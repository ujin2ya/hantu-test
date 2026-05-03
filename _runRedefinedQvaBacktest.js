/**
 * 새 QVA 정의(저점권 거래대금 돌파) — 1년 백테스트 비교
 *
 * 비교 대상:
 *   1. D_AN              — 현재 default Early QVA (D안)
 *   2. REDEFINED         — 새 정의 QVA (저점권 거래대금 돌파)
 *   3. REDEFINED_TIGHT   — closeLocation 0.50 + median value break ×3.0
 *   4. REDEFINED_TIGHT2  — TIGHT + upperWickRatio ≤ 0.52
 *
 * 비교 지표:
 *   신호 수 / 고유 종목 수 / 하루 평균 후보 수
 *   D+5/D+10/D+20 플러스 마감 비율 / 평균 / 중앙값
 *   20일 안 +10%/+20% 도달, -10% 하락
 *   VVI 전환률, H그룹 전환률
 *   D안과의 신호 시점 비교 (몇 일 빠른지)
 *   이노션 4/10 통과 여부
 *
 * 결과: 콘솔 + redefined-qva-backtest.json
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
const QVA_TRACKING_DAYS = 20;
const FORWARD_HORIZONS = [5, 10, 20];
const QVA_MERGE_WINDOW = 10;

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

// 시나리오 정의 ─────────────────────────────────
const D_AN_OVERRIDES = {}; // 현재 default Early QVA
const REDEFINED_OVERRIDES = {}; // 기본 새 정의
const REDEFINED_TIGHT_OVERRIDES = {
  closeLocationMin: 0.50,
  valueBreakMedianMul: 3.0,
};
const REDEFINED_TIGHT2_OVERRIDES = {
  closeLocationMin: 0.50,
  valueBreakMedianMul: 3.0,
  upperWickRatioMax: 0.52,
};

// 통계 헬퍼 ─────────────────────────────────────
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

function dateBetween(d, start, end) {
  return d >= start && d <= end;
}

// scenarioName === 'REDEFINED' 이면 calculateRedefinedQVA, 아니면 calculateEarlyQVA(overrides)
function runScenario(scenarioName, overrides) {
  const startTime = Date.now();
  const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
  const codeMeta = new Map();
  for (const s of stocksList.stocks) codeMeta.set(s.code, s);

  const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));
  const earlyEntries = [];
  let totalRaw = 0;
  let inocheck = null;

  // 같은 종목 episode merge용 — (code → first signal info)
  // 추가로 새 모델 신호의 시점이 D안 신호보다 며칠 빠른지 비교용 — 같은 종목/같은 episode에서
  // D안 / REDEFINED 둘 다 잡는 경우만 비교 (caller가 둘을 모두 호출 후 외부에서 비교)
  const firstSignalsByCode = new Map(); // code → [{date, idx}, ...]

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

    // 이노션 4/10 별도 체크 (forward window 부족해도 무관)
    if (code === '214320') {
      const inoIdx = rows.findIndex(r => r.date === '20260410');
      if (inoIdx >= 0) {
        const slicedIno = rows.slice(0, inoIdx + 1);
        let resIno = null;
        try {
          if (scenarioName.startsWith('REDEFINED')) resIno = ps.calculateRedefinedQVA(slicedIno, [], namedMeta, overrides);
          else resIno = ps.calculateEarlyQVA(slicedIno, [], namedMeta, overrides);
        } catch (_) {}
        inocheck = {
          passed: !!resIno?.passed,
          score: resIno?.score || 0,
          excludeReasons: resIno?.excludeReasons || [],
          signals: resIno?.signals,
        };
      }
    }

    let lastPassIdx = -10;
    const stockEpisodes = [];
    for (let t = 60; t < rows.length - Math.max(...FORWARD_HORIZONS); t++) {
      const today = rows[t];
      if (!dateBetween(today.date, SCAN_START, SCAN_END)) continue;

      const sliced = rows.slice(0, t + 1);
      let res = null;
      try {
        if (scenarioName.startsWith('REDEFINED')) {
          res = ps.calculateRedefinedQVA(sliced, [], namedMeta, overrides);
        } else {
          res = ps.calculateEarlyQVA(sliced, [], namedMeta, overrides);
        }
      } catch (_) {}

      if (!res?.passed) continue;
      totalRaw++;

      if (t - lastPassIdx <= QVA_MERGE_WINDOW) { lastPassIdx = t; continue; }
      lastPassIdx = t;

      const buyPrice = today.close;
      const f = computeForwards(rows, t, buyPrice, FORWARD_HORIZONS);

      // VVI / H그룹 검사 (단순화: VVI를 보고 다음날 1% 돌파 + 종가 유지)
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

      const entry = {
        code, name: chart.name || meta.name,
        date: today.date, idx: t, score: res.score,
        d: { 5: f.d[5], 10: f.d[10], 20: f.d[20] },
        mfe20: f.mfe20, mae20: f.mae20,
        vviHit, hHit,
      };
      earlyEntries.push(entry);
      stockEpisodes.push(entry);
    }
    if (stockEpisodes.length > 0) firstSignalsByCode.set(code, stockEpisodes);
  }
  process.stdout.write(`  [${scenarioName}] ${files.length}/${files.length} (${((Date.now() - startTime) / 1000).toFixed(0)}s)\n`);

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

  // 영업일 추정 — 1년 백테스트 영업일 ≈ 240
  const tradingDays = 240;
  const dailyAvg = round2(N / tradingDays);

  return {
    scenario: scenarioName,
    overrides,
    rawCount: totalRaw,
    dedupCount: N,
    uniqueStocks: uniq,
    dailyAvgCandidates: dailyAvg,
    d5: calcRet(5), d10: calcRet(10), d20: calcRet(20),
    avgMfe20: round2(mean(earlyEntries.map(e => e.mfe20).filter(v => v != null))),
    avgMae20: round2(mean(earlyEntries.map(e => e.mae20).filter(v => v != null))),
    vviRate: rate(earlyEntries.filter(e => e.vviHit).length, N),
    hRate: rate(earlyEntries.filter(e => e.hHit).length, N),
    inoCheck: inocheck,
    _firstSignalsByCode: firstSignalsByCode, // private — for cross-scenario timing comparison
  };
}

// 메인 ─────────────────────────────────────────
console.log(`\n📊 새 QVA(저점권 거래대금 돌파) 1년 백테스트 — ${SCAN_START} ~ ${SCAN_END}\n`);

const results = {};
results.D_AN = runScenario('D_AN', D_AN_OVERRIDES);
results.REDEFINED = runScenario('REDEFINED', REDEFINED_OVERRIDES);
results.REDEFINED_TIGHT = runScenario('REDEFINED_TIGHT', REDEFINED_TIGHT_OVERRIDES);
results.REDEFINED_TIGHT2 = runScenario('REDEFINED_TIGHT2', REDEFINED_TIGHT2_OVERRIDES);

// 표 출력
console.log(`\n${'='.repeat(150)}`);
console.log('Scenario          Raw    Dedup  Stocks  Daily  D5+%   D5avg  D10+%  D10avg D20+%  D20avg D20med +10%↑  +20%↑  -10%↓  MFE20   MAE20   VVI%   H%');
console.log('-'.repeat(150));
for (const name of ['D_AN', 'REDEFINED', 'REDEFINED_TIGHT', 'REDEFINED_TIGHT2']) {
  const r = results[name];
  console.log(
    name.padEnd(18) +
    String(r.rawCount).padStart(6) + ' ' +
    String(r.dedupCount).padStart(6) + ' ' +
    String(r.uniqueStocks).padStart(7) + ' ' +
    String(r.dailyAvgCandidates ?? '-').padStart(6) + ' ' +
    String(r.d5?.winRate ?? '-').padStart(6) + ' ' +
    String(r.d5?.mean ?? '-').padStart(6) + ' ' +
    String(r.d10?.winRate ?? '-').padStart(6) + ' ' +
    String(r.d10?.mean ?? '-').padStart(6) + ' ' +
    String(r.d20?.winRate ?? '-').padStart(6) + ' ' +
    String(r.d20?.mean ?? '-').padStart(6) + ' ' +
    String(r.d20?.median ?? '-').padStart(6) + ' ' +
    String(r.d20?.win10pct ?? '-').padStart(6) + ' ' +
    String(r.d20?.win20pct ?? '-').padStart(6) + ' ' +
    String(r.d20?.loss10pct ?? '-').padStart(6) + ' ' +
    String(r.avgMfe20 ?? '-').padStart(7) + ' ' +
    String(r.avgMae20 ?? '-').padStart(7) + ' ' +
    String(r.vviRate ?? '-').padStart(6) + ' ' +
    String(r.hRate ?? '-').padStart(6)
  );
}

// REDEFINED_TIGHT vs D_AN — 동일 종목/episode에서 신호 시점 비교
console.log(`\n${'─'.repeat(70)}`);
console.log('🕒 REDEFINED_TIGHT vs D_AN — 같은 종목 같은 episode 신호 시점 차이');
console.log('─'.repeat(70));
const redByCode = results.REDEFINED_TIGHT._firstSignalsByCode;
const danByCode = results.D_AN._firstSignalsByCode;
const sharedCodes = [...redByCode.keys()].filter(c => danByCode.has(c));
const diffs = [];
for (const code of sharedCodes) {
  const reds = redByCode.get(code);
  const dans = danByCode.get(code);
  // 가장 가까운 짝 매칭 (10일 이내)
  for (const r of reds) {
    let bestDan = null, bestDiff = Infinity;
    for (const d of dans) {
      const diff = Math.abs(r.idx - d.idx);
      if (diff <= 15 && diff < bestDiff) { bestDan = d; bestDiff = diff; }
    }
    if (bestDan) diffs.push(r.idx - bestDan.idx); // 음수 = REDEFINED가 더 빠름
  }
}
if (diffs.length > 0) {
  const avgDiff = mean(diffs);
  const medDiff = median(diffs);
  const fasterCnt = diffs.filter(d => d < 0).length;
  const samerCnt = diffs.filter(d => d === 0).length;
  const slowerCnt = diffs.filter(d => d > 0).length;
  console.log(`  공유 episode 수: ${diffs.length}`);
  console.log(`  평균 시점 차이(REDEFINED - D_AN): ${avgDiff.toFixed(2)}일  (음수=REDEFINED가 빠름)`);
  console.log(`  중앙값: ${medDiff}일`);
  console.log(`  REDEFINED 더 빠름: ${fasterCnt} (${(fasterCnt / diffs.length * 100).toFixed(1)}%)`);
  console.log(`  같은 날: ${samerCnt} (${(samerCnt / diffs.length * 100).toFixed(1)}%)`);
  console.log(`  D_AN이 더 빠름: ${slowerCnt} (${(slowerCnt / diffs.length * 100).toFixed(1)}%)`);
} else {
  console.log('  공유 episode 없음');
}

console.log(`\n📍 이노션 214320 2026-04-10 통과 여부:`);
for (const name of ['D_AN', 'REDEFINED', 'REDEFINED_TIGHT', 'REDEFINED_TIGHT2']) {
  const i = results[name].inoCheck;
  if (!i) { console.log(`  ${name.padEnd(18)}: 데이터 없음`); continue; }
  console.log(`  ${name.padEnd(18)}: ${i.passed ? '✅ passed' : '❌ rejected'} (score ${i.score})`);
  if (!i.passed && i.excludeReasons?.length > 0) {
    console.log(`    사유: ${i.excludeReasons.slice(0, 3).join(' / ')}`);
  }
}

// 옵션 C 선택 기준 자동 판정
console.log(`\n${'═'.repeat(70)}`);
console.log('🎯 옵션 C 선택 기준 자동 판정');
console.log('═'.repeat(70));
console.log('  기준: 이노션 4/10 통과 / D+20 평균 ≥ D_AN / D+20 win% ≥ 58 / 중앙값 ≥ 2.5 / -10% ≤ 12 / 하루 평균 후보 합리적');
const danMean = results.D_AN.d20?.mean;
for (const name of ['REDEFINED', 'REDEFINED_TIGHT', 'REDEFINED_TIGHT2']) {
  const r = results[name];
  const ino = r.inoCheck?.passed === true;
  const meanGE = r.d20?.mean != null && danMean != null && r.d20.mean >= danMean - 0.5;
  const winGE = r.d20?.winRate != null && r.d20.winRate >= 58;
  const medGE = r.d20?.median != null && r.d20.median >= 2.5;
  const lossOK = r.d20?.loss10pct != null && r.d20.loss10pct <= 12;
  const checks = [
    `이노션통과 ${ino ? '✅' : '❌'}`,
    `D20avg≥D_AN-0.5 ${meanGE ? '✅' : '❌'}(${r.d20?.mean})`,
    `D20+%≥58 ${winGE ? '✅' : '❌'}(${r.d20?.winRate})`,
    `중앙값≥2.5 ${medGE ? '✅' : '❌'}(${r.d20?.median})`,
    `-10%↓≤12 ${lossOK ? '✅' : '❌'}(${r.d20?.loss10pct})`,
    `하루평균 ${r.dailyAvgCandidates}`,
  ];
  console.log(`  ${name.padEnd(18)}: ${checks.join(' / ')}`);
}

// JSON 저장 (firstSignalsByCode는 너무 커서 제외)
const outPath = path.join(ROOT, 'redefined-qva-backtest.json');
const cleanResults = {};
for (const name of ['D_AN', 'REDEFINED', 'REDEFINED_TIGHT', 'REDEFINED_TIGHT2']) {
  const { _firstSignalsByCode, ...rest } = results[name];
  cleanResults[name] = rest;
}
fs.writeFileSync(outPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  scanStart: SCAN_START, scanEnd: SCAN_END,
  scenarios: cleanResults,
}, null, 2));
console.log(`\n✅ JSON 저장: ${outPath}`);
