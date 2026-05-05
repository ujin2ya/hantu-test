#!/usr/bin/env node
/**
 * BMS Price-Position Bucket Audit
 *
 * 목적:
 *   BMS 정제 상승 사례(reports/bms-winner-quality-filter-result.json의 cleanWinners A+B)에 대해
 *   상승 시작점이 최근 60일 박스권 안에서 어느 위치였는지를 구간별로 감사한다.
 *
 *   확인하는 두 축:
 *     1) 60일 저점 대비 위치 (closeFromLow60) — 저점에서 몇 % 위였는지
 *     2) 60일 고점 대비 위치 (closeFromHigh60) — 고점에서 몇 % 아래였는지
 *
 *   추가로 두 축을 합친 박스권 위치(positionInRange)를 계산해 박스 하단/중간/상단을 본다.
 *
 *   현재 후보 보드를 만들지 않는다. QVA·장기횡보·시총대비 들어온 돈 결과를 섞지 않는다.
 *   BMS 본체의 또 다른 핵심 변수(가격 위치)를 단독으로 본다.
 *
 * 데이터 누수 방지:
 *   각 winner 의 analysis.pricePosition 값을 그대로 사용 (winner-quality-filter 가
 *   startDate 기준으로 계산한 값). 이번 보고서는 새로 계산하지 않음.
 *
 * 입력:
 *   - reports/bms-winner-quality-filter-result.json (cleanWinners)
 *
 * 출력:
 *   - reports/bms-price-position-bucket-audit-result.json
 *   - reports/bms-price-position-bucket-audit-result.html
 *
 * 실행:
 *   node bms-price-position-bucket-audit.js
 *   node bms-price-position-bucket-audit.js --grades=ABC
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const INPUT_FILE = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-price-position-bucket-audit-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-price-position-bucket-audit-result.html');

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

  // 60일 저점 대비 위치 (closeFromLow60, % 위)
  LOW60_BUCKETS: [
    { key: 'low_0_10',    min: 0,   max: 10,       label: '저점 바로 위 (0~10%)',     role: '약함',       explanation: '60일 저점에서 10% 이내로 가까운 위치. 추세가 막 살아나는 시점일 수도 있지만 너무 이를 수 있어 약합니다.' },
    { key: 'low_10_25',   min: 10,  max: 25,       label: '초기 회복 (10~25%)',       role: 'BMS 보조',   explanation: '저점에서 의미 있게 떨어진 초기 회복 구간. 박스 하단~중간에 해당하는 정석 BMS 위치 후보입니다.' },
    { key: 'low_25_45',   min: 25,  max: 45,       label: '의미 있는 회복 (25~45%)',   role: 'BMS 핵심',   explanation: '저점에서 충분히 떨어진 정석 회복 구간. BMS 정제 사례가 가장 많이 몰린 핵심 영역입니다.' },
    { key: 'low_45_70',   min: 45,  max: 70,       label: '후반 회복 (45~70%)',       role: '주의',       explanation: '저점에서 이미 많이 오른 위치. 추세는 살아 있지만 위쪽 공간이 작아질 수 있습니다.' },
    { key: 'low_70_plus', min: 70,  max: Infinity, label: '과열 의심 (70%+)',         role: '강한 주의',   explanation: '저점 대비 70% 이상 오른 위치. 이미 충분히 오른 뒤라 추격 위험이 큽니다.' },
  ],

  // 60일 고점 대비 위치 (closeFromHigh60, 음수 %)
  HIGH60_BUCKETS: [
    { key: 'high_below_40',  min: -Infinity, max: -40, label: '고점에서 너무 멈 (≤-40%)', role: '약함',     explanation: '60일 고점에서 40% 이상 떨어진 위치. 큰 추세 하락 뒤 반등일 가능성으로 BMS 정상 사례에서는 드뭅니다.' },
    { key: 'high_25_40',     min: -40,       max: -25, label: '박스 중하단 (-40~-25%)',  role: 'BMS 핵심', explanation: '고점에서 25~40% 떨어진 위치로 위쪽 공간이 충분합니다. 정석 BMS 핵심 위치 중 하나입니다.' },
    { key: 'high_10_25',     min: -25,       max: -10, label: '박스 중상단 (-25~-10%)',  role: 'BMS 핵심', explanation: '고점에서 10~25% 떨어진 위치로 위쪽 공간이 적당합니다. 정석 BMS 핵심 위치 중 하나입니다.' },
    { key: 'high_3_10',      min: -10,       max: -3,  label: '고점 근처 (-10~-3%)',     role: '주의',     explanation: '60일 고점 바로 아래로 위쪽 공간이 작습니다. 매물 부담이 클 수 있습니다.' },
    { key: 'high_above_3',   min: -3,        max: Infinity, label: '신고가 근처 (-3%↑)',  role: '강한 주의', explanation: '60일 고점에 도달했거나 돌파한 위치. 정상 BMS 사례에서는 신고가 근처 시작이 드뭅니다.' },
  ],

  // 박스권 위치 (positionInRange = closeFromLow60 / (closeFromLow60 - closeFromHigh60) * 100)
  POSITION_BUCKETS: [
    { key: 'pos_below_0',   min: -Infinity, max: 0,        label: '60일 저점 이탈',  role: '약함',     explanation: '시작점이 60일 저점 밑으로 내려간 상태. 정상 BMS 위치가 아닙니다.' },
    { key: 'pos_0_30',      min: 0,         max: 30,       label: '박스 하단',     role: 'BMS 핵심', explanation: '60일 박스권 하단(0~30%)에서 시작 — 위쪽 공간이 가장 큰 정석 BMS 위치입니다.' },
    { key: 'pos_30_70',     min: 30,        max: 70,       label: '박스 중간',     role: 'BMS 핵심', explanation: '60일 박스권 중간(30~70%)에서 시작 — 정석 BMS 위치 중 하나입니다.' },
    { key: 'pos_70_100',    min: 70,        max: 100,      label: '박스 상단',     role: 'BMS 보조', explanation: '60일 박스권 상단(70~100%)에서 시작 — 위쪽 공간이 작아 매물 부담이 큽니다.' },
    { key: 'pos_above_100', min: 100,       max: Infinity, label: '60일 신고가 돌파', role: '주의',     explanation: '시작점이 60일 고점을 넘은 상태. 강한 추세이거나 추격 위험.' },
  ],

  // 추천 구간 자동 도출 임계값
  SUGGEST_MIN_COUNT_RATIO: 0.05,
  SUGGEST_DRAWDOWN_MAX: 25,
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

const NO_DATA = { key: 'no_data', label: '데이터 없음', role: '판정 불가', explanation: '60일 가격 위치 데이터가 부족합니다.' };

function findBucket(value, buckets) {
  if (value == null || !isFinite(value)) return NO_DATA;
  for (const b of buckets) {
    if (value >= b.min && value < b.max) return b;
  }
  return NO_DATA;
}

function computePositionInRange(closeFromLow60, closeFromHigh60) {
  // closeFromLow60 = (close - low) / low * 100
  // closeFromHigh60 = (close - high) / high * 100  (음수)
  // 박스권 위치 = (close - low) / (high - low) * 100
  // = closeFromLow60 / (closeFromLow60 - closeFromHigh60) * 100
  if (closeFromLow60 == null || closeFromHigh60 == null) return null;
  if (!isFinite(closeFromLow60) || !isFinite(closeFromHigh60)) return null;
  const denom = closeFromLow60 - closeFromHigh60;
  if (denom <= 0) return null;
  return round(closeFromLow60 / denom * 100, 2);
}

// ─────────────────────── 한 줄 해석 ───────────────────────

function buildOneLine(w) {
  const p = w.position || {};
  const lf = p.closeFromLow60;
  const hf = p.closeFromHigh60;
  if (lf == null || hf == null) return '60일 가격 위치 데이터가 부족한 사례입니다.';
  const posLabel = p.positionBucket?.label || '-';
  return `상승 시작점이 60일 저점 대비 +${round(lf, 1)}%, 60일 고점 대비 ${round(hf, 1)}% 위치 (${posLabel})에 있던 사례입니다.`;
}

// ─────────────────────── 그룹 통계 ───────────────────────

function summarizeBucket(items, total) {
  if (!items || items.length === 0) return { count: 0, share: 0 };
  const high = items.map(w => w.maxHighReturn);
  const close = items.map(w => w.maxCloseReturn);
  const days = items.map(w => w.daysToPeak);
  const lf = items.map(w => w.position?.closeFromLow60);
  const hf = items.map(w => w.position?.closeFromHigh60);
  const pos = items.map(w => w.position?.positionInRange);
  const drawdown = items.map(w => w.bmsMetrics?.drawdownFromPeakClose);
  const supply = items.map(w => w.bmsMetrics?.supplyAboveRatio);
  const box = items.map(w => w.bmsMetrics?.boxRangePct);
  const aCount = items.filter(w => w.grade === 'A').length;
  const bCount = items.filter(w => w.grade === 'B').length;
  const cCount = items.filter(w => w.grade === 'C').length;
  return {
    count: items.length,
    share: total > 0 ? pct(items.length, total) : null,
    aCount, bCount, cCount,
    aRate: pct(aCount, items.length),
    bRate: pct(bCount, items.length),
    avgHighReturn: avg(high), medHighReturn: median(high),
    avgCloseReturn: avg(close), medCloseReturn: median(close),
    avgDaysToPeak: avg(days), medDaysToPeak: median(days),
    avgCloseFromLow60: avg(lf),
    avgCloseFromHigh60: avg(hf),
    avgPositionInRange: avg(pos),
    avgBoxRangePct: avg(box),
    avgSupplyAbove: avg(supply),
    avgDrawdownFromPeakClose: avg(drawdown),
  };
}

// ─────────────────────── 핵심 발견 ───────────────────────

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
  const minCount = Math.max(5, Math.floor(totalCount * CONFIG.SUGGEST_MIN_COUNT_RATIO));
  const candidates = buckets.filter(b => {
    if (b.count < minCount) return false;
    if ((b.avgHighReturn ?? -1) < (allAvgHighReturn ?? 0)) return false;
    if (b.avgDrawdownFromPeakClose != null && b.avgDrawdownFromPeakClose > CONFIG.SUGGEST_DRAWDOWN_MAX) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort((a, b) => (a.bucketIdx || 0) - (b.bucketIdx || 0));
  return {
    bucketKeys: ordered.map(b => b.key),
    bucketLabels: ordered.map(b => b.label),
    minCountRequired: minCount,
    reason: `사례 ${minCount}건 이상이고 평균 상승률이 전체 평균 이상이며 상승 후 하락률이 ${CONFIG.SUGGEST_DRAWDOWN_MAX}% 이내인 구간`,
  };
}

// ─────────────────────── extractor ───────────────────────

function extractBmsMetrics(w) {
  const a = w.analysis || {};
  return {
    boxRangePct: a.boxAnalysis?.boxRangePct,
    boxRangeDays: a.boxAnalysis?.boxRangeDays,
    supplyAboveRatio: a.supplyZone?.aboveCloseRatio,
    drawdownFromPeakClose: a.postAnalysis?.drawdownFromPeakClose,
    drawdownFromPeakLow: a.postAnalysis?.drawdownFromPeakLow,
    preAccumulationRatio: a.preAccumulation?.accumulatedValueRatio,
  };
}

function extractPosition(w) {
  const p = w.analysis?.pricePosition || {};
  const closeFromLow60 = p.closeFromLow60;
  const closeFromHigh60 = p.closeFromHigh60;
  const positionInRange = computePositionInRange(closeFromLow60, closeFromHigh60);
  const lowBucket = findBucket(closeFromLow60, CONFIG.LOW60_BUCKETS);
  const highBucket = findBucket(closeFromHigh60, CONFIG.HIGH60_BUCKETS);
  const positionBucket = findBucket(positionInRange, CONFIG.POSITION_BUCKETS);
  return {
    closeFromLow60, closeFromHigh60, positionInRange,
    closeFromLow120: p.closeFromLow120, closeFromHigh120: p.closeFromHigh120,
    closeFrom52WeekHigh: p.closeFrom52WeekHigh,
    closeFromBoxLow: p.closeFromBoxLow, closeFromBoxHigh: p.closeFromBoxHigh,
    lowBucket: { key: lowBucket.key, label: lowBucket.label, role: lowBucket.role, explanation: lowBucket.explanation },
    highBucket: { key: highBucket.key, label: highBucket.label, role: highBucket.role, explanation: highBucket.explanation },
    positionBucket: { key: positionBucket.key, label: positionBucket.label, role: positionBucket.role, explanation: positionBucket.explanation },
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Price-Position Bucket Audit');
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

  const winners = targets.map(w => {
    const position = extractPosition(w);
    const bmsMetrics = extractBmsMetrics(w);
    const out = {
      code: w.code, name: w.name, market: w.market, marketCap: w.marketCap,
      grade: w._grade,
      startDate: w.startDate, peakDate: w.peakDate,
      startClose: w.startClose, peakHigh: w.peakHigh, peakClose: w.peakClose,
      daysToPeak: w.daysToPeak,
      maxHighReturn: w.maxHighReturn,
      maxCloseReturn: w.maxCloseReturn,
      position,
      bmsMetrics,
    };
    out.oneLineSummary = buildOneLine(out);
    return out;
  });

  const cReference = cReferenceSrc.map(w => {
    const position = extractPosition(w);
    return {
      code: w.code, name: w.name, grade: 'C',
      startDate: w.startDate, maxHighReturn: w.maxHighReturn, maxCloseReturn: w.maxCloseReturn,
      daysToPeak: w.daysToPeak,
      position,
      bmsMetrics: extractBmsMetrics(w),
    };
  });

  const allAvgHighReturn = avg(winners.map(w => w.maxHighReturn));
  const allMedHighReturn = median(winners.map(w => w.maxHighReturn));
  const allAvgCloseReturn = avg(winners.map(w => w.maxCloseReturn));
  const allAvgLow60 = avg(winners.map(w => w.position?.closeFromLow60));
  const allAvgHigh60 = avg(winners.map(w => w.position?.closeFromHigh60));
  const allAvgPos = avg(winners.map(w => w.position?.positionInRange));

  // 3개 축 각각 buckets summary
  function buildBucketSummary(buckets, getKey) {
    return buckets.map((b, i) => {
      const items = winners.filter(w => getKey(w) === b.key);
      return { ...b, bucketIdx: i, ...summarizeBucket(items, winners.length) };
    });
  }

  const lowSummary = buildBucketSummary(CONFIG.LOW60_BUCKETS, w => w.position?.lowBucket?.key);
  const highSummary = buildBucketSummary(CONFIG.HIGH60_BUCKETS, w => w.position?.highBucket?.key);
  const positionSummary = buildBucketSummary(CONFIG.POSITION_BUCKETS, w => w.position?.positionBucket?.key);

  // no_data 카운트
  const lowNoData = winners.filter(w => w.position?.lowBucket?.key === 'no_data').length;
  const highNoData = winners.filter(w => w.position?.highBucket?.key === 'no_data').length;
  const posNoData = winners.filter(w => w.position?.positionBucket?.key === 'no_data').length;

  // 핵심 발견
  const keyFindings = {
    low: {
      mostPopulated: pickWinningBucket(lowSummary, b => b.count, '저점 대비 가장 많은 구간'),
      highestReturn: pickWinningBucket(lowSummary, b => b.avgHighReturn, '저점 대비 평균 상승률 최고 구간'),
      largestDrawdown: pickWinningBucket(lowSummary, b => b.avgDrawdownFromPeakClose, '저점 대비 상승 후 하락률 최대 구간'),
    },
    high: {
      mostPopulated: pickWinningBucket(highSummary, b => b.count, '고점 대비 가장 많은 구간'),
      highestReturn: pickWinningBucket(highSummary, b => b.avgHighReturn, '고점 대비 평균 상승률 최고 구간'),
      largestDrawdown: pickWinningBucket(highSummary, b => b.avgDrawdownFromPeakClose, '고점 대비 상승 후 하락률 최대 구간'),
    },
    position: {
      mostPopulated: pickWinningBucket(positionSummary, b => b.count, '박스권 위치 가장 많은 구간'),
      highestReturn: pickWinningBucket(positionSummary, b => b.avgHighReturn, '박스권 위치 평균 상승률 최고 구간'),
      largestDrawdown: pickWinningBucket(positionSummary, b => b.avgDrawdownFromPeakClose, '박스권 위치 상승 후 하락률 최대 구간'),
    },
  };

  // 추천 구간 (각 축 별로)
  const suggested = {
    low: suggestRange(lowSummary, winners.length, allAvgHighReturn),
    high: suggestRange(highSummary, winners.length, allAvgHighReturn),
    position: suggestRange(positionSummary, winners.length, allAvgHighReturn),
  };

  // 결론 자동 생성
  const conclusion = [];
  // 저점 대비 핵심 발견
  const coreLow = lowSummary.find(b => b.key === 'low_25_45');
  const lowOver70 = lowSummary.find(b => b.key === 'low_70_plus');
  if (coreLow && coreLow.count >= 5) {
    conclusion.push(`60일 저점 대비 ${coreLow.label}에 사례 ${coreLow.count}건(${coreLow.share}%)이 몰렸습니다 — BMS 핵심 회복 구간으로 보입니다.`);
  }
  if (lowOver70 && lowOver70.count >= 3 && lowOver70.avgDrawdownFromPeakClose != null && lowOver70.avgDrawdownFromPeakClose > (coreLow?.avgDrawdownFromPeakClose ?? 0)) {
    conclusion.push(`저점 대비 70% 이상 오른 사례는 상승 후 평균 하락률 ${lowOver70.avgDrawdownFromPeakClose}% 로 위쪽 구간보다 흔들림이 컸습니다.`);
  }

  // 고점 대비 핵심 발견
  const coreHighA = highSummary.find(b => b.key === 'high_25_40');
  const coreHighB = highSummary.find(b => b.key === 'high_10_25');
  const nearHigh = highSummary.find(b => b.key === 'high_above_3');
  if (coreHighA && coreHighB) {
    const corePct = round(((coreHighA.count || 0) + (coreHighB.count || 0)) / winners.length * 100, 1);
    conclusion.push(`60일 고점 대비 -25%~-10% / -40%~-25% 구간에 합계 ${corePct}%가 분포 — 정석 BMS는 위쪽 공간이 충분한 상태에서 시작하는 경향이 있습니다.`);
  }
  if (nearHigh && nearHigh.count >= 3) {
    conclusion.push(`60일 신고가 근처(-3% 이상)에서 시작한 사례는 ${nearHigh.count}건(${nearHigh.share}%)으로 적습니다. 정상 BMS 위치는 신고가 근처가 아닌 박스 안에 있는 경향입니다.`);
  }

  // 박스권 위치 핵심 발견
  const boxLow = positionSummary.find(b => b.key === 'pos_0_30');
  const boxMid = positionSummary.find(b => b.key === 'pos_30_70');
  const boxTop = positionSummary.find(b => b.key === 'pos_70_100');
  if (boxLow && boxMid) {
    const insideBoxPct = round(((boxLow.count || 0) + (boxMid.count || 0) + (boxTop?.count || 0)) / winners.length * 100, 1);
    conclusion.push(`60일 박스권 안에서 시작한 사례가 전체의 ${insideBoxPct}% 입니다. BMS 정제 사례는 대부분 박스권 안에서 출발했습니다.`);
  }
  if (boxLow && boxMid && (boxLow.avgHighReturn || 0) > (boxTop?.avgHighReturn || 0)) {
    conclusion.push(`박스 하단·중간에서 시작한 사례가 박스 상단·돌파 시작보다 평균 상승률이 좋게 나타났습니다.`);
  }

  conclusion.push('이번 보고서는 BMS 본체의 또 다른 핵심 변수(가격 위치)를 단독으로 본 감사 보고서입니다. 가격 위치 구간을 현재 후보 필터로 바로 적용하지 않습니다. BMS 본체는 winner-scan + winner-quality-filter 2단계로만 단순하게 유지합니다.');

  // 요약
  const summary = {
    totalAnalyzed: winners.length,
    gradeACount: winners.filter(w => w.grade === 'A').length,
    gradeBCount: winners.filter(w => w.grade === 'B').length,
    gradeCCount: CONFIG.INCLUDE_C ? winners.filter(w => w.grade === 'C').length : cReference.length,
    cIncludedInGroupCompare: CONFIG.INCLUDE_C,
    allAvgHighReturn,
    allMedHighReturn,
    allAvgCloseReturn,
    allAvgLow60,
    allAvgHigh60,
    allAvgPositionInRange: allAvgPos,
    lowNoDataCount: lowNoData,
    highNoDataCount: highNoData,
    posNoDataCount: posNoData,
    mostPopulatedLowBucket: keyFindings.low.mostPopulated?.bucketLabel ?? null,
    mostPopulatedHighBucket: keyFindings.high.mostPopulated?.bucketLabel ?? null,
    mostPopulatedPositionBucket: keyFindings.position.mostPopulated?.bucketLabel ?? null,
  };

  // 출력
  const out = {
    meta: {
      version: 'bms-price-position-bucket-audit-v1',
      generatedAt: new Date().toISOString(),
      title: 'BMS 가격 위치 구간 감사 보고서',
      purpose: 'BMS 정제 상승 사례들의 상승 시작점이 60일 저점/고점 대비 어디 있었는지를 구간별로 확인하는 감사 보고서. 현재 후보를 찾는 보드가 아닙니다.',
      dataPolicy: 'analysis.pricePosition (winner-quality-filter 가 startDate 기준 60일 OHLC로 계산한 값) 사용. 박스권 위치는 closeFromLow60 / (closeFromLow60 - closeFromHigh60) * 100 으로 도출.',
      gradesAnalyzed: targetGrades,
    },
    config: CONFIG,
    summary,
    lowSummary,
    highSummary,
    positionSummary,
    keyFindings,
    suggested,
    winners,
    cReference: cReference.slice(0, 100),
    conclusion,
    dataLimit: [
      '가격 위치는 60일 OHLC 기준입니다. 60일 미만 데이터를 가진 종목은 정상 사례 정제 단계에서 이미 제외되었거나 일부 값이 null 처리됨.',
      '박스권 위치(positionInRange)는 closeFromLow60 / (closeFromLow60 - closeFromHigh60) * 100 공식으로 계산. 음수가 나오면 60일 저점 이탈, 100 초과면 60일 신고가 돌파를 의미.',
      'C 등급은 ' + (CONFIG.INCLUDE_C ? '메인 그룹에 포함됨' : '참고용 비율만 별도 표시') + '.',
      '이 보고서는 매수 신호가 아니라 BMS 정제 상승 사례의 가격 위치 성격을 확인하는 감사 보고서임.',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // 콘솔 출력
  console.log(`\n📊 핵심 지표:`);
  console.log(`  분석 대상: ${winners.length}건 (A=${summary.gradeACount}, B=${summary.gradeBCount}${CONFIG.INCLUDE_C ? ', C=' + summary.gradeCCount : ''})`);
  console.log(`  전체 평균 상승률: +${allAvgHighReturn}% / 종가 +${allAvgCloseReturn}%`);
  console.log(`  평균 60일 저점 대비: +${allAvgLow60}% / 평균 60일 고점 대비: ${allAvgHigh60}%`);
  console.log(`  평균 박스권 위치: ${allAvgPos}%`);

  console.log(`\n📊 60일 저점 대비 구간:`);
  lowSummary.forEach(b => {
    if (!b.count) return;
    console.log(`  ${b.label.padEnd(28)} n=${String(b.count).padStart(4)} ${String(b.share + '%').padStart(7)} avgH=${String(b.avgHighReturn).padStart(6)}% medH=${String(b.medHighReturn).padStart(6)}% close=${String(b.avgCloseReturn).padStart(6)}% 하락=${String(b.avgDrawdownFromPeakClose).padStart(5)}% A=${String(b.aRate).padStart(5)}%`);
  });

  console.log(`\n📊 60일 고점 대비 구간:`);
  highSummary.forEach(b => {
    if (!b.count) return;
    console.log(`  ${b.label.padEnd(28)} n=${String(b.count).padStart(4)} ${String(b.share + '%').padStart(7)} avgH=${String(b.avgHighReturn).padStart(6)}% medH=${String(b.medHighReturn).padStart(6)}% close=${String(b.avgCloseReturn).padStart(6)}% 하락=${String(b.avgDrawdownFromPeakClose).padStart(5)}% A=${String(b.aRate).padStart(5)}%`);
  });

  console.log(`\n📊 박스권 위치 구간:`);
  positionSummary.forEach(b => {
    if (!b.count) return;
    console.log(`  ${b.label.padEnd(28)} n=${String(b.count).padStart(4)} ${String(b.share + '%').padStart(7)} avgH=${String(b.avgHighReturn).padStart(6)}% medH=${String(b.medHighReturn).padStart(6)}% close=${String(b.avgCloseReturn).padStart(6)}% 하락=${String(b.avgDrawdownFromPeakClose).padStart(5)}% A=${String(b.aRate).padStart(5)}%`);
  });

  console.log(`\n🎯 추천 참고 구간:`);
  ['low', 'high', 'position'].forEach(axis => {
    const sg = suggested[axis];
    if (!sg) return;
    console.log(`  ${axis === 'low' ? '저점 대비' : axis === 'high' ? '고점 대비' : '박스권 위치'}: ${sg.bucketLabels.join(' + ')}`);
  });

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
<title>BMS 가격 위치 구간 감사 보고서</title>
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
.big-tile .value { font-size: 17px; font-weight: 700; color: #f1f5f9; line-height: 1.2; margin-top: 3px; }
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
.row-suggest td { background: rgba(20, 184, 166, 0.16) !important; }
.row-warn td { background: rgba(239, 68, 68, 0.10) !important; }
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
.bp-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.bp-low_0_10, .bp-high_above_3 { background: #7f1d1d; color: #fca5a5; }
.bp-low_70_plus { background: #7f1d1d; color: #fca5a5; }
.bp-low_10_25, .bp-high_below_40 { background: #475569; color: #cbd5e1; }
.bp-low_25_45, .bp-high_25_40, .bp-high_10_25 { background: #14532d; color: #a7f3d0; }
.bp-low_45_70, .bp-high_3_10 { background: #92400e; color: #fde047; }
.bp-pos_0_30, .bp-pos_30_70 { background: #14532d; color: #a7f3d0; }
.bp-pos_70_100 { background: #1e40af; color: #dbeafe; }
.bp-pos_above_100 { background: #92400e; color: #fde047; }
.bp-pos_below_0 { background: #7f1d1d; color: #fca5a5; }
.bp-no_data { background: #334155; color: #94a3b8; }

table.list tbody tr.detail { display: none; background: #0c1729; }
table.list tbody tr.detail.show { display: table-row; }
table.list tbody tr.detail td { padding: 14px 18px; border-bottom: 1px solid #1e3a5f; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 24px; font-size: 12px; }
.detail-block h4 { margin: 0 0 6px; font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; line-height: 1.6; }
.kv .k { color: #64748b; }
.kv .v { color: #cbd5e1; font-variant-numeric: tabular-nums; }

.bar-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.bar-row .lbl { width: 200px; font-size: 12px; color: #cbd5e1; }
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
  .bar-row .lbl { width: 110px; }
  .bar-row .val { width: 90px; }
}
</style>
</head>
<body>

<h1 id="page-title">BMS 가격 위치 구간 감사 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 이 보고서는 BMS 정제 상승 사례들의 상승 시작점이 60일 박스권 안에서 어디 있었는지를 구간별로 확인하는 감사 보고서입니다.
  <strong>현재 후보를 찾는 보드가 아닙니다.</strong> 가격 위치 구간을 현재 후보 필터로 바로 적용하지 않습니다.
</div>

<div class="note-box">
  💡 <strong>"가격 위치"란?</strong> 상승 시작일의 종가가 최근 60일 동안의 저점/고점과 비교해 어디에 있었는지를 보는 항목입니다.
  <br>저점 대비 = 60일 저점에서 몇 % 위였는지 / 고점 대비 = 60일 고점에서 몇 % 아래였는지
  <br>박스권 위치 = 60일 저점~고점 범위 안에서 몇 % 지점에 있었는지 (0% = 저점, 100% = 고점)
</div>

<h2>📊 핵심 지표</h2>
<div class="big-summary" id="big-summary"></div>

<h2>📊 60일 저점 대비 위치 분포</h2>
<div id="low-distribution"></div>
<h3>구간별 비교 (저점 대비)</h3>
<div id="low-compare-table"></div>

<h2>📊 60일 고점 대비 위치 분포</h2>
<div id="high-distribution"></div>
<h3>구간별 비교 (고점 대비)</h3>
<div id="high-compare-table"></div>

<h2>📊 박스권 위치 (저점~고점 범위 안 위치) 분포</h2>
<div id="position-distribution"></div>
<h3>구간별 비교 (박스권 위치)</h3>
<div id="position-compare-table"></div>

<h2>🎯 추천 참고 구간 (자동 도출)</h2>
<div id="suggested-section" class="purpose-box" style="border-left-color:#10b981;"></div>

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
        <th class="numeric">저점 대비</th>
        <th class="numeric">고점 대비</th>
        <th class="numeric">박스 위치</th>
        <th>저점 구간</th>
        <th class="col-mobile-hide">고점 구간</th>
        <th class="col-mobile-hide">박스 구간</th>
        <th class="col-summary col-mobile-hide">한 줄 해석</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<h2>📝 결론</h2>
<div id="conclusion-box" class="purpose-box" style="border-left-color:#10b981;"></div>

<footer class="foot">
  <strong>매수 신호가 아닙니다.</strong> BMS Price-Position Bucket Audit는 <em>BMS 정제 상승 사례에서 상승 시작점의 60일 가격 위치 분포·성과 차이</em>를 확인하는 감사 도구입니다.
  가격 위치 구간을 처음부터 BMS 필터로 쓰지 않습니다. 본체 이해를 위한 참고 자료로만 활용하세요.
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
  function bpCls(k) { return 'bp-' + (k || 'no_data'); }

  document.getElementById('subtitle').innerHTML =
    '분석 대상 ' + summary.totalAnalyzed + '건 (A=' + summary.gradeACount + ' B=' + summary.gradeBCount + (summary.cIncludedInGroupCompare ? ' C=' + summary.gradeCCount : '') + ') · 평균 저점대비 ' + fmtPct(summary.allAvgLow60) + ' / 평균 고점대비 ' + fmtPct(summary.allAvgHigh60) + ' / 평균 박스 위치 ' + fmtPctRaw(summary.allAvgPositionInRange) + ' · 생성 ' +
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
    { label: '평균 60일 저점 대비', value: fmtPct(summary.allAvgLow60), sub: '저점에서 몇 % 위' },
    { label: '평균 60일 고점 대비', value: fmtPct(summary.allAvgHigh60), sub: '고점에서 몇 % 아래' },
    { label: '평균 박스권 위치', value: fmtPctRaw(summary.allAvgPositionInRange), sub: '0% 저점 ~ 100% 고점' },
    { label: '저점 대비 가장 많은 구간', value: summary.mostPopulatedLowBucket || '-', sub: '사례 수 기준' },
    { label: '고점 대비 가장 많은 구간', value: summary.mostPopulatedHighBucket || '-', sub: '사례 수 기준' },
    { label: '박스 위치 가장 많은 구간', value: summary.mostPopulatedPositionBucket || '-', sub: '사례 수 기준', cls: 'suggest' },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div><div class="sub">' + t.sub + '</div>';
    ts.appendChild(el);
  });

  // 분포 막대 그래프 + 비교 표 렌더러
  function renderDistAndTable(distId, tableId, summaryArr, suggestKeys) {
    const maxCount = Math.max(1, ...summaryArr.map(b => b.count || 0));
    let distHtml = '';
    summaryArr.forEach(b => {
      if (!b.count) {
        distHtml += '<div class="bar-row">' +
          '<div class="lbl"><span class="bp-pill ' + bpCls(b.key) + '">' + escapeHtml(b.label) + '</span></div>' +
          '<div class="bar"></div>' +
          '<div class="val">0건</div>' +
        '</div>';
        return;
      }
      const widthPct = ((b.count || 0) / maxCount * 100).toFixed(1);
      distHtml += '<div class="bar-row">' +
        '<div class="lbl"><span class="bp-pill ' + bpCls(b.key) + '">' + escapeHtml(b.label) + '</span></div>' +
        '<div class="bar"><span class="fill" style="width:' + widthPct + '%;"></span></div>' +
        '<div class="val">' + b.count + '건 (' + fmtPctRaw(b.share) + ')</div>' +
      '</div>';
    });
    document.getElementById(distId).innerHTML = distHtml;

    let tHtml = '<table class="cmp"><thead><tr>' +
      '<th>구간</th><th>n</th><th>비율</th><th>역할</th><th>평균 상승률</th><th>중앙값</th><th>평균 종가</th>' +
      '<th>평균 소요</th><th>평균 박스폭</th><th>오른뒤 흔들림</th><th>위쪽 매물</th><th>A 비율</th>' +
      '</tr></thead><tbody>';
    summaryArr.forEach(b => {
      if (!b.count) return;
      let cls = '';
      if (suggestKeys && suggestKeys.includes(b.key)) cls = 'row-suggest';
      if (b.role === '강한 주의' || b.role === '약함') cls = 'row-warn';
      tHtml += '<tr class="' + cls + '">' +
        '<td><span class="bp-pill ' + bpCls(b.key) + '">' + escapeHtml(b.label) + '</span></td>' +
        '<td>' + b.count + '</td>' +
        '<td>' + fmtPctRaw(b.share) + '</td>' +
        '<td style="font-size:11px;color:#94a3b8;">' + escapeHtml(b.role) + '</td>' +
        '<td class="cell-pos">' + fmtPct(b.avgHighReturn) + '</td>' +
        '<td>' + fmtPct(b.medHighReturn) + '</td>' +
        '<td class="' + clsRet(b.avgCloseReturn) + '">' + fmtPct(b.avgCloseReturn) + '</td>' +
        '<td>' + (b.avgDaysToPeak != null ? fmtNum(b.avgDaysToPeak) + '일' : '-') + '</td>' +
        '<td>' + fmtPctRaw(b.avgBoxRangePct) + '</td>' +
        '<td class="cell-neg">' + fmtPctRaw(b.avgDrawdownFromPeakClose) + '</td>' +
        '<td>' + fmtPctRaw(b.avgSupplyAbove) + '</td>' +
        '<td>' + fmtPctRaw(b.aRate) + '</td>' +
      '</tr>';
    });
    tHtml += '</tbody></table>';
    document.getElementById(tableId).innerHTML = tHtml;
  }

  const sg = data.suggested || {};
  renderDistAndTable('low-distribution', 'low-compare-table', data.lowSummary || [], sg.low?.bucketKeys);
  renderDistAndTable('high-distribution', 'high-compare-table', data.highSummary || [], sg.high?.bucketKeys);
  renderDistAndTable('position-distribution', 'position-compare-table', data.positionSummary || [], sg.position?.bucketKeys);

  // 추천 구간
  const sgEl = document.getElementById('suggested-section');
  function renderSuggest(axis, label) {
    const s = sg[axis];
    if (!s) return '<p><strong>' + label + ':</strong> 추천 가능한 구간 없음 (조건 미달)</p>';
    const labels = (s.bucketLabels || []).map((l, i) =>
      '<span class="bp-pill ' + bpCls((s.bucketKeys || [])[i]) + '">' + escapeHtml(l) + '</span>'
    ).join(' ');
    return '<p><strong>' + label + ':</strong> ' + labels + '<br><small style="color:#94a3b8;">사유: ' + escapeHtml(s.reason) + '</small></p>';
  }
  sgEl.innerHTML =
    renderSuggest('low', '저점 대비 추천 구간') +
    renderSuggest('high', '고점 대비 추천 구간') +
    renderSuggest('position', '박스권 위치 추천 구간') +
    '<small style="color:#fde68a;">⚠️ 위 구간은 BMS 본체 필터가 아닙니다. 과거 사례 이해를 위한 참고 기준입니다.</small>';

  // 결론
  document.getElementById('conclusion-box').innerHTML =
    '<strong>📌 자동 결론:</strong><br>' + (data.conclusion || []).map(c => '• ' + escapeHtml(c)).join('<br><br>');

  // 탭
  const tabs = [{ id: 'all', label: '전체 (' + winners.length + ')' }];
  // 박스 위치 탭
  ['pos_below_0', 'pos_0_30', 'pos_30_70', 'pos_70_100', 'pos_above_100'].forEach(k => {
    const cnt = winners.filter(w => w.position?.positionBucket?.key === k).length;
    if (cnt === 0) return;
    const lbl = (data.positionSummary || []).find(b => b.key === k)?.label || k;
    tabs.push({ id: 'pos:' + k, label: lbl + ' (' + cnt + ')' });
  });
  // 저점/고점 핵심 탭
  ['low_25_45'].forEach(k => {
    const cnt = winners.filter(w => w.position?.lowBucket?.key === k).length;
    if (cnt > 0) tabs.push({ id: 'low:' + k, label: '저점 +25~45% (' + cnt + ')' });
  });
  ['high_25_40', 'high_10_25'].forEach(k => {
    const cnt = winners.filter(w => w.position?.highBucket?.key === k).length;
    if (cnt > 0) {
      const lbl = (data.highSummary || []).find(b => b.key === k)?.label || k;
      tabs.push({ id: 'high:' + k, label: lbl + ' (' + cnt + ')' });
    }
  });
  // 등급 탭
  ['A', 'B'].forEach(g => {
    const cnt = winners.filter(w => w.grade === g).length;
    if (cnt > 0) tabs.push({ id: 'grade:' + g, label: g + '등급 (' + cnt + ')' });
  });

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
    if (activeTab.startsWith('pos:')) return winners.filter(w => w.position?.positionBucket?.key === activeTab.slice(4));
    if (activeTab.startsWith('low:')) return winners.filter(w => w.position?.lowBucket?.key === activeTab.slice(4));
    if (activeTab.startsWith('high:')) return winners.filter(w => w.position?.highBucket?.key === activeTab.slice(5));
    if (activeTab.startsWith('grade:')) return winners.filter(w => w.grade === activeTab.slice(6));
    return winners;
  }

  const tbody = document.getElementById('list-body');
  function renderList() {
    tbody.innerHTML = '';
    let list = pickList();
    list = [...list].sort((a, b) => b.maxHighReturn - a.maxHighReturn);
    list.forEach((w, i) => {
      const p = w.position || {};
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
        '<td class="numeric" style="font-weight:600;color:#5eead4;">' + fmtPct(p.closeFromLow60) + '</td>' +
        '<td class="numeric" style="font-weight:600;color:#fbbf24;">' + fmtPct(p.closeFromHigh60) + '</td>' +
        '<td class="numeric">' + fmtPctRaw(p.positionInRange) + '</td>' +
        '<td><span class="bp-pill ' + bpCls(p.lowBucket?.key) + '">' + escapeHtml(p.lowBucket?.label || '-') + '</span></td>' +
        '<td class="col-mobile-hide"><span class="bp-pill ' + bpCls(p.highBucket?.key) + '">' + escapeHtml(p.highBucket?.label || '-') + '</span></td>' +
        '<td class="col-mobile-hide"><span class="bp-pill ' + bpCls(p.positionBucket?.key) + '">' + escapeHtml(p.positionBucket?.label || '-') + '</span></td>' +
        '<td class="col-summary col-mobile-hide">' + escapeHtml(w.oneLineSummary || '') + '</td>';
      const trd = document.createElement('tr');
      trd.className = 'detail';
      trd.innerHTML = '<td colspan="14">' + buildDetailHtml(w) + '</td>';
      tr.addEventListener('click', () => {
        tr.classList.toggle('expanded');
        trd.classList.toggle('show');
      });
      tbody.appendChild(tr);
      tbody.appendChild(trd);
    });
  }

  function buildDetailHtml(w) {
    const p = w.position || {};
    const m = w.bmsMetrics || {};
    return '<div class="detail-grid">' +
      '<div class="detail-block"><h4>📌 BMS 상승 사례</h4>' +
        '<div class="kv">' +
          '<div class="k">등급</div><div class="v">' + escapeHtml(w.grade || '-') + '</div>' +
          '<div class="k">시총</div><div class="v">' + fmtMc(w.marketCap) + '</div>' +
          '<div class="k">상승 시작일</div><div class="v">' + fmtDate(w.startDate) + '</div>' +
          '<div class="k">시작 종가</div><div class="v">' + fmtPrice(w.startClose) + '</div>' +
          '<div class="k">+40% 도달일</div><div class="v">' + fmtDate(w.peakDate) + '</div>' +
          '<div class="k">고가 상승률</div><div class="v cell-pos">' + fmtPct(w.maxHighReturn) + '</div>' +
          '<div class="k">상승 소요</div><div class="v">' + (w.daysToPeak || '-') + '거래일</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block"><h4>📍 60일 저점 대비 위치</h4>' +
        '<div class="kv">' +
          '<div class="k">저점 대비</div><div class="v" style="color:#5eead4;font-weight:700;">' + fmtPct(p.closeFromLow60) + '</div>' +
          '<div class="k">구간</div><div class="v"><span class="bp-pill ' + bpCls(p.lowBucket?.key) + '">' + escapeHtml(p.lowBucket?.label || '-') + '</span></div>' +
          '<div class="k">역할</div><div class="v">' + escapeHtml(p.lowBucket?.role || '-') + '</div>' +
        '</div>' +
        '<p style="color:#cbd5e1;font-size:11.5px;line-height:1.5;margin-top:6px;">' + escapeHtml(p.lowBucket?.explanation || '') + '</p>' +
      '</div>' +
      '<div class="detail-block"><h4>📍 60일 고점 대비 위치</h4>' +
        '<div class="kv">' +
          '<div class="k">고점 대비</div><div class="v" style="color:#fbbf24;font-weight:700;">' + fmtPct(p.closeFromHigh60) + '</div>' +
          '<div class="k">구간</div><div class="v"><span class="bp-pill ' + bpCls(p.highBucket?.key) + '">' + escapeHtml(p.highBucket?.label || '-') + '</span></div>' +
          '<div class="k">역할</div><div class="v">' + escapeHtml(p.highBucket?.role || '-') + '</div>' +
        '</div>' +
        '<p style="color:#cbd5e1;font-size:11.5px;line-height:1.5;margin-top:6px;">' + escapeHtml(p.highBucket?.explanation || '') + '</p>' +
      '</div>' +
      '<div class="detail-block"><h4>📦 박스권 위치 (60일)</h4>' +
        '<div class="kv">' +
          '<div class="k">박스권 위치</div><div class="v" style="font-weight:700;">' + fmtPctRaw(p.positionInRange) + '</div>' +
          '<div class="k">구간</div><div class="v"><span class="bp-pill ' + bpCls(p.positionBucket?.key) + '">' + escapeHtml(p.positionBucket?.label || '-') + '</span></div>' +
          '<div class="k">역할</div><div class="v">' + escapeHtml(p.positionBucket?.role || '-') + '</div>' +
        '</div>' +
        '<p style="color:#cbd5e1;font-size:11.5px;line-height:1.5;margin-top:6px;">' + escapeHtml(p.positionBucket?.explanation || '') + '</p>' +
      '</div>' +
      '<div class="detail-block"><h4>📊 보조 지표</h4>' +
        '<div class="kv">' +
          '<div class="k">120일 저점 대비</div><div class="v">' + fmtPct(p.closeFromLow120) + '</div>' +
          '<div class="k">120일 고점 대비</div><div class="v">' + fmtPct(p.closeFromHigh120) + '</div>' +
          '<div class="k">52주 고점 대비</div><div class="v">' + fmtPct(p.closeFrom52WeekHigh) + '</div>' +
          '<div class="k">박스 하단 대비</div><div class="v">' + fmtPct(p.closeFromBoxLow) + '</div>' +
          '<div class="k">박스 상단 대비</div><div class="v">' + fmtPct(p.closeFromBoxHigh) + '</div>' +
          '<div class="k">박스권 폭</div><div class="v">' + fmtPctRaw(m.boxRangePct) + '</div>' +
          '<div class="k">위쪽 매물 부담</div><div class="v">' + fmtPctRaw(m.supplyAboveRatio) + '</div>' +
          '<div class="k">상승 후 종가 하락</div><div class="v cell-neg">' + fmtPctRaw(m.drawdownFromPeakClose) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block" style="grid-column: 1 / -1;"><h4>한 줄 해석</h4>' +
        '<p style="color:#fde68a;font-size:13px;line-height:1.6;">' + escapeHtml(w.oneLineSummary || '') + '</p>' +
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
