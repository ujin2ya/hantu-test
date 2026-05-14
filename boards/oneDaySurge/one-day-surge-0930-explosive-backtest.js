#!/usr/bin/env node
/**
 * 1DS 09:30 폭발형 백테스트 — 손절 감수하고 큰 익절(+5/+7/+10/+15%)을 찾는다.
 *
 * 데이터 한계:
 *   - 09:00~10:00 분봉만 보유 → 09:30~10:00 구간은 분봉 측정
 *   - 11:30 측정 불가 (분봉 없음) → 당일 일봉(09:30~15:30 전체)으로 day-max 측정
 *
 * 출력: reports/one-day-surge-0930-explosive-backtest-result.{json,html}
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-0930-explosive-backtest-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-0930-explosive-backtest-result.html');
const scanner = require('./one-day-surge-0930-scanner');

const READY_CFG = scanner.CONFIG;
function isReady(m) {
  if (!m || m.bars_total < 20) return false;
  if (m.highToLastDrop != null && m.highToLastDrop <= -2.5) return false;
  if (m.openToLastRate != null && m.openToLastRate >= 8.0) return false;
  if (m.openToLastRate == null || m.openToLastRate < 1.0) return false;
  if (m.value_0930 < 1e9) return false;
  if (m.valueToAvgRatio_0930 != null && m.valueToAvgRatio_0930 < 3) return false;
  if (m.closePosition0930 < 0.65) return false;
  return true;
}

// V1~V4 폭발형 점수식
function expV1(m) {
  return (m.value_0930||0)/1e8*0.3
    + (m.valueToAvgRatio_0930||0)*3
    + (m.closePosition0930||0)*15
    + Math.max(0, m.openToLastRate||0)*1.5
    + (m.highToLastDrop!=null ? Math.max(0, 5+Math.min(0,m.highToLastDrop))*1 : 0)
    + (m.rebreakMorningHigh?8:0);
}
function expV2(m, meta) {
  let s = expV1(m);
  const mc = meta && meta.marketCap || 0;
  if (mc >= 5e10 && mc < 3e11) s += 8;   // 시총 500억~3000억
  if ((m.value_0930||0) >= 3e9) s += 6;  // 30억 이상
  if ((m.valueToAvgRatio_0930||0) >= 5) s += 5;
  return s;
}
function expV3(m, meta, ex) {
  let s = expV2(m, meta);
  if (ex && ex.volumeFadeRatio != null && ex.volumeFadeRatio >= 1.0) s += 5;  // 20~30분 거래대금 증가
  if (ex && ex.last5HighRatio != null && ex.last5HighRatio >= 0.99) s += 5;   // 25~30분 고가권 유지
  if (ex && ex.highIn0915) s -= 8;                                            // 너무 이른 spike 감점
  return s;
}
function expV4(m, meta, ex, recentQva) {
  let s = expV3(m, meta, ex);
  if (recentQva) s += 6;                                                       // 전일 QVA/VVI 겹침
  if (ex && ex.prevDayChangeRate != null && ex.prevDayChangeRate >= 12) s -= 6; // 전일 과열
  if (ex && ex.gapRate != null && ex.gapRate >= 7) s -= 5;                     // gap 과다
  return Number(s.toFixed(2));
}

function computeExtended(bars, baseRow, prevRow) {
  if (!bars || bars.length === 0) return null;
  const pre = bars.filter((b) => b.time <= '09:30' && b.close > 0);
  if (pre.length === 0) return null;
  const last = pre[pre.length - 1];
  const at0920 = [...pre].reverse().find((b) => b.time <= '09:20');
  const at0925 = [...pre].reverse().find((b) => b.time <= '09:25');
  const last10Trend = at0920 && at0920.close > 0 ? (last.close/at0920.close-1)*100 : null;
  const last5Bars = pre.filter((b) => b.time > '09:25');
  let last5High = 0;
  for (const b of last5Bars) if (b.high > last5High) last5High = b.high;
  const last5HighRatio = last5High > 0 ? last.close/last5High : null;
  let max0_30 = 0, highTime0930 = null;
  for (const b of pre) if (b.high > max0_30) { max0_30 = b.high; highTime0930 = b.time; }
  const highIn0915 = highTime0930 != null && highTime0930 < '09:15';
  const bars10_20 = pre.filter((b) => b.time > '09:10' && b.time <= '09:20');
  const bars20_30 = pre.filter((b) => b.time > '09:20' && b.time <= '09:30');
  const v10_20 = bars10_20.reduce((s, b) => s+(b.value||0), 0);
  const v20_30 = bars20_30.reduce((s, b) => s+(b.value||0), 0);
  const volumeFadeRatio = v10_20 > 0 ? v20_30/v10_20 : null;
  const prevDayChangeRate = prevRow && prevRow.close > 0 && baseRow ? (baseRow.close/prevRow.close-1)*100 : null;
  const gapRate = baseRow && baseRow.close > 0 ? (pre[0].open/baseRow.close-1)*100 : null;
  return {
    last10Trend: last10Trend != null ? Number(last10Trend.toFixed(2)) : null,
    last5HighRatio: last5HighRatio != null ? Number(last5HighRatio.toFixed(4)) : null,
    highTime0930, highIn0915,
    volumeFadeRatio: volumeFadeRatio != null ? Number(volumeFadeRatio.toFixed(3)) : null,
    prevDayChangeRate: prevDayChangeRate != null ? Number(prevDayChangeRate.toFixed(2)) : null,
    gapRate: gapRate != null ? Number(gapRate.toFixed(2)) : null,
  };
}

// 09:31~10:00 분봉 + 당일 일봉(09:30~15:30 max)으로 성과 측정
function measure(bars, entryPrice, dayRow) {
  if (!bars || !Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const post = bars.filter((b) => b.time > '09:30' && b.time <= '10:00' && b.close > 0);
  if (post.length === 0) return null;
  let maxHi1000 = -Infinity, minLo1000 = Infinity;
  let firstHit3=null, firstHit5=null, firstHit7=null, firstHit10=null, firstHit15=null;
  let firstFail1=null, firstFail2=null, firstFail3=null, firstFail5=null;
  for (const b of post) {
    if (b.high > maxHi1000) maxHi1000 = b.high;
    if (b.low < minLo1000) minLo1000 = b.low;
    const hi = (b.high/entryPrice-1)*100;
    const lo = (b.low /entryPrice-1)*100;
    if (firstHit3===null && hi>=3) firstHit3=b.time;
    if (firstHit5===null && hi>=5) firstHit5=b.time;
    if (firstHit7===null && hi>=7) firstHit7=b.time;
    if (firstHit10===null && hi>=10) firstHit10=b.time;
    if (firstHit15===null && hi>=15) firstHit15=b.time;
    if (firstFail1===null && lo<=-1) firstFail1=b.time;
    if (firstFail2===null && lo<=-2) firstFail2=b.time;
    if (firstFail3===null && lo<=-3) firstFail3=b.time;
    if (firstFail5===null && lo<=-5) firstFail5=b.time;
  }
  const close1000 = post[post.length-1].close;
  // 당일 일봉 — 09:30~15:30 max/min (단 09:30 이전 시간대도 포함됨 — 09:00 시초가가 더 낮을 수 있음)
  // dayRow의 high는 전체 시간대지만, 09:30 이후 max 추정으로 사용
  const dayMaxPct = dayRow && dayRow.high > 0 ? (dayRow.high/entryPrice-1)*100 : null;
  const dayMinPct = dayRow && dayRow.low  > 0 ? (dayRow.low /entryPrice-1)*100 : null;
  const dayClosePct = dayRow && dayRow.close > 0 ? (dayRow.close/entryPrice-1)*100 : null;
  return {
    maxReturn1000: Number(((maxHi1000/entryPrice-1)*100).toFixed(2)),
    minReturn1000: Number(((minLo1000/entryPrice-1)*100).toFixed(2)),
    returnAt1000: Number(((close1000/entryPrice-1)*100).toFixed(2)),
    dayMax: dayMaxPct != null ? Number(dayMaxPct.toFixed(2)) : null,
    dayMin: dayMinPct != null ? Number(dayMinPct.toFixed(2)) : null,
    dayClose: dayClosePct != null ? Number(dayClosePct.toFixed(2)) : null,
    hit3: firstHit3!==null, hit5: firstHit5!==null, hit7: firstHit7!==null,
    hit10: firstHit10!==null, hit15: firstHit15!==null,
    fail1: firstFail1!==null, fail2: firstFail2!==null, fail3: firstFail3!==null, fail5: firstFail5!==null,
    firstHit5BeforeFail2: firstHit5!==null && (firstFail2===null || firstHit5<firstFail2),
    firstHit7BeforeFail3: firstHit7!==null && (firstFail3===null || firstHit7<firstFail3),
    firstHit10BeforeFail3: firstHit10!==null && (firstFail3===null || firstHit10<firstFail3),
    firstHit3: firstHit3, firstHit5: firstHit5, firstHit7: firstHit7, firstHit10: firstHit10,
    firstFail1: firstFail1, firstFail2: firstFail2, firstFail3: firstFail3,
    // 당일 일봉 max가 +5/+7/+10%인지 — 11:30/15:30 측정 대용
    dayHit5: dayMaxPct != null && dayMaxPct >= 5,
    dayHit7: dayMaxPct != null && dayMaxPct >= 7,
    dayHit10: dayMaxPct != null && dayMaxPct >= 10,
    dayHit15: dayMaxPct != null && dayMaxPct >= 15,
  };
}

// 전략 시뮬레이션 (분봉 기준 — 09:31~10:00)
function simulateStrategy(bars, entryPrice, profitPct, stopPct, partialPct) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const post = bars.filter((b) => b.time > '09:30' && b.time <= '10:00' && b.close > 0);
  if (post.length === 0) return null;
  let exitPct = null, exitTime = null, exitReason = null;
  let halfExited = false, halfExitPct = null;
  for (const b of post) {
    const hi = (b.high/entryPrice-1)*100;
    const lo = (b.low /entryPrice-1)*100;
    // 손절 우선 (보수적 — high 와 low 동일 분봉에선 stop 먼저로 가정)
    if (lo <= stopPct) {
      exitPct = stopPct; exitTime = b.time; exitReason = 'stop'; break;
    }
    // partial 부분익절
    if (partialPct != null && !halfExited && hi >= partialPct) {
      halfExited = true; halfExitPct = partialPct;
    }
    if (hi >= profitPct) {
      exitPct = profitPct; exitTime = b.time; exitReason = 'profit'; break;
    }
  }
  if (exitPct === null) {
    // 청산 시점에 마지막 close
    const last = post[post.length-1];
    exitPct = (last.close/entryPrice-1)*100; exitTime = last.time; exitReason = 'time';
  }
  // partial half 익절 + 나머지
  let totalPct = exitPct;
  if (halfExited && exitReason !== 'stop') {
    totalPct = (halfExitPct + exitPct) / 2;  // 50% partial + 50% rest
  } else if (halfExited && exitReason === 'stop') {
    totalPct = (halfExitPct + stopPct) / 2;
  }
  return { exitPct: Number(exitPct.toFixed(2)), exitTime, exitReason, totalPct: Number(totalPct.toFixed(2)), halfExited };
}

function runDay(targetDate, metaMap, qvaMap) {
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
    for (let i = baseIdx - 20; i < baseIdx; i++) {
      const r = rows[i];
      if (r && r.volume > 0) { sum += (r.valueApprox || 0); n++; }
    }
    const avg20 = n > 0 ? sum/n : 0;
    const baseRow = rows[baseIdx];
    const prevRow = baseIdx > 0 ? rows[baseIdx - 1] : null;
    const dayRow = rows[dayIdx];
    const baseValue = (baseRow && baseRow.valueApprox) || 0;
    const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) continue;
    let bars;
    try { bars = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8')).bars || []; } catch (_) { continue; }
    const m = scanner.computeMetrics0930(bars, baseRow);
    if (!m) continue;
    if (!isReady(m)) continue;
    const ex = computeExtended(bars, baseRow, prevRow);
    const recentQva = qvaMap.get(code) || false;
    const perf = measure(bars, m.last0930, dayRow);
    if (!perf) continue;
    const post = bars.filter((b) => b.time > '09:30' && b.time <= '10:00' && b.close > 0);
    const entry0931Open = post.length > 0 ? post[0].open : m.last0930;
    const scores = {
      V1: Number(expV1(m).toFixed(2)),
      V2: Number(expV2(m, meta).toFixed(2)),
      V3: Number(expV3(m, meta, ex).toFixed(2)),
      V4: Number(expV4(m, meta, ex, recentQva).toFixed(2)),
    };
    // 전략 시뮬레이션 (09:30 close 진입)
    const strat = {
      A: simulateStrategy(bars, m.last0930, 3, -1),
      B: simulateStrategy(bars, m.last0930, 5, -2),
      C: simulateStrategy(bars, m.last0930, 7, -3),
      D: simulateStrategy(bars, m.last0930, 10, -3),
      E: simulateStrategy(bars, m.last0930, 7, -2, 2),
      F: simulateStrategy(bars, m.last0930, 10, -3, 2),
    };
    entries.push({ code, name: chart.name || meta.name || code, marketCap: meta.marketCap,
      metrics: { closePosition0930: m.closePosition0930, highToLastDrop: m.highToLastDrop, openToLastRate: m.openToLastRate, valueToAvgRatio_0930: m.valueToAvgRatio_0930, value_0930: m.value_0930, rebreakMorningHigh: m.rebreakMorningHigh, last0930: m.last0930 },
      extended: ex, perf, scores, strat, entry0931Open, recentQva,
    });
  }
  return { date: targetDate, entries };
}

function summarizePool(entries) {
  const n = entries.length;
  if (n === 0) return { n: 0 };
  const avg = (a) => a.reduce((s, x) => s+x, 0)/a.length;
  return {
    n,
    avgMFE_1000: Number(avg(entries.map((e) => e.perf.maxReturn1000)).toFixed(2)),
    avgMAE_1000: Number(avg(entries.map((e) => e.perf.minReturn1000)).toFixed(2)),
    avgReturnAt1000: Number(avg(entries.map((e) => e.perf.returnAt1000)).toFixed(2)),
    avgDayMax: Number(avg(entries.filter((e) => e.perf.dayMax != null).map((e) => e.perf.dayMax)).toFixed(2)),
    avgDayClose: Number(avg(entries.filter((e) => e.perf.dayClose != null).map((e) => e.perf.dayClose)).toFixed(2)),
    hit3Rate: Number((entries.filter((e) => e.perf.hit3).length/n*100).toFixed(1)),
    hit5Rate: Number((entries.filter((e) => e.perf.hit5).length/n*100).toFixed(1)),
    hit7Rate: Number((entries.filter((e) => e.perf.hit7).length/n*100).toFixed(1)),
    hit10Rate: Number((entries.filter((e) => e.perf.hit10).length/n*100).toFixed(1)),
    hit15Rate: Number((entries.filter((e) => e.perf.hit15).length/n*100).toFixed(1)),
    dayHit5Rate: Number((entries.filter((e) => e.perf.dayHit5).length/n*100).toFixed(1)),
    dayHit7Rate: Number((entries.filter((e) => e.perf.dayHit7).length/n*100).toFixed(1)),
    dayHit10Rate: Number((entries.filter((e) => e.perf.dayHit10).length/n*100).toFixed(1)),
    dayHit15Rate: Number((entries.filter((e) => e.perf.dayHit15).length/n*100).toFixed(1)),
    fail1Rate: Number((entries.filter((e) => e.perf.fail1).length/n*100).toFixed(1)),
    fail2Rate: Number((entries.filter((e) => e.perf.fail2).length/n*100).toFixed(1)),
    fail3Rate: Number((entries.filter((e) => e.perf.fail3).length/n*100).toFixed(1)),
    firstHit5BeforeFail2: Number((entries.filter((e) => e.perf.firstHit5BeforeFail2).length/n*100).toFixed(1)),
    firstHit7BeforeFail3: Number((entries.filter((e) => e.perf.firstHit7BeforeFail3).length/n*100).toFixed(1)),
    firstHit10BeforeFail3: Number((entries.filter((e) => e.perf.firstHit10BeforeFail3).length/n*100).toFixed(1)),
    // 전략별 기대값 (평균 손익)
    stratA_ev: Number(avg(entries.map((e) => e.strat.A.totalPct)).toFixed(2)),
    stratB_ev: Number(avg(entries.map((e) => e.strat.B.totalPct)).toFixed(2)),
    stratC_ev: Number(avg(entries.map((e) => e.strat.C.totalPct)).toFixed(2)),
    stratD_ev: Number(avg(entries.map((e) => e.strat.D.totalPct)).toFixed(2)),
    stratE_ev: Number(avg(entries.map((e) => e.strat.E.totalPct)).toFixed(2)),
    stratF_ev: Number(avg(entries.map((e) => e.strat.F.totalPct)).toFixed(2)),
  };
}

function loadQvaMap() {
  // 전일 QVA/VVI 이력 — pattern-result.json 또는 board json. 단순화: cache/pattern-result.json
  const p = path.join(ROOT, 'cache', 'pattern-result.json');
  const map = new Map();
  if (!fs.existsSync(p)) return map;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const list = j.results || j.stocks || [];
    for (const s of list) {
      if (!s.code) continue;
      const hasQva = !!(s.qvaSignalDate || s.latestEarlyQvaDate || s.vviRecentDate);
      if (hasQva) map.set(s.code, true);
    }
  } catch (_) {}
  return map;
}

function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log('\n💥 1DS 09:30 폭발형 백테스트 시작');
  const dates = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => fs.readdirSync(path.join(INTRADAY_BASE, d)).length >= 100)
    .sort();
  console.log(`  대상: ${dates.length}일 (${dates[0]} ~ ${dates[dates.length-1]})`);
  const metaMap = scanner.loadStockMetaMap();
  const qvaMap = loadQvaMap();
  console.log(`  메타 ${metaMap.size}건 / QVA 이력 ${qvaMap.size}건`);

  const dayResults = [];
  for (const d of dates) {
    const r = runDay(d, metaMap, qvaMap);
    if (!r) continue;
    dayResults.push(r);
    process.stdout.write(`  ${d}: READY ${r.entries.length}\n`);
  }

  // 풀 집계
  const allReady = []; for (const d of dayResults) for (const e of d.entries) allReady.push(e);
  const pools = {
    READY_ALL: allReady,
    READY_TOP5_V1: [], READY_TOP5_V2: [], READY_TOP5_V3: [], READY_TOP5_V4: [],
    READY_TOP10_V1: [], READY_TOP10_V4: [],
    READY_REBREAK: allReady.filter((e) => e.metrics.rebreakMorningHigh),
    READY_VMC10_PLUS: allReady.filter((e) => (e.metrics.value_0930||0) >= 1e10),
  };
  for (const d of dayResults) {
    for (const V of ['V1','V2','V3','V4']) {
      const sorted = [...d.entries].sort((a,b) => b.scores[V] - a.scores[V]);
      pools['READY_TOP5_'+V].push(...sorted.slice(0, 5));
      if (V === 'V1' || V === 'V4') pools['READY_TOP10_'+V].push(...sorted.slice(0, 10));
    }
  }
  const summaries = {};
  for (const k of Object.keys(pools)) summaries[k] = summarizePool(pools[k]);

  // +10% 종목 공통점 — 일봉 dayMax >= 10인 것들
  const explosive10 = allReady.filter((e) => e.perf.dayHit10);
  const explosive10Detail = explosive10.map((e) => ({
    code: e.code, name: e.name, dayMax: e.perf.dayMax, dayClose: e.perf.dayClose,
    score_V1: e.scores.V1, score_V4: e.scores.V4,
    closePosition0930: e.metrics.closePosition0930,
    highToLastDrop: e.metrics.highToLastDrop,
    openToLastRate: e.metrics.openToLastRate,
    valueToAvgRatio_0930: e.metrics.valueToAvgRatio_0930,
    rebreakMorningHigh: e.metrics.rebreakMorningHigh,
    last5HighRatio: e.extended && e.extended.last5HighRatio,
    volumeFadeRatio: e.extended && e.extended.volumeFadeRatio,
    highIn0915: e.extended && e.extended.highIn0915,
    gapRate: e.extended && e.extended.gapRate,
    prevDayChangeRate: e.extended && e.extended.prevDayChangeRate,
    marketCap_억: Math.round((e.marketCap||0)/1e8),
    recentQva: e.recentQva,
  }));

  // 오늘 (TODAY_FOCUS) 5/14 상세
  const TODAY_FOCUS = '2026-05-14';
  const today = dayResults.find((d) => d.date === TODAY_FOCUS);
  const todayDetail = {};
  if (today) {
    for (const V of ['V1','V2','V3','V4']) {
      const sorted = [...today.entries].sort((a,b) => b.scores[V] - a.scores[V]);
      todayDetail[V] = sorted.slice(0, 5).map((e) => ({
        rank: sorted.indexOf(e)+1,
        code: e.code, name: e.name, score: e.scores[V],
        perf: e.perf, strat: e.strat,
      }));
    }
  }

  const elapsedSec = ((Date.now()-t0)/1000).toFixed(2);
  const out = {
    meta: {
      title: '1DS 09:30 폭발형 백테스트',
      generatedAt: new Date().toISOString(), elapsedSec,
      eligibleDates: dates, eligibleDayCount: dates.length,
      todayFocus: TODAY_FOCUS,
      methodology: '09:30~10:00 분봉 + 당일 일봉(09:30~15:30 전체)으로 max 측정. 11:30 구간은 분봉 미보유로 측정 불가.',
      strategyDefs: {
        A: '+3%/-1% 10:00 청산',
        B: '+5%/-2% 11:30 청산 (실측 10:00)',
        C: '+7%/-3% 11:30 청산 (실측 10:00)',
        D: '+10%/-3% 당일 청산 (실측 10:00)',
        E: '+2% 절반 익절 후 +7% 목표 / -2% 손절',
        F: '+2% 절반 익절 후 +10% 목표 / -3% 손절',
      },
    },
    summaries,
    explosive10: { count: explosive10.length, list: explosive10Detail },
    todayDetail,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  // 콘솔 요약
  console.log('\n📋 풀별 폭발 성과 (당일 일봉 기준):');
  const hdr = ['Pool', 'n', 'avgDayMax', 'day5%', 'day7%', 'day10%', 'day15%', 'avgClose', '5<f2', '7<f3', '10<f3'];
  console.log('  ' + hdr.map(h => String(h).padStart(11)).join(' '));
  for (const k of ['READY_ALL','READY_TOP5_V1','READY_TOP5_V4','READY_REBREAK','READY_VMC10_PLUS']) {
    const s = summaries[k];
    if (!s.n) continue;
    console.log('  ' + [k, s.n, s.avgDayMax+'%', s.dayHit5Rate+'%', s.dayHit7Rate+'%', s.dayHit10Rate+'%', s.dayHit15Rate+'%', s.avgDayClose+'%', s.firstHit5BeforeFail2+'%', s.firstHit7BeforeFail3+'%', s.firstHit10BeforeFail3+'%'].map(c => String(c).padStart(11)).join(' '));
  }
  console.log('\n📋 전략별 평균 기대값(% per trade) — TOP5_V1:');
  const s = summaries.READY_TOP5_V1;
  console.log('  A(+3/-1/10:00): '+s.stratA_ev+'% / B(+5/-2): '+s.stratB_ev+'% / C(+7/-3): '+s.stratC_ev+'% / D(+10/-3): '+s.stratD_ev+'% / E(half@+2/+7/-2): '+s.stratE_ev+'% / F(half@+2/+10/-3): '+s.stratF_ev+'%');
  console.log('\n💥 +10% 종목 (당일 dayMax≥10%): ' + explosive10.length + '건');
  for (const e of explosive10Detail.slice(0, 15)) {
    console.log('  '+e.code+' '+(e.name||'').padEnd(15)+' dayMax='+e.dayMax+'% dayClose='+e.dayClose+'% V4='+e.score_V4+' cp='+e.closePosition0930+' drop='+e.highToLastDrop+' open='+e.openToLastRate+' rebreak='+(e.rebreakMorningHigh?1:0)+' QVA='+(e.recentQva?1:0));
  }
  console.log('\n  ⏱ 소요 '+elapsedSec+'s');
  console.log('✅ JSON: '+OUT_JSON);
  console.log('✅ HTML: '+OUT_HTML);
}

function buildHtml(out) {
  const fmt = (v, k) => v == null || v[k] == null ? '-' : v[k];
  const summary = out.summaries;
  const poolRow = (label, key) => {
    const v = summary[key]; if (!v || !v.n) return '<tr><td>'+label+'</td><td>0</td><td colspan="11">데이터 없음</td></tr>';
    return '<tr><td>'+label+'</td><td>'+v.n+'</td>' +
      '<td class="num">'+v.avgDayMax+'%</td>' +
      '<td class="num">'+v.avgDayClose+'%</td>' +
      '<td class="num pos">'+v.dayHit5Rate+'%</td>' +
      '<td class="num pos">'+v.dayHit7Rate+'%</td>' +
      '<td class="num pos">'+v.dayHit10Rate+'%</td>' +
      '<td class="num pos">'+v.dayHit15Rate+'%</td>' +
      '<td class="num neg">'+v.fail1Rate+'%</td>' +
      '<td class="num neg">'+v.fail2Rate+'%</td>' +
      '<td class="num neg">'+v.fail3Rate+'%</td>' +
      '<td class="num strong">'+v.firstHit5BeforeFail2+'%</td>' +
      '<td class="num strong">'+v.firstHit10BeforeFail3+'%</td></tr>';
  };
  const head = '<thead><tr><th>풀</th><th>n</th><th>avg dayMax</th><th>avg dayClose</th><th>day+5%</th><th>day+7%</th><th>day+10%</th><th>day+15%</th><th>-1%</th><th>-2%</th><th>-3%</th><th>h5&lt;f2</th><th>h10&lt;f3</th></tr></thead>';

  const stratHead = '<thead><tr><th>풀</th><th>n</th><th>A +3/-1</th><th>B +5/-2</th><th>C +7/-3</th><th>D +10/-3</th><th>E half+2/+7/-2</th><th>F half+2/+10/-3</th></tr></thead>';
  const stratRow = (label, key) => {
    const v = summary[key]; if (!v || !v.n) return '';
    return '<tr><td>'+label+'</td><td>'+v.n+'</td>' +
      '<td class="num">'+v.stratA_ev+'%</td>' +
      '<td class="num">'+v.stratB_ev+'%</td>' +
      '<td class="num">'+v.stratC_ev+'%</td>' +
      '<td class="num">'+v.stratD_ev+'%</td>' +
      '<td class="num">'+v.stratE_ev+'%</td>' +
      '<td class="num">'+v.stratF_ev+'%</td></tr>';
  };

  // 결론
  let bestPool = 'READY_TOP5_V1', bestVal = -Infinity;
  for (const k of ['READY_TOP5_V1','READY_TOP5_V2','READY_TOP5_V3','READY_TOP5_V4']) {
    const s = summary[k]; if (!s.n) continue;
    const composite = s.dayHit10Rate*2 + s.dayHit7Rate - s.fail3Rate*0.5;
    if (composite > bestVal) { bestVal = composite; bestPool = k; }
  }
  let bestStrat = 'A', bestStratVal = -Infinity;
  for (const k of ['A','B','C','D','E','F']) {
    const v = summary[bestPool]['strat'+k+'_ev'];
    if (v > bestStratVal) { bestStratVal = v; bestStrat = k; }
  }

  // +10% 종목 리스트
  const ex10 = out.explosive10.list || [];
  const ex10Table = ex10.length === 0 ? '<p class="muted">+10% 도달 종목 없음</p>' :
    '<table><thead><tr><th>코드</th><th>종목</th><th>dayMax</th><th>dayClose</th><th>V1</th><th>V4</th><th>cp</th><th>drop</th><th>open%</th><th>v/avg</th><th>rebreak</th><th>last5HR</th><th>vfade</th><th>highIn15</th><th>gap</th><th>D-1%</th><th>시총억</th><th>QVA</th></tr></thead><tbody>' +
    ex10.map((e) => '<tr>' +
      '<td>'+e.code+'</td><td>'+e.name+'</td>' +
      '<td class="num pos">'+e.dayMax+'%</td>' +
      '<td class="num">'+e.dayClose+'%</td>' +
      '<td class="num">'+e.score_V1+'</td>' +
      '<td class="num">'+e.score_V4+'</td>' +
      '<td class="num">'+e.closePosition0930+'</td>' +
      '<td class="num">'+e.highToLastDrop+'</td>' +
      '<td class="num">'+e.openToLastRate+'</td>' +
      '<td class="num">'+e.valueToAvgRatio_0930+'</td>' +
      '<td>'+(e.rebreakMorningHigh?'✓':'·')+'</td>' +
      '<td class="num">'+(e.last5HighRatio||'-')+'</td>' +
      '<td class="num">'+(e.volumeFadeRatio||'-')+'</td>' +
      '<td>'+(e.highIn0915?'⚠':'·')+'</td>' +
      '<td class="num">'+(e.gapRate||'-')+'</td>' +
      '<td class="num">'+(e.prevDayChangeRate||'-')+'</td>' +
      '<td class="num">'+e.marketCap_억+'</td>' +
      '<td>'+(e.recentQva?'✓':'·')+'</td></tr>').join('') +
    '</tbody></table>';

  // 오늘 V1~V4 TOP5
  const todayDetail = out.todayDetail || {};
  const todaySection = ['V1','V2','V3','V4'].map((V) => {
    const list = todayDetail[V] || []; if (list.length === 0) return '';
    return '<h4>'+V+' TOP5</h4><table><thead><tr><th>rank</th><th>코드</th><th>종목</th><th>score</th><th>10:00 max</th><th>10:00 min</th><th>@10:00</th><th>dayMax</th><th>dayClose</th></tr></thead><tbody>' +
      list.map((e) => '<tr><td>'+e.rank+'</td><td>'+e.code+'</td><td>'+e.name+'</td><td class="num">'+e.score+'</td><td class="num pos">'+e.perf.maxReturn1000+'%</td><td class="num neg">'+e.perf.minReturn1000+'%</td><td class="num">'+e.perf.returnAt1000+'%</td><td class="num pos">'+(e.perf.dayMax||'-')+'%</td><td class="num">'+(e.perf.dayClose||'-')+'%</td></tr>').join('') +
      '</tbody></table>';
  }).join('');

  return '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>1DS 폭발형 백테스트</title><style>\n' +
    'body{margin:0 auto;padding:20px;max-width:1500px;font-family:-apple-system,"Segoe UI","Noto Sans KR",sans-serif;background:#0f172a;color:#e2e8f0;font-size:13px;line-height:1.6;}\n' +
    'h1,h2,h3,h4{color:#f1f5f9;}h2{color:#fcd34d;border-bottom:1px solid #f59e0b;padding-bottom:6px;margin:22px 0 10px;}h4{color:#cbd5e1;margin:12px 0 6px;}\n' +
    '.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:14px 18px;margin:12px 0;}\n' +
    '.conclusion{background:linear-gradient(135deg,#422006 0%,#0f172a 100%);border:2px solid #f59e0b;}\n' +
    'table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-variant-numeric:tabular-nums;font-size:11.5px;}\n' +
    'th,td{padding:6px 9px;border:1px solid #334155;}\n' +
    'th{background:#1e293b;color:#cbd5e1;font-weight:700;}\n' +
    'td.num{text-align:right;}\n' +
    '.pos{color:#6ee7b7;}.neg{color:#fca5a5;}.strong{color:#fcd34d;font-weight:700;}.muted{color:#94a3b8;}\n' +
    '.note{font-size:11px;color:#94a3b8;font-style:italic;}\n' +
    '</style></head><body>\n' +
    '<h1>💥 1DS 09:30 폭발형 백테스트</h1>\n' +
    '<div class="note">'+out.meta.eligibleDayCount+'일 ('+out.meta.eligibleDates[0]+' ~ '+out.meta.eligibleDates[out.meta.eligibleDates.length-1]+') · 소요 '+out.meta.elapsedSec+'s · 11:30 구간 측정은 분봉 미보유로 생략 (당일 일봉 max로 대체).</div>\n' +

    '<div class="card conclusion">\n' +
    '<h2 style="margin-top:0;">📌 결론</h2>\n' +
    '<p><strong>최적 풀</strong>: '+bestPool+' (avgDayMax '+summary[bestPool].avgDayMax+'%, day+10% '+summary[bestPool].dayHit10Rate+'%)</p>\n' +
    '<p><strong>최적 전략</strong> ('+bestPool+'): '+bestStrat+' = 평균 손익 '+bestStratVal.toFixed(2)+'% / trade</p>\n' +
    '<p>총 +10% 도달 종목: <strong>'+out.explosive10.count+'건</strong> (READY_ALL '+summary.READY_ALL.n+'개 중 '+summary.READY_ALL.dayHit10Rate+'%)</p>\n' +
    '</div>\n' +

    '<h2>1. 풀별 폭발 성과 (당일 일봉 기준)</h2>\n<div class="card"><table>'+head+'<tbody>' +
    poolRow('READY 전체', 'READY_ALL') +
    poolRow('READY TOP5 (V1 기존)', 'READY_TOP5_V1') +
    poolRow('READY TOP5 (V2 시총가산)', 'READY_TOP5_V2') +
    poolRow('READY TOP5 (V3 거래대금추세)', 'READY_TOP5_V3') +
    poolRow('READY TOP5 (V4 QVA겹침)', 'READY_TOP5_V4') +
    poolRow('READY TOP10 (V1)', 'READY_TOP10_V1') +
    poolRow('READY TOP10 (V4)', 'READY_TOP10_V4') +
    poolRow('READY morningHigh 재돌파', 'READY_REBREAK') +
    poolRow('READY value ≥ 100억', 'READY_VMC10_PLUS') +
    '</tbody></table>\n<div class="note">avg dayMax/dayClose는 당일 09:30 close 대비 일봉 high/close 평균.</div></div>\n' +

    '<h2>2. 전략별 평균 손익 (% per trade) — TOP5 기준</h2>\n<div class="card"><table>'+stratHead+'<tbody>' +
    stratRow('READY 전체', 'READY_ALL') +
    stratRow('TOP5 V1', 'READY_TOP5_V1') +
    stratRow('TOP5 V4', 'READY_TOP5_V4') +
    stratRow('TOP10 V1', 'READY_TOP10_V1') +
    stratRow('TOP10 V4', 'READY_TOP10_V4') +
    stratRow('morningHigh 재돌파', 'READY_REBREAK') +
    '</tbody></table>\n<div class="note">전략 A~F의 실제 시뮬레이션 결과 평균 % (음수=손실). 09:30~10:00 분봉만 사용, 그 후 시점 청산은 분봉 미보유로 추정 불가.</div></div>\n' +

    '<h2>3. +10% 도달 종목 ('+out.explosive10.count+'건) — 공통점 분석</h2>\n<div class="card">'+ex10Table+'\n<div class="note">당일 일봉 high가 09:30 close 대비 +10% 이상 도달한 종목들. 공통 특성을 보고 폭발형 score 보강 단서로 활용.</div></div>\n' +

    (todaySection ? '<h2>4. 5/14 V1~V4 TOP5 실제 구성</h2>\n<div class="card">'+todaySection+'</div>\n' : '') +

    '</body></html>';
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}
module.exports = { main, runDay };
