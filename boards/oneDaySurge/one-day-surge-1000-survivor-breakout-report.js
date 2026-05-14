#!/usr/bin/env node
/**
 * 1DS — 10시 생존 후보의 돌파 예측력 검증 보고서
 *
 * 60거래일 자동 탐색에서 'READY + 10시 생존'이 평균 +2.49% / 승률 69.9%로 1위를 했지만,
 * 그 후보들이 실제로 10시 이후 돌파했는지, 아니면 단지 옆걸음이었는지는 별개 문제다.
 * 본 보고서는 10시 생존 판정이 이후 돌파를 예측하는 신호였는지 검증한다.
 *
 * 검증 질문:
 *   1. READY + 10시 생존 후보 중 몇 %가 10시 이후 09:31~10:00 high를 돌파했는가?
 *   2. 돌파 성공 vs 실패 성과 차이?
 *   3. 10:15 / 10:30 / 11:00 / 13:00 중 어느 시점에 컷오프?
 *   4. 돌파 대기 vs 10:00 즉시 진입 어느 게 좋은가?
 *   5. 10시 생존 후보 추가 필터 필요?
 *   6. "돌파 대기 / 성공 / 실패" 상태 분리 필요?
 *
 * 미래 누수 방지:
 *   - 10시 생존 판정은 bars ≤ 10:00 만 사용
 *   - 돌파 감지는 bars > 10:00 만 사용
 *   - 돌파 후 진입 시뮬레이션은 bars > breakoutTime 만 사용
 *
 * 출력:
 *   - reports/one-day-surge-1000-survivor-breakout-result.{json,html}
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-1000-survivor-breakout-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-1000-survivor-breakout-result.html');

const scanner = require('./one-day-surge-0930-scanner');

// ── CLI ──
function parseArgs(argv) {
  const a = { from: null, to: null, days: 60, minDirSize: 200 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from' || k === '--from-date') a.from = argv[++i];
    else if (k === '--to' || k === '--to-date') a.to = argv[++i];
    else if (k === '--days') a.days = parseInt(argv[++i], 10) || 60;
    else if (k === '--min-dir-size') a.minDirSize = parseInt(argv[++i], 10) || 200;
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node one-day-surge-1000-survivor-breakout-report.js [--days N] [--from-date YYYY-MM-DD] [--to-date YYYY-MM-DD]');
      process.exit(0);
    }
  }
  return a;
}

// ── 분봉 유틸 ──
function barsInRange(bars, fromExc, toInc) {
  return bars.filter((b) => b && b.time && b.close > 0 && b.time > fromExc && b.time <= toInc);
}
function barsAfter(bars, fromExc) {
  return bars.filter((b) => b && b.time && b.close > 0 && b.time > fromExc);
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

// ── survivor1000 판정 (scanner.detectSurvivor1000과 동일 로직) ──
function isSurvivor1000(bars, m) {
  if (!m || !(m.last0930 > 0)) return null;
  const win = barsInRange(bars, '09:30', '10:00');
  if (win.length === 0) return null;
  let bar1000 = null;
  for (const b of win) {
    if (b.time === '10:00') { bar1000 = b; break; }
    if (b.time <= '10:00') bar1000 = b;
  }
  if (!bar1000 || bar1000.time < '09:55') return null;
  const close1000 = bar1000.close;
  if (!(close1000 > m.last0930)) return null;
  const high_0931_1000 = maxHigh(win);
  if (high_0931_1000 <= 0) return null;
  if (close1000 < high_0931_1000 * 0.98) return null;
  const min_low_0931_1000 = minLow(win);
  if (min_low_0931_1000 < m.last0930 * 0.97) return null;
  return {
    close1000,
    high_0931_1000,
    bar1000_high: bar1000.high,
    bar1000_low: bar1000.low,
    aliveRate1000: (close1000 / m.last0930 - 1) * 100,
    closeToHighDrop_1000: (close1000 / high_0931_1000 - 1) * 100,
    min_low_0931_1000,
    value_0931_1000: sumValue(win),
  };
}

// ── TEN_REBREAK / explosiveTop 판정 (태그용) ──
function passesExplosiveTop(m) {
  if (!m || !m.rebreakMorningHigh) return false;
  if ((m.closePosition0930 || 0) < 0.85) return false;
  if ((m.value_0930 || 0) < 1e10) return false;
  return true;
}
function detectTenRebreak(bars, m) {
  if (!m || (m.value_0930 || 0) < 1e9) return false;
  if (m.highToLastDrop != null && m.highToLastDrop < -4) return false;
  const win = barsInRange(bars, '09:30', '10:30');
  if (win.length < 5) return false;
  for (let i = 0; i < win.length; i++) {
    const b = win[i];
    if (!(b.high > m.high0930)) continue;
    const prev5 = win.slice(Math.max(0, i - 5), i);
    if (prev5.length === 0) continue;
    const avg5 = sumValue(prev5) / prev5.length;
    if (avg5 <= 0) continue;
    if ((b.value || 0) < avg5 * 2) continue;
    return { triggerTime: b.time };
  }
  return false;
}
function passesAttackI(m, status, marketCap, hasTenRebreak) {
  if (!m) return false;
  if ((m.value_0930 || 0) < 2.1e9) return false;
  if ((m.closePosition0930 || 0) < 0.50) return false;
  if (m.highToLastDrop == null || m.highToLastDrop < -2.70) return false;
  if (m.openToLastRate == null || m.openToLastRate < 0.50) return false;
  if ((m.valueToAvgRatio_0930 || 0) < 3) return false;
  if (!m.rebreakMorningHigh) return false;
  if (status !== 'READY' && status !== 'FADED') return false;
  if (!(marketCap > 0) || marketCap > 5e12) return false;
  return !!hasTenRebreak;
}

// ── 돌파 + 성과 측정 (post-10:00) ──
function analyzePost1000(bars, m, surv) {
  // 사후 분봉 (bars > 10:00)
  const after = barsAfter(bars, '10:00').filter((b) => b.time <= '15:30');
  if (after.length === 0) return null;
  const E = m.last0930;  // 09:30 close (베이스라인)
  const E1000 = surv.close1000;
  const breakRef = surv.high_0931_1000;  // 핵심 돌파 기준
  const high0930 = m.high0930;
  const high1000bar = surv.bar1000_high;

  // 돌파 시간
  let breakoutTime_breakRef = null;  // 09:31~10:00 high 돌파 시간
  let breakoutTime_0930 = null;       // 09:30 high 돌파 시간 (post-10:00)
  let breakoutTime_1000bar = null;    // 10:00 bar high 돌파 시간
  let maxHi = -Infinity, maxHiTime = null;
  let minLo = Infinity;
  let lastClose = null;
  // hit/fail 시점 (09:30 close 기준)
  let hit3_0930 = null, hit5_0930 = null, hit7_0930 = null, hit10_0930 = null;
  let fail2_0930 = null, fail3_0930 = null, fail5_0930 = null;
  // hit/fail (10:00 close 기준)
  let hit1_1000 = null, hit2_1000 = null, hit3_1000 = null, hit5_1000 = null, hit7_1000 = null, hit10_1000 = null;

  for (const b of after) {
    if (b.high > maxHi) { maxHi = b.high; maxHiTime = b.time; }
    if (b.low  < minLo) minLo = b.low;
    lastClose = b.close;
    if (!breakoutTime_breakRef && b.high > breakRef) breakoutTime_breakRef = b.time;
    if (!breakoutTime_0930    && high0930 > 0 && b.high > high0930) breakoutTime_0930 = b.time;
    if (!breakoutTime_1000bar && high1000bar > 0 && b.high > high1000bar) breakoutTime_1000bar = b.time;
    // vs 09:30 close
    if (!hit3_0930  && (b.high/E-1)*100 >=  3) hit3_0930  = b.time;
    if (!hit5_0930  && (b.high/E-1)*100 >=  5) hit5_0930  = b.time;
    if (!hit7_0930  && (b.high/E-1)*100 >=  7) hit7_0930  = b.time;
    if (!hit10_0930 && (b.high/E-1)*100 >= 10) hit10_0930 = b.time;
    if (!fail2_0930 && (b.low /E-1)*100 <= -2) fail2_0930 = b.time;
    if (!fail3_0930 && (b.low /E-1)*100 <= -3) fail3_0930 = b.time;
    if (!fail5_0930 && (b.low /E-1)*100 <= -5) fail5_0930 = b.time;
    // vs 10:00 close
    if (!hit1_1000  && (b.high/E1000-1)*100 >=  1) hit1_1000  = b.time;
    if (!hit2_1000  && (b.high/E1000-1)*100 >=  2) hit2_1000  = b.time;
    if (!hit3_1000  && (b.high/E1000-1)*100 >=  3) hit3_1000  = b.time;
    if (!hit5_1000  && (b.high/E1000-1)*100 >=  5) hit5_1000  = b.time;
    if (!hit7_1000  && (b.high/E1000-1)*100 >=  7) hit7_1000  = b.time;
    if (!hit10_1000 && (b.high/E1000-1)*100 >= 10) hit10_1000 = b.time;
  }

  // 돌파 시간대 분류 (breakRef 기준)
  let breakoutGroup = 'fail';
  if (breakoutTime_breakRef) {
    if (breakoutTime_breakRef <= '10:15') breakoutGroup = 'before_1015';
    else if (breakoutTime_breakRef <= '10:30') breakoutGroup = 'before_1030';
    else if (breakoutTime_breakRef <= '11:00') breakoutGroup = 'before_1100';
    else if (breakoutTime_breakRef <= '13:00') breakoutGroup = 'before_1300';
    else breakoutGroup = 'before_1530';
  }

  // 돌파 후 추가 상승 (breakRef 돌파 시점부터 측정)
  let postBreakoutAddon = null;
  if (breakoutTime_breakRef) {
    const afterBreak = bars.filter((b) => b && b.time > breakoutTime_breakRef && b.close > 0 && b.time <= '15:30');
    if (afterBreak.length > 0) {
      const breakoutPrice = breakRef;
      const maxHi2 = Math.max(...afterBreak.map((b) => b.high || 0));
      const lastCl2 = afterBreak[afterBreak.length - 1].close;
      const addon = ((maxHi2 / breakoutPrice) - 1) * 100;
      postBreakoutAddon = {
        addonHigh:    Number(addon.toFixed(2)),
        addonClose:   Number(((lastCl2 / breakoutPrice - 1) * 100).toFixed(2)),
        hit1_addon:   addon >= 1,
        hit2_addon:   addon >= 2,
        hit3_addon:   addon >= 3,
        hit5_addon:   addon >= 5,
      };
    }
  }

  // MFE / MAE (09:30 close 기준 post-10:00)
  const mfe_0930 = Number(((maxHi / E - 1) * 100).toFixed(2));
  const mae_0930 = Number(((minLo / E - 1) * 100).toFixed(2));
  const closeRet_0930 = Number(((lastClose / E - 1) * 100).toFixed(2));
  // MFE / MAE (10:00 close 기준)
  const mfe_1000 = Number(((maxHi / E1000 - 1) * 100).toFixed(2));
  const mae_1000 = Number(((minLo / E1000 - 1) * 100).toFixed(2));
  const closeRet_1000 = Number(((lastClose / E1000 - 1) * 100).toFixed(2));

  return {
    breakoutTime_breakRef, breakoutTime_0930, breakoutTime_1000bar,
    breakoutGroup,
    maxHi, maxHiTime, minLo, lastClose,
    // 09:30 close 기준
    mfe_0930, mae_0930, closeRet_0930,
    hit3_0930: !!hit3_0930, hit5_0930: !!hit5_0930, hit7_0930: !!hit7_0930, hit10_0930: !!hit10_0930,
    fail2_0930: !!fail2_0930, fail3_0930: !!fail3_0930, fail5_0930: !!fail5_0930,
    // 10:00 close 기준
    mfe_1000, mae_1000, closeRet_1000,
    hit1_1000: !!hit1_1000, hit2_1000: !!hit2_1000, hit3_1000: !!hit3_1000,
    hit5_1000: !!hit5_1000, hit7_1000: !!hit7_1000, hit10_1000: !!hit10_1000,
    // 돌파 후 추가
    postBreakoutAddon,
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

// ── 일자별 분석 ──
function analyzeDay(dirName, metaMap) {
  const dir = path.join(INTRADAY_BASE, dirName);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const nextDateNum = dirName.replace(/-/g, '');
  const out = [];
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
    let sum = 0, cnt = 0;
    for (let i = baseInfo.baseIdx - 20; i < baseInfo.baseIdx; i++) {
      const r = rows[i];
      if (r && r.volume > 0) { sum += (r.valueApprox || 0); cnt++; }
    }
    const avg20 = cnt > 0 ? sum / cnt : 0;
    const baseValue = baseRow.valueApprox || 0;
    const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) continue;
    let bars = null;
    try { bars = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8')).bars || []; }
    catch (_) { continue; }
    if (bars.length === 0) continue;

    const m = scanner.computeMetrics0930(bars, baseRow);
    if (!m || m.bars_total < 20) continue;
    const status = scanner.classifyStatus(m);
    if (status !== 'READY') continue;
    const surv = isSurvivor1000(bars, m);
    if (!surv) continue;
    // 10시 이후 분봉이 있어야 분석 가능
    const after10 = barsAfter(bars, '10:00');
    if (after10.length < 30) continue;  // 30분 미만은 데이터 부족

    const tenRebreak = detectTenRebreak(bars, m);
    const isExpTop = passesExplosiveTop(m);
    const isAttackI = passesAttackI(m, status, meta.marketCap || 0, !!tenRebreak);
    const perf = analyzePost1000(bars, m, surv);
    if (!perf) continue;

    // 09:30~10:00 후반 거래대금 감소 여부 측정 (실패 사례 분석용)
    const seg_1031_1100 = barsInRange(bars, '10:30', '11:00');
    const valueDecline_post = seg_1031_1100.length > 0
      ? sumValue(seg_1031_1100) / Math.max(1, surv.value_0931_1000)
      : null;

    out.push({
      date: dirName, code, name: meta.name || code,
      marketCap: meta.marketCap || 0,
      // 사전 (09:30~10:00)
      m, surv,
      isExpTop, isAttackI, hasTenRebreak: !!tenRebreak,
      rebreakMorningHigh: m.rebreakMorningHigh,
      // 사후
      perf,
      valueDecline_post,
    });
  }
  return out;
}

// ── 통계 ──
function avg(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function rate(n, t) { return t > 0 ? Number((n / t * 100).toFixed(1)) : 0; }
function fixed(v, d) { return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d == null ? 2 : d)); }

function summarizeGroup(label, entries) {
  const n = entries.length;
  if (n === 0) return { label, n: 0 };
  const mfe0930 = entries.map((e) => e.perf.mfe_0930);
  const mae0930 = entries.map((e) => e.perf.mae_0930);
  const close0930 = entries.map((e) => e.perf.closeRet_0930);
  const mfe1000 = entries.map((e) => e.perf.mfe_1000);
  const mae1000 = entries.map((e) => e.perf.mae_1000);
  const close1000 = entries.map((e) => e.perf.closeRet_1000);
  return {
    label, n,
    // 09:30 close 기준
    avgMFE_0930:    fixed(avg(mfe0930), 2),
    medianMFE_0930: fixed(median(mfe0930), 2),
    avgMAE_0930:    fixed(avg(mae0930), 2),
    avgClose_0930:  fixed(avg(close0930), 2),
    closePosRate:   rate(close0930.filter((r) => r > 0).length, n),
    hit3_0930:  rate(entries.filter((e) => e.perf.hit3_0930).length, n),
    hit5_0930:  rate(entries.filter((e) => e.perf.hit5_0930).length, n),
    hit7_0930:  rate(entries.filter((e) => e.perf.hit7_0930).length, n),
    hit10_0930: rate(entries.filter((e) => e.perf.hit10_0930).length, n),
    fail2_0930: rate(entries.filter((e) => e.perf.fail2_0930).length, n),
    fail3_0930: rate(entries.filter((e) => e.perf.fail3_0930).length, n),
    fail5_0930: rate(entries.filter((e) => e.perf.fail5_0930).length, n),
    worstLoss_0930: fixed(Math.min(...close0930), 2),
    // 10:00 close 기준 (돌파 후 진입 시뮬용)
    avgMFE_1000:    fixed(avg(mfe1000), 2),
    avgMAE_1000:    fixed(avg(mae1000), 2),
    avgClose_1000:  fixed(avg(close1000), 2),
    hit1_1000: rate(entries.filter((e) => e.perf.hit1_1000).length, n),
    hit2_1000: rate(entries.filter((e) => e.perf.hit2_1000).length, n),
    hit3_1000: rate(entries.filter((e) => e.perf.hit3_1000).length, n),
    hit5_1000: rate(entries.filter((e) => e.perf.hit5_1000).length, n),
  };
}

function summarizeAddon(entries) {
  const arr = entries.map((e) => e.perf.postBreakoutAddon).filter(Boolean);
  if (arr.length === 0) return { n: 0 };
  const high = arr.map((a) => a.addonHigh);
  const close = arr.map((a) => a.addonClose);
  return {
    n: arr.length,
    avgAddonHigh:  fixed(avg(high), 2),
    medianAddonHigh: fixed(median(high), 2),
    avgAddonClose: fixed(avg(close), 2),
    addon1: rate(arr.filter((a) => a.hit1_addon).length, arr.length),
    addon2: rate(arr.filter((a) => a.hit2_addon).length, arr.length),
    addon3: rate(arr.filter((a) => a.hit3_addon).length, arr.length),
    addon5: rate(arr.filter((a) => a.hit5_addon).length, arr.length),
    closePosRate: rate(close.filter((r) => r > 0).length, arr.length),
  };
}

// ── 태그별 그룹 분류 ──
function tagSubgroups(entries) {
  const total = entries.length;
  const v0930Sorted = [...entries].sort((a, b) => b.m.value_0930 - a.m.value_0930);
  const ratioSorted = [...entries].sort((a, b) => (b.m.valueToAvgRatio_0930 || 0) - (a.m.valueToAvgRatio_0930 || 0));
  const v0930Top30 = new Set(v0930Sorted.slice(0, Math.ceil(total * 0.3)).map((e) => e.date + '|' + e.code));
  const ratioTop30 = new Set(ratioSorted.slice(0, Math.ceil(total * 0.3)).map((e) => e.date + '|' + e.code));
  return {
    explosiveTop동시:   entries.filter((e) => e.isExpTop),
    I조건동시:           entries.filter((e) => e.isAttackI),
    explosiveTop_I동시:  entries.filter((e) => e.isExpTop && e.isAttackI),
    둘다없음:            entries.filter((e) => !e.isExpTop && !e.isAttackI),
    rebreakMH있음:       entries.filter((e) => e.rebreakMorningHigh),
    rebreakMH없음:       entries.filter((e) => !e.rebreakMorningHigh),
    valueToAvgRatio상위30: entries.filter((e) => ratioTop30.has(e.date + '|' + e.code)),
    value_0930상위30:    entries.filter((e) => v0930Top30.has(e.date + '|' + e.code)),
    '10:00close_고점대비_1%이내': entries.filter((e) => e.surv.closeToHighDrop_1000 >= -1),
    '10:00close_09:30대비_1%이상': entries.filter((e) => e.surv.aliveRate1000 >= 1),
    '10:00close_09:30대비_3%이상': entries.filter((e) => e.surv.aliveRate1000 >= 3),
  };
}

// ── 실패 사례 ──
function findFailures(entries) {
  return entries.filter((e) => {
    // (a) 09:31~10:00 high 돌파 실패
    const noBreak = !e.perf.breakoutTime_breakRef;
    // (b) 10시 이후 -3% 이상 하락
    const drop3 = e.perf.fail3_0930;
    // (c) 종가 -3% 이하
    const closeBad = e.perf.closeRet_0930 <= -3;
    return noBreak || drop3 || closeBad;
  });
}

// ── HTML ──
function renderHtml(out) {
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return '-';
    const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
    return `<span class="${cls}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
  }
  function fmtRate(v) { return v == null ? '-' : v.toFixed(1) + '%'; }
  function fmtMoney(v) { if (v == null) return '-'; if (v >= 1e12) return (v/1e12).toFixed(2)+'조'; if (v >= 1e8) return (v/1e8).toFixed(0)+'억'; return v.toLocaleString(); }

  // 1. 요약 결론
  const m = out.meta;
  const g = out.byBreakoutGroup;
  const ts = out.tagSubgroups;
  const allRow = out.allEntries;
  const success = out.successEntries;
  const fail = out.failureEntries;
  const breakRate = rate(success.length, allRow.length);
  const noBreakCount = allRow.length - success.length;

  const summaryLines = [
    `<strong>분석 대상</strong>: ${m.totalDays}거래일 (${m.dates[0]} ~ ${m.dates[m.dates.length-1]}), <strong>READY + 10시 생존 후보 ${allRow.length}건</strong> (일평균 ${(allRow.length / m.totalDays).toFixed(2)}개)`,
    `<strong>핵심 결과</strong>: 10시 생존 후보 중 <strong style="color:#d84315;">${breakRate}% (${success.length}건)</strong>이 10시 이후 09:31~10:00 high를 돌파. 미돌파 <strong>${rate(noBreakCount, allRow.length)}% (${noBreakCount}건)</strong>`,
    `<strong>돌파 시점 분포</strong>: 10:15 이전 ${g.before_1015.n}건 (${rate(g.before_1015.n, allRow.length)}%) · 10:30 이전 추가 ${g.before_1030.n}건 · 11:00 이전 추가 ${g.before_1100.n}건 · 13:00 이전 추가 ${g.before_1300.n}건 · 13:00 이후 ${g.before_1530.n}건`,
    `<strong>성공 vs 실패</strong>: 돌파 성공 평균 MFE <strong>${fmtPct(out.successSummary.avgMFE_0930)}</strong> / 종가 ${fmtPct(out.successSummary.avgClose_0930)} 승률 ${fmtRate(out.successSummary.closePosRate)} · 돌파 실패 평균 MFE <strong>${fmtPct(out.failSummary.avgMFE_0930)}</strong> / 종가 ${fmtPct(out.failSummary.avgClose_0930)} 승률 ${fmtRate(out.failSummary.closePosRate)}`,
    `<strong>10:00 즉시 진입 vs 돌파 대기</strong>: 09:30 close 진입 평균 종가 ${fmtPct(out.allSummary.avgClose_0930)} 승률 ${fmtRate(out.allSummary.closePosRate)} · 돌파 후 진입(돌파 가격 기준, 추가 상승) 평균 ${fmtPct(out.addonOverall.avgAddonClose)} 도달 +2% 이상 ${fmtRate(out.addonOverall.addon2)}`,
  ];

  function groupTable(rows) {
    const head = `<thead><tr>
      <th>구분</th><th>n</th><th>비율</th>
      <th>avg MFE</th><th>median MFE</th><th>avg 종가</th><th>종가+</th>
      <th>+3%</th><th>+5%</th><th>+7%</th><th>+10%</th>
      <th>-2%</th><th>-3%</th><th>-5%</th><th>worst</th>
    </tr></thead>`;
    const body = rows.map(([label, s, total]) => {
      if (!s || s.n === 0) return `<tr><td><strong>${esc(label)}</strong></td><td>0</td><td>-</td><td colspan="12" style="color:#888;text-align:left;">샘플 없음</td></tr>`;
      return `<tr>
        <td><strong>${esc(label)}</strong></td>
        <td class="num">${s.n}</td>
        <td class="num">${total ? rate(s.n, total).toFixed(1) + '%' : '-'}</td>
        <td class="num">${fmtPct(s.avgMFE_0930)}</td>
        <td class="num">${fmtPct(s.medianMFE_0930)}</td>
        <td class="num">${fmtPct(s.avgClose_0930)}</td>
        <td class="num">${fmtRate(s.closePosRate)}</td>
        <td class="num">${fmtRate(s.hit3_0930)}</td>
        <td class="num">${fmtRate(s.hit5_0930)}</td>
        <td class="num">${fmtRate(s.hit7_0930)}</td>
        <td class="num">${fmtRate(s.hit10_0930)}</td>
        <td class="num">${fmtRate(s.fail2_0930)}</td>
        <td class="num">${fmtRate(s.fail3_0930)}</td>
        <td class="num">${fmtRate(s.fail5_0930)}</td>
        <td class="num">${fmtPct(s.worstLoss_0930)}</td>
      </tr>`;
    }).join('');
    return `<table>${head}<tbody>${body}</tbody></table>`;
  }

  // 2. 돌파율
  const breakoutSummary = `<h2>2. 10시 생존 후보의 돌파율</h2>
    <p>전체 ${allRow.length}건 중:</p>
    <ul>
      <li><strong>09:31~10:00 high 돌파 성공:</strong> ${success.length}건 (<strong>${breakRate}%</strong>) — 핵심 기준</li>
      <li><strong>09:30 high 돌파(post-10:00):</strong> ${out.breakStats.broke_0930.n}건 (${rate(out.breakStats.broke_0930.n, allRow.length)}%)</li>
      <li><strong>10:00 bar high 돌파:</strong> ${out.breakStats.broke_1000bar.n}건 (${rate(out.breakStats.broke_1000bar.n, allRow.length)}%)</li>
      <li><strong>미돌파(어느 기준에서도 안 깨짐):</strong> ${noBreakCount}건 (${rate(noBreakCount, allRow.length)}%)</li>
    </ul>`;

  // 3. 성공 vs 실패
  const successFailTable = groupTable([
    ['10시 생존 + 돌파 성공', out.successSummary, allRow.length],
    ['10시 생존 + 돌파 실패', out.failSummary, allRow.length],
    ['전체 (참고)', out.allSummary, allRow.length],
  ]);

  // 4. 돌파 시간대별
  const timeGroupTable = groupTable([
    ['10:15 이전 돌파', g.before_1015, allRow.length],
    ['10:30 이전 돌파', g.before_1030, allRow.length],
    ['11:00 이전 돌파', g.before_1100, allRow.length],
    ['13:00 이전 돌파', g.before_1300, allRow.length],
    ['13:00 이후 돌파', g.before_1530, allRow.length],
    ['돌파 실패',       g.fail,        allRow.length],
  ]);

  // 5. 돌파 후 추가 상승
  const addonTable = `<table><thead><tr>
    <th>그룹</th><th>n</th>
    <th>avg 추가↑(고가)</th><th>median</th>
    <th>avg 추가↑(종가)</th><th>종가+</th>
    <th>+1%↑</th><th>+2%↑</th><th>+3%↑</th><th>+5%↑</th>
  </tr></thead><tbody>
    ${[
      ['10:15 이전 돌파', out.addonByGroup.before_1015],
      ['10:30 이전 돌파', out.addonByGroup.before_1030],
      ['11:00 이전 돌파', out.addonByGroup.before_1100],
      ['13:00 이전 돌파', out.addonByGroup.before_1300],
      ['13:00 이후 돌파', out.addonByGroup.before_1530],
      ['전체 돌파 성공',  out.addonOverall],
    ].map(([label, a]) => {
      if (!a || a.n === 0) return `<tr><td><strong>${esc(label)}</strong></td><td>0</td><td colspan="8">샘플 없음</td></tr>`;
      return `<tr>
        <td><strong>${esc(label)}</strong></td>
        <td class="num">${a.n}</td>
        <td class="num">${fmtPct(a.avgAddonHigh)}</td>
        <td class="num">${fmtPct(a.medianAddonHigh)}</td>
        <td class="num">${fmtPct(a.avgAddonClose)}</td>
        <td class="num">${fmtRate(a.closePosRate)}</td>
        <td class="num">${fmtRate(a.addon1)}</td>
        <td class="num">${fmtRate(a.addon2)}</td>
        <td class="num">${fmtRate(a.addon3)}</td>
        <td class="num">${fmtRate(a.addon5)}</td>
      </tr>`;
    }).join('')}
  </tbody></table>`;

  // 6. 태그별 (ts는 이미 pre-computed summary)
  const tagTable = groupTable(
    Object.entries(ts).map(([k, s]) => [k, s, allRow.length])
  );

  // 7. 실패 사례
  function failureCardList(list, limit) {
    const sample = list.slice(0, limit);
    const rows = sample.map((e) => `
      <tr>
        <td>${esc(e.date)}</td>
        <td>${esc(e.code)}</td>
        <td>${esc(e.name)}</td>
        <td class="num">${fmtMoney(e.marketCap)}</td>
        <td class="num">${fmtPct(e.surv.aliveRate1000)}</td>
        <td class="num">${fmtPct(e.surv.closeToHighDrop_1000)}</td>
        <td class="num">${fmtMoney(e.surv.value_0931_1000)}</td>
        <td class="num">${e.valueDecline_post != null ? (e.valueDecline_post * 100).toFixed(0) + '%' : '-'}</td>
        <td>${e.isExpTop ? 'EXP' : ''}${e.isAttackI ? ' I' : ''}</td>
        <td class="num">${fmtPct(e.m.openToLastRate)}</td>
        <td class="num">${(e.m.valueToAvgRatio_0930 || 0).toFixed(1)}×</td>
        <td>${e.perf.breakoutTime_breakRef || '미돌파'}</td>
        <td class="num">${fmtPct(e.perf.mfe_0930)}</td>
        <td class="num">${fmtPct(e.perf.mae_0930)}</td>
        <td class="num">${fmtPct(e.perf.closeRet_0930)}</td>
      </tr>`).join('');
    return `<table style="font-size:11px;"><thead><tr>
      <th>날짜</th><th>코드</th><th>종목</th><th>시총</th>
      <th>alive%</th><th>10:00 close vs high</th><th>09:31~10:00 v</th><th>10:30~11:00 v 비율</th>
      <th>태그</th><th>open%</th><th>v/avg</th>
      <th>돌파시간</th><th>MFE</th><th>MAE</th><th>종가수익</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  // 운영 결론 작성
  const conclusions = [];
  // Q1: 돌파율
  conclusions.push(`<li><strong>1. 10시 생존 후보 중 ${breakRate}%가 09:31~10:00 high 돌파.</strong> 절반이 안 되거나(${breakRate < 50 ? '예' : '아니오'}) 절반 이상.</li>`);
  // Q2: 성공 vs 실패 성과 차이
  const gap = (out.successSummary.avgClose_0930 || 0) - (out.failSummary.avgClose_0930 || 0);
  conclusions.push(`<li><strong>2. 성공-실패 종가 평균 차이 ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%p</strong> (성공 ${fmtPct(out.successSummary.avgClose_0930)}, 실패 ${fmtPct(out.failSummary.avgClose_0930)}). ${gap >= 1.5 ? '돌파 여부가 강한 신호' : '돌파 여부 신호 약함'}.</li>`);
  // Q3: 컷오프
  const cumByCut = {
    '10:15': g.before_1015.n,
    '10:30': g.before_1015.n + g.before_1030.n,
    '11:00': g.before_1015.n + g.before_1030.n + g.before_1100.n,
  };
  conclusions.push(`<li><strong>3. 컷오프 누적 돌파 수</strong>: 10:15까지 ${cumByCut['10:15']}건 (${rate(cumByCut['10:15'], allRow.length)}%) · 10:30까지 ${cumByCut['10:30']}건 (${rate(cumByCut['10:30'], allRow.length)}%) · 11:00까지 ${cumByCut['11:00']}건 (${rate(cumByCut['11:00'], allRow.length)}%). 11시까지 돌파 안 되면 제외 고려.</li>`);
  // Q4: 즉시 vs 돌파 대기
  const immediate = out.allSummary.avgClose_0930;
  const wait = out.addonOverall.avgAddonClose;
  conclusions.push(`<li><strong>4. 09:30 close 진입 종가 평균 ${fmtPct(immediate)}</strong>(전 후보 보유) <strong>vs 돌파 후 진입 종가 평균 ${fmtPct(wait)}</strong>(돌파한 후보만). ${(wait || 0) > (immediate || 0) + 0.5 ? '돌파 대기가 더 좋음 — 대기 후 진입 고려' : '돌파 대기로 큰 이점 없음 — 10:00 생존 즉시 진입 OK'}.</li>`);
  // Q5: 추가 필터 (ts는 pre-computed summary)
  const expTopSum = ts.explosiveTop동시 && ts.explosiveTop동시.n > 0 ? ts.explosiveTop동시 : null;
  const iSum      = ts.I조건동시 && ts.I조건동시.n > 0 ? ts.I조건동시 : null;
  const tightSum  = ts['10:00close_고점대비_1%이내'] && ts['10:00close_고점대비_1%이내'].n > 0 ? ts['10:00close_고점대비_1%이내'] : null;
  conclusions.push(`<li><strong>5. 추가 필터</strong>: explosiveTop 동시 (n=${expTopSum ? expTopSum.n : 0}) 종가 평균 ${expTopSum ? fmtPct(expTopSum.avgClose_0930) : '-'} · I 조건 동시 (n=${iSum ? iSum.n : 0}) ${iSum ? fmtPct(iSum.avgClose_0930) : '-'} · 10:00 close 고점 -1% 이내 (n=${tightSum ? tightSum.n : 0}) ${tightSum ? fmtPct(tightSum.avgClose_0930) : '-'}. 강한 필터 시 표본 줄지만 평균 상승.</li>`);
  // Q6: 상태 분리
  conclusions.push(`<li><strong>6. "돌파 대기 / 돌파 성공 / 돌파 실패" 상태 분리</strong>: ${gap >= 1.5 ? '권장 — 돌파 성공만 핵심 메인으로, 대기 중은 보조, 실패는 제외' : '명확한 이점 없음 — 현 5섹션 유지 가능'}.</li>`);

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>1DS 10시 생존 후보의 돌파 예측력 검증</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; max-width: 1700px; margin: 0 auto; color: #222; background: #fafafa; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #ddd; }
  h3 { font-size: 14px; margin: 16px 0 6px; color: #444; }
  .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 11.5px; margin-bottom: 12px; }
  th, td { border: 1px solid #ddd; padding: 4px 7px; text-align: left; white-space: nowrap; }
  th { background: #f0f0f0; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #c62828; }
  .neg { color: #1565c0; }
  .summary { background: #fff; padding: 12px 16px; border-radius: 6px; border: 1px solid #e0e0e0; margin-bottom: 18px; }
  .summary strong { color: #d84315; }
  ul { padding-left: 22px; } li { margin: 4px 0; font-size: 13px; }
</style>
</head>
<body>
<h1>1DS — 10시 생존 후보의 돌파 예측력 검증</h1>
<div class="meta">생성 ${m.generatedAt} · ${m.totalDays}거래일 (${m.dates[0]} ~ ${m.dates[m.dates.length-1]}) · 소요 ${m.elapsedSec}s · 후보 ${allRow.length}건</div>

<div class="summary">
  <h2 style="margin-top:0;border:none;">1. 요약 결론</h2>
  <ul>${summaryLines.map((s) => `<li>${s}</li>`).join('')}</ul>
</div>

${breakoutSummary}

<h2>3. 돌파 성공 vs 실패 성과 비교 (post-10:00 ~ 종가, 09:30 close 기준)</h2>
${successFailTable}

<h2>4. 돌파 시간대별 성과</h2>
${timeGroupTable}

<h2>5. 돌파 후 추가 상승 (돌파 가격 = 09:31~10:00 high 기준 진입 시뮬)</h2>
${addonTable}
<p style="font-size:11px;color:#888;">"avg 추가↑(고가)" = 돌파 시점 가격 대비 이후 최고가 도달 %. "avg 추가↑(종가)" = 돌파 시점 가격 대비 종가 수익률.</p>

<h2>6. 태그/조건별 비교 (10시 생존 후보 내 subgroup)</h2>
${tagTable}

<h2>7. 실패 사례 분석 (${fail.length}건 — 미돌파 OR -3% 이탈 OR 종가 -3% 이하)</h2>
<p>전체 ${allRow.length}건 중 ${fail.length}건 (${rate(fail.length, allRow.length)}%)이 실패. 상위 20건 표시:</p>
${failureCardList(fail.slice().sort((a, b) => a.perf.closeRet_0930 - b.perf.closeRet_0930), 20)}

<h3>실패 사례 공통점 (중앙값)</h3>
<ul>
  <li>alive 율 (10:00 vs 09:30) 중앙: <strong>${fmtPct(median(fail.map((e) => e.surv.aliveRate1000)))}</strong></li>
  <li>10:00 close vs 09:31~10:00 high 드롭 중앙: <strong>${fmtPct(median(fail.map((e) => e.surv.closeToHighDrop_1000)))}</strong></li>
  <li>09:31~10:00 거래대금 중앙: <strong>${fmtMoney(median(fail.map((e) => e.surv.value_0931_1000)))}</strong></li>
  <li>10:30~11:00 거래대금 / 09:31~10:00 거래대금 비율 중앙: <strong>${(median(fail.filter((e) => e.valueDecline_post != null).map((e) => e.valueDecline_post)) * 100).toFixed(0)}%</strong> (감소 여부)</li>
  <li>explosiveTop 동시: ${rate(fail.filter((e) => e.isExpTop).length, fail.length)}% · I 조건 동시: ${rate(fail.filter((e) => e.isAttackI).length, fail.length)}%</li>
  <li>시가 대비 상승률 중앙: <strong>${fmtPct(median(fail.map((e) => e.m.openToLastRate)))}</strong> · v/avg 중앙: <strong>${(median(fail.map((e) => e.m.valueToAvgRatio_0930 || 0))).toFixed(1)}×</strong> · 시총 중앙: <strong>${fmtMoney(median(fail.map((e) => e.marketCap)))}</strong></li>
</ul>

<h2>8. 최종 운영 제안</h2>
<ul>${conclusions.join('')}</ul>

<div style="margin-top:30px;border-top:1px dashed #ccc;padding-top:10px;color:#888;font-size:11px;">
  돌파 기준: 09:31~10:00 high 기준 (핵심). 진입 시뮬은 미래 누수 없음 — 돌파 시점 이후 분봉만 사용.<br>
  10:00 close = 진입 후보 가격 / 09:30 close = 베이스라인. 두 기준 모두 보고함.
</div>
</body>
</html>`;
}

// ── main ──
async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(INTRADAY_BASE)) { console.error('[ERROR] data/intraday/1ds 없음'); process.exit(1); }

  console.log('\n🔬 1DS 10시 생존 후보의 돌파 예측력 검증');
  const t0 = Date.now();

  const metaMap = scanner.loadStockMetaMap();
  console.log(`  메타: ${metaMap.size}건`);

  const allDirs = fs.readdirSync(INTRADAY_BASE).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  let dirs = allDirs.filter((d) => fs.readdirSync(path.join(INTRADAY_BASE, d)).length >= args.minDirSize);
  if (args.from) dirs = dirs.filter((d) => d >= args.from);
  if (args.to)   dirs = dirs.filter((d) => d <= args.to);
  if (args.days && dirs.length > args.days) dirs = dirs.slice(-args.days);
  console.log(`  대상 거래일: ${dirs.length}일 (${dirs[0]} ~ ${dirs[dirs.length-1]})`);

  // entries 빌드
  const allEntries = [];
  for (const d of dirs) {
    const day = analyzeDay(d, metaMap);
    for (const e of day) allEntries.push(e);
  }
  console.log(`  ✅ READY + 10시 생존 후보: ${allEntries.length}건 (일평균 ${(allEntries.length / dirs.length).toFixed(2)})`);

  // 돌파 통계
  const breakStats = {
    broke_breakRef: { n: allEntries.filter((e) => e.perf.breakoutTime_breakRef).length },
    broke_0930:     { n: allEntries.filter((e) => e.perf.breakoutTime_0930).length },
    broke_1000bar:  { n: allEntries.filter((e) => e.perf.breakoutTime_1000bar).length },
  };
  console.log(`  돌파 (09:31~10:00 high): ${breakStats.broke_breakRef.n}건 (${rate(breakStats.broke_breakRef.n, allEntries.length)}%)`);
  console.log(`  돌파 (09:30 high post-10:00): ${breakStats.broke_0930.n}건 · 10:00 bar high: ${breakStats.broke_1000bar.n}건`);

  // 그룹 분류
  const successEntries = allEntries.filter((e) => e.perf.breakoutTime_breakRef);
  const failureEntries = findFailures(allEntries);
  const successSummary = summarizeGroup('돌파 성공', successEntries);
  const failSummary = summarizeGroup('돌파 실패', allEntries.filter((e) => !e.perf.breakoutTime_breakRef));
  const allSummary = summarizeGroup('전체', allEntries);

  // 돌파 시간대 그룹
  const groupNames = ['before_1015', 'before_1030', 'before_1100', 'before_1300', 'before_1530', 'fail'];
  const byBreakoutGroup = {};
  for (const g of groupNames) {
    byBreakoutGroup[g] = summarizeGroup(g, allEntries.filter((e) => e.perf.breakoutGroup === g));
  }

  // 돌파 후 addon
  const addonOverall = summarizeAddon(successEntries);
  const addonByGroup = {};
  for (const g of groupNames.filter((g) => g !== 'fail')) {
    addonByGroup[g] = summarizeAddon(allEntries.filter((e) => e.perf.breakoutGroup === g));
  }

  // 태그별 subgroup
  const tagGroups = tagSubgroups(allEntries);
  const tagSummaries = {};
  for (const [k, list] of Object.entries(tagGroups)) {
    tagSummaries[k] = summarizeGroup(k, list);
  }

  const elapsedSec = Number(((Date.now() - t0) / 1000).toFixed(2));
  const out = {
    meta: {
      title: '1DS 10시 생존 후보의 돌파 예측력 검증',
      generatedAt: new Date().toISOString(),
      dates: dirs, totalDays: dirs.length,
      totalEntries: allEntries.length,
      elapsedSec,
      methodology: '60거래일 READY + 10시 생존 후보 추출 → 10시 이후 09:31~10:00 high 돌파 여부 분석. 미래 누수 없음.',
    },
    breakStats,
    allEntries: allEntries.map((e) => ({  // 슬림화
      date: e.date, code: e.code, name: e.name, marketCap: e.marketCap,
      aliveRate1000: e.surv.aliveRate1000, closeToHighDrop_1000: e.surv.closeToHighDrop_1000,
      value_0931_1000: e.surv.value_0931_1000,
      isExpTop: e.isExpTop, isAttackI: e.isAttackI, hasTenRebreak: e.hasTenRebreak,
      m: { value_0930: e.m.value_0930, valueToAvgRatio_0930: e.m.valueToAvgRatio_0930,
           closePosition0930: e.m.closePosition0930, openToLastRate: e.m.openToLastRate,
           highToLastDrop: e.m.highToLastDrop, rebreakMorningHigh: e.m.rebreakMorningHigh },
      perf: e.perf,
      valueDecline_post: e.valueDecline_post,
    })),
    successEntries: successEntries.map((e) => ({ date: e.date, code: e.code, name: e.name, perf: e.perf })),
    failureEntries: failureEntries.map((e) => ({ date: e.date, code: e.code, name: e.name, perf: e.perf, surv: e.surv })),
    successSummary, failSummary, allSummary,
    byBreakoutGroup,
    addonOverall, addonByGroup,
    tagSubgroups: tagSummaries,
  };

  // HTML needs full entries — pass full version
  out.allEntries = allEntries;
  out.successEntries = successEntries;
  out.failureEntries = failureEntries;

  const html = renderHtml(out);

  // JSON에는 슬림화된 entries로 다시 변경 (파일 크기 줄이기)
  const outJson = {
    ...out,
    allEntries: undefined,  // 너무 큼 — 카운트만
    successEntries: undefined,
    failureEntries: undefined,
    allEntriesCount: allEntries.length,
    successEntriesCount: successEntries.length,
    failureEntriesCount: failureEntries.length,
    successEntriesSample: successEntries.slice(0, 20).map((e) => ({ date: e.date, code: e.code, name: e.name, perf: e.perf, surv: e.surv, isExpTop: e.isExpTop, isAttackI: e.isAttackI })),
    failureEntriesSample: failureEntries.slice(0, 30).map((e) => ({ date: e.date, code: e.code, name: e.name, perf: e.perf, surv: e.surv, m: { openToLastRate: e.m.openToLastRate, value_0930: e.m.value_0930, valueToAvgRatio_0930: e.m.valueToAvgRatio_0930 }, marketCap: e.marketCap, isExpTop: e.isExpTop, isAttackI: e.isAttackI, valueDecline_post: e.valueDecline_post })),
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(outJson, null, 2));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  console.log(`\n  ⏱ 소요 ${elapsedSec}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
  console.log(`\n  📌 핵심 결과:`);
  console.log(`     돌파율: ${rate(successEntries.length, allEntries.length)}% (${successEntries.length}/${allEntries.length})`);
  console.log(`     성공 평균 종가: ${successSummary.avgClose_0930}%, 실패 평균 종가: ${failSummary.avgClose_0930}%, 차이: ${((successSummary.avgClose_0930 || 0) - (failSummary.avgClose_0930 || 0)).toFixed(2)}%p`);
  console.log(`     돌파 시점: 10:15까지 ${byBreakoutGroup.before_1015.n} · 10:30까지 ${byBreakoutGroup.before_1015.n + byBreakoutGroup.before_1030.n} · 11:00까지 ${byBreakoutGroup.before_1015.n + byBreakoutGroup.before_1030.n + byBreakoutGroup.before_1100.n}`);
  console.log(`     돌파 후 추가 상승 (avg): 최고가 ${addonOverall.avgAddonHigh}%, 종가 ${addonOverall.avgAddonClose}%`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
}

module.exports = { main };
