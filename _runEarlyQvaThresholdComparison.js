/**
 * Early QVA threshold 완화안 비교 — strict / A / B / C / D
 *
 * 사용자 spec 3안 (A/B/C) + 분석 결과 추가한 D안 (이노션 4/10 케이스 잡기 위한 ceiling 완화).
 * 1년치 백테스트로 신호 수 / 플러스 마감 비율 / VVI/H 전환률 / 4월 이노션 통과 여부 비교.
 *
 * 결과는 콘솔 출력 + JSON 저장.
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
const SCAN_END = '20260319';
const QVA_TRACKING_DAYS = 20;
const FORWARD_HORIZONS = [5, 10, 20];
const QVA_MERGE_WINDOW = 10;

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

// ─── 4개 안의 threshold overrides ───
const SCENARIOS = {
  STRICT: {}, // default
  A_VOLUME_RELAX: {
    tv3RatioMin: 1.3,
    tv5RatioMin: 1.15,
  },
  B_REBOUND_RELAX: {
    ret5Max: 12,
    maxDailyClose5Max: 10,
    maxDailyHigh5Max: 13,
  },
  C_MIXED_RELAX: {
    tv3RatioMin: 1.35,
    tv5RatioMin: 1.15,
    ret5Max: 10,
    maxDailyClose5Max: 9,
    closeLocationMin: 0.50,
  },
  D_CEILING_RELAX: {
    // 디버그에서 발견: 4/10 이노션은 tv3=4.81 (ceiling 3.0 초과)로 탈락
    // ceiling을 4.5로 완화 + lowStabilized 조건도 OR로 완화 (lowStab=N에서도 higherLow면 OK)
    tv3RatioMax: 4.5,
    tv5RatioMax: 4.0,
    requireLowStabilizedAndOther: false, // OR 조건으로 완화
  },
};

// ─── 통계 헬퍼 ───
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

// 한 시나리오 실행
function runScenario(scenarioName, overrides) {
  const startTime = Date.now();
  const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
  const codeMeta = new Map();
  for (const s of stocksList.stocks) codeMeta.set(s.code, s);

  const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));

  // (code, qvaDate) dedup — 같은 episode 안에서 첫 신호만 채용
  const earlyEntries = [];
  let totalRaw = 0;
  // 이노션 4/10 통과 여부 추적
  let inocheck = null;

  for (let fi = 0; fi < files.length; fi++) {
    if (fi % 500 === 0) process.stdout.write(`  [${scenarioName}] ${fi}/${files.length}\r`);
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

    // 이 종목의 episode firstSignalDate 모음 (merge window 적용)
    let lastPassIdx = -10;
    for (let t = 60; t < rows.length - Math.max(...FORWARD_HORIZONS); t++) {
      const today = rows[t];
      if (today.date < SCAN_START || today.date > SCAN_END) continue;

      const sliced = rows.slice(0, t + 1);
      let res = null;
      try { res = ps.calculateEarlyQVA(sliced, [], namedMeta, overrides); } catch (_) {}

      // 이노션(214320) 4/10 (20260410) 통과 체크
      if (code === '214320' && today.date === '20260410') {
        inocheck = {
          passed: !!res?.passed,
          score: res?.score || 0,
          excludeReasons: res?.excludeReasons || [],
          signals: res?.signals,
        };
      }

      if (!res?.passed) continue;
      totalRaw++;

      // episode merge: 이전 통과로부터 10일 이내면 같은 episode → 첫 신호만 사용
      if (t - lastPassIdx <= QVA_MERGE_WINDOW) { lastPassIdx = t; continue; }
      lastPassIdx = t;

      const buyPrice = today.close;
      const f = computeForwards(rows, t, buyPrice, FORWARD_HORIZONS);

      // VVI / H그룹 진행 검사 (단순화: VVI 만)
      let vviHit = false, hHit = false;
      const maxLook = Math.min(QVA_TRACKING_DAYS, rows.length - 1 - t);
      for (let k = 1; k <= maxLook; k++) {
        const candIdx = t + k;
        const candDate = rows[candIdx].date;
        const slC = rows.slice(0, candIdx + 1);
        const slF = flowRows.filter(r => r.date <= candDate);
        if (slF.length < 10) continue;
        let vvi = null;
        try { vvi = ps.calculateVolumeValueIgnition(slC, slF, namedMeta); } catch (_) {}
        if (vvi?.passed) {
          vviHit = true;
          if (candIdx + 1 < rows.length) {
            const vR = rows[candIdx], nR = rows[candIdx + 1];
            const triggered1Pct = nR.high >= vR.high * 1.01;
            const breakoutFail = nR.close < vR.high;
            if (triggered1Pct && !breakoutFail) hHit = true;
          }
          break;
        }
      }

      earlyEntries.push({
        code, name: chart.name || meta.name,
        date: today.date, score: res.score,
        d: { 5: f.d[5], 10: f.d[10], 20: f.d[20] },
        mfe20: f.mfe20, mae20: f.mae20,
        vviHit, hHit,
      });
    }
  }
  process.stdout.write(`  [${scenarioName}] ${files.length}/${files.length} (${((Date.now() - startTime) / 1000).toFixed(0)}s)\n`);

  // 통계 집계
  const N = earlyEntries.length;
  const uniq = new Set(earlyEntries.map(e => e.code)).size;
  function calcRet(key) {
    const arr = earlyEntries.map(e => e.d[key]).filter(v => v != null && Number.isFinite(v));
    if (arr.length === 0) return null;
    return {
      n: arr.length,
      winRate: round2(arr.filter(v => v > 0).length / arr.length * 100),
      mean: round2(mean(arr)),
      median: round2(median(arr)),
      win10pct: round2(arr.filter(v => v >= 10).length / arr.length * 100),
      win20pct: round2(arr.filter(v => v >= 20).length / arr.length * 100),
      loss10pct: round2(arr.filter(v => v <= -10).length / arr.length * 100),
    };
  }
  const vviCnt = earlyEntries.filter(e => e.vviHit).length;
  const hCnt = earlyEntries.filter(e => e.hHit).length;
  return {
    scenario: scenarioName,
    overrides,
    rawCount: totalRaw,
    dedupCount: N,
    uniqueStocks: uniq,
    d5: calcRet(5), d10: calcRet(10), d20: calcRet(20),
    avgMfe20: round2(mean(earlyEntries.map(e => e.mfe20).filter(v => v != null))),
    avgMae20: round2(mean(earlyEntries.map(e => e.mae20).filter(v => v != null))),
    vviRate: rate(vviCnt, N),
    hRate: rate(hCnt, N),
    inoCheck: inocheck,
  };
}

// ─── 메인 ───
console.log(`\n📊 Early QVA threshold 완화안 비교 — ${SCAN_START} ~ ${SCAN_END}\n`);
const results = {};
for (const [name, ov] of Object.entries(SCENARIOS)) {
  results[name] = runScenario(name, ov);
}

// 출력
console.log(`\n${'='.repeat(140)}`);
console.log(`Scenario       Raw    Dedup  Stocks  D5+%   D5avg   D10+%  D10avg  D20+%  D20avg  D20med  +10%↑  +20%↑  -10%↓  MFE20   MAE20   VVI%    H%`);
console.log('-'.repeat(140));
for (const [name, r] of Object.entries(results)) {
  console.log(
    name.padEnd(15) +
    String(r.rawCount).padStart(6) + ' ' +
    String(r.dedupCount).padStart(6) + ' ' +
    String(r.uniqueStocks).padStart(7) + ' ' +
    String(r.d5?.winRate ?? '-').padStart(6) + ' ' +
    String(r.d5?.mean ?? '-').padStart(7) + ' ' +
    String(r.d10?.winRate ?? '-').padStart(6) + ' ' +
    String(r.d10?.mean ?? '-').padStart(7) + ' ' +
    String(r.d20?.winRate ?? '-').padStart(6) + ' ' +
    String(r.d20?.mean ?? '-').padStart(7) + ' ' +
    String(r.d20?.median ?? '-').padStart(7) + ' ' +
    String(r.d20?.win10pct ?? '-').padStart(6) + ' ' +
    String(r.d20?.win20pct ?? '-').padStart(6) + ' ' +
    String(r.d20?.loss10pct ?? '-').padStart(6) + ' ' +
    String(r.avgMfe20 ?? '-').padStart(7) + ' ' +
    String(r.avgMae20 ?? '-').padStart(7) + ' ' +
    String(r.vviRate ?? '-').padStart(6) + ' ' +
    String(r.hRate ?? '-').padStart(6)
  );
}

console.log(`\n📍 이노션 214320 2026-04-10 통과 여부:`);
for (const [name, r] of Object.entries(results)) {
  const i = r.inoCheck;
  if (!i) { console.log(`  ${name}: 데이터 없음`); continue; }
  console.log(`  ${name}: ${i.passed ? '✅ passed' : '❌ rejected'} (score ${i.score})`);
  if (!i.passed && i.excludeReasons?.length > 0) {
    console.log(`    사유: ${i.excludeReasons.slice(0, 3).join(' / ')}`);
  }
}

const outPath = path.join(ROOT, 'early-qva-threshold-comparison.json');
fs.writeFileSync(outPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  scanStart: SCAN_START, scanEnd: SCAN_END,
  scenarios: results,
}, null, 2));
console.log(`\n✅ JSON 저장: ${outPath}`);
