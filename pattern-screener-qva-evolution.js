// calculateQvaEvolution 함수 — QVA_EVOLUTION 점수 모델
// 100점 만점 점수 기반 QVA 신호. 제일기획 같은 방어형 횡보주 필터링.

function calculateQvaEvolution(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  // ─── 기본 필터 ───
  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  if ((meta.marketValue || 0) > 0 && meta.marketValue < 50_000_000_000) return reject('cap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const last5 = chartRows.slice(-5);
  const last10 = chartRows.slice(-10);
  const last20 = chartRows.slice(-20);
  const last60 = chartRows.slice(-60);

  const avg20Value = last20.reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = last20.reduce((s, r) => s + (r.volume || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  const todayValue = today.valueApprox || (today.close * today.volume);
  const valueRatio20 = todayValue / (avg20Value || 1);
  const volumeRatio20 = (today.volume || 0) / (avg20Vol || 1);

  // ─── 1. 거래대금 돌출 (25점) ───
  const median20Values = median(last20.map(r => r.valueApprox || 0));
  const valueMedianRatio20 = median20Values > 0 ? todayValue / median20Values : 0;

  let valueScore = 0;
  if (valueRatio20 >= 3.0) valueScore += 10;
  else if (valueRatio20 >= 2.5) valueScore += 8;
  else if (valueRatio20 >= 2.0) valueScore += 6;
  else if (valueRatio20 >= 1.7) valueScore += 4;
  else if (valueRatio20 >= 1.5) valueScore += 2;

  if (valueMedianRatio20 >= 3.0) valueScore += 15;
  else if (valueMedianRatio20 >= 2.5) valueScore += 10;
  else if (valueMedianRatio20 >= 2.0) valueScore += 8;
  else if (valueMedianRatio20 >= 1.8) valueScore += 5;

  // ─── 2. 거래량 돌출 (15점) ───
  let volumeScore = 0;
  if (volumeRatio20 >= 3.0) volumeScore = 15;
  else if (volumeRatio20 >= 2.5) volumeScore = 12;
  else if (volumeRatio20 >= 2.0) volumeScore = 10;
  else if (volumeRatio20 >= 1.7) volumeScore = 7;
  else if (volumeRatio20 >= 1.5) volumeScore = 4;

  // ─── 3. 가격 미반응 (15점) ───
  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  const ret5d = idx >= 5 ? (close / chartRows[idx - 5].close - 1) : 0;
  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;

  let priceScore = 0;
  if (todayReturn >= 0 && todayReturn <= 0.03) priceScore += 10;
  else if (todayReturn > 0.03 && todayReturn <= 0.05) priceScore += 6;
  else if (todayReturn >= -0.01 && todayReturn < 0) priceScore += 5;
  else if (todayReturn > 0.05) priceScore -= 5;

  if (ret5d <= 0.08) priceScore += 3;
  if (ret20d <= 0.15) priceScore += 2;

  // ─── 4. 구조 진화 (25점) — 6개 조건 중 개수 세기 ───
  // 조건 1: higherLow5
  const lows5 = last5.map(r => r.low);
  const lows20to25 = chartRows.slice(-25, -5).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;
  const higherLow5 = min5 > min20;

  // 조건 2: recentCloseLowHigher
  const closeLow5 = Math.min(...last5.map(r => r.close));
  const closeLow20to25 = Math.min(...chartRows.slice(-25, -5).map(r => r.close));
  const recentCloseLowHigher = closeLow5 > closeLow20to25;

  // 조건 3: ma5SlopeUp
  const ma5 = sma(last5.map(r => r.close), 5);
  const ma5Prev = chartRows.length >= 9 ? sma(chartRows.slice(-9, -4).map(r => r.close), 5) : null;
  const ma5SlopeUp = ma5 && ma5Prev ? (ma5 > ma5Prev) : false;

  // 조건 4: ma20SlopeUp (상향 또는 하락 둔화 >= 0.995)
  const ma20 = sma(last20.map(r => r.close), 20);
  const ma20Prev = chartRows.length >= 25 ? sma(chartRows.slice(-25, -5).map(r => r.close), 20) : null;
  const ma20SlopeUp = ma20 && ma20Prev ? (ma20 >= ma20Prev * 0.995) : false;

  // 조건 5: closeAboveMa20
  const closeAboveMa20 = ma20 != null && close >= ma20;

  // 조건 6: recentHighNearBreak
  const high5 = Math.max(...last5.map(r => r.high));
  const high20to25 = Math.max(...chartRows.slice(-25, -5).map(r => r.high));
  const recentHighNearBreak = high5 >= high20to25 * 0.97;

  // 6개 조건 중 개수 세기 (recentCloseHighBreak는 제외)
  const structureConditions = [
    higherLow5,
    recentCloseLowHigher,
    ma5SlopeUp,
    ma20SlopeUp,
    closeAboveMa20,
    recentHighNearBreak,
  ];
  const structureCount = structureConditions.filter(Boolean).length;

  let structureScore = 0;
  if (structureCount >= 5) structureScore = 25;
  else if (structureCount >= 4) structureScore = 20;
  else if (structureCount >= 3) structureScore = 15;
  else if (structureCount >= 2) structureScore = 8;

  // ─── 5. 탄력/위치 (10점) ───
  const high10 = Math.max(...last10.map(r => r.high));
  const low10 = Math.min(...last10.map(r => r.low));
  const rangeExpansion10 = low10 > 0 ? (high10 / low10 - 1) : 0;

  const high20 = Math.max(...last20.map(r => r.high));
  const high60 = Math.max(...last60.map(r => r.high));
  const distToHigh20 = high20 > 0 ? ((high20 - close) / high20) : 1;
  const distToHigh60 = high60 > 0 ? ((high60 - close) / high60) : 1;

  let elasticityScore = 0;
  if (rangeExpansion10 >= 0.04 && rangeExpansion10 <= 0.18) elasticityScore += 5;
  else if (rangeExpansion10 > 0 && rangeExpansion10 < 0.04) elasticityScore += 2;
  if (distToHigh20 <= 0.12) elasticityScore += 3;
  if (distToHigh60 <= 0.25) elasticityScore += 2;

  // ─── 6. 리스크 감점 (최대 -10점) ───
  const upperWick = today.high > close ? today.high - close : 0;
  const bodyRange = Math.abs(close - today.open) || 1;
  const upperWickRatio = upperWick / bodyRange;
  const { atr } = computeATR(chartRows, idx, 14);
  const atrPct = atr / close;

  let riskDeduction = 0;
  if (upperWickRatio > 0.45) riskDeduction += 5;
  if (ret5d > 0.12) riskDeduction += 5;
  if (ret20d > 0.25) riskDeduction += 5;
  if (atrPct > 0.30) riskDeduction += 5;
  riskDeduction = Math.min(riskDeduction, 10);

  // ─── 총점 계산 ───
  const totalScore = Math.round(valueScore + volumeScore + priceScore + structureScore + elasticityScore - riskDeduction);

  // ─── 최종 통과 조건 ───
  if (structureCount < 3) return reject('structure<3');
  if (valueMedianRatio20 < 2.0) return reject('valueMedianRatio<2.0');
  if (totalScore < 70) return reject(`score<70_${totalScore}`);

  // DEBUG: 제일기획 로그
  if (meta?.code === '030000') {
    console.log(`    QVA_EVOLUTION 상세:`);
    console.log(`      valueScore=${valueScore}, volumeScore=${volumeScore}, priceScore=${priceScore}`);
    console.log(`      structureScore=${structureScore} (count=${structureCount}/6)`);
    console.log(`      elasticityScore=${elasticityScore}, riskDeduction=${riskDeduction}`);
    console.log(`      totalScore=${totalScore}`);
    console.log(`      valueMedianRatio20=${valueMedianRatio20.toFixed(2)}, rangeExpansion10=${(rangeExpansion10*100).toFixed(1)}%`);
  }

  return {
    passed: true,
    model: 'QVA_EVOLUTION',
    score: totalScore,
    breakdown: {
      valueScore,
      volumeScore,
      priceScore,
      structureScore,
      elasticityScore,
      riskDeduction,
      structureCount,
    },
    signals: {
      valueRatio20: +valueRatio20.toFixed(2),
      volumeRatio20: +volumeRatio20.toFixed(2),
      valueMedianRatio20: +valueMedianRatio20.toFixed(2),
      todayReturn: +(todayReturn * 100).toFixed(2),
      ret5d: +(ret5d * 100).toFixed(2),
      ret20d: +(ret20d * 100).toFixed(2),
      upperWickRatio: +upperWickRatio.toFixed(2),
      atrPct: +(atrPct * 100).toFixed(2),
      rangeExpansion10: +(rangeExpansion10 * 100).toFixed(1),
      distToHigh20Pct: +(distToHigh20 * 100).toFixed(1),
      distToHigh60Pct: +(distToHigh60 * 100).toFixed(1),
      // 구조 지표 (bool)
      higherLow5,
      recentCloseLowHigher,
      ma5SlopeUp,
      ma20SlopeUp,
      closeAboveMa20,
      recentHighNearBreak,
      structureCount,
    },
  };
}
