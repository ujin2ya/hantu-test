#!/usr/bin/env node
/**
 * 폭발형 섹션 실제 조건 검증
 *
 * 보드에 추가된 explosiveTop/explosiveWatch 조건이 백테스트적으로 우수한지 검증.
 *
 * 조건 (현재 보드 적용):
 *   passesExplosive(m) = rebreakMorningHigh ∧ cp≥0.85 ∧ value_0930≥100억
 *   explosiveScore = finalScore + (open∈[3,8] 가산 5) + (drop≥-1 가산 3) − (open>8 감점 5)
 *
 * 풀:
 *   1. READY_ALL          — 모든 READY
 *   2. READY_TOP5         — finalScore 상위 5 (기존 운영)
 *   3. explosiveTop       — READY ∩ 조건, explosiveScore 상위 5
 *   4. explosiveWatch     — WAIT_PULLBACK ∩ 조건, explosiveScore 상위 5
 *   5. explosiveTop+Watch — 합산
 *   6. value≥100억 단독   — READY ∩ value≥100억
 *   7. rebreak 단독       — READY ∩ rebreakMorningHigh
 *   8. cp≥0.85 단독       — READY ∩ cp≥0.85
 *
 * 출력: reports/one-day-surge-0930-explosive-section-validation-result.{json,html}
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-0930-explosive-section-validation-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-0930-explosive-section-validation-result.html');
const scanner = require('./one-day-surge-0930-scanner');

const TODAY_FOCUS = '2026-05-14';

// status 분류 (Rule A) — 보드와 동일
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

// passesExplosive — 보드 코드와 동일
function passesExplosive(m) {
  if (!m || !m.rebreakMorningHigh) return false;
  if ((m.closePosition0930 || 0) < 0.85) return false;
  if ((m.value_0930 || 0) < 1e10) return false;
  return true;
}
function explosiveScore(m, baseFinal) {
  let s = baseFinal || 0;
  const o = m.openToLastRate || 0;
  if (o >= 3 && o <= 8) s += 5;
  if (o > 8) s -= 5;
  if ((m.highToLastDrop || 0) >= -1) s += 3;
  return Number(s.toFixed(2));
}

// 09:30~10:00 분봉 + 당일 일봉으로 성과
function measure(bars, entryPrice, dayRow) {
  if (!bars || !Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const post = bars.filter((b) => b.time > '09:30' && b.time <= '10:00' && b.close > 0);
  if (post.length === 0) return null;
  let maxHi = -Infinity, minLo = Infinity;
  let firstHit3=null, firstHit5=null, firstHit7=null, firstHit10=null, firstHit15=null;
  let firstFail1=null, firstFail2=null, firstFail3=null;
  for (const b of post) {
    if (b.high > maxHi) maxHi = b.high;
    if (b.low < minLo) minLo = b.low;
    const hi = (b.high/entryPrice-1)*100;
    const lo = (b.low /entryPrice-1)*100;
    if (firstHit3===null  && hi>=3)  firstHit3=b.time;
    if (firstHit5===null  && hi>=5)  firstHit5=b.time;
    if (firstHit7===null  && hi>=7)  firstHit7=b.time;
    if (firstHit10===null && hi>=10) firstHit10=b.time;
    if (firstHit15===null && hi>=15) firstHit15=b.time;
    if (firstFail1===null && lo<=-1) firstFail1=b.time;
    if (firstFail2===null && lo<=-2) firstFail2=b.time;
    if (firstFail3===null && lo<=-3) firstFail3=b.time;
  }
  const close1000 = post[post.length-1].close;
  const dayMaxPct = dayRow && dayRow.high > 0 ? (dayRow.high/entryPrice-1)*100 : null;
  const dayMinPct = dayRow && dayRow.low  > 0 ? (dayRow.low /entryPrice-1)*100 : null;
  const dayClosePct = dayRow && dayRow.close > 0 ? (dayRow.close/entryPrice-1)*100 : null;
  return {
    maxReturn1000: Number(((maxHi/entryPrice-1)*100).toFixed(2)),
    minReturn1000: Number(((minLo/entryPrice-1)*100).toFixed(2)),
    returnAt1000: Number(((close1000/entryPrice-1)*100).toFixed(2)),
    dayMax: dayMaxPct != null ? Number(dayMaxPct.toFixed(2)) : null,
    dayMin: dayMinPct != null ? Number(dayMinPct.toFixed(2)) : null,
    dayClose: dayClosePct != null ? Number(dayClosePct.toFixed(2)) : null,
    hit3: firstHit3!==null, hit5: firstHit5!==null, hit7: firstHit7!==null, hit10: firstHit10!==null, hit15: firstHit15!==null,
    fail1: firstFail1!==null, fail2: firstFail2!==null, fail3: firstFail3!==null,
    firstHit5BeforeFail2:  firstHit5!==null  && (firstFail2===null || firstHit5  < firstFail2),
    firstHit7BeforeFail3:  firstHit7!==null  && (firstFail3===null || firstHit7  < firstFail3),
    firstHit10BeforeFail3: firstHit10!==null && (firstFail3===null || firstHit10 < firstFail3),
    dayHit3:  dayMaxPct != null && dayMaxPct >= 3,
    dayHit5:  dayMaxPct != null && dayMaxPct >= 5,
    dayHit7:  dayMaxPct != null && dayMaxPct >= 7,
    dayHit10: dayMaxPct != null && dayMaxPct >= 10,
    dayHit15: dayMaxPct != null && dayMaxPct >= 15,
    closePositive: dayClosePct != null && dayClosePct > 0,
  };
}

// 전략 시뮬레이션 (09:31~10:00 분봉만으로 — 그 후 청산은 일봉 close로)
function simulate(bars, entryPrice, profitPct, stopPct, partialPct, dayRow) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const post = bars.filter((b) => b.time > '09:30' && b.time <= '10:00' && b.close > 0);
  if (post.length === 0) return null;
  let exitPct = null, exitReason = null, halfPct = null;
  for (const b of post) {
    const hi = (b.high/entryPrice-1)*100;
    const lo = (b.low /entryPrice-1)*100;
    if (lo <= stopPct) { exitPct = stopPct; exitReason = 'stop'; break; }
    if (partialPct != null && halfPct == null && hi >= partialPct) halfPct = partialPct;
    if (hi >= profitPct) { exitPct = profitPct; exitReason = 'profit'; break; }
  }
  if (exitPct === null) {
    // 10:00 미달성 — 일봉 close까지 보유 (분봉 미보유 구간은 일봉 close로 대체)
    const dayCloseRet = dayRow && dayRow.close > 0 ? (dayRow.close/entryPrice-1)*100 : (post[post.length-1].close/entryPrice-1)*100;
    exitPct = dayCloseRet; exitReason = 'dayClose';
  }
  // half 부분익절: 절반은 partialPct, 절반은 exitPct
  let total = exitPct;
  if (halfPct != null) total = (halfPct + exitPct) / 2;
  return { exitPct: Number(exitPct.toFixed(2)), exitReason, totalPct: Number(total.toFixed(2)), halfExited: halfPct != null };
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
    for (let i = baseIdx - 20; i < baseIdx; i++) {
      const r = rows[i]; if (r && r.volume > 0) { sum += (r.valueApprox||0); n++; }
    }
    const avg20 = n > 0 ? sum/n : 0;
    const baseRow = rows[baseIdx];
    const dayRow = rows[dayIdx];
    const baseValue = (baseRow && baseRow.valueApprox) || 0;
    const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) continue;
    let bars;
    try { bars = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8')).bars || []; } catch (_) { continue; }
    const m = scanner.computeMetrics0930(bars, baseRow);
    if (!m) continue;
    const status = classifyStatus(m);
    if (status !== 'READY' && status !== 'WAIT_PULLBACK') continue;  // 두 풀만 다룸
    const perf = measure(bars, m.last0930, dayRow);
    if (!perf) continue;
    const fScore = scanner.computeFinalScore(m);
    const eScore = explosiveScore(m, fScore);
    const passesExp = passesExplosive(m);
    const strat = {
      B: simulate(bars, m.last0930, 5, -2, null, dayRow),
      C: simulate(bars, m.last0930, 7, -3, null, dayRow),
      D: simulate(bars, m.last0930, 10, -3, null, dayRow),
      E: simulate(bars, m.last0930, 7, -2, 2, dayRow),
      F: simulate(bars, m.last0930, 10, -3, 2, dayRow),
    };
    entries.push({
      code, name: chart.name || meta.name || code, marketCap: meta.marketCap,
      status, perf, strat,
      finalScore: fScore, explosiveScoreVal: eScore, passesExplosive: passesExp,
      metrics: {
        closePosition0930: m.closePosition0930, highToLastDrop: m.highToLastDrop,
        openToLastRate: m.openToLastRate, value_0930: m.value_0930,
        valueToAvgRatio_0930: m.valueToAvgRatio_0930, rebreakMorningHigh: m.rebreakMorningHigh,
        last0930: m.last0930,
      },
    });
  }
  return { date: targetDate, entries };
}

function summarizePool(entries) {
  const n = entries.length;
  if (n === 0) return { n: 0 };
  const avg = (a) => a.length ? a.reduce((s, x) => s+x, 0)/a.length : 0;
  const med = (sorted) => sorted.length === 0 ? 0 : sorted.length % 2 === 0
    ? (sorted[sorted.length/2-1] + sorted[sorted.length/2])/2 : sorted[(sorted.length-1)/2];
  const dayMaxs = entries.filter((e) => e.perf.dayMax != null).map((e) => e.perf.dayMax).sort((a,b)=>a-b);
  return {
    n,
    avgDayMax: Number(avg(dayMaxs).toFixed(2)),
    medianDayMax: Number(med(dayMaxs).toFixed(2)),
    avgDayClose: Number(avg(entries.filter((e) => e.perf.dayClose != null).map((e) => e.perf.dayClose)).toFixed(2)),
    avgMaxReturn1000: Number(avg(entries.map((e) => e.perf.maxReturn1000)).toFixed(2)),
    avgReturnAt1000: Number(avg(entries.map((e) => e.perf.returnAt1000)).toFixed(2)),
    dayHit3Rate:  Number((entries.filter((e) => e.perf.dayHit3 ).length/n*100).toFixed(1)),
    dayHit5Rate:  Number((entries.filter((e) => e.perf.dayHit5 ).length/n*100).toFixed(1)),
    dayHit7Rate:  Number((entries.filter((e) => e.perf.dayHit7 ).length/n*100).toFixed(1)),
    dayHit10Rate: Number((entries.filter((e) => e.perf.dayHit10).length/n*100).toFixed(1)),
    dayHit15Rate: Number((entries.filter((e) => e.perf.dayHit15).length/n*100).toFixed(1)),
    fail1Rate: Number((entries.filter((e) => e.perf.fail1).length/n*100).toFixed(1)),
    fail2Rate: Number((entries.filter((e) => e.perf.fail2).length/n*100).toFixed(1)),
    fail3Rate: Number((entries.filter((e) => e.perf.fail3).length/n*100).toFixed(1)),
    firstHit5BeforeFail2:  Number((entries.filter((e) => e.perf.firstHit5BeforeFail2 ).length/n*100).toFixed(1)),
    firstHit7BeforeFail3:  Number((entries.filter((e) => e.perf.firstHit7BeforeFail3 ).length/n*100).toFixed(1)),
    firstHit10BeforeFail3: Number((entries.filter((e) => e.perf.firstHit10BeforeFail3).length/n*100).toFixed(1)),
    closePositiveRate: Number((entries.filter((e) => e.perf.closePositive).length/n*100).toFixed(1)),
    stratB_ev: Number(avg(entries.map((e) => e.strat.B.totalPct)).toFixed(2)),
    stratC_ev: Number(avg(entries.map((e) => e.strat.C.totalPct)).toFixed(2)),
    stratD_ev: Number(avg(entries.map((e) => e.strat.D.totalPct)).toFixed(2)),
    stratE_ev: Number(avg(entries.map((e) => e.strat.E.totalPct)).toFixed(2)),
    stratF_ev: Number(avg(entries.map((e) => e.strat.F.totalPct)).toFixed(2)),
  };
}

function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log('\n🚀 폭발형 섹션 조건 검증 시작');
  const dates = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => fs.readdirSync(path.join(INTRADAY_BASE, d)).length >= 100)
    .sort();
  console.log(`  대상: ${dates.length}일 (${dates[0]} ~ ${dates[dates.length-1]})`);
  const metaMap = scanner.loadStockMetaMap();
  console.log(`  메타: ${metaMap.size}건`);

  const dayResults = [];
  for (const d of dates) {
    const r = runDay(d, metaMap);
    if (!r) continue;
    dayResults.push(r);
  }

  // 8개 풀 집계
  const allReady = []; const allWait = [];
  for (const d of dayResults) for (const e of d.entries) {
    if (e.status === 'READY') allReady.push(e);
    else if (e.status === 'WAIT_PULLBACK') allWait.push(e);
  }

  // 일자별 explosiveTop / explosiveWatch / readyTop5 선정
  const readyTop5All = [], explosiveTopAll = [], explosiveWatchAll = [];
  const dailyExplosiveTopCount = [], dailyExplosiveWatchCount = [];
  for (const d of dayResults) {
    const dayReady = d.entries.filter((e) => e.status === 'READY');
    const dayWait  = d.entries.filter((e) => e.status === 'WAIT_PULLBACK');
    // readyTop5
    const sortedFinal = [...dayReady].sort((a, b) => b.finalScore - a.finalScore);
    for (const e of sortedFinal.slice(0, 5)) readyTop5All.push({ ...e, _date: d.date });
    // explosiveTop (READY ∩ 조건, exp score 정렬)
    const expReady = dayReady.filter((e) => e.passesExplosive).sort((a, b) => b.explosiveScoreVal - a.explosiveScoreVal);
    const expTop = expReady.slice(0, 5);
    for (const e of expTop) explosiveTopAll.push({ ...e, _date: d.date });
    dailyExplosiveTopCount.push({ date: d.date, n: expTop.length, total: expReady.length });
    // explosiveWatch (WAIT_PULLBACK ∩ 조건)
    const expWait = dayWait.filter((e) => e.passesExplosive).sort((a, b) => b.explosiveScoreVal - a.explosiveScoreVal);
    const expWatch = expWait.slice(0, 5);
    for (const e of expWatch) explosiveWatchAll.push({ ...e, _date: d.date });
    dailyExplosiveWatchCount.push({ date: d.date, n: expWatch.length, total: expWait.length });
  }

  const pools = {
    READY_ALL:           allReady,
    READY_TOP5_finalSc:  readyTop5All,
    explosiveTop:        explosiveTopAll,
    explosiveWatch:      explosiveWatchAll,
    explosiveTop_plus_Watch: [...explosiveTopAll, ...explosiveWatchAll],
    valueOver100억:      allReady.filter((e) => (e.metrics.value_0930||0) >= 1e10),
    rebreakOnly:         allReady.filter((e) => e.metrics.rebreakMorningHigh),
    cpOver85Only:        allReady.filter((e) => (e.metrics.closePosition0930||0) >= 0.85),
  };
  const summaries = {};
  for (const k of Object.keys(pools)) summaries[k] = summarizePool(pools[k]);

  // 일평균 / 0개 날짜 — explosiveTop / explosiveWatch
  const expTopDailyAvg = dailyExplosiveTopCount.reduce((s, x) => s+x.total, 0) / Math.max(1, dailyExplosiveTopCount.length);
  const expTopZeroDays = dailyExplosiveTopCount.filter((x) => x.total === 0).length;
  const expWatchDailyAvg = dailyExplosiveWatchCount.reduce((s, x) => s+x.total, 0) / Math.max(1, dailyExplosiveWatchCount.length);
  const expWatchZeroDays = dailyExplosiveWatchCount.filter((x) => x.total === 0).length;

  // 5/14 상세
  const today = dayResults.find((d) => d.date === TODAY_FOCUS);
  const todayDetail = {};
  if (today) {
    const dayReady = today.entries.filter((e) => e.status === 'READY');
    const dayWait  = today.entries.filter((e) => e.status === 'WAIT_PULLBACK');
    todayDetail.readyTop5 = [...dayReady].sort((a, b) => b.finalScore - a.finalScore).slice(0, 5).map((e) => ({
      code: e.code, name: e.name, finalScore: e.finalScore, expScore: e.explosiveScoreVal,
      passes: e.passesExplosive, m: e.metrics, perf: e.perf,
    }));
    todayDetail.explosiveTopCandidates = dayReady.filter((e) => e.passesExplosive).sort((a, b) => b.explosiveScoreVal - a.explosiveScoreVal).slice(0, 5).map((e) => ({
      code: e.code, name: e.name, expScore: e.explosiveScoreVal, m: e.metrics, perf: e.perf,
    }));
    todayDetail.explosiveWatchCandidates = dayWait.filter((e) => e.passesExplosive).sort((a, b) => b.explosiveScoreVal - a.explosiveScoreVal).slice(0, 5).map((e) => ({
      code: e.code, name: e.name, expScore: e.explosiveScoreVal, m: e.metrics, perf: e.perf,
    }));
    // explosiveTop 0개가 적절한 필터링인지: READY 후보 중 passesExp 결과
    todayDetail.explosiveFilterResult = {
      readyN: dayReady.length,
      passesExpInReady: dayReady.filter((e) => e.passesExplosive).length,
      passesExpInWait:  dayWait.filter((e) => e.passesExplosive).length,
    };
  }

  const elapsedSec = ((Date.now()-t0)/1000).toFixed(2);
  const out = {
    meta: {
      title: '폭발형 섹션 조건 검증',
      generatedAt: new Date().toISOString(), elapsedSec,
      eligibleDates: dates, eligibleDayCount: dates.length,
      todayFocus: TODAY_FOCUS,
      conditions: {
        passesExplosive: 'rebreakMorningHigh ∧ closePosition≥0.85 ∧ value_0930≥100억',
        explosiveScore: 'finalScore + (open∈[3,8] +5) + (drop≥-1 +3) − (open>8 -5)',
      },
      strategies: {
        B: '+5%/-2%, 10:00 미달성 시 일봉 close',
        C: '+7%/-3%, 10:00 미달성 시 일봉 close',
        D: '+10%/-3%',
        E: '+2% 절반 익절 후 +7% 목표 / -2% 손절',
        F: '+2% 절반 익절 후 +10% 목표 / -3% 손절',
      },
    },
    summaries,
    dailyExplosiveTopCount, dailyExplosiveWatchCount,
    expTopDailyAvg: Number(expTopDailyAvg.toFixed(2)),
    expTopZeroDays,
    expWatchDailyAvg: Number(expWatchDailyAvg.toFixed(2)),
    expWatchZeroDays,
    todayDetail,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  // 콘솔
  console.log('\n📋 8개 풀 성과 (일봉 dayMax 기준):');
  const cols = ['Pool', 'n', 'avgDayMax', 'medDayMax', 'day+3%', 'day+5%', 'day+7%', 'day+10%', 'day+15%', 'closeAvg', 'close+', 'fail3'];
  console.log('  ' + cols.map(c => String(c).padStart(11)).join(' '));
  for (const k of Object.keys(pools)) {
    const s = summaries[k]; if (!s.n) { console.log('  ' + k.padStart(11) + ' (0)'); continue; }
    console.log('  ' + [k, s.n, s.avgDayMax+'%', s.medianDayMax+'%', s.dayHit3Rate+'%', s.dayHit5Rate+'%', s.dayHit7Rate+'%', s.dayHit10Rate+'%', s.dayHit15Rate+'%', s.avgDayClose+'%', s.closePositiveRate+'%', s.fail3Rate+'%'].map(c => String(c).padStart(11)).join(' '));
  }

  console.log('\n📋 전략별 평균 손익 (% per trade):');
  const sHdr = ['Pool', 'n', 'B(+5/-2)', 'C(+7/-3)', 'D(+10/-3)', 'E(half/+7)', 'F(half/+10)'];
  console.log('  ' + sHdr.map(c => String(c).padStart(13)).join(' '));
  for (const k of Object.keys(pools)) {
    const s = summaries[k]; if (!s.n) continue;
    console.log('  ' + [k, s.n, s.stratB_ev+'%', s.stratC_ev+'%', s.stratD_ev+'%', s.stratE_ev+'%', s.stratF_ev+'%'].map(c => String(c).padStart(13)).join(' '));
  }

  console.log('\n📌 일별 후보 수 — explosiveTop 평균 ' + expTopDailyAvg.toFixed(2) + '/일, 0개인 날 ' + expTopZeroDays + '일');
  console.log('              — explosiveWatch 평균 ' + expWatchDailyAvg.toFixed(2) + '/일, 0개인 날 ' + expWatchZeroDays + '일');

  if (today) {
    console.log('\n📌 ' + TODAY_FOCUS + ' 상세:');
    console.log('  READY ' + todayDetail.explosiveFilterResult.readyN + '개, 폭발형 통과 READY ' + todayDetail.explosiveFilterResult.passesExpInReady + '개, WAIT 통과 ' + todayDetail.explosiveFilterResult.passesExpInWait + '개');
    console.log('  readyTop5 (finalScore):');
    for (const e of todayDetail.readyTop5) {
      console.log('    ' + e.code + ' ' + (e.name||'').padEnd(14) + ' final='+String(e.finalScore).padStart(7) + ' passesExp='+(e.passes?'✓':'·') + ' (cp='+e.m.closePosition0930+', value='+(e.m.value_0930/1e8).toFixed(0)+'억, rebreak='+(e.m.rebreakMorningHigh?1:0)+') | dayMax='+e.perf.dayMax+'% dayClose='+e.perf.dayClose+'%');
    }
    if (todayDetail.explosiveWatchCandidates.length > 0) {
      console.log('  explosiveWatch 5/14 결과:');
      for (const e of todayDetail.explosiveWatchCandidates) {
        console.log('    ' + e.code + ' ' + (e.name||'').padEnd(14) + ' exp='+String(e.expScore).padStart(7) + ' open='+e.m.openToLastRate+'% | dayMax='+e.perf.dayMax+'% dayClose='+e.perf.dayClose+'%');
      }
    }
  }
  console.log('\n  ⏱ 소요 '+elapsedSec+'s');
  console.log('✅ JSON: '+OUT_JSON);
  console.log('✅ HTML: '+OUT_HTML);
}

function buildHtml(out) {
  const s = out.summaries;
  const row = (label, key) => {
    const v = s[key]; if (!v || !v.n) return '<tr><td>'+label+'</td><td>0</td><td colspan="11">데이터 없음</td></tr>';
    return '<tr><td>'+label+'</td><td>'+v.n+'</td>' +
      '<td class="num">'+v.avgDayMax+'%</td><td class="num">'+v.medianDayMax+'%</td>' +
      '<td class="num pos">'+v.dayHit3Rate+'%</td><td class="num pos">'+v.dayHit5Rate+'%</td>' +
      '<td class="num pos">'+v.dayHit7Rate+'%</td><td class="num pos strong">'+v.dayHit10Rate+'%</td>' +
      '<td class="num pos">'+v.dayHit15Rate+'%</td>' +
      '<td class="num">'+v.avgDayClose+'%</td><td class="num">'+v.closePositiveRate+'%</td>' +
      '<td class="num neg">'+v.fail3Rate+'%</td></tr>';
  };
  const head = '<thead><tr><th>풀</th><th>n</th><th>avg dayMax</th><th>median dayMax</th><th>day+3%</th><th>day+5%</th><th>day+7%</th><th>day+10%</th><th>day+15%</th><th>avg close</th><th>close+</th><th>fail3</th></tr></thead>';

  const stratRow = (label, key) => {
    const v = s[key]; if (!v || !v.n) return '';
    return '<tr><td>'+label+'</td><td>'+v.n+'</td><td class="num">'+v.stratB_ev+'%</td><td class="num">'+v.stratC_ev+'%</td><td class="num">'+v.stratD_ev+'%</td><td class="num">'+v.stratE_ev+'%</td><td class="num">'+v.stratF_ev+'%</td></tr>';
  };
  const stratHead = '<thead><tr><th>풀</th><th>n</th><th>B +5/-2</th><th>C +7/-3</th><th>D +10/-3</th><th>E half/+7</th><th>F half/+10</th></tr></thead>';

  // 결론 — 종합 점수: dayHit5 + dayHit10 - fail3*0.4
  let best = 'explosiveTop', bestVal = -Infinity;
  for (const k of Object.keys(s)) {
    if (!s[k].n) continue;
    const composite = (s[k].dayHit5Rate || 0) + (s[k].dayHit10Rate || 0) * 2 - (s[k].fail3Rate || 0) * 0.4;
    if (composite > bestVal) { bestVal = composite; best = k; }
  }

  const today = out.todayDetail || {};
  const todayReadyTop5 = (today.readyTop5 || []).map((e) => '<tr>' +
    '<td>'+e.code+' '+e.name+'</td>' +
    '<td class="num">'+e.finalScore+'</td>' +
    '<td class="num">'+e.expScore+'</td>' +
    '<td>'+(e.passes?'<span class="pos">✓</span>':'<span class="muted">·</span>')+'</td>' +
    '<td class="num">'+e.m.closePosition0930+'</td>' +
    '<td class="num">'+(e.m.value_0930/1e8).toFixed(0)+'억</td>' +
    '<td>'+(e.m.rebreakMorningHigh?'✓':'·')+'</td>' +
    '<td class="num pos">'+(e.perf.dayMax||'-')+'%</td>' +
    '<td class="num">'+(e.perf.dayClose||'-')+'%</td>' +
    '</tr>').join('');
  const todayWatch = (today.explosiveWatchCandidates || []).map((e) => '<tr>' +
    '<td>'+e.code+' '+e.name+'</td>' +
    '<td class="num">'+e.expScore+'</td>' +
    '<td class="num">'+e.m.openToLastRate+'%</td>' +
    '<td class="num">'+e.m.closePosition0930+'</td>' +
    '<td class="num">'+(e.m.value_0930/1e8).toFixed(0)+'억</td>' +
    '<td class="num pos">'+(e.perf.dayMax||'-')+'%</td>' +
    '<td class="num">'+(e.perf.dayClose||'-')+'%</td>' +
    '</tr>').join('');

  return '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>폭발형 섹션 검증</title><style>\n' +
    'body{margin:0 auto;padding:20px;max-width:1500px;font-family:-apple-system,"Segoe UI","Noto Sans KR",sans-serif;background:#0f172a;color:#e2e8f0;font-size:13px;line-height:1.6;}\n' +
    'h1,h2,h3,h4{color:#f1f5f9;}h2{color:#fcd34d;border-bottom:1px solid #f59e0b;padding-bottom:6px;margin:22px 0 10px;}h4{color:#cbd5e1;margin:12px 0 6px;}\n' +
    '.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:14px 18px;margin:12px 0;}\n' +
    '.conclusion{background:linear-gradient(135deg,#422006 0%,#0f172a 100%);border:2px solid #f59e0b;}\n' +
    'table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-variant-numeric:tabular-nums;font-size:11.5px;}\n' +
    'th,td{padding:6px 9px;border:1px solid #334155;}th{background:#1e293b;color:#cbd5e1;font-weight:700;}\n' +
    'td.num{text-align:right;}.pos{color:#6ee7b7;}.neg{color:#fca5a5;}.strong{color:#fcd34d;font-weight:700;}.muted{color:#94a3b8;}\n' +
    '.note{font-size:11px;color:#94a3b8;font-style:italic;}\n' +
    '</style></head><body>\n' +
    '<h1>🚀 폭발형 섹션 조건 검증</h1>\n' +
    '<div class="note">'+out.meta.eligibleDayCount+'일 ('+out.meta.eligibleDates[0]+' ~ '+out.meta.eligibleDates[out.meta.eligibleDates.length-1]+') · 소요 '+out.meta.elapsedSec+'s</div>\n' +

    '<div class="card conclusion">\n' +
    '<h2 style="margin-top:0;">📌 결론</h2>\n' +
    '<p><strong>종합 점수 최우수 풀</strong>: <strong style="color:#fcd34d;">'+best+'</strong></p>\n' +
    '<ul>\n' +
    '<li>day+5% '+s[best].dayHit5Rate+'%, day+10% <strong>'+s[best].dayHit10Rate+'%</strong>, fail3 '+s[best].fail3Rate+'%</li>\n' +
    '<li>avg dayMax '+s[best].avgDayMax+'%, avg close '+s[best].avgDayClose+'%, close+ '+s[best].closePositiveRate+'%</li>\n' +
    '<li>전략 추천 (가장 높은 EV): B(+5/-2) '+s[best].stratB_ev+'% | D(+10/-3) '+s[best].stratD_ev+'%</li>\n' +
    '</ul>\n' +
    '<p>explosiveTop 일평균 <strong>'+out.expTopDailyAvg+'개</strong>/일, 0개인 날 <strong>'+out.expTopZeroDays+'일</strong> ('+out.meta.eligibleDayCount+'일 중)</p>\n' +
    '<p>explosiveWatch 일평균 '+out.expWatchDailyAvg+'개/일, 0개인 날 '+out.expWatchZeroDays+'일</p>\n' +
    '</div>\n' +

    '<h2>1. 8개 풀 성과 비교 (일봉 dayMax 기준)</h2>\n<div class="card"><table>'+head+'<tbody>' +
    row('READY 전체', 'READY_ALL') +
    row('READY TOP5 (finalScore, 기존 운영)', 'READY_TOP5_finalSc') +
    row('🚀 explosiveTop (READY ∩ 조건)', 'explosiveTop') +
    row('🚀 explosiveWatch (WAIT_PULLBACK ∩ 조건)', 'explosiveWatch') +
    row('🚀 explosiveTop + Watch 합산', 'explosiveTop_plus_Watch') +
    row('value≥100억 단독 (READY)', 'valueOver100억') +
    row('rebreak 단독 (READY)', 'rebreakOnly') +
    row('cp≥0.85 단독 (READY)', 'cpOver85Only') +
    '</tbody></table>\n<div class="note">avg dayMax: 09:30 close 대비 당일 일봉 high의 평균 %. day+5%/+10%는 도달률.</div></div>\n' +

    '<h2>2. 전략별 평균 손익 (% per trade)</h2>\n<div class="card"><table>'+stratHead+'<tbody>' +
    stratRow('READY 전체', 'READY_ALL') +
    stratRow('READY TOP5 (finalScore)', 'READY_TOP5_finalSc') +
    stratRow('🚀 explosiveTop', 'explosiveTop') +
    stratRow('🚀 explosiveWatch', 'explosiveWatch') +
    stratRow('value≥100억', 'valueOver100억') +
    stratRow('rebreak only', 'rebreakOnly') +
    stratRow('cp≥0.85 only', 'cpOver85Only') +
    '</tbody></table>\n<div class="note">B/C/D: 단순 익절·손절 / 10:00 미달성은 일봉 close. E/F: +2% 절반 익절 후 +7%/+10%.</div></div>\n' +

    (today.readyTop5 ? '<h2>3. 5/14 readyTop5 (finalScore)와 폭발형 조건 통과 여부</h2>\n<div class="card"><table>\n' +
    '<thead><tr><th>종목</th><th>final</th><th>exp</th><th>passes</th><th>cp</th><th>value</th><th>rebreak</th><th>dayMax</th><th>dayClose</th></tr></thead><tbody>' +
    todayReadyTop5 + '</tbody></table>\n' +
    '<div class="note">explosiveTop 0개 = readyTop5 중 누구도 (rebreak ∧ cp≥0.85 ∧ value≥100억) 모두 통과 못 했다는 의미.</div></div>\n' : '') +

    (todayWatch ? '<h2>4. 5/14 explosiveWatch 5개 실제 결과</h2>\n<div class="card"><table>\n' +
    '<thead><tr><th>종목</th><th>exp</th><th>open%</th><th>cp</th><th>value</th><th>dayMax</th><th>dayClose</th></tr></thead><tbody>' +
    todayWatch + '</tbody></table>\n' +
    '<div class="note">explosiveWatch는 WAIT_PULLBACK(이미 +8% 이상) 풀에서 조건 통과한 후보. 추격은 부담스럽지만 강한 흐름 종목.</div></div>\n' : '') +

    '<h2>5. 조건 정의</h2><div class="card">\n' +
    '<p><strong>passesExplosive</strong>: '+out.meta.conditions.passesExplosive+'</p>\n' +
    '<p><strong>explosiveScore</strong>: '+out.meta.conditions.explosiveScore+'</p>\n' +
    '</div>\n' +

    '</body></html>';
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}
module.exports = { main, runDay };
