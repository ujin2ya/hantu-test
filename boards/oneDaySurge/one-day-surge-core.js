// 1-Day Surge 공용 로직.
// one-day-surge-board.js (라이브 보드) 와 one-day-surge-nextday-validation-report.js (백테스트)
// 가 같은 임계값으로 동작하도록 점수/그룹 분류/필터를 한 곳에서 관리한다.
//
// 사용자가 임계값을 튜닝할 때는 이 파일의 CONFIG / 점수 함수 / classifyGroup 만 고치면
// 보드와 검증이 자동 동기화된다.

const CONFIG = {
  // 진입 사전 필터 (차트 기반)
  MIN_HISTORY: 25,
  MIN_AVG20_VALUE: 1e8,           // 직전 20일 평균 거래대금 1억 미만 = 너무 얕은 종목
  MIN_BASE_VALUE: 5e8,            // 기준일 거래대금 5억 미만 = 단타 후보 자격 없음
  MIN_CLOSE_PRICE: 500,           // 너무 저가 종목 (호가 단위 노이즈)
  // 시가총액 (단위: 원)
  MARKET_CAP_HARD_MIN: 5e10,      // 500억 미만 → 제외
  MARKET_CAP_HARD_MAX: 5e12,      // 5조 이상 → 제외 (초대형주는 단타 탄력 약함)
  MARKET_CAP_CORE_LO: 1e11,       // 1,000억
  MARKET_CAP_CORE_HI: 1.5e12,     // 1조 5천억 (1,000억~1.5조 = 핵심 우선 구간)
  MARKET_CAP_MID_FROM: 1.5e12,    // 1.5조 이상 → 약한 감점
  MARKET_CAP_BIG_FROM: 3e12,      // 3조 이상 → 탄력 약화 감점
  // 시총 감점치
  MARKET_CAP_PENALTY_BIG: -8,     // 3조~5조
  MARKET_CAP_PENALTY_MID: -3,     // 1.5조~3조
  MARKET_CAP_PENALTY_SMALL: -5,   // 500억~1,000억 (고위험)
  // 그룹별 화면 노출 상한
  CAP: { A: 80, B: 80, C: 60, D: 60 },
};

// ETF/ETN 브랜드 + 특수 종목 키워드. naver의 isEtf/isSpecial 플래그가 놓친 경우의 방어용.
const EXCLUDE_NAME_KEYWORDS = [
  'ETF', 'ETN',
  'KODEX', 'TIGER', 'ACE', 'SOL', 'KBSTAR', 'HANARO', 'ARIRANG', 'TIMEFOLIO', 'KOSEF', '히어로즈', 'PLUS',
  '인버스', '레버리지',
  '리츠', '스팩',
  '제1호', '제2호', '제3호', '제4호',
];

// 종목명 끝의 우/우B/숫자우/숫자우B/숫자우C 우선주 패턴.
// 매칭: 삼성전자우, 현대차2우B, 한화3우C, 두산퓨얼셀1우, "CJ제일제당 우" 등.
// 미매칭: 우진플라임, 우리은행, 우림기계 등 (우로 끝나지 않음).
function isPreferredShareName(name) {
  if (!name) return false;
  return /\s?\d*우[A-Z]?$/.test(String(name).trim());
}

function isExcludedByName(name) {
  if (!name) return false;
  for (const kw of EXCLUDE_NAME_KEYWORDS) {
    if (name.includes(kw)) return true;
  }
  return isPreferredShareName(name);
}

// hard filter — meta = {marketCap, isEtf, isSpecial, name}
// 통과한 종목만 분석/스코어링 단계로 진입.
function passesHardFilter(meta) {
  if (!meta) return { ok: false, reason: 'no_meta' };
  if (meta.isEtf) return { ok: false, reason: 'etf' };
  if (meta.isSpecial) return { ok: false, reason: 'special' };
  if (isExcludedByName(meta.name)) return { ok: false, reason: 'excluded_name' };
  const mc = Number(meta.marketCap) || 0;
  if (mc <= 0) return { ok: false, reason: 'no_marketcap' };
  if (mc < CONFIG.MARKET_CAP_HARD_MIN) return { ok: false, reason: 'mc_under_500' };
  if (mc >= CONFIG.MARKET_CAP_HARD_MAX) return { ok: false, reason: 'mc_over_5t' };
  return { ok: true };
}

const MARKET_CAP_BAND_LABEL = {
  TINY:  '시총 500억 미만',
  SMALL: '시총 500억~1,000억 (고위험 감점)',
  CORE:  '시총 1,000억~1.5조 (핵심 구간)',
  MID:   '시총 1.5조~3조 (약한 감점)',
  BIG:   '시총 3조~5조 (탄력 약화 감점)',
  MEGA:  '시총 5조 이상',
  UNKNOWN: '시총 미확인',
};

function classifyMarketCapBand(mc) {
  if (!mc || mc <= 0) return 'UNKNOWN';
  if (mc < CONFIG.MARKET_CAP_HARD_MIN) return 'TINY';
  if (mc < CONFIG.MARKET_CAP_CORE_LO) return 'SMALL';
  if (mc < CONFIG.MARKET_CAP_CORE_HI) return 'CORE';
  if (mc < CONFIG.MARKET_CAP_BIG_FROM) return 'MID';
  if (mc < CONFIG.MARKET_CAP_HARD_MAX) return 'BIG';
  return 'MEGA';
}

function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

// 차트의 최신 row 중 volume>0/close>0 인 첫 번째 인덱스.
function pickLatestBaseIdx(rows) {
  if (!Array.isArray(rows)) return -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.volume > 0 && r.close > 0 && r.high > 0 && r.low > 0) return i;
  }
  return -1;
}

// rows의 baseIdx 위치를 기준으로 단일 일자 분석. 백테스트는 baseIdx를 과거로 옮겨가며 호출.
function analyzeAt(rows, baseIdx) {
  if (!Array.isArray(rows) || rows.length < CONFIG.MIN_HISTORY) return null;
  if (baseIdx < 20 || baseIdx >= rows.length) return null;
  const base = rows[baseIdx];
  const prev = rows[baseIdx - 1];
  if (!base || !prev || !base.close || !prev.close) return null;
  if (!(base.volume > 0)) return null;
  if (base.close < CONFIG.MIN_CLOSE_PRICE) return null;
  if ((base.valueApprox || 0) < CONFIG.MIN_BASE_VALUE) return null;

  let sumVal = 0, sumVol = 0, n = 0;
  for (let i = baseIdx - 20; i < baseIdx; i++) {
    const r = rows[i];
    if (r && r.volume > 0) {
      sumVal += (r.valueApprox || 0);
      sumVol += (r.volume || 0);
      n++;
    }
  }
  if (n < 15) return null;
  const avg20Value = sumVal / n;
  const avg20Volume = sumVol / n;
  if (avg20Value < CONFIG.MIN_AVG20_VALUE) return null;

  const valueRatio = base.valueApprox / avg20Value;
  const volumeRatio = avg20Volume > 0 ? base.volume / avg20Volume : null;
  const closeRange = base.high - base.low;
  const closePosition = closeRange > 0 ? (base.close - base.low) / closeRange : 0.5;
  const upperTailRatio = closeRange > 0 ? (base.high - base.close) / closeRange : 0;
  const changeRate = (base.close / prev.close - 1) * 100;
  const gapPct = prev.close > 0 ? (base.open / prev.close - 1) * 100 : null;

  const back = (k) => {
    const r = rows[baseIdx - k];
    return r && r.close > 0 ? (base.close / r.close - 1) * 100 : null;
  };
  const ret3d = back(3);
  const ret5d = back(5);

  let high20 = 0;
  for (let i = baseIdx - 20; i < baseIdx; i++) {
    if (rows[i] && rows[i].high > high20) high20 = rows[i].high;
  }
  const distFromHigh20 = high20 > 0 ? (base.close / high20 - 1) * 100 : null;
  const isBreakoutOf20 = distFromHigh20 != null && distFromHigh20 > 0;
  const nearHigh20 = distFromHigh20 != null && distFromHigh20 <= 0 && distFromHigh20 >= -2;

  return {
    baseIdx,
    baseDate: base.date,
    open: base.open, high: base.high, low: base.low, close: base.close,
    volume: base.volume, valueAmount: base.valueApprox,
    prevClose: prev.close,
    avg20Value, avg20Volume,
    valueRatio: round(valueRatio),
    volumeRatio: round(volumeRatio),
    closePosition: round(closePosition, 3),
    upperTailRatio: round(upperTailRatio, 3),
    changeRate: round(changeRate),
    gapPct: round(gapPct),
    ret3d: round(ret3d),
    ret5d: round(ret5d),
    high20: high20 || null,
    distFromHigh20: round(distFromHigh20),
    isBreakoutOf20,
    nearHigh20,
  };
}

// marketCap (원 단위)을 받아 시총 감점도 함께 적용.
function scoreMetrics(m, marketCap) {
  const s = {};
  s.valueSurgeScore =
    m.valueRatio >= 5 ? 25 :
    m.valueRatio >= 3 ? 20 :
    m.valueRatio >= 2 ? 15 :
    m.valueRatio >= 1.5 ? 10 :
    m.valueRatio >= 1.2 ? 5 : 0;
  s.volumeSurgeScore = m.volumeRatio == null ? 0 :
    m.volumeRatio >= 3 ? 15 :
    m.volumeRatio >= 2 ? 10 :
    m.volumeRatio >= 1.5 ? 5 : 0;
  s.closeStrengthScore =
    m.closePosition >= 0.85 ? 20 :
    m.closePosition >= 0.70 ? 14 :
    m.closePosition >= 0.50 ? 7 : 0;
  s.priceMomentumScore =
    m.changeRate >= 7 ? 15 :
    m.changeRate >= 5 ? 12 :
    m.changeRate >= 3 ? 8 :
    m.changeRate >= 1 ? 4 :
    m.changeRate >= 0 ? 1 : 0;
  s.breakoutPotentialScore =
    m.isBreakoutOf20 ? 15 :
    m.nearHigh20 ? 12 :
    (m.distFromHigh20 != null && m.distFromHigh20 >= -5) ? 8 :
    (m.distFromHigh20 != null && m.distFromHigh20 >= -10) ? 4 : 0;

  s.upperTailPenalty =
    m.upperTailRatio >= 0.6 ? -20 :
    m.upperTailRatio >= 0.4 ? -10 : 0;
  let overheat = 0;
  if (m.changeRate >= 25) overheat = Math.min(overheat, -20);
  if (m.ret3d != null && m.ret3d >= 30) overheat = Math.min(overheat, -20);
  if (m.ret5d != null && m.ret5d >= 50) overheat = Math.min(overheat, -15);
  if (m.ret3d != null && m.ret3d >= 20 && overheat === 0) overheat = -10;
  s.overheatPenalty = overheat;
  let risk = 0;
  if (m.changeRate < 0 && m.closePosition < 0.3) risk -= 20;
  if (m.changeRate < -3) risk -= 10;
  if (m.close < m.open && m.closePosition < 0.3 && m.upperTailRatio >= 0.4) risk -= 10;
  s.riskPenalty = Math.max(-30, risk);

  // 시가총액 감점
  const band = classifyMarketCapBand(marketCap);
  let mcPen = 0;
  if (band === 'BIG')   mcPen = CONFIG.MARKET_CAP_PENALTY_BIG;
  else if (band === 'MID')   mcPen = CONFIG.MARKET_CAP_PENALTY_MID;
  else if (band === 'SMALL') mcPen = CONFIG.MARKET_CAP_PENALTY_SMALL;
  s.marketCapPenalty = mcPen;
  s.marketCapBand = band;

  s.oneDaySurgeScore = Math.round(
    s.valueSurgeScore + s.volumeSurgeScore + s.closeStrengthScore +
    s.priceMomentumScore + s.breakoutPotentialScore +
    s.upperTailPenalty + s.overheatPenalty + s.riskPenalty + s.marketCapPenalty
  );
  return s;
}

// 그룹 분류 (배타). 우선순위: D(위험) → A(강) → B(관심) → C(눌림) → null(드롭).
function classifyGroup(m, s) {
  const overheatedHard =
    (m.ret3d != null && m.ret3d >= 25) ||
    (m.ret5d != null && m.ret5d >= 40) ||
    (m.changeRate >= 25 && m.closePosition < 0.7);
  const tailHeavy = m.upperTailRatio >= 0.6 && m.valueRatio >= 2;
  if ((overheatedHard && s.oneDaySurgeScore >= 35) || tailHeavy) return 'D';
  if (s.oneDaySurgeScore >= 85
      && m.valueRatio >= 3
      && m.closePosition >= 0.70
      && m.upperTailRatio < 0.4
      && m.changeRate >= 3) return 'A';
  if (s.oneDaySurgeScore >= 65
      && m.valueRatio >= 1.5
      && m.closePosition >= 0.50
      && m.changeRate >= 1) return 'B';
  if (m.valueRatio >= 2
      && m.upperTailRatio >= 0.4
      && m.changeRate >= -2
      && s.oneDaySurgeScore >= 35) return 'C';
  return null;
}

// ─────────────────────────────────────────────────────────
// v5: GT 그룹 분류 (검증 보고서 v4-extra2 결과 반영)
//   기존 A/B/C/D 그룹 대신 시총 구간 + 캔들 + 거래대금 순위 + 최근 급등 횟수 조합으로
//   LIGHT-GT / BALANCED-GT / MID-CAP-GT / MICRO-RISK / MOM-RISK / HEAVY-WATCH / HEAVY-RISK 분류.
// ─────────────────────────────────────────────────────────

// GT 그룹별 시총 구간 라벨 (보드 사용자 노출용)
const GT_BAND_LABEL = {
  MICRO:    '초경량 500억~1,000억 (MICRO-RISK 후보)',
  LIGHT:    '경량 1,000억~3,000억 (LIGHT-GT 후보)',
  BALANCED: '균형형 3,000억~7,000억 (BALANCED-GT 후보)',
  MID_CAP:  '중형 7,000억~1.5조 (MID-CAP-GT 후보 — LOW_GAP_INTRADAY 한정)',
  HEAVY_WATCH: '준중대형 1.5조~3조 (HEAVY-WATCH — 단타 탄력 약화)',
  HEAVY_RISK:  '대형 3조~5조 (HEAVY-RISK — 강한 감점)',
  MEGA:     '초대형 5조 이상 (MEGA-EXCLUDE — 보드 제외)',
};

function classifyGtBand(mc) {
  if (!mc || mc <= 0) return 'UNKNOWN';
  if (mc < 5e10) return 'TINY';
  if (mc < 1e11) return 'MICRO';        // 500억~1,000억
  if (mc < 3e11) return 'LIGHT';        // 1,000억~3,000억
  if (mc < 7e11) return 'BALANCED';     // 3,000억~7,000억
  if (mc < 1.5e12) return 'MID_CAP';    // 7,000억~1.5조
  if (mc < 3e12) return 'HEAVY_WATCH';  // 1.5조~3조
  if (mc < 5e12) return 'HEAVY_RISK';   // 3조~5조
  return 'MEGA';                         // 5조↑
}

// 캔들 구조 분류 (검증 보고서 v4와 동일 — 배타 우선순위)
//   RED_CLOSE → UPPER_WICK_GREEN → GAP_HOLD → LOW_GAP_INTRADAY → BIG_GREEN → OTHER
// 입력: m (analyzeAt 결과) + base 행의 open/close/high/low — analyzeAt이 이미 주는 값 사용.
function classifyCandleType(m) {
  if (!m || !Number.isFinite(m.open) || !Number.isFinite(m.close) || !Number.isFinite(m.high) || !Number.isFinite(m.low)) return 'OTHER';
  if (m.close < m.open) return 'RED_CLOSE';
  const range = m.high - m.low;
  const bodyToRange = range > 0 ? Math.abs(m.close - m.open) / range : null;
  // baseGapRate = (open - prevClose) / prevClose * 100 — analyzeAt의 gapPct가 같은 값
  const baseGap = m.gapPct;
  // baseOpenToCloseRate = (close - open) / open * 100
  const baseOpenToClose = m.open > 0 ? (m.close / m.open - 1) * 100 : null;

  if (m.close > m.open && Number.isFinite(m.upperTailRatio) && m.upperTailRatio >= 0.35) return 'UPPER_WICK_GREEN';
  if (Number.isFinite(baseGap) && baseGap >= 7
      && Number.isFinite(baseOpenToClose) && baseOpenToClose >= 0
      && Number.isFinite(m.closePosition) && m.closePosition >= 0.8) return 'GAP_HOLD';
  if (Number.isFinite(baseGap) && baseGap < 7
      && Number.isFinite(baseOpenToClose) && baseOpenToClose >= 10
      && Number.isFinite(m.closePosition) && m.closePosition >= 0.8) return 'LOW_GAP_INTRADAY';
  if (m.close > m.open && Number.isFinite(bodyToRange) && bodyToRange >= 0.6
      && Number.isFinite(m.closePosition) && m.closePosition >= 0.8) return 'BIG_GREEN';
  return 'OTHER';
}

// 최근 N거래일 안에 +threshold% 이상 상승일 수 (baseIdx 제외)
function countRecentSurges(rows, baseIdx, lookback, threshold) {
  let cnt = 0;
  for (let i = baseIdx - lookback; i < baseIdx; i++) {
    const r = rows[i], pr = rows[i - 1];
    if (r && pr && pr.close > 0) {
      const ch = (r.close / pr.close - 1) * 100;
      if (ch >= threshold) cnt++;
    }
  }
  return cnt;
}

// GT 그룹 분류 (검증 보고서 v4-extra2 권고 그룹)
//   주의: 보드는 전일 데이터 기준이라 다음날 gapRate는 알 수 없음 — gapRate는 카드 표시만, 분류 무관.
//
// 우선순위 (배타):
//   MOM-RISK     — 상한가형 (changeRate ≥ 29%)
//   HEAVY-RISK   — 시총 3조~5조 (강한 감점)
//   HEAVY-WATCH  — 시총 1.5조~3조 (약한 감점, 별도 표시)
//   MID-CAP-GT   — 7000억~1.5조 + v/mc≥5 + LOW_GAP_INTRADAY
//   BALANCED-GT  — 3000억~7000억 + v/mc≥5 + (LOW_GAP_INTRADAY 또는 valueRank≤30)
//   LIGHT-GT     — 1000억~3000억 + v/mc≥5 + recent5Up15Count≤1
//   MICRO-RISK   — 500억~1000억 (어떤 조건이든 표시만)
//   UNCLASSIFIED — 위 어디에도 안 들어가는 후보 (보드 노출 X)
function classifyGtGroup({ m, marketCap, valueToMarketCapRatio, candleType, dailyValueRank, recent5Up15Count }) {
  if (!Number.isFinite(marketCap) || marketCap <= 0) return 'UNCLASSIFIED';

  // MOM-RISK: 상한가형 — TRAP 큰 위험. v/mc 무관, 시총 5조 미만이기만 하면 표시
  if (Number.isFinite(m && m.changeRate) && m.changeRate >= 29) return 'MOM-RISK';

  const band = classifyGtBand(marketCap);
  if (band === 'MEGA' || band === 'TINY') return 'UNCLASSIFIED'; // hard filter에서 이미 제외됐어야

  // 시총 1.5조 이상 — 단타 탄력 약함 (HEAVY 그룹 — v/mc 무관 표시)
  if (band === 'HEAVY_RISK')  return 'HEAVY-RISK';
  if (band === 'HEAVY_WATCH') return 'HEAVY-WATCH';

  const v = valueToMarketCapRatio;
  const hasV = Number.isFinite(v) && v >= 5;
  const r5OK = Number.isFinite(recent5Up15Count) && recent5Up15Count <= 1;
  const rankOK = Number.isFinite(dailyValueRank) && dailyValueRank <= 30;
  const lowGap = candleType === 'LOW_GAP_INTRADAY';

  // MID-CAP-GT: 중형 + v/mc≥5 + LOW_GAP_INTRADAY 한정
  if (band === 'MID_CAP') {
    if (hasV && lowGap) return 'MID-CAP-GT';
    return 'UNCLASSIFIED'; // 중형은 LOW_GAP_INTRADAY 외 케이스 보드 노출 X
  }
  // BALANCED-GT: 균형형 + v/mc≥5 + (LOW_GAP_INTRADAY 또는 거래대금 상위 30위)
  if (band === 'BALANCED') {
    if (hasV && (lowGap || rankOK)) return 'BALANCED-GT';
    return 'UNCLASSIFIED';
  }
  // LIGHT-GT: 경량 + v/mc≥5 + recent5Up15Count ≤ 1
  if (band === 'LIGHT') {
    if (hasV && r5OK) return 'LIGHT-GT';
    return 'UNCLASSIFIED';
  }
  // MICRO-RISK: 500억~1000억 — 표시만 (어떤 조건이든)
  if (band === 'MICRO') return 'MICRO-RISK';

  return 'UNCLASSIFIED';
}

const GT_GROUP_LABEL = {
  'BALANCED-GT': '🟢 균형형 단타 후보 (3,000억~7,000억)',
  'LIGHT-GT':    '🔵 경량 단타 후보 (1,000억~3,000억)',
  'MID-CAP-GT':  '🟣 중형 단타 후보 (7,000억~1.5조, LOW_GAP_INTRADAY)',
  'MOM-RISK':    '🟠 상한가형 장초 확인 후보 (전일 +29%↑)',
  'HEAVY-WATCH': '⚪ 준중대형 (1.5조~3조, 단타 탄력 약화)',
  'MICRO-RISK':  '🟡 초경량 고위험 (500억~1,000억, 표시만)',
  'HEAVY-RISK':  '🔴 대형 (3조~5조, 강한 감점)',
};
const GT_GROUP_DESC = {
  'BALANCED-GT': '시총과 수급 강도의 균형이 좋은 단타 후보입니다. v/mc≥5% + LOW_GAP_INTRADAY 또는 거래대금 시장 상위 30위.',
  'LIGHT-GT':    '가볍게 움직일 수 있는 경량 단타 후보입니다. 최근 급등 횟수가 과하지 않고(최근 5일 +15%↑ 1회 이하) 시총 대비 거래대금이 크게 들어온 종목입니다.',
  'MID-CAP-GT':  '중형주 중 낮은 갭에서 장중 매수세로 끌어올린 유형입니다. 검증 보고서에서 의외로 GOOD_TRADE 성과가 좋게 나온 구간입니다.',
  'MOM-RISK':    '전일 +29% 이상 상한가형. HIT10률은 높지만 시초가 진입자에게는 TRAP 위험이 크므로 S 후보가 아니라 장초 확인 후보로만 봅니다.',
  'HEAVY-WATCH': '준중대형주(1.5조~3조)는 단타 탄력이 약해질 수 있어 참고로만 봅니다.',
  'MICRO-RISK':  '가볍게 튈 수는 있지만 장중 흔들림이 큰 초경량 고위험 후보입니다. 실전 진입보다는 위험 표시 중심으로 봅니다.',
  'HEAVY-RISK':  '대형주(3조~5조)는 단타 탄력이 더 약해 보드 하단 배치합니다.',
};

// 보드 정렬 우선순위 (낮을수록 위)
const GT_GROUP_SORT_RANK = {
  'BALANCED-GT': 1, 'LIGHT-GT': 2, 'MID-CAP-GT': 3,
  'MOM-RISK': 4, 'HEAVY-WATCH': 5, 'MICRO-RISK': 6, 'HEAVY-RISK': 7,
};

module.exports = {
  CONFIG,
  EXCLUDE_NAME_KEYWORDS,
  MARKET_CAP_BAND_LABEL,
  isPreferredShareName,
  isExcludedByName,
  passesHardFilter,
  classifyMarketCapBand,
  pickLatestBaseIdx,
  analyzeAt,
  scoreMetrics,
  classifyGroup,
  round,
  // v5 GT
  GT_BAND_LABEL,
  GT_GROUP_LABEL,
  GT_GROUP_DESC,
  GT_GROUP_SORT_RANK,
  classifyGtBand,
  classifyCandleType,
  countRecentSurges,
  classifyGtGroup,
};
