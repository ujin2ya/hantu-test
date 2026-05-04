#!/usr/bin/env node
/**
 * WRA 현재 유사도 보고서 v2 (Current Similarity Report v2)
 *
 * v1 → v2 개선:
 *   1. watchTag 6단계 세분화 (CORE_A/CORE_B/SURGE_WATCH/EARLY_WATCH/BREAKOUT_CHASE/CHASE_RISK)
 *   2. 다양한 랭킹 (priority/score/lowRisk/category별)
 *   3. historyQuality별 랭킹 (FULL/MID vs SHORT)
 *   4. candidate에 boolean 플래그 + rank 필드 추가
 *   5. 정렬: watchTagV2 → riskScore↑ → totalScore↓ → history → marketCap
 *   6. v1 결과와 비교 summary
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json
 *   - reports/wra-winner-reverse-audit-v2-result.json (baseline 참조)
 *   - reports/wra-current-similarity-report.json (v1 비교용, 있으면)
 *
 * 출력:
 *   - reports/wra-current-similarity-report-v2.json
 *
 * 매수 신호 아님. 구조 유사도 보고서. 미래 데이터 사용 안 함.
 */

const fs = require('fs');
const path = require('path');
const wra = require('./wra-winner-reverse-audit');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');
const WRA_BASELINE_FILE = path.join(REPORTS_DIR, 'wra-winner-reverse-audit-v2-result.json');
const V1_RESULT_FILE = path.join(REPORTS_DIR, 'wra-current-similarity-report.json');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
})();

const CONFIG = {
  MIN_MARKET_CAP: parseInt(args['min-mc'] || '300') * 100_000_000,
  MIN_HISTORY: 60,
  STALE_DAYS: 7,
  TOPLIST_SIZE: 30,
  RISK_THRESHOLD: 20,                 // riskScore >= 20 → 위험
  WARNING_THRESHOLD_FOR_RISK: 2,      // 과열 warning ≥ 2개 → CHASE_RISK
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcluded(name) { return name && EXCLUDE_KEYWORDS.some(k => name.includes(k)); }

// ─────────────────────── 공용 헬퍼 (v1과 동일) ───────────────────────

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function mapRange(v, lo, hi) {
  if (v == null || !Number.isFinite(v)) return 0;
  if (hi === lo) return 0.5;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

function evaluateLabels(m) {
  const labels = [];
  if (!m) return labels;
  if (((m.valueRatio20 || 0) >= 1.3 || (m.volumeRatio20 || 0) >= 1.3)
      && (m.closeToMA20 ?? -Infinity) >= -3
      && (m.closeLocation || 0) >= 0.5) labels.push('BMS_EARLY');
  if ((m.valueRatio20 || 0) >= 1.5 && (m.volumeRatio20 || 0) >= 1.3
      && (m.closeLocation || 0) >= 0.5 && (m.valueToMarketCap || 0) >= 0.003) labels.push('BMS_VALUE');
  if ((m.dayReturn || 0) >= 5 && (m.closeLocation || 0) >= 0.7
      && (m.valueRatio20 || 0) >= 1.3 && (m.closeToMA20 || 0) > 0) labels.push('BMS_SURGE');
  if (m.boxUpperBreak === true && (m.valueRatio20 || 0) >= 1.3 && (m.closeLocation || 0) >= 0.6) labels.push('BMS_BREAKOUT');
  return labels;
}

function computeScores(m, prep, hasBmsValue) {
  if (!m) return { traceScore: 0, confirmScore: 0, structureScore: 0, riskScore: 0, totalScore: 0, warnings: [] };
  const trace =
      mapRange(m.valueRatio20, 1.0, 3.0) * 5
    + mapRange(m.volumeRatio20, 1.0, 3.0) * 5
    + mapRange(m.closeToMA20, -10, 10) * 5
    + mapRange(m.closeLocation, 0, 1) * 5
    + mapRange(m.closeFromRecentLow20, 0, 30) * 5;
  const confirm =
      mapRange(m.valueToMarketCap, 0, 0.05) * 5
    + mapRange(m.valueRatio20, 1.5, 4.0) * 5
    + mapRange(m.volumeRatio20, 1.3, 3.5) * 5
    + mapRange(m.closeLocation, 0.5, 1.0) * 5
    + mapRange(m.supportRatio, 0, 0.5) * 5;
  const structure =
      mapRange(m.dynamicBoxDuration, 20, 80) * 5
    + (1 - mapRange(m.boxRangePct || 30, 0, 50)) * 5
    + (1 - mapRange(m.overheadRatio, 0, 0.6)) * 5
    + mapRange(m.supportRatio, 0, 0.5) * 5
    + (prep?.lowsRising ? 5 : 0)
    + (prep?.closeAboveMa20 === true ? 5 : 0)
    + (prep?.closeAboveMa60 === true ? 5 : 0);
  let risk = 0;
  const warnings = [];
  if ((m.closeFromRecentLow20 || 0) > 40) { risk += 10; warnings.push('20일 저점 +40% 이상 (추격)'); }
  if ((m.closeToMA20 || 0) > 20) { risk += 10; warnings.push('MA20 +20% 이상 (이격 큼)'); }
  if ((m.closeFrom52WeekHigh || -100) > 0) { risk += 10; warnings.push('52w 고점 돌파 (이미 신고가)'); }
  if ((m.dayReturn || 0) > 15) { risk += 10; warnings.push('당일 +15% 이상 (단기 과열)'); }
  if (m.boxUpperBreak === true && !hasBmsValue) { risk += 10; warnings.push('돌파만 있고 거래대금 확정 부족'); }
  if (m.boxFallback === true) { risk += 3; warnings.push('박스 fallback (변동성 큼)'); }
  const total = trace + confirm + structure - risk;
  return {
    traceScore: Math.round(trace * 10) / 10,
    confirmScore: Math.round(confirm * 10) / 10,
    structureScore: Math.round(structure * 10) / 10,
    riskScore: Math.round(risk * 10) / 10,
    totalScore: Math.round(total * 10) / 10,
    warnings,
  };
}

function historyQuality(chartLen) {
  if (chartLen >= 250) return 'FULL_HISTORY';
  if (chartLen >= 120) return 'MID_HISTORY';
  if (chartLen >= 60) return 'SHORT_HISTORY';
  return 'INSUFFICIENT';
}
const HISTORY_RANK = { FULL_HISTORY: 1, MID_HISTORY: 2, SHORT_HISTORY: 3, INSUFFICIENT: 4 };

function boxQuality(m, prep) {
  const fb = m?.boxFallback === true;
  const range = m?.boxRangePct || prep?.boxRangePct || 0;
  if (!fb && range <= 25) return 'BOX_STABLE';
  if (fb && range <= 40) return 'BOX_VOLATILE';
  if (fb && range > 40) return 'BOX_UNSTABLE';
  return range <= 40 ? 'BOX_VOLATILE' : 'BOX_UNSTABLE';
}

// ─────────────────────── watchTagV2 (6단계) ───────────────────────
//
// 우선순위 적용. 한 종목은 하나의 watchTagV2만 가짐.
// 1. CORE_A: BMS_VALUE && BMS_SURGE && risk<20
// 2. CORE_B: BMS_VALUE && risk<20 (CORE_A 아님)
// 3. SURGE_WATCH: BMS_SURGE && risk<20 (CORE_A/B 아님)
// 4. EARLY_WATCH: BMS_EARLY only && risk<20
// 5. BREAKOUT_CHASE: BMS_BREAKOUT만 있거나 risk≥20 (위 4개 아님)
// 6. CHASE_RISK: risk≥20 + 과열 warning ≥2 (또는 위 5개 어느 것도 아님)
const WATCH_TAG_RANK = {
  CORE_A: 1, CORE_B: 2, SURGE_WATCH: 3, EARLY_WATCH: 4, BREAKOUT_CHASE: 5, CHASE_RISK: 6,
};

function watchTagV2(labels, riskScore, warnings) {
  const has = (k) => labels.includes(k);
  const lowRisk = riskScore < CONFIG.RISK_THRESHOLD;
  const overheatedWarnings = (warnings || []).filter(w =>
    w.includes('추격') || w.includes('이격') || w.includes('신고가') || w.includes('과열')
  ).length;
  const highRisk = riskScore >= CONFIG.RISK_THRESHOLD;
  const heavyOverheat = overheatedWarnings >= CONFIG.WARNING_THRESHOLD_FOR_RISK;

  if (heavyOverheat || (highRisk && (overheatedWarnings >= 1))) {
    // 위험이 명확히 우세 — 다른 좋은 라벨이 있어도 CHASE_RISK 또는 BREAKOUT_CHASE 강등
    if (has('BMS_BREAKOUT')) return 'BREAKOUT_CHASE';
    return 'CHASE_RISK';
  }
  if (has('BMS_VALUE') && has('BMS_SURGE') && lowRisk) return 'CORE_A';
  if (has('BMS_VALUE') && lowRisk) return 'CORE_B';
  if (has('BMS_SURGE') && lowRisk) return 'SURGE_WATCH';
  if (has('BMS_EARLY') && lowRisk) return 'EARLY_WATCH';
  if (has('BMS_BREAKOUT') || highRisk) return 'BREAKOUT_CHASE';
  return 'CHASE_RISK';
}

// ─────────────────────── 측정 (v1과 동일) ───────────────────────

function measureLatest(rows, code, marketCap) {
  if (rows.length < CONFIG.MIN_HISTORY) return null;
  const indi = wra.precomputeIndicators(rows);
  const idx = rows.length - 1;
  const today = rows[idx];
  const prev = rows[idx - 1];
  if (!today || !prev) return null;

  const measurements = wra.measureT0(rows, indi, idx, marketCap, idx);
  if (!measurements) return null;
  const t0Detail = wra.analyzeT0(rows, indi, idx, marketCap);
  if (!t0Detail) return null;
  const prep = wra.analyzePreparation(rows, indi, idx, marketCap);

  return {
    idx, date: today.date, close: today.close, prevClose: prev.close,
    dayReturn: t0Detail.dayReturn,
    valueRatio20: measurements.valueRatio20,
    volumeRatio20: measurements.volumeRatio20,
    valueToMarketCap: measurements.valueToMarketCap,
    closeLocation: measurements.closeLocation,
    closeToMA5: measurements.closeToMA5,
    closeToMA20: measurements.closeToMA20,
    closeToMA60: measurements.closeToMA60,
    closeToMA120: measurements.closeToMA120,
    closeFrom52WeekHigh: measurements.closeFrom52WeekHigh,
    closeFromRecentLow20: measurements.closeFromRecentLow20,
    closeFromRecentHigh20: measurements.closeFromRecentHigh20,
    boxRangePct: measurements.boxRangePct,
    dynamicBoxDuration: measurements.dynamicBoxDuration,
    boxFallback: measurements.boxFallback,
    overheadRatio: measurements.overheadRatio,
    supportRatio: measurements.supportRatio,
    boxUpper: t0Detail.boxUpper,
    boxUpperBreak: t0Detail.boxUpperBreak,
    chartLen: rows.length,
    prep,
  };
}

// ─────────────────────── 정렬 ───────────────────────

function sortV2(candidates) {
  return candidates.sort((a, b) => {
    // 1순위: watchTagV2 우선순위
    const ra = WATCH_TAG_RANK[a.watchTagV2] || 99;
    const rb = WATCH_TAG_RANK[b.watchTagV2] || 99;
    if (ra !== rb) return ra - rb;
    // 2순위: riskScore 낮은 순
    if (a.riskScore !== b.riskScore) return a.riskScore - b.riskScore;
    // 3순위: totalScore 높은 순
    if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
    // 4순위: historyQuality (FULL > MID > SHORT)
    const ha = HISTORY_RANK[a.historyQuality] || 99;
    const hb = HISTORY_RANK[b.historyQuality] || 99;
    if (ha !== hb) return ha - hb;
    // 5순위: marketCap 큰 순
    return (b.marketCap || 0) - (a.marketCap || 0);
  });
}

// ─────────────────────── 메인 ───────────────────────

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d||'-'); }

function main() {
  console.log('═'.repeat(80));
  console.log('WRA 현재 유사도 보고서 v2');
  console.log('═'.repeat(80));
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  let baseline = null, v1Result = null;
  if (fs.existsSync(WRA_BASELINE_FILE)) {
    try { baseline = JSON.parse(fs.readFileSync(WRA_BASELINE_FILE, 'utf-8')); } catch (_) {}
  }
  if (fs.existsSync(V1_RESULT_FILE)) {
    try { v1Result = JSON.parse(fs.readFileSync(V1_RESULT_FILE, 'utf-8')); } catch (_) {}
  }
  if (baseline) console.log(`baseline 로드: WRA v2 (${baseline.meta?.successSamples} 성공 샘플)`);
  if (v1Result) console.log(`v1 결과 로드: 후보 ${v1Result.summary?.candidatesCount}개`);
  else console.log('⚠ v1 결과 없음 — 비교 생략');

  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`\n차트 ${files.length}개 처리 시작...`);

  const lastDateCount = {};
  const candidates = [];
  let processed = 0;
  const startTime = Date.now();

  files.forEach((file, idx) => {
    const code = file.replace('.json', '');
    const meta = stockMap[code];
    if (!meta) return;
    if (isExcluded(meta.name)) return;
    if (meta.isSpecial) return;
    const marketCap = meta.marketValue || 0;
    if (marketCap < CONFIG.MIN_MARKET_CAP) return;

    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8')); } catch (_) { return; }
    const rows = chart.rows || [];
    if (rows.length < CONFIG.MIN_HISTORY) return;

    const lastRowDate = rows[rows.length - 1].date;
    lastDateCount[lastRowDate] = (lastDateCount[lastRowDate] || 0) + 1;

    const m = measureLatest(rows, code, marketCap);
    if (!m) return;

    const labels = evaluateLabels(m);
    if (labels.length === 0) { processed++; return; }

    const hasBmsValue = labels.includes('BMS_VALUE');
    const scores = computeScores(m, m.prep, hasBmsValue);
    const tagV2 = watchTagV2(labels, scores.riskScore, scores.warnings);

    candidates.push({
      code,
      name: meta.name,
      market: meta.market,
      marketCap,
      date: m.date,
      labels,
      watchTagV2: tagV2,
      historyQuality: historyQuality(m.chartLen),
      boxQuality: boxQuality(m, m.prep),
      ...scores,
      // boolean 플래그
      isCoreA: tagV2 === 'CORE_A',
      isCoreB: tagV2 === 'CORE_B',
      isLowRisk: scores.riskScore < CONFIG.RISK_THRESHOLD,
      isHighRisk: scores.riskScore >= CONFIG.RISK_THRESHOLD,
      isValueSurge: labels.includes('BMS_VALUE') && labels.includes('BMS_SURGE'),
      isValueOnly: labels.includes('BMS_VALUE') && !labels.includes('BMS_SURGE'),
      isSurgeOnly: labels.includes('BMS_SURGE') && !labels.includes('BMS_VALUE'),
      isBreakoutOnly: labels.includes('BMS_BREAKOUT') && !labels.includes('BMS_VALUE') && !labels.includes('BMS_SURGE') && !labels.includes('BMS_EARLY'),
      metrics: {
        valueRatio20: m.valueRatio20,
        volumeRatio20: m.volumeRatio20,
        valueToMarketCap: m.valueToMarketCap,
        closeLocation: m.closeLocation,
        closeToMA5: m.closeToMA5,
        closeToMA20: m.closeToMA20,
        closeToMA60: m.closeToMA60,
        closeFrom52WeekHigh: m.closeFrom52WeekHigh,
        closeFromRecentLow20: m.closeFromRecentLow20,
        closeFromRecentHigh20: m.closeFromRecentHigh20,
        dayReturn: m.dayReturn,
        boxRangePct: m.boxRangePct,
        dynamicBoxDuration: m.dynamicBoxDuration,
        boxFallback: m.boxFallback,
        overheadRatio: m.overheadRatio,
        supportRatio: m.supportRatio,
      },
      warnings: scores.warnings,
    });
    processed++;

    if ((idx + 1) % 1000 === 0) {
      const e = (Date.now() - startTime) / 1000;
      process.stdout.write(`\r${idx + 1}/${files.length} 후보=${candidates.length} ${e.toFixed(0)}s`);
    }
  });
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n분석 완료: 처리 ${processed}개, 후보 ${candidates.length}개, ${elapsed.toFixed(0)}초`);

  // latestDate (mode)
  const sortedDates = Object.entries(lastDateCount).sort(([, a], [, b]) => b - a);
  const latestDate = sortedDates[0]?.[0] || '00000000';
  const cutDate = (() => {
    const y = parseInt(latestDate.slice(0,4)), mo = parseInt(latestDate.slice(4,6))-1, d = parseInt(latestDate.slice(6,8));
    const dt = new Date(y, mo, d); dt.setDate(dt.getDate() - CONFIG.STALE_DAYS);
    return `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}`;
  })();
  let stale = 0;
  const filtered = candidates.filter(c => {
    if (c.date < cutDate) { stale++; return false; }
    return true;
  });

  // 정렬 (기본 candidates) — watchTagV2 → riskScore↑ → totalScore↓ → history → marketCap
  sortV2(filtered);

  // 다양한 랭킹
  const N = CONFIG.TOPLIST_SIZE;

  const topByPriority = filtered.slice(0, N);

  const topByScore = [...filtered]
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
    .slice(0, N);

  const topByLowRisk = [...filtered]
    .filter(c => c.isLowRisk)
    .sort((a, b) => {
      if (a.riskScore !== b.riskScore) return a.riskScore - b.riskScore;
      return (b.totalScore || 0) - (a.totalScore || 0);
    })
    .slice(0, N);

  const topCoreA = filtered.filter(c => c.isCoreA).slice(0, N);          // already sorted by V2
  const topCoreB = filtered.filter(c => c.isCoreB).slice(0, N);

  const topValueSurge = [...filtered]
    .filter(c => c.isValueSurge && c.isLowRisk)
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
    .slice(0, N);

  const topValueOnly = [...filtered]
    .filter(c => c.isValueOnly && c.isLowRisk)
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
    .slice(0, N);

  const topSurgeOnly = [...filtered]
    .filter(c => c.isSurgeOnly && c.isLowRisk)
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
    .slice(0, N);

  const topBreakoutRisk = [...filtered]
    .filter(c => c.labels.includes('BMS_BREAKOUT') || c.isHighRisk)
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
    .slice(0, N);

  const topMidFullHistory = [...filtered]
    .filter(c => (c.historyQuality === 'MID_HISTORY' || c.historyQuality === 'FULL_HISTORY') && c.isLowRisk)
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
    .slice(0, N);

  const topShortHistory = [...filtered]
    .filter(c => c.historyQuality === 'SHORT_HISTORY' && c.isLowRisk)
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
    .slice(0, N);

  // priorityRank/scoreRank/riskRank 부여
  const scoreOrder = [...filtered].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
  const riskOrder = [...filtered].sort((a, b) => a.riskScore - b.riskScore);
  filtered.forEach((c, i) => { c.priorityRank = i + 1; });
  scoreOrder.forEach((c, i) => { c.scoreRank = i + 1; });
  riskOrder.forEach((c, i) => { c.riskRank = i + 1; });

  // 요약
  const watchCount = { CORE_A: 0, CORE_B: 0, SURGE_WATCH: 0, EARLY_WATCH: 0, BREAKOUT_CHASE: 0, CHASE_RISK: 0 };
  const labelCount = { BMS_EARLY: 0, BMS_VALUE: 0, BMS_SURGE: 0, BMS_BREAKOUT: 0, valueAndSurge: 0 };
  const historyCount = {};
  const boxCount = {};
  filtered.forEach(c => {
    watchCount[c.watchTagV2] = (watchCount[c.watchTagV2] || 0) + 1;
    c.labels.forEach(l => labelCount[l] = (labelCount[l] || 0) + 1);
    if (c.isValueSurge) labelCount.valueAndSurge++;
    historyCount[c.historyQuality] = (historyCount[c.historyQuality] || 0) + 1;
    boxCount[c.boxQuality] = (boxCount[c.boxQuality] || 0) + 1;
  });
  const totalScores = filtered.map(c => c.totalScore);
  const meanScore = totalScores.length ? totalScores.reduce((a, b) => a + b, 0) / totalScores.length : 0;
  const sortedScores = [...totalScores].sort((a, b) => a - b);
  const medianScore = sortedScores.length ? sortedScores[Math.floor(sortedScores.length / 2)] : 0;
  const highRiskCount = filtered.filter(c => c.isHighRisk).length;

  // v1 비교
  const v1Watch = v1Result?.summary?.watchCount || {};
  const compareWithV1 = v1Result ? {
    v1CandidatesCount: v1Result.summary?.candidatesCount || null,
    v2CandidatesCount: filtered.length,
    v1CoreCount: v1Watch.CORE || null,
    v2CoreACount: watchCount.CORE_A,
    v2CoreBCount: watchCount.CORE_B,
    v1HighRiskCount: v1Result.summary?.highRiskCount || null,
    v2HighRiskCount: highRiskCount,
    v1ValueAndSurge: v1Result.summary?.labelCount?.valueAndSurge || null,
    v2ValueAndSurge: labelCount.valueAndSurge,
    deltaCandidates: filtered.length - (v1Result.summary?.candidatesCount || 0),
    note: 'v1의 단일 CORE(210)가 v2에서 CORE_A/CORE_B/SURGE_WATCH 등으로 세분화되어 단순 비교는 불가. 핵심 후보(CORE_A+CORE_B)만 비교 권장.',
  } : null;

  // 콘솔
  console.log('\n📊 watchTagV2 분포:');
  Object.entries(watchCount).forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v}건`));
  console.log(`\n  라벨: BMS_EARLY=${labelCount.BMS_EARLY} BMS_VALUE=${labelCount.BMS_VALUE} BMS_SURGE=${labelCount.BMS_SURGE} BMS_BREAKOUT=${labelCount.BMS_BREAKOUT}`);
  console.log(`  VALUE+SURGE 동시: ${labelCount.valueAndSurge}`);
  console.log(`  history: ${JSON.stringify(historyCount)}`);
  console.log(`  box: ${JSON.stringify(boxCount)}`);
  console.log(`  totalScore mean=${meanScore.toFixed(1)} median=${medianScore.toFixed(1)} highRisk=${highRiskCount}`);

  // 상위 출력
  function printTop(label, list, max = 20) {
    console.log(`\n🏆 ${label} 상위 ${Math.min(max, list.length)}:`);
    list.slice(0, max).forEach((c, i) => {
      console.log(`  ${(i+1).toString().padStart(2)}. ${c.name.padEnd(14)} ${c.code} ${c.market.padEnd(6)} ${c.watchTagV2.padEnd(14)} ${c.historyQuality.padEnd(13)} 시총=${(c.marketCap/1e8).toFixed(0)}억 [${c.labels.join('+')}] T${c.totalScore} R${c.riskScore}`);
    });
  }
  printTop('CORE_A', topCoreA);
  printTop('topByScore', topByScore);
  printTop('topMidFullHistory', topMidFullHistory);

  // JSON 출력
  const out = {
    meta: {
      version: 'wra-current-similarity-v2',
      generatedAt: new Date().toISOString(),
      latestTradingDate: latestDate,
      executionSeconds: Math.round(elapsed),
      universeProcessed: processed,
      candidatesCount: filtered.length,
      baselineSource: baseline ? 'wra-winner-reverse-audit-v2-result.json' : 'none',
      baselineSampleCount: baseline?.meta?.successSamples || null,
      notice: '본 보고서는 매수 신호가 아닙니다. 과거 +40% 상승 성공 종목의 T0 조건과 현재 종목의 구조 유사도를 보여주는 보고서입니다. 미래 데이터는 사용하지 않습니다.',
    },
    config: CONFIG,
    summary: {
      universeProcessed: processed,
      candidatesCount: filtered.length,
      labelCount,
      watchCount,
      historyCount,
      boxCount,
      meanTotalScore: meanScore,
      medianTotalScore: medianScore,
      highRiskCount,
      staleSkipped: stale,
    },
    compareWithV1,
    topLists: {
      topByPriority,
      topByScore,
      topByLowRisk,
      topCoreA,
      topCoreB,
      topValueSurge,
      topValueOnly,
      topSurgeOnly,
      topBreakoutRisk,
      topMidFullHistory,
      topShortHistory,
    },
    candidates: filtered,
  };

  const outPath = path.join(REPORTS_DIR, 'wra-current-similarity-report-v2.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  const sizeKB = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`\n✅ JSON 저장: ${outPath} (${sizeKB}KB)`);
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main, evaluateLabels, computeScores, watchTagV2, sortV2 };
