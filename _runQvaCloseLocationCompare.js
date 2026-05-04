/**
 * QVA closeLocation 임계 4-way 비교 + 7개 종목 케이스 검증
 *
 * 시나리오:
 *   BASE         closeLocation >= 0.50 (현재)
 *   LOOSE_45     closeLocation >= 0.45
 *   LOOSE_40     closeLocation >= 0.40
 *   OBSERVE_QVA  정식 0.50 유지 + 0.40~0.50 OBSERVE_QVA + <0.40 WEAK_CLOSE_VALUE_SPIKE
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

const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

// ─── 통계 헬퍼 ─────────────────────────────────
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function rate(num, denom) { return denom > 0 ? round2(num / denom * 100) : null; }
function round2(v) { return v == null || !Number.isFinite(v) ? null : parseFloat(v.toFixed(2)); }

function computeForwards(rows, entryIdx, entryPrice, horizons) {
  const out = { d: {} };
  for (const h of horizons) {
    const idx = entryIdx + h;
    out.d[h] = idx < rows.length && entryPrice > 0 ? (rows[idx].close / entryPrice - 1) * 100 : null;
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

// ─── 7개 종목 케이스 검증 (디버그) ─────────────
console.log('\n' + '═'.repeat(96));
console.log('🔍 7개 종목 케이스 검증 — 각 시나리오 분류 결과');
console.log('═'.repeat(96));

const cases = [
  { code: '018880', date: '20260417', name: '한온시스템 4/17' },
  { code: '018880', date: '20260421', name: '한온시스템 4/21' },
  { code: '097870', date: '20260430', name: '효성오앤비 4/30' },
  { code: '082800', date: '20260430', name: '비보존 제약 4/30' },
  { code: '214320', date: '20260410', name: '이노션 4/10' },
  { code: '464490', date: '20260427', name: '쿼드메디슨 4/27' },
  { code: '002100', date: '20260430', name: '경농 4/30' },
];

function classify(rBase, sigBase, today, prev) {
  // closeLocation 0.40으로 평가하면 valueBreak/volumeBreak/lowZone/notExtended 다 충족 + closeLocation 0.40 이상이면 OBSERVE 후보
  const closeLoc = sigBase?.closeLocation;
  const valueBreak = (sigBase?.valueRatioMedian >= 3.0) || (sigBase?.valueRatioMax >= 1.1);
  const volumeBreak = sigBase?.volumeRatioMedian >= 2.0;
  const closeOk = today.close >= prev.close * 0.99;
  if (rBase.passed) return 'QVA (정식)';
  if (valueBreak && volumeBreak && closeLoc >= 0.40 && closeLoc < 0.50 && closeOk) {
    // 다른 사유로 reject 되었는지도 봐야 함 — closeLocation 외 다른 이유로 reject되면 OBSERVE 자격 없음
    const onlyCloseReject = (rBase.excludeReasons || []).every(r =>
      r.includes('종가 위치 저가권') || r.includes('윗꼬리 과다')
    );
    if (onlyCloseReject) return 'OBSERVE_QVA';
  }
  if (valueBreak && volumeBreak) {
    if (closeLoc < 0.40 || today.close < prev.close * 0.99) return 'WEAK_CLOSE_VALUE_SPIKE';
  }
  return 'REJECT (기타)';
}

const cls45 = (code, date) => {
  const meta = codeMeta.get(code);
  const chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, code + '.json'), 'utf-8'));
  const idx = chart.rows.findIndex(r => r.date === date);
  if (idx < 0) return null;
  const sl = chart.rows.slice(0, idx + 1);
  return ps.calculateRedefinedQVA(sl, [], meta, { closeLocationMin: 0.45 });
};
const cls40 = (code, date) => {
  const meta = codeMeta.get(code);
  const chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, code + '.json'), 'utf-8'));
  const idx = chart.rows.findIndex(r => r.date === date);
  if (idx < 0) return null;
  const sl = chart.rows.slice(0, idx + 1);
  return ps.calculateRedefinedQVA(sl, [], meta, { closeLocationMin: 0.40 });
};

console.log('\n  종목                BASE(0.50)    LOOSE_45      LOOSE_40      OBSERVE 분류');
console.log('  ' + '─'.repeat(94));
for (const c of cases) {
  const meta = codeMeta.get(c.code);
  const chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, c.code + '.json'), 'utf-8'));
  const idx = chart.rows.findIndex(r => r.date === c.date);
  if (idx < 0) {
    console.log('  ' + c.name.padEnd(20) + ' (date 없음)');
    continue;
  }
  const sl = chart.rows.slice(0, idx + 1);
  const today = chart.rows[idx];
  const prev = chart.rows[idx - 1];
  const rBase = ps.calculateRedefinedQVA(sl, [], meta);
  const r45 = ps.calculateRedefinedQVA(sl, [], meta, { closeLocationMin: 0.45 });
  const r40 = ps.calculateRedefinedQVA(sl, [], meta, { closeLocationMin: 0.40 });
  const observeClass = classify(rBase, rBase?.signals, today, prev);
  const closeLoc = rBase?.signals?.closeLocation;
  const fmt = r => r?.passed ? '✅ PASS(' + r.score + ')' : '❌ REJECT';
  console.log('  ' + c.name.padEnd(20) +
    fmt(rBase).padEnd(14) +
    fmt(r45).padEnd(14) +
    fmt(r40).padEnd(14) +
    observeClass + '  (closeLoc ' + (closeLoc * 100).toFixed(0) + '%)');
}

// ─── 1년 백테스트 ─────────────────────────────
console.log('\n' + '═'.repeat(96));
console.log('📊 1년 백테스트 (2025-04-01 ~ 2026-04-24)');
console.log('═'.repeat(96));

const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));

function scan(scenarioName, overrides, classifierFn) {
  const t0 = Date.now();
  const events = []; // { code, name, date, idx, score, type, fwd, fwdAtVvi, isVvi, isHg, signals }
  let vviCount = 0, hgCount = 0;
  const typeCount = { QVA: 0, OBSERVE: 0, WEAK_CLOSE: 0 };

  for (let fi = 0; fi < files.length; fi++) {
    if (fi % 500 === 0) process.stdout.write('  [' + scenarioName + '] ' + fi + '/' + files.length + '\r');
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

    let lastIdx = -MERGE - 1;
    for (let t = 60; t < rows.length - Math.max(...FORWARD_HORIZONS); t++) {
      const today = rows[t];
      if (today.date < SCAN_START || today.date > SCAN_END) continue;
      const sliced = rows.slice(0, t + 1);
      const prev = rows[t - 1];

      // classifierFn returns { type, signals } or null
      const classification = classifierFn(sliced, namedMeta, today, prev);
      if (!classification) continue;

      // episode merge per stock
      if (t - lastIdx <= MERGE) { lastIdx = t; continue; }
      lastIdx = t;
      typeCount[classification.type] = (typeCount[classification.type] || 0) + 1;

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
      const isVvi = vviIdx != null;
      let isHg = false;
      if (isVvi && vviIdx + 1 < rows.length) {
        const v = rows[vviIdx], n = rows[vviIdx + 1];
        if (n.high >= v.high * 1.01 && n.close >= v.high) isHg = true;
      }
      if (isVvi) vviCount++;
      if (isHg) hgCount++;

      events.push({
        code, name: chart.name || meta.name, date: today.date,
        d5: fwd.d[5], d10: fwd.d[10], d20: fwd.d[20],
        mfe20: fwd.mfe20, mae20: fwd.mae20,
        isVvi, isHg, type: classification.type,
      });
    }
  }
  process.stdout.write('  [' + scenarioName + '] ' + files.length + '/' + files.length + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + 's, ' + events.length + ' signals)\n');

  function calcMetrics(items) {
    const N = items.length;
    if (N === 0) return null;
    const uniq = new Set(items.map(e => e.code)).size;
    function calcRet(key) {
      const arr = items.map(e => e[key]).filter(v => v != null && Number.isFinite(v));
      if (arr.length === 0) return null;
      return {
        n: arr.length,
        winRate: round2(arr.filter(v => v > 0).length / arr.length * 100),
        mean: round2(mean(arr)),
        median: round2(median(arr)),
      };
    }
    const d20 = items.map(e => e.d20).filter(v => v != null && Number.isFinite(v));
    return {
      n: N,
      uniqueStocks: uniq,
      dailyAvg: round2(N / 240),
      d5: calcRet('d5'), d10: calcRet('d10'), d20: calcRet('d20'),
      win10pct20: round2(d20.filter(v => v >= 10).length / Math.max(d20.length, 1) * 100),
      win20pct20: round2(d20.filter(v => v >= 20).length / Math.max(d20.length, 1) * 100),
      loss10pct20: round2(d20.filter(v => v <= -10).length / Math.max(d20.length, 1) * 100),
      avgMfe20: round2(mean(items.map(e => e.mfe20).filter(v => v != null))),
      avgMae20: round2(mean(items.map(e => e.mae20).filter(v => v != null))),
      vviRate: rate(items.filter(e => e.isVvi).length, N),
      hgRate: rate(items.filter(e => e.isHg).length, N),
    };
  }

  return {
    scenario: scenarioName,
    typeCount,
    overall: calcMetrics(events),
    byType: {
      QVA: calcMetrics(events.filter(e => e.type === 'QVA')),
      OBSERVE: calcMetrics(events.filter(e => e.type === 'OBSERVE')),
      WEAK_CLOSE: calcMetrics(events.filter(e => e.type === 'WEAK_CLOSE')),
    },
  };
}

// 분류기 정의
function classifierStrict(min) {
  return (sliced, meta, today, prev) => {
    const r = ps.calculateRedefinedQVA(sliced, [], meta, { closeLocationMin: min });
    if (!r?.passed) return null;
    return { type: 'QVA' };
  };
}
function classifierObserve(sliced, meta, today, prev) {
  // 정식 QVA: closeLocation 0.50
  const rStrict = ps.calculateRedefinedQVA(sliced, [], meta, { closeLocationMin: 0.50 });
  if (rStrict?.passed) return { type: 'QVA' };
  // OBSERVE: closeLocation 0.40 + reject 사유가 closeLocation/윗꼬리 한정
  const r40 = ps.calculateRedefinedQVA(sliced, [], meta, { closeLocationMin: 0.40 });
  if (r40?.passed) {
    // 0.40 통과지만 0.50 미달 = closeLocation 40~50 구간
    return { type: 'OBSERVE' };
  }
  // WEAK_CLOSE: valueBreak ✅ + volumeBreak ✅ + (closeLoc < 0.40 OR close < prev × 0.99)
  const s = rStrict?.signals || {};
  if (!s.valueRatioMedian) return null; // 데이터 부족
  const valueBreak = (s.valueRatioMedian >= 3.0) || (s.valueRatioMax >= 1.1);
  const volumeBreak = s.volumeRatioMedian >= 2.0;
  if (!valueBreak || !volumeBreak) return null;
  // lowZone/notExtended 필수 (그 외 사유로 reject된 종목은 WEAK_CLOSE 자격 없음)
  const reasons = rStrict?.excludeReasons || [];
  const hasLowZoneFail = reasons.some(r => r.includes('저점 대비 상승폭 초과') || r.includes('상승률 초과'));
  const hasOtherFail = reasons.some(r => r.includes('과거 급등') || r.includes('MA60 대비') || r.includes('저점 안정 미충족'));
  if (hasLowZoneFail || hasOtherFail) return null;
  return { type: 'WEAK_CLOSE' };
}

const results = {};
results.BASE = scan('BASE', { closeLocationMin: 0.50 }, classifierStrict(0.50));
results.LOOSE_45 = scan('LOOSE_45', { closeLocationMin: 0.45 }, classifierStrict(0.45));
results.LOOSE_40 = scan('LOOSE_40', { closeLocationMin: 0.40 }, classifierStrict(0.40));
results.OBSERVE = scan('OBSERVE', null, classifierObserve);

// 출력
function printRow(name, m) {
  if (!m) { console.log(name.padEnd(28) + '(no data)'); return; }
  console.log(
    name.padEnd(28) +
    String(m.n).padStart(5) + ' ' +
    String(m.uniqueStocks).padStart(6) + ' ' +
    String(m.dailyAvg ?? '-').padStart(5) + ' ' +
    String(m.d5?.winRate ?? '-').padStart(6) + ' ' +
    String(m.d5?.mean ?? '-').padStart(6) + ' ' +
    String(m.d10?.winRate ?? '-').padStart(6) + ' ' +
    String(m.d10?.mean ?? '-').padStart(6) + ' ' +
    String(m.d20?.winRate ?? '-').padStart(6) + ' ' +
    String(m.d20?.mean ?? '-').padStart(6) + ' ' +
    String(m.d20?.median ?? '-').padStart(6) + ' ' +
    String(m.win10pct20 ?? '-').padStart(5) + ' ' +
    String(m.win20pct20 ?? '-').padStart(5) + ' ' +
    String(m.loss10pct20 ?? '-').padStart(5) + ' ' +
    String(m.avgMfe20 ?? '-').padStart(6) + ' ' +
    String(m.avgMae20 ?? '-').padStart(6) + ' ' +
    String(m.vviRate ?? '-').padStart(5) + ' ' +
    String(m.hgRate ?? '-').padStart(5)
  );
}

console.log('\n' + '═'.repeat(150));
console.log('전체 시나리오 비교 (overall)');
console.log('-'.repeat(150));
console.log('Scenario                       N   Stocks Daily  D5+%   D5avg  D10+%  D10avg D20+%  D20avg D20med +10%↑ +20%↑ -10%↓  MFE20  MAE20  VVI%   HG%');
console.log('-'.repeat(150));
printRow('BASE (0.50)', results.BASE.overall);
printRow('LOOSE_45 (0.45)', results.LOOSE_45.overall);
printRow('LOOSE_40 (0.40)', results.LOOSE_40.overall);
printRow('OBSERVE 전체 (모든 type)', results.OBSERVE.overall);
console.log('-'.repeat(150));
printRow('  └ OBSERVE: QVA만', results.OBSERVE.byType.QVA);
printRow('  └ OBSERVE: OBSERVE만', results.OBSERVE.byType.OBSERVE);
printRow('  └ OBSERVE: WEAK_CLOSE만', results.OBSERVE.byType.WEAK_CLOSE);

console.log('\n📊 type 분포 (OBSERVE 시나리오):');
for (const [k, v] of Object.entries(results.OBSERVE.typeCount)) {
  if (v > 0) console.log('  ' + k + ': ' + v + '건');
}

const out = path.join(ROOT, 'qva-closeloc-compare.json');
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log('\n✅ JSON 저장: ' + out);
