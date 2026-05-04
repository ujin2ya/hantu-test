#!/usr/bin/env node
/**
 * WRA As-Of Snapshot Report
 *
 * 사용자 요청 배경:
 *   2026-05-04 기준 WRA 보드를 만든 뒤, 직전 거래일인 2026-04-30 장 마감 시점에는
 *   WRA가 어떤 종목을 후보로 잡고 있었는지 확인하기 위한 스냅샷 보고서.
 *
 * 데이터 누수 방지:
 *   - asOfDate (기본 20260430) 및 그 이전 데이터만 후보 생성에 사용
 *   - asOfDate 이후 데이터(예: 2026-05-04 OHLCV)는 후보 선정/점수/라벨에 절대 반영하지 않음
 *   - --compare-next 옵션을 명시하지 않는 한 5/4 데이터는 읽지도 않음
 *
 * 핵심 구현:
 *   각 종목 차트에서 date <= asOfDate인 행만 slice → 그 슬라이스의 마지막 행이
 *   정확히 asOfDate인 경우에만 처리 (휴장으로 누락된 종목은 skip)
 *
 * 사용 라벨/분류: WRA v3.1과 동일 (UNCLASSIFIED 0건 정의 사용)
 *   화면 표시명:
 *     CLEAN_VALUE_SETUP    → 먼저 볼 후보
 *     VALUE_SURGE_CONFIRM  → 힘 붙은 후보
 *     BREAKOUT_MOMENTUM    → 단기 반응 후보
 *     VALUE_LOOSE          → 보조 후보
 *     HIGH_VOLATILITY      → 고위험 변동성
 *     WATCH_ONLY           → 관찰만
 *     LOW_SIGNAL           → 약한 신호
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json
 *
 * 출력:
 *   - reports/wra-asof-{asOfDate}-snapshot-result.json
 *   - reports/wra-asof-{asOfDate}-snapshot-result.html
 *
 * 실행:
 *   node wra-asof-snapshot-report.js
 *   node wra-asof-snapshot-report.js --date=20260430
 *   node wra-asof-snapshot-report.js --date=20260430 --compare-next   (5/4 비교 데이터 별도 섹션, 점수 미반영)
 */

const fs = require('fs');
const path = require('path');
const wra = require('./wra-winner-reverse-audit');
const v2 = require('./wra-current-similarity-report-v2');
const v3_1 = require('./wra-current-similarity-report-v3-1');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  });
  return out;
})();

const CONFIG = {
  ASOF_DATE: String(args['date'] || '20260430'),
  MIN_MARKET_CAP: parseInt(args['min-mc'] || '300') * 100_000_000,
  MIN_HISTORY: 60,
  // 다음 거래일 OHLCV는 기본 수집 (점수/라벨에는 절대 미반영, 별도 표시용).
  // --no-compare-next로 끌 수 있음.
  COMPARE_NEXT: args['no-compare-next'] !== true,
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcluded(name) { return name && EXCLUDE_KEYWORDS.some(k => name.includes(k)); }

// ─────────────────────── v3.1 동등 헬퍼 (export 안 된 부분 복사) ───────────────────────

function historyQualityFn(chartLen) {
  if (chartLen >= 250) return 'FULL_HISTORY';
  if (chartLen >= 120) return 'MID_HISTORY';
  if (chartLen >= 60) return 'SHORT_HISTORY';
  return 'INSUFFICIENT';
}
function boxQualityFn(m) {
  const fb = m?.boxFallback === true;
  const range = m?.boxRangePct || 0;
  if (!fb && range <= 25) return 'BOX_STABLE';
  if (fb && range <= 40) return 'BOX_VOLATILE';
  if (fb && range > 40) return 'BOX_UNSTABLE';
  return range <= 40 ? 'BOX_VOLATILE' : 'BOX_UNSTABLE';
}

// ─────────────────────── 측정 (asOfDate 기준) ───────────────────────

// 차트에서 asOfDate <= date인 마지막 행이 정확히 asOfDate인 경우에만 측정.
// 휴장으로 그 날짜가 없는 종목은 null 반환 → skip.
function measureAsOf(rows, marketCap, asOfDate) {
  // asOfDate 위치 탐색 (역방향)
  let asOfIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === asOfDate) { asOfIdx = i; break; }
    if (rows[i].date < asOfDate) break;
  }
  if (asOfIdx < 0) return null;

  // asOfDate까지만 slice (그 이후 데이터 일절 미사용)
  const sliced = rows.slice(0, asOfIdx + 1);
  if (sliced.length < CONFIG.MIN_HISTORY) return null;

  const indi = wra.precomputeIndicators(sliced);
  const idx = sliced.length - 1;
  const today = sliced[idx];
  const prev = sliced[idx - 1];
  if (!today || !prev) return null;

  const measurements = wra.measureT0(sliced, indi, idx, marketCap, idx);
  if (!measurements) return null;
  const t0Detail = wra.analyzeT0(sliced, indi, idx, marketCap);
  if (!t0Detail) return null;
  const prep = wra.analyzePreparation(sliced, indi, idx, marketCap);

  return {
    idx, date: today.date, close: today.close, prevClose: prev.close,
    dayReturn: t0Detail.dayReturn,
    valueRatio20: measurements.valueRatio20,
    volumeRatio20: measurements.volumeRatio20,
    valueToMarketCap: measurements.valueToMarketCap,
    closeLocation: measurements.closeLocation,
    closeToMA5: measurements.closeToMA5,
    closeToMA20: measurements.closeToMA20,
    closeToMA60: measurements.closeToMA60,
    closeToMA120: measurements.closeToMA120,
    closeFrom52WeekHigh: measurements.closeFrom52WeekHigh,
    closeFromRecentLow20: measurements.closeFromRecentLow20,
    closeFromRecentHigh20: measurements.closeFromRecentHigh20,
    boxRangePct: measurements.boxRangePct,
    dynamicBoxDuration: measurements.dynamicBoxDuration,
    boxFallback: measurements.boxFallback,
    overheadRatio: measurements.overheadRatio,
    supportRatio: measurements.supportRatio,
    chartLen: sliced.length,
    prep,
  };
}

// ─────────────────────── 보드용 메타 ───────────────────────

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

// v3.2 라벨 — 보드와 동일
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

const BLOCK_DEF = [
  { id: 'BLOCK1', tag: 'CLEAN_VALUE_SETUP', title: '먼저 볼 후보',
    desc: '조용히 거래대금이 들어온 종목. 과열이 낮아 먼저 차트에 넣고 볼 후보입니다.',
    limit: 20, excludeOverlay: false },
  { id: 'BLOCK2', tag: 'VALUE_SURGE_CONFIRM', title: '힘 붙은 후보',
    desc: '거래대금과 상승이 같이 확인된 종목입니다. 이미 움직였을 수 있으므로 눌림/유지 확인이 필요합니다.',
    limit: 15, excludeOverlay: false },
  { id: 'BLOCK3', tag: 'BREAKOUT_MOMENTUM', title: '단기 반응 후보',
    desc: '단기 돌파 가능성이 있는 종목입니다. 추격보다는 다음 거래일 반응 확인용입니다.',
    limit: 15, excludeOverlay: true },
];

function fmtPct(v, d) {
  if (v == null || !isFinite(v)) return '-';
  return (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%';
}
function fmtX(v, d) {
  if (v == null || !isFinite(v)) return '-';
  return Number(v).toFixed(d == null ? 1 : d) + '배';
}

function computeRiskLevel(c) {
  if (c.riskOverlay === 'HIGH_VOLATILITY') return '높음';
  if ((c.riskScore || 0) >= 20) return '높음';
  if (c.watchTagV3_1 === 'HIGH_VOLATILITY') return '높음';
  const ws = (c.warnings || []).join(' ');
  if (/신고가|52주|MA20|이격|저점|과열|급등/.test(ws)) return '주의';
  if ((c.dayReturn || 0) >= 10) return '주의';
  if ((c.closeFromRecentLow20 || 0) >= 30) return '주의';
  if ((c.closeToMA20 || 0) >= 15) return '주의';
  return '낮음';
}
function computeChartLevel(c) {
  if (c.historyQuality === 'FULL_HISTORY') return '좋음';
  if (c.historyQuality === 'MID_HISTORY') return '중간';
  return '짧음';
}
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
  if ((c.dayReturn || 0) >= 15 || (c.closeToMA20 || 0) >= 20) parts.push('과열 주의');
  else if ((c.closeFromRecentLow20 || 0) >= 40) parts.push('과열 주의');
  else parts.push('박스 ' + computeBoxLevel(c));
  return parts.join(' · ');
}

function sortAll(list) {
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

function buildCoreList(sorted) {
  sorted.forEach(c => { c.coreFlag = false; c.block = null; c.coreOrder = -1; });
  const result = {};
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
    result[b.id] = pool.length;
  });
  return { block1Cnt: result.BLOCK1 || 0, block2Cnt: result.BLOCK2 || 0, block3Cnt: result.BLOCK3 || 0, total: order };
}

// ─────────────────────── 5/4 비교 옵션 ───────────────────────

function readNextDayValuesIfRequested(rows, asOfIdx, asOfDate) {
  if (!CONFIG.COMPARE_NEXT) return null;
  // asOfDate 다음 거래일 데이터를 별도로 추출 (점수/라벨에 영향 없음)
  if (asOfIdx < 0 || asOfIdx >= rows.length - 1) return null;
  const next = rows[asOfIdx + 1];
  if (!next || !next.date || next.date <= asOfDate) return null;
  const cur = rows[asOfIdx];
  const dr = (cur.close > 0) ? ((next.close - cur.close) / cur.close * 100) : null;
  // 고가 등락률 (asOfDate 종가 대비 다음 거래일 장중 고가)
  const hr = (cur.close > 0 && next.high != null) ? ((next.high - cur.close) / cur.close * 100) : null;
  return {
    prevClose: cur.close,                          // asOfDate 종가 (4/30)
    nextDate: next.date,
    nextOpen: next.open,
    nextHigh: next.high,
    nextLow: next.low,
    nextClose: next.close,
    nextVolume: next.volume,
    nextDayReturn: dr != null ? Math.round(dr * 100) / 100 : null,
    nextHighReturn: hr != null ? Math.round(hr * 100) / 100 : null,
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('WRA As-Of Snapshot Report');
  console.log(`기준일 (asOfDate): ${CONFIG.ASOF_DATE}`);
  if (CONFIG.COMPARE_NEXT) console.log('--compare-next: 다음 거래일 OHLCV 별도 수집 (점수 미반영)');
  console.log('═'.repeat(80));

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`\n차트 ${files.length}개 처리 시작...`);

  const candidates = [];
  let processed = 0, skipMeta = 0, skipExcl = 0, skipMc = 0, skipShort = 0, skipNoAsOf = 0, skipNoLabel = 0;
  const startTime = Date.now();

  files.forEach((file, idx) => {
    const code = file.replace('.json', '');
    const meta = stockMap[code];
    if (!meta) { skipMeta++; return; }
    if (isExcluded(meta.name)) { skipExcl++; return; }
    if (meta.isSpecial) { skipExcl++; return; }
    const marketCap = meta.marketValue || 0;
    if (marketCap < CONFIG.MIN_MARKET_CAP) { skipMc++; return; }

    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8')); }
    catch (_) { return; }
    const rows = chart.rows || [];
    if (rows.length < CONFIG.MIN_HISTORY) { skipShort++; return; }

    // asOfDate 위치 확인 (휴장이거나 데이터 없으면 skip)
    let asOfIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].date === CONFIG.ASOF_DATE) { asOfIdx = i; break; }
      if (rows[i].date < CONFIG.ASOF_DATE) break;
    }
    if (asOfIdx < 0) { skipNoAsOf++; return; }

    // 측정 (asOfDate까지만 사용)
    const m = measureAsOf(rows, marketCap, CONFIG.ASOF_DATE);
    if (!m) return;

    const labels = v2.evaluateLabels(m);
    if (labels.length === 0) { skipNoLabel++; processed++; return; }

    const hasBmsValue = labels.includes('BMS_VALUE');
    const v2Scores = v2.computeScores(m, m.prep, hasBmsValue);
    const tagV2 = v2.watchTagV2(labels, v2Scores.riskScore, v2Scores.warnings);
    const hQuality = historyQualityFn(m.chartLen);
    const boxQ = boxQualityFn(m);

    // v3.1 분류·점수 (export된 함수 사용)
    const v3Tag = v3_1.watchTagV3_1(labels, m, v2Scores.riskScore, tagV2, boxQ);
    const v3Scores = v3_1.computeV3Scores(labels, m, v2Scores.riskScore, hQuality, boxQ, tagV2, v3Tag.riskOverlay);

    const interpretation = ({
      VALUE_SURGE_CONFIRM: '거래대금과 상승 확인이 동시에 나온 후보',
      CLEAN_VALUE_SETUP: '위험을 낮춘 거래대금 유입 후보',
      BREAKOUT_MOMENTUM: '다음 거래일 돌파 가능성이 있으나 추격 위험 존재',
      VALUE_LOOSE: '거래대금 유입은 있으나 CLEAN 조건은 부족한 후보',
      HIGH_VOLATILITY: '급등과 급락 가능성이 모두 큰 고변동성 후보',
      WATCH_ONLY: '구조 관찰용, 단기 수익성은 약한 후보',
      LOW_SIGNAL: '신호 약함 (기본 숨김)',
    }[v3Tag.tag] || '') + (v3Tag.riskOverlay ? ' (고위험 변동성 overlay)' : '');

    const candidate = {
      code, name: meta.name, market: meta.market, marketCap,
      asOfDate: CONFIG.ASOF_DATE,
      latestTradingDate: m.date,                 // 측정 기준일 (= asOfDate)
      labels,
      watchTagV2: tagV2,
      watchTagV3_1: v3Tag.tag,
      riskOverlay: v3Tag.riskOverlay,
      historyQuality: hQuality,
      boxQuality: boxQ,
      setupScore: v3Scores.setupScore,
      momentumScore: v3Scores.momentumScore,
      historyScore: v3Scores.historyScore,
      riskPenalty: v3Scores.riskPenalty,
      finalScore: v3Scores.finalScore,
      riskScore: v2Scores.riskScore,
      valueRatio20: m.valueRatio20,
      volumeRatio20: m.volumeRatio20,
      valueToMarketCap: m.valueToMarketCap,
      closeLocation: m.closeLocation,
      closeToMA5: m.closeToMA5,
      closeToMA20: m.closeToMA20,
      closeToMA60: m.closeToMA60,
      closeToMA120: m.closeToMA120,
      closeFromRecentLow20: m.closeFromRecentLow20,
      closeFromRecentHigh20: m.closeFromRecentHigh20,
      closeFrom52WeekHigh: m.closeFrom52WeekHigh,
      dayReturn: m.dayReturn,
      boxRangePct: m.boxRangePct,
      dynamicBoxDuration: m.dynamicBoxDuration,
      boxFallback: m.boxFallback,
      overheadRatio: m.overheadRatio,
      supportRatio: m.supportRatio,
      warnings: v2Scores.warnings || [],
      interpretation,
    };
    // 화면용 메타 (사용자 친화 라벨)
    candidate.displayLabel = DISPLAY_LABEL[candidate.watchTagV3_1] || candidate.watchTagV3_1;
    candidate.summaryText = SUMMARY_TEXT[candidate.watchTagV3_1] || '-';
    candidate.metricSummary = computeMetricSummary(candidate);
    candidate.riskLevel = computeRiskLevel(candidate);
    candidate.chartLevel = computeChartLevel(candidate);
    candidate.boxLevel = computeBoxLevel(candidate);

    // 5/4 비교 옵션 (점수/라벨에 절대 반영 안 함, 별도 필드)
    if (CONFIG.COMPARE_NEXT) {
      candidate.nextDay = readNextDayValuesIfRequested(rows, asOfIdx, CONFIG.ASOF_DATE);
    }

    candidates.push(candidate);
    processed++;

    if ((idx + 1) % 1000 === 0) {
      const e = (Date.now() - startTime) / 1000;
      process.stdout.write(`\r${idx + 1}/${files.length} 후보=${candidates.length} ${e.toFixed(0)}s`);
    }
  });
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n분석 완료: 처리 ${processed}, 후보 ${candidates.length}, ${elapsed.toFixed(0)}초`);
  console.log(`스킵: meta=${skipMeta} excl=${skipExcl} marketCap=${skipMc} short=${skipShort} noAsOf=${skipNoAsOf} noLabel=${skipNoLabel}`);

  // 정렬 + rank + 핵심 마킹
  const sorted = sortAll(candidates);
  const coreCount = buildCoreList(sorted);
  sorted.forEach((c, i) => { c.rank = i + 1; });

  // 카운트
  const watchCount = {};
  const overlayCount = {};
  const labelCount = { BMS_EARLY: 0, BMS_VALUE: 0, BMS_SURGE: 0, BMS_BREAKOUT: 0, valueAndSurge: 0 };
  const histCount = {};
  const boxCount = {};
  sorted.forEach(c => {
    watchCount[c.watchTagV3_1] = (watchCount[c.watchTagV3_1] || 0) + 1;
    if (c.riskOverlay) overlayCount[c.riskOverlay] = (overlayCount[c.riskOverlay] || 0) + 1;
    c.labels.forEach(l => labelCount[l] = (labelCount[l] || 0) + 1);
    if (c.labels.includes('BMS_VALUE') && c.labels.includes('BMS_SURGE')) labelCount.valueAndSurge++;
    histCount[c.historyQuality] = (histCount[c.historyQuality] || 0) + 1;
    boxCount[c.boxQuality] = (boxCount[c.boxQuality] || 0) + 1;
  });
  const midfullCount = (histCount.MID_HISTORY || 0) + (histCount.FULL_HISTORY || 0);
  const unclassifiedCount = watchCount.UNCLASSIFIED || 0;

  const summary = {
    totalStocksProcessed: processed,
    totalCandidates: sorted.length,
    coreVisibleCount: coreCount.total,
    block1Count: coreCount.block1Cnt,
    block2Count: coreCount.block2Cnt,
    block3Count: coreCount.block3Cnt,
    watchCount,
    overlayCount,
    labelCount,
    historyCount: histCount,
    boxCount,
    valueSurgeConfirmCount: watchCount.VALUE_SURGE_CONFIRM || 0,
    cleanValueSetupCount: watchCount.CLEAN_VALUE_SETUP || 0,
    breakoutMomentumCount: watchCount.BREAKOUT_MOMENTUM || 0,
    valueLooseCount: watchCount.VALUE_LOOSE || 0,
    highVolatilitySoloCount: watchCount.HIGH_VOLATILITY || 0,
    highVolatilityOverlayCount: overlayCount.HIGH_VOLATILITY || 0,
    highVolatilityTotalCount: (watchCount.HIGH_VOLATILITY || 0) + (overlayCount.HIGH_VOLATILITY || 0),
    watchOnlyCount: watchCount.WATCH_ONLY || 0,
    lowSignalCount: watchCount.LOW_SIGNAL || 0,
    midfullCount,
    unclassifiedCount,
  };

  // 콘솔 요약
  console.log('\n📊 watchTagV3_1 분포 (asOfDate 기준):');
  Object.entries(watchCount).sort(([a], [b]) => (TAG_RANK[a]||99) - (TAG_RANK[b]||99))
    .forEach(([k, v]) => console.log(`  ${k.padEnd(22)} ${v}건  (${DISPLAY_LABEL[k] || k})`));
  console.log(`  riskOverlay HIGH_VOLATILITY: ${overlayCount.HIGH_VOLATILITY || 0}`);
  console.log(`  history MID/FULL: ${midfullCount}`);
  console.log(`  ✅ UNCLASSIFIED: ${unclassifiedCount}건 ${unclassifiedCount === 0 ? '(목표 달성)' : '(목표 미달)'}`);
  console.log(`\n핵심 후보 (3블록): 먼저 볼 ${coreCount.block1Cnt} / 힘 붙은 ${coreCount.block2Cnt} / 단기 반응 ${coreCount.block3Cnt} = 총 ${coreCount.total}`);

  // top samples
  function topByTag(tag, n) { return sorted.filter(c => c.watchTagV3_1 === tag).slice(0, n); }
  function dump(label, list, n) {
    console.log(`\n🏆 ${label} 상위 ${Math.min(n, list.length)}:`);
    list.slice(0, n).forEach((c, i) => {
      const ov = c.riskOverlay ? `+${c.riskOverlay}` : '';
      console.log(`  ${(i+1).toString().padStart(2)}. ${c.name.padEnd(14)} ${c.code} ${c.market.padEnd(6)} ${c.displayLabel.padEnd(8)} ${ov.padEnd(20)} F${c.finalScore} risk=${c.riskScore}`);
    });
  }
  dump('먼저 볼 후보 (CLEAN_VALUE_SETUP)', topByTag('CLEAN_VALUE_SETUP', 20), 20);
  dump('힘 붙은 후보 (VALUE_SURGE_CONFIRM)', topByTag('VALUE_SURGE_CONFIRM', 15), 15);
  dump('단기 반응 후보 (BREAKOUT_MOMENTUM, overlay 없는)', sorted.filter(c => c.watchTagV3_1 === 'BREAKOUT_MOMENTUM' && !c.riskOverlay), 15);

  // ─────────────────────── 출력 ───────────────────────
  const out = {
    meta: {
      version: 'wra-asof-snapshot-v1',
      generatedAt: new Date().toISOString(),
      asOfDate: CONFIG.ASOF_DATE,
      mode: 'as-of-snapshot',
      title: `${CONFIG.ASOF_DATE.slice(0,4)}-${CONFIG.ASOF_DATE.slice(4,6)}-${CONFIG.ASOF_DATE.slice(6,8)} 장 마감 기준 WRA 후보 스냅샷 보고서`,
      requestBackground: '사용자는 2026-05-04 기준 WRA 보드를 확인한 뒤, 직전 거래일인 2026-04-30 장 마감 시점에는 WRA가 어떤 종목을 후보로 잡고 있었는지 확인하고자 했다. 이 보고서는 2026-04-30까지 누적된 데이터만 사용하여 당시 시점의 후보 목록을 복원한다.',
      dataCutoffRule: `후보 생성에는 ${CONFIG.ASOF_DATE} 및 그 이전 데이터만 사용하며, ${CONFIG.ASOF_DATE} 이후 데이터(예: 20260504)는 사용하지 않는다.`,
      purpose: '현재 기준 결과가 아니라, 과거 특정 시점에서 WRA가 사전에 포착했을 후보를 확인하기 위한 스냅샷 보고서',
      compareNextEnabled: !!CONFIG.COMPARE_NEXT,
      compareNextNote: CONFIG.COMPARE_NEXT
        ? '--compare-next 옵션으로 asOfDate 다음 거래일 OHLCV를 별도 candidate.nextDay 필드로 수집함. 후보 선정/점수/라벨에는 절대 반영하지 않음.'
        : '5/4 데이터는 후보 생성에 사용되지 않았음 (--compare-next 미사용).',
      executionSeconds: Math.round(elapsed),
    },
    config: CONFIG,
    summary,
    blockDef: BLOCK_DEF,
    displayLabel: DISPLAY_LABEL,
    summaryText: SUMMARY_TEXT,
    candidates: sorted,
  };

  const outJsonPath = path.join(REPORTS_DIR, `wra-asof-${CONFIG.ASOF_DATE}-snapshot-result.json`);
  fs.writeFileSync(outJsonPath, JSON.stringify(out, null, 2));

  // HTML — 보드 HTML_TEMPLATE 재사용 + 5/4 종가/고가 컬럼만 추가
  const html = buildAsofHtml(out);
  const outHtmlPath = path.join(REPORTS_DIR, `wra-asof-${CONFIG.ASOF_DATE}-snapshot-result.html`);
  fs.writeFileSync(outHtmlPath, html, 'utf-8');

  console.log(`\n✅ JSON: ${outJsonPath} (${(JSON.stringify(out).length/1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${outHtmlPath} (${(html.length/1024).toFixed(0)}KB)`);
}

// ─────────────────────── HTML — WRA 보드 디자인 재사용 + 5/4 컬럼 추가 ───────────────────────

const board = require('./wra-watchlist-board');

function buildAsofHtml(json) {
  let tpl = board.HTML_TEMPLATE;

  // (1) thead: 위험 컬럼 다음에 5/4 종가/고가 컬럼 2개 추가
  tpl = tpl.replace(
    '<th data-sort="riskLevel">위험</th>',
    '<th data-sort="riskLevel">위험</th>\n        <th class="numeric" data-sort="nextDayReturn">5/4 종가</th>\n        <th class="numeric" data-sort="nextHighReturn">5/4 고가</th>'
  );

  // (2) buildRow: 위험 셀 다음에 5/4 셀 2개 추가
  const oldRowEnd = "'<td><span class=\"risk-pill ' + riskClass(c.riskLevel) + '\">' + c.riskLevel + '</span></td>';";
  const newRowEnd = "'<td><span class=\"risk-pill ' + riskClass(c.riskLevel) + '\">' + c.riskLevel + '</span></td>' + nextCellPair(c.nextDay);";
  tpl = tpl.replace(oldRowEnd, newRowEnd);

  // (3) 헬퍼 함수 nextCellPair를 buildRow 위에 삽입
  const helperFn = "  function nextCellPair(nd) {\n    if (!nd || nd.nextClose == null) return '<td class=\"numeric\" style=\"color:#64748b;\">—</td><td class=\"numeric\" style=\"color:#64748b;\">—</td>';\n    function fmtRet(r) { if (r == null || !isFinite(r)) return '-'; return (r >= 0 ? '+' : '') + Number(r).toFixed(2) + '%'; }\n    function clsRet(r) { if (r == null || !isFinite(r)) return ''; return r > 0 ? 'tcell-num pos' : (r < 0 ? 'tcell-num neg' : ''); }\n    const closeStr = Number(nd.nextClose).toLocaleString();\n    const highStr = nd.nextHigh != null ? Number(nd.nextHigh).toLocaleString() : '-';\n    return '<td class=\"numeric\" style=\"line-height:1.25;padding-right:14px;\">' +\n      '<div style=\"color:#cbd5e1;\">' + closeStr + '</div>' +\n      '<div class=\"' + clsRet(nd.nextDayReturn) + '\" style=\"font-size:11px;font-weight:600;\">' + fmtRet(nd.nextDayReturn) + '</div>' +\n    '</td>' +\n    '<td class=\"numeric\" style=\"line-height:1.25;padding-right:14px;\">' +\n      '<div style=\"color:#cbd5e1;\">' + highStr + '</div>' +\n      '<div class=\"' + clsRet(nd.nextHighReturn) + '\" style=\"font-size:11px;font-weight:600;\">' + fmtRet(nd.nextHighReturn) + '</div>' +\n    '</td>';\n  }\n";
  tpl = tpl.replace('  function buildRow(c) {', helperFn + '\n  function buildRow(c) {');

  // (4) 페이지 제목 변경
  const ymd = json.meta && json.meta.asOfDate ? json.meta.asOfDate : '20260430';
  const ymdFmt = ymd.slice(0,4) + '-' + ymd.slice(4,6) + '-' + ymd.slice(6,8);
  tpl = tpl.replace(
    '<h1 style="font-size:26px;">오늘은 어떤 후보를 볼까요?</h1>',
    '<h1 style="font-size:24px;">' + ymdFmt + ' 후보 + 5/4 결과 참고</h1>'
  );

  // (5) 부제(lead-desc) 변경
  tpl = tpl.replace(
    /WRA는 매수 신호가 아니라[\s\S]*?그룹을 선택하세요\./,
    '<strong style="color:#67e8f9;">' + ymdFmt + ' 장 마감 시점</strong>까지의 데이터로만 만든 후보입니다. 우측에 <strong>2026-05-04 종가/고가</strong>를 참고로 함께 표시합니다 (후보 분류·점수에는 사용 안 됨).'
  );

  // (6) JSON 데이터 주입
  tpl = tpl.replace('__JSON_DATA__', JSON.stringify(json));

  return tpl;
}


if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main, measureAsOf };
