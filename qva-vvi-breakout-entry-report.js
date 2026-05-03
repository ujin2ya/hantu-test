/**
 * QVA → VVI → 다음날 고가 돌파 진입 검증 보고서
 *
 * 흐름:
 *   QVA = 감시 시작 (관심종목 후보 압축)
 *   VVI = 거래대금 초동 확인
 *   다음날 VVI 고가 돌파 = 진입 후보 검토
 *   손절 기준 = 실패 돌파 제거
 *
 * 본 보고서는 매수 추천이 아니라, "QVA → VVI → 다음날 고가 돌파 → 손절" 조합이
 * 실전 후보 필터로 의미가 있는지 검증한다.
 *
 * 진입가 정의:
 *   entryPrice    = vviHigh
 *   entryPrice1Pct = vviHigh × 1.01
 *
 * 진입 발생 조건 (다음 거래일 장중 고가 기준):
 *   triggered     = nextHigh >= entryPrice
 *   triggered1Pct = nextHigh >= entryPrice × 1.01
 *
 * 진입일 = VVI 다음 거래일 (entryIdx = vviIdx + 1)
 *
 * 진입 이후 성과/MFE/MAE는 entryIdx + 1 ~ entryIdx + N 거래일 윈도우에서 측정.
 * (진입 당일은 윈도우에서 제외 — 진입 시점 vs 장중 변동 순서 모호성 회피)
 *
 * 손절 시나리오:
 *   A: stopPrice = vviLow            (VVI 당일 저가 이탈)
 *   B: stopPrice = vviClose          (VVI 당일 종가 이탈)
 *   C: stopPrice = entryPrice × 0.95 (진입가 -5%)
 *   D: stopPrice = entryPrice × 0.93 (진입가 -7%)
 *   E: breakoutFail = nextClose < vviHigh (다음날 종가가 VVI 고가 아래 마감 → 돌파 실패)
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const QVA_TRACKING_DAYS = 20;
const ENTRY_TRACKING_DAYS = 10;

// seed-historical-pykrx.py로 16개월치 데이터(20250102~20260430) 시드 후 1년 윈도우로 운용.
// 데이터 부족한 종목은 QVA 검출에서 자연 reject.
const SCAN_START = '20250401';
const SCAN_END = '20260319';

// 중복 제거(dedup) 대표 QVA 선택 모드:
//   - earliestQva: 가장 빠른 QVA (감시가 길게 이어진 케이스)
//   - latestQva  : VVI에 가장 가까운 QVA (실제 후보 유지 판단에 가장 현실적) [default]
//   - bestQva    : maxDropBeforeVvi가 가장 작은(=낙폭 매우 얕은) QVA
const DEDUP_MODE = process.env.DEDUP_MODE || 'latestQva';
if (!['earliestQva', 'latestQva', 'bestQva'].includes(DEDUP_MODE)) {
  console.error(`Invalid DEDUP_MODE: ${DEDUP_MODE}. Use earliestQva | latestQva | bestQva`);
  process.exit(1);
}

// ─────────── 종목 분류 ───────────
const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}
function isPreferredStock(name) {
  if (!name) return false;
  return /우[A-Z]?$/.test(name);
}

// ─────────── 통계 헬퍼 ───────────
function sma(values, period) {
  if (!values || values.length < period) return null;
  const recent = values.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / period;
}
function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function avg(values) {
  if (!values || values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
function rate(num, denom) {
  if (!denom) return null;
  return (num / denom) * 100;
}
function round2(v) {
  return v == null || !Number.isFinite(v) ? null : parseFloat(v.toFixed(2));
}

// ─────────── QVA 신호 검출 (qva-to-vvi-report.js와 동일) ───────────
function checkQVASignalAtIdx(rows, idx) {
  if (!rows || idx < 60) return false;
  const today = rows[idx];
  const close = today?.close;
  if (!close || close <= 0) return false;

  const last20 = rows.slice(idx - 19, idx + 1);
  const last5 = rows.slice(idx - 4, idx + 1);
  const avg20Value = last20.reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = last20.reduce((s, r) => s + (r.volume || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return false;

  const todayValue = today.valueApprox || today.close * today.volume;
  const valueRatio20 = todayValue / (avg20Value || 1);
  const volumeRatio20 = today.volume / (avg20Vol || 1);
  if (valueRatio20 < 1.5 || volumeRatio20 < 1.5) return false;

  const lows5 = last5.map(r => r.low);
  const lows20to25 = rows.slice(idx - 24, idx - 4).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;
  if (min5 <= min20) return false;

  const ma20 = sma(last20.map(r => r.close), 20);
  if (ma20 && close < ma20 * 0.95) return false;

  const todayReturn = today.open > 0 ? close / today.open - 1 : 0;
  if (todayReturn > 0.05) return false;

  const ret20d = idx >= 20 ? close / rows[idx - 20].close - 1 : 0;
  if (ret20d > 0.15) return false;

  const medianVal20 = median(last20.map(r => r.valueApprox || 0));
  const valueMedianRatio = medianVal20 > 0 ? todayValue / medianVal20 : 0;
  if (valueMedianRatio < 1.8) return false;

  const last3 = rows.slice(idx - 2, idx + 1);
  const hasRecentValueSpike = last3.some(r => {
    const v = r.valueApprox || r.close * r.volume;
    const vRatio = v / (avg20Value || 1);
    const medRatio = medianVal20 > 0 ? v / medianVal20 : 0;
    return vRatio >= 1.5 || medRatio >= 2.0;
  });
  if (!hasRecentValueSpike) return false;

  const last10hl = rows.slice(idx - 9, idx + 1);
  const high10 = Math.max(...last10hl.map(r => r.high));
  const low10 = Math.min(...last10hl.map(r => r.low));
  const rangeExpansion10 = low10 > 0 ? high10 / low10 - 1 : 0;
  if (rangeExpansion10 < 0.03) return false;

  return true;
}

function formatDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// ─────────── 진입 시뮬레이션 ───────────
// entryIdx = 진입 거래일 인덱스 (= vviIdx + 1)
// 측정 윈도우 = entryIdx+1 ~ entryIdx+N (진입 당일 제외)
function computeEntryMetrics(rows, entryIdx, entryPrice, days = ENTRY_TRACKING_DAYS) {
  if (entryIdx + 1 >= rows.length || !(entryPrice > 0)) {
    return null;
  }
  const out = {
    entryDate: rows[entryIdx]?.date,
    entryPrice,
    d1: null, d3: null, d5: null, d10: null,
    mfe3: null, mfe5: null, mfe10: null,
    mae3: null, mae5: null, mae10: null,
  };
  const ret = (n) => {
    const idx = entryIdx + n;
    if (idx >= rows.length) return null;
    return (rows[idx].close / entryPrice - 1) * 100;
  };
  out.d1 = ret(1); out.d3 = ret(3); out.d5 = ret(5); out.d10 = ret(10);

  const mfeMae = (n) => {
    let mfe = null, mae = null;
    for (let k = 1; k <= n && entryIdx + k < rows.length; k++) {
      const r = rows[entryIdx + k];
      const upPct = (r.high / entryPrice - 1) * 100;
      const downPct = (r.low / entryPrice - 1) * 100;
      if (mfe == null || upPct > mfe) mfe = upPct;
      if (mae == null || downPct < mae) mae = downPct;
    }
    return { mfe, mae };
  };
  const m3 = mfeMae(3), m5 = mfeMae(5), m10 = mfeMae(days);
  out.mfe3 = m3.mfe; out.mae3 = m3.mae;
  out.mfe5 = m5.mfe; out.mae5 = m5.mae;
  out.mfe10 = m10.mfe; out.mae10 = m10.mae;
  return out;
}

// ─────────── 손절 시뮬레이션 ───────────
// 손절 체크 윈도우 = entryIdx+1 ~ entryIdx+days (진입 당일 제외)
// 매일 low <= stopPrice 이면 그 날 stopPrice에 청산.
// 청산 후 D5/D10은 (stopPrice - entryPrice) / entryPrice 로 고정.
// MFE10/MAE10은 청산일까지의 high/low 기준으로만 누적.
function simulateStop(rows, entryIdx, entryPrice, stopPrice, days = ENTRY_TRACKING_DAYS) {
  const out = {
    stoppedOut: false,
    stopDate: null,
    stopDay: null,
    stopReturn: null,
    adjustedD5: null,
    adjustedD10: null,
    adjustedMFE10: null,
    adjustedMAE10: null,
  };
  if (entryIdx + 1 >= rows.length || !(entryPrice > 0) || !(stopPrice > 0)) return out;

  let mfe = null, mae = null;
  let stoppedAt = null;
  for (let k = 1; k <= days && entryIdx + k < rows.length; k++) {
    const r = rows[entryIdx + k];
    const upPct = (r.high / entryPrice - 1) * 100;
    const downPct = (r.low / entryPrice - 1) * 100;
    if (mfe == null || upPct > mfe) mfe = upPct;
    if (r.low <= stopPrice) {
      // 손절: 그 날의 high까지는 mfe에 반영, mae는 stopPrice 기준으로 클립
      const stopPct = (stopPrice / entryPrice - 1) * 100;
      if (mae == null || stopPct < mae) mae = stopPct;
      stoppedAt = { idx: entryIdx + k, day: k };
      break;
    }
    if (mae == null || downPct < mae) mae = downPct;
  }

  out.adjustedMFE10 = mfe;
  out.adjustedMAE10 = mae;

  if (stoppedAt) {
    out.stoppedOut = true;
    out.stopDate = rows[stoppedAt.idx].date;
    out.stopDay = stoppedAt.day;
    out.stopReturn = (stopPrice / entryPrice - 1) * 100;
    out.adjustedD5 = stoppedAt.day <= 5 ? out.stopReturn : (rows[entryIdx + 5]?.close
      ? (rows[entryIdx + 5].close / entryPrice - 1) * 100
      : null);
    out.adjustedD10 = stoppedAt.day <= 10 ? out.stopReturn : (rows[entryIdx + 10]?.close
      ? (rows[entryIdx + 10].close / entryPrice - 1) * 100
      : null);
  } else {
    const d5 = entryIdx + 5 < rows.length ? (rows[entryIdx + 5].close / entryPrice - 1) * 100 : null;
    const d10 = entryIdx + 10 < rows.length ? (rows[entryIdx + 10].close / entryPrice - 1) * 100 : null;
    out.adjustedD5 = d5;
    out.adjustedD10 = d10;
  }
  return out;
}

// ─────────── 메인 ───────────
const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));

console.log(`\n📊 QVA → VVI → 다음날 고가 돌파 진입 검증 보고서`);
console.log(`스캔 기간: ${formatDate(SCAN_START)} ~ ${formatDate(SCAN_END)}`);
console.log(`종목 수: ${files.length}\n`);

const records = [];
let totalQva = 0;
const t0 = Date.now();

for (let fi = 0; fi < files.length; fi++) {
  if (fi % 200 === 0) process.stdout.write(`  진행 ${fi}/${files.length}\r`);
  const code = files[fi].replace('.json', '');
  const meta = codeMeta.get(code);
  if (!meta) continue;

  let chart;
  try { chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8')); }
  catch (_) { continue; }
  const rows = chart.rows || [];
  if (rows.length < 65) continue;

  if (isExcludedProduct(chart.name || meta.name)) continue;

  let flow;
  try { flow = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, files[fi]), 'utf-8')); }
  catch (_) { flow = { rows: [] }; }
  const flowRows = flow.rows || [];
  const namedMeta = { ...meta, name: meta.name || chart.name };

  for (let t = 60; t < rows.length - 1; t++) {
    const today = rows[t];
    if (today.date < SCAN_START || today.date > SCAN_END) continue;
    if (!checkQVASignalAtIdx(rows, t)) continue;
    totalQva++;

    const qvaSignalPrice = today.close;

    // VVI 탐색 (D+1 ~ D+20)
    const maxLookAhead = Math.min(QVA_TRACKING_DAYS, rows.length - 1 - t);
    let vviIdx = null;
    for (let k = 1; k <= maxLookAhead; k++) {
      const cand = t + k;
      const candDate = rows[cand].date;
      const slicedChart = rows.slice(0, cand + 1);
      const slicedFlow = flowRows.filter(r => r.date <= candDate);
      if (slicedFlow.length < 10) continue;
      let vvi = null;
      try { vvi = ps.calculateVolumeValueIgnition(slicedChart, slicedFlow, namedMeta); }
      catch (_) { vvi = null; }
      if (vvi?.passed) { vviIdx = cand; break; }
    }
    if (vviIdx == null) continue;
    if (vviIdx + 1 >= rows.length) continue;

    const vviRow = rows[vviIdx];
    const nextRow = rows[vviIdx + 1];
    const range = vviRow.high - vviRow.low;
    const closeLocation = range > 0 ? (vviRow.close - vviRow.low) / range : null;

    // 다음날 돌파 여부
    const entryPrice = vviRow.high;
    const entryPrice1Pct = vviRow.high * 1.01;
    const triggered = nextRow.high >= entryPrice;
    const triggered1Pct = nextRow.high >= entryPrice1Pct;
    const breakoutFail = nextRow.close < vviRow.high;

    // QVA → VVI 사이 최대 낙폭 (bestQva 모드 / 표시용)
    let minLowBeforeVvi = qvaSignalPrice;
    for (let k = t + 1; k < vviIdx; k++) {
      const r = rows[k];
      if (r.low > 0 && r.low < minLowBeforeVvi) minLowBeforeVvi = r.low;
    }
    const maxDropBeforeVvi = (minLowBeforeVvi / qvaSignalPrice - 1) * 100;

    const entryIdx = vviIdx + 1;

    // 진입 메트릭 (vviHigh / vviHigh*1.01)
    const entryAtVviHigh = triggered
      ? computeEntryMetrics(rows, entryIdx, entryPrice)
      : null;
    const entryAt1Pct = triggered1Pct
      ? computeEntryMetrics(rows, entryIdx, entryPrice1Pct)
      : null;

    // 손절 시뮬레이션 — 진입 vviHigh 기준
    const stopAtVviHighScenarios = triggered ? {
      A_vviLow:    simulateStop(rows, entryIdx, entryPrice, vviRow.low),
      B_vviClose:  simulateStop(rows, entryIdx, entryPrice, vviRow.close),
      C_minus5:    simulateStop(rows, entryIdx, entryPrice, entryPrice * 0.95),
      D_minus7:    simulateStop(rows, entryIdx, entryPrice, entryPrice * 0.93),
    } : null;

    // 손절 시뮬레이션 — 진입 vviHigh*1.01 기준
    const stopAt1PctScenarios = triggered1Pct ? {
      A_vviLow:    simulateStop(rows, entryIdx, entryPrice1Pct, vviRow.low),
      B_vviClose:  simulateStop(rows, entryIdx, entryPrice1Pct, vviRow.close),
      C_minus5:    simulateStop(rows, entryIdx, entryPrice1Pct, entryPrice1Pct * 0.95),
      D_minus7:    simulateStop(rows, entryIdx, entryPrice1Pct, entryPrice1Pct * 0.93),
    } : null;

    // 태그
    const tags = ['QVA_TO_VVI'];
    if (closeLocation != null && closeLocation >= 0.75) tags.push('STRONG_VVI_CLOSE');
    if (triggered) tags.push('NEXT_DAY_BREAKOUT');
    if (triggered1Pct) tags.push('NEXT_DAY_1PCT_BREAKOUT');
    if (breakoutFail) tags.push('BREAKOUT_FAIL');
    if (stopAtVviHighScenarios?.A_vviLow?.stoppedOut) tags.push('STOPPED_VVI_LOW');
    if (stopAtVviHighScenarios?.C_minus5?.stoppedOut) tags.push('STOPPED_MINUS_5');
    if (entryAtVviHigh?.d10 != null) tags.push(entryAtVviHigh.d10 > 0 ? 'D10_WIN' : 'D10_LOSS');

    records.push({
      code,
      name: chart.name || meta.name,
      market: meta.market,
      isPreferred: isPreferredStock(chart.name || meta.name),
      qvaSignalDate: today.date,
      qvaSignalPrice,
      maxDropBeforeVvi,
      vviDate: vviRow.date,
      daysToVvi: vviIdx - t,
      vviOpen: vviRow.open,
      vviHigh: vviRow.high,
      vviLow: vviRow.low,
      vviClose: vviRow.close,
      vviCloseLocation: closeLocation,

      nextOpen: nextRow.open,
      nextHigh: nextRow.high,
      nextLow: nextRow.low,
      nextClose: nextRow.close,

      entryDate: nextRow.date,
      entryPrice,
      entryPrice1Pct,
      entryTriggered: triggered,
      entryTriggered1Pct: triggered1Pct,
      breakoutFail,

      entryAtVviHigh,
      entryAt1Pct,
      stopAtVviHighScenarios,
      stopAt1PctScenarios,

      tags,
    });
  }
}

console.log(`\n→ totalQva=${totalQva}, qvaToVviRecords=${records.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// ─────────── 그룹별 집계 ───────────
function entryAggregate(items, getEntry, getStop) {
  // getEntry(rec) -> entry metrics object or null
  // getStop(rec) -> stop scenario result or null (사용 시 adjusted 메트릭으로 대체)
  const out = {
    count: items.length,
    uniqueStocks: new Set(items.map(i => i.code)).size,
  };
  if (items.length === 0) return out;

  const entries = items.map(i => getEntry(i)).filter(e => e != null);
  out.entryCount = entries.length;
  out.entryRate = round2(rate(entries.length, items.length));

  const pick = (k) => entries.map(e => e[k]).filter(v => v != null && Number.isFinite(v));
  const d3 = pick('d3'), d5 = pick('d5'), d10 = pick('d10');
  const mfe10 = pick('mfe10'), mae10 = pick('mae10');

  out.avgEntryD3Return = round2(avg(d3));
  out.avgEntryD5Return = round2(avg(d5));
  out.avgEntryD10Return = round2(avg(d10));
  out.medianEntryD10Return = round2(median(d10));
  out.avgEntryMFE10 = round2(avg(mfe10));
  out.avgEntryMAE10 = round2(avg(mae10));

  out.posRateD5 = round2(rate(d5.filter(v => v > 0).length, d5.length));
  out.posRateD10 = round2(rate(d10.filter(v => v > 0).length, d10.length));

  out.mfe10Hit10Rate = round2(rate(mfe10.filter(v => v >= 10).length, mfe10.length));
  out.mfe10Hit15Rate = round2(rate(mfe10.filter(v => v >= 15).length, mfe10.length));
  out.mfe10Hit20Rate = round2(rate(mfe10.filter(v => v >= 20).length, mfe10.length));
  out.mae10BelowMinus5Rate = round2(rate(mae10.filter(v => v <= -5).length, mae10.length));
  out.mae10BelowMinus10Rate = round2(rate(mae10.filter(v => v <= -10).length, mae10.length));

  // 손절 시나리오 적용 시 추가 지표
  if (getStop) {
    const stops = items.map((rec, i) => ({ rec, entry: getEntry(rec), stop: getStop(rec) }))
      .filter(x => x.entry != null && x.stop != null);
    if (stops.length > 0) {
      const stopped = stops.filter(x => x.stop.stoppedOut);
      out.stoppedOutRate = round2(rate(stopped.length, stops.length));
      const stopReturns = stopped.map(x => x.stop.stopReturn).filter(Number.isFinite);
      out.avgStoppedLoss = round2(avg(stopReturns));

      const adjD5 = stops.map(x => x.stop.adjustedD5).filter(v => v != null && Number.isFinite(v));
      const adjD10 = stops.map(x => x.stop.adjustedD10).filter(v => v != null && Number.isFinite(v));
      const adjMfe = stops.map(x => x.stop.adjustedMFE10).filter(v => v != null && Number.isFinite(v));
      const adjMae = stops.map(x => x.stop.adjustedMAE10).filter(v => v != null && Number.isFinite(v));
      out.adjustedAvgD5 = round2(avg(adjD5));
      out.adjustedAvgD10 = round2(avg(adjD10));
      out.adjustedAvgMFE10 = round2(avg(adjMfe));
      out.adjustedAvgMAE10 = round2(avg(adjMae));
      out.adjustedPosRateD10 = round2(rate(adjD10.filter(v => v > 0).length, adjD10.length));
    }
  }

  return out;
}

// ─────────── 중복 제거 (dedup) ───────────
// 같은 (code, vviDate, entryDate)를 하나의 이벤트로 묶고, 그 안에서 대표 QVA를 선택한다.
// 같은 dedup 그룹의 진입가/돌파/성과는 동일하므로, 대표 선택은 아래 표시용·QVA 메트릭에만 영향을 준다.
function dedupEvents(items, mode) {
  const groups = new Map();
  for (const r of items) {
    const key = `${r.code}|${r.vviDate}|${r.entryDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const reps = [];
  for (const group of groups.values()) {
    if (group.length === 1) { reps.push(group[0]); continue; }
    let rep;
    if (mode === 'earliestQva') {
      rep = group.reduce((a, b) => a.qvaSignalDate <= b.qvaSignalDate ? a : b);
    } else if (mode === 'bestQva') {
      // maxDropBeforeVvi가 가장 작은(0에 가까운, 즉 낙폭이 얕은) 신호
      rep = group.reduce((a, b) => {
        const aD = a.maxDropBeforeVvi ?? -Infinity;
        const bD = b.maxDropBeforeVvi ?? -Infinity;
        return aD >= bD ? a : b;
      });
    } else {
      // latestQva (default) — VVI에 가장 가까운 QVA
      rep = group.reduce((a, b) => a.qvaSignalDate >= b.qvaSignalDate ? a : b);
    }
    reps.push(rep);
  }
  return reps;
}

// dedup 비교용 H그룹 집계기 (사용자 요청 지표만)
function dedupHAggregate(items) {
  const out = {
    count: items.length,
    uniqueStocks: new Set(items.map(i => i.code)).size,
  };
  if (items.length === 0) return out;
  const entries = items.map(i => i.entryAt1Pct).filter(e => e != null);
  const pick = (k) => entries.map(e => e[k]).filter(v => v != null && Number.isFinite(v));
  const d5 = pick('d5'), d10 = pick('d10');
  const mfe10 = pick('mfe10'), mae10 = pick('mae10');
  out.avgEntryD5Return = round2(avg(d5));
  out.avgEntryD10Return = round2(avg(d10));
  out.medianEntryD10Return = round2(median(d10));
  out.avgEntryMFE10 = round2(avg(mfe10));
  out.avgEntryMAE10 = round2(avg(mae10));
  out.posRateD10 = round2(rate(d10.filter(v => v > 0).length, d10.length));
  out.mfe10Hit10Rate = round2(rate(mfe10.filter(v => v >= 10).length, mfe10.length));
  out.mfe10Hit20Rate = round2(rate(mfe10.filter(v => v >= 20).length, mfe10.length));
  out.mae10BelowMinus5Rate = round2(rate(mae10.filter(v => v <= -5).length, mae10.length));
  out.mae10BelowMinus10Rate = round2(rate(mae10.filter(v => v <= -10).length, mae10.length));
  return out;
}

const VVI_HIGH = (rec) => rec.entryAtVviHigh;
const ENTRY_1PCT = (rec) => rec.entryAt1Pct;

// 그룹 정의
const groupDefs = [
  {
    key: 'A_qvaToVviAll',
    label: 'A. QVA→VVI 전체',
    items: () => records,
    entry: VVI_HIGH,
    stop: null,
  },
  {
    key: 'B_qvaToVviPlusBreakout',
    label: 'B. + 다음날 고가 돌파',
    items: () => records.filter(r => r.entryTriggered),
    entry: VVI_HIGH,
    stop: null,
  },
  {
    key: 'C_qvaToVviPlusStrongClose',
    label: 'C. + VVI 종가위치 ≥ 0.75',
    items: () => records.filter(r => r.vviCloseLocation != null && r.vviCloseLocation >= 0.75),
    entry: VVI_HIGH,
    stop: null,
  },
  {
    key: 'D_strongClosePlusBreakout',
    label: 'D. C + 다음날 고가 돌파',
    items: () => records.filter(r => r.vviCloseLocation != null && r.vviCloseLocation >= 0.75 && r.entryTriggered),
    entry: VVI_HIGH,
    stop: null,
  },
  {
    key: 'E_strongClosePlus1PctBreakout',
    label: 'E. C + 다음날 +1% 돌파',
    items: () => records.filter(r => r.vviCloseLocation != null && r.vviCloseLocation >= 0.75 && r.entryTriggered1Pct),
    entry: ENTRY_1PCT,
    stop: null,
  },
  {
    key: 'F_E_plus_vviLowStop',
    label: 'F. E + VVI 저가 이탈 손절',
    items: () => records.filter(r => r.vviCloseLocation != null && r.vviCloseLocation >= 0.75 && r.entryTriggered1Pct),
    entry: ENTRY_1PCT,
    stop: (rec) => rec.stopAt1PctScenarios?.A_vviLow,
  },
  {
    key: 'G_E_plus_minus5Stop',
    label: 'G. E + -5% 손절',
    items: () => records.filter(r => r.vviCloseLocation != null && r.vviCloseLocation >= 0.75 && r.entryTriggered1Pct),
    entry: ENTRY_1PCT,
    stop: (rec) => rec.stopAt1PctScenarios?.C_minus5,
  },
  {
    key: 'H_E_excludeBreakoutFail',
    label: 'H. E + 돌파실패 제외 (다음 종가 ≥ vviHigh)',
    items: () => records.filter(r =>
      r.vviCloseLocation != null && r.vviCloseLocation >= 0.75
      && r.entryTriggered1Pct && !r.breakoutFail
    ),
    entry: ENTRY_1PCT,
    stop: null,
  },
];

const groups = {};
for (const def of groupDefs) {
  groups[def.key] = {
    label: def.label,
    ...entryAggregate(def.items(), def.entry, def.stop),
  };
}

// 손절 시나리오 비교 (E 그룹 고정, 진입 1% 기준)
const eItems = records.filter(r =>
  r.vviCloseLocation != null && r.vviCloseLocation >= 0.75 && r.entryTriggered1Pct
);
const stopComparison = {};
const stopScenariosE = {
  A_vviLow:   { label: 'A. VVI 저가 이탈',    pick: (r) => r.stopAt1PctScenarios?.A_vviLow },
  B_vviClose: { label: 'B. VVI 종가 이탈',    pick: (r) => r.stopAt1PctScenarios?.B_vviClose },
  C_minus5:   { label: 'C. 진입가 -5%',       pick: (r) => r.stopAt1PctScenarios?.C_minus5 },
  D_minus7:   { label: 'D. 진입가 -7%',       pick: (r) => r.stopAt1PctScenarios?.D_minus7 },
};
for (const [k, def] of Object.entries(stopScenariosE)) {
  stopComparison[k] = {
    label: def.label,
    ...entryAggregate(eItems, ENTRY_1PCT, def.pick),
  };
}
// 손절 없음 (베이스라인)
stopComparison.NONE = {
  label: '0. 손절 없음 (베이스라인)',
  ...entryAggregate(eItems, ENTRY_1PCT, null),
};

// ─────────── 중복 제거(dedup) 비교 — H그룹 기준 ───────────
// H그룹 = E + breakoutFail 제외 (다음 종가 ≥ vviHigh)
const hSignal = records.filter(r =>
  r.vviCloseLocation != null && r.vviCloseLocation >= 0.75
  && r.entryTriggered1Pct
  && !r.breakoutFail
);
const hEvent = dedupEvents(hSignal, DEDUP_MODE);
// 모드별 결과 모두 노출 (집계 자체는 모드 무관 — 같은 이벤트면 진입 메트릭이 동일)
const dedupByMode = {};
for (const m of ['earliestQva', 'latestQva', 'bestQva']) {
  dedupByMode[m] = dedupHAggregate(dedupEvents(hSignal, m));
}
const dedupSummary = {
  mode: DEDUP_MODE,
  notice:
    '기존 결과는 QVA 신호 기준이며, 동일 종목의 같은 VVI 이벤트가 여러 QVA 신호와 연결될 수 있습니다. ' +
    'dedup 결과는 code + vviDate + entryDate 기준으로 중복을 제거한 실제 이벤트 기준 성과입니다.',
  signalBasedH: dedupHAggregate(hSignal),
  eventBasedH: dedupHAggregate(hEvent),
  duplicateRatePct: round2(rate(hSignal.length - hEvent.length, hSignal.length)),
  duplicatesRemoved: hSignal.length - hEvent.length,
  byMode: dedupByMode,
};

// ─────────── 요약 ───────────
const summary = {
  scanStart: SCAN_START,
  scanEnd: SCAN_END,
  totalQvaSignals: totalQva,
  qvaToVviCount: records.length,
  qvaToVviRate: round2(rate(records.length, totalQva)),
  nextDayBreakoutCount: records.filter(r => r.entryTriggered).length,
  nextDayBreakout1PctCount: records.filter(r => r.entryTriggered1Pct).length,
  strongCloseCount: records.filter(r => r.vviCloseLocation != null && r.vviCloseLocation >= 0.75).length,
  strongClosePlus1PctCount: eItems.length,
};

// ─────────── 콘솔 출력 ───────────
console.log(`\n${'='.repeat(120)}`);
console.log(`📊 요약`);
console.log(`전체 QVA 신호: ${summary.totalQvaSignals}건`);
console.log(`QVA→VVI 전환: ${summary.qvaToVviCount}건 (${summary.qvaToVviRate}%)`);
console.log(`+ 다음날 고가 돌파:        ${summary.nextDayBreakoutCount}건`);
console.log(`+ 다음날 +1% 돌파:         ${summary.nextDayBreakout1PctCount}건`);
console.log(`+ VVI 종가위치 ≥ 0.75:     ${summary.strongCloseCount}건`);
console.log(`+ E 그룹 (강한 종가 + 1%): ${summary.strongClosePlus1PctCount}건\n`);

const fmtNum = (v) => v == null ? '   -  ' : (v >= 0 ? '+' : '') + v.toFixed(2).padStart(6);
const fmtPct = (v) => v == null ? '   -  ' : v.toFixed(1).padStart(5) + '%';

console.log(`그룹별 진입 후 성과 비교 (n · 진입수 · D5/D10 평균 · MFE10 · MAE10 · D5+/D10+ 비율)`);
for (const [key, g] of Object.entries(groups)) {
  console.log(
    `  ${(g.label).padEnd(52)} | ` +
    `n=${String(g.count).padStart(3)} 진입${String(g.entryCount ?? '-').padStart(3)} | ` +
    `D5 ${fmtNum(g.avgEntryD5Return)} D10 ${fmtNum(g.avgEntryD10Return)} | ` +
    `MFE ${fmtNum(g.avgEntryMFE10)} MAE ${fmtNum(g.avgEntryMAE10)} | ` +
    `D5+ ${fmtPct(g.posRateD5)} D10+ ${fmtPct(g.posRateD10)}`
  );
  if (g.stoppedOutRate != null) {
    console.log(
      `    └ 손절 적용: stop ${fmtPct(g.stoppedOutRate)} 평균손절 ${fmtNum(g.avgStoppedLoss)} | ` +
      `adj D10 ${fmtNum(g.adjustedAvgD10)} adj MFE ${fmtNum(g.adjustedAvgMFE10)} adj MAE ${fmtNum(g.adjustedAvgMAE10)} | ` +
      `adj D10+ ${fmtPct(g.adjustedPosRateD10)}`
    );
  }
}

console.log(`\n손절 시나리오별 비교 (E 그룹 ${eItems.length}건 고정, 진입 vviHigh×1.01)`);
for (const [key, s] of Object.entries(stopComparison)) {
  console.log(
    `  ${(s.label).padEnd(28)} | stop ${fmtPct(s.stoppedOutRate)} 평균손절 ${fmtNum(s.avgStoppedLoss)} | ` +
    `adj D10 ${fmtNum(s.adjustedAvgD10 ?? s.avgEntryD10Return)} ` +
    `adj MFE ${fmtNum(s.adjustedAvgMFE10 ?? s.avgEntryMFE10)} ` +
    `adj MAE ${fmtNum(s.adjustedAvgMAE10 ?? s.avgEntryMAE10)} | ` +
    `D10+ ${fmtPct(s.adjustedPosRateD10 ?? s.posRateD10)}`
  );
}

console.log(`\n중복 제거 비교 (H그룹 — code+vviDate+entryDate 기준, dedup mode = ${DEDUP_MODE})`);
const printDedup = (label, x) => console.log(
  `  ${label.padEnd(20)} | n=${String(x.count).padStart(4)} 종목 ${String(x.uniqueStocks).padStart(3)} | ` +
  `D5 ${fmtNum(x.avgEntryD5Return)} D10 ${fmtNum(x.avgEntryD10Return)} (med ${fmtNum(x.medianEntryD10Return)}) | ` +
  `MFE ${fmtNum(x.avgEntryMFE10)} MAE ${fmtNum(x.avgEntryMAE10)} | ` +
  `D10+ ${fmtPct(x.posRateD10)} MFE≥10 ${fmtPct(x.mfe10Hit10Rate)} MFE≥20 ${fmtPct(x.mfe10Hit20Rate)} | ` +
  `MAE≤-5 ${fmtPct(x.mae10BelowMinus5Rate)} MAE≤-10 ${fmtPct(x.mae10BelowMinus10Rate)}`
);
printDedup('기존 신호 기준', dedupSummary.signalBasedH);
printDedup('이벤트 기준',   dedupSummary.eventBasedH);
console.log(`  → 중복 제거된 신호: ${dedupSummary.duplicatesRemoved}건 (${dedupSummary.duplicateRatePct}%)`);
console.log(`  ※ dedup 집계는 대표 모드 무관 (같은 이벤트는 진입 메트릭이 동일). byMode는 검증용으로만 JSON에 포함.`);

// ─────────── 상세 직렬화 ───────────
function detailSerializer(rec) {
  const e = rec.entryAtVviHigh;
  const e1 = rec.entryAt1Pct;
  const stopVH = rec.stopAtVviHighScenarios;
  const stop1P = rec.stopAt1PctScenarios;
  const ser = (s) => s ? {
    stoppedOut: s.stoppedOut,
    stopDate: s.stopDate,
    stopDay: s.stopDay,
    stopReturn: round2(s.stopReturn),
    adjustedD5: round2(s.adjustedD5),
    adjustedD10: round2(s.adjustedD10),
    adjustedMFE10: round2(s.adjustedMFE10),
    adjustedMAE10: round2(s.adjustedMAE10),
  } : null;
  return {
    code: rec.code,
    name: rec.name,
    market: rec.market,
    isPreferred: rec.isPreferred,
    qvaSignalDate: rec.qvaSignalDate,
    qvaSignalPrice: rec.qvaSignalPrice,
    vviDate: rec.vviDate,
    daysToVvi: rec.daysToVvi,
    vviOpen: rec.vviOpen, vviHigh: rec.vviHigh, vviLow: rec.vviLow, vviClose: rec.vviClose,
    vviCloseLocation: round2(rec.vviCloseLocation),
    nextOpen: rec.nextOpen, nextHigh: rec.nextHigh, nextLow: rec.nextLow, nextClose: rec.nextClose,
    entryDate: rec.entryDate,
    entryPrice: rec.entryPrice,
    entryPrice1Pct: round2(rec.entryPrice1Pct),
    entryTriggered: rec.entryTriggered,
    entryTriggered1Pct: rec.entryTriggered1Pct,
    breakoutFail: rec.breakoutFail,
    entryD1Return: round2(e?.d1),
    entryD3Return: round2(e?.d3),
    entryD5Return: round2(e?.d5),
    entryD10Return: round2(e?.d10),
    entryMFE10: round2(e?.mfe10),
    entryMAE10: round2(e?.mae10),
    entry1PctD5Return: round2(e1?.d5),
    entry1PctD10Return: round2(e1?.d10),
    entry1PctMFE10: round2(e1?.mfe10),
    entry1PctMAE10: round2(e1?.mae10),
    stopAtVviHigh: stopVH ? {
      A_vviLow: ser(stopVH.A_vviLow),
      B_vviClose: ser(stopVH.B_vviClose),
      C_minus5: ser(stopVH.C_minus5),
      D_minus7: ser(stopVH.D_minus7),
    } : null,
    stopAt1Pct: stop1P ? {
      A_vviLow: ser(stop1P.A_vviLow),
      B_vviClose: ser(stop1P.B_vviClose),
      C_minus5: ser(stop1P.C_minus5),
      D_minus7: ser(stop1P.D_minus7),
    } : null,
    tags: rec.tags,
  };
}

const sortedRecords = records.slice().sort((a, b) => {
  const aRet = a.entryAtVviHigh?.d10 ?? a.entryAt1Pct?.d10 ?? -Infinity;
  const bRet = b.entryAtVviHigh?.d10 ?? b.entryAt1Pct?.d10 ?? -Infinity;
  if (bRet !== aRet) return bRet - aRet;
  return a.qvaSignalDate.localeCompare(b.qvaSignalDate);
});

const triggeredRecs = records.filter(r => r.entryTriggered && r.entryAtVviHigh?.d10 != null);
const top10 = triggeredRecs.slice().sort((a, b) => b.entryAtVviHigh.d10 - a.entryAtVviHigh.d10).slice(0, 10);
const worst10 = triggeredRecs.slice().sort((a, b) => a.entryAtVviHigh.d10 - b.entryAtVviHigh.d10).slice(0, 10);

const jsonOut = {
  meta: {
    purpose: 'QVA → VVI → 다음날 고가 돌파 진입 후 성과 + 손절 시나리오 검증',
    notice: 'QVA = 감시 시작, VVI = 거래대금 초동 확인, 다음날 고가 돌파 = 진입 후보 검토. 매수 추천 아님.',
    qvaTrackingDays: QVA_TRACKING_DAYS,
    entryTrackingDays: ENTRY_TRACKING_DAYS,
    entryDefinition: {
      basic: 'entryPrice = vviHigh, triggered if nextHigh >= entryPrice',
      strong: 'entryPrice1Pct = vviHigh × 1.01, triggered if nextHigh >= entryPrice1Pct',
    },
    stopScenarios: {
      A: 'VVI 당일 저가 이탈 (stopPrice = vviLow)',
      B: 'VVI 당일 종가 이탈 (stopPrice = vviClose)',
      C: '진입가 -5% (stopPrice = entryPrice × 0.95)',
      D: '진입가 -7% (stopPrice = entryPrice × 0.93)',
      E: '돌파실패 플래그 (nextClose < vviHigh)',
    },
    scanStart: SCAN_START,
    scanEnd: SCAN_END,
    generatedAt: new Date().toISOString(),
  },
  summary,
  groups,
  stopComparison,
  dedupSummary,
  top10: top10.map(detailSerializer),
  worst10: worst10.map(detailSerializer),
  details: sortedRecords.map(detailSerializer),
};

fs.writeFileSync(
  path.join(ROOT, 'qva-vvi-breakout-entry-report.json'),
  JSON.stringify(jsonOut, null, 2),
  'utf-8'
);
console.log(`\n✅ JSON 저장: qva-vvi-breakout-entry-report.json`);

// ─────────── HTML 출력 ───────────
const htmlTemplate = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QVA → VVI → 다음날 고가 돌파 진입 검증</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
  h1 { color: #f1f5f9; margin: 0 0 4px 0; font-size: 24px; }
  h1 .sub { color: #94a3b8; font-size: 14px; font-weight: 400; margin-left: 6px; }
  h2 { color: #f1f5f9; margin: 32px 0 12px 0; font-size: 18px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
  h3 { color: #cbd5e1; font-size: 14px; margin: 18px 0 8px 0; font-weight: 600; }
  .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 16px; }

  .info-box { background: #1e293b; padding: 14px 18px; border-radius: 8px; margin-bottom: 14px; border-left: 3px solid #60a5fa; }
  .info-box p { margin: 0 0 8px 0; font-size: 13px; line-height: 1.65; color: #cbd5e1; }
  .info-box p:last-child { margin-bottom: 0; }
  .info-box strong { color: #f1f5f9; }

  .summary { background: #1e293b; padding: 16px 20px; border-radius: 8px; margin-bottom: 14px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .stat { background: #0f172a; padding: 10px 14px; border-radius: 6px; }
  .stat-label { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { color: #f1f5f9; font-size: 18px; font-weight: 600; margin-top: 2px; }

  .note { color: #94a3b8; font-size: 12px; line-height: 1.6; margin-bottom: 6px; }
  .note strong { color: #cbd5e1; }
  .note.warn { color: #fcd34d; background: #1e293b; padding: 10px 14px; border-radius: 6px; border-left: 3px solid #f59e0b; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #334155; white-space: nowrap; }
  th.txt, td.txt { text-align: left; }
  th { background: #283447; color: #cbd5e1; font-weight: 600; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 1; }
  th:hover { background: #334155; }
  th .help, td .help { display: inline-block; margin-left: 4px; color: #60a5fa; cursor: help; font-size: 10px; }
  tr:hover { background: #283447; }
  .table-wrap { background: #1e293b; padding: 8px; border-radius: 8px; margin-bottom: 14px; overflow-x: auto; }

  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-left: 2px; }
  .badge.brk { background: #1e3a8a; color: #93c5fd; }
  .badge.brk1 { background: #1e40af; color: #bfdbfe; }
  .badge.strong { background: #166534; color: #bbf7d0; }
  .badge.fail { background: #7f1d1d; color: #fecaca; }
  .badge.stop { background: #7c2d12; color: #fed7aa; }
  .badge.win { background: #064e3b; color: #6ee7b7; }
  .badge.loss { background: #4c1d1d; color: #fca5a5; }
  .badge.pref { background: #1e3a8a; color: #93c5fd; }
  .pos { color: #10b981; }
  .neg { color: #f87171; }
  .muted { color: #64748b; }
  .market-K { color: #60a5fa; }
  .market-Q { color: #c084fc; }

  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .controls input[type=text] { flex: 1; min-width: 200px; padding: 8px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 13px; }
  .controls select { padding: 8px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 13px; }

  .cards { display: none; padding: 4px 0 12px 0; }
  .card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .card-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .card-head .name { font-weight: 700; font-size: 15px; }
  .card-head .meta { color: #64748b; font-size: 11px; margin-left: auto; }
  .card-body { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 12px; }
  .card-body .lbl { color: #64748b; }
  .card-body .val { color: #e2e8f0; text-align: right; }

  @media (max-width: 800px) {
    body { padding: 12px; }
    h1 { font-size: 18px; }
    h1 .sub { display: block; font-size: 12px; margin: 2px 0 0 0; }
    .table-wrap table { font-size: 11px; }
    .table-wrap th, .table-wrap td { padding: 6px 6px; }
  }
  @media (max-width: 640px) {
    .details-wrap table { display: none; }
    .details-wrap .cards { display: block; }
  }
</style>
</head>
<body>
  <h1>📊 QVA → VVI → 다음날 고가 돌파 진입 검증<span class="sub">— 진입가/손절가/이후 성과 검증</span></h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="nav" style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
    <a href="/qva-watchlist" style="color:#93c5fd;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e293b;border-radius:6px;">📋 매일 운영 보드</a>
    <span style="color:#475569;font-size:11px;align-self:center;">검증 ▶</span>
    <a href="/qva-to-vvi-report" style="color:#93c5fd;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e293b;border-radius:6px;">QVA → VVI 전환</a>
    <a href="/qva-vvi-breakout-entry-report" style="color:#fff;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e3a8a;border-radius:6px;">진입</a>
    <a href="/qva-vvi-breakout-exit-report" style="color:#93c5fd;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e293b;border-radius:6px;">익절/청산</a>
  </div>

  <div class="note" style="color:#94a3b8;font-size:12px;margin-bottom:6px;">📚 <strong style="color:#cbd5e1;">검증 보고서</strong> — 매일 운영 화면이 아닌 과거 데이터 분석. 매일 보드는 <a href="/qva-watchlist" style="color:#93c5fd;">📋 매일 운영 보드</a>로 이동하세요.</div>

  <div class="info-box">
    <p>이 보고서는 <strong>QVA 후보 중 VVI로 전환된 종목이 다음 거래일에 VVI 고가를 돌파했을 때, 실제 진입 후보로 볼 수 있는지</strong> 검증합니다.</p>
    <p>QVA는 <strong>감시 시작</strong>, VVI는 <strong>거래대금 초동 확인</strong>, 다음날 고가 돌파는 <strong>진입 후보 검토 조건</strong>입니다.</p>
    <p>본 보고서는 <strong>매수 추천이 아니라 조건 조합의 성과 검증용</strong>입니다.</p>
  </div>

  <div class="note warn" id="period-warn"></div>

  <h3>전체 요약</h3>
  <div class="summary">
    <div class="summary-grid" id="summary-grid"></div>
  </div>

  <h2>H그룹: 돌파 성공 후보</h2>
  <div class="info-box" style="border-left:3px solid #10b981;">
    <p>QVA 이후 VVI가 발생했고, 다음날 VVI 고가보다 1% 이상 돌파한 뒤, 종가가 VVI 고가 위에서 마감한 후보입니다.</p>
    <p id="h-narrative" style="line-height:1.85;"></p>
  </div>

  <h2>그룹별 진입 후 성과 비교</h2>
  <div class="note">
    각 그룹별 진입 트리거 수와 진입 후 5일/10일 수익률, 10일 안 최고 상승률·최대 하락률, <strong>플러스 마감 비율</strong>을 표시합니다. F/G 행은 손절 시나리오를 적용한 조정값을 함께 보여줍니다.
  </div>
  <div class="table-wrap">
    <table id="group-table">
      <thead><tr>
        <th class="txt">그룹</th>
        <th>신호 수<span class="help" title="해당 그룹 조건을 만족하는 신호 수">ⓘ</span></th>
        <th>진입 발생<span class="help" title="다음날 진입 조건이 충족된 건수">ⓘ</span></th>
        <th>5일 뒤 평균<span class="help" title="진입 후 5거래일째 종가 기준 평균 수익률">ⓘ</span></th>
        <th>10일 뒤 평균<span class="help" title="진입 후 10거래일째 종가 기준 평균 수익률">ⓘ</span></th>
        <th>10일 뒤 중간<span class="help" title="극단값 영향을 줄인 중간값">ⓘ</span></th>
        <th>10일 안 최고 상승<span class="help" title="진입 후 10거래일 안 장중 최고가 기준 평균 (MFE10)">ⓘ</span></th>
        <th>10일 안 최대 하락<span class="help" title="진입 후 10거래일 안 장중 저가 기준 평균 (MAE10)">ⓘ</span></th>
        <th>5일 플러스%<span class="help" title="5일 뒤 종가가 진입가보다 높았던 비율">ⓘ</span></th>
        <th>10일 플러스%<span class="help" title="10일 뒤 종가가 진입가보다 높았던 비율">ⓘ</span></th>
        <th>+15% 도달%<span class="help" title="10일 안 +15% 이상 도달 비율">ⓘ</span></th>
        <th>-10% 하락%<span class="help" title="10일 안 -10% 이상 하락 비율">ⓘ</span></th>
        <th>청산 발생률<span class="help" title="해당 손절 조건에 걸린 비율">ⓘ</span></th>
        <th>10일 평균(조정)<span class="help" title="손절 적용 후 10일 평균 수익률">ⓘ</span></th>
        <th>10일 플러스%(조정)<span class="help" title="손절 적용 후 10일 플러스 마감 비율">ⓘ</span></th>
      </tr></thead>
      <tbody id="group-tbody"></tbody>
    </table>
  </div>

  <h2>손절 시나리오별 비교 <span style="color:#94a3b8;font-weight:400;font-size:13px">(E그룹 고정, 진입가 = vviHigh × 1.01)</span></h2>
  <div class="note">
    같은 진입군에 손절 기준만 바꿔 적용했을 때 평균 결과가 어떻게 변하는지 비교합니다.
  </div>
  <div class="table-wrap">
    <table id="stop-table">
      <thead><tr>
        <th class="txt">손절 시나리오</th>
        <th>진입 수</th>
        <th>청산 발생률<span class="help" title="해당 손절 조건에 걸린 비율">ⓘ</span></th>
        <th>평균 청산 손실<span class="help" title="청산된 케이스의 평균 손실률">ⓘ</span></th>
        <th>5일 평균(조정)</th>
        <th>10일 평균(조정)</th>
        <th>10일 안 최고 상승(조정)</th>
        <th>10일 안 최대 하락(조정)</th>
        <th>10일 플러스%(조정)</th>
      </tr></thead>
      <tbody id="stop-tbody"></tbody>
    </table>
  </div>

  <h2>중복 제거 비교 <span style="color:#94a3b8;font-weight:400;font-size:13px">(H그룹 — code + vviDate + entryDate 기준)</span></h2>
  <div class="info-box" style="border-left:3px solid #fbbf24;">
    <p>기존 결과는 <strong>QVA 신호 기준</strong>이며, 동일 종목의 같은 VVI 이벤트가 여러 QVA 신호와 연결될 수 있습니다.</p>
    <p>dedup 결과는 <strong>code + vviDate + entryDate 기준으로 중복을 제거한 실제 이벤트 기준</strong> 성과입니다.</p>
    <p style="color:#94a3b8;font-size:12px;">대표 QVA 선택 모드: <code id="dedup-mode"></code> · 기본값 <code>latestQva</code> (VVI에 가장 가까운 QVA를 대표로 사용 — 실제 후보 유지 판단에 가장 현실적). 환경변수 <code>DEDUP_MODE=earliestQva|latestQva|bestQva</code>로 변경 가능.</p>
  </div>
  <div class="table-wrap">
    <table id="dedup-table">
      <thead><tr>
        <th class="txt">기준</th>
        <th>신호 수</th>
        <th>고유 종목 수</th>
        <th>5일 뒤 평균</th>
        <th>10일 뒤 평균</th>
        <th>10일 뒤 중간</th>
        <th>10일 안 최고 상승<span class="help" title="진입 후 10거래일 안 장중 최고가 기준 평균 (MFE10)">ⓘ</span></th>
        <th>10일 안 최대 하락<span class="help" title="진입 후 10거래일 안 장중 저가 기준 평균 (MAE10)">ⓘ</span></th>
        <th>10일 플러스%</th>
        <th>+10% 도달%<span class="help" title="10일 안 +10% 이상 도달 비율">ⓘ</span></th>
        <th>+20% 도달%<span class="help" title="10일 안 +20% 이상 도달 비율">ⓘ</span></th>
        <th>-5% 하락%</th>
        <th>-10% 하락%</th>
      </tr></thead>
      <tbody id="dedup-tbody"></tbody>
    </table>
  </div>
  <div class="note" id="dedup-note"></div>

  <h2>잘 된 사례 TOP 10 <span style="color:#94a3b8;font-weight:400;font-size:13px">(진입 vviHigh 기준 D10 상위)</span></h2>
  <div class="table-wrap">
    <table id="top-table">
      <thead><tr>
        <th class="txt">QVA일</th>
        <th class="txt">VVI일</th>
        <th class="txt">진입일</th>
        <th class="txt">종목</th>
        <th>진입가</th>
        <th>VVI 종가위치</th>
        <th>D5%</th>
        <th>D10%</th>
        <th>MFE10</th>
        <th>MAE10</th>
        <th class="txt">손절(A 저가)</th>
        <th class="txt">손절(C -5%)</th>
      </tr></thead>
      <tbody id="top-tbody"></tbody>
    </table>
  </div>

  <h2>실패 사례 WORST 10</h2>
  <div class="note">대한유화·LS마린솔루션·삼성중공업처럼 다음날 돌파에도 손실이 컸던 종목이 어떤 손절 조건에서 걸러지는지 확인할 수 있습니다.</div>
  <div class="table-wrap">
    <table id="worst-table">
      <thead><tr>
        <th class="txt">QVA일</th>
        <th class="txt">VVI일</th>
        <th class="txt">진입일</th>
        <th class="txt">종목</th>
        <th>진입가</th>
        <th>VVI 종가위치</th>
        <th>D5%</th>
        <th>D10%</th>
        <th>MFE10</th>
        <th>MAE10</th>
        <th class="txt">손절(A 저가)</th>
        <th class="txt">손절(C -5%)</th>
      </tr></thead>
      <tbody id="worst-tbody"></tbody>
    </table>
  </div>

  <h2>종목별 상세</h2>
  <div class="controls">
    <input type="text" id="filter" placeholder="종목명 또는 코드 검색…">
    <select id="cat-filter">
      <option value="all">전체</option>
      <option value="brk">다음날 고가 돌파</option>
      <option value="brk1">다음날 +1% 돌파</option>
      <option value="strong">VVI 종가위치 ≥ 0.75</option>
      <option value="fail">돌파 실패</option>
      <option value="stoppedA">VVI 저가 청산 발생</option>
      <option value="stoppedC">-5% 청산 발생</option>
      <option value="win">10일 뒤 플러스 마감</option>
      <option value="loss">10일 뒤 마이너스 마감</option>
      <option value="pref">우선주만</option>
    </select>
  </div>
  <div class="table-wrap details-wrap">
    <table id="details-table">
      <thead><tr>
        <th class="txt">QVA일</th>
        <th class="txt">VVI일</th>
        <th class="txt">진입일</th>
        <th class="txt">코드</th>
        <th class="txt">종목</th>
        <th>VVI 고가</th>
        <th>VVI 저가</th>
        <th>VVI 종가</th>
        <th>종가 위치<span class="help" title="(VVI 종가 - VVI 저가) / (VVI 고가 - VVI 저가). 1에 가까울수록 고가권 마감.">ⓘ</span></th>
        <th>다음 고가</th>
        <th>다음 종가</th>
        <th class="txt">진입 발생</th>
        <th>5일 뒤<span class="help" title="진입 후 5거래일째 종가 기준 수익률">ⓘ</span></th>
        <th>10일 뒤<span class="help" title="진입 후 10거래일째 종가 기준 수익률">ⓘ</span></th>
        <th>10일 안 최고 상승<span class="help" title="진입 후 10거래일 안 장중 최고가 기준 (MFE10)">ⓘ</span></th>
        <th>10일 안 최대 하락<span class="help" title="진입 후 10거래일 안 장중 저가 기준 (MAE10)">ⓘ</span></th>
        <th class="txt">VVI 저가 청산</th>
        <th class="txt">-5% 청산</th>
        <th class="txt">태그</th>
      </tr></thead>
      <tbody id="details-tbody"></tbody>
    </table>
    <div class="cards" id="details-cards"></div>
  </div>

  <div class="note warn">
    ⚠️ 본 화면은 <strong>매수 추천이 아닙니다</strong>. QVA는 관심종목 후보 압축, VVI는 거래대금 초동 확인, 다음날 고가 돌파는 진입 후보 검토 조건입니다. 실제 매매는 차트, 뉴스, 시장 상황, 리스크 관리를 함께 고려해야 합니다.
  </div>

<script>
(function rewriteNavForFileProtocol(){
  if (location.protocol !== 'file:') return;
  const map = {
    '/qva-watchlist': 'qva-watchlist-board.html',
    '/qva-to-vvi-report': 'qva-to-vvi-report.html',
    '/qva-vvi-breakout-entry-report': 'qva-vvi-breakout-entry-report.html',
    '/qva-vvi-breakout-exit-report': 'qva-vvi-breakout-exit-report.html',
  };
  document.querySelectorAll('a[href]').forEach(a => {
    const h = a.getAttribute('href');
    if (map[h]) a.setAttribute('href', map[h]);
  });
})();

const DATA = __JSON_DATA__;

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8) : (d || '-'); }
function fmtNum(n) { return n != null ? Math.round(n).toLocaleString() : '-'; }
function fmtPct(n, sign) {
  if (n == null || !Number.isFinite(n)) return '<span class="muted">-</span>';
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : 'muted');
  const s = (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
  return '<span class="' + cls + '">' + s + '</span>';
}
function fmtRatio(n) { return n == null ? '-' : n.toFixed(2); }
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }

function fmtStopShort(s) {
  if (!s) return '<span class="muted">-</span>';
  if (s.stoppedOut) {
    return '<span class="neg">손절 D+' + s.stopDay + ' ' + s.stopReturn.toFixed(1) + '%</span>';
  }
  const v = s.adjustedD10;
  if (v == null) return '<span class="muted">유지</span>';
  return '<span class="' + (v > 0 ? 'pos' : 'neg') + '">유지 ' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
}

// 헤더 자막
document.getElementById('subtitle').textContent =
  '스캔 ' + fmtDate(DATA.meta.scanStart) + ' ~ ' + fmtDate(DATA.meta.scanEnd) +
  ' · QVA 추적 D+1~D+' + DATA.meta.qvaTrackingDays +
  ' · 진입 후 D+1~D+' + DATA.meta.entryTrackingDays +
  ' · 생성: ' + DATA.meta.generatedAt.slice(0, 19).replace('T', ' ');

// 요약 카드
const sum = DATA.summary;
function makeStat(label, val) {
  return '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value">' + val + '</div></div>';
}
document.getElementById('summary-grid').innerHTML = [
  makeStat('전체 QVA 신호', sum.totalQvaSignals + '건'),
  makeStat('QVA→VVI 전환', sum.qvaToVviCount + '건 (' + sum.qvaToVviRate + '%)'),
  makeStat('+ 다음날 돌파', sum.nextDayBreakoutCount + '건'),
  makeStat('+ 다음날 +1% 돌파', sum.nextDayBreakout1PctCount + '건'),
  makeStat('+ VVI 종가위치 ≥ 0.75', sum.strongCloseCount + '건'),
  makeStat('E그룹 (강한 종가 + 1%)', sum.strongClosePlus1PctCount + '건'),
].join('');

// 기간 주의 문구
document.getElementById('period-warn').innerHTML =
  '⚠️ 본 검증은 <strong>' + DATA.meta.scanStart.replace(/(\\d{4})(\\d{2})(\\d{2})/, '$1-$2-$3') + ' ~ ' + DATA.meta.scanEnd.replace(/(\\d{4})(\\d{2})(\\d{2})/, '$1-$2-$3') + ' 단일 시장 사이클</strong> 기준입니다. 다른 시장 국면에서도 동일하게 작동하는지는 추가 검증이 필요합니다.';

// H그룹 narrative — JSON 값에서 직접 렌더링
const hGroupData = DATA.groups?.H_E_excludeBreakoutFail;
if (hGroupData) {
  const f = (v) => v == null ? '-' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const p = (v) => v == null ? '-' : v.toFixed(2) + '%';
  document.getElementById('h-narrative').innerHTML =
    '총 <strong>' + hGroupData.count + '건</strong>, 고유 종목 ' + hGroupData.uniqueStocks + '개가 발견되었습니다.<br>' +
    '진입 후 10일 뒤 평균 수익률은 <strong>' + f(hGroupData.avgEntryD10Return) + '</strong>, 중간 수익률은 <strong>' + f(hGroupData.medianEntryD10Return) + '</strong>였습니다.<br>' +
    '10일 뒤 플러스 마감 비율은 <strong>' + p(hGroupData.posRateD10) + '</strong>였고, 10일 안에 한 번이라도 +20% 이상 오른 비율은 <strong>' + p(hGroupData.mfe10Hit20Rate) + '</strong>였습니다.<br>' +
    '반대로 10일 안 최대 하락률 평균은 <strong>' + f(hGroupData.avgEntryMAE10) + '</strong>였으며, -10% 이상 크게 밀린 비율은 <strong>' + p(hGroupData.mae10BelowMinus10Rate) + '</strong>였습니다.';
}

// 그룹 테이블
function fillGroupTable() {
  const tbody = document.getElementById('group-tbody');
  tbody.innerHTML = Object.values(DATA.groups).map(g => {
    return '<tr>' +
      '<td class="txt">' + g.label + '</td>' +
      '<td>' + (g.count ?? '-') + '</td>' +
      '<td>' + (g.entryCount ?? '-') + '</td>' +
      '<td>' + fmtPct(g.avgEntryD5Return, true) + '</td>' +
      '<td>' + fmtPct(g.avgEntryD10Return, true) + '</td>' +
      '<td>' + fmtPct(g.medianEntryD10Return, true) + '</td>' +
      '<td>' + fmtPct(g.avgEntryMFE10, true) + '</td>' +
      '<td>' + fmtPct(g.avgEntryMAE10, true) + '</td>' +
      '<td>' + fmtPct(g.posRateD5) + '</td>' +
      '<td>' + fmtPct(g.posRateD10) + '</td>' +
      '<td>' + fmtPct(g.mfe10Hit15Rate) + '</td>' +
      '<td>' + fmtPct(g.mae10BelowMinus10Rate) + '</td>' +
      '<td>' + (g.stoppedOutRate != null ? fmtPct(g.stoppedOutRate) : '<span class="muted">-</span>') + '</td>' +
      '<td>' + (g.adjustedAvgD10 != null ? fmtPct(g.adjustedAvgD10, true) : '<span class="muted">-</span>') + '</td>' +
      '<td>' + (g.adjustedPosRateD10 != null ? fmtPct(g.adjustedPosRateD10) : '<span class="muted">-</span>') + '</td>' +
      '</tr>';
  }).join('');
}
fillGroupTable();

// 손절 테이블
function fillStopTable() {
  const tbody = document.getElementById('stop-tbody');
  tbody.innerHTML = Object.values(DATA.stopComparison).map(s => {
    return '<tr>' +
      '<td class="txt">' + s.label + '</td>' +
      '<td>' + (s.entryCount ?? '-') + '</td>' +
      '<td>' + (s.stoppedOutRate != null ? fmtPct(s.stoppedOutRate) : '<span class="muted">손절 없음</span>') + '</td>' +
      '<td>' + (s.avgStoppedLoss != null ? fmtPct(s.avgStoppedLoss, true) : '<span class="muted">-</span>') + '</td>' +
      '<td>' + fmtPct(s.adjustedAvgD5 != null ? s.adjustedAvgD5 : s.avgEntryD5Return, true) + '</td>' +
      '<td>' + fmtPct(s.adjustedAvgD10 != null ? s.adjustedAvgD10 : s.avgEntryD10Return, true) + '</td>' +
      '<td>' + fmtPct(s.adjustedAvgMFE10 != null ? s.adjustedAvgMFE10 : s.avgEntryMFE10, true) + '</td>' +
      '<td>' + fmtPct(s.adjustedAvgMAE10 != null ? s.adjustedAvgMAE10 : s.avgEntryMAE10, true) + '</td>' +
      '<td>' + fmtPct(s.adjustedPosRateD10 != null ? s.adjustedPosRateD10 : s.posRateD10) + '</td>' +
      '</tr>';
  }).join('');
}
fillStopTable();

// dedup 비교 테이블
function fillDedupTable() {
  const ds = DATA.dedupSummary;
  document.getElementById('dedup-mode').textContent = ds.mode;
  const row = (label, x) => '<tr>' +
    '<td class="txt">' + label + '</td>' +
    '<td>' + (x.count ?? '-') + '</td>' +
    '<td>' + (x.uniqueStocks ?? '-') + '</td>' +
    '<td>' + fmtPct(x.avgEntryD5Return, true) + '</td>' +
    '<td>' + fmtPct(x.avgEntryD10Return, true) + '</td>' +
    '<td>' + fmtPct(x.medianEntryD10Return, true) + '</td>' +
    '<td>' + fmtPct(x.avgEntryMFE10, true) + '</td>' +
    '<td>' + fmtPct(x.avgEntryMAE10, true) + '</td>' +
    '<td>' + fmtPct(x.posRateD10) + '</td>' +
    '<td>' + fmtPct(x.mfe10Hit10Rate) + '</td>' +
    '<td>' + fmtPct(x.mfe10Hit20Rate) + '</td>' +
    '<td>' + fmtPct(x.mae10BelowMinus5Rate) + '</td>' +
    '<td>' + fmtPct(x.mae10BelowMinus10Rate) + '</td>' +
    '</tr>';
  document.getElementById('dedup-tbody').innerHTML =
    row('기존 신호 기준 (H그룹)', ds.signalBasedH) +
    row('이벤트 기준 (dedup, H그룹)', ds.eventBasedH);
  document.getElementById('dedup-note').innerHTML =
    '→ 중복 제거된 신호: <strong>' + ds.duplicatesRemoved + '건</strong> (' + ds.duplicateRatePct + '%) — ' +
    '같은 (code, vviDate, entryDate)는 진입가/돌파/사후 가격이 동일하므로 진입 메트릭은 대표 QVA 모드와 무관하게 같은 값을 가집니다. ' +
    'count·평균만 변하며, 모드별 결과는 JSON <code>dedupSummary.byMode</code>에서 확인할 수 있습니다.';
}
fillDedupTable();

// TOP 10 / WORST 10
function fillCaseTable(tbodyId, items) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = items.map(d => {
    const stopA = d.stopAtVviHigh?.A_vviLow;
    const stopC = d.stopAtVviHigh?.C_minus5;
    return '<tr>' +
      '<td class="txt">' + fmtDate(d.qvaSignalDate) + '</td>' +
      '<td class="txt">' + fmtDate(d.vviDate) + '</td>' +
      '<td class="txt">' + fmtDate(d.entryDate) + '</td>' +
      '<td class="txt"><span class="' + marketCls(d.market) + '">' + (d.name || '') + '</span> <span class="muted">' + d.code + '</span></td>' +
      '<td>' + fmtNum(d.entryPrice) + '원</td>' +
      '<td>' + fmtRatio(d.vviCloseLocation) + '</td>' +
      '<td>' + fmtPct(d.entryD5Return, true) + '</td>' +
      '<td>' + fmtPct(d.entryD10Return, true) + '</td>' +
      '<td>' + fmtPct(d.entryMFE10, true) + '</td>' +
      '<td>' + fmtPct(d.entryMAE10, true) + '</td>' +
      '<td class="txt">' + fmtStopShort(stopA) + '</td>' +
      '<td class="txt">' + fmtStopShort(stopC) + '</td>' +
      '</tr>';
  }).join('');
}
fillCaseTable('top-tbody', DATA.top10);
fillCaseTable('worst-tbody', DATA.worst10);

// 상세
function badges(d) {
  let b = '';
  if (d.isPreferred) b += '<span class="badge pref">우</span>';
  if (d.vviCloseLocation != null && d.vviCloseLocation >= 0.75) b += '<span class="badge strong">강한종가</span>';
  if (d.entryTriggered1Pct) b += '<span class="badge brk1">+1%돌파</span>';
  else if (d.entryTriggered) b += '<span class="badge brk">돌파</span>';
  if (d.breakoutFail) b += '<span class="badge fail">돌파실패</span>';
  if (d.stopAtVviHigh?.A_vviLow?.stoppedOut) b += '<span class="badge stop">손절A</span>';
  if (d.stopAtVviHigh?.C_minus5?.stoppedOut) b += '<span class="badge stop">손절C</span>';
  if (d.entryD10Return != null) b += '<span class="badge ' + (d.entryD10Return > 0 ? 'win' : 'loss') + '">D10 ' + (d.entryD10Return > 0 ? '+' : '') + d.entryD10Return.toFixed(1) + '%</span>';
  return b;
}

function renderDetails(items) {
  const tbody = document.getElementById('details-tbody');
  tbody.innerHTML = items.map(d => {
    const stopA = d.stopAtVviHigh?.A_vviLow;
    const stopC = d.stopAtVviHigh?.C_minus5;
    const dataAttrs = ' data-name="' + (d.name || '') + '"' +
      ' data-code="' + d.code + '"' +
      ' data-brk="' + (d.entryTriggered ? 1 : 0) + '"' +
      ' data-brk1="' + (d.entryTriggered1Pct ? 1 : 0) + '"' +
      ' data-strong="' + (d.vviCloseLocation != null && d.vviCloseLocation >= 0.75 ? 1 : 0) + '"' +
      ' data-fail="' + (d.breakoutFail ? 1 : 0) + '"' +
      ' data-stoppedA="' + (stopA?.stoppedOut ? 1 : 0) + '"' +
      ' data-stoppedC="' + (stopC?.stoppedOut ? 1 : 0) + '"' +
      ' data-win="' + (d.entryD10Return != null && d.entryD10Return > 0 ? 1 : 0) + '"' +
      ' data-loss="' + (d.entryD10Return != null && d.entryD10Return <= 0 ? 1 : 0) + '"' +
      ' data-pref="' + (d.isPreferred ? 1 : 0) + '"';
    return '<tr' + dataAttrs + '>' +
      '<td class="txt">' + fmtDate(d.qvaSignalDate) + '</td>' +
      '<td class="txt">' + fmtDate(d.vviDate) + '</td>' +
      '<td class="txt">' + fmtDate(d.entryDate) + '</td>' +
      '<td class="txt">' + d.code + '</td>' +
      '<td class="txt"><span class="' + marketCls(d.market) + '">' + (d.name || '') + '</span>' + badges(d) + '</td>' +
      '<td>' + fmtNum(d.vviHigh) + '</td>' +
      '<td>' + fmtNum(d.vviLow) + '</td>' +
      '<td>' + fmtNum(d.vviClose) + '</td>' +
      '<td>' + fmtRatio(d.vviCloseLocation) + '</td>' +
      '<td>' + fmtNum(d.nextHigh) + '</td>' +
      '<td>' + fmtNum(d.nextClose) + '</td>' +
      '<td class="txt">' + (d.entryTriggered ? '<span class="pos">○</span>' : '<span class="muted">×</span>') + '</td>' +
      '<td>' + fmtPct(d.entryD5Return, true) + '</td>' +
      '<td>' + fmtPct(d.entryD10Return, true) + '</td>' +
      '<td>' + fmtPct(d.entryMFE10, true) + '</td>' +
      '<td>' + fmtPct(d.entryMAE10, true) + '</td>' +
      '<td class="txt">' + fmtStopShort(stopA) + '</td>' +
      '<td class="txt">' + fmtStopShort(stopC) + '</td>' +
      '<td class="txt">' + (d.tags || []).join(' · ') + '</td>' +
      '</tr>';
  }).join('');

  // 모바일 카드
  const cards = document.getElementById('details-cards');
  cards.innerHTML = items.map(d => {
    const stopA = d.stopAtVviHigh?.A_vviLow;
    const stopC = d.stopAtVviHigh?.C_minus5;
    const dataAttrs = ' data-name="' + (d.name || '') + '"' +
      ' data-code="' + d.code + '"' +
      ' data-brk="' + (d.entryTriggered ? 1 : 0) + '"' +
      ' data-brk1="' + (d.entryTriggered1Pct ? 1 : 0) + '"' +
      ' data-strong="' + (d.vviCloseLocation != null && d.vviCloseLocation >= 0.75 ? 1 : 0) + '"' +
      ' data-fail="' + (d.breakoutFail ? 1 : 0) + '"' +
      ' data-stoppedA="' + (stopA?.stoppedOut ? 1 : 0) + '"' +
      ' data-stoppedC="' + (stopC?.stoppedOut ? 1 : 0) + '"' +
      ' data-win="' + (d.entryD10Return != null && d.entryD10Return > 0 ? 1 : 0) + '"' +
      ' data-loss="' + (d.entryD10Return != null && d.entryD10Return <= 0 ? 1 : 0) + '"' +
      ' data-pref="' + (d.isPreferred ? 1 : 0) + '"';
    return '<div class="card"' + dataAttrs + '>' +
      '<div class="card-head">' +
        '<span class="name ' + marketCls(d.market) + '">' + (d.name || '') + '</span>' +
        badges(d) +
        '<span class="meta">' + d.market + ' · ' + d.code + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<span class="lbl">QVA / VVI / 진입</span><span class="val">' + fmtDate(d.qvaSignalDate) + ' → ' + fmtDate(d.vviDate) + ' → ' + fmtDate(d.entryDate) + '</span>' +
        '<span class="lbl">VVI H/L/C · 종가위치</span><span class="val">' + fmtNum(d.vviHigh) + '/' + fmtNum(d.vviLow) + '/' + fmtNum(d.vviClose) + ' · ' + fmtRatio(d.vviCloseLocation) + '</span>' +
        '<span class="lbl">다음 고가 / 종가</span><span class="val">' + fmtNum(d.nextHigh) + ' / ' + fmtNum(d.nextClose) + '</span>' +
        '<span class="lbl">진입가</span><span class="val">' + fmtNum(d.entryPrice) + '원' + (d.entryTriggered ? '' : ' <span class="muted">(미발생)</span>') + '</span>' +
        '<span class="lbl">D5 / D10</span><span class="val">' + fmtPct(d.entryD5Return, true) + ' / ' + fmtPct(d.entryD10Return, true) + '</span>' +
        '<span class="lbl">MFE10 / MAE10</span><span class="val">' + fmtPct(d.entryMFE10, true) + ' / ' + fmtPct(d.entryMAE10, true) + '</span>' +
        '<span class="lbl">손절 A (VVI 저가)</span><span class="val">' + fmtStopShort(stopA) + '</span>' +
        '<span class="lbl">손절 C (-5%)</span><span class="val">' + fmtStopShort(stopC) + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}
renderDetails(DATA.details);

// 검색/필터
const filterInput = document.getElementById('filter');
const catFilter = document.getElementById('cat-filter');
function applyFilter() {
  const q = filterInput.value.trim().toLowerCase();
  const cat = catFilter.value;
  document.querySelectorAll('#details-tbody tr, #details-cards .card').forEach(el => {
    const name = (el.dataset.name || '').toLowerCase();
    const code = (el.dataset.code || '').toLowerCase();
    const matchQ = !q || name.includes(q) || code.includes(q);
    let matchC = true;
    if (cat === 'brk') matchC = el.dataset.brk === '1';
    else if (cat === 'brk1') matchC = el.dataset.brk1 === '1';
    else if (cat === 'strong') matchC = el.dataset.strong === '1';
    else if (cat === 'fail') matchC = el.dataset.fail === '1';
    else if (cat === 'stoppedA') matchC = el.dataset.stoppedA === '1';
    else if (cat === 'stoppedC') matchC = el.dataset.stoppedC === '1';
    else if (cat === 'win') matchC = el.dataset.win === '1';
    else if (cat === 'loss') matchC = el.dataset.loss === '1';
    else if (cat === 'pref') matchC = el.dataset.pref === '1';
    el.style.display = matchQ && matchC ? '' : 'none';
  });
}
filterInput.addEventListener('input', applyFilter);
catFilter.addEventListener('change', applyFilter);
</script>
</body>
</html>
`;

const html = htmlTemplate.replace('__JSON_DATA__', JSON.stringify(jsonOut));
fs.writeFileSync(path.join(ROOT, 'qva-vvi-breakout-entry-report.html'), html, 'utf-8');
console.log(`✅ HTML 저장: qva-vvi-breakout-entry-report.html  (Express /qva-vvi-breakout-entry-report 라우트로 접근)\n`);
