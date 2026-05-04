#!/usr/bin/env node
/**
 * BMS Pattern Summary Report
 *
 * 목적:
 *   bms-winner-quality-filter-result.json의 A/B 등급 정상 상승 사례를 분석해
 *   현재 종목 후보 탐색에서 사용할 BMS 기준값(suggestedRules)을 자동 도출.
 *
 *   현재 후보 탐색은 하지 않음. 이번 파일은 오직 "공통 조건 요약".
 *
 * 입력:
 *   reports/bms-winner-quality-filter-result.json
 *
 * 출력:
 *   reports/bms-pattern-summary-result.json
 *   reports/bms-pattern-summary-result.html
 *
 * 분석 기본: A+B 합산. 별도 그룹별 (A only / B only) 비교 포함.
 * 화면 용어는 초보자용으로 통일.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const INPUT_PATH = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-pattern-summary-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-pattern-summary-result.html');

// ─────────────────────── 통계 헬퍼 ───────────────────────

function round(v, d) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function pct(num, den) { if (!den || den === 0) return null; return round(num / den * 100, 2); }
function quantile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return null;
  const idx = Math.max(0, Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p)));
  return sortedArr[idx];
}
function summarize(arr) {
  const v = arr.filter(x => x != null && isFinite(x)).map(Number);
  if (v.length === 0) return { n: 0, mean: null, median: null, q1: null, q3: null, min: null, max: null };
  const sorted = [...v].sort((a, b) => a - b);
  const sum = v.reduce((s, x) => s + x, 0);
  return {
    n: v.length,
    mean: round(sum / v.length, 2),
    median: round(quantile(sorted, 0.5), 2),
    q1: round(quantile(sorted, 0.25), 2),
    q3: round(quantile(sorted, 0.75), 2),
    p10: round(quantile(sorted, 0.1), 2),
    p90: round(quantile(sorted, 0.9), 2),
    min: round(sorted[0], 2),
    max: round(sorted[sorted.length - 1], 2),
  };
}
function bucketize(arr, ranges) {
  // ranges: [[min, max, label], ...]  (max는 미만/초과 처리에 따라; 여기선 [min, max) 단위)
  const out = ranges.map(r => ({ label: r[2], min: r[0], max: r[1], count: 0 }));
  arr.forEach(v => {
    if (v == null || !isFinite(v)) return;
    for (const b of out) {
      if (v >= b.min && (b.max == null || v < b.max)) { b.count++; break; }
    }
  });
  const total = out.reduce((s, b) => s + b.count, 0);
  out.forEach(b => { b.ratio = pct(b.count, total); });
  return out;
}
function ratioWhere(arr, pred) {
  const total = arr.length;
  if (total === 0) return null;
  const cnt = arr.filter(pred).length;
  return { count: cnt, total, ratio: pct(cnt, total) };
}

// ─────────────────────── 그룹별 분석 ───────────────────────

function pickField(w, path) {
  const parts = path.split('.');
  let v = w;
  for (const p of parts) v = v?.[p];
  return v;
}

function analyzeGroup(winners) {
  if (winners.length === 0) {
    return { count: 0 };
  }

  const get = (path) => winners.map(w => pickField(w, path));

  // 1. 상승률 ─────────
  const highReturns = get('maxHighReturn');
  const closeReturns = get('maxCloseReturn');
  const returnDistribution = bucketize(highReturns, [
    [40, 50, '+40~50%'],
    [50, 70, '+50~70%'],
    [70, 100, '+70~100%'],
    [100, null, '+100% 이상'],
  ]);

  // 2. 도달 소요 ─────────
  const days = get('daysToPeak');
  const durationDistribution = bucketize(days, [
    [3, 6, '3~5일'],
    [6, 11, '6~10일'],
    [11, 16, '11~15일'],
  ]);

  // 3. 상승 전 들어온 돈 ─────────
  const preAccumulation = summarize(get('analysis.preAccumulation.accumulatedValueRatio'));
  const preDays = summarize(get('analysis.preAccumulation.days'));

  // 4. 상승 시작일 거래대금 ─────────
  const startDayRatio = summarize(get('analysis.preAccumulation.startDayValueRatio'));
  const valueSpike = summarize(get('analysis.preAccumulation.valueSpikeRatio'));

  // 5. 상승 중 거래대금 ─────────
  const runAccum = summarize(get('analysis.runAnalysis.accumulatedValueRatio'));
  const runMaxValueRatio = summarize(get('analysis.runAnalysis.maxValueRatio'));
  const runSpikeAvgRatio = summarize(get('analysis.runAnalysis.spikeAvgRatio'));
  const runSpikeDaysRatio = summarize(get('analysis.runAnalysis.spikeDaysRatio'));

  // 6. 박스권 ─────────
  const boxDays = summarize(get('analysis.boxAnalysis.boxRangeDays'));
  const boxRange = summarize(get('analysis.boxAnalysis.boxRangePct'));
  const breakoutValueRatio = summarize(get('analysis.boxAnalysis.breakoutValueRatio'));
  const lowRising = ratioWhere(winners, w => pickField(w, 'analysis.boxAnalysis.lowRising') === true);
  const touchedHighMulti = ratioWhere(winners, w => (pickField(w, 'analysis.boxAnalysis.touchedHighTimes') || 0) >= 3);
  const valueIncreasingInBox = ratioWhere(winners, w => pickField(w, 'analysis.boxAnalysis.valueTrendInBox') === 'INCREASING');

  // 7. 이평선 ─────────
  const aboveMa20 = ratioWhere(winners, w => pickField(w, 'analysis.movingAverage.aboveMa20') === true);
  const aboveMa60 = ratioWhere(winners, w => pickField(w, 'analysis.movingAverage.aboveMa60') === true);
  const aboveMa120 = ratioWhere(winners, w => pickField(w, 'analysis.movingAverage.aboveMa120') === true);
  const ma20AboveMa60Below = ratioWhere(winners, w => {
    const a = pickField(w, 'analysis.movingAverage.aboveMa20');
    const b = pickField(w, 'analysis.movingAverage.aboveMa60');
    return a === true && b === false;
  });
  const bothBelowMa20Ma60 = ratioWhere(winners, w => {
    const a = pickField(w, 'analysis.movingAverage.aboveMa20');
    const b = pickField(w, 'analysis.movingAverage.aboveMa60');
    return a === false && b === false;
  });
  const fullBull = ratioWhere(winners, w => pickField(w, 'analysis.movingAverage.arrangement') === 'FULL_BULL');
  const shortRecovery = ratioWhere(winners, w => pickField(w, 'analysis.movingAverage.arrangement') === 'SHORT_RECOVERY');

  // 8. 가격 위치 ─────────
  const closeFromLow60 = summarize(get('analysis.pricePosition.closeFromLow60'));
  const closeFromLow120 = summarize(get('analysis.pricePosition.closeFromLow120'));
  const closeFromHigh60 = summarize(get('analysis.pricePosition.closeFromHigh60'));
  const closeFromHigh120 = summarize(get('analysis.pricePosition.closeFromHigh120'));
  const closeFrom52WeekHigh = summarize(get('analysis.pricePosition.closeFrom52WeekHigh'));
  const closeFromBoxLow = summarize(get('analysis.pricePosition.closeFromBoxLow'));
  const closeFromBoxHigh = summarize(get('analysis.pricePosition.closeFromBoxHigh'));

  // 9. 위쪽 매물 부담 ─────────
  const supplyAbove = summarize(get('analysis.supplyZone.aboveCloseRatio'));
  const supplyDistribution = bucketize(get('analysis.supplyZone.aboveCloseRatio'), [
    [0, 30, '0~30% (위 매물 적음)'],
    [30, 60, '30~60% (보통)'],
    [60, null, '60% 이상 (무거움)'],
  ]);

  // 10. 상승 후 식는 모습 ─────────
  const drawdownClose = summarize(get('analysis.postAnalysis.drawdownFromPeakClose'));
  const drawdownLow = summarize(get('analysis.postAnalysis.drawdownFromPeakLow'));
  const downCandleValueRatio = summarize(get('analysis.postAnalysis.downCandleValueRatio'));
  const postValueVsRun = summarize(get('analysis.postAnalysis.avgValueVsRun'));
  const postValueLargerThanRun = ratioWhere(winners, w => {
    const r = pickField(w, 'analysis.postAnalysis.avgValueVsRun');
    return r != null && r > 1;
  });

  return {
    count: winners.length,
    return: { highReturn: summarize(highReturns), closeReturn: summarize(closeReturns), distribution: returnDistribution },
    duration: { days: summarize(days), distribution: durationDistribution },
    preAccumulation: { ratio: preAccumulation, days: preDays },
    startDay: { ratio: startDayRatio, valueSpike },
    runValue: {
      accumulatedRatio: runAccum,
      maxValueRatio: runMaxValueRatio,
      spikeAvgRatio: runSpikeAvgRatio,
      spikeDaysRatio: runSpikeDaysRatio,
    },
    box: {
      days: boxDays, rangePct: boxRange, breakoutValueRatio,
      lowRisingRatio: lowRising,
      touchedHighMultiRatio: touchedHighMulti,
      valueIncreasingRatio: valueIncreasingInBox,
    },
    movingAverage: {
      aboveMa20, aboveMa60, aboveMa120,
      ma20AboveMa60Below, bothBelowMa20Ma60,
      fullBull, shortRecovery,
    },
    pricePosition: {
      closeFromLow60, closeFromLow120,
      closeFromHigh60, closeFromHigh120, closeFrom52WeekHigh,
      closeFromBoxLow, closeFromBoxHigh,
    },
    supplyZone: { aboveCloseRatio: supplyAbove, distribution: supplyDistribution },
    postPeak: {
      drawdownClose, drawdownLow,
      downCandleValueRatio,
      postValueVsRun,
      postValueLargerThanRunRatio: postValueLargerThanRun,
    },
  };
}

// ─────────────────────── 기준값(suggestedRules) 자동 도출 ───────────────────────

function buildSuggestedRules(ab) {
  // ab = analyzeGroup(A+B)
  // 기준값 = q1/q3 등 분포 기반. 너무 엄격하지 않게.
  function guard(v, fb) { return v != null && isFinite(v) ? v : fb; }

  const pa = ab.preAccumulation.ratio;
  const sd = ab.startDay.ratio;
  const vs = ab.startDay.valueSpike;
  const bx = ab.box.rangePct;
  const lf = ab.pricePosition.closeFromLow60;
  const hf = ab.pricePosition.closeFromHigh60;
  const sa = ab.supplyZone.aboveCloseRatio;
  const bd = ab.box.days;
  const bv = ab.box.breakoutValueRatio;

  return {
    preAccumulationRatio: {
      label: '시총 대비 상승 전 들어온 돈',
      unit: '%',
      min: guard(pa.p10, 3),                      // 하위 10% 컷오프
      idealMin: guard(pa.q1, 5),
      idealMax: guard(pa.q3, 80),
      median: pa.median,
    },
    startDayValueRatio: {
      label: '시총 대비 상승 시작일 거래대금',
      unit: '%',
      min: guard(sd.p10, 0.3),
      idealMin: guard(sd.q1, 0.5),
      median: sd.median,
    },
    valueSpikeRatio: {
      label: '평소보다 거래가 늘어난 정도',
      unit: '배',
      min: guard(vs.p10, 0.8),
      idealMin: guard(vs.q1, 1.0),
      idealMax: guard(vs.q3, 3.0),
      median: vs.median,
    },
    boxRangePct: {
      label: '박스권 폭',
      unit: '%',
      min: guard(bx.p10, 8),
      idealMin: guard(bx.q1, 10),
      idealMax: guard(bx.q3, 30),
      max: 35,
      median: bx.median,
    },
    boxDays: {
      label: '박스권 기간',
      unit: '일',
      min: guard(bd.p10, 8),
      idealMin: guard(bd.q1, 10),
      idealMax: guard(bd.q3, 20),
      median: bd.median,
    },
    breakoutValueRatio: {
      label: '돌파일 거래대금 (박스 평균 대비)',
      unit: '배',
      idealMin: guard(bv.q1, 1.0),
      idealMax: guard(bv.q3, 2.5),
      median: bv.median,
    },
    closeFromLow60: {
      label: '60일 저점 대비 위치',
      unit: '%',
      min: 5,
      idealMin: guard(lf.q1, 10),
      idealMax: guard(lf.q3, 50),
      max: 80,
      median: lf.median,
    },
    closeFromHigh60: {
      label: '60일 고점 대비 위치',
      unit: '%',
      idealMin: guard(hf.q1, -40),
      idealMax: guard(hf.q3, -5),
      median: hf.median,
    },
    supplyAboveRatio: {
      label: '위쪽 매물 부담',
      unit: '%',
      idealMax: guard(sa.q1, 40),                 // 적을수록 좋음 → q1을 idealMax로 (대신 너무 빡빡하면 풀어줌)
      tolerantMax: guard(sa.median, 60),
      max: 85,
      median: sa.median,
    },
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Pattern Summary Report');
  console.log('═'.repeat(80));

  if (!fs.existsSync(INPUT_PATH)) {
    console.error('입력 없음:', INPUT_PATH);
    console.error('먼저 `node bms-winner-quality-filter-report.js` 실행 필요');
    process.exit(1);
  }

  const src = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const cleanWinners = src.cleanWinners || [];
  const aWinners = cleanWinners.filter(w => w._grade === 'A');
  const bWinners = cleanWinners.filter(w => w._grade === 'B');
  const abWinners = cleanWinners.filter(w => w._grade === 'A' || w._grade === 'B');
  console.log(`정상 사례: 총 ${cleanWinners.length}건 (A=${aWinners.length} / B=${bWinners.length})`);

  if (abWinners.length === 0) {
    console.error('A+B 등급 사례가 없습니다. 품질 필터 결과를 확인하세요.');
    process.exit(1);
  }

  const ab = analyzeGroup(abWinners);
  const aOnly = analyzeGroup(aWinners);
  const bOnly = analyzeGroup(bWinners);
  const suggestedRules = buildSuggestedRules(ab);

  // 등급별 비교 (요약값만)
  function brief(g) {
    if (g.count === 0) return { count: 0 };
    return {
      count: g.count,
      avgHighReturn: g.return.highReturn.mean,
      avgDaysToPeak: g.duration.days.mean,
      avgPreAccum: g.preAccumulation.ratio.mean,
      avgStartDay: g.startDay.ratio.mean,
      avgValueSpike: g.startDay.valueSpike.mean,
      avgBoxDays: g.box.days.mean,
      avgBoxRange: g.box.rangePct.mean,
      avgBreakoutSpike: g.box.breakoutValueRatio.mean,
      avgSupplyAbove: g.supplyZone.aboveCloseRatio.mean,
      avgCloseFromLow60: g.pricePosition.closeFromLow60.mean,
      avgCloseFromHigh60: g.pricePosition.closeFromHigh60.mean,
      aboveMa20Ratio: g.movingAverage.aboveMa20?.ratio,
      aboveMa60Ratio: g.movingAverage.aboveMa60?.ratio,
      shortRecoveryRatio: g.movingAverage.shortRecovery?.ratio,
    };
  }
  const gradeCompare = { A: brief(aOnly), B: brief(bOnly), AB: brief(ab) };

  // 콘솔 요약
  console.log('\n📊 A+B 통합 (n=' + ab.count + ')');
  console.log(`  평균 상승률(고가): ${ab.return.highReturn.mean}%, 중앙값 ${ab.return.highReturn.median}%`);
  console.log(`  평균 도달 소요: ${ab.duration.days.mean}일, 중앙값 ${ab.duration.days.median}일`);
  console.log(`  시총 대비 들어온 돈: 평균 ${ab.preAccumulation.ratio.mean}%, 중앙 ${ab.preAccumulation.ratio.median}%, Q1=${ab.preAccumulation.ratio.q1}, Q3=${ab.preAccumulation.ratio.q3}`);
  console.log(`  시총 대비 시작일 거래대금: 평균 ${ab.startDay.ratio.mean}%, 중앙 ${ab.startDay.ratio.median}%`);
  console.log(`  거래대금 spike: 평균 ${ab.startDay.valueSpike.mean}배, 중앙 ${ab.startDay.valueSpike.median}배`);
  console.log(`  박스권 폭: 평균 ${ab.box.rangePct.mean}%, 중앙 ${ab.box.rangePct.median}%`);
  console.log(`  60일 저점 대비: 평균 ${ab.pricePosition.closeFromLow60.mean}%, 중앙 ${ab.pricePosition.closeFromLow60.median}%`);
  console.log(`  60일 고점 대비: 평균 ${ab.pricePosition.closeFromHigh60.mean}%, 중앙 ${ab.pricePosition.closeFromHigh60.median}%`);
  console.log(`  위쪽 매물 부담: 평균 ${ab.supplyZone.aboveCloseRatio.mean}%, 중앙 ${ab.supplyZone.aboveCloseRatio.median}%`);
  console.log(`  20일선 위 시작 비율: ${ab.movingAverage.aboveMa20?.ratio}%`);
  console.log(`  60일선 위 시작 비율: ${ab.movingAverage.aboveMa60?.ratio}%`);
  console.log(`  단기선만 회복 비율: ${ab.movingAverage.shortRecovery?.ratio}%`);

  console.log('\n🎯 제안된 BMS 기준값 (suggestedRules):');
  Object.entries(suggestedRules).forEach(([k, v]) => {
    console.log(`  ${v.label}: ${JSON.stringify(v)}`);
  });

  // 출력
  const out = {
    meta: {
      version: 'bms-pattern-summary-v1',
      generatedAt: new Date().toISOString(),
      title: 'BMS 학습용 정상 상승 사례 공통 조건 요약',
      purpose: 'A/B 등급 정상 상승 사례의 공통 조건을 정리하고, 다음 단계 (현재 후보 탐색) 의 기준값을 자동 제안',
      nextStep: '다음 단계: A/B 등급 공통 조건과 비슷한 준비 구간에 있는 현재 종목을 찾는 bms-current-similarity-scan.js (미작성)',
      inputFile: 'reports/bms-winner-quality-filter-result.json',
    },
    config: src.config,
    summary: {
      sourceCleanCount: cleanWinners.length,
      aCount: aWinners.length,
      bCount: bWinners.length,
      abCount: abWinners.length,
    },
    gradeCompare,
    returnDistribution: ab.return.distribution,
    durationDistribution: ab.duration.distribution,
    preAccumulationSummary: ab.preAccumulation,
    startDaySummary: ab.startDay,
    runValueSummary: ab.runValue,
    boxSummary: ab.box,
    movingAverageSummary: ab.movingAverage,
    pricePositionSummary: ab.pricePosition,
    supplyZoneSummary: ab.supplyZone,
    postPeakSummary: ab.postPeak,
    suggestedRules,
    detailA: aOnly,
    detailB: bOnly,
    detailAB: ab,
    examples: {
      A: aWinners.slice(0, 5).map(briefExample),
      B: bWinners.slice(0, 5).map(briefExample),
    },
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length/1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length/1024).toFixed(0)}KB)`);
}

function briefExample(w) {
  return {
    code: w.code, name: w.name, market: w.market,
    startDate: w.startDate, peakDate: w.peakDate,
    daysToPeak: w.daysToPeak,
    maxHighReturn: w.maxHighReturn,
    maxCloseReturn: w.maxCloseReturn,
    preAccumRatio: w.analysis?.preAccumulation?.accumulatedValueRatio,
    startDayRatio: w.analysis?.preAccumulation?.startDayValueRatio,
    valueSpikeRatio: w.analysis?.preAccumulation?.valueSpikeRatio,
    boxDays: w.analysis?.boxAnalysis?.boxRangeDays,
    boxRange: w.analysis?.boxAnalysis?.boxRangePct,
    breakoutValueRatio: w.analysis?.boxAnalysis?.breakoutValueRatio,
    closeFromLow60: w.analysis?.pricePosition?.closeFromLow60,
    closeFromHigh60: w.analysis?.pricePosition?.closeFromHigh60,
    supplyAbove: w.analysis?.supplyZone?.aboveCloseRatio,
    arrangement: w.analysis?.movingAverage?.arrangement,
  };
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>BMS 정상 상승 사례 공통 조건 요약</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1300px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
  -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 14px 0 8px; color: #94a3b8; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }
.next-step-box { background: #1e3a5f; border: 1px solid #3b82f6; padding: 10px 14px; border-radius: 6px; font-size: 12px; color: #dbeafe; margin-bottom: 14px; line-height: 1.6; }

/* 큰 타일 */
.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile.primary { border-left: 4px solid #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 18px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-top: 3px; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; }

/* 섹션 카드 */
.section-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 14px 18px; margin: 10px 0 14px; }
.section-card h3 { margin: 0 0 10px; color: #67e8f9; }
.section-card .desc { color: #94a3b8; font-size: 12px; margin-bottom: 10px; line-height: 1.6; }

/* kv */
.kv { display: grid; grid-template-columns: 1fr auto; gap: 4px 14px; font-size: 13px; line-height: 1.7; }
.kv .k { color: #cbd5e1; }
.kv .v { color: #67e8f9; font-variant-numeric: tabular-nums; font-weight: 600; }

/* 분포 표 */
table.dist { width: 100%; border-collapse: collapse; font-size: 12px; background: #0f172a; border-radius: 6px; overflow: hidden; font-variant-numeric: tabular-nums; }
table.dist thead th { padding: 7px 10px; background: #0c1729; color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; border-bottom: 1px solid #334155; text-align: left; }
table.dist thead th.numeric { text-align: right; }
table.dist tbody td { padding: 6px 10px; border-bottom: 1px solid #1e293b; }
table.dist tbody td.numeric { text-align: right; color: #cbd5e1; }
table.dist tbody td.bar { padding: 0; }
.bar-fill { display: block; height: 18px; background: #38bdf8; border-radius: 3px; }

/* 등급 비교 표 */
table.compare { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; }
table.compare th, table.compare td { padding: 8px 12px; border-bottom: 1px solid #334155; text-align: right; }
table.compare th:first-child, table.compare td:first-child { text-align: left; color: #cbd5e1; }
table.compare thead th { background: #0f172a; color: #94a3b8; font-size: 11px; text-transform: uppercase; }
.col-a { color: #6ee7b7; }
.col-b { color: #93c5fd; }
.col-ab { color: #fde047; }

/* 제안 기준값 박스 */
.rules-box { background: #14532d; border: 2px solid #10b981; border-radius: 10px; padding: 16px 20px; margin: 14px 0; }
.rules-box h3 { color: #6ee7b7; margin: 0 0 10px; }
.rules-box .rule { background: #064e3b; padding: 10px 14px; border-radius: 6px; margin: 8px 0; font-size: 13px; line-height: 1.6; color: #d1fae5; }
.rules-box .rule .name { font-weight: 700; color: #6ee7b7; display: block; margin-bottom: 3px; }
.rules-box .rule .vals { color: #86efac; font-variant-numeric: tabular-nums; }
.rules-box .rule .median { color: #94a3b8; font-size: 11px; margin-left: 6px; }

/* 예시 종목 */
.examples-box { background: #0c1729; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; }
.examples-box .ex-row { display: grid; grid-template-columns: 1fr auto auto auto auto; gap: 10px; padding: 5px 0; border-bottom: 1px dashed #334155; font-size: 12px; }
.examples-box .ex-row:last-child { border-bottom: none; }
.examples-box .ex-row .name { font-weight: 600; color: #f1f5f9; }
.examples-box .ex-row .meta { color: #64748b; font-size: 11px; }
.examples-box .ex-row .ret { color: #6ee7b7; font-weight: 700; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  table.compare, table.dist { font-size: 11px; }
}
</style>
</head>
<body>

<h1 id="page-title">BMS 정상 상승 사례 공통 조건 요약</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 이 보고서는 <em>과거 정상 상승 사례들의 공통 조건</em>을 정리한 분석 보고서입니다.
  현재 종목 후보 탐색은 이 보고서에서 제안한 기준값을 사용하는 별도 파일에서 진행합니다.
</div>

<div class="next-step-box" id="next-step-box"></div>

<h2>📊 분석 대상 요약</h2>
<div class="big-summary" id="big-summary"></div>

<h2>🏆 BMS가 배울 상승 사례 요약</h2>
<div class="section-card">
  <h3>① 상승률</h3>
  <div class="kv" id="return-kv"></div>
  <h3 style="margin-top:14px;">상승률 분포</h3>
  <table class="dist" id="return-dist"></table>
</div>

<div class="section-card">
  <h3>② 상승까지 걸린 기간</h3>
  <div class="kv" id="duration-kv"></div>
  <table class="dist" id="duration-dist" style="margin-top:10px;"></table>
</div>

<h2>🔬 상승 전 준비 구간 공통점</h2>
<div class="section-card">
  <h3>③ 상승 전 들어온 돈 (시총 대비)</h3>
  <div class="kv" id="preaccum-kv"></div>
  <p class="desc" style="margin-top:8px;">상승 시작 직전 20거래일 동안 누적된 거래대금이 시가총액 대비 몇 %였는지입니다. 클수록 상승 전 자금이 많이 모였다는 뜻.</p>
</div>

<div class="section-card">
  <h3>④ 상승 시작일에 들어온 돈</h3>
  <div class="kv" id="startday-kv"></div>
  <p class="desc" style="margin-top:8px;">"평소보다 거래가 늘어난 정도" = 시작일 거래대금 / 직전 평균. 1배보다 크면 평소보다 많이 들어왔다는 뜻.</p>
</div>

<div class="section-card">
  <h3>⑤ 오르는 동안 들어온 돈</h3>
  <div class="kv" id="runvalue-kv"></div>
  <p class="desc" style="margin-top:8px;">상승 구간 안에서 거래대금이 한 번만 튀고 끝났는지, 며칠간 이어졌는지를 함께 봅니다.</p>
</div>

<h2>📦 박스권 공통점</h2>
<div class="section-card">
  <h3>⑥ 상승 전 박스권</h3>
  <div class="kv" id="box-kv"></div>
  <p class="desc" style="margin-top:8px;">박스권은 상승 직전 좁은 가격대에서 횡보하며 힘을 모은 기간입니다. 폭이 좁고 하단이 올라가는 모양이 좋은 모습.</p>
</div>

<h2>📈 이평선 / 가격 위치 공통점</h2>
<div class="section-card">
  <h3>⑦ 이평선 위치</h3>
  <div class="kv" id="ma-kv"></div>
  <p class="desc" style="margin-top:8px;">상승 시작점이 이평선 위였는지 아래였는지. <strong>20일선 위에서 시작한 비율</strong>이 의외로 낮으면, 상승 종목은 이미 빠진 자리에서 출발한다는 뜻.</p>
</div>

<div class="section-card">
  <h3>⑧ 가격 위치</h3>
  <div class="kv" id="pp-kv"></div>
  <p class="desc" style="margin-top:8px;">최근 60일 저점·고점, 52주 고점 대비 시작점이 어디였는지. 너무 많이 오른 뒤가 아니라 박스권 중하단에서 시작하는 패턴이 자주 보입니다.</p>
</div>

<h2>🧱 위쪽 매물 부담 공통점</h2>
<div class="section-card">
  <h3>⑨ 위쪽 매물</h3>
  <div class="kv" id="supply-kv"></div>
  <h3 style="margin-top:14px;">위쪽 매물 부담 분포</h3>
  <table class="dist" id="supply-dist"></table>
  <p class="desc" style="margin-top:8px;">현재가보다 위쪽에 누적된 거래량 비율. 높을수록 위에 매물이 많다는 뜻이지만, 정상 상승 사례 평균이 의외로 높을 수 있습니다.</p>
</div>

<h2>📉 상승 후 식는 모습</h2>
<div class="section-card">
  <h3>⑩ 고점 이후 변화</h3>
  <div class="kv" id="postpeak-kv"></div>
  <p class="desc" style="margin-top:8px;">+40% 도달 후 최대 10거래일 추적. 고점 이후 거래대금이 더 커지면 매물이 쏟아진 것이고, 줄어들면 식는 모습.</p>
</div>

<h2>🎯 현재 후보 탐색용 기준값 제안 (suggestedRules)</h2>
<div class="rules-box" id="rules-box"></div>

<h2>⚖️ A등급 / B등급 / 통합 비교</h2>
<div style="overflow-x:auto;">
  <table class="compare" id="compare-table"></table>
</div>

<h2>👀 예시 종목</h2>
<h3>A등급 상위 5개</h3>
<div class="examples-box" id="examples-a"></div>
<h3>B등급 상위 5개</h3>
<div class="examples-box" id="examples-b"></div>

<footer class="foot">
  <strong>다음 단계 예고:</strong> 위 <em>현재 후보 탐색용 기준값</em>을 사용해 현재 종목 중 비슷한 준비 구간에 있는 종목을 찾는 bms-current-similarity-scan.js를 별도 파일로 만듭니다.
</footer>

<script id="report-data" type="application/json">__JSON_DATA__</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const meta = data.meta || {};
  const summary = data.summary || {};
  const ab = data.detailAB || {};
  const a = data.detailA || {};
  const b = data.detailB || {};

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d); }
  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtPctRaw(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtX(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d) + '배'; }
  function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }
  function statStr(s, unit) {
    if (!s || s.n === 0) return '-';
    const u = unit || '';
    return '평균 ' + fmtNum(s.mean) + u + ' / 중앙 ' + fmtNum(s.median) + u + ' / Q1=' + fmtNum(s.q1) + u + ' / Q3=' + fmtNum(s.q3) + u;
  }

  document.getElementById('subtitle').innerHTML =
    'A등급 ' + summary.aCount + '건 + B등급 ' + summary.bCount + '건 = 합산 ' + summary.abCount + '건 분석 · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>입력:</strong> <code style="background:#0f172a;padding:1px 5px;border-radius:3px;color:#67e8f9;">' + meta.inputFile + '</code>';
  document.getElementById('next-step-box').innerHTML =
    '<strong>📌 다음 단계:</strong> ' + escapeHtml(meta.nextStep);

  // big tiles
  const tiles = [
    { label: '분석 대상 사례', value: summary.abCount + '건', sub: 'A+B 등급 합산', cls: 'primary' },
    { label: 'A등급', value: summary.aCount + '건', sub: '가장 참고하기 좋은' },
    { label: 'B등급', value: summary.bCount + '건', sub: '참고 가능' },
    { label: '평균 상승률', value: fmtPctRaw(ab.return?.highReturn?.mean), sub: '중앙 ' + fmtPctRaw(ab.return?.highReturn?.median) },
    { label: '평균 도달 소요', value: fmtNum(ab.duration?.days?.mean, 1) + '거래일', sub: '중앙 ' + fmtNum(ab.duration?.days?.median, 1) + '일' },
    { label: '평균 시총 대비 들어온 돈', value: fmtPctRaw(ab.preAccumulation?.ratio?.mean), sub: '중앙 ' + fmtPctRaw(ab.preAccumulation?.ratio?.median) },
    { label: '평균 박스권 폭', value: fmtPctRaw(ab.box?.rangePct?.mean), sub: '중앙 ' + fmtPctRaw(ab.box?.rangePct?.median) },
    { label: '평균 거래대금 spike', value: fmtX(ab.startDay?.valueSpike?.mean), sub: '중앙 ' + fmtX(ab.startDay?.valueSpike?.median) },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div>' + (t.sub ? '<div class="sub">' + t.sub + '</div>' : '');
    ts.appendChild(el);
  });

  // ① 상승률
  const r = ab.return || {};
  document.getElementById('return-kv').innerHTML =
    kv('평균 상승률 (고가)', fmtPctRaw(r.highReturn?.mean)) +
    kv('중앙값 상승률 (고가)', fmtPctRaw(r.highReturn?.median)) +
    kv('Q1 / Q3 (고가)', fmtPctRaw(r.highReturn?.q1) + ' / ' + fmtPctRaw(r.highReturn?.q3)) +
    kv('평균 상승률 (종가)', fmtPctRaw(r.closeReturn?.mean)) +
    kv('중앙값 상승률 (종가)', fmtPctRaw(r.closeReturn?.median));
  renderDist('return-dist', r.distribution || []);

  // ② 도달 소요
  const dur = ab.duration || {};
  document.getElementById('duration-kv').innerHTML =
    kv('평균 도달 소요', fmtNum(dur.days?.mean, 1) + '일') +
    kv('중앙값 도달 소요', fmtNum(dur.days?.median, 1) + '일') +
    kv('Q1 / Q3', fmtNum(dur.days?.q1, 1) + '일 / ' + fmtNum(dur.days?.q3, 1) + '일');
  renderDist('duration-dist', dur.distribution || []);

  // ③ 상승 전 들어온 돈
  const pa = ab.preAccumulation || {};
  document.getElementById('preaccum-kv').innerHTML =
    kv('평균', fmtPctRaw(pa.ratio?.mean)) +
    kv('중앙값', fmtPctRaw(pa.ratio?.median)) +
    kv('Q1', fmtPctRaw(pa.ratio?.q1)) +
    kv('Q3', fmtPctRaw(pa.ratio?.q3)) +
    kv('하위 10% 컷', fmtPctRaw(pa.ratio?.p10)) +
    kv('상위 10% 컷', fmtPctRaw(pa.ratio?.p90)) +
    kv('준비 구간 평균 일수', fmtNum(pa.days?.mean, 1) + '일');

  // ④ 상승 시작일
  const sd = ab.startDay || {};
  document.getElementById('startday-kv').innerHTML =
    kv('시총 대비 시작일 거래대금 (평균)', fmtPctRaw(sd.ratio?.mean)) +
    kv('시총 대비 시작일 거래대금 (중앙값)', fmtPctRaw(sd.ratio?.median)) +
    kv('Q1 / Q3', fmtPctRaw(sd.ratio?.q1) + ' / ' + fmtPctRaw(sd.ratio?.q3)) +
    kv('평소보다 거래가 늘어난 정도 (평균)', fmtX(sd.valueSpike?.mean)) +
    kv('평소보다 거래가 늘어난 정도 (중앙값)', fmtX(sd.valueSpike?.median)) +
    kv('Q1 / Q3 (배)', fmtX(sd.valueSpike?.q1) + ' / ' + fmtX(sd.valueSpike?.q3));

  // ⑤ 상승 중 거래대금
  const rv = ab.runValue || {};
  document.getElementById('runvalue-kv').innerHTML =
    kv('상승 구간 누적 / 시총 (평균)', fmtPctRaw(rv.accumulatedRatio?.mean)) +
    kv('상승 구간 누적 / 시총 (중앙값)', fmtPctRaw(rv.accumulatedRatio?.median)) +
    kv('상승 구간 최대일 / 시총 (평균)', fmtPctRaw(rv.maxValueRatio?.mean)) +
    kv('상승 구간 평균 spike (평소 대비)', fmtX(rv.spikeAvgRatio?.mean)) +
    kv('상승 구간 spike 비율 (평균)', fmtPctRaw(rv.spikeDaysRatio?.mean));

  // ⑥ 박스권
  const bx = ab.box || {};
  document.getElementById('box-kv').innerHTML =
    kv('평균 박스권 기간', fmtNum(bx.days?.mean, 1) + '일') +
    kv('중앙값 박스권 기간', fmtNum(bx.days?.median, 1) + '일') +
    kv('평균 박스권 폭', fmtPctRaw(bx.rangePct?.mean)) +
    kv('중앙값 박스권 폭', fmtPctRaw(bx.rangePct?.median)) +
    kv('Q1 / Q3 (폭)', fmtPctRaw(bx.rangePct?.q1) + ' / ' + fmtPctRaw(bx.rangePct?.q3)) +
    kv('박스 하단이 올라간 비율', (bx.lowRisingRatio?.ratio || 0) + '%') +
    kv('상단을 3번 이상 두드린 비율', (bx.touchedHighMultiRatio?.ratio || 0) + '%') +
    kv('박스 안 거래대금 증가 비율', (bx.valueIncreasingRatio?.ratio || 0) + '%') +
    kv('돌파일 거래대금 (박스 평균 대비)', fmtX(bx.breakoutValueRatio?.mean) + ' / 중앙 ' + fmtX(bx.breakoutValueRatio?.median));

  // ⑦ 이평선
  const ma = ab.movingAverage || {};
  document.getElementById('ma-kv').innerHTML =
    kv('20일선 위에서 시작한 비율', (ma.aboveMa20?.ratio || 0) + '%') +
    kv('60일선 위에서 시작한 비율', (ma.aboveMa60?.ratio || 0) + '%') +
    kv('120일선 위에서 시작한 비율', (ma.aboveMa120?.ratio || 0) + '%') +
    kv('20일선 위 / 60일선 아래', (ma.ma20AboveMa60Below?.ratio || 0) + '%') +
    kv('20일선·60일선 모두 아래', (ma.bothBelowMa20Ma60?.ratio || 0) + '%') +
    kv('정배열 (FULL_BULL) 비율', (ma.fullBull?.ratio || 0) + '%') +
    kv('단기선만 회복 비율', (ma.shortRecovery?.ratio || 0) + '%');

  // ⑧ 가격 위치
  const pp = ab.pricePosition || {};
  document.getElementById('pp-kv').innerHTML =
    kv('60일 저점 대비 (평균)', fmtPctRaw(pp.closeFromLow60?.mean)) +
    kv('60일 저점 대비 (중앙값)', fmtPctRaw(pp.closeFromLow60?.median)) +
    kv('Q1 / Q3 (60일 저점 대비)', fmtPctRaw(pp.closeFromLow60?.q1) + ' / ' + fmtPctRaw(pp.closeFromLow60?.q3)) +
    kv('60일 고점 대비 (평균)', fmtPctRaw(pp.closeFromHigh60?.mean)) +
    kv('120일 저점 대비 (평균)', fmtPctRaw(pp.closeFromLow120?.mean)) +
    kv('52주 고점 대비 (평균)', fmtPctRaw(pp.closeFrom52WeekHigh?.mean)) +
    kv('박스 하단 대비 (평균)', fmtPctRaw(pp.closeFromBoxLow?.mean)) +
    kv('박스 상단 대비 (평균)', fmtPctRaw(pp.closeFromBoxHigh?.mean));

  // ⑨ 위쪽 매물
  const sz = ab.supplyZone || {};
  document.getElementById('supply-kv').innerHTML =
    kv('위쪽 매물 부담 (평균)', fmtPctRaw(sz.aboveCloseRatio?.mean)) +
    kv('위쪽 매물 부담 (중앙값)', fmtPctRaw(sz.aboveCloseRatio?.median)) +
    kv('Q1 / Q3', fmtPctRaw(sz.aboveCloseRatio?.q1) + ' / ' + fmtPctRaw(sz.aboveCloseRatio?.q3));
  renderDist('supply-dist', sz.distribution || []);

  // ⑩ 상승 후
  const post = ab.postPeak || {};
  document.getElementById('postpeak-kv').innerHTML =
    kv('고점 이후 종가 기준 하락률 (평균)', fmtPctRaw(post.drawdownClose?.mean)) +
    kv('고점 이후 저가 기준 하락률 (평균)', fmtPctRaw(post.drawdownLow?.mean)) +
    kv('음봉 거래대금 비율 (평균)', fmtPctRaw(post.downCandleValueRatio?.mean)) +
    kv('상승 후 거래대금 / 상승 중 (평균)', fmtX(post.postValueVsRun?.mean)) +
    kv('상승 후 거래가 더 커진 비율', (post.postValueLargerThanRunRatio?.ratio || 0) + '%');

  // 🎯 제안 기준값
  const rules = data.suggestedRules || {};
  const rulesEl = document.getElementById('rules-box');
  rulesEl.innerHTML = '<h3>📐 제안 기준값 (현재 후보 탐색에서 사용)</h3>';
  rulesEl.innerHTML += '<p style="font-size:12px;color:#86efac;margin-bottom:10px;">A+B 등급 분포(Q1~Q3, P10~P90)에서 자동 도출. 다음 단계 bms-current-similarity-scan.js의 입력 기준이 됩니다.</p>';
  Object.entries(rules).forEach(([key, r]) => {
    const u = r.unit || '';
    const parts = [];
    if (r.min != null) parts.push('최소 ' + fmtNum(r.min) + u);
    if (r.idealMin != null) parts.push('좋은 구간 ' + fmtNum(r.idealMin) + u + (r.idealMax != null ? '~' + fmtNum(r.idealMax) + u : ' 이상'));
    if (r.idealMax != null && r.idealMin == null) parts.push(fmtNum(r.idealMax) + u + ' 이하면 좋음');
    if (r.tolerantMax != null) parts.push('허용 ' + fmtNum(r.tolerantMax) + u + ' 이하');
    if (r.max != null) parts.push('최대 ' + fmtNum(r.max) + u);
    rulesEl.innerHTML +=
      '<div class="rule">' +
        '<span class="name">▸ ' + escapeHtml(r.label) + '</span>' +
        '<span class="vals">' + parts.join(' · ') + '</span>' +
        '<span class="median">중앙값 참고: ' + fmtNum(r.median) + u + '</span>' +
      '</div>';
  });

  // ⚖️ 등급 비교
  const cmpRows = [
    ['후보 수', 'count', null],
    ['평균 상승률 (고가)', 'avgHighReturn', '%'],
    ['평균 도달 소요', 'avgDaysToPeak', '일'],
    ['평균 시총 대비 들어온 돈', 'avgPreAccum', '%'],
    ['평균 시총 대비 시작일 거래대금', 'avgStartDay', '%'],
    ['평균 거래대금 spike', 'avgValueSpike', '배'],
    ['평균 박스권 기간', 'avgBoxDays', '일'],
    ['평균 박스권 폭', 'avgBoxRange', '%'],
    ['평균 돌파일 거래대금 spike', 'avgBreakoutSpike', '배'],
    ['평균 위쪽 매물 부담', 'avgSupplyAbove', '%'],
    ['평균 60일 저점 대비', 'avgCloseFromLow60', '%'],
    ['평균 60일 고점 대비', 'avgCloseFromHigh60', '%'],
    ['20일선 위 시작 비율', 'aboveMa20Ratio', '%'],
    ['60일선 위 시작 비율', 'aboveMa60Ratio', '%'],
    ['단기선만 회복 비율', 'shortRecoveryRatio', '%'],
  ];
  const gc = data.gradeCompare || {};
  let cmpHtml = '<thead><tr><th>지표</th><th class="col-a">A등급</th><th class="col-b">B등급</th><th class="col-ab">A+B 통합</th></tr></thead><tbody>';
  cmpRows.forEach(([label, field, unit]) => {
    const va = gc.A ? gc.A[field] : null;
    const vb = gc.B ? gc.B[field] : null;
    const vab = gc.AB ? gc.AB[field] : null;
    const u = unit || '';
    const fm = (v) => (v == null || !isFinite(v)) ? '-' : Number(v).toFixed(field === 'count' ? 0 : 2) + (field === 'count' ? '' : u);
    cmpHtml += '<tr><td>' + label + '</td><td class="col-a">' + fm(va) + '</td><td class="col-b">' + fm(vb) + '</td><td class="col-ab">' + fm(vab) + '</td></tr>';
  });
  cmpHtml += '</tbody>';
  document.getElementById('compare-table').innerHTML = cmpHtml;

  // 예시
  function renderExamples(elId, list) {
    const el = document.getElementById(elId);
    if (!list || list.length === 0) {
      el.innerHTML = '<div style="color:#64748b;font-size:12px;">예시 없음</div>';
      return;
    }
    el.innerHTML = list.map(w => (
      '<div class="ex-row">' +
        '<div><span class="name">' + escapeHtml(w.name) + '</span> <span class="meta">' + w.code + ' · ' + (w.market||'-') + '</span></div>' +
        '<div class="meta">' + fmtDate(w.startDate) + ' → ' + fmtDate(w.peakDate) + '</div>' +
        '<div><span class="ret">' + fmtPctRaw(w.maxHighReturn) + '</span></div>' +
        '<div class="meta">' + w.daysToPeak + '일</div>' +
        '<div class="meta">박스 ' + (w.boxDays || '-') + '일/' + fmtPctRaw(w.boxRange) + '</div>' +
      '</div>'
    )).join('');
  }
  renderExamples('examples-a', (data.examples || {}).A);
  renderExamples('examples-b', (data.examples || {}).B);

  // helpers
  function kv(k, v) { return '<div class="k">' + k + '</div><div class="v">' + v + '</div>'; }
  function renderDist(elId, dist) {
    const el = document.getElementById(elId);
    if (!dist || dist.length === 0) { el.innerHTML = '<tbody><tr><td>데이터 없음</td></tr></tbody>'; return; }
    const maxCount = Math.max(...dist.map(d => d.count || 0), 1);
    let h = '<thead><tr><th>구간</th><th class="numeric">건수</th><th class="numeric">비율</th><th>분포</th></tr></thead><tbody>';
    dist.forEach(d => {
      const w = (d.count || 0) / maxCount * 100;
      h += '<tr><td>' + escapeHtml(d.label) + '</td><td class="numeric">' + (d.count || 0) + '</td><td class="numeric">' + (d.ratio != null ? d.ratio + '%' : '-') + '</td><td class="bar"><span class="bar-fill" style="width:' + w + '%;"></span></td></tr>';
    });
    h += '</tbody>';
    el.innerHTML = h;
  }
})();
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}
