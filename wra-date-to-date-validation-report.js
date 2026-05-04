#!/usr/bin/env node
/**
 * WRA Date-to-Date Validation Report
 *
 * 목적:
 *   2026-04-30 장 마감 시점까지 누적된 모든 과거 데이터를 사용해서 WRA current similarity 후보를 생성하고,
 *   다음 실제 거래일인 2026-05-04의 OHLCV로 후보들의 실제 반응을 검증한다.
 *
 *   2026-05-01 노동절 휴장, 5/2~5/3 주말 → 4/30 다음 실제 거래일 = 5/4
 *
 * 주의:
 *   - 후보 생성에는 2026-04-30 이하의 데이터만 사용 (data leakage 방지)
 *   - 2026-05-04 데이터는 검증 단계에서만 사용
 *   - 매수 신호가 아닌 다음 거래일 반응 검증 보고서
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json
 *
 * 출력:
 *   - reports/wra-20260430-to-20260504-validation-result.json
 *
 * 실행:
 *   node wra-date-to-date-validation-report.js
 */

const fs = require('fs');
const path = require('path');
const wra = require('./wra-winner-reverse-audit');
const v2 = require('./wra-current-similarity-report-v2');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');

const CONFIG = {
  DATA_CUTOFF_DATE: '20260430',
  VALIDATION_DATE: '20260504',
  MIN_HISTORY: 60,
  MIN_MARKET_CAP: 30_000_000_000,
  TOP_N: 30,
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcluded(name) { return name && EXCLUDE_KEYWORDS.some(k => name.includes(k)); }

// ─────────────────────── 헬퍼 ───────────────────────

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d||'-'); }
function avg(arr) { const f = arr.filter(v => v!=null && Number.isFinite(v)); return f.length ? f.reduce((a,b)=>a+b,0)/f.length : null; }
function median(arr) {
  const f = arr.filter(v => v!=null && Number.isFinite(v));
  if (!f.length) return null;
  const s = [...f].sort((a,b) => a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 === 0 ? (s[mid-1]+s[mid])/2 : s[mid];
}
function rate(arr) {
  const f = arr.filter(v => v != null);
  return f.length ? f.filter(v => v).length / f.length : null;
}

// ─────────────────────── 후보 생성 (4/30까지) ───────────────────────

function measureCutoff(cutRows, marketCap) {
  if (cutRows.length < CONFIG.MIN_HISTORY) return null;
  const indi = wra.precomputeIndicators(cutRows);
  const idx = cutRows.length - 1;
  const today = cutRows[idx];
  const prev = cutRows[idx - 1];
  if (!today || !prev) return null;

  const measurements = wra.measureT0(cutRows, indi, idx, marketCap, idx);
  if (!measurements) return null;
  const t0Detail = wra.analyzeT0(cutRows, indi, idx, marketCap);
  if (!t0Detail) return null;
  const prep = wra.analyzePreparation(cutRows, indi, idx, marketCap);

  // 5/4 검증을 위해 valueMedian20을 추출 (4/30 시점까지 사용)
  // measureT0에 ma 등은 있지만 avgVal20은 따로 indi에서.
  const avgVal20 = indi.avgVal20[idx];

  return {
    idx,
    date: today.date,
    open: today.open,
    high: today.high,
    low: today.low,
    close: today.close,
    volume: today.volume,
    value: today.valueApprox,
    prevClose: prev.close,
    avgValue20: avgVal20,
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
    boxUpper: t0Detail.boxUpper,
    boxUpperBreak: t0Detail.boxUpperBreak,
    chartLen: cutRows.length,
    prep,
  };
}

function historyQuality(chartLen) {
  if (chartLen >= 250) return 'FULL_HISTORY';
  if (chartLen >= 120) return 'MID_HISTORY';
  if (chartLen >= 60) return 'SHORT_HISTORY';
  return 'INSUFFICIENT';
}

function boxQuality(m) {
  const fb = m?.boxFallback === true;
  const range = m?.boxRangePct || 0;
  if (!fb && range <= 25) return 'BOX_STABLE';
  if (fb && range <= 40) return 'BOX_VOLATILE';
  if (fb && range > 40) return 'BOX_UNSTABLE';
  return range <= 40 ? 'BOX_VOLATILE' : 'BOX_UNSTABLE';
}

// ─────────────────────── 5/4 검증 ───────────────────────

function validateNextDay(signal, validateRow, avgValue20) {
  if (!validateRow) return { available: false };
  const sClose = signal.close, sHigh = signal.high;
  const v = validateRow;
  const range = v.high - v.low;
  const closeLocation = range > 0 ? (v.close - v.low) / range : 0.5;
  const intradayGiveback = v.high > 0 ? (v.high - v.close) / v.high : 0;
  const validateValueRatio20 = avgValue20 ? (v.valueApprox || 0) / avgValue20 : null;

  const gapReturn = sClose ? (v.open / sClose - 1) * 100 : null;
  const nextDayHighReturn = sClose ? (v.high / sClose - 1) * 100 : null;
  const nextDayLowReturn = sClose ? (v.low / sClose - 1) * 100 : null;
  const nextDayCloseReturn = sClose ? (v.close / sClose - 1) * 100 : null;

  const nextDayHighBreak = v.high > sHigh;
  const nextDayCloseBreak = v.close > sHigh;
  const nextDayClosePositive = v.close > sClose;
  const valueMaintained = validateValueRatio20 != null && validateValueRatio20 >= 1.0;
  const valueExpanded = validateValueRatio20 != null && validateValueRatio20 >= 1.5;

  // 판정
  const HIGH_BREAK_SUCCESS = nextDayHighBreak;
  const CLOSE_POSITIVE_SUCCESS = nextDayClosePositive;
  const STRONG_CONFIRM = nextDayHighBreak && nextDayClosePositive && closeLocation >= 0.6 && valueMaintained;
  const FAILED_CONFIRM = !nextDayHighBreak && !nextDayClosePositive;
  const HIGH_THEN_FADE = nextDayHighBreak && closeLocation < 0.4;
  const GAP_UP_FAIL = (gapReturn || 0) > 0 && (nextDayCloseReturn || 0) < 0;
  const VALUE_EXPAND_BUT_FAIL = valueExpanded && !nextDayClosePositive;

  return {
    available: true,
    validateOpen: v.open,
    validateHigh: v.high,
    validateLow: v.low,
    validateClose: v.close,
    validateVolume: v.volume,
    validateValue: v.valueApprox,
    gapReturn,
    nextDayHighReturn,
    nextDayLowReturn,
    nextDayCloseReturn,
    nextDayHighBreak,
    nextDayCloseBreak,
    nextDayClosePositive,
    validateCloseLocation: closeLocation,
    intradayGiveback,
    validateValueRatio20,
    valueMaintained,
    valueExpanded,
    HIGH_BREAK_SUCCESS,
    CLOSE_POSITIVE_SUCCESS,
    STRONG_CONFIRM,
    FAILED_CONFIRM,
    HIGH_THEN_FADE,
    GAP_UP_FAIL,
    VALUE_EXPAND_BUT_FAIL,
  };
}

// ─────────────────────── 그룹 분류 ───────────────────────

function assignGroups(c) {
  const groups = ['ALL'];
  const tag = c.watchTagV2;
  if (tag === 'CORE_A') {
    groups.push('CORE_A');
    if (c.riskScore === 0) groups.push('CORE_A_RISK0');
    if (c.historyQuality === 'MID_HISTORY' || c.historyQuality === 'FULL_HISTORY') groups.push('CORE_A_MIDFULL');
  }
  if (tag === 'CORE_B') groups.push('CORE_B');
  if (tag === 'EARLY_WATCH') groups.push('EARLY_WATCH');
  if (tag === 'SURGE_WATCH') groups.push('SURGE_WATCH');
  if (tag === 'BREAKOUT_CHASE') groups.push('BREAKOUT_CHASE');
  if (tag === 'CHASE_RISK') groups.push('CHASE_RISK');

  if (c.labels.includes('BMS_VALUE') && c.labels.includes('BMS_SURGE')) groups.push('VALUE_AND_SURGE');
  if (c.labels.includes('BMS_VALUE') && !c.labels.includes('BMS_SURGE')) groups.push('VALUE_ONLY');
  if (c.labels.includes('BMS_SURGE') && !c.labels.includes('BMS_VALUE')) groups.push('SURGE_ONLY');

  if (c.historyQuality === 'MID_HISTORY' || c.historyQuality === 'FULL_HISTORY') groups.push('MIDFULL_HISTORY');
  if (c.historyQuality === 'SHORT_HISTORY') groups.push('SHORT_HISTORY');
  return groups;
}

// ─────────────────────── 통계 집계 ───────────────────────

function statsForGroup(records, groupKey) {
  const f = records.filter(r => r.groups.includes(groupKey));
  if (f.length === 0) return { groupKey, count: 0 };
  const withVal = f.filter(r => r.validation?.available);
  const pickAvg = (k) => avg(withVal.map(r => r.validation?.[k]));
  const pickMed = (k) => median(withVal.map(r => r.validation?.[k]));
  const pickRate = (k) => rate(withVal.map(r => r.validation?.[k]));
  const pickReturnOver = (k, threshold) => rate(withVal.map(r => {
    const v = r.validation?.[k];
    return v != null ? v > threshold : null;
  }));
  const pickReturnUnder = (k, threshold) => rate(withVal.map(r => {
    const v = r.validation?.[k];
    return v != null ? v < threshold : null;
  }));

  return {
    groupKey,
    count: f.length,
    countValidated: withVal.length,
    avgNextCloseReturn: pickAvg('nextDayCloseReturn'),
    medNextCloseReturn: pickMed('nextDayCloseReturn'),
    avgNextHighReturn: pickAvg('nextDayHighReturn'),
    medNextHighReturn: pickMed('nextDayHighReturn'),
    avgNextLowReturn: pickAvg('nextDayLowReturn'),
    medNextLowReturn: pickMed('nextDayLowReturn'),
    avgGapReturn: pickAvg('gapReturn'),
    medGapReturn: pickMed('gapReturn'),
    highBreakRate: pickRate('HIGH_BREAK_SUCCESS'),
    closeBreakRate: pickRate('nextDayCloseBreak'),
    positiveCloseRate: pickRate('CLOSE_POSITIVE_SUCCESS'),
    strongConfirmRate: pickRate('STRONG_CONFIRM'),
    failedConfirmRate: pickRate('FAILED_CONFIRM'),
    highThenFadeRate: pickRate('HIGH_THEN_FADE'),
    gapUpFailRate: pickRate('GAP_UP_FAIL'),
    valueMaintainedRate: pickRate('valueMaintained'),
    valueExpandedRate: pickRate('valueExpanded'),
    valueExpandButFailRate: pickRate('VALUE_EXPAND_BUT_FAIL'),
    avgIntradayGiveback: pickAvg('intradayGiveback'),
    medIntradayGiveback: pickMed('intradayGiveback'),
    highReturnOver3Rate: pickReturnOver('nextDayHighReturn', 3),
    highReturnOver5Rate: pickReturnOver('nextDayHighReturn', 5),
    highReturnOver10Rate: pickReturnOver('nextDayHighReturn', 10),
    closeReturnOver3Rate: pickReturnOver('nextDayCloseReturn', 3),
    closeReturnOver5Rate: pickReturnOver('nextDayCloseReturn', 5),
    lowDropOver3Rate: pickReturnUnder('nextDayLowReturn', -3),
    lowDropOver5Rate: pickReturnUnder('nextDayLowReturn', -5),
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('WRA Date-to-Date Validation Report');
  console.log('═'.repeat(80));
  console.log(`dataCutoffDate: ${fmtDate(CONFIG.DATA_CUTOFF_DATE)} → validationDate: ${fmtDate(CONFIG.VALIDATION_DATE)}`);
  console.log();

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`차트 ${files.length}개 처리 시작...`);

  const candidates = [];
  let processed = 0;
  let skipMeta = 0, skipExcl = 0, skipMc = 0, skipShort = 0, skipNoCutoff = 0, noLabel = 0;
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

    // 4/30까지 slice
    const cutRows = rows.filter(r => r.date <= CONFIG.DATA_CUTOFF_DATE);
    if (cutRows.length < CONFIG.MIN_HISTORY) { skipShort++; return; }

    // cutRows의 마지막 거래일이 DATA_CUTOFF_DATE인지 확인 (4/30 이전이면 데이터 부족)
    const lastCutDate = cutRows[cutRows.length - 1].date;
    if (lastCutDate !== CONFIG.DATA_CUTOFF_DATE) { skipNoCutoff++; processed++; return; }

    const m = measureCutoff(cutRows, marketCap);
    if (!m) { processed++; return; }

    // 라벨 평가
    const mForLabels = {
      ...m,
      // evaluateLabels가 m.boxUpperBreak를 사용하니 측정에 포함되어야 함 (이미 m.boxUpperBreak 있음)
    };
    const labels = v2.evaluateLabels(mForLabels);
    if (labels.length === 0) { noLabel++; processed++; return; }

    const hasBmsValue = labels.includes('BMS_VALUE');
    const scores = v2.computeScores(m, m.prep, hasBmsValue);
    const tagV2 = v2.watchTagV2(labels, scores.riskScore, scores.warnings);

    // 5/4 검증
    const validateRow = rows.find(r => r.date === CONFIG.VALIDATION_DATE);
    const validation = validateNextDay(
      { open: m.open, high: m.high, low: m.low, close: m.close },
      validateRow,
      m.avgValue20
    );

    const candidate = {
      code,
      name: meta.name,
      market: meta.market,
      marketCap,
      dataCutoffDate: CONFIG.DATA_CUTOFF_DATE,
      validationDate: CONFIG.VALIDATION_DATE,
      labels,
      watchTagV2: tagV2,
      historyQuality: historyQuality(m.chartLen),
      boxQuality: boxQuality(m),
      // 점수
      totalScore: scores.totalScore,
      traceScore: scores.traceScore,
      confirmScore: scores.confirmScore,
      structureScore: scores.structureScore,
      riskScore: scores.riskScore,
      // 4/30 기준 metrics
      signalOpen: m.open,
      signalHigh: m.high,
      signalLow: m.low,
      signalClose: m.close,
      signalVolume: m.volume,
      signalValue: m.value,
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
      warnings: scores.warnings,
      // 5/4 검증 결과
      validation,
    };
    candidate.groups = assignGroups(candidate);
    candidates.push(candidate);
    processed++;
  });
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n분석 완료: 처리 ${processed}, 후보 ${candidates.length}개, ${elapsed.toFixed(0)}초`);
  console.log(`  스킵: meta=${skipMeta} 제외=${skipExcl} 시총미달=${skipMc} 차트짧음=${skipShort} cutoff없음=${skipNoCutoff} 라벨없음=${noLabel}`);

  // 5/4 검증 데이터 가용성
  const validatedCount = candidates.filter(c => c.validation?.available).length;
  console.log(`  5/4 검증 데이터 있음: ${validatedCount} / ${candidates.length}`);

  // 그룹별 통계
  const GROUPS = ['ALL', 'CORE_A', 'CORE_B', 'CORE_A_RISK0', 'CORE_A_MIDFULL', 'EARLY_WATCH', 'SURGE_WATCH',
    'BREAKOUT_CHASE', 'CHASE_RISK', 'VALUE_AND_SURGE', 'VALUE_ONLY', 'SURGE_ONLY', 'MIDFULL_HISTORY', 'SHORT_HISTORY'];
  const groupStats = {};
  GROUPS.forEach(g => { groupStats[g] = statsForGroup(candidates, g); });

  // 카운트 요약
  const watchCount = {};
  const labelCount = { BMS_EARLY: 0, BMS_VALUE: 0, BMS_SURGE: 0, BMS_BREAKOUT: 0, valueAndSurge: 0 };
  const histCount = {};
  const boxCount = {};
  let strongConfirm = 0, failedConfirm = 0, highThenFade = 0, gapUpFail = 0, valueExpandButFail = 0;
  candidates.forEach(c => {
    watchCount[c.watchTagV2] = (watchCount[c.watchTagV2] || 0) + 1;
    c.labels.forEach(l => labelCount[l] = (labelCount[l] || 0) + 1);
    if (c.labels.includes('BMS_VALUE') && c.labels.includes('BMS_SURGE')) labelCount.valueAndSurge++;
    histCount[c.historyQuality] = (histCount[c.historyQuality] || 0) + 1;
    boxCount[c.boxQuality] = (boxCount[c.boxQuality] || 0) + 1;
    if (c.validation?.STRONG_CONFIRM) strongConfirm++;
    if (c.validation?.FAILED_CONFIRM) failedConfirm++;
    if (c.validation?.HIGH_THEN_FADE) highThenFade++;
    if (c.validation?.GAP_UP_FAIL) gapUpFail++;
    if (c.validation?.VALUE_EXPAND_BUT_FAIL) valueExpandButFail++;
  });
  const allStats = groupStats.ALL;

  // 콘솔 요약
  console.log('\n📊 watchTagV2 분포:', JSON.stringify(watchCount));
  console.log('   라벨:', JSON.stringify(labelCount));
  console.log('   history:', JSON.stringify(histCount));
  console.log('   box:', JSON.stringify(boxCount));
  console.log();
  console.log('📊 그룹별 5/4 성과:');
  console.log('  group               n    val  avgClose%  medClose%  avgHigh%   strong%  fail%   fade%  +5%도달');
  GROUPS.forEach(g => {
    const s = groupStats[g];
    if (s.count === 0) { console.log(`  ${g.padEnd(18)}: 사례 없음`); return; }
    const f = (n) => n != null && Number.isFinite(n) ? n.toFixed(2) : '--';
    const r = (n) => n != null ? (n*100).toFixed(0)+'%' : '--';
    console.log(`  ${g.padEnd(18)} ${String(s.count).padStart(4)} ${String(s.countValidated).padStart(4)}  ${f(s.avgNextCloseReturn).padStart(8)}  ${f(s.medNextCloseReturn).padStart(8)}  ${f(s.avgNextHighReturn).padStart(8)}   ${r(s.strongConfirmRate).padStart(5)}  ${r(s.failedConfirmRate).padStart(5)}  ${r(s.highThenFadeRate).padStart(5)}  ${r(s.highReturnOver5Rate).padStart(5)}`);
  });

  // topLists
  const topStrongConfirm = candidates
    .filter(c => c.validation?.STRONG_CONFIRM)
    .sort((a, b) => {
      const A = a.validation, B = b.validation;
      if (B.nextDayCloseReturn !== A.nextDayCloseReturn) return B.nextDayCloseReturn - A.nextDayCloseReturn;
      if (B.validateCloseLocation !== A.validateCloseLocation) return B.validateCloseLocation - A.validateCloseLocation;
      return (B.validateValueRatio20 || 0) - (A.validateValueRatio20 || 0);
    })
    .slice(0, CONFIG.TOP_N);

  const sortDesc = (key) => (a, b) => (b.validation?.[key] || -Infinity) - (a.validation?.[key] || -Infinity);
  const sortAsc = (key) => (a, b) => (a.validation?.[key] || Infinity) - (b.validation?.[key] || Infinity);

  const topNextCloseReturn = candidates.filter(c => c.validation?.available)
    .sort(sortDesc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N);
  const topNextHighReturn = candidates.filter(c => c.validation?.available)
    .sort(sortDesc('nextDayHighReturn')).slice(0, CONFIG.TOP_N);
  const topHighThenFade = candidates.filter(c => c.validation?.HIGH_THEN_FADE)
    .sort((a, b) => {
      if ((b.validation.nextDayHighReturn || 0) !== (a.validation.nextDayHighReturn || 0))
        return b.validation.nextDayHighReturn - a.validation.nextDayHighReturn;
      return a.validation.validateCloseLocation - b.validation.validateCloseLocation;
    })
    .slice(0, CONFIG.TOP_N);
  const topFailedConfirm = candidates.filter(c => c.validation?.FAILED_CONFIRM)
    .sort(sortAsc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N);
  const topGapUpFail = candidates.filter(c => c.validation?.GAP_UP_FAIL)
    .sort(sortAsc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N);
  const topValueExpandButFail = candidates.filter(c => c.validation?.VALUE_EXPAND_BUT_FAIL)
    .sort(sortAsc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N);

  const topCoreA = candidates.filter(c => c.watchTagV2 === 'CORE_A')
    .sort((a, b) => {
      if (a.riskScore !== b.riskScore) return a.riskScore - b.riskScore;
      return (b.validation?.nextDayCloseReturn || -Infinity) - (a.validation?.nextDayCloseReturn || -Infinity);
    })
    .slice(0, CONFIG.TOP_N);
  const topCoreB = candidates.filter(c => c.watchTagV2 === 'CORE_B')
    .sort((a, b) => {
      if (a.riskScore !== b.riskScore) return a.riskScore - b.riskScore;
      return (b.validation?.nextDayCloseReturn || -Infinity) - (a.validation?.nextDayCloseReturn || -Infinity);
    })
    .slice(0, CONFIG.TOP_N);
  const topMidFull = candidates.filter(c => c.historyQuality !== 'SHORT_HISTORY' && c.validation?.available)
    .sort(sortDesc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N);
  const topShortHistory = candidates.filter(c => c.historyQuality === 'SHORT_HISTORY' && c.validation?.available)
    .sort(sortDesc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N);

  // JSON
  const out = {
    meta: {
      version: 'wra-date-to-date-validation-v1',
      generatedAt: new Date().toISOString(),
      mode: 'date-to-date-validation',
      dataCutoffDate: CONFIG.DATA_CUTOFF_DATE,
      validationDate: CONFIG.VALIDATION_DATE,
      executionSeconds: Math.round(elapsed),
      note: '2026-04-30까지의 데이터로 후보를 생성하고 2026-05-04 하루 데이터로 다음 거래일 반응을 검증',
      universeProcessed: processed,
      candidatesCount: candidates.length,
      candidatesValidated: validatedCount,
    },
    config: CONFIG,
    summary: {
      totalStocksProcessed: processed,
      totalCandidates: candidates.length,
      candidatesValidated: validatedCount,
      watchCount,
      labelCount,
      historyCount: histCount,
      boxCount,
      strongConfirmCount: strongConfirm,
      failedConfirmCount: failedConfirm,
      highThenFadeCount: highThenFade,
      gapUpFailCount: gapUpFail,
      valueExpandButFailCount: valueExpandButFail,
      avgNextCloseReturn: allStats.avgNextCloseReturn,
      medNextCloseReturn: allStats.medNextCloseReturn,
      avgNextHighReturn: allStats.avgNextHighReturn,
      medNextHighReturn: allStats.medNextHighReturn,
      highBreakRate: allStats.highBreakRate,
      positiveCloseRate: allStats.positiveCloseRate,
      strongConfirmRate: allStats.strongConfirmRate,
      failedConfirmRate: allStats.failedConfirmRate,
    },
    groupStats,
    topLists: {
      topStrongConfirm,
      topNextCloseReturn,
      topNextHighReturn,
      topHighThenFade,
      topFailedConfirm,
      topGapUpFail,
      topValueExpandButFail,
      topCoreA,
      topCoreB,
      topMidFull,
      topShortHistory,
    },
    candidates,
  };

  const outPath = path.join(REPORTS_DIR, 'wra-20260430-to-20260504-validation-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  const sizeKB = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`\n✅ JSON 저장: ${outPath} (${sizeKB}KB)`);
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main };
