#!/usr/bin/env node
/**
 * WRA Date-to-Date Rolling Validation Report
 *
 * 목적:
 *   여러 과거 cutoff date에서 "cutoff까지 데이터로 후보 생성 → 다음 실제 거래일 1일 반응 검증"을 반복하여,
 *   watchTagV2 + label 조합이 다음 거래일에 일관되게 유효한지 확인한다.
 *
 *   단일 cutoff(4/30 → 5/4) 검증의 한계 (시장 시점 의존, 표본 부족)를 보완.
 *
 * 절대 하지 말 것:
 *   - QVA/VVI 파일 수정
 *   - 운영 보드/라우트/관리자 화면 연결
 *   - 기존 wra v1/v2/date-to-date 결과 덮어쓰기
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json
 *
 * 출력:
 *   - reports/wra-date-to-date-rolling-validation-result.json
 *
 * 옵션:
 *   --days=20                          최근 N개 거래일을 cutoff로 사용 (기본 20)
 *   --from=20260301 --to=20260430      범위 지정
 *   --top=50                           topLists 사이즈
 */

const fs = require('fs');
const path = require('path');
const wra = require('./wra-winner-reverse-audit');
const v2 = require('./wra-current-similarity-report-v2');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
})();

const CONFIG = {
  DAYS: parseInt(args.days || '20'),
  FROM: args.from || null,
  TO: args.to || null,
  MIN_HISTORY: 60,
  MIN_MARKET_CAP: 30_000_000_000,
  TOP_N: parseInt(args.top || '50'),
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

// ─────────────────────── cutoff index 측정 ───────────────────────
//
// 종목별 차트 rows에서 date <= cutoff인 마지막 idx에서 metric 측정.
// 차트가 cutoff 정확히 포함하지 않으면 null 반환 (그 cutoff에는 그 종목 없음).
function measureAtCutoff(rows, cutoffDate, marketCap) {
  // cutoff에 정확히 매칭되는 row의 idx (즉 cutoffDate가 그 종목 거래일이어야)
  let cutIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === cutoffDate) { cutIdx = i; break; }
    if (rows[i].date < cutoffDate) break;
  }
  if (cutIdx < 0) return null;
  if (cutIdx + 1 < CONFIG.MIN_HISTORY) return null;

  const cutRows = rows.slice(0, cutIdx + 1);
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

  const avgVal20 = indi.avgVal20[idx];

  return {
    open: today.open, high: today.high, low: today.low, close: today.close,
    volume: today.volume, value: today.valueApprox,
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
    boxUpperBreak: t0Detail.boxUpperBreak,
    chartLen: cutRows.length,
    prep,
  };
}

// ─────────────────────── 검증 ───────────────────────

function validateNextDay(signalClose, signalHigh, validateRow, avgValue20) {
  if (!validateRow) return { available: false };
  const v = validateRow;
  const range = v.high - v.low;
  const closeLocation = range > 0 ? (v.close - v.low) / range : 0.5;
  const intradayGiveback = v.high > 0 ? (v.high - v.close) / v.high : 0;
  const validateValueRatio20 = avgValue20 ? (v.valueApprox || 0) / avgValue20 : null;

  const gapReturn = signalClose ? (v.open / signalClose - 1) * 100 : null;
  const nextDayHighReturn = signalClose ? (v.high / signalClose - 1) * 100 : null;
  const nextDayLowReturn = signalClose ? (v.low / signalClose - 1) * 100 : null;
  const nextDayCloseReturn = signalClose ? (v.close / signalClose - 1) * 100 : null;

  const nextDayHighBreak = v.high > signalHigh;
  const nextDayCloseBreak = v.close > signalHigh;
  const nextDayClosePositive = v.close > signalClose;
  const valueMaintained = validateValueRatio20 != null && validateValueRatio20 >= 1.0;
  const valueExpanded = validateValueRatio20 != null && validateValueRatio20 >= 1.5;

  return {
    available: true,
    validateOpen: v.open, validateHigh: v.high, validateLow: v.low, validateClose: v.close,
    validateVolume: v.volume, validateValue: v.valueApprox,
    gapReturn, nextDayHighReturn, nextDayLowReturn, nextDayCloseReturn,
    nextDayHighBreak, nextDayCloseBreak, nextDayClosePositive,
    validateCloseLocation: closeLocation, intradayGiveback, validateValueRatio20,
    valueMaintained, valueExpanded,
    HIGH_BREAK_SUCCESS: nextDayHighBreak,
    CLOSE_POSITIVE_SUCCESS: nextDayClosePositive,
    STRONG_CONFIRM: nextDayHighBreak && nextDayClosePositive && closeLocation >= 0.6 && valueMaintained,
    FAILED_CONFIRM: !nextDayHighBreak && !nextDayClosePositive,
    HIGH_THEN_FADE: nextDayHighBreak && closeLocation < 0.4,
    GAP_UP_FAIL: (gapReturn || 0) > 0 && (nextDayCloseReturn || 0) < 0,
    VALUE_EXPAND_BUT_FAIL: valueExpanded && !nextDayClosePositive,
  };
}

// ─────────────────────── 그룹 분류 ───────────────────────

function isCleanValueSetup(c, m) {
  return c.labels.includes('BMS_VALUE')
    && !c.labels.includes('BMS_SURGE')
    && c.riskScore <= 10
    && c.boxQuality === 'BOX_STABLE'
    && (m.dayReturn || 0) < 5
    && (m.closeToMA20 || 0) < 12
    && (m.closeFromRecentLow20 || 0) < 25
    && (m.valueRatio20 || 0) >= 1.5
    && (m.valueRatio20 || 0) <= 4.0;
}
function isStructureReady(c, m) {
  return c.labels.length === 1 && c.labels[0] === 'BMS_EARLY'
    && c.riskScore === 0
    && c.boxQuality === 'BOX_STABLE'
    && (m.closeToMA20 || 0) >= -3
    && (m.closeToMA20 || 0) <= 8
    && (m.closeFromRecentLow20 || 0) < 20
    && (m.valueRatio20 || 0) >= 1.2;
}

function assignGroups(c, m) {
  const groups = ['ALL'];
  const tag = c.watchTagV2;
  if (tag === 'CORE_A') {
    groups.push('CORE_A');
    if (c.riskScore === 0) {
      groups.push('CORE_A_RISK0');
      groups.push('SAFE_CONFIRM_CANDIDATE');
    }
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

  // 추가 그룹
  if (isCleanValueSetup(c, m)) groups.push('CLEAN_VALUE_SETUP');
  if (c.labels.includes('BMS_BREAKOUT') && (c.labels.includes('BMS_VALUE') || c.labels.includes('BMS_SURGE'))) groups.push('BREAKOUT_MOMENTUM');
  if (tag === 'CHASE_RISK' || c.riskScore >= 20) groups.push('HIGH_VOLATILITY');
  if (isStructureReady(c, m)) groups.push('STRUCTURE_READY');

  return groups;
}

// ─────────────────────── 그룹 통계 ───────────────────────

function statsForGroup(events, groupKey) {
  const f = events.filter(e => e.groups.includes(groupKey));
  if (f.length === 0) return { groupKey, eventCount: 0 };
  const withVal = f.filter(e => e.validation?.available);
  const pickAvg = (k) => avg(withVal.map(e => e.validation?.[k]));
  const pickMed = (k) => median(withVal.map(e => e.validation?.[k]));
  const pickRate = (k) => rate(withVal.map(e => e.validation?.[k]));
  const pickReturnOver = (k, t) => rate(withVal.map(e => {
    const v = e.validation?.[k];
    return v != null ? v > t : null;
  }));
  const pickReturnUnder = (k, t) => rate(withVal.map(e => {
    const v = e.validation?.[k];
    return v != null ? v < t : null;
  }));
  return {
    groupKey,
    eventCount: f.length,
    eventCountValidated: withVal.length,
    uniqueStockCount: new Set(f.map(e => e.code)).size,
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
    highReturnOver3Rate: pickReturnOver('nextDayHighReturn', 3),
    highReturnOver5Rate: pickReturnOver('nextDayHighReturn', 5),
    closeReturnOver3Rate: pickReturnOver('nextDayCloseReturn', 3),
    closeReturnOver5Rate: pickReturnOver('nextDayCloseReturn', 5),
    lowDropOver3Rate: pickReturnUnder('nextDayLowReturn', -3),
    lowDropOver5Rate: pickReturnUnder('nextDayLowReturn', -5),
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('WRA Date-to-Date Rolling Validation Report');
  console.log('═'.repeat(80));

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  // 차트 메모리 로드
  console.log('차트 로드 중...');
  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  const chartsMap = {};
  files.forEach(f => {
    const code = f.replace('.json', '');
    const meta = stockMap[code];
    if (!meta) return;
    if (isExcluded(meta.name)) return;
    if (meta.isSpecial) return;
    if ((meta.marketValue || 0) < CONFIG.MIN_MARKET_CAP) return;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CHART_DIR, f), 'utf-8'));
      const rows = c.rows || [];
      if (rows.length >= CONFIG.MIN_HISTORY) chartsMap[code] = rows;
    } catch (_) {}
  });
  console.log(`  ${Object.keys(chartsMap).length}개 차트 로드 (시총 300억+ ETF 제외)`);

  // 거래일 union 결정
  const dateFreq = {};
  Object.values(chartsMap).forEach(rows => {
    rows.forEach(r => { dateFreq[r.date] = (dateFreq[r.date] || 0) + 1; });
  });
  const sortedDates = Object.keys(dateFreq).sort();

  // cutoff/validation pair 결정
  let cutoffPairs = [];
  if (CONFIG.FROM && CONFIG.TO) {
    const filtered = sortedDates.filter(d => d >= CONFIG.FROM && d <= CONFIG.TO);
    for (let i = 0; i < filtered.length - 1; i++) {
      // validation은 cutoff 다음 거래일 — sortedDates에서 cutoff 다음 idx
      const nextDate = sortedDates[sortedDates.indexOf(filtered[i]) + 1];
      if (!nextDate) continue;
      cutoffPairs.push({ cutoff: filtered[i], validation: nextDate });
    }
  } else {
    // 마지막 N+1개 거래일 → N개 pair
    const last = sortedDates.slice(-CONFIG.DAYS - 1);
    for (let i = 0; i < last.length - 1; i++) {
      cutoffPairs.push({ cutoff: last[i], validation: last[i + 1] });
    }
  }
  console.log(`cutoff pairs: ${cutoffPairs.length}개`);
  if (cutoffPairs.length === 0) { console.error('cutoff pair 없음'); process.exit(1); }
  console.log(`  첫: ${fmtDate(cutoffPairs[0].cutoff)} → ${fmtDate(cutoffPairs[0].validation)}`);
  console.log(`  마지막: ${fmtDate(cutoffPairs[cutoffPairs.length-1].cutoff)} → ${fmtDate(cutoffPairs[cutoffPairs.length-1].validation)}`);

  const events = [];
  const dailyStatsRaw = {};   // cutoff -> { events: [] }
  const startTime = Date.now();
  let cutoffIdx = 0;

  cutoffPairs.forEach(({ cutoff, validation }) => {
    cutoffIdx++;
    const dailyEvents = [];
    Object.entries(chartsMap).forEach(([code, rows]) => {
      const meta = stockMap[code];
      if (!meta) return;
      const marketCap = meta.marketValue;

      const m = measureAtCutoff(rows, cutoff, marketCap);
      if (!m) return;

      const labels = v2.evaluateLabels(m);
      if (labels.length === 0) return;

      const hasBmsValue = labels.includes('BMS_VALUE');
      const scores = v2.computeScores(m, m.prep, hasBmsValue);
      const tagV2 = v2.watchTagV2(labels, scores.riskScore, scores.warnings);

      // validation row 찾기
      const validateRow = rows.find(r => r.date === validation);
      const validation_ = validateNextDay(m.close, m.high, validateRow, m.avgValue20);

      const ev = {
        cutoffDate: cutoff,
        validationDate: validation,
        code,
        name: meta.name,
        market: meta.market,
        marketCap,
        labels,
        watchTagV2: tagV2,
        historyQuality: historyQuality(m.chartLen),
        boxQuality: boxQuality(m),
        totalScore: scores.totalScore,
        traceScore: scores.traceScore,
        confirmScore: scores.confirmScore,
        structureScore: scores.structureScore,
        riskScore: scores.riskScore,
        // signal metrics (간략)
        signalClose: m.close, signalHigh: m.high, signalLow: m.low, signalOpen: m.open,
        signalValue: m.value, signalVolume: m.volume,
        valueRatio20: m.valueRatio20,
        volumeRatio20: m.volumeRatio20,
        valueToMarketCap: m.valueToMarketCap,
        closeLocation: m.closeLocation,
        closeToMA20: m.closeToMA20,
        closeToMA60: m.closeToMA60,
        closeFromRecentLow20: m.closeFromRecentLow20,
        closeFrom52WeekHigh: m.closeFrom52WeekHigh,
        dayReturn: m.dayReturn,
        boxRangePct: m.boxRangePct,
        dynamicBoxDuration: m.dynamicBoxDuration,
        boxFallback: m.boxFallback,
        overheadRatio: m.overheadRatio,
        supportRatio: m.supportRatio,
        warnings: scores.warnings,
        validation: validation_,
      };
      ev.groups = assignGroups(ev, m);
      events.push(ev);
      dailyEvents.push(ev);
    });
    dailyStatsRaw[cutoff] = dailyEvents;

    if (cutoffIdx % 5 === 0 || cutoffIdx === cutoffPairs.length) {
      const e = (Date.now() - startTime) / 1000;
      process.stdout.write(`\rcutoff ${cutoffIdx}/${cutoffPairs.length} events=${events.length} ${e.toFixed(0)}s`);
    }
  });
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\nrolling 완료: ${events.length} events, ${elapsed.toFixed(0)}초`);

  // 그룹 통계
  const GROUPS = [
    'ALL', 'CORE_A', 'CORE_A_RISK0', 'CORE_B', 'EARLY_WATCH', 'SURGE_WATCH',
    'BREAKOUT_CHASE', 'CHASE_RISK', 'VALUE_AND_SURGE', 'VALUE_ONLY', 'SURGE_ONLY',
    'MIDFULL_HISTORY', 'SHORT_HISTORY',
    // 새 그룹
    'SAFE_CONFIRM_CANDIDATE', 'CLEAN_VALUE_SETUP', 'BREAKOUT_MOMENTUM', 'HIGH_VOLATILITY', 'STRUCTURE_READY',
  ];
  const groupStats = {};
  GROUPS.forEach(g => { groupStats[g] = statsForGroup(events, g); });

  // 날짜별 통계
  const dailyStats = {};
  Object.entries(dailyStatsRaw).forEach(([cutoff, dailyEvents]) => {
    const withVal = dailyEvents.filter(e => e.validation?.available);
    const topStrong = [...dailyEvents].filter(e => e.validation?.STRONG_CONFIRM)
      .sort((a, b) => (b.validation.nextDayCloseReturn || 0) - (a.validation.nextDayCloseReturn || 0))
      .slice(0, 5)
      .map(e => ({ code: e.code, name: e.name, watchTagV2: e.watchTagV2, ret: e.validation.nextDayCloseReturn }));
    dailyStats[cutoff] = {
      cutoffDate: cutoff,
      validationDate: dailyEvents[0]?.validationDate || null,
      candidatesCount: dailyEvents.length,
      candidatesValidated: withVal.length,
      avgNextCloseReturn: avg(withVal.map(e => e.validation.nextDayCloseReturn)),
      highBreakRate: rate(withVal.map(e => e.validation.HIGH_BREAK_SUCCESS)),
      strongConfirmRate: rate(withVal.map(e => e.validation.STRONG_CONFIRM)),
      failedConfirmRate: rate(withVal.map(e => e.validation.FAILED_CONFIRM)),
      topStrongConfirm: topStrong,
    };
  });

  // topLists
  const sortDesc = (k) => (a, b) => (b.validation?.[k] || -Infinity) - (a.validation?.[k] || -Infinity);
  const sortAsc = (k) => (a, b) => (a.validation?.[k] || Infinity) - (b.validation?.[k] || Infinity);
  const onlyVal = events.filter(e => e.validation?.available);
  const trim = (e) => ({
    code: e.code, name: e.name, market: e.market, watchTagV2: e.watchTagV2,
    cutoffDate: e.cutoffDate, validationDate: e.validationDate,
    labels: e.labels, riskScore: e.riskScore, totalScore: e.totalScore,
    historyQuality: e.historyQuality, boxQuality: e.boxQuality,
    nextDayCloseReturn: e.validation.nextDayCloseReturn,
    nextDayHighReturn: e.validation.nextDayHighReturn,
    gapReturn: e.validation.gapReturn,
    validateCloseLocation: e.validation.validateCloseLocation,
    validateValueRatio20: e.validation.validateValueRatio20,
  });

  const topStrongConfirm = onlyVal.filter(e => e.validation.STRONG_CONFIRM)
    .sort((a, b) => {
      const A = a.validation, B = b.validation;
      if (B.nextDayCloseReturn !== A.nextDayCloseReturn) return B.nextDayCloseReturn - A.nextDayCloseReturn;
      if (B.validateCloseLocation !== A.validateCloseLocation) return B.validateCloseLocation - A.validateCloseLocation;
      return (B.validateValueRatio20 || 0) - (A.validateValueRatio20 || 0);
    })
    .slice(0, CONFIG.TOP_N).map(trim);
  const topNextCloseReturn = [...onlyVal].sort(sortDesc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N).map(trim);
  const topNextHighReturn = [...onlyVal].sort(sortDesc('nextDayHighReturn')).slice(0, CONFIG.TOP_N).map(trim);
  const topHighThenFade = onlyVal.filter(e => e.validation.HIGH_THEN_FADE)
    .sort(sortDesc('nextDayHighReturn')).slice(0, CONFIG.TOP_N).map(trim);
  const topFailedConfirm = onlyVal.filter(e => e.validation.FAILED_CONFIRM)
    .sort(sortAsc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N).map(trim);
  const topCleanValueSetup = onlyVal.filter(e => e.groups.includes('CLEAN_VALUE_SETUP'))
    .sort(sortDesc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N).map(trim);
  const topSafeConfirmCandidate = onlyVal.filter(e => e.groups.includes('SAFE_CONFIRM_CANDIDATE'))
    .sort(sortDesc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N).map(trim);
  const topBreakoutMomentum = onlyVal.filter(e => e.groups.includes('BREAKOUT_MOMENTUM'))
    .sort(sortDesc('nextDayCloseReturn')).slice(0, CONFIG.TOP_N).map(trim);
  const topHighVolatility = onlyVal.filter(e => e.groups.includes('HIGH_VOLATILITY'))
    .sort(sortDesc('nextDayHighReturn')).slice(0, CONFIG.TOP_N).map(trim);

  // 콘솔 출력
  console.log('\n📊 그룹별 rolling 통계:');
  console.log('  group                       n   uStocks  avgClose%  medClose%  avgHigh%  strong%  fail%  fade%  +5%도달 lowDrop>5%');
  GROUPS.forEach(g => {
    const s = groupStats[g];
    if (s.eventCount === 0) { console.log(`  ${g.padEnd(26)}: 사례 없음`); return; }
    const f = (n) => n != null && Number.isFinite(n) ? n.toFixed(2) : '--';
    const r = (n) => n != null ? (n*100).toFixed(0)+'%' : '--';
    console.log(`  ${g.padEnd(26)} ${String(s.eventCount).padStart(4)} ${String(s.uniqueStockCount).padStart(6)}  ${f(s.avgNextCloseReturn).padStart(8)}  ${f(s.medNextCloseReturn).padStart(8)}  ${f(s.avgNextHighReturn).padStart(7)}  ${r(s.strongConfirmRate).padStart(5)}  ${r(s.failedConfirmRate).padStart(5)}  ${r(s.highThenFadeRate).padStart(5)}  ${r(s.highReturnOver5Rate).padStart(5)}  ${r(s.lowDropOver5Rate).padStart(5)}`);
  });

  // 카운트
  const watchCount = {};
  const labelCount = { BMS_EARLY: 0, BMS_VALUE: 0, BMS_SURGE: 0, BMS_BREAKOUT: 0, valueAndSurge: 0 };
  events.forEach(e => {
    watchCount[e.watchTagV2] = (watchCount[e.watchTagV2] || 0) + 1;
    e.labels.forEach(l => labelCount[l] = (labelCount[l] || 0) + 1);
    if (e.labels.includes('BMS_VALUE') && e.labels.includes('BMS_SURGE')) labelCount.valueAndSurge++;
  });

  const out = {
    meta: {
      version: 'wra-date-to-date-rolling-validation-v1',
      generatedAt: new Date().toISOString(),
      mode: 'rolling-date-to-date-validation',
      cutoffPairCount: cutoffPairs.length,
      totalEvents: events.length,
      from: cutoffPairs[0]?.cutoff,
      to: cutoffPairs[cutoffPairs.length - 1]?.cutoff,
      executionSeconds: Math.round(elapsed),
      universeStocks: Object.keys(chartsMap).length,
      note: '여러 cutoff date에서 cutoff까지 데이터로 v2 라벨 생성 → 다음 거래일 1일 반응 검증을 반복.',
    },
    config: CONFIG,
    summary: {
      cutoffPairs: cutoffPairs.length,
      totalEvents: events.length,
      universeStocks: Object.keys(chartsMap).length,
      watchCount, labelCount,
      avgNextCloseReturn: groupStats.ALL.avgNextCloseReturn,
      medNextCloseReturn: groupStats.ALL.medNextCloseReturn,
      strongConfirmRate: groupStats.ALL.strongConfirmRate,
      failedConfirmRate: groupStats.ALL.failedConfirmRate,
      highBreakRate: groupStats.ALL.highBreakRate,
    },
    groupStats,
    dailyStats,
    topLists: {
      topStrongConfirm, topNextCloseReturn, topNextHighReturn,
      topHighThenFade, topFailedConfirm,
      topCleanValueSetup, topSafeConfirmCandidate,
      topBreakoutMomentum, topHighVolatility,
    },
    // events는 매우 큼 — 별도 파일로 저장하지 않고 인덱스만 (필요시 v2 증강)
    sampleEvents: events.slice(0, 100),
  };

  const outPath = path.join(REPORTS_DIR, 'wra-date-to-date-rolling-validation-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  const sizeKB = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`\n✅ JSON 저장: ${outPath} (${sizeKB}KB)`);
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main };
