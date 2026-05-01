require('dotenv').config();
const patternScreener = require('./pattern-screener.js');

(async () => {
  console.log('제일기획(030000) 디버그 테스트 시작...\n');
  const result = await patternScreener.analyzeAll({ logProgress: false });

  console.log('\n\n=== 스크린 완료 ===');

  // 제일기획 찾기
  if (result.qvaCandidates && result.qvaCandidates.length > 0) {
    const jeil = result.qvaCandidates.find(c => c.code === '030000');
    if (jeil) {
      console.log('\n✓ 제일기획이 qvaCandidates에 있음!');
      console.log('  qvaType:', jeil.qvaType);
      console.log('  qvaScore:', jeil.qvaScore);
    }
  }
  if (result.qvaHigherLowCandidates && result.qvaHigherLowCandidates.length > 0) {
    const jeil = result.qvaHigherLowCandidates.find(c => c.code === '030000');
    if (jeil) {
      console.log('\n✓ 제일기획이 qvaHigherLowCandidates에 있음!');
      console.log('  qvaType:', jeil.qvaType);
      console.log('  qvaScore:', jeil.qvaScore);
    }
  }
  if (result.qvaHoldCandidates && result.qvaHoldCandidates.length > 0) {
    const jeil = result.qvaHoldCandidates.find(c => c.code === '030000');
    if (jeil) {
      console.log('\n✓ 제일기획이 qvaHoldCandidates에 있음!');
      console.log('  qvaType:', jeil.qvaType);
      console.log('  qvaScore:', jeil.qvaScore);
    }
  }

  // pattern-result.json 확인
  const fs = require('fs');
  if (fs.existsSync('./cache/pattern-result.json')) {
    const patternResult = JSON.parse(fs.readFileSync('./cache/pattern-result.json', 'utf-8'));
    const jeil2 = patternResult.candidates?.find(c => c.code === '030000');
    if (jeil2) {
      console.log('\n✓ 제일기획이 pattern-result.json candidates에 있음!');
      console.log('  필드:', Object.keys(jeil2).slice(0, 10).join(', '));
    } else {
      console.log('\n✗ 제일기획이 pattern-result.json candidates에 없음');
    }
  }
})();
