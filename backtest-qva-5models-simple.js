#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_STOCKS = path.join(ROOT, 'cache', 'stock-charts-long');
const STOCKS_FILE = path.join(ROOT, 'cache', 'naver-stocks-list.json');

console.log('\n🔬 QVA 5가지 세부 가설 백테스트\n');

const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
const stockMap = {};
stocksData.stocks.forEach(s => { stockMap[s.code] = s; });

const models = ['FIRST', '2DAY', 'ABSORB', 'HIGHER_LOW', 'HOLD'];
const results = {};

for (const model of ['baseline', ...models]) {
  results[model] = { n: 0, returns: [] };
}
results.byMarket = { KOSPI: {}, KOSDAQ: {} };
for (const model of models) {
  results.byMarket.KOSPI[model] = { n: 0, returns: [] };
  results.byMarket.KOSDAQ[model] = { n: 0, returns: [] };
}

let processed = 0;
const files = fs.readdirSync(LONG_STOCKS).filter(f => f.endsWith('.json')).slice(0, 500); // 500개 테스트

for (const file of files) {
  const code = file.replace('.json', '');
  const stock = stockMap[code];
  if (!stock) continue;

  let chart;
  try {
    chart = JSON.parse(fs.readFileSync(path.join(LONG_STOCKS, file), 'utf-8'));
  } catch (_) { continue; }

  const rows = chart.rows || [];
  if (rows.length < 100) continue;

  const startIdx = Math.max(0, rows.length - 100);
  for (let i = startIdx; i < rows.length - 40; i++) {
    const close = rows[i].close;
    
    // 수익률
    const d20 = (rows[Math.min(i + 20, rows.length - 1)].close / close - 1) * 100;
    const d40 = (rows[Math.min(i + 40, rows.length - 1)].close / close - 1) * 100;

    // MFE20
    let mfe20 = 0;
    for (let j = i + 1; j <= Math.min(i + 20, rows.length - 1); j++) {
      mfe20 = Math.max(mfe20, (rows[j].high - close) / close * 100);
    }

    const ret = { d20, d40, mfe20, hit: d20 > 0 ? 1 : 0 };
    results.baseline.returns.push(ret);

    // 5가지 모델
    const histRows = rows.slice(0, i + 1);
    let qvaFirst = null, qva2Day = null, qvaAbsorb = null, qvaHigherLow = null, qvaHold = null;

    try {
      qvaFirst = ps.calculateQuietVolumeFirst(histRows, [], { code, marketValue: stock.marketValue });
      qva2Day = ps.calculateQuietVolume2Day(histRows, [], { code, marketValue: stock.marketValue });
      qvaAbsorb = ps.calculateQuietVolumeAbsorb(histRows, [], { code, marketValue: stock.marketValue });
      qvaHigherLow = ps.calculateQuietVolumeHigherLow(histRows, [], { code, marketValue: stock.marketValue });
      qvaHold = ps.calculateQuietVolumeHold(histRows, [], { code, marketValue: stock.marketValue });
    } catch (_) {}

    const modelResult = { FIRST: qvaFirst, '2DAY': qva2Day, ABSORB: qvaAbsorb, HIGHER_LOW: qvaHigherLow, HOLD: qvaHold };

    for (const model of models) {
      if (modelResult[model]?.passed) {
        results[model].returns.push(ret);
        results[model].n++;

        if (stock.market === 'KOSPI') {
          results.byMarket.KOSPI[model].returns.push(ret);
          results.byMarket.KOSPI[model].n++;
        } else if (stock.market === 'KOSDAQ') {
          results.byMarket.KOSDAQ[model].returns.push(ret);
          results.byMarket.KOSDAQ[model].n++;
        }
      }
    }
  }

  processed++;
}

// 통계 계산
function calcStats(returns) {
  if (!returns.length) return { n: 0, d20: 0, mfe20: 0, hit: 0 };
  const d20s = returns.map(r => r.d20);
  const mfe20s = returns.map(r => r.mfe20);
  const hits = returns.map(r => r.hit);
  return {
    n: returns.length,
    d20: +(d20s.reduce((a,b)=>a+b,0)/d20s.length).toFixed(2),
    mfe20: +(mfe20s.reduce((a,b)=>a+b,0)/mfe20s.length).toFixed(2),
    hit: +(hits.filter(h=>h).length/hits.length*100).toFixed(1),
  };
}

console.log('═'.repeat(100));
console.log('📊 QVA 5가지 모델 비교 (500개 종목, 샘플)\n');

const metrics = ['n', 'd20', 'mfe20', 'hit'];
const header = 'Model'.padEnd(15) + metrics.map(m => m.padStart(15)).join('');
console.log(header);
console.log('─'.repeat(100));

console.log('Baseline'.padEnd(15) + metrics.map(m => String(calcStats(results.baseline.returns)[m] || 0).padStart(15)).join(''));
for (const model of models) {
  console.log(model.padEnd(15) + metrics.map(m => String(calcStats(results[model].returns)[m] || 0).padStart(15)).join(''));
}

console.log('\n처리된 종목:', processed, '\n');
