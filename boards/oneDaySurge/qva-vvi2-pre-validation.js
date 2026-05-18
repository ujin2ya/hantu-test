#!/usr/bin/env node
/**
 * QVA → VVI2 장중 예비 발화(VVI2_PRE) 일봉 근사 검증
 *
 * 목적:
 *   QVA1/QVA2 발생 이후 어떤 날 장중에 QVA 고가를 돌파하고 거래량/거래대금이
 *   QVA 기준에 근접/초과한 경우 → 그날 종가 기준 VVI2 확정으로 이어졌는지,
 *   이후 +10/+20/+30/+50% 상승으로 이어졌는지 검증한다.
 *
 *   분봉이 없으므로 일봉으로 "장중 발생 가능성"을 근사한다.
 *   결과가 좋으면 다음 단계에서 KIS 분봉(09:10/09:30/10:00/10:30/11:00 기준)으로 실시간 감지 검증.
 *
 * 중요:
 *   - 새 운영 보드 / 라우터 / cron / 실시간 알림 만들지 않는다.
 *   - 기존 QVA1/QVA2/VVI2 로직은 변경하지 않는다.
 *   - 기존 qva-to-1ds-candidate-pool-validation.js는 건드리지 않는다.
 *   - 이번은 일봉 기반 1차 검증.
 *
 * 입력:
 *   - DB board_signals (QVA1=QVA_WATCHLIST.QVA_NEW / QVA2=QVA2_WATCHLIST.QVA2_NEW)
 *   - cache/stock-charts-long/{code}.json (일봉 OHLC + valueApprox + volume)
 *
 * 출력:
 *   - reports/qva-vvi2-pre-validation-result.json
 *   - reports/qva-vvi2-pre-validation-result.html
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { query, closePool, isEnabled } = require(path.join(ROOT, 'src', 'db', 'mysql'));
const { findVvi2AfterQva2 } = require(path.join(ROOT, 'boards', 'qva2', 'qva2-screener'));

const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const OUT_JSON  = path.join(ROOT, 'reports', 'qva-vvi2-pre-validation-result.json');
const OUT_HTML  = path.join(ROOT, 'reports', 'qva-vvi2-pre-validation-result.html');

const FOLLOW_DAYS = 20;

// PRE 그룹 등급 우선순위 — 높을수록 강함
const PRE_RANK = Object.freeze({
  PRE_A_STRONG:       6,
  PRE_B_EARLY:        5,
  PRE_C_INTRADAY_ONLY: 4,
  PRE_D_VALUE_ONLY:   3,
  BREAK_FAIL:         2,
  NO_PRE:             1,
});
const PRE_LABEL = Object.freeze({
  PRE_A_STRONG:       '🔥 PRE_A (장중 돌파 + 거래 강 + 종가 유지)',
  PRE_B_EARLY:        '⏳ PRE_B (조기 감지 — 근접 수준)',
  PRE_C_INTRADAY_ONLY:'⚠ PRE_C (장중 돌파 후 종가 실패)',
  PRE_D_VALUE_ONLY:   '💧 PRE_D (거래대금 선행, 고가 미돌파)',
  BREAK_FAIL:         '❌ BREAK_FAIL (장중 돌파 후 종가 크게 밀림)',
  NO_PRE:             '— NO_PRE',
});

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
function fmtRatio(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(2) + 'x';
}
function ymdToDate(ymd) {
  const s = String(ymd);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
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
function sampleQualityOf(n) {
  if (n >= 300) return '신뢰가능';
  if (n >= 100) return '참고가능';
  if (n >=  30) return '표본작음';
  return '해석주의';
}

// 한 날짜의 PRE 그룹 분류 (우선순위 첫 매치)
function classifyPre({ intradayBreakQvaHigh, valueNearQva, valueOverQva, volumeNearQva, volumeOverQva, closeHoldQvaHigh, closeNearQvaHigh }) {
  if (intradayBreakQvaHigh && valueOverQva && volumeOverQva && closeHoldQvaHigh) return 'PRE_A_STRONG';
  if (intradayBreakQvaHigh && valueNearQva && volumeNearQva && closeNearQvaHigh) return 'PRE_B_EARLY';
  if (intradayBreakQvaHigh && valueNearQva && volumeNearQva && !closeHoldQvaHigh) return 'PRE_C_INTRADAY_ONLY';
  if (!intradayBreakQvaHigh && valueOverQva && volumeOverQva) return 'PRE_D_VALUE_ONLY';
  if (intradayBreakQvaHigh && !closeNearQvaHigh) return 'BREAK_FAIL';
  return 'NO_PRE';
}

// ─── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  if (!isEnabled()) { console.error('❌ .env DB_* 미설정'); process.exit(1); }
  console.log('🔍 QVA → VVI2_PRE 일봉 근사 검증 시작');
  const t0 = Date.now();

  // 1. QVA1/QVA2 신호 로드
  const qvaRows = await query(`
    SELECT signal_date, board_name, signal_kind, stock_code, stock_name
    FROM board_signals
    WHERE (board_name = 'QVA_WATCHLIST'  AND signal_kind = 'QVA_NEW')
       OR (board_name = 'QVA2_WATCHLIST' AND signal_kind = 'QVA2_NEW')
    ORDER BY signal_date, stock_code
  `);
  const qva1n = qvaRows.filter(r => r.board_name === 'QVA_WATCHLIST').length;
  const qva2n = qvaRows.length - qva1n;
  console.log(`  QVA 신호 ${qvaRows.length}건 (QVA1 ${qva1n} / QVA2 ${qva2n})`);

  // 2. 각 QVA 신호별 추적
  const chartCache = new Map();
  function getChart(code) {
    if (chartCache.has(code)) return chartCache.get(code);
    const c = loadChart(code);
    chartCache.set(code, c);
    return c;
  }

  const signals = [];
  let skipped = 0, skipNoChart = 0, skipNoQvaRow = 0, skipInvalidQva = 0;

  for (const qva of qvaRows) {
    const code = qva.stock_code;
    const qvaType = qva.board_name === 'QVA_WATCHLIST' ? 'QVA1' : 'QVA2';
    const qvaDate = String(qva.signal_date).slice(0,10);
    const qvaDateYMD = qvaDate.replace(/-/g, '');
    const chart = getChart(code);
    if (!chart || !Array.isArray(chart.rows)) { skipped++; skipNoChart++; continue; }
    const rows = chart.rows;
    const qvaIdx = rows.findIndex(r => String(r.date) === qvaDateYMD);
    if (qvaIdx < 0) { skipped++; skipNoQvaRow++; continue; }
    const qvaRow = rows[qvaIdx];
    const qvaClose  = qvaRow.close;
    const qvaHigh   = qvaRow.high;
    const qvaVolume = qvaRow.volume || 0;
    const qvaValue  = qvaRow.valueApprox || (qvaRow.close * (qvaRow.volume || 0));
    if (!qvaClose || !qvaHigh || qvaVolume <= 0 || qvaValue <= 0) { skipped++; skipInvalidQva++; continue; }

    // ── 실제 VVI2 (absorption 정의 — 기존 findVvi2AfterQva2 그대로 사용) ──
    const vvi2Res = findVvi2AfterQva2(rows, qvaIdx, FOLLOW_DAYS, { qva2Type: 'absorption' });
    const isActualVvi2 = vvi2Res.vvi2Idx > 0;
    const actualVvi2Idx = isActualVvi2 ? vvi2Res.vvi2Idx : -1;
    const actualVvi2Date = isActualVvi2 ? ymdToDate(rows[actualVvi2Idx].date) : null;
    const daysToActualVvi2 = isActualVvi2 ? actualVvi2Idx - qvaIdx : null;

    // 누적 추적
    let minClose = qvaClose;
    let maxHigh  = qvaHigh;
    let firstReach10  = null, firstReach20  = null,
        firstReach30  = null, firstReach50  = null,
        firstReach100 = null;
    let firstQvaHighRebreakIdx = -1; // D+1~D+N 중 첫 high>=qvaHigh
    const daily = [];

    for (let d = 1; d <= FOLLOW_DAYS; d++) {
      const idx = qvaIdx + d;
      if (idx >= rows.length) break;
      const row = rows[idx];
      const dateFmt = ymdToDate(row.date);

      if (Number.isFinite(row.close)) minClose = Math.min(minClose, row.close);
      if (Number.isFinite(row.high))  maxHigh  = Math.max(maxHigh, row.high);

      const maxDropFromQvaClosePct = pct(minClose, qvaClose);
      const maxUpSoFar = pct(maxHigh, qvaClose);
      if (firstReach10  == null && maxUpSoFar != null && maxUpSoFar >= 10)  firstReach10  = d;
      if (firstReach20  == null && maxUpSoFar != null && maxUpSoFar >= 20)  firstReach20  = d;
      if (firstReach30  == null && maxUpSoFar != null && maxUpSoFar >= 30)  firstReach30  = d;
      if (firstReach50  == null && maxUpSoFar != null && maxUpSoFar >= 50)  firstReach50  = d;
      if (firstReach100 == null && maxUpSoFar != null && maxUpSoFar >= 100) firstReach100 = d;

      const dayHigh   = row.high;
      const dayLow    = row.low;
      const dayClose  = row.close;
      const dayOpen   = row.open;
      const dayVolume = row.volume || 0;
      const dayValue  = row.valueApprox || (dayClose * dayVolume);

      const intradayBreakQvaHigh = dayHigh >= qvaHigh;
      const intradayNearQvaHigh  = dayHigh >= qvaHigh * 0.985;
      const valueNearQva   = dayValue  >= qvaValue  * 0.7;
      const valueOverQva   = dayValue  >= qvaValue;
      const volumeNearQva  = dayVolume >= qvaVolume * 0.7;
      const volumeOverQva  = dayVolume >= qvaVolume;
      const closeHoldQvaHigh = dayClose >= qvaHigh;
      const closeNearQvaHigh = dayClose >= qvaHigh * 0.97;
      const closeFailAfterBreak    = intradayBreakQvaHigh && !closeHoldQvaHigh;
      const strongCloseAfterBreak  = intradayBreakQvaHigh && closeNearQvaHigh;

      const priceAlive5  = maxDropFromQvaClosePct != null && maxDropFromQvaClosePct >= -5;
      const priceAlive10 = maxDropFromQvaClosePct != null && maxDropFromQvaClosePct >= -10;

      if (firstQvaHighRebreakIdx < 0 && intradayBreakQvaHigh) firstQvaHighRebreakIdx = idx;

      const preGroup = classifyPre({
        intradayBreakQvaHigh, valueNearQva, valueOverQva, volumeNearQva, volumeOverQva,
        closeHoldQvaHigh, closeNearQvaHigh,
      });

      daily.push({
        daysFromQva: d,
        preDate: dateFmt,
        preGroup,
        dayOpen, dayHigh, dayLow, dayClose,
        dayVolume, dayValue,
        valueToQvaRatio:  qvaValue  > 0 ? Number((dayValue  / qvaValue).toFixed(3))  : null,
        volumeToQvaRatio: qvaVolume > 0 ? Number((dayVolume / qvaVolume).toFixed(3)) : null,
        closeToQvaHighPct: pct(dayClose, qvaHigh),
        highToQvaHighPct:  pct(dayHigh,  qvaHigh),
        maxDropFromQvaClosePct,
        priceAlive5, priceAlive10,
        intradayBreakQvaHigh, intradayNearQvaHigh,
        valueNearQva, valueOverQva, volumeNearQva, volumeOverQva,
        closeHoldQvaHigh, closeNearQvaHigh,
        closeFailAfterBreak, strongCloseAfterBreak,
      });
    }

    // 대표 이벤트 선택
    let firstPreEvent = null;
    let bestPreEvent = null;
    for (const day of daily) {
      if (day.preGroup === 'NO_PRE') continue;
      if (firstPreEvent == null) firstPreEvent = day;
      if (bestPreEvent == null || PRE_RANK[day.preGroup] > PRE_RANK[bestPreEvent.preGroup]) {
        bestPreEvent = day;
      }
    }
    const bestPreGroup = bestPreEvent ? bestPreEvent.preGroup : 'NO_PRE';

    // PRE 기준 이후 성과
    let preFollow = null;
    if (bestPreEvent) {
      const preIdx = qvaIdx + bestPreEvent.daysFromQva;
      const preClose = bestPreEvent.dayClose;
      let pMinClose = preClose, pMaxHigh = preClose;
      let d1Up = null, d3Up = null, d5Up = null, d10Up = null, d20Up = null;
      let hit10 = false, hit20 = false, hit30 = false, hit50 = false;
      let breach5 = false, breach10 = false;
      // 재돌파 (PRE_C/BREAK_FAIL 분석)
      let nextDayRebreak = false, d3Rebreak = false, d5Rebreak = false;
      for (let k = 1; k <= FOLLOW_DAYS; k++) {
        const j = preIdx + k;
        if (j >= rows.length) break;
        const r2 = rows[j];
        if (Number.isFinite(r2.close)) pMinClose = Math.min(pMinClose, r2.close);
        if (Number.isFinite(r2.high))  pMaxHigh  = Math.max(pMaxHigh,  r2.high);
        const upSoFar = pct(pMaxHigh, preClose);
        const dropSoFar = pct(pMinClose, preClose);
        if (k === 1)  d1Up  = upSoFar;
        if (k === 3)  d3Up  = upSoFar;
        if (k === 5)  d5Up  = upSoFar;
        if (k === 10) d10Up = upSoFar;
        if (k === 20) d20Up = upSoFar;
        if (upSoFar != null) {
          if (upSoFar >= 10) hit10 = true;
          if (upSoFar >= 20) hit20 = true;
          if (upSoFar >= 30) hit30 = true;
          if (upSoFar >= 50) hit50 = true;
        }
        if (dropSoFar != null) {
          if (dropSoFar <= -5)  breach5  = true;
          if (dropSoFar <= -10) breach10 = true;
        }
        if (r2.high >= qvaHigh) {
          if (k === 1) nextDayRebreak = true;
          if (k <= 3) d3Rebreak = true;
          if (k <= 5) d5Rebreak = true;
        }
      }
      preFollow = {
        d1MaxUpFromPreClose:  d1Up,
        d3MaxUpFromPreClose:  d3Up,
        d5MaxUpFromPreClose:  d5Up,
        d10MaxUpFromPreClose: d10Up,
        d20MaxUpFromPreClose: d20Up,
        hit10FromPre: hit10, hit20FromPre: hit20, hit30FromPre: hit30, hit50FromPre: hit50,
        maxDropAfterPrePct: pct(pMinClose, preClose),
        breach5AfterPre: breach5, breach10AfterPre: breach10,
        nextDayRebreakQvaHigh: nextDayRebreak,
        d3RebreakQvaHigh: d3Rebreak,
        d5RebreakQvaHigh: d5Rebreak,
      };
    }

    // VVI2 비교
    let sameDayVvi2Confirmed = false, preBeforeVvi2 = false, preLeadDays = null;
    if (bestPreEvent && isActualVvi2) {
      const preIdx = qvaIdx + bestPreEvent.daysFromQva;
      sameDayVvi2Confirmed = preIdx === actualVvi2Idx;
      preBeforeVvi2 = preIdx < actualVvi2Idx;
      preLeadDays = actualVvi2Idx - preIdx;
    }

    // QVA 기준 BIG 분류
    const maxUpsideFromQvaPct = pct(maxHigh, qvaClose);
    const maxDropFromQvaPct   = pct(minClose, qvaClose);
    const bigGroups = [];
    if (maxUpsideFromQvaPct != null) {
      if (maxUpsideFromQvaPct >= 20)  bigGroups.push('BIG_20');
      if (maxUpsideFromQvaPct >= 30)  bigGroups.push('BIG_30');
      if (maxUpsideFromQvaPct >= 50)  bigGroups.push('BIG_50');
      if (maxUpsideFromQvaPct >= 100) bigGroups.push('SUPER_FIRE');
      if (maxUpsideFromQvaPct < 20)   bigGroups.push('NON_BIG');
    }

    signals.push({
      code, name: qva.stock_name, qvaType, qvaDate,
      qvaClose, qvaHigh, qvaVolume, qvaValue,
      // VVI2
      isActualVvi2, actualVvi2Date, daysToActualVvi2,
      sameDayVvi2Confirmed, preBeforeVvi2, preLeadDays,
      // PRE
      firstPreEvent, bestPreEvent, bestPreGroup,
      preFollow,
      // QVA 기준 성과
      maxUpsideFromQvaPct, maxDropFromQvaPct,
      firstReach10FromQva: firstReach10,
      firstReach20FromQva: firstReach20,
      firstReach30FromQva: firstReach30,
      firstReach50FromQva: firstReach50,
      firstReach100FromQva: firstReach100,
      hit20FromQva: firstReach20 != null,
      hit30FromQva: firstReach30 != null,
      hit50FromQva: firstReach50 != null,
      superFireFromQva: firstReach100 != null,
      bigGroups,
      breach5FromQva:  maxDropFromQvaPct != null && maxDropFromQvaPct < -5,
      breach10FromQva: maxDropFromQvaPct != null && maxDropFromQvaPct < -10,
      // 모든 daily는 보고서 용량 최소화를 위해 저장 안 함
      // (대표 사례에서는 bestPreEvent / firstPreEvent만 사용)
      firstQvaHighRebreakDays: firstQvaHighRebreakIdx > 0 ? firstQvaHighRebreakIdx - qvaIdx : null,
    });
  }
  console.log(`  추적 ${signals.length}건 / skip ${skipped} (no chart ${skipNoChart} / no qva row ${skipNoQvaRow} / invalid qva ${skipInvalidQva})`);

  // ─── 3. 그룹별 집계 helper ───────────────────────────────────────────
  function makeGroup(label, items) {
    const n = items.length;
    if (n === 0) return { group: label, n: 0, sampleQuality: sampleQualityOf(0) };
    const withPre = items.filter(x => x.bestPreEvent);
    const withFollow = items.filter(x => x.preFollow);
    const vvi2Items = items.filter(x => x.isActualVvi2);
    const q1 = items.filter(x => x.qvaType === 'QVA1').length;
    const preBefore = items.filter(x => x.preBeforeVvi2).length;
    const sameDay   = items.filter(x => x.sameDayVvi2Confirmed).length;
    const leadDays  = items.filter(x => Number.isFinite(x.preLeadDays)).map(x => x.preLeadDays);
    const ratioVal  = withPre.map(x => x.bestPreEvent.valueToQvaRatio).filter(Number.isFinite);
    const ratioVol  = withPre.map(x => x.bestPreEvent.volumeToQvaRatio).filter(Number.isFinite);
    return {
      group: label,
      n,
      sampleQuality: sampleQualityOf(n),
      qva1Count: q1, qva2Count: n - q1,
      qva1Share: rate(q1, n), qva2Share: rate(n - q1, n),
      // 실제 VVI2 확정
      actualVvi2Rate:           rate(vvi2Items.length, n),
      sameDayVvi2ConfirmedRate: rate(sameDay, n),
      preBeforeVvi2Rate:        rate(preBefore, n),
      avgPreLeadDays: leadDays.length ? Number(avg(leadDays).toFixed(2)) : null,
      // PRE 후 성과 (preFollow가 있는 row만)
      hit10FromPreRate: rate(withFollow.filter(x => x.preFollow.hit10FromPre).length, withFollow.length || 1),
      hit20FromPreRate: rate(withFollow.filter(x => x.preFollow.hit20FromPre).length, withFollow.length || 1),
      hit30FromPreRate: rate(withFollow.filter(x => x.preFollow.hit30FromPre).length, withFollow.length || 1),
      hit50FromPreRate: rate(withFollow.filter(x => x.preFollow.hit50FromPre).length, withFollow.length || 1),
      avgD1FromPre:  Number((avg(withFollow.map(x => x.preFollow.d1MaxUpFromPreClose))  ?? 0).toFixed(2)),
      avgD3FromPre:  Number((avg(withFollow.map(x => x.preFollow.d3MaxUpFromPreClose))  ?? 0).toFixed(2)),
      avgD5FromPre:  Number((avg(withFollow.map(x => x.preFollow.d5MaxUpFromPreClose))  ?? 0).toFixed(2)),
      avgD10FromPre: Number((avg(withFollow.map(x => x.preFollow.d10MaxUpFromPreClose)) ?? 0).toFixed(2)),
      avgD20FromPre: Number((avg(withFollow.map(x => x.preFollow.d20MaxUpFromPreClose)) ?? 0).toFixed(2)),
      breach5AfterPreRate:  rate(withFollow.filter(x => x.preFollow.breach5AfterPre).length, withFollow.length || 1),
      breach10AfterPreRate: rate(withFollow.filter(x => x.preFollow.breach10AfterPre).length, withFollow.length || 1),
      // QVA 기준 성과
      big20Rate:     rate(items.filter(x => x.bigGroups.includes('BIG_20')).length, n),
      big30Rate:     rate(items.filter(x => x.bigGroups.includes('BIG_30')).length, n),
      big50Rate:     rate(items.filter(x => x.bigGroups.includes('BIG_50')).length, n),
      superFireRate: rate(items.filter(x => x.bigGroups.includes('SUPER_FIRE')).length, n),
      avgMaxUpFromQva: Number((avg(items.map(x => x.maxUpsideFromQvaPct)) ?? 0).toFixed(2)),
      // PRE 일 거래 비율
      avgValueToQvaRatio:  ratioVal.length ? Number(avg(ratioVal).toFixed(2)) : null,
      avgVolumeToQvaRatio: ratioVol.length ? Number(avg(ratioVol).toFixed(2)) : null,
      // 재돌파 (PRE_C/BREAK_FAIL 분석용)
      nextDayRebreakRate: rate(withFollow.filter(x => x.preFollow.nextDayRebreakQvaHigh).length, withFollow.length || 1),
      d3RebreakRate:      rate(withFollow.filter(x => x.preFollow.d3RebreakQvaHigh).length,      withFollow.length || 1),
      d5RebreakRate:      rate(withFollow.filter(x => x.preFollow.d5RebreakQvaHigh).length,      withFollow.length || 1),
    };
  }

  const allItems = signals;
  const byPre = {};
  for (const k of ['PRE_A_STRONG','PRE_B_EARLY','PRE_C_INTRADAY_ONLY','PRE_D_VALUE_ONLY','BREAK_FAIL','NO_PRE']) {
    byPre[k] = signals.filter(x => x.bestPreGroup === k);
  }

  // 4. 기본 PRE 그룹
  const baseGroups = [
    makeGroup('ALL_QVA',             allItems),
    makeGroup('PRE_A_STRONG',        byPre.PRE_A_STRONG),
    makeGroup('PRE_B_EARLY',         byPre.PRE_B_EARLY),
    makeGroup('PRE_C_INTRADAY_ONLY', byPre.PRE_C_INTRADAY_ONLY),
    makeGroup('PRE_D_VALUE_ONLY',    byPre.PRE_D_VALUE_ONLY),
    makeGroup('BREAK_FAIL',          byPre.BREAK_FAIL),
    makeGroup('NO_PRE',              byPre.NO_PRE),
  ];

  // 5. QVA 유형 × PRE
  const qvaTypeGroups = [
    makeGroup('QVA1_PRE_A',      signals.filter(x => x.qvaType === 'QVA1' && x.bestPreGroup === 'PRE_A_STRONG')),
    makeGroup('QVA2_PRE_A',      signals.filter(x => x.qvaType === 'QVA2' && x.bestPreGroup === 'PRE_A_STRONG')),
    makeGroup('QVA1_PRE_B',      signals.filter(x => x.qvaType === 'QVA1' && x.bestPreGroup === 'PRE_B_EARLY')),
    makeGroup('QVA2_PRE_B',      signals.filter(x => x.qvaType === 'QVA2' && x.bestPreGroup === 'PRE_B_EARLY')),
    makeGroup('QVA1_PRE_C',      signals.filter(x => x.qvaType === 'QVA1' && x.bestPreGroup === 'PRE_C_INTRADAY_ONLY')),
    makeGroup('QVA2_PRE_C',      signals.filter(x => x.qvaType === 'QVA2' && x.bestPreGroup === 'PRE_C_INTRADAY_ONLY')),
    makeGroup('QVA1_BREAK_FAIL', signals.filter(x => x.qvaType === 'QVA1' && x.bestPreGroup === 'BREAK_FAIL')),
    makeGroup('QVA2_BREAK_FAIL', signals.filter(x => x.qvaType === 'QVA2' && x.bestPreGroup === 'BREAK_FAIL')),
  ];

  // 6. 경과일 구간별 (bestPreEvent.daysFromQva 기준)
  function bucketize(d) {
    if (d == null) return 'NO_PRE';
    if (d === 1) return 'PRE_D1';
    if (d <= 3)  return 'PRE_D2_D3';
    if (d <= 5)  return 'PRE_D4_D5';
    if (d <= 10) return 'PRE_D6_D10';
    return 'PRE_D11_D20';
  }
  const dayGroupKeys = ['PRE_D1','PRE_D2_D3','PRE_D4_D5','PRE_D6_D10','PRE_D11_D20'];
  const dayGroups = dayGroupKeys.map(k =>
    makeGroup(k, signals.filter(x => x.bestPreEvent && bucketize(x.bestPreEvent.daysFromQva) === k)));

  // 7. VVI2 비교 그룹
  const vvi2CompareGroups = [
    makeGroup('PRE_CONFIRMED_SAME_DAY',   signals.filter(x => x.sameDayVvi2Confirmed)),
    makeGroup('PRE_BEFORE_VVI2',          signals.filter(x => x.preBeforeVvi2)),
    makeGroup('PRE_BUT_NO_VVI2',          signals.filter(x => x.bestPreEvent && !x.isActualVvi2)),
    makeGroup('ACTUAL_VVI2_WITHOUT_PRE',  signals.filter(x => x.isActualVvi2 && !x.bestPreEvent)),
  ];

  // 8. BIG-RUN 연결 그룹
  const bigRunGroups = [
    makeGroup('PRE_A_OR_B_AND_BIG50',
      signals.filter(x => (x.bestPreGroup === 'PRE_A_STRONG' || x.bestPreGroup === 'PRE_B_EARLY') && x.bigGroups.includes('BIG_50'))),
    makeGroup('PRE_C_AND_NEXT_REBREAK',
      signals.filter(x => x.bestPreGroup === 'PRE_C_INTRADAY_ONLY' && x.preFollow && x.preFollow.nextDayRebreakQvaHigh)),
    makeGroup('PRE_D_VALUE_ONLY_THEN_BREAK',
      signals.filter(x => x.bestPreGroup === 'PRE_D_VALUE_ONLY' && x.preFollow && x.preFollow.d5RebreakQvaHigh)),
    makeGroup('BREAK_FAIL_THEN_BIG20',
      signals.filter(x => x.bestPreGroup === 'BREAK_FAIL' && x.bigGroups.includes('BIG_20'))),
    makeGroup('QVA2_PRE_A_OR_B',
      signals.filter(x => x.qvaType === 'QVA2' && (x.bestPreGroup === 'PRE_A_STRONG' || x.bestPreGroup === 'PRE_B_EARLY'))),
    makeGroup('QVA2_PRE_A_OR_B_AND_BIG50',
      signals.filter(x => x.qvaType === 'QVA2'
        && (x.bestPreGroup === 'PRE_A_STRONG' || x.bestPreGroup === 'PRE_B_EARLY')
        && x.bigGroups.includes('BIG_50'))),
  ];

  // 9. 장중 돌파 후 종가 실패 분석 (PRE_C / BREAK_FAIL)
  function makeRebreakAnalysis(items) {
    const n = items.length;
    if (n === 0) return { n: 0 };
    const withFollow = items.filter(x => x.preFollow);
    const m = withFollow.length || 1;
    return {
      n,
      withFollowN: withFollow.length,
      nextDayRebreakRate: rate(withFollow.filter(x => x.preFollow.nextDayRebreakQvaHigh).length, m),
      d3RebreakRate:      rate(withFollow.filter(x => x.preFollow.d3RebreakQvaHigh).length, m),
      d5RebreakRate:      rate(withFollow.filter(x => x.preFollow.d5RebreakQvaHigh).length, m),
      d5Hit10Rate:        rate(withFollow.filter(x => x.preFollow.hit10FromPre).length, m),
      d10Hit20Rate:       rate(withFollow.filter(x => x.preFollow.hit20FromPre).length, m),
      d20Hit50Rate:       rate(withFollow.filter(x => x.preFollow.hit50FromPre).length, m),
      d5Breach5Rate:      rate(withFollow.filter(x => x.preFollow.breach5AfterPre).length, m),
      d10Breach10Rate:    rate(withFollow.filter(x => x.preFollow.breach10AfterPre).length, m),
      big20Rate: rate(items.filter(x => x.bigGroups.includes('BIG_20')).length, n),
      big50Rate: rate(items.filter(x => x.bigGroups.includes('BIG_50')).length, n),
    };
  }
  const rebreakAnalysis = {
    PRE_C_INTRADAY_ONLY: makeRebreakAnalysis(byPre.PRE_C_INTRADAY_ONLY),
    BREAK_FAIL:          makeRebreakAnalysis(byPre.BREAK_FAIL),
  };

  // 10. 거래대금 선행형 분석 (PRE_D_VALUE_ONLY)
  const valueOnlyAnalysis = (() => {
    const items = byPre.PRE_D_VALUE_ONLY;
    const n = items.length;
    if (n === 0) return { n: 0 };
    const withFollow = items.filter(x => x.preFollow);
    const m = withFollow.length || 1;
    return {
      n,
      withFollowN: withFollow.length,
      d1BreakRate: rate(withFollow.filter(x => x.preFollow.nextDayRebreakQvaHigh).length, m),
      d3BreakRate: rate(withFollow.filter(x => x.preFollow.d3RebreakQvaHigh).length, m),
      d5BreakRate: rate(withFollow.filter(x => x.preFollow.d5RebreakQvaHigh).length, m),
      actualVvi2Rate: rate(items.filter(x => x.isActualVvi2).length, n),
      big20Rate: rate(items.filter(x => x.bigGroups.includes('BIG_20')).length, n),
      big30Rate: rate(items.filter(x => x.bigGroups.includes('BIG_30')).length, n),
      big50Rate: rate(items.filter(x => x.bigGroups.includes('BIG_50')).length, n),
      superFireRate: rate(items.filter(x => x.bigGroups.includes('SUPER_FIRE')).length, n),
    };
  })();

  // 11. QVA2 특화 분석
  const qva2Items = signals.filter(x => x.qvaType === 'QVA2');
  const qva2Specific = {
    all:        makeGroup('QVA2_ALL',         qva2Items),
    preA:       makeGroup('QVA2_PRE_A',       qva2Items.filter(x => x.bestPreGroup === 'PRE_A_STRONG')),
    preB:       makeGroup('QVA2_PRE_B',       qva2Items.filter(x => x.bestPreGroup === 'PRE_B_EARLY')),
    preC:       makeGroup('QVA2_PRE_C',       qva2Items.filter(x => x.bestPreGroup === 'PRE_C_INTRADAY_ONLY')),
    preD:       makeGroup('QVA2_PRE_D',       qva2Items.filter(x => x.bestPreGroup === 'PRE_D_VALUE_ONLY')),
    breakFail:  makeGroup('QVA2_BREAK_FAIL',  qva2Items.filter(x => x.bestPreGroup === 'BREAK_FAIL')),
    noPre:      makeGroup('QVA2_NO_PRE',      qva2Items.filter(x => x.bestPreGroup === 'NO_PRE')),
  };

  // 12. 2차 발화형 분석
  const secondFireBase = signals.filter(x =>
    x.firstReach20FromQva != null && x.firstReach20FromQva <= 5 && x.bigGroups.includes('BIG_50'));
  const secondFirePre = secondFireBase.filter(x =>
    x.bestPreEvent && ['PRE_A_STRONG','PRE_B_EARLY','PRE_C_INTRADAY_ONLY','PRE_D_VALUE_ONLY'].includes(x.bestPreGroup));
  const secondFirePreAB = secondFireBase.filter(x =>
    x.bestPreEvent && (x.bestPreGroup === 'PRE_A_STRONG' || x.bestPreGroup === 'PRE_B_EARLY'));
  function makeSecondFireStat(items) {
    const n = items.length;
    if (n === 0) return { n: 0 };
    const preBeforePeak = items.filter(x =>
      x.bestPreEvent && x.firstReach50FromQva != null && x.bestPreEvent.daysFromQva < x.firstReach50FromQva);
    return {
      n,
      avgFirstReach20Days: Number((avg(items.map(x => x.firstReach20FromQva)) ?? 0).toFixed(1)),
      avgPreDays: Number((avg(items.filter(x => x.bestPreEvent).map(x => x.bestPreEvent.daysFromQva)) ?? 0).toFixed(1)),
      avgFirstReach50Days: Number((avg(items.filter(x => x.firstReach50FromQva != null).map(x => x.firstReach50FromQva)) ?? 0).toFixed(1)),
      preBeforePeakRate: rate(preBeforePeak.length, n),
      avgD20FromPre: items.filter(x => x.preFollow).length
        ? Number((avg(items.filter(x => x.preFollow).map(x => x.preFollow.d20MaxUpFromPreClose)) ?? 0).toFixed(2))
        : null,
    };
  }
  const secondFire = {
    base:   makeSecondFireStat(secondFireBase),
    pre:    makeSecondFireStat(secondFirePre),
    preAB:  makeSecondFireStat(secondFirePreAB),
  };

  // ─── 4. 대표 사례 ────────────────────────────────────────────────────
  function caseRow(x, interpret) {
    return {
      code: x.code, name: x.name, qvaType: x.qvaType, qvaDate: x.qvaDate,
      qvaHigh: x.qvaHigh,
      preDate: x.bestPreEvent ? x.bestPreEvent.preDate : null,
      preGroup: x.bestPreGroup,
      preDayHigh:  x.bestPreEvent ? x.bestPreEvent.dayHigh  : null,
      preDayClose: x.bestPreEvent ? x.bestPreEvent.dayClose : null,
      valueToQvaRatio:  x.bestPreEvent ? x.bestPreEvent.valueToQvaRatio  : null,
      volumeToQvaRatio: x.bestPreEvent ? x.bestPreEvent.volumeToQvaRatio : null,
      isActualVvi2: x.isActualVvi2,
      actualVvi2Date: x.actualVvi2Date,
      preLeadDays: x.preLeadDays,
      d5UpFromPre:  x.preFollow ? x.preFollow.d5MaxUpFromPreClose  : null,
      d20UpFromPre: x.preFollow ? x.preFollow.d20MaxUpFromPreClose : null,
      maxUpFromQva: x.maxUpsideFromQvaPct,
      maxDropFromQva: x.maxDropFromQvaPct,
      isBig50: x.bigGroups.includes('BIG_50'),
      isSuperFire: x.bigGroups.includes('SUPER_FIRE'),
      interpret,
    };
  }
  function interpretSuccess(x) {
    const parts = [];
    if (x.bestPreGroup === 'PRE_A_STRONG' && x.sameDayVvi2Confirmed) parts.push('장중 QVA 고가 돌파 후 종가 유지 → VVI2 당일 확정');
    else if (x.bestPreGroup === 'PRE_A_STRONG' && x.preBeforeVvi2)   parts.push(`PRE_A 후 ${x.preLeadDays}거래일 뒤 VVI2 확정`);
    else if (x.bestPreGroup === 'PRE_B_EARLY' && x.isActualVvi2)     parts.push('PRE_B 후 VVI2 확정');
    else if (x.bestPreGroup === 'PRE_D_VALUE_ONLY')                  parts.push(`거래대금이 먼저 붙고 D+${x.preFollow ? '재돌파' : '대기'}에 가격 돌파`);
    if (x.bigGroups.includes('SUPER_FIRE')) parts.push('SUPER_FIRE 진입');
    else if (x.bigGroups.includes('BIG_50')) parts.push('BIG_50 도달');
    if (parts.length === 0) parts.push('PRE 후 +20% 도달');
    return parts.join(' / ');
  }
  function interpretBig50(x) {
    const parts = [];
    parts.push(`${x.bestPreGroup} 후 ${fmtPct(x.maxUpsideFromQvaPct)} (QVA 기준)`);
    if (x.bigGroups.includes('SUPER_FIRE')) parts.push('SUPER_FIRE');
    if (x.qvaType === 'QVA2') parts.push('QVA2 출처');
    if (x.preBeforeVvi2 && x.preLeadDays > 0) parts.push(`PRE가 VVI2보다 ${x.preLeadDays}일 빨랐음`);
    return parts.join(' / ');
  }
  function interpretFail(x) {
    const parts = [];
    if (x.bestPreGroup === 'PRE_A_STRONG' && !x.isActualVvi2) parts.push('PRE_A였지만 VVI2 미확정 (다음날 후속 거래 약함 추정)');
    if (x.bestPreGroup === 'PRE_B_EARLY' && !x.isActualVvi2)   parts.push('PRE_B였지만 VVI2 미확정');
    if (x.preFollow && x.preFollow.breach10AfterPre)           parts.push('PRE 후 -10% 이탈');
    if (parts.length === 0) parts.push('PRE 후 회복 실패');
    return parts.join(' / ');
  }
  function interpretRebreak(x) {
    const parts = [];
    parts.push(`${x.bestPreGroup} 후`);
    if (x.preFollow && x.preFollow.nextDayRebreakQvaHigh) parts.push('다음날 QVA 고가 재돌파');
    else if (x.preFollow && x.preFollow.d3RebreakQvaHigh) parts.push('D+3 안 재돌파');
    else if (x.preFollow && x.preFollow.d5RebreakQvaHigh) parts.push('D+5 안 재돌파');
    if (x.bigGroups.includes('BIG_20')) parts.push('이후 BIG_20+');
    if (x.bigGroups.includes('BIG_50')) parts.push('BIG_50');
    return parts.join(' / ');
  }

  const successCases = signals
    .filter(x => x.bestPreEvent && (x.bestPreGroup === 'PRE_A_STRONG' || x.bestPreGroup === 'PRE_B_EARLY')
              && x.isActualVvi2 && x.bigGroups.includes('BIG_20'))
    .slice().sort((a,b) => (b.maxUpsideFromQvaPct||0) - (a.maxUpsideFromQvaPct||0))
    .slice(0, 15).map(x => caseRow(x, interpretSuccess(x)));

  const big50Cases = signals
    .filter(x => x.bestPreEvent && x.bigGroups.includes('BIG_50'))
    .slice().sort((a,b) => (b.maxUpsideFromQvaPct||0) - (a.maxUpsideFromQvaPct||0))
    .slice(0, 15).map(x => caseRow(x, interpretBig50(x)));

  const failCases = signals
    .filter(x => (x.bestPreGroup === 'PRE_A_STRONG' || x.bestPreGroup === 'PRE_B_EARLY')
              && (!x.isActualVvi2 || (x.preFollow && x.preFollow.breach10AfterPre)))
    .slice().sort((a,b) => (a.maxDropFromQvaPct||0) - (b.maxDropFromQvaPct||0))
    .slice(0, 15).map(x => caseRow(x, interpretFail(x)));

  const rebreakCases = signals
    .filter(x => (x.bestPreGroup === 'PRE_C_INTRADAY_ONLY' || x.bestPreGroup === 'BREAK_FAIL')
              && x.preFollow && (x.preFollow.nextDayRebreakQvaHigh || x.preFollow.d3RebreakQvaHigh))
    .slice().sort((a,b) => (b.maxUpsideFromQvaPct||0) - (a.maxUpsideFromQvaPct||0))
    .slice(0, 15).map(x => caseRow(x, interpretRebreak(x)));

  // ─── 5. 요약 + 자동 결론 ─────────────────────────────────────────────
  const preA = baseGroups.find(g => g.group === 'PRE_A_STRONG');
  const preB = baseGroups.find(g => g.group === 'PRE_B_EARLY');
  const preC = baseGroups.find(g => g.group === 'PRE_C_INTRADAY_ONLY');
  const preD = baseGroups.find(g => g.group === 'PRE_D_VALUE_ONLY');
  const bf   = baseGroups.find(g => g.group === 'BREAK_FAIL');
  const np   = baseGroups.find(g => g.group === 'NO_PRE');
  const all  = baseGroups.find(g => g.group === 'ALL_QVA');

  // 최고 그룹 (실제 VVI2 확정률 / BIG_50 비율) — n>=30 한정
  const elig = baseGroups.filter(g => g.n >= 30 && g.group !== 'ALL_QVA');
  const bestByVvi2 = elig.slice().sort((a,b) => b.actualVvi2Rate - a.actualVvi2Rate)[0];
  const bestByBig50 = elig.slice().sort((a,b) => b.big50Rate     - a.big50Rate)[0];

  const conclusions = [];
  if (preA && preA.n >= 30 && preA.actualVvi2Rate >= 60) {
    conclusions.push('PRE_A는 실제 VVI2 확정률이 높아 장중 강한 예비 발화로 볼 수 있음');
  }
  if (preB && preB.n >= 30 && preB.actualVvi2Rate < (preA?.actualVvi2Rate ?? 0)) {
    conclusions.push('PRE_B는 조기 감지에는 유리하지만 종가 확인 필요');
  }
  if (preC && preC.n >= 30 && rebreakAnalysis.PRE_C_INTRADAY_ONLY.nextDayRebreakRate >= 30) {
    conclusions.push('PRE_C는 실패가 아니라 다음날 재돌파 후보로 별도 확인할 가치 있음');
  }
  if (preD && preD.n >= 30) {
    conclusions.push('PRE_D는 가격보다 거래대금이 먼저 붙는 선행형');
  }
  if (qva2Specific.preA && qva2Specific.preA.n >= 30 && qva2Specific.preA.big50Rate >= (qva2Specific.all.big50Rate || 0)) {
    conclusions.push('QVA2_PRE는 변동성은 크지만 BIG_50 포착력이 높음');
  }
  if (bf && bf.n >= 30 && bf.big50Rate < 5) {
    conclusions.push('BREAK_FAIL은 BIG_50 가능성이 낮은 진성 실패 그룹');
  }

  const summary = {
    totalQvaSignals: qvaRows.length,
    tracked: signals.length,
    skipped, skipNoChart, skipNoQvaRow, skipInvalidQva,
    followDays: FOLLOW_DAYS,
    counts: {
      PRE_A: byPre.PRE_A_STRONG.length,
      PRE_B: byPre.PRE_B_EARLY.length,
      PRE_C: byPre.PRE_C_INTRADAY_ONLY.length,
      PRE_D: byPre.PRE_D_VALUE_ONLY.length,
      BREAK_FAIL: byPre.BREAK_FAIL.length,
      NO_PRE: byPre.NO_PRE.length,
    },
    actualVvi2N: signals.filter(x => x.isActualVvi2).length,
    actualVvi2Rate: rate(signals.filter(x => x.isActualVvi2).length, signals.length),
    bestByVvi2:  bestByVvi2  ? { group: bestByVvi2.group,  rate: bestByVvi2.actualVvi2Rate,  n: bestByVvi2.n }  : null,
    bestByBig50: bestByBig50 ? { group: bestByBig50.group, rate: bestByBig50.big50Rate,      n: bestByBig50.n } : null,
    qva2PreAOrB: {
      n: (qva2Specific.preA?.n || 0) + (qva2Specific.preB?.n || 0),
      big50Rate: (() => {
        const items = qva2Items.filter(x => x.bestPreGroup === 'PRE_A_STRONG' || x.bestPreGroup === 'PRE_B_EARLY');
        return rate(items.filter(x => x.bigGroups.includes('BIG_50')).length, items.length);
      })(),
    },
    conclusions,
  };

  // ─── 6. JSON 저장 + HTML 렌더 ────────────────────────────────────────
  const result = {
    meta: {
      title: 'QVA → VVI2 장중 예비 발화(VVI2_PRE) 일봉 근사 검증',
      generatedAt: new Date().toISOString(),
      followDays: FOLLOW_DAYS,
    },
    summary,
    baseGroups,
    qvaTypeGroups,
    dayGroups,
    vvi2CompareGroups,
    bigRunGroups,
    rebreakAnalysis,
    valueOnlyAnalysis,
    qva2Specific,
    secondFire,
    cases: { successCases, big50Cases, failCases, rebreakCases },
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  console.log(`✅ JSON: ${OUT_JSON}`);
  fs.writeFileSync(OUT_HTML, renderHtml(result));
  console.log(`✅ HTML: ${OUT_HTML}`);

  // ─── 7. 콘솔 출력 ────────────────────────────────────────────────────
  console.log();
  console.log('━'.repeat(80));
  console.log('=== QVA → VVI2_PRE 일봉 근사 검증 요약 ===');
  console.log(`전체 QVA 신호: ${qvaRows.length}건 / 추적 ${signals.length}건 / 실제 VVI2 ${summary.actualVvi2N}건 (${summary.actualVvi2Rate}%)`);
  console.log();
  console.log(`PRE_A_STRONG: n=${preA.n}, 실제 VVI2 ${preA.actualVvi2Rate}% (same-day ${preA.sameDayVvi2ConfirmedRate}%), BIG_50 ${preA.big50Rate}%`);
  console.log(`PRE_B_EARLY:  n=${preB.n}, 실제 VVI2 ${preB.actualVvi2Rate}%, BIG_50 ${preB.big50Rate}%`);
  console.log(`PRE_C_INTRADAY_ONLY: n=${preC.n}, 다음날 재돌파 ${rebreakAnalysis.PRE_C_INTRADAY_ONLY.nextDayRebreakRate}%, D+20 +20% ${preC.hit20FromPreRate}%`);
  console.log(`PRE_D_VALUE_ONLY: n=${preD.n}, D+5 qvaHigh 돌파 ${valueOnlyAnalysis.d5BreakRate || 0}%, 이후 VVI2 ${valueOnlyAnalysis.actualVvi2Rate || 0}%`);
  console.log(`BREAK_FAIL:   n=${bf.n}, D+5 +10% ${bf.hit10FromPreRate}%, -10% 이탈 ${bf.breach10AfterPreRate}%, BIG_50 ${bf.big50Rate}%`);
  console.log();
  console.log(`QVA2_PRE_A: n=${qva2Specific.preA.n}, 실제 VVI2 ${qva2Specific.preA.actualVvi2Rate}%, BIG_50 ${qva2Specific.preA.big50Rate}%, SUPER ${qva2Specific.preA.superFireRate}%`);
  console.log(`QVA2_PRE_B: n=${qva2Specific.preB.n}, 실제 VVI2 ${qva2Specific.preB.actualVvi2Rate}%, BIG_50 ${qva2Specific.preB.big50Rate}%`);
  console.log();
  if (summary.bestByVvi2) console.log(`VVI2를 가장 잘 선행 감지한 PRE 그룹: ${summary.bestByVvi2.group} = ${summary.bestByVvi2.rate}% (n=${summary.bestByVvi2.n})`);
  if (summary.bestByBig50) console.log(`BIG_50을 가장 잘 포착한 PRE 그룹: ${summary.bestByBig50.group} = ${summary.bestByBig50.rate}% (n=${summary.bestByBig50.n})`);
  console.log();
  console.log('=== 2차 발화형 (D+5 +20% → BIG_50) 안에서 PRE 위치 ===');
  console.log(`기본:  n=${secondFire.base.n}, 1차 +20% 평균 ${secondFire.base.avgFirstReach20Days}d, 최종 +50% 평균 ${secondFire.base.avgFirstReach50Days}d`);
  console.log(`PRE:   n=${secondFire.pre.n}, PRE가 +50% 도달보다 먼저 나온 비율 ${secondFire.pre.preBeforePeakRate}%`);
  console.log(`PRE_A/B: n=${secondFire.preAB.n}, PRE_A/B가 먼저 ${secondFire.preAB.preBeforePeakRate}%`);
  console.log();
  console.log(`⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await closePool();
}

// ─── HTML 렌더 ───────────────────────────────────────────────────────────
function renderHtml(result) {
  const { meta, summary, baseGroups, qvaTypeGroups, dayGroups, vvi2CompareGroups,
          bigRunGroups, rebreakAnalysis, valueOnlyAnalysis, qva2Specific, secondFire, cases } = result;

  function groupRow(g) {
    const vcls = g.actualVvi2Rate >= 60 ? 'pos' : g.actualVvi2Rate >= 40 ? 'mid' : 'neu';
    const bcls = g.big50Rate     >= 20 ? 'pos' : g.big50Rate     >= 12 ? 'mid' : 'neu';
    return '<tr>' +
      `<td><b>${esc(PRE_LABEL[g.group] || g.group)}</b><div class="code">${esc(g.group)}</div></td>` +
      `<td class="num">${g.n}</td>` +
      `<td>${sampleQualityPill(g.sampleQuality || '해석주의')}</td>` +
      `<td class="num">${g.qva1Count||0}/${g.qva2Count||0}</td>` +
      `<td class="num ${vcls}">${g.actualVvi2Rate||0}%</td>` +
      `<td class="num">${g.sameDayVvi2ConfirmedRate||0}%</td>` +
      `<td class="num">${g.preBeforeVvi2Rate||0}%</td>` +
      `<td class="num">${g.avgPreLeadDays ?? '—'}</td>` +
      `<td class="num">${g.hit10FromPreRate||0}%</td>` +
      `<td class="num">${g.hit20FromPreRate||0}%</td>` +
      `<td class="num">${g.hit30FromPreRate||0}%</td>` +
      `<td class="num pos">${g.hit50FromPreRate||0}%</td>` +
      `<td class="num">${fmtPct(g.avgD1FromPre)}</td>` +
      `<td class="num">${fmtPct(g.avgD5FromPre)}</td>` +
      `<td class="num">${fmtPct(g.avgD20FromPre)}</td>` +
      `<td class="num neg">${g.breach5AfterPreRate||0}%</td>` +
      `<td class="num neg">${g.breach10AfterPreRate||0}%</td>` +
      `<td class="num">${g.big20Rate||0}%</td>` +
      `<td class="num ${bcls}">${g.big50Rate||0}%</td>` +
      `<td class="num">${g.superFireRate||0}%</td>` +
      `<td class="num">${fmtRatio(g.avgValueToQvaRatio)}</td>` +
      `<td class="num">${fmtRatio(g.avgVolumeToQvaRatio)}</td>` +
      '</tr>';
  }
  const groupTableHead = '<table class="t"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>표본</th><th>QVA1/QVA2</th>' +
    '<th>실제 VVI2</th><th>same-day</th><th>PRE&lt;VVI2</th><th>평균 lead</th>' +
    '<th>+10%</th><th>+20%</th><th>+30%</th><th>+50%</th>' +
    '<th>D+1 평균</th><th>D+5 평균</th><th>D+20 평균</th>' +
    '<th>-5%</th><th>-10%</th>' +
    '<th>BIG_20</th><th>BIG_50</th><th>SUPER</th>' +
    '<th>val 비율</th><th>vol 비율</th>' +
    '</tr></thead><tbody>';

  const baseTable    = groupTableHead + baseGroups.map(groupRow).join('') + '</tbody></table>';
  const qvaTypeTable = groupTableHead + qvaTypeGroups.map(groupRow).join('') + '</tbody></table>';
  const dayTable     = groupTableHead + dayGroups.map(groupRow).join('') + '</tbody></table>';
  const vvi2CmpTable = groupTableHead + vvi2CompareGroups.map(groupRow).join('') + '</tbody></table>';
  const bigRunTable  = groupTableHead + bigRunGroups.map(groupRow).join('') + '</tbody></table>';

  // 재돌파 분석 카드 (PRE_C / BREAK_FAIL)
  function rebreakCard(label, r) {
    if (!r || r.n === 0) return `<div class="empty">${esc(label)} 사례 없음</div>`;
    return `<div class="card">
      <h3 style="margin-top:0;">${esc(label)} — n=${r.n}</h3>
      <div class="card-row">
        <div class="stat"><div class="lbl">다음날 QVA 고가 재돌파</div><div class="val">${r.nextDayRebreakRate}%</div></div>
        <div class="stat"><div class="lbl">D+3 안 재돌파</div><div class="val">${r.d3RebreakRate}%</div></div>
        <div class="stat"><div class="lbl">D+5 안 재돌파</div><div class="val">${r.d5RebreakRate}%</div></div>
        <div class="stat"><div class="lbl">PRE 후 +10% 도달</div><div class="val">${r.d5Hit10Rate}%</div></div>
        <div class="stat"><div class="lbl">PRE 후 +20% 도달</div><div class="val">${r.d10Hit20Rate}%</div></div>
        <div class="stat"><div class="lbl">PRE 후 +50% 도달</div><div class="val pos">${r.d20Hit50Rate}%</div></div>
        <div class="stat" style="background:#450a0a;"><div class="lbl">-5% 이탈</div><div class="val" style="color:#fca5a5;">${r.d5Breach5Rate}%</div></div>
        <div class="stat" style="background:#450a0a;"><div class="lbl">-10% 이탈</div><div class="val" style="color:#fca5a5;">${r.d10Breach10Rate}%</div></div>
        <div class="stat"><div class="lbl">QVA BIG_20</div><div class="val">${r.big20Rate}%</div></div>
        <div class="stat"><div class="lbl">QVA BIG_50</div><div class="val">${r.big50Rate}%</div></div>
      </div>
    </div>`;
  }

  const valueOnlyCard = valueOnlyAnalysis.n === 0
    ? '<div class="empty">PRE_D_VALUE_ONLY 사례 없음</div>'
    : `<div class="card">
      <div class="card-row">
        <div class="stat"><div class="lbl">n</div><div class="val">${valueOnlyAnalysis.n}</div></div>
        <div class="stat"><div class="lbl">D+1 안 qvaHigh 돌파</div><div class="val">${valueOnlyAnalysis.d1BreakRate}%</div></div>
        <div class="stat"><div class="lbl">D+3 안 돌파</div><div class="val">${valueOnlyAnalysis.d3BreakRate}%</div></div>
        <div class="stat"><div class="lbl">D+5 안 돌파</div><div class="val pos">${valueOnlyAnalysis.d5BreakRate}%</div></div>
        <div class="stat"><div class="lbl">실제 VVI2 확정</div><div class="val">${valueOnlyAnalysis.actualVvi2Rate}%</div></div>
        <div class="stat"><div class="lbl">BIG_20</div><div class="val">${valueOnlyAnalysis.big20Rate}%</div></div>
        <div class="stat"><div class="lbl">BIG_30</div><div class="val">${valueOnlyAnalysis.big30Rate}%</div></div>
        <div class="stat"><div class="lbl">BIG_50</div><div class="val pos">${valueOnlyAnalysis.big50Rate}%</div></div>
        <div class="stat"><div class="lbl">SUPER_FIRE</div><div class="val">${valueOnlyAnalysis.superFireRate}%</div></div>
      </div>
    </div>`;

  const qva2Card = `<div class="card">
    <div class="card-row">
      ${[qva2Specific.all, qva2Specific.preA, qva2Specific.preB, qva2Specific.preC, qva2Specific.preD, qva2Specific.breakFail, qva2Specific.noPre].map(g => `
        <div class="stat">
          <div class="lbl">${esc(g.group)}</div>
          <div class="val">${g.n}</div>
          <div class="sub">VVI2 ${g.actualVvi2Rate}% · BIG_50 ${g.big50Rate}% · SUPER ${g.superFireRate}%</div>
        </div>`).join('')}
    </div>
  </div>`;

  const secondFireCard = `<div class="card">
    <div class="card-row">
      <div class="stat"><div class="lbl">기본 (D+5 +20% → BIG_50)</div><div class="val">${secondFire.base.n}</div>
        <div class="sub">1차 +20% 평균 ${secondFire.base.avgFirstReach20Days}일 · 최종 +50% 평균 ${secondFire.base.avgFirstReach50Days}일</div></div>
      <div class="stat"><div class="lbl">PRE_A/B/C/D 동반</div><div class="val">${secondFire.pre.n}</div>
        <div class="sub">PRE가 최종 +50% 도달보다 먼저 ${secondFire.pre.preBeforePeakRate}%</div></div>
      <div class="stat"><div class="lbl">PRE_A/B만</div><div class="val pos">${secondFire.preAB.n}</div>
        <div class="sub">PRE가 먼저 ${secondFire.preAB.preBeforePeakRate}%</div></div>
      <div class="stat"><div class="lbl">평균 PRE 발생일</div><div class="val">${secondFire.pre.avgPreDays ?? '—'}</div></div>
    </div>
  </div>`;

  // 대표 사례 표
  function caseTable(list, emptyMsg) {
    if (!list || list.length === 0) return `<div class="empty">${esc(emptyMsg)}</div>`;
    return '<table class="t"><thead><tr>' +
      '<th>종목</th><th>유형</th><th>QVA일</th><th>PRE일</th><th>PRE 그룹</th>' +
      '<th>QVA고가</th><th>PRE high</th><th>PRE close</th>' +
      '<th>val 비율</th><th>vol 비율</th>' +
      '<th>실제 VVI2</th><th>VVI2일</th><th>PRE lead</th>' +
      '<th>D+5 from PRE</th><th>D+20 from PRE</th>' +
      '<th>QVA 기준 maxUp</th><th>BIG_50</th>' +
      '<th>해석</th>' +
      '</tr></thead><tbody>' +
      list.map(c => '<tr>' +
        `<td><b>${esc(c.name)}</b><div class="code">${esc(c.code)}</div></td>` +
        `<td><span class="pill ${c.qvaType === 'QVA1' ? 'p-q1' : 'p-q2'}">${c.qvaType}</span></td>` +
        `<td>${esc(c.qvaDate)}</td>` +
        `<td>${esc(c.preDate || '—')}</td>` +
        `<td><span class="pill p-neu">${esc(c.preGroup)}</span></td>` +
        `<td class="num">${fmtInt(c.qvaHigh)}</td>` +
        `<td class="num">${fmtInt(c.preDayHigh)}</td>` +
        `<td class="num">${fmtInt(c.preDayClose)}</td>` +
        `<td class="num">${fmtRatio(c.valueToQvaRatio)}</td>` +
        `<td class="num">${fmtRatio(c.volumeToQvaRatio)}</td>` +
        `<td>${c.isActualVvi2 ? '<span class="pill p-good">확정</span>' : '<span class="pill p-neu">미확정</span>'}</td>` +
        `<td>${esc(c.actualVvi2Date || '—')}</td>` +
        `<td class="num">${c.preLeadDays ?? '—'}</td>` +
        `<td class="num">${fmtPct(c.d5UpFromPre)}</td>` +
        `<td class="num">${fmtPct(c.d20UpFromPre)}</td>` +
        `<td class="num pos">${fmtPct(c.maxUpFromQva)}</td>` +
        `<td>${c.isBig50 ? '<span class="pill p-good">BIG_50</span>' : '—'}${c.isSuperFire ? ' <span class="pill p-q2">SUPER</span>' : ''}</td>` +
        `<td style="font-size:11px;color:#cbd5e1;max-width:280px;">${esc(c.interpret || '')}</td>` +
        '</tr>').join('') + '</tbody></table>';
  }
  const successHtml = caseTable(cases.successCases, '성공 사례 없음');
  const big50Html   = caseTable(cases.big50Cases,   'BIG_50 사례 없음');
  const failHtml    = caseTable(cases.failCases,    '실패 사례 없음');
  const rebreakHtml = caseTable(cases.rebreakCases, '재돌파 사례 없음');

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>${esc(meta.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif; background: #0f172a; color: #cbd5e1; margin: 0; padding: 18px 22px 60px; max-width: 1700px; }
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
  .hint { color: #94a3b8; font-size: 11.5px; line-height: 1.6; margin-bottom: 8px; }
  .warn-note { background:#422006; border:1px solid #b45309; color:#fde68a; padding:10px 14px; border-radius:8px; font-size:12px; margin: 12px 0; line-height: 1.6; }
</style></head>
<body>
<h1>${esc(meta.title)}</h1>
<div class="subtitle">생성: ${esc(meta.generatedAt)} · 추적 기간 D+1~D+${meta.followDays} · 일봉 기반 근사 검증</div>

<div class="warn-note">
  ⚠ <b>일봉 기반 근사 검증입니다.</b> 실제 장중 감지에는 분봉(KIS API)이 필요합니다.
  이 보고서가 좋으면 다음 단계에서 09:10/09:30/10:00/10:30/11:00 기준 VVI2_PRE 실시간 감지 가능성을 검증합니다.
  새 운영 보드/라우터/cron/실시간 알림은 만들지 않았습니다.
</div>

<h2>1. 요약</h2>
<div class="card">
  <div class="card-row">
    <div class="stat"><div class="lbl">전체 QVA</div><div class="val">${summary.totalQvaSignals}</div><div class="sub">추적 ${summary.tracked}, skip ${summary.skipped}</div></div>
    <div class="stat"><div class="lbl">🔥 PRE_A</div><div class="val">${summary.counts.PRE_A}</div></div>
    <div class="stat"><div class="lbl">⏳ PRE_B</div><div class="val">${summary.counts.PRE_B}</div></div>
    <div class="stat"><div class="lbl">⚠ PRE_C</div><div class="val">${summary.counts.PRE_C}</div></div>
    <div class="stat"><div class="lbl">💧 PRE_D</div><div class="val">${summary.counts.PRE_D}</div></div>
    <div class="stat"><div class="lbl">❌ BREAK_FAIL</div><div class="val">${summary.counts.BREAK_FAIL}</div></div>
    <div class="stat"><div class="lbl">실제 VVI2</div><div class="val pos">${summary.actualVvi2N}</div><div class="sub">${summary.actualVvi2Rate}%</div></div>
    ${summary.bestByVvi2 ? `<div class="stat"><div class="lbl">VVI2 확정률 1위</div><div class="val">${esc(summary.bestByVvi2.group)}</div><div class="sub">${summary.bestByVvi2.rate}% (n=${summary.bestByVvi2.n})</div></div>` : ''}
    ${summary.bestByBig50 ? `<div class="stat"><div class="lbl">BIG_50 비율 1위</div><div class="val">${esc(summary.bestByBig50.group)}</div><div class="sub">${summary.bestByBig50.rate}% (n=${summary.bestByBig50.n})</div></div>` : ''}
    <div class="stat"><div class="lbl">QVA2 PRE_A/B</div><div class="val">${summary.qva2PreAOrB.n}</div><div class="sub">BIG_50 ${summary.qva2PreAOrB.big50Rate}%</div></div>
  </div>
  ${summary.conclusions.length ? `<div class="conclusion">${summary.conclusions.map(c => '• ' + esc(c)).join('<br>')}</div>` : ''}
</div>

<h2>2. VVI2_PRE 그룹별 성과</h2>
<div class="hint">
  PRE_A_STRONG: 장중 QVA 고가 돌파 + 거래량/거래대금 모두 QVA 이상 + 종가도 QVA 고가 위 유지 (가장 강함).
  PRE_B_EARLY: 장중 돌파 + 거래 근접(0.7x↑) + 종가 근접(qvaHigh × 0.97 이상).
  PRE_C: 장중 돌파 + 거래 근접했지만 종가 실패. PRE_D: 거래만 강하고 가격 돌파 X.
  BREAK_FAIL: 장중 돌파 후 종가 크게 밀림 (qvaHigh × 0.97 미달).
</div>
${baseTable}

<h2>3. 실제 VVI2 확정률 비교</h2>
<div class="hint">PRE 발생일이 곧 VVI2 확정일(same-day) / VVI2보다 먼저 / PRE 있었지만 VVI2 미확정 / VVI2 있었지만 PRE 미감지.</div>
${vvi2CmpTable}

<h2>4. QVA1/QVA2별 PRE 성과 비교</h2>
<div class="hint">QVA2(흡수형)와 QVA1(원조) 각각 PRE 그룹별 성능 비교 — QVA2가 변동성 큰 종목을 더 잘 잡는지 확인.</div>
${qvaTypeTable}

<h2>5. 장중 돌파 후 종가 실패 분석 (PRE_C / BREAK_FAIL)</h2>
<div class="hint">"실패"가 아닐 수 있음. 다음날/D+3/D+5 안에 재돌파하는지, 이후 BIG_20/BIG_50까지 가는지 검증.</div>
${rebreakCard('PRE_C_INTRADAY_ONLY (장중 돌파했지만 종가 실패)', rebreakAnalysis.PRE_C_INTRADAY_ONLY)}
${rebreakCard('BREAK_FAIL (종가가 qvaHigh × 0.97 미달)', rebreakAnalysis.BREAK_FAIL)}

<h2>6. 거래대금 선행형 분석 (PRE_D_VALUE_ONLY)</h2>
<div class="hint">가격은 아직 QVA 고가를 못 넘었지만 거래량/거래대금이 먼저 붙은 케이스 — 며칠 안에 가격 돌파로 이어지는가?</div>
${valueOnlyCard}

<h2>7. PRE 발생 경과일별 성과</h2>
<div class="hint">D+1 / D+2~3 / D+4~5 / D+6~10 / D+11~20 — 빠른 PRE가 좋은지, 늦은 D+6~10에서도 잡히는지 검증.</div>
${dayTable}

<h2>8. BIG-RUN 연결 분석</h2>
<div class="hint">기존 QVA→1DS 검증에서 강했던 구조(거래대금 재증가 + 고가 돌파 + 저점 상승)가 VVI2_PRE에서도 유효한가?</div>
${bigRunTable}

<h3>8-1. 2차 발화형과 PRE의 관계</h3>
<div class="hint">"D+5 안 +20% 도달 → BIG_50까지 더 간 종목" 중 PRE_A/B가 +50% 도달보다 먼저 나왔는지 — PRE가 2차 발화 진입 타이밍을 사전 신호로 줄 수 있는지.</div>
${secondFireCard}

<h2>9. QVA2 특화 분석</h2>
<div class="hint">QVA2는 BIG-RUN 검증에서 BIG_50 14% / SUPER_FIRE 6%로 QVA1(9.8% / 2.3%)보다 강한 결과. PRE에서도 같은 경향이 보이는지.</div>
${qva2Card}

<h2>10. 대표 성공 사례 — PRE_A/PRE_B 후 실제 VVI2 확정 + BIG_20 이상</h2>
${successHtml}

<h2>11. 대표 BIG_50 사례 — PRE 후 BIG_50 도달</h2>
${big50Html}

<h2>12. 대표 실패 사례 — PRE_A/PRE_B였지만 VVI2 미확정 또는 -10% 이탈</h2>
${failHtml}

<h2>13. 장중 돌파 실패 후 재돌파 사례 — PRE_C/BREAK_FAIL 후 재돌파</h2>
${rebreakHtml}

<footer style="margin-top: 24px; padding: 12px; background: #1e293b; border-radius: 6px; color: #64748b; font-size: 11.5px; text-align: center;">
  일봉 근사 검증 — 분봉 검증은 다음 단계. 기존 보드/신호/cron 변경 없음.
</footer>
</body></html>`;
}

function sampleQualityPill(q) {
  const map = { '신뢰가능': 'p-good', '참고가능': 'p-q2', '표본작음': 'p-neu', '해석주의': 'p-warn' };
  return `<span class="pill ${map[q] || 'p-neu'}">${esc(q)}</span>`;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
