/**
 * BMS Buy Candidate Core
 *
 * 재사용 가능한 BMS 후보 계산 모듈.
 * 라이브 보드(bms-buy-candidate-board.js)와 cutoff 백테스트(추후) 모두에서 동일 로직 사용.
 *
 * 핵심 진입점:
 *   calculateBmsCandidateForDate(rows, cutoffIdx, meta) → candidate 객체
 *
 * 데이터 누수 방지:
 *   cutoffIdx 시점까지의 rows.slice(0, cutoffIdx + 1) 만 사용. 이후 데이터는 절대 참조하지 않음.
 *
 * 점수 / 조건 정의는 이전 감사 보고서와 동일:
 *   - 정석 BMS: 들어온 돈 5~40% / 저점 +10~+45% / 고점 -40~-10%
 *   - 강한 BMS: 들어온 돈 10~40% / 동일 가격 위치
 *   - 단순 점수: 35 + 25 + 25 - 위험 감점(0~15) → 0~85 범위
 */

'use strict';

// ─────────────────────── CONFIG (조정 가능) ───────────────────────

const CONFIG = {
  PRE_ACCUM_DAYS: 20,    // 시총 대비 들어온 돈 — 누적 일수
  PRICE_POSITION_DAYS: 60, // 60일 저점/고점 기준
  MIN_HISTORY: 60,       // 최소 차트 길이
};

const VALUE_RATIO_GROUPS = [
  { key: 'insufficient_0_5', min: 0, max: 5,        label: '유입 부족',       role: 'BMS 제외/약함' },
  { key: 'support_5_10',     min: 5, max: 10,       label: '초기 유입 참고',   role: 'BMS 보조' },
  { key: 'core_10_20',       min: 10, max: 20,      label: '핵심 구간',       role: 'BMS 핵심' },
  { key: 'core_20_40',       min: 20, max: 40,      label: '강한 핵심 구간',   role: 'BMS 핵심' },
  { key: 'caution_40_80',    min: 40, max: 80,      label: '거래 과다 주의',   role: '주의' },
  { key: 'overheat_80_plus', min: 80, max: Infinity, label: '과열 가능',       role: '강한 주의' },
];

const CORE_CONDITION = {
  CLASSIC: {
    label: '정석 BMS 조건',
    description: '상승 전 거래대금이 적당히 지나갔고, 주가는 저점에서 어느 정도 회복했지만 아직 고점까지 공간이 남아 있는 조건입니다.',
    valueRatioMin: 5, valueRatioMax: 40,
    low60Min: 10, low60Max: 45,
    high60Min: -40, high60Max: -10,
  },
  STRONG: {
    label: '강한 BMS 조건',
    description: '상승 전 거래대금이 BMS 중심 구간에 있고, 가격 위치도 저점 회복·고점 여유 조건에 들어오는 더 엄격한 조건입니다.',
    valueRatioMin: 10, valueRatioMax: 40,
    low60Min: 10, low60Max: 45,
    high60Min: -40, high60Max: -10,
  },
};

const SCORE_GRADES = {
  strong:  { min: 85, label: '강한 BMS 점수',  explanation: '상승 전 들어온 돈과 가격 위치가 모두 BMS 핵심 조건에 가까운 사례입니다.' },
  classic: { min: 70, label: '정석 BMS 점수',  explanation: 'BMS 핵심 조건을 상당 부분 만족하는 사례입니다.' },
  partial: { min: 50, label: '일부 조건 만족',  explanation: '일부 조건은 맞지만 핵심 조건이 부족한 사례입니다.' },
  weak:    { min: 0,  label: 'BMS 조건 약함',  explanation: 'BMS 핵심 조건과는 거리가 있는 사례입니다.' },
};

// ─────────────────────── 유틸 ───────────────────────

function round(v, d) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function pct(num, den) { if (!den || den === 0) return null; return round(num / den * 100, 2); }
function isNum(v) { return v != null && isFinite(v); }

function findIdxByDate(rows, date) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === date) return i;
    if (rows[i].date < date) break;
  }
  return -1;
}

function findLatestIdx(rows) {
  return rows.length > 0 ? rows.length - 1 : -1;
}

// ─────────────────────── 핵심 변수 계산 ───────────────────────

/**
 * 시총 대비 상승 전 들어온 돈 (20거래일 누적 거래대금 / 시총 * 100)
 * cutoffIdx 포함 직전 20거래일의 valueApprox 합계 사용.
 */
function computeValueRatio(rows, cutoffIdx, marketCap) {
  if (cutoffIdx < CONFIG.PRE_ACCUM_DAYS - 1) return null;
  if (!marketCap || marketCap <= 0) return null;
  const start = cutoffIdx - CONFIG.PRE_ACCUM_DAYS + 1;
  let sum = 0;
  let validDays = 0;
  for (let i = start; i <= cutoffIdx; i++) {
    const v = rows[i]?.valueApprox;
    if (v != null && isFinite(v)) { sum += v; validDays++; }
  }
  if (validDays < CONFIG.PRE_ACCUM_DAYS * 0.5) return null;
  return round(sum / marketCap * 100, 2);
}

/**
 * 시작일 거래대금 / 시총 (cutoff 당일 거래대금)
 */
function computeStartDayValueRatio(rows, cutoffIdx, marketCap) {
  if (!marketCap || marketCap <= 0) return null;
  const v = rows[cutoffIdx]?.valueApprox;
  if (!isNum(v)) return null;
  return round(v / marketCap * 100, 2);
}

/**
 * 60일 OHLC 기준 가격 위치
 *   - closeFromLow60: (close - low60) / low60 * 100
 *   - closeFromHigh60: (close - high60) / high60 * 100  (음수)
 *   - positionInRange: 박스권 안 위치 0% ~ 100%
 */
function computePricePosition(rows, cutoffIdx) {
  const days = CONFIG.PRICE_POSITION_DAYS;
  if (cutoffIdx < days - 1) return { dataLimit: '60일 데이터 부족' };
  const today = rows[cutoffIdx];
  const close = today?.close;
  if (!isNum(close) || close <= 0) return { dataLimit: '종가 없음' };
  const start = cutoffIdx - days + 1;
  let low = Infinity, high = -Infinity;
  for (let i = start; i <= cutoffIdx; i++) {
    const r = rows[i];
    if (!r) continue;
    if (isNum(r.low) && r.low > 0 && r.low < low) low = r.low;
    if (isNum(r.high) && r.high > high) high = r.high;
  }
  if (!isFinite(low) || !isFinite(high) || low <= 0) return { dataLimit: '60일 OHLC 없음' };
  const closeFromLow60 = round((close - low) / low * 100, 2);
  const closeFromHigh60 = round((close - high) / high * 100, 2);
  const denom = closeFromLow60 - closeFromHigh60;
  const positionInRange = denom > 0 ? round(closeFromLow60 / denom * 100, 2) : null;
  return { close, low60: round(low, 0), high60: round(high, 0), closeFromLow60, closeFromHigh60, positionInRange };
}

/**
 * 시총 대비 들어온 돈 구간 분류
 */
function classifyValueRatioGroup(vRatio) {
  if (!isNum(vRatio)) return { groupKey: 'no_data', groupLabel: '데이터 없음', groupRole: '판정 불가' };
  for (const g of VALUE_RATIO_GROUPS) {
    if (vRatio >= g.min && vRatio < g.max) return { groupKey: g.key, groupLabel: g.label, groupRole: g.role };
  }
  return { groupKey: 'no_data', groupLabel: '데이터 없음', groupRole: '판정 불가' };
}

// ─────────────────────── 정석/강한 조건 검사 ───────────────────────

function checkRule(rule, vRatio, lf, hf) {
  const valueRatio = isNum(vRatio) && vRatio >= rule.valueRatioMin && vRatio <= rule.valueRatioMax;
  const lowPosition = isNum(lf) && lf >= rule.low60Min && lf <= rule.low60Max;
  const highPosition = isNum(hf) && hf >= rule.high60Min && hf <= rule.high60Max;
  return { valueRatio, lowPosition, highPosition, matches: valueRatio && lowPosition && highPosition };
}

function getFailedReasons(rule, vRatio, lf, hf) {
  const reasons = [];
  if (!isNum(vRatio)) reasons.push('데이터 부족 (들어온 돈)');
  else if (vRatio < rule.valueRatioMin) reasons.push(`들어온 돈 부족 (${vRatio}% < ${rule.valueRatioMin}%)`);
  else if (vRatio > rule.valueRatioMax) reasons.push(`들어온 돈 과다 (${vRatio}% > ${rule.valueRatioMax}%)`);

  if (!isNum(lf)) reasons.push('데이터 부족 (저점 대비)');
  else if (lf < rule.low60Min) reasons.push(`저점 대비 너무 낮음 (+${lf}% < +${rule.low60Min}%)`);
  else if (lf > rule.low60Max) reasons.push(`저점 대비 너무 높음 (+${lf}% > +${rule.low60Max}%)`);

  if (!isNum(hf)) reasons.push('데이터 부족 (고점 대비)');
  else if (hf < rule.high60Min) reasons.push(`고점과 너무 멂 (${hf}% < ${rule.high60Min}%)`);
  else if (hf > rule.high60Max) reasons.push(`고점 근처 (${hf}% > ${rule.high60Max}%)`);
  return reasons;
}

// 라벨/역할 (단일 분류)
function buildConditionLabel(matchesClassic, matchesStrong, classicPass, vRatio, lf, hf) {
  if (matchesStrong) return { label: '강한 BMS 조건 만족', role: '강한 핵심 조건', explanation: '시총 대비 들어온 돈과 가격 위치가 모두 강한 BMS 조건에 들어온 사례입니다.' };
  if (matchesClassic) return { label: '정석 BMS 조건 만족', role: '핵심 조건', explanation: '상승 전 거래대금과 가격 위치가 정석 BMS 조건에 들어온 사례입니다.' };

  const v = classicPass.valueRatio, l = classicPass.lowPosition, h = classicPass.highPosition;
  if (l && h && isNum(vRatio) && vRatio < CORE_CONDITION.CLASSIC.valueRatioMin) {
    return { label: '가격은 좋지만 들어온 돈 부족', role: '일부 조건만 만족', explanation: '저점 회복과 고점까지의 공간은 좋지만, 상승 전 시총 대비 거래대금이 부족했던 사례입니다.' };
  }
  if (v && (!l || !h)) {
    return { label: '들어온 돈은 좋지만 가격 위치 이탈', role: '일부 조건만 만족', explanation: '상승 전 거래대금은 적당히 지나갔지만, 가격 위치가 정석 BMS 조건에서 벗어난 사례입니다.' };
  }
  if (isNum(vRatio) && vRatio > CORE_CONDITION.CLASSIC.valueRatioMax) {
    return { label: '거래 과다 주의', role: '주의', explanation: '상승 전 거래대금이 너무 많이 지나간 구간입니다. 빠르게 움직일 수 있지만 오른 뒤 흔들림이 커질 수 있습니다.' };
  }
  if (isNum(lf) && lf < CORE_CONDITION.CLASSIC.low60Min) {
    return { label: '저점 근처 힘 확인 부족', role: '주의', explanation: '시작점이 아직 저점 근처라 힘이 충분히 확인되지 않은 사례입니다.' };
  }
  if (isNum(hf) && hf > CORE_CONDITION.CLASSIC.high60Max) {
    return { label: '고점 근처 주의', role: '주의', explanation: '시작점이 최근 고점에 가까워 추격 위험이나 흔들림이 커질 수 있는 사례입니다.' };
  }
  return { label: '조건 미충족', role: '조건 외', explanation: '정석 BMS 조건에는 들어오지 않는 사례입니다.' };
}

// ─────────────────────── 단순 점수 (0~85) ───────────────────────

function scoreValueRatio(v) {
  if (!isNum(v))            return { score: 0,  reason: '데이터 없음 (0)' };
  if (v >= 10 && v <= 40)   return { score: 35, reason: '핵심 10~40% (35)' };
  if (v >= 5 && v < 10)     return { score: 25, reason: '초기 유입 5~10% (25)' };
  if (v >= 0 && v < 5)      return { score: 10, reason: '유입 부족 0~5% (10)' };
  if (v > 40 && v <= 80)    return { score: 15, reason: '거래 과다 40~80% (15)' };
  if (v > 80)               return { score: 5,  reason: '과열 가능 80%+ (5)' };
  return { score: 0, reason: '범위 외 (0)' };
}

function scoreLowPosition(lf) {
  if (!isNum(lf))             return { score: 0,  reason: '데이터 없음 (0)' };
  if (lf >= 10 && lf <= 45)   return { score: 25, reason: '핵심 회복 +10~45% (25)' };
  if (lf > 45 && lf <= 70)    return { score: 12, reason: '많이 회복 +45~70% (12)' };
  if (lf >= 0 && lf < 10)     return { score: 10, reason: '저점 근처 0~10% (10)' };
  if (lf > 70)                return { score: 5,  reason: '과열 의심 +70%↑ (5)' };
  if (lf < 0)                 return { score: 0,  reason: '저점 이탈 <0% (0)' };
  return { score: 0, reason: '범위 외 (0)' };
}

function scoreHighPosition(hf) {
  if (!isNum(hf))                 return { score: 0,  reason: '데이터 없음 (0)' };
  if (hf >= -40 && hf <= -10)     return { score: 25, reason: '핵심 -40~-10% (25)' };
  if (hf > -10 && hf <= -3)       return { score: 12, reason: '고점 근처 -10~-3% (12)' };
  if (hf > -3)                    return { score: 5,  reason: '신고가 근처 -3%↑ (5)' };
  if (hf < -40)                   return { score: 10, reason: '고점 너무 멈 ≤-40% (10)' };
  return { score: 0, reason: '범위 외 (0)' };
}

function computeRiskPenalty(v, lf, hf) {
  let penalty = 0;
  const reasons = [];
  if (isNum(v)) {
    if (v > 40) { penalty += 5; reasons.push('들어온 돈 40% 초과 (-5)'); }
    if (v > 80) { penalty += 5; reasons.push('들어온 돈 80% 초과 (추가 -5)'); }
  }
  if (isNum(lf) && lf > 70) { penalty += 5; reasons.push('저점 대비 +70% 초과 (-5)'); }
  if (isNum(hf) && hf > -3) { penalty += 5; reasons.push('고점 대비 -3% 초과 (-5)'); }
  let dataMissing = 0;
  if (!isNum(v)) dataMissing++;
  if (!isNum(lf)) dataMissing++;
  if (!isNum(hf)) dataMissing++;
  if (dataMissing >= 2) { penalty += 10; reasons.push('핵심값 데이터 2개 이상 부족 (-10)'); }
  return { penalty: Math.min(15, penalty), reasons };
}

function classifyScoreGrade(score) {
  if (score >= SCORE_GRADES.strong.min)  return { key: 'strong',  ...SCORE_GRADES.strong };
  if (score >= SCORE_GRADES.classic.min) return { key: 'classic', ...SCORE_GRADES.classic };
  if (score >= SCORE_GRADES.partial.min) return { key: 'partial', ...SCORE_GRADES.partial };
  return { key: 'weak', ...SCORE_GRADES.weak };
}

function computeSimpleScore(vRatio, lf, hf) {
  const valueScore = scoreValueRatio(vRatio);
  const lowScore = scoreLowPosition(lf);
  const highScore = scoreHighPosition(hf);
  const risk = computeRiskPenalty(vRatio, lf, hf);
  const total = Math.max(0, valueScore.score + lowScore.score + highScore.score - risk.penalty);
  const grade = classifyScoreGrade(total);
  return {
    totalScore: total,
    scoreGrade: grade.key,
    scoreLabel: grade.label,
    explanation: grade.explanation,
    valueScore: valueScore.score,
    lowPositionScore: lowScore.score,
    highPositionScore: highScore.score,
    riskPenalty: risk.penalty,
    breakdown: {
      valueScoreReason: valueScore.reason,
      lowPositionReason: lowScore.reason,
      highPositionReason: highScore.reason,
      riskPenaltyReasons: risk.reasons,
    },
  };
}

// ─────────────────────── 한 줄 해석 ───────────────────────

function buildOneLine(candidate) {
  const c = candidate;
  if (c.matchesStrongBms) return `BMS 점수 ${c.simpleBmsScore.totalScore}점, 강한 BMS 조건 모두 만족. 정석 후보로 검토 가능.`;
  if (c.matchesClassicBms) return `BMS 점수 ${c.simpleBmsScore.totalScore}점, 정석 BMS 조건 만족. 차트 확인 권장.`;
  if (c.simpleBmsScore.scoreGrade === 'partial' && c.simpleBmsScore.riskPenalty > 0) {
    return `점수 ${c.simpleBmsScore.totalScore}점 — 위험 감점 ${c.simpleBmsScore.riskPenalty}점 적용. 추격 위험 점검 필요.`;
  }
  if (c.simpleBmsScore.scoreGrade === 'weak') {
    return `점수 ${c.simpleBmsScore.totalScore}점 — BMS 핵심 조건과 거리 있음. 후보 우선순위 낮음.`;
  }
  return `점수 ${c.simpleBmsScore.totalScore}점 — 일부 조건만 만족. 추가 확인 필요.`;
}

// ─────────────────────── 핵심 진입점 ───────────────────────

/**
 * @param {Array} rows  차트 일봉 배열 (date, open, high, low, close, volume, valueApprox 포함, 날짜 오름차순)
 * @param {number} cutoffIdx  계산 기준일 인덱스 (이 인덱스 포함 이전 데이터만 사용)
 * @param {Object} meta  { code, name, market, marketCap, isSpecial, isEtf }
 * @returns {Object}  candidate 객체
 *
 * 누수 방지: rows.slice(0, cutoffIdx + 1) 만 사용. cutoffIdx 이후 데이터는 절대 참조하지 않음.
 */
function calculateBmsCandidateForDate(rows, cutoffIdx, meta) {
  meta = meta || {};
  const skeleton = {
    code: meta.code, name: meta.name, market: meta.market, marketCap: meta.marketCap,
    isSpecial: !!meta.isSpecial, isEtf: !!meta.isEtf,
    cutoffDate: null, cutoffIdx,
  };

  if (!Array.isArray(rows) || rows.length === 0 || cutoffIdx < 0 || cutoffIdx >= rows.length) {
    return { ...skeleton, dataLimit: 'cutoffIdx 범위 밖', valid: false };
  }
  if (cutoffIdx < CONFIG.MIN_HISTORY - 1) {
    return { ...skeleton, cutoffDate: rows[cutoffIdx]?.date || null, dataLimit: '차트 데이터 60일 미만', valid: false };
  }

  // 누수 방지 — cutoffIdx 까지의 슬라이스만 사용
  const slice = rows.slice(0, cutoffIdx + 1);
  const today = slice[cutoffIdx];
  const cutoffDate = today?.date || null;
  const close = today?.close;
  if (!isNum(close) || close <= 0) {
    return { ...skeleton, cutoffDate, dataLimit: '종가 없음', valid: false };
  }

  // 핵심 변수
  const valueRatio = computeValueRatio(slice, cutoffIdx, meta.marketCap);
  const startDayValueRatio = computeStartDayValueRatio(slice, cutoffIdx, meta.marketCap);
  const position = computePricePosition(slice, cutoffIdx);
  const closeFromLow60 = position.closeFromLow60 ?? null;
  const closeFromHigh60 = position.closeFromHigh60 ?? null;

  // 구간 분류
  const valueRatioGroup = classifyValueRatioGroup(valueRatio);

  // 정석/강한 조건
  const classicPass = checkRule(CORE_CONDITION.CLASSIC, valueRatio, closeFromLow60, closeFromHigh60);
  const strongPass = checkRule(CORE_CONDITION.STRONG, valueRatio, closeFromLow60, closeFromHigh60);
  const failedClassicReasons = classicPass.matches ? [] : getFailedReasons(CORE_CONDITION.CLASSIC, valueRatio, closeFromLow60, closeFromHigh60);
  const failedStrongReasons = strongPass.matches ? [] : getFailedReasons(CORE_CONDITION.STRONG, valueRatio, closeFromLow60, closeFromHigh60);

  // 점수
  const simpleBmsScore = computeSimpleScore(valueRatio, closeFromLow60, closeFromHigh60);

  // 라벨
  const lbl = buildConditionLabel(classicPass.matches, strongPass.matches, classicPass, valueRatio, closeFromLow60, closeFromHigh60);

  const candidate = {
    ...skeleton,
    cutoffDate, valid: true,
    close,
    valueRatio: {
      preAccumulationRatio: valueRatio,
      startDayValueRatio,
      group: valueRatioGroup,
    },
    pricePosition: {
      close: position.close ?? null,
      low60: position.low60 ?? null,
      high60: position.high60 ?? null,
      closeFromLow60, closeFromHigh60,
      positionInRange: position.positionInRange ?? null,
      dataLimit: position.dataLimit || null,
    },
    coreCondition: {
      matchesClassicBms: classicPass.matches,
      matchesStrongBms: strongPass.matches,
      classicPass: { valueRatio: classicPass.valueRatio, lowPosition: classicPass.lowPosition, highPosition: classicPass.highPosition },
      strongPass: { valueRatio: strongPass.valueRatio, lowPosition: strongPass.lowPosition, highPosition: strongPass.highPosition },
      failedClassicReasons,
      failedStrongReasons,
      conditionLabel: lbl.label,
      conditionRole: lbl.role,
      explanation: lbl.explanation,
    },
    matchesClassicBms: classicPass.matches,
    matchesStrongBms: strongPass.matches,
    simpleBmsScore,
  };
  candidate.oneLineSummary = buildOneLine(candidate);
  return candidate;
}

// ─────────────────────── exports ───────────────────────

module.exports = {
  // 핵심 진입점
  calculateBmsCandidateForDate,
  // 헬퍼 (백테스트 또는 다른 모듈에서 직접 호출 가능)
  findIdxByDate,
  findLatestIdx,
  computeValueRatio,
  computeStartDayValueRatio,
  computePricePosition,
  classifyValueRatioGroup,
  checkRule,
  getFailedReasons,
  buildConditionLabel,
  computeSimpleScore,
  classifyScoreGrade,
  buildOneLine,
  // 정의 (UI/리포트에서 표시할 때 재사용)
  CONFIG,
  CORE_CONDITION,
  SCORE_GRADES,
  VALUE_RATIO_GROUPS,
};
