#!/usr/bin/env node
/**
 * 1DS — 09:45 시점에서 10시 생존 후보 예측 + 진입 가능성 백테스트
 *
 * 배경:
 *   09:30 시점 정보만으로 10시 생존을 예측하기는 어려웠다 (best precSurv ~33-40%, drop3 ~45%).
 *   15분 더 본 09:45 시점에서는 신호가 더 명확해지는지, 그리고 그 시점 진입이
 *   10:00 확인 진입 대비 추가 수익 구간을 확보하는지 확인.
 *
 * 입력:
 *   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json (대부분 full-day 분봉)
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json
 *   - boards/oneDaySurge/one-day-surge-0930-scanner.js (computeMetrics0930/classifyStatus 재사용)
 *
 * 출력:
 *   - reports/one-day-surge-0945-survivor-predict-result.json
 *   - reports/one-day-surge-0945-survivor-predict-result.html
 *
 * 1DS 본체/스캐너/QVA/VVI/BMS 일체 무수정. 보드에도 반영하지 않음 (검증만).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-0945-survivor-predict-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-0945-survivor-predict-result.html');

const scanner = require('./one-day-surge-0930-scanner');

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { days: 60, fromDate: null, toDate: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--days') a.days = parseInt(argv[++i], 10) || 60;
    else if (k === '--from-date') a.fromDate = argv[++i];
    else if (k === '--to-date') a.toDate = argv[++i];
    else if (k === '--help' || k === '-h') {
      console.log('Usage: --days N | --from-date YYYY-MM-DD --to-date YYYY-MM-DD');
      process.exit(0);
    }
  }
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// 로더 / 유틸
// ─────────────────────────────────────────────────────────────────────────────
function loadMeta() {
  const m = new Map();
  if (!fs.existsSync(NAVER_LIST_PATH)) return m;
  try {
    const j = JSON.parse(fs.readFileSync(NAVER_LIST_PATH, 'utf-8'));
    for (const s of (j.stocks || [])) {
      if (!s.code) continue;
      m.set(s.code, {
        code: s.code, name: s.name, market: s.market,
        marketCap: s.marketValue || 0,
        isEtf: !!s.isEtf, isSpecial: !!s.isSpecial,
      });
    }
  } catch (_) {}
  return m;
}
function loadChart(code) {
  const p = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}
function loadIntraday(dateDash, code) {
  const p = path.join(INTRADAY_BASE, dateDash, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}
function dashToYmd(d) { return d ? d.replace(/-/g, '') : null; }
function barsInRange(bars, fromInc, toInc) {
  return (bars || []).filter(b => b && b.time && b.close > 0 && b.time >= fromInc && b.time <= toInc);
}
function barsInRangeExc(bars, fromExc, toInc) {
  return (bars || []).filter(b => b && b.time && b.close > 0 && b.time > fromExc && b.time <= toInc);
}
function sumValue(arr) { return arr.reduce((s, b) => s + (b.value || 0), 0); }
function maxHigh(arr)  { return arr.length ? Math.max(...arr.map(b => b.high || 0)) : null; }
function minLow(arr)   { return arr.length ? Math.min(...arr.map(b => b.low  || Infinity)) : null; }
function pickBarAt(bars, time) {
  return (bars || []).find(b => b && b.time === time && b.close > 0) || null;
}
function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

// ─────────────────────────────────────────────────────────────────────────────
// 09:45 feature 추출 — 09:30까지의 m + bars 사용
// 09:30 ~ 09:45 구간 분봉으로 확장 메트릭 계산
// ─────────────────────────────────────────────────────────────────────────────
function compute0945Features(bars, m) {
  // m: scanner.computeMetrics0930 결과 (09:00~09:30 메트릭)
  const last0930 = m.last0930;
  const high0930 = m.high0930;

  const bars31_45 = barsInRangeExc(bars, '09:30', '09:45');
  if (bars31_45.length < 5) return null;

  // 09:45 close (= 마지막 bar in 09:31~09:45)
  const bar0945 = pickBarAt(bars, '09:45') || bars31_45[bars31_45.length - 1];
  const close0945 = bar0945.close;

  // 09:31~09:45 high/low
  const high31_45 = maxHigh(bars31_45) || 0;
  const low31_45  = minLow(bars31_45) || 0;

  // closePosition since 09:30 (09:30 close 기준 09:31~09:45 range 안 close 위치)
  const rangeSince0930 = high31_45 - low31_45;
  const cpSince0930 = rangeSince0930 > 0 ? (close0945 - low31_45) / rangeSince0930 : 0.5;

  // 09:30~09:45 사이 09:30 close 대비 -1.5%/-2%/-3% 터치
  let touched_m15 = false, touched_m20 = false, touched_m30 = false;
  for (const b of bars31_45) {
    const dnPct = (b.low / last0930 - 1) * 100;
    if (dnPct <= -1.5) touched_m15 = true;
    if (dnPct <= -2)   touched_m20 = true;
    if (dnPct <= -3)   touched_m30 = true;
  }

  // 5분 구간별 거래대금
  const b30_35 = barsInRange(bars, '09:31', '09:35');
  const b35_40 = barsInRange(bars, '09:36', '09:40');
  const b40_45 = barsInRange(bars, '09:41', '09:45');
  const v30_35 = sumValue(b30_35);
  const v35_40 = sumValue(b35_40);
  const v40_45 = sumValue(b40_45);
  const v30_45 = v30_35 + v35_40 + v40_45;
  const v00_30 = m.value_0930 || 0;

  // 분당 close 추적
  const close0935 = pickBarAt(bars, '09:35')?.close || null;
  const close0940 = pickBarAt(bars, '09:40')?.close || null;

  // 09:30~09:45 중 09:30 close 대비 고점 갱신 (high31_45 > high0930)
  const highRefreshSince0930 = high31_45 > high0930;

  // 09:40~09:45 저점 상승 (low_b40_45 > low_b30_40)
  const low40_45 = minLow(b40_45);
  const low30_40 = Math.min(minLow(b30_35) || Infinity, minLow(b35_40) || Infinity);
  const lowRisingLate = (low40_45 != null && low30_40 != Infinity) ? low40_45 > low30_40 : false;

  // 09:40~09:45 고점 갱신 (high_b40_45 == high31_45)
  const high40_45 = maxHigh(b40_45);
  const highRefreshLate = high40_45 != null && high40_45 >= high31_45;

  // 09:30 이후 모든 5분 구간 low 단조 증가? (간단 버전)
  const allLowsRising = (minLow(b30_35) || Infinity) <= (minLow(b35_40) || Infinity) &&
                        (minLow(b35_40) || Infinity) <= (low40_45 || Infinity);
  const allHighsRising = (maxHigh(b30_35) || 0) <= (maxHigh(b35_40) || 0) &&
                         (maxHigh(b35_40) || 0) <= (high40_45 || 0);

  // 5분 VWAP (09:31~09:45)
  let vw = 0, vol = 0;
  for (const b of bars31_45) {
    if (b.volume > 0 && b.close > 0) { vw += b.close * b.volume; vol += b.volume; }
  }
  const vwap31_45 = vol > 0 ? vw / vol : null;

  // 09:30 high 재돌파 후 유지
  const reBreakHigh0930 = high31_45 > high0930;
  const heldAboveHigh0930 = reBreakHigh0930 && close0945 >= high0930 * 0.995;

  // 09:30~09:45 고점 갱신했지만 종가는 밀린 경우
  const refreshedButPushedBack = highRefreshSince0930 && (close0945 / high31_45 - 1) * 100 <= -1.5;

  // 09:40~09:45 거래대금 급감 (= v40_45 < v35_40 * 0.5)
  const volumeShrinkLate = v35_40 > 0 && v40_45 < v35_40 * 0.5;

  return {
    close0945,
    high0931_0945: high31_45,
    low0931_0945: low31_45,
    closeVs0930_pct: round(((close0945 / last0930) - 1) * 100, 3),
    closeVsHigh31_45_dropPct: high31_45 > 0 ? round(((close0945 / high31_45) - 1) * 100, 3) : null,
    closeVsLow31_45_pct: low31_45 > 0 ? round(((close0945 / low31_45) - 1) * 100, 3) : null,
    closePositionSince0930: round(cpSince0930, 3),
    highToLastDrop0945: high31_45 > 0 ? round(((close0945 / high31_45) - 1) * 100, 3) : null,
    touched_m15, touched_m20, touched_m30,
    value_0930_0935: Math.round(v30_35),
    value_0935_0940: Math.round(v35_40),
    value_0940_0945: Math.round(v40_45),
    ratio_v_0940_0945_to_0930_0935: v30_35 > 0 ? round(v40_45 / v30_35, 3) : null,
    ratio_v_0940_0945_to_0935_0940: v35_40 > 0 ? round(v40_45 / v35_40, 3) : null,
    cum_value_0930_0945: Math.round(v30_45),
    cum_v_0930_0945_to_v_0900_0930_ratio: v00_30 > 0 ? round(v30_45 / v00_30, 3) : null,
    close0935_above_0930: close0935 != null && close0935 > last0930,
    close0940_above_0930: close0940 != null && close0940 > last0930,
    close0945_above_0930: close0945 > last0930,
    close0945_above_0940: close0940 != null && close0945 > close0940,
    highRefreshSince0930, highRefreshLate, lowRisingLate,
    allLowsRising, allHighsRising,
    above_vwap_31_45: vwap31_45 != null ? close0945 >= vwap31_45 : null,
    reBreakHigh0930, heldAboveHigh0930,
    refreshedButPushedBack, volumeShrinkLate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome — 09:45 진입 기준
// ─────────────────────────────────────────────────────────────────────────────
function computeOutcomes(bars, last0930, close0945, high0930) {
  const bars31_45 = barsInRangeExc(bars, '09:30', '09:45');
  const bars46_1000 = barsInRange(bars, '09:46', '10:00');
  const bars31_1000 = barsInRangeExc(bars, '09:30', '10:00');

  // 10:00 bar
  let bar1000 = pickBarAt(bars, '10:00');
  if (!bar1000 && bars31_1000.length > 0) bar1000 = bars31_1000[bars31_1000.length - 1];
  if (!bar1000) return { hasOutcome: false, reason: 'no_1000_bar' };
  const close1000 = bar1000.close;

  // high_0931_1000 / min_low_0931_1000 (라벨용)
  const high0931_1000 = maxHigh(bars31_1000) || 0;
  const minLow0931_1000 = minLow(bars31_1000) || 0;

  // 라벨 A: 10시 생존
  const survivor1000 = (close1000 > last0930)
    && (close1000 >= high0931_1000 * 0.98)
    && (minLow0931_1000 >= last0930 * 0.97);

  // 라벨 C: 강한 10시 생존
  const strongSurvivor = close1000 >= last0930 * 1.03;

  // 라벨 D: 10시 실패 (close1000 <= 09:30 close OR close1000 high 대비 -2% 초과)
  const fail1000 = (close1000 <= last0930) ||
    (high0931_1000 > 0 && (close1000 / high0931_1000 - 1) * 100 < -2);

  // 라벨 B: 10:00 이후 09:31~10:00 high 돌파
  const bars1001_end = barsInRangeExc(bars, '10:00', '23:59');
  let breakoutAfter1000 = false, breakoutTime = null;
  for (const b of bars1001_end) {
    if (high0931_1000 > 0 && b.high > high0931_1000) { breakoutAfter1000 = true; breakoutTime = b.time; break; }
  }
  const survivor1000AndBreakout = survivor1000 && breakoutAfter1000;
  const breakoutBefore_1015 = breakoutTime != null && breakoutTime <= '10:15';
  const breakoutBefore_1100 = breakoutTime != null && breakoutTime <= '11:00';

  // 09:45 close 진입 기준 — bars 09:46~15:30 까지 MFE/MAE/익절손절 시각
  const bars46_end = barsInRangeExc(bars, '09:45', '23:59');
  const hasPostBars = bars46_end.length > 0;

  let dayHigh = null, dayLow = null, dayClose = null;
  let mfePct = null, maePct = null, finalRetPct = null;
  let plus2, plus3, plus5, plus7, plus10, minus15, minus20, minus30, minus50;
  plus2 = plus3 = plus5 = plus7 = plus10 = null;
  minus15 = minus20 = minus30 = minus50 = null;

  if (hasPostBars) {
    const entry = close0945;
    let runH = -Infinity, runL = Infinity;
    for (const b of bars46_end) {
      if (b.high > runH) runH = b.high;
      if (b.low  < runL) runL = b.low;
      const upPct = (b.high / entry - 1) * 100;
      const dnPct = (b.low  / entry - 1) * 100;
      if (plus2  == null && upPct >= 2)  plus2  = b.time;
      if (plus3  == null && upPct >= 3)  plus3  = b.time;
      if (plus5  == null && upPct >= 5)  plus5  = b.time;
      if (plus7  == null && upPct >= 7)  plus7  = b.time;
      if (plus10 == null && upPct >= 10) plus10 = b.time;
      if (minus15 == null && dnPct <= -1.5) minus15 = b.time;
      if (minus20 == null && dnPct <= -2)   minus20 = b.time;
      if (minus30 == null && dnPct <= -3)   minus30 = b.time;
      if (minus50 == null && dnPct <= -5)   minus50 = b.time;
    }
    dayHigh = runH > 0 ? runH : null;
    dayLow  = runL < Infinity ? runL : null;
    dayClose = bars46_end[bars46_end.length - 1].close;
    mfePct = round(((dayHigh / entry) - 1) * 100, 3);
    maePct = round(((dayLow  / entry) - 1) * 100, 3);
    finalRetPct = round(((dayClose / entry) - 1) * 100, 3);
  }

  // 10:00 진입 비교 (close1000 → dayClose)
  let ret_entry_1000 = null;
  if (hasPostBars && close1000 > 0) {
    ret_entry_1000 = round(((dayClose / close1000) - 1) * 100, 3);
  }

  return {
    hasOutcome: hasPostBars,
    close1000, high0931_1000, minLow0931_1000,
    survivor1000, survivor1000AndBreakout, strongSurvivor, fail1000,
    breakoutAfter1000, breakoutTime, breakoutBefore_1015, breakoutBefore_1100,
    dayHigh, dayLow, dayClose,
    mfePct, maePct, finalRetPct,
    plus2_first: plus2, plus3_first: plus3, plus5_first: plus5, plus7_first: plus7, plus10_first: plus10,
    minus15_first: minus15, minus20_first: minus20, minus30_first: minus30, minus50_first: minus50,
    ret_entry_1000,
    hasPostBars,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 한 (date, code) 분석
// ─────────────────────────────────────────────────────────────────────────────
function analyzeCandidate(dateDash, code, meta, chart, intraday) {
  if (!intraday || !Array.isArray(intraday.bars) || intraday.bars.length === 0) return null;
  const rows = chart?.rows || [];
  if (rows.length === 0) return null;

  const dateYmd = dashToYmd(dateDash);
  let dayIdx = -1, prevIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === dateYmd) { dayIdx = i; break; }
  }
  if (dayIdx >= 0) {
    for (let i = dayIdx - 1; i >= 0; i--) {
      if (rows[i] && rows[i].volume > 0 && rows[i].close > 0) { prevIdx = i; break; }
    }
  } else {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i] && rows[i].date < dateYmd && rows[i].volume > 0) { prevIdx = i; break; }
    }
  }
  if (prevIdx < 0) return null;
  const baseRow = rows[prevIdx];

  let sumVal = 0, n = 0;
  for (let i = prevIdx - 20; i < prevIdx; i++) {
    const r = rows[i]; if (r && r.volume > 0) { sumVal += (r.valueApprox || 0); n++; }
  }
  const avg20 = n > 0 ? sumVal / n : 0;

  const liq = scanner.passesLiquidityFilter(meta, avg20, baseRow.valueApprox || 0);
  if (!liq.ok) return { skipped: true, reason: liq.reason };

  const bars = intraday.bars;
  const m = scanner.computeMetrics0930(bars, baseRow);
  if (!m) return { skipped: true, reason: 'compute_failed' };
  const status = scanner.classifyStatus(m);

  // 09:45 features
  const f0945 = compute0945Features(bars, m);
  if (!f0945) return { skipped: true, reason: 'no_0945_bars' };

  // EXPLOSIVE 정의 (09:30 시점)
  const isExplosiveTop = status === 'READY'
    && (m.value_0930 || 0) >= 3e9
    && (m.closePosition0930 || 0) >= 0.70
    && (m.valueToAvgRatio_0930 || 0) >= 5
    && (m.openToLastRate || 0) >= 2.0;

  const outcome = computeOutcomes(bars, m.last0930, f0945.close0945, m.high0930);

  return {
    code, name: meta.name || code, market: meta.market || null,
    date: dateDash, marketCap: meta.marketCap, prevClose: baseRow.close,
    status, ...m, ...f0945, isExplosiveTop,
    outcome,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 가설 정의 — 09:45까지 정보만 사용
// ─────────────────────────────────────────────────────────────────────────────
const HYPOTHESES = [
  { id: 'A',  name: '0945_ALIVE_BASIC',
    desc: 'close0945 > close0930 AND close0945 ≥ high0931_0945 × 0.985 AND low0931_0945 ≥ close0930 × 0.98',
    pred: c => c.status === 'READY'
      && c.close0945_above_0930
      && (c.closeVsHigh31_45_dropPct || -10) >= -1.5
      && c.low0931_0945 >= c.last0930 * 0.98 },
  { id: 'B',  name: '0945_ALIVE_STRONG',
    desc: 'close0945 ≥ close0930×1.01 + closeVsHigh ≥-1.5% + low0945 ≥ close0930×0.98',
    pred: c => c.status === 'READY'
      && (c.closeVs0930_pct || 0) >= 1
      && (c.closeVsHigh31_45_dropPct || -10) >= -1.5
      && c.low0931_0945 >= c.last0930 * 0.98 },
  { id: 'C',  name: '0945_ALIVE_PLUS2',
    desc: 'close0945 ≥ close0930×1.02 + closeVsHigh ≥-2% + low0945 ≥ close0930×0.98',
    pred: c => c.status === 'READY'
      && (c.closeVs0930_pct || 0) >= 2
      && (c.closeVsHigh31_45_dropPct || -10) >= -2
      && c.low0931_0945 >= c.last0930 * 0.98 },
  { id: 'D',  name: '0945_NO_DROP',
    desc: 'close0945 > close0930 + 무 -2%터치 + 구간 high 대비 -2% 이내',
    pred: c => c.status === 'READY'
      && c.close0945_above_0930
      && !c.touched_m20
      && (c.closeVsHigh31_45_dropPct || -10) >= -2 },
  { id: 'E',  name: '0945_TREND_UP',
    desc: '35↑, 40↑, 45↑ 단조 + 무 -2%터치',
    pred: c => c.status === 'READY'
      && c.close0935_above_0930 && c.close0940_above_0930 && c.close0945_above_0930
      && c.close0945_above_0940
      && !c.touched_m20 },
  { id: 'F',  name: '0945_VOLUME_HOLD',
    desc: 'close0945 > close0930 + v_40-45 ≥ v_35-40×0.8 + closeVsHigh ≥-1.5%',
    pred: c => c.status === 'READY'
      && c.close0945_above_0930
      && (c.ratio_v_0940_0945_to_0935_0940 || 0) >= 0.8
      && (c.closeVsHigh31_45_dropPct || -10) >= -1.5 },
  { id: 'G',  name: '0945_REBREAK',
    desc: '09:30 high 재돌파 + heldAbove + 무 -2%터치',
    pred: c => c.status === 'READY'
      && c.reBreakHigh0930
      && c.heldAboveHigh0930
      && !c.touched_m20 },
  { id: 'H',  name: '0945_SURVIVOR_TOP',
    desc: 'A + close0945 ≥ 0930×1.01 + v_40-45 유지 + low_40-45 상승',
    pred: c => HYPOTHESES[0].pred(c)
      && (c.closeVs0930_pct || 0) >= 1
      && (c.ratio_v_0940_0945_to_0935_0940 || 0) >= 0.8
      && c.lowRisingLate },
  { id: 'I',  name: '0945_STRONG_TOP',
    desc: 'A + close0945 ≥ 0930×1.02 + closeVsHigh ≥-1% + v_40-45 유지',
    pred: c => HYPOTHESES[0].pred(c)
      && (c.closeVs0930_pct || 0) >= 2
      && (c.closeVsHigh31_45_dropPct || -10) >= -1
      && (c.ratio_v_0940_0945_to_0935_0940 || 0) >= 0.8 },
  { id: 'J',  name: '0945_EXPLOSIVE_ONLY',
    desc: '09:30 EXPLOSIVE + close0945 > 0930 + 무 -2%터치',
    pred: c => c.isExplosiveTop
      && c.close0945_above_0930
      && !c.touched_m20 },
  { id: 'K',  name: '0945_EXPLOSIVE_SURVIVE',
    desc: '09:30 EXPLOSIVE + A 조건',
    pred: c => c.isExplosiveTop && HYPOTHESES[0].pred(c) },
  { id: 'L',  name: '0945_READY_WIDE',
    desc: 'READY + close0945 > 0930 + 무 -3%터치',
    pred: c => c.status === 'READY'
      && c.close0945_above_0930
      && !c.touched_m30 },
];

const BASELINES = [
  { id: 'READY_0930',  name: '09:30 READY 전체',         pred: c => c.status === 'READY' },
  { id: 'EXPLOSIVE_0930', name: '09:30 EXPLOSIVE',       pred: c => c.isExplosiveTop === true },
];

// ─────────────────────────────────────────────────────────────────────────────
// 집계
// ─────────────────────────────────────────────────────────────────────────────
function summarizeSet(records) {
  const n = records.length;
  const empty = { n: 0, dailyAvgCount: 0,
    precSurvivor: 0, precBreakout: 0, precStrong: 0,
    breakAfter1000_rate: 0, breakBefore1015_rate: 0, breakBefore1100_rate: 0,
    avgRet: 0, medianRet: 0, winRate: 0,
    reach2: 0, reach3: 0, reach5: 0, reach7: 0, reach10: 0,
    drop15: 0, drop20: 0, drop30: 0, drop50: 0,
    avgMfe: 0, avgMae: 0, worstLoss: 0, closePositiveRate: 0,
    p3_before_m15: 0, p5_before_m20: 0, p10_before_m30: 0,
    avg_ret_entry_1000: 0,
  };
  if (n === 0) return empty;

  const surv = records.filter(r => r.outcome.survivor1000).length;
  const survBreak = records.filter(r => r.outcome.survivor1000AndBreakout).length;
  const strong = records.filter(r => r.outcome.strongSurvivor).length;
  const breakAfter = records.filter(r => r.outcome.breakoutAfter1000).length;
  const breakB1015 = records.filter(r => r.outcome.breakoutBefore_1015).length;
  const breakB1100 = records.filter(r => r.outcome.breakoutBefore_1100).length;

  const rets = records.map(r => r.outcome.finalRetPct || 0).sort((a, b) => a - b);
  const avgRet = rets.reduce((s, v) => s + v, 0) / n;
  const medianRet = rets[Math.floor(n / 2)];
  const winRate = records.filter(r => (r.outcome.finalRetPct || 0) > 0).length / n;

  const reach2  = records.filter(r => (r.outcome.mfePct || 0) >= 2).length / n;
  const reach3  = records.filter(r => (r.outcome.mfePct || 0) >= 3).length / n;
  const reach5  = records.filter(r => (r.outcome.mfePct || 0) >= 5).length / n;
  const reach7  = records.filter(r => (r.outcome.mfePct || 0) >= 7).length / n;
  const reach10 = records.filter(r => (r.outcome.mfePct || 0) >= 10).length / n;
  const drop15 = records.filter(r => (r.outcome.maePct || 0) <= -1.5).length / n;
  const drop20 = records.filter(r => (r.outcome.maePct || 0) <= -2).length / n;
  const drop30 = records.filter(r => (r.outcome.maePct || 0) <= -3).length / n;
  const drop50 = records.filter(r => (r.outcome.maePct || 0) <= -5).length / n;
  const avgMfe = records.reduce((s, r) => s + (r.outcome.mfePct || 0), 0) / n;
  const avgMae = records.reduce((s, r) => s + (r.outcome.maePct || 0), 0) / n;
  const worstLoss = Math.min(...records.map(r => r.outcome.maePct || 0));
  const closePos = records.filter(r => (r.outcome.finalRetPct || 0) > 0).length / n;

  // 순서 비교 (+3 먼저 / -1.5 먼저, +5 먼저 / -2, +10 / -3)
  function firstWinRate(pField, mField) {
    const valid = records.filter(r => r.outcome[pField] || r.outcome[mField]);
    if (valid.length === 0) return 0;
    const winners = valid.filter(r => {
      const p = r.outcome[pField], q = r.outcome[mField];
      return p && (!q || p < q);
    });
    return winners.length / valid.length;
  }
  const p3_before_m15 = firstWinRate('plus3_first', 'minus15_first');
  const p5_before_m20 = firstWinRate('plus5_first', 'minus20_first');
  const p10_before_m30 = firstWinRate('plus10_first', 'minus30_first');

  const dates = new Set(records.map(r => r.date));
  const dailyAvgCount = n / Math.max(1, dates.size);

  // 09:45 진입 vs 10:00 진입 비교 (평균 ret)
  const valid1000 = records.filter(r => r.outcome.ret_entry_1000 != null);
  const avg_ret_1000 = valid1000.length > 0 ? valid1000.reduce((s, r) => s + r.outcome.ret_entry_1000, 0) / valid1000.length : 0;

  return {
    n, dailyAvgCount: round(dailyAvgCount, 2),
    precSurvivor: round(surv / n * 100, 1),
    precBreakout: round(survBreak / n * 100, 1),
    precStrong: round(strong / n * 100, 1),
    breakAfter1000_rate: round(breakAfter / n * 100, 1),
    breakBefore1015_rate: round(breakB1015 / n * 100, 1),
    breakBefore1100_rate: round(breakB1100 / n * 100, 1),
    avgRet: round(avgRet, 2), medianRet: round(medianRet, 2), winRate: round(winRate * 100, 1),
    reach2: round(reach2 * 100, 1), reach3: round(reach3 * 100, 1),
    reach5: round(reach5 * 100, 1), reach7: round(reach7 * 100, 1), reach10: round(reach10 * 100, 1),
    drop15: round(drop15 * 100, 1), drop20: round(drop20 * 100, 1),
    drop30: round(drop30 * 100, 1), drop50: round(drop50 * 100, 1),
    avgMfe: round(avgMfe, 2), avgMae: round(avgMae, 2),
    worstLoss: round(worstLoss, 2),
    closePositiveRate: round(closePos * 100, 1),
    p3_before_m15: round(p3_before_m15 * 100, 1),
    p5_before_m20: round(p5_before_m20 * 100, 1),
    p10_before_m30: round(p10_before_m30 * 100, 1),
    avg_ret_entry_1000: round(avg_ret_1000, 2),
  };
}

function summarizeRecall(filtered, allReady) {
  const survInFiltered = filtered.filter(r => r.outcome.survivor1000).length;
  const survInAll = allReady.filter(r => r.outcome.survivor1000).length;
  return survInAll === 0 ? 0 : round(survInFiltered / survInAll * 100, 1);
}

// 전략 시뮬레이션 (분봉 시각 기반)
function simulateStrategy(records, tpPct, slPct) {
  let totalRet = 0, wins = 0, losses = 0, holds = 0;
  for (const r of records) {
    if (!r.outcome.hasOutcome) continue;
    const tp = tpPct === 2 ? r.outcome.plus2_first
             : tpPct === 3 ? r.outcome.plus3_first
             : tpPct === 5 ? r.outcome.plus5_first
             : tpPct === 7 ? r.outcome.plus7_first
             : tpPct === 10 ? r.outcome.plus10_first
             : null;
    const sl = slPct === 1.5 ? r.outcome.minus15_first
             : slPct === 2 ? r.outcome.minus20_first
             : slPct === 2.5 ? r.outcome.minus30_first   // -2.5는 -3 분봉 근사 (없음)
             : slPct === 3 ? r.outcome.minus30_first
             : null;
    let ret;
    if (tp && (!sl || tp <= sl)) { ret = tpPct; wins++; }
    else if (sl && (!tp || sl < tp)) { ret = -slPct; losses++; }
    else { ret = r.outcome.finalRetPct || 0; holds++; }
    totalRet += ret;
  }
  return { avgRet: round(totalRet / Math.max(1, records.length), 2), wins, losses, holds,
    winRate: round(wins / Math.max(1, records.length) * 100, 1) };
}

// S6: 09:45 entry, 10:00 생존 실패 시 청산 (= 10:00 close), 성공 시 종가 보유
function simulateS6(records) {
  let total = 0;
  for (const r of records) {
    if (!r.outcome.hasOutcome) continue;
    if (r.outcome.survivor1000) total += (r.outcome.finalRetPct || 0);
    else {
      // 09:45 close → 10:00 close 청산
      // 진입 가격: close0945 (record.close0945) / 청산 가격: close1000
      // 수익: (close1000 / close0945 - 1) * 100
      const entry = r.close0945, exit = r.outcome.close1000;
      if (entry > 0 && exit > 0) total += ((exit / entry) - 1) * 100;
    }
  }
  return { avgRet: round(total / Math.max(1, records.length), 2) };
}

// S7: 09:45 entry, 11:00 까지 돌파 실패 시 청산 (= 11:00 close), 성공 시 종가 보유
function simulateS7(records) {
  let total = 0;
  for (const r of records) {
    if (!r.outcome.hasOutcome) continue;
    if (r.outcome.breakoutBefore_1100) total += (r.outcome.finalRetPct || 0);
    else total += 0; // 11:00 청산 가격 모름 — 보수적 0% 가정
  }
  return { avgRet: round(total / Math.max(1, records.length), 2) };
}

// 실패 사례
function analyzeFailures(records) {
  const fails = records.filter(r => !r.outcome.survivor1000 || (r.outcome.finalRetPct || 0) <= -3);
  if (fails.length === 0) return { n: 0 };
  const n = fails.length;
  const counts = {
    drop_over_1pct_at_0945:  fails.filter(r => (r.closeVsHigh31_45_dropPct || 0) <= -1).length,
    volume_shrink_late:      fails.filter(r => r.volumeShrinkLate).length,
    touched_m20_in_window:   fails.filter(r => r.touched_m20).length,
    barely_above_0930:       fails.filter(r => (r.closeVs0930_pct || 0) < 0.5).length,
    no_high_refresh:         fails.filter(r => !r.highRefreshSince0930).length,
    refresh_pushback:        fails.filter(r => r.refreshedButPushedBack).length,
  };
  const out = { n };
  for (const k of Object.keys(counts)) out[k + '_rate'] = round(counts[k] / n * 100, 1);
  out.avgFinalRet = round(fails.reduce((s, r) => s + (r.outcome.finalRetPct || 0), 0) / n, 2);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const t0 = Date.now();
  console.log('\n🔮 1DS 09:45 → 10시 생존 예측 백테스트');

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(INTRADAY_BASE)) { console.error('[ERROR] intraday dir 없음'); process.exit(1); }

  let allDates = fs.readdirSync(INTRADAY_BASE).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (args.fromDate) allDates = allDates.filter(d => d >= args.fromDate);
  if (args.toDate)   allDates = allDates.filter(d => d <= args.toDate);
  if (!args.fromDate && !args.toDate) allDates = allDates.slice(-args.days);
  console.log(`  분석 일자: ${allDates.length}건 (${allDates[0]} ~ ${allDates[allDates.length-1]})`);

  const metaMap = loadMeta();
  console.log(`  종목 메타: ${metaMap.size}건`);

  const allRecords = [];
  let skipNoChart = 0, skipNoMeta = 0, skipNoOutcome = 0, skipPreLiq = 0, skipNo0945 = 0;
  for (const dateDash of allDates) {
    const intDir = path.join(INTRADAY_BASE, dateDash);
    if (!fs.existsSync(intDir)) continue;
    const files = fs.readdirSync(intDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const code = f.replace(/\.json$/, '');
      const meta = metaMap.get(code);
      if (!meta) { skipNoMeta++; continue; }
      const chart = loadChart(code);
      if (!chart) { skipNoChart++; continue; }
      const intraday = loadIntraday(dateDash, code);
      if (!intraday) continue;
      const result = analyzeCandidate(dateDash, code, meta, chart, intraday);
      if (!result) continue;
      if (result.skipped) {
        if (result.reason === 'no_0945_bars') skipNo0945++; else skipPreLiq++;
        continue;
      }
      if (!result.outcome || !result.outcome.hasOutcome) { skipNoOutcome++; continue; }
      allRecords.push(result);
    }
  }
  console.log(`  분석 record: ${allRecords.length}건 (skip: noMeta=${skipNoMeta} noChart=${skipNoChart} preLiq=${skipPreLiq} no0945=${skipNo0945} noOutcome=${skipNoOutcome})`);

  const byStatus = {};
  for (const r of allRecords) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(`  status 분포:`, byStatus);

  const readyAll = allRecords.filter(r => r.status === 'READY');
  console.log(`  09:30 READY 전체: ${readyAll.length}건`);

  const evals = [];
  function evaluate(id, name, desc, pred) {
    const filtered = allRecords.filter(pred);
    const summary = summarizeSet(filtered);
    const recall = summarizeRecall(filtered, readyAll);
    const failures = analyzeFailures(filtered);
    const strategies = {
      S1: simulateStrategy(filtered, 2, 1.5),
      S2: simulateStrategy(filtered, 3, 1.5),
      S3: simulateStrategy(filtered, 5, 2),
      S4: simulateStrategy(filtered, 7, 2.5),
      S5: simulateStrategy(filtered, 10, 3),
      S6: simulateS6(filtered),
      S7: simulateS7(filtered),
    };
    evals.push({ id, name, desc, summary, recallVsReadyAll: recall, strategies, failures });
  }
  for (const b of BASELINES) evaluate(b.id, b.name, b.desc || '', b.pred);
  for (const h of HYPOTHESES) evaluate(h.id, h.name, h.desc, h.pred);

  // 랭킹
  const rankCandidates = evals.filter(e => e.id !== 'READY_0930' && e.id !== 'EXPLOSIVE_0930' &&
    e.summary.n >= 80 &&
    e.summary.dailyAvgCount >= 2 && e.summary.dailyAvgCount <= 15 &&
    e.summary.precSurvivor >= 60 &&
    e.summary.precBreakout >= 50 &&
    e.summary.avgRet >= 1.0 &&
    e.summary.reach3 >= 45 &&
    e.summary.reach5 >= 30 &&
    e.summary.drop30 <= 30
  ).sort((a, b) => b.summary.avgRet - a.summary.avgRet);

  // 기존 10시 생존 후보 reference summary
  const refSurvivor = readyAll.filter(r => r.outcome.survivor1000);
  const refSurvivorSummary = summarizeSet(refSurvivor);

  const out = {
    meta: {
      title: '1DS — 09:45 시점 10시 생존 예측 백테스트',
      generatedAt: new Date().toISOString(),
      dateRange: { from: allDates[0], to: allDates[allDates.length-1], n: allDates.length },
      args,
    },
    universe: {
      totalRecords: allRecords.length,
      statusBreakdown: byStatus,
      readyAllCount: readyAll.length,
    },
    baselines: evals.filter(e => BASELINES.some(b => b.id === e.id)),
    hypotheses: evals.filter(e => HYPOTHESES.some(h => h.id === e.id)),
    ranking: {
      passed: rankCandidates.map(e => ({ id: e.id, name: e.name, avgRet: e.summary.avgRet,
        precSurvivor: e.summary.precSurvivor, precBreakout: e.summary.precBreakout,
        dailyAvg: e.summary.dailyAvgCount, n: e.summary.n, drop30: e.summary.drop30 })),
      allByAvgRet: [...evals].sort((a,b)=> (b.summary.avgRet||0) - (a.summary.avgRet||0)).map(e => ({
        id: e.id, name: e.name, n: e.summary.n,
        avgRet: e.summary.avgRet, precSurvivor: e.summary.precSurvivor,
        dailyAvg: e.summary.dailyAvgCount, drop30: e.summary.drop30,
      })),
    },
    referenceSurvivorSummary: refSurvivorSummary,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), 'utf-8');
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  // 콘솔 요약
  const baseReady = evals.find(e => e.id === 'READY_0930').summary;
  const baseExpl = evals.find(e => e.id === 'EXPLOSIVE_0930').summary;
  console.log(`\n  📊 베이스 — 09:30 READY 전체: n=${baseReady.n} avgRet(09:45 진입)=${baseReady.avgRet}% precSurv=${baseReady.precSurvivor}% drop30=${baseReady.drop30}%`);
  console.log(`         09:30 EXPLOSIVE:      n=${baseExpl.n} avgRet(09:45 진입)=${baseExpl.avgRet}% precSurv=${baseExpl.precSurvivor}% drop30=${baseExpl.drop30}%`);
  console.log(`  📊 기존 10시 생존 후보 (사후): n=${refSurvivorSummary.n} avgRet(09:45 진입)=${refSurvivorSummary.avgRet}% reach5=${refSurvivorSummary.reach5}% drop30=${refSurvivorSummary.drop30}%`);

  console.log(`  ── 09:45 가설 (avgRet desc) ──`);
  for (const e of [...evals].sort((a,b)=>b.summary.avgRet - a.summary.avgRet).slice(0, 14)) {
    console.log(`    ${e.id.padEnd(22)} ${e.name.padEnd(28)} n=${String(e.summary.n).padStart(4)} avg=${String(e.summary.avgRet).padStart(6)}% precSurv=${String(e.summary.precSurvivor).padStart(5)}% drop30=${String(e.summary.drop30).padStart(5)}% dailyAvg=${e.summary.dailyAvgCount}`);
  }
  console.log(`  ── 추천 조건 (n≥80, precSurv≥60%, precBreak≥50%, avgRet≥1.0%, reach3≥45%, reach5≥30%, drop30≤30%) ──`);
  if (rankCandidates.length === 0) console.log('    (없음)');
  for (const e of rankCandidates) {
    console.log(`    ✅ ${e.id} ${e.name} — avg=${e.summary.avgRet}% precSurv=${e.summary.precSurvivor}% dailyAvg=${e.summary.dailyAvgCount} drop30=${e.summary.drop30}% n=${e.summary.n}`);
  }
  console.log(`  elapsed: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML
// ─────────────────────────────────────────────────────────────────────────────
function buildHtml(data) {
  const { meta, universe, baselines, hypotheses, ranking, referenceSurvivorSummary } = data;
  const evals = [...baselines, ...hypotheses];

  function evalRow(e) {
    const s = e.summary;
    return `<tr>
      <td><strong>${e.id}</strong></td>
      <td>${e.name}</td>
      <td style="font-size:11px;color:#94a3b8">${e.desc || ''}</td>
      <td style="text-align:right">${s.n}</td>
      <td style="text-align:right">${s.dailyAvgCount}</td>
      <td style="text-align:right;color:${s.precSurvivor>=60?'#22c55e':'#94a3b8'};font-weight:700">${s.precSurvivor}%</td>
      <td style="text-align:right">${e.recallVsReadyAll}%</td>
      <td style="text-align:right;color:${s.precBreakout>=50?'#22c55e':'#94a3b8'};font-weight:700">${s.precBreakout}%</td>
      <td style="text-align:right">${s.precStrong}%</td>
      <td style="text-align:right;color:${s.avgRet>=1?'#22c55e':(s.avgRet<0?'#ef4444':'#94a3b8')};font-weight:700">${s.avgRet}%</td>
      <td style="text-align:right">${s.winRate}%</td>
      <td style="text-align:right">${s.reach3}%</td>
      <td style="text-align:right">${s.reach5}%</td>
      <td style="text-align:right;color:${s.drop30>30?'#ef4444':'#94a3b8'}">${s.drop30}%</td>
      <td style="text-align:right">${s.avg_ret_entry_1000}%</td>
      <td style="text-align:right">${s.worstLoss}%</td>
    </tr>`;
  }

  const tableHeader = `<thead><tr>
    <th>ID</th><th>이름</th><th>정의</th>
    <th>n</th><th>일평균</th>
    <th>생존 precision</th><th>recall</th>
    <th>돌파 precision</th><th>강한생존</th>
    <th>평균(09:45 진입)</th><th>승률</th>
    <th>+3%도달</th><th>+5%도달</th><th>-3%이탈</th>
    <th>10:00 진입 평균</th><th>최악손실</th>
  </tr></thead>`;

  const baseRow = baselines.find(b => b.id === 'READY_0930') || { summary: {} };
  const explRow = baselines.find(b => b.id === 'EXPLOSIVE_0930') || { summary: {} };
  const bestByAvg = [...evals].sort((a,b)=>b.summary.avgRet - a.summary.avgRet)[0];
  const bestByPrec = [...evals].sort((a,b)=>b.summary.precSurvivor - a.summary.precSurvivor)[0];
  // 09:30 보고서와 비교 위한 평균 수치 차이
  const ref0930 = { readyAvg: 0.72, readyPrec: 39, readyDrop: 45.5, exploAvg: 1.81, exploPrec: 33.3, exploDrop: 45.8 };

  const conclusion = `
    <div class="conclusion">
      <h3>최종 결론</h3>
      <ul>
        <li><strong>09:45에 나와도 되는 후보 조건이 있는가?</strong> —
          ${ranking.passed.length > 0
            ? `있다. 추천 조건 <strong>${ranking.passed.length}건</strong> 통과 (precSurv≥60%, avgRet≥1%, drop3≤30%): ${ranking.passed.map(r => r.id+'/'+r.name).join(', ')}.`
            : '엄격 기준 통과 0건. 차순위 후보: ' + ranking.allByAvgRet.slice(0, 3).map(r=>`${r.id}(avg ${r.avgRet}% / precSurv ${r.precSurvivor}%)`).join(' · ') + '.'}
        </li>
        <li><strong>09:45는 09:30보다 10시 생존 예측력이 확실히 좋아지는가?</strong> —
          09:30 보고서 READY 전체 precSurv ≈ ${ref0930.readyPrec}% → 09:45 시점 09:30 READY universe precSurv ${baseRow.summary.precSurvivor}%.
          09:45 베스트 가설 precSurv: ${(bestByPrec?.summary.precSurvivor || 0)}% (${bestByPrec?.id}).
          ${(bestByPrec?.summary.precSurvivor || 0) >= 55 ? '<span style="color:#22c55e">예측력 향상 명확.</span>' : '<span style="color:#fbbf24">정밀도 향상 제한적.</span>'}
        </li>
        <li><strong>09:45 진입이 10:00 확인 진입보다 나은가?</strong> —
          09:45 진입 평균(READY 전체) ${baseRow.summary.avgRet}% vs 10:00 진입 평균 ${baseRow.summary.avg_ret_entry_1000}%.
          ${(baseRow.summary.avgRet || 0) > (baseRow.summary.avg_ret_entry_1000 || 0)
            ? `<strong>09:45 진입이 +${round((baseRow.summary.avgRet || 0) - (baseRow.summary.avg_ret_entry_1000 || 0), 2)}%p 더 좋다.</strong>`
            : `10:00 진입이 더 좋다 (또는 비슷).`}
          09:45 베스트(${bestByAvg?.id}) 평균 ${bestByAvg?.summary.avgRet}% / 10:00 진입 ${bestByAvg?.summary.avg_ret_entry_1000}%.
        </li>
        <li><strong>09:45 진입 후 10시 생존 실패 시 손실을 감당할 수 있는가?</strong> —
          09:45 READY 전체 09:45→10:00 평균 손실(생존 실패): S6 전략 평균 ${(baselines.find(b=>b.id==='READY_0930')?.strategies?.S6?.avgRet ?? '?')}% (S6 = 생존 실패 시 10:00 청산).
          drop3 비율(READY 전체) ${baseRow.summary.drop30}% — 09:30 보고서 ${ref0930.readyDrop}% 대비 ${baseRow.summary.drop30 < ref0930.readyDrop ? '<span style="color:#22c55e">개선</span>' : '<span style="color:#ef4444">악화</span>'}.
        </li>
        <li><strong>1DS 보드에 "09:45 조기 생존 후보" 섹션 추가 가치 있는가?</strong> —
          ${ranking.passed.length > 0
            ? `<span style="color:#22c55e">가치 있음.</span> 추천 조건 ${ranking.passed.map(r=>r.id).join(', ')} 중 하나를 메인 필터로 사용. 단, 이번 작업에서는 보드 반영하지 않음 (검증만).`
            : '<span style="color:#fbbf24">단기적 가치 제한적.</span> 정밀도 충분치 않아 별도 섹션 도입은 보류. 차순위 후보로 추가 분석 권장.'}
        </li>
      </ul>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<title>1DS — 09:45 → 10시 생존 예측 백테스트</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  max-width: 1700px; margin: 0 auto; padding: 18px 24px 80px; background: #0f172a; color: #e2e8f0; font-size: 13px; }
h1 { font-size: 22px; color: #f1f5f9; }
h2 { font-size: 16px; color: #cbd5e1; margin-top: 28px; }
h3 { font-size: 14px; color: #cbd5e1; }
.purpose { background: #1e293b; border-left: 3px solid #a78bfa; padding: 12px 16px; border-radius: 6px; line-height: 1.7; }
.conclusion { background: #042f2e; border-left: 4px solid #14b8a6; padding: 14px 18px; border-radius: 6px; line-height: 1.8; margin: 18px 0; }
.conclusion ul { margin: 8px 0 0; padding-left: 20px; }
.conclusion li { margin-bottom: 8px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
th, td { padding: 6px 8px; border-bottom: 1px solid #334155; text-align: left; }
th { background: #1e293b; color: #cbd5e1; font-weight: 600; }
tr:hover { background: rgba(30,41,59,0.5); }
.meta-line { color: #94a3b8; font-size: 12px; margin-bottom: 12px; }
</style></head><body>
<h1>🔮 1DS — 09:45 시점에서 10시 생존 후보 예측 + 진입 가능성 백테스트</h1>
<div class="meta-line">분석 기간: ${meta.dateRange.from} ~ ${meta.dateRange.to} (${meta.dateRange.n} 거래일) · 생성 ${new Date(meta.generatedAt).toLocaleString('ko-KR')}</div>
<div class="purpose">
  <strong>목표:</strong> 09:45까지의 분봉만으로 10시 생존을 예측하고, 09:45 close 진입이 10:00 확인 진입보다 추가 수익을 확보하는지.<br>
  <strong>09:30 보고서 대비:</strong> 09:30 READY 전체 avgRet 0.72% / precSurv 39% / drop3 45.5% — 09:45는 정밀도와 실패율이 개선되는지가 핵심.<br>
  <strong>비교:</strong> universe = 09:30 READY 종목 (1066건). 같은 종목에 대해 09:45까지 새 features 적용.
</div>

<h2>1. 요약 결론</h2>
${conclusion}

<h2>2. 09:45 예측 조건별 순위</h2>
<h3>비교 대상 (09:30 시점 분류)</h3>
<table>${tableHeader}<tbody>${baselines.map(evalRow).join('')}</tbody></table>
<h3>09:45 예측 가설 (A~L)</h3>
<table>${tableHeader}<tbody>${hypotheses.map(evalRow).join('')}</tbody></table>
<h3>전체 평균수익률 순</h3>
<table>${tableHeader}<tbody>${[...evals].sort((a,b)=>b.summary.avgRet - a.summary.avgRet).map(evalRow).join('')}</tbody></table>

<h2>3. 09:45 vs 10:00 진입 수익 비교</h2>
<table><thead><tr>
<th>ID</th><th>이름</th><th>n</th>
<th>09:45 진입 평균</th><th>10:00 진입 평균</th><th>09:45가 더 확보한 수익</th>
<th>09:45→10:00 평균 (S6 = 생존 실패 시 청산)</th>
</tr></thead><tbody>
${evals.map(e => {
  const diff = round((e.summary.avgRet || 0) - (e.summary.avg_ret_entry_1000 || 0), 2);
  return `<tr>
    <td><strong>${e.id}</strong></td><td>${e.name}</td>
    <td style="text-align:right">${e.summary.n}</td>
    <td style="text-align:right">${e.summary.avgRet}%</td>
    <td style="text-align:right">${e.summary.avg_ret_entry_1000}%</td>
    <td style="text-align:right;color:${diff>0?'#22c55e':'#ef4444'}">${diff>=0?'+':''}${diff}%p</td>
    <td style="text-align:right">${e.strategies.S6.avgRet}%</td>
  </tr>`;
}).join('')}
</tbody></table>

<h2>4. 전략 시뮬레이션 (S1=+2/-1.5, S2=+3/-1.5, S3=+5/-2, S4=+7/-2.5, S5=+10/-3, S6=생존 청산, S7=돌파 청산)</h2>
<table><thead><tr>
<th>ID</th><th>이름</th><th>n</th>
<th>S1 +2/-1.5</th><th>S2 +3/-1.5</th><th>S3 +5/-2</th><th>S4 +7/-2.5</th><th>S5 +10/-3</th><th>S6 생존</th><th>S7 돌파</th>
</tr></thead><tbody>
${evals.map(e => {
  const s = e.strategies;
  return `<tr>
    <td><strong>${e.id}</strong></td><td>${e.name}</td>
    <td style="text-align:right">${e.summary.n}</td>
    <td style="text-align:right">${s.S1.avgRet}%</td>
    <td style="text-align:right">${s.S2.avgRet}%</td>
    <td style="text-align:right">${s.S3.avgRet}%</td>
    <td style="text-align:right">${s.S4.avgRet}%</td>
    <td style="text-align:right">${s.S5.avgRet}%</td>
    <td style="text-align:right">${s.S6.avgRet}%</td>
    <td style="text-align:right">${s.S7.avgRet}%</td>
  </tr>`;
}).join('')}
</tbody></table>

<h2>5. 실패 사례 09:45 공통점</h2>
<table><thead><tr>
<th>ID</th><th>이름</th><th>실패 n</th>
<th>구간 고점 -1%↓밀림</th><th>40-45 거래대금 급감</th><th>-2% 터치</th>
<th>09:30 대비 약진</th><th>high 갱신 실패</th><th>고점 갱신 후 종가 밀림</th><th>평균 종가</th>
</tr></thead><tbody>
${evals.map(e => {
  const f = e.failures;
  return `<tr>
    <td><strong>${e.id}</strong></td><td>${e.name}</td>
    <td style="text-align:right">${f.n}</td>
    <td style="text-align:right">${f.drop_over_1pct_at_0945_rate || 0}%</td>
    <td style="text-align:right">${f.volume_shrink_late_rate || 0}%</td>
    <td style="text-align:right">${f.touched_m20_in_window_rate || 0}%</td>
    <td style="text-align:right">${f.barely_above_0930_rate || 0}%</td>
    <td style="text-align:right">${f.no_high_refresh_rate || 0}%</td>
    <td style="text-align:right">${f.refresh_pushback_rate || 0}%</td>
    <td style="text-align:right">${f.avgFinalRet || 0}%</td>
  </tr>`;
}).join('')}
</tbody></table>

<div class="meta-line" style="margin-top:24px">전체 universe: ${universe.totalRecords}건 (status: ${Object.entries(universe.statusBreakdown).map(([k,v])=>k+'='+v).join(', ')}) · 09:30 READY: ${universe.readyAllCount}건</div>
</body></html>`;
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = { main };
