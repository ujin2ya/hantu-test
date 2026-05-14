#!/usr/bin/env node
/**
 * 1DS — 최고의 단타 가설 자동 탐색 (60거래일치 분봉 기반)
 *
 * 단일 가설(explosiveTop / TEN_REBREAK 등)이 19일치 표본에서 한계를 보였기 때문에,
 * 60일치 풀 분봉 데이터로 실제로 오른 종목 vs 실패한 종목을 가르는 조건 조합을 자동 탐색한다.
 *
 * 미래 누수 방지:
 *   - 사전 feature: 09:30 시점까지의 분봉만 사용
 *   - trigger feature: trigger 시점 이전 분봉만 사용 (trigger 시간 자체는 알 수 있는 정보로 표시 가능)
 *   - 성과 측정: 진입 시점 이후 분봉만 사용
 *
 * 입력:
 *   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json (60일 × ~300 종목)
 *   - cache/stock-charts-long/{code}.json (유동성 필터용)
 *   - cache/naver-stocks-list.json (메타)
 *
 * 출력:
 *   - reports/one-day-surge-best-intraday-hypothesis-miner-result.{json,html}
 *
 * 사용:
 *   node boards/oneDaySurge/one-day-surge-best-intraday-hypothesis-miner.js --days 60
 *   node boards/oneDaySurge/one-day-surge-best-intraday-hypothesis-miner.js --from-date 2026-04-01 --to-date 2026-05-14
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-best-intraday-hypothesis-miner-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-best-intraday-hypothesis-miner-result.html');

const scanner = require('./one-day-surge-0930-scanner');

// ── CLI ──
function parseArgs(argv) {
  const a = { from: null, to: null, days: 60, minDirSize: 200, scannerLimit: 300 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from-date' || k === '--from') a.from = argv[++i];
    else if (k === '--to-date' || k === '--to') a.to = argv[++i];
    else if (k === '--days') a.days = parseInt(argv[++i], 10) || 60;
    else if (k === '--scanner-limit') a.scannerLimit = parseInt(argv[++i], 10) || 300;
    else if (k === '--min-dir-size') a.minDirSize = parseInt(argv[++i], 10) || 200;
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node one-day-surge-best-intraday-hypothesis-miner.js [--days 60] [--from-date YYYY-MM-DD] [--to-date YYYY-MM-DD]');
      process.exit(0);
    }
  }
  return a;
}

// ── 분봉 유틸 ──
function barsInRange(bars, fromExc, toInc) {
  return bars.filter((b) => b && b.time && b.close > 0 && b.time > fromExc && b.time <= toInc);
}
function barsInRangeInc(bars, fromInc, toInc) {
  return bars.filter((b) => b && b.time && b.close > 0 && b.time >= fromInc && b.time <= toInc);
}
function lastBarAtOrBefore(bars, t) {
  let r = null;
  for (const b of bars) {
    if (b && b.time && b.close > 0 && b.time <= t) r = b;
    else if (b && b.time > t) break;
  }
  return r;
}
function sumVal(arr) { return arr.reduce((s, b) => s + (b.value || 0), 0); }
function maxHigh(arr) { return arr.length ? Math.max(...arr.map((b) => b.high || 0)) : 0; }
function minLow(arr)  { return arr.length ? Math.min(...arr.map((b) => b.low || Infinity)) : Infinity; }

// ── 사전 feature 추출 ──
// scanner.computeMetrics0930의 결과 m + 추가 sub-window feature
function extractPreFeatures(bars, m, marketCap) {
  if (!m) return null;
  const seg_09_0910 = barsInRangeInc(bars, '09:00', '09:10');
  const seg_0910_0920 = barsInRange(bars, '09:10', '09:20');
  const seg_0920_0930 = barsInRange(bars, '09:20', '09:30');
  const seg_last5 = barsInRange(bars, '09:25', '09:30');  // 09:26~09:30
  const seg_prev5 = barsInRange(bars, '09:20', '09:25');  // 09:21~09:25 (직전 5분 비교용)

  const value_0900_0910 = sumVal(seg_09_0910);
  const value_0910_0920 = sumVal(seg_0910_0920);
  const value_0920_0930 = sumVal(seg_0920_0930);
  const value_ratio_2nd = value_0900_0910 > 0 ? value_0920_0930 / value_0900_0910 : null;

  let cp_0920_0930 = null;
  let highBreak_0920_0930 = false;
  if (seg_0920_0930.length > 0) {
    const hi = maxHigh(seg_0920_0930);
    const lo = minLow(seg_0920_0930);
    const range = hi - lo;
    const last = seg_0920_0930[seg_0920_0930.length - 1];
    cp_0920_0930 = range > 0 ? (last.close - lo) / range : 0.5;
    // 09:20 이전 max high 대비 09:20~09:30 사이 high가 더 큰지
    const max_0900_0920 = Math.max(maxHigh(seg_09_0910), maxHigh(seg_0910_0920));
    highBreak_0920_0930 = hi > max_0900_0920;
  }

  // 직전 5분 (09:25~09:30) 저점 상승 여부 — 단조 증가
  let lowRising_last5 = false;
  if (seg_last5.length >= 3) {
    let prev = null, monotone = true;
    for (const b of seg_last5) {
      if (prev != null && !(b.low > prev)) { monotone = false; break; }
      prev = b.low;
    }
    lowRising_last5 = monotone;
  }
  // 직전 5분 close 상승률
  let closeRise_last5 = null;
  if (seg_last5.length >= 2) {
    const first = seg_last5[0], last = seg_last5[seg_last5.length - 1];
    if (first.close > 0) closeRise_last5 = (last.close / first.close - 1) * 100;
  }
  // 직전 5분 거래대금 증가율 (vs 그 직전 5분)
  let valueIncrease_last5 = null;
  const v_last5 = sumVal(seg_last5);
  const v_prev5 = sumVal(seg_prev5);
  if (v_prev5 > 0) valueIncrease_last5 = v_last5 / v_prev5;

  const valueToMc_0930 = (marketCap > 0) ? m.value_0930 / marketCap : null;

  return {
    // m에서 직접 가져오는 사전 정보
    value_0930: m.value_0930,
    valueToAvgRatio_0930: m.valueToAvgRatio_0930,
    closePosition0930: m.closePosition0930,
    highToLastDrop: m.highToLastDrop,
    openToLastRate: m.openToLastRate,
    rebreakMorningHigh: !!m.rebreakMorningHigh,
    bars_total: m.bars_total,
    last0930: m.last0930,
    high0930: m.high0930,
    // 추가 sub-window feature
    value_0900_0910, value_0910_0920, value_0920_0930,
    value_ratio_2nd,
    cp_0920_0930,
    highBreak_0920_0930,
    lowRising_last5,
    closeRise_last5,
    valueIncrease_last5,
    valueToMc_0930,
  };
}

// ── trigger feature ──
// (rebreakTime, closeRecoveryTime, alive1000, ...)
function extractTriggerFeatures(bars, m) {
  const after0930 = barsInRange(bars, '09:30', '15:30');
  // 09:30 high 재돌파 시간 (첫 번째)
  let rebreakTime = null, rebreakBar = null;
  for (const b of after0930) {
    if (m.high0930 > 0 && b.high > m.high0930) { rebreakTime = b.time; rebreakBar = b; break; }
  }
  // 09:30 close 회복 시간 (첫 번째 close >= m.last0930) — FADED에서만 의미 있음
  let closeRecoveryTime = null;
  for (const b of after0930) {
    if (m.last0930 > 0 && b.close >= m.last0930) { closeRecoveryTime = b.time; break; }
  }
  const rebreakBefore1000 = rebreakTime != null && rebreakTime <= '10:00';
  const rebreakBefore1030 = rebreakTime != null && rebreakTime <= '10:30';
  // 10:00 생존 여부
  const bar1000 = lastBarAtOrBefore(bars, '10:00');
  const alive1000 = bar1000 && bar1000.time >= '09:55' && bar1000.close > m.last0930;

  // trigger 전 -2% 터치 여부
  let trigger_preFail2 = null;
  if (rebreakTime) {
    const pre = barsInRange(bars, '09:30', rebreakTime);
    trigger_preFail2 = pre.some((b) => m.last0930 > 0 && (b.low / m.last0930 - 1) * 100 <= -2);
  }
  // trigger 후 5분 고점 추가 갱신
  let trigger_followupHigh5 = null;
  let trigger_followupValue5 = null;
  let trigger_after10min_aboveTrigger = null;
  if (rebreakTime && rebreakBar) {
    const post5 = after0930.filter((b) => b.time > rebreakTime && b.time <= addMinStr(rebreakTime, 5));
    const post10bar = after0930.find((b) => b.time === addMinStr(rebreakTime, 10)) ||
                       lastBarAtOrBefore(after0930, addMinStr(rebreakTime, 10));
    trigger_followupHigh5 = post5.some((b) => b.high > rebreakBar.high);
    // followupValue: post5 거래대금 합 > rebreak 직전 5분 거래대금 합
    const pre5 = after0930.filter((b) => b.time > addMinStr(rebreakTime, -5) && b.time <= rebreakTime);
    const v_post5 = sumVal(post5);
    const v_pre5  = sumVal(pre5);
    trigger_followupValue5 = v_pre5 > 0 && v_post5 > v_pre5;
    trigger_after10min_aboveTrigger = post10bar ? post10bar.close > m.high0930 : null;
  }
  // trigger price = m.high0930 (09:30 high)
  return {
    rebreakTime, rebreakPrice: rebreakTime ? m.high0930 : null,
    closeRecoveryTime,
    rebreakBefore1000, rebreakBefore1030,
    alive1000: alive1000 == null ? null : !!alive1000,
    trigger_preFail2, trigger_followupHigh5, trigger_followupValue5,
    trigger_after10min_aboveTrigger,
  };
}
function addMinStr(t, delta) {
  // t = "HH:MM", returns same format with delta minutes added (clamped 00:00~23:59)
  const [h, m] = t.split(':').map(Number);
  let mins = h * 60 + m + delta;
  if (mins < 0) mins = 0;
  if (mins > 23 * 60 + 59) mins = 23 * 60 + 59;
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}

// ── 성과 측정 ──
// 7 전략 결과를 한 번에 계산. 각 strategy { entered, realizedReturn, ... }
function measureAllStrategies(bars, m, trigF) {
  const after0930 = barsInRange(bars, '09:30', '15:30');
  const E_0930 = m.last0930;
  const E_trig = m.high0930;

  // 공통 — 09:31~15:30 분봉으로 hit/fail/MFE/MAE 추적
  const trackBars = (bs, E) => {
    if (!(E > 0) || bs.length === 0) return null;
    let maxHi = -Infinity, minLo = Infinity, lastClose = null;
    let hit3 = null, hit5 = null, hit7 = null, hit10 = null;
    let fail2 = null, fail3 = null, fail5 = null;
    for (const b of bs) {
      if (b.high > maxHi) maxHi = b.high;
      if (b.low  < minLo) minLo = b.low;
      lastClose = b.close;
      if (!hit3  && (b.high/E - 1) * 100 >= 3)  hit3  = b.time;
      if (!hit5  && (b.high/E - 1) * 100 >= 5)  hit5  = b.time;
      if (!hit7  && (b.high/E - 1) * 100 >= 7)  hit7  = b.time;
      if (!hit10 && (b.high/E - 1) * 100 >= 10) hit10 = b.time;
      if (!fail2 && (b.low /E - 1) * 100 <= -2) fail2 = b.time;
      if (!fail3 && (b.low /E - 1) * 100 <= -3) fail3 = b.time;
      if (!fail5 && (b.low /E - 1) * 100 <= -5) fail5 = b.time;
    }
    return {
      maxHi, minLo, lastClose,
      mfe: maxHi !== -Infinity ? (maxHi/E - 1) * 100 : null,
      mae: minLo !== Infinity ? (minLo/E - 1) * 100 : null,
      closeRet: (lastClose/E - 1) * 100,
      hit3, hit5, hit7, hit10, fail2, fail3, fail5,
    };
  };

  // 분봉 안에서 TP·SL chronological 시뮬
  const simStrategy = (bs, E, tpPct, slPct) => {
    if (!(E > 0) || bs.length === 0) return { entered: false };
    const tpPrice = E * (1 + tpPct / 100);
    const slPrice = E * (1 + slPct / 100);
    let outcome = null, outcomePrice = null, outcomeTime = null;
    let lastClose = null;
    for (const b of bs) {
      lastClose = b.close;
      const slHit = b.low <= slPrice;
      const tpHit = b.high >= tpPrice;
      if (slHit)      { outcome = 'SL'; outcomePrice = slPrice; outcomeTime = b.time; break; }
      else if (tpHit) { outcome = 'TP'; outcomePrice = tpPrice; outcomeTime = b.time; break; }
    }
    if (!outcome) { outcome = 'TIMEOUT'; outcomePrice = lastClose; outcomeTime = bs[bs.length - 1].time; }
    return { entered: true, outcome, outcomePrice, outcomeTime, realizedReturn: (outcomePrice/E - 1) * 100 };
  };

  // S1~S4: 09:30 진입
  const track0930 = trackBars(after0930, E_0930);
  const aliveAt1000 = (() => {
    const b = lastBarAtOrBefore(bars, '10:00');
    return b && b.time >= '09:55' && b.close > E_0930;
  })();

  const s1 = simStrategy(after0930, E_0930, 5, -2);
  const s2 = simStrategy(after0930, E_0930, 10, -3);
  const s3 = simStrategy(after0930, E_0930, 7, -2.5);
  // S4: 10시 생존 시 종가 보유, 아니면 10시 청산
  let s4;
  if (after0930.length === 0 || !(E_0930 > 0)) {
    s4 = { entered: false };
  } else {
    const b1000 = lastBarAtOrBefore(bars, '10:00');
    if (!b1000) {
      s4 = { entered: true, outcome: 'HOLD_TO_CLOSE', realizedReturn: track0930 ? track0930.closeRet : 0 };
    } else if (b1000.close > E_0930) {
      s4 = { entered: true, outcome: 'HOLD_TO_CLOSE', realizedReturn: track0930.closeRet };
    } else {
      s4 = { entered: true, outcome: 'EXIT_1000', realizedReturn: (b1000.close/E_0930 - 1) * 100 };
    }
  }

  // T1/T2: trigger 진입 (rebreakTime 이후 분봉, 진입가 = m.high0930)
  let t1 = { entered: false }, t2 = { entered: false }, t3 = { entered: false };
  if (trigF.rebreakTime) {
    const afterTrig = bars.filter((b) => b && b.time && b.close > 0 && b.time > trigF.rebreakTime);
    t1 = simStrategy(afterTrig, E_trig, 5, -2);
    t2 = simStrategy(afterTrig, E_trig, 10, -3);
    // T3: trigger 품질 확인 후 (followupHigh5 OR followupValue5) 시 진입, T+5 close 진입가
    if (trigF.trigger_followupHigh5 || trigF.trigger_followupValue5) {
      const t3EntryTime = addMinStr(trigF.rebreakTime, 5);
      const entryBar = lastBarAtOrBefore(bars, t3EntryTime);
      if (entryBar) {
        const E_t3 = entryBar.close;
        const afterT3 = bars.filter((b) => b.time > entryBar.time);
        t3 = simStrategy(afterT3, E_t3, 5, -2);
        if (t3.entered) t3.entryPrice_t3 = E_t3;
      }
    }
  }

  return {
    track0930, aliveAt1000,
    S1: s1, S2: s2, S3: s3, S4: s4,
    T1: t1, T2: t2, T3: t3,
  };
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

// ── 통계 헬퍼 ──
function avg(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function rate(n, t) { return t > 0 ? Number((n / t * 100).toFixed(1)) : 0; }
function pct(v, d) { return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d == null ? 2 : d)); }

// ── 가설 평가 ──
// entries: 모든 종목-일의 features + perfs
// hypothesis: { name, label, predicate(entry) -> bool, strategy }
// strategy: 'S1'|'S2'|'S3'|'S4'|'T1'|'T2'|'T3'
function evaluateHypothesis(entries, hypothesis, totalDays, missed10Set, expTopSet, iSet) {
  const filtered = entries.filter((e) => hypothesis.predicate(e));
  const stratKey = hypothesis.strategy;
  const withPerf = filtered.filter((e) => e.perf && e.perf[stratKey] && e.perf[stratKey].entered);
  const n = withPerf.length;
  if (n === 0) return { n: 0, label: hypothesis.label, name: hypothesis.name, strategy: stratKey };

  const rets = withPerf.map((e) => e.perf[stratKey].realizedReturn);
  const track = withPerf.map((e) => e.perf.track0930).filter(Boolean);
  const mfes = track.map((t) => t.mfe).filter((x) => x != null);
  const maes = track.map((t) => t.mae).filter((x) => x != null);
  const closeRets = track.map((t) => t.closeRet).filter((x) => x != null);

  const hit3   = track.filter((t) => t.hit3).length;
  const hit5   = track.filter((t) => t.hit5).length;
  const hit7   = track.filter((t) => t.hit7).length;
  const hit10  = track.filter((t) => t.hit10).length;
  const fail2  = track.filter((t) => t.fail2).length;
  const fail3  = track.filter((t) => t.fail3).length;
  const fail5  = track.filter((t) => t.fail5).length;
  const firstHit5BeforeFail2 = track.filter((t) => t.hit5 && (!t.fail2 || t.hit5 < t.fail2)).length;
  const firstHit10BeforeFail3 = track.filter((t) => t.hit10 && (!t.fail3 || t.hit10 < t.fail3)).length;
  const closePos = closeRets.filter((r) => r > 0).length;
  const alive1000 = withPerf.filter((e) => e.perf.aliveAt1000).length;

  // 일별 후보 수
  const perDay = new Map();
  for (const e of filtered) perDay.set(e.date, (perDay.get(e.date) || 0) + 1);
  const perDayCounts = [...perDay.values()];
  const zeroDays = totalDays - perDayCounts.filter((c) => c > 0).length;

  // 중복 / recall / precision
  const keys = new Set(filtered.map((e) => e.date + '|' + e.code));
  const expDup = [...keys].filter((k) => expTopSet.has(k)).length;
  const iDup   = [...keys].filter((k) => iSet.has(k)).length;
  const winnerHit = [...keys].filter((k) => missed10Set.has(k)).length;

  return {
    name: hypothesis.name, label: hypothesis.label, strategy: stratKey,
    n,
    perDayAvg:   pct(filtered.length / Math.max(1, totalDays), 2),
    perDayMedian: pct(median(perDayCounts) || 0, 1),
    avgReturn:   pct(avg(rets), 2),
    medianReturn:pct(median(rets), 2),
    winRate:     rate(rets.filter((r) => r > 0).length, n),
    lossRate:    rate(rets.filter((r) => r < 0).length, n),
    hit3Rate:    rate(hit3, track.length),
    hit5Rate:    rate(hit5, track.length),
    hit7Rate:    rate(hit7, track.length),
    hit10Rate:   rate(hit10, track.length),
    fail2Rate:   rate(fail2, track.length),
    fail3Rate:   rate(fail3, track.length),
    fail5Rate:   rate(fail5, track.length),
    firstHit5BeforeFail2Rate:  rate(firstHit5BeforeFail2, track.length),
    firstHit10BeforeFail3Rate: rate(firstHit10BeforeFail3, track.length),
    avgMfe:      pct(avg(mfes), 2),
    avgMae:      pct(avg(maes), 2),
    worstLoss:   pct(Math.min(...rets), 2),
    bestWin:     pct(Math.max(...rets), 2),
    closePosRate: rate(closePos, closeRets.length),
    alive1000Rate: rate(alive1000, n),
    zeroDaysRate: rate(zeroDays, totalDays),
    expTopOverlap:  expDup,
    expTopOverlapRate: rate(expDup, n),
    iCondOverlap:    iDup,
    iCondOverlapRate: rate(iDup, n),
    winnerRecall:    pct(rate(winnerHit, missed10Set.size || 1), 1),    // 잡힌 +10% winner / 전체 +10% winner
    winnerPrecision: pct(rate(winnerHit, keys.size || 1), 1),           // 잡힌 +10% winner / 이 가설의 후보 수
  };
}

// ── 랭킹 스코어 (사용자 명시) ──
function rankScore(s) {
  if (!s || s.n === 0) return -Infinity;
  return (s.avgReturn || 0) * 2
       + (s.winRate || 0) * 0.03
       + (s.hit10Rate || 0) * 0.08
       + (s.hit5Rate || 0) * 0.03
       - (s.fail3Rate || 0) * 0.05
       - Math.abs((s.perDayAvg || 0) - 7) * 0.08
       - Math.max(0, (s.zeroDaysRate || 0) - 30) * 0.05;
}

// 기본 통과 조건
function passesBasicGate(s, readyHit10Rate) {
  if (!s || s.n < 80) return false;
  if (s.perDayAvg < 2 || s.perDayAvg > 20) return false;
  if (s.avgReturn == null || s.avgReturn < 0.7) return false;
  if (s.medianReturn != null && s.medianReturn < -1.5) return false;
  if (s.hit10Rate != null && readyHit10Rate != null && s.hit10Rate < readyHit10Rate) return false;  // precision 측면: READY 전체 +10% 도달률보다 높을 것
  if (s.fail3Rate != null && s.fail3Rate > 60) return false;
  if (s.zeroDaysRate != null && s.zeroDaysRate > 50) return false;
  return true;
}

// ── 가설 카탈로그 생성 ──
function generateHypothesisCatalog() {
  // helper for label
  const moneyL = (v) => v >= 1e10 ? (v/1e10).toFixed(0)+'백억' : v >= 1e8 ? (v/1e8).toFixed(0)+'억' : v;
  const list = [];

  // ── A. 단일 feature bucket ──
  // status
  for (const st of ['READY', 'FADED', 'WEAK', 'WAIT_PULLBACK']) {
    list.push({ name: `status_${st}`, label: `${st} 전체`, predicate: (e) => e.status === st });
  }
  // value_0930 bucket
  const valBins = [
    { name: 'val_lt10', label: '거래대금 <10억', lo: 0,    hi: 1e9 },
    { name: 'val_10_30', label: '거래대금 10~30억', lo: 1e9, hi: 3e9 },
    { name: 'val_30_50', label: '거래대금 30~50억', lo: 3e9, hi: 5e9 },
    { name: 'val_50_100', label: '거래대금 50~100억', lo: 5e9, hi: 1e10 },
    { name: 'val_ge100',  label: '거래대금 ≥100억', lo: 1e10, hi: Infinity },
  ];
  for (const v of valBins) list.push({ name: v.name, label: v.label,
    predicate: (e) => (e.f.value_0930 || 0) >= v.lo && (e.f.value_0930 || 0) < v.hi });
  // valueToAvgRatio
  for (const r of [{n:'ratio_lt3',l:'v/avg <3',lo:0,hi:3},{n:'ratio_3_5',l:'v/avg 3~5',lo:3,hi:5},{n:'ratio_5_10',l:'v/avg 5~10',lo:5,hi:10},{n:'ratio_ge10',l:'v/avg ≥10',lo:10,hi:1e9}]) {
    list.push({ name: r.n, label: r.l, predicate: (e) => (e.f.valueToAvgRatio_0930 || 0) >= r.lo && (e.f.valueToAvgRatio_0930 || 0) < r.hi });
  }
  // closePosition
  for (const c of [{n:'cp_lt05',l:'cp <0.50',lo:0,hi:0.5},{n:'cp_05_07',l:'cp 0.5~0.7',lo:0.5,hi:0.7},{n:'cp_07_085',l:'cp 0.7~0.85',lo:0.7,hi:0.85},{n:'cp_ge085',l:'cp ≥0.85',lo:0.85,hi:1.01}]) {
    list.push({ name: c.n, label: c.l, predicate: (e) => (e.f.closePosition0930 || 0) >= c.lo && (e.f.closePosition0930 || 0) < c.hi });
  }
  // highToLastDrop
  for (const d of [{n:'drop_ge_n1',l:'drop ≥-1%',lo:-1,hi:0.1},{n:'drop_n1_n25',l:'drop -1~-2.5%',lo:-2.5,hi:-1},{n:'drop_n25_n5',l:'drop -2.5~-5%',lo:-5,hi:-2.5},{n:'drop_lt_n5',l:'drop <-5%',lo:-100,hi:-5}]) {
    list.push({ name: d.n, label: d.l, predicate: (e) => e.f.highToLastDrop != null && e.f.highToLastDrop >= d.lo && e.f.highToLastDrop < d.hi });
  }
  // openToLastRate
  for (const o of [{n:'open_lt0',l:'open<0%',lo:-100,hi:0},{n:'open_0_1',l:'open 0~1%',lo:0,hi:1},{n:'open_1_3',l:'open 1~3%',lo:1,hi:3},{n:'open_3_5',l:'open 3~5%',lo:3,hi:5},{n:'open_5_8',l:'open 5~8%',lo:5,hi:8},{n:'open_ge8',l:'open ≥8%',lo:8,hi:1e3}]) {
    list.push({ name: o.n, label: o.l, predicate: (e) => e.f.openToLastRate != null && e.f.openToLastRate >= o.lo && e.f.openToLastRate < o.hi });
  }
  // marketCap
  for (const mc of [{n:'mc_lt1000',l:'시총 <1000억',lo:0,hi:1e11},{n:'mc_1_3',l:'시총 1000억~3000억',lo:1e11,hi:3e11},{n:'mc_3_1조',l:'시총 3000억~1조',lo:3e11,hi:1e12},{n:'mc_1_3조',l:'시총 1~3조',lo:1e12,hi:3e12},{n:'mc_ge3조',l:'시총 ≥3조',lo:3e12,hi:1e13}]) {
    list.push({ name: mc.n, label: mc.l, predicate: (e) => e.marketCap >= mc.lo && e.marketCap < mc.hi });
  }
  // valueToMc
  for (const v of [{n:'vmc_lt05',l:'v/mc <0.5%',lo:0,hi:0.005},{n:'vmc_05_2',l:'v/mc 0.5~2%',lo:0.005,hi:0.02},{n:'vmc_2_5',l:'v/mc 2~5%',lo:0.02,hi:0.05},{n:'vmc_ge5',l:'v/mc ≥5%',lo:0.05,hi:1}]) {
    list.push({ name: v.n, label: v.l, predicate: (e) => e.f.valueToMc_0930 != null && e.f.valueToMc_0930 >= v.lo && e.f.valueToMc_0930 < v.hi });
  }
  // value_ratio_2nd (2차 거래대금 유입)
  for (const v of [{n:'v2nd_ge1',l:'9:20~9:30 거래대금 ≥ 9:00~9:10 동일',lo:1,hi:1e9},{n:'v2nd_ge2',l:'9:20~9:30 거래대금 ≥ 2× 9:00~9:10',lo:2,hi:1e9},{n:'v2nd_lt05',l:'9:20~9:30 거래대금 <50% of 9:00~9:10',lo:0,hi:0.5}]) {
    list.push({ name: v.n, label: v.l, predicate: (e) => e.f.value_ratio_2nd != null && e.f.value_ratio_2nd >= v.lo && e.f.value_ratio_2nd < v.hi });
  }
  // rebreakMorningHigh
  list.push({ name: 'mh_yes', label: '첫 10분 고점 재돌파 ✓', predicate: (e) => e.f.rebreakMorningHigh });
  list.push({ name: 'mh_no',  label: '첫 10분 고점 재돌파 ✗', predicate: (e) => !e.f.rebreakMorningHigh });
  // lowRising_last5
  list.push({ name: 'lowrise5_yes', label: '직전 5분 저점 단조 상승', predicate: (e) => e.f.lowRising_last5 });
  // closeRise_last5
  list.push({ name: 'closerise5_ge0', label: '직전 5분 close 상승 (≥0%)', predicate: (e) => e.f.closeRise_last5 != null && e.f.closeRise_last5 >= 0 });
  // valueIncrease_last5
  list.push({ name: 'val_inc_last5_ge15', label: '직전 5분 거래대금 ≥ 직전5(09:20~25) ×1.5', predicate: (e) => e.f.valueIncrease_last5 != null && e.f.valueIncrease_last5 >= 1.5 });
  // highBreak_0920_0930
  list.push({ name: 'high_break_0920_0930', label: '09:20~09:30 신고점 갱신', predicate: (e) => e.f.highBreak_0920_0930 });
  // cp_0920_0930
  list.push({ name: 'cp_0920_0930_ge07', label: '09:20~09:30 내부 종가 위치 ≥0.7', predicate: (e) => e.f.cp_0920_0930 != null && e.f.cp_0920_0930 >= 0.7 });

  // ── B. 2개 조합 ──
  // status × closePosition
  for (const st of ['READY', 'FADED', 'WEAK']) {
    list.push({ name: `${st}_cp_ge07`, label: `${st} + cp≥0.70`, predicate: (e) => e.status === st && (e.f.closePosition0930 || 0) >= 0.7 });
    list.push({ name: `${st}_cp_ge085`, label: `${st} + cp≥0.85`, predicate: (e) => e.status === st && (e.f.closePosition0930 || 0) >= 0.85 });
    list.push({ name: `${st}_mh`, label: `${st} + MH재돌파 ✓`, predicate: (e) => e.status === st && e.f.rebreakMorningHigh });
    list.push({ name: `${st}_ratio_ge5`, label: `${st} + v/avg ≥5`, predicate: (e) => e.status === st && (e.f.valueToAvgRatio_0930 || 0) >= 5 });
    list.push({ name: `${st}_val_ge50`, label: `${st} + 거래대금 ≥50억`, predicate: (e) => e.status === st && (e.f.value_0930 || 0) >= 5e9 });
    list.push({ name: `${st}_vmc_ge2`, label: `${st} + v/mc ≥2%`, predicate: (e) => e.status === st && (e.f.valueToMc_0930 || 0) >= 0.02 });
    list.push({ name: `${st}_2ndsurge`, label: `${st} + 9:20~9:30 거래대금 ≥2× 9:00~9:10`, predicate: (e) => e.status === st && (e.f.value_ratio_2nd || 0) >= 2 });
    list.push({ name: `${st}_highbreak`, label: `${st} + 9:20~9:30 신고점 갱신`, predicate: (e) => e.status === st && e.f.highBreak_0920_0930 });
    list.push({ name: `${st}_lowrise5`, label: `${st} + 직전 5분 저점 상승`, predicate: (e) => e.status === st && e.f.lowRising_last5 });
  }
  // valueToMc + drop
  list.push({ name: 'vmc_ge2_drop_ge_n2', label: 'v/mc ≥2% + drop ≥-2%', predicate: (e) => (e.f.valueToMc_0930 || 0) >= 0.02 && e.f.highToLastDrop != null && e.f.highToLastDrop >= -2 });
  // FADED + 10시 생존 (trigger 기반 — trigger 시점 이후 정보지만 알려진다 가정)
  list.push({ name: 'FADED_alive1000', label: 'FADED + 10시 생존', predicate: (e) => e.status === 'FADED' && e.perf.aliveAt1000, strategy: 'S4' });
  list.push({ name: 'WEAK_alive1000',  label: 'WEAK + 10시 생존',  predicate: (e) => e.status === 'WEAK'  && e.perf.aliveAt1000, strategy: 'S4' });
  list.push({ name: 'READY_alive1000', label: 'READY + 10시 생존', predicate: (e) => e.status === 'READY' && e.perf.aliveAt1000, strategy: 'S4' });

  // ── C. 3개 조합 ──
  list.push({ name: 'READY_cp085_ratio5', label: 'READY + cp≥0.85 + v/avg≥5', predicate: (e) => e.status === 'READY' && (e.f.closePosition0930 || 0) >= 0.85 && (e.f.valueToAvgRatio_0930 || 0) >= 5 });
  list.push({ name: 'READY_mh_val100', label: 'READY + MH재돌파 + 거래대금≥100억', predicate: (e) => e.status === 'READY' && e.f.rebreakMorningHigh && (e.f.value_0930 || 0) >= 1e10 });
  list.push({ name: 'READY_cp085_vmc05', label: 'READY + cp≥0.85 + v/mc≥0.5%', predicate: (e) => e.status === 'READY' && (e.f.closePosition0930 || 0) >= 0.85 && (e.f.valueToMc_0930 || 0) >= 0.005 });
  list.push({ name: 'READY_2ndsurge_highbreak', label: 'READY + 9:20~9:30 2차 거래대금 + 신고점', predicate: (e) => e.status === 'READY' && (e.f.value_ratio_2nd || 0) >= 1.5 && e.f.highBreak_0920_0930 });
  list.push({ name: 'FADED_closerecov_alive', label: 'FADED + 09:30 close 회복 + 10시 생존', predicate: (e) => e.status === 'FADED' && e.f.closeRecoveryTime != null && e.f.closeRecoveryTime <= '10:00' && e.perf.aliveAt1000, strategy: 'S4' });
  list.push({ name: 'WEAK_2ndsurge_recov', label: 'WEAK + 2차 거래대금 + 기준가 회복', predicate: (e) => e.status === 'WEAK' && (e.f.value_ratio_2nd || 0) >= 1.5 && e.f.closeRecoveryTime != null && e.f.closeRecoveryTime <= '10:00', strategy: 'S4' });
  list.push({ name: 'READY_mh_vmc2', label: 'READY + MH재돌파 + v/mc≥2%', predicate: (e) => e.status === 'READY' && e.f.rebreakMorningHigh && (e.f.valueToMc_0930 || 0) >= 0.02 });
  list.push({ name: 'READY_drop_ge_n1_ratio5', label: 'READY + drop ≥-1% + v/avg≥5', predicate: (e) => e.status === 'READY' && e.f.highToLastDrop != null && e.f.highToLastDrop >= -1 && (e.f.valueToAvgRatio_0930 || 0) >= 5 });

  // ── D. Trigger 기반 ──
  // 09:30 high 재돌파 (= rebreakBefore1030 trigger)
  list.push({ name: 'T_rebreak', label: '09:30 high 재돌파 (10:30 전)', predicate: (e) => e.f.rebreakBefore1030, strategy: 'T1' });
  list.push({ name: 'T_rebreak_S2', label: '09:30 high 재돌파 +10/-3', predicate: (e) => e.f.rebreakBefore1030, strategy: 'T2' });
  list.push({ name: 'T_rebreak_nofail2', label: '재돌파 + trigger 전 -2% 미터치', predicate: (e) => e.f.rebreakBefore1030 && e.f.trigger_preFail2 === false, strategy: 'T1' });
  list.push({ name: 'T_rebreak_followup_high', label: '재돌파 + 후속 5분 고점 추가 갱신', predicate: (e) => e.f.rebreakBefore1030 && e.f.trigger_followupHigh5, strategy: 'T1' });
  list.push({ name: 'T_rebreak_followup_value', label: '재돌파 + 후속 5분 거래대금 증가', predicate: (e) => e.f.rebreakBefore1030 && e.f.trigger_followupValue5, strategy: 'T1' });
  list.push({ name: 'T_rebreak_alive1000', label: '재돌파 + 10시 생존', predicate: (e) => e.f.rebreakBefore1030 && e.perf.aliveAt1000, strategy: 'T1' });
  list.push({ name: 'T_rebreak_quality_T3', label: '재돌파 + 품질 확인 후 진입(T3)', predicate: (e) => e.f.rebreakBefore1030 && (e.f.trigger_followupHigh5 || e.f.trigger_followupValue5), strategy: 'T3' });
  list.push({ name: 'T_rebreak_after10_above', label: '재돌파 + 10분 후 trigger 위 유지', predicate: (e) => e.f.rebreakBefore1030 && e.f.trigger_after10min_aboveTrigger === true, strategy: 'T1' });

  // FADED_RECOVERY (= FADED + closeRecovery + rebreak by 10:30)
  list.push({ name: 'FADED_RECOVERY', label: 'FADED + close 회복 + 재돌파', predicate: (e) => e.status === 'FADED' && e.f.closeRecoveryTime != null && e.f.closeRecoveryTime <= '10:00' && e.f.rebreakBefore1030, strategy: 'T1' });
  list.push({ name: 'WEAK_RECOVERY', label: 'WEAK + close 회복 + 재돌파', predicate: (e) => e.status === 'WEAK' && e.f.closeRecoveryTime != null && e.f.closeRecoveryTime <= '10:00' && e.f.rebreakBefore1030, strategy: 'T1' });

  // 기존 I 조건 + 비교
  list.push({ name: 'I_condition', label: '[기존] I 조건 (TEN_REBREAK 동시충족)', predicate: (e) => isIcondition(e), strategy: 'S1' });
  list.push({ name: 'I_condition_S2', label: '[기존] I 조건 × S2 (+10/-3)', predicate: (e) => isIcondition(e), strategy: 'S2' });
  list.push({ name: 'explosiveTop', label: '[기존] explosiveTop', predicate: (e) => isExplosiveTop(e), strategy: 'S1' });
  list.push({ name: 'explosiveTop_S2', label: '[기존] explosiveTop × S2', predicate: (e) => isExplosiveTop(e), strategy: 'S2' });
  list.push({ name: 'TEN_REBREAK', label: '[기존] TEN_REBREAK 단독', predicate: (e) => e.f.rebreakBefore1030 && (e.f.value_0930 || 0) >= 1e9 && e.f.highToLastDrop != null && e.f.highToLastDrop >= -4, strategy: 'T1' });
  list.push({ name: 'READY_all', label: '[기존] READY 전체', predicate: (e) => e.status === 'READY', strategy: 'S1' });

  // 기본 strategy = S1 (single feature buckets는 S1로)
  for (const h of list) if (!h.strategy) h.strategy = 'S1';
  return list;
}

function isExplosiveTop(e) {
  if (!e.f.rebreakMorningHigh) return false;
  if ((e.f.closePosition0930 || 0) < 0.85) return false;
  if ((e.f.value_0930 || 0) < 1e10) return false;
  return e.status === 'READY';
}
function isIcondition(e) {
  const f = e.f;
  if ((f.value_0930 || 0) < 2.1e9) return false;
  if ((f.closePosition0930 || 0) < 0.50) return false;
  if (f.highToLastDrop == null || f.highToLastDrop < -2.70) return false;
  if (f.openToLastRate == null || f.openToLastRate < 0.50) return false;
  if ((f.valueToAvgRatio_0930 || 0) < 3) return false;
  if (!f.rebreakMorningHigh) return false;
  if (e.status !== 'READY' && e.status !== 'FADED') return false;
  if (!(e.marketCap > 0) || e.marketCap > 5e12) return false;
  return f.rebreakBefore1030;  // TEN_REBREAK trigger
}

// ── main ──
function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log('\n🔍 1DS 최고의 단타 가설 자동 탐색');
  const t0 = Date.now();

  const metaMap = scanner.loadStockMetaMap();
  console.log(`  메타: ${metaMap.size}건`);

  // 거래일 결정
  let dirs = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => fs.readdirSync(path.join(INTRADAY_BASE, d)).length >= args.minDirSize)
    .sort();
  if (args.from) dirs = dirs.filter((d) => d >= args.from);
  if (args.to)   dirs = dirs.filter((d) => d <= args.to);
  if (args.days && dirs.length > args.days) dirs = dirs.slice(-args.days);
  console.log(`  대상 거래일: ${dirs.length}일 (${dirs[0]} ~ ${dirs[dirs.length-1]})`);
  if (dirs.length === 0) { console.error('[ERROR] 대상 일자 0건'); process.exit(1); }

  // 모든 종목-일 entries 빌드
  console.log(`  종목-일 entry 빌드 중...`);
  const entries = [];
  for (const dirName of dirs) {
    const dir = path.join(INTRADAY_BASE, dirName);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const nextDateNum = dirName.replace(/-/g, '');
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
      let sum = 0, n = 0;
      for (let i = baseInfo.baseIdx - 20; i < baseInfo.baseIdx; i++) {
        const r = rows[i];
        if (r && r.volume > 0) { sum += (r.valueApprox || 0); n++; }
      }
      const avg20 = n > 0 ? sum / n : 0;
      const baseValue = baseRow.valueApprox || 0;
      const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
      if (!liq.ok) continue;
      let bars = null;
      try { bars = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8')).bars || []; }
      catch (_) { continue; }
      if (bars.length === 0) continue;
      const m = scanner.computeMetrics0930(bars, baseRow);
      if (!m) continue;
      const status = scanner.classifyStatus(m);
      const f = extractPreFeatures(bars, m, meta.marketCap || 0);
      const trigF = extractTriggerFeatures(bars, m);
      const perf = measureAllStrategies(bars, m, trigF);
      entries.push({
        date: dirName, code,
        name: meta.name || code,
        marketCap: meta.marketCap || 0,
        status,
        f: { ...f, ...trigF },
        perf,
      });
    }
  }
  console.log(`  ✅ entries: ${entries.length}건 (일평균 ${(entries.length/dirs.length).toFixed(0)})`);

  // +10% (vs 09:30 close) winner set 계산
  const winner10Keys = new Set();
  for (const e of entries) {
    if (e.perf.track0930 && e.perf.track0930.hit10) winner10Keys.add(e.date + '|' + e.code);
  }
  const expTopKeys = new Set();
  const iKeys = new Set();
  for (const e of entries) {
    if (isExplosiveTop(e)) expTopKeys.add(e.date + '|' + e.code);
    if (isIcondition(e))   iKeys.add(e.date + '|' + e.code);
  }
  console.log(`  +10% winners (vs 09:30 close): ${winner10Keys.size}건 / explosiveTop: ${expTopKeys.size}건 / I 조건: ${iKeys.size}건`);

  // READY 전체의 +10% rate (basicGate 기준)
  const readyTrack = entries.filter((e) => e.status === 'READY').map((e) => e.perf.track0930).filter(Boolean);
  const readyHit10Rate = rate(readyTrack.filter((t) => t.hit10).length, readyTrack.length);
  console.log(`  READY 전체 +10% 도달률: ${readyHit10Rate}% (이게 basicGate 기준선)`);

  // 가설 catalog 평가
  const catalog = generateHypothesisCatalog();
  console.log(`  가설 ${catalog.length}건 평가 중...`);
  const evaluated = [];
  for (const h of catalog) {
    const r = evaluateHypothesis(entries, h, dirs.length, winner10Keys, expTopKeys, iKeys);
    if (r.n > 0) {
      r.score = pct(rankScore(r), 2);
      r.passesGate = passesBasicGate(r, readyHit10Rate);
      evaluated.push(r);
    }
  }
  evaluated.sort((a, b) => (b.score || -Infinity) - (a.score || -Infinity));
  console.log(`  ✅ 평가 완료. n>0 가설 ${evaluated.length}건`);

  // 기존 모델 결과 추출
  const baselines = {
    explosiveTop:   evaluated.find((e) => e.name === 'explosiveTop'),
    explosiveTop_S2: evaluated.find((e) => e.name === 'explosiveTop_S2'),
    READY_all:      evaluated.find((e) => e.name === 'READY_all'),
    TEN_REBREAK:    evaluated.find((e) => e.name === 'TEN_REBREAK'),
    FADED_RECOVERY: evaluated.find((e) => e.name === 'FADED_RECOVERY'),
    I_condition:    evaluated.find((e) => e.name === 'I_condition'),
    I_condition_S2: evaluated.find((e) => e.name === 'I_condition_S2'),
    READY_alive1000: evaluated.find((e) => e.name === 'READY_alive1000'),
  };

  // 상위 통과 가설 분류
  const passed = evaluated.filter((e) => e.passesGate && !e.name.startsWith('I_') && !e.name.startsWith('explosiveTop') && e.name !== 'READY_all' && e.name !== 'TEN_REBREAK' && e.name !== 'FADED_RECOVERY');
  const top20 = passed.slice(0, 20);

  // 최고 +10% precision
  const byWinnerPrecision = [...evaluated].filter((e) => e.n >= 30).sort((a, b) => (b.winnerPrecision || 0) - (a.winnerPrecision || 0)).slice(0, 10);
  // 최고 avgReturn (n≥50)
  const byAvgReturn = [...evaluated].filter((e) => e.n >= 50).sort((a, b) => (b.avgReturn || 0) - (a.avgReturn || 0)).slice(0, 10);
  // 후보 수가 실전적 (3~10/일)
  const practical = [...evaluated].filter((e) => e.n >= 50 && e.perDayAvg >= 3 && e.perDayAvg <= 10 && e.avgReturn > 0.5).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);
  // 위험 (worst < -10 또는 fail3 > 60)
  const risky = [...evaluated].filter((e) => e.n >= 50 && ((e.worstLoss != null && e.worstLoss < -10) || (e.fail3Rate || 0) > 60)).sort((a, b) => (a.avgReturn || 0) - (b.avgReturn || 0)).slice(0, 10);
  // 버려야 할 — basicGate 미통과 + avgReturn < 0 + n ≥ 50
  const discard = [...evaluated].filter((e) => !e.passesGate && e.n >= 50 && (e.avgReturn || 0) < 0).slice(0, 10);

  // 최종 추천 (안정형 / 공격형 / 회복형 / 관찰)
  const stableRec = [...passed].filter((e) => (e.strategy === 'S1' || e.strategy === 'S3') && (e.avgReturn || 0) >= 0.7 && (e.fail3Rate || 100) <= 35).slice(0, 3);
  const attackRec = [...passed].filter((e) => (e.strategy === 'S2' || e.strategy === 'T2') && (e.avgReturn || 0) >= 1.0).slice(0, 3);
  const recoveryRec = [...passed].filter((e) => (e.name.includes('RECOVERY') || e.name.includes('recov') || e.name.includes('FADED_') || e.name.includes('WEAK_'))).slice(0, 3);
  const watchRec = [...evaluated].filter((e) => (e.avgReturn || 0) < 0 || ((e.fail3Rate || 0) > 50)).slice(0, 5).map((e) => ({ ...e, _note: '진입 X, 관찰만' }));

  const elapsedSec = Number(((Date.now() - t0) / 1000).toFixed(2));

  const out = {
    meta: {
      title: '1DS — 최고의 단타 가설 자동 탐색',
      generatedAt: new Date().toISOString(),
      totalDays: dirs.length,
      datesAnalyzed: dirs,
      totalEntries: entries.length,
      winner10Count: winner10Keys.size,
      explosiveTopCount: expTopKeys.size,
      iConditionCount: iKeys.size,
      readyHit10Rate,
      elapsedSec,
      methodology: '60일 분봉 데이터로 ~' + catalog.length + ' 가설 평가. 사전 feature는 09:30까지의 분봉만 사용. trigger feature는 trigger 시점 이전 분봉만 사용. 성과는 진입 시점 이후 분봉으로 측정 (TP·SL 동시 hit 시 SL 보수적 우선). 7 strategy (S1~S4 / T1~T3) 각자 다른 진입/청산.',
      rankFormula: 'score = avgReturn*2 + winRate*0.03 + hit10Rate*0.08 + hit5Rate*0.03 - fail3Rate*0.05 - abs(perDayAvg-7)*0.08 - max(0,zeroDayRate-30)*0.05',
      basicGate: 'n≥80, 2≤perDayAvg≤20, avgReturn>0.7, medianReturn≥-1.5, hit10Rate≥READY base, fail3Rate≤60, zeroDayRate≤50',
    },
    baselines,
    top20,
    byWinnerPrecision, byAvgReturn, practical, risky, discard,
    recommendations: { stable: stableRec, attack: attackRec, recovery: recoveryRec, watch: watchRec },
    allHypotheses: evaluated,  // 모든 평가 결과 (참고용)
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, renderHtml(out), 'utf-8');

  console.log(`\n  ⏱ 소요 ${elapsedSec}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
  console.log(`\n  📌 통과 가설 ${passed.length}건, top5:`);
  for (const e of top20.slice(0, 5)) {
    console.log(`     score ${e.score} | ${e.label} × ${e.strategy} | n=${e.n} pD=${e.perDayAvg} avg=${e.avgReturn}% win=${e.winRate}% +10%=${e.hit10Rate}% worst=${e.worstLoss}%`);
  }
}

// ── HTML ──
function renderHtml(out) {
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const fmtPct = (v, d) => {
    if (v == null || !Number.isFinite(v)) return '-';
    const dd = d == null ? 2 : d;
    const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
    return `<span class="${cls}">${v >= 0 ? '+' : ''}${v.toFixed(dd)}%</span>`;
  };
  const fmtRate = (v) => v == null ? '-' : v.toFixed(1) + '%';

  function row(e) {
    if (!e) return '<tr><td colspan="14" style="color:#888;text-align:center;">없음</td></tr>';
    return `<tr>
      <td>${esc(e.label)}</td>
      <td>${esc(e.strategy)}</td>
      <td class="num">${e.n}</td>
      <td class="num">${e.perDayAvg}</td>
      <td class="num">${fmtPct(e.avgReturn)}</td>
      <td class="num">${fmtPct(e.medianReturn)}</td>
      <td class="num">${fmtRate(e.winRate)}</td>
      <td class="num">${fmtRate(e.hit5Rate)}</td>
      <td class="num">${fmtRate(e.hit10Rate)}</td>
      <td class="num">${fmtRate(e.fail3Rate)}</td>
      <td class="num">${fmtPct(e.worstLoss)}</td>
      <td class="num">${e.winnerRecall != null ? e.winnerRecall + '%' : '-'}</td>
      <td class="num">${e.winnerPrecision != null ? e.winnerPrecision + '%' : '-'}</td>
      <td class="num"><strong>${e.score}</strong></td>
    </tr>`;
  }
  const head = `<thead><tr>
    <th>가설</th><th>전략</th><th>n</th><th>일평균</th>
    <th>평균</th><th>중앙</th><th>승률</th>
    <th>+5%</th><th>+10%</th><th>-3%</th>
    <th>worst</th>
    <th>winner recall</th><th>winner prec</th>
    <th>score</th>
  </tr></thead>`;

  // 1. 요약 결론
  const top1 = out.top20[0];
  const summary = `<div class="summary">
    <h2 style="margin-top:0;border:none;">1. 요약 결론</h2>
    <ul>
      <li>분석 대상: ${out.meta.totalDays}거래일 (${out.meta.datesAnalyzed[0]} ~ ${out.meta.datesAnalyzed[out.meta.datesAnalyzed.length-1]}) · 총 entries ${out.meta.totalEntries}건 · 평가 가설 ${out.allHypotheses.length}건</li>
      <li>+10% (vs 09:30 close) winner: <strong>${out.meta.winner10Count}건</strong> · explosiveTop: ${out.meta.explosiveTopCount}건 · I 조건: ${out.meta.iConditionCount}건</li>
      <li>READY 전체 +10% 도달률 = <strong>${out.meta.readyHit10Rate}%</strong> (basicGate 기준선)</li>
      <li>basicGate 통과 가설 (기존 모델 제외) <strong>${out.top20.length}건 → 상위 20개 노출</strong></li>
      <li>최고 score 가설: <strong style="color:#d84315;">${top1 ? esc(top1.label) + ' × ' + top1.strategy + ' (score ' + top1.score + ', avg ' + top1.avgReturn + '%, win ' + top1.winRate + '%, +10% ' + top1.hit10Rate + '%, n=' + top1.n + ', 일평균 ' + top1.perDayAvg + ')' : '없음'}</strong></li>
    </ul>
  </div>`;

  // 2. 상위 20개
  const top20Rows = out.top20.map(row).join('');

  // 3. 기존 모델 비교
  const baseRows = ['explosiveTop', 'explosiveTop_S2', 'READY_all', 'TEN_REBREAK', 'FADED_RECOVERY', 'I_condition', 'I_condition_S2', 'READY_alive1000']
    .map((k) => out.baselines[k] ? row(out.baselines[k]) : '').join('');

  // 4. winner precision top10
  const precRows = out.byWinnerPrecision.map(row).join('');

  // 5. avg return top10
  const avgRows = out.byAvgReturn.map(row).join('');

  // 6. practical top10
  const practRows = out.practical.map(row).join('');

  // 7. risky
  const riskyRows = out.risky.map(row).join('');

  // 8. discard
  const discardRows = out.discard.map(row).join('');

  // 9. 추천
  function recBlock(title, list, note) {
    const rows = list.length ? list.map(row).join('') : '<tr><td colspan="14" style="color:#888;text-align:center;">조건 만족 가설 없음</td></tr>';
    return `<h3 style="margin-top:14px;">${esc(title)}</h3><p class="note">${esc(note || '')}</p><table>${head}<tbody>${rows}</tbody></table>`;
  }

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>1DS — 최고의 단타 가설 자동 탐색</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; max-width: 1800px; margin: 0 auto; color: #222; background: #fafafa; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #ddd; }
  h3 { font-size: 14px; margin: 16px 0 6px; color: #444; }
  .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 11.5px; margin-bottom: 10px; }
  th, td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; white-space: nowrap; }
  th { background: #f0f0f0; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #c62828; }
  .neg { color: #1565c0; }
  .summary { background: #fff; padding: 12px 16px; border-radius: 6px; border: 1px solid #e0e0e0; margin-bottom: 18px; }
  .summary strong { color: #d84315; }
  ul { padding-left: 22px; } li { margin: 3px 0; font-size: 13px; }
  table tr:nth-child(odd) td { background: #fafafa; }
  .note { color: #888; font-size: 11px; }
</style>
</head>
<body>
<h1>1DS — 최고의 단타 가설 자동 탐색 (60거래일)</h1>
<div class="meta">
  생성 ${out.meta.generatedAt} · ${out.meta.totalDays}거래일 · entries ${out.meta.totalEntries}건 · 평가 가설 ${out.allHypotheses.length}건 · 소요 ${out.meta.elapsedSec}s
  <div class="note">${esc(out.meta.methodology)}</div>
  <div class="note">랭킹 score = ${esc(out.meta.rankFormula)}</div>
  <div class="note">basicGate = ${esc(out.meta.basicGate)}</div>
</div>
${summary}

<h2>2. 상위 20개 가설 랭킹 (basicGate 통과, 기존 모델 제외)</h2>
<table>${head}<tbody>${top20Rows}</tbody></table>

<h2>3. 기존 explosiveTop / I 조건과 비교</h2>
<table>${head}<tbody>${baseRows}</tbody></table>

<h2>4. +10% winner를 가장 잘 잡는 조건 (winner precision 상위, n≥30)</h2>
<table>${head}<tbody>${precRows}</tbody></table>

<h2>5. 평균 수익이 가장 좋은 조건 (n≥50)</h2>
<table>${head}<tbody>${avgRows}</tbody></table>

<h2>6. 후보 수가 실전적으로 적당한 조건 (n≥50 · 일평균 3~10 · 평균 >0.5%)</h2>
<table>${head}<tbody>${practRows}</tbody></table>

<h2>7. 위험한 조건 (worst &lt; -10% 또는 fail3 &gt; 60%, n≥50)</h2>
<table>${head}<tbody>${riskyRows}</tbody></table>

<h2>8. 버려야 할 조건 (basicGate 미통과 · avgReturn &lt; 0 · n≥50)</h2>
<table>${head}<tbody>${discardRows}</tbody></table>

<h2>9. 최종 추천 후보</h2>
${recBlock('🚀 안정형 (S1/S3 · avg ≥0.7% · fail3 ≤35%)', out.recommendations.stable, '+5% 또는 +7% 익절 / 작은 손절. 안정적 분포.')}
${recBlock('🔥 공격형 (S2/T2 · avg ≥1.0%)', out.recommendations.attack, '+10% 익절 / -3% 손절. 큰 상승 노림.')}
${recBlock('♻ 회복형 (FADED/WEAK + 회복 신호)', out.recommendations.recovery, '약세 상태에서 회복 흔적 + 재돌파 패턴.')}
${recBlock('👀 관찰만 (avgReturn <0 또는 fail3 >50%)', out.recommendations.watch, '진입 X, 관찰만 권장.')}

<h2>10. 다음 보드 반영 제안</h2>
<div class="summary">
  <ul>
    ${out.recommendations.stable[0] ? `<li><strong>🚀 안정형 후보 섹션</strong> — <code>${esc(out.recommendations.stable[0].name)}</code> (${esc(out.recommendations.stable[0].label)}) × ${out.recommendations.stable[0].strategy} 추천. avg ${out.recommendations.stable[0].avgReturn}% / 일평균 ${out.recommendations.stable[0].perDayAvg}개 / +10% ${out.recommendations.stable[0].hit10Rate}%</li>` : '<li>안정형 추천 가설 없음</li>'}
    ${out.recommendations.attack[0] ? `<li><strong>🔥 공격형 후보 섹션</strong> — <code>${esc(out.recommendations.attack[0].name)}</code> (${esc(out.recommendations.attack[0].label)}) × ${out.recommendations.attack[0].strategy} 추천. avg ${out.recommendations.attack[0].avgReturn}% / 일평균 ${out.recommendations.attack[0].perDayAvg}개 / +10% ${out.recommendations.attack[0].hit10Rate}%</li>` : '<li>공격형 추천 가설 없음</li>'}
    ${out.recommendations.recovery[0] ? `<li><strong>♻ 회복형 후보 섹션</strong> — <code>${esc(out.recommendations.recovery[0].name)}</code> (${esc(out.recommendations.recovery[0].label)}) × ${out.recommendations.recovery[0].strategy} 추천.</li>` : '<li>회복형 추천 가설 없음</li>'}
    <li><strong>관찰 섹션</strong> — explosiveWatch 등 진입 X 종목은 별도 영역으로 유지.</li>
  </ul>
</div>

<div class="note" style="margin-top:30px;border-top:1px dashed #ccc;padding-top:10px;">검증 일자: ${esc(out.meta.datesAnalyzed.join(', '))}</div>
</body>
</html>`;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}
module.exports = { main };
