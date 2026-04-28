// FlowLead v2 — 수급 선행·가격 미반응 모델 백테스트
//
// 비교 대상:
//   - FlowLead v2 (calculateFlowLeadScoreV2 통과)
//   - matchedBaseline (flowLeadV2Universe 통과 — 가격/구조/변동성 같은 universe 의 종목, 수급 조건 X)
//   - baselineTrendRS (구 v2 의 TrendTemplate + RS 통과)
//   - baselineAll (시총·거래대금만 통과한 모든 시점)
//
// forward = close-to-close, d5/d10/d20
//
// 그룹: regime / market / score bucket(50-59,60-69,70+) / topN(5,10,20)
// 통계: mean, median, win, PF, n + winsorize 5% mean/PF

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const FORWARD_DAYS = [5, 10, 20];
const DAYS_BACK = 700;

// ─── stats ───
function summarize(rets) {
  if (!rets || !rets.length) return null;
  const sorted = [...rets].sort((a, b) => a - b);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = sum(rets) / rets.length;
  const pf = losses.length ? sum(wins) / Math.abs(sum(losses)) : (wins.length ? Infinity : 0);
  return {
    n: rets.length,
    mean: +(mean * 100).toFixed(2),
    median: +(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(2),
    win: Math.round((wins.length / rets.length) * 100),
    pf: +pf.toFixed(2),
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
  return { group: label, n: s.n, mean: s.mean, median: s.median, win: s.win, pf: s.pf, trMean: t?.mean, trPF: t?.pf };
}
function aggKey(trials, k) {
  return summarize(trials.map((t) => t.forward?.[k]).filter(Number.isFinite));
}
function trimKey(trials, k) {
  return trimmed(trials.map((t) => t.forward?.[k]).filter(Number.isFinite));
}

// ─── load ───
const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

(async () => {
  console.log('================================================================');
  console.log('FlowLead v2 — 수급 선행·가격 미반응 모델 백테스트');
  console.log('================================================================');
  console.log(`daysBack=${DAYS_BACK}, forwardDays=${FORWARD_DAYS.join(',')}\n`);

  // ─── 1) 구 v2 백테스트 (baselineTrendRS) ───
  const t0 = Date.now();
  console.log('[1/3] 구 v2 백테스트 (baselineTrendRS) 호출…');
  const r = await ps.backtestTotalScore({
    daysBack: DAYS_BACK,
    forwardDays: [5, 20],
    entryMode: 'nextOpen',
    applyAtrStop: true,
    useFinancials: 'asOf',
    cacheDir: CHART_DIR,
  });
  console.log(`  → trendRS=${r.trendRSTrials.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const trendRSKeys = new Set(r.trendRSTrials.map((t) => `${t.code}|${t.date}`));

  // ─── 2) trial 수집 ───
  console.log('\n[2/3] trial 수집…');
  const codes = fs.readdirSync(FLOW_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

  const flowV2Trials = [];   // FlowLead v2 통과
  const matchedTrials = [];  // flowLeadV2Universe 만 통과 (수급 무관)
  const allTrials = [];      // 시총·거래대금만 통과
  const trendRSTrials = [];  // 구 v2 trendRS pool

  let scanned = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const meta = codeMeta.get(code) || {};
    if (meta.isSpecial || meta.isEtf) continue;
    if ((meta.marketValue || 0) < 100_000_000_000) continue;

    let flow;
    try { flow = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, `${code}.json`), 'utf-8')); } catch (_) { continue; }
    const flowRows = flow.rows || [];
    if (flowRows.length < 30) continue;

    const chartPath = path.join(CHART_DIR, `${code}.json`);
    if (!fs.existsSync(chartPath)) continue;
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8')); } catch (_) { continue; }
    const chartRows = chart.rows || [];
    if (chartRows.length < 80) continue;

    const flowDateSet = new Set(flowRows.map((r) => r.date));

    const N = chartRows.length;
    const startIdx = Math.max(60, N - DAYS_BACK);
    const maxFwd = Math.max(...FORWARD_DAYS);

    for (let t = startIdx; t < N - maxFwd - 1; t++) {
      const today = chartRows[t];

      // 거래대금 필터 (allTrials 기본 universe — 시총은 위에서 통과)
      const start20 = Math.max(0, t - 19);
      const last20 = chartRows.slice(start20, t + 1);
      const avg20Value = last20.reduce((s, x) => s + (x.valueApprox || 0), 0) / Math.max(last20.length, 1);
      if (avg20Value < 5_000_000_000) continue;

      // forward
      const forward = {};
      for (const fwd of FORWARD_DAYS) {
        const fut = chartRows[t + fwd];
        if (!fut || !(today.close > 0) || !(fut.close > 0)) continue;
        forward[`d${fwd}`] = fut.close / today.close - 1;
      }
      if (!Number.isFinite(forward.d5)) continue;

      const baseTrial = {
        code, date: today.date,
        market: meta.market,
        marketCap: meta.marketValue,
        avg20Value, forward,
      };
      allTrials.push(baseTrial);
      scanned++;

      if (trendRSKeys.has(`${code}|${today.date}`)) trendRSTrials.push(baseTrial);

      // matched baseline — flowLeadV2Universe 통과만
      const chartsUpTo = chartRows.slice(0, t + 1);
      let universeOk = false;
      try {
        const u = ps.flowLeadV2Universe(chartsUpTo, meta);
        universeOk = u && u.passed;
      } catch (_) {}
      if (!universeOk) continue;
      matchedTrials.push(baseTrial);

      // FlowLead v2 — flow 기반 추가 score
      if (!flowDateSet.has(today.date)) continue;
      const flowsUpTo = flowRows.filter((f) => f.date <= today.date);
      if (flowsUpTo.length < 20) continue;

      let sc;
      try { sc = ps.calculateFlowLeadScoreV2(chartsUpTo, flowsUpTo, meta); } catch (_) { sc = null; }
      if (!sc || !sc.passed) continue;

      flowV2Trials.push({
        ...baseTrial,
        score: sc.score,
        breakdown: sc.breakdown,
        signals: sc.signals,
      });
    }

    if ((i + 1) % 50 === 0 || i === codes.length - 1) {
      console.log(`  ${i + 1}/${codes.length}: scanned=${scanned}, all=${allTrials.length}, matched=${matchedTrials.length}, flowV2=${flowV2Trials.length}`);
    }
  }
  console.log(`\n→ allTrials=${allTrials.length}, trendRSTrials=${trendRSTrials.length}, matched=${matchedTrials.length}, flowV2=${flowV2Trials.length}`);

  // ─── 3) regime ───
  console.log('\n[3/3] 그룹 분석…');
  const monthOf = (d) => String(d).slice(0, 6);
  const monthMap = new Map();
  for (const tr of allTrials) {
    if (!Number.isFinite(tr.forward.d5)) continue;
    const m = monthOf(tr.date);
    if (!monthMap.has(m)) monthMap.set(m, []);
    monthMap.get(m).push(tr.forward.d5);
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
  for (const arr of [allTrials, trendRSTrials, matchedTrials, flowV2Trials]) {
    for (const tr of arr) tr.regime = monthRegime.get(monthOf(tr.date)) || 'unknown';
  }

  // ─── 출력 헬퍼 ───
  function compareTab(filter, fwd) {
    const flow = flowV2Trials.filter(filter);
    const matched = matchedTrials.filter(filter);
    const trs = trendRSTrials.filter(filter);
    const all = allTrials.filter(filter);
    const k = `d${fwd}`;
    return [
      row('FlowLead v2',      aggKey(flow, k),    trimKey(flow, k)),
      row('matchedBaseline',  aggKey(matched, k), trimKey(matched, k)),
      row('baselineTrendRS',  aggKey(trs, k),     trimKey(trs, k)),
      row('baselineAll',      aggKey(all, k),     trimKey(all, k)),
    ];
  }

  // 1. 전체 d5/d10/d20
  console.log('\n\n## 1. 전체 d5/d10/d20 (raw + winsorize 5%)');
  for (const fwd of FORWARD_DAYS) {
    console.log(`\n### d${fwd}`);
    console.table(compareTab(() => true, fwd));
  }

  // 2. score bucket × d10
  console.log('\n\n## 2. score bucket × d10 (FlowLead v2 만)');
  const buckets = [
    ['70+',    (t) => t.score >= 70],
    ['60-69',  (t) => t.score >= 60 && t.score < 70],
    ['50-59',  (t) => t.score >= 50 && t.score < 60],
    ['<50',    (t) => t.score < 50],
  ];
  const bRows = buckets.map(([lab, f]) => {
    const ts = flowV2Trials.filter(f);
    return row(lab, aggKey(ts, 'd10'), trimKey(ts, 'd10'));
  });
  bRows.push(row('matchedBaseline', aggKey(matchedTrials, 'd10'), trimKey(matchedTrials, 'd10')));
  console.table(bRows);

  // 2b. score bucket × d20
  console.log('\n## 2b. score bucket × d20 (FlowLead v2 만)');
  const bRows20 = buckets.map(([lab, f]) => {
    const ts = flowV2Trials.filter(f);
    return row(lab, aggKey(ts, 'd20'), trimKey(ts, 'd20'));
  });
  bRows20.push(row('matchedBaseline', aggKey(matchedTrials, 'd20'), trimKey(matchedTrials, 'd20')));
  console.table(bRows20);

  // 3. regime × d10/d20
  console.log('\n\n## 3. regime × d10');
  for (const reg of ['bull', 'bear', 'sideways']) {
    console.log(`\n### ${reg}`);
    console.table(compareTab((t) => t.regime === reg, 10));
  }
  console.log('\n## 3b. regime × d20');
  for (const reg of ['bull', 'bear', 'sideways']) {
    console.log(`\n### ${reg}`);
    console.table(compareTab((t) => t.regime === reg, 20));
  }

  // 4. market × d10/d20
  console.log('\n\n## 4. market × d10');
  for (const m of ['KOSPI', 'KOSDAQ']) {
    console.log(`\n### ${m}`);
    console.table(compareTab((t) => t.market === m, 10));
  }
  console.log('\n## 4b. market × d20');
  for (const m of ['KOSPI', 'KOSDAQ']) {
    console.log(`\n### ${m}`);
    console.table(compareTab((t) => t.market === m, 20));
  }

  // 5. topN × d10/d20 — 매일 score 상위 N 진입
  console.log('\n\n## 5. topN — 매일 score 상위 N 진입');
  const byDate = new Map();
  for (const tr of flowV2Trials) {
    if (!byDate.has(tr.date)) byDate.set(tr.date, []);
    byDate.get(tr.date).push(tr);
  }
  const topNResults = [];
  for (const N of [5, 10, 20]) {
    const picks = [];
    for (const [, arr] of byDate) {
      const sorted = [...arr].sort((a, b) => b.score - a.score).slice(0, N);
      picks.push(...sorted);
    }
    topNResults.push({ group: `top${N} d10`, ...summarize(picks.map((t) => t.forward.d10).filter(Number.isFinite)) });
    topNResults.push({ group: `top${N} d20`, ...summarize(picks.map((t) => t.forward.d20).filter(Number.isFinite)) });
  }
  topNResults.push({ group: 'matched d10', ...aggKey(matchedTrials, 'd10') });
  topNResults.push({ group: 'matched d20', ...aggKey(matchedTrials, 'd20') });
  console.table(topNResults);

  // 6. 판정 — FlowLead v2 vs matchedBaseline (핵심) + vs baselineTrendRS
  console.log('\n\n================================================================');
  console.log('## 판정 — FlowLead v2 (핵심: vs matchedBaseline)');
  console.log('================================================================');

  function dominates(a, b) {
    if (!a || !b) return false;
    return a.mean > b.mean && a.median > b.median && a.pf > b.pf && a.win > b.win;
  }
  function compareDetail(a, b, fwd, lblB) {
    if (!a || !b) return `  d${fwd}: 표본 부족`;
    const wins = [
      ['mean',   a.mean   > b.mean],
      ['median', a.median > b.median],
      ['PF',     a.pf     > b.pf],
      ['win%',   a.win    > b.win],
    ];
    const okCount = wins.filter(([, v]) => v).length;
    const detail = wins.map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join(' ');
    return `  d${fwd}: ${detail}  (${okCount}/4)  | FL v2 n=${a.n} mean=${a.mean}% med=${a.median}% PF=${a.pf} win=${a.win}%   vs   ${lblB} n=${b.n} mean=${b.mean}% med=${b.median}% PF=${b.pf} win=${b.win}%`;
  }

  const flowD5 = aggKey(flowV2Trials, 'd5');
  const flowD10 = aggKey(flowV2Trials, 'd10');
  const flowD20 = aggKey(flowV2Trials, 'd20');
  const matD5 = aggKey(matchedTrials, 'd5');
  const matD10 = aggKey(matchedTrials, 'd10');
  const matD20 = aggKey(matchedTrials, 'd20');
  const trsD5 = aggKey(trendRSTrials, 'd5');
  const trsD10 = aggKey(trendRSTrials, 'd10');
  const trsD20 = aggKey(trendRSTrials, 'd20');

  console.log('\n### vs matchedBaseline (가장 공정한 비교):');
  console.log(compareDetail(flowD5, matD5, 5, 'matched'));
  console.log(compareDetail(flowD10, matD10, 10, 'matched'));
  console.log(compareDetail(flowD20, matD20, 20, 'matched'));

  console.log('\n### vs baselineTrendRS (참고):');
  console.log(compareDetail(flowD5, trsD5, 5, 'trendRS'));
  console.log(compareDetail(flowD10, trsD10, 10, 'trendRS'));
  console.log(compareDetail(flowD20, trsD20, 20, 'trendRS'));

  // regime별 vs matchedBaseline d10/d20
  console.log('\n### regime별 vs matchedBaseline (d10 / d20 동시 4지표 우위):');
  for (const reg of ['bull', 'bear', 'sideways']) {
    const fr = flowV2Trials.filter((t) => t.regime === reg);
    const mr = matchedTrials.filter((t) => t.regime === reg);
    const f10 = aggKey(fr, 'd10'), m10 = aggKey(mr, 'd10');
    const f20 = aggKey(fr, 'd20'), m20 = aggKey(mr, 'd20');
    const p10 = dominates(f10, m10);
    const p20 = dominates(f20, m20);
    console.log(`\n  [${reg}] d10/d20 4지표 동시 우위: ${p10 && p20 ? '✅' : '✗'}`);
    console.log(compareDetail(f10, m10, 10, 'matched'));
    console.log(compareDetail(f20, m20, 20, 'matched'));
  }

  // ─── 결론 ───
  console.log('\n\n================================================================');
  console.log('## 최종 결론 (vs matchedBaseline)');
  console.log('================================================================');
  const corePassD10 = dominates(flowD10, matD10);
  const corePassD20 = dominates(flowD20, matD20);

  const regimePassed = [];
  for (const reg of ['bull', 'bear', 'sideways']) {
    const fr = flowV2Trials.filter((t) => t.regime === reg);
    const mr = matchedTrials.filter((t) => t.regime === reg);
    const f10 = aggKey(fr, 'd10'), m10 = aggKey(mr, 'd10');
    const f20 = aggKey(fr, 'd20'), m20 = aggKey(mr, 'd20');
    if (dominates(f10, m10) && dominates(f20, m20)) regimePassed.push(reg);
  }

  let conclusion;
  if (corePassD10 && corePassD20) {
    conclusion = '✅ FlowLead v2 채택 가능 — 전체 d10/d20 모두 matchedBaseline 대비 mean+median+PF+win 4지표 동시 우위';
  } else if (regimePassed.length > 0) {
    conclusion = `⚠️ 특정 regime 에서만 제한 사용 (${regimePassed.join(', ')}) — 전체로는 우위 없음`;
  } else if ((flowD10?.n ?? 0) >= 100) {
    conclusion = '🚨 후보 수는 나오지만 알파 없음 — 가설 자체 재검토 필요';
  } else {
    conclusion = '🚨 모델 재설계 필요 — 후보 수 부족';
  }
  console.log('\n  ' + conclusion);
  console.log(`\n  (전체 d10 4지표 우위: ${corePassD10 ? 'YES' : 'NO'}, d20: ${corePassD20 ? 'YES' : 'NO'}, regime 통과: ${regimePassed.length > 0 ? regimePassed.join('/') : 'none'})`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
