/**
 * VPR (Volume Pullback Rebound) Analyzer — 공용 모듈
 *
 * QVA → VVI → 돌파 성공(H그룹) 이후 눌림/재돌파 후속 분석.
 * vpr-hgroup-pullback-rebound-audit.js (감사) + qva-watchlist-board.js (라이브 보드)에서 공유.
 *
 * 주의:
 *   - QVA/VVI/H그룹 정의는 변경하지 않는다.
 *   - VPR은 매수확정 신호가 아니라 H그룹 이후 후속 확인 태그다.
 */

const DEFAULT_CONFIG = {
  PULLBACK_LOOKAHEAD_DAYS: 10,    // H돌파일 이후 눌림 관찰 거래일 수
  MIN_PULLBACK_DAYS: 1,
  POST_REBOUND_DAYS: [5, 10],     // 재돌파일 종가 기준 후속 성과 윈도우
  // 눌림 분류 임계값 (기준 진입가 대비 %)
  NORMAL_CLOSE_DD: -8,            // 정상 눌림 종가 하락 한계
  NORMAL_LOW_DD: -12,             // 정상 눌림 저가 하락 한계
  DEEP_CLOSE_DD: -15,             // 깊은 눌림 종가 하한 (이하 = 구조 훼손)
  DEEP_LOW_DD: -20,               // 깊은 눌림 저가 하한 (이하 = 구조 훼손)
  NO_PULLBACK_LOW_DD: -3,         // 눌림 없음 (저가가 진입가 -3% 위 유지)
};

const VPR_LABELS = {
  STRONG_VPR_SUCCESS: '강한 VPR 성공',
  CLASSIC_VPR_SUCCESS: 'VPR 성공',
  WEAK_VPR_REBOUND: 'VPR 재돌파 약함',
  PULLBACK_PENDING: 'VPR 대기',
  REBOUND_FAIL: 'VPR 실패',
  STRUCTURAL_BREAK: '구조 훼손',
  NO_PULLBACK_RUNAWAY: '눌림 없이 상승',
  DATA_INSUFFICIENT: '데이터 부족',
};

// 문구는 3년+flow 백테스트(이벤트 448건) 운영 해석 기준 (2026-05-05).
const VPR_DESCRIPTIONS = {
  STRONG_VPR_SUCCESS: '정상 눌림 후 강한 재돌파와 종가 유지가 확인된 상태입니다. 후속 상승 가능성이 높고, 하락 위험은 상대적으로 낮았습니다 (n=41, H+10 고가 +16.72% / 종가 +5.86% / -5% 종가 2.44%).',
  CLASSIC_VPR_SUCCESS: '눌림 후 기준 가격을 다시 회복하고 종가가 유지된 상태입니다 (n=30, H+10 고가 +11.95% / 종가 +2.54%).',
  WEAK_VPR_REBOUND: '장중 재돌파는 있었지만 종가 유지가 약한 상태입니다. 통계상 이후 회복률이 낮아 추가 확인 전까지 주의가 필요합니다 (n=40, 성공 회복률 3.13%, H+10 고가 +6.80% / 종가 +0.49%).',
  PULLBACK_PENDING: '정상 눌림 범위에 있으나 아직 재돌파 전입니다. 성공보다 구조 훼손으로 갈 가능성도 있어 관찰 상태로 봐야 합니다 (D+5 대기 98건 → D+10 성공 20.41% / 구조 훼손 44.9%).',
  REBOUND_FAIL: '눌림 후 10거래일 안에 재돌파가 나오지 않은 상태입니다. 약세 시그널.',
  STRUCTURAL_BREAK: '돌파 이후 기준 가격을 의미 있게 이탈한 위험 상태입니다. 신규 매수는 피하고, 보유 중이면 관리 해제 또는 손절 기준 확인이 필요합니다 (n=133, H+10 종가 -8.80% / -5% 종가 72.18%).',
  NO_PULLBACK_RUNAWAY: '돌파 성공 후 눌림 없이 상승 흐름이 이어지는 상태입니다. 흐름은 강하지만 기준가에서 멀어졌다면 추격 주의가 필요합니다 (n=162, H+10 고가 +20.69% / 종가 +9.49% / +20% 도달 33.95%).',
  DATA_INSUFFICIENT: '돌파일 이후 거래일이 부족해 VPR 분석이 어려운 상태입니다.',
};

// 이미 상승이 진행돼 (judgmentStatus === MANAGEMENT) VPR 분석이 의미 적은 상태에 붙이는 보조 메모
const MANAGEMENT_NOTE = '이미 상승이 진행된 상태로, 신규 진입보다는 관리 관점입니다.';

// ─────────────────────── 헬퍼 ───────────────────────

function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}

// ─────────────────────── 핵심 분석 ───────────────────────

/**
 * @param {object} input - { entryDate?, entryIdx?, vviHigh, vviClose, vviLow?, qvaSignalPrice, entryPrice? }
 * @param {Array} rows - chart rows ascending by date
 * @param {object} [config] - optional overrides
 * @returns {object} VPR analysis result (or { vprStatus: 'DATA_INSUFFICIENT', ... })
 */
function analyzeVPR(input, rows, config = DEFAULT_CONFIG) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config);
  const { vviHigh, vviClose, vviLow, qvaSignalPrice } = input;

  // entryIdx 결정
  let entryIdx = input.entryIdx;
  if (entryIdx == null && input.entryDate) {
    entryIdx = rows.findIndex(r => r.date === input.entryDate);
  }
  if (entryIdx == null || entryIdx < 0) {
    return {
      vprStatus: 'DATA_INSUFFICIENT',
      vprLabel: VPR_LABELS.DATA_INSUFFICIENT,
      reason: '차트 캐시에 H돌파일이 없음',
      result: { vprStatus: 'DATA_INSUFFICIENT', vprLabel: VPR_LABELS.DATA_INSUFFICIENT,
                isClassicVprSuccess: false, isStrongVprSuccess: false, isVprFailure: false },
    };
  }
  if (!(vviHigh > 0)) {
    return {
      vprStatus: 'DATA_INSUFFICIENT',
      vprLabel: VPR_LABELS.DATA_INSUFFICIENT,
      reason: 'vviHigh 값이 없음',
      result: { vprStatus: 'DATA_INSUFFICIENT', vprLabel: VPR_LABELS.DATA_INSUFFICIENT,
                isClassicVprSuccess: false, isStrongVprSuccess: false, isVprFailure: false },
    };
  }

  const hRow = rows[entryIdx];
  const hBreakoutHigh = hRow.high;
  const hBreakoutClose = hRow.close;
  const vviBreakPrice = vviHigh * 1.01;
  const entryPrice = (input.entryPrice && input.entryPrice > 0) ? input.entryPrice : vviBreakPrice;

  const lookahead = cfg.PULLBACK_LOOKAHEAD_DAYS;
  const lastIdx = Math.min(entryIdx + lookahead, rows.length - 1);
  if (lastIdx - entryIdx < cfg.MIN_PULLBACK_DAYS) {
    return {
      vprStatus: 'DATA_INSUFFICIENT',
      vprLabel: VPR_LABELS.DATA_INSUFFICIENT,
      reason: 'H돌파일 이후 거래일이 부족함',
      base: { vviHigh, vviBreakPrice: round(vviBreakPrice), hBreakoutHigh, hBreakoutClose, entryPrice: round(entryPrice) },
      result: { vprStatus: 'DATA_INSUFFICIENT', vprLabel: VPR_LABELS.DATA_INSUFFICIENT,
                isClassicVprSuccess: false, isStrongVprSuccess: false, isVprFailure: false },
    };
  }

  // ─── 눌림 (entryIdx+1 ~ lastIdx) ───
  let lowestLowAfterH = Infinity;
  let lowestLowIdx = -1;
  let lowestCloseAfterH = Infinity;
  let lowestCloseIdx = -1;
  for (let k = entryIdx + 1; k <= lastIdx; k++) {
    const r = rows[k];
    if (r.low < lowestLowAfterH) { lowestLowAfterH = r.low; lowestLowIdx = k; }
    if (r.close < lowestCloseAfterH) { lowestCloseAfterH = r.close; lowestCloseIdx = k; }
  }
  let pullbackHighOnDescent = -Infinity;
  for (let k = entryIdx + 1; k <= lowestLowIdx; k++) {
    if (rows[k].high > pullbackHighOnDescent) pullbackHighOnDescent = rows[k].high;
  }
  if (!Number.isFinite(pullbackHighOnDescent)) pullbackHighOnDescent = hBreakoutHigh;

  const lowDrawdownFromEntryPct = (lowestLowAfterH / entryPrice - 1) * 100;
  const closeDrawdownFromEntryPct = (lowestCloseAfterH / entryPrice - 1) * 100;
  const lowDrawdownFromHHighPct = (lowestLowAfterH / hBreakoutHigh - 1) * 100;
  const lowDrawdownFromVviBreakPct = (lowestLowAfterH / vviBreakPrice - 1) * 100;
  const daysToPullback = lowestLowIdx - entryIdx;
  const pullbackDate = lowestLowIdx >= 0 ? rows[lowestLowIdx].date : null;

  // 눌림 평균 거래대금
  let pullbackValueSum = 0, pullbackValueCount = 0;
  for (let k = entryIdx + 1; k <= Math.max(lowestLowIdx, entryIdx + 1); k++) {
    if (k > lastIdx) break;
    const v = rows[k].valueApprox || rows[k].close * rows[k].volume;
    if (v > 0) { pullbackValueSum += v; pullbackValueCount++; }
  }
  const pullbackAvgValue = pullbackValueCount > 0 ? pullbackValueSum / pullbackValueCount : 0;

  // ─── 눌림 분류 ───
  // 구조 훼손 = 실제 의미 있는 하락이 동반된 경우만 분류한다.
  // (entry가 qvaSignalPrice 바로 위에 있는 짧은 funnel — 예: QVA → 며칠 내 VVI → H — 에서
  //  -1% 정도 작은 흔들림으로도 qvaSignalPrice * 1.02 조건이 발동하던 문제 보정)
  let pullbackType, pullbackTypeLabel;
  const isStructuralBreak =
    closeDrawdownFromEntryPct < cfg.DEEP_CLOSE_DD ||
    lowDrawdownFromEntryPct < cfg.DEEP_LOW_DD ||
    (qvaSignalPrice > 0 && lowestLowAfterH <= qvaSignalPrice * 1.02 && lowDrawdownFromEntryPct <= -8);
  const noPullback = lowDrawdownFromEntryPct > cfg.NO_PULLBACK_LOW_DD;
  if (isStructuralBreak) {
    pullbackType = 'STRUCTURAL_BREAK';
    pullbackTypeLabel = '구조 훼손';
  } else if (noPullback) {
    pullbackType = 'NO_PULLBACK';
    pullbackTypeLabel = '눌림 없이 상승';
  } else if (
    closeDrawdownFromEntryPct >= cfg.NORMAL_CLOSE_DD &&
    lowDrawdownFromEntryPct >= cfg.NORMAL_LOW_DD
  ) {
    pullbackType = 'NORMAL_PULLBACK';
    pullbackTypeLabel = '정상 눌림';
  } else {
    pullbackType = 'DEEP_PULLBACK';
    pullbackTypeLabel = '깊은 눌림';
  }
  const hasPullback = pullbackType !== 'NO_PULLBACK';

  // ─── 재돌파 검출 (눌림 이후 ~ lastIdx) ───
  const reboundStart = lowestLowIdx + 1;
  let hasVviBreakRecover = false;
  let hasHHighBreak = false;
  let hasPullbackTopBreak = false;
  let firstReboundIdx = -1;
  for (let k = reboundStart; k <= lastIdx; k++) {
    const r = rows[k];
    const recoverVvi = r.close >= vviBreakPrice || r.high >= vviBreakPrice;
    const breakHHigh = r.high >= hBreakoutHigh;
    const breakPullbackTop = r.high > pullbackHighOnDescent;
    if (recoverVvi && !hasVviBreakRecover) hasVviBreakRecover = true;
    if (breakHHigh && !hasHHighBreak) hasHHighBreak = true;
    if (breakPullbackTop && !hasPullbackTopBreak) hasPullbackTopBreak = true;
    if (firstReboundIdx < 0 && (recoverVvi || breakHHigh || breakPullbackTop)) {
      firstReboundIdx = k;
    }
  }
  const hasVprRebound = firstReboundIdx >= 0;
  const reboundDate = hasVprRebound ? rows[firstReboundIdx].date : null;
  const daysToRebound = hasVprRebound ? firstReboundIdx - entryIdx : null;
  const reboundClose = hasVprRebound ? rows[firstReboundIdx].close : null;
  const reboundHigh = hasVprRebound ? rows[firstReboundIdx].high : null;
  const reboundValue = hasVprRebound
    ? (rows[firstReboundIdx].valueApprox || rows[firstReboundIdx].close * rows[firstReboundIdx].volume)
    : null;
  const reboundValueVsPullbackAvg = (hasVprRebound && pullbackAvgValue > 0)
    ? round(reboundValue / pullbackAvgValue, 2)
    : null;
  const closeHeldAboveReboundLevel = hasVprRebound
    ? rows[firstReboundIdx].close >= Math.min(vviBreakPrice, pullbackHighOnDescent)
    : null;

  // ─── 재돌파 후 성과 (재돌파일 종가 기준) ───
  const reboundForward = {};
  if (hasVprRebound) {
    for (const N of cfg.POST_REBOUND_DAYS) {
      let mfeHighReturn = null;
      let closeReturn = null;
      for (let k = 1; k <= N; k++) {
        const j = firstReboundIdx + k;
        if (j >= rows.length) break;
        const upHigh = (rows[j].high / reboundClose - 1) * 100;
        if (mfeHighReturn == null || upHigh > mfeHighReturn) mfeHighReturn = upHigh;
        if (k === N) closeReturn = (rows[j].close / reboundClose - 1) * 100;
      }
      reboundForward[`mfeHigh${N}`] = round(mfeHighReturn, 2);
      reboundForward[`close${N}`] = round(closeReturn, 2);
    }
  }

  // ─── H돌파일 종가 기준 10일 성과 ───
  let maxHighReturnWithin10 = null;
  let closeReturnWithin10 = null;
  for (let k = 1; k <= cfg.PULLBACK_LOOKAHEAD_DAYS; k++) {
    const j = entryIdx + k;
    if (j >= rows.length) break;
    const upHigh = (rows[j].high / hBreakoutClose - 1) * 100;
    if (maxHighReturnWithin10 == null || upHigh > maxHighReturnWithin10) maxHighReturnWithin10 = upHigh;
    if (k === cfg.PULLBACK_LOOKAHEAD_DAYS) closeReturnWithin10 = (rows[j].close / hBreakoutClose - 1) * 100;
  }

  // ─── 최종 vprStatus 분류 ───
  // 사용자 spec(2026-05): 종가 유지 실패 → WEAK_VPR_REBOUND로 분기 (정석 VPR 성공에서 분리)
  let vprStatus, vprLabel;
  let isClassicVprSuccess = false;
  let isStrongVprSuccess = false;
  let isWeakVprRebound = false;
  let isVprFailure = false;

  if (pullbackType === 'STRUCTURAL_BREAK') {
    vprStatus = 'STRUCTURAL_BREAK';
    isVprFailure = true;
  } else if (pullbackType === 'NO_PULLBACK') {
    vprStatus = 'NO_PULLBACK_RUNAWAY';
  } else {
    if (hasVprRebound) {
      if (closeHeldAboveReboundLevel) {
        const strongConditions =
          pullbackType === 'NORMAL_PULLBACK' &&
          hasHHighBreak &&
          reboundValueVsPullbackAvg != null && reboundValueVsPullbackAvg >= 1.0;
        if (strongConditions) {
          vprStatus = 'STRONG_VPR_SUCCESS';
          isStrongVprSuccess = true;
          isClassicVprSuccess = true;
        } else {
          vprStatus = 'CLASSIC_VPR_SUCCESS';
          isClassicVprSuccess = true;
        }
      } else {
        // 재돌파는 발생했지만 종가가 기준 가격 아래에서 마감
        vprStatus = 'WEAK_VPR_REBOUND';
        isWeakVprRebound = true;
      }
    } else {
      const exhausted = lastIdx >= entryIdx + cfg.PULLBACK_LOOKAHEAD_DAYS;
      if (exhausted) {
        vprStatus = 'REBOUND_FAIL';
        isVprFailure = true;
      } else {
        vprStatus = 'PULLBACK_PENDING';
      }
    }
  }
  vprLabel = VPR_LABELS[vprStatus];

  const oneLineSummary = buildOneLineSummary({
    vprStatus, pullbackType, daysToPullback, daysToRebound,
    closeDrawdownFromEntryPct, lowDrawdownFromEntryPct,
    hasHHighBreak, closeHeldAboveReboundLevel,
  });

  return {
    base: {
      vviHigh,
      vviBreakPrice: round(vviBreakPrice),
      hBreakoutHigh,
      hBreakoutClose,
      entryPrice: round(entryPrice),
      qvaSignalPrice,
      pullbackHighOnDescent: round(pullbackHighOnDescent),
    },
    pullback: {
      hasPullback,
      pullbackType,
      pullbackTypeLabel,
      pullbackDate,
      daysToPullback,
      lowestLowAfterH,
      lowestCloseAfterH,
      lowDrawdownFromEntryPct: round(lowDrawdownFromEntryPct),
      closeDrawdownFromEntryPct: round(closeDrawdownFromEntryPct),
      lowDrawdownFromHHighPct: round(lowDrawdownFromHHighPct),
      lowDrawdownFromVviBreakPct: round(lowDrawdownFromVviBreakPct),
      pullbackAvgValue: Math.round(pullbackAvgValue),
    },
    rebound: {
      hasVprRebound,
      hasVviBreakRecover,
      hasHHighBreak,
      hasPullbackTopBreak,
      reboundDate,
      daysToRebound,
      reboundClose,
      reboundHigh,
      reboundValue: reboundValue != null ? Math.round(reboundValue) : null,
      reboundValueVsPullbackAvg,
      closeHeldAboveReboundLevel,
    },
    result: {
      vprStatus,
      vprLabel,
      isClassicVprSuccess,
      isStrongVprSuccess,
      isWeakVprRebound,
      isVprFailure,
      maxHighReturnAfterRebound: reboundForward.mfeHigh10 ?? null,
      closeReturnAfterRebound: reboundForward.close10 ?? null,
      mfeHigh5AfterRebound: reboundForward.mfeHigh5 ?? null,
      close5AfterRebound: reboundForward.close5 ?? null,
      maxHighReturnWithin10: round(maxHighReturnWithin10),
      closeReturnWithin10: round(closeReturnWithin10),
    },
    oneLineSummary,
  };
}

function buildOneLineSummary({ vprStatus, pullbackType, daysToPullback, daysToRebound,
                               closeDrawdownFromEntryPct, lowDrawdownFromEntryPct,
                               hasHHighBreak }) {
  switch (vprStatus) {
    case 'STRONG_VPR_SUCCESS':
      return `정상 눌림(${daysToPullback}일째 -${Math.abs(closeDrawdownFromEntryPct).toFixed(1)}%) 후 ${daysToRebound}일 만에 H돌파일 고가까지 재돌파하고 종가가 유지된 강한 VPR 성공 사례입니다.`;
    case 'CLASSIC_VPR_SUCCESS': {
      const reboundLabel = hasHHighBreak ? 'H돌파일 고가' : 'VVI 기준가';
      return `${pullbackType === 'NORMAL_PULLBACK' ? '정상' : '깊은'} 눌림 후 ${daysToRebound}일 만에 ${reboundLabel}를 재돌파하고 종가가 유지된 VPR 성공 사례입니다.`;
    }
    case 'WEAK_VPR_REBOUND': {
      const reboundLabel = hasHHighBreak ? 'H돌파일 고가' : 'VVI 기준가';
      return `${pullbackType === 'NORMAL_PULLBACK' ? '정상' : '깊은'} 눌림 후 ${daysToRebound}일 만에 ${reboundLabel}를 장중 재돌파했지만 종가 유지가 약한 상태입니다.`;
    }
    case 'PULLBACK_PENDING':
      return `현재 ${pullbackType === 'NORMAL_PULLBACK' ? '정상' : '깊은'} 눌림 진행 중 — 아직 재돌파 미확인 (관찰 윈도우 미완).`;
    case 'REBOUND_FAIL':
      return `${pullbackType === 'NORMAL_PULLBACK' ? '정상' : '깊은'} 눌림(-${Math.abs(closeDrawdownFromEntryPct).toFixed(1)}%) 후 10거래일 안에 재돌파 없음 — VPR 실패.`;
    case 'STRUCTURAL_BREAK':
      return `H돌파일 기준 진입가 대비 종가 ${closeDrawdownFromEntryPct.toFixed(1)}% / 저가 ${lowDrawdownFromEntryPct.toFixed(1)}% 이탈 — 구조 훼손으로 분류된 사례입니다.`;
    case 'NO_PULLBACK_RUNAWAY':
      return '돌파 성공 후 눌림 없이 상승이 이어진 H그룹 사례입니다. 신규 진입은 추격 주의입니다.';
    default:
      return '';
  }
}

/**
 * BREAKDOWN_WEAK 등 화면 상태와 VPR 태그가 충돌할 때 한 줄 해석에 둘 다 설명한다.
 * (예: judgmentStatus='BREAKDOWN_WEAK'인데 vprStatus='PULLBACK_PENDING'이면
 *  "기존 기준으로는 돌파 악화이나, VPR 기준으로는 정상 눌림 범위에서 재돌파 대기 중입니다.")
 *
 * @param {string} judgmentStatus - 화면 상태 (REVIEW_OK / CHASE_CAUTION / PULLBACK_WAIT / MANAGEMENT / BREAKDOWN_WEAK)
 * @param {object} vprResult - analyzeVPR 결과 객체
 * @returns {string|null} 충돌 시 보충 문장, 없으면 null
 */
function buildConflictNote(judgmentStatus, vprResult) {
  if (!judgmentStatus || !vprResult) return null;
  const vs = vprResult?.result?.vprStatus;
  if (!vs || vs === 'DATA_INSUFFICIENT') return null;

  const healthyVpr = ['STRONG_VPR_SUCCESS', 'CLASSIC_VPR_SUCCESS', 'PULLBACK_PENDING'];
  const weakVpr = ['WEAK_VPR_REBOUND'];
  const damagedVpr = ['STRUCTURAL_BREAK', 'REBOUND_FAIL'];

  // 충돌 1: 화면=돌파 악화 + VPR=정상/대기/재돌파 → "돌파 악화이나 VPR 기준으로는 ..."
  if (judgmentStatus === 'BREAKDOWN_WEAK') {
    if (healthyVpr.includes(vs)) {
      const phrase = {
        STRONG_VPR_SUCCESS: '정상 눌림 후 강한 재돌파가 확인된 상태',
        CLASSIC_VPR_SUCCESS: '정상 눌림 후 기준 가격을 재돌파한 상태',
        PULLBACK_PENDING: '정상 눌림 범위에서 재돌파 대기 중',
      }[vs];
      return `기존 기준으로는 돌파 악화이나, VPR 기준으로는 ${phrase}입니다.`;
    }
    if (weakVpr.includes(vs)) {
      return '기존 기준으로는 돌파 악화이며, VPR 기준으로도 재돌파 후 종가 유지가 약한 상태입니다.';
    }
    return null;
  }
  // 충돌 2: 화면=눌림 대기/추격 주의 + VPR=구조 훼손/재돌파 실패
  if (judgmentStatus === 'PULLBACK_WAIT' || judgmentStatus === 'CHASE_CAUTION') {
    if (damagedVpr.includes(vs)) {
      const phrase = vs === 'STRUCTURAL_BREAK' ? '구조 훼손' : '재돌파 실패';
      return `기존 기준으로는 ${judgmentStatus === 'PULLBACK_WAIT' ? '눌림 대기' : '추격 주의'}처럼 보이지만, VPR 기준으로는 ${phrase} 상태입니다.`;
    }
    if (weakVpr.includes(vs)) {
      return `기존 기준으로는 ${judgmentStatus === 'PULLBACK_WAIT' ? '눌림 대기' : '추격 주의'} 상태이며, VPR 기준으로는 재돌파 후 종가 유지가 약한 상태입니다.`;
    }
  }
  // 충돌 3: 화면=관리 구간 + VPR=구조 훼손
  if (judgmentStatus === 'MANAGEMENT' && damagedVpr.includes(vs)) {
    const phrase = vs === 'STRUCTURAL_BREAK' ? '구조 훼손' : '재돌파 실패';
    return `현재가는 진입가 +15% 위 관리 구간이지만, VPR 기준으로는 ${phrase} 흔적이 있는 상태입니다.`;
  }
  return null;
}

// ─────────────────────── 신규 VPR (돌파 이후 반응 분류) ───────────────────────
//
// 사용자 spec(2026-05): VPR을 "성공/실패" 판정에서 "돌파 이후 반응 분류"로 재정의.
// H그룹(이미 기준선을 돌파한 종목군) 내부에서만 적용한다.
//
// 기준값:
//   baseClose       = VVI 돌파대기일 종가
//   breakoutLine    = baseClose × 1.01
//   nextOpen/High/Low/Close = 다음 거래일(=H돌파일) 시/고/저/종가
//   nextValue       = 다음 거래일 거래대금
//   prevValueAvg    = VVI일 이전 20거래일 평균 거래대금
//
// 메인 태그(우선순위 순):
//   1. 과열 돌파      OVERHEATED_BREAKOUT
//   2. 고가권 유지    HIGH_ZONE_HOLD
//   3. 기준선 위 마감  ABOVE_BREAKOUT_LINE
//   4. 기준 종가 위 유지 ABOVE_BASE_CLOSE
//   5. 장중 돌파 후 밀림 INTRADAY_PUSHBACK
//
// 화면에서는 "성공/실패/미돌파/대기" 표현을 쓰지 않는다.

const VPR_MAIN_LABELS = {
  OVERHEATED_BREAKOUT: '과열 돌파',
  HIGH_ZONE_HOLD: '고가권 유지',
  ABOVE_BREAKOUT_LINE: '기준선 위 마감',
  ABOVE_BASE_CLOSE: '기준 종가 위 유지',
  INTRADAY_PUSHBACK: '장중 돌파 후 밀림',
};

const VPR_MAIN_DESCRIPTIONS = {
  OVERHEATED_BREAKOUT: '기준선은 돌파했지만 기준 종가 대비 많이 떠 있어 추격 위험이 큽니다.',
  HIGH_ZONE_HOLD: '기준선을 돌파한 뒤 종가가 고가권에서 유지되었습니다.',
  ABOVE_BREAKOUT_LINE: '기준선 위에서 마감했지만 장중 고점 대비 일부 밀림이 있었습니다.',
  ABOVE_BASE_CLOSE: '장중 기준선을 돌파했지만 종가는 돌파 기준가 아래로 내려왔고, 기준 종가는 지켰습니다.',
  INTRADAY_PUSHBACK: '장중 기준선을 돌파했지만 종가가 기준 종가 아래로 내려와 밀림이 있었습니다.',
};

const VPR_AUX_LABELS = {
  VOLUME_EXPLOSION: '거래대금 폭발',
  VOLUME_SUPPORT: '거래대금 동반',
  VOLUME_WEAK: '거래대금 약함',
  GAP_UP_START: '갭상승 출발',
  GAP_UP_WOBBLE: '갭상승 후 흔들림',
  UPPER_WICK_WARN: '위꼬리 주의',
  UPPER_WICK_SMALL: '위꼬리 적음',
  LOWER_WICK_RECOVER: '아래꼬리 회복',
  FAR_FROM_BASE: '기준가 대비 거리 큼',
  QUIET_BREAKOUT: '조용한 돌파',
};

const VPR_AUX_DESCRIPTIONS = {
  VOLUME_EXPLOSION: '거래대금이 평소보다 매우 크게 증가했습니다.',
  VOLUME_SUPPORT: '기준선 돌파와 함께 거래대금도 평소보다 크게 늘었습니다.',
  VOLUME_WEAK: '기준선은 돌파했지만 거래대금은 평소보다 약했습니다.',
  GAP_UP_START: '시가부터 기준선 위에서 출발했습니다.',
  GAP_UP_WOBBLE: '시가부터 기준선 위에서 출발했지만 종가는 시가보다 낮게 마감했습니다.',
  UPPER_WICK_WARN: '장중 고점 대비 종가가 많이 내려왔습니다.',
  UPPER_WICK_SMALL: '종가가 당일 고가에 가깝게 마감했습니다.',
  LOWER_WICK_RECOVER: '장중 기준 종가 아래로 밀렸지만 종가가 회복되었습니다.',
  FAR_FROM_BASE: '기준 종가 대비 많이 떠 있어 추격 위험이 있습니다.',
  QUIET_BREAKOUT: '기준선은 돌파했지만 거래대금 증가는 보통 수준입니다.',
};

/**
 * H그룹 종목의 돌파 이후 반응을 분류한다 (단일 거래일 기반).
 *
 * @param {object} input - { vviIdx, breakoutIdx }  (둘 다 rows 배열의 index)
 * @param {Array} rows - chart rows ascending by date (각 row: open/high/low/close/volume/valueApprox/date)
 * @returns {object|null} { vprMain, vprTags, vprDescription, vprBaseClose, vprBreakoutLine,
 *                          vprDistanceFromBasePct, vprDistanceFromBreakoutPct, vprClosePosition } 또는 null
 */
function analyzeBreakoutReaction(input, rows) {
  const { vviIdx, breakoutIdx } = input || {};
  if (!Number.isFinite(vviIdx) || !Number.isFinite(breakoutIdx)) return null;
  if (vviIdx < 0 || breakoutIdx <= vviIdx || breakoutIdx >= rows.length) return null;

  const vviRow = rows[vviIdx];
  const breakoutRow = rows[breakoutIdx];
  if (!vviRow || !breakoutRow || !vviRow.close || !breakoutRow.close) return null;

  const baseClose = vviRow.close;
  const breakoutLine = baseClose * 1.01;
  const nextOpen = breakoutRow.open;
  const nextHigh = breakoutRow.high;
  const nextLow = breakoutRow.low;
  const nextClose = breakoutRow.close;
  const nextValue = breakoutRow.valueApprox || (breakoutRow.close * breakoutRow.volume) || 0;

  // VVI일 이전 20거래일 평균 거래대금
  const prevStart = Math.max(0, vviIdx - 20);
  const prevRows = rows.slice(prevStart, vviIdx);
  const prevValueAvg = prevRows.length > 0
    ? prevRows.reduce((s, r) => s + (r.valueApprox || (r.close * r.volume) || 0), 0) / prevRows.length
    : 0;

  // 안전장치: H그룹이 아니면 (다음날 고가 < 기준선) null 반환
  if (nextHigh < breakoutLine) return null;

  // closePosition (당일 가격 범위 내 종가 위치)
  const closePosition = (nextHigh === nextLow) ? 1 : (nextClose - nextLow) / (nextHigh - nextLow);
  const vprDistanceFromBasePct = (nextClose / baseClose - 1) * 100;
  const vprDistanceFromBreakoutPct = (nextClose / breakoutLine - 1) * 100;

  // ─── 메인 태그 결정 (우선순위 순) ───
  let vprMain;
  if (nextClose >= baseClose * 1.12) {
    vprMain = 'OVERHEATED_BREAKOUT';
  } else if (nextClose >= breakoutLine && closePosition >= 0.7) {
    vprMain = 'HIGH_ZONE_HOLD';
  } else if (nextClose >= breakoutLine) {
    vprMain = 'ABOVE_BREAKOUT_LINE';
  } else if (nextClose >= baseClose) {
    vprMain = 'ABOVE_BASE_CLOSE';
  } else {
    vprMain = 'INTRADAY_PUSHBACK';
  }

  // ─── 보조 태그 ───
  const vprTags = [];

  // 거래대금 폭발 / 동반 / 약함 — 상호배타 (폭발 > 동반)
  if (prevValueAvg > 0) {
    if (nextValue >= prevValueAvg * 3) vprTags.push('VOLUME_EXPLOSION');
    else if (nextValue >= prevValueAvg * 2) vprTags.push('VOLUME_SUPPORT');
    else if (nextValue < prevValueAvg) vprTags.push('VOLUME_WEAK');
  }

  // 갭상승 출발
  const isGapUp = nextOpen >= breakoutLine;
  if (isGapUp) {
    vprTags.push('GAP_UP_START');
    if (nextClose < nextOpen && nextClose >= baseClose) {
      vprTags.push('GAP_UP_WOBBLE');
    }
  }

  // 위꼬리 주의 — 장중 고점 대비 종가가 많이 내려옴
  if (nextHigh > nextClose * 1.05) vprTags.push('UPPER_WICK_WARN');

  // 위꼬리 적음
  if (closePosition >= 0.85) vprTags.push('UPPER_WICK_SMALL');

  // 아래꼬리 회복
  if (closePosition >= 0.7 && nextLow < baseClose) vprTags.push('LOWER_WICK_RECOVER');

  // 기준가 대비 거리 큼 (메인이 OVERHEATED인 경우 중복 의미이지만 보조 태그로도 부착 — spec 준수)
  if (nextClose >= baseClose * 1.12) vprTags.push('FAR_FROM_BASE');

  // 조용한 돌파 — 거래대금이 평균 이상이지만 2배 미만
  if (prevValueAvg > 0 && nextValue >= prevValueAvg && nextValue < prevValueAvg * 2) {
    vprTags.push('QUIET_BREAKOUT');
  }

  // ─── description 조합 ───
  const mainDesc = VPR_MAIN_DESCRIPTIONS[vprMain] || '';
  const tagDescs = vprTags.map(t => VPR_AUX_DESCRIPTIONS[t]).filter(Boolean);
  const description = [mainDesc, ...tagDescs].join(' ').trim();

  return {
    vprMain,
    vprMainLabel: VPR_MAIN_LABELS[vprMain],
    vprTags,
    vprTagLabels: vprTags.map(t => VPR_AUX_LABELS[t]),
    vprDescription: description,
    vprBaseClose: baseClose,
    vprBreakoutLine: round(breakoutLine, 2),
    vprDistanceFromBasePct: round(vprDistanceFromBasePct, 2),
    vprDistanceFromBreakoutPct: round(vprDistanceFromBreakoutPct, 2),
    vprClosePosition: round(closePosition * 100, 1),
  };
}

module.exports = {
  analyzeVPR,
  buildOneLineSummary,
  buildConflictNote,
  DEFAULT_CONFIG,
  VPR_LABELS,
  VPR_DESCRIPTIONS,
  MANAGEMENT_NOTE,
  // 신규 (돌파 이후 반응 분류)
  analyzeBreakoutReaction,
  VPR_MAIN_LABELS,
  VPR_MAIN_DESCRIPTIONS,
  VPR_AUX_LABELS,
  VPR_AUX_DESCRIPTIONS,
};
