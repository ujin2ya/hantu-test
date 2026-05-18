#!/usr/bin/env node
/**
 * 1DS 후보 × 나스닥 테마 흐름 매칭 검증
 *
 * 목표:
 *   1DS 후보 중 전일 나스닥에서 강했던 테마와 매칭되는 종목이 비매칭 1DS 대비
 *   당일/후속 성과가 더 좋은지. QVA1/QVA2 선행 이력과 나스닥 테마가 겹칠 때 시너지가 있는지.
 *
 * 중요:
 *   - 새 운영 보드/라우터/cron 추가 X.
 *   - 자동매수 신호 X — 1DS 후보 우선순위 정렬 기준 검증.
 *   - 수동 매핑 JSON 기반. 실시간 뉴스/LLM 분류 X.
 *   - 기존 1DS/QVA1/QVA2/VVI2 본체 로직 변경 X.
 *
 * 입력:
 *   - DB board_signals (ONE_DAY_SURGE / QVA_WATCHLIST.QVA_NEW / QVA2_WATCHLIST.QVA2_NEW)
 *   - cache/stock-charts-long/{code}.json (일봉)
 *   - data/theme/nasdaq-theme-map.json
 *   - data/theme/nasdaq-theme-daily.json
 *
 * 출력:
 *   - reports/one-day-surge-nasdaq-theme-validation-result.json
 *   - reports/one-day-surge-nasdaq-theme-validation-result.html
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { query, closePool, isEnabled } = require(path.join(ROOT, 'src', 'db', 'mysql'));
const { findVvi2AfterQva2 } = require(path.join(ROOT, 'boards', 'qva2', 'qva2-screener'));

const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const THEME_MAP_PATH = path.join(ROOT, 'data', 'theme', 'nasdaq-theme-map.json');
const THEME_DAILY_PATH = path.join(ROOT, 'data', 'theme', 'nasdaq-theme-daily.json');
const OUT_JSON = path.join(ROOT, 'reports', 'one-day-surge-nasdaq-theme-validation-result.json');
const OUT_HTML = path.join(ROOT, 'reports', 'one-day-surge-nasdaq-theme-validation-result.html');

const FOLLOW_DAYS = 20;
const QVA_LEAD_LOOKBACK_TRADING_DAYS = 20;

// ─── 유틸 ────────────────────────────────────────────────────────────────
function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}
function pct(num, denom) {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return null;
  return Number(((num / denom - 1) * 100).toFixed(2));
}
function fmtPct(v, p = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + Number(v).toFixed(p) + '%';
}
function avg(arr) {
  const xs = arr.filter(v => Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}
function rate(num, denom) { return denom > 0 ? Number((num / denom * 100).toFixed(1)) : 0; }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sampleQualityOf(n) {
  if (n >= 300) return '신뢰가능';
  if (n >= 100) return '참고가능';
  if (n >=  30) return '표본작음';
  return '해석주의';
}
function sampleQualityPill(q) {
  const map = { '신뢰가능': 'p-good', '참고가능': 'p-q2', '표본작음': 'p-neu', '해석주의': 'p-warn' };
  return `<span class="pill ${map[q] || 'p-neu'}">${esc(q)}</span>`;
}

function classifyThemeStrength(t) {
  if (!t) return 'NONE';
  const ratio = t.totalTickerCount > 0 ? t.strongTickerCount / t.totalTickerCount : 0;
  if (t.avgChangePct >= 2.5 || ratio >= 0.6) return 'STRONG';
  if (t.avgChangePct >= 1.0) return 'MID';
  return 'WEAK';
}

// 한국 거래일 → 전일 미국장 데이터. KR 휴일 무관 — daily.json에서 그 KR date 이전 가장 가까운 entry.
// (실제 운영에선 미국 거래일 캘린더로 정확 매칭하지만 수동 데이터는 단순화)
function findNasdaqThemeAt(dailyHistory, krDate) {
  const sorted = dailyHistory.slice().sort((a, b) => b.date.localeCompare(a.date));
  for (const e of sorted) {
    if (e.date < krDate) return e;       // 전일 또는 그 이전
    if (e.date === krDate) return e;     // 같은 날 데이터도 허용 (전일 밤 미국장 데이터를 KR signalDate 키로 저장한 경우)
  }
  return sorted[sorted.length - 1] || null;
}

function matchThemes(stockName, themesMap) {
  const matched = [];
  for (const key of Object.keys(themesMap)) {
    const t = themesMap[key];
    if (!t.krStocks) continue;
    if (t.krStocks.some(s => s === stockName)) {
      matched.push({ themeKey: key, label: t.label, matchType: 'directStockMatch' });
    }
  }
  return matched;
}

// ─── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  if (!isEnabled()) { console.error('❌ .env DB_* 미설정'); process.exit(1); }
  console.log('🔍 1DS × 나스닥 테마 흐름 매칭 검증');
  const t0 = Date.now();

  const themeMap   = JSON.parse(fs.readFileSync(THEME_MAP_PATH, 'utf-8')).themes;
  const themeDaily = JSON.parse(fs.readFileSync(THEME_DAILY_PATH, 'utf-8')).history;
  const themeKeys  = Object.keys(themeMap);
  console.log(`  테마 ${themeKeys.length}개 / 일일 강도 ${themeDaily.length}일치`);

  // DB 신호 한 번에 로드
  const onedsRows = await query(`
    SELECT signal_date, stock_code, stock_name, signal_kind, raw_json
    FROM board_signals
    WHERE board_name = 'ONE_DAY_SURGE'
    ORDER BY signal_date, stock_code
  `);
  const qvaRows = await query(`
    SELECT signal_date, stock_code, board_name, raw_json
    FROM board_signals
    WHERE (board_name = 'QVA_WATCHLIST'  AND signal_kind = 'QVA_NEW')
       OR (board_name = 'QVA2_WATCHLIST' AND signal_kind = 'QVA2_NEW')
  `);
  console.log(`  1DS 신호 ${onedsRows.length} / QVA 신호 ${qvaRows.length}`);

  // QVA를 종목별로 group + 오름차순 (in-memory lookup)
  const qvaByCode = new Map();
  for (const q of qvaRows) {
    const code = q.stock_code;
    if (!qvaByCode.has(code)) qvaByCode.set(code, []);
    let qvaScore = 0;
    try {
      const raw = q.raw_json ? (typeof q.raw_json === 'string' ? JSON.parse(q.raw_json) : q.raw_json) : null;
      qvaScore = raw?.bestEarlyQvaScore ?? raw?.score ?? 0;
    } catch (_) {}
    qvaByCode.get(code).push({
      date: String(q.signal_date).slice(0,10),
      type: q.board_name === 'QVA_WATCHLIST' ? 'QVA1' : 'QVA2',
      score: qvaScore,
    });
  }
  for (const arr of qvaByCode.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

  // 차트 cache
  const chartCache = new Map();
  function getChart(code) {
    if (chartCache.has(code)) return chartCache.get(code);
    const c = loadChart(code);
    chartCache.set(code, c);
    return c;
  }

  const signals = [];
  let skipped = 0;

  for (const oneds of onedsRows) {
    const code = oneds.stock_code;
    const name = oneds.stock_name;
    const signalDate = String(oneds.signal_date).slice(0,10);
    const signalDateYMD = signalDate.replace(/-/g, '');
    const signalKind = oneds.signal_kind;

    // 1DS score
    let oneDaySurgeScore = 0, sourceGroup = null, signalPrice = null;
    try {
      const raw = oneds.raw_json ? (typeof oneds.raw_json === 'string' ? JSON.parse(oneds.raw_json) : oneds.raw_json) : null;
      oneDaySurgeScore = raw?.score ?? raw?.totalScore ?? raw?.priorityScore ?? raw?.finalScore ?? 0;
      sourceGroup = raw?.group ?? raw?.tier ?? null;
      signalPrice = raw?.close ?? raw?.signalPrice ?? raw?.anchorPrice ?? null;
    } catch (_) {}

    const chart = getChart(code);
    if (!chart || !chart.rows) { skipped++; continue; }
    const rows = chart.rows;
    const sIdx = rows.findIndex(r => String(r.date) === signalDateYMD);
    if (sIdx < 0) { skipped++; continue; }
    const sRow = rows[sIdx];
    const sClose = sRow.close;
    if (!sClose) { skipped++; continue; }
    if (!Number.isFinite(signalPrice) || signalPrice <= 0) signalPrice = sClose;

    // D+0(signal day) high/close (signalPrice 기준 변화율)
    const signalDayHighFromSignalPrice = pct(sRow.high, signalPrice);
    const signalDayCloseFromSignalPrice = pct(sRow.close, signalPrice);

    // D+1~D+20 추적 (signalPrice 대비)
    let maxHigh = sRow.high ?? signalPrice;
    let minLow  = sRow.low ?? signalPrice;
    const dayCheckpoints = {1: null, 3: null, 5: null, 10: null, 20: null};
    const dayDownCheckpoints = {1: null, 3: null, 5: null, 10: null, 20: null};
    let cumH = signalPrice, cumL = signalPrice;
    for (let d = 1; d <= FOLLOW_DAYS; d++) {
      const idx = sIdx + d;
      if (idx >= rows.length) break;
      const row = rows[idx];
      if (Number.isFinite(row.high) && row.high > cumH) cumH = row.high;
      if (Number.isFinite(row.low)  && row.low  < cumL) cumL = row.low;
      if (Number.isFinite(row.high)) maxHigh = Math.max(maxHigh, row.high);
      if (Number.isFinite(row.low))  minLow  = Math.min(minLow, row.low);
      if (dayCheckpoints.hasOwnProperty(d)) { dayCheckpoints[d] = pct(cumH, signalPrice); dayDownCheckpoints[d] = pct(cumL, signalPrice); }
    }
    const maxUpFromSignal = pct(cumH, signalPrice);
    const maxDownFromSignal = pct(cumL, signalPrice);

    // hit/breach
    const upT = [3, 5, 10, 15, 20, 30, 50], dnT = [3, 5, 7, 10];
    const fHit = {}, fBreach = {};
    let rh = signalPrice, rl = signalPrice;
    for (let d = 1; d <= FOLLOW_DAYS; d++) {
      const idx = sIdx + d;
      if (idx >= rows.length) break;
      const row = rows[idx];
      if (Number.isFinite(row.high) && row.high > rh) rh = row.high;
      if (Number.isFinite(row.low)  && row.low  < rl) rl = row.low;
      const u = pct(rh, signalPrice), dPct = pct(rl, signalPrice);
      for (const t of upT) if (fHit[t]    == null && u    != null && u    >=  t) fHit[t]    = d;
      for (const t of dnT) if (fBreach[t] == null && dPct != null && dPct <= -t) fBreach[t] = d;
    }

    const bigGroups = [];
    if (maxUpFromSignal != null) {
      if (maxUpFromSignal >= 20)  bigGroups.push('BIG_20');
      if (maxUpFromSignal >= 30)  bigGroups.push('BIG_30');
      if (maxUpFromSignal >= 50)  bigGroups.push('BIG_50');
      if (maxUpFromSignal >= 100) bigGroups.push('SUPER_FIRE');
      if (maxUpFromSignal < 20)   bigGroups.push('NON_BIG');
    }

    // 일봉 PRE_A 근사 (1DS 이전 QVA에서 신호로 진행했는지 — 본 검증에선 1DS 후 PRE_A는 의미 약함 — skip)
    // 실제 VVI2 확정 — 1DS signalDate를 anchor로 보고 그 이후 absorption VVI2 발생 여부
    const vvi2Res = findVvi2AfterQva2(rows, sIdx, FOLLOW_DAYS, { qva2Type: 'absorption' });
    const isActualVvi2 = vvi2Res.vvi2Idx > 0;

    // ─── QVA 선행 이력 (signalDate 이전 20거래일) ─────────────────────────
    const qvaList = qvaByCode.get(code) || [];
    // signalDate 이전 + 그 사이 거래일 ≤ 20
    let hasQva1Lead = false, hasQva2Lead = false;
    let qvaLeadDate = null, qvaLeadDaysAgo = null, qvaLeadScore = 0;
    for (const q of qvaList) {
      if (q.date >= signalDate) continue;
      const qIdx = rows.findIndex(r => String(r.date) === q.date.replace(/-/g, ''));
      if (qIdx < 0) continue;
      const daysAgo = sIdx - qIdx;
      if (daysAgo < 0 || daysAgo > QVA_LEAD_LOOKBACK_TRADING_DAYS) continue;
      // 가장 최근 (signalDate에 가까운) QVA만 anchor로 사용
      if (q.type === 'QVA1') hasQva1Lead = true;
      if (q.type === 'QVA2') hasQva2Lead = true;
      if (qvaLeadDaysAgo == null || daysAgo < qvaLeadDaysAgo) {
        qvaLeadDate = q.date;
        qvaLeadDaysAgo = daysAgo;
        qvaLeadScore = q.score;
      }
    }
    const hasQvaLead = hasQva1Lead || hasQva2Lead;
    const qvaLeadType = hasQva1Lead && hasQva2Lead ? 'QVA1_QVA2' : hasQva1Lead ? 'QVA1' : hasQva2Lead ? 'QVA2' : 'NONE';
    // qvaLeadStillAlive — qvaLead 이후 signalDate 전까지 -10% 이상 무너지지 않았는지
    let qvaLeadStillAlive = null, qvaLeadStillAlive5 = null, qvaLeadMaxDropPct = null;
    if (qvaLeadDate) {
      const qIdx = sIdx - qvaLeadDaysAgo;
      const qClose = rows[qIdx].close;
      let qMinClose = qClose;
      for (let k = qIdx + 1; k <= sIdx; k++) {
        if (Number.isFinite(rows[k].close)) qMinClose = Math.min(qMinClose, rows[k].close);
      }
      qvaLeadMaxDropPct = pct(qMinClose, qClose);
      qvaLeadStillAlive  = qvaLeadMaxDropPct != null && qvaLeadMaxDropPct > -10;
      qvaLeadStillAlive5 = qvaLeadMaxDropPct != null && qvaLeadMaxDropPct > -5;
    }

    // ─── 테마 매칭 ───────────────────────────────────────────────────────
    const matched = matchThemes(name, themeMap);
    const nasdaqEntry = findNasdaqThemeAt(themeDaily, signalDate);
    let bestThemeKey = null, bestThemeLabel = null, bestThemeStrength = 'NONE';
    let bestStrongRatio = 0, bestAvgChange = -999;
    for (const m of matched) {
      const td = nasdaqEntry?.themes?.[m.themeKey];
      if (!td) continue;
      const strength = classifyThemeStrength(td);
      const ratio = td.totalTickerCount > 0 ? td.strongTickerCount / td.totalTickerCount : 0;
      const rank = { STRONG: 3, MID: 2, WEAK: 1, NONE: 0 };
      if (rank[strength] > (rank[bestThemeStrength] || 0) ||
          (rank[strength] === (rank[bestThemeStrength] || 0) && ratio > bestStrongRatio)) {
        bestThemeKey = m.themeKey;
        bestThemeLabel = m.label;
        bestThemeStrength = strength;
        bestStrongRatio = ratio;
        bestAvgChange = td.avgChangePct;
      }
    }
    const themeMatchReason = matched.length > 0 ? 'directStockMatch' : 'no_match';

    // themeScore 계산 (최대 35)
    let themeScore = 0;
    if (matched.length > 0) themeScore += 10;
    if (bestThemeStrength === 'STRONG') themeScore += 10;
    else if (bestThemeStrength === 'MID') themeScore += 5;
    if (bestStrongRatio >= 0.6) themeScore += 5;
    if (oneDaySurgeScore >= 80) themeScore += 3;
    if (hasQvaLead) themeScore += 5;
    themeScore = Math.min(35, themeScore);

    // 거래대금 강도 점수
    const last20 = rows.slice(Math.max(0, sIdx - 19), sIdx + 1);
    const avg20Value = avg(last20.map(r => r.valueApprox || 0));
    const todayValue = sRow.valueApprox || 0;
    const valStrength = avg20Value > 0 ? todayValue / avg20Value : 1;
    let valueStrengthBonus = 0;
    if (valStrength >= 5) valueStrengthBonus = 8;
    else if (valStrength >= 3) valueStrengthBonus = 5;
    else if (valStrength >= 2) valueStrengthBonus = 2;

    // QVA lead bonus / QVA2 bonus
    const qvaLeadBonus = hasQvaLead ? 5 : 0;
    const qva2LeadBonus = hasQva2Lead ? 3 : 0;

    // finalScore
    const finalScore = oneDaySurgeScore + themeScore + qvaLeadBonus + valueStrengthBonus + qva2LeadBonus;

    signals.push({
      code, name, signalDate, signalKind, sourceGroup,
      oneDaySurgeScore, signalPrice,
      open: sRow.open, high: sRow.high, low: sRow.low, close: sRow.close,
      volume: sRow.volume, value: sRow.valueApprox,
      // 당일 + 후속
      signalDayHighFromSignalPrice, signalDayCloseFromSignalPrice,
      closeAboveSignalPrice: sRow.close >= signalPrice,
      d1MaxUp: dayCheckpoints[1], d3MaxUp: dayCheckpoints[3], d5MaxUp: dayCheckpoints[5],
      d10MaxUp: dayCheckpoints[10], d20MaxUp: dayCheckpoints[20],
      d1MaxDown: dayDownCheckpoints[1], d3MaxDown: dayDownCheckpoints[3], d5MaxDown: dayDownCheckpoints[5],
      d10MaxDown: dayDownCheckpoints[10], d20MaxDown: dayDownCheckpoints[20],
      maxUpFromSignal, maxDownFromSignal,
      hit3:  fHit[3]  != null, hit5:  fHit[5]  != null,
      hit10: fHit[10] != null, hit15: fHit[15] != null,
      hit20: fHit[20] != null, hit30: fHit[30] != null, hit50: fHit[50] != null,
      hit10Day: fHit[10] ?? null, hit20Day: fHit[20] ?? null, hit50Day: fHit[50] ?? null,
      breach3:  fBreach[3]  != null, breach5:  fBreach[5]  != null,
      breach7:  fBreach[7]  != null, breach10: fBreach[10] != null,
      breach5Day: fBreach[5] ?? null, breach10Day: fBreach[10] ?? null,
      bigGroups,
      isActualVvi2,
      // QVA lead
      hasQvaLead, hasQva1Lead, hasQva2Lead, qvaLeadType,
      qvaLeadDate, qvaLeadDaysAgo, qvaLeadScore,
      qvaLeadStillAlive, qvaLeadStillAlive5, qvaLeadMaxDropPct,
      // 테마
      matchedThemes: matched.map(m => m.themeKey),
      themeMatchCount: matched.length,
      bestThemeKey, bestThemeLabel, bestThemeStrength,
      themeMatchReason, bestStrongRatio: Number(bestStrongRatio.toFixed(3)),
      bestAvgChange: bestAvgChange === -999 ? null : bestAvgChange,
      // 점수
      themeScore, valueStrength: Number(valStrength.toFixed(2)), valueStrengthBonus,
      qvaLeadBonus, qva2LeadBonus, finalScore,
    });
  }
  console.log(`  추적 ${signals.length} / skip ${skipped}`);

  // ─── 그룹 집계 ────────────────────────────────────────────────────────
  function makeGroup(label, items) {
    const n = items.length;
    if (n === 0) return { group: label, n: 0, sampleQuality: sampleQualityOf(0) };
    return {
      group: label, n, sampleQuality: sampleQualityOf(n),
      withQvaLead: items.filter(x => x.hasQvaLead).length,
      withQva2Lead: items.filter(x => x.hasQva2Lead).length,
      // 당일
      avgSignalDayHigh:  Number((avg(items.map(x => x.signalDayHighFromSignalPrice)) ?? 0).toFixed(2)),
      avgSignalDayClose: Number((avg(items.map(x => x.signalDayCloseFromSignalPrice)) ?? 0).toFixed(2)),
      closeAboveRate:    rate(items.filter(x => x.closeAboveSignalPrice).length, n),
      // 후속
      avgD1Max:  Number((avg(items.map(x => x.d1MaxUp))  ?? 0).toFixed(2)),
      avgD3Max:  Number((avg(items.map(x => x.d3MaxUp))  ?? 0).toFixed(2)),
      avgD5Max:  Number((avg(items.map(x => x.d5MaxUp))  ?? 0).toFixed(2)),
      avgD10Max: Number((avg(items.map(x => x.d10MaxUp)) ?? 0).toFixed(2)),
      avgD20Max: Number((avg(items.map(x => x.d20MaxUp)) ?? 0).toFixed(2)),
      // hit
      hit5Rate:  rate(items.filter(x => x.hit5).length, n),
      hit10Rate: rate(items.filter(x => x.hit10).length, n),
      hit15Rate: rate(items.filter(x => x.hit15).length, n),
      hit20Rate: rate(items.filter(x => x.hit20).length, n),
      hit30Rate: rate(items.filter(x => x.hit30).length, n),
      hit50Rate: rate(items.filter(x => x.hit50).length, n),
      // breach
      breach3Rate:  rate(items.filter(x => x.breach3).length, n),
      breach5Rate:  rate(items.filter(x => x.breach5).length, n),
      breach7Rate:  rate(items.filter(x => x.breach7).length, n),
      breach10Rate: rate(items.filter(x => x.breach10).length, n),
      // BIG-RUN
      big20Rate: rate(items.filter(x => x.bigGroups.includes('BIG_20')).length, n),
      big30Rate: rate(items.filter(x => x.bigGroups.includes('BIG_30')).length, n),
      big50Rate: rate(items.filter(x => x.bigGroups.includes('BIG_50')).length, n),
      superFireRate: rate(items.filter(x => x.bigGroups.includes('SUPER_FIRE')).length, n),
      actualVvi2Rate: rate(items.filter(x => x.isActualVvi2).length, n),
      // 점수
      avgOneDsScore:  Number((avg(items.map(x => x.oneDaySurgeScore)) ?? 0).toFixed(1)),
      avgThemeScore:  Number((avg(items.map(x => x.themeScore)) ?? 0).toFixed(1)),
      avgFinalScore:  Number((avg(items.map(x => x.finalScore)) ?? 0).toFixed(1)),
    };
  }

  const baseGroups = [
    makeGroup('ALL_1DS',                 signals),
    makeGroup('1DS_WITH_THEME',          signals.filter(x => x.themeMatchCount > 0)),
    makeGroup('1DS_WITH_STRONG_THEME',   signals.filter(x => x.bestThemeStrength === 'STRONG')),
    makeGroup('1DS_WITH_MID_THEME',      signals.filter(x => x.bestThemeStrength === 'MID')),
    makeGroup('1DS_WITHOUT_THEME',       signals.filter(x => x.themeMatchCount === 0)),
  ];
  const qvaGroups = [
    makeGroup('1DS_WITH_QVA_LEAD',                 signals.filter(x => x.hasQvaLead)),
    makeGroup('1DS_WITH_QVA1_LEAD',                signals.filter(x => x.hasQva1Lead)),
    makeGroup('1DS_WITH_QVA2_LEAD',                signals.filter(x => x.hasQva2Lead)),
    makeGroup('1DS_WITH_QVA_LEAD_AND_THEME',       signals.filter(x => x.hasQvaLead && x.themeMatchCount > 0)),
    makeGroup('1DS_WITH_QVA_LEAD_AND_STRONG_THEME',signals.filter(x => x.hasQvaLead && x.bestThemeStrength === 'STRONG')),
    makeGroup('1DS_WITHOUT_QVA_BUT_THEME',         signals.filter(x => !x.hasQvaLead && x.themeMatchCount > 0)),
  ];
  const themeGroups = themeKeys.map(k => makeGroup('1DS_THEME_' + k, signals.filter(x => x.matchedThemes.includes(k))));

  // themeScore 구간
  function inRange(n, lo, hi) { return n >= lo && n <= hi; }
  const themeScoreBuckets = [
    makeGroup('THEME_SCORE_0',     signals.filter(x => x.themeScore === 0)),
    makeGroup('THEME_SCORE_1_9',   signals.filter(x => inRange(x.themeScore, 1, 9))),
    makeGroup('THEME_SCORE_10_19', signals.filter(x => inRange(x.themeScore, 10, 19))),
    makeGroup('THEME_SCORE_20_29', signals.filter(x => inRange(x.themeScore, 20, 29))),
    makeGroup('THEME_SCORE_30_PLUS', signals.filter(x => x.themeScore >= 30)),
  ];

  // finalScore TOP_N_PER_DAY
  const byDate = new Map();
  for (const s of signals) {
    if (!byDate.has(s.signalDate)) byDate.set(s.signalDate, []);
    byDate.get(s.signalDate).push(s);
  }
  function topNPerDay(n) {
    const picked = [];
    for (const [date, arr] of byDate) {
      const sorted = arr.slice().sort((a, b) => b.finalScore - a.finalScore);
      for (const s of sorted.slice(0, n)) picked.push(s);
    }
    return picked;
  }
  const topNGroups = [
    makeGroup('TOP_5_PER_DAY',  topNPerDay(5)),
    makeGroup('TOP_10_PER_DAY', topNPerDay(10)),
    makeGroup('TOP_20_PER_DAY', topNPerDay(20)),
  ];

  // ─── 대표 사례 ───────────────────────────────────────────────────────
  function caseRow(s, interpret) {
    return {
      code: s.code, name: s.name, signalDate: s.signalDate, signalKind: s.signalKind,
      oneDaySurgeScore: s.oneDaySurgeScore, themeScore: s.themeScore, finalScore: s.finalScore,
      bestThemeKey: s.bestThemeKey, bestThemeLabel: s.bestThemeLabel,
      bestThemeStrength: s.bestThemeStrength, bestAvgChange: s.bestAvgChange,
      qvaLeadType: s.qvaLeadType, qvaLeadDate: s.qvaLeadDate, qvaLeadDaysAgo: s.qvaLeadDaysAgo,
      qvaLeadStillAlive: s.qvaLeadStillAlive,
      signalDayHighFromSignalPrice: s.signalDayHighFromSignalPrice,
      signalDayCloseFromSignalPrice: s.signalDayCloseFromSignalPrice,
      maxUpFromSignal: s.maxUpFromSignal, maxDownFromSignal: s.maxDownFromSignal,
      d5MaxUp: s.d5MaxUp, d20MaxUp: s.d20MaxUp,
      hit10Day: s.hit10Day, hit20Day: s.hit20Day, hit50Day: s.hit50Day,
      breach5Day: s.breach5Day, breach10Day: s.breach10Day,
      bigGroups: s.bigGroups, isActualVvi2: s.isActualVvi2,
      interpret,
    };
  }
  const winners = signals
    .filter(x => x.bestThemeStrength === 'STRONG' && x.hasQvaLead && x.bigGroups.includes('BIG_50'))
    .slice().sort((a, b) => (b.maxUpFromSignal || 0) - (a.maxUpFromSignal || 0))
    .slice(0, 15).map(s => caseRow(s,
      `${s.bestThemeLabel} STRONG + ${s.qvaLeadType} lead (${s.qvaLeadDaysAgo}일 전) → ${fmtPct(s.maxUpFromSignal, 1)}`
      + (s.bigGroups.includes('SUPER_FIRE') ? ' (SUPER_FIRE)' : '')));
  const losers = signals
    .filter(x => x.bestThemeStrength === 'STRONG' && x.breach10)
    .slice().sort((a, b) => (a.maxDownFromSignal || 0) - (b.maxDownFromSignal || 0))
    .slice(0, 15).map(s => caseRow(s, `${s.bestThemeLabel} STRONG이었지만 ${fmtPct(s.maxDownFromSignal, 1)} 이탈`));

  const dates = [...new Set(signals.map(s => s.signalDate))].sort();
  const todayDate = dates[dates.length - 1];
  const todayCandidates = signals
    .filter(s => s.signalDate === todayDate && s.bestThemeStrength === 'STRONG')
    .slice().sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 20)
    .map(s => caseRow(s, `${s.bestThemeLabel} STRONG (finalScore ${s.finalScore})` + (s.hasQvaLead ? ` · ${s.qvaLeadType} lead` : '')));

  // ─── 요약 ────────────────────────────────────────────────────────────
  const allG = baseGroups.find(g => g.group === 'ALL_1DS');
  const withT = baseGroups.find(g => g.group === '1DS_WITH_THEME');
  const withS = baseGroups.find(g => g.group === '1DS_WITH_STRONG_THEME');
  const without = baseGroups.find(g => g.group === '1DS_WITHOUT_THEME');
  const qvaAndStrong = qvaGroups.find(g => g.group === '1DS_WITH_QVA_LEAD_AND_STRONG_THEME');
  const liftBig50 = without && without.big50Rate > 0 ? Number((withS.big50Rate / without.big50Rate).toFixed(2)) : null;
  const qvaThemeLiftVsAll = allG.big50Rate > 0 && qvaAndStrong?.n > 0 ? Number((qvaAndStrong.big50Rate / allG.big50Rate).toFixed(2)) : null;
  const bestThemes = themeGroups.filter(g => g.n >= 30).slice().sort((a, b) => b.big50Rate - a.big50Rate).slice(0, 5);

  const summary = {
    totalSignals: signals.length,
    withThemeN: withT?.n || 0,
    strongThemeN: withS?.n || 0,
    midThemeN: baseGroups.find(g => g.group === '1DS_WITH_MID_THEME')?.n || 0,
    withoutThemeN: without?.n || 0,
    withQvaLeadN: qvaGroups.find(g => g.group === '1DS_WITH_QVA_LEAD')?.n || 0,
    withQvaLeadAndStrongN: qvaAndStrong?.n || 0,
    strongThemeBig50: withS?.big50Rate || 0,
    withoutThemeBig50: without?.big50Rate || 0,
    qvaLeadAndStrongBig50: qvaAndStrong?.big50Rate || 0,
    allBig50: allG.big50Rate,
    liftBig50,
    qvaThemeLiftVsAll,
    bestThemes: bestThemes.map(t => ({
      theme: t.group, n: t.n, big50Rate: t.big50Rate, big30Rate: t.big30Rate, superRate: t.superFireRate,
    })),
    top5PerDay:  topNGroups.find(g => g.group === 'TOP_5_PER_DAY'),
    top10PerDay: topNGroups.find(g => g.group === 'TOP_10_PER_DAY'),
    top20PerDay: topNGroups.find(g => g.group === 'TOP_20_PER_DAY'),
    todayDate,
    todayStrongCandidateCount: todayCandidates.length,
  };

  const result = {
    meta: {
      title: '1DS × 나스닥 테마 흐름 매칭 검증',
      generatedAt: new Date().toISOString(),
      followDays: FOLLOW_DAYS,
      qvaLeadLookback: QVA_LEAD_LOOKBACK_TRADING_DAYS,
      themeMapVersion: JSON.parse(fs.readFileSync(THEME_MAP_PATH, 'utf-8'))._meta?.version || 'unknown',
      themeDailyDates: themeDaily.map(d => d.date),
    },
    summary,
    baseGroups, qvaGroups, themeGroups, themeScoreBuckets, topNGroups,
    cases: { winners, losers, todayCandidates },
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  console.log(`✅ JSON: ${OUT_JSON}`);
  fs.writeFileSync(OUT_HTML, renderHtml(result));
  console.log(`✅ HTML: ${OUT_HTML}`);

  // 콘솔
  console.log();
  console.log('━'.repeat(80));
  console.log('=== 1DS × 나스닥 테마 검증 요약 ===');
  console.log(`전체 1DS: ${signals.length} / 테마 매칭: ${withT.n} (${rate(withT.n, signals.length)}%) / STRONG: ${withS.n} / QVA lead+STRONG: ${qvaAndStrong?.n || 0}`);
  console.log();
  console.log(`▶ 1DS_WITH_STRONG_THEME BIG_50:           ${withS.big50Rate}%`);
  console.log(`▶ 1DS_WITHOUT_THEME    BIG_50:           ${without.big50Rate}%`);
  console.log(`▶ 1DS_WITH_QVA_LEAD_AND_STRONG_THEME BIG_50: ${qvaAndStrong?.big50Rate || 0}% (n=${qvaAndStrong?.n || 0})`);
  console.log(`▶ ALL_1DS BIG_50: ${allG.big50Rate}%`);
  if (liftBig50 != null) console.log(`▶ STRONG vs WITHOUT lift: ${liftBig50}x`);
  if (qvaThemeLiftVsAll != null) console.log(`▶ QVA+STRONG vs ALL lift:  ${qvaThemeLiftVsAll}x`);
  console.log();
  console.log('테마별 BIG_50 TOP 3:');
  for (let i = 0; i < Math.min(3, bestThemes.length); i++) {
    const t = bestThemes[i];
    console.log(`  ${i+1}. ${t.group} — n=${t.n} BIG_50 ${t.big50Rate}% BIG_30 ${t.big30Rate}% SUPER ${t.superRate}%`);
  }
  console.log();
  const t10 = summary.top10PerDay;
  if (t10 && t10.n > 0) {
    console.log(`▶ TOP_10_PER_DAY 성과: n=${t10.n} / hit10 ${t10.hit10Rate}% / BIG_20 ${t10.big20Rate}% / BIG_30 ${t10.big30Rate}% / BIG_50 ${t10.big50Rate}% / SUPER ${t10.superFireRate}% / breach10 ${t10.breach10Rate}%`);
  }
  console.log();
  // 운영 적용 결론
  let verdict;
  if (withS.n >= 30 && liftBig50 != null) {
    const liftOk = liftBig50 >= 1.5;
    const qvaThemeOk = qvaThemeLiftVsAll != null && qvaThemeLiftVsAll >= 2.0;
    if (liftOk && qvaThemeOk) verdict = `운영 적용 가능 — STRONG lift ${liftBig50}x + QVA+STRONG lift ${qvaThemeLiftVsAll}x로 우선순위 정렬 가치 있음`;
    else if (liftOk || qvaThemeOk) verdict = `부분적 가치 — lift ${liftBig50}x / QVA+STRONG ${qvaThemeLiftVsAll}x — 한쪽 기준만 충족`;
    else verdict = `효과 약함 (lift ${liftBig50}x / QVA+STRONG ${qvaThemeLiftVsAll}x) — 매핑 + 일일 강도 데이터 더 채워야`;
  } else {
    verdict = `표본 부족 (STRONG n=${withS.n}) — 매핑 + 일일 강도 데이터 누적 필요`;
  }
  console.log('▶ 운영 적용 가능성: ' + verdict);
  console.log(`⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await closePool();
}

// ─── HTML 렌더 ───────────────────────────────────────────────────────────
function renderHtml(result) {
  const { meta, summary, baseGroups, qvaGroups, themeGroups, themeScoreBuckets, topNGroups, cases } = result;

  function groupRow(g) {
    if (!g || g.n === 0) return `<tr><td><b>${esc(g.group)}</b></td><td colspan="20">데이터 없음</td></tr>`;
    return '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td>${sampleQualityPill(g.sampleQuality)}</td>` +
      `<td class="num">${g.withQvaLead||0}/${g.withQva2Lead||0}</td>` +
      `<td class="num">${fmtPct(g.avgSignalDayHigh)}</td>` +
      `<td class="num">${fmtPct(g.avgSignalDayClose)}</td>` +
      `<td class="num">${g.closeAboveRate}%</td>` +
      `<td class="num">${fmtPct(g.avgD1Max)}</td>` +
      `<td class="num">${fmtPct(g.avgD5Max)}</td>` +
      `<td class="num">${fmtPct(g.avgD10Max)}</td>` +
      `<td class="num">${fmtPct(g.avgD20Max)}</td>` +
      `<td class="num pos">${g.hit10Rate}%</td>` +
      `<td class="num pos">${g.hit20Rate}%</td>` +
      `<td class="num">${g.big20Rate}%</td>` +
      `<td class="num">${g.big30Rate}%</td>` +
      `<td class="num pos">${g.big50Rate}%</td>` +
      `<td class="num pos">${g.superFireRate}%</td>` +
      `<td class="num">${g.actualVvi2Rate}%</td>` +
      `<td class="num neg">${g.breach5Rate}%</td>` +
      `<td class="num neg">${g.breach10Rate}%</td>` +
      `<td class="num">${g.avgOneDsScore}</td>` +
      `<td class="num">${g.avgThemeScore}</td>` +
      `<td class="num">${g.avgFinalScore}</td>` +
      '</tr>';
  }
  const headRow = '<thead><tr>' +
    '<th>그룹</th><th>n</th><th>표본</th><th>QVA/QVA2 lead</th>' +
    '<th>당일 고가</th><th>당일 종가</th><th>종가>=signal</th>' +
    '<th>D+1</th><th>D+5</th><th>D+10</th><th>D+20</th>' +
    '<th>hit10</th><th>hit20</th>' +
    '<th>BIG_20</th><th>BIG_30</th><th>BIG_50</th><th>SUPER</th>' +
    '<th>VVI2</th>' +
    '<th>-5%</th><th>-10%</th>' +
    '<th>avg 1DS</th><th>avg theme</th><th>avg final</th>' +
    '</tr></thead>';
  function groupTable(rows) { return '<table class="t">' + headRow + '<tbody>' + rows.map(groupRow).join('') + '</tbody></table>'; }

  function caseTable(list, emptyMsg) {
    if (!list || list.length === 0) return `<div class="empty">${esc(emptyMsg)}</div>`;
    return '<table class="t"><thead><tr>' +
      '<th>종목</th><th>1DS일</th><th>kind</th>' +
      '<th>1DS</th><th>theme</th><th>final</th>' +
      '<th>테마</th><th>강도</th><th>나스닥</th>' +
      '<th>QVA lead</th><th>며칠전</th>' +
      '<th>당일↑</th><th>당일종가</th>' +
      '<th>maxUp</th><th>maxDown</th>' +
      '<th>BIG?</th><th>VVI2</th>' +
      '<th>해석</th>' +
      '</tr></thead><tbody>' +
      list.map(c => '<tr>' +
        `<td><b>${esc(c.name)}</b><div class="code">${esc(c.code)}</div></td>` +
        `<td>${esc(c.signalDate)}</td>` +
        `<td><span class="pill p-neu">${esc(c.signalKind || '')}</span></td>` +
        `<td class="num">${c.oneDaySurgeScore}</td>` +
        `<td class="num">${c.themeScore}</td>` +
        `<td class="num pos"><b>${c.finalScore}</b></td>` +
        `<td>${esc(c.bestThemeLabel || '—')}</td>` +
        `<td>${c.bestThemeStrength === 'STRONG' ? '<span class="pill p-good">STRONG</span>' :
              c.bestThemeStrength === 'MID' ? '<span class="pill p-q2">MID</span>' :
              c.bestThemeStrength === 'WEAK' ? '<span class="pill p-neu">WEAK</span>' :
              '<span class="pill p-neu">—</span>'}</td>` +
        `<td class="num">${fmtPct(c.bestAvgChange)}</td>` +
        `<td>${c.qvaLeadType !== 'NONE' ? `<span class="pill ${c.qvaLeadType.includes('QVA2') ? 'p-q2' : 'p-q1'}">${esc(c.qvaLeadType)}</span>` : '—'}</td>` +
        `<td class="num">${c.qvaLeadDaysAgo ?? '—'}</td>` +
        `<td class="num pos">${fmtPct(c.signalDayHighFromSignalPrice)}</td>` +
        `<td class="num">${fmtPct(c.signalDayCloseFromSignalPrice)}</td>` +
        `<td class="num pos">${fmtPct(c.maxUpFromSignal)}</td>` +
        `<td class="num neg">${fmtPct(c.maxDownFromSignal)}</td>` +
        `<td>${c.bigGroups?.includes('SUPER_FIRE') ? '<span class="pill p-q2">SUPER</span>' :
              c.bigGroups?.includes('BIG_50') ? '<span class="pill p-good">BIG_50</span>' :
              c.bigGroups?.includes('BIG_30') ? '<span class="pill p-q2">BIG_30</span>' :
              c.bigGroups?.includes('BIG_20') ? '<span class="pill p-neu">BIG_20</span>' : '—'}</td>` +
        `<td>${c.isActualVvi2 ? '<span class="pill p-good">확정</span>' : '—'}</td>` +
        `<td style="font-size:11px;color:#cbd5e1;max-width:280px;">${esc(c.interpret || '')}</td>` +
        '</tr>').join('') + '</tbody></table>';
  }

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>${esc(meta.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif; background: #0f172a; color: #cbd5e1; margin: 0; padding: 18px 22px 60px; max-width: 2000px; }
  h1 { color: #f1f5f9; font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: #94a3b8; font-size: 12px; margin-bottom: 16px; }
  h2 { color: #5eead4; font-size: 17px; margin: 24px 0 10px; border-left: 4px solid #14b8a6; padding-left: 10px; }
  h3 { color: #c4b5fd; font-size: 14px; margin: 14px 0 8px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 18px; margin-bottom: 14px; }
  .card-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
  .stat { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; }
  .stat .lbl { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
  .stat .val { color: #f1f5f9; font-size: 22px; font-weight: 700; margin-top: 4px; line-height: 1.1; }
  .stat .sub { color: #94a3b8; font-size: 11px; margin-top: 2px; }
  table.t { width: 100%; border-collapse: collapse; background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; font-size: 11.5px; margin-bottom: 12px; }
  table.t th, table.t td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #334155; color: #cbd5e1; vertical-align: top; }
  table.t th { background: #0f172a; color: #5eead4; font-weight: 600; font-size: 10.5px; }
  table.t td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.t td.pos { color: #86efac; font-weight: 600; }
  table.t td.neg { color: #fca5a5; }
  .code { color: #64748b; font-size: 10.5px; font-family: ui-monospace, monospace; }
  .pill { display: inline-block; padding: 1.5px 7px; border-radius: 999px; font-size: .7rem; font-weight: 600; margin: 0 2px; }
  .p-q1   { background: #052e16; color: #86efac; border: 1px solid #166534; }
  .p-q2   { background: #1e1b4b; color: #c4b5fd; border: 1px solid #4338ca; }
  .p-good { background: #064e3b; color: #a7f3d0; border: 1px solid #10b981; }
  .p-neu  { background: #0f172a; color: #64748b; border: 1px solid #334155; }
  .p-warn { background: #422006; color: #fcd34d; border: 1px solid #b45309; }
  .empty { background: rgba(0,0,0,0.3); border: 1px dashed #334155; padding: 14px; text-align: center; border-radius: 6px; color: #94a3b8; }
  .hint { color: #94a3b8; font-size: 11.5px; line-height: 1.6; margin-bottom: 8px; }
  .warn-note { background:#422006; border:1px solid #b45309; color:#fde68a; padding:10px 14px; border-radius:8px; font-size:12px; margin: 12px 0; line-height: 1.6; }
</style></head>
<body>
<h1>${esc(meta.title)}</h1>
<div class="subtitle">생성: ${esc(meta.generatedAt)} · 추적 D+1~D+${meta.followDays} · QVA 선행 lookback ${meta.qvaLeadLookback}거래일 · 테마맵 v${esc(meta.themeMapVersion)} · 나스닥 강도 ${meta.themeDailyDates.length}일치</div>

<div class="warn-note">
  ⚠ <b>수동 매핑 기반 검증입니다.</b> 자동 매수 신호 X.
  data/theme/nasdaq-theme-{map,daily}.json을 수동 확장해야 매핑 정확도와 일일 강도 데이터가 늘어남.
</div>

<h2>1. 요약</h2>
<div class="card">
  <div class="card-row">
    <div class="stat"><div class="lbl">전체 1DS</div><div class="val">${summary.totalSignals}</div></div>
    <div class="stat"><div class="lbl">테마 매칭</div><div class="val">${summary.withThemeN}</div></div>
    <div class="stat"><div class="lbl">STRONG 테마</div><div class="val pos">${summary.strongThemeN}</div></div>
    <div class="stat"><div class="lbl">QVA lead 보유</div><div class="val">${summary.withQvaLeadN}</div></div>
    <div class="stat" style="background:#3a1a04;"><div class="lbl">QVA lead + STRONG</div><div class="val" style="color:#fde68a;">${summary.withQvaLeadAndStrongN}</div></div>
    <div class="stat"><div class="lbl">STRONG BIG_50</div><div class="val pos">${summary.strongThemeBig50}%</div></div>
    <div class="stat"><div class="lbl">테마 없음 BIG_50</div><div class="val">${summary.withoutThemeBig50}%</div></div>
    <div class="stat"><div class="lbl">STRONG vs WITHOUT lift</div><div class="val">${summary.liftBig50 != null ? summary.liftBig50 + 'x' : '—'}</div></div>
    <div class="stat" style="background:#3a1a04;"><div class="lbl">QVA+STRONG BIG_50</div><div class="val pos" style="color:#fde68a;">${summary.qvaLeadAndStrongBig50}%</div></div>
    <div class="stat"><div class="lbl">QVA+STRONG vs ALL lift</div><div class="val">${summary.qvaThemeLiftVsAll != null ? summary.qvaThemeLiftVsAll + 'x' : '—'}</div></div>
    ${summary.bestThemes && summary.bestThemes[0] ? `<div class="stat"><div class="lbl">최고 테마</div><div class="val">${esc(summary.bestThemes[0].theme)}</div><div class="sub">BIG_50 ${summary.bestThemes[0].big50Rate}% (n=${summary.bestThemes[0].n})</div></div>` : ''}
  </div>
</div>

<h2>2. 테마 매칭 여부별 1DS 성과</h2>
${groupTable(baseGroups)}

<h2>3. QVA 선행 여부 + 테마 조합별 성과</h2>
<div class="hint">1DS signalDate 이전 ${meta.qvaLeadLookback}거래일 안에 QVA1/QVA2 발생한 종목.</div>
${groupTable(qvaGroups)}

<h2>4. 테마별 1DS 성과</h2>
${groupTable(themeGroups)}

<h2>5. themeScore 구간별 성과</h2>
<div class="hint">themeScore = directStockMatch(10) + STRONG(10)/MID(5) + strongRatio≥0.6(5) + 1DS≥80(3) + QVA lead(5). 최대 35.</div>
${groupTable(themeScoreBuckets)}

<h2>6. finalScore TOP N per day 시뮬</h2>
<div class="hint">finalScore = 1DS score + themeScore + qvaLeadBonus(5) + valueStrengthBonus + qva2LeadBonus(3). 매 signalDate별 상위 N개만 추렸을 때.</div>
${groupTable(topNGroups)}

<h2>7. 대표 성공 사례 — 1DS + STRONG 테마 + QVA lead + BIG_50</h2>
${caseTable(cases.winners, 'STRONG 테마 + QVA lead + BIG_50 사례 없음')}

<h2>8. 대표 실패 사례 — STRONG 테마였지만 -10% 이탈</h2>
${caseTable(cases.losers, 'STRONG 테마였지만 실패한 사례 없음')}

<h2>9. 오늘(${esc(summary.todayDate)}) 기준 STRONG 테마 매칭 후보 (참고용)</h2>
<div class="hint">검증 보고서 예시 — 운영 매수 신호 X. finalScore 상위 20개.</div>
${caseTable(cases.todayCandidates, '오늘 기준 STRONG 테마 매칭 1DS 없음')}

<footer style="margin-top: 24px; padding: 12px; background: #1e293b; border-radius: 6px; color: #64748b; font-size: 11.5px; text-align: center;">
  수동 테마 매핑 기반 검증. 운영 보드/cron/라우터 추가 X. 매핑 확장은 data/theme/ 하위 JSON 수정.
</footer>
</body></html>`;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
