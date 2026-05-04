#!/usr/bin/env node
/**
 * BMS = Big Move Similarity Model
 *
 * 1. 과거 일정 기간(2025-04-01 ~ 2026-04-30)에 +40% 이상 오른 종목을 자동 선정 (bigMove episode)
 * 2. 각 episode의 상승 전 / 상승 중 / 상승 후 구간을 분석
 * 3. 모든 episode의 공통 조건을 통계로 요약 (mean/median/Q1/Q3)
 * 4. 현재 종목 중 그 조건과 비슷한 종목을 BMS Score 100점으로 점수화
 *
 * 출력:
 *   - big-move-similarity-report.json  (원본 데이터)
 *   - big-move-similarity-report.html  (시각화)
 *
 * 미래 데이터 누수 방지:
 *   - 과거 episode 분석에서는 surgeStart 시점 이전 데이터만 BASE 분석에 사용
 *   - 현재 후보 점수화는 latestTradingDate 이전 정보만 사용 (peak/post-peak 데이터 일체 미사용)
 *
 * 본 보고서는 매수 추천이 아니라 모델 검증/실험 보고서다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__filename);
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_FILE = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const config = {
  SURGE_WINDOW_DAYS: 20,
  SURGE_RETURN_THRESHOLD: 40,
  BASE_LOOKBACK_DAYS: 30,
  SUPPLY_LOOKBACK_DAYS: 120,
  EPISODE_MERGE_WINDOW: 10,
  POST_PEAK_DAYS: 20,
  ANALYSIS_START: '20250401',
  ANALYSIS_END: '20260430',
  MIN_MARKET_CAP: 30_000_000_000, // 300억 미만은 episode 분석에서 제외
  MIN_AVG20_VALUE: 500_000_000,   // 평균 거래대금 5억 미만은 후보 분석에서 제외
  TOP_CANDIDATES: 50,
  TOP_REPRESENTATIVE_EPISODES: 20,
};

// 분석 제외 상품 (qva-surge-day-report.js와 동일 정책)
const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

// 대표 사례 필수 확인 종목 (사용자 요청)
const REQUIRED_SAMPLES = [
  { code: '018880', name: '한온시스템' },
  { code: '025860', name: '남해화학' },
  { code: '001250', name: 'GS글로벌' },
  { code: '005010', name: '휴스틸' },
  { code: '018470', name: '조일알미늄' },
];

// ─────────────────────── 헬퍼 ───────────────────────

function sma(values, period) {
  if (!values || values.length < period) return null;
  const recent = values.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / period;
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quartile(values, q) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] != null) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

function average(values) {
  if (!values || values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sum(arr, key) {
  return arr.reduce((s, r) => s + (key ? (r[key] || 0) : r), 0);
}

function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}

function computeATR(rows, period = 14) {
  if (rows.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const tr = Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close)
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((s, t) => s + t, 0) / period;
}

function computeOverheadSupply(rows, currentPrice) {
  if (rows.length === 0 || !currentPrice) {
    return { overheadSupply5: 0, overheadSupply10: 0, overheadSupply15: 0 };
  }
  let totalValue = 0;
  let supply5 = 0, supply10 = 0, supply15 = 0;
  rows.forEach(r => {
    const v = r.valueApprox || 0;
    if (v <= 0) return;
    const midPrice = (r.high + r.low) / 2;
    if (midPrice <= 0) return;
    totalValue += v;
    const ratio = midPrice / currentPrice - 1;
    if (ratio > 0 && ratio <= 0.05) supply5 += v;
    if (ratio > 0 && ratio <= 0.10) supply10 += v;
    if (ratio > 0 && ratio <= 0.15) supply15 += v;
  });
  return {
    overheadSupply5: totalValue ? supply5 / totalValue : 0,
    overheadSupply10: totalValue ? supply10 / totalValue : 0,
    overheadSupply15: totalValue ? supply15 / totalValue : 0,
  };
}

// ─────────────────────── bigMove episode 탐지 ───────────────────────

/**
 * surgeStart = 상승의 첫 강한 날 (high >= 전일종가 * 1.02 이상)
 * surgePeak = 그 후 SURGE_WINDOW_DAYS 거래일 안의 최고 high 도달일
 * 같은 종목에서 연속 신호는 EPISODE_MERGE_WINDOW 거래일 cooldown으로 1개로 병합
 */
function findBigMoveEpisodes(rows, code, name, market, marketCap) {
  const episodes = [];
  const minStartIdx = Math.max(config.BASE_LOOKBACK_DAYS, 20);

  let i = minStartIdx;
  while (i < rows.length - 1) {
    const today = rows[i];
    if (!today || today.date < config.ANALYSIS_START || today.date > config.ANALYSIS_END) {
      i++;
      continue;
    }
    const prev = rows[i - 1];
    if (!prev || !prev.close || !today.close) { i++; continue; }

    // surge 시작 조건: 오늘 high가 전일 종가 대비 +2% 이상 (intraday breakout)
    if (today.high < prev.close * 1.02) { i++; continue; }

    // 향후 SURGE_WINDOW_DAYS 안의 max high 검사
    const windowEnd = Math.min(i + config.SURGE_WINDOW_DAYS - 1, rows.length - 1);
    let peakHigh = today.high;
    let peakIdx = i;
    for (let j = i; j <= windowEnd; j++) {
      if (rows[j].high > peakHigh) {
        peakHigh = rows[j].high;
        peakIdx = j;
      }
    }

    const surgeReturnPct = (peakHigh / prev.close - 1) * 100;
    if (surgeReturnPct >= config.SURGE_RETURN_THRESHOLD) {
      episodes.push({
        code,
        name,
        market,
        marketCapAtStart: marketCap,
        surgeStartIdx: i,
        surgePeakIdx: peakIdx,
        surgeStartDate: today.date,
        surgePeakDate: rows[peakIdx].date,
        baselineClose: prev.close,
        startClose: today.close,
        peakHigh,
        surgeReturnPct,
        daysToPeak: peakIdx - i + 1,
      });
      // skip past peak + cooldown so the same episode isn't double-counted
      i = peakIdx + config.EPISODE_MERGE_WINDOW + 1;
    } else {
      i++;
    }
  }

  return episodes;
}

// ─────────────────────── 상승 전 분석 ───────────────────────

function analyzePreSurge(rows, surgeStartIdx, marketCap) {
  const baseStart = Math.max(0, surgeStartIdx - config.BASE_LOOKBACK_DAYS);
  const baseRows = rows.slice(baseStart, surgeStartIdx); // surgeStart 미포함
  if (baseRows.length < 10) return null;

  const lastBaseClose = baseRows[baseRows.length - 1].close;
  if (!lastBaseClose) return null;

  // 박스권
  const highs = baseRows.map(r => r.high);
  const lows = baseRows.map(r => r.low);
  const boxUpper = Math.max(...highs);
  const boxLower = Math.min(...lows);
  const boxRangePct = boxLower > 0 ? (boxUpper / boxLower - 1) * 100 : 0;
  const closePositionInBox = (boxUpper - boxLower) > 0
    ? (lastBaseClose - boxLower) / (boxUpper - boxLower)
    : 0.5;

  // ATR 변동성
  const atr = computeATR(baseRows);
  const atrPct = atr && lastBaseClose ? (atr / lastBaseClose) * 100 : 0;

  // 거래량/거래대금 (BASE 기간만)
  const last20 = rows.slice(Math.max(0, surgeStartIdx - 20), surgeStartIdx);
  const last3 = rows.slice(Math.max(0, surgeStartIdx - 3), surgeStartIdx);
  const last5 = rows.slice(Math.max(0, surgeStartIdx - 5), surgeStartIdx);
  const last10 = rows.slice(Math.max(0, surgeStartIdx - 10), surgeStartIdx);

  const valueMedian20 = median(last20.map(r => r.valueApprox || 0));
  const valueAvg20 = average(last20.map(r => r.valueApprox || 0));
  const volumeMedian20 = median(last20.map(r => r.volume || 0));
  const volumeAvg20 = average(last20.map(r => r.volume || 0));

  // surgeStart 당일 거래대금 (이건 surge가 시작된 날의 데이터 — 분석 시점에 알 수 있음)
  const surgeStartRow = rows[surgeStartIdx];
  const surgeStartValue = surgeStartRow ? (surgeStartRow.valueApprox || 0) : 0;
  const surgeStartValueRatio = valueMedian20 ? surgeStartValue / valueMedian20 : 0;

  const recent3AvgValue = average(last3.map(r => r.valueApprox || 0));
  const recent5AvgValue = average(last5.map(r => r.valueApprox || 0));
  const recent3ValueRatio = valueMedian20 ? recent3AvgValue / valueMedian20 : 0;
  const recent5ValueRatio = valueMedian20 ? recent5AvgValue / valueMedian20 : 0;

  // 시총 대비 거래대금 (5d/10d/20d 누적)
  const sumVal = arr => arr.reduce((s, r) => s + (r.valueApprox || 0), 0);
  const value5dRatio = marketCap ? sumVal(last5) / marketCap : 0;
  const value10dRatio = marketCap ? sumVal(last10) / marketCap : 0;
  const value20dRatio = marketCap ? sumVal(last20) / marketCap : 0;

  // 가격 위치
  const win20 = rows.slice(Math.max(0, surgeStartIdx - 20), surgeStartIdx);
  const win60 = rows.slice(Math.max(0, surgeStartIdx - 60), surgeStartIdx);
  const win120 = rows.slice(Math.max(0, surgeStartIdx - 120), surgeStartIdx);
  const low20 = win20.length ? Math.min(...win20.map(r => r.low)) : lastBaseClose;
  const low60 = win60.length ? Math.min(...win60.map(r => r.low)) : lastBaseClose;
  const low120 = win120.length ? Math.min(...win120.map(r => r.low)) : lastBaseClose;
  const high20 = win20.length ? Math.max(...win20.map(r => r.high)) : lastBaseClose;
  const high60 = win60.length ? Math.max(...win60.map(r => r.high)) : lastBaseClose;
  const high120 = win120.length ? Math.max(...win120.map(r => r.high)) : lastBaseClose;

  const returnFromLow20 = low20 ? (lastBaseClose / low20 - 1) * 100 : 0;
  const returnFromLow60 = low60 ? (lastBaseClose / low60 - 1) * 100 : 0;
  const returnFromLow120 = low120 ? (lastBaseClose / low120 - 1) * 100 : 0;
  const distanceFromHigh20 = high20 ? (lastBaseClose / high20 - 1) * 100 : 0;
  const distanceFromHigh60 = high60 ? (lastBaseClose / high60 - 1) * 100 : 0;
  const distanceFromHigh120 = high120 ? (lastBaseClose / high120 - 1) * 100 : 0;

  // 이동평균선 (BASE 기간 종료 시점 = lastBaseClose)
  const allCloses = rows.slice(0, surgeStartIdx).map(r => r.close);
  const ma5 = sma(allCloses, 5);
  const ma20 = sma(allCloses, 20);
  const ma60 = sma(allCloses, 60);
  const ma120 = sma(allCloses, 120);
  const ma20Past = sma(allCloses.slice(0, -5), 20);
  const ma60Past = sma(allCloses.slice(0, -10), 60);
  const ma20Slope = ma20 && ma20Past ? (ma20 / ma20Past - 1) * 100 : 0;
  const ma60Slope = ma60 && ma60Past ? (ma60 / ma60Past - 1) * 100 : 0;

  const closeAboveMa5 = ma5 != null ? lastBaseClose >= ma5 : null;
  const closeAboveMa20 = ma20 != null ? lastBaseClose >= ma20 : null;
  const closeAboveMa60 = ma60 != null ? lastBaseClose >= ma60 : null;
  const closeAboveMa120 = ma120 != null ? lastBaseClose >= ma120 : null;
  const ma5AboveMa20 = (ma5 != null && ma20 != null) ? ma5 >= ma20 : null;
  const closeMa20Gap = ma20 ? (lastBaseClose / ma20 - 1) * 100 : 0;
  const closeMa60Gap = ma60 ? (lastBaseClose / ma60 - 1) * 100 : 0;

  // 매물대 (overhead supply)
  const supplyRows = rows.slice(Math.max(0, surgeStartIdx - config.SUPPLY_LOOKBACK_DAYS), surgeStartIdx);
  const overhead = computeOverheadSupply(supplyRows, lastBaseClose);
  // breakoutValuePower: surgeStart 거래대금 vs 매물대 부담
  const breakoutValuePower = overhead.overheadSupply10 > 0
    ? surgeStartValueRatio / overhead.overheadSupply10
    : surgeStartValueRatio * 5;

  return {
    boxDays: baseRows.length,
    boxRangePct,
    boxUpper,
    boxLower,
    closePositionInBox,
    atrPct,
    valueMedian20,
    valueAvg20,
    volumeMedian20,
    volumeAvg20,
    surgeStartValue,
    surgeStartValueRatio,
    recent3AvgValue,
    recent5AvgValue,
    recent3ValueRatio,
    recent5ValueRatio,
    value5dRatio,
    value10dRatio,
    value20dRatio,
    returnFromLow20,
    returnFromLow60,
    returnFromLow120,
    distanceFromHigh20,
    distanceFromHigh60,
    distanceFromHigh120,
    closeAboveMa5,
    closeAboveMa20,
    closeAboveMa60,
    closeAboveMa120,
    ma5AboveMa20,
    ma20Slope,
    ma60Slope,
    closeMa20Gap,
    closeMa60Gap,
    overheadSupply5: overhead.overheadSupply5,
    overheadSupply10: overhead.overheadSupply10,
    overheadSupply15: overhead.overheadSupply15,
    breakoutValuePower,
  };
}

// ─────────────────────── 상승 중 분석 ───────────────────────

function analyzeDuringSurge(rows, surgeStartIdx, surgePeakIdx, marketCap, flowRows) {
  const surgeRows = rows.slice(surgeStartIdx, surgePeakIdx + 1);
  if (surgeRows.length === 0) return null;

  const startDate = rows[surgeStartIdx].date;
  const peakDate = rows[surgePeakIdx].date;

  const cumulativeValue = surgeRows.reduce((s, r) => s + (r.valueApprox || 0), 0);
  const cumulativeVolume = surgeRows.reduce((s, r) => s + (r.volume || 0), 0);
  const avgDailyValue = cumulativeValue / surgeRows.length;
  const cumulativeValueRatio = marketCap ? cumulativeValue / marketCap : 0;
  const avgDailyValueRatio = marketCap ? avgDailyValue / marketCap : 0;

  let upDayValue = 0, downDayValue = 0;
  let redCandleValue = 0, blueCandleValue = 0;
  surgeRows.forEach((r, idx) => {
    const v = r.valueApprox || 0;
    if (r.close > r.open) redCandleValue += v;
    else if (r.close < r.open) blueCandleValue += v;
    const priorClose = idx > 0 ? surgeRows[idx - 1].close : (rows[surgeStartIdx - 1]?.close || r.open);
    if (priorClose && r.close > priorClose) upDayValue += v;
    else if (priorClose && r.close < priorClose) downDayValue += v;
  });

  const upDayValueRatio = cumulativeValue ? upDayValue / cumulativeValue : 0;
  const downDayValueRatio = cumulativeValue ? downDayValue / cumulativeValue : 0;
  const redCandleValueShare = cumulativeValue ? redCandleValue / cumulativeValue : 0;
  const blueCandleValueShare = cumulativeValue ? blueCandleValue / cumulativeValue : 0;

  let maxDailyValue = 0, maxDailyValueDate = null;
  surgeRows.forEach(r => {
    const v = r.valueApprox || 0;
    if (v > maxDailyValue) { maxDailyValue = v; maxDailyValueDate = r.date; }
  });
  const maxDailyValueRatio = marketCap ? maxDailyValue / marketCap : 0;

  // 수급
  let foreignNetBuy = 0, institutionNetBuy = 0;
  let hasFlow = false;
  if (flowRows && flowRows.length > 0) {
    flowRows.forEach(f => {
      if (f.date >= startDate && f.date <= peakDate) {
        foreignNetBuy += (f.foreignNetValue || 0);
        institutionNetBuy += (f.orgNetValue || 0);
        hasFlow = true;
      }
    });
  }
  const smartMoneyNetBuy = foreignNetBuy + institutionNetBuy;
  const smartMoneyShareOfValue = cumulativeValue ? smartMoneyNetBuy / cumulativeValue : 0;
  const smartMoneyMcRatio = marketCap ? smartMoneyNetBuy / marketCap : 0;

  return {
    daysToPeak: surgeRows.length,
    cumulativeValueToPeak: cumulativeValue,
    cumulativeVolumeToPeak: cumulativeVolume,
    cumulativeValueRatio,
    avgDailyValueToPeak: avgDailyValue,
    avgDailyValueRatio,
    upDayValueRatio,
    downDayValueRatio,
    redCandleValueShare,
    blueCandleValueShare,
    maxDailyValue,
    maxDailyValueRatio,
    maxDailyValueDate,
    foreignNetBuyToPeak: foreignNetBuy,
    institutionNetBuyToPeak: institutionNetBuy,
    smartMoneyNetBuyToPeak: smartMoneyNetBuy,
    smartMoneyShareOfValue,
    smartMoneyMcRatio,
    hasFlowData: hasFlow,
  };
}

// ─────────────────────── 상승 후 분석 ───────────────────────

function analyzePostPeak(rows, surgePeakIdx, marketCap, flowRows) {
  const peakRow = rows[surgePeakIdx];
  if (!peakRow) return null;
  const peakHigh = peakRow.high;
  const peakClose = peakRow.close;

  const post = rows.slice(surgePeakIdx + 1, Math.min(rows.length, surgePeakIdx + 1 + config.POST_PEAK_DAYS));
  if (post.length === 0) return null;

  const closeAt = (n) => post[Math.min(n, post.length - 1)]?.close;
  const drawdown5 = closeAt(4) ? (closeAt(4) / peakHigh - 1) * 100 : null;
  const drawdown10 = closeAt(9) ? (closeAt(9) / peakHigh - 1) * 100 : null;
  const drawdown20 = closeAt(19) ? (closeAt(19) / peakHigh - 1) * 100 : null;

  let daysToDrop10 = null, daysToDrop20 = null;
  for (let i = 0; i < post.length; i++) {
    const dd = (post[i].close / peakHigh - 1) * 100;
    if (daysToDrop10 == null && dd <= -10) daysToDrop10 = i + 1;
    if (daysToDrop20 == null && dd <= -20) daysToDrop20 = i + 1;
  }

  const postCumulativeValue = post.reduce((s, r) => s + (r.valueApprox || 0), 0);
  let downDayValue = 0;
  let highVolumeDownDays = 0;
  const pre20 = rows.slice(Math.max(0, surgePeakIdx - 19), surgePeakIdx + 1);
  const avg20Value = average(pre20.map(r => r.valueApprox || 0));

  post.forEach((r, idx) => {
    const v = r.valueApprox || 0;
    const priorClose = idx > 0 ? post[idx - 1].close : peakClose;
    if (priorClose && r.close < priorClose) {
      downDayValue += v;
      if (avg20Value && v >= avg20Value * 1.5) highVolumeDownDays++;
    }
  });
  const postPeakDownDayValueShare = postCumulativeValue ? downDayValue / postCumulativeValue : 0;

  let foreignNet = 0, institutionNet = 0;
  if (flowRows && flowRows.length > 0) {
    const peakDate = rows[surgePeakIdx].date;
    const endDate = post[post.length - 1].date;
    flowRows.forEach(f => {
      if (f.date > peakDate && f.date <= endDate) {
        foreignNet += (f.foreignNetValue || 0);
        institutionNet += (f.orgNetValue || 0);
      }
    });
  }
  const smartMoneyNet = foreignNet + institutionNet;

  // distribution signal
  const distributionSignal = (highVolumeDownDays >= 2) || (postPeakDownDayValueShare > 0.6);

  return {
    drawdown5,
    drawdown10,
    drawdown20,
    daysToDrop10,
    daysToDrop20,
    postPeakCumulativeValue: postCumulativeValue,
    postPeakDownDayValueShare,
    postPeakForeignNetValue: foreignNet,
    postPeakInstitutionNetValue: institutionNet,
    postPeakSmartMoneyNetValue: smartMoneyNet,
    highVolumeDownDays,
    distributionSignal,
  };
}

// ─────────────────────── 통계 집계 ───────────────────────

function makeStats(values) {
  const filtered = values.filter(v => v != null && Number.isFinite(v));
  if (filtered.length === 0) return { count: 0 };
  return {
    count: filtered.length,
    mean: average(filtered),
    median: median(filtered),
    q1: quartile(filtered, 0.25),
    q3: quartile(filtered, 0.75),
    min: Math.min(...filtered),
    max: Math.max(...filtered),
  };
}

function aggregateBaselines(episodes) {
  const out = {};
  const numericFields = {
    preSurge: [
      'boxDays', 'boxRangePct', 'closePositionInBox', 'atrPct',
      'surgeStartValueRatio', 'recent3ValueRatio', 'recent5ValueRatio',
      'value5dRatio', 'value10dRatio', 'value20dRatio',
      'returnFromLow20', 'returnFromLow60', 'returnFromLow120',
      'distanceFromHigh20', 'distanceFromHigh60', 'distanceFromHigh120',
      'closeMa20Gap', 'closeMa60Gap', 'ma20Slope', 'ma60Slope',
      'overheadSupply5', 'overheadSupply10', 'overheadSupply15',
      'breakoutValuePower',
    ],
    duringSurge: [
      'cumulativeValueRatio', 'avgDailyValueRatio', 'upDayValueRatio',
      'redCandleValueShare', 'maxDailyValueRatio',
      'smartMoneyShareOfValue', 'smartMoneyMcRatio', 'daysToPeak',
    ],
    postPeak: [
      'drawdown5', 'drawdown10', 'drawdown20',
      'postPeakDownDayValueShare', 'highVolumeDownDays',
    ],
  };

  Object.entries(numericFields).forEach(([source, fields]) => {
    fields.forEach(f => {
      const vals = episodes.map(e => e[source] && e[source][f]);
      out[f] = makeStats(vals);
    });
  });

  // surgeReturnPct 자체도 통계
  out.surgeReturnPct = makeStats(episodes.map(e => e.surgeReturnPct));

  // 불리언 필드
  const boolFields = [
    { key: 'closeAboveMa5', source: 'preSurge' },
    { key: 'closeAboveMa20', source: 'preSurge' },
    { key: 'closeAboveMa60', source: 'preSurge' },
    { key: 'closeAboveMa120', source: 'preSurge' },
    { key: 'ma5AboveMa20', source: 'preSurge' },
    { key: 'distributionSignal', source: 'postPeak' },
  ];
  boolFields.forEach(({ key, source }) => {
    const vals = episodes.map(e => e[source] && e[source][key]).filter(v => v != null);
    const trueCount = vals.filter(v => v).length;
    out[key] = {
      count: vals.length,
      trueCount,
      trueRate: vals.length ? trueCount / vals.length : 0,
    };
  });

  // 수급 데이터 가용성
  const flowEpisodes = episodes.filter(e => e.duringSurge && e.duringSurge.hasFlowData);
  out._meta = {
    totalEpisodes: episodes.length,
    episodesWithFlow: flowEpisodes.length,
  };

  return out;
}

// ─────────────────────── 현재 후보 점수화 ───────────────────────

/**
 * baseline 분위수를 임계로 하는 0~1 점수.
 * higherIsBetter=true: value≥Q3이면 1.0, value≤Q1이면 0, 사이는 선형
 *   → +40% 종목들의 상위 25% 만큼 강한 신호여야 만점. 너무 약하면 0.
 *   → Q3을 크게 초과해도 1.0에서 멈춤 (단순화)
 * higherIsBetter=false: value≤Q1이면 1.0, value≥Q3이면 0, 사이는 선형
 */
function scoreSignal(value, stats, higherIsBetter = true) {
  if (value == null || !Number.isFinite(value) || !stats || stats.count < 5) return 0;
  const { q1, q3 } = stats;
  if (q3 <= q1) return value >= stats.median ? 1 : 0;

  if (higherIsBetter) {
    if (value >= q3) return 1.0;
    if (value <= q1) return 0;
    return (value - q1) / (q3 - q1);
  } else {
    if (value <= q1) return 1.0;
    if (value >= q3) return 0;
    return 1 - (value - q1) / (q3 - q1);
  }
}

function scoreCurrentCandidate(rows, marketCap, flowRows, baselines, latestDate) {
  if (rows.length < 60) return null;
  // 최신 거래일이 latestDate인지 확인 (데이터 일관성)
  const lastIdx = rows.length - 1;
  const today = rows[lastIdx];
  if (!today || !today.close) return null;

  // "오늘"을 surgeStart로 가정한 분석 — 단 미래 데이터(=오늘 이후) 전혀 사용 안 함
  // analyzePreSurge는 rows[0..surgeStartIdx-1]만 본다 (BASE는 오늘 미포함)
  // surgeStart 당일 거래대금만 오늘 데이터를 사용 (현재 시장 데이터)
  const preSurge = analyzePreSurge(rows, lastIdx, marketCap);
  if (!preSurge) return null;

  // 평균 거래대금이 너무 작으면 스킵
  if (preSurge.valueMedian20 < config.MIN_AVG20_VALUE) return null;

  const todayValue = today.valueApprox || 0;
  const todayValueRatio = preSurge.valueMedian20 ? todayValue / preSurge.valueMedian20 : 0;
  const todayReturn = rows[lastIdx - 1] ? (today.close / rows[lastIdx - 1].close - 1) * 100 : 0;

  // 최근 10일 수급 비율 (smart money / value)
  let smartMoneyShareRecent = null;
  let hasFlowData = false;
  if (flowRows && flowRows.length > 0) {
    const recentRows = rows.slice(Math.max(0, lastIdx - 9), lastIdx + 1);
    const recentDates = new Set(recentRows.map(r => r.date));
    let sumFlow = 0, sumValue = 0;
    flowRows.forEach(f => {
      if (recentDates.has(f.date)) {
        sumFlow += (f.foreignNetValue || 0) + (f.orgNetValue || 0);
        hasFlowData = true;
      }
    });
    sumValue = recentRows.reduce((s, r) => s + (r.valueApprox || 0), 0);
    smartMoneyShareRecent = sumValue ? sumFlow / sumValue : null;
  }

  // ---- BMS Score ----
  let raw = 0;
  const matched = [];
  const warnings = [];

  // 1. 시총 대비 거래대금 유입 (25점)
  const s1_5 = scoreSignal(preSurge.value5dRatio, baselines.value5dRatio, true);
  const s1_10 = scoreSignal(preSurge.value10dRatio, baselines.value10dRatio, true);
  const s1_20 = scoreSignal(preSurge.value20dRatio, baselines.value20dRatio, true);
  const s1 = (s1_5 + s1_10 + s1_20) / 3;
  raw += s1 * 25;
  if (s1 >= 0.7) matched.push('시총대비 거래대금 유입');

  // 2. 거래대금 증가율 (20점)
  const s2_a = scoreSignal(preSurge.recent3ValueRatio, baselines.recent3ValueRatio, true);
  const s2_b = scoreSignal(todayValueRatio, baselines.surgeStartValueRatio, true);
  const s2 = (s2_a + s2_b) / 2;
  raw += s2 * 20;
  if (s2 >= 0.7) matched.push('거래대금 증가율');

  // 3. 수급 (15점) — 데이터 없으면 null
  let s3 = null;
  if (smartMoneyShareRecent != null && baselines.smartMoneyShareOfValue && baselines.smartMoneyShareOfValue.count >= 5) {
    s3 = scoreSignal(smartMoneyShareRecent, baselines.smartMoneyShareOfValue, true);
    raw += s3 * 15;
    if (s3 >= 0.7) matched.push('외국인+기관 순매수');
  }

  // 4. 박스권 (15점)
  const s4_a = scoreSignal(preSurge.boxRangePct, baselines.boxRangePct, false); // 변동폭은 좁을수록 좋음
  const s4_b = preSurge.closePositionInBox >= 0.7 ? 1 : preSurge.closePositionInBox >= 0.5 ? 0.7 : preSurge.closePositionInBox >= 0.3 ? 0.4 : 0.2;
  const s4 = (s4_a + s4_b) / 2;
  raw += s4 * 15;
  if (s4 >= 0.7) matched.push('박스권 형성/돌파');

  // 5. 이동평균선 (10점)
  let s5_raw = 0;
  if (preSurge.closeAboveMa20) s5_raw += 0.5;
  if (preSurge.ma5AboveMa20) s5_raw += 0.25;
  if (preSurge.ma20Slope >= 0) s5_raw += 0.25;
  raw += s5_raw * 10;
  if (s5_raw >= 0.75) matched.push('이동평균선 정배열');

  // 6. 매물대 부담 (10점)
  let s6_a = 0;
  if (preSurge.overheadSupply10 < 0.15) s6_a = 1.0;
  else if (preSurge.overheadSupply10 < 0.30) s6_a = 0.7;
  else if (preSurge.overheadSupply10 < 0.45) s6_a = 0.4;
  else s6_a = 0.1;
  const s6_b = scoreSignal(preSurge.breakoutValuePower, baselines.breakoutValuePower, true);
  const s6 = (s6_a + s6_b) / 2;
  raw += s6 * 10;
  if (s6 >= 0.7) matched.push('매물대 부담 낮음');

  // 7. 가격 위치 (5점)
  const s7_a = scoreSignal(preSurge.returnFromLow60, baselines.returnFromLow60, true);
  const s7_b = scoreSignal(preSurge.distanceFromHigh60, baselines.distanceFromHigh60, true);
  const s7 = (s7_a + s7_b) / 2;
  raw += s7 * 5;

  // Warnings
  if (preSurge.distanceFromHigh60 > -3) warnings.push('60일 고점 근접 (매물대 위험)');
  if (preSurge.returnFromLow20 > 30) warnings.push('20일 저점 +30% 이상 (추격)');
  if (preSurge.overheadSupply10 > 0.50) warnings.push('매물대 부담 과다');
  if (todayReturn > 10) warnings.push('당일 +10% 이상 (단기 과열)');
  if (preSurge.boxRangePct > 60) warnings.push('박스권 넓음 (변동성 과다)');

  // 정규화 (수급 데이터 없으면 85점 만점)
  let normalizedScore = raw;
  if (s3 == null) {
    normalizedScore = (raw / 85) * 100;
  }

  let label = '낮음';
  if (normalizedScore >= 80) label = '강한 후보';
  else if (normalizedScore >= 65) label = '관심 후보';
  else if (normalizedScore >= 50) label = '관찰 후보';

  return {
    score: Math.round(raw * 10) / 10,
    normalizedScore: Math.round(normalizedScore * 10) / 10,
    label,
    breakdown: {
      valueMcInflow: Math.round(s1 * 25 * 10) / 10,
      valueGrowth: Math.round(s2 * 20 * 10) / 10,
      smartMoney: s3 != null ? Math.round(s3 * 15 * 10) / 10 : null,
      box: Math.round(s4 * 15 * 10) / 10,
      ma: Math.round(s5_raw * 10 * 10) / 10,
      overhead: Math.round(s6 * 10 * 10) / 10,
      pricePosition: Math.round(s7 * 5 * 10) / 10,
    },
    today: {
      date: today.date,
      close: today.close,
      todayReturn,
      todayValue,
      todayValueRatio,
    },
    snapshot: { ...preSurge, smartMoneyShareRecent, hasFlowData },
    matched,
    warnings,
  };
}

// ─────────────────────── 메인 ───────────────────────

function loadStocks() {
  const data = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const map = {};
  (data.stocks || []).forEach(s => { map[s.code] = s; });
  return map;
}

function loadFlow(code) {
  const fp = path.join(FLOW_DIR, `${code}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return j.rows || null;
  } catch (_) { return null; }
}

function main() {
  console.log('═'.repeat(80));
  console.log('BMS = Big Move Similarity Model 분석 시작');
  console.log('═'.repeat(80));
  console.log(`분석 기간: ${fmtDate(config.ANALYSIS_START)} ~ ${fmtDate(config.ANALYSIS_END)}`);
  console.log(`상승 임계값: +${config.SURGE_RETURN_THRESHOLD}% / ${config.SURGE_WINDOW_DAYS}거래일 안`);
  console.log();

  const stockMap = loadStocks();
  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`총 ${files.length}개 차트 파일 처리 중...`);

  const allEpisodes = [];
  const allCandidates = [];
  // 차트별 마지막 거래일 분포 → 최빈값을 진짜 latestDate로 (이상치 종목 영향 제거)
  const lastDateCount = {};
  let processed = 0;
  let skippedExcluded = 0;
  let skippedSmallCap = 0;
  let skippedShortChart = 0;

  // 1차: 과거 episode 검출
  files.forEach((file, idx) => {
    const code = file.replace('.json', '');
    const meta = stockMap[code];
    if (!meta) return;
    if (isExcludedProduct(meta.name)) { skippedExcluded++; return; }

    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8')); }
    catch (_) { return; }
    const rows = chart.rows || [];
    if (rows.length < 60) { skippedShortChart++; return; }

    const lastRowDate = rows[rows.length - 1].date;
    lastDateCount[lastRowDate] = (lastDateCount[lastRowDate] || 0) + 1;

    const marketCap = meta.marketValue || 0;
    if (marketCap < config.MIN_MARKET_CAP) { skippedSmallCap++; return; }

    const flowRows = loadFlow(code);
    const episodes = findBigMoveEpisodes(rows, code, meta.name, meta.market, marketCap);

    episodes.forEach(ep => {
      ep.preSurge = analyzePreSurge(rows, ep.surgeStartIdx, marketCap);
      ep.duringSurge = analyzeDuringSurge(rows, ep.surgeStartIdx, ep.surgePeakIdx, marketCap, flowRows);
      ep.postPeak = analyzePostPeak(rows, ep.surgePeakIdx, marketCap, flowRows);
      // surge 시점의 가격 정보를 함께 저장
      ep.startOpen = rows[ep.surgeStartIdx].open;
      ep.startHigh = rows[ep.surgeStartIdx].high;
      ep.startLow = rows[ep.surgeStartIdx].low;
      delete ep.surgeStartIdx;
      delete ep.surgePeakIdx;
    });

    allEpisodes.push(...episodes);
    processed++;
    if ((idx + 1) % 500 === 0) {
      process.stdout.write(`\r1단계 진행: ${idx + 1}/${files.length} (${allEpisodes.length} episodes)`);
    }
  });
  // 최빈값을 latestDate로 (4,265개가 4/30이고 1개만 5/4면 4/30이 진짜 최신 거래일)
  const sortedDates = Object.entries(lastDateCount).sort(([, a], [, b]) => b - a);
  const latestDate = sortedDates.length ? sortedDates[0][0] : '00000000';
  const latestDateCount2 = sortedDates.length ? sortedDates[0][1] : 0;
  const totalCharted = sortedDates.reduce((s, [, n]) => s + n, 0);
  console.log(`\r1단계 완료: ${processed}개 종목 처리, ${allEpisodes.length}개 bigMove episode 검출`);
  console.log(`  — 제외 상품: ${skippedExcluded} / 시총 미달: ${skippedSmallCap} / 차트 부족: ${skippedShortChart}`);
  console.log(`  — 최신 거래일(최빈): ${fmtDate(latestDate)} (${latestDateCount2}/${totalCharted}개 종목)`);
  if (sortedDates.length > 1) {
    console.log(`  — 다른 마지막 거래일: ${sortedDates.slice(1, 4).map(([d, n]) => fmtDate(d)+'='+n).join(', ')}`);
  }

  // preSurge가 null인 episode는 제외 (히스토리 부족)
  const validEpisodes = allEpisodes.filter(e => e.preSurge && e.duringSurge);
  console.log(`  — 분석 가능한 episode: ${validEpisodes.length}`);

  if (validEpisodes.length === 0) {
    console.error('분석 가능한 episode가 없습니다. 차트 데이터를 확인하세요.');
    process.exit(1);
  }

  // 2차: 통계 집계
  const baselines = aggregateBaselines(validEpisodes);
  console.log(`2단계 완료: 통계 집계`);

  // 3차: 현재 후보 점수화
  console.log(`3단계: 현재 후보 점수화 진행 중...`);
  // 종목별 최신 거래일이 갱신 시점에 따라 다를 수 있으므로 최근 5거래일 (캘린더 7일) 이내면 허용
  const latestStaleCutoff = (() => {
    const y = parseInt(latestDate.slice(0, 4));
    const m = parseInt(latestDate.slice(4, 6)) - 1;
    const d = parseInt(latestDate.slice(6, 8));
    const dt = new Date(y, m, d);
    dt.setDate(dt.getDate() - 7);
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  })();

  let cand_skipMeta = 0, cand_skipExcl = 0, cand_skipShort = 0, cand_skipStale = 0, cand_skipSmallMc = 0, cand_skipScore = 0;
  files.forEach((file, idx) => {
    const code = file.replace('.json', '');
    const meta = stockMap[code];
    if (!meta) { cand_skipMeta++; return; }
    if (isExcludedProduct(meta.name)) { cand_skipExcl++; return; }

    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8')); }
    catch (_) { cand_skipShort++; return; }
    const rows = chart.rows || [];
    if (rows.length < 60) { cand_skipShort++; return; }

    // 최신 거래일이 너무 오래되면(거래정지/관리종목 등) 스킵
    const lastDate = rows[rows.length - 1].date;
    if (lastDate < latestStaleCutoff) { cand_skipStale++; return; }

    const marketCap = meta.marketValue || 0;
    if (marketCap < config.MIN_MARKET_CAP) { cand_skipSmallMc++; return; }

    const flowRows = loadFlow(code);
    const result = scoreCurrentCandidate(rows, marketCap, flowRows, baselines, lastDate);
    if (!result) { cand_skipScore++; return; }

    allCandidates.push({
      code,
      name: meta.name,
      market: meta.market,
      marketCap,
      ...result,
    });

    if ((idx + 1) % 500 === 0) {
      process.stdout.write(`\r3단계 진행: ${idx + 1}/${files.length}`);
    }
  });
  console.log(`\r3단계 완료: ${allCandidates.length}개 후보 점수화`);
  console.log(`  — 스킵: meta=${cand_skipMeta} 제외=${cand_skipExcl} 차트짧음=${cand_skipShort} 오래됨=${cand_skipStale} 시총미달=${cand_skipSmallMc} 점수실패=${cand_skipScore}`);

  // 정렬
  allCandidates.sort((a, b) => b.normalizedScore - a.normalizedScore);
  validEpisodes.sort((a, b) => b.surgeReturnPct - a.surgeReturnPct);

  // 점수 분포
  const scoreBuckets = { '90+': 0, '80-89': 0, '70-79': 0, '60-69': 0, '50-59': 0, '40-49': 0, '<40': 0 };
  allCandidates.forEach(c => {
    const s = c.normalizedScore;
    if (s >= 90) scoreBuckets['90+']++;
    else if (s >= 80) scoreBuckets['80-89']++;
    else if (s >= 70) scoreBuckets['70-79']++;
    else if (s >= 60) scoreBuckets['60-69']++;
    else if (s >= 50) scoreBuckets['50-59']++;
    else if (s >= 40) scoreBuckets['40-49']++;
    else scoreBuckets['<40']++;
  });

  // 대표 사례 확인 (과거 episode + 현재 BMS 점수)
  const requiredHits = REQUIRED_SAMPLES.map(s => {
    const eps = validEpisodes.filter(e => e.code === s.code);
    const cIdx = allCandidates.findIndex(c => c.code === s.code);
    const candidate = cIdx >= 0 ? allCandidates[cIdx] : null;
    return {
      code: s.code,
      name: s.name,
      episodes: eps.slice(0, 3),
      currentCandidate: candidate ? {
        normalizedScore: candidate.normalizedScore,
        label: candidate.label,
        breakdown: candidate.breakdown,
        warnings: candidate.warnings,
        matched: candidate.matched,
        rank: cIdx + 1,
        today: candidate.today,
        snapshot: candidate.snapshot,
      } : null,
    };
  });

  // 대표 사례 출력
  console.log('\n대표 사례 검출 결과:');
  requiredHits.forEach(h => {
    if (h.episodes.length === 0) {
      console.log(`  ${h.name} (${h.code}): episode 없음`);
    } else {
      h.episodes.forEach(ep => {
        console.log(`  ${ep.name} (${ep.code}) surgeStart=${fmtDate(ep.surgeStartDate)} → peak=${fmtDate(ep.surgePeakDate)} +${ep.surgeReturnPct.toFixed(1)}% (D+${ep.daysToPeak})`);
      });
    }
  });

  // JSON 저장
  const top = allCandidates.slice(0, config.TOP_CANDIDATES);
  const repEpisodes = validEpisodes.slice(0, config.TOP_REPRESENTATIVE_EPISODES);

  const jsonOut = {
    meta: {
      generatedAt: new Date().toISOString(),
      latestTradingDate: latestDate,
      analysisStart: config.ANALYSIS_START,
      analysisEnd: config.ANALYSIS_END,
      config,
      totalEpisodes: validEpisodes.length,
      totalCandidates: allCandidates.length,
    },
    baselines,
    scoreBuckets,
    topCandidates: top,
    representativeEpisodes: repEpisodes,
    requiredSamples: requiredHits,
    allEpisodesCount: validEpisodes.length,
  };

  const jsonPath = path.join(ROOT, 'big-move-similarity-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2));
  console.log(`\nJSON 저장: ${jsonPath}`);

  // HTML 생성
  const html = generateHTML(jsonOut);
  const htmlPath = path.join(ROOT, 'big-move-similarity-report.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`HTML 저장: ${htmlPath}`);

  console.log('\n═'.repeat(80));
  console.log('완료');
  console.log('═'.repeat(80));
  console.log(`bigMove episode: ${validEpisodes.length}개`);
  console.log(`현재 BMS 후보: ${allCandidates.length}개`);
  console.log(`  강한 후보(80+): ${allCandidates.filter(c => c.normalizedScore >= 80).length}개`);
  console.log(`  관심 후보(65+): ${allCandidates.filter(c => c.normalizedScore >= 65 && c.normalizedScore < 80).length}개`);
  console.log(`  관찰 후보(50+): ${allCandidates.filter(c => c.normalizedScore >= 50 && c.normalizedScore < 65).length}개`);
}

// ─────────────────────── HTML 생성 ───────────────────────

function generateHTML(data) {
  const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BMS · Big Move Similarity Model</title>
<style>
  * { box-sizing: border-box; }
  body { background:#0f172a; color:#e2e8f0; font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif; margin:0; padding:20px; line-height:1.55; }
  .wrap { max-width:1400px; margin:0 auto; }
  h1 { font-size:24px; color:#f1f5f9; margin:0 0 8px 0; }
  h2 { font-size:18px; color:#f1f5f9; margin:24px 0 10px 0; padding-bottom:6px; border-bottom:1px solid #334155; }
  h3 { font-size:15px; color:#cbd5e1; margin:16px 0 8px 0; }
  .subtitle { color:#94a3b8; font-size:13px; margin-bottom:16px; }
  .info-box { background:#1e293b; border-left:3px solid #38bdf8; padding:14px 18px; margin:16px 0; border-radius:6px; font-size:13px; color:#cbd5e1; }
  .info-box p { margin:6px 0; }
  .info-box strong { color:#f1f5f9; }
  .warn-box { background:#1e293b; border-left:3px solid #fbbf24; padding:12px 16px; margin:14px 0; border-radius:6px; color:#fcd34d; font-size:13px; }
  .summary-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; margin:12px 0; }
  .stat { background:#1e293b; padding:12px 14px; border-radius:6px; border:1px solid #334155; }
  .stat-label { color:#94a3b8; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; }
  .stat-value { color:#f1f5f9; font-size:20px; font-weight:700; margin-top:4px; }
  .stat-sub { color:#64748b; font-size:11px; margin-top:2px; }
  .table-scroll { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; background:#1e293b; border-radius:6px; overflow:hidden; margin:8px 0; font-size:12px; }
  thead { background:#0f172a; position:sticky; top:0; z-index:1; }
  th { padding:8px 10px; text-align:left; color:#94a3b8; font-weight:600; border-bottom:1px solid #334155; cursor:pointer; user-select:none; white-space:nowrap; }
  th:hover { color:#e2e8f0; }
  th.sorted-asc::after { content:' ▲'; color:#38bdf8; }
  th.sorted-desc::after { content:' ▼'; color:#38bdf8; }
  td { padding:8px 10px; border-bottom:1px solid #1e293b; color:#cbd5e1; vertical-align:top; white-space:nowrap; }
  td .sub { color:#64748b; font-size:11px; margin-top:2px; }
  td.tags { white-space:normal; min-width:140px; max-width:200px; }
  td.tags .tag-wrap { display:flex; flex-wrap:wrap; gap:3px; }
  td.name-col { white-space:nowrap; max-width:160px; overflow:hidden; text-overflow:ellipsis; }
  tbody tr:hover { background:#252e3f; }
  .pos { color:#10b981; }
  .neg { color:#ef4444; }
  .muted { color:#64748b; }
  .market-K { color:#3b82f6; font-weight:600; }
  .market-Q { color:#f59e0b; font-weight:600; }
  .badge { display:inline-block; padding:1px 6px; border-radius:8px; font-size:10px; margin-left:4px; font-weight:600; white-space:nowrap; }
  .badge.strong { background:#10b981; color:#0f172a; }
  .badge.interest { background:#fbbf24; color:#0f172a; }
  .badge.watch { background:#64748b; color:#f1f5f9; }
  .badge.warn { background:#ef4444; color:#fff; }
  .badge.match { background:#0ea5e9; color:#fff; }
  td .badge { margin-left:0; }
  .controls { display:flex; gap:10px; margin:10px 0; flex-wrap:wrap; }
  .controls input, .controls select { background:#1e293b; color:#e2e8f0; border:1px solid #334155; padding:7px 10px; border-radius:6px; font-size:13px; }
  .controls input { flex:1; min-width:200px; }
  details { margin:10px 0; background:#1e293b; border-radius:6px; padding:8px 14px; border:1px solid #334155; }
  details summary { cursor:pointer; padding:6px 0; color:#f1f5f9; font-weight:600; }
  details[open] summary { border-bottom:1px solid #334155; margin-bottom:10px; padding-bottom:8px; }
  .ep-card { background:#0f172a; border:1px solid #334155; border-radius:6px; padding:12px; margin:8px 0; font-size:12px; }
  .ep-card .head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid #334155; }
  .ep-card .head .name { font-size:15px; font-weight:700; color:#f1f5f9; }
  .ep-card .head .ret { font-size:18px; font-weight:700; color:#10b981; }
  .ep-card .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:6px 14px; }
  .ep-card .lbl { color:#64748b; font-size:11px; }
  .ep-card .val { color:#e2e8f0; font-weight:500; }
  .breakdown { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
  .br { background:#0f172a; padding:3px 8px; border-radius:4px; font-size:11px; color:#94a3b8; border:1px solid #334155; }
  .br strong { color:#e2e8f0; }
  .matched-list { margin-top:6px; }
  .matched-list .badge { margin-right:4px; }
  .nav { display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap; font-size:13px; }
  .nav a { color:#38bdf8; text-decoration:none; padding:5px 10px; background:#1e293b; border-radius:4px; border:1px solid #334155; }
  .nav a:hover { background:#252e3f; }
  .baseline-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:10px; margin:12px 0; }
  .baseline-card { background:#1e293b; padding:10px 14px; border-radius:6px; border:1px solid #334155; }
  .baseline-card .label { color:#cbd5e1; font-size:12px; font-weight:600; margin-bottom:4px; }
  .baseline-card .vals { display:grid; grid-template-columns:repeat(4, 1fr); gap:4px; font-size:11px; }
  .baseline-card .vals div { color:#94a3b8; }
  .baseline-card .vals strong { color:#f1f5f9; display:block; }
  .req-sample { background:#1e293b; padding:12px 14px; border-radius:6px; margin:8px 0; border-left:3px solid #fbbf24; }
  .req-sample .name { font-size:14px; font-weight:600; color:#f1f5f9; margin-bottom:6px; }
  .req-sample .ep { font-size:12px; color:#cbd5e1; margin-left:12px; }
  .config-table { font-size:12px; }
  .config-table td:first-child { color:#94a3b8; }
  .footer { color:#64748b; font-size:11px; margin-top:30px; padding-top:14px; border-top:1px solid #334155; }
</style>
</head>
<body>
<div class="wrap">
  <h1>BMS · Big Move Similarity Model</h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="nav">
    <a href="#config">설정값</a>
    <a href="#summary">상승 episode 요약</a>
    <a href="#baselines">공통 조건 baselines</a>
    <a href="#during">상승 중</a>
    <a href="#post">상승 후</a>
    <a href="#candidates">현재 BMS 후보</a>
    <a href="#representative">대표 사례</a>
    <a href="#required">필수 사례 확인</a>
  </div>

  <div class="info-box">
    <p><strong>이 보고서가 답하는 질문</strong></p>
    <p>과거에 +40% 이상 크게 오른 종목들은 <strong>오르기 전</strong>·<strong>오르는 중</strong>·<strong>오른 후</strong>에 어떤 공통 조건을 가졌는가? 그리고 현재 종목 중 <strong>그 조건과 비슷한 종목</strong>은 무엇인가?</p>
    <p style="margin-top:8px;"><strong>해석</strong></p>
    <p>BMS Score는 매수 추천이 아니라, "과거 대상승 종목과 통계적으로 유사한 정도"를 점수화한 실험 지표입니다. 점수가 높다고 미래 상승을 보장하지 않습니다.</p>
    <p style="margin-top:8px;"><strong>미래 데이터 누수 방지</strong></p>
    <p>현재 후보 점수화에는 latestTradingDate 이전 정보만 사용했습니다. 과거 episode의 상승 후 데이터(피크/하락)는 baseline 계산과 점수에 들어가지 않습니다.</p>
  </div>

  <div class="warn-box">⚠️ 본 보고서는 매수 추천이 아닙니다. 모델 검증·실험 보고서입니다.</div>

  <h2 id="config">⚙️ 설정값</h2>
  <table class="config-table">
    <tr><td>분석 기간</td><td id="cfg-period"></td></tr>
    <tr><td>SURGE_WINDOW_DAYS</td><td id="cfg-window"></td></tr>
    <tr><td>SURGE_RETURN_THRESHOLD</td><td id="cfg-threshold"></td></tr>
    <tr><td>BASE_LOOKBACK_DAYS</td><td id="cfg-base"></td></tr>
    <tr><td>SUPPLY_LOOKBACK_DAYS</td><td id="cfg-supply"></td></tr>
    <tr><td>EPISODE_MERGE_WINDOW</td><td id="cfg-merge"></td></tr>
    <tr><td>POST_PEAK_DAYS</td><td id="cfg-post"></td></tr>
    <tr><td>MIN_MARKET_CAP</td><td id="cfg-mc"></td></tr>
  </table>

  <h2 id="summary">📊 과거 +40% 상승 episode 요약</h2>
  <div class="summary-grid" id="summary-cards"></div>

  <h2 id="baselines">🎯 상승 전 공통 조건 (baselines)</h2>
  <p class="subtitle">각 지표의 중앙값(median)/Q1/Q3 — 현재 후보 점수화의 기준이 되는 분포입니다.</p>
  <div class="baseline-grid" id="baselines-pre"></div>

  <h2 id="during">🚀 상승 중 거래대금/시총 분석</h2>
  <div class="baseline-grid" id="baselines-during"></div>

  <h2 id="post">📉 상승 후 분산/하락 분석</h2>
  <div class="baseline-grid" id="baselines-post"></div>
  <div class="info-box" style="border-color:#ef4444;">
    <p><strong>⚠️ 실패/위험 패턴 요약</strong></p>
    <ul id="failure-patterns" style="margin:6px 0; padding-left:20px;"></ul>
  </div>

  <h2 id="candidates">🔥 현재 BMS 후보 TOP <span id="top-count"></span></h2>
  <div class="summary-grid" id="score-distribution"></div>
  <div class="info-box" style="font-size:12px;">
    <p style="margin:0;"><strong>📖 컬럼 설명</strong> &nbsp; <span class="muted">(헤더에 마우스 올리면 자세한 설명)</span></p>
    <p style="margin:4px 0 0 0; font-size:11px; line-height:1.6; color:#94a3b8;">
      <strong>거래대금</strong>: 시총 대비 최근 10일 누적 / 오늘이 평소보다 몇 배 ·
      <strong>박스</strong>: 최근 30일 변동폭과 박스 안 위치(0=하단, 1=상단) ·
      <strong>가격위치</strong>: 60일 저점에서 +몇% 올라왔는지 / 60일 고점에서 -몇% 내려왔는지 ·
      <strong>매물대</strong>: 현재가 위 +10% 구간에 쌓인 매물 비중 ·
      <strong>수급</strong>: 외국인+기관 순매수 / 거래대금
    </p>
  </div>
  <div class="controls">
    <input type="text" id="filter" placeholder="종목명 또는 코드 검색…">
    <select id="label-filter">
      <option value="all">전체 라벨</option>
      <option value="강한 후보">강한 후보 (80+)</option>
      <option value="관심 후보">관심 후보 (65~79)</option>
      <option value="관찰 후보">관찰 후보 (50~64)</option>
    </select>
  </div>
  <div class="table-scroll">
  <table id="candidates-table">
    <thead><tr>
      <th data-col="rank" data-num="1">#</th>
      <th data-col="name" title="종목명·시장·코드">종목</th>
      <th data-col="marketCap" data-num="1" title="시가총액 / 종가">시총·종가</th>
      <th data-col="bms" data-num="1" title="BMS Score (100점 만점) + 라벨">BMS</th>
      <th data-col="value" data-num="1" title="시총 대비 10일 거래대금 / 오늘 거래대금이 평소(20일 중앙값) 대비 몇 배">거래대금</th>
      <th data-col="box" data-num="1" title="박스 변동폭 / 박스 안에서의 위치(0=하단,1=상단)">박스</th>
      <th data-col="position" data-num="1" title="60일 저점에서 +% / 60일 고점에서 -%">가격위치</th>
      <th data-col="overhead" data-num="1" title="현재가 위 +10% 구간 매물대 비중 / 외국인+기관 수급 비율">매물·수급</th>
      <th data-col="matched">강한 신호</th>
      <th data-col="warnings">주의</th>
    </tr></thead>
    <tbody id="candidates-body"></tbody>
  </table>
  </div>

  <h2 id="representative">⭐ 대표 bigMove 사례 TOP <span id="rep-count"></span></h2>
  <p class="subtitle">surgeReturnPct 내림차순 — 가장 크게 오른 종목들</p>
  <div id="rep-list"></div>

  <h2 id="required">📌 필수 사례 확인</h2>
  <p class="subtitle">사용자 요청 종목 (한온시스템 외 4종)이 episode로 잡혔는지 확인합니다.</p>
  <div id="required-list"></div>

  <div class="footer">
    생성: <span id="gen-time"></span> · BMS = Big Move Similarity Model · 매수 추천이 아니라 실험적 분석 보고서입니다.
  </div>
</div>

<script>
const DATA = __JSON_DATA__;

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }
function fmtNum(n) { return n != null ? Math.round(n).toLocaleString() : '-'; }
function fmtPct(n, sign) {
  if (n == null || !isFinite(n)) return '-';
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : 'muted');
  const s = (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
  return '<span class="'+cls+'">'+s+'</span>';
}
function fmtMc(v) {
  if (!v) return '-';
  if (v >= 1e12) return (v/1e12).toFixed(2)+'조';
  if (v >= 1e8) return (v/1e8).toFixed(0)+'억';
  return (v/1e4).toFixed(0)+'만';
}
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }
function labelBadge(label) {
  const k = label === '강한 후보' ? 'strong' : label === '관심 후보' ? 'interest' : label === '관찰 후보' ? 'watch' : 'muted';
  return '<span class="badge '+k+'">'+label+'</span>';
}
function num(v, fixed) {
  if (v == null || !isFinite(v)) return '-';
  return Number(v).toFixed(fixed != null ? fixed : 2);
}

// 헤더 자막
const m = DATA.meta;
document.getElementById('subtitle').textContent =
  '분석 기간 ' + fmtDate(m.analysisStart) + ' ~ ' + fmtDate(m.analysisEnd) +
  ' · 기준일 ' + fmtDate(m.latestTradingDate) +
  ' · episode ' + m.totalEpisodes + '개 · 후보 ' + m.totalCandidates + '개' +
  ' · 생성 ' + m.generatedAt.slice(0,19).replace('T',' ');
document.getElementById('gen-time').textContent = m.generatedAt.slice(0,19).replace('T',' ');

// 설정값
const c = m.config;
document.getElementById('cfg-period').textContent = fmtDate(m.analysisStart) + ' ~ ' + fmtDate(m.analysisEnd);
document.getElementById('cfg-window').textContent = c.SURGE_WINDOW_DAYS + ' 거래일';
document.getElementById('cfg-threshold').textContent = '+' + c.SURGE_RETURN_THRESHOLD + '%';
document.getElementById('cfg-base').textContent = c.BASE_LOOKBACK_DAYS + ' 거래일';
document.getElementById('cfg-supply').textContent = c.SUPPLY_LOOKBACK_DAYS + ' 거래일';
document.getElementById('cfg-merge').textContent = c.EPISODE_MERGE_WINDOW + ' 거래일';
document.getElementById('cfg-post').textContent = c.POST_PEAK_DAYS + ' 거래일';
document.getElementById('cfg-mc').textContent = (c.MIN_MARKET_CAP/1e8).toFixed(0) + '억 이상';

// Episode 요약
const sr = DATA.baselines.surgeReturnPct;
document.getElementById('summary-cards').innerHTML = [
  ['총 episode', m.totalEpisodes + '개'],
  ['surgeReturn 중앙값', '+' + sr.median.toFixed(1) + '%'],
  ['surgeReturn 평균', '+' + sr.mean.toFixed(1) + '%'],
  ['최고 surgeReturn', '+' + sr.max.toFixed(1) + '%'],
  ['DaysToPeak 중앙값', 'D+' + DATA.baselines.daysToPeak.median.toFixed(1)],
].map(([l, v]) => '<div class="stat"><div class="stat-label">'+l+'</div><div class="stat-value">'+v+'</div></div>').join('');

// Baselines 헬퍼
function makeBaselineCard(label, key, format) {
  const s = DATA.baselines[key];
  if (!s || s.count === 0) return '';
  const f = format || (v => num(v, 2));
  return '<div class="baseline-card">' +
    '<div class="label">'+label+' <span class="muted" style="font-size:11px;font-weight:400">('+s.count+'건)</span></div>' +
    '<div class="vals">' +
      '<div>중앙값<strong>'+f(s.median)+'</strong></div>' +
      '<div>평균<strong>'+f(s.mean)+'</strong></div>' +
      '<div>Q1<strong>'+f(s.q1)+'</strong></div>' +
      '<div>Q3<strong>'+f(s.q3)+'</strong></div>' +
    '</div>' +
  '</div>';
}
function makeBoolCard(label, key) {
  const s = DATA.baselines[key];
  if (!s || s.count === 0) return '';
  const pct = (s.trueRate * 100).toFixed(1);
  return '<div class="baseline-card">' +
    '<div class="label">'+label+' <span class="muted" style="font-size:11px;font-weight:400">('+s.count+'건)</span></div>' +
    '<div class="vals">' +
      '<div>참 비율<strong>'+pct+'%</strong></div>' +
      '<div>참 건수<strong>'+s.trueCount+'</strong></div>' +
      '<div>전체<strong>'+s.count+'</strong></div>' +
      '<div>&nbsp;<strong>&nbsp;</strong></div>' +
    '</div>' +
  '</div>';
}

// Pre-surge baselines
document.getElementById('baselines-pre').innerHTML = [
  makeBaselineCard('박스권 일수', 'boxDays', v => v.toFixed(0) + '일'),
  makeBaselineCard('박스 범위 %', 'boxRangePct', v => v.toFixed(1) + '%'),
  makeBaselineCard('박스 내 위치 (0~1)', 'closePositionInBox', v => v.toFixed(2)),
  makeBaselineCard('ATR %', 'atrPct', v => v.toFixed(2) + '%'),
  makeBaselineCard('surgeStart 거래대금/20일중앙', 'surgeStartValueRatio', v => v.toFixed(2) + 'x'),
  makeBaselineCard('직전 3일 거래대금/20일중앙', 'recent3ValueRatio', v => v.toFixed(2) + 'x'),
  makeBaselineCard('5일 거래대금/시총', 'value5dRatio', v => (v*100).toFixed(2) + '%'),
  makeBaselineCard('10일 거래대금/시총', 'value10dRatio', v => (v*100).toFixed(2) + '%'),
  makeBaselineCard('20일 거래대금/시총', 'value20dRatio', v => (v*100).toFixed(2) + '%'),
  makeBaselineCard('60일 저점 대비 +%', 'returnFromLow60', v => v.toFixed(1) + '%'),
  makeBaselineCard('60일 고점 대비 -%', 'distanceFromHigh60', v => v.toFixed(1) + '%'),
  makeBaselineCard('120일 저점 대비 +%', 'returnFromLow120', v => v.toFixed(1) + '%'),
  makeBaselineCard('close vs MA20 gap %', 'closeMa20Gap', v => v.toFixed(2) + '%'),
  makeBaselineCard('MA20 기울기 (5일전 대비)', 'ma20Slope', v => v.toFixed(2) + '%'),
  makeBaselineCard('매물대 ~+10% 비율', 'overheadSupply10', v => (v*100).toFixed(1) + '%'),
  makeBaselineCard('매물대 ~+15% 비율', 'overheadSupply15', v => (v*100).toFixed(1) + '%'),
  makeBaselineCard('breakoutValuePower', 'breakoutValuePower', v => v.toFixed(2)),
  makeBoolCard('close ≥ MA20 비율', 'closeAboveMa20'),
  makeBoolCard('close ≥ MA60 비율', 'closeAboveMa60'),
  makeBoolCard('MA5 ≥ MA20 비율', 'ma5AboveMa20'),
].filter(x => x).join('');

// During-surge baselines
document.getElementById('baselines-during').innerHTML = [
  makeBaselineCard('상승기간 (일)', 'daysToPeak', v => 'D+' + v.toFixed(1)),
  makeBaselineCard('상승기간 누적거래대금/시총', 'cumulativeValueRatio', v => (v*100).toFixed(1) + '%'),
  makeBaselineCard('상승기간 일평균거래대금/시총', 'avgDailyValueRatio', v => (v*100).toFixed(2) + '%'),
  makeBaselineCard('상승일 거래대금 비율', 'upDayValueRatio', v => (v*100).toFixed(1) + '%'),
  makeBaselineCard('양봉 거래대금 비율', 'redCandleValueShare', v => (v*100).toFixed(1) + '%'),
  makeBaselineCard('최대일거래대금/시총', 'maxDailyValueRatio', v => (v*100).toFixed(1) + '%'),
  makeBaselineCard('수급(외국+기관)/거래대금', 'smartMoneyShareOfValue', v => (v*100).toFixed(2) + '%'),
  makeBaselineCard('수급(외국+기관)/시총', 'smartMoneyMcRatio', v => (v*100).toFixed(2) + '%'),
].filter(x => x).join('');

// Post-peak baselines
document.getElementById('baselines-post').innerHTML = [
  makeBaselineCard('drawdown D+5', 'drawdown5', v => v.toFixed(1) + '%'),
  makeBaselineCard('drawdown D+10', 'drawdown10', v => v.toFixed(1) + '%'),
  makeBaselineCard('drawdown D+20', 'drawdown20', v => v.toFixed(1) + '%'),
  makeBaselineCard('peak 후 하락일 거래대금 비율', 'postPeakDownDayValueShare', v => (v*100).toFixed(1) + '%'),
  makeBaselineCard('peak 후 고거래대금 하락일수', 'highVolumeDownDays', v => v.toFixed(1) + '일'),
  makeBoolCard('분산 신호 발생률', 'distributionSignal'),
].filter(x => x).join('');

// 실패 패턴 요약
const fp = document.getElementById('failure-patterns');
const dd5 = DATA.baselines.drawdown5;
const dd10 = DATA.baselines.drawdown10;
const ds = DATA.baselines.distributionSignal;
const items = [];
if (dd5 && dd5.count) items.push('peak 후 5거래일 평균 ' + dd5.median.toFixed(1) + '% drawdown — 즉, +40% 상승 종목도 단기에 ' + Math.abs(dd5.median).toFixed(1) + '% 정도 빠지는 경우가 절반 이상');
if (dd10 && dd10.count) items.push('peak 후 10거래일 중앙값 drawdown ' + dd10.median.toFixed(1) + '%');
if (ds && ds.count) items.push('peak 후 분산 신호(고거래량 하락 2일↑ 또는 하락일 거래대금 60%↑) 발생률 ' + (ds.trueRate*100).toFixed(1) + '%');
items.push('peak 시점에 추격 매수 시, 평균적으로 1주~2주 내 손실 가능성이 높음 — 상승 전 BASE 단계가 진정한 진입 타이밍');
fp.innerHTML = items.map(t => '<li>'+t+'</li>').join('');

// 점수 분포
const sb = DATA.scoreBuckets || {};
const sbOrder = ['90+', '80-89', '70-79', '60-69', '50-59', '40-49', '<40'];
document.getElementById('score-distribution').innerHTML = sbOrder.map(k => {
  const v = sb[k] || 0;
  const total = DATA.meta.totalCandidates || 1;
  const p = (v / total * 100).toFixed(1);
  return '<div class="stat"><div class="stat-label">'+k+'</div><div class="stat-value">'+v+'</div><div class="stat-sub">'+p+'%</div></div>';
}).join('');

// 후보 테이블 (브라우저에서 'top'은 window.top 전역과 충돌하므로 다른 이름 사용)
const topList = DATA.topCandidates;
document.getElementById('top-count').textContent = topList.length;
const cbody = document.getElementById('candidates-body');
// 매칭/경고 라벨을 평이하게
const SHORT_LABELS = {
  '시총대비 거래대금 유입': '거래대금 유입',
  '거래대금 증가율': '거래대금 증가',
  '외국인+기관 순매수': '외인·기관 매수',
  '박스권 형성/돌파': '박스권 형성',
  '이동평균선 정배열': 'MA 정배열',
  '매물대 부담 낮음': '매물대 적음',
  '60일 고점 근접 (매물대 위험)': '고점 근접',
  '20일 저점 +30% 이상 (추격)': '단기 추격주의',
  '매물대 부담 과다': '매물대 부담',
  '당일 +10% 이상 (단기 과열)': '당일 과열',
  '박스권 넓음 (변동성 과다)': '변동성 큼',
};
function shortLabel(s) { return SHORT_LABELS[s] || s; }

function renderCandidates(rows) {
  cbody.innerHTML = rows.map((c, i) => {
    const sn = c.snapshot;
    const ohs10 = (sn.overheadSupply10 * 100).toFixed(1);
    const sm = sn.smartMoneyShareRecent != null ? (sn.smartMoneyShareRecent*100).toFixed(2) + '%' : '-';
    const matched = (c.matched || []).map(m => '<span class="badge match" title="'+m+'">'+shortLabel(m)+'</span>').join('');
    const warns = (c.warnings || []).map(w => '<span class="badge warn" title="'+w+'">'+shortLabel(w)+'</span>').join('');
    const maInfo = (sn.closeAboveMa20 ? '<span class="pos">MA위</span>' : '<span class="neg">MA아래</span>') + ' ' + sn.closeMa20Gap.toFixed(1) + '%';
    return '<tr ' +
      'data-name="'+c.name+'" data-code="'+c.code+'" data-label="'+c.label+'">' +
      '<td>'+(i+1)+'</td>' +
      '<td class="name-col" title="'+c.name+' / '+c.code+'">' +
        '<div><span class="'+marketCls(c.market)+'">'+c.name+'</span></div>' +
        '<div class="sub">'+c.market+' · '+c.code+'</div>' +
      '</td>' +
      '<td><div>'+fmtMc(c.marketCap)+'</div><div class="sub">'+fmtNum(c.today.close)+'원</div></td>' +
      '<td><div><strong style="font-size:14px;">'+c.normalizedScore.toFixed(1)+'</strong></div><div class="sub">'+labelBadge(c.label)+'</div></td>' +
      '<td title="10일 거래대금/시총 · 오늘이 평소(20일 중앙값) 대비 몇 배">' +
        '<div>'+(sn.value10dRatio*100).toFixed(1)+'% <span class="sub">/시총</span></div>' +
        '<div class="sub">오늘 '+c.today.todayValueRatio.toFixed(2)+'x · 3일 '+sn.recent3ValueRatio.toFixed(2)+'x</div>' +
      '</td>' +
      '<td title="박스 일수·변동폭 / 박스 안 위치(0=하단,1=상단)">' +
        '<div>'+sn.boxDays+'일 · '+sn.boxRangePct.toFixed(1)+'%</div>' +
        '<div class="sub">위치 '+sn.closePositionInBox.toFixed(2)+'</div>' +
      '</td>' +
      '<td title="60일 저점 대비 +% / 60일 고점 대비 -%">' +
        '<div>저점+'+sn.returnFromLow60.toFixed(1)+'%</div>' +
        '<div class="sub">고점'+sn.distanceFromHigh60.toFixed(1)+'% · '+maInfo+'</div>' +
      '</td>' +
      '<td title="현재가 위 +10% 매물대 비중 / 외국인+기관 수급 비율">' +
        '<div>매물 '+ohs10+'%</div>' +
        '<div class="sub">수급 '+sm+'</div>' +
      '</td>' +
      '<td class="tags"><div class="tag-wrap">'+matched+'</div></td>' +
      '<td class="tags"><div class="tag-wrap">'+warns+'</div></td>' +
    '</tr>';
  }).join('');
}
renderCandidates(topList);

// 필터
const filterInput = document.getElementById('filter');
const labelFilter = document.getElementById('label-filter');
function applyFilter() {
  const q = filterInput.value.trim().toLowerCase();
  const lf = labelFilter.value;
  document.querySelectorAll('#candidates-body tr').forEach(tr => {
    const name = (tr.dataset.name || '').toLowerCase();
    const code = (tr.dataset.code || '').toLowerCase();
    const label = tr.dataset.label || '';
    const matchQ = !q || name.includes(q) || code.includes(q);
    const matchL = lf === 'all' || label === lf;
    tr.style.display = matchQ && matchL ? '' : 'none';
  });
}
filterInput.addEventListener('input', applyFilter);
labelFilter.addEventListener('change', applyFilter);

// 정렬
document.querySelectorAll('#candidates-table th').forEach((th, idx) => {
  th.addEventListener('click', () => {
    const isAsc = th.classList.contains('sorted-asc');
    document.querySelectorAll('#candidates-table th').forEach(h => h.classList.remove('sorted-asc','sorted-desc'));
    th.classList.add(isAsc ? 'sorted-desc' : 'sorted-asc');
    const tbody = document.getElementById('candidates-body');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.sort((a, b) => {
      const va = a.children[idx].textContent.replace(/[%x]/g,'').replace(/,/g,'').trim();
      const vb = b.children[idx].textContent.replace(/[%x]/g,'').replace(/,/g,'').trim();
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) return isAsc ? na - nb : nb - na;
      return isAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    rows.forEach(r => tbody.appendChild(r));
  });
});

// 대표 사례
const reps = DATA.representativeEpisodes;
document.getElementById('rep-count').textContent = reps.length;
document.getElementById('rep-list').innerHTML = reps.map(ep => {
  const pre = ep.preSurge || {};
  const dur = ep.duringSurge || {};
  const post = ep.postPeak || {};
  return '<div class="ep-card">' +
    '<div class="head">' +
      '<div><span class="name '+marketCls(ep.market)+'">'+ep.name+'</span> <span class="muted">'+ep.code+' · '+ep.market+'</span></div>' +
      '<div class="ret">+' + ep.surgeReturnPct.toFixed(1) + '%</div>' +
    '</div>' +
    '<div class="grid">' +
      '<div><span class="lbl">surgeStart</span> <span class="val">'+fmtDate(ep.surgeStartDate)+'</span></div>' +
      '<div><span class="lbl">surgePeak</span> <span class="val">'+fmtDate(ep.surgePeakDate)+'</span></div>' +
      '<div><span class="lbl">daysToPeak</span> <span class="val">D+'+ep.daysToPeak+'</span></div>' +
      '<div><span class="lbl">시총(시작)</span> <span class="val">'+fmtMc(ep.marketCapAtStart)+'</span></div>' +
      '<div><span class="lbl">박스 일수</span> <span class="val">'+(pre.boxDays||0)+'일 ('+(pre.boxRangePct||0).toFixed(1)+'%)</span></div>' +
      '<div><span class="lbl">박스 내 위치</span> <span class="val">'+(pre.closePositionInBox||0).toFixed(2)+'</span></div>' +
      '<div><span class="lbl">surgeStart 거래대금×</span> <span class="val">'+(pre.surgeStartValueRatio||0).toFixed(2)+'x</span></div>' +
      '<div><span class="lbl">5d/시총</span> <span class="val">'+((pre.value5dRatio||0)*100).toFixed(2)+'%</span></div>' +
      '<div><span class="lbl">10d/시총</span> <span class="val">'+((pre.value10dRatio||0)*100).toFixed(2)+'%</span></div>' +
      '<div><span class="lbl">L60+</span> <span class="val">+'+(pre.returnFromLow60||0).toFixed(1)+'%</span></div>' +
      '<div><span class="lbl">H60-</span> <span class="val">'+(pre.distanceFromHigh60||0).toFixed(1)+'%</span></div>' +
      '<div><span class="lbl">매물대10</span> <span class="val">'+((pre.overheadSupply10||0)*100).toFixed(1)+'%</span></div>' +
      '<div><span class="lbl">상승기간 누적/시총</span> <span class="val">'+((dur.cumulativeValueRatio||0)*100).toFixed(1)+'%</span></div>' +
      '<div><span class="lbl">최대일/시총</span> <span class="val">'+((dur.maxDailyValueRatio||0)*100).toFixed(1)+'%</span></div>' +
      '<div><span class="lbl">수급/거래대금</span> <span class="val">'+(dur.hasFlowData ? ((dur.smartMoneyShareOfValue||0)*100).toFixed(2)+'%' : '데이터 없음')+'</span></div>' +
      '<div><span class="lbl">drawdown D+5</span> <span class="val">'+(post.drawdown5 != null ? post.drawdown5.toFixed(1)+'%' : '-')+'</span></div>' +
      '<div><span class="lbl">drawdown D+10</span> <span class="val">'+(post.drawdown10 != null ? post.drawdown10.toFixed(1)+'%' : '-')+'</span></div>' +
      '<div><span class="lbl">분산 신호</span> <span class="val">'+(post.distributionSignal ? '<span class="neg">발생</span>' : '<span class="pos">없음</span>')+'</span></div>' +
    '</div>' +
  '</div>';
}).join('');

// 필수 사례 확인 (과거 episode + 현재 BMS 점수)
const reqList = document.getElementById('required-list');
reqList.innerHTML = DATA.requiredSamples.map(rs => {
  let html = '<div class="req-sample"><div class="name">'+rs.name+' ('+rs.code+')</div>';
  if (!rs.episodes || rs.episodes.length === 0) {
    html += '<div class="ep muted">+40% bigMove episode 검출되지 않음</div>';
  } else {
    html += rs.episodes.map(ep => {
      const pre = ep.preSurge || {};
      return '<div class="ep">' +
        '📈 <strong>surgeStart '+fmtDate(ep.surgeStartDate)+'</strong> → peak '+fmtDate(ep.surgePeakDate)+
        ' <span class="pos">+'+ep.surgeReturnPct.toFixed(1)+'%</span> (D+'+ep.daysToPeak+')' +
        ' · 박스 '+(pre.boxDays||0)+'일/'+(pre.boxRangePct||0).toFixed(1)+'%' +
        ' · surgeStart거래대금 '+(pre.surgeStartValueRatio||0).toFixed(2)+'x' +
        ' · L60 +'+(pre.returnFromLow60||0).toFixed(1)+'%' +
        ' · 매물대10 '+((pre.overheadSupply10||0)*100).toFixed(1)+'%' +
        '</div>';
    }).join('');
  }
  // 현재 BMS 점수
  if (rs.currentCandidate) {
    const cc = rs.currentCandidate;
    const b = cc.breakdown;
    const matched = (cc.matched||[]).map(m => '<span class="badge match">'+m+'</span>').join('');
    const warns = (cc.warnings||[]).map(w => '<span class="badge warn">'+w+'</span>').join('');
    html += '<div class="ep" style="margin-top:8px;padding-top:8px;border-top:1px dashed #334155;">' +
      '🎯 <strong>현재 BMS 점수</strong>: <strong style="color:#f1f5f9">'+cc.normalizedScore.toFixed(1)+'</strong> '+labelBadge(cc.label)+' (전체 '+cc.rank+'위)' +
      '<br><span class="muted" style="font-size:11px">' +
      '거래대금/시총='+b.valueMcInflow+'/25 · 증가율='+b.valueGrowth+'/20 · 수급='+(b.smartMoney != null ? b.smartMoney+'/15' : '-')+
      ' · 박스='+b.box+'/15 · MA='+b.ma+'/10 · 매물대='+b.overhead+'/10 · 위치='+b.pricePosition+'/5</span>' +
      (matched ? '<div class="matched-list">'+matched+'</div>' : '') +
      (warns ? '<div class="matched-list">'+warns+'</div>' : '') +
      '</div>';
  } else {
    html += '<div class="ep muted" style="margin-top:6px">현재 BMS 후보 점수화 대상에 없음 (시총/거래대금 미달 또는 차트 데이터 부족)</div>';
  }
  html += '</div>';
  return html;
}).join('');
</script>
</body>
</html>`;

  return HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(data));
}

// ─────────────────────── CLI ───────────────────────

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('오류:', e);
    process.exit(1);
  }
}

module.exports = {
  config,
  findBigMoveEpisodes,
  analyzePreSurge,
  analyzeDuringSurge,
  analyzePostPeak,
  aggregateBaselines,
  scoreCurrentCandidate,
  generateHTML,
};
