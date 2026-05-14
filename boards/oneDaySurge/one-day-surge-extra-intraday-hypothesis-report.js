#!/usr/bin/env node
/**
 * 1DS 09:30 스캐너 — 추가 단타 가설 백테스트 보고서
 *
 * 기존 explosiveTop은 09:30 시점에서 완벽한 종목만 본다 (보수적).
 * 이 보고서는 09:30 이후 다시 살아나는 종목 / 거래대금이 2차로 붙는 종목 등
 * 늦게 진입 가능한 추가 단타 가설 5종을 검증한다.
 *
 * 검증 가설:
 *   1. TEN_REBREAK       — 09:30~10:30 사이 09:30 high 재돌파 (거래대금 2배 가산)
 *   2. FADED_RECOVERY    — 09:30 FADED → 10:00 close 회복 → 10:30 high 재돌파
 *   3. SECOND_VALUE_SURGE — 09:30~10:00 또는 10:00~10:30 거래대금 2차 surge
 *   4. TEN_SURVIVOR      — 10:00 close 위 유지 + 10시 고가 근처
 *   5. MORNING_TREND     — 09:15→09:30→10:00→10:30 close+low 동시 상승 트렌드
 *
 * 비교 베이스라인 (09:30 close 진입, 종가 청산):
 *   - explosiveTop (스캐너 폭발형 후보)
 *   - READY 전체 / FADED 전체 / WAIT_PULLBACK / WEAK
 *
 * 미래 누수 금지:
 *   - 각 가설의 trigger 조건은 trigger 시점(T) 이전 분봉만 사용
 *   - 진입가는 T 시점 close (또는 재돌파 가격)
 *   - 성과는 T 직후 분봉 ~ 청산 시점 분봉만 사용
 *
 * 입력:
 *   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json  (09:00~15:30 분봉)
 *   - cache/stock-charts-long/{code}.json         (유동성 필터용 전일 일봉)
 *   - cache/naver-stocks-list.json                (메타: ETF/특수/시총)
 *
 * 출력:
 *   - reports/one-day-surge-extra-intraday-hypothesis-result.{json,html}
 *
 * 사용:
 *   node boards/oneDaySurge/one-day-surge-extra-intraday-hypothesis-report.js
 *   node boards/oneDaySurge/one-day-surge-extra-intraday-hypothesis-report.js --from 2026-04-16 --to 2026-05-14
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
let OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-extra-intraday-hypothesis-result.json');
let OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-extra-intraday-hypothesis-result.html');

const scanner = require('./one-day-surge-0930-scanner');

// ── CLI ──
function parseArgs(argv) {
  const a = { from: null, to: null, days: null, minDirSize: 200 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from' || k === '--from-date') a.from = argv[++i];
    else if (k === '--to' || k === '--to-date') a.to = argv[++i];
    else if (k === '--days') a.days = parseInt(argv[++i], 10) || null;
    else if (k === '--min-dir-size') a.minDirSize = parseInt(argv[++i], 10) || 200;
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node one-day-surge-extra-intraday-hypothesis-report.js [--from-date YYYY-MM-DD] [--to-date YYYY-MM-DD] [--days N] [--min-dir-size 200]');
      process.exit(0);
    }
  }
  return a;
}
function applyDaysSuffix(days) {
  if (!days || days < 30) return;
  OUT_JSON = path.join(REPORTS_DIR, `one-day-surge-extra-intraday-hypothesis-${days}d-result.json`);
  OUT_HTML = path.join(REPORTS_DIR, `one-day-surge-extra-intraday-hypothesis-${days}d-result.html`);
}

// ── 분봉 유틸 ──
function barsInRange(bars, fromExclusive, toInclusive) {
  // fromExclusive < time ≤ toInclusive
  return bars.filter((b) => b && b.time && b.close > 0 && b.time > fromExclusive && b.time <= toInclusive);
}
function barsInRangeInclusive(bars, fromInclusive, toInclusive) {
  return bars.filter((b) => b && b.time && b.close > 0 && b.time >= fromInclusive && b.time <= toInclusive);
}
function lastBarAtOrBefore(bars, t) {
  let r = null;
  for (const b of bars) {
    if (b && b.time && b.close > 0 && b.time <= t) r = b;
    else if (b && b.time > t) break;
  }
  return r;
}
function sumValue(arr) { return arr.reduce((s, b) => s + (b.value || 0), 0); }
function maxHigh(arr)  { return arr.length ? Math.max(...arr.map((b) => b.high || 0)) : 0; }
function minLow(arr)   { return arr.length ? Math.min(...arr.map((b) => b.low  || Infinity)) : Infinity; }

// ── 가설 trigger ──
// 각 함수는 { entryTime, entryPrice, slPrice|slPct, tpPct, exitTime, reason } 또는 null 반환
// trigger 검증 시점까지의 분봉만 사용 (미래 누수 X)

// 1. TEN_REBREAK
//   - 09:00~09:30 value ≥ 10억
//   - 09:30 highToLastDrop ≥ -4%
//   - 09:31~10:30 사이 어떤 분봉이 09:30 high 돌파 + 그 분봉 value > 직전 5분 평균 × 2
//   - 진입가 = high0930 (재돌파 가격), 청산 = 11:00 또는 종가
function hypoTenRebreak(bars, m) {
  if (!m) return null;
  if ((m.value_0930 || 0) < 1e9) return null;
  if (m.highToLastDrop != null && m.highToLastDrop < -4) return null;

  const window = barsInRange(bars, '09:30', '10:30');
  if (window.length < 5) return null;

  for (let i = 0; i < window.length; i++) {
    const b = window[i];
    if (!(b.high > m.high0930)) continue;
    // 직전 5분 평균 거래대금 — i 이전 5개 (없으면 그 부분만)
    const prev5 = window.slice(Math.max(0, i - 5), i);
    if (prev5.length === 0) continue;
    const avg5 = sumValue(prev5) / prev5.length;
    if (avg5 <= 0) continue;
    if ((b.value || 0) < avg5 * 2) continue;

    return {
      entryTime: b.time,
      entryPrice: m.high0930,
      slPct: -2.0,
      tpPct: 5.0,
      exitTime: '11:00',
      reason: `09:30 high(${m.high0930}) 재돌파 + value ${(b.value/1e8).toFixed(1)}억 (×${(b.value/avg5).toFixed(1)})`,
    };
  }
  return null;
}

// 2. FADED_RECOVERY
//   - 09:30 상태 = FADED (drop ≤ -2.5% 자동)
//   - 09:00~09:30 value ≥ 20억
//   - 09:30 highToLastDrop in [-6%, -2.5%]
//   - 09:31~10:00 사이 어떤 분봉 close ≥ 09:30 close
//   - 10:00~10:30 사이 어떤 분봉 high > 09:30 high
//   - 진입 = 09:30 high 재돌파 가격, 청산 = 11:00 또는 종가
function hypoFadedRecovery(bars, m, status) {
  if (!m) return null;
  if (status !== 'FADED') return null;
  if ((m.value_0930 || 0) < 2e9) return null;
  if (m.highToLastDrop == null) return null;
  if (m.highToLastDrop > -2.5 || m.highToLastDrop < -6) return null;

  // step 1: 09:31~10:00 close 회복
  const w1 = barsInRange(bars, '09:30', '10:00');
  const recovered = w1.some((b) => b.close >= m.last0930);
  if (!recovered) return null;

  // step 2: 09:31~10:30 high 재돌파 (전체 09:30 이후 첫 재돌파 시점)
  const w2 = barsInRange(bars, '09:30', '10:30');
  const rebreakBar = w2.find((b) => b.high > m.high0930);
  if (!rebreakBar) return null;

  return {
    entryTime: rebreakBar.time,
    entryPrice: m.high0930,
    slPct: -2.0,
    tpPct: 5.0,
    exitTime: '11:00',
    reason: `FADED drop ${m.highToLastDrop}% → ${rebreakBar.time} 09:30 high 재돌파`,
  };
}

// 3. SECOND_VALUE_SURGE
//   - 09:00~09:30 value ≥ 10억
//   - 가격은 09:30 close 위 유지 (모든 분봉 close ≥ 09:30 close)
//   - 조건 A: 09:30~10:00 value ≥ 09:00~09:30 value × 0.5  → entry @ 10:00 close
//   - 조건 B (A 실패 시): 10:00~10:30 value > 09:30~10:00 value (가격 유지 09:31~10:30) → entry @ 10:30 close
//   - 청산 종가
function hypoSecondValueSurge(bars, m) {
  if (!m) return null;
  if ((m.value_0930 || 0) < 1e9) return null;

  const w0930_1000 = barsInRange(bars, '09:30', '10:00');
  if (w0930_1000.length < 10) return null;
  const value0930_1000 = sumValue(w0930_1000);
  const bar1000 = lastBarAtOrBefore(bars, '10:00');
  if (!bar1000 || bar1000.time < '09:45') return null;  // 10:00 근방 분봉 필요

  // 가격 유지 — 09:31~10:00 모든 분봉 close ≥ 09:30 close
  const priceHoldA = w0930_1000.every((b) => b.close >= m.last0930);

  // 조건 A
  if (priceHoldA && value0930_1000 >= m.value_0930 * 0.5) {
    return {
      entryTime: bar1000.time,
      entryPrice: bar1000.close,
      slPct: -2.0,
      tpPct: 5.0,
      exitTime: '15:20',
      reason: `09:30~10:00 value ${(value0930_1000/1e8).toFixed(1)}억 ≥ 50% of 09:00~09:30 (${(m.value_0930/1e8).toFixed(1)}억)`,
    };
  }

  // 조건 B — 10:00~10:30 value > 09:30~10:00 value (가격 09:31~10:30 유지)
  const w1000_1030 = barsInRange(bars, '10:00', '10:30');
  if (w1000_1030.length < 10) return null;
  const value1000_1030 = sumValue(w1000_1030);
  const w0930_1030 = barsInRange(bars, '09:30', '10:30');
  const priceHoldB = w0930_1030.every((b) => b.close >= m.last0930);
  if (!priceHoldB) return null;
  if (!(value1000_1030 > value0930_1000)) return null;

  const bar1030 = lastBarAtOrBefore(bars, '10:30');
  if (!bar1030 || bar1030.time < '10:15') return null;

  return {
    entryTime: bar1030.time,
    entryPrice: bar1030.close,
    slPct: -2.0,
    tpPct: 5.0,
    exitTime: '15:20',
    reason: `10:00~10:30 value ${(value1000_1030/1e8).toFixed(1)}억 > 09:30~10:00 (${(value0930_1000/1e8).toFixed(1)}억)`,
  };
}

// 4. TEN_SURVIVOR
//   - 10:00 close > 09:30 close
//   - 10:00 close가 09:31~10:00 high 대비 -2% 이내
//   - 09:31~10:00 모든 분봉 low ≥ 09:30 close × 0.99 (기준가 위 유지, 약간 wick 허용)
//   - 09:00~09:30 value ≥ 20억
//   - 진입 10:00 close, TP +5, SL -2.5, 청산 종가
function hypoTenSurvivor(bars, m) {
  if (!m) return null;
  if ((m.value_0930 || 0) < 2e9) return null;

  const bar1000 = lastBarAtOrBefore(bars, '10:00');
  if (!bar1000 || bar1000.time < '09:55') return null;
  if (!(bar1000.close > m.last0930)) return null;

  const w0930_1000 = barsInRange(bars, '09:30', '10:00');
  if (w0930_1000.length < 10) return null;
  const high0930_1000 = maxHigh(w0930_1000);
  if (high0930_1000 <= 0) return null;
  const closeToHighDrop = (bar1000.close / high0930_1000 - 1) * 100;
  if (closeToHighDrop < -2) return null;

  // 기준가 위 유지 (low ≥ 09:30 close × 0.99)
  const baseHold = w0930_1000.every((b) => b.low >= m.last0930 * 0.99);
  if (!baseHold) return null;

  return {
    entryTime: bar1000.time,
    entryPrice: bar1000.close,
    slPct: -2.5,
    tpPct: 5.0,
    exitTime: '15:20',
    reason: `10:00 close 위 유지 (high 대비 ${closeToHighDrop.toFixed(2)}%)`,
  };
}

// 5. MORNING_TREND
//   - 09:30 close > 09:15 close
//   - 10:00 close > 09:30 close
//   - 10:30 close > 10:00 close
//   - 각 구간 저점 상승 : low(09:00~09:15) < low(09:15~09:30) < low(09:30~10:00) < low(10:00~10:30)
//   - 거래대금 유지: 09:30~10:00 value ≥ 09:00~09:30 value × 0.3, 10:00~10:30 value ≥ 09:00~09:30 × 0.3
//   - 진입 10:30 close, TP +5%, SL = 직전 저점 = low(10:00~10:30), 청산 13:00 또는 종가
function hypoMorningTrend(bars, m) {
  if (!m) return null;

  const bar0915 = lastBarAtOrBefore(bars, '09:15');
  const bar0930 = lastBarAtOrBefore(bars, '09:30');
  const bar1000 = lastBarAtOrBefore(bars, '10:00');
  const bar1030 = lastBarAtOrBefore(bars, '10:30');
  if (!bar0915 || !bar0930 || !bar1000 || !bar1030) return null;
  if (bar0915.time < '09:10' || bar1000.time < '09:55' || bar1030.time < '10:25') return null;

  if (!(bar0930.close > bar0915.close)) return null;
  if (!(bar1000.close > bar0930.close)) return null;
  if (!(bar1030.close > bar1000.close)) return null;

  // 구간 저점 — 끝 시점은 inclusive
  const seg1 = barsInRangeInclusive(bars, '09:00', '09:15');
  const seg2 = barsInRange(bars, '09:15', '09:30');
  const seg3 = barsInRange(bars, '09:30', '10:00');
  const seg4 = barsInRange(bars, '10:00', '10:30');
  if (seg1.length === 0 || seg2.length === 0 || seg3.length === 0 || seg4.length === 0) return null;
  const low1 = minLow(seg1), low2 = minLow(seg2), low3 = minLow(seg3), low4 = minLow(seg4);
  if (!(low2 > low1 && low3 > low2 && low4 > low3)) return null;

  // 거래대금 유지
  const v_pre  = m.value_0930;
  const v_seg3 = sumValue(seg3);
  const v_seg4 = sumValue(seg4);
  if (v_seg3 < v_pre * 0.3) return null;
  if (v_seg4 < v_pre * 0.3) return null;

  return {
    entryTime: bar1030.time,
    entryPrice: bar1030.close,
    slPrice: low4,    // 직전 저점 이탈 — 절대가
    slPct: ((low4 / bar1030.close - 1) * 100),  // 표시용
    tpPct: 5.0,
    exitTime: '13:00',
    reason: `09:15→09:30→10:00→10:30 close+low 동시 상승, low4=${low4}`,
  };
}

// ── 성과 측정 ──
// trigger { entryTime, entryPrice, slPct, tpPct, exitTime, slPrice? }
// 진입 시점 직후 분봉부터 exitTime까지 측정. 같은 분봉 안에서 TP/SL 모두 hit하면 보수적으로 SL 우선.
function measurePerf(bars, trig) {
  const after = bars.filter((b) => b && b.time && b.close > 0 && b.time > trig.entryTime && b.time <= trig.exitTime);
  if (after.length === 0) return null;
  const E = trig.entryPrice;
  if (!(E > 0)) return null;

  const tpPrice = E * (1 + trig.tpPct / 100);
  const slPrice = (trig.slPrice && trig.slPrice > 0)
    ? trig.slPrice
    : E * (1 + trig.slPct / 100);

  let maxHi = -Infinity, minLo = Infinity, lastClose = null;
  let outcome = null;   // 'TP' | 'SL' | 'TIMEOUT'
  let outcomePrice = null;
  let outcomeTime = null;
  // 거리 (%)별 도달
  let hit3 = false, hit5 = false, hit7 = false;
  let fail2 = false, fail3 = false;
  // 첫 도달 시점 인덱스 (chronological)
  let hit3Idx = -1, hit5Idx = -1, hit7Idx = -1, fail2Idx = -1, fail3Idx = -1;

  for (let i = 0; i < after.length; i++) {
    const b = after[i];
    if (b.high > maxHi) maxHi = b.high;
    if (b.low  < minLo) minLo = b.low;
    lastClose = b.close;

    if (!outcome) {
      // 보수적 — 같은 분봉 안에 TP/SL 둘 다 hit하면 SL 우선
      const slHit = b.low <= slPrice;
      const tpHit = b.high >= tpPrice;
      if (slHit) { outcome = 'SL'; outcomePrice = slPrice; outcomeTime = b.time; }
      else if (tpHit) { outcome = 'TP'; outcomePrice = tpPrice; outcomeTime = b.time; }
    }

    if (!hit3 && (b.high / E - 1) * 100 >= 3) { hit3 = true; hit3Idx = i; }
    if (!hit5 && (b.high / E - 1) * 100 >= 5) { hit5 = true; hit5Idx = i; }
    if (!hit7 && (b.high / E - 1) * 100 >= 7) { hit7 = true; hit7Idx = i; }
    if (!fail2 && (b.low  / E - 1) * 100 <= -2) { fail2 = true; fail2Idx = i; }
    if (!fail3 && (b.low  / E - 1) * 100 <= -3) { fail3 = true; fail3Idx = i; }
  }

  if (!outcome) {
    outcome = 'TIMEOUT';
    outcomePrice = lastClose;
    outcomeTime = after[after.length - 1].time;
  }

  const realizedReturn = (outcomePrice / E - 1) * 100;
  const maxUp   = (maxHi / E - 1) * 100;
  const maxDown = (minLo / E - 1) * 100;

  return {
    entryTime: trig.entryTime,
    entryPrice: E,
    exitTime: outcomeTime,
    exitPrice: outcomePrice,
    outcome,
    realizedReturn: Number(realizedReturn.toFixed(2)),
    maxUp:   Number(maxUp.toFixed(2)),
    maxDown: Number(maxDown.toFixed(2)),
    hit3, hit5, hit7, fail2, fail3,
    hit3BeforeFail2: hit3Idx >= 0 && (fail2Idx < 0 || hit3Idx < fail2Idx),
    hit5BeforeFail2: hit5Idx >= 0 && (fail2Idx < 0 || hit5Idx < fail2Idx),
  };
}

// ── 통계 ──
function avg(arr)    { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function rate(n, total) { return total > 0 ? Number((n / total * 100).toFixed(1)) : 0; }

function summarize(label, entries, perDayCounts, totalDays) {
  const n = entries.length;
  const perfs = entries.map((e) => e.perf).filter(Boolean);
  if (n === 0 || perfs.length === 0) {
    const zeroDaysRatio = totalDays > 0 ? rate(totalDays - (perDayCounts || []).filter((c) => c > 0).length, totalDays) : 0;
    return { label, n: 0, nWithPerf: 0, perDayAvg: 0, zeroDaysRatio, note: '샘플 없음' };
  }
  const rets = perfs.map((p) => p.realizedReturn);
  const ups  = perfs.map((p) => p.maxUp);
  const dns  = perfs.map((p) => p.maxDown);
  const wins   = perfs.filter((p) => p.realizedReturn > 0).length;
  const losses = perfs.filter((p) => p.realizedReturn < 0).length;
  const zeroDays = totalDays - (perDayCounts || []).filter((c) => c > 0).length;
  return {
    label,
    n,
    nWithPerf: perfs.length,
    perDayAvg:        Number((n / Math.max(1, totalDays)).toFixed(2)),
    avgReturn:        Number(avg(rets).toFixed(2)),
    medianReturn:     Number(median(rets).toFixed(2)),
    winRate:          rate(wins,   perfs.length),
    lossRate:         rate(losses, perfs.length),
    hit3Rate:         rate(perfs.filter((p) => p.hit3).length, perfs.length),
    hit5Rate:         rate(perfs.filter((p) => p.hit5).length, perfs.length),
    hit7Rate:         rate(perfs.filter((p) => p.hit7).length, perfs.length),
    fail2Rate:        rate(perfs.filter((p) => p.fail2).length, perfs.length),
    fail3Rate:        rate(perfs.filter((p) => p.fail3).length, perfs.length),
    avgMaxUp:         Number(avg(ups).toFixed(2)),
    avgMaxDown:       Number(avg(dns).toFixed(2)),
    worstLoss:        Number(Math.min(...rets).toFixed(2)),
    bestWin:          Number(Math.max(...rets).toFixed(2)),
    tpRate:           rate(perfs.filter((p) => p.outcome === 'TP').length, perfs.length),
    slRate:           rate(perfs.filter((p) => p.outcome === 'SL').length, perfs.length),
    timeoutRate:      rate(perfs.filter((p) => p.outcome === 'TIMEOUT').length, perfs.length),
    zeroDaysRatio:    totalDays > 0 ? rate(zeroDays, totalDays) : 0,
    perDayCountsMin:  perDayCounts ? Math.min(...perDayCounts) : 0,
    perDayCountsMax:  perDayCounts ? Math.max(...perDayCounts) : 0,
    perDayCountsMedian: perDayCounts ? Number(median(perDayCounts).toFixed(1)) : 0,
  };
}

// ── 베이스라인용 explosiveTop 판정 ──
function passesExplosive(m) {
  if (!m || !m.rebreakMorningHigh) return false;
  if ((m.closePosition0930 || 0) < 0.85) return false;
  if ((m.value_0930 || 0) < 1e10) return false;
  return true;
}

// ── 차트 캐시 ──
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
function findBaseRow(rows, nextDateNum) {
  if (!Array.isArray(rows)) return null;
  const idx = rows.findIndex((r) => r.date === nextDateNum);
  if (idx < 21) return null;
  return { baseIdx: idx - 1, baseRow: rows[idx - 1] };
}

// ── 일자별 분석 ──
function analyzeDay(dirName, metaMap) {
  const dir = path.join(INTRADAY_BASE, dirName);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;

  const nextDateNum = dirName.replace(/-/g, '');
  // 각 베이스라인/가설별 entries
  const buckets = {
    READY: [], FADED: [], WAIT_PULLBACK: [], WEAK: [],
    explosiveTop: [],
    TEN_REBREAK: [], FADED_RECOVERY: [], SECOND_VALUE_SURGE: [], TEN_SURVIVOR: [], MORNING_TREND: [],
  };

  for (const fname of files) {
    const code = fname.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    if (!meta) continue;

    const rows = loadChartRows(code);
    if (!rows) continue;
    const baseInfo = findBaseRow(rows, nextDateNum);
    if (!baseInfo) continue;
    const baseRow = baseInfo.baseRow;
    if (!baseRow || !(baseRow.close > 0)) continue;

    // avg20 + 유동성
    let sum = 0, cnt = 0;
    for (let i = baseInfo.baseIdx - 20; i < baseInfo.baseIdx; i++) {
      const r = rows[i];
      if (r && r.volume > 0) { sum += (r.valueApprox || 0); cnt++; }
    }
    const avg20 = cnt > 0 ? sum / cnt : 0;
    const baseValue = baseRow.valueApprox || 0;
    const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) continue;

    // 분봉
    let bars = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8'));
      bars = j.bars || [];
    } catch (_) { continue; }
    if (bars.length === 0) continue;

    const m = scanner.computeMetrics0930(bars, baseRow);
    if (!m) continue;
    const status = scanner.classifyStatus(m);

    const entryBase = {
      date: dirName, code, name: meta.name || code,
      marketCap: meta.marketCap,
      status, metrics: m,
    };

    // 베이스라인: 09:30 close 진입, 종가(15:20)까지 측정 — 동일 진입가/청산 기준
    const baselineTrig = {
      entryTime: '09:30', entryPrice: m.last0930,
      slPct: -2.0, tpPct: 5.0, exitTime: '15:20',
    };
    const perfBase = measurePerf(bars, baselineTrig);
    const entryWithBase = { ...entryBase, perf: perfBase };

    if (status === 'READY') buckets.READY.push(entryWithBase);
    if (status === 'FADED') buckets.FADED.push(entryWithBase);
    if (status === 'WAIT_PULLBACK') buckets.WAIT_PULLBACK.push(entryWithBase);
    if (status === 'WEAK') buckets.WEAK.push(entryWithBase);
    if (status === 'READY' && passesExplosive(m)) buckets.explosiveTop.push(entryWithBase);

    // 가설 5종 — 각 가설은 trigger 시점/진입가/청산이 다르므로 perf를 새로 측정
    const hypos = [
      ['TEN_REBREAK',        hypoTenRebreak(bars, m)],
      ['FADED_RECOVERY',     hypoFadedRecovery(bars, m, status)],
      ['SECOND_VALUE_SURGE', hypoSecondValueSurge(bars, m)],
      ['TEN_SURVIVOR',       hypoTenSurvivor(bars, m)],
      ['MORNING_TREND',      hypoMorningTrend(bars, m)],
    ];
    for (const [name, trig] of hypos) {
      if (!trig) continue;
      const perf = measurePerf(bars, trig);
      if (!perf) continue;
      buckets[name].push({
        ...entryBase,
        trig: { entryTime: trig.entryTime, entryPrice: trig.entryPrice, slPct: trig.slPct, tpPct: trig.tpPct, exitTime: trig.exitTime, reason: trig.reason },
        perf,
      });
    }
  }

  return { dirName, totalFiles: files.length, buckets };
}

// ── 추천 결론 빌더 ──
function buildConclusion(summaries) {
  const get = (k) => summaries.find((s) => s.label === k) || null;
  const base = get('explosiveTop');
  const lines = [];
  const recommendations = [];
  const warnings = [];

  // 베이스라인 진입 09:30 close / 청산 15:20 / TP+5 SL-2 — 기준
  const baseAvg = base ? base.avgReturn : null;
  const baseN   = base ? base.n : 0;
  const baseHit5 = base ? base.hit5Rate : null;
  const basePerDay = base ? base.perDayAvg : 0;

  lines.push(`explosiveTop 베이스라인: n=${baseN}, 일평균 ${basePerDay}개, 평균 실현수익 ${baseAvg}%, +5% 도달률 ${baseHit5}%`);

  for (const name of ['TEN_REBREAK', 'FADED_RECOVERY', 'SECOND_VALUE_SURGE', 'TEN_SURVIVOR', 'MORNING_TREND']) {
    const s = get(name);
    if (!s || s.n === 0) {
      warnings.push(`${name}: n=0 — 가설 자체가 너무 빡빡함. 보드 추가 불가.`);
      continue;
    }
    const edge = baseAvg != null && s.avgReturn != null ? Number((s.avgReturn - baseAvg).toFixed(2)) : null;
    const tag = (s.avgReturn > 0 && s.winRate >= 50) ? '⭕'
              : (s.avgReturn > 0 || s.winRate >= 50) ? '🟡' : '❌';
    lines.push(`${tag} ${name}: n=${s.n}, 일평균 ${s.perDayAvg}개, 평균 ${s.avgReturn}%, 승률 ${s.winRate}%, +5% ${s.hit5Rate}%, 최악 ${s.worstLoss}%`);

    // 추천 / 경고 판단
    if (s.avgReturn >= 0.5 && s.winRate >= 50 && s.hit5Rate >= 25 && s.perDayAvg >= 0.3 && s.worstLoss > -10) {
      recommendations.push(`${name}: 평균 ${s.avgReturn}%, 승률 ${s.winRate}%, 일평균 ${s.perDayAvg}개 — 보드 보조 섹션 후보`);
    } else if (s.avgReturn < -1 || s.winRate < 35 || s.worstLoss < -10) {
      warnings.push(`${name}: 평균 ${s.avgReturn}%, 승률 ${s.winRate}%, 최악 ${s.worstLoss}% — 위험. 보드 추가 금지.`);
    }
  }

  const fadedRecov = get('FADED_RECOVERY');
  const fadedMeaningful = fadedRecov && fadedRecov.n >= 5 && fadedRecov.avgReturn > 0 && fadedRecov.winRate >= 50;

  const lateStrategies = ['TEN_REBREAK', 'TEN_SURVIVOR', 'SECOND_VALUE_SURGE', 'MORNING_TREND']
    .map((n) => get(n)).filter((s) => s && s.n >= 5);
  const lateMeaningful = lateStrategies.some((s) => s.avgReturn >= 0.5 && s.winRate >= 50);

  return {
    lines,
    recommendations,
    warnings,
    fadedRecoveryMeaningful: fadedMeaningful,
    lateEntryMeaningful: lateMeaningful,
  };
}

// ── HTML 렌더 ──
function renderHtml(out) {
  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return '-';
    const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
    return `<span class="${cls}">${(v >= 0 ? '+' : '')}${v.toFixed(2)}%</span>`;
  }
  function fmtRate(v) { return v == null ? '-' : v.toFixed(1) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

  function row(s) {
    if (!s || s.n === 0) {
      return `<tr><td><strong>${esc(s ? s.label : '-')}</strong></td><td colspan="14" style="color:#888;text-align:left;">샘플 없음 (n=0, 0-후보 일자 ${s ? s.zeroDaysRatio : 0}%)</td></tr>`;
    }
    return `<tr>
      <td><strong>${esc(s.label)}</strong></td>
      <td class="num">${s.n}</td>
      <td class="num">${s.perDayAvg}</td>
      <td class="num">${fmtPct(s.avgReturn)}</td>
      <td class="num">${fmtPct(s.medianReturn)}</td>
      <td class="num">${fmtRate(s.winRate)}</td>
      <td class="num">${fmtRate(s.lossRate)}</td>
      <td class="num">${fmtRate(s.hit3Rate)}</td>
      <td class="num">${fmtRate(s.hit5Rate)}</td>
      <td class="num">${fmtRate(s.hit7Rate)}</td>
      <td class="num">${fmtRate(s.fail2Rate)}</td>
      <td class="num">${fmtRate(s.fail3Rate)}</td>
      <td class="num">${fmtPct(s.avgMaxUp)}</td>
      <td class="num">${fmtPct(s.avgMaxDown)}</td>
      <td class="num">${fmtPct(s.worstLoss)}</td>
    </tr>`;
  }

  const head = `<thead><tr>
    <th>그룹</th><th>n</th><th>일평균</th>
    <th>평균</th><th>중앙</th>
    <th>승률</th><th>손실률</th>
    <th>+3%</th><th>+5%</th><th>+7%</th>
    <th>-2%</th><th>-3%</th>
    <th>avg ↑</th><th>avg ↓</th><th>worst</th>
  </tr></thead>`;

  const baselineRows = ['explosiveTop', 'READY', 'FADED', 'WAIT_PULLBACK', 'WEAK']
    .map((k) => out.summaries.find((s) => s.label === k))
    .map(row).join('');
  const hypoRows = ['TEN_REBREAK', 'FADED_RECOVERY', 'SECOND_VALUE_SURGE', 'TEN_SURVIVOR', 'MORNING_TREND']
    .map((k) => out.summaries.find((s) => s.label === k))
    .map(row).join('');

  const conclusionLines = out.conclusion.lines.map((l) => `<li>${esc(l)}</li>`).join('');
  const recList = out.conclusion.recommendations.length
    ? out.conclusion.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')
    : '<li style="color:#888;">추천 가설 없음 — 모든 가설이 explosiveTop 대비 명확한 우위를 보이지 못함</li>';
  const warnList = out.conclusion.warnings.length
    ? out.conclusion.warnings.map((w) => `<li>${esc(w)}</li>`).join('')
    : '<li style="color:#888;">위험 가설 없음</li>';

  const datesAnalyzed = out.meta.datesAnalyzed.join(', ');

  // 가설별 trigger 시간 분포 (참고)
  function triggerTimeDistribution(name) {
    const list = (out.entriesByBucket && out.entriesByBucket[name]) || [];
    if (list.length === 0) return '-';
    const times = list.map((e) => e.trig && e.trig.entryTime).filter(Boolean).sort();
    if (times.length === 0) return '-';
    return `${times[0]} ~ ${times[times.length - 1]} (중앙 ${times[Math.floor(times.length / 2)]})`;
  }
  const triggerDist = ['TEN_REBREAK', 'FADED_RECOVERY', 'SECOND_VALUE_SURGE', 'TEN_SURVIVOR', 'MORNING_TREND']
    .map((n) => `<tr><td>${n}</td><td>${triggerTimeDistribution(n)}</td></tr>`).join('');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>1DS 추가 단타 가설 백테스트</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; max-width: 1500px; margin: 0 auto; color: #222; background: #fafafa; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #ddd; }
  h3 { font-size: 14px; margin: 16px 0 6px; color: #444; }
  .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 12px; }
  th, td { border: 1px solid #ddd; padding: 5px 8px; text-align: left; }
  th { background: #f0f0f0; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #c62828; }
  .neg { color: #1565c0; }
  ul { padding-left: 22px; }
  li { margin: 3px 0; font-size: 13px; }
  .summary { background: #fff; padding: 12px 16px; border-radius: 6px; border: 1px solid #e0e0e0; margin-bottom: 18px; }
  .summary strong { color: #d84315; }
  .note { color: #888; font-size: 11px; margin-top: 4px; }
  .hypotheses-table tr:nth-child(odd) td { background: #fafafa; }
</style>
</head>
<body>
<h1>1DS 09:30 스캐너 — 추가 단타 가설 백테스트</h1>
<div class="meta">
  생성: ${out.meta.generatedAt} · 백테스트 대상 일자: ${out.meta.datesAnalyzed.length}일 (${out.meta.datesAnalyzed[0]} ~ ${out.meta.datesAnalyzed[out.meta.datesAnalyzed.length - 1]}) · 소요 ${out.meta.elapsedSec}s
  <div class="note">측정 방식: 베이스라인 = 09:30 close 진입 / 15:20 청산 (TP +5%, SL -2%). 각 가설은 자기 trigger/진입가/SL/청산 시간 사용. 같은 분봉에서 TP·SL 동시 hit 시 보수적으로 SL 우선.</div>
</div>

<div class="summary">
  <h2 style="margin-top:0;border:none;">1. 요약 결론</h2>
  <ul>${conclusionLines}</ul>
  <div style="margin-top:10px;">
    <strong>FADED 회복형 유효:</strong> ${out.conclusion.fadedRecoveryMeaningful ? '⭕ 의미 있음' : '❌ 의미 없음'} ·
    <strong>10시 이후 전략 유효:</strong> ${out.conclusion.lateEntryMeaningful ? '⭕ 의미 있음' : '❌ 의미 없음'}
  </div>
</div>

<h2>2. 가설별 성과 비교표</h2>
<h3>베이스라인 (09:30 close 진입 → 15:20 청산, TP +5% / SL -2%)</h3>
<table class="hypotheses-table">${head}<tbody>${baselineRows}</tbody></table>

<h3>가설 5종 (각자 trigger / 진입가 / 청산 시간 적용)</h3>
<table class="hypotheses-table">${head}<tbody>${hypoRows}</tbody></table>

<h3>가설별 trigger 시간 분포</h3>
<table style="width:auto;"><thead><tr><th>가설</th><th>trigger 시간 범위</th></tr></thead><tbody>${triggerDist}</tbody></table>

<h2>3. explosiveTop 대비 우월한 가설</h2>
<ul>${recList}</ul>

<h2>4. FADED 회복형이 의미 있는가</h2>
<p>${out.conclusion.fadedRecoveryMeaningful
    ? '⭕ FADED_RECOVERY 가설은 표본 ≥5, 평균 수익 > 0, 승률 ≥50% — FADED 풀에서 회복 패턴은 의미 있는 신호. 보드의 보조 섹션 후보로 검토 가능.'
    : '❌ FADED_RECOVERY 가설은 표본 부족 또는 성과 불충분 — FADED 풀은 진입하지 않는 것이 맞다.'}</p>

<h2>5. 10시 이후 전략이 의미 있는가</h2>
<p>${out.conclusion.lateEntryMeaningful
    ? '⭕ 10시 이후 진입 전략 중 최소 하나는 표본 ≥5, 평균 수익 ≥0.5%, 승률 ≥50% — 늦은 진입도 의미 있다. 다만 09:30 EXPLOSIVE 대비 trade-off (진입 시점 늦음, 후보 수 적음) 고려 필요.'
    : '❌ 10시 이후 전략은 모두 표본 부족 또는 성과 미달 — 09:30 시점 EXPLOSIVE에 집중하는 것이 맞다.'}</p>

<h2>6. 보드에 추가할 만한 섹션 추천</h2>
<ul>${recList}</ul>

<h2>7. 추가하지 말아야 할 위험 가설</h2>
<ul>${warnList}</ul>

<div class="note" style="margin-top:30px;border-top:1px dashed #ccc;padding-top:10px;">
  검증 일자: ${esc(datesAnalyzed)}
</div>
</body>
</html>`;
}

// ── main ──
function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(INTRADAY_BASE)) {
    console.error('[ERROR] data/intraday/1ds 디렉토리가 없습니다.');
    process.exit(1);
  }

  console.log('\n📊 1DS 추가 단타 가설 백테스트');
  const t0 = Date.now();

  const metaMap = scanner.loadStockMetaMap();
  console.log(`  메타 로드: ${metaMap.size}건`);

  const allDirs = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  let dirs = allDirs;
  if (args.from) dirs = dirs.filter((d) => d >= args.from);
  if (args.to)   dirs = dirs.filter((d) => d <= args.to);
  dirs = dirs.filter((d) => {
    const n = fs.readdirSync(path.join(INTRADAY_BASE, d)).length;
    return n >= args.minDirSize;
  });
  if (args.days && dirs.length > args.days) {
    dirs = dirs.slice(-args.days);
  }
  applyDaysSuffix(args.days);
  console.log(`  분봉 디렉토리: 전체 ${allDirs.length}개 → 백테스트 대상 ${dirs.length}개 (min-dir-size ${args.minDirSize}${args.days ? `, --days ${args.days}` : ''})`);
  if (dirs.length === 0) {
    console.error('[ERROR] 백테스트 대상 일자 없음.');
    process.exit(1);
  }

  // 일자별 분석
  const perDay = [];
  const totalBuckets = {
    READY: [], FADED: [], WAIT_PULLBACK: [], WEAK: [],
    explosiveTop: [],
    TEN_REBREAK: [], FADED_RECOVERY: [], SECOND_VALUE_SURGE: [], TEN_SURVIVOR: [], MORNING_TREND: [],
  };
  const perDayCounts = {
    READY: [], FADED: [], WAIT_PULLBACK: [], WEAK: [],
    explosiveTop: [],
    TEN_REBREAK: [], FADED_RECOVERY: [], SECOND_VALUE_SURGE: [], TEN_SURVIVOR: [], MORNING_TREND: [],
  };

  for (const dirName of dirs) {
    const day = analyzeDay(dirName, metaMap);
    if (!day) continue;
    perDay.push({ date: dirName, totalFiles: day.totalFiles,
      counts: Object.fromEntries(Object.entries(day.buckets).map(([k, v]) => [k, v.length])) });
    for (const k of Object.keys(totalBuckets)) {
      totalBuckets[k].push(...day.buckets[k]);
      perDayCounts[k].push(day.buckets[k].length);
    }
  }

  const totalDays = perDay.length;
  console.log(`  ✅ 분석 완료: ${totalDays} 거래일`);
  for (const k of Object.keys(totalBuckets)) {
    console.log(`     ${k.padEnd(20)} 총 ${String(totalBuckets[k].length).padStart(5)}건 / 일평균 ${(totalBuckets[k].length / totalDays).toFixed(2)}`);
  }

  // 통계
  const summaries = [];
  for (const k of ['explosiveTop', 'READY', 'FADED', 'WAIT_PULLBACK', 'WEAK',
                   'TEN_REBREAK', 'FADED_RECOVERY', 'SECOND_VALUE_SURGE', 'TEN_SURVIVOR', 'MORNING_TREND']) {
    summaries.push(summarize(k, totalBuckets[k], perDayCounts[k], totalDays));
  }

  const conclusion = buildConclusion(summaries);

  // entries 슬림화 (각 가설은 trigger info 보존)
  const entriesByBucket = {};
  for (const k of ['TEN_REBREAK', 'FADED_RECOVERY', 'SECOND_VALUE_SURGE', 'TEN_SURVIVOR', 'MORNING_TREND']) {
    entriesByBucket[k] = totalBuckets[k].map((e) => ({
      date: e.date, code: e.code, name: e.name,
      status: e.status,
      trig: e.trig,
      perf: e.perf,
    }));
  }

  const out = {
    meta: {
      title: '1DS 09:30 스캐너 — 추가 단타 가설 백테스트',
      generatedAt: new Date().toISOString(),
      datesAnalyzed: dirs,
      totalDays,
      minDirSize: args.minDirSize,
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(2)),
      methodology: '베이스라인 = 09:30 close 진입 / 15:20 청산 (TP +5%, SL -2%). 각 가설은 자체 trigger/진입가/SL/청산. TP·SL 동시 hit 시 SL 우선 (보수적).',
    },
    perDay,
    summaries,
    conclusion,
    entriesByBucket,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, renderHtml(out), 'utf-8');

  console.log(`\n  ⏱ 소요 ${out.meta.elapsedSec}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
  console.log(`\n  📌 결론:`);
  for (const l of conclusion.lines) console.log(`     ${l}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}

module.exports = { main };
