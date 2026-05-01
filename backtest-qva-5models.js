#!/usr/bin/env node
// QVA 5가지 세부 가설 백테스트
// FIRST, 2DAY, ABSORB, HIGHER_LOW, HOLD

const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_STOCKS = path.join(ROOT, 'cache', 'stock-charts-long');
const STOCKS_FILE = path.join(ROOT, 'cache', 'naver-stocks-list.json');

console.log('\n🔬 QVA 5가지 세부 가설 백테스트\n');
console.log('모델: FIRST / 2DAY / ABSORB / HIGHER_LOW / HOLD');
console.log('지표: d5/10/20/40, MFE10/20/40, hit7/10/15, winRate, PF, worst, MAE20\n');

(async () => {
  const startTime = Date.now();

  // 헬퍼
  const calcStats = (returns) => {
    if (!returns.length) {
      return { n: 0, d5: 0, d10: 0, d20: 0, d40: 0, MFE10: 0, MFE20: 0, MFE40: 0,
               MAE20: 0, hit7: 0, hit10: 0, hit15: 0, winRate: 0, PF: 0, worst: 0 };
    }

    const d5s = returns.map(r => r.d5), d10s = returns.map(r => r.d10), d20s = returns.map(r => r.d20), d40s = returns.map(r => r.d40);
    const MFE10s = returns.map(r => r.MFE10), MFE20s = returns.map(r => r.MFE20), MFE40s = returns.map(r => r.MFE40);
    const MAE20s = returns.map(r => r.MAE20);
    const hit7s = returns.map(r => r.d7 > 0 ? 1 : 0), hit10s = returns.map(r => r.d10 > 0 ? 1 : 0), hit15s = returns.map(r => r.d15 > 0 ? 1 : 0);

    const wins = returns.filter(r => r.d20 > 0), losses = returns.filter(r => r.d20 <= 0);
    const avgWin = wins.length ? wins.reduce((s, r) => s + r.d20, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, r) => s + r.d20, 0) / losses.length) : 0;

    return {
      n: returns.length,
      d5: +(d5s.reduce((a,b)=>a+b,0)/d5s.length*100).toFixed(2),
      d10: +(d10s.reduce((a,b)=>a+b,0)/d10s.length*100).toFixed(2),
      d20: +(d20s.reduce((a,b)=>a+b,0)/d20s.length*100).toFixed(2),
      d40: +(d40s.reduce((a,b)=>a+b,0)/d40s.length*100).toFixed(2),
      MFE10: +(MFE10s.reduce((a,b)=>a+b,0)/MFE10s.length*100).toFixed(2),
      MFE20: +(MFE20s.reduce((a,b)=>a+b,0)/MFE20s.length*100).toFixed(2),
      MFE40: +(MFE40s.reduce((a,b)=>a+b,0)/MFE40s.length*100).toFixed(2),
      MAE20: +(MAE20s.reduce((a,b)=>a+b,0)/MAE20s.length*100).toFixed(2),
      hit7: +(hit7s.filter(h=>h>0).length/hit7s.length*100).toFixed(1),
      hit10: +(hit10s.filter(h=>h>0).length/hit10s.length*100).toFixed(1),
      hit15: +(hit15s.filter(h=>h>0).length/hit15s.length*100).toFixed(1),
      winRate: +(wins.length/returns.length*100).toFixed(1),
      PF: avgLoss > 0 ? +(avgWin/avgLoss).toFixed(2) : 0,
      worst: +(Math.min(...d40s)*100).toFixed(2),
    };
  };

  const getReturn = (rows, idx, days) => {
    if (idx + days >= rows.length) return 0;
    return rows[idx + days].close / rows[idx].close - 1;
  };

  const getMFE = (rows, idx, days) => {
    let mfe = 0;
    for (let j = idx + 1; j <= Math.min(idx + days, rows.length - 1); j++) {
      const high = rows[j]?.high || rows[j]?.close;
      mfe = Math.max(mfe, (high - rows[idx].close) / rows[idx].close);
    }
    return mfe;
  };

  const getMAE = (rows, idx, days) => {
    let mae = 0;
    for (let j = idx + 1; j <= Math.min(idx + days, rows.length - 1); j++) {
      const low = rows[j]?.low || rows[j]?.close;
      mae = Math.min(mae, (low - rows[idx].close) / rows[idx].close);
    }
    return mae;
  };

  try {
    const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
    const stockMap = {};
    (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

    console.log(`📊 종목 메타: ${Object.keys(stockMap).length}개\n`);

    const models = ['FIRST', '2DAY', 'ABSORB', 'HIGHER_LOW', 'HOLD'];
    let baselineReturns = [];
    let modelReturns = { FIRST: [], '2DAY': [], ABSORB: [], HIGHER_LOW: [], HOLD: [] };
    let kospiByModel = { FIRST: [], '2DAY': [], ABSORB: [], HIGHER_LOW: [], HOLD: [] };
    let kosdaqByModel = { FIRST: [], '2DAY': [], ABSORB: [], HIGHER_LOW: [], HOLD: [] };

    const files = fs.readdirSync(LONG_STOCKS).filter(f => f.endsWith('.json'));
    let processedCount = 0;

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

      // 최근 100일 윈도우에서 스캔
      const startIdx = Math.max(0, rows.length - 100);
      for (let i = startIdx; i < rows.length - 40; i++) {
        const signalRow = rows[i];
        const histRows = rows.slice(0, i + 1);

        // 수익률 계산
        const ret = {
          d5: getReturn(rows, i, 5), d7: getReturn(rows, i, 7), d10: getReturn(rows, i, 10),
          d15: getReturn(rows, i, 15), d20: getReturn(rows, i, 20), d40: getReturn(rows, i, 40),
          MFE10: getMFE(rows, i, 10), MFE20: getMFE(rows, i, 20), MFE40: getMFE(rows, i, 40),
          MAE20: getMAE(rows, i, 20),
        };

        baselineReturns.push(ret);

        // 5가지 모델 테스트
        let qvaFirst = null, qva2Day = null, qvaAbsorb = null, qvaHigherLow = null, qvaHold = null;
        try {
          qvaFirst = ps.calculateQuietVolumeFirst(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
          qva2Day = ps.calculateQuietVolume2Day(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
          qvaAbsorb = ps.calculateQuietVolumeAbsorb(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
          qvaHigherLow = ps.calculateQuietVolumeHigherLow(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
          qvaHold = ps.calculateQuietVolumeHold(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
        } catch (_) {}

        if (qvaFirst?.passed) { modelReturns.FIRST.push(ret); if (stock.market === 'KOSPI') kospiByModel.FIRST.push(ret); else kosdaqByModel.FIRST.push(ret); }
        if (qva2Day?.passed) { modelReturns['2DAY'].push(ret); if (stock.market === 'KOSPI') kospiByModel['2DAY'].push(ret); else kosdaqByModel['2DAY'].push(ret); }
        if (qvaAbsorb?.passed) { modelReturns.ABSORB.push(ret); if (stock.market === 'KOSPI') kospiByModel.ABSORB.push(ret); else kosdaqByModel.ABSORB.push(ret); }
        if (qvaHigherLow?.passed) { modelReturns.HIGHER_LOW.push(ret); if (stock.market === 'KOSPI') kospiByModel.HIGHER_LOW.push(ret); else kosdaqByModel.HIGHER_LOW.push(ret); }
        if (qvaHold?.passed) { modelReturns.HOLD.push(ret); if (stock.market === 'KOSPI') kospiByModel.HOLD.push(ret); else kosdaqByModel.HOLD.push(ret); }
      }

      processedCount++;
    }

    const results = {
      baseline: calcStats(baselineReturns),
      processed: processedCount,
      byMarket: { KOSPI: {}, KOSDAQ: {} },
    };

    for (const model of models) {
      results[model] = calcStats(modelReturns[model]);
      results.byMarket.KOSPI[model] = calcStats(kospiByModel[model]);
      results.byMarket.KOSDAQ[model] = calcStats(kosdaqByModel[model]);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ 백테스트 완료 (${elapsed}초)\n`);

    // 출력
    console.log('═'.repeat(180));
    console.log('📊 QVA 5가지 모델 비교\n');

    const metrics = ['n', 'd20', 'MFE20', 'MFE40', 'hit10', 'hit15', 'winRate', 'PF', 'worst'];
    const header = 'Model'.padEnd(15) + metrics.map(m => m.padStart(12)).join('');
    console.log(header);
    console.log('─'.repeat(180));

    const allModels = ['baseline', ...models];
    for (const model of allModels) {
      const data = results[model];
      let row = model.padEnd(15);
      for (const metric of metrics) {
        row += String(data[metric] || 0).padStart(12);
      }
      console.log(row);
    }

    console.log('\n' + '═'.repeat(180));
    console.log(`🎯 시장 분리 분석\n`);

    console.log('KOSPI:');
    for (const model of models) {
      const data = results.byMarket.KOSPI[model];
      console.log(`  ${model}: ${data.n} 신호, d20=${data.d20}%, MFE20=${data.MFE20}%, hit10=${data.hit10}%`);
    }

    console.log('\nKOSDAQ:');
    for (const model of models) {
      const data = results.byMarket.KOSDAQ[model];
      console.log(`  ${model}: ${data.n} 신호, d20=${data.d20}%, MFE20=${data.MFE20}%, hit10=${data.hit10}%`);
    }

    // TOP 2
    const sorted = models.map(m => ({ model: m, mfe20: results[m].MFE20, hit10: results[m].hit10, pf: results[m].PF })).sort((a, b) => {
      if (b.mfe20 !== a.mfe20) return b.mfe20 - a.mfe20;
      if (b.hit10 !== a.hit10) return b.hit10 - a.hit10;
      return b.pf - a.pf;
    });

    console.log('\n' + '═'.repeat(180));
    console.log(`🏆 TOP 2 모델 (MFE20 기준)\n`);
    sorted.slice(0, 2).forEach((m, i) => {
      const data = results[m.model];
      console.log(`${i + 1}. ${m.model}`);
      console.log(`   d20=${data.d20}%, MFE20=${data.MFE20}%, MFE40=${data.MFE40}%, hit10=${data.hit10}%, hit15=${data.hit15}%, PF=${data.PF}`);
    });

    console.log(`\n📊 처리된 종목: ${results.processed}개\n`);

    const outputPath = path.join(ROOT, 'cache', 'qva-5models-backtest.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`💾 결과 저장: ${outputPath}\n`);

  } catch (e) {
    console.error('❌ 오류:', e.message);
    process.exit(1);
  }
})();
