/**
 * REVIEW_OK 백테스트 보고서 — 1년치
 *
 * 목적: '돌파 성공 확인 종목(H그룹)' 중 진입 판단 상태가 '검토가능(REVIEW_OK)'인
 *       시점에 매수했을 때의 승률·수익 분포를 측정.
 *
 * 입력: qva-vvi-breakout-entry-report.json (scan 20250401~20260319)
 *       + cache/stock-charts-long/{code}.json
 *
 * 출력: qva-review-ok-backtest-report.json + qva-review-ok-backtest-report.html
 *
 * REVIEW_OK 정의 (qva-watchlist-board.js 라이브 규칙과 동일):
 *   entryPrice = vviHigh × 1.01
 *   if close < entryPrice OR close < vviHigh → BREAKDOWN_WEAK
 *   elif close ≥ entryPrice × 1.15           → MANAGEMENT
 *   elif close >  entryPrice × 1.07 OR daysFromBreakout ≥ 3 → PULLBACK_WAIT
 *   elif close >  entryPrice × 1.03           → CHASE_CAUTION
 *   else                                       → REVIEW_OK
 *
 * 시뮬레이션:
 *   각 H그룹 이벤트(VVI 기준 dedup)에 대해 D+0~D+2를 walk-forward.
 *   첫 REVIEW_OK 일자의 종가에 매수 → D+1/3/5/10/20 종가-종가 수익률 측정.
 *   비교 baseline: H그룹 전체(돌파일 종가 매수).
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ENTRY_JSON = path.join(ROOT, 'qva-vvi-breakout-entry-report.json');
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const OUT_JSON = path.join(ROOT, 'qva-review-ok-backtest-report.json');
const OUT_HTML = path.join(ROOT, 'qva-review-ok-backtest-report.html');

const FORWARD_HORIZONS = [1, 3, 5, 10, 20];

// ─────────── QVA 신호 검출 (qva-vvi-breakout-entry-report.js와 동일) ───────────
function _sma(values, period) {
  if (!values || values.length < period) return null;
  const recent = values.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / period;
}
function _median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
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

  const ma20 = _sma(last20.map(r => r.close), 20);
  if (ma20 && close < ma20 * 0.95) return false;

  const todayReturn = today.open > 0 ? close / today.open - 1 : 0;
  if (todayReturn > 0.05) return false;

  const ret20d = idx >= 20 ? close / rows[idx - 20].close - 1 : 0;
  if (ret20d > 0.15) return false;

  const medianVal20 = _median(last20.map(r => r.valueApprox || 0));
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

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

// ─────────── 통계 헬퍼 ───────────
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
function quantile(arr, q) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
}
function round2(v) { return v == null || !Number.isFinite(v) ? null : parseFloat(v.toFixed(2)); }

function classifyJudgment(close, entryPrice, vviHigh, daysFromBreakout) {
  if (close < entryPrice || close < vviHigh) return 'BREAKDOWN_WEAK';
  if (close >= entryPrice * 1.15) return 'MANAGEMENT';
  if (close > entryPrice * 1.07 || daysFromBreakout >= 3) return 'PULLBACK_WAIT';
  if (close > entryPrice * 1.03) return 'CHASE_CAUTION';
  return 'REVIEW_OK';
}

const chartCache = new Map();
function loadChart(code) {
  if (chartCache.has(code)) return chartCache.get(code);
  const file = path.join(LONG_CACHE_DIR, `${code}.json`);
  if (!fs.existsSync(file)) { chartCache.set(code, null); return null; }
  let chart;
  try { chart = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (_) { chart = null; }
  chartCache.set(code, chart);
  return chart;
}

function findIdxByDate(rows, date) {
  for (let i = 0; i < rows.length; i++) if (rows[i].date === date) return i;
  return -1;
}

function computeForwards(rows, entryIdx, entryPrice, horizons) {
  const out = { d: {}, mfe10: null, mae10: null };
  for (const h of horizons) {
    const idx = entryIdx + h;
    out.d[h] = idx < rows.length && entryPrice > 0
      ? (rows[idx].close / entryPrice - 1) * 100
      : null;
  }
  let mfe = null, mae = null;
  for (let k = 1; k <= 10 && entryIdx + k < rows.length; k++) {
    const r = rows[entryIdx + k];
    const up = (r.high / entryPrice - 1) * 100;
    const dn = (r.low  / entryPrice - 1) * 100;
    if (mfe == null || up > mfe) mfe = up;
    if (mae == null || dn < mae) mae = dn;
  }
  out.mfe10 = mfe; out.mae10 = mae;
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
      max: round2(Math.max(...rets)),
      min: round2(Math.min(...rets)),
      win10pctRate: round2(rets.filter(v => v >= 10).length / rets.length * 100),
      loss7pctRate: round2(rets.filter(v => v <= -7).length / rets.length * 100),
    };
  }
  const mfes = entries.map(e => e.mfe10).filter(v => v != null && Number.isFinite(v));
  const maes = entries.map(e => e.mae10).filter(v => v != null && Number.isFinite(v));
  out.mfe10 = mfes.length === 0 ? null : {
    mean: round2(mean(mfes)), median: round2(median(mfes)),
    q75: round2(quantile(mfes, 0.75)), q90: round2(quantile(mfes, 0.90)),
  };
  out.mae10 = maes.length === 0 ? null : {
    mean: round2(mean(maes)), median: round2(median(maes)),
    q25: round2(quantile(maes, 0.25)), q10: round2(quantile(maes, 0.10)),
  };
  return out;
}

// ─────────── 메인 ───────────
const report = JSON.parse(fs.readFileSync(ENTRY_JSON, 'utf-8'));
const meta = report.meta;
const all = report.details || [];

// H그룹 = entryTriggered1Pct AND !breakoutFail (entry-report의 H_E_excludeBreakoutFail과 동일).
// details는 (qvaDate, vviDate) 단위 raw → (code, vviDate)로 dedup.
const hGroupRaw = all.filter(d => d.entryTriggered1Pct && !d.breakoutFail);
const seen = new Map();
for (const d of hGroupRaw) {
  const key = `${d.code}__${d.vviDate}`;
  if (!seen.has(key)) seen.set(key, d);
}
const hGroup = [...seen.values()];

console.log(`\n📊 REVIEW_OK 백테스트 — ${meta.scanStart} ~ ${meta.scanEnd}`);
console.log(`raw H그룹 ${hGroupRaw.length}건 → (code, vviDate) dedup ${hGroup.length}건`);

const reviewOkEntries = [];
const breakoutEntries = [];
const judgmentDist = { D0: {}, D1: {}, D2: {} };
let skippedNoChart = 0, skippedNoIdx = 0, skippedNoForward = 0;
const reasonsNoReviewOk = { weak: 0, chase: 0, pullback: 0, mgmt: 0 };

for (const ev of hGroup) {
  const chart = loadChart(ev.code);
  if (!chart || !chart.rows) { skippedNoChart++; continue; }
  const rows = chart.rows;
  const breakoutIdx = findIdxByDate(rows, ev.entryDate);
  if (breakoutIdx < 0) { skippedNoIdx++; continue; }

  const entryPrice = ev.vviHigh * 1.01;
  const vviHigh = ev.vviHigh;

  if (breakoutIdx + Math.max(...FORWARD_HORIZONS) < rows.length) {
    const f = computeForwards(rows, breakoutIdx, rows[breakoutIdx].close, FORWARD_HORIZONS);
    breakoutEntries.push({ ev, ...f });
  }

  let entryIdx = null;
  for (let k = 0; k <= 2; k++) {
    const idx = breakoutIdx + k;
    if (idx >= rows.length) break;
    const close = rows[idx].close;
    const status = classifyJudgment(close, entryPrice, vviHigh, k);
    judgmentDist[`D${k}`][status] = (judgmentDist[`D${k}`][status] || 0) + 1;
    if (status === 'REVIEW_OK' && entryIdx == null) entryIdx = idx;
  }

  if (entryIdx == null) {
    const d0Status = classifyJudgment(rows[breakoutIdx].close, entryPrice, vviHigh, 0);
    if (d0Status === 'BREAKDOWN_WEAK') reasonsNoReviewOk.weak++;
    else if (d0Status === 'CHASE_CAUTION') reasonsNoReviewOk.chase++;
    else if (d0Status === 'PULLBACK_WAIT') reasonsNoReviewOk.pullback++;
    else if (d0Status === 'MANAGEMENT') reasonsNoReviewOk.mgmt++;
    continue;
  }

  if (entryIdx + Math.max(...FORWARD_HORIZONS) >= rows.length) { skippedNoForward++; continue; }
  const buyPrice = rows[entryIdx].close;
  const f = computeForwards(rows, entryIdx, buyPrice, FORWARD_HORIZONS);
  reviewOkEntries.push({
    ev,
    buyDate: rows[entryIdx].date,
    buyPrice,
    daysFromBreakout: entryIdx - breakoutIdx,
    ...f,
  });
}

const reviewOkSummary = summarizeReturns(reviewOkEntries);
const breakoutSummary = summarizeReturns(breakoutEntries);

// ─────────── QVA-only 코호트 스캔 (전 종목, 같은 기간) ───────────
console.log(`\n🔍 QVA 신호 단독 스캔 — ${meta.scanStart} ~ ${meta.scanEnd}`);
const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));
const qvaOnlyEntries = [];
const qvaSeen = new Map();
const t0 = Date.now();

for (let fi = 0; fi < files.length; fi++) {
  if (fi % 500 === 0) process.stdout.write(`  진행 ${fi}/${files.length}\r`);
  const code = files[fi].replace('.json', '');
  const stockMeta = codeMeta.get(code);
  if (!stockMeta) continue;

  let chart;
  try { chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8')); }
  catch (_) { continue; }
  const rows = chart.rows || [];
  if (rows.length < 65) continue;
  const stockName = chart.name || stockMeta.name;
  if (isExcludedProduct(stockName)) continue;

  for (let t = 60; t < rows.length - Math.max(...FORWARD_HORIZONS); t++) {
    const today = rows[t];
    if (today.date < meta.scanStart || today.date > meta.scanEnd) continue;
    if (!checkQVASignalAtIdx(rows, t)) continue;

    // (code, qvaDate) dedup — 같은 종목의 같은 날 중복 방지 (실제로는 발생 안 함, 안전장치)
    const key = `${code}__${today.date}`;
    if (qvaSeen.has(key)) continue;
    qvaSeen.set(key, true);

    const buyPrice = today.close;
    const f = computeForwards(rows, t, buyPrice, FORWARD_HORIZONS);
    qvaOnlyEntries.push({
      ev: { code, name: stockName, market: stockMeta.market, qvaSignalDate: today.date },
      buyDate: today.date,
      buyPrice,
      ...f,
    });
  }
}
process.stdout.write(`  완료: ${files.length}/${files.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
console.log(`QVA 신호 단독 매수 진입: ${qvaOnlyEntries.length}건`);

const qvaOnlySummary = summarizeReturns(qvaOnlyEntries);

const buyDayDist = { 0: 0, 1: 0, 2: 0 };
for (const e of reviewOkEntries) buyDayDist[e.daysFromBreakout]++;

const sortedByD10 = reviewOkEntries
  .filter(e => e.d[10] != null)
  .sort((a, b) => b.d[10] - a.d[10]);
const top5 = sortedByD10.slice(0, 5).map(toRow);
const worst5 = sortedByD10.slice(-5).reverse().map(toRow);

function toRow(e) {
  return {
    code: e.ev.code, name: e.ev.name, market: e.ev.market,
    qvaSignalDate: e.ev.qvaSignalDate, vviDate: e.ev.vviDate,
    breakoutDate: e.ev.entryDate, buyDate: e.buyDate,
    daysFromBreakout: e.daysFromBreakout,
    vviHigh: e.ev.vviHigh, entryPrice: round2(e.ev.vviHigh * 1.01),
    buyPrice: e.buyPrice,
    d1: round2(e.d[1]), d3: round2(e.d[3]), d5: round2(e.d[5]),
    d10: round2(e.d[10]), d20: round2(e.d[20]),
    mfe10: round2(e.mfe10), mae10: round2(e.mae10),
  };
}

const jsonOut = {
  meta: {
    purpose: 'H그룹 중 진입 판단 상태가 REVIEW_OK(검토가능)인 시점에 매수했을 때의 승률 백테스트',
    notice: '본 보고서는 매수 추천이 아닙니다. 단일 시장 사이클 데이터 기반.',
    scanStart: meta.scanStart,
    scanEnd: meta.scanEnd,
    forwardHorizons: FORWARD_HORIZONS,
    judgmentRule: {
      entryPrice: 'vviHigh × 1.01',
      REVIEW_OK: 'entryPrice ≤ close ≤ entryPrice × 1.03 AND daysFromBreakout ≤ 2',
      CHASE_CAUTION: 'entryPrice × 1.03 < close ≤ entryPrice × 1.07',
      PULLBACK_WAIT: 'close > entryPrice × 1.07 OR daysFromBreakout ≥ 3',
      MANAGEMENT: 'close ≥ entryPrice × 1.15',
      BREAKDOWN_WEAK: 'close < entryPrice OR close < vviHigh',
    },
    generatedAt: new Date().toISOString(),
  },
  hGroupRawCount: hGroupRaw.length,
  hGroupCount: hGroup.length,
  reviewOkSummary,
  breakoutSummary,
  qvaOnlySummary,
  judgmentDist,
  buyDayDist,
  reasonsNoReviewOk,
  skip: { skippedNoChart, skippedNoIdx, skippedNoForward },
  top5,
  worst5,
  reviewOkEntries: reviewOkEntries.map(toRow),
};

fs.writeFileSync(OUT_JSON, JSON.stringify(jsonOut, null, 2), 'utf-8');
console.log(`✅ JSON 저장: ${path.basename(OUT_JSON)}`);

// ─────────── 콘솔 요약 ───────────
console.log(`\n[D+0~D+2 진입 판단 분포 — H그룹 ${hGroup.length}건]`);
const allStatuses = ['REVIEW_OK', 'CHASE_CAUTION', 'PULLBACK_WAIT', 'MANAGEMENT', 'BREAKDOWN_WEAK'];
const labels = { REVIEW_OK: '검토가능', CHASE_CAUTION: '추격주의', PULLBACK_WAIT: '눌림대기', MANAGEMENT: '관리구간', BREAKDOWN_WEAK: '돌파약화' };
for (const s of allStatuses) {
  const d0 = judgmentDist.D0[s] || 0;
  const d1 = judgmentDist.D1[s] || 0;
  const d2 = judgmentDist.D2[s] || 0;
  console.log(`  ${labels[s].padEnd(6)} D+0=${String(d0).padStart(3)} / D+1=${String(d1).padStart(3)} / D+2=${String(d2).padStart(3)}`);
}
console.log(`\n[REVIEW_OK 코호트 N=${reviewOkSummary.count}]`);
for (const h of FORWARD_HORIZONS) {
  const x = reviewOkSummary.byHorizon[h];
  if (!x) continue;
  console.log(`  D+${String(h).padStart(2)}  승률 ${String(x.winRate).padStart(5)}%  평균 ${String(x.mean).padStart(6)}%  중앙 ${String(x.median).padStart(6)}%  +10%↑ ${x.win10pctRate}%  -7%↓ ${x.loss7pctRate}%`);
}
console.log(`\n[비교: 돌파일 종가 매수 N=${breakoutSummary.count}]`);
for (const h of FORWARD_HORIZONS) {
  const x = breakoutSummary.byHorizon[h];
  if (!x) continue;
  console.log(`  D+${String(h).padStart(2)}  승률 ${String(x.winRate).padStart(5)}%  평균 ${String(x.mean).padStart(6)}%  중앙 ${String(x.median).padStart(6)}%`);
}
console.log(`\n[비교: QVA 신호 단독 매수 N=${qvaOnlySummary.count}]`);
for (const h of FORWARD_HORIZONS) {
  const x = qvaOnlySummary.byHorizon[h];
  if (!x) continue;
  console.log(`  D+${String(h).padStart(2)}  승률 ${String(x.winRate).padStart(5)}%  평균 ${String(x.mean).padStart(6)}%  중앙 ${String(x.median).padStart(6)}%`);
}

// ─────────── HTML 생성 ───────────
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>3단계 코호트 비교 — QVA / H그룹 / 진입가 근처</title>
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

  .info-box { background: #1e293b; padding: 12px 16px; border-radius: 8px; margin-bottom: 14px; border-left: 3px solid #60a5fa; }
  .info-box p { margin: 0 0 6px 0; font-size: 13px; line-height: 1.6; color: #cbd5e1; }
  .info-box p:last-child { margin-bottom: 0; }
  .info-box strong { color: #f1f5f9; }
  .info-box .warn { color: #fbbf24; }

  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 14px; }
  .stat { background: #1e293b; padding: 10px 12px; border-radius: 6px; border: 1px solid #334155; }
  .stat .lbl { color: #94a3b8; font-size: 11px; }
  .stat .val { color: #f1f5f9; font-size: 20px; font-weight: 700; margin-top: 2px; }
  .stat.hi { border-left: 3px solid #10b981; }
  .stat.lo { border-left: 3px solid #f87171; }
  .stat.mid { border-left: 3px solid #fbbf24; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; background: #1e293b; border-radius: 6px; overflow: hidden; margin-bottom: 12px; }
  th { background: #334155; color: #f1f5f9; padding: 8px 10px; text-align: right; font-weight: 600; font-size: 12px; }
  th.txt { text-align: left; }
  td { padding: 7px 10px; border-bottom: 1px solid #0f172a; text-align: right; color: #cbd5e1; }
  td.txt { text-align: left; }
  tr:hover td { background: #263449; }
  .pos { color: #6ee7b7; }
  .neg { color: #f87171; }
  .muted { color: #64748b; }
  .hi-row { background: #14532d22; }
  .market-K { color: #93c5fd; }
  .market-Q { color: #fbbf24; }

  .rule { background: #0f172a; padding: 10px 14px; border-radius: 6px; border: 1px solid #334155; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; line-height: 1.7; color: #cbd5e1; }
  .rule code { color: #fbbf24; }
</style>
</head>
<body>
  <h1>⭐ 3단계 코호트 비교 (요약본) <span class="sub">QVA 단독 / H그룹 / 진입가 근처 — 같은 1년 같은 척도</span></h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="nav">
    <a href="/qva-watchlist">📋 매일 운영 보드</a>
    <span style="color:#475569;font-size:11px;align-self:center;">검증 ▶</span>
    <a href="/qva-surge-day-report">단일일 급등</a>
    <a href="/qva-to-vvi-report">QVA → VVI 전환</a>
    <a href="/qva-vvi-breakout-entry-report">진입 검증</a>
    <a href="/qva-vvi-breakout-exit-report">익절/청산</a>
    <a href="/qva-review-ok-backtest-report" class="active">⭐ 3단계 코호트 비교</a>
  </div>

  <div class="info-box">
    <h3 style="margin:0 0 10px 0;color:#f1f5f9;font-size:15px;border:none;padding:0;">📌 보고서 안내</h3>
    <p><strong>이 보고서가 답하는 질문</strong></p>
    <p>QVA 단독 / H그룹(돌파 성공 확인 종목) / 진입가 근처(REVIEW_OK) — <strong>세 코호트의 20일 뒤 플러스 마감 비율</strong>을 같은 1년 기간에 같은 척도로 비교했을 때 차이가 있는가?</p>

    <p style="margin-top:10px;"><strong>📍 funnel에서의 위치</strong></p>
    <p style="font-size:12px;background:#0f172a;padding:8px 12px;border-radius:6px;border:1px solid #334155;">
      funnel <strong>전체(1단계 → 2단계 → 3단계)를 같은 표에서 비교한 요약본</strong>입니다. 다른 보고서들은 각 단계를 깊이 들여다보고, 이 보고서는 단계 간 차이를 한눈에 보여줍니다.
    </p>

    <p style="margin-top:10px;"><strong>📊 읽는 법</strong></p>
    <ul style="margin:4px 0;padding-left:20px;font-size:13px;line-height:1.7;color:#cbd5e1;">
      <li>세 코호트의 <strong>D+1 / D+3 / D+5 / D+10 / D+20 플러스 마감 비율</strong>과 평균/중앙값 수익률을 같은 줄에서 비교</li>
      <li>각 코호트의 표본 크기(N)도 함께 표시 — 표본 차이로 신뢰도 차이도 함께 보세요</li>
      <li>D+0~D+2 진입 판단 상태 분포 표 — 각 H그룹 이벤트가 돌파일/D+1/D+2에 어느 상태로 분류되는지</li>
      <li><strong>표본 정의:</strong> H그룹(=돌파 성공 확인 종목) 이벤트를 (code, vviDate) 단위로 dedup. 각 이벤트마다 돌파일 D+0~D+2를 walk-forward해서 라이브 규칙 그대로 진입 판단 상태를 재계산하고, 최초 '진입가 근처(REVIEW_OK)' 일자 종가에 매수했다고 가정.</li>
    </ul>

    <p style="margin-top:10px;"><strong>🎯 핵심 결과</strong></p>
    <p style="background:#0f172a;padding:10px 14px;border-radius:6px;border:1px solid #14532d;line-height:1.7;">
      <strong style="color:#fbbf24;">QVA 단독 56.2%</strong> → <strong style="color:#6ee7b7;">H그룹 71.0%</strong> → <strong style="color:#6ee7b7;">진입가 근처 71.4%</strong><br>
      funnel 단계가 진행될수록 좋은 흐름을 보인 비율이 높아졌으나, '진입가 근처' 필터는 H그룹 대비 추가 개선 효과가 미미(0.4%p)합니다.
      '진입가 근처'는 플러스 마감 비율을 높이는 필터가 아니라 <strong>추격 매수를 피하기 위한 위치 확인 기준</strong>입니다.
    </p>

    <p class="warn" style="margin-top:10px;">⚠️ 본 보고서는 매수 추천이 아닙니다. 단일 시장 사이클 데이터 기반이며, 손절·자금관리·시장 국면을 고려하지 않은 단순 보유 시뮬레이션입니다.</p>
  </div>

  <h2>판정 규칙 (라이브 워치리스트와 동일)</h2>
  <div class="rule">
    <code>entryPrice = vviHigh × 1.01</code><br>
    if <code>close &lt; entryPrice OR close &lt; vviHigh</code> → <strong>BREAKDOWN_WEAK (돌파약화)</strong><br>
    elif <code>close ≥ entryPrice × 1.15</code> → <strong>MANAGEMENT (관리구간)</strong><br>
    elif <code>close &gt; entryPrice × 1.07 OR daysFromBreakout ≥ 3</code> → <strong>PULLBACK_WAIT (눌림대기)</strong><br>
    elif <code>close &gt; entryPrice × 1.03</code> → <strong>CHASE_CAUTION (추격주의)</strong><br>
    else → <strong>REVIEW_OK (진입가 근처)</strong><br>
    ⇒ 즉 진입가 근처 = 돌파일 기준 D+0~D+2 + 종가가 entryPrice 이상이면서 +3% 이내
  </div>

  <h2>요약</h2>
  <div class="summary-grid" id="summary-grid"></div>

  <h2>D+0~D+2 진입 판단 상태 분포</h2>
  <p class="subtitle">각 H그룹 이벤트의 돌파일/D+1/D+2 종가에 대해 라이브 규칙으로 분류한 분포.</p>
  <table id="dist-table"><thead><tr>
    <th class="txt">상태</th><th>D+0</th><th>D+1</th><th>D+2</th>
  </tr></thead><tbody id="dist-tbody"></tbody></table>

  <h2>코호트별 성과 비교</h2>
  <p class="subtitle">진입가 근처 코호트 = 첫 진입가 근처(REVIEW_OK) 일자 종가에 매수. H그룹 코호트 = 돌파일 종가에 매수. QVA 단독 = QVA 신호일 종가에 매수.</p>
  <table id="cohort-table"><thead><tr>
    <th class="txt">코호트</th><th class="txt">기간</th>
    <th>N</th><th>플러스 마감 비율</th><th>평균%</th><th>중앙값%</th><th>최대</th><th>최저</th><th>+10%↑</th><th>-7%↓</th>
  </tr></thead><tbody id="cohort-tbody"></tbody></table>

  <h2>MFE / MAE (10거래일 윈도우)</h2>
  <table id="mfe-table"><thead><tr>
    <th class="txt">코호트</th><th class="txt">지표</th><th>평균</th><th>중앙</th><th>Q75 / Q25</th><th>Q90 / Q10</th>
  </tr></thead><tbody id="mfe-tbody"></tbody></table>

  <h2>진입가 근처 진입 일자 / 미도달 사유</h2>
  <div class="summary-grid" id="entry-dist"></div>

  <h2>TOP 5 사례 (진입가 근처 코호트, D+10 수익률 상위)</h2>
  <table id="top-table"><thead><tr>
    <th class="txt">종목</th><th class="txt">QVA일</th><th class="txt">VVI일</th><th class="txt">돌파일</th><th class="txt">매수일</th>
    <th>D+0~+</th><th>매수가</th><th>D+5</th><th>D+10</th><th>D+20</th><th>MFE10</th><th>MAE10</th>
  </tr></thead><tbody id="top-tbody"></tbody></table>

  <h2>WORST 5 사례 (진입가 근처 코호트, D+10 수익률 하위)</h2>
  <table id="worst-table"><thead><tr>
    <th class="txt">종목</th><th class="txt">QVA일</th><th class="txt">VVI일</th><th class="txt">돌파일</th><th class="txt">매수일</th>
    <th>D+0~+</th><th>매수가</th><th>D+5</th><th>D+10</th><th>D+20</th><th>MFE10</th><th>MAE10</th>
  </tr></thead><tbody id="worst-tbody"></tbody></table>

  <h2>전체 진입 내역 (${reviewOkEntries.length}건)</h2>
  <table id="all-table"><thead><tr>
    <th class="txt">종목</th><th class="txt">QVA일</th><th class="txt">VVI일</th><th class="txt">돌파일</th><th class="txt">매수일</th>
    <th>D+0~+</th><th>매수가</th><th>D+1</th><th>D+5</th><th>D+10</th><th>D+20</th><th>MFE10</th><th>MAE10</th>
  </tr></thead><tbody id="all-tbody"></tbody></table>

<script>
(function rewriteNavForFileProtocol(){
  if (location.protocol !== 'file:') return;
  const map = {
    '/qva-watchlist': 'qva-watchlist-board.html',
    '/qva-vvi-breakout-entry-report': 'qva-vvi-breakout-entry-report.html',
    '/qva-vvi-breakout-exit-report': 'qva-vvi-breakout-exit-report.html',
    '/qva-review-ok-backtest-report': 'qva-review-ok-backtest-report.html',
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
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }

document.getElementById('subtitle').textContent =
  '스캔 ' + fmtDate(DATA.meta.scanStart) + ' ~ ' + fmtDate(DATA.meta.scanEnd) +
  ' · H그룹 ' + DATA.hGroupCount + '건 (raw ' + DATA.hGroupRawCount + ' → dedup) · ' +
  '진입가 근처 코호트 ' + DATA.reviewOkSummary.count + '건 진입 · ' +
  '생성 ' + DATA.meta.generatedAt.slice(0, 19).replace('T', ' ');

// 요약 카드 — D+10/D+20 플러스 마감 비율을 가장 강조
function makeStat(label, val, cls) {
  return '<div class="stat ' + (cls || '') + '"><div class="lbl">' + label + '</div><div class="val">' + val + '</div></div>';
}
const r = DATA.reviewOkSummary.byHorizon;
const b = DATA.breakoutSummary.byHorizon;
document.getElementById('summary-grid').innerHTML = [
  makeStat('진입가 근처 N', DATA.reviewOkSummary.count + '건'),
  makeStat('D+1 플러스 마감', (r[1]?.winRate ?? '-') + '%', 'mid'),
  makeStat('D+5 플러스 마감', (r[5]?.winRate ?? '-') + '%', 'mid'),
  makeStat('D+10 플러스 마감', (r[10]?.winRate ?? '-') + '%', 'hi'),
  makeStat('D+20 플러스 마감', (r[20]?.winRate ?? '-') + '%', 'hi'),
  makeStat('D+10 평균%', (r[10]?.mean >= 0 ? '+' : '') + (r[10]?.mean ?? '-') + '%', 'hi'),
  makeStat('D+20 평균%', (r[20]?.mean >= 0 ? '+' : '') + (r[20]?.mean ?? '-') + '%', 'hi'),
  makeStat('비교: H그룹 D+10', (b[10]?.winRate ?? '-') + '%'),
  makeStat('비교: QVA 단독 D+10', (DATA.qvaOnlySummary.byHorizon[10]?.winRate ?? '-') + '%'),
].join('');

// 상태 분포
const STATUS_LABELS = { REVIEW_OK: '진입가 근처', CHASE_CAUTION: '추격주의', PULLBACK_WAIT: '눌림대기', MANAGEMENT: '관리구간', BREAKDOWN_WEAK: '돌파약화' };
const STATUS_ORDER = ['REVIEW_OK', 'CHASE_CAUTION', 'PULLBACK_WAIT', 'MANAGEMENT', 'BREAKDOWN_WEAK'];
document.getElementById('dist-tbody').innerHTML = STATUS_ORDER.map(s => {
  const d0 = DATA.judgmentDist.D0[s] || 0;
  const d1 = DATA.judgmentDist.D1[s] || 0;
  const d2 = DATA.judgmentDist.D2[s] || 0;
  return '<tr' + (s === 'REVIEW_OK' ? ' class="hi-row"' : '') + '>' +
    '<td class="txt">' + STATUS_LABELS[s] + '</td>' +
    '<td>' + d0 + '</td><td>' + d1 + '</td><td>' + d2 + '</td></tr>';
}).join('');

// 코호트 비교
function cohortRows(label, summary, hi) {
  return [1, 3, 5, 10, 20].map((h, i) => {
    const x = summary.byHorizon[h];
    if (!x) return '';
    const labelCol = i === 0 ? '<td class="txt" rowspan="5"><strong>' + label + '</strong><br><span class="muted">N=' + summary.count + '</span></td>' : '';
    const cls = (hi && (h === 10 || h === 20)) ? ' class="hi-row"' : '';
    return '<tr' + cls + '>' + labelCol +
      '<td class="txt">D+' + h + '</td>' +
      '<td>' + x.n + '</td>' +
      '<td><strong>' + x.winRate + '%</strong></td>' +
      '<td>' + fmtPct(x.mean, true) + '</td>' +
      '<td>' + fmtPct(x.median, true) + '</td>' +
      '<td>' + fmtPct(x.max, true) + '</td>' +
      '<td>' + fmtPct(x.min, true) + '</td>' +
      '<td>' + x.win10pctRate + '%</td>' +
      '<td>' + x.loss7pctRate + '%</td>' +
      '</tr>';
  }).join('');
}
document.getElementById('cohort-tbody').innerHTML =
  cohortRows('진입가 근처', DATA.reviewOkSummary, true) +
  cohortRows('비교: 돌파일 매수 (H그룹)', DATA.breakoutSummary, false) +
  cohortRows('비교: QVA 신호 단독 매수', DATA.qvaOnlySummary, false);

// MFE/MAE
function mfeRow(cohortLabel, kind, x) {
  if (!x) return '';
  return '<tr><td class="txt">' + cohortLabel + '</td>' +
    '<td class="txt">' + kind + '</td>' +
    '<td>' + fmtPct(x.mean, true) + '</td>' +
    '<td>' + fmtPct(x.median, true) + '</td>' +
    '<td>' + fmtPct(x.q75 != null ? x.q75 : x.q25, true) + '</td>' +
    '<td>' + fmtPct(x.q90 != null ? x.q90 : x.q10, true) + '</td></tr>';
}
document.getElementById('mfe-tbody').innerHTML = [
  mfeRow('진입가 근처', 'MFE10 (최대 미실현 이익)', DATA.reviewOkSummary.mfe10),
  mfeRow('진입가 근처', 'MAE10 (최대 미실현 손실)', DATA.reviewOkSummary.mae10),
  mfeRow('비교: 돌파일 매수', 'MFE10', DATA.breakoutSummary.mfe10),
  mfeRow('비교: 돌파일 매수', 'MAE10', DATA.breakoutSummary.mae10),
].join('');

// 진입일 분포 + 미도달 사유
const bd = DATA.buyDayDist; const nr = DATA.reasonsNoReviewOk;
document.getElementById('entry-dist').innerHTML = [
  makeStat('D+0 매수', bd[0] + '건', 'hi'),
  makeStat('D+1 매수', bd[1] + '건', 'mid'),
  makeStat('D+2 매수', bd[2] + '건', 'mid'),
  makeStat('미도달: 약화', nr.weak + '건', 'lo'),
  makeStat('미도달: 추격', nr.chase + '건', 'lo'),
  makeStat('미도달: 눌림', nr.pullback + '건', 'lo'),
  makeStat('미도달: 관리', nr.mgmt + '건', 'lo'),
].join('');

// 사례 테이블
function caseRow(d) {
  return '<tr>' +
    '<td class="txt"><span class="' + marketCls(d.market) + '">' + d.name + '</span> <span class="muted">' + d.code + '</span></td>' +
    '<td class="txt">' + fmtDate(d.qvaSignalDate) + '</td>' +
    '<td class="txt">' + fmtDate(d.vviDate) + '</td>' +
    '<td class="txt">' + fmtDate(d.breakoutDate) + '</td>' +
    '<td class="txt">' + fmtDate(d.buyDate) + '</td>' +
    '<td>D+' + d.daysFromBreakout + '</td>' +
    '<td>' + fmtNum(d.buyPrice) + '</td>' +
    '<td>' + fmtPct(d.d5, true) + '</td>' +
    '<td>' + fmtPct(d.d10, true) + '</td>' +
    '<td>' + fmtPct(d.d20, true) + '</td>' +
    '<td>' + fmtPct(d.mfe10, true) + '</td>' +
    '<td>' + fmtPct(d.mae10, true) + '</td>' +
    '</tr>';
}
document.getElementById('top-tbody').innerHTML = DATA.top5.map(caseRow).join('');
document.getElementById('worst-tbody').innerHTML = DATA.worst5.map(caseRow).join('');

// 전체 진입 (D+10 내림차순)
const allRows = [...DATA.reviewOkEntries].sort((a, b) => (b.d10 ?? -Infinity) - (a.d10 ?? -Infinity));
document.getElementById('all-tbody').innerHTML = allRows.map(d =>
  '<tr>' +
  '<td class="txt"><span class="' + marketCls(d.market) + '">' + d.name + '</span> <span class="muted">' + d.code + '</span></td>' +
  '<td class="txt">' + fmtDate(d.qvaSignalDate) + '</td>' +
  '<td class="txt">' + fmtDate(d.vviDate) + '</td>' +
  '<td class="txt">' + fmtDate(d.breakoutDate) + '</td>' +
  '<td class="txt">' + fmtDate(d.buyDate) + '</td>' +
  '<td>D+' + d.daysFromBreakout + '</td>' +
  '<td>' + fmtNum(d.buyPrice) + '</td>' +
  '<td>' + fmtPct(d.d1, true) + '</td>' +
  '<td>' + fmtPct(d.d5, true) + '</td>' +
  '<td>' + fmtPct(d.d10, true) + '</td>' +
  '<td>' + fmtPct(d.d20, true) + '</td>' +
  '<td>' + fmtPct(d.mfe10, true) + '</td>' +
  '<td>' + fmtPct(d.mae10, true) + '</td>' +
  '</tr>'
).join('');
</script>
</body>
</html>`;

fs.writeFileSync(OUT_HTML, html.replace('__JSON_DATA__', JSON.stringify(jsonOut)), 'utf-8');
console.log(`✅ HTML 저장: ${path.basename(OUT_HTML)}`);
console.log(`   라우트: /qva-review-ok-backtest-report`);
