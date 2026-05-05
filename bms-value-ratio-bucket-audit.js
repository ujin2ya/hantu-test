#!/usr/bin/env node
/**
 * BMS Value-Ratio Bucket Audit
 *
 * 목적:
 *   BMS 정제 상승 사례(reports/bms-winner-quality-filter-result.json의 cleanWinners A+B)에 대해
 *   "상승 전 20거래일 동안 시총 대비 들어온 돈"을 구간별로 묶어 어떤 구간에서 사례가 많고
 *   어느 구간에서 평균 상승률이 좋았는지 감사한다.
 *
 *   현재 후보 보드를 만들지 않는다. QVA·장기횡보 결과를 섞지 않는다.
 *   BMS 본체의 핵심 변수 하나(상승 전 들어온 돈)만 단독으로 본다.
 *
 * 데이터 누수 방지:
 *   각 winner 의 analysis.preAccumulation.accumulatedValueRatio 값을 그대로 사용.
 *   이 값은 winner-quality-filter 가 startDate 이전 20거래일만으로 계산한 누적값.
 *
 * 입력:
 *   - reports/bms-winner-quality-filter-result.json (cleanWinners)
 *
 * 출력:
 *   - reports/bms-value-ratio-bucket-audit-result.json
 *   - reports/bms-value-ratio-bucket-audit-result.html
 *
 * 실행:
 *   node bms-value-ratio-bucket-audit.js
 *   node bms-value-ratio-bucket-audit.js --grades=ABC   (C까지 메인 그룹에 포함)
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const INPUT_FILE = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-value-ratio-bucket-audit-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-value-ratio-bucket-audit-result.html');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  });
  return out;
})();

const CONFIG = {
  GRADES_PRIMARY: ['A', 'B'],
  GRADES_REFERENCE: ['C'],
  INCLUDE_C: String(args['grades'] || 'AB').toUpperCase().includes('C'),
  VALUE_BUCKETS: [
    { key: '0_5',     min: 0,   max: 5,        label: '거의 안 들어온 구간' },
    { key: '5_10',    min: 5,   max: 10,       label: '약하게 들어온 구간' },
    { key: '10_20',   min: 10,  max: 20,       label: '의미 있게 들어온 구간' },
    { key: '20_40',   min: 20,  max: 40,       label: '강하게 들어온 구간' },
    { key: '40_80',   min: 40,  max: 80,       label: '매우 강하게 들어온 구간' },
    { key: '80_plus', min: 80,  max: Infinity, label: '과열 가능 구간' },
  ],
  // 추천 구간 자동 도출 임계값
  SUGGEST_MIN_COUNT_RATIO: 0.05,             // 전체의 5% 이상 사례 보유
  SUGGEST_RETURN_AT_LEAST_ALL_AVG: true,     // 평균 또는 중앙값이 전체 평균 이상
  SUGGEST_DRAWDOWN_MAX: 25,                  // 상승 후 평균 하락률 25% 이내
};

// ─────────────────────── 헬퍼 ───────────────────────

function round(v, d) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function pct(num, den) { if (!den || den === 0) return null; return round(num / den * 100, 2); }
function avg(arr) { const v = arr.filter(x => x != null && isFinite(x)); if (v.length === 0) return null; return round(v.reduce((s, x) => s + x, 0) / v.length, 2); }
function median(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  return round(s[Math.floor(s.length / 2)], 2);
}

function fmtPct(v) { if (v == null) return '-'; return (v >= 0 ? '+' : '') + v + '%'; }

function bucketOf(value) {
  if (value == null || !isFinite(value)) return { key: 'no_data', label: '데이터 부족' };
  for (const b of CONFIG.VALUE_BUCKETS) {
    if (value >= b.min && value < b.max) return b;
  }
  return CONFIG.VALUE_BUCKETS[CONFIG.VALUE_BUCKETS.length - 1]; // safety
}

// ─────────────────────── BMS 핵심 지표 추출 ───────────────────────

function extractBmsMetrics(w) {
  const a = w.analysis || {};
  return {
    boxRangePct: a.boxAnalysis?.boxRangePct,
    boxRangeDays: a.boxAnalysis?.boxRangeDays,
    closeFromLow60: a.pricePosition?.closeFromLow60,
    closeFromHigh60: a.pricePosition?.closeFromHigh60,
    supplyAboveRatio: a.supplyZone?.aboveCloseRatio,
    drawdownFromPeakClose: a.postAnalysis?.drawdownFromPeakClose,
    drawdownFromPeakLow: a.postAnalysis?.drawdownFromPeakLow,
    downCandleValueRatio: a.postAnalysis?.downCandleValueRatio,
    movingAverageAboveCount: (a.movingAverage?.aboveMa20 ? 1 : 0) + (a.movingAverage?.aboveMa60 ? 1 : 0) + (a.movingAverage?.aboveMa120 ? 1 : 0),
  };
}

function extractValueRatio(w) {
  const a = w.analysis || {};
  return {
    preAccumulationRatio: a.preAccumulation?.accumulatedValueRatio,
    startDayValueRatio: a.preAccumulation?.startDayValueRatio,
    valueSpikeRatio: a.preAccumulation?.valueSpikeRatio,
    runAccumulatedValueRatio: a.runAnalysis?.accumulatedValueRatio,
  };
}

// ─────────────────────── 한 줄 해석 ───────────────────────

function buildOneLine(w) {
  const v = w.valueRatio || {};
  const r = v.preAccumulationRatio;
  const k = w.valueRatio?.bucketKey;
  if (r == null) {
    return '시총 대비 상승 전 들어온 돈 데이터가 부족한 사례입니다.';
  }
  if (k === '0_5') {
    return `상승 전 들어온 돈은 ${r}%로 적었지만 이후 +${w.maxHighReturn}% 오른 예외 사례입니다.`;
  }
  if (k === '5_10') {
    return `상승 전 시총 대비 ${r}% 정도가 약하게 들어왔던 사례입니다.`;
  }
  if (k === '10_20') {
    return `상승 전 20일 동안 시총 대비 ${r}%의 거래대금이 지나간 의미 있는 유입 구간 사례입니다.`;
  }
  if (k === '20_40') {
    return `시총 대비 ${r}% 거래대금이 지나간 강한 유입 사례입니다.`;
  }
  if (k === '40_80') {
    return `시총 대비 ${r}% 거래대금이 지나간 매우 강한 유입 사례입니다.`;
  }
  if (k === '80_plus') {
    return `${r}%로 시총을 넘는 거래대금이 지나간 과열 가능 구간 사례입니다.`;
  }
  return `시총 대비 ${r}% 들어온 사례입니다.`;
}

// ─────────────────────── 구간 통계 ───────────────────────

function summarizeBucket(items, total) {
  if (!items || items.length === 0) return { count: 0, share: 0 };
  const high = items.map(w => w.maxHighReturn);
  const close = items.map(w => w.maxCloseReturn);
  const days = items.map(w => w.daysToPeak);
  const pre = items.map(w => w.valueRatio?.preAccumulationRatio);
  const startDay = items.map(w => w.valueRatio?.startDayValueRatio);
  const spike = items.map(w => w.valueRatio?.valueSpikeRatio);
  const runAccum = items.map(w => w.valueRatio?.runAccumulatedValueRatio);
  const box = items.map(w => w.bmsMetrics?.boxRangePct);
  const low60 = items.map(w => w.bmsMetrics?.closeFromLow60);
  const high60 = items.map(w => w.bmsMetrics?.closeFromHigh60);
  const supply = items.map(w => w.bmsMetrics?.supplyAboveRatio);
  const drawdown = items.map(w => w.bmsMetrics?.drawdownFromPeakClose);
  const downRatio = items.map(w => w.bmsMetrics?.downCandleValueRatio);
  const aCount = items.filter(w => w.grade === 'A').length;
  const bCount = items.filter(w => w.grade === 'B').length;
  return {
    count: items.length,
    share: total > 0 ? pct(items.length, total) : null,
    aCount, bCount,
    aRate: pct(aCount, items.length),
    bRate: pct(bCount, items.length),
    avgHighReturn: avg(high), medHighReturn: median(high),
    avgCloseReturn: avg(close), medCloseReturn: median(close),
    avgDaysToPeak: avg(days), medDaysToPeak: median(days),
    avgPreAccum: avg(pre), medPreAccum: median(pre),
    avgStartDayValueRatio: avg(startDay),
    avgValueSpikeRatio: avg(spike),
    avgRunAccumRatio: avg(runAccum),
    avgBoxRange: avg(box),
    avgCloseFromLow60: avg(low60),
    avgCloseFromHigh60: avg(high60),
    avgSupplyAbove: avg(supply),
    avgDrawdownFromPeakClose: avg(drawdown),
    avgDownCandleValueRatio: avg(downRatio),
  };
}

// ─────────────────────── 핵심 발견 추출 ───────────────────────

function pickWinningBucket(buckets, scoreFn, label) {
  const valid = buckets.filter(b => b.count > 0 && scoreFn(b) != null);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => scoreFn(b) - scoreFn(a));
  return { bucketKey: sorted[0].key, bucketLabel: sorted[0].label, value: scoreFn(sorted[0]), description: label };
}

function pickLowestBucket(buckets, scoreFn, label) {
  const valid = buckets.filter(b => b.count > 0 && scoreFn(b) != null);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => scoreFn(a) - scoreFn(b));
  return { bucketKey: sorted[0].key, bucketLabel: sorted[0].label, value: scoreFn(sorted[0]), description: label };
}

// ─────────────────────── 추천 구간 자동 도출 ───────────────────────

function suggestRange(buckets, totalCount, allAvgHighReturn) {
  // 사례 충분 + 평균/중앙값 상승률 ≥ 전체 평균 + 하락률 임계 이내
  const minCount = Math.max(5, Math.floor(totalCount * CONFIG.SUGGEST_MIN_COUNT_RATIO));
  const candidates = buckets.filter(b => {
    if (b.count < minCount) return false;
    const ret = b.avgHighReturn ?? -1;
    if (ret < (allAvgHighReturn ?? 0)) return false;
    if (b.avgDrawdownFromPeakClose != null && b.avgDrawdownFromPeakClose > CONFIG.SUGGEST_DRAWDOWN_MAX) return false;
    return true;
  });
  if (candidates.length === 0) {
    // 완화: 사례 충분 + 평균만 양호
    const fallback = buckets.filter(b => b.count >= minCount && (b.avgHighReturn ?? 0) >= (allAvgHighReturn ?? 0) * 0.95);
    if (fallback.length === 0) return null;
    candidates.push(...fallback);
  }
  // 인접 구간을 합쳐서 최소~최대 범위로 제안
  const ordered = [...candidates].sort((a, b) => a.bucketIdx - b.bucketIdx);
  const min = ordered[0].min;
  const max = ordered[ordered.length - 1].max === Infinity ? null : ordered[ordered.length - 1].max;
  return {
    min,
    max,
    bucketKeys: ordered.map(b => b.key),
    bucketLabels: ordered.map(b => b.label),
    minCountRequired: minCount,
    reason: `사례 ${minCount}건 이상 확보된 구간 중 평균 상승률이 전체 평균 이상이고 상승 후 하락률이 ${CONFIG.SUGGEST_DRAWDOWN_MAX}% 이내인 구간`,
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Value-Ratio Bucket Audit');
  console.log('═'.repeat(80));

  if (!fs.existsSync(INPUT_FILE)) {
    console.error('입력 파일 없음:', INPUT_FILE);
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8'));
  const cleanWinners = input.cleanWinners || [];
  console.log(`입력: cleanWinners ${cleanWinners.length}건 (A=${input.gradeSummary?.A?.count} B=${input.gradeSummary?.B?.count} C=${input.gradeSummary?.C?.count})`);

  const targetGrades = CONFIG.INCLUDE_C ? [...CONFIG.GRADES_PRIMARY, ...CONFIG.GRADES_REFERENCE] : [...CONFIG.GRADES_PRIMARY];
  const targets = cleanWinners.filter(w => targetGrades.includes(w._grade));
  const cReferenceSrc = cleanWinners.filter(w => w._grade === 'C');
  console.log(`대상 등급: ${targetGrades.join('+')} → ${targets.length}건 (C 참고: ${cReferenceSrc.length}건)`);

  // 각 winner 분석
  const winners = targets.map(w => {
    const valueRatio = extractValueRatio(w);
    const bmsMetrics = extractBmsMetrics(w);
    const r = valueRatio.preAccumulationRatio;
    const b = bucketOf(r);
    const out = {
      code: w.code, name: w.name, market: w.market, marketCap: w.marketCap,
      grade: w._grade,
      startDate: w.startDate, peakDate: w.peakDate,
      startClose: w.startClose, peakHigh: w.peakHigh, peakClose: w.peakClose,
      daysToPeak: w.daysToPeak,
      maxHighReturn: w.maxHighReturn,
      maxCloseReturn: w.maxCloseReturn,
      valueRatio: { ...valueRatio, bucketKey: b.key, bucketLabel: b.label },
      bmsMetrics,
    };
    out.oneLineSummary = buildOneLine(out);
    return out;
  });

  const cReference = cReferenceSrc.map(w => {
    const v = extractValueRatio(w);
    const b = bucketOf(v.preAccumulationRatio);
    return {
      code: w.code, name: w.name, grade: 'C',
      startDate: w.startDate, maxHighReturn: w.maxHighReturn, maxCloseReturn: w.maxCloseReturn,
      daysToPeak: w.daysToPeak,
      valueRatio: { ...v, bucketKey: b.key, bucketLabel: b.label },
      bmsMetrics: extractBmsMetrics(w),
    };
  });

  // 전체 평균
  const allAvgHighReturn = avg(winners.map(w => w.maxHighReturn));
  const allMedHighReturn = median(winners.map(w => w.maxHighReturn));
  const allAvgCloseReturn = avg(winners.map(w => w.maxCloseReturn));
  const allAvgPreAccum = avg(winners.map(w => w.valueRatio.preAccumulationRatio));
  const allMedPreAccum = median(winners.map(w => w.valueRatio.preAccumulationRatio));

  // 구간별 묶음
  const noDataItems = winners.filter(w => w.valueRatio.bucketKey === 'no_data');
  const buckets = CONFIG.VALUE_BUCKETS.map((b, i) => {
    const items = winners.filter(w => w.valueRatio.bucketKey === b.key);
    return {
      ...b,
      bucketIdx: i,
      ...summarizeBucket(items, winners.length),
    };
  });
  const noDataBucket = {
    key: 'no_data', min: null, max: null, label: '데이터 부족', bucketIdx: 99,
    ...summarizeBucket(noDataItems, winners.length),
  };

  // C 참고 구간 분포 (간단)
  const cBucketCounts = CONFIG.VALUE_BUCKETS.map(b => ({
    key: b.key, label: b.label,
    count: cReference.filter(w => w.valueRatio.bucketKey === b.key).length,
    avgHighReturn: avg(cReference.filter(w => w.valueRatio.bucketKey === b.key).map(w => w.maxHighReturn)),
  }));

  // 핵심 발견
  const keyFindings = {
    mostPopulatedBucket: pickWinningBucket(buckets, b => b.count, '사례가 가장 많이 몰린 구간'),
    highestAvgReturnBucket: pickWinningBucket(buckets, b => b.avgHighReturn, '평균 고가 상승률이 가장 높은 구간'),
    highestMedReturnBucket: pickWinningBucket(buckets, b => b.medHighReturn, '중앙값 상승률이 가장 높은 구간'),
    highestCloseReturnBucket: pickWinningBucket(buckets, b => b.avgCloseReturn, '평균 종가 상승률이 가장 높은 구간'),
    fastestPeakBucket: pickLowestBucket(buckets, b => b.avgDaysToPeak, '상승 소요 기간이 가장 짧은 구간'),
    largestDrawdownBucket: pickWinningBucket(buckets, b => b.avgDrawdownFromPeakClose, '상승 후 평균 하락률이 가장 큰 구간'),
    highestARatioBucket: pickWinningBucket(buckets, b => b.aRate, 'A등급 비율이 가장 높은 구간'),
  };

  // 추천 구간 자동 도출
  const suggestedValueRatioRange = suggestRange(buckets, winners.length, allAvgHighReturn);

  // 요약
  const summary = {
    totalAnalyzed: winners.length,
    gradeACount: winners.filter(w => w.grade === 'A').length,
    gradeBCount: winners.filter(w => w.grade === 'B').length,
    gradeCCount: CONFIG.INCLUDE_C ? winners.filter(w => w.grade === 'C').length : cReference.length,
    cIncludedInGroupCompare: CONFIG.INCLUDE_C,
    cReferenceCount: cReference.length,
    noDataCount: noDataItems.length,
    allAvgHighReturn,
    allMedHighReturn,
    allAvgCloseReturn,
    allAvgPreAccum,
    allMedPreAccum,
    mostPopulatedBucketLabel: keyFindings.mostPopulatedBucket?.bucketLabel ?? null,
    highestReturnBucketLabel: keyFindings.highestAvgReturnBucket?.bucketLabel ?? null,
    highestMedReturnBucketLabel: keyFindings.highestMedReturnBucket?.bucketLabel ?? null,
    suggestedRangeLabel: suggestedValueRatioRange ? (suggestedValueRatioRange.min + '~' + (suggestedValueRatioRange.max ?? '∞') + '%') : null,
  };

  // 자동 결론
  const conclusion = [];
  const top10_40 = buckets.filter(b => ['10_20', '20_40'].includes(b.key));
  const top10_40Count = top10_40.reduce((s, b) => s + b.count, 0);
  const top10_40AvgRet = avg(winners.filter(w => ['10_20', '20_40'].includes(w.valueRatio.bucketKey)).map(w => w.maxHighReturn));
  if (top10_40Count >= winners.length * 0.3 && top10_40AvgRet != null && top10_40AvgRet >= allAvgHighReturn) {
    conclusion.push(`BMS 정제 상승 사례에서는 상승 전 20거래일 동안 시총 대비 10~40% 정도의 거래대금이 지나간 구간이 가장 의미 있어 보입니다 (사례 ${top10_40Count}건, 평균 +${top10_40AvgRet}%).`);
  }
  const strongBucket = buckets.find(b => b.key === '20_40');
  if (strongBucket && strongBucket.count >= 5 && strongBucket.avgHighReturn != null && strongBucket.avgHighReturn === keyFindings.highestAvgReturnBucket?.value) {
    conclusion.push('강하게 들어온 구간(20~40%)이 평균 상승률에서 가장 좋은 모습을 보였습니다. 다만 과열 여부는 함께 확인해야 합니다.');
  }
  const overheat = buckets.find(b => b.key === '80_plus');
  if (overheat && overheat.count >= 3 && overheat.avgDrawdownFromPeakClose != null && overheat.avgDrawdownFromPeakClose > (allAvgHighReturn != null ? allAvgHighReturn * 0.3 : 15)) {
    conclusion.push(`80% 초과 구간은 상승 후 평균 하락률이 ${overheat.avgDrawdownFromPeakClose}% 로 다른 구간보다 큰 편입니다. 단순히 좋게 보기보다 과열 가능 구간으로 보는 것이 적절합니다.`);
  }
  const lowBucket = buckets.find(b => b.key === '0_5');
  if (lowBucket && (lowBucket.count < 5 || (lowBucket.avgHighReturn != null && lowBucket.avgHighReturn < allAvgHighReturn * 0.9))) {
    conclusion.push('5% 미만 구간은 사례 수가 적거나 평균 상승률이 낮아 BMS 핵심 구간으로 보기 어렵습니다.');
  }
  // 비슷한 구간이 많으면
  const validBuckets = buckets.filter(b => b.count >= 5 && b.avgHighReturn != null);
  if (validBuckets.length >= 3) {
    const returns = validBuckets.map(b => b.avgHighReturn);
    const max = Math.max(...returns), min = Math.min(...returns);
    if ((max - min) < 5) {
      conclusion.push('상승 전 들어온 돈 구간 간 평균 상승률 차이가 크지 않습니다. 시총 대비 들어온 돈만으로 상승률 차이를 완전히 설명하기는 어렵습니다. 다만 BMS에서 최소한의 거래대금 누적 여부는 중요한 기본 조건으로 보입니다.');
    }
  }
  conclusion.push('이번 보고서는 BMS 본체의 핵심 변수 하나(상승 전 시총 대비 들어온 돈)를 이해하기 위한 감사 보고서입니다. 시총 대비 들어온 돈 구간을 현재 후보 필터로 바로 적용하지 않습니다. 먼저 과거 상승 사례에서 의미 있는 구간을 확인하는 것이 목적입니다.');

  // 예시
  const examples = {
    strongInRecommended: suggestedValueRatioRange
      ? winners.filter(w => suggestedValueRatioRange.bucketKeys.includes(w.valueRatio.bucketKey))
          .sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10)
      : [],
    strongInOverheat: winners.filter(w => w.valueRatio.bucketKey === '80_plus')
      .sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
    strongInLow: winners.filter(w => w.valueRatio.bucketKey === '0_5')
      .sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
  };

  // bucketSummary (콘솔/JSON 양쪽 동일 사용)
  const bucketSummary = [...buckets, noDataBucket].filter(b => b.count > 0);

  // 출력
  const out = {
    meta: {
      version: 'bms-value-ratio-bucket-audit-v1',
      generatedAt: new Date().toISOString(),
      title: 'BMS 시총 대비 들어온 돈 구간 감사 보고서',
      purpose: 'BMS 정제 상승 사례들이 크게 오르기 전 20거래일 동안 시총 대비 어느 정도 거래대금이 지나갔는지를 구간별로 확인하는 감사 보고서. 현재 후보를 찾는 보드가 아닙니다.',
      dataPolicy: 'analysis.preAccumulation.accumulatedValueRatio (winner-quality-filter 가 startDate 이전 20거래일만으로 계산한 누적값) 사용. 누수 없음.',
      gradesAnalyzed: targetGrades,
    },
    config: CONFIG,
    summary,
    bucketSummary,
    cReferenceBucketCounts: cBucketCounts,
    keyFindings,
    suggestedValueRatioRange,
    winners,
    cReference: cReference.slice(0, 100),
    examples,
    conclusion,
    dataLimit: [
      '"들어온 돈"은 거래대금 기준이며 순매수금액이 아님. 매수금액/매도금액 분리 데이터 없음.',
      '시총 데이터가 없거나 0인 종목은 preAccumulationRatio 가 null 이라 "데이터 부족" 구간으로 분류됨 (' + noDataItems.length + '건).',
      '상승 전 20거래일 데이터가 부족한 종목은 분석 단계에서 winner-quality-filter 가 이미 처리했음.',
      'C 등급은 ' + (CONFIG.INCLUDE_C ? '메인 그룹에 포함됨' : '참고용 비율만 별도 표시') + '.',
      '이 보고서는 매수 신호가 아니라 BMS 정제 상승 사례의 성격을 확인하는 감사 보고서임.',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // 콘솔 출력
  console.log(`\n📊 핵심 지표:`);
  console.log(`  분석 대상: ${winners.length}건 (A=${summary.gradeACount}, B=${summary.gradeBCount}${CONFIG.INCLUDE_C ? ', C=' + summary.gradeCCount : ''})`);
  console.log(`  전체 평균 상승률: +${allAvgHighReturn}% / 중앙값: +${allMedHighReturn}%`);
  console.log(`  전체 평균 시총 대비 들어온 돈: ${allAvgPreAccum}% / 중앙값: ${allMedPreAccum}%`);

  console.log(`\n📊 구간별 요약:`);
  bucketSummary.forEach(b => {
    if (!b.count) return;
    console.log(`  ${String(b.label).padEnd(20)} (${b.key.padEnd(8)}) n=${String(b.count).padStart(4)} ${String(b.share + '%').padStart(6)} avgH=${String(b.avgHighReturn).padStart(6)}% medH=${String(b.medHighReturn).padStart(6)}% close=${String(b.avgCloseReturn).padStart(6)}% 소요=${String(b.avgDaysToPeak).padStart(5)}일 하락=${String(b.avgDrawdownFromPeakClose).padStart(5)}% A=${String(b.aRate).padStart(5)}%`);
  });

  console.log(`\n🔎 핵심 발견:`);
  Object.entries(keyFindings).forEach(([k, v]) => {
    if (v == null) return;
    console.log(`  ${v.description}: ${v.bucketLabel} (${v.value})`);
  });

  console.log(`\n🎯 추천 참고 구간:`);
  if (suggestedValueRatioRange) {
    console.log(`  ${suggestedValueRatioRange.min}~${suggestedValueRatioRange.max ?? '∞'}% (구간: ${suggestedValueRatioRange.bucketLabels.join(', ')})`);
    console.log(`  사유: ${suggestedValueRatioRange.reason}`);
  } else {
    console.log('  추천 가능한 구간 없음 (충분한 표본 + 전체 평균 이상 조건 미달)');
  }

  console.log(`\n📝 결론:`);
  conclusion.forEach(c => console.log('  - ' + c));

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>BMS 시총 대비 들어온 돈 구간 감사 보고서</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
  -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 14px 0 8px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }
.note-box { background: #1e293b; border-left: 4px solid #fbbf24; padding: 10px 14px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.7; }

.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile.primary { border-left: 4px solid #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }
.big-tile.success { border-left: 4px solid #10b981; }
.big-tile.success .value { color: #6ee7b7; }
.big-tile.warn { border-left: 4px solid #f59e0b; }
.big-tile.warn .value { color: #fde047; }
.big-tile.suggest { border-left: 4px solid #14b8a6; }
.big-tile.suggest .value { color: #5eead4; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 18px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-top: 3px; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; }

.tabs { display: flex; gap: 6px; margin: 18px 0 8px; flex-wrap: wrap; }
.tab-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-weight: 500; }
.tab-btn:hover { color: #f1f5f9; border-color: #64748b; }
.tab-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }

table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 12px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; }
table.cmp thead th:first-child { text-align: left; }
table.cmp tbody td { padding: 8px 12px; border-bottom: 1px solid #334155; text-align: right; font-variant-numeric: tabular-nums; }
table.cmp tbody td:first-child { text-align: left; color: #cbd5e1; font-weight: 600; }
table.cmp tbody tr:hover td { background: #273549; }
.row-highlight td { background: rgba(16, 185, 129, 0.18) !important; }
.row-suggest td { background: rgba(20, 184, 166, 0.16) !important; }
.row-overheat td { background: rgba(239, 68, 68, 0.12) !important; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-warn { color: #fde047; }

.tbl-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.list { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
table.list thead th { background: #0f172a; color: #94a3b8; font-weight: 600; text-align: left; padding: 9px 12px; border-bottom: 1px solid #334155; white-space: nowrap; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
table.list thead th.numeric { text-align: right; }
table.list tbody tr.row { border-bottom: 1px solid #1e293b; cursor: pointer; }
table.list tbody tr.row:hover { background: #273549; }
table.list tbody tr.row.expanded { background: #1e3a5f; }
table.list tbody tr.row td { padding: 8px 12px; vertical-align: middle; line-height: 1.3; white-space: nowrap; }
table.list tbody tr.row td.numeric { text-align: right; }
table.list tbody tr.row td.col-name { font-weight: 600; color: #f1f5f9; min-width: 130px; }
table.list tbody tr.row td.col-name .meta { display: block; font-size: 10px; color: #64748b; font-weight: 400; margin-top: 2px; }
table.list tbody tr.row td.col-summary { color: #cbd5e1; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: normal; line-height: 1.4; font-size: 11.5px; }
table.list tbody tr.row:nth-child(odd) { background: #1c2942; }
table.list tbody tr.row:nth-child(odd):hover { background: #273549; }
table.list tbody tr.row.expanded, table.list tbody tr.row.expanded:nth-child(odd) { background: #1e3a5f; }

.grade-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.grade-A { background: #14532d; color: #6ee7b7; }
.grade-B { background: #1e40af; color: #dbeafe; }
.grade-C { background: #475569; color: #cbd5e1; }
.bucket-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.bucket-0_5 { background: #475569; color: #cbd5e1; }
.bucket-5_10 { background: #1e3a8a; color: #93c5fd; }
.bucket-10_20 { background: #14532d; color: #a7f3d0; }
.bucket-20_40 { background: #064e3b; color: #6ee7b7; }
.bucket-40_80 { background: #6d28d9; color: #ddd6fe; }
.bucket-80_plus { background: #7f1d1d; color: #fca5a5; }
.bucket-no_data { background: #334155; color: #94a3b8; }

table.list tbody tr.detail { display: none; background: #0c1729; }
table.list tbody tr.detail.show { display: table-row; }
table.list tbody tr.detail td { padding: 14px 18px; border-bottom: 1px solid #1e3a5f; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 24px; font-size: 12px; }
.detail-block h4 { margin: 0 0 6px; font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; line-height: 1.6; }
.kv .k { color: #64748b; }
.kv .v { color: #cbd5e1; font-variant-numeric: tabular-nums; }

.bar-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.bar-row .lbl { width: 180px; font-size: 12px; color: #cbd5e1; }
.bar-row .bar { flex: 1; height: 16px; background: #0f172a; border-radius: 4px; overflow: hidden; position: relative; }
.bar-row .bar .fill { display: block; height: 100%; background: linear-gradient(90deg, #0ea5e9, #14b8a6); }
.bar-row .val { width: 140px; font-size: 12px; color: #94a3b8; text-align: right; font-variant-numeric: tabular-nums; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; }
  .tbl-wrap { overflow-x: auto !important; }
  .col-mobile-hide,
  table.list thead th.col-mobile-hide { display: none; }
  .detail-grid { grid-template-columns: 1fr; }
  .bar-row .lbl { width: 100px; }
  .bar-row .val { width: 90px; }
}
</style>
</head>
<body>

<h1 id="page-title">BMS 시총 대비 들어온 돈 구간 감사 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 이 보고서는 BMS 정제 상승 사례들이 크게 오르기 전 20거래일 동안 시총 대비 어느 정도 거래대금이 지나갔는지를 구간별로 확인하는 감사 보고서입니다.
  <strong>현재 후보를 찾는 보드가 아닙니다.</strong> 시총 대비 들어온 돈 구간을 현재 후보 필터로 바로 적용하지 않습니다.
</div>

<div class="note-box">
  💡 <strong>"시총 대비 상승 전 들어온 돈"이란?</strong> 해당 종목이 크게 오르기 전 20거래일 동안 지나간 거래대금이 시가총액과 비교해 어느 정도였는지를 뜻합니다.
  예) 시총 1,000억 종목에 상승 전 20일 동안 200억 거래대금이 지나갔다면 20%입니다.
  ※ 이 값은 거래대금 기준이며 실제 순매수금액은 아닙니다.
</div>

<h2>📊 핵심 지표</h2>
<div class="big-summary" id="big-summary"></div>

<h2>📊 시총 대비 들어온 돈 구간 분포</h2>
<div id="bucket-distribution"></div>

<h2>📊 구간별 상승률·종가·소요·하락 비교</h2>
<div id="bucket-compare-table"></div>

<h2>📊 구간별 A/B 등급 분포</h2>
<div id="bucket-grade-table"></div>

<h2>🔎 핵심 발견</h2>
<div id="key-findings" class="purpose-box" style="border-left-color:#fbbf24;"></div>

<h2>🎯 추천 참고 구간</h2>
<div id="suggested-range" class="purpose-box" style="border-left-color:#10b981;"></div>

<h2>🏆 BMS 상승 사례 리스트</h2>
<div class="tabs" id="tabs"></div>
<div class="tbl-wrap">
  <table class="list">
    <thead>
      <tr>
        <th>#</th>
        <th>종목</th>
        <th>등급</th>
        <th class="col-mobile-hide">상승 시작일</th>
        <th class="numeric">고가 상승률</th>
        <th class="numeric col-mobile-hide">종가 상승률</th>
        <th class="numeric col-mobile-hide">소요</th>
        <th>들어온돈 구간</th>
        <th class="numeric">시총대비 들어온돈</th>
        <th class="numeric col-mobile-hide">시작일 거래대금/시총</th>
        <th class="numeric col-mobile-hide">시작일 spike</th>
        <th class="numeric col-mobile-hide">오르는 동안</th>
        <th class="numeric col-mobile-hide">박스폭</th>
        <th class="numeric col-mobile-hide">저점대비</th>
        <th class="numeric col-mobile-hide">고점대비</th>
        <th class="col-summary">한 줄 해석</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<h2>📝 결론</h2>
<div id="conclusion-box" class="purpose-box" style="border-left-color:#10b981;"></div>

<footer class="foot">
  <strong>매수 신호가 아닙니다.</strong> BMS Value-Ratio Bucket Audit는 <em>BMS 정제 상승 사례에서 상승 전 시총 대비 거래대금이 어느 구간에 몰렸고, 어떤 구간에서 결과가 좋았는지를 확인</em>하는 감사 도구입니다.
  시총 대비 들어온 돈 구간을 처음부터 BMS 필터로 쓰지 않습니다. 이 보고서 결과를 보고 본체 이해를 위한 참고 자료로만 활용하세요.
  <br><br>
  <small style="color:#64748b;" id="data-limit"></small>
</footer>

<script id="report-data" type="application/json">__JSON_DATA__</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const meta = data.meta || {};
  const summary = data.summary || {};
  const winners = data.winners || [];

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d); }
  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtPctRaw(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }
  function fmtMc(v) { if (!v) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; return Math.round(e) + '억'; }
  function fmtPrice(v) { if (!v) return '-'; return Number(v).toLocaleString() + '원'; }
  function clsRet(v) { if (v == null || !isFinite(v)) return ''; return v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : ''); }
  function bucketCls(k) { return 'bucket-' + (k || 'no_data'); }

  document.getElementById('subtitle').innerHTML =
    '분석 대상 ' + summary.totalAnalyzed + '건 (A=' + summary.gradeACount + ' B=' + summary.gradeBCount + (summary.cIncludedInGroupCompare ? ' C=' + summary.gradeCCount : '') + ') · 전체 평균 상승률 ' + fmtPct(summary.allAvgHighReturn) + ' · 평균 시총 대비 들어온 돈 ' + fmtPctRaw(summary.allAvgPreAccum) + ' · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>데이터 정의:</strong> ' + escapeHtml(meta.dataPolicy);

  document.getElementById('data-limit').innerHTML =
    '데이터 한계:<br>' + (data.dataLimit || []).map(l => '&nbsp;&bull; ' + escapeHtml(l)).join('<br>');

  // 핵심 타일
  const tiles = [
    { label: '분석 대상', value: summary.totalAnalyzed + '건', sub: 'A ' + summary.gradeACount + ' / B ' + summary.gradeBCount, cls: 'primary' },
    { label: '전체 평균 상승률', value: fmtPct(summary.allAvgHighReturn), sub: '중앙값 ' + fmtPct(summary.allMedHighReturn), cls: 'success' },
    { label: '전체 평균 들어온 돈', value: fmtPctRaw(summary.allAvgPreAccum), sub: '중앙값 ' + fmtPctRaw(summary.allMedPreAccum) },
    { label: '가장 많은 구간', value: summary.mostPopulatedBucketLabel || '-', sub: '사례 수 기준' },
    { label: '평균 상승률 최고 구간', value: summary.highestReturnBucketLabel || '-', sub: '평균 고가 상승률 기준', cls: 'success' },
    { label: '중앙값 상승률 최고 구간', value: summary.highestMedReturnBucketLabel || '-', sub: '중앙값 기준' },
    { label: '추천 참고 구간', value: summary.suggestedRangeLabel || '-', sub: '자동 도출 (필터 아님)', cls: 'suggest' },
    { label: '데이터 부족', value: summary.noDataCount + '건', sub: '시총·거래대금 데이터 없음', cls: summary.noDataCount > 0 ? 'warn' : '' },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div><div class="sub">' + t.sub + '</div>';
    ts.appendChild(el);
  });

  // 구간 분포 (막대 그래프)
  const bucketSummary = data.bucketSummary || [];
  const maxCount = Math.max(1, ...bucketSummary.map(b => b.count || 0));
  let distHtml = '';
  bucketSummary.forEach(b => {
    const widthPct = ((b.count || 0) / maxCount * 100).toFixed(1);
    distHtml += '<div class="bar-row">' +
      '<div class="lbl"><span class="bucket-pill ' + bucketCls(b.key) + '">' + escapeHtml(b.label) + '</span></div>' +
      '<div class="bar"><span class="fill" style="width:' + widthPct + '%;"></span></div>' +
      '<div class="val">' + b.count + '건 (' + fmtPctRaw(b.share) + ')</div>' +
    '</div>';
  });
  document.getElementById('bucket-distribution').innerHTML = distHtml;

  // 구간 비교 표
  const sg = data.suggestedValueRatioRange;
  const suggestSet = new Set((sg?.bucketKeys) || []);
  let cmpHtml = '<table class="cmp"><thead><tr>' +
    '<th>구간</th><th>n</th><th>비율</th><th>평균 상승률</th><th>중앙값</th><th>평균 종가</th>' +
    '<th>평균 소요</th><th>평균 들어온돈</th><th>시작일 거래대금/시총</th><th>시작일 spike</th>' +
    '<th>오르는 동안</th><th>박스폭</th><th>저점대비</th><th>고점대비</th><th>오른뒤 흔들림</th>' +
    '</tr></thead><tbody>';
  bucketSummary.forEach(b => {
    let cls = '';
    if (suggestSet.has(b.key)) cls = 'row-suggest';
    if (b.key === '80_plus') cls = 'row-overheat';
    if (b.key === 'no_data') cls = '';
    cmpHtml += '<tr class="' + cls + '">' +
      '<td><span class="bucket-pill ' + bucketCls(b.key) + '">' + escapeHtml(b.label) + '</span></td>' +
      '<td>' + b.count + '</td>' +
      '<td>' + fmtPctRaw(b.share) + '</td>' +
      '<td class="cell-pos">' + fmtPct(b.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(b.medHighReturn) + '</td>' +
      '<td class="' + clsRet(b.avgCloseReturn) + '">' + fmtPct(b.avgCloseReturn) + '</td>' +
      '<td>' + (b.avgDaysToPeak != null ? fmtNum(b.avgDaysToPeak) + '일' : '-') + '</td>' +
      '<td>' + fmtPctRaw(b.avgPreAccum) + '</td>' +
      '<td>' + fmtPctRaw(b.avgStartDayValueRatio) + '</td>' +
      '<td>' + (b.avgValueSpikeRatio != null ? fmtNum(b.avgValueSpikeRatio) + '×' : '-') + '</td>' +
      '<td>' + fmtPctRaw(b.avgRunAccumRatio) + '</td>' +
      '<td>' + fmtPctRaw(b.avgBoxRange) + '</td>' +
      '<td>' + fmtPct(b.avgCloseFromLow60) + '</td>' +
      '<td>' + fmtPct(b.avgCloseFromHigh60) + '</td>' +
      '<td class="cell-neg">' + fmtPctRaw(b.avgDrawdownFromPeakClose) + '</td>' +
    '</tr>';
  });
  cmpHtml += '</tbody></table>';
  document.getElementById('bucket-compare-table').innerHTML = cmpHtml;

  // A/B 등급 분포 표
  let gradeHtml = '<table class="cmp"><thead><tr><th>구간</th><th>n</th><th>A 사례</th><th>B 사례</th><th>A 비율</th><th>B 비율</th></tr></thead><tbody>';
  bucketSummary.forEach(b => {
    gradeHtml += '<tr>' +
      '<td><span class="bucket-pill ' + bucketCls(b.key) + '">' + escapeHtml(b.label) + '</span></td>' +
      '<td>' + b.count + '</td>' +
      '<td>' + (b.aCount || 0) + '건</td>' +
      '<td>' + (b.bCount || 0) + '건</td>' +
      '<td>' + fmtPctRaw(b.aRate) + '</td>' +
      '<td>' + fmtPctRaw(b.bRate) + '</td>' +
    '</tr>';
  });
  gradeHtml += '</tbody></table>';
  document.getElementById('bucket-grade-table').innerHTML = gradeHtml;

  // 핵심 발견
  const kf = data.keyFindings || {};
  const findingsList = [
    kf.mostPopulatedBucket,
    kf.highestAvgReturnBucket,
    kf.highestMedReturnBucket,
    kf.highestCloseReturnBucket,
    kf.fastestPeakBucket,
    kf.largestDrawdownBucket,
    kf.highestARatioBucket,
  ].filter(x => x);
  const kfHtml = findingsList.map(f =>
    '<strong>' + escapeHtml(f.description) + ':</strong> <span class="bucket-pill ' + bucketCls(f.bucketKey) + '">' + escapeHtml(f.bucketLabel) + '</span> (' + fmtNum(f.value) + ')'
  ).join('<br>');
  document.getElementById('key-findings').innerHTML = kfHtml || '핵심 발견 없음';

  // 추천 구간
  const sgEl = document.getElementById('suggested-range');
  if (sg) {
    const labelsHtml = (sg.bucketLabels || []).map((l, i) =>
      '<span class="bucket-pill ' + bucketCls((sg.bucketKeys || [])[i]) + '">' + escapeHtml(l) + '</span>'
    ).join(' ');
    sgEl.innerHTML =
      '<strong>📌 자동 도출 결과:</strong> 시총 대비 <strong style="color:#5eead4;">' + sg.min + '~' + (sg.max ?? '∞') + '%</strong> 구간<br><br>' +
      '구간 라벨: ' + labelsHtml + '<br><br>' +
      '<strong>사유:</strong> ' + escapeHtml(sg.reason) + '<br>' +
      '<small style="color:#fde68a;">⚠️ 이 구간은 BMS 본체 필터가 아닙니다. 과거 사례 이해를 위한 참고 기준입니다.</small>';
  } else {
    sgEl.innerHTML = '<strong>📌 자동 도출 결과:</strong> 추천 가능한 구간 없음 (충분한 표본 + 전체 평균 이상 + 하락률 임계 조건을 모두 만족하는 구간이 없음)';
  }

  // 결론
  const conclusion = data.conclusion || [];
  document.getElementById('conclusion-box').innerHTML =
    '<strong>📌 자동 결론:</strong><br>' +
    conclusion.map(c => '• ' + escapeHtml(c)).join('<br><br>');

  // 탭
  const tabs = [
    { id: 'all', label: '전체 (' + winners.length + ')' },
    { id: '0_5', label: '거의 안 들어온 (' + winners.filter(w => w.valueRatio.bucketKey === '0_5').length + ')' },
    { id: '5_10', label: '약하게 (' + winners.filter(w => w.valueRatio.bucketKey === '5_10').length + ')' },
    { id: '10_20', label: '의미 있게 (' + winners.filter(w => w.valueRatio.bucketKey === '10_20').length + ')' },
    { id: '20_40', label: '강하게 (' + winners.filter(w => w.valueRatio.bucketKey === '20_40').length + ')' },
    { id: '40_80', label: '매우 강하게 (' + winners.filter(w => w.valueRatio.bucketKey === '40_80').length + ')' },
    { id: '80_plus', label: '과열 가능 (' + winners.filter(w => w.valueRatio.bucketKey === '80_plus').length + ')' },
    { id: 'A', label: 'A등급 (' + winners.filter(w => w.grade === 'A').length + ')' },
    { id: 'B', label: 'B등급 (' + winners.filter(w => w.grade === 'B').length + ')' },
  ];
  const tabsEl = document.getElementById('tabs');
  let activeTab = 'all';
  tabs.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (t.id === activeTab ? ' active' : '');
    btn.textContent = t.label;
    btn.dataset.tab = t.id;
    btn.addEventListener('click', () => {
      activeTab = t.id;
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderList();
    });
    tabsEl.appendChild(btn);
  });

  function pickList() {
    if (activeTab === 'all') return winners;
    if (activeTab === 'A' || activeTab === 'B') return winners.filter(w => w.grade === activeTab);
    return winners.filter(w => w.valueRatio.bucketKey === activeTab);
  }

  const tbody = document.getElementById('list-body');
  function renderList() {
    tbody.innerHTML = '';
    let list = pickList();
    list = [...list].sort((a, b) => b.maxHighReturn - a.maxHighReturn);
    list.forEach((w, i) => {
      const m = w.bmsMetrics || {};
      const v = w.valueRatio || {};
      const tr = document.createElement('tr');
      tr.className = 'row';
      tr.innerHTML =
        '<td>' + (i + 1) + '</td>' +
        '<td class="col-name">' + escapeHtml(w.name) + '<span class="meta">' + w.code + ' · ' + (w.market || '-') + '</span></td>' +
        '<td><span class="grade-pill grade-' + (w.grade || 'C') + '">' + escapeHtml(w.grade || '-') + '</span></td>' +
        '<td class="col-mobile-hide">' + fmtDate(w.startDate) + '</td>' +
        '<td class="numeric cell-pos" style="font-weight:700;">' + fmtPct(w.maxHighReturn) + '</td>' +
        '<td class="numeric col-mobile-hide ' + clsRet(w.maxCloseReturn) + '">' + fmtPct(w.maxCloseReturn) + '</td>' +
        '<td class="numeric col-mobile-hide">' + (w.daysToPeak != null ? w.daysToPeak + '일' : '-') + '</td>' +
        '<td><span class="bucket-pill ' + bucketCls(v.bucketKey) + '">' + escapeHtml(v.bucketLabel || '-') + '</span></td>' +
        '<td class="numeric" style="font-weight:700;color:#5eead4;">' + fmtPctRaw(v.preAccumulationRatio) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPctRaw(v.startDayValueRatio) + '</td>' +
        '<td class="numeric col-mobile-hide">' + (v.valueSpikeRatio != null ? fmtNum(v.valueSpikeRatio) + '×' : '-') + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPctRaw(v.runAccumulatedValueRatio) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPctRaw(m.boxRangePct) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPct(m.closeFromLow60) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPct(m.closeFromHigh60) + '</td>' +
        '<td class="col-summary">' + escapeHtml(w.oneLineSummary || '') + '</td>';
      const trd = document.createElement('tr');
      trd.className = 'detail';
      trd.innerHTML = '<td colspan="16">' + buildDetailHtml(w) + '</td>';
      tr.addEventListener('click', () => {
        tr.classList.toggle('expanded');
        trd.classList.toggle('show');
      });
      tbody.appendChild(tr);
      tbody.appendChild(trd);
    });
  }

  function buildDetailHtml(w) {
    const m = w.bmsMetrics || {};
    const v = w.valueRatio || {};
    const strengths = [];
    const cautions = [];
    if (v.bucketKey === '10_20' || v.bucketKey === '20_40') strengths.push('상승 전 시총 대비 들어온 돈이 BMS 핵심 구간 안');
    if (v.bucketKey === '80_plus') cautions.push('80% 초과 — 이미 거래가 과도하게 몰린 과열 가능 구간');
    if (v.bucketKey === '0_5') cautions.push('상승 전 들어온 돈이 5% 미만 — BMS 핵심 구간으로 보기 어려움');
    if (m.drawdownFromPeakClose != null && m.drawdownFromPeakClose > 25) cautions.push('상승 후 종가 기준 하락률 ' + m.drawdownFromPeakClose + '% — 흔들림 큼');
    if (m.boxRangePct != null && m.boxRangePct <= 25) strengths.push('상승 전 박스권 폭 ' + m.boxRangePct + '%로 응축');
    if (m.supplyAboveRatio != null && m.supplyAboveRatio <= 40) strengths.push('위쪽 매물 부담 낮음 (' + m.supplyAboveRatio + '%)');

    return '<div class="detail-grid">' +
      '<div class="detail-block"><h4>📌 BMS 상승 사례</h4>' +
        '<div class="kv">' +
          '<div class="k">등급</div><div class="v">' + escapeHtml(w.grade || '-') + '</div>' +
          '<div class="k">시총</div><div class="v">' + fmtMc(w.marketCap) + '</div>' +
          '<div class="k">상승 시작일</div><div class="v">' + fmtDate(w.startDate) + '</div>' +
          '<div class="k">시작 종가</div><div class="v">' + fmtPrice(w.startClose) + '</div>' +
          '<div class="k">+40% 도달일</div><div class="v">' + fmtDate(w.peakDate) + '</div>' +
          '<div class="k">고가</div><div class="v">' + fmtPrice(w.peakHigh) + '</div>' +
          '<div class="k">상승 소요</div><div class="v">' + (w.daysToPeak || '-') + '거래일</div>' +
          '<div class="k">고가 상승률</div><div class="v cell-pos">' + fmtPct(w.maxHighReturn) + '</div>' +
          '<div class="k">종가 상승률</div><div class="v ' + clsRet(w.maxCloseReturn) + '">' + fmtPct(w.maxCloseReturn) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block"><h4>💰 시총 대비 들어온 돈 (상승 전)</h4>' +
        '<div class="kv">' +
          '<div class="k">상승 전 20일 누적/시총</div><div class="v" style="color:#5eead4;font-weight:700;">' + fmtPctRaw(v.preAccumulationRatio) + '</div>' +
          '<div class="k">구간</div><div class="v"><span class="bucket-pill ' + bucketCls(v.bucketKey) + '">' + escapeHtml(v.bucketLabel || '-') + '</span></div>' +
          '<div class="k">시작일 거래대금/시총</div><div class="v">' + fmtPctRaw(v.startDayValueRatio) + '</div>' +
          '<div class="k">시작일 거래대금 spike</div><div class="v">' + (v.valueSpikeRatio != null ? fmtNum(v.valueSpikeRatio) + '×' : '-') + '</div>' +
          '<div class="k">오르는 동안 들어온 돈</div><div class="v">' + fmtPctRaw(v.runAccumulatedValueRatio) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block"><h4>📊 BMS 핵심 지표</h4>' +
        '<div class="kv">' +
          '<div class="k">박스권 폭 (' + (m.boxRangeDays || '-') + '일)</div><div class="v">' + fmtPctRaw(m.boxRangePct) + '</div>' +
          '<div class="k">60일 저점 대비</div><div class="v">' + fmtPct(m.closeFromLow60) + '</div>' +
          '<div class="k">60일 고점 대비</div><div class="v">' + fmtPct(m.closeFromHigh60) + '</div>' +
          '<div class="k">위쪽 매물 부담</div><div class="v">' + fmtPctRaw(m.supplyAboveRatio) + '</div>' +
          '<div class="k">상승 후 종가 하락률</div><div class="v cell-neg">' + fmtPctRaw(m.drawdownFromPeakClose) + '</div>' +
          '<div class="k">상승 후 음봉 거래대금</div><div class="v">' + fmtPctRaw(m.downCandleValueRatio) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block" style="grid-column: 1 / -1;"><h4>강점 / 주의점 / 한 줄 해석</h4>' +
        (strengths.length > 0 ? '<p style="color:#6ee7b7;">강점: ' + strengths.map(escapeHtml).join(' · ') + '</p>' : '') +
        (cautions.length > 0 ? '<p style="color:#fca5a5;">주의: ' + cautions.map(escapeHtml).join(' · ') + '</p>' : '') +
        '<p style="color:#fde68a;font-size:13px;line-height:1.6;margin-top:8px;">' + escapeHtml(w.oneLineSummary || '') + '</p>' +
        '<p style="color:#94a3b8;font-size:11px;margin-top:6px;">⚠️ 과거 사례의 성격 확인용입니다. 같은 패턴이 미래에도 반복된다는 보장은 없습니다.</p>' +
      '</div>' +
    '</div>';
  }

  renderList();
})();
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}
