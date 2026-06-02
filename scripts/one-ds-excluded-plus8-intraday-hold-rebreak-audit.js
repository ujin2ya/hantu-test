#!/usr/bin/env node
/**
 * 1DS 관찰 제외 +8% 고가권 유지 / 재돌파 사전탐지 감사용 백테스트
 *
 * 가설: 관찰 제외 +8% 종목 중 나중에 closePosition ≥ 0.70/0.80 으로 강하게 마감한 종목을
 *       장중 10시/11시/13시/14시 시점의 분봉 조건(고가권 유지, 재돌파)으로 미리 구분할 수 있는가?
 *
 * 매수 추천 아님. 감사용 사후 검증.
 *
 * 입력:
 *   - data/intraday/1ds/{date}/{code}.json (09:00~15:30 풀데이 분봉)
 *   - cache/stock-charts-long/{code}.json
 *   - stocks.json / cache/naver-stocks-list.json
 *
 * 출력:
 *   - reports/one-ds-excluded-plus8-intraday-hold-rebreak-audit-result.json
 *   - reports/one-ds-excluded-plus8-intraday-hold-rebreak-audit-result.html
 *
 * CLI:
 *   node scripts/one-ds-excluded-plus8-intraday-hold-rebreak-audit.js --days=20
 *   node scripts/one-ds-excluded-plus8-intraday-hold-rebreak-audit.js --days=60
 *   node scripts/one-ds-excluded-plus8-intraday-hold-rebreak-audit.js --days=all
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-ds-excluded-plus8-intraday-hold-rebreak-audit-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-ds-excluded-plus8-intraday-hold-rebreak-audit-result.html');

const scanner = require(path.join(ROOT, 'boards', 'oneDaySurge', 'one-day-surge-0930-scanner'));

const ATTACK_TOP_N    = 5;
const PLUS8_THRESHOLD = 0.08;
const VALUE_STRONG_RATIO = 3;  // 기존 backtest의 "+8% + 거래대금 3배" 재사용
const COMPLETE_LAST_BAR_GE = '15:30';
const MIN_BARS_COMPLETE    = 300;

function parseArgs(argv) {
  const a = { days: '20', limitEvents: 300 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--days') a.days = argv[++i];
    else if (k.startsWith('--days=')) a.days = k.split('=')[1];
    else if (k === '--limit-events') a.limitEvents = parseInt(argv[++i], 10) || 300;
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node scripts/one-ds-excluded-plus8-intraday-hold-rebreak-audit.js [--days=20|60|all]');
      process.exit(0);
    }
  }
  return a;
}

function listIntradayDates() {
  if (!fs.existsSync(INTRADAY_BASE)) return [];
  return fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
}

const chartCache = new Map();
function loadChartRows(code) {
  if (chartCache.has(code)) return chartCache.get(code);
  const p = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(p)) { chartCache.set(code, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    chartCache.set(code, j.rows || null);
    return j.rows || null;
  } catch (_) { chartCache.set(code, null); return null; }
}

function findDayAndBase(rows, dateNumStr) {
  if (!Array.isArray(rows)) return null;
  const idx = rows.findIndex((r) => r.date === dateNumStr);
  if (idx < 22) return null;
  return { dIdx: idx, dRow: rows[idx], baseRow: rows[idx - 1] };
}

function calcAvg20Value(rows, dIdx) {
  let sum = 0, n = 0;
  for (let i = dIdx - 21; i < dIdx - 1; i++) {
    const r = rows[i];
    if (r && r.volume > 0) { sum += (r.valueApprox || 0); n++; }
  }
  return n > 0 ? sum / n : 0;
}

// ── 시점별 가격 + 그 시점까지의 장중 고가 ──
function extractSnapshot(bars, cutoff) {
  const inWin = bars.filter((b) => b && b.time && b.time <= cutoff && b.close > 0);
  if (inWin.length === 0) return { available: false };
  const last = inWin[inWin.length - 1];
  let high = 0;
  for (const b of inWin) if (b.high > high) high = b.high;
  return { available: true, signalPrice: last.close, highSoFar: high, barTime: last.time };
}

// ── 특정 시점 이후 첫 재돌파 ──
function findFirstRebreak(bars, afterTime, thresholdHigh) {
  for (const b of bars) {
    if (!b || !b.time) continue;
    if (b.time <= afterTime) continue;
    if (b.high > thresholdHigh) return { time: b.time, signalPrice: b.close };
  }
  return null;
}

// ── 시각 산술 (HH:MM 문자열) ──
function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minToTime(min) {
  if (min >= 24 * 60) min = 24 * 60 - 1;
  if (min < 0) min = 0;
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

// ── 장중 forward 성과 — refTime 이후 N분 / restOfDay / after 13:00 / after 14:00 ──
function computeIntradayPerformance(bars, refTime, signalPrice) {
  if (signalPrice <= 0 || !refTime) return null;
  const refMin = timeToMin(refTime);

  // 헬퍼: bars filter by time range (exclusive start, inclusive end)
  function barsIn(startMin, endMin) {
    return bars.filter((b) => {
      if (!b || !b.time || !(b.close > 0)) return false;
      const t = timeToMin(b.time);
      return t > startMin && t <= endMin;
    });
  }

  // MFE 계산
  function mfeIn(startMin, endMin) {
    const sub = barsIn(startMin, endMin);
    let h = 0;
    for (const b of sub) if (b.high > h) h = b.high;
    if (h <= 0) return null;
    return (h / signalPrice - 1) * 100;
  }
  // 최저점
  function maxDropIn(startMin, endMin) {
    const sub = barsIn(startMin, endMin);
    let l = Infinity;
    for (const b of sub) if (b.low < l) l = b.low;
    if (!Number.isFinite(l)) return null;
    return (l / signalPrice - 1) * 100;
  }

  const T15_30 = timeToMin('15:30');
  const T13_00 = timeToMin('13:00');
  const T14_00 = timeToMin('14:00');

  const restEnd  = T15_30;
  const t30End   = Math.min(refMin + 30, T15_30);
  const t60End   = Math.min(refMin + 60, T15_30);
  const t120End  = Math.min(refMin + 120, T15_30);

  // first hit / fail / peak time (after refTime, restOfDay)
  // hit/fail are scanned bar-by-bar; first event timing recorded
  function firstHitAt(thr, startMin, endMin) {
    const sub = barsIn(startMin, endMin);
    for (const b of sub) {
      const r = (b.high / signalPrice - 1) * 100;
      if (r >= thr) return timeToMin(b.time);
    }
    return null;
  }
  function firstFailAt(thr, startMin, endMin) {
    const sub = barsIn(startMin, endMin);
    for (const b of sub) {
      const r = (b.low / signalPrice - 1) * 100;
      if (r <= -thr) return timeToMin(b.time);
    }
    return null;
  }

  // peak time + minutes-to-peak (over restOfDay)
  let peakTimeMin = null, peakPrice = 0;
  for (const b of barsIn(refMin, restEnd)) {
    if (b.high > peakPrice) { peakPrice = b.high; peakTimeMin = timeToMin(b.time); }
  }
  const minutesToPeak = peakTimeMin != null ? (peakTimeMin - refMin) : null;

  return {
    refTime,
    signalPrice,
    mfe30m:        mfeIn(refMin, t30End),
    mfe60m:        mfeIn(refMin, t60End),
    mfe120m:       mfeIn(refMin, t120End),
    mfeAfter1300:  mfeIn(Math.max(refMin, T13_00), restEnd),
    mfeAfter1400:  mfeIn(Math.max(refMin, T14_00), restEnd),
    mfeRestOfDay:  mfeIn(refMin, restEnd),
    // 최대 하락(참고용 — fail 분모는 별도)
    maxDropRestOfDay: maxDropIn(refMin, restEnd),

    // hit/fail
    hit2_30m:        firstHitAt(2,  refMin, t30End)  != null,
    hit3_30m:        firstHitAt(3,  refMin, t30End)  != null,
    hit5_60m:        firstHitAt(5,  refMin, t60End)  != null,
    hit5_120m:       firstHitAt(5,  refMin, t120End) != null,
    hit5_restOfDay:  firstHitAt(5,  refMin, restEnd) != null,
    hit7_restOfDay:  firstHitAt(7,  refMin, restEnd) != null,
    hit10_restOfDay: firstHitAt(10, refMin, restEnd) != null,
    fail2_30m:       firstFailAt(2, refMin, t30End)  != null,
    fail3_60m:       firstFailAt(3, refMin, t60End)  != null,
    fail5_restOfDay: firstFailAt(5, refMin, restEnd) != null,

    // first hit before first fail (timing-aware)
    _firstHit3: firstHitAt(3, refMin, restEnd),
    _firstHit5: firstHitAt(5, refMin, restEnd),
    _firstFail3: firstFailAt(3, refMin, restEnd),
    _firstFail5: firstFailAt(5, refMin, restEnd),

    peakTime:      peakTimeMin != null ? minToTime(peakTimeMin) : null,
    minutesToPeak,
    peakWithin30m:  minutesToPeak != null && minutesToPeak <= 30,
    peakWithin60m:  minutesToPeak != null && minutesToPeak <= 60,
    peakWithin120m: minutesToPeak != null && minutesToPeak <= 120,
    peakAfter1300:  peakTimeMin != null && peakTimeMin > T13_00,
    peakAfter1400:  peakTimeMin != null && peakTimeMin > T14_00,
  };
}

function firstHit3BeforeFail3(perf) {
  if (!perf._firstHit3) return false;
  if (!perf._firstFail3) return true;
  return perf._firstHit3 < perf._firstFail3;
}
function firstHit5BeforeFail3(perf) {
  if (!perf._firstHit5) return false;
  if (!perf._firstFail3) return true;
  return perf._firstHit5 < perf._firstFail3;
}
function firstHit5BeforeFail5(perf) {
  if (!perf._firstHit5) return false;
  if (!perf._firstFail5) return true;
  return perf._firstHit5 < perf._firstFail5;
}

// ── 한 날의 D 이벤트 식별 + 장중 조건 산출 ──
function analyzeDay(dateDir, metaMap) {
  const dir = path.join(INTRADAY_BASE, dateDir);
  if (!fs.existsSync(dir)) return { d: [], stats: { partial: 0, missing: 0, complete: 0 } };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return { d: [], stats: { partial: 0, missing: 0, complete: 0 } };
  const dateNumStr = dateDir.replace(/-/g, '');

  // Step 1: collect candidates with scanner status (same as backtest)
  const dayCands = [];
  for (const fname of files) {
    const code = fname.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    if (!meta) continue;
    const rows = loadChartRows(code);
    if (!rows) continue;
    const dayInfo = findDayAndBase(rows, dateNumStr);
    if (!dayInfo) continue;
    const { dIdx, dRow, baseRow } = dayInfo;
    if (!baseRow || !(baseRow.close > 0) || !dRow || !(dRow.close > 0)) continue;
    const avg20 = calcAvg20Value(rows, dIdx);
    const baseValue = baseRow.valueApprox || 0;
    const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) continue;

    let bars;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8'));
      bars = j.bars || [];
    } catch (_) { continue; }
    if (bars.length === 0) continue;

    const m = scanner.computeMetrics0930(bars, baseRow);
    if (!m) continue;
    const status = scanner.classifyStatus(m);
    if (status === 'INSUFFICIENT_BARS') continue;

    dayCands.push({ code, name: meta.name || code, status, m, bars, baseRow, dRow, baseValue });
  }

  // Step 2: among D candidates (status WAIT_PULLBACK/FADED/WEAK), check +8% at 10:00 = D group
  const dEvents = [];
  let partial = 0, missing = 0, complete = 0;

  for (const c of dayCands) {
    if (!(c.status === 'WAIT_PULLBACK' || c.status === 'FADED' || c.status === 'WEAK')) continue;
    const snap1000 = extractSnapshot(c.bars, '10:00');
    if (!snap1000.available) { missing++; continue; }
    const prevClose = c.baseRow.close;
    const plus8_1000 = (snap1000.signalPrice / prevClose - 1) >= PLUS8_THRESHOLD;
    if (!plus8_1000) continue;  // D 정의: 10:00 +8% 필수

    // 완전한 풀데이 분봉 여부
    const lastBar = c.bars[c.bars.length - 1];
    const isComplete = lastBar && lastBar.time >= COMPLETE_LAST_BAR_GE && c.bars.length >= MIN_BARS_COMPLETE;
    if (!isComplete) { partial++; continue; }  // 백테스트는 풀데이 필요
    complete++;

    // 시점별 스냅샷 / 고가
    const snap1100 = extractSnapshot(c.bars, '11:00');
    const morningSnap = extractSnapshot(c.bars, '11:30');  // 09:00~11:30 morningHigh

    const highUntil1000 = snap1000.highSoFar;
    const highUntil1100 = snap1100.available ? snap1100.highSoFar : null;
    const morningHigh = morningSnap.available ? morningSnap.highSoFar : null;

    const priceToHighRatio1000 = highUntil1000 > 0 ? snap1000.signalPrice / highUntil1000 : null;
    const priceToHighRatio1100 = (snap1100.available && highUntil1100 > 0) ? snap1100.signalPrice / highUntil1100 : null;

    // 재돌파 시각/가격
    const rb1000 = findFirstRebreak(c.bars, '10:00', highUntil1000);
    const rb1100 = highUntil1100 ? findFirstRebreak(c.bars, '11:00', highUntil1100) : null;
    const rb1300 = morningHigh   ? findFirstRebreak(c.bars, '13:00', morningHigh)   : null;
    const rb1400 = morningHigh   ? findFirstRebreak(c.bars, '14:00', morningHigh)   : null;

    // 거래대금 조건
    const dayValue = c.dRow.valueApprox || 0;
    const valueRatioVsBase = c.baseValue > 0 ? dayValue / c.baseValue : 0;
    const valueStrong = valueRatioVsBase >= VALUE_STRONG_RATIO;

    // closePosition (사후 정답지)
    const closePosition = (c.dRow.high > c.dRow.low) ? (c.dRow.close - c.dRow.low) / (c.dRow.high - c.dRow.low) : null;

    // 조건 12종
    const cond = {
      holdHigh1000_95:           priceToHighRatio1000 != null && priceToHighRatio1000 >= 0.95,
      holdHigh1000_97:           priceToHighRatio1000 != null && priceToHighRatio1000 >= 0.97,
      drawdownFromHigh1000_le3:  priceToHighRatio1000 != null && (priceToHighRatio1000 - 1) >= -0.03,
      holdHigh1100_95:           priceToHighRatio1100 != null && priceToHighRatio1100 >= 0.95,
      holdHigh1100_97:           priceToHighRatio1100 != null && priceToHighRatio1100 >= 0.97,
      rebreakAfter1000:          rb1000 !== null,
      rebreakAfter1100:          rb1100 !== null,
      rebreakAfter1300:          rb1300 !== null,
      rebreakAfter1400:          rb1400 !== null,
      valueStrong,
    };
    cond.holdAndValue    = (cond.holdHigh1000_95 || cond.holdHigh1100_95) && cond.valueStrong;
    cond.fadedButRecover = (c.status === 'FADED') && (cond.rebreakAfter1000 || cond.rebreakAfter1300);

    // 성과 — 조건별 refTime 매핑
    const perfBase = {
      _1000:   computeIntradayPerformance(c.bars, '10:00', snap1000.signalPrice),
      _1100:   snap1100.available ? computeIntradayPerformance(c.bars, '11:00', snap1100.signalPrice) : null,
      _rb1000: rb1000 ? computeIntradayPerformance(c.bars, rb1000.time, rb1000.signalPrice) : null,
      _rb1100: rb1100 ? computeIntradayPerformance(c.bars, rb1100.time, rb1100.signalPrice) : null,
      _rb1300: rb1300 ? computeIntradayPerformance(c.bars, rb1300.time, rb1300.signalPrice) : null,
      _rb1400: rb1400 ? computeIntradayPerformance(c.bars, rb1400.time, rb1400.signalPrice) : null,
    };

    dEvents.push({
      date: dateDir,
      code: c.code,
      name: c.name,
      status: c.status,
      prevClose,
      signalPrice1000: snap1000.signalPrice,
      plusPct1000: (snap1000.signalPrice / prevClose - 1) * 100,
      highUntil1000,
      priceToHighRatio1000,
      highUntil1100,
      priceToHighRatio1100,
      morningHigh,
      rb1000, rb1100, rb1300, rb1400,
      valueRatioVsBase,
      closePosition,
      closePositionGroup: closePosition == null ? null : (closePosition >= 0.80 ? '80+' : closePosition >= 0.70 ? '70+' : '<70'),
      dRow: { open: c.dRow.open, high: c.dRow.high, low: c.dRow.low, close: c.dRow.close, valueApprox: c.dRow.valueApprox },
      cond,
      perfBase,
    });
  }
  return { d: dEvents, stats: { partial, missing, complete } };
}

// ── 통계 헬퍼 ──
function avg(arr) { if (!arr.length) return null; return arr.reduce((s, v) => s + v, 0) / arr.length; }
function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function rate(num, den) { if (!den) return 0; return (num / den) * 100; }
function fmt(n, d = 2) { if (n == null || !Number.isFinite(n)) return null; return Number(n.toFixed(d)); }

// 조건명 → perfBase 키 매핑 (어떤 refTime 기준 성과를 쓸지)
const COND_REF = {
  holdHigh1000_95:           '_1000',
  holdHigh1000_97:           '_1000',
  drawdownFromHigh1000_le3:  '_1000',
  holdHigh1100_95:           '_1100',
  holdHigh1100_97:           '_1100',
  rebreakAfter1000:          '_rb1000',
  rebreakAfter1100:          '_rb1100',
  rebreakAfter1300:          '_rb1300',
  rebreakAfter1400:          '_rb1400',
  valueStrong:               '_1000',
  holdAndValue:              '_1000',
  fadedButRecover:           '_rb1000',  // 1000 우선; 1000이 없으면 1300으로 fallback
};

function getPerf(ev, condKey) {
  let refKey = COND_REF[condKey];
  if (condKey === 'fadedButRecover') {
    if (ev.perfBase._rb1000) refKey = '_rb1000';
    else if (ev.perfBase._rb1300) refKey = '_rb1300';
    else return null;
  }
  return ev.perfBase[refKey] || null;
}

function summarizeCondition(subsetEvents, condKey) {
  const perfs = subsetEvents.map((e) => getPerf(e, condKey)).filter(Boolean);
  const n = subsetEvents.length;
  if (n === 0 || perfs.length === 0) return { n, perfN: 0 };
  const mfe30s = perfs.map((p) => p.mfe30m).filter(Number.isFinite);
  const mfe60s = perfs.map((p) => p.mfe60m).filter(Number.isFinite);
  const mfe120s = perfs.map((p) => p.mfe120m).filter(Number.isFinite);
  const mfeA13s = perfs.map((p) => p.mfeAfter1300).filter(Number.isFinite);
  const mfeA14s = perfs.map((p) => p.mfeAfter1400).filter(Number.isFinite);
  const mfeRods = perfs.map((p) => p.mfeRestOfDay).filter(Number.isFinite);
  const minutesToPeaks = perfs.map((p) => p.minutesToPeak).filter(Number.isFinite);

  return {
    n,
    perfN: perfs.length,
    mfe30m:        fmt(avg(mfe30s)),
    mfe60m:        fmt(avg(mfe60s)),
    mfe120m:       fmt(avg(mfe120s)),
    mfeAfter1300:  fmt(avg(mfeA13s)),
    mfeAfter1400:  fmt(avg(mfeA14s)),
    mfeRestOfDay:  fmt(avg(mfeRods)),
    hit2_30m:        fmt(rate(perfs.filter((p) => p.hit2_30m).length, perfs.length)),
    hit3_30m:        fmt(rate(perfs.filter((p) => p.hit3_30m).length, perfs.length)),
    hit5_60m:        fmt(rate(perfs.filter((p) => p.hit5_60m).length, perfs.length)),
    hit5_120m:       fmt(rate(perfs.filter((p) => p.hit5_120m).length, perfs.length)),
    hit5_restOfDay:  fmt(rate(perfs.filter((p) => p.hit5_restOfDay).length, perfs.length)),
    hit7_restOfDay:  fmt(rate(perfs.filter((p) => p.hit7_restOfDay).length, perfs.length)),
    hit10_restOfDay: fmt(rate(perfs.filter((p) => p.hit10_restOfDay).length, perfs.length)),
    fail2_30m:       fmt(rate(perfs.filter((p) => p.fail2_30m).length, perfs.length)),
    fail3_60m:       fmt(rate(perfs.filter((p) => p.fail3_60m).length, perfs.length)),
    fail5_restOfDay: fmt(rate(perfs.filter((p) => p.fail5_restOfDay).length, perfs.length)),
    firstHit3BeforeFail3: fmt(rate(perfs.filter((p) => firstHit3BeforeFail3(p)).length, perfs.length)),
    firstHit5BeforeFail3: fmt(rate(perfs.filter((p) => firstHit5BeforeFail3(p)).length, perfs.length)),
    firstHit5BeforeFail5: fmt(rate(perfs.filter((p) => firstHit5BeforeFail5(p)).length, perfs.length)),
    avgMinutesToPeak:    fmt(avg(minutesToPeaks), 1),
    medianMinutesToPeak: fmt(median(minutesToPeaks), 1),
    peakWithin30mRate:   fmt(rate(perfs.filter((p) => p.peakWithin30m).length, perfs.length)),
    peakWithin60mRate:   fmt(rate(perfs.filter((p) => p.peakWithin60m).length, perfs.length)),
    peakWithin120mRate:  fmt(rate(perfs.filter((p) => p.peakWithin120m).length, perfs.length)),
    peakAfter1300Rate:   fmt(rate(perfs.filter((p) => p.peakAfter1300).length, perfs.length)),
    peakAfter1400Rate:   fmt(rate(perfs.filter((p) => p.peakAfter1400).length, perfs.length)),
  };
}

// ── 사전탐지 성능 (precision / recall / lift vs closePos 70/80) ──
function computeDetectionStats(allD, subset) {
  const totalD = allD.length;
  const totalD70 = allD.filter((e) => e.closePosition != null && e.closePosition >= 0.70).length;
  const totalD80 = allD.filter((e) => e.closePosition != null && e.closePosition >= 0.80).length;

  const subsetN = subset.length;
  const sub70   = subset.filter((e) => e.closePosition != null && e.closePosition >= 0.70).length;
  const sub80   = subset.filter((e) => e.closePosition != null && e.closePosition >= 0.80).length;

  const baseline70Rate = totalD > 0 ? totalD70 / totalD : 0;
  const baseline80Rate = totalD > 0 ? totalD80 / totalD : 0;

  const precision70 = subsetN > 0 ? sub70 / subsetN : 0;
  const precision80 = subsetN > 0 ? sub80 / subsetN : 0;
  const recall70    = totalD70 > 0 ? sub70 / totalD70 : 0;
  const recall80    = totalD80 > 0 ? sub80 / totalD80 : 0;
  const lift70      = baseline70Rate > 0 ? precision70 / baseline70Rate : 0;
  const lift80      = baseline80Rate > 0 ? precision80 / baseline80Rate : 0;

  return {
    n: subsetN,
    precision70: fmt(precision70 * 100),
    precision80: fmt(precision80 * 100),
    recall70:    fmt(recall70 * 100),
    recall80:    fmt(recall80 * 100),
    lift70:      fmt(lift70, 2),
    lift80:      fmt(lift80, 2),
  };
}

// ── HTML 렌더링 ──
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

const COND_LABEL = {
  holdHigh1000_95:           '10시 ≥ 95% 고가 유지',
  holdHigh1000_97:           '10시 ≥ 97% 고가 유지',
  drawdownFromHigh1000_le3:  '10시 고가 대비 -3% 이내',
  holdHigh1100_95:           '11시 ≥ 95% 고가 유지',
  holdHigh1100_97:           '11시 ≥ 97% 고가 유지',
  rebreakAfter1000:          '10:00 이후 고가 재돌파',
  rebreakAfter1100:          '11:00 이후 고가 재돌파',
  rebreakAfter1300:          '13:00 이후 오전 고가 재돌파',
  rebreakAfter1400:          '14:00 이후 오전 고가 재돌파',
  valueStrong:               '거래대금 3배+ (전일 대비)',
  holdAndValue:              '고가권 유지 + 거래대금',
  fadedButRecover:           'FADED 후 재돌파',
};

const ALL_CONDS = Object.keys(COND_LABEL);

function renderDetectionTable(allD, condStats) {
  let html = `<table>
  <thead><tr><th>조건</th><th>n</th><th>precision70</th><th>precision80</th><th>recall70</th><th>recall80</th><th>lift70</th><th>lift80</th></tr></thead>
  <tbody>`;
  for (const k of ALL_CONDS) {
    const s = condStats[k];
    if (!s) continue;
    const liftClass80 = s.lift80 != null && s.lift80 >= 1.5 ? 'style="color:#22c55e;font-weight:700;"' : '';
    html += `<tr>
      <td>${escapeHtml(COND_LABEL[k])}</td>
      <td>${s.n}</td>
      <td>${s.precision70 ?? '–'}</td>
      <td>${s.precision80 ?? '–'}</td>
      <td>${s.recall70 ?? '–'}</td>
      <td>${s.recall80 ?? '–'}</td>
      <td>${s.lift70 ?? '–'}</td>
      <td ${liftClass80}>${s.lift80 ?? '–'}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  return html;
}

function renderPerfTable(perfStats) {
  let html = `<table>
  <thead><tr>
    <th>조건</th><th>n</th>
    <th>mfe30m</th><th>mfe60m</th><th>mfe120m</th>
    <th>mfeA1300</th><th>mfeA1400</th><th>mfeROD</th>
    <th>hit3_30m</th><th>hit5_60m</th><th>hit5_ROD</th><th>hit10_ROD</th>
    <th>fail3_60m</th><th>fail5_ROD</th>
    <th>H3&lt;F3</th><th>H5&lt;F3</th>
    <th>avgMinPeak</th><th>peakA1300%</th>
  </tr></thead><tbody>`;
  for (const k of ALL_CONDS) {
    const s = perfStats[k];
    if (!s || s.perfN === 0) {
      html += `<tr><td>${escapeHtml(COND_LABEL[k])}</td><td>0</td><td colspan="16" style="color:#94a3b8;">no data</td></tr>`;
      continue;
    }
    html += `<tr>
      <td>${escapeHtml(COND_LABEL[k])}</td>
      <td>${s.n}</td>
      <td>${s.mfe30m ?? '–'}</td>
      <td>${s.mfe60m ?? '–'}</td>
      <td>${s.mfe120m ?? '–'}</td>
      <td>${s.mfeAfter1300 ?? '–'}</td>
      <td>${s.mfeAfter1400 ?? '–'}</td>
      <td>${s.mfeRestOfDay ?? '–'}</td>
      <td>${s.hit3_30m ?? '–'}</td>
      <td>${s.hit5_60m ?? '–'}</td>
      <td>${s.hit5_restOfDay ?? '–'}</td>
      <td>${s.hit10_restOfDay ?? '–'}</td>
      <td style="color:#f87171;">${s.fail3_60m ?? '–'}</td>
      <td style="color:#f87171;">${s.fail5_restOfDay ?? '–'}</td>
      <td>${s.firstHit3BeforeFail3 ?? '–'}</td>
      <td>${s.firstHit5BeforeFail3 ?? '–'}</td>
      <td>${s.avgMinutesToPeak ?? '–'}</td>
      <td>${s.peakAfter1300Rate ?? '–'}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  return html;
}

// FADED / WAIT_PULLBACK 분석 헬퍼
function statusSubsetAnalysis(allD, status, subConds) {
  const subset = allD.filter((e) => e.status === status);
  const result = { n_total: subset.length, conditions: {} };
  for (const condDef of subConds) {
    const matched = condDef.filter ? subset.filter(condDef.filter) : subset;
    const refKey = condDef.refKey || '_1000';
    const perfs = matched.map((e) => e.perfBase[refKey]).filter(Boolean);
    const detection = computeDetectionStats(allD, matched);
    let mfeRod = null;
    if (perfs.length > 0) {
      const arr = perfs.map((p) => p.mfeRestOfDay).filter(Number.isFinite);
      mfeRod = arr.length ? avg(arr) : null;
    }
    result.conditions[condDef.key] = {
      label: condDef.label,
      n: matched.length,
      mfeRestOfDay: fmt(mfeRod),
      ...detection,
    };
  }
  return result;
}

function renderStatusSubsetTable(subsetAnalysis) {
  let html = `<table>
  <thead><tr><th>조건</th><th>n</th><th>mfeROD</th><th>precision70</th><th>precision80</th><th>lift70</th><th>lift80</th></tr></thead>
  <tbody>`;
  for (const [k, s] of Object.entries(subsetAnalysis.conditions)) {
    html += `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td>${s.n}</td>
      <td>${s.mfeRestOfDay ?? '–'}</td>
      <td>${s.precision70 ?? '–'}</td>
      <td>${s.precision80 ?? '–'}</td>
      <td>${s.lift70 ?? '–'}</td>
      <td>${s.lift80 ?? '–'}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  return html;
}

// 자동 해석 텍스트
function buildAutoInterpretation(condDetection, condPerf, baselineCloseP70Rate, baselineCloseP80Rate) {
  const messages = [];

  // 1. 가장 좋은 사전탐지 조건 (lift80 기준)
  let bestDetect = null;
  for (const k of ALL_CONDS) {
    const d = condDetection[k];
    if (!d || d.n < 20) continue;
    if (!bestDetect || (d.lift80 || 0) > (bestDetect.lift80 || 0)) bestDetect = { key: k, ...d };
  }

  // 2. 가장 좋은 mfeRestOfDay
  let bestMfe = null;
  for (const k of ALL_CONDS) {
    const s = condPerf[k];
    if (!s || s.perfN < 20) continue;
    if (!bestMfe || (s.mfeRestOfDay || 0) > (bestMfe.mfeRestOfDay || 0)) bestMfe = { key: k, ...s };
  }

  // 3. 가장 낮은 fail5
  let bestFail = null;
  for (const k of ALL_CONDS) {
    const s = condPerf[k];
    if (!s || s.perfN < 20) continue;
    if (!bestFail || (s.fail5_restOfDay || 999) < (bestFail.fail5_restOfDay || 999)) bestFail = { key: k, ...s };
  }

  if (bestDetect) {
    messages.push(`📌 closePos≥80%을 가장 잘 예측한 조건: <strong>${COND_LABEL[bestDetect.key]}</strong> (lift80=${bestDetect.lift80}, precision80=${bestDetect.precision80}%, n=${bestDetect.n})`);
  } else {
    messages.push('⚠ 사전탐지 조건 충분 표본 부족 (n<20).');
  }
  if (bestMfe) {
    messages.push(`📌 장중 MFE(rest-of-day)가 가장 좋은 조건: <strong>${COND_LABEL[bestMfe.key]}</strong> (mfeROD=${bestMfe.mfeRestOfDay}%, n=${bestMfe.perfN})`);
  }
  if (bestFail) {
    messages.push(`📌 fail5(rest-of-day)가 가장 낮은 조건: <strong>${COND_LABEL[bestFail.key]}</strong> (fail5=${bestFail.fail5_restOfDay}%, n=${bestFail.perfN})`);
  }

  // 4. 10시 vs 11시 비교
  const d10 = condDetection.holdHigh1000_95;
  const d11 = condDetection.holdHigh1100_95;
  if (d10 && d11 && d10.n >= 20 && d11.n >= 20) {
    if ((d11.lift80 || 0) > (d10.lift80 || 0)) {
      messages.push(`🕐 11시 조건이 10시 조건보다 사전탐지력 우수 (lift80 11시=${d11.lift80} vs 10시=${d10.lift80}).`);
    } else {
      messages.push(`🕐 10시 조건이 11시 조건과 동등하거나 우수 (lift80 10시=${d10.lift80} vs 11시=${d11.lift80}).`);
    }
  }

  // 5. 오후 재돌파 의미
  const d13 = condDetection.rebreakAfter1300;
  if (d13 && d13.n >= 20 && d13.lift80 >= 1.3) {
    messages.push(`🌅 오후 재돌파(13시 이후 오전 고가 재돌파) 의미 있음 (lift80=${d13.lift80}, n=${d13.n}). 즉시 추격보다 오후 관찰 유지에 적합.`);
  } else if (d13 && d13.n >= 20) {
    messages.push(`🌅 오후 재돌파 사전탐지력 제한적 (lift80=${d13.lift80}).`);
  }

  // 6. fail 위험 판단
  if (bestMfe) {
    if (bestMfe.fail5_restOfDay < 20) {
      messages.push(`✅ 최우수 조건의 fail5는 ${bestMfe.fail5_restOfDay}% — 감당 가능한 수준.`);
    } else {
      messages.push(`⚠ 최우수 조건도 fail5가 ${bestMfe.fail5_restOfDay}% — 실전 적용 시 위험 관리 필요.`);
    }
  }

  // 7. 운영판 반영 권고
  if (bestDetect && bestDetect.lift80 >= 1.5 && bestMfe && bestMfe.fail5_restOfDay < 25) {
    messages.push('💡 권장: 별도 보드까지는 아니어도 기존 보드에 "오후까지 관찰 유지" 태그 추가 검토 가치 있음.');
  } else if (bestDetect && bestDetect.lift80 < 1.3) {
    messages.push('💡 권장: 사전탐지력 lift80 < 1.3. 운영판 반영 보류, 추가 검증 필요.');
  } else {
    messages.push('💡 권장: 사전탐지력은 있지만 fail 위험이 높음. 즉시 추격 X, 오후 관찰 유지 태그가 적합.');
  }

  return messages;
}

// ── 최종 HTML ──
function renderHtml(data) {
  const { meta, summary, condDetection, condPerf, fadedAnalysis, waitPullbackAnalysis, eventList, autoMessages, baselineCloseP } = data;
  const coverageWarning = summary.completeCoverageRate < 80
    ? `<div style="background:#7f1d1d;color:#fef3c7;padding:14px 18px;border-radius:8px;margin:0 0 16px;font-weight:600;">
        ⚠ 분봉 커버리지가 ${summary.completeCoverageRate.toFixed(1)}%로 낮아 결과 해석에 주의가 필요합니다.
        partial/missing 분봉을 운영서버에서 백필 후 재실행 권장.
       </div>`
    : `<div style="background:#14532d;color:#dcfce7;padding:10px 14px;border-radius:8px;margin:0 0 16px;font-size:13px;">
        ✅ 분봉 커버리지 ${summary.completeCoverageRate.toFixed(1)}% — 충분.
       </div>`;

  const eventRows = eventList.map((e) => `<tr>
    <td>${escapeHtml(e.date)}</td>
    <td>${escapeHtml(e.code)}</td>
    <td>${escapeHtml(e.name)}</td>
    <td>${escapeHtml(e.status)}</td>
    <td>${fmt(e.plusPct1000, 1) ?? '–'}%</td>
    <td>${fmt(e.priceToHighRatio1000 != null ? e.priceToHighRatio1000 * 100 : null, 1) ?? '–'}%</td>
    <td>${fmt(e.priceToHighRatio1100 != null ? e.priceToHighRatio1100 * 100 : null, 1) ?? '–'}%</td>
    <td>${e.rb1000 ? e.rb1000.time : '–'}</td>
    <td>${e.rb1300 ? e.rb1300.time : '–'}</td>
    <td>${e.closePosition != null ? fmt(e.closePosition * 100, 1) : '–'}%</td>
    <td>${e.closePositionGroup || '–'}</td>
    <td>${e.mfeRestOfDay != null ? fmt(e.mfeRestOfDay, 1) : '–'}</td>
    <td>${e.peakTime || '–'}</td>
    <td>${e.minutesToPeak != null ? e.minutesToPeak : '–'}</td>
    <td style="color:${e.fail5RestOfDay ? '#f87171' : '#94a3b8'};">${e.fail5RestOfDay ? 'F5' : '–'}</td>
  </tr>`).join('');

  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<title>1DS 관찰 제외 +8% 고가권 유지/재돌파 감사용 백테스트</title>
<style>
  body { background:#0f172a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; margin:0; padding:20px; }
  h1 { color:#fde047; font-size:22px; margin:0 0 8px; }
  h2 { color:#fde047; font-size:16px; margin:20px 0 8px; }
  .sub { color:#94a3b8; font-size:13px; margin-bottom:14px; }
  .card { background:#1e293b; padding:14px 18px; border-radius:8px; margin:0 0 14px; border-left:4px solid #fde047; }
  table { border-collapse:collapse; width:100%; font-size:12px; background:#0b1320; margin-top:8px; }
  th, td { padding:5px 8px; border:1px solid #1e293b; text-align:left; }
  th { color:#fde047; background:#1e293b; font-weight:700; }
  details summary { outline:none; cursor:pointer; font-size:15px; color:#fde047; font-weight:700; padding:8px 0; }
  .note { font-size:12px; color:#94a3b8; background:#1e293b; padding:10px 14px; border-radius:6px; margin:14px 0; }
  ul.auto-msg li { margin: 6px 0; line-height: 1.5; }
</style>
</head><body>

<h1>1DS 관찰 제외 +8% 고가권 유지 / 재돌파 사전탐지 감사용 백테스트</h1>
<div class="sub">
  생성: ${escapeHtml(meta.generatedAt)} · 분봉 윈도우 ${escapeHtml(meta.windowFrom)} ~ ${escapeHtml(meta.windowTo)} (${meta.tradingDaysUsed}일)
</div>

${coverageWarning}

<div class="card">
  <strong>📋 요약</strong><br>
  분석 기간: ${escapeHtml(meta.windowFrom)} ~ ${escapeHtml(meta.windowTo)} (${meta.tradingDaysUsed}일)<br>
  D 관찰 제외 +8% 이벤트: <strong>${summary.totalD}</strong>건 (분봉 풀데이 보유)<br>
  분봉 풀데이 보유 (complete): ${summary.complete}건 / partial: ${summary.partial}건 / missing: ${summary.missing}건<br>
  complete 커버리지: ${summary.completeCoverageRate.toFixed(1)}%<br>
  closePos≥0.70 비율 (baseline): ${fmt(baselineCloseP.b70 * 100, 1)}%<br>
  closePos≥0.80 비율 (baseline): ${fmt(baselineCloseP.b80 * 100, 1)}%
</div>

<div class="card">
  <strong>🧭 기존 결과 요약 (해석 출발점)</strong><br>
  · D 관찰 제외 +8% 전체는 A 공격형 대비 우위가 작았다 (hit5 +4.1p, fail5 +3p).<br>
  · 하지만 D 중 closePosition ≥ 0.80 그룹은 매우 강했다 (이전 백테스트: hit5=94.1%, fail5=10.9%).<br>
  · 이번 백테스트의 목적: 그 강한 그룹을 장중에 미리 찾는 사전탐지 조건 검증.
</div>

<div class="card">
  <strong>💡 자동 해석</strong>
  <ul class="auto-msg">
    ${autoMessages.map((m) => `<li>${m}</li>`).join('')}
  </ul>
</div>

<details open><summary>3. 분봉 커버리지 — 일자별</summary>
<table>
  <thead><tr><th>날짜</th><th>complete</th><th>partial</th><th>missing</th><th>coverage %</th></tr></thead>
  <tbody>${(summary.perDate || []).map((d) => `<tr><td>${escapeHtml(d.date)}</td><td>${d.complete}</td><td>${d.partial}</td><td>${d.missing}</td><td>${d.coverage}</td></tr>`).join('')}</tbody>
</table>
</details>

<details open><summary>4. 장중 조건별 사전탐지 성능 (precision / recall / lift)</summary>
${renderDetectionTable(null, condDetection)}
<div class="note">lift80 ≥ 1.5 (녹색) — closePos≥80% 그룹을 baseline 대비 1.5배 이상 잘 잡아내는 조건. 사전탐지력 핵심 지표.</div>
</details>

<details open><summary>5. 장중 조건별 성과 (MFE / hit / fail / peak)</summary>
${renderPerfTable(condPerf)}
<div class="note">refTime: holdHigh1000_* = 10:00, holdHigh1100_* = 11:00, rebreakAfter1000 = 첫 재돌파 시각, rebreakAfter1300 = 13시 이후 첫 재돌파, etc. ROD = rest-of-day, A1300 = after 13:00.</div>
</details>

<details><summary>6. FADED 회복 분석</summary>
<p>FADED 상태로 관찰 제외된 ${fadedAnalysis.n_total}건 안에서 조건별 추가 비교:</p>
${renderStatusSubsetTable(fadedAnalysis)}
</details>

<details><summary>7. WAIT_PULLBACK 분석</summary>
<p>WAIT_PULLBACK 상태로 관찰 제외된 ${waitPullbackAnalysis.n_total}건 안에서 조건별 추가 비교:</p>
${renderStatusSubsetTable(waitPullbackAnalysis)}
</details>

<details><summary>8. 이벤트 상세 리스트 (상위 ${eventList.length}건, mfeROD desc)</summary>
<table>
  <thead><tr>
    <th>date</th><th>code</th><th>name</th><th>status</th>
    <th>+%@1000</th><th>P/H@1000</th><th>P/H@1100</th>
    <th>RB1000t</th><th>RB1300t</th>
    <th>closePos%</th><th>group</th>
    <th>mfeROD</th><th>peakTime</th><th>minPeak</th><th>fail</th>
  </tr></thead>
  <tbody>${eventRows}</tbody>
</table>
</details>

<div class="card" style="margin-top:24px;">
  <strong>🚧 향후 운영 반영 후보 (이번 작업에서 코드는 미적용)</strong><br>
  · 제외됐지만 힘 유지 (holdHigh1100_95)<br>
  · 오후까지 관찰 유지 (rebreakAfter1300)<br>
  · 고가 재돌파 대기 (priceToHighRatio1000 0.93~0.97)<br>
  · FADED 후 회복 (fadedButRecover)<br>
  · 추격 제외지만 고가권 유지 (drawdownFromHigh1000_le3)<br><br>
  실제 운영 보드 추가는 별도 검토. 이번 작업은 감사용.
</div>

</body></html>`;
}

// ── main ──
function main() {
  const args = parseArgs(process.argv);
  console.log(`🔍 1DS 관찰 제외 +8% 장중 hold/rebreak 감사 — days=${args.days}`);
  const metaMap = scanner.loadStockMetaMap();
  const allDates = listIntradayDates();
  if (allDates.length === 0) { console.error('❌ 분봉 디렉토리 없음'); process.exit(1); }

  let windowDates;
  if (args.days === 'all') windowDates = allDates;
  else {
    const n = parseInt(args.days, 10);
    if (!Number.isFinite(n) || n <= 0) { console.error('❌ --days는 양의 정수 또는 all'); process.exit(1); }
    windowDates = allDates.slice(-n);
  }
  console.log(`  대상 윈도우: ${windowDates.length}일 (${windowDates[0]} ~ ${windowDates[windowDates.length-1]})`);

  // collect events
  const allD = [];
  const perDate = [];
  let totalComplete = 0, totalPartial = 0, totalMissing = 0;
  for (const dateDir of windowDates) {
    const { d, stats } = analyzeDay(dateDir, metaMap);
    allD.push(...d);
    totalComplete += stats.complete;
    totalPartial  += stats.partial;
    totalMissing  += stats.missing;
    const req = stats.complete + stats.partial + stats.missing;
    perDate.push({
      date: dateDir,
      complete: stats.complete, partial: stats.partial, missing: stats.missing,
      coverage: req > 0 ? ((stats.complete / req) * 100).toFixed(1) + '%' : '–',
    });
    console.log(`  ${dateDir}: D complete=${stats.complete} partial=${stats.partial}`);
  }
  console.log(`\n  D 이벤트 (분봉 풀데이 보유): ${allD.length}건`);

  if (allD.length === 0) {
    console.error('❌ D 이벤트 0건 — 분봉이 부족하거나 +8% 충족 종목 없음. 운영서버 분봉 백필 후 재실행.');
    process.exit(2);
  }

  const totalReq = totalComplete + totalPartial + totalMissing;
  const completeCoverageRate = totalReq > 0 ? (totalComplete / totalReq) * 100 : 0;

  // baseline rates
  const c70 = allD.filter((e) => e.closePosition != null && e.closePosition >= 0.70).length;
  const c80 = allD.filter((e) => e.closePosition != null && e.closePosition >= 0.80).length;
  const baselineCloseP = { b70: allD.length > 0 ? c70 / allD.length : 0, b80: allD.length > 0 ? c80 / allD.length : 0 };

  // condition detection + performance
  const condDetection = {};
  const condPerf = {};
  for (const k of ALL_CONDS) {
    const subset = allD.filter((e) => e.cond[k]);
    condDetection[k] = computeDetectionStats(allD, subset);
    condPerf[k] = summarizeCondition(subset, k);
  }

  // FADED + WAIT_PULLBACK
  const fadedConds = [
    { key: 'all',                label: 'FADED 전체',                filter: null,                                                          refKey: '_1000' },
    { key: 'holdHigh1000_95',    label: '+ holdHigh1000_95',         filter: (e) => e.cond.holdHigh1000_95,                                  refKey: '_1000' },
    { key: 'rebreakAfter1000',   label: '+ rebreakAfter1000',        filter: (e) => e.cond.rebreakAfter1000,                                 refKey: '_rb1000' },
    { key: 'rebreakAfter1300',   label: '+ rebreakAfter1300',        filter: (e) => e.cond.rebreakAfter1300,                                 refKey: '_rb1300' },
    { key: 'valueStrong',        label: '+ valueStrong',             filter: (e) => e.cond.valueStrong,                                      refKey: '_1000' },
  ];
  const waitConds = [
    { key: 'all',                label: 'WAIT_PULLBACK 전체',        filter: null,                                                          refKey: '_1000' },
    { key: 'holdHigh1000_95',    label: '+ holdHigh1000_95',         filter: (e) => e.cond.holdHigh1000_95,                                  refKey: '_1000' },
    { key: 'holdHigh1100_95',    label: '+ holdHigh1100_95',         filter: (e) => e.cond.holdHigh1100_95,                                  refKey: '_1100' },
    { key: 'rebreakAfter1000',   label: '+ rebreakAfter1000',        filter: (e) => e.cond.rebreakAfter1000,                                 refKey: '_rb1000' },
    { key: 'rebreakAfter1300',   label: '+ rebreakAfter1300',        filter: (e) => e.cond.rebreakAfter1300,                                 refKey: '_rb1300' },
  ];
  const fadedAnalysis = statusSubsetAnalysis(allD, 'FADED', fadedConds);
  const waitPullbackAnalysis = statusSubsetAnalysis(allD, 'WAIT_PULLBACK', waitConds);

  // event list (top by mfeRestOfDay at canonical 10:00 perf)
  const eventList = allD
    .map((e) => {
      const perf10 = e.perfBase._1000;
      return {
        date: e.date, code: e.code, name: e.name, status: e.status,
        plusPct1000: e.plusPct1000,
        priceToHighRatio1000: e.priceToHighRatio1000,
        priceToHighRatio1100: e.priceToHighRatio1100,
        rb1000: e.rb1000, rb1300: e.rb1300,
        closePosition: e.closePosition,
        closePositionGroup: e.closePositionGroup,
        mfeRestOfDay: perf10 ? perf10.mfeRestOfDay : null,
        peakTime: perf10 ? perf10.peakTime : null,
        minutesToPeak: perf10 ? perf10.minutesToPeak : null,
        fail5RestOfDay: perf10 ? perf10.fail5_restOfDay : false,
      };
    })
    .sort((a, b) => {
      const am = a.mfeRestOfDay != null ? a.mfeRestOfDay : -999;
      const bm = b.mfeRestOfDay != null ? b.mfeRestOfDay : -999;
      return bm - am;
    })
    .slice(0, args.limitEvents);

  const meta = {
    generatedAt: new Date().toISOString(),
    daysOption: args.days,
    intradayDateFrom: allDates[0],
    intradayDateTo: allDates[allDates.length - 1],
    windowFrom: windowDates[0],
    windowTo: windowDates[windowDates.length - 1],
    tradingDaysUsed: windowDates.length,
  };
  const summary = {
    totalD: allD.length,
    complete: totalComplete,
    partial: totalPartial,
    missing: totalMissing,
    completeCoverageRate,
    perDate,
  };
  const autoMessages = buildAutoInterpretation(condDetection, condPerf, baselineCloseP.b70, baselineCloseP.b80);

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    meta, summary, baselineCloseP,
    condDetection, condPerf,
    fadedAnalysis, waitPullbackAnalysis,
    eventList,
  }, null, 2), 'utf-8');
  console.log(`✅ JSON 저장: ${OUT_JSON}`);

  const html = renderHtml({
    meta, summary, condDetection, condPerf,
    fadedAnalysis, waitPullbackAnalysis,
    eventList, autoMessages, baselineCloseP,
  });
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`✅ HTML 저장: ${OUT_HTML}`);

  console.log(`\n📊 요약:`);
  console.log(`  D 이벤트 (풀데이): ${allD.length}건 (커버리지 ${completeCoverageRate.toFixed(1)}%)`);
  console.log(`  closePos≥70 baseline: ${(baselineCloseP.b70 * 100).toFixed(1)}%`);
  console.log(`  closePos≥80 baseline: ${(baselineCloseP.b80 * 100).toFixed(1)}%`);
  let best = null;
  for (const k of ALL_CONDS) {
    const d = condDetection[k];
    if (!d || d.n < 20) continue;
    if (!best || (d.lift80 || 0) > (best.lift80 || 0)) best = { key: k, ...d };
  }
  if (best) console.log(`  최우수 사전탐지 (lift80): ${best.key} = ${best.lift80}x (n=${best.n})`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}
