#!/usr/bin/env node
/**
 * D+5 실전 운용 보드
 *
 * 목적:
 *   기존 H그룹/VPR 보드는 D+5 백테스트와 관찰용으로 그대로 유지하고, 이 보드는
 *   장중에 어떤 가격을 기준으로 관찰·대응할지 보여주는 별도 운용 화면이다.
 *
 *   종목을 등급화하지 않고, 기준선·전일 고가·추격 금지선·기준 이탈선을 함께 표시해
 *   사용자가 가격 기준으로 직접 판단할 수 있도록 한다.
 *
 * 입력:
 *   qva-watchlist-board.json (기존 H그룹 candidates, 수정하지 않음)
 *   cache/stock-charts-long/{code}.json (H돌파일 고/저 lookup)
 *
 * 출력:
 *   reports/hgroup-live-operation-board-result.json
 *   reports/hgroup-live-operation-board-result.html
 *
 * 라우트: /hgroup-live-operation
 *
 * UI 원칙 (사용자 spec 2026-05-06):
 *   1) 기존 H그룹/VPR 보드는 수정하지 않음
 *   2) 종목을 정예형/보수형/공격형 같은 그룹으로 나누지 않음
 *   3) 매수 확정/강력 매수/성공 같은 표현 금지
 *   4) marketBreadthScore는 필터로 쓰지 않음
 *   5) D+10 관련 문구 없음 — D+5 단기 운용만
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const BOARD_PATH = path.join(ROOT, 'qva-watchlist-board.json');
const OUT_JSON = path.join(REPORTS_DIR, 'hgroup-live-operation-board-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'hgroup-live-operation-board-result.html');

const MAX_DAYS = 5;  // D+5 이내만

function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}
function fmtNum(v) { return v != null ? Math.round(v).toLocaleString() : '-'; }
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8); }

function loadHbarFromChart(code, hDate) {
  const p = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const rows = j.rows || [];
    const r = rows.find(x => x.date === hDate);
    return r || null;
  } catch (_) { return null; }
}

function buildRunComment({
  vprMain, vprTags, currentPrice, baseClose, breakoutLine,
  signalHigh, chasingNoLine, distanceFromBasePct,
}) {
  const comments = [];
  // 1) 현재가가 breakoutLine 근처이고 거리 ≤10%
  const nearLine = currentPrice >= breakoutLine * 0.99 && currentPrice <= breakoutLine * 1.02;
  if (nearLine && distanceFromBasePct <= 10) {
    comments.push('기준선 근처에서 유지 여부를 확인할 수 있는 구간입니다.');
  }
  // 2) 현재가가 signalHigh 근처
  if (signalHigh && currentPrice >= signalHigh * 0.98 && currentPrice <= signalHigh * 1.02) {
    comments.push('전일 고가 재돌파 여부가 핵심입니다.');
  }
  // 3) 추격 금지선 이상
  if (chasingNoLine && currentPrice >= chasingNoLine) {
    comments.push('기준 종가 대비 많이 떠 있어 추격 위험이 큽니다.');
  }
  // 4) baseClose 아래
  if (currentPrice < baseClose) {
    comments.push('기준 종가를 이탈한 상태이므로 보류 관찰이 필요합니다.');
  }
  // 5) VPR 고가권 유지 + 위꼬리 적음 — 과거 D+5 검증 최상위 조건
  if (vprMain === 'HIGH_ZONE_HOLD' && (vprTags || []).includes('UPPER_WICK_SMALL')) {
    comments.push('과거 D+5 검증에서 가장 성과가 좋았던 조건 조합에 가까운 흐름입니다.');
  }
  return comments;
}

function main() {
  if (!fs.existsSync(BOARD_PATH)) {
    console.error('[ERROR] qva-watchlist-board.json 없음. 먼저 `node qva-watchlist-board.js` 실행.');
    process.exit(1);
  }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log('\n📊 D+5 실전 운용 보드 생성');

  const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf-8'));
  const hgroup = (board.stages?.BREAKOUT_SUCCESS || [])
    .filter(c => (c.daysFromBreakout ?? Infinity) <= MAX_DAYS);
  console.log(`  H그룹 (D+0~D+${MAX_DAYS}) 종목: ${hgroup.length}건`);

  const items = hgroup.map(c => {
    const baseClose = c.vprBaseClose || c.vviClose;
    const breakoutLine = c.vprBreakoutLine || (baseClose ? round(baseClose * 1.01) : null);
    // H돌파일 고/저 — 기존 board 데이터에 없으면 차트 캐시에서 보충
    let signalHigh = c.breakoutNextHigh ?? null;
    let signalLow = null;
    if (signalHigh == null || signalLow == null) {
      const hRow = loadHbarFromChart(c.code, c.breakoutDate);
      if (hRow) {
        signalHigh = signalHigh ?? hRow.high;
        signalLow = hRow.low;
      }
    }
    const currentPrice = c.currentClose;
    const entryDistancePct = (baseClose && currentPrice) ? round((currentPrice / baseClose - 1) * 100) : null;

    // 운용 가격 기준 4종
    const watchPriceLow = baseClose;            // 관찰가 하단
    const watchPriceHigh = breakoutLine;         // 관찰가 상단
    const breakoutConfirmPrice = (breakoutLine != null && signalHigh != null)
      ? Math.max(breakoutLine, signalHigh) : (breakoutLine ?? signalHigh ?? null);
    const chasingNoLine = (baseClose != null && breakoutLine != null)
      ? round(Math.min(baseClose * 1.08, breakoutLine * 1.06)) : null;
    const breakdownLine = baseClose;              // 기준 이탈선 (기본)
    const breakdownConservative = baseClose != null ? round(baseClose * 0.99) : null;

    const runComments = buildRunComment({
      vprMain: c.vprMain,
      vprTags: c.vprTags,
      currentPrice, baseClose, breakoutLine, signalHigh, chasingNoLine,
      distanceFromBasePct: entryDistancePct ?? Infinity,
    });

    return {
      code: c.code, name: c.name, market: c.market,
      breakoutDate: c.breakoutDate, daysFromBreakout: c.daysFromBreakout,
      vprMain: c.vprMain, vprMainLabel: c.vprMainLabel,
      vprTags: c.vprTags || [], vprTagLabels: c.vprTagLabels || [],
      baseClose, breakoutLine,
      signalHigh, signalLow,
      currentPrice,
      entryDistancePct,
      // 운용 가격 기준
      watchPriceLow, watchPriceHigh,
      breakoutConfirmPrice,
      chasingNoLine,
      breakdownLine, breakdownConservative,
      runComments,
    };
  });

  // 정렬: 돌파일 최신순 → D+ 작은 순
  items.sort((a, b) => {
    const da = a.breakoutDate || '00000000';
    const db = b.breakoutDate || '00000000';
    if (da !== db) return db.localeCompare(da);
    return (a.daysFromBreakout ?? 0) - (b.daysFromBreakout ?? 0);
  });

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'D+5 실전 운용 보드',
      purpose: '이 보드는 H그룹 발생 후 D+5 안의 단기 반응을 운용하기 위한 별도 화면입니다. 기존 H그룹/VPR 보드는 그대로 유지하며, 이 화면에서는 종목별로 기준선, 전일 고가, 추격 금지선, 기준 이탈선을 함께 보여주어 장중 판단을 돕습니다.',
      sourceBoard: 'qva-watchlist-board.json (BREAKOUT_SUCCESS 단계, D+0~D+5)',
      latestTradingDate: board.debugCounts?.latestTradingDate,
    },
    counts: {
      totalCandidates: hgroup.length,
      effective: items.length,
    },
    items,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // 콘솔 요약
  console.log(`\n=== 운용 가격 기준 ===`);
  for (const it of items) {
    console.log(`[${it.name} ${it.code}] D+${it.daysFromBreakout} VPR ${it.vprMainLabel || '-'} 거리 ${it.entryDistancePct}%`);
    console.log(`  관찰가:    ${fmtNum(it.watchPriceLow)} ~ ${fmtNum(it.watchPriceHigh)}원`);
    console.log(`  돌파 확인: ${fmtNum(it.breakoutConfirmPrice)}원 (max(기준선, 전일고))`);
    console.log(`  추격 금지: ${fmtNum(it.chasingNoLine)}원`);
    console.log(`  이탈선:    ${fmtNum(it.breakdownLine)}원 (보수 ${fmtNum(it.breakdownConservative)})`);
    console.log(`  현재가:    ${fmtNum(it.currentPrice)}원`);
    if (it.runComments.length) {
      for (const cm of it.runComments) console.log(`  💬 ${cm}`);
    }
    console.log('');
  }

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>D+5 실전 운용 보드</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px; -webkit-overflow-scrolling: touch;
}
nav { display:flex; gap:10px; flex-wrap:wrap; padding:8px 0 14px; border-bottom:1px solid #1e293b; margin-bottom:14px; }
nav a { color:#94a3b8; text-decoration:none; font-size:12px; padding:4px 8px; border-radius:4px; }
nav a:hover { color:#e2e8f0; background:#1e293b; }
nav a.active { color:#f1f5f9; background:#1e293b; }

h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #0f172a; border-left: 3px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #67e8f9; }
.warn { color:#fbbf24; }

.card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.card h3 { margin: 0 0 6px; font-size: 15px; color: #f1f5f9; font-weight: 700; }
.card .meta { font-size: 11px; color: #94a3b8; margin-bottom: 8px; }
.card .meta .badge { display:inline-block; padding:1px 6px; border-radius:3px; margin-right:4px; }
.card .meta .badge.vpr-HIGH_ZONE_HOLD       { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }
.card .meta .badge.vpr-ABOVE_BREAKOUT_LINE  { background: #134e4a; color: #5eead4; }
.card .meta .badge.vpr-ABOVE_BASE_CLOSE     { background: #312e81; color: #c7d2fe; }
.card .meta .badge.vpr-INTRADAY_PUSHBACK    { background: #422006; color: #fde047; border: 1px solid #ca8a04; }
.card .meta .badge.vpr-OVERHEATED_BREAKOUT  { background: #7c2d12; color: #fdba74; border: 1px solid #f97316; }
.card .meta .badge.aux                       { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; font-size: 10px; }

.price-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin: 8px 0; }
.price-cell { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; }
.price-cell .label { font-size: 11px; color: #94a3b8; margin-bottom: 2px; }
.price-cell .value { font-size: 14px; font-weight: 600; color: #e2e8f0; font-variant-numeric: tabular-nums; }
.price-cell .sub { font-size: 10px; color: #64748b; margin-top: 2px; }
.price-cell.line-watch     { border-left: 3px solid #38bdf8; }
.price-cell.line-confirm   { border-left: 3px solid #6ee7b7; }
.price-cell.line-chasing   { border-left: 3px solid #f59e0b; }
.price-cell.line-breakdown { border-left: 3px solid #ef4444; }
.price-cell.line-current   { border-left: 3px solid #c4b5fd; }

.dist-pos-near    { color: #6ee7b7; font-weight: 600; }
.dist-pos-mid     { color: #5eead4; }
.dist-pos-aggr    { color: #c7d2fe; }
.dist-pos-far     { color: #fdba74; }
.dist-neg         { color: #fca5a5; }

.run-comments { margin-top: 10px; padding: 8px 12px; background: #0f172a; border-left: 2px solid #475569; border-radius: 4px; font-size: 12px; line-height: 1.7; color: #cbd5e1; }
.run-comments .empty { color: #64748b; font-style: italic; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
.bt-table { width:100%; border-collapse:collapse; font-size:12px; font-variant-numeric: tabular-nums; }
.bt-table thead th { background:#1e293b; color:#94a3b8; padding:8px 10px; border-bottom:1px solid #334155; text-align:left; font-weight:600; font-size:11px; }
.bt-table tbody td { padding:7px 10px; border-bottom:1px solid #334155; color:#cbd5e1; }
.bt-table .num { text-align:right; }
.bt-row-base td { background:rgba(99,102,241,0.10); }
.bt-row-top td { background:rgba(110,231,183,0.06); color:#a7f3d0; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; }
  .price-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
</head>
<body>

<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드 (관찰용)</a>
  <a href="/hgroup-live-operation" class="active">🎯 D+5 실전 운용 보드</a>
  <a href="/vpr-trade-winrate">📊 VPR 매매 승률 백테스트</a>
  <a href="/vpr-market-breadth">📊 시장 환경 참고</a>
</nav>

<h1>🎯 D+5 실전 운용 보드</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  이 보드는 H그룹 발생 후 <strong>D+5 안의 단기 반응을 운용하기 위한 별도 화면</strong>입니다.
  기존 H그룹/VPR 보드는 그대로 유지하며, 이 화면에서는 종목별로
  <strong>기준선, 전일 고가, 추격 금지선, 기준 이탈선</strong>을 함께 보여주어 장중 판단을 돕습니다.
  <span class="warn">매수 추천이 아니라 가격 기준 안내입니다.</span>
</div>

<details open style="background:#0f172a;border:1px solid #334155;border-left:3px solid #94a3b8;border-radius:8px;padding:10px 14px;margin-bottom:14px;">
  <summary style="cursor:pointer;color:#cbd5e1;font-size:13px;">📊 D+5 백테스트 조합별 성과표 (참고)</summary>
  <p style="margin:6px 0 0 0;color:#94a3b8;font-size:11px;line-height:1.6;">
    💡 <strong>거리</strong> = 매수 시점 가격이 기준 종가에서 얼마나 떨어졌는지 %. 작을수록 추격 위험이 작습니다.
    이 표는 개별 종목의 매수 등급이 아니라 <em>과거 조건 조합별 성과 참고표</em>입니다.
  </p>
  <div style="margin-top:10px;overflow-x:auto;">
    <table class="bt-table">
      <thead>
        <tr><th>조합명</th><th>조건</th><th class="num">n</th><th class="num">승률</th><th class="num">매번 평균</th><th>해석</th></tr>
      </thead>
      <tbody>
        <tr class="bt-row-base"><td><strong>전체 H그룹</strong></td><td>전체</td><td class="num">448</td><td class="num">49.11%</td><td class="num">+0.26%</td><td>기준값</td></tr>
        <tr><td><strong>기본 조합</strong></td><td>거리 ≤10%</td><td class="num">334</td><td class="num">50.60%</td><td class="num">+0.40%</td><td>가장 넓은 기본 필터</td></tr>
        <tr><td><strong>공격 조합</strong></td><td>거리 ≤12% + VPR 기준선 위 이상 + 거래대금 동반</td><td class="num">252</td><td class="num">51.98%</td><td class="num">+0.68%</td><td>표본을 넓게 유지하면서 거래대금 동반을 보는 조합</td></tr>
        <tr><td><strong>보수 조합</strong></td><td>거리 ≤8% + 위꼬리 적음</td><td class="num">64</td><td class="num">59.38%</td><td class="num">+0.98%</td><td>거리와 위꼬리를 엄격하게 본 조합</td></tr>
        <tr class="bt-row-top"><td><strong>최상위 조합</strong></td><td>거리 ≤10% + VPR 고가권 유지 + 위꼬리 적음</td><td class="num">64</td><td class="num">59.38%</td><td class="num">+1.18%</td><td>검증상 가장 균형이 좋았던 조합</td></tr>
      </tbody>
    </table>
  </div>
</details>

<h2 id="header">📋 H그룹 D+5 이내 종목별 운용 가격 기준</h2>
<div id="cards"></div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtNum(v) { return v != null ? Math.round(v).toLocaleString() : '-'; }
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8); }
function fmtPct(v) {
  if (v == null) return '-';
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(2) + '%';
}
function distClass(v) {
  if (v == null) return '';
  if (v < 0) return 'dist-neg';
  if (v <= 8) return 'dist-pos-near';
  if (v <= 10) return 'dist-pos-mid';
  if (v <= 12) return 'dist-pos-aggr';
  return 'dist-pos-far';
}

document.getElementById('subtitle').textContent =
  'H그룹 D+0~D+5 종목 ' + DATA.counts.effective + '건 · ' +
  '기준일: ' + (DATA.meta.latestTradingDate ? fmtDate(DATA.meta.latestTradingDate) : '-') + ' · ' +
  '생성: ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

document.getElementById('header').textContent =
  '📋 H그룹 D+5 이내 종목별 운용 가격 기준 (' + DATA.counts.effective + '건)';

function renderCards() {
  const html = [];
  for (const it of DATA.items) {
    const tagsHtml = (it.vprTagLabels || []).map(t => '<span class="badge aux">' + t + '</span>').join('');
    const cmts = (it.runComments || []);
    const cmtsHtml = cmts.length
      ? cmts.map(c => '<div>💬 ' + c + '</div>').join('')
      : '<div class="empty">— 별도 운용 코멘트 없음 —</div>';
    html.push(
      '<div class="card">' +
        '<h3>' + (it.name || '') + ' <span style="color:#64748b;font-size:13px;font-weight:400;">' + it.code + '</span></h3>' +
        '<div class="meta">' +
          '<span class="badge" style="background:#1e293b;border:1px solid #334155;">돌파일 ' + fmtDate(it.breakoutDate) + ' · D+' + (it.daysFromBreakout ?? 0) + '</span>' +
          (it.vprMain ? ('<span class="badge vpr-' + it.vprMain + '">' + (it.vprMainLabel || it.vprMain) + '</span>') : '') +
          tagsHtml +
        '</div>' +
        '<div class="price-grid">' +
          '<div class="price-cell line-current">' +
            '<div class="label">현재가</div>' +
            '<div class="value">' + fmtNum(it.currentPrice) + '원</div>' +
            '<div class="sub">거리 <span class="' + distClass(it.entryDistancePct) + '">' + fmtPct(it.entryDistancePct) + '</span></div>' +
          '</div>' +
          '<div class="price-cell line-watch">' +
            '<div class="label">관찰가 (기준선 근처)</div>' +
            '<div class="value">' + fmtNum(it.watchPriceLow) + ' ~ ' + fmtNum(it.watchPriceHigh) + '</div>' +
            '<div class="sub">기준 종가 ~ 기준선</div>' +
          '</div>' +
          '<div class="price-cell line-confirm">' +
            '<div class="label">돌파 확인가</div>' +
            '<div class="value">' + fmtNum(it.breakoutConfirmPrice) + '원</div>' +
            '<div class="sub">max(기준선, 전일 고가)</div>' +
          '</div>' +
          '<div class="price-cell line-chasing">' +
            '<div class="label">추격 금지선</div>' +
            '<div class="value">' + fmtNum(it.chasingNoLine) + '원</div>' +
            '<div class="sub">min(기준 종가×1.08, 기준선×1.06)</div>' +
          '</div>' +
          '<div class="price-cell line-breakdown">' +
            '<div class="label">기준 이탈선</div>' +
            '<div class="value">' + fmtNum(it.breakdownLine) + '원</div>' +
            '<div class="sub">보수 ' + fmtNum(it.breakdownConservative) + ' · 전일 저가 참고 ' + fmtNum(it.signalLow) + '</div>' +
          '</div>' +
          '<div class="price-cell">' +
            '<div class="label">전일 고/저</div>' +
            '<div class="value">' + fmtNum(it.signalHigh) + ' / ' + fmtNum(it.signalLow) + '</div>' +
            '<div class="sub">H돌파일 고가/저가</div>' +
          '</div>' +
        '</div>' +
        '<div class="run-comments">' + cmtsHtml + '</div>' +
      '</div>'
    );
  }
  if (html.length === 0) {
    html.push('<div class="card" style="text-align:center;color:#64748b;">현재 D+5 이내 H그룹 종목이 없습니다.</div>');
  }
  document.getElementById('cards').innerHTML = html.join('');
}
renderCards();

document.getElementById('data-limit').innerHTML =
  '<strong>가격 기준 정의</strong><br>' +
  '• 관찰가 = 기준 종가 ~ 기준선 (= VVI 돌파대기일 종가 ~ ×1.01)<br>' +
  '• 돌파 확인가 = max(기준선, H돌파일 고가)<br>' +
  '• 추격 금지선 = min(기준 종가 × 1.08, 기준선 × 1.06)<br>' +
  '• 기준 이탈선 = 기준 종가 (보수 ×0.99, 참고 H돌파일 저가)<br>' +
  '• <strong>매수 추천이 아닙니다.</strong> 장중 판단 보조용 가격 기준선입니다.';
</script>

</body>
</html>
`;

main();
