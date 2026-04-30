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
const stocksListPath = path.join(CACHE_DIR, 'naver-stocks-list.json');
const stocksList = JSON.parse(fs.readFileSync(stocksListPath, 'utf-8')).stocks;

// p60/p70 임계값 계산
const compressionThresholds = {};
const targets = {
  'cap500to1000': (cap) => cap >= 50_000_000_000 && cap < 100_000_000_000,
  'cap1000to2000': (cap) => cap >= 100_000_000_000 && cap < 200_000_000_000,
  'cap2000to3000': (cap) => cap >= 200_000_000_000 && cap < 300_000_000_000,
};

for (const [range, filter] of Object.entries(targets)) {
  const ratios = [];
  const rangeStocks = stocksList.filter(s => filter(s.marketValue));
  
  for (const meta of rangeStocks) {
    let cache = null;
    try {
      cache = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, `${meta.code}.json`), 'utf-8'));
    } catch (_) {
      try {
        cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${meta.code}.json`), 'utf-8'));
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
  
  if (ratios.length > 0) {
    ratios.sort((a, b) => a - b);
    compressionThresholds[range] = {
      p60: ratios[Math.floor(ratios.length * 0.60)],
      p70: ratios[Math.floor(ratios.length * 0.70)],
    };
  }
}

// 테스트 함수
const testSmallCsb = (conditionTest, rangeLabel) => {
  const ready = { total: 0, byRange: {} };
  const watch = { total: 0, byRange: {} };
  
  for (const [range, filter] of Object.entries(targets)) {
    const rangeStocks = stocksList.filter(s => filter(s.marketValue));
    let readyCount = 0, watchCount = 0;
    
    for (const meta of rangeStocks) {
      let cache = null;
      try {
        cache = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, `${meta.code}.json`), 'utf-8'));
      } catch (_) {
        try {
          cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${meta.code}.json`), 'utf-8'));
        } catch (_) { continue; }
      }
      
      const rows = cache.rows || [];
      if (rows.length < 60) continue;
      
      const idx = rows.length - 1;
      const close = rows[idx].close;
      const last20rows = rows.slice(Math.max(0, idx - 19), idx + 1);
      const last5rows = rows.slice(Math.max(0, idx - 4), idx + 1);
      const last60rows = rows.slice(Math.max(0, idx - 59), idx + 1);
      
      // 거래대금 50억 이상
      const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / last20rows.length;
      if (avg20Value < 5_000_000_000) continue;
      
      // ATR <= 25%
      const atr = computeATR(rows, idx, 14);
      const atrPct = atr / close;
      if (atrPct > 0.25) continue;
      
      // 지지 확인 (strict)
      const ma20 = sma(last20rows.map((r) => r.close), 20);
      const ma60 = sma(last60rows.map((r) => r.close), 60);
      const supportConfirmed = (ma20 > 0 && close >= ma20 * 0.95) || (ma60 > 0 && close >= ma60 * 0.92);
      if (!supportConfirmed) continue;
      
      // 거래대금 재활성
      const avg5Value = last5rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / last5rows.length;
      const valueRatio = avg20Value > 0 ? avg5Value / avg20Value : 0;
      if (valueRatio < 0.9) continue;
      
      // 압축 형성 (조건에 따라)
      const last20high = Math.max(...last20rows.map((r) => r.high || r.close));
      const last20low = Math.min(...last20rows.map((r) => r.low || r.close));
      const compressionRatio = last20high > 0 ? last20low / last20high : 1;
      const compressionFormed = conditionTest(compressionRatio, range);
      if (!compressionFormed) continue;
      
      // 돌파 대기
      const distFromHigh20 = last20high > 0 ? (last20high - close) / last20high : 1;
      const breakoutReady = distFromHigh20 <= 0.12;
      
      const condCount = 1 + 1 + 1 + (breakoutReady ? 1 : 0);
      if (condCount >= 4) readyCount++;
      if (condCount >= 3) watchCount++;
    }
    
    ready.byRange[range] = readyCount;
    watch.byRange[range] = watchCount;
    ready.total += readyCount;
    watch.total += watchCount;
  }
  
  return { ready, watch };
};

console.log('🔬 압축 조건 실험 (수정)\n');
console.log('compressionRatio = 20일 최저가 / 20일 최고가');
console.log('  높을수록 = 변동폭 작음 = 압축 상태\n');

console.log('= A1 (기존: >= 0.89) =');
const a1 = testSmallCsb((r) => r >= 0.89);
console.log(`READY: ${a1.ready.total}`);
console.log(`WATCH: ${a1.watch.total}`);
console.log(`  500억~1000억: ${a1.watch.byRange['cap500to1000']}`);
console.log(`  1000억~2000억: ${a1.watch.byRange['cap1000to2000']}`);
console.log(`  2000억~3000억: ${a1.watch.byRange['cap2000to3000']}\n`);

console.log('= A4-correct (상위 30% = >= p70) =');
const a4c = testSmallCsb((r, range) => r >= compressionThresholds[range]?.p70);
console.log(`READY: ${a4c.ready.total}`);
console.log(`WATCH: ${a4c.watch.total}`);
console.log(`  500억~1000억: ${a4c.watch.byRange['cap500to1000']}`);
console.log(`  1000억~2000억: ${a4c.watch.byRange['cap1000to2000']}`);
console.log(`  2000억~3000억: ${a4c.watch.byRange['cap2000to3000']}\n`);

console.log('= A5-correct (상위 40% = >= p60) =');
const a5c = testSmallCsb((r, range) => r >= compressionThresholds[range]?.p60);
console.log(`READY: ${a5c.ready.total}`);
console.log(`WATCH: ${a5c.watch.total}`);
console.log(`  500억~1000억: ${a5c.watch.byRange['cap500to1000']}`);
console.log(`  1000억~2000억: ${a5c.watch.byRange['cap1000to2000']}`);
console.log(`  2000억~3000억: ${a5c.watch.byRange['cap2000to3000']}\n`);

console.log('임계값:');
for (const [range, vals] of Object.entries(compressionThresholds)) {
  const rangeLabel = { 'cap500to1000': '500억~1000억', 'cap1000to2000': '1000억~2000억', 'cap2000to3000': '2000억~3000억' }[range];
  console.log(`  ${rangeLabel}: p60=${vals.p60.toFixed(4)}, p70=${vals.p70.toFixed(4)}`);
}
