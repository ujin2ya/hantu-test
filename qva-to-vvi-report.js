/**
 * QVA → VVI 전환 검증 보고서
 *
 * QVA(Quiet Volume Anomaly)는 "누군가 들어오기 시작한 흔적"을 찾는 관심종목 후보
 * 압축 모델이고, VVI(Volume Value Ignition)는 "실제 거래대금 초동이 터진" 확인 신호다.
 *
 * 본 보고서는 다음 질문에 답한다:
 *   "QVA 이후 VVI로 이어진 종목은 QVA만 발생한 종목보다 실제 매수 검토 후보로 더 유리한가?"
 *
 * 흐름:
 *   1단계: QVA 발생 → 관심종목 등록
 *   2단계: QVA 이후 20거래일 추적
 *   3단계: VVI 발생 → 거래대금 초동 확인
 *   4단계: VVI 다음 거래일 고가 돌파 확인 → 진입 후보 검토
 *   5단계: 이후 D3/D5/D10/MFE/MAE 성과 추적
 *
 * 본 보고서는 매수 추천 보고서가 아니다. QVA 후보 중 거래대금 초동 확인까지 이어진
 * 종목의 품질을 검증하기 위한 분석 도구다.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

// 추적 윈도우
const QVA_TRACKING_DAYS = 20;        // QVA 이후 VVI를 찾는 최대 거래일
const AFTER_VVI_TRACKING_DAYS = 10;  // VVI 이후 D1~D10 성과 추적

// QVA 신호일 스캔 범위 — 데이터 시작(60일 사전 히스토리 필요) 이후 ~ 데이터 끝-30거래일
// 충분한 사후 추적(QVA 후 20일 + VVI 후 10일 = 30일)을 보장한다.
// seed-historical-pykrx.py로 약 16개월치 데이터(20250102~20260430) 시드 후 1년 윈도우로 운용.
// 데이터 부족한 종목(60일 미만 사전 데이터)은 QVA 검출에서 자연 reject.
const SCAN_START = '20250401';
const SCAN_END = '20260319';

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

// ─────────── QVA 신호 검출 (qva-surge-day-report.js와 동일 로직, idx 기반) ───────────
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

// ─────────── 메인 ───────────
const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));

console.log(`\n📊 QVA → VVI 전환 검증 보고서`);
console.log(`스캔 기간: ${formatDate(SCAN_START)} ~ ${formatDate(SCAN_END)}`);
console.log(`QVA 추적: D+1 ~ D+${QVA_TRACKING_DAYS} 안에 VVI 발생 여부`);
console.log(`VVI 이후: D+1 ~ D+${AFTER_VVI_TRACKING_DAYS} 성과 + MFE/MAE`);
console.log(`종목 수: ${files.length}\n`);

const allRecords = [];
const excludedRecords = [];
const t0 = Date.now();
let scanned = 0;

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

  let flow;
  try { flow = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, files[fi]), 'utf-8')); }
  catch (_) { flow = { rows: [] }; }
  const flowRows = flow.rows || [];

  const isExcluded = isExcludedProduct(chart.name || meta.name);
  const namedMeta = { ...meta, name: meta.name || chart.name };

  for (let t = 60; t < rows.length - 1; t++) {
    const today = rows[t];
    if (today.date < SCAN_START || today.date > SCAN_END) continue;
    scanned++;
    if (!checkQVASignalAtIdx(rows, t)) continue;

    const qvaDate = today.date;
    const qvaSignalPrice = today.close;
    const qvaSignalTradingValue = today.valueApprox || today.close * today.volume;

    // QVA 이후 20거래일 안에 첫 VVI 신호 탐색
    const maxLookAhead = Math.min(QVA_TRACKING_DAYS, rows.length - 1 - t);
    let vviIdx = null;
    let vviInfo = null;

    // VVI는 ETF/특수종목/시총<500억 등을 자체 reject 하므로 isExcluded여도 호출 자체는 안전.
    // 다만 isExcluded는 본 보고서 본문 분석에서 분리한다.
    for (let k = 1; k <= maxLookAhead; k++) {
      const cand = t + k;
      const candDate = rows[cand].date;
      const slicedChart = rows.slice(0, cand + 1);
      const slicedFlow = flowRows.filter(r => r.date <= candDate);
      if (slicedFlow.length < 10) continue;
      let vvi = null;
      try { vvi = ps.calculateVolumeValueIgnition(slicedChart, slicedFlow, namedMeta); }
      catch (_) { vvi = null; }
      if (vvi?.passed) { vviIdx = cand; vviInfo = vvi; break; }
    }

    // QVA → VVI 전 구간 (VVI 발생 시: D+1 ~ VVI 직전 / 미발생 시: D+1 ~ D+20)
    const beforeEnd = vviIdx != null ? vviIdx : t + maxLookAhead + 1;
    const beforeRows = rows.slice(t + 1, beforeEnd);

    let minLowBeforeVvi = qvaSignalPrice;
    let maxHighBeforeVvi = qvaSignalPrice;
    let minCloseBeforeVvi = qvaSignalPrice;
    let maxCloseBeforeVvi = qvaSignalPrice;
    for (const r of beforeRows) {
      if (r.low > 0 && r.low < minLowBeforeVvi) minLowBeforeVvi = r.low;
      if (r.high > maxHighBeforeVvi) maxHighBeforeVvi = r.high;
      if (r.close > 0 && r.close < minCloseBeforeVvi) minCloseBeforeVvi = r.close;
      if (r.close > maxCloseBeforeVvi) maxCloseBeforeVvi = r.close;
    }
    const maxDropBeforeVvi = (minLowBeforeVvi / qvaSignalPrice - 1) * 100;
    const maxCloseDropBeforeVvi = (minCloseBeforeVvi / qvaSignalPrice - 1) * 100;
    const preVviMaxReturn = (maxHighBeforeVvi / qvaSignalPrice - 1) * 100;

    const entry = {
      code,
      name: chart.name || meta.name,
      market: meta.market,
      isExcludedProduct: isExcluded,
      isPreferred: isPreferredStock(chart.name || meta.name),
      qvaSignalDate: qvaDate,
      qvaSignalPrice,
      qvaSignalClose: qvaSignalPrice,
      qvaSignalTradingValue,

      qvaToVvi: vviIdx != null,
      vviDate: null,
      daysToVvi: null,
      qvaToVviReturn: null,

      minLowBeforeVvi,
      minCloseBeforeVvi,
      maxHighBeforeVvi,
      maxCloseBeforeVvi,
      preVviMaxReturn,
      maxDropBeforeVvi,
      maxCloseDropBeforeVvi,

      // VVI 당일 (전환된 경우만 채움)
      vviOpen: null, vviHigh: null, vviLow: null, vviClose: null,
      vviVolume: null, vviTradingValue: null, vviTradingValueRatio: null,
      vviReturnFromPrevClose: null, vviReturnFromQvaSignal: null,
      vviCloseLocation: null,

      // 다음날 돌파
      nextOpen: null, nextHigh: null, nextLow: null, nextClose: null,
      nextTradingValue: null,
      nextDayBreakout: null, nextDayBreakoutPct: null,
      nextDayBreakout1Pct: null, nextDayCloseReturn: null,

      // VVI 이후 성과
      afterVviD1Return: null, afterVviD3Return: null,
      afterVviD5Return: null, afterVviD10Return: null,
      afterVviMFE3: null, afterVviMFE5: null, afterVviMFE10: null,
      afterVviMAE3: null, afterVviMAE5: null, afterVviMAE10: null,

      tags: [],
    };

    if (vviIdx != null) {
      const vviRow = rows[vviIdx];
      const prevRow = rows[vviIdx - 1];
      const range = vviRow.high - vviRow.low;
      const closeLocation = range > 0 ? (vviRow.close - vviRow.low) / range : null;

      const vviPreStart = Math.max(0, vviIdx - 20);
      const vviPreRows = rows.slice(vviPreStart, vviIdx);
      const avg20Val = vviPreRows.length > 0
        ? vviPreRows.reduce((s, r) => s + (r.valueApprox || 0), 0) / vviPreRows.length
        : 0;
      const tradingValue = vviRow.valueApprox || vviRow.close * vviRow.volume;
      const tradingValueRatio = avg20Val > 0 ? tradingValue / avg20Val : null;

      entry.vviDate = vviRow.date;
      entry.daysToVvi = vviIdx - t;
      entry.qvaToVviReturn = (vviRow.close / qvaSignalPrice - 1) * 100;

      entry.vviOpen = vviRow.open;
      entry.vviHigh = vviRow.high;
      entry.vviLow = vviRow.low;
      entry.vviClose = vviRow.close;
      entry.vviVolume = vviRow.volume;
      entry.vviTradingValue = tradingValue;
      entry.vviTradingValueRatio = tradingValueRatio;
      entry.vviReturnFromPrevClose = prevRow && prevRow.close > 0
        ? (vviRow.close / prevRow.close - 1) * 100 : null;
      entry.vviReturnFromQvaSignal = entry.qvaToVviReturn;
      entry.vviCloseLocation = closeLocation;

      // 다음 거래일 고가 돌파
      const nextIdx = vviIdx + 1;
      if (nextIdx < rows.length) {
        const next = rows[nextIdx];
        entry.nextOpen = next.open;
        entry.nextHigh = next.high;
        entry.nextLow = next.low;
        entry.nextClose = next.close;
        entry.nextTradingValue = next.valueApprox || next.close * next.volume;
        entry.nextDayBreakout = next.high > vviRow.high;
        entry.nextDayBreakoutPct = vviRow.high > 0
          ? (next.high / vviRow.high - 1) * 100 : null;
        entry.nextDayBreakout1Pct = next.high >= vviRow.high * 1.01;
        entry.nextDayCloseReturn = vviRow.close > 0
          ? (next.close / vviRow.close - 1) * 100 : null;
      }

      // VVI 이후 D1/D3/D5/D10 + MFE/MAE
      const fwdReturn = (n) => {
        const idx = vviIdx + n;
        if (idx >= rows.length || vviRow.close <= 0) return null;
        return (rows[idx].close / vviRow.close - 1) * 100;
      };
      entry.afterVviD1Return = fwdReturn(1);
      entry.afterVviD3Return = fwdReturn(3);
      entry.afterVviD5Return = fwdReturn(5);
      entry.afterVviD10Return = fwdReturn(10);

      const fwdMfeMae = (n) => {
        let mfe = null, mae = null;
        for (let k = 1; k <= n && vviIdx + k < rows.length; k++) {
          const r = rows[vviIdx + k];
          if (vviRow.close <= 0) break;
          const upPct = (r.high / vviRow.close - 1) * 100;
          const downPct = (r.low / vviRow.close - 1) * 100;
          if (mfe == null || upPct > mfe) mfe = upPct;
          if (mae == null || downPct < mae) mae = downPct;
        }
        return { mfe, mae };
      };
      const m3 = fwdMfeMae(3), m5 = fwdMfeMae(5), m10 = fwdMfeMae(10);
      entry.afterVviMFE3 = m3.mfe; entry.afterVviMAE3 = m3.mae;
      entry.afterVviMFE5 = m5.mfe; entry.afterVviMAE5 = m5.mae;
      entry.afterVviMFE10 = m10.mfe; entry.afterVviMAE10 = m10.mae;

      // 태그
      if (entry.maxDropBeforeVvi >= -10) entry.tags.push('DROP_WITHIN_10');
      else if (entry.maxDropBeforeVvi >= -15) entry.tags.push('DROP_WITHIN_15');
      else if (entry.maxDropBeforeVvi >= -20) entry.tags.push('DROP_WITHIN_20');
      if (vviRow.close >= qvaSignalPrice) entry.tags.push('ABOVE_SIGNAL_PRICE');
      else if (vviRow.close >= qvaSignalPrice * 0.97) entry.tags.push('NEAR_SIGNAL_PRICE');
      if (closeLocation != null && closeLocation >= 0.75) entry.tags.push('VERY_STRONG_CLOSE');
      else if (closeLocation != null && closeLocation >= 0.6) entry.tags.push('STRONG_CLOSE');
      if (entry.nextDayBreakout1Pct) entry.tags.push('NEXT_BREAKOUT_1PCT');
      else if (entry.nextDayBreakout) entry.tags.push('NEXT_BREAKOUT');
    }

    if (isExcluded) excludedRecords.push(entry);
    else allRecords.push(entry);
  }
}

console.log(`\n→ scanned=${scanned}, allRecords=${allRecords.length}, excluded=${excludedRecords.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// ─────────── 그룹별 집계 ───────────
function aggregate(items) {
  const out = {
    count: items.length,
    uniqueStocks: new Set(items.map(i => i.code)).size,
  };
  if (items.length === 0) return out;

  const vviItems = items.filter(i => i.qvaToVvi);
  const vviPick = (k) => vviItems.map(i => i[k]).filter(v => v != null && Number.isFinite(v));

  out.qvaToVviCount = vviItems.length;
  out.qvaToVviRate = round2(rate(vviItems.length, items.length));

  const daysToVvi = vviPick('daysToVvi');
  out.avgDaysToVvi = round2(avg(daysToVvi));
  out.medianDaysToVvi = round2(median(daysToVvi));

  const qvaToVviReturn = vviPick('qvaToVviReturn');
  out.avgQvaToVviReturn = round2(avg(qvaToVviReturn));
  out.medianQvaToVviReturn = round2(median(qvaToVviReturn));

  const maxDrop = vviPick('maxDropBeforeVvi');
  out.avgMaxDropBeforeVvi = round2(avg(maxDrop));
  out.medianMaxDropBeforeVvi = round2(median(maxDrop));

  const closeLoc = vviPick('vviCloseLocation');
  out.avgVviCloseLocation = round2(avg(closeLoc));

  const breakoutBase = vviItems.filter(i => i.nextDayBreakout != null);
  out.nextDayBreakoutRate = round2(rate(breakoutBase.filter(i => i.nextDayBreakout).length, breakoutBase.length));
  out.nextDayBreakout1PctRate = round2(rate(breakoutBase.filter(i => i.nextDayBreakout1Pct).length, breakoutBase.length));

  const d3 = vviPick('afterVviD3Return');
  const d5 = vviPick('afterVviD5Return');
  const d10 = vviPick('afterVviD10Return');
  out.avgAfterVviD3Return = round2(avg(d3));
  out.avgAfterVviD5Return = round2(avg(d5));
  out.avgAfterVviD10Return = round2(avg(d10));

  out.avgAfterVviMFE5 = round2(avg(vviPick('afterVviMFE5')));
  out.avgAfterVviMFE10 = round2(avg(vviPick('afterVviMFE10')));
  out.avgAfterVviMAE5 = round2(avg(vviPick('afterVviMAE5')));
  out.avgAfterVviMAE10 = round2(avg(vviPick('afterVviMAE10')));

  out.winRateD5 = round2(rate(d5.filter(v => v > 0).length, d5.length));
  out.winRateD10 = round2(rate(d10.filter(v => v > 0).length, d10.length));

  const mfe10 = vviPick('afterVviMFE10');
  out.mfe10Hit10Rate = round2(rate(mfe10.filter(v => v >= 10).length, mfe10.length));
  out.mfe10Hit15Rate = round2(rate(mfe10.filter(v => v >= 15).length, mfe10.length));
  out.mfe10Hit20Rate = round2(rate(mfe10.filter(v => v >= 20).length, mfe10.length));

  const mae10 = vviPick('afterVviMAE10');
  out.mae10BelowMinus5Rate = round2(rate(mae10.filter(v => v <= -5).length, mae10.length));
  out.mae10BelowMinus10Rate = round2(rate(mae10.filter(v => v <= -10).length, mae10.length));

  return out;
}

// ─────────── 그룹 정의 ───────────
const groupDefs = {
  allQva: { label: '전체 QVA 신호', filter: (i) => true },
  qvaOnly: { label: 'QVA 단독 (VVI 미발생)', filter: (i) => !i.qvaToVvi },
  qvaToVvi: { label: 'QVA → VVI 전환', filter: (i) => i.qvaToVvi },
  qvaToVviDrop15: {
    label: 'QVA→VVI · 낙폭 -15% 이내',
    filter: (i) => i.qvaToVvi && i.maxDropBeforeVvi >= -15,
  },
  qvaToVviNearSignal: {
    label: 'QVA→VVI · 낙폭 -15% + VVI종가 ≥ 신호가×0.97',
    filter: (i) => i.qvaToVvi && i.maxDropBeforeVvi >= -15
      && i.vviClose != null && i.vviClose >= i.qvaSignalPrice * 0.97,
  },
  qvaToVviStrongClose: {
    label: 'QVA→VVI · 낙폭 -15% + VVI종가 ≥ 신호가 + 종가위치 ≥ 0.6',
    filter: (i) => i.qvaToVvi && i.maxDropBeforeVvi >= -15
      && i.vviClose != null && i.vviClose >= i.qvaSignalPrice
      && i.vviCloseLocation != null && i.vviCloseLocation >= 0.6,
  },
  qvaToVviBreakout: {
    label: 'QVA→VVI · 낙폭 -15% + 종가위치 ≥ 0.6 + 다음날 고가 돌파',
    filter: (i) => i.qvaToVvi && i.maxDropBeforeVvi >= -15
      && i.vviCloseLocation != null && i.vviCloseLocation >= 0.6
      && i.nextDayBreakout === true,
  },
  qvaToVviStrongBreakout: {
    label: 'QVA→VVI · 낙폭 -15% + 종가위치 ≥ 0.75 + 다음날 +1% 돌파',
    filter: (i) => i.qvaToVvi && i.maxDropBeforeVvi >= -15
      && i.vviCloseLocation != null && i.vviCloseLocation >= 0.75
      && i.nextDayBreakout1Pct === true,
  },
};

const groups = {};
for (const [key, def] of Object.entries(groupDefs)) {
  const items = allRecords.filter(def.filter);
  groups[key] = { label: def.label, ...aggregate(items) };
}

// ─────────── 요약 ───────────
const totalQvaSignals = allRecords.length;
const uniqueQvaStocks = new Set(allRecords.map(i => i.code)).size;
const qvaToVviRecords = allRecords.filter(i => i.qvaToVvi);
const qvaToVviCount = qvaToVviRecords.length;
const qvaOnlyCount = totalQvaSignals - qvaToVviCount;
const daysToVviAll = qvaToVviRecords.map(i => i.daysToVvi).filter(Number.isFinite);

const summary = {
  totalQvaSignals,
  uniqueQvaStocks,
  qvaToVviCount,
  qvaToVviRate: round2(rate(qvaToVviCount, totalQvaSignals)),
  avgDaysToVvi: round2(avg(daysToVviAll)),
  medianDaysToVvi: round2(median(daysToVviAll)),
  qvaOnlyCount,
  qvaOnlyRate: round2(rate(qvaOnlyCount, totalQvaSignals)),
  excludedProductsCount: excludedRecords.length,
};

// ─────────── 콘솔 출력 ───────────
console.log(`\n${'='.repeat(120)}`);
console.log(`📊 요약`);
console.log(`전체 QVA 신호: ${totalQvaSignals}건 · 고유 종목 ${uniqueQvaStocks}개`);
console.log(`QVA→VVI 전환: ${qvaToVviCount}건 (${summary.qvaToVviRate}%) · 평균 ${summary.avgDaysToVvi}일 · 중간값 ${summary.medianDaysToVvi}일`);
console.log(`QVA 단독:     ${qvaOnlyCount}건 (${summary.qvaOnlyRate}%)`);
console.log(`분석 제외 상품(ETF/ETN/...): ${excludedRecords.length}건\n`);

console.log(`그룹별 비교 (count · D5 평균 · D10 평균 · MFE10 · MAE10 · D5+ 비율 · D10+ 비율 · 다음날돌파)`);
const fmtNum = (v) => v == null ? '   -  ' : (v >= 0 ? '+' : '') + v.toFixed(2).padStart(6);
const fmtPct = (v) => v == null ? '   -  ' : v.toFixed(1).padStart(5) + '%';
for (const [key, g] of Object.entries(groups)) {
  console.log(
    `  ${(g.label).padEnd(60)} | n=${String(g.count).padStart(4)} | ` +
    `D5 ${fmtNum(g.avgAfterVviD5Return)} · D10 ${fmtNum(g.avgAfterVviD10Return)} · ` +
    `MFE10 ${fmtNum(g.avgAfterVviMFE10)} · MAE10 ${fmtNum(g.avgAfterVviMAE10)} | ` +
    `D5+ ${fmtPct(g.winRateD5)} · D10+ ${fmtPct(g.winRateD10)} · 돌파 ${fmtPct(g.nextDayBreakoutRate)}`
  );
}

// ─────────── JSON / HTML 출력 ───────────
const detailSerializer = (e) => ({
  code: e.code,
  name: e.name,
  market: e.market,
  isPreferred: e.isPreferred,
  isExcludedProduct: e.isExcludedProduct,
  qvaSignalDate: e.qvaSignalDate,
  qvaSignalPrice: e.qvaSignalPrice,
  qvaSignalClose: e.qvaSignalClose,
  qvaSignalTradingValue: Math.round(e.qvaSignalTradingValue || 0),
  qvaToVvi: e.qvaToVvi,
  vviDate: e.vviDate,
  daysToVvi: e.daysToVvi,
  qvaToVviReturn: round2(e.qvaToVviReturn),
  minLowBeforeVvi: e.minLowBeforeVvi,
  minCloseBeforeVvi: e.minCloseBeforeVvi,
  maxHighBeforeVvi: e.maxHighBeforeVvi,
  maxCloseBeforeVvi: e.maxCloseBeforeVvi,
  preVviMaxReturn: round2(e.preVviMaxReturn),
  maxDropBeforeVvi: round2(e.maxDropBeforeVvi),
  maxCloseDropBeforeVvi: round2(e.maxCloseDropBeforeVvi),
  vviOpen: e.vviOpen, vviHigh: e.vviHigh, vviLow: e.vviLow, vviClose: e.vviClose,
  vviVolume: e.vviVolume,
  vviTradingValue: e.vviTradingValue ? Math.round(e.vviTradingValue) : null,
  vviTradingValueRatio: round2(e.vviTradingValueRatio),
  vviReturnFromPrevClose: round2(e.vviReturnFromPrevClose),
  vviReturnFromQvaSignal: round2(e.vviReturnFromQvaSignal),
  vviCloseLocation: round2(e.vviCloseLocation),
  nextOpen: e.nextOpen, nextHigh: e.nextHigh, nextLow: e.nextLow, nextClose: e.nextClose,
  nextTradingValue: e.nextTradingValue ? Math.round(e.nextTradingValue) : null,
  nextDayBreakout: e.nextDayBreakout,
  nextDayBreakoutPct: round2(e.nextDayBreakoutPct),
  nextDayBreakout1Pct: e.nextDayBreakout1Pct,
  nextDayCloseReturn: round2(e.nextDayCloseReturn),
  afterVviD1Return: round2(e.afterVviD1Return),
  afterVviD3Return: round2(e.afterVviD3Return),
  afterVviD5Return: round2(e.afterVviD5Return),
  afterVviD10Return: round2(e.afterVviD10Return),
  afterVviMFE3: round2(e.afterVviMFE3),
  afterVviMFE5: round2(e.afterVviMFE5),
  afterVviMFE10: round2(e.afterVviMFE10),
  afterVviMAE3: round2(e.afterVviMAE3),
  afterVviMAE5: round2(e.afterVviMAE5),
  afterVviMAE10: round2(e.afterVviMAE10),
  tags: e.tags,
});

const sortedDetails = allRecords
  .slice()
  .sort((a, b) => {
    if (a.qvaToVvi !== b.qvaToVvi) return a.qvaToVvi ? -1 : 1;
    const aRet = a.afterVviD10Return ?? -Infinity;
    const bRet = b.afterVviD10Return ?? -Infinity;
    if (bRet !== aRet) return bRet - aRet;
    return a.qvaSignalDate.localeCompare(b.qvaSignalDate);
  });

const jsonOut = {
  meta: {
    purpose: 'QVA 신호 이후 20거래일 안에 VVI로 전환된 종목의 성과 검증',
    qvaDefinition: '누군가 들어오기 시작한 흔적을 찾는 20거래일 추적 후보 (관심종목 후보 압축)',
    vviDefinition: '실제 거래대금 초동이 터진 확인 후보 (수급 확인)',
    notice: 'QVA는 매수 추천 신호가 아니다. VVI는 거래대금 초동 확인 신호이고, 다음날 고가 돌파는 진입 후보 검토 신호다.',
    trackingDays: QVA_TRACKING_DAYS,
    afterVviTrackingDays: AFTER_VVI_TRACKING_DAYS,
    scanStart: SCAN_START,
    scanEnd: SCAN_END,
    excludeKeywords: EXCLUDE_KEYWORDS,
    generatedAt: new Date().toISOString(),
  },
  summary,
  groups,
  details: sortedDetails.map(detailSerializer),
  excludedDetails: excludedRecords.slice().sort((a, b) => a.qvaSignalDate.localeCompare(b.qvaSignalDate)).map(detailSerializer),
};

fs.writeFileSync(
  path.join(ROOT, 'qva-to-vvi-report.json'),
  JSON.stringify(jsonOut, null, 2),
  'utf-8'
);
console.log(`\n✅ JSON 저장: qva-to-vvi-report.json`);

// ─────────── HTML 출력 ───────────
const htmlTemplate = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QVA → VVI 전환 검증 보고서</title>
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
  .stat-value .pct { color: #10b981; font-size: 13px; font-weight: 400; margin-left: 6px; }
  .stat.qva { border-left: 3px solid #60a5fa; }
  .stat.vvi { border-left: 3px solid #10b981; }
  .stat.only { border-left: 3px solid #94a3b8; }

  .note { color: #94a3b8; font-size: 12px; padding: 4px 4px; line-height: 1.6; margin-bottom: 6px; }
  .note strong { color: #cbd5e1; }
  .note.warn { color: #fcd34d; background: #1e293b; padding: 10px 14px; border-radius: 6px; border-left: 3px solid #f59e0b; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #334155; white-space: nowrap; }
  th:first-child, td:first-child, th.txt, td.txt { text-align: left; }
  th { background: #283447; color: #cbd5e1; font-weight: 600; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 1; }
  th:hover { background: #334155; }
  th .help, td .help { display: inline-block; margin-left: 4px; color: #60a5fa; cursor: help; font-size: 10px; }
  th.sorted-asc::after { content: " ▲"; color: #60a5fa; }
  th.sorted-desc::after { content: " ▼"; color: #60a5fa; }
  tr:hover { background: #283447; }

  .group-table-wrap, .details-table-wrap { background: #1e293b; padding: 8px; border-radius: 8px; margin-bottom: 14px; overflow-x: auto; }

  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-left: 2px; }
  .badge.vvi { background: #064e3b; color: #6ee7b7; }
  .badge.only { background: #374151; color: #9ca3af; }
  .badge.brk { background: #1e3a8a; color: #93c5fd; }
  .badge.brk1 { background: #1e40af; color: #bfdbfe; }
  .badge.strong { background: #14532d; color: #86efac; }
  .badge.vstrong { background: #166534; color: #bbf7d0; }
  .badge.near { background: #422006; color: #fbbf24; }
  .badge.above { background: #14532d; color: #86efac; }
  .badge.drop10 { background: #4c1d95; color: #c4b5fd; }
  .badge.drop15 { background: #581c87; color: #d8b4fe; }
  .badge.drop20 { background: #6b21a8; color: #e9d5ff; }
  .badge.pref { background: #1e3a8a; color: #93c5fd; }
  .pos { color: #10b981; }
  .neg { color: #f87171; }
  .muted { color: #64748b; }
  .market-K { color: #60a5fa; }
  .market-Q { color: #c084fc; }
  .empty { padding: 18px; color: #64748b; text-align: center; font-size: 13px; }

  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .controls input[type=text] { flex: 1; min-width: 200px; padding: 8px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 13px; }
  .controls select { padding: 8px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 13px; }

  /* 모바일 카드 */
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
    h2 { font-size: 15px; margin-top: 24px; }
    h3 { font-size: 13px; }
    .subtitle { font-size: 11px; }
    .summary { padding: 12px; }
    .stat-value { font-size: 15px; }
    .stat-label { font-size: 10px; }
    .info-box p { font-size: 12px; }
    .group-table-wrap table, .details-table-wrap table { font-size: 11px; }
    .group-table-wrap th, .group-table-wrap td, .details-table-wrap th, .details-table-wrap td { padding: 6px 6px; }
  }

  @media (max-width: 640px) {
    .details-table-wrap table { display: none; }
    .details-table-wrap .cards { display: block; }
  }
</style>
</head>
<body>
  <h1>📊 QVA → VVI 전환 검증 보고서<span class="sub">— QVA 후보 중 실제 거래대금 초동으로 이어진 종목 분석</span></h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="nav" style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
    <a href="/qva-watchlist" style="color:#93c5fd;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e293b;border-radius:6px;">📋 매일 운영 보드</a>
    <span style="color:#475569;font-size:11px;align-self:center;">검증 ▶</span>
    <a href="/qva-to-vvi-report" style="color:#fff;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e3a8a;border-radius:6px;">QVA → VVI 전환</a>
    <a href="/qva-vvi-breakout-entry-report" style="color:#93c5fd;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e293b;border-radius:6px;">진입</a>
    <a href="/qva-vvi-breakout-exit-report" style="color:#93c5fd;text-decoration:none;font-size:13px;padding:6px 10px;background:#1e293b;border-radius:6px;">익절/청산</a>
  </div>

  <div class="note" style="color:#94a3b8;font-size:12px;margin-bottom:6px;">📚 <strong style="color:#cbd5e1;">검증 보고서</strong> — 매일 운영 화면이 아닌 과거 데이터 분석. 매일 보드는 <a href="/qva-watchlist" style="color:#93c5fd;">📋 매일 운영 보드</a>로 이동하세요.</div>

  <div class="info-box">
    <p>이 보고서는 <strong>QVA 신호가 나온 종목 중 ${QVA_TRACKING_DAYS}거래일 안에 VVI로 이어진 종목</strong>을 찾고, VVI 발생 시점 이후의 성과를 분석합니다.</p>
    <p>QVA는 매수 추천 신호가 아니라 <strong>관심종목 후보를 좁히는 선행 감지 모델</strong>이고, VVI는 <strong>실제 거래대금 초동이 터진 확인 신호</strong>입니다.</p>
    <p>따라서 이 보고서는 <strong>"QVA 후보 중 VVI 확인까지 이어진 종목이 더 좋은 매수 검토 후보가 되는가"</strong>를 검증하기 위한 보고서입니다.</p>
  </div>

  <h3>전체 요약</h3>
  <div class="summary">
    <div class="summary-grid" id="summary-grid"></div>
  </div>

  <div class="note">
    <strong>집계 단위:</strong> 본 보고서는 종목 수가 아니라 <strong>QVA 신호 발생 건수</strong> 기준으로 집계합니다. 동일 종목이 여러 신호일에 반복 등장할 수 있어 고유 종목 수는 별도 표기합니다.
  </div>
  <div class="note">
    <strong>분석 제외 상품:</strong> 종목명에 ETN/ETF/레버리지/인버스/선물/TR/H) 키워드가 포함된 상품은 본문 분석에서 분리합니다.
  </div>

  <h2>그룹별 비교</h2>
  <div class="note">
    각 그룹별로 신호 수, VVI 도달일, QVA→VVI 시점 수익률, VVI 이후 D3/D5/D10 평균 수익률, MFE10/MAE10, <strong>D5/D10 양수 마감 비율</strong>(승률 아님), 다음날 고가 돌파 비율을 비교합니다.
  </div>
  <div class="group-table-wrap">
    <table id="group-table">
      <thead><tr>
        <th class="txt" data-col="label" data-type="str">그룹</th>
        <th data-col="count" data-type="num">신호 수</th>
        <th data-col="uniqueStocks" data-type="num">고유 종목 수</th>
        <th data-col="avgDaysToVvi" data-type="num">평균 VVI 도달<span class="help" title="QVA 신호 후 VVI까지 평균 거래일 수">ⓘ</span></th>
        <th data-col="avgQvaToVviReturn" data-type="num">QVA → VVI 시점 수익률</th>
        <th data-col="avgAfterVviD5Return" data-type="num">VVI 후 5일 뒤 평균</th>
        <th data-col="avgAfterVviD10Return" data-type="num">VVI 후 10일 뒤 평균</th>
        <th data-col="avgAfterVviMFE10" data-type="num">10일 안 최고 상승<span class="help" title="VVI 발생 후 10거래일 안 장중 최고가 기준 평균 (MFE10)">ⓘ</span></th>
        <th data-col="avgAfterVviMAE10" data-type="num">10일 안 최대 하락<span class="help" title="VVI 발생 후 10거래일 안 장중 저가 기준 평균 (MAE10)">ⓘ</span></th>
        <th data-col="winRateD5" data-type="num">5일 뒤 플러스%</th>
        <th data-col="winRateD10" data-type="num">10일 뒤 플러스%</th>
        <th data-col="nextDayBreakoutRate" data-type="num">다음날 고가 돌파%</th>
      </tr></thead>
      <tbody id="group-tbody"></tbody>
    </table>
  </div>

  <h2>필터 단계별 성과 비교</h2>
  <div class="note">
    조건이 강해질수록 신호 수가 줄어듭니다. 각 단계의 신호 수를 함께 보고 판단해야 합니다.
  </div>
  <div class="group-table-wrap">
    <table id="filter-table">
      <thead><tr>
        <th class="txt" data-col="label" data-type="str">필터 단계</th>
        <th data-col="count" data-type="num">신호 수</th>
        <th data-col="avgQvaToVviReturn" data-type="num">QVA → VVI%</th>
        <th data-col="avgAfterVviD5Return" data-type="num">5일 평균</th>
        <th data-col="avgAfterVviD10Return" data-type="num">10일 평균</th>
        <th data-col="avgAfterVviMFE10" data-type="num">10일 안 최고 상승</th>
        <th data-col="avgAfterVviMAE10" data-type="num">10일 안 최대 하락</th>
        <th data-col="winRateD5" data-type="num">5일 플러스%</th>
        <th data-col="winRateD10" data-type="num">10일 플러스%</th>
        <th data-col="mfe10Hit10Rate" data-type="num">+10% 도달%</th>
        <th data-col="mfe10Hit15Rate" data-type="num">+15% 도달%</th>
      </tr></thead>
      <tbody id="filter-tbody"></tbody>
    </table>
  </div>

  <h2>종목별 상세</h2>
  <div class="controls">
    <input type="text" id="filter" placeholder="종목명 또는 코드 검색…">
    <select id="cat-filter">
      <option value="all">전체</option>
      <option value="vvi">VVI 전환</option>
      <option value="only">QVA 단독</option>
      <option value="drop10">낙폭 -10% 이내</option>
      <option value="drop15">낙폭 -15% 이내</option>
      <option value="strong">VVI 종가위치 ≥ 0.6</option>
      <option value="vstrong">VVI 종가위치 ≥ 0.75</option>
      <option value="brk">다음날 고가 돌파</option>
      <option value="brk1">다음날 +1% 고가 돌파</option>
      <option value="pref">우선주만</option>
    </select>
  </div>
  <div class="details-table-wrap">
    <table id="details-table">
      <thead><tr>
        <th data-col="qvaSignalDate" data-type="str">QVA일</th>
        <th class="txt" data-col="code" data-type="str">코드</th>
        <th class="txt" data-col="name" data-type="str">종목</th>
        <th data-col="qvaSignalPrice" data-type="num">QVA 신호가</th>
        <th data-col="vviDate" data-type="str">VVI일</th>
        <th data-col="daysToVvi" data-type="num">D+</th>
        <th data-col="qvaToVviReturn" data-type="num">QVA→VVI%</th>
        <th data-col="maxDropBeforeVvi" data-type="num">VVI전 최대낙폭%</th>
        <th data-col="vviCloseLocation" data-type="num">종가위치</th>
        <th data-col="vviTradingValue" data-type="num">VVI 거래대금</th>
        <th data-col="nextDayBreakout" data-type="bool">다음날 돌파</th>
        <th data-col="afterVviD5Return" data-type="num">D5%</th>
        <th data-col="afterVviD10Return" data-type="num">D10%</th>
        <th data-col="afterVviMFE10" data-type="num">MFE10</th>
        <th data-col="afterVviMAE10" data-type="num">MAE10</th>
        <th class="txt" data-col="tags" data-type="str">태그</th>
      </tr></thead>
      <tbody id="details-tbody"></tbody>
    </table>
    <div class="cards" id="details-cards"></div>
  </div>

  <div class="note warn">
    ⚠️ 본 화면은 <strong>매수 추천이 아닙니다</strong>. QVA는 관심종목 후보를 좁히는 필터이고, VVI는 거래대금 초동 확인 신호입니다. 실제 매수 여부는 차트, 뉴스, 시장 상황, 리스크 관리를 함께 보고 판단해야 합니다.
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
function fmtValue(v) { return v == null ? '-' : (v / 1e8).toFixed(0) + '억'; }
function fmtPct(n, sign) {
  if (n == null || !Number.isFinite(n)) return '<span class="muted">-</span>';
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : 'muted');
  const s = (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
  return '<span class="' + cls + '">' + s + '</span>';
}
function fmtRatio(n) { return n == null ? '-' : n.toFixed(2); }
function fmtBool(b) {
  if (b === true) return '<span class="pos">○</span>';
  if (b === false) return '<span class="neg">×</span>';
  return '<span class="muted">-</span>';
}
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }

// 헤더 자막
document.getElementById('subtitle').textContent =
  '스캔 ' + fmtDate(DATA.meta.scanStart) + ' ~ ' + fmtDate(DATA.meta.scanEnd) +
  ' · QVA 추적 D+1~D+' + DATA.meta.trackingDays +
  ' · VVI 이후 D+1~D+' + DATA.meta.afterVviTrackingDays +
  ' · 생성: ' + DATA.meta.generatedAt.slice(0, 19).replace('T', ' ');

// 요약 카드
const sum = DATA.summary;
function makeStat(label, val, pct, klass) {
  const cls = 'stat' + (klass ? ' ' + klass : '');
  return '<div class="' + cls + '"><div class="stat-label">' + label + '</div><div class="stat-value">' + val +
    (pct != null ? '<span class="pct">' + pct + '</span>' : '') + '</div></div>';
}
document.getElementById('summary-grid').innerHTML = [
  makeStat('전체 QVA 신호', sum.totalQvaSignals + '건', null, 'qva'),
  makeStat('고유 종목', sum.uniqueQvaStocks + '개', null, 'qva'),
  makeStat('QVA→VVI 전환', sum.qvaToVviCount + '건', sum.qvaToVviRate + '%', 'vvi'),
  makeStat('평균 VVI 도달', 'D+' + (sum.avgDaysToVvi != null ? sum.avgDaysToVvi.toFixed(1) : '-'), null, 'vvi'),
  makeStat('중간 VVI 도달', 'D+' + (sum.medianDaysToVvi != null ? sum.medianDaysToVvi.toFixed(1) : '-'), null, 'vvi'),
  makeStat('QVA 단독', sum.qvaOnlyCount + '건', sum.qvaOnlyRate + '%', 'only'),
  makeStat('분석 제외 상품', sum.excludedProductsCount + '건'),
].join('');

// 그룹 테이블
function fillTable(tbodyId, items, cols) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = items.map(it => '<tr>' + cols.map(c => {
    const v = it[c.key];
    let cell;
    if (c.fmt === 'pct') cell = fmtPct(v, true);
    else if (c.fmt === 'num') cell = v != null ? v.toLocaleString() : '-';
    else if (c.fmt === 'days') cell = v != null ? 'D+' + (typeof v === 'number' ? v.toFixed(1) : v) : '-';
    else cell = v != null ? String(v) : '-';
    return '<td' + (c.txt ? ' class="txt"' : '') + '>' + cell + '</td>';
  }).join('') + '</tr>').join('');
}

const groupRows = Object.entries(DATA.groups).map(([k, g]) => ({ key: k, ...g }));
fillTable('group-tbody', groupRows, [
  { key: 'label', txt: true },
  { key: 'count', fmt: 'num' },
  { key: 'uniqueStocks', fmt: 'num' },
  { key: 'avgDaysToVvi', fmt: 'days' },
  { key: 'avgQvaToVviReturn', fmt: 'pct' },
  { key: 'avgAfterVviD5Return', fmt: 'pct' },
  { key: 'avgAfterVviD10Return', fmt: 'pct' },
  { key: 'avgAfterVviMFE10', fmt: 'pct' },
  { key: 'avgAfterVviMAE10', fmt: 'pct' },
  { key: 'winRateD5', fmt: 'pct' },
  { key: 'winRateD10', fmt: 'pct' },
  { key: 'nextDayBreakoutRate', fmt: 'pct' },
]);

// 필터 단계별 (subset of groups, with stricter filters)
const filterRows = ['qvaToVvi', 'qvaToVviDrop15', 'qvaToVviNearSignal', 'qvaToVviStrongClose', 'qvaToVviBreakout', 'qvaToVviStrongBreakout']
  .map(k => ({ key: k, ...DATA.groups[k] }));
fillTable('filter-tbody', filterRows, [
  { key: 'label', txt: true },
  { key: 'count', fmt: 'num' },
  { key: 'avgQvaToVviReturn', fmt: 'pct' },
  { key: 'avgAfterVviD5Return', fmt: 'pct' },
  { key: 'avgAfterVviD10Return', fmt: 'pct' },
  { key: 'avgAfterVviMFE10', fmt: 'pct' },
  { key: 'avgAfterVviMAE10', fmt: 'pct' },
  { key: 'winRateD5', fmt: 'pct' },
  { key: 'winRateD10', fmt: 'pct' },
  { key: 'mfe10Hit10Rate', fmt: 'pct' },
  { key: 'mfe10Hit15Rate', fmt: 'pct' },
]);

// 상세 테이블
function badges(d) {
  let b = '';
  if (d.isPreferred) b += '<span class="badge pref">우</span>';
  if (d.qvaToVvi) {
    b += '<span class="badge vvi">VVI</span>';
    if (d.maxDropBeforeVvi != null) {
      if (d.maxDropBeforeVvi >= -10) b += '<span class="badge drop10">-10%이내</span>';
      else if (d.maxDropBeforeVvi >= -15) b += '<span class="badge drop15">-15%이내</span>';
      else if (d.maxDropBeforeVvi >= -20) b += '<span class="badge drop20">-20%이내</span>';
    }
    if (d.vviCloseLocation != null) {
      if (d.vviCloseLocation >= 0.75) b += '<span class="badge vstrong">고가권</span>';
      else if (d.vviCloseLocation >= 0.6) b += '<span class="badge strong">상단권</span>';
    }
    if (d.vviClose != null && d.qvaSignalPrice) {
      if (d.vviClose >= d.qvaSignalPrice) b += '<span class="badge above">신호가↑</span>';
      else if (d.vviClose >= d.qvaSignalPrice * 0.97) b += '<span class="badge near">신호가근처</span>';
    }
    if (d.nextDayBreakout1Pct) b += '<span class="badge brk1">+1%돌파</span>';
    else if (d.nextDayBreakout) b += '<span class="badge brk">돌파</span>';
  } else {
    b += '<span class="badge only">단독</span>';
  }
  return b;
}

const COLS_DETAIL = [
  { key: 'qvaSignalDate', label: 'QVA일', type: 'str', render: d => fmtDate(d.qvaSignalDate) },
  { key: 'code', label: '코드', type: 'str', txt: true, render: d => d.code },
  { key: 'name', label: '종목', type: 'str', txt: true, render: d => '<span class="' + marketCls(d.market) + '">' + (d.name || '') + '</span>' + badges(d) },
  { key: 'qvaSignalPrice', label: 'QVA 신호가', type: 'num', render: d => fmtNum(d.qvaSignalPrice) + '원' },
  { key: 'vviDate', label: 'VVI일', type: 'str', render: d => d.vviDate ? fmtDate(d.vviDate) : '<span class="muted">미발생</span>' },
  { key: 'daysToVvi', label: 'D+', type: 'num', render: d => d.daysToVvi != null ? 'D+' + d.daysToVvi : '-' },
  { key: 'qvaToVviReturn', label: 'QVA→VVI%', type: 'num', render: d => fmtPct(d.qvaToVviReturn, true) },
  { key: 'maxDropBeforeVvi', label: 'VVI전 최대낙폭%', type: 'num', render: d => fmtPct(d.maxDropBeforeVvi, true) },
  { key: 'vviCloseLocation', label: '종가위치', type: 'num', render: d => fmtRatio(d.vviCloseLocation) },
  { key: 'vviTradingValue', label: 'VVI 거래대금', type: 'num', render: d => fmtValue(d.vviTradingValue) },
  { key: 'nextDayBreakout', label: '다음날 돌파', type: 'bool', render: d => fmtBool(d.nextDayBreakout) },
  { key: 'afterVviD5Return', label: 'D5%', type: 'num', render: d => fmtPct(d.afterVviD5Return, true) },
  { key: 'afterVviD10Return', label: 'D10%', type: 'num', render: d => fmtPct(d.afterVviD10Return, true) },
  { key: 'afterVviMFE10', label: 'MFE10', type: 'num', render: d => fmtPct(d.afterVviMFE10, true) },
  { key: 'afterVviMAE10', label: 'MAE10', type: 'num', render: d => fmtPct(d.afterVviMAE10, true) },
  { key: 'tags', label: '태그', type: 'str', txt: true, render: d => (d.tags || []).join(' · ') },
];

function renderDetails(items) {
  const tbody = document.getElementById('details-tbody');
  tbody.innerHTML = items.map(d => {
    const dataAttrs = ' data-name="' + (d.name || '') + '"' +
      ' data-code="' + d.code + '"' +
      ' data-vvi="' + (d.qvaToVvi ? 1 : 0) + '"' +
      ' data-drop10="' + (d.qvaToVvi && d.maxDropBeforeVvi != null && d.maxDropBeforeVvi >= -10 ? 1 : 0) + '"' +
      ' data-drop15="' + (d.qvaToVvi && d.maxDropBeforeVvi != null && d.maxDropBeforeVvi >= -15 ? 1 : 0) + '"' +
      ' data-strong="' + (d.qvaToVvi && d.vviCloseLocation != null && d.vviCloseLocation >= 0.6 ? 1 : 0) + '"' +
      ' data-vstrong="' + (d.qvaToVvi && d.vviCloseLocation != null && d.vviCloseLocation >= 0.75 ? 1 : 0) + '"' +
      ' data-brk="' + (d.nextDayBreakout ? 1 : 0) + '"' +
      ' data-brk1="' + (d.nextDayBreakout1Pct ? 1 : 0) + '"' +
      ' data-pref="' + (d.isPreferred ? 1 : 0) + '"';
    return '<tr' + dataAttrs + '>' + COLS_DETAIL.map(c =>
      '<td' + (c.txt ? ' class="txt"' : '') + '>' + c.render(d) + '</td>'
    ).join('') + '</tr>';
  }).join('');

  // 모바일 카드
  const cards = document.getElementById('details-cards');
  cards.innerHTML = items.map(d => {
    const dataAttrs = ' data-name="' + (d.name || '') + '"' +
      ' data-code="' + d.code + '"' +
      ' data-vvi="' + (d.qvaToVvi ? 1 : 0) + '"' +
      ' data-drop10="' + (d.qvaToVvi && d.maxDropBeforeVvi != null && d.maxDropBeforeVvi >= -10 ? 1 : 0) + '"' +
      ' data-drop15="' + (d.qvaToVvi && d.maxDropBeforeVvi != null && d.maxDropBeforeVvi >= -15 ? 1 : 0) + '"' +
      ' data-strong="' + (d.qvaToVvi && d.vviCloseLocation != null && d.vviCloseLocation >= 0.6 ? 1 : 0) + '"' +
      ' data-vstrong="' + (d.qvaToVvi && d.vviCloseLocation != null && d.vviCloseLocation >= 0.75 ? 1 : 0) + '"' +
      ' data-brk="' + (d.nextDayBreakout ? 1 : 0) + '"' +
      ' data-brk1="' + (d.nextDayBreakout1Pct ? 1 : 0) + '"' +
      ' data-pref="' + (d.isPreferred ? 1 : 0) + '"';
    return '<div class="card"' + dataAttrs + '>' +
      '<div class="card-head">' +
        '<span class="name ' + marketCls(d.market) + '">' + (d.name || '') + '</span>' +
        badges(d) +
        '<span class="meta">' + d.market + ' · ' + d.code + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<span class="lbl">QVA일 / 신호가</span><span class="val">' + fmtDate(d.qvaSignalDate) + ' · ' + fmtNum(d.qvaSignalPrice) + '원</span>' +
        '<span class="lbl">VVI일</span><span class="val">' + (d.vviDate ? fmtDate(d.vviDate) + ' (D+' + d.daysToVvi + ')' : '<span class="muted">미발생</span>') + '</span>' +
        '<span class="lbl">QVA→VVI%</span><span class="val">' + fmtPct(d.qvaToVviReturn, true) + '</span>' +
        '<span class="lbl">VVI전 최대낙폭%</span><span class="val">' + fmtPct(d.maxDropBeforeVvi, true) + '</span>' +
        '<span class="lbl">종가위치</span><span class="val">' + fmtRatio(d.vviCloseLocation) + '</span>' +
        '<span class="lbl">VVI 거래대금</span><span class="val">' + fmtValue(d.vviTradingValue) + '</span>' +
        '<span class="lbl">다음날 돌파</span><span class="val">' + fmtBool(d.nextDayBreakout) + '</span>' +
        '<span class="lbl">D5 / D10</span><span class="val">' + fmtPct(d.afterVviD5Return, true) + ' / ' + fmtPct(d.afterVviD10Return, true) + '</span>' +
        '<span class="lbl">MFE10 / MAE10</span><span class="val">' + fmtPct(d.afterVviMFE10, true) + ' / ' + fmtPct(d.afterVviMAE10, true) + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}
renderDetails(DATA.details);

// 정렬
function attachSort(tableId, dataKey) {
  const tbl = document.getElementById(tableId);
  tbl.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const type = th.dataset.type;
      const isAsc = th.classList.contains('sorted-asc');
      tbl.querySelectorAll('th').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(isAsc ? 'sorted-desc' : 'sorted-asc');

      let items;
      if (dataKey === 'group') items = Object.entries(DATA.groups).map(([k, g]) => ({ key: k, ...g }));
      else if (dataKey === 'filter') items = ['qvaToVvi', 'qvaToVviDrop15', 'qvaToVviNearSignal', 'qvaToVviStrongClose', 'qvaToVviBreakout', 'qvaToVviStrongBreakout'].map(k => ({ key: k, ...DATA.groups[k] }));
      else items = DATA.details.slice();

      const cmp = (a, b) => {
        let va = a[col], vb = b[col];
        if (type === 'num') { va = va == null ? -Infinity : +va; vb = vb == null ? -Infinity : +vb; return isAsc ? vb - va : va - vb; }
        if (type === 'bool') { va = va === true ? 1 : (va === false ? 0 : -1); vb = vb === true ? 1 : (vb === false ? 0 : -1); return isAsc ? vb - va : va - vb; }
        return isAsc ? String(vb || '').localeCompare(String(va || '')) : String(va || '').localeCompare(String(vb || ''));
      };
      items.sort(cmp);

      if (dataKey === 'group') {
        fillTable('group-tbody', items, [
          { key: 'label', txt: true },
          { key: 'count', fmt: 'num' },
          { key: 'uniqueStocks', fmt: 'num' },
          { key: 'avgDaysToVvi', fmt: 'days' },
          { key: 'avgQvaToVviReturn', fmt: 'pct' },
          { key: 'avgAfterVviD5Return', fmt: 'pct' },
          { key: 'avgAfterVviD10Return', fmt: 'pct' },
          { key: 'avgAfterVviMFE10', fmt: 'pct' },
          { key: 'avgAfterVviMAE10', fmt: 'pct' },
          { key: 'winRateD5', fmt: 'pct' },
          { key: 'winRateD10', fmt: 'pct' },
          { key: 'nextDayBreakoutRate', fmt: 'pct' },
        ]);
      } else if (dataKey === 'filter') {
        fillTable('filter-tbody', items, [
          { key: 'label', txt: true },
          { key: 'count', fmt: 'num' },
          { key: 'avgQvaToVviReturn', fmt: 'pct' },
          { key: 'avgAfterVviD5Return', fmt: 'pct' },
          { key: 'avgAfterVviD10Return', fmt: 'pct' },
          { key: 'avgAfterVviMFE10', fmt: 'pct' },
          { key: 'avgAfterVviMAE10', fmt: 'pct' },
          { key: 'winRateD5', fmt: 'pct' },
          { key: 'winRateD10', fmt: 'pct' },
          { key: 'mfe10Hit10Rate', fmt: 'pct' },
          { key: 'mfe10Hit15Rate', fmt: 'pct' },
        ]);
      } else {
        renderDetails(items);
        applyFilter();
      }
    });
  });
}
attachSort('group-table', 'group');
attachSort('filter-table', 'filter');
attachSort('details-table', 'details');

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
    if (cat === 'vvi') matchC = el.dataset.vvi === '1';
    else if (cat === 'only') matchC = el.dataset.vvi === '0';
    else if (cat === 'drop10') matchC = el.dataset.drop10 === '1';
    else if (cat === 'drop15') matchC = el.dataset.drop15 === '1';
    else if (cat === 'strong') matchC = el.dataset.strong === '1';
    else if (cat === 'vstrong') matchC = el.dataset.vstrong === '1';
    else if (cat === 'brk') matchC = el.dataset.brk === '1';
    else if (cat === 'brk1') matchC = el.dataset.brk1 === '1';
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
fs.writeFileSync(path.join(ROOT, 'qva-to-vvi-report.html'), html, 'utf-8');
console.log(`✅ HTML 저장: qva-to-vvi-report.html  (Express /qva-to-vvi-report 라우트로 접근)\n`);
