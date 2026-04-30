// Phase 9 — VolumeValueIgnition (거래대금 초동 후보) 백테스트
//
// 거래대금 폭증 신호가 다음날 진입 시 수익을 내는가를 검증
// 진입방식: signalClose / nextOpen / nextClose
// 평가: d3/d5/d10/d20 수익률 + MFE/MAE + hit rate

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const FORWARD_DAYS = [1, 3, 5, 10, 20];
const DAYS_BACK = 700;
const ENTRY_METHODS = ['signalClose', 'nextOpen', 'nextClose', 'nextHighBreak'];

// ─── stats ───
function summarize(rets) {
  if (!rets || !rets.length) return null;
  const sorted = [...rets].sort((a, b) => a - b);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = sum(rets) / rets.length;
  const avgWin = wins.length ? sum(wins) / wins.length : 0;
  const avgLoss = losses.length ? sum(losses) / losses.length : 0;
  const pf = losses.length ? sum(wins) / Math.abs(sum(losses)) : (wins.length ? Infinity : 0);
  return {
    n: rets.length,
    mean: +(mean * 100).toFixed(2),
    median: +(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(2),
    win: Math.round((wins.length / rets.length) * 100),
    avgW: +(avgWin * 100).toFixed(2),
    avgL: +(avgLoss * 100).toFixed(2),
    pf: +pf.toFixed(2),
    worst: +(sorted[0] * 100).toFixed(2),
  };
}
function summarizeByThreshold(rets, threshold) {
  if (!rets || !rets.length) return 0;
  return Math.round((rets.filter(r => r >= threshold).length / rets.length) * 100);
}
function calcMfeMae(chartRows, entryIdx, entryPrice, days) {
  let mfe = 0, mae = 0;
  for (let k = 1; k <= days && entryIdx + k < chartRows.length; k++) {
    const bar = chartRows[entryIdx + k];
    if (!bar) break;
    mfe = Math.max(mfe, (bar.high || bar.close) / entryPrice - 1);
    mae = Math.min(mae, (bar.low || bar.close) / entryPrice - 1);
  }
  return { mfe: +(mfe * 100).toFixed(2), mae: +(mae * 100).toFixed(2) };
}
function trimmed(rets, pct = 0.05) {
  if (!rets || rets.length < 20) return null;
  const sorted = [...rets].sort((a, b) => a - b);
  const lo = Math.floor(sorted.length * pct);
  const hi = Math.ceil(sorted.length * (1 - pct));
  return summarize(sorted.slice(lo, hi));
}
function row(label, s, t = null) {
  if (!s) return { group: label, n: 0 };
  return { group: label, n: s.n, mean: s.mean, median: s.median, win: s.win, pf: s.pf, worst: s.worst, trMean: t?.mean, trPF: t?.pf };
}
function aggKey(trials, key) {
  return summarize(trials.map((t) => t.forward?.[key]).filter(Number.isFinite));
}
function summarizeBreakout(trials, entryPriceField, metric) {
  const rets = trials.filter(t => t.triggered).map(t => t[metric]).filter(Number.isFinite);
  if (!rets || !rets.length) return null;
  const sorted = [...rets].sort((a, b) => a - b);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = sum(rets) / rets.length;
  const pf = losses.length ? sum(wins) / Math.abs(sum(losses)) : (wins.length ? Infinity : 0);
  return {
    triggered: trials.filter(t => t.triggered).length,
    triggerRate: Math.round((trials.filter(t => t.triggered).length / trials.length) * 100),
    n: rets.length,
    mean: +(mean * 100).toFixed(2),
    median: +(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(2),
    win: Math.round((wins.length / rets.length) * 100),
    pf: +pf.toFixed(2),
    worst: +(sorted[0] * 100).toFixed(2),
  };
}
function trimKey(trials, key) {
  return trimmed(trials.map((t) => t.forward?.[key]).filter(Number.isFinite));
}

// ─── load ───
const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

(async () => {
  console.log('================================================================');
  console.log('Phase 9 — VolumeValueIgnition (거래대금 초동 후보) 백테스트');
  console.log('================================================================');
  console.log(`daysBack=${DAYS_BACK}, forwardDays=${FORWARD_DAYS.join(',')}\n`);

  // ─── 기준선 — 전체 평균 ───
  const t0 = Date.now();
  console.log('[1/2] trial 수집…');

  const codes = fs.readdirSync(FLOW_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

  const vviTrials = [];
  const allTrials = [];

  let scanned = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const meta = codeMeta.get(code) || {};
    if (meta.isSpecial || meta.isEtf) continue;
    if ((meta.marketValue || 0) < 50_000_000_000) continue;

    let flow;
    try {
      flow = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, `${code}.json`), 'utf-8'));
    } catch (_) { continue; }
    const flowRows = flow.rows || [];
    if (flowRows.length < 10) continue;

    const chartPath = path.join(CHART_DIR, `${code}.json`);
    if (!fs.existsSync(chartPath)) continue;
    let chart;
    try {
      chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8'));
    } catch (_) { continue; }
    const chartRows = chart.rows || [];
    if (chartRows.length < 60) continue;

    const flowDateSet = new Set(flowRows.map((r) => r.date));

    const N = chartRows.length;
    const startIdx = Math.max(60, N - DAYS_BACK);
    const maxFwd = Math.max(...FORWARD_DAYS);

    for (let t = startIdx; t < N - maxFwd - 2; t++) {
      const today = chartRows[t];
      const nextBar = chartRows[t + 1];
      const close = today?.close;
      if (!close || close <= 0 || !nextBar) continue;

      const last20rows = chartRows.slice(-20);
      const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last20rows.length, 1);
      if (avg20Value < 2_000_000_000) continue;

      // A. signalClose entry (baseline)
      const forwardSignalClose = {};
      // B. nextOpen entry
      const forwardNextOpen = {};
      // C. nextClose entry
      const forwardNextClose = {};
      // D. nextHighBreak entry (only if nextBar.high > today.high)
      const forwardNextHighBreak = {};

      const nextOpenPrice = nextBar.open;
      const nextClosePrice = nextBar.close;
      const canNextOpen = nextOpenPrice > 0;
      const canNextClose = nextClosePrice > 0;
      const isHighBreakSetup = nextBar.high > today.high;

      for (const fwd of FORWARD_DAYS) {
        const fut = chartRows[t + fwd];
        if (!fut || !(close > 0) || !(fut.close > 0)) continue;

        // A. signalClose: entry at today.close
        forwardSignalClose[`d${fwd}`] = fut.close / close - 1;

        // B. nextOpen: entry at nextBar.open
        if (canNextOpen) {
          forwardNextOpen[`d${fwd}`] = fut.close / nextOpenPrice - 1;
        }

        // C. nextClose: entry at nextBar.close
        if (canNextClose) {
          forwardNextClose[`d${fwd}`] = fut.close / nextClosePrice - 1;
        }

        // D. nextHighBreak: only if setup valid, entry at today.high
        if (isHighBreakSetup) {
          forwardNextHighBreak[`d${fwd}`] = fut.close / today.high - 1;
        }
      }
      if (!Number.isFinite(forwardSignalClose.d5)) continue;

      const baseTrial = {
        code,
        date: today.date,
        market: meta.market,
        marketCap: meta.marketValue,
        avg20Value,
        closePrice: close,
        todayHigh: today.high,
        todayOpen: today.open,
        nextOpen: nextOpenPrice,
        nextClose: nextClosePrice,
        nextHigh: nextBar.high,
        forwardSignalClose,
        forwardNextOpen,
        forwardNextClose,
        forwardNextHighBreak,
        mfeMaeSignalClose: calcMfeMae(chartRows, t, close, 20),
        mfeMaeNextOpen: canNextOpen ? calcMfeMae(chartRows, t + 1, nextOpenPrice, 20) : null,
        mfeMaeNextClose: canNextClose ? calcMfeMae(chartRows, t + 1, nextClosePrice, 20) : null,
        mfeMaeNextHighBreak: isHighBreakSetup ? calcMfeMae(chartRows, t, today.high, 20) : null,
      };
      allTrials.push(baseTrial);
      scanned++;

      if (!flowDateSet.has(today.date)) continue;
      const flowsUpTo = flowRows.filter((f) => f.date <= today.date);
      if (flowsUpTo.length < 10) continue;
      const chartsUpTo = chartRows.slice(0, t + 1);

      // VolumeValueIgnition
      let vviScore;
      try { vviScore = ps.calculateVolumeValueIgnition(chartsUpTo, flowsUpTo, meta); } catch (_) { vviScore = null; }
      if (vviScore?.passed) {
        // Breakout Confirm 전략용 데이터 수집
        const signalHigh = today.high;
        const triggered = nextBar && nextBar.high > signalHigh;

        // 4가지 진입가로 forward returns 계산 (breakout triggered일 때만)
        const breakoutReturnsA = {};  // entry = signalHigh
        const breakoutReturnsB = {};  // entry = signalHigh * 1.003
        const breakoutReturnsC = {};  // entry = signalHigh * 1.005
        const breakoutReturnsD = {};  // entry = nextClose (if triggered)

        if (triggered) {
          const entryA = signalHigh;
          const entryB = signalHigh * 1.003;
          const entryC = signalHigh * 1.005;
          const entryD = nextClosePrice;

          for (const fwd of FORWARD_DAYS) {
            const fut = chartRows[t + fwd];
            if (!fut || !(fut.close > 0)) continue;
            breakoutReturnsA[`d${fwd}`] = fut.close / entryA - 1;
            breakoutReturnsB[`d${fwd}`] = fut.close / entryB - 1;
            breakoutReturnsC[`d${fwd}`] = fut.close / entryC - 1;
            breakoutReturnsD[`d${fwd}`] = fut.close / entryD - 1;
          }
        }

        vviTrials.push({
          ...baseTrial,
          score: vviScore.score,
          category: vviScore.category,
          breakdown: vviScore.breakdown,
          signals: vviScore.signals,
          todayReturn: vviScore.signals?.todayReturn || 0,
          signalHigh,
          triggered,
          nextHighBreakoutHigh: nextBar?.high || 0,
          breakoutReturnsA,
          breakoutReturnsB,
          breakoutReturnsC,
          breakoutReturnsD,
        });
      }
    }

    if ((i + 1) % 50 === 0 || i === codes.length - 1) {
      console.log(`  ${i + 1}/${codes.length}: scanned=${scanned}, all=${allTrials.length}, vvi=${vviTrials.length}`);
    }
  }

  console.log(`\n→ allTrials=${allTrials.length}, vviTrials=${vviTrials.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // ─── regime 분석 ───
  console.log('\n[2/2] 진입 방식별 검증…');
  const monthOf = (d) => String(d).slice(0, 6);
  const monthMap = new Map();
  for (const t of allTrials) {
    if (!Number.isFinite(t.forwardSignalClose?.d5)) continue;
    const m = monthOf(t.date);
    if (!monthMap.has(m)) monthMap.set(m, []);
    monthMap.get(m).push(t.forwardSignalClose.d5);
  }
  const monthRegime = new Map();
  for (const m of [...monthMap.keys()].sort()) {
    const arr = monthMap.get(m);
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    let regime = 'sideways';
    if (mean > 0.02) regime = 'bull';
    else if (mean < -0.01) regime = 'bear';
    monthRegime.set(m, regime);
  }
  for (const arr of [allTrials, vviTrials]) {
    for (const t of arr) t.regime = monthRegime.get(monthOf(t.date)) || 'unknown';
  }

  // ─── 출력 헬퍼 ───
  function aggKeyByMethod(trials, key, method) {
    const field = `forward${method.charAt(0).toUpperCase() + method.slice(1)}`;
    return summarize(trials.map((t) => t[field]?.[key]).filter(Number.isFinite));
  }
  function trimKeyByMethod(trials, key, method) {
    const field = `forward${method.charAt(0).toUpperCase() + method.slice(1)}`;
    return trimmed(trials.map((t) => t[field]?.[key]).filter(Number.isFinite));
  }
  function compareTab(filter, fwd, method) {
    const vvi = vviTrials.filter(filter);
    const all = allTrials.filter(filter);
    const k = `d${fwd}`;
    return [
      row('VVI', aggKeyByMethod(vvi, k, method), trimKeyByMethod(vvi, k, method)),
      row('baseline', aggKeyByMethod(all, k, method)),
    ];
  }

  // ─── 진입 방식 비교 ───
  console.log('\n\n================================================================');
  console.log('## 1. 진입 방식 비교 (VVI d5)');
  console.log('================================================================');
  const vviD5ByMethod = {};
  const baseD5ByMethod = {};
  for (const method of ENTRY_METHODS) {
    vviD5ByMethod[method] = aggKeyByMethod(vviTrials, 'd5', method);
    baseD5ByMethod[method] = aggKeyByMethod(allTrials, 'd5', method);
  }
  console.log('\n### 진입 방식별 d5 수익성');
  const methodComparisons = ENTRY_METHODS.map((method) => ({
    method: method === 'signalClose' ? 'Signal Close' : method === 'nextOpen' ? 'Next Open' : method === 'nextClose' ? 'Next Close' : 'Next High Break',
    vviN: vviD5ByMethod[method]?.n || 0,
    vviMean: vviD5ByMethod[method]?.mean || '-',
    vviWin: vviD5ByMethod[method]?.win || '-',
    vviPF: vviD5ByMethod[method]?.pf || '-',
    baseN: baseD5ByMethod[method]?.n || 0,
    baseMean: baseD5ByMethod[method]?.mean || '-',
    baseWin: baseD5ByMethod[method]?.win || '-',
    basePF: baseD5ByMethod[method]?.pf || '-',
  }));
  console.table(methodComparisons);

  // 2. category — nextOpen 진입 (다음 시가 매수)
  console.log('\n\n## 2. Next Open 진입 × Category (d3, d5, d10)');
  const catRows = {
    STRONG: vviTrials.filter((t) => t.category === 'STRONG_IGNITION'),
    NORMAL: vviTrials.filter((t) => t.category === 'IGNITION'),
  };
  for (const fwd of [3, 5, 10]) {
    console.log(`\n### d${fwd}`);
    const rows = [
      row('STRONG', aggKeyByMethod(catRows.STRONG, `d${fwd}`, 'nextOpen'), trimKeyByMethod(catRows.STRONG, `d${fwd}`, 'nextOpen')),
      row('IGNITION', aggKeyByMethod(catRows.NORMAL, `d${fwd}`, 'nextOpen'), trimKeyByMethod(catRows.NORMAL, `d${fwd}`, 'nextOpen')),
      row('baseline', aggKeyByMethod(allTrials, `d${fwd}`, 'nextOpen')),
    ];
    console.table(rows);
  }

  // 3. regime × d5, nextOpen 진입
  console.log('\n\n## 3. Market Regime × Next Open (d5)');
  for (const reg of ['bull', 'bear', 'sideways']) {
    console.log(`\n### ${reg} regime`);
    console.table(compareTab((t) => t.regime === reg, 5, 'nextOpen'));
  }

  // 4. KOSPI/KOSDAQ × d5, nextOpen
  console.log('\n\n## 4. Market × Next Open (d5)');
  for (const m of ['KOSPI', 'KOSDAQ']) {
    console.log(`\n### ${m}`);
    console.table(compareTab((t) => t.market === m, 5, 'nextOpen'));
  }

  // 5. 시총 × d5, nextOpen
  console.log('\n\n## 5. Market Cap × Next Open (d5)');
  function mcGroup(t) {
    const mc = t.marketCap || 0;
    if (mc >= 1_000_000_000_000) return '1조+';
    if (mc >= 300_000_000_000) return '3000억-1조';
    if (mc >= 100_000_000_000) return '1000-3000억';
    return '<1000억';
  }
  for (const grp of ['1000-3000억', '3000억-1조', '1조+']) {
    console.log(`\n### ${grp}`);
    console.table(compareTab((t) => mcGroup(t) === grp, 5, 'nextOpen'));
  }

  // 6. valueRatio bucket × d5, nextOpen
  console.log('\n\n## 6. Value Ratio × Next Open (d5)');
  function vrGroup(t) {
    const vr = t.signals?.valueRatio20 || 0;
    if (vr >= 5.0) return '5.0+';
    if (vr >= 3.0) return '3.0-5.0';
    if (vr >= 2.0) return '2.0-3.0';
    return '<2.0';
  }
  for (const grp of ['2.0-3.0', '3.0-5.0', '5.0+']) {
    console.log(`\n### ${grp}`);
    console.table(compareTab((t) => vrGroup(t) === grp, 5, 'nextOpen'));
  }

  // 7. closeLocation bucket × d5, nextOpen
  console.log('\n\n## 7. Close Location × Next Open (d5)');
  function clGroup(t) {
    const cl = t.signals?.closeLocation || 0;
    if (cl >= 0.8) return '0.8+';
    if (cl >= 0.6) return '0.6-0.8';
    return '<0.6';
  }
  for (const grp of ['0.6-0.8', '0.8+']) {
    console.log(`\n### ${grp}`);
    console.table(compareTab((t) => clGroup(t) === grp, 5, 'nextOpen'));
  }

  // 8. todayReturn bucket × d5, nextOpen
  console.log('\n\n## 8. Today Return × Next Open (d5)');
  function trGroup(t) {
    const tr = (t.todayReturn || 0) / 100;
    if (tr >= 0.10) return '10%+';
    if (tr >= 0.05) return '5-10%';
    if (tr >= 0.02) return '2-5%';
    return '<2%';
  }
  for (const grp of ['2-5%', '5-10%', '10%+']) {
    console.log(`\n### ${grp}`);
    console.table(compareTab((t) => trGroup(t) === grp, 5, 'nextOpen'));
  }

  // ─── VVI Breakout Confirm 전략 백테스트 ───
  console.log('\n\n================================================================');
  console.log('## VVI Breakout Confirm 전략');
  console.log('================================================================');
  console.log('신호: VVI v2 신호 발생');
  console.log('진입조건: 다음 거래일에 전일 고가를 돌파 (nextBar.high > signalDay.high)');
  console.log('진입가: A) 신호일 고가 / B) 신호일 고가×1.003 / C) 신호일 고가×1.005 / D) 다음일 종가\n');

  function analyzeBreakout(label, trials, entryType) {
    console.log(`\n### ${label}`);

    // Trigger 통계
    const triggered = trials.filter(t => t.triggered);
    const triggerRate = trials.length > 0 ? Math.round((triggered.length / trials.length) * 100) : 0;
    console.log(`Triggered: ${triggered.length}/${trials.length} (${triggerRate}%)\n`);

    if (triggered.length === 0) {
      console.log('(진입 기회 없음)');
      return;
    }

    // 4가지 진입가별 분석
    const entries = ['A', 'B', 'C', 'D'];
    const forwardFields = ['breakoutReturnsA', 'breakoutReturnsB', 'breakoutReturnsC', 'breakoutReturnsD'];
    const results = [];

    for (let i = 0; i < 4; i++) {
      const entry = entries[i];
      const field = forwardFields[i];
      const d5Rets = triggered.map(t => t[field]?.d5).filter(Number.isFinite);

      if (d5Rets.length === 0) {
        results.push({ entry, triggered: 0, triggerRate: 0, n: 0, mean: '-', win: '-', pf: '-', worst: '-' });
      } else {
        const sorted = d5Rets.sort((a, b) => a - b);
        const wins = d5Rets.filter(r => r > 0);
        const losses = d5Rets.filter(r => r < 0);
        const sum = arr => arr.reduce((s, v) => s + v, 0);
        const mean = sum(d5Rets) / d5Rets.length;
        const pf = losses.length ? sum(wins) / Math.abs(sum(losses)) : (wins.length ? Infinity : 0);

        results.push({
          entry: `Entry ${entry}${entry === 'A' ? ' (고가)' : entry === 'B' ? ' (+0.3%)' : entry === 'C' ? ' (+0.5%)' : ' (다음종가)'}`,
          triggered: triggered.length,
          triggerRate,
          n: d5Rets.length,
          mean: +(mean * 100).toFixed(2),
          median: +(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(2),
          win: Math.round((wins.length / d5Rets.length) * 100),
          pf: +pf.toFixed(2),
          worst: +(sorted[0] * 100).toFixed(2),
        });
      }
    }
    console.table(results);
  }

  // 전체 분석
  analyzeBreakout('전체 VVI Breakout Confirm (d5 기준)', vviTrials);

  // 시총별 분석
  console.log('\n\n## 시총별 분석 (Entry A - 신호일 고가)');
  for (const grp of ['500억-1000억', '1000-3000억', '3000억-1조', '1조+']) {
    const filtered = vviTrials.filter(t => {
      const mc = t.marketCap || 0;
      if (grp === '500억-1000억') return mc >= 50_000_000_000 && mc < 100_000_000_000;
      if (grp === '1000-3000억') return mc >= 100_000_000_000 && mc < 300_000_000_000;
      if (grp === '3000억-1조') return mc >= 300_000_000_000 && mc < 1_000_000_000_000;
      if (grp === '1조+') return mc >= 1_000_000_000_000;
      return false;
    });
    if (filtered.length === 0) continue;
    analyzeBreakout(`${grp} (n=${filtered.length})`, filtered);
  }

  // valueRatio 분석
  console.log('\n\n## Value Ratio 분석 (Entry A - 신호일 고가)');
  for (const grp of ['2~3배', '3~5배', '5배+']) {
    const filtered = vviTrials.filter(t => {
      const vr = t.signals?.valueRatio20 || 0;
      if (grp === '2~3배') return vr >= 2.0 && vr < 3.0;
      if (grp === '3~5배') return vr >= 3.0 && vr < 5.0;
      if (grp === '5배+') return vr >= 5.0;
      return false;
    });
    if (filtered.length === 0) continue;
    analyzeBreakout(`${grp} (n=${filtered.length})`, filtered);
  }

  // closeLocation 분석
  console.log('\n\n## Close Location 분석 (Entry A - 신호일 고가)');
  for (const grp of ['0.7-0.8', '0.8+']) {
    const filtered = vviTrials.filter(t => {
      const cl = t.signals?.closeLocation || 0;
      if (grp === '0.7-0.8') return cl >= 0.7 && cl < 0.8;
      if (grp === '0.8+') return cl >= 0.8;
      return false;
    });
    if (filtered.length === 0) continue;
    analyzeBreakout(`${grp} (n=${filtered.length})`, filtered);
  }

  // todayReturn 분석
  console.log('\n\n## Today Return 분석 (Entry A - 신호일 고가)');
  for (const grp of ['2-5%', '5-10%', '10-15%']) {
    const filtered = vviTrials.filter(t => {
      const tr = (t.todayReturn || 0) / 100;
      if (grp === '2-5%') return tr >= 0.02 && tr < 0.05;
      if (grp === '5-10%') return tr >= 0.05 && tr < 0.10;
      if (grp === '10-15%') return tr >= 0.10 && tr < 0.15;
      return false;
    });
    if (filtered.length === 0) continue;
    analyzeBreakout(`${grp} (n=${filtered.length})`, filtered);
  }

  // 장세 분석
  console.log('\n\n## 장세 분석 (Entry A - 신호일 고가)');
  for (const reg of ['bull', 'sideways', 'bear']) {
    const filtered = vviTrials.filter(t => t.regime === reg);
    if (filtered.length === 0) continue;
    const regLabel = reg === 'bull' ? '강세' : reg === 'sideways' ? '횡보' : '약세';
    analyzeBreakout(`${regLabel} (n=${filtered.length})`, filtered);
  }

  // 시장 분석
  console.log('\n\n## 시장 분석 (Entry A - 신호일 고가)');
  for (const m of ['KOSPI', 'KOSDAQ']) {
    const filtered = vviTrials.filter(t => t.market === m);
    if (filtered.length === 0) continue;
    analyzeBreakout(`${m} (n=${filtered.length})`, filtered);
  }

  // ─── 최종 판정 ───
  console.log('\n\n================================================================');
  console.log('## 최종 판정 (VVI Breakout Confirm — Entry A)');
  console.log('================================================================');
  const triggered = vviTrials.filter(t => t.triggered);
  const trigRate = vviTrials.length > 0 ? Math.round((triggered.length / vviTrials.length) * 100) : 0;
  const d5Rets = triggered.map(t => t.breakoutReturnsA?.d5).filter(Number.isFinite);

  let summary = null;
  if (d5Rets.length > 0) {
    const sorted = d5Rets.sort((a, b) => a - b);
    const wins = d5Rets.filter(r => r > 0);
    const losses = d5Rets.filter(r => r < 0);
    const sum = arr => arr.reduce((s, v) => s + v, 0);
    const mean = sum(d5Rets) / d5Rets.length;
    const pf = losses.length ? sum(wins) / Math.abs(sum(losses)) : (wins.length ? Infinity : 0);
    const medVal = sorted[Math.floor(sorted.length / 2)];
    const win = Math.round((wins.length / d5Rets.length) * 100);

    summary = { triggered: triggered.length, trigRate, n: d5Rets.length, mean: +(mean * 100).toFixed(2), win, pf: +pf.toFixed(2) };

    let conclusion;
    if (trigRate >= 40 && win >= 50 && pf >= 1.5 && summary.mean >= 1.0) {
      conclusion = '✅ 채택 가능 — trigger 40% 이상, d5 win≥50%, PF≥1.5, mean≥1.0%';
    } else if (trigRate >= 30 && win >= 48 && pf >= 1.3 && summary.mean >= 0.8) {
      conclusion = '⚠️ 조건부 채택 — trigger 30% 이상, d5 win≥48%, PF≥1.3, mean≥0.8%. 시총 대형주 확인 필요';
    } else if (trigRate >= 20 && win >= 48 && pf >= 1.2) {
      conclusion = '⚠️ 신호 유지 — trigger 20% 이상, 기본 조건 만족. UI 노출 검토';
    } else {
      conclusion = '🚨 성과 미흡 — trigger 또는 수익성 부족. 진입 조건 재검토';
    }

    console.log(`\n${conclusion}`);
    console.log(`\n(VVI Breakout Confirm d5: triggered=${triggered.length}/${vviTrials.length} (${trigRate}%), n=${d5Rets.length}, mean=${summary.mean}%, win=${win}%, PF=${pf.toFixed(2)})`);
  } else {
    console.log('\n🚨 분석 불가 — 진입 기회가 없거나 forward data 부족');
  }
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
