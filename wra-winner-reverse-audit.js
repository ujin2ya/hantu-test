#!/usr/bin/env node
/**
 * WRA — Winner Reverse Audit
 *
 * 목적:
 *   "오를 것 같은 종목을 바로 찾는 모델"이 아니다.
 *   먼저 과거 데이터에서 실제로 N거래일 안 +X% 이상 오른 종목을 자동으로 찾아내고,
 *   그 종목들이 오르기 전 / 오르는 중 / 오른 후에 어떤 거래대금·거래량·시총 대비 거래대금·
 *   이평선 위치·박스권·매물대 구조를 가졌는지 역산하는 보고서다.
 *
 * 본 스크립트는 다음이 아니다:
 *   - live signal, watchlist, 실시간 후보 탐지, 매수 후보 추천
 *   - "오늘 살 종목" 화면
 *   - 종목명 하드코딩 결과 강제
 *
 * 본 스크립트는 다음이다:
 *   - 과거 성공 샘플의 시작 조건 역산 보고서 (audit)
 *
 * 데이터 누수 주의:
 *   - 성공 샘플 선별은 미래 수익률을 사용한다 (audit이므로 정상).
 *   - T0 조건 분석은 T0 시점 이전 또는 당일까지의 데이터만 사용해야 한다.
 *   - 진행/하락 구간은 future를 사용한다 (사후 측정).
 *
 * 실행:
 *   node wra-winner-reverse-audit.js
 *   node wra-winner-reverse-audit.js --target=30 --track=20
 *   node wra-winner-reverse-audit.js --sample-stocks=100   # 빠른 테스트
 *
 * 출력:
 *   reports/wra-winner-reverse-audit-result.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
})();

const CONFIG = {
  // 분석 기간
  ANALYSIS_START: args.start || '20250401',
  ANALYSIS_END: args.end || '20260430',

  // 성공 샘플 정의
  TARGET_RETURN: parseFloat(args.target || '40') / 100,   // +40% 기본 (옵션: 30/40/50)
  TRACK_DAYS: parseInt(args.track || '20'),                // 20거래일 (옵션: 15/20/25/30)
  PRICE_BASIS: args.basis || 'high',                       // 'high' (기본) | 'close' (확장 여지)

  // 중복 제거
  DEDUP_DAYS: parseInt(args.dedup || '20'),                // 같은 종목 20거래일 안 → 가장 이른 시작점만

  // T0 역산 lookback
  T0_BACKWARD_LOOKBACK: 30,

  // 4구간 분석 lookback
  PREP_LOOKBACK: 30,
  POST_PEAK_DAYS: 20,

  // universe 필터 — MIN_HISTORY를 60으로 낮춤 (운영 cache의 차트 길이 분포가 60~250 분산이라
  // 120 기준으로는 universe가 96개로 좁혀짐. 60이면 ~2,300개로 확장. 52주 고점은 사용 가능 길이 기준).
  MIN_HISTORY: 60,
  MIN_MARKET_CAP: 30_000_000_000,                          // 300억

  // 테스트
  SAMPLE_STOCKS: args['sample-stocks'] ? parseInt(args['sample-stocks']) : null,
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcluded(name) {
  return name && EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

// ─────────────────────── 유틸리티 ───────────────────────

function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}

function avg(arr) {
  const f = arr.filter(v => v != null && Number.isFinite(v));
  if (f.length === 0) return null;
  return f.reduce((a, b) => a + b, 0) / f.length;
}

function median(arr) {
  const f = arr.filter(v => v != null && Number.isFinite(v));
  if (f.length === 0) return null;
  const s = [...f].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function quartile(arr, q) {
  const f = arr.filter(v => v != null && Number.isFinite(v));
  if (f.length === 0) return null;
  const s = [...f].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (s[base + 1] != null) return s[base] + rest * (s[base + 1] - s[base]);
  return s[base];
}

function statsBlock(arr) {
  const f = arr.filter(v => v != null && Number.isFinite(v));
  if (f.length === 0) return { count: 0 };
  return {
    count: f.length,
    mean: avg(f),
    median: median(f),
    q1: quartile(f, 0.25),
    q3: quartile(f, 0.75),
    min: Math.min(...f),
    max: Math.max(...f),
  };
}

function safe(num, denom) {
  return denom && Number.isFinite(num) && Number.isFinite(denom) ? num / denom : null;
}

// ─────────────────────── 매물대 분석 ───────────────────────

function analyzeOverhead(rows, idx, lookback = 60, bins = 20) {
  const startIdx = Math.max(0, idx - lookback);
  const window = rows.slice(startIdx, idx);
  if (window.length === 0) return null;

  const lo = Math.min(...window.map(r => r.low));
  const hi = Math.max(...window.map(r => r.high));
  if (hi <= lo) return null;

  const binSize = (hi - lo) / bins;
  const histogram = Array(bins).fill(0);
  let totalValue = 0;

  window.forEach(r => {
    const v = r.valueApprox || 0;
    const midPrice = (r.high + r.low) / 2;
    const binIdx = Math.min(bins - 1, Math.max(0, Math.floor((midPrice - lo) / binSize)));
    histogram[binIdx] += v;
    totalValue += v;
  });

  const close = rows[idx].close;
  const closeBin = Math.min(bins - 1, Math.max(0, Math.floor((close - lo) / binSize)));

  let aboveValue = 0, belowValue = 0;
  histogram.forEach((v, i) => {
    if (i > closeBin) aboveValue += v;
    else if (i < closeBin) belowValue += v;
  });

  return {
    rangeLow: lo,
    rangeHigh: hi,
    totalValue,
    overheadRatio: totalValue ? aboveValue / totalValue : 0,
    supportRatio: totalValue ? belowValue / totalValue : 0,
    closeBin,
    bins: histogram,
  };
}

// ─────────────────────── 단일 종목 메트릭 사전 계산 ───────────────────────

function precomputeIndicators(rows) {
  const closes = rows.map(r => r.close);
  const highs = rows.map(r => r.high);
  const lows = rows.map(r => r.low);
  const vols = rows.map(r => r.volume || 0);
  const vals = rows.map(r => r.valueApprox || 0);

  // 이평선
  const ma = (arr, period) => {
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= period) sum -= arr[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  };

  return {
    closes, highs, lows, vols, vals,
    ma5: ma(closes, 5),
    ma20: ma(closes, 20),
    ma60: ma(closes, 60),
    ma120: ma(closes, 120),
    avgVol20: ma(vols, 20),
    avgVal20: ma(vals, 20),
    avgVol5: ma(vols, 5),
    avgVal5: ma(vals, 5),
  };
}

function rollingMin(arr, idx, window) {
  let m = Infinity;
  for (let j = Math.max(0, idx - window + 1); j <= idx; j++) if (arr[j] < m) m = arr[j];
  return m === Infinity ? null : m;
}
function rollingMax(arr, idx, window) {
  let m = -Infinity;
  for (let j = Math.max(0, idx - window + 1); j <= idx; j++) if (arr[j] > m) m = arr[j];
  return m === -Infinity ? null : m;
}

// ─────────────────────── 성공 샘플 자동 선별 ───────────────────────

function findSuccessSamples(rows, indi) {
  const samples = [];
  const lastValidBase = rows.length - CONFIG.TRACK_DAYS - 1;

  for (let i = CONFIG.MIN_HISTORY; i <= lastValidBase; i++) {
    const baseDate = rows[i].date;
    if (baseDate < CONFIG.ANALYSIS_START || baseDate > CONFIG.ANALYSIS_END) continue;
    const baseClose = rows[i].close;
    if (!baseClose) continue;

    let peakHigh = -Infinity, peakIdx = -1;
    for (let j = i + 1; j <= i + CONFIG.TRACK_DAYS && j < rows.length; j++) {
      if (rows[j].high > peakHigh) { peakHigh = rows[j].high; peakIdx = j; }
    }
    if (peakIdx < 0) continue;

    const futureReturn = peakHigh / baseClose - 1;
    if (futureReturn < CONFIG.TARGET_RETURN) continue;

    // 목표 도달일 (target hit day) — 첫 도달일
    let targetHitIdx = peakIdx;
    for (let j = i + 1; j <= peakIdx; j++) {
      if (rows[j].high / baseClose - 1 >= CONFIG.TARGET_RETURN) { targetHitIdx = j; break; }
    }
    samples.push({
      baseIdx: i,
      baseDate,
      baseClose,
      peakIdx,
      peakDate: rows[peakIdx].date,
      peakHigh,
      peakReturn: futureReturn * 100,
      targetHitIdx,
      targetHitDate: rows[targetHitIdx].date,
      daysToTarget: targetHitIdx - i,
    });
  }
  return samples;
}

// 중복 제거: 같은 종목에서 DEDUP_DAYS 안 여러 샘플 → 가장 이른 시작점만
function dedupSamples(samples) {
  if (samples.length === 0) return samples;
  const sorted = [...samples].sort((a, b) => a.baseIdx - b.baseIdx);
  const out = [];
  let lastBaseIdx = -Infinity;
  let lastPeakIdx = -Infinity;
  sorted.forEach(s => {
    if (s.baseIdx - lastBaseIdx <= CONFIG.DEDUP_DAYS && s.baseIdx <= lastPeakIdx) return;
    out.push(s);
    lastBaseIdx = s.baseIdx;
    lastPeakIdx = s.peakIdx;
  });
  return out;
}

// ─────────────────────── 동적 박스권 탐지 ───────────────────────
//
// 단순 PREP_LOOKBACK 고정이 아니라, T0 직전 20~80거래일 사이에서
// "안정 구간"을 동적으로 찾는다.
//   - boxRangePct ≤ 25% (좁은 변동폭)
//   - 저점이 무너지지 않음 (window low가 5% 이상 추가 하락 없음)
//   - 종가가 구간 안에 머무름
//   - 가능하면 가장 긴 안정 구간을 반환
//
// 데이터 누수 방지: idx 이전 데이터만 사용.
function findDynamicBox(rows, indi, idx, opts = {}) {
  const minLen = opts.minLen || 20;
  const maxLen = opts.maxLen || 80;
  const maxRangePct = opts.maxRangePct || 25;
  // 가장 긴 길이부터 찾기 (긴 박스 우선)
  let best = null;
  for (let len = maxLen; len >= minLen; len -= 5) {
    const startIdx = idx - len;
    if (startIdx < 0) continue;
    const window = rows.slice(startIdx, idx);
    if (window.length < minLen) continue;

    const lows = window.map(r => r.low);
    const highs = window.map(r => r.high);
    const closes = window.map(r => r.close);
    const lo = Math.min(...lows);
    const hi = Math.max(...highs);
    if (lo <= 0) continue;
    const rangePct = (hi / lo - 1) * 100;
    if (rangePct > maxRangePct) continue;

    // 저점 안정성: 마지막 5일 low min ≥ 첫 5일 low min × 0.95
    const firstHalfLow = Math.min(...lows.slice(0, 5));
    const lastHalfLow = Math.min(...lows.slice(-5));
    if (firstHalfLow > 0 && lastHalfLow < firstHalfLow * 0.95) continue;

    // 종가 안정성: 모든 종가가 [lo*0.97, hi*1.03] 안
    const stable = closes.every(c => c >= lo * 0.97 && c <= hi * 1.03);
    if (!stable) continue;

    best = { startIdx, endIdx: idx - 1, duration: len, low: lo, high: hi, rangePct };
    break; // 가장 긴 것 발견 시 종료
  }

  if (best) return best;
  // fallback: 30일 단순 박스
  const fbStart = Math.max(0, idx - 30);
  const fbWin = rows.slice(fbStart, idx);
  if (fbWin.length === 0) return null;
  const lo = Math.min(...fbWin.map(r => r.low));
  const hi = Math.max(...fbWin.map(r => r.high));
  return {
    startIdx: fbStart,
    endIdx: idx - 1,
    duration: fbWin.length,
    low: lo,
    high: hi,
    rangePct: lo > 0 ? (hi / lo - 1) * 100 : 0,
    fallback: true,
  };
}

// ─────────────────────── T0 4유형 ───────────────────────
//
// 상승 시작점을 하나로 고정하지 않고 4가지 유형으로 분리한다.
// 각각 baseIdx 직전 T0_BACKWARD_LOOKBACK 안에서 별도 후보를 찾는다.
// 데이터 누수 방지: T0 후보 평가는 baseIdx 이전 데이터만 사용.

function findT0Variants(rows, indi, sample) {
  const { baseIdx } = sample;
  const lo = Math.max(CONFIG.MIN_HISTORY, baseIdx - CONFIG.T0_BACKWARD_LOOKBACK);
  const hi = baseIdx;

  // ─ 보조 함수
  const dayMetrics = (j) => {
    const prev = rows[j - 1];
    const cur = rows[j];
    if (!prev || !cur) return null;
    const range = cur.high - cur.low;
    return {
      valueRatio20: indi.avgVal20[j - 1] ? cur.valueApprox / indi.avgVal20[j - 1] : 0,
      volumeRatio20: indi.avgVol20[j - 1] ? cur.volume / indi.avgVol20[j - 1] : 0,
      closeLocation: range > 0 ? (cur.close - cur.low) / range : 0.5,
      dayReturn: prev.close ? (cur.close / prev.close - 1) * 100 : 0,
      closeAboveMa5: indi.ma5[j - 1] ? cur.close >= indi.ma5[j - 1] : null,
      closeAboveMa20: indi.ma20[j - 1] ? cur.close >= indi.ma20[j - 1] : null,
    };
  };

  // T0_EARLY_TRACE: 가장 먼저 나타난 이상징후
  //   MA 회복(close가 MA20 아래→위), 거래량 +30%, 거래대금 +30% 중 가장 빠른 후보
  let earlyTrace = null;
  for (let j = lo; j <= hi; j++) {
    const ma20 = indi.ma20[j];
    const ma20Prev = indi.ma20[j - 1];
    const closePrev = indi.closes[j - 1];
    const closeCur = indi.closes[j];
    const maRecover = ma20Prev && ma20 && closePrev < ma20Prev && closeCur >= ma20;
    const volUp = indi.avgVol20[j - 1] && indi.vols[j] >= indi.avgVol20[j - 1] * 1.3;
    const valUp = indi.avgVal20[j - 1] && indi.vals[j] >= indi.avgVal20[j - 1] * 1.3;
    if (maRecover || volUp || valUp) { earlyTrace = j; break; }
  }

  // T0_VALUE_CONFIRM: 거래대금/거래량 의미 있게 증가 + closeLocation 강세
  let valueConfirm = null;
  for (let j = lo; j <= hi; j++) {
    const m = dayMetrics(j);
    if (!m) continue;
    if (m.valueRatio20 >= 1.5 && m.volumeRatio20 >= 1.3 && m.closeLocation >= 0.5) {
      valueConfirm = j;
      break;
    }
  }

  // T0_BOX_BREAK: 박스권 상단 종가 돌파
  //   동적 박스를 j 시점에서 찾고, close > boxUpper + valueRatio20 ≥ 1.3
  let boxBreakIdx = null;
  for (let j = lo; j <= hi; j++) {
    const box = findDynamicBox(rows, indi, j);
    if (!box) continue;
    const m = dayMetrics(j);
    if (!m) continue;
    if (rows[j].close > box.high && m.valueRatio20 >= 1.3) {
      boxBreakIdx = j;
      break;
    }
  }

  // T0_SURGE_START: 본격 상승 시작일
  //   조건 A: dayReturn ≥ 5% AND closeLocation ≥ 0.7 AND valueRatio20 ≥ 1.5
  //   조건 B: 최근 5거래일 누적 상승률 ≥ 10%로 처음 전환
  let surgeStart = null;
  for (let j = lo; j <= hi; j++) {
    const m = dayMetrics(j);
    if (!m) continue;
    const condA = m.dayReturn >= 5 && m.closeLocation >= 0.7 && m.valueRatio20 >= 1.5;
    if (condA) { surgeStart = j; break; }
    const close5 = indi.closes[j - 5];
    const ret5 = close5 ? (rows[j].close / close5 - 1) * 100 : 0;
    if (ret5 >= 10) { surgeStart = j; break; }
  }

  return {
    earlyTraceIdx: earlyTrace,
    valueConfirmIdx: valueConfirm,
    boxBreakIdx: boxBreakIdx,
    surgeStartIdx: surgeStart,
    earlyTraceDate: earlyTrace != null ? rows[earlyTrace].date : null,
    valueConfirmDate: valueConfirm != null ? rows[valueConfirm].date : null,
    boxBreakDate: boxBreakIdx != null ? rows[boxBreakIdx].date : null,
    surgeStartDate: surgeStart != null ? rows[surgeStart].date : null,
  };
}

// 한 idx에서 T0 측정 메트릭 (T0별 통계 비교용)
function measureT0(rows, indi, idx, marketCap, baseIdx) {
  if (idx == null || idx < 1 || idx >= rows.length) return null;
  const cur = rows[idx];
  const prev = rows[idx - 1];
  if (!cur || !prev) return null;
  const range = cur.high - cur.low;
  const recentLow20 = rollingMin(indi.lows, idx - 1, 20);
  const recentHigh20 = rollingMax(indi.highs, idx - 1, 20);
  const high52w = rollingMax(indi.highs, idx - 1, Math.min(idx, 252));
  const box = findDynamicBox(rows, indi, idx);
  const overhead = analyzeOverhead(rows, idx - 1, 60, 20);

  return {
    idx,
    date: cur.date,
    valueRatio20: indi.avgVal20[idx - 1] ? cur.valueApprox / indi.avgVal20[idx - 1] : null,
    volumeRatio20: indi.avgVol20[idx - 1] ? cur.volume / indi.avgVol20[idx - 1] : null,
    valueToMarketCap: marketCap ? cur.valueApprox / marketCap : null,
    closeLocation: range > 0 ? (cur.close - cur.low) / range : 0.5,
    closeToMA5: indi.ma5[idx - 1] ? (cur.close / indi.ma5[idx - 1] - 1) * 100 : null,
    closeToMA20: indi.ma20[idx - 1] ? (cur.close / indi.ma20[idx - 1] - 1) * 100 : null,
    closeToMA60: indi.ma60[idx - 1] ? (cur.close / indi.ma60[idx - 1] - 1) * 100 : null,
    closeToMA120: indi.ma120[idx - 1] ? (cur.close / indi.ma120[idx - 1] - 1) * 100 : null,
    closeFrom52WeekHigh: high52w ? (cur.close / high52w - 1) * 100 : null,
    closeFromRecentLow20: recentLow20 ? (cur.close / recentLow20 - 1) * 100 : null,
    closeFromRecentHigh20: recentHigh20 ? (cur.close / recentHigh20 - 1) * 100 : null,
    boxRangePct: box?.rangePct,
    dynamicBoxDuration: box?.duration,
    boxFallback: !!box?.fallback,
    overheadRatio: overhead?.overheadRatio,
    supportRatio: overhead?.supportRatio,
    daysToTargetFromT0: baseIdx - idx,  // 음수 가능 (T0가 baseIdx 직후일 때)
  };
}

// 호환성을 위해 v1에서 쓰던 findT0Candidates도 유지 (5종 후보 → bestEstimated 산출)
function findT0Candidates(rows, indi, sample) {
  const v = findT0Variants(rows, indi, sample);
  // 4유형 중 가장 이른 idx를 bestEstimated로
  const candidates = [v.earlyTraceIdx, v.valueConfirmIdx, v.boxBreakIdx, v.surgeStartIdx].filter(x => x != null);
  const bestEstimated = candidates.length ? Math.min(...candidates) : sample.baseIdx;

  return {
    earliestVolumeSignalIdx: v.earlyTraceIdx,                  // legacy 호환 (이름만)
    earliestValueSignalIdx: v.valueConfirmIdx,
    maBreakSignalIdx: v.earlyTraceIdx,
    boxBreakSignalIdx: v.boxBreakIdx,
    bestEstimatedStartIdx: bestEstimated,
    bestEstimatedStartDay: rows[bestEstimated].date,
    variants: v,                                                // 4유형 idx/date
  };
}

// ─────────────────────── 4구간 분석 ───────────────────────

// 1. 준비 구간 (dynamic box + 보조 메트릭)
function analyzePreparation(rows, indi, t0Idx, marketCap) {
  if (t0Idx <= 0) return null;

  // dynamic box (20~80일 안 가장 긴 안정 구간)
  const box = findDynamicBox(rows, indi, t0Idx);
  // 최근 5일 vs 이전 5일 거래량/거래대금 비교를 위한 작은 window
  const recentWin = rows.slice(Math.max(0, t0Idx - 10), t0Idx);
  const recent5Vols = recentWin.slice(-5).map(r => r.volume || 0);
  const prev5Vols = recentWin.slice(0, 5).map(r => r.volume || 0);
  const recent5Vals = recentWin.slice(-5).map(r => r.valueApprox || 0);
  const prev5Vals = recentWin.slice(0, 5).map(r => r.valueApprox || 0);

  const dryRatio = safe(avg(recent5Vols), avg(prev5Vols));
  const valueIncrease = safe(avg(recent5Vals), avg(prev5Vals));

  // 이평선 위치 (T0 직전 영업일 기준)
  const t0PrevClose = indi.closes[t0Idx - 1] || null;
  const t0PrevMa20 = indi.ma20[t0Idx - 1];
  const t0PrevMa60 = indi.ma60[t0Idx - 1];

  // 저점 상승 여부 (최근 5 vs 이전 5)
  const recentLows = recentWin.map(r => r.low);
  const last5Low = recentLows.length >= 5 ? Math.min(...recentLows.slice(-5)) : null;
  const prev5Low = recentLows.length >= 10 ? Math.min(...recentLows.slice(0, 5)) : null;
  const lowsRising = (prev5Low != null && last5Low != null && last5Low >= prev5Low * 0.99);

  // 매물대 (T0 이전 60일)
  const overhead = analyzeOverhead(rows, t0Idx - 1, 60, 20);

  return {
    days: box?.duration || 0,
    boxHigh: box?.high,
    boxLow: box?.low,
    boxRangePct: box?.rangePct,
    boxDuration: box?.duration,                // 동적 길이
    boxFallback: box?.fallback || false,
    dryRatio,
    valueIncrease,
    closeAboveMa20: t0PrevClose != null && t0PrevMa20 != null ? t0PrevClose >= t0PrevMa20 : null,
    closeAboveMa60: t0PrevClose != null && t0PrevMa60 != null ? t0PrevClose >= t0PrevMa60 : null,
    lowsRising,
    overheadRatio: overhead?.overheadRatio,
    supportRatio: overhead?.supportRatio,
  };
}

// 2. T0 당일 분석 — T0 시점까지의 데이터만 사용 (누수 금지)
function analyzeT0(rows, indi, t0Idx, marketCap) {
  if (t0Idx <= 0 || t0Idx >= rows.length) return null;
  const t0 = rows[t0Idx];
  const prev = rows[t0Idx - 1];
  if (!t0 || !prev) return null;

  const todayValue = t0.valueApprox || 0;
  const todayVolume = t0.volume || 0;
  const avgVol20 = indi.avgVol20[t0Idx - 1];   // T0 이전까지의 20일 평균
  const avgVal20 = indi.avgVal20[t0Idx - 1];

  // 가격 위치
  const range = t0.high - t0.low;
  const closeLocation = range > 0 ? (t0.close - t0.low) / range : 0.5;

  const recentLow20 = rollingMin(indi.lows, t0Idx - 1, 20);
  const recentHigh20 = rollingMax(indi.highs, t0Idx - 1, 20);
  const recentLow60 = rollingMin(indi.lows, t0Idx - 1, 60);
  const recentHigh60 = rollingMax(indi.highs, t0Idx - 1, 60);
  const high52w = rollingMax(indi.highs, t0Idx - 1, Math.min(t0Idx, 252));

  // 박스 상단 (T0 이전 PREP 일)
  const prepWindow = rows.slice(Math.max(0, t0Idx - CONFIG.PREP_LOOKBACK), t0Idx);
  const boxUpper = prepWindow.length ? Math.max(...prepWindow.map(r => r.high)) : null;

  return {
    date: t0.date,
    open: t0.open,
    high: t0.high,
    low: t0.low,
    close: t0.close,
    volume: todayVolume,
    value: todayValue,
    valueToMarketCap: marketCap ? todayValue / marketCap : null,
    volumeRatio20: avgVol20 ? todayVolume / avgVol20 : null,
    valueRatio20: avgVal20 ? todayValue / avgVal20 : null,
    closeLocation,
    closeFromRecentLow20: recentLow20 ? (t0.close / recentLow20 - 1) * 100 : null,
    closeFromRecentHigh20: recentHigh20 ? (t0.close / recentHigh20 - 1) * 100 : null,
    closeFromRecentLow60: recentLow60 ? (t0.close / recentLow60 - 1) * 100 : null,
    closeFromRecentHigh60: recentHigh60 ? (t0.close / recentHigh60 - 1) * 100 : null,
    closeFrom52WeekHigh: high52w ? (t0.close / high52w - 1) * 100 : null,
    closeToMA5: indi.ma5[t0Idx - 1] ? (t0.close / indi.ma5[t0Idx - 1] - 1) * 100 : null,
    closeToMA20: indi.ma20[t0Idx - 1] ? (t0.close / indi.ma20[t0Idx - 1] - 1) * 100 : null,
    closeToMA60: indi.ma60[t0Idx - 1] ? (t0.close / indi.ma60[t0Idx - 1] - 1) * 100 : null,
    closeToMA120: indi.ma120[t0Idx - 1] ? (t0.close / indi.ma120[t0Idx - 1] - 1) * 100 : null,
    boxUpper,
    closeToBoxUpper: boxUpper ? (t0.close / boxUpper - 1) * 100 : null,
    boxUpperBreak: boxUpper != null && t0.close > boxUpper,
    dayReturn: prev.close ? (t0.close / prev.close - 1) * 100 : null,
  };
}

// 3. 진행 구간 (T0 이후 ~ peak 또는 targetHit)
function analyzeProgression(rows, t0Idx, peakIdx, targetHitIdx, marketCap) {
  const endIdx = Math.min(peakIdx, rows.length - 1);
  const window = rows.slice(t0Idx, endIdx + 1);
  if (window.length === 0) return null;

  let cumValue = 0, cumVolume = 0, redValue = 0, blueValue = 0;
  let upDays = 0, downDays = 0;
  let maxRet = -Infinity;

  window.forEach((r, i) => {
    const v = r.valueApprox || 0;
    cumValue += v;
    cumVolume += r.volume || 0;
    if (r.close > r.open) redValue += v;
    else if (r.close < r.open) blueValue += v;
    const prevClose = i > 0 ? window[i - 1].close : (rows[t0Idx - 1]?.close || r.open);
    if (prevClose && r.close > prevClose) upDays++;
    else if (prevClose && r.close < prevClose) downDays++;
    const ret = (r.high / window[0].close - 1) * 100;
    if (ret > maxRet) maxRet = ret;
  });

  return {
    days: window.length,
    daysToTarget: targetHitIdx - t0Idx,
    cumulativeValue: cumValue,
    cumulativeVolume: cumVolume,
    cumulativeValueToMarketCap: marketCap ? cumValue / marketCap : null,
    redCandleValueRatio: cumValue ? redValue / cumValue : null,
    blueCandleValueRatio: cumValue ? blueValue / cumValue : null,
    upDays,
    downDays,
    maxReturn: Number.isFinite(maxRet) ? maxRet : null,
  };
}

// 4. 하락 구간 (peak 이후 N일)
function analyzePostPeak(rows, indi, peakIdx, marketCap) {
  const post = rows.slice(peakIdx + 1, peakIdx + 1 + CONFIG.POST_PEAK_DAYS);
  if (post.length === 0) return null;
  const peakHigh = rows[peakIdx].high;
  const peakClose = rows[peakIdx].close;

  let blueValue = 0, redValue = 0, totalValue = 0;
  let totalVolume = 0;
  let maxDrawdown = 0;

  post.forEach(r => {
    const v = r.valueApprox || 0;
    totalValue += v;
    totalVolume += r.volume || 0;
    if (r.close < r.open) blueValue += v;
    else if (r.close > r.open) redValue += v;
    const dd = (r.low / peakHigh - 1) * 100;
    if (dd < maxDrawdown) maxDrawdown = dd;
  });

  // 5/20일선 이탈 여부
  let break5 = false, break20 = false;
  for (let j = peakIdx + 1; j <= Math.min(peakIdx + CONFIG.POST_PEAK_DAYS, rows.length - 1); j++) {
    const ma5 = indi.ma5[j];
    const ma20 = indi.ma20[j];
    if (ma5 && rows[j].close < ma5) break5 = true;
    if (ma20 && rows[j].close < ma20) break20 = true;
  }

  // 이전 진행 구간 상승 거래대금 비교
  // 진행 구간은 별도라 여기선 단순 비교: postCumValue vs preceding T0~peak 평균
  return {
    days: post.length,
    postCumulativeValue: totalValue,
    postCumulativeVolume: totalVolume,
    postBlueCandleValueRatio: totalValue ? blueValue / totalValue : null,
    postRedCandleValueRatio: totalValue ? redValue / totalValue : null,
    maxDrawdownFromPeak: maxDrawdown,
    breakBelowMa5: break5,
    breakBelowMa20: break20,
  };
}

// ─────────────────────── 패턴 분류 ───────────────────────

function classifyPatterns(sample, rows, indi, t0Idx) {
  const tags = [];
  const prep = sample.preparation || {};
  const t0 = sample.t0 || {};

  // VALUE_ACCUMULATION: 준비 구간에서 거래대금 증가 + T0 valueRatio20 >= 1.5
  if ((prep.valueIncrease || 0) >= 1.2 && (t0.valueRatio20 || 0) >= 1.5) tags.push('VALUE_ACCUMULATION');

  // BOX_BREAK: T0 박스 상단 돌파
  if (t0.boxUpperBreak) tags.push('BOX_BREAK');

  // MA_RECOVERY (강화):
  //   - T0 이전 5거래일 중 3일 이상 close < MA20
  //   - T0 close >= MA20
  //   - T0 close >= MA5
  //   - T0 valueRatio20 >= 1.3
  //   - T0 closeLocation >= 0.6
  if (rows && indi && t0Idx) {
    let belowMa20Count = 0;
    for (let j = Math.max(0, t0Idx - 5); j < t0Idx; j++) {
      const ma = indi.ma20[j];
      if (ma && indi.closes[j] < ma) belowMa20Count++;
    }
    const ma5T0 = indi.ma5[t0Idx];
    const ma20T0 = indi.ma20[t0Idx];
    const closeT0 = rows[t0Idx]?.close;
    const condStrict = belowMa20Count >= 3
      && ma20T0 && closeT0 >= ma20T0
      && ma5T0 && closeT0 >= ma5T0
      && (t0.valueRatio20 || 0) >= 1.3
      && (t0.closeLocation || 0) >= 0.6;
    if (condStrict) tags.push('MA_RECOVERY');
  }

  // LOW_FLOAT_FAST_SURGE: 시총 작고 T0 valueToMarketCap 큼
  if (sample.marketCap && sample.marketCap < 200_000_000_000 && (t0.valueToMarketCap || 0) >= 0.05) {
    tags.push('LOW_FLOAT_FAST_SURGE');
  }

  // RESISTANCE_BREAK: 준비 구간에서 위쪽 매물대가 컸는데 T0 박스 상단 돌파
  if ((prep.overheadRatio || 0) >= 0.30 && t0.boxUpperBreak) tags.push('RESISTANCE_BREAK');

  // NO_RESISTANCE_RUN: 위쪽 매물대 얇음
  if ((prep.overheadRatio || 0) <= 0.15) tags.push('NO_RESISTANCE_RUN');

  return tags;
}

// ─────────────────────── 단일 종목 분석 ───────────────────────

function analyzeStock(rows, code, name, market, marketCap) {
  if (rows.length < CONFIG.MIN_HISTORY + CONFIG.TRACK_DAYS) {
    return { samples: [], excludeReason: 'data_short' };
  }
  const indi = precomputeIndicators(rows);

  let raw = findSuccessSamples(rows, indi);
  if (raw.length === 0) return { samples: [], excludeReason: null };

  const deduped = dedupSamples(raw);
  const out = [];
  deduped.forEach(s => {
    const t0Cands = findT0Candidates(rows, indi, s);
    const t0Idx = t0Cands.bestEstimatedStartIdx;

    // 4유형 T0별 측정 (각 유형의 idx에서 메트릭 계산 — null이면 null)
    const t0Variants = t0Cands.variants;
    const t0Measurements = {
      EARLY_TRACE: measureT0(rows, indi, t0Variants.earlyTraceIdx, marketCap, s.baseIdx),
      VALUE_CONFIRM: measureT0(rows, indi, t0Variants.valueConfirmIdx, marketCap, s.baseIdx),
      BOX_BREAK: measureT0(rows, indi, t0Variants.boxBreakIdx, marketCap, s.baseIdx),
      SURGE_START: measureT0(rows, indi, t0Variants.surgeStartIdx, marketCap, s.baseIdx),
    };

    const preparation = analyzePreparation(rows, indi, t0Idx, marketCap);
    const t0 = analyzeT0(rows, indi, t0Idx, marketCap);
    const progression = analyzeProgression(rows, t0Idx, s.peakIdx, s.targetHitIdx, marketCap);
    const postPeak = analyzePostPeak(rows, indi, s.peakIdx, marketCap);

    const sample = {
      code, name, market, marketCap,
      baseDate: s.baseDate,
      baseClose: s.baseClose,
      peakDate: s.peakDate,
      peakIdx: s.peakIdx,
      peakHigh: s.peakHigh,
      peakReturn: s.peakReturn,
      targetHitDate: s.targetHitDate,
      daysToTarget: s.daysToTarget,
      t0Date: t0Cands.bestEstimatedStartDay,
      t0Candidates: t0Cands,
      t0Measurements,
      preparation,
      t0,
      progression,
      postPeak,
    };
    sample.patterns = classifyPatterns(sample, rows, indi, t0Idx);
    out.push(sample);
  });
  return { samples: out, rawCount: raw.length, dedupedCount: deduped.length };
}

// ─────────────────────── 통계 집계 ───────────────────────

function aggregateStats(samples) {
  const pick = (path) => samples.map(s => {
    let cur = s;
    for (const p of path.split('.')) cur = cur ? cur[p] : null;
    return cur;
  });

  return {
    peakReturn: statsBlock(pick('peakReturn')),
    daysToTarget: statsBlock(pick('daysToTarget')),
    boxRangePct: statsBlock(pick('preparation.boxRangePct')),
    boxDuration: statsBlock(pick('preparation.boxDuration')),
    overheadRatio: statsBlock(pick('preparation.overheadRatio')),
    supportRatio: statsBlock(pick('preparation.supportRatio')),
    t0ValueToMarketCap: statsBlock(pick('t0.valueToMarketCap')),
    t0ValueRatio20: statsBlock(pick('t0.valueRatio20')),
    t0VolumeRatio20: statsBlock(pick('t0.volumeRatio20')),
    t0CloseLocation: statsBlock(pick('t0.closeLocation')),
    t0CloseToMA5: statsBlock(pick('t0.closeToMA5')),
    t0CloseToMA20: statsBlock(pick('t0.closeToMA20')),
    t0CloseToMA60: statsBlock(pick('t0.closeToMA60')),
    t0CloseFrom52WeekHigh: statsBlock(pick('t0.closeFrom52WeekHigh')),
    t0CloseFromRecentLow20: statsBlock(pick('t0.closeFromRecentLow20')),
    progDays: statsBlock(pick('progression.days')),
    progCumValueToMarketCap: statsBlock(pick('progression.cumulativeValueToMarketCap')),
    progRedCandleValueRatio: statsBlock(pick('progression.redCandleValueRatio')),
    progMaxReturn: statsBlock(pick('progression.maxReturn')),
    postBlueCandleRatio: statsBlock(pick('postPeak.postBlueCandleValueRatio')),
    postMaxDrawdown: statsBlock(pick('postPeak.maxDrawdownFromPeak')),
  };
}

// T0 4유형별 통계 — 각 유형이 잡힌 샘플에 한정
function aggregateT0Variants(samples) {
  const variants = ['EARLY_TRACE', 'VALUE_CONFIRM', 'BOX_BREAK', 'SURGE_START'];
  const out = {};
  variants.forEach(v => {
    const matched = samples.map(s => s.t0Measurements?.[v]).filter(m => m != null);
    out[v] = {
      count: matched.length,
      coverage: samples.length ? matched.length / samples.length : 0,
      valueRatio20: statsBlock(matched.map(m => m.valueRatio20)),
      volumeRatio20: statsBlock(matched.map(m => m.volumeRatio20)),
      valueToMarketCap: statsBlock(matched.map(m => m.valueToMarketCap)),
      closeLocation: statsBlock(matched.map(m => m.closeLocation)),
      closeToMA20: statsBlock(matched.map(m => m.closeToMA20)),
      closeFrom52WeekHigh: statsBlock(matched.map(m => m.closeFrom52WeekHigh)),
      closeFromRecentLow20: statsBlock(matched.map(m => m.closeFromRecentLow20)),
      boxRangePct: statsBlock(matched.map(m => m.boxRangePct)),
      dynamicBoxDuration: statsBlock(matched.map(m => m.dynamicBoxDuration)),
      overheadRatio: statsBlock(matched.map(m => m.overheadRatio)),
      supportRatio: statsBlock(matched.map(m => m.supportRatio)),
      daysToTargetFromT0: statsBlock(matched.map(m => m.daysToTargetFromT0)),
    };
  });
  return out;
}

function patternDistribution(samples) {
  const dist = {};
  samples.forEach(s => {
    (s.patterns || []).forEach(p => { dist[p] = (dist[p] || 0) + 1; });
    if ((s.patterns || []).length === 0) dist['NO_TAG'] = (dist['NO_TAG'] || 0) + 1;
  });
  return dist;
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('WRA — Winner Reverse Audit');
  console.log('═'.repeat(80));
  console.log(`기간: ${fmtDate(CONFIG.ANALYSIS_START)} ~ ${fmtDate(CONFIG.ANALYSIS_END)}`);
  console.log(`목표 수익률: +${(CONFIG.TARGET_RETURN * 100).toFixed(0)}% / 추적: ${CONFIG.TRACK_DAYS}거래일 (${CONFIG.PRICE_BASIS} 기준)`);
  console.log(`중복 제거: ${CONFIG.DEDUP_DAYS}거래일 / 최소 시총: ${CONFIG.MIN_MARKET_CAP / 1e8}억`);
  if (CONFIG.SAMPLE_STOCKS) console.log(`⚠ SAMPLE 모드: 처음 ${CONFIG.SAMPLE_STOCKS}개 종목만`);
  console.log();

  // reports 디렉토리 보장
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // 종목 메타
  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  // 차트 파일
  let files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  if (CONFIG.SAMPLE_STOCKS) files = files.slice(0, CONFIG.SAMPLE_STOCKS);
  console.log(`차트 ${files.length}개 처리 시작...`);

  const allSamples = [];
  const excludeLog = {
    no_meta: 0,
    excluded_product: 0,
    no_market_cap: 0,
    small_market_cap: 0,
    chart_unreadable: 0,
    data_short: 0,
    no_success: 0,
    deduped: 0, // 누적 dedup 카운트
    raw_count_total: 0,
  };

  let processed = 0;
  const startTime = Date.now();
  files.forEach((file, idx) => {
    const code = file.replace('.json', '');
    const meta = stockMap[code];
    if (!meta) { excludeLog.no_meta++; return; }
    if (isExcluded(meta.name)) { excludeLog.excluded_product++; return; }
    if (meta.isSpecial) { excludeLog.excluded_product++; return; }
    const marketCap = meta.marketValue || 0;
    if (!marketCap) { excludeLog.no_market_cap++; return; }
    if (marketCap < CONFIG.MIN_MARKET_CAP) { excludeLog.small_market_cap++; return; }

    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8')); }
    catch (_) { excludeLog.chart_unreadable++; return; }
    const rows = chart.rows || [];

    const result = analyzeStock(rows, code, meta.name, meta.market, marketCap);
    if (result.excludeReason === 'data_short') { excludeLog.data_short++; return; }
    if (result.samples.length === 0) { excludeLog.no_success++; processed++; return; }
    allSamples.push(...result.samples);
    excludeLog.raw_count_total += result.rawCount || 0;
    excludeLog.deduped += (result.rawCount || 0) - (result.dedupedCount || 0);
    processed++;

    if ((idx + 1) % 500 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const eta = (elapsed / (idx + 1)) * (files.length - idx - 1);
      process.stdout.write(`\r${idx + 1}/${files.length} samples=${allSamples.length} 경과 ${elapsed.toFixed(0)}s ETA ${eta.toFixed(0)}s`);
    }
  });
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n분석 완료: ${processed}개 종목, ${allSamples.length}개 성공 샘플 (raw ${excludeLog.raw_count_total}건 → 중복제거 ${excludeLog.deduped}건), ${elapsed.toFixed(0)}초`);

  // 통계
  const stats = aggregateStats(allSamples);
  const t0VariantStats = aggregateT0Variants(allSamples);
  const patternDist = patternDistribution(allSamples);

  // dynamic box fallback 비율 (boxRangePct ≤ 25% 안정 구간을 못 찾아 30일 fallback으로 간 비율)
  const fbCount = allSamples.filter(s => s.preparation?.boxFallback).length;
  const boxFallbackRate = allSamples.length ? fbCount / allSamples.length : 0;

  // 콘솔 요약
  console.log('\n📊 핵심 지표 (중앙값):');
  console.log(`  peakReturn=${stats.peakReturn.median?.toFixed(1)}% / daysToTarget=${stats.daysToTarget.median?.toFixed(1)}일`);
  console.log(`  T0 valueRatio20=${stats.t0ValueRatio20.median?.toFixed(2)} / volumeRatio20=${stats.t0VolumeRatio20.median?.toFixed(2)} / valueToMarketCap=${(stats.t0ValueToMarketCap.median * 100)?.toFixed(2)}%`);
  console.log(`  T0 closeLocation=${stats.t0CloseLocation.median?.toFixed(2)} / closeToMA20=${stats.t0CloseToMA20.median?.toFixed(2)}% / 52w 고점 대비=${stats.t0CloseFrom52WeekHigh.median?.toFixed(1)}%`);
  console.log(`  진행 누적 거래대금/시총 중앙값=${(stats.progCumValueToMarketCap.median * 100)?.toFixed(1)}%`);
  console.log(`  준비 구간 박스 폭(동적)=${stats.boxRangePct.median?.toFixed(1)}% / boxDuration 중앙값=${stats.boxDuration.median?.toFixed(0)}일 (fallback ${(boxFallbackRate*100).toFixed(0)}%) / overheadRatio=${(stats.overheadRatio.median * 100)?.toFixed(1)}%`);

  console.log('\n📊 T0 4유형별 통계 (median, coverage):');
  Object.entries(t0VariantStats).forEach(([k, v]) => {
    if (v.count === 0) { console.log(`  ${k.padEnd(16)} 매칭 없음`); return; }
    console.log(`  ${k.padEnd(16)} n=${v.count} (cov ${(v.coverage*100).toFixed(0)}%) valR=${v.valueRatio20.median?.toFixed(2)} volR=${v.volumeRatio20.median?.toFixed(2)} v/mc=${(v.valueToMarketCap.median*100)?.toFixed(2)}% closeLoc=${v.closeLocation.median?.toFixed(2)} MA20=${v.closeToMA20.median?.toFixed(1)}% 52wH=${v.closeFrom52WeekHigh.median?.toFixed(0)}% boxLen=${v.dynamicBoxDuration.median?.toFixed(0)}일 d2T=${v.daysToTargetFromT0.median?.toFixed(0)}d`);
  });

  console.log('\n📋 패턴 분포:');
  Object.entries(patternDist).sort(([, a], [, b]) => b - a).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(24)} ${v}건 (${(v / allSamples.length * 100).toFixed(0)}%)`);
  });
  console.log('\n📝 제외 로그:');
  Object.entries(excludeLog).forEach(([k, v]) => {
    if (v > 0) console.log(`  ${k.padEnd(24)} ${v}`);
  });

  // JSON 출력 — 사이즈를 위해 sample은 핵심 필드만
  const slimSamples = allSamples.map(s => ({
    code: s.code, name: s.name, market: s.market, marketCap: s.marketCap,
    baseDate: s.baseDate, t0Date: s.t0Date, peakDate: s.peakDate, targetHitDate: s.targetHitDate,
    peakReturn: s.peakReturn, daysToTarget: s.daysToTarget,
    t0Candidates: s.t0Candidates,
    t0Measurements: s.t0Measurements,
    t0: s.t0,
    preparation: s.preparation,
    progression: s.progression,
    postPeak: s.postPeak,
    patterns: s.patterns,
  }));

  const out = {
    meta: {
      version: 'v2',
      generatedAt: new Date().toISOString(),
      executionSeconds: Math.round(elapsed),
      universeStocks: processed,
      successSamples: allSamples.length,
      rawSamplesTotal: excludeLog.raw_count_total,
      dedupedRemoved: excludeLog.deduped,
      progressionWindowExplanation:
        'TRACK_DAYS는 baseDate 이후 +TARGET_RETURN% 도달 여부를 보는 기간입니다 (high 기준). ' +
        'T0는 baseDate 이전으로 역산될 수 있으므로 T0~targetHitDate 기간(progression.days)은 ' +
        'TRACK_DAYS보다 길 수 있습니다. base에서 peak까지의 간격은 항상 TRACK_DAYS 이하지만, ' +
        'T0에서 peak까지는 더 길어질 수 있습니다.',
      boxFallbackRate,
      boxFallbackExplanation:
        'dynamic box(20~80일, boxRangePct ≤ 25%)를 못 찾으면 30일 단순 박스로 fallback합니다. ' +
        'fallback 비율이 높다는 것은 그만큼 prep 구간 변동성이 25%를 자주 초과한다는 의미이며, ' +
        '한국 시장 success 종목의 prep이 좁은 박스권보다는 ±25% 이상 변동성을 보인다는 뜻입니다.',
    },
    config: CONFIG,
    summary: {
      totalSamples: allSamples.length,
      avgPeakReturn: stats.peakReturn.mean,
      medianPeakReturn: stats.peakReturn.median,
      avgDaysToTarget: stats.daysToTarget.mean,
      medianDaysToTarget: stats.daysToTarget.median,
      avgT0ValueToMarketCap: stats.t0ValueToMarketCap.mean,
      avgProgCumValueToMarketCap: stats.progCumValueToMarketCap.mean,
      avgDynamicBoxDuration: stats.boxDuration.mean,
      avgBoxRangePct: stats.boxRangePct.mean,
    },
    stats,
    t0VariantStats,
    patternDistribution: patternDist,
    samples: slimSamples,
    excludeLog,
  };

  const outPath = path.join(REPORTS_DIR, 'wra-winner-reverse-audit-v2-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  const sizeKB = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`\n✅ JSON 저장: ${outPath} (${sizeKB}KB)`);

  console.log('\n주의: 본 보고서는 audit이며 운영 보드/screener/매수 후보가 아닙니다.');
  console.log('       종목명 하드코딩 없이 조건만으로 자연스럽게 잡힌 사례입니다.');
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = {
  CONFIG,
  findSuccessSamples,
  dedupSamples,
  findT0Candidates,
  findT0Variants,
  measureT0,
  analyzePreparation,
  analyzeT0,
  analyzeProgression,
  analyzePostPeak,
  classifyPatterns,
  analyzeStock,
  // 헬퍼
  precomputeIndicators,
  findDynamicBox,
  analyzeOverhead,
  rollingMin,
  rollingMax,
};
