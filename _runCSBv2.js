// CompressionSupportBreakout v2 백테스트
//
// v1 → v2 변경:
//   - 시총 500억+ (v1 1000억) → 시총 구간 4개 분리 출력 (500-1000억 / 1000-3000억 / 3000억-1조 / 1조+)
//   - 압축 ≤0.9 / 거래대금 ≥1.0 / 고점거리 ≤10% (조건 완화)
//   - sweet spot 점수 (compressionRatio 0.55~0.75 최고 등)
//   - n 목표 1000+
//   - 500-1000억 별도 위험 메트릭 (worst 분리)

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const FORWARD_DAYS = [5, 10, 20, 40];
const MFE_DAYS = [10, 20, 40];
const HIT_DAYS = [10, 20, 40];
const HIT_THRESHOLDS = [0.10, 0.20];
const DAYS_BACK = 700;

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
function aggKey(trials, k) { return summarize(trials.map((t) => t.forward?.[k]).filter(Number.isFinite)); }
function trimKey(trials, k) { return trimmed(trials.map((t) => t.forward?.[k]).filter(Number.isFinite)); }
function hitRate(trials, k) {
  const arr = trials.map((t) => t.forward?.[k]).filter((v) => v === true || v === false);
  if (!arr.length) return null;
  const hits = arr.filter((v) => v === true).length;
  return { n: arr.length, rate: Math.round((hits / arr.length) * 100) };
}
function mcGroup(mc) {
  if (mc >= 1_000_000_000_000) return '1조+';
  if (mc >= 300_000_000_000) return '3000억-1조';
  if (mc >= 100_000_000_000) return '1000-3000억';
  if (mc >= 50_000_000_000) return '500-1000억';
  return '<500억';
}
function tvGroup(v) {
  if (v >= 30_000_000_000) return '300억+';
  if (v >= 10_000_000_000) return '100-300억';
  return '50-100억';
}

const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

(async () => {
  console.log('================================================================');
  console.log('CSB v2 — 조건 완화 + sweet spot 점수 + 시총 500억 universe');
  console.log('================================================================');
  console.log(`daysBack=${DAYS_BACK}, forwardDays=${FORWARD_DAYS.join(',')}\n`);

  const t0 = Date.now();
  console.log('[1/3] 구 v2 백테스트 호출…');
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

  console.log('\n[2/3] trial 수집…');
  const codes = fs.readdirSync(FLOW_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

  const csbTrials = [];
  const compressionTrials = [];
  const allTrials = [];
  const trendRSTrials = [];

  let scanned = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const meta = codeMeta.get(code) || {};
    if (meta.isSpecial || meta.isEtf) continue;
    if ((meta.marketValue || 0) < 50_000_000_000) continue; // 500억+

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
      const start20 = Math.max(0, t - 19);
      const last20 = chartRows.slice(start20, t + 1);
      const avg20Value = last20.reduce((s, x) => s + (x.valueApprox || 0), 0) / Math.max(last20.length, 1);
      if (avg20Value < 5_000_000_000) continue;

      const close = today.close;
      if (!(close > 0)) continue;

      const forward = {};
      for (const fwd of FORWARD_DAYS) {
        const fut = chartRows[t + fwd];
        if (fut && fut.close > 0) forward[`d${fwd}`] = fut.close / close - 1;
      }
      if (!Number.isFinite(forward.d5)) continue;

      // MFE
      let runningMaxHigh = 0;
      let prevWindowEnd = t;
      for (const win of MFE_DAYS) {
        for (let j = prevWindowEnd + 1; j <= t + win; j++) {
          const r2 = chartRows[j];
          if (!r2) break;
          const h = r2.high || r2.close;
          if (h > runningMaxHigh) runningMaxHigh = h;
        }
        prevWindowEnd = t + win;
        forward[`mfe${win}`] = runningMaxHigh > 0 ? runningMaxHigh / close - 1 : null;
      }
      // hit rate
      let maxSoFar = 0;
      const hitsAt = {};
      for (let j = t + 1; j <= t + Math.max(...HIT_DAYS); j++) {
        const r2 = chartRows[j];
        if (!r2) break;
        const h = r2.high || r2.close;
        if (h > maxSoFar) maxSoFar = h;
        const ret = maxSoFar / close - 1;
        for (const thr of HIT_THRESHOLDS) {
          if (hitsAt[thr] == null && ret >= thr) hitsAt[thr] = j - t;
        }
      }
      for (const win of HIT_DAYS) {
        for (const thr of HIT_THRESHOLDS) {
          if (thr === 0.20 && win < 20) continue;
          const k = `hit${win}_${Math.round(thr * 100)}pct`;
          forward[k] = hitsAt[thr] != null && hitsAt[thr] <= win;
        }
      }

      const baseTrial = {
        code, date: today.date,
        market: meta.market,
        marketCap: meta.marketValue,
        avg20Value, forward,
      };
      allTrials.push(baseTrial);
      scanned++;
      if (trendRSKeys.has(`${code}|${today.date}`)) trendRSTrials.push(baseTrial);

      const chartsUpTo = chartRows.slice(0, t + 1);

      let compPass = false;
      try {
        const u3 = ps.flowLeadV3CompressionUniverse(chartsUpTo, meta);
        compPass = u3 && u3.passed;
      } catch (_) {}
      if (compPass) compressionTrials.push(baseTrial);

      let csbPass = false;
      try {
        const ucsb = ps.compressionSupportBreakoutUniverseV2(chartsUpTo, meta);
        csbPass = ucsb && ucsb.passed;
      } catch (_) {}
      if (!csbPass) continue;

      let flowsUpTo = null;
      if (flowDateSet.has(today.date)) {
        flowsUpTo = flowRows.filter((f) => f.date <= today.date);
        if (flowsUpTo.length < 20) flowsUpTo = null;
      }
      let sc;
      try { sc = ps.calculateCompressionSupportBreakoutScoreV2(chartsUpTo, flowsUpTo, meta); } catch (_) { sc = null; }
      if (!sc || !sc.passed) continue;

      csbTrials.push({
        ...baseTrial,
        score: sc.score,
        breakdown: sc.breakdown,
        stage: sc.stage,
        signals: sc.signals,
      });
    }

    if ((i + 1) % 50 === 0 || i === codes.length - 1) {
      console.log(`  ${i + 1}/${codes.length}: scanned=${scanned}, all=${allTrials.length}, comp=${compressionTrials.length}, csb=${csbTrials.length}`);
    }
  }
  console.log(`\n→ all=${allTrials.length}, trendRS=${trendRSTrials.length}, comp=${compressionTrials.length}, csb=${csbTrials.length}`);

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
  for (const arr of [allTrials, trendRSTrials, compressionTrials, csbTrials]) {
    for (const tr of arr) tr.regime = monthRegime.get(monthOf(tr.date)) || 'unknown';
  }

  function compareTab(filter, fwdKey) {
    const csb = csbTrials.filter(filter);
    const comp = compressionTrials.filter(filter);
    const trs = trendRSTrials.filter(filter);
    const all = allTrials.filter(filter);
    return [
      row('CSB v2',              aggKey(csb, fwdKey),  trimKey(csb, fwdKey)),
      row('compressionBaseline', aggKey(comp, fwdKey), trimKey(comp, fwdKey)),
      row('baselineTrendRS',     aggKey(trs, fwdKey),  trimKey(trs, fwdKey)),
      row('baselineAll',         aggKey(all, fwdKey),  trimKey(all, fwdKey)),
    ];
  }

  // 1. close return d5/d10/d20/d40
  console.log('\n\n## 1. close return — d5/d10/d20/d40');
  for (const fwd of FORWARD_DAYS) {
    console.log(`\n### d${fwd}`);
    console.table(compareTab(() => true, `d${fwd}`));
  }

  // 2. MFE
  console.log('\n\n## 2. MFE — mfe10/20/40');
  for (const win of MFE_DAYS) {
    console.log(`\n### mfe${win}`);
    console.table(compareTab(() => true, `mfe${win}`));
  }

  // 3. hit rate
  console.log('\n\n## 3. Hit rate (% of trials reaching threshold within window)');
  const hitRows = [];
  for (const win of HIT_DAYS) {
    for (const thr of HIT_THRESHOLDS) {
      if (thr === 0.20 && win < 20) continue;
      const key = `hit${win}_${Math.round(thr * 100)}pct`;
      const csb = hitRate(csbTrials, key);
      const comp = hitRate(compressionTrials, key);
      const trs = hitRate(trendRSTrials, key);
      const all = hitRate(allTrials, key);
      hitRows.push({
        metric: `${win}d ≥+${Math.round(thr * 100)}%`,
        CSB_v2: `${csb?.rate}% (${csb?.n})`,
        comp: `${comp?.rate}% (${comp?.n})`,
        trendRS: `${trs?.rate}% (${trs?.n})`,
        all: `${all?.rate}% (${all?.n})`,
      });
    }
  }
  console.table(hitRows);

  // 4. score bucket
  console.log('\n\n## 4. score bucket — d20 + mfe20 + hit20_10pct');
  const buckets = [
    ['70+',    (t) => t.score >= 70],
    ['60-69',  (t) => t.score >= 60 && t.score < 70],
    ['50-59',  (t) => t.score >= 50 && t.score < 60],
    ['<50',    (t) => t.score < 50],
  ];
  const bRows = buckets.map(([lab, f]) => {
    const ts = csbTrials.filter(f);
    const d20 = aggKey(ts, 'd20');
    const mfe20 = aggKey(ts, 'mfe20');
    const hit10 = hitRate(ts, 'hit10_10pct');
    const hit20 = hitRate(ts, 'hit20_10pct');
    return {
      bucket: lab, n: d20?.n || 0,
      d20_mean: d20?.mean, d20_median: d20?.median, d20_win: d20?.win + '%',
      mfe20_mean: mfe20?.mean,
      hit10_10: hit10 ? `${hit10.rate}%` : null,
      hit20_10: hit20 ? `${hit20.rate}%` : null,
    };
  });
  bRows.push({
    bucket: 'compressionBaseline',
    n: compressionTrials.length,
    d20_mean: aggKey(compressionTrials, 'd20')?.mean,
    d20_median: aggKey(compressionTrials, 'd20')?.median,
    d20_win: aggKey(compressionTrials, 'd20')?.win + '%',
    mfe20_mean: aggKey(compressionTrials, 'mfe20')?.mean,
    hit10_10: hitRate(compressionTrials, 'hit10_10pct') ? `${hitRate(compressionTrials, 'hit10_10pct').rate}%` : null,
    hit20_10: hitRate(compressionTrials, 'hit20_10pct') ? `${hitRate(compressionTrials, 'hit20_10pct').rate}%` : null,
  });
  console.table(bRows);

  console.log('\n## 4b. score bucket — d40 + mfe40 + hit40_10/20pct');
  const bRows40 = buckets.map(([lab, f]) => {
    const ts = csbTrials.filter(f);
    const d40 = aggKey(ts, 'd40');
    const mfe40 = aggKey(ts, 'mfe40');
    const hit10 = hitRate(ts, 'hit40_10pct');
    const hit20 = hitRate(ts, 'hit40_20pct');
    return {
      bucket: lab, n: d40?.n || 0,
      d40_mean: d40?.mean, d40_median: d40?.median,
      mfe40_mean: mfe40?.mean,
      hit40_10: hit10 ? `${hit10.rate}%` : null,
      hit40_20: hit20 ? `${hit20.rate}%` : null,
    };
  });
  bRows40.push({
    bucket: 'compressionBaseline',
    n: compressionTrials.length,
    d40_mean: aggKey(compressionTrials, 'd40')?.mean,
    d40_median: aggKey(compressionTrials, 'd40')?.median,
    mfe40_mean: aggKey(compressionTrials, 'mfe40')?.mean,
    hit40_10: hitRate(compressionTrials, 'hit40_10pct') ? `${hitRate(compressionTrials, 'hit40_10pct').rate}%` : null,
    hit40_20: hitRate(compressionTrials, 'hit40_20pct') ? `${hitRate(compressionTrials, 'hit40_20pct').rate}%` : null,
  });
  console.table(bRows40);

  // 5. regime × d20 / mfe20
  console.log('\n\n## 5. regime × d20 / mfe20 / hit20_10pct');
  for (const reg of ['bull', 'bear', 'sideways']) {
    console.log(`\n### ${reg} d20`);
    console.table(compareTab((t) => t.regime === reg, 'd20'));
  }
  console.log('\n## 5b. regime hit rates');
  const regHits = [];
  for (const reg of ['bull', 'bear', 'sideways']) {
    const csbR = csbTrials.filter((t) => t.regime === reg);
    const compR = compressionTrials.filter((t) => t.regime === reg);
    const allR = allTrials.filter((t) => t.regime === reg);
    regHits.push({
      regime: reg,
      CSB_hit10: hitRate(csbR, 'hit10_10pct')?.rate + '%',
      CSB_hit20: hitRate(csbR, 'hit20_10pct')?.rate + '%',
      comp_hit10: hitRate(compR, 'hit10_10pct')?.rate + '%',
      comp_hit20: hitRate(compR, 'hit20_10pct')?.rate + '%',
      all_hit10: hitRate(allR, 'hit10_10pct')?.rate + '%',
      all_hit20: hitRate(allR, 'hit20_10pct')?.rate + '%',
    });
  }
  console.table(regHits);

  // 6. market × d20
  console.log('\n\n## 6. market × d20');
  for (const m of ['KOSPI', 'KOSDAQ']) {
    console.log(`\n### ${m}`);
    console.table(compareTab((t) => t.market === m, 'd20'));
  }

  // 7. 시총 구간 — 핵심
  console.log('\n\n## 7. 시총 구간 × d20 / mfe20 / hit20_10pct / worst');
  const mcGroups = ['500-1000억', '1000-3000억', '3000억-1조', '1조+'];
  const mcRows = mcGroups.map((grp) => {
    const csbG = csbTrials.filter((t) => mcGroup(t.marketCap) === grp);
    const allG = allTrials.filter((t) => mcGroup(t.marketCap) === grp);
    const d20 = aggKey(csbG, 'd20');
    const d40 = aggKey(csbG, 'd40');
    const mfe20 = aggKey(csbG, 'mfe20');
    const mfe40 = aggKey(csbG, 'mfe40');
    const hit10 = hitRate(csbG, 'hit10_10pct');
    const hit20 = hitRate(csbG, 'hit20_10pct');
    const allD20 = aggKey(allG, 'd20');
    return {
      mcGroup: grp,
      n: d20?.n || 0,
      d20_mean: d20?.mean,
      d20_median: d20?.median,
      d20_win: d20?.win + '%',
      d20_pf: d20?.pf,
      d20_worst: d20?.worst,
      d40_mean: d40?.mean,
      mfe20_mean: mfe20?.mean,
      mfe40_mean: mfe40?.mean,
      hit10_10: hit10 ? `${hit10.rate}%` : null,
      hit20_10: hit20 ? `${hit20.rate}%` : null,
      all_d20: allD20?.mean,
    };
  });
  console.table(mcRows);

  // 7b. 500-1000억 별도 위험 메트릭
  console.log('\n## 7b. 500-1000억 구간 — 위험 메트릭 별도 출력');
  const smallCap = csbTrials.filter((t) => t.marketCap >= 50_000_000_000 && t.marketCap < 100_000_000_000);
  const smallCapAll = allTrials.filter((t) => t.marketCap >= 50_000_000_000 && t.marketCap < 100_000_000_000);
  const sc20 = aggKey(smallCap, 'd20'), sc40 = aggKey(smallCap, 'd40');
  const scMfe20 = aggKey(smallCap, 'mfe20'), scMfe40 = aggKey(smallCap, 'mfe40');
  const scHit10 = hitRate(smallCap, 'hit10_10pct');
  const scHit20 = hitRate(smallCap, 'hit20_10pct');
  const scAllD20 = aggKey(smallCapAll, 'd20'), scAllD40 = aggKey(smallCapAll, 'd40');
  console.table([
    {
      metric: '500-1000억 CSB',
      n: sc20?.n || 0,
      d20_mean: sc20?.mean, d20_median: sc20?.median, d20_win: sc20?.win + '%',
      d20_pf: sc20?.pf, d20_worst: sc20?.worst,
      d40_mean: sc40?.mean, d40_worst: sc40?.worst,
      mfe20_mean: scMfe20?.mean, mfe40_mean: scMfe40?.mean,
      hit10: scHit10 ? `${scHit10.rate}%` : null,
      hit20: scHit20 ? `${scHit20.rate}%` : null,
    },
    {
      metric: '500-1000억 baselineAll',
      n: scAllD20?.n || 0,
      d20_mean: scAllD20?.mean, d20_median: scAllD20?.median, d20_win: scAllD20?.win + '%',
      d20_pf: scAllD20?.pf, d20_worst: scAllD20?.worst,
      d40_mean: scAllD40?.mean, d40_worst: scAllD40?.worst,
    },
  ]);

  // 8. 거래대금 구간
  console.log('\n\n## 8. 거래대금 구간 × d20');
  for (const grp of ['50-100억', '100-300억', '300억+']) {
    console.log(`\n### ${grp}`);
    console.table(compareTab((t) => tvGroup(t.avg20Value) === grp, 'd20'));
  }

  // 9. topN
  console.log('\n\n## 9. topN — 매일 score 상위 N (d20 + mfe20 + hit10/hit20)');
  const byDate = new Map();
  for (const tr of csbTrials) {
    if (!byDate.has(tr.date)) byDate.set(tr.date, []);
    byDate.get(tr.date).push(tr);
  }
  const topNRows = [];
  for (const N of [5, 10, 20]) {
    const picks = [];
    for (const [, arr] of byDate) {
      const sorted = [...arr].sort((a, b) => b.score - a.score).slice(0, N);
      picks.push(...sorted);
    }
    const d20 = aggKey(picks, 'd20'), d40 = aggKey(picks, 'd40');
    const mfe20 = aggKey(picks, 'mfe20'), mfe40 = aggKey(picks, 'mfe40');
    topNRows.push({
      group: `top${N}`,
      n: d20?.n || 0,
      d20_mean: d20?.mean, d20_win: d20?.win + '%',
      d40_mean: d40?.mean,
      mfe20_mean: mfe20?.mean, mfe40_mean: mfe40?.mean,
      hit10: hitRate(picks, 'hit10_10pct') ? `${hitRate(picks, 'hit10_10pct').rate}%` : null,
      hit20: hitRate(picks, 'hit20_10pct') ? `${hitRate(picks, 'hit20_10pct').rate}%` : null,
      hit40_10: hitRate(picks, 'hit40_10pct') ? `${hitRate(picks, 'hit40_10pct').rate}%` : null,
      hit40_20: hitRate(picks, 'hit40_20pct') ? `${hitRate(picks, 'hit40_20pct').rate}%` : null,
    });
  }
  topNRows.push({
    group: 'compression all',
    n: compressionTrials.length,
    d20_mean: aggKey(compressionTrials, 'd20')?.mean,
    d20_win: aggKey(compressionTrials, 'd20')?.win + '%',
    d40_mean: aggKey(compressionTrials, 'd40')?.mean,
    mfe20_mean: aggKey(compressionTrials, 'mfe20')?.mean,
    mfe40_mean: aggKey(compressionTrials, 'mfe40')?.mean,
    hit10: hitRate(compressionTrials, 'hit10_10pct') ? `${hitRate(compressionTrials, 'hit10_10pct').rate}%` : null,
    hit20: hitRate(compressionTrials, 'hit20_10pct') ? `${hitRate(compressionTrials, 'hit20_10pct').rate}%` : null,
    hit40_10: hitRate(compressionTrials, 'hit40_10pct') ? `${hitRate(compressionTrials, 'hit40_10pct').rate}%` : null,
    hit40_20: hitRate(compressionTrials, 'hit40_20pct') ? `${hitRate(compressionTrials, 'hit40_20pct').rate}%` : null,
  });
  console.table(topNRows);

  // ─── 성공 기준 체크 ───
  console.log('\n\n================================================================');
  console.log('## 성공 기준 체크');
  console.log('================================================================');

  const csbD20 = aggKey(csbTrials, 'd20'), allD20 = aggKey(allTrials, 'd20'), compD20 = aggKey(compressionTrials, 'd20');
  const csbD40 = aggKey(csbTrials, 'd40'), allD40 = aggKey(allTrials, 'd40'), compD40 = aggKey(compressionTrials, 'd40');
  const csbMfe20 = aggKey(csbTrials, 'mfe20'), allMfe20 = aggKey(allTrials, 'mfe20'), compMfe20 = aggKey(compressionTrials, 'mfe20');
  const csbMfe40 = aggKey(csbTrials, 'mfe40'), allMfe40 = aggKey(allTrials, 'mfe40'), compMfe40 = aggKey(compressionTrials, 'mfe40');
  const csbHit10 = hitRate(csbTrials, 'hit10_10pct'), allHit10 = hitRate(allTrials, 'hit10_10pct');
  const csbHit20 = hitRate(csbTrials, 'hit20_10pct'), allHit20 = hitRate(allTrials, 'hit20_10pct');
  const csbHit40 = hitRate(csbTrials, 'hit40_10pct'), allHit40 = hitRate(allTrials, 'hit40_10pct');

  console.log('\n[1] d20/d40/MFE20/MFE40 baseline 우위:');
  console.log(`  d20:   CSB ${csbD20?.mean}% vs comp ${compD20?.mean}% / all ${allD20?.mean}%`);
  console.log(`  d40:   CSB ${csbD40?.mean}% vs comp ${compD40?.mean}% / all ${allD40?.mean}%`);
  console.log(`  mfe20: CSB ${csbMfe20?.mean}% vs comp ${compMfe20?.mean}% / all ${allMfe20?.mean}%`);
  console.log(`  mfe40: CSB ${csbMfe40?.mean}% vs comp ${compMfe40?.mean}% / all ${allMfe40?.mean}%`);

  console.log('\n[2] hit10/hit20 baseline 개선:');
  console.log(`  hit10_+10%: CSB ${csbHit10?.rate}% vs all ${allHit10?.rate}%`);
  console.log(`  hit20_+10%: CSB ${csbHit20?.rate}% vs all ${allHit20?.rate}%`);
  console.log(`  hit40_+10%: CSB ${csbHit40?.rate}% vs all ${allHit40?.rate}%`);

  console.log('\n[3] score bucket 단조 — d20 mean by bucket:');
  for (const [lab, f] of buckets) {
    const ts = csbTrials.filter(f);
    const d20 = aggKey(ts, 'd20');
    const mfe20 = aggKey(ts, 'mfe20');
    const hit20 = hitRate(ts, 'hit20_10pct');
    console.log(`  ${lab}: n=${d20?.n} d20=${d20?.mean}% mfe20=${mfe20?.mean}% hit20=${hit20?.rate}%`);
  }

  console.log('\n[4] sideways 비교:');
  const csbSide = csbTrials.filter((t) => t.regime === 'sideways');
  const allSide = allTrials.filter((t) => t.regime === 'sideways');
  const compSide = compressionTrials.filter((t) => t.regime === 'sideways');
  console.log(`  sideways d20: CSB ${aggKey(csbSide, 'd20')?.mean}% vs comp ${aggKey(compSide, 'd20')?.mean}% / all ${aggKey(allSide, 'd20')?.mean}%`);
  console.log(`  sideways hit20: CSB ${hitRate(csbSide, 'hit20_10pct')?.rate}% vs all ${hitRate(allSide, 'hit20_10pct')?.rate}%`);

  console.log('\n[5] 표본 n:');
  console.log(`  csbTrials n=${csbTrials.length} (목표 1000+, ${csbTrials.length >= 1000 ? '✅' : '✗'})`);

  console.log('\n[6] 500-1000억 worst 분리 여부 (위 7b 표 참고):');
  console.log(`  CSB 500-1000억 d20 worst: ${aggKey(smallCap, 'd20')?.worst}% / d40 worst: ${aggKey(smallCap, 'd40')?.worst}%`);
  console.log(`  CSB 1000억+ 평균 d20 worst (참고): ${aggKey(csbTrials.filter((t) => t.marketCap >= 100_000_000_000), 'd20')?.worst}%`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
