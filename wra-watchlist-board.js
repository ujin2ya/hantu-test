#!/usr/bin/env node
/**
 * WRA Watchlist Board v3 — 통합 리스트 (섹션 제거 + 한국어 표기)
 *
 * 입력:  reports/wra-current-similarity-report-v3-1.json
 * 출력:  reports/wra-watchlist-board.json
 *        reports/wra-watchlist-board.html
 *
 * v2(섹션형 표) → v3(통합 한 리스트):
 *   - 섹션 헤더 제거. 모두 한 표 안에 우선순위 정렬로 노출.
 *   - 내부 라벨(VALUE_SURGE_CONFIRM 등)은 그대로 유지하되, 화면에는 한국어 displayLabel.
 *   - 각 행에 summaryText(한줄판단) + metricSummary(거래대금 N배 · MA20 ±x% · 저점 ±x% · 박스 ...) 사전 생성.
 *   - 컬럼 10개: 순위/종목/유형/한줄판단/점수/거래대금/과열/저점대비/차트/위험
 *   - 위험: 높음/주의/낮음 3단계
 *   - 빠른 필터 4개 (오늘 볼 / 고변동성 제외 / 전체 / 차트신뢰 높은) + 고급 필터(접힘)
 *
 * QVA/VVI/pattern-screener 미수정. 매수 신호 아님.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SOURCE = path.join(ROOT, 'reports', 'wra-current-similarity-report-v3-1.json');
const OUT_JSON = path.join(ROOT, 'reports', 'wra-watchlist-board.json');
const OUT_HTML = path.join(ROOT, 'reports', 'wra-watchlist-board.html');

// 화면 우선순위
const TAG_RANK = {
  CLEAN_VALUE_SETUP: 1,
  VALUE_SURGE_CONFIRM: 2,
  BREAKOUT_MOMENTUM: 3,
  VALUE_LOOSE: 4,
  HIGH_VOLATILITY: 5,
  WATCH_ONLY: 6,
  LOW_SIGNAL: 7,
};
const HISTORY_RANK = { FULL_HISTORY: 1, MID_HISTORY: 2, SHORT_HISTORY: 3, INSUFFICIENT: 4 };
const BOX_RANK = { BOX_STABLE: 1, BOX_VOLATILE: 2, BOX_UNSTABLE: 3 };

// 한국어 표시명 (v3.2: rolling 검증 결과 반영, 사용자 친화 라벨)
const DISPLAY_LABEL = {
  CLEAN_VALUE_SETUP: '안정 관찰',
  VALUE_SURGE_CONFIRM: '상승 확인',
  BREAKOUT_MOMENTUM: '단기 반응',
  VALUE_LOOSE: '보조 유입',
  HIGH_VOLATILITY: '고위험 단기반응',
  WATCH_ONLY: '약한 관찰',
  LOW_SIGNAL: '약한 신호',
};
const SUMMARY_TEXT = {
  CLEAN_VALUE_SETUP: '거래대금 유입, 상대적으로 위험 낮음',
  VALUE_SURGE_CONFIRM: '거래대금+상승 확인, 눌림/유지 확인',
  BREAKOUT_MOMENTUM: '돌파/반응 가능, 추격주의',
  VALUE_LOOSE: '거래대금은 있으나 조건 보통',
  HIGH_VOLATILITY: '크게 움직일 수 있지만 실패율 높음',
  WATCH_ONLY: '움직임 약함, 기본 후순위',
  LOW_SIGNAL: '신호 약함',
};

// 3블록 구성: 먼저 볼(20) → 힘 붙은(15) → 단기 반응(15, overlay 제외)
const CORE_LIMITS = {
  CLEAN_VALUE_SETUP: 20,
  VALUE_SURGE_CONFIRM: 15,
  BREAKOUT_MOMENTUM_NO_OVERLAY: 15,
};

const BLOCK_DEF = [
  {
    id: 'BLOCK1',
    tag: 'CLEAN_VALUE_SETUP',
    title: '먼저 볼 후보',
    desc: '조용히 거래대금이 들어온 종목. 과열이 낮아 먼저 차트에 넣고 볼 후보입니다.',
    limit: CORE_LIMITS.CLEAN_VALUE_SETUP,
    excludeOverlay: false,
  },
  {
    id: 'BLOCK2',
    tag: 'VALUE_SURGE_CONFIRM',
    title: '힘 붙은 후보',
    desc: '거래대금과 상승이 같이 확인된 종목입니다. 이미 움직였을 수 있으므로 눌림/유지 확인이 필요합니다.',
    limit: CORE_LIMITS.VALUE_SURGE_CONFIRM,
    excludeOverlay: false,
  },
  {
    id: 'BLOCK3',
    tag: 'BREAKOUT_MOMENTUM',
    title: '단기 반응 후보',
    desc: '단기 돌파 가능성이 있는 종목입니다. 추격보다는 다음 거래일 반응 확인용입니다.',
    limit: CORE_LIMITS.BREAKOUT_MOMENTUM_NO_OVERLAY,
    excludeOverlay: true,
  },
];

function loadSource() {
  if (!fs.existsSync(SOURCE)) {
    console.error('source missing:', SOURCE);
    console.error('먼저 `node wra-current-similarity-report-v3-1.js` 실행 필요');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(SOURCE, 'utf-8'));
}

function sortCandidates(list) {
  return [...list].sort((a, b) => {
    const ta = TAG_RANK[a.watchTagV3_1] || 99;
    const tb = TAG_RANK[b.watchTagV3_1] || 99;
    if (ta !== tb) return ta - tb;

    const oa = a.riskOverlay ? 1 : 0;
    const ob = b.riskOverlay ? 1 : 0;
    if (oa !== ob) return oa - ob;

    const ha = HISTORY_RANK[a.historyQuality] || 9;
    const hb = HISTORY_RANK[b.historyQuality] || 9;
    if (ha !== hb) return ha - hb;

    if ((a.finalScore || 0) !== (b.finalScore || 0)) return (b.finalScore || 0) - (a.finalScore || 0);

    const ba = BOX_RANK[a.boxQuality] || 9;
    const bb = BOX_RANK[b.boxQuality] || 9;
    if (ba !== bb) return ba - bb;

    return (b.marketCap || 0) - (a.marketCap || 0);
  });
}

function fmtPct(v, digits) {
  if (v == null || !isFinite(v)) return '-';
  return (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(digits == null ? 1 : digits) + '%';
}
function fmtX(v, digits) {
  if (v == null || !isFinite(v)) return '-';
  return Number(v).toFixed(digits == null ? 1 : digits) + '배';
}

// 위험 단계: 높음 / 주의 / 낮음
function computeRiskLevel(c) {
  if (c.riskOverlay === 'HIGH_VOLATILITY') return '높음';
  if ((c.riskScore || 0) >= 20) return '높음';
  if (c.watchTagV3_1 === 'HIGH_VOLATILITY') return '높음';

  // warnings 검사 — 신고가/MA20 이격/20일 저점 +40% 등
  const ws = (c.warnings || []).join(' ');
  if (/신고가|52주|MA20|이격|저점|과열|급등/.test(ws)) return '주의';
  if ((c.dayReturn || 0) >= 10) return '주의';
  if ((c.closeFromRecentLow20 || 0) >= 30) return '주의';
  if ((c.closeToMA20 || 0) >= 15) return '주의';
  return '낮음';
}

// 차트 신뢰도 (history) → 사람이 읽기 쉬운 단계
function computeChartLevel(c) {
  if (c.historyQuality === 'FULL_HISTORY') return '좋음';
  if (c.historyQuality === 'MID_HISTORY') return '중간';
  return '짧음';
}

// 박스 상태 한국어
function computeBoxLevel(c) {
  if (c.boxQuality === 'BOX_STABLE') return '안정';
  if (c.boxQuality === 'BOX_VOLATILE') return '변동';
  return '불안정';
}

function computeMetricSummary(c) {
  const parts = [];
  parts.push('거래대금 ' + fmtX(c.valueRatio20, 1));
  parts.push('MA20 ' + fmtPct(c.closeToMA20, 1));
  parts.push('저점 ' + fmtPct(c.closeFromRecentLow20, 1));
  // 박스 또는 위험 상태 보조 어구
  if ((c.dayReturn || 0) >= 15 || (c.closeToMA20 || 0) >= 20) parts.push('과열 주의');
  else if ((c.closeFromRecentLow20 || 0) >= 40) parts.push('과열 주의');
  else parts.push('박스 ' + computeBoxLevel(c));
  return parts.join(' · ');
}

function trimCandidate(c) {
  const base = {
    code: c.code, name: c.name, market: c.market, marketCap: c.marketCap,
    watchTagV3_1: c.watchTagV3_1, riskOverlay: c.riskOverlay,
    historyQuality: c.historyQuality, boxQuality: c.boxQuality,
    finalScore: c.finalScore, setupScore: c.setupScore, momentumScore: c.momentumScore,
    historyScore: c.historyScore, riskPenalty: c.riskPenalty, riskScore: c.riskScore,
    valueRatio20: c.valueRatio20, volumeRatio20: c.volumeRatio20,
    valueToMarketCap: c.valueToMarketCap, closeLocation: c.closeLocation,
    closeToMA20: c.closeToMA20, closeFromRecentLow20: c.closeFromRecentLow20,
    closeFrom52WeekHigh: c.closeFrom52WeekHigh, dayReturn: c.dayReturn,
    boxRangePct: c.boxRangePct, dynamicBoxDuration: c.dynamicBoxDuration, boxFallback: c.boxFallback,
    warnings: c.warnings || [], interpretation: c.interpretation, labels: c.labels || [],
  };
  base.displayLabel = DISPLAY_LABEL[c.watchTagV3_1] || c.watchTagV3_1;
  base.summaryText = SUMMARY_TEXT[c.watchTagV3_1] || '-';
  base.metricSummary = computeMetricSummary(c);
  base.riskLevel = computeRiskLevel(c);
  base.chartLevel = computeChartLevel(c);
  base.boxLevel = computeBoxLevel(c);
  return base;
}

// 블록 내부 정렬: history > overlay > finalScore > riskScore > marketCap
function sortInsideBlock(list) {
  return [...list].sort((a, b) => {
    const ha = HISTORY_RANK[a.historyQuality] || 9;
    const hb = HISTORY_RANK[b.historyQuality] || 9;
    if (ha !== hb) return ha - hb;

    const oa = a.riskOverlay ? 1 : 0;
    const ob = b.riskOverlay ? 1 : 0;
    if (oa !== ob) return oa - ob;

    if ((a.finalScore || 0) !== (b.finalScore || 0)) return (b.finalScore || 0) - (a.finalScore || 0);

    if ((a.riskScore || 0) !== (b.riskScore || 0)) return (a.riskScore || 0) - (b.riskScore || 0);

    return (b.marketCap || 0) - (a.marketCap || 0);
  });
}

// 오늘 우선 확인 후보 산출 — 3블록 순차 (라운드로빈 X)
//   블록1: 먼저 볼 후보 (CLEAN_VALUE_SETUP) 상위 20
//   블록2: 힘 붙은 후보 (VALUE_SURGE_CONFIRM) 상위 15
//   블록3: 단기 반응 후보 (BREAKOUT_MOMENTUM, overlay 없는) 상위 15
function buildBlockList(sorted) {
  sorted.forEach(c => { c.coreFlag = false; c.block = null; c.coreOrder = -1; });

  const blockResults = {};
  let order = 0;
  BLOCK_DEF.forEach(b => {
    let pool = sorted.filter(c => c.watchTagV3_1 === b.tag);
    if (b.excludeOverlay) pool = pool.filter(c => !c.riskOverlay);
    pool = sortInsideBlock(pool).slice(0, b.limit);
    pool.forEach(c => {
      c.coreFlag = true;
      c.block = b.id;
      c.coreOrder = order++;
    });
    blockResults[b.id] = pool.length;
  });

  return {
    block1Cnt: blockResults.BLOCK1 || 0,
    block2Cnt: blockResults.BLOCK2 || 0,
    block3Cnt: blockResults.BLOCK3 || 0,
    total: order,
  };
}

function buildJson(source) {
  const candidates = (source.candidates || []).map(trimCandidate);
  const sorted = sortCandidates(candidates);
  const coreCount = buildBlockList(sorted);
  sorted.forEach((c, i) => { c.rank = i + 1; });

  const summary = source.summary || {};
  const meta = source.meta || {};

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceVersion: meta.version,
      latestTradingDate: meta.latestTradingDate,
      universeProcessed: summary.totalStocksProcessed || 0,
      totalCandidates: summary.totalCandidates || 0,
      coreVisibleCount: coreCount.total,
      block1Count: coreCount.block1Cnt,                    // 먼저 볼 후보
      block2Count: coreCount.block2Cnt,                    // 힘 붙은 후보
      block3Count: coreCount.block3Cnt,                    // 단기 반응 후보
      collapsedCount: (summary.totalCandidates || 0) - coreCount.total,
      highVolatilityTotalCount: (summary.highVolatilitySoloCount || 0) + (summary.highVolatilityOverlayCount || 0),
    },
    blockDef: BLOCK_DEF,
    summary: {
      VALUE_SURGE_CONFIRM: summary.valueSurgeConfirmCount || 0,
      CLEAN_VALUE_SETUP: summary.cleanValueSetupCount || 0,
      BREAKOUT_MOMENTUM: summary.breakoutMomentumCount || 0,
      VALUE_LOOSE: summary.valueLooseCount || 0,
      HIGH_VOLATILITY_solo: summary.highVolatilitySoloCount || 0,
      HIGH_VOLATILITY_overlay: summary.highVolatilityOverlayCount || 0,
      WATCH_ONLY: summary.watchOnlyCount || 0,
      LOW_SIGNAL: summary.lowSignalCount || 0,
      midfullCount: summary.midfullCount || 0,
      unclassifiedCount: summary.unclassifiedCount || 0,
    },
    coreLimits: CORE_LIMITS,
    displayLabel: DISPLAY_LABEL,
    summaryText: SUMMARY_TEXT,
    candidates: sorted,
  };
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>WRA 단기 반응 후보 보드</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body {
  margin: 0; padding: 16px 20px 80px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0;
  font-size: 13px;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }

.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

/* big summary tiles */
.big-summary { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.big-tile {
  flex: 1; min-width: 150px;
  background: #1e293b; border: 1px solid #334155; border-radius: 10px;
  padding: 14px 16px;
}
.big-tile .label { font-size: 12px; color: #94a3b8; margin-bottom: 4px; }
.big-tile .value { font-size: 26px; font-weight: 700; color: #f1f5f9; line-height: 1.1; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; }
.big-tile.primary { background: linear-gradient(135deg, #0c4a6e 0%, #1e293b 100%); border-color: #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }
.big-tile.warning { border-color: #b91c1c; }
.big-tile.warning .value { color: #fca5a5; }
.big-tile.success .value { color: #6ee7b7; }
.big-tile.muted .value { color: #cbd5e1; }

.intro {
  background: #1e293b; border-left: 4px solid #38bdf8; padding: 9px 14px; border-radius: 6px;
  font-size: 13px; color: #cbd5e1; margin-bottom: 14px; line-height: 1.6;
}
.intro strong { color: #67e8f9; }

/* quick filters */
.quick-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.qf-btn {
  background: #1e293b; color: #cbd5e1; border: 1px solid #334155;
  border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer;
  font-weight: 500; transition: all 0.12s;
}
.qf-btn:hover { border-color: #64748b; color: #f1f5f9; }
.qf-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }
.adv-toggle {
  margin-left: auto;
  background: transparent; color: #94a3b8; border: 1px solid #334155;
  border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer;
}
.adv-toggle:hover { color: #cbd5e1; border-color: #64748b; }
.match-status { font-size: 12px; color: #94a3b8; margin-left: 12px; }

/* advanced filter (collapsed) */
.adv-bar { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; display: none; }
.adv-bar.open { display: block; }
.adv-row { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
.adv-row + .adv-row { margin-top: 8px; padding-top: 8px; border-top: 1px solid #334155; }
.adv-group { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.adv-group .gname { font-size: 10px; color: #64748b; padding-right: 3px; text-transform: uppercase; letter-spacing: 0.5px; }
.btn-f {
  background: #0f172a; color: #94a3b8; border: 1px solid #334155;
  border-radius: 5px; padding: 4px 9px; font-size: 11px; cursor: pointer;
  transition: all 0.12s;
}
.btn-f:hover { border-color: #64748b; color: #cbd5e1; }
.btn-f.active { background: #1e40af; color: #f1f5f9; border-color: #3b82f6; }
.input-f {
  background: #0f172a; color: #e2e8f0; border: 1px solid #334155;
  border-radius: 5px; padding: 4px 9px; font-size: 11px; height: 26px; min-width: 130px;
}
.input-f:focus { outline: none; border-color: #3b82f6; }

/* table */
.tbl-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.list { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
table.list thead th {
  background: #0f172a; color: #94a3b8; font-weight: 600; text-align: left;
  padding: 10px 8px; border-bottom: 1px solid #334155; white-space: nowrap;
  position: sticky; top: 0; z-index: 5; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px;
  cursor: pointer; user-select: none;
}
table.list thead th:hover { color: #cbd5e1; }
table.list thead th.numeric { text-align: right; }
table.list thead th .arrow { color: #38bdf8; margin-left: 3px; }
table.list tbody tr.row { border-bottom: 1px solid #1e293b; cursor: pointer; transition: background 0.1s; }
table.list tbody tr.row:hover { background: #273549; }
table.list tbody tr.row.expanded { background: #1e3a5f; }
table.list tbody tr.row td { padding: 10px 8px; vertical-align: middle; white-space: nowrap; }
table.list tbody tr.row td.numeric { text-align: right; }
table.list tbody tr.row td.col-rank { color: #64748b; font-size: 12px; width: 40px; }
table.list tbody tr.row td.col-name { font-weight: 600; color: #f1f5f9; min-width: 160px; }
table.list tbody tr.row td.col-name .meta { font-size: 11px; color: #64748b; font-weight: 400; margin-left: 6px; }
table.list tbody tr.row td.col-name a.stock-link { color: inherit; text-decoration: none; border-bottom: 1px dashed transparent; }
table.list tbody tr.row td.col-name a.stock-link:hover { color: #67e8f9; border-bottom-color: #67e8f9; }
table.list tbody tr.row td.col-name a.stock-link::after {
  content: '↗'; font-size: 10px; color: #64748b; margin-left: 4px; opacity: 0.7;
}
table.list tbody tr.row td.col-name a.stock-link:hover::after { color: #67e8f9; opacity: 1; }
table.list tbody tr.row td.col-summary { color: #cbd5e1; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }

/* zebra */
table.list tbody tr.row:nth-child(4n+1) { background: #1c2942; }
table.list tbody tr.row:nth-child(4n+1):hover { background: #273549; }
table.list tbody tr.row.expanded,
table.list tbody tr.row.expanded:nth-child(4n+1) { background: #1e3a5f; }

/* 블록 구분 행 — 약하게, 화면을 크게 쪼개지 않음 */
table.list tbody tr.group-row { background: #15243a; }
table.list tbody tr.group-row td {
  padding: 8px 12px; border-top: 1px solid #1e3a5f; border-bottom: 1px solid #1e3a5f;
  font-size: 12px; color: #cbd5e1; font-weight: 600; white-space: nowrap;
}
table.list tbody tr.group-row .gnum { color: #64748b; margin-right: 6px; font-weight: 400; }
table.list tbody tr.group-row .gtitle { color: #f1f5f9; }
table.list tbody tr.group-row .gcount { color: #94a3b8; font-weight: 400; margin-left: 6px; font-size: 11px; }
table.list tbody tr.group-row .gdesc { color: #94a3b8; font-weight: 400; margin-left: 14px; font-size: 12px; }
@media (max-width: 900px) {
  table.list tbody tr.group-row .gdesc { display: none; }
}

/* type chip (한국어 표시) */
.type-chip { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.type-chip.t-CLEAN_VALUE_SETUP { background: #047857; color: #d1fae5; }
.type-chip.t-VALUE_SURGE_CONFIRM { background: #0e7490; color: #cffafe; }
.type-chip.t-BREAKOUT_MOMENTUM { background: #6d28d9; color: #ede9fe; }
.type-chip.t-VALUE_LOOSE { background: #92400e; color: #fef3c7; }
.type-chip.t-HIGH_VOLATILITY { background: #991b1b; color: #fee2e2; }
.type-chip.t-WATCH_ONLY { background: #475569; color: #e2e8f0; }
.type-chip.t-LOW_SIGNAL { background: #1e293b; color: #94a3b8; border: 1px solid #475569; }

.overlay-pill {
  display: inline-block; margin-left: 5px; padding: 2px 7px; border-radius: 999px;
  font-size: 10px; font-weight: 700; background: #b91c1c; color: #fee2e2;
}

/* risk pill */
.risk-pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.risk-pill.r-low { background: #14532d; color: #86efac; }
.risk-pill.r-mid { background: #713f12; color: #fde047; }
.risk-pill.r-high { background: #7f1d1d; color: #fca5a5; }

/* chart pill (history) */
.chart-pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.chart-pill.c-good { background: #14532d; color: #86efac; }
.chart-pill.c-mid { background: #1e3a8a; color: #93c5fd; }
.chart-pill.c-short { background: #334155; color: #94a3b8; }

/* numeric coloring */
.tcell-num.pos { color: #6ee7b7; }
.tcell-num.neg { color: #fca5a5; }
.tcell-num.warm { color: #fde047; }
.tcell-num.hot { color: #fca5a5; font-weight: 600; }

.score-cell {
  font-weight: 700;
  color: #fbbf24;
}

/* expanded detail row */
table.list tbody tr.detail { display: none; background: #0c1729; }
table.list tbody tr.detail.show { display: table-row; }
table.list tbody tr.detail td { padding: 14px 18px; border-bottom: 1px solid #1e3a5f; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px 24px; font-size: 12px; }
.detail-block h4 { margin: 0 0 6px; font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.detail-block p { margin: 0 0 4px; color: #cbd5e1; line-height: 1.6; }
.detail-block code { background: #1e293b; padding: 1px 5px; border-radius: 3px; color: #67e8f9; font-size: 11px; }
.detail-block .interp { color: #fde68a; font-style: italic; }
.detail-block .warn { color: #fca5a5; }
.detail-block .label-chip {
  display: inline-block; padding: 1px 7px; margin: 1px 3px 1px 0;
  background: #1e293b; color: #93c5fd; border: 1px solid #1e40af;
  border-radius: 999px; font-size: 10px;
}

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

@media (max-width: 900px) {
  /* 모바일: 본문 세로 스크롤 자연스럽게, 표는 안에서 가로 스크롤 */
  html, body { overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  body { padding: 12px 12px 60px; max-width: 100%; }
  .detail-grid { grid-template-columns: 1fr; }
  table.list { font-size: 12px; }
  /* 좁은 화면에서는 한줄판단 컬럼 숨김 (헤더+셀 둘 다 숨겨야 정렬 어긋나지 않음) */
  .col-summary,
  table.list thead th[data-sort="summaryText"] { display: none; }
  /* sticky thead가 모바일에서 일부 브라우저에서 스크롤 막을 수 있어 해제 */
  table.list thead th { position: static; }
  /* 표 가로 스크롤 보장 */
  .tbl-wrap { overflow-x: auto !important; -webkit-overflow-scrolling: touch; }
}
/* iOS 모멘텀 스크롤 보강 */
body { -webkit-overflow-scrolling: touch; }
/* board ↔ board 이동 링크 */
.board-switch-row {
  display: flex; align-items: center; justify-content: space-between;
  flex-wrap: wrap; gap: 10px; margin: 4px 0 14px;
}
.board-switch-row .hint { font-size: 12px; color: #94a3b8; }
.board-switch-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px; border-radius: 999px;
  font-size: 13px; font-weight: 700; text-decoration: none;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.08);
  color: #e5e7eb;
  transition: background 0.12s, border-color 0.12s, transform 0.06s;
}
.board-switch-btn:hover { background: rgba(255,255,255,0.14); transform: translateY(-1px); }
.board-switch-btn.qva { border-color: rgba(34,197,94,0.45); }
.board-switch-btn.wra { border-color: rgba(96,165,250,0.45); }
</style>
</head>
<body>

<h1 style="font-size:26px;">오늘은 어떤 후보를 볼까요?</h1>
<div class="lead-desc" style="font-size:14px;color:#cbd5e1;margin:4px 0 12px;line-height:1.6;">
  WRA는 매수 신호가 아니라 <strong style="color:#67e8f9;">단기 반응 가능성을 목적별로 나눠 보여주는 보드</strong>입니다.
  아래에서 오늘 보고 싶은 후보 그룹을 선택하세요.
</div>
<div class="board-switch-row">
  <span class="hint">20거래일 추적 후보는 QVA 보드에서 확인하세요.</span>
  <a class="board-switch-btn qva" href="/qva-watchlist">📋 QVA 20거래일 추적 후보 보드 보기 →</a>
</div>
<div class="subtitle" id="subtitle">로딩 중…</div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> WRA는 단기 반응 가능성을 분류하는 보드입니다.
  <strong>안정 관찰</strong>은 실패율이 낮은 후보, <strong>단기 반응</strong>은 크게 움직일 수 있지만 실패율도 높은 후보입니다.
  실제 매수 판단은 차트·뉴스·시장 상황을 별도로 확인하세요.
</div>

<div class="big-summary" id="big-summary"></div>

<div class="intro">
  <strong>오늘 우선 확인할 후보만</strong> 보여줍니다. <strong>① 먼저 볼 후보</strong>는 덜 오른 거래대금 유입, <strong>② 힘 붙은 후보</strong>는 이미 움직인 종목, <strong>③ 단기 반응 후보</strong>는 다음 거래일 반응 확인용입니다.
  <br>
  <span style="color:#94a3b8;">전체 후보와 고위험 변동성 후보는 아래 빠른 필터로 확인하세요.</span>
</div>

<style>
  .mode-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 12px; }
  .mode-card-btn {
    background: #1e293b; border: 2px solid #334155; border-radius: 12px;
    padding: 14px 16px; cursor: pointer; text-align: left;
    transition: all 0.15s; position: relative;
    color: #cbd5e1; font-family: inherit;
  }
  .mode-card-btn:hover { border-color: #64748b; transform: translateY(-1px); background: #273549; }
  .mode-card-btn.active { background: #0f4f64; border-color: #38bdf8; box-shadow: 0 0 0 1px #38bdf8 inset; }
  .mode-card-btn .ic { font-size: 22px; line-height: 1; }
  .mode-card-btn .title { font-size: 15px; font-weight: 700; color: #f1f5f9; margin: 6px 0 4px; display: flex; align-items: center; gap: 6px; }
  .mode-card-btn .desc { font-size: 11.5px; color: #94a3b8; line-height: 1.5; }
  .mode-card-btn.aggressive { border-color: rgba(239,68,68,0.4); }
  .mode-card-btn.aggressive .title { color: #fca5a5; }
  .mode-card-btn.aggressive.active { background: #4c0a0a; border-color: #ef4444; box-shadow: 0 0 0 1px #ef4444 inset; }
  .warn-badge {
    display: inline-block; background: #b91c1c; color: #fee2e2;
    font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px;
    letter-spacing: 0.4px; animation: pulse-warn 2s infinite;
  }
  @keyframes pulse-warn { 0%,100% { opacity: 1; } 50% { opacity: 0.65; } }
  .mode-card-btn .count-badge {
    position: absolute; top: 10px; right: 12px;
    background: rgba(0,0,0,0.3); color: #cbd5e1;
    font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  }
  .mode-card-btn.active .count-badge { background: #38bdf8; color: #0f172a; }
  .mode-card-btn.aggressive.active .count-badge { background: #ef4444; color: #fee2e2; }
</style>

<div class="mode-cards">
  <button type="button" class="mode-card-btn aggressive active" data-preset="HIGH_VOL_ONLY">
    <span class="count-badge" data-count-for="HIGH_VOL_ONLY"></span>
    <span class="ic">🔥</span>
    <div class="title">고위험 공격형 <span class="warn-badge">⚠ 주의</span></div>
    <div class="desc">공격적으로 단기 변동성을 확인하고 싶다면 고위험 공격형 후보를 볼 수 있습니다. 단, 이 그룹은 크게 움직일 가능성과 실패 가능성이 모두 높으므로 추격주의가 필요합니다. 실제 판단은 차트, 거래대금 유지, 뉴스 흐름을 함께 확인하세요.</div>
  </button>
  <button type="button" class="mode-card-btn" data-preset="REACTION">
    <span class="count-badge" data-count-for="REACTION"></span>
    <span class="ic">⚡</span>
    <div class="title">단기 반응</div>
    <div class="desc">다음 거래일 크게 움직일 가능성이 있는 후보입니다. 실패율도 높으므로 추격주의가 필요합니다.</div>
  </button>
  <button type="button" class="mode-card-btn" data-preset="STABLE">
    <span class="count-badge" data-count-for="STABLE"></span>
    <span class="ic">🛡️</span>
    <div class="title">안정 관찰</div>
    <div class="desc">거래대금은 들어왔지만 상대적으로 위험이 낮은 후보입니다. 단기 급등보다는 관심종목 관찰에 적합합니다.</div>
  </button>
  <button type="button" class="mode-card-btn" data-preset="ALL">
    <span class="count-badge" data-count-for="ALL"></span>
    <span class="ic">📋</span>
    <div class="title">전체 보기</div>
    <div class="desc">전체 WRA 후보를 모두 확인합니다. 약한 신호와 약한 관찰도 포함됩니다.</div>
  </button>
</div>

<div id="mode-desc" style="background:#1e293b;border-left:4px solid #38bdf8;padding:9px 14px;border-radius:6px;font-size:12px;color:#cbd5e1;margin-bottom:10px;line-height:1.6;display:none;"></div>

<div class="quick-bar" style="margin-bottom:8px;">
  <span class="match-status" id="match-status"></span>
  <button class="qf-btn" data-preset="MID_FULL" style="margin-left:auto;">📊 차트신뢰 높은 것만</button>
  <button class="adv-toggle" id="adv-toggle">고급 필터 ▾</button>
</div>

<div class="adv-bar" id="adv-bar">
  <div class="adv-row">
    <div class="adv-group">
      <span class="gname">유형</span>
      <button class="btn-f" data-tag="CLEAN_VALUE_SETUP">안정 관찰</button>
      <button class="btn-f" data-tag="VALUE_SURGE_CONFIRM">상승 확인</button>
      <button class="btn-f" data-tag="BREAKOUT_MOMENTUM">단기 반응</button>
      <button class="btn-f" data-tag="VALUE_LOOSE">보조 유입</button>
      <button class="btn-f" data-tag="HIGH_VOLATILITY">고위험 단기반응</button>
      <button class="btn-f" data-tag="WATCH_ONLY">약한 관찰</button>
      <button class="btn-f" data-tag="LOW_SIGNAL">약한 신호</button>
    </div>
  </div>
  <div class="adv-row">
    <div class="adv-group">
      <span class="gname">시장</span>
      <button class="btn-f" data-market="KOSPI">KOSPI</button>
      <button class="btn-f" data-market="KOSDAQ">KOSDAQ</button>
    </div>
    <div class="adv-group">
      <span class="gname">박스</span>
      <button class="btn-f" data-box="BOX_STABLE">안정</button>
      <button class="btn-f" data-box="BOX_VOLATILE">변동</button>
      <button class="btn-f" data-box="BOX_UNSTABLE">불안정</button>
    </div>
    <div class="adv-group">
      <span class="gname">최소점수</span>
      <input class="input-f" type="number" id="min-final" placeholder="-" step="1" style="width: 80px;">
    </div>
    <input class="input-f" type="search" id="q" placeholder="🔍 종목명 / 코드">
    <button class="btn-f" id="reset-adv">고급 필터 초기화</button>
  </div>
</div>

<div class="tbl-wrap">
  <table class="list">
    <thead>
      <tr>
        <th data-sort="rank">#</th>
        <th data-sort="name">종목</th>
        <th data-sort="watchTagV3_1">유형</th>
        <th data-sort="summaryText">한줄판단</th>
        <th class="numeric" data-sort="finalScore">점수</th>
        <th class="numeric" data-sort="valueRatio20">거래대금</th>
        <th class="numeric" data-sort="closeToMA20">과열</th>
        <th class="numeric" data-sort="closeFromRecentLow20">저점대비</th>
        <th data-sort="historyQuality">차트</th>
        <th data-sort="riskLevel">위험</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<footer class="foot">
  <strong>WRA/BMS는 매수 신호가 아니라 단기 반응 가능성이 있는 후보를 분류하는 보드입니다.</strong>
  실제 매수 판단은 차트, 뉴스, 시장 상황 확인 후 별도로 해야 합니다.
  <br>
  <small>
    데이터: reports/wra-current-similarity-report-v3-1.json (WRA Current Similarity v3.1) · UNCLASSIFIED 0건 ·
    내부 우선순위: CLEAN_VALUE_SETUP > VALUE_SURGE_CONFIRM > BREAKOUT_MOMENTUM > VALUE_LOOSE > HIGH_VOLATILITY > WATCH_ONLY > LOW_SIGNAL ·
    행 클릭 시 상세 펼침.
  </small>
</footer>

<script id="board-data" type="application/json">__JSON_DATA__</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('board-data').textContent);
  const meta = data.meta || {};
  const summary = data.summary || {};
  const displayLabel = data.displayLabel || {};
  const candidates = data.candidates || [];

  const HISTORY_RANK = { FULL_HISTORY: 1, MID_HISTORY: 2, SHORT_HISTORY: 3, INSUFFICIENT: 4 };
  const BOX_RANK = { BOX_STABLE: 1, BOX_VOLATILE: 2, BOX_UNSTABLE: 3 };
  const RISK_RANK = { '낮음': 1, '주의': 2, '높음': 3 };

  function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }
  function fmtNum(v, digits) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(digits == null ? 1 : digits); }
  function fmtPct(v, digits) { if (v == null || !isFinite(v)) return '-'; return (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(digits == null ? 1 : digits) + '%'; }
  function fmtMc(v) { if (!v) return '-'; const eok = v / 100_000_000; if (eok >= 10000) return (eok / 10000).toFixed(1) + '조'; return Math.round(eok) + '억'; }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

  // 서브타이틀
  document.getElementById('subtitle').innerHTML =
    '기준일 <strong style="color:#cbd5e1;">' + fmtDate(meta.latestTradingDate) + '</strong> · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  // ── 큰 요약 타일 5개
  const bigTiles = [
    { label: '오늘 우선 확인', value: meta.coreVisibleCount, sub: '먼저 볼 후보 ' + meta.block1Count + ' · 힘 붙은 후보 ' + meta.block2Count + ' · 단기 반응 후보 ' + meta.block3Count, cls: 'primary' },
    { label: '전체 후보', value: meta.totalCandidates, sub: '분석 종목 ' + meta.universeProcessed + '개', cls: 'muted' },
    { label: '고위험 변동성', value: meta.highVolatilityTotalCount, sub: '단독 ' + summary.HIGH_VOLATILITY_solo + ' + overlay ' + summary.HIGH_VOLATILITY_overlay, cls: 'warning' },
    { label: '차트신뢰 높음', value: summary.midfullCount, sub: 'MID/FULL_HISTORY (120일+)', cls: 'success' },
    { label: '기준일', value: fmtDate(meta.latestTradingDate), sub: 'UNCLASSIFIED ' + summary.unclassifiedCount + ' ' + (summary.unclassifiedCount === 0 ? '✅' : '⚠️'), cls: 'muted' },
  ];
  const bigRow = document.getElementById('big-summary');
  bigTiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML =
      '<div class="label">' + escapeHtml(t.label) + '</div>' +
      '<div class="value">' + escapeHtml(String(t.value)) + '</div>' +
      '<div class="sub">' + escapeHtml(t.sub) + '</div>';
    bigRow.appendChild(el);
  });

  // ── 상태 (v3.2 모드 5가지: STABLE / REACTION / HIGH_VOL_ONLY / ALL / MID_FULL)
  // 기본 모드 = HIGH_VOL_ONLY (사용자가 진입 시 고위험 후보부터 보고 싶음)
  const state = {
    preset: 'HIGH_VOL_ONLY',
    tags: new Set(),
    market: new Set(),
    box: new Set(),
    minFinal: null,
    q: '',
    sortKey: null,
    sortDir: 'desc',
  };

  // 모드 정의 (rolling 검증 결과 기반)
  const MODES = {
    STABLE: {
      title: '안정 관찰', icon: '🛡️',
      desc: '거래대금 유입은 있으나 상대적으로 위험이 낮은 후보입니다. 단기 급등보다 관심종목 관찰에 적합합니다. (rolling RR 2.56)',
      filter: function (c) {
        if (c.watchTagV3_1 === 'CLEAN_VALUE_SETUP') return true;
        if (c.watchTagV3_1 === 'VALUE_LOOSE' && !c.riskOverlay && (c.riskScore || 0) < 20) return true;
        return false;
      },
      sortFn: function (a, b) {
        // 1. CLEAN_VALUE_SETUP 우선
        const ta = a.watchTagV3_1 === 'CLEAN_VALUE_SETUP' ? 0 : 1;
        const tb = b.watchTagV3_1 === 'CLEAN_VALUE_SETUP' ? 0 : 1;
        if (ta !== tb) return ta - tb;
        const oa = a.riskOverlay ? 1 : 0;
        const ob = b.riskOverlay ? 1 : 0;
        if (oa !== ob) return oa - ob;
        const ha = HISTORY_RANK[a.historyQuality] || 9;
        const hb = HISTORY_RANK[b.historyQuality] || 9;
        if (ha !== hb) return ha - hb;
        if ((a.finalScore || 0) !== (b.finalScore || 0)) return (b.finalScore || 0) - (a.finalScore || 0);
        return (a.riskScore || 0) - (b.riskScore || 0);
      },
    },
    REACTION: {
      title: '단기 반응', icon: '⚡',
      desc: '크게 움직일 가능성이 있는 후보입니다. 실패율도 높으므로 추격주의가 필요합니다. (rolling avg +1.4%, +3% 도달 30.8%)',
      filter: function (c) {
        if (c.watchTagV3_1 === 'HIGH_VOLATILITY') return true;
        if ((c.riskScore || 0) >= 30) return true;
        if (c.watchTagV3_1 === 'VALUE_SURGE_CONFIRM') return true;
        if (c.watchTagV3_1 === 'BREAKOUT_MOMENTUM') return true;
        return false;
      },
      sortFn: function (a, b) {
        const ra = (a.riskScore || 0) >= 30 ? 0 : 1;
        const rb = (b.riskScore || 0) >= 30 ? 0 : 1;
        if (ra !== rb) return ra - rb;
        const ta = a.watchTagV3_1 === 'HIGH_VOLATILITY' ? 0 : 1;
        const tb = b.watchTagV3_1 === 'HIGH_VOLATILITY' ? 0 : 1;
        if (ta !== tb) return ta - tb;
        if ((a.valueRatio20 || 0) !== (b.valueRatio20 || 0)) return (b.valueRatio20 || 0) - (a.valueRatio20 || 0);
        if ((a.momentumScore || 0) !== (b.momentumScore || 0)) return (b.momentumScore || 0) - (a.momentumScore || 0);
        return (b.finalScore || 0) - (a.finalScore || 0);
      },
    },
    HIGH_VOL_ONLY: {
      title: '고위험만', icon: '🔥',
      desc: '단기 반응은 강하지만 실패율도 높은 후보입니다. 반드시 고변동성 후보로 분리해서 봅니다.',
      filter: function (c) {
        if (c.watchTagV3_1 === 'HIGH_VOLATILITY') return true;
        if (c.riskOverlay === 'HIGH_VOLATILITY') return true;
        if ((c.riskScore || 0) >= 30) return true;
        return false;
      },
      sortFn: function (a, b) {
        if ((a.riskScore || 0) !== (b.riskScore || 0)) return (b.riskScore || 0) - (a.riskScore || 0);
        if ((a.valueRatio20 || 0) !== (b.valueRatio20 || 0)) return (b.valueRatio20 || 0) - (a.valueRatio20 || 0);
        return (b.dayReturn || 0) - (a.dayReturn || 0);
      },
    },
    ALL: {
      title: '전체 보기', icon: '📋',
      desc: '전체 후보. LOW_SIGNAL/약한 관찰은 흐리게 표시.',
      filter: function () { return true; },
      sortFn: null,             // 기본 priority 정렬 사용
    },
    MID_FULL: {
      title: '차트신뢰 높은 것만', icon: '📊',
      desc: 'MID/FULL_HISTORY (120일 이상) 차트가 있는 후보만. LOW_SIGNAL 제외.',
      filter: function (c) {
        if (c.watchTagV3_1 === 'LOW_SIGNAL') return false;
        return c.historyQuality === 'MID_HISTORY' || c.historyQuality === 'FULL_HISTORY';
      },
      sortFn: function (a, b) {
        const ta = TAG_RANK[a.watchTagV3_1] || 99;
        const tb = TAG_RANK[b.watchTagV3_1] || 99;
        if (ta !== tb) return ta - tb;
        if ((a.finalScore || 0) !== (b.finalScore || 0)) return (b.finalScore || 0) - (a.finalScore || 0);
        return (a.riskScore || 0) - (b.riskScore || 0);
      },
    },
  };
  const TAG_RANK = { CLEAN_VALUE_SETUP: 1, VALUE_SURGE_CONFIRM: 2, BREAKOUT_MOMENTUM: 3, VALUE_LOOSE: 4, HIGH_VOLATILITY: 5, WATCH_ONLY: 6, LOW_SIGNAL: 7 };

  // ── 행 빌드
  const tbody = document.getElementById('list-body');
  const rowsByCode = {};

  function riskClass(level) {
    if (level === '높음') return 'r-high';
    if (level === '주의') return 'r-mid';
    return 'r-low';
  }
  function chartClass(level) {
    if (level === '좋음') return 'c-good';
    if (level === '중간') return 'c-mid';
    return 'c-short';
  }
  function ma20Class(v) {
    if (v == null || !isFinite(v)) return '';
    if (v >= 20) return 'hot';
    if (v >= 12) return 'warm';
    return v > 0 ? 'pos' : (v < 0 ? 'neg' : '');
  }
  function lowClass(v) {
    if (v == null || !isFinite(v)) return '';
    if (v >= 40) return 'hot';
    if (v >= 25) return 'warm';
    return v > 0 ? 'pos' : (v < 0 ? 'neg' : '');
  }

  function buildRow(c) {
    const tr = document.createElement('tr');
    tr.className = 'row tag-' + c.watchTagV3_1 + (c.riskOverlay ? ' has-overlay' : '');
    tr.dataset.code = c.code;
    tr.dataset.tag = c.watchTagV3_1;
    tr.dataset.overlay = c.riskOverlay ? 'yes' : 'no';
    tr.dataset.hist = c.historyQuality;
    tr.dataset.box = c.boxQuality;
    tr.dataset.market = c.market || '';
    tr.dataset.name = c.name;
    tr.dataset.core = c.coreFlag ? '1' : '0';
    tr.dataset.risk = c.riskLevel;

    const overlayPill = c.riskOverlay ? '<span class="overlay-pill">고위험</span>' : '';

    tr.innerHTML =
      '<td class="col-rank">' + c.rank + '</td>' +
      '<td class="col-name">' +
        '<a class="stock-link" href="/?query=' + encodeURIComponent(c.code) + '&from=wra-watchlist" target="_blank" rel="noopener" title="새 창에서 상세 페이지 열기" onclick="event.stopPropagation();">' +
          escapeHtml(c.name) +
        '</a>' +
        '<span class="meta">' + c.code + ' · ' + (c.market || '-') + ' · ' + fmtMc(c.marketCap) + '</span>' +
      '</td>' +
      '<td><span class="type-chip t-' + c.watchTagV3_1 + '">' + (c.displayLabel || displayLabel[c.watchTagV3_1] || c.watchTagV3_1) + '</span>' + overlayPill + '</td>' +
      '<td class="col-summary">' + escapeHtml(c.summaryText) + '</td>' +
      '<td class="numeric score-cell">' + fmtNum(c.finalScore) + '</td>' +
      '<td class="numeric">' + fmtNum(c.valueRatio20, 1) + '배</td>' +
      '<td class="numeric tcell-num ' + ma20Class(c.closeToMA20) + '">MA20 ' + fmtPct(c.closeToMA20, 1) + '</td>' +
      '<td class="numeric tcell-num ' + lowClass(c.closeFromRecentLow20) + '">' + fmtPct(c.closeFromRecentLow20, 1) + '</td>' +
      '<td><span class="chart-pill ' + chartClass(c.chartLevel) + '">' + c.chartLevel + '</span></td>' +
      '<td><span class="risk-pill ' + riskClass(c.riskLevel) + '">' + c.riskLevel + '</span></td>';

    // 상세
    const trd = document.createElement('tr');
    trd.className = 'detail';
    trd.dataset.code = c.code;
    const labelChips = (c.labels || []).map(l => '<span class="label-chip">' + escapeHtml(l) + '</span>').join('');
    const warnsHtml = (c.warnings && c.warnings.length)
      ? c.warnings.map(w => '<p class="warn">⚠ ' + escapeHtml(w) + '</p>').join('')
      : '<p style="color:#64748b;">없음</p>';
    trd.innerHTML =
      '<td colspan="10">' +
        '<div class="detail-grid">' +
          '<div class="detail-block">' +
            '<h4>분류 · 라벨</h4>' +
            '<p>유형 (화면): <code>' + (c.displayLabel || c.watchTagV3_1) + '</code></p>' +
            '<p>내부 라벨: <code>' + c.watchTagV3_1 + '</code>' + (c.riskOverlay ? ' + <code style="color:#fca5a5;">' + c.riskOverlay + '</code>' : '') + '</p>' +
            '<p class="interp">' + escapeHtml(c.interpretation || '') + '</p>' +
            '<p>BMS 라벨: ' + (labelChips || '<span style="color:#64748b;">없음</span>') + '</p>' +
            '<p style="color:#64748b; margin-top:4px;">' + escapeHtml(c.metricSummary) + '</p>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>점수 분해</h4>' +
            '<p>setupScore <code>' + fmtNum(c.setupScore) + '</code> — boxQuality·CLEAN 조건·MA20 거리·저점거리·valueRatio·history 가산</p>' +
            '<p>momentumScore <code>' + fmtNum(c.momentumScore) + '</code> — BMS_VALUE/SURGE/BREAKOUT/valueAndSurge·closeLocation</p>' +
            '<p>historyScore <code>' + fmtNum(c.historyScore, 0) + '</code> — FULL +10 / MID +6 / SHORT 0</p>' +
            '<p>riskPenalty <code style="color:#fca5a5;">−' + fmtNum(c.riskPenalty) + '</code> — riskScore + 추격·과열·overlay 가산</p>' +
            '<p>finalScore <code style="color:#fbbf24; font-weight:700;">' + fmtNum(c.finalScore) + '</code> = setup + mom + hist − risk</p>' +
            '<p style="color:#64748b; margin-top:4px;">riskScore=' + (c.riskScore || 0) + '</p>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>지표 상세</h4>' +
            '<p>거래대금/볼륨: valueRatio20 <code>' + fmtNum(c.valueRatio20, 2) + '×</code> · volumeRatio20 <code>' + fmtNum(c.volumeRatio20, 2) + '×</code></p>' +
            '<p>회전율 (val/MC): <code>' + (c.valueToMarketCap != null ? fmtNum(c.valueToMarketCap * 100, 2) + '%' : '-') + '</code></p>' +
            '<p>당일 종가 위치: closeLocation <code>' + fmtNum(c.closeLocation, 2) + '</code> (0=하단, 1=상단)</p>' +
            '<p>52주 고점 대비: <code>' + fmtPct(c.closeFrom52WeekHigh) + '</code></p>' +
            '<p>당일 수익률: <code>' + fmtPct(c.dayReturn) + '</code></p>' +
            '<p>박스: range <code>' + fmtNum(c.boxRangePct, 1) + '%</code> · 기간 <code>' + (c.dynamicBoxDuration || '-') + 'd' + (c.boxFallback ? ' (fallback)' : '') + '</code></p>' +
          '</div>' +
          '<div class="detail-block" style="grid-column: 1 / -1;">' +
            '<h4>경고 (warnings)</h4>' +
            warnsHtml +
          '</div>' +
        '</div>' +
      '</td>';

    return [tr, trd];
  }

  // 블록 구분 행 (CORE 모드 전용 — 다른 모드에서는 탈착)
  const groupRows = {};
  function buildGroupRows() {
    const blockDef = data.blockDef || [];
    const counts = {
      BLOCK1: meta.block1Count || 0,
      BLOCK2: meta.block2Count || 0,
      BLOCK3: meta.block3Count || 0,
    };
    const numerals = { BLOCK1: '①', BLOCK2: '②', BLOCK3: '③' };
    blockDef.forEach(b => {
      const tr = document.createElement('tr');
      tr.className = 'group-row';
      tr.dataset.block = b.id;
      tr.innerHTML =
        '<td colspan="10">' +
          '<span class="gnum">' + numerals[b.id] + '</span>' +
          '<span class="gtitle">' + escapeHtml(b.title) + '</span>' +
          '<span class="gcount">(' + counts[b.id] + '건)</span>' +
          '<span class="gdesc">' + escapeHtml(b.desc) + '</span>' +
        '</td>';
      groupRows[b.id] = tr;
    });
  }

  function render() {
    tbody.innerHTML = '';
    buildGroupRows();
    candidates.forEach(c => {
      const [tr, trd] = buildRow(c);
      tbody.appendChild(tr);
      tbody.appendChild(trd);
      rowsByCode[c.code] = { row: tr, detail: trd, data: c };
      tr.addEventListener('click', () => {
        tr.classList.toggle('expanded');
        trd.classList.toggle('show');
      });
    });
    applyFilters();
  }

  // ── 가시성: 모드 정의의 filter 사용 + 추가 사용자 필터
  function isVisible(c) {
    const mode = MODES[state.preset];
    if (!mode || !mode.filter(c)) return false;

    // 사용자 추가 필터
    if (state.tags.size > 0 && !state.tags.has(c.watchTagV3_1)) return false;
    if (state.market.size > 0 && !state.market.has(c.market)) return false;
    if (state.box.size > 0 && !state.box.has(c.boxQuality)) return false;
    if (state.minFinal != null && (c.finalScore == null || c.finalScore < state.minFinal)) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      if (!String(c.name || '').toLowerCase().includes(q) && !String(c.code || '').toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function applyFilters() {
    let total = candidates.length;
    let visible = 0;

    // 1) preset 별 화면 정렬 (사용자가 컬럼 정렬을 누르지 않은 동안만 자동 적용)
    if (!state.sortKey) reorderForPreset();

    // 2) 가시성
    Object.values(rowsByCode).forEach(({ row, detail, data }) => {
      const v = isVisible(data);
      row.style.display = v ? '' : 'none';
      if (!v) {
        detail.classList.remove('show');
        row.classList.remove('expanded');
        detail.style.display = 'none';
      } else {
        detail.style.display = detail.classList.contains('show') ? '' : 'none';
        visible++;
      }
    });

    // 3) 행 번호 (#) 표시값을 화면 순서로 갱신
    let n = 1;
    Array.from(tbody.querySelectorAll('tr.row')).forEach(tr => {
      if (tr.style.display !== 'none') {
        const c = tr.querySelector('.col-rank');
        if (c) c.textContent = n++;
      }
    });

    document.getElementById('match-status').innerHTML =
      '<strong style="color:#cbd5e1;">' + visible + '</strong>건 표시 / 전체 ' + total;

    // 모드 설명 갱신 — MID_FULL 같이 카드에 없는 모드일 때만 인라인 표시
    const modeDesc = document.getElementById('mode-desc');
    if (modeDesc) {
      const mode = MODES[state.preset];
      const inCardSet = ['STABLE', 'REACTION', 'HIGH_VOL_ONLY', 'ALL'].includes(state.preset);
      if (mode && !inCardSet) {
        modeDesc.style.display = '';
        modeDesc.innerHTML = '<span style="font-size:14px;">' + (mode.icon || '📊') + '</span> <strong style="color:#67e8f9;">' + mode.title + '</strong> — ' + mode.desc;
      } else {
        modeDesc.style.display = 'none';
      }
    }
  }

  // 모드 변경 시 그 모드의 정렬 적용 (group-row는 v3.2에서 사용 안 함, 단일 리스트)
  function reorderForPreset() {
    Object.values(groupRows).forEach(tr => { if (tr.parentNode === tbody) tbody.removeChild(tr); });
    const mode = MODES[state.preset];
    let ordered;
    if (mode && mode.sortFn) {
      ordered = [...candidates].sort(mode.sortFn);
    } else {
      ordered = [...candidates];     // priority(rank) 순 — 이미 sortCandidates로 정렬됨
    }
    ordered.forEach(c => {
      const item = rowsByCode[c.code];
      if (item) { tbody.appendChild(item.row); tbody.appendChild(item.detail); }
    });
  }

  // ── 정렬
  function applySort(key) {
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      const numKeys = new Set(['rank', 'finalScore', 'valueRatio20', 'closeToMA20', 'closeFromRecentLow20']);
      state.sortDir = (numKeys.has(key) && key !== 'rank') ? 'desc' : 'asc';
    }
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const sorted = [...candidates].sort((a, b) => {
      let va = a[key], vb = b[key];
      if (key === 'historyQuality') { va = HISTORY_RANK[va] || 9; vb = HISTORY_RANK[vb] || 9; }
      else if (key === 'boxQuality') { va = BOX_RANK[va] || 9; vb = BOX_RANK[vb] || 9; }
      else if (key === 'riskLevel') { va = RISK_RANK[va] || 9; vb = RISK_RANK[vb] || 9; }
      if (va == null) va = (typeof vb === 'number') ? -Infinity : '';
      if (vb == null) vb = (typeof va === 'number') ? -Infinity : '';
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    sorted.forEach(c => {
      const item = rowsByCode[c.code];
      if (item) {
        tbody.appendChild(item.row);
        tbody.appendChild(item.detail);
      }
    });
    document.querySelectorAll('thead th').forEach(th => {
      th.querySelectorAll('.arrow').forEach(a => a.remove());
      if (th.dataset.sort === key) {
        const arr = document.createElement('span');
        arr.className = 'arrow';
        arr.textContent = state.sortDir === 'asc' ? '▲' : '▼';
        th.appendChild(arr);
      }
    });
    applyFilters();
  }

  function resetSortToDefault() {
    state.sortKey = null;
    document.querySelectorAll('thead th .arrow').forEach(a => a.remove());
    candidates.forEach(c => {
      const item = rowsByCode[c.code];
      if (item) {
        tbody.appendChild(item.row);
        tbody.appendChild(item.detail);
      }
    });
    applyFilters();
  }

  // ── 이벤트
  document.querySelectorAll('thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => applySort(th.dataset.sort));
  });

  // 큰 모드 카드 + 작은 빠른 버튼 모두 처리
  function activatePreset(preset) {
    document.querySelectorAll('.mode-card-btn[data-preset], .qf-btn[data-preset]').forEach(b => b.classList.remove('active'));
    const cardBtn = document.querySelector('.mode-card-btn[data-preset="' + preset + '"]');
    const qfBtn = document.querySelector('.qf-btn[data-preset="' + preset + '"]');
    if (cardBtn) cardBtn.classList.add('active');
    if (qfBtn) qfBtn.classList.add('active');
    state.preset = preset;
    applyFilters();
  }
  document.querySelectorAll('.mode-card-btn[data-preset], .qf-btn[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => activatePreset(btn.dataset.preset));
  });

  // 각 모드 카드의 count 배지 미리 계산해서 표시
  function updateModeCounts() {
    ['STABLE', 'REACTION', 'HIGH_VOL_ONLY', 'ALL'].forEach(p => {
      const m = MODES[p]; if (!m) return;
      const n = candidates.filter(c => m.filter(c)).length;
      const badge = document.querySelector('[data-count-for="' + p + '"]');
      if (badge) badge.textContent = n + '건';
    });
  }
  updateModeCounts();

  document.querySelectorAll('.btn-f[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tag;
      btn.classList.toggle('active');
      if (state.tags.has(t)) state.tags.delete(t); else state.tags.add(t);
      // 유형 필터 누르면 자동 ALL preset으로
      if (state.preset !== 'ALL') {
        document.querySelectorAll('.qf-btn[data-preset]').forEach(b => b.classList.remove('active'));
        document.querySelector('.qf-btn[data-preset="ALL"]').classList.add('active');
        state.preset = 'ALL';
      }
      applyFilters();
    });
  });
  document.querySelectorAll('.btn-f[data-market]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const v = btn.dataset.market;
      if (state.market.has(v)) state.market.delete(v); else state.market.add(v);
      applyFilters();
    });
  });
  document.querySelectorAll('.btn-f[data-box]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const v = btn.dataset.box;
      if (state.box.has(v)) state.box.delete(v); else state.box.add(v);
      applyFilters();
    });
  });
  document.getElementById('min-final').addEventListener('input', e => {
    const v = e.target.value;
    state.minFinal = (v === '' || v == null) ? null : parseFloat(v);
    applyFilters();
  });
  document.getElementById('q').addEventListener('input', e => {
    state.q = e.target.value.trim();
    applyFilters();
  });
  document.getElementById('reset-adv').addEventListener('click', () => {
    state.tags.clear(); state.market.clear(); state.box.clear();
    state.minFinal = null; state.q = '';
    document.querySelectorAll('.btn-f.active').forEach(b => b.classList.remove('active'));
    document.getElementById('min-final').value = '';
    document.getElementById('q').value = '';
    resetSortToDefault();
  });

  // 고급 필터 토글
  const advBar = document.getElementById('adv-bar');
  const advToggle = document.getElementById('adv-toggle');
  advToggle.addEventListener('click', () => {
    advBar.classList.toggle('open');
    advToggle.textContent = advBar.classList.contains('open') ? '고급 필터 ▴' : '고급 필터 ▾';
  });

  render();
})();
</script>
</body>
</html>
`;

// ─────────────────────── 실행 ───────────────────────

function main() {
  console.log('═'.repeat(72));
  console.log('WRA Watchlist Board v3 (통합 리스트 + 한국어 표시)');
  console.log('═'.repeat(72));

  const source = loadSource();
  const board = buildJson(source);

  if (!fs.existsSync(path.dirname(OUT_JSON))) fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(board, null, 2));
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(board));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  const sumKB = (JSON.stringify(board).length / 1024).toFixed(0);
  const htmlKB = (html.length / 1024).toFixed(0);
  console.log(`\n기준일       : ${board.meta.latestTradingDate}`);
  console.log(`전체 후보     : ${board.meta.totalCandidates}건`);
  console.log(`오늘 우선 확인: ${board.meta.coreVisibleCount}건 (3블록 순차)`);
  console.log(`   ① 먼저 볼 후보   ${board.meta.block1Count}건`);
  console.log(`   ② 힘 붙은 후보   ${board.meta.block2Count}건`);
  console.log(`   ③ 단기 반응 후보 ${board.meta.block3Count}건 (overlay 제외)`);
  console.log(`고변동성     : ${board.meta.highVolatilityTotalCount}건 (단독 ${board.summary.HIGH_VOLATILITY_solo} + overlay ${board.summary.HIGH_VOLATILITY_overlay})`);
  console.log(`차트신뢰 높음: ${board.summary.midfullCount}건 (MID/FULL_HISTORY)`);
  console.log(`UNCLASSIFIED : ${board.summary.unclassifiedCount}건 ${board.summary.unclassifiedCount === 0 ? '✅' : '⚠️'}`);

  // 위험 단계 분포 미리 계산해서 보여주기
  const riskCount = { '낮음': 0, '주의': 0, '높음': 0 };
  board.candidates.forEach(c => { riskCount[c.riskLevel] = (riskCount[c.riskLevel] || 0) + 1; });
  console.log(`\n위험 분포    : 낮음 ${riskCount['낮음']} / 주의 ${riskCount['주의']} / 높음 ${riskCount['높음']}`);

  // 한줄판단 샘플 (각 유형별 최상위 1개)
  console.log('\n한줄판단 샘플:');
  const seenTags = new Set();
  board.candidates.forEach(c => {
    if (seenTags.has(c.watchTagV3_1)) return;
    seenTags.add(c.watchTagV3_1);
    console.log(`   [${c.displayLabel.padEnd(5)}] ${c.name.padEnd(14)} ${c.code} — ${c.summaryText}`);
    console.log(`           └ ${c.metricSummary}`);
  });

  console.log(`\n✅ JSON 저장: ${OUT_JSON} (${sumKB}KB)`);
  console.log(`✅ HTML 저장: ${OUT_HTML} (${htmlKB}KB)`);
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main, buildJson, sortCandidates, buildBlockList, HTML_TEMPLATE };
