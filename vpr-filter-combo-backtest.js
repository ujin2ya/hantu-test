#!/usr/bin/env node
/**
 * VPR 필터 조합 검증 — 진입가 거리 필터 + 시장 레짐 필터
 *
 * 목적:
 *   H그룹/VPR 조건에 진입가 거리 필터와 시장 레짐 필터를 더했을 때
 *   승률·매번 평균·표본 수가 어떻게 변하는지 검증.
 *
 *   "승률만 높이는" 방향이 아니라, 멀리 올라간 종목과 시장 약세 구간을 제거하면
 *   매번 평균이 유지/개선되는지 확인하는 게 목적.
 *
 * 입력:
 *   reports/vpr-hgroup-three-year-with-flow-backtest-result.json  (이벤트 448건)
 *   cache/stock-charts-long/{code}.json
 *   cache/kospi-daily.json, cache/kosdaq-daily.json (3년치)
 *
 * 출력:
 *   reports/vpr-filter-combo-backtest-result.json
 *   reports/vpr-filter-combo-backtest-result.html
 *
 * 라우트: /vpr-filter-combo
 */

const fs = require('fs');
const path = require('path');
const vprAnalyzer = require('./vpr-analyzer');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INPUT_PATH = path.join(REPORTS_DIR, 'vpr-hgroup-three-year-with-flow-backtest-result.json');
const KOSPI_PATH = path.join(ROOT, 'cache', 'kospi-daily.json');
const KOSDAQ_PATH = path.join(ROOT, 'cache', 'kosdaq-daily.json');
const OUT_JSON = path.join(REPORTS_DIR, 'vpr-filter-combo-backtest-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'vpr-filter-combo-backtest-result.html');

const args = (() => {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
})();
const ENTRY_DAY = parseInt(args['entry-day'] || '5', 10);     // 5=D+5 (보드 발견 시점)
const ENTRY_PRICE_KIND = (args['entry-price'] || 'open').toLowerCase();

// ─── 시뮬레이션 시나리오 (사용자 spec: 분할청산 기본 + 5일/10일 보유) ───
const SCENARIOS = [
  { key: 'split10', label: '분할 청산 (10일 한도)', kind: 'split', holdDays: 10, sl: -5, tiers: [
    { pct: 6, weight: 0.5 }, { pct: 12, weight: 0.3 }, { pct: 16, weight: 0.2 },
  ] },
  { key: 'time5', label: '단순 보유 5일 (시간 종료)', kind: 'time', holdDays: 5 },
  { key: 'time10', label: '단순 보유 10일 (시간 종료)', kind: 'time', holdDays: 10 },
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
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`; }

// ─── 시뮬레이션 (분할 청산 + 단순 시간 보유) ───
function simulateSplit(rows, buyIdx, buyPrice, tiers, slPct, holdDays, entryKind = 'open') {
  let remaining = 1.0, realized = 0;
  let stopPrice = buyPrice * (1 + slPct / 100);
  let nextTier = 0;
  let mfe = 0, mae = 0;  // % from buyPrice

  if (entryKind === 'open' && rows[buyIdx]) {
    const r = rows[buyIdx];
    mfe = Math.max(mfe, (r.high / buyPrice - 1) * 100);
    mae = Math.min(mae, (r.low / buyPrice - 1) * 100);
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
    mfe = Math.max(mfe, (r.high / buyPrice - 1) * 100);
    mae = Math.min(mae, (r.low / buyPrice - 1) * 100);
    if (r.open <= stopPrice) {
      realized += remaining * (r.open / buyPrice - 1) * 100;
      remaining = 0; break;
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
      remaining = 0; break;
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
    }
  }
  // exitType 결정 (요약 분류용)
  let exitType = 'TIME';
  if (nextTier === tiers.length) exitType = 'TP';
  else if (remaining === 0 && nextTier === 0) exitType = 'SL';
  else if (remaining < 1 && remaining > 0) exitType = 'PARTIAL_TIME';
  return { returnPct: round(realized), exitType, mfe: round(mfe), mae: round(mae) };
}

function simulateTime(rows, buyIdx, buyPrice, holdDays, entryKind = 'open') {
  // 단순: N거래일 후 종가 청산. SL/TP 없음. MFE/MAE만 추적.
  let mfe = 0, mae = 0;
  if (entryKind === 'open' && rows[buyIdx]) {
    mfe = Math.max(mfe, (rows[buyIdx].high / buyPrice - 1) * 100);
    mae = Math.min(mae, (rows[buyIdx].low / buyPrice - 1) * 100);
  }
  for (let k = 1; k <= holdDays; k++) {
    const idx = buyIdx + k;
    if (idx >= rows.length) break;
    const r = rows[idx];
    mfe = Math.max(mfe, (r.high / buyPrice - 1) * 100);
    mae = Math.min(mae, (r.low / buyPrice - 1) * 100);
  }
  const exitIdx = buyIdx + holdDays;
  if (exitIdx >= rows.length) {
    const lastIdx = rows.length - 1;
    if (lastIdx <= buyIdx) return null;
    return { returnPct: round((rows[lastIdx].close / buyPrice - 1) * 100), exitType: 'TIME', mfe: round(mfe), mae: round(mae) };
  }
  return { returnPct: round((rows[exitIdx].close / buyPrice - 1) * 100), exitType: 'TIME', mfe: round(mfe), mae: round(mae) };
}

// ─── 시장 레짐: 인덱스 + MA 계산 ───
function buildIndexLookup(rows) {
  const dateMap = new Map();
  const closes = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    closes.push(r.close);
    const ma60 = i >= 59 ? closes.slice(i - 59, i + 1).reduce((s, v) => s + v, 0) / 60 : null;
    const ma200 = i >= 199 ? closes.slice(i - 199, i + 1).reduce((s, v) => s + v, 0) / 200 : null;
    dateMap.set(r.date, { close: r.close, ma60, ma200 });
  }
  return dateMap;
}
function loadIndex(p) {
  if (!fs.existsSync(p)) return new Map();
  const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const rows = (j.rows || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  return buildIndexLookup(rows);
}

// ─── 통계 요약 ───
function summarize(label, results, baseN = null, baseWinRate = null, baseExpectancy = null) {
  if (results.length === 0) return { label, n: 0 };
  const valid = results.filter(r => r != null && Number.isFinite(r.returnPct));
  if (valid.length === 0) return { label, n: 0 };
  const returns = valid.map(r => r.returnPct);
  const wins = valid.filter(r => r.returnPct > 0);
  const losses = valid.filter(r => r.returnPct <= 0);
  const tpExits = valid.filter(r => r.exitType === 'TP');
  const slExits = valid.filter(r => r.exitType === 'SL');
  const timeExits = valid.filter(r => r.exitType === 'TIME' || r.exitType === 'PARTIAL_TIME');
  const winRate = wins.length / valid.length * 100;
  const avgWin = mean(wins.map(r => r.returnPct));
  const avgLoss = mean(losses.map(r => r.returnPct));
  const expectancy = winRate / 100 * (avgWin || 0) + (1 - winRate / 100) * (avgLoss || 0);
  const mfes = valid.map(r => r.mfe).filter(v => v != null);
  const maes = valid.map(r => r.mae).filter(v => v != null);
  return {
    label,
    n: valid.length,
    winRate: round(winRate),
    avgReturn: round(mean(returns)),
    medianReturn: round(median(returns)),
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    expectancy: round(expectancy),
    tpRate: rate(tpExits.length, valid.length),
    slRate: rate(slExits.length, valid.length),
    timeRate: rate(timeExits.length, valid.length),
    avgMFE: round(mean(mfes)),
    avgMAE: round(mean(maes)),
    worstMAE: round(Math.min(...maes.filter(v => v != null))),
    removed: baseN != null ? baseN - valid.length : null,
    deltaWinRate: baseWinRate != null && winRate != null ? round(winRate - baseWinRate) : null,
    deltaExpectancy: baseExpectancy != null && expectancy != null ? round(expectancy - baseExpectancy) : null,
  };
}

// ─── 메인 ───
function main() {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error('[ERROR] 입력 없음:', INPUT_PATH);
    process.exit(1);
  }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log(`\n📊 VPR 필터 조합 검증 — 진입가 거리 + 시장 레짐`);
  console.log(`  매수 시점: D+${ENTRY_DAY} ${ENTRY_PRICE_KIND === 'open' ? '시가' : '종가'}`);

  const inputData = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const events = inputData.events || [];
  console.log(`  입력 이벤트: ${events.length}건`);

  const kospiMap = loadIndex(KOSPI_PATH);
  const kosdaqMap = loadIndex(KOSDAQ_PATH);
  console.log(`  KOSPI 일봉: ${kospiMap.size}건, KOSDAQ 일봉: ${kosdaqMap.size}건`);

  // ─── 각 이벤트별 데이터 준비 ───
  const trades = [];
  let skipNoChart = 0, skipNoEntry = 0, skipNoData = 0, skipNoVpr = 0;

  for (const e of events) {
    const chartPath = path.join(CHART_DIR, `${e.code}.json`);
    if (!fs.existsSync(chartPath)) { skipNoChart++; continue; }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8')); }
    catch (_) { skipNoChart++; continue; }
    const rows = chart.rows || [];
    const hIdx = rows.findIndex(r => r.date === e.hDate);
    const vviIdx = rows.findIndex(r => r.date === e.vviDate);
    if (hIdx < 0 || vviIdx < 0) { skipNoEntry++; continue; }
    const buyIdx = hIdx + ENTRY_DAY;
    if (buyIdx >= rows.length) { skipNoEntry++; continue; }
    const buyPrice = ENTRY_PRICE_KIND === 'open' ? rows[buyIdx].open : rows[buyIdx].close;
    if (!buyPrice || buyPrice <= 0) { skipNoEntry++; continue; }
    if (buyIdx + 3 >= rows.length) { skipNoData++; continue; }

    const vpr = vprAnalyzer.analyzeBreakoutReaction({ vviIdx, breakoutIdx: hIdx }, rows);
    if (!vpr || !vpr.vprMain || !vpr.vprBaseClose) { skipNoVpr++; continue; }

    const buyDate = rows[buyIdx].date;
    const entryDistancePct = (buyPrice / vpr.vprBaseClose - 1) * 100;

    // 시장 레짐 (매수일 기준)
    const kospi = kospiMap.get(buyDate) || null;
    const kosdaq = kosdaqMap.get(buyDate) || null;
    const regime = {
      kospiAbove200: kospi && kospi.ma200 != null ? kospi.close > kospi.ma200 : null,
      kosdaqAbove200: kosdaq && kosdaq.ma200 != null ? kosdaq.close > kosdaq.ma200 : null,
      kospiAbove60: kospi && kospi.ma60 != null ? kospi.close > kospi.ma60 : null,
      kosdaqAbove60: kosdaq && kosdaq.ma60 != null ? kosdaq.close > kosdaq.ma60 : null,
    };

    // 시뮬레이션 결과 (시나리오별)
    const simResults = {};
    for (const sc of SCENARIOS) {
      let r = null;
      if (sc.kind === 'split') {
        r = simulateSplit(rows, buyIdx, buyPrice, sc.tiers, sc.sl, sc.holdDays, ENTRY_PRICE_KIND);
      } else if (sc.kind === 'time') {
        r = simulateTime(rows, buyIdx, buyPrice, sc.holdDays, ENTRY_PRICE_KIND);
      }
      simResults[sc.key] = r;
    }

    trades.push({
      code: e.code, name: e.name, market: e.market,
      hDate: e.hDate, buyDate, buyPrice,
      vprMain: vpr.vprMain, vprMainLabel: vpr.vprMainLabel,
      vprTags: vpr.vprTags, vprBaseClose: vpr.vprBaseClose, vprBreakoutLine: vpr.vprBreakoutLine,
      entryDistancePct: round(entryDistancePct),
      d5Judgment: e.d5Snapshot?.judgmentStatus,
      regime,
      sim: simResults,
    });
  }
  console.log(`  실효 trade: ${trades.length}건 (skip: chart ${skipNoChart}, entry ${skipNoEntry}, data ${skipNoData}, vpr ${skipNoVpr})`);

  // ─── 베이스 필터 12종 (사용자 spec) ───
  const BASE_FILTERS = [
    { key: 'ALL', label: 'H그룹 전체', match: () => true },
    { key: 'M_HIGH', label: 'VPR: 고가권 유지', match: t => t.vprMain === 'HIGH_ZONE_HOLD' },
    { key: 'M_ABOVE_LINE', label: 'VPR: 기준선 위 마감', match: t => t.vprMain === 'ABOVE_BREAKOUT_LINE' },
    { key: 'M_ABOVE_BASE', label: 'VPR: 기준 종가 위 유지', match: t => t.vprMain === 'ABOVE_BASE_CLOSE' },
    { key: 'M_PUSHBACK', label: 'VPR: 장중 돌파 후 밀림', match: t => t.vprMain === 'INTRADAY_PUSHBACK' },
    { key: 'M_OVER', label: 'VPR: 과열 돌파', match: t => t.vprMain === 'OVERHEATED_BREAKOUT' },
    { key: 'A_WICK_SMALL', label: '보조: 위꼬리 적음', match: t => (t.vprTags || []).includes('UPPER_WICK_SMALL') },
    { key: 'A_VOL_SUP', label: '보조: 거래대금 동반', match: t => (t.vprTags || []).includes('VOLUME_SUPPORT') },
    { key: 'A_LOWER_REC', label: '보조: 아래꼬리 회복', match: t => (t.vprTags || []).includes('LOWER_WICK_RECOVER') },
    { key: 'C_HIGH_WICK', label: '조합: 고가권 + 위꼬리 적음', match: t => t.vprMain === 'HIGH_ZONE_HOLD' && (t.vprTags || []).includes('UPPER_WICK_SMALL') },
    { key: 'C_HIGH_WICK_VOL', label: '조합: 고가권 + 위꼬리 적음 + 거래대금 동반', match: t => t.vprMain === 'HIGH_ZONE_HOLD' && (t.vprTags || []).includes('UPPER_WICK_SMALL') && ((t.vprTags || []).includes('VOLUME_SUPPORT') || (t.vprTags || []).includes('VOLUME_EXPLOSION')) },
    { key: 'C_HIGH_WICK_NOGAP', label: '조합: 고가권 + 위꼬리 적음 + 갭상승 출발 제외', match: t => t.vprMain === 'HIGH_ZONE_HOLD' && (t.vprTags || []).includes('UPPER_WICK_SMALL') && !(t.vprTags || []).includes('GAP_UP_START') },
  ];

  // ─── 진입가 거리 컷 6종 ───
  const DISTANCE_CUTS = [
    { key: 'NONE', label: '거리 필터 없음', maxDist: Infinity },
    { key: 'D15', label: '거리 ≤ 15%', maxDist: 15 },
    { key: 'D12', label: '거리 ≤ 12%', maxDist: 12 },
    { key: 'D10', label: '거리 ≤ 10%', maxDist: 10 },
    { key: 'D8', label: '거리 ≤ 8%', maxDist: 8 },
    { key: 'D5', label: '거리 ≤ 5%', maxDist: 5 },
  ];

  // ─── 시장 레짐 7종 ───
  const REGIME_FILTERS = [
    { key: 'NONE', label: '레짐 필터 없음', match: () => true },
    { key: 'KP200', label: 'KOSPI > 200일선', match: t => t.regime.kospiAbove200 === true },
    { key: 'KQ200', label: 'KOSDAQ > 200일선', match: t => t.regime.kosdaqAbove200 === true },
    { key: 'KP60', label: 'KOSPI > 60일선', match: t => t.regime.kospiAbove60 === true },
    { key: 'KQ60', label: 'KOSDAQ > 60일선', match: t => t.regime.kosdaqAbove60 === true },
    { key: 'BOTH200', label: 'KOSPI/KOSDAQ 모두 > 200일선', match: t => t.regime.kospiAbove200 === true && t.regime.kosdaqAbove200 === true },
    { key: 'EITHER60', label: 'KOSPI 또는 KOSDAQ > 60일선', match: t => t.regime.kospiAbove60 === true || t.regime.kosdaqAbove60 === true },
  ];

  // ─── 결과 계산 (베이스 × 거리 × 레짐 × 시나리오) ───
  // 베이스 = ALL 일 때 거리/레짐 필터별 표 → 거리 필터 단독 표, 레짐 단독 표
  // 베이스 != ALL × (거리, 레짐) → 조합 표
  const cells = [];  // 모든 결과 셀
  function evalCell(scKey, baseFilter, distCut, regimeFilter) {
    const filtered = trades.filter(t =>
      baseFilter.match(t) &&
      Math.abs(t.entryDistancePct) !== Infinity && t.entryDistancePct <= distCut.maxDist &&
      regimeFilter.match(t)
    );
    const results = filtered.map(t => t.sim[scKey]).filter(r => r != null);
    return summarize('', results);
  }
  // 베이스라인 (ALL, NONE, NONE) for delta computation
  const baseline = {};
  for (const sc of SCENARIOS) {
    const baseSummary = evalCell(sc.key, BASE_FILTERS[0], DISTANCE_CUTS[0], REGIME_FILTERS[0]);
    baseline[sc.key] = baseSummary;
  }

  function withDelta(s, scKey) {
    const b = baseline[scKey];
    if (!s || s.n === 0) return s;
    return {
      ...s,
      removed: b.n - s.n,
      deltaWinRate: b.winRate != null && s.winRate != null ? round(s.winRate - b.winRate) : null,
      deltaExpectancy: b.expectancy != null && s.expectancy != null ? round(s.expectancy - b.expectancy) : null,
    };
  }

  // 결과 매트릭스 빌드
  const allCells = [];
  for (const sc of SCENARIOS) {
    for (const bf of BASE_FILTERS) {
      for (const dc of DISTANCE_CUTS) {
        for (const rf of REGIME_FILTERS) {
          const s = evalCell(sc.key, bf, dc, rf);
          allCells.push({
            scenarioKey: sc.key, scenarioLabel: sc.label,
            baseKey: bf.key, baseLabel: bf.label,
            distKey: dc.key, distLabel: dc.label, distMax: dc.maxDist,
            regimeKey: rf.key, regimeLabel: rf.label,
            ...withDelta(s, sc.key),
          });
        }
      }
    }
  }

  // ─── 추천 운영안 (시장 레짐 필터 제외 — 검증 결과 효과 없음) ───
  // 사용자 spec(2026-05-06): 시장 점수 필터는 후보 제거에 사용하지 않음. 거리 + VPR 조합 중심.
  const PRESETS = [
    { key: 'AGGR', label: '공격형', distMax: 12, regimeKey: 'NONE' },
    { key: 'BAL', label: '균형형', distMax: 10, regimeKey: 'NONE' },
    { key: 'CONS', label: '보수형', distMax: 8, regimeKey: 'NONE' },
  ];
  const presetResults = {};
  for (const sc of SCENARIOS) {
    presetResults[sc.key] = {};
    for (const ps of PRESETS) {
      const dc = DISTANCE_CUTS.find(x => x.maxDist === ps.distMax);
      const rf = REGIME_FILTERS.find(x => x.key === ps.regimeKey);
      const map = {};
      for (const bf of BASE_FILTERS) {
        const s = evalCell(sc.key, bf, dc, rf);
        map[bf.key] = withDelta(s, sc.key);
      }
      presetResults[sc.key][ps.key] = { preset: ps, distLabel: dc.label, regimeLabel: rf.label, byBase: map };
    }
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'VPR 필터 조합 검증 — 진입가 거리 + 시장 레짐',
      purpose: '승률을 인위적으로 높이는 게 아니라, 매수 시점 알 수 있는 정보(현재가-기준가 거리, 시장 200/60일선)로 표본을 정예화했을 때 승률·매번 평균이 어떻게 변하는지 검증.',
      noFutureInfo: '필터는 모두 매수 시점(D+5)에 알 수 있는 정보만 사용. 사후 분류 없음.',
      buySource: `D+${ENTRY_DAY} ${ENTRY_PRICE_KIND === 'open' ? '시가' : '종가'}`,
    },
    config: {
      entryDay: ENTRY_DAY, entryPriceKind: ENTRY_PRICE_KIND,
      scenarios: SCENARIOS.map(s => ({ key: s.key, label: s.label, holdDays: s.holdDays, kind: s.kind })),
      baseFilters: BASE_FILTERS.map(f => ({ key: f.key, label: f.label })),
      distanceCuts: DISTANCE_CUTS.map(d => ({ key: d.key, label: d.label, maxDist: d.maxDist === Infinity ? null : d.maxDist })),
      regimeFilters: REGIME_FILTERS.map(r => ({ key: r.key, label: r.label })),
      presets: PRESETS,
    },
    counts: {
      totalEvents: events.length,
      effectiveTrades: trades.length,
      skipNoChart, skipNoEntry, skipNoData, skipNoVpr,
    },
    baseline,
    cells: allCells,
    presetResults,
    distanceDistribution: (() => {
      const buckets = { '≤5': 0, '5~8': 0, '8~10': 0, '10~12': 0, '12~15': 0, '>15': 0, '<0': 0 };
      for (const t of trades) {
        const d = t.entryDistancePct;
        if (d < 0) buckets['<0']++;
        else if (d <= 5) buckets['≤5']++;
        else if (d <= 8) buckets['5~8']++;
        else if (d <= 10) buckets['8~10']++;
        else if (d <= 12) buckets['10~12']++;
        else if (d <= 15) buckets['12~15']++;
        else buckets['>15']++;
      }
      return buckets;
    })(),
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // ─── 콘솔 요약 ───
  console.log(`\n📊 진입가 거리 분포:`);
  for (const [k, v] of Object.entries(out.distanceDistribution)) {
    console.log(`  ${k.padStart(6)}: ${v} (${rate(v, trades.length)}%)`);
  }

  console.log(`\n📊 베이스라인 (H그룹 전체, 필터 없음):`);
  for (const sc of SCENARIOS) {
    const b = baseline[sc.key];
    console.log(`  [${sc.label}] n=${b.n}, 승률 ${b.winRate}%, 매번 ${b.expectancy}%`);
  }

  console.log(`\n📊 H그룹 전체 (ALL) × 거리 필터 단독 (분할청산 기준):`);
  console.log(`  거리 컷       n   승률    매번 평균  익절률  손절률  시간종료  제거수   ΔWR     ΔE`);
  for (const dc of DISTANCE_CUTS) {
    const cell = allCells.find(c => c.scenarioKey === 'split10' && c.baseKey === 'ALL' && c.distKey === dc.key && c.regimeKey === 'NONE');
    if (!cell || !cell.n) continue;
    const ok = (cell.deltaWinRate >= 0 && cell.deltaExpectancy >= 0) ? '🟢' : (cell.deltaExpectancy < -0.2 ? '🔴' : '⚪');
    console.log(`  ${ok} ${cell.distLabel.padEnd(14)} ${String(cell.n).padStart(4)}  ${String(cell.winRate).padStart(6)}%  ${String(cell.expectancy).padStart(7)}%  ${String(cell.tpRate).padStart(5)}%  ${String(cell.slRate).padStart(5)}%  ${String(cell.timeRate).padStart(7)}%  ${String(cell.removed).padStart(5)}  ${String(cell.deltaWinRate ?? '-').padStart(5)}  ${String(cell.deltaExpectancy ?? '-').padStart(5)}`);
  }

  console.log(`\n📊 H그룹 전체 (ALL) × 시장 레짐 단독 (분할청산 기준):`);
  console.log(`  레짐 필터                    n   승률    매번 평균  제거수   ΔWR     ΔE`);
  for (const rf of REGIME_FILTERS) {
    const cell = allCells.find(c => c.scenarioKey === 'split10' && c.baseKey === 'ALL' && c.distKey === 'NONE' && c.regimeKey === rf.key);
    if (!cell || !cell.n) continue;
    const ok = (cell.deltaWinRate >= 0 && cell.deltaExpectancy >= 0) ? '🟢' : (cell.deltaExpectancy < -0.2 ? '🔴' : '⚪');
    console.log(`  ${ok} ${rf.label.padEnd(28)} ${String(cell.n).padStart(4)}  ${String(cell.winRate).padStart(6)}%  ${String(cell.expectancy).padStart(7)}%  ${String(cell.removed).padStart(5)}  ${String(cell.deltaWinRate ?? '-').padStart(5)}  ${String(cell.deltaExpectancy ?? '-').padStart(5)}`);
  }

  console.log(`\n📊 추천 운영안 (분할청산 기준, baseFilter='ALL'):`);
  for (const ps of PRESETS) {
    const r = presetResults['split10'][ps.key];
    const cell = r.byBase['ALL'];
    if (!cell || !cell.n) continue;
    console.log(`  [${ps.label}] ${r.distLabel} + ${r.regimeLabel}`);
    console.log(`    n=${cell.n}, 승률 ${cell.winRate}%, 매번 ${cell.expectancy}%, ΔWR ${cell.deltaWinRate}, ΔE ${cell.deltaExpectancy}`);
  }

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

// ─── HTML ───
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>VPR 필터 조합 검증</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px; -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 16px 0 8px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

.preset-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 14px; }
.preset-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 14px 16px; }
.preset-card h3 { margin-top: 0; }
.preset-card .head { display: flex; justify-content: space-between; align-items: baseline; }
.preset-card .nums { font-size: 12px; color: #cbd5e1; line-height: 1.7; }
.preset-card .num-big { font-size: 22px; font-weight: 700; }
.preset-card.aggr h3 { color: #fdba74; }
.preset-card.bal h3 { color: #6ee7b7; }
.preset-card.cons h3 { color: #93c5fd; }

.scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; margin-bottom: 14px; border-radius: 8px; }
.scroll-x table.cmp { margin-bottom: 0; }
table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 10px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; white-space: nowrap; }
table.cmp thead th:first-child { text-align: left; }
table.cmp tbody td { padding: 7px 10px; border-bottom: 1px solid #334155; text-align: right; font-variant-numeric: tabular-nums; }
table.cmp tbody td:first-child { text-align: left; color: #cbd5e1; font-weight: 600; }
table.cmp tbody tr:hover td { background: #273549; }
.row-good td { background: rgba(13, 148, 136, 0.15) !important; }
.row-bad td { background: rgba(239, 68, 68, 0.10) !important; }
.row-base td { background: rgba(99, 102, 241, 0.12) !important; font-weight: 600; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-neutral { color: #94a3b8; }
.tag-low-n { color: #fbbf24; font-size: 10px; }

.tabs { display: flex; gap: 6px; margin: 18px 0 8px; flex-wrap: wrap; }
.tab-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 7px; padding: 7px 14px; font-size: 12px; cursor: pointer; }
.tab-btn:hover { color: #f1f5f9; border-color: #64748b; }
.tab-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }

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

<h1>VPR 필터 조합 검증 — 진입가 거리 + 시장 레짐</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  H그룹/VPR 조건에 <strong>진입가 거리 필터</strong>(매수 시점 가격이 기준 종가에서 얼마나 떨어졌는가)와 <strong>시장 레짐 필터</strong>(KOSPI/KOSDAQ 대비 200/60일선)를 더했을 때
  승률·매번 평균·표본 수가 어떻게 변하는지 검증합니다. 모든 필터는 <strong>매수 시점에 알 수 있는 정보만</strong> 사용합니다 (사후 분류 없음).
</div>

<div class="warn-banner">
  ⚠️ <strong>승률만 높이는 것이 좋은 게 아닙니다.</strong> n이 작아 통계적 유의성이 떨어지는 케이스나, 매번 평균이 떨어지는 케이스는 추천에서 제외합니다.
  n=30 미만은 참고용. n≥50이고 승률·매번 평균이 동시에 개선되는 조건을 우선 추천합니다.
</div>

<h2>🎯 추천 운영안 (분할청산 기준)</h2>
<p class="subtitle">사용자 spec에 따른 3가지 운영 강도. 베이스 필터 = H그룹 전체.</p>
<div class="preset-grid" id="preset-grid"></div>

<h2>🏆 요약 결론</h2>
<h3>균형 좋은 조건 TOP 5 (n≥50, 승률+매번 평균 개선폭 합계 기준)</h3>
<div id="balanced-top5"></div>
<h3>승률 최고 조건 TOP 5 (n≥30)</h3>
<div id="winrate-top5"></div>
<h3>매번 평균 최고 조건 TOP 5 (n≥30)</h3>
<div id="expectancy-top5"></div>
<h3>표본 수 50 이상 조건 (매번 평균 기준 정렬)</h3>
<div id="sample50-top5"></div>

<h2>📊 진입가 거리 필터별 성과 (베이스 = H그룹 전체)</h2>
<p class="subtitle">거리 필터만 적용. 시장 레짐 필터는 없음.</p>
<div class="tabs" id="dist-tabs"></div>
<div id="dist-table"></div>

<h2>📊 시장 레짐 필터별 성과 (베이스 = H그룹 전체)</h2>
<p class="subtitle">레짐 필터만 적용. 거리 필터는 없음.</p>
<div class="tabs" id="regime-tabs"></div>
<div id="regime-table"></div>

<h2>📊 거리 + 레짐 조합 매트릭스 (분할청산 기준)</h2>
<p class="subtitle">베이스 = H그룹 전체. 행 = 거리, 열 = 레짐. 셀 = 매번 평균%(n).</p>
<div id="combo-table"></div>

<h2>📊 VPR 메인 태그별 성과 변화</h2>
<p class="subtitle">분할청산 기준. 거리 ≤ 10% + KOSDAQ 60일선 위 적용 시 변화.</p>
<div id="vpr-main-table"></div>

<h2>📊 VPR 보조 태그 + 조합 필터별 성과 변화</h2>
<p class="subtitle">분할청산 기준. 거리 ≤ 10% + KOSDAQ 60일선 위 적용 시 변화.</p>
<div id="vpr-aux-table"></div>

<h2>📈 진입가 거리 분포</h2>
<div id="dist-dist"></div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;
const cfg = DATA.config;

function fmtPct(v) {
  if (v == null || !isFinite(v)) return '<span class="cell-neutral">-</span>';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%</span>';
}
function fmtRate(v, lowThresh, highThresh) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const lo = lowThresh != null ? lowThresh : 35;
  const hi = highThresh != null ? highThresh : 50;
  const cls = v >= hi ? 'cell-pos' : (v < lo ? 'cell-neg' : 'cell-neutral');
  return '<span class="' + cls + '">' + Number(v).toFixed(1) + '%</span>';
}
function fmtDelta(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral');
  const arrow = v > 0 ? '▲' : (v < 0 ? '▼' : '─');
  return '<span class="' + cls + '">' + arrow + Math.abs(v).toFixed(2) + '</span>';
}
function fmtN(n) {
  if (n == null) return '-';
  if (n < 30) return '<span class="tag-low-n">' + n + ' ⚠</span>';
  return n;
}

document.getElementById('subtitle').textContent =
  '입력 ' + DATA.counts.totalEvents + '건 → 실효 매매 ' + DATA.counts.effectiveTrades + '건 · ' +
  '매수: ' + DATA.meta.buySource + ' · ' +
  '생성: ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

// 추천 운영안 카드
function renderPresets() {
  const html = [];
  const presetClsMap = { AGGR: 'aggr', BAL: 'bal', CONS: 'cons' };
  for (const ps of cfg.presets) {
    const r = DATA.presetResults['split10'][ps.key];
    const all = r.byBase['ALL'];
    const cls = presetClsMap[ps.key];
    const goodSig = all && all.deltaExpectancy != null && all.deltaExpectancy > 0;
    html.push('<div class="preset-card ' + cls + '">' +
      '<div class="head"><h3>' + ps.label + '</h3>' +
      '<span style="color:#94a3b8;font-size:11px;">' + (goodSig ? '🟢 추천' : '⚪ 검토') + '</span></div>' +
      '<div class="nums">필터: <strong>' + r.distLabel + '</strong> + <strong>' + r.regimeLabel + '</strong></div>' +
      '<div class="nums">표본: <strong>' + (all.n || 0) + '건</strong>' +
      ' (제거 ' + (all.removed || 0) + '건)</div>' +
      '<div class="nums">승률 <span class="num-big">' + (all.winRate != null ? all.winRate + '%' : '-') + '</span>' +
      ' (' + fmtDelta(all.deltaWinRate) + ')</div>' +
      '<div class="nums">매번 평균 <span class="num-big">' + fmtPct(all.expectancy) + '</span>' +
      ' (' + fmtDelta(all.deltaExpectancy) + ')</div>' +
      '</div>');
  }
  document.getElementById('preset-grid').innerHTML = html.join('');
}
renderPresets();

// 셀 정렬·필터 헬퍼
function findCell(scKey, baseKey, distKey, regimeKey) {
  return DATA.cells.find(c => c.scenarioKey === scKey && c.baseKey === baseKey && c.distKey === distKey && c.regimeKey === regimeKey);
}

// TOP 5 표
function renderTopTable(elId, title, items, baseRow) {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>조건</th><th>n</th><th>승률</th><th>매번 평균</th><th>중앙값</th>',
    '<th>평균 MFE</th><th>평균 MAE</th><th>최악 MAE</th>',
    '<th>익절률</th><th>손절률</th><th>시간종료</th>',
    '<th>제거수</th><th>ΔWR</th><th>ΔE</th>',
    '</tr></thead><tbody>'];
  if (baseRow) {
    html.push('<tr class="row-base"><td>' + baseRow.label + '</td>' +
      '<td>' + (baseRow.n || 0) + '</td>' +
      '<td>' + fmtRate(baseRow.winRate) + '</td>' +
      '<td>' + fmtPct(baseRow.expectancy) + '</td>' +
      '<td>' + fmtPct(baseRow.medianReturn) + '</td>' +
      '<td>' + fmtPct(baseRow.avgMFE) + '</td>' +
      '<td>' + fmtPct(baseRow.avgMAE) + '</td>' +
      '<td>' + fmtPct(baseRow.worstMAE) + '</td>' +
      '<td>' + (baseRow.tpRate != null ? baseRow.tpRate + '%' : '-') + '</td>' +
      '<td>' + (baseRow.slRate != null ? baseRow.slRate + '%' : '-') + '</td>' +
      '<td>' + (baseRow.timeRate != null ? baseRow.timeRate + '%' : '-') + '</td>' +
      '<td>0</td><td>-</td><td>-</td></tr>');
  }
  for (const item of items) {
    const cls = (item.deltaWinRate >= 0 && item.deltaExpectancy >= 0) ? ' class="row-good"' :
                ((item.deltaExpectancy != null && item.deltaExpectancy < -0.3) ? ' class="row-bad"' : '');
    const lbl = item.baseLabel + ' / ' + item.distLabel + ' / ' + item.regimeLabel;
    html.push('<tr' + cls + '><td>' + lbl + '</td>' +
      '<td>' + fmtN(item.n) + '</td>' +
      '<td>' + fmtRate(item.winRate) + '</td>' +
      '<td>' + fmtPct(item.expectancy) + '</td>' +
      '<td>' + fmtPct(item.medianReturn) + '</td>' +
      '<td>' + fmtPct(item.avgMFE) + '</td>' +
      '<td>' + fmtPct(item.avgMAE) + '</td>' +
      '<td>' + fmtPct(item.worstMAE) + '</td>' +
      '<td>' + (item.tpRate != null ? item.tpRate + '%' : '-') + '</td>' +
      '<td>' + (item.slRate != null ? item.slRate + '%' : '-') + '</td>' +
      '<td>' + (item.timeRate != null ? item.timeRate + '%' : '-') + '</td>' +
      '<td>' + (item.removed != null ? item.removed : '-') + '</td>' +
      '<td>' + fmtDelta(item.deltaWinRate) + '</td>' +
      '<td>' + fmtDelta(item.deltaExpectancy) + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById(elId).innerHTML = html.join('');
}

// TOP 5 데이터 추출 (split10 기준)
const split10Cells = DATA.cells.filter(c => c.scenarioKey === 'split10' && c.n >= 1);
const baseLine = DATA.baseline['split10'];
const baseRow = { ...baseLine, label: 'BASELINE: H그룹 전체 / 필터 없음' };

// 균형 = (deltaWinRate + deltaExpectancy×10) 합 (n>=50)
const balanced = split10Cells.filter(c => c.n >= 50 && c.baseKey === 'ALL').slice()
  .sort((a, b) => ((b.deltaWinRate || 0) + (b.deltaExpectancy || 0) * 10) - ((a.deltaWinRate || 0) + (a.deltaExpectancy || 0) * 10))
  .slice(0, 5);
renderTopTable('balanced-top5', 'BALANCED', balanced, baseRow);

const winRateTop = split10Cells.filter(c => c.n >= 30).slice()
  .sort((a, b) => (b.winRate || 0) - (a.winRate || 0))
  .slice(0, 5);
renderTopTable('winrate-top5', 'WINRATE', winRateTop, baseRow);

const expTop = split10Cells.filter(c => c.n >= 30).slice()
  .sort((a, b) => (b.expectancy || 0) - (a.expectancy || 0))
  .slice(0, 5);
renderTopTable('expectancy-top5', 'EXPECTANCY', expTop, baseRow);

const sample50 = split10Cells.filter(c => c.n >= 50).slice()
  .sort((a, b) => (b.expectancy || 0) - (a.expectancy || 0))
  .slice(0, 8);
renderTopTable('sample50-top5', 'SAMPLE50', sample50, baseRow);

// 거리 단독 표 (탭별 시나리오)
let curScDist = 'split10';
function renderScTabs(elId, onChange, getCur) {
  const html = cfg.scenarios.map(sc =>
    '<button class="tab-btn' + (sc.key === getCur() ? ' active' : '') + '" data-tab="' + sc.key + '">' + sc.label + '</button>'
  ).join('');
  document.getElementById(elId).innerHTML = html;
  document.querySelectorAll('#' + elId + ' .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      onChange(btn.getAttribute('data-tab'));
      document.querySelectorAll('#' + elId + ' .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

function renderDistTable() {
  const rows = cfg.distanceCuts.map(dc => findCell(curScDist, 'ALL', dc.key, 'NONE')).filter(Boolean);
  renderTopTable('dist-table', 'DIST', rows.slice(1), { ...rows[0], label: 'BASELINE: ' + rows[0].distLabel });
}
renderScTabs('dist-tabs', (v) => { curScDist = v; renderDistTable(); }, () => curScDist);
renderDistTable();

let curScReg = 'split10';
function renderRegimeTable() {
  const rows = cfg.regimeFilters.map(rf => findCell(curScReg, 'ALL', 'NONE', rf.key)).filter(Boolean);
  renderTopTable('regime-table', 'REGIME', rows.slice(1), { ...rows[0], label: 'BASELINE: ' + rows[0].regimeLabel });
}
renderScTabs('regime-tabs', (v) => { curScReg = v; renderRegimeTable(); }, () => curScReg);
renderRegimeTable();

// 거리 × 레짐 조합 매트릭스 (분할청산, ALL)
function renderComboMatrix() {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>거리 \\\\ 레짐</th>'];
  for (const rf of cfg.regimeFilters) html.push('<th>' + rf.label + '</th>');
  html.push('</tr></thead><tbody>');
  for (const dc of cfg.distanceCuts) {
    html.push('<tr><td>' + dc.label + '</td>');
    for (const rf of cfg.regimeFilters) {
      const c = findCell('split10', 'ALL', dc.key, rf.key);
      if (!c || !c.n) { html.push('<td>-</td>'); continue; }
      const exp = c.expectancy;
      const cls = c.deltaExpectancy > 0.2 ? 'cell-pos' : (c.deltaExpectancy < -0.2 ? 'cell-neg' : '');
      html.push('<td><span class="' + cls + '">' + (exp != null ? (exp > 0 ? '+' : '') + exp.toFixed(2) + '%' : '-') + '</span><br>' +
        '<span style="font-size:10px;color:#64748b;">n=' + c.n + ' · 승률 ' + (c.winRate != null ? c.winRate.toFixed(1) : '-') + '%</span></td>');
    }
    html.push('</tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById('combo-table').innerHTML = html.join('');
}
renderComboMatrix();

// VPR 메인 + 보조 표 (대표 프리셋: 거리 ≤ 10% + KOSDAQ 60일선)
function renderVprTable(elId, baseKeys) {
  const rows = baseKeys.map(bk => {
    const cellNoFilter = findCell('split10', bk, 'NONE', 'NONE');
    const cellWithFilter = findCell('split10', bk, 'D10', 'KQ60');
    return {
      baseLabel: cellNoFilter ? cellNoFilter.baseLabel : bk,
      noFilter: cellNoFilter,
      withFilter: cellWithFilter,
    };
  });
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>VPR 분류</th>',
    '<th>n (필터 없음)</th><th>승률</th><th>매번 평균</th>',
    '<th>n (D10 + KQ60)</th><th>승률</th><th>매번 평균</th>',
    '<th>제거수</th><th>ΔWR</th><th>ΔE</th>',
    '</tr></thead><tbody>'];
  for (const row of rows) {
    const a = row.noFilter; const b = row.withFilter;
    if (!a) continue;
    const dWR = b && a.winRate != null && b.winRate != null ? round(b.winRate - a.winRate) : null;
    const dE = b && a.expectancy != null && b.expectancy != null ? round(b.expectancy - a.expectancy) : null;
    const cls = (dWR > 0 && dE > 0) ? ' class="row-good"' : ((dE != null && dE < -0.3) ? ' class="row-bad"' : '');
    html.push('<tr' + cls + '><td>' + row.baseLabel + '</td>' +
      '<td>' + fmtN(a.n) + '</td>' +
      '<td>' + fmtRate(a.winRate) + '</td>' +
      '<td>' + fmtPct(a.expectancy) + '</td>' +
      '<td>' + (b ? fmtN(b.n) : '-') + '</td>' +
      '<td>' + (b ? fmtRate(b.winRate) : '-') + '</td>' +
      '<td>' + (b ? fmtPct(b.expectancy) : '-') + '</td>' +
      '<td>' + (b ? a.n - b.n : '-') + '</td>' +
      '<td>' + fmtDelta(dWR) + '</td>' +
      '<td>' + fmtDelta(dE) + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById(elId).innerHTML = html.join('');
}
function round(v, d = 2) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
renderVprTable('vpr-main-table', ['M_HIGH', 'M_ABOVE_LINE', 'M_ABOVE_BASE', 'M_PUSHBACK', 'M_OVER']);
renderVprTable('vpr-aux-table', ['A_WICK_SMALL', 'A_VOL_SUP', 'A_LOWER_REC', 'C_HIGH_WICK', 'C_HIGH_WICK_VOL', 'C_HIGH_WICK_NOGAP']);

// 거리 분포
function renderDistDistribution() {
  const total = DATA.counts.effectiveTrades;
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr><th>구간 (%)</th><th>건수</th><th>비율</th></tr></thead><tbody>'];
  for (const [k, v] of Object.entries(DATA.distanceDistribution)) {
    html.push('<tr><td>' + k + '</td><td>' + v + '</td><td>' + (total ? (v/total*100).toFixed(1) : 0) + '%</td></tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById('dist-dist').innerHTML = html.join('');
}
renderDistDistribution();

document.getElementById('data-limit').innerHTML =
  '<strong>데이터 한계 / 가정</strong><br>' +
  '• 매수: ' + DATA.meta.buySource + ' (체결 슬리피지 미반영)<br>' +
  '• 분할청산: 50% +6% / 30% +12% / 20% +16% / 손절 -5% / 본전 이동<br>' +
  '• 시장 레짐: KOSPI/KOSDAQ 200일선·60일선 (FinanceDataReader 기준 일봉)<br>' +
  '• 모든 필터는 매수 시점에 알 수 있는 정보만 사용 (look-ahead 없음)<br>' +
  '• <strong>매수 추천이 아닙니다.</strong> 통계 검증입니다.';
</script>

</body>
</html>
`;

main();
