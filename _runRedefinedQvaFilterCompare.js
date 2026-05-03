/**
 * REDEFINED_TIGHT QVA 추가 필터 비교 — 1년치
 *
 * 사용자 우려(쿼드메디슨 케이스): 거래대금이 말라있는 종목에서 ratio가 부풀려져 잡히는
 * 케이스를 잡기 위해 BASE에 4가지 필터를 단계적으로 더해 비교.
 *
 * 시나리오:
 *   BASE              — 현재 REDEFINED_TIGHT
 *   FILTER_A          — BASE + liquidityFloor A (오늘 ≥ 10억, prev20 median ≥ 3억) + lowStabilized
 *   FILTER_B          — A + notCollapsedAfterPump (returnFromHigh60 ≤ -35 AND maxValue60 ≥ ×3)
 *   FILTER_C          — B + ma60Mul 0.85
 *   FILTER_D          — B + liquidityFloor B (오늘 ≥ 20억, prev20 median ≥ 5억) + ma60Mul 0.85
 *   ※ 부록: FILTER_C30 — FILTER_C에서 collapseRetThreshold만 -30%로 완화 (쿼드메디슨 케이스 위주)
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const SCAN_START = '20250401';
const SCAN_END = '20260424';
const FORWARD_HORIZONS = [5, 10, 20];
const VVI_LOOKAHEAD = 20;
const MERGE = 10;

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

const SCENARIOS = {
  BASE: {},
  FILTER_A: {
    minTodayValue: 1_000_000_000,
    minMedianPrev20Value: 300_000_000,
    requireLowStabilized: true,
  },
  FILTER_B: {
    minTodayValue: 1_000_000_000,
    minMedianPrev20Value: 300_000_000,
    requireLowStabilized: true,
    requireNotCollapsed: true,
    collapseRetThreshold: -35,
    collapseValueRatio: 3,
  },
  FILTER_C: {
    minTodayValue: 1_000_000_000,
    minMedianPrev20Value: 300_000_000,
    requireLowStabilized: true,
    requireNotCollapsed: true,
    collapseRetThreshold: -35,
    collapseValueRatio: 3,
    ma60Mul: 0.85,
  },
  FILTER_D: {
    minTodayValue: 2_000_000_000,
    minMedianPrev20Value: 500_000_000,
    requireLowStabilized: true,
    requireNotCollapsed: true,
    collapseRetThreshold: -35,
    collapseValueRatio: 3,
    ma60Mul: 0.85,
  },
  // 부록: 쿼드메디슨 returnFromHigh60 = -31% 라서 spec -35% 임계로는 안 잡힘 → -30%로 완화
  FILTER_C30: {
    minTodayValue: 1_000_000_000,
    minMedianPrev20Value: 300_000_000,
    requireLowStabilized: true,
    requireNotCollapsed: true,
    collapseRetThreshold: -30,
    collapseValueRatio: 3,
    ma60Mul: 0.85,
  },
};

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function mean(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function rate(num, denom) { return denom > 0 ? round2(num / denom * 100) : null; }
function round2(v) { return v == null || !Number.isFinite(v) ? null : parseFloat(v.toFixed(2)); }

function computeForwards(rows, entryIdx, entryPrice, horizons) {
  const out = { d: {} };
  for (const h of horizons) {
    const idx = entryIdx + h;
    out.d[h] = idx < rows.length && entryPrice > 0
      ? (rows[idx].close / entryPrice - 1) * 100 : null;
  }
  let mfe = null, mae = null;
  for (let k = 1; k <= 20 && entryIdx + k < rows.length; k++) {
    const r = rows[entryIdx + k];
    const up = (r.high / entryPrice - 1) * 100;
    const dn = (r.low / entryPrice - 1) * 100;
    if (mfe == null || up > mfe) mfe = up;
    if (mae == null || dn < mae) mae = dn;
  }
  out.mfe20 = mfe; out.mae20 = mae;
  return out;
}

function runScenario(name, overrides) {
  const t0 = Date.now();
  const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
  const codeMeta = new Map();
  for (const s of stocksList.stocks) codeMeta.set(s.code, s);
  const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));

  const events = [];
  let inoCheck = null, quadCheck = null;
  let hgCount = 0, vviCount = 0;

  for (let fi = 0; fi < files.length; fi++) {
    if (fi % 500 === 0) process.stdout.write(`  [${name}] ${fi}/${files.length}\r`);
    const code = files[fi].replace('.json', '');
    const meta = codeMeta.get(code);
    if (!meta) continue;
    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8')); }
    catch (_) { continue; }
    const rows = chart.rows || [];
    if (rows.length < 65) continue;
    if (isExcludedProduct(chart.name || meta.name)) continue;

    let flow;
    try { flow = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, files[fi]), 'utf-8')); }
    catch (_) { flow = { rows: [] }; }
    const flowRows = flow.rows || [];
    const namedMeta = { ...meta, name: meta.name || chart.name };

    // 이노션/쿼드메디슨 별도 체크 (forward 부족 무관)
    if (code === '214320') {
      const inoIdx = rows.findIndex(r => r.date === '20260410');
      if (inoIdx >= 0) {
        const sl = rows.slice(0, inoIdx + 1);
        const r = ps.calculateRedefinedQVA(sl, [], namedMeta, overrides);
        inoCheck = { passed: !!r?.passed, score: r?.score || 0, reasons: r?.excludeReasons || [], signals: r?.signals };
      }
    }
    if (code === '464490') {
      const qIdx = rows.findIndex(r => r.date === '20260427');
      if (qIdx >= 0) {
        const sl = rows.slice(0, qIdx + 1);
        const r = ps.calculateRedefinedQVA(sl, [], namedMeta, overrides);
        quadCheck = { passed: !!r?.passed, score: r?.score || 0, reasons: r?.excludeReasons || [], signals: r?.signals };
      }
    }

    let lastIdx = -MERGE - 1;
    for (let t = 60; t < rows.length - Math.max(...FORWARD_HORIZONS); t++) {
      const today = rows[t];
      if (today.date < SCAN_START || today.date > SCAN_END) continue;
      const sliced = rows.slice(0, t + 1);
      let r = null;
      try { r = ps.calculateRedefinedQVA(sliced, [], namedMeta, overrides); } catch (_) {}
      if (!r?.passed) continue;
      // episode dedup
      if (t - lastIdx <= MERGE) { lastIdx = t; continue; }
      lastIdx = t;

      const fwd = computeForwards(rows, t, today.close, FORWARD_HORIZONS);

      // VVI lookahead
      let vviIdx = null;
      const maxLook = Math.min(VVI_LOOKAHEAD, rows.length - 1 - t);
      for (let k = 1; k <= maxLook; k++) {
        const candIdx = t + k;
        const candDate = rows[candIdx].date;
        const slC = rows.slice(0, candIdx + 1);
        const slF = flowRows.filter(rr => rr.date <= candDate);
        if (slF.length < 10) continue;
        let vvi = null;
        try { vvi = ps.calculateVolumeValueIgnition(slC, slF, namedMeta); } catch (_) {}
        if (vvi?.passed) { vviIdx = candIdx; break; }
      }
      let isVvi = vviIdx != null;
      let isHg = false;
      if (isVvi && vviIdx + 1 < rows.length) {
        const v = rows[vviIdx], n = rows[vviIdx + 1];
        if (n.high >= v.high * 1.01 && n.close >= v.high) isHg = true;
      }
      if (isVvi) vviCount++;
      if (isHg) hgCount++;

      events.push({
        code, name: chart.name || meta.name,
        date: today.date,
        score: r.score,
        d5: fwd.d[5], d10: fwd.d[10], d20: fwd.d[20],
        mfe20: fwd.mfe20, mae20: fwd.mae20,
        isVvi, isHg,
      });
    }
  }
  process.stdout.write(`  [${name}] ${files.length}/${files.length} (${((Date.now() - t0) / 1000).toFixed(0)}s, ${events.length} signals)\n`);

  const N = events.length;
  const uniq = new Set(events.map(e => e.code)).size;
  function calcRet(key) {
    const arr = events.map(e => e[key]).filter(v => v != null && Number.isFinite(v));
    if (arr.length === 0) return null;
    return {
      n: arr.length,
      winRate: round2(arr.filter(v => v > 0).length / arr.length * 100),
      mean: round2(mean(arr)),
      median: round2(median(arr)),
    };
  }
  const d20 = events.map(e => e.d20).filter(v => v != null && Number.isFinite(v));
  return {
    scenario: name,
    overrides,
    n: N,
    uniqueStocks: uniq,
    dailyAvg: round2(N / 240),
    d5: calcRet('d5'),
    d10: calcRet('d10'),
    d20: calcRet('d20'),
    win10pct20: round2(d20.filter(v => v >= 10).length / Math.max(d20.length, 1) * 100),
    win20pct20: round2(d20.filter(v => v >= 20).length / Math.max(d20.length, 1) * 100),
    loss10pct20: round2(d20.filter(v => v <= -10).length / Math.max(d20.length, 1) * 100),
    avgMfe20: round2(mean(events.map(e => e.mfe20).filter(v => v != null))),
    avgMae20: round2(mean(events.map(e => e.mae20).filter(v => v != null))),
    vviRate: rate(vviCount, N),
    hgRate: rate(hgCount, N),
    inoCheck, quadCheck,
  };
}

console.log(`\n📊 REDEFINED_TIGHT QVA 추가 필터 비교 — ${SCAN_START} ~ ${SCAN_END}\n`);
const results = {};
for (const [name, ov] of Object.entries(SCENARIOS)) {
  results[name] = runScenario(name, ov);
}

// 출력
console.log(`\n${'='.repeat(140)}`);
console.log('Scenario     N    Stocks Daily  D5+%   D5avg  D10+%  D10avg D20+%  D20avg D20med +10%↑ +20%↑ -10%↓  MFE20  MAE20  VVI%  HG%');
console.log('-'.repeat(140));
for (const [name, r] of Object.entries(results)) {
  console.log(
    name.padEnd(13) +
    String(r.n).padStart(5) + ' ' +
    String(r.uniqueStocks).padStart(6) + ' ' +
    String(r.dailyAvg ?? '-').padStart(5) + ' ' +
    String(r.d5?.winRate ?? '-').padStart(6) + ' ' +
    String(r.d5?.mean ?? '-').padStart(6) + ' ' +
    String(r.d10?.winRate ?? '-').padStart(6) + ' ' +
    String(r.d10?.mean ?? '-').padStart(6) + ' ' +
    String(r.d20?.winRate ?? '-').padStart(6) + ' ' +
    String(r.d20?.mean ?? '-').padStart(6) + ' ' +
    String(r.d20?.median ?? '-').padStart(6) + ' ' +
    String(r.win10pct20 ?? '-').padStart(5) + ' ' +
    String(r.win20pct20 ?? '-').padStart(5) + ' ' +
    String(r.loss10pct20 ?? '-').padStart(5) + ' ' +
    String(r.avgMfe20 ?? '-').padStart(6) + ' ' +
    String(r.avgMae20 ?? '-').padStart(6) + ' ' +
    String(r.vviRate ?? '-').padStart(5) + ' ' +
    String(r.hgRate ?? '-').padStart(5)
  );
}

console.log(`\n📍 이노션 214320 2026-04-10:`);
for (const [name, r] of Object.entries(results)) {
  const i = r.inoCheck;
  if (!i) { console.log(`  ${name.padEnd(13)}: 데이터 없음`); continue; }
  console.log(`  ${name.padEnd(13)}: ${i.passed ? '✅ PASS (' + i.score + ')' : '❌ REJECT'}` + (!i.passed && i.reasons?.length ? '  사유: ' + i.reasons.slice(0, 2).join(' / ') : ''));
}

console.log(`\n📍 쿼드메디슨 464490 2026-04-27:`);
for (const [name, r] of Object.entries(results)) {
  const q = r.quadCheck;
  if (!q) { console.log(`  ${name.padEnd(13)}: 데이터 없음`); continue; }
  console.log(`  ${name.padEnd(13)}: ${q.passed ? '✅ PASS (' + q.score + ')' : '❌ REJECT'}` + (!q.passed && q.reasons?.length ? '  사유: ' + q.reasons.slice(0, 2).join(' / ') : ''));
}

// 쿼드메디슨 디버그 수치
const quadBase = results.BASE.quadCheck;
if (quadBase) {
  console.log(`\n🔍 쿼드메디슨 4/27 BASE 디버그 수치:`);
  const s = quadBase.signals || {};
  const fmt억 = v => v != null ? (v / 1e8).toFixed(1) + '억' : '-';
  console.log(`  todayValue ${fmt억(s.todayValue)}  prev20ValueMedian ${fmt억(s.medianPrev20Value)}  maxPrev20 ${fmt억(s.maxPrev20Value)}`);
  console.log(`  maxValue60 ${fmt억(s.maxValue60)}  returnFromHigh60 ${s.returnFromHigh60}%`);
  console.log(`  recent5Low ${s.recent5Low}  previous5Low ${s.previous5Low}  low20 ${s.low20}`);
  console.log(`  close ${s.close}  ma5 ${s.ma5}  ma60 ${s.ma60}`);
  console.log(`  lowStabilized=${s.lowStabilized} higherLow=${s.higherLow}  closeAboveMa5=${s.ma5 != null && s.close >= s.ma5}`);
  console.log(`  passedQVA=${quadBase.passed} score=${quadBase.score}`);
  console.log(`  failedReasons (BASE는 통과): ${quadBase.reasons.join(' / ') || '(none)'}`);
  // 각 시나리오에서의 사유
  for (const [name, r] of Object.entries(results)) {
    if (name === 'BASE') continue;
    const q = r.quadCheck;
    if (q && !q.passed) {
      console.log(`  ${name} reject 사유: ${q.reasons.slice(0, 3).join(' / ')}`);
    }
  }
}

const outPath = path.join(ROOT, 'redefined-qva-filter-compare.json');
fs.writeFileSync(outPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  scanStart: SCAN_START, scanEnd: SCAN_END,
  scenarios: results,
}, null, 2));
console.log(`\n✅ JSON 저장: ${outPath}`);
