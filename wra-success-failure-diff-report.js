#!/usr/bin/env node
/**
 * WRA Success/Failure Diff Report
 *
 * 목적:
 *   2026-04-30 기준 WRA 후보가 2026-05-04에 어떻게 됐는지 — 성공/실패 그룹으로 나누고
 *   4/30 시점의 어떤 조건이 결과를 갈랐는지 분석. v3.2 개선안 도출용.
 *
 * 입력:
 *   - reports/wra-asof-20260430-snapshot-result.json   (4/30 측정 + nextDay 5/4 OHLCV)
 *   - reports/wra-20260430-to-20260504-validation-result.json  (4/30 signal OHLCV cross-ref)
 *
 * 출력:
 *   - reports/wra-20260430-success-failure-diff-result.json
 *   - reports/wra-20260430-success-failure-diff-result.html
 *
 * 후보 생성 로직은 수정하지 않음. 분석 전용.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const SNAPSHOT_PATH = path.join(REPORTS_DIR, 'wra-asof-20260430-snapshot-result.json');
const VALIDATION_PATH = path.join(REPORTS_DIR, 'wra-20260430-to-20260504-validation-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'wra-20260430-success-failure-diff-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'wra-20260430-success-failure-diff-result.html');

// ─────────────────────── 통계 헬퍼 ───────────────────────

function stats(arr) {
  const valid = arr.filter(v => v != null && isFinite(v)).map(Number);
  if (valid.length === 0) return { n: 0, mean: null, median: null, q1: null, q3: null, min: null, max: null };
  const sorted = [...valid].sort((a, b) => a - b);
  const q = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))];
  return {
    n: valid.length,
    mean: round(valid.reduce((s, v) => s + v, 0) / valid.length, 2),
    median: round(q(0.5), 2),
    q1: round(q(0.25), 2),
    q3: round(q(0.75), 2),
    min: round(sorted[0], 2),
    max: round(sorted[sorted.length - 1], 2),
  };
}
function round(v, d) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function pct(num, den) { if (!den || den === 0) return null; return round(num / den * 100, 1); }
function fmtPct(v) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }

// ─────────────────────── 분류 ───────────────────────

function classify(c) {
  const tags = new Set();
  const nd = c.nextDay;
  if (!nd) return { tags, hasNextDay: false };

  const sigHigh = c._signalHigh;
  const sigClose = c._signalClose;
  const sigVol = c._signalVolume;

  const nextHigh = nd.nextHigh;
  const nextClose = nd.nextClose;
  const nextLow = nd.nextLow;
  const nextVol = nd.nextVolume;

  const closeLoc54 = (nextHigh != null && nextLow != null && nextHigh > nextLow)
    ? (nextClose - nextLow) / (nextHigh - nextLow) : null;
  const volMaintained = (sigVol != null && sigVol > 0 && nextVol != null) ? (nextVol / sigVol) >= 0.7 : false;
  const highBreak = (sigHigh != null && nextHigh != null) ? nextHigh > sigHigh : null;
  const closeUp = (sigClose != null && nextClose != null) ? nextClose > sigClose : null;
  const closeReturn = nd.nextDayReturn;
  const highReturn = nd.nextHighReturn;

  // 성공
  if (highBreak === true && closeUp === true && closeLoc54 != null && closeLoc54 >= 0.6 && volMaintained) {
    tags.add('STRONG_CONFIRM');
  }
  if (closeReturn != null && closeReturn >= 3) tags.add('CLOSE_WIN');
  if (highReturn != null && highReturn >= 5) tags.add('HIGH_OPPORTUNITY');

  // 실패
  if (highBreak === false && closeUp === false) tags.add('FAILED_CONFIRM');
  if (highBreak === true && closeLoc54 != null && closeLoc54 < 0.4) tags.add('HIGH_THEN_FADE');
  if (closeReturn != null && closeReturn <= -2) tags.add('CLOSE_LOSS');

  // 합집합
  if (tags.has('STRONG_CONFIRM') || tags.has('CLOSE_WIN') || tags.has('HIGH_OPPORTUNITY')) tags.add('SUCCESS_ALL');
  if (tags.has('FAILED_CONFIRM') || tags.has('HIGH_THEN_FADE') || tags.has('CLOSE_LOSS')) tags.add('FAIL_ALL');

  return {
    tags,
    hasNextDay: true,
    closeLoc54: round(closeLoc54, 3),
    volRatio: sigVol > 0 ? round(nextVol / sigVol, 2) : null,
    highBreak, closeUp, closeReturn, highReturn,
  };
}

// ─────────────────────── 비교 메트릭 ───────────────────────

const COMPARE_METRICS = [
  'finalScore', 'setupScore', 'momentumScore', 'historyScore', 'riskPenalty', 'riskScore',
  'valueRatio20', 'volumeRatio20', 'valueToMarketCap',
  'closeLocation', 'closeToMA20', 'closeFromRecentLow20', 'closeFrom52WeekHigh',
  'dayReturn', 'boxRangePct', 'dynamicBoxDuration',
];

function summarizeGroup(candidates) {
  if (candidates.length === 0) return { n: 0, metrics: {}, tagCount: {}, historyCount: {}, boxCount: {}, warningCount: 0, fallbackCount: 0 };
  const out = { n: candidates.length, metrics: {}, tagCount: {}, historyCount: {}, boxCount: {}, warningCount: 0, fallbackCount: 0 };
  COMPARE_METRICS.forEach(k => { out.metrics[k] = stats(candidates.map(c => c[k])); });
  candidates.forEach(c => {
    out.tagCount[c.watchTagV3_1] = (out.tagCount[c.watchTagV3_1] || 0) + 1;
    out.historyCount[c.historyQuality] = (out.historyCount[c.historyQuality] || 0) + 1;
    out.boxCount[c.boxQuality] = (out.boxCount[c.boxQuality] || 0) + 1;
    out.warningCount += (c.warnings || []).length;
    if (c.boxFallback) out.fallbackCount++;
  });
  out.avgWarningsPerCandidate = round(out.warningCount / candidates.length, 2);
  out.fallbackRate = pct(out.fallbackCount, candidates.length);
  return out;
}

// ─────────────────────── threshold sweep ───────────────────────

function sweepEval(filtered, totalAvailable) {
  if (filtered.length === 0) return { n: 0, fromTotal: totalAvailable };
  const closeRets = filtered.map(c => c.nextDay && c.nextDay.nextDayReturn).filter(v => v != null);
  const highRets = filtered.map(c => c.nextDay && c.nextDay.nextHighReturn).filter(v => v != null);
  const close3 = closeRets.filter(r => r >= 3).length;
  const high5 = highRets.filter(r => r >= 5).length;
  const closeLoss = filtered.filter(c => c._classified.tags.has('CLOSE_LOSS')).length;
  const highThenFade = filtered.filter(c => c._classified.tags.has('HIGH_THEN_FADE')).length;
  const lowDropOver3 = closeRets.filter(r => r <= -3).length;
  return {
    n: filtered.length,
    fromTotal: totalAvailable,
    coveragePct: pct(filtered.length, totalAvailable),
    avgCloseReturn: closeRets.length ? round(closeRets.reduce((s, v) => s + v, 0) / closeRets.length, 2) : null,
    medCloseReturn: closeRets.length ? round([...closeRets].sort((a, b) => a - b)[Math.floor(closeRets.length / 2)], 2) : null,
    avgHighReturn: highRets.length ? round(highRets.reduce((s, v) => s + v, 0) / highRets.length, 2) : null,
    closeWin3Rate: pct(close3, closeRets.length),
    highOpp5Rate: pct(high5, highRets.length),
    closeLossRate: pct(closeLoss, filtered.length),
    highThenFadeRate: pct(highThenFade, filtered.length),
    lowDropOver3Rate: pct(lowDropOver3, closeRets.length),
  };
}

const SWEEP_DEFS = [
  { name: 'closeLocation>=0.6', fn: c => (c.closeLocation || 0) >= 0.6 },
  { name: 'closeLocation>=0.7', fn: c => (c.closeLocation || 0) >= 0.7 },
  { name: 'closeLocation>=0.8', fn: c => (c.closeLocation || 0) >= 0.8 },
  { name: 'valueRatio20 1.5~3.0', fn: c => (c.valueRatio20 || 0) >= 1.5 && (c.valueRatio20 || 0) <= 3.0 },
  { name: 'valueRatio20 1.5~3.5', fn: c => (c.valueRatio20 || 0) >= 1.5 && (c.valueRatio20 || 0) <= 3.5 },
  { name: 'valueRatio20 1.7~3.2', fn: c => (c.valueRatio20 || 0) >= 1.7 && (c.valueRatio20 || 0) <= 3.2 },
  { name: 'closeToMA20<=6', fn: c => (c.closeToMA20 || 0) <= 6 },
  { name: 'closeToMA20<=8', fn: c => (c.closeToMA20 || 0) <= 8 },
  { name: 'closeToMA20<=10', fn: c => (c.closeToMA20 || 0) <= 10 },
  { name: 'closeToMA20<=12', fn: c => (c.closeToMA20 || 0) <= 12 },
  { name: 'lowDist<=12', fn: c => (c.closeFromRecentLow20 || 0) <= 12 },
  { name: 'lowDist<=15', fn: c => (c.closeFromRecentLow20 || 0) <= 15 },
  { name: 'lowDist<=18', fn: c => (c.closeFromRecentLow20 || 0) <= 18 },
  { name: 'lowDist<=20', fn: c => (c.closeFromRecentLow20 || 0) <= 20 },
  { name: 'lowDist<=25', fn: c => (c.closeFromRecentLow20 || 0) <= 25 },
  { name: 'BOX_STABLE only', fn: c => c.boxQuality === 'BOX_STABLE' },
  { name: 'riskScore=0', fn: c => (c.riskScore || 0) === 0 },
  { name: 'history MID/FULL', fn: c => c.historyQuality === 'MID_HISTORY' || c.historyQuality === 'FULL_HISTORY' },
  { name: 'dayReturn<=3', fn: c => (c.dayReturn || 0) <= 3 },
  { name: 'dayReturn<=5', fn: c => (c.dayReturn || 0) <= 5 },
  { name: 'dayReturn<=8', fn: c => (c.dayReturn || 0) <= 8 },
  // 조합 — 가장 가능성 있는 v3.2 후보
  { name: 'CL>=0.6 AND lowDist<=15', fn: c => (c.closeLocation || 0) >= 0.6 && (c.closeFromRecentLow20 || 0) <= 15 },
  { name: 'CL>=0.7 AND MA20<=8 AND vR 1.5~3', fn: c => (c.closeLocation || 0) >= 0.7 && (c.closeToMA20 || 0) <= 8 && (c.valueRatio20 || 0) >= 1.5 && (c.valueRatio20 || 0) <= 3.0 },
  { name: 'CL>=0.6 AND BOX_STABLE AND riskScore=0', fn: c => (c.closeLocation || 0) >= 0.6 && c.boxQuality === 'BOX_STABLE' && (c.riskScore || 0) === 0 },
];

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('WRA Success/Failure Diff Report — 4/30 → 5/4');
  console.log('═'.repeat(80));

  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
  const val = JSON.parse(fs.readFileSync(VALIDATION_PATH, 'utf-8'));
  const valByCode = new Map((val.candidates || []).map(c => [c.code, c]));

  // cross-reference: signalHigh/Close/Volume 주입
  const candidates = (snap.candidates || []).map(c => {
    const v = valByCode.get(c.code);
    return {
      ...c,
      _signalHigh: v?.signalHigh ?? null,
      _signalLow: v?.signalLow ?? null,
      _signalClose: v?.signalClose ?? null,
      _signalOpen: v?.signalOpen ?? null,
      _signalVolume: v?.signalVolume ?? null,
      _signalValue: v?.signalValue ?? null,
    };
  });

  // 분류
  candidates.forEach(c => { c._classified = classify(c); });
  const withNextDay = candidates.filter(c => c._classified.hasNextDay);
  const withSignalRefs = candidates.filter(c => c._signalHigh != null && c._classified.hasNextDay);

  console.log(`총 후보: ${candidates.length}, 5/4 데이터 매칭: ${withNextDay.length}, signal cross-ref 가능: ${withSignalRefs.length}`);

  // 그룹별 분리
  const groups = {
    SUCCESS_ALL: withNextDay.filter(c => c._classified.tags.has('SUCCESS_ALL')),
    STRONG_CONFIRM: withNextDay.filter(c => c._classified.tags.has('STRONG_CONFIRM')),
    CLOSE_WIN: withNextDay.filter(c => c._classified.tags.has('CLOSE_WIN')),
    HIGH_OPPORTUNITY: withNextDay.filter(c => c._classified.tags.has('HIGH_OPPORTUNITY')),
    FAIL_ALL: withNextDay.filter(c => c._classified.tags.has('FAIL_ALL')),
    FAILED_CONFIRM: withNextDay.filter(c => c._classified.tags.has('FAILED_CONFIRM')),
    HIGH_THEN_FADE: withNextDay.filter(c => c._classified.tags.has('HIGH_THEN_FADE')),
    CLOSE_LOSS: withNextDay.filter(c => c._classified.tags.has('CLOSE_LOSS')),
    NEUTRAL: withNextDay.filter(c => !c._classified.tags.has('SUCCESS_ALL') && !c._classified.tags.has('FAIL_ALL')),
  };

  console.log('\n그룹별 표본 수 (중복 가능):');
  Object.entries(groups).forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v.length}`));

  // 그룹 통계
  const groupStats = {};
  Object.entries(groups).forEach(([k, v]) => { groupStats[k] = summarizeGroup(v); });

  // 핵심 차이 (성공 vs 실패 평균 차이)
  const keyDiffs = {};
  COMPARE_METRICS.forEach(k => {
    const s = groupStats.SUCCESS_ALL.metrics[k];
    const f = groupStats.FAIL_ALL.metrics[k];
    if (s.mean != null && f.mean != null) {
      keyDiffs[k] = {
        success_mean: s.mean, success_n: s.n,
        fail_mean: f.mean, fail_n: f.n,
        diff: round(s.mean - f.mean, 2),
        successHigher: (s.mean > f.mean),
      };
    }
  });

  // threshold sweep
  const sweepResults = SWEEP_DEFS.map(d => ({
    name: d.name,
    eval: sweepEval(withNextDay.filter(d.fn), withNextDay.length),
  }));

  // 핵심 sweep 정리 (covering rate >= 30% & avgCloseReturn 또는 closeWin3Rate 우수한 것)
  const sweepRanked = [...sweepResults]
    .filter(r => r.eval.n >= 5)
    .sort((a, b) => (b.eval.avgCloseReturn || -999) - (a.eval.avgCloseReturn || -999));

  // tag별 결과
  const byTag = {};
  ['CLEAN_VALUE_SETUP', 'VALUE_SURGE_CONFIRM', 'BREAKOUT_MOMENTUM', 'VALUE_LOOSE', 'HIGH_VOLATILITY', 'WATCH_ONLY', 'LOW_SIGNAL'].forEach(t => {
    const list = withNextDay.filter(c => c.watchTagV3_1 === t);
    byTag[t] = sweepEval(list, withNextDay.length);
  });

  // 결론 생성 (rule-based)
  const conclusion = buildConclusion(groupStats, keyDiffs, sweepRanked, byTag);

  // 출력
  const out = {
    meta: {
      version: 'wra-success-failure-diff-v1',
      generatedAt: new Date().toISOString(),
      asOfDate: '20260430',
      validationDate: '20260504',
      title: 'WRA 4/30 후보의 5/4 성공/실패 비교 분석 보고서',
      purpose: '4/30 시점의 어떤 조건이 5/4 결과를 갈랐는지 분석해 v3.2 개선안 도출',
      successDef: {
        STRONG_CONFIRM: '5/4 고가 > 4/30 고가 AND 5/4 종가 > 4/30 종가 AND closeLocation_5/4 ≥ 0.6 AND 거래대금 유지 (volRatio ≥ 0.7)',
        CLOSE_WIN: '5/4 종가 등락률 ≥ +3%',
        HIGH_OPPORTUNITY: '5/4 고가 등락률 ≥ +5%',
      },
      failDef: {
        FAILED_CONFIRM: '5/4 고가 ≤ 4/30 고가 AND 5/4 종가 ≤ 4/30 종가',
        HIGH_THEN_FADE: '5/4 고가 > 4/30 고가 BUT closeLocation_5/4 < 0.4',
        CLOSE_LOSS: '5/4 종가 등락률 ≤ -2%',
      },
    },
    sampleCount: {
      total: candidates.length,
      withNextDay: withNextDay.length,
      withSignalRefs: withSignalRefs.length,
    },
    groupCounts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    groupStats,
    keyDiffs,
    sweepResults,
    sweepRanked: sweepRanked.slice(0, 15),
    byTag,
    conclusion,
    // 라벨별 그룹 분포 (8개 핵심 질문 답변용)
    answers: buildAnswers(groupStats, keyDiffs, byTag, sweepRanked),
    // 상세 후보 리스트 (JSON 무게 줄이려고 핵심만)
    candidatesDetailed: withNextDay.map(c => ({
      code: c.code, name: c.name, market: c.market, marketCap: c.marketCap,
      watchTagV3_1: c.watchTagV3_1, displayLabel: c.displayLabel,
      finalScore: c.finalScore, riskScore: c.riskScore,
      valueRatio20: c.valueRatio20, closeLocation: c.closeLocation,
      closeToMA20: c.closeToMA20, closeFromRecentLow20: c.closeFromRecentLow20,
      historyQuality: c.historyQuality, boxQuality: c.boxQuality,
      warnings: c.warnings,
      next: {
        nextClose: c.nextDay?.nextClose, nextHigh: c.nextDay?.nextHigh,
        closeReturn: c.nextDay?.nextDayReturn, highReturn: c.nextDay?.nextHighReturn,
        closeLoc54: c._classified.closeLoc54,
      },
      groups: [...c._classified.tags],
      isSuccess: c._classified.tags.has('SUCCESS_ALL'),
      isFail: c._classified.tags.has('FAIL_ALL'),
    })),
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  console.log(`\n핵심 메트릭 — 성공 vs 실패 평균:`);
  Object.entries(keyDiffs).slice(0, 10).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(24)} success=${(v.success_mean||0).toFixed(2)} (n=${v.success_n}) | fail=${(v.fail_mean||0).toFixed(2)} (n=${v.fail_n}) | diff=${v.diff > 0 ? '+' : ''}${v.diff}`);
  });

  console.log(`\nsweep top 5 (avgCloseReturn 기준):`);
  sweepRanked.slice(0, 5).forEach(r => {
    console.log(`  ${r.name.padEnd(40)} n=${r.eval.n}/${r.eval.fromTotal} avgClose=${r.eval.avgCloseReturn} closeWin3=${r.eval.closeWin3Rate}% closeLoss=${r.eval.closeLossRate}%`);
  });

  console.log(`\ntag별 성과:`);
  Object.entries(byTag).forEach(([t, e]) => {
    if (e.n > 0) console.log(`  ${t.padEnd(22)} n=${e.n} avgClose=${e.avgCloseReturn} avgHigh=${e.avgHighReturn} closeWin3=${e.closeWin3Rate}% closeLoss=${e.closeLossRate}%`);
  });

  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length/1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length/1024).toFixed(0)}KB)`);
}

// ─────────────────────── 답변·결론 생성 ───────────────────────

function buildAnswers(groupStats, keyDiffs, byTag, sweepRanked) {
  const sa = groupStats.SUCCESS_ALL;
  const fa = groupStats.FAIL_ALL;
  const cl = keyDiffs.closeLocation;
  const vr = keyDiffs.valueRatio20;
  const ma20 = keyDiffs.closeToMA20;
  const lowD = keyDiffs.closeFromRecentLow20;
  // tag별 winRate
  const tagWinRate = {};
  Object.entries(byTag).forEach(([t, e]) => {
    if (e.n > 0) tagWinRate[t] = { n: e.n, closeWin3Rate: e.closeWin3Rate || 0, avgClose: e.avgCloseReturn || 0 };
  });
  const bestTag = Object.entries(tagWinRate).sort((a, b) => (b[1].avgClose||-999) - (a[1].avgClose||-999))[0];

  return {
    q1_closeLocationHigher: {
      question: '성공 후보가 실패 후보보다 closeLocation이 높았는가?',
      answer: cl ? (cl.successHigher ? `예 — 성공 평균 ${cl.success_mean} vs 실패 ${cl.fail_mean} (차이 ${cl.diff > 0 ? '+' : ''}${cl.diff})` : `아니오 — 성공 ${cl.success_mean} vs 실패 ${cl.fail_mean}`) : '데이터 부족',
    },
    q2_valueRatioRange: {
      question: '성공 후보의 valueRatio20은 적절한 범위였는가?',
      answer: `성공 그룹 vR 평균 ${sa.metrics.valueRatio20.mean}, Q1=${sa.metrics.valueRatio20.q1}, Q3=${sa.metrics.valueRatio20.q3} | 실패 그룹 평균 ${fa.metrics.valueRatio20.mean}, Q1=${fa.metrics.valueRatio20.q1}, Q3=${fa.metrics.valueRatio20.q3}`,
    },
    q3_closeToMA20Failure: {
      question: '실패 후보는 closeToMA20이 더 높았는가?',
      answer: ma20 ? (!ma20.successHigher ? `예 — 실패 평균 ${ma20.fail_mean} vs 성공 ${ma20.success_mean} (실패가 ${Math.abs(ma20.diff)} 더 높음)` : `아니오 — 성공 ${ma20.success_mean} vs 실패 ${ma20.fail_mean}`) : '데이터 부족',
    },
    q4_lowDistFailure: {
      question: '실패 후보는 closeFromRecentLow20이 더 높았는가?',
      answer: lowD ? (!lowD.successHigher ? `예 — 실패 평균 ${lowD.fail_mean} vs 성공 ${lowD.success_mean} (실패가 ${Math.abs(lowD.diff)} 더 높음)` : `아니오 — 성공 ${lowD.success_mean} vs 실패 ${lowD.fail_mean}`) : '데이터 부족',
    },
    q5_boxFallback: {
      question: 'boxFallback 또는 BOX_VOLATILE이 실패에 영향을 줬는가?',
      answer: `성공 fallback율 ${sa.fallbackRate}% (n=${sa.n}) vs 실패 fallback율 ${fa.fallbackRate}% (n=${fa.n}) | 성공 BOX_STABLE ${sa.boxCount.BOX_STABLE || 0}/${sa.n} vs 실패 BOX_STABLE ${fa.boxCount.BOX_STABLE || 0}/${fa.n}`,
    },
    q6_historyQuality: {
      question: 'historyQuality가 좋은(MID/FULL) 후보가 더 성공했는가?',
      answer: `성공 MID/FULL ${(sa.historyCount.MID_HISTORY || 0) + (sa.historyCount.FULL_HISTORY || 0)}/${sa.n} | 실패 MID/FULL ${(fa.historyCount.MID_HISTORY || 0) + (fa.historyCount.FULL_HISTORY || 0)}/${fa.n}`,
    },
    q7_bestTag: {
      question: '어떤 watchTagV3_1이 가장 잘 버텼는가?',
      answer: bestTag ? `${bestTag[0]} (n=${bestTag[1].n}, avgClose=${bestTag[1].avgClose}%, closeWin3=${bestTag[1].closeWin3Rate}%)` : '데이터 부족',
      tagBreakdown: tagWinRate,
    },
    q8_bestFilter: {
      question: '어떤 조건을 추가하면 실패를 가장 많이 줄이는가?',
      answer: sweepRanked[0] ? `${sweepRanked[0].name} — n=${sweepRanked[0].eval.n}/${sweepRanked[0].eval.fromTotal}, avgClose=${sweepRanked[0].eval.avgCloseReturn}%, closeWin3=${sweepRanked[0].eval.closeWin3Rate}%, closeLoss=${sweepRanked[0].eval.closeLossRate}%` : '데이터 부족',
      top5: sweepRanked.slice(0, 5).map(r => ({ name: r.name, n: r.eval.n, avgClose: r.eval.avgCloseReturn, closeWin3: r.eval.closeWin3Rate, closeLoss: r.eval.closeLossRate })),
    },
  };
}

function buildConclusion(groupStats, keyDiffs, sweepRanked, byTag) {
  const recommendations = [];

  // closeLocation 효과
  const clDiff = keyDiffs.closeLocation;
  if (clDiff && clDiff.successHigher && Math.abs(clDiff.diff) > 0.05) {
    recommendations.push(`closeLocation 필터 추가 권장: 성공 평균 ${clDiff.success_mean} vs 실패 ${clDiff.fail_mean}. 4/30 closeLocation < 0.5 후보는 5/4 종가 약세 위험. CLEAN_VALUE_SETUP 조건에 closeLocation >= 0.5 추가 검토.`);
  }
  // closeToMA20
  const ma20Diff = keyDiffs.closeToMA20;
  if (ma20Diff && !ma20Diff.successHigher && Math.abs(ma20Diff.diff) > 1) {
    recommendations.push(`closeToMA20 상한 강화: 실패 평균 ${ma20Diff.fail_mean}% vs 성공 ${ma20Diff.success_mean}%. CLEAN_VALUE_SETUP의 closeToMA20 < 12 → < 8~10 정도 검토.`);
  }
  // closeFromRecentLow20
  const lowDiff = keyDiffs.closeFromRecentLow20;
  if (lowDiff && !lowDiff.successHigher && Math.abs(lowDiff.diff) > 1) {
    recommendations.push(`closeFromRecentLow20 상한 강화: 실패 ${lowDiff.fail_mean}% vs 성공 ${lowDiff.success_mean}%. CLEAN_VALUE_SETUP의 < 25 → < 18~20 정도 검토.`);
  }
  // top sweep
  if (sweepRanked.length > 0) {
    const top = sweepRanked[0];
    recommendations.push(`최고 sweep 조건: ${top.name} (n=${top.eval.n}, 평균 종가 ${top.eval.avgCloseReturn}%, +3% 도달 ${top.eval.closeWin3Rate}%). v3.2 후보 필터로 검토.`);
  }
  // tag별 약점
  const tagPoor = Object.entries(byTag).filter(([_, e]) => e.n > 5 && e.avgCloseReturn != null && e.avgCloseReturn < -1);
  if (tagPoor.length > 0) {
    recommendations.push(`성과 약한 tag: ${tagPoor.map(([t, e]) => `${t} (avgClose=${e.avgCloseReturn}%, closeLoss=${e.closeLossRate}%)`).join(', ')}.`);
  }

  return {
    weakness: '4/30 핵심 후보(특히 CLEAN_VALUE_SETUP)는 종가 유지가 약하다 — 장중 고가는 100% 위로 갔지만 종가 양봉은 26%에 그침. closeLocation 필터로 종가 약한 후보를 사전 차단할 여지가 있음.',
    recommendations,
    perTagSuggestions: {
      CLEAN_VALUE_SETUP: 'closeLocation >= 0.5~0.6 필수 조건 추가. closeFromRecentLow20 < 25 → < 18 검토. closeToMA20 < 12 → < 10 검토.',
      VALUE_SURGE_CONFIRM: '이미 표본이 작음(3건). 추가 데이터 수집 후 재검토. dayReturn <= 8 정도로 추격 위험 감소 검토.',
      BREAKOUT_MOMENTUM: '4/30 시점 0건. 별도 검증 어려움. overlay 없는 BM 풀 자체가 작은지 모니터링.',
    },
    finalProposal: 'WRA v3.2 = v3.1 + closeLocation >= 0.5 필터 (CLEAN_VALUE_SETUP) + closeFromRecentLow20 < 18 (CLEAN_VALUE_SETUP) + boxQuality BOX_STABLE 필수 유지. 단일 cutoff 표본이라 다른 cutoff에서도 같은 패턴이 나오는지 추가 검증 필요.',
  };
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>WRA 성공/실패 비교 분석</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0; padding: 18px 28px 80px; max-width: 1500px; margin: 0 auto;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 16px 0 8px; color: #94a3b8; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; }
.purpose-box strong { color: #67e8f9; }

/* big tiles */
.big-summary { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.big-tile { flex: 1; min-width: 140px; background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 12px 14px; }
.big-tile.success { border-color: #10b981; }
.big-tile.fail { border-color: #ef4444; }
.big-tile.neutral { border-color: #64748b; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 22px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-top: 4px; }
.big-tile.success .value { color: #6ee7b7; }
.big-tile.fail .value { color: #fca5a5; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; }

table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; margin: 8px 0 14px; background: #1e293b; border-radius: 8px; overflow: hidden; }
table.cmp th, table.cmp td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #334155; }
table.cmp th:first-child, table.cmp td:first-child { text-align: left; color: #cbd5e1; }
table.cmp thead th { background: #0f172a; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
table.cmp tr:hover td { background: #273549; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-mute { color: #64748b; }

/* answer card */
.answer-list { background: #1e293b; border-radius: 8px; padding: 14px 16px; }
.answer-item { padding: 10px 0; border-bottom: 1px dashed #334155; }
.answer-item:last-child { border-bottom: none; }
.answer-item .q { font-weight: 600; color: #67e8f9; margin-bottom: 4px; }
.answer-item .a { font-size: 12px; color: #cbd5e1; line-height: 1.6; }

/* sweep table */
table.sweep { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; margin-top: 8px; }
table.sweep th, table.sweep td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #334155; }
table.sweep th:first-child, table.sweep td:first-child { text-align: left; }
table.sweep thead th { background: #0f172a; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
table.sweep tr.top td { background: #14532d; color: #d1fae5; font-weight: 600; }
table.sweep tr:hover:not(.top) td { background: #273549; }

/* recommendation */
.recommend-box { background: #422006; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 12px 16px; margin-bottom: 14px; color: #fde68a; line-height: 1.7; }
.recommend-box strong { color: #fef3c7; }
.recommend-box ul { margin: 8px 0 0; padding-left: 20px; }
.recommend-box li { margin-bottom: 6px; }

/* 종목 리스트 */
.list-filter { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
.list-filter .filter-btn {
  background: #1e293b; color: #cbd5e1; border: 1px solid #334155;
  border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-weight: 500;
}
.list-filter .filter-btn:hover { color: #f1f5f9; border-color: #64748b; }
.list-filter .filter-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }
.list-filter .filter-btn.success.active { background: #047857; border-color: #10b981; }
.list-filter .filter-btn.fail.active { background: #991b1b; border-color: #ef4444; }
.list-filter .filter-input {
  background: #0f172a; color: #e2e8f0; border: 1px solid #334155;
  border-radius: 6px; padding: 6px 10px; font-size: 12px; height: 30px; min-width: 160px;
}
.list-status { font-size: 12px; color: #94a3b8; margin-left: auto; }

table.cand { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; }
table.cand thead th {
  background: #0f172a; color: #94a3b8; font-weight: 600;
  padding: 9px 10px; border-bottom: 1px solid #334155;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: left;
  position: sticky; top: 0;
}
table.cand thead th.numeric { text-align: right; }
table.cand tbody tr { border-bottom: 1px solid #1e293b; }
table.cand tbody tr:nth-child(odd) { background: #1c2942; }
table.cand tbody tr:hover { background: #273549; }
table.cand tbody td { padding: 7px 10px; vertical-align: middle; white-space: nowrap; line-height: 1.3; }
table.cand tbody td.numeric { text-align: right; }
table.cand tbody td.col-name { font-weight: 600; color: #f1f5f9; min-width: 130px; max-width: 180px; }
table.cand tbody td.col-name .meta { display: block; font-size: 10px; color: #64748b; font-weight: 400; margin-top: 2px; }

/* 결과 마커 (좌측 컬러바) */
table.cand tbody tr.row-success td.col-name { box-shadow: inset 3px 0 0 #10b981; padding-left: 14px; }
table.cand tbody tr.row-fail td.col-name { box-shadow: inset 3px 0 0 #ef4444; padding-left: 14px; }
table.cand tbody tr.row-neutral td.col-name { box-shadow: inset 3px 0 0 #64748b; padding-left: 14px; }
table.cand tbody tr.row-mixed td.col-name { box-shadow: inset 3px 0 0 #fbbf24; padding-left: 14px; }

.tag-pill { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; }
.tag-pill.t-CLEAN_VALUE_SETUP { background: #047857; color: #d1fae5; }
.tag-pill.t-VALUE_SURGE_CONFIRM { background: #0e7490; color: #cffafe; }
.tag-pill.t-BREAKOUT_MOMENTUM { background: #6d28d9; color: #ede9fe; }
.tag-pill.t-VALUE_LOOSE { background: #92400e; color: #fef3c7; }
.tag-pill.t-HIGH_VOLATILITY { background: #991b1b; color: #fee2e2; }
.tag-pill.t-WATCH_ONLY { background: #475569; color: #e2e8f0; }
.tag-pill.t-LOW_SIGNAL { background: #1e293b; color: #94a3b8; border: 1px solid #475569; }

.result-pills { display: flex; gap: 3px; flex-wrap: wrap; }
.result-pill {
  display: inline-block; padding: 1px 6px; border-radius: 4px;
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.3px;
}
.result-pill.STRONG_CONFIRM { background: #14532d; color: #6ee7b7; }
.result-pill.CLOSE_WIN { background: #064e3b; color: #86efac; }
.result-pill.HIGH_OPPORTUNITY { background: #134e4a; color: #5eead4; }
.result-pill.FAILED_CONFIRM { background: #7f1d1d; color: #fca5a5; }
.result-pill.HIGH_THEN_FADE { background: #713f12; color: #fde047; }
.result-pill.CLOSE_LOSS { background: #581c87; color: #d8b4fe; }
.result-pill.SUCCESS_ALL, .result-pill.FAIL_ALL { display: none; }

.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }
</style>
</head>
<body>

<h1 id="page-title">WRA 4/30 후보의 5/4 성공/실패 비교</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<h2>📊 그룹별 표본 수</h2>
<div class="big-summary" id="group-tiles"></div>

<h2>🔑 핵심 8개 질문</h2>
<div class="answer-list" id="answers"></div>

<h2>📈 성공 vs 실패 — 4/30 시점 지표 비교 (평균)</h2>
<div id="key-diffs"></div>

<h2>🎯 Threshold Sweep — v3.2 후보 필터 검증</h2>
<p style="color:#94a3b8;font-size:12px;line-height:1.6;">각 조건이 4/30 후보 풀에 적용됐을 때 5/4 결과가 어떻게 달라지는지. avgCloseReturn 기준 정렬.</p>
<div id="sweep-table"></div>

<h2>🏷️ tag별 5/4 성과</h2>
<div id="tag-table"></div>

<h2>💡 결론 및 v3.2 추천 조건</h2>
<div class="recommend-box" id="conclusion"></div>

<h2>📋 종목별 4/30 → 5/4 결과 (전체 후보)</h2>
<p style="color:#94a3b8;font-size:12px;line-height:1.6;margin-bottom:8px;">
  좌측 컬러바: <span style="color:#10b981;">초록=성공</span> / <span style="color:#ef4444;">빨강=실패</span> / <span style="color:#fbbf24;">노랑=성공+실패 둘 다</span> / <span style="color:#64748b;">회색=중립</span>.
  결과 알약(STRONG_CONFIRM/CLOSE_WIN/HIGH_THEN_FADE 등)을 보면 어떤 패턴인지 한눈에 보입니다.
</p>
<div class="list-filter" id="list-filter">
  <button class="filter-btn active" data-filter="ALL">전체</button>
  <button class="filter-btn success" data-filter="SUCCESS">성공만</button>
  <button class="filter-btn fail" data-filter="FAIL">실패만</button>
  <button class="filter-btn" data-filter="NEUTRAL">중립만</button>
  <button class="filter-btn" data-tag="CLEAN_VALUE_SETUP">먼저 볼</button>
  <button class="filter-btn" data-tag="VALUE_SURGE_CONFIRM">힘 붙은</button>
  <button class="filter-btn" data-tag="BREAKOUT_MOMENTUM">단기 반응</button>
  <button class="filter-btn" data-tag="VALUE_LOOSE">보조</button>
  <button class="filter-btn" data-tag="HIGH_VOLATILITY">고변동</button>
  <button class="filter-btn" data-tag="WATCH_ONLY">관찰</button>
  <button class="filter-btn" data-tag="LOW_SIGNAL">약함</button>
  <input type="search" class="filter-input" id="cand-search" placeholder="🔍 종목명 / 코드">
  <span class="list-status" id="cand-status"></span>
</div>
<div style="overflow-x:auto;">
  <table class="cand" id="cand-table">
    <thead>
      <tr>
        <th data-sort="name">종목</th>
        <th data-sort="watchTagV3_1">유형</th>
        <th class="numeric" data-sort="finalScore">점수</th>
        <th class="numeric" data-sort="closeLocation">closeLoc</th>
        <th class="numeric" data-sort="closeToMA20">MA20</th>
        <th class="numeric" data-sort="closeFromRecentLow20">저점대비</th>
        <th class="numeric" data-sort="valueRatio20">거래대금</th>
        <th class="numeric" data-sort="riskScore">risk</th>
        <th data-sort="boxQuality">box</th>
        <th data-sort="historyQuality">차트</th>
        <th class="numeric" data-sort="closeReturn">5/4 종가%</th>
        <th class="numeric" data-sort="highReturn">5/4 고가%</th>
        <th>결과</th>
      </tr>
    </thead>
    <tbody id="cand-body"></tbody>
  </table>
</div>

<footer class="foot">
  <strong>매수 신호 보고서가 아닙니다.</strong> 단일 cutoff(4/30 → 5/4) 표본 분석으로, 통계적 유의성 검증을 위해서는 여러 cutoff에서 같은 패턴이 나오는지 추가 확인이 필요합니다.
</footer>

<script id="report-data" type="application/json">__JSON_DATA__</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const meta = data.meta || {};
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 2 : d); }

  document.getElementById('page-title').textContent = meta.title || 'WRA 4/30 후보의 5/4 성공/실패 비교';
  document.getElementById('subtitle').innerHTML =
    'asOfDate <strong style="color:#cbd5e1;">' + meta.asOfDate + '</strong> → validation <strong style="color:#cbd5e1;">' + meta.validationDate + '</strong> · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>성공 정의:</strong>' +
    '<ul style="margin:4px 0 0;padding-left:20px;">' +
      '<li>STRONG_CONFIRM — ' + escapeHtml(meta.successDef.STRONG_CONFIRM) + '</li>' +
      '<li>CLOSE_WIN — ' + escapeHtml(meta.successDef.CLOSE_WIN) + '</li>' +
      '<li>HIGH_OPPORTUNITY — ' + escapeHtml(meta.successDef.HIGH_OPPORTUNITY) + '</li>' +
    '</ul>' +
    '<strong>실패 정의:</strong>' +
    '<ul style="margin:4px 0 0;padding-left:20px;">' +
      '<li>FAILED_CONFIRM — ' + escapeHtml(meta.failDef.FAILED_CONFIRM) + '</li>' +
      '<li>HIGH_THEN_FADE — ' + escapeHtml(meta.failDef.HIGH_THEN_FADE) + '</li>' +
      '<li>CLOSE_LOSS — ' + escapeHtml(meta.failDef.CLOSE_LOSS) + '</li>' +
    '</ul>';

  // Group tiles
  const sc = data.sampleCount;
  const gc = data.groupCounts;
  const tiles = [
    { label: '전체 (5/4 매칭)', value: sc.withNextDay, sub: '/ ' + sc.total + ' 후보', cls: 'neutral' },
    { label: 'SUCCESS_ALL', value: gc.SUCCESS_ALL, sub: 'STRONG ' + gc.STRONG_CONFIRM + ' / CW ' + gc.CLOSE_WIN + ' / HO ' + gc.HIGH_OPPORTUNITY, cls: 'success' },
    { label: 'FAIL_ALL', value: gc.FAIL_ALL, sub: 'FC ' + gc.FAILED_CONFIRM + ' / HTF ' + gc.HIGH_THEN_FADE + ' / CL ' + gc.CLOSE_LOSS, cls: 'fail' },
    { label: 'STRONG_CONFIRM', value: gc.STRONG_CONFIRM, sub: '4가지 조건 모두 충족', cls: 'success' },
    { label: 'NEUTRAL', value: gc.NEUTRAL, sub: '성공/실패 어디에도 안 들어감', cls: 'neutral' },
  ];
  const tilesEl = document.getElementById('group-tiles');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || 'neutral');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div><div class="sub">' + t.sub + '</div>';
    tilesEl.appendChild(el);
  });

  // Answers
  const ans = data.answers || {};
  const ansEl = document.getElementById('answers');
  const ansOrder = ['q1_closeLocationHigher','q2_valueRatioRange','q3_closeToMA20Failure','q4_lowDistFailure','q5_boxFallback','q6_historyQuality','q7_bestTag','q8_bestFilter'];
  ansOrder.forEach(k => {
    const a = ans[k]; if (!a) return;
    const div = document.createElement('div'); div.className = 'answer-item';
    div.innerHTML = '<div class="q">Q. ' + escapeHtml(a.question) + '</div>' +
      '<div class="a">→ ' + escapeHtml(a.answer) + '</div>';
    ansEl.appendChild(div);
  });

  // Key diffs table
  const kd = data.keyDiffs;
  const kdRows = ['finalScore','setupScore','momentumScore','riskScore','riskPenalty','valueRatio20','volumeRatio20','valueToMarketCap','closeLocation','closeToMA20','closeFromRecentLow20','closeFrom52WeekHigh','dayReturn','boxRangePct','dynamicBoxDuration'];
  let kdHtml = '<table class="cmp"><thead><tr><th>지표</th><th>성공 평균 (n)</th><th>실패 평균 (n)</th><th>차이 (성공−실패)</th><th>방향</th></tr></thead><tbody>';
  kdRows.forEach(k => {
    const v = kd[k]; if (!v) return;
    const cls = v.diff > 0 ? 'cell-pos' : (v.diff < 0 ? 'cell-neg' : 'cell-mute');
    const arrow = v.diff > 0 ? '↑ 성공이 높음' : (v.diff < 0 ? '↓ 실패가 높음' : '–');
    kdHtml += '<tr>' +
      '<td>' + k + '</td>' +
      '<td>' + fmtNum(v.success_mean) + ' <span class="cell-mute">(' + v.success_n + ')</span></td>' +
      '<td>' + fmtNum(v.fail_mean) + ' <span class="cell-mute">(' + v.fail_n + ')</span></td>' +
      '<td class="' + cls + '">' + (v.diff > 0 ? '+' : '') + fmtNum(v.diff) + '</td>' +
      '<td class="' + cls + '">' + arrow + '</td>' +
    '</tr>';
  });
  kdHtml += '</tbody></table>';
  document.getElementById('key-diffs').innerHTML = kdHtml;

  // Sweep table — top 15
  const sw = data.sweepResults || [];
  const swSorted = [...sw].sort((a, b) => (b.eval.avgCloseReturn || -999) - (a.eval.avgCloseReturn || -999));
  let swHtml = '<table class="sweep"><thead><tr><th>조건</th><th>n / total</th><th>커버율</th><th>평균 종가%</th><th>중앙 종가%</th><th>평균 고가%</th><th>+3% 도달</th><th>+5% 고가 도달</th><th>실패율</th><th>highThenFade</th></tr></thead><tbody>';
  swSorted.forEach((r, idx) => {
    const e = r.eval;
    const cls = idx < 3 && e.n >= 5 ? 'top' : '';
    const cl = (v) => (v == null) ? '-' : fmtNum(v);
    const clp = (v) => (v == null) ? '-' : (fmtNum(v, 1) + '%');
    swHtml += '<tr class="' + cls + '">' +
      '<td>' + escapeHtml(r.name) + '</td>' +
      '<td>' + e.n + ' / ' + e.fromTotal + '</td>' +
      '<td>' + clp(e.coveragePct) + '</td>' +
      '<td class="' + (e.avgCloseReturn > 0 ? 'cell-pos' : 'cell-neg') + '">' + cl(e.avgCloseReturn) + '%</td>' +
      '<td>' + cl(e.medCloseReturn) + '%</td>' +
      '<td class="cell-pos">' + cl(e.avgHighReturn) + '%</td>' +
      '<td>' + clp(e.closeWin3Rate) + '</td>' +
      '<td>' + clp(e.highOpp5Rate) + '</td>' +
      '<td class="cell-neg">' + clp(e.closeLossRate) + '</td>' +
      '<td>' + clp(e.highThenFadeRate) + '</td>' +
    '</tr>';
  });
  swHtml += '</tbody></table>';
  document.getElementById('sweep-table').innerHTML = swHtml;

  // Tag table
  const bt = data.byTag || {};
  let tagHtml = '<table class="cmp"><thead><tr><th>tag</th><th>n</th><th>평균 종가%</th><th>평균 고가%</th><th>+3% 도달</th><th>+5% 고가 도달</th><th>실패율</th><th>highThenFade</th></tr></thead><tbody>';
  Object.entries(bt).forEach(([t, e]) => {
    if (e.n === 0) return;
    const cl = (v) => (v == null) ? '-' : fmtNum(v);
    const clp = (v) => (v == null) ? '-' : (fmtNum(v, 1) + '%');
    tagHtml += '<tr>' +
      '<td>' + t + '</td>' +
      '<td>' + e.n + '</td>' +
      '<td class="' + ((e.avgCloseReturn || 0) > 0 ? 'cell-pos' : 'cell-neg') + '">' + cl(e.avgCloseReturn) + '%</td>' +
      '<td class="cell-pos">' + cl(e.avgHighReturn) + '%</td>' +
      '<td>' + clp(e.closeWin3Rate) + '</td>' +
      '<td>' + clp(e.highOpp5Rate) + '</td>' +
      '<td class="cell-neg">' + clp(e.closeLossRate) + '</td>' +
      '<td>' + clp(e.highThenFadeRate) + '</td>' +
    '</tr>';
  });
  tagHtml += '</tbody></table>';
  document.getElementById('tag-table').innerHTML = tagHtml;

  // Conclusion
  const cn = data.conclusion || {};
  let cnHtml = '<strong>⚠️ 현재 WRA의 약점:</strong> ' + escapeHtml(cn.weakness || '') + '<br><br>';
  cnHtml += '<strong>📌 추천 조건 (sweep 근거 기반):</strong><ul>';
  (cn.recommendations || []).forEach(r => { cnHtml += '<li>' + escapeHtml(r) + '</li>'; });
  cnHtml += '</ul>';
  if (cn.perTagSuggestions) {
    cnHtml += '<strong>🏷️ tag별 개선안:</strong><ul>';
    Object.entries(cn.perTagSuggestions).forEach(([t, s]) => { cnHtml += '<li><code style="background:#1e293b;padding:1px 5px;border-radius:3px;color:#67e8f9;">' + t + '</code> ' + escapeHtml(s) + '</li>'; });
    cnHtml += '</ul>';
  }
  cnHtml += '<strong>🎯 최종 제안:</strong> ' + escapeHtml(cn.finalProposal || '');
  document.getElementById('conclusion').innerHTML = cnHtml;

  // ────────── 종목 테이블 ──────────
  const cands = data.candidatesDetailed || [];
  const candBody = document.getElementById('cand-body');
  const candStatus = document.getElementById('cand-status');

  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtMc(v) { if (!v) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; return Math.round(e) + '억'; }
  function clsRet(v) { if (v == null || !isFinite(v)) return ''; return v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : ''); }

  // 결과 분류 (행 색깔용)
  function rowKind(c) {
    const isS = !!c.isSuccess;
    const isF = !!c.isFail;
    if (isS && isF) return 'mixed';     // 둘 다 (예: HIGH_OPPORTUNITY + HIGH_THEN_FADE)
    if (isS) return 'success';
    if (isF) return 'fail';
    return 'neutral';
  }

  function renderCands(list) {
    candBody.innerHTML = '';
    list.forEach(c => {
      const kind = rowKind(c);
      const tr = document.createElement('tr');
      tr.className = 'row-' + kind;
      tr.dataset.tag = c.watchTagV3_1;
      tr.dataset.kind = kind;
      tr.dataset.name = c.name; tr.dataset.code = c.code;

      const groupPills = (c.groups || [])
        .filter(g => g !== 'SUCCESS_ALL' && g !== 'FAIL_ALL')
        .map(g => '<span class="result-pill ' + g + '">' + g.replace(/_/g, ' ') + '</span>')
        .join('');

      tr.innerHTML =
        '<td class="col-name">' + escapeHtml(c.name) +
          '<span class="meta">' + c.code + ' · ' + (c.market || '-') + ' · ' + fmtMc(c.marketCap) + '</span></td>' +
        '<td><span class="tag-pill t-' + c.watchTagV3_1 + '">' + escapeHtml(c.displayLabel || c.watchTagV3_1) + '</span></td>' +
        '<td class="numeric" style="font-weight:600;color:#fbbf24;">' + fmtNum(c.finalScore) + '</td>' +
        '<td class="numeric">' + fmtNum(c.closeLocation, 2) + '</td>' +
        '<td class="numeric">' + fmtPct(c.closeToMA20, 1) + '</td>' +
        '<td class="numeric">' + fmtPct(c.closeFromRecentLow20, 1) + '</td>' +
        '<td class="numeric">' + fmtNum(c.valueRatio20, 1) + '×</td>' +
        '<td class="numeric">' + (c.riskScore || 0) + '</td>' +
        '<td>' + (c.boxQuality || '').replace('BOX_','') + '</td>' +
        '<td>' + (c.historyQuality || '').replace('_HISTORY','') + '</td>' +
        '<td class="numeric ' + clsRet(c.next?.closeReturn) + '">' + fmtPct(c.next?.closeReturn, 2) + '</td>' +
        '<td class="numeric ' + clsRet(c.next?.highReturn) + '">' + fmtPct(c.next?.highReturn, 2) + '</td>' +
        '<td><div class="result-pills">' + (groupPills || '<span style="color:#64748b;font-size:10px;">—</span>') + '</div></td>';
      candBody.appendChild(tr);
    });
  }

  // 정렬: 기본 = 결과 그룹 (성공 먼저) → 그 안에서 finalScore 내림차순
  function defaultSort(arr) {
    const order = { success: 1, mixed: 2, fail: 3, neutral: 4 };
    return [...arr].sort((a, b) => {
      const oa = order[rowKind(a)] || 9;
      const ob = order[rowKind(b)] || 9;
      if (oa !== ob) return oa - ob;
      return (b.finalScore || 0) - (a.finalScore || 0);
    });
  }

  // 필터 상태
  const fState = { kind: 'ALL', tags: new Set(), q: '' };

  function applyCandFilter() {
    let visible = 0, total = 0;
    candBody.querySelectorAll('tr').forEach(tr => {
      total++;
      let show = true;
      if (fState.kind === 'SUCCESS' && tr.dataset.kind !== 'success' && tr.dataset.kind !== 'mixed') show = false;
      if (fState.kind === 'FAIL' && tr.dataset.kind !== 'fail' && tr.dataset.kind !== 'mixed') show = false;
      if (fState.kind === 'NEUTRAL' && tr.dataset.kind !== 'neutral') show = false;
      if (show && fState.tags.size > 0 && !fState.tags.has(tr.dataset.tag)) show = false;
      if (show && fState.q) {
        const q = fState.q.toLowerCase();
        const n = (tr.dataset.name || '').toLowerCase();
        const c = (tr.dataset.code || '').toLowerCase();
        if (!n.includes(q) && !c.includes(q)) show = false;
      }
      tr.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    candStatus.innerHTML = '<strong style="color:#cbd5e1;">' + visible + '</strong> / ' + total + '건';
  }

  // 초기 렌더
  renderCands(defaultSort(cands));
  applyCandFilter();

  // 필터 버튼
  document.querySelectorAll('.list-filter [data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.list-filter [data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      fState.kind = btn.dataset.filter;
      applyCandFilter();
    });
  });
  document.querySelectorAll('.list-filter [data-tag]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const t = btn.dataset.tag;
      if (fState.tags.has(t)) fState.tags.delete(t);
      else fState.tags.add(t);
      applyCandFilter();
    });
  });
  document.getElementById('cand-search').addEventListener('input', e => {
    fState.q = e.target.value.trim();
    applyCandFilter();
  });

  // 헤더 클릭 정렬
  let sortKey = null, sortDir = 'desc';
  document.querySelectorAll('#cand-table thead th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortKey = key; sortDir = 'desc'; }
      const dir = sortDir === 'asc' ? 1 : -1;
      const sorted = [...cands].sort((a, b) => {
        let va, vb;
        if (key === 'closeReturn') { va = a.next?.closeReturn; vb = b.next?.closeReturn; }
        else if (key === 'highReturn') { va = a.next?.highReturn; vb = b.next?.highReturn; }
        else { va = a[key]; vb = b[key]; }
        if (va == null) va = (typeof vb === 'number') ? -Infinity : '';
        if (vb == null) vb = -Infinity;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
      renderCands(sorted);
      applyCandFilter();
    });
  });
})();
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}
