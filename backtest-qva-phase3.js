#!/usr/bin/env node
// Phase 3: QVA 포괄적 백테스트
// 3가지 모델 (STRICT/BASE/LOOSE) × 15가지 지표 분석

const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

console.log('\n🧪 Phase 3: QVA 포괄적 백테스트 (QVA v2 포함)\n');
console.log('모델: QVA_BASE vs QVA_LOOSE vs QVA_v2 (신규)');
console.log('데이터: 장기 차트 (120일+) × 100거래일 슬라이싱');
console.log('지표: d5/10/20/40, MFE10/20/40, MAE10/20, hit5/10/20, winRate, PF, worst\n');

(async () => {
  const startTime = Date.now();

  const results = await ps.backtestQVA({ daysBack: 100 });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ 백테스트 완료 (${elapsed}초)\n`);

  console.log('═'.repeat(140));
  console.log('📊 QVA 모델 비교 — 핵심 지표\n');

  const models = ['baseline', 'qvaBase', 'qvaLoose', 'qvaV2'];
  const labels = ['Baseline', 'QVA_BASE', 'QVA_LOOSE', 'QVA_v2'];
  const metrics = ['n', 'd5', 'd10', 'd20', 'd40', 'MFE20', 'MFE40', 'hit10', 'hit20', 'winRate', 'PF', 'worst'];

  // 헤더
  const header = 'Model'.padEnd(15) + metrics.map(m => m.padStart(10)).join('');
  console.log(header);
  console.log('─'.repeat(140));

  // 각 모델
  for (let i = 0; i < models.length; i++) {
    const key = models[i];
    const label = labels[i];
    const data = results[key];
    if (!data) continue;

    let row = label.padEnd(15);
    for (const metric of metrics) {
      const val = data[metric] || 0;
      row += String(val).padStart(10);
    }
    console.log(row);
  }

  console.log('\n' + '═'.repeat(140));
  console.log(`📈 신호 수\n`);
  console.log(`  Baseline: ${results.baseline.n || 0} 거래일`);
  console.log(`  QVA_BASE: ${results.qvaBase.n} 신호`);
  console.log(`  QVA_LOOSE: ${results.qvaLoose.n} 신호`);
  console.log(`  QVA_v2: ${results.qvaV2.n} 신호`);

  console.log(`\n🎯 시장 분리 분석\n`);
  console.log(`  QVA_BASE: KOSPI=${results.byMarket.KOSPI.qvaBase.n} (d20=${results.byMarket.KOSPI.qvaBase.d20}%), KOSDAQ=${results.byMarket.KOSDAQ.qvaBase.n} (d20=${results.byMarket.KOSDAQ.qvaBase.d20}%)`);
  console.log(`  QVA_v2:   KOSPI=${results.byMarket.KOSPI.qvaV2.n} (d20=${results.byMarket.KOSPI.qvaV2.d20}%), KOSDAQ=${results.byMarket.KOSDAQ.qvaV2.n} (d20=${results.byMarket.KOSDAQ.qvaV2.d20}%)`);

  console.log(`\n📋 처리된 종목: ${results.processed}개\n`);

  // 결과 저장
  const outputPath = path.join(__dirname, 'cache', 'qva-backtest-phase3.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`💾 결과 저장: ${outputPath}\n`);

  console.log('═'.repeat(140));
  console.log('\n✓ Phase 3 완료\n');
})().catch(e => {
  console.error('❌ 오류:', e.message);
  process.exit(1);
});
