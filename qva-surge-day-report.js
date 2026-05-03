/**
 * QVA 신호 후 20거래일 내 급등일 탐지 보고서
 *
 * 이 보고서는 QVA 신호가 나온 종목들이 신호 후 20거래일 안에 전일 종가 대비
 * 하루 +10%, +15%, +20%, +30% 이상 급등한 적이 있는지 분석한다.
 *
 * QVA는 매수 추천 신호가 아니라, 관심종목에 넣고 추적할 만한 후보를 좁혀주는
 * 선행 감지 모델이다. 따라서 본 보고서의 급등 발생률은 승률이 아니라,
 * QVA 신호 이후 급등 이벤트가 발생한 비율이다.
 *
 * 두 가지 급등 기준:
 *   - 종가 기준 (메인): bestSingleDayCloseReturn = (todayClose - prevClose) / prevClose * 100
 *     실제로 강하게 마감한 급등.
 *   - 고가 기준 (보조): bestSingleDayHighReturn = (todayHigh - prevClose) / prevClose * 100
 *     장중 한 번이라도 강하게 튄 급등.
 *
 * ETF/ETN/레버리지/인버스/선물/TR/H 상품은 별도 목록(excludedProducts)으로 분리한다.
 * 우선주는 분석에 포함하되 isPreferred 플래그로 표시한다.
 */

const fs = require('fs');
const path = require('path');

const LONG_CACHE_DIR = path.join(__dirname, 'cache', 'stock-charts-long');

// ---------- 종목 분류 ----------
const EXCLUDE_KEYWORDS = ["ETN", "ETF", "레버리지", "인버스", "선물", "TR", "H)"];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}
function isPreferredStock(name) {
  if (!name) return false;
  return /우[A-Z]?$/.test(name);
}

// ---------- QVA 신호 검출 (qva-full-month-tracking-report.js와 동일) ----------
function sma(values, period) {
  if (!values || values.length < period) return null;
  const recent = values.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / period;
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function checkQVASignal(chartRows, testDate) {
  const filtered = chartRows.filter(row => row.date <= testDate);
  if (filtered.length < 60) return null;

  const idx = filtered.length - 1;
  const today = filtered[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const last20 = filtered.slice(-20);
  const last5 = filtered.slice(-5);
  const avg20Value = last20.reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = last20.reduce((s, r) => s + (r.volume || 0), 0) / 20;

  if (avg20Value < 1_000_000_000) return null;

  const todayValue = today.valueApprox || today.close * today.volume;
  const valueRatio20 = todayValue / (avg20Value || 1);
  const volumeRatio20 = today.volume / (avg20Vol || 1);

  if (valueRatio20 < 1.5 || volumeRatio20 < 1.5) return null;

  const lows5 = last5.map(r => r.low);
  const lows20to25 = filtered.slice(-25, -5).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;

  if (min5 <= min20) return null;

  const ma20 = sma(last20.map(r => r.close), 20);
  if (ma20 && close < ma20 * 0.95) return null;

  const todayReturn = today.open > 0 ? close / today.open - 1 : 0;
  if (todayReturn > 0.05) return null;

  const ret20d = idx >= 20 ? close / filtered[idx - 20].close - 1 : 0;
  if (ret20d > 0.15) return null;

  const medianVal20 = median(last20.map(r => r.valueApprox || 0));
  const valueMedianRatio = medianVal20 > 0 ? todayValue / medianVal20 : 0;
  if (valueMedianRatio < 1.8) return null;

  const last3 = filtered.slice(-3);
  const hasRecentValueSpike = last3.some(r => {
    const v = r.valueApprox || r.close * r.volume;
    const vRatio = v / (avg20Value || 1);
    const medRatio = medianVal20 > 0 ? v / medianVal20 : 0;
    return vRatio >= 1.5 || medRatio >= 2.0;
  });
  if (!hasRecentValueSpike) return null;

  const last10hl = filtered.slice(-10);
  const high10 = Math.max(...last10hl.map(r => r.high));
  const low10 = Math.min(...last10hl.map(r => r.low));
  const rangeExpansion10 = low10 > 0 ? high10 / low10 - 1 : 0;
  if (rangeExpansion10 < 0.03) return null;

  return true;
}

// ---------- 단일일 급등 분석 ----------
// 신호일 이후 D+1 ~ D+20 사이에서 종가 기준 best day와 고가 기준 best day를
// 독립적으로 추적한다. (서로 다른 날일 수 있다.)
function analyzeSurgeDays(rows, signalRowIdx) {
  const signalRow = rows[signalRowIdx];
  if (!signalRow || signalRow.close <= 0) return null;
  if (signalRowIdx + 20 >= rows.length) return null; // D+20까지 데이터가 있어야 함

  const window = rows.slice(signalRowIdx, signalRowIdx + 21); // [0]=signal, [1..20]=D+1..D+20

  // 신호일 시점의 직전 20일 평균 거래대금 (급등일 거래대금 비교용 베이스라인)
  const preStart = Math.max(0, signalRowIdx - 19);
  const last20BeforeSignal = rows.slice(preStart, signalRowIdx + 1);
  const avg20Value = last20BeforeSignal.reduce(
    (s, r) => s + (r.valueApprox || r.close * r.volume || 0), 0
  ) / last20BeforeSignal.length;

  let bestCloseReturn = -Infinity, bestCloseDay = null;
  let bestHighReturn = -Infinity, bestHighDay = null;

  for (let d = 1; d <= 20; d++) {
    const prev = window[d - 1];
    const today = window[d];
    if (!prev || !today || prev.close <= 0) continue;
    const closeReturn = (today.close / prev.close - 1) * 100;
    const highReturn = today.high > 0 ? (today.high / prev.close - 1) * 100 : closeReturn;
    if (closeReturn > bestCloseReturn) {
      bestCloseReturn = closeReturn;
      bestCloseDay = { d, prev, today };
    }
    if (highReturn > bestHighReturn) {
      bestHighReturn = highReturn;
      bestHighDay = { d, prev, today };
    }
  }
  if (!bestCloseDay) return null;

  // pre-surge MDD: 종가 기준 best day 직전까지의 최저점 → 신호가 대비 최대 하락률
  let preSurgeMinLow = signalRow.close;
  for (let i = 0; i < bestCloseDay.d; i++) {
    const lo = window[i].low;
    if (lo > 0 && lo < preSurgeMinLow) preSurgeMinLow = lo;
  }
  const preSurgeMaxDrop = (preSurgeMinLow / signalRow.close - 1) * 100;

  const surgeValue = bestCloseDay.today.valueApprox || bestCloseDay.today.close * bestCloseDay.today.volume;
  const surgeValueRatio = avg20Value > 0 ? surgeValue / avg20Value : 0;
  const returnFromSignal = (bestCloseDay.today.close / signalRow.close - 1) * 100;

  return {
    signalDate: signalRow.date,
    signalPrice: signalRow.close,

    // 종가 기준 (메인)
    surgeDate: bestCloseDay.today.date,
    daysToSurge: bestCloseDay.d,
    prevClose: bestCloseDay.prev.close,
    surgeClose: bestCloseDay.today.close,
    bestSingleDayCloseReturn: bestCloseReturn,

    // 고가 기준 (보조)
    highSurgeDate: bestHighDay.today.date,
    daysToHighSurge: bestHighDay.d,
    highSurgePrevClose: bestHighDay.prev.close,
    surgeHigh: bestHighDay.today.high,
    bestSingleDayHighReturn: bestHighReturn,

    // 공통
    returnFromSignal,
    surgeValue,
    surgeValueRatio,
    preSurgeMaxDrop,

    // 종가 기준 플래그
    closeSurge10: bestCloseReturn >= 10,
    closeSurge15: bestCloseReturn >= 15,
    closeSurge20: bestCloseReturn >= 20,
    closeSurge30: bestCloseReturn >= 30,

    // 고가 기준 플래그
    highSurge10: bestHighReturn >= 10,
    highSurge15: bestHighReturn >= 15,
    highSurge20: bestHighReturn >= 20,
    highSurge30: bestHighReturn >= 30,
  };
}

function formatDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
}

// ---------- 메인 ----------
const testDates = [
  "20260303", "20260306", "20260309", "20260312", "20260316", "20260319",
  "20260323", "20260326", "20260330", "20260402", "20260406", "20260410",
];
const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith(".json"));

console.log(`\n📊 QVA 신호 후 20거래일 내 급등일 탐지 보고서`);
console.log(`기간: ${formatDate(testDates[0])} ~ ${formatDate(testDates[testDates.length - 1])}`);
console.log(`요청 신호일 ${testDates.length}개 | 추적: D+1 ~ D+20`);
console.log(`급등 기준: 종가 +10%↑ (메인) / 고가 +10%↑ (보조)`);
console.log(`ETF/ETN/레버리지/인버스/선물/TR/H 상품은 분석 제외 목록으로 분리`);
console.log(`※ QVA는 매수 추천 신호가 아닌 추적 후보 모델. 본 수치는 승률이 아닌 급등 이벤트 발생률.\n`);

const allSignalsByDate = {};
const allStats = [];

testDates.forEach(testDate => {
  const regularStocks = [];
  const surgedRegularStocks = [];  // closeSurge10 충족 (regular only)
  const excludedProducts = [];

  files.forEach((file, fileIdx) => {
    if (fileIdx % 1000 === 0) process.stdout.write(`  [${testDate}] ${fileIdx}/${files.length}\r`);

    const code = file.replace('.json', '');
    const filePath = path.join(LONG_CACHE_DIR, file);

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const rows = data.rows || [];
      if (!checkQVASignal(rows, testDate)) return;

      const signalRowIdx = rows.findIndex(r => r.date === testDate);
      if (signalRowIdx < 0) return;

      const result = analyzeSurgeDays(rows, signalRowIdx);
      if (!result) return;

      const isExcluded = isExcludedProduct(data.name);
      const entry = {
        code,
        name: data.name,
        market: code.startsWith('3') || code.startsWith('1') || code.startsWith('9') ? 'KOSDAQ' : 'KOSPI',
        isExcludedProduct: isExcluded,
        isPreferred: isPreferredStock(data.name),
        ...result,
      };

      if (isExcluded) {
        excludedProducts.push(entry);
      } else {
        regularStocks.push(entry);
        if (entry.closeSurge10) surgedRegularStocks.push(entry);
      }
    } catch (e) {
      // skip
    }
  });

  console.log(`\n${'='.repeat(120)}`);
  console.log(`\n📈 ${formatDate(testDate)} | QVA 신호 ${regularStocks.length}건 (분석 제외 상품 ${excludedProducts.length}건 별도) | 종가 +10% 급등 ${surgedRegularStocks.length}건\n`);

  if (regularStocks.length === 0 && excludedProducts.length === 0) {
    console.log('신호 없음 (또는 20거래일 추적 데이터 부족)\n');
    return;
  }

  const cs10 = regularStocks.filter(s => s.closeSurge10).length;
  const cs15 = regularStocks.filter(s => s.closeSurge15).length;
  const cs20 = regularStocks.filter(s => s.closeSurge20).length;
  const cs30 = regularStocks.filter(s => s.closeSurge30).length;
  const hs10 = regularStocks.filter(s => s.highSurge10).length;
  const hs15 = regularStocks.filter(s => s.highSurge15).length;
  const hs20 = regularStocks.filter(s => s.highSurge20).length;
  const hs30 = regularStocks.filter(s => s.highSurge30).length;
  const avgCloseSurgeReturn = surgedRegularStocks.length
    ? surgedRegularStocks.reduce((a, b) => a + b.bestSingleDayCloseReturn, 0) / surgedRegularStocks.length
    : 0;
  const avgDaysToSurge = surgedRegularStocks.length
    ? surgedRegularStocks.reduce((a, b) => a + b.daysToSurge, 0) / surgedRegularStocks.length
    : 0;

  if (regularStocks.length > 0) {
    console.log(`💡 종가 기준 급등 발생 (실제 강하게 마감)`);
    console.log(`  +10%: ${cs10}/${regularStocks.length} (${(cs10 / regularStocks.length * 100).toFixed(0)}%)`);
    console.log(`  +15%: ${cs15}/${regularStocks.length} (${(cs15 / regularStocks.length * 100).toFixed(0)}%)`);
    console.log(`  +20%: ${cs20}/${regularStocks.length} (${(cs20 / regularStocks.length * 100).toFixed(0)}%)`);
    console.log(`  +30%: ${cs30}/${regularStocks.length} (${(cs30 / regularStocks.length * 100).toFixed(0)}%)`);
    console.log(`💡 고가 기준 급등 발생 (장중 한 번이라도 강하게 튄)`);
    console.log(`  +10%: ${hs10}/${regularStocks.length} (${(hs10 / regularStocks.length * 100).toFixed(0)}%)`);
    console.log(`  +15%: ${hs15}/${regularStocks.length} (${(hs15 / regularStocks.length * 100).toFixed(0)}%)`);
    console.log(`  +20%: ${hs20}/${regularStocks.length} (${(hs20 / regularStocks.length * 100).toFixed(0)}%)`);
    console.log(`  +30%: ${hs30}/${regularStocks.length} (${(hs30 / regularStocks.length * 100).toFixed(0)}%)`);
    if (surgedRegularStocks.length > 0) {
      console.log(`  평균 종가 급등률 (종가 +10% 이상): +${avgCloseSurgeReturn.toFixed(2)}%`);
      console.log(`  평균 급등 발생 시점 (종가 +10% 이상): D+${avgDaysToSurge.toFixed(1)}\n`);
    } else {
      console.log(`  +10% 이상 급등 종목 없음\n`);
    }
  }

  // 정렬: (1) bestSingleDayCloseReturn desc, (2) daysToSurge asc, (3) returnFromSignal desc
  const sortFn = (a, b) => {
    if (b.bestSingleDayCloseReturn !== a.bestSingleDayCloseReturn) return b.bestSingleDayCloseReturn - a.bestSingleDayCloseReturn;
    if (a.daysToSurge !== b.daysToSurge) return a.daysToSurge - b.daysToSurge;
    return b.returnFromSignal - a.returnFromSignal;
  };
  surgedRegularStocks.sort(sortFn);

  if (surgedRegularStocks.length > 0) {
    const N = Math.min(15, surgedRegularStocks.length);
    console.log(`📋 종가 +10% 급등 발생 종목 상위 ${N}개`);
    console.log(`| # | 종목 | 코드 | 신호일 | 신호가 | 급등일 | D+ | 종가일간% | 고가일간% | 신호대비% | 거래대금배수 | 급등전MDD% |`);
    surgedRegularStocks.slice(0, N).forEach((s, i) => {
      const sign = s.returnFromSignal >= 0 ? '+' : '';
      const pref = s.isPreferred ? ' [우]' : '';
      console.log(
        `| ${i + 1} | ${(s.name || '').padEnd(8)}${pref} | ${s.code} | ${formatDate(s.signalDate)} | ${s.signalPrice.toLocaleString()}원 | ` +
        `${formatDate(s.surgeDate)} | D+${s.daysToSurge} | ` +
        `+${s.bestSingleDayCloseReturn.toFixed(2)}% | +${s.bestSingleDayHighReturn.toFixed(2)}% | ` +
        `${sign}${s.returnFromSignal.toFixed(2)}% | ${s.surgeValueRatio.toFixed(2)}x | ${s.preSurgeMaxDrop.toFixed(2)}% |`
      );
    });
    console.log('');
  }

  if (excludedProducts.length > 0) {
    console.log(`📦 분석 제외 상품 (ETF/ETN/레버리지/인버스/선물/TR/H): ${excludedProducts.length}건`);
    excludedProducts.slice(0, 10).forEach(p => {
      console.log(`   ${p.name} (${p.code}) · 종가 +${p.bestSingleDayCloseReturn.toFixed(2)}%`);
    });
    if (excludedProducts.length > 10) console.log(`   ... 외 ${excludedProducts.length - 10}건`);
    console.log('');
  }

  allStats.push({
    date: testDate,
    totalSignals: regularStocks.length,
    excludedProductsCount: excludedProducts.length,
    closeSurge10: cs10, closeSurge15: cs15, closeSurge20: cs20, closeSurge30: cs30,
    highSurge10: hs10, highSurge15: hs15, highSurge20: hs20, highSurge30: hs30,
    avgCloseSurgeReturn,
    avgDaysToSurge,
  });
  allSignalsByDate[testDate] = {
    regular: regularStocks,
    surged: surgedRegularStocks,
    excludedProducts,
  };
});

// ---------- 전체 요약 ----------
console.log(`\n\n${'='.repeat(120)}\n`);
console.log(`📊 전체 요약 (분석 완료된 신호일 ${allStats.length}개 합산, regular only)\n`);

const totalSignals = allStats.reduce((a, b) => a + b.totalSignals, 0);
const totalExcludedProducts = allStats.reduce((a, b) => a + b.excludedProductsCount, 0);
const totalCloseSurge10 = allStats.reduce((a, b) => a + b.closeSurge10, 0);
const totalCloseSurge15 = allStats.reduce((a, b) => a + b.closeSurge15, 0);
const totalCloseSurge20 = allStats.reduce((a, b) => a + b.closeSurge20, 0);
const totalCloseSurge30 = allStats.reduce((a, b) => a + b.closeSurge30, 0);
const totalHighSurge10 = allStats.reduce((a, b) => a + b.highSurge10, 0);
const totalHighSurge15 = allStats.reduce((a, b) => a + b.highSurge15, 0);
const totalHighSurge20 = allStats.reduce((a, b) => a + b.highSurge20, 0);
const totalHighSurge30 = allStats.reduce((a, b) => a + b.highSurge30, 0);

const allRegularFlat = Object.values(allSignalsByDate).flatMap(o => o.regular || []);
const allSurgedFlat = Object.values(allSignalsByDate).flatMap(o => o.surged || []);
const allExcludedFlat = Object.values(allSignalsByDate).flatMap(o => o.excludedProducts || []);

const uniqueStocks = new Set(allRegularFlat.map(s => s.code)).size;
const closeSurge10UniqueStocks = new Set(allRegularFlat.filter(s => s.closeSurge10).map(s => s.code)).size;
const highSurge10UniqueStocks = new Set(allRegularFlat.filter(s => s.highSurge10).map(s => s.code)).size;
const preferredStocksCount = allRegularFlat.filter(s => s.isPreferred).length;
const uniqueExcludedProducts = new Set(allExcludedFlat.map(s => s.code)).size;

const avgDaysToSurgeAll = allSurgedFlat.length
  ? allSurgedFlat.reduce((a, b) => a + b.daysToSurge, 0) / allSurgedFlat.length
  : 0;

let fastest = null;
let biggest = null;
for (const s of allSurgedFlat) {
  if (!fastest ||
      s.daysToSurge < fastest.daysToSurge ||
      (s.daysToSurge === fastest.daysToSurge && s.bestSingleDayCloseReturn > fastest.bestSingleDayCloseReturn)) {
    fastest = s;
  }
  if (!biggest || s.bestSingleDayCloseReturn > biggest.bestSingleDayCloseReturn) biggest = s;
}

const pctOf = (n, d) => d > 0 ? (n / d * 100).toFixed(1) : '0.0';

const analyzedSignalDates = allStats.map(s => s.date);
const excludedSignalDates = testDates
  .filter(d => !analyzedSignalDates.includes(d))
  .map(d => ({ date: d, reason: "20거래일 추적 데이터 부족" }));

console.log(`전체 QVA 신호 (regular): ${totalSignals}건 · 고유 종목 ${uniqueStocks}개 · 우선주 ${preferredStocksCount}건 포함`);
console.log(`분석 제외 상품: ${totalExcludedProducts}건 · 고유 ${uniqueExcludedProducts}개\n`);

console.log(`【종가 기준 급등 발생률】 (실제 강하게 마감한 급등)`);
console.log(`+10%: ${totalCloseSurge10}건 (${pctOf(totalCloseSurge10, totalSignals)}%) · 고유 종목 ${closeSurge10UniqueStocks}개`);
console.log(`+15%: ${totalCloseSurge15}건 (${pctOf(totalCloseSurge15, totalSignals)}%)`);
console.log(`+20%: ${totalCloseSurge20}건 (${pctOf(totalCloseSurge20, totalSignals)}%)`);
console.log(`+30%: ${totalCloseSurge30}건 (${pctOf(totalCloseSurge30, totalSignals)}%)\n`);

console.log(`【고가 기준 급등 발생률】 (장중 한 번이라도 강하게 튄 급등)`);
console.log(`+10%: ${totalHighSurge10}건 (${pctOf(totalHighSurge10, totalSignals)}%) · 고유 종목 ${highSurge10UniqueStocks}개`);
console.log(`+15%: ${totalHighSurge15}건 (${pctOf(totalHighSurge15, totalSignals)}%)`);
console.log(`+20%: ${totalHighSurge20}건 (${pctOf(totalHighSurge20, totalSignals)}%)`);
console.log(`+30%: ${totalHighSurge30}건 (${pctOf(totalHighSurge30, totalSignals)}%)\n`);

console.log(`평균 급등 발생 시점 (종가 +10% 이상 한정): D+${avgDaysToSurgeAll.toFixed(2)}\n`);

if (excludedSignalDates.length > 0) {
  console.log(`※ 분석 제외 신호일: ${excludedSignalDates.map(e => formatDate(e.date)).join(', ')} (사유: 20거래일 추적 데이터 부족)\n`);
}

if (fastest) {
  console.log(`⚡ 가장 빠른 종가 급등: ${fastest.name} (${fastest.code})`);
  console.log(`   신호일 ${formatDate(fastest.signalDate)} → 급등일 ${formatDate(fastest.surgeDate)} (D+${fastest.daysToSurge}) | +${fastest.bestSingleDayCloseReturn.toFixed(2)}%`);
}
if (biggest) {
  console.log(`🚀 가장 큰 종가 급등: ${biggest.name} (${biggest.code})`);
  console.log(`   신호일 ${formatDate(biggest.signalDate)} → 급등일 ${formatDate(biggest.surgeDate)} (D+${biggest.daysToSurge}) | +${biggest.bestSingleDayCloseReturn.toFixed(2)}%`);
}
console.log('');

// 신호일별 통계 표 (종가 기준)
console.log(`\n📈 신호일별 단일일 종가 급등 발생 통계\n`);
console.log(`| 신호일 | 신호수 | 종가+10 | 종가+15 | 종가+20 | 종가+30 | 고가+10 | 고가+15 | 고가+20 | 고가+30 | 평균 D+ |`);
allStats.forEach(stat => {
  const r = (n) => stat.totalSignals > 0 ? `${(n / stat.totalSignals * 100).toFixed(0)}%` : '-';
  console.log(
    `| ${formatDate(stat.date)} | ${stat.totalSignals.toString().padStart(5)}건 | ` +
    `${r(stat.closeSurge10)} | ${r(stat.closeSurge15)} | ${r(stat.closeSurge20)} | ${r(stat.closeSurge30)} | ` +
    `${r(stat.highSurge10)} | ${r(stat.highSurge15)} | ${r(stat.highSurge20)} | ${r(stat.highSurge30)} | ` +
    `${stat.closeSurge10 > 0 ? 'D+' + stat.avgDaysToSurge.toFixed(1) : '-'} |`
  );
});

// JSON 저장
const stockSerializer = (s) => ({
  code: s.code,
  name: s.name,
  market: s.market,
  isExcludedProduct: s.isExcludedProduct,
  isPreferred: s.isPreferred,
  signalDate: s.signalDate,
  signalPrice: s.signalPrice,

  // 종가 기준 (메인)
  surgeDate: s.surgeDate,
  daysToSurge: s.daysToSurge,
  prevClose: s.prevClose,
  surgeClose: s.surgeClose,
  bestSingleDayCloseReturn: parseFloat(s.bestSingleDayCloseReturn.toFixed(2)),

  // 고가 기준 (보조)
  highSurgeDate: s.highSurgeDate,
  daysToHighSurge: s.daysToHighSurge,
  highSurgePrevClose: s.highSurgePrevClose,
  surgeHigh: s.surgeHigh,
  bestSingleDayHighReturn: parseFloat(s.bestSingleDayHighReturn.toFixed(2)),

  // 공통
  returnFromSignal: parseFloat(s.returnFromSignal.toFixed(2)),
  surgeValue: Math.round(s.surgeValue),
  surgeValueRatio: parseFloat(s.surgeValueRatio.toFixed(2)),
  preSurgeMaxDrop: parseFloat(s.preSurgeMaxDrop.toFixed(2)),

  // 플래그
  closeSurge10: s.closeSurge10, closeSurge15: s.closeSurge15, closeSurge20: s.closeSurge20, closeSurge30: s.closeSurge30,
  highSurge10: s.highSurge10, highSurge15: s.highSurge15, highSurge20: s.highSurge20, highSurge30: s.highSurge30,
});

const jsonOut = {
  meta: {
    purpose: "QVA 신호 후 20거래일 안에 단일일 종가/고가 기준 +10%/+15%/+20%/+30% 이상 급등이 발생했는지 분석",
    notice: "QVA는 매수 추천 신호가 아니라 관심종목 후보를 좁히는 추적 모델이다. 본 수치는 승률이 아니라 QVA 신호 이후 급등 이벤트가 발생한 비율이다.",
    surgeThresholdPct: 10,
    trackingDays: 20,
    excludeKeywords: EXCLUDE_KEYWORDS,
    requestedSignalDates: testDates,
    analyzedSignalDates,
    excludedSignalDates,
    generatedAt: new Date().toISOString(),
  },
  summary: {
    totalSignals,
    uniqueStocks,
    preferredStocksCount,
    excludedProductsCount: totalExcludedProducts,
    uniqueExcludedProducts,

    // 종가 기준
    closeSurge10: totalCloseSurge10,
    closeSurge15: totalCloseSurge15,
    closeSurge20: totalCloseSurge20,
    closeSurge30: totalCloseSurge30,
    closeSurge10Rate: parseFloat(pctOf(totalCloseSurge10, totalSignals)),
    closeSurge15Rate: parseFloat(pctOf(totalCloseSurge15, totalSignals)),
    closeSurge20Rate: parseFloat(pctOf(totalCloseSurge20, totalSignals)),
    closeSurge30Rate: parseFloat(pctOf(totalCloseSurge30, totalSignals)),
    closeSurge10UniqueStocks,

    // 고가 기준
    highSurge10: totalHighSurge10,
    highSurge15: totalHighSurge15,
    highSurge20: totalHighSurge20,
    highSurge30: totalHighSurge30,
    highSurge10Rate: parseFloat(pctOf(totalHighSurge10, totalSignals)),
    highSurge15Rate: parseFloat(pctOf(totalHighSurge15, totalSignals)),
    highSurge20Rate: parseFloat(pctOf(totalHighSurge20, totalSignals)),
    highSurge30Rate: parseFloat(pctOf(totalHighSurge30, totalSignals)),
    highSurge10UniqueStocks,

    avgDaysToSurge: parseFloat(avgDaysToSurgeAll.toFixed(2)),
    fastest: fastest ? {
      code: fastest.code, name: fastest.name,
      signalDate: fastest.signalDate, surgeDate: fastest.surgeDate,
      daysToSurge: fastest.daysToSurge,
      bestSingleDayCloseReturn: parseFloat(fastest.bestSingleDayCloseReturn.toFixed(2)),
    } : null,
    biggest: biggest ? {
      code: biggest.code, name: biggest.name,
      signalDate: biggest.signalDate, surgeDate: biggest.surgeDate,
      daysToSurge: biggest.daysToSurge,
      bestSingleDayCloseReturn: parseFloat(biggest.bestSingleDayCloseReturn.toFixed(2)),
    } : null,
  },
  signalDates: allStats.map(stat => ({
    date: stat.date,
    totalSignals: stat.totalSignals,
    excludedProductsCount: stat.excludedProductsCount,
    closeSurge10: stat.closeSurge10, closeSurge15: stat.closeSurge15, closeSurge20: stat.closeSurge20, closeSurge30: stat.closeSurge30,
    highSurge10: stat.highSurge10, highSurge15: stat.highSurge15, highSurge20: stat.highSurge20, highSurge30: stat.highSurge30,
    avgCloseSurgeReturn: parseFloat(stat.avgCloseSurgeReturn.toFixed(2)),
    avgDaysToSurge: parseFloat(stat.avgDaysToSurge.toFixed(2)),
    stocks: (allSignalsByDate[stat.date]?.regular || [])
      .slice()
      .sort((a, b) => {
        if (b.bestSingleDayCloseReturn !== a.bestSingleDayCloseReturn) return b.bestSingleDayCloseReturn - a.bestSingleDayCloseReturn;
        if (a.daysToSurge !== b.daysToSurge) return a.daysToSurge - b.daysToSurge;
        return b.returnFromSignal - a.returnFromSignal;
      })
      .map(stockSerializer),
    excludedProducts: (allSignalsByDate[stat.date]?.excludedProducts || [])
      .slice()
      .sort((a, b) => b.bestSingleDayCloseReturn - a.bestSingleDayCloseReturn)
      .map(stockSerializer),
  })),
};

fs.writeFileSync(
  path.join(__dirname, 'qva-surge-day-report.json'),
  JSON.stringify(jsonOut, null, 2),
  'utf-8'
);

console.log(`\n✅ JSON 저장: qva-surge-day-report.json`);

// ---------- HTML 생성 ----------
const htmlTemplate = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QVA 신호 후 20거래일 내 급등일 탐지 보고서</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
  h1 { color: #f1f5f9; margin: 0 0 4px 0; font-size: 24px; }
  h1 .sub { color: #94a3b8; font-size: 14px; font-weight: 400; margin-left: 6px; }
  h2 { color: #f1f5f9; margin: 32px 0 12px 0; font-size: 18px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
  h3 { color: #cbd5e1; font-size: 14px; margin: 18px 0 8px 0; font-weight: 600; }
  .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 16px; }

  .info-box { background: #1e293b; padding: 14px 18px; border-radius: 8px; margin-bottom: 14px; border-left: 3px solid #60a5fa; }
  .info-box p { margin: 0 0 8px 0; font-size: 13px; line-height: 1.65; color: #cbd5e1; }
  .info-box p:last-child { margin-bottom: 0; }
  .info-box strong { color: #f1f5f9; }

  .summary { background: #1e293b; padding: 16px 20px; border-radius: 8px; margin-bottom: 14px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .stat { background: #0f172a; padding: 10px 14px; border-radius: 6px; }
  .stat-label { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { color: #f1f5f9; font-size: 18px; font-weight: 600; margin-top: 2px; }
  .stat-value .pct { color: #10b981; font-size: 13px; font-weight: 400; margin-left: 6px; }
  .stat.close { border-left: 3px solid #10b981; }
  .stat.high { border-left: 3px solid #f59e0b; }

  .summary-text { background: #0f172a; border: 1px solid #334155; padding: 14px 18px; border-radius: 8px; margin-bottom: 14px; font-size: 13px; line-height: 1.75; color: #e2e8f0; }
  .summary-text .caveat { color: #94a3b8; font-size: 12px; }

  .note { color: #94a3b8; font-size: 12px; padding: 4px 4px; line-height: 1.6; margin-bottom: 6px; }
  .note strong { color: #cbd5e1; }
  .note.warn { color: #fcd34d; }

  .highlight { background: #1e293b; padding: 12px 16px; border-radius: 6px; margin-bottom: 8px; border-left: 3px solid #f59e0b; }
  .highlight strong { color: #fbbf24; }
  .highlight .name { color: #f1f5f9; font-weight: 600; }

  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .controls input[type=text] { flex: 1; min-width: 200px; padding: 8px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 13px; }
  .controls label { color: #94a3b8; font-size: 13px; cursor: pointer; user-select: none; }
  .controls select { padding: 8px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 13px; }

  details { background: #1e293b; border-radius: 8px; margin-bottom: 12px; }
  details summary { padding: 14px 18px; cursor: pointer; font-weight: 600; color: #f1f5f9; user-select: none; }
  details summary:hover { background: #283447; }
  details[open] summary { border-bottom: 1px solid #334155; }
  .date-stats { padding: 8px 18px; color: #94a3b8; font-size: 12px; }
  .date-stats span { margin-right: 14px; }
  .date-stats .surge.close { color: #10b981; }
  .date-stats .surge.high { color: #fbbf24; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #334155; white-space: nowrap; }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2), th:nth-child(3), td:nth-child(3) { text-align: left; }
  th { background: #283447; color: #cbd5e1; font-weight: 600; cursor: pointer; user-select: none; position: sticky; top: 0; }
  th:hover { background: #334155; }
  th.sorted-asc::after { content: " ▲"; color: #60a5fa; }
  th.sorted-desc::after { content: " ▼"; color: #60a5fa; }
  tr:hover { background: #283447; }

  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-left: 2px; }
  .badge.s10 { background: #064e3b; color: #6ee7b7; }
  .badge.s15 { background: #14532d; color: #86efac; }
  .badge.s20 { background: #166534; color: #bbf7d0; }
  .badge.s30 { background: #f59e0b; color: #1e293b; }
  .badge.h10 { background: #7c2d12; color: #fed7aa; }
  .badge.h15 { background: #9a3412; color: #fed7aa; }
  .badge.h20 { background: #c2410c; color: #ffedd5; }
  .badge.h30 { background: #ea580c; color: #1e293b; }
  .badge.pref { background: #1e3a8a; color: #93c5fd; }
  .pos { color: #10b981; }
  .neg { color: #f87171; }
  .muted { color: #64748b; }
  .market-K { color: #60a5fa; }
  .market-Q { color: #c084fc; }
  .empty { padding: 18px; color: #64748b; text-align: center; font-size: 13px; }

  /* 분석 제외 상품 박스 */
  .excluded-section { margin-top: 32px; }
  .excluded-section details { border: 1px solid #475569; }

  /* 모바일: 카드 레이아웃 */
  .cards { display: none; padding: 6px 10px 12px 10px; }
  .card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .card-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .card-head .name { font-weight: 700; font-size: 15px; }
  .card-head .meta { color: #64748b; font-size: 11px; margin-left: auto; }
  .card-headline { display: flex; align-items: baseline; gap: 10px; padding: 6px 0 10px 0; border-bottom: 1px dashed #334155; margin-bottom: 10px; flex-wrap: wrap; }
  .card-headline .big-pct { font-size: 28px; font-weight: 700; }
  .card-headline .surge-when { color: #cbd5e1; font-size: 13px; }
  .card-headline .high-tag { font-size: 12px; color: #fbbf24; margin-left: auto; }
  .card-body { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 12px; }
  .card-body .lbl { color: #64748b; }
  .card-body .val { color: #e2e8f0; text-align: right; }
  @media (max-width: 640px) {
    body { padding: 12px; }
    h1 { font-size: 18px; }
    h1 .sub { display: block; font-size: 12px; margin: 2px 0 0 0; }
    h2 { font-size: 15px; margin-top: 24px; }
    h3 { font-size: 13px; }
    .subtitle { font-size: 11px; }
    .summary { padding: 12px; }
    .stat-value { font-size: 15px; }
    .stat-label { font-size: 10px; }
    .summary-text { font-size: 12px; padding: 12px 14px; }
    .info-box p { font-size: 12px; }
    .highlight { font-size: 12px; padding: 10px 12px; }
    details summary { padding: 12px 14px; font-size: 13px; }
    .date-stats { font-size: 11px; padding: 6px 14px; }
    .date-stats span { margin-right: 10px; }
    table { display: none; }
    .cards { display: block; }
    .controls input[type=text], .controls select { font-size: 14px; }
  }
</style>
</head>
<body>
  <h1>📊 QVA 신호 후 20거래일 내 급등일 탐지 보고서<span class="sub">— QVA 단일일 급등 발생 분석</span></h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="nav" style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
    <a href="/qva-watchlist" style="color:#93c5fd;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e293b;border-radius:6px;">📋 매일 운영 보드</a>
    <span style="color:#475569;font-size:11px;align-self:center;">검증 ▶</span>
    <a href="/qva-surge-day-report" style="color:#fff;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e3a8a;border-radius:6px;">단일일 급등</a>
    <a href="/qva-to-vvi-report" style="color:#93c5fd;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e293b;border-radius:6px;">QVA → VVI 전환</a>
    <a href="/qva-vvi-breakout-entry-report" style="color:#93c5fd;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e293b;border-radius:6px;">진입</a>
    <a href="/qva-vvi-breakout-exit-report" style="color:#93c5fd;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e293b;border-radius:6px;">익절/청산</a>
    <a href="/qva-review-ok" style="color:#6ee7b7;text-decoration:none;font-size:13px;padding:6px 10px;background:#0f172a;border:1px solid #10b981;border-radius:6px;">⭐ 3단계 코호트 비교</a>
  </div>

  <div class="info-box">
    <h3 style="margin:0 0 10px 0;color:#f1f5f9;font-size:15px;border:none;padding:0;">📌 보고서 안내</h3>
    <p><strong>이 보고서가 답하는 질문</strong></p>
    <p>QVA 신호가 발생한 종목이 그 후 20거래일 안에 단일일 기준 +10/+15/+20/+30% 큰 급등을 얼마나 자주 일으켰는가?</p>

    <p style="margin-top:10px;"><strong>📍 funnel에서의 위치</strong></p>
    <p style="font-size:12px;background:#0f172a;padding:8px 12px;border-radius:6px;border:1px solid #334155;">
      <span style="color:#fbbf24;font-weight:700;">QVA(감시 시작)</span> 단계의 폭발력 자체를 측정. VVI나 돌파 성공까지 진행되지 않더라도, QVA 후보가 <strong>한 번이라도 급등을 일으킨 비율</strong>을 봅니다.
    </p>

    <p style="margin-top:10px;"><strong>📊 읽는 법</strong></p>
    <ul style="margin:4px 0;padding-left:20px;font-size:13px;line-height:1.7;color:#cbd5e1;">
      <li><strong>종가 기준</strong> = 그날 강하게 마감한 진짜 급등</li>
      <li><strong>고가 기준</strong> = 장중에 한 번이라도 튄 급등 (다시 내려와 마감했을 수도 있음)</li>
      <li><strong>"급등 발생률"은 매수 시 승률이 아닙니다.</strong> 매수해서 얻은 수익률이 아니라 이벤트 발생 빈도입니다.</li>
    </ul>

    <p style="margin-top:10px;"><strong>🎯 핵심 의미</strong></p>
    <p>QVA 신호가 폭발력 측면에서 얼마나 가치 있는지를 보여줍니다. 급등 발생률이 높을수록 QVA 후보를 추적할 가치가 있다는 근거가 됩니다.</p>

    <p style="margin-top:10px;color:#fbbf24;">⚠️ 매수 추천이 아니라 모델 검증/분석입니다.</p>
  </div>

  <h3>전체 개요</h3>
  <div class="summary">
    <div class="summary-grid" id="summary-overview"></div>
  </div>

  <h3>종가 기준 급등 발생률 <span style="color:#94a3b8;font-weight:400;font-size:12px">(실제 강하게 마감한 급등)</span></h3>
  <div class="summary">
    <div class="summary-grid" id="summary-close"></div>
  </div>

  <h3>고가 기준 급등 발생률 <span style="color:#94a3b8;font-weight:400;font-size:12px">(장중 한 번이라도 강하게 튄 급등)</span></h3>
  <div class="summary">
    <div class="summary-grid" id="summary-high"></div>
  </div>

  <div class="summary-text" id="summary-text"></div>

  <div class="note">
    <strong>집계 단위:</strong> 본 보고서는 종목 수 기준이 아니라 <strong>QVA 신호 발생 건수</strong> 기준으로 집계합니다. 동일 종목이 여러 신호일에 반복 등장할 수 있습니다.
  </div>

  <div class="note">
    <strong>최고점 보고서와의 차이:</strong> 기존 QVA 최고점 보고서는 신호 후 20거래일 안에 <strong>최고점이 어디까지 갔는지</strong>를 봅니다. 반면 이 보고서는 신호 후 20거래일 안에 <strong>어느 날 하루 급등이 발생했는지</strong>를 봅니다.
  </div>

  <div class="note">
    <strong>분석 제외 상품:</strong> 종목명에 ETN/ETF/레버리지/인버스/선물/TR/H) 키워드가 포함된 상품(레버리지·인버스 ETF/ETN 등)은 본문 분석에서 제외하고 페이지 하단 별도 섹션으로 분리했습니다. <strong>우선주</strong>는 분석에 포함하되 <span class="badge pref" style="margin:0 2px">우</span> 배지로 표시합니다.
  </div>

  <div class="note warn" id="excluded-note" style="display:none"></div>

  <div id="highlights"></div>

  <h2>신호일별 상세</h2>
  <div class="controls">
    <input type="text" id="filter" placeholder="종목명 또는 코드 검색…">
    <select id="surge-filter">
      <option value="all">전체</option>
      <option value="closeSurge10">+10% 종가 급등 발생</option>
      <option value="closeSurge15">+15% 종가 급등 발생</option>
      <option value="closeSurge20">+20% 종가 급등 발생</option>
      <option value="closeSurge30">+30% 종가 급등 발생</option>
      <option value="highSurge10">+10% 고가 급등 발생</option>
      <option value="highSurge15">+15% 고가 급등 발생</option>
      <option value="highSurge20">+20% 고가 급등 발생</option>
      <option value="highSurge30">+30% 고가 급등 발생</option>
      <option value="preferred">우선주만</option>
    </select>
  </div>

  <div id="dates"></div>

  <div class="excluded-section">
    <h2>📦 분석 제외 상품 (ETF/ETN/레버리지/인버스/선물/TR/H)</h2>
    <div class="note">QVA는 개별 주식의 수급 흔적을 찾는 모델이라, 합성·파생 상품은 본문 분석에서 분리했습니다. 참고용으로만 표시합니다.</div>
    <div id="excluded-dates"></div>
  </div>

<script>
const DATA = __JSON_DATA__;

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8) : (d || '-'); }
function fmtNum(n) { return n != null ? Math.round(n).toLocaleString() : '-'; }
function fmtPct(n, sign) {
  if (n == null) return '-';
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : 'muted');
  const s = (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
  return '<span class="' + cls + '">' + s + '</span>';
}
function fmtValueOk(v) { return (v / 1e8).toFixed(0) + '억'; }
function badges(s) {
  let b = '';
  if (s.isPreferred) b += '<span class="badge pref">우</span>';
  if (s.closeSurge30) b += '<span class="badge s30">종가30+</span>';
  else if (s.closeSurge20) b += '<span class="badge s20">종가20+</span>';
  else if (s.closeSurge15) b += '<span class="badge s15">종가15+</span>';
  else if (s.closeSurge10) b += '<span class="badge s10">종가10+</span>';
  if (s.highSurge30 && !s.closeSurge30) b += '<span class="badge h30">고가30+</span>';
  else if (s.highSurge20 && !s.closeSurge20) b += '<span class="badge h20">고가20+</span>';
  else if (s.highSurge15 && !s.closeSurge15) b += '<span class="badge h15">고가15+</span>';
  else if (s.highSurge10 && !s.closeSurge10) b += '<span class="badge h10">고가10+</span>';
  return b;
}
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }

// 헤더 자막
const reqDates = DATA.meta.requestedSignalDates;
const anlDates = DATA.meta.analyzedSignalDates;
document.getElementById('subtitle').textContent =
  '요청 신호일 ' + reqDates.length + '개 (' + fmtDate(reqDates[0]) + ' ~ ' + fmtDate(reqDates[reqDates.length - 1]) + ')' +
  ' · 분석 완료 ' + anlDates.length + '개' +
  ' · 추적: D+1 ~ D+' + DATA.meta.trackingDays +
  ' · 급등 기준: 단일일 +' + DATA.meta.surgeThresholdPct + '% 이상' +
  ' · 생성: ' + DATA.meta.generatedAt.slice(0, 19).replace('T', ' ');

// 분석 제외 신호일
if (DATA.meta.excludedSignalDates && DATA.meta.excludedSignalDates.length > 0) {
  const ex = DATA.meta.excludedSignalDates.map(d => fmtDate(d.date)).join(', ');
  const reason = DATA.meta.excludedSignalDates[0].reason;
  const note = document.getElementById('excluded-note');
  note.style.display = '';
  note.innerHTML = '⚠️ <strong>분석 제외 신호일:</strong> ' + ex + ' — ' + reason + '으로 인해 제외되었습니다.';
}

// 요약 통계 카드
const sum = DATA.summary;
function makeStatCard(label, val, pct, klass) {
  const cls = 'stat' + (klass ? ' ' + klass : '');
  return '<div class="' + cls + '"><div class="stat-label">' + label + '</div><div class="stat-value">' + val +
    (pct ? '<span class="pct">' + pct + '</span>' : '') + '</div></div>';
}

document.getElementById('summary-overview').innerHTML = [
  makeStatCard('전체 QVA 신호', sum.totalSignals + '건'),
  makeStatCard('고유 종목', sum.uniqueStocks + '개'),
  makeStatCard('우선주 포함', sum.preferredStocksCount + '건'),
  makeStatCard('분석 제외 상품', sum.excludedProductsCount + '건'),
  makeStatCard('평균 급등 시점', 'D+' + sum.avgDaysToSurge.toFixed(1)),
].join('');

document.getElementById('summary-close').innerHTML = [
  makeStatCard('+10% 종가 급등', sum.closeSurge10 + '건', sum.closeSurge10Rate + '%', 'close'),
  makeStatCard('+15% 종가 급등', sum.closeSurge15 + '건', sum.closeSurge15Rate + '%', 'close'),
  makeStatCard('+20% 종가 급등', sum.closeSurge20 + '건', sum.closeSurge20Rate + '%', 'close'),
  makeStatCard('+30% 종가 급등', sum.closeSurge30 + '건', sum.closeSurge30Rate + '%', 'close'),
  makeStatCard('+10% 고유 종목', sum.closeSurge10UniqueStocks + '개', null, 'close'),
].join('');

document.getElementById('summary-high').innerHTML = [
  makeStatCard('+10% 고가 급등', sum.highSurge10 + '건', sum.highSurge10Rate + '%', 'high'),
  makeStatCard('+15% 고가 급등', sum.highSurge15 + '건', sum.highSurge15Rate + '%', 'high'),
  makeStatCard('+20% 고가 급등', sum.highSurge20 + '건', sum.highSurge20Rate + '%', 'high'),
  makeStatCard('+30% 고가 급등', sum.highSurge30 + '건', sum.highSurge30Rate + '%', 'high'),
  makeStatCard('+10% 고유 종목', sum.highSurge10UniqueStocks + '개', null, 'high'),
].join('');

// 요약 문구
document.getElementById('summary-text').innerHTML =
  'QVA 신호 ' + sum.totalSignals + '건 중 ' + sum.closeSurge10 + '건, 즉 <strong>' + sum.closeSurge10Rate + '%</strong>가 신호 후 ' +
  DATA.meta.trackingDays + '거래일 안에 전일 종가 대비 하루 <strong>종가 +10% 이상 급등</strong>했습니다.<br>' +
  '+15% 이상 종가 급등은 ' + sum.closeSurge15Rate + '%, +20% 이상은 ' + sum.closeSurge20Rate + '%, +30% 이상은 ' + sum.closeSurge30Rate + '%였습니다. ' +
  '평균 급등 발생 시점은 신호 후 ' + sum.avgDaysToSurge.toFixed(2) + '거래일입니다.<br>' +
  '<span style="color:#fbbf24">고가 기준</span>으로는 +10% ' + sum.highSurge10Rate + '%, +15% ' + sum.highSurge15Rate + '%, +20% ' + sum.highSurge20Rate + '%, +30% ' + sum.highSurge30Rate + '%로, 장중 한 번이라도 튄 비율은 더 높습니다.<br><br>' +
  '<span class="caveat">이 수치는 승률이 아니라 QVA 신호 이후 급등 이벤트가 발생한 비율입니다.</span>';

// 하이라이트
const hl = document.getElementById('highlights');
let hlHtml = '';
if (sum.fastest) {
  hlHtml += '<div class="highlight">⚡ <strong>가장 빠른 종가 급등</strong> · <span class="name">' + sum.fastest.name +
    '</span> (' + sum.fastest.code + ') · 신호일 ' + fmtDate(sum.fastest.signalDate) +
    ' → 급등일 ' + fmtDate(sum.fastest.surgeDate) + ' (D+' + sum.fastest.daysToSurge + ') · ' +
    fmtPct(sum.fastest.bestSingleDayCloseReturn, true) + '</div>';
}
if (sum.biggest) {
  hlHtml += '<div class="highlight">🚀 <strong>가장 큰 종가 급등</strong> · <span class="name">' + sum.biggest.name +
    '</span> (' + sum.biggest.code + ') · 신호일 ' + fmtDate(sum.biggest.signalDate) +
    ' → 급등일 ' + fmtDate(sum.biggest.surgeDate) + ' (D+' + sum.biggest.daysToSurge + ') · ' +
    fmtPct(sum.biggest.bestSingleDayCloseReturn, true) + '</div>';
}
hl.innerHTML = hlHtml;

// 컬럼 정의
const COLS = [
  { key: 'name', label: '종목', type: 'str', render: (s) => '<span class="' + marketCls(s.market) + '">' + (s.name || '') + '</span>' + badges(s) },
  { key: 'code', label: '코드', type: 'str' },
  { key: 'signalPrice', label: '신호가', type: 'num', render: (s) => fmtNum(s.signalPrice) + '원' },
  { key: 'surgeDate', label: '종가 급등일', type: 'str', render: (s) => fmtDate(s.surgeDate) + ' D+' + s.daysToSurge },
  { key: 'bestSingleDayCloseReturn', label: '종가 일간%', type: 'num', render: (s) => fmtPct(s.bestSingleDayCloseReturn, true) },
  { key: 'highSurgeDate', label: '고가 급등일', type: 'str', render: (s) => fmtDate(s.highSurgeDate) + ' D+' + s.daysToHighSurge },
  { key: 'bestSingleDayHighReturn', label: '고가 일간%', type: 'num', render: (s) => fmtPct(s.bestSingleDayHighReturn, true) },
  { key: 'returnFromSignal', label: '신호대비%', type: 'num', render: (s) => fmtPct(s.returnFromSignal, true) },
  { key: 'surgeValueRatio', label: '거래대금배수', type: 'num', render: (s) => s.surgeValueRatio.toFixed(2) + 'x' },
  { key: 'preSurgeMaxDrop', label: '급등전MDD%', type: 'num', render: (s) => fmtPct(s.preSurgeMaxDrop) },
];

function renderStocksList(parent, dateRec, stocks, kind /* 'regular' or 'excluded' */) {
  if (stocks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = kind === 'excluded' ? '제외 상품 없음' : '신호 종목 없음';
    parent.appendChild(empty);
    return;
  }
  const tbl = document.createElement('table');
  tbl.dataset.date = dateRec.date;
  tbl.dataset.kind = kind;
  const thead = '<thead><tr>' + COLS.map((c, i) => '<th data-col="' + i + '">' + c.label + '</th>').join('') + '</tr></thead>';
  const tbody = '<tbody>' + stocks.map(s =>
    '<tr data-name="' + (s.name || '') + '" data-code="' + s.code +
    '" data-cs10="' + (s.closeSurge10 ? 1 : 0) + '" data-cs15="' + (s.closeSurge15 ? 1 : 0) +
    '" data-cs20="' + (s.closeSurge20 ? 1 : 0) + '" data-cs30="' + (s.closeSurge30 ? 1 : 0) +
    '" data-hs10="' + (s.highSurge10 ? 1 : 0) + '" data-hs15="' + (s.highSurge15 ? 1 : 0) +
    '" data-hs20="' + (s.highSurge20 ? 1 : 0) + '" data-hs30="' + (s.highSurge30 ? 1 : 0) +
    '" data-pref="' + (s.isPreferred ? 1 : 0) + '">' +
    COLS.map(c => '<td>' + (c.render ? c.render(s) : s[c.key]) + '</td>').join('') +
    '</tr>'
  ).join('') + '</tbody>';
  tbl.innerHTML = thead + tbody;
  parent.appendChild(tbl);

  // 모바일 카드
  const cards = document.createElement('div');
  cards.className = 'cards';
  cards.innerHTML = stocks.map(s => {
    const pctCls = s.bestSingleDayCloseReturn > 0 ? 'pos' : (s.bestSingleDayCloseReturn < 0 ? 'neg' : 'muted');
    const pctSign = s.bestSingleDayCloseReturn > 0 ? '+' : '';
    const fromSignSign = s.returnFromSignal > 0 ? '+' : '';
    const fromSignCls = s.returnFromSignal > 0 ? 'pos' : (s.returnFromSignal < 0 ? 'neg' : 'muted');
    const mddCls = s.preSurgeMaxDrop < 0 ? 'neg' : 'muted';
    const highTagSep = s.highSurgeDate !== s.surgeDate;
    const highTagText = highTagSep
      ? '장중 고가 +' + s.bestSingleDayHighReturn.toFixed(2) + '% (' + fmtDate(s.highSurgeDate) + ' D+' + s.daysToHighSurge + ')'
      : '장중 고가 +' + s.bestSingleDayHighReturn.toFixed(2) + '%';
    return '<div class="card" data-name="' + (s.name || '') + '" data-code="' + s.code +
      '" data-cs10="' + (s.closeSurge10 ? 1 : 0) + '" data-cs15="' + (s.closeSurge15 ? 1 : 0) +
      '" data-cs20="' + (s.closeSurge20 ? 1 : 0) + '" data-cs30="' + (s.closeSurge30 ? 1 : 0) +
      '" data-hs10="' + (s.highSurge10 ? 1 : 0) + '" data-hs15="' + (s.highSurge15 ? 1 : 0) +
      '" data-hs20="' + (s.highSurge20 ? 1 : 0) + '" data-hs30="' + (s.highSurge30 ? 1 : 0) +
      '" data-pref="' + (s.isPreferred ? 1 : 0) + '">' +
      '<div class="card-head">' +
        '<span class="name ' + marketCls(s.market) + '">' + (s.name || '') + '</span>' +
        badges(s) +
        '<span class="meta">' + s.market + ' · ' + s.code + '</span>' +
      '</div>' +
      '<div class="card-headline">' +
        '<span class="big-pct ' + pctCls + '">' + pctSign + s.bestSingleDayCloseReturn.toFixed(2) + '%</span>' +
        '<span class="surge-when">' + fmtDate(s.surgeDate) + ' · D+' + s.daysToSurge + '</span>' +
        '<span class="high-tag">' + highTagText + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<span class="lbl">신호가</span><span class="val">' + fmtNum(s.signalPrice) + '원 (' + fmtDate(s.signalDate) + ')</span>' +
        '<span class="lbl">전일종가 → 종가</span><span class="val">' + fmtNum(s.prevClose) + '원 → ' + fmtNum(s.surgeClose) + '원</span>' +
        '<span class="lbl">고가 (장중)</span><span class="val">' + fmtNum(s.surgeHigh) + '원</span>' +
        '<span class="lbl">신호대비</span><span class="val ' + fromSignCls + '">' + fromSignSign + s.returnFromSignal.toFixed(2) + '%</span>' +
        '<span class="lbl">거래대금</span><span class="val">' + (s.surgeValue / 1e8).toFixed(0) + '억 (' + s.surgeValueRatio.toFixed(2) + 'x)</span>' +
        '<span class="lbl">급등 전 MDD</span><span class="val ' + mddCls + '">' + s.preSurgeMaxDrop.toFixed(2) + '%</span>' +
      '</div>' +
    '</div>';
  }).join('');
  parent.appendChild(cards);
}

// 신호일별 렌더 (regular)
const datesEl = document.getElementById('dates');
DATA.signalDates.forEach((d, idx) => {
  const det = document.createElement('details');
  if (idx < 2) det.open = true;
  const sumEl = document.createElement('summary');
  sumEl.innerHTML = fmtDate(d.date) + ' · 신호 ' + d.totalSignals + '건 · ' +
    '<span style="color:#10b981">종가+10% ' + d.closeSurge10 + '</span> / +15% ' + d.closeSurge15 + ' / +20% ' + d.closeSurge20 + ' / +30% ' + d.closeSurge30 +
    ' · <span style="color:#fbbf24">고가+10% ' + d.highSurge10 + '</span> / +15% ' + d.highSurge15 + ' / +20% ' + d.highSurge20 + ' / +30% ' + d.highSurge30 +
    (d.closeSurge10 > 0 ? ' · 평균 D+' + d.avgDaysToSurge.toFixed(1) : '');
  det.appendChild(sumEl);

  const stats = document.createElement('div');
  stats.className = 'date-stats';
  const r = (n) => d.totalSignals ? (n / d.totalSignals * 100).toFixed(0) : 0;
  stats.innerHTML = '<span>총 ' + d.totalSignals + '건</span>' +
    '<span class="surge close">종가 +10%: ' + r(d.closeSurge10) + '%</span>' +
    '<span class="surge close">+15%: ' + r(d.closeSurge15) + '%</span>' +
    '<span class="surge close">+20%: ' + r(d.closeSurge20) + '%</span>' +
    '<span class="surge close">+30%: ' + r(d.closeSurge30) + '%</span>' +
    '<span class="surge high">고가 +10%: ' + r(d.highSurge10) + '%</span>' +
    '<span class="surge high">+15%: ' + r(d.highSurge15) + '%</span>' +
    '<span class="surge high">+20%: ' + r(d.highSurge20) + '%</span>' +
    '<span class="surge high">+30%: ' + r(d.highSurge30) + '%</span>';
  det.appendChild(stats);

  renderStocksList(det, d, d.stocks, 'regular');
  datesEl.appendChild(det);
});

// 분석 제외 상품 렌더
const exDatesEl = document.getElementById('excluded-dates');
DATA.signalDates.forEach((d, idx) => {
  if (!d.excludedProducts || d.excludedProducts.length === 0) return;
  const det = document.createElement('details');
  const sumEl = document.createElement('summary');
  sumEl.innerHTML = fmtDate(d.date) + ' · 분석 제외 상품 ' + d.excludedProducts.length + '건';
  det.appendChild(sumEl);
  renderStocksList(det, d, d.excludedProducts, 'excluded');
  exDatesEl.appendChild(det);
});
if (exDatesEl.children.length === 0) {
  exDatesEl.innerHTML = '<div class="note">제외된 상품이 없습니다.</div>';
}

// 정렬 (모든 table 대상)
document.querySelectorAll('table').forEach(tbl => {
  tbl.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => {
      const colIdx = parseInt(th.dataset.col, 10);
      const col = COLS[colIdx];
      const tbody = tbl.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const isAsc = th.classList.contains('sorted-asc');
      tbl.querySelectorAll('th').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(isAsc ? 'sorted-desc' : 'sorted-asc');
      const dateKey = tbl.dataset.date;
      const kind = tbl.dataset.kind;
      const dateRec = DATA.signalDates.find(x => x.date === dateKey);
      const source = kind === 'excluded' ? dateRec.excludedProducts : dateRec.stocks;
      const stocksByCode = Object.fromEntries(source.map(s => [s.code, s]));
      rows.sort((a, b) => {
        const sa = stocksByCode[a.dataset.code], sb = stocksByCode[b.dataset.code];
        let va = sa[col.key], vb = sb[col.key];
        if (col.type === 'num') { va = +va; vb = +vb; return isAsc ? vb - va : va - vb; }
        return isAsc ? String(vb).localeCompare(String(va)) : String(va).localeCompare(String(vb));
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
});

// 필터
const filterInput = document.getElementById('filter');
const surgeFilter = document.getElementById('surge-filter');
function applyFilter() {
  const q = filterInput.value.trim().toLowerCase();
  const sf = surgeFilter.value;
  document.querySelectorAll('table tbody tr, .cards .card').forEach(el => {
    const name = (el.dataset.name || '').toLowerCase();
    const code = (el.dataset.code || '').toLowerCase();
    const matchQ = !q || name.includes(q) || code.includes(q);
    let matchS = true;
    if (sf === 'closeSurge10') matchS = el.dataset.cs10 === '1';
    else if (sf === 'closeSurge15') matchS = el.dataset.cs15 === '1';
    else if (sf === 'closeSurge20') matchS = el.dataset.cs20 === '1';
    else if (sf === 'closeSurge30') matchS = el.dataset.cs30 === '1';
    else if (sf === 'highSurge10') matchS = el.dataset.hs10 === '1';
    else if (sf === 'highSurge15') matchS = el.dataset.hs15 === '1';
    else if (sf === 'highSurge20') matchS = el.dataset.hs20 === '1';
    else if (sf === 'highSurge30') matchS = el.dataset.hs30 === '1';
    else if (sf === 'preferred') matchS = el.dataset.pref === '1';
    el.style.display = matchQ && matchS ? '' : 'none';
  });
}
filterInput.addEventListener('input', applyFilter);
surgeFilter.addEventListener('change', applyFilter);
</script>
</body>
</html>
`;

const html = htmlTemplate.replace('__JSON_DATA__', JSON.stringify(jsonOut));
fs.writeFileSync(path.join(__dirname, 'qva-surge-day-report.html'), html, 'utf-8');
console.log(`✅ HTML 저장: qva-surge-day-report.html  (Express /qva-surge 라우트로 접근)`);
