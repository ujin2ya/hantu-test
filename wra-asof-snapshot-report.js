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

const DISPLAY_LABEL = {
  CLEAN_VALUE_SETUP: '먼저 볼 후보',
  VALUE_SURGE_CONFIRM: '힘 붙은 후보',
  BREAKOUT_MOMENTUM: '단기 반응 후보',
  VALUE_LOOSE: '보조 후보',
  HIGH_VOLATILITY: '고위험 변동성',
  WATCH_ONLY: '관찰만',
  LOW_SIGNAL: '약한 신호',
};
const SUMMARY_TEXT = {
  CLEAN_VALUE_SETUP: '거래대금 유입, 과열 낮음',
  VALUE_SURGE_CONFIRM: '거래대금+상승 확인, 눌림/유지 확인',
  BREAKOUT_MOMENTUM: '돌파 시도, 추격 주의',
  VALUE_LOOSE: '거래대금은 있으나 조건 보통',
  HIGH_VOLATILITY: '크게 튈 수 있지만 흔들림 큼',
  WATCH_ONLY: '아직은 관찰 단계',
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

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  const outHtmlPath = path.join(REPORTS_DIR, `wra-asof-${CONFIG.ASOF_DATE}-snapshot-result.html`);
  fs.writeFileSync(outHtmlPath, html, 'utf-8');

  console.log(`\n✅ JSON: ${outJsonPath} (${(JSON.stringify(out).length/1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${outHtmlPath} (${(html.length/1024).toFixed(0)}KB)`);
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>WRA 후보 스냅샷 보고서</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 18px 28px 80px; max-width: 1640px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0;
  font-size: 13px;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.background-box {
  background: #1e293b; border-left: 4px solid #38bdf8;
  padding: 12px 16px; border-radius: 6px; margin-bottom: 14px;
  font-size: 13px; color: #cbd5e1; line-height: 1.7;
}
.background-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }
.cutoff-banner {
  background: #1e3a8a; border: 1px solid #3b82f6;
  padding: 10px 14px; border-radius: 6px; margin-bottom: 14px;
  font-size: 12px; color: #dbeafe; line-height: 1.6;
}
.cutoff-banner strong { color: #93c5fd; }

/* big tiles */
.big-summary { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.big-tile { flex: 1; min-width: 150px; background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; }
.big-tile .label { font-size: 12px; color: #94a3b8; margin-bottom: 4px; }
.big-tile .value { font-size: 26px; font-weight: 700; color: #f1f5f9; line-height: 1.1; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; }
.big-tile.primary { background: linear-gradient(135deg, #0c4a6e 0%, #1e293b 100%); border-color: #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }
.big-tile.warning { border-color: #b91c1c; }
.big-tile.warning .value { color: #fca5a5; }
.big-tile.success .value { color: #6ee7b7; }
.big-tile.muted .value { color: #cbd5e1; }

/* table */
.tbl-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; margin-top: 14px; }
table.list { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
table.list thead th {
  background: #0f172a; color: #94a3b8; font-weight: 600; text-align: left;
  padding: 11px 14px; border-bottom: 1px solid #334155; white-space: nowrap;
  position: sticky; top: 0; z-index: 5; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px;
  cursor: pointer; user-select: none;
}
table.list thead th:hover { color: #cbd5e1; }
table.list thead th.numeric { text-align: right; }
table.list thead th .arrow { color: #38bdf8; margin-left: 3px; }
table.list tbody tr.row { border-bottom: 1px solid #1e293b; cursor: pointer; transition: background 0.1s; }
table.list tbody tr.row:hover { background: #273549; }
table.list tbody tr.row.expanded { background: #1e3a5f; }
table.list tbody tr.row td { padding: 10px 14px; vertical-align: middle; white-space: nowrap; line-height: 1.35; }
table.list tbody tr.row td.numeric { text-align: right; }
table.list tbody tr.row td.col-rank { color: #64748b; font-size: 12px; width: 38px; padding-left: 14px; padding-right: 8px; }
table.list tbody tr.row td.col-name {
  font-weight: 600; color: #f1f5f9; min-width: 140px; max-width: 200px;
  padding-right: 8px;
}
/* 코드/시장/시총을 종목명 아래 한 줄로 — 가로 길이 절약 */
table.list tbody tr.row td.col-name .meta {
  display: block; font-size: 10.5px; color: #64748b; font-weight: 400;
  margin-left: 0; margin-top: 3px; letter-spacing: 0.2px;
}
table.list tbody tr.row td.col-summary {
  color: #cbd5e1; max-width: 220px; padding-right: 16px;
  overflow: hidden; text-overflow: ellipsis;
}
/* 우측 컬럼들 폭 가이드 (몰림 방지) */
table.list tbody tr.row td.col-next { min-width: 140px; padding: 9px 16px 9px 14px; }
.next-cell { display: flex; flex-direction: column; gap: 3px; line-height: 1.25; align-items: flex-end; }
.next-row { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; }
.next-tag { color: #94a3b8; font-size: 10.5px; font-weight: 700; min-width: 13px; }
.next-tag.tag-high { color: #fbbf24; }
.next-num { color: #cbd5e1; font-variant-numeric: tabular-nums; min-width: 48px; text-align: right; }
.next-pct { font-weight: 600; min-width: 60px; text-align: right; font-variant-numeric: tabular-nums; }
.next-date { font-size: 10px; color: #64748b; margin-top: 2px; letter-spacing: 0.5px; }

/* group separator */
table.list tbody tr.group-row { background: #15243a; }
table.list tbody tr.group-row td {
  padding: 8px 12px; border-top: 1px solid #1e3a5f; border-bottom: 1px solid #1e3a5f;
  font-size: 12px; color: #cbd5e1; font-weight: 600; white-space: nowrap;
}
table.list tbody tr.group-row .gnum { color: #64748b; margin-right: 6px; font-weight: 400; }
table.list tbody tr.group-row .gtitle { color: #f1f5f9; }
table.list tbody tr.group-row .gcount { color: #94a3b8; font-weight: 400; margin-left: 6px; font-size: 11px; }
table.list tbody tr.group-row .gdesc { color: #94a3b8; font-weight: 400; margin-left: 14px; font-size: 12px; }

/* zebra */
table.list tbody tr.row:nth-child(4n+1) { background: #1c2942; }
table.list tbody tr.row:nth-child(4n+1):hover { background: #273549; }
table.list tbody tr.row.expanded, table.list tbody tr.row.expanded:nth-child(4n+1) { background: #1e3a5f; }

/* type chip */
.type-chip { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.type-chip.t-CLEAN_VALUE_SETUP { background: #047857; color: #d1fae5; }
.type-chip.t-VALUE_SURGE_CONFIRM { background: #0e7490; color: #cffafe; }
.type-chip.t-BREAKOUT_MOMENTUM { background: #6d28d9; color: #ede9fe; }
.type-chip.t-VALUE_LOOSE { background: #92400e; color: #fef3c7; }
.type-chip.t-HIGH_VOLATILITY { background: #991b1b; color: #fee2e2; }
.type-chip.t-WATCH_ONLY { background: #475569; color: #e2e8f0; }
.type-chip.t-LOW_SIGNAL { background: #1e293b; color: #94a3b8; border: 1px solid #475569; }
.overlay-pill { display: inline-block; margin-left: 5px; padding: 2px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; background: #b91c1c; color: #fee2e2; }

.risk-pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.risk-pill.r-low { background: #14532d; color: #86efac; }
.risk-pill.r-mid { background: #713f12; color: #fde047; }
.risk-pill.r-high { background: #7f1d1d; color: #fca5a5; }
.chart-pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.chart-pill.c-good { background: #14532d; color: #86efac; }
.chart-pill.c-mid { background: #1e3a8a; color: #93c5fd; }
.chart-pill.c-short { background: #334155; color: #94a3b8; }

.tcell-num.pos { color: #6ee7b7; }
.tcell-num.neg { color: #fca5a5; }
.tcell-num.warm { color: #fde047; }
.tcell-num.hot { color: #fca5a5; font-weight: 600; }
.score-cell { font-weight: 700; color: #fbbf24; }

/* expanded detail */
table.list tbody tr.detail { display: none; background: #0c1729; }
table.list tbody tr.detail.show { display: table-row; }
table.list tbody tr.detail td { padding: 14px 18px; border-bottom: 1px solid #1e3a5f; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px 24px; font-size: 12px; }
.detail-block h4 { margin: 0 0 6px; font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.detail-block p { margin: 0 0 4px; color: #cbd5e1; line-height: 1.6; }
.detail-block code { background: #1e293b; padding: 1px 5px; border-radius: 3px; color: #67e8f9; font-size: 11px; }
.detail-block .interp { color: #fde68a; font-style: italic; }
.detail-block .warn { color: #fca5a5; }
.detail-block .label-chip { display: inline-block; padding: 1px 7px; margin: 1px 3px 1px 0; background: #1e293b; color: #93c5fd; border: 1px solid #1e40af; border-radius: 999px; font-size: 10px; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

.section-tabs { display: flex; gap: 6px; margin: 18px 0 10px; }
.section-tab { padding: 7px 14px; background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 7px; cursor: pointer; font-size: 13px; font-weight: 500; }
.section-tab.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }
.section-tab:hover { color: #f1f5f9; }

@media (max-width: 900px) {
  body { padding: 12px; }
  .detail-grid { grid-template-columns: 1fr; }
  table.list { font-size: 12px; }
  .col-summary { display: none; }
}
</style>
</head>
<body>

<h1 id="page-title">WRA 후보 스냅샷 보고서</h1>
<div class="subtitle" id="subtitle">로딩 중…</div>

<div class="background-box" id="background-box">
</div>

<div class="cutoff-banner" id="cutoff-banner">
</div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 과거 특정 시점 (asOfDate)에서 WRA가 잡았을 후보를 복원해 보여줍니다. 실제 매수 판단은 차트·뉴스·시장 상황을 별도로 확인하세요.
</div>

<div class="big-summary" id="big-summary"></div>

<div class="section-tabs">
  <button class="section-tab active" data-tab="core">⭐ 핵심 후보 (3블록)</button>
  <button class="section-tab" data-tab="all">전체 후보</button>
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
        <th class="numeric" data-sort="nextDayReturn">다음일 (참고)</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<footer class="foot">
  <strong>이 보고서는 매수 신호가 아닙니다.</strong> asOfDate 시점에 WRA가 사전에 포착했을 후보 목록을 복원한 스냅샷입니다.
  asOfDate 이후 데이터는 후보 선정·점수·라벨에 반영되지 않았습니다.
  <br>
  <small>
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
  const summaryText = data.summaryText || {};
  const candidates = data.candidates || [];
  const blockDef = data.blockDef || [];

  const HISTORY_RANK = { FULL_HISTORY: 1, MID_HISTORY: 2, SHORT_HISTORY: 3, INSUFFICIENT: 4 };
  const BOX_RANK = { BOX_STABLE: 1, BOX_VOLATILE: 2, BOX_UNSTABLE: 3 };
  const RISK_RANK = { '낮음': 1, '주의': 2, '높음': 3 };

  function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d); }
  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtMc(v) { if (!v) return '-'; const e = v / 100_000_000; if (e >= 10000) return (e/10000).toFixed(1) + '조'; return Math.round(e) + '억'; }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

  // 제목/설명 채우기
  document.getElementById('page-title').textContent = meta.title || 'WRA 후보 스냅샷 보고서';
  document.getElementById('subtitle').innerHTML =
    'asOfDate <strong style="color:#cbd5e1;">' + fmtDate(meta.asOfDate) + '</strong> · 처리 ' + summary.totalStocksProcessed + '종목 · 후보 ' + summary.totalCandidates + '건 · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  document.getElementById('background-box').innerHTML =
    '<strong>📌 사용자 요청 배경:</strong> ' + escapeHtml(meta.requestBackground || '') +
    '<br><br><strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose || '');
  document.getElementById('cutoff-banner').innerHTML =
    '<strong>🔒 데이터 cutoff:</strong> ' + escapeHtml(meta.dataCutoffRule || '') +
    '<br><strong>5/4 데이터 사용 여부:</strong> ' + escapeHtml(meta.compareNextNote || '');

  // big tiles
  const bigTiles = [
    { label: '핵심 후보', value: meta.coreVisibleCount || (summary.block1Count + summary.block2Count + summary.block3Count), sub: '먼저 볼 ' + summary.block1Count + ' · 힘 붙은 ' + summary.block2Count + ' · 단기 반응 ' + summary.block3Count, cls: 'primary' },
    { label: '전체 후보', value: summary.totalCandidates, sub: '처리 종목 ' + summary.totalStocksProcessed + '개', cls: 'muted' },
    { label: '고위험 변동성', value: summary.highVolatilityTotalCount, sub: '단독 ' + summary.highVolatilitySoloCount + ' + overlay ' + summary.highVolatilityOverlayCount, cls: 'warning' },
    { label: '차트신뢰 높음', value: summary.midfullCount, sub: 'MID/FULL_HISTORY (120일+)', cls: 'success' },
    { label: '기준일', value: fmtDate(meta.asOfDate), sub: 'UNCLASSIFIED ' + summary.unclassifiedCount + ' ' + (summary.unclassifiedCount === 0 ? '✅' : '⚠️'), cls: 'muted' },
  ];
  const bigRow = document.getElementById('big-summary');
  bigTiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + escapeHtml(t.label) + '</div>' +
      '<div class="value">' + escapeHtml(String(t.value)) + '</div>' +
      '<div class="sub">' + escapeHtml(t.sub) + '</div>';
    bigRow.appendChild(el);
  });

  // 행 빌드
  const tbody = document.getElementById('list-body');
  const rowsByCode = {};
  function riskClass(l) { return l === '높음' ? 'r-high' : (l === '주의' ? 'r-mid' : 'r-low'); }
  function chartClass(l) { return l === '좋음' ? 'c-good' : (l === '중간' ? 'c-mid' : 'c-short'); }
  function ma20Class(v) { if (v == null || !isFinite(v)) return ''; if (v >= 20) return 'hot'; if (v >= 12) return 'warm'; return v > 0 ? 'pos' : (v < 0 ? 'neg' : ''); }
  function lowClass(v) { if (v == null || !isFinite(v)) return ''; if (v >= 40) return 'hot'; if (v >= 25) return 'warm'; return v > 0 ? 'pos' : (v < 0 ? 'neg' : ''); }

  // 다음 거래일 셀 (asOfDate+1 종가/고가 + 등락률)
  function nextDayCellHtml(nd) {
    if (!nd || nd.nextClose == null) {
      return '<span style="color:#64748b;">—</span>';
    }
    function fmtRet(r) {
      if (r == null || !isFinite(r)) return '-';
      return (r >= 0 ? '+' : '') + Number(r).toFixed(2) + '%';
    }
    function clsRet(r) {
      if (r == null || !isFinite(r)) return '';
      return r > 0 ? 'pos' : (r < 0 ? 'neg' : '');
    }
    const closeStr = Number(nd.nextClose).toLocaleString();
    const highStr = nd.nextHigh != null ? Number(nd.nextHigh).toLocaleString() : '-';
    const dateStr = nd.nextDate ? (nd.nextDate.slice(4,6) + '/' + nd.nextDate.slice(6,8)) : '';
    return '<div class="next-cell">' +
      '<div class="next-row"><span class="next-tag">종</span>' +
        '<span class="next-num">' + closeStr + '</span>' +
        '<span class="next-pct tcell-num ' + clsRet(nd.nextDayReturn) + '">' + fmtRet(nd.nextDayReturn) + '</span>' +
      '</div>' +
      '<div class="next-row"><span class="next-tag tag-high">고</span>' +
        '<span class="next-num">' + highStr + '</span>' +
        '<span class="next-pct tcell-num ' + clsRet(nd.nextHighReturn) + '">' + fmtRet(nd.nextHighReturn) + '</span>' +
      '</div>' +
      (dateStr ? '<div class="next-date">' + dateStr + '</div>' : '') +
      '</div>';
  }

  function buildRow(c) {
    const tr = document.createElement('tr');
    tr.className = 'row tag-' + c.watchTagV3_1 + (c.riskOverlay ? ' has-overlay' : '');
    tr.dataset.code = c.code; tr.dataset.tag = c.watchTagV3_1;
    const overlayPill = c.riskOverlay ? '<span class="overlay-pill">고위험</span>' : '';
    tr.innerHTML =
      '<td class="col-rank">' + c.rank + '</td>' +
      '<td class="col-name">' + escapeHtml(c.name) + '<span class="meta">' + c.code + ' · ' + (c.market || '-') + ' · ' + fmtMc(c.marketCap) + '</span></td>' +
      '<td><span class="type-chip t-' + c.watchTagV3_1 + '">' + (c.displayLabel || displayLabel[c.watchTagV3_1] || c.watchTagV3_1) + '</span>' + overlayPill + '</td>' +
      '<td class="col-summary">' + escapeHtml(c.summaryText || '') + '</td>' +
      '<td class="numeric score-cell">' + fmtNum(c.finalScore) + '</td>' +
      '<td class="numeric">' + fmtNum(c.valueRatio20, 1) + '배</td>' +
      '<td class="numeric tcell-num ' + ma20Class(c.closeToMA20) + '">MA20 ' + fmtPct(c.closeToMA20, 1) + '</td>' +
      '<td class="numeric tcell-num ' + lowClass(c.closeFromRecentLow20) + '">' + fmtPct(c.closeFromRecentLow20, 1) + '</td>' +
      '<td><span class="chart-pill ' + chartClass(c.chartLevel) + '">' + c.chartLevel + '</span></td>' +
      '<td><span class="risk-pill ' + riskClass(c.riskLevel) + '">' + c.riskLevel + '</span></td>' +
      '<td class="numeric col-next">' + nextDayCellHtml(c.nextDay) + '</td>';

    const trd = document.createElement('tr');
    trd.className = 'detail';
    trd.dataset.code = c.code;
    const labelChips = (c.labels || []).map(l => '<span class="label-chip">' + escapeHtml(l) + '</span>').join('');
    const warnsHtml = (c.warnings && c.warnings.length)
      ? c.warnings.map(w => '<p class="warn">⚠ ' + escapeHtml(w) + '</p>').join('')
      : '<p style="color:#64748b;">없음</p>';
    const nextDayHtml = c.nextDay
      ? ('<div class="detail-block" style="grid-column: 1 / -1;">' +
          '<h4>다음 거래일 비교 (점수 미반영, 참고용)</h4>' +
          '<p>다음 거래일: <code>' + (c.nextDay.nextDate || '-') + '</code></p>' +
          '<p>OHLC: 시 <code>' + fmtNum(c.nextDay.nextOpen, 0) + '</code> · 고 <code>' + fmtNum(c.nextDay.nextHigh, 0) + '</code> · 저 <code>' + fmtNum(c.nextDay.nextLow, 0) + '</code> · 종 <code>' + fmtNum(c.nextDay.nextClose, 0) + '</code></p>' +
          '<p>다음거래일 등락률: <code>' + fmtPct(c.nextDay.nextDayReturn, 2) + '</code></p>' +
          '</div>')
      : '';
    trd.innerHTML =
      '<td colspan="11">' +
        '<div class="detail-grid">' +
          '<div class="detail-block">' +
            '<h4>분류 · 라벨</h4>' +
            '<p>유형 (화면): <code>' + (c.displayLabel || c.watchTagV3_1) + '</code></p>' +
            '<p>내부 라벨: <code>' + c.watchTagV3_1 + '</code>' + (c.riskOverlay ? ' + <code style="color:#fca5a5;">' + c.riskOverlay + '</code>' : '') + '</p>' +
            '<p class="interp">' + escapeHtml(c.interpretation || '') + '</p>' +
            '<p>BMS 라벨: ' + (labelChips || '<span style="color:#64748b;">없음</span>') + '</p>' +
            '<p style="color:#64748b; margin-top:4px;">' + escapeHtml(c.metricSummary || '') + '</p>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>점수 분해</h4>' +
            '<p>setupScore <code>' + fmtNum(c.setupScore) + '</code></p>' +
            '<p>momentumScore <code>' + fmtNum(c.momentumScore) + '</code></p>' +
            '<p>historyScore <code>' + fmtNum(c.historyScore, 0) + '</code></p>' +
            '<p>riskPenalty <code style="color:#fca5a5;">−' + fmtNum(c.riskPenalty) + '</code></p>' +
            '<p>finalScore <code style="color:#fbbf24; font-weight:700;">' + fmtNum(c.finalScore) + '</code> (= setup + mom + hist − risk)</p>' +
            '<p style="color:#64748b; margin-top:4px;">riskScore=' + (c.riskScore || 0) + '</p>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>지표 상세</h4>' +
            '<p>거래대금 <code>' + fmtNum(c.valueRatio20, 2) + '×</code> · 거래량 <code>' + fmtNum(c.volumeRatio20, 2) + '×</code></p>' +
            '<p>val/MC <code>' + (c.valueToMarketCap != null ? fmtNum(c.valueToMarketCap * 100, 2) + '%' : '-') + '</code></p>' +
            '<p>당일 종가 위치 <code>' + fmtNum(c.closeLocation, 2) + '</code> (0=하단, 1=상단)</p>' +
            '<p>52주 고점 대비 <code>' + fmtPct(c.closeFrom52WeekHigh) + '</code> · 당일 등락률 <code>' + fmtPct(c.dayReturn) + '</code></p>' +
            '<p>박스 range <code>' + fmtNum(c.boxRangePct, 1) + '%</code> · 기간 <code>' + (c.dynamicBoxDuration || '-') + 'd' + (c.boxFallback ? ' (fallback)' : '') + '</code></p>' +
          '</div>' +
          '<div class="detail-block" style="grid-column: 1 / -1;">' +
            '<h4>경고 (warnings)</h4>' + warnsHtml +
          '</div>' +
          nextDayHtml +
        '</div>' +
      '</td>';

    return [tr, trd];
  }

  // 그룹 행
  const groupRows = {};
  function buildGroupRows() {
    const counts = { BLOCK1: summary.block1Count || 0, BLOCK2: summary.block2Count || 0, BLOCK3: summary.block3Count || 0 };
    const numerals = { BLOCK1: '①', BLOCK2: '②', BLOCK3: '③' };
    blockDef.forEach(b => {
      const tr = document.createElement('tr');
      tr.className = 'group-row';
      tr.dataset.block = b.id;
      tr.innerHTML =
        '<td colspan="11">' +
          '<span class="gnum">' + numerals[b.id] + '</span>' +
          '<span class="gtitle">' + escapeHtml(b.title) + '</span>' +
          '<span class="gcount">(' + counts[b.id] + '건)</span>' +
          '<span class="gdesc">' + escapeHtml(b.desc) + '</span>' +
        '</td>';
      groupRows[b.id] = tr;
    });
  }

  // 초기 렌더 (모든 행 생성)
  buildGroupRows();
  candidates.forEach(c => {
    const [tr, trd] = buildRow(c);
    rowsByCode[c.code] = { row: tr, detail: trd, data: c };
    tr.addEventListener('click', () => {
      tr.classList.toggle('expanded');
      trd.classList.toggle('show');
    });
  });

  // 탭 전환
  let activeTab = 'core';
  function reorder() {
    tbody.innerHTML = '';
    Object.values(groupRows).forEach(tr => { if (tr.parentNode === tbody) tbody.removeChild(tr); });
    if (activeTab === 'core') {
      const core = candidates.filter(c => c.coreFlag).sort((a, b) => (a.coreOrder || 0) - (b.coreOrder || 0));
      let lastBlock = null;
      core.forEach(c => {
        if (c.block !== lastBlock) {
          const gr = groupRows[c.block];
          if (gr) tbody.appendChild(gr);
          lastBlock = c.block;
        }
        const item = rowsByCode[c.code];
        if (item) { tbody.appendChild(item.row); tbody.appendChild(item.detail); }
      });
    } else {
      candidates.forEach(c => {
        const item = rowsByCode[c.code];
        if (item) { tbody.appendChild(item.row); tbody.appendChild(item.detail); }
      });
    }
    // 행 번호 재계산
    let n = 1;
    Array.from(tbody.querySelectorAll('tr.row')).forEach(tr => {
      const c = tr.querySelector('.col-rank');
      if (c) c.textContent = n++;
    });
  }
  document.querySelectorAll('.section-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.section-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      reorder();
    });
  });

  reorder();
})();
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main, measureAsOf };
