#!/usr/bin/env node
/**
 * WRA 현재 유사도 보고서 (Current Similarity Report)
 *
 * 목적:
 *   매수 신호가 아니다. 매수 후보 추천기가 아니다.
 *   과거 +40% 상승 성공 종목의 T0 조건과 현재 종목의 구조가 얼마나 유사한지 보여주는 보고서다.
 *
 * 데이터 누수 방지:
 *   - 미래 데이터 절대 사용 금지
 *   - 각 종목의 최신 거래일까지의 데이터만 사용
 *   - "오늘"이라는 표현은 사용하지 않음 (latestTradingDate 또는 기준일로 명시)
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json (종목별 일봉)
 *   - cache/naver-stocks-list.json (메타)
 *   - reports/wra-winner-reverse-audit-v2-result.json (참조용 baseline)
 *
 * 출력:
 *   - reports/wra-current-similarity-report.json
 *
 * 실행:
 *   node wra-current-similarity-report.js
 *   node wra-current-similarity-report.js --top=200       # 상위 N개만 저장
 *   node wra-current-similarity-report.js --min-mc=10000   # 최소 시총 (억)
 */

const fs = require('fs');
const path = require('path');
const wra = require('./wra-winner-reverse-audit');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');
const WRA_BASELINE_FILE = path.join(REPORTS_DIR, 'wra-winner-reverse-audit-v2-result.json');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
})();

const CONFIG = {
  MIN_MARKET_CAP: parseInt(args['min-mc'] || '300') * 100_000_000,   // 기본 300억
  MIN_HISTORY: 60,
  TOP_N: args.top ? parseInt(args.top) : null,                         // null이면 모두 저장
  // 기준일이 너무 오래된 종목 제외 — 캘린더 7일
  STALE_DAYS: 7,
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcluded(name) {
  return name && EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

// ─────────────────────── 헬퍼 ───────────────────────

function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function safe(n) { return Number.isFinite(n) ? n : null; }

// 0~1 매핑 (선형, range 밖이면 클램프)
function mapRange(v, lo, hi) {
  if (v == null || !Number.isFinite(v)) return 0;
  if (hi === lo) return 0.5;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

// ─────────────────────── 라벨 평가 ───────────────────────

function evaluateLabels(m) {
  const labels = [];
  if (!m) return labels;

  // BMS_EARLY: (valR≥1.3 OR volR≥1.3) AND closeToMA20≥-3 AND closeLoc≥0.5
  if (((m.valueRatio20 || 0) >= 1.3 || (m.volumeRatio20 || 0) >= 1.3)
      && (m.closeToMA20 ?? -Infinity) >= -3
      && (m.closeLocation || 0) >= 0.5) {
    labels.push('BMS_EARLY');
  }

  // BMS_VALUE: valR≥1.5 AND volR≥1.3 AND closeLoc≥0.5 AND v/mc≥0.003
  if ((m.valueRatio20 || 0) >= 1.5
      && (m.volumeRatio20 || 0) >= 1.3
      && (m.closeLocation || 0) >= 0.5
      && (m.valueToMarketCap || 0) >= 0.003) {
    labels.push('BMS_VALUE');
  }

  // BMS_SURGE: dayReturn≥5 AND closeLoc≥0.7 AND valR≥1.3 AND closeToMA20>0
  if ((m.dayReturn || 0) >= 5
      && (m.closeLocation || 0) >= 0.7
      && (m.valueRatio20 || 0) >= 1.3
      && (m.closeToMA20 || 0) > 0) {
    labels.push('BMS_SURGE');
  }

  // BMS_BREAKOUT: close > boxUpper AND valR≥1.3 AND closeLoc≥0.6
  if (m.boxUpperBreak === true
      && (m.valueRatio20 || 0) >= 1.3
      && (m.closeLocation || 0) >= 0.6) {
    labels.push('BMS_BREAKOUT');
  }

  return labels;
}

// ─────────────────────── 점수 계산 ───────────────────────

// 각 점수는 0~25점 정도, total 약 0~100점 범위
function computeScores(m, prep, hasBmsValue) {
  if (!m) return { traceScore: 0, confirmScore: 0, structureScore: 0, riskScore: 0, totalScore: 0 };

  // traceScore: 가장 빠른 흔적 — 25점 만점
  const trace =
      mapRange(m.valueRatio20, 1.0, 3.0) * 5
    + mapRange(m.volumeRatio20, 1.0, 3.0) * 5
    + mapRange(m.closeToMA20, -10, 10) * 5
    + mapRange(m.closeLocation, 0, 1) * 5
    + mapRange(m.closeFromRecentLow20, 0, 30) * 5;

  // confirmScore: 거래대금/시총 + 종가 강세 — 25점 만점
  const confirm =
      mapRange(m.valueToMarketCap, 0, 0.05) * 5
    + mapRange(m.valueRatio20, 1.5, 4.0) * 5
    + mapRange(m.volumeRatio20, 1.3, 3.5) * 5
    + mapRange(m.closeLocation, 0.5, 1.0) * 5
    + mapRange(m.supportRatio, 0, 0.5) * 5;

  // structureScore: 박스/매물대/이평선 — 35점 만점
  const structure =
      mapRange(m.dynamicBoxDuration, 20, 80) * 5
    + (1 - mapRange(m.boxRangePct || 30, 0, 50)) * 5     // 좁을수록 좋음
    + (1 - mapRange(m.overheadRatio, 0, 0.6)) * 5         // 적을수록 좋음
    + mapRange(m.supportRatio, 0, 0.5) * 5
    + (prep?.lowsRising ? 5 : 0)
    + (prep?.closeAboveMa20 === true ? 5 : 0)
    + (prep?.closeAboveMa60 === true ? 5 : 0);

  // riskScore: 과열/추격 감점 — 0~50점 (총점에서 뺄 값)
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

// ─────────────────────── 라벨 판정 (history / box) ───────────────────────

function historyQuality(chartLen) {
  if (chartLen >= 250) return 'FULL_HISTORY';
  if (chartLen >= 120) return 'MID_HISTORY';
  if (chartLen >= 60) return 'SHORT_HISTORY';
  return 'INSUFFICIENT';
}

function boxQuality(m, prep) {
  const fb = m?.boxFallback === true;
  const range = m?.boxRangePct || prep?.boxRangePct || 0;
  if (!fb && range <= 25) return 'BOX_STABLE';
  if (fb && range <= 40) return 'BOX_VOLATILE';
  if (fb && range > 40) return 'BOX_UNSTABLE';
  // dynamic box를 찾았지만 range 25 초과 (이론적으로 발생하지 않음 since findDynamicBox는 25 이하만 반환)
  return range <= 40 ? 'BOX_VOLATILE' : 'BOX_UNSTABLE';
}

// ─────────────────────── 종목별 측정 (latest idx 기준) ───────────────────────

function measureLatest(rows, code, marketCap) {
  if (rows.length < CONFIG.MIN_HISTORY) return null;
  const indi = wra.precomputeIndicators(rows);
  const idx = rows.length - 1;
  const today = rows[idx];
  const prev = rows[idx - 1];
  if (!today || !prev) return null;

  // T0 측정 (idx 시점에서) — wra 모듈의 measureT0 활용
  const measurements = wra.measureT0(rows, indi, idx, marketCap, idx);
  if (!measurements) return null;

  // 추가 메트릭: dayReturn, boxUpper/boxUpperBreak (analyzeT0 활용)
  const t0Detail = wra.analyzeT0(rows, indi, idx, marketCap);
  if (!t0Detail) return null;

  // preparation
  const prep = wra.analyzePreparation(rows, indi, idx, marketCap);

  return {
    idx,
    date: today.date,
    close: today.close,
    prevClose: prev.close,
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

function rankPriority(labels) {
  const has = (k) => labels.includes(k);
  if (has('BMS_VALUE') && has('BMS_SURGE')) return 1;
  if (has('BMS_VALUE')) return 2;
  if (has('BMS_SURGE')) return 3;
  if (has('BMS_EARLY')) return 4;
  if (has('BMS_BREAKOUT')) return 5;
  return 9;
}

function sortCandidates(candidates) {
  return candidates.sort((a, b) => {
    const ra = rankPriority(a.labels);
    const rb = rankPriority(b.labels);
    if (ra !== rb) return ra - rb;
    return (b.totalScore || 0) - (a.totalScore || 0);
  });
}

// ─────────────────────── 분류 라벨 ───────────────────────

function watchTag(labels) {
  // 핵심 후보, 추격 위험, 관찰 후보
  const has = (k) => labels.includes(k);
  if (has('BMS_VALUE') || has('BMS_SURGE')) return 'CORE';
  if (has('BMS_BREAKOUT') && !has('BMS_VALUE')) return 'CHASE_RISK';
  if (has('BMS_EARLY')) return 'WATCH';
  return 'NONE';
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('WRA 현재 유사도 보고서 (Current Similarity Report)');
  console.log('═'.repeat(80));
  console.log(`최소 시총: ${CONFIG.MIN_MARKET_CAP / 1e8}억`);
  console.log();

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // baseline 로드 (참조용 — 통계 비교에 사용)
  let baseline = null;
  if (fs.existsSync(WRA_BASELINE_FILE)) {
    try { baseline = JSON.parse(fs.readFileSync(WRA_BASELINE_FILE, 'utf-8')); }
    catch (_) {}
  }
  if (baseline) {
    console.log(`baseline 로드: WRA v2 (${baseline.meta?.successSamples}개 success 샘플)`);
  } else {
    console.log('⚠ WRA v2 baseline 파일 없음 — 비교 통계는 생략');
  }

  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`차트 ${files.length}개 처리 시작...`);

  // latestTradingDate 결정 (mode)
  const lastDateCount = {};
  let latestDate = '00000000';

  const candidates = [];
  let processed = 0;
  let skipMeta = 0, skipExcl = 0, skipMc = 0, skipShort = 0, skipStale = 0;
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

    const m = measureLatest(rows, code, marketCap);
    if (!m) { skipShort++; return; }

    const labels = evaluateLabels(m);
    if (labels.length === 0) { processed++; return; }   // 라벨 하나도 없으면 후보 아님

    const hasBmsValue = labels.includes('BMS_VALUE');
    const scores = computeScores(m, m.prep, hasBmsValue);

    candidates.push({
      code,
      name: meta.name,
      market: meta.market,
      marketCap,
      date: m.date,
      labels,
      watchTag: watchTag(labels),
      historyQuality: historyQuality(m.chartLen),
      boxQuality: boxQuality(m, m.prep),
      ...scores,
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
      const elapsed = (Date.now() - startTime) / 1000;
      process.stdout.write(`\r${idx + 1}/${files.length} 후보=${candidates.length} 경과=${elapsed.toFixed(0)}s`);
    }
  });
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n분석 완료: 처리 ${processed}개, 후보 ${candidates.length}개, ${elapsed.toFixed(0)}초`);
  console.log(`  스킵: meta=${skipMeta} 제외=${skipExcl} 시총미달=${skipMc} 차트짧음=${skipShort}`);

  // latestDate (mode)
  const sortedDates = Object.entries(lastDateCount).sort(([, a], [, b]) => b - a);
  latestDate = sortedDates[0]?.[0] || '00000000';

  // stale cutoff: 종목별 last row date가 latestDate에서 7 캘린더일 이상 지났으면 후보에서 제외
  const cutDate = (() => {
    const y = parseInt(latestDate.slice(0, 4)), mo = parseInt(latestDate.slice(4, 6)) - 1, d = parseInt(latestDate.slice(6, 8));
    const dt = new Date(y, mo, d); dt.setDate(dt.getDate() - CONFIG.STALE_DAYS);
    return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
  })();
  const filteredCandidates = candidates.filter(c => {
    if (c.date < cutDate) { skipStale++; return false; }
    return true;
  });

  // 정렬
  sortCandidates(filteredCandidates);

  // 카운트 by label
  const labelCount = {
    BMS_EARLY: 0, BMS_VALUE: 0, BMS_SURGE: 0, BMS_BREAKOUT: 0,
    valueAndSurge: 0,
  };
  const histCount = {};
  const boxCount = {};
  const watchCount = { CORE: 0, CHASE_RISK: 0, WATCH: 0, NONE: 0 };
  filteredCandidates.forEach(c => {
    c.labels.forEach(l => labelCount[l] = (labelCount[l] || 0) + 1);
    if (c.labels.includes('BMS_VALUE') && c.labels.includes('BMS_SURGE')) labelCount.valueAndSurge++;
    histCount[c.historyQuality] = (histCount[c.historyQuality] || 0) + 1;
    boxCount[c.boxQuality] = (boxCount[c.boxQuality] || 0) + 1;
    watchCount[c.watchTag] = (watchCount[c.watchTag] || 0) + 1;
  });

  const totalScores = filteredCandidates.map(c => c.totalScore);
  const meanScore = totalScores.length ? totalScores.reduce((a, b) => a + b, 0) / totalScores.length : 0;
  const sortedScores = [...totalScores].sort((a, b) => a - b);
  const medianScore = sortedScores.length ? sortedScores[Math.floor(sortedScores.length / 2)] : 0;
  const highRiskCount = filteredCandidates.filter(c => (c.riskScore || 0) >= 20).length;

  // 콘솔 요약
  console.log('\n📊 후보 요약:');
  console.log(`  전체 처리: ${processed}, 후보: ${filteredCandidates.length} (stale 제외 ${skipStale})`);
  console.log(`  라벨: BMS_EARLY=${labelCount.BMS_EARLY} BMS_VALUE=${labelCount.BMS_VALUE} BMS_SURGE=${labelCount.BMS_SURGE} BMS_BREAKOUT=${labelCount.BMS_BREAKOUT}`);
  console.log(`  BMS_VALUE+BMS_SURGE 동시: ${labelCount.valueAndSurge}`);
  console.log(`  watchTag: CORE=${watchCount.CORE} CHASE_RISK=${watchCount.CHASE_RISK} WATCH=${watchCount.WATCH}`);
  console.log(`  history: ${JSON.stringify(histCount)}`);
  console.log(`  box: ${JSON.stringify(boxCount)}`);
  console.log(`  totalScore mean=${meanScore.toFixed(1)} median=${medianScore.toFixed(1)} 위험(>=20점) ${highRiskCount}`);

  // 상위 20개 출력
  console.log('\n🏆 상위 20개 (라벨 우선 + 동점은 totalScore):');
  filteredCandidates.slice(0, 20).forEach((c, i) => {
    console.log(`  ${(i + 1).toString().padStart(2)}. ${c.name.padEnd(14)} ${c.code} ${c.market.padEnd(6)} 시총=${(c.marketCap / 1e8).toFixed(0)}억 [${c.labels.join('+')}] watch=${c.watchTag} total=${c.totalScore} (T${c.traceScore}/C${c.confirmScore}/S${c.structureScore}/-R${c.riskScore})`);
  });

  // JSON 저장
  let outCandidates = filteredCandidates;
  if (CONFIG.TOP_N) outCandidates = outCandidates.slice(0, CONFIG.TOP_N);

  const out = {
    meta: {
      version: 'wra-current-similarity-v1',
      generatedAt: new Date().toISOString(),
      latestTradingDate: latestDate,
      executionSeconds: Math.round(elapsed),
      universeProcessed: processed,
      candidatesCount: filteredCandidates.length,
      candidatesSaved: outCandidates.length,
      baselineSource: baseline ? 'wra-winner-reverse-audit-v2-result.json' : 'none',
      baselineSampleCount: baseline?.meta?.successSamples || null,
      notice: '본 보고서는 매수 신호가 아닙니다. 과거 +40% 상승 성공 종목의 T0 조건과 현재 종목의 구조 유사도를 보여주는 보고서입니다. 미래 데이터는 사용하지 않습니다.',
    },
    config: CONFIG,
    summary: {
      universeProcessed: processed,
      candidatesCount: filteredCandidates.length,
      labelCount,
      historyCount: histCount,
      boxCount,
      watchCount,
      meanTotalScore: meanScore,
      medianTotalScore: medianScore,
      highRiskCount,
      skipStale,
    },
    candidates: outCandidates,
  };

  const outPath = path.join(REPORTS_DIR, 'wra-current-similarity-report.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  const sizeKB = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`\n✅ JSON 저장: ${outPath} (${sizeKB}KB)`);
  console.log('\n주의: 본 보고서는 매수 추천이 아닙니다. 구조 유사도 보고서입니다.');
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main, evaluateLabels, computeScores };
