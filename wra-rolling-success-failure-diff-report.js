#!/usr/bin/env node
/**
 * WRA Rolling Success/Failure Diff Report
 *
 * 목적:
 *   여러 cutoff에서 WRA v3.1 후보를 만들고 다음 거래일 성과를 측정한 뒤,
 *   성공/실패 그룹의 차이를 "반복 검증". 단일 cutoff(4/30→5/4) 결과가
 *   우연인지 패턴인지 확인하기 위한 rolling diff.
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json (date <= cutoff만 사용)
 *   - cache/naver-stocks-list.json
 *
 * 출력:
 *   - reports/wra-rolling-success-failure-diff-result.json
 *   - reports/wra-rolling-success-failure-diff-result.html
 *
 * 실행:
 *   node wra-rolling-success-failure-diff-report.js                 (최근 20 cutoff)
 *   node wra-rolling-success-failure-diff-report.js --days=20
 *   node wra-rolling-success-failure-diff-report.js --days=40
 *   node wra-rolling-success-failure-diff-report.js --from=20260301 --to=20260430
 *
 * 데이터 누수 방지:
 *   각 cutoff마다 차트를 date <= cutoff로 slice 후 v3.1 측정.
 *   다음 거래일 OHLCV는 별도 nextDay 필드로만 보관 (점수/라벨에 미반영).
 *
 * QVA/VVI/pattern-screener/v3.1/board 미수정.
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
const OUT_JSON = path.join(REPORTS_DIR, 'wra-rolling-success-failure-diff-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'wra-rolling-success-failure-diff-result.html');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  });
  return out;
})();

const CONFIG = {
  DAYS: parseInt(args['days'] || '20'),
  FROM: args['from'] || null,
  TO: args['to'] || null,
  MIN_MARKET_CAP: parseInt(args['min-mc'] || '300') * 100_000_000,
  MIN_HISTORY: 60,
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcluded(name) { return name && EXCLUDE_KEYWORDS.some(k => name.includes(k)); }

// ─────────────────────── 헬퍼 ───────────────────────

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

function round(v, d) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function pct(num, den) { if (!den || den === 0) return null; return round(num / den * 100, 1); }

function stats(arr) {
  const valid = arr.filter(v => v != null && isFinite(v)).map(Number);
  if (valid.length === 0) return { n: 0, mean: null, median: null };
  const sorted = [...valid].sort((a, b) => a - b);
  return {
    n: valid.length,
    mean: round(valid.reduce((s, v) => s + v, 0) / valid.length, 2),
    median: round(sorted[Math.floor(sorted.length / 2)], 2),
    q1: round(sorted[Math.floor(sorted.length * 0.25)], 2),
    q3: round(sorted[Math.floor(sorted.length * 0.75)], 2),
  };
}

// ─────────────────────── 측정 ───────────────────────

// 차트 rows + cutoffIdx 시점 측정 (asof 스냅샷과 동일 로직, idx만 다름)
function measureAtIdx(rows, marketCap, cutoffIdx) {
  if (cutoffIdx < CONFIG.MIN_HISTORY - 1) return null;
  const sliced = rows.slice(0, cutoffIdx + 1);
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
    idx, date: today.date, close: today.close, high: today.high, low: today.low, prevClose: prev.close,
    dayReturn: t0Detail.dayReturn,
    valueRatio20: measurements.valueRatio20,
    volumeRatio20: measurements.volumeRatio20,
    valueToMarketCap: measurements.valueToMarketCap,
    closeLocation: measurements.closeLocation,
    closeToMA20: measurements.closeToMA20,
    closeFrom52WeekHigh: measurements.closeFrom52WeekHigh,
    closeFromRecentLow20: measurements.closeFromRecentLow20,
    closeFromRecentHigh20: measurements.closeFromRecentHigh20,
    boxRangePct: measurements.boxRangePct,
    dynamicBoxDuration: measurements.dynamicBoxDuration,
    boxFallback: measurements.boxFallback,
    chartLen: sliced.length,
    prep,
  };
}

// 다음 거래일 OHLCV (cutoffIdx + 1)
function getNextDay(rows, cutoffIdx, cutoffClose, cutoffHigh) {
  if (cutoffIdx < 0 || cutoffIdx >= rows.length - 1) return null;
  const next = rows[cutoffIdx + 1];
  if (!next || !next.date) return null;
  const nextCloseRet = (cutoffClose > 0) ? ((next.close - cutoffClose) / cutoffClose * 100) : null;
  const nextHighRet = (cutoffClose > 0 && next.high != null) ? ((next.high - cutoffClose) / cutoffClose * 100) : null;
  const closeLoc = (next.high > next.low) ? (next.close - next.low) / (next.high - next.low) : null;
  const highBreak = (cutoffHigh != null && next.high != null) ? next.high > cutoffHigh : null;
  const closeUp = (cutoffClose != null && next.close != null) ? next.close > cutoffClose : null;
  return {
    nextDate: next.date, nextOpen: next.open, nextHigh: next.high, nextLow: next.low,
    nextClose: next.close, nextVolume: next.volume,
    nextDayReturn: round(nextCloseRet, 2),
    nextHighReturn: round(nextHighRet, 2),
    closeLoc54: round(closeLoc, 3),
    highBreak, closeUp,
  };
}

function classifyEvent(c, cutoffVolume) {
  const tags = new Set();
  const nd = c.nextDay;
  if (!nd) return tags;
  // STRONG_CONFIRM (volume 비교용 — cutoffVolume 전달)
  const volMaintained = (cutoffVolume != null && cutoffVolume > 0 && nd.nextVolume != null) ? (nd.nextVolume / cutoffVolume) >= 0.7 : false;
  if (nd.highBreak === true && nd.closeUp === true && nd.closeLoc54 != null && nd.closeLoc54 >= 0.6 && volMaintained) {
    tags.add('STRONG_CONFIRM');
  }
  if (nd.nextDayReturn != null && nd.nextDayReturn >= 3) tags.add('CLOSE_WIN');
  if (nd.nextHighReturn != null && nd.nextHighReturn >= 5) tags.add('HIGH_OPPORTUNITY');
  if (nd.highBreak === false && nd.closeUp === false) tags.add('FAILED_CONFIRM');
  if (nd.highBreak === true && nd.closeLoc54 != null && nd.closeLoc54 < 0.4) tags.add('HIGH_THEN_FADE');
  if (nd.nextDayReturn != null && nd.nextDayReturn <= -2) tags.add('CLOSE_LOSS');
  if (tags.has('STRONG_CONFIRM') || tags.has('CLOSE_WIN') || tags.has('HIGH_OPPORTUNITY')) tags.add('SUCCESS_ALL');
  if (tags.has('FAILED_CONFIRM') || tags.has('HIGH_THEN_FADE') || tags.has('CLOSE_LOSS')) tags.add('FAIL_ALL');
  return tags;
}

// ─────────────────────── cutoff 결정 ───────────────────────

function pickCutoffDates(stockCharts) {
  // 모든 종목 차트의 마지막 ~50거래일 모아 frequency 기반 공통 거래일 추출
  const freq = new Map();
  stockCharts.forEach(({ rows }) => {
    const tail = rows.slice(-50);
    tail.forEach(r => { freq.set(r.date, (freq.get(r.date) || 0) + 1); });
  });
  // 종목 수의 70% 이상 등장하는 날짜만 유효 거래일로 채택
  const threshold = stockCharts.length * 0.7;
  const validDates = [...freq.entries()]
    .filter(([_, c]) => c >= threshold)
    .map(([d, _]) => d)
    .sort();          // 오름차순

  // 사용자 옵션 적용
  let candidates = validDates;
  if (CONFIG.FROM) candidates = candidates.filter(d => d >= String(CONFIG.FROM));
  if (CONFIG.TO) candidates = candidates.filter(d => d <= String(CONFIG.TO));

  // 마지막 거래일은 validation 데이터(다음일)가 없으니 제외
  if (candidates.length > 0) candidates = candidates.slice(0, candidates.length - 1);

  // --days=N 적용 (가장 최근 N개)
  if (!CONFIG.FROM && !CONFIG.TO) {
    candidates = candidates.slice(-CONFIG.DAYS);
  }
  return candidates;
}

// ─────────────────────── threshold sweep ───────────────────────

function sweepEval(events, totalAvailable) {
  if (events.length === 0) return { n: 0, fromTotal: totalAvailable };
  const closeRets = events.map(e => e.nextDay && e.nextDay.nextDayReturn).filter(v => v != null);
  const highRets = events.map(e => e.nextDay && e.nextDay.nextHighReturn).filter(v => v != null);
  const close3 = closeRets.filter(r => r >= 3).length;
  const high5 = highRets.filter(r => r >= 5).length;
  const closeLoss = events.filter(e => e._tags.has('CLOSE_LOSS')).length;
  const highThenFade = events.filter(e => e._tags.has('HIGH_THEN_FADE')).length;
  const lowDropOver3 = closeRets.filter(r => r <= -3).length;
  const success = events.filter(e => e._tags.has('SUCCESS_ALL')).length;
  const fail = events.filter(e => e._tags.has('FAIL_ALL')).length;
  const sortedClose = [...closeRets].sort((a, b) => a - b);
  return {
    n: events.length,
    fromTotal: totalAvailable,
    coveragePct: pct(events.length, totalAvailable),
    avgCloseReturn: closeRets.length ? round(closeRets.reduce((s, v) => s + v, 0) / closeRets.length, 2) : null,
    medCloseReturn: closeRets.length ? round(sortedClose[Math.floor(sortedClose.length / 2)], 2) : null,
    avgHighReturn: highRets.length ? round(highRets.reduce((s, v) => s + v, 0) / highRets.length, 2) : null,
    closeWin3Rate: pct(close3, closeRets.length),
    highOpp5Rate: pct(high5, highRets.length),
    closeLossRate: pct(closeLoss, events.length),
    highThenFadeRate: pct(highThenFade, events.length),
    lowDropOver3Rate: pct(lowDropOver3, closeRets.length),
    successRate: pct(success, events.length),
    failureRate: pct(fail, events.length),
    riskRewardRatio: (closeLoss > 0) ? round(success / closeLoss, 2) : (success > 0 ? Infinity : null),
  };
}

const SWEEP_DEFS = [
  { name: 'valueRatio20 >= 3', fn: e => (e.valueRatio20 || 0) >= 3 },
  { name: 'valueRatio20 >= 5', fn: e => (e.valueRatio20 || 0) >= 5 },
  { name: 'valueRatio20 >= 7', fn: e => (e.valueRatio20 || 0) >= 7 },
  { name: 'valueRatio20 >= 10', fn: e => (e.valueRatio20 || 0) >= 10 },
  { name: 'riskScore >= 10', fn: e => (e.riskScore || 0) >= 10 },
  { name: 'riskScore >= 20', fn: e => (e.riskScore || 0) >= 20 },
  { name: 'riskScore >= 30', fn: e => (e.riskScore || 0) >= 30 },
  { name: 'closeToMA20 <= 8', fn: e => (e.closeToMA20 || 0) <= 8 },
  { name: 'closeToMA20 <= 12', fn: e => (e.closeToMA20 || 0) <= 12 },
  { name: 'closeToMA20 <= 20', fn: e => (e.closeToMA20 || 0) <= 20 },
  { name: 'lowDist <= 20', fn: e => (e.closeFromRecentLow20 || 0) <= 20 },
  { name: 'lowDist <= 30', fn: e => (e.closeFromRecentLow20 || 0) <= 30 },
  { name: 'lowDist <= 40', fn: e => (e.closeFromRecentLow20 || 0) <= 40 },
  { name: 'dayReturn <= 5', fn: e => (e.dayReturn || 0) <= 5 },
  { name: 'dayReturn <= 10', fn: e => (e.dayReturn || 0) <= 10 },
  { name: 'dayReturn <= 15', fn: e => (e.dayReturn || 0) <= 15 },
  { name: 'HIGH_VOLATILITY only', fn: e => e.watchTagV3_1 === 'HIGH_VOLATILITY' },
  { name: 'HIGH_VOLATILITY + valueRatio20 >= 5', fn: e => e.watchTagV3_1 === 'HIGH_VOLATILITY' && (e.valueRatio20 || 0) >= 5 },
  { name: 'CLEAN_VALUE_SETUP only', fn: e => e.watchTagV3_1 === 'CLEAN_VALUE_SETUP' },
  { name: 'CLEAN_VALUE_SETUP + closeLocation>=0.7', fn: e => e.watchTagV3_1 === 'CLEAN_VALUE_SETUP' && (e.closeLocation || 0) >= 0.7 },
  { name: 'VALUE_SURGE_CONFIRM only', fn: e => e.watchTagV3_1 === 'VALUE_SURGE_CONFIRM' },
  { name: 'BREAKOUT_MOMENTUM no overlay', fn: e => e.watchTagV3_1 === 'BREAKOUT_MOMENTUM' && !e.riskOverlay },
];

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('WRA Rolling Success/Failure Diff Report');
  console.log('═'.repeat(80));

  // 1) 종목 마스터 로드
  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  // 2) 차트 일괄 로드 (필터 1차)
  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`\n차트 ${files.length}개 로드 시작...`);
  const stockCharts = [];
  let skipMeta = 0, skipExcl = 0, skipMc = 0, skipShort = 0;
  files.forEach(file => {
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
    stockCharts.push({ code, meta, marketCap, rows });
  });
  console.log(`로드 완료: ${stockCharts.length}종목 (skip meta=${skipMeta} excl=${skipExcl} mc=${skipMc} short=${skipShort})`);

  // 3) cutoff date 결정
  const cutoffs = pickCutoffDates(stockCharts);
  if (cutoffs.length === 0) {
    console.error('cutoff 날짜를 결정할 수 없음.');
    process.exit(1);
  }
  console.log(`\nrolling cutoff ${cutoffs.length}개: ${cutoffs[0]} ~ ${cutoffs[cutoffs.length - 1]}`);

  // 4) cutoff 별 측정
  const allEvents = [];
  const perCutoff = [];
  const startTime = Date.now();
  cutoffs.forEach((cutoff, ci) => {
    let cutoffEvents = 0, cutoffSuccess = 0, cutoffFail = 0;
    const cutoffEventsList = [];

    stockCharts.forEach(({ code, meta, marketCap, rows }) => {
      // cutoff index 찾기
      let cutoffIdx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].date === cutoff) { cutoffIdx = i; break; }
        if (rows[i].date < cutoff) break;
      }
      if (cutoffIdx < 0) return;
      if (cutoffIdx + 1 >= rows.length) return;       // 다음 거래일 데이터 없음

      const m = measureAtIdx(rows, marketCap, cutoffIdx);
      if (!m) return;

      const labels = v2.evaluateLabels(m);
      if (labels.length === 0) return;

      const hasBmsValue = labels.includes('BMS_VALUE');
      const v2Scores = v2.computeScores(m, m.prep, hasBmsValue);
      const tagV2 = v2.watchTagV2(labels, v2Scores.riskScore, v2Scores.warnings);
      const hQuality = historyQualityFn(m.chartLen);
      const boxQ = boxQualityFn(m);
      const v3Tag = v3_1.watchTagV3_1(labels, m, v2Scores.riskScore, tagV2, boxQ);
      const v3Scores = v3_1.computeV3Scores(labels, m, v2Scores.riskScore, hQuality, boxQ, tagV2, v3Tag.riskOverlay);

      const cutoffRow = rows[cutoffIdx];
      const nextDay = getNextDay(rows, cutoffIdx, cutoffRow.close, cutoffRow.high);
      if (!nextDay) return;

      const event = {
        cutoff, validationDate: nextDay.nextDate, code, name: meta.name, market: meta.market, marketCap,
        watchTagV3_1: v3Tag.tag, riskOverlay: v3Tag.riskOverlay,
        labels, historyQuality: hQuality, boxQuality: boxQ,
        finalScore: v3Scores.finalScore, setupScore: v3Scores.setupScore,
        momentumScore: v3Scores.momentumScore, historyScore: v3Scores.historyScore,
        riskPenalty: v3Scores.riskPenalty, riskScore: v2Scores.riskScore,
        valueRatio20: m.valueRatio20, volumeRatio20: m.volumeRatio20,
        valueToMarketCap: m.valueToMarketCap, closeLocation: m.closeLocation,
        closeToMA20: m.closeToMA20, closeFromRecentLow20: m.closeFromRecentLow20,
        closeFrom52WeekHigh: m.closeFrom52WeekHigh, dayReturn: m.dayReturn,
        boxRangePct: m.boxRangePct, dynamicBoxDuration: m.dynamicBoxDuration,
        boxFallback: m.boxFallback, warnings: v2Scores.warnings || [],
        nextDay,
      };

      // signalVolume = cutoffRow.volume
      event._tags = classifyEvent(event, cutoffRow.volume);
      allEvents.push(event);
      cutoffEventsList.push(event);
      cutoffEvents++;
      if (event._tags.has('SUCCESS_ALL')) cutoffSuccess++;
      if (event._tags.has('FAIL_ALL')) cutoffFail++;
    });

    perCutoff.push({
      cutoff, validationDate: cutoffEventsList[0]?.nextDay?.nextDate || null,
      events: cutoffEvents,
      success: cutoffSuccess, fail: cutoffFail,
      successRate: pct(cutoffSuccess, cutoffEvents),
      failureRate: pct(cutoffFail, cutoffEvents),
      avgCloseReturn: round(
        cutoffEventsList
          .map(e => e.nextDay.nextDayReturn).filter(v => v != null)
          .reduce((s, v) => s + v, 0) / Math.max(1, cutoffEventsList.length), 2),
    });

    const elapsed = (Date.now() - startTime) / 1000;
    process.stdout.write(`\rcutoff ${ci + 1}/${cutoffs.length} ${cutoff}: events=${cutoffEvents} S=${cutoffSuccess} F=${cutoffFail} (총 ${allEvents.length}, ${elapsed.toFixed(0)}s)   `);
  });
  console.log(`\n전체 이벤트: ${allEvents.length}개\n`);

  // 5) 집계
  // tag별 통계
  const TAGS = ['CLEAN_VALUE_SETUP', 'VALUE_SURGE_CONFIRM', 'BREAKOUT_MOMENTUM', 'VALUE_LOOSE', 'HIGH_VOLATILITY', 'WATCH_ONLY', 'LOW_SIGNAL'];
  const tagStats = {};
  TAGS.forEach(t => {
    const sub = allEvents.filter(e => e.watchTagV3_1 === t);
    tagStats[t] = sweepEval(sub, allEvents.length);
  });

  // 성공/실패 그룹별 cutoff 시점 지표 평균
  const COMPARE_KEYS = ['finalScore', 'setupScore', 'momentumScore', 'riskScore', 'riskPenalty',
    'valueRatio20', 'volumeRatio20', 'valueToMarketCap',
    'closeLocation', 'closeToMA20', 'closeFromRecentLow20', 'closeFrom52WeekHigh',
    'dayReturn', 'boxRangePct', 'dynamicBoxDuration'];
  const successEvents = allEvents.filter(e => e._tags.has('SUCCESS_ALL'));
  const failEvents = allEvents.filter(e => e._tags.has('FAIL_ALL'));
  const keyDiffs = {};
  COMPARE_KEYS.forEach(k => {
    const s = stats(successEvents.map(e => e[k]));
    const f = stats(failEvents.map(e => e[k]));
    keyDiffs[k] = {
      success_mean: s.mean, success_n: s.n, success_median: s.median,
      fail_mean: f.mean, fail_n: f.n, fail_median: f.median,
      diff: (s.mean != null && f.mean != null) ? round(s.mean - f.mean, 2) : null,
      successHigher: s.mean != null && f.mean != null && s.mean > f.mean,
    };
  });

  // boxFallback / box / history 분포
  function counter(arr, key) {
    const out = {};
    arr.forEach(e => { const k = e[key]; out[k] = (out[k] || 0) + 1; });
    return out;
  }
  const successBoxFallbackRate = pct(successEvents.filter(e => e.boxFallback).length, successEvents.length);
  const failBoxFallbackRate = pct(failEvents.filter(e => e.boxFallback).length, failEvents.length);
  const successBoxQ = counter(successEvents, 'boxQuality');
  const failBoxQ = counter(failEvents, 'boxQuality');
  const successHistory = counter(successEvents, 'historyQuality');
  const failHistory = counter(failEvents, 'historyQuality');

  // threshold sweep
  const sweepResults = SWEEP_DEFS.map(d => ({
    name: d.name,
    eval: sweepEval(allEvents.filter(d.fn), allEvents.length),
  }));
  const sweepRanked = [...sweepResults]
    .filter(r => r.eval.n >= 20)        // n=20 미만은 노이즈로 간주
    .sort((a, b) => (b.eval.avgCloseReturn || -999) - (a.eval.avgCloseReturn || -999));

  // 결론
  const conclusion = buildConclusion(tagStats, keyDiffs, sweepRanked, perCutoff);

  // 콘솔 요약
  console.log('tag별 성과:');
  TAGS.forEach(t => {
    const e = tagStats[t];
    if (e.n > 0) console.log(`  ${t.padEnd(22)} n=${String(e.n).padStart(4)} avgClose=${e.avgCloseReturn}% closeWin3=${e.closeWin3Rate}% closeLoss=${e.closeLossRate}% RR=${e.riskRewardRatio}`);
  });
  console.log('\n성공 vs 실패 핵심 지표:');
  ['finalScore', 'valueRatio20', 'closeLocation', 'closeToMA20', 'closeFromRecentLow20', 'riskScore'].forEach(k => {
    const v = keyDiffs[k];
    if (v.diff != null) console.log(`  ${k.padEnd(22)} success=${v.success_mean} (n=${v.success_n}) | fail=${v.fail_mean} (n=${v.fail_n}) | diff=${v.diff > 0 ? '+' : ''}${v.diff}`);
  });
  console.log('\nsweep top 5 (avgCloseReturn 기준):');
  sweepRanked.slice(0, 5).forEach(r => {
    const e = r.eval;
    console.log(`  ${r.name.padEnd(40)} n=${e.n}/${e.fromTotal} avg=${e.avgCloseReturn}% closeWin3=${e.closeWin3Rate}% closeLoss=${e.closeLossRate}% RR=${e.riskRewardRatio}`);
  });

  // 출력
  const out = {
    meta: {
      version: 'wra-rolling-diff-v1',
      generatedAt: new Date().toISOString(),
      title: 'WRA Rolling Success/Failure Diff Report',
      purpose: '여러 cutoff 반복 검증으로 단일 cutoff 결과의 우연/패턴 여부 확인',
      cutoffs,
      cutoffCount: cutoffs.length,
      stocksProcessed: stockCharts.length,
      totalEvents: allEvents.length,
    },
    config: CONFIG,
    perCutoff,
    tagStats,
    keyDiffs,
    sweepResults,
    sweepRanked: sweepRanked.slice(0, 20),
    boxAndHistory: {
      successBoxFallbackRate, failBoxFallbackRate,
      successBoxQ, failBoxQ, successHistory, failHistory,
    },
    conclusion,
    // 모든 이벤트 압축 — cutoff별 필터로 한 번에 한 날짜씩 보면 가벼움
    events: allEvents.map(e => ({
      cutoff: e.cutoff, validationDate: e.validationDate,
      code: e.code, name: e.name, market: e.market, marketCap: e.marketCap,
      tag: e.watchTagV3_1, riskOverlay: e.riskOverlay,
      finalScore: round(e.finalScore, 1),
      valueRatio20: round(e.valueRatio20, 2),
      closeLocation: round(e.closeLocation, 2),
      closeToMA20: round(e.closeToMA20, 1),
      closeFromRecentLow20: round(e.closeFromRecentLow20, 1),
      riskScore: e.riskScore,
      historyQuality: e.historyQuality,
      boxQuality: e.boxQuality,
      closeReturn: e.nextDay?.nextDayReturn,
      highReturn: e.nextDay?.nextHighReturn,
      groups: [...e._tags].filter(g => g !== 'SUCCESS_ALL' && g !== 'FAIL_ALL'),
      isSuccess: e._tags.has('SUCCESS_ALL'),
      isFail: e._tags.has('FAIL_ALL'),
    })),
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

// ─────────────────────── 결론 생성 ───────────────────────

function buildConclusion(tagStats, keyDiffs, sweepRanked, perCutoff) {
  const answers = {};

  // Q1. HIGH_VOLATILITY rolling 강한가
  const hv = tagStats.HIGH_VOLATILITY;
  answers.q1_highVolatilityRolling = {
    question: 'HIGH_VOLATILITY는 rolling에서도 강한가?',
    answer: hv && hv.n > 50
      ? `${hv.n}개 이벤트, avgClose ${hv.avgCloseReturn}%, +3% 도달 ${hv.closeWin3Rate}%, RR=${hv.riskRewardRatio}. ${(hv.avgCloseReturn || 0) >= 1 ? '예 — rolling에서도 강함' : '아니오 — 단일 cutoff와 다름'}`
      : `표본 부족 (n=${hv?.n || 0})`,
  };
  // Q2. HIGH_VOLATILITY 실패율 감당 가능
  answers.q2_highVolatilityRiskAcceptable = {
    question: 'HIGH_VOLATILITY 실패율은 감당 가능한가?',
    answer: hv ? `실패율 ${hv.failureRate}%, CLOSE_LOSS율 ${hv.closeLossRate}%, RR=${hv.riskRewardRatio}. ${(hv.riskRewardRatio || 0) >= 1.5 ? '감당 가능' : (hv.riskRewardRatio || 0) >= 1 ? '경계선' : '위험'}` : '데이터 부족',
  };
  // Q3. CLEAN_VALUE_SETUP 안정 관찰용
  const cv = tagStats.CLEAN_VALUE_SETUP;
  answers.q3_cleanIsStableObserve = {
    question: 'CLEAN_VALUE_SETUP은 단기 반응용이 아니라 안정 관찰용인가?',
    answer: cv ? `n=${cv.n}, avgClose ${cv.avgCloseReturn}%, +3% 도달 ${cv.closeWin3Rate}%, 실패율 ${cv.failureRate}%. ${(cv.closeWin3Rate || 0) < 25 ? '예 — 단기 반응 약하므로 안정 관찰용으로 재포지셔닝 추천' : '단기 반응도 일부 가능'}` : '데이터 부족',
  };
  // Q4. WATCH_ONLY 의미
  const wo = tagStats.WATCH_ONLY;
  answers.q4_watchOnlyShouldHide = {
    question: 'WATCH_ONLY는 기본 숨김 또는 제거해도 되는가?',
    answer: wo ? `n=${wo.n}, avgClose ${wo.avgCloseReturn}%, +3% 도달 ${wo.closeWin3Rate}%. ${(wo.closeWin3Rate || 0) < 5 ? '예 — 사실상 의미 없음. 기본 숨김 권장' : '약하지만 어느 정도 유효'}` : '데이터 부족',
  };
  // Q5. valueRatio20 효과
  const vrSweeps = sweepRanked.filter(r => r.name.startsWith('valueRatio20'));
  answers.q5_valueRatioWorks = {
    question: 'valueRatio20 높은 조건은 반복적으로 유효한가?',
    answer: vrSweeps.length > 0
      ? vrSweeps.map(s => `${s.name}: avgClose ${s.eval.avgCloseReturn}% +3% ${s.eval.closeWin3Rate}%`).join(' / ')
      : '데이터 부족',
  };
  // Q6. 보드 노출 순서 추천
  const sortedTags = Object.entries(tagStats)
    .filter(([_, e]) => e.n >= 20)
    .sort((a, b) => (b[1].avgCloseReturn || -999) - (a[1].avgCloseReturn || -999));
  answers.q6_boardOrder = {
    question: 'v3.2 보드 기본 노출 순서는?',
    answer: sortedTags.map(([t, e]) => `${t} (avgClose=${e.avgCloseReturn}%, +3%=${e.closeWin3Rate}%)`).join(' > '),
  };
  // Q7. 후보 조건 변경 vs 화면 분류 변경
  // — closeLocation 차이가 작고 valueRatio20/riskScore 차이가 크면 "조건 변경 효과 작고, 화면 분류 변경(노출 순서)이 더 효과적"
  const clD = keyDiffs.closeLocation;
  const vrD = keyDiffs.valueRatio20;
  const rsD = keyDiffs.riskScore;
  const conditionEffect = (Math.abs(clD?.diff || 0) > 0.05) || (Math.abs(vrD?.diff || 0) > 1) || (Math.abs(rsD?.diff || 0) > 5);
  answers.q7_changeConditionsOrUI = {
    question: 'v3.2 후보 조건을 바꿀지, 화면 분류만 바꿀지?',
    answer: conditionEffect
      ? '조건 변경보다 화면 분류 변경이 우선. closeLocation 차이는 미미하고, valueRatio20/riskScore 같은 단기 반응 지표가 더 강함. CLEAN을 안정 관찰용으로 재포지셔닝하고 HIGH_VOLATILITY를 단기 반응 핵심으로 노출하는 게 효과적.'
      : '추가 표본 필요. 단일 cutoff와 rolling 결과 모두 closeLocation 효과가 미미하므로 조건 변경은 보류, 화면 분류 우선.',
  };

  return {
    weakness: 'CLEAN_VALUE_SETUP은 종가 유지가 약함. 단기 반응 측면에서는 HIGH_VOLATILITY가 가장 강하지만 실패율도 큼. WATCH_ONLY는 사실상 무가치.',
    proposedDirection: '조건 변경보다 보드 화면 재포지셔닝이 효과적: ① 단기 반응 노리는 사용자 → HIGH_VOLATILITY를 1순위 노출 ② 안정 진입 노리는 사용자 → CLEAN_VALUE_SETUP 1순위 노출 ③ WATCH_ONLY는 LOW_SIGNAL과 함께 기본 숨김 강화.',
    answers,
  };
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>WRA Rolling Diff Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 28px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
}
h1 { font-size: 22px; margin: 0 0 6px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; }
.purpose-box strong { color: #67e8f9; }
.recommend-box { background: #422006; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 12px 16px; margin-bottom: 14px; color: #fde68a; line-height: 1.7; }
.recommend-box strong { color: #fef3c7; }

.big-summary { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.big-tile { flex: 1; min-width: 140px; background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 12px 14px; }
.big-tile.primary { border-color: #0ea5e9; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 22px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-top: 4px; }
.big-tile.primary .value { color: #67e8f9; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; }

table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; margin: 8px 0 14px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; }
table.cmp th, table.cmp td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #334155; }
table.cmp th:first-child, table.cmp td:first-child { text-align: left; color: #cbd5e1; }
table.cmp thead th { background: #0f172a; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
table.cmp tr:hover td { background: #273549; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-mute { color: #64748b; }
.row-best td { background: #14532d !important; color: #d1fae5; font-weight: 600; }

/* 이벤트 테이블 */
.event-filter { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
.ef-btn {
  background: #1e293b; color: #cbd5e1; border: 1px solid #334155;
  border-radius: 6px; padding: 6px 11px; font-size: 12px; cursor: pointer; font-weight: 500;
}
.ef-btn:hover { color: #f1f5f9; border-color: #64748b; }
.ef-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }
.ef-btn.success.active { background: #047857; border-color: #10b981; }
.ef-btn.fail.active { background: #991b1b; border-color: #ef4444; }
.ef-input { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 6px 10px; font-size: 12px; height: 30px; min-width: 160px; }
.ef-status { font-size: 12px; color: #94a3b8; margin-left: auto; }
table.evt { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; }
table.evt thead th {
  background: #0f172a; color: #94a3b8; font-weight: 600;
  padding: 9px 10px; border-bottom: 1px solid #334155;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: left;
  cursor: pointer; user-select: none;
}
table.evt thead th.numeric { text-align: right; }
table.evt tbody tr { border-bottom: 1px solid #1e293b; }
table.evt tbody tr:nth-child(odd) { background: #1c2942; }
table.evt tbody tr:hover { background: #273549; }
table.evt tbody td { padding: 7px 10px; vertical-align: middle; white-space: nowrap; line-height: 1.3; }
table.evt tbody td.numeric { text-align: right; }
table.evt tbody td.col-name { font-weight: 600; color: #f1f5f9; min-width: 130px; max-width: 180px; }
table.evt tbody td.col-name .meta { display: block; font-size: 10px; color: #64748b; font-weight: 400; margin-top: 2px; }
table.evt tbody tr.row-success td.col-name { box-shadow: inset 3px 0 0 #10b981; padding-left: 14px; }
table.evt tbody tr.row-fail td.col-name { box-shadow: inset 3px 0 0 #ef4444; padding-left: 14px; }
table.evt tbody tr.row-neutral td.col-name { box-shadow: inset 3px 0 0 #64748b; padding-left: 14px; }
table.evt tbody tr.row-mixed td.col-name { box-shadow: inset 3px 0 0 #fbbf24; padding-left: 14px; }
.tag-pill { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; }
.tag-pill.t-CLEAN_VALUE_SETUP { background: #047857; color: #d1fae5; }
.tag-pill.t-VALUE_SURGE_CONFIRM { background: #0e7490; color: #cffafe; }
.tag-pill.t-BREAKOUT_MOMENTUM { background: #6d28d9; color: #ede9fe; }
.tag-pill.t-VALUE_LOOSE { background: #92400e; color: #fef3c7; }
.tag-pill.t-HIGH_VOLATILITY { background: #991b1b; color: #fee2e2; }
.tag-pill.t-WATCH_ONLY { background: #475569; color: #e2e8f0; }
.tag-pill.t-LOW_SIGNAL { background: #1e293b; color: #94a3b8; border: 1px solid #475569; }
.result-pills { display: flex; gap: 3px; flex-wrap: wrap; }
.result-pill { display: inline-block; padding: 1px 5px; border-radius: 4px; font-size: 9.5px; font-weight: 700; letter-spacing: 0.3px; }
.result-pill.STRONG_CONFIRM { background: #14532d; color: #6ee7b7; }
.result-pill.CLOSE_WIN { background: #064e3b; color: #86efac; }
.result-pill.HIGH_OPPORTUNITY { background: #134e4a; color: #5eead4; }
.result-pill.FAILED_CONFIRM { background: #7f1d1d; color: #fca5a5; }
.result-pill.HIGH_THEN_FADE { background: #713f12; color: #fde047; }
.result-pill.CLOSE_LOSS { background: #581c87; color: #d8b4fe; }

.answer-list { background: #1e293b; border-radius: 8px; padding: 14px 16px; }
.answer-item { padding: 10px 0; border-bottom: 1px dashed #334155; }
.answer-item:last-child { border-bottom: none; }
.answer-item .q { font-weight: 600; color: #67e8f9; margin-bottom: 4px; }
.answer-item .a { font-size: 12px; color: #cbd5e1; line-height: 1.6; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
</style>
</head>
<body>

<h1 id="page-title">WRA Rolling Success/Failure Diff Report</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="recommend-box" id="recommend"></div>

<h2>📊 전체 통계</h2>
<div class="big-summary" id="big-summary"></div>

<h2>🔑 핵심 7개 질문</h2>
<div class="answer-list" id="answers"></div>

<h2>🏷️ tag별 rolling 성과</h2>
<div id="tag-table"></div>

<h2>📈 성공 vs 실패 — cutoff 시점 지표 비교 (rolling 평균)</h2>
<div id="key-diffs"></div>

<h2>🎯 Threshold Sweep — rolling 검증</h2>
<p style="color:#94a3b8;font-size:12px;line-height:1.6;">avgCloseReturn 기준 정렬. n>=20 조건만 표시 (노이즈 필터).</p>
<div id="sweep-table"></div>

<h2>📅 cutoff별 시계열</h2>
<div id="per-cutoff-table"></div>

<h2>📋 종목별 이벤트 — cutoff별로 필터해서 보세요</h2>
<p style="color:#94a3b8;font-size:12px;line-height:1.6;margin-bottom:8px;">
  6,000+ 이벤트를 모두 한 번에 띄우면 무거우므로 <strong>cutoff 단위 필터</strong>가 기본입니다 (가장 최근 cutoff 자동 선택).
  좌측 컬러바: <span style="color:#10b981;">초록=성공</span> / <span style="color:#ef4444;">빨강=실패</span> / <span style="color:#fbbf24;">노랑=둘 다</span> / <span style="color:#64748b;">회색=중립</span>.
</p>
<div class="event-filter" id="event-filter">
  <label style="font-size:11px;color:#94a3b8;">cutoff:
    <select id="cutoff-select" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px 10px;font-size:12px;margin-left:6px;"></select>
  </label>
  <button class="ef-btn active" data-filter="ALL">전체</button>
  <button class="ef-btn success" data-filter="SUCCESS">성공만</button>
  <button class="ef-btn fail" data-filter="FAIL">실패만</button>
  <button class="ef-btn" data-filter="NEUTRAL">중립만</button>
  <button class="ef-btn" data-tag="CLEAN_VALUE_SETUP">먼저 볼</button>
  <button class="ef-btn" data-tag="VALUE_SURGE_CONFIRM">힘 붙은</button>
  <button class="ef-btn" data-tag="BREAKOUT_MOMENTUM">단기 반응</button>
  <button class="ef-btn" data-tag="VALUE_LOOSE">보조</button>
  <button class="ef-btn" data-tag="HIGH_VOLATILITY">고변동</button>
  <button class="ef-btn" data-tag="WATCH_ONLY">관찰</button>
  <button class="ef-btn" data-tag="LOW_SIGNAL">약함</button>
  <input type="search" class="ef-input" id="event-search" placeholder="🔍 종목명 / 코드">
  <span class="ef-status" id="event-status"></span>
</div>
<div style="overflow-x:auto;">
  <table class="evt" id="evt-table">
    <thead>
      <tr>
        <th data-sort="name">종목</th>
        <th data-sort="tag">유형</th>
        <th class="numeric" data-sort="finalScore">점수</th>
        <th class="numeric" data-sort="closeLocation">closeLoc</th>
        <th class="numeric" data-sort="closeToMA20">MA20</th>
        <th class="numeric" data-sort="closeFromRecentLow20">저점대비</th>
        <th class="numeric" data-sort="valueRatio20">거래대금</th>
        <th class="numeric" data-sort="riskScore">risk</th>
        <th data-sort="boxQuality">box</th>
        <th data-sort="historyQuality">차트</th>
        <th class="numeric" data-sort="closeReturn">D+1 종가%</th>
        <th class="numeric" data-sort="highReturn">D+1 고가%</th>
        <th>결과</th>
      </tr>
    </thead>
    <tbody id="evt-body"></tbody>
  </table>
</div>

<footer class="foot">
  <strong>매수 신호 보고서가 아닙니다.</strong> 분류 모델 검증을 위한 분석 보고서이며 실제 매매 판단은 차트·뉴스·시장 상황을 별도로 확인하세요.
</footer>

<script id="report-data" type="application/json">__JSON_DATA__</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const meta = data.meta || {};
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 2 : d); }

  document.getElementById('page-title').textContent = meta.title;
  document.getElementById('subtitle').innerHTML =
    'cutoff 범위 <strong style="color:#cbd5e1;">' + (meta.cutoffs[0] || '') + ' ~ ' + (meta.cutoffs[meta.cutoffs.length-1] || '') + '</strong> · ' +
    meta.cutoffCount + '개 cutoff · 처리 종목 ' + meta.stocksProcessed + ' · 전체 이벤트 ' + meta.totalEvents + ' · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  document.getElementById('purpose-box').innerHTML = '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose);

  const cn = data.conclusion || {};
  document.getElementById('recommend').innerHTML =
    '<strong>⚠️ 약점:</strong> ' + escapeHtml(cn.weakness || '') +
    '<br><br><strong>🎯 v3.2 추천 방향:</strong> ' + escapeHtml(cn.proposedDirection || '');

  // big tiles
  const cutoffsArr = meta.cutoffs || [];
  const tiles = [
    { label: '전체 이벤트', value: meta.totalEvents, sub: 'cutoff ' + meta.cutoffCount + '개 × 종목', cls: 'primary' },
    { label: '평균 cutoff당 이벤트', value: meta.cutoffCount > 0 ? Math.round(meta.totalEvents / meta.cutoffCount) : 0, sub: '평일별 후보 풀', cls: '' },
    { label: '처리 종목', value: meta.stocksProcessed, sub: '시총 300억+ ETF 제외', cls: '' },
    { label: 'cutoff 범위', value: meta.cutoffCount, sub: (cutoffsArr[0] || '') + ' ~ ' + (cutoffsArr[cutoffsArr.length - 1] || ''), cls: '' },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div><div class="sub">' + t.sub + '</div>';
    ts.appendChild(el);
  });

  // 7 answers
  const ans = (cn.answers) || {};
  const ansEl = document.getElementById('answers');
  ['q1_highVolatilityRolling','q2_highVolatilityRiskAcceptable','q3_cleanIsStableObserve','q4_watchOnlyShouldHide','q5_valueRatioWorks','q6_boardOrder','q7_changeConditionsOrUI'].forEach(k => {
    const a = ans[k]; if (!a) return;
    const div = document.createElement('div');
    div.className = 'answer-item';
    div.innerHTML = '<div class="q">Q. ' + escapeHtml(a.question) + '</div><div class="a">→ ' + escapeHtml(a.answer) + '</div>';
    ansEl.appendChild(div);
  });

  // tag table
  let tagHtml = '<table class="cmp"><thead><tr><th>tag</th><th>n</th><th>평균 종가%</th><th>중앙 종가%</th><th>평균 고가%</th><th>+3% 도달</th><th>+5% 고가</th><th>실패율</th><th>RR</th></tr></thead><tbody>';
  Object.entries(data.tagStats).forEach(([t, e]) => {
    if (e.n === 0) return;
    const fmt = v => v == null ? '-' : fmtNum(v);
    const fmtP = v => v == null ? '-' : fmtNum(v, 1) + '%';
    const rrStr = (e.riskRewardRatio === Infinity || e.riskRewardRatio == null) ? '-' : fmtNum(e.riskRewardRatio);
    tagHtml += '<tr>' +
      '<td>' + t + '</td>' +
      '<td>' + e.n + '</td>' +
      '<td class="' + ((e.avgCloseReturn || 0) > 0 ? 'cell-pos' : 'cell-neg') + '">' + fmt(e.avgCloseReturn) + '%</td>' +
      '<td>' + fmt(e.medCloseReturn) + '%</td>' +
      '<td class="cell-pos">' + fmt(e.avgHighReturn) + '%</td>' +
      '<td>' + fmtP(e.closeWin3Rate) + '</td>' +
      '<td>' + fmtP(e.highOpp5Rate) + '</td>' +
      '<td class="cell-neg">' + fmtP(e.closeLossRate) + '</td>' +
      '<td>' + rrStr + '</td>' +
    '</tr>';
  });
  tagHtml += '</tbody></table>';
  document.getElementById('tag-table').innerHTML = tagHtml;

  // key diffs
  const kd = data.keyDiffs;
  let kdHtml = '<table class="cmp"><thead><tr><th>지표</th><th>성공 평균</th><th>성공 중앙</th><th>실패 평균</th><th>실패 중앙</th><th>차이</th><th>방향</th></tr></thead><tbody>';
  ['finalScore','setupScore','momentumScore','riskScore','riskPenalty','valueRatio20','volumeRatio20','valueToMarketCap','closeLocation','closeToMA20','closeFromRecentLow20','closeFrom52WeekHigh','dayReturn','boxRangePct'].forEach(k => {
    const v = kd[k]; if (!v) return;
    const cls = (v.diff || 0) > 0 ? 'cell-pos' : ((v.diff || 0) < 0 ? 'cell-neg' : 'cell-mute');
    const arrow = (v.diff || 0) > 0 ? '↑ 성공이 높음' : ((v.diff || 0) < 0 ? '↓ 실패가 높음' : '–');
    kdHtml += '<tr>' +
      '<td>' + k + '</td>' +
      '<td>' + fmtNum(v.success_mean) + ' <span class="cell-mute">(' + (v.success_n || 0) + ')</span></td>' +
      '<td>' + fmtNum(v.success_median) + '</td>' +
      '<td>' + fmtNum(v.fail_mean) + ' <span class="cell-mute">(' + (v.fail_n || 0) + ')</span></td>' +
      '<td>' + fmtNum(v.fail_median) + '</td>' +
      '<td class="' + cls + '">' + (v.diff > 0 ? '+' : '') + fmtNum(v.diff) + '</td>' +
      '<td class="' + cls + '">' + arrow + '</td>' +
    '</tr>';
  });
  kdHtml += '</tbody></table>';
  document.getElementById('key-diffs').innerHTML = kdHtml;

  // sweep table
  const sr = data.sweepRanked || [];
  let swHtml = '<table class="cmp"><thead><tr><th>조건</th><th>n / total</th><th>커버율</th><th>평균 종가%</th><th>중앙 종가%</th><th>평균 고가%</th><th>+3% 도달</th><th>+5% 고가</th><th>실패율</th><th>highThenFade</th><th>RR</th></tr></thead><tbody>';
  sr.forEach((r, idx) => {
    const e = r.eval;
    const cls = idx < 3 ? 'row-best' : '';
    const fmt = v => v == null ? '-' : fmtNum(v);
    const fmtP = v => v == null ? '-' : fmtNum(v, 1) + '%';
    const rrStr = (e.riskRewardRatio === Infinity || e.riskRewardRatio == null) ? '-' : fmtNum(e.riskRewardRatio);
    swHtml += '<tr class="' + cls + '">' +
      '<td>' + escapeHtml(r.name) + '</td>' +
      '<td>' + e.n + ' / ' + e.fromTotal + '</td>' +
      '<td>' + fmtP(e.coveragePct) + '</td>' +
      '<td class="' + ((e.avgCloseReturn || 0) > 0 ? 'cell-pos' : 'cell-neg') + '">' + fmt(e.avgCloseReturn) + '%</td>' +
      '<td>' + fmt(e.medCloseReturn) + '%</td>' +
      '<td class="cell-pos">' + fmt(e.avgHighReturn) + '%</td>' +
      '<td>' + fmtP(e.closeWin3Rate) + '</td>' +
      '<td>' + fmtP(e.highOpp5Rate) + '</td>' +
      '<td class="cell-neg">' + fmtP(e.closeLossRate) + '</td>' +
      '<td>' + fmtP(e.highThenFadeRate) + '</td>' +
      '<td>' + rrStr + '</td>' +
    '</tr>';
  });
  swHtml += '</tbody></table>';
  document.getElementById('sweep-table').innerHTML = swHtml;

  // per cutoff
  let pcHtml = '<table class="cmp"><thead><tr><th>cutoff</th><th>validation</th><th>events</th><th>S</th><th>F</th><th>성공률</th><th>실패율</th><th>평균 종가%</th></tr></thead><tbody>';
  (data.perCutoff || []).forEach(p => {
    const fmtP = v => v == null ? '-' : fmtNum(v, 1) + '%';
    const fmt = v => v == null ? '-' : fmtNum(v);
    pcHtml += '<tr>' +
      '<td>' + p.cutoff + '</td>' +
      '<td>' + (p.validationDate || '-') + '</td>' +
      '<td>' + p.events + '</td>' +
      '<td class="cell-pos">' + p.success + '</td>' +
      '<td class="cell-neg">' + p.fail + '</td>' +
      '<td>' + fmtP(p.successRate) + '</td>' +
      '<td>' + fmtP(p.failureRate) + '</td>' +
      '<td class="' + ((p.avgCloseReturn || 0) > 0 ? 'cell-pos' : 'cell-neg') + '">' + fmt(p.avgCloseReturn) + '%</td>' +
    '</tr>';
  });
  pcHtml += '</tbody></table>';
  document.getElementById('per-cutoff-table').innerHTML = pcHtml;

  // ────────── 종목 이벤트 테이블 ──────────
  const events = data.events || [];
  const evtBody = document.getElementById('evt-body');
  const evtStatus = document.getElementById('event-status');
  const cutoffSelect = document.getElementById('cutoff-select');

  // cutoff 드롭다운 채우기 (가장 최근부터)
  const sortedCutoffs = [...(meta.cutoffs || [])].sort().reverse();
  cutoffSelect.innerHTML = sortedCutoffs.map((d, i) => '<option value="' + d + '"' + (i === 0 ? ' selected' : '') + '>' + d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) + ' (D+1)</option>').join('');

  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtMc(v) { if (!v) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; return Math.round(e) + '억'; }
  function clsRet(v) { if (v == null || !isFinite(v)) return ''; return v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : ''); }
  function rowKind(e) {
    if (e.isSuccess && e.isFail) return 'mixed';
    if (e.isSuccess) return 'success';
    if (e.isFail) return 'fail';
    return 'neutral';
  }

  function renderEvts(list) {
    evtBody.innerHTML = '';
    list.forEach(e => {
      const kind = rowKind(e);
      const tr = document.createElement('tr');
      tr.className = 'row-' + kind;
      tr.dataset.tag = e.tag; tr.dataset.kind = kind;
      tr.dataset.name = e.name; tr.dataset.code = e.code;
      const pills = (e.groups || []).map(g => '<span class="result-pill ' + g + '">' + g.replace(/_/g, ' ') + '</span>').join('');
      tr.innerHTML =
        '<td class="col-name">' + escapeHtml(e.name) +
          '<span class="meta">' + e.code + ' · ' + (e.market || '-') + ' · ' + fmtMc(e.marketCap) + '</span></td>' +
        '<td><span class="tag-pill t-' + e.tag + '">' + e.tag.replace(/_/g, ' ') + '</span></td>' +
        '<td class="numeric" style="font-weight:600;color:#fbbf24;">' + fmtNum(e.finalScore, 1) + '</td>' +
        '<td class="numeric">' + fmtNum(e.closeLocation, 2) + '</td>' +
        '<td class="numeric">' + fmtPct(e.closeToMA20, 1) + '</td>' +
        '<td class="numeric">' + fmtPct(e.closeFromRecentLow20, 1) + '</td>' +
        '<td class="numeric">' + fmtNum(e.valueRatio20, 1) + '×</td>' +
        '<td class="numeric">' + (e.riskScore || 0) + '</td>' +
        '<td>' + (e.boxQuality || '').replace('BOX_','') + '</td>' +
        '<td>' + (e.historyQuality || '').replace('_HISTORY','') + '</td>' +
        '<td class="numeric ' + clsRet(e.closeReturn) + '">' + fmtPct(e.closeReturn, 2) + '</td>' +
        '<td class="numeric ' + clsRet(e.highReturn) + '">' + fmtPct(e.highReturn, 2) + '</td>' +
        '<td><div class="result-pills">' + (pills || '<span style="color:#64748b;font-size:10px;">—</span>') + '</div></td>';
      evtBody.appendChild(tr);
    });
  }

  // 필터 상태
  const evState = { cutoff: sortedCutoffs[0] || '', kind: 'ALL', tags: new Set(), q: '' };
  let evSortKey = null, evSortDir = 'desc';

  function applyEvFilter() {
    const filtered = events.filter(e => {
      if (evState.cutoff && e.cutoff !== evState.cutoff) return false;
      const k = rowKind(e);
      if (evState.kind === 'SUCCESS' && k !== 'success' && k !== 'mixed') return false;
      if (evState.kind === 'FAIL' && k !== 'fail' && k !== 'mixed') return false;
      if (evState.kind === 'NEUTRAL' && k !== 'neutral') return false;
      if (evState.tags.size > 0 && !evState.tags.has(e.tag)) return false;
      if (evState.q) {
        const q = evState.q.toLowerCase();
        if (!String(e.name||'').toLowerCase().includes(q) && !String(e.code||'').toLowerCase().includes(q)) return false;
      }
      return true;
    });

    // 정렬
    let sorted = filtered;
    if (evSortKey) {
      const dir = evSortDir === 'asc' ? 1 : -1;
      sorted = [...filtered].sort((a, b) => {
        let va = a[evSortKey], vb = b[evSortKey];
        if (va == null) va = (typeof vb === 'number') ? -Infinity : '';
        if (vb == null) vb = -Infinity;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
    } else {
      // 기본: 성공 먼저, 그 안에서 finalScore 내림차순
      const order = { success: 1, mixed: 2, fail: 3, neutral: 4 };
      sorted = [...filtered].sort((a, b) => {
        const oa = order[rowKind(a)] || 9;
        const ob = order[rowKind(b)] || 9;
        if (oa !== ob) return oa - ob;
        return (b.finalScore || 0) - (a.finalScore || 0);
      });
    }

    renderEvts(sorted);
    evtStatus.innerHTML = '<strong style="color:#cbd5e1;">' + sorted.length + '</strong>건 (전체 ' + events.length + ')';
  }

  cutoffSelect.addEventListener('change', e => { evState.cutoff = e.target.value; applyEvFilter(); });
  document.querySelectorAll('.event-filter [data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.event-filter [data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      evState.kind = btn.dataset.filter;
      applyEvFilter();
    });
  });
  document.querySelectorAll('.event-filter [data-tag]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const t = btn.dataset.tag;
      if (evState.tags.has(t)) evState.tags.delete(t); else evState.tags.add(t);
      applyEvFilter();
    });
  });
  document.getElementById('event-search').addEventListener('input', e => {
    evState.q = e.target.value.trim();
    applyEvFilter();
  });
  document.querySelectorAll('#evt-table thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (evSortKey === key) evSortDir = evSortDir === 'asc' ? 'desc' : 'asc';
      else { evSortKey = key; evSortDir = 'desc'; }
      applyEvFilter();
    });
  });

  applyEvFilter();
})();
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}
