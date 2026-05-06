#!/usr/bin/env node
/**
 * D+5 재돌파 운용 보드
 *
 * 목적:
 *   가설 검증(hgroup-live-operation-hypothesis-report)에서 가장 강했던 시그널은 H돌파일 고가
 *   재돌파였다. 재돌파 있음 (n=186) 승률 75.27% / 매번 +6.83%, 재돌파 없음 (n=174) 승률 8.05% / 매번 -5.54%.
 *
 *   이 보드는 H그룹 D+0~D+5 후보를 대상으로 H돌파일 고가 재돌파 상태를 추적하는 운용 화면이다.
 *   매수 등급표가 아니라 재돌파 상태 + 기준 종가 이탈 여부를 추적한다.
 *
 * 입력:
 *   qva-watchlist-board.json (기존 H그룹 candidates, 수정하지 않음)
 *   cache/stock-charts-long/{code}.json (D+1~latest 가격 추적)
 *
 * 출력:
 *   reports/hgroup-rebreak-operation-board-result.json
 *   reports/hgroup-rebreak-operation-board-result.html
 *
 * 라우트: /d5-rebreak-board
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const BOARD_PATH = path.join(ROOT, 'qva-watchlist-board.json');
const OUT_JSON = path.join(REPORTS_DIR, 'hgroup-rebreak-operation-board-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'hgroup-rebreak-operation-board-result.html');

const MAX_DAYS = 5;
const NEAR_REBREAK_PCT = -3;  // 재돌파 근접 = -3% 이내

const STATUS_LABELS = {
  CLOSE_REBREAK_HOLD: '재돌파 후 위 유지',
  CLOSE_REBREAK_PULLBACK: '재돌파 후 눌림',
  INTRADAY_REBREAK: '장중 재돌파 (오늘)',
  NEAR_REBREAK: '재돌파 근접',
  WAITING: '재돌파 대기',
  BELOW_BASE: '기준 종가 이탈 주의',
  BREAKDOWN_NO_RECOVER: '이탈 후 회복 실패',
};

function round(v, d = 2) { if (v == null || !Number.isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function fmtNum(v) { return v != null ? Math.round(v).toLocaleString() : '-'; }
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8); }

function loadChart(code) {
  const p = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}

// ─── 재돌파 상태 산출 ───
function computeRebreakStatus({ rows, hIdx, baseClose, hDayHigh, breakoutLine, latestIdx }) {
  let everClosedAboveHHigh = false;
  let everIntradayAboveHHigh = false;
  let everLowBelowBaseClose = false;
  let recoveredAboveBreakoutLine = false;
  let everPullbackToBreakoutLine = false;
  let firstRebreakDayOffset = null;
  let firstRebreakDate = null;

  for (let k = 1; hIdx + k <= latestIdx; k++) {
    const r = rows[hIdx + k];
    if (!r) continue;
    if (r.close >= hDayHigh) {
      everClosedAboveHHigh = true;
      if (firstRebreakDayOffset == null) {
        firstRebreakDayOffset = k;
        firstRebreakDate = r.date;
      }
    }
    if (r.high >= hDayHigh) everIntradayAboveHHigh = true;
    if (r.low < baseClose) everLowBelowBaseClose = true;
    if (r.low <= breakoutLine) everPullbackToBreakoutLine = true;
    if (r.close >= breakoutLine) recoveredAboveBreakoutLine = true;
  }

  const lastRow = rows[latestIdx];
  const currentClose = lastRow ? lastRow.close : null;
  const currentHigh = lastRow ? lastRow.high : null;
  const currentLow = lastRow ? lastRow.low : null;
  const currentlyAboveHHigh = currentClose != null && currentClose >= hDayHigh;

  // 상태 결정 — 우선순위 순으로 첫 매칭
  // 사용자 spec(2026-05-06): CLOSE_REBREAK를 "현재 위 유지" vs "후 눌림" 둘로 분리해 시점 헷갈림 해소.
  let status;
  if (everLowBelowBaseClose && !everClosedAboveHHigh && currentClose < breakoutLine) {
    status = 'BREAKDOWN_NO_RECOVER';
  } else if (currentClose != null && currentClose < baseClose) {
    status = 'BELOW_BASE';
  } else if (everClosedAboveHHigh && currentlyAboveHHigh) {
    status = 'CLOSE_REBREAK_HOLD';      // 종가 재돌파 후 현재도 H고 위
  } else if (everClosedAboveHHigh) {
    status = 'CLOSE_REBREAK_PULLBACK';   // 종가 재돌파 후 살짝 눌림 (H고 아래로 이동)
  } else if (currentClose != null && currentClose >= hDayHigh) {
    status = 'INTRADAY_REBREAK';
  } else if (currentClose != null && currentClose >= hDayHigh * (1 + NEAR_REBREAK_PCT / 100)) {
    status = 'NEAR_REBREAK';
  } else {
    status = 'WAITING';
  }

  // "눌림 없이 상승" 부가 플래그 — 정렬에 활용 가능
  const noPullback = !everPullbackToBreakoutLine;

  return {
    status,
    everClosedAboveHHigh, everIntradayAboveHHigh,
    everLowBelowBaseClose, recoveredAboveBreakoutLine,
    everPullbackToBreakoutLine, noPullback,
    firstRebreakDayOffset, firstRebreakDate,
    currentClose, currentHigh, currentLow,
    distanceToHHighPct: (currentClose != null && hDayHigh) ? round((currentClose / hDayHigh - 1) * 100) : null,
    aboveHDayHigh: currentlyAboveHHigh,
  };
}

// ─── 운용 코멘트 ───
function buildRunComments({ status, hasVolumeSupport, gapPct, noPullback, firstRebreakDate, firstRebreakDayOffset }) {
  const cmts = [];
  const rbInfo = (firstRebreakDate && firstRebreakDayOffset != null)
    ? `${firstRebreakDate.slice(0, 4)}-${firstRebreakDate.slice(4, 6)}-${firstRebreakDate.slice(6, 8)} (D+${firstRebreakDayOffset})`
    : null;
  if (status === 'CLOSE_REBREAK_HOLD' && hasVolumeSupport) {
    cmts.push((rbInfo ? `${rbInfo}에 ` : '') + '종가 재돌파했고 현재도 H돌파일 고가 위 유지 중. D+5 검증 최강 조건(재돌파+거래대금 동반).');
  } else if (status === 'CLOSE_REBREAK_HOLD') {
    cmts.push((rbInfo ? `${rbInfo}에 ` : '') + '종가 재돌파했고 현재도 H돌파일 고가 위 유지 중. 검증상 승률 75% 구간.');
  } else if (status === 'CLOSE_REBREAK_PULLBACK') {
    cmts.push((rbInfo ? `${rbInfo}에 ` : '') + '종가 재돌파했지만 현재는 H돌파일 고가 살짝 아래로 눌림. 정상 흐름이지만 종가 재돌파 재확인이 필요합니다.');
  } else if (status === 'INTRADAY_REBREAK') {
    cmts.push('오늘 장중 H돌파일 고가 위 유지 중. 아직 종가 미확정이라 마감까지 유지되는지 확인이 필요합니다.');
  } else if (status === 'NEAR_REBREAK') {
    cmts.push('H돌파일 고가까지 가까워진 상태(-3% 이내). 돌파 시 거래대금 동반 여부가 중요합니다.');
  } else if (status === 'WAITING') {
    cmts.push('아직 H돌파일 고가 재돌파 전입니다. 기준 종가를 지키는지 확인합니다.');
  } else if (status === 'BELOW_BASE') {
    cmts.push('기준 종가 아래로 내려온 상태입니다. 과거 검증상 이탈 후 회복 실패 구간은 성과가 매우 나빴습니다.');
  } else if (status === 'BREAKDOWN_NO_RECOVER') {
    cmts.push('과거 검증상 성과가 가장 나빴던 구간입니다 (n=72, 승률 0%). 신규 관찰 우선순위를 낮춥니다.');
  }

  // 갭 해석 추가
  if (gapPct != null) {
    if (gapPct >= 8) cmts.push('큰 갭상승: 강한 모멘텀 가능성. 단, H돌파일 고가 위 유지 확인 필요.');
    else if (gapPct >= 5) cmts.push('중간 갭상승: 모멘텀 확인 구간.');
    else if (gapPct >= 0 && gapPct < 2) cmts.push('작은 갭: 과거 검증상 모멘텀이 약했던 구간.');
    else if (gapPct < 0) cmts.push('하락 출발: 기준 종가 이탈 여부 확인 필요.');
  }

  // 눌림 없이 상승 부가
  if (noPullback && (status === 'CLOSE_REBREAK' || status === 'INTRADAY_REBREAK')) {
    cmts.push('D+1~현재까지 기준선 아래로 내려간 적 없는 강한 흐름.');
  }

  return cmts;
}

function main() {
  if (!fs.existsSync(BOARD_PATH)) {
    console.error('[ERROR] qva-watchlist-board.json 없음. 먼저 `node qva-watchlist-board.js` 실행.');
    process.exit(1);
  }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log('\n📊 D+5 재돌파 운용 보드 생성');

  const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf-8'));
  const hgroup = (board.stages?.BREAKOUT_SUCCESS || [])
    .filter(c => (c.daysFromBreakout ?? Infinity) <= MAX_DAYS);
  console.log(`  H그룹 D+0~D+${MAX_DAYS}: ${hgroup.length}건`);

  const items = [];
  for (const c of hgroup) {
    const chart = loadChart(c.code);
    if (!chart) continue;
    const rows = chart.rows || [];
    const hIdx = rows.findIndex(r => r.date === c.breakoutDate);
    if (hIdx < 0) continue;
    const hRow = rows[hIdx];
    const latestIdx = rows.length - 1;
    const baseClose = c.vprBaseClose || c.vviClose;
    const breakoutLine = c.vprBreakoutLine || (baseClose ? round(baseClose * 1.01) : null);
    const hDayHigh = hRow?.high;
    const hDayLow = hRow?.low;
    if (!baseClose || !breakoutLine || !hDayHigh) continue;

    const reb = computeRebreakStatus({ rows, hIdx, baseClose, hDayHigh, breakoutLine, latestIdx });

    // 갭% — D+1 시가 vs baseClose (가설 검증과 동일 정의)
    const day1 = rows[hIdx + 1];
    const gapPct = day1?.open ? round((day1.open / baseClose - 1) * 100) : null;

    // 거래대금 동반 — H돌파일의 vprTags 기준
    const hasVolumeSupport = (c.vprTags || []).includes('VOLUME_SUPPORT') || (c.vprTags || []).includes('VOLUME_EXPLOSION');

    const distFromBase = baseClose ? round((reb.currentClose / baseClose - 1) * 100) : null;
    const distToHHigh = reb.distanceToHHighPct;  // 음수면 미돌파, 양수면 위

    const runComments = buildRunComments({
      status: reb.status,
      hasVolumeSupport,
      gapPct,
      noPullback: reb.noPullback,
      firstRebreakDate: reb.firstRebreakDate,
      firstRebreakDayOffset: reb.firstRebreakDayOffset,
    });

    items.push({
      code: c.code, name: c.name, market: c.market,
      breakoutDate: c.breakoutDate, daysFromBreakout: c.daysFromBreakout,
      vprMain: c.vprMain, vprMainLabel: c.vprMainLabel,
      vprTags: c.vprTags || [], vprTagLabels: c.vprTagLabels || [],
      baseClose, breakoutLine, hDayHigh, hDayLow,
      currentClose: reb.currentClose,
      distFromBase,                    // 현재가가 기준 종가에서 떨어진 % (라이브 거리)
      distToHHigh,                     // 현재가가 H돌파일 고가까지 남은 거리 % (음수 = 못 돌파)
      aboveHDayHigh: reb.aboveHDayHigh,
      belowBaseClose: reb.currentClose != null && reb.currentClose < baseClose,
      hasVolumeSupport,
      gapPct,
      rebreakStatus: reb.status,
      rebreakStatusLabel: STATUS_LABELS[reb.status] || reb.status,
      everClosedAboveHHigh: reb.everClosedAboveHHigh,
      everLowBelowBaseClose: reb.everLowBelowBaseClose,
      noPullback: reb.noPullback,
      firstRebreakDayOffset: reb.firstRebreakDayOffset,
      firstRebreakDate: reb.firstRebreakDate,
      runComments,
    });
  }

  // ─── 정렬 (사용자 spec) ───
  // 1. 종가 재돌파 확정 + 거래대금 동반
  // 2. 장중 재돌파 유지 중 + 거래대금 동반
  // 3. 재돌파 근접
  // 4. 눌림 없이 상승 (위 어디에도 안 들어가는 종목)
  // 5. 재돌파 대기
  // 6. 기준 종가 이탈 주의
  // 7. 기준 종가 이탈 후 회복 실패
  function sortRank(it) {
    const s = it.rebreakStatus;
    const v = it.hasVolumeSupport;
    if (s === 'CLOSE_REBREAK_HOLD' && v) return 1;
    if (s === 'CLOSE_REBREAK_HOLD') return 1.5;
    if (s === 'INTRADAY_REBREAK' && v) return 2;
    if (s === 'INTRADAY_REBREAK') return 2.5;
    if (s === 'CLOSE_REBREAK_PULLBACK') return 3;   // 재돌파 후 살짝 눌림 (정상)
    if (s === 'NEAR_REBREAK') return 4;
    if (s === 'WAITING' && it.noPullback) return 5;
    if (s === 'WAITING') return 6;
    if (s === 'BELOW_BASE') return 7;
    if (s === 'BREAKDOWN_NO_RECOVER') return 8;
    return 9;
  }
  items.sort((a, b) => {
    const ra = sortRank(a), rb = sortRank(b);
    if (ra !== rb) return ra - rb;
    // 같은 그룹 내: 돌파일 최신순 → 거리 작은 순
    const da = a.breakoutDate || '00000000', db = b.breakoutDate || '00000000';
    if (da !== db) return db.localeCompare(da);
    return Math.abs(a.distFromBase || 0) - Math.abs(b.distFromBase || 0);
  });

  // ─── 콘솔 출력 ───
  console.log(`\n=== 재돌파 운용 보드 ===`);
  for (const it of items) {
    console.log(`[${it.name} ${it.code}] D+${it.daysFromBreakout} ${it.rebreakStatusLabel}${it.hasVolumeSupport ? ' + 거래대금동반' : ''}`);
    console.log(`  현재 ${fmtNum(it.currentClose)}원 / H고 ${fmtNum(it.hDayHigh)}원 (남은거리 ${it.distToHHigh}%) / 기준종가 ${fmtNum(it.baseClose)}원`);
    console.log(`  거리 ${it.distFromBase}% · 갭% ${it.gapPct ?? '-'} · VPR ${it.vprMainLabel || '-'}`);
    if (it.runComments.length) {
      for (const c of it.runComments) console.log(`  💬 ${c}`);
    }
    console.log('');
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'D+5 재돌파 운용 보드',
      purpose: '이 보드는 H그룹 발생 후 D+5 안에 H돌파일 고가를 재돌파하는지 추적하는 운용 보드입니다. 백테스트에서는 H돌파일 고가 재돌파 여부가 D+5 성과를 가장 크게 갈랐습니다. 단, 재돌파는 사전에 확정되는 값이 아니라 장중 또는 종가 기준으로 확인되는 상태이므로, 이 화면은 매수 등급표가 아니라 재돌파 상태와 기준 종가 이탈 여부를 추적하는 보드입니다.',
      sourceBoard: 'qva-watchlist-board.json (BREAKOUT_SUCCESS, D+0~D+5)',
      latestTradingDate: board.debugCounts?.latestTradingDate,
    },
    counts: { total: hgroup.length, effective: items.length },
    statusLabels: STATUS_LABELS,
    backtest: {
      positive: [
        { label: '재돌파 + 거래대금 동반', n: 160, winRate: 74.38, avgClose5: 7.08 },
        { label: '재돌파 있음', n: 186, winRate: 75.27, avgClose5: 6.83 },
        { label: '눌림 없이 상승', n: 162, winRate: 64.20, avgClose5: 5.12 },
      ],
      negative: [
        { label: '재돌파 없음', n: 174, winRate: 8.05, avgClose5: -5.54 },
        { label: '기준 종가 이탈 후 회복 실패', n: 72, winRate: 0, avgClose5: -9.02 },
      ],
      gap: [
        { label: 'gap ≥ 8 (큰 갭상승)', n: 103, winRate: 50.49, avgClose5: 2.45 },
        { label: '0~2% 작은 갭', n: 94, winRate: 34.04, avgClose5: -1.28 },
      ],
    },
    items,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

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
<title>D+5 재돌파 운용 보드</title>
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

.bt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; margin-bottom: 14px; }
.bt-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.bt-card.pos { border-left: 3px solid #14b8a6; }
.bt-card.neg { border-left: 3px solid #ef4444; }
.bt-card.gap { border-left: 3px solid #f59e0b; }
.bt-card h4 { margin: 0 0 6px; font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.bt-card .row { font-size: 12px; line-height: 1.7; color: #cbd5e1; display: flex; justify-content: space-between; }
.bt-card .row .lab { color: #cbd5e1; }
.bt-card .row .val { color: #f1f5f9; font-weight: 600; font-variant-numeric: tabular-nums; }
.bt-card .row.pos .val { color: #6ee7b7; }
.bt-card .row.neg .val { color: #fca5a5; }

.card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.card h3 { margin: 0 0 6px; font-size: 15px; color: #f1f5f9; font-weight: 700; }
.card .meta { font-size: 11px; color: #94a3b8; margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.card .meta .badge { display:inline-block; padding:2px 7px; border-radius:3px; font-size:11px; font-weight:600; }
.card.s-CLOSE_REBREAK_HOLD     { border-left: 5px solid #10b981; }
.card.s-CLOSE_REBREAK_PULLBACK { border-left: 5px solid #5eead4; }
.card.s-INTRADAY_REBREAK       { border-left: 5px solid #34d399; }
.card.s-NEAR_REBREAK           { border-left: 5px solid #38bdf8; }
.card.s-WAITING                { border-left: 5px solid #94a3b8; }
.card.s-BELOW_BASE             { border-left: 5px solid #f59e0b; }
.card.s-BREAKDOWN_NO_RECOVER   { border-left: 5px solid #ef4444; opacity: 0.85; }

.badge.st-CLOSE_REBREAK_HOLD     { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }
.badge.st-CLOSE_REBREAK_PULLBACK { background: #134e4a; color: #5eead4; border: 1px solid #14b8a6; }
.badge.st-INTRADAY_REBREAK       { background: #134e4a; color: #5eead4; border: 1px solid #14b8a6; }
.badge.st-NEAR_REBREAK           { background: #1e3a8a; color: #93c5fd; border: 1px solid #3b82f6; }
.badge.st-WAITING                { background: #1e293b; color: #cbd5e1; border: 1px solid #475569; }
.badge.st-BELOW_BASE             { background: #422006; color: #fde047; border: 1px solid #ca8a04; }
.badge.st-BREAKDOWN_NO_RECOVER   { background: #7f1d1d; color: #fca5a5; border: 1px solid #ef4444; }
.badge.rebreak-date              { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; font-size: 10px; }
.badge.vol     { background: #422006; color: #fbbf24; border: 1px solid #f59e0b; }
.badge.no-pull { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }
.badge.aux     { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; }
.badge.vpr-HIGH_ZONE_HOLD       { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }
.badge.vpr-ABOVE_BREAKOUT_LINE  { background: #134e4a; color: #5eead4; }
.badge.vpr-ABOVE_BASE_CLOSE     { background: #312e81; color: #c7d2fe; }
.badge.vpr-INTRADAY_PUSHBACK    { background: #422006; color: #fde047; border: 1px solid #ca8a04; }
.badge.vpr-OVERHEATED_BREAKOUT  { background: #7c2d12; color: #fdba74; border: 1px solid #f97316; }

.price-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 8px 0; }
.price-cell { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; }
.price-cell .label { font-size: 10px; color: #94a3b8; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.3px; }
.price-cell .value { font-size: 14px; font-weight: 600; color: #e2e8f0; font-variant-numeric: tabular-nums; }
.price-cell .sub { font-size: 10px; color: #64748b; margin-top: 2px; }
.price-cell.k-current { border-left: 3px solid #c4b5fd; }
.price-cell.k-hhigh   { border-left: 3px solid #6ee7b7; }
.price-cell.k-base    { border-left: 3px solid #f59e0b; }
.price-cell.k-line    { border-left: 3px solid #38bdf8; }
.price-cell.k-gap     { border-left: 3px solid #fbbf24; }

.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }

.run-comments { margin-top: 10px; padding: 8px 12px; background: #0f172a; border-left: 2px solid #475569; border-radius: 4px; font-size: 12px; line-height: 1.7; color: #cbd5e1; }
.run-comments .empty { color: #64748b; font-style: italic; }

.empty-list { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 24px; text-align: center; color: #64748b; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; }
  .price-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
</head>
<body>

<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/d5">🎯 D+5 실전 운용</a>
  <a href="/d5-rebreak-board" class="active">🔥 D+5 재돌파 운용</a>
  <a href="/d5-hyp">🧪 D+5 가설 검증</a>
</nav>

<h1>🔥 D+5 재돌파 운용 보드</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  이 보드는 H그룹 발생 후 D+5 안에 <strong>H돌파일 고가를 재돌파하는지 추적</strong>하는 운용 보드입니다.
  백테스트에서는 H돌파일 고가 재돌파 여부가 D+5 성과를 가장 크게 갈랐습니다 (재돌파 있음 승률 75% / 매번 +6.83% vs 없음 8% / -5.54%).
  단, 재돌파는 사전에 확정되는 값이 아니라 장중 또는 종가 기준으로 확인되는 상태이므로, 이 화면은
  <strong>매수 등급표가 아니라 재돌파 상태와 기준 종가 이탈 여부를 추적하는 보드</strong>입니다.
</div>

<h2>📊 백테스트 핵심 시그널 (3년·n=448)</h2>
<div class="bt-grid" id="bt-grid"></div>

<h2 id="hd">🔥 H그룹 D+5 이내 종목별 재돌파 추적</h2>
<div id="cards"></div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtNum(v) { return v != null ? Math.round(v).toLocaleString() : '-'; }
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8); }
function fmtPct(v, prec) {
  if (v == null) return '-';
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(prec || 2) + '%';
}

document.getElementById('subtitle').textContent =
  'H그룹 D+0~D+5 종목 ' + DATA.counts.effective + '건 · ' +
  '기준일: ' + (DATA.meta.latestTradingDate ? fmtDate(DATA.meta.latestTradingDate) : '-') + ' · ' +
  '생성: ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

// 백테스트 카드
function renderBacktest() {
  const html = [];
  // 긍정
  html.push('<div class="bt-card pos"><h4>핵심 긍정 시그널</h4>');
  for (const x of DATA.backtest.positive) {
    html.push('<div class="row pos"><span class="lab">' + x.label + '</span><span class="val">n=' + x.n + ' / ' + x.winRate + '% / ' + fmtPct(x.avgClose5) + '</span></div>');
  }
  html.push('</div>');
  // 부정
  html.push('<div class="bt-card neg"><h4>핵심 부정 시그널</h4>');
  for (const x of DATA.backtest.negative) {
    html.push('<div class="row neg"><span class="lab">' + x.label + '</span><span class="val">n=' + x.n + ' / ' + x.winRate + '% / ' + fmtPct(x.avgClose5) + '</span></div>');
  }
  html.push('</div>');
  // 갭
  html.push('<div class="bt-card gap"><h4>갭 해석</h4>');
  for (const x of DATA.backtest.gap) {
    html.push('<div class="row"><span class="lab">' + x.label + '</span><span class="val">n=' + x.n + ' / ' + x.winRate + '% / ' + fmtPct(x.avgClose5) + '</span></div>');
  }
  html.push('</div>');
  document.getElementById('bt-grid').innerHTML = html.join('');
}
renderBacktest();

// 카드 렌더
function renderCards() {
  const items = DATA.items || [];
  if (items.length === 0) {
    document.getElementById('cards').innerHTML = '<div class="empty-list">현재 D+5 이내 H그룹 종목이 없습니다.</div>';
    return;
  }
  document.getElementById('hd').textContent = '🔥 H그룹 D+5 이내 종목별 재돌파 추적 (' + items.length + '건)';
  const html = [];
  for (const it of items) {
    const tagsHtml = (it.vprTagLabels || []).map(t => '<span class="badge aux">' + t + '</span>').join('');
    const cmts = it.runComments || [];
    const cmtsHtml = cmts.length
      ? cmts.map(c => '<div>💬 ' + c + '</div>').join('')
      : '<div class="empty">— 별도 운용 코멘트 없음 —</div>';
    const distHHigh = it.distToHHigh != null ? fmtPct(it.distToHHigh) : '-';
    const distHHighCls = it.distToHHigh != null && it.distToHHigh >= 0 ? 'cell-pos' : 'cell-neg';
    const distFromBaseCls = it.distFromBase != null && it.distFromBase >= 0 ? 'cell-pos' : 'cell-neg';
    const gapCls = it.gapPct != null && it.gapPct >= 5 ? 'cell-pos' : (it.gapPct != null && it.gapPct < 0 ? 'cell-neg' : '');

    const isRebrokeAlready = (it.rebreakStatus === 'CLOSE_REBREAK_HOLD' || it.rebreakStatus === 'CLOSE_REBREAK_PULLBACK');
    const rebreakBadgeHtml = isRebrokeAlready && it.firstRebreakDate
      ? '<span class="badge rebreak-date">📅 재돌파일 ' + fmtDate(it.firstRebreakDate) + ' (D+' + (it.firstRebreakDayOffset ?? '?') + ')</span>'
      : '';
    const hHighSubText = isRebrokeAlready && it.firstRebreakDate
      ? '재돌파 ' + fmtDate(it.firstRebreakDate) + ' (D+' + (it.firstRebreakDayOffset ?? '?') + ') · 현재 ' + (it.aboveHDayHigh ? '<span class="cell-pos">위 유지 ' : '<span class="cell-neg">살짝 아래 ') + distHHigh + '</span>'
      : '남은 거리 <span class="' + distHHighCls + '">' + distHHigh + '</span> · 저가 ' + fmtNum(it.hDayLow);
    html.push(
      '<div class="card s-' + it.rebreakStatus + '">' +
        '<h3>' + (it.name || '') + ' <span style="color:#64748b;font-size:13px;font-weight:400;">' + it.code + '</span></h3>' +
        '<div class="meta">' +
          '<span class="badge st-' + it.rebreakStatus + '">' + it.rebreakStatusLabel + '</span>' +
          rebreakBadgeHtml +
          (it.hasVolumeSupport ? '<span class="badge vol">거래대금 동반(H돌파일)</span>' : '') +
          (it.noPullback && (it.rebreakStatus === 'CLOSE_REBREAK_HOLD' || it.rebreakStatus === 'CLOSE_REBREAK_PULLBACK' || it.rebreakStatus === 'INTRADAY_REBREAK') ? '<span class="badge no-pull">눌림 없이 상승</span>' : '') +
          '<span class="badge aux">H돌파일 ' + fmtDate(it.breakoutDate) + ' · D+' + (it.daysFromBreakout ?? 0) + '</span>' +
          (it.vprMain ? ('<span class="badge vpr-' + it.vprMain + '">' + (it.vprMainLabel || it.vprMain) + '</span>') : '') +
          tagsHtml +
        '</div>' +
        '<div class="price-grid">' +
          '<div class="price-cell k-current">' +
            '<div class="label">현재가</div>' +
            '<div class="value">' + fmtNum(it.currentClose) + '원</div>' +
            '<div class="sub">기준 종가 대비 <span class="' + distFromBaseCls + '">' + fmtPct(it.distFromBase) + '</span></div>' +
          '</div>' +
          '<div class="price-cell k-hhigh">' +
            '<div class="label">H돌파일 고가 (재돌파 기준)</div>' +
            '<div class="value">' + fmtNum(it.hDayHigh) + '원</div>' +
            '<div class="sub">' + hHighSubText + '</div>' +
          '</div>' +
          '<div class="price-cell k-line">' +
            '<div class="label">돌파 기준선</div>' +
            '<div class="value">' + fmtNum(it.breakoutLine) + '원</div>' +
            '<div class="sub">기준 종가 ×1.01</div>' +
          '</div>' +
          '<div class="price-cell k-base">' +
            '<div class="label">기준 종가 (이탈선)</div>' +
            '<div class="value">' + fmtNum(it.baseClose) + '원</div>' +
            '<div class="sub">' + (it.belowBaseClose ? '<span class="cell-neg">⚠ 현재 이탈 중</span>' : (it.everLowBelowBaseClose ? '한번 이탈했다가 회복' : '이탈 없음')) + '</div>' +
          '</div>' +
          '<div class="price-cell k-gap">' +
            '<div class="label">갭% (D+1 시가/기준)</div>' +
            '<div class="value"><span class="' + gapCls + '">' + (it.gapPct != null ? fmtPct(it.gapPct) : '-') + '</span></div>' +
            '<div class="sub">≥8% 강모멘텀 · 0~2% 약모멘텀</div>' +
          '</div>' +
        '</div>' +
        '<div class="run-comments">' + cmtsHtml + '</div>' +
      '</div>'
    );
  }
  document.getElementById('cards').innerHTML = html.join('');
}
renderCards();

document.getElementById('data-limit').innerHTML =
  '<strong>재돌파 상태 정의</strong><br>' +
  '• 종가 재돌파 확정 = D+1~현재까지 어느 종가가 H돌파일 고가 이상으로 마감<br>' +
  '• 장중 재돌파 유지 중 = 현재가 ≥ H돌파일 고가 (종가 미확정)<br>' +
  '• 재돌파 근접 = 현재가가 H돌파일 고가 -3% 이내<br>' +
  '• 재돌파 대기 = 현재가가 H돌파일 고가 -3% 아래, 기준 종가는 유지<br>' +
  '• 기준 종가 이탈 주의 = 현재가 < 기준 종가<br>' +
  '• 이탈 후 회복 실패 = 한 번 이탈했고 H돌파일 고가/돌파 기준선 미회복 (n=72, 백테스트 승률 0%)<br>' +
  '<br>' +
  '• 거리 = 현재가 / 기준 종가 - 1 · 갭% = D+1 시가 / 기준 종가 - 1<br>' +
  '• 거래대금 동반 = H돌파일에 거래대금 동반/폭발 보조태그 부착됨<br>' +
  '• <strong>매수 추천이 아닙니다.</strong> 재돌파 추적용 운용 보드입니다.';
</script>

</body>
</html>
`;

main();
