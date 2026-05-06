#!/usr/bin/env node
/**
 * VPR Trade Win-Rate Backtest
 *
 * 목적:
 *   QVA → VVI → 돌파 성공(H그룹) 후보를 H돌파일 종가에 매수했다고 가정하고,
 *   여러 익절/손절 규칙으로 시뮬레이션해서 진짜 승률·기대값·손익비를 계산한다.
 *
 *   기존 백테스트는 "고가 +N% 한 번이라도 도달했나"를 본 반면, 이 스크립트는
 *   매일 high/low first-touch 방식으로 익절·손절 중 누가 먼저 닿는지 시뮬레이션.
 *
 *   QVA/VVI/H그룹/VPR 정의는 변경하지 않는다. vpr-analyzer.js 그대로 사용.
 *
 * 입력:
 *   reports/vpr-hgroup-three-year-with-flow-backtest-result.json (events + 분류)
 *   cache/stock-charts-long/{code}.json (시뮬레이션용 차트)
 *
 * 출력:
 *   reports/vpr-trade-winrate-backtest-result.json
 *   reports/vpr-trade-winrate-backtest-result.html
 *
 * 라우트: /vpr-trade-winrate
 *
 * 시나리오:
 *   A: 익절 +6% / 손절 -3%
 *   B: 익절 +10% / 손절 -5%
 *   C: 익절 +15% / 손절 -5%
 *   D: 익절 +20% / 손절 -5%
 *   E: 분할 (50% +6%, 30% +12%, 20% +16%, 손절 -5%, 본전 ratchet)
 *
 * 필터 (VPR 분류 = D+10 기준 / judgmentStatus = D+5 기준):
 *   ALL, STRONG_VPR_SUCCESS, CLASSIC_VPR_SUCCESS, NORMAL_PULLBACK_PENDING,
 *   NO_PULLBACK_RUNAWAY, STRUCTURAL_BREAK, REVIEW_OK, CHASE_CAUTION,
 *   PULLBACK_WAIT, MANAGEMENT, BREAKDOWN_WEAK, COMBO_*
 *
 * 매수 시점 (--entry-day):
 *   0  = H돌파일 종가 (기본, 가장 빠른 진입)
 *   5  = D+5 종가 (보드 노출 마지막 = "5일 보고 매수")
 *   10 = D+10 종가 (VPR 성숙 후)
 *
 * 시간 종료: 매수 후 N거래일 종가 청산 (--hold-days, 기본 10)
 *
 * 실행:
 *   node vpr-trade-winrate-backtest.js
 *   node vpr-trade-winrate-backtest.js --entry-day=5 --hold-days=5
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INPUT_PATH = path.join(REPORTS_DIR, 'vpr-hgroup-three-year-with-flow-backtest-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'vpr-trade-winrate-backtest-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'vpr-trade-winrate-backtest-result.html');

const args = (() => {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
})();
const ENTRY_DAY = parseInt(args['entry-day'] || '1', 10);  // 1=다음날(기본, 보드 발견 후 익일 매수), 0=H돌파일 종가, 5=D+5, 10=D+10
const ENTRY_PRICE = (args['entry-price'] || 'open').toLowerCase();  // open (기본, 장초반) | close
const HOLD_DAYS = parseInt(args['hold-days'] || '10', 10);  // 시간 종료까지 거래일

// ─── 시나리오 정의 ───
const SCENARIOS = [
  { key: 'A', label: '익절 +6% / 손절 -3%', short: '+6/-3', tp: 6, sl: -3, rr: '1:2', kind: 'simple' },
  { key: 'B', label: '익절 +10% / 손절 -5%', short: '+10/-5', tp: 10, sl: -5, rr: '1:2', kind: 'simple' },
  { key: 'C', label: '익절 +15% / 손절 -5%', short: '+15/-5', tp: 15, sl: -5, rr: '1:3', kind: 'simple' },
  { key: 'D', label: '익절 +20% / 손절 -5%', short: '+20/-5', tp: 20, sl: -5, rr: '1:4', kind: 'simple' },
  {
    key: 'E',
    label: '분할 청산 (50% +6 / 30% +12 / 20% +16, 본전 이동)',
    short: '분할 청산',
    kind: 'split',
    tiers: [
      { pct: 6, weight: 0.5 },
      { pct: 12, weight: 0.3 },
      { pct: 16, weight: 0.2 },
    ],
    sl: -5,
    rr: '복합',
  },
];

// ─── 통계 헬퍼 ───
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
function rate(num, denom) { if (!denom) return null; return round(num / denom * 100, 2); }
function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// ─── First-touch 시뮬레이션 (단순 OCO) ───
// 매수가 buyPrice, hold N거래일 동안 매일 high/low 체크.
// 익절가/손절가 중 먼저 닿는 쪽 청산. 갭다운 시 시초가가 손절가 아래면 시초가 청산 (slippage).
// 시간 종료 시 N거래일 종가 청산.
function simulateSimple(rows, buyIdx, buyPrice, tpPct, slPct, holdDays, entryPrice = 'close') {
  const tpPrice = buyPrice * (1 + tpPct / 100);
  const slPrice = buyPrice * (1 + slPct / 100);

  // entryPrice='open'일 때 매수일(buyIdx) 인트라데이도 체크
  // (open으로 이미 체결됐으니 same-day 갭 체크는 의미 없음, 인트라데이 high/low만 본다)
  if (entryPrice === 'open' && rows[buyIdx]) {
    const r = rows[buyIdx];
    if (r.low <= slPrice) {
      return { exitDay: 0, exitPrice: slPrice, exitType: 'SL', returnPct: round((slPrice / buyPrice - 1) * 100) };
    }
    if (r.high >= tpPrice) {
      return { exitDay: 0, exitPrice: tpPrice, exitType: 'TP', returnPct: round((tpPrice / buyPrice - 1) * 100) };
    }
  }

  for (let k = 1; k <= holdDays; k++) {
    const idx = buyIdx + k;
    if (idx >= rows.length) {
      // 데이터 부족 — 마지막 가능한 종가로 청산
      const lastIdx = rows.length - 1;
      if (lastIdx <= buyIdx) return null;
      return {
        exitDay: lastIdx - buyIdx,
        exitPrice: rows[lastIdx].close,
        exitType: 'TIME',
        returnPct: round((rows[lastIdx].close / buyPrice - 1) * 100),
      };
    }
    const r = rows[idx];
    const o = r.open, h = r.high, l = r.low, c = r.close;

    // 갭 처리: 시초가가 이미 익절/손절선 너머로 갭하면 시초가 체결
    if (o >= tpPrice) {
      return { exitDay: k, exitPrice: o, exitType: 'TP_GAP', returnPct: round((o / buyPrice - 1) * 100) };
    }
    if (o <= slPrice) {
      return { exitDay: k, exitPrice: o, exitType: 'SL_GAP', returnPct: round((o / buyPrice - 1) * 100) };
    }
    // 장중 익절/손절 first-touch — 보수적으로 손절 먼저 (high와 low 둘 다 닿은 케이스 = 손절 우선)
    if (l <= slPrice) {
      return { exitDay: k, exitPrice: slPrice, exitType: 'SL', returnPct: round((slPrice / buyPrice - 1) * 100) };
    }
    if (h >= tpPrice) {
      return { exitDay: k, exitPrice: tpPrice, exitType: 'TP', returnPct: round((tpPrice / buyPrice - 1) * 100) };
    }
  }
  // 시간 종료 — N거래일 종가 청산
  const idx = buyIdx + holdDays;
  if (idx >= rows.length) return null;
  return {
    exitDay: holdDays,
    exitPrice: rows[idx].close,
    exitType: 'TIME',
    returnPct: round((rows[idx].close / buyPrice - 1) * 100),
  };
}

// ─── 분할 익절 시뮬레이션 ───
// tiers: [{pct, weight}, ...] 순서대로 도달 체크. 도달 시 weight만큼 청산 + 손절선 ratchet up.
// 첫 익절 도달 후 손절선을 매수가(본전)로 이동, 두 번째 후 첫 익절가로, ...
function simulateSplit(rows, buyIdx, buyPrice, tiers, slPct, holdDays, entryPrice = 'close') {
  let remaining = 1.0;
  let realized = 0;  // 누적 실현 수익률 × weight 합
  let stopPrice = buyPrice * (1 + slPct / 100);  // 초기 손절가
  let nextTier = 0;
  const exits = [];

  // entryPrice='open'일 때 매수일 인트라데이 체크 (open으로 체결, 갭 의미 없음)
  if (entryPrice === 'open' && rows[buyIdx]) {
    const r = rows[buyIdx];
    if (r.low <= stopPrice) {
      const exitPct = (stopPrice / buyPrice - 1) * 100;
      realized += remaining * exitPct;
      exits.push({ day: 0, type: 'SL', weight: remaining, exitPrice: stopPrice, returnPct: round(exitPct) });
      remaining = 0;
    } else {
      while (nextTier < tiers.length) {
        const t = tiers[nextTier];
        const tp = buyPrice * (1 + t.pct / 100);
        if (r.high >= tp) {
          realized += t.weight * t.pct;
          exits.push({ day: 0, type: 'TP', tier: t.pct, weight: t.weight, exitPrice: tp, returnPct: t.pct });
          remaining -= t.weight;
          nextTier++;
          if (nextTier === 1) stopPrice = buyPrice;
          else stopPrice = buyPrice * (1 + tiers[nextTier - 2].pct / 100);
        } else break;
      }
    }
  }

  for (let k = 1; k <= holdDays; k++) {
    const idx = buyIdx + k;
    if (idx >= rows.length) break;
    const r = rows[idx];
    const o = r.open, h = r.high, l = r.low;

    // 갭다운 시 시초가가 stopPrice 아래로 갭 → 잔여 전부 시초가 청산
    if (o <= stopPrice) {
      const exitPct = (o / buyPrice - 1) * 100;
      realized += remaining * exitPct;
      exits.push({ day: k, type: 'SL_GAP', weight: remaining, exitPrice: o, returnPct: round(exitPct) });
      remaining = 0;
      break;
    }
    // 갭상승: 시초가가 다음 익절 tier 이상이면 그 티어 청산
    while (nextTier < tiers.length) {
      const t = tiers[nextTier];
      const tp = buyPrice * (1 + t.pct / 100);
      if (o >= tp) {
        realized += t.weight * t.pct;
        exits.push({ day: k, type: 'TP_GAP', tier: t.pct, weight: t.weight, exitPrice: o, returnPct: t.pct });
        remaining -= t.weight;
        nextTier++;
        // 손절선 ratchet: 첫 tp 도달 시 본전, 그 다음은 직전 tp 가격
        if (nextTier === 1) stopPrice = buyPrice;
        else stopPrice = buyPrice * (1 + tiers[nextTier - 2].pct / 100);
      } else break;
    }
    if (remaining <= 0) break;

    // 장중 손절 first (보수적)
    if (l <= stopPrice) {
      const exitPct = (stopPrice / buyPrice - 1) * 100;
      realized += remaining * exitPct;
      exits.push({ day: k, type: 'SL', weight: remaining, exitPrice: stopPrice, returnPct: round(exitPct) });
      remaining = 0;
      break;
    }
    // 장중 익절 tier 도달
    while (nextTier < tiers.length) {
      const t = tiers[nextTier];
      const tp = buyPrice * (1 + t.pct / 100);
      if (h >= tp) {
        realized += t.weight * t.pct;
        exits.push({ day: k, type: 'TP', tier: t.pct, weight: t.weight, exitPrice: tp, returnPct: t.pct });
        remaining -= t.weight;
        nextTier++;
        if (nextTier === 1) stopPrice = buyPrice;
        else stopPrice = buyPrice * (1 + tiers[nextTier - 2].pct / 100);
      } else break;
    }
    if (remaining <= 0) break;
  }
  // 시간 종료 — 잔여분 종가 청산
  if (remaining > 0) {
    const idx = buyIdx + holdDays;
    if (idx < rows.length) {
      const c = rows[idx].close;
      const exitPct = (c / buyPrice - 1) * 100;
      realized += remaining * exitPct;
      exits.push({ day: holdDays, type: 'TIME', weight: remaining, exitPrice: c, returnPct: round(exitPct) });
      remaining = 0;
    }
  }
  // 반올림 + 분류
  const totalReturn = round(realized);
  const isWin = totalReturn > 0;
  return {
    exitType: 'SPLIT',
    returnPct: totalReturn,
    exits,
    isWin,
  };
}

// ─── 그룹 통계 ───
function summarize(label, trades) {
  const valid = trades.filter(t => t.result != null);
  if (valid.length === 0) return { label, count: 0, valid: 0 };
  const returns = valid.map(t => t.result.returnPct);
  const wins = valid.filter(t => t.result.returnPct > 0);
  const losses = valid.filter(t => t.result.returnPct <= 0);
  const tpExits = valid.filter(t => t.result.exitType === 'TP' || t.result.exitType === 'TP_GAP');
  const slExits = valid.filter(t => t.result.exitType === 'SL' || t.result.exitType === 'SL_GAP');
  const timeExits = valid.filter(t => t.result.exitType === 'TIME');
  const splitExits = valid.filter(t => t.result.exitType === 'SPLIT');

  const winReturns = wins.map(t => t.result.returnPct);
  const lossReturns = losses.map(t => t.result.returnPct);
  const avgWin = mean(winReturns);
  const avgLoss = mean(lossReturns);
  const winRate = wins.length / valid.length;
  const expectancy = winRate * (avgWin || 0) + (1 - winRate) * (avgLoss || 0);

  // 최대 연속 손실
  let maxLossStreak = 0, curStreak = 0;
  for (const t of valid) {
    if (t.result.returnPct <= 0) { curStreak++; if (curStreak > maxLossStreak) maxLossStreak = curStreak; }
    else curStreak = 0;
  }

  // 평균 보유 일수
  const avgHoldDays = mean(valid.map(t => t.result.exitDay).filter(v => v != null));

  return {
    label, count: trades.length, valid: valid.length,
    winRate: round(winRate * 100),
    winCount: wins.length, lossCount: losses.length,
    avgReturn: round(mean(returns)),
    medianReturn: round(median(returns)),
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    rrRatio: avgLoss && avgLoss !== 0 ? round(Math.abs(avgWin / avgLoss), 2) : null,
    expectancy: round(expectancy),
    tpRate: rate(tpExits.length, valid.length),
    slRate: rate(slExits.length, valid.length),
    timeRate: rate(timeExits.length, valid.length),
    splitCount: splitExits.length,
    maxLossStreak,
    avgHoldDays: round(avgHoldDays, 1),
    bestTrade: round(Math.max(...returns)),
    worstTrade: round(Math.min(...returns)),
  };
}

// ─────────────────────── 메인 ───────────────────────
function main() {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`[ERROR] 입력 없음: ${INPUT_PATH}`);
    console.error(`먼저 \`node vpr-hgroup-long-period-maturity-backtest.js --from=20230101 --to=20260420 --label=three-year-with-flow\`를 실행하세요.`);
    process.exit(1);
  }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const inputData = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const events = inputData.events || [];

  console.log(`\n📊 VPR Trade Win-Rate Backtest`);
  console.log(`  입력 이벤트: ${events.length}건 (3년+flow 백테스트 결과)`);
  console.log(`  매수 시점:    D+${ENTRY_DAY} ${ENTRY_PRICE === 'open' ? '시가 (장초반)' : '종가'} / 시간 종료: 매수 후 ${HOLD_DAYS}거래일`);
  console.log(`  시나리오:    ${SCENARIOS.length}종 (A, B, C, D, E)`);

  // ─── 각 이벤트별 매수가/시뮬레이션 데이터 준비 ───
  const eventTrades = [];  // [{event, buyPrice, rows, buyIdx, valid}]
  let skipNoChart = 0, skipNoEntry = 0, skipNoData = 0;

  for (const e of events) {
    const chartPath = path.join(CHART_DIR, `${e.code}.json`);
    if (!fs.existsSync(chartPath)) { skipNoChart++; continue; }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8')); }
    catch (_) { skipNoChart++; continue; }
    const rows = chart.rows || [];
    const hIdx = rows.findIndex(r => r.date === e.hDate);
    if (hIdx < 0) { skipNoEntry++; continue; }
    const buyIdx = hIdx + ENTRY_DAY;
    if (buyIdx >= rows.length) { skipNoEntry++; continue; }
    const buyPrice = ENTRY_PRICE === 'open' ? rows[buyIdx].open : rows[buyIdx].close;
    if (!buyPrice || buyPrice <= 0) { skipNoEntry++; continue; }
    // 시간 종료 데이터 충분한가 — 매수 후 최소 3거래일은 있어야 의미 있음
    if (buyIdx + 3 >= rows.length) { skipNoData++; continue; }

    eventTrades.push({
      event: e,
      buyPrice,
      buyIdx,
      buyDate: rows[buyIdx].date,
      rows,
      d5VprStatus: e.d5Snapshot?.vprStatus,
      d10VprStatus: e.d10Snapshot?.vprStatus,
      d5Judgment: e.d5Snapshot?.judgmentStatus,
      d10Judgment: e.d10Snapshot?.judgmentStatus,
    });
  }
  console.log(`  실효 trade: ${eventTrades.length}건 (skip: chart ${skipNoChart}, entry ${skipNoEntry}, data ${skipNoData})`);

  // ─── 각 시나리오 시뮬레이션 ───
  const scenarioResults = {};
  for (const sc of SCENARIOS) {
    const trades = [];
    for (const t of eventTrades) {
      let result = null;
      if (sc.kind === 'simple') {
        result = simulateSimple(t.rows, t.buyIdx, t.buyPrice, sc.tp, sc.sl, HOLD_DAYS, ENTRY_PRICE);
      } else if (sc.kind === 'split') {
        result = simulateSplit(t.rows, t.buyIdx, t.buyPrice, sc.tiers, sc.sl, HOLD_DAYS, ENTRY_PRICE);
      }
      trades.push({ ...t, result });
    }
    scenarioResults[sc.key] = { scenario: sc, trades };
  }

  // ─── 필터별 집계 (D+5 시점 = 보드에서 실제로 보이는 것만) ───
  const FILTERS = [
    { key: 'ALL', label: '전체 (필터 없음)', match: (_t) => true },
    // judgmentStatus (보드 정렬 1차 키)
    { key: 'D5J_PWAIT', label: '눌림대기 (judgmentStatus)', match: t => t.d5Judgment === 'PULLBACK_WAIT' },
    { key: 'D5J_MGMT', label: '관리구간 (judgmentStatus)', match: t => t.d5Judgment === 'MANAGEMENT' },
    { key: 'D5J_BWEAK', label: '돌파악화 (judgmentStatus) — 매수금지', match: t => t.d5Judgment === 'BREAKDOWN_WEAK' },
    // VPR 분류 (보드의 7라벨)
    { key: 'D5V_STRONG', label: 'VPR: 강한 성공', match: t => t.d5VprStatus === 'STRONG_VPR_SUCCESS' },
    { key: 'D5V_CLASSIC', label: 'VPR: 정석 성공', match: t => t.d5VprStatus === 'CLASSIC_VPR_SUCCESS' },
    { key: 'D5V_RUNAWAY', label: 'VPR: 눌림없이 상승', match: t => t.d5VprStatus === 'NO_PULLBACK_RUNAWAY' },
    { key: 'D5V_PENDING', label: 'VPR: 눌림 대기 (분류)', match: t => t.d5VprStatus === 'PULLBACK_PENDING' },
    { key: 'D5V_WEAK', label: 'VPR: 약한 재돌파', match: t => t.d5VprStatus === 'WEAK_VPR_REBOUND' },
    { key: 'D5V_STRUCT', label: 'VPR: 구조 훼손 — 매수금지', match: t => t.d5VprStatus === 'STRUCTURAL_BREAK' },
    // 의미있는 조합
    { key: 'COMBO_PWAIT_GOOD', label: '조합 ✅: 눌림대기 + 좋은 VPR (강한/정석/상승)', match: t => t.d5Judgment === 'PULLBACK_WAIT' && ['STRONG_VPR_SUCCESS', 'CLASSIC_VPR_SUCCESS', 'NO_PULLBACK_RUNAWAY'].includes(t.d5VprStatus) },
    { key: 'COMBO_MGMT_RUNAWAY', label: '조합 ✅: 관리구간 + 눌림없이 상승', match: t => t.d5Judgment === 'MANAGEMENT' && t.d5VprStatus === 'NO_PULLBACK_RUNAWAY' },
    { key: 'COMBO_BWEAK_STRUCT', label: '조합 ❌: 돌파악화 + 구조훼손 — 매수금지', match: t => t.d5Judgment === 'BREAKDOWN_WEAK' && t.d5VprStatus === 'STRUCTURAL_BREAK' },
  ];

  const summary = [];
  for (const sc of SCENARIOS) {
    const trades = scenarioResults[sc.key].trades;
    for (const f of FILTERS) {
      const filtered = trades.filter(t => f.match(t));
      if (filtered.length === 0) continue;
      const stat = summarize(`${sc.label} | ${f.label}`, filtered);
      summary.push({
        scenarioKey: sc.key, scenarioLabel: sc.label, scenarioRR: sc.rr,
        filterKey: f.key, filterLabel: f.label,
        ...stat,
      });
    }
  }

  // ─── 시나리오 × 전체 비교 (요약 표) ───
  const scenarioSummary = SCENARIOS.map(sc => {
    const all = summary.find(s => s.scenarioKey === sc.key && s.filterKey === 'ALL');
    return all || { scenarioKey: sc.key, scenarioLabel: sc.label, scenarioRR: sc.rr, count: 0, valid: 0 };
  });

  // ─── 시나리오 × D+5 분류 매트릭스 ───
  const d5Matrix = {};
  for (const sc of SCENARIOS) {
    d5Matrix[sc.key] = {};
    for (const f of ['ALL', 'D5J_PWAIT', 'D5J_MGMT', 'D5J_BWEAK', 'D5V_STRONG', 'D5V_CLASSIC', 'D5V_RUNAWAY', 'D5V_PENDING', 'D5V_WEAK', 'D5V_STRUCT']) {
      const s = summary.find(x => x.scenarioKey === sc.key && x.filterKey === f);
      if (s) d5Matrix[sc.key][f] = s;
    }
  }

  const trades = scenarioResults.A.trades;  // 어떤 시나리오든 trade 목록 동일 (result만 다름)
  const eventTradesOut = trades.map(t => ({
    code: t.event.code,
    name: t.event.name,
    market: t.event.market,
    hDate: t.event.hDate,
    buyDate: t.buyDate,
    buyPrice: t.buyPrice,
    d5VprStatus: t.d5VprStatus,
    d10VprStatus: t.d10VprStatus,
    d5Judgment: t.d5Judgment,
    d10Judgment: t.d10Judgment,
    results: Object.fromEntries(SCENARIOS.map(sc => [
      sc.key, scenarioResults[sc.key].trades.find(x => x.event.eventKey === t.event.eventKey)?.result || null,
    ])),
  }));

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'VPR Trade Win-Rate Backtest',
      purpose: 'QVA→VVI→돌파 성공 후보를 H돌파일 종가에 매수 + 5종 익절/손절 시나리오 first-touch 시뮬레이션. 진짜 승률·기대값·손익비 검증.',
      notice: 'QVA/VVI/H그룹/VPR 정의 변경 없음. vpr-analyzer.js 그대로. 매수 추천이 아니라 트레이드 규칙별 통계 검증.',
      inputSource: 'reports/vpr-hgroup-three-year-with-flow-backtest-result.json (이벤트 448건)',
      simulationKind: 'first-touch (high/low 기준 익절·손절 누가 먼저 닿는가, 갭 슬리피지 반영, 손절 우선 보수적)',
    },
    config: {
      entryDay: ENTRY_DAY,
      entryPrice: ENTRY_PRICE,
      holdDays: HOLD_DAYS,
      scenarios: SCENARIOS,
      buySource: (() => {
        const dayLabel = ENTRY_DAY === 0 ? 'H돌파일' : `D+${ENTRY_DAY}`;
        const priceLabel = ENTRY_PRICE === 'open' ? '시가 (장초반)' : '종가';
        return `${dayLabel} ${priceLabel}`;
      })(),
    },
    counts: {
      totalEvents: events.length,
      effectiveTrades: eventTrades.length,
      skipNoChart, skipNoEntry, skipNoData,
    },
    scenarioSummary,
    d5Matrix,
    summary,
    trades: eventTradesOut,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // ─── 콘솔 출력 ───
  console.log(`\n📊 시나리오별 전체 (필터 없음):`);
  console.log(`  시나리오                                  n     승률   평균이익  평균손실  매번 평균  연속손실  보유일`);
  for (const s of scenarioSummary) {
    if (!s.count) continue;
    console.log(`  ${(s.scenarioLabel || '-').padEnd(45)} ${String(s.valid).padStart(4)}  ${String(s.winRate ?? '-').padStart(6)}%  ${String(s.avgWin ?? '-').padStart(7)}%  ${String(s.avgLoss ?? '-').padStart(7)}%  ${String(s.expectancy ?? '-').padStart(7)}%  ${String(s.maxLossStreak ?? '-').padStart(7)}  ${String(s.avgHoldDays ?? '-').padStart(5)}`);
  }

  console.log(`\n📊 D+5 보드 정보별 매번 평균(=기대값) % — 같은 보드 신호로 일관 매수했을 때 1번당 평균 결과`);
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
      console.log(`    ${tag} ${sc.label.padEnd(45)} 승률 ${String(s.winRate).padStart(5)}%  매번평균 ${String(s.expectancy >= 0 ? '+' : '') + s.expectancy}%  (이익 ${winStr} / 손실 ${lossStr})`);
    }
  }

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
<title>VPR Trade Win-Rate Backtest</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px; -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 14px 0 8px; color: #cbd5e1; }
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

.scroll-x {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  max-width: 100%;
  margin-bottom: 14px;
  border-radius: 8px;
}
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

.tabs { display: flex; gap: 6px; margin: 18px 0 8px; flex-wrap: wrap; }
.tab-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-weight: 500; }
.tab-btn:hover { color: #f1f5f9; border-color: #64748b; }
.tab-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }

.scenario-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.scenario-card h3 { margin-top: 0; color: #67e8f9; font-size: 14px; }

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

<h1>VPR 매매 승률 백테스트</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  QVA→VVI→돌파 성공(H그룹) 후보를 <strong id="entry-label"></strong>에 매수했다고 가정하고,
  <strong>5가지 익절/손절 규칙</strong>으로 매일 고가·저가 기준 시뮬레이션해서 진짜 승률과 평균 수익을 검증합니다.
  보수적 가정: 같은 날 고가·저가 둘 다 닿으면 손절 우선 청산. 시초가 갭 반영.
</div>

<div class="warn-banner">
  ⚠️ <strong>매수 추천이 아닙니다.</strong> 매매 규칙별 통계 검증입니다.
  필터 기준은 <strong>D+5 시점에 보드에서 실제로 보이는 정보만</strong> 사용합니다 (judgmentStatus + VPR 분류).
  입력은 3년+flow 백테스트 이벤트 448건.
</div>

<h2>📊 시나리오별 핵심 타일 (필터 없음)</h2>
<div class="big-summary" id="big-summary"></div>

<h2>📊 시나리오별 전체 비교 (필터 없음)</h2>
<p class="subtitle">5가지 익절/손절 규칙을 같은 표본에 적용한 결과. <strong>매번 평균</strong> = 1번 매수당 평균 결과 (양수면 통계적으로 유리).</p>
<div id="scenario-summary-table"></div>

<h2>📊 시나리오 × D+5 보드 정보별 승률 매트릭스</h2>
<p class="subtitle">각 셀 = 승률(거래수). D+5 시점에 보드에서 실제로 볼 수 있는 분류만 사용.</p>
<div id="matrix-table"></div>

<h2>🏆 시나리오별 가장 좋은 D+5 필터 (n≥10, 매번 평균 기준)</h2>
<p class="subtitle">각 시나리오에서 가장 평균 결과가 좋은 D+5 필터 (사례 수 10건 이상만).</p>
<div id="best-filter-table"></div>

<h2>📋 시나리오별 D+5 필터 상세</h2>
<div class="tabs" id="scenario-tabs"></div>
<div id="scenario-detail"></div>

<h2>📋 개별 매매 결과</h2>
<p class="subtitle">개별 사례. 5가지 시나리오 결과를 모두 표시. ✅ 익절 / ❌ 손절 / ⏱ 시간종료 / 🔀 분할청산.</p>
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
function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}

const cfg = DATA.config;
document.getElementById('subtitle').textContent =
  '입력 ' + DATA.counts.totalEvents + '건 → 실제 매매 ' + DATA.counts.effectiveTrades + '건 · ' +
  '매수 ' + cfg.buySource + ' / 보유 ' + cfg.holdDays + '거래일 · ' +
  '생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');
document.getElementById('entry-label').textContent = cfg.buySource;

// 핵심 타일
const ssum = DATA.scenarioSummary;
const tiles = ssum.map((s, i) => ({
  cls: s.expectancy > 0 ? 'success' : 'fail',
  label: s.scenarioLabel,
  value: s.winRate != null ? s.winRate + '%' : '-',
  sub: 'n=' + (s.valid || 0) + ' / 매번평균 ' + (s.expectancy != null ? (s.expectancy > 0 ? '+' : '') + s.expectancy + '%' : '-'),
}));
document.getElementById('big-summary').innerHTML = tiles.map(t =>
  '<div class="big-tile ' + t.cls + '">' +
    '<div class="label">' + t.label + '</div>' +
    '<div class="value">' + t.value + '</div>' +
    (t.sub ? '<div class="sub">' + t.sub + '</div>' : '') +
  '</div>'
).join('');

// 시나리오 요약 표
function scenarioSummaryTable(rows) {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>시나리오</th><th>n</th><th>승률</th>',
    '<th>평균 이익</th><th>평균 손실</th><th>매번 평균</th>',
    '<th>익절률</th><th>손절률</th><th>시간종료</th><th>연속손실 최대</th><th>평균 보유일</th>',
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
      '<td>' + (r.avgHoldDays != null ? r.avgHoldDays + '일' : '-') + '</td>' +
      '<td>' + fmtPct(r.bestTrade) + '</td>' +
      '<td>' + fmtPct(r.worstTrade) + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('scenario-summary-table').innerHTML = scenarioSummaryTable(ssum);

// 매트릭스 (시나리오 × D+5 필터, 셀 = 승률(n))
function matrixTable(matrix, scenarios, filters) {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>시나리오</th>'];
  for (const f of filters) html.push('<th>' + f.short + '</th>');
  html.push('</tr></thead><tbody>');
  for (const sc of scenarios) {
    html.push('<tr><td>' + sc.label + '</td>');
    for (const f of filters) {
      const cell = matrix[sc.key]?.[f.key];
      if (!cell || !cell.valid) {
        html.push('<td>-</td>');
        continue;
      }
      const wr = cell.winRate;
      const cls = wr >= 50 ? 'cell-pos' : (wr < 30 ? 'cell-neg' : '');
      html.push('<td><span class="' + cls + '">' + (wr ?? '-') + '%</span><br><span style="font-size:10px;color:#64748b;">n=' + cell.valid + '</span></td>');
    }
    html.push('</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
const matrixFilters = [
  { key: 'ALL', short: '전체' },
  { key: 'D5J_PWAIT', short: '눌림대기' },
  { key: 'D5J_MGMT', short: '관리구간' },
  { key: 'D5J_BWEAK', short: '돌파악화' },
  { key: 'D5V_STRONG', short: 'VPR 강한' },
  { key: 'D5V_CLASSIC', short: 'VPR 정석' },
  { key: 'D5V_RUNAWAY', short: '눌림없이' },
  { key: 'D5V_PENDING', short: 'VPR 대기' },
  { key: 'D5V_WEAK', short: '약한 재돌파' },
  { key: 'D5V_STRUCT', short: '구조훼손' },
];
document.getElementById('matrix-table').innerHTML = matrixTable(DATA.d5Matrix, cfg.scenarios, matrixFilters);

// 베스트 필터 (각 시나리오에서 매번 평균 기준 top, n≥10)
function bestFilterTable() {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>시나리오</th><th>가장 좋은 D+5 필터</th><th>n</th><th>승률</th>',
    '<th>평균 이익</th><th>평균 손실</th><th>매번 평균</th><th>최악</th>',
    '</tr></thead><tbody>'];
  for (const sc of cfg.scenarios) {
    const candidates = DATA.summary.filter(s => s.scenarioKey === sc.key && (s.valid || 0) >= 10 && s.filterKey !== 'ALL');
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity));
    const best = candidates[0];
    const cls = best.expectancy > 0 ? ' class="row-highlight"' : '';
    html.push('<tr' + cls + '>' +
      '<td>' + sc.label + '</td>' +
      '<td>' + best.filterLabel + '</td>' +
      '<td>' + best.valid + '</td>' +
      '<td>' + fmtRate(best.winRate) + '</td>' +
      '<td>' + fmtPct(best.avgWin) + '</td>' +
      '<td>' + fmtPct(best.avgLoss) + '</td>' +
      '<td>' + fmtPct(best.expectancy) + '</td>' +
      '<td>' + fmtPct(best.worstTrade) + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('best-filter-table').innerHTML = bestFilterTable();

// 시나리오 × D+5 필터 디테일 (탭별)
let curTab = cfg.scenarios[0].key;
document.getElementById('scenario-tabs').innerHTML = cfg.scenarios.map(s =>
  '<button class="tab-btn' + (s.key === curTab ? ' active' : '') + '" data-tab="' + s.key + '">' + s.label + '</button>'
).join('');
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    curTab = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderScenarioDetail();
  });
});
function renderScenarioDetail() {
  const rows = DATA.summary.filter(s => s.scenarioKey === curTab && (s.valid || 0) > 0);
  rows.sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity));
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>D+5 필터</th><th>n</th><th>승률</th><th>평균 이익</th><th>평균 손실</th>',
    '<th>매번 평균</th><th>익절률</th><th>손절률</th><th>시간종료</th>',
    '<th>최고</th><th>최악</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    const cls = r.expectancy > 0 ? ' class="row-highlight"' : '';
    html.push('<tr' + cls + '>' +
      '<td>' + r.filterLabel + '</td>' +
      '<td>' + r.valid + '</td>' +
      '<td>' + fmtRate(r.winRate) + '</td>' +
      '<td>' + fmtPct(r.avgWin) + '</td>' +
      '<td>' + fmtPct(r.avgLoss) + '</td>' +
      '<td>' + fmtPct(r.expectancy) + '</td>' +
      '<td>' + (r.tpRate != null ? r.tpRate + '%' : '-') + '</td>' +
      '<td>' + (r.slRate != null ? r.slRate + '%' : '-') + '</td>' +
      '<td>' + (r.timeRate != null ? r.timeRate + '%' : '-') + '</td>' +
      '<td>' + fmtPct(r.bestTrade) + '</td>' +
      '<td>' + fmtPct(r.worstTrade) + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById('scenario-detail').innerHTML = html.join('');
}
renderScenarioDetail();

// 개별 trade 리스트 — D+5 정보만 표시
function tradesTable() {
  const trades = DATA.trades || [];
  const scs = cfg.scenarios;
  const head = ['<th>#</th>', '<th>종목</th>', '<th>매수일</th>', '<th>매수가</th>',
    '<th>D+5 화면</th>', '<th>D+5 VPR</th>'];
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
    const cells = [
      '<td>' + (i + 1) + '</td>',
      '<td>' + (t.name || '') + ' <span style="color:#64748b;">' + t.code + '</span></td>',
      '<td>' + fmtDate(t.buyDate) + '</td>',
      '<td>' + (t.buyPrice ? t.buyPrice.toLocaleString() : '-') + '</td>',
      '<td><span style="font-size:11px;color:#94a3b8;">' + (t.d5Judgment || '-') + '</span></td>',
      '<td><span style="font-size:11px;color:#94a3b8;">' + (t.d5VprStatus || '-') + '</span></td>',
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
  '• <strong>필터는 D+5 시점 정보만 사용</strong> — 보드에서 실제로 보이는 judgmentStatus + VPR 분류 (look-ahead 없음)<br>' +
  '• 거래 수수료/세금 미반영 (실제 매매는 0.2~0.5% 추가 차감 필요)<br>' +
  '• 매수 추천이 아니라 매매 규칙별 통계 검증입니다.';
</script>

</body>
</html>
`;

main();
