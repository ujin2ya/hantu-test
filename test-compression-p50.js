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

const compressionThresholds = {};
const targets = {
  'cap500to1000': (cap) => cap >= 50_000_000_000 && cap < 100_000_000_000,
  'cap1000to2000': (cap) => cap >= 100_000_000_000 && cap < 200_000_000_000,
  'cap2000to3000': (cap) => cap >= 200_000_000_000 && cap < 300_000_000_000,
};

// 임계값 계산
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
      p50: ratios[Math.floor(ratios.length * 0.50)],
      p60: ratios[Math.floor(ratios.length * 0.60)],
      p70: ratios[Math.floor(ratios.length * 0.70)],
    };
  }
}

// A6-correct (>= p50) 테스트
const candidates = [];
let readyCount = 0, watchCount = 0;

for (const [range, filter] of Object.entries(targets)) {
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
    
    // 지지 확인
    const ma20 = sma(last20rows.map((r) => r.close), 20);
    const ma60 = sma(last60rows.map((r) => r.close), 60);
    const supportConfirmed = (ma20 > 0 && close >= ma20 * 0.95) || (ma60 > 0 && close >= ma60 * 0.92);
    if (!supportConfirmed) continue;
    
    // 거래대금 재활성
    const avg5Value = last5rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / last5rows.length;
    const valueRatio = avg20Value > 0 ? avg5Value / avg20Value : 0;
    if (valueRatio < 0.9) continue;
    
    // 압축 형성 (p50)
    const last20high = Math.max(...last20rows.map((r) => r.high || r.close));
    const last20low = Math.min(...last20rows.map((r) => r.low || r.close));
    const compressionRatio = last20high > 0 ? last20low / last20high : 1;
    if (compressionRatio < compressionThresholds[range]?.p50) continue;
    
    // 돌파 대기
    const distFromHigh20 = last20high > 0 ? (last20high - close) / last20high : 1;
    const breakoutReady = distFromHigh20 <= 0.12;
    
    const condCount = 1 + 1 + 1 + (breakoutReady ? 1 : 0);
    const isReady = condCount >= 4;
    const isWatch = condCount >= 3;
    
    if (isReady) readyCount++;
    if (isWatch) watchCount++;
    
    if (isWatch) {
      candidates.push({
        code: meta.code,
        name: meta.name,
        marketCap: meta.marketValue,
        range: range,
        compressionRatio: compressionRatio,
        valueRatio: valueRatio,
        atrPct: atrPct,
        distFromHigh20: distFromHigh20 * 100,
        avg20Value: avg20Value,
        tags: [
          supportConfirmed ? '지지확인' : '',
          valueRatio >= 0.9 ? '거래대금재활성' : '',
          compressionRatio >= compressionThresholds[range]?.p50 ? '압축' : '',
          breakoutReady ? '돌파대기' : '',
        ].filter(Boolean),
        isReady: isReady,
      });
    }
  }
}

console.log('🔬 압축 조건 p50 실험\n');
console.log('임계값:');
for (const [range, vals] of Object.entries(compressionThresholds)) {
  const rangeLabel = { 'cap500to1000': '500억~1000억', 'cap1000to2000': '1000억~2000억', 'cap2000to3000': '2000억~3000억' }[range];
  console.log(`  ${rangeLabel}: p50=${vals.p50.toFixed(4)}, p60=${vals.p60.toFixed(4)}, p70=${vals.p70.toFixed(4)}`);
}

console.log('\n= A6-correct (상위 50% = >= p50) =');
console.log(`READY: ${readyCount}`);
console.log(`WATCH: ${watchCount}`);
console.log(`  500억~1000억: ${candidates.filter(c => c.range === 'cap500to1000').length}`);
console.log(`  1000억~2000억: ${candidates.filter(c => c.range === 'cap1000to2000').length}`);
console.log(`  2000억~3000억: ${candidates.filter(c => c.range === 'cap2000to3000').length}`);

console.log('\n📋 후보 종목 (WATCH 이상):');
candidates.sort((a, b) => b.avg20Value - a.avg20Value).forEach(c => {
  const rangeLabel = { 'cap500to1000': '500억~1000억', 'cap1000to2000': '1000억~2000억', 'cap2000to3000': '2000억~3000억' }[c.range];
  console.log(`\n${c.code} ${c.name}`);
  console.log(`  시총: ${(c.marketCap / 1e8).toFixed(0)}억 (${rangeLabel})`);
  console.log(`  압축: ${c.compressionRatio.toFixed(4)} / 거래대금: ${c.valueRatio.toFixed(2)}x / ATR: ${(c.atrPct * 100).toFixed(1)}%`);
  console.log(`  고점거리: ${c.distFromHigh20.toFixed(1)}% / 20일평균거래대금: ${(c.avg20Value / 1e9).toFixed(1)}억`);
  console.log(`  태그: ${c.tags.join(' | ')} ${c.isReady ? '✨READY' : ''}`);
});

console.log(`\n총 WATCH 후보: ${candidates.length}개`);
