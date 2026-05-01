require('dotenv').config();
const patternScreener = require('./pattern-screener.js');

(async () => {
  console.log('QVA_EVOLUTION 전체 종목 스캔 시작...\n');
  const result = await patternScreener.analyzeAll({ logProgress: false });

  // ─── QVA_EVOLUTION 후보 분석 ───
  console.log(`\n${'='.repeat(80)}`);
  console.log(`QVA_EVOLUTION 후보 분석`);
  console.log(`${'='.repeat(80)}`);
  console.log(`총 후보 수: ${result.qvaEvolutionCount}`);
  console.log(`\n후보 리스트 (점수순):\n`);

  result.qvaEvolutionCandidates.forEach((c, idx) => {
    const s = c.qvaEvolution?.signals || {};
    const b = c.qvaEvolution?.breakdown || {};
    console.log(`${idx + 1}. ${c.code} ${c.name} (${c.market})`);
    console.log(`   종가: ${c.closePrice.toLocaleString()}원 | 시총: ${(c.marketCap / 1e9).toFixed(1)}B`);
    console.log(`   QVA_EVOLUTION 점수: ${c.qvaScore}점`);
    console.log(`   - valueMedianRatio20=${s.valueMedianRatio20?.toFixed(2)}배 | rangeExpansion10=${s.rangeExpansion10?.toFixed(1)}%`);
    console.log(`   - structureCount=${b.structureCount}/6 | 거래대금=${s.valueRatio20?.toFixed(2)}배 | 거래량=${s.volumeRatio20?.toFixed(2)}배`);
    console.log(`   - 구조지표: higherLow5=${s.higherLow5 ? 'Y' : 'N'} | recentCloseLowHigher=${s.recentCloseLowHigher ? 'Y' : 'N'} | ma5SlopeUp=${s.ma5SlopeUp ? 'Y' : 'N'} | ma20SlopeUp=${s.ma20SlopeUp ? 'Y' : 'N'} | closeAboveMa20=${s.closeAboveMa20 ? 'Y' : 'N'} | recentHighNearBreak=${s.recentHighNearBreak ? 'Y' : 'N'}`);
    console.log(`   - ret5d=${s.ret5d?.toFixed(1)}% | ret20d=${s.ret20d?.toFixed(1)}%\n`);
  });

  // ─── 통계 분석 ───
  const scoreStats = result.qvaEvolutionCandidates.map(c => c.qvaScore);
  const avgScore = scoreStats.length > 0 ? (scoreStats.reduce((a, b) => a + b, 0) / scoreStats.length).toFixed(1) : 0;
  const maxScore = Math.max(...scoreStats, 0);
  const minScore = Math.min(...scoreStats, 100);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`QVA_EVOLUTION 점수 통계`);
  console.log(`${'='.repeat(80)}`);
  console.log(`평균 점수: ${avgScore}점 | 최고: ${maxScore}점 | 최저: ${minScore}점`);

  // 점수대별 분포
  const score80plus = scoreStats.filter(s => s >= 80).length;
  const score75to79 = scoreStats.filter(s => s >= 75 && s < 80).length;
  const score70to74 = scoreStats.filter(s => s >= 70 && s < 75).length;

  console.log(`\n점수대별 분포:`);
  console.log(`  80점 이상: ${score80plus}개`);
  console.log(`  75~79점: ${score75to79}개`);
  console.log(`  70~74점: ${score70to74}개`);

  // ─── 제외 원인 분석 ───
  console.log(`\n${'='.repeat(80)}`);
  console.log(`QVA_EVOLUTION 제외 원인 분석 (상위 100개 표본)`);
  console.log(`${'='.repeat(80)}\n`);

  const reasonCounts = {};
  let excludeCount = 0;

  for (const stock of result.taggedAll.slice(0, 100)) {
    const code = stock.code;
    const rows = require('fs').existsSync(`cache/${code}.json`)
      ? JSON.parse(require('fs').readFileSync(`cache/${code}.json`, 'utf-8'))
      : [];

    if (rows.length < 60) {
      reasonCounts['데이터부족'] = (reasonCounts['데이터부족'] || 0) + 1;
      excludeCount++;
      continue;
    }

    try {
      const res = patternScreener.calculateQvaEvolution?.(rows, [], { marketValue: stock.marketCap });
      if (!res?.passed && res?.reason) {
        const reason = res.reason;
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      }
    } catch (_) {}
    excludeCount++;
  }

  const sortedReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log(`제외 원인 Top 10 (100개 종목 표본 내):\n`);
  sortedReasons.forEach(([reason, count], idx) => {
    console.log(`${idx + 1}. ${reason}: ${count}개`);
  });

  // 제일기획 상세
  const jeilgihohak = result.taggedAll.find(t => t.code === '030000');
  if (jeilgihohak) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`제일기획(030000) 상세 분석`);
    console.log(`${'='.repeat(80)}`);
    console.log(`QVA_EVOLUTION: ${jeilgihohak.qvaEvolution ? '통과' : '불통과'}`);
    if (jeilgihohak.qvaEvolution) {
      console.log(`점수: ${jeilgihohak.qvaEvolution.score}`);
    } else {
      console.log(`(후보에서 제외됨 - 초기 유입 신호 약함)`);
    }
  }
})();
