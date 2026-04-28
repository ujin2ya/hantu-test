// Phase 6 — Korea Flow Lead Model 백테스트
//
// 비교 대상:
//   - FlowLead (calculateFlowLeadScore 통과)
//   - baselineAll (universe 필터 통과 모든 시점)
//   - baselineTrendRS (구 v2 의 TrendTemplate + RS 통과)
//   - Bull Trend Model (= 구 v2 setupScore ≥ 75 + entryReady — 격하된 옛 모델)
//
// 그룹 분리:
//   - score bucket (90+/80-89/70-79/60-69/50-59/<50)
//   - regime (bull/bear/sideways)
//   - market (KOSPI/KOSDAQ)
//   - 시총 구간 (1000-3000억/3000억-1조/1조+)
//   - 거래대금 구간 (50-100억/100-300억/300억+)
//   - winsorize 5%
//
// forward = close-to-close (단순화 — 4 모델 비교 일관성)

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const FORWARD_DAYS = [1, 5, 20];
const DAYS_BACK = 700;

// ─── stats helpers ───
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

// ─── load ───
const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

(async () => {
  console.log('================================================================');
  console.log('Phase 6 — Korea Flow Lead Model 백테스트');
  console.log('================================================================');
  console.log(`daysBack=${DAYS_BACK}, forwardDays=${FORWARD_DAYS.join(',')}\n`);

  // ─── 1) 구 v2 backtest 호출 — TrendRS pool + Bull Trend (setupScore ≥ 75 + entryReady) ───
  const t0 = Date.now();
  console.log('[1/3] 구 v2 백테스트 (baselineTrendRS + Bull Trend Model) 호출…');
  const r = await ps.backtestTotalScore({
    daysBack: DAYS_BACK,
    forwardDays: FORWARD_DAYS,
    entryMode: 'nextOpen',
    applyAtrStop: true,
    useFinancials: 'asOf',
    cacheDir: CHART_DIR,
  });
  console.log(`  → trendRS=${r.trendRSTrials.length}, allScored=${r.allScored.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // 키 매핑 (code|date → trial)
  function keyOf(t) { return `${t.code}|${t.date}`; }
  const trendRSByKey = new Map();
  for (const t of r.trendRSTrials) trendRSByKey.set(keyOf(t), t);
  const bullTrendByKey = new Map();
  for (const t of r.allScored) {
    if (t.setupScore >= 75 && t.entryReady) bullTrendByKey.set(keyOf(t), t);
  }

  // ─── 2) FlowLead trial 수집 (close-to-close forward) ───
  console.log('\n[2/3] FlowLead trial 수집…');
  const codes = fs.readdirSync(FLOW_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

  const flowTrials = [];
  const allTrials = [];   // baselineAll (close-to-close)
  const trendRSCloseTrials = [];   // trendRS pool 이지만 close-to-close forward 로
  const bullTrendCloseTrials = []; // Bull Trend Model (close-to-close)

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
    if (chartRows.length < 80) continue;

    // flow date set for filtering
    const flowDateSet = new Set(flowRows.map((r) => r.date));

    const N = chartRows.length;
    const startIdx = Math.max(60, N - DAYS_BACK);
    const maxFwd = Math.max(...FORWARD_DAYS);

    for (let t = startIdx; t < N - maxFwd - 1; t++) {
      const today = chartRows[t];
      // universe — avg20Value
      const start20 = Math.max(0, t - 19);
      const last20 = chartRows.slice(start20, t + 1);
      const avg20Value = last20.reduce((s, x) => s + (x.valueApprox || 0), 0) / Math.max(last20.length, 1);
      if (avg20Value < 5_000_000_000) continue;

      // forward (close-to-close)
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

      // FlowLead — flow row 가 today.date 까지 있고 20일 이상이어야
      if (!flowDateSet.has(today.date)) continue;
      const flowsUpTo = flowRows.filter((f) => f.date <= today.date);
      if (flowsUpTo.length < 20) continue;
      const chartsUpTo = chartRows.slice(0, t + 1);

      let score;
      try {
        score = ps.calculateFlowLeadScore(chartsUpTo, flowsUpTo, meta);
      } catch (_) { score = null; }
      if (!score || !score.passed) continue;

      flowTrials.push({
        ...baseTrial,
        score: score.score,
        breakdown: score.breakdown,
        signals: score.signals,
      });
    }

    if ((i + 1) % 50 === 0 || i === codes.length - 1) {
      console.log(`  ${i + 1}/${codes.length}: scanned=${scanned}, all=${allTrials.length}, flow=${flowTrials.length}`);
    }
  }

  console.log(`\n→ allTrials=${allTrials.length}, trendRSClose=${trendRSCloseTrials.length}, bullTrendClose=${bullTrendCloseTrials.length}, flowTrials=${flowTrials.length}`);

  // ─── 3) 월별 regime 정의 (allTrials d5 mean 기준) ───
  console.log('\n[3/3] 그룹 분석 출력…');
  const monthOf = (d) => String(d).slice(0, 6);
  const monthMap = new Map();
  for (const t of allTrials) {
    if (!Number.isFinite(t.forward.d5)) continue;
    const m = monthOf(t.date);
    if (!monthMap.has(m)) monthMap.set(m, []);
    monthMap.get(m).push(t.forward.d5);
  }
  const monthRegime = new Map();
  console.log('\n## 월별 baselineAll d5 평균 — regime 정의');
  for (const m of [...monthMap.keys()].sort()) {
    const arr = monthMap.get(m);
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    let regime = 'sideways';
    if (mean > 0.02) regime = 'bull';
    else if (mean < -0.01) regime = 'bear';
    monthRegime.set(m, regime);
    console.log(`  ${m}: n=${arr.length}, mean=${(mean * 100).toFixed(2)}% → ${regime}`);
  }
  for (const arr of [allTrials, trendRSCloseTrials, bullTrendCloseTrials, flowTrials]) {
    for (const t of arr) t.regime = monthRegime.get(monthOf(t.date)) || 'unknown';
  }

  // ─── 출력 헬퍼 ───
  function compareTab(filter, fwd) {
    const flow = flowTrials.filter(filter);
    const all = allTrials.filter(filter);
    const trs = trendRSCloseTrials.filter(filter);
    const bull = bullTrendCloseTrials.filter(filter);
    const k = `d${fwd}`;
    return [
      row('FlowLead',         aggKey(flow, k), trimKey(flow, k)),
      row('Bull Trend Model', aggKey(bull, k), trimKey(bull, k)),
      row('baselineTrendRS',  aggKey(trs, k)),
      row('baselineAll',      aggKey(all, k)),
    ];
  }

  // 1. 전체 d1/d5/d20
  console.log('\n\n## 1. 전체 d1/d5/d20');
  for (const fwd of FORWARD_DAYS) {
    console.log(`\n### d${fwd}`);
    console.table(compareTab(() => true, fwd));
  }

  // 2. score bucket × d1/d5/d20
  console.log('\n\n## 2. score bucket — FlowLead');
  for (const fwd of FORWARD_DAYS) {
    console.log(`\n### d${fwd}`);
    const buckets = [
      ['90+',    (t) => t.score >= 90],
      ['80-89',  (t) => t.score >= 80 && t.score < 90],
      ['70-79',  (t) => t.score >= 70 && t.score < 80],
      ['60-69',  (t) => t.score >= 60 && t.score < 70],
      ['<60',    (t) => t.score < 60],
    ];
    const rows = buckets.map(([lab, f]) => {
      const ts = flowTrials.filter(f);
      return row(lab, aggKey(ts, `d${fwd}`), trimKey(ts, `d${fwd}`));
    });
    rows.push(row('baselineAll', aggKey(allTrials, `d${fwd}`)));
    console.table(rows);
  }

  // 3. regime × d5
  console.log('\n\n## 3. regime × d5');
  for (const reg of ['bull', 'bear', 'sideways']) {
    console.log(`\n### ${reg}`);
    console.table(compareTab((t) => t.regime === reg, 5));
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

  // 7. winsorize 5% 비교 (전체)
  console.log('\n\n## 7. winsorize 5% — 전체 d1/d5/d20');
  for (const fwd of FORWARD_DAYS) {
    const k = `d${fwd}`;
    console.log(`\n### d${fwd}`);
    console.table([
      row('FlowLead raw',         aggKey(flowTrials, k)),
      row('FlowLead 5%',          trimKey(flowTrials, k)),
      row('Bull Trend raw',       aggKey(bullTrendCloseTrials, k)),
      row('Bull Trend 5%',        trimKey(bullTrendCloseTrials, k)),
      row('baselineTrendRS raw',  aggKey(trendRSCloseTrials, k)),
      row('baselineAll raw',      aggKey(allTrials, k)),
      row('baselineAll 5%',       trimKey(allTrials, k)),
    ]);
  }

  // 8. 판정 — 사용자 요구
  //    기준: FlowLead vs baselineTrendRS — d5 와 d20 모두 mean+median+PF+win 4지표 동시 우위
  //    Bull Trend Model 은 비교/분석용 (매수 모델 아님 — 격하)
  //    결론 4가지 중 하나:
  //      ✅ FlowLead 채택 가능
  //      ⚠️ 특정 regime 에서만 제한 사용
  //      🚨 후보는 나오지만 알파 없음
  //      🚨 모델 재설계 필요
  console.log('\n\n================================================================');
  console.log('## 판정 — FlowLead vs baselineTrendRS');
  console.log('================================================================');

  function dominates(a, b) {
    if (!a || !b) return false;
    return a.mean > b.mean && a.median > b.median && a.pf > b.pf && a.win > b.win;
  }
  function compareDetail(a, b, fwd) {
    if (!a || !b) return `  d${fwd}: 표본 부족`;
    const wins = [
      ['mean',   a.mean   > b.mean],
      ['median', a.median > b.median],
      ['PF',     a.pf     > b.pf],
      ['win%',   a.win    > b.win],
    ];
    const okCount = wins.filter(([, v]) => v).length;
    const detail = wins.map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join(' ');
    return `  d${fwd}: ${detail}  (${okCount}/4)  | FL n=${a.n} mean=${a.mean}% med=${a.median}% PF=${a.pf} win=${a.win}%   vs   trsRS n=${b.n} mean=${b.mean}% med=${b.median}% PF=${b.pf} win=${b.win}%`;
  }

  const flowD5 = aggKey(flowTrials, 'd5');
  const flowD20 = aggKey(flowTrials, 'd20');
  const trsD5 = aggKey(trendRSCloseTrials, 'd5');
  const trsD20 = aggKey(trendRSCloseTrials, 'd20');

  console.log('\n전체 (FlowLead vs baselineTrendRS):');
  console.log(compareDetail(flowD5, trsD5, 5));
  console.log(compareDetail(flowD20, trsD20, 20));

  const fullPassD5 = dominates(flowD5, trsD5);
  const fullPassD20 = dominates(flowD20, trsD20);

  // regime별 — 어느 regime 에서 4지표 모두 우위?
  console.log('\nRegime 별 (d5 / d20 동시 4지표 우위 여부):');
  const regimeResults = [];
  for (const reg of ['bull', 'bear', 'sideways']) {
    const fr = flowTrials.filter((t) => t.regime === reg);
    const tr = trendRSCloseTrials.filter((t) => t.regime === reg);
    const f5 = aggKey(fr, 'd5'), t5 = aggKey(tr, 'd5');
    const f20 = aggKey(fr, 'd20'), t20 = aggKey(tr, 'd20');
    const p5 = dominates(f5, t5);
    const p20 = dominates(f20, t20);
    const ok = p5 && p20;
    regimeResults.push({ reg, p5, p20, ok, f5, f20, t5, t20 });
    console.log(`\n  [${reg}] d5/d20 4지표 동시 우위: ${ok ? '✅' : '✗'}`);
    console.log(compareDetail(f5, t5, 5));
    console.log(compareDetail(f20, t20, 20));
  }
  const regimePassed = regimeResults.filter((r) => r.ok).map((r) => r.reg);

  // ─── 결론 ───
  console.log('\n\n================================================================');
  console.log('## 최종 결론');
  console.log('================================================================');
  let conclusion;
  if (fullPassD5 && fullPassD20) {
    conclusion = '✅ FlowLead 채택 가능 — 전체 d5/d20 모두 baselineTrendRS 대비 mean+median+PF+win 4지표 동시 우위';
  } else if (regimePassed.length > 0) {
    conclusion = `⚠️ 특정 regime 에서만 제한 사용 (${regimePassed.join(', ')}) — 전체로는 우위 없음, 해당 regime 에서만 4지표 동시 우위`;
  } else if ((flowD5?.n ?? 0) >= 100) {
    conclusion = '🚨 후보는 나오지만 알파 없음 — n 충분하지만 baselineTrendRS 대비 우위 무. 가설 (수급 선행 + 가격 미과열) 자체 재검토 필요';
  } else {
    conclusion = '🚨 모델 재설계 필요 — 후보 수 부족 (n<100) 또는 통계적 의미 확보 불가';
  }
  console.log('\n  ' + conclusion);
  console.log(`\n  (전체 d5 4지표 우위: ${fullPassD5 ? 'YES' : 'NO'}, 전체 d20 4지표 우위: ${fullPassD20 ? 'YES' : 'NO'}, regime 통과: ${regimePassed.length > 0 ? regimePassed.join('/') : 'none'})`);

  // 참고 — 옛 Bull Trend Model (격하, 매수 모델 아님)
  const bullD5 = aggKey(bullTrendCloseTrials, 'd5');
  const bullD20 = aggKey(bullTrendCloseTrials, 'd20');
  console.log('\n참고 — Bull Trend Model (옛 v2 격하, 비교/분석용):');
  console.log(`  d5  : n=${bullD5?.n} mean=${bullD5?.mean}% PF=${bullD5?.pf} win=${bullD5?.win}%`);
  console.log(`  d20 : n=${bullD20?.n} mean=${bullD20?.mean}% PF=${bullD20?.pf} win=${bullD20?.win}%`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
