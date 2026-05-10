/**
 * QVA2 Screener — 고점 대비 충분히 내려온 자리에서 돈이 다시 들어온 첫 흔적
 *
 * QVA2 정의 (사용자 확정, 2026-05-09 재정의):
 *   "QVA2는 저점을 맞히는 모델이 아니라, 최근 고가 대비 충분히 내려온 자리에서,
 *    거래량과 거래대금이 다시 강하게 들어오기 시작한 첫 흔적을 잡는 모델이다."
 *
 *   반드시 동시에 만족:
 *     1. 최근 고점 대비 충분히 내려온 자리
 *     2. 아직 고점권이 아닌 자리
 *     3. 그 자리에서 거래량과 거래대금이 다시 강하게 살아나는 날
 *
 *   기존 QVA(`calculateRedefinedQVA`, `calculateQuietVolumeAnomaly`)는 절대 건드리지 않는다.
 *   QVA2는 기존 QVA의 대체가 아니라 별도 실험 라인.
 *
 * 두 경로 OR (둘 다 공통 위치 필터를 먼저 통과해야 함):
 *   A) absorption — 마감 약하지만 장중 저가에서 회복 + 거래대금 강함
 *   B) spike      — 장중 강한 반응 + 거래대금 폭발 (캔들 모양 무관, 단 closeLoc ≥ 0.25)
 *
 * 핵심 — close ≥ low20 × 0.98 은 "저점권 조건"이 아니다.
 *   이건 단지 "저점을 깨고 무너지지 않았다"는 이탈 방지 필터.
 *   진짜 저점권 판단은 drawdownFromHigh60 / drawdownFromHigh120 / pricePosition 으로 한다.
 */

// 임계값은 QVA2_CONFIG 한 곳에서만 관리한다.
const QVA2_CONFIG = Object.freeze({
  // ── 메타·유동성 ─────────────────────────────────────────
  marketCapMin: 50_000_000_000,            // 500억
  marketCapMax: 5_000_000_000_000,         // 5조
  minAvgValue20: 1_000_000_000,            // 평균 거래대금 10억
  minHistoryDays: 120,                     // 120거래일 이상 history 필요

  // ── 공통 위치 필터 (qva2CommonLocationFilter) ─────────
  // 1. 고점 대비 조정 구간 — 최소 한 쪽 이상 만족
  minDrawdownFromHigh60: 25,               // (high60 - close) / high60 ≥ 25%
  minDrawdownFromHigh120: 30,              // (high120 - close) / high120 ≥ 30%
  // 2. 가격 위치 — 최소 한 쪽 이상 만족
  maxPricePosition60: 0.55,                // (close - low60) / (high60 - low60) ≤ 0.55
  maxPricePosition120: 0.60,
  // 3. 최근 고점 근접 제외
  minDistanceFromHigh60: 15,               // (high60 - close) / high60 ≥ 15%
  // 4. 저점에서 이미 너무 오른 종목 제외
  maxRiseFromLow60: 55,                    // (close / low60 - 1) × 100 ≤ 55%
  // 5. 저점 붕괴 제외
  low20BreakTolerance: 0.98,               // close ≥ low20 × 0.98
  low60BreakTolerance: 0.95,               // close ≥ low60 × 0.95

  // ── 경로 A (absorption) ────────────────────────────────
  absorptionMinChangePct: -4,
  absorptionMaxChangePct: -1,
  absorptionMinCloseLocation: 0.35,
  absorptionMaxUpperWickRatio: 0.60,
  absorptionMaxBodyRatio: 0.65,
  absorptionMinVolumeRatio: 2.0,
  absorptionMinValueRatio: 2.0,

  // ── 경로 B (spike) ─────────────────────────────────────
  spikeMinIntradayHighPct: 10,             // (high / prevClose - 1) ≥ 10%
  spikeMinValueRatio: 5.0,                 // value ÷ median(prev20 value) ≥ 5
  // spike 핵심은 고점 대비 조정 + 거래대금 폭발 + 장중 강한 반응. 종가 위치는 핵심 아님.
  // 마음AI 2026-04-06 (closeLoc 11%, DD60 33%, DD120 45%) 같은 사례를 잡기 위해 0.10으로 완화.
  // absorption(0.35)은 그대로 유지.
  spikeMinCloseLocation: 0.10,
});

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 0 ? (s[n / 2 - 1] + s[n / 2]) / 2 : s[Math.floor(n / 2)];
}

/**
 * QVA2 detection at a specific day.
 *
 * @param {Array} chartRows  - chart rows (ascending date), each row { date, open, high, low, close, volume, valueApprox }
 * @param {number} dayIdx    - index into chartRows of the candidate day (the "today" of the QVA2 check)
 * @param {Object} meta      - { isEtf, isSpecial, marketValue, code, name, market }
 * @param {Object} overrides - partial QVA2_CONFIG overrides
 * @returns {Object|null}    - { passed, reason, signals, excludeReasons, ... } or null when chart insufficient
 */
function calculateQVA2(chartRows, dayIdx, meta = {}, overrides = {}) {
  if (!Array.isArray(chartRows) || chartRows.length === 0) return null;
  if (dayIdx == null || dayIdx < 0 || dayIdx >= chartRows.length) return null;

  const TH = { ...QVA2_CONFIG, ...overrides };
  const reject = (reason, debug = []) => ({ passed: false, qva2Type: 'none', reason, excludeReasons: debug, signals: null, tags: [] });

  // 메타 필터
  if (meta.isEtf || meta.isSpecial) return reject('etf_or_special', ['ETF/특수상품']);
  const marketValue = meta.marketValue || 0;
  if (marketValue > 0 && marketValue < TH.marketCapMin) {
    return reject('marketcap_too_small', [`시총 ${(TH.marketCapMin / 1e8).toFixed(0)}억 미만`]);
  }
  if (marketValue > 0 && TH.marketCapMax > 0 && marketValue > TH.marketCapMax) {
    return reject('marketcap_too_large', [`시총 ${(TH.marketCapMax / 1e12).toFixed(1)}조 초과 (대형주 제외)`]);
  }

  // 기준일 데이터 + history 길이 (120거래일 이상 필요)
  const today = chartRows[dayIdx];
  if (!today || !today.close || today.close <= 0) return null;
  if (dayIdx < TH.minHistoryDays - 1) {
    return reject('insufficient_history', [`이전 ${TH.minHistoryDays}거래일 데이터 부족 (idx=${dayIdx})`]);
  }
  const prev = chartRows[dayIdx - 1];
  if (!prev || !prev.close || prev.close <= 0) return null;

  // 캔들 모양
  const open = today.open, high = today.high, low = today.low, close = today.close;
  if (![open, high, low, close].every(v => Number.isFinite(v) && v > 0)) return null;
  const candleRange = high - low;
  const closeLocation = candleRange > 0 ? (close - low) / candleRange : 0.5;
  const upperWickRatio = candleRange > 0 ? (high - Math.max(open, close)) / candleRange : 0;
  const bodyRatio = candleRange > 0 ? Math.abs(close - open) / candleRange : 0;
  const isBearCandle = close < open;
  const changePct = ((close / prev.close) - 1) * 100;

  // 직전 20일 통계 (오늘 제외)
  const prev20 = chartRows.slice(dayIdx - 20, dayIdx);
  const prev20Volumes = prev20.map(r => r.volume || 0);
  const prev20Values  = prev20.map(r => r.valueApprox || 0);
  const avg20Vol   = prev20Volumes.reduce((s, v) => s + v, 0) / prev20.length;
  const avg20Value = prev20Values.reduce((s, v) => s + v, 0)  / prev20.length;
  const medianPrev20Volume = median(prev20Volumes);
  const medianPrev20Value  = median(prev20Values);

  const todayVolume = today.volume || 0;
  const todayValue  = today.valueApprox || (close * todayVolume) || 0;

  // 유동성 floor — 직전 20일 평균이 낮아도 당일 거래대금이 충분히 크면 통과.
  // QVA2의 본질("휴면 → 폭발 첫 흔적")을 살리기 위함. 진짜 거래정지·초저유동성
  // 종목 (당일도 10억 미만)만 컷한다.
  if (avg20Value < TH.minAvgValue20 && todayValue < TH.minAvgValue20) {
    return reject('avg20_and_today_value_below_floor', [
      `직전 20일 평균 거래대금 ${(avg20Value / 1e8).toFixed(1)}억 < ${(TH.minAvgValue20 / 1e8).toFixed(0)}억 AND 당일 거래대금 ${(todayValue / 1e8).toFixed(1)}억 < ${(TH.minAvgValue20 / 1e8).toFixed(0)}억`,
    ]);
  }
  const volumeRatio = medianPrev20Volume > 0 ? todayVolume / medianPrev20Volume : 0;
  const valueRatio  = medianPrev20Value  > 0 ? todayValue  / medianPrev20Value  : 0;

  // ─── 위치 데이터 (60/120일) ───
  const last20  = chartRows.slice(dayIdx - 19, dayIdx + 1);
  const last60  = chartRows.slice(dayIdx - 59, dayIdx + 1);
  const last120 = chartRows.slice(dayIdx - 119, dayIdx + 1);
  const low20  = Math.min(...last20.map(r => r.low));
  const low60  = Math.min(...last60.map(r => r.low));
  const low120 = Math.min(...last120.map(r => r.low));
  const high60  = Math.max(...last60.map(r => r.high));
  const high120 = Math.max(...last120.map(r => r.high));

  const drawdownFromHigh60  = high60  > 0 ? ((high60  - close) / high60)  * 100 : 0;
  const drawdownFromHigh120 = high120 > 0 ? ((high120 - close) / high120) * 100 : 0;
  const range60  = high60  - low60;
  const range120 = high120 - low120;
  const pricePosition60  = range60  > 0 ? (close - low60)  / range60  : 1;
  const pricePosition120 = range120 > 0 ? (close - low120) / range120 : 1;
  const riseFromLow20 = low20 > 0 ? ((close / low20) - 1) * 100 : 0;
  const riseFromLow60 = low60 > 0 ? ((close / low60) - 1) * 100 : 0;
  const distanceFromHigh60 = high60 > 0 ? ((high60 - close) / high60) * 100 : 0;

  // ─── 공통 위치 필터 (qva2CommonLocationFilter) ───
  const enoughPulledBack =
    drawdownFromHigh60 >= TH.minDrawdownFromHigh60 ||
    drawdownFromHigh120 >= TH.minDrawdownFromHigh120;
  const notHighZone =
    pricePosition60 <= TH.maxPricePosition60 ||
    pricePosition120 <= TH.maxPricePosition120;
  const notTooFarFromLow = riseFromLow60 <= TH.maxRiseFromLow60;
  const notNearRecentHigh = distanceFromHigh60 >= TH.minDistanceFromHigh60;
  const notBrokenDown =
    close >= low20 * TH.low20BreakTolerance &&
    close >= low60 * TH.low60BreakTolerance;

  const qva2CommonLocationFilter =
    enoughPulledBack &&
    notHighZone &&
    notTooFarFromLow &&
    notNearRecentHigh &&
    notBrokenDown;

  const excludeReasons = [];
  if (!enoughPulledBack) excludeReasons.push(`고점 대비 조정 부족 (DD60 ${drawdownFromHigh60.toFixed(1)}% < ${TH.minDrawdownFromHigh60}% AND DD120 ${drawdownFromHigh120.toFixed(1)}% < ${TH.minDrawdownFromHigh120}%)`);
  if (!notHighZone) excludeReasons.push(`아직 고점권 (pricePos60 ${(pricePosition60*100).toFixed(0)}% > ${(TH.maxPricePosition60*100).toFixed(0)}% AND pricePos120 ${(pricePosition120*100).toFixed(0)}% > ${(TH.maxPricePosition120*100).toFixed(0)}%)`);
  if (!notTooFarFromLow) excludeReasons.push(`저점에서 이미 너무 오름 (riseFromLow60 +${riseFromLow60.toFixed(1)}% > ${TH.maxRiseFromLow60}%)`);
  if (!notNearRecentHigh) excludeReasons.push(`최근 고점 너무 가까움 (distFromHigh60 ${distanceFromHigh60.toFixed(1)}% < ${TH.minDistanceFromHigh60}%)`);
  if (!notBrokenDown) {
    if (close < low20 * TH.low20BreakTolerance) excludeReasons.push(`20일 저점 이탈 (close ${close} < low20 ${low20} × ${TH.low20BreakTolerance})`);
    if (close < low60 * TH.low60BreakTolerance) excludeReasons.push(`60일 저점 큰 폭 이탈 (close ${close} < low60 ${low60} × ${TH.low60BreakTolerance})`);
  }

  // ─── 경로 A (absorption) ───
  const weakCloseButNotDead = changePct < TH.absorptionMaxChangePct && changePct >= TH.absorptionMinChangePct;
  const recoveredFromLow = closeLocation >= TH.absorptionMinCloseLocation;
  const notDumpCandle = closeLocation >= TH.absorptionMinCloseLocation && bodyRatio <= TH.absorptionMaxBodyRatio;
  const notUpperWickFailure = upperWickRatio <= TH.absorptionMaxUpperWickRatio;
  const strongVolumeAndValue = volumeRatio >= TH.absorptionMinVolumeRatio && valueRatio >= TH.absorptionMinValueRatio;

  const isQVA2Absorption =
    qva2CommonLocationFilter &&
    weakCloseButNotDead &&
    recoveredFromLow &&
    notDumpCandle &&
    notUpperWickFailure &&
    strongVolumeAndValue;

  if (!weakCloseButNotDead) {
    if (changePct >= TH.absorptionMaxChangePct) excludeReasons.push(`[A] 약세 마감 아님 (전일 대비 ${changePct.toFixed(2)}% ≥ ${TH.absorptionMaxChangePct}%)`);
    if (changePct < TH.absorptionMinChangePct)  excludeReasons.push(`[A] 과도한 하락 (전일 대비 ${changePct.toFixed(2)}% < ${TH.absorptionMinChangePct}%)`);
  }
  if (!recoveredFromLow) excludeReasons.push(`[A] 종가 위치 저가권 (closeLoc ${(closeLocation*100).toFixed(0)}% < ${(TH.absorptionMinCloseLocation*100).toFixed(0)}%)`);
  if (recoveredFromLow && bodyRatio > TH.absorptionMaxBodyRatio) excludeReasons.push(`[A] 큰 음봉/대봉 (bodyRatio ${(bodyRatio*100).toFixed(0)}% > ${(TH.absorptionMaxBodyRatio*100).toFixed(0)}%)`);
  if (!notUpperWickFailure) excludeReasons.push(`[A] 윗꼬리 과다 (upperWick ${(upperWickRatio*100).toFixed(0)}% > ${(TH.absorptionMaxUpperWickRatio*100).toFixed(0)}%)`);
  if (!strongVolumeAndValue) {
    if (volumeRatio < TH.absorptionMinVolumeRatio) excludeReasons.push(`[A] 거래량 부족 (×${volumeRatio.toFixed(2)} < ${TH.absorptionMinVolumeRatio})`);
    if (valueRatio  < TH.absorptionMinValueRatio)  excludeReasons.push(`[A] 거래대금 부족 (×${valueRatio.toFixed(2)} < ${TH.absorptionMinValueRatio})`);
  }

  // ─── 경로 B (spike) ───
  const intradayHighPct = prev.close > 0 ? ((high / prev.close) - 1) * 100 : 0;
  const strongIntradaySpike = intradayHighPct >= TH.spikeMinIntradayHighPct;
  const extremeValueInflow = valueRatio >= TH.spikeMinValueRatio;
  const minimumCloseRecovery = closeLocation >= TH.spikeMinCloseLocation;

  const isQVA2Spike =
    qva2CommonLocationFilter &&
    strongIntradaySpike &&
    extremeValueInflow &&
    minimumCloseRecovery;

  if (!strongIntradaySpike) excludeReasons.push(`[B] 장중 폭등 부족 (intradayHigh +${intradayHighPct.toFixed(1)}% < ${TH.spikeMinIntradayHighPct}%)`);
  if (!extremeValueInflow) excludeReasons.push(`[B] 거래대금 폭발 부족 (×${valueRatio.toFixed(2)} < ${TH.spikeMinValueRatio})`);
  if (!minimumCloseRecovery) excludeReasons.push(`[B] 종가 너무 저가권 (closeLoc ${(closeLocation*100).toFixed(0)}% < ${(TH.spikeMinCloseLocation*100).toFixed(0)}%)`);

  // ─── 통합 ───
  const passed = isQVA2Absorption || isQVA2Spike;
  const qva2Type = isQVA2Absorption && isQVA2Spike ? 'both'
                : isQVA2Absorption ? 'absorption'
                : isQVA2Spike ? 'spike'
                : 'none';

  // ─── 점수 (100점 만점) ───
  let score = 0;
  // 위치 30점 — 고점 대비 조정폭이 클수록, 가격 위치가 낮을수록 가산
  if (drawdownFromHigh60 >= 50) score += 12;
  else if (drawdownFromHigh60 >= 40) score += 9;
  else if (drawdownFromHigh60 >= 30) score += 6;
  else if (drawdownFromHigh60 >= 25) score += 3;
  if (drawdownFromHigh120 >= 60) score += 8;
  else if (drawdownFromHigh120 >= 45) score += 5;
  else if (drawdownFromHigh120 >= 30) score += 2;
  if (pricePosition60 <= 0.25) score += 6;
  else if (pricePosition60 <= 0.40) score += 4;
  else if (pricePosition60 <= 0.55) score += 2;
  if (riseFromLow60 <= 15) score += 4;
  else if (riseFromLow60 <= 30) score += 2;

  // 거래대금/거래량 강도 30점
  if (valueRatio >= 8)        score += 18;
  else if (valueRatio >= 5)   score += 14;
  else if (valueRatio >= 3.5) score += 10;
  else if (valueRatio >= 2.5) score += 6;
  else if (valueRatio >= 2.0) score += 3;
  if (volumeRatio >= 5)       score += 12;
  else if (volumeRatio >= 3.5) score += 9;
  else if (volumeRatio >= 2.5) score += 5;
  else if (volumeRatio >= 2.0) score += 2;

  // type별 추가 점수 (40점)
  if (qva2Type === 'absorption' || qva2Type === 'both') {
    if (closeLocation >= 0.65) score += 12;
    else if (closeLocation >= 0.50) score += 8;
    else if (closeLocation >= 0.35) score += 4;
    if (upperWickRatio <= 0.25) score += 8;
    else if (upperWickRatio <= 0.45) score += 4;
    if (changePct >= -2.0) score += 12;
    else if (changePct >= -3.0) score += 6;
    else if (changePct >= -4.0) score += 2;
  } else if (qva2Type === 'spike') {
    if (intradayHighPct >= 25) score += 18;
    else if (intradayHighPct >= 15) score += 12;
    else if (intradayHighPct >= 10) score += 6;
    if (closeLocation >= 0.50) score += 8;
    else if (closeLocation >= 0.35) score += 5;
    else if (closeLocation >= 0.25) score += 2;
    if (close >= prev.close) score += 6;
  }

  // 등급
  let grade = 'NONE', gradeLabel = null;
  if (qva2Type === 'spike') {
    if (score >= 70) { grade = 'STRONG_SPIKE'; gradeLabel = '강한 spike (저점권 + 거래대금 폭발)'; }
    else if (score >= 55) { grade = 'SPIKE'; gradeLabel = 'spike (저점권 + 장중 강한 반응)'; }
    else if (score >= 40) { grade = 'WATCH_SPIKE'; gradeLabel = '관찰 — spike'; }
  } else if (qva2Type === 'absorption' || qva2Type === 'both') {
    if (score >= 70) { grade = 'STRONG_QVA2'; gradeLabel = '강한 QVA2 (저점권 + 흡수 흔적)'; }
    else if (score >= 55) { grade = 'QVA2'; gradeLabel = 'QVA2 (저점권 + 흡수 흔적)'; }
    else if (score >= 40) { grade = 'WATCH_QVA2'; gradeLabel = '관찰 — 약한 흡수 흔적'; }
  }

  let closeLocationLabel;
  if (closeLocation >= 0.65) closeLocationLabel = '고가권';
  else if (closeLocation >= 0.40) closeLocationLabel = '중간 이상';
  else closeLocationLabel = '저가권';

  return {
    passed,
    qva2Type,
    reason: passed ? `qva2_pass_${qva2Type}` : (excludeReasons[0] || 'no_match'),
    excludeReasons,
    grade, gradeLabel, score: Math.round(score),
    paths: {
      commonLocationFilter: qva2CommonLocationFilter,
      absorption: isQVA2Absorption,
      spike: isQVA2Spike,
    },
    signals: {
      date: today.date,
      open, high, low, close,
      prevClose: prev.close,
      changePct: +changePct.toFixed(2),
      intradayHighPct: +intradayHighPct.toFixed(2),
      closeLocation: +closeLocation.toFixed(3),
      closeLocationLabel,
      upperWickRatio: +upperWickRatio.toFixed(3),
      bodyRatio: +bodyRatio.toFixed(3),
      isBearCandle,
      todayVolume,
      todayValue,
      volumeRatio: +volumeRatio.toFixed(2),
      valueRatio:  +valueRatio.toFixed(2),
      avg20Volume: Math.round(avg20Vol),
      avg20Value:  Math.round(avg20Value),
      medianPrev20Volume: Math.round(medianPrev20Volume),
      medianPrev20Value:  Math.round(medianPrev20Value),
      // 위치 (재정의 핵심 — 이게 진짜 저점권 판단)
      high60, low60, high120, low120, low20,
      drawdownFromHigh60:  +drawdownFromHigh60.toFixed(2),
      drawdownFromHigh120: +drawdownFromHigh120.toFixed(2),
      pricePosition60:     +pricePosition60.toFixed(3),
      pricePosition120:    +pricePosition120.toFixed(3),
      riseFromLow20: +riseFromLow20.toFixed(2),
      riseFromLow60: +riseFromLow60.toFixed(2),
      distanceFromHigh60: +distanceFromHigh60.toFixed(2),
      // 호환 필드 (기존 보드/검증 코드가 쓰던 이름) — 새 의미로 alias
      volumeRatio20: +volumeRatio.toFixed(2),
      valueRatio20:  +valueRatio.toFixed(2),
      recentLow20: low20, recentLow60: low60,
      low20HoldPct: low20 > 0 ? +(((close / low20) - 1) * 100).toFixed(2) : null,
      low60HoldPct: low60 > 0 ? +(((close / low60) - 1) * 100).toFixed(2) : null,
    },
    tags: passed ? buildTags({ qva2Type, closeLocation, valueRatio, volumeRatio, changePct, upperWickRatio, low20, close, intradayHighPct, drawdownFromHigh60 }) : [],
  };
}

function buildTags({ qva2Type, closeLocation, valueRatio, volumeRatio, changePct, upperWickRatio, low20, close, intradayHighPct, drawdownFromHigh60 }) {
  const tags = [];
  // 위치 태그 (공통)
  if (drawdownFromHigh60 >= 40) tags.push(`고점 -${drawdownFromHigh60.toFixed(0)}% 깊은 조정`);
  else if (drawdownFromHigh60 >= 25) tags.push(`고점 -${drawdownFromHigh60.toFixed(0)}% 조정`);

  if (qva2Type === 'spike' || qva2Type === 'both') {
    tags.push('거래대금 폭발');
    if (intradayHighPct >= 20) tags.push(`장중 +${intradayHighPct.toFixed(0)}% 폭등`);
    else tags.push(`장중 +${intradayHighPct.toFixed(0)}%`);
  }
  if (qva2Type === 'absorption' || qva2Type === 'both') {
    if (closeLocation >= 0.45) tags.push('장중 방어 흔적');
    if (changePct < -1) tags.push('마감 약함');
    if (closeLocation >= 0.35 && upperWickRatio <= 0.60) tags.push('투매형 제외 통과');
  }
  if (valueRatio >= 5) tags.push(`거래대금 ×${valueRatio.toFixed(1)}`);
  else if (valueRatio >= 3) tags.push('거래대금 강함');
  if (low20 > 0 && close >= low20 * 1.02) tags.push('저점 이탈 없음');
  return tags;
}

/**
 * 한 chart에 대해 최근 lookbackDays 거래일 안의 모든 QVA2 신호를 반환.
 * Validation/board 양쪽에서 공유.
 */
function findQVA2Events(chartRows, meta, lookbackDays = 20, overrides = {}) {
  const minHist = (overrides && overrides.minHistoryDays) || QVA2_CONFIG.minHistoryDays;
  if (!Array.isArray(chartRows) || chartRows.length < minHist) return [];
  const out = [];
  const start = Math.max(minHist, chartRows.length - lookbackDays);
  for (let i = start; i < chartRows.length; i++) {
    const r = calculateQVA2(chartRows, i, meta, overrides);
    if (r && r.passed) {
      out.push({ idx: i, date: chartRows[i].date, ...r });
    }
  }
  return out;
}

// ─── VVI2 탐지 ───
// QVA2 type별로 다른 정의:
//
//   absorption type — 정상 흡수 캔들 후속 재돌파:
//     1) high > qva2High           (그날 만든 고가 재돌파)
//     2) volume ≥ qva2Volume       (거래량 동등 이상)
//     3) value  ≥ qva2Value        (거래대금 동등 이상)
//     4) closeLocation ≥ 0.50      (강한 종가 마감)
//     5) qva2Close × 0.95 이상 유지 (이탈 시 자격 박탈)
//
//   spike type — 윗꼬리 폭발 캔들 후속 재돌파:
//     spike 캔들의 high/volume/value는 비정상적으로 높아서 anchor로 부적합.
//     대신 spike 종가(qva2Close) 재돌파 + 적당한 거래대금 + 강한 종가 마감을 본다.
//     1) close > qva2Close          (종가가 spike 당일 종가 이상으로 회복/돌파)
//     2) closeLocation ≥ 0.50       (강한 종가 마감)
//     3) value ≥ prev20 median × 2  (그날 평균 대비 2배 이상 — 거래대금 살아있음)
//     4) qva2Close × 0.95 이상 유지 (자격 박탈 동일)
const VVI2_CONFIG = Object.freeze({
  minClosePullback: -0.05,            // qva2Close × 0.95 이하면 자격 박탈 (공통)
  minVvi2CloseLocation: 0.50,         // 공통
  // spike type 전용
  spikeValueMedianMultMin: 2.0,       // value ≥ prev20 median × 2.0
});

/**
 * @param {Array} rows         chart rows
 * @param {number} qva2Idx     QVA2 발생일의 인덱스
 * @param {number} maxDays     QVA2 이후 최대 N 거래일 안에서 탐색 (0이면 끝까지)
 * @param {Object} opts        { qva2Type: 'absorption'|'spike'|'both' } (default 'absorption' for backward compat)
 * @returns {Object}           { vvi2Idx, breakBeforeVvi2, breakDate, priceOnlyIdx, postQvaMaxHigh }
 */
function findVvi2AfterQva2(rows, qva2Idx, maxDays = 0, opts = {}) {
  const TH = { ...VVI2_CONFIG, ...(opts.overrides || {}) };
  const qva2Type = opts.qva2Type || 'absorption';
  const out = {
    vvi2Idx: -1,
    breakBeforeVvi2: false, breakDate: null,
    priceOnlyIdx: -1,
    postQvaMaxHigh: null,
    qva2Type,
  };
  if (!Array.isArray(rows) || qva2Idx < 0 || qva2Idx >= rows.length) return out;
  const qva2 = rows[qva2Idx];
  const qva2High = qva2.high, qva2Close = qva2.close;
  const qva2Volume = qva2.volume || 0, qva2Value = qva2.valueApprox || 0;
  if (!qva2High || !qva2Close || qva2Volume <= 0 || qva2Value <= 0) return out;

  // spike 경로용: 평가일 직전 20일 median (매일 갱신)
  function medianAt(idx, key) {
    const start = Math.max(0, idx - 20);
    const arr = rows.slice(start, idx).map(r => (key === 'volume' ? (r.volume || 0) : (r.valueApprox || 0)));
    if (arr.length < 10) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    return n % 2 === 0 ? (sorted[n/2 - 1] + sorted[n/2]) / 2 : sorted[Math.floor(n/2)];
  }

  const endIdx = maxDays > 0 ? Math.min(rows.length - 1, qva2Idx + maxDays) : rows.length - 1;
  for (let i = qva2Idx + 1; i <= endIdx; i++) {
    const r = rows[i];
    if (!r || !r.close) continue;
    if (out.postQvaMaxHigh == null || r.high > out.postQvaMaxHigh) out.postQvaMaxHigh = r.high;

    // 자격 박탈 (공통)
    if (r.close < qva2Close * (1 + TH.minClosePullback)) {
      out.breakBeforeVvi2 = true;
      out.breakDate = r.date;
      return out;
    }

    const range = r.high - r.low;
    const closeLocation = range > 0 ? (r.close - r.low) / range : 0.5;
    const okLoc = closeLocation >= TH.minVvi2CloseLocation;

    if (qva2Type === 'spike') {
      // spike VVI2 (사용자 spec 통일):
      //   close > qva2Close
      //   AND closeLoc ≥ 0.50
      //   AND (valueRatio ≥ 2.0 OR value ≥ qva2Value × 0.8)
      //   AND (volumeRatio ≥ 1.5 OR volume ≥ qva2Volume × 0.8)
      const closeOverQva2 = r.close > qva2Close;
      const m20Val = medianAt(i, 'value');
      const m20Vol = medianAt(i, 'volume');
      const valueRatio  = m20Val > 0 ? (r.valueApprox || 0) / m20Val : 0;
      const volumeRatio = m20Vol > 0 ? (r.volume || 0) / m20Vol : 0;
      const valOk = valueRatio >= 2.0 || (r.valueApprox || 0) >= qva2Value * 0.8;
      const volOk = volumeRatio >= 1.5 || (r.volume || 0) >= qva2Volume * 0.8;
      if (closeOverQva2 && okLoc && valOk && volOk) {
        out.vvi2Idx = i;
        return out;
      } else if (closeOverQva2 && out.priceOnlyIdx < 0) {
        out.priceOnlyIdx = i;
      }
    } else {
      // absorption (기본) VVI2: high > qva2High + vol + val + closeLoc
      if (r.high > qva2High) {
        const okVol = (r.volume || 0) >= qva2Volume;
        const okVal = (r.valueApprox || 0) >= qva2Value;
        if (okVol && okVal && okLoc) {
          out.vvi2Idx = i;
          return out;
        } else if (out.priceOnlyIdx < 0) {
          out.priceOnlyIdx = i;
        }
      }
    }
  }
  return out;
}

// ─── VVI3 탐지 (단순 정의) ───
// QVA2 발생일 이후 어느 날이든 close ≥ qva2Close 으로 마감하면 VVI3.
// 거래량·거래대금·closeLocation 모두 무시. 종가만 본다.
// 가장 빠른 그런 날을 VVI3로 정한다.
//
// @param {Array} rows         chart rows
// @param {number} qva2Idx     QVA2 발생일의 인덱스
// @param {number} maxDays     최대 N 거래일 안에서 탐색 (0이면 끝까지)
// @returns {Object}           { vvi3Idx, vvi3Date, vvi3Close, daysToVvi3 } 또는 vvi3Idx === -1
function findVvi3AfterQva2(rows, qva2Idx, maxDays = 0) {
  const out = { vvi3Idx: -1, vvi3Date: null, vvi3Close: null, daysToVvi3: null };
  if (!Array.isArray(rows) || qva2Idx < 0 || qva2Idx >= rows.length) return out;
  const qva2Close = rows[qva2Idx].close;
  if (!qva2Close || qva2Close <= 0) return out;
  const endIdx = maxDays > 0 ? Math.min(rows.length - 1, qva2Idx + maxDays) : rows.length - 1;
  for (let i = qva2Idx + 1; i <= endIdx; i++) {
    const r = rows[i];
    if (!r || !r.close) continue;
    if (r.close >= qva2Close) {
      out.vvi3Idx = i;
      out.vvi3Date = r.date;
      out.vvi3Close = r.close;
      out.daysToVvi3 = i - qva2Idx;
      return out;
    }
  }
  return out;
}

module.exports = {
  QVA2_CONFIG,
  VVI2_CONFIG,
  calculateQVA2,
  findQVA2Events,
  findVvi2AfterQva2,
  findVvi3AfterQva2,
};
