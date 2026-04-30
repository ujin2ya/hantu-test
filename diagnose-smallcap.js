const fs = require('fs');
const path = require('path');

const computeATR = (rows, idx, period = 14) => {
  if (!rows || idx < period) return null;
  const trs = [];
  for (let i = idx - period + 1; i <= idx; i++) {
    const curr = rows[i];
    const prev = rows[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
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

const targets = {
  'cap500to1000': (cap) => cap >= 50_000_000_000 && cap < 100_000_000_000,
  'cap1000to2000': (cap) => cap >= 100_000_000_000 && cap < 200_000_000_000,
  'cap2000to3000': (cap) => cap >= 200_000_000_000 && cap < 300_000_000_000,
};

const results = {};
for (const [range, filter] of Object.entries(targets)) {
  results[range] = {
    total: 0,
    hasChart: 0,
    hasFlow: 0,
    passedAvg20ge50B: 0,
    passedAvg20ge30B: 0,
    passedATRle25: 0,
    passedATRle30: 0,
    passedSupportStrict: 0,
    passedSupportRelaxed: 0,
    passedVolumeRatio: 0,
    passedCompression: 0,
    passedBreakout: 0,
    passed3Plus: 0,
    passed4All: 0,
    failReasons: {},
  };

  const rangeStocks = stocksList.filter(s => filter(s.marketValue));
  results[range].total = rangeStocks.length;

  for (const meta of rangeStocks) {
    const code = meta.code;
    let cache = null;
    let hasChart = false, hasFlow = false;

    try {
      cache = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, `${code}.json`), 'utf-8'));
      hasChart = true;
    } catch (_) {
      try {
        cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${code}.json`), 'utf-8'));
        hasChart = true;
      } catch (_) {}
    }

    if (!hasChart) {
      results[range].failReasons['데이터_없음'] = (results[range].failReasons['데이터_없음'] || 0) + 1;
      continue;
    }

    results[range].hasChart++;
    const rows = cache.rows || [];
    if (rows.length < 60) {
      results[range].failReasons['데이터_부족'] = (results[range].failReasons['데이터_부족'] || 0) + 1;
      continue;
    }

    const idx = rows.length - 1;
    const close = rows[idx].close;

    try {
      const flowPath = path.join(CACHE_DIR, 'flow-history', `${code}.json`);
      if (fs.existsSync(flowPath)) {
        hasFlow = true;
        results[range].hasFlow++;
      }
    } catch (_) {}

    const last20rows = rows.slice(Math.max(0, idx - 19), idx + 1);
    const last5rows = rows.slice(Math.max(0, idx - 4), idx + 1);
    const last60rows = rows.slice(Math.max(0, idx - 59), idx + 1);

    const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / last20rows.length;
    const avg5Value = last5rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / last5rows.length;

    if (avg20Value >= 5_000_000_000) results[range].passedAvg20ge50B++;
    if (avg20Value >= 3_000_000_000) results[range].passedAvg20ge30B++;

    const atr = computeATR(rows, idx, 14);
    const atrPct = atr / close;
    if (atrPct <= 0.25) results[range].passedATRle25++;
    if (atrPct <= 0.30) results[range].passedATRle30++;

    const valueRatio = avg20Value > 0 ? avg5Value / avg20Value : 0;
    if (valueRatio >= 0.9) results[range].passedVolumeRatio++;

    const ma20 = sma(last20rows.map((r) => r.close), 20);
    const ma60 = sma(last60rows.map((r) => r.close), 60);
    const supportStrict = (ma20 > 0 && close >= ma20 * 0.95) || (ma60 > 0 && close >= ma60 * 0.92);
    const supportRelaxed = (ma20 > 0 && close >= ma20 * 0.93) || (ma60 > 0 && close >= ma60 * 0.90);
    if (supportStrict) results[range].passedSupportStrict++;
    if (supportRelaxed) results[range].passedSupportRelaxed++;

    const last20high = Math.max(...last20rows.map((r) => r.high || r.close));
    const last20low = Math.min(...last20rows.map((r) => r.low || r.close));
    const compressionRatio = last20high > 0 ? last20low / last20high : 1;
    const compressionFormed = compressionRatio >= 0.89;
    if (compressionFormed) results[range].passedCompression++;

    const distFromHigh20 = last20high > 0 ? (last20high - close) / last20high : 1;
    const breakoutReady = distFromHigh20 <= 0.12;
    if (breakoutReady) results[range].passedBreakout++;

    const condCount = (supportStrict ? 1 : 0) + (valueRatio >= 0.9 ? 1 : 0) + (compressionFormed ? 1 : 0) + (breakoutReady ? 1 : 0);
    if (condCount >= 3) results[range].passed3Plus++;
    if (condCount === 4) results[range].passed4All++;
  }
}

console.log('📊 500억~3000억 구간 CSB-Lite 조건 진단\n');
for (const [range, data] of Object.entries(results)) {
  const rangeLabel = {
    'cap500to1000': '500억~1000억',
    'cap1000to2000': '1000억~2000억',
    'cap2000to3000': '2000억~3000억',
  }[range];

  console.log(`\n=== ${rangeLabel} ===`);
  console.log(`전체: ${data.total}종목`);
  console.log(`  ✓ chart 있음: ${data.hasChart}`);
  console.log(`  ✓ flow 있음: ${data.hasFlow}`);
  console.log(`\n조건별 통과:`);
  console.log(`  거래대금 50억: ${data.passedAvg20ge50B}`);
  console.log(`  거래대금 30억: ${data.passedAvg20ge30B}`);
  console.log(`  ATR <= 25%: ${data.passedATRle25}`);
  console.log(`  ATR <= 30%: ${data.passedATRle30}`);
  console.log(`  지지확인(strict): ${data.passedSupportStrict}`);
  console.log(`  지지확인(relaxed): ${data.passedSupportRelaxed}`);
  console.log(`  거래대금재활성: ${data.passedVolumeRatio}`);
  console.log(`  압축형성: ${data.passedCompression}`);
  console.log(`  돌파대기: ${data.passedBreakout}`);
  console.log(`\n통과 종목:`);
  console.log(`  3조건+: ${data.passed3Plus}`);
  console.log(`  4조건 모두: ${data.passed4All}`);
  console.log(`\n탈락 사유:`);
  for (const [reason, count] of Object.entries(data.failReasons)) {
    console.log(`  ${reason}: ${count}`);
  }
}
