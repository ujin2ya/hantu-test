#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_STOCKS = path.join(ROOT, 'cache', 'stock-charts-long');
const STOCKS_FILE = path.join(ROOT, 'cache', 'naver-stocks-list.json');

console.log('\n🔬 QVA 5가지 세부 가설 백테스트 (전체)\n');

const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
const stockMap = {};
stocksData.stocks.forEach(s => { stockMap[s.code] = s; });

const models = ['FIRST', '2DAY', 'ABSORB', 'HIGHER_LOW', 'HOLD'];
const results = {};

for (const model of ['baseline', ...models]) {
  results[model] = { n: 0, d20: 0, d40: 0, mfe20: 0, mfe40: 0, hit10: 0, hit20: 0, count: 0 };
}
results.byMarket = { KOSPI: {}, KOSDAQ: {} };
for (const model of models) {
  results.byMarket.KOSPI[model] = { n: 0, d20: 0, mfe20: 0, hit10: 0, count: 0 };
  results.byMarket.KOSDAQ[model] = { n: 0, d20: 0, mfe20: 0, hit10: 0, count: 0 };
}

let processed = 0;
const files = fs.readdirSync(LONG_STOCKS).filter(f => f.endsWith('.json'));

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
    
    const d20 = (rows[Math.min(i + 20, rows.length - 1)].close / close - 1) * 100;
    const d40 = (rows[Math.min(i + 40, rows.length - 1)].close / close - 1) * 100;

    let mfe20 = 0, mfe40 = 0;
    for (let j = i + 1; j <= Math.min(i + 20, rows.length - 1); j++) {
      mfe20 = Math.max(mfe20, (rows[j].high - close) / close * 100);
    }
    for (let j = i + 1; j <= Math.min(i + 40, rows.length - 1); j++) {
      mfe40 = Math.max(mfe40, (rows[j].high - close) / close * 100);
    }

    const hit10 = (rows[Math.min(i + 10, rows.length - 1)].close / close - 1) * 100 > 0 ? 1 : 0;
    const hit20 = d20 > 0 ? 1 : 0;

    // Baseline
    results.baseline.d20 += d20;
    results.baseline.d40 += d40;
    results.baseline.mfe20 += mfe20;
    results.baseline.mfe40 += mfe40;
    results.baseline.hit10 += hit10;
    results.baseline.hit20 += hit20;
    results.baseline.count++;

    // 5가지 모델
    const histRows = rows.slice(0, i + 1);
    const modelTests = {
      FIRST: ps.calculateQuietVolumeFirst(histRows, [], { code, marketValue: stock.marketValue }),
      '2DAY': ps.calculateQuietVolume2Day(histRows, [], { code, marketValue: stock.marketValue }),
      ABSORB: ps.calculateQuietVolumeAbsorb(histRows, [], { code, marketValue: stock.marketValue }),
      HIGHER_LOW: ps.calculateQuietVolumeHigherLow(histRows, [], { code, marketValue: stock.marketValue }),
      HOLD: ps.calculateQuietVolumeHold(histRows, [], { code, marketValue: stock.marketValue }),
    };

    for (const model of models) {
      if (modelTests[model]?.passed) {
        results[model].n++;
        results[model].d20 += d20;
        results[model].d40 += d40;
        results[model].mfe20 += mfe20;
        results[model].mfe40 += mfe40;
        results[model].hit10 += hit10;
        results[model].hit20 += hit20;
        results[model].count++;

        if (stock.market === 'KOSPI') {
          results.byMarket.KOSPI[model].n++;
          results.byMarket.KOSPI[model].d20 += d20;
          results.byMarket.KOSPI[model].mfe20 += mfe20;
          results.byMarket.KOSPI[model].hit10 += hit10;
          results.byMarket.KOSPI[model].count++;
        } else if (stock.market === 'KOSDAQ') {
          results.byMarket.KOSDAQ[model].n++;
          results.byMarket.KOSDAQ[model].d20 += d20;
          results.byMarket.KOSDAQ[model].mfe20 += mfe20;
          results.byMarket.KOSDAQ[model].hit10 += hit10;
          results.byMarket.KOSDAQ[model].count++;
        }
      }
    }
  }

  processed++;
  if (processed % 500 === 0) process.stdout.write(`\r진행: ${processed}`);
}

console.log(`\r완료: ${processed}개 종목\n`);

// 평균 계산
function avg(model) {
  if (!results[model].count) return { d20: 0, d40: 0, mfe20: 0, mfe40: 0, hit10: 0, hit20: 0 };
  return {
    d20: +(results[model].d20 / results[model].count).toFixed(2),
    d40: +(results[model].d40 / results[model].count).toFixed(2),
    mfe20: +(results[model].mfe20 / results[model].count).toFixed(2),
    mfe40: +(results[model].mfe40 / results[model].count).toFixed(2),
    hit10: +(results[model].hit10 / results[model].count * 100).toFixed(1),
    hit20: +(results[model].hit20 / results[model].count * 100).toFixed(1),
  };
}

console.log('═'.repeat(140));
console.log('📊 QVA 5가지 모델 최종 결과\n');

const metrics = ['n', 'd20', 'd40', 'mfe20', 'mfe40', 'hit10', 'hit20'];
const header = 'Model'.padEnd(15) + metrics.map(m => m.padStart(12)).join('');
console.log(header);
console.log('─'.repeat(140));

const baseline = avg('baseline');
console.log('Baseline'.padEnd(15) + [results.baseline.n, baseline.d20, baseline.d40, baseline.mfe20, baseline.mfe40, baseline.hit10, baseline.hit20]
  .map(v => String(v).padStart(12)).join(''));

for (const model of models) {
  const stats = avg(model);
  console.log(model.padEnd(15) + [results[model].n, stats.d20, stats.d40, stats.mfe20, stats.mfe40, stats.hit10, stats.hit20]
    .map(v => String(v).padStart(12)).join(''));
}

// TOP 2
console.log('\n' + '═'.repeat(140));
console.log('🏆 TOP 2 모델\n');

const sorted = models.map(m => {
  const s = avg(m);
  return { model: m, d20: s.d20, mfe20: s.mfe20, hit10: s.hit10, n: results[m].n };
}).sort((a, b) => {
  if (b.mfe20 !== a.mfe20) return b.mfe20 - a.mfe20;
  if (b.d20 !== a.d20) return b.d20 - a.d20;
  return b.hit10 - a.hit10;
});

sorted.slice(0, 2).forEach((m, i) => {
  console.log(`${i+1}. ${m.model}: ${m.n} 신호, d20=${m.d20}%, mfe20=${m.mfe20}%, hit10=${m.hit10}%`);
});

console.log('\n🎯 시장별 TOP\n');
console.log('KOSPI:');
for (const model of models) {
  const stats = results.byMarket.KOSPI[model];
  if (stats.count > 0) {
    console.log(`  ${model}: ${stats.n} 신호, d20=${(stats.d20/stats.count).toFixed(2)}%, mfe20=${(stats.mfe20/stats.count).toFixed(2)}%`);
  }
}
console.log('\nKOSDAQ:');
for (const model of models) {
  const stats = results.byMarket.KOSDAQ[model];
  if (stats.count > 0) {
    console.log(`  ${model}: ${stats.n} 신호, d20=${(stats.d20/stats.count).toFixed(2)}%, mfe20=${(stats.mfe20/stats.count).toFixed(2)}%`);
  }
}

fs.writeFileSync(path.join(ROOT, 'cache', 'qva-5models-final.json'), JSON.stringify(results, null, 2));
console.log('\n💾 결과 저장: cache/qva-5models-final.json\n');

