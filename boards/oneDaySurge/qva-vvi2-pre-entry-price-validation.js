#!/usr/bin/env node
/**
 * VVI2_PRE_A 분봉 감지 시점 진입가 기준 백테스트
 *
 * 목적:
 *   분봉 strict 09:30 / 10:00 감지 시점 가격으로 실제 진입했을 때
 *   D+0/D+1~D+20 성과 + stop/take 시뮬레이션 + first-touch 분석.
 *   운영 보드/알림 전에 "실제 진입했을 때 수익이 나는가" 검증.
 *
 * 중요:
 *   - 새 운영 보드 / 라우터 / cron / 실시간 알림 만들지 않는다.
 *   - 기존 QVA1/QVA2/VVI2 / 일봉 PRE_A 분류 로직은 변경하지 않는다.
 *   - 분봉 cache (cache/kis-minute/{code}/{yyyymmdd}.json)는 이미 받아 둠 — fetch X.
 *
 * 입력:
 *   - DB board_signals (QVA1/QVA2)
 *   - cache/stock-charts-long/{code}.json (일봉)
 *   - cache/kis-minute/{code}/{yyyymmdd}.json (분봉 raw — 09:00~14:30)
 *
 * 출력:
 *   - reports/qva-vvi2-pre-entry-price-validation-result.json
 *   - reports/qva-vvi2-pre-entry-price-validation-result.html
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { query, closePool, isEnabled } = require(path.join(ROOT, 'src', 'db', 'mysql'));
const { findVvi2AfterQva2 } = require(path.join(ROOT, 'boards', 'qva2', 'qva2-screener'));

const CHART_DIR  = path.join(ROOT, 'cache', 'stock-charts-long');
const MINUTE_DIR = path.join(ROOT, 'cache', 'kis-minute');
const OUT_JSON   = path.join(ROOT, 'reports', 'qva-vvi2-pre-entry-price-validation-result.json');
const OUT_HTML   = path.join(ROOT, 'reports', 'qva-vvi2-pre-entry-price-validation-result.html');

const FOLLOW_DAYS = 20;

// 검증 시점 (이전 validation과 동일)
const SNAPSHOT_TIMES = [
  { label: '09:10', hhmmss: '091000' },
  { label: '09:30', hhmmss: '093000' },
  { label: '10:00', hhmmss: '100000' },
];
const RATIO_THRESHOLD_BY_TIME = { '09:10': 0.25, '09:30': 0.40, '10:00': 0.60 };

// ─── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { days: 60, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--days') a.days = parseInt(argv[++i], 10) || 60;
    else if (k === '--dry-run') a.dryRun = true;
  }
  return a;
}

// ─── 유틸 ────────────────────────────────────────────────────────────────
function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}
function loadMinuteCache(code, ymd) {
  const fp = path.join(MINUTE_DIR, code, ymd + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}
function pct(num, denom) {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return null;
  return Number(((num / denom - 1) * 100).toFixed(2));
}
function fmtPct(v, p = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + Number(v).toFixed(p) + '%';
}
function fmtInt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString();
}
function ymdDash(ymd) {
  const s = String(ymd);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}
function avg(arr) {
  const xs = arr.filter(v => Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}
function median(arr) {
  const xs = arr.filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
function rate(num, denom) { return denom > 0 ? Number((num / denom * 100).toFixed(1)) : 0; }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sampleQualityOf(n) {
  if (n >= 300) return '신뢰가능';
  if (n >= 100) return '참고가능';
  if (n >=  30) return '표본작음';
  return '해석주의';
}
function sampleQualityPill(q) {
  const map = { '신뢰가능': 'p-good', '참고가능': 'p-q2', '표본작음': 'p-neu', '해석주의': 'p-warn' };
  return `<span class="pill ${map[q] || 'p-neu'}">${esc(q)}</span>`;
}

// ─── 일봉 PRE 분류 (qva-vvi2-pre-validation.js와 동일) ───────────────────
function classifyDailyPre(d) {
  const { intradayBreakQvaHigh, valueNearQva, valueOverQva, volumeNearQva, volumeOverQva, closeHoldQvaHigh, closeNearQvaHigh } = d;
  if (intradayBreakQvaHigh && valueOverQva && volumeOverQva && closeHoldQvaHigh) return 'PRE_A_STRONG';
  if (intradayBreakQvaHigh && valueNearQva && volumeNearQva && closeNearQvaHigh) return 'PRE_B_EARLY';
  if (intradayBreakQvaHigh && valueNearQva && volumeNearQva && !closeHoldQvaHigh) return 'PRE_C_INTRADAY_ONLY';
  if (!intradayBreakQvaHigh && valueOverQva && volumeOverQva) return 'PRE_D_VALUE_ONLY';
  if (intradayBreakQvaHigh && !closeNearQvaHigh) return 'BREAK_FAIL';
  return 'NO_PRE';
}

// ─── 분봉 raw → snapshot (이전 validation과 동일 로직) ──────────────────
function buildSnapshotsAt(rawBars, qvaHigh, qvaVolume, qvaValue) {
  const bars = rawBars.map(r => ({
    hhmmss: r.stck_cntg_hour,
    open:  Number(r.stck_oprc) || null,
    high:  Number(r.stck_hgpr) || null,
    low:   Number(r.stck_lwpr) || null,
    close: Number(r.stck_prpr) || null,
    volume: Number(r.cntg_vol) || 0,
    acmlValue: Number(r.acml_tr_pbmn) || 0,
    acmlVol:  Number(r.acml_vol) || 0,
  })).filter(b => b.hhmmss && b.close);

  const result = {};
  for (const snap of SNAPSHOT_TIMES) {
    let lastIdx = -1;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].hhmmss <= snap.hhmmss) lastIdx = i; else break;
    }
    if (lastIdx < 0) { result[snap.label] = null; continue; }
    let cumVol = 0;
    let high = -Infinity, low = Infinity;
    let brokenQvaHigh = false;
    for (let i = 0; i <= lastIdx; i++) {
      cumVol += (bars[i].volume || 0);
      if (bars[i].high != null && bars[i].high > high) high = bars[i].high;
      if (bars[i].low  != null && bars[i].low  < low)  low  = bars[i].low;
      if (bars[i].high >= qvaHigh) brokenQvaHigh = true;
    }
    const lastBar = bars[lastIdx];
    const lastPrice = lastBar.close;
    const valueSoFar = lastBar.acmlValue;
    // 다음 분봉 (entry_nextMinute용)
    const nextBar = bars[lastIdx + 1] || null;
    // VWAP (cumValue / cumVol)
    const vwap = lastBar.acmlVol > 0 ? lastBar.acmlValue / lastBar.acmlVol : null;
    // last3 hold (strict 조건용)
    const last3 = bars.slice(Math.max(0, lastIdx - 2), lastIdx + 1);
    const last3HoldQvaHigh = last3.filter(b => b.close >= qvaHigh).length >= 2;

    result[snap.label] = {
      snapshotTime: snap.label, hhmmss: snap.hhmmss,
      lastPrice, lastBarIdx: lastIdx,
      nextBarClose: nextBar ? nextBar.close : null,
      vwap,
      volumeSoFar: cumVol, valueSoFar,
      valueToQvaRatioSoFar:  qvaValue  > 0 ? Number((valueSoFar / qvaValue).toFixed(3))  : null,
      volumeToQvaRatioSoFar: qvaVolume > 0 ? Number((cumVol     / qvaVolume).toFixed(3)) : null,
      priceToQvaHighPct: pct(lastPrice, qvaHigh),
      isAboveQvaHigh: lastPrice >= qvaHigh,
      hasBrokenQvaHighSoFar: brokenQvaHigh,
      last3HoldQvaHigh,
    };
  }
  return { result, bars };
}

function classifyIntradayPreA(snap) {
  if (!snap) return { strict: false, base: false };
  const thr = RATIO_THRESHOLD_BY_TIME[snap.snapshotTime];
  if (thr == null) return { strict: false, base: false };
  const baseTime = snap.snapshotTime;
  let basePriceOk;
  if (baseTime === '09:10' || baseTime === '09:30') basePriceOk = snap.priceToQvaHighPct != null && snap.priceToQvaHighPct >= -1.0;
  else basePriceOk = snap.isAboveQvaHigh;
  const base = snap.hasBrokenQvaHighSoFar
            && basePriceOk
            && (snap.valueToQvaRatioSoFar  ?? 0) >= thr
            && (snap.volumeToQvaRatioSoFar ?? 0) >= thr;
  const strict = snap.hasBrokenQvaHighSoFar
              && snap.isAboveQvaHigh
              && (snap.valueToQvaRatioSoFar  ?? 0) >= thr
              && (snap.volumeToQvaRatioSoFar ?? 0) >= thr
              && snap.last3HoldQvaHigh;
  return { strict, base };
}

// ─── 진입 이후 성과 시뮬레이션 ──────────────────────────────────────────
// entryPrice 기준 D+0(분봉 잔여) + D+1~D+20 일봉 OHLC로 성과 계산.
function simulateEntry(entryPrice, barsAfterEntry, dailyRowsAfter /* D+1~D+20 */) {
  // D+0 잔여 (분봉)
  let day0High = -Infinity, day0Low = Infinity, day0Close = null;
  for (const b of barsAfterEntry) {
    if (b.high != null && b.high > day0High) day0High = b.high;
    if (b.low  != null && b.low  < day0Low)  day0Low  = b.low;
    if (b.close != null) day0Close = b.close;
  }
  if (day0High === -Infinity) day0High = entryPrice;
  if (day0Low === Infinity) day0Low = entryPrice;
  if (day0Close == null) day0Close = entryPrice;

  // 누적 max/min trace — D+0부터 D+20까지
  // 각 거래일에 high, low 시계열을 만들어 hit/breach/first-touch 시뮬레이션
  // 결과적으로 max/min after entry, hit 도달 D, breach 도달 D
  const timeline = [];
  // D+0
  timeline.push({ d: 0, high: day0High, low: day0Low, close: day0Close });
  // D+1~D+20
  for (let i = 0; i < dailyRowsAfter.length; i++) {
    timeline.push({ d: i + 1, high: dailyRowsAfter[i].high, low: dailyRowsAfter[i].low, close: dailyRowsAfter[i].close });
  }

  // 누적 max/min for upDay/downDay anchors
  // hit/breach: cumulative 누적 (max high so far, min low so far) 기준
  let cumMaxHigh = entryPrice, cumMinLow = entryPrice;
  const upHits = {}, downBreaches = {};
  // first-touch: 각 거래일에서 high(상승)/low(하락) 중 어느 게 먼저 닿았는지 — 같은 날에 둘 다면 보수적으로 low 우선
  const upThresholds = [3, 5, 7, 10, 15, 20, 30, 50];
  const downThresholds = [3, 5, 7, 10];
  const firstHitDay = {}, firstBreachDay = {};

  for (const row of timeline) {
    const high = row.high, low = row.low;
    if (Number.isFinite(high) && high > cumMaxHigh) cumMaxHigh = high;
    if (Number.isFinite(low)  && low  < cumMinLow)  cumMinLow  = low;
    const upPct   = pct(cumMaxHigh, entryPrice);
    const downPct = pct(cumMinLow,  entryPrice);
    for (const t of upThresholds) {
      if (firstHitDay[t] == null && upPct != null && upPct >= t) firstHitDay[t] = row.d;
    }
    for (const t of downThresholds) {
      if (firstBreachDay[t] == null && downPct != null && downPct <= -t) firstBreachDay[t] = row.d;
    }
  }

  // milestone arrays
  const dayCheckpoints = [1, 2, 3, 5, 10, 20];
  const maxUpAt = {}, maxDownAt = {};
  let runningMaxHigh = entryPrice, runningMinLow = entryPrice;
  for (const row of timeline) {
    if (Number.isFinite(row.high) && row.high > runningMaxHigh) runningMaxHigh = row.high;
    if (Number.isFinite(row.low)  && row.low  < runningMinLow)  runningMinLow  = row.low;
    if (dayCheckpoints.includes(row.d)) {
      maxUpAt[row.d]   = pct(runningMaxHigh, entryPrice);
      maxDownAt[row.d] = pct(runningMinLow, entryPrice);
    }
  }

  return {
    entryPrice,
    day0High, day0Low, day0Close,
    entryToDayHighPct:  pct(day0High,  entryPrice),
    entryToDayLowPct:   pct(day0Low,   entryPrice),
    entryToDayClosePct: pct(day0Close, entryPrice),
    closeAboveEntry: day0Close >= entryPrice,
    maxUpFromEntry: pct(cumMaxHigh, entryPrice),
    maxDownFromEntry: pct(cumMinLow, entryPrice),
    d1MaxUp:  maxUpAt[1]  ?? null,  d1MaxDown:  maxDownAt[1]  ?? null,
    d2MaxUp:  maxUpAt[2]  ?? null,
    d3MaxUp:  maxUpAt[3]  ?? null,  d3MaxDown:  maxDownAt[3]  ?? null,
    d5MaxUp:  maxUpAt[5]  ?? null,  d5MaxDown:  maxDownAt[5]  ?? null,
    d10MaxUp: maxUpAt[10] ?? null,  d10MaxDown: maxDownAt[10] ?? null,
    d20MaxUp: maxUpAt[20] ?? null,  d20MaxDown: maxDownAt[20] ?? null,
    hit3:  firstHitDay[3]  != null, hit3Day:  firstHitDay[3]  ?? null,
    hit5:  firstHitDay[5]  != null, hit5Day:  firstHitDay[5]  ?? null,
    hit7:  firstHitDay[7]  != null, hit7Day:  firstHitDay[7]  ?? null,
    hit10: firstHitDay[10] != null, hit10Day: firstHitDay[10] ?? null,
    hit15: firstHitDay[15] != null, hit15Day: firstHitDay[15] ?? null,
    hit20: firstHitDay[20] != null, hit20Day: firstHitDay[20] ?? null,
    hit30: firstHitDay[30] != null, hit30Day: firstHitDay[30] ?? null,
    hit50: firstHitDay[50] != null, hit50Day: firstHitDay[50] ?? null,
    breach3:  firstBreachDay[3]  != null, breach3Day:  firstBreachDay[3]  ?? null,
    breach5:  firstBreachDay[5]  != null, breach5Day:  firstBreachDay[5]  ?? null,
    breach7:  firstBreachDay[7]  != null, breach7Day:  firstBreachDay[7]  ?? null,
    breach10: firstBreachDay[10] != null, breach10Day: firstBreachDay[10] ?? null,
    firstHitDay, firstBreachDay,
    timeline,
  };
}

// ─── First-touch: +X% 먼저 vs -Y% 먼저 ─────────────────────────────────
function firstTouchOutcome(sim, upPct, downPct, maxDays = 5) {
  // 같은 날 둘 다 도달이면 low 먼저 (보수적)
  let upDay = null, downDay = null;
  for (const row of sim.timeline) {
    if (row.d > maxDays) break;
    const upHit   = sim.entryPrice > 0 && row.high != null && (row.high  - sim.entryPrice) / sim.entryPrice * 100 >= upPct;
    const downHit = sim.entryPrice > 0 && row.low  != null && (sim.entryPrice - row.low) / sim.entryPrice * 100 >= downPct;
    if (downHit && downDay == null) downDay = row.d;
    if (upHit   && upDay   == null) upDay   = row.d;
    if (upDay != null && downDay != null) break;
  }
  if (upDay == null && downDay == null) return 'NEITHER';
  if (upDay != null && (downDay == null || upDay < downDay)) return 'UP_FIRST';
  if (downDay != null && (upDay == null || downDay < upDay)) return 'DOWN_FIRST';
  return 'SAME_DAY_DOWN'; // 같은 날 둘 다면 down 우선
}

// ─── Stop/Take 시뮬레이션 ──────────────────────────────────────────────
// stopPct = -X% (양수로 표현, 손실), takePct = +Y%, exit = closeDN (D+N 종가 청산)
function stopTakeSim(sim, stopPct, takePct, exitDay /* null = closeD20 */) {
  // 매 거래일 통과하면서 stop/take 트리거 검사
  // 같은 날 둘 다 가능하면 보수적으로 stop 먼저
  const entry = sim.entryPrice;
  const exitMax = exitDay != null ? exitDay : 20;
  let returnPct = null;
  let trigger = null;
  let triggerDay = null;
  for (const row of sim.timeline) {
    if (row.d > exitMax) break;
    if (stopPct != null && row.low != null && (entry - row.low) / entry * 100 >= stopPct) {
      returnPct = -stopPct;
      trigger = 'STOP';
      triggerDay = row.d;
      break;
    }
    if (takePct != null && row.high != null && (row.high - entry) / entry * 100 >= takePct) {
      returnPct = takePct;
      trigger = 'TAKE';
      triggerDay = row.d;
      break;
    }
  }
  if (trigger == null) {
    // exit at close of exitDay
    const lastRow = sim.timeline.find(r => r.d === exitMax) || sim.timeline[sim.timeline.length - 1];
    returnPct = (lastRow.close - entry) / entry * 100;
    trigger = 'EXIT_AT_CLOSE';
    triggerDay = lastRow.d;
  }
  return { returnPct: Number(returnPct.toFixed(2)), trigger, triggerDay };
}

// ─── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (!isEnabled()) { console.error('❌ .env DB_* 미설정'); process.exit(1); }
  console.log('🔍 VVI2_PRE_A 분봉 감지 시점 진입가 백테스트 시작');
  console.log(`   days=${args.days}`);
  const t0 = Date.now();

  // 1. QVA 신호 로드
  const qvaRows = await query(`
    SELECT signal_date, board_name, signal_kind, stock_code, stock_name
    FROM board_signals
    WHERE (board_name = 'QVA_WATCHLIST'  AND signal_kind = 'QVA_NEW')
       OR (board_name = 'QVA2_WATCHLIST' AND signal_kind = 'QVA2_NEW')
    ORDER BY signal_date, stock_code
  `);
  console.log(`  QVA 신호 ${qvaRows.length}건 로드`);

  // 2. 차트 로드 + recent-N 윈도우 후보 추출
  const chartCache = new Map();
  function getChart(code) {
    if (chartCache.has(code)) return chartCache.get(code);
    const c = loadChart(code);
    chartCache.set(code, c);
    return c;
  }
  // recent N 거래일 cutoff
  const dateSet = new Set();
  for (const r of qvaRows.slice(0, 200)) {
    const c = getChart(r.stock_code);
    if (c && c.rows) for (const row of c.rows) if (row.date) dateSet.add(String(row.date));
  }
  const allDates = [...dateSet].sort();
  const recentCutoff = args.days > 0 && allDates.length > args.days ? allDates[allDates.length - args.days] : '00000000';

  // 후보 추출: QVA D+1~D+10 + 일봉 PRE_A_STRONG 한정 (이전 검증과 일치)
  const candidates = [];
  for (const qva of qvaRows) {
    const code = qva.stock_code;
    const qvaType = qva.board_name === 'QVA_WATCHLIST' ? 'QVA1' : 'QVA2';
    const qvaDate = String(qva.signal_date).slice(0,10);
    const qvaDateYMD = qvaDate.replace(/-/g, '');
    const chart = getChart(code);
    if (!chart || !chart.rows) continue;
    const rows = chart.rows;
    const qvaIdx = rows.findIndex(r => String(r.date) === qvaDateYMD);
    if (qvaIdx < 0) continue;
    const qvaRow = rows[qvaIdx];
    const qvaClose  = qvaRow.close;
    const qvaHigh   = qvaRow.high;
    const qvaVolume = qvaRow.volume || 0;
    const qvaValue  = qvaRow.valueApprox || (qvaRow.close * (qvaRow.volume || 0));
    if (!qvaClose || !qvaHigh || qvaVolume <= 0 || qvaValue <= 0) continue;

    for (let d = 1; d <= 10; d++) {
      const idx = qvaIdx + d;
      if (idx >= rows.length) break;
      const row = rows[idx];
      const ymd = String(row.date);
      if (ymd < recentCutoff) continue;

      const dayHigh = row.high, dayClose = row.close;
      const dayVolume = row.volume || 0;
      const dayValue  = row.valueApprox || (dayClose * dayVolume);
      const intradayBreakQvaHigh = dayHigh >= qvaHigh;
      const valueNearQva   = dayValue  >= qvaValue  * 0.7;
      const valueOverQva   = dayValue  >= qvaValue;
      const volumeNearQva  = dayVolume >= qvaVolume * 0.7;
      const volumeOverQva  = dayVolume >= qvaVolume;
      const closeHoldQvaHigh = dayClose >= qvaHigh;
      const closeNearQvaHigh = dayClose >= qvaHigh * 0.97;
      const dayPreGroup = classifyDailyPre({
        intradayBreakQvaHigh, valueNearQva, valueOverQva, volumeNearQva, volumeOverQva,
        closeHoldQvaHigh, closeNearQvaHigh,
      });
      // 일봉 PRE_A_STRONG만 — entry 검증은 분봉 strict 통과 종목 중에서만 의미
      if (dayPreGroup !== 'PRE_A_STRONG') continue;

      candidates.push({
        code, name: qva.stock_name, qvaType, qvaDate, qvaIdx,
        qvaClose, qvaHigh, qvaVolume, qvaValue,
        dayDate: ymd, dayIdx: idx, daysFromQva: d,
        dayClose, dayHigh, dayLow: row.low,
      });
    }
  }

  // dedup (code, dayDate)
  const seen = new Set();
  const uniqCands = [];
  for (const c of candidates) {
    const k = c.code + '|' + c.dayDate;
    if (seen.has(k)) continue;
    seen.add(k);
    uniqCands.push(c);
  }
  console.log(`  후보 PRE_A_STRONG (uniq): ${uniqCands.length}건`);

  if (args.dryRun) { await closePool(); return; }

  // 3. 각 후보에 대해 분봉 cache 로드 + snapshot 계산 + strict 분류 + entry 시뮬
  let missingMinute = 0;
  const entries = []; // { ..., snapshotTime, mode (strict/base), entry simulation, isActualVvi2 }

  for (const c of uniqCands) {
    const minuteCache = loadMinuteCache(c.code, c.dayDate);
    if (!minuteCache || !Array.isArray(minuteCache.raw) || minuteCache.raw.length === 0) { missingMinute++; continue; }
    const { result: snaps, bars } = buildSnapshotsAt(minuteCache.raw, c.qvaHigh, c.qvaVolume, c.qvaValue);

    // 실제 VVI2 확정
    const chart = getChart(c.code);
    const rows = chart.rows;
    const vvi2Res = findVvi2AfterQva2(rows, c.qvaIdx, FOLLOW_DAYS, { qva2Type: 'absorption' });
    const isActualVvi2 = vvi2Res.vvi2Idx > 0;
    const sameDayVvi2 = isActualVvi2 && rows[vvi2Res.vvi2Idx].date === c.dayDate;

    // D+1~D+20 일봉
    const dailyRowsAfter = [];
    for (let k = 1; k <= FOLLOW_DAYS; k++) {
      const j = c.dayIdx + k;
      if (j >= rows.length) break;
      dailyRowsAfter.push(rows[j]);
    }

    // 각 시점/모드별 entry 시뮬
    for (const t of ['09:10', '09:30', '10:00']) {
      const snap = snaps[t];
      if (!snap) continue;
      const cls = classifyIntradayPreA(snap);
      if (!cls.strict && !cls.base) continue;
      const entryPrice_snapshot   = snap.lastPrice;
      const entryPrice_nextMinute = snap.nextBarClose || snap.lastPrice;
      const entryPrice_vwap       = snap.vwap || snap.lastPrice;
      const barsAfter = bars.slice(snap.lastBarIdx + 1);

      // 기본은 entryPrice_snapshot
      const sim = simulateEntry(entryPrice_snapshot, barsAfter, dailyRowsAfter);
      // 보조: nextMinute, vwap
      const simNext = simulateEntry(entryPrice_nextMinute, barsAfter.slice(1), dailyRowsAfter);
      // BIG_50 from QVA
      let qvaMaxHigh = c.qvaHigh;
      for (let k = c.qvaIdx + 1; k < Math.min(rows.length, c.qvaIdx + 1 + FOLLOW_DAYS); k++) {
        if (Number.isFinite(rows[k].high)) qvaMaxHigh = Math.max(qvaMaxHigh, rows[k].high);
      }
      const qvaMaxUp = pct(qvaMaxHigh, c.qvaClose);
      const isBig50  = qvaMaxUp != null && qvaMaxUp >= 50;
      const isSuper  = qvaMaxUp != null && qvaMaxUp >= 100;

      // strict가 true면 strict 모드로 등록, base만 true면 base 모드로 (둘 다 true는 strict 우선)
      const modes = [];
      if (cls.strict) modes.push('strict');
      else if (cls.base) modes.push('base');
      for (const mode of modes) {
        entries.push({
          code: c.code, name: c.name, qvaType: c.qvaType, qvaDate: c.qvaDate,
          dayDate: c.dayDate, daysFromQva: c.daysFromQva,
          qvaHigh: c.qvaHigh, qvaClose: c.qvaClose,
          snapshotTime: t, mode,
          entryPrice_snapshot, entryPrice_nextMinute, entryPrice_vwap,
          sim, simNext,
          isActualVvi2, sameDayVvi2,
          qvaMaxUp, isBig50, isSuper,
          dayClose: c.dayClose,
        });
      }
    }
  }
  console.log(`  분봉 strict/base 통과 entry: ${entries.length}건 / 분봉 미존재 skip: ${missingMinute}`);

  // 4. 그룹 집계
  function makeGroupStat(label, items) {
    const n = items.length;
    if (n === 0) return { group: label, n: 0, sampleQuality: sampleQualityOf(0) };
    const sims = items.map(x => x.sim);
    return {
      group: label, n, sampleQuality: sampleQualityOf(n),
      qva1Count: items.filter(x => x.qvaType === 'QVA1').length,
      qva2Count: items.filter(x => x.qvaType === 'QVA2').length,
      avgEntryToDayHigh:  Number((avg(sims.map(s => s.entryToDayHighPct))  ?? 0).toFixed(2)),
      avgEntryToDayClose: Number((avg(sims.map(s => s.entryToDayClosePct)) ?? 0).toFixed(2)),
      avgEntryToDayLow:   Number((avg(sims.map(s => s.entryToDayLowPct))   ?? 0).toFixed(2)),
      closeAboveEntryRate: rate(sims.filter(s => s.closeAboveEntry).length, n),
      avgD1Max:  Number((avg(sims.map(s => s.d1MaxUp))  ?? 0).toFixed(2)),
      avgD3Max:  Number((avg(sims.map(s => s.d3MaxUp))  ?? 0).toFixed(2)),
      avgD5Max:  Number((avg(sims.map(s => s.d5MaxUp))  ?? 0).toFixed(2)),
      avgD10Max: Number((avg(sims.map(s => s.d10MaxUp)) ?? 0).toFixed(2)),
      avgD20Max: Number((avg(sims.map(s => s.d20MaxUp)) ?? 0).toFixed(2)),
      hit3Rate:  rate(sims.filter(s => s.hit3).length, n),
      hit5Rate:  rate(sims.filter(s => s.hit5).length, n),
      hit10Rate: rate(sims.filter(s => s.hit10).length, n),
      hit15Rate: rate(sims.filter(s => s.hit15).length, n),
      hit20Rate: rate(sims.filter(s => s.hit20).length, n),
      hit30Rate: rate(sims.filter(s => s.hit30).length, n),
      hit50Rate: rate(sims.filter(s => s.hit50).length, n),
      breach3Rate:  rate(sims.filter(s => s.breach3).length, n),
      breach5Rate:  rate(sims.filter(s => s.breach5).length, n),
      breach7Rate:  rate(sims.filter(s => s.breach7).length, n),
      breach10Rate: rate(sims.filter(s => s.breach10).length, n),
      isActualVvi2Rate: rate(items.filter(x => x.isActualVvi2).length, n),
      big50Rate:      rate(items.filter(x => x.isBig50).length, n),
      superFireRate:  rate(items.filter(x => x.isSuper).length, n),
    };
  }

  const groupKeys = [
    { label: 'STRICT_0910', filter: e => e.snapshotTime === '09:10' && e.mode === 'strict' },
    { label: 'STRICT_0930', filter: e => e.snapshotTime === '09:30' && e.mode === 'strict' },
    { label: 'STRICT_1000', filter: e => e.snapshotTime === '10:00' && e.mode === 'strict' },
    { label: 'BASE_0930',   filter: e => e.snapshotTime === '09:30' && e.mode === 'base' },
    { label: 'BASE_1000',   filter: e => e.snapshotTime === '10:00' && e.mode === 'base' },
  ];
  const timeGroups = groupKeys.map(g => makeGroupStat(g.label, entries.filter(g.filter)));

  // QVA 유형별
  const qvaTypeGroups = [
    makeGroupStat('QVA1_STRICT_0930', entries.filter(e => e.qvaType === 'QVA1' && e.snapshotTime === '09:30' && e.mode === 'strict')),
    makeGroupStat('QVA2_STRICT_0930', entries.filter(e => e.qvaType === 'QVA2' && e.snapshotTime === '09:30' && e.mode === 'strict')),
    makeGroupStat('QVA1_STRICT_1000', entries.filter(e => e.qvaType === 'QVA1' && e.snapshotTime === '10:00' && e.mode === 'strict')),
    makeGroupStat('QVA2_STRICT_1000', entries.filter(e => e.qvaType === 'QVA2' && e.snapshotTime === '10:00' && e.mode === 'strict')),
  ];

  // VVI2 확정 여부별
  const vvi2Groups = [
    makeGroupStat('STRICT_AND_ACTUAL_VVI2', entries.filter(e => e.mode === 'strict' && e.snapshotTime !== '09:10' && e.isActualVvi2)),
    makeGroupStat('STRICT_BUT_NO_VVI2',     entries.filter(e => e.mode === 'strict' && e.snapshotTime !== '09:10' && !e.isActualVvi2)),
    makeGroupStat('STRICT_AND_BIG50',       entries.filter(e => e.mode === 'strict' && e.snapshotTime !== '09:10' && e.isBig50)),
    makeGroupStat('STRICT_NOT_BIG50',       entries.filter(e => e.mode === 'strict' && e.snapshotTime !== '09:10' && !e.isBig50)),
  ];

  // 5. First-touch 분석 (시간대별)
  function makeFirstTouchStat(label, items, upPct, downPct, maxDays = 5) {
    const n = items.length;
    if (n === 0) return { group: label, n: 0 };
    const outcomes = items.map(x => firstTouchOutcome(x.sim, upPct, downPct, maxDays));
    const up = outcomes.filter(o => o === 'UP_FIRST').length;
    const down = outcomes.filter(o => o === 'DOWN_FIRST' || o === 'SAME_DAY_DOWN').length;
    const none = outcomes.filter(o => o === 'NEITHER').length;
    return {
      group: label, n,
      upFirstRate:   rate(up, n),
      downFirstRate: rate(down, n),
      neitherRate:   rate(none, n),
      upDownRatio: down > 0 ? Number((up / down).toFixed(2)) : (up > 0 ? Infinity : 0),
    };
  }
  const firstTouchByGroup = {};
  for (const grp of ['STRICT_0930', 'STRICT_1000']) {
    const items = entries.filter(groupKeys.find(g => g.label === grp).filter);
    firstTouchByGroup[grp] = {
      up3_down3:    makeFirstTouchStat('+3 vs -3', items, 3, 3),
      up5_down5:    makeFirstTouchStat('+5 vs -5', items, 5, 5),
      up10_down5:   makeFirstTouchStat('+10 vs -5', items, 10, 5),
      up10_down7:   makeFirstTouchStat('+10 vs -7', items, 10, 7),
      up20_down10:  makeFirstTouchStat('+20 vs -10', items, 20, 10),
    };
  }

  // 6. Stop/Take 시뮬레이션
  function makeStopTakeStat(label, items, stop, take, exitDay) {
    const n = items.length;
    if (n === 0) return { group: label, n: 0 };
    const results = items.map(x => stopTakeSim(x.sim, stop, take, exitDay));
    const wins = results.filter(r => r.returnPct > 0).length;
    const stopHits = results.filter(r => r.trigger === 'STOP').length;
    const takeHits = results.filter(r => r.trigger === 'TAKE').length;
    const exitHits = results.filter(r => r.trigger === 'EXIT_AT_CLOSE').length;
    const returns = results.map(r => r.returnPct);
    return {
      group: label, n,
      stop, take, exitDay,
      winRate: rate(wins, n),
      stopHitRate: rate(stopHits, n),
      takeHitRate: rate(takeHits, n),
      exitHitRate: rate(exitHits, n),
      avgReturn: Number((avg(returns) ?? 0).toFixed(2)),
      medianReturn: Number((median(returns) ?? 0).toFixed(2)),
      maxGainAvg: Number((avg(items.map(x => x.sim.maxUpFromEntry)) ?? 0).toFixed(2)),
      riskReward: stop > 0 ? Number((take / stop).toFixed(2)) : null,
      // expectancy = winRate × avgWin - lossRate × avgLoss
      expectancy: (() => {
        const winRet = avg(returns.filter(r => r > 0));
        const lossRet = avg(returns.filter(r => r <= 0));
        const winRateF = wins / n;
        const lossRateF = (n - wins) / n;
        return Number((winRateF * (winRet || 0) + lossRateF * (lossRet || 0)).toFixed(3));
      })(),
    };
  }
  const stopTakeCombos = [
    { stop: 5,  take: 10, exit: null },
    { stop: 5,  take: 15, exit: null },
    { stop: 7,  take: 15, exit: null },
    { stop: 7,  take: 20, exit: null },
    { stop: 10, take: 20, exit: null },
    { stop: 10, take: 30, exit: null },
    { stop: null, take: null, exit: 1 },   // noStop / closeD1
    { stop: null, take: null, exit: 3 },   // noStop / closeD3
    { stop: null, take: null, exit: 5 },   // noStop / closeD5
  ];
  const stopTakeBySnap = {};
  for (const grp of ['STRICT_0930', 'STRICT_1000', 'QVA2_STRICT_0930', 'QVA2_STRICT_1000']) {
    let items;
    if (grp.startsWith('QVA2_')) {
      items = entries.filter(e => e.qvaType === 'QVA2' && e.snapshotTime === (grp.includes('1000') ? '10:00' : '09:30') && e.mode === 'strict');
    } else {
      items = entries.filter(groupKeys.find(g => g.label === grp).filter);
    }
    stopTakeBySnap[grp] = stopTakeCombos.map(c => makeStopTakeStat(
      (c.stop != null ? `stop${c.stop}/take${c.take}` : `noStop/closeD${c.exit}`),
      items, c.stop, c.take, c.exit
    ));
  }

  // 7. 대표 사례
  function caseRow(e, interpret) {
    return {
      code: e.code, name: e.name, qvaType: e.qvaType, qvaDate: e.qvaDate, dayDate: e.dayDate,
      snapshotTime: e.snapshotTime, mode: e.mode,
      entryPrice: e.entryPrice_snapshot,
      qvaHigh: e.qvaHigh,
      dayClose: e.dayClose,
      entryToDayHigh: e.sim.entryToDayHighPct,
      entryToDayClose: e.sim.entryToDayClosePct,
      d5MaxUp: e.sim.d5MaxUp, d20MaxUp: e.sim.d20MaxUp,
      d5MaxDown: e.sim.d5MaxDown,
      maxUpFromEntry: e.sim.maxUpFromEntry,
      maxDownFromEntry: e.sim.maxDownFromEntry,
      hit10Day: e.sim.hit10Day, hit20Day: e.sim.hit20Day, hit50Day: e.sim.hit50Day,
      breach5Day: e.sim.breach5Day, breach10Day: e.sim.breach10Day,
      isActualVvi2: e.isActualVvi2, isBig50: e.isBig50, isSuper: e.isSuper,
      interpret,
    };
  }
  const winners = entries.filter(e => e.mode === 'strict' && e.snapshotTime === '10:00' && (e.sim.hit20 || e.sim.hit30))
    .slice().sort((a,b) => (b.sim.maxUpFromEntry || 0) - (a.sim.maxUpFromEntry || 0))
    .slice(0, 15).map(e => caseRow(e, `10:00 strict 진입 → D+${e.sim.hit20Day || e.sim.hit30Day}에 ${fmtPct(e.sim.maxUpFromEntry, 1)} 도달` + (e.isSuper ? ' (SUPER_FIRE)' : '')));
  const losers = entries.filter(e => e.mode === 'strict' && (e.sim.breach5 || e.sim.breach10))
    .slice().sort((a,b) => (a.sim.maxDownFromEntry || 0) - (b.sim.maxDownFromEntry || 0))
    .slice(0, 15).map(e => caseRow(e, `${e.snapshotTime} strict 진입 → D+${e.sim.breach5Day || e.sim.breach10Day}에 ${fmtPct(e.sim.maxDownFromEntry, 1)} 이탈`));

  // 8. 요약
  const g0930 = timeGroups.find(g => g.group === 'STRICT_0930');
  const g1000 = timeGroups.find(g => g.group === 'STRICT_1000');
  const qva2_1000 = qvaTypeGroups.find(g => g.group === 'QVA2_STRICT_1000');
  const ft1000 = firstTouchByGroup.STRICT_1000;
  // 가장 좋은 stop/take Top 5 (10:00 strict 기준 expectancy)
  const bestStopTake = stopTakeBySnap.STRICT_1000.slice()
    .filter(s => s.n > 0)
    .sort((a, b) => b.expectancy - a.expectancy)
    .slice(0, 5);

  const summary = {
    candidates: uniqCands.length,
    analyzed: entries.length,
    missingMinute,
    days: args.days,
    strict_0930: g0930,
    strict_1000: g1000,
    qva2_strict_1000: qva2_1000,
    bestStopTake_1000: bestStopTake,
    upDown_10_5_1000: ft1000?.up10_down5 || null,
    upDown_20_10_1000: ft1000?.up20_down10 || null,
  };

  const result = {
    meta: {
      title: 'VVI2_PRE_A 분봉 감지 시점 진입가 백테스트',
      generatedAt: new Date().toISOString(),
      followDays: FOLLOW_DAYS,
      args,
    },
    summary,
    timeGroups,
    qvaTypeGroups,
    vvi2Groups,
    firstTouchByGroup,
    stopTakeBySnap,
    cases: { winners, losers },
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  console.log(`✅ JSON: ${OUT_JSON}`);
  fs.writeFileSync(OUT_HTML, renderHtml(result));
  console.log(`✅ HTML: ${OUT_HTML}`);

  // 콘솔 출력
  console.log();
  console.log('━'.repeat(80));
  console.log('=== VVI2_PRE_A 진입가 백테스트 요약 ===');
  function dump(label, g) {
    if (!g || g.n === 0) { console.log(`  ${label}: n=0`); return; }
    console.log(`  ${label}: n=${g.n} (${g.sampleQuality}) / 평균 당일고가 ${fmtPct(g.avgEntryToDayHigh)} / 평균 종가 ${fmtPct(g.avgEntryToDayClose)} / hit5 ${g.hit5Rate}% / hit10 ${g.hit10Rate}% / hit20 ${g.hit20Rate}% / breach5 ${g.breach5Rate}% / breach10 ${g.breach10Rate}%`);
  }
  dump('09:30 strict', g0930);
  dump('10:00 strict', g1000);
  dump('QVA2 10:00 strict', qva2_1000);
  console.log();
  if (ft1000?.up10_down5) {
    const f = ft1000.up10_down5;
    console.log(`+10 먼저 vs -5 먼저 (10:00 strict, D+5): ${f.upFirstRate}% vs ${f.downFirstRate}% (ratio ${f.upDownRatio})`);
  }
  if (ft1000?.up20_down10) {
    const f = ft1000.up20_down10;
    console.log(`+20 먼저 vs -10 먼저 (10:00 strict, D+5): ${f.upFirstRate}% vs ${f.downFirstRate}% (ratio ${f.upDownRatio})`);
  }
  console.log();
  console.log('Stop/Take Top 5 (10:00 strict, expectancy 기준):');
  for (let i = 0; i < bestStopTake.length; i++) {
    const s = bestStopTake[i];
    console.log(`  ${i+1}. ${s.group} — win ${s.winRate}% / avg ${fmtPct(s.avgReturn)} / median ${fmtPct(s.medianReturn)} / stopHit ${s.stopHitRate}% / takeHit ${s.takeHitRate}% / expectancy ${s.expectancy >= 0 ? '+' : ''}${s.expectancy}`);
  }
  console.log();
  // 운영화 1줄 결론
  const exp = bestStopTake[0]?.expectancy ?? 0;
  const hit10ok = (g1000?.hit10Rate ?? 0) >= 50;
  const breach5ok = (g1000?.breach5Rate ?? 100) <= 35;
  const ratio = ft1000?.up10_down5?.upDownRatio ?? 0;
  const ratioOk = ratio !== Infinity && ratio >= 1.5;
  const verdict = (exp > 0 && hit10ok && breach5ok && ratioOk)
    ? '운영화 검토 가능 — expectancy 양수 + hit10 50%↑ + breach5 35%↓ + 손익비 1.5x↑'
    : (exp > 0 ? '진입 전략 일부 통과 — 추가 튜닝 필요'
                : '신호는 좋지만 진입 전략 미완성 (expectancy 음수)');
  console.log('▶ 운영화 결론: ' + verdict);
  console.log();
  console.log(`⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await closePool();
}

// ─── HTML 렌더 ───────────────────────────────────────────────────────────
function renderHtml(result) {
  const { meta, summary, timeGroups, qvaTypeGroups, vvi2Groups, firstTouchByGroup, stopTakeBySnap, cases } = result;

  function groupTable(rows) {
    const head = '<table class="t"><thead><tr>' +
      '<th>그룹</th><th>n</th><th>표본</th><th>QVA1/QVA2</th>' +
      '<th>당일 고가</th><th>당일 종가</th><th>당일 저가</th><th>종가↑entry</th>' +
      '<th>D+1</th><th>D+3</th><th>D+5</th><th>D+10</th><th>D+20</th>' +
      '<th>hit5</th><th>hit10</th><th>hit20</th><th>hit30</th><th>hit50</th>' +
      '<th>-3%</th><th>-5%</th><th>-7%</th><th>-10%</th>' +
      '<th>VVI2</th><th>BIG_50</th><th>SUPER</th>' +
      '</tr></thead><tbody>';
    const body = rows.map(g => '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td>${g.n > 0 ? sampleQualityPill(g.sampleQuality) : '—'}</td>` +
      `<td class="num">${g.qva1Count||0}/${g.qva2Count||0}</td>` +
      `<td class="num">${fmtPct(g.avgEntryToDayHigh)}</td>` +
      `<td class="num">${fmtPct(g.avgEntryToDayClose)}</td>` +
      `<td class="num neg">${fmtPct(g.avgEntryToDayLow)}</td>` +
      `<td class="num">${g.closeAboveEntryRate||0}%</td>` +
      `<td class="num">${fmtPct(g.avgD1Max)}</td>` +
      `<td class="num">${fmtPct(g.avgD3Max)}</td>` +
      `<td class="num">${fmtPct(g.avgD5Max)}</td>` +
      `<td class="num">${fmtPct(g.avgD10Max)}</td>` +
      `<td class="num">${fmtPct(g.avgD20Max)}</td>` +
      `<td class="num">${g.hit5Rate||0}%</td>` +
      `<td class="num pos">${g.hit10Rate||0}%</td>` +
      `<td class="num pos">${g.hit20Rate||0}%</td>` +
      `<td class="num">${g.hit30Rate||0}%</td>` +
      `<td class="num">${g.hit50Rate||0}%</td>` +
      `<td class="num neg">${g.breach3Rate||0}%</td>` +
      `<td class="num neg">${g.breach5Rate||0}%</td>` +
      `<td class="num neg">${g.breach7Rate||0}%</td>` +
      `<td class="num neg">${g.breach10Rate||0}%</td>` +
      `<td class="num">${g.isActualVvi2Rate||0}%</td>` +
      `<td class="num">${g.big50Rate||0}%</td>` +
      `<td class="num">${g.superFireRate||0}%</td>` +
      '</tr>').join('');
    return head + body + '</tbody></table>';
  }

  function firstTouchCard(label, items) {
    if (!items) return '<div class="empty">' + esc(label) + ' 데이터 없음</div>';
    function row(name, f) {
      if (!f || f.n === 0) return '';
      return '<tr>' +
        `<td><b>${esc(name)}</b></td>` +
        `<td class="num">${f.n}</td>` +
        `<td class="num pos">${f.upFirstRate}%</td>` +
        `<td class="num neg">${f.downFirstRate}%</td>` +
        `<td class="num">${f.neitherRate}%</td>` +
        `<td class="num"><b>${f.upDownRatio === Infinity ? '∞' : f.upDownRatio}</b></td>` +
        '</tr>';
    }
    return `<h3>${esc(label)}</h3>` +
      '<table class="t"><thead><tr><th>조합</th><th>n</th><th>UP 먼저</th><th>DOWN 먼저</th><th>둘 다 X</th><th>UP/DOWN ratio</th></tr></thead><tbody>' +
      row('+3% 먼저 vs -3% 먼저', items.up3_down3) +
      row('+5% 먼저 vs -5% 먼저', items.up5_down5) +
      row('+10% 먼저 vs -5% 먼저', items.up10_down5) +
      row('+10% 먼저 vs -7% 먼저', items.up10_down7) +
      row('+20% 먼저 vs -10% 먼저', items.up20_down10) +
      '</tbody></table>';
  }

  function stopTakeTable(label, rows) {
    return `<h3>${esc(label)}</h3>` +
      '<table class="t"><thead><tr>' +
      '<th>조합</th><th>n</th><th>winRate</th><th>avgReturn</th><th>median</th><th>maxGain 평균</th>' +
      '<th>stopHit</th><th>takeHit</th><th>exit</th><th>riskReward</th><th>expectancy</th>' +
      '</tr></thead><tbody>' +
      rows.map(s => {
        if (s.n === 0) return `<tr><td><b>${esc(s.group)}</b></td><td class="num">0</td><td colspan="9">—</td></tr>`;
        const expCls = s.expectancy > 0 ? 'pos' : 'neg';
        return '<tr>' +
          `<td><b>${esc(s.group)}</b></td>` +
          `<td class="num">${s.n}</td>` +
          `<td class="num">${s.winRate}%</td>` +
          `<td class="num ${s.avgReturn >= 0 ? 'pos' : 'neg'}">${fmtPct(s.avgReturn)}</td>` +
          `<td class="num">${fmtPct(s.medianReturn)}</td>` +
          `<td class="num">${fmtPct(s.maxGainAvg)}</td>` +
          `<td class="num neg">${s.stopHitRate}%</td>` +
          `<td class="num pos">${s.takeHitRate}%</td>` +
          `<td class="num">${s.exitHitRate}%</td>` +
          `<td class="num">${s.riskReward != null ? s.riskReward + 'x' : '—'}</td>` +
          `<td class="num ${expCls}"><b>${s.expectancy >= 0 ? '+' : ''}${s.expectancy}</b></td>` +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  function caseTable(list, emptyMsg) {
    if (!list || list.length === 0) return `<div class="empty">${esc(emptyMsg)}</div>`;
    return '<table class="t"><thead><tr>' +
      '<th>종목</th><th>QVA</th><th>QVA일</th><th>진입일</th><th>시간/모드</th>' +
      '<th>진입가</th><th>QVA고가</th><th>당일종가</th>' +
      '<th>당일↑ from entry</th><th>당일종가 from entry</th>' +
      '<th>D+5 max↑</th><th>D+20 max↑</th><th>D+5 max↓</th>' +
      '<th>hit10일</th><th>hit20일</th><th>hit50일</th><th>breach5일</th>' +
      '<th>VVI2</th><th>BIG_50</th><th>해석</th>' +
      '</tr></thead><tbody>' +
      list.map(c => '<tr>' +
        `<td><b>${esc(c.name)}</b><div class="code">${esc(c.code)}</div></td>` +
        `<td><span class="pill ${c.qvaType === 'QVA1' ? 'p-q1' : 'p-q2'}">${c.qvaType}</span></td>` +
        `<td>${esc(c.qvaDate)}</td>` +
        `<td>${esc(ymdDash(c.dayDate))}</td>` +
        `<td>${esc(c.snapshotTime)} ${esc(c.mode)}</td>` +
        `<td class="num">${fmtInt(c.entryPrice)}</td>` +
        `<td class="num">${fmtInt(c.qvaHigh)}</td>` +
        `<td class="num">${fmtInt(c.dayClose)}</td>` +
        `<td class="num pos">${fmtPct(c.entryToDayHigh)}</td>` +
        `<td class="num">${fmtPct(c.entryToDayClose)}</td>` +
        `<td class="num pos">${fmtPct(c.d5MaxUp)}</td>` +
        `<td class="num pos">${fmtPct(c.d20MaxUp)}</td>` +
        `<td class="num neg">${fmtPct(c.d5MaxDown)}</td>` +
        `<td class="num">${c.hit10Day ?? '—'}</td>` +
        `<td class="num">${c.hit20Day ?? '—'}</td>` +
        `<td class="num">${c.hit50Day ?? '—'}</td>` +
        `<td class="num">${c.breach5Day ?? '—'}</td>` +
        `<td>${c.isActualVvi2 ? '<span class="pill p-good">확정</span>' : '<span class="pill p-neu">—</span>'}</td>` +
        `<td>${c.isBig50 ? '<span class="pill p-good">BIG_50</span>' : '—'}${c.isSuper ? ' <span class="pill p-q2">SUPER</span>' : ''}</td>` +
        `<td style="font-size:11px;color:#cbd5e1;max-width:280px;">${esc(c.interpret || '')}</td>` +
        '</tr>').join('') + '</tbody></table>';
  }

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>${esc(meta.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif; background: #0f172a; color: #cbd5e1; margin: 0; padding: 18px 22px 60px; max-width: 1900px; }
  h1 { color: #f1f5f9; font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: #94a3b8; font-size: 12px; margin-bottom: 16px; }
  h2 { color: #5eead4; font-size: 17px; margin: 24px 0 10px; border-left: 4px solid #14b8a6; padding-left: 10px; }
  h3 { color: #c4b5fd; font-size: 14px; margin: 14px 0 8px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 18px; margin-bottom: 14px; }
  .card-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
  .stat { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; }
  .stat .lbl { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
  .stat .val { color: #f1f5f9; font-size: 22px; font-weight: 700; margin-top: 4px; line-height: 1.1; }
  .stat .sub { color: #94a3b8; font-size: 11px; margin-top: 2px; }
  table.t { width: 100%; border-collapse: collapse; background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; font-size: 12px; margin-bottom: 12px; }
  table.t th, table.t td { padding: 7px 9px; text-align: left; border-bottom: 1px solid #334155; color: #cbd5e1; vertical-align: top; }
  table.t th { background: #0f172a; color: #5eead4; font-weight: 600; font-size: 11px; }
  table.t td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.t td.pos { color: #86efac; font-weight: 600; }
  table.t td.neg { color: #fca5a5; }
  .code { color: #64748b; font-size: 10.5px; font-family: ui-monospace, monospace; }
  .pill { display: inline-block; padding: 1.5px 7px; border-radius: 999px; font-size: .7rem; font-weight: 600; margin: 0 2px; }
  .p-q1   { background: #052e16; color: #86efac; border: 1px solid #166534; }
  .p-q2   { background: #1e1b4b; color: #c4b5fd; border: 1px solid #4338ca; }
  .p-good { background: #064e3b; color: #a7f3d0; border: 1px solid #10b981; }
  .p-neu  { background: #0f172a; color: #64748b; border: 1px solid #334155; }
  .p-warn { background: #422006; color: #fcd34d; border: 1px solid #b45309; }
  .empty { background: rgba(0,0,0,0.3); border: 1px dashed #334155; padding: 14px; text-align: center; border-radius: 6px; color: #94a3b8; }
  .hint { color: #94a3b8; font-size: 11.5px; line-height: 1.6; margin-bottom: 8px; }
</style></head>
<body>
<h1>${esc(meta.title)}</h1>
<div class="subtitle">생성: ${esc(meta.generatedAt)} · 분봉 strict/base 감지 시점 진입가(entryPrice_snapshot) 기준 D+1~D+${meta.followDays} 시뮬레이션</div>

<h2>1. 요약</h2>
<div class="card">
  <div class="card-row">
    <div class="stat"><div class="lbl">후보 (uniq code-date)</div><div class="val">${summary.candidates}</div></div>
    <div class="stat"><div class="lbl">분석 entry</div><div class="val pos">${summary.analyzed}</div><div class="sub">분봉 미존재 skip ${summary.missingMinute}</div></div>
    <div class="stat"><div class="lbl">최근 N 거래일</div><div class="val">${summary.days}</div></div>
    ${summary.strict_1000 ? `<div class="stat"><div class="lbl">10:00 strict hit10</div><div class="val pos">${summary.strict_1000.hit10Rate}%</div><div class="sub">n=${summary.strict_1000.n}</div></div>` : ''}
    ${summary.strict_1000 ? `<div class="stat"><div class="lbl">10:00 strict breach5</div><div class="val neg">${summary.strict_1000.breach5Rate}%</div></div>` : ''}
    ${summary.qva2_strict_1000 ? `<div class="stat"><div class="lbl">QVA2 10:00 hit20</div><div class="val pos">${summary.qva2_strict_1000.hit20Rate}%</div><div class="sub">n=${summary.qva2_strict_1000.n}</div></div>` : ''}
    ${summary.upDown_10_5_1000 ? `<div class="stat"><div class="lbl">+10 먼저 vs -5 먼저 (10:00)</div><div class="val">${summary.upDown_10_5_1000.upFirstRate}% / ${summary.upDown_10_5_1000.downFirstRate}%</div><div class="sub">ratio ${summary.upDown_10_5_1000.upDownRatio}</div></div>` : ''}
  </div>
</div>

<h2>2. 시간대별 진입 성과</h2>
<div class="hint">기본 entry = entryPrice_snapshot (감지 시점 lastPrice). 각 시간대 strict/base 통과 후보의 D+0 진입 후 성과.</div>
${groupTable(timeGroups)}

<h2>3. QVA1/QVA2별 진입 성과</h2>
<div class="hint">QVA2 strict는 BIG_50/SUPER 비율이 QVA1보다 강한지 — 진입가 기준에서도 같은 경향인지.</div>
${groupTable(qvaTypeGroups)}

<h2>4. VVI2 확정 여부별 진입 성과</h2>
<div class="hint">장중 strict 진입 후 종가 VVI2 확정까지 가야 더 좋은지 vs strict만으로도 충분한지.</div>
${groupTable(vvi2Groups)}

<h2>5. 먼저 도달 분석 (D+5 윈도우)</h2>
<div class="hint">진입 후 D+5까지 +X% 익절 vs -Y% 손절 어느 쪽이 먼저 닿는지. 같은 날 둘 다 닿으면 보수적으로 DOWN 우선.</div>
${firstTouchCard('10:00 strict', firstTouchByGroup.STRICT_1000)}
${firstTouchCard('09:30 strict', firstTouchByGroup.STRICT_0930)}

<h2>6. Stop/Take 시뮬레이션</h2>
<div class="hint">expectancy = winRate × avgWin + lossRate × avgLoss. 양수면 long-run 양의 기대값.</div>
${stopTakeTable('10:00 strict — 전체', stopTakeBySnap.STRICT_1000)}
${stopTakeTable('09:30 strict — 전체', stopTakeBySnap.STRICT_0930)}
${stopTakeTable('QVA2 10:00 strict', stopTakeBySnap.QVA2_STRICT_1000)}
${stopTakeTable('QVA2 09:30 strict', stopTakeBySnap.QVA2_STRICT_0930)}

<h2>7. 대표 성공 사례 — 10:00 strict 진입 후 D+20 안 hit20/hit30 도달</h2>
${caseTable(cases.winners, '성공 사례 없음')}

<h2>8. 대표 실패 사례 — strict 진입 후 -5%/-10% 이탈</h2>
${caseTable(cases.losers, '실패 사례 없음')}

<footer style="margin-top: 24px; padding: 12px; background: #1e293b; border-radius: 6px; color: #64748b; font-size: 11.5px; text-align: center;">
  분봉 감지 시점 진입 백테스트 — 실시간 알림/운영 보드/cron 추가 X. 운영화 판단용 검증.
</footer>
</body></html>`;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
