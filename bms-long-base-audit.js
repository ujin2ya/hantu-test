#!/usr/bin/env node
/**
 * BMS Long-Base Audit
 *
 * 목적:
 *   BMS 정제 상승 사례(reports/bms-winner-quality-filter-result.json의 cleanWinners A+B)에 대해
 *   상승 시작 전 100거래일 동안 장기 횡보 구간이 있었는지 감사한다.
 *
 *   장기 횡보 여부를 BMS 필터로 쓰지 않는다. 사례의 성격을 확인하는 감사 보고서다.
 *
 * 데이터 누수 방지:
 *   장기 박스권은 반드시 startDate 이전 데이터만으로 계산한다. (rows.slice(startIdx-100, startIdx))
 *
 * QVA 겹침:
 *   reports/bms-qva-overlap-audit-result.json 이 있으면 그 결과를 매칭. 없으면 QVA 부분 생략.
 *
 * 입력:
 *   - reports/bms-winner-quality-filter-result.json (cleanWinners)
 *   - reports/bms-qva-overlap-audit-result.json (선택, QVA 겹침용)
 *   - cache/stock-charts-long/{code}.json
 *
 * 출력:
 *   - reports/bms-long-base-audit-result.json
 *   - reports/bms-long-base-audit-result.html
 *
 * 실행:
 *   node bms-long-base-audit.js
 *   node bms-long-base-audit.js --grades=ABC   (C까지 메인 그룹에 포함)
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const INPUT_FILE = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.json');
const QVA_FILE = path.join(REPORTS_DIR, 'bms-qva-overlap-audit-result.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-long-base-audit-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-long-base-audit-result.html');

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
  LONG_BASE_DAYS: 100,
  LONG_BASE_MIN_DAYS: 80,                // 80일 이상은 보조 분석에 포함 (단, 100일 미만이면 데이터 부족 라벨)
  LONG_BASE_RANGE_TIGHT: 25,
  LONG_BASE_RANGE_GOOD: 40,
  LONG_BASE_RANGE_MAX: 60,               // 60% 이하 = 장기 횡보형
  LONG_BASE_RANGE_TOO_WIDE: 80,
  RECENT_DAYS: 20,
  RECENT_VALUE_TO_CAP_MIN: 7,            // 거래대금 재유입 태그 조건
  RECENT_VS_100AVG_MIN: 1.0,
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
function rate(predicate, arr) {
  const valid = arr.filter(x => x != null);
  if (valid.length === 0) return null;
  return pct(valid.filter(predicate).length, valid.length);
}

function findIdxByDate(rows, date) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === date) return i;
    if (rows[i].date < date) break;
  }
  return -1;
}

// ─────────────────────── 장기 횡보 분류 ───────────────────────

function classifyBaseGrade(rangePct, daysAvailable) {
  if (rangePct == null) return '데이터 부족';
  if (daysAvailable < CONFIG.LONG_BASE_MIN_DAYS) return '데이터 부족';
  if (rangePct <= CONFIG.LONG_BASE_RANGE_TIGHT) return '강한 응축';
  if (rangePct <= CONFIG.LONG_BASE_RANGE_GOOD) return '좋은 장기 횡보';
  if (rangePct <= CONFIG.LONG_BASE_RANGE_MAX) return '넓지만 허용';
  if (rangePct <= CONFIG.LONG_BASE_RANGE_TOO_WIDE) return '흔들림 큼';
  return '장기 횡보 아님';
}

function classifyPosition(pos) {
  if (pos == null || !isFinite(pos)) return '판정 불가';
  if (pos > 100) return '100일 고점 돌파 상태';
  if (pos < 0) return '100일 저점 이탈 상태';
  if (pos >= 70) return '장기 박스권 상단';
  if (pos >= 30) return '장기 박스권 중간';
  return '장기 박스권 하단';
}

function classifyValueTrend(ratio) {
  if (ratio == null) return '데이터 부족';
  if (ratio >= 1.3) return '최근 거래 증가';
  if (ratio >= 0.8) return '거래 유지';
  return '거래 감소';
}

// ─────────────────────── 장기 박스권 분석 ───────────────────────

function analyzeLongBase(w, rows) {
  const startIdx = findIdxByDate(rows, w.startDate);
  if (startIdx < 0) {
    return { hasEnoughData: false, daysAvailable: 0, dataLimit: 'startDate 차트에 없음' };
  }

  const daysAvailable = startIdx; // 상승 시작 이전 거래일 수
  // 80일 이상은 분석 포함 (spec: 80~99일은 보조 분석). 100일 충족 여부는 isFullData로 구분.
  const hasEnoughData = daysAvailable >= CONFIG.LONG_BASE_MIN_DAYS;
  const isFullData = daysAvailable >= CONFIG.LONG_BASE_DAYS;
  if (!hasEnoughData) {
    return {
      hasEnoughData: false,
      isFullData: false,
      daysAvailable,
      dataLimit: `상승 전 데이터 부족 (사용 가능 ${daysAvailable}일, 최소 ${CONFIG.LONG_BASE_MIN_DAYS}일 필요)`,
      baseGrade: '데이터 부족',
    };
  }

  const lookbackDays = Math.min(CONFIG.LONG_BASE_DAYS, daysAvailable);
  const baseStart = startIdx - lookbackDays;
  const baseRows = rows.slice(baseStart, startIdx); // [startIdx-lookback .. startIdx-1] (시작일 미포함)

  const lows = baseRows.map(r => r.low).filter(v => v > 0);
  const highs = baseRows.map(r => r.high).filter(v => v > 0);
  if (lows.length === 0 || highs.length === 0) {
    return { hasEnoughData: false, daysAvailable, dataLimit: '가격 데이터 없음', baseGrade: '데이터 부족' };
  }
  const low100 = Math.min(...lows);
  const high100 = Math.max(...highs);
  const rangePct100 = low100 > 0 ? round((high100 - low100) / low100 * 100, 2) : null;

  const startClose = w.startClose;
  const denom = high100 - low100;
  const startPositionInRange = denom > 0 ? round((startClose - low100) / denom * 100, 2) : null;
  const closeFromLow100 = pct(startClose - low100, low100);
  const closeFromHigh100 = pct(startClose - high100, high100);

  // 거래대금 흐름 (앞 50일 vs 뒤 50일)
  const half = Math.floor(baseRows.length / 2);
  const firstHalf = baseRows.slice(0, half);
  const secondHalf = baseRows.slice(half);
  const first50AvgValue = firstHalf.length > 0 ? firstHalf.reduce((s, r) => s + (r.valueApprox || 0), 0) / firstHalf.length : 0;
  const last50AvgValue = secondHalf.length > 0 ? secondHalf.reduce((s, r) => s + (r.valueApprox || 0), 0) / secondHalf.length : 0;
  const valueTrendRatio = first50AvgValue > 0 ? round(last50AvgValue / first50AvgValue, 2) : null;
  const valueTrendLabel = classifyValueTrend(valueTrendRatio);

  // 최근 20일 거래대금
  const recent20 = baseRows.slice(-CONFIG.RECENT_DAYS);
  const recent20Sum = recent20.reduce((s, r) => s + (r.valueApprox || 0), 0);
  const recent20ValueToCap = (w.marketCap || 0) > 0 ? round(recent20Sum / w.marketCap * 100, 2) : null;
  const recent20Avg = recent20.length > 0 ? recent20Sum / recent20.length : 0;
  const overall100Avg = baseRows.reduce((s, r) => s + (r.valueApprox || 0), 0) / baseRows.length;
  const recent20Vs100Avg = overall100Avg > 0 ? round(recent20Avg / overall100Avg, 2) : null;

  // 장기 횡보 후 거래대금 재유입 태그
  const hasValueReentry = (
    rangePct100 != null && rangePct100 <= CONFIG.LONG_BASE_RANGE_MAX
    && recent20ValueToCap != null && recent20ValueToCap >= CONFIG.RECENT_VALUE_TO_CAP_MIN
    && recent20Vs100Avg != null && recent20Vs100Avg >= CONFIG.RECENT_VS_100AVG_MIN
  );

  return {
    hasEnoughData,
    isFullData,
    daysAvailable,
    lookbackDays,
    high100: round(high100, 0),
    low100: round(low100, 0),
    rangePct100,
    startPositionInRange,
    closeFromLow100,
    closeFromHigh100,
    baseGrade: classifyBaseGrade(rangePct100, daysAvailable),
    basePositionLabel: classifyPosition(startPositionInRange),
    first50AvgValue: round(first50AvgValue, 0),
    last50AvgValue: round(last50AvgValue, 0),
    valueTrendRatio,
    valueTrendLabel,
    recent20ValueToCap,
    recent20Vs100Avg,
    hasValueReentry,
  };
}

// ─────────────────────── BMS 핵심 지표 (기존과 일관) ───────────────────────

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

// ─────────────────────── 한 줄 해석 ───────────────────────

function buildOneLine(w) {
  const lb = w.longBase || {};
  const m = w.bmsMetrics || {};
  if (!lb.hasEnoughData) {
    return '100일 데이터가 부족해 장기 횡보 여부를 판정할 수 없습니다.';
  }
  if (lb.baseGrade === '강한 응축') {
    return `상승 전 100일 동안 ${lb.rangePct100}% 범위로 강하게 응축된 사례입니다.`;
  }
  if (lb.baseGrade === '좋은 장기 횡보') {
    if (lb.hasValueReentry) {
      return `상승 전 100일 동안 ${lb.rangePct100}% 범위에서 움직였고, 최근 거래대금이 다시 들어온 좋은 장기 횡보 사례입니다.`;
    }
    return `상승 전 100일 동안 ${lb.rangePct100}% 범위에서 움직인 좋은 장기 횡보 사례입니다.`;
  }
  if (lb.baseGrade === '넓지만 허용') {
    if (lb.hasValueReentry) {
      return `강한 응축은 아니지만 100일 ${lb.rangePct100}% 범위에서 움직이다가 거래대금이 다시 들어온 사례입니다.`;
    }
    return `100일 박스권 폭이 ${lb.rangePct100}%로 넓지만 허용 범위 안에서 움직였습니다.`;
  }
  if (lb.baseGrade === '흔들림 큼') {
    return `100일 박스권 폭이 ${lb.rangePct100}%로 흔들림이 큰 구간이었습니다.`;
  }
  if (lb.baseGrade === '장기 횡보 아님') {
    return `100일 박스권 폭이 ${lb.rangePct100}%로 넓어 장기 횡보로 보기는 어렵습니다.`;
  }
  return '장기 횡보 판정 결과 — 위 표 참고.';
}

// ─────────────────────── 그룹 통계 ───────────────────────

function summarizeGroup(items, total) {
  if (!items || items.length === 0) return { count: 0, share: 0 };
  const high = items.map(w => w.maxHighReturn);
  const close = items.map(w => w.maxCloseReturn);
  const days = items.map(w => w.daysToPeak);
  const accum = items.map(w => w.bmsMetrics?.preAccumulatedValueRatio);
  const recentValueToCap = items.map(w => w.longBase?.recent20ValueToCap);
  const recentVs100 = items.map(w => w.longBase?.recent20Vs100Avg);
  const valueTrend = items.map(w => w.longBase?.valueTrendRatio);
  const qvaCount = items.filter(w => w.qvaOverlap?.qvaWithin20Days).length;
  const aCount = items.filter(w => w.grade === 'A').length;
  const bCount = items.filter(w => w.grade === 'B').length;
  return {
    count: items.length,
    share: total > 0 ? pct(items.length, total) : null,
    avgHighReturn: avg(high), medHighReturn: median(high),
    avgCloseReturn: avg(close), medCloseReturn: median(close),
    avgDaysToPeak: avg(days), medDaysToPeak: median(days),
    avgPreAccum: avg(accum),
    avgRecent20ValueToCap: avg(recentValueToCap),
    avgRecent20Vs100Avg: avg(recentVs100),
    avgValueTrendRatio: avg(valueTrend),
    qvaOverlapCount: qvaCount,
    qvaOverlapRate: pct(qvaCount, items.length),
    gradeARate: pct(aCount, items.length),
    gradeBRate: pct(bCount, items.length),
  };
}

// ─────────────────────── 메인 ───────────────────────

function loadQvaOverlapMap() {
  if (!fs.existsSync(QVA_FILE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(QVA_FILE, 'utf-8'));
    const map = new Map();
    (j.winners || []).forEach(w => {
      const q = w.qva || {};
      map.set(w.code + '|' + w.startDate, {
        qvaWithin20Days: !!q.hasQvaWithin20Days,
        qvaWithin10Days: !!q.hasQvaWithin10Days,
        qvaWithin5Days: !!q.hasQvaWithin5Days,
        qvaOnStartDate: !!q.hasQvaOnStartDate,
        qvaTypesBeforeStart: q.qvaTypesBeforeStart || [],
        daysFromFirstQvaToStart: q.daysFromFirstQvaToStart ?? null,
        daysFromNearestQvaToStart: q.daysFromNearestQvaToStart ?? null,
      });
    });
    return map;
  } catch (_) { return null; }
}

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Long-Base Audit');
  console.log('═'.repeat(80));

  if (!fs.existsSync(INPUT_FILE)) {
    console.error('입력 파일 없음:', INPUT_FILE);
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8'));
  const cleanWinners = input.cleanWinners || [];
  console.log(`입력: cleanWinners ${cleanWinners.length}건 (A=${input.gradeSummary?.A?.count} B=${input.gradeSummary?.B?.count} C=${input.gradeSummary?.C?.count})`);

  const qvaMap = loadQvaOverlapMap();
  console.log(qvaMap ? `QVA 감사 결과 로드: ${qvaMap.size}건` : 'QVA 감사 결과 파일 없음 — QVA 겹침 분석 제외');

  const targetGrades = CONFIG.INCLUDE_C ? [...CONFIG.GRADES_PRIMARY, ...CONFIG.GRADES_REFERENCE] : [...CONFIG.GRADES_PRIMARY];
  const targets = cleanWinners.filter(w => targetGrades.includes(w._grade));
  const cReferenceSrc = cleanWinners.filter(w => w._grade === 'C');
  console.log(`대상 등급: ${targetGrades.join('+')} → ${targets.length}건 (C 참고: ${cReferenceSrc.length}건)`);

  const startTime = Date.now();
  const winners = [];
  let chartMissing = 0, dataInsufficient = 0;

  // A+B 분석
  targets.forEach((w, i) => {
    if ((i + 1) % 100 === 0) console.log(`  진행: ${i + 1}/${targets.length}`);
    const chartFile = path.join(CHART_DIR, w.code + '.json');
    if (!fs.existsSync(chartFile)) { chartMissing++; return; }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartFile, 'utf-8')); } catch (_) { chartMissing++; return; }
    const rows = chart.rows || [];
    if (rows.length < 60) { chartMissing++; return; }

    const longBase = analyzeLongBase(w, rows);
    if (!longBase.hasEnoughData) dataInsufficient++;
    const bmsMetrics = extractBmsMetrics(w);
    const qvaOverlap = qvaMap ? (qvaMap.get(w.code + '|' + w.startDate) || null) : null;
    const out = {
      code: w.code, name: w.name, market: w.market, marketCap: w.marketCap,
      grade: w._grade,
      startDate: w.startDate, peakDate: w.peakDate,
      startClose: w.startClose, peakHigh: w.peakHigh, peakClose: w.peakClose,
      daysToPeak: w.daysToPeak,
      maxHighReturn: w.maxHighReturn,
      maxCloseReturn: w.maxCloseReturn,
      bmsMetrics,
      longBase,
      qvaOverlap,
    };
    out.oneLineSummary = buildOneLine(out);
    winners.push(out);
  });

  // C 참고 — 가벼운 집계만 (메인 그룹에 포함 안 할 때)
  const cReference = [];
  if (!CONFIG.INCLUDE_C) {
    cReferenceSrc.forEach((w, i) => {
      if ((i + 1) % 200 === 0) console.log(`  C 참고 진행: ${i + 1}/${cReferenceSrc.length}`);
      const chartFile = path.join(CHART_DIR, w.code + '.json');
      if (!fs.existsSync(chartFile)) return;
      let chart;
      try { chart = JSON.parse(fs.readFileSync(chartFile, 'utf-8')); } catch (_) { return; }
      const rows = chart.rows || [];
      if (rows.length < 60) return;
      const longBase = analyzeLongBase(w, rows);
      const qvaOverlap = qvaMap ? (qvaMap.get(w.code + '|' + w.startDate) || null) : null;
      cReference.push({
        code: w.code, name: w.name, grade: 'C',
        startDate: w.startDate,
        maxHighReturn: w.maxHighReturn, maxCloseReturn: w.maxCloseReturn,
        daysToPeak: w.daysToPeak,
        bmsMetrics: extractBmsMetrics(w),
        longBase, qvaOverlap,
      });
    });
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n분석 완료: ${winners.length}건 (${elapsed.toFixed(1)}초)`);
  const fullDataCount = winners.filter(w => w.longBase?.isFullData).length;
  const auxDataCount = winners.filter(w => w.longBase?.hasEnoughData && !w.longBase.isFullData).length;
  if (chartMissing > 0 || dataInsufficient > 0) {
    console.log(`  데이터 한계: 차트없음 ${chartMissing} / 80일 미만 ${dataInsufficient} (분석 제외) / 100일 충족 ${fullDataCount} / 보조분석 80~99일 ${auxDataCount}`);
  }

  // 분류
  const enough = winners.filter(w => w.longBase?.hasEnoughData);
  const tight = enough.filter(w => w.longBase.rangePct100 <= CONFIG.LONG_BASE_RANGE_TIGHT);
  const good = enough.filter(w => w.longBase.rangePct100 > CONFIG.LONG_BASE_RANGE_TIGHT && w.longBase.rangePct100 <= CONFIG.LONG_BASE_RANGE_GOOD);
  const wide = enough.filter(w => w.longBase.rangePct100 > CONFIG.LONG_BASE_RANGE_GOOD && w.longBase.rangePct100 <= CONFIG.LONG_BASE_RANGE_MAX);
  const longBase = enough.filter(w => w.longBase.rangePct100 <= CONFIG.LONG_BASE_RANGE_MAX); // 강한 응축 + 좋은 횡보 + 넓지만 허용
  const wobble = enough.filter(w => w.longBase.rangePct100 > CONFIG.LONG_BASE_RANGE_MAX && w.longBase.rangePct100 <= CONFIG.LONG_BASE_RANGE_TOO_WIDE);
  const notLongBase = enough.filter(w => w.longBase.rangePct100 > CONFIG.LONG_BASE_RANGE_TOO_WIDE);
  const insufficient = winners.filter(w => !w.longBase?.hasEnoughData);
  const reentry = enough.filter(w => w.longBase.hasValueReentry);

  // 분포
  const longBaseDistribution = [
    { label: '강한 응축', count: tight.length, rate: pct(tight.length, winners.length) },
    { label: '좋은 장기 횡보', count: good.length, rate: pct(good.length, winners.length) },
    { label: '넓지만 허용', count: wide.length, rate: pct(wide.length, winners.length) },
    { label: '흔들림 큼', count: wobble.length, rate: pct(wobble.length, winners.length) },
    { label: '장기 횡보 아님', count: notLongBase.length, rate: pct(notLongBase.length, winners.length) },
    { label: '데이터 부족', count: insufficient.length, rate: pct(insufficient.length, winners.length) },
  ];

  // 위치 분포
  const positionDistribution = ['장기 박스권 하단', '장기 박스권 중간', '장기 박스권 상단', '100일 고점 돌파 상태', '100일 저점 이탈 상태', '판정 불가'].map(label => {
    const items = winners.filter(w => w.longBase?.basePositionLabel === label);
    return { label, count: items.length, rate: pct(items.length, winners.length) };
  });

  // 거래대금 추세 분포
  const valueTrendDistribution = ['최근 거래 증가', '거래 유지', '거래 감소', '데이터 부족'].map(label => {
    const items = winners.filter(w => w.longBase?.valueTrendLabel === label);
    return { label, count: items.length, rate: pct(items.length, winners.length) };
  });

  // 그룹 비교
  const groupCompare = {
    longBase: { label: '장기 횡보형 (≤60% 범위)', ...summarizeGroup(longBase, winners.length) },
    tight: { label: '강한 응축 (≤25%)', ...summarizeGroup(tight, winners.length) },
    good: { label: '좋은 장기 횡보 (25~40%)', ...summarizeGroup(good, winners.length) },
    wide: { label: '넓지만 허용 (40~60%)', ...summarizeGroup(wide, winners.length) },
    notLongBase: { label: '장기 횡보 아님 (>60%)', ...summarizeGroup([...wobble, ...notLongBase], winners.length) },
    reentry: { label: '거래대금 재유입형', ...summarizeGroup(reentry, winners.length) },
    all: { label: '전체', ...summarizeGroup(winners, winners.length) },
  };

  // QVA × 장기 횡보 교차 (QVA 데이터 있을 때만)
  // 분모는 모두 enough(데이터 충분) 그룹 안에서만 비교 — 데이터 부족 케이스 제외
  let qvaOverlapByLongBase = null;
  if (qvaMap) {
    const notLongBaseEnough = enough.filter(w => w.longBase.rangePct100 > CONFIG.LONG_BASE_RANGE_MAX);
    const qvaInLongBase = longBase.filter(w => w.qvaOverlap?.qvaWithin20Days).length;
    const qvaInTight = tight.filter(w => w.qvaOverlap?.qvaWithin20Days).length;
    const qvaInNotLong = notLongBaseEnough.filter(w => w.qvaOverlap?.qvaWithin20Days).length;
    qvaOverlapByLongBase = {
      longBaseTotal: longBase.length,
      longBaseWithQva: qvaInLongBase,
      longBaseQvaRate: pct(qvaInLongBase, longBase.length),
      tightTotal: tight.length,
      tightWithQva: qvaInTight,
      tightQvaRate: pct(qvaInTight, tight.length),
      notLongBaseTotal: notLongBaseEnough.length,
      notLongBaseWithQva: qvaInNotLong,
      notLongBaseQvaRate: pct(qvaInNotLong, notLongBaseEnough.length),
    };
  }

  // C 참고 비율
  let cReferenceSummary = null;
  if (cReference.length > 0) {
    const cEnough = cReference.filter(w => w.longBase?.hasEnoughData);
    const cLongBase = cEnough.filter(w => w.longBase.rangePct100 <= CONFIG.LONG_BASE_RANGE_MAX);
    cReferenceSummary = {
      total: cReference.length,
      cWithEnoughData: cEnough.length,
      cLongBaseCount: cLongBase.length,
      cLongBaseRate: pct(cLongBase.length, cReference.length),
    };
  }

  // 요약
  const summary = {
    totalAnalyzed: winners.length,
    gradeACount: winners.filter(w => w.grade === 'A').length,
    gradeBCount: winners.filter(w => w.grade === 'B').length,
    gradeCCount: CONFIG.INCLUDE_C ? winners.filter(w => w.grade === 'C').length : cReference.length,
    cIncludedInGroupCompare: CONFIG.INCLUDE_C,
    enoughDataCount: enough.length,
    fullDataCount: enough.filter(w => w.longBase.isFullData).length,
    auxDataCount: enough.filter(w => !w.longBase.isFullData).length,
    insufficientCount: insufficient.length,
    longBaseCount: longBase.length,
    longBaseRate: pct(longBase.length, winners.length),
    tightCount: tight.length,
    goodCount: good.length,
    reentryCount: reentry.length,
    longBaseAvgReturn: avg(longBase.map(w => w.maxHighReturn)),
    notLongBaseAvgReturn: avg([...wobble, ...notLongBase].map(w => w.maxHighReturn)),
    reentryAvgReturn: avg(reentry.map(w => w.maxHighReturn)),
    longBaseQvaOverlapRate: qvaOverlapByLongBase?.longBaseQvaRate ?? null,
  };

  // 결론 자동 생성
  const conclusion = [];
  const lbRate = summary.longBaseRate || 0;
  if (lbRate >= 50) {
    conclusion.push('BMS 정제 상승 사례의 상당수는 크게 오르기 전 100일 안에서 제한된 범위로 움직인 장기 횡보형이었습니다. BMS에서 장기 준비 구간은 중요한 축일 가능성이 있습니다.');
  } else if (lbRate >= 25) {
    conclusion.push('BMS 정제 상승 사례 중 일부는 장기 횡보형이지만, 전부는 아닙니다. BMS는 장기 횡보형과 비횡보형을 나누어 보는 것이 좋아 보입니다.');
  } else {
    conclusion.push('BMS 정제 상승 사례에서 100일 장기 횡보형은 많지 않았습니다. BMS는 100일 장기 횡보보다 상승 전 20일 준비 구간이 더 중요할 수 있습니다.');
  }
  if (longBase.length >= 5 && summary.longBaseAvgReturn != null && summary.notLongBaseAvgReturn != null) {
    if (summary.longBaseAvgReturn > summary.notLongBaseAvgReturn) {
      conclusion.push(`장기 횡보형은 평균 고가 상승률 ${summary.longBaseAvgReturn}% 로 비횡보형 ${summary.notLongBaseAvgReturn}% 보다 더 좋은 모습을 보였습니다.`);
    } else {
      conclusion.push(`장기 횡보 여부만으로 상승률 우위를 만들지는 않았습니다 (장기 횡보형 ${summary.longBaseAvgReturn}% vs 비횡보형 ${summary.notLongBaseAvgReturn}%). 장기 횡보는 필터가 아니라 유형 태그로 보는 것이 적절합니다.`);
    }
  }
  if (reentry.length >= 5 && summary.reentryAvgReturn != null && summary.notLongBaseAvgReturn != null && summary.reentryAvgReturn > summary.notLongBaseAvgReturn) {
    conclusion.push(`오래 쉬다가 최근 거래대금이 다시 들어온 사례가 평균 ${summary.reentryAvgReturn}% 로 비횡보형 ${summary.notLongBaseAvgReturn}% 보다 강한 상승을 보였습니다. 장기 횡보 자체보다 최근 거래대금 재유입이 더 중요한 신호일 수 있습니다.`);
  }
  if (qvaOverlapByLongBase) {
    if ((qvaOverlapByLongBase.longBaseQvaRate || 0) > (qvaOverlapByLongBase.notLongBaseQvaRate || 0)) {
      conclusion.push(`장기 횡보형 그룹의 QVA 겹침 비율 ${qvaOverlapByLongBase.longBaseQvaRate}% 가 비횡보형 ${qvaOverlapByLongBase.notLongBaseQvaRate}% 보다 높아 두 신호가 일부 함께 나타나는 경향이 있습니다.`);
    }
  }
  conclusion.push('장기 횡보 여부도 QVA처럼 처음부터 BMS 필터로 쓰지 않습니다. 먼저 태그로 보고, 실제 성과 차이가 있는지 확인합니다.');

  // 예시
  const examples = {
    strongTight: [...tight].sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
    strongReentry: [...reentry].sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
    notLongBaseStrong: [...notLongBase].sort((a, b) => b.maxHighReturn - a.maxHighReturn).slice(0, 10),
  };

  // 출력
  const out = {
    meta: {
      version: 'bms-long-base-audit-v1',
      generatedAt: new Date().toISOString(),
      title: 'BMS 장기 횡보 여부 감사 보고서',
      purpose: 'BMS 정제 상승 사례들이 크게 오르기 전 100거래일 동안 장기 횡보 구간이 있었는지 확인하는 감사 보고서. 현재 종목 후보를 찾는 보드가 아닙니다.',
      dataPolicy: '장기 박스권은 startDate 이전 100거래일만으로 계산. rows.slice(startIdx-100, startIdx) 로 누수 방지.',
      qvaSource: qvaMap ? `bms-qva-overlap-audit-result.json (${qvaMap.size}건 매칭)` : 'QVA 감사 결과 파일 없음 — QVA 겹침 분석 제외',
      gradesAnalyzed: targetGrades,
    },
    config: CONFIG,
    summary,
    longBaseDistribution,
    positionDistribution,
    valueTrendDistribution,
    groupCompare,
    qvaOverlapByLongBase,
    valueReentrySummary: {
      count: reentry.length,
      rate: pct(reentry.length, winners.length),
      avgReturn: avg(reentry.map(w => w.maxHighReturn)),
      medReturn: median(reentry.map(w => w.maxHighReturn)),
      avgRecent20ToCap: avg(reentry.map(w => w.longBase.recent20ValueToCap)),
    },
    cReferenceSummary,
    winners,
    cReference: cReference.slice(0, 100),
    examples,
    conclusion,
    dataLimit: [
      `차트 캐시 길이 한계로 ${insufficient.length}건은 상승 전 80거래일 데이터조차 부족 — 장기 횡보 판정 제외.`,
      `100거래일을 모두 충족한 사례는 ${enough.filter(w => w.longBase.isFullData).length}건, 80~99일만 가능한 보조 분석 사례는 ${enough.filter(w => !w.longBase.isFullData).length}건. 보조 분석 사례도 분석에는 포함했으나 박스권 폭은 80~99일 데이터로 측정됨.`,
      '장기 횡보 여부는 현재 정의한 가격 범위 기준이며, 차트 모양을 완벽히 해석하는 것은 아님.',
      qvaMap ? 'QVA 겹침은 bms-qva-overlap-audit-result.json 결과를 매칭 (HIGHER_LOW/HOLD 두 신호만).' : 'QVA 감사 결과 파일이 없어 QVA 겹침 분석 제외됨.',
      '이 보고서는 매수 신호가 아니라 BMS 정제 상승 사례의 성격을 확인하는 감사 보고서임.',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // 콘솔 출력
  console.log(`\n📊 핵심 지표:`);
  console.log(`  분석 대상: ${winners.length}건 (A=${summary.gradeACount}, B=${summary.gradeBCount}${CONFIG.INCLUDE_C ? ', C=' + summary.gradeCCount : ''})`);
  console.log(`  100일 데이터 충분: ${enough.length}건 / 부족: ${insufficient.length}건`);
  console.log(`  장기 횡보형 (≤60%): ${longBase.length}건 (${summary.longBaseRate}%)`);
  console.log(`    - 강한 응축 (≤25%):     ${tight.length}건`);
  console.log(`    - 좋은 장기 횡보 (~40): ${good.length}건`);
  console.log(`    - 넓지만 허용 (~60%):   ${wide.length}건`);
  console.log(`  장기 횡보 아님 (>60%): ${wobble.length + notLongBase.length}건`);
  console.log(`  거래대금 재유입형: ${reentry.length}건`);
  console.log(`  장기 횡보형 평균 상승률: +${summary.longBaseAvgReturn}% / 비횡보형: +${summary.notLongBaseAvgReturn}%`);
  if (qvaOverlapByLongBase) {
    console.log(`  장기 횡보형 QVA 겹침: ${qvaOverlapByLongBase.longBaseQvaRate}% / 비횡보형 QVA 겹침: ${qvaOverlapByLongBase.notLongBaseQvaRate}%`);
  }

  console.log(`\n📊 장기 횡보 등급 분포:`);
  longBaseDistribution.forEach(d => console.log(`  ${d.label.padEnd(14)} ${String(d.count).padStart(4)}건 (${d.rate}%)`));

  console.log(`\n📊 그룹 비교:`);
  Object.values(groupCompare).forEach(g => {
    if (!g.count) return;
    console.log(`  ${String(g.label).padEnd(28)} n=${String(g.count).padStart(4)} +${g.avgHighReturn}% / 종가 +${g.avgCloseReturn}% / QVA ${g.qvaOverlapRate}%`);
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
<title>BMS 장기 횡보 여부 감사 보고서</title>
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
.big-tile.tight { border-left: 4px solid #10b981; }
.big-tile.tight .value { color: #6ee7b7; }
.big-tile.warn { border-left: 4px solid #f59e0b; }
.big-tile.warn .value { color: #fde047; }
.big-tile.qva { border-left: 4px solid #14b8a6; }
.big-tile.qva .value { color: #5eead4; }
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
.base-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.base-tight { background: #064e3b; color: #6ee7b7; }
.base-good { background: #14532d; color: #a7f3d0; }
.base-wide { background: #1e40af; color: #dbeafe; }
.base-wobble { background: #92400e; color: #fde047; }
.base-not { background: #7f1d1d; color: #fca5a5; }
.base-na { background: #475569; color: #cbd5e1; }
.qva-pill { display: inline-block; padding: 2px 7px; margin-right: 4px; border-radius: 4px; font-size: 10px; font-weight: 700; }
.qva-pill.hl { background: #115e59; color: #99f6e4; }
.qva-pill.hold { background: #5b21b6; color: #ddd6fe; }
.qva-pill.none { background: #475569; color: #cbd5e1; }
.reentry-pill { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; background: #4338ca; color: #c7d2fe; }

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

<h1 id="page-title">BMS 장기 횡보 여부 감사 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 이 보고서는 BMS 정제 상승 사례들이 크게 오르기 전 100거래일 이상 오래 횡보하거나 힘을 모은 구간이 있었는지 확인하는 감사 보고서입니다.
  <strong>현재 종목 후보를 찾는 보드가 아닙니다.</strong> 과거 상승 사례의 공통 성격을 확인하기 위한 분석입니다.
</div>

<div class="note-box">
  💡 <strong>"장기 횡보형"이란?</strong> 크게 오르기 전 약 100거래일 동안 비교적 제한된 가격 범위 안에서 움직인 사례를 뜻합니다. 박스권 폭이 좁을수록 응축이 강한 사례입니다.
</div>

<h2>📊 핵심 지표</h2>
<div class="big-summary" id="big-summary"></div>

<h2>📊 장기 횡보 등급 분포</h2>
<div id="distribution-table"></div>

<h2>📊 장기 박스권 위치 분포 (상승 시작점 기준)</h2>
<div id="position-table"></div>

<h2>📊 상승 전 거래대금 흐름 분포</h2>
<div id="value-trend-table"></div>

<h2>📊 그룹 비교 (장기 횡보형 vs 비횡보형)</h2>
<div id="group-compare-table"></div>

<h2 id="qva-section-title" style="display:none;">📊 QVA × 장기 횡보 겹침 (참고)</h2>
<div id="qva-overlap-section" style="display:none;"></div>

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
        <th>장기 횡보 등급</th>
        <th class="numeric">100일 박스폭</th>
        <th class="col-mobile-hide">박스 위치</th>
        <th class="numeric col-mobile-hide">저점대비</th>
        <th class="numeric col-mobile-hide">고점대비</th>
        <th class="numeric col-mobile-hide">최근20일 들어온돈</th>
        <th class="col-mobile-hide">최근 거래</th>
        <th>QVA</th>
        <th class="col-summary">한 줄 해석</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<h2>📝 결론</h2>
<div id="conclusion-box" class="purpose-box" style="border-left-color:#10b981;"></div>

<footer class="foot">
  <strong>매수 신호가 아닙니다.</strong> BMS Long-Base Audit는 <em>BMS 정제 상승 사례에 장기 횡보 구간이 있었는지 확인</em>하는 감사 도구입니다.
  장기 횡보 여부는 처음부터 BMS 필터로 쓰지 않습니다. 이 보고서 결과를 보고 태그·보조 가산점으로 쓸지 판단합니다.
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

  function baseClass(g) {
    if (g === '강한 응축') return 'base-tight';
    if (g === '좋은 장기 횡보') return 'base-good';
    if (g === '넓지만 허용') return 'base-wide';
    if (g === '흔들림 큼') return 'base-wobble';
    if (g === '장기 횡보 아님') return 'base-not';
    return 'base-na';
  }

  document.getElementById('subtitle').innerHTML =
    '분석 대상 ' + summary.totalAnalyzed + '건 (A=' + summary.gradeACount + ' B=' + summary.gradeBCount + (summary.cIncludedInGroupCompare ? ' C=' + summary.gradeCCount : '') + ') · 분석 가능 ' + summary.enoughDataCount + '건 (100일 충족 ' + summary.fullDataCount + ' + 보조 80~99일 ' + summary.auxDataCount + ') / 데이터 부족 ' + summary.insufficientCount + '건 · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>데이터 누수 방지:</strong> ' + escapeHtml(meta.dataPolicy) +
    '<br><strong>QVA 데이터:</strong> ' + escapeHtml(meta.qvaSource);

  document.getElementById('data-limit').innerHTML =
    '데이터 한계:<br>' + (data.dataLimit || []).map(l => '&nbsp;&bull; ' + escapeHtml(l)).join('<br>');

  // 핵심 타일
  const tiles = [
    { label: '분석 대상', value: summary.totalAnalyzed + '건', sub: 'A ' + summary.gradeACount + ' / B ' + summary.gradeBCount + (summary.cIncludedInGroupCompare ? ' / C ' + summary.gradeCCount : ''), cls: 'primary' },
    { label: '분석 가능 사례', value: summary.enoughDataCount + '건', sub: '100일 충족 ' + summary.fullDataCount + ' + 보조 ' + summary.auxDataCount + ' / 부족 ' + summary.insufficientCount },
    { label: '장기 횡보형 (≤60%)', value: summary.longBaseCount + '건', sub: fmtPctRaw(summary.longBaseRate) + ' 비율', cls: 'tight' },
    { label: '강한 응축 (≤25%)', value: summary.tightCount + '건', sub: '응축 사례', cls: 'tight' },
    { label: '좋은 장기 횡보', value: summary.goodCount + '건', sub: '25~40% 박스권' },
    { label: '거래대금 재유입형', value: summary.reentryCount + '건', sub: '오래 쉬다가 거래 회복', cls: 'qva' },
    { label: '장기 횡보형 평균 상승률', value: fmtPct(summary.longBaseAvgReturn), sub: '비횡보형 ' + fmtPct(summary.notLongBaseAvgReturn) },
    { label: '장기 횡보형 QVA 겹침', value: summary.longBaseQvaOverlapRate != null ? fmtPctRaw(summary.longBaseQvaOverlapRate) : '-', sub: 'QVA 데이터 있을 때만', cls: 'qva' },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div><div class="sub">' + t.sub + '</div>';
    ts.appendChild(el);
  });

  // 분포 표
  function renderDistTable(targetId, dist, title) {
    let html = '<table class="cmp"><thead><tr><th>' + title + '</th><th>사례 수</th><th>비율</th></tr></thead><tbody>';
    dist.forEach(d => {
      html += '<tr><td>' + escapeHtml(d.label) + '</td><td>' + d.count + '건</td><td>' + fmtPctRaw(d.rate) + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById(targetId).innerHTML = html;
  }
  renderDistTable('distribution-table', data.longBaseDistribution || [], '장기 횡보 등급');
  renderDistTable('position-table', data.positionDistribution || [], '박스권 위치');
  renderDistTable('value-trend-table', data.valueTrendDistribution || [], '거래대금 흐름');

  // 그룹 비교
  const gc = data.groupCompare || {};
  const order = ['longBase', 'tight', 'good', 'wide', 'notLongBase', 'reentry', 'all'];
  let gcHtml = '<table class="cmp"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>비율</th><th>평균 상승률</th><th>보통 상승률</th><th>평균 종가</th>' +
    '<th>상승 소요</th><th>상승 전 들어온돈</th><th>최근20/100평균</th><th>QVA 흔적</th><th>A 비율</th><th>B 비율</th>' +
    '</tr></thead><tbody>';
  order.forEach(k => {
    const g = gc[k] || {};
    if (!g.count) return;
    const cls = (k === 'longBase' || k === 'tight') ? 'row-highlight' : '';
    gcHtml += '<tr class="' + cls + '">' +
      '<td>' + escapeHtml(g.label) + '</td>' +
      '<td>' + g.count + '</td>' +
      '<td>' + fmtPctRaw(g.share) + '</td>' +
      '<td class="cell-pos">' + fmtPct(g.avgHighReturn) + '</td>' +
      '<td>' + fmtPct(g.medHighReturn) + '</td>' +
      '<td class="' + clsRet(g.avgCloseReturn) + '">' + fmtPct(g.avgCloseReturn) + '</td>' +
      '<td>' + (g.avgDaysToPeak != null ? fmtNum(g.avgDaysToPeak, 1) + '일' : '-') + '</td>' +
      '<td>' + fmtPctRaw(g.avgPreAccum) + '</td>' +
      '<td>' + (g.avgRecent20Vs100Avg != null ? fmtNum(g.avgRecent20Vs100Avg) + '×' : '-') + '</td>' +
      '<td>' + (g.qvaOverlapRate != null ? fmtPctRaw(g.qvaOverlapRate) : '-') + '</td>' +
      '<td>' + fmtPctRaw(g.gradeARate) + '</td>' +
      '<td>' + fmtPctRaw(g.gradeBRate) + '</td>' +
    '</tr>';
  });
  gcHtml += '</tbody></table>';
  document.getElementById('group-compare-table').innerHTML = gcHtml;

  // QVA × 장기 횡보 겹침
  const qol = data.qvaOverlapByLongBase;
  if (qol) {
    document.getElementById('qva-section-title').style.display = '';
    const sec = document.getElementById('qva-overlap-section');
    sec.style.display = '';
    sec.innerHTML =
      '<table class="cmp"><thead><tr><th>그룹</th><th>n</th><th>QVA 흔적 있음</th><th>QVA 겹침 비율</th></tr></thead><tbody>' +
      '<tr><td>장기 횡보형 (≤60%)</td><td>' + qol.longBaseTotal + '</td><td>' + qol.longBaseWithQva + '건</td><td>' + fmtPctRaw(qol.longBaseQvaRate) + '</td></tr>' +
      '<tr><td>강한 응축 (≤25%)</td><td>' + qol.tightTotal + '</td><td>' + qol.tightWithQva + '건</td><td>' + fmtPctRaw(qol.tightQvaRate) + '</td></tr>' +
      '<tr><td>장기 횡보 아님 (>60%)</td><td>' + qol.notLongBaseTotal + '</td><td>' + qol.notLongBaseWithQva + '건</td><td>' + fmtPctRaw(qol.notLongBaseQvaRate) + '</td></tr>' +
      '</tbody></table>';
  }

  // 결론
  const conclusion = data.conclusion || [];
  document.getElementById('conclusion-box').innerHTML =
    '<strong>📌 자동 결론:</strong><br>' +
    conclusion.map(c => '• ' + escapeHtml(c)).join('<br><br>');

  // 탭
  const longBaseList = winners.filter(w => w.longBase?.hasEnoughData && w.longBase.rangePct100 <= 60);
  const tightList = winners.filter(w => w.longBase?.hasEnoughData && w.longBase.rangePct100 <= 25);
  const goodList = winners.filter(w => w.longBase?.hasEnoughData && w.longBase.rangePct100 > 25 && w.longBase.rangePct100 <= 40);
  const reentryList = winners.filter(w => w.longBase?.hasValueReentry);
  const qvaList = winners.filter(w => w.qvaOverlap?.qvaWithin20Days);
  const insufficientList = winners.filter(w => !w.longBase?.hasEnoughData);
  const tabs = [
    { id: 'all', label: '전체 (' + winners.length + ')' },
    { id: 'longBase', label: '장기 횡보형 (' + longBaseList.length + ')' },
    { id: 'tight', label: '강한 응축 (' + tightList.length + ')' },
    { id: 'good', label: '좋은 장기 횡보 (' + goodList.length + ')' },
    { id: 'reentry', label: '거래대금 재유입 (' + reentryList.length + ')' },
  ];
  if (qvaList.length > 0) tabs.push({ id: 'qva', label: 'QVA 겹침 (' + qvaList.length + ')' });
  tabs.push({ id: 'insufficient', label: '데이터 부족 (' + insufficientList.length + ')' });

  const tabsEl = document.getElementById('tabs');
  let activeTab = 'longBase';
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
    if (activeTab === 'longBase') return longBaseList;
    if (activeTab === 'tight') return tightList;
    if (activeTab === 'good') return goodList;
    if (activeTab === 'reentry') return reentryList;
    if (activeTab === 'qva') return qvaList;
    if (activeTab === 'insufficient') return insufficientList;
    return winners;
  }

  function qvaPills(qva) {
    if (!qva || !qva.qvaWithin20Days) return '<span class="qva-pill none">없음</span>';
    const types = qva.qvaTypesBeforeStart || [];
    if (types.length === 0) return '<span class="qva-pill none">없음</span>';
    return types.map(t => {
      if (t === 'QVA-HIGHER_LOW') return '<span class="qva-pill hl">HL</span>';
      if (t === 'QVA-HOLD') return '<span class="qva-pill hold">HOLD</span>';
      return '<span class="qva-pill none">' + escapeHtml(t) + '</span>';
    }).join('');
  }

  const tbody = document.getElementById('list-body');
  function renderList() {
    tbody.innerHTML = '';
    let list = pickList();
    list = [...list].sort((a, b) => b.maxHighReturn - a.maxHighReturn);
    list.forEach((w, i) => {
      const m = w.bmsMetrics || {};
      const lb = w.longBase || {};
      const tr = document.createElement('tr');
      tr.className = 'row';
      const reentryTag = lb.hasValueReentry ? ' <span class="reentry-pill">재유입</span>' : '';
      tr.innerHTML =
        '<td>' + (i + 1) + '</td>' +
        '<td class="col-name">' + escapeHtml(w.name) + '<span class="meta">' + w.code + ' · ' + (w.market || '-') + '</span></td>' +
        '<td><span class="grade-pill grade-' + (w.grade || 'C') + '">' + escapeHtml(w.grade || '-') + '</span></td>' +
        '<td class="col-mobile-hide">' + fmtDate(w.startDate) + '</td>' +
        '<td class="numeric cell-pos" style="font-weight:700;">' + fmtPct(w.maxHighReturn) + '</td>' +
        '<td class="numeric col-mobile-hide ' + clsRet(w.maxCloseReturn) + '">' + fmtPct(w.maxCloseReturn) + '</td>' +
        '<td class="numeric col-mobile-hide">' + (w.daysToPeak != null ? w.daysToPeak + '일' : '-') + '</td>' +
        '<td><span class="base-pill ' + baseClass(lb.baseGrade) + '">' + escapeHtml(lb.baseGrade || '-') + '</span>' + reentryTag + '</td>' +
        '<td class="numeric">' + fmtPctRaw(lb.rangePct100) + '</td>' +
        '<td class="col-mobile-hide" style="font-size:11px;color:#cbd5e1;">' + escapeHtml(lb.basePositionLabel || '-') + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPct(lb.closeFromLow100) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPct(lb.closeFromHigh100) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPctRaw(lb.recent20ValueToCap) + '</td>' +
        '<td class="col-mobile-hide" style="font-size:11px;color:#94a3b8;">' + escapeHtml(lb.valueTrendLabel || '-') + '</td>' +
        '<td>' + qvaPills(w.qvaOverlap) + '</td>' +
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
    const lb = w.longBase || {};
    const q = w.qvaOverlap;
    const strengths = [];
    const cautions = [];
    if (lb.baseGrade === '강한 응축') strengths.push('100일 박스권 폭이 ' + lb.rangePct100 + '% 로 강하게 응축');
    else if (lb.baseGrade === '좋은 장기 횡보') strengths.push('100일 박스권 폭이 ' + lb.rangePct100 + '% 로 좋은 장기 횡보 구간');
    if (lb.hasValueReentry) strengths.push('오래 쉬다가 최근 거래대금이 다시 들어옴');
    if (lb.basePositionLabel === '장기 박스권 하단') strengths.push('상승 시작점이 장기 박스권 하단권 — 위쪽 공간 충분');
    if (q && q.qvaWithin20Days) strengths.push('상승 전 ' + (q.daysFromFirstQvaToStart != null ? q.daysFromFirstQvaToStart + '거래일 전 ' : '') + 'QVA 흔적 있음');
    if (lb.baseGrade === '장기 횡보 아님') cautions.push('100일 박스권 폭이 넓어 장기 횡보형은 아님');
    if (lb.valueTrendLabel === '거래 감소') cautions.push('100일 동안 거래대금이 점점 줄어듦 — 관심도 약화');
    if (lb.basePositionLabel === '100일 고점 돌파 상태') cautions.push('상승 시작점이 100일 고점 위 — 위쪽 공간 제한적');
    if (!lb.hasEnoughData) cautions.push('100일 데이터 부족 — 장기 횡보 판정 제한');

    let qvaBlock = '';
    if (q) {
      qvaBlock =
        '<div class="kv">' +
          '<div class="k">QVA 흔적 (20일 안)</div><div class="v">' + (q.qvaWithin20Days ? '<span class="cell-pos">있음</span>' : '<span class="cell-neg">없음</span>') + '</div>' +
          '<div class="k">상승 시작일 당일</div><div class="v">' + (q.qvaOnStartDate ? '예' : '아니오') + '</div>' +
          '<div class="k">QVA 유형</div><div class="v">' + (q.qvaTypesBeforeStart || []).join(', ') + '</div>' +
          '<div class="k">상승 며칠 전</div><div class="v">' + (q.daysFromFirstQvaToStart != null ? q.daysFromFirstQvaToStart + '거래일' : '-') + '</div>' +
        '</div>';
    } else {
      qvaBlock = '<p style="color:#94a3b8;font-size:11px;">QVA 감사 결과 파일이 없거나 매칭 실패 — QVA 데이터 없음</p>';
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
      '<div class="detail-block"><h4>📊 100일 가격 범위</h4>' +
        '<div class="kv">' +
          '<div class="k">사용 가능 일수</div><div class="v">' + (lb.daysAvailable || '-') + '거래일</div>' +
          '<div class="k">100일 고가</div><div class="v">' + fmtPrice(lb.high100) + '</div>' +
          '<div class="k">100일 저가</div><div class="v">' + fmtPrice(lb.low100) + '</div>' +
          '<div class="k">100일 박스권 폭</div><div class="v">' + fmtPctRaw(lb.rangePct100) + '</div>' +
          '<div class="k">박스권 안 위치</div><div class="v">' + fmtPctRaw(lb.startPositionInRange) + '</div>' +
          '<div class="k">100일 저점 대비</div><div class="v">' + fmtPct(lb.closeFromLow100) + '</div>' +
          '<div class="k">100일 고점 대비</div><div class="v">' + fmtPct(lb.closeFromHigh100) + '</div>' +
          '<div class="k">박스 위치</div><div class="v">' + escapeHtml(lb.basePositionLabel || '-') + '</div>' +
          '<div class="k">장기 횡보 등급</div><div class="v"><span class="base-pill ' + baseClass(lb.baseGrade) + '">' + escapeHtml(lb.baseGrade || '-') + '</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block"><h4>💰 상승 전 거래대금 흐름</h4>' +
        '<div class="kv">' +
          '<div class="k">앞 50일 평균</div><div class="v">' + (lb.first50AvgValue != null ? Math.round(lb.first50AvgValue / 1e6).toLocaleString() + '백만' : '-') + '</div>' +
          '<div class="k">뒤 50일 평균</div><div class="v">' + (lb.last50AvgValue != null ? Math.round(lb.last50AvgValue / 1e6).toLocaleString() + '백만' : '-') + '</div>' +
          '<div class="k">뒤 50일 / 앞 50일</div><div class="v">' + (lb.valueTrendRatio != null ? fmtNum(lb.valueTrendRatio) + '×' : '-') + '</div>' +
          '<div class="k">분류</div><div class="v">' + escapeHtml(lb.valueTrendLabel || '-') + '</div>' +
          '<div class="k">최근 20일 시총 대비</div><div class="v">' + fmtPctRaw(lb.recent20ValueToCap) + '</div>' +
          '<div class="k">최근20일 / 100일 평균</div><div class="v">' + (lb.recent20Vs100Avg != null ? fmtNum(lb.recent20Vs100Avg) + '×' : '-') + '</div>' +
          '<div class="k">거래대금 재유입</div><div class="v">' + (lb.hasValueReentry ? '<span class="reentry-pill">예</span>' : '아니오') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block"><h4>⚡ QVA 겹침 (참고)</h4>' + qvaBlock + '</div>' +
      '<div class="detail-block" style="grid-column: 1 / -1;"><h4>강점 / 주의점</h4>' +
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
