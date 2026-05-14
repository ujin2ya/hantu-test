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

// ── 공격형 재돌파 후보 (I 조건) — 19일 백테스트 결과 반영 ──
// 조건 (사용자 명세):
//   - value_0930 >= 21억 / cp ≥ 0.50 / drop ≥ -2.70 / open ≥ 0.50 / ratio ≥ 3
//   - rebreakMorningHigh = true
//   - status ∈ {READY, FADED}
//   - marketCap ≤ 5조
//   - triggeredHypos에 TEN_REBREAK 포함 (= hasTenRebreak)
// 가설 trigger는 trigger 시점 이전 분봉만 사용 (미래 누수 없음).
function barsInRangeExc(bars, fromExc, toInc) {
  return bars.filter((b) => b && b.time && b.close > 0 && b.time > fromExc && b.time <= toInc);
}
function sumBarValue(arr) { return arr.reduce((s, b) => s + (b.value || 0), 0); }

// TEN_REBREAK 가설: 09:00~09:30 거래대금 ≥10억 + drop ≥ -4 + 09:31~10:30 사이 09:30 high 재돌파
// (재돌파 분봉 value > 직전 5분 평균 × 2). 분봉이 09:30 까지밖에 없으면 trigger 안 됨 (false 반환).
function detectTenRebreak(bars, m) {
  if (!m) return false;
  if ((m.value_0930 || 0) < 1e9) return false;
  if (m.highToLastDrop != null && m.highToLastDrop < -4) return false;
  const win = barsInRangeExc(bars, '09:30', '10:30');
  if (win.length < 5) return false;
  for (let i = 0; i < win.length; i++) {
    const b = win[i];
    if (!(b.high > m.high0930)) continue;
    const prev5 = win.slice(Math.max(0, i - 5), i);
    if (prev5.length === 0) continue;
    const avg5 = sumBarValue(prev5) / prev5.length;
    if (avg5 <= 0) continue;
    if ((b.value || 0) < avg5 * 2) continue;
    return { triggerTime: b.time, triggerPrice: m.high0930 };
  }
  return false;
}

// ── 10시 생존 확인 (60거래일 hypothesis miner 1위 — 평균 +2.49%, 승률 69.9%) ──
// 조건 (사용자 명세):
//   - 09:30 close 위에서 10:00 마감 (close1000 > last0930)
//   - close1000 >= high(09:31~10:00) × 0.98 — 고점 대비 크게 밀리지 않음
//   - 09:31~10:00 중 -3% 이하 심한 무너짐 없음
// 분봉이 10:00 까지 없으면 null 반환 (= "10:00 확인 대기" 상태).
function detectSurvivor1000(bars, m) {
  if (!m || !(m.last0930 > 0)) return null;
  // 10:00 분봉 존재 여부 — 09:55 이상의 분봉이 하나라도 있어야 함
  const win = barsInRangeExc(bars, '09:30', '10:00');
  if (win.length === 0) return null;
  // 10:00 시점의 bar (10:00 또는 그 직전 마지막)
  let bar1000 = null;
  for (const b of win) {
    if (b.time === '10:00') { bar1000 = b; break; }
    if (b.time <= '10:00') bar1000 = b;
  }
  if (!bar1000 || bar1000.time < '09:55') return null;  // 10시 분봉 미수신 — 확인 대기

  const close1000 = bar1000.close;
  if (!(close1000 > m.last0930)) return null;  // 09:30 close 아래 마감 — 생존 실패

  // 09:31~10:00 high
  const high0931_1000 = Math.max(...win.map((b) => b.high || 0));
  if (high0931_1000 <= 0) return null;
  // close1000 >= high0931_1000 × 0.98 (고점 대비 -2% 이내)
  if (close1000 < high0931_1000 * 0.98) return null;

  // 09:31~10:00 중 -3% 이하 무너짐 체크 (low 기준)
  const min_low_0931_1000 = Math.min(...win.map((b) => b.low || Infinity));
  if (min_low_0931_1000 < m.last0930 * 0.97) return null;  // -3% 초과 무너짐

  return {
    close1000,
    high0931_1000,
    aliveRate1000: Number(((close1000 / m.last0930 - 1) * 100).toFixed(2)),
    closeToHighDrop_1000: Number(((close1000 / high0931_1000 - 1) * 100).toFixed(2)),
    minLow0931_1000: min_low_0931_1000,
    minLowDrop_0931_1000: Number(((min_low_0931_1000 / m.last0930 - 1) * 100).toFixed(2)),
  };
}

// FADED_RECOVERY 가설 (보조 배지용): FADED 상태에서 09:31~10:00 close 회복 + 09:31~10:30 high 재돌파
function detectFadedRecovery(bars, m, status) {
  if (!m || status !== 'FADED') return false;
  if ((m.value_0930 || 0) < 2e9) return false;
  if (m.highToLastDrop == null) return false;
  if (m.highToLastDrop > -2.5 || m.highToLastDrop < -6) return false;
  const w1 = barsInRangeExc(bars, '09:30', '10:00');
  if (!w1.some((b) => b.close >= m.last0930)) return false;
  const w2 = barsInRangeExc(bars, '09:30', '10:30');
  const rb = w2.find((b) => b.high > m.high0930);
  return rb ? { triggerTime: rb.time } : false;
}

// I 조건 사전 통과 — TEN_REBREAK 외 모든 사전 조건
function passesAttackPrefilter(m, status, marketCap) {
  if (!m) return false;
  if ((m.value_0930 || 0) < 2.1e9) return false;
  if ((m.closePosition0930 || 0) < 0.50) return false;
  if (m.highToLastDrop == null || m.highToLastDrop < -2.70) return false;
  if (m.openToLastRate == null || m.openToLastRate < 0.50) return false;
  if ((m.valueToAvgRatio_0930 || 0) < 3) return false;
  if (!m.rebreakMorningHigh) return false;
  if (status !== 'READY' && status !== 'FADED') return false;
  if (!(marketCap > 0) || marketCap > 5e12) return false;
  return true;
}

// I 조건 전체 충족 — prefilter + TEN_REBREAK 발화
function passesAttackRebreak(m, status, marketCap, hasTenRebreak) {
  return passesAttackPrefilter(m, status, marketCap) && !!hasTenRebreak;
}

// attackScore — attackRebreak 후보 정렬용. finalScore 기반 + TEN_REBREAK / FADED 보정.
function attackScore(m, baseFinal, status, hasFadedRecovery) {
  let s = baseFinal || 0;
  // 거래대금 강세 가중
  s += Math.min(20, (m.value_0930 || 0) / 1e9);   // 1억당 +1, 최대 +20
  // valueToAvgRatio 가중
  s += Math.max(0, (m.valueToAvgRatio_0930 || 0) - 3) * 2;
  // closePosition 가중 (0.5 이상 부분)
  s += Math.max(0, (m.closePosition0930 || 0) - 0.5) * 10;
  // drop 작을수록 가산
  if ((m.highToLastDrop || -10) >= -1) s += 3;
  // FADED 상태는 약간 감점 (회복 흔적이 있어도 READY 보다 안정성 낮음)
  if (status === 'FADED') s -= 2;
  // FADED_RECOVERY 동시 발생 시 약간 가산 (회복 신호 확인됨)
  if (hasFadedRecovery) s += 2;
  return Number(s.toFixed(2));
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
  // 10:00 분봉 도달 여부 카운트 — survivor1000Ready 판정용
  let bars1000AvailableCount = 0;

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
    // 10:00 분봉이 들어왔는지 (생존 여부와 무관하게 데이터 가용성 추적)
    if (bars.some((b) => b && b.time >= '09:55' && b.time <= '10:05')) bars1000AvailableCount++;
    // 공격형 가설 — 분봉이 09:31 이후까지 있으면 trigger 검사. 09:30 cron 직후에는 거의 다 false.
    const tenRebreak = m ? detectTenRebreak(bars, m) : false;
    const fadedRecovery = m ? detectFadedRecovery(bars, m, status) : false;
    // 10시 생존 — 분봉이 10:00 까지 있으면 검사. 09:30 cron 직후에는 null (확인 대기).
    const survivor1000Info = m ? detectSurvivor1000(bars, m) : null;
    const triggeredHypos = [];
    if (tenRebreak) triggeredHypos.push('TEN_REBREAK');
    if (fadedRecovery) triggeredHypos.push('FADED_RECOVERY');
    if (survivor1000Info) triggeredHypos.push('SURVIVOR_1000');
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
      hasTenRebreak: !!tenRebreak,
      tenRebreakTrigger: tenRebreak || null,
      hasFadedRecovery: !!fadedRecovery,
      hasSurvivor1000: !!survivor1000Info,
      survivor1000: survivor1000Info,  // { close1000, high0931_1000, aliveRate1000, closeToHighDrop_1000, ... } or null
      triggeredHypos,
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

  // ── 폭발형 후보 선별 (explosive-backtest 결과 반영) ──
  // 조건: rebreakMorningHigh ✓ + closePosition≥0.85 + value_0930≥100억 + (open 3~8% 우선)
  // 정렬: explosiveScore = finalScore + (open 3~8 가산 5) − (drop 큰 만큼 추가 감점)
  const EXPLOSIVE_TOP_LIMIT = 5;
  function passesExplosive(m) {
    if (!m || !m.rebreakMorningHigh) return false;
    if ((m.closePosition0930 || 0) < 0.85) return false;
    if ((m.value_0930 || 0) < 1e10) return false;  // 100억
    return true;
  }
  function explosiveScore(m, baseFinal) {
    let s = baseFinal || 0;
    const o = m.openToLastRate || 0;
    if (o >= 3 && o <= 8) s += 5;     // sweet zone 가산
    if (o > 8) s -= 5;                 // 너무 오른 거 감점
    if ((m.highToLastDrop || 0) >= -1) s += 3;  // drop 작을수록 추가 가산
    return Number(s.toFixed(2));
  }
  // READY 풀에서 폭발형 조건 통과 → explosiveScore 정렬 → TOP5
  const explosiveReadyAll = statusBuckets.READY.filter((e) => passesExplosive(e.metrics))
    .map((e) => ({ ...e, explosiveScore: explosiveScore(e.metrics, e.finalScore) }))
    .sort((a, b) => b.explosiveScore - a.explosiveScore);
  const explosiveTop = explosiveReadyAll.slice(0, EXPLOSIVE_TOP_LIMIT);

  // WAIT_PULLBACK 풀에서 폭발형 조건 통과 → "관찰 후보" (눌림 후 재돌파 필요)
  const explosiveWatchAll = statusBuckets.WAIT_PULLBACK.filter((e) => passesExplosive(e.metrics))
    .map((e) => ({ ...e, explosiveScore: explosiveScore(e.metrics, e.finalScore) }))
    .sort((a, b) => b.explosiveScore - a.explosiveScore);
  const explosiveWatch = explosiveWatchAll.slice(0, EXPLOSIVE_TOP_LIMIT);

  // ── 공격형 재돌파 후보 (I 조건) — READY + FADED 풀에서 추출 ──
  // 19일 백테스트 기준 n=190, 일평균 10개, close×S1 +1.21% / S2 +1.52%.
  const SUGGESTED_STRATEGY_STABLE = {
    type: 'STABLE_SCALP',
    label: '안정형 단타',
    takeProfit: '+5%',
    stopLoss: '-2%',
    note: '19거래일 검증 기준 +5%/-2% 전략이 안정적 (n=64, 평균 +0.97%, 승률 46.9%, +10% 12.5%)',
  };
  const SUGGESTED_STRATEGY_ATTACK = {
    type: 'ATTACK_REBREAK',
    label: '공격형 재돌파',
    takeProfit: '+10%',
    stopLoss: '-3%',
    conservativeTakeProfit: '+5%',
    conservativeStopLoss: '-2%',
    note: '19거래일 검증 기준 +10%/-3% 전략이 가장 좋았으나 손실 폭도 더 큼 (n=190, S2 평균 +1.52%, 승률 55.8%, +10% 14.7%, 최악 -3%)',
  };

  const attackPoolAll = [...statusBuckets.READY, ...statusBuckets.FADED]
    .filter((e) => passesAttackRebreak(e.metrics, e.status, e.marketCap, e.hasTenRebreak))
    .map((e) => ({ ...e, attackScore: attackScore(e.metrics, e.finalScore, e.status, e.hasFadedRecovery) }))
    .sort((a, b) => b.attackScore - a.attackScore);

  // ── 10시 생존 확인 후보 (60거래일 검증 1위, score 9.04) ──
  // 조건: status=READY ∩ survivor1000 검증 통과
  // 09:30 cron 직후에는 거의 다 비어 있고, 10:00 cron 이후에 채워진다.
  const SUGGESTED_STRATEGY_SURVIVOR = {
    type: 'READY_ALIVE_1000',
    label: '10시 생존 확인형',
    entryBasis: '10:00 생존 확인 후',
    takeProfit: '+5% 또는 +10%',
    stopLoss: '-3%',
    note: '60거래일 검증 기준 평균 +2.49%, 승률 69.9%, +5% 도달 52.6%, +10% 도달 18.2%. 단, 장중 급락 사례가 있어 손절 기준 필요.',
  };
  const survivor1000PoolAll = statusBuckets.READY
    .filter((e) => e.hasSurvivor1000)
    .map((e) => ({ ...e }))
    .sort((a, b) => (b.survivor1000.aliveRate1000 || 0) - (a.survivor1000.aliveRate1000 || 0));

  // 중복 제거 set
  const explosiveTopCodeSet = new Set(explosiveTop.map((e) => e.code));
  const attackCodeSet = new Set(attackPoolAll.map((e) => e.code));
  const survivor1000CodeSet = new Set(survivor1000PoolAll.map((e) => e.code));

  // ── [1] survivor1000 — 메인 후보, 최우선 노출 ──
  // 한 종목이 survivor1000에 들어가면 다른 섹션에서 제외 (중복 노출 금지).
  const survivor1000 = survivor1000PoolAll.map((e) => {
    const overlapBadges = ['10시 생존 확인'];
    if (explosiveTopCodeSet.has(e.code)) overlapBadges.push('조기 포착');
    if (attackCodeSet.has(e.code))       overlapBadges.push('공격형 재돌파 동시');
    if (e.hasFadedRecovery)              overlapBadges.push('FADED 회복 동시');
    return {
      ...e,
      isSurvivor1000: true,
      isExplosiveTop: explosiveTopCodeSet.has(e.code),
      isAttackRebreak: attackCodeSet.has(e.code),
      overlapBadges,
      suggestedStrategy: SUGGESTED_STRATEGY_SURVIVOR,
      reason: '10시까지 09:30 close 위에서 생존',
    };
  });

  // ── [2] 09:30 조기 포착 후보 (= 기존 explosiveTop, survivor1000에 없는 것만) ──
  const explosiveStable = explosiveTop
    .filter((e) => !survivor1000CodeSet.has(e.code))
    .map((e) => {
      const overlapBadges = ['조기 포착'];
      if (attackCodeSet.has(e.code)) overlapBadges.push('공격형 재돌파 동시');
      if (e.hasFadedRecovery)        overlapBadges.push('FADED 회복 동시');
      overlapBadges.push('10시 확인 필요');
      return {
        ...e,
        isSurvivor1000: false,
        isExplosiveTop: true,
        isAttackRebreak: attackCodeSet.has(e.code),
        overlapBadges,
        suggestedStrategy: SUGGESTED_STRATEGY_STABLE,
        reason: '09:30 조기 포착 — 10시 생존 확인 전 감시 후보',
      };
    });

  // ── [3] 공격형 재돌파 감시 후보 (= 기존 I 조건, survivor1000 + explosiveStable 제외) ──
  const attackRebreak = attackPoolAll
    .filter((e) => !survivor1000CodeSet.has(e.code) && !explosiveTopCodeSet.has(e.code))
    .map((e) => {
      const overlapBadges = ['공격형 재돌파', '10시 확인 필요'];
      if (e.hasFadedRecovery) overlapBadges.push('FADED 회복 동시');
      return {
        ...e,
        isSurvivor1000: false,
        isExplosiveTop: false,
        isAttackRebreak: true,
        overlapBadges,
        suggestedStrategy: SUGGESTED_STRATEGY_ATTACK,
        reason: '09:30 + TEN_REBREAK — 10시 생존 확인 전 감시 후보',
      };
    });

  // ── [4] READY 1차 후보 — 위 3개 섹션 제외 ──
  const attackOnlyCodes = new Set(attackRebreak.map((e) => e.code));
  const readyRestCombined = statusBuckets.READY
    .filter((e) => !survivor1000CodeSet.has(e.code) && !explosiveTopCodeSet.has(e.code) && !attackOnlyCodes.has(e.code))
    .map((e) => ({
      ...e,
      isSurvivor1000: false,
      isExplosiveTop: false,
      isAttackRebreak: false,
      overlapBadges: e.hasFadedRecovery ? ['FADED 회복 동시', '10시 확인 필요'] : ['10시 확인 필요'],
      suggestedStrategy: null,
      reason: '예선 통과 — 10시 생존 확인 전까지 보조 관찰',
    }));

  // ── [5] 관찰/제외 후보 (watchOnly) ──
  // 60일 검증 위험 조건: WAIT_PULLBACK 전체 / FADED + cp≥0.70 / open≥8% (이미 WAIT_PULLBACK 컷) / v/mc≥5% 단독 / FADED 단독 / WEAK 단독
  // 화면 노출은 일부만 (메인 후보 아님을 명시).
  const watchEntries = [];
  // 5-1. explosiveWatch (=WAIT_PULLBACK ∩ 폭발형) — 추격 주의
  for (const e of explosiveWatch) {
    watchEntries.push({ ...e, isSurvivor1000: false, isExplosiveTop: false, isAttackRebreak: false,
      overlapBadges: ['추격 주의', '폭발형 관찰'], suggestedStrategy: null,
      reason: '시가 대비 +8% 이상 — 추격 부담' });
  }
  // 5-2. WAIT_PULLBACK 단독 (explosiveWatch 외)
  const explosiveWatchCodeSet = new Set(explosiveWatch.map((e) => e.code));
  for (const e of statusBuckets.WAIT_PULLBACK.slice(0, 10)) {
    if (explosiveWatchCodeSet.has(e.code)) continue;
    watchEntries.push({ ...e, isSurvivor1000: false, isExplosiveTop: false, isAttackRebreak: false,
      overlapBadges: ['추격 부담'], suggestedStrategy: null,
      reason: '과열 출발 — 즉시 진입 부적합' });
  }
  // 5-3. FADED + cp≥0.70 (60일 검증 fail3 75% 위험 유형)
  for (const e of statusBuckets.FADED.slice(0, 10)) {
    if ((e.metrics && e.metrics.closePosition0930 || 0) >= 0.70) {
      watchEntries.push({ ...e, isSurvivor1000: false, isExplosiveTop: false, isAttackRebreak: false,
        overlapBadges: ['FADED 단독 위험'], suggestedStrategy: null,
        reason: 'FADED + cp 높음 — 60일 검증 fail3 75%' });
    }
  }
  // 5-4. v/mc ≥5% 단독 (READY/FADED 외 status에서) — 60일 검증 fail3 66.5% 위험
  for (const status of ['WEAK', 'FADED']) {
    const list = statusBuckets[status] || [];
    for (const e of list) {
      const vmc = e.marketCap > 0 ? (e.metrics.value_0930 || 0) / e.marketCap : 0;
      if (vmc >= 0.05 && watchEntries.length < 30) {
        watchEntries.push({ ...e, isSurvivor1000: false, isExplosiveTop: false, isAttackRebreak: false,
          overlapBadges: ['시총 대비 거래대금만 큰 유형'], suggestedStrategy: null,
          reason: 'v/mc ≥5% 단독 — 60일 검증 fail3 66.5%' });
        if (watchEntries.length >= 30) break;
      }
    }
  }
  // dedupe by code
  const watchSeen = new Set();
  const watchOnly = watchEntries.filter((e) => {
    if (watchSeen.has(e.code)) return false;
    watchSeen.add(e.code); return true;
  });

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
    scanner0930Wait:     wait,                   // WAIT_PULLBACK — 추격 부담 (백테스트 fail1 71.9%)
    scanner0930Faded:    faded,                  // FADED — 카드 노출 X (통계만, 백테스트 결과 평균 이하)
    scanner0930ExplosiveTop:   explosiveTop,     // 🚀 폭발형 후보 (READY ∩ rebreak + cp≥0.85 + value≥100억) — 호환성 유지
    scanner0930ExplosiveWatch: explosiveWatch,   // 🚀 폭발형 관찰 후보 (WAIT_PULLBACK ∩ 같은 조건, 눌림 후 재돌파 필요) — 호환성 유지
    // ── 60거래일 백테스트 결과 반영 신규 5섹션 구조 (2026-05-14) ──
    // 우선순위: survivor1000 > explosiveStable > attackRebreak > readyRestFinal > watchOnly
    scanner0930Survivor1000:    survivor1000,     // ✅ [1] 10시 생존 확인 후보 (메인, 60일 검증 1위)
    scanner0930ExplosiveStable: explosiveStable,  // 🚀 [2] 09:30 조기 포착 후보 (= explosiveTop, survivor1000 제외)
    scanner0930AttackRebreak:   attackRebreak,    // 🔥 [3] 공격형 재돌파 감시 후보 (survivor1000 + explosiveStable 제외)
    scanner0930ReadyRestFinal:  readyRestCombined,// 📡 [4] 09:30 READY 1차 후보 (위 3개 제외)
    scanner0930WatchOnly:       watchOnly,        // 👀 [5] 관찰/제외 후보 (WAIT_PULLBACK / FADED+cp / v/mc 단독 등)
    // 10시 cron 후 채워졌는지 표시 — bars1000AvailableCount > 0 면 10시 분봉 데이터가 들어왔다는 의미
    survivor1000Ready: bars1000AvailableCount > 0,
    bars1000AvailableCount,
    survivor1000CheckedAt: finishedAt.toISOString(),
    summary: {
      readyCount: statusBuckets.READY.length,
      survivor1000Count: survivor1000.length,
      explosiveTopCount: explosiveStable.length,
      attackRebreakCount: attackRebreak.length,
      readyRestCount: readyRestCombined.length,
      watchOnlyCount: watchOnly.length,
      isSurvivor1000Ready: survivor1000.length > 0,
      survivor1000CheckedAt: finishedAt.toISOString(),
      // 사용자에게 안내용 문구 (10시 전/후)
      mainSectionLabel: survivor1000.length > 0
        ? '10:00 생존 확인 완료. 메인 후보는 10시 생존 확인 후보입니다.'
        : '10:00 생존 확인 전입니다. 현재 후보는 예선 단계입니다.',
    },
    explosiveCounts: {
      explosiveTopTotal:   explosiveReadyAll.length,
      explosiveWatchTotal: explosiveWatchAll.length,
      attackRebreakTotal:  attackPoolAll.length,
      attackRebreakNewOnly: attackRebreak.length,  // explosiveTop 중복 제외 후
      survivor1000Total:   survivor1000PoolAll.length,
    },
    suggestedStrategies: { stable: SUGGESTED_STRATEGY_STABLE, attack: SUGGESTED_STRATEGY_ATTACK, survivor: SUGGESTED_STRATEGY_SURVIVOR },
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
  if (explosiveTop.length > 0) {
    console.log(`\n  🚀 폭발형 후보 (explosiveTop ${explosiveTop.length}건 / 통과 ${explosiveReadyAll.length}건, 백테스트 day+10% 11.6%):`);
    for (const e of explosiveTop) {
      const m = e.metrics;
      console.log(`     exp ${e.explosiveScore.toFixed(1).padStart(6)} | ${e.code} ${(e.name || '').padEnd(15)} | +${(m.openToLastRate || 0).toFixed(2)}% | v ${(m.value_0930 / 1e8).toFixed(0)}억 (x${(m.valueToAvgRatio_0930 || 0).toFixed(1)}) | cp ${(m.closePosition0930 * 100).toFixed(0)}% | drop ${(m.highToLastDrop || 0).toFixed(2)}% ↗MH재돌파`);
    }
  }
  if (explosiveWatch.length > 0) {
    console.log(`\n  ⚠ 폭발형 관찰 후보 (explosiveWatch ${explosiveWatch.length}건 — 추격 부담, 눌림 후 재돌파 필요):`);
    for (const e of explosiveWatch) {
      console.log(`     exp ${e.explosiveScore.toFixed(1).padStart(6)} | ${e.code} ${(e.name || '').padEnd(15)} | +${(e.metrics.openToLastRate || 0).toFixed(2)}%`);
    }
  }
  if (attackRebreak.length > 0 || attackPoolAll.length > 0) {
    console.log(`\n  🔥 공격형 재돌파 후보 (attackRebreak ${attackRebreak.length}건 / 전체 통과 ${attackPoolAll.length}건, 안정형 중복 ${attackPoolAll.length - attackRebreak.length}건 제외):`);
    for (const e of attackRebreak.slice(0, 10)) {
      const m = e.metrics;
      console.log(`     attack ${e.attackScore.toFixed(1).padStart(6)} | ${e.code} ${(e.name || '').padEnd(15)} | ${e.status} | TEN_REBREAK@${e.tenRebreakTrigger ? e.tenRebreakTrigger.triggerTime : '?'} | v ${(m.value_0930/1e8).toFixed(0)}억 | cp ${(m.closePosition0930*100).toFixed(0)}% | drop ${(m.highToLastDrop||0).toFixed(2)}%`);
    }
  }

  // 10시 생존 — 메인 후보 콘솔 로그
  console.log(`\n  ✅ 10시 생존 확인 후보 (survivor1000):`);
  if (bars1000AvailableCount === 0) {
    console.log(`     (10:00 분봉 미수신 — 09:30 cron 직후로 보임. 10:00 cron 이후 재실행 시 채워짐)`);
  } else if (survivor1000.length === 0) {
    console.log(`     (10:00 분봉 ${bars1000AvailableCount}개 수신 완료 / 생존 후보 0건)`);
  } else {
    console.log(`     ${survivor1000.length}건 (10:00 분봉 ${bars1000AvailableCount}개 수신, 60일 검증 1위 — 평균 +2.49% 승률 69.9%):`);
    for (const e of survivor1000.slice(0, 10)) {
      const s = e.survivor1000;
      console.log(`     alive +${s.aliveRate1000}% | ${e.code} ${(e.name || '').padEnd(15)} | 10:00 close ${s.close1000}원 (high 대비 ${s.closeToHighDrop_1000}%, 저점 ${s.minLowDrop_0931_1000}%)${e.isExplosiveTop ? ' [조기포착]' : ''}${e.isAttackRebreak ? ' [공격형]' : ''}`);
    }
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
  computeFinalScore,
  passesLiquidityFilter,
  loadStockMetaMap,
  main,
};
