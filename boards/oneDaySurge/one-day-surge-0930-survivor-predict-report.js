#!/usr/bin/env node
/**
 * 1DS — 09:30 시점에서 10시 생존 후보를 미리 예측하는 모델 백테스트
 *
 * 배경:
 *   기존 10시 생존 확인은 정확도는 좋지만 10:00에 확인 → 이미 09:30~10:00 사이 큰 부분 상승.
 *   60거래일 검증: 09:30 entry close return 평균 +2.49% vs 10:00 entry +0.23%.
 *   목표: 09:30 분봉만으로 10시 생존을 예측해 09:30 close에 진입할 후보를 찾는다.
 *
 * 입력:
 *   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json  (분봉, 대부분 full-day 09:00~15:30)
 *   - cache/stock-charts-long/{code}.json         (일봉 — 유동성 + dayHigh/Low/Close)
 *   - cache/naver-stocks-list.json                (메타)
 *   - boards/oneDaySurge/one-day-surge-0930-scanner.js (computeMetrics0930/classifyStatus 재사용)
 *
 * 출력:
 *   - reports/one-day-surge-0930-survivor-predict-result.json
 *   - reports/one-day-surge-0930-survivor-predict-result.html
 *
 * CLI:
 *   node boards/oneDaySurge/one-day-surge-0930-survivor-predict-report.js
 *   node boards/oneDaySurge/one-day-surge-0930-survivor-predict-report.js --days 60
 *   node boards/oneDaySurge/one-day-surge-0930-survivor-predict-report.js --from-date 2026-02-12 --to-date 2026-05-14
 *
 * 1DS 본체/스캐너/QVA/VVI/BMS 일체 무수정. 새 산출물만 생성.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-0930-survivor-predict-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-0930-survivor-predict-result.html');

const core    = require('./one-day-surge-core');
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
// 로더
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

// ─────────────────────────────────────────────────────────────────────────────
// 분봉 보조
// ─────────────────────────────────────────────────────────────────────────────
function barsInRange(bars, fromInc, toInc) {
  return (bars || []).filter(b => b && b.time && b.close > 0 && b.time >= fromInc && b.time <= toInc);
}
function barsInRangeExc(bars, fromExc, toInc) {
  return (bars || []).filter(b => b && b.time && b.close > 0 && b.time > fromExc && b.time <= toInc);
}
function sumValue(arr) { return arr.reduce((s, b) => s + (b.value || 0), 0); }
function maxHigh(arr)  { return arr.length ? Math.max(...arr.map(b => b.high || 0)) : null; }
function minLow(arr)   { return arr.length ? Math.min(...arr.map(b => b.low || Infinity)) : null; }
function pickBarAt(bars, time) {
  return (bars || []).find(b => b && b.time === time && b.close > 0) || null;
}
function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

// ─────────────────────────────────────────────────────────────────────────────
// 09:30 확장 features (scanner.computeMetrics0930 가 기본, 여기서 구간별/마지막 5분 추가)
// ─────────────────────────────────────────────────────────────────────────────
function compute0930Extras(bars0_30, m, prevClose) {
  const b00_10 = barsInRange(bars0_30, '09:00', '09:10');
  const b10_20 = barsInRange(bars0_30, '09:11', '09:20');
  const b20_30 = barsInRange(bars0_30, '09:21', '09:30');
  const b25_30 = barsInRange(bars0_30, '09:26', '09:30');
  const b20_25 = barsInRange(bars0_30, '09:21', '09:25');
  const b15_20 = barsInRange(bars0_30, '09:16', '09:20');

  const v00_10 = sumValue(b00_10);
  const v10_20 = sumValue(b10_20);
  const v20_30 = sumValue(b20_30);
  const v25_30 = sumValue(b25_30);
  const v20_25 = sumValue(b20_25);

  const close09_20 = pickBarAt(bars0_30, '09:20')?.close || (b10_20.slice(-1)[0]?.close || null);
  const close09_30 = m.last0930;
  const high_25_30 = maxHigh(b25_30);
  const low_25_30  = minLow(b25_30);
  const low_20_25  = minLow(b20_25);
  const low_15_20  = minLow(b15_20);
  const high_20_30 = maxHigh(b20_30);
  const high_0_30  = m.high0930;

  // 5분 VWAP (09:26~09:30)
  let vw = 0, vol = 0;
  for (const b of b25_30) {
    if (b.volume > 0 && b.close > 0) {
      vw += b.close * b.volume; vol += b.volume;
    }
  }
  const vwap_25_30 = vol > 0 ? vw / vol : null;

  // 09:00~09:30 중 고점 대비 -3% 이상 밀린 적 (max drawdown from running high)
  let runHigh = -Infinity;
  let maxDrawdownPct = 0;
  for (const b of bars0_30) {
    if (b.high > runHigh) runHigh = b.high;
    if (runHigh > 0) {
      const dd = (b.low / runHigh - 1) * 100;
      if (dd < maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  // 09:00~09:10 거래대금 집중 후 09:20~09:30 감소? (v20_30 < v00_10 * 0.5)
  const valueShrinkAfterMorning = v00_10 > 0 && v20_30 < v00_10 * 0.5;

  // 시가 대비 +8% 이상 과열 (이미 m.openToLastRate)
  const overheatedOpenToLast = (m.openToLastRate || 0) >= 8;

  return {
    // 구간별 거래대금
    value_0900_0910: Math.round(v00_10),
    value_0910_0920: Math.round(v10_20),
    value_0920_0930: Math.round(v20_30),
    value_0925_0930: Math.round(v25_30),
    value_0920_0925: Math.round(v20_25),
    ratio_v_0920_0930_to_0900_0910: v00_10 > 0 ? round(v20_30 / v00_10, 3) : null,
    ratio_v_0920_0930_to_0910_0920: v10_20 > 0 ? round(v20_30 / v10_20, 3) : null,
    ratio_v_0925_0930_to_0920_0925: v20_25 > 0 ? round(v25_30 / v20_25, 3) : null,
    // 09:20~09:30 가격 흐름
    closeChange_0920_0930_pct: close09_20 > 0 ? round(((close09_30 / close09_20) - 1) * 100, 3) : null,
    highRefresh_0920_0930: high_20_30 != null && high_0_30 != null && high_20_30 >= high_0_30,  // 09:20~09:30 high == 전체 09:00~09:30 high
    lowRising_0920_vs_earlier: low_20_25 != null && low_15_20 != null && low_20_25 > low_15_20,
    // 마지막 5분 (09:26~09:30)
    closeChange_0925_0930_pct: b20_25.length && b25_30.length
      ? round(((close09_30 / b20_25[b20_25.length-1].close) - 1) * 100, 3)
      : null,
    highRefresh_0925_0930: high_25_30 != null && high_0_30 != null && high_25_30 >= high_0_30,
    lowRising_0925_vs_0920: low_25_30 != null && low_20_25 != null && low_25_30 > low_20_25,
    closeVsHigh_0925_0930_dropPct: high_25_30 > 0 ? round(((close09_30 / high_25_30) - 1) * 100, 3) : null,
    above_vwap_25_30: vwap_25_30 != null ? close09_30 >= vwap_25_30 : null,
    // 실패 위험
    morningMaxDrawdownPct: round(maxDrawdownPct, 3),
    valueShrinkAfterMorning,
    overheatedOpenToLast,
    // 보조
    closeVsHigh_0_30_dropPct: high_0_30 > 0 ? round(((close09_30 / high_0_30) - 1) * 100, 3) : null,
    closeVsPrevClose_pct: prevClose > 0 ? round(((close09_30 / prevClose) - 1) * 100, 3) : null,
    valueToMarketCap_0930: null, // attached later
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome labels + 09:30 entry performance
// ─────────────────────────────────────────────────────────────────────────────
function computeOutcomes(bars, m, dayRow) {
  // bars: 전체 분봉 (09:00~15:30). m.last0930 = 09:30 close, m.high0930 = 09:00~09:30 high
  const last0930 = m.last0930;
  // 10:00 분봉
  const bars0931_1000 = barsInRangeExc(bars, '09:30', '10:00');
  if (bars0931_1000.length === 0) {
    return { hasOutcome: false, reason: 'no_post_0930_bars' };
  }
  // 10:00 bar
  let bar1000 = pickBarAt(bars, '10:00');
  if (!bar1000) {
    // fallback — 09:31~10:00 마지막 bar
    bar1000 = bars0931_1000[bars0931_1000.length - 1];
  }
  const close1000 = bar1000.close;
  const high_0931_1000 = maxHigh(bars0931_1000) || 0;
  const min_low_0931_1000 = minLow(bars0931_1000) || 0;

  // ── 정답 라벨 ──
  // L1: 10시 생존 성공
  const survivor1000 = (close1000 > last0930)
    && (close1000 >= high_0931_1000 * 0.98)
    && (min_low_0931_1000 >= last0930 * 0.97);

  // L3: 강한 10시 생존
  const strongSurvivor = close1000 >= last0930 * 1.03;

  // L2: 10시 생존 + 돌파 성공 — 10:00 이후 (10:01~15:30) 중 high > high_0931_1000
  const bars1001_to_end = barsInRangeExc(bars, '10:00', '23:59');
  let breakoutAfter1000 = false;
  let breakoutTime = null;
  if (high_0931_1000 > 0) {
    for (const b of bars1001_to_end) {
      if (b.high > high_0931_1000) {
        breakoutAfter1000 = true;
        breakoutTime = b.time;
        break;
      }
    }
  }
  const survivor1000AndBreakout = survivor1000 && breakoutAfter1000;
  const breakoutBefore_1015 = breakoutTime != null && breakoutTime <= '10:15';
  const breakoutBefore_1100 = breakoutTime != null && breakoutTime <= '11:00';

  // ── 09:30 진입 성과 ──
  // 분봉이 있으면 분봉 기반, 없으면 일봉 OHLC fallback
  const hasPostBars = bars1001_to_end.length > 0;
  let dayHigh, dayLow, dayClose;
  let mfeTime = null, maeTime = null;
  let entryToFinalCloseRet = null;
  let plus5_first = null, minus2_first = null;
  let plus10_first = null, minus3_first = null;
  let plus3_first = null, plus7_first = null;
  let minus5_first = null;

  if (hasPostBars) {
    // 09:30 분봉 이후 (09:31~15:30) 진입가 last0930 기준
    const allPost = barsInRangeExc(bars, '09:30', '23:59');
    let runHigh = -Infinity, runLow = Infinity, runHighTime = null, runLowTime = null;
    let p3 = null, p5 = null, p7 = null, p10 = null;
    let m2 = null, m3 = null, m5 = null;
    const entry = last0930;
    for (const b of allPost) {
      if (b.high > runHigh) { runHigh = b.high; runHighTime = b.time; }
      if (b.low < runLow)   { runLow = b.low;   runLowTime  = b.time; }
      const upPct = (b.high / entry - 1) * 100;
      const dnPct = (b.low  / entry - 1) * 100;
      if (p3  == null && upPct >= 3)  p3  = b.time;
      if (p5  == null && upPct >= 5)  p5  = b.time;
      if (p7  == null && upPct >= 7)  p7  = b.time;
      if (p10 == null && upPct >= 10) p10 = b.time;
      if (m2  == null && dnPct <= -2) m2  = b.time;
      if (m3  == null && dnPct <= -3) m3  = b.time;
      if (m5  == null && dnPct <= -5) m5  = b.time;
    }
    const finalBar = allPost[allPost.length - 1];
    dayHigh = runHigh > 0 ? runHigh : null;
    dayLow  = runLow < Infinity ? runLow : null;
    dayClose = finalBar?.close || null;
    mfeTime = runHighTime; maeTime = runLowTime;
    plus3_first = p3; plus5_first = p5; plus7_first = p7; plus10_first = p10;
    minus2_first = m2; minus3_first = m3; minus5_first = m5;
  } else if (dayRow) {
    // 분봉 없음 → 일봉 fallback (시각 정보 없음, +5 먼저 / -2 먼저 N/A)
    dayHigh = dayRow.high; dayLow = dayRow.low; dayClose = dayRow.close;
  } else {
    return { hasOutcome: false, reason: 'no_post_bars_no_daily' };
  }

  if (!(dayHigh > 0 && dayLow > 0 && dayClose > 0)) {
    return { hasOutcome: false, reason: 'invalid_post_data' };
  }

  const entry = last0930;
  const mfePct = round(((dayHigh / entry) - 1) * 100, 3);
  const maePct = round(((dayLow  / entry) - 1) * 100, 3);
  const finalRetPct = round(((dayClose / entry) - 1) * 100, 3);
  entryToFinalCloseRet = finalRetPct;

  return {
    hasOutcome: true,
    close1000, high_0931_1000, min_low_0931_1000,
    survivor1000, survivor1000AndBreakout, strongSurvivor,
    breakoutAfter1000, breakoutTime, breakoutBefore_1015, breakoutBefore_1100,
    dayHigh, dayLow, dayClose,
    mfePct, maePct, finalRetPct,
    mfeTime, maeTime,
    plus3_first, plus5_first, plus7_first, plus10_first,
    minus2_first, minus3_first, minus5_first,
    hasPostBars,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 09:30 후보 한 건 분석 (한 (date, code) 의 모든 데이터)
// ─────────────────────────────────────────────────────────────────────────────
function analyzeCandidate(dateDash, code, meta, chart, intraday) {
  if (!intraday || !Array.isArray(intraday.bars) || intraday.bars.length === 0) return null;
  const rows = chart?.rows || [];
  if (rows.length === 0) return null;

  const dateYmd = dashToYmd(dateDash);
  // 일봉에서 dateYmd row 찾기 + 직전 거래일 row 찾기
  let dayIdx = -1, prevIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === dateYmd) { dayIdx = i; break; }
  }
  // prevIdx: dayIdx-1 또는 dayIdx 못 찾았으면 < dateYmd 중 가장 최근 valid
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
  const dayRow = dayIdx >= 0 ? rows[dayIdx] : null;

  // 20일 평균 거래대금
  let sumVal = 0, n = 0;
  for (let i = prevIdx - 20; i < prevIdx; i++) {
    const r = rows[i]; if (r && r.volume > 0) { sumVal += (r.valueApprox || 0); n++; }
  }
  const avg20 = n > 0 ? sumVal / n : 0;

  // 유동성 + 종목 자격
  const liq = scanner.passesLiquidityFilter(meta, avg20, baseRow.valueApprox || 0);
  if (!liq.ok) return { skipped: true, reason: liq.reason };

  // 09:30 metrics (기본)
  const bars = intraday.bars;
  const bars0_30 = barsInRange(bars, '09:00', '09:30');
  if (bars0_30.length < 5) return { skipped: true, reason: 'too_few_bars' };
  const m = scanner.computeMetrics0930(bars, baseRow);
  if (!m) return { skipped: true, reason: 'compute_failed' };
  const status = scanner.classifyStatus(m);

  // 확장 features
  const ex = compute0930Extras(bars0_30, m, baseRow.close);
  if (meta.marketCap > 0) {
    ex.valueToMarketCap_0930 = round((m.value_0930 / meta.marketCap) * 100, 4);
  }
  ex.marketCap = meta.marketCap;
  ex.prevClose = baseRow.close;

  // 보조: TEN_REBREAK / explosiveTop 동시 (I 조건)
  // TEN_REBREAK는 09:31~10:30 분봉 필요 — outcome 시점과 별개로 09:30까지 정보 + 미래 정보 혼합.
  // 본 분석에서는 status === 'READY' 안에서 P 후보 평가만 하므로 explosiveTop 정확 정의가 필요할 때만 추가.
  // explosiveTop 정의(간단): READY + 09:30까지 값 매우 강함 — value_0930 ≥ 30억 + closePosition ≥ 0.7 + ratio ≥ 5.
  const isExplosiveTop = status === 'READY'
    && (m.value_0930 || 0) >= 3e9
    && (m.closePosition0930 || 0) >= 0.70
    && (m.valueToAvgRatio_0930 || 0) >= 5
    && (m.openToLastRate || 0) >= 2.0;

  // I 조건 prefilter (TEN_REBREAK 없이도 prefilter만 — 09:30까지 정보만 사용)
  const ICondPrefilter = (m.value_0930 >= 2.1e9)
    && ((m.closePosition0930 || 0) >= 0.50)
    && ((m.highToLastDrop || -10) >= -2.70)
    && ((m.openToLastRate || 0) >= 0.50)
    && ((m.valueToAvgRatio_0930 || 0) >= 3)
    && !!m.rebreakMorningHigh
    && (status === 'READY' || status === 'FADED');

  // outcomes
  const outcome = computeOutcomes(bars, m, dayRow);

  return {
    code, name: meta.name || code, market: meta.market || null,
    date: dateDash,
    marketCap: meta.marketCap, prevClose: baseRow.close,
    status, ...m, ...ex,
    isExplosiveTop, ICondPrefilter,
    outcome,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P1~P10 가설 정의 — 09:30 시점 정보만 사용
// ─────────────────────────────────────────────────────────────────────────────
const HYPOTHESES = [
  { id: 'P1',  name: '고점권 유지형',
    desc: 'READY + closePos ≥0.70 + drop ≥-1.5 + 종가 > 시가',
    pred: c => c.status === 'READY' && c.closePosition0930 >= 0.70 && c.highToLastDrop >= -1.5 && c.last0930 > c.open0900 },
  { id: 'P2',  name: '직전 10분 재가속형',
    desc: 'READY + v_20-30 ≥ v_10-20 + close_30 > close_20 + low_25_30 ≥ low_15_20',
    pred: c => c.status === 'READY' && c.value_0920_0930 >= c.value_0910_0920 && (c.closeChange_0920_0930_pct || 0) > 0 && (c.lowRising_0925_vs_0920 === true || c.lowRising_0920_vs_earlier === true) },
  { id: 'P3',  name: '마지막 5분 힘 유지형',
    desc: 'READY + close30 ≥ high_25_30×0.99 + v_25_30 ≥ v_20_25×0.8 + low_25_30 ≥ low_20_25',
    pred: c => c.status === 'READY' && (c.closeVsHigh_0925_0930_dropPct || -10) >= -1 && (c.value_0925_0930 >= c.value_0920_0925 * 0.8) && c.lowRising_0925_vs_0920 === true },
  { id: 'P4',  name: '고점권 + 거래대금 유지 (P1+P3)',
    desc: 'P1 AND P3',
    pred: c => HYPOTHESES[0].pred(c) && HYPOTHESES[2].pred(c) },
  { id: 'P5',  name: '재가속 + 거래대금 유지 (P2+P3)',
    desc: 'P2 AND P3',
    pred: c => HYPOTHESES[1].pred(c) && HYPOTHESES[2].pred(c) },
  { id: 'P6',  name: '강한 10시 생존 예상형',
    desc: 'READY + 종가 ≥ prevClose×1.03 + drop ≥-2.0 + (value≥3억 OR ratio상위)',
    pred: c => c.status === 'READY' && (c.closeVsPrevClose_pct || 0) >= 3 && c.highToLastDrop >= -2.0 && ((c.value_0930 || 0) >= 3e9 || (c.valueToAvgRatio_0930 || 0) >= 5) },
  { id: 'P7',  name: '과열 제외형',
    desc: 'READY + openToLast <8 + drop ≥-2.5 + v_20-30/v_00-10 ≥0.5',
    pred: c => c.status === 'READY' && c.openToLastRate < 8 && c.highToLastDrop >= -2.5 && (c.ratio_v_0920_0930_to_0900_0910 || 0) >= 0.5 },
  { id: 'P8',  name: '최고 압축형',
    desc: 'READY + drop ≥-1.5 + closePos ≥0.70 + v_20-30 ≥ v_10-20 + low_25_30 상승 + openToLast<8',
    pred: c => c.status === 'READY' && c.highToLastDrop >= -1.5 && c.closePosition0930 >= 0.70 && c.value_0920_0930 >= c.value_0910_0920 && c.lowRising_0925_vs_0920 === true && c.openToLastRate < 8 },
  { id: 'P9',  name: '공격형 포함형 (P8 + I/explosive)',
    desc: 'P8 AND (I 조건 prefilter OR explosiveTop)',
    pred: c => HYPOTHESES[7].pred(c) && (c.ICondPrefilter || c.isExplosiveTop) },
  { id: 'P10', name: '넓은 후보형',
    desc: 'READY + drop ≥-2.5 + close_30 > close_20 + v_20-30 유지',
    pred: c => c.status === 'READY' && c.highToLastDrop >= -2.5 && (c.closeChange_0920_0930_pct || 0) > 0 && c.value_0920_0930 >= c.value_0910_0920 * 0.8 },
];

// 비교 대상
const BASELINES = [
  { id: 'READY_ALL',         name: 'READY 전체',                  pred: c => c.status === 'READY' },
  { id: 'EXPLOSIVE',         name: 'explosiveTop',                pred: c => c.isExplosiveTop === true },
  { id: 'I_COND_PREFILTER',  name: 'I 조건 prefilter',            pred: c => c.ICondPrefilter === true },
];

// ─────────────────────────────────────────────────────────────────────────────
// 집계
// ─────────────────────────────────────────────────────────────────────────────
function summarizeSet(records) {
  // records: each has .outcome with hasOutcome=true
  const n = records.length;
  if (n === 0) {
    return { n: 0, dailyAvgCount: 0,
      precSurvivor: 0, recSurvivor: 0, precBreakout: 0, precStrong: 0,
      breakAfter1000_rate: 0, breakBefore1015_rate: 0, breakBefore1100_rate: 0,
      avgRet: 0, medianRet: 0, winRate: 0,
      reach3: 0, reach5: 0, reach7: 0, reach10: 0,
      drop2: 0, drop3: 0, drop5: 0,
      avgMfe: 0, avgMae: 0, worstLoss: 0, closePositiveRate: 0,
      p5_before_m2: 0, p10_before_m3: 0,
    };
  }
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

  const reach3  = records.filter(r => (r.outcome.mfePct || 0) >= 3).length / n;
  const reach5  = records.filter(r => (r.outcome.mfePct || 0) >= 5).length / n;
  const reach7  = records.filter(r => (r.outcome.mfePct || 0) >= 7).length / n;
  const reach10 = records.filter(r => (r.outcome.mfePct || 0) >= 10).length / n;
  const drop2 = records.filter(r => (r.outcome.maePct || 0) <= -2).length / n;
  const drop3 = records.filter(r => (r.outcome.maePct || 0) <= -3).length / n;
  const drop5 = records.filter(r => (r.outcome.maePct || 0) <= -5).length / n;
  const avgMfe = records.reduce((s, r) => s + (r.outcome.mfePct || 0), 0) / n;
  const avgMae = records.reduce((s, r) => s + (r.outcome.maePct || 0), 0) / n;
  const worstLoss = Math.min(...records.map(r => r.outcome.maePct || 0));
  const closePos = records.filter(r => (r.outcome.finalRetPct || 0) > 0).length / n;

  // +5 먼저 / -2 먼저 (시각 비교)
  const validP5M2 = records.filter(r => r.outcome.plus5_first || r.outcome.minus2_first);
  const p5BeforeM2 = validP5M2.length === 0 ? 0
    : validP5M2.filter(r => {
        const p = r.outcome.plus5_first, q = r.outcome.minus2_first;
        return p && (!q || p < q);
      }).length / validP5M2.length;
  const validP10M3 = records.filter(r => r.outcome.plus10_first || r.outcome.minus3_first);
  const p10BeforeM3 = validP10M3.length === 0 ? 0
    : validP10M3.filter(r => {
        const p = r.outcome.plus10_first, q = r.outcome.minus3_first;
        return p && (!q || p < q);
      }).length / validP10M3.length;

  const dates = new Set(records.map(r => r.date));
  const dailyAvgCount = n / Math.max(1, dates.size);

  return {
    n, dailyAvgCount: round(dailyAvgCount, 2),
    precSurvivor: round(surv / n * 100, 1),
    precBreakout: round(survBreak / n * 100, 1),
    precStrong: round(strong / n * 100, 1),
    breakAfter1000_rate: round(breakAfter / n * 100, 1),
    breakBefore1015_rate: round(breakB1015 / n * 100, 1),
    breakBefore1100_rate: round(breakB1100 / n * 100, 1),
    avgRet: round(avgRet, 2), medianRet: round(medianRet, 2), winRate: round(winRate * 100, 1),
    reach3: round(reach3 * 100, 1), reach5: round(reach5 * 100, 1),
    reach7: round(reach7 * 100, 1), reach10: round(reach10 * 100, 1),
    drop2: round(drop2 * 100, 1), drop3: round(drop3 * 100, 1), drop5: round(drop5 * 100, 1),
    avgMfe: round(avgMfe, 2), avgMae: round(avgMae, 2),
    worstLoss: round(worstLoss, 2),
    closePositiveRate: round(closePos * 100, 1),
    p5_before_m2: round(p5BeforeM2 * 100, 1),
    p10_before_m3: round(p10BeforeM3 * 100, 1),
  };
}

// Recall = filtered survivors / all survivors in READY universe
function summarizeRecall(filtered, allReady) {
  const survInFiltered = filtered.filter(r => r.outcome.survivor1000).length;
  const survInAll = allReady.filter(r => r.outcome.survivor1000).length;
  return survInAll === 0 ? 0 : round(survInFiltered / survInAll * 100, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 전략 시뮬레이션 — 진입 last0930, 분봉 순회로 익절/손절 도달 시각 비교
// ─────────────────────────────────────────────────────────────────────────────
function simulateStrategy(records, takeProfitPct, stopLossPct) {
  // record.outcome.plus{X}_first, minus{X}_first 사용
  let totalRet = 0, wins = 0, losses = 0, holds = 0;
  for (const r of records) {
    if (!r.outcome.hasOutcome) continue;
    const entry = r.last0930;
    // 익절/손절 시각 비교 (시간 문자열 비교 OK — HH:MM)
    const tp = takeProfitPct === 3 ? r.outcome.plus3_first
             : takeProfitPct === 5 ? r.outcome.plus5_first
             : takeProfitPct === 7 ? r.outcome.plus7_first
             : takeProfitPct === 10 ? r.outcome.plus10_first
             : null;
    const sl = stopLossPct === 2 ? r.outcome.minus2_first
             : stopLossPct === 3 ? r.outcome.minus3_first
             : stopLossPct === 5 ? r.outcome.minus5_first
             : stopLossPct === 1.5 ? null  // 1.5%는 별도 — 모두 -2%보다 보수적이지만 분봉 시각 정확 없음
             : null;
    let ret;
    if (tp && (!sl || tp <= sl)) { ret = takeProfitPct; wins++; }
    else if (sl && (!tp || sl < tp)) { ret = -stopLossPct; losses++; }
    else { ret = r.outcome.finalRetPct || 0; holds++; }
    totalRet += ret;
  }
  const n = records.length || 1;
  return { avgRet: round(totalRet / n, 2), wins, losses, holds,
    winRate: round(wins / n * 100, 1) };
}

// S5: 09:30 close 진입, 10:00 생존 실패 시 청산, 생존 성공 시 보유 (장종가)
function simulateS5(records) {
  let totalRet = 0;
  for (const r of records) {
    if (!r.outcome.hasOutcome) continue;
    if (r.outcome.survivor1000) totalRet += (r.outcome.finalRetPct || 0);
    else {
      // 10:00 시점 청산
      const entry = r.last0930;
      const ret = ((r.outcome.close1000 / entry) - 1) * 100;
      totalRet += ret;
    }
  }
  return { avgRet: round(totalRet / Math.max(1, records.length), 2) };
}

// S6: 11:00 까지 돌파 실패 시 청산, 돌파 성공 시 보유 (장종가)
function simulateS6(records) {
  let totalRet = 0;
  for (const r of records) {
    if (!r.outcome.hasOutcome) continue;
    if (r.outcome.breakoutBefore_1100) totalRet += (r.outcome.finalRetPct || 0);
    else {
      // 11:00 시점 청산 — 분봉이 있으면 11:00 close, 없으면 finalRetPct 사용
      // 단순화: 11:00 시점 가격을 모르면 청산 시 0% 가정 (보수적)
      totalRet += 0;
    }
  }
  return { avgRet: round(totalRet / Math.max(1, records.length), 2) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 실패 사례 분석 — 각 P 조건에서 실패한 케이스의 09:30 공통점 추출
// ─────────────────────────────────────────────────────────────────────────────
function analyzeFailures(records) {
  const fails = records.filter(r => !r.outcome.survivor1000 || r.outcome.finalRetPct <= -3);
  if (fails.length === 0) return { n: 0 };
  const n = fails.length;
  const counts = {
    high_drop_over_1pct:        fails.filter(r => (r.highToLastDrop || -10) <= -1.0).length,
    value_shrink_late:          fails.filter(r => r.valueShrinkAfterMorning === true).length,
    overheated:                 fails.filter(r => r.overheatedOpenToLast === true).length,
    very_low_v_to_mc:           fails.filter(r => (r.valueToMarketCap_0930 || 0) > 5).length,
    last5min_low_break:         fails.filter(r => r.lowRising_0925_vs_0920 === false).length,
    last5min_value_shrink:      fails.filter(r => (r.value_0925_0930 || 0) < (r.value_0920_0925 || 0) * 0.5).length,
    close_pct_from_morning_low: fails.filter(r => (r.closePosition0930 || 0) < 0.5).length,
  };
  const out = { n };
  for (const k of Object.keys(counts)) out[k + '_rate'] = round(counts[k] / n * 100, 1);
  out.avgFinalRet = round(fails.reduce((s, r) => s + (r.outcome.finalRetPct || 0), 0) / n, 2);
  out.examples = fails.slice(0, 8).map(r => ({
    date: r.date, code: r.code, name: r.name,
    drop: r.highToLastDrop, openToLast: r.openToLastRate, closePos: r.closePosition0930,
    valueShrinkAfterMorning: r.valueShrinkAfterMorning, finalRet: r.outcome.finalRetPct,
  }));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const t0 = Date.now();
  console.log('\n🔮 1DS 09:30 → 10시 생존 예측 백테스트 시작');

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(INTRADAY_BASE)) {
    console.error('[ERROR] data/intraday/1ds 없음');
    process.exit(1);
  }

  // 분석 일자
  let allDates = fs.readdirSync(INTRADAY_BASE).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (args.fromDate) allDates = allDates.filter(d => d >= args.fromDate);
  if (args.toDate)   allDates = allDates.filter(d => d <= args.toDate);
  if (!args.fromDate && !args.toDate) allDates = allDates.slice(-args.days);
  console.log(`  분석 일자: ${allDates.length}건 (${allDates[0]} ~ ${allDates[allDates.length-1]})`);

  const metaMap = loadMeta();
  console.log(`  종목 메타: ${metaMap.size}건`);

  // (date, code) → 분석 결과
  const allRecords = [];
  let skipNoChart = 0, skipNoMeta = 0, skipNoOutcome = 0, skipPreLiq = 0;
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
      if (result.skipped) { skipPreLiq++; continue; }
      if (!result.outcome || !result.outcome.hasOutcome) { skipNoOutcome++; continue; }
      allRecords.push(result);
    }
  }
  console.log(`  분석 record: ${allRecords.length}건 (skip: noChart=${skipNoChart} noMeta=${skipNoMeta} preLiq=${skipPreLiq} noOutcome=${skipNoOutcome})`);

  // status 분포
  const byStatus = {};
  for (const r of allRecords) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(`  status 분포:`, byStatus);

  // P/baseline 평가
  const readyAll = allRecords.filter(r => r.status === 'READY');
  console.log(`  READY 전체: ${readyAll.length}건`);

  const evals = [];
  function evaluate(id, name, desc, pred) {
    const filtered = allRecords.filter(pred);
    const summary = summarizeSet(filtered);
    const recall = summarizeRecall(filtered, readyAll);
    const failures = analyzeFailures(filtered);
    const strategies = {
      S1: simulateStrategy(filtered, 3, 2),     // -1.5 손절은 -2로 근사
      S2: simulateStrategy(filtered, 5, 2),
      S3: simulateStrategy(filtered, 7, 3),     // -2.5는 -3 근사
      S4: simulateStrategy(filtered, 10, 3),
      S5: simulateS5(filtered),
      S6: simulateS6(filtered),
    };
    evals.push({ id, name, desc, summary, recallVsReadyAll: recall, strategies, failures });
  }

  for (const b of BASELINES) evaluate(b.id, b.name, b.desc || '', b.pred);
  for (const h of HYPOTHESES) evaluate(h.id, h.name, h.desc, h.pred);

  // 평가 1 — 예측 성능 / 평가 2 — 성과 / 평가 3 — 실패 사례 (이미 evals에 포함)

  // 랭킹 — 좋은 조건 필터
  const rankCandidates = evals.filter(e =>
    e.summary.n >= 80 &&
    e.summary.dailyAvgCount >= 2 && e.summary.dailyAvgCount <= 15 &&
    e.summary.precSurvivor >= 65 &&
    e.summary.precBreakout >= 55 &&
    e.summary.avgRet >= 1.0 &&
    e.summary.reach5 >= 40 &&
    e.summary.drop3 <= 25
  ).sort((a, b) => b.summary.avgRet - a.summary.avgRet);

  // 최종 결론
  const readyAllSummary = evals.find(e => e.id === 'READY_ALL')?.summary || {};
  const readySurvivorReady = allRecords.filter(r => r.status === 'READY' && r.outcome.survivor1000);
  const survivor1000Summary = summarizeSet(readySurvivorReady);

  const out = {
    meta: {
      title: '1DS — 09:30 시점에서 10시 생존 예측 백테스트',
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
      passed: rankCandidates.map(e => ({ id: e.id, name: e.name, avgRet: e.summary.avgRet, precSurvivor: e.summary.precSurvivor, dailyAvg: e.summary.dailyAvgCount, n: e.summary.n })),
      allByAvgRet: [...evals].sort((a,b)=> (b.summary.avgRet||0) - (a.summary.avgRet||0)).map(e => ({ id: e.id, name: e.name, n: e.summary.n, avgRet: e.summary.avgRet, precSurvivor: e.summary.precSurvivor, dailyAvg: e.summary.dailyAvgCount })),
    },
    referenceSurvivorSummary: survivor1000Summary,  // 기존 10시 생존 후보 성과 비교용
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), 'utf-8');
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  console.log(`\n  📊 평가 결과 요약:`);
  console.log(`    READY 전체 (베이스라인) — n=${readyAllSummary.n} avgRet=${readyAllSummary.avgRet}% precSurv=${readyAllSummary.precSurvivor}% dailyAvg=${readyAllSummary.dailyAvgCount}`);
  console.log(`    기존 10시 생존 후보   — n=${survivor1000Summary.n} avgRet=${survivor1000Summary.avgRet}% precSurv=${survivor1000Summary.precSurvivor}% dailyAvg=${survivor1000Summary.dailyAvgCount}`);
  console.log(`  ── 09:30 예측 가설 (avgRet desc) ──`);
  for (const e of [...evals].sort((a,b)=>b.summary.avgRet - a.summary.avgRet).slice(0, 12)) {
    console.log(`    ${e.id.padEnd(20)} ${e.name.padEnd(28)} n=${String(e.summary.n).padStart(4)} avgRet=${String(e.summary.avgRet).padStart(6)}% precSurv=${String(e.summary.precSurvivor).padStart(5)}% dailyAvg=${e.summary.dailyAvgCount}`);
  }
  console.log(`  ── 추천 조건 (n≥80, precSurv≥65, precBreak≥55, avgRet≥1.0, reach5≥40, drop3≤25) ──`);
  if (rankCandidates.length === 0) console.log('    (없음)');
  for (const e of rankCandidates) {
    console.log(`    ✅ ${e.id} ${e.name} — avgRet=${e.summary.avgRet}% precSurv=${e.summary.precSurvivor}% dailyAvg=${e.summary.dailyAvgCount} n=${e.summary.n}`);
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

  function statusBar(v, max=100, color='#22c55e') {
    const w = Math.max(0, Math.min(100, (v/max)*100));
    return `<div style="display:inline-block;height:8px;background:${color};width:${w}%;border-radius:2px;"></div>`;
  }
  function pctCell(v, threshold) {
    if (v == null) return '<td>-</td>';
    const color = threshold && v >= threshold ? '#22c55e' : (v < 0 ? '#ef4444' : '#94a3b8');
    return `<td style="color:${color};font-weight:600">${v}%</td>`;
  }
  function evalRow(e) {
    const s = e.summary;
    return `<tr>
      <td><strong>${e.id}</strong></td>
      <td>${e.name}</td>
      <td style="font-size:11px;color:#94a3b8">${e.desc || ''}</td>
      <td style="text-align:right">${s.n}</td>
      <td style="text-align:right">${s.dailyAvgCount}</td>
      <td style="text-align:right;color:${s.precSurvivor>=65?'#22c55e':'#94a3b8'};font-weight:700">${s.precSurvivor}%</td>
      <td style="text-align:right">${e.recallVsReadyAll}%</td>
      <td style="text-align:right;color:${s.precBreakout>=55?'#22c55e':'#94a3b8'};font-weight:700">${s.precBreakout}%</td>
      <td style="text-align:right">${s.precStrong}%</td>
      <td style="text-align:right;color:${s.avgRet>=1?'#22c55e':(s.avgRet<0?'#ef4444':'#94a3b8')};font-weight:700">${s.avgRet}%</td>
      <td style="text-align:right">${s.winRate}%</td>
      <td style="text-align:right">${s.reach5}%</td>
      <td style="text-align:right;color:${s.drop3>25?'#ef4444':'#94a3b8'}">${s.drop3}%</td>
      <td style="text-align:right">${s.worstLoss}%</td>
    </tr>`;
  }

  // 1. 요약 결론
  const readyAllRow = baselines.find(b => b.id === 'READY_ALL') || { summary: {} };
  const conclusion = `
    <div class="conclusion">
      <h3>최종 결론</h3>
      <ul>
        <li><strong>09:30에 나와도 되는 후보 조건이 있는가?</strong> —
          ${ranking.passed.length > 0
            ? `있다. 추천 조건 <strong>${ranking.passed.length}건</strong> 통과: ${ranking.passed.map(r => r.id).join(', ')}.`
            : '엄격 기준(n≥80, precSurv≥65, avgRet≥1.0, drop3≤25 등)을 모두 만족하는 조건은 없음. 차순위로는 ' + ranking.allByAvgRet.slice(0, 3).map(r=>`${r.id}(${r.avgRet}%)`).join(', ') + '.'}
        </li>
        <li><strong>10시 생존 후보를 09:30에 얼마나 맞힐 수 있는가?</strong> —
          READY 전체 precision ${readyAllRow.summary.precSurvivor}% / 가설별 최고 precision ${Math.max(...evals.map(e => e.summary.precSurvivor || 0))}%.
          최고 precision 조건: ${(evals.slice().sort((a,b)=>b.summary.precSurvivor - a.summary.precSurvivor)[0] || {id:'?'}).id}.
        </li>
        <li><strong>09:30 진입이 10:00 확인 진입보다 나은가?</strong> —
          READY 전체 09:30 진입 평균 ${readyAllRow.summary.avgRet}% / 기존 10시 생존 후보(10:00 확인) 평균 ${referenceSurvivorSummary.avgRet}%.
          ${(readyAllRow.summary.avgRet || 0) > (referenceSurvivorSummary.avgRet || 0)
            ? '09:30 진입이 더 좋다 (10:00 확인이 평균을 깎음).'
            : '10:00 확인 진입이 더 좋지만 진입 가능 종목이 09:30보다 적음 (실제 도달 시점 늦음).'}
        </li>
        <li><strong>이미 10시 전 고점 찍은 종목 회피</strong> —
          P7(과열 제외형), P8(최고 압축형)이 closePosition ≥0.70 + drop ≥-1.5/-2.5 기준으로 종가 밀린 종목을 컷.
          drop3 비율 비교: READY 전체 ${readyAllRow.summary.drop3}% vs P7 ${(hypotheses.find(h=>h.id==='P7')?.summary.drop3 || '?')}% / P8 ${(hypotheses.find(h=>h.id==='P8')?.summary.drop3 || '?')}%.
        </li>
        <li><strong>1DS 보드에 "09:30 선진입 후보" 섹션 추가 가능?</strong> —
          ${ranking.passed.length > 0
            ? `<span style="color:#22c55e">가능.</span> 추천 조건(${ranking.passed.map(r=>r.id).join(', ')})으로 신규 섹션을 만들 수 있음. 다만 09:30 시점 진입이라 실시간 분봉 의존도가 높아 cron 안정성이 중요.`
            : '<span style="color:#fbbf24">엄격 기준 미통과.</span> 차순위 조건으로라도 시범 도입은 가능하나 별도 risk-aware 모니터링 필요.'}
        </li>
      </ul>
    </div>
  `;

  // 2. 순위표
  const tableHeader = `<thead><tr>
    <th>ID</th><th>이름</th><th>정의</th>
    <th>n</th><th>일평균</th>
    <th>10시생존 precision</th><th>recall</th>
    <th>돌파 precision</th><th>강한생존</th>
    <th>평균수익</th><th>승률</th><th>+5%도달</th><th>-3%이탈</th><th>최악손실</th>
  </tr></thead>`;

  const baselineTable = `
    <h3>📊 비교 대상 (베이스라인)</h3>
    <table>${tableHeader}<tbody>${baselines.map(evalRow).join('')}</tbody></table>
  `;
  const hypTable = `
    <h3>🔮 09:30 예측 가설 (P1~P10)</h3>
    <table>${tableHeader}<tbody>${hypotheses.map(evalRow).join('')}</tbody></table>
  `;
  const sortedByAvgRet = `
    <h3>🏆 평균 수익률 순 정렬 (전체)</h3>
    <table>${tableHeader}<tbody>${[...evals].sort((a,b)=>b.summary.avgRet - a.summary.avgRet).map(evalRow).join('')}</tbody></table>
  `;

  // 3. 전략 시뮬레이션
  function stratRow(e) {
    const s = e.strategies;
    return `<tr>
      <td><strong>${e.id}</strong></td><td>${e.name}</td>
      <td style="text-align:right">${e.summary.n}</td>
      <td style="text-align:right">${s.S1.avgRet}% (W:${s.S1.wins}/L:${s.S1.losses})</td>
      <td style="text-align:right">${s.S2.avgRet}% (W:${s.S2.wins}/L:${s.S2.losses})</td>
      <td style="text-align:right">${s.S3.avgRet}% (W:${s.S3.wins}/L:${s.S3.losses})</td>
      <td style="text-align:right">${s.S4.avgRet}% (W:${s.S4.wins}/L:${s.S4.losses})</td>
      <td style="text-align:right">${s.S5.avgRet}%</td>
      <td style="text-align:right">${s.S6.avgRet}%</td>
    </tr>`;
  }
  const strategyTable = `
    <h3>📈 전략 시뮬레이션 (S1=+3/-2, S2=+5/-2, S3=+7/-3, S4=+10/-3, S5=10시생존청산, S6=11시돌파청산)</h3>
    <table><thead><tr>
      <th>ID</th><th>이름</th><th>n</th>
      <th>S1 +3/-2</th><th>S2 +5/-2</th><th>S3 +7/-3</th><th>S4 +10/-3</th><th>S5 생존</th><th>S6 돌파</th>
    </tr></thead><tbody>${evals.map(stratRow).join('')}</tbody></table>
  `;

  // 4. 실패 사례 분석
  function failRow(e) {
    const f = e.failures;
    return `<tr>
      <td><strong>${e.id}</strong></td><td>${e.name}</td>
      <td style="text-align:right">${f.n}</td>
      <td style="text-align:right">${f.high_drop_over_1pct_rate || 0}%</td>
      <td style="text-align:right">${f.value_shrink_late_rate || 0}%</td>
      <td style="text-align:right">${f.overheated_rate || 0}%</td>
      <td style="text-align:right">${f.last5min_low_break_rate || 0}%</td>
      <td style="text-align:right">${f.last5min_value_shrink_rate || 0}%</td>
      <td style="text-align:right">${f.avgFinalRet || 0}%</td>
    </tr>`;
  }
  const failTable = `
    <h3>❌ 실패 사례 09:30 공통점 비율</h3>
    <table><thead><tr>
      <th>ID</th><th>이름</th><th>실패 n</th>
      <th>고점 -1%↓밀림</th><th>거래대금 후반 감소</th><th>+8%↑과열</th><th>5분 저점 붕괴</th><th>5분 거래대금 절반↓</th><th>평균 종가</th>
    </tr></thead><tbody>${evals.map(failRow).join('')}</tbody></table>
  `;

  // 5. 보드 반영 제안
  const recommendation = ranking.passed.length > 0
    ? `<p style="color:#22c55e"><strong>추천:</strong> ${ranking.passed.map(r => r.id).join(', ')} 조건으로 "09:30 선진입 후보" 섹션을 1DS 보드 상단에 추가. 일평균 ${ranking.passed.map(r => r.dailyAvg).join('/')}건 노출.</p>`
    : `<p style="color:#fbbf24"><strong>현재 데이터 기준 엄격 통과 조건은 없음.</strong> 차순위 후보 ${ranking.allByAvgRet.slice(0, 3).map(r=>r.id).join(', ')}로 시범 도입 검토 가능하지만 위험 모니터링 필요.</p>`;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>1DS — 09:30 → 10시 생존 예측 백테스트</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  max-width: 1600px; margin: 0 auto; padding: 18px 24px 80px; background: #0f172a; color: #e2e8f0; font-size: 13px; }
h1 { font-size: 22px; color: #f1f5f9; }
h2 { font-size: 16px; color: #cbd5e1; margin-top: 28px; }
h3 { font-size: 14px; color: #cbd5e1; margin-top: 18px; }
.purpose { background: #1e293b; border-left: 3px solid #a78bfa; padding: 12px 16px; border-radius: 6px; line-height: 1.7; }
.conclusion { background: #042f2e; border-left: 4px solid #14b8a6; padding: 14px 18px; border-radius: 6px; line-height: 1.8; margin: 18px 0; }
.conclusion ul { margin: 8px 0 0 0; padding-left: 20px; }
.conclusion li { margin-bottom: 8px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
th, td { padding: 6px 10px; border-bottom: 1px solid #334155; text-align: left; }
th { background: #1e293b; color: #cbd5e1; font-weight: 600; }
tr:hover { background: rgba(30,41,59,0.5); }
.meta-line { color: #94a3b8; font-size: 12px; margin-bottom: 12px; }
</style>
</head>
<body>
<h1>🔮 1DS — 09:30 시점에서 10시 생존 후보 예측 백테스트</h1>
<div class="meta-line">분석 기간: ${meta.dateRange.from} ~ ${meta.dateRange.to} (${meta.dateRange.n} 거래일) · 생성 ${new Date(meta.generatedAt).toLocaleString('ko-KR')}</div>

<div class="purpose">
  <strong>목표:</strong> 09:30까지의 분봉 정보만 사용해 10시 생존 가능성이 높은 종목을 미리 골라 09:30 close에 진입.<br>
  <strong>배경:</strong> 60일 백테스트 결과, 10시 생존 후보를 10:00에 확인하면 수익의 대부분이 09:30~10:00 사이에 이미 발생함 (09:30 평균 +2.49% / 10:00 평균 +0.23%).<br>
  <strong>정답 라벨:</strong>
  <ul style="margin:6px 0 0;">
    <li>10시 생존 = 10:00 close > 09:30 close AND 10:00 close ≥ 09:31~10:00 high × 0.98</li>
    <li>10시 생존 + 돌파 = 10시 생존 AND 10:00 이후 09:31~10:00 high 돌파</li>
    <li>강한 10시 생존 = 10:00 close ≥ 09:30 close × 1.03</li>
  </ul>
</div>

<h2>1. 요약 결론</h2>
${conclusion}

<h2>2. 09:30 예측 조건별 순위</h2>
${baselineTable}
${hypTable}
${sortedByAvgRet}

<h2>3. 09:30 진입 성과 — 전략별 시뮬레이션</h2>
${strategyTable}

<h2>4. 실패 사례 분석</h2>
${failTable}

<h2>5. 보드 반영 제안</h2>
${recommendation}

<div class="meta-line" style="margin-top:24px">전체 universe: ${universe.totalRecords}건 (status: ${Object.entries(universe.statusBreakdown).map(([k,v])=>k+'='+v).join(', ')}) · READY: ${universe.readyAllCount}건</div>
</body>
</html>`;
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = { main };
