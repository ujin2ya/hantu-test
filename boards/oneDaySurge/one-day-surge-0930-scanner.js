#!/usr/bin/env node
/**
 * 1-Day Surge — 09:30 실시간 포착 스캐너
 *
 * 전일 mainPool 후보만 보는 기존 1DS 보드와 별개로, 09:30 시점에 실제로 강한 종목을
 * 새로 뽑는 스캐너. 분봉이 들어와 있는 모든 종목(유동성 통과 + 다음 거래일 분봉 존재)을
 * 대상으로 09:00~09:30 분봉을 분석하고 READY/WAIT_PULLBACK/FADED/WEAK/INSUFFICIENT_BARS로
 * 분류한다.
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json   (일봉 — 유동성 필터)
 *   - cache/naver-stocks-list.json          (meta — ETF/특수/시총)
 *   - stocks.json                            (보조)
 *   - data/intraday/1ds/{nextDate}/{code}.json (09:00~09:30 분봉)
 *
 * 출력:
 *   - reports/one-day-surge-0930-scanner.json
 *
 * CLI:
 *   node boards/oneDaySurge/one-day-surge-0930-scanner.js
 *   node boards/oneDaySurge/one-day-surge-0930-scanner.js --next-date 2026-05-14
 *   node boards/oneDaySurge/one-day-surge-0930-scanner.js --top 50
 *
 * 분봉 수집은 이 스캐너가 직접 하지 않는다. KIS API 호출 부담을 줄이기 위해
 * pipeline/collect-1ds-intraday.js (--from-scanner 모드)가 따로 책임진다.
 * 이 스캐너는 이미 수집된 분봉 파일만 읽는다 (분봉이 없는 종목은 INSUFFICIENT_BARS X
 * — 후보 풀에서 아예 제외하고 통계에만 카운트).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const STOCKS_PATH = path.join(ROOT, 'stocks.json');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-0930-scanner.json');

const core = require('./one-day-surge-core');

// ── 스캐너 임계값 (사용자 명시 + 일부 튜닝) ──
const CONFIG = {
  // 유동성 필터 — 사용자 명시
  MIN_AVG20_VALUE: 1e9,         // 최근 20일 평균 거래대금 ≥ 10억
  MIN_BASE_VALUE:  2e9,         // 또는 전일 거래대금 ≥ 20억
  MIN_MARKET_CAP:  5e10,        // 시가총액 ≥ 500억
  MAX_MARKET_CAP:  5e12,        // 5조 이상 단타 부적합

  // READY 조건 — 사용자 명시
  MIN_BARS:               20,    // 분봉 수 ≥ 20개
  MIN_VALUE_0930:         1e9,   // 09:00~09:30 누적 거래대금 ≥ 10억
  MIN_VALUE_AVG_RATIO:    3,     // 09:30 거래대금 / 평균 30분 추정 ≥ 3
  MIN_CLOSE_POSITION:     0.65,  // 09:30 close 위치 ≥ 0.65
  MAX_HIGH_TO_LAST_DROP: -2.5,   // 고점 대비 -2.5%↑ 빠지면 FADED (%)
  MIN_OPEN_TO_LAST_RATE:  1.0,   // 시가 대비 +1%↑ (%)
  MAX_OPEN_TO_LAST_RATE:  8.0,   // 시가 대비 +8%↑ 시 WAIT_PULLBACK (%)
};

// 상태 한국어 라벨
const STATUS_LABEL = {
  READY:             '09:30 기준 강한 상태 유지',
  WAIT_PULLBACK:     '이미 +8% 이상 올라 추격 부담',
  FADED:             '장초 고점 대비 다시 밀림',
  WEAK:              '시가 대비 약하거나 거래대금 부족',
  INSUFFICIENT_BARS: '분봉 부족 (≥20개 필요)',
};

function parseArgs(argv) {
  const args = { nextDate: null, top: 50, mode: 'quick', candidatesTarget: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--next-date') args.nextDate = argv[++i];
    else if (a === '--top') args.top = Number(argv[++i]) || 50;
    else if (a === '--mode') args.mode = argv[++i] || 'quick';
    else if (a === '--candidates-target') args.candidatesTarget = Number(argv[++i]) || null;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node one-day-surge-0930-scanner.js [--next-date YYYY-MM-DD] [--top N] [--mode quick|full] [--candidates-target N]`);
      console.log(`  --mode quick: 빠른 결과 (메인풀 분봉만, default). --mode full: 확장 스캐너 후보 분봉까지 반영.`);
      console.log(`  --candidates-target N: 분봉 수집 단계에서 시도한 후보 수 (메타 표시용).`);
      process.exit(0);
    }
  }
  if (!['quick', 'full'].includes(args.mode)) args.mode = 'quick';
  return args;
}

function loadStockMetaMap() {
  const map = new Map();
  if (fs.existsSync(STOCKS_PATH)) {
    try {
      const j = JSON.parse(fs.readFileSync(STOCKS_PATH, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (s.shortCode) map.set(s.shortCode, { name: s.name, market: s.market });
      }
    } catch (_) {}
  }
  if (fs.existsSync(NAVER_LIST_PATH)) {
    try {
      const j = JSON.parse(fs.readFileSync(NAVER_LIST_PATH, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (!s.code) continue;
        const cur = map.get(s.code) || {};
        map.set(s.code, {
          ...cur,
          name: s.name || cur.name,
          market: s.market || cur.market,
          marketCap: s.marketValue || 0,
          isEtf: !!s.isEtf,
          isSpecial: !!s.isSpecial,
        });
      }
    } catch (_) {}
  }
  return map;
}

// 분봉 디렉토리 자동 선택 — 가장 최근 거래일 (또는 --next-date 강제)
function pickIntradayDate(forced) {
  if (forced) return forced;
  if (!fs.existsSync(INTRADAY_BASE)) return null;
  const dirs = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return dirs.length > 0 ? dirs[dirs.length - 1] : null;
}

// 유동성 + 종목 자격 hard 컷
function passesLiquidityFilter(meta, avg20, baseValue) {
  if (!meta) return { ok: false, reason: 'no_meta' };
  if (meta.isEtf) return { ok: false, reason: 'etf' };
  if (meta.isSpecial) return { ok: false, reason: 'special' };
  if (core.isExcludedByName(meta.name)) return { ok: false, reason: 'excluded_name' };
  const mc = Number(meta.marketCap) || 0;
  if (mc <= 0) return { ok: false, reason: 'no_marketcap' };
  if (mc < CONFIG.MIN_MARKET_CAP) return { ok: false, reason: 'mc_under_500' };
  if (mc >= CONFIG.MAX_MARKET_CAP) return { ok: false, reason: 'mc_over_5t' };
  if (avg20 < CONFIG.MIN_AVG20_VALUE && baseValue < CONFIG.MIN_BASE_VALUE) {
    return { ok: false, reason: 'low_liquidity' };
  }
  return { ok: true };
}

// 09:00~09:30 분봉 → 메트릭 계산
function computeMetrics0930(bars, baseRow) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const bars0_30 = bars.filter((b) => b.time && b.time <= '09:30' && b.close > 0);
  if (bars0_30.length === 0) return null;

  const firstBar = bars0_30.find((b) => b.open > 0) || bars0_30[0];
  const lastBar  = bars0_30[bars0_30.length - 1];
  const open0900 = firstBar.open;
  const last0930 = lastBar.close;

  let high = 0, low = Infinity, value = 0, volume = 0;
  for (const b of bars0_30) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    value += (b.value || 0);
    volume += (b.volume || 0);
  }
  const range = high - low;
  const closePosition = range > 0 ? (last0930 - low) / range : 0.5;
  const openToLastRate = open0900 > 0 ? (last0930 / open0900 - 1) * 100 : null;
  const highToLastDrop = high > 0 ? (last0930 / high - 1) * 100 : null;
  // 평균 30분 추정 거래대금 = 전일 거래대금 / 13 (장 6.5h ÷ 0.5h)
  const avgPer30min = baseRow && baseRow.valueApprox > 0 ? baseRow.valueApprox / 13 : 0;
  const valueToAvgRatio_0930 = avgPer30min > 0 ? value / avgPer30min : null;

  // 첫 10분 고점 재돌파
  const bars0_10  = bars0_30.filter((b) => b.time <= '09:10');
  const bars10_30 = bars0_30.filter((b) => b.time > '09:10');
  const max0_10  = bars0_10.length ? Math.max(...bars0_10.map((b) => b.high || 0)) : 0;
  const max10_30 = bars10_30.length ? Math.max(...bars10_30.map((b) => b.high || 0)) : 0;
  const rebreakMorningHigh = max10_30 > max0_10;

  return {
    bars_total: bars0_30.length,
    open0900,
    last0930,
    high0930: high,
    low0930: low === Infinity ? null : low,
    value_0930: value,
    volume_0930: volume,
    closePosition0930: Number(closePosition.toFixed(3)),
    openToLastRate: openToLastRate != null ? Number(openToLastRate.toFixed(2)) : null,
    highToLastDrop: highToLastDrop != null ? Number(highToLastDrop.toFixed(2)) : null,
    valueToAvgRatio_0930: valueToAvgRatio_0930 != null ? Number(valueToAvgRatio_0930.toFixed(2)) : null,
    rebreakMorningHigh,
  };
}

// 상태 분류 (배타, 우선순위: INSUFFICIENT > FADED > WAIT_PULLBACK > WEAK > READY)
function classifyStatus(m) {
  if (!m || m.bars_total < CONFIG.MIN_BARS) return 'INSUFFICIENT_BARS';
  if (m.highToLastDrop != null && m.highToLastDrop <= CONFIG.MAX_HIGH_TO_LAST_DROP) return 'FADED';
  if (m.openToLastRate != null && m.openToLastRate >= CONFIG.MAX_OPEN_TO_LAST_RATE) return 'WAIT_PULLBACK';
  // WEAK 컷: 시가 대비 약함 / 거래대금 부족 / close 위치 낮음 / 거래대금 비율 부족
  if (m.openToLastRate == null || m.openToLastRate < CONFIG.MIN_OPEN_TO_LAST_RATE) return 'WEAK';
  if (m.value_0930 < CONFIG.MIN_VALUE_0930) return 'WEAK';
  if (m.valueToAvgRatio_0930 != null && m.valueToAvgRatio_0930 < CONFIG.MIN_VALUE_AVG_RATIO) return 'WEAK';
  if (m.closePosition0930 < CONFIG.MIN_CLOSE_POSITION) return 'WEAK';
  return 'READY';
}

// 정렬 — READY 풀: openToLastRate × valueToAvgRatio 곱이 높은 순
function readyScore(m) {
  const a = (m.openToLastRate || 0);
  const b = (m.valueToAvgRatio_0930 || 0);
  return a * Math.sqrt(b);
}

// finalScore — READY 후보 중 "실전 우선 후보" 선출용 종합 점수.
// 거래대금 / v/avg 비율 / 종가 위치 / 첫 10분 고점 재돌파 / 고점 대비 유지력 / 시가 대비 상승률을
// 가중 합산. 사용자 요구: "실전 우선 후보"는 상위 5개만 추출하므로 정렬 기준 강화 필요.
function computeFinalScore(m) {
  if (!m) return 0;
  const valScore     = (m.value_0930 || 0) / 1e8 * 0.3;            // 09:30 누적 거래대금 (1억 단위, 0.3 가중)
  const ratioScore   = (m.valueToAvgRatio_0930 || 0) * 3;          // 평균 30분 대비 비율 (3배 가중)
  const cpScore      = (m.closePosition0930 || 0) * 15;            // 종가 위치 0~1 → 0~15점
  const upScore      = Math.max(0, m.openToLastRate || 0) * 1.5;   // 시가 대비 양봉 (1~8% 영역)
  // 고점 대비 유지력 (마지막 10분 유지력 대용) — drop이 0%에 가까울수록 가산, -2.5% 이하면 0
  const drop = m.highToLastDrop;
  const holdScore = drop == null ? 0
    : drop >= -0.5 ? 10       // 거의 고점 근처
    : drop >= -1.0 ? 7
    : drop >= -1.5 ? 5
    : drop >= -2.0 ? 3
    : drop >= -2.5 ? 1
    : 0;
  const rebreakBonus = m.rebreakMorningHigh ? 8 : 0;               // 첫 10분 고점 재돌파 ✓
  return Number((valScore + ratioScore + cpScore + upScore + holdScore + rebreakBonus).toFixed(2));
}

function fmtDate(d) {
  if (!d) return '-';
  const s = String(d);
  return s.includes('-') ? s : s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}

function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date();
  const t0 = Date.now();
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(CHART_DIR)) {
    console.error('[ERROR] cache/stock-charts-long 디렉토리가 없습니다.');
    process.exit(1);
  }

  const nextDate = pickIntradayDate(args.nextDate);
  if (!nextDate) {
    console.error('[ERROR] data/intraday/1ds 안에 분봉 디렉토리가 없습니다. 먼저 분봉을 수집하세요.');
    process.exit(1);
  }
  const intradayDir = path.join(INTRADAY_BASE, nextDate);
  console.log(`\n📡 1DS 09:30 실시간 스캐너 [mode=${args.mode}] — 분봉 디렉토리: ${nextDate}`);
  if (args.candidatesTarget) console.log(`  (확장 스캔 후보 목표 ${args.candidatesTarget}개)`);

  const metaMap = loadStockMetaMap();
  const intradayFiles = fs.existsSync(intradayDir)
    ? fs.readdirSync(intradayDir).filter((f) => f.endsWith('.json'))
    : [];
  console.log(`  분봉 파일: ${intradayFiles.length}건 (대상 후보군)`);

  const liquidityRejectCounts = { no_meta: 0, etf: 0, special: 0, excluded_name: 0, no_marketcap: 0, mc_under_500: 0, mc_over_5t: 0, low_liquidity: 0, no_chart: 0, short_history: 0 };
  const statusBuckets = { READY: [], WAIT_PULLBACK: [], FADED: [], WEAK: [], INSUFFICIENT_BARS: [] };

  for (const fname of intradayFiles) {
    const code = fname.replace(/\.json$/, '');
    const meta = metaMap.get(code);

    // 차트 일봉 → 유동성 필터
    const chartPath = path.join(CHART_DIR, fname);
    if (!fs.existsSync(chartPath)) { liquidityRejectCounts.no_chart++; continue; }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8')); } catch (_) { liquidityRejectCounts.no_chart++; continue; }
    const rows = chart && chart.rows;
    const baseIdx = core.pickLatestBaseIdx(rows);
    if (baseIdx < 20) { liquidityRejectCounts.short_history++; continue; }

    // avg20Value / baseValue
    let sum = 0, n = 0;
    for (let i = baseIdx - 20; i < baseIdx; i++) {
      const r = rows[i];
      if (r && r.volume > 0) { sum += (r.valueApprox || 0); n++; }
    }
    const avg20 = n > 0 ? sum / n : 0;
    const baseRow = rows[baseIdx];
    const baseValue = (baseRow && baseRow.valueApprox) || 0;

    const liq = passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) {
      liquidityRejectCounts[liq.reason] = (liquidityRejectCounts[liq.reason] || 0) + 1;
      continue;
    }

    // 분봉 읽기
    let bars;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(intradayDir, fname), 'utf-8'));
      bars = j.bars || [];
    } catch (_) { continue; }

    const m = computeMetrics0930(bars, baseRow);
    const status = classifyStatus(m);
    const entry = {
      code,
      name: (meta && meta.name) || (chart && chart.name) || code,
      market: (meta && meta.market) || (chart && chart.market) || '',
      marketCap: meta.marketCap,
      baseDate: baseRow && baseRow.date,
      avg20Value: Math.round(avg20),
      baseValue: Math.round(baseValue),
      metrics: m,
      status,
      statusLabel: STATUS_LABEL[status],
      score:      m ? Number(readyScore(m).toFixed(2)) : 0,
      finalScore: m ? computeFinalScore(m) : 0,
    };
    if (!statusBuckets[status]) statusBuckets[status] = [];
    statusBuckets[status].push(entry);
  }

  // 각 풀 정렬 — READY는 finalScore(실전 우선 후보 선출용 종합 점수) 내림차순
  statusBuckets.READY.sort((a, b) => b.finalScore - a.finalScore);
  statusBuckets.WAIT_PULLBACK.sort((a, b) => (b.metrics.openToLastRate || 0) - (a.metrics.openToLastRate || 0));
  statusBuckets.FADED.sort((a, b) => (a.metrics.highToLastDrop || 0) - (b.metrics.highToLastDrop || 0));
  statusBuckets.WEAK.sort((a, b) => (b.metrics.openToLastRate || 0) - (a.metrics.openToLastRate || 0));

  // top N으로 자르기 (WEAK/INSUFFICIENT는 다 보관할 필요 없음 — top * 2 정도까지)
  const TOP = Math.max(1, args.top);
  const READY_TOP_LIMIT = 5;  // "실전 우선 후보" — 화면 상단 압축 노출
  const ready    = statusBuckets.READY.slice(0, TOP);
  const readyTop  = statusBuckets.READY.slice(0, READY_TOP_LIMIT);
  const readyRest = statusBuckets.READY.slice(READY_TOP_LIMIT, TOP);
  const wait     = statusBuckets.WAIT_PULLBACK.slice(0, TOP);
  const faded    = statusBuckets.FADED.slice(0, TOP);
  const weak     = statusBuckets.WEAK.slice(0, Math.min(TOP, 50));
  const insuff   = statusBuckets.INSUFFICIENT_BARS;

  const finishedAt = new Date();
  const elapsedSec = Number(((Date.now() - t0) / 1000).toFixed(2));
  const totalAnalyzed = statusBuckets.READY.length + statusBuckets.WAIT_PULLBACK.length + statusBuckets.FADED.length + statusBuckets.WEAK.length + statusBuckets.INSUFFICIENT_BARS.length;
  const out = {
    meta: {
      title: '1-Day Surge — 09:30 실시간 포착 스캐너',
      mode: args.mode,                                  // 'quick' | 'full'
      candidatesTarget: args.candidatesTarget || null,  // 분봉 수집 단계에서 시도한 후보 수 (외부 정보)
      scannedCount: intradayFiles.length,               // 분봉 파일 수 (= 분봉 수집 성공 종목 수)
      successCount: totalAnalyzed,                       // 유동성 통과 + 메트릭 계산 성공 종목 수
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      elapsedSec,
      generatedAt: finishedAt.toISOString(),
      nextDate,
      intradayDir,
      config: CONFIG,
      basis: '09:00~09:30 분봉 기준 실시간 포착. 전일 mainPool과 무관. 분봉 미수집 종목은 후보군에서 제외.',
    },
    counts: {
      intradayFiles: intradayFiles.length,
      liquidityRejected: Object.values(liquidityRejectCounts).reduce((a, b) => a + b, 0),
      liquidityRejectBreakdown: liquidityRejectCounts,
      READY: statusBuckets.READY.length,
      WAIT_PULLBACK: statusBuckets.WAIT_PULLBACK.length,
      FADED: statusBuckets.FADED.length,
      WEAK: statusBuckets.WEAK.length,
      INSUFFICIENT_BARS: statusBuckets.INSUFFICIENT_BARS.length,
    },
    statusLabels: STATUS_LABEL,
    scanner0930Ready:    ready,                 // 전체 READY (호환성 유지)
    scanner0930ReadyTop:  readyTop,              // 상위 5 — 실전 우선 후보
    scanner0930ReadyRest: readyRest,             // 6번째 이후 READY — 1차 통과 후보 (접힘)
    readyTopLimit: READY_TOP_LIMIT,
    scanner0930Holding:  [...wait, ...faded],   // WAIT_PULLBACK + FADED 합쳐서 "보류/재관찰"
    scanner0930Rejected: weak,                  // WEAK
    insufficientBarsCount: insuff.length,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // 콘솔 로그
  if (args.candidatesTarget) {
    console.log(`  📊 mode=${args.mode} / 확장 스캔 ${args.candidatesTarget}개 시도 → 분봉 수집 ${intradayFiles.length}개 (${(intradayFiles.length / args.candidatesTarget * 100).toFixed(1)}%)`);
  } else {
    console.log(`  📊 mode=${args.mode} / 분봉 파일 ${intradayFiles.length}개`);
  }
  console.log(`  09:30 스캔 대상: ${intradayFiles.length}개 (분봉 파일 기준)`);
  console.log(`  유동성 필터 제외: ${out.counts.liquidityRejected}개`);
  for (const [reason, n] of Object.entries(liquidityRejectCounts)) {
    if (n > 0) console.log(`     - ${reason}: ${n}개`);
  }
  console.log(`  📊 상태 분류:`);
  console.log(`     READY              ${statusBuckets.READY.length}개 — ${STATUS_LABEL.READY}`);
  console.log(`     WAIT_PULLBACK      ${statusBuckets.WAIT_PULLBACK.length}개 — ${STATUS_LABEL.WAIT_PULLBACK}`);
  console.log(`     FADED              ${statusBuckets.FADED.length}개 — ${STATUS_LABEL.FADED}`);
  console.log(`     WEAK               ${statusBuckets.WEAK.length}개 — ${STATUS_LABEL.WEAK}`);
  console.log(`     INSUFFICIENT_BARS  ${statusBuckets.INSUFFICIENT_BARS.length}개 — ${STATUS_LABEL.INSUFFICIENT_BARS}`);
  if (readyTop.length > 0) {
    console.log(`\n  🎯 실전 우선 후보 (readyTop ${readyTop.length}건, finalScore 내림차순):`);
    for (const e of readyTop) {
      const m = e.metrics;
      console.log(`     final ${e.finalScore.toFixed(1).padStart(6)} | ${e.code} ${(e.name || '').padEnd(15)} | +${(m.openToLastRate || 0).toFixed(2)}% | v ${(m.value_0930 / 1e8).toFixed(0)}억 (x${(m.valueToAvgRatio_0930 || 0).toFixed(1)}) | cp ${(m.closePosition0930 * 100).toFixed(0)}% | drop ${(m.highToLastDrop || 0).toFixed(2)}%${m.rebreakMorningHigh ? ' | ↗MH재돌파' : ''}`);
    }
  }
  if (readyRest.length > 0) {
    console.log(`\n  📋 1차 통과 후보 (readyRest ${readyRest.length}건, 화면 접힘):`);
    for (const e of readyRest.slice(0, 15)) {
      console.log(`     final ${e.finalScore.toFixed(1).padStart(6)} | ${e.code} ${(e.name || '').padEnd(15)}`);
    }
    if (readyRest.length > 15) console.log(`     ... 외 ${readyRest.length - 15}건`);
  }
  console.log(`\n  ⏱ 소요 ${elapsedSec}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}

module.exports = {
  CONFIG,
  STATUS_LABEL,
  computeMetrics0930,
  classifyStatus,
  passesLiquidityFilter,
  main,
};
