const fs = require('fs');
const path = require('path');

const computeATR = (rows, idx, period = 14) => {
  if (!rows || idx < period) return null;
  const trs = [];
  for (let i = idx - period + 1; i <= idx; i++) {
    const curr = rows[i];
    const prev = rows[i - 1];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / period;
};

const sma = (values, period) => {
  if (!values || values.length < period) return null;
  const sum = values.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
};

const CACHE_DIR = path.join(__dirname, 'cache');
const LONG_CACHE_DIR = path.join(CACHE_DIR, 'stock-charts-long');

// 혜인 003010 데이터 확인
console.log('🔍 혜인 (003010) 거래대금 검증\n');

const codeToCheck = '003010';
const meta = { code: codeToCheck, name: '혜인' };

let cache = null;
try {
  cache = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, `${codeToCheck}.json`), 'utf-8'));
} catch (_) {
  try {
    cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${codeToCheck}.json`), 'utf-8'));
  } catch (_) { 
    console.log('데이터 없음');
    process.exit(1);
  }
}

const rows = cache.rows || [];
const idx = rows.length - 1;
const last20rows = rows.slice(Math.max(0, idx - 19), idx + 1);

console.log('20일 데이터:');
last20rows.forEach((r, i) => {
  console.log(`  ${i}: close=${r.close}, valueApprox=${r.valueApprox}`);
});

const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / last20rows.length;

console.log('\n계산:');
console.log(`  valueApprox 합: ${last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0)}`);
console.log(`  valueApprox 개수: ${last20rows.length}`);
console.log(`  평균 (avg20Value): ${avg20Value}`);
console.log(`  단위 변환 (억): ${avg20Value / 1e8}`);
console.log(`  단위 변환 (만): ${avg20Value / 1e4}`);
console.log(`  단위 변환 (천): ${avg20Value / 1e3}`);
console.log('\n필터 판정:');
console.log(`  50억 필터 (5_000_000_000): avg20Value >= 5_000_000_000? ${avg20Value >= 5_000_000_000}`);
console.log(`  30억 필터 (3_000_000_000): avg20Value >= 3_000_000_000? ${avg20Value >= 3_000_000_000}`);
console.log(`  10억 필터 (1_000_000_000): avg20Value >= 1_000_000_000? ${avg20Value >= 1_000_000_000}`);

// 모든 14개 후보의 raw value 재확인
console.log('\n\n📊 전체 후보 거래대금 재검증\n');

const stocksListPath = path.join(CACHE_DIR, 'naver-stocks-list.json');
const stocksList = JSON.parse(fs.readFileSync(stocksListPath, 'utf-8')).stocks;

const candidateCodes = ['071090', '024840', '054540', '102120', '101670', '078150', '199820', '003010', '307180', '147830', '289930', '131400', '396300', '453450'];

for (const code of candidateCodes) {
  let c = null;
  try {
    c = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, `${code}.json`), 'utf-8'));
  } catch (_) {
    try {
      c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${code}.json`), 'utf-8'));
    } catch (_) { continue; }
  }
  
  const rows = c.rows || [];
  const idx = rows.length - 1;
  const last20rows = rows.slice(Math.max(0, idx - 19), idx + 1);
  const avg = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / last20rows.length;
  
  const meta = stocksList.find(s => s.code === code);
  console.log(`${code} ${meta?.name || 'N/A'}`);
  console.log(`  raw: ${avg}`);
  console.log(`  억: ${(avg / 1e8).toFixed(1)}`);
  console.log(`  50억 필터 통과: ${avg >= 5_000_000_000 ? '✓' : '✗'}`);
  console.log('');
}
