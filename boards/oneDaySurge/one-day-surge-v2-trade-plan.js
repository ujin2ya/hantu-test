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
// REBREAK_FADED: rebreakMorningHigh_10_30 ✓ 인데 마지막 close가
// 09:10~09:30 high 대비 -2.5%↓ 밀려있으면 "장초 고점 돌파 후 다시 밀림" 상태로 본다.
const REBREAK_FADE_RATE = -0.025;
// INSUFFICIENT_BARS: 09:00~09:30 분봉 총 개수가 이 값 미만이면 "분봉 부족"으로 표시.
// 정상 수집 시 ~31개. KIS API가 거래량 없는 분봉을 빼고 응답하는 종목은 1~3개만 들어오는데
// 이 경우 ratio/돌파 판정이 사실상 의미 없으므로 매수가를 비우고 사용자에게 명시한다.
const MIN_BARS_FOR_JUDGMENT = 5;

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
// 09:30 분봉이 들어와 있으면 마지막 분봉 close(09:10~09:30 끝점)를 우선해
// 09:10~09:30 사이의 추가 급등/급락이 WAIT_PULLBACK/ENTRY_INVALIDATED 판정에 반영되게 한다.
function pickCurrentPrice(it) {
  const im = it.intraday;
  if (im && Number.isFinite(im.lastClose) && im.lastClose > 0) return im.lastClose;
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

  // 분봉으로 검증 안 된 후보(strategySource === 'group_fallback')는 09:30 신규 진입 후보로 보지 않는다.
  // baseClose 기반 fallback 계산은 09:30 분봉 시점에 신뢰도가 낮으므로 NEED_INTRADAY_CONFIRM 상태로 명시.
  // 분봉 디렉토리에 파일이 없거나 entryStrategies 매치가 안 된 경우 모두 여기로 떨어진다.
  if (strategySource === 'group_fallback') {
    return {
      mode: 'AUTO',
      status: 'NEED_INTRADAY_CONFIRM',
      strategy, strategySource,
      baseEntryPrice: base ? roundToKoreanTick(base.price, 'nearest') : null,
      baseEntrySource: base ? base.source : null,
      currentPrice: null, currentSource: null, ratioPct: null,
      buyPrice: null, sellPrice1: null, sellPrice2: null, stopPrice: null,
      reason: '09:30 분봉 미확인 — 신규 진입 후보 아님',
      riskNote: '분봉 수집/전략 매치 실패. 분봉 들어오면 자동 재분류됨.',
      rewardRisk1: null, rewardRisk2: null,
    };
  }

  if (!base) {
    return { mode: 'AUTO', status: 'MISSING_PRICE_DATA', strategy, strategySource, reason: '가격 데이터 부족' };
  }
  const current = pickCurrentPrice(it);
  if (!Number.isFinite(current) || current <= 0) {
    return { mode: 'AUTO', status: 'MISSING_PRICE_DATA', strategy, strategySource, reason: '가격 데이터 부족' };
  }

  const ratio = current / base.price - 1;
  const im = it.intraday;
  // currentSource: 어디서 온 가격인지 명시 (UI에서 09:10/09:30 close 구분)
  const currentSource = (im && Number.isFinite(im.lastClose) && im.lastClose > 0)
    ? 'lastBar'                              // 09:10~09:30 마지막 분봉 close (이상적)
    : (im && Number.isFinite(im.entryPrice) && im.entryPrice > 0)
      ? 'entryPrice0910'                     // 09:10 close fallback
      : 'baseClose';                         // 분봉 없음 — 전일 종가

  // 분봉 부족 — 분봉은 들어왔지만 봉 개수가 너무 적어 판정에 의미가 없는 케이스.
  // KIS API가 거래량 없는 분봉을 응답에서 빼는 일부 종목(저거래/저유동성)에서 발생.
  // 매수가는 비우고 사용자에게 "분봉 부족" 명시.
  if (im && currentSource === 'lastBar'
      && Number.isFinite(im.bars_total) && im.bars_total < MIN_BARS_FOR_JUDGMENT) {
    return {
      mode: 'AUTO',
      status: 'INSUFFICIENT_BARS',
      strategy, strategySource,
      baseEntryPrice: roundToKoreanTick(base.price, 'nearest'),
      baseEntrySource: base.source,
      currentPrice: roundToKoreanTick(current, 'nearest'),
      currentSource,
      ratioPct: Number((ratio * 100).toFixed(2)),
      barsTotal: im.bars_total,
      buyPrice: null, sellPrice1: null, sellPrice2: null, stopPrice: null,
      reason: '09:00~09:30 분봉이 ' + im.bars_total + '개뿐 — 판정 자료 부족',
      riskNote: `정상 수집 시 ~31개. 이 종목은 거래량 없는 분봉이 응답에서 빠진 것으로 보임 — 진입 판단에 사용하기 어려움`,
      rewardRisk1: null, rewardRisk2: null,
    };
  }

  // 기준가 이탈 — 현재가가 기준가보다 너무 밀림. hard stop이라 가장 먼저 판정.
  if (ratio <= INVALID_DROP_RATE) {
    return {
      mode: 'AUTO',
      status: 'ENTRY_INVALIDATED',
      strategy, strategySource,
      baseEntryPrice: roundToKoreanTick(base.price, 'nearest'),
      baseEntrySource: base.source,
      currentPrice: roundToKoreanTick(current, 'nearest'),
      currentSource,
      ratioPct: Number((ratio * 100).toFixed(2)),
      buyPrice: null, sellPrice1: null, sellPrice2: null, stopPrice: null,
      reason: '장초 기준가를 이탈해 흐름 약화',
      riskNote: `현재가 ${fmtKR(current)}원이 기준가 ${fmtKR(base.price)}원 대비 ${(ratio * 100).toFixed(2)}% — 흐름 약화`,
      rewardRisk1: null, rewardRisk2: null,
    };
  }

  // 장초 고점 돌파 후 밀림 — rebreakMorningHigh ✓ 인데 마지막 close가
  // 09:10~09:30 high 대비 -2.5%↓ 빠진 케이스. WAIT_PULLBACK보다 먼저 판정한다
  // (추격 부담보다 "돌파 무효화"가 더 구체적인 위험 신호).
  if (im
      && im.rebreakMorningHigh_10_30 === true
      && Number.isFinite(im.high_10_30) && im.high_10_30 > 0
      && Number.isFinite(im.lastClose)  && im.lastClose > 0) {
    const fadeRatio = im.lastClose / im.high_10_30 - 1;
    if (fadeRatio <= REBREAK_FADE_RATE) {
      return {
        mode: 'AUTO',
        status: 'REBREAK_FADED',
        strategy, strategySource,
        baseEntryPrice: roundToKoreanTick(base.price, 'nearest'),
        baseEntrySource: base.source,
        currentPrice: roundToKoreanTick(im.lastClose, 'nearest'),
        currentSource,
        ratioPct: Number((ratio * 100).toFixed(2)),
        high_10_30: roundToKoreanTick(im.high_10_30, 'nearest'),
        fadeFromHighPct: Number((fadeRatio * 100).toFixed(2)),
        buyPrice: null, sellPrice1: null, sellPrice2: null, stopPrice: null,
        reason: '장초 고점 돌파 후 다시 밀림',
        riskNote: `09:10~09:30 고점 ${fmtKR(im.high_10_30)}원 대비 마지막 ${fmtKR(im.lastClose)}원 ${(fadeRatio * 100).toFixed(2)}% — 돌파 후 되밀림`,
        rewardRisk1: null, rewardRisk2: null,
      };
    }
  }

  // 추격 부담 — 현재가가 기준가보다 너무 올라 있음
  if (ratio >= CHASE_LIMIT_RATE) {
    return {
      mode: 'AUTO',
      status: 'WAIT_PULLBACK',
      strategy, strategySource,
      baseEntryPrice: roundToKoreanTick(base.price, 'nearest'),
      baseEntrySource: base.source,
      currentPrice: roundToKoreanTick(current, 'nearest'),
      currentSource,
      ratioPct: Number((ratio * 100).toFixed(2)),
      buyPrice: null, sellPrice1: null, sellPrice2: null, stopPrice: null,
      reason: '이미 기준가보다 많이 올라 추격 부담',
      riskNote: `현재가 ${fmtKR(current)}원이 기준가 ${fmtKR(base.price)}원 대비 +${(ratio * 100).toFixed(2)}% — 추격 부담`,
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
    ? '분봉 미확인 — 그룹 기본 전략으로 기준가 근처 눌림 지정가'
    : '장초 흐름 유지 중 — 기준가 근처 눌림 지정가';

  return {
    mode: 'AUTO',
    status: 'READY',
    strategy, strategySource,
    baseEntryPrice: roundToKoreanTick(base.price, 'nearest'),
    baseEntrySource: base.source,
    currentPrice: roundToKoreanTick(current, 'nearest'),
    currentSource,
    ratioPct: Number((ratio * 100).toFixed(2)),
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
  let readyCount = 0, waitPullbackCount = 0, invalidatedCount = 0, fadedCount = 0, insufficientCount = 0, needConfirmCount = 0, missingPriceCount = 0;
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
      case 'REBREAK_FADED':      fadedCount++; break;
      case 'INSUFFICIENT_BARS':  insufficientCount++; break;
      case 'NEED_INTRADAY_CONFIRM': needConfirmCount++; break;
      case 'MISSING_PRICE_DATA': missingPriceCount++; break;
    }
    if (plan.strategySource === 'intraday') intradayConfirmedCount++;
    else if (plan.strategySource === 'group_fallback') groupFallbackCount++;
  }
  return {
    plansByCode,
    summary: {
      autoCount: count,
      readyCount, waitPullbackCount, invalidatedCount, fadedCount, insufficientCount, needConfirmCount, missingPriceCount,
      intradayConfirmedCount, groupFallbackCount,
    },
  };
}

// 상태별 한국어 라벨 — board.js 카드와 콘솔 로그가 공유한다.
const STATUS_LABEL = {
  READY:                '장초 흐름 유지 중',
  WAIT_PULLBACK:        '이미 기준가보다 많이 올라 추격 부담',
  ENTRY_INVALIDATED:    '장초 기준가를 이탈해 흐름 약화',
  REBREAK_FADED:        '장초 고점 돌파 후 다시 밀림',
  INSUFFICIENT_BARS:    '분봉 부족 — 판정 자료 없음',
  NEED_INTRADAY_CONFIRM:'09:30 분봉 확인 없음 — 신규 진입 후보 아님',
  MISSING_PRICE_DATA:   '가격 데이터 부족',
};

module.exports = {
  AUTO_PLAN_LIMIT,
  ENTRY_DISCOUNT, TARGET_RATE, STOP_RATE,
  CHASE_LIMIT_RATE, INVALID_DROP_RATE, REBREAK_FADE_RATE, MIN_BARS_FOR_JUDGMENT,
  AUTO_STRATEGIES, STRATEGY_PRIORITY,
  STATUS_LABEL,
  koreanTickSize, roundToKoreanTick,
  pickPrimaryStrategy, pickBaseEntryPrice, pickCurrentPrice,
  calcTradePlan, buildTradePlans,
};
