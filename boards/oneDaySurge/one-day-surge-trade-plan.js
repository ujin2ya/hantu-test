/**
 * 1-Day Surge Board — 자동 참고 매수가/매도가 계산 모듈
 *
 * 보드의 후보 선정/정렬은 그대로 유지하고, 위험 필터 통과 후보(mainPool) 중
 * 자동 계산 가능한 상위 N개에 한해 tradePlan(참고 매수가/1차 목표/2차 목표/손절 기준)을 계산한다.
 *
 * 매수 "추천"이 아닌 참고 가격이며 시장가 매수 전제로 계산하지 않는다.
 * 기준가(baseEntryPrice) 근처 눌림 지정가 개념으로 약 0.3~1.0% 아래에 buyPrice를 둔다.
 *
 * 호출자(one-day-surge-board.js):
 *   const tp = require('./one-day-surge-trade-plan');
 *   const { plansByCode, summary } = tp.buildTradePlans(mainPoolSortedDesc);
 *   for (const it of all) {
 *     if (it.riskExcluded) it.tradePlan = { mode:'NONE', status:'AUTO_EXCLUDED_RISK', reason:'위험 태그로 자동 계산 제외' };
 *     else if (plansByCode.has(it.code)) it.tradePlan = plansByCode.get(it.code);
 *     else it.tradePlan = { mode:'NONE', status:'NOT_SELECTED' };
 *   }
 *   out.summary = { tradePlan: { ...summary, excludedRiskCount } };
 */

'use strict';

const AUTO_PLAN_LIMIT = 10;

const ENTRY_DISCOUNT = {
  BALANCED_REBREAK: 0.003,
  SAFE_REBREAK:     0.005,
  CLEAN_REBREAK:    0.005,
  LIGHT_REBREAK:    0.010,
};

const TARGET_RATE = {
  BALANCED_REBREAK: [0.035, 0.070],
  SAFE_REBREAK:     [0.030, 0.050],
  CLEAN_REBREAK:    [0.030, 0.055],
  LIGHT_REBREAK:    [0.025, 0.050],
};

const STOP_RATE = {
  BALANCED_REBREAK: 0.025,
  SAFE_REBREAK:     0.025,
  CLEAN_REBREAK:    0.027,
  LIGHT_REBREAK:    0.030,
};

const CHASE_LIMIT_RATE = 0.04;
const INVALID_DROP_RATE = -0.03;

// 그룹/조건이 가장 specific한 전략을 우선해서 그 전략의 params를 적용한다.
// BALANCED-GT 전용 → BALANCED, LIGHT-GT 전용 → LIGHT, BAL/LIGHT 공통 + !prev_high → SAFE, 그 외 rebreakMorningHigh → CLEAN
const STRATEGY_PRIORITY = {
  BALANCED_REBREAK: 0,
  LIGHT_REBREAK:    1,
  SAFE_REBREAK:     2,
  CLEAN_REBREAK:    3,
};
const AUTO_STRATEGIES = Object.keys(STRATEGY_PRIORITY);

// 한국 주식 호가 단위 (대략) — 보드 카드 표시용 round 수준에서 충분.
function koreanTickSize(price) {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

function roundToKoreanTick(price, mode) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const tick = koreanTickSize(price);
  if (mode === 'down') return Math.floor(price / tick) * tick;
  if (mode === 'up')   return Math.ceil(price / tick) * tick;
  return Math.round(price / tick) * tick;
}

// 그룹 → 기본 전략 매핑 (분봉 미확인 fallback).
// 보드는 D-day 16:35에 생성되어 다음날 09:30:30 메일 발송 / 09:30 보드 열람 시점에는
// 분봉 데이터가 들어오기 전이라 entryStrategies가 비어있을 수 있다.
// 그래도 tradePlan을 보여주기 위해 그룹별 default 전략을 매핑한다.
//   BALANCED-GT → BALANCED_REBREAK params
//   LIGHT-GT    → LIGHT_REBREAK params
//   MID-CAP-GT  → CLEAN_REBREAK params (그룹 specific 전략 없음, 보수적 fallback)
const GROUP_FALLBACK_STRATEGY = {
  'BALANCED-GT': 'BALANCED_REBREAK',
  'LIGHT-GT':    'LIGHT_REBREAK',
  'MID-CAP-GT':  'CLEAN_REBREAK',
};

// returns { strategy, source } — source: 'intraday' (entryStrategies 실제 매치) | 'group_fallback' (분봉 미확인 default)
function pickPrimaryStrategy(it) {
  const tags = it.entryStrategies || [];
  let best = null, bestRank = Infinity;
  for (const t of tags) {
    if (t in STRATEGY_PRIORITY) {
      const r = STRATEGY_PRIORITY[t];
      if (r < bestRank) { best = t; bestRank = r; }
    }
  }
  if (best) return { strategy: best, source: 'intraday' };
  const fb = GROUP_FALLBACK_STRATEGY[it.gtGroup] || null;
  if (fb) return { strategy: fb, source: 'group_fallback' };
  return null;
}

// baseEntryPrice 우선순위:
//   1) rebreakPrice — 09:00~09:10 max(=morningHigh) — 재돌파 신호의 trigger level
//   2) entryPrice0910 — 09:10 close
//   3) baseClose — D-day 종가 (09:30 현재가 proxy. 보드는 live data 미사용)
//   4) todayOpen — D-day 시가
//   5) prevClose — 전일 종가
function pickBaseEntryPrice(it) {
  const im = it.intraday;
  if (im && im.rebreakMorningHigh_10_30 === true && Number.isFinite(im.preEntryMaxHigh) && im.preEntryMaxHigh > 0) {
    return { price: im.preEntryMaxHigh, source: 'rebreakPrice' };
  }
  if (im && Number.isFinite(im.entryPrice) && im.entryPrice > 0) {
    return { price: im.entryPrice, source: 'entryPrice0910' };
  }
  if (Number.isFinite(it.close) && it.close > 0) {
    return { price: it.close, source: 'baseClose' };
  }
  if (Number.isFinite(it.open) && it.open > 0) {
    return { price: it.open, source: 'todayOpen' };
  }
  if (Number.isFinite(it.prevClose) && it.prevClose > 0) {
    return { price: it.prevClose, source: 'prevClose' };
  }
  return null;
}

// 현재가 proxy — live가 없으므로 가장 최근 알려진 가격을 사용.
function pickCurrentPrice(it) {
  const im = it.intraday;
  if (im && Number.isFinite(im.entryPrice) && im.entryPrice > 0) return im.entryPrice;
  if (Number.isFinite(it.close) && it.close > 0) return it.close;
  return null;
}

function fmtKR(n) {
  return Math.round(n).toLocaleString('ko-KR');
}

function calcTradePlan(it) {
  const sp = pickPrimaryStrategy(it);
  if (!sp) {
    return { mode: 'NONE', status: 'NOT_SELECTED', reason: '자동 계산 대상 그룹/전략 미일치' };
  }
  const { strategy, source: strategySource } = sp;
  const base = pickBaseEntryPrice(it);
  if (!base) {
    return { mode: 'AUTO', status: 'MISSING_PRICE_DATA', strategy, strategySource, reason: '가격 데이터 부족' };
  }
  const current = pickCurrentPrice(it);
  if (!Number.isFinite(current) || current <= 0) {
    return { mode: 'AUTO', status: 'MISSING_PRICE_DATA', strategy, strategySource, reason: '가격 데이터 부족' };
  }

  const ratio = current / base.price - 1;

  // 추격 부담 — 현재가가 기준가보다 너무 올라 있음
  if (ratio >= CHASE_LIMIT_RATE) {
    return {
      mode: 'AUTO',
      status: 'WAIT_PULLBACK',
      strategy, strategySource,
      baseEntryPrice: roundToKoreanTick(base.price, 'nearest'),
      baseEntrySource: base.source,
      buyPrice: null, sellPrice1: null, sellPrice2: null, stopPrice: null,
      reason: '현재가가 기준가보다 많이 올라 눌림 대기',
      riskNote: `현재가 ${fmtKR(current)}원이 기준가 ${fmtKR(base.price)}원 대비 +${(ratio * 100).toFixed(2)}% — 추격 부담`,
      rewardRisk1: null, rewardRisk2: null,
    };
  }

  // 기준가 이탈 — 현재가가 기준가보다 너무 밀림
  if (ratio <= INVALID_DROP_RATE) {
    return {
      mode: 'AUTO',
      status: 'ENTRY_INVALIDATED',
      strategy, strategySource,
      baseEntryPrice: roundToKoreanTick(base.price, 'nearest'),
      baseEntrySource: base.source,
      buyPrice: null, sellPrice1: null, sellPrice2: null, stopPrice: null,
      reason: '기준가를 이탈해 자동 진입 보류',
      riskNote: `현재가 ${fmtKR(current)}원이 기준가 ${fmtKR(base.price)}원 대비 ${(ratio * 100).toFixed(2)}% — 흐름 약화`,
      rewardRisk1: null, rewardRisk2: null,
    };
  }

  // READY — 가격 계산
  const discount = ENTRY_DISCOUNT[strategy];
  const [t1, t2]  = TARGET_RATE[strategy];
  const stopPct   = STOP_RATE[strategy];

  const buyPrice   = roundToKoreanTick(base.price * (1 - discount), 'down');
  const sellPrice1 = roundToKoreanTick(buyPrice  * (1 + t1),        'up');
  const sellPrice2 = roundToKoreanTick(buyPrice  * (1 + t2),        'up');
  const stopPrice  = roundToKoreanTick(buyPrice  * (1 - stopPct),   'down');

  const risk    = buyPrice - stopPrice;
  const reward1 = sellPrice1 - buyPrice;
  const reward2 = sellPrice2 - buyPrice;
  const rewardRisk1 = risk > 0 ? Number((reward1 / risk).toFixed(2)) : null;
  const rewardRisk2 = risk > 0 ? Number((reward2 / risk).toFixed(2)) : null;

  // 참고 위험 문구 — 매수 추천 아님. 실제 진입은 본인의 판단.
  const notes = [];
  if (Number.isFinite(it.low) && it.low <= stopPrice) {
    notes.push('이미 손절 영역 경험 (당일 저가가 손절 기준 이하)');
  }
  if (Number.isFinite(it.close) && Number.isFinite(it.prevClose) && it.close < it.prevClose) {
    notes.push('전일 종가 이탈 주의');
  }
  if (it.intraday && Number.isFinite(it.intraday.lowFromOpen_0_10)) {
    notes.push(`09:10 저가 시초가 대비 ${it.intraday.lowFromOpen_0_10.toFixed(2)}%`);
  }
  // 분봉 미확인 fallback일 때 명시
  const reason = (strategySource === 'group_fallback')
    ? '기준일 종가 기준 눌림 지정가 (분봉 미확인 — 그룹 기본 전략 적용)'
    : '기준가 근처 눌림 지정가';

  return {
    mode: 'AUTO',
    status: 'READY',
    strategy, strategySource,
    baseEntryPrice: roundToKoreanTick(base.price, 'nearest'),
    baseEntrySource: base.source,
    buyPrice, sellPrice1, sellPrice2, stopPrice,
    reason,
    riskNote: notes.join(' / ') || null,
    rewardRisk1, rewardRisk2,
  };
}

// mainPool은 displayPriorityScore 내림차순으로 정렬된 위험 필터 통과 후보 배열이어야 한다.
// 자동 계산 가능한 후보를 위에서부터 최대 AUTO_PLAN_LIMIT개 골라 tradePlan을 계산한다.
// 자동 계산 대상 전략(SAFE/BALANCED/CLEAN/LIGHT)이 없는 후보는 건너뛰고 다음으로 넘어간다.
function buildTradePlans(mainPool) {
  const plansByCode = new Map();
  let count = 0;
  let readyCount = 0, waitPullbackCount = 0, invalidatedCount = 0, missingPriceCount = 0;
  let intradayConfirmedCount = 0, groupFallbackCount = 0;
  for (const it of mainPool) {
    if (count >= AUTO_PLAN_LIMIT) break;
    if (!pickPrimaryStrategy(it)) continue;
    const plan = calcTradePlan(it);
    plansByCode.set(it.code, plan);
    count++;
    switch (plan.status) {
      case 'READY':              readyCount++; break;
      case 'WAIT_PULLBACK':      waitPullbackCount++; break;
      case 'ENTRY_INVALIDATED':  invalidatedCount++; break;
      case 'MISSING_PRICE_DATA': missingPriceCount++; break;
    }
    if (plan.strategySource === 'intraday') intradayConfirmedCount++;
    else if (plan.strategySource === 'group_fallback') groupFallbackCount++;
  }
  return {
    plansByCode,
    summary: {
      autoCount: count,
      readyCount, waitPullbackCount, invalidatedCount, missingPriceCount,
      intradayConfirmedCount, groupFallbackCount,
    },
  };
}

module.exports = {
  AUTO_PLAN_LIMIT,
  ENTRY_DISCOUNT, TARGET_RATE, STOP_RATE,
  CHASE_LIMIT_RATE, INVALID_DROP_RATE,
  AUTO_STRATEGIES, STRATEGY_PRIORITY,
  koreanTickSize, roundToKoreanTick,
  pickPrimaryStrategy, pickBaseEntryPrice, pickCurrentPrice,
  calcTradePlan, buildTradePlans,
};
