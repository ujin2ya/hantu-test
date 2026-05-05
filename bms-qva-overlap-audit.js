#!/usr/bin/env node
/**
 * BMS × QVA Overlap Audit
 *
 * 목적:
 *   BMS 정제 상승 사례(reports/bms-winner-quality-filter-result.json의 cleanWinners A+B)에 대해
 *   상승 시작일(startDate) 이전 ~20거래일 동안 QVA 신호가 있었는지 감사한다.
 *
 *   QVA를 BMS 필터로 쓰지 않는다. 두 모델의 겹침 여부와 성과 차이를 확인하는 감사 보고서다.
 *
 * 데이터 누수 방지:
 *   QVA 신호는 반드시 startDate 이전 데이터만으로 계산한다. (rows.slice(0, idx+1))
 *
 * QVA 로직:
 *   pattern-screener.js 의 calculateQuietVolumeHigherLow / calculateQuietVolumeHold 재사용.
 *   두 함수 모두 chartRows 마지막 row에서 신호를 판단하므로, 각 검사일까지의 slice 를 넘긴다.
 *   원본의 marketCap 500억 하한 필터는 그대로 둔다 — 그 이하 종목은 신호 미발생으로 보고.
 *
 * 입력:
 *   - reports/bms-winner-quality-filter-result.json (cleanWinners)
 *   - cache/stock-charts-long/{code}.json
 *
 * 출력:
 *   - reports/bms-qva-overlap-audit-result.json
 *   - reports/bms-qva-overlap-audit-result.html
 *
 * 실행:
 *   node bms-qva-overlap-audit.js
 *   node bms-qva-overlap-audit.js --grades=AB    (기본, A+B만)
 *   node bms-qva-overlap-audit.js --grades=ABC   (C까지 포함)
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const INPUT_FILE = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-qva-overlap-audit-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-qva-overlap-audit-result.html');

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
  LOOKBACK_DAYS: 20,
  WINDOWS: [0, 5, 10, 20], // 검사 기간 (시작일 당일=0, 5일전, 10일전, 20일전)
};

// ─────────────────────── pattern-screener QVA 재사용 ───────────────────────

const screener = require('./pattern-screener.js');
const calcHigherLow = screener.calculateQuietVolumeHigherLow;
const calcHold = screener.calculateQuietVolumeHold;

if (typeof calcHigherLow !== 'function' || typeof calcHold !== 'function') {
  console.error('pattern-screener.js 에서 QVA 함수를 가져오지 못했습니다.');
  process.exit(1);
}

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
function rate(predicate, arr) {
  const valid = arr.filter(x => x != null);
  if (valid.length === 0) return null;
  return pct(valid.filter(predicate).length, valid.length);
}

function fmtDate(d) { return d && d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) : (d || '-'); }

// chart rows 에서 date 의 idx 찾기 (없으면 -1)
function findIdxByDate(rows, date) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === date) return i;
    if (rows[i].date < date) break;
  }
  return -1;
}

// ─────────────────────── QVA 검사 ───────────────────────

// runQvaAt: 차트 rows[0..idx+1] 슬라이스로 QVA HL/HOLD 신호 판정
// meta는 marketValue 만 필요 (QVA의 내부 필터용)
function runQvaAt(rows, idx, meta) {
  if (idx < 59) return { hl: false, hold: false }; // QVA 자체가 60 rows 필요
  const slice = rows.slice(0, idx + 1);
  let hl = false, hold = false;
  try {
    const r1 = calcHigherLow(slice, [], meta);
    if (r1 && r1.passed === true) hl = true;
  } catch (_) {}
  try {
    const r2 = calcHold(slice, [], meta);
    if (r2 && r2.passed === true) hold = true;
  } catch (_) {}
  return { hl, hold };
}

// 각 winner에 대해 startDate 이전 LOOKBACK_DAYS 동안 QVA 신호를 검사
function analyzeWinner(w, rows) {
  const meta = { marketValue: w.marketCap || 0, isSpecial: false, isEtf: false };
  // startDate 가 chart에 있는지 확인 (백테스트 데이터라 chart는 그 날짜를 포함)
  const startIdx = findIdxByDate(rows, w.startDate);
  if (startIdx < 0) {
    return { dataLimit: 'startDate 차트에 없음', signals: [] };
  }

  // 검사 범위: startIdx-20 ~ startIdx (총 21 거래일)
  const windowStart = Math.max(0, startIdx - CONFIG.LOOKBACK_DAYS);
  const signals = [];
  for (let i = windowStart; i <= startIdx; i++) {
    const sig = runQvaAt(rows, i, meta);
    if (sig.hl || sig.hold) {
      signals.push({
        date: rows[i].date,
        daysBeforeStart: startIdx - i,
        hl: sig.hl,
        hold: sig.hold,
      });
    }
  }

  const inWindow = (n) => signals.filter(s => s.daysBeforeStart <= n);
  const has = (n) => inWindow(n).length > 0;
  const onStart = signals.find(s => s.daysBeforeStart === 0);
  const within5 = inWindow(5);
  const within10 = inWindow(10);
  const within20 = inWindow(20);

  // 가장 먼저 (가장 오래된) QVA 신호 = 큰 daysBeforeStart 가 첫 신호
  let firstSig = null, nearestSig = null;
  if (signals.length > 0) {
    firstSig = signals.reduce((acc, s) => (acc == null || s.daysBeforeStart > acc.daysBeforeStart ? s : acc), null);
    nearestSig = signals.reduce((acc, s) => (acc == null || s.daysBeforeStart < acc.daysBeforeStart ? s : acc), null);
  }

  // 신호 유형 집계
  const types = new Set();
  signals.forEach(s => { if (s.hl) types.add('QVA-HIGHER_LOW'); if (s.hold) types.add('QVA-HOLD'); });

  return {
    hasAnyQvaBeforeStart: has(20),
    hasQvaOnStartDate: !!onStart,
    hasQvaWithin5Days: has(5),
    hasQvaWithin10Days: has(10),
    hasQvaWithin20Days: has(20),
    hasHigherLowBefore: signals.some(s => s.hl),
    hasHoldBefore: signals.some(s => s.hold),
    hasBothBefore: types.has('QVA-HIGHER_LOW') && types.has('QVA-HOLD'),
    firstQvaDateBeforeStart: firstSig?.date || null,
    daysFromFirstQvaToStart: firstSig?.daysBeforeStart ?? null,
    nearestQvaDateBeforeStart: nearestSig?.date || null,
    daysFromNearestQvaToStart: nearestSig?.daysBeforeStart ?? null,
    qvaTypesBeforeStart: [...types].sort(),
    qvaSignalCount: signals.length,
    qvaSignals: signals.slice(0, 25), // 너무 많으면 잘라냄
  };
}

// ─────────────────────── 한 줄 해석 ───────────────────────

function buildOneLine(w) {
  const q = w.qva || {};
  if (q.hasQvaOnStartDate) {
    return '상승 시작일 당일 QVA 흔적이 확인된 사례입니다.';
  }
  if (q.hasBothBefore) {
    return 'QVA-HIGHER_LOW와 QVA-HOLD 흔적이 모두 BMS 상승 전에 나타난 겹침 사례입니다.';
  }
  if (q.hasQvaWithin20Days) {
    const types = (q.qvaTypesBeforeStart || []).join(' + ') || 'QVA';
    const days = q.daysFromFirstQvaToStart;
    if (days != null) {
      return '상승 ' + days + '거래일 전에 ' + types + ' 흔적이 있었고, 이후 +' + round(w.maxHighReturn, 1) + '% 상승했습니다.';
    }
    return types + ' 흔적이 BMS 상승 전 20거래일 안에 있었습니다.';
  }
  return 'QVA 흔적은 없었지만 BMS 기준으로 상승 전 거래대금이 충분히 쌓인 사례입니다.';
}

// ─────────────────────── 그룹 통계 ───────────────────────

function summarizeGroup(items) {
  if (!items || items.length === 0) return { count: 0 };
  const high = items.map(w => w.maxHighReturn);
  const close = items.map(w => w.maxCloseReturn);
  const days = items.map(w => w.daysToPeak);
  const accum = items.map(w => w.bmsMetrics?.preAccumulatedValueRatio);
  const box = items.map(w => w.bmsMetrics?.boxRangePct);
  const low60 = items.map(w => w.bmsMetrics?.closeFromLow60);
  const high60 = items.map(w => w.bmsMetrics?.closeFromHigh60);
  const supply = items.map(w => w.bmsMetrics?.supplyAboveRatio);
  const drawdown = items.map(w => w.bmsMetrics?.postDrawdownPct);
  const lead = items.map(w => w.qva?.daysFromFirstQvaToStart).filter(v => v != null);
  return {
    count: items.length,
    avgHighReturn: avg(high), medHighReturn: median(high),
    avgCloseReturn: avg(close), medCloseReturn: median(close),
    avgDaysToPeak: avg(days), medDaysToPeak: median(days),
    avgPreAccum: avg(accum),
    avgBoxRange: avg(box),
    avgCloseFromLow60: avg(low60),
    avgCloseFromHigh60: avg(high60),
    avgSupplyAbove: avg(supply),
    avgPostDrawdown: avg(drawdown),
    avgQvaLeadDays: avg(lead),
  };
}

// 각 winner 의 BMS 핵심 지표 추출 (보고서·그룹 비교용 평탄화)
function extractBmsMetrics(w) {
  const a = w.analysis || {};
  return {
    preAccumulatedValueRatio: a.preAccumulation?.accumulatedValueRatio,
    valueSpikeRatio: a.preAccumulation?.valueSpikeRatio,
    boxRangePct: a.boxAnalysis?.boxRangePct,
    boxRangeDays: a.boxAnalysis?.days,
    closeFromLow60: a.pricePosition?.closeFromLow60,
    closeFromHigh60: a.pricePosition?.closeFromHigh60,
    supplyAboveRatio: a.supplyZone?.aboveCloseRatio,
    postDrawdownPct: a.postAnalysis?.drawdownFromPeakClose,
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('BMS × QVA Overlap Audit');
  console.log('═'.repeat(80));

  if (!fs.existsSync(INPUT_FILE)) {
    console.error('입력 파일 없음:', INPUT_FILE);
    console.error('먼저 node bms-winner-quality-filter-report.js 를 실행하세요.');
    process.exit(1);
  }

  const input = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8'));
  const cleanWinners = input.cleanWinners || [];
  console.log(`입력: cleanWinners ${cleanWinners.length}건 (A=${input.gradeSummary?.A?.count} B=${input.gradeSummary?.B?.count} C=${input.gradeSummary?.C?.count})`);

  const targetGrades = CONFIG.INCLUDE_C ? [...CONFIG.GRADES_PRIMARY, ...CONFIG.GRADES_REFERENCE] : [...CONFIG.GRADES_PRIMARY];
  console.log(`대상 등급: ${targetGrades.join('+')}`);

  const targets = cleanWinners.filter(w => targetGrades.includes(w._grade));
  const cReference = cleanWinners.filter(w => w._grade === 'C');
  console.log(`분석 대상: ${targets.length}건 (참고용 C: ${cReference.length}건)`);

  const startTime = Date.now();
  const winners = [];
  let chartMissing = 0, startDateMissing = 0;

  // A+B 분석 (메인)
  targets.forEach((w, i) => {
    if ((i + 1) % 50 === 0) console.log(`  진행: ${i + 1}/${targets.length}`);
    const chartFile = path.join(CHART_DIR, w.code + '.json');
    if (!fs.existsSync(chartFile)) { chartMissing++; return; }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartFile, 'utf-8')); } catch (_) { chartMissing++; return; }
    const rows = chart.rows || [];
    if (rows.length < 60) { startDateMissing++; return; }

    const qva = analyzeWinner(w, rows);
    if (qva.dataLimit) startDateMissing++;
    const bmsMetrics = extractBmsMetrics(w);
    const out = {
      code: w.code, name: w.name, market: w.market, marketCap: w.marketCap,
      grade: w._grade,
      startDate: w.startDate, peakDate: w.peakDate,
      startClose: w.startClose, peakHigh: w.peakHigh, peakClose: w.peakClose,
      daysToPeak: w.daysToPeak,
      maxHighReturn: w.maxHighReturn,
      maxCloseReturn: w.maxCloseReturn,
      bmsMetrics,
      qva,
    };
    out.oneLineSummary = buildOneLine(out);
    winners.push(out);
  });

  // C 참고용 — 가벼운 집계만 (대조군)
  const cWinners = [];
  if (CONFIG.INCLUDE_C === false) {
    cReference.forEach((w, i) => {
      if ((i + 1) % 100 === 0) console.log(`  C 참고 진행: ${i + 1}/${cReference.length}`);
      const chartFile = path.join(CHART_DIR, w.code + '.json');
      if (!fs.existsSync(chartFile)) return;
      let chart;
      try { chart = JSON.parse(fs.readFileSync(chartFile, 'utf-8')); } catch (_) { return; }
      const rows = chart.rows || [];
      if (rows.length < 60) return;
      const qva = analyzeWinner(w, rows);
      cWinners.push({
        code: w.code, name: w.name, grade: 'C',
        startDate: w.startDate, peakDate: w.peakDate,
        maxHighReturn: w.maxHighReturn, maxCloseReturn: w.maxCloseReturn,
        daysToPeak: w.daysToPeak,
        bmsMetrics: extractBmsMetrics(w),
        qva,
      });
    });
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n분석 완료: ${winners.length}건 (${elapsed.toFixed(1)}초)`);
  if (chartMissing > 0 || startDateMissing > 0) {
    console.log(`  데이터 한계: 차트없음 ${chartMissing} / startDate 차트 외 ${startDateMissing}`);
  }

  // ─── 요약 ───
  const gradeA = winners.filter(w => w.grade === 'A');
  const gradeB = winners.filter(w => w.grade === 'B');
  const gradeC = winners.filter(w => w.grade === 'C'); // INCLUDE_C 시
  const all = [...winners];

  const qva20 = all.filter(w => w.qva?.hasQvaWithin20Days);
  const qva10 = all.filter(w => w.qva?.hasQvaWithin10Days);
  const qva5 = all.filter(w => w.qva?.hasQvaWithin5Days);
  const qva0 = all.filter(w => w.qva?.hasQvaOnStartDate);

  const qvaPresent = all.filter(w => w.qva?.hasQvaWithin20Days);
  const qvaAbsent = all.filter(w => !w.qva?.hasQvaWithin20Days);
  const qvaHold = all.filter(w => w.qva?.hasHoldBefore);
  const qvaHL = all.filter(w => w.qva?.hasHigherLowBefore);
  const qvaBoth = all.filter(w => w.qva?.hasBothBefore);

  // C 참고 집계 (간단 비율만)
  const cQvaPresent = cWinners.filter(w => w.qva?.hasQvaWithin20Days);

  const summary = {
    totalAnalyzed: all.length,
    gradeACount: gradeA.length,
    gradeBCount: gradeB.length,
    gradeCCount: CONFIG.INCLUDE_C ? gradeC.length : cWinners.length,
    cIncludedInGroupCompare: CONFIG.INCLUDE_C,
    qvaWithin20Count: qva20.length,
    qvaWithin20Rate: pct(qva20.length, all.length),
    qvaWithin10Rate: pct(qva10.length, all.length),
    qvaWithin5Rate: pct(qva5.length, all.length),
    qvaOnStartRate: pct(qva0.length, all.length),
    qvaHoldRate: pct(qvaHold.length, all.length),
    qvaHigherLowRate: pct(qvaHL.length, all.length),
    qvaBothRate: pct(qvaBoth.length, all.length),
    avgQvaLeadDays: avg(all.map(w => w.qva?.daysFromFirstQvaToStart).filter(v => v != null)),
    cReferenceQvaWithin20Rate: cWinners.length > 0 ? pct(cQvaPresent.length, cWinners.length) : null,
    cReferenceCount: cWinners.length,
  };

  // ─── 그룹 비교 ───
  const groupCompare = {
    bmsPlusQva: { label: 'BMS + QVA 있음', ...summarizeGroup(qvaPresent) },
    bmsOnly: { label: 'BMS 단독 (QVA 없음)', ...summarizeGroup(qvaAbsent) },
    bmsHold: { label: 'BMS + QVA-HOLD', ...summarizeGroup(qvaHold) },
    bmsHL: { label: 'BMS + QVA-HIGHER_LOW', ...summarizeGroup(qvaHL) },
    bmsBoth: { label: 'BMS + QVA 둘 다', ...summarizeGroup(qvaBoth) },
    all: { label: '전체', ...summarizeGroup(all) },
  };

  // ─── QVA 선행일 분포 ───
  const buckets = [
    { label: '당일', min: 0, max: 0 },
    { label: '1~3거래일 전', min: 1, max: 3 },
    { label: '4~5거래일 전', min: 4, max: 5 },
    { label: '6~10거래일 전', min: 6, max: 10 },
    { label: '11~20거래일 전', min: 11, max: 20 },
  ];
  const qvaLeadTimeDistribution = buckets.map(b => {
    const items = all.filter(w => {
      const d = w.qva?.daysFromFirstQvaToStart;
      return d != null && d >= b.min && d <= b.max;
    });
    return { label: b.label, count: items.length, rate: pct(items.length, all.length) };
  });
  qvaLeadTimeDistribution.push({
    label: 'QVA 없음',
    count: qvaAbsent.length,
    rate: pct(qvaAbsent.length, all.length),
  });

  // ─── 결론 자동 생성 ───
  const overlapRate = summary.qvaWithin20Rate || 0;
  const conclusion = [];
  if (overlapRate >= 50) {
    conclusion.push('BMS 정제 상승 사례의 상당수가 상승 전에 QVA 흔적을 보였습니다. BMS와 QVA는 함께 쓰면 후보 품질을 높이는 보조 관계일 가능성이 있습니다.');
  } else if (overlapRate >= 20) {
    conclusion.push('QVA는 일부 BMS 상승 사례에서만 먼저 나타났습니다. BMS+QVA 겹침형과 BMS 단독형을 별도로 구분해서 보는 것이 좋아 보입니다.');
  } else {
    conclusion.push('BMS 상승 사례 중 QVA가 먼저 나타난 경우는 많지 않았습니다. BMS는 QVA와 다른 종류의 조용한 준비 구간을 잡는 독립 모델일 가능성이 있습니다.');
  }
  const presentReturn = groupCompare.bmsPlusQva.avgHighReturn || 0;
  const absentReturn = groupCompare.bmsOnly.avgHighReturn || 0;
  if (qvaPresent.length >= 5 && presentReturn > absentReturn) {
    conclusion.push('QVA가 있는 BMS 사례는 평균 고가 상승률 ' + round(presentReturn, 1) + '% 로 QVA가 없는 그룹 ' + round(absentReturn, 1) + '% 보다 강한 모습을 보였습니다.');
  }
  if (qvaAbsent.length >= 10 && absentReturn >= 40) {
    conclusion.push('QVA가 없는 BMS 사례도 평균 고가 상승률 ' + round(absentReturn, 1) + '% 로 충분히 강했습니다. QVA가 없다고 BMS 사례를 제외해서는 안 됩니다. QVA는 필터가 아니라 태그로 쓰는 것이 적절합니다.');
  }
  conclusion.push('이 보고서 결과를 보고, QVA를 BMS 보드의 태그 또는 보조 가산점으로 쓸지 판단합니다. QVA를 처음부터 BMS 필터로 쓰지 않습니다.');

  // ─── 출력 ───
  const out = {
    meta: {
      version: 'bms-qva-overlap-audit-v1',
      generatedAt: new Date().toISOString(),
      title: 'BMS × QVA 겹침 감사 보고서',
      purpose: 'BMS 정제 상승 사례에서 상승 시작일 이전 ~20거래일 동안 QVA(HIGHER_LOW/HOLD) 흔적이 있었는지 감사합니다. QVA를 BMS 필터로 쓰지 않습니다.',
      dataPolicy: 'QVA 신호는 반드시 startDate 이전 데이터만으로 계산. rows.slice(0, idx+1) 로 누수 방지.',
      qvaSubtypes: 'pattern-screener.js 의 calculateQuietVolumeHigherLow / calculateQuietVolumeHold 재사용. 두 신호만 안정 구현.',
      gradesAnalyzed: targetGrades,
    },
    config: CONFIG,
    summary,
    qvaOverlapSummary: {
      qvaWithin20Count: qva20.length,
      qvaWithin10Count: qva10.length,
      qvaWithin5Count: qva5.length,
      qvaOnStartCount: qva0.length,
      qvaHoldCount: qvaHold.length,
      qvaHigherLowCount: qvaHL.length,
      qvaBothCount: qvaBoth.length,
    },
    groupCompare,
    qvaLeadTimeDistribution,
    typeCompare: {
      hold: summarizeGroup(qvaHold),
      higherLow: summarizeGroup(qvaHL),
      both: summarizeGroup(qvaBoth),
    },
    winners,
    cReference: cWinners.slice(0, 100), // 참고용 100개만
    examples: {
      strongOverlap: qvaPresent
        .filter(w => w.qva?.daysFromFirstQvaToStart >= 3)
        .sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
      strongWithoutQva: qvaAbsent
        .sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
    },
    conclusion,
    dataLimit: [
      'QVA 로직: pattern-screener.js의 calculateQuietVolumeHigherLow / calculateQuietVolumeHold 두 함수만 사용. FIRST/ABSORB는 이번 감사에서 제외.',
      'QVA 자체에 시총 500억 하한 필터가 있어 그 이하 종목은 QVA 신호 미발생으로 처리.',
      '차트 60거래일 미만이면 QVA 판정 불가 — 일부 종목은 QVA 흔적 검증 못 한 채 "QVA 없음"으로 분류될 수 있음.',
      '매수금액/매도금액 분리 데이터 없음 — flowRows 는 빈 배열 전달.',
      'cleanWinners A+B를 기본 분석 대상으로 함. C는 ' + (CONFIG.INCLUDE_C ? '메인 그룹에 포함됨' : '참고용 비율만 계산') + '.',
      '이 보고서는 매수 신호가 아니라 BMS와 QVA의 관계를 확인하는 감사 보고서입니다.',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  console.log(`\n📊 핵심 지표:`);
  console.log(`  분석 대상: ${all.length}건 (A=${gradeA.length}, B=${gradeB.length}${CONFIG.INCLUDE_C ? ', C=' + gradeC.length : ''})`);
  console.log(`  QVA 흔적 (20일 안): ${qva20.length}건 (${summary.qvaWithin20Rate}%)`);
  console.log(`  QVA 흔적 (10일 안): ${qva10.length}건 (${summary.qvaWithin10Rate}%)`);
  console.log(`  QVA 흔적 (5일 안):  ${qva5.length}건 (${summary.qvaWithin5Rate}%)`);
  console.log(`  QVA 흔적 (당일):    ${qva0.length}건 (${summary.qvaOnStartRate}%)`);
  console.log(`  QVA-HOLD: ${qvaHold.length}건 / QVA-HIGHER_LOW: ${qvaHL.length}건 / 둘 다: ${qvaBoth.length}건`);
  console.log(`  평균 QVA 선행일: ${summary.avgQvaLeadDays}일`);
  console.log(`  C 참고 그룹 QVA 흔적 비율: ${summary.cReferenceQvaWithin20Rate}% (${cWinners.length}건 중)`);

  console.log(`\n📊 그룹 비교 (평균 고가 상승률):`);
  Object.values(groupCompare).forEach(g => {
    if (!g.count) return;
    console.log(`  ${String(g.label).padEnd(28)} n=${String(g.count).padStart(4)}  +${g.avgHighReturn}% / 종가 +${g.avgCloseReturn}% / 소요 ${g.avgDaysToPeak}일`);
  });

  console.log(`\n📊 QVA 선행일 분포:`);
  qvaLeadTimeDistribution.forEach(b => {
    console.log(`  ${b.label.padEnd(14)} ${String(b.count).padStart(4)}건 (${b.rate}%)`);
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
<title>BMS × QVA 겹침 감사 보고서</title>
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
.big-tile.qva { border-left: 4px solid #14b8a6; }
.big-tile.qva .value { color: #5eead4; }
.big-tile.warn { border-left: 4px solid #f59e0b; }
.big-tile.warn .value { color: #fde047; }
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
.row-highlight td { background: rgba(13, 148, 136, 0.18) !important; }
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
.qva-pill { display: inline-block; padding: 2px 7px; margin-right: 4px; border-radius: 4px; font-size: 10px; font-weight: 700; }
.qva-pill.hl { background: #115e59; color: #99f6e4; }
.qva-pill.hold { background: #5b21b6; color: #ddd6fe; }
.qva-pill.none { background: #475569; color: #cbd5e1; }

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

<h1 id="page-title">BMS × QVA 겹침 감사 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 이 보고서는 BMS 정제 상승 사례에 QVA 흔적이 상승 전에 있었는지 확인하는 감사 보고서입니다.
  <strong>QVA를 BMS 필터로 쓰지 않습니다.</strong> 두 모델의 겹침 여부와 성과 차이만 확인합니다.
</div>

<div class="note-box">
  💡 <strong>"상승 전 QVA 흔적"이란?</strong> BMS 종목이 크게 오르기 전 ~20거래일 동안 누군가가 들어오기 시작한 흔적(QVA 신호: HIGHER_LOW=저점이 올라가며 거래량 붙음 / HOLD=거래대금 이상징후 후 가격 안 무너짐)이 있었는지를 보는 항목입니다.
</div>

<h2>📊 핵심 지표</h2>
<div class="big-summary" id="big-summary"></div>

<h2>📊 그룹 비교 (BMS+QVA vs BMS 단독)</h2>
<p class="subtitle" id="group-compare-note"></p>
<div id="group-compare-table"></div>

<h2>📊 QVA 흔적이 상승 며칠 전에 나왔나?</h2>
<div id="lead-time-table"></div>

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
        <th class="col-mobile-hide">+40% 도달일</th>
        <th class="numeric col-mobile-hide">소요</th>
        <th class="numeric">고가 상승률</th>
        <th class="numeric col-mobile-hide">종가 상승률</th>
        <th>상승 전 QVA</th>
        <th class="col-mobile-hide">QVA 첫 신호일</th>
        <th class="numeric col-mobile-hide">며칠 전</th>
        <th class="numeric col-mobile-hide">들어온 돈</th>
        <th class="numeric col-mobile-hide">박스폭</th>
        <th class="col-summary">한 줄 해석</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<h2>📝 결론</h2>
<div id="conclusion-box" class="purpose-box" style="border-left-color:#10b981;"></div>

<footer class="foot">
  <strong>매수 신호가 아닙니다.</strong> BMS × QVA Overlap Audit는 <em>BMS 정제 상승 사례에 QVA 신호가 상승 전에 있었는지 확인</em>하는 감사 도구입니다.
  QVA는 처음부터 BMS 필터로 쓰지 않습니다. 이 보고서 결과를 보고 QVA를 태그·보조 가산점으로 쓸지 판단합니다.
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

  document.getElementById('subtitle').innerHTML =
    '분석 대상 ' + summary.totalAnalyzed + '건 (A=' + summary.gradeACount + ' B=' + summary.gradeBCount + (summary.cIncludedInGroupCompare ? ' C=' + summary.gradeCCount : '') + ') · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>데이터 누수 방지:</strong> ' + escapeHtml(meta.dataPolicy) +
    '<br><strong>QVA 사용:</strong> ' + escapeHtml(meta.qvaSubtypes);

  document.getElementById('data-limit').innerHTML =
    '데이터 한계:<br>' + (data.dataLimit || []).map(l => '&nbsp;&bull; ' + escapeHtml(l)).join('<br>');

  // 핵심 지표 타일
  const tiles = [
    { label: '분석 대상', value: summary.totalAnalyzed + '건', sub: 'A ' + summary.gradeACount + ' / B ' + summary.gradeBCount + (summary.cIncludedInGroupCompare ? ' / C ' + summary.gradeCCount : ''), cls: 'primary' },
    { label: '⚡ QVA 흔적 (20일 안)', value: summary.qvaWithin20Count + '건', sub: fmtPctRaw(summary.qvaWithin20Rate) + ' 비율', cls: 'qva' },
    { label: 'QVA 흔적 (10일 안)', value: fmtPctRaw(summary.qvaWithin10Rate), sub: '5일 안 ' + fmtPctRaw(summary.qvaWithin5Rate) },
    { label: '상승 시작일 당일', value: fmtPctRaw(summary.qvaOnStartRate), sub: 'QVA 흔적 비율' },
    { label: '평균 QVA 선행일', value: fmtNum(summary.avgQvaLeadDays, 1) + '일', sub: '얼마나 먼저 나왔는지' },
    { label: 'QVA-HOLD 비율', value: fmtPctRaw(summary.qvaHoldRate), sub: '거래대금 이상 후 안 무너짐' },
    { label: 'QVA-HIGHER_LOW 비율', value: fmtPctRaw(summary.qvaHigherLowRate), sub: '저점 상승 + 거래량 유입' },
    { label: 'QVA 둘 다 있음', value: fmtPctRaw(summary.qvaBothRate), sub: 'HOLD + HIGHER_LOW 동시' },
  ];
  if (summary.cReferenceQvaWithin20Rate != null) {
    tiles.push({ label: '참고: C등급 QVA 비율', value: fmtPctRaw(summary.cReferenceQvaWithin20Rate), sub: 'C ' + summary.cReferenceCount + '건 중 (대조군)', cls: 'warn' });
  }
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div><div class="sub">' + t.sub + '</div>';
    ts.appendChild(el);
  });

  // 그룹 비교 표
  document.getElementById('group-compare-note').textContent =
    'BMS+QVA = 상승 전 20거래일 안에 QVA 신호가 있었던 그룹 / BMS 단독 = QVA 신호가 없었던 그룹';
  const gc = data.groupCompare || {};
  const order = ['bmsPlusQva', 'bmsOnly', 'bmsHold', 'bmsHL', 'bmsBoth', 'all'];
  let gcHtml = '<table class="cmp"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>평균 상승률</th><th>보통 상승률</th><th>평균 종가 상승률</th>' +
    '<th>상승 소요</th><th>들어온 돈</th><th>박스폭</th><th>저점대비</th><th>고점대비</th><th>오른뒤 흔들림</th>' +
    '<th>QVA 선행일</th>' +
    '</tr></thead><tbody>';
  order.forEach(k => {
    const g = gc[k] || {};
    if (!g.count) return;
    const cls = (k === 'bmsPlusQva') ? 'row-highlight' : '';
    gcHtml += '<tr class="' + cls + '">' +
      '<td>' + escapeHtml(g.label) + '</td>' +
      '<td>' + g.count + '</td>' +
      '<td class="cell-pos">' + fmtPct(g.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(g.medHighReturn) + '</td>' +
      '<td class="' + clsRet(g.avgCloseReturn) + '">' + fmtPct(g.avgCloseReturn) + '</td>' +
      '<td>' + (g.avgDaysToPeak != null ? fmtNum(g.avgDaysToPeak, 1) + '일' : '-') + '</td>' +
      '<td>' + fmtPctRaw(g.avgPreAccum) + '</td>' +
      '<td>' + fmtPctRaw(g.avgBoxRange) + '</td>' +
      '<td>' + fmtPct(g.avgCloseFromLow60) + '</td>' +
      '<td>' + fmtPct(g.avgCloseFromHigh60) + '</td>' +
      '<td class="cell-neg">' + fmtPct(g.avgPostDrawdown) + '</td>' +
      '<td>' + (g.avgQvaLeadDays != null ? fmtNum(g.avgQvaLeadDays, 1) + '일' : '-') + '</td>' +
    '</tr>';
  });
  gcHtml += '</tbody></table>';
  document.getElementById('group-compare-table').innerHTML = gcHtml;

  // 선행일 분포 표
  const lt = data.qvaLeadTimeDistribution || [];
  let ltHtml = '<table class="cmp"><thead><tr><th>QVA 첫 신호 시점</th><th>사례 수</th><th>비율</th></tr></thead><tbody>';
  lt.forEach(b => {
    ltHtml += '<tr>' +
      '<td>' + escapeHtml(b.label) + '</td>' +
      '<td>' + b.count + '건</td>' +
      '<td>' + fmtPctRaw(b.rate) + '</td>' +
    '</tr>';
  });
  ltHtml += '</tbody></table>';
  document.getElementById('lead-time-table').innerHTML = ltHtml;

  // 결론
  const conclusion = data.conclusion || [];
  document.getElementById('conclusion-box').innerHTML =
    '<strong>📌 자동 결론:</strong><br>' +
    conclusion.map(c => '• ' + escapeHtml(c)).join('<br><br>');

  // 탭
  const qvaWith = winners.filter(w => w.qva && w.qva.hasQvaWithin20Days);
  const qvaWithout = winners.filter(w => !(w.qva && w.qva.hasQvaWithin20Days));
  const qvaHold = winners.filter(w => w.qva && w.qva.hasHoldBefore);
  const qvaHL = winners.filter(w => w.qva && w.qva.hasHigherLowBefore);
  const gradeA = winners.filter(w => w.grade === 'A');
  const gradeB = winners.filter(w => w.grade === 'B');
  const gradeC = winners.filter(w => w.grade === 'C');

  const tabs = [
    { id: 'all', label: '전체 (' + winners.length + ')' },
    { id: 'qva', label: '⚡ QVA 있음 (' + qvaWith.length + ')' },
    { id: 'noqva', label: 'QVA 없음 (' + qvaWithout.length + ')' },
    { id: 'hold', label: 'QVA-HOLD (' + qvaHold.length + ')' },
    { id: 'hl', label: 'QVA-HIGHER_LOW (' + qvaHL.length + ')' },
    { id: 'A', label: 'A등급 (' + gradeA.length + ')' },
    { id: 'B', label: 'B등급 (' + gradeB.length + ')' },
  ];
  if (gradeC.length > 0) tabs.push({ id: 'C', label: 'C등급 참고 (' + gradeC.length + ')' });

  const tabsEl = document.getElementById('tabs');
  let activeTab = 'qva';
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
    if (activeTab === 'qva') return qvaWith;
    if (activeTab === 'noqva') return qvaWithout;
    if (activeTab === 'hold') return qvaHold;
    if (activeTab === 'hl') return qvaHL;
    if (activeTab === 'A') return gradeA;
    if (activeTab === 'B') return gradeB;
    if (activeTab === 'C') return gradeC;
    return winners;
  }

  const tbody = document.getElementById('list-body');

  function qvaTypePills(types) {
    if (!types || types.length === 0) return '<span class="qva-pill none">없음</span>';
    return types.map(t => {
      if (t === 'QVA-HIGHER_LOW') return '<span class="qva-pill hl">HIGHER_LOW</span>';
      if (t === 'QVA-HOLD') return '<span class="qva-pill hold">HOLD</span>';
      return '<span class="qva-pill none">' + escapeHtml(t) + '</span>';
    }).join('');
  }

  function renderList() {
    tbody.innerHTML = '';
    let list = pickList();
    list = [...list].sort((a, b) => b.maxHighReturn - a.maxHighReturn);
    list.forEach((w, i) => {
      const m = w.bmsMetrics || {};
      const q = w.qva || {};
      const tr = document.createElement('tr');
      tr.className = 'row';
      tr.innerHTML =
        '<td>' + (i + 1) + '</td>' +
        '<td class="col-name">' + escapeHtml(w.name) + '<span class="meta">' + w.code + ' · ' + (w.market || '-') + '</span></td>' +
        '<td><span class="grade-pill grade-' + (w.grade || 'C') + '">' + escapeHtml(w.grade || '-') + '</span></td>' +
        '<td class="col-mobile-hide">' + fmtDate(w.startDate) + '</td>' +
        '<td class="col-mobile-hide">' + fmtDate(w.peakDate) + '</td>' +
        '<td class="numeric col-mobile-hide">' + (w.daysToPeak != null ? w.daysToPeak + '일' : '-') + '</td>' +
        '<td class="numeric cell-pos" style="font-weight:700;">' + fmtPct(w.maxHighReturn) + '</td>' +
        '<td class="numeric col-mobile-hide ' + clsRet(w.maxCloseReturn) + '">' + fmtPct(w.maxCloseReturn) + '</td>' +
        '<td>' + qvaTypePills(q.qvaTypesBeforeStart) + '</td>' +
        '<td class="col-mobile-hide">' + fmtDate(q.firstQvaDateBeforeStart) + '</td>' +
        '<td class="numeric col-mobile-hide">' + (q.daysFromFirstQvaToStart != null ? q.daysFromFirstQvaToStart + '거래일' : '-') + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPctRaw(m.preAccumulatedValueRatio) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPctRaw(m.boxRangePct) + '</td>' +
        '<td class="col-summary">' + escapeHtml(w.oneLineSummary || '') + '</td>';
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
    const m = w.bmsMetrics || {};
    const q = w.qva || {};
    const sigs = q.qvaSignals || [];
    let signalsHtml = '';
    if (sigs.length > 0) {
      signalsHtml = '<ul style="margin:4px 0 0 16px;color:#cbd5e1;">' + sigs.map(s => {
        const types = [];
        if (s.hl) types.push('<span class="qva-pill hl">HIGHER_LOW</span>');
        if (s.hold) types.push('<span class="qva-pill hold">HOLD</span>');
        return '<li>' + fmtDate(s.date) + ' (D-' + s.daysBeforeStart + ') ' + types.join(' ') + '</li>';
      }).join('') + '</ul>';
    } else {
      signalsHtml = '<p style="color:#94a3b8;">상승 전 20거래일 안에 QVA 신호 없음</p>';
    }

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
      '<div class="detail-block"><h4>⚡ 상승 전 QVA 흔적</h4>' +
        '<div class="kv">' +
          '<div class="k">QVA 흔적 여부</div><div class="v">' + (q.hasQvaWithin20Days ? '<span class="cell-pos">있음</span>' : '<span class="cell-neg">없음</span>') + '</div>' +
          '<div class="k">시작일 당일</div><div class="v">' + (q.hasQvaOnStartDate ? '예' : '아니오') + '</div>' +
          '<div class="k">5일 안</div><div class="v">' + (q.hasQvaWithin5Days ? '예' : '아니오') + '</div>' +
          '<div class="k">10일 안</div><div class="v">' + (q.hasQvaWithin10Days ? '예' : '아니오') + '</div>' +
          '<div class="k">20일 안</div><div class="v">' + (q.hasQvaWithin20Days ? '예' : '아니오') + '</div>' +
          '<div class="k">QVA 유형</div><div class="v">' + (q.qvaTypesBeforeStart || []).join(', ') + '</div>' +
          '<div class="k">첫 QVA 신호일</div><div class="v">' + fmtDate(q.firstQvaDateBeforeStart) + '</div>' +
          '<div class="k">상승 며칠 전</div><div class="v">' + (q.daysFromFirstQvaToStart != null ? q.daysFromFirstQvaToStart + '거래일' : '-') + '</div>' +
        '</div>' +
        '<div style="margin-top:8px;"><strong style="color:#94a3b8;font-size:11px;">QVA 신호 일자 목록:</strong>' + signalsHtml + '</div>' +
      '</div>' +
      '<div class="detail-block"><h4>📊 BMS 핵심 지표 (상승 전)</h4>' +
        '<div class="kv">' +
          '<div class="k">상승 전 들어온 돈</div><div class="v">' + fmtPctRaw(m.preAccumulatedValueRatio) + '</div>' +
          '<div class="k">거래대금 spike</div><div class="v">' + (m.valueSpikeRatio != null ? fmtNum(m.valueSpikeRatio) + '×' : '-') + '</div>' +
          '<div class="k">박스권 폭 (' + (m.boxRangeDays || '-') + '일)</div><div class="v">' + fmtPctRaw(m.boxRangePct) + '</div>' +
          '<div class="k">60일 저점 대비</div><div class="v">' + fmtPct(m.closeFromLow60) + '</div>' +
          '<div class="k">60일 고점 대비</div><div class="v">' + fmtPct(m.closeFromHigh60) + '</div>' +
          '<div class="k">위쪽 매물 부담</div><div class="v">' + fmtPctRaw(m.supplyAboveRatio) + '</div>' +
          '<div class="k">오른 뒤 흔들림</div><div class="v cell-neg">' + fmtPct(m.postDrawdownPct) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block" style="grid-column: 1 / -1;"><h4>한 줄 해석</h4>' +
        '<p style="color:#fde68a;font-size:13px;line-height:1.6;">' + escapeHtml(w.oneLineSummary || '') + '</p>' +
        '<p style="color:#94a3b8;font-size:11px;margin-top:6px;">⚠️ 주의할 점: QVA는 상승 신호가 아니라 사후 감사용 흔적 확인입니다. 같은 패턴이 미래에도 반복된다는 보장은 없습니다.</p>' +
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
