#!/usr/bin/env node
/**
 * 1-Day Surge — 09:30 스캐너 백테스트
 *
 * 과거 거래일별로 09:30 스캐너를 재현해 후보 수가 실전적으로 적당한지 검증.
 *
 * 미래 누수 없는 정의:
 *   - 후보 풀  = 분봉 디렉토리 `data/intraday/1ds/{D+1}/` 의 파일 = 그날 운영 cron이 받은
 *                priorityScore 상위 300개 (옵션 C 백필 기준 + 일자별 buildScannerCandidates 적용).
 *   - baseRow  = 종목 차트에서 D+1 row의 직전 row (= D 일자, 전일 일봉, 종가 확정).
 *   - 09:30 분봉 = 디렉토리의 분봉 중 time ≤ '09:30' 까지의 row → 메트릭/status 분류.
 *   - 성과 측정 = 같은 종목 분봉 중 time > '09:30' ~ '10:00' 까지 → max/return/drawdown 등.
 *
 * 검증 그룹:
 *   - 전체 스캔 대상 (디렉토리 모든 종목)
 *   - READY_ALL / READY_TOP5 / READY_TOP10 / READY_REST
 *   - WAIT_PULLBACK / FADED / WEAK
 *
 * 추가 분석:
 *   - finalScore rank 1~5 / 6~10 / 11~20 / 21+ 별 성과
 *   - 조건 민감도 A(현재) / B(강한) / C(완화)
 *
 * 출력:
 *   - reports/one-day-surge-0930-scanner-backtest-result.json
 *   - reports/one-day-surge-0930-scanner-backtest-result.html
 *
 * 사용:
 *   node boards/oneDaySurge/one-day-surge-0930-scanner-backtest.js
 *   node boards/oneDaySurge/one-day-surge-0930-scanner-backtest.js --min-dir-size 100
 *   node boards/oneDaySurge/one-day-surge-0930-scanner-backtest.js --from 2026-04-16 --to 2026-05-14
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-0930-scanner-backtest-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-0930-scanner-backtest-result.html');

const scanner = require('./one-day-surge-0930-scanner');
const core = require('./one-day-surge-core');

// ── CLI ──
function parseArgs(argv) {
  const a = { from: null, to: null, minDirSize: 100, readyTopLimit: 5 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from') a.from = argv[++i];
    else if (k === '--to') a.to = argv[++i];
    else if (k === '--min-dir-size') a.minDirSize = parseInt(argv[++i], 10) || 100;
    else if (k === '--ready-top-limit') a.readyTopLimit = parseInt(argv[++i], 10) || 5;
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node one-day-surge-0930-scanner-backtest.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--min-dir-size 100]');
      process.exit(0);
    }
  }
  return a;
}

// ── 조건 세트 (사용자 명시 — A 현재 / B 강한 / C 완화) ──
const RULES = {
  A: { label: '현재 기준', MIN_VALUE: 1e9,   MIN_RATIO: 3.0, MIN_CP: 0.65, MAX_DROP: -2.5, MIN_UP: 1.0, MAX_UP: 8.0 },
  B: { label: '강한 기준', MIN_VALUE: 2e9,   MIN_RATIO: 5.0, MIN_CP: 0.75, MAX_DROP: -1.5, MIN_UP: 2.0, MAX_UP: 6.5 },
  C: { label: '완화 기준', MIN_VALUE: 7e8,   MIN_RATIO: 2.5, MIN_CP: 0.60, MAX_DROP: -3.0, MIN_UP: 0.8, MAX_UP: 8.0 },
};
const MIN_BARS = 20;  // 모든 규칙 공통

function classifyByRule(m, rule) {
  if (!m || m.bars_total < MIN_BARS) return 'INSUFFICIENT_BARS';
  if (m.highToLastDrop != null && m.highToLastDrop <= rule.MAX_DROP) return 'FADED';
  if (m.openToLastRate != null && m.openToLastRate >= rule.MAX_UP) return 'WAIT_PULLBACK';
  if (m.openToLastRate == null || m.openToLastRate < rule.MIN_UP) return 'WEAK';
  if (m.value_0930 < rule.MIN_VALUE) return 'WEAK';
  if (m.valueToAvgRatio_0930 != null && m.valueToAvgRatio_0930 < rule.MIN_RATIO) return 'WEAK';
  if (m.closePosition0930 < rule.MIN_CP) return 'WEAK';
  return 'READY';
}

// ── 성과 측정: 09:30 close 대비 09:30~10:00 분봉의 변화 ──
function measurePerformance(allBars, entryPrice) {
  if (!Array.isArray(allBars) || allBars.length === 0 || !(entryPrice > 0)) return null;
  const after = allBars.filter((b) => b.time && b.time > '09:30' && b.time <= '10:00' && b.close > 0);
  if (after.length === 0) return null;
  let maxClose = -Infinity, minClose = Infinity, maxHigh = -Infinity, minLow = Infinity;
  let hit1Idx = -1, hit2Idx = -1, hit3Idx = -1, fail1Idx = -1, fail2Idx = -1;
  for (let i = 0; i < after.length; i++) {
    const b = after[i];
    if (b.close > maxClose) maxClose = b.close;
    if (b.close < minClose) minClose = b.close;
    if (b.high && b.high > maxHigh) maxHigh = b.high;
    if (b.low && b.low < minLow) minLow = b.low;
    // hit/fail은 high/low 기준 (실전 진입가 대비 도달 여부)
    if (hit1Idx < 0 && b.high && (b.high / entryPrice - 1) >= 0.01) hit1Idx = i;
    if (hit2Idx < 0 && b.high && (b.high / entryPrice - 1) >= 0.02) hit2Idx = i;
    if (hit3Idx < 0 && b.high && (b.high / entryPrice - 1) >= 0.03) hit3Idx = i;
    if (fail1Idx < 0 && b.low  && (b.low  / entryPrice - 1) <= -0.01) fail1Idx = i;
    if (fail2Idx < 0 && b.low  && (b.low  / entryPrice - 1) <= -0.02) fail2Idx = i;
  }
  const lastClose = after[after.length - 1].close;
  return {
    n_bars_after: after.length,
    entryPrice,
    maxReturnTo1000:  Number(((maxHigh   / entryPrice - 1) * 100).toFixed(2)),  // high 기준 최대 상승률
    returnAt1000:     Number(((lastClose / entryPrice - 1) * 100).toFixed(2)),  // 10:00 종가 수익률
    drawdown:         Number(((minLow    / entryPrice - 1) * 100).toFixed(2)),  // low 기준 최대 하락
    hit1: hit1Idx >= 0, hit2: hit2Idx >= 0, hit3: hit3Idx >= 0,
    fail1: fail1Idx >= 0, fail2: fail2Idx >= 0,
    hit1Idx, hit2Idx, hit3Idx, fail1Idx, fail2Idx,
    firstHit2BeforeFail1: hit2Idx >= 0 && (fail1Idx < 0 || hit2Idx < fail1Idx),
    firstHit3BeforeFail1: hit3Idx >= 0 && (fail1Idx < 0 || hit3Idx < fail1Idx),
  };
}

// ── 통계 헬퍼 ──
function avg(arr)    { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function rate(n, total) { return total > 0 ? Number((n / total * 100).toFixed(1)) : 0; }

function summarize(entries) {
  const n = entries.length;
  if (n === 0) return { n: 0 };
  const perfs = entries.map((e) => e.perf).filter(Boolean);
  if (perfs.length === 0) return { n, noPerfMeasured: true };
  const maxRets = perfs.map((p) => p.maxReturnTo1000).filter(Number.isFinite);
  const rets1000 = perfs.map((p) => p.returnAt1000).filter(Number.isFinite);
  const dds = perfs.map((p) => p.drawdown).filter(Number.isFinite);
  return {
    n,
    nWithPerf: perfs.length,
    avgMaxReturnTo1000:    Number(avg(maxRets).toFixed(2)),
    medianMaxReturnTo1000: Number(median(maxRets).toFixed(2)),
    avgReturnAt1000:       Number(avg(rets1000).toFixed(2)),
    avgDrawdown:           Number(avg(dds).toFixed(2)),
    hit1Rate:                  rate(perfs.filter((p) => p.hit1).length, perfs.length),
    hit2Rate:                  rate(perfs.filter((p) => p.hit2).length, perfs.length),
    hit3Rate:                  rate(perfs.filter((p) => p.hit3).length, perfs.length),
    fail1Rate:                 rate(perfs.filter((p) => p.fail1).length, perfs.length),
    fail2Rate:                 rate(perfs.filter((p) => p.fail2).length, perfs.length),
    firstHit2BeforeFail1Rate:  rate(perfs.filter((p) => p.firstHit2BeforeFail1).length, perfs.length),
    firstHit3BeforeFail1Rate:  rate(perfs.filter((p) => p.firstHit3BeforeFail1).length, perfs.length),
  };
}

// ── 일자별 차트 baseRow 매핑 (코드별 1회 로드) ──
const chartCache = new Map();
function loadChartRows(code) {
  if (chartCache.has(code)) return chartCache.get(code);
  const p = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(p)) { chartCache.set(code, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    chartCache.set(code, j.rows || null);
    return j.rows || null;
  } catch (_) { chartCache.set(code, null); return null; }
}

// 분봉 디렉토리 일자(D+1)와 종목 → baseRow (D 일자, 전일 종가 확정) 추출
function findBaseRow(rows, nextDateNum) {
  if (!Array.isArray(rows)) return null;
  const idx = rows.findIndex((r) => r.date === nextDateNum);
  if (idx < 21) return null;  // 충분한 이력 필요 (avg20 계산용)
  return { baseIdx: idx - 1, baseRow: rows[idx - 1] };
}

// ── 일자별 분석 ──
function analyzeDay(dirName, metaMap, ruleKey) {
  const rule = RULES[ruleKey];
  const dir = path.join(INTRADAY_BASE, dirName);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;

  const nextDateNum = dirName.replace(/-/g, '');
  const entries = [];

  for (const fname of files) {
    const code = fname.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    if (!meta) continue;

    const rows = loadChartRows(code);
    if (!rows) continue;
    const baseInfo = findBaseRow(rows, nextDateNum);
    if (!baseInfo) continue;
    const baseRow = baseInfo.baseRow;
    if (!baseRow || !(baseRow.close > 0)) continue;

    // avg20 계산
    let sum = 0, n = 0;
    for (let i = baseInfo.baseIdx - 20; i < baseInfo.baseIdx; i++) {
      const r = rows[i];
      if (r && r.volume > 0) { sum += (r.valueApprox || 0); n++; }
    }
    const avg20 = n > 0 ? sum / n : 0;
    const baseValue = baseRow.valueApprox || 0;
    const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) continue;

    // 분봉 로드
    let bars = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8'));
      bars = j.bars || [];
    } catch (_) { continue; }
    if (bars.length === 0) continue;

    // 09:00~09:30 메트릭
    const m = scanner.computeMetrics0930(bars, baseRow);
    if (!m) continue;
    const status = classifyByRule(m, rule);
    const finalScore = m.bars_total >= MIN_BARS ? scanner.computeFinalScore(m) : 0;

    // 성과 측정: 09:30 close(=m.last0930) 대비 09:30~10:00
    const perf = measurePerformance(bars, m.last0930);

    entries.push({
      date: dirName,
      code,
      name: meta.name || code,
      market: meta.market || '',
      marketCap: meta.marketCap,
      baseDate: baseRow.date,
      metrics: m,
      status,
      finalScore,
      perf,
    });
  }
  return { dirName, nextDateNum, totalFiles: files.length, analyzedCount: entries.length, entries };
}

// ── rank별 분석 (READY 풀에서 finalScore 내림차순 후 rank 그룹화) ──
function analyzeByRank(allReady) {
  // allReady: 모든 일자의 READY entries (각 entry에 date 포함)
  // 일자별로 finalScore 내림차순 정렬 + rank 부여
  const byDate = new Map();
  for (const e of allReady) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => b.finalScore - a.finalScore);
    list.forEach((e, i) => { e.rankInDay = i + 1; });
  }
  const buckets = {
    'rank1_5':   allReady.filter((e) => e.rankInDay >= 1 && e.rankInDay <= 5),
    'rank6_10':  allReady.filter((e) => e.rankInDay >= 6 && e.rankInDay <= 10),
    'rank11_20': allReady.filter((e) => e.rankInDay >= 11 && e.rankInDay <= 20),
    'rank21_plus': allReady.filter((e) => e.rankInDay >= 21),
  };
  const result = {};
  for (const [k, list] of Object.entries(buckets)) result[k] = summarize(list);
  return result;
}

// ── 일자별 READY 개수 분포 ──
function dailyReadyDistribution(perDayResults) {
  const counts = perDayResults.map((d) => (d.statusCounts && d.statusCounts.READY) || 0);
  if (counts.length === 0) return { days: 0 };
  const sorted = [...counts].sort((a, b) => a - b);
  return {
    days: counts.length,
    avg: Number(avg(counts).toFixed(1)),
    median: Number(median(counts).toFixed(1)),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
    perDay: counts,
  };
}

// ── main ──
function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(INTRADAY_BASE)) {
    console.error('[ERROR] data/intraday/1ds 디렉토리가 없습니다.');
    process.exit(1);
  }

  console.log('\n📊 1DS 09:30 스캐너 백테스트');
  const t0 = Date.now();

  const metaMap = scanner.loadStockMetaMap();
  console.log(`  메타 로드: ${metaMap.size}건`);

  const allDirs = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  let dirs = allDirs;
  if (args.from) dirs = dirs.filter((d) => d >= args.from);
  if (args.to)   dirs = dirs.filter((d) => d <= args.to);
  // 백필 후보 풀(300+개)이 있는 일자만 (이전 운영 cron만 받은 일자는 ~50개라 백테스트 부적합)
  dirs = dirs.filter((d) => {
    const n = fs.readdirSync(path.join(INTRADAY_BASE, d)).length;
    return n >= args.minDirSize;
  });
  console.log(`  분봉 디렉토리: 전체 ${allDirs.length}개 → 백테스트 대상 ${dirs.length}개 (min-dir-size ${args.minDirSize})`);
  if (dirs.length === 0) {
    console.error('[ERROR] 백테스트 대상 일자 없음. --min-dir-size 낮춰 재시도하거나 백필 데이터 확인.');
    process.exit(1);
  }

  // ── 일자별 분석 — 룰 A/B/C 각각 ──
  const resultsByRule = {};
  for (const ruleKey of Object.keys(RULES)) {
    console.log(`\n  ▸ Rule ${ruleKey} (${RULES[ruleKey].label}):`);
    const perDay = [];
    for (const dirName of dirs) {
      const dayResult = analyzeDay(dirName, metaMap, ruleKey);
      if (!dayResult) continue;
      // status별 count
      const statusCounts = { READY: 0, WAIT_PULLBACK: 0, FADED: 0, WEAK: 0, INSUFFICIENT_BARS: 0 };
      for (const e of dayResult.entries) statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;
      dayResult.statusCounts = statusCounts;
      perDay.push(dayResult);
    }
    // 통합 집계
    const allEntries = perDay.flatMap((d) => d.entries);
    const byStatus = {};
    for (const e of allEntries) {
      if (!byStatus[e.status]) byStatus[e.status] = [];
      byStatus[e.status].push(e);
    }
    // READY 풀에서 rank 분석
    const readyAll = byStatus.READY || [];
    // 일자별 finalScore 내림차순 후 rank
    const readyByDate = new Map();
    for (const e of readyAll) {
      if (!readyByDate.has(e.date)) readyByDate.set(e.date, []);
      readyByDate.get(e.date).push(e);
    }
    for (const list of readyByDate.values()) {
      list.sort((a, b) => b.finalScore - a.finalScore);
      list.forEach((e, i) => { e.rankInDay = i + 1; });
    }
    const readyTop5  = readyAll.filter((e) => e.rankInDay <= 5);
    const readyTop10 = readyAll.filter((e) => e.rankInDay <= 10);
    const readyRest  = readyAll.filter((e) => e.rankInDay > args.readyTopLimit);
    const rankBuckets = analyzeByRank(readyAll);

    resultsByRule[ruleKey] = {
      rule: RULES[ruleKey],
      perDay: perDay.map((d) => ({ date: d.dirName, totalFiles: d.totalFiles, analyzedCount: d.analyzedCount, statusCounts: d.statusCounts })),
      dailyReadyDistribution: dailyReadyDistribution(perDay),
      summaries: {
        ALL_SCAN:        summarize(allEntries),
        READY_ALL:       summarize(readyAll),
        READY_TOP5:      summarize(readyTop5),
        READY_TOP10:     summarize(readyTop10),
        READY_REST:      summarize(readyRest),
        WAIT_PULLBACK:   summarize(byStatus.WAIT_PULLBACK || []),
        FADED:           summarize(byStatus.FADED || []),
        WEAK:            summarize(byStatus.WEAK || []),
        INSUFFICIENT_BARS: summarize(byStatus.INSUFFICIENT_BARS || []),
      },
      rankBuckets,
    };
    const dist = resultsByRule[ruleKey].dailyReadyDistribution;
    console.log(`     일자별 READY 분포: 평균 ${dist.avg} / median ${dist.median} / [${dist.min}~${dist.max}]`);
    console.log(`     ALL_SCAN n=${resultsByRule[ruleKey].summaries.ALL_SCAN.n} / READY n=${resultsByRule[ruleKey].summaries.READY_ALL.n}`);
  }

  // ── 추천 결론 ──
  const ruleA = resultsByRule.A.summaries;
  const recommendation = buildRecommendation(resultsByRule);

  const out = {
    meta: {
      title: '1DS 09:30 스캐너 백테스트',
      generatedAt: new Date().toISOString(),
      datesAnalyzed: dirs,
      minDirSize: args.minDirSize,
      readyTopLimit: args.readyTopLimit,
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(2)),
    },
    rules: RULES,
    resultsByRule,
    recommendation,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, renderHtml(out), 'utf-8');

  console.log(`\n  ⏱ 소요 ${out.meta.elapsedSec}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
  console.log(`\n  📌 결론: ${recommendation.summaryLine}`);
}

// ── 추천 결론 빌더 ──
function buildRecommendation(resultsByRule) {
  const a = resultsByRule.A;
  const ready = a.summaries.READY_ALL;
  const top5 = a.summaries.READY_TOP5;
  const top10 = a.summaries.READY_TOP10;
  const rest = a.summaries.READY_REST;
  const dist = a.dailyReadyDistribution;

  // top5의 hit2 - rest의 hit2 차이로 "rank 상위가 의미 있는가" 판단
  const top5Edge = (top5.firstHit2BeforeFail1Rate || 0) - (rest.firstHit2BeforeFail1Rate || 0);
  const top10Edge = (top10.firstHit2BeforeFail1Rate || 0) - (rest.firstHit2BeforeFail1Rate || 0);

  // 추천 노출 수 결정
  let recommendedTop = 5;
  let reasoning = '';
  if (top5Edge >= 5) {
    recommendedTop = 5;
    reasoning = `TOP5의 firstHit2BeforeFail1Rate가 REST보다 ${top5Edge.toFixed(1)}%p 높음 → 상위 5개에 압축 노출 권장`;
  } else if (top10Edge >= 3) {
    recommendedTop = 10;
    reasoning = `TOP5와 TOP10 차이는 작지만 TOP10이 REST보다 ${top10Edge.toFixed(1)}%p 우위 → 상위 10개 노출 권장`;
  } else {
    recommendedTop = ready.n / dist.days >= 5 ? 5 : Math.max(3, Math.round(dist.avg / 2));
    reasoning = `TOP5/TOP10/REST 간 성과 차이가 작음 — 단순히 일자별 READY 절반(${recommendedTop}개)만 노출하는 게 적절`;
  }

  const summaryLine = `Rule A 기준 일자별 READY 평균 ${dist.avg}개. TOP5 firstHit2BeforeFail1=${top5.firstHit2BeforeFail1Rate}%, REST=${rest.firstHit2BeforeFail1Rate}%. 추천 노출: 상위 ${recommendedTop}개`;

  return {
    recommendedTop,
    reasoning,
    summaryLine,
    metrics: {
      readyPerDay_avg: dist.avg,
      readyPerDay_median: dist.median,
      top5_firstHit2BeforeFail1Rate: top5.firstHit2BeforeFail1Rate,
      top10_firstHit2BeforeFail1Rate: top10.firstHit2BeforeFail1Rate,
      rest_firstHit2BeforeFail1Rate: rest.firstHit2BeforeFail1Rate,
      top5_avgMaxReturn: top5.avgMaxReturnTo1000,
      top10_avgMaxReturn: top10.avgMaxReturnTo1000,
      rest_avgMaxReturn: rest.avgMaxReturnTo1000,
    },
  };
}

// ── HTML 리포트 ──
function renderHtml(out) {
  function fmtPct(v) { return v == null ? '-' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function fmtRate(v) { return v == null ? '-' : v.toFixed(1) + '%'; }
  function summaryRow(label, s) {
    if (!s || s.n === 0) return `<tr><td>${label}</td><td>0</td><td colspan="11" style="color:#888;text-align:left;">샘플 없음</td></tr>`;
    return `<tr>
      <td><strong>${label}</strong></td>
      <td>${s.n}</td>
      <td class="num">${fmtPct(s.avgMaxReturnTo1000)}</td>
      <td class="num">${fmtPct(s.medianMaxReturnTo1000)}</td>
      <td class="num">${fmtPct(s.avgReturnAt1000)}</td>
      <td class="num">${fmtPct(s.avgDrawdown)}</td>
      <td class="num">${fmtRate(s.hit1Rate)}</td>
      <td class="num">${fmtRate(s.hit2Rate)}</td>
      <td class="num">${fmtRate(s.hit3Rate)}</td>
      <td class="num">${fmtRate(s.fail1Rate)}</td>
      <td class="num">${fmtRate(s.fail2Rate)}</td>
      <td class="num"><strong>${fmtRate(s.firstHit2BeforeFail1Rate)}</strong></td>
      <td class="num">${fmtRate(s.firstHit3BeforeFail1Rate)}</td>
    </tr>`;
  }
  const tableHead = `<thead><tr>
    <th>그룹</th><th>n</th>
    <th>avg max</th><th>median max</th><th>avg @10:00</th><th>avg DD</th>
    <th>hit1</th><th>hit2</th><th>hit3</th>
    <th>fail1</th><th>fail2</th>
    <th>hit2前fail1</th><th>hit3前fail1</th>
  </tr></thead>`;

  function statusTable(ruleKey) {
    const r = out.resultsByRule[ruleKey];
    if (!r) return '';
    const s = r.summaries;
    const rows = [
      summaryRow('전체 스캔 대상',  s.ALL_SCAN),
      summaryRow('READY ALL',     s.READY_ALL),
      summaryRow('READY TOP5',    s.READY_TOP5),
      summaryRow('READY TOP10',   s.READY_TOP10),
      summaryRow('READY REST',    s.READY_REST),
      summaryRow('WAIT_PULLBACK', s.WAIT_PULLBACK),
      summaryRow('FADED',         s.FADED),
      summaryRow('WEAK',          s.WEAK),
      summaryRow('INSUFFICIENT_BARS', s.INSUFFICIENT_BARS),
    ].join('');
    return `<table class="bt-table">${tableHead}<tbody>${rows}</tbody></table>`;
  }
  function rankTable(ruleKey) {
    const r = out.resultsByRule[ruleKey];
    if (!r || !r.rankBuckets) return '';
    const rb = r.rankBuckets;
    const rows = [
      summaryRow('rank 1~5',   rb.rank1_5),
      summaryRow('rank 6~10',  rb.rank6_10),
      summaryRow('rank 11~20', rb.rank11_20),
      summaryRow('rank 21+',   rb.rank21_plus),
    ].join('');
    return `<table class="bt-table">${tableHead}<tbody>${rows}</tbody></table>`;
  }
  function distChart(ruleKey) {
    const r = out.resultsByRule[ruleKey];
    if (!r) return '';
    const dist = r.dailyReadyDistribution;
    const rows = r.perDay.map((d) => `<tr><td>${d.date}</td><td class="num">${d.totalFiles}</td><td class="num">${d.analyzedCount}</td><td class="num">${d.statusCounts.READY}</td><td class="num">${d.statusCounts.WAIT_PULLBACK}</td><td class="num">${d.statusCounts.FADED}</td><td class="num">${d.statusCounts.WEAK}</td><td class="num">${d.statusCounts.INSUFFICIENT_BARS}</td></tr>`).join('');
    return `<div class="bt-stat">일자별 READY 평균 <strong>${dist.avg}</strong> / median ${dist.median} / 범위 ${dist.min}~${dist.max} (${dist.days}일)</div>
      <table class="bt-table small"><thead><tr><th>날짜</th><th>files</th><th>분석</th><th>READY</th><th>WAIT</th><th>FADED</th><th>WEAK</th><th>INSUFF</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  const reco = out.recommendation;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>1DS 09:30 스캐너 백테스트 결과</title>
<style>
  body { margin: 0 auto; max-width: 1400px; padding: 20px; font-family: -apple-system, "Segoe UI", "Noto Sans KR", sans-serif; background: #0f172a; color: #e2e8f0; font-size: 13px; }
  h1 { color: #5eead4; }
  h2 { color: #fde68a; border-bottom: 1px solid #334155; padding-bottom: 6px; margin-top: 28px; }
  .reco-box { background: linear-gradient(135deg, #042f2e 0%, #1e293b 100%); border: 2px solid #14b8a6; padding: 16px; border-radius: 10px; margin: 14px 0; }
  .reco-box strong { color: #6ee7b7; font-size: 16px; }
  .reco-line { font-size: 14px; color: #a7f3d0; margin: 6px 0; }
  .bt-table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
  .bt-table th, .bt-table td { border: 1px solid #334155; padding: 5px 7px; text-align: left; }
  .bt-table th { background: #1e293b; color: #cbd5e1; font-weight: 700; }
  .bt-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bt-table tbody tr:nth-child(odd) { background: rgba(30, 41, 59, 0.4); }
  .bt-table.small { font-size: 11px; }
  .bt-stat { padding: 6px 10px; background: #1e293b; border-left: 3px solid #5eead4; margin: 8px 0; }
  .rule-tabs { display: flex; gap: 6px; margin: 10px 0; }
  .rule-tab { padding: 8px 14px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; cursor: pointer; color: #94a3b8; }
  .rule-tab.active { background: #042f2e; border-color: #14b8a6; color: #6ee7b7; font-weight: 700; }
  .rule-panel { display: none; }
  .rule-panel.active { display: block; }
  .intro { color: #cbd5e1; line-height: 1.7; padding: 12px; background: #1e293b; border-radius: 8px; margin: 12px 0; }
  .intro code { background: #0f172a; padding: 2px 6px; border-radius: 3px; color: #fde68a; }
  .meta { color: #94a3b8; font-size: 12px; }
</style>
</head><body>

<h1>📊 1DS 09:30 스캐너 백테스트 결과</h1>
<div class="meta">생성: ${out.meta.generatedAt} · 분석 일자 ${out.meta.datesAnalyzed.length}일 (${out.meta.datesAnalyzed[0]} ~ ${out.meta.datesAnalyzed[out.meta.datesAnalyzed.length - 1]}) · 소요 ${out.meta.elapsedSec}s</div>

<h2>🎯 요약 결론</h2>
<div class="reco-box">
  <strong>${reco.summaryLine}</strong>
  <div class="reco-line">→ ${reco.reasoning}</div>
  <div class="reco-line">→ <strong>추천: 화면 상단 readyTop을 ${reco.recommendedTop}개로 노출</strong></div>
</div>

<div class="intro">
<strong>📖 이 보고서가 검증하는 것</strong><br>
1DS 09:30 스캐너가 화면에 보여주는 READY 후보 수가 실전적으로 적당한가?<br>
"적당하다" = 상위 N개에 들어간 후보가 9:30~10:00 동안 평균 수익률·hit rate가 REST/WEAK/FADED보다 의미 있게 높다.<br>
<br>
<strong>📊 지표 의미 (초보자용)</strong><br>
· <code>n</code>: 표본 수 (해당 그룹의 종목·일자 조합 수)<br>
· <code>avg max</code>: 09:30 close 대비 09:30~10:00 분봉 high 최대 상승률의 평균<br>
· <code>avg @10:00</code>: 09:30 close 대비 10:00 종가 수익률 평균 (실제로 30분 보유했을 때 수익)<br>
· <code>avg DD</code>: 평균 최대 낙폭 (drawdown — 보유 중 떨어진 정도)<br>
· <code>hit1/2/3</code>: 09:30 대비 +1%/+2%/+3% 도달률<br>
· <code>fail1/2</code>: 09:30 대비 -1%/-2% 하락률<br>
· <code>hit2前fail1</code>: <strong>+2%에 fail1(-1%)보다 먼저 도달한 비율 — 실전 손익비 핵심 지표</strong><br>
· <code>hit3前fail1</code>: +3%에 -1%보다 먼저 도달한 비율
</div>

<h2>📋 룰 A (현재 기준) — 상태별 성과</h2>
${statusTable('A')}

<h2>🎯 룰 A — finalScore rank별 성과</h2>
${rankTable('A')}

<h2>📅 룰 A — 일자별 READY 개수 분포</h2>
${distChart('A')}

<h2>🔬 조건 민감도 비교 — A 현재 / B 강한 / C 완화</h2>
<div class="intro">
  · <strong>A 현재</strong>: value≥10억 / v/avg≥3 / cp≥0.65 / drop>-2.5% / up 1~8%<br>
  · <strong>B 강한</strong>: value≥20억 / v/avg≥5 / cp≥0.75 / drop>-1.5% / up 2~6.5%<br>
  · <strong>C 완화</strong>: value≥7억 / v/avg≥2.5 / cp≥0.6 / drop>-3% / up 0.8~8%
</div>

<div class="rule-tabs">
  <span class="rule-tab active" data-rule="A">A 현재</span>
  <span class="rule-tab" data-rule="B">B 강한</span>
  <span class="rule-tab" data-rule="C">C 완화</span>
</div>
<div class="rule-panel active" id="panel-A"><h3>A 현재</h3>${statusTable('A')}<h4>rank별</h4>${rankTable('A')}<h4>일자별</h4>${distChart('A')}</div>
<div class="rule-panel" id="panel-B"><h3>B 강한</h3>${statusTable('B')}<h4>rank별</h4>${rankTable('B')}<h4>일자별</h4>${distChart('B')}</div>
<div class="rule-panel" id="panel-C"><h3>C 완화</h3>${statusTable('C')}<h4>rank별</h4>${rankTable('C')}<h4>일자별</h4>${distChart('C')}</div>

<script>
  document.querySelectorAll('.rule-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const r = tab.dataset.rule;
      document.querySelectorAll('.rule-tab').forEach((t) => t.classList.toggle('active', t.dataset.rule === r));
      document.querySelectorAll('.rule-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + r));
    });
  });
</script>

</body></html>`;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}

module.exports = { main };
