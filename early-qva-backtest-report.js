/**
 * Early QVA 백테스트 보고서 — 1년치
 *
 * 목적: Early QVA가 기존 Confirmed QVA보다 평균 며칠 먼저 잡히는지,
 *       그리고 품질이 너무 떨어지지 않는지 검증.
 *
 * 비교 코호트:
 *   1. Early QVA (단독)
 *   2. Confirmed QVA (단독, 기존)
 *   3. Early QVA → Confirmed QVA (전환된 것)
 *   4. Early QVA → VVI (VVI까지 전환)
 *   5. Early QVA → H그룹 (H그룹까지 진행)
 *
 * 지표: 신호 수 / 고유 종목 수 / D+5/10/20 플러스 마감 비율 + 평균 수익률 +
 *       MFE/MAE / 도달 비율 / 전환률 / 평균 며칠 먼저 잡혔는지.
 *
 * 입력: cache/stock-charts-long/{code}.json + cache/flow-history (VVI용)
 * 출력: early-qva-backtest-report.json + .html
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const SCAN_START = '20250401';
const SCAN_END = '20260319';
const QVA_TRACKING_DAYS = 20;
const FORWARD_HORIZONS = [5, 10, 20];

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function mean(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function round2(v) { return v == null || !Number.isFinite(v) ? null : parseFloat(v.toFixed(2)); }
function rate(num, denom) { return denom > 0 ? round2(num / denom * 100) : null; }
function fmt(d) { return d && d.length === 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : (d || '-'); }

// ─── Confirmed QVA 검출 (기존 보고서와 동일) ───
function _sma(values, period) {
  if (!values || values.length < period) return null;
  const recent = values.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / period;
}
function _median(values) {
  if (!values || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function checkConfirmedQVAAtIdx(rows, idx) {
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
  if (todayValue / (avg20Value || 1) < 1.5) return false;
  if (today.volume / (avg20Vol || 1) < 1.5) return false;
  const lows5 = last5.map(r => r.low);
  const lows20to25 = rows.slice(idx - 24, idx - 4).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;
  if (min5 <= min20) return false;
  const ma20 = _sma(last20.map(r => r.close), 20);
  if (ma20 && close < ma20 * 0.95) return false;
  const todayReturn = today.open > 0 ? close / today.open - 1 : 0;
  if (todayReturn > 0.05) return false;
  const ret20d = idx >= 20 ? close / rows[idx - 20].close - 1 : 0;
  if (ret20d > 0.15) return false;
  const medianVal20 = _median(last20.map(r => r.valueApprox || 0));
  if ((medianVal20 > 0 ? todayValue / medianVal20 : 0) < 1.8) return false;
  const last3 = rows.slice(idx - 2, idx + 1);
  const hasRecentValueSpike = last3.some(r => {
    const v = r.valueApprox || r.close * r.volume;
    return v / (avg20Value || 1) >= 1.5 || (medianVal20 > 0 ? v / medianVal20 : 0) >= 2.0;
  });
  if (!hasRecentValueSpike) return false;
  const last10hl = rows.slice(idx - 9, idx + 1);
  const high10 = Math.max(...last10hl.map(r => r.high));
  const low10 = Math.min(...last10hl.map(r => r.low));
  if ((low10 > 0 ? high10 / low10 - 1 : 0) < 0.03) return false;
  return true;
}

function computeForwards(rows, entryIdx, entryPrice, horizons) {
  const out = { d: {}, mfe10: null, mae10: null, mfe20: null, mae20: null };
  for (const h of horizons) {
    const idx = entryIdx + h;
    out.d[h] = idx < rows.length && entryPrice > 0
      ? (rows[idx].close / entryPrice - 1) * 100 : null;
  }
  for (const win of [10, 20]) {
    let mfe = null, mae = null;
    for (let k = 1; k <= win && entryIdx + k < rows.length; k++) {
      const r = rows[entryIdx + k];
      const up = (r.high / entryPrice - 1) * 100;
      const dn = (r.low / entryPrice - 1) * 100;
      if (mfe == null || up > mfe) mfe = up;
      if (mae == null || dn < mae) mae = dn;
    }
    if (win === 10) { out.mfe10 = mfe; out.mae10 = mae; }
    else { out.mfe20 = mfe; out.mae20 = mae; }
  }
  return out;
}

function summarizeReturns(entries) {
  const out = { count: entries.length, byHorizon: {} };
  for (const h of FORWARD_HORIZONS) {
    const rets = entries.map(e => e.d[h]).filter(v => v != null && Number.isFinite(v));
    if (rets.length === 0) { out.byHorizon[h] = null; continue; }
    out.byHorizon[h] = {
      n: rets.length,
      winRate: round2(rets.filter(v => v > 0).length / rets.length * 100),
      mean: round2(mean(rets)),
      median: round2(median(rets)),
      win10pctRate: round2(rets.filter(v => v >= 10).length / rets.length * 100),
      win20pctRate: round2(rets.filter(v => v >= 20).length / rets.length * 100),
      loss10pctRate: round2(rets.filter(v => v <= -10).length / rets.length * 100),
    };
  }
  const mfe20s = entries.map(e => e.mfe20).filter(v => v != null && Number.isFinite(v));
  const mae20s = entries.map(e => e.mae20).filter(v => v != null && Number.isFinite(v));
  out.mfe20 = mfe20s.length ? round2(mean(mfe20s)) : null;
  out.mae20 = mae20s.length ? round2(mean(mae20s)) : null;
  out.uniqueStocks = new Set(entries.map(e => e.code)).size;
  return out;
}

// ─── 메인 ───
const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));
console.log(`\n📊 Early QVA 백테스트 — ${SCAN_START} ~ ${SCAN_END}`);
console.log(`종목 수: ${files.length}\n`);

// 코호트별 진입 레코드
const cohorts = {
  earlyQva: [],          // Early QVA 발생 시점 매수
  confirmedQva: [],      // Confirmed QVA 발생 시점 매수
  earlyToConfirmed: [],  // Early QVA 후 Confirmed QVA로 전환된 케이스 (Early 시점 매수)
  earlyToVvi: [],        // Early QVA 후 VVI까지 전환 (Early 시점 매수)
  earlyToH: [],          // Early QVA 후 H그룹까지 진행 (Early 시점 매수)
};

// 큐로셀 디버그
const debugCases = [];

const t0 = Date.now();
let totalEarly = 0, totalConfirmed = 0;

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

  // 종목 단위 Early QVA 신호 모음 ((code, firstEarlyDate) 단위 dedup)
  // 같은 종목에 한 윈도우 내 여러 Early QVA가 있으면 첫 신호만 사용 (사용자 spec: first 우선)
  let lastEarlyIdx = -10; // dedup window
  for (let t = 60; t < rows.length - Math.max(...FORWARD_HORIZONS); t++) {
    const today = rows[t];
    if (today.date < SCAN_START || today.date > SCAN_END) continue;

    // 큐로셀 372320 2026-04-30 디버그
    if (code === '372320' && today.date === '20260430') {
      const sliced = rows.slice(0, t + 1);
      const res = ps.calculateEarlyQVA(sliced, [], namedMeta);
      debugCases.push({
        code, name: chart.name || meta.name, date: today.date,
        earlyQva: !!res?.passed,
        excludeReasons: res?.excludeReasons || [],
        signals: res?.signals || null,
      });
    }

    // 같은 종목 중복 스킵 (TRACKING_DAYS 단위)
    if (t - lastEarlyIdx < QVA_TRACKING_DAYS) continue;

    // Early QVA 검사
    const sliced = rows.slice(0, t + 1);
    let early = null;
    try { early = ps.calculateEarlyQVA(sliced, [], namedMeta); } catch (_) { early = null; }

    if (early?.passed) {
      lastEarlyIdx = t;
      totalEarly++;
      const buyPrice = today.close;
      const f = computeForwards(rows, t, buyPrice, FORWARD_HORIZONS);
      const baseRec = {
        code, name: chart.name || meta.name, market: meta.market,
        earlyDate: today.date, buyPrice,
        score: early.score, grade: early.grade,
        ...f,
      };
      cohorts.earlyQva.push(baseRec);

      // Forward: Early QVA 후 N거래일 안에 Confirmed/VVI/H그룹 발생 여부
      let confirmedIdx = null, vviIdx = null, hIdx = null;
      const maxLookahead = Math.min(QVA_TRACKING_DAYS, rows.length - 1 - t);
      // Confirmed QVA 검출
      for (let k = 1; k <= maxLookahead; k++) {
        const candIdx = t + k;
        if (checkConfirmedQVAAtIdx(rows, candIdx)) { confirmedIdx = candIdx; break; }
      }
      // VVI 검출
      for (let k = 1; k <= maxLookahead; k++) {
        const candIdx = t + k;
        const candDate = rows[candIdx].date;
        const slC = rows.slice(0, candIdx + 1);
        const slF = flowRows.filter(r => r.date <= candDate);
        if (slF.length < 10) continue;
        let vvi = null;
        try { vvi = ps.calculateVolumeValueIgnition(slC, slF, namedMeta); }
        catch (_) { vvi = null; }
        if (vvi?.passed) { vviIdx = candIdx; break; }
      }
      // H그룹: VVI 다음날 vviHigh×1.01 돌파 + nextClose>=vviHigh
      if (vviIdx != null && vviIdx + 1 < rows.length) {
        const vR = rows[vviIdx], nR = rows[vviIdx + 1];
        const triggered1Pct = nR.high >= vR.high * 1.01;
        const breakoutFail = nR.close < vR.high;
        if (triggered1Pct && !breakoutFail) hIdx = vviIdx + 1;
      }

      if (confirmedIdx != null) {
        cohorts.earlyToConfirmed.push({
          ...baseRec, confirmedIdx,
          confirmedDate: rows[confirmedIdx].date,
          daysToConfirmed: confirmedIdx - t,
        });
      }
      if (vviIdx != null) {
        cohorts.earlyToVvi.push({
          ...baseRec, vviIdx, vviDate: rows[vviIdx].date,
          daysToVvi: vviIdx - t,
        });
      }
      if (hIdx != null) {
        cohorts.earlyToH.push({
          ...baseRec, hIdx, hDate: rows[hIdx].date,
          daysToH: hIdx - t,
        });
      }
    }
  }

  // Confirmed QVA 별도 스캔 (단독 코호트용)
  let lastConfirmedIdx = -10;
  for (let t = 60; t < rows.length - Math.max(...FORWARD_HORIZONS); t++) {
    const today = rows[t];
    if (today.date < SCAN_START || today.date > SCAN_END) continue;
    if (t - lastConfirmedIdx < QVA_TRACKING_DAYS) continue;
    if (!checkConfirmedQVAAtIdx(rows, t)) continue;
    lastConfirmedIdx = t;
    totalConfirmed++;
    const buyPrice = today.close;
    const f = computeForwards(rows, t, buyPrice, FORWARD_HORIZONS);
    cohorts.confirmedQva.push({
      code, name: chart.name || meta.name, market: meta.market,
      confirmedDate: today.date, buyPrice,
      ...f,
    });
  }
}
process.stdout.write(`  완료 ${files.length}/${files.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);

console.log(`\n총 Early QVA 신호: ${totalEarly}건`);
console.log(`총 Confirmed QVA 신호: ${totalConfirmed}건`);
console.log(`Early → Confirmed 전환: ${cohorts.earlyToConfirmed.length}건 (${rate(cohorts.earlyToConfirmed.length, cohorts.earlyQva.length)}%)`);
console.log(`Early → VVI 전환: ${cohorts.earlyToVvi.length}건 (${rate(cohorts.earlyToVvi.length, cohorts.earlyQva.length)}%)`);
console.log(`Early → H그룹 전환: ${cohorts.earlyToH.length}건 (${rate(cohorts.earlyToH.length, cohorts.earlyQva.length)}%)`);

// 평균 며칠 먼저 잡혔는지 (Early → Confirmed)
const daysEarlier = cohorts.earlyToConfirmed.map(e => e.daysToConfirmed);
const avgDaysEarlier = daysEarlier.length ? round2(mean(daysEarlier)) : null;
const medianDaysEarlier = daysEarlier.length ? round2(median(daysEarlier)) : null;
console.log(`\nEarly QVA가 Confirmed QVA보다 평균 ${avgDaysEarlier}일 먼저 잡힘 (중앙값 ${medianDaysEarlier}일)`);

// 5 코호트 요약
const summary = {
  earlyQva: summarizeReturns(cohorts.earlyQva),
  confirmedQva: summarizeReturns(cohorts.confirmedQva),
  earlyToConfirmed: summarizeReturns(cohorts.earlyToConfirmed),
  earlyToVvi: summarizeReturns(cohorts.earlyToVvi),
  earlyToH: summarizeReturns(cohorts.earlyToH),
};

console.log(`\n📊 코호트별 D+20 플러스 마감 비율 / 평균 수익률`);
const cohortLabels = {
  earlyQva: 'Early QVA (단독)',
  confirmedQva: 'Confirmed QVA (단독, 기존)',
  earlyToConfirmed: 'Early → Confirmed QVA',
  earlyToVvi: 'Early → VVI',
  earlyToH: 'Early → H그룹',
};
for (const [k, lbl] of Object.entries(cohortLabels)) {
  const s = summary[k];
  const d20 = s.byHorizon[20];
  console.log(`  ${lbl.padEnd(28)} N=${String(s.count).padStart(4)} (${String(s.uniqueStocks).padStart(3)}종목) | D+20 ${d20 ? d20.winRate + '% 평균' + d20.mean + '%' : '-'}`);
}

const conversion = {
  earlyToConfirmedRate: rate(cohorts.earlyToConfirmed.length, cohorts.earlyQva.length),
  earlyToVviRate: rate(cohorts.earlyToVvi.length, cohorts.earlyQva.length),
  earlyToHRate: rate(cohorts.earlyToH.length, cohorts.earlyQva.length),
  avgDaysEarlier,
  medianDaysEarlier,
};

const jsonOut = {
  meta: {
    purpose: 'Early QVA가 Confirmed QVA보다 평균 며칠 먼저 잡히는지, 품질이 너무 떨어지지 않는지 검증',
    notice: '본 보고서는 매수 추천이 아닙니다. 단일 시장 사이클 데이터 기반.',
    scanStart: SCAN_START, scanEnd: SCAN_END,
    forwardHorizons: FORWARD_HORIZONS,
    generatedAt: new Date().toISOString(),
  },
  totalCounts: {
    earlyQva: cohorts.earlyQva.length,
    confirmedQva: cohorts.confirmedQva.length,
    earlyToConfirmed: cohorts.earlyToConfirmed.length,
    earlyToVvi: cohorts.earlyToVvi.length,
    earlyToH: cohorts.earlyToH.length,
  },
  conversion,
  summary,
  debugCases,
  // 일부 sample 진입 (UI top/worst 표시용)
  sampleEarly: cohorts.earlyQva
    .filter(e => e.d[20] != null)
    .sort((a, b) => b.d[20] - a.d[20])
    .slice(0, 30),
};

fs.writeFileSync(path.join(ROOT, 'early-qva-backtest-report.json'), JSON.stringify(jsonOut, null, 2));
console.log(`\n✅ JSON 저장: early-qva-backtest-report.json`);

// HTML 생성
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🌱 Early QVA 백테스트 — 바닥권 초기 흔적 검증</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
  h1 { color: #f1f5f9; margin: 0 0 4px 0; font-size: 24px; }
  h1 .sub { color: #94a3b8; font-size: 14px; font-weight: 400; margin-left: 6px; }
  h2 { color: #f1f5f9; margin: 24px 0 8px 0; font-size: 17px; padding: 8px 0; border-bottom: 1px solid #334155; }
  .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 12px; }
  .nav { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  .nav a { color: #93c5fd; text-decoration: none; font-size: 12px; padding: 6px 10px; background: #1e293b; border-radius: 6px; }
  .nav a.active { background: #1e3a8a; color: #fff; }
  .info-box { background: #1e293b; padding: 14px 18px; border-radius: 8px; margin-bottom: 14px; border-left: 3px solid #34d399; }
  .info-box p { margin: 0 0 6px 0; font-size: 13px; line-height: 1.7; color: #cbd5e1; }
  .info-box strong { color: #f1f5f9; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .stat { background: #1e293b; padding: 10px 14px; border-radius: 6px; border: 1px solid #334155; }
  .stat .lbl { color: #94a3b8; font-size: 11px; }
  .stat .val { color: #f1f5f9; font-size: 22px; font-weight: 700; margin-top: 2px; }
  .stat.hi { border-left: 3px solid #34d399; }
  .stat.warn { border-left: 3px solid #fbbf24; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; background: #1e293b; border-radius: 6px; overflow: hidden; margin-bottom: 12px; }
  th { background: #334155; color: #f1f5f9; padding: 8px 10px; text-align: right; font-weight: 600; font-size: 12px; }
  th.txt { text-align: left; }
  td { padding: 7px 10px; border-bottom: 1px solid #0f172a; text-align: right; color: #cbd5e1; }
  td.txt { text-align: left; }
  tr:hover td { background: #263449; }
  .pos { color: #6ee7b7; }
  .neg { color: #f87171; }
  .muted { color: #64748b; }
  .market-K { color: #93c5fd; }
  .market-Q { color: #fbbf24; }
  .debug { background: #422006; padding: 12px 16px; border-radius: 6px; border-left: 3px solid #fbbf24; margin-bottom: 12px; }
  .debug pre { margin: 6px 0; font-size: 11px; color: #fde68a; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>🌱 Early QVA 백테스트 <span class="sub">바닥권 초기 흔적 검증 — 기존 QVA보다 얼마나 먼저 잡히나</span></h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="nav">
    <a href="/qva-watchlist">📋 매일 운영 보드</a>
    <span style="color:#475569;font-size:11px;align-self:center;">검증 ▶</span>
    <a href="/qva-surge-day-report">단일일 급등</a>
    <a href="/qva-to-vvi-report">QVA → VVI 전환</a>
    <a href="/qva-vvi-breakout-entry-report">진입</a>
    <a href="/qva-vvi-breakout-exit-report">익절/청산</a>
    <a href="/qva-review-ok">⭐ 3단계 코호트 비교</a>
    <a href="/early-qva-backtest" class="active">🌱 Early QVA</a>
  </div>

  <div class="info-box">
    <h3 style="margin:0 0 10px 0;color:#f1f5f9;font-size:15px;border:none;padding:0;">📌 보고서 안내</h3>
    <p><strong>이 보고서가 답하는 질문</strong></p>
    <p>Early QVA가 기존 Confirmed QVA보다 평균 며칠 먼저 잡히는가? 그 대신 플러스 마감 비율이나 하락 위험이 얼마나 나빠지는가?</p>

    <p style="margin-top:10px;"><strong>📍 funnel에서의 위치</strong></p>
    <p style="font-size:12px;background:#0f172a;padding:8px 12px;border-radius:6px;border:1px solid #334155;">
      <span style="color:#34d399;font-weight:700;">🌱 Early QVA(0단계)</span> → <span style="color:#fbbf24;font-weight:700;">Confirmed QVA(1단계)</span> → <span style="color:#3b82f6;font-weight:700;">VVI(2단계)</span> → <span style="color:#a5b4fc;font-weight:700;">+1% 돌파(3단계)</span> → <span style="color:#10b981;font-weight:700;">H그룹</span><br>
      Early QVA는 funnel <strong>맨 앞단에 추가된 더 빠른 감시 후보</strong> 역할입니다.
    </p>

    <p style="margin-top:10px;"><strong>📊 읽는 법</strong></p>
    <ul style="margin:4px 0;padding-left:20px;font-size:13px;line-height:1.7;color:#cbd5e1;">
      <li>5개 코호트 비교 — Early 단독 / Confirmed 단독 / Early→Confirmed / Early→VVI / Early→H그룹</li>
      <li>Early가 Confirmed보다 평균 며칠 먼저 잡히는지 + 전환률 함께 표시</li>
      <li>D+5 / D+10 / D+20 플러스 마감 비율과 평균 수익률 비교</li>
    </ul>

    <p style="margin-top:10px;"><strong>🎯 핵심 의미</strong></p>
    <p>Early QVA가 더 빨리 잡히는 대신 품질이 얼마나 떨어지는지를 정량 확인. Confirmed로 전환된 부분(Early→Confirmed) 의 성과는 Early 단독보다 좋아야 funnel이 의미 있음.</p>

    <p class="warn" style="margin-top:10px;color:#fbbf24;">⚠️ 본 보고서는 매수 추천이 아닙니다. Early QVA는 더 이른 신호이므로 실패 확률도 더 높습니다. 단일 시장 사이클 데이터 기반.</p>
  </div>

  <h2>요약 — 전환률과 시간 차이</h2>
  <div class="summary-grid" id="summary-grid"></div>

  <h2>5개 코호트 성과 비교</h2>
  <p class="subtitle">신호 수, 고유 종목 수, D+5/10/20 플러스 마감 비율 + 평균 수익률, 20일 안 최고/최저, +10/+20% 도달률, -10% 하락률.</p>
  <table id="cohort-table"><thead><tr>
    <th class="txt">코호트</th><th>N</th><th>고유종목</th>
    <th>D+5 +%마감</th><th>D+5 평균</th>
    <th>D+10 +%마감</th><th>D+10 평균</th>
    <th>D+20 +%마감</th><th>D+20 평균</th><th>D+20 중앙</th>
    <th>20일 최고</th><th>20일 최저</th>
    <th>+10%↑</th><th>+20%↑</th><th>-10%↓</th>
  </tr></thead><tbody id="cohort-tbody"></tbody></table>

  <h2>큐로셀(372320) 2026-04-30 디버그</h2>
  <p class="subtitle">사용자 요청 케이스 — Early QVA 기준에서 후행 신호로 제외되는지 확인.</p>
  <div id="debug-area"></div>

  <h2>Early QVA TOP 30 사례 (D+20 수익률 상위)</h2>
  <table id="top-table"><thead><tr>
    <th class="txt">종목</th><th class="txt">Early 발생일</th><th>점수</th><th class="txt">등급</th>
    <th>매수가</th><th>D+5</th><th>D+10</th><th>D+20</th><th>MFE20</th><th>MAE20</th>
  </tr></thead><tbody id="top-tbody"></tbody></table>

<script>
const DATA = __JSON_DATA__;

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8) : (d || '-'); }
function fmtNum(n) { return n != null ? Math.round(n).toLocaleString() : '-'; }
function fmtPct(n, sign) {
  if (n == null || !Number.isFinite(n)) return '<span class="muted">-</span>';
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : 'muted');
  const s = (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
  return '<span class="' + cls + '">' + s + '</span>';
}
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }

document.getElementById('subtitle').textContent =
  '스캔 ' + fmtDate(DATA.meta.scanStart) + ' ~ ' + fmtDate(DATA.meta.scanEnd) +
  ' · 생성 ' + DATA.meta.generatedAt.slice(0,19).replace('T',' ');

// 요약 카드
function makeStat(label, val, cls) {
  return '<div class="stat ' + (cls || '') + '"><div class="lbl">' + label + '</div><div class="val">' + val + '</div></div>';
}
const c = DATA.totalCounts, conv = DATA.conversion;
document.getElementById('summary-grid').innerHTML = [
  makeStat('Early QVA 신호', c.earlyQva + '건', 'hi'),
  makeStat('Confirmed QVA 신호', c.confirmedQva + '건'),
  makeStat('Early → Confirmed', c.earlyToConfirmed + '건 (' + (conv.earlyToConfirmedRate ?? '-') + '%)'),
  makeStat('Early → VVI', c.earlyToVvi + '건 (' + (conv.earlyToVviRate ?? '-') + '%)'),
  makeStat('Early → H그룹', c.earlyToH + '건 (' + (conv.earlyToHRate ?? '-') + '%)'),
  makeStat('Early가 Confirmed보다 평균 먼저', (conv.avgDaysEarlier ?? '-') + '일', 'warn'),
  makeStat('중앙값', (conv.medianDaysEarlier ?? '-') + '일', 'warn'),
].join('');

// 코호트 표
const cohortLabels = {
  earlyQva: '🌱 Early QVA (단독)',
  confirmedQva: '👀 Confirmed QVA (단독, 기존)',
  earlyToConfirmed: 'Early → Confirmed QVA',
  earlyToVvi: 'Early → VVI',
  earlyToH: '🔥 Early → H그룹',
};
function row(cohortKey, label) {
  const s = DATA.summary[cohortKey];
  if (!s || !s.count) return '';
  const d5 = s.byHorizon[5], d10 = s.byHorizon[10], d20 = s.byHorizon[20];
  return '<tr>' +
    '<td class="txt"><strong>' + label + '</strong></td>' +
    '<td>' + s.count + '</td>' +
    '<td>' + s.uniqueStocks + '</td>' +
    '<td>' + (d5 ? d5.winRate + '%' : '-') + '</td>' +
    '<td>' + (d5 ? fmtPct(d5.mean, true) : '-') + '</td>' +
    '<td>' + (d10 ? d10.winRate + '%' : '-') + '</td>' +
    '<td>' + (d10 ? fmtPct(d10.mean, true) : '-') + '</td>' +
    '<td>' + (d20 ? d20.winRate + '%' : '-') + '</td>' +
    '<td>' + (d20 ? fmtPct(d20.mean, true) : '-') + '</td>' +
    '<td>' + (d20 ? fmtPct(d20.median, true) : '-') + '</td>' +
    '<td>' + fmtPct(s.mfe20, true) + '</td>' +
    '<td>' + fmtPct(s.mae20, true) + '</td>' +
    '<td>' + (d20 ? d20.win10pctRate + '%' : '-') + '</td>' +
    '<td>' + (d20 ? d20.win20pctRate + '%' : '-') + '</td>' +
    '<td>' + (d20 ? d20.loss10pctRate + '%' : '-') + '</td>' +
    '</tr>';
}
document.getElementById('cohort-tbody').innerHTML = Object.entries(cohortLabels).map(([k, l]) => row(k, l)).join('');

// 큐로셀 디버그
const debugArea = document.getElementById('debug-area');
if (DATA.debugCases.length === 0) {
  debugArea.innerHTML = '<p class="muted">큐로셀 372320 2026-04-30 데이터 없음</p>';
} else {
  debugArea.innerHTML = DATA.debugCases.map(d =>
    '<div class="debug">' +
    '<p><strong>' + d.code + ' ' + d.name + ' (' + fmtDate(d.date) + ')</strong></p>' +
    '<p>Early QVA: <strong>' + (d.earlyQva ? '✅ passed' : '❌ rejected') + '</strong></p>' +
    (d.excludeReasons.length > 0 ? '<p>제외 사유:</p><pre>' + d.excludeReasons.map(r => '  • ' + r).join('\\n') + '</pre>' : '') +
    (d.signals ? '<p>signals:</p><pre>' + JSON.stringify(d.signals, null, 2) + '</pre>' : '') +
    '</div>'
  ).join('');
}

// TOP 30
document.getElementById('top-tbody').innerHTML = (DATA.sampleEarly || []).map(e =>
  '<tr>' +
  '<td class="txt"><span class="' + marketCls(e.market) + '">' + e.name + '</span> <span class="muted">' + e.code + '</span></td>' +
  '<td class="txt">' + fmtDate(e.earlyDate) + '</td>' +
  '<td>' + e.score + '</td>' +
  '<td class="txt">' + (e.grade || '-') + '</td>' +
  '<td>' + fmtNum(e.buyPrice) + '</td>' +
  '<td>' + fmtPct(e.d['5'], true) + '</td>' +
  '<td>' + fmtPct(e.d['10'], true) + '</td>' +
  '<td>' + fmtPct(e.d['20'], true) + '</td>' +
  '<td>' + fmtPct(e.mfe20, true) + '</td>' +
  '<td>' + fmtPct(e.mae20, true) + '</td>' +
  '</tr>'
).join('');
</script>
</body>
</html>`;

fs.writeFileSync(path.join(ROOT, 'early-qva-backtest-report.html'), html.replace('__JSON_DATA__', JSON.stringify(jsonOut)), 'utf-8');
console.log(`✅ HTML 저장: early-qva-backtest-report.html`);
console.log(`   라우트: /early-qva-backtest`);
