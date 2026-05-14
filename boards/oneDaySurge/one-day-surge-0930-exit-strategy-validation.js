#!/usr/bin/env node
/**
 * explosiveTop 10시 강제 종료 vs 생존 심사 후 연장 검증
 *
 * 데이터 한계:
 *   - 09:00~10:00 분봉만 보유 → 10:00 이후는 일봉(09:30~15:30 high/low/close)으로 근사
 *   - "10시 이후 MFE", "고점권 유지" 등은 정확한 시각을 모르므로 일봉 기준 근사 사용
 *
 * 전략:
 *   A. 10:00 강제 청산                                       — 분봉 close 사용
 *   B. +2.5% 절반 익절 + 나머지 10:00 청산                   — 분봉
 *   C. +2.5% 절반 익절 + 10:00 고점권(close ≥ max-2%)이면 종가 — 분봉+일봉 근사
 *   D. +5% 익절 / -2% 손절                                  — 분봉 시뮬
 *   E. 10:00 생존(close ≥ before10 max -2% 이내)이면 종가 연장 — 분봉+일봉 근사
 *
 * 출력: reports/one-day-surge-0930-exit-strategy-validation-result.{json,html}
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-0930-exit-strategy-validation-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-0930-exit-strategy-validation-result.html');
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

// 분봉 09:31~10:00 + 일봉으로 5종 전략 시뮬
function simulateExits(bars, entry, dayRow) {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const post = bars.filter((b) => b.time > '09:30' && b.time <= '10:00' && b.close > 0);
  if (post.length === 0) return null;
  // before10 max/min
  let max10 = -Infinity, min10 = Infinity;
  let firstHit25=null, firstHit5=null, firstFail2=null;
  for (const b of post) {
    if (b.high > max10) max10 = b.high;
    if (b.low < min10) min10 = b.low;
    const hi = (b.high/entry-1)*100, lo = (b.low/entry-1)*100;
    if (firstHit25===null && hi>=2.5) firstHit25=b.time;
    if (firstHit5===null  && hi>=5)   firstHit5=b.time;
    if (firstFail2===null && lo<=-2)  firstFail2=b.time;
  }
  const close10  = post[post.length-1].close;
  const close10Pct = (close10/entry-1)*100;
  const max10Pct = (max10/entry-1)*100;
  const min10Pct = (min10/entry-1)*100;
  // 일봉 — 09:30~15:30 high/low/close
  const dayHighPct = dayRow && dayRow.high > 0 ? (dayRow.high/entry-1)*100 : null;
  const dayLowPct  = dayRow && dayRow.low  > 0 ? (dayRow.low /entry-1)*100 : null;
  const dayClosePct = dayRow && dayRow.close > 0 ? (dayRow.close/entry-1)*100 : null;
  // 10:00 이후 추가 max/min 근사: dayHigh가 max10보다 크면 그 차이가 10:00+ 추가 상승
  const after10MaxPct = dayHighPct != null && dayHighPct > max10Pct ? dayHighPct : null;
  const after10MinPct = dayLowPct  != null && dayLowPct  < min10Pct ? dayLowPct  : null;

  // 전략 A: 10:00 강제 청산
  const A = { exitPct: Number(close10Pct.toFixed(2)), reason: '10:00_close' };

  // 전략 B: +2.5% 절반 + 10:00 청산
  let B_exitPct;
  if (firstHit25 !== null) {
    B_exitPct = (2.5 + close10Pct) / 2;
  } else {
    B_exitPct = close10Pct;
  }
  const B = { exitPct: Number(B_exitPct.toFixed(2)), reason: firstHit25 ? 'half@2.5+10:00' : '10:00_close' };

  // 전략 C: +2.5% 절반 + (10:00 close가 max10에서 -2% 이내면 종가 청산, 아니면 10:00)
  let C_exitPct;
  const isHoldingHigh = (close10Pct >= max10Pct - 2);
  if (firstHit25 !== null) {
    if (isHoldingHigh && dayClosePct != null) {
      C_exitPct = (2.5 + dayClosePct) / 2;
    } else {
      C_exitPct = (2.5 + close10Pct) / 2;
    }
  } else {
    C_exitPct = close10Pct;
  }
  const C = { exitPct: Number(C_exitPct.toFixed(2)), reason: firstHit25 ? (isHoldingHigh ? 'half@2.5+종가' : 'half@2.5+10:00') : '10:00_close', isHoldingHigh };

  // 전략 D: +5% 익절 / -2% 손절 (분봉 우선순위: 손절 우선)
  let D_exitPct = null;
  for (const b of post) {
    const hi = (b.high/entry-1)*100, lo = (b.low/entry-1)*100;
    if (lo <= -2) { D_exitPct = -2; break; }
    if (hi >= 5)  { D_exitPct = 5;  break; }
  }
  if (D_exitPct === null) D_exitPct = close10Pct;
  const D = { exitPct: Number(D_exitPct.toFixed(2)), reason: D_exitPct === -2 ? 'stop' : (D_exitPct === 5 ? 'profit' : '10:00_close') };

  // 전략 E: 10:00 생존(close > 0 + close ≥ max-2%) → 종가 연장, 아니면 10:00
  let E_exitPct;
  if (close10Pct > 0 && isHoldingHigh && dayClosePct != null) {
    E_exitPct = dayClosePct;
  } else {
    E_exitPct = close10Pct;
  }
  const E = { exitPct: Number(E_exitPct.toFixed(2)), reason: (close10Pct > 0 && isHoldingHigh) ? '연장 종가' : '10:00_청산', survived: close10Pct > 0 && isHoldingHigh };

  return {
    entry, max10Pct: Number(max10Pct.toFixed(2)), min10Pct: Number(min10Pct.toFixed(2)),
    close10Pct: Number(close10Pct.toFixed(2)), dayClosePct: dayClosePct != null ? Number(dayClosePct.toFixed(2)) : null,
    dayHighPct: dayHighPct != null ? Number(dayHighPct.toFixed(2)) : null,
    after10MaxPct: after10MaxPct != null ? Number(after10MaxPct.toFixed(2)) : null,
    after10MinPct: after10MinPct != null ? Number(after10MinPct.toFixed(2)) : null,
    isHoldingHigh, survived10: close10Pct > 0 && isHoldingHigh,
    A, B, C, D, E,
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
    for (let i = baseIdx-20; i < baseIdx; i++) { const r = rows[i]; if (r && r.volume>0) { sum+=(r.valueApprox||0); n++; } }
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
    if (status !== 'READY' && status !== 'WAIT_PULLBACK') continue;
    const sim = simulateExits(bars, m.last0930, dayRow);
    if (!sim) continue;
    entries.push({
      code, name: chart.name || meta.name || code,
      status, passesExp: passesExplosive(m),
      m: { closePosition0930: m.closePosition0930, value_0930: m.value_0930, rebreakMorningHigh: m.rebreakMorningHigh, openToLastRate: m.openToLastRate, highToLastDrop: m.highToLastDrop },
      sim,
    });
  }
  return { date: targetDate, entries };
}

function summarize(entries) {
  const n = entries.length;
  if (n === 0) return { n: 0 };
  const avg = (a) => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
  const med = (sorted) => sorted.length === 0 ? 0 : sorted.length%2===0 ? (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2 : sorted[(sorted.length-1)/2];
  const stratStats = (key) => {
    const vals = entries.map((e) => e.sim[key].exitPct);
    const sorted = [...vals].sort((a,b)=>a-b);
    return {
      avg: Number(avg(vals).toFixed(2)),
      median: Number(med(sorted).toFixed(2)),
      winRate: Number((vals.filter((v) => v > 0).length / n * 100).toFixed(1)),
      lossRate: Number((vals.filter((v) => v < 0).length / n * 100).toFixed(1)),
      fail2Rate: Number((vals.filter((v) => v <= -2).length / n * 100).toFixed(1)),
      fail3Rate: Number((vals.filter((v) => v <= -3).length / n * 100).toFixed(1)),
      bigWinRate: Number((vals.filter((v) => v >= 5).length / n * 100).toFixed(1)),
    };
  };
  return {
    n,
    // 10:00 시점 통계
    avgMax10: Number(avg(entries.map((e)=>e.sim.max10Pct)).toFixed(2)),
    avgMin10: Number(avg(entries.map((e)=>e.sim.min10Pct)).toFixed(2)),
    avgClose10: Number(avg(entries.map((e)=>e.sim.close10Pct)).toFixed(2)),
    avgDayClose: Number(avg(entries.filter((e)=>e.sim.dayClosePct!=null).map((e)=>e.sim.dayClosePct)).toFixed(2)),
    // 10:00 이후 (근사)
    avgAfter10Max: Number(avg(entries.filter((e)=>e.sim.after10MaxPct!=null).map((e)=>e.sim.after10MaxPct - e.sim.max10Pct)).toFixed(2)),
    avgAfter10MinDelta: Number(avg(entries.filter((e)=>e.sim.after10MinPct!=null).map((e)=>e.sim.after10MinPct - e.sim.min10Pct)).toFixed(2)),
    // 10:00 생존 (close>0 AND close≥max-2%) 후보의 종가 플러스율
    survived10Count: entries.filter((e)=>e.sim.survived10).length,
    survived10ClosePositive: (() => {
      const survived = entries.filter((e)=>e.sim.survived10 && e.sim.dayClosePct!=null);
      if (survived.length === 0) return 0;
      const positive = survived.filter((e) => e.sim.dayClosePct > 0).length;
      return Number((positive/survived.length*100).toFixed(1));
    })(),
    survived10AvgDayClose: (() => {
      const survived = entries.filter((e)=>e.sim.survived10 && e.sim.dayClosePct!=null);
      return survived.length === 0 ? 0 : Number(avg(survived.map((e)=>e.sim.dayClosePct)).toFixed(2));
    })(),
    notSurvived10AvgDayClose: (() => {
      const ns = entries.filter((e)=>!e.sim.survived10 && e.sim.dayClosePct!=null);
      return ns.length === 0 ? 0 : Number(avg(ns.map((e)=>e.sim.dayClosePct)).toFixed(2));
    })(),
    // 전략별
    A: stratStats('A'), B: stratStats('B'), C: stratStats('C'), D: stratStats('D'), E: stratStats('E'),
  };
}

function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log('\n⏰ 10시 강제 종료 vs 생존 심사 후 연장 검증');
  const dates = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => fs.readdirSync(path.join(INTRADAY_BASE, d)).length >= 100)
    .sort();
  console.log(`  대상: ${dates.length}일 (${dates[0]} ~ ${dates[dates.length-1]})`);
  const metaMap = scanner.loadStockMetaMap();
  const dayResults = [];
  for (const d of dates) { const r = runDay(d, metaMap); if (r) dayResults.push(r); }

  const allReady = []; const allWait = []; const allExp = []; const allExpWatch = [];
  for (const d of dayResults) for (const e of d.entries) {
    if (e.status === 'READY') allReady.push(e);
    if (e.status === 'WAIT_PULLBACK') allWait.push(e);
    if (e.status === 'READY' && e.passesExp) allExp.push(e);
    if (e.status === 'WAIT_PULLBACK' && e.passesExp) allExpWatch.push(e);
  }

  const summaries = {
    explosiveTop: summarize(allExp),
    READY_ALL: summarize(allReady),
    explosiveWatch: summarize(allExpWatch),
  };

  // 5/14 상세
  const today = dayResults.find((d) => d.date === TODAY_FOCUS);
  const todayDetail = today ? today.entries.filter((e) => e.passesExp).map((e) => ({
    code: e.code, name: e.name, status: e.status,
    max10: e.sim.max10Pct, close10: e.sim.close10Pct, dayClose: e.sim.dayClosePct, dayHigh: e.sim.dayHighPct,
    A: e.sim.A.exitPct, B: e.sim.B.exitPct, C: e.sim.C.exitPct, D: e.sim.D.exitPct, E: e.sim.E.exitPct,
    survived10: e.sim.survived10,
  })) : [];

  const elapsedSec = ((Date.now()-t0)/1000).toFixed(2);
  const out = {
    meta: {
      title: 'explosiveTop 10시 강제 종료 vs 생존 심사 후 연장 검증',
      generatedAt: new Date().toISOString(), elapsedSec,
      eligibleDates: dates, eligibleDayCount: dates.length,
      methodology: '09:00~10:00 분봉 + 당일 일봉 근사. 10:00 이후 정확한 시각/MFE는 분봉 미보유로 일봉 high/close로 추정.',
      strategies: {
        A: '10:00 강제 청산',
        B: '+2.5% 절반 익절 + 나머지 10:00 청산',
        C: '+2.5% 절반 익절 + 10:00 고점권(close ≥ max-2%)이면 종가, 아니면 10:00',
        D: '+5% 익절 / -2% 손절 (분봉)',
        E: '10:00 생존(close > 0 AND close ≥ max-2% 이내)이면 종가 연장, 아니면 10:00',
      },
    },
    summaries,
    todayDetail,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  // 콘솔
  console.log('\n📋 그룹별 전략 평균 손익 (% per trade):');
  const head = ['Pool', 'n', 'A 10:00', 'B half+10:00', 'C half+연장', 'D +5/-2', 'E 생존연장'];
  console.log('  ' + head.map(c => String(c).padStart(14)).join(' '));
  for (const k of ['explosiveTop','READY_ALL','explosiveWatch']) {
    const s = summaries[k]; if (!s.n) { console.log('  ' + k.padStart(14) + ' (0)'); continue; }
    console.log('  ' + [k, s.n, s.A.avg+'%', s.B.avg+'%', s.C.avg+'%', s.D.avg+'%', s.E.avg+'%'].map(c=>String(c).padStart(14)).join(' '));
  }
  console.log('\n📋 그룹별 승률 / 손실 위험:');
  const head2 = ['Pool', 'A 승률', 'A 손실', 'D 승률', 'D fail2', 'E 승률', 'E 종가+'];
  console.log('  ' + head2.map(c => String(c).padStart(13)).join(' '));
  for (const k of ['explosiveTop','READY_ALL','explosiveWatch']) {
    const s = summaries[k]; if (!s.n) continue;
    console.log('  ' + [k, s.A.winRate+'%', s.A.lossRate+'%', s.D.winRate+'%', s.D.fail2Rate+'%', s.E.winRate+'%', s.survived10ClosePositive+'%'].map(c=>String(c).padStart(13)).join(' '));
  }
  console.log('\n📋 explosiveTop 10:00 생존 분석:');
  const s = summaries.explosiveTop;
  console.log('  10:00 생존(close>0 + max근접) 후보 ' + s.survived10Count + '/' + s.n + '건');
  console.log('  생존 후보 평균 종가 수익률: ' + s.survived10AvgDayClose + '%');
  console.log('  생존 후보 종가 플러스 비율: ' + s.survived10ClosePositive + '%');
  console.log('  미생존 후보 평균 종가 수익률: ' + s.notSurvived10AvgDayClose + '%');
  console.log('  10:00 이후 추가 상승 평균 (max10 → dayHigh): +' + s.avgAfter10Max + '%');
  console.log('  10:00 이후 추가 하락 평균 (min10 → dayLow): ' + s.avgAfter10MinDelta + '%');

  console.log('\n  ⏱ 소요 '+elapsedSec+'s');
  console.log('✅ JSON: '+OUT_JSON);
  console.log('✅ HTML: '+OUT_HTML);
}

function buildHtml(out) {
  const s = out.summaries;
  const stratRow = (label, key) => {
    const v = s[key]; if (!v || !v.n) return '<tr><td>'+label+'</td><td>0</td><td colspan="5">데이터 없음</td></tr>';
    const cls = (val) => val > 0 ? 'pos' : (val < 0 ? 'neg' : 'muted');
    return '<tr><td>'+label+'</td><td>'+v.n+'</td>' +
      '<td class="num '+cls(v.A.avg)+'">'+v.A.avg+'%</td>' +
      '<td class="num '+cls(v.B.avg)+'">'+v.B.avg+'%</td>' +
      '<td class="num '+cls(v.C.avg)+'">'+v.C.avg+'%</td>' +
      '<td class="num '+cls(v.D.avg)+'">'+v.D.avg+'%</td>' +
      '<td class="num '+cls(v.E.avg)+'">'+v.E.avg+'%</td></tr>';
  };
  const winRow = (label, key) => {
    const v = s[key]; if (!v || !v.n) return '';
    return '<tr><td>'+label+'</td><td>'+v.n+'</td>' +
      '<td class="num">'+v.A.winRate+'% / '+v.A.lossRate+'%</td>' +
      '<td class="num">'+v.B.winRate+'%</td>' +
      '<td class="num">'+v.C.winRate+'%</td>' +
      '<td class="num">'+v.D.winRate+'% / '+v.D.fail2Rate+'%</td>' +
      '<td class="num">'+v.E.winRate+'%</td>' +
      '<td class="num">'+v.survived10Count+'/'+v.n+' ('+(v.survived10Count/v.n*100).toFixed(1)+'%)</td>' +
      '<td class="num strong">'+v.survived10ClosePositive+'%</td>' +
      '<td class="num">'+v.survived10AvgDayClose+'%</td>' +
      '<td class="num">'+v.notSurvived10AvgDayClose+'%</td>' +
      '<td class="num pos">+'+v.avgAfter10Max+'%</td>' +
      '<td class="num neg">'+v.avgAfter10MinDelta+'%</td></tr>';
  };

  // 결론
  const e = s.explosiveTop;
  let bestStrat = 'A', bestVal = -Infinity;
  for (const k of ['A','B','C','D','E']) {
    if (e[k].avg > bestVal) { bestVal = e[k].avg; bestStrat = k; }
  }
  const survivalRate = e.n > 0 ? (e.survived10Count/e.n*100).toFixed(1) : 0;
  const recommendation = (() => {
    if (e.E.avg > e.A.avg + 0.3 && e.survived10ClosePositive >= 60) {
      return '10시 생존 심사 후 연장(E)이 강제 청산(A)보다 우수 — 생존 종목 ' + e.survived10ClosePositive + '%가 종가 플러스 마감. **연장 권장**';
    } else if (e.A.avg > e.E.avg) {
      return '10시 강제 청산(A)이 우수. 10시 이후 보유는 평균 손실. **강제 청산 권장**';
    } else {
      return '강제 청산과 연장의 차이가 작음. 안전하게 강제 청산 또는 부분 익절 후 종가 절반 보유.';
    }
  })();

  const todayList = (out.todayDetail || []).map((t) => '<tr>' +
    '<td>'+t.code+' '+t.name+'</td>' +
    '<td>'+t.status+'</td>' +
    '<td class="num pos">'+t.max10+'%</td>' +
    '<td class="num">'+t.close10+'%</td>' +
    '<td class="num">'+(t.dayHigh||'-')+'%</td>' +
    '<td class="num">'+(t.dayClose||'-')+'%</td>' +
    '<td>'+(t.survived10?'✓':'·')+'</td>' +
    '<td class="num">'+t.A+'%</td>' +
    '<td class="num">'+t.B+'%</td>' +
    '<td class="num">'+t.C+'%</td>' +
    '<td class="num">'+t.D+'%</td>' +
    '<td class="num">'+t.E+'%</td>' +
    '</tr>').join('');

  return '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>10시 종료 검증</title><style>\n' +
    'body{margin:0 auto;padding:20px;max-width:1500px;font-family:-apple-system,"Segoe UI","Noto Sans KR",sans-serif;background:#0f172a;color:#e2e8f0;font-size:13px;line-height:1.6;}\n' +
    'h1,h2,h3{color:#f1f5f9;}h2{color:#fcd34d;border-bottom:1px solid #f59e0b;padding-bottom:6px;margin:22px 0 10px;}\n' +
    '.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:14px 18px;margin:12px 0;}\n' +
    '.conclusion{background:linear-gradient(135deg,#042f2e 0%,#0f172a 100%);border:2px solid #14b8a6;}\n' +
    'table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-variant-numeric:tabular-nums;font-size:11.5px;}\n' +
    'th,td{padding:7px 10px;border:1px solid #334155;}th{background:#1e293b;color:#cbd5e1;font-weight:700;}\n' +
    'td.num{text-align:right;}.pos{color:#6ee7b7;}.neg{color:#fca5a5;}.strong{color:#fcd34d;font-weight:700;}.muted{color:#94a3b8;}\n' +
    '.note{font-size:11px;color:#94a3b8;font-style:italic;}\n' +
    '</style></head><body>\n' +
    '<h1>⏰ explosiveTop 10시 강제 종료 vs 생존 심사 후 연장 검증</h1>\n' +
    '<div class="note">'+out.meta.eligibleDayCount+'일 ('+out.meta.eligibleDates[0]+' ~ '+out.meta.eligibleDates[out.meta.eligibleDates.length-1]+') · 소요 '+out.meta.elapsedSec+'s · 10:00 이후 분봉 미보유 → 일봉으로 근사.</div>\n' +

    '<div class="card conclusion">\n' +
    '<h2 style="margin-top:0;">📌 결론</h2>\n' +
    '<p><strong>explosiveTop의 최적 전략:</strong> <strong style="color:#fcd34d;">' + bestStrat + '</strong> (평균 ' + bestVal + '% / trade)</p>\n' +
    '<p><strong>추천:</strong> ' + recommendation + '</p>\n' +
    '<ul>\n' +
    '<li>10시 강제 청산(A): 평균 <strong>' + e.A.avg + '%</strong> / 승률 ' + e.A.winRate + '%</li>\n' +
    '<li>+2.5% 절반 + 10:00(B): 평균 ' + e.B.avg + '%</li>\n' +
    '<li>+2.5% 절반 + 고점권 연장(C): 평균 ' + e.C.avg + '%</li>\n' +
    '<li>+5%/-2% 분봉 시뮬(D): 평균 ' + e.D.avg + '% / fail2 ' + e.D.fail2Rate + '%</li>\n' +
    '<li>10시 생존 연장(E): 평균 <strong>' + e.E.avg + '%</strong> / 생존률 ' + survivalRate + '%</li>\n' +
    '<li>10시 생존 종목의 종가 플러스 비율: <strong>' + e.survived10ClosePositive + '%</strong> (생존 평균 종가 ' + e.survived10AvgDayClose + '%, 미생존 평균 종가 ' + e.notSurvived10AvgDayClose + '%)</li>\n' +
    '<li>10시 이후 추가 상승 (근사): +' + e.avgAfter10Max + '% / 추가 하락 ' + e.avgAfter10MinDelta + '%</li>\n' +
    '</ul>\n' +
    '</div>\n' +

    '<h2>1. 전략별 평균 손익 (% per trade)</h2>\n<div class="card"><table>\n' +
    '<thead><tr><th>풀</th><th>n</th><th>A 10:00 강제</th><th>B half+10:00</th><th>C half+연장</th><th>D +5/-2</th><th>E 생존 연장</th></tr></thead><tbody>\n' +
    stratRow('🚀 explosiveTop', 'explosiveTop') +
    stratRow('READY 전체', 'READY_ALL') +
    stratRow('explosiveWatch', 'explosiveWatch') +
    '</tbody></table></div>\n' +

    '<h2>2. 승률 / 손실 / 10시 생존 분석</h2>\n<div class="card"><table>\n' +
    '<thead><tr><th>풀</th><th>n</th><th>A 승/손</th><th>B 승률</th><th>C 승률</th><th>D 승/fail2</th><th>E 승률</th><th>10시 생존</th><th>생존→종가+</th><th>생존 avg종가</th><th>미생존 avg종가</th><th>10:00+ 추가max</th><th>10:00+ 추가min</th></tr></thead><tbody>\n' +
    winRow('🚀 explosiveTop', 'explosiveTop') +
    winRow('READY 전체', 'READY_ALL') +
    winRow('explosiveWatch', 'explosiveWatch') +
    '</tbody></table>\n' +
    '<div class="note">10시 생존 = close10 > 0 AND close10 ≥ before10 max - 2% 이내. 생존 후보의 종가 플러스 비율이 60% 이상이면 연장이 의미 있음.</div></div>\n' +

    (todayList ? '<h2>3. 5/14 explosiveTop / explosiveWatch 종목별 전략 결과</h2>\n<div class="card"><table>\n' +
    '<thead><tr><th>종목</th><th>풀</th><th>max10</th><th>close10</th><th>dayHigh</th><th>dayClose</th><th>10시 생존</th><th>A</th><th>B</th><th>C</th><th>D</th><th>E</th></tr></thead><tbody>\n' +
    todayList + '</tbody></table></div>\n' : '') +

    '<h2>4. 데이터 한계 및 정의</h2><div class="card">\n' +
    '<p>분봉은 <strong>09:00~10:00만 보유</strong>. 10:00 이후 정확한 시각/MFE는 측정 불가, 일봉(09:30~15:30 high/low/close)으로 근사.</p>\n' +
    '<ul>\n' +
    '<li><strong>10시 생존</strong> = (10:00 close > 09:30 close) AND (10:00 close가 09:31~10:00 max에서 -2% 이내)</li>\n' +
    '<li><strong>10:00 이후 추가 상승</strong> = max(0, dayHigh - 09:31~10:00 max)</li>\n' +
    '<li><strong>전략 C / E의 "종가 청산"</strong> = 일봉 close 기준</li>\n' +
    '</ul>\n' +
    '<p>정확한 10:00 이후 분봉이 필요하면 운영 서버에서 --full-day로 09:00~15:30 분봉 재수집 필요.</p>\n' +
    '</div>\n' +

    '</body></html>';
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}
module.exports = { main, runDay };
