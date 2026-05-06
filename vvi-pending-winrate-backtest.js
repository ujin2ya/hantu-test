#!/usr/bin/env node
/**
 * VVI돌파대기 매매 승률 백테스트
 *
 * 목적:
 *   QVA → VVI 발생 종목을 보드(VVI_FIRED 단계)에서 발견했을 때, 다음 날 시가에 매수했을 때
 *   진짜 승률·평균 결과를 검증한다. 돌파 성공/실패 사후 정보를 사용하지 않는다.
 *
 *   기존 H그룹(BREAKOUT_SUCCESS) 백테스트는 다음날 돌파 성공한 케이스만 추렸지만,
 *   이 스크립트는 VVI 발생 = 보드 노출 시점이므로 돌파 성공/실패 모두 포함.
 *
 *   QVA/VVI 정의 변경 없음. pattern-screener.js의 calculateVolumeValueIgnition 그대로 사용.
 *
 * 출력:
 *   reports/vvi-pending-winrate-backtest-result.json
 *   reports/vvi-pending-winrate-backtest-result.html
 *
 * 라우트: /vvi-pending-winrate
 *
 * 시나리오:
 *   익절 +6% / 손절 -3%
 *   익절 +10% / 손절 -5%
 *   익절 +15% / 손절 -5%
 *   익절 +20% / 손절 -5%
 *   분할 청산 (50% +6 / 30% +12 / 20% +16, 본전 이동)
 *
 * 매수: VVI 발생 다음 거래일 시가 (--entry-price=close 로 종가 매수도 지원)
 * 보유: 10거래일 종가 청산
 *
 * 실행:
 *   node vvi-pending-winrate-backtest.js                      # 3년 기본
 *   node vvi-pending-winrate-backtest.js --from=20240101 --to=20260420
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const OUT_JSON = path.join(REPORTS_DIR, 'vvi-pending-winrate-backtest-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'vvi-pending-winrate-backtest-result.html');

const args = (() => {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
})();
const FROM = String(args.from || '20230101').trim();
const TO = String(args.to || '20260420').trim();
const ENTRY_PRICE = (args['entry-price'] || 'open').toLowerCase();  // VVI+1 open (기본) | close
const HOLD_DAYS = parseInt(args['hold-days'] || '10', 10);

const TRACKING_DAYS = 20;          // QVA 추적 만료 (보드 정의 그대로)
const EXIT_THRESHOLD_PCT = -10;    // QVA 시그널 가격 -10% 이탈 시 트래킹 무효 (보드 정의)

// ─── 시나리오 정의 ───
const SCENARIOS = [
  { key: 'A', label: '익절 +6% / 손절 -3%',  tp: 6,  sl: -3, kind: 'simple' },
  { key: 'B', label: '익절 +10% / 손절 -5%', tp: 10, sl: -5, kind: 'simple' },
  { key: 'C', label: '익절 +15% / 손절 -5%', tp: 15, sl: -5, kind: 'simple' },
  { key: 'D', label: '익절 +20% / 손절 -5%', tp: 20, sl: -5, kind: 'simple' },
  {
    key: 'E', label: '분할 청산 (50% +6 / 30% +12 / 20% +16, 본전 이동)',
    kind: 'split',
    tiers: [
      { pct: 6, weight: 0.5 },
      { pct: 12, weight: 0.3 },
      { pct: 16, weight: 0.2 },
    ],
    sl: -5,
  },
];

// ─── 유틸 ───
function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}
function mean(arr) {
  const v = arr.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}
function median(arr) {
  const v = arr.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function sma(values, period) {
  if (!values || values.length < period) return null;
  return values.slice(-period).reduce((s, v) => s + v, 0) / period;
}
function rate(num, denom) { if (!denom) return null; return round(num / denom * 100, 2); }
function isExcludedProduct(name) {
  if (!name) return false;
  return /(스팩|우$|전환|전환사채|채권|ETN$|ETF$)/i.test(name);
}

// ─── QVA 시그널 (vpr-hgroup-long-period-maturity-backtest.js와 동일) ───
function checkQVASignalAtIdx(rows, idx) {
  if (!rows || idx < 60) return false;
  const today = rows[idx];
  const close = today?.close;
  if (!close || close <= 0) return false;
  const last20 = rows.slice(idx - 19, idx + 1);
  const last5 = rows.slice(idx - 4, idx + 1);
  const avg20Value = last20.reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = last20.reduce((s, r) => s + (r.volume || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return false;
  const todayValue = today.valueApprox || today.close * today.volume;
  const valueRatio20 = todayValue / (avg20Value || 1);
  const volumeRatio20 = today.volume / (avg20Vol || 1);
  if (valueRatio20 < 1.5 || volumeRatio20 < 1.5) return false;
  const lows5 = last5.map(r => r.low);
  const lows20to25 = rows.slice(idx - 24, idx - 4).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;
  if (min5 <= min20) return false;
  const ma20 = sma(last20.map(r => r.close), 20);
  if (ma20 && close < ma20 * 0.95) return false;
  const todayReturn = today.open > 0 ? close / today.open - 1 : 0;
  if (todayReturn > 0.05) return false;
  const ret20d = idx >= 20 ? close / rows[idx - 20].close - 1 : 0;
  if (ret20d > 0.15) return false;
  const medianVal20 = median(last20.map(r => r.valueApprox || 0));
  const valueMedianRatio = medianVal20 > 0 ? todayValue / medianVal20 : 0;
  if (valueMedianRatio < 1.8) return false;
  const last3 = rows.slice(idx - 2, idx + 1);
  const hasRecentValueSpike = last3.some(r => {
    const v = r.valueApprox || r.close * r.volume;
    const vRatio = v / (avg20Value || 1);
    const medRatio = medianVal20 > 0 ? v / medianVal20 : 0;
    return vRatio >= 1.5 || medRatio >= 2.0;
  });
  if (!hasRecentValueSpike) return false;
  const last10hl = rows.slice(idx - 9, idx + 1);
  const high10 = Math.max(...last10hl.map(r => r.high));
  const low10 = Math.min(...last10hl.map(r => r.low));
  const rangeExpansion10 = low10 > 0 ? high10 / low10 - 1 : 0;
  if (rangeExpansion10 < 0.03) return false;
  return true;
}

// ─── VVI 검출: cutoff 시점에 vviIdx === cutoffIdx 인 VVI 발생일만 잡음 (당일 VVI = 다음날 매수) ───
function detectVviFireAt(rows, flowRows, cutoffIdx, namedMeta) {
  if (cutoffIdx < 60) return null;
  // QVA 후보를 찾는다 (lookback TRACKING_DAYS)
  let qvaIdx = null;
  for (let k = 0; k <= TRACKING_DAYS && cutoffIdx - k >= 60; k++) {
    if (checkQVASignalAtIdx(rows, cutoffIdx - k)) { qvaIdx = cutoffIdx - k; break; }
  }
  if (qvaIdx == null) return null;
  if (qvaIdx === cutoffIdx) return null;  // cutoff 당일이 QVA면 VVI 검출 불가

  // QVA 시그널 가격 -10% 이탈 시 트래킹 무효
  const signalPrice = rows[qvaIdx].close;
  for (let k = 1; k <= cutoffIdx - qvaIdx; k++) {
    const r = rows[qvaIdx + k];
    if (r.close > 0 && r.close <= signalPrice * (1 + EXIT_THRESHOLD_PCT / 100)) return null;
  }

  // QVA 후 첫 VVI 검출 — cutoff 당일에 발생한 케이스만 수집
  for (let k = 1; k <= cutoffIdx - qvaIdx; k++) {
    const cand = qvaIdx + k;
    const candDate = rows[cand].date;
    const slicedChart = rows.slice(0, cand + 1);
    const slicedFlow = flowRows.filter(r => r?.date && r.date <= candDate);
    if (slicedFlow.length < 10) continue;
    let vvi = null;
    try { vvi = ps.calculateVolumeValueIgnition(slicedChart, slicedFlow, namedMeta); }
    catch (_) { vvi = null; }
    if (vvi?.passed) {
      if (cand !== cutoffIdx) return null;  // VVI가 cutoff 당일이 아니면 스킵
      return { qvaIdx, vviIdx: cand, vviRow: rows[cand], signalPrice };
    }
  }
  return null;
}

// ─── 매매 시뮬레이션 (vpr-trade-winrate-backtest.js와 동일 로직) ───
function simulateSimple(rows, buyIdx, buyPrice, tpPct, slPct, holdDays, entryPrice = 'open') {
  const tpPrice = buyPrice * (1 + tpPct / 100);
  const slPrice = buyPrice * (1 + slPct / 100);
  if (entryPrice === 'open' && rows[buyIdx]) {
    const r = rows[buyIdx];
    if (r.low <= slPrice) return { exitDay: 0, exitType: 'SL', returnPct: round((slPrice / buyPrice - 1) * 100) };
    if (r.high >= tpPrice) return { exitDay: 0, exitType: 'TP', returnPct: round((tpPrice / buyPrice - 1) * 100) };
  }
  for (let k = 1; k <= holdDays; k++) {
    const idx = buyIdx + k;
    if (idx >= rows.length) {
      const lastIdx = rows.length - 1;
      if (lastIdx <= buyIdx) return null;
      return { exitDay: lastIdx - buyIdx, exitType: 'TIME', returnPct: round((rows[lastIdx].close / buyPrice - 1) * 100) };
    }
    const r = rows[idx];
    if (r.open >= tpPrice) return { exitDay: k, exitType: 'TP_GAP', returnPct: round((r.open / buyPrice - 1) * 100) };
    if (r.open <= slPrice) return { exitDay: k, exitType: 'SL_GAP', returnPct: round((r.open / buyPrice - 1) * 100) };
    if (r.low <= slPrice) return { exitDay: k, exitType: 'SL', returnPct: round((slPrice / buyPrice - 1) * 100) };
    if (r.high >= tpPrice) return { exitDay: k, exitType: 'TP', returnPct: round((tpPrice / buyPrice - 1) * 100) };
  }
  const idx = buyIdx + holdDays;
  if (idx >= rows.length) return null;
  return { exitDay: holdDays, exitType: 'TIME', returnPct: round((rows[idx].close / buyPrice - 1) * 100) };
}

function simulateSplit(rows, buyIdx, buyPrice, tiers, slPct, holdDays, entryPrice = 'open') {
  let remaining = 1.0;
  let realized = 0;
  let stopPrice = buyPrice * (1 + slPct / 100);
  let nextTier = 0;

  if (entryPrice === 'open' && rows[buyIdx]) {
    const r = rows[buyIdx];
    if (r.low <= stopPrice) {
      realized += remaining * (stopPrice / buyPrice - 1) * 100;
      remaining = 0;
    } else {
      while (nextTier < tiers.length) {
        const t = tiers[nextTier];
        const tp = buyPrice * (1 + t.pct / 100);
        if (r.high >= tp) {
          realized += t.weight * t.pct;
          remaining -= t.weight;
          nextTier++;
          if (nextTier === 1) stopPrice = buyPrice;
          else stopPrice = buyPrice * (1 + tiers[nextTier - 2].pct / 100);
        } else break;
      }
    }
  }

  for (let k = 1; k <= holdDays; k++) {
    if (remaining <= 0) break;
    const idx = buyIdx + k;
    if (idx >= rows.length) break;
    const r = rows[idx];
    if (r.open <= stopPrice) {
      realized += remaining * (r.open / buyPrice - 1) * 100;
      remaining = 0;
      break;
    }
    while (nextTier < tiers.length) {
      const t = tiers[nextTier];
      const tp = buyPrice * (1 + t.pct / 100);
      if (r.open >= tp) {
        realized += t.weight * t.pct;
        remaining -= t.weight;
        nextTier++;
        if (nextTier === 1) stopPrice = buyPrice;
        else stopPrice = buyPrice * (1 + tiers[nextTier - 2].pct / 100);
      } else break;
    }
    if (remaining <= 0) break;
    if (r.low <= stopPrice) {
      realized += remaining * (stopPrice / buyPrice - 1) * 100;
      remaining = 0;
      break;
    }
    while (nextTier < tiers.length) {
      const t = tiers[nextTier];
      const tp = buyPrice * (1 + t.pct / 100);
      if (r.high >= tp) {
        realized += t.weight * t.pct;
        remaining -= t.weight;
        nextTier++;
        if (nextTier === 1) stopPrice = buyPrice;
        else stopPrice = buyPrice * (1 + tiers[nextTier - 2].pct / 100);
      } else break;
    }
  }
  if (remaining > 0) {
    const idx = buyIdx + holdDays;
    if (idx < rows.length) {
      realized += remaining * (rows[idx].close / buyPrice - 1) * 100;
      remaining = 0;
    }
  }
  return { exitType: 'SPLIT', returnPct: round(realized) };
}

// ─── 그룹 통계 ───
function summarize(label, trades) {
  const valid = trades.filter(t => t.result != null);
  if (valid.length === 0) return { label, count: trades.length, valid: 0 };
  const returns = valid.map(t => t.result.returnPct);
  const wins = valid.filter(t => t.result.returnPct > 0);
  const losses = valid.filter(t => t.result.returnPct <= 0);
  const tpExits = valid.filter(t => t.result.exitType === 'TP' || t.result.exitType === 'TP_GAP');
  const slExits = valid.filter(t => t.result.exitType === 'SL' || t.result.exitType === 'SL_GAP');
  const timeExits = valid.filter(t => t.result.exitType === 'TIME');
  const winReturns = wins.map(t => t.result.returnPct);
  const lossReturns = losses.map(t => t.result.returnPct);
  const avgWin = mean(winReturns);
  const avgLoss = mean(lossReturns);
  const winRate = wins.length / valid.length;
  const expectancy = winRate * (avgWin || 0) + (1 - winRate) * (avgLoss || 0);
  let maxLossStreak = 0, curStreak = 0;
  for (const t of valid) {
    if (t.result.returnPct <= 0) { curStreak++; if (curStreak > maxLossStreak) maxLossStreak = curStreak; }
    else curStreak = 0;
  }
  return {
    label, count: trades.length, valid: valid.length,
    winRate: round(winRate * 100),
    winCount: wins.length, lossCount: losses.length,
    avgReturn: round(mean(returns)),
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    expectancy: round(expectancy),
    tpRate: rate(tpExits.length, valid.length),
    slRate: rate(slExits.length, valid.length),
    timeRate: rate(timeExits.length, valid.length),
    maxLossStreak,
    bestTrade: round(Math.max(...returns)),
    worstTrade: round(Math.min(...returns)),
  };
}

// ─────────────────────── 메인 ───────────────────────
function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
  const codeMeta = new Map();
  for (const s of stocksList.stocks) codeMeta.set(s.code, s);
  const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));

  console.log(`\n📊 VVI돌파대기 매매 승률 백테스트 (${FROM} ~ ${TO})`);
  console.log(`  매수: VVI 발생 다음 거래일 ${ENTRY_PRICE === 'open' ? '시가 (장초반)' : '종가'} / 보유 ${HOLD_DAYS}거래일`);
  console.log(`  종목 수: ${files.length}`);

  // 차트 + flow 로드
  const allDates = new Set();
  const chartCache = new Map();
  for (let fi = 0; fi < files.length; fi++) {
    if (fi % 1000 === 0) process.stdout.write(`  차트 로드 ${fi}/${files.length}\r`);
    const code = files[fi].replace('.json', '');
    const meta = codeMeta.get(code);
    if (!meta || isExcludedProduct(meta.name)) continue;
    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8')); }
    catch (_) { continue; }
    const rows = chart.rows || [];
    if (rows.length < 65) continue;
    let flowRows = [];
    try {
      const flowRaw = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, files[fi]), 'utf-8'));
      flowRows = flowRaw?.rows || [];
    } catch (_) {}
    chartCache.set(code, { rows, flowRows, meta, name: chart.name || meta.name });
    for (const r of rows) if (r?.date) allDates.add(r.date);
  }
  process.stdout.write(`  차트 로드 ${files.length}/${files.length}\n`);
  console.log(`  유효 종목: ${chartCache.size}`);

  const tradingDatesAll = Array.from(allDates).sort();
  const tradingDatesInRange = tradingDatesAll.filter(d => d >= FROM && d <= TO);
  console.log(`  분석 cutoff 일자: ${tradingDatesInRange.length}일`);

  // VVI 발생일 검출 (cutoff 당일에 VVI 발생한 케이스만)
  const events = [];
  let processed = 0;
  const t0 = Date.now();
  for (const [code, { rows, flowRows, meta, name }] of chartCache) {
    processed++;
    if (processed % 200 === 0) {
      process.stdout.write(`  VVI 검출 ${processed}/${chartCache.size} (events ${events.length})\r`);
    }
    const namedMeta = { ...meta, name: name || meta.name };
    for (const cutoff of tradingDatesInRange) {
      const cutoffIdx = rows.findIndex(r => r.date === cutoff);
      if (cutoffIdx < 0) continue;
      const det = detectVviFireAt(rows, flowRows, cutoffIdx, namedMeta);
      if (!det) continue;
      const { qvaIdx, vviIdx, vviRow, signalPrice } = det;
      const buyIdx = vviIdx + 1;
      if (buyIdx >= rows.length) continue;
      const buyRow = rows[buyIdx];
      const buyPrice = ENTRY_PRICE === 'open' ? buyRow.open : buyRow.close;
      if (!buyPrice || buyPrice <= 0) continue;

      // 다음날 돌파 결과 (사후 분류용 — 필터로 사용하지 않고 통계만)
      const triggered1Pct = buyRow.high >= vviRow.high * 1.01;
      const closeHeldAboveVviHigh = buyRow.close >= vviRow.high;
      let nextDayCategory;
      if (triggered1Pct && closeHeldAboveVviHigh) nextDayCategory = 'BREAKOUT_SUCCESS';
      else if (triggered1Pct) nextDayCategory = 'BREAKOUT_WEAK';
      else nextDayCategory = 'NO_BREAKOUT';

      events.push({
        code, name: meta.name, market: meta.market,
        qvaDate: rows[qvaIdx].date, vviDate: vviRow.date, buyDate: buyRow.date,
        buyIdx, buyPrice, vviHigh: vviRow.high, vviClose: vviRow.close, signalPrice,
        nextDayCategory,
        rows,  // 시뮬레이션용 (저장 시 제외)
      });
    }
  }
  process.stdout.write(`  VVI 검출 ${chartCache.size}/${chartCache.size}            \n`);
  console.log(`  VVI 발생 이벤트: ${events.length}건 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 시나리오 시뮬레이션
  const scenarioResults = {};
  for (const sc of SCENARIOS) {
    const trades = events.map(e => ({
      event: e,
      result: sc.kind === 'simple'
        ? simulateSimple(e.rows, e.buyIdx, e.buyPrice, sc.tp, sc.sl, HOLD_DAYS, ENTRY_PRICE)
        : simulateSplit(e.rows, e.buyIdx, e.buyPrice, sc.tiers, sc.sl, HOLD_DAYS, ENTRY_PRICE),
    }));
    scenarioResults[sc.key] = trades;
  }

  // 필터별 집계
  const FILTERS = [
    { key: 'ALL', label: '전체 (필터 없음)', match: () => true },
    { key: 'BREAKOUT_SUCCESS', label: '다음날 돌파 성공 (=H그룹)', match: e => e.nextDayCategory === 'BREAKOUT_SUCCESS' },
    { key: 'BREAKOUT_WEAK', label: '다음날 약한 돌파 (고가는 찍었지만 종가 미달)', match: e => e.nextDayCategory === 'BREAKOUT_WEAK' },
    { key: 'NO_BREAKOUT', label: '다음날 돌파 실패 (고가 미달)', match: e => e.nextDayCategory === 'NO_BREAKOUT' },
  ];

  const summary = [];
  for (const sc of SCENARIOS) {
    for (const f of FILTERS) {
      const filtered = scenarioResults[sc.key].filter(t => f.match(t.event));
      const stat = summarize(`${sc.label} | ${f.label}`, filtered);
      summary.push({
        scenarioKey: sc.key, scenarioLabel: sc.label,
        filterKey: f.key, filterLabel: f.label,
        ...stat,
      });
    }
  }

  // 시나리오별 ALL 요약
  const scenarioSummary = SCENARIOS.map(sc => {
    const all = summary.find(s => s.scenarioKey === sc.key && s.filterKey === 'ALL');
    return all || { scenarioKey: sc.key, scenarioLabel: sc.label, count: 0, valid: 0 };
  });

  // 카테고리 분포
  const categoryCount = {
    BREAKOUT_SUCCESS: events.filter(e => e.nextDayCategory === 'BREAKOUT_SUCCESS').length,
    BREAKOUT_WEAK: events.filter(e => e.nextDayCategory === 'BREAKOUT_WEAK').length,
    NO_BREAKOUT: events.filter(e => e.nextDayCategory === 'NO_BREAKOUT').length,
  };

  // 콘솔 출력
  console.log(`\n📊 다음날 돌파 결과 분포:`);
  console.log(`  돌파 성공 (=H그룹):     ${categoryCount.BREAKOUT_SUCCESS}건  (${rate(categoryCount.BREAKOUT_SUCCESS, events.length)}%)`);
  console.log(`  약한 돌파 (종가 미달):   ${categoryCount.BREAKOUT_WEAK}건  (${rate(categoryCount.BREAKOUT_WEAK, events.length)}%)`);
  console.log(`  돌파 실패 (고가 미달):   ${categoryCount.NO_BREAKOUT}건  (${rate(categoryCount.NO_BREAKOUT, events.length)}%)`);

  console.log(`\n📊 시나리오별 전체 (필터 없음):`);
  console.log(`  시나리오                                          n     승률   평균이익  평균손실  매번 평균  연속손실`);
  for (const s of scenarioSummary) {
    if (!s.count) continue;
    const winStr = s.avgWin == null ? '없음' : (s.avgWin + '%');
    const lossStr = s.avgLoss == null ? '없음' : (s.avgLoss + '%');
    console.log(`  ${(s.scenarioLabel || '-').padEnd(50)} ${String(s.valid).padStart(4)}  ${String(s.winRate ?? '-').padStart(6)}%  ${winStr.padStart(7)}  ${lossStr.padStart(8)}  ${String(s.expectancy ?? '-').padStart(7)}%  ${String(s.maxLossStreak ?? '-').padStart(6)}`);
  }

  console.log(`\n📊 시나리오 × 다음날 돌파 결과별 매번 평균(=기대값) %:`);
  for (const f of FILTERS) {
    const printed = [];
    for (const sc of SCENARIOS) {
      const s = summary.find(x => x.scenarioKey === sc.key && x.filterKey === f.key);
      if (!s || !s.valid) continue;
      printed.push({ sc, s });
    }
    if (printed.length === 0) continue;
    const n = printed[0].s.valid;
    console.log(`  [${f.label}] (n=${n})`);
    for (const { sc, s } of printed) {
      const tag = s.expectancy > 0.5 ? '🟢' : (s.expectancy < -0.5 ? '🔴' : '⚪');
      const winStr = s.avgWin == null ? '없음' : (s.avgWin + '%');
      const lossStr = s.avgLoss == null ? '없음' : (s.avgLoss + '%');
      console.log(`    ${tag} ${sc.label.padEnd(50)} 승률 ${String(s.winRate).padStart(5)}%  매번평균 ${String(s.expectancy >= 0 ? '+' : '') + s.expectancy}%  (이익 ${winStr} / 손실 ${lossStr})`);
    }
  }

  // 매매 결과 (rows 제외)
  const tradesOut = events.map((e, i) => ({
    code: e.code, name: e.name, market: e.market,
    qvaDate: e.qvaDate, vviDate: e.vviDate, buyDate: e.buyDate,
    buyPrice: e.buyPrice, vviHigh: e.vviHigh, vviClose: e.vviClose,
    nextDayCategory: e.nextDayCategory,
    results: Object.fromEntries(SCENARIOS.map(sc => [sc.key, scenarioResults[sc.key][i]?.result || null])),
  }));

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'VVI돌파대기 매매 승률 백테스트',
      purpose: '보드 VVI_FIRED 단계에서 발견 → 다음날 매수 시 진짜 승률 검증. 돌파 성공/실패 사후 정보를 필터로 사용하지 않음 (보드에서 보이는 정보만).',
      inputRange: `${FROM} ~ ${TO}`,
    },
    config: {
      from: FROM, to: TO,
      entryPrice: ENTRY_PRICE,
      holdDays: HOLD_DAYS,
      scenarios: SCENARIOS,
      buySource: `VVI 발생 다음 거래일 ${ENTRY_PRICE === 'open' ? '시가 (장초반)' : '종가'}`,
    },
    counts: {
      totalEvents: events.length,
      ...categoryCount,
      successRate: rate(categoryCount.BREAKOUT_SUCCESS, events.length),
    },
    scenarioSummary,
    summary,
    trades: tradesOut,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

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
<title>VVI돌파대기 매매 승률 백테스트</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px; -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile.primary { border-left: 4px solid #0ea5e9; } .big-tile.primary .value { color: #67e8f9; }
.big-tile.success { border-left: 4px solid #14b8a6; } .big-tile.success .value { color: #5eead4; }
.big-tile.warn { border-left: 4px solid #f59e0b; } .big-tile.warn .value { color: #fde047; }
.big-tile.fail { border-left: 4px solid #ef4444; } .big-tile.fail .value { color: #fca5a5; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 17px; font-weight: 700; color: #f1f5f9; line-height: 1.2; margin-top: 3px; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; }

.scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; margin-bottom: 14px; border-radius: 8px; }
.scroll-x table.cmp { margin-bottom: 0; }
table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 12px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; }
table.cmp thead th:first-child { text-align: left; }
table.cmp tbody td { padding: 8px 12px; border-bottom: 1px solid #334155; text-align: right; font-variant-numeric: tabular-nums; }
table.cmp tbody td:first-child { text-align: left; color: #cbd5e1; font-weight: 600; }
table.cmp tbody tr:hover td { background: #273549; }
.row-highlight td { background: rgba(13, 148, 136, 0.18) !important; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-neutral { color: #94a3b8; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; }
  .scroll-x table.cmp { width: max-content; min-width: 100%; white-space: nowrap; }
}
</style>
</head>
<body>

<h1>VVI돌파대기 매매 승률 백테스트</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  보드 <strong>VVI_FIRED 단계</strong> (=VVI돌파대기)에서 종목을 발견했을 때, <strong id="entry-label"></strong>에 매수했다고 가정하고
  매일 고가·저가 기준 시뮬레이션해서 진짜 승률과 평균 수익을 검증합니다.
  보수적: 같은 날 고가·저가 둘 다 닿으면 손절 우선 청산. 시초가 갭 반영.
</div>

<div class="warn-banner">
  ⚠️ <strong>매수 추천이 아닙니다.</strong> 매매 규칙별 통계 검증입니다.
  돌파 성공/실패는 보드 발견 시점에 알 수 없으므로 <strong>사후 분류</strong>입니다 (필터 아닌 결과 분석용).
</div>

<h2>📊 다음날 돌파 결과 분포</h2>
<div class="big-summary" id="category-summary"></div>

<h2>📊 시나리오별 전체 결과 (필터 없음 = 보드 보고 무조건 매수했을 때)</h2>
<p class="subtitle"><strong>매번 평균</strong> = 1번 매수당 평균 결과 (양수면 통계적으로 유리).</p>
<div id="scenario-summary-table"></div>

<h2>📊 시나리오 × 다음날 돌파 결과별 (사후 분류, 참고용)</h2>
<p class="subtitle">VVI돌파대기 종목이 다음날 어떻게 됐는지에 따른 결과 분류. <strong>매수 시점에는 알 수 없는 정보</strong>이지만, 어떤 종목이 결국 올라갔는지 패턴 파악에 도움.</p>
<div id="matrix-table"></div>

<h2>📋 개별 매매 결과</h2>
<p class="subtitle">개별 사례 (최대 200건). ✅ 익절 / ❌ 손절 / ⏱ 시간종료 / 🔀 분할청산.</p>
<div id="trades-list"></div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtPct(v) {
  if (v == null || !isFinite(v)) return '<span class="cell-neutral">-</span>';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%</span>';
}
function fmtRate(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v >= 50 ? 'cell-pos' : (v < 35 ? 'cell-neg' : 'cell-neutral');
  return '<span class="' + cls + '">' + Number(v).toFixed(1) + '%</span>';
}
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8); }

const cfg = DATA.config;
document.getElementById('subtitle').textContent =
  'VVI 발생 이벤트 ' + DATA.counts.totalEvents + '건 · 기간 ' + cfg.from + '~' + cfg.to + ' · ' +
  '매수 ' + cfg.buySource + ' / 보유 ' + cfg.holdDays + '거래일 · ' +
  '생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');
document.getElementById('entry-label').textContent = cfg.buySource;

// 카테고리 분포
const cnt = DATA.counts;
const total = cnt.totalEvents;
const catTiles = [
  { cls: 'primary', label: '전체 VVI 발생', value: total + '건', sub: cfg.from + '~' + cfg.to },
  { cls: 'success', label: '돌파 성공 (=H그룹)', value: cnt.BREAKOUT_SUCCESS + '건', sub: '비율 ' + (total ? (cnt.BREAKOUT_SUCCESS/total*100).toFixed(1) : 0) + '%' },
  { cls: 'warn', label: '약한 돌파', value: cnt.BREAKOUT_WEAK + '건', sub: '비율 ' + (total ? (cnt.BREAKOUT_WEAK/total*100).toFixed(1) : 0) + '%' },
  { cls: 'fail', label: '돌파 실패', value: cnt.NO_BREAKOUT + '건', sub: '비율 ' + (total ? (cnt.NO_BREAKOUT/total*100).toFixed(1) : 0) + '%' },
];
document.getElementById('category-summary').innerHTML = catTiles.map(t =>
  '<div class="big-tile ' + t.cls + '">' +
    '<div class="label">' + t.label + '</div>' +
    '<div class="value">' + t.value + '</div>' +
    '<div class="sub">' + t.sub + '</div>' +
  '</div>'
).join('');

// 시나리오 요약 표 (필터=ALL)
function scenarioSummaryTable(rows) {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>시나리오</th><th>n</th><th>승률</th>',
    '<th>평균 이익</th><th>평균 손실</th><th>매번 평균</th>',
    '<th>익절률</th><th>손절률</th><th>시간종료</th><th>연속손실 최대</th>',
    '<th>최고</th><th>최악</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    if (!r.count) continue;
    const cls = r.expectancy > 0 ? ' class="row-highlight"' : '';
    html.push('<tr' + cls + '>' +
      '<td>' + (r.scenarioLabel || '-') + '</td>' +
      '<td>' + (r.valid ?? '-') + '</td>' +
      '<td>' + fmtRate(r.winRate) + '</td>' +
      '<td>' + fmtPct(r.avgWin) + '</td>' +
      '<td>' + fmtPct(r.avgLoss) + '</td>' +
      '<td>' + fmtPct(r.expectancy) + '</td>' +
      '<td>' + (r.tpRate != null ? r.tpRate + '%' : '-') + '</td>' +
      '<td>' + (r.slRate != null ? r.slRate + '%' : '-') + '</td>' +
      '<td>' + (r.timeRate != null ? r.timeRate + '%' : '-') + '</td>' +
      '<td>' + (r.maxLossStreak ?? '-') + '</td>' +
      '<td>' + fmtPct(r.bestTrade) + '</td>' +
      '<td>' + fmtPct(r.worstTrade) + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('scenario-summary-table').innerHTML = scenarioSummaryTable(DATA.scenarioSummary);

// 매트릭스 (시나리오 × 카테고리)
function matrixTable() {
  const filters = ['BREAKOUT_SUCCESS', 'BREAKOUT_WEAK', 'NO_BREAKOUT'];
  const filterLabels = { BREAKOUT_SUCCESS: '돌파 성공', BREAKOUT_WEAK: '약한 돌파', NO_BREAKOUT: '돌파 실패' };
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>시나리오</th>'];
  for (const f of filters) html.push('<th>' + filterLabels[f] + '</th>');
  html.push('</tr></thead><tbody>');
  for (const sc of cfg.scenarios) {
    html.push('<tr><td>' + sc.label + '</td>');
    for (const f of filters) {
      const cell = DATA.summary.find(x => x.scenarioKey === sc.key && x.filterKey === f);
      if (!cell || !cell.valid) { html.push('<td>-</td>'); continue; }
      const wr = cell.winRate;
      const cls = wr >= 50 ? 'cell-pos' : (wr < 30 ? 'cell-neg' : '');
      html.push('<td><span class="' + cls + '">' + (wr ?? '-') + '%</span><br>' +
        '<span style="font-size:10px;color:#64748b;">매번 ' + (cell.expectancy != null ? (cell.expectancy > 0 ? '+' : '') + cell.expectancy + '%' : '-') + '</span><br>' +
        '<span style="font-size:10px;color:#64748b;">n=' + cell.valid + '</span></td>');
    }
    html.push('</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('matrix-table').innerHTML = matrixTable();

// 개별 매매 결과
function tradesTable() {
  const trades = DATA.trades || [];
  const scs = cfg.scenarios;
  const head = ['<th>#</th>', '<th>종목</th>', '<th>VVI일</th>', '<th>매수일</th>', '<th>매수가</th>', '<th>다음날 결과</th>'];
  for (const sc of scs) head.push('<th>' + sc.label + '</th>');
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>', head.join(''), '</tr></thead><tbody>'];
  trades.slice(0, 200).forEach((t, i) => {
    const r = t.results || {};
    const cell = (key) => {
      const x = r[key];
      if (!x) return '<td>-</td>';
      const ret = x.returnPct;
      const cls = ret > 0 ? 'cell-pos' : (ret < 0 ? 'cell-neg' : 'cell-neutral');
      const exit = x.exitType;
      const exitTag = exit === 'TP' || exit === 'TP_GAP' ? '✅' : (exit === 'SL' || exit === 'SL_GAP' ? '❌' : (exit === 'SPLIT' ? '🔀' : '⏱'));
      return '<td><span class="' + cls + '">' + exitTag + ' ' + (ret > 0 ? '+' : '') + ret + '%</span></td>';
    };
    const catLabel = { BREAKOUT_SUCCESS: '✅ 돌파성공', BREAKOUT_WEAK: '⚠ 약한돌파', NO_BREAKOUT: '❌ 실패' };
    const cells = [
      '<td>' + (i + 1) + '</td>',
      '<td>' + (t.name || '') + ' <span style="color:#64748b;">' + t.code + '</span></td>',
      '<td>' + fmtDate(t.vviDate) + '</td>',
      '<td>' + fmtDate(t.buyDate) + '</td>',
      '<td>' + (t.buyPrice ? t.buyPrice.toLocaleString() : '-') + '</td>',
      '<td><span style="font-size:11px;color:#94a3b8;">' + (catLabel[t.nextDayCategory] || t.nextDayCategory) + '</span></td>',
    ];
    for (const sc of scs) cells.push(cell(sc.key));
    html.push('<tr>' + cells.join('') + '</tr>');
  });
  if (trades.length > 200) {
    html.push('<tr><td colspan="' + (6 + scs.length) + '" style="text-align:center;color:#64748b;padding:10px;">... ' + (trades.length - 200) + '건 추가 (JSON 참조)</td></tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('trades-list').innerHTML = tradesTable();

document.getElementById('data-limit').innerHTML =
  '<strong>데이터 한계 / 시뮬레이션 가정</strong><br>' +
  '• 매수: ' + cfg.buySource + ' (체결 슬리피지 미반영)<br>' +
  '• 청산: 매일 고가·저가 기준. 같은 날 둘 다 닿으면 손절 우선 (보수적). 시초가 갭 반영<br>' +
  '• 시간 종료: 매수 후 ' + cfg.holdDays + '거래일 종가 청산<br>' +
  '• 다음날 돌파 결과(성공/약함/실패)는 매수 시점에 알 수 없음 — 사후 분류용 참고 데이터<br>' +
  '• 거래 수수료/세금 미반영 (실제 매매는 0.2~0.5% 추가 차감 필요)<br>' +
  '• 매수 추천이 아니라 매매 규칙별 통계 검증입니다.';
</script>

</body>
</html>
`;

main();
