#!/usr/bin/env node
/**
 * BMS Current Similarity Scan
 *
 * 목적:
 *   현재 시장 종목 중에서 과거 A+B 등급 정상 상승 사례와 비슷한 "준비 구간"에
 *   있는 종목을 찾는다. 매수 신호가 아니라 관심종목을 좁히기 위한 참고용.
 *
 * 핵심 정의:
 *   BMS는 "오늘 거래대금이 폭발한 종목"을 찾는 모델이 아니다.
 *   "오르기 전 20거래일 동안 조용히 돈이 지나갔고, 아직 고점까지 공간이 남아 있는
 *    준비 구간 종목"을 찾는 모델이다. 거래대금 spike는 핵심이 아닌 참고값.
 *
 * 입력:
 *   - reports/bms-pattern-summary-result.json (suggestedRules)
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json
 *
 * 출력:
 *   - reports/bms-current-similarity-result.json
 *   - reports/bms-current-similarity-result.html
 *
 * 점수 (총 100점):
 *   30점 상승 전 들어온 돈 (시총 대비 누적)
 *   25점 가격 위치 (저점/고점 대비)
 *   20점 박스권
 *   10점 위쪽 매물 부담
 *   10점 거래대금 유지 (꾸준한 흐름)
 *    5점 이평선 위치 (참고)
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');
const RULES_INPUT = path.join(REPORTS_DIR, 'bms-pattern-summary-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-current-similarity-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-current-similarity-result.html');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  });
  return out;
})();

const CONFIG = {
  MIN_MARKET_CAP: parseInt(args['min-mc'] || '100') * 100_000_000,
  MIN_HISTORY: 60,
  PRE_ACCUM_DAYS: 20,
  BOX_MIN_DAYS: 10,
  BOX_MAX_DAYS: 30,
  SUPPLY_LOOKBACK: 120,
  SUPPLY_BINS: 24,
  // 최소 통과 조건
  MIN_PRE_ACCUM_PCT: 7,
  MAX_PRE_ACCUM_PCT: 80,
  MAX_BOX_RANGE_PCT: 35,
  MIN_LOW60_PCT: 5,
  MAX_LOW60_PCT: 80,
  MIN_HIGH60_PCT: -40,
  MAX_HIGH60_PCT: 5,
  // 운영 단계 한도 (오늘 차트로 우선 볼 후보 좁히기)
  TOP_CANDIDATE_LIMIT: parseInt(args['top'] || '15'),         // 오늘 볼 후보 최대 개수
  PRIMARY_SCORE_MIN: parseFloat(args['primary-min'] || '95'), // 오늘 볼 후보 최소 점수
  WATCH_SCORE_MIN: parseFloat(args['watch-min'] || '75'),     // 관찰 후보 최소 점수
};

// 기본값 (suggestedRules 못 읽을 때 fallback)
const DEFAULT_RULES = {
  preAccumulationRatio: { label: '시총 대비 상승 전 들어온 돈', unit: '%', min: 7.27, idealMin: 10.78, idealMax: 31.4, median: 17.55 },
  startDayValueRatio:   { label: '시총 대비 상승 시작일 거래대금', unit: '%', min: 0.36, idealMin: 0.46, median: 0.7 },
  valueSpikeRatio:      { label: '평소보다 거래가 늘어난 정도', unit: '배', min: 0.39, idealMin: 0.54, idealMax: 1.21, median: 0.76 },
  boxRangePct:          { label: '박스권 폭', unit: '%', min: 11.68, idealMin: 14.81, idealMax: 24.97, max: 35, median: 18.86 },
  boxDays:              { label: '박스권 기간', unit: '일', min: 10, idealMin: 10, idealMax: 10, median: 10 },
  breakoutValueRatio:   { label: '돌파일 거래대금 (박스 평균 대비)', unit: '배', idealMin: 0.62, idealMax: 1.24, median: 0.9 },
  closeFromLow60:       { label: '60일 저점 대비 위치', unit: '%', min: 5, idealMin: 13.2, idealMax: 32.76, max: 80, median: 21.52 },
  closeFromHigh60:      { label: '60일 고점 대비 위치', unit: '%', idealMin: -28.57, idealMax: -13.83, median: -22.23 },
  supplyAboveRatio:     { label: '위쪽 매물 부담', unit: '%', idealMax: 36.98, tolerantMax: 59.85, max: 85, median: 59.85 },
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcluded(name) { return name && EXCLUDE_KEYWORDS.some(k => name.includes(k)); }

// ─────────────────────── 헬퍼 ───────────────────────

function round(v, d) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function pct(num, den) { if (!den || den === 0) return null; return round(num / den * 100, 2); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sma(arr, period, key) {
  if (!arr || arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += (key ? arr[i][key] : arr[i]) || 0;
  return sum / period;
}

// ─────────────────────── 박스권 / 매물대 ───────────────────────

function computeBoxRange(rows, currentIdx) {
  let best = null;
  for (let n = CONFIG.BOX_MIN_DAYS; n <= CONFIG.BOX_MAX_DAYS; n++) {
    const s = currentIdx - n;
    if (s < 0) break;
    const slice = rows.slice(s, currentIdx);
    const lows = slice.map(r => r.low).filter(v => v > 0);
    const highs = slice.map(r => r.high).filter(v => v > 0);
    if (lows.length === 0) continue;
    const lo = Math.min(...lows), hi = Math.max(...highs);
    if (lo <= 0) continue;
    const range = (hi - lo) / lo * 100;
    const score = -range;        // 좁을수록 좋음
    if (!best || score > best.score) {
      best = { days: n, boxLow: lo, boxHigh: hi, rangePct: round(range, 2), score };
    }
  }
  if (!best) return { dataLimit: '데이터 없음' };

  const boxRows = rows.slice(currentIdx - best.days, currentIdx);
  const half = Math.floor(boxRows.length / 2);
  const firstHalf = boxRows.slice(0, half);
  const secondHalf = boxRows.slice(half);
  const firstAvgValue = firstHalf.length > 0 ? firstHalf.reduce((s, r) => s + (r.valueApprox || 0), 0) / firstHalf.length : 0;
  const secondAvgValue = secondHalf.length > 0 ? secondHalf.reduce((s, r) => s + (r.valueApprox || 0), 0) / secondHalf.length : 0;
  const touchedHigh = boxRows.filter(r => r.high >= best.boxHigh * 0.97).length;
  const firstMinLow = firstHalf.length > 0 ? Math.min(...firstHalf.map(r => r.low)) : null;
  const secondMinLow = secondHalf.length > 0 ? Math.min(...secondHalf.map(r => r.low)) : null;
  const lowRising = firstMinLow != null && secondMinLow != null && secondMinLow > firstMinLow;

  return {
    boxRangeDays: best.days,
    boxLow: round(best.boxLow, 0),
    boxHigh: round(best.boxHigh, 0),
    boxRangePct: best.rangePct,
    touchedHighTimes: touchedHigh,
    lowRising,
    valueTrendInBox: secondAvgValue > firstAvgValue * 1.2 ? 'INCREASING'
                  : secondAvgValue < firstAvgValue * 0.8 ? 'DECREASING'
                  : 'FLAT',
  };
}

function computeSupplyZone(supplyRows, currentClose) {
  if (!supplyRows || supplyRows.length === 0) return { dataLimit: '데이터 없음' };
  const lows = supplyRows.map(r => r.low).filter(v => v > 0);
  const highs = supplyRows.map(r => r.high).filter(v => v > 0);
  if (lows.length === 0) return { dataLimit: '가격 데이터 없음' };
  const minPrice = Math.min(...lows);
  const maxPrice = Math.max(...highs);
  if (maxPrice <= minPrice) return { dataLimit: '가격 범위 없음' };

  const binCount = CONFIG.SUPPLY_BINS;
  const binSize = (maxPrice - minPrice) / binCount;
  const bins = new Array(binCount).fill(0);
  supplyRows.forEach(r => {
    const mid = (r.high + r.low) / 2;
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((mid - minPrice) / binSize)));
    bins[idx] += r.volume || 0;
  });
  const totalVol = bins.reduce((s, v) => s + v, 0);
  if (totalVol === 0) return { dataLimit: '거래량 없음' };

  let aboveVol = 0;
  bins.forEach((v, i) => {
    const binMid = minPrice + (i + 0.5) * binSize;
    if (binMid > currentClose) aboveVol += v;
  });
  return {
    aboveCloseRatio: pct(aboveVol, totalVol),
  };
}

// ─────────────────────── 측정 (현재 시점) ───────────────────────

function measureCurrent(rows, marketCap) {
  if (rows.length < CONFIG.MIN_HISTORY) return null;
  const idx = rows.length - 1;
  const today = rows[idx];
  if (!today || today.close <= 0) return null;
  const close = today.close;

  // 최근 20일 누적 거래대금
  const preStart = Math.max(0, idx - CONFIG.PRE_ACCUM_DAYS + 1);
  const last20 = rows.slice(preStart, idx + 1);
  if (last20.length === 0) return null;
  const sumValue = last20.reduce((s, r) => s + (r.valueApprox || 0), 0);
  const avgValue = sumValue / last20.length;
  const preAccumulationRatio = pct(sumValue, marketCap);

  // 시총 대비 오늘 거래대금
  const startDayValueRatio = pct(today.valueApprox || 0, marketCap);
  const valueSpikeRatio = avgValue > 0 ? round((today.valueApprox || 0) / avgValue, 2) : null;

  // 박스권
  const box = computeBoxRange(rows, idx);

  // 가격 위치
  const last60 = rows.slice(Math.max(0, idx - 59), idx + 1);
  const last120 = rows.slice(Math.max(0, idx - 119), idx + 1);
  const last250 = rows.slice(Math.max(0, idx - 249), idx + 1);
  const low60 = Math.min(...last60.map(r => r.low));
  const high60 = Math.max(...last60.map(r => r.high));
  const low120 = Math.min(...last120.map(r => r.low));
  const high120 = Math.max(...last120.map(r => r.high));
  const high52w = last250.length > 0 ? Math.max(...last250.map(r => r.high)) : null;
  const closeFromLow60 = pct(close - low60, low60);
  const closeFromHigh60 = pct(close - high60, high60);
  const closeFromLow120 = pct(close - low120, low120);
  const closeFromHigh120 = pct(close - high120, high120);
  const closeFrom52WeekHigh = high52w ? pct(close - high52w, high52w) : null;

  // 매물대
  const supplyRows = rows.slice(Math.max(0, idx - CONFIG.SUPPLY_LOOKBACK + 1), idx + 1);
  const supply = computeSupplyZone(supplyRows, close);

  // 이평선
  const ma5 = sma(rows.slice(Math.max(0, idx - 4), idx + 1), 5, 'close');
  const ma20 = sma(rows.slice(Math.max(0, idx - 19), idx + 1), 20, 'close');
  const ma60 = sma(rows.slice(Math.max(0, idx - 59), idx + 1), 60, 'close');
  const ma120 = sma(rows.slice(Math.max(0, idx - 119), idx + 1), 120, 'close');

  // 거래대금 유지 (avgValue 대비 0.5배 이상인 날 수)
  const persistDays = last20.filter(r => avgValue > 0 && (r.valueApprox || 0) >= avgValue * 0.5).length;
  const persistRatio = pct(persistDays, last20.length);

  return {
    date: today.date, close,
    preAccumulationRatio, startDayValueRatio, valueSpikeRatio,
    avgValue20: round(avgValue, 0), sumValue20: round(sumValue, 0),
    persistDays, persistRatio,
    box,
    closeFromLow60, closeFromHigh60, closeFromLow120, closeFromHigh120, closeFrom52WeekHigh,
    supply,
    ma5: round(ma5, 0), ma20: round(ma20, 0), ma60: round(ma60, 0), ma120: round(ma120, 0),
    aboveMa20: ma20 ? close > ma20 : null,
    aboveMa60: ma60 ? close > ma60 : null,
    aboveMa120: ma120 ? close > ma120 : null,
  };
}

// ─────────────────────── 최소 통과 조건 ───────────────────────

function passMinimumFilter(m) {
  const reasons = [];
  if (m.preAccumulationRatio == null) { reasons.push('데이터 부족 (거래대금)'); return reasons; }
  if (m.preAccumulationRatio < CONFIG.MIN_PRE_ACCUM_PCT) reasons.push('시총 대비 들어온 돈 부족 (' + m.preAccumulationRatio + '% < ' + CONFIG.MIN_PRE_ACCUM_PCT + '%)');
  if (m.preAccumulationRatio > CONFIG.MAX_PRE_ACCUM_PCT) reasons.push('시총 대비 들어온 돈 과다 (' + m.preAccumulationRatio + '% > ' + CONFIG.MAX_PRE_ACCUM_PCT + '%)');
  if (m.box && m.box.boxRangePct != null && m.box.boxRangePct > CONFIG.MAX_BOX_RANGE_PCT) reasons.push('박스권 폭이 너무 넓음 (' + m.box.boxRangePct + '%)');
  if (m.closeFromLow60 == null || m.closeFromLow60 < CONFIG.MIN_LOW60_PCT) reasons.push('저점에서 너무 가까움 또는 데이터 부족');
  if (m.closeFromLow60 > CONFIG.MAX_LOW60_PCT) reasons.push('이미 저점 대비 많이 오름 (' + m.closeFromLow60 + '%)');
  if (m.closeFromHigh60 == null || m.closeFromHigh60 < CONFIG.MIN_HIGH60_PCT) reasons.push('고점에서 너무 멀어 박스 밖으로 벗어남');
  if (m.closeFromHigh60 > CONFIG.MAX_HIGH60_PCT) reasons.push('이미 고점 근처 (' + m.closeFromHigh60 + '%)');
  if ((m.avgValue20 || 0) === 0) reasons.push('거래대금 0 (거래정지/거래 없음)');
  return reasons;
}

// ─────────────────────── 점수 계산 ───────────────────────

// 헬퍼: ideal 구간이면 만점, min 미달이면 0, 그 사이 선형 보간. 과도하면 감점.
function scoreInRange(v, rule, maxScore) {
  if (v == null || !isFinite(v)) return 0;
  const { min, idealMin, idealMax, max } = rule;
  // 이상 구간 (만점)
  if (idealMin != null && idealMax != null && v >= idealMin && v <= idealMax) return maxScore;
  if (idealMin != null && idealMax == null && v >= idealMin) return maxScore;
  if (idealMin == null && idealMax != null && v <= idealMax) return maxScore;
  // 최소 미달 → 0
  if (min != null && v < min) return 0;
  // 최대 초과 → 0
  if (max != null && v > max) return 0;
  // 선형 보간
  if (idealMin != null && v < idealMin) {
    // min ~ idealMin 구간: 0 → maxScore
    const lo = min != null ? min : idealMin * 0.5;
    return clamp((v - lo) / Math.max(0.0001, idealMin - lo), 0, 1) * maxScore;
  }
  if (idealMax != null && v > idealMax) {
    const hi = max != null ? max : idealMax * 1.5;
    return clamp((hi - v) / Math.max(0.0001, hi - idealMax), 0, 1) * maxScore;
  }
  return maxScore * 0.5;
}

function computeBmsScores(m, rules) {
  // 1. 상승 전 들어온 돈 (30점)
  const accumulationScore = round(scoreInRange(m.preAccumulationRatio, rules.preAccumulationRatio, 30), 1);

  // 2. 가격 위치 (25점) — 저점 대비 + 고점 대비 합산
  const lowScore = scoreInRange(m.closeFromLow60, rules.closeFromLow60, 12.5);
  const highScore = scoreInRange(m.closeFromHigh60, rules.closeFromHigh60, 12.5);
  const pricePositionScore = round(lowScore + highScore, 1);

  // 3. 박스권 (20점)
  let boxScore = 0;
  if (m.box && m.box.boxRangePct != null) {
    boxScore = scoreInRange(m.box.boxRangePct, rules.boxRangePct, 16);
    if (m.box.lowRising) boxScore += 2;                                        // 저점 상승 가산
    if (m.box.valueTrendInBox === 'INCREASING') boxScore += 2;                  // 거래대금 증가 가산
    boxScore = Math.min(20, boxScore);
  }
  boxScore = round(boxScore, 1);

  // 4. 위쪽 매물 부담 (10점) — 낮을수록 좋음
  let supplyScore = 0;
  const sa = m.supply?.aboveCloseRatio;
  if (sa != null) {
    const r = rules.supplyAboveRatio;
    if (sa <= (r.idealMax || 36.98)) supplyScore = 10;
    else if (sa <= (r.tolerantMax || 59.85)) supplyScore = 7;
    else if (sa <= (r.max || 85)) supplyScore = 3;
    else supplyScore = 0;
  }
  supplyScore = round(supplyScore, 1);

  // 5. 거래대금 유지 (10점) — persistRatio 기준
  let valuePersistenceScore = 0;
  const pr = m.persistRatio;
  if (pr != null) {
    if (pr >= 80) valuePersistenceScore = 10;
    else if (pr >= 60) valuePersistenceScore = 7;
    else if (pr >= 40) valuePersistenceScore = 4;
    else valuePersistenceScore = 1;
  }

  // 6. 이평선 위치 (5점) — 보조
  let movingAverageScore = 0;
  if (m.aboveMa20) movingAverageScore += 2;
  if (m.aboveMa60) movingAverageScore += 2;
  if (m.aboveMa120) movingAverageScore += 1;
  movingAverageScore = Math.min(5, movingAverageScore);

  const total = round(accumulationScore + pricePositionScore + boxScore + supplyScore + valuePersistenceScore + movingAverageScore, 1);

  return {
    accumulationScore, pricePositionScore, boxScore, supplyScore, valuePersistenceScore, movingAverageScore,
    total,
  };
}

// ─────────────────────── 후보 유형 분류 ───────────────────────

function classifyTypes(m, scores, rules) {
  const types = [];
  const ar = m.preAccumulationRatio;
  const ra = rules.preAccumulationRatio;
  const lf = m.closeFromLow60;
  const rl = rules.closeFromLow60;
  const hf = m.closeFromHigh60;
  const rh = rules.closeFromHigh60;
  const bx = m.box?.boxRangePct;
  const rbx = rules.boxRangePct;
  const sa = m.supply?.aboveCloseRatio;
  const rs = rules.supplyAboveRatio;

  // 1. 정석 상승 준비형 (모든 핵심 조건이 ideal 구간)
  const isClassic = ar != null && ar >= ra.idealMin && ar <= ra.idealMax
    && lf != null && lf >= rl.idealMin && lf <= rl.idealMax
    && hf != null && hf >= rh.idealMin && hf <= rh.idealMax
    && bx != null && bx >= rbx.idealMin && bx <= rbx.idealMax
    && sa != null && sa <= (rs.idealMax || 40);
  if (isClassic) types.push('정석 상승 준비형');

  // 2. 현실 상승 준비형 (점수 60점 이상이면서 위 정석 X)
  if (!isClassic && scores.total >= 60) types.push('현실 상승 준비형');

  // 3. 거래대금 누적형 (스파이크는 약하지만 누적 좋음)
  if (ar != null && ar >= ra.idealMin && (m.valueSpikeRatio == null || m.valueSpikeRatio < 1.0)) {
    types.push('거래대금 누적형');
  }

  // 4. 박스권 응축형
  if (bx != null && bx >= 12 && bx <= 25 && (m.box?.lowRising || (m.box?.touchedHighTimes || 0) >= 3)) {
    types.push('박스권 응축형');
  }

  // 5. 위쪽 매물 부담형
  if (sa != null && sa > (rs.tolerantMax || 60) && scores.total >= 50) {
    types.push('위쪽 매물 부담형');
  }

  // 6. 이미 많이 오른 위험형
  if ((lf != null && lf > (rl.idealMax + 10)) || (hf != null && hf > -5)) {
    types.push('이미 많이 오른 위험형');
  }

  if (types.length === 0) types.push('기타');
  return types;
}

// ─────────────────────── 운영 단계 분류 ───────────────────────

// 운영 우선순위 (BMS 화면 라벨):
//   1. 주의 후보       (점수 높아도 이미 많이 오른 위험)
//   2. 오늘 볼 후보(예비) (모든 조건 좋은 구간) — 정렬 후 상위 N만 진짜 "오늘 볼 후보"로,
//                       나머지는 "관찰 후보"로 강등
//   3. 위쪽 가격 확인  (현재가 위 매물·박스 상단 근처. VVI의 거래대금 돌파와는 다름)
//   4. 관찰 후보       (점수 75+ 또는 핵심 일부 약함)
//   5. 거래대금 누적 후보 (spike 약하지만 누적 충분 — BMS 핵심 유형)
//   6. 하단 후보       (그 외)
function classifyOperationStage(m, scores, rules) {
  const ar = m.preAccumulationRatio;
  const ra = rules.preAccumulationRatio || {};
  const lf = m.closeFromLow60;
  const hf = m.closeFromHigh60;
  const bx = m.box?.boxRangePct;
  const sa = m.supply?.aboveCloseRatio;

  // 1) 과열 주의 — 저점 대비 +45% 이상 또는 60일 고점 -10% 이내
  const overheated =
    (lf != null && lf >= 45)
    || (hf != null && hf >= -10);
  if (overheated) {
    return {
      stage: '주의 후보',
      reason: 'BMS 점수는 높지만 저점 대비 이미 많이 오른 상태이거나 60일 고점 근처',
      next: '추격보다는 눌림 또는 재정비 여부 확인 후 재평가',
    };
  }

  // 2) 1차 핵심 후보
  const idealAccum = ar != null && ar >= (ra.idealMin || 10) && ar <= (ra.idealMax || 32);
  const acceptableAccum = ar != null && ar >= (ra.min || 7) && ar <= (ra.max || 80);
  const goodBoxNarrow = bx != null && bx >= 14 && bx <= 25;
  const okBoxRange = bx != null && bx <= 30;
  const goodLow = lf != null && lf >= 13 && lf <= 35;
  const goodHigh = hf != null && hf >= -30 && hf <= -10;
  const okSupply = sa != null && sa <= 60;

  if (
    scores.total >= 90
    && (idealAccum || acceptableAccum)
    && (goodBoxNarrow || okBoxRange)
    && goodLow
    && goodHigh
    && okSupply
  ) {
    return {
      stage: '오늘 볼 후보',
      reason: '시총 대비 들어온 돈·박스권 폭·가격 위치·매물 부담이 모두 BMS 좋은 구간',
      next: '박스권 상단·위쪽 가격대를 거래대금과 함께 넘는지 확인 — 가장 먼저 차트로 검토할 후보',
    };
  }

  // 3) 위쪽 가격 확인 — 현재가 위쪽에 매물 무겁거나 박스 상단 근처
  //    (VVI의 "거래대금 돌파"와 다름. 여기서는 위에 막힌 가격대를 확인하는 의미)
  const heavySupply = sa != null && sa > 60;
  const nearBoxTop = m.box?.boxHigh != null && m.close > 0
    && m.close >= m.box.boxHigh * 0.95
    && m.close <= m.box.boxHigh * 1.02;
  if (scores.total >= 60 && (heavySupply || nearBoxTop)) {
    let reason, next;
    if (heavySupply && nearBoxTop) {
      reason = '현재가 위에 막힌 가격대(매물·박스 상단)가 있음';
      next = '위쪽 가격대를 거래대금 유지와 함께 넘는지 다음 거래일 확인';
    } else if (heavySupply) {
      reason = '조건은 괜찮지만 현재가 위에 예전에 거래가 많이 된 가격대가 있음';
      next = '위쪽 가격대를 넘을 때 거래대금이 유지되는지 확인';
    } else {
      reason = '박스권 상단 바로 아래 — 위쪽 가격대를 넘을 시점 근처';
      next = '박스 상단을 종가로 넘으면서 거래대금이 유지되는지 확인';
    }
    return { stage: '위쪽 가격 확인', reason, next };
  }

  // 4) 관찰 후보
  if (scores.total >= CONFIG.WATCH_SCORE_MIN) {
    return {
      stage: '관찰 후보',
      reason: '핵심 조건 중 1~2개가 약하지만 전체 구조는 BMS 정상 사례와 유사',
      next: '약한 조건이 개선되면 오늘 볼 후보로 승격 가능 — 관심종목 수준 관찰',
    };
  }

  // 5) 거래대금 누적 후보 — BMS의 핵심 유형
  const lowSpike = (m.valueSpikeRatio == null || m.valueSpikeRatio < 0.8);
  const decentAccum = ar != null && ar >= 10;
  const notBadPosition = (lf == null || (lf >= 5 && lf <= 60)) && (hf == null || (hf >= -50 && hf <= 5));
  if (lowSpike && decentAccum && notBadPosition) {
    return {
      stage: '거래대금 누적 후보',
      reason: '오늘 거래대금 폭증은 없지만 최근 20일 시총 대비 누적 거래대금이 충분 — BMS 핵심 유형',
      next: '추가 거래대금 유입·박스 응축·위쪽 가격대 진입 시점 관찰',
    };
  }

  return {
    stage: '하단 후보',
    reason: 'BMS 핵심 조건 일부만 충족 — 우선순위 낮음',
    next: '조건이 개선되면 재평가',
  };
}

// ─────────────────────── 한 줄 해석 ───────────────────────

function buildOneLineSummary(m, scores, types, rules) {
  const ar = m.preAccumulationRatio;
  const lf = m.closeFromLow60;
  const hf = m.closeFromHigh60;
  const bx = m.box?.boxRangePct;
  const sa = m.supply?.aboveCloseRatio;

  if (types.includes('이미 많이 오른 위험형')) {
    return '이미 저점 대비 많이 오른 상태라 추격 위험이 있습니다.';
  }
  if (types.includes('정석 상승 준비형')) {
    return '시총 대비 거래대금 누적·박스권 폭·가격 위치가 모두 좋은 구간에 있는 정석 준비 구간입니다.';
  }
  if (types.includes('위쪽 매물 부담형')) {
    return '박스권·거래대금은 좋지만 현재가 위에 막힌 가격대(매물)가 있어 위쪽 가격 확인이 필요합니다.';
  }
  if (types.includes('거래대금 누적형')) {
    return '거래대금 폭증은 없지만 누적 거래대금이 좋아 BMS 기준에 가깝습니다.';
  }
  if (types.includes('박스권 응축형')) {
    return '박스권이 좁고 저점이 올라가는 응축 모양으로 위쪽 가격대 진입 시점을 관찰할 후보입니다.';
  }
  if (types.includes('현실 상승 준비형')) {
    return '일부 조건은 약하지만 전체적으로 과거 정상 상승 사례와 유사한 준비 구간입니다.';
  }
  return '조건 일부 충족. 참고만 하세요.';
}

// ─────────────────────── 메인 ───────────────────────

function loadRules() {
  if (fs.existsSync(RULES_INPUT)) {
    try {
      const j = JSON.parse(fs.readFileSync(RULES_INPUT, 'utf-8'));
      if (j.suggestedRules) return { rules: j.suggestedRules, source: 'pattern-summary' };
    } catch (_) {}
  }
  return { rules: DEFAULT_RULES, source: 'default-fallback' };
}

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Current Similarity Scan');
  console.log('═'.repeat(80));

  const { rules, source } = loadRules();
  console.log(`\n기준값 출처: ${source}`);

  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`차트 ${files.length}개 스캔 시작...`);

  const candidates = [];
  const excluded = [];
  const exclusionReasons = new Map();
  let processed = 0, skipMeta = 0, skipExcl = 0, skipMc = 0, skipShort = 0;
  const startTime = Date.now();

  files.forEach((file, idx) => {
    const code = file.replace('.json', '');
    const meta = stockMap[code];
    if (!meta) { skipMeta++; return; }
    if (isExcluded(meta.name) || meta.isSpecial || meta.isEtf) { skipExcl++; return; }
    const marketCap = meta.marketValue || 0;
    if (marketCap < CONFIG.MIN_MARKET_CAP) { skipMc++; return; }

    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8')); }
    catch (_) { return; }
    const rows = chart.rows || [];
    if (rows.length < CONFIG.MIN_HISTORY) { skipShort++; return; }
    processed++;

    const m = measureCurrent(rows, marketCap);
    if (!m) {
      excluded.push({ code, name: meta.name, reasons: ['측정 실패 (데이터 부족)'] });
      const k = '측정 실패 (데이터 부족)';
      exclusionReasons.set(k, (exclusionReasons.get(k) || 0) + 1);
      return;
    }

    const minReasons = passMinimumFilter(m);
    if (minReasons.length > 0) {
      excluded.push({ code, name: meta.name, market: meta.market, marketCap, currentClose: m.close, reasons: minReasons, metrics: simpleMetrics(m) });
      minReasons.forEach(r => exclusionReasons.set(r, (exclusionReasons.get(r) || 0) + 1));
      return;
    }

    const scores = computeBmsScores(m, rules);
    const types = classifyTypes(m, scores, rules);
    const oneLine = buildOneLineSummary(m, scores, types, rules);
    const op = classifyOperationStage(m, scores, rules);

    // strengths / warnings
    const strengths = [];
    const warnings = [];
    const ra = rules.preAccumulationRatio;
    if (m.preAccumulationRatio >= ra.idealMin && m.preAccumulationRatio <= ra.idealMax) strengths.push('시총 대비 들어온 돈이 좋은 구간');
    if (m.box?.boxRangePct != null && m.box.boxRangePct >= rules.boxRangePct.idealMin && m.box.boxRangePct <= rules.boxRangePct.idealMax) strengths.push('박스권 폭이 좋은 구간');
    if (m.closeFromLow60 != null && m.closeFromLow60 >= rules.closeFromLow60.idealMin && m.closeFromLow60 <= rules.closeFromLow60.idealMax) strengths.push('저점 대비 위치 양호');
    if (m.supply?.aboveCloseRatio != null && m.supply.aboveCloseRatio <= (rules.supplyAboveRatio.idealMax || 40)) strengths.push('위쪽 매물 부담 낮음');
    if (m.box?.lowRising) strengths.push('박스 하단 상승');

    if (m.supply?.aboveCloseRatio != null && m.supply.aboveCloseRatio > (rules.supplyAboveRatio.tolerantMax || 60)) warnings.push('위쪽 매물 부담 큼');
    if (m.closeFromLow60 != null && m.closeFromLow60 > (rules.closeFromLow60.idealMax + 10)) warnings.push('저점 대비 이미 많이 오름');
    if (m.closeFromHigh60 != null && m.closeFromHigh60 > -5) warnings.push('60일 고점 근처');

    candidates.push({
      code, name: meta.name, market: meta.market, currentDate: m.date, currentClose: m.close, marketCap,
      score: scores.total,
      typeLabels: types,
      operationStage: op.stage,
      operationReason: op.reason,
      nextCheckPoint: op.next,
      oneLineSummary: oneLine,
      metrics: {
        preAccumulationRatio: m.preAccumulationRatio,
        startDayValueRatio: m.startDayValueRatio,
        valueSpikeRatio: m.valueSpikeRatio,
        boxRangePct: m.box?.boxRangePct,
        boxRangeDays: m.box?.boxRangeDays,
        boxLow: m.box?.boxLow,
        boxHigh: m.box?.boxHigh,
        lowRising: m.box?.lowRising,
        valueTrendInBox: m.box?.valueTrendInBox,
        touchedHighTimes: m.box?.touchedHighTimes,
        closeFromLow60: m.closeFromLow60,
        closeFromHigh60: m.closeFromHigh60,
        closeFromLow120: m.closeFromLow120,
        closeFromHigh120: m.closeFromHigh120,
        closeFrom52WeekHigh: m.closeFrom52WeekHigh,
        supplyAboveRatio: m.supply?.aboveCloseRatio,
        persistDays: m.persistDays,
        persistRatio: m.persistRatio,
        avgValue20: m.avgValue20,
        sumValue20: m.sumValue20,
        ma5: m.ma5, ma20: m.ma20, ma60: m.ma60, ma120: m.ma120,
        aboveMa20: m.aboveMa20, aboveMa60: m.aboveMa60, aboveMa120: m.aboveMa120,
      },
      scores,
      warnings, strengths,
    });
  });

  // 정렬: score 내림차순 → 동점 시 시총 대비 들어온 돈이 좋은 구간 가까운 순 → 박스권 폭이 좋은 구간 → 저점대비 → 매물 부담 낮음
  function distFromIdeal(v, rule) {
    if (v == null || !isFinite(v)) return Infinity;
    if (rule.idealMin != null && v < rule.idealMin) return rule.idealMin - v;
    if (rule.idealMax != null && v > rule.idealMax) return v - rule.idealMax;
    return 0;
  }
  // 운영 단계 우선순위: 오늘 볼 → 관찰 → 누적 → 위쪽 가격 확인 → 주의 → 하단
  const STAGE_ORDER = {
    '오늘 볼 후보': 1,
    '관찰 후보': 2,
    '거래대금 누적 후보': 3,
    '위쪽 가격 확인': 4,
    '주의 후보': 5,
    '하단 후보': 6,
  };
  candidates.sort((a, b) => {
    const sa = STAGE_ORDER[a.operationStage] || 99;
    const sb = STAGE_ORDER[b.operationStage] || 99;
    if (sa !== sb) return sa - sb;
    if (b.score !== a.score) return b.score - a.score;
    const arA = distFromIdeal(a.metrics.preAccumulationRatio, rules.preAccumulationRatio);
    const arB = distFromIdeal(b.metrics.preAccumulationRatio, rules.preAccumulationRatio);
    if (arA !== arB) return arA - arB;
    const bxA = distFromIdeal(a.metrics.boxRangePct, rules.boxRangePct);
    const bxB = distFromIdeal(b.metrics.boxRangePct, rules.boxRangePct);
    if (bxA !== bxB) return bxA - bxB;
    const lfA = distFromIdeal(a.metrics.closeFromLow60, rules.closeFromLow60);
    const lfB = distFromIdeal(b.metrics.closeFromLow60, rules.closeFromLow60);
    if (lfA !== lfB) return lfA - lfB;
    return (a.metrics.supplyAboveRatio || 100) - (b.metrics.supplyAboveRatio || 100);
  });
  // 후처리: "오늘 볼 후보" 인원 제한
  // 점수 95+ AND 상위 TOP_CANDIDATE_LIMIT개만 진짜 "오늘 볼 후보"로 유지.
  // 나머지는 "관찰 후보"로 강등 (조건은 좋지만 화면에 너무 많아지지 않게).
  let topAssigned = 0;
  candidates.forEach(c => {
    if (c.operationStage !== '오늘 볼 후보') return;
    if (c.score >= CONFIG.PRIMARY_SCORE_MIN && topAssigned < CONFIG.TOP_CANDIDATE_LIMIT) {
      topAssigned++;            // 유지
    } else {
      c.operationStage = '관찰 후보';
      c.operationReason = '오늘 볼 후보 조건은 갖췄지만 점수 또는 우선순위가 상위 ' + CONFIG.TOP_CANDIDATE_LIMIT + '에 들지 않아 관찰 후보로 분류';
      c.nextCheckPoint = '점수가 ' + CONFIG.PRIMARY_SCORE_MIN + '+ 또는 상위로 올라오면 오늘 볼 후보로 승격';
    }
  });

  candidates.forEach((c, i) => { c.rank = i + 1; });

  // 운영 단계별 카운트
  const stageSummary = {
    '오늘 볼 후보': 0, '관찰 후보': 0, '거래대금 누적 후보': 0,
    '위쪽 가격 확인': 0, '주의 후보': 0, '하단 후보': 0,
  };
  candidates.forEach(c => { stageSummary[c.operationStage] = (stageSummary[c.operationStage] || 0) + 1; });

  // 통계
  const typeSummary = {
    '정석 상승 준비형': 0, '현실 상승 준비형': 0, '거래대금 누적형': 0,
    '박스권 응축형': 0, '위쪽 매물 부담형': 0, '이미 많이 오른 위험형': 0, '기타': 0,
  };
  candidates.forEach(c => { c.typeLabels.forEach(t => { typeSummary[t] = (typeSummary[t] || 0) + 1; }); });

  const scoreDistribution = [
    { label: '90점 이상', count: candidates.filter(c => c.score >= 90).length },
    { label: '80~89', count: candidates.filter(c => c.score >= 80 && c.score < 90).length },
    { label: '70~79', count: candidates.filter(c => c.score >= 70 && c.score < 80).length },
    { label: '60~69', count: candidates.filter(c => c.score >= 60 && c.score < 70).length },
    { label: '50~59', count: candidates.filter(c => c.score >= 50 && c.score < 60).length },
    { label: '50 미만', count: candidates.filter(c => c.score < 50).length },
  ];

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n분석 완료: 처리 ${processed}, 후보 ${candidates.length}, 제외 ${excluded.length}, ${elapsed.toFixed(0)}초`);
  console.log(`스킵: meta=${skipMeta} excl=${skipExcl} mc=${skipMc} short=${skipShort}`);

  console.log('\n📊 운영 단계별:');
  Object.entries(stageSummary).forEach(([k, v]) => { if (v > 0) console.log(`  ${k.padEnd(20)} ${v}건`); });
  console.log('\n📊 후보 유형별:');
  Object.entries(typeSummary).forEach(([k, v]) => { if (v > 0) console.log(`  ${k.padEnd(20)} ${v}건`); });

  console.log('\n🏆 BMS 유사도 상위 15:');
  candidates.slice(0, 15).forEach(c => {
    console.log(`  ${c.rank.toString().padStart(3)}. ${c.name.padEnd(14)} ${c.code} ${c.market.padEnd(6)} 점수 ${c.score} (들어온돈 ${c.metrics.preAccumulationRatio}%, 저점대비 +${c.metrics.closeFromLow60}%, 박스 ${c.metrics.boxRangePct}%, 매물 ${c.metrics.supplyAboveRatio}%) [${c.typeLabels.join(',')}]`);
  });

  console.log('\n🚫 제외 사유 TOP 10:');
  [...exclusionReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([reason, count]) => {
    console.log(`  ${count.toString().padStart(4)}건  ${reason}`);
  });

  // 출력
  const out = {
    meta: {
      version: 'bms-current-similarity-v1',
      generatedAt: new Date().toISOString(),
      title: 'BMS 현재 후보 (과거 정상 상승 사례와 유사한 준비 구간)',
      purpose: '과거 A+B 등급 정상 상승 사례의 공통 조건을 기준으로, 현재 시장에서 비슷한 준비 구간에 있는 종목을 찾는 보드. 매수 신호가 아니라 관심종목을 좁히기 위한 참고용.',
      coreDefinition: 'BMS는 "오늘 거래대금이 폭발한 종목"을 찾는 모델이 아니다. "오르기 전 20거래일 동안 조용히 돈이 지나갔고, 아직 고점까지 공간이 남아 있는 준비 구간 종목"을 찾는 모델이다.',
      rulesSource: source,
      latestTradingDate: candidates[0]?.currentDate || null,
    },
    config: CONFIG,
    summary: {
      totalScanned: processed,
      candidateCount: candidates.length,
      excludedCount: excluded.length,
      avgScore: round(candidates.reduce((s, c) => s + c.score, 0) / Math.max(1, candidates.length), 2),
    },
    suggestedRulesUsed: rules,
    stageSummary,
    typeSummary,
    scoreDistribution,
    excludedSummary: [...exclusionReasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
    candidates,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length/1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length/1024).toFixed(0)}KB)`);
}

function simpleMetrics(m) {
  return {
    preAccumulationRatio: m.preAccumulationRatio,
    closeFromLow60: m.closeFromLow60,
    closeFromHigh60: m.closeFromHigh60,
    boxRangePct: m.box?.boxRangePct,
    supplyAboveRatio: m.supply?.aboveCloseRatio,
  };
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>BMS 현재 후보 — 과거 상승 사례와 유사한 준비 구간</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
  -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 18px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-top: 3px; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; }
.big-tile.primary { border-left: 4px solid #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }

.tabs { display: flex; gap: 6px; margin: 18px 0 8px; flex-wrap: wrap; }
.tab-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-weight: 500; }
.tab-btn:hover { color: #f1f5f9; border-color: #64748b; }
.tab-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }

.tbl-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.list { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
table.list thead th {
  background: #0f172a; color: #94a3b8; font-weight: 600; text-align: left;
  padding: 9px 12px; border-bottom: 1px solid #334155; white-space: nowrap;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px;
}
table.list thead th.numeric { text-align: right; }
table.list tbody tr.row { border-bottom: 1px solid #1e293b; cursor: pointer; }
table.list tbody tr.row:hover { background: #273549; }
table.list tbody tr.row.expanded { background: #1e3a5f; }
table.list tbody tr.row td { padding: 8px 12px; vertical-align: middle; line-height: 1.3; white-space: nowrap; }
table.list tbody tr.row td.numeric { text-align: right; }
table.list tbody tr.row td.col-name { font-weight: 600; color: #f1f5f9; min-width: 130px; }
table.list tbody tr.row td.col-name .meta { display: block; font-size: 10px; color: #64748b; font-weight: 400; margin-top: 2px; }
table.list tbody tr.row td.col-summary { color: #cbd5e1; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
table.list tbody tr.row:nth-child(odd) { background: #1c2942; }
table.list tbody tr.row:nth-child(odd):hover { background: #273549; }
table.list tbody tr.row.expanded, table.list tbody tr.row.expanded:nth-child(odd) { background: #1e3a5f; }

.score-cell { font-weight: 700; color: #fbbf24; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-warn { color: #fde047; }
.type-pill { display: inline-block; padding: 1px 6px; margin: 1px 3px 1px 0; border-radius: 4px; font-size: 10px; font-weight: 600; }
.type-pill.classic { background: #047857; color: #d1fae5; }
.type-pill.realistic { background: #1e40af; color: #dbeafe; }
.type-pill.accumulation { background: #6d28d9; color: #ede9fe; }
.type-pill.box { background: #0e7490; color: #cffafe; }
.type-pill.supply { background: #92400e; color: #fef3c7; }
.type-pill.danger { background: #991b1b; color: #fee2e2; }
.type-pill.other { background: #475569; color: #e2e8f0; }

/* 운영 단계 pill */
.stage-pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.stage-pill.s-core { background: #14532d; color: #6ee7b7; }
.stage-pill.s-watch { background: #1e3a8a; color: #93c5fd; }
.stage-pill.s-accum { background: #6d28d9; color: #ede9fe; }
.stage-pill.s-breakout { background: #92400e; color: #fde047; }
.stage-pill.s-overheated { background: #7f1d1d; color: #fca5a5; }
.stage-pill.s-bottom { background: #475569; color: #cbd5e1; }
.tab-btn.s-core.active { background: #047857; border-color: #10b981; }
.tab-btn.s-watch.active { background: #1e40af; border-color: #3b82f6; }
.tab-btn.s-accum.active { background: #6d28d9; border-color: #a78bfa; }
.tab-btn.s-breakout.active { background: #92400e; border-color: #f59e0b; }
.tab-btn.s-overheated.active { background: #991b1b; border-color: #ef4444; }
.tab-btn.s-bottom.active { background: #475569; border-color: #94a3b8; }

table.list tbody tr.detail { display: none; background: #0c1729; }
table.list tbody tr.detail.show { display: table-row; }
table.list tbody tr.detail td { padding: 14px 18px; border-bottom: 1px solid #1e3a5f; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 24px; font-size: 12px; }
.detail-block h4 { margin: 0 0 6px; font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.detail-block p { margin: 0 0 4px; color: #cbd5e1; line-height: 1.6; }
.detail-block .strength { color: #6ee7b7; }
.detail-block .warning { color: #fca5a5; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; line-height: 1.6; }
.kv .k { color: #64748b; }
.kv .v { color: #cbd5e1; font-variant-numeric: tabular-nums; }
.score-bar { display: flex; align-items: center; gap: 4px; }
.score-bar .bar { flex: 1; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; }
.score-bar .bar .fill { display: block; height: 100%; background: #38bdf8; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .tbl-wrap { overflow-x: auto !important; }
  .col-mobile-hide,
  table.list thead th.col-mobile-hide { display: none; }
  .detail-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<h1 id="page-title">BMS 현재 후보 — 과거 상승 사례와 유사한 준비 구간</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>BMS 점수가 높다고 바로 좋은 매수 자리는 아닙니다.</strong> BMS는 과거 상승 종목과 비슷한 준비 구간을 찾는 도구이며,
  실제 매수 판단은 차트·뉴스·시장 상황 확인 후 해야 합니다. 후보를 운영 단계(오늘 볼 / 관찰 / 거래대금 누적 / 위쪽 가격 확인 / 주의)로 나눠 표시하니 <strong>오늘 볼 후보부터</strong> 단계 순서대로 보세요.
  <br><span style="color:#fbbf24;font-size:11.5px;">※ "위쪽 가격 확인"은 VVI의 거래대금 돌파와 다릅니다. 현재가 위에 예전에 거래가 많이 된 가격대를 넘는지 참고로 확인한다는 뜻입니다.</span>
</div>

<h2>📊 요약</h2>
<div class="big-summary" id="big-summary"></div>

<h2>🏆 BMS 후보 리스트</h2>
<div class="tabs" id="tabs"></div>
<div class="tbl-wrap">
  <table class="list">
    <thead>
      <tr>
        <th>#</th>
        <th>종목</th>
        <th>운영 단계</th>
        <th class="numeric">BMS 점수</th>
        <th class="numeric col-mobile-hide">현재가</th>
        <th class="numeric col-mobile-hide">시총</th>
        <th class="numeric">시총대비 들어온돈</th>
        <th class="numeric col-mobile-hide">박스폭</th>
        <th class="numeric">저점대비</th>
        <th class="numeric col-mobile-hide">고점대비</th>
        <th class="numeric col-mobile-hide">위쪽매물</th>
        <th class="col-mobile-hide">왜 이 단계인지</th>
        <th class="col-mobile-hide">다음에 확인할 것</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<footer class="foot">
  <strong>매수 신호가 아닙니다.</strong> BMS Current Similarity Scan은 <em>과거 A+B 등급 정상 상승 사례의 공통 조건과 현재 종목의 준비 구간을 비교</em>하는 분석 도구입니다.
  관심종목을 좁히는 1차 필터로만 활용하시고, 실제 매매 판단은 차트·뉴스·시장 상황을 별도로 확인하세요.
  <br><br>
  <small style="color:#64748b;">기준값 출처: <span id="rules-source"></span> · 차트 약 120일 보유 한계로 ma120·매물대 일부 부정확.</small>
</footer>

<script id="report-data" type="application/json">__JSON_DATA__</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const meta = data.meta || {};
  const summary = data.summary || {};
  const candidates = data.candidates || [];
  const typeSummary = data.typeSummary || {};
  const rules = data.suggestedRulesUsed || {};

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d); }
  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtPctRaw(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtX(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d) + '배'; }
  function fmtMc(v) { if (!v) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; return Math.round(e) + '억'; }
  function fmtPrice(v) { if (!v) return '-'; return Number(v).toLocaleString() + '원'; }
  function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }

  document.getElementById('subtitle').innerHTML =
    '기준일 <strong style="color:#cbd5e1;">' + fmtDate(meta.latestTradingDate) + '</strong> · 검사 ' + summary.totalScanned + '종목 · 후보 <strong>' + summary.candidateCount + '건</strong> · 평균 BMS 점수 ' + summary.avgScore + ' · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>핵심 정의:</strong> ' + escapeHtml(meta.coreDefinition);
  document.getElementById('rules-source').textContent = meta.rulesSource;

  // big tiles — 운영 단계 중심 (오늘 볼 후보 강조)
  const stageSummary = data.stageSummary || {};
  const tiles = [
    { label: '검사 종목', value: summary.totalScanned + '개', sub: '시총 100억+, ETF 제외 · 들어온 돈 7% 이상 80% 이하 통과' },
    { label: '전체 후보', value: summary.candidateCount + '건', sub: '평균 BMS 점수 ' + summary.avgScore },
    { label: '🎯 오늘 볼 후보', value: (stageSummary['오늘 볼 후보'] || 0) + '건', sub: '오늘 먼저 차트로 검토', cls: 'primary' },
    { label: '👁 관찰 후보', value: (stageSummary['관찰 후보'] || 0) + '건', sub: '관심종목 수준' },
    { label: '💰 거래대금 누적 후보', value: (stageSummary['거래대금 누적 후보'] || 0) + '건', sub: '조용한 누적형 (BMS 핵심)' },
    { label: '🧱 위쪽 가격 확인', value: (stageSummary['위쪽 가격 확인'] || 0) + '건', sub: '위에 막힌 가격대 있음' },
    { label: '⚠️ 주의 후보', value: (stageSummary['주의 후보'] || 0) + '건', sub: '이미 많이 오른 상태' },
    { label: '평균 BMS 점수', value: summary.avgScore, sub: '점수 분포 평균' },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div><div class="sub">' + t.sub + '</div>';
    ts.appendChild(el);
  });

  // 탭 — 운영 단계 중심 (기본은 오늘 볼 후보)
  const tabs = [
    { id: '오늘 볼 후보', label: '🎯 오늘 볼 후보 (' + (stageSummary['오늘 볼 후보'] || 0) + ')', cls: 's-core' },
    { id: '관찰 후보', label: '👁 관찰 후보 (' + (stageSummary['관찰 후보'] || 0) + ')', cls: 's-watch' },
    { id: '거래대금 누적 후보', label: '💰 거래대금 누적 후보 (' + (stageSummary['거래대금 누적 후보'] || 0) + ')', cls: 's-accum' },
    { id: '위쪽 가격 확인', label: '🧱 위쪽 가격 확인 (' + (stageSummary['위쪽 가격 확인'] || 0) + ')', cls: 's-breakout' },
    { id: '주의 후보', label: '⚠️ 주의 후보 (' + (stageSummary['주의 후보'] || 0) + ')', cls: 's-overheated' },
    { id: 'all', label: '전체 (' + candidates.length + ')' },
  ];
  const tabsEl = document.getElementById('tabs');
  let activeTab = '오늘 볼 후보';
  tabs.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn ' + (t.cls || '') + (t.id === activeTab ? ' active' : '');
    btn.textContent = t.label;
    btn.dataset.tab = t.id;
    btn.addEventListener('click', () => {
      activeTab = t.id;
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderList();
    });
    tabsEl.appendChild(btn);
  });

  function pickList() {
    if (activeTab === 'all') return candidates;
    return candidates.filter(c => c.operationStage === activeTab);
  }
  function stageClass(stage) {
    if (stage === '오늘 볼 후보') return 's-core';
    if (stage === '관찰 후보') return 's-watch';
    if (stage === '거래대금 누적 후보') return 's-accum';
    if (stage === '위쪽 가격 확인') return 's-breakout';
    if (stage === '주의 후보') return 's-overheated';
    return 's-bottom';
  }
  function typeClass(t) {
    if (t === '정석 상승 준비형') return 'classic';
    if (t === '현실 상승 준비형') return 'realistic';
    if (t === '거래대금 누적형') return 'accumulation';
    if (t === '박스권 응축형') return 'box';
    if (t === '위쪽 매물 부담형') return 'supply';
    if (t === '이미 많이 오른 위험형') return 'danger';
    return 'other';
  }

  const tbody = document.getElementById('list-body');
  function renderList() {
    tbody.innerHTML = '';
    const list = pickList();
    list.forEach((c) => {
      const m = c.metrics || {};
      const stage = c.operationStage || '하단/관찰';

      const tr = document.createElement('tr');
      tr.className = 'row';
      tr.innerHTML =
        '<td>' + c.rank + '</td>' +
        '<td class="col-name">' + escapeHtml(c.name) + '<span class="meta">' + c.code + ' · ' + (c.market || '-') + '</span></td>' +
        '<td><span class="stage-pill ' + stageClass(stage) + '">' + escapeHtml(stage) + '</span></td>' +
        '<td class="numeric score-cell">' + fmtNum(c.score, 1) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPrice(c.currentClose) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtMc(c.marketCap) + '</td>' +
        '<td class="numeric">' + fmtPctRaw(m.preAccumulationRatio) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPctRaw(m.boxRangePct) + '</td>' +
        '<td class="numeric">' + fmtPct(m.closeFromLow60) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPct(m.closeFromHigh60) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPctRaw(m.supplyAboveRatio) + '</td>' +
        '<td class="col-mobile-hide" style="color:#cbd5e1;font-size:11.5px;max-width:260px;white-space:normal;line-height:1.4;">' + escapeHtml(c.operationReason || '') + '</td>' +
        '<td class="col-mobile-hide" style="color:#fde68a;font-size:11.5px;max-width:260px;white-space:normal;line-height:1.4;">' + escapeHtml(c.nextCheckPoint || '') + '</td>';

      const trd = document.createElement('tr');
      trd.className = 'detail';
      trd.innerHTML = '<td colspan="13">' + buildDetailHtml(c) + '</td>';
      tr.addEventListener('click', () => {
        tr.classList.toggle('expanded');
        trd.classList.toggle('show');
      });
      tbody.appendChild(tr);
      tbody.appendChild(trd);
    });
  }

  function bar(v, max) { const w = Math.max(0, Math.min(100, (v / max) * 100)); return '<div class="bar"><span class="fill" style="width:' + w + '%;"></span></div>'; }

  function buildDetailHtml(c) {
    const m = c.metrics || {};
    const s = c.scores || {};
    const strengthsHtml = (c.strengths || []).map(x => '<p class="strength">✓ ' + escapeHtml(x) + '</p>').join('');
    const warningsHtml = (c.warnings || []).map(x => '<p class="warning">⚠ ' + escapeHtml(x) + '</p>').join('');

    return '<div class="detail-grid">' +
      '<div class="detail-block" style="grid-column: 1 / -1; background:#0f172a; padding:10px 14px; border-radius:6px;">' +
        '<h4>📌 운영 판단</h4>' +
        '<p><span class="stage-pill ' + stageClass(c.operationStage) + '">' + escapeHtml(c.operationStage) + '</span></p>' +
        '<p style="margin-top:6px;"><strong style="color:#cbd5e1;">왜 이 단계인지:</strong> ' + escapeHtml(c.operationReason || '-') + '</p>' +
        '<p><strong style="color:#fde68a;">다음에 확인할 것:</strong> ' + escapeHtml(c.nextCheckPoint || '-') + '</p>' +
        '<p style="margin-top:6px;"><strong style="color:#94a3b8;">한 줄 해석:</strong> ' + escapeHtml(c.oneLineSummary || '-') + '</p>' +
        ((c.typeLabels || []).length ? '<p style="margin-top:6px;"><strong style="color:#94a3b8;">유형:</strong> ' + (c.typeLabels || []).map(t => '<span class="type-pill ' + typeClass(t) + '">' + escapeHtml(t) + '</span>').join('') + '</p>' : '') +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>BMS 점수 분해</h4>' +
        '<div class="kv">' +
          '<div class="k">상승 전 들어온 돈 (30점)</div><div class="v">' + fmtNum(s.accumulationScore, 1) + '점</div>' +
          '<div class="k">가격 위치 (25점)</div><div class="v">' + fmtNum(s.pricePositionScore, 1) + '점</div>' +
          '<div class="k">박스권 (20점)</div><div class="v">' + fmtNum(s.boxScore, 1) + '점</div>' +
          '<div class="k">위쪽 매물 부담 (10점)</div><div class="v">' + fmtNum(s.supplyScore, 1) + '점</div>' +
          '<div class="k">거래대금 유지 (10점)</div><div class="v">' + fmtNum(s.valuePersistenceScore, 1) + '점</div>' +
          '<div class="k">이평선 (5점)</div><div class="v">' + fmtNum(s.movingAverageScore, 1) + '점</div>' +
          '<div class="k" style="color:#fbbf24;font-weight:700;">총점</div><div class="v" style="color:#fbbf24;font-weight:700;">' + fmtNum(s.total, 1) + '점</div>' +
        '</div>' +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>① 상승 전 들어온 돈</h4>' +
        '<div class="kv">' +
          '<div class="k">최근 20일 누적 / 시총</div><div class="v">' + fmtPctRaw(m.preAccumulationRatio) + '</div>' +
          '<div class="k">기준 좋은 구간</div><div class="v">' + fmtNum(rules.preAccumulationRatio?.idealMin) + '~' + fmtNum(rules.preAccumulationRatio?.idealMax) + '%</div>' +
          '<div class="k">오늘 거래대금 / 시총</div><div class="v">' + fmtPctRaw(m.startDayValueRatio) + '</div>' +
          '<div class="k">최근 20일 평균 거래대금</div><div class="v">' + (m.avgValue20 ? Math.round(m.avgValue20 / 1e8) + '억' : '-') + '</div>' +
          '<div class="k">평소보다 거래가 늘어난 정도</div><div class="v">' + (m.valueSpikeRatio != null ? fmtX(m.valueSpikeRatio) : '-') + '</div>' +
          '<div class="k">거래가 꾸준히 이어진 일수</div><div class="v">' + (m.persistDays || '-') + '/' + 20 + '일 (' + fmtPctRaw(m.persistRatio) + ')</div>' +
        '</div>' +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>② 가격 위치</h4>' +
        '<div class="kv">' +
          '<div class="k">60일 저점 대비</div><div class="v">' + fmtPct(m.closeFromLow60) + ' (좋은 구간 ' + fmtNum(rules.closeFromLow60?.idealMin) + '~' + fmtNum(rules.closeFromLow60?.idealMax) + '%)</div>' +
          '<div class="k">60일 고점 대비</div><div class="v">' + fmtPct(m.closeFromHigh60) + ' (좋은 구간 ' + fmtNum(rules.closeFromHigh60?.idealMin) + '~' + fmtNum(rules.closeFromHigh60?.idealMax) + '%)</div>' +
          '<div class="k">120일 저점 대비</div><div class="v">' + fmtPct(m.closeFromLow120) + '</div>' +
          '<div class="k">120일 고점 대비</div><div class="v">' + fmtPct(m.closeFromHigh120) + '</div>' +
          '<div class="k">52주 고점 대비</div><div class="v">' + fmtPct(m.closeFrom52WeekHigh) + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>③ 박스권</h4>' +
        '<div class="kv">' +
          '<div class="k">박스권 기간</div><div class="v">' + (m.boxRangeDays || '-') + '일</div>' +
          '<div class="k">박스권 폭</div><div class="v">' + fmtPctRaw(m.boxRangePct) + ' (좋은 구간 ' + fmtNum(rules.boxRangePct?.idealMin) + '~' + fmtNum(rules.boxRangePct?.idealMax) + '%)</div>' +
          '<div class="k">박스 하단</div><div class="v">' + (m.boxLow != null ? Number(m.boxLow).toLocaleString() + '원' : '-') + '</div>' +
          '<div class="k">박스 상단</div><div class="v">' + (m.boxHigh != null ? Number(m.boxHigh).toLocaleString() + '원' : '-') + '</div>' +
          '<div class="k">저점이 올라가나</div><div class="v">' + (m.lowRising ? '예' : '아니오') + '</div>' +
          '<div class="k">상단 두드린 횟수</div><div class="v">' + (m.touchedHighTimes || 0) + '회</div>' +
          '<div class="k">박스 안 거래대금 추세</div><div class="v">' + (m.valueTrendInBox || '-') + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>④ 위쪽 매물 부담</h4>' +
        '<div class="kv">' +
          '<div class="k">현재가 위쪽 매물 비율</div><div class="v">' + fmtPctRaw(m.supplyAboveRatio) + '</div>' +
          '<div class="k">기준 (좋음/허용/한계)</div><div class="v">' + fmtNum(rules.supplyAboveRatio?.idealMax) + '% / ' + fmtNum(rules.supplyAboveRatio?.tolerantMax) + '% / ' + fmtNum(rules.supplyAboveRatio?.max) + '%</div>' +
        '</div>' +
        '<p style="color:#94a3b8;font-size:11px;margin-top:6px;">현재가 위에 거래량이 많이 쌓인 가격대(매물)가 두꺼우면 위쪽으로 갈 때 저항이 됩니다.</p>' +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>⑤ 이평선 위치</h4>' +
        '<div class="kv">' +
          '<div class="k">5일선</div><div class="v">' + (m.ma5 != null ? Number(m.ma5).toLocaleString() + '원' : '-') + '</div>' +
          '<div class="k">20일선</div><div class="v">' + (m.ma20 != null ? Number(m.ma20).toLocaleString() + '원' : '-') + ' (' + (m.aboveMa20 ? '↑ 위' : '↓ 아래') + ')</div>' +
          '<div class="k">60일선</div><div class="v">' + (m.ma60 != null ? Number(m.ma60).toLocaleString() + '원' : '-') + ' (' + (m.aboveMa60 ? '↑ 위' : '↓ 아래') + ')</div>' +
          '<div class="k">120일선</div><div class="v">' + (m.ma120 != null ? Number(m.ma120).toLocaleString() + '원' : '-') + ' (' + (m.aboveMa120 ? '↑ 위' : '↓ 아래') + ')</div>' +
        '</div>' +
      '</div>' +

      '<div class="detail-block" style="grid-column: 1 / -1;">' +
        '<h4>BMS 과거 패턴과 닮은 점 / 주의할 점</h4>' +
        (strengthsHtml || '<p style="color:#64748b;">강점 항목 없음</p>') +
        (warningsHtml || '<p style="color:#64748b;">경고 항목 없음</p>') +
      '</div>' +
    '</div>';
  }

  renderList();
})();
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}
