#!/usr/bin/env node
/**
 * BMS Simple Score Audit
 *
 * 목적:
 *   BMS 정제 상승 사례에 단순 100점 점수를 적용해, A/B 정상 상승 사례와 C/제외 사례가
 *   점수로 구분되는지 감사한다.
 *
 *   현재 매수후보 보드 만들지 않는다. 점수화 방식이 의미 있는지 사전 검증만 한다.
 *
 *   점수 = 들어온 돈 점수(35) + 저점 위치 점수(25) + 고점 공간 점수(25) - 위험 감점(최대 15)
 *   최종 점수는 0~85 범위. 단순한 단일 점수로 BMS 다움을 평가.
 *
 * 데이터 누수 방지:
 *   각 winner 의 analysis.preAccumulation.accumulatedValueRatio /
 *   analysis.pricePosition.closeFromLow60 / closeFromHigh60 사용. winner-quality-filter 가
 *   startDate 시점 데이터로 계산한 값.
 *
 * 입력:
 *   - reports/bms-winner-quality-filter-result.json (cleanWinners + excludedWinners)
 *
 * 출력:
 *   - reports/bms-simple-score-audit-result.json
 *   - reports/bms-simple-score-audit-result.html
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const INPUT_FILE = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-simple-score-audit-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-simple-score-audit-result.html');

// ─────────────────────── 점수 정의 (CONFIG) ───────────────────────

const SCORE_DEF = {
  valueRatio: {
    label: '상승 전 들어온 돈 점수',
    max: 35,
    description: '크게 오르기 전 20거래일 동안 시총 대비 어느 정도 거래대금이 지나갔는지 보는 점수입니다.',
    rules: [
      { key: 'core_10_40',   min: 10, max: 40,       score: 35, label: '핵심 (10~40%)' },
      { key: 'support_5_10', min: 5,  max: 10,       score: 25, label: '초기 유입 (5~10%)' },
      { key: 'low_0_5',      min: 0,  max: 5,        score: 10, label: '유입 부족 (0~5%)' },
      { key: 'caution_40_80',min: 40, max: 80,       score: 15, label: '거래 과다 (40~80%)' },
      { key: 'overheat_80',  min: 80, max: Infinity, score: 5,  label: '과열 가능 (80%+)' },
    ],
  },
  lowPosition: {
    label: '저점에서 회복한 정도',
    max: 25,
    description: '60일 저점 대비 시작점이 얼마나 회복했는지 보는 점수입니다.',
    rules: [
      { key: 'core_10_45',     min: 10, max: 45,       score: 25, label: '핵심 회복 (+10~45%)' },
      { key: 'mid_45_70',      min: 45, max: 70,       score: 12, label: '많이 회복 (+45~70%)' },
      { key: 'low_0_10',       min: 0,  max: 10,       score: 10, label: '저점 근처 (0~10%)' },
      { key: 'overheated_70',  min: 70, max: Infinity, score: 5,  label: '과열 의심 (+70%↑)' },
    ],
    // 0% 미만 (음수) → 0점, 데이터 없음 → 0점
  },
  highPosition: {
    label: '고점까지 남은 공간',
    max: 25,
    description: '60일 고점 대비 시작점이 얼마나 떨어져 있는지 보는 점수입니다.',
    rules: [
      { key: 'core_-40_-10',   min: -40,        max: -10,       score: 25, label: '핵심 (-40~-10%)' },
      { key: 'near_-10_-3',    min: -10,        max: -3,        score: 12, label: '고점 근처 (-10~-3%)' },
      { key: 'breakout_-3_up', min: -3,         max: Infinity,  score: 5,  label: '신고가 근처 (-3%↑)' },
      { key: 'too_far_-40',    min: -Infinity,  max: -40,       score: 10, label: '고점 너무 멈 (≤-40%)' },
    ],
  },
  riskPenalty: {
    label: '위험 감점',
    max: 15,
    description: '거래 과다 / 이미 많이 오른 / 고점 근처 / 데이터 부족에 따른 감점.',
  },
};

const SCORE_GRADES = {
  strong:  { min: 85, label: '강한 BMS 점수',     explanation: '상승 전 들어온 돈과 가격 위치가 모두 BMS 핵심 조건에 가까운 사례입니다.' },
  classic: { min: 70, label: '정석 BMS 점수',     explanation: 'BMS 핵심 조건을 상당 부분 만족하는 사례입니다.' },
  partial: { min: 50, label: '일부 조건 만족',     explanation: '일부 조건은 맞지만 핵심 조건이 부족한 사례입니다.' },
  weak:    { min: 0,  label: 'BMS 조건 약함',     explanation: 'BMS 핵심 조건과는 거리가 있는 사례입니다.' },
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

// ─────────────────────── 점수 계산 ───────────────────────

function scoreValueRatio(v) {
  if (v == null || !isFinite(v)) return { score: 0, reason: '데이터 없음 (0)' };
  if (v >= 10 && v <= 40)   return { score: 35, reason: '핵심 10~40% (35)' };
  if (v >= 5 && v < 10)     return { score: 25, reason: '초기 유입 5~10% (25)' };
  if (v >= 0 && v < 5)      return { score: 10, reason: '유입 부족 0~5% (10)' };
  if (v > 40 && v <= 80)    return { score: 15, reason: '거래 과다 40~80% (15)' };
  if (v > 80)               return { score: 5,  reason: '과열 가능 80%+ (5)' };
  return { score: 0, reason: '범위 외 (0)' };
}

function scoreLowPosition(lf) {
  if (lf == null || !isFinite(lf)) return { score: 0, reason: '데이터 없음 (0)' };
  if (lf >= 10 && lf <= 45) return { score: 25, reason: '핵심 회복 +10~45% (25)' };
  if (lf > 45 && lf <= 70)  return { score: 12, reason: '많이 회복 +45~70% (12)' };
  if (lf >= 0 && lf < 10)   return { score: 10, reason: '저점 근처 0~10% (10)' };
  if (lf > 70)              return { score: 5,  reason: '과열 의심 +70%↑ (5)' };
  if (lf < 0)               return { score: 0, reason: '저점 이탈 <0% (0)' };
  return { score: 0, reason: '범위 외 (0)' };
}

function scoreHighPosition(hf) {
  if (hf == null || !isFinite(hf)) return { score: 0, reason: '데이터 없음 (0)' };
  if (hf >= -40 && hf <= -10) return { score: 25, reason: '핵심 -40~-10% (25)' };
  if (hf > -10 && hf <= -3)   return { score: 12, reason: '고점 근처 -10~-3% (12)' };
  if (hf > -3)                return { score: 5,  reason: '신고가 근처 -3%↑ (5)' };
  if (hf < -40)               return { score: 10, reason: '고점 너무 멈 ≤-40% (10)' };
  return { score: 0, reason: '범위 외 (0)' };
}

function computeRiskPenalty(v, lf, hf) {
  let penalty = 0;
  const reasons = [];
  if (v != null && isFinite(v)) {
    if (v > 40) { penalty += 5; reasons.push('들어온 돈 40% 초과 (-5)'); }
    if (v > 80) { penalty += 5; reasons.push('들어온 돈 80% 초과 (추가 -5)'); }
  }
  if (lf != null && isFinite(lf) && lf > 70) { penalty += 5; reasons.push('저점 대비 +70% 초과 (-5)'); }
  if (hf != null && isFinite(hf) && hf > -3) { penalty += 5; reasons.push('고점 대비 -3% 초과 (-5)'); }
  let dataMissing = 0;
  if (v == null || !isFinite(v)) dataMissing++;
  if (lf == null || !isFinite(lf)) dataMissing++;
  if (hf == null || !isFinite(hf)) dataMissing++;
  if (dataMissing >= 2) { penalty += 10; reasons.push('핵심값 데이터 2개 이상 부족 (-10)'); }
  return { penalty: Math.min(15, penalty), reasons };
}

function classifyScoreGrade(score) {
  if (score >= SCORE_GRADES.strong.min)  return { key: 'strong',  label: SCORE_GRADES.strong.label,  explanation: SCORE_GRADES.strong.explanation };
  if (score >= SCORE_GRADES.classic.min) return { key: 'classic', label: SCORE_GRADES.classic.label, explanation: SCORE_GRADES.classic.explanation };
  if (score >= SCORE_GRADES.partial.min) return { key: 'partial', label: SCORE_GRADES.partial.label, explanation: SCORE_GRADES.partial.explanation };
  return { key: 'weak', label: SCORE_GRADES.weak.label, explanation: SCORE_GRADES.weak.explanation };
}

function computeSimpleBmsScore(w) {
  const a = w.analysis || {};
  const v = a.preAccumulation?.accumulatedValueRatio;
  const lf = a.pricePosition?.closeFromLow60;
  const hf = a.pricePosition?.closeFromHigh60;
  const valueScore = scoreValueRatio(v);
  const lowScore = scoreLowPosition(lf);
  const highScore = scoreHighPosition(hf);
  const risk = computeRiskPenalty(v, lf, hf);
  const total = Math.max(0, valueScore.score + lowScore.score + highScore.score - risk.penalty);
  const grade = classifyScoreGrade(total);
  return {
    totalScore: total,
    scoreGrade: grade.key,
    scoreLabel: grade.label,
    valueScore: valueScore.score,
    lowPositionScore: lowScore.score,
    highPositionScore: highScore.score,
    riskPenalty: risk.penalty,
    scoreBreakdown: {
      preAccumulationRatio: v,
      closeFromLow60: lf,
      closeFromHigh60: hf,
      valueScoreReason: valueScore.reason,
      lowPositionReason: lowScore.reason,
      highPositionReason: highScore.reason,
      riskPenaltyReasons: risk.reasons,
    },
    explanation: grade.explanation,
  };
}

// ─────────────────────── 한 줄 해석 ───────────────────────

function buildOneLine(w) {
  const s = w.simpleBmsScore || {};
  if (s.scoreGrade === 'strong') {
    return `BMS 점수 ${s.totalScore}점으로 상승 전 들어온 돈과 가격 위치가 모두 좋은 사례입니다.`;
  }
  if (s.scoreGrade === 'classic') {
    return `BMS 점수 ${s.totalScore}점으로 핵심 조건을 상당 부분 만족하는 사례입니다.`;
  }
  if (s.scoreGrade === 'partial' && (s.riskPenalty || 0) > 0) {
    return `점수 ${s.totalScore}점 — 위험 감점 ${s.riskPenalty}점이 적용된 사례입니다.`;
  }
  if (s.scoreGrade === 'weak' && (w.maxHighReturn || 0) >= 50) {
    return `점수 ${s.totalScore}점이지만 이후 +${w.maxHighReturn}% 상승한 예외 사례입니다.`;
  }
  if (s.scoreGrade === 'partial') {
    return `점수 ${s.totalScore}점 — 일부 조건만 만족한 사례입니다.`;
  }
  return `점수 ${s.totalScore}점 — BMS 핵심 조건과 거리가 있는 사례입니다.`;
}

// ─────────────────────── 그룹 통계 ───────────────────────

function summarizeGroup(items) {
  if (!items || items.length === 0) return { count: 0 };
  const scores = items.map(w => w.simpleBmsScore?.totalScore);
  const high = items.map(w => w.maxHighReturn);
  const close = items.map(w => w.maxCloseReturn);
  const drawdown = items.map(w => w.analysis?.postAnalysis?.drawdownFromPeakClose);
  const days = items.map(w => w.daysToPeak);
  return {
    count: items.length,
    avgScore: avg(scores),
    medScore: median(scores),
    rate85plus: pct(items.filter(w => (w.simpleBmsScore?.totalScore || 0) >= 85).length, items.length),
    rate70plus: pct(items.filter(w => (w.simpleBmsScore?.totalScore || 0) >= 70).length, items.length),
    rateBelow50: pct(items.filter(w => (w.simpleBmsScore?.totalScore || 0) < 50).length, items.length),
    avgHighReturn: avg(high), medHighReturn: median(high),
    avgCloseReturn: avg(close), medCloseReturn: median(close),
    avgDrawdown: avg(drawdown),
    avgDaysToPeak: avg(days),
  };
}

// 점수 구간 통계
function summarizeBucket(items, total) {
  if (!items || items.length === 0) return { count: 0 };
  const high = items.map(w => w.maxHighReturn);
  const close = items.map(w => w.maxCloseReturn);
  const days = items.map(w => w.daysToPeak);
  const drawdown = items.map(w => w.analysis?.postAnalysis?.drawdownFromPeakClose);
  const v = items.map(w => w.analysis?.preAccumulation?.accumulatedValueRatio);
  const lf = items.map(w => w.analysis?.pricePosition?.closeFromLow60);
  const hf = items.map(w => w.analysis?.pricePosition?.closeFromHigh60);
  const aCount = items.filter(w => w.grade === 'A').length;
  const bCount = items.filter(w => w.grade === 'B').length;
  const cCount = items.filter(w => w.grade === 'C').length;
  const exCount = items.filter(w => w.grade === 'excluded').length;
  return {
    count: items.length,
    share: total > 0 ? pct(items.length, total) : null,
    aCount, bCount, cCount, exCount,
    abShare: pct(aCount + bCount, items.length),
    cExShare: pct(cCount + exCount, items.length),
    avgHighReturn: avg(high), medHighReturn: median(high),
    avgCloseReturn: avg(close),
    avgDaysToPeak: avg(days),
    avgDrawdown: avg(drawdown),
    avgPreAccum: avg(v),
    avgCloseFromLow60: avg(lf),
    avgCloseFromHigh60: avg(hf),
  };
}

// ─────────────────────── 메인 ───────────────────────

function packageWinner(rawWinner, gradeOverride) {
  const w = {
    code: rawWinner.code, name: rawWinner.name, market: rawWinner.market, marketCap: rawWinner.marketCap,
    grade: gradeOverride || rawWinner._grade,
    startDate: rawWinner.startDate, peakDate: rawWinner.peakDate,
    daysToPeak: rawWinner.daysToPeak,
    maxHighReturn: rawWinner.maxHighReturn, maxCloseReturn: rawWinner.maxCloseReturn,
    analysis: rawWinner.analysis,                // 원본 보존 (점수 계산에 필요)
    coreCondition: rawWinner.coreCondition || null,    // cleanWinners 만 가짐
    valueRatioGroup: rawWinner.valueRatioGroup || null,
    exclusionFlags: rawWinner._exclusionFlags || null,
  };
  w.simpleBmsScore = computeSimpleBmsScore(w);
  w.oneLineSummary = buildOneLine(w);
  return w;
}

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Simple Score Audit');
  console.log('═'.repeat(80));

  if (!fs.existsSync(INPUT_FILE)) {
    console.error('입력 파일 없음:', INPUT_FILE);
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8'));
  const cleanWinnersRaw = input.cleanWinners || [];
  const excludedRaw = input.excludedWinners || [];

  const cleanWinners = cleanWinnersRaw.map(w => packageWinner(w));
  const excludedWinners = excludedRaw.map(w => packageWinner(w, 'excluded'));

  console.log(`입력: cleanWinners ${cleanWinners.length}건 / excluded ${excludedWinners.length}건`);

  const gA = cleanWinners.filter(w => w.grade === 'A');
  const gB = cleanWinners.filter(w => w.grade === 'B');
  const gAB = cleanWinners.filter(w => w.grade === 'A' || w.grade === 'B');
  const gC = cleanWinners.filter(w => w.grade === 'C');

  // 등급별 점수 분포
  const gradeScoreSummary = {
    A: { label: 'A등급', ...summarizeGroup(gA) },
    B: { label: 'B등급', ...summarizeGroup(gB) },
    AB: { label: 'A+B', ...summarizeGroup(gAB) },
    C: { label: 'C등급', ...summarizeGroup(gC) },
    allClean: { label: '전체 cleanWinners', ...summarizeGroup(cleanWinners) },
    excluded: { label: 'excluded (참고용)', ...summarizeGroup(excludedWinners) },
  };

  // 점수 구간별 성과
  const allItems = [...cleanWinners, ...excludedWinners];
  const bucket85 = allItems.filter(w => (w.simpleBmsScore.totalScore || 0) >= 85);
  const bucket70 = allItems.filter(w => (w.simpleBmsScore.totalScore || 0) >= 70 && (w.simpleBmsScore.totalScore || 0) < 85);
  const bucket50 = allItems.filter(w => (w.simpleBmsScore.totalScore || 0) >= 50 && (w.simpleBmsScore.totalScore || 0) < 70);
  const bucketLow = allItems.filter(w => (w.simpleBmsScore.totalScore || 0) < 50);
  const scoreBucketSummary = {
    score_85_up:    { label: '85점 이상 (강한 BMS)',  ...summarizeBucket(bucket85, allItems.length) },
    score_70_84:    { label: '70~84점 (정석 BMS)',     ...summarizeBucket(bucket70, allItems.length) },
    score_50_69:    { label: '50~69점 (일부 만족)',    ...summarizeBucket(bucket50, allItems.length) },
    score_below_50: { label: '50점 미만 (조건 약함)',   ...summarizeBucket(bucketLow, allItems.length) },
  };

  // 점수 등급(키) 별 분포 (cleanWinners 전체에서)
  const scoreGradeDistribution = {
    strong:  cleanWinners.filter(w => w.simpleBmsScore.scoreGrade === 'strong').length,
    classic: cleanWinners.filter(w => w.simpleBmsScore.scoreGrade === 'classic').length,
    partial: cleanWinners.filter(w => w.simpleBmsScore.scoreGrade === 'partial').length,
    weak:    cleanWinners.filter(w => w.simpleBmsScore.scoreGrade === 'weak').length,
  };

  // 핵심 발견
  const abAvg = gradeScoreSummary.AB.avgScore || 0;
  const cAvg = gradeScoreSummary.C.avgScore || 0;
  const exAvg = gradeScoreSummary.excluded.avgScore || 0;
  const aRate85 = gradeScoreSummary.A.rate85plus || 0;
  const cRate85 = gradeScoreSummary.C.rate85plus || 0;
  const cBelow50 = gradeScoreSummary.C.rateBelow50 || 0;
  const exBelow50 = gradeScoreSummary.excluded.rateBelow50 || 0;
  const keyFindings = {
    abVsCAvgGap: round(abAvg - cAvg, 2),
    abVsExAvgGap: round(abAvg - exAvg, 2),
    aRate85VsCRatio: cRate85 > 0 ? round(aRate85 / cRate85, 2) : null,
    in85plus_abShare: scoreBucketSummary.score_85_up.abShare,
    in85plus_cExShare: scoreBucketSummary.score_85_up.cExShare,
    in70plus_abShare: pct(
      [...bucket85, ...bucket70].filter(w => w.grade === 'A' || w.grade === 'B').length,
      bucket85.length + bucket70.length
    ),
    inBelow50_cExShare: scoreBucketSummary.score_below_50.cExShare,
  };

  // 자동 결론
  const conclusion = [];
  if (keyFindings.abVsCAvgGap >= 10) {
    conclusion.push(`A+B 평균 점수 ${abAvg}점 vs C등급 ${cAvg}점, 차이 ${keyFindings.abVsCAvgGap}점 — BMS 점수는 정상 상승 사례를 구분하는 데 의미가 있어 보입니다.`);
  } else if (keyFindings.abVsCAvgGap > 0) {
    conclusion.push(`A+B 평균 점수 ${abAvg}점 vs C등급 ${cAvg}점, 차이 ${keyFindings.abVsCAvgGap}점 — 약간의 차별력이 있지만 큰 차이는 아닙니다.`);
  } else {
    conclusion.push(`A+B 평균 점수와 C등급 차이가 거의 없습니다. 단순 점수만으로는 정상 사례를 구분하기 어렵습니다.`);
  }

  if (keyFindings.aRate85VsCRatio != null && keyFindings.aRate85VsCRatio >= 3) {
    conclusion.push(`A등급의 85점 이상 비율 ${aRate85}% 가 C등급 ${cRate85}% 의 ${keyFindings.aRate85VsCRatio}배. 85점 이상은 강한 BMS 사례로 볼 수 있습니다.`);
  }

  const bucket70plusCount = bucket85.length + bucket70.length;
  if (keyFindings.in70plus_abShare != null && keyFindings.in70plus_abShare >= 60 && bucket70plusCount >= 30) {
    conclusion.push(`70점 이상 그룹의 A+B 비율 ${keyFindings.in70plus_abShare}% (n=${bucket70plusCount}) — 70점 이상은 나중에 매수후보 보드의 기본 후보군으로 검토할 수 있습니다.`);
  }

  if (bucket85.length < 30) {
    conclusion.push(`85점 이상은 ${bucket85.length}건으로 표본이 작습니다. 강한 후보로 쓰되 후보 수 자체가 적을 수 있습니다.`);
  }

  if (keyFindings.inBelow50_cExShare != null && keyFindings.inBelow50_cExShare >= 60) {
    conclusion.push(`50점 미만에 C/excluded가 ${keyFindings.inBelow50_cExShare}% 몰림. 50점 미만은 BMS 조건 약함으로 보는 것이 적절합니다.`);
  }

  conclusion.push('이번 보고서는 BMS 단순 점수가 의미 있는지 사전 검증한 감사 보고서입니다. 위 결론은 현재 후보 보드 기준 확정이 아니라, 나중에 매수후보 보드를 만들 때 참고할 점수 기준입니다. BMS 본체는 여전히 winner-scan + winner-quality-filter 2단계로만 단순하게 유지합니다.');

  // 예시
  const examples = {
    topScore: [...cleanWinners].sort((a, b) => b.simpleBmsScore.totalScore - a.simpleBmsScore.totalScore).slice(0, 10),
    weakScoreButHighReturn: [...cleanWinners].filter(w => w.simpleBmsScore.totalScore < 50 && (w.maxHighReturn || 0) >= 50)
      .sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
    excludedTopScore: [...excludedWinners].sort((a, b) => b.simpleBmsScore.totalScore - a.simpleBmsScore.totalScore).slice(0, 10),
  };

  // 요약
  const summary = {
    totalAnalyzed: cleanWinners.length,
    excludedReferenceCount: excludedWinners.length,
    gradeACount: gA.length, gradeBCount: gB.length, gradeABCount: gAB.length, gradeCCount: gC.length,
    abAvgScore: gradeScoreSummary.AB.avgScore,
    cAvgScore: gradeScoreSummary.C.avgScore,
    exAvgScore: gradeScoreSummary.excluded.avgScore,
    aRate85: gradeScoreSummary.A.rate85plus,
    bRate70: gradeScoreSummary.B.rate70plus,
    cRateBelow50: gradeScoreSummary.C.rateBelow50,
    exRateBelow50: gradeScoreSummary.excluded.rateBelow50,
    countAt85plus: bucket85.length,
    countAt70plus: bucket85.length + bucket70.length,
    suggestedThreshold: keyFindings.in70plus_abShare >= 60 ? '70점 이상 (참고)' : '추가 검증 필요',
  };

  // 출력
  const out = {
    meta: {
      version: 'bms-simple-score-audit-v1',
      generatedAt: new Date().toISOString(),
      title: 'BMS 단순 점수 감사 보고서',
      purpose: 'BMS 정제 상승 사례에 단순한 100점 점수를 적용해, A/B 정상 상승 사례와 C/제외 사례가 점수로 구분되는지 확인. 현재 매수후보를 찾는 보드가 아닙니다.',
      scoreFormula: 'BMS Score = 들어온 돈 점수(35) + 저점 위치 점수(25) + 고점 공간 점수(25) - 위험 감점(0~15). 최종 0~85 범위.',
      scopeNote: '오직 시총 대비 상승 전 들어온 돈 + 가격 위치 + 위험 감점만 점수에 포함. 박스권 폭, QVA, 장기횡보 미사용.',
    },
    config: { SCORE_DEF, SCORE_GRADES },
    scoreDefinition: SCORE_DEF,
    summary,
    gradeScoreSummary,
    scoreBucketSummary,
    scoreGradeDistribution,
    keyFindings,
    winners: cleanWinners,
    excludedAnalyzed: excludedWinners.slice(0, 200),
    examples,
    conclusion,
    dataLimit: [
      'BMS 점수는 과거 상승 사례를 설명하기 위한 단순 점수이며, 현재 매수후보 점수로 확정된 것이 아닙니다.',
      '시총 대비 들어온 돈은 순매수금액이 아니라 거래대금 기준입니다.',
      '가격 위치는 최근 60거래일 고점/저점 기준입니다.',
      '점수는 현재 후보 보드에 아직 적용하지 않습니다.',
      '매수 신호가 아닙니다.',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // 콘솔 출력
  console.log(`\n📊 핵심 지표:`);
  console.log(`  분석 대상: cleanWinners ${cleanWinners.length}건 (A=${gA.length}, B=${gB.length}, C=${gC.length}) / excluded ${excludedWinners.length}건`);
  console.log(`  A+B 평균 점수: ${abAvg}점 / C: ${cAvg}점 / excluded: ${exAvg}점`);
  console.log(`  A 등급 85점+ 비율: ${aRate85}% / C 등급 85점+ 비율: ${cRate85}%`);
  console.log(`  C 50점 미만 비율: ${cBelow50}% / excluded 50점 미만 비율: ${exBelow50}%`);

  console.log(`\n📊 등급별 점수 분포:`);
  ['A', 'B', 'AB', 'C', 'allClean', 'excluded'].forEach(k => {
    const g = gradeScoreSummary[k];
    if (!g.count) return;
    console.log(`  ${g.label.padEnd(20)} n=${String(g.count).padStart(4)} 평균=${String(g.avgScore).padStart(5)}점 중앙=${String(g.medScore).padStart(5)}점 / 85+=${String(g.rate85plus).padStart(5)}% 70+=${String(g.rate70plus).padStart(5)}% <50=${String(g.rateBelow50).padStart(5)}%`);
  });

  console.log(`\n📊 점수 구간별 (전체 cleanWinners + excluded):`);
  ['score_85_up', 'score_70_84', 'score_50_69', 'score_below_50'].forEach(k => {
    const b = scoreBucketSummary[k];
    if (!b.count) return;
    console.log(`  ${b.label.padEnd(28)} n=${String(b.count).padStart(4)} (${String(b.share).padStart(5)}%) A=${b.aCount} B=${b.bCount} C=${b.cCount} ex=${b.exCount} | A+B=${String(b.abShare).padStart(5)}% C+ex=${String(b.cExShare).padStart(5)}% | 평균 +${b.avgHighReturn}% / 흔들림 ${b.avgDrawdown}%`);
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
<title>BMS 단순 점수 감사 보고서</title>
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
.def-box { background: #1e293b; border-left: 4px solid #10b981; padding: 12px 16px; border-radius: 6px; margin-bottom: 10px; line-height: 1.6; }
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
.row-strong td { background: rgba(20, 184, 166, 0.18) !important; }
.row-classic td { background: rgba(16, 185, 129, 0.16) !important; }
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
table.list tbody tr.row td.col-summary { color: #cbd5e1; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: normal; line-height: 1.4; font-size: 11.5px; }
table.list tbody tr.row:nth-child(odd) { background: #1c2942; }
table.list tbody tr.row:nth-child(odd):hover { background: #273549; }
table.list tbody tr.row.expanded, table.list tbody tr.row.expanded:nth-child(odd) { background: #1e3a5f; }

.grade-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.grade-A { background: #14532d; color: #6ee7b7; }
.grade-B { background: #1e40af; color: #dbeafe; }
.grade-C { background: #475569; color: #cbd5e1; }
.grade-excluded { background: #7f1d1d; color: #fca5a5; }
.score-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.score-strong  { background: #115e59; color: #99f6e4; }
.score-classic { background: #14532d; color: #a7f3d0; }
.score-partial { background: #1e40af; color: #dbeafe; }
.score-weak    { background: #7f1d1d; color: #fca5a5; }
.score-cell { font-weight: 800; color: #fde047; font-size: 13px; }

table.list tbody tr.detail { display: none; background: #0c1729; }
table.list tbody tr.detail.show { display: table-row; }
table.list tbody tr.detail td { padding: 14px 18px; border-bottom: 1px solid #1e3a5f; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 24px; font-size: 12px; }
.detail-block h4 { margin: 0 0 6px; font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; line-height: 1.6; }
.kv .k { color: #64748b; }
.kv .v { color: #cbd5e1; font-variant-numeric: tabular-nums; }

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

<h1>BMS 단순 점수 감사 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 이 보고서는 BMS 정제 상승 사례에 단순한 100점 점수를 적용해, A/B와 C/excluded가 점수로 구분되는지 확인하는 감사 보고서입니다.
  <strong>현재 매수후보를 찾는 보드가 아닙니다.</strong> 점수는 아직 후보 보드에 적용하지 않습니다.
</div>

<div class="note-box">
  💡 <strong>점수 공식:</strong> BMS Score = 들어온 돈 점수(35) + 저점 위치 점수(25) + 고점 공간 점수(25) − 위험 감점(0~15) → <strong>0~85 범위</strong>.
  박스권 폭, QVA, 장기횡보 모두 빼고 오직 "들어온 돈 + 가격 위치 + 위험 감점"만 사용합니다.
</div>

<h2>📊 핵심 지표</h2>
<div class="big-summary" id="big-summary"></div>

<h2>🎯 BMS 점수 정의</h2>
<div id="score-def"></div>

<h2>📊 등급별 점수 분포</h2>
<div id="grade-table"></div>

<h2>📊 점수 구간별 성과</h2>
<p class="subtitle">전체 (cleanWinners + excluded) 기준 — 각 구간의 평균/A·B·C·excluded 분포</p>
<div id="bucket-table"></div>

<h2>📝 결론</h2>
<div id="conclusion-box" class="purpose-box" style="border-left-color:#10b981;"></div>

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
        <th class="numeric">BMS 점수</th>
        <th>점수 등급</th>
        <th class="numeric col-mobile-hide">들어온 돈 점수</th>
        <th class="numeric col-mobile-hide">저점 점수</th>
        <th class="numeric col-mobile-hide">고점 점수</th>
        <th class="numeric col-mobile-hide">위험 감점</th>
        <th class="col-mobile-hide">정석</th>
        <th class="col-mobile-hide">강한</th>
        <th class="col-summary col-mobile-hide">한 줄 해석</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<footer class="foot">
  <strong>매수 신호가 아닙니다.</strong> BMS Simple Score Audit는 <em>점수화 방식이 의미 있는지 사전 검증</em>하는 감사 도구입니다.
  점수를 처음부터 BMS 매수후보 보드로 확정해서 쓰지 않습니다.
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
  const excluded = data.excludedAnalyzed || [];

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d); }
  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtPctRaw(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }
  function fmtMc(v) { if (!v) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; return Math.round(e) + '억'; }
  function fmtPrice(v) { if (!v) return '-'; return Number(v).toLocaleString() + '원'; }
  function clsRet(v) { if (v == null || !isFinite(v)) return ''; return v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : ''); }
  function scoreCls(g) {
    if (g === 'strong') return 'score-strong';
    if (g === 'classic') return 'score-classic';
    if (g === 'partial') return 'score-partial';
    return 'score-weak';
  }

  document.getElementById('subtitle').innerHTML =
    '분석 대상 cleanWinners ' + summary.totalAnalyzed + '건 (A=' + summary.gradeACount + ' B=' + summary.gradeBCount + ' C=' + summary.gradeCCount + ') / excluded 참고 ' + summary.excludedReferenceCount + '건 · A+B 평균 ' + fmtNum(summary.abAvgScore) + '점 vs C ' + fmtNum(summary.cAvgScore) + '점 · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>📌 점수 공식:</strong> ' + escapeHtml(meta.scoreFormula) +
    '<br><strong>분석 범위:</strong> ' + escapeHtml(meta.scopeNote);

  document.getElementById('data-limit').innerHTML =
    '데이터 한계:<br>' + (data.dataLimit || []).map(l => '&nbsp;&bull; ' + escapeHtml(l)).join('<br>');

  // 핵심 타일
  const tiles = [
    { label: '분석 대상', value: summary.totalAnalyzed + '건', sub: 'A ' + summary.gradeACount + ' / B ' + summary.gradeBCount + ' / C ' + summary.gradeCCount, cls: 'primary' },
    { label: 'A+B 평균 점수', value: fmtNum(summary.abAvgScore) + '점', sub: 'C ' + fmtNum(summary.cAvgScore) + '점 / excluded ' + fmtNum(summary.exAvgScore) + '점', cls: 'success' },
    { label: 'A등급 85점+ 비율', value: fmtPctRaw(summary.aRate85), sub: '강한 BMS 점수 도달', cls: 'strong' },
    { label: 'B등급 70점+ 비율', value: fmtPctRaw(summary.bRate70), sub: '정석 BMS 이상' },
    { label: 'C등급 50점-', value: fmtPctRaw(summary.cRateBelow50), sub: '약함 그룹', cls: 'warn' },
    { label: 'excluded 50점-', value: fmtPctRaw(summary.exRateBelow50), sub: '제외와 약함이 일치하는지', cls: 'warn' },
    { label: '85점 이상 사례', value: summary.countAt85plus + '건', sub: '강한 BMS', cls: 'strong' },
    { label: '70점 이상 사례', value: summary.countAt70plus + '건', sub: '정석 BMS 이상', cls: 'success' },
    { label: '추천 점수 기준', value: summary.suggestedThreshold || '-', sub: '미확정 — 참고용', cls: 'strong' },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div><div class="sub">' + t.sub + '</div>';
    ts.appendChild(el);
  });

  // 점수 정의
  const sd = data.scoreDefinition || {};
  function defBlock(title, conf, color) {
    let html = '<div class="def-box" style="border-left-color:' + color + ';"><strong>' + escapeHtml(title) + ' (최대 ' + conf.max + '점)</strong>' +
      '<p style="font-size:11.5px;color:#94a3b8;margin:4px 0;">' + escapeHtml(conf.description || '') + '</p>';
    if (conf.rules) {
      html += '<ul style="margin:4px 0 0 16px;font-size:11.5px;color:#cbd5e1;">';
      conf.rules.forEach(r => {
        html += '<li>' + escapeHtml(r.label) + ' → <strong style="color:#fde047;">' + r.score + '점</strong></li>';
      });
      html += '</ul>';
    }
    html += '</div>';
    return html;
  }
  document.getElementById('score-def').innerHTML =
    defBlock(sd.valueRatio?.label || '들어온 돈', sd.valueRatio || {}, '#10b981') +
    defBlock(sd.lowPosition?.label || '저점 위치', sd.lowPosition || {}, '#0ea5e9') +
    defBlock(sd.highPosition?.label || '고점 공간', sd.highPosition || {}, '#a78bfa') +
    '<div class="def-box" style="border-left-color:#ef4444;"><strong>위험 감점 (최대 -15점)</strong>' +
    '<ul style="margin:4px 0 0 16px;font-size:11.5px;color:#cbd5e1;">' +
    '<li>들어온 돈 40% 초과 → -5</li>' +
    '<li>들어온 돈 80% 초과 → 추가 -5</li>' +
    '<li>저점 대비 +70% 초과 → -5</li>' +
    '<li>고점 대비 -3% 초과 → -5</li>' +
    '<li>핵심값 데이터 2개 이상 부족 → -10</li>' +
    '</ul></div>';

  // 등급별 표
  const gss = data.gradeScoreSummary || {};
  const gradeOrder = ['A', 'B', 'AB', 'C', 'allClean', 'excluded'];
  let gtHtml = '<table class="cmp"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>평균 점수</th><th>중앙값</th><th>85+ 비율</th><th>70+ 비율</th><th>50- 비율</th>' +
    '<th>평균 상승률</th><th>평균 종가</th><th>평균 흔들림</th>' +
    '</tr></thead><tbody>';
  gradeOrder.forEach(k => {
    const g = gss[k];
    if (!g || !g.count) return;
    const cls = (k === 'AB') ? 'row-classic' : ((k === 'A') ? 'row-strong' : ((k === 'excluded') ? 'row-warn' : ''));
    gtHtml += '<tr class="' + cls + '">' +
      '<td>' + escapeHtml(g.label) + '</td>' +
      '<td>' + g.count + '</td>' +
      '<td class="score-cell">' + fmtNum(g.avgScore, 1) + '</td>' +
      '<td>' + fmtNum(g.medScore, 0) + '</td>' +
      '<td class="cell-pos">' + fmtPctRaw(g.rate85plus) + '</td>' +
      '<td class="cell-pos">' + fmtPctRaw(g.rate70plus) + '</td>' +
      '<td class="cell-neg">' + fmtPctRaw(g.rateBelow50) + '</td>' +
      '<td class="cell-pos">' + fmtPct(g.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(g.avgCloseReturn) + '</td>' +
      '<td class="cell-neg">' + fmtPctRaw(g.avgDrawdown) + '</td>' +
    '</tr>';
  });
  gtHtml += '</tbody></table>';
  document.getElementById('grade-table').innerHTML = gtHtml;

  // 점수 구간별 표
  const sbs = data.scoreBucketSummary || {};
  const bucketOrder = ['score_85_up', 'score_70_84', 'score_50_69', 'score_below_50'];
  let btHtml = '<table class="cmp"><thead><tr>' +
    '<th>구간</th><th>n</th><th>비율</th><th>A</th><th>B</th><th>C</th><th>excl</th><th>A+B 비율</th><th>C+ex 비율</th>' +
    '<th>평균 상승률</th><th>평균 종가</th><th>평균 흔들림</th><th>평균 들어온돈</th><th>저점대비</th><th>고점대비</th>' +
    '</tr></thead><tbody>';
  bucketOrder.forEach(k => {
    const b = sbs[k];
    if (!b || !b.count) return;
    const cls = (k === 'score_85_up') ? 'row-strong' : ((k === 'score_70_84') ? 'row-classic' : ((k === 'score_below_50') ? 'row-warn' : ''));
    btHtml += '<tr class="' + cls + '">' +
      '<td>' + escapeHtml(b.label) + '</td>' +
      '<td>' + b.count + '</td>' +
      '<td>' + fmtPctRaw(b.share) + '</td>' +
      '<td>' + b.aCount + '</td>' +
      '<td>' + b.bCount + '</td>' +
      '<td>' + b.cCount + '</td>' +
      '<td>' + b.exCount + '</td>' +
      '<td class="cell-pos">' + fmtPctRaw(b.abShare) + '</td>' +
      '<td class="cell-neg">' + fmtPctRaw(b.cExShare) + '</td>' +
      '<td class="cell-pos">' + fmtPct(b.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(b.avgCloseReturn) + '</td>' +
      '<td class="cell-neg">' + fmtPctRaw(b.avgDrawdown) + '</td>' +
      '<td>' + fmtPctRaw(b.avgPreAccum) + '</td>' +
      '<td>' + fmtPct(b.avgCloseFromLow60) + '</td>' +
      '<td>' + fmtPct(b.avgCloseFromHigh60) + '</td>' +
    '</tr>';
  });
  btHtml += '</tbody></table>';
  document.getElementById('bucket-table').innerHTML = btHtml;

  // 결론
  document.getElementById('conclusion-box').innerHTML =
    '<strong>📌 자동 결론:</strong><br>' + (data.conclusion || []).map(c => '• ' + escapeHtml(c)).join('<br><br>');

  // 탭
  const allItems = [...winners, ...excluded];
  const tabs = [
    { id: 'all', label: '전체 (' + allItems.length + ')' },
    { id: 'score_85_up', label: '85점 이상 (' + allItems.filter(w => (w.simpleBmsScore?.totalScore || 0) >= 85).length + ')' },
    { id: 'score_70_84', label: '70~84점 (' + allItems.filter(w => { const s = w.simpleBmsScore?.totalScore || 0; return s >= 70 && s < 85; }).length + ')' },
    { id: 'score_50_69', label: '50~69점 (' + allItems.filter(w => { const s = w.simpleBmsScore?.totalScore || 0; return s >= 50 && s < 70; }).length + ')' },
    { id: 'score_below_50', label: '50점 미만 (' + allItems.filter(w => (w.simpleBmsScore?.totalScore || 0) < 50).length + ')' },
    { id: 'A', label: 'A등급 (' + winners.filter(w => w.grade === 'A').length + ')' },
    { id: 'B', label: 'B등급 (' + winners.filter(w => w.grade === 'B').length + ')' },
    { id: 'C', label: 'C등급 (' + winners.filter(w => w.grade === 'C').length + ')' },
    { id: 'excluded', label: 'excluded 참고 (' + excluded.length + ')' },
  ];
  const tabsEl = document.getElementById('tabs');
  let activeTab = 'score_85_up';
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
    if (activeTab === 'all') return allItems;
    if (activeTab === 'score_85_up') return allItems.filter(w => (w.simpleBmsScore?.totalScore || 0) >= 85);
    if (activeTab === 'score_70_84') return allItems.filter(w => { const s = w.simpleBmsScore?.totalScore || 0; return s >= 70 && s < 85; });
    if (activeTab === 'score_50_69') return allItems.filter(w => { const s = w.simpleBmsScore?.totalScore || 0; return s >= 50 && s < 70; });
    if (activeTab === 'score_below_50') return allItems.filter(w => (w.simpleBmsScore?.totalScore || 0) < 50);
    if (activeTab === 'A' || activeTab === 'B' || activeTab === 'C') return winners.filter(w => w.grade === activeTab);
    if (activeTab === 'excluded') return excluded;
    return allItems;
  }

  const tbody = document.getElementById('list-body');
  function renderList() {
    tbody.innerHTML = '';
    let list = pickList();
    list = [...list].sort((a, b) => (b.simpleBmsScore?.totalScore || 0) - (a.simpleBmsScore?.totalScore || 0));
    list.slice(0, 500).forEach((w, i) => {
      const s = w.simpleBmsScore || {};
      const cc = w.coreCondition || {};
      const tr = document.createElement('tr');
      tr.className = 'row';
      const yes = '<span style="color:#6ee7b7;font-weight:700;">✓</span>';
      const no  = '<span style="color:#fca5a5;">✗</span>';
      tr.innerHTML =
        '<td>' + (i + 1) + '</td>' +
        '<td class="col-name">' + escapeHtml(w.name) + '<span class="meta">' + w.code + ' · ' + (w.market || '-') + '</span></td>' +
        '<td><span class="grade-pill grade-' + (w.grade || 'C') + '">' + escapeHtml(w.grade || '-') + '</span></td>' +
        '<td class="col-mobile-hide">' + fmtDate(w.startDate) + '</td>' +
        '<td class="numeric cell-pos" style="font-weight:700;">' + fmtPct(w.maxHighReturn) + '</td>' +
        '<td class="numeric col-mobile-hide ' + clsRet(w.maxCloseReturn) + '">' + fmtPct(w.maxCloseReturn) + '</td>' +
        '<td class="numeric score-cell">' + (s.totalScore != null ? s.totalScore : '-') + '</td>' +
        '<td><span class="score-pill ' + scoreCls(s.scoreGrade) + '">' + escapeHtml(s.scoreLabel || '-') + '</span></td>' +
        '<td class="numeric col-mobile-hide">' + (s.valueScore != null ? s.valueScore : '-') + '</td>' +
        '<td class="numeric col-mobile-hide">' + (s.lowPositionScore != null ? s.lowPositionScore : '-') + '</td>' +
        '<td class="numeric col-mobile-hide">' + (s.highPositionScore != null ? s.highPositionScore : '-') + '</td>' +
        '<td class="numeric col-mobile-hide cell-neg">' + (s.riskPenalty ? '-' + s.riskPenalty : '0') + '</td>' +
        '<td class="col-mobile-hide">' + (cc.matchesClassicBms ? yes : no) + '</td>' +
        '<td class="col-mobile-hide">' + (cc.matchesStrongBms ? yes : no) + '</td>' +
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
    const s = w.simpleBmsScore || {};
    const sb = s.scoreBreakdown || {};
    const cc = w.coreCondition || {};
    const reasonsHtml = (arr) => (arr && arr.length > 0)
      ? '<ul style="margin:4px 0 0 16px;color:#fca5a5;font-size:11px;">' + arr.map(r => '<li>' + escapeHtml(r) + '</li>').join('') + '</ul>'
      : '<p style="color:#94a3b8;font-size:11px;margin:0;">없음</p>';
    return '<div class="detail-grid">' +
      '<div class="detail-block"><h4>📌 BMS 상승 사례</h4>' +
        '<div class="kv">' +
          '<div class="k">등급</div><div class="v">' + escapeHtml(w.grade || '-') + '</div>' +
          '<div class="k">시총</div><div class="v">' + fmtMc(w.marketCap) + '</div>' +
          '<div class="k">상승 시작일</div><div class="v">' + fmtDate(w.startDate) + '</div>' +
          '<div class="k">+40% 도달일</div><div class="v">' + fmtDate(w.peakDate) + '</div>' +
          '<div class="k">고가 상승률</div><div class="v cell-pos">' + fmtPct(w.maxHighReturn) + '</div>' +
          '<div class="k">상승 소요</div><div class="v">' + (w.daysToPeak || '-') + '거래일</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block"><h4>🎯 BMS 점수 (' + (s.totalScore || 0) + '점)</h4>' +
        '<div class="kv">' +
          '<div class="k">점수 등급</div><div class="v"><span class="score-pill ' + scoreCls(s.scoreGrade) + '">' + escapeHtml(s.scoreLabel || '-') + '</span></div>' +
          '<div class="k">들어온 돈 점수</div><div class="v">' + (s.valueScore != null ? s.valueScore + '점' : '-') + ' (' + escapeHtml(sb.valueScoreReason || '-') + ')</div>' +
          '<div class="k">저점 위치 점수</div><div class="v">' + (s.lowPositionScore != null ? s.lowPositionScore + '점' : '-') + ' (' + escapeHtml(sb.lowPositionReason || '-') + ')</div>' +
          '<div class="k">고점 공간 점수</div><div class="v">' + (s.highPositionScore != null ? s.highPositionScore + '점' : '-') + ' (' + escapeHtml(sb.highPositionReason || '-') + ')</div>' +
          '<div class="k">위험 감점</div><div class="v cell-neg">' + (s.riskPenalty ? '-' + s.riskPenalty + '점' : '없음') + '</div>' +
        '</div>' +
        '<p style="color:#cbd5e1;font-size:11.5px;line-height:1.5;margin-top:6px;">' + escapeHtml(s.explanation || '') + '</p>' +
      '</div>' +
      '<div class="detail-block"><h4>📊 핵심 값</h4>' +
        '<div class="kv">' +
          '<div class="k">시총 대비 들어온 돈</div><div class="v">' + fmtPct(sb.preAccumulationRatio) + '</div>' +
          '<div class="k">저점 대비 위치</div><div class="v">' + fmtPct(sb.closeFromLow60) + '</div>' +
          '<div class="k">고점까지 남은 공간</div><div class="v">' + fmtPct(sb.closeFromHigh60) + '</div>' +
        '</div>' +
        '<p style="color:#94a3b8;font-size:11px;margin-top:6px;"><strong>위험 감점 사유:</strong></p>' + reasonsHtml(sb.riskPenaltyReasons) +
      '</div>' +
      '<div class="detail-block"><h4>🎯 BMS 핵심 조건 (참고)</h4>' +
        '<div class="kv">' +
          '<div class="k">조건 라벨</div><div class="v">' + escapeHtml(cc.conditionLabel || '-') + '</div>' +
          '<div class="k">정석 BMS</div><div class="v">' + (cc.matchesClassicBms ? '<span style="color:#6ee7b7;font-weight:700;">통과</span>' : '<span style="color:#fca5a5;">미통과</span>') + '</div>' +
          '<div class="k">강한 BMS</div><div class="v">' + (cc.matchesStrongBms ? '<span style="color:#6ee7b7;font-weight:700;">통과</span>' : '<span style="color:#fca5a5;">미통과</span>') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block" style="grid-column: 1 / -1;"><h4>한 줄 해석</h4>' +
        '<p style="color:#fde68a;font-size:13px;line-height:1.6;">' + escapeHtml(w.oneLineSummary || '') + '</p>' +
        '<p style="color:#94a3b8;font-size:11px;margin-top:6px;">⚠️ 점수는 과거 사례 설명용 단순 점수입니다. 현재 매수후보 점수로 확정된 것이 아니며 매수 신호가 아닙니다.</p>' +
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
