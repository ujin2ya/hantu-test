require('dotenv').config();
const patternScreener = require('./pattern-screener.js');

(async () => {
  console.log('QVA_EVOLUTION 백테스트 시작...\n');
  const result = await patternScreener.backtestQVA({ daysBack: 100 });

  // ─── 신호 수 비교 ───
  console.log(`${'='.repeat(80)}`);
  console.log(`신호 발생 수 비교`);
  console.log(`${'='.repeat(80)}`);
  console.log(`총 처리 종목: ${result.processed}개`);
  console.log(`baseline (거래량 이상징후): ${result.baseline.n}개`);
  console.log(`QVA_STRICT: ${result.qvaStrict.n}개 (${result.signals.strict}신호)`);
  console.log(`QVA_BASE: ${result.qvaBase.n}개 (${result.signals.base}신호)`);
  console.log(`QVA_LOOSE: ${result.qvaLoose.n}개 (${result.signals.loose}신호)`);
  console.log(`QVA_V2: ${result.qvaV2.n}개 (${result.signals.v2}신호)`);
  console.log(`QVA_EVOLUTION: ${result.qvaEvolution.n}개 (${result.signals.evolution}신호)`);
  console.log(`QVA_HOLD: ${result.qvaHold.n}개 (${result.signals.hold}신호)`);
  console.log(`QVA_HIGHER_LOW: ${result.qvaHigherLow.n}개 (${result.signals.higherLow}신호)`);

  // ─── 성과 메트릭 비교 ───
  console.log(`\n${'='.repeat(80)}`);
  console.log(`성과 메트릭 비교`);
  console.log(`${'='.repeat(80)}`);

  const formatRow = (label, data) => {
    return `${label.padEnd(18)} | n=${data.n.toString().padStart(4)} | d5=${(data.d5+'%').padStart(7)} | d10=${(data.d10+'%').padStart(7)} | d20=${(data.d20+'%').padStart(7)} | d40=${(data.d40+'%').padStart(7)} | MFE20=${(data.MFE20+'%').padStart(7)} | MFE40=${(data.MFE40+'%').padStart(7)} | hit20=${(data.hit20+'%').padStart(6)} | worst=${(data.worst+'%').padStart(7)}`;
  };

  console.log(`모델${''.padEnd(13)} | n    | d5     | d10    | d20    | d40    | MFE20  | MFE40  | hit20% | worst  `);
  console.log('-'.repeat(120));
  console.log(formatRow('baseline', result.baseline));
  console.log(formatRow('QVA_STRICT', result.qvaStrict));
  console.log(formatRow('QVA_BASE', result.qvaBase));
  console.log(formatRow('QVA_LOOSE', result.qvaLoose));
  console.log(formatRow('QVA_V2', result.qvaV2));
  console.log(formatRow('QVA_EVOLUTION', result.qvaEvolution));
  console.log(formatRow('QVA_HOLD', result.qvaHold));
  console.log(formatRow('QVA_HIGHER_LOW', result.qvaHigherLow));

  // ─── 3% 도달율 ───
  console.log(`\n${'='.repeat(80)}`);
  console.log(`3% 이상 도달율 (초기 유입 강도 지표)`);
  console.log(`${'='.repeat(80)}`);
  const hitRow = (label, data) => {
    return `${label.padEnd(18)} | hit3pct10=${(data.hit3pct10+'%').padStart(6)} | hit3pct20=${(data.hit3pct20+'%').padStart(6)}`;
  };
  console.log(hitRow('baseline', result.baseline));
  console.log(hitRow('QVA_EVOLUTION', result.qvaEvolution));
  console.log(hitRow('QVA_HOLD', result.qvaHold));
  console.log(hitRow('QVA_HIGHER_LOW', result.qvaHigherLow));

  // ─── 전환율 ───
  console.log(`\n${'='.repeat(80)}`);
  console.log(`CSB/VVI 전환율 (진화 가능성)`);
  console.log(`${'='.repeat(80)}`);
  const convRow = (label, data) => {
    return `${label.padEnd(18)} | CSB5d=${(data.csbConv5d+'%').padStart(6)} | CSB10d=${(data.csbConv10d+'%').padStart(6)} | CSB20d=${(data.csbConv20d+'%').padStart(6)} | VVI20d=${(data.vviConv20d+'%').padStart(6)}`;
  };
  console.log(convRow('baseline', result.baseline));
  console.log(convRow('QVA_EVOLUTION', result.qvaEvolution));
  console.log(convRow('QVA_HOLD', result.qvaHold));
  console.log(convRow('QVA_HIGHER_LOW', result.qvaHigherLow));

  // ─── 시장별 분석 ───
  console.log(`\n${'='.repeat(80)}`);
  console.log(`시장별 QVA_EVOLUTION 성과`);
  console.log(`${'='.repeat(80)}`);
  console.log(formatRow('KOSPI', result.byMarket.KOSPI.qvaEvolution));
  console.log(formatRow('KOSDAQ', result.byMarket.KOSDAQ.qvaEvolution));

  // ─── 요약 ───
  console.log(`\n${'='.repeat(80)}`);
  console.log(`핵심 발견`);
  console.log(`${'='.repeat(80)}`);
  console.log(`✓ QVA_EVOLUTION 신호 수: ${result.signals.evolution}개`);
  console.log(`✓ QVA_EVOLUTION d20 수익률: ${result.qvaEvolution.d20}%`);
  console.log(`✓ QVA_EVOLUTION 3%도달율 10d: ${result.qvaEvolution.hit3pct10}%`);
  console.log(`✓ QVA_EVOLUTION CSB전환율 5d: ${result.qvaEvolution.csbConv5d}%`);
  console.log(`✓ QVA_EVOLUTION VVI전환율 20d: ${result.qvaEvolution.vviConv20d}%`);
  console.log(`✓ QVA_HOLD 신호 수: ${result.signals.hold}개`);
  console.log(`✓ QVA_HIGHER_LOW 신호 수: ${result.signals.higherLow}개`);
  console.log(`\n  ⇒ 기존 모델 대비 QVA_EVOLUTION: ${result.signals.evolution > (result.signals.base + result.signals.v2) ? '신호 증가' : result.signals.evolution < (result.signals.base + result.signals.v2) ? '신호 감소' : '신호 동등'}`);
})();
