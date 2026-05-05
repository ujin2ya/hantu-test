#!/usr/bin/env node
/**
 * BMS Winner Quality Filter Report
 *
 * 목적:
 *   bms-winner-scan-result.json을 읽어 BMS 학습용으로 적합한 "정상 상승 사례"와
 *   제외해야 할 "특수/왜곡 사례"를 분리하는 보고서.
 *
 *   현재 후보 탐색은 하지 않음. 이번 단계의 목적은 오직 하나:
 *   "과거 크게 오른 종목 중 BMS가 배울 만한 정상 상승 사례만 추려낸다."
 *
 * 입력:
 *   reports/bms-winner-scan-result.json
 *
 * 출력:
 *   reports/bms-winner-quality-filter-result.json
 *   reports/bms-winner-quality-filter-result.html
 *
 * 처리 순서:
 *   1) 같은 종목 사례를 시간순으로 그룹화
 *   2) 종목당 "대표 사례" 1개 선택 — 가장 먼저 +40% 도달한 사례.
 *      단, 그 사례가 특수 의심이면 다음 사례로 fallback.
 *   3) 대표 사례를 정상 기준으로 검사:
 *      - 정상이면 등급 분류 (A/B/C)
 *      - 특수 의심이면 excluded 처리 + 사유
 *   4) 통계·요약·정상 사례 공통 조건 계산
 *
 *   특정 종목명을 직접 조건에 넣지 않음. 시장 전체에서 자동 선별.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const INPUT_PATH = path.join(REPORTS_DIR, 'bms-winner-scan-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.html');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  });
  return out;
})();

// ─────────────────────── CONFIG (모두 조정 가능) ───────────────────────

const CONFIG = {
  // 특수 케이스 의심 임계값
  EXCLUDE_FAST_DAYS: 2,
  EXCLUDE_FAST_RETURN: 100,            // 2일 이내 +100% 이상
  EXCLUDE_EXTREME_RETURN: 300,         // 어떤 기간이든 +300% 이상
  EXCLUDE_PRE_DAYS_MIN: 10,            // 준비 구간 최소 일수 (못 채우면 제외)
  EXCLUDE_BOX_RANGE_MAX: 80,           // 박스권 폭 80% 이상이면 제외
  EXCLUDE_LOW60_MAX: 150,              // 60일 저점 대비 +150% 이상이면 이미 너무 오른 뒤
  EXCLUDE_NEAR_52W_HIGH_THRESHOLD: -3, // closeFrom52WeekHigh ≥ -3% (즉 거의 신고가)이면 제외

  // 정상 사례 기본 기준
  NORMAL_HIGH_RETURN_MIN: 40,
  NORMAL_HIGH_RETURN_MAX: 150,
  NORMAL_CLOSE_RETURN_MIN: 25,         // 종가 +25%+ 권장 (필수는 아님)
  NORMAL_DAYS_TO_PEAK_MIN: 3,
  NORMAL_DAYS_TO_PEAK_MAX: 15,
  NORMAL_PRE_DAYS_MIN: 15,             // 준비 구간 최소 15일
  NORMAL_BOX_RANGE_MIN: 8,
  NORMAL_BOX_RANGE_MAX: 35,
  NORMAL_LOW60_MIN: 5,
  NORMAL_LOW60_MAX: 80,
  NORMAL_HIGH60_MIN: -40,
  NORMAL_HIGH60_MAX: 5,
  NORMAL_PRE_ACCUM_MIN_PCT: 3,         // 시총 대비 누적 ≥ 3%
  NORMAL_START_DAY_RATIO_MIN_PCT: 0.3, // 시총 대비 시작일 거래대금 ≥ 0.3%

  // A 등급 기준 (정상 사례 안에서)
  A_HIGH_RETURN_MIN: 40,
  A_HIGH_RETURN_MAX: 100,
  A_DAYS_MIN: 5,
  A_DAYS_MAX: 15,
  A_BOX_RANGE_MIN: 10,
  A_BOX_RANGE_MAX: 25,
  A_LOW60_MIN: 10,
  A_LOW60_MAX: 60,
  A_VALUE_SPIKE_MIN: 1.5,              // 평소보다 1.5배 이상
  A_PRE_ACCUM_MIN_PCT: 5,
  A_PRE_ACCUM_MAX_PCT: 80,
};

// 사용자 인자로 일부 오버라이드 가능 (예: --high-min=40 --high-max=120)
if (args['high-min']) CONFIG.NORMAL_HIGH_RETURN_MIN = parseFloat(args['high-min']);
if (args['high-max']) CONFIG.NORMAL_HIGH_RETURN_MAX = parseFloat(args['high-max']);

// ─────────────────────── 시총 대비 들어온 돈 구간 ───────────────────────
// bms-value-ratio-bucket-audit 결과를 단순 6구간으로 정리한 BMS 기본 해석.
// 등급(A/B/C) 로직은 그대로 유지하되, 0~5%/80%+ 구간만 A 강등 적용.
const VALUE_RATIO_GROUPS = [
  {
    key: 'insufficient_0_5', min: 0, max: 5,
    label: '유입 부족', role: 'BMS 제외/약함',
    explanation: '상승 전 들어온 돈이 시총 대비 5% 미만으로 매우 적은 사례입니다. BMS 정제 사례 중에서도 드물게 나타난 예외 구간으로, BMS 핵심으로 보기 어렵습니다.',
  },
  {
    key: 'support_5_10', min: 5, max: 10,
    label: '초기 유입 참고', role: 'BMS 보조',
    explanation: '상승 전 들어온 돈은 많지 않지만, 정석 사례가 일부 나온 초기 유입 구간입니다. 보조 참고용으로 둡니다.',
  },
  {
    key: 'core_10_20', min: 10, max: 20,
    label: '핵심 구간', role: 'BMS 핵심',
    explanation: '상승 전 20거래일 동안 시총 대비 10~20%의 거래대금이 지나간, BMS 정제 사례가 가장 많이 몰린 중심 구간입니다.',
  },
  {
    key: 'core_20_40', min: 20, max: 40,
    label: '강한 핵심 구간', role: 'BMS 핵심',
    explanation: '시총 대비 20~40%의 거래대금이 지나간 강한 유입 구간입니다. 평균 상승률이 가장 좋게 나타난 구간입니다.',
  },
  {
    key: 'caution_40_80', min: 40, max: 80,
    label: '거래 과다 주의', role: '주의',
    explanation: '상승 전 거래대금이 매우 많이 지나간 구간입니다. 움직임은 빠를 수 있지만 오른 뒤 흔들림도 커질 수 있습니다.',
  },
  {
    key: 'overheat_80_plus', min: 80, max: Infinity,
    label: '과열 가능', role: '강한 주의',
    explanation: '시총을 넘는 수준의 거래대금이 지나간 과열 가능 구간입니다. 빠르게 오를 수 있지만 흔들림이 크고 BMS 핵심으로 보기 어렵습니다.',
  },
];
const VALUE_RATIO_NO_DATA = {
  key: 'no_data',
  label: '데이터 없음', role: '판정 불가',
  explanation: '시총 또는 거래대금 데이터가 부족해 구간 판정이 불가능합니다.',
};

function assignValueRatioGroup(w) {
  const r = w.analysis?.preAccumulation?.accumulatedValueRatio;
  if (r == null || !isFinite(r)) {
    return {
      preAccumulationRatio: null,
      groupKey: VALUE_RATIO_NO_DATA.key,
      groupLabel: VALUE_RATIO_NO_DATA.label,
      groupRole: VALUE_RATIO_NO_DATA.role,
      explanation: VALUE_RATIO_NO_DATA.explanation,
    };
  }
  for (const g of VALUE_RATIO_GROUPS) {
    if (r >= g.min && r < g.max) {
      return {
        preAccumulationRatio: r,
        groupKey: g.key, groupLabel: g.label, groupRole: g.role,
        explanation: g.explanation,
      };
    }
  }
  return {
    preAccumulationRatio: r,
    groupKey: VALUE_RATIO_NO_DATA.key,
    groupLabel: VALUE_RATIO_NO_DATA.label,
    groupRole: VALUE_RATIO_NO_DATA.role,
    explanation: VALUE_RATIO_NO_DATA.explanation,
  };
}

// ─────────────────────── 정석/강한 BMS 핵심 조건 ───────────────────────
// bms-core-condition-overlap-audit 결과: 들어온 돈 + 가격 위치 두 조건만으로
// A+B(47%)와 C(13%) 사이에 3.65× 차별력을 확인. 단순 핵심 태그로 정제 보고서에 추가.
const CORE_CONDITION = {
  CLASSIC: {
    label: '정석 BMS 조건',
    description: '상승 전 거래대금이 적당히 지나갔고, 주가는 저점에서 어느 정도 회복했지만 아직 고점까지 공간이 남아 있는 조건입니다.',
    valueRatioMin: 5,  valueRatioMax: 40,
    low60Min: 10,      low60Max: 45,
    high60Min: -40,    high60Max: -10,
  },
  STRONG: {
    label: '강한 BMS 조건',
    description: '상승 전 거래대금이 BMS 중심 구간에 있고, 가격 위치도 저점 회복·고점 여유 조건에 들어오는 더 엄격한 조건입니다.',
    valueRatioMin: 10, valueRatioMax: 40,
    low60Min: 10,      low60Max: 45,
    high60Min: -40,    high60Max: -10,
  },
};

function checkRule(rule, vRatio, lf, hf) {
  const valueRatio = vRatio != null && isFinite(vRatio) && vRatio >= rule.valueRatioMin && vRatio <= rule.valueRatioMax;
  const lowPosition = lf != null && isFinite(lf) && lf >= rule.low60Min && lf <= rule.low60Max;
  const highPosition = hf != null && isFinite(hf) && hf >= rule.high60Min && hf <= rule.high60Max;
  return { valueRatio, lowPosition, highPosition, matches: valueRatio && lowPosition && highPosition };
}

function getFailedReasons(rule, vRatio, lf, hf) {
  const reasons = [];
  if (vRatio == null || !isFinite(vRatio)) reasons.push('데이터 부족 (들어온 돈)');
  else if (vRatio < rule.valueRatioMin) reasons.push(`들어온 돈 부족 (${vRatio}% < ${rule.valueRatioMin}%)`);
  else if (vRatio > rule.valueRatioMax) reasons.push(`들어온 돈 과다 (${vRatio}% > ${rule.valueRatioMax}%)`);

  if (lf == null || !isFinite(lf)) reasons.push('데이터 부족 (저점 대비)');
  else if (lf < rule.low60Min) reasons.push(`저점 대비 너무 낮음 (+${lf}% < +${rule.low60Min}%)`);
  else if (lf > rule.low60Max) reasons.push(`저점 대비 너무 높음 (+${lf}% > +${rule.low60Max}%)`);

  if (hf == null || !isFinite(hf)) reasons.push('데이터 부족 (고점 대비)');
  else if (hf < rule.high60Min) reasons.push(`고점과 너무 멂 (${hf}% < ${rule.high60Min}%)`);
  else if (hf > rule.high60Max) reasons.push(`고점 근처 (${hf}% > ${rule.high60Max}%)`);
  return reasons;
}

// 라벨/역할 (사용자 요구 우선순위)
function buildCoreLabel(c) {
  if (c.matchesStrongBms) {
    return { label: '강한 BMS 조건 만족', role: '강한 핵심 조건', explanation: '시총 대비 들어온 돈과 가격 위치가 모두 강한 BMS 조건에 들어온 사례입니다.' };
  }
  if (c.matchesClassicBms) {
    return { label: '정석 BMS 조건 만족', role: '핵심 조건', explanation: '상승 전 거래대금과 가격 위치가 정석 BMS 조건에 들어온 사례입니다.' };
  }
  const v = c.classicPass.valueRatio;
  const l = c.classicPass.lowPosition;
  const h = c.classicPass.highPosition;
  const vR = c.preAccumulationRatio;
  const lf = c.closeFromLow60;
  const hf = c.closeFromHigh60;

  // 가격 위치 둘 다 통과 + 들어온 돈만 부족 (5% 미만)
  if (l && h && vR != null && vR < CORE_CONDITION.CLASSIC.valueRatioMin) {
    return { label: '가격은 좋지만 들어온 돈 부족', role: '일부 조건만 만족', explanation: '저점 회복과 고점까지의 공간은 좋지만, 상승 전 시총 대비 거래대금이 부족했던 사례입니다.' };
  }
  // 들어온 돈은 정석 안에 있는데 가격 위치 일부 이탈
  if (v && (!l || !h)) {
    return { label: '들어온 돈은 좋지만 가격 위치 이탈', role: '일부 조건만 만족', explanation: '상승 전 거래대금은 적당히 지나갔지만, 가격 위치가 정석 BMS 조건에서 벗어난 사례입니다.' };
  }
  // 거래 과다 주의 (40% 초과)
  if (vR != null && vR > CORE_CONDITION.CLASSIC.valueRatioMax) {
    return { label: '거래 과다 주의', role: '주의', explanation: '상승 전 거래대금이 너무 많이 지나간 구간입니다. 빠르게 움직일 수 있지만 오른 뒤 흔들림이 커질 수 있습니다.' };
  }
  // 저점 근처 힘 확인 부족 (저점 대비 < 10)
  if (lf != null && lf < CORE_CONDITION.CLASSIC.low60Min) {
    return { label: '저점 근처 힘 확인 부족', role: '주의', explanation: '상승 시작점이 아직 저점 근처라 힘이 충분히 확인되지 않은 사례입니다.' };
  }
  // 고점 근처 주의 (고점 대비 > -10)
  if (hf != null && hf > CORE_CONDITION.CLASSIC.high60Max) {
    return { label: '고점 근처 주의', role: '주의', explanation: '상승 시작점이 최근 고점에 가까워 추격 위험이나 흔들림이 커질 수 있는 사례입니다.' };
  }
  return { label: '조건 미충족', role: '조건 외', explanation: '정석 BMS 조건에는 들어오지 않는 사례입니다.' };
}

// 라벨 → labelSummary key 매핑
function labelKeyOf(label) {
  if (label === '강한 BMS 조건 만족') return 'strongCore';
  if (label === '정석 BMS 조건 만족') return 'classicCore';
  if (label === '가격은 좋지만 들어온 돈 부족') return 'goodPriceLowValue';
  if (label === '들어온 돈은 좋지만 가격 위치 이탈') return 'goodValueBadPrice';
  if (label === '거래 과다 주의') return 'overValueCaution';
  if (label === '저점 근처 힘 확인 부족') return 'lowBaseWeak';
  if (label === '고점 근처 주의') return 'nearHighCaution';
  return 'noMatch';
}

function computeCoreCondition(w) {
  const a = w.analysis || {};
  const vRatio = a.preAccumulation?.accumulatedValueRatio;
  const lf = a.pricePosition?.closeFromLow60;
  const hf = a.pricePosition?.closeFromHigh60;
  const classicPass = checkRule(CORE_CONDITION.CLASSIC, vRatio, lf, hf);
  const strongPass = checkRule(CORE_CONDITION.STRONG, vRatio, lf, hf);
  const c = {
    preAccumulationRatio: vRatio,
    closeFromLow60: lf,
    closeFromHigh60: hf,
    matchesClassicBms: classicPass.matches,
    matchesStrongBms: strongPass.matches,
    classicPass: { valueRatio: classicPass.valueRatio, lowPosition: classicPass.lowPosition, highPosition: classicPass.highPosition },
    strongPass: { valueRatio: strongPass.valueRatio, lowPosition: strongPass.lowPosition, highPosition: strongPass.highPosition },
    failedClassicReasons: classicPass.matches ? [] : getFailedReasons(CORE_CONDITION.CLASSIC, vRatio, lf, hf),
    failedStrongReasons: strongPass.matches ? [] : getFailedReasons(CORE_CONDITION.STRONG, vRatio, lf, hf),
  };
  const lbl = buildCoreLabel(c);
  c.conditionLabel = lbl.label;
  c.conditionRole = lbl.role;
  c.explanation = lbl.explanation;
  c.labelKey = labelKeyOf(lbl.label);
  return c;
}

// ─────────────────────── 헬퍼 ───────────────────────

function round(v, d) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function pct(num, den) { if (!den || den === 0) return null; return round(num / den * 100, 2); }
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function avg(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  if (v.length === 0) return null;
  return round(v.reduce((s, x) => s + x, 0) / v.length, 2);
}

// ─────────────────────── 특수 케이스 의심 검사 ───────────────────────

function checkExclusionFlags(w) {
  const flags = [];
  const a = w.analysis || {};
  const pa = a.preAccumulation || {};
  const ba = a.boxAnalysis || {};
  const pp = a.pricePosition || {};
  const ma = a.movingAverage || {};
  const sz = a.supplyZone || {};

  // 너무 빠른 폭등
  if (w.daysToPeak <= CONFIG.EXCLUDE_FAST_DAYS && (w.maxHighReturn || 0) >= CONFIG.EXCLUDE_FAST_RETURN) {
    flags.push('너무 빠른 폭등 (' + CONFIG.EXCLUDE_FAST_DAYS + '일 이내 +' + CONFIG.EXCLUDE_FAST_RETURN + '%↑)');
  }
  // 비정상 폭등
  if ((w.maxHighReturn || 0) >= CONFIG.EXCLUDE_EXTREME_RETURN) {
    flags.push('비정상 폭등 (+' + CONFIG.EXCLUDE_EXTREME_RETURN + '% 이상)');
  }
  // 준비 구간 데이터 부족
  if ((pa.days || 0) < CONFIG.EXCLUDE_PRE_DAYS_MIN) {
    flags.push('상승 전 준비 구간 데이터 부족 (' + (pa.days || 0) + '일)');
  }
  // 거래대금 0 또는 데이터 이상
  if ((pa.avgPreValue || 0) === 0) {
    flags.push('상승 전 거래대금 거의 0 (거래 없다가 튄 사례)');
  }
  if ((pa.startDayValue || 0) === 0) {
    flags.push('상승 시작일 거래대금 0 (데이터 이상)');
  }
  // 박스권 폭 너무 넓음
  if (ba.boxRangePct != null && ba.boxRangePct >= CONFIG.EXCLUDE_BOX_RANGE_MAX) {
    flags.push('박스권 폭이 너무 넓음 (≥' + CONFIG.EXCLUDE_BOX_RANGE_MAX + '%)');
  }
  // 이미 너무 오른 뒤
  if (pp.closeFromLow60 != null && pp.closeFromLow60 >= CONFIG.EXCLUDE_LOW60_MAX) {
    flags.push('이미 60일 저점 대비 +' + CONFIG.EXCLUDE_LOW60_MAX + '% 이상 위');
  }
  // 52주 신고가 근처
  if (pp.closeFrom52WeekHigh != null && pp.closeFrom52WeekHigh >= CONFIG.EXCLUDE_NEAR_52W_HIGH_THRESHOLD) {
    flags.push('이미 52주 신고가 근처에서 시작');
  }
  // 이평선 데이터 부족 (60일선만 필수, 120일선은 차트 길이 한계로 자주 없음 → 별도 표기만)
  if (!ma.ma60) {
    flags.push('이평선 데이터 부족 (60일선 없음 — startIdx가 차트 앞쪽)');
  }
  // 박스권 데이터 부족 (정상 검사에서 박스권 폭 null로 자동 컷 → 여기선 정보 플래그만)
  if (ba.dataLimit) flags.push('박스권 데이터 부족 (계산 불가)');
  // 매물대 데이터 부족 (위쪽 매물 분석 한계만 표기)
  // → 매물대만 부족하다고 학습에서 빼는 건 과도. 제외 사유에서 빼고 정보로만 둠.
  // if (sz.dataLimit) flags.push('매물대 데이터 부족');

  return flags;
}

// ─────────────────────── 정상 사례 기준 ───────────────────────

function isNormalCase(w) {
  const a = w.analysis || {};
  const pa = a.preAccumulation || {};
  const ba = a.boxAnalysis || {};
  const pp = a.pricePosition || {};

  if (!(w.maxHighReturn >= CONFIG.NORMAL_HIGH_RETURN_MIN && w.maxHighReturn <= CONFIG.NORMAL_HIGH_RETURN_MAX)) return false;
  if (!(w.daysToPeak >= CONFIG.NORMAL_DAYS_TO_PEAK_MIN && w.daysToPeak <= CONFIG.NORMAL_DAYS_TO_PEAK_MAX)) return false;
  if ((pa.days || 0) < CONFIG.NORMAL_PRE_DAYS_MIN) return false;

  const boxR = ba.boxRangePct;
  if (boxR == null || boxR < CONFIG.NORMAL_BOX_RANGE_MIN || boxR > CONFIG.NORMAL_BOX_RANGE_MAX) return false;

  const low60 = pp.closeFromLow60;
  if (low60 == null || low60 < CONFIG.NORMAL_LOW60_MIN || low60 > CONFIG.NORMAL_LOW60_MAX) return false;

  const high60 = pp.closeFromHigh60;
  if (high60 == null || high60 < CONFIG.NORMAL_HIGH60_MIN || high60 > CONFIG.NORMAL_HIGH60_MAX) return false;

  if ((pa.startDayValue || 0) <= 0) return false;
  if ((pa.accumulatedValueRatio || 0) < CONFIG.NORMAL_PRE_ACCUM_MIN_PCT) return false;
  if ((pa.startDayValueRatio || 0) < CONFIG.NORMAL_START_DAY_RATIO_MIN_PCT) return false;

  return true;
}

// ─────────────────────── 등급 분류 ───────────────────────

function classifyGrade(w) {
  const a = w.analysis || {};
  const pa = a.preAccumulation || {};
  const ba = a.boxAnalysis || {};
  const pp = a.pricePosition || {};

  const isA = (
    w.maxHighReturn >= CONFIG.A_HIGH_RETURN_MIN && w.maxHighReturn <= CONFIG.A_HIGH_RETURN_MAX
    && w.daysToPeak >= CONFIG.A_DAYS_MIN && w.daysToPeak <= CONFIG.A_DAYS_MAX
    && ba.boxRangePct != null && ba.boxRangePct >= CONFIG.A_BOX_RANGE_MIN && ba.boxRangePct <= CONFIG.A_BOX_RANGE_MAX
    && pp.closeFromLow60 != null && pp.closeFromLow60 >= CONFIG.A_LOW60_MIN && pp.closeFromLow60 <= CONFIG.A_LOW60_MAX
    && (pa.valueSpikeRatio || 0) >= CONFIG.A_VALUE_SPIKE_MIN
    && (pa.accumulatedValueRatio || 0) >= CONFIG.A_PRE_ACCUM_MIN_PCT
    && (pa.accumulatedValueRatio || 0) <= CONFIG.A_PRE_ACCUM_MAX_PCT
  );
  if (isA) return 'A';

  // 정상 통과했지만 A는 아님 → B/C
  // B = NORMAL 기본 기준 그대로 (이미 통과한 상태)
  // C = NORMAL을 일부 못 만족하지만 살릴만한 케이스 — 이번 함수는 NORMAL 통과 후 호출되므로 사실상 B 이상
  // C를 만들려면 NORMAL 기준을 살짝 완화해야. 별도 isLooseCase로 처리.
  return 'B';
}

// 정상 기준 살짝 완화 (C 등급 후보)
function isLooseCase(w) {
  const a = w.analysis || {};
  const pa = a.preAccumulation || {};
  const ba = a.boxAnalysis || {};
  const pp = a.pricePosition || {};

  // 너무 빠르거나 박스 넓거나 데이터 일부 부족하지만 완전 제외는 아님
  if (!(w.maxHighReturn >= 40 && w.maxHighReturn <= 200)) return false;
  if (!(w.daysToPeak >= 2 && w.daysToPeak <= 15)) return false;
  if ((pa.days || 0) < 10) return false;
  if ((pa.startDayValue || 0) <= 0) return false;
  if (pp.closeFrom52WeekHigh != null && pp.closeFrom52WeekHigh >= -3) return false;
  if (ba.boxRangePct != null && ba.boxRangePct >= 60) return false;     // 박스 60%까지 허용
  return true;
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Winner Quality Filter Report');
  console.log('═'.repeat(80));

  if (!fs.existsSync(INPUT_PATH)) {
    console.error('입력 없음:', INPUT_PATH);
    console.error('먼저 `node bms-winner-scan-report.js` 실행 필요');
    process.exit(1);
  }

  const src = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const winners = src.winners || [];
  console.log(`원본 사례: ${winners.length}건`);

  // 1) 종목별 그룹화 (시간순)
  const byCode = new Map();
  winners.forEach(w => {
    if (!byCode.has(w.code)) byCode.set(w.code, []);
    byCode.get(w.code).push(w);
  });
  byCode.forEach(arr => arr.sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '')));
  const uniqueStockCount = byCode.size;
  console.log(`중복 제거 후 종목: ${uniqueStockCount}개`);

  // 2) 종목당 대표 사례 선택
  // 첫 사례가 특수 의심이면 다음 정상으로 fallback
  const representatives = [];
  const skipped = [];        // 종목 안에서 대표가 아닌 사례 (중복 redundant)
  byCode.forEach((arr, code) => {
    let chosen = null;
    let chosenReason = null;
    for (const w of arr) {
      const flags = checkExclusionFlags(w);
      if (flags.length === 0) {
        chosen = w;
        chosenReason = '가장 먼저 +40% 달성한 정상 사례';
        break;
      }
    }
    if (!chosen) {
      // 모두 특수 의심 → 첫 사례 대표로 두되 excluded 처리
      chosen = arr[0];
      chosenReason = '같은 종목 모든 사례가 특수 케이스 의심 (첫 사례 대표)';
    }
    chosen._chosenReason = chosenReason;
    representatives.push(chosen);
    arr.forEach(w => { if (w !== chosen) skipped.push({ ...w, _skipReason: '같은 종목 대표 사례 외' }); });
  });

  // 3) 대표 사례 분류
  const cleanWinners = [];   // A/B/C
  const excludedWinners = []; // 제외 사유 + 사례

  representatives.forEach(w => {
    const flags = checkExclusionFlags(w);
    if (flags.length > 0) {
      excludedWinners.push({ ...w, _exclusionFlags: flags });
      return;
    }
    if (isNormalCase(w)) {
      const grade = classifyGrade(w);
      cleanWinners.push({ ...w, _grade: grade });
    } else if (isLooseCase(w)) {
      cleanWinners.push({ ...w, _grade: 'C' });
    } else {
      excludedWinners.push({ ...w, _exclusionFlags: ['정상 기준에서 일부 항목 미달 (Loose도 안 됨)'] });
    }
  });

  // 3-1) 시총 대비 상승 전 들어온 돈 구간 태그
  // bms-value-ratio-bucket-audit 결과 기준: 10~40% = BMS 핵심, 5~10% = 보조, 40%+ = 주의, 0~5% = 약함
  // 등급 로직은 그대로 두되 0~5% / 80%+ 만 A 등급에서 B로 강등 (핵심 구간 밖이라).
  let demotedFromA = 0;
  cleanWinners.forEach(w => {
    w.valueRatioGroup = assignValueRatioGroup(w);
    if (w._grade === 'A' && (w.valueRatioGroup.groupKey === 'insufficient_0_5' || w.valueRatioGroup.groupKey === 'overheat_80_plus')) {
      w._grade = 'B';
      w._gradeAdjustReason = '시총 대비 상승 전 들어온 돈이 BMS 핵심 구간 밖(' + w.valueRatioGroup.groupLabel + ')이라 B등급으로 조정';
      demotedFromA++;
    }
    // BMS 핵심 조건 태그 — 등급/점수에 영향 주지 않고 분류 라벨만 추가
    w.coreCondition = computeCoreCondition(w);
  });

  // 정렬: cleanWinners는 grade(A>B>C) → maxHighReturn 내림차순
  const gradeOrder = { A: 1, B: 2, C: 3 };
  cleanWinners.sort((a, b) => {
    const ga = gradeOrder[a._grade] || 9;
    const gb = gradeOrder[b._grade] || 9;
    if (ga !== gb) return ga - gb;
    return (b.maxHighReturn || 0) - (a.maxHighReturn || 0);
  });
  excludedWinners.sort((a, b) => (b.maxHighReturn || 0) - (a.maxHighReturn || 0));

  // 4) 통계
  const gradeCount = { A: 0, B: 0, C: 0 };
  cleanWinners.forEach(w => { gradeCount[w._grade]++; });

  // 제외 사유 집계
  const exclusionReasonCount = new Map();
  excludedWinners.forEach(w => {
    (w._exclusionFlags || []).forEach(f => {
      exclusionReasonCount.set(f, (exclusionReasonCount.get(f) || 0) + 1);
    });
  });
  const exclusionReasonSummary = [...exclusionReasonCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));

  // 정상 사례 (A+B) 공통 조건
  const ab = cleanWinners.filter(w => w._grade === 'A' || w._grade === 'B');
  const patternSummary = computePatternSummary(ab);

  // 전체 정상 (A+B+C) 평균
  const allCleanSummary = computePatternSummary(cleanWinners);

  // 요약
  const summary = {
    sourceTotalCount: winners.length,
    uniqueStockCount,
    representativeCount: representatives.length,
    skippedDuplicateCount: skipped.length,
    cleanCount: cleanWinners.length,
    excludedCount: excludedWinners.length,
    excludedRate: pct(excludedWinners.length, representatives.length),
    gradeACount: gradeCount.A,
    gradeBCount: gradeCount.B,
    gradeCCount: gradeCount.C,
    avgMaxHighReturn: avg(cleanWinners.map(w => w.maxHighReturn)),
    medMaxHighReturn: round(median(cleanWinners.map(w => w.maxHighReturn).filter(v => v != null)), 2),
    avgDaysToPeak: avg(cleanWinners.map(w => w.daysToPeak)),
    avgPreAccumulationRatio: avg(cleanWinners.map(w => w.analysis?.preAccumulation?.accumulatedValueRatio)),
    avgBoxRangePct: avg(cleanWinners.map(w => w.analysis?.boxAnalysis?.boxRangePct)),
  };

  // 콘솔 요약
  console.log('\n📊 정리 결과:');
  console.log(`  원본 사례: ${summary.sourceTotalCount}건`);
  console.log(`  중복 제거 후 종목: ${uniqueStockCount}개`);
  console.log(`  중복 사례 제외: ${summary.skippedDuplicateCount}건`);
  console.log(`  정상 사례: ${summary.cleanCount}건 (A=${gradeCount.A} / B=${gradeCount.B} / C=${gradeCount.C})`);
  console.log(`  제외 사례: ${summary.excludedCount}건 (제외율 ${summary.excludedRate}%)`);
  console.log(`  정상 평균 상승률: ${summary.avgMaxHighReturn}%`);
  console.log(`  정상 평균 도달 소요: ${summary.avgDaysToPeak}일`);
  console.log(`  정상 평균 시총 대비 들어온 돈: ${summary.avgPreAccumulationRatio}%`);
  console.log(`  정상 평균 박스권 폭: ${summary.avgBoxRangePct}%`);

  console.log('\n🚫 제외 사유 TOP 10:');
  exclusionReasonSummary.slice(0, 10).forEach(({ reason, count }) => {
    console.log(`  ${count.toString().padStart(4)}건  ${reason}`);
  });

  console.log('\n🔬 A+B 등급 공통 조건 (학습용):');
  Object.entries(patternSummary).slice(0, 16).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(36)} ${JSON.stringify(v)}`);
  });

  // 4-1) 시총 대비 들어온 돈 구간 요약
  const valueRatioGroupSummary = {};
  [...VALUE_RATIO_GROUPS, VALUE_RATIO_NO_DATA].forEach(g => {
    const items = cleanWinners.filter(w => w.valueRatioGroup?.groupKey === g.key);
    const high = items.map(w => w.maxHighReturn);
    const close = items.map(w => w.maxCloseReturn);
    const days = items.map(w => w.daysToPeak);
    const drawdown = items.map(w => w.analysis?.postAnalysis?.drawdownFromPeakClose);
    const aCount = items.filter(w => w._grade === 'A').length;
    const bCount = items.filter(w => w._grade === 'B').length;
    const cCount = items.filter(w => w._grade === 'C').length;
    valueRatioGroupSummary[g.key] = {
      label: g.label,
      role: g.role,
      explanation: g.explanation,
      count: items.length,
      rate: pct(items.length, cleanWinners.length),
      avgHighReturn: avg(high),
      medHighReturn: round(median(high.filter(v => v != null)), 2),
      avgCloseReturn: avg(close),
      avgDaysToPeak: avg(days),
      avgDrawdown: avg(drawdown),
      gradeACount: aCount,
      gradeBCount: bCount,
      gradeCCount: cCount,
    };
  });

  // 화면 단순 카운트 (타일용)
  const valueRatioRoleCount = {
    core: cleanWinners.filter(w => w.valueRatioGroup?.groupRole === 'BMS 핵심').length,
    support: cleanWinners.filter(w => w.valueRatioGroup?.groupRole === 'BMS 보조').length,
    caution: cleanWinners.filter(w => w.valueRatioGroup?.groupRole === '주의').length,
    overheat: cleanWinners.filter(w => w.valueRatioGroup?.groupRole === '강한 주의').length,
    insufficient: cleanWinners.filter(w => w.valueRatioGroup?.groupRole === 'BMS 제외/약함').length,
    noData: cleanWinners.filter(w => w.valueRatioGroup?.groupRole === '판정 불가').length,
  };

  console.log(`\n💰 시총 대비 상승 전 들어온 돈 구간 분포:`);
  Object.entries(valueRatioGroupSummary).forEach(([k, v]) => {
    if (!v.count) return;
    console.log(`  ${v.label.padEnd(14)} (${k.padEnd(18)}) n=${String(v.count).padStart(4)} ${String(v.rate + '%').padStart(7)} 평균 +${v.avgHighReturn}% / 종가 +${v.avgCloseReturn}% / 소요 ${v.avgDaysToPeak}일 / 하락 ${v.avgDrawdown}% / A=${v.gradeACount} B=${v.gradeBCount} C=${v.gradeCCount}`);
  });
  if (demotedFromA > 0) {
    console.log(`  (참고) 0~5% / 80%+ 구간이라 A→B 강등된 사례: ${demotedFromA}건`);
  }

  // 4-2) BMS 핵심 조건 (정석/강한) 태그 요약
  function summarizeCondition(items) {
    if (!items || items.length === 0) {
      return { count: 0, rate: null, avgHighReturn: null, avgCloseReturn: null, avgDaysToPeak: null, avgDrawdown: null };
    }
    return {
      count: items.length,
      rate: pct(items.length, cleanWinners.length),
      avgHighReturn: avg(items.map(w => w.maxHighReturn)),
      avgCloseReturn: avg(items.map(w => w.maxCloseReturn)),
      avgDaysToPeak: avg(items.map(w => w.daysToPeak)),
      avgDrawdown: avg(items.map(w => w.analysis?.postAnalysis?.drawdownFromPeakClose)),
    };
  }

  const classicMatchAll = cleanWinners.filter(w => w.coreCondition.matchesClassicBms);
  const classicMissAll = cleanWinners.filter(w => !w.coreCondition.matchesClassicBms);
  const strongMatchAll = cleanWinners.filter(w => w.coreCondition.matchesStrongBms);
  const strongMissAll = cleanWinners.filter(w => !w.coreCondition.matchesStrongBms);

  function gradeBlock(grade) {
    const g = cleanWinners.filter(w => w._grade === grade);
    const cm = g.filter(w => w.coreCondition.matchesClassicBms);
    const sm = g.filter(w => w.coreCondition.matchesStrongBms);
    return {
      count: g.length,
      classicMatchCount: cm.length,
      classicMatchRate: pct(cm.length, g.length),
      strongMatchCount: sm.length,
      strongMatchRate: pct(sm.length, g.length),
    };
  }

  const labelKeys = ['strongCore', 'classicCore', 'goodPriceLowValue', 'goodValueBadPrice', 'overValueCaution', 'lowBaseWeak', 'nearHighCaution', 'noMatch'];
  const labelMeta = {
    strongCore: { label: '강한 BMS 조건 만족', role: '강한 핵심 조건' },
    classicCore: { label: '정석 BMS 조건 만족', role: '핵심 조건' },
    goodPriceLowValue: { label: '가격은 좋지만 들어온 돈 부족', role: '일부 조건만 만족' },
    goodValueBadPrice: { label: '들어온 돈은 좋지만 가격 위치 이탈', role: '일부 조건만 만족' },
    overValueCaution: { label: '거래 과다 주의', role: '주의' },
    lowBaseWeak: { label: '저점 근처 힘 확인 부족', role: '주의' },
    nearHighCaution: { label: '고점 근처 주의', role: '주의' },
    noMatch: { label: '조건 미충족', role: '조건 외' },
  };
  const labelSummary = {};
  labelKeys.forEach(k => {
    const items = cleanWinners.filter(w => w.coreCondition.labelKey === k);
    labelSummary[k] = { ...labelMeta[k], ...summarizeCondition(items) };
  });

  const coreConditionSummary = {
    classic: {
      total: cleanWinners.length,
      ...summarizeCondition(classicMatchAll),
      missSummary: summarizeCondition(classicMissAll),
    },
    strong: {
      total: cleanWinners.length,
      ...summarizeCondition(strongMatchAll),
      missSummary: summarizeCondition(strongMissAll),
    },
    byGrade: {
      A: gradeBlock('A'),
      B: gradeBlock('B'),
      C: gradeBlock('C'),
    },
    labelSummary,
    definitions: {
      classic: {
        label: CORE_CONDITION.CLASSIC.label,
        description: CORE_CONDITION.CLASSIC.description,
        rule: '들어온 돈 ' + CORE_CONDITION.CLASSIC.valueRatioMin + '~' + CORE_CONDITION.CLASSIC.valueRatioMax + '% AND 저점 +' + CORE_CONDITION.CLASSIC.low60Min + '~+' + CORE_CONDITION.CLASSIC.low60Max + '% AND 고점 ' + CORE_CONDITION.CLASSIC.high60Min + '~' + CORE_CONDITION.CLASSIC.high60Max + '%',
      },
      strong: {
        label: CORE_CONDITION.STRONG.label,
        description: CORE_CONDITION.STRONG.description,
        rule: '들어온 돈 ' + CORE_CONDITION.STRONG.valueRatioMin + '~' + CORE_CONDITION.STRONG.valueRatioMax + '% AND 저점 +' + CORE_CONDITION.STRONG.low60Min + '~+' + CORE_CONDITION.STRONG.low60Max + '% AND 고점 ' + CORE_CONDITION.STRONG.high60Min + '~' + CORE_CONDITION.STRONG.high60Max + '%',
      },
    },
  };

  console.log(`\n🎯 BMS 핵심 조건 태그:`);
  console.log(`  정석 BMS 조건 만족: ${classicMatchAll.length}건 (${coreConditionSummary.classic.rate}%) — 평균 +${coreConditionSummary.classic.avgHighReturn}% / 흔들림 ${coreConditionSummary.classic.avgDrawdown}%`);
  console.log(`  강한 BMS 조건 만족: ${strongMatchAll.length}건 (${coreConditionSummary.strong.rate}%) — 평균 +${coreConditionSummary.strong.avgHighReturn}% / 흔들림 ${coreConditionSummary.strong.avgDrawdown}%`);
  console.log(`  등급별 정석 만족률: A=${coreConditionSummary.byGrade.A.classicMatchRate}% / B=${coreConditionSummary.byGrade.B.classicMatchRate}% / C=${coreConditionSummary.byGrade.C.classicMatchRate}%`);
  console.log(`  등급별 강한 만족률: A=${coreConditionSummary.byGrade.A.strongMatchRate}% / B=${coreConditionSummary.byGrade.B.strongMatchRate}% / C=${coreConditionSummary.byGrade.C.strongMatchRate}%`);
  console.log(`  라벨 분포:`);
  labelKeys.forEach(k => {
    const v = labelSummary[k];
    if (!v.count) return;
    console.log(`    ${v.label.padEnd(28)} ${String(v.count).padStart(4)}건 (${v.rate}%) 평균 +${v.avgHighReturn}% / 흔들림 ${v.avgDrawdown}%`);
  });

  // 5) 출력
  const out = {
    meta: {
      version: 'bms-winner-quality-filter-v1',
      generatedAt: new Date().toISOString(),
      title: 'BMS 학습용 정상 상승 사례 정리 보고서',
      purpose: '과거 +40% 사례 중 BMS가 배울 만한 정상 상승 사례만 추려낸다. 너무 빠른 폭등·신고가 근처·데이터 부족·박스권 너무 넓음 등 특수 케이스를 제외. 각 사례의 시총 대비 상승 전 들어온 돈을 6구간(유입 부족/초기 유입/핵심/강한 핵심/거래 과다/과열)으로 태그한다.',
      nextStep: 'BMS 본체는 winner-scan + winner-quality-filter 2단계로 단순하게 유지. 시총 대비 들어온 돈 구간별 성격은 별도 감사 보고서(/bms-value-ratio-audit)에서 확인.',
      inputFile: 'reports/bms-winner-scan-result.json',
      valueRatioBuckets: 'BMS 핵심: 10~40% / 보조: 5~10% / 주의: 40% 이상 / 약함: 5% 미만',
    },
    config: CONFIG,
    summary,
    gradeSummary: {
      A: { count: gradeCount.A, label: '가장 참고하기 좋은 상승 사례' },
      B: { count: gradeCount.B, label: '참고 가능한 상승 사례' },
      C: { count: gradeCount.C, label: '참고만 할 사례' },
      excluded: { count: excludedWinners.length, label: '학습에 쓰면 안 되는 사례' },
    },
    exclusionReasonSummary,
    valueRatioGroupSummary,
    valueRatioRoleCount,
    valueRatioGradeAdjustment: {
      demotedFromA,
      reason: '0~5% (유입 부족) 또는 80%+ (과열 가능) 구간은 BMS 핵심 구간 밖이라 A 등급에서 B로 조정',
    },
    coreConditionSummary,
    cleanWinners,
    excludedWinners,
    duplicateSummary: {
      uniqueStockCount,
      sourceTotalCount: winners.length,
      skippedDuplicateCount: skipped.length,
    },
    patternSummary,
    allCleanSummary,
    dataLimit: [
      '시총 대비 상승 전 들어온 돈은 순매수금액이 아니라 거래대금 기준입니다. 실제 매수금액과 매도금액이 분리된 데이터가 없으므로, 이 값은 매집 확정 지표가 아니라 상승 전 시장에서 돈이 얼마나 지나갔는지를 보는 참고 지표입니다.',
      '가격 위치는 최근 60거래일 고점/저점 기준입니다.',
      '정석 BMS 조건은 과거 상승 사례에서 의미 있게 나타난 조건 조합입니다. 다만 현재 후보 선별 조건으로 바로 확정한 것은 아니며, 매수 신호가 아닙니다.',
      '시총 데이터가 없거나 0인 종목은 구간 판정이 불가능해 "데이터 없음"으로 분류됩니다.',
      '이 보고서는 매수 신호가 아니라 BMS 학습용 정상 상승 사례를 추리는 정제 보고서입니다.',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length/1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length/1024).toFixed(0)}KB)`);
}

function computePatternSummary(winners) {
  if (winners.length === 0) return { count: 0 };
  const get = (path) => winners.map(w => {
    const parts = path.split('.');
    let v = w;
    for (const p of parts) v = v?.[p];
    return v;
  }).filter(v => v != null && isFinite(v));

  const ma20Above = winners.filter(w => w.analysis?.movingAverage?.aboveMa20 === true).length;
  const ma60Above = winners.filter(w => w.analysis?.movingAverage?.aboveMa60 === true).length;
  const ma120Above = winners.filter(w => w.analysis?.movingAverage?.aboveMa120 === true).length;
  const shortRecovery = winners.filter(w => w.analysis?.movingAverage?.arrangement === 'SHORT_RECOVERY').length;

  return {
    count: winners.length,
    avgMaxHighReturn: avg(get('maxHighReturn')),
    medMaxHighReturn: round(median(get('maxHighReturn')), 2),
    avgMaxCloseReturn: avg(get('maxCloseReturn')),
    avgDaysToPeak: avg(get('daysToPeak')),
    avgPreAccumulationRatio: avg(get('analysis.preAccumulation.accumulatedValueRatio')),
    avgStartDayValueRatio: avg(get('analysis.preAccumulation.startDayValueRatio')),
    avgValueSpikeRatio: avg(get('analysis.preAccumulation.valueSpikeRatio')),
    avgBoxRangeDays: avg(get('analysis.boxAnalysis.boxRangeDays')),
    avgBoxRangePct: avg(get('analysis.boxAnalysis.boxRangePct')),
    avgBreakoutValueRatio: avg(get('analysis.boxAnalysis.breakoutValueRatio')),
    avgSupplyAboveRatio: avg(get('analysis.supplyZone.aboveCloseRatio')),
    avgCloseFromLow60: avg(get('analysis.pricePosition.closeFromLow60')),
    avgCloseFromHigh60: avg(get('analysis.pricePosition.closeFromHigh60')),
    avgCloseFrom52WeekHigh: avg(get('analysis.pricePosition.closeFrom52WeekHigh')),
    aboveMa20Pct: pct(ma20Above, winners.length),
    aboveMa60Pct: pct(ma60Above, winners.length),
    aboveMa120Pct: pct(ma120Above, winners.length),
    shortRecoveryPct: pct(shortRecovery, winners.length),
  };
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>BMS 학습용 정상 상승 사례 정리 보고서</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1400px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
  -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 14px 0 8px; color: #94a3b8; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 18px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-top: 3px; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; line-height: 1.4; }
.big-tile.A { border-left: 4px solid #10b981; }
.big-tile.A .value { color: #6ee7b7; }
.big-tile.B { border-left: 4px solid #3b82f6; }
.big-tile.B .value { color: #93c5fd; }
.big-tile.C { border-left: 4px solid #fbbf24; }
.big-tile.C .value { color: #fde047; }
.big-tile.excluded { border-left: 4px solid #ef4444; }
.big-tile.excluded .value { color: #fca5a5; }
.big-tile.primary { border-left: 4px solid #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }

.tabs { display: flex; gap: 6px; margin: 18px 0 8px; flex-wrap: wrap; }
.tab-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-weight: 500; }
.tab-btn:hover { color: #f1f5f9; border-color: #64748b; }
.tab-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }
.tab-btn.A.active { background: #047857; border-color: #10b981; }
.tab-btn.B.active { background: #1e40af; border-color: #3b82f6; }
.tab-btn.C.active { background: #92400e; border-color: #fbbf24; }
.tab-btn.excluded.active { background: #991b1b; border-color: #ef4444; }

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
table.list tbody tr.row td.col-name .grade-badge { display: inline-block; padding: 1px 6px; margin-right: 6px; border-radius: 4px; font-size: 10px; font-weight: 700; vertical-align: 1px; }
table.list tbody tr.row td.col-name .grade-A { background: #047857; color: #d1fae5; }
table.list tbody tr.row td.col-name .grade-B { background: #1e40af; color: #dbeafe; }
table.list tbody tr.row td.col-name .grade-C { background: #92400e; color: #fef3c7; }
table.list tbody tr.row td.col-name .grade-X { background: #7f1d1d; color: #fee2e2; }

/* 시총 대비 들어온 돈 구간 pill */
.vr-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.vr-insufficient_0_5 { background: #475569; color: #cbd5e1; }
.vr-support_5_10     { background: #1e3a8a; color: #93c5fd; }
.vr-core_10_20       { background: #14532d; color: #a7f3d0; }
.vr-core_20_40       { background: #064e3b; color: #6ee7b7; }
.vr-caution_40_80    { background: #6d28d9; color: #ddd6fe; }
.vr-overheat_80_plus { background: #7f1d1d; color: #fca5a5; }
.vr-no_data          { background: #334155; color: #94a3b8; }
.vr-role { font-size: 10px; color: #94a3b8; margin-left: 6px; }
.big-tile.vr-core { border-left: 4px solid #10b981; }
.big-tile.vr-core .value { color: #6ee7b7; }
.big-tile.vr-support { border-left: 4px solid #3b82f6; }
.big-tile.vr-support .value { color: #93c5fd; }
.big-tile.vr-caution { border-left: 4px solid #a78bfa; }
.big-tile.vr-caution .value { color: #ddd6fe; }
.big-tile.vr-overheat { border-left: 4px solid #ef4444; }
.big-tile.vr-overheat .value { color: #fca5a5; }
.big-tile.vr-insufficient { border-left: 4px solid #64748b; }
.big-tile.vr-insufficient .value { color: #cbd5e1; }
table.cmp-vr { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp-vr thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 12px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; }
table.cmp-vr thead th:first-child, table.cmp-vr thead th:nth-child(2) { text-align: left; }
table.cmp-vr tbody td { padding: 8px 12px; border-bottom: 1px solid #334155; text-align: right; font-variant-numeric: tabular-nums; }
table.cmp-vr tbody td:first-child, table.cmp-vr tbody td:nth-child(2) { text-align: left; color: #cbd5e1; }
table.cmp-vr tbody tr:hover td { background: #273549; }
.row-vr-core td { background: rgba(16, 185, 129, 0.10) !important; }
.row-vr-overheat td { background: rgba(239, 68, 68, 0.10) !important; }

/* BMS 핵심 조건 태그 */
.cond-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.cond-strong { background: #115e59; color: #99f6e4; }
.cond-classic { background: #14532d; color: #a7f3d0; }
.cond-partial { background: #1e40af; color: #dbeafe; }
.cond-warn { background: #92400e; color: #fde047; }
.cond-out { background: #475569; color: #cbd5e1; }
.pass-yes { color: #6ee7b7; font-weight: 700; }
.pass-no  { color: #fca5a5; font-weight: 700; }
.big-tile.cc-strong { border-left: 4px solid #14b8a6; }
.big-tile.cc-strong .value { color: #5eead4; }
.big-tile.cc-classic { border-left: 4px solid #10b981; }
.big-tile.cc-classic .value { color: #6ee7b7; }
.big-tile.cc-warn { border-left: 4px solid #ef4444; }
.big-tile.cc-warn .value { color: #fca5a5; }
table.cmp-cc { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp-cc thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 12px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; }
table.cmp-cc thead th:first-child, table.cmp-cc thead th:nth-child(2) { text-align: left; }
table.cmp-cc tbody td { padding: 8px 12px; border-bottom: 1px solid #334155; text-align: right; font-variant-numeric: tabular-nums; }
table.cmp-cc tbody td:first-child, table.cmp-cc tbody td:nth-child(2) { text-align: left; color: #cbd5e1; }
table.cmp-cc tbody tr:hover td { background: #273549; }
.row-cc-core td { background: rgba(16, 185, 129, 0.18) !important; }
.row-cc-strong td { background: rgba(20, 184, 166, 0.18) !important; }
.row-cc-warn td { background: rgba(239, 68, 68, 0.10) !important; }
table.list tbody tr.row:nth-child(odd) { background: #1c2942; }
table.list tbody tr.row:nth-child(odd):hover { background: #273549; }
table.list tbody tr.row.expanded, table.list tbody tr.row.expanded:nth-child(odd) { background: #1e3a5f; }

.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-warn { color: #fde047; }
.flag-pill { display: inline-block; padding: 1px 7px; margin: 1px 3px 1px 0; background: #581c87; color: #d8b4fe; border-radius: 4px; font-size: 10px; }

table.list tbody tr.detail { display: none; background: #0c1729; }
table.list tbody tr.detail.show { display: table-row; }
table.list tbody tr.detail td { padding: 14px 18px; border-bottom: 1px solid #1e3a5f; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 24px; font-size: 12px; }
.detail-block h4 { margin: 0 0 6px; font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.detail-block p { margin: 0 0 4px; color: #cbd5e1; line-height: 1.6; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; line-height: 1.6; }
.kv .k { color: #64748b; }
.kv .v { color: #cbd5e1; font-variant-numeric: tabular-nums; }

.exclusion-reason-list { background: #1e293b; border-radius: 8px; padding: 12px 16px; }
.exclusion-reason-list .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dashed #334155; font-size: 13px; }
.exclusion-reason-list .row:last-child { border-bottom: none; }
.exclusion-reason-list .reason { color: #fde68a; }
.exclusion-reason-list .count { color: #fca5a5; font-weight: 700; font-variant-numeric: tabular-nums; }

.pattern-summary { background: #1e293b; border-radius: 8px; padding: 14px 18px; }
.pattern-summary .kv { grid-template-columns: 1fr auto; }
.pattern-summary .kv .k { color: #cbd5e1; }
.pattern-summary .kv .v { color: #67e8f9; font-weight: 600; }

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

<h1 id="page-title">BMS 학습용 정상 상승 사례 정리 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 과거 +40% 사례 중에서 BMS가 학습에 쓸 만한 정상 사례만 추려내는 보고서입니다.
  현재 종목 후보 탐색은 별도 파일에서 진행합니다.
</div>

<h2>📊 정리 요약</h2>
<div class="big-summary" id="big-summary"></div>

<h2>💰 시총 대비 상승 전 들어온 돈 구간</h2>
<p style="color:#94a3b8;font-size:12px;line-height:1.6;">
  이 구간은 BMS 정제 상승 사례들이 크게 오르기 전 20거래일 동안 시총 대비 어느 정도 거래대금이 지나갔는지를 보여줍니다.
  BMS는 <strong style="color:#6ee7b7;">10~40% 구간을 핵심</strong>으로 보고, <strong style="color:#93c5fd;">5~10%는 초기 유입 참고</strong>, <strong style="color:#fca5a5;">40% 이상은 거래 과다 주의</strong>로 봅니다.
  <span style="color:#fde68a;">단순 분류 태그이며 BMS 본체 필터로는 사용하지 않습니다.</span>
</p>
<div id="value-ratio-section"></div>

<h2>🎯 BMS 핵심 조건 태그</h2>
<p style="color:#94a3b8;font-size:12px;line-height:1.6;">
  정석 BMS 조건은 <strong style="color:#a7f3d0;">시총 대비 상승 전 들어온 돈</strong>과 <strong style="color:#a7f3d0;">상승 시작점 가격 위치</strong>를 함께 보는 단순 조건입니다.
  A+B 정상 상승 사례에서는 C등급보다 약 <strong style="color:#fde68a;">3.65배 더 자주</strong> 나타났습니다.
  <span style="color:#fde68a;">조건 태그일 뿐 BMS 본체 필터가 아닙니다 — 매수 신호도 아닙니다.</span>
</p>
<div id="core-cond-def"></div>
<div id="core-cond-section"></div>

<h2>🚫 제외 사유 TOP</h2>
<div class="exclusion-reason-list" id="exclusion-reason-list"></div>

<h2>🔬 A+B 등급 공통 조건 (학습 기준)</h2>
<p style="color:#94a3b8;font-size:12px;line-height:1.6;">A등급(가장 참고하기 좋은)·B등급(참고 가능)만 모아서 평균/중앙값을 계산. 다음 단계 (현재 종목 유사도 검색) 의 기준점이 됩니다.</p>
<div class="pattern-summary" id="pattern-summary"></div>

<h2>🏆 사례 리스트</h2>
<div class="tabs" id="tabs"></div>
<div class="tbl-wrap">
  <table class="list">
    <thead>
      <tr>
        <th>종목</th>
        <th class="numeric">상승률 (고가)</th>
        <th class="numeric">소요 일수</th>
        <th class="col-mobile-hide">상승 시작일</th>
        <th class="col-mobile-hide">정점일</th>
        <th class="numeric col-mobile-hide">시총</th>
        <th class="numeric">시총 대비 들어온 돈</th>
        <th>들어온 돈 구간</th>
        <th class="col-mobile-hide">BMS 구간 역할</th>
        <th>BMS 핵심 조건</th>
        <th class="col-mobile-hide">조건 역할</th>
        <th class="numeric col-mobile-hide">박스권 폭</th>
        <th class="numeric col-mobile-hide">저점 대비 위치</th>
        <th class="col-mobile-hide">이평선 정렬</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<footer class="foot">
  <strong>BMS 본체 범위:</strong> winner-scan + winner-quality-filter 2단계로만 단순하게 유지합니다.
  시총 대비 들어온 돈은 거래대금 기준이며 실제 순매수금액이 아닙니다 — 매집 확정 지표가 아니라 상승 전 시장에서 돈이 얼마나 지나갔는지를 보는 참고 지표입니다.
  구간별 성격은 별도 감사 보고서(<code>/bms-value-ratio-audit</code>)에서 깊이 있게 확인하세요.
  <br><br>
  <small style="color:#64748b;" id="data-limit-text"></small>
</footer>

<script id="report-data" type="application/json">__JSON_DATA__</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const meta = data.meta || {};
  const summary = data.summary || {};
  const cleanWinners = data.cleanWinners || [];
  const excludedWinners = data.excludedWinners || [];
  const patternSummary = data.patternSummary || {};
  const exclusionReasonSummary = data.exclusionReasonSummary || [];

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d); }
  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtPctRaw(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtMc(v) { if (!v) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; return Math.round(e) + '억'; }
  function fmtValue(v) { if (!v || !isFinite(v)) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; if (e >= 1) return e.toFixed(0) + '억'; return Math.round(v / 1e6) + '백만'; }
  function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }

  document.getElementById('subtitle').innerHTML =
    '원본 ' + summary.sourceTotalCount + '건 → 종목 ' + summary.uniqueStockCount + '개 → ' +
    '<span class="cell-pos">정상 ' + summary.cleanCount + '건</span> / ' +
    '<span class="cell-neg">제외 ' + summary.excludedCount + '건 (' + summary.excludedRate + '%)</span> · ' +
    '생성 ' + new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>📌 다음 단계:</strong> ' + escapeHtml(meta.nextStep) +
    (meta.valueRatioBuckets ? '<br><strong>💰 들어온 돈 구간:</strong> ' + escapeHtml(meta.valueRatioBuckets) : '');

  const dlEl = document.getElementById('data-limit-text');
  if (dlEl && data.dataLimit) {
    dlEl.innerHTML = '데이터 한계: ' + (data.dataLimit || []).map(l => '<br>&nbsp;&bull; ' + escapeHtml(l)).join('');
  }

  // big tiles
  const vrCount = data.valueRatioRoleCount || {};
  const cc = data.coreConditionSummary || {};
  const tiles = [
    { label: '원본 상승 사례', value: summary.sourceTotalCount + '건', sub: '중복 포함', cls: '' },
    { label: '중복 제거 후 종목', value: summary.uniqueStockCount + '개', sub: '대표 사례 1개씩', cls: 'primary' },
    { label: '학습용 정상 사례', value: summary.cleanCount + '건', sub: 'A+B+C', cls: 'primary' },
    { label: 'A등급', value: summary.gradeACount + '건', sub: '가장 참고하기 좋은', cls: 'A' },
    { label: 'B등급', value: summary.gradeBCount + '건', sub: '참고 가능', cls: 'B' },
    { label: 'C등급', value: summary.gradeCCount + '건', sub: '참고만', cls: 'C' },
    { label: '🎯 정석 BMS 조건 만족', value: (cc.classic?.count || 0) + '건', sub: fmtPctRaw(cc.classic?.rate) + ' (전체 중)', cls: 'cc-classic' },
    { label: '🎯 강한 BMS 조건 만족', value: (cc.strong?.count || 0) + '건', sub: fmtPctRaw(cc.strong?.rate) + ' (전체 중)', cls: 'cc-strong' },
    { label: '정석 조건 평균 상승률', value: fmtPct(cc.classic?.avgHighReturn), sub: '미만족 ' + fmtPct(cc.classic?.missSummary?.avgHighReturn), cls: 'cc-classic' },
    { label: '정석 조건 흔들림', value: fmtPctRaw(cc.classic?.avgDrawdown), sub: '미만족 ' + fmtPctRaw(cc.classic?.missSummary?.avgDrawdown), cls: 'cc-classic' },
    { label: 'BMS 핵심 (10~40%)', value: (vrCount.core || 0) + '건', sub: '들어온 돈 핵심 구간', cls: 'vr-core' },
    { label: 'BMS 보조 (5~10%)', value: (vrCount.support || 0) + '건', sub: '초기 유입 참고', cls: 'vr-support' },
    { label: '주의 (40~80%)', value: (vrCount.caution || 0) + '건', sub: '거래 과다 주의', cls: 'vr-caution' },
    { label: '과열 가능 (80%+)', value: (vrCount.overheat || 0) + '건', sub: '강한 주의', cls: 'vr-overheat' },
    { label: '유입 부족 (0~5%)', value: (vrCount.insufficient || 0) + '건', sub: '핵심에서 제외', cls: 'vr-insufficient' },
    { label: '제외 사례', value: summary.excludedCount + '건', sub: '제외율 ' + summary.excludedRate + '%', cls: 'excluded' },
    { label: '정상 평균 상승률', value: fmtPct(summary.avgMaxHighReturn), sub: '중앙값 ' + fmtPct(summary.medMaxHighReturn), cls: '' },
    { label: '정상 평균 도달 소요', value: fmtNum(summary.avgDaysToPeak, 1) + '거래일', sub: '', cls: '' },
    { label: '정상 평균 시총 대비 돈', value: fmtPct(summary.avgPreAccumulationRatio), sub: '상승 전 누적', cls: '' },
    { label: '정상 평균 박스권 폭', value: fmtPct(summary.avgBoxRangePct), sub: '', cls: '' },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div>' + (t.sub ? '<div class="sub">' + t.sub + '</div>' : '');
    ts.appendChild(el);
  });

  // 시총 대비 들어온 돈 구간 분포 (표)
  const vrSummary = data.valueRatioGroupSummary || {};
  const vrOrder = ['insufficient_0_5', 'support_5_10', 'core_10_20', 'core_20_40', 'caution_40_80', 'overheat_80_plus', 'no_data'];
  let vrHtml = '<table class="cmp-vr"><thead><tr>' +
    '<th>구간</th><th>의미</th><th>사례 수</th><th>비율</th><th>평균 상승률</th><th>평균 종가</th><th>평균 소요</th><th>오른뒤 흔들림</th><th>A/B/C</th>' +
    '</tr></thead><tbody>';
  vrOrder.forEach(k => {
    const g = vrSummary[k];
    if (!g || !g.count) return;
    let cls = '';
    if (k === 'core_10_20' || k === 'core_20_40') cls = 'row-vr-core';
    if (k === 'overheat_80_plus') cls = 'row-vr-overheat';
    vrHtml += '<tr class="' + cls + '">' +
      '<td><span class="vr-pill vr-' + k + '">' + escapeHtml(g.label) + '</span></td>' +
      '<td><span class="vr-role">' + escapeHtml(g.role) + '</span> · <span style="color:#94a3b8;font-size:11px;">' + escapeHtml(g.explanation) + '</span></td>' +
      '<td>' + g.count + '건</td>' +
      '<td>' + fmtNum(g.rate) + '%</td>' +
      '<td class="cell-pos">' + fmtPct(g.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(g.avgCloseReturn) + '</td>' +
      '<td>' + (g.avgDaysToPeak != null ? fmtNum(g.avgDaysToPeak, 1) + '일' : '-') + '</td>' +
      '<td>' + (g.avgDrawdown != null ? fmtNum(g.avgDrawdown, 1) + '%' : '-') + '</td>' +
      '<td>A=' + g.gradeACount + ' / B=' + g.gradeBCount + ' / C=' + g.gradeCCount + '</td>' +
    '</tr>';
  });
  vrHtml += '</tbody></table>';
  const adj = data.valueRatioGradeAdjustment || {};
  if (adj.demotedFromA > 0) {
    vrHtml += '<p style="color:#fde68a;font-size:11.5px;line-height:1.5;margin-top:6px;">📌 0~5% / 80%+ 구간이라 A등급에서 B등급으로 조정된 사례: <strong>' + adj.demotedFromA + '건</strong> · ' + escapeHtml(adj.reason) + '</p>';
  }
  document.getElementById('value-ratio-section').innerHTML = vrHtml;

  // BMS 핵심 조건 섹션 (정의 + 라벨 분포 표 + 등급별 만족률)
  const ccDef = (cc.definitions) || {};
  document.getElementById('core-cond-def').innerHTML =
    '<div style="background:#1e293b;border-left:4px solid #10b981;padding:10px 14px;border-radius:6px;margin-bottom:8px;line-height:1.6;">' +
      '<strong style="color:#a7f3d0;">' + escapeHtml(ccDef.classic?.label || '정석 BMS 조건') + '</strong>' +
      ' <span style="color:#94a3b8;">— ' + escapeHtml(ccDef.classic?.description || '') + '</span>' +
      '<br><code style="background:#0f172a;color:#fde047;padding:2px 6px;border-radius:3px;font-size:11.5px;">' + escapeHtml(ccDef.classic?.rule || '') + '</code>' +
    '</div>' +
    '<div style="background:#1e293b;border-left:4px solid #14b8a6;padding:10px 14px;border-radius:6px;margin-bottom:14px;line-height:1.6;">' +
      '<strong style="color:#99f6e4;">' + escapeHtml(ccDef.strong?.label || '강한 BMS 조건') + '</strong>' +
      ' <span style="color:#94a3b8;">— ' + escapeHtml(ccDef.strong?.description || '') + '</span>' +
      '<br><code style="background:#0f172a;color:#fde047;padding:2px 6px;border-radius:3px;font-size:11.5px;">' + escapeHtml(ccDef.strong?.rule || '') + '</code>' +
    '</div>';

  const labelOrder = ['strongCore', 'classicCore', 'goodPriceLowValue', 'goodValueBadPrice', 'overValueCaution', 'lowBaseWeak', 'nearHighCaution', 'noMatch'];
  const labelExplain = {
    strongCore: '시총 대비 들어온 돈도 BMS 중심 구간이고 가격 위치도 저점 회복·고점 여유 조건에 들어옴',
    classicCore: '들어온 돈과 가격 위치가 정석 BMS 조건 안',
    goodPriceLowValue: '가격 위치는 좋지만 상승 전 들어온 돈이 5% 미만',
    goodValueBadPrice: '들어온 돈은 5~40% 안이지만 가격 위치 일부가 정석 범위 밖',
    overValueCaution: '상승 전 거래대금 40% 초과 — 빠르지만 흔들림 큼',
    lowBaseWeak: '저점 대비 +10% 미만 — 힘이 충분히 확인되지 않음',
    nearHighCaution: '고점 대비 -10% 이내 — 고점 근처 추격 위험',
    noMatch: '위 기준에 모두 들어가지 않음',
  };
  const lbls = (cc.labelSummary) || {};
  let ccHtml = '<table class="cmp-cc"><thead><tr>' +
    '<th>조건 태그</th><th>의미</th><th>사례 수</th><th>비율</th><th>평균 상승률</th><th>평균 종가 상승률</th><th>오른뒤 흔들림</th><th>해석</th>' +
    '</tr></thead><tbody>';
  labelOrder.forEach(k => {
    const l = lbls[k];
    if (!l || !l.count) return;
    let cls = '';
    if (k === 'strongCore') cls = 'row-cc-strong';
    else if (k === 'classicCore') cls = 'row-cc-core';
    else if (l.role === '주의') cls = 'row-cc-warn';
    let condCls = 'cond-out';
    if (l.role === '강한 핵심 조건') condCls = 'cond-strong';
    else if (l.role === '핵심 조건') condCls = 'cond-classic';
    else if (l.role === '주의') condCls = 'cond-warn';
    else if (l.role === '일부 조건만 만족') condCls = 'cond-partial';
    ccHtml += '<tr class="' + cls + '">' +
      '<td><span class="cond-pill ' + condCls + '">' + escapeHtml(l.label) + '</span></td>' +
      '<td style="font-size:11px;color:#94a3b8;">' + escapeHtml(labelExplain[k] || '') + '</td>' +
      '<td>' + l.count + '건</td>' +
      '<td>' + fmtPctRaw(l.rate) + '</td>' +
      '<td class="cell-pos">' + fmtPct(l.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(l.avgCloseReturn) + '</td>' +
      '<td class="cell-neg">' + fmtPctRaw(l.avgDrawdown) + '</td>' +
      '<td style="font-size:11px;color:#cbd5e1;">' + escapeHtml(l.role) + '</td>' +
    '</tr>';
  });
  ccHtml += '</tbody></table>';

  // 등급별 만족률 보조 표
  const bg = cc.byGrade || {};
  ccHtml += '<table class="cmp-cc" style="margin-top:8px;"><thead><tr>' +
    '<th>등급</th><th>n</th><th>정석 만족 수</th><th>정석 만족률</th><th>강한 만족 수</th><th>강한 만족률</th>' +
    '</tr></thead><tbody>';
  ['A', 'B', 'C'].forEach(k => {
    const g = bg[k];
    if (!g || !g.count) return;
    ccHtml += '<tr>' +
      '<td><span class="grade-badge grade-' + k + '" style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;">' + k + '</span></td>' +
      '<td>' + g.count + '</td>' +
      '<td>' + g.classicMatchCount + '건</td>' +
      '<td class="cell-pos">' + fmtPctRaw(g.classicMatchRate) + '</td>' +
      '<td>' + g.strongMatchCount + '건</td>' +
      '<td class="cell-pos">' + fmtPctRaw(g.strongMatchRate) + '</td>' +
    '</tr>';
  });
  ccHtml += '</tbody></table>';
  ccHtml += '<p style="color:#fde68a;font-size:11.5px;line-height:1.5;margin-top:6px;">📌 A등급 정석 만족률이 C등급보다 높을수록 조건이 BMS 정상 사례를 잘 설명한다는 뜻입니다. 자세한 차별력 분석은 별도 감사 보고서(/bms-core-condition-audit)에서 확인.</p>';
  document.getElementById('core-cond-section').innerHTML = ccHtml;

  // 제외 사유
  const erEl = document.getElementById('exclusion-reason-list');
  if (exclusionReasonSummary.length === 0) {
    erEl.innerHTML = '<div style="color:#64748b;">제외 사례 없음</div>';
  } else {
    exclusionReasonSummary.slice(0, 15).forEach(r => {
      const div = document.createElement('div');
      div.className = 'row';
      div.innerHTML = '<span class="reason">' + escapeHtml(r.reason) + '</span><span class="count">' + r.count + '건</span>';
      erEl.appendChild(div);
    });
  }

  // pattern summary
  const patternKv = [
    ['후보 수', patternSummary.count + '건'],
    ['평균 상승률 (고가)', fmtPct(patternSummary.avgMaxHighReturn)],
    ['중앙값 상승률', fmtPct(patternSummary.medMaxHighReturn)],
    ['평균 상승률 (종가)', fmtPct(patternSummary.avgMaxCloseReturn)],
    ['평균 +40% 도달 소요', fmtNum(patternSummary.avgDaysToPeak, 1) + '거래일'],
    ['평균 시총 대비 들어온 돈', fmtPct(patternSummary.avgPreAccumulationRatio)],
    ['평균 시총 대비 시작일 거래대금', fmtPct(patternSummary.avgStartDayValueRatio)],
    ['평균 상승 시작일 거래대금 spike', fmtNum(patternSummary.avgValueSpikeRatio) + '배'],
    ['평균 박스권 기간', fmtNum(patternSummary.avgBoxRangeDays, 1) + '일'],
    ['평균 박스권 폭', fmtPct(patternSummary.avgBoxRangePct)],
    ['평균 돌파일 거래대금 배수', fmtNum(patternSummary.avgBreakoutValueRatio) + '배'],
    ['평균 위쪽 매물 부담', fmtPct(patternSummary.avgSupplyAboveRatio)],
    ['평균 60일 저점 대비', fmtPct(patternSummary.avgCloseFromLow60)],
    ['평균 60일 고점 대비', fmtPct(patternSummary.avgCloseFromHigh60)],
    ['평균 52주 고점 대비', fmtPct(patternSummary.avgCloseFrom52WeekHigh)],
    ['20일선 위에서 시작한 비율', fmtPct(patternSummary.aboveMa20Pct)],
    ['60일선 위에서 시작한 비율', fmtPct(patternSummary.aboveMa60Pct)],
    ['120일선 위에서 시작한 비율', fmtPct(patternSummary.aboveMa120Pct)],
    ['단기선만 회복한 비율', fmtPct(patternSummary.shortRecoveryPct)],
  ];
  let psHtml = '<div class="kv">';
  patternKv.forEach(([k, v]) => {
    psHtml += '<div class="k">' + k + '</div><div class="v">' + v + '</div>';
  });
  psHtml += '</div>';
  document.getElementById('pattern-summary').innerHTML = psHtml;

  // tabs
  const tabs = [
    { id: 'A', label: 'A등급 (' + summary.gradeACount + ')', cls: 'A' },
    { id: 'B', label: 'B등급 (' + summary.gradeBCount + ')', cls: 'B' },
    { id: 'C', label: 'C등급 (' + summary.gradeCCount + ')', cls: 'C' },
    { id: 'excluded', label: '제외 (' + summary.excludedCount + ')', cls: 'excluded' },
    { id: 'all', label: '전체 정상 (' + summary.cleanCount + ')', cls: '' },
  ];
  const tabsEl = document.getElementById('tabs');
  let activeTab = 'A';
  tabs.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn ' + t.cls + (t.id === activeTab ? ' active' : '');
    btn.textContent = t.label;
    btn.dataset.tab = t.id;
    btn.dataset.cls = t.cls;
    btn.addEventListener('click', () => {
      activeTab = t.id;
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderList();
    });
    tabsEl.appendChild(btn);
  });

  function pickList() {
    if (activeTab === 'A') return cleanWinners.filter(w => w._grade === 'A');
    if (activeTab === 'B') return cleanWinners.filter(w => w._grade === 'B');
    if (activeTab === 'C') return cleanWinners.filter(w => w._grade === 'C');
    if (activeTab === 'excluded') return excludedWinners;
    return cleanWinners;
  }

  const tbody = document.getElementById('list-body');
  function renderList() {
    tbody.innerHTML = '';
    const list = pickList();
    list.forEach((w) => {
      const a = w.analysis || {};
      const grade = w._grade || 'X';
      const tr = document.createElement('tr');
      tr.className = 'row';
      const vrg = w.valueRatioGroup || {};
      const vrKey = vrg.groupKey || 'no_data';
      const vrLabel = vrg.groupLabel || '데이터 없음';
      const vrRole = vrg.groupRole || '-';
      const cc = w.coreCondition || {};
      const ccLabel = cc.conditionLabel || '-';
      const ccRole = cc.conditionRole || '-';
      let ccCls = 'cond-out';
      if (ccRole === '강한 핵심 조건') ccCls = 'cond-strong';
      else if (ccRole === '핵심 조건') ccCls = 'cond-classic';
      else if (ccRole === '주의') ccCls = 'cond-warn';
      else if (ccRole === '일부 조건만 만족') ccCls = 'cond-partial';
      tr.innerHTML =
        '<td class="col-name">' +
          '<span class="grade-badge grade-' + grade + '">' + grade + '</span>' +
          escapeHtml(w.name) +
          '<span class="meta">' + w.code + ' · ' + (w.market || '-') + '</span>' +
        '</td>' +
        '<td class="numeric cell-pos" style="font-weight:700;">' + fmtPct(w.maxHighReturn) + '</td>' +
        '<td class="numeric">' + w.daysToPeak + '일</td>' +
        '<td class="col-mobile-hide">' + fmtDate(w.startDate) + '</td>' +
        '<td class="col-mobile-hide">' + fmtDate(w.peakDate) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtMc(w.marketCap) + '</td>' +
        '<td class="numeric">' + fmtPct(a.preAccumulation?.accumulatedValueRatio) + '</td>' +
        '<td><span class="vr-pill vr-' + vrKey + '">' + escapeHtml(vrLabel) + '</span></td>' +
        '<td class="col-mobile-hide" style="font-size:11px;color:#cbd5e1;">' + escapeHtml(vrRole) + '</td>' +
        '<td><span class="cond-pill ' + ccCls + '">' + escapeHtml(ccLabel) + '</span></td>' +
        '<td class="col-mobile-hide" style="font-size:11px;color:#cbd5e1;">' + escapeHtml(ccRole) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPct(a.boxAnalysis?.boxRangePct) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPct(a.pricePosition?.closeFromLow60) + '</td>' +
        '<td class="col-mobile-hide">' + (a.movingAverage?.arrangement || '-') + '</td>';
      const trd = document.createElement('tr');
      trd.className = 'detail';
      trd.innerHTML = '<td colspan="14">' + buildDetailHtml(w) + '</td>';
      tr.addEventListener('click', () => {
        tr.classList.toggle('expanded');
        trd.classList.toggle('show');
      });
      tbody.appendChild(tr);
      tbody.appendChild(trd);
    });
  }

  function buildDetailHtml(w) {
    const a = w.analysis || {};
    const pa = a.preAccumulation || {};
    const ra = a.runAnalysis || {};
    const ba = a.boxAnalysis || {};
    const pp = a.pricePosition || {};
    const ma = a.movingAverage || {};
    const sz = a.supplyZone || {};
    const flagsHtml = (w._exclusionFlags || []).map(f => '<span class="flag-pill">' + escapeHtml(f) + '</span>').join('');

    const vrg = w.valueRatioGroup || {};
    const vrKey = vrg.groupKey || 'no_data';
    const adjustNote = w._gradeAdjustReason ? '<p style="color:#fde68a;font-size:11px;">⚠️ ' + escapeHtml(w._gradeAdjustReason) + '</p>' : '';

    return '<div class="detail-grid">' +
      '<div class="detail-block">' +
        '<h4>판정 결과</h4>' +
        '<p>등급: <strong style="color:#67e8f9;">' + (w._grade || '제외') + '</strong></p>' +
        '<p>대표 사례 선택 사유: ' + escapeHtml(w._chosenReason || '-') + '</p>' +
        (flagsHtml ? '<p>제외 사유: ' + flagsHtml + '</p>' : '') +
        adjustNote +
      '</div>' +
      '<div class="detail-block">' +
        '<h4>💰 시총 대비 상승 전 들어온 돈</h4>' +
        '<div class="kv">' +
          '<div class="k">시총 대비 들어온 돈</div><div class="v">' + fmtPct(vrg.preAccumulationRatio) + '</div>' +
          '<div class="k">구간</div><div class="v"><span class="vr-pill vr-' + vrKey + '">' + escapeHtml(vrg.groupLabel || '-') + '</span></div>' +
          '<div class="k">BMS 역할</div><div class="v">' + escapeHtml(vrg.groupRole || '-') + '</div>' +
        '</div>' +
        '<p style="color:#cbd5e1;font-size:11.5px;line-height:1.5;margin-top:6px;">' + escapeHtml(vrg.explanation || '') + '</p>' +
      '</div>' +
      (function(){
        const c = w.coreCondition || {};
        let cls2 = 'cond-out';
        if (c.conditionRole === '강한 핵심 조건') cls2 = 'cond-strong';
        else if (c.conditionRole === '핵심 조건') cls2 = 'cond-classic';
        else if (c.conditionRole === '주의') cls2 = 'cond-warn';
        else if (c.conditionRole === '일부 조건만 만족') cls2 = 'cond-partial';
        const yes = '<span class="pass-yes">통과 ✓</span>';
        const no  = '<span class="pass-no">미통과 ✗</span>';
        const reasonsHtml = (arr) => (arr && arr.length > 0)
          ? '<ul style="margin:4px 0 0 16px;color:#fca5a5;font-size:11px;">' + arr.map(r => '<li>' + escapeHtml(r) + '</li>').join('') + '</ul>'
          : '<p style="color:#6ee7b7;font-size:11px;">실패 사유 없음 (조건 통과)</p>';
        return '<div class="detail-block">' +
          '<h4>🎯 BMS 핵심 조건</h4>' +
          '<div class="kv">' +
            '<div class="k">조건 라벨</div><div class="v"><span class="cond-pill ' + cls2 + '">' + escapeHtml(c.conditionLabel || '-') + '</span></div>' +
            '<div class="k">조건 역할</div><div class="v">' + escapeHtml(c.conditionRole || '-') + '</div>' +
            '<div class="k">정석 BMS 조건</div><div class="v">' + (c.matchesClassicBms ? yes : no) + '</div>' +
            '<div class="k">강한 BMS 조건</div><div class="v">' + (c.matchesStrongBms ? yes : no) + '</div>' +
            '<div class="k">시총 대비 들어온 돈</div><div class="v">' + fmtPct(c.preAccumulationRatio) + '</div>' +
            '<div class="k">저점 대비 위치</div><div class="v">' + fmtPct(c.closeFromLow60) + '</div>' +
            '<div class="k">고점까지 남은 공간</div><div class="v">' + fmtPct(c.closeFromHigh60) + '</div>' +
          '</div>' +
          '<p style="color:#cbd5e1;font-size:11.5px;line-height:1.5;margin-top:6px;">' + escapeHtml(c.explanation || '') + '</p>' +
          '<p style="color:#94a3b8;font-size:11px;margin-top:6px;"><strong>정석 미충족 사유:</strong></p>' + reasonsHtml(c.failedClassicReasons) +
          '<p style="color:#94a3b8;font-size:11px;margin-top:6px;"><strong>강한 미충족 사유:</strong></p>' + reasonsHtml(c.failedStrongReasons) +
        '</div>';
      })() +
      '<div class="detail-block">' +
        '<h4>① 상승 전 거래대금</h4>' +
        '<div class="kv">' +
          '<div class="k">시총 대비 들어온 돈</div><div class="v">' + fmtPct(pa.accumulatedValueRatio) + '</div>' +
          '<div class="k">시총 대비 시작일 거래대금</div><div class="v">' + fmtPct(pa.startDayValueRatio) + '</div>' +
          '<div class="k">평소 대비 spike</div><div class="v">' + (pa.valueSpikeRatio != null ? fmtNum(pa.valueSpikeRatio) + '×' : '-') + '</div>' +
          '<div class="k">준비 구간 일수</div><div class="v">' + (pa.days || '-') + '일</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block">' +
        '<h4>② 상승 진행</h4>' +
        '<div class="kv">' +
          '<div class="k">상승 기간</div><div class="v">' + (ra.days || '-') + '거래일</div>' +
          '<div class="k">평균 spike</div><div class="v">' + (ra.spikeAvgRatio != null ? fmtNum(ra.spikeAvgRatio) + '×' : '-') + '</div>' +
          '<div class="k">크게 늘어난 날</div><div class="v">' + (ra.spikeDays || 0) + '/' + (ra.days || '-') + '일</div>' +
          '<div class="k">시총 대비 누적</div><div class="v">' + fmtPct(ra.accumulatedValueRatio) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block">' +
        '<h4>③ 박스권</h4>' +
        (ba.dataLimit ? '<p style="color:#fca5a5;">' + escapeHtml(ba.dataLimit) + '</p>' : (
          '<div class="kv">' +
          '<div class="k">기간</div><div class="v">' + (ba.boxRangeDays || '-') + '일</div>' +
          '<div class="k">폭</div><div class="v">' + fmtPct(ba.boxRangePct) + '</div>' +
          '<div class="k">하단 → 상단</div><div class="v">' + (ba.boxLow != null ? ba.boxLow.toLocaleString() : '-') + ' → ' + (ba.boxHigh != null ? ba.boxHigh.toLocaleString() : '-') + '</div>' +
          '<div class="k">하단 올라감</div><div class="v">' + (ba.lowRising ? '예' : '아니오') + '</div>' +
          '<div class="k">상단 두드린 횟수</div><div class="v">' + (ba.touchedHighTimes || 0) + '회</div>' +
          '<div class="k">박스 안 거래대금 추세</div><div class="v">' + (ba.valueTrendInBox || '-') + '</div>' +
          '<div class="k">돌파일 거래대금 배수</div><div class="v">' + (ba.breakoutValueRatio != null ? fmtNum(ba.breakoutValueRatio) + '×' : '-') + '</div>' +
          '</div>'
        )) +
      '</div>' +
      '<div class="detail-block">' +
        '<h4>④ 가격 위치</h4>' +
        '<div class="kv">' +
          '<div class="k">60일 저점 대비</div><div class="v">' + fmtPct(pp.closeFromLow60) + ' 위</div>' +
          '<div class="k">120일 저점 대비</div><div class="v">' + fmtPct(pp.closeFromLow120) + ' 위</div>' +
          '<div class="k">60일 고점 대비</div><div class="v">' + fmtPct(pp.closeFromHigh60) + '</div>' +
          '<div class="k">52주 고점 대비</div><div class="v">' + fmtPct(pp.closeFrom52WeekHigh) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block">' +
        '<h4>⑤ 이평선 / 매물대</h4>' +
        '<div class="kv">' +
          '<div class="k">이평선 정렬</div><div class="v">' + (ma.arrangement || '-') + '</div>' +
          '<div class="k">종가 vs 20일선</div><div class="v">' + fmtPct(ma.closeOverMa20) + '</div>' +
          '<div class="k">종가 vs 60일선</div><div class="v">' + fmtPct(ma.closeOverMa60) + '</div>' +
          '<div class="k">위쪽 매물 부담</div><div class="v">' + fmtPct(sz.aboveCloseRatio) + '</div>' +
        '</div>' +
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
