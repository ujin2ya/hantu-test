#!/usr/bin/env node
/**
 * 1DS "관찰 제외 +8%" 감사용 백테스트
 *
 * 가설: 기존 1DS 09:30 scanner가 "관찰/제외 후보 (즉시 진입 X)" 섹션으로 분류한
 *       종목 중 당일 특정 시점 +8% 이상 오른 케이스가, 공격형/10시 생존 후보보다
 *       후속 상승률이 좋은가?
 *
 * 비교 그룹:
 *   A. 공격형 후보         = status=READY + finalScore Top N
 *   B. 10시 생존 후보       = status=READY + close(10:00) > close(09:30)
 *   C. 관찰 제외 후보 전체  = status ∈ {WAIT_PULLBACK, FADED, WEAK}
 *   D. 관찰 제외 + +8%      = C 안에서 +8% 조건 충족
 *
 * 기존 1DS 보드/로직/리포트는 절대 수정하지 않는 감사용 일회성 분석.
 *
 * 입력:
 *   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json (분봉)
 *   - cache/stock-charts-long/{code}.json         (일봉)
 *   - stocks.json / cache/naver-stocks-list.json   (meta)
 *
 * 출력:
 *   - reports/one-ds-excluded-plus8-backtest-result.json
 *   - reports/one-ds-excluded-plus8-backtest-result.html
 *
 * CLI:
 *   node scripts/one-ds-excluded-plus8-backtest.js
 *   node scripts/one-ds-excluded-plus8-backtest.js --window 60
 *   node scripts/one-ds-excluded-plus8-backtest.js --window 120
 *   node scripts/one-ds-excluded-plus8-backtest.js --limit-events 500
 *   node scripts/one-ds-excluded-plus8-backtest.js --no-html
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-ds-excluded-plus8-backtest-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-ds-excluded-plus8-backtest-result.html');

const scanner = require(path.join(ROOT, 'boards', 'oneDaySurge', 'one-day-surge-0930-scanner'));
const core    = require(path.join(ROOT, 'boards', 'oneDaySurge', 'one-day-surge-core'));

// ── 백테스트 상수 ──
const PLUS8_THRESHOLD       = 0.08;   // +8%
const UPPER_LIMIT_THRESHOLD = 0.298;  // 한국 가격 제한 +30% 근사 (실 측정은 종목별)
const ATTACK_TOP_N          = 5;      // status=READY 안에서 finalScore 상위 5 → "공격형" proxy
const FORWARD_WINDOW_DAYS   = 10;     // D+1..D+10 일봉 forward window
const STATUS_KO = {
  READY:             '강한 상태 유지',
  WAIT_PULLBACK:     '추격 부담 (+8% 이상)',
  FADED:             '고점 대비 밀림',
  WEAK:              '시가/거래대금 부족',
  INSUFFICIENT_BARS: '분봉 부족',
};

// ── CLI ──
function parseArgs(argv) {
  const a = { windows: [60, 120], limitEvents: 500, noHtml: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--window') {
      const v = parseInt(argv[++i], 10);
      a.windows = [v];
    } else if (k === '--limit-events') a.limitEvents = parseInt(argv[++i], 10) || 500;
    else if (k === '--no-html') a.noHtml = true;
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node scripts/one-ds-excluded-plus8-backtest.js [--window 60|120] [--limit-events N] [--no-html]');
      process.exit(0);
    }
  }
  return a;
}

// ── 분봉 디렉토리 enumerate ──
function listIntradayDates() {
  if (!fs.existsSync(INTRADAY_BASE)) return [];
  return fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();  // ascending
}

// ── 차트 캐시 (코드별 1회 로드) ──
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

// 분봉 디렉토리명(YYYY-MM-DD) → chart row idx (D 일자) + baseRow (D-1)
function findDayAndBase(rows, dateNumStr) {
  if (!Array.isArray(rows)) return null;
  const idx = rows.findIndex((r) => r.date === dateNumStr);
  if (idx < 22) return null;  // 충분한 과거(avg20 + base)
  return { dIdx: idx, dRow: rows[idx], baseRow: rows[idx - 1] };
}

// avg20 산출 (D-1 직전 20일)
function calcAvg20Value(rows, dIdx) {
  let sum = 0, n = 0;
  for (let i = dIdx - 21; i < dIdx - 1; i++) {
    const r = rows[i];
    if (r && r.volume > 0) { sum += (r.valueApprox || 0); n++; }
  }
  return n > 0 ? sum / n : 0;
}

// ── 시점별 스냅샷 추출 ──
function extractSnapshot(bars, cutoff) {
  const inWin = bars.filter((b) => b && b.time && b.time <= cutoff && b.close > 0);
  if (inWin.length === 0) return { available: false };
  const last = inWin[inWin.length - 1];
  let high = 0;
  for (const b of inWin) if (b.high > high) high = b.high;
  return {
    available: true,
    signalPrice: last.close,
    intradayHigh: high,
    barTime: last.time,
  };
}

// ── 신호 이후 당일 최고가 (분봉 기반 MFE1) ──
function maxHighAfter(bars, cutoff) {
  let h = 0;
  for (const b of bars) {
    if (!b || !b.time) continue;
    if (b.time <= cutoff) continue;
    if (b.high > h) h = b.high;
  }
  return h > 0 ? h : null;
}

// ── D-day 이후 forward returns (D+1..D+N 일봉) ──
function computeForwardReturns(rows, dIdx, signalPrice) {
  const result = { mfe3: null, mfe5: null, mfe10: null,
                   hit3: false, hit5: false, hit10: false,
                   fail3: false, fail5: false,
                   upperLimitHit: false,
                   nextDayGapPct: null, nextDayGapUp: false };
  if (signalPrice <= 0) return result;

  let runningMaxHigh = 0;
  let hitTimes = {};
  let failTimes = {};

  // 최대 D+10
  for (let off = 1; off <= FORWARD_WINDOW_DAYS; off++) {
    const r = rows[dIdx + off];
    if (!r || !(r.close > 0)) break;

    // 일봉 단위 hit/fail timing — 같은 봉 안에서 high가 low보다 먼저라고 낙관 가정
    const highRet = (r.high / signalPrice - 1) * 100;
    const lowRet  = (r.low  / signalPrice - 1) * 100;
    if (r.high > runningMaxHigh) runningMaxHigh = r.high;

    for (const thr of [3, 5, 10]) {
      if (!hitTimes[thr] && highRet >= thr) hitTimes[thr] = off;
    }
    for (const thr of [3, 5]) {
      if (!failTimes[thr] && lowRet <= -thr) failTimes[thr] = off;
    }

    // MFE
    const mfe = (runningMaxHigh / signalPrice - 1) * 100;
    if (off <= 3 && (result.mfe3 == null || mfe > result.mfe3)) result.mfe3 = mfe;
    if (off <= 5 && (result.mfe5 == null || mfe > result.mfe5)) result.mfe5 = mfe;
    if (off <= 10 && (result.mfe10 == null || mfe > result.mfe10)) result.mfe10 = mfe;

    // 상한가 근사: (high / prev_close) - 1 ≥ 0.298
    const prevR = rows[dIdx + off - 1];
    if (prevR && prevR.close > 0) {
      const dayChange = r.high / prevR.close - 1;
      if (dayChange >= UPPER_LIMIT_THRESHOLD) result.upperLimitHit = true;
    }
  }

  // hit/fail flags: hit/fail은 최종 발화 여부, fail3/5는 hit3보다 먼저 발화한 경우만 (timing-aware)
  result.hit3 = !!hitTimes[3];
  result.hit5 = !!hitTimes[5];
  result.hit10 = !!hitTimes[10];
  if (failTimes[3] && (!hitTimes[3] || failTimes[3] < hitTimes[3])) result.fail3 = true;
  if (failTimes[5] && (!hitTimes[3] || failTimes[5] < hitTimes[3])) result.fail5 = true;

  // 다음 거래일 시가 gap (D+1 open vs D close)
  const dRow = rows[dIdx];
  const nextR = rows[dIdx + 1];
  if (dRow && nextR && dRow.close > 0 && nextR.open > 0) {
    const gap = (nextR.open / dRow.close - 1) * 100;
    result.nextDayGapPct = gap;
    result.nextDayGapUp = nextR.open > dRow.close;
  }

  return result;
}

// ── 통계 ──
function avg(arr) { if (!arr.length) return null; return arr.reduce((s, v) => s + v, 0) / arr.length; }
function rate(num, den) { if (!den) return 0; return (num / den) * 100; }
function fmt(n, d=2) {
  if (n == null || !Number.isFinite(n)) return '–';
  return Number(n.toFixed(d));
}

function summarizeEvents(events, signalKey) {
  // signalKey: 'p0930' | 'p1000' | 'p1100' — perf cached per snapshot, signalPrice 다름
  const valid = events.filter((e) => e.perfs && e.perfs[signalKey]);
  const n = valid.length;
  if (n === 0) return { n: 0 };

  const mfe1s   = valid.map((e) => e.perfs[signalKey].mfe1).filter(Number.isFinite);
  const mfe3s   = valid.map((e) => e.perfs[signalKey].mfe3).filter(Number.isFinite);
  const mfe5s   = valid.map((e) => e.perfs[signalKey].mfe5).filter(Number.isFinite);
  const mfe10s  = valid.map((e) => e.perfs[signalKey].mfe10).filter(Number.isFinite);
  const hit3    = valid.filter((e) => e.perfs[signalKey].hit3).length;
  const hit5    = valid.filter((e) => e.perfs[signalKey].hit5).length;
  const hit10   = valid.filter((e) => e.perfs[signalKey].hit10).length;
  const fail3   = valid.filter((e) => e.perfs[signalKey].fail3).length;
  const fail5   = valid.filter((e) => e.perfs[signalKey].fail5).length;
  const ch      = valid.filter((e) => e.perfs[signalKey].closeHold).length;
  const gaps    = valid.map((e) => e.perfs[signalKey].nextDayGapPct).filter(Number.isFinite);
  const gapsUp  = valid.filter((e) => e.perfs[signalKey].nextDayGapUp).length;
  const ulHit   = valid.filter((e) => e.perfs[signalKey].upperLimitHit).length;

  return {
    n,
    avgMFE1:           fmt(avg(mfe1s)),
    avgMFE3:           fmt(avg(mfe3s)),
    avgMFE5:           fmt(avg(mfe5s)),
    avgMFE10:          fmt(avg(mfe10s)),
    hit3:              fmt(rate(hit3, n)),
    hit5:              fmt(rate(hit5, n)),
    hit10:             fmt(rate(hit10, n)),
    fail3:             fmt(rate(fail3, n)),
    fail5:             fmt(rate(fail5, n)),
    closeHold:         fmt(rate(ch, n)),
    nextDayGapAvg:     fmt(avg(gaps)),
    nextDayGapUpRate:  fmt(rate(gapsUp, n)),
    upperLimitHitRate: fmt(rate(ulHit, n)),
  };
}

// ── 자동 해석 텍스트 ──
function buildInterpretation(groupComp) {
  const A = groupComp.A_attack;
  const D = groupComp.D_excluded_plus8;
  if (!A || !D || A.n === 0 || D.n === 0) {
    return '표본 부족, 결론 유보 (A 또는 D 그룹의 n=0).';
  }
  const diffHit5  = D.hit5 - A.hit5;
  const diffHit10 = D.hit10 - A.hit10;
  const diffFail5 = D.fail5 - A.fail5;
  const small = D.n < 30 ? '표본 부족 (D n<30), 결론 유보. ' : '';

  let verdict;
  if (diffHit5 >= 5 && diffFail5 <= 3) {
    verdict = `관찰 제외 +8% 그룹이 공격형 후보보다 명확히 우수 (hit5 +${fmt(diffHit5,1)}p, fail5 차이 ${fmt(diffFail5,1)}p). **별도 보드 승격 검토 가치 있음.**`;
  } else if (diffHit5 >= 5 && diffFail5 > 3) {
    verdict = `hit5는 +${fmt(diffHit5,1)}p 우수하나 fail5도 +${fmt(diffFail5,1)}p 높아 실전 위험도 동반 상승. **별도 보드보다는 기존 보드에 "강한 관찰 제외" 태그 추가 권장.**`;
  } else if (diffHit5 >= 0) {
    verdict = `공격형 대비 우위가 작음 (hit5 +${fmt(diffHit5,1)}p, fail5 차이 ${fmt(diffFail5,1)}p). **승격/태그 모두 부족, 검증 추가 필요.**`;
  } else {
    verdict = `공격형 대비 열위 (hit5 ${fmt(diffHit5,1)}p, fail5 차이 ${fmt(diffFail5,1)}p). **가설 기각, 기존 정책 유지.**`;
  }
  return small + verdict;
}

// ── Best group (hit5 기준) ──
function pickBestGroup(groupComp) {
  let best = null;
  for (const [k, v] of Object.entries(groupComp)) {
    if (!v || v.n === 0) continue;
    if (!best || v.hit5 > best.hit5) best = { name: k, hit5: v.hit5, n: v.n };
  }
  return best;
}

// ── 한 날의 이벤트 추출 ──
function analyzeDay(dateDir, metaMap) {
  const dir = path.join(INTRADAY_BASE, dateDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return [];
  const dateNumStr = dateDir.replace(/-/g, '');

  const dayEvents = [];

  for (const fname of files) {
    const code = fname.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    if (!meta) continue;

    const rows = loadChartRows(code);
    if (!rows) continue;

    const dayInfo = findDayAndBase(rows, dateNumStr);
    if (!dayInfo) continue;
    const { dIdx, dRow, baseRow } = dayInfo;
    if (!baseRow || !(baseRow.close > 0)) continue;
    if (!dRow || !(dRow.close > 0)) continue;

    const avg20 = calcAvg20Value(rows, dIdx);
    const baseValue = baseRow.valueApprox || 0;
    const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) continue;

    let bars;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8'));
      bars = j.bars || [];
    } catch (_) { continue; }
    if (bars.length === 0) continue;

    const m = scanner.computeMetrics0930(bars, baseRow);
    if (!m) continue;
    const status = scanner.classifyStatus(m);
    if (status === 'INSUFFICIENT_BARS') continue;

    const finalScore = scanner.computeFinalScore(m);

    const snap0930 = extractSnapshot(bars, '09:30');
    const snap1000 = extractSnapshot(bars, '10:00');
    const snap1100 = extractSnapshot(bars, '11:00');

    if (!snap0930.available) continue;  // 09:30 없으면 평가 불가

    const prevClose = baseRow.close;
    const closePlus8 = (dRow.close / prevClose - 1) >= PLUS8_THRESHOLD;

    // +8% 판정 — 시점 × 기준
    const plus8 = {};
    for (const [tKey, snap] of [['0930', snap0930], ['1000', snap1000], ['1100', snap1100]]) {
      if (!snap.available) { plus8[tKey] = { signalPricePlus8: null, intradayHighPlus8: null }; continue; }
      plus8[tKey] = {
        signalPricePlus8:  (snap.signalPrice / prevClose - 1) >= PLUS8_THRESHOLD,
        intradayHighPlus8: (snap.intradayHigh / prevClose - 1) >= PLUS8_THRESHOLD,
      };
    }

    // signalPrice별 perf 계산 (3시점 + closePrice 기준)
    const perfs = {};
    for (const [pKey, snap] of [['p0930', snap0930], ['p1000', snap1000], ['p1100', snap1100]]) {
      if (!snap.available) continue;
      const fwd = computeForwardReturns(rows, dIdx, snap.signalPrice);
      const intradayMaxAfter = maxHighAfter(bars, snap.barTime);
      const mfe1 = intradayMaxAfter != null && snap.signalPrice > 0
        ? (intradayMaxAfter / snap.signalPrice - 1) * 100
        : null;
      const closeHold = dRow.close >= snap.signalPrice;
      perfs[pKey] = {
        ...fwd,
        mfe1,
        closeHold,
      };
    }

    // 그룹 분류 — A는 finalScore 상위 N (이 시점에는 dayEvents 모아진 후 finalScore rank 정렬 필요)
    const isC = (status === 'WAIT_PULLBACK' || status === 'FADED' || status === 'WEAK');
    const isReady = status === 'READY';
    const survived10 = isReady && snap1000.available && snap1000.signalPrice > snap0930.signalPrice;

    dayEvents.push({
      date: dateDir,
      code,
      name: meta.name || code,
      market: meta.market || '',
      marketCap: meta.marketCap || 0,
      status,
      finalScore,
      prevClose,
      snap0930,
      snap1000,
      snap1100,
      dRow,
      plus8,
      closePlus8,
      perfs,
      isC,
      isReady,
      survived10,
      // sub-breakdown 조건들 미리 계산
      valueRatioVsBase: baseValue > 0 ? (dRow.valueApprox || 0) / baseValue : 0,
      valueToMarketCapRatio: meta.marketCap > 0 ? (dRow.valueApprox || 0) / meta.marketCap : 0,
      closePosition: (dRow.high > dRow.low) ? (dRow.close - dRow.low) / (dRow.high - dRow.low) : 0.5,
      nextDayGapUpDayBasis: (rows[dIdx + 1] && rows[dIdx + 1].open > dRow.close),
    });
  }

  // 같은 날 안에서 status=READY인 종목들에 finalScore rank 매김
  const readyEvents = dayEvents.filter((e) => e.isReady).sort((a, b) => b.finalScore - a.finalScore);
  readyEvents.forEach((e, i) => { e.readyRank = i + 1; e.isA = (i + 1) <= ATTACK_TOP_N; });
  // B(survivor1000) 마킹
  for (const e of dayEvents) {
    if (!e.isReady) { e.isA = false; e.isB = false; continue; }
    e.isB = !!e.survived10;
  }

  return dayEvents;
}

// ── 메인 백테스트 ──
function runBacktest(allEvents, window, vmcTop25Threshold) {
  // window 거래일 cap — events는 date 오름차순 가정, 마지막 N일치만
  const allDates = [...new Set(allEvents.map((e) => e.date))].sort();
  const cap = allDates.slice(-window);
  const capSet = new Set(cap);
  const events = allEvents.filter((e) => capSet.has(e.date));
  const actualDays = cap.length;

  // 4 그룹 (canonical: 10:00 signal 기반 perf 사용)
  const groupComp = {
    A_attack:         summarizeEvents(events.filter((e) => e.isA), 'p1000'),
    B_survivor1000:   summarizeEvents(events.filter((e) => e.isB), 'p1000'),
    C_excludedAll:    summarizeEvents(events.filter((e) => e.isC), 'p1000'),
    D_excluded_plus8: summarizeEvents(events.filter((e) => e.isC && e.plus8['1000'].signalPricePlus8), 'p1000'),
  };

  // +8% 기준별 (Group D 안, 10:00 기준)
  const cEvents = events.filter((e) => e.isC);
  const plus8Crit = {
    signalPricePlus8:  summarizeEvents(cEvents.filter((e) => e.plus8['1000'].signalPricePlus8 === true), 'p1000'),
    intradayHighPlus8: summarizeEvents(cEvents.filter((e) => e.plus8['1000'].intradayHighPlus8 === true), 'p1000'),
    closePlus8:        summarizeEvents(cEvents.filter((e) => e.closePlus8 === true), 'p1000'),
  };

  // 시간대별 (Group D, signalPricePlus8 기준)
  const snapComp = {};
  for (const tKey of ['0930', '1000', '1100']) {
    const pKey = 'p' + tKey;
    const subset = cEvents.filter((e) => e.plus8[tKey].signalPricePlus8 === true);
    const noDataCnt = cEvents.filter((e) => e.plus8[tKey].signalPricePlus8 === null).length;
    snapComp[tKey] = {
      signalPricePlus8:  summarizeEvents(subset, pKey),
      intradayHighPlus8: summarizeEvents(cEvents.filter((e) => e.plus8[tKey].intradayHighPlus8 === true), pKey),
      noDataDays: noDataCnt,
    };
  }

  // Sub-breakdown (Group D, signalPricePlus8 at 10:00 기준)
  const dEvents = events.filter((e) => e.isC && e.plus8['1000'].signalPricePlus8);
  const sub = {
    '1_plus8_only':         summarizeEvents(dEvents, 'p1000'),
    '2_plus8_value3x':      summarizeEvents(dEvents.filter((e) => e.valueRatioVsBase >= 3), 'p1000'),
    '3_plus8_value5x':      summarizeEvents(dEvents.filter((e) => e.valueRatioVsBase >= 5), 'p1000'),
    '4_plus8_vmc_top25':    summarizeEvents(dEvents.filter((e) => e.valueToMarketCapRatio >= vmcTop25Threshold), 'p1000'),
    '5_plus8_closepos_70':  summarizeEvents(dEvents.filter((e) => e.closePosition >= 0.70), 'p1000'),
    '6_plus8_closepos_80':  summarizeEvents(dEvents.filter((e) => e.closePosition >= 0.80), 'p1000'),
    '7_plus8_nextopen_up':  summarizeEvents(dEvents.filter((e) => e.nextDayGapUpDayBasis), 'p1000'),
  };

  // Summary
  const best = pickBestGroup(groupComp);
  const A = groupComp.A_attack;
  const D = groupComp.D_excluded_plus8;
  const summary = {
    bestGroup: best ? `${best.name} (hit5 ${best.hit5}%, n=${best.n})` : '–',
    groupA_hit5:  A.hit5  != null ? A.hit5  : 0,
    groupD_hit5:  D.hit5  != null ? D.hit5  : 0,
    diffHit5:     A.hit5  != null && D.hit5  != null ? fmt(D.hit5  - A.hit5,  1) : 0,
    groupA_hit10: A.hit10 != null ? A.hit10 : 0,
    groupD_hit10: D.hit10 != null ? D.hit10 : 0,
    diffHit10:    A.hit10 != null && D.hit10 != null ? fmt(D.hit10 - A.hit10, 1) : 0,
    groupA_fail5: A.fail5 != null ? A.fail5 : 0,
    groupD_fail5: D.fail5 != null ? D.fail5 : 0,
    diffFail5:    A.fail5 != null && D.fail5 != null ? fmt(D.fail5 - A.fail5, 1) : 0,
    interpretation: buildInterpretation(groupComp),
  };

  return { actualDays, summary, groupComp, plus8Crit, snapComp, sub, dEvents };
}

// ── HTML ──
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderMetricsRow(label, m) {
  if (!m || m.n === 0) {
    return `<tr><td><strong>${escapeHtml(label)}</strong></td><td colspan="14" style="color:#94a3b8;">n=0</td></tr>`;
  }
  return `<tr>
    <td><strong>${escapeHtml(label)}</strong></td>
    <td>${m.n}</td>
    <td>${m.avgMFE1 ?? '–'}</td>
    <td>${m.avgMFE3 ?? '–'}</td>
    <td>${m.avgMFE5 ?? '–'}</td>
    <td>${m.avgMFE10 ?? '–'}</td>
    <td>${m.hit3 ?? '–'}</td>
    <td>${m.hit5 ?? '–'}</td>
    <td>${m.hit10 ?? '–'}</td>
    <td style="color:#f87171;">${m.fail3 ?? '–'}</td>
    <td style="color:#f87171;">${m.fail5 ?? '–'}</td>
    <td>${m.closeHold ?? '–'}</td>
    <td>${m.nextDayGapAvg ?? '–'}</td>
    <td>${m.nextDayGapUpRate ?? '–'}</td>
    <td>${m.upperLimitHitRate ?? '–'}</td>
  </tr>`;
}

const METRIC_HEADERS = `<tr>
  <th>그룹</th><th>n</th>
  <th>avgMFE1</th><th>avgMFE3</th><th>avgMFE5</th><th>avgMFE10</th>
  <th>hit3</th><th>hit5</th><th>hit10</th>
  <th>fail3</th><th>fail5</th>
  <th>closeHold</th><th>다음시가gap평균</th><th>다음시가gap up</th><th>상한가도달</th>
</tr>`;

function renderTable(title, rowsHtml) {
  return `
<details open><summary style="cursor:pointer;font-size:16px;font-weight:700;color:#fde047;padding:6px 0;">${escapeHtml(title)}</summary>
<table style="border-collapse:collapse;width:100%;font-size:13px;margin:8px 0 20px;">
  <thead style="background:#1e293b;">${METRIC_HEADERS}</thead>
  <tbody>${rowsHtml}</tbody>
</table></details>`;
}

function renderEventList(events, limit) {
  const top = events
    .slice()
    .sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      const am = (a.perfs.p1000 && a.perfs.p1000.mfe5) || -999;
      const bm = (b.perfs.p1000 && b.perfs.p1000.mfe5) || -999;
      return bm - am;
    })
    .slice(0, limit);

  const rows = top.map((e) => {
    const prevChangePct = (e.dRow.close / e.prevClose - 1) * 100;
    const p = e.perfs.p1000 || {};
    return `<tr>
      <td>${escapeHtml(e.date)}</td>
      <td>10:00</td>
      <td><strong>${escapeHtml(e.name)}</strong></td>
      <td>${escapeHtml(e.code)}</td>
      <td>C (관찰 제외)</td>
      <td>${escapeHtml(e.status)} (${escapeHtml(STATUS_KO[e.status] || '')})</td>
      <td style="color:#22c55e;">+${fmt(prevChangePct, 1)}%</td>
      <td>${e.snap1000.signalPrice.toLocaleString()}</td>
      <td>${e.dRow.high.toLocaleString()}</td>
      <td>${e.dRow.close.toLocaleString()}</td>
      <td>${fmt(p.mfe3, 1) ?? '–'}</td>
      <td>${fmt(p.mfe5, 1) ?? '–'}</td>
      <td>${fmt(p.mfe10, 1) ?? '–'}</td>
      <td style="color:${p.fail5 ? '#f87171' : '#94a3b8'};">${p.fail5 ? 'F5' : p.fail3 ? 'F3' : '–'}</td>
      <td>${fmt(p.nextDayGapPct, 1) ?? '–'}%</td>
      <td>${p.upperLimitHit ? '🚀' : '–'}</td>
    </tr>`;
  }).join('');

  return `
<details><summary style="cursor:pointer;font-size:16px;font-weight:700;color:#fde047;padding:6px 0;">6. 이벤트 리스트 (Group D, 상위 ${top.length}건 — 10:00 신호 기준)</summary>
<table style="border-collapse:collapse;width:100%;font-size:12px;margin:8px 0 20px;">
  <thead style="background:#1e293b;"><tr>
    <th>날짜</th><th>시각</th><th>종목명</th><th>코드</th>
    <th>기존 분류</th><th>제외 사유</th>
    <th>전일대비</th><th>신호가</th><th>당일고가</th><th>당일종가</th>
    <th>mfe3</th><th>mfe5</th><th>mfe10</th>
    <th>fail</th><th>다음시가gap</th><th>상한가</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table></details>`;
}

function renderSummaryCard(label, res) {
  const s = res.summary;
  return `
<div style="background:#0f172a;border-left:4px solid #fde047;padding:16px 20px;margin:0 0 16px;border-radius:8px;">
  <div style="font-size:13px;color:#94a3b8;font-weight:600;">${escapeHtml(label)} (실거래일 ${res.actualDays}일)</div>
  <div style="margin-top:10px;font-size:18px;font-weight:700;color:#fde047;">가장 성과 좋은 그룹: ${escapeHtml(s.bestGroup)}</div>
  <div style="margin-top:12px;font-size:14px;line-height:1.7;color:#e2e8f0;">
    <strong>공격형(A) vs 관찰 제외 +8%(D) — hit5 차이:</strong>
      A ${s.groupA_hit5}% / D ${s.groupD_hit5}% → <span style="color:${s.diffHit5 >= 0 ? '#22c55e' : '#f87171'};font-weight:700;">${s.diffHit5 >= 0 ? '+' : ''}${s.diffHit5}p</span><br>
    <strong>hit10 차이:</strong>
      A ${s.groupA_hit10}% / D ${s.groupD_hit10}% → <span style="color:${s.diffHit10 >= 0 ? '#22c55e' : '#f87171'};font-weight:700;">${s.diffHit10 >= 0 ? '+' : ''}${s.diffHit10}p</span><br>
    <strong>fail5 차이:</strong>
      A ${s.groupA_fail5}% / D ${s.groupD_fail5}% → <span style="color:${s.diffFail5 <= 0 ? '#22c55e' : '#f87171'};font-weight:700;">${s.diffFail5 >= 0 ? '+' : ''}${s.diffFail5}p</span>
  </div>
  <div style="margin-top:14px;padding:12px;background:#1e293b;border-radius:6px;font-size:14px;color:#fef3c7;">
    💡 ${s.interpretation}
  </div>
</div>`;
}

function renderHtml(result, limitEvents) {
  const sections60  = result['60d'];
  const sections120 = result['120d'];

  const groupRows60 = sections60 ? (
    renderMetricsRow('A. 공격형 (READY + 상위 5)',  sections60.groupComp.A_attack) +
    renderMetricsRow('B. 10시 생존',                 sections60.groupComp.B_survivor1000) +
    renderMetricsRow('C. 관찰 제외 전체',            sections60.groupComp.C_excludedAll) +
    renderMetricsRow('D. 관찰 제외 + 10:00 +8%',     sections60.groupComp.D_excluded_plus8)
  ) : '';
  const groupRows120 = sections120 ? (
    renderMetricsRow('A. 공격형 (READY + 상위 5)',  sections120.groupComp.A_attack) +
    renderMetricsRow('B. 10시 생존',                 sections120.groupComp.B_survivor1000) +
    renderMetricsRow('C. 관찰 제외 전체',            sections120.groupComp.C_excludedAll) +
    renderMetricsRow('D. 관찰 제외 + 10:00 +8%',     sections120.groupComp.D_excluded_plus8)
  ) : '';

  const plus8CritRows60 = sections60 ? (
    renderMetricsRow('signalPricePlus8 @ 10:00',  sections60.plus8Crit.signalPricePlus8) +
    renderMetricsRow('intradayHighPlus8 @ 10:00', sections60.plus8Crit.intradayHighPlus8) +
    renderMetricsRow('closePlus8 (일봉 기준)',     sections60.plus8Crit.closePlus8)
  ) : '';

  let snapRows60 = '';
  if (sections60) {
    for (const t of ['0930', '1000', '1100']) {
      const sc = sections60.snapComp[t];
      const lbl = `${t.slice(0, 2)}:${t.slice(2)} signalPricePlus8` + (sc.noDataDays > 0 ? ` (no-data ${sc.noDataDays})` : '');
      snapRows60 += renderMetricsRow(lbl, sc.signalPricePlus8);
    }
  }

  const subRows60 = sections60 ? (
    renderMetricsRow('1. +8% only',                       sections60.sub['1_plus8_only']) +
    renderMetricsRow('2. +8% + 거래대금 3배',             sections60.sub['2_plus8_value3x']) +
    renderMetricsRow('3. +8% + 거래대금 5배',             sections60.sub['3_plus8_value5x']) +
    renderMetricsRow('4. +8% + v/mc 상위 25%',            sections60.sub['4_plus8_vmc_top25']) +
    renderMetricsRow('5. +8% + 종가위치 ≥ 0.70',          sections60.sub['5_plus8_closepos_70']) +
    renderMetricsRow('6. +8% + 종가위치 ≥ 0.80',          sections60.sub['6_plus8_closepos_80']) +
    renderMetricsRow('7. +8% + 다음시가 갭상승',          sections60.sub['7_plus8_nextopen_up'])
  ) : '';

  const eventListHtml = sections60 ? renderEventList(sections60.dEvents, limitEvents) : '';

  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<title>1DS 관찰 제외 +8% 감사용 백테스트</title>
<style>
  body { background:#0f172a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; margin:0; padding:20px; }
  h1 { color:#fde047; font-size:24px; margin:0 0 8px; }
  .sub { color:#94a3b8; font-size:13px; margin-bottom:20px; }
  table { background:#0b1320; }
  th, td { padding:6px 10px; border:1px solid #1e293b; text-align:left; }
  th { color:#fde047; font-weight:700; }
  details summary { outline:none; }
  .meta-note { font-size:12px; color:#94a3b8; background:#1e293b; padding:10px 14px; border-radius:6px; margin:0 0 18px; }
</style>
</head><body>

<h1>1DS "관찰 제외 +8%" 감사용 백테스트</h1>
<div class="sub">
  생성: ${escapeHtml(result.meta.generatedAt)} ·
  분봉 ${escapeHtml(result.meta.intradayDateFrom)} ~ ${escapeHtml(result.meta.intradayDateTo)} ·
  실거래일 60d=${result.meta.actualDays['60'] || '-'} / 120d=${result.meta.actualDays['120'] || '-'} ·
  이벤트 ${result.meta.totalEvents}건
</div>

<div class="meta-note">
  <strong>그룹 정의:</strong>
  A. 공격형 = scanner status=READY + finalScore 상위 ${ATTACK_TOP_N} (라이브 attackTopCandidates의 09:30 시점 proxy).
  B. 10시 생존 = READY + close(10:00) > close(09:30).
  C. 관찰 제외 = status ∈ {WAIT_PULLBACK, FADED, WEAK} — 라이브 보드 watchOnly의 상위 집합 (보드는 추가 위험 패턴 필터).
  D. 관찰 제외 + +8% = C ∩ (10:00 close 기준 전일 대비 +8% 이상).
  <br><strong>주의:</strong> 매수 추천 아님, 감사용 후속 상승률 검증.
</div>

${sections60 ? '<h2 style="color:#fde047;font-size:18px;margin:18px 0 10px;">📊 60거래일</h2>' + renderSummaryCard('60거래일 요약', sections60) : ''}
${sections120 ? '<h2 style="color:#fde047;font-size:18px;margin:18px 0 10px;">📊 120거래일</h2>' + renderSummaryCard('120거래일 요약', sections120) : ''}

${sections60 ? renderTable('2. 그룹 비교 표 — 60거래일 (10:00 신호 기준)', groupRows60) : ''}
${sections120 ? renderTable('2-2. 그룹 비교 표 — 120거래일 (10:00 신호 기준)', groupRows120) : ''}
${sections60 ? renderTable('3. +8% 기준별 비교 표 (Group D 내, 60d, 10:00 신호)', plus8CritRows60) : ''}
${sections60 ? renderTable('4. 시간대별 비교 표 (Group D, signalPricePlus8 기준, 60d)', snapRows60) : ''}
${sections60 ? renderTable('5. 조건 추가별 비교 표 (Group D 분해, 60d, signalPricePlus8 @ 10:00 기준)', subRows60) : ''}
${eventListHtml}

</body></html>`;
}

// ── 메인 ──
function main() {
  const args = parseArgs(process.argv);
  console.log('🔍 1DS 관찰 제외 +8% 감사용 백테스트 시작');
  const metaMap = scanner.loadStockMetaMap();
  const allDates = listIntradayDates();
  if (allDates.length === 0) {
    console.error('❌ data/intraday/1ds/ 에 거래일 디렉토리 없음');
    process.exit(1);
  }
  console.log(`  분봉 가용 거래일: ${allDates.length}일 (${allDates[0]} ~ ${allDates[allDates.length-1]})`);

  const allEvents = [];
  for (const dateDir of allDates) {
    const evts = analyzeDay(dateDir, metaMap);
    if (evts.length > 0) {
      const c = evts.filter((e) => e.isC).length;
      const a = evts.filter((e) => e.isA).length;
      const b = evts.filter((e) => e.isB).length;
      console.log(`  ${dateDir}: 총 ${evts.length} (A=${a} B=${b} C=${c})`);
    }
    allEvents.push(...evts);
  }
  console.log(`  전체 이벤트: ${allEvents.length}건`);

  // v/mc 상위 25% threshold (전체 분포 기준)
  const vmcVals = allEvents.map((e) => e.valueToMarketCapRatio).filter((v) => v > 0).sort((a, b) => b - a);
  const vmcTop25Threshold = vmcVals.length > 0 ? vmcVals[Math.floor(vmcVals.length * 0.25)] : 0;

  const result = {
    meta: {
      generatedAt: new Date().toISOString(),
      intradayDateFrom: allDates[0],
      intradayDateTo: allDates[allDates.length - 1],
      windows: args.windows,
      actualDays: {},
      totalEvents: allEvents.length,
      vmcTop25Threshold,
      notes: 'C의 정의: scanner status ∈ {WAIT_PULLBACK, FADED, WEAK} — 라이브 보드 watchOnly의 상위 집합. A는 finalScore 상위 5 proxy.',
    },
  };

  for (const w of args.windows) {
    const r = runBacktest(allEvents, w, vmcTop25Threshold);
    result.meta.actualDays[String(w)] = r.actualDays;
    // dEvents는 60d 용 화면에만 (120d는 집계만)
    const summary = {
      actualDays: r.actualDays,
      summary: r.summary,
      groupComp: r.groupComp,
      plus8Crit: r.plus8Crit,
      snapComp: r.snapComp,
      sub: r.sub,
      dEvents: w === 60 ? r.dEvents : undefined,
    };
    result[w + 'd'] = summary;
  }

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // JSON 출력 — dEvents는 상위 limitEvents개만 + 가벼운 필드만
  const jsonOut = JSON.parse(JSON.stringify(result));
  for (const w of args.windows) {
    if (jsonOut[w + 'd'] && jsonOut[w + 'd'].dEvents) {
      jsonOut[w + 'd'].dEvents = jsonOut[w + 'd'].dEvents
        .slice()
        .sort((a, b) => {
          if (a.date !== b.date) return b.date.localeCompare(a.date);
          const am = (a.perfs.p1000 && a.perfs.p1000.mfe5) || -999;
          const bm = (b.perfs.p1000 && b.perfs.p1000.mfe5) || -999;
          return bm - am;
        })
        .slice(0, args.limitEvents)
        .map((e) => ({
          date: e.date,
          code: e.code,
          name: e.name,
          status: e.status,
          prevChangePct: fmt((e.dRow.close / e.prevClose - 1) * 100, 1),
          signalPrice: e.snap1000.signalPrice,
          dayHigh: e.dRow.high,
          dayClose: e.dRow.close,
          mfe3:  fmt(e.perfs.p1000 && e.perfs.p1000.mfe3, 1),
          mfe5:  fmt(e.perfs.p1000 && e.perfs.p1000.mfe5, 1),
          mfe10: fmt(e.perfs.p1000 && e.perfs.p1000.mfe10, 1),
          fail3: !!(e.perfs.p1000 && e.perfs.p1000.fail3),
          fail5: !!(e.perfs.p1000 && e.perfs.p1000.fail5),
          nextDayGapPct: fmt(e.perfs.p1000 && e.perfs.p1000.nextDayGapPct, 1),
          upperLimitHit: !!(e.perfs.p1000 && e.perfs.p1000.upperLimitHit),
        }));
    }
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(jsonOut, null, 2), 'utf-8');
  console.log(`✅ JSON 저장: ${OUT_JSON}`);

  if (!args.noHtml) {
    const html = renderHtml(result, args.limitEvents);
    fs.writeFileSync(OUT_HTML, html, 'utf-8');
    console.log(`✅ HTML 저장: ${OUT_HTML}`);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}
