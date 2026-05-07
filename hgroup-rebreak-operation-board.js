#!/usr/bin/env node
/**
 * D+5 재돌파 운용 보드
 *
 * 목적:
 *   가설 검증(hgroup-live-operation-hypothesis-report)에서 가장 강했던 시그널은 H돌파일 고가
 *   재돌파였다. 재돌파 있음 (n=186) 승률 75.27% / 매번 +6.83%, 재돌파 없음 (n=174) 승률 8.05% / 매번 -5.54%.
 *
 *   이 보드는 H그룹 D+0~D+5 후보를 대상으로 H돌파일 고가 재돌파 상태를 추적하는 운용 화면이다.
 *   매수 등급표가 아니라 재돌파 상태 + 기준 종가 이탈 여부를 추적한다.
 *
 * 입력:
 *   qva-watchlist-board.json (기존 H그룹 candidates, 수정하지 않음)
 *   cache/stock-charts-long/{code}.json (D+1~latest 가격 추적)
 *
 * 출력:
 *   reports/hgroup-rebreak-operation-board-result.json
 *   reports/hgroup-rebreak-operation-board-result.html
 *
 * 라우트: /d5-rebreak-board
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const BOARD_PATH = path.join(ROOT, 'qva-watchlist-board.json');
const OUT_JSON = path.join(REPORTS_DIR, 'hgroup-rebreak-operation-board-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'hgroup-rebreak-operation-board-result.html');

const MAX_DAYS = 5;

// 사용자 spec 2026-05-06: rebreak deep-dive 결과 반영. 상태 체계 8종.
// 종가 재돌파 = 가장 강한 시그널 / 장중만 = 부정 / 이탈 후 당일 회복 = 착시 (실제 약함).
const STATUS_LABELS = {
  TODAY_INITIAL_BREAKOUT: '오늘 H돌파일 (D+0)',
  CLOSE_REBREAK_NO_BREACH: '종가 재돌파 · 이탈 없음',
  CLOSE_REBREAK_VOL_EXPLOSION: '종가 재돌파 · 거래대금 폭발',
  CLOSE_REBREAK_HOLD_NEXTDAY: '종가 재돌파 · 다음날 유지',
  CLOSE_REBREAK_BREACH_RECOVER: '종가 재돌파 · 이탈 후 회복',
  INTRADAY_PUSHBACK: '장중만 돌파 후 밀림',
  BREACH_RECOVER_ILLUSION: '이탈 후 회복 착시',
  NO_REBREAK: '재돌파 없음',
  BREACH_NO_RECOVER: '이탈 후 회복 실패',
};
const STATUS_INTERPRETATIONS = {
  CLOSE_REBREAK_NO_BREACH: '검증상 가장 강했던 핵심 조건입니다 (n=126, 승률 89%, 매번 +9.41%).',
  CLOSE_REBREAK_VOL_EXPLOSION: '재돌파와 함께 거래대금이 크게 붙은 강한 모멘텀 구간입니다 (n=91, 승률 87%, 매번 +11%).',
  CLOSE_REBREAK_HOLD_NEXTDAY: '재돌파 이후에도 가격이 유지된 강한 후속 확인입니다 (n=165, 승률 88%, 매번 +9.08%).',
  CLOSE_REBREAK_BREACH_RECOVER: '이탈이 있었지만 재돌파까지 회복한 예외적 회복형입니다 (n=77, 승률 79%, 매번 +6.18%).',
  INTRADAY_PUSHBACK: '검증상 재돌파 없음과 비슷하게 약했던 구간입니다 (n=106, 승률 8.5%, 매번 -5.02%). 종가 재돌파 전까지는 재돌파로 인정하지 않습니다.',
  BREACH_RECOVER_ILLUSION: '겉으로는 회복처럼 보이지만 검증상 성과가 매우 약했던 구간입니다 (이탈 후 당일 회복 n=95, 승률 7.4%, 매번 -4.74%).',
  NO_REBREAK: '검증상 성과가 매우 약했던 구간입니다 (n=220, 승률 7%, 매번 -5.81%).',
  BREACH_NO_RECOVER: '검증상 가장 나빴던 제외 우선 구간입니다 (n=76, 승률 0%, 매번 -10.2%).',
  TODAY_INITIAL_BREAKOUT: '오늘이 H돌파일(D+0) 자체. 재돌파 추적은 D+1부터 시작.',
};
// 거래대금 강도 (재돌파일 valueRatio 기준)
const VOLUME_STRENGTH_LABELS = {
  EXPLOSION: '거래대금 폭발 (×5↑)',
  STRONG: '거래대금 강함 (×3↑)',
  SUPPORT: '거래대금 동반 (×2↑)',
  MILD: '거래대금 보통 이하',
};
function classifyVolumeStrength(valueRatio) {
  if (valueRatio == null) return null;
  if (valueRatio >= 5) return 'EXPLOSION';
  if (valueRatio >= 3) return 'STRONG';
  if (valueRatio >= 2) return 'SUPPORT';
  return 'MILD';
}
// 재돌파 후 거리 라벨 (사용자 spec 2026-05-06)
const REBREAK_DIST_LABELS = {
  POST_0_2: { label: '재돌파 직후', note: null },
  POST_2_5: { label: '재돌파 후 상승', note: null },
  POST_5_8: { label: '강한 모멘텀', note: '(참고: 표본 n<50)' },
  POST_8_12: { label: '강한 모멘텀 지속', note: '(참고: 표본 n<50)' },
  POST_12P: { label: '급등 모멘텀', note: '(참고: 표본 n<50)' },
};
function classifyRebreakDistance(distPct) {
  if (distPct == null) return null;
  if (distPct >= 12) return 'POST_12P';
  if (distPct >= 8) return 'POST_8_12';
  if (distPct >= 5) return 'POST_5_8';
  if (distPct >= 2) return 'POST_2_5';
  if (distPct >= 0) return 'POST_0_2';
  return null;  // 음수면 아직 재돌파 못 함
}

function round(v, d = 2) { if (v == null || !Number.isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function fmtNum(v) { return v != null ? Math.round(v).toLocaleString() : '-'; }
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8); }

function loadChart(code) {
  const p = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}

// 재돌파일 외국인/기관 순매수 금액 (cache/flow-history). 키 일치 안 하면 null.
// 사용자 spec(2026-05-06 hgroup-rebreak-flow-backtest 결과): 외국인/기관만 사용. 개인은 근사값이라 보드 태그 X.
function loadFlowRow(code, date) {
  if (!code || !date) return null;
  const p = path.join(FLOW_DIR, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const f = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (f.rows || []).find((r) => r.date === date) || null;
  } catch (_) { return null; }
}

// 수급 태그 산출 — 재돌파일에 외국인/기관 순매수가 함께 들어왔는지.
// 사용자 spec: 단순 순매수 여부만 보드에 표시. 비중 임계 3%/5%는 핵심 필터로 쓰지 않음.
//   1) 외국인 순매수 동반: foreignNetValue > 0 (검증 n=70, 92.86%, +10.12% — 단독에서 가장 강함)
//   2) 외인+기관 수급 동반: foreignNetValue + instNetValue > 0 (보조 태그)
//   3) 거래대금 폭발 + 수급 동반: rebreakValueRatio ≥ 5 + 외인+기관 합산 > 0 (별도 강조)
// 표시 우선순위: 외국인 단독 > 외인+기관 합산 (외국인 표시되면 합산은 중복 강조 안 함).
function computeFlowTags(flowRow, rebreakValueRatio) {
  if (!flowRow) return null;
  const foreignNet = Number(flowRow.foreignNetValue) || 0;
  const instNet = Number(flowRow.instNetValue) || 0;
  const sumNet = foreignNet + instNet;
  const foreignBuy = foreignNet > 0;
  const sumBuy = sumNet > 0;
  const volExplosionWithFlow = (rebreakValueRatio != null && rebreakValueRatio >= 5) && sumBuy;
  return {
    foreignNet, instNet, sumNet,
    foreignBuy, sumBuy, volExplosionWithFlow,
    // 표시용: 외국인 단독이 있으면 합산 배지는 숨김 (중복 강조 회피, 사용자 spec).
    showForeign: foreignBuy,
    showSum: !foreignBuy && sumBuy,
    showVolExplosionFlow: volExplosionWithFlow,
  };
}

// ─── 재돌파 상태 산출 ───
// 사용자 spec(2026-05-06): rebreak deep-dive 결과 반영 8단계 + D+0 분리.
// 우선순위:
//   D+0 → BREACH_NO_RECOVER → BREACH_RECOVER_ILLUSION → CLOSE_REBREAK_NO_BREACH
//   → CLOSE_REBREAK_VOL_EXPLOSION → CLOSE_REBREAK_HOLD_NEXTDAY
//   → CLOSE_REBREAK_BREACH_RECOVER → INTRADAY_PUSHBACK → NO_REBREAK
function computeRebreakStatus({ rows, hIdx, baseClose, hDayHigh, breakoutLine, latestIdx }) {
  let everClosedAboveHHigh = false;
  let everIntradayAboveHHigh = false;
  let everLowBelowBaseClose = false;
  let breakdownEverRecovered = false;  // 이탈 후 종가가 baseClose 이상으로 회복했는가
  let recoveredAboveBreakoutLine = false;
  let everPullbackToBreakoutLine = false;
  let firstRebreakDayOffset = null;
  let firstRebreakDate = null;
  let firstRebreakIdx = null;
  let seenBreach = false;

  for (let k = 1; hIdx + k <= latestIdx; k++) {
    const r = rows[hIdx + k];
    if (!r) continue;
    if (r.close >= hDayHigh) {
      everClosedAboveHHigh = true;
      if (firstRebreakDayOffset == null) {
        firstRebreakDayOffset = k;
        firstRebreakDate = r.date;
        firstRebreakIdx = hIdx + k;
      }
    }
    if (r.high >= hDayHigh) everIntradayAboveHHigh = true;
    if (r.low < baseClose) {
      everLowBelowBaseClose = true;
      seenBreach = true;
      if (r.close >= baseClose) breakdownEverRecovered = true;
    } else if (seenBreach && r.close >= baseClose) {
      breakdownEverRecovered = true;
    }
    if (r.low <= breakoutLine) everPullbackToBreakoutLine = true;
    if (r.close >= breakoutLine) recoveredAboveBreakoutLine = true;
  }

  // 재돌파일 거래대금 비율 (재돌파일 valueApprox / 직전 20거래일 평균)
  let rebreakValueRatio = null;
  if (firstRebreakIdx != null) {
    const todayVal = rows[firstRebreakIdx]?.valueApprox;
    if (todayVal && firstRebreakIdx >= 20) {
      let sum = 0, n = 0;
      for (let i = firstRebreakIdx - 20; i < firstRebreakIdx; i++) {
        const r = rows[i];
        if (r?.valueApprox) { sum += r.valueApprox; n++; }
      }
      const avg = n > 0 ? sum / n : null;
      if (avg && avg > 0) rebreakValueRatio = todayVal / avg;
    }
  }

  // 재돌파 다음날 종가 유지 여부 (재돌파일 다음날 종가 ≥ hDayHigh)
  let nextDayHoldAfterRebreak = null;
  if (firstRebreakIdx != null && firstRebreakIdx + 1 <= latestIdx) {
    const next = rows[firstRebreakIdx + 1];
    if (next && next.close != null) {
      nextDayHoldAfterRebreak = next.close >= hDayHigh;
    }
  }

  const lastRow = rows[latestIdx];
  const prevRow = latestIdx > 0 ? rows[latestIdx - 1] : null;
  const currentClose = lastRow ? lastRow.close : null;
  const currentHigh = lastRow ? lastRow.high : null;
  const currentLow = lastRow ? lastRow.low : null;
  const currentOpen = lastRow ? lastRow.open : null;
  const todayChangePct = (prevRow && lastRow && prevRow.close > 0)
    ? (lastRow.close / prevRow.close - 1) * 100 : null;
  const todayHighVsHHighPct = (lastRow && hDayHigh > 0)
    ? (lastRow.high / hDayHigh - 1) * 100 : null;
  const todayClosePosition = (lastRow && lastRow.high > lastRow.low)
    ? (lastRow.close - lastRow.low) / (lastRow.high - lastRow.low) * 100 : null;
  const todayUpperWickPct = (lastRow && lastRow.close > 0)
    ? (lastRow.high / lastRow.close - 1) * 100 : null;
  const currentlyAboveHHigh = currentClose != null && currentClose >= hDayHigh;
  // D+0 = 오늘이 H돌파일 그 자체 (latestIdx === hIdx). 재돌파 개념이 아직 적용 안 됨.
  const isTodayInitialBreakout = latestIdx === hIdx;

  // 상태 결정 — 우선순위 순으로 첫 매칭
  let status;
  if (isTodayInitialBreakout) {
    status = 'TODAY_INITIAL_BREAKOUT';
  } else if (everLowBelowBaseClose && !breakdownEverRecovered) {
    status = 'BREACH_NO_RECOVER';
  } else if (everLowBelowBaseClose && breakdownEverRecovered && !everClosedAboveHHigh) {
    status = 'BREACH_RECOVER_ILLUSION';
  } else if (everClosedAboveHHigh && !everLowBelowBaseClose) {
    status = 'CLOSE_REBREAK_NO_BREACH';
  } else if (everClosedAboveHHigh && rebreakValueRatio != null && rebreakValueRatio >= 5) {
    status = 'CLOSE_REBREAK_VOL_EXPLOSION';
  } else if (everClosedAboveHHigh && nextDayHoldAfterRebreak === true) {
    status = 'CLOSE_REBREAK_HOLD_NEXTDAY';
  } else if (everClosedAboveHHigh && everLowBelowBaseClose) {
    status = 'CLOSE_REBREAK_BREACH_RECOVER';
  } else if (everClosedAboveHHigh) {
    // fallback: 종가 재돌파했고 위 조건 어디에도 안 맞음 — 이탈 없음으로 처리
    status = 'CLOSE_REBREAK_NO_BREACH';
  } else if (everIntradayAboveHHigh) {
    status = 'INTRADAY_PUSHBACK';
  } else {
    status = 'NO_REBREAK';
  }

  // 거래대금 강도 분류
  const volumeStrength = classifyVolumeStrength(rebreakValueRatio);

  // 재돌파 후 거리 (현재 종가 vs hDayHigh)
  const postRebreakDistPct = (everClosedAboveHHigh && currentClose != null && hDayHigh)
    ? (currentClose / hDayHigh - 1) * 100 : null;
  const rebreakDistanceClass = classifyRebreakDistance(postRebreakDistPct);

  // "눌림 없이 상승" 부가 플래그 — 정렬에 활용 가능
  const noPullback = !everPullbackToBreakoutLine;

  return {
    status,
    everClosedAboveHHigh, everIntradayAboveHHigh,
    everLowBelowBaseClose, recoveredAboveBreakoutLine,
    breakdownEverRecovered,
    everPullbackToBreakoutLine, noPullback,
    firstRebreakDayOffset, firstRebreakDate,
    rebreakValueRatio: round(rebreakValueRatio),
    nextDayHoldAfterRebreak,
    volumeStrength,
    postRebreakDistPct: round(postRebreakDistPct),
    rebreakDistanceClass,
    currentClose, currentHigh, currentLow, currentOpen,
    todayChangePct: round(todayChangePct),
    todayHighVsHHighPct: round(todayHighVsHHighPct),
    todayClosePosition: round(todayClosePosition, 1),
    todayUpperWickPct: round(todayUpperWickPct),
    prevClose: prevRow ? prevRow.close : null,
    distanceToHHighPct: (currentClose != null && hDayHigh) ? round((currentClose / hDayHigh - 1) * 100) : null,
    aboveHDayHigh: currentlyAboveHHigh,
  };
}

// ─── 운용 코멘트 ───
function buildRunComments({ status, hasVolumeSupport, gapPct, noPullback, firstRebreakDate, firstRebreakDayOffset, vprMain, rebreakValueRatio, postRebreakDistPct, rebreakDistanceClass }) {
  const cmts = [];
  const rbInfo = (firstRebreakDate && firstRebreakDayOffset != null)
    ? `${firstRebreakDate.slice(0, 4)}-${firstRebreakDate.slice(4, 6)}-${firstRebreakDate.slice(6, 8)} (D+${firstRebreakDayOffset})`
    : null;

  if (status === 'TODAY_INITIAL_BREAKOUT') {
    cmts.push('오늘이 바로 H돌파일(D+0) 자체. 재돌파 추적은 내일(D+1)부터 — 오늘은 VPR + 종가 위치로 강도 확인.');
    if (vprMain === 'OVERHEATED_BREAKOUT') {
      cmts.push('VPR 과열 돌파 — 기준 종가 대비 +12% 이상 떠 있음. 내일 재돌파 시도 시 거래대금 동반 여부 확인.');
    } else if (vprMain === 'HIGH_ZONE_HOLD') {
      cmts.push('VPR 고가권 유지 — 종가 위치가 고가권에서 마감. 내일 H돌파일 고가 종가 재돌파가 핵심.');
    }
  } else if (status === 'CLOSE_REBREAK_NO_BREACH') {
    cmts.push((rbInfo ? `${rbInfo}에 ` : '') + '종가 재돌파 + 기준 종가 한 번도 이탈 없음. 검증상 가장 강했던 핵심 조건(n=126, 승률 89%, 매번 +9.41%).');
  } else if (status === 'CLOSE_REBREAK_VOL_EXPLOSION') {
    const vr = rebreakValueRatio != null ? `×${rebreakValueRatio.toFixed(1)}` : '폭발';
    cmts.push((rbInfo ? `${rbInfo}에 ` : '') + `종가 재돌파 + 재돌파일 거래대금 ${vr}. 검증상 강한 모멘텀 구간(n=91, 승률 87%, 매번 +11%).`);
  } else if (status === 'CLOSE_REBREAK_HOLD_NEXTDAY') {
    cmts.push((rbInfo ? `${rbInfo}에 ` : '') + '종가 재돌파 + 다음날 종가도 H돌파일 고가 위 유지. 강한 후속 확인(n=165, 승률 88%, 매번 +9.08%).');
  } else if (status === 'CLOSE_REBREAK_BREACH_RECOVER') {
    cmts.push((rbInfo ? `${rbInfo}에 ` : '') + '기준 종가 이탈이 한 번 있었지만 종가 재돌파까지 회복한 예외적 회복형(n=77, 승률 79%, 매번 +6.18%) — 이탈 안 한 본진(89%)보다는 약함.');
  } else if (status === 'INTRADAY_PUSHBACK') {
    cmts.push('장중 H돌파일 고가는 닿았지만 종가까지는 한 번도 못 마감. 검증상 재돌파 없음과 비슷하게 약했던 구간(n=106, 승률 8.5%, 매번 -5.02%) — 종가 재돌파 전까지는 재돌파로 인정 안 함.');
  } else if (status === 'BREACH_RECOVER_ILLUSION') {
    cmts.push('기준 종가 이탈한 뒤 종가는 회복했지만 H돌파일 고가까지는 종가 재돌파 못함. 회복처럼 보이지만 검증상 매우 약한 구간(이탈 후 당일 회복 n=95, 승률 7.4%, 매번 -4.74%) — 회복 착시.');
  } else if (status === 'NO_REBREAK') {
    cmts.push('아직 H돌파일 고가에 장중도 닿지 않은 상태. 검증상 매우 약한 구간(n=220, 승률 7%, 매번 -5.81%).');
  } else if (status === 'BREACH_NO_RECOVER') {
    cmts.push('기준 종가 이탈한 뒤 회복도 못 한 상태. 검증상 가장 나빴던 제외 우선 구간(n=76, 승률 0%, 매번 -10.2%).');
  }

  // 재돌파 후 거리 (긍정 4종 상태에서만 추가)
  const isCloseRebreak = status === 'CLOSE_REBREAK_NO_BREACH'
    || status === 'CLOSE_REBREAK_VOL_EXPLOSION'
    || status === 'CLOSE_REBREAK_HOLD_NEXTDAY'
    || status === 'CLOSE_REBREAK_BREACH_RECOVER';
  if (isCloseRebreak && rebreakDistanceClass && postRebreakDistPct != null) {
    const lab = REBREAK_DIST_LABELS[rebreakDistanceClass];
    if (lab) {
      cmts.push(`재돌파 후 거리 ${lab.label} (현재 +${postRebreakDistPct.toFixed(2)}%)${lab.note ? ' ' + lab.note : ''}.`);
    }
  }

  // 갭 해석 추가
  if (gapPct != null) {
    if (gapPct >= 8) cmts.push('큰 갭상승: 강한 모멘텀 가능성. 단, H돌파일 고가 위 유지 확인 필요.');
    else if (gapPct >= 5) cmts.push('중간 갭상승: 모멘텀 확인 구간.');
    else if (gapPct >= 0 && gapPct < 2) cmts.push('작은 갭: 과거 검증상 모멘텀이 약했던 구간.');
    else if (gapPct < 0) cmts.push('하락 출발: 기준 종가 이탈 여부 확인 필요.');
  }

  // 눌림 없이 상승 부가 (종가 재돌파 4종 + INTRADAY_PUSHBACK은 아닌 데이터에 한정)
  if (noPullback && isCloseRebreak) {
    cmts.push('D+1~현재까지 돌파 기준선 아래로 내려간 적 없는 강한 흐름.');
  }

  return cmts;
}

// ─── 착각 방지 해석 코멘트 ───
// "오늘 +7% 올랐는데 왜 재돌파 없음?" 같은 사용자 혼동을 자동으로 해소하는 한 줄.
// 오늘의 등락 + 시스템 상태가 어긋나 보일 때 그 이유를 설명한다.
function buildInterpretationComment(it) {
  const s = it.rebreakStatus;
  const chg = it.todayChangePct;
  const hvh = it.todayHighVsHHighPct;
  const cp = it.todayClosePosition;
  const wick = it.todayUpperWickPct;
  const fmtN = (v) => v != null ? Math.round(v).toLocaleString() : '-';
  const breakoutDateLabel = (it.breakoutDate || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');

  // D+0
  if (s === 'TODAY_INITIAL_BREAKOUT') {
    if (chg != null && chg >= 5) {
      return `오늘 +${chg.toFixed(1)}%로 큰 상승했지만, 오늘이 H돌파일(D+0) 자체라 ${fmtN(it.hDayHigh)}원은 "재돌파해야 할 기준"이 아니라 "내일부터 깨야 할 기준". 재돌파 추적은 D+1(내일)부터 시작.`;
    } else if (chg != null && chg < 0) {
      return `오늘이 H돌파일(D+0)인데 종가가 ${chg.toFixed(1)}%로 약함. 강한 H돌파라기보다 변동성 큰 상태 — 내일 흐름 보고 판단 필요.`;
    }
    return null;
  }
  // 재돌파 없음 + 오늘 큰 상승
  if (s === 'NO_REBREAK' && chg != null && chg >= 5 && hvh != null && hvh < -3) {
    return `오늘 +${chg.toFixed(1)}%로 잘 갔지만, H돌파일(${breakoutDateLabel}) 고가 ${fmtN(it.hDayHigh)}원까지는 ${Math.abs(hvh).toFixed(1)}% 모자랐음. 그래서 "재돌파 없음" — 오늘 상승과 시스템 상태는 별개로 봐야 함.`;
  }
  // 장중만 돌파 후 밀림 (긍정 색상 금지 — 검증상 매우 약함)
  if (s === 'INTRADAY_PUSHBACK') {
    if (wick != null && wick > 3) {
      return `장중 H돌파일 고가는 닿았지만 종가는 위꼬리 ${wick.toFixed(1)}%로 밀림. 검증상 종가 재돌파 못 한 "장중만"은 재돌파 없음과 비슷하게 약함(승률 8.5%, 매번 -5.02%) — 종가 재돌파 전까지는 추격 보류.`;
    }
    return `장중 H돌파일 고가는 닿았지만 종가는 못 닿음. 검증상 종가 재돌파 못 한 "장중만"은 재돌파 없음과 비슷하게 약함(승률 8.5%) — 종가 재돌파 전까지 재돌파로 인정 안 함.`;
  }
  // 이탈 후 회복 착시 — "회복처럼 보이지만 실제로는 매우 약함" 강조 (counterintuitive)
  if (s === 'BREACH_RECOVER_ILLUSION') {
    return `기준 종가(${fmtN(it.baseClose)}원) 이탈 뒤 종가는 회복했지만 H돌파일 고가(${fmtN(it.hDayHigh)}원)까지는 종가 재돌파 못 함. 겉으로는 회복처럼 보이지만 검증상 승률 7.4%로 매우 약했던 구간 — 회복 착시.`;
  }
  // 이탈 후 회복 실패
  if (s === 'BREACH_NO_RECOVER') {
    return `기준 종가(${fmtN(it.baseClose)}원) 이탈 뒤 회복도 못 한 상태. 통계상 가장 약한 영역(n=76, 승률 0%, 매번 -10.2%) — 신규 관찰 우선순위 최하.`;
  }
  // 종가 재돌파 + 이탈 없음 — 가장 강한 핵심
  if (s === 'CLOSE_REBREAK_NO_BREACH') {
    const dist = it.postRebreakDistPct != null ? ` 현재 +${it.postRebreakDistPct.toFixed(2)}%까지 떠 있음.` : '';
    return `H돌파일 고가 종가 재돌파 + 기준 종가 한 번도 이탈 없음. 검증상 가장 강했던 핵심 조건(n=126, 승률 89%, 매번 +9.41%).${dist}`;
  }
  // 종가 재돌파 + 거래대금 폭발
  if (s === 'CLOSE_REBREAK_VOL_EXPLOSION') {
    const vr = it.rebreakValueRatio != null ? `×${it.rebreakValueRatio.toFixed(1)}` : '5배 이상';
    return `H돌파일 고가 종가 재돌파 + 재돌파일 거래대금 ${vr} 폭발. 검증상 강한 모멘텀 구간(n=91, 승률 87%, 매번 +11%).`;
  }
  // 종가 재돌파 + 다음날 유지
  if (s === 'CLOSE_REBREAK_HOLD_NEXTDAY') {
    if (cp != null && cp >= 75) {
      return `H돌파일 고가 종가 재돌파 + 다음날도 유지 + 오늘 종가 위치 ${cp.toFixed(0)}% 고가권 마감. 검증상 강한 후속 확인 패턴(n=165, 승률 88%, 매번 +9.08%).`;
    }
    return `H돌파일 고가 종가 재돌파 + 다음날 종가도 H고 위 유지. 검증상 강한 후속 확인 패턴(n=165, 승률 88%, 매번 +9.08%).`;
  }
  // 종가 재돌파 + 이탈 후 회복
  if (s === 'CLOSE_REBREAK_BREACH_RECOVER') {
    return `기준 종가 이탈했지만 H돌파일 고가 종가 재돌파까지 회복한 예외적 회복형(n=77, 승률 79%, 매번 +6.18%) — 이탈 안 한 본진(89%)보다는 약함.`;
  }
  // 일반: 오늘 큰 상승 + 종가 위치 약함
  if (chg != null && chg >= 3 && cp != null && cp < 40) {
    return `오늘 +${chg.toFixed(1)}%로 강하게 출발했지만 종가 위치 ${cp.toFixed(0)}%로 마감 약화. 장중 강세가 종가까지 이어지지 않음.`;
  }
  return null;
}

function main() {
  if (!fs.existsSync(BOARD_PATH)) {
    console.error('[ERROR] qva-watchlist-board.json 없음. 먼저 `node qva-watchlist-board.js` 실행.');
    process.exit(1);
  }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log('\n📊 D+5 재돌파 운용 보드 생성');

  const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf-8'));
  const hgroup = (board.stages?.BREAKOUT_SUCCESS || [])
    .filter(c => (c.daysFromBreakout ?? Infinity) <= MAX_DAYS);
  console.log(`  H그룹 D+0~D+${MAX_DAYS}: ${hgroup.length}건`);

  const items = [];
  for (const c of hgroup) {
    const chart = loadChart(c.code);
    if (!chart) continue;
    const rows = chart.rows || [];
    const hIdx = rows.findIndex(r => r.date === c.breakoutDate);
    if (hIdx < 0) continue;
    const hRow = rows[hIdx];
    const latestIdx = rows.length - 1;
    const baseClose = c.vprBaseClose || c.vviClose;
    const breakoutLine = c.vprBreakoutLine || (baseClose ? round(baseClose * 1.01) : null);
    const hDayHigh = hRow?.high;
    const hDayLow = hRow?.low;
    if (!baseClose || !breakoutLine || !hDayHigh) continue;

    const reb = computeRebreakStatus({ rows, hIdx, baseClose, hDayHigh, breakoutLine, latestIdx });

    // 재돌파일 수급 (외국인/기관 순매수). 종가 재돌파가 발생한 케이스에서만 의미 있음.
    const flowRow = reb.firstRebreakDate ? loadFlowRow(c.code, reb.firstRebreakDate) : null;
    const flowTags = computeFlowTags(flowRow, reb.rebreakValueRatio);

    // 갭% — D+1 시가 vs baseClose (가설 검증과 동일 정의)
    const day1 = rows[hIdx + 1];
    const gapPct = day1?.open ? round((day1.open / baseClose - 1) * 100) : null;

    // 거래대금 동반 — H돌파일의 vprTags 기준
    const hasVolumeSupport = (c.vprTags || []).includes('VOLUME_SUPPORT') || (c.vprTags || []).includes('VOLUME_EXPLOSION');

    const distFromBase = baseClose ? round((reb.currentClose / baseClose - 1) * 100) : null;
    const distToHHigh = reb.distanceToHHighPct;  // 음수면 미돌파, 양수면 위

    const runComments = buildRunComments({
      status: reb.status,
      hasVolumeSupport,
      gapPct,
      noPullback: reb.noPullback,
      firstRebreakDate: reb.firstRebreakDate,
      firstRebreakDayOffset: reb.firstRebreakDayOffset,
      vprMain: c.vprMain,
      rebreakValueRatio: reb.rebreakValueRatio,
      postRebreakDistPct: reb.postRebreakDistPct,
      rebreakDistanceClass: reb.rebreakDistanceClass,
    });

    // 해석 코멘트 (착각 방지) — 마지막에 추가
    const interpretation = buildInterpretationComment({
      rebreakStatus: reb.status,
      breakoutDate: c.breakoutDate,
      hDayHigh, baseClose,
      todayChangePct: reb.todayChangePct,
      todayHighVsHHighPct: reb.todayHighVsHHighPct,
      todayClosePosition: reb.todayClosePosition,
      todayUpperWickPct: reb.todayUpperWickPct,
      firstRebreakDate: reb.firstRebreakDate,
      rebreakValueRatio: reb.rebreakValueRatio,
      postRebreakDistPct: reb.postRebreakDistPct,
    });

    const rebreakDistLabelObj = reb.rebreakDistanceClass ? REBREAK_DIST_LABELS[reb.rebreakDistanceClass] : null;
    items.push({
      code: c.code, name: c.name, market: c.market,
      breakoutDate: c.breakoutDate, daysFromBreakout: c.daysFromBreakout,
      vprMain: c.vprMain, vprMainLabel: c.vprMainLabel,
      vprTags: c.vprTags || [], vprTagLabels: c.vprTagLabels || [],
      interpretation,  // 착각 방지 해석 코멘트 (한 줄)
      baseClose, breakoutLine, hDayHigh, hDayLow,
      currentClose: reb.currentClose,
      distFromBase,
      distToHHigh,
      aboveHDayHigh: reb.aboveHDayHigh,
      belowBaseClose: reb.currentClose != null && reb.currentClose < baseClose,
      hasVolumeSupport,
      gapPct,
      rebreakStatus: reb.status,
      rebreakStatusLabel: STATUS_LABELS[reb.status] || reb.status,
      rebreakStatusInterp: STATUS_INTERPRETATIONS[reb.status] || null,
      everClosedAboveHHigh: reb.everClosedAboveHHigh,
      everIntradayAboveHHigh: reb.everIntradayAboveHHigh,
      everLowBelowBaseClose: reb.everLowBelowBaseClose,
      breakdownEverRecovered: reb.breakdownEverRecovered,
      noPullback: reb.noPullback,
      firstRebreakDayOffset: reb.firstRebreakDayOffset,
      firstRebreakDate: reb.firstRebreakDate,
      rebreakValueRatio: reb.rebreakValueRatio,
      volumeStrength: reb.volumeStrength,
      volumeStrengthLabel: reb.volumeStrength ? VOLUME_STRENGTH_LABELS[reb.volumeStrength] : null,
      nextDayHoldAfterRebreak: reb.nextDayHoldAfterRebreak,
      postRebreakDistPct: reb.postRebreakDistPct,
      rebreakDistanceClass: reb.rebreakDistanceClass,
      rebreakDistanceLabel: rebreakDistLabelObj ? rebreakDistLabelObj.label : null,
      rebreakDistanceNote: rebreakDistLabelObj ? rebreakDistLabelObj.note : null,
      // 재돌파일 수급 태그 (외국인/기관 단순 순매수 여부)
      flowTags,
      flowRebreakDate: reb.firstRebreakDate,
      // 오늘 흐름
      todayOpen: reb.currentOpen,
      todayHigh: reb.currentHigh,
      todayLow: reb.currentLow,
      prevClose: reb.prevClose,
      todayChangePct: reb.todayChangePct,
      todayHighVsHHighPct: reb.todayHighVsHHighPct,
      todayClosePosition: reb.todayClosePosition,
      todayUpperWickPct: reb.todayUpperWickPct,
      runComments,
    });
  }

  // ─── 정렬 (사용자 spec 2026-05-06: 긍정 위 / 부정 하단) ───
  function sortRank(it) {
    const s = it.rebreakStatus;
    if (s === 'TODAY_INITIAL_BREAKOUT') return 0;          // 오늘 H돌파 — 가장 위 (신선한 신규)
    if (s === 'CLOSE_REBREAK_NO_BREACH') return 1;         // 핵심 긍정 (이탈 없음 + 재돌파)
    if (s === 'CLOSE_REBREAK_VOL_EXPLOSION') return 2;     // 거래대금 폭발
    if (s === 'CLOSE_REBREAK_HOLD_NEXTDAY') return 3;      // 다음날 유지
    if (s === 'CLOSE_REBREAK_BREACH_RECOVER') return 4;    // 이탈 후 회복형
    if (s === 'INTRADAY_PUSHBACK') return 5;               // 주의 (장중만)
    if (s === 'NO_REBREAK') return 6;                      // 하단 (재돌파 없음)
    if (s === 'BREACH_RECOVER_ILLUSION') return 7;         // 하단 (회복 착시)
    if (s === 'BREACH_NO_RECOVER') return 8;               // 가장 하단 (이탈 후 회복 실패)
    return 9;
  }
  items.sort((a, b) => {
    const ra = sortRank(a), rb = sortRank(b);
    if (ra !== rb) return ra - rb;
    // 같은 그룹 내: 돌파일 최신순 → 거리 작은 순
    const da = a.breakoutDate || '00000000', db = b.breakoutDate || '00000000';
    if (da !== db) return db.localeCompare(da);
    return Math.abs(a.distFromBase || 0) - Math.abs(b.distFromBase || 0);
  });

  // ─── 콘솔 출력 ───
  console.log(`\n=== 재돌파 운용 보드 ===`);
  for (const it of items) {
    console.log(`[${it.name} ${it.code}] D+${it.daysFromBreakout} ${it.rebreakStatusLabel}${it.hasVolumeSupport ? ' + 거래대금동반' : ''}`);
    console.log(`  현재 ${fmtNum(it.currentClose)}원 / H고 ${fmtNum(it.hDayHigh)}원 (남은거리 ${it.distToHHigh}%) / 기준종가 ${fmtNum(it.baseClose)}원`);
    console.log(`  거리 ${it.distFromBase}% · 갭% ${it.gapPct ?? '-'} · VPR ${it.vprMainLabel || '-'}`);
    if (it.runComments.length) {
      for (const c of it.runComments) console.log(`  💬 ${c}`);
    }
    console.log('');
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'D+5 재돌파 운용 보드',
      purpose: '이 보드는 H그룹 발생 후 D+5 안에 H돌파일 고가를 재돌파하는지 추적하는 운용 보드입니다. 백테스트에서는 H돌파일 고가 재돌파 여부가 D+5 성과를 가장 크게 갈랐습니다. 단, 재돌파는 사전에 확정되는 값이 아니라 장중 또는 종가 기준으로 확인되는 상태이므로, 이 화면은 매수 등급표가 아니라 재돌파 상태와 기준 종가 이탈 여부를 추적하는 보드입니다.',
      sourceBoard: 'qva-watchlist-board.json (BREAKOUT_SUCCESS, D+0~D+5)',
      latestTradingDate: board.debugCounts?.latestTradingDate,
    },
    counts: { total: hgroup.length, effective: items.length },
    statusLabels: STATUS_LABELS,
    backtest: {
      positive: [
        { label: '재돌파 + 거래대금 동반', n: 160, winRate: 74.38, avgClose5: 7.08 },
        { label: '재돌파 있음', n: 186, winRate: 75.27, avgClose5: 6.83 },
        { label: '눌림 없이 상승', n: 162, winRate: 64.20, avgClose5: 5.12 },
      ],
      negative: [
        { label: '재돌파 없음', n: 174, winRate: 8.05, avgClose5: -5.54 },
        { label: '기준 종가 이탈 후 회복 실패', n: 72, winRate: 0, avgClose5: -9.02 },
      ],
      gap: [
        { label: 'gap ≥ 8 (큰 갭상승)', n: 103, winRate: 50.49, avgClose5: 2.45 },
        { label: '0~2% 작은 갭', n: 94, winRate: 34.04, avgClose5: -1.28 },
      ],
    },
    items,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>D+5 재돌파 운용 보드</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px; -webkit-overflow-scrolling: touch;
}
nav { display:flex; gap:10px; flex-wrap:wrap; padding:8px 0 14px; border-bottom:1px solid #1e293b; margin-bottom:14px; }
nav a { color:#94a3b8; text-decoration:none; font-size:12px; padding:4px 8px; border-radius:4px; }
nav a:hover { color:#e2e8f0; background:#1e293b; }
nav a.active { color:#f1f5f9; background:#1e293b; }

h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #0f172a; border-left: 3px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

.bt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; margin-bottom: 14px; }
.bt-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.bt-card.pos { border-left: 3px solid #14b8a6; }
.bt-card.neg { border-left: 3px solid #ef4444; }
.bt-card.gap { border-left: 3px solid #f59e0b; }
.bt-card h4 { margin: 0 0 6px; font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.bt-card .row { font-size: 12px; line-height: 1.7; color: #cbd5e1; display: flex; justify-content: space-between; }
.bt-card .row .lab { color: #cbd5e1; }
.bt-card .row .val { color: #f1f5f9; font-weight: 600; font-variant-numeric: tabular-nums; }
.bt-card .row.pos .val { color: #6ee7b7; }
.bt-card .row.neg .val { color: #fca5a5; }

.card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.card h3 { margin: 0 0 6px; font-size: 15px; color: #f1f5f9; font-weight: 700; }
.card .meta { font-size: 11px; color: #94a3b8; margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.card .meta .badge { display:inline-block; padding:2px 7px; border-radius:3px; font-size:11px; font-weight:600; }
/* 사용자 spec 2026-05-06: rebreak deep-dive 8단계
   긍정 4종 (CLOSE_REBREAK_*) = emerald/teal 그라데이션
   주의 = INTRADAY_PUSHBACK (장중만 = 긍정 색 사용 금지)
   부정 = NO_REBREAK / BREACH_RECOVER_ILLUSION / BREACH_NO_RECOVER */
.card.s-TODAY_INITIAL_BREAKOUT       { border-left: 5px solid #c4b5fd; }
.card.s-CLOSE_REBREAK_NO_BREACH      { border-left: 6px solid #10b981; box-shadow: -3px 0 12px -8px #10b981; } /* 핵심 긍정 */
.card.s-CLOSE_REBREAK_VOL_EXPLOSION  { border-left: 6px solid #14b8a6; box-shadow: -3px 0 12px -8px #14b8a6; }
.card.s-CLOSE_REBREAK_HOLD_NEXTDAY   { border-left: 5px solid #34d399; }
.card.s-CLOSE_REBREAK_BREACH_RECOVER { border-left: 5px solid #5eead4; }
.card.s-INTRADAY_PUSHBACK            { border-left: 5px solid #f59e0b; opacity: 0.92; } /* 주의 (긍정 X) */
.card.s-NO_REBREAK                   { border-left: 5px solid #94a3b8; opacity: 0.88; }
.card.s-BREACH_RECOVER_ILLUSION      { border-left: 5px solid #fb923c; opacity: 0.88; } /* 회복 착시 */
.card.s-BREACH_NO_RECOVER            { border-left: 5px solid #ef4444; opacity: 0.85; }

.badge.st-TODAY_INITIAL_BREAKOUT       { background: #312e81; color: #c4b5fd; border: 1px solid #818cf8; font-weight: 700; }
.badge.st-CLOSE_REBREAK_NO_BREACH      { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; font-weight: 700; }
.badge.st-CLOSE_REBREAK_VOL_EXPLOSION  { background: #134e4a; color: #5eead4; border: 1px solid #14b8a6; font-weight: 700; }
.badge.st-CLOSE_REBREAK_HOLD_NEXTDAY   { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }
.badge.st-CLOSE_REBREAK_BREACH_RECOVER { background: #134e4a; color: #5eead4; border: 1px solid #14b8a6; }
.badge.st-INTRADAY_PUSHBACK            { background: #422006; color: #fde047; border: 1px solid #ca8a04; }
.badge.st-NO_REBREAK                   { background: #1e293b; color: #cbd5e1; border: 1px solid #475569; }
.badge.st-BREACH_RECOVER_ILLUSION      { background: #7c2d12; color: #fdba74; border: 1px solid #f97316; }
.badge.st-BREACH_NO_RECOVER            { background: #7f1d1d; color: #fca5a5; border: 1px solid #ef4444; }
/* lifecycle 배지 — D+N + 남은 거래일. D+4/D+5 + 약한 상태에서는 "재돌파 미확정"/"의미 약화" suffix가 붙는다. */
.badge.lc-d0                           { background: #134e4a; color: #67e8f9; border: 1px solid #06b6d4; font-weight: 700; }
.badge.lc-mid                          { background: #1e293b; color: #cbd5e1; border: 1px solid #475569; }
.badge.lc-d4                           { background: #422006; color: #fdba74; border: 1px solid #f97316; font-weight: 700; }
.badge.lc-d5                           { background: #3f1d1d; color: #fca5a5; border: 1px solid #ef4444; font-weight: 700; }
.badge.rebreak-date                    { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; font-size: 10px; }
.badge.vol     { background: #422006; color: #fbbf24; border: 1px solid #f59e0b; }
.badge.vol-explosion { background: #7c2d12; color: #fef3c7; border: 1px solid #f97316; font-weight: 700; box-shadow: 0 0 0 1px #f59e0b inset; } /* 거래대금 폭발 별도 강조 */
.badge.vol-strong    { background: #422006; color: #fde047; border: 1px solid #ca8a04; }
.badge.vol-support   { background: #422006; color: #fbbf24; border: 1px solid #f59e0b; }
.badge.no-breach { background: #064e3b; color: #a7f3d0; border: 1px solid #10b981; font-weight: 700; } /* 기준 종가 이탈 없음 핵심 긍정 태그 */
.badge.no-pull { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }
/* 수급 태그 (사용자 spec 2026-05-06 hgroup-rebreak-flow-backtest 결과 반영) */
.badge.flow-foreign      { background: #1e3a8a; color: #bfdbfe; border: 1px solid #3b82f6; font-weight: 700; box-shadow: 0 0 0 1px #60a5fa inset; } /* 외국인 단독 — 가장 우선, 강한 강조 */
.badge.flow-sum          { background: #1e293b; color: #93c5fd; border: 1px solid #475569; }                                                          /* 외인+기관 합산 — 보조, 차분한 톤 */
.badge.flow-vol-explosion{ background: #4c1d95; color: #ddd6fe; border: 1px solid #8b5cf6; font-weight: 700; box-shadow: 0 0 0 1px #a78bfa inset; }   /* 거래대금 폭발 + 수급 동반 — 별도 강조 */
.badge.dist-soft  { background: #134e4a; color: #5eead4; border: 1px solid #14b8a6; }
.badge.dist-strong{ background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }
.badge.aux     { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; }
.badge.vpr-HIGH_ZONE_HOLD       { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }
.badge.vpr-ABOVE_BREAKOUT_LINE  { background: #134e4a; color: #5eead4; }
.badge.vpr-ABOVE_BASE_CLOSE     { background: #312e81; color: #c7d2fe; }
.badge.vpr-INTRADAY_PUSHBACK    { background: #422006; color: #fde047; border: 1px solid #ca8a04; }
.badge.vpr-OVERHEATED_BREAKOUT  { background: #7c2d12; color: #fdba74; border: 1px solid #f97316; }

.price-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 8px 0; }
.price-cell { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; }
.price-cell .label { font-size: 10px; color: #94a3b8; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.3px; }
.price-cell .value { font-size: 14px; font-weight: 600; color: #e2e8f0; font-variant-numeric: tabular-nums; }
.price-cell .sub { font-size: 10px; color: #64748b; margin-top: 2px; }
.price-cell.k-current { border-left: 3px solid #c4b5fd; }
.price-cell.k-hhigh   { border-left: 3px solid #6ee7b7; }
.price-cell.k-base    { border-left: 3px solid #f59e0b; }
.price-cell.k-line    { border-left: 3px solid #38bdf8; }
.price-cell.k-gap     { border-left: 3px solid #fbbf24; }

.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }

.today-flow { margin-top: 10px; padding: 8px 12px; background: #0f172a; border-left: 2px solid #c4b5fd; border-radius: 4px; font-size: 12px; line-height: 1.7; color: #cbd5e1; }
.today-flow .ohlc { font-family: ui-monospace, monospace; font-size: 11px; color: #94a3b8; }
.today-flow strong { color: #e2e8f0; }
.interpretation-box { margin-top: 8px; padding: 10px 14px; background: #1e1b4b; border-left: 3px solid #fbbf24; border-radius: 4px; font-size: 12px; line-height: 1.7; color: #fde68a; }
.interpretation-box::before { content: '💡 '; font-weight: 700; }
.run-comments { margin-top: 10px; padding: 8px 12px; background: #0f172a; border-left: 2px solid #475569; border-radius: 4px; font-size: 12px; line-height: 1.7; color: #cbd5e1; }
.run-comments .empty { color: #64748b; font-style: italic; }

.empty-list { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 24px; text-align: center; color: #64748b; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; }
  .price-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
</head>
<body>

<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/rebreak" class="active">🔥 D+5 재돌파 운용</a>
  <a href="/one-day-surge-board">⚡ 1DS 단타 후보</a>
  <a href="/qva-vvi-redefined-board">🎯 QVA 고점 재돌파</a>
  <a href="/rebreak-deep">🔬 재돌파 심층 검증</a>
</nav>

<h1>🔥 D+5 재돌파 운용 보드</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  이 보드는 H그룹 발생 후 D+5 안에 <strong>H돌파일 고가를 재돌파하는지 추적</strong>하는 운용 보드입니다.
  백테스트에서는 H돌파일 고가 재돌파 여부가 D+5 성과를 가장 크게 갈랐습니다 (재돌파 있음 승률 75% / 매번 +6.83% vs 없음 8% / -5.54%).
  단, 재돌파는 사전에 확정되는 값이 아니라 장중 또는 종가 기준으로 확인되는 상태이므로, 이 화면은
  <strong>매수 등급표가 아니라 재돌파 상태와 기준 종가 이탈 여부를 추적하는 보드</strong>입니다.
</div>

<div class="purpose-box" style="border-left-color:#60a5fa;">
  💱 <strong>수급 태그 안내</strong> — 현재 수급 태그는 외국인·기관 순매수 데이터를 기준으로 계산합니다.
  개인 수급은 근사값이며, 프로그램 매매 데이터는 포함하지 않습니다.
  따라서 <strong>개인 과열 주의 / 손바뀜 수급 / 프로그램 수급</strong> 태그는 보드에 표시하지 않습니다.
</div>

<h2>📊 백테스트 핵심 시그널 (3년·n=448)</h2>
<div class="bt-grid" id="bt-grid"></div>

<h2 id="hd">🔥 H그룹 D+5 이내 종목별 재돌파 추적</h2>
<div id="cards"></div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtNum(v) { return v != null ? Math.round(v).toLocaleString() : '-'; }
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8); }
function fmtPct(v, prec) {
  if (v == null) return '-';
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(prec || 2) + '%';
}

document.getElementById('subtitle').textContent =
  'H그룹 D+0~D+5 종목 ' + DATA.counts.effective + '건 · ' +
  '기준일: ' + (DATA.meta.latestTradingDate ? fmtDate(DATA.meta.latestTradingDate) : '-') + ' · ' +
  '생성: ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

// 백테스트 카드
function renderBacktest() {
  const html = [];
  // 긍정
  html.push('<div class="bt-card pos"><h4>핵심 긍정 시그널</h4>');
  for (const x of DATA.backtest.positive) {
    html.push('<div class="row pos"><span class="lab">' + x.label + '</span><span class="val">n=' + x.n + ' / ' + x.winRate + '% / ' + fmtPct(x.avgClose5) + '</span></div>');
  }
  html.push('</div>');
  // 부정
  html.push('<div class="bt-card neg"><h4>핵심 부정 시그널</h4>');
  for (const x of DATA.backtest.negative) {
    html.push('<div class="row neg"><span class="lab">' + x.label + '</span><span class="val">n=' + x.n + ' / ' + x.winRate + '% / ' + fmtPct(x.avgClose5) + '</span></div>');
  }
  html.push('</div>');
  // 갭
  html.push('<div class="bt-card gap"><h4>갭 해석</h4>');
  for (const x of DATA.backtest.gap) {
    html.push('<div class="row"><span class="lab">' + x.label + '</span><span class="val">n=' + x.n + ' / ' + x.winRate + '% / ' + fmtPct(x.avgClose5) + '</span></div>');
  }
  html.push('</div>');
  document.getElementById('bt-grid').innerHTML = html.join('');
}
renderBacktest();

function buildTodayFlowHtml(it) {
  if (it.todayChangePct == null && !it.todayOpen) return '';
  const chg = it.todayChangePct;
  const chgCls = chg > 0 ? 'cell-pos' : (chg < 0 ? 'cell-neg' : '');
  const chgStr = chg != null ? '<span class="' + chgCls + '"><strong>' + (chg > 0 ? '+' : '') + chg.toFixed(2) + '%</strong></span>' : '-';
  const ohlcStr = it.todayOpen != null
    ? '<span class="ohlc">시 ' + fmtNum(it.todayOpen) + ' · 고 ' + fmtNum(it.todayHigh) + ' · 저 ' + fmtNum(it.todayLow) + ' · 종 ' + fmtNum(it.currentClose) + '</span>'
    : '';
  const prevStr = it.prevClose != null ? '<span class="ohlc">전일 ' + fmtNum(it.prevClose) + ' → 오늘 종가 ' + fmtNum(it.currentClose) + '</span>' : '';

  // 오늘 H돌파일 고가 도달 코멘트
  const notes = [];
  if (it.todayHighVsHHighPct != null && it.hDayHigh) {
    const hvh = it.todayHighVsHHighPct;
    if (hvh >= 0) {
      notes.push('장중 H돌파일 고가(' + fmtNum(it.hDayHigh) + ') <span class="cell-pos">+' + hvh.toFixed(2) + '%</span> 돌파');
    } else if (hvh >= -3) {
      notes.push('장중 H돌파일 고가(' + fmtNum(it.hDayHigh) + ')까지 <span class="cell-pos">' + hvh.toFixed(2) + '%</span> 근접');
    } else {
      notes.push('장중 H돌파일 고가(' + fmtNum(it.hDayHigh) + ') 대비 ' + hvh.toFixed(2) + '%');
    }
  }
  // 종가 위치
  if (it.todayClosePosition != null) {
    const cp = it.todayClosePosition;
    if (cp >= 80) notes.push('종가 위치 <span class="cell-pos">' + cp.toFixed(0) + '% (고가권 마감)</span>');
    else if (cp >= 50) notes.push('종가 위치 ' + cp.toFixed(0) + '% (중간권)');
    else notes.push('종가 위치 <span class="cell-neg">' + cp.toFixed(0) + '% (저가권 마감)</span>');
  }
  // 위꼬리
  if (it.todayUpperWickPct != null && it.todayUpperWickPct >= 5) {
    notes.push('위꼬리 <span class="cell-neg">+' + it.todayUpperWickPct.toFixed(1) + '% (고점 대비 매도 압력)</span>');
  } else if (it.todayUpperWickPct != null && it.todayUpperWickPct < 1) {
    notes.push('위꼬리 거의 없음 (강한 마감)');
  }

  return '<div class="today-flow">' +
    '📊 <strong>오늘 흐름</strong>: ' + prevStr + ' = ' + chgStr +
    (ohlcStr ? '<br>' + ohlcStr : '') +
    (notes.length ? '<br>' + notes.join(' · ') : '') +
    '</div>';
}

// lifecycle 배지: D+N · 남은 X거래일 (사용자 spec 2026-05-07).
// 약한 상태(NO_REBREAK / INTRADAY_PUSHBACK / BREACH_RECOVER_ILLUSION / BREACH_NO_RECOVER) +
// D+4/D+5 조합에만 "재돌파 미확정" / "의미 약화" suffix를 붙여 우선순위를 자연스럽게 낮춘다.
const WEAK_REBREAK_STATUS = new Set(['NO_REBREAK','INTRADAY_PUSHBACK','BREACH_RECOVER_ILLUSION','BREACH_NO_RECOVER']);
function buildLifecycleBadge(it) {
  const d = Math.max(0, it.daysFromBreakout ?? 0);
  let label, cls;
  if (d === 0)      { label = 'D+0 · 오늘 H돌파일';     cls = 'lc-d0'; }
  else if (d >= 5)  { label = 'D+5 · 오늘 종료 예정';   cls = 'lc-d5'; }
  else if (d === 4) { label = 'D+4 · 남은 1거래일';     cls = 'lc-d4'; }
  else              { label = 'D+' + d + ' · 남은 ' + (5 - d) + '거래일'; cls = 'lc-mid'; }
  if ((d === 4 || d >= 5) && WEAK_REBREAK_STATUS.has(it.rebreakStatus)) {
    label += ' · ' + (d === 4 ? '재돌파 미확정' : '의미 약화');
  }
  return '<span class="badge ' + cls + '">' + label + '</span>';
}

// 카드 렌더
function renderCards() {
  const items = DATA.items || [];
  if (items.length === 0) {
    document.getElementById('cards').innerHTML = '<div class="empty-list">현재 D+5 이내 H그룹 종목이 없습니다.</div>';
    return;
  }
  document.getElementById('hd').textContent = '🔥 H그룹 D+5 이내 종목별 재돌파 추적 (' + items.length + '건)';
  const html = [];
  for (const it of items) {
    const tagsHtml = (it.vprTagLabels || []).map(t => '<span class="badge aux">' + t + '</span>').join('');
    const cmts = it.runComments || [];
    const cmtsHtml = cmts.length
      ? cmts.map(c => '<div>💬 ' + c + '</div>').join('')
      : '<div class="empty">— 별도 운용 코멘트 없음 —</div>';
    const distHHigh = it.distToHHigh != null ? fmtPct(it.distToHHigh) : '-';
    const distHHighCls = it.distToHHigh != null && it.distToHHigh >= 0 ? 'cell-pos' : 'cell-neg';
    const distFromBaseCls = it.distFromBase != null && it.distFromBase >= 0 ? 'cell-pos' : 'cell-neg';
    const gapCls = it.gapPct != null && it.gapPct >= 5 ? 'cell-pos' : (it.gapPct != null && it.gapPct < 0 ? 'cell-neg' : '');

    const closeRebreakSet = new Set(['CLOSE_REBREAK_NO_BREACH','CLOSE_REBREAK_VOL_EXPLOSION','CLOSE_REBREAK_HOLD_NEXTDAY','CLOSE_REBREAK_BREACH_RECOVER']);
    const isRebrokeAlready = closeRebreakSet.has(it.rebreakStatus);
    const isTodayD0 = it.rebreakStatus === 'TODAY_INITIAL_BREAKOUT';
    const rebreakBadgeHtml = isRebrokeAlready && it.firstRebreakDate
      ? '<span class="badge rebreak-date">📅 재돌파일 ' + fmtDate(it.firstRebreakDate) + ' (D+' + (it.firstRebreakDayOffset ?? '?') + ')</span>'
      : '';

    // 거래대금 강도 배지 (재돌파일 valueRatio 기반) — EXPLOSION만 별도 강조
    let volStrengthHtml = '';
    if (it.volumeStrength && it.rebreakValueRatio != null) {
      const cls = it.volumeStrength === 'EXPLOSION' ? 'vol-explosion'
                : it.volumeStrength === 'STRONG'    ? 'vol-strong'
                : it.volumeStrength === 'SUPPORT'   ? 'vol-support'
                : null;
      if (cls && it.volumeStrength !== 'MILD') {
        volStrengthHtml = '<span class="badge ' + cls + '">' + it.volumeStrengthLabel + ' (재돌파일 ×' + it.rebreakValueRatio.toFixed(1) + ')</span>';
      }
    }

    // 기준 종가 이탈 없음 — 핵심 긍정 태그 (사용자 spec)
    const noBreachHtml = (isRebrokeAlready && !it.everLowBelowBaseClose)
      ? '<span class="badge no-breach">기준 종가 이탈 없음</span>'
      : '';

    // 수급 태그 — 종가 재돌파 그룹에 한정. 사용자 spec 2026-05-06 hgroup-rebreak-flow-backtest 결과:
    //   • 외국인 단독: n=70, 92.86%, +10.12% (가장 강함 → 최우선 강조)
    //   • 외인+기관 합산: 보조 (외국인 단독 표시되면 합산은 숨김 — 중복 강조 회피)
    //   • 거래대금 폭발 + 수급 동반: n=69, 88.41%, +11.15% (별도 강조)
    let flowTagsHtml = '';
    if (isRebrokeAlready && it.flowTags) {
      const parts = [];
      if (it.flowTags.showForeign) {
        parts.push('<span class="badge flow-foreign" title="재돌파일에 외국인 순매수가 함께 들어온 상태입니다. 검증상 종가 재돌파·이탈 없음 조건과 결합될 때 수익 비율이 더 높았습니다 (n=70, 92.86%, +10.12%).">💱 외국인 순매수 동반</span>');
      }
      if (it.flowTags.showVolExplosionFlow) {
        parts.push('<span class="badge flow-vol-explosion" title="거래대금이 평소보다 크게 터지고 외인/기관 수급도 동반된 상태입니다 (n=69, 88.41%, 평균 +11.15%). 강한 모멘텀 참고 태그 — 매수 확정 신호 아님.">🔥 거래대금 폭발 + 수급 동반</span>');
      }
      if (it.flowTags.showSum) {
        parts.push('<span class="badge flow-sum" title="재돌파일에 외국인과 기관 합산 순매수가 양수인 상태입니다.">외인+기관 수급 동반</span>');
      }
      flowTagsHtml = parts.join('');
    }

    // 재돌파 후 거리 라벨
    const distLabelHtml = (isRebrokeAlready && it.rebreakDistanceLabel && it.postRebreakDistPct != null)
      ? '<span class="badge ' + (it.rebreakDistanceClass === 'POST_0_2' || it.rebreakDistanceClass === 'POST_2_5' ? 'dist-soft' : 'dist-strong') + '">' + it.rebreakDistanceLabel + ' (+' + it.postRebreakDistPct.toFixed(1) + '%)' + (it.rebreakDistanceNote ? ' ' + it.rebreakDistanceNote : '') + '</span>'
      : '';

    let hHighSubText;
    if (isTodayD0) {
      hHighSubText = '오늘 H돌파일 자체 — 종가 ' + fmtNum(it.currentClose) + '원 (고가 대비 <span class="' + distHHighCls + '">' + distHHigh + '</span>) · 저가 ' + fmtNum(it.hDayLow);
    } else if (isRebrokeAlready && it.firstRebreakDate) {
      hHighSubText = '재돌파 ' + fmtDate(it.firstRebreakDate) + ' (D+' + (it.firstRebreakDayOffset ?? '?') + ') · 현재 ' + (it.aboveHDayHigh ? '<span class="cell-pos">위 유지 ' : '<span class="cell-neg">살짝 아래 ') + distHHigh + '</span>';
    } else if (it.rebreakStatus === 'INTRADAY_PUSHBACK') {
      hHighSubText = '장중만 닿음 (종가 미돌파) · 현재 <span class="' + distHHighCls + '">' + distHHigh + '</span>';
    } else {
      hHighSubText = '남은 거리 <span class="' + distHHighCls + '">' + distHHigh + '</span> · 저가 ' + fmtNum(it.hDayLow);
    }
    html.push(
      '<div class="card s-' + it.rebreakStatus + '">' +
        '<h3><a href="/d5-rebreak/' + it.code + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;border-bottom:1px dotted #475569;">' + (it.name || '') + '</a> <span style="color:#64748b;font-size:13px;font-weight:400;">' + it.code + '</span> <a href="/d5-rebreak/' + it.code + '" target="_blank" rel="noopener" style="color:#94a3b8;text-decoration:none;font-size:12px;font-weight:400;margin-left:6px;" title="상세 페이지로 이동">↗ 상세</a></h3>' +
        '<div class="meta">' +
          '<span class="badge st-' + it.rebreakStatus + '">' + it.rebreakStatusLabel + '</span>' +
          buildLifecycleBadge(it) +
          rebreakBadgeHtml +
          noBreachHtml +
          flowTagsHtml +
          volStrengthHtml +
          distLabelHtml +
          (it.hasVolumeSupport ? '<span class="badge vol">거래대금 동반(H돌파일)</span>' : '') +
          (it.noPullback && isRebrokeAlready ? '<span class="badge no-pull">눌림 없이 상승</span>' : '') +
          '<span class="badge aux">H돌파일 ' + fmtDate(it.breakoutDate) + '</span>' +
          (it.vprMain ? ('<span class="badge vpr-' + it.vprMain + '">' + (it.vprMainLabel || it.vprMain) + '</span>') : '') +
          tagsHtml +
        '</div>' +
        '<div class="price-grid">' +
          '<div class="price-cell k-current">' +
            '<div class="label">현재가</div>' +
            '<div class="value">' + fmtNum(it.currentClose) + '원</div>' +
            '<div class="sub">기준 종가 대비 <span class="' + distFromBaseCls + '">' + fmtPct(it.distFromBase) + '</span></div>' +
          '</div>' +
          '<div class="price-cell k-hhigh">' +
            '<div class="label">H돌파일 고가 (재돌파 기준)</div>' +
            '<div class="value">' + fmtNum(it.hDayHigh) + '원</div>' +
            '<div class="sub">' + hHighSubText + '</div>' +
          '</div>' +
          '<div class="price-cell k-line">' +
            '<div class="label">돌파 기준선</div>' +
            '<div class="value">' + fmtNum(it.breakoutLine) + '원</div>' +
            '<div class="sub">기준 종가 ×1.01</div>' +
          '</div>' +
          '<div class="price-cell k-base">' +
            '<div class="label">기준 종가 (이탈선)</div>' +
            '<div class="value">' + fmtNum(it.baseClose) + '원</div>' +
            '<div class="sub">' + (it.belowBaseClose ? '<span class="cell-neg">⚠ 현재 이탈 중</span>' : (it.everLowBelowBaseClose ? '한번 이탈했다가 회복' : '이탈 없음')) + '</div>' +
          '</div>' +
          '<div class="price-cell k-gap">' +
            '<div class="label">갭% (D+1 시가/기준)</div>' +
            '<div class="value"><span class="' + gapCls + '">' + (it.gapPct != null ? fmtPct(it.gapPct) : '-') + '</span></div>' +
            '<div class="sub">≥8% 강모멘텀 · 0~2% 약모멘텀</div>' +
          '</div>' +
        '</div>' +
        buildTodayFlowHtml(it) +
        (it.interpretation ? '<div class="interpretation-box">' + it.interpretation + '</div>' : '') +
        '<div class="run-comments">' + cmtsHtml + '</div>' +
      '</div>'
    );
  }
  document.getElementById('cards').innerHTML = html.join('');
}
renderCards();

document.getElementById('data-limit').innerHTML =
  '<strong>재돌파 상태 정의 (rebreak deep-dive 결과 반영, 2026-05-06)</strong><br>' +
  '<strong>긍정 4종 (종가 재돌파 = 핵심 시그널)</strong><br>' +
  '• 종가 재돌파 · 이탈 없음 = D+1~현재 어느 날 종가 ≥ H돌파일 고가 + 기준 종가 한 번도 이탈 없음 (n=126, 승률 89%, 매번 +9.41%) <strong>핵심 조건</strong><br>' +
  '• 종가 재돌파 · 거래대금 폭발 = 위 + 재돌파일 거래대금 ×5 이상 (n=91, 승률 87%, 매번 +11%)<br>' +
  '• 종가 재돌파 · 다음날 유지 = 종가 재돌파 + 그 다음날 종가도 ≥ H돌파일 고가 (n=165, 승률 88%, 매번 +9.08%)<br>' +
  '• 종가 재돌파 · 이탈 후 회복 = 기준 종가 이탈했지만 종가 재돌파까지 회복 (n=77, 승률 79%, 매번 +6.18%)<br>' +
  '<strong>주의/부정</strong><br>' +
  '• 장중만 돌파 후 밀림 = 장중 H돌파일 고가는 닿았지만 종가는 못 마감 (n=106, 승률 8.5%, 매번 -5.02%) — 종가 재돌파 전까지 재돌파로 인정 X<br>' +
  '• 이탈 후 회복 착시 = 기준 종가 이탈한 뒤 종가는 회복했지만 H돌파일 고가까지는 종가 재돌파 못함 (이탈 후 당일 회복 n=95, 승률 7.4%, 매번 -4.74%)<br>' +
  '• 재돌파 없음 = 장중도 H돌파일 고가에 한 번도 안 닿음 (n=220, 승률 7%, 매번 -5.81%)<br>' +
  '• 이탈 후 회복 실패 = 기준 종가 이탈한 뒤 회복도 못 한 상태 (n=76, 승률 0%, 매번 -10.2%) <strong>제외 우선</strong><br>' +
  '<br>' +
  '<strong>보조 태그</strong><br>' +
  '• 거래대금 폭발(×5↑) / 강함(×3↑) / 동반(×2↑) — 재돌파일 거래대금 / 직전 20거래일 평균 valueApprox<br>' +
  '• 재돌파 후 거리: 0~2% 직후 / 2~5% 상승 / 5~8% 강한 모멘텀 / 8~12% 강한 모멘텀 지속 / 12%↑ 급등 (5%↑ 구간은 표본 n<50 참고)<br>' +
  '• 거리 = 현재가 / 기준 종가 - 1 · 갭% = D+1 시가 / 기준 종가 - 1<br>' +
  '• 거래대금 동반(H돌파일) = H돌파일 자체에 거래대금 동반/폭발 보조태그 부착<br>' +
  '<br>' +
  '<strong>수급 태그 (재돌파일 외국인/기관 순매수 데이터 기준)</strong><br>' +
  '• 💱 <strong>외국인 순매수 동반</strong> = 재돌파일 외국인 순매수 금액 > 0 (검증 n=70, 수익 비율 92.86%, 평균 +10.12% — 단독에서 가장 강함, 최우선 표시)<br>' +
  '• 🔥 <strong>거래대금 폭발 + 수급 동반</strong> = 재돌파일 거래대금 ×5 이상 + 외인+기관 합산 순매수 > 0 (검증 n=69, 88.41%, 평균 +11.15% — 강한 모멘텀 참고)<br>' +
  '• <strong>외인+기관 수급 동반</strong> = 재돌파일 외국인 + 기관 합산 순매수 > 0 (보조 태그, 외국인 단독 표시 시 중복 강조 회피로 숨김)<br>' +
  '• 비중 임계 3%/5% 조건은 검증상 비중을 높일수록 평균 결과가 미세하게 낮아져 보드 핵심 필터로 쓰지 않습니다.<br>' +
  '• 개인 수급은 -(외국인 + 기관) 근사값이라 보드 태그로 사용하지 않습니다 (개인 과열 주의·손바뀜 수급 미표시).<br>' +
  '• 프로그램 매매 데이터는 cache에 없어 프로그램 수급 태그도 미표시입니다.<br>' +
  '<br>' +
  '• <strong>매수 추천이 아닙니다.</strong> 재돌파 추적용 운용 보드입니다.';
</script>

</body>
</html>
`;

main();
