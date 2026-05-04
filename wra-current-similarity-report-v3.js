#!/usr/bin/env node
/**
 * WRA Current Similarity Report v3
 *
 * v2 → v3 핵심 변경:
 *   - watchTagV3 6단계 (rolling validation 결과 반영):
 *       VALUE_SURGE_CONFIRM > CLEAN_VALUE_SETUP > BREAKOUT_MOMENTUM > HIGH_VOLATILITY > WATCH_ONLY > WEAK_EARLY
 *   - HIGH_VOLATILITY는 다른 라벨과 겹치면 riskOverlay로 별도 표시
 *   - 새 점수 체계: setupScore + momentumScore + historyScore - riskPenalty = finalScore
 *   - historyScore 가중치 (FULL +10 / MID +6 / SHORT 0)
 *   - interpretation 문자열 포함
 *
 * 매수 신호 아님. 미래 데이터 사용 안 함. QVA/VVI 미수정.
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json
 *   - reports/wra-current-similarity-report-v2.json (v2 비교용, 있으면)
 *
 * 출력:
 *   - reports/wra-current-similarity-report-v3.json
 */

const fs = require('fs');
const path = require('path');
const wra = require('./wra-winner-reverse-audit');
const v2 = require('./wra-current-similarity-report-v2');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');
const V2_RESULT_FILE = path.join(REPORTS_DIR, 'wra-current-similarity-report-v2.json');

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
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcluded(name) { return name && EXCLUDE_KEYWORDS.some(k => name.includes(k)); }

// ─────────────────────── 헬퍼 ───────────────────────

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d||'-'); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function mapRange(v, lo, hi) {
  if (v == null || !Number.isFinite(v)) return 0;
  if (hi === lo) return 0.5;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

// ─────────────────────── 측정 ───────────────────────

function measureLatest(rows, marketCap) {
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

function historyQuality(chartLen) {
  if (chartLen >= 250) return 'FULL_HISTORY';
  if (chartLen >= 120) return 'MID_HISTORY';
  if (chartLen >= 60) return 'SHORT_HISTORY';
  return 'INSUFFICIENT';
}
function historyScoreFn(q) {
  return q === 'FULL_HISTORY' ? 10 : q === 'MID_HISTORY' ? 6 : 0;
}
function boxQuality(m) {
  const fb = m?.boxFallback === true;
  const range = m?.boxRangePct || 0;
  if (!fb && range <= 25) return 'BOX_STABLE';
  if (fb && range <= 40) return 'BOX_VOLATILE';
  if (fb && range > 40) return 'BOX_UNSTABLE';
  return range <= 40 ? 'BOX_VOLATILE' : 'BOX_UNSTABLE';
}

// ─────────────────────── 그룹 정의 ───────────────────────

function isCleanValueSetup(labels, m, riskScore, boxQ) {
  return labels.includes('BMS_VALUE')
    && !labels.includes('BMS_SURGE')
    && riskScore <= 10
    && boxQ === 'BOX_STABLE'
    && (m.dayReturn || 0) < 5
    && (m.closeToMA20 || 0) < 12
    && (m.closeFromRecentLow20 || 0) < 25
    && (m.valueRatio20 || 0) >= 1.5
    && (m.valueRatio20 || 0) <= 4.0;
}

function isValueSurgeConfirm(labels, m, riskScore) {
  return labels.includes('BMS_VALUE')
    && labels.includes('BMS_SURGE')
    && riskScore < 30
    && (m.dayReturn || 0) <= 15
    && (m.closeToMA20 || 0) < 25;
}

function isBreakoutMomentum(labels) {
  return labels.includes('BMS_BREAKOUT')
    && (labels.includes('BMS_VALUE') || labels.includes('BMS_SURGE'));
}

function isHighVolatilityCondition(m, riskScore, watchTagV2) {
  return watchTagV2 === 'CHASE_RISK'
    || riskScore >= 20
    || (m.closeFromRecentLow20 || 0) >= 40
    || (m.closeToMA20 || 0) >= 20
    || (m.dayReturn || 0) >= 15;
}

function isStructureReady(labels, m, riskScore, boxQ) {
  return labels.length === 1 && labels[0] === 'BMS_EARLY'
    && riskScore === 0
    && boxQ === 'BOX_STABLE'
    && (m.closeToMA20 || 0) >= -3
    && (m.closeToMA20 || 0) <= 8
    && (m.closeFromRecentLow20 || 0) < 20
    && (m.valueRatio20 || 0) >= 1.2;
}

function isWatchOnly(labels, m, riskScore, boxQ) {
  if (riskScore > 10) return false;
  if (isStructureReady(labels, m, riskScore, boxQ)) return true;
  // EARLY only && riskScore <= 10
  return labels.length === 1 && labels[0] === 'BMS_EARLY';
}

function isWeakEarly(labels) {
  return labels.length === 1 && labels[0] === 'BMS_EARLY';
}

// 메인 라벨 결정 (우선순위)
const TAG_RANK = {
  VALUE_SURGE_CONFIRM: 1,
  CLEAN_VALUE_SETUP: 2,
  BREAKOUT_MOMENTUM: 3,
  HIGH_VOLATILITY: 4,
  WATCH_ONLY: 5,
  WEAK_EARLY: 6,
  UNCLASSIFIED: 9,
};

function watchTagV3(labels, m, riskScore, watchTagV2, boxQ) {
  const isHighVol = isHighVolatilityCondition(m, riskScore, watchTagV2);

  if (isValueSurgeConfirm(labels, m, riskScore)) {
    return { tag: 'VALUE_SURGE_CONFIRM', riskOverlay: isHighVol ? 'HIGH_VOLATILITY' : null };
  }
  if (isCleanValueSetup(labels, m, riskScore, boxQ)) {
    return { tag: 'CLEAN_VALUE_SETUP', riskOverlay: isHighVol ? 'HIGH_VOLATILITY' : null };
  }
  if (isBreakoutMomentum(labels)) {
    return { tag: 'BREAKOUT_MOMENTUM', riskOverlay: isHighVol ? 'HIGH_VOLATILITY' : null };
  }
  // 위 셋 어디에도 안 맞고 high volatility라면 단독 HIGH_VOLATILITY
  if (isHighVol) {
    return { tag: 'HIGH_VOLATILITY', riskOverlay: null };
  }
  if (isWatchOnly(labels, m, riskScore, boxQ)) {
    return { tag: 'WATCH_ONLY', riskOverlay: null };
  }
  if (isWeakEarly(labels)) {
    return { tag: 'WEAK_EARLY', riskOverlay: null };
  }
  return { tag: 'UNCLASSIFIED', riskOverlay: isHighVol ? 'HIGH_VOLATILITY' : null };
}

const INTERPRETATION = {
  VALUE_SURGE_CONFIRM: '거래대금과 상승 확인이 동시에 나온 후보',
  CLEAN_VALUE_SETUP: '위험을 낮춘 거래대금 유입 후보',
  BREAKOUT_MOMENTUM: '다음 거래일 돌파 가능성이 있으나 추격 위험 존재',
  HIGH_VOLATILITY: '급등과 급락 가능성이 모두 큰 고변동성 후보',
  WATCH_ONLY: '구조 관찰용, 단기 수익성은 약한 후보',
  WEAK_EARLY: 'EARLY 단독으로 신호 약함',
  UNCLASSIFIED: '분류되지 않은 후보',
};

// ─────────────────────── v3 점수 ───────────────────────

function computeV3Scores(labels, m, riskScore, hQuality, boxQ, watchTagV2, riskOverlay) {
  // setupScore: 안정형·구조형 점수 (0~50점 정도)
  let setup = 0;
  setup += isCleanValueSetup(labels, m, riskScore, boxQ) ? 12 : 0;
  setup += boxQ === 'BOX_STABLE' ? 6 : (boxQ === 'BOX_VOLATILE' ? 2 : 0);
  setup += (1 - mapRange(riskScore, 0, 30)) * 8;     // riskScore 0이면 +8, 30이상이면 0
  // closeToMA20 0~12 구간이 좋음
  const ma20 = m.closeToMA20 || 0;
  setup += (ma20 >= 0 && ma20 <= 12) ? 6 : (ma20 < 0 ? 3 : 0);
  // closeFromRecentLow20 5~25 구간이 좋음
  const lr = m.closeFromRecentLow20 || 0;
  setup += (lr >= 5 && lr <= 25) ? 5 : (lr >= 0 && lr < 5 ? 2 : 0);
  // valueRatio20 1.5~4.0 구간
  const vr = m.valueRatio20 || 0;
  setup += (vr >= 1.5 && vr <= 4.0) ? 5 : (vr >= 1.2 && vr < 1.5 ? 2 : 0);
  setup += historyScoreFn(hQuality) * 0.8;            // history 반영 (FULL +8, MID +4.8)

  // momentumScore: 모멘텀 점수 (0~40점 정도)
  let mom = 0;
  if (labels.includes('BMS_VALUE')) mom += 10;
  if (labels.includes('BMS_SURGE')) mom += 10;
  if (labels.includes('BMS_BREAKOUT')) mom += 6;
  if (labels.includes('BMS_VALUE') && labels.includes('BMS_SURGE')) mom += 5;     // valueAndSurge bonus
  // valueRatio20 적정 범위만 가산 (과도하면 risk로)
  mom += vr >= 1.5 && vr <= 5.0 ? mapRange(vr, 1.5, 4.0) * 5 : 0;
  // closeLocation 강세 가산
  mom += (m.closeLocation || 0) * 4;

  // historyScore: 별도 +가산값 (10/6/0)
  const hScore = historyScoreFn(hQuality);

  // riskPenalty: 0~50점 감점
  let pen = 0;
  pen += riskScore;                                    // 기본 risk 그대로
  if ((m.closeFromRecentLow20 || 0) >= 40) pen += 8;
  if ((m.closeToMA20 || 0) >= 20) pen += 8;
  if ((m.dayReturn || 0) >= 15) pen += 8;
  if (boxQ === 'BOX_UNSTABLE') pen += 5;
  if (riskOverlay === 'HIGH_VOLATILITY') pen += 6;     // overlay 추가 감점

  const finalScore = setup + mom + hScore - pen;

  return {
    setupScore: Math.round(setup * 10) / 10,
    momentumScore: Math.round(mom * 10) / 10,
    historyScore: hScore,
    riskPenalty: Math.round(pen * 10) / 10,
    finalScore: Math.round(finalScore * 10) / 10,
  };
}

// ─────────────────────── 정렬 ───────────────────────

function sortV3(candidates) {
  return candidates.sort((a, b) => {
    const ra = TAG_RANK[a.watchTagV3] || 99;
    const rb = TAG_RANK[b.watchTagV3] || 99;
    if (ra !== rb) return ra - rb;
    if (a.riskScore !== b.riskScore) return a.riskScore - b.riskScore;
    if (a.finalScore !== b.finalScore) return b.finalScore - a.finalScore;
    return (b.marketCap || 0) - (a.marketCap || 0);
  });
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('WRA Current Similarity Report v3');
  console.log('═'.repeat(80));
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  let v2Result = null;
  if (fs.existsSync(V2_RESULT_FILE)) {
    try { v2Result = JSON.parse(fs.readFileSync(V2_RESULT_FILE, 'utf-8')); } catch (_) {}
  }
  if (v2Result) console.log(`v2 결과 로드: 후보 ${v2Result.summary?.candidatesCount}개`);

  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`\n차트 ${files.length}개 처리 시작...`);

  const lastDateCount = {};
  const candidates = [];
  let processed = 0, skipMeta = 0, skipExcl = 0, skipMc = 0, skipShort = 0;
  const startTime = Date.now();

  files.forEach((file, idx) => {
    const code = file.replace('.json', '');
    const meta = stockMap[code];
    if (!meta) { skipMeta++; return; }
    if (isExcluded(meta.name)) { skipExcl++; return; }
    if (meta.isSpecial) { skipExcl++; return; }
    const marketCap = meta.marketValue || 0;
    if (marketCap < CONFIG.MIN_MARKET_CAP) { skipMc++; return; }

    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8')); }
    catch (_) { return; }
    const rows = chart.rows || [];
    if (rows.length < CONFIG.MIN_HISTORY) { skipShort++; return; }

    const lastRowDate = rows[rows.length - 1].date;
    lastDateCount[lastRowDate] = (lastDateCount[lastRowDate] || 0) + 1;

    const m = measureLatest(rows, marketCap);
    if (!m) return;

    const labels = v2.evaluateLabels(m);
    if (labels.length === 0) { processed++; return; }

    const hasBmsValue = labels.includes('BMS_VALUE');
    const v2Scores = v2.computeScores(m, m.prep, hasBmsValue);
    const tagV2 = v2.watchTagV2(labels, v2Scores.riskScore, v2Scores.warnings);
    const hQuality = historyQuality(m.chartLen);
    const boxQ = boxQuality(m);
    const v3Tag = watchTagV3(labels, m, v2Scores.riskScore, tagV2, boxQ);
    const v3Scores = computeV3Scores(labels, m, v2Scores.riskScore, hQuality, boxQ, tagV2, v3Tag.riskOverlay);

    candidates.push({
      code, name: meta.name, market: meta.market, marketCap,
      latestTradingDate: m.date,
      labels,
      watchTagV2: tagV2,
      watchTagV3: v3Tag.tag,
      riskOverlay: v3Tag.riskOverlay,
      historyQuality: hQuality,
      boxQuality: boxQ,
      totalScoreV2: v2Scores.totalScore,
      setupScore: v3Scores.setupScore,
      momentumScore: v3Scores.momentumScore,
      historyScore: v3Scores.historyScore,
      riskPenalty: v3Scores.riskPenalty,
      finalScore: v3Scores.finalScore,
      riskScore: v2Scores.riskScore,
      // 메트릭
      valueRatio20: m.valueRatio20,
      volumeRatio20: m.volumeRatio20,
      valueToMarketCap: m.valueToMarketCap,
      closeLocation: m.closeLocation,
      closeToMA5: m.closeToMA5,
      closeToMA20: m.closeToMA20,
      closeToMA60: m.closeToMA60,
      closeFromRecentLow20: m.closeFromRecentLow20,
      closeFromRecentHigh20: m.closeFromRecentHigh20,
      closeFrom52WeekHigh: m.closeFrom52WeekHigh,
      dayReturn: m.dayReturn,
      boxRangePct: m.boxRangePct,
      dynamicBoxDuration: m.dynamicBoxDuration,
      boxFallback: m.boxFallback,
      overheadRatio: m.overheadRatio,
      supportRatio: m.supportRatio,
      warnings: v2Scores.warnings,
      interpretation: INTERPRETATION[v3Tag.tag] + (v3Tag.riskOverlay ? ' (고변동성 overlay)' : ''),
    });
    processed++;

    if ((idx + 1) % 1000 === 0) {
      const e = (Date.now() - startTime) / 1000;
      process.stdout.write(`\r${idx + 1}/${files.length} 후보=${candidates.length} ${e.toFixed(0)}s`);
    }
  });
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n분석 완료: 처리 ${processed}, 후보 ${candidates.length}, ${elapsed.toFixed(0)}초`);

  // latestDate (mode)
  const sorted = Object.entries(lastDateCount).sort(([, a], [, b]) => b - a);
  const latestDate = sorted[0]?.[0] || '00000000';
  // stale 컷
  const cutDate = (() => {
    const y = parseInt(latestDate.slice(0,4)), mo = parseInt(latestDate.slice(4,6))-1, d = parseInt(latestDate.slice(6,8));
    const dt = new Date(y, mo, d); dt.setDate(dt.getDate() - CONFIG.STALE_DAYS);
    return `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}`;
  })();
  let stale = 0;
  const filtered = candidates.filter(c => {
    if (c.latestTradingDate < cutDate) { stale++; return false; }
    return true;
  });

  sortV3(filtered);
  filtered.forEach((c, i) => { c.priorityRank = i + 1; });

  // 카운트
  const watchCount = {};
  const overlayCount = {};
  const labelCount = { BMS_EARLY: 0, BMS_VALUE: 0, BMS_SURGE: 0, BMS_BREAKOUT: 0, valueAndSurge: 0 };
  const histCount = {};
  const boxCount = {};
  filtered.forEach(c => {
    watchCount[c.watchTagV3] = (watchCount[c.watchTagV3] || 0) + 1;
    if (c.riskOverlay) overlayCount[c.riskOverlay] = (overlayCount[c.riskOverlay] || 0) + 1;
    c.labels.forEach(l => labelCount[l] = (labelCount[l] || 0) + 1);
    if (c.labels.includes('BMS_VALUE') && c.labels.includes('BMS_SURGE')) labelCount.valueAndSurge++;
    histCount[c.historyQuality] = (histCount[c.historyQuality] || 0) + 1;
    boxCount[c.boxQuality] = (boxCount[c.boxQuality] || 0) + 1;
  });
  const midfullCount = (histCount.MID_HISTORY || 0) + (histCount.FULL_HISTORY || 0);

  // topLists
  const N = CONFIG.TOPLIST_SIZE;
  const sortByFinal = (a, b) => (b.finalScore || 0) - (a.finalScore || 0);
  const sortByRiskAsc = (a, b) => {
    if (a.riskScore !== b.riskScore) return a.riskScore - b.riskScore;
    return (b.finalScore || 0) - (a.finalScore || 0);
  };

  const topValueSurgeConfirm = filtered.filter(c => c.watchTagV3 === 'VALUE_SURGE_CONFIRM').slice(0, N);  // 이미 sortV3로 정렬됨
  const topCleanValueSetup = filtered.filter(c => c.watchTagV3 === 'CLEAN_VALUE_SETUP').slice(0, N);
  const topBreakoutMomentum = filtered.filter(c => c.watchTagV3 === 'BREAKOUT_MOMENTUM').slice(0, N);
  const topHighVolatility = [...filtered].filter(c => c.watchTagV3 === 'HIGH_VOLATILITY' || c.riskOverlay === 'HIGH_VOLATILITY').sort(sortByFinal).slice(0, N);
  const topWatchOnly = filtered.filter(c => c.watchTagV3 === 'WATCH_ONLY').slice(0, N);
  const topMidFullHistory = [...filtered]
    .filter(c => c.historyQuality === 'MID_HISTORY' || c.historyQuality === 'FULL_HISTORY')
    .sort(sortByFinal).slice(0, N);
  const topByFinalScore = [...filtered].sort(sortByFinal).slice(0, N);
  const topBySetupScore = [...filtered].sort((a, b) => (b.setupScore || 0) - (a.setupScore || 0)).slice(0, N);
  const topByMomentumScore = [...filtered].sort((a, b) => (b.momentumScore || 0) - (a.momentumScore || 0)).slice(0, N);
  const topLowRisk = [...filtered].sort(sortByRiskAsc).slice(0, N);

  // v2 비교
  let compareWithV2 = null;
  if (v2Result) {
    const v2Tags = v2Result.summary?.watchCount || {};
    const sameStocks = new Set(filtered.map(c => c.code));
    const v2Stocks = new Set((v2Result.candidates || []).map(c => c.code));
    const overlap = [...sameStocks].filter(c => v2Stocks.has(c));
    compareWithV2 = {
      v2CandidatesCount: v2Result.summary?.candidatesCount || null,
      v3CandidatesCount: filtered.length,
      v2Tags,
      v3Tags: watchCount,
      stockOverlap: overlap.length,
    };
  }

  // 콘솔
  console.log('\n📊 watchTagV3 분포:');
  Object.entries(watchCount).sort(([a], [b]) => (TAG_RANK[a]||99) - (TAG_RANK[b]||99))
    .forEach(([k, v]) => console.log(`  ${k.padEnd(22)} ${v}건`));
  console.log(`\n  riskOverlay: ${JSON.stringify(overlayCount)}`);
  console.log(`  history: ${JSON.stringify(histCount)} (MID+FULL=${midfullCount})`);
  console.log(`  box: ${JSON.stringify(boxCount)}`);
  console.log(`  labels: ${JSON.stringify(labelCount)}`);

  function printTop(label, list, max = 15) {
    console.log(`\n🏆 ${label} 상위 ${Math.min(max, list.length)}:`);
    list.slice(0, max).forEach((c, i) => {
      const ov = c.riskOverlay ? `+${c.riskOverlay}` : '';
      console.log(`  ${(i+1).toString().padStart(2)}. ${c.name.padEnd(14)} ${c.code} ${c.market.padEnd(6)} ${c.watchTagV3.padEnd(20)}${ov.padEnd(18)} F${c.finalScore} S${c.setupScore} M${c.momentumScore} H${c.historyScore} -R${c.riskPenalty} risk=${c.riskScore}`);
    });
  }
  printTop('VALUE_SURGE_CONFIRM', topValueSurgeConfirm);
  printTop('CLEAN_VALUE_SETUP', topCleanValueSetup);
  printTop('BREAKOUT_MOMENTUM', topBreakoutMomentum);
  printTop('HIGH_VOLATILITY (단독+overlay)', topHighVolatility);
  printTop('topByFinalScore', topByFinalScore);
  printTop('topMidFullHistory', topMidFullHistory);

  // JSON
  const out = {
    meta: {
      version: 'wra-current-similarity-v3',
      generatedAt: new Date().toISOString(),
      latestTradingDate: latestDate,
      executionSeconds: Math.round(elapsed),
      universeProcessed: processed,
      candidatesCount: filtered.length,
      notice: '본 보고서는 매수 신호가 아닙니다. v3는 rolling validation 결과를 반영한 watchTagV3 6단계 체계를 사용합니다.',
    },
    config: CONFIG,
    summary: {
      totalStocksProcessed: processed,
      totalCandidates: filtered.length,
      watchCount, overlayCount,
      labelCount,
      historyCount: histCount,
      boxCount,
      cleanValueSetupCount: watchCount.CLEAN_VALUE_SETUP || 0,
      valueSurgeConfirmCount: watchCount.VALUE_SURGE_CONFIRM || 0,
      breakoutMomentumCount: watchCount.BREAKOUT_MOMENTUM || 0,
      highVolatilityCount: (watchCount.HIGH_VOLATILITY || 0) + (overlayCount.HIGH_VOLATILITY || 0),
      watchOnlyCount: watchCount.WATCH_ONLY || 0,
      weakEarlyCount: watchCount.WEAK_EARLY || 0,
      midfullCount,
      staleSkipped: stale,
    },
    compareWithV2,
    topLists: {
      topValueSurgeConfirm,
      topCleanValueSetup,
      topBreakoutMomentum,
      topHighVolatility,
      topWatchOnly,
      topMidFullHistory,
      topByFinalScore,
      topBySetupScore,
      topByMomentumScore,
      topLowRisk,
    },
    candidates: filtered,
  };

  const outPath = path.join(REPORTS_DIR, 'wra-current-similarity-report-v3.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  const sizeKB = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`\n✅ JSON 저장: ${outPath} (${sizeKB}KB)`);
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main, watchTagV3, computeV3Scores };
