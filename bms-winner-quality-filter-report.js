#!/usr/bin/env node
/**
 * BMS Winner Quality Filter Report
 *
 * 목적:
 *   bms-winner-scan-result.json을 읽어 BMS 학습용으로 적합한 "정상 상승 사례"와
 *   제외해야 할 "특수/왜곡 사례"를 분리하는 보고서.
 *
 *   현재 후보 탐색은 하지 않음. 이번 단계의 목적은 오직 하나:
 *   "과거 크게 오른 종목 중 BMS가 배울 만한 정상 상승 사례만 추려낸다."
 *
 * 입력:
 *   reports/bms-winner-scan-result.json
 *
 * 출력:
 *   reports/bms-winner-quality-filter-result.json
 *   reports/bms-winner-quality-filter-result.html
 *
 * 처리 순서:
 *   1) 같은 종목 사례를 시간순으로 그룹화
 *   2) 종목당 "대표 사례" 1개 선택 — 가장 먼저 +40% 도달한 사례.
 *      단, 그 사례가 특수 의심이면 다음 사례로 fallback.
 *   3) 대표 사례를 정상 기준으로 검사:
 *      - 정상이면 등급 분류 (A/B/C)
 *      - 특수 의심이면 excluded 처리 + 사유
 *   4) 통계·요약·정상 사례 공통 조건 계산
 *
 *   특정 종목명을 직접 조건에 넣지 않음. 시장 전체에서 자동 선별.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const INPUT_PATH = path.join(REPORTS_DIR, 'bms-winner-scan-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-winner-quality-filter-result.html');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  });
  return out;
})();

// ─────────────────────── CONFIG (모두 조정 가능) ───────────────────────

const CONFIG = {
  // 특수 케이스 의심 임계값
  EXCLUDE_FAST_DAYS: 2,
  EXCLUDE_FAST_RETURN: 100,            // 2일 이내 +100% 이상
  EXCLUDE_EXTREME_RETURN: 300,         // 어떤 기간이든 +300% 이상
  EXCLUDE_PRE_DAYS_MIN: 10,            // 준비 구간 최소 일수 (못 채우면 제외)
  EXCLUDE_BOX_RANGE_MAX: 80,           // 박스권 폭 80% 이상이면 제외
  EXCLUDE_LOW60_MAX: 150,              // 60일 저점 대비 +150% 이상이면 이미 너무 오른 뒤
  EXCLUDE_NEAR_52W_HIGH_THRESHOLD: -3, // closeFrom52WeekHigh ≥ -3% (즉 거의 신고가)이면 제외

  // 정상 사례 기본 기준
  NORMAL_HIGH_RETURN_MIN: 40,
  NORMAL_HIGH_RETURN_MAX: 150,
  NORMAL_CLOSE_RETURN_MIN: 25,         // 종가 +25%+ 권장 (필수는 아님)
  NORMAL_DAYS_TO_PEAK_MIN: 3,
  NORMAL_DAYS_TO_PEAK_MAX: 15,
  NORMAL_PRE_DAYS_MIN: 15,             // 준비 구간 최소 15일
  NORMAL_BOX_RANGE_MIN: 8,
  NORMAL_BOX_RANGE_MAX: 35,
  NORMAL_LOW60_MIN: 5,
  NORMAL_LOW60_MAX: 80,
  NORMAL_HIGH60_MIN: -40,
  NORMAL_HIGH60_MAX: 5,
  NORMAL_PRE_ACCUM_MIN_PCT: 3,         // 시총 대비 누적 ≥ 3%
  NORMAL_START_DAY_RATIO_MIN_PCT: 0.3, // 시총 대비 시작일 거래대금 ≥ 0.3%

  // A 등급 기준 (정상 사례 안에서)
  A_HIGH_RETURN_MIN: 40,
  A_HIGH_RETURN_MAX: 100,
  A_DAYS_MIN: 5,
  A_DAYS_MAX: 15,
  A_BOX_RANGE_MIN: 10,
  A_BOX_RANGE_MAX: 25,
  A_LOW60_MIN: 10,
  A_LOW60_MAX: 60,
  A_VALUE_SPIKE_MIN: 1.5,              // 평소보다 1.5배 이상
  A_PRE_ACCUM_MIN_PCT: 5,
  A_PRE_ACCUM_MAX_PCT: 80,
};

// 사용자 인자로 일부 오버라이드 가능 (예: --high-min=40 --high-max=120)
if (args['high-min']) CONFIG.NORMAL_HIGH_RETURN_MIN = parseFloat(args['high-min']);
if (args['high-max']) CONFIG.NORMAL_HIGH_RETURN_MAX = parseFloat(args['high-max']);

// ─────────────────────── 헬퍼 ───────────────────────

function round(v, d) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function pct(num, den) { if (!den || den === 0) return null; return round(num / den * 100, 2); }
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function avg(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  if (v.length === 0) return null;
  return round(v.reduce((s, x) => s + x, 0) / v.length, 2);
}

// ─────────────────────── 특수 케이스 의심 검사 ───────────────────────

function checkExclusionFlags(w) {
  const flags = [];
  const a = w.analysis || {};
  const pa = a.preAccumulation || {};
  const ba = a.boxAnalysis || {};
  const pp = a.pricePosition || {};
  const ma = a.movingAverage || {};
  const sz = a.supplyZone || {};

  // 너무 빠른 폭등
  if (w.daysToPeak <= CONFIG.EXCLUDE_FAST_DAYS && (w.maxHighReturn || 0) >= CONFIG.EXCLUDE_FAST_RETURN) {
    flags.push('너무 빠른 폭등 (' + CONFIG.EXCLUDE_FAST_DAYS + '일 이내 +' + CONFIG.EXCLUDE_FAST_RETURN + '%↑)');
  }
  // 비정상 폭등
  if ((w.maxHighReturn || 0) >= CONFIG.EXCLUDE_EXTREME_RETURN) {
    flags.push('비정상 폭등 (+' + CONFIG.EXCLUDE_EXTREME_RETURN + '% 이상)');
  }
  // 준비 구간 데이터 부족
  if ((pa.days || 0) < CONFIG.EXCLUDE_PRE_DAYS_MIN) {
    flags.push('상승 전 준비 구간 데이터 부족 (' + (pa.days || 0) + '일)');
  }
  // 거래대금 0 또는 데이터 이상
  if ((pa.avgPreValue || 0) === 0) {
    flags.push('상승 전 거래대금 거의 0 (거래 없다가 튄 사례)');
  }
  if ((pa.startDayValue || 0) === 0) {
    flags.push('상승 시작일 거래대금 0 (데이터 이상)');
  }
  // 박스권 폭 너무 넓음
  if (ba.boxRangePct != null && ba.boxRangePct >= CONFIG.EXCLUDE_BOX_RANGE_MAX) {
    flags.push('박스권 폭이 너무 넓음 (≥' + CONFIG.EXCLUDE_BOX_RANGE_MAX + '%)');
  }
  // 이미 너무 오른 뒤
  if (pp.closeFromLow60 != null && pp.closeFromLow60 >= CONFIG.EXCLUDE_LOW60_MAX) {
    flags.push('이미 60일 저점 대비 +' + CONFIG.EXCLUDE_LOW60_MAX + '% 이상 위');
  }
  // 52주 신고가 근처
  if (pp.closeFrom52WeekHigh != null && pp.closeFrom52WeekHigh >= CONFIG.EXCLUDE_NEAR_52W_HIGH_THRESHOLD) {
    flags.push('이미 52주 신고가 근처에서 시작');
  }
  // 이평선 데이터 부족 (60일선만 필수, 120일선은 차트 길이 한계로 자주 없음 → 별도 표기만)
  if (!ma.ma60) {
    flags.push('이평선 데이터 부족 (60일선 없음 — startIdx가 차트 앞쪽)');
  }
  // 박스권 데이터 부족 (정상 검사에서 박스권 폭 null로 자동 컷 → 여기선 정보 플래그만)
  if (ba.dataLimit) flags.push('박스권 데이터 부족 (계산 불가)');
  // 매물대 데이터 부족 (위쪽 매물 분석 한계만 표기)
  // → 매물대만 부족하다고 학습에서 빼는 건 과도. 제외 사유에서 빼고 정보로만 둠.
  // if (sz.dataLimit) flags.push('매물대 데이터 부족');

  return flags;
}

// ─────────────────────── 정상 사례 기준 ───────────────────────

function isNormalCase(w) {
  const a = w.analysis || {};
  const pa = a.preAccumulation || {};
  const ba = a.boxAnalysis || {};
  const pp = a.pricePosition || {};

  if (!(w.maxHighReturn >= CONFIG.NORMAL_HIGH_RETURN_MIN && w.maxHighReturn <= CONFIG.NORMAL_HIGH_RETURN_MAX)) return false;
  if (!(w.daysToPeak >= CONFIG.NORMAL_DAYS_TO_PEAK_MIN && w.daysToPeak <= CONFIG.NORMAL_DAYS_TO_PEAK_MAX)) return false;
  if ((pa.days || 0) < CONFIG.NORMAL_PRE_DAYS_MIN) return false;

  const boxR = ba.boxRangePct;
  if (boxR == null || boxR < CONFIG.NORMAL_BOX_RANGE_MIN || boxR > CONFIG.NORMAL_BOX_RANGE_MAX) return false;

  const low60 = pp.closeFromLow60;
  if (low60 == null || low60 < CONFIG.NORMAL_LOW60_MIN || low60 > CONFIG.NORMAL_LOW60_MAX) return false;

  const high60 = pp.closeFromHigh60;
  if (high60 == null || high60 < CONFIG.NORMAL_HIGH60_MIN || high60 > CONFIG.NORMAL_HIGH60_MAX) return false;

  if ((pa.startDayValue || 0) <= 0) return false;
  if ((pa.accumulatedValueRatio || 0) < CONFIG.NORMAL_PRE_ACCUM_MIN_PCT) return false;
  if ((pa.startDayValueRatio || 0) < CONFIG.NORMAL_START_DAY_RATIO_MIN_PCT) return false;

  return true;
}

// ─────────────────────── 등급 분류 ───────────────────────

function classifyGrade(w) {
  const a = w.analysis || {};
  const pa = a.preAccumulation || {};
  const ba = a.boxAnalysis || {};
  const pp = a.pricePosition || {};

  const isA = (
    w.maxHighReturn >= CONFIG.A_HIGH_RETURN_MIN && w.maxHighReturn <= CONFIG.A_HIGH_RETURN_MAX
    && w.daysToPeak >= CONFIG.A_DAYS_MIN && w.daysToPeak <= CONFIG.A_DAYS_MAX
    && ba.boxRangePct != null && ba.boxRangePct >= CONFIG.A_BOX_RANGE_MIN && ba.boxRangePct <= CONFIG.A_BOX_RANGE_MAX
    && pp.closeFromLow60 != null && pp.closeFromLow60 >= CONFIG.A_LOW60_MIN && pp.closeFromLow60 <= CONFIG.A_LOW60_MAX
    && (pa.valueSpikeRatio || 0) >= CONFIG.A_VALUE_SPIKE_MIN
    && (pa.accumulatedValueRatio || 0) >= CONFIG.A_PRE_ACCUM_MIN_PCT
    && (pa.accumulatedValueRatio || 0) <= CONFIG.A_PRE_ACCUM_MAX_PCT
  );
  if (isA) return 'A';

  // 정상 통과했지만 A는 아님 → B/C
  // B = NORMAL 기본 기준 그대로 (이미 통과한 상태)
  // C = NORMAL을 일부 못 만족하지만 살릴만한 케이스 — 이번 함수는 NORMAL 통과 후 호출되므로 사실상 B 이상
  // C를 만들려면 NORMAL 기준을 살짝 완화해야. 별도 isLooseCase로 처리.
  return 'B';
}

// 정상 기준 살짝 완화 (C 등급 후보)
function isLooseCase(w) {
  const a = w.analysis || {};
  const pa = a.preAccumulation || {};
  const ba = a.boxAnalysis || {};
  const pp = a.pricePosition || {};

  // 너무 빠르거나 박스 넓거나 데이터 일부 부족하지만 완전 제외는 아님
  if (!(w.maxHighReturn >= 40 && w.maxHighReturn <= 200)) return false;
  if (!(w.daysToPeak >= 2 && w.daysToPeak <= 15)) return false;
  if ((pa.days || 0) < 10) return false;
  if ((pa.startDayValue || 0) <= 0) return false;
  if (pp.closeFrom52WeekHigh != null && pp.closeFrom52WeekHigh >= -3) return false;
  if (ba.boxRangePct != null && ba.boxRangePct >= 60) return false;     // 박스 60%까지 허용
  return true;
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Winner Quality Filter Report');
  console.log('═'.repeat(80));

  if (!fs.existsSync(INPUT_PATH)) {
    console.error('입력 없음:', INPUT_PATH);
    console.error('먼저 `node bms-winner-scan-report.js` 실행 필요');
    process.exit(1);
  }

  const src = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const winners = src.winners || [];
  console.log(`원본 사례: ${winners.length}건`);

  // 1) 종목별 그룹화 (시간순)
  const byCode = new Map();
  winners.forEach(w => {
    if (!byCode.has(w.code)) byCode.set(w.code, []);
    byCode.get(w.code).push(w);
  });
  byCode.forEach(arr => arr.sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '')));
  const uniqueStockCount = byCode.size;
  console.log(`중복 제거 후 종목: ${uniqueStockCount}개`);

  // 2) 종목당 대표 사례 선택
  // 첫 사례가 특수 의심이면 다음 정상으로 fallback
  const representatives = [];
  const skipped = [];        // 종목 안에서 대표가 아닌 사례 (중복 redundant)
  byCode.forEach((arr, code) => {
    let chosen = null;
    let chosenReason = null;
    for (const w of arr) {
      const flags = checkExclusionFlags(w);
      if (flags.length === 0) {
        chosen = w;
        chosenReason = '가장 먼저 +40% 달성한 정상 사례';
        break;
      }
    }
    if (!chosen) {
      // 모두 특수 의심 → 첫 사례 대표로 두되 excluded 처리
      chosen = arr[0];
      chosenReason = '같은 종목 모든 사례가 특수 케이스 의심 (첫 사례 대표)';
    }
    chosen._chosenReason = chosenReason;
    representatives.push(chosen);
    arr.forEach(w => { if (w !== chosen) skipped.push({ ...w, _skipReason: '같은 종목 대표 사례 외' }); });
  });

  // 3) 대표 사례 분류
  const cleanWinners = [];   // A/B/C
  const excludedWinners = []; // 제외 사유 + 사례

  representatives.forEach(w => {
    const flags = checkExclusionFlags(w);
    if (flags.length > 0) {
      excludedWinners.push({ ...w, _exclusionFlags: flags });
      return;
    }
    if (isNormalCase(w)) {
      const grade = classifyGrade(w);
      cleanWinners.push({ ...w, _grade: grade });
    } else if (isLooseCase(w)) {
      cleanWinners.push({ ...w, _grade: 'C' });
    } else {
      excludedWinners.push({ ...w, _exclusionFlags: ['정상 기준에서 일부 항목 미달 (Loose도 안 됨)'] });
    }
  });

  // 정렬: cleanWinners는 grade(A>B>C) → maxHighReturn 내림차순
  const gradeOrder = { A: 1, B: 2, C: 3 };
  cleanWinners.sort((a, b) => {
    const ga = gradeOrder[a._grade] || 9;
    const gb = gradeOrder[b._grade] || 9;
    if (ga !== gb) return ga - gb;
    return (b.maxHighReturn || 0) - (a.maxHighReturn || 0);
  });
  excludedWinners.sort((a, b) => (b.maxHighReturn || 0) - (a.maxHighReturn || 0));

  // 4) 통계
  const gradeCount = { A: 0, B: 0, C: 0 };
  cleanWinners.forEach(w => { gradeCount[w._grade]++; });

  // 제외 사유 집계
  const exclusionReasonCount = new Map();
  excludedWinners.forEach(w => {
    (w._exclusionFlags || []).forEach(f => {
      exclusionReasonCount.set(f, (exclusionReasonCount.get(f) || 0) + 1);
    });
  });
  const exclusionReasonSummary = [...exclusionReasonCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));

  // 정상 사례 (A+B) 공통 조건
  const ab = cleanWinners.filter(w => w._grade === 'A' || w._grade === 'B');
  const patternSummary = computePatternSummary(ab);

  // 전체 정상 (A+B+C) 평균
  const allCleanSummary = computePatternSummary(cleanWinners);

  // 요약
  const summary = {
    sourceTotalCount: winners.length,
    uniqueStockCount,
    representativeCount: representatives.length,
    skippedDuplicateCount: skipped.length,
    cleanCount: cleanWinners.length,
    excludedCount: excludedWinners.length,
    excludedRate: pct(excludedWinners.length, representatives.length),
    gradeACount: gradeCount.A,
    gradeBCount: gradeCount.B,
    gradeCCount: gradeCount.C,
    avgMaxHighReturn: avg(cleanWinners.map(w => w.maxHighReturn)),
    medMaxHighReturn: round(median(cleanWinners.map(w => w.maxHighReturn).filter(v => v != null)), 2),
    avgDaysToPeak: avg(cleanWinners.map(w => w.daysToPeak)),
    avgPreAccumulationRatio: avg(cleanWinners.map(w => w.analysis?.preAccumulation?.accumulatedValueRatio)),
    avgBoxRangePct: avg(cleanWinners.map(w => w.analysis?.boxAnalysis?.boxRangePct)),
  };

  // 콘솔 요약
  console.log('\n📊 정리 결과:');
  console.log(`  원본 사례: ${summary.sourceTotalCount}건`);
  console.log(`  중복 제거 후 종목: ${uniqueStockCount}개`);
  console.log(`  중복 사례 제외: ${summary.skippedDuplicateCount}건`);
  console.log(`  정상 사례: ${summary.cleanCount}건 (A=${gradeCount.A} / B=${gradeCount.B} / C=${gradeCount.C})`);
  console.log(`  제외 사례: ${summary.excludedCount}건 (제외율 ${summary.excludedRate}%)`);
  console.log(`  정상 평균 상승률: ${summary.avgMaxHighReturn}%`);
  console.log(`  정상 평균 도달 소요: ${summary.avgDaysToPeak}일`);
  console.log(`  정상 평균 시총 대비 들어온 돈: ${summary.avgPreAccumulationRatio}%`);
  console.log(`  정상 평균 박스권 폭: ${summary.avgBoxRangePct}%`);

  console.log('\n🚫 제외 사유 TOP 10:');
  exclusionReasonSummary.slice(0, 10).forEach(({ reason, count }) => {
    console.log(`  ${count.toString().padStart(4)}건  ${reason}`);
  });

  console.log('\n🔬 A+B 등급 공통 조건 (학습용):');
  Object.entries(patternSummary).slice(0, 16).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(36)} ${JSON.stringify(v)}`);
  });

  // 5) 출력
  const out = {
    meta: {
      version: 'bms-winner-quality-filter-v1',
      generatedAt: new Date().toISOString(),
      title: 'BMS 학습용 정상 상승 사례 정리 보고서',
      purpose: '과거 +40% 사례 중 BMS가 배울 만한 정상 상승 사례만 추려낸다. 너무 빠른 폭등·신고가 근처·데이터 부족·박스권 너무 넓음 등 특수 케이스를 제외.',
      nextStep: '다음 단계에서는 A/B 등급 정상 사례의 공통 조건을 기준으로 현재 종목 중 비슷한 준비 구간에 있는 종목을 찾는다 (bms-current-similarity-scan.js, 미작성).',
      inputFile: 'reports/bms-winner-scan-result.json',
    },
    config: CONFIG,
    summary,
    gradeSummary: {
      A: { count: gradeCount.A, label: '가장 참고하기 좋은 상승 사례' },
      B: { count: gradeCount.B, label: '참고 가능한 상승 사례' },
      C: { count: gradeCount.C, label: '참고만 할 사례' },
      excluded: { count: excludedWinners.length, label: '학습에 쓰면 안 되는 사례' },
    },
    exclusionReasonSummary,
    cleanWinners,
    excludedWinners,
    duplicateSummary: {
      uniqueStockCount,
      sourceTotalCount: winners.length,
      skippedDuplicateCount: skipped.length,
    },
    patternSummary,
    allCleanSummary,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length/1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length/1024).toFixed(0)}KB)`);
}

function computePatternSummary(winners) {
  if (winners.length === 0) return { count: 0 };
  const get = (path) => winners.map(w => {
    const parts = path.split('.');
    let v = w;
    for (const p of parts) v = v?.[p];
    return v;
  }).filter(v => v != null && isFinite(v));

  const ma20Above = winners.filter(w => w.analysis?.movingAverage?.aboveMa20 === true).length;
  const ma60Above = winners.filter(w => w.analysis?.movingAverage?.aboveMa60 === true).length;
  const ma120Above = winners.filter(w => w.analysis?.movingAverage?.aboveMa120 === true).length;
  const shortRecovery = winners.filter(w => w.analysis?.movingAverage?.arrangement === 'SHORT_RECOVERY').length;

  return {
    count: winners.length,
    avgMaxHighReturn: avg(get('maxHighReturn')),
    medMaxHighReturn: round(median(get('maxHighReturn')), 2),
    avgMaxCloseReturn: avg(get('maxCloseReturn')),
    avgDaysToPeak: avg(get('daysToPeak')),
    avgPreAccumulationRatio: avg(get('analysis.preAccumulation.accumulatedValueRatio')),
    avgStartDayValueRatio: avg(get('analysis.preAccumulation.startDayValueRatio')),
    avgValueSpikeRatio: avg(get('analysis.preAccumulation.valueSpikeRatio')),
    avgBoxRangeDays: avg(get('analysis.boxAnalysis.boxRangeDays')),
    avgBoxRangePct: avg(get('analysis.boxAnalysis.boxRangePct')),
    avgBreakoutValueRatio: avg(get('analysis.boxAnalysis.breakoutValueRatio')),
    avgSupplyAboveRatio: avg(get('analysis.supplyZone.aboveCloseRatio')),
    avgCloseFromLow60: avg(get('analysis.pricePosition.closeFromLow60')),
    avgCloseFromHigh60: avg(get('analysis.pricePosition.closeFromHigh60')),
    avgCloseFrom52WeekHigh: avg(get('analysis.pricePosition.closeFrom52WeekHigh')),
    aboveMa20Pct: pct(ma20Above, winners.length),
    aboveMa60Pct: pct(ma60Above, winners.length),
    aboveMa120Pct: pct(ma120Above, winners.length),
    shortRecoveryPct: pct(shortRecovery, winners.length),
  };
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>BMS 학습용 정상 상승 사례 정리 보고서</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1400px;
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

.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 18px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-top: 3px; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; line-height: 1.4; }
.big-tile.A { border-left: 4px solid #10b981; }
.big-tile.A .value { color: #6ee7b7; }
.big-tile.B { border-left: 4px solid #3b82f6; }
.big-tile.B .value { color: #93c5fd; }
.big-tile.C { border-left: 4px solid #fbbf24; }
.big-tile.C .value { color: #fde047; }
.big-tile.excluded { border-left: 4px solid #ef4444; }
.big-tile.excluded .value { color: #fca5a5; }
.big-tile.primary { border-left: 4px solid #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }

.tabs { display: flex; gap: 6px; margin: 18px 0 8px; flex-wrap: wrap; }
.tab-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-weight: 500; }
.tab-btn:hover { color: #f1f5f9; border-color: #64748b; }
.tab-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }
.tab-btn.A.active { background: #047857; border-color: #10b981; }
.tab-btn.B.active { background: #1e40af; border-color: #3b82f6; }
.tab-btn.C.active { background: #92400e; border-color: #fbbf24; }
.tab-btn.excluded.active { background: #991b1b; border-color: #ef4444; }

.tbl-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.list { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
table.list thead th {
  background: #0f172a; color: #94a3b8; font-weight: 600; text-align: left;
  padding: 9px 12px; border-bottom: 1px solid #334155; white-space: nowrap;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px;
}
table.list thead th.numeric { text-align: right; }
table.list tbody tr.row { border-bottom: 1px solid #1e293b; cursor: pointer; }
table.list tbody tr.row:hover { background: #273549; }
table.list tbody tr.row.expanded { background: #1e3a5f; }
table.list tbody tr.row td { padding: 8px 12px; vertical-align: middle; line-height: 1.3; white-space: nowrap; }
table.list tbody tr.row td.numeric { text-align: right; }
table.list tbody tr.row td.col-name { font-weight: 600; color: #f1f5f9; min-width: 130px; }
table.list tbody tr.row td.col-name .meta { display: block; font-size: 10px; color: #64748b; font-weight: 400; margin-top: 2px; }
table.list tbody tr.row td.col-name .grade-badge { display: inline-block; padding: 1px 6px; margin-right: 6px; border-radius: 4px; font-size: 10px; font-weight: 700; vertical-align: 1px; }
table.list tbody tr.row td.col-name .grade-A { background: #047857; color: #d1fae5; }
table.list tbody tr.row td.col-name .grade-B { background: #1e40af; color: #dbeafe; }
table.list tbody tr.row td.col-name .grade-C { background: #92400e; color: #fef3c7; }
table.list tbody tr.row td.col-name .grade-X { background: #7f1d1d; color: #fee2e2; }
table.list tbody tr.row:nth-child(odd) { background: #1c2942; }
table.list tbody tr.row:nth-child(odd):hover { background: #273549; }
table.list tbody tr.row.expanded, table.list tbody tr.row.expanded:nth-child(odd) { background: #1e3a5f; }

.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-warn { color: #fde047; }
.flag-pill { display: inline-block; padding: 1px 7px; margin: 1px 3px 1px 0; background: #581c87; color: #d8b4fe; border-radius: 4px; font-size: 10px; }

table.list tbody tr.detail { display: none; background: #0c1729; }
table.list tbody tr.detail.show { display: table-row; }
table.list tbody tr.detail td { padding: 14px 18px; border-bottom: 1px solid #1e3a5f; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 24px; font-size: 12px; }
.detail-block h4 { margin: 0 0 6px; font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.detail-block p { margin: 0 0 4px; color: #cbd5e1; line-height: 1.6; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; line-height: 1.6; }
.kv .k { color: #64748b; }
.kv .v { color: #cbd5e1; font-variant-numeric: tabular-nums; }

.exclusion-reason-list { background: #1e293b; border-radius: 8px; padding: 12px 16px; }
.exclusion-reason-list .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dashed #334155; font-size: 13px; }
.exclusion-reason-list .row:last-child { border-bottom: none; }
.exclusion-reason-list .reason { color: #fde68a; }
.exclusion-reason-list .count { color: #fca5a5; font-weight: 700; font-variant-numeric: tabular-nums; }

.pattern-summary { background: #1e293b; border-radius: 8px; padding: 14px 18px; }
.pattern-summary .kv { grid-template-columns: 1fr auto; }
.pattern-summary .kv .k { color: #cbd5e1; }
.pattern-summary .kv .v { color: #67e8f9; font-weight: 600; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .tbl-wrap { overflow-x: auto !important; }
  .col-mobile-hide,
  table.list thead th.col-mobile-hide { display: none; }
  .detail-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<h1 id="page-title">BMS 학습용 정상 상승 사례 정리 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 과거 +40% 사례 중에서 BMS가 학습에 쓸 만한 정상 사례만 추려내는 보고서입니다.
  현재 종목 후보 탐색은 별도 파일에서 진행합니다.
</div>

<h2>📊 정리 요약</h2>
<div class="big-summary" id="big-summary"></div>

<h2>🚫 제외 사유 TOP</h2>
<div class="exclusion-reason-list" id="exclusion-reason-list"></div>

<h2>🔬 A+B 등급 공통 조건 (학습 기준)</h2>
<p style="color:#94a3b8;font-size:12px;line-height:1.6;">A등급(가장 참고하기 좋은)·B등급(참고 가능)만 모아서 평균/중앙값을 계산. 다음 단계 (현재 종목 유사도 검색) 의 기준점이 됩니다.</p>
<div class="pattern-summary" id="pattern-summary"></div>

<h2>🏆 사례 리스트</h2>
<div class="tabs" id="tabs"></div>
<div class="tbl-wrap">
  <table class="list">
    <thead>
      <tr>
        <th>종목</th>
        <th class="numeric">상승률 (고가)</th>
        <th class="numeric">소요 일수</th>
        <th class="col-mobile-hide">상승 시작일</th>
        <th class="col-mobile-hide">정점일</th>
        <th class="numeric col-mobile-hide">시총</th>
        <th class="numeric">시총 대비 들어온 돈</th>
        <th class="numeric col-mobile-hide">박스권 폭</th>
        <th class="numeric col-mobile-hide">저점 대비 위치</th>
        <th class="col-mobile-hide">이평선 정렬</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<footer class="foot">
  <strong>다음 단계 예고:</strong> A등급/B등급 상승 사례들의 공통 조건을 기준으로
  현재 종목 중 비슷한 준비 구간에 있는 종목을 찾습니다 (별도 파일에서 진행).
</footer>

<script id="report-data" type="application/json">__JSON_DATA__</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const meta = data.meta || {};
  const summary = data.summary || {};
  const cleanWinners = data.cleanWinners || [];
  const excludedWinners = data.excludedWinners || [];
  const patternSummary = data.patternSummary || {};
  const exclusionReasonSummary = data.exclusionReasonSummary || [];

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d); }
  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtMc(v) { if (!v) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; return Math.round(e) + '억'; }
  function fmtValue(v) { if (!v || !isFinite(v)) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; if (e >= 1) return e.toFixed(0) + '억'; return Math.round(v / 1e6) + '백만'; }
  function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }

  document.getElementById('subtitle').innerHTML =
    '원본 ' + summary.sourceTotalCount + '건 → 종목 ' + summary.uniqueStockCount + '개 → ' +
    '<span class="cell-pos">정상 ' + summary.cleanCount + '건</span> / ' +
    '<span class="cell-neg">제외 ' + summary.excludedCount + '건 (' + summary.excludedRate + '%)</span> · ' +
    '생성 ' + new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>📌 다음 단계:</strong> ' + escapeHtml(meta.nextStep);

  // big tiles
  const tiles = [
    { label: '원본 상승 사례', value: summary.sourceTotalCount + '건', sub: '중복 포함', cls: '' },
    { label: '중복 제거 후 종목', value: summary.uniqueStockCount + '개', sub: '대표 사례 1개씩', cls: 'primary' },
    { label: '학습용 정상 사례', value: summary.cleanCount + '건', sub: 'A+B+C', cls: 'primary' },
    { label: 'A등급', value: summary.gradeACount + '건', sub: '가장 참고하기 좋은', cls: 'A' },
    { label: 'B등급', value: summary.gradeBCount + '건', sub: '참고 가능', cls: 'B' },
    { label: 'C등급', value: summary.gradeCCount + '건', sub: '참고만', cls: 'C' },
    { label: '제외 사례', value: summary.excludedCount + '건', sub: '제외율 ' + summary.excludedRate + '%', cls: 'excluded' },
    { label: '정상 평균 상승률', value: fmtPct(summary.avgMaxHighReturn), sub: '중앙값 ' + fmtPct(summary.medMaxHighReturn), cls: '' },
    { label: '정상 평균 도달 소요', value: fmtNum(summary.avgDaysToPeak, 1) + '거래일', sub: '', cls: '' },
    { label: '정상 평균 시총 대비 돈', value: fmtPct(summary.avgPreAccumulationRatio), sub: '상승 전 누적', cls: '' },
    { label: '정상 평균 박스권 폭', value: fmtPct(summary.avgBoxRangePct), sub: '', cls: '' },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div>' + (t.sub ? '<div class="sub">' + t.sub + '</div>' : '');
    ts.appendChild(el);
  });

  // 제외 사유
  const erEl = document.getElementById('exclusion-reason-list');
  if (exclusionReasonSummary.length === 0) {
    erEl.innerHTML = '<div style="color:#64748b;">제외 사례 없음</div>';
  } else {
    exclusionReasonSummary.slice(0, 15).forEach(r => {
      const div = document.createElement('div');
      div.className = 'row';
      div.innerHTML = '<span class="reason">' + escapeHtml(r.reason) + '</span><span class="count">' + r.count + '건</span>';
      erEl.appendChild(div);
    });
  }

  // pattern summary
  const patternKv = [
    ['후보 수', patternSummary.count + '건'],
    ['평균 상승률 (고가)', fmtPct(patternSummary.avgMaxHighReturn)],
    ['중앙값 상승률', fmtPct(patternSummary.medMaxHighReturn)],
    ['평균 상승률 (종가)', fmtPct(patternSummary.avgMaxCloseReturn)],
    ['평균 +40% 도달 소요', fmtNum(patternSummary.avgDaysToPeak, 1) + '거래일'],
    ['평균 시총 대비 들어온 돈', fmtPct(patternSummary.avgPreAccumulationRatio)],
    ['평균 시총 대비 시작일 거래대금', fmtPct(patternSummary.avgStartDayValueRatio)],
    ['평균 상승 시작일 거래대금 spike', fmtNum(patternSummary.avgValueSpikeRatio) + '배'],
    ['평균 박스권 기간', fmtNum(patternSummary.avgBoxRangeDays, 1) + '일'],
    ['평균 박스권 폭', fmtPct(patternSummary.avgBoxRangePct)],
    ['평균 돌파일 거래대금 배수', fmtNum(patternSummary.avgBreakoutValueRatio) + '배'],
    ['평균 위쪽 매물 부담', fmtPct(patternSummary.avgSupplyAboveRatio)],
    ['평균 60일 저점 대비', fmtPct(patternSummary.avgCloseFromLow60)],
    ['평균 60일 고점 대비', fmtPct(patternSummary.avgCloseFromHigh60)],
    ['평균 52주 고점 대비', fmtPct(patternSummary.avgCloseFrom52WeekHigh)],
    ['20일선 위에서 시작한 비율', fmtPct(patternSummary.aboveMa20Pct)],
    ['60일선 위에서 시작한 비율', fmtPct(patternSummary.aboveMa60Pct)],
    ['120일선 위에서 시작한 비율', fmtPct(patternSummary.aboveMa120Pct)],
    ['단기선만 회복한 비율', fmtPct(patternSummary.shortRecoveryPct)],
  ];
  let psHtml = '<div class="kv">';
  patternKv.forEach(([k, v]) => {
    psHtml += '<div class="k">' + k + '</div><div class="v">' + v + '</div>';
  });
  psHtml += '</div>';
  document.getElementById('pattern-summary').innerHTML = psHtml;

  // tabs
  const tabs = [
    { id: 'A', label: 'A등급 (' + summary.gradeACount + ')', cls: 'A' },
    { id: 'B', label: 'B등급 (' + summary.gradeBCount + ')', cls: 'B' },
    { id: 'C', label: 'C등급 (' + summary.gradeCCount + ')', cls: 'C' },
    { id: 'excluded', label: '제외 (' + summary.excludedCount + ')', cls: 'excluded' },
    { id: 'all', label: '전체 정상 (' + summary.cleanCount + ')', cls: '' },
  ];
  const tabsEl = document.getElementById('tabs');
  let activeTab = 'A';
  tabs.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn ' + t.cls + (t.id === activeTab ? ' active' : '');
    btn.textContent = t.label;
    btn.dataset.tab = t.id;
    btn.dataset.cls = t.cls;
    btn.addEventListener('click', () => {
      activeTab = t.id;
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderList();
    });
    tabsEl.appendChild(btn);
  });

  function pickList() {
    if (activeTab === 'A') return cleanWinners.filter(w => w._grade === 'A');
    if (activeTab === 'B') return cleanWinners.filter(w => w._grade === 'B');
    if (activeTab === 'C') return cleanWinners.filter(w => w._grade === 'C');
    if (activeTab === 'excluded') return excludedWinners;
    return cleanWinners;
  }

  const tbody = document.getElementById('list-body');
  function renderList() {
    tbody.innerHTML = '';
    const list = pickList();
    list.forEach((w) => {
      const a = w.analysis || {};
      const grade = w._grade || 'X';
      const tr = document.createElement('tr');
      tr.className = 'row';
      tr.innerHTML =
        '<td class="col-name">' +
          '<span class="grade-badge grade-' + grade + '">' + grade + '</span>' +
          escapeHtml(w.name) +
          '<span class="meta">' + w.code + ' · ' + (w.market || '-') + '</span>' +
        '</td>' +
        '<td class="numeric cell-pos" style="font-weight:700;">' + fmtPct(w.maxHighReturn) + '</td>' +
        '<td class="numeric">' + w.daysToPeak + '일</td>' +
        '<td class="col-mobile-hide">' + fmtDate(w.startDate) + '</td>' +
        '<td class="col-mobile-hide">' + fmtDate(w.peakDate) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtMc(w.marketCap) + '</td>' +
        '<td class="numeric">' + fmtPct(a.preAccumulation?.accumulatedValueRatio) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPct(a.boxAnalysis?.boxRangePct) + '</td>' +
        '<td class="numeric col-mobile-hide">' + fmtPct(a.pricePosition?.closeFromLow60) + '</td>' +
        '<td class="col-mobile-hide">' + (a.movingAverage?.arrangement || '-') + '</td>';
      const trd = document.createElement('tr');
      trd.className = 'detail';
      trd.innerHTML = '<td colspan="10">' + buildDetailHtml(w) + '</td>';
      tr.addEventListener('click', () => {
        tr.classList.toggle('expanded');
        trd.classList.toggle('show');
      });
      tbody.appendChild(tr);
      tbody.appendChild(trd);
    });
  }

  function buildDetailHtml(w) {
    const a = w.analysis || {};
    const pa = a.preAccumulation || {};
    const ra = a.runAnalysis || {};
    const ba = a.boxAnalysis || {};
    const pp = a.pricePosition || {};
    const ma = a.movingAverage || {};
    const sz = a.supplyZone || {};
    const flagsHtml = (w._exclusionFlags || []).map(f => '<span class="flag-pill">' + escapeHtml(f) + '</span>').join('');

    return '<div class="detail-grid">' +
      '<div class="detail-block">' +
        '<h4>판정 결과</h4>' +
        '<p>등급: <strong style="color:#67e8f9;">' + (w._grade || '제외') + '</strong></p>' +
        '<p>대표 사례 선택 사유: ' + escapeHtml(w._chosenReason || '-') + '</p>' +
        (flagsHtml ? '<p>제외 사유: ' + flagsHtml + '</p>' : '') +
      '</div>' +
      '<div class="detail-block">' +
        '<h4>① 상승 전 거래대금</h4>' +
        '<div class="kv">' +
          '<div class="k">시총 대비 들어온 돈</div><div class="v">' + fmtPct(pa.accumulatedValueRatio) + '</div>' +
          '<div class="k">시총 대비 시작일 거래대금</div><div class="v">' + fmtPct(pa.startDayValueRatio) + '</div>' +
          '<div class="k">평소 대비 spike</div><div class="v">' + (pa.valueSpikeRatio != null ? fmtNum(pa.valueSpikeRatio) + '×' : '-') + '</div>' +
          '<div class="k">준비 구간 일수</div><div class="v">' + (pa.days || '-') + '일</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block">' +
        '<h4>② 상승 진행</h4>' +
        '<div class="kv">' +
          '<div class="k">상승 기간</div><div class="v">' + (ra.days || '-') + '거래일</div>' +
          '<div class="k">평균 spike</div><div class="v">' + (ra.spikeAvgRatio != null ? fmtNum(ra.spikeAvgRatio) + '×' : '-') + '</div>' +
          '<div class="k">크게 늘어난 날</div><div class="v">' + (ra.spikeDays || 0) + '/' + (ra.days || '-') + '일</div>' +
          '<div class="k">시총 대비 누적</div><div class="v">' + fmtPct(ra.accumulatedValueRatio) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block">' +
        '<h4>③ 박스권</h4>' +
        (ba.dataLimit ? '<p style="color:#fca5a5;">' + escapeHtml(ba.dataLimit) + '</p>' : (
          '<div class="kv">' +
          '<div class="k">기간</div><div class="v">' + (ba.boxRangeDays || '-') + '일</div>' +
          '<div class="k">폭</div><div class="v">' + fmtPct(ba.boxRangePct) + '</div>' +
          '<div class="k">하단 → 상단</div><div class="v">' + (ba.boxLow != null ? ba.boxLow.toLocaleString() : '-') + ' → ' + (ba.boxHigh != null ? ba.boxHigh.toLocaleString() : '-') + '</div>' +
          '<div class="k">하단 올라감</div><div class="v">' + (ba.lowRising ? '예' : '아니오') + '</div>' +
          '<div class="k">상단 두드린 횟수</div><div class="v">' + (ba.touchedHighTimes || 0) + '회</div>' +
          '<div class="k">박스 안 거래대금 추세</div><div class="v">' + (ba.valueTrendInBox || '-') + '</div>' +
          '<div class="k">돌파일 거래대금 배수</div><div class="v">' + (ba.breakoutValueRatio != null ? fmtNum(ba.breakoutValueRatio) + '×' : '-') + '</div>' +
          '</div>'
        )) +
      '</div>' +
      '<div class="detail-block">' +
        '<h4>④ 가격 위치</h4>' +
        '<div class="kv">' +
          '<div class="k">60일 저점 대비</div><div class="v">' + fmtPct(pp.closeFromLow60) + ' 위</div>' +
          '<div class="k">120일 저점 대비</div><div class="v">' + fmtPct(pp.closeFromLow120) + ' 위</div>' +
          '<div class="k">60일 고점 대비</div><div class="v">' + fmtPct(pp.closeFromHigh60) + '</div>' +
          '<div class="k">52주 고점 대비</div><div class="v">' + fmtPct(pp.closeFrom52WeekHigh) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="detail-block">' +
        '<h4>⑤ 이평선 / 매물대</h4>' +
        '<div class="kv">' +
          '<div class="k">이평선 정렬</div><div class="v">' + (ma.arrangement || '-') + '</div>' +
          '<div class="k">종가 vs 20일선</div><div class="v">' + fmtPct(ma.closeOverMa20) + '</div>' +
          '<div class="k">종가 vs 60일선</div><div class="v">' + fmtPct(ma.closeOverMa60) + '</div>' +
          '<div class="k">위쪽 매물 부담</div><div class="v">' + fmtPct(sz.aboveCloseRatio) + '</div>' +
        '</div>' +
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
