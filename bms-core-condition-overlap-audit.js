#!/usr/bin/env node
/**
 * BMS Core Condition Overlap Audit
 *
 * 목적:
 *   BMS 정제 상승 사례에서 두 핵심 변수가 동시에 만족될 때 얼마나 의미가 있는지 감사한다.
 *     1) 시총 대비 상승 전 들어온 돈
 *     2) 상승 시작점의 60일 가격 위치 (저점 대비 + 고점 대비)
 *
 *   현재 후보 보드를 만들지 않는다. QVA·장기횡보·박스권 폭은 이번 분석에 섞지 않는다.
 *   오로지 "들어온 돈 + 가격 위치" 조합의 차별력만 본다.
 *
 * 데이터 누수 방지:
 *   각 winner 의 analysis.preAccumulation.accumulatedValueRatio /
 *   analysis.pricePosition.closeFromLow60 / closeFromHigh60 값을 그대로 사용.
 *   winner-quality-filter 가 startDate 시점 데이터로 계산한 값이라 누수 없음.
 *
 * 입력:
 *   - reports/bms-winner-quality-filter-result.json (cleanWinners + excludedWinners)
 *
 * 출력:
 *   - reports/bms-core-condition-overlap-audit-result.json
 *   - reports/bms-core-condition-overlap-audit-result.html
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const INPUT_FILE = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-core-condition-overlap-audit-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-core-condition-overlap-audit-result.html');

const CONFIG = {
  // 정석 BMS 조건 — 5~10% 보조 구간까지 포함하는 넓은 조건
  CLASSIC: {
    label: '정석 BMS 조건',
    description: '상승 전 거래대금이 적당히 지나갔고, 주가는 저점에서 어느 정도 회복했지만 아직 고점까지 공간이 남아 있는 조건입니다.',
    valueRatioMin: 5, valueRatioMax: 40,
    low60Min: 10, low60Max: 45,
    high60Min: -40, high60Max: -10,
  },
  // 강한 BMS 조건 — 들어온 돈도 BMS 핵심(10~40%)
  STRONG: {
    label: '강한 BMS 조건',
    description: '상승 전 거래대금이 BMS 중심 구간에 있고, 가격 위치도 저점 회복·고점 여유 조건에 들어오는 더 엄격한 조건입니다.',
    valueRatioMin: 10, valueRatioMax: 40,
    low60Min: 10, low60Max: 45,
    high60Min: -40, high60Max: -10,
  },
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

// ─────────────────────── 조건 검사 ───────────────────────

function checkRule(rule, vRatio, lf, hf) {
  const valueRatio = vRatio != null && isFinite(vRatio) && vRatio >= rule.valueRatioMin && vRatio <= rule.valueRatioMax;
  const lowPosition = lf != null && isFinite(lf) && lf >= rule.low60Min && lf <= rule.low60Max;
  const highPosition = hf != null && isFinite(hf) && hf >= rule.high60Min && hf <= rule.high60Max;
  return {
    valueRatio, lowPosition, highPosition,
    matches: valueRatio && lowPosition && highPosition,
  };
}

function getFailedReasons(rule, vRatio, lf, hf) {
  const reasons = [];
  if (vRatio == null || !isFinite(vRatio)) reasons.push('데이터 부족 (들어온 돈)');
  else if (vRatio < rule.valueRatioMin) reasons.push(`들어온 돈 부족 (${vRatio}% < ${rule.valueRatioMin}%)`);
  else if (vRatio > rule.valueRatioMax) reasons.push(`들어온 돈 과다 (${vRatio}% > ${rule.valueRatioMax}%)`);

  if (lf == null || !isFinite(lf)) reasons.push('데이터 부족 (저점 대비)');
  else if (lf < rule.low60Min) reasons.push(`저점 대비 너무 낮음 (+${lf}% < +${rule.low60Min}%)`);
  else if (lf > rule.low60Max) reasons.push(`저점 대비 너무 높음 (+${lf}% > +${rule.low60Max}%)`);

  if (hf == null || !isFinite(hf)) reasons.push('데이터 부족 (고점 대비)');
  else if (hf < rule.high60Min) reasons.push(`고점과 너무 멂 (${hf}% < ${rule.high60Min}%)`);
  else if (hf > rule.high60Max) reasons.push(`고점 근처 (${hf}% > ${rule.high60Max}%)`);

  return reasons;
}

// 조건 라벨/역할 (사용자 시야용 단일 라벨)
function buildConditionLabel(c) {
  if (c.matchesStrongBms) return { label: '강한 BMS 조건 만족', role: '강한 핵심 조건' };
  if (c.matchesClassicBms) return { label: '정석 BMS 조건 만족', role: '핵심 조건' };

  const v = c.classicPass.valueRatio;
  const l = c.classicPass.lowPosition;
  const h = c.classicPass.highPosition;
  const vR = c.preAccumulationRatio;
  const lf = c.closeFromLow60;
  const hf = c.closeFromHigh60;

  // 가격 둘 다 통과 + 들어온 돈만 실패
  if (l && h && !v) {
    if (vR != null && vR < CONFIG.CLASSIC.valueRatioMin) return { label: '가격 위치는 좋지만 들어온 돈 부족', role: '일부 조건만 만족' };
    if (vR != null && vR > CONFIG.CLASSIC.valueRatioMax) return { label: '거래 과다지만 가격은 좋음', role: '주의' };
    return { label: '가격 위치만 만족', role: '일부 조건만 만족' };
  }
  // 들어온 돈 통과 + 위치 일부 실패
  if (v && (!l || !h)) {
    if (hf != null && hf > CONFIG.CLASSIC.high60Max) return { label: '들어온 돈은 좋지만 고점 근처', role: '주의' };
    if (hf != null && hf < CONFIG.CLASSIC.high60Min) return { label: '들어온 돈은 좋지만 고점과 너무 멂', role: '일부 조건만 만족' };
    if (lf != null && lf > CONFIG.CLASSIC.low60Max) return { label: '들어온 돈은 좋지만 저점에서 너무 오름', role: '주의' };
    if (lf != null && lf < CONFIG.CLASSIC.low60Min) return { label: '들어온 돈은 좋지만 저점 근처', role: '일부 조건만 만족' };
    return { label: '들어온 돈은 좋지만 가격 위치 이탈', role: '일부 조건만 만족' };
  }
  // 위치만 일부 통과 (l 또는 h 만)
  if (!v && (l || h)) {
    if (vR != null && vR > CONFIG.CLASSIC.valueRatioMax) return { label: '거래 과다 주의', role: '주의' };
    return { label: '일부 조건만 만족', role: '일부 조건만 만족' };
  }
  // 모두 실패
  return { label: '조건 미충족', role: '조건 외' };
}

// 7-셀 조건 조합 매트릭스
function classifyMatrix(c) {
  const v = c.classicPass.valueRatio;
  const l = c.classicPass.lowPosition;
  const h = c.classicPass.highPosition;
  const vR = c.preAccumulationRatio;
  const hf = c.closeFromHigh60;

  if (v && l && h) return { key: 'all_pass', label: '세 조건 모두 만족' };
  if (v && !l && !h) return { key: 'value_only', label: '들어온 돈만 만족' };
  if (!v && l && h) {
    if (vR != null && vR < CONFIG.CLASSIC.valueRatioMin) return { key: 'pos_value_low', label: '가격은 좋지만 들어온 돈 부족' };
    if (vR != null && vR > CONFIG.CLASSIC.valueRatioMax) return { key: 'pos_value_high', label: '거래 과다지만 가격은 좋음' };
    return { key: 'position_only', label: '가격 위치만 만족' };
  }
  if (v && l && !h && hf != null && hf > CONFIG.CLASSIC.high60Max) return { key: 'value_pos_near_high', label: '들어온 돈은 좋지만 고점 근처' };
  if (!v && !l && !h) return { key: 'none', label: '모두 미충족' };
  return { key: 'other', label: '기타 조합' };
}

// 한 줄 해석
function buildOneLine(c) {
  if (c.matchesStrongBms) return '시총 대비 들어온 돈도 BMS 중심 구간이고 가격 위치도 저점 회복·고점 여유 조건에 들어온, 강한 BMS 조건 만족 사례입니다.';
  if (c.matchesClassicBms) return '시총 대비 들어온 돈과 가격 위치가 모두 정석 BMS 조건에 들어온 사례입니다.';

  const v = c.classicPass.valueRatio;
  const l = c.classicPass.lowPosition;
  const h = c.classicPass.highPosition;
  const vR = c.preAccumulationRatio;

  if (l && h && !v) {
    if (vR != null && vR < CONFIG.CLASSIC.valueRatioMin) return '가격 위치는 좋지만 상승 전 들어온 돈이 부족했던 사례입니다.';
    if (vR != null && vR > CONFIG.CLASSIC.valueRatioMax) return '가격 위치는 좋지만 상승 전 거래가 너무 많이 지나간 사례입니다.';
    return '가격 위치는 좋지만 들어온 돈 데이터가 부족한 사례입니다.';
  }
  if (v && (!l || !h)) {
    if (c.closeFromHigh60 != null && c.closeFromHigh60 > CONFIG.CLASSIC.high60Max) return '들어온 돈은 충분했지만 이미 고점 근처라 주의가 필요한 사례입니다.';
    if (c.closeFromLow60 != null && c.closeFromLow60 > CONFIG.CLASSIC.low60Max) return '들어온 돈은 충분했지만 저점에서 이미 많이 오른 사례입니다.';
    return '들어온 돈은 충분했지만 가격 위치가 정석 BMS 범위 밖이었던 사례입니다.';
  }
  if (!v && !l && !h) return '들어온 돈도 부족하고 가격 위치도 정석 범위 밖이었던 사례입니다.';
  return 'BMS 핵심 조건에서 일부만 만족한 사례입니다.';
}

// ─────────────────────── 핵심 계산 (winner 별) ───────────────────────

function computeCoreCondition(w) {
  const a = w.analysis || {};
  const vRatio = a.preAccumulation?.accumulatedValueRatio;
  const lf = a.pricePosition?.closeFromLow60;
  const hf = a.pricePosition?.closeFromHigh60;

  const classicPass = checkRule(CONFIG.CLASSIC, vRatio, lf, hf);
  const strongPass = checkRule(CONFIG.STRONG, vRatio, lf, hf);
  const failedClassicReasons = classicPass.matches ? [] : getFailedReasons(CONFIG.CLASSIC, vRatio, lf, hf);
  const failedStrongReasons = strongPass.matches ? [] : getFailedReasons(CONFIG.STRONG, vRatio, lf, hf);

  const c = {
    preAccumulationRatio: vRatio,
    closeFromLow60: lf,
    closeFromHigh60: hf,
    matchesClassicBms: classicPass.matches,
    matchesStrongBms: strongPass.matches,
    classicPass: { valueRatio: classicPass.valueRatio, lowPosition: classicPass.lowPosition, highPosition: classicPass.highPosition },
    strongPass: { valueRatio: strongPass.valueRatio, lowPosition: strongPass.lowPosition, highPosition: strongPass.highPosition },
    failedClassicReasons,
    failedStrongReasons,
  };
  const lbl = buildConditionLabel(c);
  c.conditionLabel = lbl.label;
  c.conditionRole = lbl.role;
  c.matrixCell = classifyMatrix(c);
  c.explanation = c.matchesStrongBms
    ? CONFIG.STRONG.description
    : c.matchesClassicBms
      ? CONFIG.CLASSIC.description
      : '정석 BMS 조건에서 일부 항목이 빠진 상태입니다.';
  return c;
}

function extractBmsMetrics(w) {
  const a = w.analysis || {};
  return {
    boxRangePct: a.boxAnalysis?.boxRangePct,
    drawdownFromPeakClose: a.postAnalysis?.drawdownFromPeakClose,
    drawdownFromPeakLow: a.postAnalysis?.drawdownFromPeakLow,
    supplyAboveRatio: a.supplyZone?.aboveCloseRatio,
  };
}

function packageWinner(w) {
  const core = computeCoreCondition(w);
  const m = extractBmsMetrics(w);
  return {
    code: w.code, name: w.name, market: w.market, marketCap: w.marketCap,
    grade: w._grade,
    startDate: w.startDate, peakDate: w.peakDate,
    daysToPeak: w.daysToPeak,
    maxHighReturn: w.maxHighReturn, maxCloseReturn: w.maxCloseReturn,
    coreCondition: core,
    valueRatioGroup: w.valueRatioGroup || null,
    bmsMetrics: m,
    oneLineSummary: buildOneLine(core),
  };
}

// ─────────────────────── 그룹 통계 ───────────────────────

function summarizeGroup(items) {
  if (!items || items.length === 0) return { count: 0 };
  const high = items.map(w => w.maxHighReturn);
  const close = items.map(w => w.maxCloseReturn);
  const days = items.map(w => w.daysToPeak);
  const drawdown = items.map(w => w.bmsMetrics?.drawdownFromPeakClose);
  return {
    count: items.length,
    avgHighReturn: avg(high), medHighReturn: median(high),
    avgCloseReturn: avg(close), medCloseReturn: median(close),
    avgDaysToPeak: avg(days),
    avgDrawdown: avg(drawdown),
  };
}

function buildGradeConditionSummary(group, label) {
  const total = group.length;
  const classicMatch = group.filter(w => w.coreCondition.matchesClassicBms);
  const classicMiss = group.filter(w => !w.coreCondition.matchesClassicBms);
  const strongMatch = group.filter(w => w.coreCondition.matchesStrongBms);
  const strongMiss = group.filter(w => !w.coreCondition.matchesStrongBms);
  return {
    label,
    count: total,
    classicMatchCount: classicMatch.length,
    classicMatchRate: pct(classicMatch.length, total),
    strongMatchCount: strongMatch.length,
    strongMatchRate: pct(strongMatch.length, total),
    classicMatchSummary: summarizeGroup(classicMatch),
    classicMissSummary: summarizeGroup(classicMiss),
    strongMatchSummary: summarizeGroup(strongMatch),
    strongMissSummary: summarizeGroup(strongMiss),
    overall: summarizeGroup(group),
  };
}

// ─────────────────────── 실패 사유 ───────────────────────

function buildFailureReasonSummary(group, ruleKey) {
  // ruleKey: 'failedClassicReasons' or 'failedStrongReasons'
  const buckets = new Map();
  group.forEach(w => {
    const reasons = w.coreCondition[ruleKey] || [];
    if (reasons.length === 0) return;
    // 핵심 분류 키만 추출 (수치는 빼기)
    reasons.forEach(r => {
      let key = r;
      if (r.includes('들어온 돈 부족')) key = '들어온 돈 부족 (5% 미만)';
      else if (r.includes('들어온 돈 과다')) key = '들어온 돈 과다 (40% 초과)';
      else if (r.includes('저점 대비 너무 낮음')) key = '저점 대비 너무 낮음 (+10% 미만)';
      else if (r.includes('저점 대비 너무 높음')) key = '저점 대비 너무 높음 (+45% 초과)';
      else if (r.includes('고점과 너무 멂')) key = '고점과 너무 멂 (-40% 미만)';
      else if (r.includes('고점 근처')) key = '고점 근처 (-10% 초과)';
      else if (r.includes('데이터 부족')) key = '데이터 부족';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(w);
    });
  });
  return [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, items]) => ({
      reason: key,
      count: items.length,
      rate: pct(items.length, group.length),
      avgHighReturn: avg(items.map(w => w.maxHighReturn)),
      avgCloseReturn: avg(items.map(w => w.maxCloseReturn)),
      avgDrawdown: avg(items.map(w => w.bmsMetrics?.drawdownFromPeakClose)),
      examples: items.sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 5).map(w => ({
        code: w.code, name: w.name, grade: w.grade,
        preAccumulationRatio: w.coreCondition.preAccumulationRatio,
        closeFromLow60: w.coreCondition.closeFromLow60,
        closeFromHigh60: w.coreCondition.closeFromHigh60,
        maxHighReturn: w.maxHighReturn,
      })),
    }));
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Core Condition Overlap Audit');
  console.log('═'.repeat(80));

  if (!fs.existsSync(INPUT_FILE)) {
    console.error('입력 파일 없음:', INPUT_FILE);
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8'));
  const cleanWinnersRaw = input.cleanWinners || [];
  const excludedWinnersRaw = input.excludedWinners || [];
  console.log(`입력: cleanWinners ${cleanWinnersRaw.length}건 (A=${input.gradeSummary?.A?.count} B=${input.gradeSummary?.B?.count} C=${input.gradeSummary?.C?.count}) / excluded ${excludedWinnersRaw.length}건`);

  const cleanWinners = cleanWinnersRaw.map(packageWinner);
  // excludedWinners는 _grade 가 없을 수 있음 — 'excluded' 로 라벨링
  const excludedWinners = excludedWinnersRaw.map(w => {
    const out = packageWinner(w);
    out.grade = 'excluded';
    out.exclusionFlags = w._exclusionFlags || [];
    return out;
  });

  // 그룹 분리
  const gradeA = cleanWinners.filter(w => w.grade === 'A');
  const gradeB = cleanWinners.filter(w => w.grade === 'B');
  const gradeAB = cleanWinners.filter(w => w.grade === 'A' || w.grade === 'B');
  const gradeC = cleanWinners.filter(w => w.grade === 'C');

  // 등급별 조건 만족률
  const gradeConditionSummary = {
    A: buildGradeConditionSummary(gradeA, 'A등급'),
    B: buildGradeConditionSummary(gradeB, 'B등급'),
    AB: buildGradeConditionSummary(gradeAB, 'A+B'),
    C: buildGradeConditionSummary(gradeC, 'C등급'),
    allClean: buildGradeConditionSummary(cleanWinners, '전체 cleanWinners'),
    excluded: buildGradeConditionSummary(excludedWinners, 'excluded (참고용)'),
  };

  // 조건 만족 vs 미만족 (A+B 기준)
  const matchVsNonMatchSummary = {
    classic: {
      match: summarizeGroup(gradeAB.filter(w => w.coreCondition.matchesClassicBms)),
      miss: summarizeGroup(gradeAB.filter(w => !w.coreCondition.matchesClassicBms)),
    },
    strong: {
      match: summarizeGroup(gradeAB.filter(w => w.coreCondition.matchesStrongBms)),
      miss: summarizeGroup(gradeAB.filter(w => !w.coreCondition.matchesStrongBms)),
    },
  };

  // 실패 사유 (A+B 기준)
  const failureReasonSummary = {
    classic: buildFailureReasonSummary(gradeAB.filter(w => !w.coreCondition.matchesClassicBms), 'failedClassicReasons'),
    strong: buildFailureReasonSummary(gradeAB.filter(w => !w.coreCondition.matchesStrongBms), 'failedStrongReasons'),
  };

  // 조건 매트릭스
  const matrixKeys = ['all_pass', 'value_only', 'position_only', 'value_pos_near_high', 'pos_value_low', 'pos_value_high', 'none', 'other'];
  const matrixLabels = {
    all_pass: '세 조건 모두 만족',
    value_only: '들어온 돈만 만족',
    position_only: '가격 위치만 만족',
    value_pos_near_high: '들어온 돈은 좋지만 고점 근처',
    pos_value_low: '가격은 좋지만 들어온 돈 부족',
    pos_value_high: '거래 과다지만 가격은 좋음',
    none: '모두 미충족',
    other: '기타 조합',
  };
  const conditionMatrix = matrixKeys.map(k => {
    const ab = gradeAB.filter(w => w.coreCondition.matrixCell.key === k);
    const c = gradeC.filter(w => w.coreCondition.matrixCell.key === k);
    const all = cleanWinners.filter(w => w.coreCondition.matrixCell.key === k);
    return {
      key: k, label: matrixLabels[k] || k,
      abCount: ab.length, abRate: pct(ab.length, gradeAB.length),
      cCount: c.length, cRate: pct(c.length, gradeC.length),
      allCount: all.length, allRate: pct(all.length, cleanWinners.length),
      avgHighReturn: avg(all.map(w => w.maxHighReturn)),
      avgCloseReturn: avg(all.map(w => w.maxCloseReturn)),
      avgDaysToPeak: avg(all.map(w => w.daysToPeak)),
      avgDrawdown: avg(all.map(w => w.bmsMetrics?.drawdownFromPeakClose)),
    };
  });

  // 핵심 발견
  const abClassicRate = gradeConditionSummary.AB.classicMatchRate || 0;
  const cClassicRate = gradeConditionSummary.C.classicMatchRate || 0;
  const abStrongRate = gradeConditionSummary.AB.strongMatchRate || 0;
  const cStrongRate = gradeConditionSummary.C.strongMatchRate || 0;
  const exClassicRate = gradeConditionSummary.excluded.classicMatchRate || 0;

  const keyFindings = {
    classicABvsC: {
      ab: abClassicRate,
      c: cClassicRate,
      ratio: cClassicRate > 0 ? round(abClassicRate / cClassicRate, 2) : null,
    },
    strongABvsC: {
      ab: abStrongRate,
      c: cStrongRate,
      ratio: cStrongRate > 0 ? round(abStrongRate / cStrongRate, 2) : null,
    },
    classicABvsExcluded: {
      ab: abClassicRate,
      excluded: exClassicRate,
      ratio: exClassicRate > 0 ? round(abClassicRate / exClassicRate, 2) : null,
    },
    classicMatchVsMiss: {
      matchAvgReturn: matchVsNonMatchSummary.classic.match.avgHighReturn,
      missAvgReturn: matchVsNonMatchSummary.classic.miss.avgHighReturn,
      matchAvgDrawdown: matchVsNonMatchSummary.classic.match.avgDrawdown,
      missAvgDrawdown: matchVsNonMatchSummary.classic.miss.avgDrawdown,
    },
    strongMatchVsMiss: {
      matchAvgReturn: matchVsNonMatchSummary.strong.match.avgHighReturn,
      missAvgReturn: matchVsNonMatchSummary.strong.miss.avgHighReturn,
      matchAvgDrawdown: matchVsNonMatchSummary.strong.match.avgDrawdown,
      missAvgDrawdown: matchVsNonMatchSummary.strong.miss.avgDrawdown,
    },
  };

  // 자동 결론
  const conclusion = [];
  // 1. 정석 조건 차별력
  if (abClassicRate >= cClassicRate * 1.3 && gradeAB.length >= 30) {
    conclusion.push(`A+B 정석 BMS 조건 만족률(${abClassicRate}%)이 C등급(${cClassicRate}%)의 ${keyFindings.classicABvsC.ratio}배로 높습니다. 정석 BMS 조건은 의미 있는 정제 조건으로 보입니다.`);
  } else if (abClassicRate > cClassicRate) {
    conclusion.push(`A+B 정석 BMS 조건 만족률(${abClassicRate}%)이 C등급(${cClassicRate}%)보다 높지만 차이가 1.3배 미만입니다. 정석 조건은 보조 설명 정도로 보는 것이 적절합니다.`);
  } else {
    conclusion.push(`A+B 정석 BMS 조건 만족률이 C등급과 비슷하거나 낮습니다. 들어온 돈+가격 위치 조합만으로 등급을 설명하기는 어렵습니다.`);
  }

  // 2. 강한 조건 차별력 / 표본 부족
  const strongABCount = gradeConditionSummary.AB.strongMatchCount;
  if (abStrongRate >= cStrongRate * 1.3 && strongABCount >= 10) {
    conclusion.push(`강한 BMS 조건 만족률 A+B(${abStrongRate}%) vs C(${cStrongRate}%) 비율이 ${keyFindings.strongABvsC.ratio}배. 강한 조건은 더 엄격한 핵심 조건으로 볼 수 있습니다 (A+B 만족 ${strongABCount}건).`);
  } else if (strongABCount < 10) {
    conclusion.push(`강한 BMS 조건은 A+B 만족 사례가 ${strongABCount}건뿐이라 표본이 부족합니다. 정석 조건을 기본으로 두는 것이 안전합니다.`);
  }

  // 3. 만족 vs 미만족 상승률
  const matchRet = matchVsNonMatchSummary.classic.match.avgHighReturn;
  const missRet = matchVsNonMatchSummary.classic.miss.avgHighReturn;
  if (matchRet != null && missRet != null) {
    if (matchRet > missRet + 1) {
      conclusion.push(`정석 조건 만족 그룹 평균 상승률 +${matchRet}% > 미만족 +${missRet}% — 조건 조합은 상승률 면에서도 긍정적 차이를 보였습니다.`);
    } else if (Math.abs(matchRet - missRet) <= 1) {
      conclusion.push(`정석 조건 만족 그룹 평균 상승률 +${matchRet}% vs 미만족 +${missRet}% — 차이가 작습니다. 조건 조합은 상승률을 크게 높이기보다는 BMS다운 사례를 설명하는 기준으로 보는 것이 적절합니다.`);
    } else {
      conclusion.push(`정석 조건 미만족 그룹 평균 상승률 +${missRet}% > 만족 +${matchRet}% — 조건이 상승률 우위를 보장하지는 않습니다.`);
    }
  }

  // 4. 흔들림
  const matchDD = matchVsNonMatchSummary.classic.match.avgDrawdown;
  const missDD = matchVsNonMatchSummary.classic.miss.avgDrawdown;
  if (matchDD != null && missDD != null) {
    if (matchDD < missDD - 1) {
      conclusion.push(`정석 조건 만족 그룹 평균 흔들림 ${matchDD}% < 미만족 ${missDD}% — 조건 조합은 상승 후 안정성 측면에서도 의미가 있을 수 있습니다.`);
    } else if (matchDD > missDD + 1) {
      conclusion.push(`정석 조건 만족 그룹 평균 흔들림 ${matchDD}% > 미만족 ${missDD}% — 조건 만족이 곧 안정성을 뜻하지는 않습니다. 흔들림은 별도 확인이 필요합니다.`);
    }
  }

  // 5~7. 판단 (사용자 요청)
  conclusion.push('판단: 정석 조건은 BMS 핵심 설명으로 사용 가능 — 들어온 돈 5~40% + 저점 +10~45% + 고점 -40~-10% 의 단순 3조건만으로 A+B 사례 다수를 설명.');
  conclusion.push(`판단: 강한 조건(들어온 돈 10~40%)을 쓰면 표본이 ${strongABCount}건으로 줄어들어 ${strongABCount < 30 ? '표본이 작아 보조 기준으로만 권장' : '핵심 기준으로 사용 가능'}.`);
  conclusion.push('판단: 5~10% 보조 구간은 A등급 비율이 높았던 점, 정석 조건에 포함했을 때도 차별력이 유지되는 점을 보면 유지하는 것이 적절.');
  conclusion.push('판단: 40% 초과 구간은 본 분석에서도 별도 라벨("거래 과다 주의")로 분리되며, 평균 흔들림이 큰 경향이 보고서 내 다른 감사와 일관 — 주의로 두는 것이 맞음.');

  conclusion.push('이번 보고서는 BMS 본체의 두 핵심 변수 조합을 단독으로 본 감사 보고서입니다. 조건 조합을 현재 후보 필터로 바로 적용하지 않습니다. BMS 본체는 winner-scan + winner-quality-filter 2단계로만 단순하게 유지합니다.');

  // 요약
  const summary = {
    totalAnalyzed: cleanWinners.length,
    gradeACount: gradeA.length,
    gradeBCount: gradeB.length,
    gradeABCount: gradeAB.length,
    gradeCCount: gradeC.length,
    excludedReferenceCount: excludedWinners.length,
    classicABMatch: gradeConditionSummary.AB.classicMatchCount,
    classicABRate: abClassicRate,
    classicCRate: cClassicRate,
    classicABvsCRatio: keyFindings.classicABvsC.ratio,
    strongABMatch: gradeConditionSummary.AB.strongMatchCount,
    strongABRate: abStrongRate,
    strongCRate: cStrongRate,
    strongABvsCRatio: keyFindings.strongABvsC.ratio,
    classicExcludedRate: exClassicRate,
    suggestedSimpleCondition: '정석 BMS 조건 (들어온 돈 5~40% + 저점 +10~45% + 고점 -40~-10%)',
  };

  // 예시
  const examples = {
    classicMatchTopReturn: gradeAB.filter(w => w.coreCondition.matchesClassicBms)
      .sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
    strongMatchTopReturn: gradeAB.filter(w => w.coreCondition.matchesStrongBms)
      .sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
    nearHighWarning: gradeAB.filter(w => w.coreCondition.matrixCell.key === 'value_pos_near_high')
      .sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
    posOnlyValueLow: gradeAB.filter(w => w.coreCondition.matrixCell.key === 'pos_value_low')
      .sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
  };

  // 출력
  const out = {
    meta: {
      version: 'bms-core-condition-overlap-audit-v1',
      generatedAt: new Date().toISOString(),
      title: 'BMS 핵심 조건 조합 감사 보고서',
      purpose: 'BMS 정제 상승 사례에서 "시총 대비 들어온 돈"과 "60일 가격 위치" 두 핵심 조건이 동시에 만족될 때 얼마나 의미가 있는지 감사. 현재 후보를 찾는 보드가 아닙니다.',
      dataPolicy: 'analysis.preAccumulation.accumulatedValueRatio + analysis.pricePosition.closeFromLow60/closeFromHigh60. winner-quality-filter 가 startDate 시점 데이터로 계산한 값이라 누수 없음.',
      scopeNote: '이번 분석은 박스권 폭, QVA, 장기 횡보, 거래대금 spike 등을 전부 빼고 오직 "들어온 돈 + 가격 위치" 두 조건만 봅니다.',
    },
    config: CONFIG,
    summary,
    conditionDefinitions: {
      classic: {
        label: CONFIG.CLASSIC.label,
        description: CONFIG.CLASSIC.description,
        rule: '들어온 돈 ' + CONFIG.CLASSIC.valueRatioMin + '~' + CONFIG.CLASSIC.valueRatioMax + '% AND 저점 +' + CONFIG.CLASSIC.low60Min + '~+' + CONFIG.CLASSIC.low60Max + '% AND 고점 ' + CONFIG.CLASSIC.high60Min + '~' + CONFIG.CLASSIC.high60Max + '%',
      },
      strong: {
        label: CONFIG.STRONG.label,
        description: CONFIG.STRONG.description,
        rule: '들어온 돈 ' + CONFIG.STRONG.valueRatioMin + '~' + CONFIG.STRONG.valueRatioMax + '% AND 저점 +' + CONFIG.STRONG.low60Min + '~+' + CONFIG.STRONG.low60Max + '% AND 고점 ' + CONFIG.STRONG.high60Min + '~' + CONFIG.STRONG.high60Max + '%',
      },
    },
    gradeConditionSummary,
    matchVsNonMatchSummary,
    failureReasonSummary,
    conditionMatrix,
    keyFindings,
    winners: cleanWinners,
    excludedReference: excludedWinners.slice(0, 200),
    examples,
    conclusion,
    dataLimit: [
      '"시총 대비 들어온 돈"은 순매수금액이 아니라 거래대금 기준입니다. 매수금액/매도금액 분리 데이터 없음.',
      '가격 위치는 startDate 기준 최근 60거래일 OHLC로 계산한 값입니다.',
      '조건 조합은 과거 상승 사례의 공통 성격을 확인하기 위한 것이며, 현재 후보 필터가 아닙니다.',
      'excludedWinners는 데이터 구조 일부가 다를 수 있어 일부 지표가 null로 처리됩니다 — 참고용 비율만 별도 표시.',
      '이 보고서는 매수 신호가 아니라 BMS 정제 상승 사례의 핵심 조건 조합을 확인하는 감사 보고서입니다.',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // 콘솔 출력
  console.log(`\n📊 핵심 지표:`);
  console.log(`  분석 대상: ${cleanWinners.length}건 (A=${gradeA.length}, B=${gradeB.length}, C=${gradeC.length}) / excluded 참고 ${excludedWinners.length}건`);
  console.log(`\n📊 등급별 정석 BMS 조건 만족률:`);
  ['A', 'B', 'AB', 'C', 'allClean', 'excluded'].forEach(k => {
    const g = gradeConditionSummary[k];
    if (!g.count) return;
    console.log(`  ${g.label.padEnd(20)} n=${String(g.count).padStart(4)} 정석=${String(g.classicMatchCount).padStart(4)} (${String(g.classicMatchRate).padStart(5)}%) 강한=${String(g.strongMatchCount).padStart(4)} (${String(g.strongMatchRate).padStart(5)}%)`);
  });

  console.log(`\n📊 정석 조건 만족 vs 미만족 (A+B):`);
  console.log(`  만족 n=${gradeConditionSummary.AB.classicMatchCount} 평균 상승=${matchVsNonMatchSummary.classic.match.avgHighReturn}% / 종가=${matchVsNonMatchSummary.classic.match.avgCloseReturn}% / 흔들림=${matchVsNonMatchSummary.classic.match.avgDrawdown}%`);
  console.log(`  미만족 n=${gradeConditionSummary.AB.count - gradeConditionSummary.AB.classicMatchCount} 평균 상승=${matchVsNonMatchSummary.classic.miss.avgHighReturn}% / 종가=${matchVsNonMatchSummary.classic.miss.avgCloseReturn}% / 흔들림=${matchVsNonMatchSummary.classic.miss.avgDrawdown}%`);

  console.log(`\n📊 강한 조건 만족 vs 미만족 (A+B):`);
  console.log(`  만족 n=${gradeConditionSummary.AB.strongMatchCount} 평균 상승=${matchVsNonMatchSummary.strong.match.avgHighReturn}% / 흔들림=${matchVsNonMatchSummary.strong.match.avgDrawdown}%`);
  console.log(`  미만족 n=${gradeConditionSummary.AB.count - gradeConditionSummary.AB.strongMatchCount} 평균 상승=${matchVsNonMatchSummary.strong.miss.avgHighReturn}% / 흔들림=${matchVsNonMatchSummary.strong.miss.avgDrawdown}%`);

  console.log(`\n📊 조건 매트릭스 (A+B 분포):`);
  conditionMatrix.forEach(m => {
    if (!m.abCount && !m.allCount) return;
    console.log(`  ${m.label.padEnd(28)} A+B ${String(m.abCount).padStart(4)} (${String(m.abRate).padStart(5)}%) | C ${String(m.cCount).padStart(4)} (${String(m.cRate).padStart(5)}%) | 평균 +${m.avgHighReturn}% / 흔들림 ${m.avgDrawdown}%`);
  });

  console.log(`\n📊 정석 조건 실패 사유 TOP (A+B):`);
  failureReasonSummary.classic.forEach(r => {
    console.log(`  ${r.reason.padEnd(28)} ${String(r.count).padStart(4)}건 (${r.rate}%)  평균 +${r.avgHighReturn}% / 흔들림 ${r.avgDrawdown}%`);
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
<title>BMS 핵심 조건 조합 감사 보고서</title>
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
.def-box { background: #1e293b; border-left: 4px solid #10b981; padding: 12px 16px; border-radius: 6px; margin-bottom: 10px; line-height: 1.7; }
.def-box strong { color: #6ee7b7; }
.def-box code { background: #0f172a; color: #fde047; padding: 2px 6px; border-radius: 3px; font-size: 11.5px; }

.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile.primary { border-left: 4px solid #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }
.big-tile.success { border-left: 4px solid #10b981; }
.big-tile.success .value { color: #6ee7b7; }
.big-tile.strong { border-left: 4px solid #14b8a6; }
.big-tile.strong .value { color: #5eead4; }
.big-tile.warn { border-left: 4px solid #f59e0b; }
.big-tile.warn .value { color: #fde047; }
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
.row-match td { background: rgba(16, 185, 129, 0.18) !important; }
.row-strong td { background: rgba(20, 184, 166, 0.16) !important; }
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
table.list tbody tr.row td.col-summary { color: #cbd5e1; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: normal; line-height: 1.4; font-size: 11.5px; }
table.list tbody tr.row:nth-child(odd) { background: #1c2942; }
table.list tbody tr.row:nth-child(odd):hover { background: #273549; }
table.list tbody tr.row.expanded, table.list tbody tr.row.expanded:nth-child(odd) { background: #1e3a5f; }

.grade-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.grade-A { background: #14532d; color: #6ee7b7; }
.grade-B { background: #1e40af; color: #dbeafe; }
.grade-C { background: #475569; color: #cbd5e1; }
.grade-excluded { background: #7f1d1d; color: #fca5a5; }
.cond-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.cond-strong { background: #115e59; color: #99f6e4; }
.cond-classic { background: #14532d; color: #a7f3d0; }
.cond-partial { background: #1e40af; color: #dbeafe; }
.cond-warn { background: #92400e; color: #fde047; }
.cond-out { background: #475569; color: #cbd5e1; }
.pass-yes { color: #6ee7b7; font-weight: 700; }
.pass-no  { color: #fca5a5; font-weight: 700; }

table.list tbody tr.detail { display: none; background: #0c1729; }
table.list tbody tr.detail.show { display: table-row; }
table.list tbody tr.detail td { padding: 14px 18px; border-bottom: 1px solid #1e3a5f; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 24px; font-size: 12px; }
.detail-block h4 { margin: 0 0 6px; font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; line-height: 1.6; }
.kv .k { color: #64748b; }
.kv .v { color: #cbd5e1; font-variant-numeric: tabular-nums; }

.failure-list { display: grid; gap: 8px; }
.failure-item { background: #1e293b; border-radius: 6px; padding: 10px 14px; border-left: 3px solid #f59e0b; }
.failure-item .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.failure-item .head .reason { color: #fde68a; font-weight: 600; font-size: 13px; }
.failure-item .head .stats { color: #94a3b8; font-size: 11.5px; }
.failure-item .examples { margin-top: 6px; font-size: 11.5px; color: #cbd5e1; }
.failure-item .examples .ex { display: inline-block; margin-right: 10px; padding: 2px 6px; background: #0f172a; border-radius: 3px; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; }
  .tbl-wrap { overflow-x: auto !important; }
  .col-mobile-hide,
  table.list thead th.col-mobile-hide { display: none; }
  .detail-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<h1 id="page-title">BMS 핵심 조건 조합 감사 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 이 보고서는 BMS 정제 상승 사례에서 "시총 대비 들어온 돈"과 "60일 가격 위치" 두 조건이 동시에 얼마나 겹치는지 확인하는 감사 보고서입니다.
  <strong>현재 후보를 찾는 보드가 아닙니다.</strong> 조건 조합을 현재 후보 필터로 바로 적용하지 않습니다.
</div>

<div class="note-box">
  💡 <strong>이번 분석 범위:</strong> 박스권 폭, QVA, 장기 횡보, 거래대금 spike 등은 모두 빼고 오로지 <strong>"시총 대비 들어온 돈" + "60일 가격 위치"</strong> 두 조건만 봅니다.
</div>

<h2>📊 핵심 지표</h2>
<div class="big-summary" id="big-summary"></div>

<h2>🎯 정석 BMS 조건과 강한 BMS 조건 정의</h2>
<div id="conditions-def"></div>

<h2>📊 등급별 조건 만족률</h2>
<div id="grade-condition-table"></div>

<h2>📊 조건 만족 vs 미만족 성과 비교 (A+B 기준)</h2>
<div id="match-vs-nonmatch-table"></div>

<h2>📊 조건 조합 매트릭스</h2>
<p class="subtitle">A+B와 C 등급에서 같은 조건 조합이 얼마나 자주 나타나는지를 보여줍니다.</p>
<div id="matrix-table"></div>

<h2>🚫 정석 조건 실패 사유 (A+B)</h2>
<p class="subtitle">조건을 만족하지 못한 이유가 무엇인지 — BMS 조건을 가볍게 만들 때 어떤 기준이 너무 빡빡한지 확인하기 위한 참고용입니다.</p>
<div id="failure-section" class="failure-list"></div>

<h2>🏆 사례 리스트</h2>
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
        <th class="numeric col-mobile-hide">종가</th>
        <th class="numeric col-mobile-hide">소요</th>
        <th class="numeric">들어온 돈</th>
        <th class="numeric">저점 대비</th>
        <th class="numeric">고점 여유</th>
        <th>정석</th>
        <th>강한</th>
        <th class="col-mobile-hide">조건 해석</th>
        <th class="numeric col-mobile-hide">흔들림</th>
        <th class="col-summary col-mobile-hide">한 줄 해석</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<h2>📝 결론</h2>
<div id="conclusion-box" class="purpose-box" style="border-left-color:#10b981;"></div>

<footer class="foot">
  <strong>매수 신호가 아닙니다.</strong> BMS Core Condition Overlap Audit는 <em>BMS 정제 상승 사례에서 "들어온 돈 + 가격 위치" 조건 조합의 차별력</em>을 확인하는 감사 도구입니다.
  조건 조합을 처음부터 BMS 필터로 쓰지 않습니다. 본체 이해를 위한 참고 자료로만 활용하세요.
  BMS 본체는 winner-scan + winner-quality-filter 2단계로만 단순하게 유지합니다.
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
  function condCls(role) {
    if (role === '강한 핵심 조건') return 'cond-strong';
    if (role === '핵심 조건') return 'cond-classic';
    if (role === '주의') return 'cond-warn';
    if (role === '일부 조건만 만족') return 'cond-partial';
    return 'cond-out';
  }

  document.getElementById('subtitle').innerHTML =
    '분석 대상 ' + summary.totalAnalyzed + '건 (A=' + summary.gradeACount + ' B=' + summary.gradeBCount + ' C=' + summary.gradeCCount + ') · 정석 BMS A+B ' + summary.classicABRate + '% vs C ' + summary.classicCRate + '% · 강한 BMS A+B ' + summary.strongABRate + '% vs C ' + summary.strongCRate + '% · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>📌 분석 범위:</strong> ' + escapeHtml(meta.scopeNote) +
    '<br><strong>데이터 정의:</strong> ' + escapeHtml(meta.dataPolicy);

  document.getElementById('data-limit').innerHTML =
    '데이터 한계:<br>' + (data.dataLimit || []).map(l => '&nbsp;&bull; ' + escapeHtml(l)).join('<br>');

  // 핵심 타일
  const tiles = [
    { label: '분석 대상', value: summary.totalAnalyzed + '건', sub: 'A ' + summary.gradeACount + ' / B ' + summary.gradeBCount + ' / C ' + summary.gradeCCount, cls: 'primary' },
    { label: 'A+B 사례', value: summary.gradeABCount + '건', sub: '핵심 분석 대상', cls: 'primary' },
    { label: 'C 참고 사례', value: summary.gradeCCount + '건', sub: '대조군' },
    { label: '정석 BMS A+B 만족', value: summary.classicABMatch + '건', sub: fmtPctRaw(summary.classicABRate) + ' (A+B 중)', cls: 'success' },
    { label: '강한 BMS A+B 만족', value: summary.strongABMatch + '건', sub: fmtPctRaw(summary.strongABRate) + ' (A+B 중)', cls: 'strong' },
    { label: 'C등급 정석 만족률', value: fmtPctRaw(summary.classicCRate), sub: '대조군 비교용' },
    { label: 'A+B vs C 정석 비율', value: (summary.classicABvsCRatio != null ? fmtNum(summary.classicABvsCRatio, 2) + '×' : '-'), sub: '1.3× 이상이면 의미 있음', cls: 'success' },
    { label: '추천 단순 조건', value: '정석 BMS', sub: '들어온돈 5~40% / 저점+10~45% / 고점-40~-10%', cls: 'strong' },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div><div class="sub">' + t.sub + '</div>';
    ts.appendChild(el);
  });

  // 조건 정의
  const cd = data.conditionDefinitions || {};
  document.getElementById('conditions-def').innerHTML =
    '<div class="def-box"><strong>① ' + escapeHtml(cd.classic?.label || '') + '</strong>' +
    '<p>' + escapeHtml(cd.classic?.description || '') + '</p>' +
    '<p><code>' + escapeHtml(cd.classic?.rule || '') + '</code></p></div>' +
    '<div class="def-box" style="border-left-color:#14b8a6;"><strong>② ' + escapeHtml(cd.strong?.label || '') + '</strong>' +
    '<p>' + escapeHtml(cd.strong?.description || '') + '</p>' +
    '<p><code>' + escapeHtml(cd.strong?.rule || '') + '</code></p></div>';

  // 등급별 조건 만족률
  const gcs = data.gradeConditionSummary || {};
  const gradeOrder = ['A', 'B', 'AB', 'C', 'allClean', 'excluded'];
  let gctHtml = '<table class="cmp"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>정석 만족 수</th><th>정석 만족률</th><th>강한 만족 수</th><th>강한 만족률</th>' +
    '<th>정석 만족 평균 상승</th><th>정석 미만족 평균</th><th>정석 만족 흔들림</th><th>정석 미만족 흔들림</th>' +
    '</tr></thead><tbody>';
  gradeOrder.forEach(k => {
    const g = gcs[k];
    if (!g || !g.count) return;
    const cls = (k === 'AB' ? 'row-match' : '') + (k === 'excluded' ? ' row-warn' : '');
    gctHtml += '<tr class="' + cls + '">' +
      '<td>' + escapeHtml(g.label) + '</td>' +
      '<td>' + g.count + '</td>' +
      '<td>' + g.classicMatchCount + '건</td>' +
      '<td class="cell-pos">' + fmtPctRaw(g.classicMatchRate) + '</td>' +
      '<td>' + g.strongMatchCount + '건</td>' +
      '<td class="cell-pos">' + fmtPctRaw(g.strongMatchRate) + '</td>' +
      '<td class="cell-pos">' + fmtPct(g.classicMatchSummary?.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(g.classicMissSummary?.avgHighReturn) + '</td>' +
      '<td class="cell-neg">' + fmtPctRaw(g.classicMatchSummary?.avgDrawdown) + '</td>' +
      '<td>' + fmtPctRaw(g.classicMissSummary?.avgDrawdown) + '</td>' +
    '</tr>';
  });
  gctHtml += '</tbody></table>';
  document.getElementById('grade-condition-table').innerHTML = gctHtml;

  // 만족 vs 미만족
  const mvs = data.matchVsNonMatchSummary || {};
  let mvHtml = '<table class="cmp"><thead><tr>' +
    '<th>구분</th><th>n</th><th>평균 상승률</th><th>중앙값</th><th>평균 종가</th><th>평균 소요</th><th>평균 흔들림</th>' +
    '</tr></thead><tbody>';
  ['classic', 'strong'].forEach(rule => {
    const labelM = rule === 'classic' ? '정석 BMS 조건 만족' : '강한 BMS 조건 만족';
    const labelN = rule === 'classic' ? '정석 BMS 조건 미만족' : '강한 BMS 조건 미만족';
    const m = mvs[rule]?.match || {};
    const n = mvs[rule]?.miss || {};
    mvHtml += '<tr class="' + (rule === 'classic' ? 'row-match' : 'row-strong') + '">' +
      '<td>' + labelM + '</td>' +
      '<td>' + (m.count || 0) + '</td>' +
      '<td class="cell-pos">' + fmtPct(m.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(m.medHighReturn) + '</td>' +
      '<td>' + fmtPct(m.avgCloseReturn) + '</td>' +
      '<td>' + (m.avgDaysToPeak != null ? fmtNum(m.avgDaysToPeak) + '일' : '-') + '</td>' +
      '<td class="cell-neg">' + fmtPctRaw(m.avgDrawdown) + '</td>' +
    '</tr>';
    mvHtml += '<tr>' +
      '<td>' + labelN + '</td>' +
      '<td>' + (n.count || 0) + '</td>' +
      '<td>' + fmtPct(n.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(n.medHighReturn) + '</td>' +
      '<td>' + fmtPct(n.avgCloseReturn) + '</td>' +
      '<td>' + (n.avgDaysToPeak != null ? fmtNum(n.avgDaysToPeak) + '일' : '-') + '</td>' +
      '<td class="cell-neg">' + fmtPctRaw(n.avgDrawdown) + '</td>' +
    '</tr>';
  });
  mvHtml += '</tbody></table>';
  document.getElementById('match-vs-nonmatch-table').innerHTML = mvHtml;

  // 매트릭스
  const matrix = data.conditionMatrix || [];
  let mxHtml = '<table class="cmp"><thead><tr>' +
    '<th>조합</th><th>A+B 수</th><th>A+B 비율</th><th>C 수</th><th>C 비율</th><th>전체 수</th><th>평균 상승</th><th>평균 종가</th><th>평균 소요</th><th>평균 흔들림</th>' +
    '</tr></thead><tbody>';
  matrix.forEach(m => {
    if (!m.allCount) return;
    const cls = m.key === 'all_pass' ? 'row-match' : (m.key === 'value_pos_near_high' ? 'row-warn' : '');
    mxHtml += '<tr class="' + cls + '">' +
      '<td>' + escapeHtml(m.label) + '</td>' +
      '<td>' + m.abCount + '건</td>' +
      '<td>' + fmtPctRaw(m.abRate) + '</td>' +
      '<td>' + m.cCount + '건</td>' +
      '<td>' + fmtPctRaw(m.cRate) + '</td>' +
      '<td>' + m.allCount + '건</td>' +
      '<td class="cell-pos">' + fmtPct(m.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(m.avgCloseReturn) + '</td>' +
      '<td>' + (m.avgDaysToPeak != null ? fmtNum(m.avgDaysToPeak) + '일' : '-') + '</td>' +
      '<td class="cell-neg">' + fmtPctRaw(m.avgDrawdown) + '</td>' +
    '</tr>';
  });
  mxHtml += '</tbody></table>';
  document.getElementById('matrix-table').innerHTML = mxHtml;

  // 실패 사유
  const fr = (data.failureReasonSummary?.classic) || [];
  const fEl = document.getElementById('failure-section');
  if (fr.length === 0) {
    fEl.innerHTML = '<p style="color:#64748b;">A+B 사례 모두 정석 조건 만족</p>';
  } else {
    fr.forEach(r => {
      const div = document.createElement('div');
      div.className = 'failure-item';
      div.innerHTML =
        '<div class="head"><span class="reason">' + escapeHtml(r.reason) + '</span>' +
        '<span class="stats">' + r.count + '건 (' + fmtPctRaw(r.rate) + ') · 평균 상승 ' + fmtPct(r.avgHighReturn) + ' · 종가 ' + fmtPct(r.avgCloseReturn) + ' · 흔들림 ' + fmtPctRaw(r.avgDrawdown) + '</span></div>' +
        '<div class="examples">대표: ' + (r.examples || []).map(e =>
          '<span class="ex">' + escapeHtml(e.name) + ' (' + e.code + ', ' + e.grade + ', +' + e.maxHighReturn + '%)</span>'
        ).join('') + '</div>';
      fEl.appendChild(div);
    });
  }

  // 결론
  document.getElementById('conclusion-box').innerHTML =
    '<strong>📌 자동 결론:</strong><br>' + (data.conclusion || []).map(c => '• ' + escapeHtml(c)).join('<br><br>');

  // 탭
  const tabs = [
    { id: 'all', label: '전체 (' + winners.length + ')' },
    { id: 'classicMatch', label: '정석 BMS 조건 만족 (' + winners.filter(w => w.coreCondition.matchesClassicBms).length + ')' },
    { id: 'strongMatch', label: '강한 BMS 조건 만족 (' + winners.filter(w => w.coreCondition.matchesStrongBms).length + ')' },
    { id: 'pos_value_low', label: '가격은 좋지만 들어온 돈 부족 (' + winners.filter(w => w.coreCondition.matrixCell.key === 'pos_value_low').length + ')' },
    { id: 'value_pos_near_high', label: '들어온 돈은 좋지만 고점 근처 (' + winners.filter(w => w.coreCondition.matrixCell.key === 'value_pos_near_high').length + ')' },
    { id: 'pos_value_high', label: '거래 과다지만 가격은 좋음 (' + winners.filter(w => w.coreCondition.matrixCell.key === 'pos_value_high').length + ')' },
    { id: 'A', label: 'A등급 (' + winners.filter(w => w.grade === 'A').length + ')' },
    { id: 'B', label: 'B등급 (' + winners.filter(w => w.grade === 'B').length + ')' },
    { id: 'C', label: 'C등급 (' + winners.filter(w => w.grade === 'C').length + ')' },
  ];

  const tabsEl = document.getElementById('tabs');
  let activeTab = 'classicMatch';
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
    if (activeTab === 'classicMatch') return winners.filter(w => w.coreCondition.matchesClassicBms);
    if (activeTab === 'strongMatch') return winners.filter(w => w.coreCondition.matchesStrongBms);
    if (activeTab === 'A' || activeTab === 'B' || activeTab === 'C') return winners.filter(w => w.grade === activeTab);
    return winners.filter(w => w.coreCondition.matrixCell.key === activeTab);
  }

  const tbody = document.getElementById('list-body');
  function renderList() {
    tbody.innerHTML = '';
    let list = pickList();
    list = [...list].sort((a, b) => b.maxHighReturn - a.maxHighReturn);
    list.forEach((w, i) => {
      const c = w.coreCondition || {};
      const m = w.bmsMetrics || {};
      const tr = document.createElement('tr');
      tr.className = 'row';
      const passSign = (b) => b ? '<span class="pass-yes">✓</span>' : '<span class="pass-no">✗</span>';
      tr.innerHTML =
        '<td>' + (i + 1) + '</td>' +
        '<td class="col-name">' + escapeHtml(w.name) + '<span class="meta">' + w.code + ' · ' + (w.market || '-') + '</span></td>' +
        '<td><span class="grade-pill grade-' + (w.grade || 'C') + '">' + escapeHtml(w.grade || '-') + '</span></td>' +
        '<td class="col-mobile-hide">' + fmtDate(w.startDate) + '</td>' +
        '<td class="numeric cell-pos" style="font-weight:700;">' + fmtPct(w.maxHighReturn) + '</td>' +
        '<td class="numeric col-mobile-hide ' + clsRet(w.maxCloseReturn) + '">' + fmtPct(w.maxCloseReturn) + '</td>' +
        '<td class="numeric col-mobile-hide">' + (w.daysToPeak != null ? w.daysToPeak + '일' : '-') + '</td>' +
        '<td class="numeric" style="font-weight:600;color:#5eead4;">' + fmtPctRaw(c.preAccumulationRatio) + '</td>' +
        '<td class="numeric">' + fmtPct(c.closeFromLow60) + '</td>' +
        '<td class="numeric" style="color:#fbbf24;">' + fmtPct(c.closeFromHigh60) + '</td>' +
        '<td>' + passSign(c.matchesClassicBms) + '</td>' +
        '<td>' + passSign(c.matchesStrongBms) + '</td>' +
        '<td class="col-mobile-hide"><span class="cond-pill ' + condCls(c.conditionRole) + '">' + escapeHtml(c.conditionLabel || '-') + '</span></td>' +
        '<td class="numeric col-mobile-hide cell-neg">' + fmtPctRaw(m.drawdownFromPeakClose) + '</td>' +
        '<td class="col-summary col-mobile-hide">' + escapeHtml(w.oneLineSummary || '') + '</td>';
      const trd = document.createElement('tr');
      trd.className = 'detail';
      trd.innerHTML = '<td colspan="15">' + buildDetailHtml(w) + '</td>';
      tr.addEventListener('click', () => {
        tr.classList.toggle('expanded');
        trd.classList.toggle('show');
      });
      tbody.appendChild(tr);
      tbody.appendChild(trd);
    });
  }

  function buildDetailHtml(w) {
    const c = w.coreCondition || {};
    const m = w.bmsMetrics || {};
    const v = w.valueRatioGroup || {};
    const passText = (b) => b ? '<span class="pass-yes">통과 ✓</span>' : '<span class="pass-no">미통과 ✗</span>';
    const reasonsHtml = (arr) => (arr && arr.length > 0)
      ? '<ul style="margin:4px 0 0 16px;color:#fca5a5;">' + arr.map(r => '<li>' + escapeHtml(r) + '</li>').join('') + '</ul>'
      : '<p style="color:#6ee7b7;">실패 사유 없음 (조건 통과)</p>';

    return '<div class="detail-grid">' +
      '<div class="detail-block"><h4>📌 BMS 상승 사례</h4>' +
        '<div class="kv">' +
          '<div class="k">등급</div><div class="v">' + escapeHtml(w.grade || '-') + '</div>' +
          '<div class="k">시총</div><div class="v">' + fmtMc(w.marketCap) + '</div>' +
          '<div class="k">상승 시작일</div><div class="v">' + fmtDate(w.startDate) + '</div>' +
          '<div class="k">+40% 도달일</div><div class="v">' + fmtDate(w.peakDate) + '</div>' +
          '<div class="k">상승 소요</div><div class="v">' + (w.daysToPeak || '-') + '거래일</div>' +
          '<div class="k">고가 상승률</div><div class="v cell-pos">' + fmtPct(w.maxHighReturn) + '</div>' +
          '<div class="k">종가 상승률</div><div class="v ' + clsRet(w.maxCloseReturn) + '">' + fmtPct(w.maxCloseReturn) + '</div>' +
          '<div class="k">상승 후 흔들림</div><div class="v cell-neg">' + fmtPctRaw(m.drawdownFromPeakClose) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block"><h4>💰 시총 대비 들어온 돈</h4>' +
        '<div class="kv">' +
          '<div class="k">값</div><div class="v" style="color:#5eead4;font-weight:700;">' + fmtPctRaw(c.preAccumulationRatio) + '</div>' +
          '<div class="k">정석 통과 (5~40%)</div><div class="v">' + passText(c.classicPass?.valueRatio) + '</div>' +
          '<div class="k">강한 통과 (10~40%)</div><div class="v">' + passText(c.strongPass?.valueRatio) + '</div>' +
          '<div class="k">단순 구간</div><div class="v">' + escapeHtml(v.groupLabel || '-') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block"><h4>📍 60일 가격 위치</h4>' +
        '<div class="kv">' +
          '<div class="k">저점 대비</div><div class="v" style="color:#5eead4;font-weight:700;">' + fmtPct(c.closeFromLow60) + '</div>' +
          '<div class="k">저점 통과 (+10~+45%)</div><div class="v">' + passText(c.classicPass?.lowPosition) + '</div>' +
          '<div class="k">고점 대비</div><div class="v" style="color:#fbbf24;font-weight:700;">' + fmtPct(c.closeFromHigh60) + '</div>' +
          '<div class="k">고점 통과 (-40~-10%)</div><div class="v">' + passText(c.classicPass?.highPosition) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block"><h4>🎯 조건 판정</h4>' +
        '<div class="kv">' +
          '<div class="k">정석 BMS</div><div class="v">' + passText(c.matchesClassicBms) + '</div>' +
          '<div class="k">강한 BMS</div><div class="v">' + passText(c.matchesStrongBms) + '</div>' +
          '<div class="k">조건 라벨</div><div class="v"><span class="cond-pill ' + condCls(c.conditionRole) + '">' + escapeHtml(c.conditionLabel || '-') + '</span></div>' +
          '<div class="k">조건 역할</div><div class="v">' + escapeHtml(c.conditionRole || '-') + '</div>' +
          '<div class="k">조건 조합</div><div class="v">' + escapeHtml(c.matrixCell?.label || '-') + '</div>' +
        '</div>' +
        '<p style="color:#cbd5e1;font-size:11.5px;line-height:1.5;margin-top:6px;">' + escapeHtml(c.explanation || '') + '</p>' +
      '</div>' +
      '<div class="detail-block"><h4>🚫 정석 조건 실패 사유</h4>' + reasonsHtml(c.failedClassicReasons) + '</div>' +
      '<div class="detail-block"><h4>🚫 강한 조건 실패 사유</h4>' + reasonsHtml(c.failedStrongReasons) + '</div>' +
      '<div class="detail-block" style="grid-column: 1 / -1;"><h4>한 줄 해석</h4>' +
        '<p style="color:#fde68a;font-size:13px;line-height:1.6;">' + escapeHtml(w.oneLineSummary || '') + '</p>' +
        '<p style="color:#94a3b8;font-size:11px;margin-top:6px;">⚠️ 과거 사례의 성격 확인용입니다. 같은 패턴이 미래에도 반복된다는 보장은 없습니다. 이 조건 조합을 현재 후보 필터로 적용하지 않습니다.</p>' +
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
