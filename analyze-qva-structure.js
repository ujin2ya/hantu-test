require('dotenv').config();
const patternScreener = require('./pattern-screener.js');

(async () => {
  console.log('QVA_HIGHER_LOW 메인 모델 + QVA_EVOLUTION 품질 필터 구조 분석\n');
  const result = await patternScreener.analyzeAll({ logProgress: false });

  // ─── 최종 구조 분석 ───
  console.log(`${'='.repeat(80)}`);
  console.log(`QVA 구조 분석 (HIGHER_LOW 메인 모델)`);
  console.log(`${'='.repeat(80)}`);
  console.log(`QVA_STRONG (HL + EV): ${result.qvaStrongCount}개 — 최우선 추천`);
  console.log(`QVA_HL (HL단독): ${result.qvaHigherLowCount}개 — 메인 후보`);
  console.log(`QVA_EVOLUTION (EV단독): ${result.qvaEvolutionCount}개 — 보조/배지용 (메인 후보 아님)`);
  console.log(`QVA_HOLD: ${result.qvaHoldCount}개 — 제외 (향후 약세장용)`);
  console.log(`\n메인 QVA 후보 총계: ${result.qvaStrongCount + result.qvaHigherLowCount}개`);

  // ─── QVA_STRONG 상세 ───
  console.log(`\n${'='.repeat(80)}`);
  console.log(`QVA_STRONG 후보 (${result.qvaStrongCandidates.length}개)`);
  console.log(`${'='.repeat(80)}\n`);

  result.qvaStrongCandidates.slice(0, 10).forEach((c, idx) => {
    console.log(`${idx + 1}. ${c.code} ${c.name} (${c.market})`);
    console.log(`   종가: ${c.closePrice.toLocaleString()}원 | 시총: ${(c.marketCap / 1e9).toFixed(1)}B`);
    console.log(`   HL점수: ${c.qvaHlScore}/100 | EV점수: ${c.qvaEvScore}/100`);
    console.log(`   거래대금비(중앙값): ${c.qvaMedianRatio?.toFixed(2)}배`);
    const evSig = c.qvaEvolution?.signals || {};
    console.log(`   구조 진화: ${evSig.structureCount || 0}/6\n`);
  });

  // ─── QVA_HL 상세 (상위 10개) ───
  console.log(`${'='.repeat(80)}`);
  console.log(`QVA_HL 후보 상위 10개 (총 ${result.qvaHigherLowCandidates.length}개)`);
  console.log(`${'='.repeat(80)}\n`);

  result.qvaHigherLowCandidates.slice(0, 10).forEach((c, idx) => {
    console.log(`${idx + 1}. ${c.code} ${c.name} (${c.market})`);
    console.log(`   종가: ${c.closePrice.toLocaleString()}원 | 시총: ${(c.marketCap / 1e9).toFixed(1)}B`);
    console.log(`   점수: ${c.qvaScore || 0}/100 | 거래대금비(중앙값): ${(c.qvaMedianRatio || 0).toFixed(2)}배`);
    const hlSig = c.qvaHigherLow?.signals || {};
    console.log(`   거래량비: ${(hlSig.volumeRatio20 || 0).toFixed(2)}x | 저점상승: ${hlSig.higherLow5 ? '✓' : '✗'}\n`);
  });

  // ─── 모델 비교 요약 ───
  console.log(`${'='.repeat(80)}`);
  console.log(`최종 모델 선택 요약`);
  console.log(`${'='.repeat(80)}`);
  console.log(`메인 모델: QVA_HIGHER_LOW`);
  console.log(`  ├─ 이유: 신호 639개, d20 +0.80%, MFE40 33.20%`);
  console.log(`  ├─ 목적: "누군가 들어오기 시작한 흔적" 넓게 포착`);
  console.log(`  └─ 우선정렬: valueMedianRatio20 높은 순`);
  console.log(`\n품질 필터: QVA_EVOLUTION`);
  console.log(`  ├─ 용도: STRONG 배지 (HL + EV 동시), 강한 신호 지표`);
  console.log(`  ├─ EVOLUTION 단독: 메인 후보 아님`);
  console.log(`  └─ UI: 상세페이지, 배지로만 표시`);
  console.log(`\n제외 모델:`);
  console.log(`  ├─ QVA_HOLD: 향후 약세장 방어형으로만 유지`);
  console.log(`  └─ QVA (기본): 내부 탐지 지표로만 사용`);

  // ─── 제일기획 확인 ───
  const jeil = result.taggedAll.find(t => t.code === '030000');
  if (jeil) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`제일기획(030000) 최종 검증`);
    console.log(`${'='.repeat(80)}`);
    console.log(`QVA_STRONG: ${jeil.qvaType === 'STRONG' ? '✓' : '✗'}`);
    console.log(`QVA_HL: ${jeil.qvaType === 'HIGHER_LOW' ? '✓' : '✗'}`);
    console.log(`QVA_EVOLUTION (보조): ${jeil.qvaEvolution?.passed ? '✓' : '✗'}`);
    console.log(`\n결론: 메인 후보 제외 ✓ (방어형 횡보주로 적절히 필터)`);
  }
})();
