const fs = require('fs');
const path = require('path');

const sma = (values, period) => {
  if (!values || values.length < period) return null;
  const sum = values.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
};

const CACHE_DIR = path.join(__dirname, 'cache');
const LONG_CACHE_DIR = path.join(CACHE_DIR, 'stock-charts-long');

const stocksListPath = path.join(CACHE_DIR, 'naver-stocks-list.json');
const stocksList = JSON.parse(fs.readFileSync(stocksListPath, 'utf-8')).stocks;

console.log('📊 compressionRatio 분석\n');
console.log('compressionRatio = (20일 최저가) / (20일 최고가)');
console.log('  → 값이 낮을수록 변동폭이 큼 (압축이 큼)');
console.log('  → 값이 높을수록 변동폭이 작음 (안정적)');
console.log('  → 현재 조건: >= 0.89 (변동폭 11% 이상)\n');

const targets = {
  'cap500to1000': (cap) => cap >= 50_000_000_000 && cap < 100_000_000_000,
  'cap1000to2000': (cap) => cap >= 100_000_000_000 && cap < 200_000_000_000,
  'cap2000to3000': (cap) => cap >= 200_000_000_000 && cap < 300_000_000_000,
};

for (const [range, filter] of Object.entries(targets)) {
  const rangeLabel = {
    'cap500to1000': '500억~1000억',
    'cap1000to2000': '1000억~2000억',
    'cap2000to3000': '2000억~3000억',
  }[range];

  const rangeStocks = stocksList.filter(s => filter(s.marketValue));
  const ratios = [];

  for (const meta of rangeStocks) {
    const code = meta.code;
    let cache = null;

    try {
      cache = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, `${code}.json`), 'utf-8'));
    } catch (_) {
      try {
        cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${code}.json`), 'utf-8'));
      } catch (_) { continue; }
    }

    const rows = cache.rows || [];
    if (rows.length < 20) continue;

    const idx = rows.length - 1;
    const last20rows = rows.slice(Math.max(0, idx - 19), idx + 1);
    const last20high = Math.max(...last20rows.map((r) => r.high || r.close));
    const last20low = Math.min(...last20rows.map((r) => r.low || r.close));
    const compressionRatio = last20high > 0 ? last20low / last20high : 1;

    ratios.push(compressionRatio);
  }

  if (ratios.length === 0) {
    console.log(`${rangeLabel}: 데이터 없음\n`);
    continue;
  }

  ratios.sort((a, b) => a - b);
  const p = (pct) => ratios[Math.floor(ratios.length * pct / 100)];

  const pass089 = ratios.filter(r => r >= 0.89).length;
  const pass100 = ratios.filter(r => r <= 1.00).length;
  const pass110 = ratios.filter(r => r <= 1.10).length;
  const p30 = p(30);
  const passP30 = ratios.filter(r => r <= p30).length;
  const p40 = p(40);
  const passP40 = ratios.filter(r => r <= p40).length;

  console.log(`${rangeLabel}`);
  console.log(`  데이터 있는 종목: ${ratios.length}`);
  console.log(`\ncompressionRatio 분포:`);
  console.log(`  최소: ${Math.min(...ratios).toFixed(4)}`);
  console.log(`  p10:  ${p(10).toFixed(4)}`);
  console.log(`  p25:  ${p(25).toFixed(4)}`);
  console.log(`  중위: ${p(50).toFixed(4)}`);
  console.log(`  p75:  ${p(75).toFixed(4)}`);
  console.log(`  p90:  ${p(90).toFixed(4)}`);
  console.log(`  최대: ${Math.max(...ratios).toFixed(4)}`);
  console.log(`\n조건별 통과 종목:`);
  console.log(`  >= 0.89 (기존): ${pass089} (${(pass089/ratios.length*100).toFixed(0)}%)`);
  console.log(`  <= 1.00: ${pass100} (${(pass100/ratios.length*100).toFixed(0)}%)`);
  console.log(`  <= 1.10: ${pass110} (${(pass110/ratios.length*100).toFixed(0)}%)`);
  console.log(`  <= p30 (${p30.toFixed(4)}): ${passP30} (${(passP30/ratios.length*100).toFixed(0)}%)`);
  console.log(`  <= p40 (${p40.toFixed(4)}): ${passP40} (${(passP40/ratios.length*100).toFixed(0)}%)`);
  console.log('');
}
