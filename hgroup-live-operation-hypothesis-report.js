#!/usr/bin/env node
/**
 * D+5 실전 운용 가설 검증 보고서
 *
 * 목적:
 *   D+5 실전 운용 보드(`/d5`)에 넣을 가격 기준이 실제 성과를 개선하는지 4가지 가설로 검증.
 *   매수 추천 아닌 통계 검증. n≥50이고 승률·매번 평균 동시 개선되는 조건만 추천.
 *
 * 검증 가설:
 *   1) 전일 고가 재돌파형     — D+1~D+5 안에 H돌파일 고가 재돌파 여부
 *   2) 첫 눌림 회복형         — D+1~D+3 눌림 + breakoutLine 재회복
 *   3) 장초반 갭 제한형       — D+1 시가 갭 % 구간별 성과
 *   4) H그룹 과다일 희소성    — 같은 날 H그룹 발생 수 구간별 성과
 *
 * 입력: reports/vpr-hgroup-three-year-with-flow-backtest-result.json (이벤트 448건)
 *       cache/stock-charts-long/{code}.json
 *
 * 출력:
 *   reports/hgroup-live-operation-hypothesis-result.json
 *   reports/hgroup-live-operation-hypothesis-result.html
 *
 * 라우트: /hgroup-live-operation-hypothesis  (별칭 /d5-hyp)
 */

const fs = require('fs');
const path = require('path');
const vprAnalyzer = require('./vpr-analyzer');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INPUT_PATH = path.join(REPORTS_DIR, 'vpr-hgroup-three-year-with-flow-backtest-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'hgroup-live-operation-hypothesis-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'hgroup-live-operation-hypothesis-result.html');

const HOLD_DAYS = 5;  // D+5 단기 운용

// ─── 헬퍼 ───
function round(v, d = 2) { if (v == null || !Number.isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function mean(arr) { const v = arr.filter(x => x != null && Number.isFinite(x)); if (v.length === 0) return null; return v.reduce((s, x) => s + x, 0) / v.length; }
function rate(num, denom) { if (!denom) return null; return round(num / denom * 100, 2); }
function pct(num, denom) { if (!denom) return null; return num / denom; }

// ─── 이벤트별 D+5 성과 측정 ───
// 진입 = H돌파일 종가 (D+0 close). hold = 5거래일 (D+1~D+5).
function computeMetrics(rows, hIdx, baseClose, signalHigh, signalLow) {
  const hClose = rows[hIdx]?.close;
  if (!hClose || !rows[hIdx + 1]) return null;
  const day1 = rows[hIdx + 1];

  let mfe = -Infinity, mae = Infinity;
  let highMax = -Infinity, lowMin = Infinity;
  let touchedBelowBase = false;
  let crossedAboveBreakout = null;  // 재돌파한 첫 날 (relative idx) — 사용 안 하면 그냥 boolean
  let rebrokeSignalHigh = false;
  let rebrokeSignalHighDayIdx = null;
  let pullbackHappened = false;     // breakoutLine or baseClose 근처 눌림 발생 여부
  let pullbackToBaseClose = false;
  let pullbackBelowBaseClose = false;
  let recoveredAboveBreakoutLine = false;  // 눌림 후 재회복

  const breakoutLine = baseClose * 1.01;
  let lastClose = hClose;

  for (let k = 1; k <= HOLD_DAYS; k++) {
    const r = rows[hIdx + k];
    if (!r) break;
    const high = r.high, low = r.low, cl = r.close;
    if (high > highMax) highMax = high;
    if (low < lowMin) lowMin = low;
    mfe = Math.max(mfe, (high / hClose - 1) * 100);
    mae = Math.min(mae, (low / hClose - 1) * 100);
    if (low < baseClose) touchedBelowBase = true;
    // 재돌파: 종가가 signalHigh 위로 마감
    if (!rebrokeSignalHigh && cl >= signalHigh) {
      rebrokeSignalHigh = true;
      rebrokeSignalHighDayIdx = k;
    }
    // 눌림: low가 baseClose 근처 또는 아래
    if (k <= 3 && low <= breakoutLine) pullbackHappened = true;
    if (k <= 3 && low <= baseClose * 1.005) pullbackToBaseClose = true;
    if (k <= 3 && low < baseClose) pullbackBelowBaseClose = true;
    // 재회복: 종가가 breakoutLine 위로 다시 마감 (눌림 발생 후)
    if (pullbackHappened && cl >= breakoutLine) recoveredAboveBreakoutLine = true;
    lastClose = cl;
  }

  const close5 = (lastClose / hClose - 1) * 100;
  const reach3 = highMax >= hClose * 1.03;
  const reach5 = highMax >= hClose * 1.05;
  const reachM3 = lowMin <= hClose * 0.97;  // -3% 도달
  const baseClosePathBreached = touchedBelowBase;
  // 시간초과: TP1 +6% 미달 AND SL -5% 미히트 → 5일간 의미 없는 흐름
  const timeStuck = (mfe < 6) && (mae > -5);

  return {
    hClose, day1Open: day1.open, day1High: day1.high, day1Low: day1.low, day1Close: day1.close,
    mfe5: round(mfe), mae5: round(mae),
    close5: round(close5),
    reach3, reach5, reachMinus3: reachM3,
    breachedBaseClose: baseClosePathBreached,
    rebrokeSignalHigh,
    rebrokeSignalHighDayIdx,
    pullbackHappened,
    pullbackToBaseClose,
    pullbackBelowBaseClose,
    recoveredAboveBreakoutLine,
    timeStuck,
    win: close5 > 0,
  };
}

// ─── 그룹 통계 ───
function summarize(rows) {
  const valid = rows.filter(r => r != null);
  if (valid.length === 0) return { n: 0 };
  const close5s = valid.map(r => r.close5);
  const wins = valid.filter(r => r.win).length;
  return {
    n: valid.length,
    winRate: round(wins / valid.length * 100),
    avgClose5: round(mean(close5s)),
    avgMFE5: round(mean(valid.map(r => r.mfe5))),
    avgMAE5: round(mean(valid.map(r => r.mae5))),
    reach3Rate: rate(valid.filter(r => r.reach3).length, valid.length),
    reach5Rate: rate(valid.filter(r => r.reach5).length, valid.length),
    breachRate: rate(valid.filter(r => r.breachedBaseClose).length, valid.length),
    timeStuckRate: rate(valid.filter(r => r.timeStuck).length, valid.length),
  };
}

// ─── 메인 ───
function main() {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error('[ERROR] 입력 없음:', INPUT_PATH);
    process.exit(1);
  }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  console.log('\n📊 D+5 실전 운용 가설 검증');

  const inputData = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const events = inputData.events || [];
  console.log(`  입력 이벤트: ${events.length}건`);

  // 이벤트별 측정 + 메타 부착
  const trades = [];
  for (const e of events) {
    const chartPath = path.join(CHART_DIR, `${e.code}.json`);
    if (!fs.existsSync(chartPath)) continue;
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8')); } catch (_) { continue; }
    const rows = chart.rows || [];
    const hIdx = rows.findIndex(r => r.date === e.hDate);
    const vviIdx = rows.findIndex(r => r.date === e.vviDate);
    if (hIdx < 0 || vviIdx < 0) continue;
    const hRow = rows[hIdx];
    const vviRow = rows[vviIdx];
    if (!hRow || !vviRow) continue;
    const baseClose = vviRow.close;
    const signalHigh = hRow.high;
    const signalLow = hRow.low;
    const breakoutLine = baseClose * 1.01;

    const metrics = computeMetrics(rows, hIdx, baseClose, signalHigh, signalLow);
    if (!metrics) continue;

    const vpr = vprAnalyzer.analyzeBreakoutReaction({ vviIdx, breakoutIdx: hIdx }, rows);
    if (!vpr || !vpr.vprMain) continue;

    // 갭 % (D+1 시가 / baseClose)
    const gapPct = baseClose > 0 ? round((metrics.day1Open / baseClose - 1) * 100) : null;

    trades.push({
      code: e.code, name: e.name, market: e.market,
      hDate: e.hDate, vviDate: e.vviDate,
      baseClose, signalHigh, signalLow, breakoutLine,
      vprMain: vpr.vprMain, vprMainLabel: vpr.vprMainLabel,
      vprTags: vpr.vprTags || [],
      gapPct,
      ...metrics,
    });
  }
  console.log(`  실효 trade: ${trades.length}건`);

  // ───────────────────── 가설 1: 전일 고가 재돌파형 ─────────────────────
  // VPR이 고가권 유지 또는 기준선 위 마감인 그룹 안에서 재돌파 vs 미재돌파
  const h1Pool = trades.filter(t => ['HIGH_ZONE_HOLD', 'ABOVE_BREAKOUT_LINE'].includes(t.vprMain));
  const h1Results = [
    { key: 'BASE', label: '베이스 (전체 H그룹)', subset: trades },
    { key: 'POOL', label: 'VPR 고가권/기준선 위 (전체)', subset: h1Pool },
    { key: 'REBR', label: '재돌파 있음', subset: h1Pool.filter(t => t.rebrokeSignalHigh) },
    { key: 'NO_REBR', label: '재돌파 없음', subset: h1Pool.filter(t => !t.rebrokeSignalHigh) },
    { key: 'REBR_VOL', label: '재돌파 + 거래대금 동반(H돌파일)', subset: h1Pool.filter(t => t.rebrokeSignalHigh && (t.vprTags.includes('VOLUME_SUPPORT') || t.vprTags.includes('VOLUME_EXPLOSION'))) },
    { key: 'REBR_WICK', label: '재돌파 + 위꼬리 적음(H돌파일)', subset: h1Pool.filter(t => t.rebrokeSignalHigh && t.vprTags.includes('UPPER_WICK_SMALL')) },
  ].map(r => ({ ...r, ...summarize(r.subset) }));

  // ───────────────────── 가설 2: 첫 눌림 회복형 ─────────────────────
  const h2Results = [
    { key: 'BASE', label: '베이스 (전체 H그룹)', subset: trades },
    { key: 'NO_PULL', label: '눌림 없이 상승 (D+1~D+3 low > breakoutLine)', subset: trades.filter(t => !t.pullbackHappened) },
    { key: 'LINE_PULL_REC', label: '기준선 눌림 후 회복', subset: trades.filter(t => t.pullbackHappened && !t.pullbackToBaseClose && t.recoveredAboveBreakoutLine) },
    { key: 'BASE_PULL_REC', label: '기준 종가 눌림 후 회복', subset: trades.filter(t => t.pullbackToBaseClose && !t.pullbackBelowBaseClose && t.recoveredAboveBreakoutLine) },
    { key: 'BREACH_REC', label: '기준 종가 이탈 후 회복', subset: trades.filter(t => t.pullbackBelowBaseClose && t.recoveredAboveBreakoutLine) },
    { key: 'BREACH_FAIL', label: '기준 종가 이탈 후 회복 실패', subset: trades.filter(t => t.pullbackBelowBaseClose && !t.recoveredAboveBreakoutLine) },
  ].map(r => ({ ...r, ...summarize(r.subset) }));

  // ───────────────────── 가설 3: 장초반 갭 제한형 ─────────────────────
  const h3Buckets = [
    { key: 'NEG', label: 'gap% < 0 (보합/약갭)', test: g => g < 0 },
    { key: 'B0_2', label: '0 ≤ gap% < 2', test: g => g >= 0 && g < 2 },
    { key: 'B2_5', label: '2 ≤ gap% < 5', test: g => g >= 2 && g < 5 },
    { key: 'B5_8', label: '5 ≤ gap% < 8', test: g => g >= 5 && g < 8 },
    { key: 'B8P', label: 'gap% ≥ 8 (큰 갭상승)', test: g => g >= 8 },
  ];
  const h3Results = [
    { key: 'BASE', label: '베이스 (전체 H그룹)', subset: trades },
    ...h3Buckets.map(b => ({ key: b.key, label: b.label, subset: trades.filter(t => t.gapPct != null && b.test(t.gapPct)) })),
  ].map(r => ({ ...r, ...summarize(r.subset) }));

  // ───────────────────── 가설 4: H그룹 과다일 희소성 ─────────────────────
  // 각 hDate별 H그룹 발생 수 (전체 trades 기준)
  const countByDate = new Map();
  for (const t of trades) countByDate.set(t.hDate, (countByDate.get(t.hDate) || 0) + 1);
  const h4Buckets = [
    { key: 'LE5', label: '같은 날 H그룹 ≤ 5', test: c => c <= 5 },
    { key: 'LE10', label: '≤ 10', test: c => c <= 10 },
    { key: 'LE15', label: '≤ 15', test: c => c <= 15 },
    { key: 'LE20', label: '≤ 20', test: c => c <= 20 },
    { key: 'LE30', label: '≤ 30', test: c => c <= 30 },
    { key: 'GT30', label: '> 30 (대량 발생일)', test: c => c > 30 },
  ];
  const h4Results = [
    { key: 'BASE', label: '베이스 (전체 H그룹)', subset: trades },
    ...h4Buckets.map(b => ({
      key: b.key, label: b.label,
      subset: trades.filter(t => b.test(countByDate.get(t.hDate) || 0)),
    })),
  ].map(r => ({ ...r, ...summarize(r.subset) }));

  // ───────────────────── 추천 운영안 ─────────────────────
  // n ≥ 50 + 베이스 대비 승률 + 매번 평균 동시 개선
  const baseStat = summarize(trades);
  const allResults = [
    { hyp: 'H1 재돌파', items: h1Results },
    { hyp: 'H2 눌림 회복', items: h2Results },
    { hyp: 'H3 갭 제한', items: h3Results },
    { hyp: 'H4 희소성', items: h4Results },
  ];
  const recommendations = [];
  for (const grp of allResults) {
    for (const r of grp.items) {
      if (r.key === 'BASE') continue;
      if (r.n < 50) continue;
      const dWR = (r.winRate ?? 0) - (baseStat.winRate ?? 0);
      const dE = (r.avgClose5 ?? 0) - (baseStat.avgClose5 ?? 0);
      if (dWR > 0 && dE > 0) {
        recommendations.push({
          hypothesis: grp.hyp, key: r.key, label: r.label,
          n: r.n, winRate: r.winRate, avgClose5: r.avgClose5,
          dWR: round(dWR), dE: round(dE),
          score: round(dWR + dE * 5, 2),  // 단순 종합 점수
        });
      }
    }
  }
  recommendations.sort((a, b) => b.score - a.score);

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'D+5 실전 운용 가설 검증 보고서',
      purpose: 'D+5 실전 운용 보드에 넣을 가격 기준이 실제 성과를 개선하는지 4가지 가설로 검증. 매수 추천 아닌 통계 검증.',
      noFutureInfo: '모든 조건은 매수 시점(D+0 종가) 또는 D+1~D+5 장중에 실시간 확인 가능한 정보만 사용.',
      entry: 'H돌파일 종가 (D+0 close)',
      hold: 'D+1~D+5 (5거래일)',
      exit: '단순 D+5 종가 청산 (TP/SL 없음)',
      criteria: 'n ≥ 50 + 승률 + 매번 평균 동시 개선되는 조건만 추천.',
    },
    counts: { totalEvents: events.length, effectiveTrades: trades.length },
    baseline: baseStat,
    hypothesis1: { label: 'H1. 전일 고가 재돌파형', results: h1Results },
    hypothesis2: { label: 'H2. 첫 눌림 회복형', results: h2Results },
    hypothesis3: { label: 'H3. 장초반 갭 제한형', results: h3Results },
    hypothesis4: { label: 'H4. H그룹 과다일 희소성 (당일 H그룹 발생 수)', results: h4Results },
    recommendations,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // 콘솔 요약
  function printTable(label, results) {
    console.log(`\n📊 ${label}`);
    console.log(`  조건                                                n     승률   매번 평균  MFE5   MAE5   +3%    +5%    이탈률  시간초과`);
    for (const r of results) {
      const lowN = r.n < 30 ? ' ⚠' : (r.n < 50 ? ' (참)' : '');
      console.log(`  ${(r.label || '-').padEnd(48)} ${String(r.n).padStart(4)}  ${String(r.winRate ?? '-').padStart(6)}%  ${String(r.avgClose5 ?? '-').padStart(7)}%  ${String(r.avgMFE5 ?? '-').padStart(5)}%  ${String(r.avgMAE5 ?? '-').padStart(5)}%  ${String(r.reach3Rate ?? '-').padStart(5)}%  ${String(r.reach5Rate ?? '-').padStart(5)}%  ${String(r.breachRate ?? '-').padStart(5)}%  ${String(r.timeStuckRate ?? '-').padStart(6)}%${lowN}`);
    }
  }
  printTable('H1. 전일 고가 재돌파형', h1Results);
  printTable('H2. 첫 눌림 회복형', h2Results);
  printTable('H3. 장초반 갭 제한형', h3Results);
  printTable('H4. H그룹 과다일 희소성', h4Results);

  console.log(`\n📊 추천 운영안 (n≥50, 승률+매번 평균 동시 개선):`);
  if (recommendations.length === 0) {
    console.log('  ⚠️ 조건에 맞는 추천 없음');
  } else {
    for (const r of recommendations) {
      console.log(`  [${r.hypothesis}] ${r.label} → n=${r.n}, 승률 ${r.winRate}% (Δ${r.dWR > 0 ? '+' : ''}${r.dWR}), 매번 ${r.avgClose5}% (Δ${r.dE > 0 ? '+' : ''}${r.dE})`);
    }
  }

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>D+5 실전 운용 가설 검증</title>
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
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

.scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; margin-bottom: 14px; border-radius: 8px; }
table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 10px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; white-space: nowrap; }
table.cmp thead th:first-child { text-align: left; }
table.cmp tbody td { padding: 7px 10px; border-bottom: 1px solid #334155; text-align: right; }
table.cmp tbody td:first-child { text-align: left; color: #cbd5e1; font-weight: 600; }
table.cmp tbody tr:hover td { background: #273549; }
.row-base td { background: rgba(99,102,241,0.10) !important; }
.row-good td { background: rgba(13, 148, 136, 0.15) !important; }
.row-bad td { background: rgba(239, 68, 68, 0.08) !important; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-neutral { color: #94a3b8; }
.tag-low-n { color: #fbbf24; font-size: 10px; }

.recommend-card { background: #1e293b; border: 1px solid #334155; border-left: 4px solid #10b981; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; }
.recommend-card .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.recommend-card .head strong { color: #6ee7b7; font-size: 14px; }
.recommend-card .head .hyp { color: #94a3b8; font-size: 11px; }
.recommend-card .stats { font-size: 12px; color: #cbd5e1; line-height: 1.7; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; }
  .scroll-x table.cmp { width: max-content; min-width: 100%; white-space: nowrap; }
}
</style>
</head>
<body>

<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/d5">🎯 D+5 실전 운용 보드</a>
  <a href="/hgroup-live-operation-hypothesis" class="active">🧪 D+5 가설 검증</a>
  <a href="/vpr-trade-winrate">📊 VPR 매매 승률</a>
</nav>

<h1>🧪 D+5 실전 운용 가설 검증 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  D+5 실전 운용 보드에 넣을 가격 기준이 실제 성과를 개선하는지 <strong>4가지 가설</strong>로 검증합니다.
  매수 추천이 아니라 통계 검증입니다.<br>
  진입 = H돌파일 종가 / 청산 = D+5 종가 (단순 보유, TP/SL 없음). 모든 조건은 매수 시점 또는 장중 실시간 확인 가능한 정보만 사용.
</div>

<div class="warn-banner">
  ⚠️ <strong>n ≥ 50 + 승률·매번 평균 동시 개선</strong>되는 조건만 추천에 포함. n &lt; 30은 ⚠ 표시 (참고용).
  승률만 오르고 매번 평균이 떨어지는 조건은 탈락.
</div>

<h2>🏆 추천 운영안 (조건 충족 시)</h2>
<div id="recommendations"></div>

<h2>📊 H1. 전일 고가 재돌파형</h2>
<p class="subtitle">VPR이 고가권/기준선 위인 종목 중, D+1~D+5 안에 H돌파일 고가를 종가 기준 재돌파한 그룹.</p>
<div id="h1-table"></div>

<h2>📊 H2. 첫 눌림 회복형</h2>
<p class="subtitle">D+1~D+3 동안의 눌림 패턴(없음/기준선/기준 종가/이탈) × 회복 여부.</p>
<div id="h2-table"></div>

<h2>📊 H3. 장초반 갭 제한형</h2>
<p class="subtitle">D+1 시가 / 기준 종가 갭 % 구간별. 갭이 크면 거리가 멀어져 추격 위험.</p>
<div id="h3-table"></div>

<h2>📊 H4. H그룹 과다일 희소성</h2>
<p class="subtitle">같은 H돌파일에 H그룹이 몇 개 발생했는지. 적은 날에 발생한 종목이 더 강한 후보일 가능성 검증.</p>
<div id="h4-table"></div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtPct(v) {
  if (v == null || !isFinite(v)) return '<span class="cell-neutral">-</span>';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%</span>';
}
function fmtRate(v, lo, hi) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const _lo = lo != null ? lo : 35, _hi = hi != null ? hi : 50;
  const cls = v >= _hi ? 'cell-pos' : (v < _lo ? 'cell-neg' : 'cell-neutral');
  return '<span class="' + cls + '">' + Number(v).toFixed(1) + '%</span>';
}
function fmtN(n) {
  if (n == null) return '-';
  if (n < 30) return '<span class="tag-low-n">' + n + ' ⚠</span>';
  if (n < 50) return n + ' <span class="tag-low-n">(참)</span>';
  return n;
}

const baseline = DATA.baseline;
document.getElementById('subtitle').textContent =
  '입력 ' + DATA.counts.totalEvents + '건 → 실효 ' + DATA.counts.effectiveTrades + '건 · ' +
  '베이스: 승률 ' + baseline.winRate + '%, 매번 ' + baseline.avgClose5 + '% · ' +
  '생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

// 추천 운영안
function renderRecommendations() {
  const recs = DATA.recommendations || [];
  const container = document.getElementById('recommendations');
  if (recs.length === 0) {
    container.innerHTML = '<div class="purpose-box" style="border-left-color:#fbbf24;color:#fde68a;">⚠️ 조건에 맞는 추천 없음 (n≥50 + 승률·매번 평균 동시 개선 조건). 표본이 작거나 효과가 미세한 경우입니다.</div>';
    return;
  }
  const html = [];
  for (const r of recs) {
    html.push('<div class="recommend-card">' +
      '<div class="head">' +
        '<strong>' + r.label + '</strong>' +
        '<span class="hyp">' + r.hypothesis + '</span>' +
      '</div>' +
      '<div class="stats">' +
        'n=<strong>' + r.n + '</strong> · ' +
        '승률 <strong>' + r.winRate + '%</strong> (Δ' + fmtPct(r.dWR) + ') · ' +
        '매번 평균 <strong>' + (r.avgClose5 > 0 ? '+' : '') + r.avgClose5 + '%</strong> (Δ' + fmtPct(r.dE) + ')' +
      '</div>' +
    '</div>');
  }
  container.innerHTML = html.join('');
}
renderRecommendations();

function renderHypTable(elId, results) {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>조건</th><th>n</th><th>승률</th><th>매번 평균</th>',
    '<th>평균 MFE5</th><th>평균 MAE5</th>',
    '<th>+3% 도달률</th><th>+5% 도달률</th>',
    '<th>기준 종가 이탈률</th><th>시간초과율</th>',
    '</tr></thead><tbody>'];
  for (const r of results) {
    let cls = '';
    if (r.key === 'BASE') cls = ' class="row-base"';
    else if (r.n >= 50 && r.winRate != null && baseline.winRate != null && r.winRate > baseline.winRate && r.avgClose5 > baseline.avgClose5) cls = ' class="row-good"';
    else if (r.n >= 50 && r.avgClose5 != null && baseline.avgClose5 != null && r.avgClose5 < baseline.avgClose5 - 0.3) cls = ' class="row-bad"';
    html.push('<tr' + cls + '>' +
      '<td>' + r.label + '</td>' +
      '<td>' + fmtN(r.n) + '</td>' +
      '<td>' + fmtRate(r.winRate) + '</td>' +
      '<td>' + fmtPct(r.avgClose5) + '</td>' +
      '<td>' + fmtPct(r.avgMFE5) + '</td>' +
      '<td>' + fmtPct(r.avgMAE5) + '</td>' +
      '<td>' + (r.reach3Rate != null ? r.reach3Rate + '%' : '-') + '</td>' +
      '<td>' + (r.reach5Rate != null ? r.reach5Rate + '%' : '-') + '</td>' +
      '<td>' + (r.breachRate != null ? r.breachRate + '%' : '-') + '</td>' +
      '<td>' + (r.timeStuckRate != null ? r.timeStuckRate + '%' : '-') + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById(elId).innerHTML = html.join('');
}
renderHypTable('h1-table', DATA.hypothesis1.results);
renderHypTable('h2-table', DATA.hypothesis2.results);
renderHypTable('h3-table', DATA.hypothesis3.results);
renderHypTable('h4-table', DATA.hypothesis4.results);

document.getElementById('data-limit').innerHTML =
  '<strong>데이터 정의</strong><br>' +
  '• 진입 = H돌파일 종가 / 청산 = D+5 종가 (단순 보유)<br>' +
  '• MFE5 = 5일 안 최고가 / 진입가 - 1 (평균)<br>' +
  '• MAE5 = 5일 안 최저가 / 진입가 - 1 (평균)<br>' +
  '• +3%/+5% 도달률 = 5일 안 최고가가 진입가의 +3% / +5% 이상 도달한 비율<br>' +
  '• 기준 종가 이탈률 = 5일 안 최저가가 기준 종가(VVI 돌파대기일 종가) 미만으로 내려간 비율<br>' +
  '• 시간초과율 = MFE5 < 6% AND MAE5 > -5% (5일간 의미 없는 흐름)<br>' +
  '• 재돌파(H1) = D+1~D+5 종가가 H돌파일 고가 이상으로 마감<br>' +
  '• 갭%(H3) = D+1 시가 / 기준 종가 - 1<br>' +
  '• 같은 날 H그룹 수(H4) = 해당 H돌파일 동일 날짜에 검출된 H그룹 종목 수 (3년 백테스트 전체 기준)<br>' +
  '• <strong>매수 추천이 아닙니다.</strong> 가설 검증입니다.';
</script>

</body>
</html>
`;

main();
