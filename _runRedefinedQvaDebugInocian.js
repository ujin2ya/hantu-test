/**
 * 이노션 214320 — 새 QVA(저점권 거래대금 돌파) 재정의 모델로 2026-04-10 검사
 * 사용자 요청 지표 전부 출력.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const CODE = '214320';
const TARGET_DATE = '20260410';

const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const meta = stocksList.stocks.find(s => s.code === CODE);
if (!meta) { console.error('meta not found for', CODE); process.exit(1); }

const chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, `${CODE}.json`), 'utf-8'));
const rows = chart.rows || [];
const tIdx = rows.findIndex(r => r.date === TARGET_DATE);
if (tIdx < 0) { console.error('target date not found', TARGET_DATE); process.exit(1); }

const sliced = rows.slice(0, tIdx + 1);
const namedMeta = { ...meta, name: meta.name || chart.name };

const res = ps.calculateRedefinedQVA(sliced, [], namedMeta);

const today = rows[tIdx];
const prev = rows[tIdx - 1];

console.log('━'.repeat(70));
console.log(`📍 ${chart.name || meta.name} (${CODE}) — ${TARGET_DATE} 새 QVA(저점권 거래대금 돌파) 검증`);
console.log('━'.repeat(70));
console.log('\n[당일 캔들]');
console.log(`  시 ${today.open?.toLocaleString()}  고 ${today.high?.toLocaleString()}  저 ${today.low?.toLocaleString()}  종 ${today.close?.toLocaleString()}`);
console.log(`  전일 종가 ${prev?.close?.toLocaleString()}  변동 ${((today.close / prev.close - 1) * 100).toFixed(2)}%`);
console.log(`  거래량 ${today.volume?.toLocaleString()}주  거래대금 ${(today.valueApprox / 1e8).toFixed(1)}억원`);

if (!res) { console.log('\n❌ 결과 null (데이터 부족 등)'); process.exit(0); }

const s = res.signals || {};
console.log('\n[가격 위치]');
console.log(`  returnFromLow20  ${s.returnFromLow20}%  (≤ 20 통과)`);
console.log(`  returnFromLow60  ${s.returnFromLow60}%  (≤ 25 통과)`);
console.log(`  return5          ${s.ret5}%  (≤ 15 통과)`);
console.log(`  return10         ${s.ret10}%  (≤ 20 통과)`);
console.log(`  return20         ${s.ret20}%  (≤ 25 통과)`);

console.log('\n[거래대금 / 거래량 — prev20 비교]');
console.log(`  todayValue              ${(s.todayValue / 1e8).toFixed(2)}억`);
console.log(`  prev20ValueMedian       ${(s.medianPrev20Value / 1e8).toFixed(2)}억`);
console.log(`  prev20ValueMax          ${(s.maxPrev20Value / 1e8).toFixed(2)}억`);
console.log(`  todayValue / median     ×${s.valueRatioMedian}  (≥ 2.5 통과)`);
console.log(`  todayValue / max        ×${s.valueRatioMax}  (≥ 1.1 통과 — median OR max 둘 중 하나만)`);
console.log(`  todayVolume             ${s.todayVolume?.toLocaleString()}주`);
console.log(`  prev20VolumeMedian      ${s.medianPrev20Volume?.toLocaleString()}주`);
console.log(`  todayVolume / median    ×${s.volumeRatioMedian}  (≥ 2.0 통과)`);

console.log('\n[종가 강도]');
console.log(`  closeLocation     ${(s.closeLocation * 100).toFixed(0)}%  (≥ 45 통과)`);
console.log(`  upperWickRatio    ${(s.upperWickRatio * 100).toFixed(0)}%  (≤ 55 통과)`);
console.log(`  close vs prevClose  ${((s.close / s.prevClose - 1) * 100).toFixed(2)}%  (≥ -1% 통과)`);

console.log('\n[조건별 통과]');
const c = res.checks || {};
console.log(`  lowZone        ${c.lowZone ? '✅' : '❌'}`);
console.log(`  valueBreak     ${c.valueBreak ? '✅' : '❌'}`);
console.log(`  volumeBreak    ${c.volumeBreak ? '✅' : '❌'}`);
console.log(`  notExtended    ${c.notExtended ? '✅' : '❌'}`);
console.log(`  notWeakClose   ${c.notWeakClose ? '✅' : '❌'}`);

console.log('\n[최종]');
console.log(`  qvaSignalPassed ${res.passed ? '✅ PASS' : '❌ REJECT'}  score ${res.score}  ${res.gradeLabel || ''}`);
if (!res.passed) {
  console.log(`\n  failedReasons:`);
  res.excludeReasons.forEach(r => console.log(`    - ${r}`));
}

console.log('\n━'.repeat(35));
console.log('참고: 기존 D안(Early QVA) 비교\n');
const oldRes = ps.calculateEarlyQVA(sliced, [], namedMeta);
console.log(`  D안 결과: ${oldRes?.passed ? '✅ pass' : '❌ reject'}  score ${oldRes?.score || 0}`);
if (oldRes && !oldRes.passed) {
  console.log(`  사유: ${(oldRes.excludeReasons || []).slice(0, 3).join(' / ')}`);
}
console.log('');
