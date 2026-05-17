#!/usr/bin/env node
/**
 * QVA2 D+5 재돌파 운용 보드 — /rebreak 의 QVA2 버전 (실험)
 *
 * 입력:
 *   reports/qva2-watchlist-board.json (BREAKOUT_SUCCESS 후보) — 수정하지 않음
 *   cache/stock-charts-long/{code}.json (D+1~latest 가격 추적)
 *
 * 정의 (기존 /rebreak 와 1:1 동일 구조):
 *   D+0 = QVA2 BREAKOUT_SUCCESS 발생일 (= VVI2 다음 거래일에 close > VVI2 high)
 *   D+0 high (= breakoutHigh) 를 D+1~D+5 안에 종가 기준 재돌파했는지 추적
 *
 *   상태 분류:
 *     - TODAY_INITIAL_BREAKOUT     : 오늘이 D+0
 *     - CLOSE_REBREAK              : D+1~D+5 어느 날 close > breakoutHigh
 *     - INTRADAY_PUSHBACK          : D+1~D+5 high > breakoutHigh 였지만 close <= breakoutHigh (장중만 돌파)
 *     - NO_REBREAK                 : D+1~D+5 high가 breakoutHigh 도달 못 함
 *     - BREACH_NO_RECOVER          : 진입가 (entryPrice = vviHigh × 1.01) 아래로 종가 이탈, 회복 못함
 *
 * 출력: reports/qva2-d5-rebreak-board.{json,html}
 * 라우트: GET /qva2-d5-rebreak
 *
 * 환경변수:
 *   - QVA2_REBREAK_MAX_DAYS (기본 5) — D+1~D+N 추적 윈도우
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHART_DIR   = path.join(ROOT, 'cache', 'stock-charts-long');
const BOARD_PATH  = path.join(REPORTS_DIR, 'qva2-watchlist-board.json');
const OUT_JSON    = path.join(REPORTS_DIR, 'qva2-d5-rebreak-board.json');
const OUT_HTML    = path.join(REPORTS_DIR, 'qva2-d5-rebreak-board.html');

const MAX_DAYS = Number(process.env.QVA2_REBREAK_MAX_DAYS || 5);

const STATUS_LABELS = {
  TODAY_INITIAL_BREAKOUT: '오늘 D+0 돌파',
  CLOSE_REBREAK:          '종가 재돌파 성공',
  INTRADAY_PUSHBACK:      '장중만 돌파 후 밀림',
  BREACH_NO_RECOVER:      '진입가 이탈 후 회복 실패',
  NO_REBREAK:             '재돌파 없음',
};
const STATUS_INTERPRETATIONS = {
  TODAY_INITIAL_BREAKOUT: '오늘이 BREAKOUT 일자(D+0)입니다. 재돌파 추적은 D+1부터.',
  CLOSE_REBREAK:          'D+1~D+5 안에 종가가 D+0 고가를 다시 넘었습니다 — 강한 후보.',
  INTRADAY_PUSHBACK:      'D+1~D+5 안에 장중만 D+0 고가를 넘었으나 종가는 못 넘겼습니다.',
  BREACH_NO_RECOVER:      'D+0 진입가(VVI2 high × 1.01) 아래로 종가 이탈, 회복 못함 — 위험.',
  NO_REBREAK:             'D+1~D+5 동안 D+0 고가 도달조차 못함 — 약한 후보.',
};

function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}
function round2(v) { return v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100; }
function fmtNum(v) { return v != null ? Math.round(v).toLocaleString() : '-'; }

function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}

function loadBoard() {
  if (!fs.existsSync(BOARD_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf-8')); } catch (_) { return null; }
}

/**
 * BREAKOUT_SUCCESS 후보 한 건에 대해 D+1~D+MAX_DAYS 재돌파 분석.
 * @param item    qva2-watchlist-board.json의 BREAKOUT_SUCCESS 항목
 * @param chart   chart cache
 */
function analyzeRebreak(item, chart) {
  const rows = chart && chart.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const breakoutIdx = rows.findIndex(r => r.date === item.breakoutDate);
  if (breakoutIdx < 0) return null;
  const breakoutRow = rows[breakoutIdx];
  const breakoutHigh = breakoutRow.high;
  const breakoutClose = breakoutRow.close;
  const entryPrice = item.breakoutEntryPrice1Pct;
  if (!breakoutHigh || !entryPrice) return null;

  const lastIdx = rows.length - 1;
  const daysFromBreakout = lastIdx - breakoutIdx;
  const trackingEnd = Math.min(lastIdx, breakoutIdx + MAX_DAYS);

  let rebreakIdx = -1, rebreakRow = null;       // 종가 재돌파 (close > breakoutHigh)
  let intradayIdx = -1, intradayRow = null;     // 장중만 (high > breakoutHigh, close ≤)
  let breachIdx = -1, breachRow = null;         // 진입가 이탈 (close < entryPrice)
  let recoveredAfterBreach = false;
  let maxHighAfter = breakoutHigh, maxHighDate = item.breakoutDate;
  let minCloseAfter = breakoutClose, minCloseDate = item.breakoutDate;
  const trackedDays = [];

  for (let i = breakoutIdx + 1; i <= trackingEnd; i++) {
    const r = rows[i];
    if (!r || !r.close) continue;
    trackedDays.push({
      date: r.date, dayOffset: i - breakoutIdx,
      open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
      valueApprox: r.valueApprox || (r.close * r.volume),
      vsBreakoutHighPct: round2(((r.high / breakoutHigh) - 1) * 100),
      closeVsBreakoutHighPct: round2(((r.close / breakoutHigh) - 1) * 100),
      closeVsEntryPct: round2(((r.close / entryPrice) - 1) * 100),
    });
    if (r.high > maxHighAfter) { maxHighAfter = r.high; maxHighDate = r.date; }
    if (r.close < minCloseAfter) { minCloseAfter = r.close; minCloseDate = r.date; }
    if (rebreakIdx < 0 && r.close > breakoutHigh) {
      rebreakIdx = i; rebreakRow = r;
    } else if (intradayIdx < 0 && r.high > breakoutHigh && r.close <= breakoutHigh) {
      intradayIdx = i; intradayRow = r;
    }
    if (breachIdx < 0 && r.close < entryPrice) {
      breachIdx = i; breachRow = r;
    } else if (breachIdx >= 0 && !recoveredAfterBreach && r.close >= breakoutHigh) {
      recoveredAfterBreach = true;
    }
  }

  // 상태 결정 — 우선순위: 종가 재돌파 > 진입가 이탈(미회복) > 장중만 > 재돌파 없음
  let status, statusLabel;
  if (daysFromBreakout === 0) {
    status = 'TODAY_INITIAL_BREAKOUT';
  } else if (rebreakIdx >= 0) {
    status = 'CLOSE_REBREAK';
  } else if (breachIdx >= 0 && !recoveredAfterBreach) {
    status = 'BREACH_NO_RECOVER';
  } else if (intradayIdx >= 0) {
    status = 'INTRADAY_PUSHBACK';
  } else {
    status = 'NO_REBREAK';
  }
  statusLabel = STATUS_LABELS[status];

  // 재돌파일 거래대금 비율 (전 20일 평균 대비)
  let rebreakValueRatio = null;
  if (rebreakRow) {
    const start = Math.max(0, rebreakIdx - 20);
    const prev20 = rows.slice(start, rebreakIdx);
    const avgVal = prev20.length > 0 ? prev20.reduce((s, r) => s + (r.valueApprox || 0), 0) / prev20.length : 0;
    if (avgVal > 0) rebreakValueRatio = round2((rebreakRow.valueApprox || 0) / avgVal);
  }

  return {
    status, statusLabel,
    breakoutDate: item.breakoutDate,
    breakoutHigh,
    breakoutClose,
    entryPrice: round2(entryPrice),
    daysFromBreakout,
    trackingEnd: rows[trackingEnd]?.date,
    rebreakDate: rebreakRow ? rebreakRow.date : null,
    rebreakClose: rebreakRow ? rebreakRow.close : null,
    rebreakDayOffset: rebreakIdx >= 0 ? rebreakIdx - breakoutIdx : null,
    rebreakValueRatio,
    intradayDate: intradayRow ? intradayRow.date : null,
    intradayHigh: intradayRow ? intradayRow.high : null,
    breachDate: breachRow ? breachRow.date : null,
    breachClose: breachRow ? breachRow.close : null,
    recoveredAfterBreach,
    maxHighAfter, maxHighDate,
    minCloseAfter, minCloseDate,
    currentClose: rows[lastIdx].close,
    currentDate: rows[lastIdx].date,
    currentVsBreakoutHighPct: round2(((rows[lastIdx].close / breakoutHigh) - 1) * 100),
    currentVsEntryPct: round2(((rows[lastIdx].close / entryPrice) - 1) * 100),
    trackedDays,
  };
}

async function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`\n📊 QVA2 D+5 재돌파 운용 보드 (D+1~D+${MAX_DAYS})`);

  const board = loadBoard();
  if (!board) {
    console.error('  qva2-watchlist-board.json 이 없습니다. 먼저 \'node qva2-watchlist-board.js\' 실행하세요.');
    process.exit(1);
  }
  const baseDate = board.meta && board.meta.baseDate;
  console.log(`  기준일: ${baseDate ? fmtDate(baseDate) : '-'}`);

  const breakouts = (board.stages && board.stages.BREAKOUT_SUCCESS) || [];
  console.log(`  BREAKOUT_SUCCESS 후보: ${breakouts.length}건 (qva2-watchlist 보드 기준)`);

  const events = [];
  let chartMissing = 0, anchorMissing = 0;
  for (const item of breakouts) {
    const chart = loadChart(item.code);
    if (!chart) { chartMissing++; continue; }
    const r = analyzeRebreak(item, chart);
    if (!r) { anchorMissing++; continue; }
    events.push({
      code: item.code, name: item.name, market: item.market, marketValue: item.marketValue,
      qva2SignalDate: item.qva2SignalDate, qva2Score: item.qva2Score, qva2Grade: item.qva2Grade,
      vvi2Date: item.vvi2Date, vvi2High: item.vvi2High,
      ...r,
    });
  }
  console.log(`  분석 이벤트: ${events.length}건 (chart 없음 ${chartMissing} / anchor 없음 ${anchorMissing})`);

  const byStatus = {
    CLOSE_REBREAK: [], TODAY_INITIAL_BREAKOUT: [],
    INTRADAY_PUSHBACK: [], BREACH_NO_RECOVER: [], NO_REBREAK: [],
  };
  for (const e of events) (byStatus[e.status] || (byStatus[e.status] = [])).push(e);

  // 정렬
  byStatus.CLOSE_REBREAK.sort((a, b) => {
    if (a.rebreakDate !== b.rebreakDate) return (b.rebreakDate || '').localeCompare(a.rebreakDate || '');
    return (b.rebreakValueRatio || 0) - (a.rebreakValueRatio || 0);
  });
  byStatus.TODAY_INITIAL_BREAKOUT.sort((a, b) => (b.qva2Score || 0) - (a.qva2Score || 0));
  byStatus.INTRADAY_PUSHBACK.sort((a, b) => (b.currentVsBreakoutHighPct || -999) - (a.currentVsBreakoutHighPct || -999));
  byStatus.BREACH_NO_RECOVER.sort((a, b) => (a.minCloseAfter || 0) - (b.minCloseAfter || 0));
  byStatus.NO_REBREAK.sort((a, b) => (b.currentVsBreakoutHighPct || -999) - (a.currentVsBreakoutHighPct || -999));

  const counts = {
    total: events.length,
    closeRebreak: byStatus.CLOSE_REBREAK.length,
    today:        byStatus.TODAY_INITIAL_BREAKOUT.length,
    intraday:     byStatus.INTRADAY_PUSHBACK.length,
    breach:       byStatus.BREACH_NO_RECOVER.length,
    noRebreak:    byStatus.NO_REBREAK.length,
  };

  const out = {
    meta: {
      title: 'QVA2 D+5 재돌파 운용 보드',
      subtitle: 'QVA2 BREAKOUT 후보의 D+0 고가를 D+1~D+5 안에 다시 종가 돌파했는지 추적',
      caution: '실험 라인. 매수 확정 신호 아님.',
      generatedAt: new Date().toISOString(),
      baseDate, baseDateFmt: baseDate ? fmtDate(baseDate) : null,
      maxDays: MAX_DAYS,
      statusLabels: STATUS_LABELS,
      statusInterpretations: STATUS_INTERPRETATIONS,
    },
    counts,
    byStatus,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  // DB 저장 (실패해도 HTML/JSON은 정상)
  try {
    const { saveQva2D5RebreakBoardToDB } = require('../../src/db/saveBoardSignals');
    const r = await saveQva2D5RebreakBoardToDB(out, { jsonPath: OUT_JSON, htmlPath: OUT_HTML });
    if (r) console.log(`  🗄  DB 저장: runId=${r.runId} rows=${r.totalRows} (inserted=${r.inserted} updated=${r.updated})`);
  } catch (e) {
    console.warn(`  ⚠ DB 저장 실패 (HTML/JSON은 정상 저장됨): ${e.message}`);
  } finally {
    try { await require('../../src/db/mysql').closePool(); } catch (_) {}
  }

  console.log(`\n  요약:`);
  console.log(`    🟢 종가 재돌파:     ${counts.closeRebreak}건`);
  console.log(`    🔵 D+0 (오늘 돌파):  ${counts.today}건`);
  console.log(`    🟡 장중만 돌파:     ${counts.intraday}건`);
  console.log(`    🔴 진입가 이탈:     ${counts.breach}건`);
  console.log(`    ⚪ 재돌파 없음:     ${counts.noRebreak}건`);
  if (byStatus.CLOSE_REBREAK.length > 0) {
    console.log(`\n  ── 종가 재돌파 상위 ${Math.min(8, byStatus.CLOSE_REBREAK.length)} ──`);
    for (const e of byStatus.CLOSE_REBREAK.slice(0, 8)) {
      console.log(`    BREAKOUT ${fmtDate(e.breakoutDate)} → 재돌파 ${fmtDate(e.rebreakDate)} (D+${e.rebreakDayOffset}) | ${e.code} ${(e.name || '').padEnd(12)} | 진입가 ${e.entryPrice} → 현재 ${(e.currentVsEntryPct || 0).toFixed(1)}% | 거래대금 ×${e.rebreakValueRatio || '-'}`);
    }
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
<title>QVA2 D+5 재돌파 운용 보드 (실험)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
}
nav.boards { display:flex; gap:6px; flex-wrap:wrap; padding:8px 0 14px; border-bottom:1px solid #1e293b; margin-bottom:14px; align-items:center; }
nav.boards .group-label { font-size:11px; color:#64748b; padding:4px 8px 4px 0; font-weight:600; letter-spacing:0.4px; text-transform:uppercase; }
nav.boards a { color:#94a3b8; text-decoration:none; font-size:12px; padding:5px 10px; border-radius:6px; border:1px solid transparent; }
nav.boards a:hover { color:#e2e8f0; background:#1e293b; }
nav.boards a.live { border-color:#1e293b; }
nav.boards a.experiment { border-color:#7c3aed; color:#c4b5fd; background:#1e1b4b; }
nav.boards a.experiment:hover { background:#312e81; color:#e0e7ff; }
nav.boards a.active { background:#1e293b; color:#f1f5f9; border-color:#334155; }
nav.boards a.experiment.active { background:#312e81; color:#e0e7ff; border-color:#a78bfa; }
nav.boards .sep { color:#475569; padding:0 6px; }
h1 { font-size:22px; margin:6px 0 4px; color:#f1f5f9; font-weight:700; }
.exp-pill { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; background:#312e81; color:#c4b5fd; border:1px solid #6366f1; margin-left:8px; vertical-align:middle; font-weight:600; }
.subtitle { font-size:13px; color:#94a3b8; margin-bottom:12px; line-height:1.6; }
.purpose-box { background:#0f172a; border-left:3px solid #a78bfa; padding:12px 16px; border-radius:6px; margin-bottom:14px; line-height:1.7; color:#cbd5e1; font-size:13px; }
.purpose-box strong { color:#c4b5fd; }
.funnel-chip { display:inline-block; text-decoration:none; padding:4px 10px; border-radius:5px; font-size:12px; font-weight:600; transition: transform 0.1s, filter 0.15s; }
.funnel-chip:hover { transform: translateY(-1px); filter: brightness(1.25); }
h2[id^="sec-"] { scroll-margin-top: 14px; }
.caution-box { background:#1f1b14; border-left:3px solid #fbbf24; padding:10px 14px; border-radius:6px; margin-bottom:14px; color:#fcd34d; font-size:12px; line-height:1.6; }

.summary-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:10px; margin-bottom:16px; }
.summary-cell { background:#1e293b; border:1px solid #334155; border-radius:8px; padding:10px 14px; }
.summary-cell .label { font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.4px; }
.summary-cell .value { font-size:22px; font-weight:700; color:#f1f5f9; font-variant-numeric:tabular-nums; margin-top:4px; }
.summary-cell .sub { font-size:11px; color:#64748b; margin-top:2px; }
.summary-cell.rebreak { border-left:4px solid #14b8a6; }
.summary-cell.today   { border-left:4px solid #3b82f6; }
.summary-cell.intra   { border-left:4px solid #f59e0b; }
.summary-cell.breach  { border-left:4px solid #ef4444; }
.summary-cell.no      { border-left:4px solid #94a3b8; }

h2 { font-size:16px; margin:22px 0 10px; color:#cbd5e1; }
h2 .count { font-size:13px; color:#64748b; font-weight:400; margin-left:6px; }

.card { background:#1e293b; border:1px solid #334155; border-radius:10px; padding:14px 16px; margin-bottom:10px; }
.card.s-CLOSE_REBREAK          { border-left:6px solid #14b8a6; background:linear-gradient(90deg, #042f2e 0%, #1e293b 25%); }
.card.s-TODAY_INITIAL_BREAKOUT { border-left:5px solid #3b82f6; background:linear-gradient(90deg, #172554 0%, #1e293b 25%); }
.card.s-INTRADAY_PUSHBACK      { border-left:4px solid #f59e0b; opacity:0.92; }
.card.s-BREACH_NO_RECOVER      { border-left:4px solid #ef4444; opacity:0.85; }
.card.s-NO_REBREAK             { border-left:4px solid #94a3b8; opacity:0.85; }
.card h3 { margin:0 0 6px; font-size:15px; color:#f1f5f9; font-weight:700; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.card h3 .code { color:#64748b; font-size:12px; font-weight:400; }
.card h3 .market { color:#94a3b8; font-size:11px; padding:1px 6px; border:1px solid #334155; border-radius:4px; }
.card h3 a.name-link { color:#f1f5f9; text-decoration:none; border-bottom:1px dashed transparent; }
.card h3 a.name-link:hover { color:#5eead4; border-bottom-color:#5eead4; }
.card .status-badge { font-size:11px; padding:2px 8px; border-radius:999px; font-weight:600; border:1px solid; }
.card.s-CLOSE_REBREAK          .status-badge { background:#042f2e; color:#5eead4; border-color:#14b8a6; }
.card.s-TODAY_INITIAL_BREAKOUT .status-badge { background:#172554; color:#93c5fd; border-color:#3b82f6; }
.card.s-INTRADAY_PUSHBACK      .status-badge { background:#422006; color:#fde68a; border-color:#f59e0b; }
.card.s-BREACH_NO_RECOVER      .status-badge { background:#7f1d1d; color:#fca5a5; border-color:#ef4444; }
.card.s-NO_REBREAK             .status-badge { background:#1e293b; color:#cbd5e1; border-color:#475569; }

.metrics-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(135px, 1fr)); gap:8px; margin:8px 0; }
.metric { background:#0f172a; border:1px solid #334155; border-radius:6px; padding:7px 10px; }
.metric .label { font-size:10px; color:#94a3b8; margin-bottom:2px; text-transform:uppercase; letter-spacing:0.3px; }
.metric .value { font-size:14px; font-weight:600; color:#e2e8f0; font-variant-numeric:tabular-nums; }
.cell-pos { color:#6ee7b7; }
.cell-neg { color:#fca5a5; }
.cell-warn { color:#fbbf24; }

.timeline { display:flex; gap:4px; margin:8px 0; }
.tl-cell { flex:1; min-width:0; padding:5px 6px; border-radius:4px; background:#0f172a; border:1px solid #1e293b; text-align:center; font-size:10.5px; color:#94a3b8; }
.tl-cell.up { background:#042f2e; color:#5eead4; border-color:#14b8a6; }
.tl-cell.down { background:#1e293b; color:#fca5a5; border-color:#475569; }
.tl-cell .day { font-size:9px; color:#64748b; margin-bottom:2px; }
.tl-cell .pct { font-weight:700; font-variant-numeric:tabular-nums; }

.section-empty { padding:18px; background:#1e293b; border:1px dashed #475569; border-radius:8px; color:#64748b; text-align:center; font-size:12px; }
details.section { margin-bottom:16px; }
details.section > summary { cursor:pointer; font-size:14px; font-weight:700; color:#cbd5e1; padding:10px 14px; user-select:none; background:#0f172a; border-radius:8px; border:1px solid #1e293b; }
details.section > .section-body { padding:12px 6px; }
footer.foot { margin-top:30px; padding:14px; background:#1e293b; border-radius:8px; font-size:12px; color:#94a3b8; line-height:1.7; }
</style>
</head>
<body>
<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
  <div style="background:linear-gradient(90deg,#064e3b 0%,#065f46 100%);border:1px solid #10b981;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#a7f3d0;font-weight:700;letter-spacing:0.3px;">🟢 운영 보드</span><a href="/qva2-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR</a><a href="/qva2-d5-rebreak" style="color:#fff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.22);border:1px solid #fff;font-weight:700;">🔥 D+5 재돌파</a><a href="/qva2-vvi" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파</a></div>
  <div style="background:linear-gradient(90deg,#1e1b4b 0%,#312e81 100%);border:1px solid #6366f1;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#c4b5fd;font-weight:700;letter-spacing:0.3px;">🟣 실험 라인</span><a href="/one-day-surge-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">⚡ 1DS 단타 후보</a></div>
  <div style="background:linear-gradient(90deg,#1e293b 0%,#334155 100%);border:1px solid #64748b;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;opacity:0.92;"><span style="color:#cbd5e1;font-weight:700;letter-spacing:0.3px;">📜 과거 보드</span><a href="/qva-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR (구)</a><a href="/rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파 (구)</a><a href="/qva-vvi-redefined-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파 (구)</a></div>
</div>

<h1>🔥 QVA2 D+5 재돌파 운용 보드 <span class="exp-pill">실험 라인</span></h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  <strong>QVA2 BREAKOUT_SUCCESS</strong> 후보를 입력으로 받아, D+0 고가가 D+1~D+5 안에 종가 기준 다시 돌파됐는지 추적하는 운용 보드입니다.
  <br>기존 <a href="/rebreak" style="color:#c4b5fd;">/rebreak</a> 의 1:1 QVA2 mirror.
  <br><br><span style="color:#94a3b8;font-size:12px;">상태 분포 (chip 클릭 = 해당 섹션으로 이동):</span><br>
  <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px;">
    <a href="#sec-rb" class="funnel-chip" style="background:#052e16;border:1px solid #22c55e;color:#86efac;">🟢 종가 재돌파 성공</a>
    <a href="#sec-td" class="funnel-chip" style="background:#0c2740;border:1px solid #3b82f6;color:#93c5fd;">🔵 오늘 D+0 돌파</a>
    <a href="#sec-in" class="funnel-chip" style="background:#3a2a08;border:1px solid #eab308;color:#fde047;">🟡 장중만 돌파 후 밀림</a>
    <a href="#sec-br" class="funnel-chip" style="background:#450a0a;border:1px solid #f87171;color:#fca5a5;">🔴 진입가 이탈 후 회복 실패</a>
    <a href="#sec-nr" class="funnel-chip" style="background:#1e293b;border:1px solid #94a3b8;color:#cbd5e1;">⚪ 재돌파 없음</a>
  </div>
</div>

<div class="caution-box">
  ⚠️ <strong>실험 라인:</strong> 검증 데이터 부족. 매수 신호 아닙니다.
</div>

<h2>📊 화면 요약</h2>
<div class="summary-grid" id="summary-grid"></div>

<h2 id="sec-rb">🟢 종가 재돌파 성공 <span class="count" id="rb-count"></span></h2>
<div id="rb-host"></div>

<h2 id="sec-td">🔵 오늘 D+0 돌파 <span class="count" id="td-count"></span></h2>
<div id="td-host"></div>

<h2 id="sec-in">🟡 장중만 돌파 후 밀림 <span class="count" id="in-count"></span></h2>
<div id="in-host"></div>

<h2 id="sec-br">🔴 진입가 이탈 후 회복 실패 <span class="count" id="br-count"></span></h2>
<div id="br-host"></div>

<h2 id="sec-nr">⚪ 재돌파 없음 <span class="count" id="nr-count"></span></h2>
<div id="nr-host"></div>

<footer class="foot" id="foot"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}
function fmtMarketcap(v) { if (!v) return '-'; if (v >= 1e12) return (v / 1e12).toFixed(1) + '조'; if (v >= 1e8) return Math.round(v / 1e8) + '억'; return v; }
function fmtNum(v) { if (v == null) return '-'; return Math.round(v).toLocaleString(); }
function pctClass(v) { if (v == null) return ''; return v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : ''); }

document.getElementById('subtitle').textContent =
  '기준일 ' + (DATA.meta.baseDateFmt || '-') + ' · 추적 D+1~D+' + DATA.meta.maxDays + ' · 생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

const sg = document.getElementById('summary-grid');
const c = DATA.counts;
sg.innerHTML = [
  cell('rebreak', '종가 재돌파',      c.closeRebreak, ''),
  cell('today',   'D+0 (오늘 돌파)', c.today,        '재돌파 추적은 D+1부터'),
  cell('intra',   '장중만 돌파',      c.intraday,     ''),
  cell('breach',  '진입가 이탈',      c.breach,       '회복 실패'),
  cell('no',      '재돌파 없음',      c.noRebreak,    ''),
].join('');
function cell(cls, label, value, sub) {
  return '<div class="summary-cell ' + cls + '"><div class="label">' + label + '</div><div class="value">' + (value ?? 0) + '</div><div class="sub">' + (sub || '') + '</div></div>';
}

document.getElementById('rb-count').textContent = '(' + (DATA.byStatus.CLOSE_REBREAK?.length || 0) + ')';
document.getElementById('td-count').textContent = '(' + (DATA.byStatus.TODAY_INITIAL_BREAKOUT?.length || 0) + ')';
document.getElementById('in-count').textContent = '(' + (DATA.byStatus.INTRADAY_PUSHBACK?.length || 0) + ')';
document.getElementById('br-count').textContent = '(' + (DATA.byStatus.BREACH_NO_RECOVER?.length || 0) + ')';
document.getElementById('nr-count').textContent = '(' + (DATA.byStatus.NO_REBREAK?.length || 0) + ')';

// 입력 (BREAKOUT_SUCCESS) 자체가 0이면 전체 안내
const totalInput = (DATA.byStatus.CLOSE_REBREAK?.length || 0)
                 + (DATA.byStatus.TODAY_INITIAL_BREAKOUT?.length || 0)
                 + (DATA.byStatus.INTRADAY_PUSHBACK?.length || 0)
                 + (DATA.byStatus.BREACH_NO_RECOVER?.length || 0)
                 + (DATA.byStatus.NO_REBREAK?.length || 0);
const upstreamEmpty = totalInput === 0;
const upstreamHtml = upstreamEmpty
  ? '<div class="section-empty" style="border-color:#7c3aed;background:#1e1b4b;color:#c4b5fd;padding:20px;line-height:1.6;">현재 재돌파 분석 대상이 없습니다.<br>이 보드는 <strong>/qva2-watchlist의 BREAKOUT_SUCCESS 후보</strong>가 생긴 뒤 자동으로 채워집니다.<br><br>새 QVA2 위치 필터가 엄격하게 적용되어 고점권 변동성 종목이 제외됩니다.<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;justify-content:center;"><a href="/qva2-watchlist" style="color:#e0e7ff;text-decoration:none;padding:4px 12px;border-radius:5px;background:#312e81;border:1px solid #a78bfa;font-size:11.5px;">QVA2 H그룹/VPR 보드 보기</a><a href="/qva2-vvi" style="color:#e0e7ff;text-decoration:none;padding:4px 12px;border-radius:5px;background:#312e81;border:1px solid #a78bfa;font-size:11.5px;">QVA2 VVI 보드 보기</a></div></div>'
  : null;

renderCards('rb-host', DATA.byStatus.CLOSE_REBREAK,          upstreamHtml || '종가 재돌파 후보가 없습니다.');
renderCards('td-host', DATA.byStatus.TODAY_INITIAL_BREAKOUT, upstreamEmpty ? '' : '오늘 D+0 돌파 후보 없음.');
renderCards('in-host', DATA.byStatus.INTRADAY_PUSHBACK,      '');
renderCards('br-host', DATA.byStatus.BREACH_NO_RECOVER,      '');
renderCards('nr-host', DATA.byStatus.NO_REBREAK,             '');

document.getElementById('foot').innerHTML = '입력: <a href="/qva2-watchlist" style="color:#c4b5fd;">/qva2-watchlist</a>의 BREAKOUT_SUCCESS 후보. 기존 <a href="/rebreak" style="color:#c4b5fd;">/rebreak</a> 와 구조 동일, 입력만 QVA2.';

function renderCards(hostId, items, emptyMsg) {
  const host = document.getElementById(hostId);
  if (!items || items.length === 0) {
    if (typeof emptyMsg === 'string' && emptyMsg.startsWith('<div')) {
      host.innerHTML = emptyMsg;
    } else if (!emptyMsg) {
      host.innerHTML = '';
    } else {
      host.innerHTML = '<div class="section-empty">' + emptyMsg + '</div>';
    }
    return;
  }
  host.innerHTML = items.map(card).join('');
}

function card(e) {
  return '<div class="card s-' + e.status + '">' +
    '<h3>' +
      '<a class="name-link" href="/qva2-d5-rebreak/' + e.code + '">' + (e.name || e.code) + '</a>' +
      '<span class="code">' + e.code + '</span>' +
      '<span class="market">' + (e.market || '') + '</span>' +
      '<span class="status-badge">' + e.statusLabel + '</span>' +
    '</h3>' +
    '<div class="metrics-grid">' +
      m('QVA2 신호일', fmtDate(e.qva2SignalDate)) +
      m('VVI2',        fmtDate(e.vvi2Date)) +
      m('D+0 (BREAKOUT)', fmtDate(e.breakoutDate) + ' (D+' + e.daysFromBreakout + ')') +
      m('D+0 고가',    fmtNum(e.breakoutHigh)) +
      m('진입가',       fmtNum(e.entryPrice)) +
      (e.rebreakDate
        ? m('재돌파일',  fmtDate(e.rebreakDate) + ' (D+' + e.rebreakDayOffset + ')', 'cell-pos')
        : (e.intradayDate ? m('장중 도달', fmtDate(e.intradayDate), 'cell-warn') : '')) +
      (e.rebreakValueRatio != null ? m('재돌파 거래대금 ×', e.rebreakValueRatio.toFixed(2), e.rebreakValueRatio >= 3 ? 'cell-pos' : '') : '') +
      m('현재 종가',    fmtNum(e.currentClose)) +
      m('vs D+0 고가', (e.currentVsBreakoutHighPct >= 0 ? '+' : '') + (e.currentVsBreakoutHighPct ?? 0).toFixed(2) + '%', pctClass(e.currentVsBreakoutHighPct)) +
      m('vs 진입가',    (e.currentVsEntryPct >= 0 ? '+' : '') + (e.currentVsEntryPct ?? 0).toFixed(2) + '%', pctClass(e.currentVsEntryPct)) +
      m('시총',         fmtMarketcap(e.marketValue)) +
    '</div>' +
    timelineHtml(e) +
  '</div>';
}

function timelineHtml(e) {
  if (!e.trackedDays || e.trackedDays.length === 0) return '';
  const cells = e.trackedDays.map(d => {
    const cls = d.closeVsBreakoutHighPct > 0 ? 'up' : 'down';
    return '<div class="tl-cell ' + cls + '"><div class="day">D+' + d.dayOffset + ' ' + fmtDate(d.date).slice(5) + '</div><div class="pct">' + (d.closeVsBreakoutHighPct >= 0 ? '+' : '') + d.closeVsBreakoutHighPct.toFixed(1) + '%</div></div>';
  });
  return '<div class="timeline">' + cells.join('') + '</div>';
}

function m(label, value, cls) {
  if (value == null) return '';
  return '<div class="metric"><div class="label">' + label + '</div><div class="value' + (cls ? ' ' + cls : '') + '">' + value + '</div></div>';
}
</script>
</body>
</html>
`;

if (require.main === module) {
  main().catch(e => { console.error('❌', e); process.exit(1); });
}

module.exports = { main };
