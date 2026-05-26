// renderHtml 함수만 별도 파일에 작성 — 메인 파일에 inline됨.
// 이 파일은 generator 본문에 포함되며 단독 실행되지 않음.
const { getBoardNavHtml } = require('../../src/utils/boardNav');
module.exports = function renderHtml({ themesMap, themeStrength, latestDaily, result }) {
  const { strongThemes, midThemes, candidates, summary } = result;
  const themeKeys = Object.keys(themesMap);

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function fmtPct(v) { if (v == null || !Number.isFinite(v)) return '—'; return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
  function fmtValue(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 1e12) return (v/1e12).toFixed(1) + '조';
    if (v >= 1e8)  return (v/1e8).toFixed(0) + '억';
    if (v >= 1e4)  return (v/1e4).toFixed(0) + '만';
    return Math.round(v).toLocaleString();
  }

  // ─── 카드용 슬림 데이터 (JS 주입용) ────────────────────────────────────
  const cardsForJs = candidates.map(c => ({
    code: c.code, name: c.name,
    grade: c.grade, score: c.themeWatchScore,
    themeKey: c.bestThemeKey, themeLabel: c.bestThemeLabel || '—',
    themeStrength: c.bestThemeStrength || 'NONE',
    themeReason: c.bestThemeReason,
    themeAvgChange: c.bestAvgChange,
    matchedThemes: c.matchedThemes,
    hasQva1: c.hasQva1, qva1Date: c.qva1Date, qva1Score: c.qva1Score, qva1DaysAgo: c.qva1DaysAgo,
    hasQva2: c.hasQva2, qva2Date: c.qva2Date, qva2Score: c.qva2Score, qva2Type: c.qva2Type, qva2DaysAgo: c.qva2DaysAgo,
    hasVvi2: c.hasVvi2, vvi2Date: c.vvi2Date, vvi2DaysAgo: c.vvi2DaysAgo,
    hasOneds: c.hasOneDaySurge, onedsDate: c.oneDaySurgeDate, onedsScore: c.oneDaySurgeScore, onedsDaysAgo: c.oneDaySurgeDaysAgo,
    hasAnySignal: c.hasAnySignal,
    latestDate: c.latestDate, latestClose: c.latestClose, latestChangePct: c.latestChangePct,
    latestValue: c.latestValue, valueRatio20: c.valueRatio20,
    nearRecentHigh: c.nearRecentHigh, closeStrong: c.closeStrong, alreadyExtended: c.alreadyExtended,
    interpret: c.interpret,
  }));

  // themesMap 슬림 — JS에서 사용 (테마 select 옵션 + 강도 표시)
  const themesForJs = {};
  for (const k of themeKeys) {
    const t = themesMap[k];
    const td = themeStrength[k] || {};
    themesForJs[k] = {
      label: t.label || k,
      strength: td.strength || 'NONE',
      avgChangePct: td.avgChangePct ?? null,
      reason: td.reason || '',
    };
  }

  const totalCount = candidates.length;
  const qvaSignalCount = summary.qva1Candidates + summary.qva2Candidates;
  const recentSignalCount = summary.vvi2Candidates + summary.oneDaySurgeCandidates;

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>오늘 지켜볼 후보 — 전일 나스닥 테마 기반</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif; background: #0f172a; color: #cbd5e1; margin: 0; padding: 14px 18px 48px; max-width: 1500px; }
  h1 { color: #f1f5f9; font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #94a3b8; font-size: 12px; margin-bottom: 12px; }
  h2 { color: #5eead4; font-size: 16px; margin: 18px 0 8px; border-left: 3px solid #14b8a6; padding-left: 8px; }

  .note { background:#1e293b; border:1px solid #334155; color:#cbd5e1; padding:9px 13px; border-radius:6px; font-size:12px; margin: 8px 0 14px; line-height: 1.55; }
  .note b { color: #fde68a; }

  /* 요약 카드 */
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .stat { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 11px; }
  .stat .lbl { color: #94a3b8; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.2px; }
  .stat .val { color: #f1f5f9; font-size: 20px; font-weight: 700; margin-top: 2px; }
  .stat .sub { color: #94a3b8; font-size: 10.5px; margin-top: 2px; }

  /* 필터 바 — sticky */
  .filter-bar { position: sticky; top: 0; z-index: 10; background: #0f172a; padding: 10px 0 8px; border-bottom: 1px solid #334155; margin-bottom: 10px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .filter-bar label { display: flex; flex-direction: column; font-size: 10.5px; color: #94a3b8; }
  .filter-bar select { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 4px; padding: 4px 6px; font-size: 12px; min-width: 100px; margin-top: 2px; }
  .filter-bar button { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .filter-bar button:hover { background: #334155; }
  .filter-bar .meta-count { color: #94a3b8; font-size: 11.5px; margin-left: auto; }

  /* 탭 */
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid #334155; margin-bottom: 12px; }
  .tab { background: transparent; color: #94a3b8; border: none; padding: 8px 14px; cursor: pointer; font-size: 13px; font-weight: 600; border-bottom: 2px solid transparent; }
  .tab:hover { color: #cbd5e1; }
  .tab.active { color: #5eead4; border-bottom-color: #14b8a6; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* 카드 grid — PC 3열, tablet 2열, 모바일 1열 */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 8px; }

  /* 후보 카드 */
  .cand { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 9px 12px; transition: border-color 0.15s; }
  .cand.hidden { display: none; }
  .cand[data-grade="A"] { border-left: 3px solid #facc15; background: #1e293b; }
  .cand[data-grade="B"] { border-left: 3px solid #a78bfa; }
  .cand[data-grade="C"] { border-left: 3px solid #475569; }
  .cand[data-grade="D"] { border-left: 3px solid #334155; opacity: 0.7; }

  .cand .row1 { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .cand .stock-link { text-decoration: none; color: inherit; display: inline-flex; align-items: baseline; gap: 4px; padding: 1px 4px; margin: -1px -4px; border-radius: 3px; transition: background 0.12s; }
  .cand .stock-link:hover { background: rgba(94, 234, 212, 0.12); }
  .cand .stock-link:hover .name { color: #5eead4; text-decoration: underline; text-decoration-color: #14b8a6; text-underline-offset: 2px; }
  .cand .name { color: #f1f5f9; font-weight: 700; font-size: 14px; transition: color 0.12s; }
  .cand .code { color: #64748b; font-size: 10.5px; font-family: ui-monospace, monospace; margin-left: 4px; }
  .cand .score { color: #f1f5f9; font-weight: 700; font-size: 16px; }

  .cand .row2 { font-size: 11px; color: #94a3b8; margin: 4px 0; display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  .cand .pill { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 600; }
  .p-strong { background: #422006; color: #fcd34d; border: 1px solid #b45309; }
  .p-mid    { background: #1e1b4b; color: #c4b5fd; border: 1px solid #4338ca; }
  .p-weak   { background: #0f172a; color: #94a3b8; border: 1px solid #334155; }
  .p-down   { background: #4c1d1d; color: #fca5a5; border: 1px solid #ef4444; }
  .p-none   { background: #0f172a; color: #475569; border: 1px solid #334155; }

  .p-grade-a { background: #422006; color: #fcd34d; border: 1px solid #facc15; font-weight: 700; }
  .p-grade-b { background: #1e1b4b; color: #c4b5fd; border: 1px solid #a78bfa; font-weight: 600; }
  .p-grade-c { background: #0f172a; color: #94a3b8; border: 1px solid #475569; }
  .p-grade-d { background: #0f172a; color: #64748b; border: 1px solid #334155; }

  .p-qva1 { background: #052e16; color: #86efac; border: 1px solid #166534; }
  .p-qva2 { background: #1e1b4b; color: #c4b5fd; border: 1px solid #4338ca; }
  .p-vvi2 { background: #1e3a8a; color: #93c5fd; border: 1px solid #3b82f6; }
  .p-ods  { background: #064e3b; color: #a7f3d0; border: 1px solid #10b981; }

  .cand .interp { font-size: 11.5px; color: #cbd5e1; margin-top: 6px; padding-top: 6px; border-top: 1px solid #334155; line-height: 1.5; }
  .cand details { margin-top: 6px; }
  .cand details summary { cursor: pointer; color: #5eead4; font-size: 11px; font-weight: 600; padding: 3px 0; }
  .cand details summary:hover { color: #99f6e4; }
  .cand details .details-body { font-size: 11px; color: #cbd5e1; padding: 6px 8px; background: #0f172a; border-radius: 4px; margin-top: 4px; line-height: 1.6; }
  .cand details .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; }
  .cand details .kv .k { color: #94a3b8; }
  .cand details .kv .v { color: #cbd5e1; }

  .pos { color: #86efac; font-weight: 600; }
  .neg { color: #fca5a5; }

  /* 더보기 버튼 */
  .show-more { display: block; width: 100%; margin-top: 8px; padding: 8px; background: #1e293b; border: 1px dashed #475569; border-radius: 6px; color: #94a3b8; font-size: 12px; font-weight: 600; cursor: pointer; }
  .show-more:hover { color: #cbd5e1; border-color: #64748b; }

  /* 테마/신호별 details */
  .group { margin-bottom: 12px; }
  .group > summary { cursor: pointer; padding: 8px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #f1f5f9; font-weight: 600; font-size: 13px; list-style: none; display: flex; justify-content: space-between; align-items: center; }
  .group > summary::-webkit-details-marker { display: none; }
  .group > summary::before { content: '▶'; color: #5eead4; font-size: 10px; margin-right: 8px; transition: transform 0.15s; }
  .group[open] > summary::before { transform: rotate(90deg); display: inline-block; }
  .group > summary .count { color: #94a3b8; font-size: 11.5px; font-weight: 400; }
  .group .group-body { padding: 8px 0 4px; }

  .empty { padding: 14px; text-align: center; color: #94a3b8; font-size: 12.5px; background: rgba(0,0,0,0.25); border: 1px dashed #334155; border-radius: 6px; margin: 6px 0; }

  /* 수동 새로고침 박스 */
  .refresh-box { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 12px; margin: 10px 0 14px; }
  .refresh-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 11.5px; color: #cbd5e1; }
  .refresh-meta .refresh-label { color: #94a3b8; }
  .refresh-meta .refresh-value { color: #cbd5e1; font-variant-numeric: tabular-nums; }
  .refresh-meta .refresh-sep { color: #475569; }
  .refresh-meta .src-cron   { color: #93c5fd; }
  .refresh-meta .src-manual { color: #fcd34d; }
  .refresh-btn { margin-left: auto; background: #1e1b4b; color: #c4b5fd; border: 1px solid #4338ca; border-radius: 4px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.12s; }
  .refresh-btn:hover:not(:disabled) { background: #312e81; }
  .refresh-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .refresh-status { width: 100%; font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .refresh-status.ok   { color: #86efac; }
  .refresh-status.err  { color: #fca5a5; }
  .refresh-status.busy { color: #fcd34d; }

  /* 테마 강도 요약 표 */
  .theme-strength-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .theme-strength-table th, .theme-strength-table td { padding: 5px 8px; border-bottom: 1px solid #334155; text-align: left; }
  .theme-strength-table th { background: #0f172a; color: #5eead4; font-weight: 600; font-size: 10.5px; }
  .theme-strength-table td.num { text-align: right; font-variant-numeric: tabular-nums; }

  @media (max-width: 720px) {
    body { padding: 10px; }
    .cards { grid-template-columns: 1fr; }
    .filter-bar select { min-width: 80px; font-size: 11px; }
    .tab { padding: 7px 10px; font-size: 12px; }
  }
</style>
</head>
<body>

${getBoardNavHtml('/nasdaq-theme-watch')}

<h1>🌎 오늘 지켜볼 후보 — 전일 나스닥 테마 기반</h1>
<div class="subtitle">
  테마 기준일 ${esc(result.themeDate || '—')} · 미국장 ${esc(result.usMarketDate || '—')} · 생성 ${esc(result.generatedAt)}
</div>

<div class="refresh-box">
  <div class="refresh-meta">
    <span class="refresh-label">📅 마지막 ticker 갱신:</span>
    <span id="lastFetchedAt" class="refresh-value">${esc(result.themeFetchedAt || '—')}</span>
    <span class="refresh-sep">·</span>
    <span class="refresh-label">데이터 기준:</span>
    <span class="refresh-value ${result.triggerSource === 'manual' ? 'src-manual' : 'src-cron'}">${result.triggerSource === 'manual' ? '🖱 수동 새로고침' : '🤖 미국 정규장 마감 후 (cron)'}</span>
  </div>
  <button type="button" id="refreshNasdaqThemeBtn" class="refresh-btn" onclick="refreshNasdaqTheme()" title="FMP/Yahoo에서 ticker 데이터를 재수집하고 테마별 강도를 다시 계산합니다.">
    🔄 나스닥 테마 새로고침
  </button>
  <div id="refreshStatus" class="refresh-status"></div>
</div>

<div class="note">
  이 보드는 전일 미국장 강세 테마와 국내 수급 흔적을 연결해 <b>오늘 지켜볼 후보</b>를 정리한 화면입니다.
  매수 신호가 아니며, 실제 판단은 차트·뉴스·당일 흐름을 함께 확인해야 합니다.
  <br><b style="color:#fde68a;">이 보드는 전일 미국장 강세 테마와 매칭된 국내 종목만 표시합니다.</b> 테마 매칭이 없는 국내 QVA/VVI/1DS 후보는 기존 보드에서 확인하세요.
  <details style="margin-top:4px;"><summary style="cursor:pointer;color:#94a3b8;font-size:11px;">자세히</summary>
  <div style="margin-top:6px;font-size:11.5px;line-height:1.6;">
    출발점은 전일 미국장 테마. 그 테마와 연결되는 국내 종목 중 최근 QVA1/QVA2/VVI2/1DS 수급 흔적이 있는 종목을 score 합산해 등급화.
    데이터 출처: 미국 테마는 FMP/Yahoo 자동 fetch (수동 매핑), 국내 신호는 board_signals DB.
  </div></details>
</div>

<!-- 요약 카드 -->
<div class="summary">
  <div class="stat"><div class="lbl">STRONG 테마</div><div class="val" style="color:#fde047;">${strongThemes.length}</div></div>
  <div class="stat"><div class="lbl">MID 테마</div><div class="val" style="color:#c4b5fd;">${midThemes.length}</div></div>
  <div class="stat"><div class="lbl">🔥 A 최우선</div><div class="val" style="color:#facc15;">${summary.gradeA}</div></div>
  <div class="stat"><div class="lbl">⏳ B 우선</div><div class="val" style="color:#a78bfa;">${summary.gradeB}</div></div>
  <div class="stat"><div class="lbl">QVA1/QVA2 연결</div><div class="val">${qvaSignalCount}</div></div>
  <div class="stat"><div class="lbl">VVI2/1DS 연결</div><div class="val">${recentSignalCount}</div></div>
</div>

<details open style="margin-bottom:10px;"><summary style="cursor:pointer;color:#5eead4;font-size:12px;padding:4px 0;">📊 테마별 강도 요약</summary>
<table class="theme-strength-table">
  <thead><tr><th>테마</th><th>강도</th><th class="num">평균 등락</th><th>이유</th></tr></thead>
  <tbody>
  ${themeKeys.map(k => {
    const t = themesMap[k]; const td = themeStrength[k] || {};
    const s = td.strength || 'NONE';
    const cls = s === 'STRONG' ? 'p-strong' : s === 'MID' ? 'p-mid' : s === 'DOWN' ? 'p-down' : s === 'WEAK' ? 'p-weak' : 'p-none';
    return `<tr><td><b>${esc(t.label)}</b></td><td><span class="pill ${cls}">${esc(s)}</span></td><td class="num ${(td.avgChangePct||0) >= 0 ? 'pos' : 'neg'}">${fmtPct(td.avgChangePct)}</td><td style="color:#94a3b8;font-size:11px;">${esc(td.reason || '—')}</td></tr>`;
  }).join('')}
  </tbody>
</table>
</details>

<!-- 필터바 제거됨 — 기본 점수순 정렬 + 탭 전환으로만 그룹 변경 -->

<!-- 탭 -->
<div class="tabs">
  <button class="tab active" data-tab="today">🔥 오늘 볼 후보</button>
  <button class="tab" data-tab="by-theme">🎯 테마별 보기</button>
  <button class="tab" data-tab="by-signal">📡 신호별 보기</button>
  <button class="tab" data-tab="all">📋 전체 후보</button>
</div>

<!-- 탭 1: 오늘 볼 후보 (A/B) -->
<div class="tab-panel active" data-panel="today">
  <h2>오늘 볼 후보 (A/B 등급)</h2>
  <div id="panel-today-cards" class="cards"></div>
</div>

<!-- 탭 2: 테마별 -->
<div class="tab-panel" data-panel="by-theme">
  <h2>테마별 보기 — STRONG 펼침, 그 외 접힘</h2>
  <div id="panel-theme-groups"></div>
</div>

<!-- 탭 3: 신호별 -->
<div class="tab-panel" data-panel="by-signal">
  <h2>신호별 보기</h2>
  <div id="panel-signal-groups"></div>
</div>

<!-- 탭 4: 전체 -->
<div class="tab-panel" data-panel="all">
  <h2>전체 후보</h2>
  <details id="all-details"><summary style="cursor:pointer;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#f1f5f9;font-weight:600;">전체 후보 ${totalCount}건 펼치기</summary>
    <div id="panel-all-cards" class="cards" style="margin-top:8px;"></div>
  </details>
</div>

<footer style="margin-top: 20px; padding: 10px; background: #1e293b; border-radius: 6px; color: #64748b; font-size: 11px; text-align: center;">
  매수 신호 X · 차분 관찰용 화면 · 테마 매핑 수동 + 일일 강도 자동 fetch
</footer>

<script>
window.__CANDIDATES__ = ${JSON.stringify(cardsForJs)};
window.__THEMES__     = ${JSON.stringify(themesForJs)};
window.__STRONG__     = ${JSON.stringify(strongThemes)};
window.__MID__        = ${JSON.stringify(midThemes)};

// 등급 → 우선순위 (정렬용)
const GRADE_RANK = { A: 4, B: 3, C: 2, D: 1 };
const STRENGTH_RANK = { STRONG: 4, MID: 3, WEAK: 2, DOWN: 1, NONE: 0 };
const GRADE_LABEL = { A: '🔥 최우선', B: '⏳ 우선', C: '👀 후보', D: '📡 참고' };
const STRENGTH_LABEL_CLS = { STRONG: 'p-strong', MID: 'p-mid', WEAK: 'p-weak', DOWN: 'p-down', NONE: 'p-none' };

const LIMIT_TODAY = 15, LIMIT_THEME = 5, LIMIT_SIGNAL = 10;

function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmtPct(v, p) { if (v == null || !isFinite(v)) return '—'; const n = (typeof p === 'number') ? p : 2; return (v > 0 ? '+' : '') + Number(v).toFixed(n) + '%'; }
function fmtVal(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1e12) return (v/1e12).toFixed(1) + '조';
  if (v >= 1e8)  return (v/1e8).toFixed(0) + '억';
  if (v >= 1e4)  return (v/1e4).toFixed(0) + '만';
  return Math.round(v).toLocaleString();
}

// 카드 1개 HTML
function cardHtml(c) {
  const sCls = STRENGTH_LABEL_CLS[c.themeStrength] || 'p-none';
  const gCls = 'p-grade-' + c.grade.toLowerCase();
  const signals = [];
  if (c.hasQva1)  signals.push('<span class="pill p-qva1">QVA1 ' + (c.qva1DaysAgo!=null ? c.qva1DaysAgo+'d전' : '') + '</span>');
  if (c.hasQva2)  signals.push('<span class="pill p-qva2">QVA2 ' + (c.qva2DaysAgo!=null ? c.qva2DaysAgo+'d전' : '') + '</span>');
  if (c.hasVvi2)  signals.push('<span class="pill p-vvi2">VVI2 ' + (c.vvi2DaysAgo!=null ? c.vvi2DaysAgo+'d전' : '') + '</span>');
  if (c.hasOneds) signals.push('<span class="pill p-ods">1DS ' + (c.onedsDaysAgo!=null ? c.onedsDaysAgo+'d전' : '') + '</span>');
  if (!c.hasAnySignal) signals.push('<span class="pill p-none">신호 없음 (테마 직접)</span>');

  const details = [];
  if (c.qva1Date)   details.push('<div class="k">QVA1</div><div class="v">' + c.qva1Date + ' · ' + (c.qva1Score||0) + 'p</div>');
  if (c.qva2Date)   details.push('<div class="k">QVA2</div><div class="v">' + c.qva2Date + ' · ' + (c.qva2Score||0) + 'p' + (c.qva2Type ? ' · '+c.qva2Type : '') + '</div>');
  if (c.vvi2Date)   details.push('<div class="k">VVI2</div><div class="v">' + c.vvi2Date + '</div>');
  if (c.onedsDate)  details.push('<div class="k">1DS</div><div class="v">' + c.onedsDate + ' · ' + (c.onedsScore||0) + 'p</div>');
  if (c.latestDate) details.push('<div class="k">최근일</div><div class="v">' + c.latestDate + ' · close ' + (c.latestClose||'—') + ' · ' + fmtPct(c.latestChangePct) + '</div>');
  if (c.latestValue != null) details.push('<div class="k">거래대금</div><div class="v">' + fmtVal(c.latestValue) + (c.valueRatio20 ? ' (20일 평균 ×' + c.valueRatio20 + ')' : '') + '</div>');
  details.push('<div class="k">테마 매칭</div><div class="v">' + escHtml(c.themeLabel) + ' (' + c.themeStrength + (c.themeAvgChange!=null ? ', 평균 '+fmtPct(c.themeAvgChange) : '') + ')</div>');
  if (c.themeReason) details.push('<div class="k">테마 이유</div><div class="v" style="font-style:italic;">' + escHtml(c.themeReason) + '</div>');
  if (c.nearRecentHigh)  details.push('<div class="k">⚠</div><div class="v">60일 고가 근처</div>');
  if (c.closeStrong)     details.push('<div class="k">✓</div><div class="v">강한 종가</div>');
  if (c.alreadyExtended) details.push('<div class="k">⚠</div><div class="v" style="color:#fca5a5;">이미 신고가권 — 추격 주의</div>');

  // data-* 속성: 필터/정렬용
  const dataSignals = [];
  if (c.hasQva1)  dataSignals.push('QVA1');
  if (c.hasQva2)  dataSignals.push('QVA2');
  if (c.hasVvi2)  dataSignals.push('VVI2');
  if (c.hasOneds) dataSignals.push('ODS');
  if (!c.hasAnySignal) dataSignals.push('NONE');

  const matchedThemes = (c.matchedThemes || []).join(',');

  return '<div class="cand" data-code="' + escHtml(c.code) + '" data-grade="' + c.grade + '"'
    + ' data-theme="' + escHtml(c.themeKey || '') + '"'
    + ' data-matched-themes="' + escHtml(matchedThemes) + '"'
    + ' data-strength="' + c.themeStrength + '"'
    + ' data-signals="' + dataSignals.join(',') + '"'
    + ' data-score="' + c.score + '"'
    + ' data-recent="' + Math.min(c.qva1DaysAgo??999, c.qva2DaysAgo??999, c.vvi2DaysAgo??999, c.onedsDaysAgo??999) + '"'
    + ' data-value="' + (c.latestValue || 0) + '"'
    + ' data-change="' + (c.latestChangePct || 0) + '"'
    + ' data-strength-rank="' + (STRENGTH_RANK[c.themeStrength] || 0) + '">'
    + '<div class="row1"><div>'
    + '<a href="/stock/' + escHtml(c.code) + '?from=nasdaq-theme-watch" target="_blank" rel="noopener" class="stock-link" title="새 창에서 상세 페이지 열기">'
    + '<span class="name">' + escHtml(c.name) + '</span><span class="code">' + escHtml(c.code) + '</span>'
    + '</a>'
    + '</div>'
    + '<div class="score">' + c.score + '</div></div>'
    + '<div class="row2">'
    + '<span class="pill ' + gCls + '">' + GRADE_LABEL[c.grade] + '</span>'
    + '<span class="pill ' + sCls + '">' + escHtml(c.themeLabel) + ' ' + c.themeStrength + '</span>'
    + signals.join('')
    + '</div>'
    + '<div class="interp">' + escHtml(c.interpret || '') + '</div>'
    + (details.length ? '<details><summary>상세 보기</summary><div class="details-body"><div class="kv">' + details.join('') + '</div></div></details>' : '')
    + '</div>';
}

// 후보 목록 — 점수 내림차순 (필터 제거, 단순 정렬)
function getFiltered() {
  return window.__CANDIDATES__.slice().sort((a, b) => b.score - a.score);
}
function updateMetaCount() { /* no-op (필터바 제거) */ }

// ─── 탭 렌더 ──────────────────────────────────────────────────────────
function renderTodayTab() {
  const filtered = getFiltered().filter(c => c.grade === 'A' || c.grade === 'B');
  const container = document.getElementById('panel-today-cards');
  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty">필터 조건에 맞는 A/B 등급 후보 없음</div>';
    updateMetaCount(filtered.length);
    return;
  }
  const shown = filtered.slice(0, LIMIT_TODAY);
  const hidden = filtered.slice(LIMIT_TODAY);
  container.innerHTML = shown.map(cardHtml).join('') +
    (hidden.length ? '<button class="show-more" onclick="expandTodayMore(this)">+ ' + hidden.length + '건 더 보기</button>' : '');
  container._hidden = hidden;
  updateMetaCount(filtered.length);
}
function expandTodayMore(btn) {
  const container = document.getElementById('panel-today-cards');
  const hidden = container._hidden || [];
  btn.outerHTML = hidden.map(cardHtml).join('');
}

function renderByThemeTab() {
  const filtered = getFiltered();
  const container = document.getElementById('panel-theme-groups');
  // 강도 정렬: STRONG → MID → WEAK → DOWN → NONE
  const themeOrder = Object.keys(window.__THEMES__).slice().sort((a, b) => {
    const sa = STRENGTH_RANK[window.__THEMES__[a].strength] || 0;
    const sb = STRENGTH_RANK[window.__THEMES__[b].strength] || 0;
    return sb - sa;
  });
  const blocks = [];
  for (const themeKey of themeOrder) {
    const t = window.__THEMES__[themeKey];
    const list = filtered.filter(c => (c.matchedThemes||[]).indexOf(themeKey) >= 0);
    const isOpen = t.strength === 'STRONG' && list.length > 0;
    const sCls = STRENGTH_LABEL_CLS[t.strength] || 'p-none';
    const shown = list.slice(0, LIMIT_THEME);
    const hidden = list.slice(LIMIT_THEME);
    const bodyHtml = list.length > 0
      ? ('<div class="cards">' + shown.map(cardHtml).join('') + '</div>' +
         (hidden.length ? '<button class="show-more" data-hidden-count="' + hidden.length + '" onclick="expandThemeMore(this,\\''+themeKey+'\\')">+ ' + hidden.length + '건 더 보기</button>' : ''))
      : ('<div class="empty">관련 국내 종목 매핑이 없거나 최근 수급 흔적이 없음 — 테마 강도만 참고</div>');
    blocks.push(
      '<details class="group"' + (isOpen ? ' open' : '') + ' data-theme="' + themeKey + '">' +
      '<summary><span>' + escHtml(t.label) + ' <span class="pill ' + sCls + '">' + t.strength + '</span></span>' +
      '<span class="count">' + list.length + '건</span></summary>' +
      '<div class="group-body">' + bodyHtml + '</div></details>'
    );
  }
  container.innerHTML = blocks.join('') || '<div class="empty">필터 조건에 맞는 테마 후보 없음</div>';
  // hidden 데이터를 dom에 attach
  for (const themeKey of themeOrder) {
    const t = window.__THEMES__[themeKey];
    const list = filtered.filter(c => (c.matchedThemes||[]).indexOf(themeKey) >= 0);
    if (list.length > LIMIT_THEME) {
      const det = container.querySelector('details[data-theme="' + themeKey + '"]');
      if (det) det._hidden = list.slice(LIMIT_THEME);
    }
  }
  updateMetaCount(filtered.length);
}
function expandThemeMore(btn, themeKey) {
  const det = btn.closest('details');
  const hidden = det._hidden || [];
  const cardsContainer = det.querySelector('.cards');
  cardsContainer.insertAdjacentHTML('beforeend', hidden.map(cardHtml).join(''));
  btn.remove();
}

function renderBySignalTab() {
  const filtered = getFiltered();
  const groups = [
    { key: 'QVA2', label: 'QVA2 흔적 있음', pred: c => c.hasQva2 },
    { key: 'QVA1', label: 'QVA1 흔적 있음', pred: c => c.hasQva1 },
    { key: 'VVI2', label: 'VVI2 있음', pred: c => c.hasVvi2 },
    { key: 'ODS',  label: '1DS 있음', pred: c => c.hasOneds },
    { key: 'NONE', label: '신호 없음이지만 테마 직접 매칭', pred: c => !c.hasAnySignal },
  ];
  const container = document.getElementById('panel-signal-groups');
  const blocks = [];
  for (const g of groups) {
    const list = filtered.filter(g.pred);
    if (list.length === 0) continue;
    const shown = list.slice(0, LIMIT_SIGNAL);
    const hidden = list.slice(LIMIT_SIGNAL);
    blocks.push(
      '<details class="group" open data-signal="' + g.key + '">' +
      '<summary><span>' + escHtml(g.label) + '</span><span class="count">' + list.length + '건</span></summary>' +
      '<div class="group-body"><div class="cards">' + shown.map(cardHtml).join('') + '</div>' +
      (hidden.length ? '<button class="show-more" onclick="expandSignalMore(this,\\''+g.key+'\\')">+ ' + hidden.length + '건 더 보기</button>' : '') +
      '</div></details>'
    );
  }
  container.innerHTML = blocks.join('') || '<div class="empty">필터 조건에 맞는 신호 후보 없음</div>';
  for (const g of groups) {
    const list = filtered.filter(g.pred);
    if (list.length > LIMIT_SIGNAL) {
      const det = container.querySelector('details[data-signal="' + g.key + '"]');
      if (det) det._hidden = list.slice(LIMIT_SIGNAL);
    }
  }
  updateMetaCount(filtered.length);
}
function expandSignalMore(btn, key) {
  const det = btn.closest('details');
  const hidden = det._hidden || [];
  const cardsContainer = det.querySelector('.cards');
  cardsContainer.insertAdjacentHTML('beforeend', hidden.map(cardHtml).join(''));
  btn.remove();
}

function renderAllTab() {
  const filtered = getFiltered();
  const container = document.getElementById('panel-all-cards');
  container.innerHTML = filtered.map(cardHtml).join('') || '<div class="empty">필터 조건에 맞는 후보 없음</div>';
  // summary text update
  const det = document.getElementById('all-details');
  if (det) {
    const sum = det.querySelector('summary');
    if (sum) sum.textContent = '전체 후보 ' + filtered.length + '건 펼치기';
  }
  updateMetaCount(filtered.length);
}

// ─── 탭 전환 ──────────────────────────────────────────────────────────
const TAB_RENDERERS = {
  'today':     renderTodayTab,
  'by-theme':  renderByThemeTab,
  'by-signal': renderBySignalTab,
  'all':       renderAllTab,
};
let activeTab = 'today';

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  TAB_RENDERERS[name]();
}

// ─── 수동 새로고침 ────────────────────────────────────────────────────
let refreshPolling = null;
async function refreshNasdaqTheme() {
  const msg = '나스닥 테마 새로고침을 실행합니다. FMP/Yahoo에서 ticker 데이터를 재수집하고 테마별 강도를 다시 계산합니다. 30~90초 정도 걸릴 수 있습니다.';
  if (!confirm(msg)) return;
  const btn = document.getElementById('refreshNasdaqThemeBtn');
  const sts = document.getElementById('refreshStatus');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 새로고침 중...'; }
  if (sts) { sts.className = 'refresh-status busy'; sts.textContent = '🔄 요청 전송 중...'; }
  try {
    const resp = await fetch('/admin/refresh-nasdaq-theme', { method: 'POST', credentials: 'same-origin' });
    if (resp.status === 401 || resp.redirected) {
      alert('관리자 로그인이 필요합니다. /admin/login 에서 로그인 후 다시 시도하세요.');
      if (btn) { btn.disabled = false; btn.textContent = '🔄 나스닥 테마 새로고침'; }
      if (sts) { sts.className = 'refresh-status err'; sts.textContent = '⚠ 관리자 로그인 필요'; }
      return;
    }
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error('HTTP ' + resp.status + ' ' + t.slice(0, 120));
    }
    const data = await resp.json();
    if (data.running) {
      if (sts) { sts.className = 'refresh-status busy'; sts.textContent = '⏳ 이미 실행 중 — ' + (data.message || ''); }
      pollNasdaqThemeStatus();
      return;
    }
    if (!data.ok) {
      throw new Error(data.message || '시작 실패');
    }
    if (sts) { sts.className = 'refresh-status busy'; sts.textContent = '✅ 백그라운드 시작됨 — phase 확인 중...'; }
    pollNasdaqThemeStatus();
  } catch (err) {
    if (sts) { sts.className = 'refresh-status err'; sts.textContent = '❌ 실패: ' + err.message; }
    if (btn) { btn.disabled = false; btn.textContent = '🔄 나스닥 테마 새로고침'; }
    alert('새로고침 실패: ' + err.message);
  }
}
function pollNasdaqThemeStatus() {
  if (refreshPolling) clearInterval(refreshPolling);
  let ticks = 0;
  refreshPolling = setInterval(async () => {
    ticks += 1;
    if (ticks > 60) { // 5분 타임아웃 (5s × 60)
      clearInterval(refreshPolling);
      const sts = document.getElementById('refreshStatus');
      if (sts) { sts.className = 'refresh-status err'; sts.textContent = '⚠ 타임아웃 — 페이지를 새로고침해서 결과 확인'; }
      return;
    }
    try {
      const r = await fetch('/admin/nasdaq-theme-status', { credentials: 'same-origin' });
      if (!r.ok) return;
      const s = await r.json();
      const sts = document.getElementById('refreshStatus');
      if (s.running) {
        if (sts) { sts.className = 'refresh-status busy'; sts.textContent = '⏳ phase: ' + (s.phase || '...') + ' (' + (ticks * 5) + 's 경과)'; }
      } else {
        clearInterval(refreshPolling);
        if (s.lastError) {
          if (sts) { sts.className = 'refresh-status err'; sts.textContent = '❌ 실패: ' + s.lastError; }
          const btn = document.getElementById('refreshNasdaqThemeBtn');
          if (btn) { btn.disabled = false; btn.textContent = '🔄 나스닥 테마 새로고침'; }
        } else {
          if (sts) { sts.className = 'refresh-status ok'; sts.textContent = '✅ 완료 — 3초 후 화면 새로고침'; }
          setTimeout(() => { location.reload(); }, 3000);
        }
      }
    } catch (_) { /* ignore — 다음 tick에서 재시도 */ }
  }, 5000);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  switchTab('today');
});
</script>
</body></html>`;
};
