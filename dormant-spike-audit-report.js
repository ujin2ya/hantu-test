#!/usr/bin/env node
/**
 * 휴면 후 거래대금 폭발 감사 보고서
 *
 * 목적:
 *   QVA2가 정의상 잡지 못하는 "휴면 종목의 첫 거래대금 폭발 + 신고가/고점권 진입" 패턴이
 *   이후 실제로 의미 있는 반응을 보였는지 검증한다.
 *   QVA2(고점 대비 조정 자리에서 돈 들어오는 첫 흔적)와 별개의 성격.
 *
 *   별도 감사일 뿐 보드/라우트는 만들지 않는다.
 *
 * 조건 (사용자 spec, 2026-05-10):
 *   - 시총 500억 이상 / ETF·우선주·스팩·특수상품 제외
 *   - avg20Value < 10억 (직전 20일 평균 거래대금 휴면 수준)
 *   - todayValue ≥ 10억 (당일 거래대금 폭발 floor)
 *   - valueRatio ≥ 10 (당일 거래대금 / median20 ≥ 10배)
 *   - volumeRatio ≥ 5
 *   - pricePosition60 ≥ 0.60 OR distanceFromHigh60 ≤ 15 (고점권/신고가 영역)
 *   - changePct > 0 (전일 종가 대비 상승, 양봉 마감)
 *
 * 출력:
 *   reports/dormant-spike-audit-result.{html,json}
 *
 * 환경변수:
 *   - DORMANT_AUDIT_DAYS (기본 180) — 과거 N 거래일 윈도우 시뮬레이션
 *   - DORMANT_AUDIT_MAX_MARKETCAP (기본 5e12)
 *
 * 기존 QVA/QVA2/VVI/VPR 모두 무수정.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CHART_DIR   = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST  = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON    = path.join(REPORTS_DIR, 'dormant-spike-audit-result.json');
const OUT_HTML    = path.join(REPORTS_DIR, 'dormant-spike-audit-result.html');

const AUDIT_DAYS    = Number(process.env.DORMANT_AUDIT_DAYS || 180);
const MAX_MARKETCAP = Number(process.env.DORMANT_AUDIT_MAX_MARKETCAP || 5e12);

// 조건 임계값
const CONFIG = Object.freeze({
  marketCapMin: 50_000_000_000,        // 500억
  avgValue20MaxForDormant: 1_000_000_000,  // < 10억 (휴면)
  todayValueMin: 1_000_000_000,        // ≥ 10억
  valueRatioMin: 10,                   // median 대비 ≥ 10배
  volumeRatioMin: 5,                   // ≥ 5배
  // 위치: 둘 중 하나만 만족
  minPricePosition60: 0.60,
  maxDistanceFromHigh60: 15,
});

function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}
function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 0 ? (s[n / 2 - 1] + s[n / 2]) / 2 : s[Math.floor(n / 2)];
}

function loadMetaMap() {
  if (!fs.existsSync(NAVER_LIST)) return new Map();
  try {
    const j = JSON.parse(fs.readFileSync(NAVER_LIST, 'utf-8'));
    const m = new Map();
    for (const s of (j.stocks || [])) {
      if (!s.code) continue;
      m.set(s.code, { code: s.code, name: s.name, market: s.market, marketValue: s.marketValue || 0, isEtf: !!s.isEtf, isSpecial: !!s.isSpecial });
    }
    return m;
  } catch (_) { return new Map(); }
}

function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}

/** 한 종목, 한 일자에 대해 휴면→폭발 조건 평가 */
function evaluate(rows, idx, meta) {
  if (idx < 60 || idx >= rows.length) return null;
  const today = rows[idx];
  const prev = rows[idx - 1];
  if (!today.close || !prev.close) return null;
  const close = today.close;
  const high = today.high, low = today.low;
  const todayVolume = today.volume || 0;
  const todayValue  = today.valueApprox || (close * todayVolume) || 0;
  const changePct = ((close / prev.close) - 1) * 100;

  // 직전 20일 통계
  const prev20 = rows.slice(idx - 20, idx);
  const avg20Value = prev20.reduce((s, r) => s + (r.valueApprox || 0), 0) / prev20.length;
  const med20Vol = median(prev20.map(r => r.volume || 0));
  const med20Val = median(prev20.map(r => r.valueApprox || 0));

  // 60일 위치
  const last60 = rows.slice(Math.max(0, idx - 59), idx + 1);
  const high60 = Math.max(...last60.map(r => r.high));
  const low60  = Math.min(...last60.map(r => r.low));
  const range60 = high60 - low60;
  const pricePosition60 = range60 > 0 ? (close - low60) / range60 : 1;
  const distanceFromHigh60 = high60 > 0 ? ((high60 - close) / high60) * 100 : 0;

  const valueRatio = med20Val > 0 ? todayValue / med20Val : 0;
  const volumeRatio = med20Vol > 0 ? todayVolume / med20Vol : 0;
  const candleRange = high - low;
  const closeLocation = candleRange > 0 ? (close - low) / candleRange : 0.5;

  const cond = {
    dormant:        avg20Value < CONFIG.avgValue20MaxForDormant,
    todayFloor:     todayValue >= CONFIG.todayValueMin,
    valueExplosion: valueRatio >= CONFIG.valueRatioMin,
    volumeExplosion: volumeRatio >= CONFIG.volumeRatioMin,
    inHighZone:     pricePosition60 >= CONFIG.minPricePosition60 || distanceFromHigh60 <= CONFIG.maxDistanceFromHigh60,
    bullish:        changePct > 0,
  };
  const passed = cond.dormant && cond.todayFloor && cond.valueExplosion && cond.volumeExplosion && cond.inHighZone && cond.bullish;
  if (!passed) return null;

  return {
    date: today.date, idx,
    open: today.open, high, low, close, prevClose: prev.close,
    changePct: +changePct.toFixed(2),
    todayVolume, todayValue,
    avg20Value: Math.round(avg20Value),
    med20Vol: Math.round(med20Vol), med20Val: Math.round(med20Val),
    valueRatio: +valueRatio.toFixed(2),
    volumeRatio: +volumeRatio.toFixed(2),
    closeLocation: +closeLocation.toFixed(3),
    high60, low60,
    pricePosition60: +pricePosition60.toFixed(3),
    distanceFromHigh60: +distanceFromHigh60.toFixed(2),
    cond,
  };
}

/** 시그널 발생 후 outcome */
function computeOutcomes(rows, idx) {
  const sigClose = rows[idx].close;
  if (!sigClose) return null;
  const out = {
    closePctD5: null, closePctD10: null, closePctD20: null,
    mfeD20: null, maeD20: null,
    hitPlus10: false, hitPlus20: false, hitPlus30: false,
    drop5First: false, drop10First: false,
    daysAvailable: 0,
    peakDate: null, peakDayOffset: null, peakReturnPct: null,
  };

  for (const h of [5, 10, 20]) {
    const j = idx + h;
    if (j < rows.length && rows[j]?.close) {
      out[`closePctD${h}`] = +(((rows[j].close / sigClose) - 1) * 100).toFixed(2);
      if (h > out.daysAvailable) out.daysAvailable = h;
    }
  }

  let mfe = -Infinity, mae = Infinity;
  let firstHit10 = -1, firstHit20 = -1, firstHit30 = -1;
  let firstDrop5 = -1, firstDrop10 = -1;
  let peakClose = sigClose, peakIdx = idx;
  for (let i = idx + 1; i <= Math.min(rows.length - 1, idx + 20); i++) {
    const r = rows[i];
    if (!r) continue;
    const hr = ((r.high / sigClose) - 1) * 100;
    const lr = ((r.low  / sigClose) - 1) * 100;
    if (hr > mfe) mfe = hr;
    if (lr < mae) mae = lr;
    if (hr >= 10 && firstHit10 < 0) firstHit10 = i;
    if (hr >= 20 && firstHit20 < 0) firstHit20 = i;
    if (hr >= 30 && firstHit30 < 0) firstHit30 = i;
    if (lr <= -5  && firstDrop5  < 0) firstDrop5  = i;
    if (lr <= -10 && firstDrop10 < 0) firstDrop10 = i;
    if (r.close > peakClose) { peakClose = r.close; peakIdx = i; }
  }
  if (Number.isFinite(mfe)) out.mfeD20 = +mfe.toFixed(2);
  if (Number.isFinite(mae)) out.maeD20 = +mae.toFixed(2);
  out.hitPlus10 = firstHit10 >= 0;
  out.hitPlus20 = firstHit20 >= 0;
  out.hitPlus30 = firstHit30 >= 0;
  out.drop5First  = firstDrop5  >= 0 && (firstHit10 < 0 || firstDrop5  < firstHit10);
  out.drop10First = firstDrop10 >= 0 && (firstHit10 < 0 || firstDrop10 < firstHit10);
  if (peakIdx > idx) {
    out.peakDate = rows[peakIdx].date;
    out.peakDayOffset = peakIdx - idx;
    out.peakReturnPct = +(((peakClose / sigClose) - 1) * 100).toFixed(2);
  }
  return out;
}

function avg(arr, key) {
  const xs = arr.map(e => e[key]).filter(v => v != null && Number.isFinite(v));
  if (!xs.length) return null;
  return +(xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(2);
}
function rate(arr, pred) {
  if (!arr.length) return null;
  return +((arr.filter(pred).length / arr.length) * 100).toFixed(1);
}

function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`\n📊 휴면 후 거래대금 폭발 감사 (윈도우 ${AUDIT_DAYS}거래일)`);

  const metaMap = loadMetaMap();
  const codes = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  console.log(`  스캔 대상: ${codes.length}개 chart`);

  const events = [];
  let scanned = 0;
  for (const code of codes) {
    const meta = metaMap.get(code);
    if (!meta) continue;
    if (meta.isEtf || meta.isSpecial) continue;
    if (!meta.marketValue || meta.marketValue < CONFIG.marketCapMin || meta.marketValue > MAX_MARKETCAP) continue;
    const chart = loadChart(code);
    if (!chart || !chart.rows || chart.rows.length < 80) continue;
    scanned++;
    const rows = chart.rows;
    // 최근 시그널도 잡되 outcome은 가능한 만큼만 (computeOutcomes가 부분 outcome 처리).
    const lastValid = rows.length - 1;
    const start = Math.max(60, lastValid - AUDIT_DAYS + 1);
    if (start > lastValid) continue;
    for (let i = start; i <= lastValid; i++) {
      const sig = evaluate(rows, i, meta);
      if (!sig) continue;
      const out = computeOutcomes(rows, i);
      if (!out) continue;
      events.push({
        code, name: meta.name, market: meta.market, marketValue: meta.marketValue,
        ...sig, ...out,
      });
    }
  }
  console.log(`  scanned=${scanned} / 시그널: ${events.length}건`);

  // 정렬 — 신호일 최신
  events.sort((a, b) => b.date.localeCompare(a.date));

  // 요약 통계
  const stats = {
    n: events.length,
    avg_closeD5:  avg(events, 'closePctD5'),
    avg_closeD10: avg(events, 'closePctD10'),
    avg_closeD20: avg(events, 'closePctD20'),
    avg_mfeD20:   avg(events, 'mfeD20'),
    avg_maeD20:   avg(events, 'maeD20'),
    hitPlus10_pct: rate(events, e => e.hitPlus10),
    hitPlus20_pct: rate(events, e => e.hitPlus20),
    hitPlus30_pct: rate(events, e => e.hitPlus30),
    drop5First_pct:  rate(events, e => e.drop5First),
    drop10First_pct: rate(events, e => e.drop10First),
    closePos_D10: rate(events, e => e.closePctD10 != null && e.closePctD10 > 0),
    closePos_D20: rate(events, e => e.closePctD20 != null && e.closePctD20 > 0),
  };

  // 전 종목 시그널 수 dedup count
  const codeCount = new Map();
  for (const e of events) codeCount.set(e.code, (codeCount.get(e.code) || 0) + 1);

  const out = {
    meta: {
      title: '휴면 후 거래대금 폭발 감사 보고서',
      subtitle: '직전 20일 거래대금이 휴면 수준이었지만 당일 거래대금이 폭발하고 가격이 고점권/신고가에 진입한 케이스의 후속 반응 검증',
      generatedAt: new Date().toISOString(),
      auditDays: AUDIT_DAYS,
      maxMarketcap: MAX_MARKETCAP,
      stocksScanned: scanned,
      totalEvents: events.length,
      uniqueStocks: codeCount.size,
      thresholds: CONFIG,
    },
    stats,
    events,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  console.log(`\n  요약:`);
  console.log(`    n = ${stats.n} (unique 종목 ${codeCount.size}개)`);
  console.log(`    평균 D+5/10/20 close: ${stats.avg_closeD5}% / ${stats.avg_closeD10}% / ${stats.avg_closeD20}%`);
  console.log(`    평균 MFE D+20: ${stats.avg_mfeD20}% / 평균 MAE D+20: ${stats.avg_maeD20}%`);
  console.log(`    +10%/+20%/+30% 도달률: ${stats.hitPlus10_pct}% / ${stats.hitPlus20_pct}% / ${stats.hitPlus30_pct}%`);
  console.log(`    -5% 먼저 하락 / -10% 먼저 하락: ${stats.drop5First_pct}% / ${stats.drop10First_pct}%`);
  console.log(`    종가 양수율 D+10/D+20: ${stats.closePos_D10}% / ${stats.closePos_D20}%`);
  console.log(`\n  TOP 10 최근 시그널:`);
  for (const e of events.slice(0, 10)) {
    console.log(`    ${fmtDate(e.date)} | ${e.code} ${(e.name || '').padEnd(13)} | val ${Math.round(e.todayValue/1e8)}억 (×${e.valueRatio}) | Δ ${e.changePct}% | pricePos60 ${(e.pricePosition60*100).toFixed(0)}% / distHigh60 ${e.distanceFromHigh60}% | D+10 ${e.closePctD10 ?? '?'}% / D+20 ${e.closePctD20 ?? '?'}% / MFE ${e.mfeD20 ?? '?'}%`);
  }
  console.log(`  elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

function buildHtml(data) {
  return HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(data));
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>휴면 후 거래대금 폭발 감사</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin:0 auto; padding:18px 24px 80px; max-width:1500px;
  font-family:-apple-system,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR",sans-serif;
  background:#0f172a; color:#e2e8f0; font-size:13px;
}
h1 { font-size:22px; margin:6px 0 4px; color:#f1f5f9; font-weight:700; }
.exp-pill { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; background:#3f1d05; color:#fdba74; border:1px solid #f97316; margin-left:8px; vertical-align:middle; font-weight:600; }
.subtitle { font-size:13px; color:#94a3b8; margin-bottom:14px; line-height:1.6; }
.purpose-box { background:#0f172a; border-left:3px solid #f97316; padding:12px 16px; border-radius:6px; margin-bottom:14px; line-height:1.7; color:#cbd5e1; font-size:13px; }
.purpose-box strong { color:#fdba74; }
.summary-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:10px; margin-bottom:18px; }
.summary-cell { background:#1e293b; border:1px solid #334155; border-radius:8px; padding:10px 14px; }
.summary-cell .label { font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.4px; }
.summary-cell .value { font-size:22px; font-weight:700; color:#f1f5f9; font-variant-numeric:tabular-nums; margin-top:4px; }
.summary-cell.pos { border-left:4px solid #22c55e; }
.summary-cell.warn { border-left:4px solid #fbbf24; }
.summary-cell.neg { border-left:4px solid #ef4444; }

h2 { font-size:16px; margin:22px 0 10px; color:#cbd5e1; }

table { width:100%; border-collapse:collapse; margin-bottom:18px; font-size:11.5px; }
table th, table td { padding:6px 8px; border-bottom:1px solid #1e293b; }
table th { color:#94a3b8; text-align:left; font-size:10.5px; background:#0f172a; position:sticky; top:0; }
table td { color:#cbd5e1; font-variant-numeric:tabular-nums; }
table td.code { color:#94a3b8; }
table td.name a { color:#f1f5f9; text-decoration:none; }
table td.name a:hover { color:#fdba74; }
.cell-pos { color:#6ee7b7; }
.cell-neg { color:#fca5a5; }
.cell-warn { color:#fbbf24; }

footer.foot { margin-top:30px; padding:14px; background:#1e293b; border-radius:8px; font-size:12px; color:#94a3b8; line-height:1.7; }
</style>
</head>
<body>
<h1>📊 휴면 후 거래대금 폭발 감사 <span class="exp-pill">감사 보고서</span></h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  <strong>대상:</strong> 직전 20일 평균 거래대금이 10억 미만(휴면)이었지만, 당일 거래대금이 10억 이상으로 폭발하고 (median 대비 ×10 이상),
  거래량이 ×5 이상 늘었으며, 가격이 60일 고점 영역(pricePosition60 ≥ 0.60 또는 고점 -15% 이내)에서 양봉 마감한 케이스.
  <br><br>
  <strong>QVA2와의 차이:</strong> QVA2는 "고점 대비 충분히 내려온 자리"가 핵심 — 본 감사는 그 반대편 ("휴면 → 폭발 + 신고가/고점권 진입") 패턴.
  팬젠 2026-04-15 같은 케이스. 보드 라인이 아니라 후속 반응 검증용.
</div>

<h2>🎯 전체 요약</h2>
<div class="summary-grid" id="summary-grid"></div>

<h2>📋 시그널 목록 (신호일 최신순)</h2>
<div style="overflow-x:auto;"><table id="events-table"></table></div>

<footer class="foot" id="foot"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}
function fmtMarketcap(v) { if (!v) return '-'; if (v >= 1e12) return (v / 1e12).toFixed(1) + '조'; if (v >= 1e8) return Math.round(v / 1e8) + '억'; return v; }
function pctClass(v) { if (v == null) return ''; return v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : ''); }

document.getElementById('subtitle').textContent =
  '윈도우 ' + DATA.meta.auditDays + '거래일 · 스캔 종목 ' + DATA.meta.stocksScanned + ' · 시그널 ' + DATA.meta.totalEvents + '건 (unique ' + DATA.meta.uniqueStocks + '종목) · 생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

const s = DATA.stats;
const sg = document.getElementById('summary-grid');
sg.innerHTML = [
  cell('pos', '시그널 수', s.n),
  cell(s.avg_closeD10 > 0 ? 'pos' : 'neg', '평균 D+10 종가', (s.avg_closeD10 ?? 0) + '%'),
  cell(s.avg_closeD20 > 0 ? 'pos' : 'neg', '평균 D+20 종가', (s.avg_closeD20 ?? 0) + '%'),
  cell('pos', '평균 MFE D+20', (s.avg_mfeD20 ?? 0) + '%'),
  cell('warn', '평균 MAE D+20', (s.avg_maeD20 ?? 0) + '%'),
  cell(s.hitPlus10_pct >= 50 ? 'pos' : 'warn', '+10% 도달률', (s.hitPlus10_pct ?? 0) + '%'),
  cell(s.hitPlus20_pct >= 30 ? 'pos' : 'warn', '+20% 도달률', (s.hitPlus20_pct ?? 0) + '%'),
  cell(s.hitPlus30_pct >= 15 ? 'pos' : 'warn', '+30% 도달률', (s.hitPlus30_pct ?? 0) + '%'),
  cell('warn', '-5% 먼저 하락', (s.drop5First_pct ?? 0) + '%'),
  cell('neg', '-10% 먼저 하락', (s.drop10First_pct ?? 0) + '%'),
  cell('warn', '종가 양수율 D+10', (s.closePos_D10 ?? 0) + '%'),
  cell('warn', '종가 양수율 D+20', (s.closePos_D20 ?? 0) + '%'),
].join('');

function cell(cls, label, value) {
  return '<div class="summary-cell ' + cls + '"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
}

const headers = ['신호일','종목','코드','시총','당일거래대금','val×','vol×','Δ','pricePos60','distHigh60','D+5','D+10','D+20','MFE D+20','MAE D+20','+10%','+20%','+30%','-5% 먼저','-10% 먼저'];
let html = '<thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>';
for (const e of DATA.events) {
  html += '<tr>' +
    '<td>' + fmtDate(e.date) + '</td>' +
    '<td class="name"><a href="/stock/' + e.code + '">' + (e.name || e.code) + '</a></td>' +
    '<td class="code">' + e.code + '</td>' +
    '<td>' + fmtMarketcap(e.marketValue) + '</td>' +
    '<td>' + Math.round(e.todayValue/1e8) + '억</td>' +
    '<td class="cell-pos">×' + e.valueRatio + '</td>' +
    '<td class="cell-pos">×' + e.volumeRatio + '</td>' +
    '<td class="cell-pos">+' + e.changePct + '%</td>' +
    '<td>' + Math.round(e.pricePosition60*100) + '%</td>' +
    '<td>-' + e.distanceFromHigh60 + '%</td>' +
    '<td class="' + pctClass(e.closePctD5) + '">' + (e.closePctD5 != null ? e.closePctD5 + '%' : '-') + '</td>' +
    '<td class="' + pctClass(e.closePctD10) + '">' + (e.closePctD10 != null ? e.closePctD10 + '%' : '-') + '</td>' +
    '<td class="' + pctClass(e.closePctD20) + '">' + (e.closePctD20 != null ? e.closePctD20 + '%' : '-') + '</td>' +
    '<td class="cell-pos">' + (e.mfeD20 != null ? '+' + e.mfeD20 + '%' : '-') + '</td>' +
    '<td class="cell-neg">' + (e.maeD20 != null ? e.maeD20 + '%' : '-') + '</td>' +
    '<td>' + (e.hitPlus10 ? '✓' : '·') + '</td>' +
    '<td>' + (e.hitPlus20 ? '✓' : '·') + '</td>' +
    '<td>' + (e.hitPlus30 ? '✓' : '·') + '</td>' +
    '<td>' + (e.drop5First ? '<span class="cell-warn">⚠</span>' : '·') + '</td>' +
    '<td>' + (e.drop10First ? '<span class="cell-neg">✗</span>' : '·') + '</td>' +
    '</tr>';
}
html += '</tbody>';
document.getElementById('events-table').innerHTML = html;

document.getElementById('foot').innerHTML =
  '<strong>임계값:</strong> avg20 < ' + (DATA.meta.thresholds.avgValue20MaxForDormant/1e8) + '억 / today ≥ ' + (DATA.meta.thresholds.todayValueMin/1e8) + '억 / valR ≥ ' + DATA.meta.thresholds.valueRatioMin + ' / volR ≥ ' + DATA.meta.thresholds.volumeRatioMin + ' / pricePos60 ≥ ' + DATA.meta.thresholds.minPricePosition60 + ' OR distHigh60 ≤ ' + DATA.meta.thresholds.maxDistanceFromHigh60 + '% / changePct > 0 / 시총 ≥ ' + (DATA.meta.thresholds.marketCapMin/1e8) + '억.' +
  '<br>임계값은 dormant-spike-audit-report.js의 CONFIG에서 조정.';
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}

module.exports = { main };
