/**
 * QVA 단일일 급등 추적 보고서
 *
 * 목적: QVA 신호 이후 20거래일 안에 어느 날 갑자기 확 뛴(+10%↑ 단일일) 종목이 있었는지 확인
 * 기존 qva-full-month-tracking-report.js (최고점 도달 추적)와는 별개의 보고서.
 * 최고점이 아닌 '단일일 급등' 사건만을 추적한다.
 *
 * 급등 정의: dailyReturn = (today.close / prev.close - 1) * 100 >= 10%
 */

const fs = require('fs');
const path = require('path');

const LONG_CACHE_DIR = path.join(__dirname, 'cache', 'stock-charts-long');

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
// 신호일 이후 D+1 ~ D+20 사이에서 dailyReturn 가장 큰 날을 best surge day로 선정.
// best surge가 +10% 미만이면 hit10=false 등으로 카운트 (그래도 데이터는 보관).
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

  // 추적 창에서 가장 큰 단일일 수익률 찾기
  let bestReturn = -Infinity;
  let bestDay = null;
  for (let d = 1; d <= 20; d++) {
    const prev = window[d - 1];
    const today = window[d];
    if (!prev || !today || prev.close <= 0) continue;
    const dailyReturn = (today.close / prev.close - 1) * 100;
    if (dailyReturn > bestReturn) {
      bestReturn = dailyReturn;
      bestDay = { d, prev, today };
    }
  }
  if (!bestDay) return null;

  // best surge day 직전까지의 최저점 → 신호가 대비 최대 하락률
  let preSurgeMinLow = signalRow.close;
  for (let i = 0; i < bestDay.d; i++) {
    const lo = window[i].low;
    if (lo > 0 && lo < preSurgeMinLow) preSurgeMinLow = lo;
  }
  const preSurgeMaxDrop = (preSurgeMinLow / signalRow.close - 1) * 100;

  const surgeValue = bestDay.today.valueApprox || bestDay.today.close * bestDay.today.volume;
  const surgeValueRatio = avg20Value > 0 ? surgeValue / avg20Value : 0;
  const returnFromSignal = (bestDay.today.close / signalRow.close - 1) * 100;

  return {
    signalDate: signalRow.date,
    signalPrice: signalRow.close,
    surgeDate: bestDay.today.date,
    daysToSurge: bestDay.d,
    prevClose: bestDay.prev.close,
    surgeClose: bestDay.today.close,
    bestSingleDayReturn: bestReturn,
    returnFromSignal,
    surgeValue,
    surgeValueRatio,
    preSurgeMaxDrop,
    hit10: bestReturn >= 10,
    hit15: bestReturn >= 15,
    hit20: bestReturn >= 20,
    hit30: bestReturn >= 30,
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

console.log(`\n📊 QVA 단일일 급등 추적 보고서`);
console.log(`기간: ${formatDate(testDates[0])} ~ ${formatDate(testDates[testDates.length - 1])}`);
console.log(`신호일 ${testDates.length}개 | 추적: D+1 ~ D+20`);
console.log(`급등 기준: 단일일 종가 +10% 이상 (전일 종가 대비)\n`);

const allSignalsByDate = {};
const allStats = [];

testDates.forEach(testDate => {
  const allStocks = [];
  const surgedStocks = [];

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

      const entry = {
        code,
        name: data.name,
        market: code.startsWith('3') || code.startsWith('1') || code.startsWith('9') ? 'KOSDAQ' : 'KOSPI',
        ...result,
      };
      allStocks.push(entry);
      if (entry.hit10) surgedStocks.push(entry);
    } catch (e) {
      // skip
    }
  });

  console.log(`\n${'='.repeat(120)}`);
  console.log(`\n📈 ${formatDate(testDate)} | QVA 신호 ${allStocks.length}개 | +10% 단일일 급등 ${surgedStocks.length}개\n`);

  if (allStocks.length === 0) {
    console.log('신호 없음\n');
    return;
  }

  const hit10 = allStocks.filter(s => s.hit10).length;
  const hit15 = allStocks.filter(s => s.hit15).length;
  const hit20 = allStocks.filter(s => s.hit20).length;
  const hit30 = allStocks.filter(s => s.hit30).length;
  const avgSurgeReturn = surgedStocks.length
    ? surgedStocks.reduce((a, b) => a + b.bestSingleDayReturn, 0) / surgedStocks.length
    : 0;
  const avgDaysToSurge = surgedStocks.length
    ? surgedStocks.reduce((a, b) => a + b.daysToSurge, 0) / surgedStocks.length
    : 0;

  console.log(`💡 통계`);
  console.log(`  hit10 (+10%↑): ${hit10}/${allStocks.length} (${(hit10 / allStocks.length * 100).toFixed(0)}%)`);
  console.log(`  hit15 (+15%↑): ${hit15}/${allStocks.length} (${(hit15 / allStocks.length * 100).toFixed(0)}%)`);
  console.log(`  hit20 (+20%↑): ${hit20}/${allStocks.length} (${(hit20 / allStocks.length * 100).toFixed(0)}%)`);
  console.log(`  hit30 (+30%↑): ${hit30}/${allStocks.length} (${(hit30 / allStocks.length * 100).toFixed(0)}%)`);
  if (surgedStocks.length > 0) {
    console.log(`  평균 단일일 급등률 (hit10 기준): +${avgSurgeReturn.toFixed(2)}%`);
    console.log(`  평균 급등 소요일수 (hit10 기준): D+${avgDaysToSurge.toFixed(1)}\n`);
  } else {
    console.log(`  +10% 이상 급등 종목 없음\n`);
  }

  // 정렬: (1) bestSingleDayReturn desc, (2) daysToSurge asc, (3) returnFromSignal desc
  surgedStocks.sort((a, b) => {
    if (b.bestSingleDayReturn !== a.bestSingleDayReturn) return b.bestSingleDayReturn - a.bestSingleDayReturn;
    if (a.daysToSurge !== b.daysToSurge) return a.daysToSurge - b.daysToSurge;
    return b.returnFromSignal - a.returnFromSignal;
  });

  if (surgedStocks.length > 0) {
    const N = Math.min(15, surgedStocks.length);
    console.log(`📋 +10%↑ 급등 종목 상위 ${N}개`);
    console.log(`| # | 종목 | 코드 | 신호일 | 신호가 | 급등일 | D+ | 전일종가 | 급등종가 | 일간% | 신호대비% | 거래대금(억) | 거래대금/20일평균 | 급등전MDD% |`);
    console.log(`|---|------|------|--------|--------|--------|----|---------|---------|------|---------|-----------|-------------|--------|`);
    surgedStocks.slice(0, N).forEach((s, i) => {
      const sign = s.returnFromSignal >= 0 ? '+' : '';
      console.log(
        `| ${i + 1} | ${(s.name || '').padEnd(8)} | ${s.code} | ${formatDate(s.signalDate)} | ${s.signalPrice.toLocaleString()}원 | ` +
        `${formatDate(s.surgeDate)} | D+${s.daysToSurge} | ${s.prevClose.toLocaleString()}원 | ${s.surgeClose.toLocaleString()}원 | ` +
        `+${s.bestSingleDayReturn.toFixed(2)}% | ${sign}${s.returnFromSignal.toFixed(2)}% | ` +
        `${(s.surgeValue / 1e8).toFixed(0)}억 | ${s.surgeValueRatio.toFixed(2)}x | ${s.preSurgeMaxDrop.toFixed(2)}% |`
      );
    });
    console.log('');
  }

  allStats.push({
    date: testDate,
    totalSignals: allStocks.length,
    hit10, hit15, hit20, hit30,
    avgSurgeReturn,
    avgDaysToSurge,
  });
  allSignalsByDate[testDate] = { all: allStocks, surged: surgedStocks };
});

// ---------- 전체 요약 ----------
console.log(`\n\n${'='.repeat(120)}\n`);
console.log(`📊 전체 요약 (${testDates.length}개 신호일 합산)\n`);

const totalSignals = allStats.reduce((a, b) => a + b.totalSignals, 0);
const totalHit10 = allStats.reduce((a, b) => a + b.hit10, 0);
const totalHit15 = allStats.reduce((a, b) => a + b.hit15, 0);
const totalHit20 = allStats.reduce((a, b) => a + b.hit20, 0);
const totalHit30 = allStats.reduce((a, b) => a + b.hit30, 0);

const allSurged = Object.values(allSignalsByDate).flatMap(o => o.surged);
const avgDaysToSurgeAll = allSurged.length
  ? allSurged.reduce((a, b) => a + b.daysToSurge, 0) / allSurged.length
  : 0;

let fastest = null;
let biggest = null;
for (const s of allSurged) {
  // 가장 빠른 급등: daysToSurge 최소, 동률이면 bestSingleDayReturn 큰 것
  if (!fastest ||
      s.daysToSurge < fastest.daysToSurge ||
      (s.daysToSurge === fastest.daysToSurge && s.bestSingleDayReturn > fastest.bestSingleDayReturn)) {
    fastest = s;
  }
  if (!biggest || s.bestSingleDayReturn > biggest.bestSingleDayReturn) biggest = s;
}

const pctOf = (n, d) => d > 0 ? (n / d * 100).toFixed(1) : '0.0';

console.log(`전체 QVA 신호: ${totalSignals}개`);
console.log(`+10% 이상 단일일 급등: ${totalHit10}개 (${pctOf(totalHit10, totalSignals)}%)`);
console.log(`+15% 이상: ${totalHit15}개 (${pctOf(totalHit15, totalSignals)}%)`);
console.log(`+20% 이상: ${totalHit20}개 (${pctOf(totalHit20, totalSignals)}%)`);
console.log(`+30% 이상: ${totalHit30}개 (${pctOf(totalHit30, totalSignals)}%)`);
console.log(`평균 급등 소요일수 (hit10 기준): D+${avgDaysToSurgeAll.toFixed(1)}\n`);

if (fastest) {
  console.log(`⚡ 가장 빠른 급등: ${fastest.name} (${fastest.code})`);
  console.log(`   신호일 ${formatDate(fastest.signalDate)} → 급등일 ${formatDate(fastest.surgeDate)} (D+${fastest.daysToSurge}) | +${fastest.bestSingleDayReturn.toFixed(2)}%`);
}
if (biggest) {
  console.log(`🚀 가장 큰 단일일 급등: ${biggest.name} (${biggest.code})`);
  console.log(`   신호일 ${formatDate(biggest.signalDate)} → 급등일 ${formatDate(biggest.surgeDate)} (D+${biggest.daysToSurge}) | +${biggest.bestSingleDayReturn.toFixed(2)}%`);
}
console.log('');

// 신호일별 통계 표
console.log(`\n📈 신호일별 단일일 급등 통계\n`);
console.log(`| 신호일 | 신호수 | hit10 | hit15 | hit20 | hit30 | 평균 D+ |`);
console.log(`|--------|--------|--------|--------|--------|--------|--------|`);
allStats.forEach(stat => {
  const r = (n) => stat.totalSignals > 0 ? `${(n / stat.totalSignals * 100).toFixed(0)}%` : '-';
  console.log(
    `| ${formatDate(stat.date)} | ${stat.totalSignals.toString().padStart(5)}개 | ` +
    `${r(stat.hit10)} | ${r(stat.hit15)} | ${r(stat.hit20)} | ${r(stat.hit30)} | ` +
    `${stat.hit10 > 0 ? 'D+' + stat.avgDaysToSurge.toFixed(1) : '-'} |`
  );
});

// JSON 저장
const jsonOut = {
  meta: {
    purpose: "QVA 신호 후 20거래일 안에 단일일 +10% 이상 급등 발생 여부 추적",
    surgeThresholdPct: 10,
    trackingDays: 20,
    signalDates: testDates,
    generatedAt: new Date().toISOString(),
  },
  summary: {
    totalSignals,
    hit10: totalHit10,
    hit15: totalHit15,
    hit20: totalHit20,
    hit30: totalHit30,
    hit10Rate: parseFloat(pctOf(totalHit10, totalSignals)),
    hit15Rate: parseFloat(pctOf(totalHit15, totalSignals)),
    hit20Rate: parseFloat(pctOf(totalHit20, totalSignals)),
    hit30Rate: parseFloat(pctOf(totalHit30, totalSignals)),
    avgDaysToSurge: parseFloat(avgDaysToSurgeAll.toFixed(2)),
    fastest: fastest ? {
      code: fastest.code, name: fastest.name,
      signalDate: fastest.signalDate, surgeDate: fastest.surgeDate,
      daysToSurge: fastest.daysToSurge,
      bestSingleDayReturn: parseFloat(fastest.bestSingleDayReturn.toFixed(2)),
    } : null,
    biggest: biggest ? {
      code: biggest.code, name: biggest.name,
      signalDate: biggest.signalDate, surgeDate: biggest.surgeDate,
      daysToSurge: biggest.daysToSurge,
      bestSingleDayReturn: parseFloat(biggest.bestSingleDayReturn.toFixed(2)),
    } : null,
  },
  signalDates: allStats.map(stat => ({
    date: stat.date,
    totalSignals: stat.totalSignals,
    hit10: stat.hit10,
    hit15: stat.hit15,
    hit20: stat.hit20,
    hit30: stat.hit30,
    avgSurgeReturn: parseFloat(stat.avgSurgeReturn.toFixed(2)),
    avgDaysToSurge: parseFloat(stat.avgDaysToSurge.toFixed(2)),
    stocks: (allSignalsByDate[stat.date]?.all || [])
      .slice()
      .sort((a, b) => {
        if (b.bestSingleDayReturn !== a.bestSingleDayReturn) return b.bestSingleDayReturn - a.bestSingleDayReturn;
        if (a.daysToSurge !== b.daysToSurge) return a.daysToSurge - b.daysToSurge;
        return b.returnFromSignal - a.returnFromSignal;
      })
      .map(s => ({
        code: s.code,
        name: s.name,
        market: s.market,
        signalDate: s.signalDate,
        signalPrice: s.signalPrice,
        surgeDate: s.surgeDate,
        daysToSurge: s.daysToSurge,
        prevClose: s.prevClose,
        surgeClose: s.surgeClose,
        bestSingleDayReturn: parseFloat(s.bestSingleDayReturn.toFixed(2)),
        returnFromSignal: parseFloat(s.returnFromSignal.toFixed(2)),
        surgeValue: Math.round(s.surgeValue),
        surgeValueRatio: parseFloat(s.surgeValueRatio.toFixed(2)),
        preSurgeMaxDrop: parseFloat(s.preSurgeMaxDrop.toFixed(2)),
        hit10: s.hit10, hit15: s.hit15, hit20: s.hit20, hit30: s.hit30,
      })),
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
<title>QVA 단일일 급등 추적 보고서</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
  h1 { color: #f1f5f9; margin: 0 0 4px 0; font-size: 24px; }
  h2 { color: #f1f5f9; margin: 32px 0 12px 0; font-size: 18px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
  .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 20px; }
  .summary { background: #1e293b; padding: 16px 20px; border-radius: 8px; margin-bottom: 20px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .stat { background: #0f172a; padding: 10px 14px; border-radius: 6px; }
  .stat-label { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { color: #f1f5f9; font-size: 18px; font-weight: 600; margin-top: 2px; }
  .stat-value .pct { color: #10b981; font-size: 13px; font-weight: 400; margin-left: 6px; }
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
  .date-stats span { margin-right: 16px; }
  .date-stats .hit { color: #10b981; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #334155; white-space: nowrap; }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2), th:nth-child(3), td:nth-child(3) { text-align: left; }
  th { background: #283447; color: #cbd5e1; font-weight: 600; cursor: pointer; user-select: none; position: sticky; top: 0; }
  th:hover { background: #334155; }
  th.sorted-asc::after { content: " ▲"; color: #60a5fa; }
  th.sorted-desc::after { content: " ▼"; color: #60a5fa; }
  tr:hover { background: #283447; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-left: 2px; }
  .badge.h10 { background: #064e3b; color: #6ee7b7; }
  .badge.h15 { background: #14532d; color: #86efac; }
  .badge.h20 { background: #166534; color: #bbf7d0; }
  .badge.h30 { background: #f59e0b; color: #1e293b; }
  .pos { color: #10b981; }
  .neg { color: #f87171; }
  .muted { color: #64748b; }
  .market-K { color: #60a5fa; }
  .market-Q { color: #c084fc; }
  .empty { padding: 18px; color: #64748b; text-align: center; font-size: 13px; }

  /* 모바일: 카드 레이아웃 */
  .cards { display: none; padding: 6px 10px 12px 10px; }
  .card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .card-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .card-head .name { font-weight: 700; font-size: 15px; }
  .card-head .meta { color: #64748b; font-size: 11px; margin-left: auto; }
  .card-headline { display: flex; align-items: baseline; gap: 10px; padding: 6px 0 10px 0; border-bottom: 1px dashed #334155; margin-bottom: 10px; }
  .card-headline .big-pct { font-size: 28px; font-weight: 700; }
  .card-headline .surge-when { color: #cbd5e1; font-size: 13px; }
  .card-body { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 12px; }
  .card-body .lbl { color: #64748b; }
  .card-body .val { color: #e2e8f0; text-align: right; }
  @media (max-width: 640px) {
    body { padding: 12px; }
    h1 { font-size: 19px; }
    h2 { font-size: 15px; margin-top: 24px; }
    .subtitle { font-size: 11px; }
    .summary { padding: 12px; }
    .stat-value { font-size: 15px; }
    .stat-label { font-size: 10px; }
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
  <h1>📊 QVA 단일일 급등 추적 보고서</h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="summary">
    <div class="summary-grid" id="summary-grid"></div>
  </div>

  <div id="highlights"></div>

  <h2>신호일별 상세</h2>
  <div class="controls">
    <input type="text" id="filter" placeholder="종목명 또는 코드 검색…">
    <select id="hit-filter">
      <option value="all">전체</option>
      <option value="hit10">+10% 이상만</option>
      <option value="hit15">+15% 이상만</option>
      <option value="hit20">+20% 이상만</option>
      <option value="hit30">+30% 이상만</option>
    </select>
  </div>

  <div id="dates"></div>

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
  if (s.hit30) b += '<span class="badge h30">30+</span>';
  else if (s.hit20) b += '<span class="badge h20">20+</span>';
  else if (s.hit15) b += '<span class="badge h15">15+</span>';
  else if (s.hit10) b += '<span class="badge h10">10+</span>';
  return b;
}
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }

// 헤더
document.getElementById('subtitle').textContent =
  '기간: ' + fmtDate(DATA.meta.signalDates[0]) + ' ~ ' + fmtDate(DATA.meta.signalDates[DATA.meta.signalDates.length - 1]) +
  ' | 신호일 ' + DATA.meta.signalDates.length + '개 | 추적: D+1 ~ D+' + DATA.meta.trackingDays +
  ' | 급등 기준: 단일일 +' + DATA.meta.surgeThresholdPct + '% 이상 (전일 종가 대비)' +
  ' | 생성: ' + DATA.meta.generatedAt.slice(0, 19).replace('T', ' ');

// 요약
const sum = DATA.summary;
const grid = document.getElementById('summary-grid');
grid.innerHTML = [
  ['전체 QVA 신호', sum.totalSignals + '개'],
  ['+10% 단일일 급등', sum.hit10 + '개', sum.hit10Rate + '%'],
  ['+15% 이상', sum.hit15 + '개', sum.hit15Rate + '%'],
  ['+20% 이상', sum.hit20 + '개', sum.hit20Rate + '%'],
  ['+30% 이상', sum.hit30 + '개', sum.hit30Rate + '%'],
  ['평균 급등 소요', 'D+' + sum.avgDaysToSurge.toFixed(1)],
].map(([label, val, pct]) =>
  '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value">' + val +
  (pct ? '<span class="pct">' + pct + '</span>' : '') + '</div></div>'
).join('');

// 하이라이트
const hl = document.getElementById('highlights');
let hlHtml = '';
if (sum.fastest) {
  hlHtml += '<div class="highlight">⚡ <strong>가장 빠른 급등</strong> · <span class="name">' + sum.fastest.name +
    '</span> (' + sum.fastest.code + ') · 신호일 ' + fmtDate(sum.fastest.signalDate) +
    ' → 급등일 ' + fmtDate(sum.fastest.surgeDate) + ' (D+' + sum.fastest.daysToSurge + ') · ' +
    fmtPct(sum.fastest.bestSingleDayReturn, true) + '</div>';
}
if (sum.biggest) {
  hlHtml += '<div class="highlight">🚀 <strong>가장 큰 단일일 급등</strong> · <span class="name">' + sum.biggest.name +
    '</span> (' + sum.biggest.code + ') · 신호일 ' + fmtDate(sum.biggest.signalDate) +
    ' → 급등일 ' + fmtDate(sum.biggest.surgeDate) + ' (D+' + sum.biggest.daysToSurge + ') · ' +
    fmtPct(sum.biggest.bestSingleDayReturn, true) + '</div>';
}
hl.innerHTML = hlHtml;

// 컬럼 정의
const COLS = [
  { key: 'name', label: '종목', type: 'str', render: (s) => '<span class="' + marketCls(s.market) + '">' + (s.name || '') + '</span>' + badges(s) },
  { key: 'code', label: '코드', type: 'str' },
  { key: 'market', label: '시장', type: 'str' },
  { key: 'signalPrice', label: '신호가', type: 'num', render: (s) => fmtNum(s.signalPrice) + '원' },
  { key: 'surgeDate', label: '급등일', type: 'str', render: (s) => fmtDate(s.surgeDate) },
  { key: 'daysToSurge', label: 'D+', type: 'num', render: (s) => 'D+' + s.daysToSurge },
  { key: 'prevClose', label: '전일종가', type: 'num', render: (s) => fmtNum(s.prevClose) + '원' },
  { key: 'surgeClose', label: '급등종가', type: 'num', render: (s) => fmtNum(s.surgeClose) + '원' },
  { key: 'bestSingleDayReturn', label: '일간%', type: 'num', render: (s) => fmtPct(s.bestSingleDayReturn, true) },
  { key: 'returnFromSignal', label: '신호대비%', type: 'num', render: (s) => fmtPct(s.returnFromSignal, true) },
  { key: 'surgeValue', label: '거래대금', type: 'num', render: (s) => fmtValueOk(s.surgeValue) },
  { key: 'surgeValueRatio', label: '거래대금배수', type: 'num', render: (s) => s.surgeValueRatio.toFixed(2) + 'x' },
  { key: 'preSurgeMaxDrop', label: '급등전MDD%', type: 'num', render: (s) => fmtPct(s.preSurgeMaxDrop) },
];

// 신호일별 렌더
const datesEl = document.getElementById('dates');
DATA.signalDates.forEach((d, idx) => {
  const det = document.createElement('details');
  if (idx < 2) det.open = true;
  const sumEl = document.createElement('summary');
  sumEl.innerHTML = fmtDate(d.date) + ' · 신호 ' + d.totalSignals + '개 · ' +
    '<span class="hit" style="color:#10b981">+10% ' + d.hit10 + '</span> / +15% ' + d.hit15 +
    ' / +20% ' + d.hit20 + ' / +30% ' + d.hit30 +
    (d.hit10 > 0 ? ' · 평균 D+' + d.avgDaysToSurge.toFixed(1) : '');
  det.appendChild(sumEl);

  const stats = document.createElement('div');
  stats.className = 'date-stats';
  stats.innerHTML = '<span>총 ' + d.totalSignals + '개</span>' +
    '<span class="hit">hit10: ' + (d.totalSignals ? (d.hit10/d.totalSignals*100).toFixed(0) : 0) + '%</span>' +
    '<span class="hit">hit15: ' + (d.totalSignals ? (d.hit15/d.totalSignals*100).toFixed(0) : 0) + '%</span>' +
    '<span class="hit">hit20: ' + (d.totalSignals ? (d.hit20/d.totalSignals*100).toFixed(0) : 0) + '%</span>' +
    '<span class="hit">hit30: ' + (d.totalSignals ? (d.hit30/d.totalSignals*100).toFixed(0) : 0) + '%</span>';
  det.appendChild(stats);

  if (d.stocks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '신호 종목 없음';
    det.appendChild(empty);
  } else {
    const tbl = document.createElement('table');
    tbl.dataset.date = d.date;
    const thead = '<thead><tr>' + COLS.map((c, i) => '<th data-col="' + i + '">' + c.label + '</th>').join('') + '</tr></thead>';
    const tbody = '<tbody>' + d.stocks.map(s =>
      '<tr data-name="' + (s.name || '') + '" data-code="' + s.code +
      '" data-h10="' + (s.hit10 ? 1 : 0) + '" data-h15="' + (s.hit15 ? 1 : 0) +
      '" data-h20="' + (s.hit20 ? 1 : 0) + '" data-h30="' + (s.hit30 ? 1 : 0) + '">' +
      COLS.map(c => '<td>' + (c.render ? c.render(s) : s[c.key]) + '</td>').join('') +
      '</tr>'
    ).join('') + '</tbody>';
    tbl.innerHTML = thead + tbody;
    det.appendChild(tbl);

    // 모바일 카드 (같은 데이터, 다른 레이아웃)
    const cards = document.createElement('div');
    cards.className = 'cards';
    cards.innerHTML = d.stocks.map(s => {
      const pctCls = s.bestSingleDayReturn > 0 ? 'pos' : (s.bestSingleDayReturn < 0 ? 'neg' : 'muted');
      const pctSign = s.bestSingleDayReturn > 0 ? '+' : '';
      const fromSignSign = s.returnFromSignal > 0 ? '+' : '';
      const fromSignCls = s.returnFromSignal > 0 ? 'pos' : (s.returnFromSignal < 0 ? 'neg' : 'muted');
      const mddCls = s.preSurgeMaxDrop < 0 ? 'neg' : 'muted';
      return '<div class="card" data-name="' + (s.name || '') + '" data-code="' + s.code +
        '" data-h10="' + (s.hit10 ? 1 : 0) + '" data-h15="' + (s.hit15 ? 1 : 0) +
        '" data-h20="' + (s.hit20 ? 1 : 0) + '" data-h30="' + (s.hit30 ? 1 : 0) + '">' +
        '<div class="card-head">' +
          '<span class="name ' + marketCls(s.market) + '">' + (s.name || '') + '</span>' +
          badges(s) +
          '<span class="meta">' + s.market + ' · ' + s.code + '</span>' +
        '</div>' +
        '<div class="card-headline">' +
          '<span class="big-pct ' + pctCls + '">' + pctSign + s.bestSingleDayReturn.toFixed(2) + '%</span>' +
          '<span class="surge-when">' + fmtDate(s.surgeDate) + ' · D+' + s.daysToSurge + '</span>' +
        '</div>' +
        '<div class="card-body">' +
          '<span class="lbl">신호가</span><span class="val">' + fmtNum(s.signalPrice) + '원 (' + fmtDate(s.signalDate) + ')</span>' +
          '<span class="lbl">전일종가 → 급등종가</span><span class="val">' + fmtNum(s.prevClose) + '원 → ' + fmtNum(s.surgeClose) + '원</span>' +
          '<span class="lbl">신호대비</span><span class="val ' + fromSignCls + '">' + fromSignSign + s.returnFromSignal.toFixed(2) + '%</span>' +
          '<span class="lbl">거래대금</span><span class="val">' + (s.surgeValue / 1e8).toFixed(0) + '억 (' + s.surgeValueRatio.toFixed(2) + 'x)</span>' +
          '<span class="lbl">급등 전 MDD</span><span class="val ' + mddCls + '">' + s.preSurgeMaxDrop.toFixed(2) + '%</span>' +
        '</div>' +
      '</div>';
    }).join('');
    det.appendChild(cards);
  }
  datesEl.appendChild(det);
});

// 정렬
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
      const dateRec = DATA.signalDates.find(x => x.date === dateKey);
      const stocksByCode = Object.fromEntries(dateRec.stocks.map(s => [s.code, s]));
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
const hitFilter = document.getElementById('hit-filter');
function applyFilter() {
  const q = filterInput.value.trim().toLowerCase();
  const hf = hitFilter.value;
  document.querySelectorAll('table tbody tr, .cards .card').forEach(el => {
    const name = (el.dataset.name || '').toLowerCase();
    const code = (el.dataset.code || '').toLowerCase();
    const matchQ = !q || name.includes(q) || code.includes(q);
    let matchH = true;
    if (hf === 'hit10') matchH = el.dataset.h10 === '1';
    else if (hf === 'hit15') matchH = el.dataset.h15 === '1';
    else if (hf === 'hit20') matchH = el.dataset.h20 === '1';
    else if (hf === 'hit30') matchH = el.dataset.h30 === '1';
    el.style.display = matchQ && matchH ? '' : 'none';
  });
}
filterInput.addEventListener('input', applyFilter);
hitFilter.addEventListener('change', applyFilter);
</script>
</body>
</html>
`;

const html = htmlTemplate.replace('__JSON_DATA__', JSON.stringify(jsonOut));
fs.writeFileSync(path.join(__dirname, 'qva-surge-day-report.html'), html, 'utf-8');
console.log(`✅ HTML 저장: qva-surge-day-report.html  (Express /qva-surge 라우트로 접근)`);
