/**
 * QVA 일별 신규 후보 수 분포 — 1년치 (FILTER_C30 default)
 *
 * 목적: 매일 운영 보드의 "오늘 신규 QVA" 카운트가 평균/중앙값/최대 어느 수준인지
 *       확인. 어느 날 0건/소수가 나와도 정상 범위인지 가늠.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const SCAN_START = '20250401';
const SCAN_END = '20260424';

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));

// date → set of (code with QVA passed at that date)
const dailyPassMap = new Map();

console.log(`\n📊 QVA 일별 신규 후보 수 분포 — ${SCAN_START} ~ ${SCAN_END}\n`);
const t0 = Date.now();

for (let fi = 0; fi < files.length; fi++) {
  if (fi % 500 === 0) process.stdout.write(`  진행 ${fi}/${files.length}\r`);
  const code = files[fi].replace('.json', '');
  const meta = codeMeta.get(code);
  if (!meta) continue;
  if (isExcludedProduct(meta.name)) continue;
  let chart;
  try { chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8')); }
  catch (_) { continue; }
  const rows = chart.rows || [];
  if (rows.length < 65) continue;

  const namedMeta = { ...meta, name: meta.name || chart.name };

  for (let t = 60; t < rows.length; t++) {
    const today = rows[t];
    if (today.date < SCAN_START || today.date > SCAN_END) continue;

    const sliced = rows.slice(0, t + 1);
    let r = null;
    try { r = ps.calculateRedefinedQVA(sliced, [], namedMeta); } catch (_) {}
    if (!r?.passed) continue;

    if (!dailyPassMap.has(today.date)) dailyPassMap.set(today.date, new Set());
    dailyPassMap.get(today.date).add(code);
  }
}
process.stdout.write(`  ${files.length}/${files.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);

// 모든 거래일 수집
const allDates = Array.from(dailyPassMap.keys()).sort();
const dailyCounts = allDates.map(d => ({ date: d, count: dailyPassMap.get(d).size }));

// 거래일이 dailyPassMap에 없는 경우 (= 그 날 0건) 도 누락되지 않도록 기준일 보강
// — long cache에서 모든 거래일을 모아서 비어있는 날도 포함
const allTradingDateSet = new Set();
for (const f of files.slice(0, 50)) { // 50개 종목만 sampling — 모든 거래일은 동일
  try {
    const d = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, f), 'utf-8'));
    for (const r of d.rows || []) if (r.date >= SCAN_START && r.date <= SCAN_END) allTradingDateSet.add(r.date);
  } catch (_) {}
}
const allTradingDates = Array.from(allTradingDateSet).sort();
const fullDailyCounts = allTradingDates.map(d => ({ date: d, count: dailyPassMap.get(d)?.size || 0 }));

// 분포
const counts = fullDailyCounts.map(d => d.count);
const sorted = [...counts].sort((a, b) => a - b);
function median(arr) {
  const m = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[m - 1] + arr[m]) / 2 : arr[m];
}
const mean = counts.reduce((s, v) => s + v, 0) / counts.length;
const med = median(sorted);
const max = sorted[sorted.length - 1];
const min = sorted[0];
const zero = counts.filter(c => c === 0).length;
const oneToTwo = counts.filter(c => c >= 1 && c <= 2).length;
const threeToFive = counts.filter(c => c >= 3 && c <= 5).length;
const sixToTen = counts.filter(c => c >= 6 && c <= 10).length;
const overTen = counts.filter(c => c > 10).length;
const totalDays = counts.length;

console.log(`\n${'='.repeat(70)}`);
console.log(`거래일 수:                  ${totalDays}일`);
console.log(`최소:                       ${min}건`);
console.log(`최대:                       ${max}건`);
console.log(`평균:                       ${mean.toFixed(2)}건`);
console.log(`중앙값:                     ${med}건`);
console.log(`총 신호 수:                 ${counts.reduce((s, v) => s + v, 0)}건 (종목 dedup 후)`);
console.log('-'.repeat(70));
console.log(`0건인 날:                   ${zero}일 (${(zero / totalDays * 100).toFixed(1)}%)`);
console.log(`1~2건인 날:                 ${oneToTwo}일 (${(oneToTwo / totalDays * 100).toFixed(1)}%)`);
console.log(`3~5건인 날:                 ${threeToFive}일 (${(threeToFive / totalDays * 100).toFixed(1)}%)`);
console.log(`6~10건인 날:                ${sixToTen}일 (${(sixToTen / totalDays * 100).toFixed(1)}%)`);
console.log(`10건 초과인 날:             ${overTen}일 (${(overTen / totalDays * 100).toFixed(1)}%)`);

// 최근 30거래일 추세
console.log(`\n📅 최근 30거래일 추세:`);
const recent = fullDailyCounts.slice(-30);
recent.forEach(d => {
  const bar = '█'.repeat(Math.min(d.count, 20));
  console.log(`  ${d.date.slice(0,4)}-${d.date.slice(4,6)}-${d.date.slice(6,8)}  ${String(d.count).padStart(3)} ${bar}`);
});

// 4/30 기준 직전 30거래일
const today30Idx = allTradingDates.indexOf('20260430');
if (today30Idx >= 30) {
  const last30 = fullDailyCounts.slice(today30Idx - 29, today30Idx + 1);
  const last30Mean = last30.reduce((s, d) => s + d.count, 0) / last30.length;
  console.log(`\n  ↳ 4/30 직전 30거래일 평균: ${last30Mean.toFixed(2)}건 (정상 범위 가늠)`);
}

const out = {
  generatedAt: new Date().toISOString(),
  scanStart: SCAN_START, scanEnd: SCAN_END,
  totalTradingDays: totalDays,
  totalSignals: counts.reduce((s, v) => s + v, 0),
  distribution: {
    min, max, mean: parseFloat(mean.toFixed(2)), median: med,
    zeroDays: zero, oneToTwoDays: oneToTwo, threeToFiveDays: threeToFive,
    sixToTenDays: sixToTen, overTenDays: overTen,
  },
  daily: fullDailyCounts,
};
fs.writeFileSync(path.join(ROOT, 'qva-daily-distribution.json'), JSON.stringify(out, null, 2));
console.log(`\n✅ JSON 저장: qva-daily-distribution.json`);
