#!/usr/bin/env node
/**
 * explosiveTop full-minute 재검증 (09:00~15:30 전체 분봉)
 *
 * 전략 A~I 비교 + 손절 민감도 + 10:00 생존 분석.
 *
 * 미래 누수 방지:
 *   - 후보 선정 = 09:00~09:30 분봉만 (status / passesExplosive)
 *   - 성과 측정 = 09:31~15:30 분봉
 *
 * 출력: reports/one-day-surge-0930-explosive-fullminute-validation-result.{json,html}
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-0930-explosive-fullminute-validation-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-0930-explosive-fullminute-validation-result.html');
const scanner = require('./one-day-surge-0930-scanner');
const TODAY_FOCUS = '2026-05-14';

function classifyStatus(m) {
  if (!m || m.bars_total < 20) return 'INSUFFICIENT';
  if (m.highToLastDrop != null && m.highToLastDrop <= -2.5) return 'FADED';
  if (m.openToLastRate != null && m.openToLastRate >= 8.0) return 'WAIT_PULLBACK';
  if (m.openToLastRate == null || m.openToLastRate < 1.0) return 'WEAK';
  if (m.value_0930 < 1e9) return 'WEAK';
  if (m.valueToAvgRatio_0930 != null && m.valueToAvgRatio_0930 < 3) return 'WEAK';
  if (m.closePosition0930 < 0.65) return 'WEAK';
  return 'READY';
}
function passesExplosive(m) {
  if (!m || !m.rebreakMorningHigh) return false;
  if ((m.closePosition0930 || 0) < 0.85) return false;
  if ((m.value_0930 || 0) < 1e10) return false;
  return true;
}

// 헬퍼 — 시간 ≤ HH:MM 인 마지막 bar의 close
function priceAt(bars, time) {
  let last = null;
  for (const b of bars) { if (b.time <= time && b.close > 0) last = b; }
  return last ? last.close : null;
}
function priceAtOrAfter(bars, time) {
  for (const b of bars) { if (b.time >= time && b.close > 0) return b; }
  return null;
}

// 분봉 시뮬레이션 — 진입가 + 익절/손절 임계, 시간 한도
// returns { exitPct, exitTime, exitReason }
function simulateStopProfit(bars, entry, profitPct, stopPct, fromTime, untilTime) {
  const range = bars.filter((b) => b.time > fromTime && b.time <= untilTime && b.close > 0);
  if (range.length === 0) return null;
  for (const b of range) {
    const hi = (b.high/entry-1)*100;
    const lo = (b.low /entry-1)*100;
    // 손절 우선 (보수적)
    if (lo <= stopPct) return { exitPct: stopPct, exitTime: b.time, exitReason: 'stop' };
    if (hi >= profitPct) return { exitPct: profitPct, exitTime: b.time, exitReason: 'profit' };
  }
  const lastBar = range[range.length-1];
  return { exitPct: Number(((lastBar.close/entry-1)*100).toFixed(2)), exitTime: lastBar.time, exitReason: 'time' };
}

// 트레일링 스탑 — 10:00 이후 고점 대비 -trailPct% 이탈 시 청산
function simulateTrailing(bars, entry, stopPct, trailPct, profitPct) {
  // 09:31~10:00 사이 손절/익절 우선 처리
  const pre = bars.filter((b) => b.time > '09:30' && b.time <= '10:00' && b.close > 0);
  for (const b of pre) {
    const hi = (b.high/entry-1)*100;
    const lo = (b.low /entry-1)*100;
    if (lo <= stopPct) return { exitPct: stopPct, exitTime: b.time, exitReason: 'stop' };
    if (hi >= profitPct) return { exitPct: profitPct, exitTime: b.time, exitReason: 'profit' };
  }
  // 10:00 close가 진입가 위면 트레일링 시작 (아니면 10:00 청산)
  const close10 = pre.length > 0 ? pre[pre.length-1].close : entry;
  if (close10 <= entry) return { exitPct: Number(((close10/entry-1)*100).toFixed(2)), exitTime: '10:00', exitReason: '10:00_breakeven' };
  // 10:00 이후 — peakHigh 추적, 종가가 peakHigh × (1 + trailPct/100) 이하로 떨어지면 청산
  const post = bars.filter((b) => b.time > '10:00' && b.time <= '15:30' && b.close > 0);
  if (post.length === 0) return { exitPct: Number(((close10/entry-1)*100).toFixed(2)), exitTime: '10:00', exitReason: 'no_post' };
  let peak = close10;
  for (const b of post) {
    if (b.high > peak) peak = b.high;
    const trailStopPrice = peak * (1 + trailPct/100);  // trailPct는 음수 (예: -2)
    if (b.low <= trailStopPrice) {
      // 청산 — peak 대비 -trailPct% 가격
      return { exitPct: Number(((trailStopPrice/entry-1)*100).toFixed(2)), exitTime: b.time, exitReason: 'trail' };
    }
  }
  const lastBar = post[post.length-1];
  return { exitPct: Number(((lastBar.close/entry-1)*100).toFixed(2)), exitTime: lastBar.time, exitReason: 'time_end' };
}

// 전략 시뮬레이션 (A~G + I 손절 민감도) — 09:30 entry, 절반 익절 + 잔여 종가
// 절반 익절은 +5% 도달 시 즉시 절반 청산, 절반은 untilTime까지 보유
// 단 -2% 손절은 전체 청산
function simulateHalfProfitExtend(bars, entry, profitPct, stopPct, untilTime) {
  const post = bars.filter((b) => b.time > '09:30' && b.close > 0);
  let halfExited = false;
  let halfPct = null;
  for (const b of post) {
    const hi = (b.high/entry-1)*100;
    const lo = (b.low /entry-1)*100;
    if (!halfExited) {
      // 손절 우선 (전량)
      if (lo <= stopPct) return { totalPct: stopPct, exitReason: 'stop@'+b.time, halfExited: false };
      if (hi >= profitPct) { halfExited = true; halfPct = profitPct; }  // 절반 익절
    } else {
      // 절반 익절 후 — 나머지 절반은 untilTime까지 보유, 그 사이에 손절은 stopPct
      if (b.time > untilTime) break;
      if (lo <= stopPct) {
        return { totalPct: Number(((halfPct + stopPct)/2).toFixed(2)), exitReason: 'half+stop@'+b.time, halfExited: true };
      }
    }
  }
  // untilTime close로 잔여 청산
  const exitBar = priceAtOrAfter(bars, untilTime) || priceAtOrAfter(bars, '15:30');
  const exitPct = exitBar ? (exitBar.close/entry-1)*100 : 0;
  if (halfExited) {
    return { totalPct: Number(((halfPct + exitPct)/2).toFixed(2)), exitReason: 'half+'+untilTime, halfExited: true };
  }
  return { totalPct: Number(exitPct.toFixed(2)), exitReason: untilTime+'_close', halfExited: false };
}

// 절반 익절 + "10:00 생존 시" 연장 (조건부 연장)
function simulateHalfProfitConditional(bars, entry, profitPct, stopPct, untilTime) {
  const post0930to1000 = bars.filter((b) => b.time > '09:30' && b.time <= '10:00' && b.close > 0);
  let halfExited = false;
  let halfPct = null;
  // 09:31~10:00 사이: 손절 + 절반 익절
  for (const b of post0930to1000) {
    const hi = (b.high/entry-1)*100;
    const lo = (b.low /entry-1)*100;
    if (lo <= stopPct) return { totalPct: stopPct, exitReason: 'stop@'+b.time, halfExited: false, survived: false };
    if (!halfExited && hi >= profitPct) { halfExited = true; halfPct = profitPct; }
  }
  // 10:00 close, 10:00 직전 max
  let max10 = -Infinity, close10 = null;
  for (const b of post0930to1000) {
    if (b.high > max10) max10 = b.high;
    close10 = b.close;
  }
  if (close10 == null) return null;
  const close10Pct = (close10/entry-1)*100;
  const max10Pct = (max10/entry-1)*100;
  const survived = close10Pct > 0 && close10Pct >= max10Pct - 2;
  // 절반 익절했고 생존이면 untilTime까지 연장, 아니면 10:00 close에서 잔여 청산
  if (halfExited) {
    if (survived) {
      // 잔여 보유 — untilTime까지, 그 사이 손절 -2% 유지
      const rest = bars.filter((b) => b.time > '10:00' && b.time <= untilTime && b.close > 0);
      for (const b of rest) {
        const lo = (b.low/entry-1)*100;
        if (lo <= stopPct) {
          return { totalPct: Number(((halfPct + stopPct)/2).toFixed(2)), exitReason: 'half+stop@'+b.time, halfExited: true, survived: true };
        }
      }
      const exitBar = priceAtOrAfter(bars, untilTime) || priceAtOrAfter(bars, '15:30');
      const exitPct = exitBar ? (exitBar.close/entry-1)*100 : close10Pct;
      return { totalPct: Number(((halfPct + exitPct)/2).toFixed(2)), exitReason: 'half+'+untilTime, halfExited: true, survived: true };
    } else {
      return { totalPct: Number(((halfPct + close10Pct)/2).toFixed(2)), exitReason: 'half+10:00(unsurvived)', halfExited: true, survived: false };
    }
  }
  // 익절 못 한 경우 — 10:00 close
  return { totalPct: Number(close10Pct.toFixed(2)), exitReason: '10:00_close', halfExited: false, survived };
}

// 종목별 perf — 모든 전략 시뮬 + 핵심 지표
function computePerf(bars, entry) {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const post = bars.filter((b) => b.time > '09:30' && b.time <= '15:30' && b.close > 0);
  if (post.length === 0) return null;
  // 09:31~10:00 통계
  const pre10 = post.filter((b) => b.time <= '10:00');
  let max10 = -Infinity, min10 = Infinity, close10 = null;
  for (const b of pre10) { if (b.high>max10) max10=b.high; if (b.low<min10) min10=b.low; close10=b.close; }
  // 09:31~15:30 도달률
  let firstHit2=null, firstHit3=null, firstHit5=null, firstHit7=null, firstHit10=null;
  let firstFail2=null, firstFail3=null;
  for (const b of post) {
    const hi = (b.high/entry-1)*100, lo = (b.low/entry-1)*100;
    if (firstHit2 ===null && hi>=2)  firstHit2 =b.time;
    if (firstHit3 ===null && hi>=3)  firstHit3 =b.time;
    if (firstHit5 ===null && hi>=5)  firstHit5 =b.time;
    if (firstHit7 ===null && hi>=7)  firstHit7 =b.time;
    if (firstHit10===null && hi>=10) firstHit10=b.time;
    if (firstFail2===null && lo<=-2) firstFail2=b.time;
    if (firstFail3===null && lo<=-3) firstFail3=b.time;
  }
  // 10:00 생존
  const close10Pct = close10 != null ? (close10/entry-1)*100 : null;
  const max10Pct = isFinite(max10) ? (max10/entry-1)*100 : null;
  const survived = close10Pct != null && close10Pct > 0 && close10Pct >= max10Pct - 2;

  // 시점별 가격 (1030/1100/1300/1530)
  const p1030 = priceAt(post, '10:30');
  const p1100 = priceAt(post, '11:00');
  const p1300 = priceAt(post, '13:00');
  const p1530 = priceAt(post, '15:30');
  const ret1030 = p1030 ? (p1030/entry-1)*100 : null;
  const ret1100 = p1100 ? (p1100/entry-1)*100 : null;
  const ret1300 = p1300 ? (p1300/entry-1)*100 : null;
  const ret1530 = p1530 ? (p1530/entry-1)*100 : null;

  // 전 구간 max/min
  let maxAll = -Infinity, minAll = Infinity;
  for (const b of post) { if (b.high>maxAll) maxAll=b.high; if (b.low<minAll) minAll=b.low; }
  const maxAllPct = (maxAll/entry-1)*100;
  const minAllPct = (minAll/entry-1)*100;

  // 전략 시뮬
  const A = { totalPct: Number((close10Pct||0).toFixed(2)), reason: '10:00 강제' };
  const B = simulateStopProfit(bars, entry, 5, -2, '09:30', '15:30');
  const C = simulateHalfProfitExtend(bars, entry, 5, -2, '10:00');
  const D = simulateHalfProfitConditional(bars, entry, 5, -2, '10:30');
  const E = simulateHalfProfitConditional(bars, entry, 5, -2, '11:00');
  const F = simulateHalfProfitConditional(bars, entry, 5, -2, '13:00');
  const G = simulateHalfProfitConditional(bars, entry, 5, -2, '15:30');
  const H = simulateTrailing(bars, entry, -2, -2, 100);  // 손절 -2%, trail -2%, 무한 익절(트레일링만)
  // I: 손절 민감도
  const I_1_5 = simulateStopProfit(bars, entry, 100, -1.5, '09:30', '15:30');
  const I_2_0 = simulateStopProfit(bars, entry, 100, -2.0, '09:30', '15:30');
  const I_2_5 = simulateStopProfit(bars, entry, 100, -2.5, '09:30', '15:30');
  const I_3_0 = simulateStopProfit(bars, entry, 100, -3.0, '09:30', '15:30');

  return {
    close10Pct: close10Pct != null ? Number(close10Pct.toFixed(2)) : null,
    max10Pct: max10Pct != null ? Number(max10Pct.toFixed(2)) : null,
    survived,
    maxAllPct: Number(maxAllPct.toFixed(2)),
    minAllPct: Number(minAllPct.toFixed(2)),
    ret1030: ret1030 != null ? Number(ret1030.toFixed(2)) : null,
    ret1100: ret1100 != null ? Number(ret1100.toFixed(2)) : null,
    ret1300: ret1300 != null ? Number(ret1300.toFixed(2)) : null,
    ret1530: ret1530 != null ? Number(ret1530.toFixed(2)) : null,
    hit2: firstHit2!==null, hit3: firstHit3!==null, hit5: firstHit5!==null, hit7: firstHit7!==null, hit10: firstHit10!==null,
    fail2: firstFail2!==null, fail3: firstFail3!==null,
    A, B, C, D, E, F, G, H,
    I: { '1.5': I_1_5, '2.0': I_2_0, '2.5': I_2_5, '3.0': I_3_0 },
  };
}

function runDay(targetDate, metaMap) {
  const dir = path.join(INTRADAY_BASE, targetDate);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;
  const targetNum = targetDate.replace(/-/g, '');
  const entries = [];
  for (const fname of files) {
    const code = fname.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    if (!meta) continue;
    const chartPath = path.join(CHART_DIR, fname);
    if (!fs.existsSync(chartPath)) continue;
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8')); } catch (_) { continue; }
    const rows = chart && chart.rows;
    if (!Array.isArray(rows) || rows.length < 25) continue;
    const dayIdx = rows.findIndex((r) => r.date === targetNum);
    if (dayIdx < 1) continue;
    const baseIdx = dayIdx - 1;
    if (baseIdx < 20) continue;
    let sum = 0, n = 0;
    for (let i = baseIdx-20; i < baseIdx; i++) { const r=rows[i]; if (r && r.volume>0) { sum += (r.valueApprox||0); n++; } }
    const avg20 = n > 0 ? sum/n : 0;
    const baseRow = rows[baseIdx];
    const baseValue = (baseRow && baseRow.valueApprox) || 0;
    const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) continue;
    let bars;
    try { bars = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8')).bars || []; } catch (_) { continue; }
    if (bars.length < 30) continue;  // full-day인데 너무 짧으면 거래 없음
    const m = scanner.computeMetrics0930(bars, baseRow);
    if (!m) continue;
    const status = classifyStatus(m);
    if (status !== 'READY' && status !== 'WAIT_PULLBACK') continue;
    const perf = computePerf(bars, m.last0930);
    if (!perf) continue;
    entries.push({
      code, name: chart.name || meta.name || code,
      status, passesExp: passesExplosive(m),
      finalScore: scanner.computeFinalScore(m),
      m: { closePosition0930: m.closePosition0930, value_0930: m.value_0930, rebreakMorningHigh: m.rebreakMorningHigh, openToLastRate: m.openToLastRate, highToLastDrop: m.highToLastDrop, last0930: m.last0930 },
      perf,
    });
  }
  return { date: targetDate, entries };
}

function summarize(entries) {
  const n = entries.length;
  if (n === 0) return { n: 0 };
  const avg = (a) => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
  const med = (sorted) => sorted.length===0?0:sorted.length%2===0?(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2:sorted[(sorted.length-1)/2];
  const stratStats = (key) => {
    const vals = entries.map((e) => e.perf[key].totalPct != null ? e.perf[key].totalPct : e.perf[key].exitPct);
    const sorted = [...vals].sort((a,b)=>a-b);
    return {
      avg: Number(avg(vals).toFixed(2)),
      median: Number(med(sorted).toFixed(2)),
      winRate: Number((vals.filter((v)=>v>0).length/n*100).toFixed(1)),
      lossRate: Number((vals.filter((v)=>v<0).length/n*100).toFixed(1)),
      worstLoss: Number(Math.min(...vals).toFixed(2)),
      bestGain: Number(Math.max(...vals).toFixed(2)),
    };
  };
  const survived = entries.filter((e) => e.perf.survived);
  const notSurvived = entries.filter((e) => !e.perf.survived);
  return {
    n,
    avgMax10: Number(avg(entries.map((e)=>e.perf.max10Pct||0)).toFixed(2)),
    avgClose10: Number(avg(entries.map((e)=>e.perf.close10Pct||0)).toFixed(2)),
    avgMaxAll: Number(avg(entries.map((e)=>e.perf.maxAllPct)).toFixed(2)),
    avgMinAll: Number(avg(entries.map((e)=>e.perf.minAllPct)).toFixed(2)),
    survivedCount: survived.length,
    survivalRate: Number((survived.length/n*100).toFixed(1)),
    survived_avg1030: Number(avg(survived.filter((e)=>e.perf.ret1030!=null).map((e)=>e.perf.ret1030)).toFixed(2)),
    survived_avg1100: Number(avg(survived.filter((e)=>e.perf.ret1100!=null).map((e)=>e.perf.ret1100)).toFixed(2)),
    survived_avg1300: Number(avg(survived.filter((e)=>e.perf.ret1300!=null).map((e)=>e.perf.ret1300)).toFixed(2)),
    survived_avg1530: Number(avg(survived.filter((e)=>e.perf.ret1530!=null).map((e)=>e.perf.ret1530)).toFixed(2)),
    survived_positive1530Rate: survived.length > 0 ? Number((survived.filter((e)=>e.perf.ret1530>0).length/survived.length*100).toFixed(1)) : 0,
    notSurvived_avg1030: Number(avg(notSurvived.filter((e)=>e.perf.ret1030!=null).map((e)=>e.perf.ret1030)).toFixed(2)),
    notSurvived_avg1530: Number(avg(notSurvived.filter((e)=>e.perf.ret1530!=null).map((e)=>e.perf.ret1530)).toFixed(2)),
    hit2Rate: Number((entries.filter((e)=>e.perf.hit2).length/n*100).toFixed(1)),
    hit3Rate: Number((entries.filter((e)=>e.perf.hit3).length/n*100).toFixed(1)),
    hit5Rate: Number((entries.filter((e)=>e.perf.hit5).length/n*100).toFixed(1)),
    hit7Rate: Number((entries.filter((e)=>e.perf.hit7).length/n*100).toFixed(1)),
    hit10Rate: Number((entries.filter((e)=>e.perf.hit10).length/n*100).toFixed(1)),
    fail2Rate: Number((entries.filter((e)=>e.perf.fail2).length/n*100).toFixed(1)),
    fail3Rate: Number((entries.filter((e)=>e.perf.fail3).length/n*100).toFixed(1)),
    A: stratStats('A'), B: stratStats('B'), C: stratStats('C'), D: stratStats('D'),
    E: stratStats('E'), F: stratStats('F'), G: stratStats('G'), H: stratStats('H'),
    I_1_5: { avg: Number(avg(entries.map((e)=>e.perf.I['1.5'].exitPct)).toFixed(2)), worst: Number(Math.min(...entries.map((e)=>e.perf.I['1.5'].exitPct)).toFixed(2)) },
    I_2_0: { avg: Number(avg(entries.map((e)=>e.perf.I['2.0'].exitPct)).toFixed(2)), worst: Number(Math.min(...entries.map((e)=>e.perf.I['2.0'].exitPct)).toFixed(2)) },
    I_2_5: { avg: Number(avg(entries.map((e)=>e.perf.I['2.5'].exitPct)).toFixed(2)), worst: Number(Math.min(...entries.map((e)=>e.perf.I['2.5'].exitPct)).toFixed(2)) },
    I_3_0: { avg: Number(avg(entries.map((e)=>e.perf.I['3.0'].exitPct)).toFixed(2)), worst: Number(Math.min(...entries.map((e)=>e.perf.I['3.0'].exitPct)).toFixed(2)) },
  };
}

function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log('\n⏰ explosiveTop full-minute 재검증');
  const dates = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => fs.readdirSync(path.join(INTRADAY_BASE, d)).length >= 100)
    .sort();
  console.log(`  대상: ${dates.length}일 (${dates[0]} ~ ${dates[dates.length-1]})`);
  const metaMap = scanner.loadStockMetaMap();

  const dayResults = [];
  for (const d of dates) {
    const r = runDay(d, metaMap);
    if (r) dayResults.push(r);
    process.stdout.write(`  ${d}: ${r?r.entries.length:0}\n`);
  }

  const allReady = [], allWait = [], allExp = [], allExpWatch = [], allReadyTop5 = [];
  for (const d of dayResults) {
    for (const e of d.entries) {
      if (e.status === 'READY') allReady.push(e);
      if (e.status === 'WAIT_PULLBACK') allWait.push(e);
      if (e.status === 'READY' && e.passesExp) allExp.push(e);
      if (e.status === 'WAIT_PULLBACK' && e.passesExp) allExpWatch.push(e);
    }
    const top5 = [...d.entries.filter((e)=>e.status==='READY')].sort((a,b)=>b.finalScore-a.finalScore).slice(0,5);
    for (const e of top5) allReadyTop5.push(e);
  }

  const summaries = {
    explosiveTop:   summarize(allExp),
    READY_TOP5:     summarize(allReadyTop5),
    READY_ALL:      summarize(allReady),
    explosiveWatch: summarize(allExpWatch),
  };

  // 5/14 explosiveTop/Watch 상세
  const today = dayResults.find((d) => d.date === TODAY_FOCUS);
  const todayDetail = today ? today.entries.filter((e) => e.passesExp).map((e) => ({
    code: e.code, name: e.name, status: e.status, finalScore: e.finalScore,
    perf: {
      close10: e.perf.close10Pct, max10: e.perf.max10Pct, survived: e.perf.survived,
      ret1030: e.perf.ret1030, ret1100: e.perf.ret1100, ret1300: e.perf.ret1300, ret1530: e.perf.ret1530,
      maxAll: e.perf.maxAllPct, minAll: e.perf.minAllPct,
      A: e.perf.A.totalPct, B: e.perf.B.exitPct, C: e.perf.C.totalPct,
      D: e.perf.D.totalPct, E: e.perf.E.totalPct, F: e.perf.F.totalPct, G: e.perf.G.totalPct,
      H: e.perf.H.exitPct,
    },
  })) : [];

  const elapsedSec = ((Date.now()-t0)/1000).toFixed(2);
  const out = {
    meta: {
      title: 'explosiveTop full-minute 재검증',
      generatedAt: new Date().toISOString(), elapsedSec,
      eligibleDates: dates, eligibleDayCount: dates.length,
      methodology: '09:00~15:30 전체 분봉 사용. 후보 선정=09:30 분봉, 성과=09:31~15:30 분봉.',
      strategies: {
        A: '10:00 강제 청산',
        B: '+5%/-2% 분봉 시뮬 (전 구간)',
        C: '+5% 절반 익절 + -2% 손절, 나머지 10:00 청산',
        D: '+5% 절반 익절 + -2% 손절, 10:00 생존 시 나머지 10:30 청산',
        E: '+5% 절반 + -2% 손절, 10:00 생존 시 11:00 청산',
        F: '+5% 절반 + -2% 손절, 10:00 생존 시 13:00 청산',
        G: '+5% 절반 + -2% 손절, 10:00 생존 시 종가(15:30) 청산',
        H: '10:00 이후 고점 대비 -2% trailing (전 구간 -2% 손절 우선)',
        I: '손절 민감도 -1.5/-2/-2.5/-3% (익절 없이 종가까지 보유)',
      },
    },
    summaries,
    todayDetail,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  // 콘솔
  console.log('\n📋 그룹별 전략 평균 손익 (% per trade):');
  const head = ['Pool','n','A 10:00','B +5/-2','C half+10:00','D half+10:30','E half+11:00','F half+13:00','G half+종가','H trail'];
  console.log('  ' + head.map(c => String(c).padStart(13)).join(' '));
  for (const k of ['explosiveTop','READY_TOP5','READY_ALL','explosiveWatch']) {
    const s = summaries[k]; if (!s.n) continue;
    console.log('  ' + [k, s.n, s.A.avg+'%', s.B.avg+'%', s.C.avg+'%', s.D.avg+'%', s.E.avg+'%', s.F.avg+'%', s.G.avg+'%', s.H.avg+'%'].map(c=>String(c).padStart(13)).join(' '));
  }

  console.log('\n📋 explosiveTop 10:00 생존 후 시점별 수익률:');
  const s = summaries.explosiveTop;
  console.log('  10:00 생존률: '+s.survivalRate+'% ('+s.survivedCount+'/'+s.n+')');
  console.log('  생존: 10:30 +'+s.survived_avg1030+'%, 11:00 +'+s.survived_avg1100+'%, 13:00 +'+s.survived_avg1300+'%, 종가 +'+s.survived_avg1530+'%');
  console.log('  생존 종목 종가 플러스: '+s.survived_positive1530Rate+'%');
  console.log('  미생존: 10:30 '+s.notSurvived_avg1030+'%, 종가 '+s.notSurvived_avg1530+'%');

  console.log('\n📋 손절 민감도 (explosiveTop, 익절 없이 종가까지):');
  for (const stop of ['1_5','2_0','2_5','3_0']) {
    const v = s['I_'+stop];
    console.log('  -'+stop.replace('_','.')+'%: 평균 '+v.avg+'% / 최악 '+v.worst+'%');
  }

  console.log('\n  ⏱ 소요 '+elapsedSec+'s');
  console.log('✅ JSON: '+OUT_JSON);
  console.log('✅ HTML: '+OUT_HTML);
}

function buildHtml(out) {
  const s = out.summaries;
  const cls = (v) => v > 0 ? 'pos' : (v < 0 ? 'neg' : 'muted');
  const stratRow = (label, key) => {
    const v = s[key]; if (!v||!v.n) return '<tr><td>'+label+'</td><td>0</td><td colspan="8">데이터 없음</td></tr>';
    return '<tr><td>'+label+'</td><td>'+v.n+'</td>' +
      ['A','B','C','D','E','F','G','H'].map(k=>'<td class="num '+cls(v[k].avg)+'">'+v[k].avg+'%</td>').join('') +
    '</tr>';
  };
  const headStrat = '<thead><tr><th>풀</th><th>n</th><th>A 10:00</th><th>B +5/-2</th><th>C half+10:00</th><th>D half+10:30</th><th>E half+11:00</th><th>F half+13:00</th><th>G half+종가</th><th>H trail</th></tr></thead>';

  const winRow = (label, key) => {
    const v = s[key]; if (!v||!v.n) return '';
    return '<tr><td>'+label+'</td><td>'+v.n+'</td>' +
      ['A','B','C','D','E','F','G','H'].map(k=>'<td class="num">'+v[k].winRate+'% / '+v[k].lossRate+'%</td>').join('') +
    '</tr>';
  };

  const survRow = (label, key) => {
    const v = s[key]; if (!v||!v.n) return '';
    return '<tr><td>'+label+'</td>' +
      '<td class="num">'+v.survivalRate+'% ('+v.survivedCount+'/'+v.n+')</td>' +
      '<td class="num pos">'+v.survived_avg1030+'%</td>' +
      '<td class="num pos">'+v.survived_avg1100+'%</td>' +
      '<td class="num pos">'+v.survived_avg1300+'%</td>' +
      '<td class="num pos strong">'+v.survived_avg1530+'%</td>' +
      '<td class="num strong">'+v.survived_positive1530Rate+'%</td>' +
      '<td class="num neg">'+v.notSurvived_avg1530+'%</td></tr>';
  };

  const stopRow = (label, key) => {
    const v = s[key]; if (!v||!v.n) return '';
    return '<tr><td>'+label+'</td>' +
      '<td class="num">'+v.I_1_5.avg+'% (최악 '+v.I_1_5.worst+'%)</td>' +
      '<td class="num">'+v.I_2_0.avg+'% (최악 '+v.I_2_0.worst+'%)</td>' +
      '<td class="num">'+v.I_2_5.avg+'% (최악 '+v.I_2_5.worst+'%)</td>' +
      '<td class="num">'+v.I_3_0.avg+'% (최악 '+v.I_3_0.worst+'%)</td></tr>';
  };

  // 결론 — explosiveTop에서 최고 전략 + 손절 추천
  const e = s.explosiveTop;
  let bestStrat = 'A', bestVal = -Infinity;
  for (const k of ['A','B','C','D','E','F','G','H']) if (e[k].avg > bestVal) { bestVal = e[k].avg; bestStrat = k; }
  const stratDef = out.meta.strategies[bestStrat];
  const survivalConclusion = e.survival_positive1530Rate >= 60
    ? '10:00 생존 시 종가까지 보유가 의미 있음 (생존 종목 ' + e.survived_positive1530Rate + '% 플러스)'
    : '10:00 생존이어도 종가까지는 신중. 11:00 또는 13:00 청산 검토.';

  const todayList = (out.todayDetail || []).map((t) => '<tr>' +
    '<td>'+t.code+' '+t.name+'</td><td>'+t.status+'</td>' +
    '<td class="num">'+t.finalScore+'</td>' +
    '<td class="num">'+(t.perf.close10||'-')+'%</td>' +
    '<td>'+(t.perf.survived?'<span class="pos">✓</span>':'·')+'</td>' +
    '<td class="num">'+(t.perf.ret1030||'-')+'%</td>' +
    '<td class="num">'+(t.perf.ret1100||'-')+'%</td>' +
    '<td class="num">'+(t.perf.ret1300||'-')+'%</td>' +
    '<td class="num strong">'+(t.perf.ret1530||'-')+'%</td>' +
    '<td class="num pos">'+t.perf.maxAll+'%</td>' +
    '<td class="num neg">'+t.perf.minAll+'%</td>' +
    '<td class="num">'+t.perf.A+'%</td>' +
    '<td class="num">'+t.perf.B+'%</td>' +
    '<td class="num">'+t.perf.G+'%</td></tr>').join('');

  return '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>explosiveTop fullminute 검증</title><style>\n' +
    'body{margin:0 auto;padding:20px;max-width:1600px;font-family:-apple-system,"Segoe UI","Noto Sans KR",sans-serif;background:#0f172a;color:#e2e8f0;font-size:13px;line-height:1.6;}\n' +
    'h1,h2,h3{color:#f1f5f9;}h2{color:#fcd34d;border-bottom:1px solid #f59e0b;padding-bottom:6px;margin:22px 0 10px;}\n' +
    '.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:14px 18px;margin:12px 0;}\n' +
    '.conclusion{background:linear-gradient(135deg,#042f2e 0%,#0f172a 100%);border:2px solid #14b8a6;}\n' +
    'table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-variant-numeric:tabular-nums;font-size:11.5px;}\n' +
    'th,td{padding:6px 8px;border:1px solid #334155;}th{background:#1e293b;color:#cbd5e1;font-weight:700;}\n' +
    'td.num{text-align:right;}.pos{color:#6ee7b7;}.neg{color:#fca5a5;}.strong{color:#fcd34d;font-weight:700;}.muted{color:#94a3b8;}\n' +
    '.note{font-size:11px;color:#94a3b8;font-style:italic;}\n' +
    '</style></head><body>\n' +
    '<h1>⏰ explosiveTop full-minute 재검증</h1>\n' +
    '<div class="note">'+out.meta.eligibleDayCount+'일 ('+out.meta.eligibleDates[0]+' ~ '+out.meta.eligibleDates[out.meta.eligibleDates.length-1]+') · 소요 '+out.meta.elapsedSec+'s · 09:00~15:30 전체 분봉 사용</div>\n' +

    '<div class="card conclusion">\n' +
    '<h2 style="margin-top:0;">📌 결론</h2>\n' +
    '<p><strong>explosiveTop n=' + e.n + ' / 최적 전략: ' + bestStrat + '</strong> = 평균 <strong>' + bestVal + '%</strong> / trade<br>' +
    '<span class="note">' + stratDef + '</span></p>\n' +
    '<ul>\n' +
    '<li>10:00 생존률: <strong>' + e.survivalRate + '%</strong> (' + e.survivedCount + '/' + e.n + '건)</li>\n' +
    '<li>생존 종목 종가까지 보유 시: 평균 <strong>' + e.survived_avg1530 + '%</strong>, 종가 플러스 <strong>' + e.survived_positive1530Rate + '%</strong></li>\n' +
    '<li>10:30 평균 ' + e.survived_avg1030 + '% / 11:00 ' + e.survived_avg1100 + '% / 13:00 ' + e.survived_avg1300 + '% / 종가 ' + e.survived_avg1530 + '%</li>\n' +
    '<li>미생존 종목 종가: 평균 <strong class="neg">' + e.notSurvived_avg1530 + '%</strong> (즉시 청산이 정답)</li>\n' +
    '<li>전체 도달률: +2% ' + e.hit2Rate + '% / +5% ' + e.hit5Rate + '% / +10% ' + e.hit10Rate + '% | -2% ' + e.fail2Rate + '% / -3% ' + e.fail3Rate + '%</li>\n' +
    '</ul>\n' +
    '<p>→ ' + survivalConclusion + '</p>\n' +
    '</div>\n' +

    '<h2>1. 전략별 평균 손익 (% per trade)</h2>\n<div class="card"><table>' + headStrat + '<tbody>\n' +
    stratRow('🚀 explosiveTop', 'explosiveTop') +
    stratRow('READY TOP5 (finalScore)', 'READY_TOP5') +
    stratRow('READY 전체', 'READY_ALL') +
    stratRow('🚀 explosiveWatch', 'explosiveWatch') +
    '</tbody></table>\n<div class="note">전략 정의는 페이지 하단 참조.</div></div>\n' +

    '<h2>2. 10:00 생존 후 시점별 수익률 (생존 종목만 평균)</h2>\n<div class="card"><table>\n' +
    '<thead><tr><th>풀</th><th>10:00 생존</th><th>10:30 평균</th><th>11:00 평균</th><th>13:00 평균</th><th>종가 평균</th><th>종가 플러스율</th><th>미생존 종가 평균</th></tr></thead><tbody>\n' +
    survRow('🚀 explosiveTop', 'explosiveTop') +
    survRow('READY TOP5', 'READY_TOP5') +
    survRow('READY 전체', 'READY_ALL') +
    survRow('explosiveWatch', 'explosiveWatch') +
    '</tbody></table>\n<div class="note">10:00 생존 = close10 > entry AND close10 ≥ max(09:31~10:00) × 0.98. 생존 종목의 시점별 평균이 시간 갈수록 증가하면 연장이 의미 있음.</div></div>\n' +

    '<h2>3. 승률/손실률 (전략별)</h2>\n<div class="card"><table>' + headStrat + '<tbody>\n' +
    winRow('🚀 explosiveTop', 'explosiveTop') +
    winRow('READY TOP5', 'READY_TOP5') +
    winRow('explosiveWatch', 'explosiveWatch') +
    '</tbody></table></div>\n' +

    '<h2>4. 손절 민감도 (익절 없이 종가까지 보유)</h2>\n<div class="card"><table>\n' +
    '<thead><tr><th>풀</th><th>-1.5%</th><th>-2.0%</th><th>-2.5%</th><th>-3.0%</th></tr></thead><tbody>\n' +
    stopRow('🚀 explosiveTop', 'explosiveTop') +
    stopRow('READY TOP5', 'READY_TOP5') +
    stopRow('explosiveWatch', 'explosiveWatch') +
    '</tbody></table>\n<div class="note">손절 폭이 너무 작으면 흔들림에 자주 손절돼 평균이 낮아짐. 너무 크면 최악 손실이 커짐. 균형점을 찾는 자료.</div></div>\n' +

    (todayList ? '<h2>5. 5/14 explosiveTop/Watch 종목별 상세</h2>\n<div class="card"><table>\n' +
    '<thead><tr><th>종목</th><th>풀</th><th>final</th><th>close10</th><th>생존</th><th>10:30</th><th>11:00</th><th>13:00</th><th>종가</th><th>maxAll</th><th>minAll</th><th>A</th><th>B</th><th>G</th></tr></thead><tbody>\n' +
    todayList + '</tbody></table></div>\n' : '') +

    '<h2>6. 전략 정의</h2><div class="card">' +
    Object.entries(out.meta.strategies).map(([k,v]) => '<p><strong>'+k+'</strong>: '+v+'</p>').join('') +
    '</div>\n' +
    '</body></html>';
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}
module.exports = { main, runDay };
