// Phase 7 — Korea Rebound Model 백테스트
//
// d1~d5 단기 반등 모델 (d20 추세 모델 X)
// forwardDays = [1, 3, 5, 10]
//
// 비교 대상:
//   - Rebound (calculateReboundScore 통과)
//   - FlowLead (calculateFlowLeadScore 통과)
//   - Bull Trend Model (구 v2 setupScore ≥ 75 + entryReady)
//   - baselineTrendRS, baselineAll
//
// 그룹 분리:
//   - score bucket (70+/60-69/50-59/<50)
//   - regime (bull/bear/sideways)
//   - market (KOSPI/KOSDAQ)
//   - 시총 구간, 거래대금 구간
//   - winsorize 5%
//   - topN (top5/top10/top20 — 점수 상위 N 만)
//
// 핵심 판정: Rebound 의 d5 PF / median / winRate 가 baselineTrendRS 대비 의미있게 우위?

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const FORWARD_DAYS = [1, 3, 5, 10];
const DAYS_BACK = 700;

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
function trimKey(trials, key) {
  return trimmed(trials.map((t) => t.forward?.[key]).filter(Number.isFinite));
}
function dominates(a, b) {
  if (!a || !b) return false;
  return a.mean > b.mean && a.median > b.median && a.pf > b.pf && a.win > b.win;
}

// ─── load ───
const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

(async () => {
  console.log('================================================================');
  console.log('Phase 7 — Korea Rebound Model 백테스트');
  console.log('================================================================');
  console.log(`daysBack=${DAYS_BACK}, forwardDays=${FORWARD_DAYS.join(',')}\n`);

  // ─── 구 v2 백테스트 — trendRS pool + Bull Trend pool ───
  const t0 = Date.now();
  console.log('[1/3] 구 v2 백테스트 (baselineTrendRS + Bull Trend Model) 호출…');
  const r = await ps.backtestTotalScore({
    daysBack: DAYS_BACK,
    forwardDays: [1, 5, 20],   // v2 default — 결과는 키만 사용
    entryMode: 'nextOpen',
    applyAtrStop: true,
    useFinancials: 'asOf',
    cacheDir: CHART_DIR,
  });
  console.log(`  → trendRS=${r.trendRSTrials.length}, allScored=${r.allScored.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  function keyOf(t) { return `${t.code}|${t.date}`; }
  const trendRSByKey = new Set();
  for (const t of r.trendRSTrials) trendRSByKey.add(keyOf(t));
  const bullTrendByKey = new Set();
  for (const t of r.allScored) {
    if (t.setupScore >= 75 && t.entryReady) bullTrendByKey.add(keyOf(t));
  }

  // ─── trial 수집 ───
  console.log('\n[2/3] Rebound + FlowLead trial 수집…');
  const codes = fs.readdirSync(FLOW_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

  const reboundTrials = [];
  const flowTrials = [];
  const allTrials = [];
  const trendRSCloseTrials = [];
  const bullTrendCloseTrials = [];

  let scanned = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const meta = codeMeta.get(code) || {};
    if (meta.isSpecial || meta.isEtf) continue;
    if ((meta.marketValue || 0) < 100_000_000_000) continue;

    let flow;
    try {
      flow = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, `${code}.json`), 'utf-8'));
    } catch (_) { continue; }
    const flowRows = flow.rows || [];
    if (flowRows.length < 30) continue;

    const chartPath = path.join(CHART_DIR, `${code}.json`);
    if (!fs.existsSync(chartPath)) continue;
    let chart;
    try {
      chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8'));
    } catch (_) { continue; }
    const chartRows = chart.rows || [];
    if (chartRows.length < 220) continue;  // Rebound 200MA 필요

    const flowDateSet = new Set(flowRows.map((r) => r.date));

    const N = chartRows.length;
    const startIdx = Math.max(200, N - DAYS_BACK);
    const maxFwd = Math.max(...FORWARD_DAYS);

    for (let t = startIdx; t < N - maxFwd - 1; t++) {
      const today = chartRows[t];
      const start20 = Math.max(0, t - 19);
      const last20 = chartRows.slice(start20, t + 1);
      const avg20Value = last20.reduce((s, x) => s + (x.valueApprox || 0), 0) / Math.max(last20.length, 1);
      if (avg20Value < 5_000_000_000) continue;

      const forward = {};
      for (const fwd of FORWARD_DAYS) {
        const fut = chartRows[t + fwd];
        if (!fut || !(today.close > 0) || !(fut.close > 0)) continue;
        forward[`d${fwd}`] = fut.close / today.close - 1;
      }
      if (!Number.isFinite(forward.d5)) continue;

      const baseTrial = {
        code,
        date: today.date,
        market: meta.market,
        marketCap: meta.marketValue,
        avg20Value,
        forward,
      };
      allTrials.push(baseTrial);
      scanned++;

      const k = keyOf(baseTrial);
      if (trendRSByKey.has(k)) trendRSCloseTrials.push(baseTrial);
      if (bullTrendByKey.has(k)) bullTrendCloseTrials.push(baseTrial);

      if (!flowDateSet.has(today.date)) continue;
      const flowsUpTo = flowRows.filter((f) => f.date <= today.date);
      if (flowsUpTo.length < 10) continue;
      const chartsUpTo = chartRows.slice(0, t + 1);

      // FlowLead
      let fScore;
      try { fScore = ps.calculateFlowLeadScore(chartsUpTo, flowsUpTo, meta); } catch (_) { fScore = null; }
      if (fScore?.passed) {
        flowTrials.push({ ...baseTrial, score: fScore.score, breakdown: fScore.breakdown, signals: fScore.signals });
      }

      // Rebound
      let rScore;
      try { rScore = ps.calculateReboundScore(chartsUpTo, flowsUpTo, meta); } catch (_) { rScore = null; }
      if (rScore?.passed) {
        reboundTrials.push({ ...baseTrial, score: rScore.score, breakdown: rScore.breakdown, signals: rScore.signals });
      }
    }

    if ((i + 1) % 50 === 0 || i === codes.length - 1) {
      console.log(`  ${i + 1}/${codes.length}: scanned=${scanned}, all=${allTrials.length}, flow=${flowTrials.length}, rebound=${reboundTrials.length}`);
    }
  }

  console.log(`\n→ allTrials=${allTrials.length}, trendRS=${trendRSCloseTrials.length}, bullTrend=${bullTrendCloseTrials.length}, flow=${flowTrials.length}, rebound=${reboundTrials.length}`);

  // ─── monthly regime ───
  console.log('\n[3/3] 그룹 분석…');
  const monthOf = (d) => String(d).slice(0, 6);
  const monthMap = new Map();
  for (const t of allTrials) {
    if (!Number.isFinite(t.forward.d5)) continue;
    const m = monthOf(t.date);
    if (!monthMap.has(m)) monthMap.set(m, []);
    monthMap.get(m).push(t.forward.d5);
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
  for (const arr of [allTrials, trendRSCloseTrials, bullTrendCloseTrials, flowTrials, reboundTrials]) {
    for (const t of arr) t.regime = monthRegime.get(monthOf(t.date)) || 'unknown';
  }

  // ─── 출력 헬퍼 ───
  function compareTab(filter, fwd) {
    const re = reboundTrials.filter(filter);
    const fl = flowTrials.filter(filter);
    const all = allTrials.filter(filter);
    const trs = trendRSCloseTrials.filter(filter);
    const bull = bullTrendCloseTrials.filter(filter);
    const k = `d${fwd}`;
    return [
      row('Rebound',          aggKey(re, k), trimKey(re, k)),
      row('FlowLead',         aggKey(fl, k), trimKey(fl, k)),
      row('Bull Trend',       aggKey(bull, k), trimKey(bull, k)),
      row('baselineTrendRS',  aggKey(trs, k)),
      row('baselineAll',      aggKey(all, k)),
    ];
  }

  // 1. 전체 d1/d3/d5/d10
  console.log('\n\n## 1. 전체 d1/d3/d5/d10');
  for (const fwd of FORWARD_DAYS) {
    console.log(`\n### d${fwd}`);
    console.table(compareTab(() => true, fwd));
  }

  // 2. score bucket — Rebound
  console.log('\n\n## 2. Rebound score bucket');
  for (const fwd of FORWARD_DAYS) {
    console.log(`\n### d${fwd}`);
    const buckets = [
      ['70+',    (t) => t.score >= 70],
      ['60-69',  (t) => t.score >= 60 && t.score < 70],
      ['50-59',  (t) => t.score >= 50 && t.score < 60],
      ['<50',    (t) => t.score < 50],
    ];
    const rows = buckets.map(([lab, f]) => {
      const ts = reboundTrials.filter(f);
      return row(lab, aggKey(ts, `d${fwd}`), trimKey(ts, `d${fwd}`));
    });
    rows.push(row('baselineAll', aggKey(allTrials, `d${fwd}`)));
    console.table(rows);
  }

  // 3. regime × d3/d5
  console.log('\n\n## 3. regime × d3, d5');
  for (const reg of ['bull', 'bear', 'sideways']) {
    for (const fwd of [3, 5]) {
      console.log(`\n### ${reg} d${fwd}`);
      console.table(compareTab((t) => t.regime === reg, fwd));
    }
  }

  // 4. KOSPI/KOSDAQ × d5
  console.log('\n\n## 4. market × d5');
  for (const m of ['KOSPI', 'KOSDAQ']) {
    console.log(`\n### ${m}`);
    console.table(compareTab((t) => t.market === m, 5));
  }

  // 5. 시총 × d5
  console.log('\n\n## 5. 시총 × d5');
  function mcGroup(t) {
    const mc = t.marketCap || 0;
    if (mc >= 1_000_000_000_000) return '1조+';
    if (mc >= 300_000_000_000) return '3000억-1조';
    if (mc >= 100_000_000_000) return '1000-3000억';
    return '<1000억';
  }
  for (const grp of ['1000-3000억', '3000억-1조', '1조+']) {
    console.log(`\n### ${grp}`);
    console.table(compareTab((t) => mcGroup(t) === grp, 5));
  }

  // 6. 거래대금 × d5
  console.log('\n\n## 6. 거래대금 × d5');
  function tvGroup(t) {
    const v = t.avg20Value || 0;
    if (v >= 30_000_000_000) return '300억+';
    if (v >= 10_000_000_000) return '100-300억';
    if (v >= 5_000_000_000) return '50-100억';
    return '<50억';
  }
  for (const grp of ['50-100억', '100-300억', '300억+']) {
    console.log(`\n### ${grp}`);
    console.table(compareTab((t) => tvGroup(t) === grp, 5));
  }

  // 7. winsorize 5% — 전체 d3/d5
  console.log('\n\n## 7. winsorize 5% — d3, d5');
  for (const fwd of [3, 5]) {
    const k = `d${fwd}`;
    console.log(`\n### d${fwd}`);
    console.table([
      row('Rebound raw',          aggKey(reboundTrials, k)),
      row('Rebound 5%',           trimKey(reboundTrials, k)),
      row('FlowLead raw',         aggKey(flowTrials, k)),
      row('FlowLead 5%',          trimKey(flowTrials, k)),
      row('Bull Trend raw',       aggKey(bullTrendCloseTrials, k)),
      row('baselineTrendRS raw',  aggKey(trendRSCloseTrials, k)),
      row('baselineAll raw',      aggKey(allTrials, k)),
      row('baselineAll 5%',       trimKey(allTrials, k)),
    ]);
  }

  // 8. topN — 매일 score 상위 N 만 (한 시점당 N 개)
  console.log('\n\n## 8. Rebound topN — 매일 score 상위 N 진입 (d5)');
  const reboundByDate = new Map();
  for (const t of reboundTrials) {
    if (!reboundByDate.has(t.date)) reboundByDate.set(t.date, []);
    reboundByDate.get(t.date).push(t);
  }
  function topNRets(N, key) {
    const rets = [];
    for (const arr of reboundByDate.values()) {
      const sorted = [...arr].sort((a, b) => b.score - a.score).slice(0, N);
      for (const t of sorted) {
        const v = t.forward?.[key];
        if (Number.isFinite(v)) rets.push(v);
      }
    }
    return rets;
  }
  const topRows = [];
  for (const N of [5, 10, 20]) {
    for (const fwd of [3, 5]) {
      const rets = topNRets(N, `d${fwd}`);
      const s = summarize(rets);
      const tr = trimmed(rets);
      topRows.push({ group: `top${N} d${fwd}`, ...s, trMean: tr?.mean, trPF: tr?.pf });
    }
  }
  console.table(topRows);

  // ─── 판정 ───
  console.log('\n\n================================================================');
  console.log('## 판정 — Rebound vs baselineTrendRS (핵심: d3, d5)');
  console.log('================================================================');
  function compareDetail(a, b, fwd) {
    if (!a || !b) return `  d${fwd}: 표본 부족`;
    const checks = [
      ['mean',   a.mean   > b.mean],
      ['median', a.median > b.median],
      ['PF',     a.pf     > b.pf],
      ['win%',   a.win    > b.win],
    ];
    const ok = checks.filter(([, v]) => v).length;
    const detail = checks.map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join(' ');
    return `  d${fwd}: ${detail}  (${ok}/4)  | RB n=${a.n} mean=${a.mean}% med=${a.median}% PF=${a.pf} win=${a.win}%   vs   trsRS n=${b.n} mean=${b.mean}% med=${b.median}% PF=${b.pf} win=${b.win}%`;
  }

  const reD3 = aggKey(reboundTrials, 'd3');
  const reD5 = aggKey(reboundTrials, 'd5');
  const trsD3 = aggKey(trendRSCloseTrials, 'd3');
  const trsD5 = aggKey(trendRSCloseTrials, 'd5');

  console.log('\n전체 (Rebound vs baselineTrendRS):');
  console.log(compareDetail(reD3, trsD3, 3));
  console.log(compareDetail(reD5, trsD5, 5));

  const fullPassD3 = dominates(reD3, trsD3);
  const fullPassD5 = dominates(reD5, trsD5);

  console.log('\nRegime 별 (d3 / d5 동시 4지표 우위):');
  const regimeResults = [];
  for (const reg of ['bull', 'bear', 'sideways']) {
    const rb = reboundTrials.filter((t) => t.regime === reg);
    const tr = trendRSCloseTrials.filter((t) => t.regime === reg);
    const r3 = aggKey(rb, 'd3'), t3 = aggKey(tr, 'd3');
    const r5 = aggKey(rb, 'd5'), t5 = aggKey(tr, 'd5');
    const ok = dominates(r3, t3) && dominates(r5, t5);
    regimeResults.push({ reg, ok });
    console.log(`\n  [${reg}] d3/d5 4지표 동시 우위: ${ok ? '✅' : '✗'}`);
    console.log(compareDetail(r3, t3, 3));
    console.log(compareDetail(r5, t5, 5));
  }
  const regimePassed = regimeResults.filter((r) => r.ok).map((r) => r.reg);

  // ─── 결론 — bear/sideways 부활 여부가 사용자 가설의 핵심 ───
  console.log('\n\n================================================================');
  console.log('## 최종 결론 (Rebound)');
  console.log('================================================================');
  const bearSideways = regimePassed.filter((r) => r === 'bear' || r === 'sideways');
  let conclusion;
  if (fullPassD3 && fullPassD5) {
    conclusion = '✅ Rebound 채택 가능 — 전체 d3/d5 모두 baselineTrendRS 대비 mean+median+PF+win 4지표 동시 우위';
  } else if (bearSideways.length === 2) {
    conclusion = '✅ Rebound 채택 가능 (regime 한정) — bear/sideways 모두 d3/d5 4지표 우위. 사용자 가설(약세장에서 반등 잡기) 적중';
  } else if (bearSideways.length === 1) {
    conclusion = `⚠️ 특정 regime 에서만 제한 사용 (${bearSideways[0]} 만 통과) — 약세장 부분 부활`;
  } else if (regimePassed.length > 0) {
    conclusion = `⚠️ 특정 regime 에서만 제한 사용 (${regimePassed.join(', ')}) — 단 핵심인 bear/sideways 는 미통과`;
  } else if ((reD5?.n ?? 0) >= 100) {
    conclusion = '🚨 후보는 나오지만 알파 없음 — n 충분, baselineTrendRS 대비 우위 무. 가설(과매도 후 반등) 재검토';
  } else {
    conclusion = '🚨 모델 재설계 필요 — 후보 수 부족 (n<100)';
  }
  console.log('\n  ' + conclusion);
  console.log(`\n  (전체 d3 4지표 우위: ${fullPassD3 ? 'YES' : 'NO'}, 전체 d5 4지표 우위: ${fullPassD5 ? 'YES' : 'NO'}, regime 통과: ${regimePassed.length > 0 ? regimePassed.join('/') : 'none'})`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
