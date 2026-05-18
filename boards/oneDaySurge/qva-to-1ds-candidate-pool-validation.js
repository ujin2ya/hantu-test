#!/usr/bin/env node
/**
 * QVA1/QVA2 → 1DS 후보풀 선행 효과 검증 보고서
 *
 * 목적:
 *   QVA1(원조 QVA, board_name=QVA_WATCHLIST/signal_kind=QVA_NEW) 또는
 *   QVA2(흡수형 QVA, board_name=QVA2_WATCHLIST/signal_kind=QVA2_NEW) 신호 발생 종목을
 *   1DS의 사전 후보풀로 보고, 이후 1DS 발화 또는 단일일 급등(+10/15/20/30%) 가능성이 있는지 검증.
 *
 * 중요:
 *   - 기존 QVA1/QVA2/1DS 로직은 변경하지 않는다 (이 스크립트는 read-only 검증).
 *   - 운영 보드를 건드리지 않고 독립 보고서로만 만든다.
 *   - 성과가 좋으면 이후 qva-ignite-watch-board.js 같은 운영 보드로 분리 가능한 구조.
 *
 * 입력:
 *   - DB board_signals (QVA1/QVA2 신호 + ONE_DAY_SURGE 신호)
 *   - cache/stock-charts-long/{code}.json (일봉 OHLC + valueApprox)
 *
 * 출력:
 *   - reports/qva-to-1ds-candidate-pool-validation-result.json
 *   - reports/qva-to-1ds-candidate-pool-validation-result.html
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { query, closePool, isEnabled } = require(path.join(ROOT, 'src', 'db', 'mysql'));

const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const OUT_JSON  = path.join(ROOT, 'reports', 'qva-to-1ds-candidate-pool-validation-result.json');
const OUT_HTML  = path.join(ROOT, 'reports', 'qva-to-1ds-candidate-pool-validation-result.html');

const FOLLOW_DAYS = 20;

// ─── 유틸 ────────────────────────────────────────────────────────────────
function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch (_) { return null; }
}
function pct(num, denom) {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return null;
  return Number(((num / denom - 1) * 100).toFixed(2));
}
function fmtPct(v, p = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + Number(v).toFixed(p) + '%';
}
function fmtInt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString();
}
function ymdToDate(ymd) {
  const s = String(ymd);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}
function dateToYMD(d) {
  return String(d).slice(0,10).replace(/-/g, '');
}
function avg(arr) {
  const xs = arr.filter(v => Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}
function rate(num, denom) { return denom > 0 ? Number((num / denom * 100).toFixed(1)) : 0; }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── 등급 계산 ───────────────────────────────────────────────────────────
function classifyGrade(score) {
  if (score >= 80) return 'IGNITION_READY';
  if (score >= 65) return 'PRIORITY_WATCH';
  if (score >= 50) return 'PREPARING';
  return 'TRACK_ONLY';
}
const GRADE_LABEL = Object.freeze({
  IGNITION_READY:  '🔥 발화 임박 후보',
  PRIORITY_WATCH:  '⏳ 우선 관찰 후보',
  PREPARING:       '👀 아직 준비 중',
  TRACK_ONLY:      '📡 추적만',
});

// 운영 등급 — 운영 후보 압축 결과
const GRADE_RANK = Object.freeze({ A_READY: 4, B_WATCH: 3, C_WAIT: 2, D_EXCLUDE: 1 });
const OP_GRADE_LABEL = Object.freeze({
  A_READY:   '🔥 오늘 우선 확인',
  B_WATCH:   '⏳ 장중 관찰',
  C_WAIT:    '👀 대기',
  D_EXCLUDE: '📦 제외/접기',
});

// ─── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  if (!isEnabled()) { console.error('❌ .env DB_* 미설정'); process.exit(1); }
  console.log('🔍 QVA1/QVA2 → 1DS 후보풀 선행 효과 검증 시작');
  const t0 = Date.now();

  // ─── 1. QVA1/QVA2 신호 + 1DS 발화 신호 로드 ───────────────────────────
  const qvaRows = await query(`
    SELECT signal_date, board_name, signal_kind, stock_code, stock_name
    FROM board_signals
    WHERE (board_name = 'QVA_WATCHLIST'  AND signal_kind = 'QVA_NEW')
       OR (board_name = 'QVA2_WATCHLIST' AND signal_kind = 'QVA2_NEW')
    ORDER BY signal_date, stock_code
  `);
  const qva1 = qvaRows.filter(r => r.board_name === 'QVA_WATCHLIST');
  const qva2 = qvaRows.filter(r => r.board_name === 'QVA2_WATCHLIST');
  console.log(`  QVA 신호 ${qvaRows.length}건 로드 (QVA1 ${qva1.length} / QVA2 ${qva2.length})`);

  const onedsRows = await query(`
    SELECT signal_date, stock_code FROM board_signals
    WHERE board_name = 'ONE_DAY_SURGE'
  `);
  const oneDsSet = new Set(onedsRows.map(r => r.stock_code + '|' + String(r.signal_date).slice(0,10)));
  console.log(`  1DS 발화 신호 ${onedsRows.length}건 로드`);

  // 같은 종목의 QVA1/QVA2 date list (중복 보너스 계산용)
  const qva1Dates = new Map();
  const qva2Dates = new Map();
  for (const r of qva1) {
    const d = String(r.signal_date).slice(0,10);
    if (!qva1Dates.has(r.stock_code)) qva1Dates.set(r.stock_code, []);
    qva1Dates.get(r.stock_code).push(d);
  }
  for (const r of qva2) {
    const d = String(r.signal_date).slice(0,10);
    if (!qva2Dates.has(r.stock_code)) qva2Dates.set(r.stock_code, []);
    qva2Dates.get(r.stock_code).push(d);
  }

  // ─── 2. 차트 캐시 + 각 QVA 신호 D+1~D+20 추적 ─────────────────────────
  const chartCache = new Map();
  function getChart(code) {
    if (chartCache.has(code)) return chartCache.get(code);
    const c = loadChart(code);
    chartCache.set(code, c);
    return c;
  }

  const followups = [];
  let skipped = 0, skippedNoChart = 0, skippedNoQvaRow = 0;

  for (const qva of qvaRows) {
    const code = qva.stock_code;
    const qvaType = qva.board_name === 'QVA_WATCHLIST' ? 'QVA1' : 'QVA2';
    const qvaDate = String(qva.signal_date).slice(0,10);
    const qvaDateYMD = qvaDate.replace(/-/g, '');
    const chart = getChart(code);
    if (!chart || !Array.isArray(chart.rows)) { skipped++; skippedNoChart++; continue; }
    const rows = chart.rows;
    const qvaIdx = rows.findIndex(r => String(r.date) === qvaDateYMD);
    if (qvaIdx < 0) { skipped++; skippedNoQvaRow++; continue; }
    const qvaRow = rows[qvaIdx];
    const qvaClose = qvaRow.close;
    const qvaHigh  = qvaRow.high;
    const qvaValue = qvaRow.valueApprox || (qvaRow.close * (qvaRow.volume || 0));

    // 추적 누적
    let minClose = qvaClose, minLow = qvaRow.low, maxHigh = qvaHigh;
    let firstOneDsDate = null, firstOneDsDays = null;
    const dailyHits = { d10: null, d15: null, d20: null, d30: null };  // 일별(전일종가 대비) 첫 도달 D
    let d5MaxUp = null, d10MaxUp = null, d20MaxUp = null;
    let reachedPlus20FromQva = false; // QVA 종가 대비 한 번이라도 +20% 도달 (기존 isAlreadyFired용)
    // QVA 종가 대비 누적 최대 상승률이 처음 +X%를 넘은 D — 대상승 분석용
    let firstReach20FromQva = null, firstReach30FromQva = null,
        firstReach50FromQva = null, firstReach100FromQva = null;
    let firstIgnReadyOrPrioDays = null; // 첫 IGNITION_READY 또는 PRIORITY_WATCH 발생 D
    const followItems = [];

    for (let d = 1; d <= FOLLOW_DAYS; d++) {
      const idx = qvaIdx + d;
      if (idx >= rows.length) break;
      const row = rows[idx];
      const dateFmt = ymdToDate(row.date);

      // 누적 통계
      if (Number.isFinite(row.close)) minClose = Math.min(minClose, row.close);
      if (Number.isFinite(row.low))   minLow   = Math.min(minLow, row.low);
      if (Number.isFinite(row.high))  maxHigh  = Math.max(maxHigh, row.high);

      // 일별 급등 (D 일자의 전일종가 대비 일일 high%)
      const prevClose = rows[idx - 1]?.close;
      const dailyHighPct = pct(row.high, prevClose);
      if (dailyHighPct != null) {
        if (dailyHits.d10 == null && dailyHighPct >= 10) dailyHits.d10 = d;
        if (dailyHits.d15 == null && dailyHighPct >= 15) dailyHits.d15 = d;
        if (dailyHits.d20 == null && dailyHighPct >= 20) dailyHits.d20 = d;
        if (dailyHits.d30 == null && dailyHighPct >= 30) dailyHits.d30 = d;
      }

      // 1DS 발화 lookup (해당 일자에 ONE_DAY_SURGE 보드 행 있으면)
      if (firstOneDsDate == null && oneDsSet.has(code + '|' + dateFmt)) {
        firstOneDsDate = dateFmt;
        firstOneDsDays = d;
      }

      // D+5/10/20 최고 상승률 (QVA 종가 대비)
      const maxUpSoFar = pct(maxHigh, qvaClose);
      if (d === 5)  d5MaxUp = maxUpSoFar;
      if (d === 10) d10MaxUp = maxUpSoFar;
      if (d === 20) d20MaxUp = maxUpSoFar;
      if (maxUpSoFar != null && maxUpSoFar >= 20) reachedPlus20FromQva = true;
      // QVA 종가 대비 누적 첫 도달 D
      if (firstReach20FromQva  == null && maxUpSoFar != null && maxUpSoFar >= 20)  firstReach20FromQva  = d;
      if (firstReach30FromQva  == null && maxUpSoFar != null && maxUpSoFar >= 30)  firstReach30FromQva  = d;
      if (firstReach50FromQva  == null && maxUpSoFar != null && maxUpSoFar >= 50)  firstReach50FromQva  = d;
      if (firstReach100FromQva == null && maxUpSoFar != null && maxUpSoFar >= 100) firstReach100FromQva = d;

      // 일별 상태 (그 시점에서 후보풀로 봤다면)
      const maxDropFromQvaClosePct = pct(minClose, qvaClose);
      const isPriceAlive = maxDropFromQvaClosePct != null && maxDropFromQvaClosePct > -5;

      const distanceToQvaHighPct = pct(row.close, qvaHigh);
      const isNearQvaHigh = distanceToQvaHighPct != null && distanceToQvaHighPct > -7;

      let avg5Value = 0, avgCount = 0;
      for (let k = Math.max(qvaIdx + 1, idx - 4); k <= idx; k++) {
        const v = rows[k]?.valueApprox;
        if (Number.isFinite(v)) { avg5Value += v; avgCount++; }
      }
      avg5Value = avgCount > 0 ? avg5Value / avgCount : 0;
      const curValue = row.valueApprox || 0;
      const isValueReIncreasing = (avg5Value > 0 && curValue >= avg5Value * 1.5)
                               || (qvaValue > 0 && curValue >= qvaValue * 0.7);

      let recent3Min = Infinity;
      for (let k = Math.max(qvaIdx + 1, idx - 2); k <= idx; k++) {
        if (Number.isFinite(rows[k]?.low)) recent3Min = Math.min(recent3Min, rows[k].low);
      }
      const isLowRising = recent3Min !== Infinity && minLow > 0 && recent3Min > minLow * 1.03;

      const priceChangeFromQvaPct = pct(row.close, qvaClose);
      const isNotOverExtended = priceChangeFromQvaPct != null && priceChangeFromQvaPct < 15;

      // 중복 보너스 — 같은 종목에 QVA1/QVA2가 [qvaDate, dateFmt] 안에 둘 다 있었는지
      const otherDates = qvaType === 'QVA1' ? qva2Dates.get(code) : qva1Dates.get(code);
      let hasBoth = false;
      if (otherDates) {
        for (const od of otherDates) {
          if (od >= qvaDate && od <= dateFmt) { hasBoth = true; break; }
        }
      }

      // ignitionWatchScore
      let score = 0;
      if (isPriceAlive)          score += 25;
      if (isNearQvaHigh)         score += 20;
      if (isValueReIncreasing)   score += 20;
      if (isLowRising)           score += 15;
      if (d >= 1 && d <= 10)     score += 10;
      if (hasBoth)               score += 10;
      const grade = classifyGrade(score);
      if (firstIgnReadyOrPrioDays == null && (grade === 'IGNITION_READY' || grade === 'PRIORITY_WATCH')) {
        firstIgnReadyOrPrioDays = d;
      }

      // ─── 운영용 필드 (검증용 필드와 별도) ──────────────────────────
      // isOperationalNearQvaHigh — 운영 후보 좁힘: QVA 고가 -7% ~ +5% 범위
      const isOperationalNearQvaHigh =
        distanceToQvaHighPct != null && distanceToQvaHighPct >= -7 && distanceToQvaHighPct <= 5;
      // isChasingRisk — QVA 종가 대비 +18% 초과 (추격 위험)
      const isChasingRisk =
        priceChangeFromQvaPct != null && priceChangeFromQvaPct > 18;
      // isAlreadyFired — +25% 초과 OR QVA 이후 이미 +20% 도달 (이미 한 번 출발한 종목)
      const isAlreadyFired =
        (priceChangeFromQvaPct != null && priceChangeFromQvaPct > 25) || reachedPlus20FromQva;
      // isTooExtendedForOperation — +40% 초과 (운영 후보로 부적합)
      const isTooExtendedForOperation =
        priceChangeFromQvaPct != null && priceChangeFromQvaPct > 40;

      // 운영 후보 압축 조건 — 모두 만족해야 isOperationalCandidate
      const isOperationalCandidate =
        (grade === 'IGNITION_READY' || grade === 'PRIORITY_WATCH') &&
        (d >= 1 && d <= 5) &&
        isPriceAlive &&
        isOperationalNearQvaHigh &&
        isValueReIncreasing &&
        (maxDropFromQvaClosePct != null && maxDropFromQvaClosePct >= -5) &&
        (priceChangeFromQvaPct != null && priceChangeFromQvaPct >= -3) &&
        (priceChangeFromQvaPct != null && priceChangeFromQvaPct <= 18) &&
        !isTooExtendedForOperation;

      // 운영 등급 결정
      let operationGrade;
      if (isOperationalCandidate &&
          grade === 'IGNITION_READY' &&
          d >= 2 && d <= 5 &&
          isLowRising) {
        operationGrade = 'A_READY';
      } else if (isOperationalCandidate) {
        operationGrade = 'B_WATCH';
      } else if (
        // C_WAIT: QVA 후보지만 아직 고가 근처가 아니거나 거래대금 재증가 약함
        (grade === 'IGNITION_READY' || grade === 'PRIORITY_WATCH' || grade === 'PREPARING') &&
        d <= 10 &&
        isPriceAlive &&
        !isTooExtendedForOperation &&
        !isAlreadyFired &&
        (!isOperationalNearQvaHigh || !isValueReIncreasing)
      ) {
        operationGrade = 'C_WAIT';
      } else {
        operationGrade = 'D_EXCLUDE';
      }

      followItems.push({
        daysFromQva: d,
        currentDate: dateFmt,
        currentClose: row.close,
        currentValue: curValue,
        priceChangeFromQvaPct,
        distanceToQvaHighPct,
        maxDropFromQvaClosePct,
        isPriceAlive,
        isNearQvaHigh,
        isValueReIncreasing,
        isLowRising,
        isNotOverExtended,
        hasBoth,
        ignitionWatchScore: score,
        ignitionWatchGrade: grade,
        // 운영 필드
        isOperationalNearQvaHigh,
        isChasingRisk,
        isAlreadyFired,
        isTooExtendedForOperation,
        isOperationalCandidate,
        operationGrade,
      });
    }

    const maxUpsidePct = pct(maxHigh, qvaClose);
    const maxDropPct   = pct(minClose, qvaClose);

    // followup 단위 운영 등급 — 추적 기간 중 가장 좋은 등급
    let bestOperationGrade = 'D_EXCLUDE';
    for (const fi of followItems) {
      if ((GRADE_RANK[fi.operationGrade] || 0) > (GRADE_RANK[bestOperationGrade] || 0)) {
        bestOperationGrade = fi.operationGrade;
      }
    }

    followups.push({
      code, name: qva.stock_name, qvaType, qvaDate,
      qvaClose, qvaHigh, qvaValue,
      maxUpsidePct, maxDropPct,
      hit10: dailyHits.d10 != null, hit10Days: dailyHits.d10,
      hit15: dailyHits.d15 != null, hit15Days: dailyHits.d15,
      hit20: dailyHits.d20 != null, hit20Days: dailyHits.d20,
      hit30: dailyHits.d30 != null, hit30Days: dailyHits.d30,
      d5MaxUp, d10MaxUp, d20MaxUp,
      // QVA 종가 대비 누적 첫 도달 D — 대상승 분석용
      firstReach20FromQva, firstReach30FromQva, firstReach50FromQva, firstReach100FromQva,
      // 첫 IGNITION/PRIORITY 발생 D
      firstIgnReadyOrPrioDays,
      breach5:  maxDropPct != null && maxDropPct < -5,
      breach10: maxDropPct != null && maxDropPct < -10,
      breach15: maxDropPct != null && maxDropPct < -15,
      hasOneDs: firstOneDsDate != null,
      firstOneDsDate, firstOneDsDays,
      bestOperationGrade,
      daily: followItems,
    });
  }

  console.log(`  추적 ${followups.length}건 / skip ${skipped} (no chart ${skippedNoChart} / no qva row ${skippedNoQvaRow})`);

  // ─── 3. 그룹별 집계 ──────────────────────────────────────────────────
  function makeGroupStat(name, items) {
    const n = items.length;
    if (n === 0) {
      return { group: name, n: 0, hit10Rate: 0, hit15Rate: 0, hit20Rate: 0, hit30Rate: 0,
               oneDsRate: 0, avgOneDsDays: null, avgD5: null, avgD10: null, avgD20: null,
               avgMaxUpside: null, breach5Rate: 0, breach10Rate: 0 };
    }
    const oneDsItems = items.filter(x => x.hasOneDs);
    return {
      group: name,
      n,
      hit10Rate:  rate(items.filter(x => x.hit10).length, n),
      hit15Rate:  rate(items.filter(x => x.hit15).length, n),
      hit20Rate:  rate(items.filter(x => x.hit20).length, n),
      hit30Rate:  rate(items.filter(x => x.hit30).length, n),
      oneDsRate:  rate(oneDsItems.length, n),
      avgOneDsDays: oneDsItems.length > 0
        ? Number(avg(oneDsItems.map(x => x.firstOneDsDays)).toFixed(1)) : null,
      avgD5:   Number((avg(items.map(x => x.d5MaxUp))  ?? 0).toFixed(2)),
      avgD10:  Number((avg(items.map(x => x.d10MaxUp)) ?? 0).toFixed(2)),
      avgD20:  Number((avg(items.map(x => x.d20MaxUp)) ?? 0).toFixed(2)),
      avgMaxUpside: Number((avg(items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      breach5Rate:  rate(items.filter(x => x.breach5).length, n),
      breach10Rate: rate(items.filter(x => x.breach10).length, n),
    };
  }
  const hasAnyDailyTrue = (x, key) => x.daily.some(d => d[key]);
  const hasAnyGrade     = (x, grade) => x.daily.some(d => d.ignitionWatchGrade === grade);
  const allAreGrade     = (x, grade) => x.daily.length > 0 && x.daily.every(d => d.ignitionWatchGrade === grade);

  const groups = [
    makeGroupStat('ALL_QVA_POOL',       followups),
    makeGroupStat('QVA1_POOL',          followups.filter(x => x.qvaType === 'QVA1')),
    makeGroupStat('QVA2_POOL',          followups.filter(x => x.qvaType === 'QVA2')),
    makeGroupStat('PRICE_ALIVE',        followups.filter(x => hasAnyDailyTrue(x, 'isPriceAlive'))),
    makeGroupStat('NEAR_QVA_HIGH',      followups.filter(x => hasAnyDailyTrue(x, 'isNearQvaHigh'))),
    makeGroupStat('VALUE_REINCREASING', followups.filter(x => hasAnyDailyTrue(x, 'isValueReIncreasing'))),
    makeGroupStat('LOW_RISING',         followups.filter(x => hasAnyDailyTrue(x, 'isLowRising'))),
    makeGroupStat('NOT_OVER_EXTENDED',  followups.filter(x => hasAnyDailyTrue(x, 'isNotOverExtended'))),
    makeGroupStat('IGNITION_READY',     followups.filter(x => hasAnyGrade(x, 'IGNITION_READY'))),
    makeGroupStat('PRIORITY_WATCH',     followups.filter(x => hasAnyGrade(x, 'PRIORITY_WATCH'))),
    makeGroupStat('PREPARING',          followups.filter(x => hasAnyGrade(x, 'PREPARING'))),
    makeGroupStat('TRACK_ONLY',         followups.filter(x => allAreGrade(x, 'TRACK_ONLY'))),
  ];

  // ─── 3-B. 운영 압축 후보 그룹 집계 (bestOperationGrade 기준) ───────────
  const operationalAll = followups.filter(x =>
    x.bestOperationGrade === 'A_READY' || x.bestOperationGrade === 'B_WATCH');
  const operationalGroups = [
    makeGroupStat('OPERATIONAL_ALL', operationalAll),
    makeGroupStat('A_READY',         followups.filter(x => x.bestOperationGrade === 'A_READY')),
    makeGroupStat('B_WATCH',         followups.filter(x => x.bestOperationGrade === 'B_WATCH')),
    makeGroupStat('C_WAIT',          followups.filter(x => x.bestOperationGrade === 'C_WAIT')),
    makeGroupStat('D_EXCLUDE',       followups.filter(x => x.bestOperationGrade === 'D_EXCLUDE')),
  ];

  // ─── 4. daysFromQva 구간별 (첫 IGNITION_READY 시점 기준) ─────────────
  function bucketize(d) {
    if (d === 1) return 'D+1';
    if (d <= 3) return 'D+2~D+3';
    if (d <= 5) return 'D+4~D+5';
    if (d <= 10) return 'D+6~D+10';
    return 'D+11~D+20';
  }
  const daysBuckets = {};
  for (const x of followups) {
    const firstIgn = x.daily.find(d => d.ignitionWatchGrade === 'IGNITION_READY');
    if (!firstIgn) continue;
    const b = bucketize(firstIgn.daysFromQva);
    if (!daysBuckets[b]) daysBuckets[b] = [];
    daysBuckets[b].push(x);
  }
  const daysGroups = ['D+1', 'D+2~D+3', 'D+4~D+5', 'D+6~D+10', 'D+11~D+20']
    .map(b => ({ ...makeGroupStat(b, daysBuckets[b] || []) }));

  // ─── 5. 대표 성공/실패 사례 ──────────────────────────────────────────
  const successCases = followups
    .filter(x => x.hasOneDs || x.hit20)
    .slice()
    .sort((a, b) => (b.maxUpsidePct || 0) - (a.maxUpsidePct || 0))
    .slice(0, 15);

  const failCases = followups
    .filter(x => x.breach10)
    .slice()
    .sort((a, b) => (a.maxDropPct || 0) - (b.maxDropPct || 0))
    .slice(0, 15);

  // ─── 6. 오늘 기준 운영 후보 (최신 daily 시점의 IGNITION_READY / PRIORITY_WATCH) ──
  const todayStr = new Date().toISOString().slice(0, 10);
  const perCode = new Map();
  for (const x of followups) {
    for (let i = x.daily.length - 1; i >= 0; i--) {
      const d = x.daily[i];
      if (d.currentDate > todayStr) continue;
      if (d.ignitionWatchGrade === 'IGNITION_READY' || d.ignitionWatchGrade === 'PRIORITY_WATCH') {
        const entry = {
          code: x.code, name: x.name, qvaType: x.qvaType, qvaDate: x.qvaDate,
          qvaClose: x.qvaClose, qvaHigh: x.qvaHigh,
          ...d,
          maxUpsidePct: x.maxUpsidePct,
          hasOneDsLater: x.hasOneDs,
          firstOneDsDays: x.firstOneDsDays,
        };
        const existing = perCode.get(x.code);
        if (!existing || d.currentDate > existing.currentDate
            || (d.currentDate === existing.currentDate && d.ignitionWatchScore > existing.ignitionWatchScore)) {
          perCode.set(x.code, entry);
        }
        break;
      }
    }
  }
  const todayCandidates = [...perCode.values()]
    .sort((a, b) => b.ignitionWatchScore - a.ignitionWatchScore);

  // ─── BIG-RUN 검증 — QVA 이후 크게 간 종목의 공통 특징 분석 ──────────
  // 1) 대상승 그룹 분류 (중복 허용)
  for (const x of followups) {
    const mu = x.maxUpsidePct;
    x.bigGroups = [];
    if (mu != null) {
      if (mu >= 20)  x.bigGroups.push('BIG_20');
      if (mu >= 30)  x.bigGroups.push('BIG_30');
      if (mu >= 50)  x.bigGroups.push('BIG_50');
      if (mu >= 100) x.bigGroups.push('SUPER_FIRE');
      if (mu < 20)   x.bigGroups.push('NON_BIG');
    }
    // 초기 전조 (D+1~D+5)
    const early = x.daily.filter(d => d.daysFromQva >= 1 && d.daysFromQva <= 5);
    x.earlyValueReIncreasing = early.some(d => d.isValueReIncreasing);
    x.earlyNearOrBreakHigh   = early.some(d =>
      (d.distanceToQvaHighPct != null && d.distanceToQvaHighPct >= -7));
    x.earlyIgnition          = early.some(d =>
      d.ignitionWatchGrade === 'IGNITION_READY' || d.ignitionWatchGrade === 'PRIORITY_WATCH');
    x.earlyLowRising         = early.some(d => d.isLowRising);
    x.earlyStrongClose       = early.some(d =>
      Number.isFinite(d.currentClose) && d.currentClose >= x.qvaHigh);
    x.firstIgnReadyOrPrioDays = x.firstIgnReadyOrPrioDays; // already set
  }

  // 2) 그룹별 기본 성과 집계
  function makeBigGroupStat(label, items) {
    const n = items.length;
    if (n === 0) return { group: label, n: 0 };
    const mu = items.map(x => x.maxUpsidePct).filter(v => Number.isFinite(v)).sort((a,b)=>a-b);
    const median = mu.length ? mu[Math.floor(mu.length/2)] : null;
    const q1Items = items.filter(x => x.qvaType === 'QVA1');
    return {
      group: label,
      n,
      shareOfAll: rate(n, followups.length),
      qva1Count: q1Items.length,
      qva2Count: n - q1Items.length,
      qva1Share: rate(q1Items.length, n),
      qva2Share: rate(n - q1Items.length, n),
      avgMaxUp:   Number((avg(items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      medianMaxUp: median != null ? Number(median.toFixed(2)) : null,
      avgD5:      Number((avg(items.map(x => x.d5MaxUp))  ?? 0).toFixed(2)),
      avgD10:     Number((avg(items.map(x => x.d10MaxUp)) ?? 0).toFixed(2)),
      avgD20:     Number((avg(items.map(x => x.d20MaxUp)) ?? 0).toFixed(2)),
      avgFirstReach10:  items.filter(x => x.hit10Days).length > 0 ? Number(avg(items.filter(x => x.hit10Days).map(x => x.hit10Days)).toFixed(1)) : null,
      avgFirstReach20:  items.filter(x => x.firstReach20FromQva).length > 0 ? Number(avg(items.filter(x => x.firstReach20FromQva).map(x => x.firstReach20FromQva)).toFixed(1)) : null,
      breach5Rate:  rate(items.filter(x => x.breach5).length, n),
      breach10Rate: rate(items.filter(x => x.breach10).length, n),
      breach15Rate: rate(items.filter(x => x.breach15).length, n),
    };
  }
  const bigGroups = {
    BIG_20:     followups.filter(x => x.bigGroups.includes('BIG_20')),
    BIG_30:     followups.filter(x => x.bigGroups.includes('BIG_30')),
    BIG_50:     followups.filter(x => x.bigGroups.includes('BIG_50')),
    SUPER_FIRE: followups.filter(x => x.bigGroups.includes('SUPER_FIRE')),
    NON_BIG:    followups.filter(x => x.bigGroups.includes('NON_BIG')),
  };
  const bigGroupStats = Object.entries(bigGroups).map(([k,v]) => makeBigGroupStat(k, v));

  // 3) QVA1 vs QVA2 대상승 비교
  function makeQvaCompare(type) {
    const items = followups.filter(x => x.qvaType === type);
    const n = items.length;
    const big20 = items.filter(x => x.bigGroups.includes('BIG_20'));
    const big30 = items.filter(x => x.bigGroups.includes('BIG_30'));
    const big50 = items.filter(x => x.bigGroups.includes('BIG_50'));
    const sf    = items.filter(x => x.bigGroups.includes('SUPER_FIRE'));
    const mu = items.map(x => x.maxUpsidePct).filter(v => Number.isFinite(v)).sort((a,b)=>a-b);
    return {
      type, n,
      big20Rate: rate(big20.length, n),
      big30Rate: rate(big30.length, n),
      big50Rate: rate(big50.length, n),
      superFireRate: rate(sf.length, n),
      avgMaxUp:   Number((avg(items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      medianMaxUp: mu.length ? Number(mu[Math.floor(mu.length/2)].toFixed(2)) : null,
      breach10Rate: rate(items.filter(x => x.breach10).length, n),
      big30Shake10Rate: rate(big30.filter(x => x.breach10).length, big30.length),
      big50Shake10Rate: rate(big50.filter(x => x.breach10).length, big50.length),
    };
  }
  const qvaCompare = [ makeQvaCompare('QVA1'), makeQvaCompare('QVA2') ];

  // 4) 흔들고 간 종목
  function makeShakeStat(label, filter) {
    const items = followups.filter(filter);
    const n = items.length;
    if (n === 0) return { group: label, n: 0 };
    const q1 = items.filter(x => x.qvaType === 'QVA1').length;
    const denomBig20 = bigGroups.BIG_20.length;
    const denomBig30 = bigGroups.BIG_30.length;
    const denomBig50 = bigGroups.BIG_50.length;
    return {
      group: label, n,
      shareOfBig20: rate(n, denomBig20),
      shareOfBig30: rate(n, denomBig30),
      shareOfBig50: rate(n, denomBig50),
      qva1Count: q1, qva2Count: n - q1,
      avgMaxUp:   Number((avg(items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      avgMaxDrop: Number((avg(items.map(x => x.maxDropPct)) ?? 0).toFixed(2)),
      avgFirstReach20: items.filter(x => x.firstReach20FromQva).length > 0 ? Number(avg(items.filter(x => x.firstReach20FromQva).map(x => x.firstReach20FromQva)).toFixed(1)) : null,
      avgFirstReach30: items.filter(x => x.firstReach30FromQva).length > 0 ? Number(avg(items.filter(x => x.firstReach30FromQva).map(x => x.firstReach30FromQva)).toFixed(1)) : null,
      avgFirstReach50: items.filter(x => x.firstReach50FromQva).length > 0 ? Number(avg(items.filter(x => x.firstReach50FromQva).map(x => x.firstReach50FromQva)).toFixed(1)) : null,
    };
  }
  const shakeGroups = [
    makeShakeStat('SHAKE_5_BIG_20',  x => x.breach5 && x.bigGroups.includes('BIG_20')),
    makeShakeStat('SHAKE_10_BIG_30', x => x.breach10 && x.bigGroups.includes('BIG_30')),
    makeShakeStat('SHAKE_10_BIG_50', x => x.breach10 && x.bigGroups.includes('BIG_50')),
    makeShakeStat('SHAKE_15_BIG_50', x => x.breach15 && x.bigGroups.includes('BIG_50')),
  ];

  // 5) 기존 운영 압축(D_EXCLUDE)이 버린 대상승 종목
  function exclusionReason(x) {
    // 단순 추정 — daily 상태 중 가장 흔한 사유
    const reasons = [];
    if (x.breach5) reasons.push('breach5');
    if (x.daily.some(d => d.isTooExtendedForOperation)) reasons.push('tooExtended_40+');
    if (x.daily.every(d => d.distanceToQvaHighPct == null || !(d.distanceToQvaHighPct >= -7 && d.distanceToQvaHighPct <= 5))) reasons.push('outOfHighRange');
    if (x.daily.every(d => d.daysFromQva > 5 || !d.isOperationalCandidate)) {
      // 5일 안에 운영 후보된 적 없음
      if (!x.daily.some(d => d.daysFromQva <= 5)) reasons.push('after_d5');
    }
    if (!x.daily.some(d => d.isValueReIncreasing)) reasons.push('noValueReinc');
    if (reasons.length === 0) reasons.push('other');
    return reasons;
  }
  function makeExcludeStat(label, items) {
    const n = items.length;
    if (n === 0) return { group: label, n: 0 };
    const reasonCounts = {};
    for (const x of items) {
      for (const r of exclusionReason(x)) reasonCounts[r] = (reasonCounts[r] || 0) + 1;
    }
    return {
      group: label, n,
      shareOfTarget: rate(n, label === 'D_EXCLUDE_AND_BIG_20'      ? bigGroups.BIG_20.length
                            : label === 'D_EXCLUDE_AND_BIG_30'      ? bigGroups.BIG_30.length
                            : label === 'D_EXCLUDE_AND_BIG_50'      ? bigGroups.BIG_50.length
                            : label === 'D_EXCLUDE_AND_SUPER_FIRE'  ? bigGroups.SUPER_FIRE.length : n),
      avgMaxUp: Number((avg(items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      avgMaxDrop: Number((avg(items.map(x => x.maxDropPct)) ?? 0).toFixed(2)),
      reasonCounts,
    };
  }
  const dExcludeGroups = [
    makeExcludeStat('D_EXCLUDE_AND_BIG_20',     followups.filter(x => x.bestOperationGrade === 'D_EXCLUDE' && x.bigGroups.includes('BIG_20'))),
    makeExcludeStat('D_EXCLUDE_AND_BIG_30',     followups.filter(x => x.bestOperationGrade === 'D_EXCLUDE' && x.bigGroups.includes('BIG_30'))),
    makeExcludeStat('D_EXCLUDE_AND_BIG_50',     followups.filter(x => x.bestOperationGrade === 'D_EXCLUDE' && x.bigGroups.includes('BIG_50'))),
    makeExcludeStat('D_EXCLUDE_AND_SUPER_FIRE', followups.filter(x => x.bestOperationGrade === 'D_EXCLUDE' && x.bigGroups.includes('SUPER_FIRE'))),
  ];

  // 6) 초기 전조 분석 (각 조건별 + 조합)
  function makeEarlyStat(label, filter) {
    const items = followups.filter(filter);
    const n = items.length;
    if (n === 0) return { group: label, n: 0, big20Rate: 0, big30Rate: 0, big50Rate: 0, superFireRate: 0, avgMaxUp: 0, breach10Rate: 0 };
    return {
      group: label, n,
      big20Rate:     rate(items.filter(x => x.bigGroups.includes('BIG_20')).length, n),
      big30Rate:     rate(items.filter(x => x.bigGroups.includes('BIG_30')).length, n),
      big50Rate:     rate(items.filter(x => x.bigGroups.includes('BIG_50')).length, n),
      superFireRate: rate(items.filter(x => x.bigGroups.includes('SUPER_FIRE')).length, n),
      avgMaxUp: Number((avg(items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      breach10Rate: rate(items.filter(x => x.breach10).length, n),
    };
  }
  const earlyStats = [
    makeEarlyStat('earlyValueReIncreasing',                x => x.earlyValueReIncreasing),
    makeEarlyStat('earlyNearOrBreakHigh',                  x => x.earlyNearOrBreakHigh),
    makeEarlyStat('earlyIgnition',                         x => x.earlyIgnition),
    makeEarlyStat('earlyLowRising',                        x => x.earlyLowRising),
    makeEarlyStat('earlyStrongClose',                      x => x.earlyStrongClose),
    makeEarlyStat('value+highBreak',                       x => x.earlyValueReIncreasing && x.earlyNearOrBreakHigh),
    makeEarlyStat('value+ignition',                        x => x.earlyValueReIncreasing && x.earlyIgnition),
    makeEarlyStat('highBreak+lowRising',                   x => x.earlyNearOrBreakHigh && x.earlyLowRising),
    makeEarlyStat('value+highBreak+lowRising',             x => x.earlyValueReIncreasing && x.earlyNearOrBreakHigh && x.earlyLowRising),
    makeEarlyStat('value+highBreak+ignition',              x => x.earlyValueReIncreasing && x.earlyNearOrBreakHigh && x.earlyIgnition),
  ];

  // 7) 경과일별 (첫 IGNITION/PRIORITY 시점)
  function ignDayBucket(d) {
    if (d == null) return 'NEVER';
    if (d === 1) return 'D+1';
    if (d <= 3) return 'D+2~D+3';
    if (d <= 5) return 'D+4~D+5';
    if (d <= 10) return 'D+6~D+10';
    return 'D+11~D+20';
  }
  const ignBuckets = { 'D+1':[], 'D+2~D+3':[], 'D+4~D+5':[], 'D+6~D+10':[], 'D+11~D+20':[], 'NEVER':[] };
  for (const x of followups) ignBuckets[ignDayBucket(x.firstIgnReadyOrPrioDays)].push(x);
  const ignDayStats = Object.entries(ignBuckets).map(([k, v]) => {
    const n = v.length;
    if (n === 0) return { group: k, n: 0 };
    return {
      group: k, n,
      big20Rate:     rate(v.filter(x => x.bigGroups.includes('BIG_20')).length, n),
      big30Rate:     rate(v.filter(x => x.bigGroups.includes('BIG_30')).length, n),
      big50Rate:     rate(v.filter(x => x.bigGroups.includes('BIG_50')).length, n),
      superFireRate: rate(v.filter(x => x.bigGroups.includes('SUPER_FIRE')).length, n),
      avgMaxUp:  Number((avg(v.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      avgMaxDrop: Number((avg(v.map(x => x.maxDropPct)) ?? 0).toFixed(2)),
      breach10Rate: rate(v.filter(x => x.breach10).length, n),
    };
  });

  // 8) 2차 발화형
  function makeSecondFireStat(label, filter) {
    const items = followups.filter(filter);
    const n = items.length;
    if (n === 0) return { group: label, n: 0 };
    const q1 = items.filter(x => x.qvaType === 'QVA1').length;
    return {
      group: label, n,
      shareOfBig50:     rate(n, bigGroups.BIG_50.length),
      shareOfSuperFire: rate(n, bigGroups.SUPER_FIRE.length),
      qva1Count: q1, qva2Count: n - q1,
      avgMaxUp:   Number((avg(items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      avgMaxDrop: Number((avg(items.map(x => x.maxDropPct)) ?? 0).toFixed(2)),
      avgEarly20Days: Number((avg(items.map(x => x.firstReach20FromQva)) ?? 0).toFixed(1)),
      avgFinalPeakDays: Number((avg(items.map(x => Math.max(x.firstReach50FromQva || 0, x.firstReach100FromQva || 0))) ?? 0).toFixed(1)),
    };
  }
  const secondFireGroups = [
    makeSecondFireStat('EARLY_20_THEN_50',
      x => x.firstReach20FromQva != null && x.firstReach20FromQva <= 5 && x.bigGroups.includes('BIG_50')),
    makeSecondFireStat('EARLY_30_THEN_50',
      x => x.firstReach30FromQva != null && x.firstReach30FromQva <= 5 && x.bigGroups.includes('BIG_50')),
    makeSecondFireStat('EARLY_20_THEN_100',
      x => x.firstReach20FromQva != null && x.firstReach20FromQva <= 5 && x.bigGroups.includes('SUPER_FIRE')),
  ];

  // 9) BIG-RUN 조건 조합 매트릭스 — 어떤 조건 조합이 +50%/+100%를 가장 잘 가르는가
  const BASELINE_BIG50      = rate(bigGroups.BIG_50.length,     followups.length);
  const BASELINE_SUPER_FIRE = rate(bigGroups.SUPER_FIRE.length, followups.length);

  function sampleQualityOf(n) {
    if (n >= 300) return '신뢰가능';
    if (n >= 100) return '참고가능';
    if (n >=  30) return '표본작음';
    return '해석주의';
  }
  function makeComboStat(label, filter) {
    const items = followups.filter(filter);
    const n = items.length;
    const empty = {
      group: label, n: 0, sampleQuality: sampleQualityOf(0),
      big20Count: 0, big30Count: 0, big50Count: 0, superFireCount: 0, nonBigCount: 0,
      big20Rate: 0, big30Rate: 0, big50Rate: 0, superFireRate: 0, nonBigRate: 0,
      big50Lift: 0, superFireLift: 0,
      avgMaxUp: 0, medianMaxUp: null, avgMaxDrop: 0,
      breach5Rate: 0, breach10Rate: 0, breach15Rate: 0,
      avgD5: 0, avgD10: 0, avgD20: 0,
      avgFirstReach20: null, avgFirstReach50: null,
      qva1Count: 0, qva2Count: 0, qva1Share: 0, qva2Share: 0,
      efficiency: 0,
    };
    if (n === 0) return empty;
    const big20Items = items.filter(x => x.bigGroups.includes('BIG_20'));
    const big30Items = items.filter(x => x.bigGroups.includes('BIG_30'));
    const big50Items = items.filter(x => x.bigGroups.includes('BIG_50'));
    const sfItems    = items.filter(x => x.bigGroups.includes('SUPER_FIRE'));
    const nonBigItems = items.filter(x => x.bigGroups.includes('NON_BIG'));
    const q1n = items.filter(x => x.qvaType === 'QVA1').length;
    const mu = items.map(x => x.maxUpsidePct).filter(v => Number.isFinite(v)).sort((a,b) => a - b);
    const median = mu.length ? mu[Math.floor(mu.length/2)] : null;
    const fr20 = items.filter(x => x.firstReach20FromQva).map(x => x.firstReach20FromQva);
    const fr50 = items.filter(x => x.firstReach50FromQva).map(x => x.firstReach50FromQva);
    const big50Rate = rate(big50Items.length, n);
    const sfRate    = rate(sfItems.length, n);
    return {
      group: label, n, sampleQuality: sampleQualityOf(n),
      big20Count: big20Items.length,
      big30Count: big30Items.length,
      big50Count: big50Items.length,
      superFireCount: sfItems.length,
      nonBigCount: nonBigItems.length,
      big20Rate:     rate(big20Items.length, n),
      big30Rate:     rate(big30Items.length, n),
      big50Rate,
      superFireRate: sfRate,
      nonBigRate:    rate(nonBigItems.length, n),
      big50Lift:     BASELINE_BIG50 > 0      ? Number((big50Rate / BASELINE_BIG50).toFixed(2))      : 0,
      superFireLift: BASELINE_SUPER_FIRE > 0 ? Number((sfRate    / BASELINE_SUPER_FIRE).toFixed(2)) : 0,
      avgMaxUp:    Number((avg(items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      medianMaxUp: median != null ? Number(median.toFixed(2)) : null,
      avgMaxDrop:  Number((avg(items.map(x => x.maxDropPct))   ?? 0).toFixed(2)),
      breach5Rate:  rate(items.filter(x => x.breach5).length, n),
      breach10Rate: rate(items.filter(x => x.breach10).length, n),
      breach15Rate: rate(items.filter(x => x.breach15).length, n),
      avgD5:  Number((avg(items.map(x => x.d5MaxUp))  ?? 0).toFixed(2)),
      avgD10: Number((avg(items.map(x => x.d10MaxUp)) ?? 0).toFixed(2)),
      avgD20: Number((avg(items.map(x => x.d20MaxUp)) ?? 0).toFixed(2)),
      avgFirstReach20: fr20.length ? Number(avg(fr20).toFixed(1)) : null,
      avgFirstReach50: fr50.length ? Number(avg(fr50).toFixed(1)) : null,
      qva1Count: q1n, qva2Count: n - q1n,
      qva1Share: rate(q1n, n), qva2Share: rate(n - q1n, n),
      efficiency: Number((big50Items.length * big50Rate / 100).toFixed(2)),
    };
  }
  const inDays = (d, lo, hi) => d != null && d >= lo && d <= hi;
  const comboMatrix = [
    makeComboStat('QVA2_ONLY',              x => x.qvaType === 'QVA2'),
    makeComboStat('QVA2_VALUE_HIGH_LOW',    x => x.qvaType === 'QVA2' && x.earlyValueReIncreasing && x.earlyNearOrBreakHigh && x.earlyLowRising),
    makeComboStat('QVA2_EARLY_IGNITION',    x => x.qvaType === 'QVA2' && x.earlyIgnition),
    makeComboStat('QVA2_D6_D10_IGNITION',   x => x.qvaType === 'QVA2' && inDays(x.firstIgnReadyOrPrioDays, 6, 10)),
    makeComboStat('QVA2_SHAKE10_RECOVER',   x => x.qvaType === 'QVA2' && x.breach10),
    makeComboStat('QVA1_VALUE_HIGH_LOW',    x => x.qvaType === 'QVA1' && x.earlyValueReIncreasing && x.earlyNearOrBreakHigh && x.earlyLowRising),
    makeComboStat('VALUE_HIGH_LOW_ALL',     x => x.earlyValueReIncreasing && x.earlyNearOrBreakHigh && x.earlyLowRising),
    makeComboStat('VALUE_HIGH_LOW_D1_D5',   x => x.earlyValueReIncreasing && x.earlyNearOrBreakHigh && x.earlyLowRising && inDays(x.firstIgnReadyOrPrioDays, 1, 5)),
    makeComboStat('VALUE_HIGH_LOW_D6_D10',  x => x.earlyValueReIncreasing && x.earlyNearOrBreakHigh && x.earlyLowRising && inDays(x.firstIgnReadyOrPrioDays, 6, 10)),
    makeComboStat('EARLY_20_THEN_50',       x => x.firstReach20FromQva != null && x.firstReach20FromQva <= 5),
    makeComboStat('EARLY_30_THEN_50',       x => x.firstReach30FromQva != null && x.firstReach30FromQva <= 5),
    makeComboStat('D_EXCLUDE_BIG_STYLE',    x => x.bestOperationGrade === 'D_EXCLUDE' && (x.earlyValueReIncreasing || x.earlyNearOrBreakHigh)),
    makeComboStat('SHAKE10_BIG_STYLE',      x => x.breach10 && (x.earlyValueReIncreasing || x.earlyLowRising || x.earlyNearOrBreakHigh)),
    makeComboStat('LATE_FIRE_D6_D10',       x => inDays(x.firstIgnReadyOrPrioDays, 6, 10)),
    makeComboStat('SUPER_FIRE_STYLE',       x => x.bigGroups.includes('SUPER_FIRE') && x.earlyValueReIncreasing && x.earlyNearOrBreakHigh),
  ];
  // Top 랭킹 4종
  const comboBig50TopByRate      = comboMatrix.slice().sort((a,b) => b.big50Rate     - a.big50Rate).slice(0, 15);
  const comboSuperFireTopByRate  = comboMatrix.slice().sort((a,b) => b.superFireRate - a.superFireRate).slice(0, 15);
  const comboBig50TopByLift      = comboMatrix.filter(c => c.n >= 100).slice().sort((a,b) => b.big50Lift - a.big50Lift).slice(0, 15);
  const comboBig50TopByEfficiency = comboMatrix.slice().sort((a,b) => b.efficiency - a.efficiency).slice(0, 15);

  // 10) 정밀 분석 — D_EXCLUDE-but-BIG_50 / -10%-흔들고-BIG_50 / 2차 발화
  const dExcludeBig50Items = followups.filter(x => x.bestOperationGrade === 'D_EXCLUDE' && x.bigGroups.includes('BIG_50'));
  const dExcludeBig50Refined = (() => {
    const n = dExcludeBig50Items.length;
    if (n === 0) return { n: 0 };
    const q1n = dExcludeBig50Items.filter(x => x.qvaType === 'QVA1').length;
    const reasonCounts = {};
    for (const x of dExcludeBig50Items) {
      for (const r of exclusionReason(x)) reasonCounts[r] = (reasonCounts[r] || 0) + 1;
    }
    const fr50 = dExcludeBig50Items.filter(x => x.firstReach50FromQva).map(x => x.firstReach50FromQva);
    return {
      n,
      shareOfBig50: rate(n, bigGroups.BIG_50.length),
      qva1Count: q1n, qva2Count: n - q1n,
      qva1Share: rate(q1n, n), qva2Share: rate(n - q1n, n),
      reasonCounts,
      avgMaxUp:   Number((avg(dExcludeBig50Items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      avgMaxDrop: Number((avg(dExcludeBig50Items.map(x => x.maxDropPct))   ?? 0).toFixed(2)),
      avgFirstReach50: fr50.length ? Number(avg(fr50).toFixed(1)) : null,
      earlyValueShare:    rate(dExcludeBig50Items.filter(x => x.earlyValueReIncreasing).length, n),
      earlyHighShare:     rate(dExcludeBig50Items.filter(x => x.earlyNearOrBreakHigh).length, n),
      earlyLowShare:      rate(dExcludeBig50Items.filter(x => x.earlyLowRising).length, n),
      earlyIgnitionShare: rate(dExcludeBig50Items.filter(x => x.earlyIgnition).length, n),
    };
  })();

  const shakeBig50Items = followups.filter(x => x.breach10 && x.bigGroups.includes('BIG_50'));
  const shakeBig50Refined = (() => {
    const n = shakeBig50Items.length;
    if (n === 0) return { n: 0 };
    const q1n = shakeBig50Items.filter(x => x.qvaType === 'QVA1').length;
    const fr50 = shakeBig50Items.filter(x => x.firstReach50FromQva).map(x => x.firstReach50FromQva);
    return {
      n,
      shareOfBig50: rate(n, bigGroups.BIG_50.length),
      qva1Count: q1n, qva2Count: n - q1n,
      avgMaxUp:   Number((avg(shakeBig50Items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      avgMaxDrop: Number((avg(shakeBig50Items.map(x => x.maxDropPct))   ?? 0).toFixed(2)),
      avgFirstReach50: fr50.length ? Number(avg(fr50).toFixed(1)) : null,
      earlyValueRate:    rate(shakeBig50Items.filter(x => x.earlyValueReIncreasing).length, n),
      earlyHighRate:     rate(shakeBig50Items.filter(x => x.earlyNearOrBreakHigh).length, n),
      earlyLowRate:      rate(shakeBig50Items.filter(x => x.earlyLowRising).length, n),
      earlyIgnitionRate: rate(shakeBig50Items.filter(x => x.earlyIgnition).length, n),
      breach15ThenBig50: shakeBig50Items.filter(x => x.breach15).length,
    };
  })();

  const secondFireItems = followups.filter(x =>
    x.firstReach20FromQva != null && x.firstReach20FromQva <= 5 && x.bigGroups.includes('BIG_50'));
  const secondFireRefined = (() => {
    const n = secondFireItems.length;
    if (n === 0) return { n: 0 };
    const q1n = secondFireItems.filter(x => x.qvaType === 'QVA1').length;
    const fr50 = secondFireItems.filter(x => x.firstReach50FromQva).map(x => x.firstReach50FromQva);
    return {
      n,
      shareOfBig50: rate(n, bigGroups.BIG_50.length),
      qva1Count: q1n, qva2Count: n - q1n,
      qva1Share: rate(q1n, n), qva2Share: rate(n - q1n, n),
      avgFirstReach20: Number((avg(secondFireItems.map(x => x.firstReach20FromQva)) ?? 0).toFixed(1)),
      avgFirstReach50: fr50.length ? Number(avg(fr50).toFixed(1)) : null,
      avgGapFirst20To50: fr50.length
        ? Number((avg(secondFireItems.filter(x => x.firstReach50FromQva).map(x => x.firstReach50FromQva - x.firstReach20FromQva))).toFixed(1))
        : null,
      avgMaxUp: Number((avg(secondFireItems.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      breach5BetweenRate:  rate(secondFireItems.filter(x => x.breach5).length, n),
      breach10BetweenRate: rate(secondFireItems.filter(x => x.breach10).length, n),
      superFireSubsetN: secondFireItems.filter(x => x.bigGroups.includes('SUPER_FIRE')).length,
      superFireSubsetRate: rate(secondFireItems.filter(x => x.bigGroups.includes('SUPER_FIRE')).length, n),
    };
  })();

  // 11) 대표 사례 — 각 그룹 15개
  function caseRow(x, extraTag) {
    return {
      code: x.code, name: x.name, qvaType: x.qvaType, qvaDate: x.qvaDate,
      qvaClose: x.qvaClose, qvaHigh: x.qvaHigh,
      maxUpsidePct: x.maxUpsidePct, maxDropPct: x.maxDropPct,
      firstReach20: x.firstReach20FromQva, firstReach30: x.firstReach30FromQva,
      firstReach50: x.firstReach50FromQva, firstReach100: x.firstReach100FromQva,
      firstIgnDay: x.firstIgnReadyOrPrioDays,
      bestOperationGrade: x.bestOperationGrade,
      exclusionReasons: x.bestOperationGrade === 'D_EXCLUDE' ? exclusionReason(x) : [],
      extraTag: extraTag || null,
    };
  }
  function interpretBig(x) {
    const parts = [];
    if (x.qvaType === 'QVA2' && x.breach10) parts.push('QVA2 이후 크게 흔들렸지만 결국 급등');
    else if (x.breach10) parts.push('-10% 이상 흔들고 회복 급등');
    if (x.firstReach20FromQva != null && x.firstReach20FromQva <= 5 && x.maxUpsidePct >= 50)
      parts.push(`D+${x.firstReach20FromQva}에 1차 +20% 후 2차 상승`);
    if (x.bestOperationGrade === 'D_EXCLUDE' && x.maxUpsidePct >= 50)
      parts.push('안전 압축에서는 제외됐지만 실제 BIG_50');
    if (x.earlyValueReIncreasing && x.earlyNearOrBreakHigh)
      parts.push('초기 거래대금 재증가 + QVA 고가 접근');
    if (parts.length === 0) parts.push('QVA 후 큰 상승');
    return parts.join(' / ');
  }
  const big50Cases = followups
    .filter(x => x.bigGroups.includes('BIG_50'))
    .slice().sort((a,b) => (b.maxUpsidePct||0) - (a.maxUpsidePct||0))
    .slice(0, 15).map(x => ({ ...caseRow(x), interpret: interpretBig(x) }));
  const superFireCases = followups
    .filter(x => x.bigGroups.includes('SUPER_FIRE'))
    .slice().sort((a,b) => (b.maxUpsidePct||0) - (a.maxUpsidePct||0))
    .slice(0, 15).map(x => ({ ...caseRow(x), interpret: interpretBig(x) }));
  const shakeBig50Cases = followups
    .filter(x => x.breach10 && x.bigGroups.includes('BIG_50'))
    .slice().sort((a,b) => (b.maxUpsidePct||0) - (a.maxUpsidePct||0))
    .slice(0, 15).map(x => ({ ...caseRow(x, 'shake10+big50'), interpret: interpretBig(x) }));
  const dExcludeBig50Cases = followups
    .filter(x => x.bestOperationGrade === 'D_EXCLUDE' && x.bigGroups.includes('BIG_50'))
    .slice().sort((a,b) => (b.maxUpsidePct||0) - (a.maxUpsidePct||0))
    .slice(0, 15).map(x => ({ ...caseRow(x, 'd_exclude+big50'), interpret: interpretBig(x) }));
  const secondFireCases = followups
    .filter(x => x.firstReach20FromQva != null && x.firstReach20FromQva <= 5 &&
                 (x.bigGroups.includes('BIG_50') || x.bigGroups.includes('SUPER_FIRE')))
    .slice().sort((a,b) => (b.maxUpsidePct||0) - (a.maxUpsidePct||0))
    .slice(0, 15).map(x => ({ ...caseRow(x, 'second_fire'), interpret: interpretBig(x) }));

  // BIG-RUN 분석 결과 묶음
  const bigRun = {
    bigGroupStats,
    qvaCompare,
    shakeGroups,
    dExcludeGroups,
    earlyStats,
    ignDayStats,
    secondFireGroups,
    cases: { big50Cases, superFireCases, shakeBig50Cases, dExcludeBig50Cases, secondFireCases },
    // 조건 조합 매트릭스 (15종) + 4 랭킹 + 3 정밀 분석
    baselines: { big50Rate: BASELINE_BIG50, superFireRate: BASELINE_SUPER_FIRE, totalN: followups.length },
    comboMatrix,
    comboBig50TopByRate,
    comboSuperFireTopByRate,
    comboBig50TopByLift,
    comboBig50TopByEfficiency,
    refined: {
      dExcludeBig50: dExcludeBig50Refined,
      shakeBig50:    shakeBig50Refined,
      secondFire:    secondFireRefined,
    },
  };

  // ─── 6-B. 오늘 기준 운영 압축 후보 (A_READY / B_WATCH) ────────────────
  // 종목별 최신 daily 시점 중 operationGrade가 A_READY/B_WATCH인 entry 추출
  const opPerCode = new Map();
  for (const x of followups) {
    for (let i = x.daily.length - 1; i >= 0; i--) {
      const d = x.daily[i];
      if (d.currentDate > todayStr) continue;
      if (d.operationGrade === 'A_READY' || d.operationGrade === 'B_WATCH') {
        const entry = {
          code: x.code, name: x.name, qvaType: x.qvaType, qvaDate: x.qvaDate,
          qvaClose: x.qvaClose, qvaHigh: x.qvaHigh,
          ...d,
          maxUpsidePct: x.maxUpsidePct,
          hasOneDsLater: x.hasOneDs,
          firstOneDsDays: x.firstOneDsDays,
          bestOperationGrade: x.bestOperationGrade,
        };
        const existing = opPerCode.get(x.code);
        if (!existing ||
            d.currentDate > existing.currentDate ||
            (d.currentDate === existing.currentDate &&
             (GRADE_RANK[d.operationGrade] || 0) > (GRADE_RANK[existing.operationGrade] || 0))) {
          opPerCode.set(x.code, entry);
        }
        break;
      }
    }
  }
  function dayBucketPriority(d) {
    // D+2~D+5 우선, 그 외 후순위
    if (d >= 2 && d <= 5) return 0;
    if (d === 1) return 1;
    return 2;
  }
  function distanceCloseness(dist) {
    // -3 ~ +3에 가까운 순 — 절대값이 작을수록 우선
    if (dist == null) return 999;
    return Math.abs(dist);
  }
  const operationalCandidatesToday = [...opPerCode.values()].sort((a, b) => {
    // 1) operationGrade — A_READY 먼저
    const g = (GRADE_RANK[b.operationGrade] || 0) - (GRADE_RANK[a.operationGrade] || 0);
    if (g !== 0) return g;
    // 2) daysFromQva D+2~D+5 우선
    const db = dayBucketPriority(a.daysFromQva) - dayBucketPriority(b.daysFromQva);
    if (db !== 0) return db;
    // 3) isValueReIncreasing true 우선
    const v = (b.isValueReIncreasing ? 1 : 0) - (a.isValueReIncreasing ? 1 : 0);
    if (v !== 0) return v;
    // 4) distanceToQvaHighPct가 -3~+3에 가까운 순
    const dc = distanceCloseness(a.distanceToQvaHighPct) - distanceCloseness(b.distanceToQvaHighPct);
    if (dc !== 0) return dc;
    // 5) maxDropFromQvaClosePct가 덜 나쁜 순 (큰 값 우선)
    const md = (b.maxDropFromQvaClosePct ?? -999) - (a.maxDropFromQvaClosePct ?? -999);
    if (md !== 0) return md;
    // 6) ignitionWatchScore 높은 순
    return b.ignitionWatchScore - a.ignitionWatchScore;
  });

  // 과열/이탈로 제외된 후보 카운트 (D_EXCLUDE 중 사유별)
  const excludedTooExtended = followups.filter(x => x.daily.some(d => d.isTooExtendedForOperation)).length;
  const excludedBreach5 = followups.filter(x => x.breach5).length;

  // ─── 7. 요약 + 결론 ──────────────────────────────────────────────────
  const allStat = groups.find(g => g.group === 'ALL_QVA_POOL');
  const ignStat = groups.find(g => g.group === 'IGNITION_READY');
  const qva1Stat = groups.find(g => g.group === 'QVA1_POOL');
  const qva2Stat = groups.find(g => g.group === 'QVA2_POOL');

  // 가장 성과 좋은 그룹 (1DS 발화율 기준)
  const sortedByOneDs = groups
    .filter(g => g.n >= 30 && !['ALL_QVA_POOL'].includes(g.group))
    .slice().sort((a, b) => b.oneDsRate - a.oneDsRate);
  const bestOneDsGroup = sortedByOneDs[0] || null;
  const sortedByHit10 = groups
    .filter(g => g.n >= 30 && !['ALL_QVA_POOL'].includes(g.group))
    .slice().sort((a, b) => b.hit10Rate - a.hit10Rate);
  const bestHit10Group = sortedByHit10[0] || null;
  // 가장 성과 좋은 경과일 구간
  const sortedDays = daysGroups.filter(g => g.n >= 10).slice().sort((a, b) => b.hit10Rate - a.hit10Rate);
  const bestBucket = sortedDays[0] || null;

  const opAllStat   = operationalGroups.find(g => g.group === 'OPERATIONAL_ALL');
  const opAReadyStat = operationalGroups.find(g => g.group === 'A_READY');
  const opBWatchStat = operationalGroups.find(g => g.group === 'B_WATCH');

  const summary = {
    totalQvaSignals: qvaRows.length,
    qva1Count: qva1.length,
    qva2Count: qva2.length,
    tracked: followups.length,
    skipped,
    followDays: FOLLOW_DAYS,
    allOneDsRate:  allStat?.oneDsRate ?? 0,
    allHit10Rate:  allStat?.hit10Rate ?? 0,
    allHit20Rate:  allStat?.hit20Rate ?? 0,
    ignReadyN:     ignStat?.n ?? 0,
    ignReadyOneDsRate: ignStat?.oneDsRate ?? 0,
    ignReadyHit10Rate: ignStat?.hit10Rate ?? 0,
    qva1OneDsRate: qva1Stat?.oneDsRate ?? 0,
    qva2OneDsRate: qva2Stat?.oneDsRate ?? 0,
    bestOneDsGroup,
    bestHit10Group,
    bestBucket,
    // 운영 압축
    operationalAllN: opAllStat?.n ?? 0,
    operationalAllHit10Rate: opAllStat?.hit10Rate ?? 0,
    operationalAllBreach10Rate: opAllStat?.breach10Rate ?? 0,
    aReadyN:  opAReadyStat?.n ?? 0,
    bWatchN:  opBWatchStat?.n ?? 0,
    excludedTooExtended,
    excludedBreach5,
    operationalCandidatesTodayCount: operationalCandidatesToday.length,
  };

  // ─── 8. JSON 저장 + HTML 렌더 ────────────────────────────────────────
  const result = {
    meta: {
      title: 'QVA1/QVA2 → 1DS 후보풀 선행 효과 검증',
      generatedAt: new Date().toISOString(),
      followDays: FOLLOW_DAYS,
    },
    summary,
    groups,
    operationalGroups,
    daysGroups,
    successCases,
    failCases,
    todayCandidates,
    operationalCandidatesToday,
    bigRun,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  console.log(`✅ JSON: ${OUT_JSON}`);

  fs.writeFileSync(OUT_HTML, renderHtml(result));
  console.log(`✅ HTML: ${OUT_HTML}`);

  // ─── 9. 콘솔 요약 ────────────────────────────────────────────────────
  console.log();
  console.log('━'.repeat(80));
  console.log('=== 요약 ===');
  console.log(`전체 QVA 후보: ${qvaRows.length}건 (QVA1 ${qva1.length} / QVA2 ${qva2.length})`);
  console.log(`추적 완료: ${followups.length}건 (skip ${skipped})`);
  console.log();
  console.log(`전체 (ALL_QVA_POOL):`);
  console.log(`  20일 내 1DS 발화: ${summary.allOneDsRate}%`);
  console.log(`  20일 내 +10% 도달: ${summary.allHit10Rate}%`);
  console.log(`  20일 내 +20% 도달: ${summary.allHit20Rate}%`);
  console.log();
  console.log(`IGNITION_READY (${summary.ignReadyN}건):`);
  console.log(`  1DS 발화: ${summary.ignReadyOneDsRate}% / +10% 도달: ${summary.ignReadyHit10Rate}%`);
  console.log();
  console.log(`QVA1 vs QVA2:  1DS 발화율 ${summary.qva1OneDsRate}% vs ${summary.qva2OneDsRate}%`);
  if (bestOneDsGroup) console.log(`가장 좋은 그룹 (1DS 발화): ${bestOneDsGroup.group} = ${bestOneDsGroup.oneDsRate}% (n=${bestOneDsGroup.n})`);
  if (bestHit10Group) console.log(`가장 좋은 그룹 (+10% 급등): ${bestHit10Group.group} = ${bestHit10Group.hit10Rate}% (n=${bestHit10Group.n})`);
  if (bestBucket) console.log(`가장 좋은 경과일 구간: ${bestBucket.group} = +10% ${bestBucket.hit10Rate}% (n=${bestBucket.n})`);
  console.log();
  console.log('━'.repeat(80));
  console.log('=== 운영 압축 ===');
  console.log(`기존 IGNITION_READY (전 기간 한 번이라도): ${summary.ignReadyN}건`);
  console.log(`운영 압축 후보 (A_READY + B_WATCH bestGrade): ${summary.operationalAllN}건`);
  console.log(`  A_READY: ${summary.aReadyN}건 / B_WATCH: ${summary.bWatchN}건`);
  console.log(`  +10% 도달률: ${summary.operationalAllHit10Rate}% / -10% 이탈률: ${summary.operationalAllBreach10Rate}%`);
  console.log(`제외 사유:`);
  console.log(`  과열 (+40% 초과 도달): ${summary.excludedTooExtended}건`);
  console.log(`  -5% 이상 이탈: ${summary.excludedBreach5}건`);
  console.log(`오늘 기준 운영 후보 (A_READY/B_WATCH 최신 시점): ${summary.operationalCandidatesTodayCount}건`);
  console.log();

  // ─── BIG-RUN 검증 콘솔 출력 ──────────────────────────────────────────
  console.log('━'.repeat(80));
  console.log('=== 대상승(BIG-RUN) 검증 ===');
  const bg = bigRun.bigGroupStats;
  const gOf = (k) => bg.find(g => g.group === k) || { n: 0, shareOfAll: 0 };
  const b20 = gOf('BIG_20'), b30 = gOf('BIG_30'), b50 = gOf('BIG_50'), sf = gOf('SUPER_FIRE');
  console.log(`BIG_20:     ${b20.n}건 (${b20.shareOfAll}%) — avgMaxUp ${b20.avgMaxUp}%`);
  console.log(`BIG_30:     ${b30.n}건 (${b30.shareOfAll}%) — avgMaxUp ${b30.avgMaxUp}%`);
  console.log(`BIG_50:     ${b50.n}건 (${b50.shareOfAll}%) — avgMaxUp ${b50.avgMaxUp}%`);
  console.log(`SUPER_FIRE: ${sf.n}건 (${sf.shareOfAll}%) — avgMaxUp ${sf.avgMaxUp}%`);
  console.log();
  const q1c = bigRun.qvaCompare[0], q2c = bigRun.qvaCompare[1];
  console.log(`QVA1 BIG_50: ${q1c.big50Rate}% (n=${q1c.n}) / QVA2 BIG_50: ${q2c.big50Rate}% (n=${q2c.n})`);
  console.log(`QVA1 SUPER_FIRE: ${q1c.superFireRate}% / QVA2 SUPER_FIRE: ${q2c.superFireRate}%`);
  console.log();
  const sg10b50 = bigRun.shakeGroups.find(g => g.group === 'SHAKE_10_BIG_50');
  console.log(`-10% 이상 흔들고 BIG_50 간 종목: ${sg10b50.n}건 (BIG_50 중 ${sg10b50.shareOfBig50}%)`);
  const dxb50 = bigRun.dExcludeGroups.find(g => g.group === 'D_EXCLUDE_AND_BIG_50');
  console.log(`기존 운영 압축에서 제외된 BIG_50: ${dxb50.n}건 (BIG_50 중 ${dxb50.shareOfTarget}%)`);
  const sf2 = bigRun.secondFireGroups.find(g => g.group === 'EARLY_20_THEN_50');
  console.log(`D+5 안 +20% 먼저 + BIG_50 (2차 발화): ${sf2.n}건`);
  console.log();
  const earlyBest = bigRun.earlyStats.slice().sort((a,b) => b.big50Rate - a.big50Rate)[0];
  if (earlyBest) console.log(`BIG_50 가장 잘 잡은 초기 전조 조합: ${earlyBest.group} = ${earlyBest.big50Rate}% (n=${earlyBest.n})`);
  const ignBest = bigRun.ignDayStats.filter(g => g.n >= 10).slice().sort((a,b) => b.big50Rate - a.big50Rate)[0];
  if (ignBest) console.log(`BIG_50 가장 잘 잡은 경과일 구간: ${ignBest.group} = ${ignBest.big50Rate}% (n=${ignBest.n})`);
  console.log();

  // ─── BIG-RUN 조건 조합 매트릭스 콘솔 출력 ────────────────────────────
  console.log('━'.repeat(80));
  console.log('=== BIG-RUN 조건 조합 매트릭스 (15종) ===');
  console.log(`기준선 (baseline): BIG_50 ${bigRun.baselines.big50Rate}% / SUPER_FIRE ${bigRun.baselines.superFireRate}% (전체 n=${bigRun.baselines.totalN})`);
  console.log();
  const dumpTopList = (title, list, extractor) => {
    console.log(`${title}:`);
    list.slice(0, 5).forEach((c, i) => {
      console.log(`  ${i+1}. ${c.group.padEnd(24)} ${extractor(c)} (n=${c.n}, ${c.sampleQuality})`);
    });
    console.log();
  };
  dumpTopList('BIG_50% Top 5',     bigRun.comboBig50TopByRate,
    c => `BIG_50 ${c.big50Rate}% (lift ${c.big50Lift}x)`);
  dumpTopList('SUPER_FIRE% Top 5', bigRun.comboSuperFireTopByRate,
    c => `SUPER_FIRE ${c.superFireRate}% (lift ${c.superFireLift}x)`);
  dumpTopList('BIG_50 lift Top 5 (n≥100)', bigRun.comboBig50TopByLift,
    c => `lift ${c.big50Lift}x — BIG_50 ${c.big50Rate}%`);
  dumpTopList('BIG_50 효율 Top 5 (n × rate)', bigRun.comboBig50TopByEfficiency,
    c => `efficiency ${c.efficiency} — BIG_50 ${c.big50Count}건 / ${c.big50Rate}%`);

  console.log('=== 정밀 분석 3종 ===');
  const r1 = bigRun.refined.dExcludeBig50;
  const r2 = bigRun.refined.shakeBig50;
  const r3 = bigRun.refined.secondFire;
  console.log(`📦 D_EXCLUDE-but-BIG_50: ${r1.n}건 (BIG_50 중 ${r1.shareOfBig50 || 0}%) — QVA1/QVA2 ${r1.qva1Count||0}/${r1.qva2Count||0}, value전조 ${r1.earlyValueShare||0}%, high접근 ${r1.earlyHighShare||0}%`);
  console.log(`⚡ -10% 흔들고 BIG_50: ${r2.n}건 (BIG_50 중 ${r2.shareOfBig50 || 0}%) — 회복 전조 value ${r2.earlyValueRate||0}% / high ${r2.earlyHighRate||0}% / low ${r2.earlyLowRate||0}% / ignition ${r2.earlyIgnitionRate||0}%`);
  console.log(`🚀 2차 발화 (D+5 +20% → BIG_50): ${r3.n}건 (SUPER_FIRE까지 ${r3.superFireSubsetN||0}건, ${r3.superFireSubsetRate||0}%) — 1차→최종 평균 ${r3.avgGapFirst20To50||'—'}일`);
  console.log();
  console.log(`⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await closePool();
}

// ─── HTML 렌더 ───────────────────────────────────────────────────────────
function renderHtml(result) {
  const { meta, summary, groups, operationalGroups, daysGroups, successCases, failCases, todayCandidates, operationalCandidatesToday, bigRun } = result;
  const groupLabelKR = {
    ALL_QVA_POOL: '전체 QVA 후보',
    QVA1_POOL: 'QVA1 (원조)',
    QVA2_POOL: 'QVA2 (흡수형)',
    PRICE_ALIVE: '가격 유지',
    NEAR_QVA_HIGH: 'QVA 고가 근처 접근',
    VALUE_REINCREASING: '거래대금 재증가',
    LOW_RISING: '저점 상승',
    NOT_OVER_EXTENDED: '과한 상승 X',
    IGNITION_READY: '🔥 발화 임박',
    PRIORITY_WATCH: '⏳ 우선 관찰',
    PREPARING: '👀 준비 중',
    TRACK_ONLY: '📡 추적만',
    // 운영 그룹
    OPERATIONAL_ALL: '운영 압축 후보 전체',
    A_READY:   '🔥 오늘 우선 확인',
    B_WATCH:   '⏳ 장중 관찰',
    C_WAIT:    '👀 대기',
    D_EXCLUDE: '📦 제외/접기',
  };

  const conclusion = (() => {
    const q1 = summary.qva1OneDsRate, q2 = summary.qva2OneDsRate;
    if (q1 > q2 + 5)      return `QVA1이 QVA2보다 1DS 발화율 우위 (${q1}% vs ${q2}%)`;
    else if (q2 > q1 + 5) return `QVA2가 QVA1보다 1DS 발화율 우위 (${q2}% vs ${q1}%)`;
    else                  return `QVA1·QVA2 1DS 발화율 비슷 (${q1}% vs ${q2}%) — 보완 관계`;
  })();

  function groupRow(g) {
    const cls = g.oneDsRate >= 20 ? 'pos' : g.oneDsRate >= 10 ? 'mid' : 'neu';
    return '<tr>' +
      `<td><b>${esc(groupLabelKR[g.group] || g.group)}</b><div class="code">${esc(g.group)}</div></td>` +
      `<td class="num">${g.n}</td>` +
      `<td class="num ${cls}">${g.oneDsRate}%</td>` +
      `<td class="num">${g.avgOneDsDays != null ? g.avgOneDsDays + 'd' : '—'}</td>` +
      `<td class="num">${g.hit10Rate}%</td>` +
      `<td class="num">${g.hit15Rate}%</td>` +
      `<td class="num">${g.hit20Rate}%</td>` +
      `<td class="num">${g.hit30Rate}%</td>` +
      `<td class="num">${fmtPct(g.avgD5)}</td>` +
      `<td class="num">${fmtPct(g.avgD10)}</td>` +
      `<td class="num">${fmtPct(g.avgD20)}</td>` +
      `<td class="num neg">${g.breach5Rate}%</td>` +
      `<td class="num neg">${g.breach10Rate}%</td>` +
      '</tr>';
  }

  const groupsTable = '<table class="t"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>1DS 발화율</th><th>평균 일</th>' +
    '<th>+10%</th><th>+15%</th><th>+20%</th><th>+30%</th>' +
    '<th>D+5 최고</th><th>D+10 최고</th><th>D+20 최고</th>' +
    '<th>-5% 이탈</th><th>-10% 이탈</th>' +
    '</tr></thead><tbody>' + groups.map(groupRow).join('') + '</tbody></table>';

  const daysTable = '<table class="t"><thead><tr>' +
    '<th>경과일 (첫 IGNITION_READY)</th><th>n</th><th>1DS 발화율</th>' +
    '<th>+10%</th><th>+15%</th><th>+20%</th>' +
    '<th>D+5 최고</th><th>D+10 최고</th><th>D+20 최고</th>' +
    '</tr></thead><tbody>' +
    daysGroups.map(g => '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td class="num pos">${g.oneDsRate}%</td>` +
      `<td class="num">${g.hit10Rate}%</td>` +
      `<td class="num">${g.hit15Rate}%</td>` +
      `<td class="num">${g.hit20Rate}%</td>` +
      `<td class="num">${fmtPct(g.avgD5)}</td>` +
      `<td class="num">${fmtPct(g.avgD10)}</td>` +
      `<td class="num">${fmtPct(g.avgD20)}</td>` +
      '</tr>').join('') + '</tbody></table>';

  function caseRow(c, kind) {
    const tag = kind === 'success'
      ? (c.hasOneDs ? `1DS 발화 (D+${c.firstOneDsDays})` : `+${c.hit20Days}d 만에 +20% 도달`)
      : `-10% 이탈`;
    return '<tr>' +
      `<td><b>${esc(c.name)}</b><div class="code">${esc(c.code)}</div></td>` +
      `<td><span class="pill ${c.qvaType === 'QVA1' ? 'p-q1' : 'p-q2'}">${c.qvaType}</span></td>` +
      `<td>${esc(c.qvaDate)}</td>` +
      `<td class="num">${fmtInt(c.qvaClose)}</td>` +
      `<td class="num">${fmtInt(c.qvaHigh)}</td>` +
      `<td class="num ${kind === 'success' ? 'pos' : ''}">${fmtPct(c.maxUpsidePct)}</td>` +
      `<td class="num ${kind === 'fail' ? 'neg' : ''}">${fmtPct(c.maxDropPct)}</td>` +
      `<td>${esc(tag)}</td>` +
      '</tr>';
  }
  const successTable = '<table class="t"><thead><tr>' +
    '<th>종목</th><th>유형</th><th>QVA 발생일</th><th>QVA 종가</th><th>QVA 고가</th>' +
    '<th>최대 상승률</th><th>최대 하락률</th><th>결과</th>' +
    '</tr></thead><tbody>' + successCases.map(c => caseRow(c, 'success')).join('') + '</tbody></table>';
  const failTable = '<table class="t"><thead><tr>' +
    '<th>종목</th><th>유형</th><th>QVA 발생일</th><th>QVA 종가</th><th>QVA 고가</th>' +
    '<th>최대 상승률</th><th>최대 하락률</th><th>결과</th>' +
    '</tr></thead><tbody>' + failCases.map(c => caseRow(c, 'fail')).join('') + '</tbody></table>';

  function todayRow(c, _) {
    const flagPill = (cond, text, cls) => cond
      ? `<span class="pill p-${cls}">${esc(text)}</span>`
      : `<span class="pill p-neu">${esc(text)} ✗</span>`;
    return '<tr>' +
      `<td><b>${esc(c.name)}</b><div class="code">${esc(c.code)}</div></td>` +
      `<td><span class="pill ${c.qvaType === 'QVA1' ? 'p-q1' : 'p-q2'}">${c.qvaType}</span></td>` +
      `<td>${esc(c.qvaDate)}</td>` +
      `<td class="num">D+${c.daysFromQva}</td>` +
      `<td class="num">${fmtPct(c.priceChangeFromQvaPct)}</td>` +
      `<td class="num">${fmtPct(c.distanceToQvaHighPct)}</td>` +
      `<td class="num neg">${fmtPct(c.maxDropFromQvaClosePct)}</td>` +
      `<td>${flagPill(c.isValueReIncreasing, '거래대금 살아남', 'good')}</td>` +
      `<td>${flagPill(c.isLowRising, '저점 상승', 'good')}</td>` +
      `<td class="num"><b>${c.ignitionWatchScore}</b></td>` +
      `<td>${esc(GRADE_LABEL[c.ignitionWatchGrade] || c.ignitionWatchGrade)}</td>` +
      `<td>${c.hasOneDsLater ? `이미 1DS 발화 (D+${c.firstOneDsDays})` : '—'}</td>` +
      `<td class="num">${fmtPct(c.maxUpsidePct)}</td>` +
      '</tr>';
  }
  const todayTopHtml = todayCandidates.slice(0, 15).map(todayRow).join('');
  const todayRestHtml = todayCandidates.slice(15).map(todayRow).join('');
  const todayTable = todayCandidates.length === 0
    ? '<div class="empty">오늘 기준 IGNITION_READY / PRIORITY_WATCH 후보가 없습니다.</div>'
    : '<table class="t"><thead><tr>' +
        '<th>종목</th><th>유형</th><th>QVA 발생일</th><th>경과일</th>' +
        '<th>QVA 대비 가격</th><th>QVA 고가까지</th><th>최대 하락</th>' +
        '<th>거래대금</th><th>저점</th><th>점수</th><th>등급</th>' +
        '<th>이후 1DS</th><th>이후 최대 상승</th>' +
        '</tr></thead><tbody>' + todayTopHtml + '</tbody></table>' +
        (todayRestHtml ? '<details><summary>나머지 ' + todayCandidates.slice(15).length + '개 펼치기</summary><table class="t"><tbody>' + todayRestHtml + '</tbody></table></details>' : '');

  // ─── 운영 그룹 성과표 (groupRow와 같은 형식) ──────────────────────────
  function opGroupRow(g) {
    const cls = g.hit10Rate >= 60 ? 'pos' : g.hit10Rate >= 40 ? 'mid' : 'neu';
    return '<tr>' +
      `<td><b>${esc(groupLabelKR[g.group] || g.group)}</b><div class="code">${esc(g.group)}</div></td>` +
      `<td class="num">${g.n}</td>` +
      `<td class="num ${cls}">${g.hit10Rate}%</td>` +
      `<td class="num">${g.hit15Rate}%</td>` +
      `<td class="num">${g.hit20Rate}%</td>` +
      `<td class="num">${fmtPct(g.avgD5)}</td>` +
      `<td class="num">${fmtPct(g.avgD10)}</td>` +
      `<td class="num neg">${g.breach5Rate}%</td>` +
      `<td class="num neg">${g.breach10Rate}%</td>` +
      '</tr>';
  }
  const opGroupsTable = '<table class="t"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>+10%</th><th>+15%</th><th>+20%</th>' +
    '<th>D+5 최고</th><th>D+10 최고</th><th>-5% 이탈</th><th>-10% 이탈</th>' +
    '</tr></thead><tbody>' + operationalGroups.map(opGroupRow).join('') + '</tbody></table>';

  // ─── 운영 후보 행 (오늘 기준) ─────────────────────────────────────────
  function interpret(c) {
    const lines = [];
    if (c.daysFromQva >= 2 && c.daysFromQva <= 5) lines.push('D+2~D+5 발화 대기 구간');
    if (c.maxDropFromQvaClosePct != null && c.maxDropFromQvaClosePct >= -5) lines.push('가격이 무너지지 않고 유지됨');
    if (c.distanceToQvaHighPct != null && c.distanceToQvaHighPct >= -7 && c.distanceToQvaHighPct <= 5) lines.push('QVA 고가 근처까지 다시 접근');
    if (c.isValueReIncreasing) lines.push('거래대금이 다시 살아남');
    if (c.isLowRising) lines.push('저점이 올라오는 흐름');
    if (c.isChasingRisk) lines.push('⚠ 추격 부담 (QVA 대비 +18% 초과)');
    if (c.isTooExtendedForOperation) lines.push('⚠ 과한 상승 — 운영 제외 대상');
    if (lines.length === 0) lines.push('단순 추적 상태');
    return lines.join(' · ');
  }
  function opRow(c) {
    const opGradeCls = c.operationGrade === 'A_READY' ? 'pos' : c.operationGrade === 'B_WATCH' ? 'mid' : 'neu';
    const flagPill = (cond, text) => cond
      ? `<span class="pill p-good">${esc(text)}</span>`
      : `<span class="pill p-neu">${esc(text)} ✗</span>`;
    return '<tr>' +
      `<td><b>${esc(c.name)}</b><div class="code">${esc(c.code)}</div></td>` +
      `<td><span class="pill ${c.qvaType === 'QVA1' ? 'p-q1' : 'p-q2'}">${c.qvaType}</span></td>` +
      `<td>${esc(c.qvaDate)}</td>` +
      `<td class="num">D+${c.daysFromQva}</td>` +
      `<td class="num">${fmtPct(c.priceChangeFromQvaPct)}</td>` +
      `<td class="num">${fmtPct(c.distanceToQvaHighPct)}</td>` +
      `<td class="num neg">${fmtPct(c.maxDropFromQvaClosePct)}</td>` +
      `<td>${flagPill(c.isValueReIncreasing, '거래대금 살아남')}</td>` +
      `<td>${flagPill(c.isLowRising, '저점 상승')}</td>` +
      `<td class="num">${c.ignitionWatchScore}</td>` +
      `<td class="${opGradeCls}"><b>${esc(OP_GRADE_LABEL[c.operationGrade] || c.operationGrade)}</b></td>` +
      `<td style="font-size:11px;color:#94a3b8;max-width:280px;">${esc(interpret(c))}</td>` +
      '</tr>';
  }
  const opTopHtml = operationalCandidatesToday.slice(0, 20).map(opRow).join('');
  const opRestHtml = operationalCandidatesToday.slice(20).map(opRow).join('');
  const operationalTodayTable = operationalCandidatesToday.length === 0
    ? '<div class="empty">오늘 기준 운영 압축 후보 (A_READY / B_WATCH)가 없습니다.</div>'
    : '<table class="t"><thead><tr>' +
        '<th>종목</th><th>유형</th><th>QVA 발생일</th><th>경과일</th>' +
        '<th>QVA 대비</th><th>QVA 고가까지</th><th>최대 하락</th>' +
        '<th>거래대금</th><th>저점</th><th>점수</th><th>운영 등급</th>' +
        '<th>화면 해석</th>' +
        '</tr></thead><tbody>' + opTopHtml + '</tbody></table>' +
        (opRestHtml ? '<details><summary>나머지 ' + operationalCandidatesToday.slice(20).length + '개 펼치기</summary><table class="t"><tbody>' + opRestHtml + '</tbody></table></details>' : '');

  // ─── BIG-RUN 검증 표 빌더 ────────────────────────────────────────────
  const bigGroupTable = '<table class="t"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>전체 대비</th><th>QVA1/QVA2</th>' +
    '<th>평균 max상승</th><th>중앙값</th>' +
    '<th>D+5 평균</th><th>D+10 평균</th><th>D+20 평균</th>' +
    '<th>첫 +10일</th><th>첫 +20일</th>' +
    '<th>-5%</th><th>-10%</th><th>-15%</th>' +
    '</tr></thead><tbody>' +
    bigRun.bigGroupStats.map(g => '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td class="num">${g.shareOfAll || 0}%</td>` +
      `<td class="num">${g.qva1Count||0}/${g.qva2Count||0}</td>` +
      `<td class="num pos">${fmtPct(g.avgMaxUp)}</td>` +
      `<td class="num">${fmtPct(g.medianMaxUp)}</td>` +
      `<td class="num">${fmtPct(g.avgD5)}</td>` +
      `<td class="num">${fmtPct(g.avgD10)}</td>` +
      `<td class="num">${fmtPct(g.avgD20)}</td>` +
      `<td class="num">${g.avgFirstReach10 ?? '—'}</td>` +
      `<td class="num">${g.avgFirstReach20 ?? '—'}</td>` +
      `<td class="num neg">${g.breach5Rate}%</td>` +
      `<td class="num neg">${g.breach10Rate}%</td>` +
      `<td class="num neg">${g.breach15Rate}%</td>` +
      '</tr>').join('') + '</tbody></table>';

  const qvaCompareTable = '<table class="t"><thead><tr>' +
    '<th>유형</th><th>n</th><th>BIG_20</th><th>BIG_30</th><th>BIG_50</th><th>SUPER_FIRE</th>' +
    '<th>평균 max상승</th><th>중앙값</th><th>-10% 이탈</th>' +
    '<th>BIG_30 중 -10% 흔든</th><th>BIG_50 중 -10% 흔든</th>' +
    '</tr></thead><tbody>' +
    bigRun.qvaCompare.map(g => '<tr>' +
      `<td><b>${esc(g.type)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td class="num">${g.big20Rate}%</td>` +
      `<td class="num">${g.big30Rate}%</td>` +
      `<td class="num pos">${g.big50Rate}%</td>` +
      `<td class="num pos">${g.superFireRate}%</td>` +
      `<td class="num">${fmtPct(g.avgMaxUp)}</td>` +
      `<td class="num">${fmtPct(g.medianMaxUp)}</td>` +
      `<td class="num neg">${g.breach10Rate}%</td>` +
      `<td class="num">${g.big30Shake10Rate}%</td>` +
      `<td class="num">${g.big50Shake10Rate}%</td>` +
      '</tr>').join('') + '</tbody></table>';

  const shakeTable = '<table class="t"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>BIG_20 중</th><th>BIG_30 중</th><th>BIG_50 중</th>' +
    '<th>QVA1/QVA2</th><th>평균 max상승</th><th>평균 max하락</th>' +
    '<th>+20% 도달일</th><th>+30%</th><th>+50%</th>' +
    '</tr></thead><tbody>' +
    bigRun.shakeGroups.map(g => '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td class="num">${g.shareOfBig20 || 0}%</td>` +
      `<td class="num">${g.shareOfBig30 || 0}%</td>` +
      `<td class="num pos">${g.shareOfBig50 || 0}%</td>` +
      `<td class="num">${(g.qva1Count||0)}/${(g.qva2Count||0)}</td>` +
      `<td class="num pos">${fmtPct(g.avgMaxUp)}</td>` +
      `<td class="num neg">${fmtPct(g.avgMaxDrop)}</td>` +
      `<td class="num">${g.avgFirstReach20 ?? '—'}</td>` +
      `<td class="num">${g.avgFirstReach30 ?? '—'}</td>` +
      `<td class="num">${g.avgFirstReach50 ?? '—'}</td>` +
      '</tr>').join('') + '</tbody></table>';

  const dExcludeTable = '<table class="t"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>대상 그룹 대비</th>' +
    '<th>평균 max상승</th><th>평균 max하락</th><th>제외 사유 (다중)</th>' +
    '</tr></thead><tbody>' +
    bigRun.dExcludeGroups.map(g => '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td class="num neg">${g.shareOfTarget || 0}%</td>` +
      `<td class="num pos">${fmtPct(g.avgMaxUp)}</td>` +
      `<td class="num neg">${fmtPct(g.avgMaxDrop)}</td>` +
      `<td style="font-size:11px;color:#94a3b8;">${esc(Object.entries(g.reasonCounts||{}).map(([k,v])=>k+' '+v).join(' / '))}</td>` +
      '</tr>').join('') + '</tbody></table>';

  const earlyTable = '<table class="t"><thead><tr>' +
    '<th>전조 조건</th><th>n</th><th>BIG_20</th><th>BIG_30</th><th>BIG_50</th><th>SUPER_FIRE</th>' +
    '<th>평균 max상승</th><th>-10% 이탈</th>' +
    '</tr></thead><tbody>' +
    bigRun.earlyStats.map(g => '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td class="num">${g.big20Rate}%</td>` +
      `<td class="num">${g.big30Rate}%</td>` +
      `<td class="num pos">${g.big50Rate}%</td>` +
      `<td class="num pos">${g.superFireRate}%</td>` +
      `<td class="num">${fmtPct(g.avgMaxUp)}</td>` +
      `<td class="num neg">${g.breach10Rate}%</td>` +
      '</tr>').join('') + '</tbody></table>';

  const ignDayTable = '<table class="t"><thead><tr>' +
    '<th>첫 IGNITION/PRIORITY 시점</th><th>n</th><th>BIG_20</th><th>BIG_30</th><th>BIG_50</th><th>SUPER_FIRE</th>' +
    '<th>평균 max상승</th><th>평균 max하락</th><th>-10% 이탈</th>' +
    '</tr></thead><tbody>' +
    bigRun.ignDayStats.map(g => '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n||0}</td>` +
      `<td class="num">${g.big20Rate||0}%</td>` +
      `<td class="num">${g.big30Rate||0}%</td>` +
      `<td class="num pos">${g.big50Rate||0}%</td>` +
      `<td class="num pos">${g.superFireRate||0}%</td>` +
      `<td class="num">${fmtPct(g.avgMaxUp)}</td>` +
      `<td class="num neg">${fmtPct(g.avgMaxDrop)}</td>` +
      `<td class="num neg">${g.breach10Rate||0}%</td>` +
      '</tr>').join('') + '</tbody></table>';

  const secondFireTable = '<table class="t"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>BIG_50 중</th><th>SUPER_FIRE 중</th><th>QVA1/QVA2</th>' +
    '<th>평균 max상승</th><th>평균 max하락</th><th>초기 +20일</th><th>최종 peak 평균일</th>' +
    '</tr></thead><tbody>' +
    bigRun.secondFireGroups.map(g => '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td class="num pos">${g.shareOfBig50||0}%</td>` +
      `<td class="num pos">${g.shareOfSuperFire||0}%</td>` +
      `<td class="num">${(g.qva1Count||0)}/${(g.qva2Count||0)}</td>` +
      `<td class="num pos">${fmtPct(g.avgMaxUp)}</td>` +
      `<td class="num neg">${fmtPct(g.avgMaxDrop)}</td>` +
      `<td class="num">${g.avgEarly20Days ?? '—'}</td>` +
      `<td class="num">${g.avgFinalPeakDays ?? '—'}</td>` +
      '</tr>').join('') + '</tbody></table>';

  function bigCaseRow(c) {
    const reasonsTxt = (c.exclusionReasons && c.exclusionReasons.length)
      ? c.exclusionReasons.join(' / ') : '—';
    return '<tr>' +
      `<td><b>${esc(c.name)}</b><div class="code">${esc(c.code)}</div></td>` +
      `<td><span class="pill ${c.qvaType === 'QVA1' ? 'p-q1' : 'p-q2'}">${c.qvaType}</span></td>` +
      `<td>${esc(c.qvaDate)}</td>` +
      `<td class="num">${fmtInt(c.qvaClose)}</td>` +
      `<td class="num">${fmtInt(c.qvaHigh)}</td>` +
      `<td class="num pos">${fmtPct(c.maxUpsidePct)}</td>` +
      `<td class="num neg">${fmtPct(c.maxDropPct)}</td>` +
      `<td class="num">${c.firstReach20 ?? '—'}</td>` +
      `<td class="num">${c.firstReach30 ?? '—'}</td>` +
      `<td class="num">${c.firstReach50 ?? '—'}</td>` +
      `<td class="num">${c.firstReach100 ?? '—'}</td>` +
      `<td class="num">${c.firstIgnDay ?? '—'}</td>` +
      `<td>${esc(c.bestOperationGrade)}</td>` +
      `<td style="font-size:11px;color:#94a3b8;">${esc(reasonsTxt)}</td>` +
      `<td style="font-size:11px;color:#cbd5e1;max-width:260px;">${esc(c.interpret || '')}</td>` +
      '</tr>';
  }
  function bigCaseTable(list, emptyMsg) {
    if (!list || list.length === 0) return `<div class="empty">${esc(emptyMsg)}</div>`;
    return '<table class="t"><thead><tr>' +
      '<th>종목</th><th>유형</th><th>QVA일</th><th>QVA종가</th><th>QVA고가</th>' +
      '<th>최대 상승</th><th>최대 하락</th>' +
      '<th>+20일</th><th>+30일</th><th>+50일</th><th>+100일</th>' +
      '<th>첫 IGN/PRIO</th><th>운영 등급</th><th>제외 사유</th><th>해석</th>' +
      '</tr></thead><tbody>' + list.map(bigCaseRow).join('') + '</tbody></table>';
  }
  const cases = bigRun.cases;
  const big50CasesHtml      = bigCaseTable(cases.big50Cases,      'BIG_50 사례 없음');
  const superFireCasesHtml  = bigCaseTable(cases.superFireCases,  'SUPER_FIRE 사례 없음');
  const shakeBig50CasesHtml = bigCaseTable(cases.shakeBig50Cases, '-10% 흔들고 BIG_50 간 사례 없음');
  const dExcludeBig50Html   = bigCaseTable(cases.dExcludeBig50Cases, '운영 압축에서 제외됐지만 BIG_50 사례 없음');
  const secondFireCasesHtml = bigCaseTable(cases.secondFireCases, '2차 발화 사례 없음');

  // ─── BIG-RUN 조건 조합 매트릭스 표 빌더 (섹션 17~22) ─────────────────
  const sampleQualityPill = (q) => {
    const map = { '신뢰가능': 'p-good', '참고가능': 'p-q2', '표본작음': 'p-neu', '해석주의': 'p-warn' };
    return `<span class="pill ${map[q] || 'p-neu'}">${esc(q)}</span>`;
  };
  function comboRow(c) {
    const liftCls50 = c.big50Lift >= 1.5 ? 'pos' : c.big50Lift >= 1.2 ? 'mid' : 'neu';
    const liftClsSF = c.superFireLift >= 1.5 ? 'pos' : c.superFireLift >= 1.2 ? 'mid' : 'neu';
    return '<tr>' +
      `<td><b>${esc(c.group)}</b></td>` +
      `<td class="num">${c.n}</td>` +
      `<td>${sampleQualityPill(c.sampleQuality)}</td>` +
      `<td class="num">${c.qva1Count}/${c.qva2Count}</td>` +
      `<td class="num">${c.big20Rate}%</td>` +
      `<td class="num">${c.big30Rate}%</td>` +
      `<td class="num pos">${c.big50Rate}% <span style="color:#94a3b8;font-size:10px;">(${c.big50Count})</span></td>` +
      `<td class="num pos">${c.superFireRate}% <span style="color:#94a3b8;font-size:10px;">(${c.superFireCount})</span></td>` +
      `<td class="num">${c.nonBigRate}%</td>` +
      `<td class="num ${liftCls50}">${c.big50Lift}x</td>` +
      `<td class="num ${liftClsSF}">${c.superFireLift}x</td>` +
      `<td class="num">${fmtPct(c.avgMaxUp)}</td>` +
      `<td class="num">${fmtPct(c.medianMaxUp)}</td>` +
      `<td class="num neg">${fmtPct(c.avgMaxDrop)}</td>` +
      `<td class="num neg">${c.breach5Rate}%</td>` +
      `<td class="num neg">${c.breach10Rate}%</td>` +
      `<td class="num">${fmtPct(c.avgD5)}</td>` +
      `<td class="num">${fmtPct(c.avgD10)}</td>` +
      `<td class="num">${fmtPct(c.avgD20)}</td>` +
      `<td class="num">${c.avgFirstReach20 ?? '—'}</td>` +
      `<td class="num">${c.avgFirstReach50 ?? '—'}</td>` +
      '</tr>';
  }
  const comboMatrixTable = '<table class="t"><thead><tr>' +
    '<th>조건 조합</th><th>n</th><th>표본</th><th>QVA1/QVA2</th>' +
    '<th>BIG_20</th><th>BIG_30</th><th>BIG_50</th><th>SUPER_FIRE</th><th>NON_BIG</th>' +
    '<th>BIG_50 lift</th><th>SUPER lift</th>' +
    '<th>평균 maxUp</th><th>중앙값</th><th>평균 maxDrop</th>' +
    '<th>-5%</th><th>-10%</th>' +
    '<th>D+5 평균</th><th>D+10 평균</th><th>D+20 평균</th>' +
    '<th>첫 +20일</th><th>첫 +50일</th>' +
    '</tr></thead><tbody>' + bigRun.comboMatrix.map(comboRow).join('') + '</tbody></table>';

  function topRankRow(c, primaryMetric) {
    return '<tr>' +
      `<td><b>${esc(c.group)}</b></td>` +
      `<td class="num">${c.n}</td>` +
      `<td>${sampleQualityPill(c.sampleQuality)}</td>` +
      `<td class="num pos"><b>${primaryMetric(c)}</b></td>` +
      `<td class="num">${c.big50Count}건 / ${c.big50Rate}%</td>` +
      `<td class="num">${c.superFireCount}건 / ${c.superFireRate}%</td>` +
      `<td class="num">${c.big50Lift}x</td>` +
      `<td class="num">${c.superFireLift}x</td>` +
      `<td class="num">${fmtPct(c.avgMaxUp)}</td>` +
      `<td class="num">${c.qva1Count}/${c.qva2Count}</td>` +
      `<td class="num neg">${c.breach10Rate}%</td>` +
      '</tr>';
  }
  const topRankHead = '<table class="t"><thead><tr>' +
    '<th>조건 조합</th><th>n</th><th>표본</th><th>지표</th>' +
    '<th>BIG_50</th><th>SUPER_FIRE</th>' +
    '<th>BIG_50 lift</th><th>SUPER lift</th>' +
    '<th>평균 maxUp</th><th>QVA1/QVA2</th><th>-10% 이탈</th>' +
    '</tr></thead><tbody>';
  const comboTopBig50Table = topRankHead +
    bigRun.comboBig50TopByRate.map(c => topRankRow(c, x => `BIG_50 ${x.big50Rate}%`)).join('') + '</tbody></table>';
  const comboTopSuperFireTable = topRankHead +
    bigRun.comboSuperFireTopByRate.map(c => topRankRow(c, x => `SUPER ${x.superFireRate}%`)).join('') + '</tbody></table>';
  const comboTopLiftTable = bigRun.comboBig50TopByLift.length === 0
    ? '<div class="empty">n≥100 조합 없음</div>'
    : topRankHead +
      bigRun.comboBig50TopByLift.map(c => topRankRow(c, x => `${x.big50Lift}x`)).join('') + '</tbody></table>';
  const comboTopEfficiencyTable = topRankHead +
    bigRun.comboBig50TopByEfficiency.map(c => topRankRow(c, x => `efficiency ${x.efficiency}`)).join('') + '</tbody></table>';

  // ─── 정밀 분석 카드 ──────────────────────────────────────────────────
  const r1 = bigRun.refined.dExcludeBig50;
  const r2 = bigRun.refined.shakeBig50;
  const r3 = bigRun.refined.secondFire;

  function reasonsLine(rc) {
    if (!rc) return '—';
    return Object.entries(rc).sort((a,b) => b[1]-a[1]).map(([k,v]) => `${k} ${v}`).join(' / ') || '—';
  }
  const refinedDExcludeCard = r1.n === 0
    ? '<div class="empty">D_EXCLUDE-but-BIG_50 케이스 없음</div>'
    : `<div class="card">
        <div class="card-row">
          <div class="stat"><div class="lbl">n (BIG_50 중)</div><div class="val">${r1.n}</div><div class="sub">${r1.shareOfBig50||0}%</div></div>
          <div class="stat"><div class="lbl">QVA1 / QVA2</div><div class="val">${r1.qva1Count}/${r1.qva2Count}</div><div class="sub">QVA2 ${r1.qva2Share||0}%</div></div>
          <div class="stat"><div class="lbl">평균 max상승</div><div class="val">${fmtPct(r1.avgMaxUp)}</div></div>
          <div class="stat"><div class="lbl">평균 max하락</div><div class="val">${fmtPct(r1.avgMaxDrop)}</div></div>
          <div class="stat"><div class="lbl">첫 +50% 평균일</div><div class="val">${r1.avgFirstReach50 ?? '—'}</div></div>
          <div class="stat"><div class="lbl">초기 value 전조</div><div class="val">${r1.earlyValueShare||0}%</div></div>
          <div class="stat"><div class="lbl">초기 고가 접근</div><div class="val">${r1.earlyHighShare||0}%</div></div>
          <div class="stat"><div class="lbl">초기 저점 상승</div><div class="val">${r1.earlyLowShare||0}%</div></div>
          <div class="stat"><div class="lbl">초기 IGNITION</div><div class="val">${r1.earlyIgnitionShare||0}%</div></div>
        </div>
        <div class="hint" style="margin-top:8px;">제외 사유 분포: <b>${esc(reasonsLine(r1.reasonCounts))}</b></div>
      </div>`;

  const refinedShakeCard = r2.n === 0
    ? '<div class="empty">-10% 흔들고 BIG_50 케이스 없음</div>'
    : `<div class="card">
        <div class="card-row">
          <div class="stat"><div class="lbl">n (BIG_50 중)</div><div class="val">${r2.n}</div><div class="sub">${r2.shareOfBig50||0}%</div></div>
          <div class="stat"><div class="lbl">QVA1 / QVA2</div><div class="val">${r2.qva1Count}/${r2.qva2Count}</div></div>
          <div class="stat"><div class="lbl">평균 max상승</div><div class="val">${fmtPct(r2.avgMaxUp)}</div></div>
          <div class="stat"><div class="lbl">평균 max하락</div><div class="val">${fmtPct(r2.avgMaxDrop)}</div></div>
          <div class="stat"><div class="lbl">첫 +50% 평균일</div><div class="val">${r2.avgFirstReach50 ?? '—'}</div></div>
          <div class="stat"><div class="lbl">value 전조</div><div class="val">${r2.earlyValueRate||0}%</div></div>
          <div class="stat"><div class="lbl">고가 접근</div><div class="val">${r2.earlyHighRate||0}%</div></div>
          <div class="stat"><div class="lbl">저점 상승</div><div class="val">${r2.earlyLowRate||0}%</div></div>
          <div class="stat"><div class="lbl">IGNITION</div><div class="val">${r2.earlyIgnitionRate||0}%</div></div>
          <div class="stat"><div class="lbl">-15% 까지 흔들고 회복</div><div class="val">${r2.breach15ThenBig50||0}</div></div>
        </div>
        <div class="hint" style="margin-top:8px;">→ 회복 전조 중 비율이 높은 항목이 "흔들리고 결국 큰 종목"의 공통 신호</div>
      </div>`;

  const refinedSecondCard = r3.n === 0
    ? '<div class="empty">2차 발화 케이스 없음</div>'
    : `<div class="card">
        <div class="card-row">
          <div class="stat"><div class="lbl">n (BIG_50 중)</div><div class="val">${r3.n}</div><div class="sub">${r3.shareOfBig50||0}%</div></div>
          <div class="stat"><div class="lbl">QVA1 / QVA2</div><div class="val">${r3.qva1Count}/${r3.qva2Count}</div></div>
          <div class="stat"><div class="lbl">1차 +20% 평균일</div><div class="val">${r3.avgFirstReach20 ?? '—'}</div></div>
          <div class="stat"><div class="lbl">최종 +50% 평균일</div><div class="val">${r3.avgFirstReach50 ?? '—'}</div></div>
          <div class="stat"><div class="lbl">1차→최종 평균 gap</div><div class="val">${r3.avgGapFirst20To50 ?? '—'}일</div></div>
          <div class="stat"><div class="lbl">SUPER_FIRE까지 간</div><div class="val">${r3.superFireSubsetN||0}</div><div class="sub">${r3.superFireSubsetRate||0}%</div></div>
          <div class="stat"><div class="lbl">중간 -5% 이탈</div><div class="val">${r3.breach5BetweenRate||0}%</div></div>
          <div class="stat"><div class="lbl">중간 -10% 이탈</div><div class="val">${r3.breach10BetweenRate||0}%</div></div>
          <div class="stat"><div class="lbl">평균 max상승</div><div class="val">${fmtPct(r3.avgMaxUp)}</div></div>
        </div>
        <div class="hint" style="margin-top:8px;">→ "+20%에서 끊지 않고 두면 평균 ${r3.avgGapFirst20To50 ?? '—'}일 후 +50%까지" 패턴 검증</div>
      </div>`;

  // 섹션 9 요약 카드
  const bg = bigRun.bigGroupStats;
  const gOf = (k) => bg.find(g => g.group === k) || { n: 0, shareOfAll: 0 };
  const b20s = gOf('BIG_20'), b30s = gOf('BIG_30'), b50s = gOf('BIG_50'), sfs = gOf('SUPER_FIRE');
  const q1c = bigRun.qvaCompare[0], q2c = bigRun.qvaCompare[1];
  const dxb50 = bigRun.dExcludeGroups.find(g => g.group === 'D_EXCLUDE_AND_BIG_50') || { n: 0, shareOfTarget: 0 };
  const sg10b50 = bigRun.shakeGroups.find(g => g.group === 'SHAKE_10_BIG_50') || { n: 0, shareOfBig50: 0 };
  const sf2 = bigRun.secondFireGroups.find(g => g.group === 'EARLY_20_THEN_50') || { n: 0 };

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>${esc(meta.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif; background: #0f172a; color: #cbd5e1; margin: 0; padding: 18px 22px 60px; max-width: 1500px; }
  h1 { color: #f1f5f9; font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: #94a3b8; font-size: 12px; margin-bottom: 16px; }
  h2 { color: #5eead4; font-size: 17px; margin: 24px 0 10px; border-left: 4px solid #14b8a6; padding-left: 10px; }
  h3 { color: #c4b5fd; font-size: 14px; margin: 14px 0 8px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 18px; margin-bottom: 14px; }
  .card-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
  .stat { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; }
  .stat .lbl { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
  .stat .val { color: #f1f5f9; font-size: 22px; font-weight: 700; margin-top: 4px; line-height: 1.1; }
  .stat .sub { color: #94a3b8; font-size: 11px; margin-top: 2px; }
  table.t { width: 100%; border-collapse: collapse; background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; font-size: 12px; margin-bottom: 12px; }
  table.t th, table.t td { padding: 7px 9px; text-align: left; border-bottom: 1px solid #334155; color: #cbd5e1; vertical-align: top; }
  table.t th { background: #0f172a; color: #5eead4; font-weight: 600; font-size: 11px; }
  table.t td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.t td.pos { color: #86efac; font-weight: 600; }
  table.t td.mid { color: #fbbf24; font-weight: 600; }
  table.t td.neg { color: #fca5a5; }
  table.t td.neu { color: #cbd5e1; }
  .code { color: #64748b; font-size: 10.5px; font-family: ui-monospace, monospace; }
  .pill { display: inline-block; padding: 1.5px 7px; border-radius: 999px; font-size: .7rem; font-weight: 600; margin: 0 2px; }
  .p-q1   { background: #052e16; color: #86efac; border: 1px solid #166534; }
  .p-q2   { background: #1e1b4b; color: #c4b5fd; border: 1px solid #4338ca; }
  .p-good { background: #064e3b; color: #a7f3d0; border: 1px solid #10b981; }
  .p-neu  { background: #0f172a; color: #64748b; border: 1px solid #334155; }
  .p-warn { background: #422006; color: #fcd34d; border: 1px solid #b45309; }
  .conclusion { background: rgba(94,234,212,0.12); border-left: 4px solid #14b8a6; padding: 10px 14px; border-radius: 6px; color: #99f6e4; line-height: 1.7; margin: 10px 0; }
  .empty { background: rgba(0,0,0,0.3); border: 1px dashed #334155; padding: 14px; text-align: center; border-radius: 6px; color: #94a3b8; }
  details { background: rgba(0,0,0,0.2); border-radius: 8px; padding: 4px 8px; margin: 8px 0; }
  details summary { cursor: pointer; padding: 6px 10px; color: #5eead4; font-weight: 600; user-select: none; font-size: 12px; }
  .hint { color: #94a3b8; font-size: 11.5px; line-height: 1.6; margin-bottom: 8px; }
</style></head>
<body>
<h1>${esc(meta.title)}</h1>
<div class="subtitle">생성: ${esc(meta.generatedAt)} · 추적 기간 D+1~D+${meta.followDays}</div>

<h2>1. 요약</h2>
<div class="card">
  <div class="card-row">
    <div class="stat"><div class="lbl">전체 QVA 후보</div><div class="val">${summary.totalQvaSignals}</div><div class="sub">QVA1 ${summary.qva1Count} / QVA2 ${summary.qva2Count}</div></div>
    <div class="stat"><div class="lbl">추적 완료</div><div class="val">${summary.tracked}</div><div class="sub">skip ${summary.skipped}</div></div>
    <div class="stat"><div class="lbl">20일 내 1DS 발화</div><div class="val">${summary.allOneDsRate}%</div></div>
    <div class="stat"><div class="lbl">20일 내 +10% 도달</div><div class="val">${summary.allHit10Rate}%</div></div>
    <div class="stat"><div class="lbl">20일 내 +20% 도달</div><div class="val">${summary.allHit20Rate}%</div></div>
    <div class="stat"><div class="lbl">🔥 발화 임박 (검증)</div><div class="val">${summary.ignReadyN}</div><div class="sub">1DS ${summary.ignReadyOneDsRate}% / +10% ${summary.ignReadyHit10Rate}%</div></div>
  </div>
  <div class="conclusion">${esc(conclusion)}</div>
</div>

<div class="card" style="background:linear-gradient(180deg,#422006 0%,#1e293b 90%);border-color:#f59e0b;">
  <div style="font-size:13px;color:#fde68a;font-weight:600;margin-bottom:8px;">⚙ 운영 압축 후보 (이 보고서의 핵심 — 매수 추천 X, 관찰 순서 정렬)</div>
  <div class="card-row">
    <div class="stat"><div class="lbl">운영 압축 후보 (전 기간)</div><div class="val">${summary.operationalAllN}</div><div class="sub">A_READY + B_WATCH bestGrade</div></div>
    <div class="stat" style="background:#3a1a04;"><div class="lbl">🔥 A_READY (오늘 우선 확인)</div><div class="val" style="color:#fde68a;">${summary.aReadyN}</div></div>
    <div class="stat"><div class="lbl">⏳ B_WATCH (장중 관찰)</div><div class="val">${summary.bWatchN}</div></div>
    <div class="stat"><div class="lbl">압축 +10% 도달률</div><div class="val">${summary.operationalAllHit10Rate}%</div><div class="sub">vs 전체 ${summary.allHit10Rate}%</div></div>
    <div class="stat"><div class="lbl">압축 -10% 이탈률</div><div class="val">${summary.operationalAllBreach10Rate}%</div></div>
    <div class="stat"><div class="lbl">오늘 기준 운영 후보</div><div class="val">${summary.operationalCandidatesTodayCount}</div></div>
  </div>
  <div class="card-row" style="margin-top:8px;">
    <div class="stat" style="background:#450a0a;"><div class="lbl">📦 과열 제외 (+40% 초과)</div><div class="val" style="color:#fca5a5;">${summary.excludedTooExtended}</div></div>
    <div class="stat" style="background:#450a0a;"><div class="lbl">📦 -5% 이탈 제외</div><div class="val" style="color:#fca5a5;">${summary.excludedBreach5}</div></div>
  </div>
</div>

<h2>2. QVA 후보풀 그룹별 성과</h2>
<div class="hint">"한 번이라도 그 상태가 된 적 있는 신호" 기준으로 그룹화. n / 1DS 발화율 / 일별 급등률 / D+5/10/20 최고 상승률 / 이탈률.</div>
${groupsTable}

<h2>3. 발화 대기 점수 등급별 성과</h2>
<div class="hint">기준: isPriceAlive +25 / isNearQvaHigh +20 / isValueReIncreasing +20 / isLowRising +15 / D+1~10 +10 / QVA1+QVA2 중복 +10 — 80↑ 🔥 발화 임박, 65↑ ⏳ 우선 관찰, 50↑ 👀 준비 중, 그 외 📡 추적만.</div>
${groups.filter(g => ['IGNITION_READY','PRIORITY_WATCH','PREPARING','TRACK_ONLY'].includes(g.group))
  .map(g => '').length ? '' : ''}
<!-- 등급별은 이미 위 그룹표에 들어 있으므로 한 번 더 표시하지 않음 -->

<h2>4. QVA 이후 경과일별 성과 (첫 IGNITION_READY가 발생한 시점 기준)</h2>
<div class="hint">QVA 발생 후 며칠 안에 발화 대기 상태가 되었을 때 가장 성과가 좋은지 본다.</div>
${daysTable}

<h2>5. 대표 성공 사례 (1DS 발화 또는 +20% 도달)</h2>
${successCases.length === 0
  ? '<div class="empty">아직 성공 사례가 없습니다.</div>'
  : successTable}

<h2>6. 대표 실패 사례 (-10% 이상 이탈)</h2>
${failCases.length === 0
  ? '<div class="empty">아직 실패 사례가 없습니다.</div>'
  : failTable}

<h2>7. 오늘 기준 검증용 후보 (🔥 발화 임박 + ⏳ 우선 관찰)</h2>
<div class="hint">검증용 발화 대기 점수 등급 기준 — 후보가 많고, 이미 크게 오른 종목도 섞입니다. 운영용은 섹션 8 참고.</div>
${todayTable}

<h2>8. 운영용 압축 후보 (⚙ 핵심 — 매수 추천 X, 관찰 순서)</h2>
<div class="hint">
  검증용 IGNITION_READY 그룹은 후보가 너무 많고 이미 +20% 오른 종목도 발화 임박으로 잡힘. 운영 후보를 좁히는 추가 조건:<br>
  &nbsp;· <b>이미 발화한 종목 컷</b> — QVA 대비 +18% 초과 / +25% 초과 / QVA 이후 +20% 도달 / +40% 초과<br>
  &nbsp;· <b>이탈 컷</b> — QVA 종가 대비 -5% 이상 빠진 종목 제외<br>
  &nbsp;· <b>경과일 컷</b> — D+1~D+5만 (그 후는 발화 가능성 ↓)<br>
  &nbsp;· <b>QVA 고가 범위</b> — -7% ~ +5% (너무 멀거나 이미 넘었으면 제외)<br>
  · <b>거래대금 살아있어야</b><br>
  최대 20개 우선 표시, 나머지는 펼치기. 매수 추천이 아니라 "오늘/내일 우선 볼 종목"을 정하는 관찰 도구입니다.
</div>

<h3>8-1. 운영 등급별 성과 (bestOperationGrade 기준)</h3>
${opGroupsTable}

<h3>8-2. 오늘 운영 압축 후보 (🔥 A_READY + ⏳ B_WATCH)</h3>
${operationalTodayTable}

<h2>9. 대상승(BIG-RUN) 검증 요약 — "크게 간 종목의 특징" 검증</h2>
<div class="hint">
  안전한 종목을 찾는 게 아니라 <b>QVA 이후 +20%, +30%, +50%, +100% 크게 간 종목</b>의 공통 특징을 본다.
  운영 보드는 만들지 않고 검증만 보강. 기존 안전 압축이 큰 종목을 얼마나 버렸는지도 확인.
</div>
<div class="card" style="background:linear-gradient(180deg,#1e1b4b 0%,#0f172a 90%);border-color:#a78bfa;">
  <div class="card-row">
    <div class="stat"><div class="lbl">BIG_20 (+20%↑)</div><div class="val" style="color:#c4b5fd;">${b20s.n}</div><div class="sub">${b20s.shareOfAll || 0}% · 평균 ${fmtPct(b20s.avgMaxUp)}</div></div>
    <div class="stat"><div class="lbl">BIG_30 (+30%↑)</div><div class="val" style="color:#c4b5fd;">${b30s.n}</div><div class="sub">${b30s.shareOfAll || 0}%</div></div>
    <div class="stat"><div class="lbl">BIG_50 (+50%↑)</div><div class="val" style="color:#fbbf24;">${b50s.n}</div><div class="sub">${b50s.shareOfAll || 0}% · 평균 ${fmtPct(b50s.avgMaxUp)}</div></div>
    <div class="stat"><div class="lbl">SUPER_FIRE (+100%↑)</div><div class="val" style="color:#fde68a;">${sfs.n}</div><div class="sub">${sfs.shareOfAll || 0}% · 평균 ${fmtPct(sfs.avgMaxUp)}</div></div>
    <div class="stat"><div class="lbl">QVA1 vs QVA2 BIG_50</div><div class="val">${q1c.big50Rate}% / ${q2c.big50Rate}%</div><div class="sub">n=${q1c.n} / ${q2c.n}</div></div>
    <div class="stat"><div class="lbl">QVA1/QVA2 SUPER_FIRE</div><div class="val">${q1c.superFireRate}% / ${q2c.superFireRate}%</div></div>
  </div>
  <div class="card-row" style="margin-top:8px;">
    <div class="stat" style="background:#3a1a04;"><div class="lbl">📦 안전 압축이 버린 BIG_50</div><div class="val" style="color:#fcd34d;">${dxb50.n}</div><div class="sub">BIG_50 중 ${dxb50.shareOfTarget || 0}%</div></div>
    <div class="stat" style="background:#3a1a04;"><div class="lbl">⚡ -10% 흔들고 BIG_50</div><div class="val" style="color:#fcd34d;">${sg10b50.n}</div><div class="sub">BIG_50 중 ${sg10b50.shareOfBig50 || 0}%</div></div>
    <div class="stat" style="background:#3a1a04;"><div class="lbl">🚀 2차 발화 (D+5 안 +20% → BIG_50)</div><div class="val" style="color:#fcd34d;">${sf2.n}</div></div>
  </div>
</div>

<h2>10. 대상승 그룹별 특징 비교</h2>
${bigGroupTable}

<h3>10-1. QVA1 vs QVA2 대상승 비교</h3>
${qvaCompareTable}

<h2>11. 흔들고 간 종목 분석 (-5/-10/-15% 이탈 후 BIG_20/30/50)</h2>
<div class="hint">"-5% 이상 흔들리면 무조건 제외"를 적용하면 얼마나 많은 큰 종목을 놓치는지 확인.</div>
${shakeTable}

<h2>12. 안전 압축이 놓친 대상승 종목 분석</h2>
<div class="hint">기존 운영 압축(D_EXCLUDE)에 들어간 종목 중 실제로 BIG_20~SUPER_FIRE 간 종목 수와 제외 사유 분포.</div>
${dExcludeTable}

<h2>13. 초기 전조 조건별 대상승률 (D+1~D+5 안)</h2>
<div class="hint">QVA 후 5일 안에 어떤 전조가 있어야 BIG_50/SUPER_FIRE까지 가는지 — 단일 조건 + 조합.</div>
${earlyTable}

<h2>14. 첫 IGNITION/PRIORITY 발생 시점별 대상승률</h2>
${ignDayTable}

<h2>15. 2차 발화형 분석 (조기 +20% 후 더 큰 상승)</h2>
<div class="hint">"이미 +20% 오른 종목을 과열로 버리면 안 되는지" 검증. D+1~D+5 안에 +20% 도달 후 BIG_50/SUPER_FIRE까지 더 간 종목.</div>
${secondFireTable}

<h2>16. 대표 사례</h2>
<h3>16-1. BIG_50 대표 사례 (TOP 15)</h3>
${big50CasesHtml}
<h3>16-2. SUPER_FIRE 대표 사례 (TOP 15)</h3>
${superFireCasesHtml}
<h3>16-3. -10% 이상 흔들고 BIG_50 간 사례</h3>
${shakeBig50CasesHtml}
<h3>16-4. 안전 압축에서 제외됐지만 BIG_50 간 사례</h3>
${dExcludeBig50Html}
<h3>16-5. 2차 발화 (D+5 안 +20% → BIG_50/SUPER_FIRE)</h3>
${secondFireCasesHtml}

<h2>17. BIG-RUN 조건 조합 매트릭스 (15종)</h2>
<div class="hint">
  목표는 안전한 종목이 아니라 <b>+50%, +100% 이상 크게 간 종목을 더 잘 가르는 조건 조합</b>을 찾는 것. 운영 추천이 아닌 검증.<br>
  기준선(baseline) — 전체 ${bigRun.baselines.totalN}건 중 BIG_50 <b>${bigRun.baselines.big50Rate}%</b> / SUPER_FIRE <b>${bigRun.baselines.superFireRate}%</b>.
  <b>lift</b> = 조합 발화율 / 기준선 (1배면 무차별, 1.5배↑ = 의미 있음).<br>
  <b>표본 품질</b>: n≥300 신뢰가능 / 100~299 참고가능 / 30~99 표본작음 / &lt;30 해석주의.
</div>
${comboMatrixTable}

<h2>18. BIG_50 포착 우수 조합 Top 15</h2>
<div class="hint">기준선 ${bigRun.baselines.big50Rate}% 대비 어느 조건이 +50%↑ 종목을 가장 잘 잡는지. n이 작은 조합은 우연일 수 있음 (표본 품질 확인).</div>

<h3>18-1. BIG_50% 기준 (단순 발화율)</h3>
${comboTopBig50Table}

<h3>18-2. BIG_50 lift 상위 (n≥100 신뢰 가능 조합 한정)</h3>
<div class="hint">표본 100건 이상 중 기준선 대비 lift가 가장 큰 조합 — 표본 + 차별성 균형.</div>
${comboTopLiftTable}

<h3>18-3. BIG_50 포착 효율 (n × rate / 100)</h3>
<div class="hint">"실제로 몇 건의 BIG_50을 포함하면서 빈도가 얼마나 높은가" — 운영에서 활용 가능한 양 + 질의 균형.</div>
${comboTopEfficiencyTable}

<h2>19. SUPER_FIRE 포착 우수 조합 Top 15 (SUPER_FIRE% 기준)</h2>
<div class="hint">기준선 ${bigRun.baselines.superFireRate}% 대비 어느 조건이 +100%↑ 종목을 가장 잘 잡는지.</div>
${comboTopSuperFireTable}

<h2>20. 안전 필터가 놓친 BIG_50 정밀 분석</h2>
<div class="hint">기존 운영 압축(D_EXCLUDE)에 들어간 종목 중 실제 BIG_50까지 간 케이스의 공통 신호. 어떤 초기 전조가 있었는데 안전 필터에서 빠졌는지.</div>
${refinedDExcludeCard}

<h2>21. 흔들고 간 BIG_50 정밀 분석</h2>
<div class="hint">-10% 이상 흔들고도 BIG_50까지 간 종목 — "흔들리는 동안 살아있다"는 신호가 있었는지.</div>
${refinedShakeCard}

<h2>22. 2차 발화형 정밀 분석</h2>
<div class="hint">D+5 안에 +20% 1차 발화 후 BIG_50까지 더 간 종목 — 1차→최종 평균 gap, 중간 흔들림 정도, SUPER_FIRE 진행률.</div>
${refinedSecondCard}

<footer style="margin-top: 24px; padding: 12px; background: #1e293b; border-radius: 6px; color: #64748b; font-size: 11.5px; text-align: center;">
  검증 보고서 — 기존 운영 보드/신호 계산은 변경하지 않습니다. 성과가 좋으면 이후 qva-ignite-watch-board.js로 분리 예정.
</footer>
</body></html>`;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
