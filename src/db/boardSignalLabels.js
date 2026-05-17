/**
 * board_name / signal_kind 코드 → 한글 라벨 + 단계 점수 매핑.
 *
 * 정책:
 *   - DB에는 코드(QVA2_WATCHLIST/VVI2_FIRED)를 그대로 저장한다.
 *   - 화면에 노출할 때 이 모듈로 한글 라벨로 치환한다.
 *   - 원본 코드는 EJS에서 title="..." 속성으로 보존한다.
 *   - unknown 코드는 원본 그대로 fallback 한다 (앱 깨지지 않게).
 *
 * 점수 (label/stage_score):
 *   - 매수 점수 아님 — "먼저 볼 순서" 보조 점수.
 *   - KIND_WEIGHTS 와 BOARD_WEIGHTS 의 합산.
 *   - priority_score 와 별개로 화면에 표시되며 DB에 저장하지 않는다.
 */

// ─── 보드 라벨 ────────────────────────────────────────────────────────────
const BOARD_LABELS = Object.freeze({
  QVA_WATCHLIST:      'QVA',
  QVA2_WATCHLIST:     'QVA2',
  QVA_VVI_REDEFINED:  'QVA-VVI',
  QVA2_VVI:           'QVA2-VVI',
  HGROUP_REBREAK:     '재돌파',
  QVA2_D5_REBREAK:    'QVA2 D+5 재돌파',
  ONE_DAY_SURGE:      '1DS',
});

// ─── 신호 종류 라벨 ───────────────────────────────────────────────────────
const KIND_LABELS = Object.freeze({
  // QVA / QVA2 funnel
  QVA_NEW:                 '신규 QVA',
  QVA_TRACKING:            '추적 중',
  QVA2_NEW:                '신규 QVA2',
  QVA2_TRACKING:           '추적 중',
  LONG_QVA_ALL:            '장기 QVA',
  // VVI / VVI2
  VVI_FIRED:               'VVI 발화',
  VVI2_FIRED:              'VVI2 발화',
  TODAY_NEW_VVI:           '오늘 신규 VVI',
  TODAY_NEW_VVI2:          '오늘 신규 VVI2',
  // 돌파
  BREAKOUT_SUCCESS:        '돌파 성공',
  TODAY_INITIAL_BREAKOUT:  '오늘 첫 돌파',
  CLOSE_REBREAK:           '종가 재돌파',
  CLOSE_REBREAK_NO_BREACH: '이탈 없는 종가 재돌파',
  STABLE_BREAKOUT:         '안정 돌파',
  STRONG_VALUE:            '강한 거래대금',
  // 1DS
  ATTACK_TOP:              '공격형 TOP',
  MAIN:                    '메인 후보',
  // 중간 상태
  WAITING:                 '대기',
  NEAR_HIGH:               '고가 근처',
  CLOSE_WEAK:              '종가 약함',
  VALUE_WEAK:              '거래대금 약함',
  PRICE_ONLY:              '가격만 돌파',
  OVERHEATED:              '과열',
  INTRADAY_PUSHBACK:       '장중만 돌파',
  // 실패·이탈
  FAILED:                  '실패·이탈',
  BROKEN:                  '이탈됨',
  BREACH_NO_RECOVER:       '이탈 후 회복 실패',
  BREACH_RECOVER_ILLUSION: '회복 착시',
  NO_REBREAK:              '재돌파 없음',
});

// ─── 점수 ─────────────────────────────────────────────────────────────────
// 매수 점수 아님. "먼저 살펴볼 순서"용 보조 점수.
const KIND_WEIGHTS = Object.freeze({
  BREAKOUT_SUCCESS:         18,
  CLOSE_REBREAK_NO_BREACH:  15,
  CLOSE_REBREAK:            14,
  VVI2_FIRED:               16,
  VVI_FIRED:                14,
  TODAY_INITIAL_BREAKOUT:   12,
  ATTACK_TOP:               12,
  STABLE_BREAKOUT:          10,
  STRONG_VALUE:              9,
  TODAY_NEW_VVI:             8,
  TODAY_NEW_VVI2:            8,
  MAIN:                      8,
  QVA2_NEW:                  8,
  QVA_NEW:                   7,
  NEAR_HIGH:                 5,
  WAITING:                   3,
  PRICE_ONLY:                2,
  VALUE_WEAK:                1,
  CLOSE_WEAK:                1,
  QVA2_TRACKING:             1,
  QVA_TRACKING:              0,
  LONG_QVA_ALL:              0,
  OVERHEATED:               -3,
  INTRADAY_PUSHBACK:        -5,
  NO_REBREAK:              -10,
  BREACH_RECOVER_ILLUSION: -12,
  FAILED:                  -15,
  BROKEN:                  -15,
  BREACH_NO_RECOVER:       -18,
});

const BOARD_WEIGHTS = Object.freeze({
  QVA2_VVI:           8,
  QVA2_D5_REBREAK:    8,
  HGROUP_REBREAK:     7,
  ONE_DAY_SURGE:      6,
  QVA_VVI_REDEFINED:  6,
  QVA2_WATCHLIST:     4,
  QVA_WATCHLIST:      3,
});

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────

function formatBoardName(boardName) {
  if (!boardName) return '';
  return BOARD_LABELS[boardName] || boardName;
}

function formatSignalKind(kind) {
  if (!kind) return '';
  return KIND_LABELS[kind] || kind;
}

// 'QVA2_WATCHLIST/VVI2_FIRED' → 'QVA2 / VVI2 발화'
// 입력이 (board, kind) 두 인자거나 'board/kind' 단일 문자열 모두 지원.
function formatBoardKind(boardNameOrCombined, signalKind) {
  let bn, sk;
  if (signalKind === undefined && typeof boardNameOrCombined === 'string' && boardNameOrCombined.includes('/')) {
    const [a, b] = boardNameOrCombined.split('/', 2);
    bn = a; sk = b;
  } else {
    bn = boardNameOrCombined; sk = signalKind;
  }
  if (!bn) return '';
  const b = formatBoardName(bn);
  if (!sk) return b;
  const k = formatSignalKind(sk);
  return b + ' / ' + k;
}

// 단계 점수 — KIND_WEIGHTS + BOARD_WEIGHTS 합산.
// unknown은 0으로 (no-op fallback).
function getBoardKindWeight(boardName, signalKind) {
  const kw = (signalKind && Object.prototype.hasOwnProperty.call(KIND_WEIGHTS, signalKind)) ? KIND_WEIGHTS[signalKind] : 0;
  const bw = (boardName && Object.prototype.hasOwnProperty.call(BOARD_WEIGHTS, boardName)) ? BOARD_WEIGHTS[boardName] : 0;
  return kw + bw;
}

// ─── 필터 프리셋 (5차, 2026-05-17) ──────────────────────────────────────
// 사용자가 즉시 적용 가능한 신호 조합 후보 — UI에서 select 한 줄로 선택.
// 매수 조건 아님, "후보 압축용 화면 조건".
//
// matchMode:
//   'any' — includeKind 중 하나라도 가진 종목 (가장 흔한 사용)
//   'all' — includeKind 모두를 가진 종목 (강한 funnel 매칭)
const FILTER_PRESETS = Object.freeze({
  STRONG_REACTION: {
    label: '강한 반응 후보',
    description: 'VVI/VVI2 발화, 돌파 성공, 재돌파처럼 실제 움직임이 확인된 후보',
    includeKind: ['VVI_FIRED', 'VVI2_FIRED', 'BREAKOUT_SUCCESS', 'CLOSE_REBREAK', 'CLOSE_REBREAK_NO_BREACH', 'TODAY_INITIAL_BREAKOUT'],
    excludeKind: ['FAILED', 'BROKEN', 'BREACH_NO_RECOVER', 'BREACH_RECOVER_ILLUSION', 'NO_REBREAK'],
    matchMode: 'any',
  },
  QVA2_CORE: {
    label: 'QVA2 핵심 후보',
    description: 'QVA2 신규 포착부터 VVI2 / 돌파로 이어지는 후보',
    includeBoard: ['QVA2_WATCHLIST', 'QVA2_VVI', 'QVA2_D5_REBREAK'],
    includeKind: ['QVA2_NEW', 'VVI2_FIRED', 'BREAKOUT_SUCCESS', 'TODAY_INITIAL_BREAKOUT'],
    excludeKind: ['FAILED', 'BROKEN', 'BREACH_NO_RECOVER'],
    matchMode: 'any',
  },
  REBREAK_ONLY: {
    label: '재돌파 후보',
    description: '종가 재돌파나 D+5 재돌파 계열 후보',
    includeBoard: ['HGROUP_REBREAK', 'QVA2_D5_REBREAK'],
    includeKind: ['CLOSE_REBREAK', 'CLOSE_REBREAK_NO_BREACH', 'TODAY_INITIAL_BREAKOUT'],
    excludeKind: ['NO_REBREAK', 'BREACH_NO_RECOVER', 'BROKEN'],
    matchMode: 'any',
  },
  ONE_DAY_ATTACK: {
    label: '1DS 공격 후보',
    description: '장초 단기 반응을 보는 1DS 공격형 후보',
    includeBoard: ['ONE_DAY_SURGE'],
    includeKind: ['ATTACK_TOP', 'MAIN'],
    excludeKind: [],
    matchMode: 'any',
  },
  RISK_EXCLUDED: {
    label: '위험·제외 후보',
    description: '실패, 이탈, 회복 실패 계열만 따로 확인',
    includeKind: ['FAILED', 'BROKEN', 'BREACH_NO_RECOVER', 'BREACH_RECOVER_ILLUSION', 'NO_REBREAK'],
    excludeKind: [],
    matchMode: 'any',
  },
});

// 프리셋 + 사용자 override 머지. user query 값이 있으면 preset 위에 덮어쓴다.
function mergePresetWithOverrides(presetKey, overrides) {
  const base = (presetKey && FILTER_PRESETS[presetKey]) ? { ...FILTER_PRESETS[presetKey] } : {};
  const o = overrides || {};
  return {
    includeBoard: o.includeBoard != null ? o.includeBoard : (base.includeBoard || []),
    excludeBoard: o.excludeBoard != null ? o.excludeBoard : (base.excludeBoard || []),
    includeKind:  o.includeKind  != null ? o.includeKind  : (base.includeKind  || []),
    excludeKind:  o.excludeKind  != null ? o.excludeKind  : (base.excludeKind  || []),
    matchMode:    o.matchMode    || base.matchMode || 'any',
  };
}

module.exports = {
  BOARD_LABELS,
  KIND_LABELS,
  KIND_WEIGHTS,
  BOARD_WEIGHTS,
  FILTER_PRESETS,
  formatBoardName,
  formatSignalKind,
  formatBoardKind,
  getBoardKindWeight,
  mergePresetWithOverrides,
};
