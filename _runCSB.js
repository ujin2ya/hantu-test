// CompressionSupportBreakout — "상승 전 압축 후보" 백테스트
//
// 메트릭:
//   - close return: d5 / d10 / d20 / d40
//   - MFE (max favorable excursion): mfe10 / mfe20 / mfe40 — 보유 기간 중 최대 high
//   - hit rate: 10일/20일/40일 안에 +10% 도달 비율, 20일/40일 안에 +20% 도달 비율
//
// 비교 대상:
//   - CSB (calculateCompressionSupportBreakoutScore 통과)
//   - compressionBaseline (v3 universe)
//   - baselineTrendRS, baselineAll
//
// 그룹: regime / market / score bucket(70+/60-69/50-59/<50) / topN(5,10,20) / winsorize 5%

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
function aggKey(trials, k) { return summarize(trials.map((t) => t.forward?.[k]).filter(Number.isFinite)); }
function trimKey(trials, k) { return trimmed(trials.map((t) => t.forward?.[k]).filter(Number.isFinite)); }
function hitRate(trials, k) {
  const arr = trials.map((t) => t.forward?.[k]).filter((v) => v === true || v === false);
  if (!arr.length) return null;
  const hits = arr.filter((v) => v === true).length;
  return { n: arr.length, rate: Math.round((hits / arr.length) * 100) };
}

const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

(async () => {
  console.log('================================================================');
  console.log('CompressionSupportBreakout — "상승 전 압축 후보" 백테스트');
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
      const start20 = Math.max(0, t - 19);
      const last20 = chartRows.slice(start20, t + 1);
      const avg20Value = last20.reduce((s, x) => s + (x.valueApprox || 0), 0) / Math.max(last20.length, 1);
      if (avg20Value < 5_000_000_000) continue;

      const close = today.close;
      if (!(close > 0)) continue;

      // forward returns
      const forward = {};
      for (const fwd of FORWARD_DAYS) {
        const fut = chartRows[t + fwd];
        if (fut && fut.close > 0) forward[`d${fwd}`] = fut.close / close - 1;
      }
      if (!Number.isFinite(forward.d5)) continue;

      // MFE & hit rate
      let runningMaxHigh = 0;
      let prevWindowEnd = t;
      for (const win of MFE_DAYS) {
        // running max from t+1..t+win
        for (let j = prevWindowEnd + 1; j <= t + win; j++) {
          const r2 = chartRows[j];
          if (!r2) break;
          const h = r2.high || r2.close;
          if (h > runningMaxHigh) runningMaxHigh = h;
        }
        prevWindowEnd = t + win;
        forward[`mfe${win}`] = runningMaxHigh > 0 ? runningMaxHigh / close - 1 : null;
      }
      // hit rates — when the running high crosses threshold
      // recompute with growing window (already have running max via above loop's intermediate state — but we need separate computation)
      // simpler: scan once for full window and record hit days
      let maxSoFar = 0;
      const hitsAt = {};  // {0.10: dayIdx, 0.20: dayIdx}
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

      // compressionBaseline
      let compPass = false;
      try {
        const u3 = ps.flowLeadV3CompressionUniverse(chartsUpTo, meta);
        compPass = u3 && u3.passed;
      } catch (_) {}
      if (compPass) compressionTrials.push(baseTrial);

      // CSB universe
      let csbPass = false;
      try {
        const ucsb = ps.compressionSupportBreakoutUniverse(chartsUpTo, meta);
        csbPass = ucsb && ucsb.passed;
      } catch (_) {}
      if (!csbPass) continue;

      // CSB score (flow optional — use if available)
      let flowsUpTo = null;
      if (flowDateSet.has(today.date)) {
        flowsUpTo = flowRows.filter((f) => f.date <= today.date);
        if (flowsUpTo.length < 20) flowsUpTo = null;
      }
      let sc;
      try { sc = ps.calculateCompressionSupportBreakoutScore(chartsUpTo, flowsUpTo, meta); } catch (_) { sc = null; }
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
      row('CSB',                aggKey(csb, fwdKey),  trimKey(csb, fwdKey)),
      row('compressionBaseline',aggKey(comp, fwdKey), trimKey(comp, fwdKey)),
      row('baselineTrendRS',    aggKey(trs, fwdKey),  trimKey(trs, fwdKey)),
      row('baselineAll',        aggKey(all, fwdKey),  trimKey(all, fwdKey)),
    ];
  }

  // 1. close return d5/d10/d20/d40
  console.log('\n\n## 1. close return — d5/d10/d20/d40 (raw + winsorize 5%)');
  for (const fwd of FORWARD_DAYS) {
    console.log(`\n### d${fwd}`);
    console.table(compareTab(() => true, `d${fwd}`));
  }

  // 2. MFE
  console.log('\n\n## 2. MFE (max favorable excursion) — mfe10/20/40');
  for (const win of MFE_DAYS) {
    console.log(`\n### mfe${win}`);
    console.table(compareTab(() => true, `mfe${win}`));
  }

  // 3. hit rates
  console.log('\n\n## 3. Hit rate — % of trials reaching threshold within window');
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
        CSB: `${csb?.rate}% (${csb?.n})`,
        comp: `${comp?.rate}% (${comp?.n})`,
        trendRS: `${trs?.rate}% (${trs?.n})`,
        all: `${all?.rate}% (${all?.n})`,
      });
    }
  }
  console.table(hitRows);

  // 4. score bucket × d20
  console.log('\n\n## 4. score bucket — d20 close return + mfe20 + hit20_10pct');
  const buckets = [
    ['70+',    (t) => t.score >= 70],
    ['60-69',  (t) => t.score >= 60 && t.score < 70],
    ['50-59',  (t) => t.score >= 50 && t.score < 60],
    ['<50',    (t) => t.score < 50],
  ];
  const bucketRows = buckets.map(([lab, f]) => {
    const ts = csbTrials.filter(f);
    const d20 = aggKey(ts, 'd20');
    const mfe20 = aggKey(ts, 'mfe20');
    const hit = hitRate(ts, 'hit20_10pct');
    return {
      bucket: lab,
      n: d20?.n || 0,
      d20_mean: d20?.mean,
      d20_median: d20?.median,
      mfe20_mean: mfe20?.mean,
      mfe20_median: mfe20?.median,
      hit20_10pct: hit ? `${hit.rate}%` : null,
    };
  });
  bucketRows.push({
    bucket: 'compressionBaseline',
    n: aggKey(compressionTrials, 'd20')?.n || 0,
    d20_mean: aggKey(compressionTrials, 'd20')?.mean,
    d20_median: aggKey(compressionTrials, 'd20')?.median,
    mfe20_mean: aggKey(compressionTrials, 'mfe20')?.mean,
    mfe20_median: aggKey(compressionTrials, 'mfe20')?.median,
    hit20_10pct: hitRate(compressionTrials, 'hit20_10pct') ? `${hitRate(compressionTrials, 'hit20_10pct').rate}%` : null,
  });
  console.table(bucketRows);

  // 4b. d40 / mfe40 / hit40
  console.log('\n## 4b. score bucket — d40 + mfe40 + hit40_10pct + hit40_20pct');
  const bucketRows40 = buckets.map(([lab, f]) => {
    const ts = csbTrials.filter(f);
    const d40 = aggKey(ts, 'd40');
    const mfe40 = aggKey(ts, 'mfe40');
    const hit10 = hitRate(ts, 'hit40_10pct');
    const hit20 = hitRate(ts, 'hit40_20pct');
    return {
      bucket: lab,
      n: d40?.n || 0,
      d40_mean: d40?.mean,
      d40_median: d40?.median,
      mfe40_mean: mfe40?.mean,
      mfe40_median: mfe40?.median,
      hit40_10pct: hit10 ? `${hit10.rate}%` : null,
      hit40_20pct: hit20 ? `${hit20.rate}%` : null,
    };
  });
  bucketRows40.push({
    bucket: 'compressionBaseline',
    n: aggKey(compressionTrials, 'd40')?.n || 0,
    d40_mean: aggKey(compressionTrials, 'd40')?.mean,
    d40_median: aggKey(compressionTrials, 'd40')?.median,
    mfe40_mean: aggKey(compressionTrials, 'mfe40')?.mean,
    mfe40_median: aggKey(compressionTrials, 'mfe40')?.median,
    hit40_10pct: hitRate(compressionTrials, 'hit40_10pct') ? `${hitRate(compressionTrials, 'hit40_10pct').rate}%` : null,
    hit40_20pct: hitRate(compressionTrials, 'hit40_20pct') ? `${hitRate(compressionTrials, 'hit40_20pct').rate}%` : null,
  });
  console.table(bucketRows40);

  // 5. regime × d20 / mfe20 / hit20_10pct
  console.log('\n\n## 5. regime × d20 / mfe20 / hit20_10pct');
  for (const reg of ['bull', 'bear', 'sideways']) {
    console.log(`\n### ${reg} d20`);
    console.table(compareTab((t) => t.regime === reg, 'd20'));
    console.log(`### ${reg} mfe20`);
    console.table(compareTab((t) => t.regime === reg, 'mfe20'));
    const csbReg = csbTrials.filter((t) => t.regime === reg);
    const compReg = compressionTrials.filter((t) => t.regime === reg);
    const allReg = allTrials.filter((t) => t.regime === reg);
    const trsReg = trendRSTrials.filter((t) => t.regime === reg);
    console.log(`### ${reg} hit20_10pct`);
    console.table([
      { group: 'CSB',                rate: hitRate(csbReg, 'hit20_10pct')?.rate + '%', n: hitRate(csbReg, 'hit20_10pct')?.n },
      { group: 'compressionBaseline',rate: hitRate(compReg, 'hit20_10pct')?.rate + '%', n: hitRate(compReg, 'hit20_10pct')?.n },
      { group: 'baselineTrendRS',    rate: hitRate(trsReg, 'hit20_10pct')?.rate + '%', n: hitRate(trsReg, 'hit20_10pct')?.n },
      { group: 'baselineAll',        rate: hitRate(allReg, 'hit20_10pct')?.rate + '%', n: hitRate(allReg, 'hit20_10pct')?.n },
    ]);
  }

  // 6. market × d20
  console.log('\n\n## 6. market × d20 / hit20_10pct');
  for (const m of ['KOSPI', 'KOSDAQ']) {
    console.log(`\n### ${m} d20`);
    console.table(compareTab((t) => t.market === m, 'd20'));
  }

  // 7. topN
  console.log('\n\n## 7. topN — 매일 score 상위 N 진입 (d20 / mfe20 / hit20_10pct)');
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
    topNRows.push({
      group: `top${N}`,
      n: picks.length,
      d20_mean: aggKey(picks, 'd20')?.mean,
      mfe20_mean: aggKey(picks, 'mfe20')?.mean,
      hit20_10pct: hitRate(picks, 'hit20_10pct') ? `${hitRate(picks, 'hit20_10pct').rate}%` : null,
      hit40_10pct: hitRate(picks, 'hit40_10pct') ? `${hitRate(picks, 'hit40_10pct').rate}%` : null,
      hit40_20pct: hitRate(picks, 'hit40_20pct') ? `${hitRate(picks, 'hit40_20pct').rate}%` : null,
    });
  }
  topNRows.push({
    group: 'compression all',
    n: compressionTrials.length,
    d20_mean: aggKey(compressionTrials, 'd20')?.mean,
    mfe20_mean: aggKey(compressionTrials, 'mfe20')?.mean,
    hit20_10pct: hitRate(compressionTrials, 'hit20_10pct') ? `${hitRate(compressionTrials, 'hit20_10pct').rate}%` : null,
    hit40_10pct: hitRate(compressionTrials, 'hit40_10pct') ? `${hitRate(compressionTrials, 'hit40_10pct').rate}%` : null,
    hit40_20pct: hitRate(compressionTrials, 'hit40_20pct') ? `${hitRate(compressionTrials, 'hit40_20pct').rate}%` : null,
  });
  console.table(topNRows);

  // ─── 판정 ───
  console.log('\n\n================================================================');
  console.log('## 판정 — 성공 기준 체크');
  console.log('================================================================');

  function dom(a, b) { return a && b && a.mean > b.mean && a.median > b.median && a.pf > b.pf && a.win > b.win; }

  const csbD20 = aggKey(csbTrials, 'd20'), compD20 = aggKey(compressionTrials, 'd20'), allD20 = aggKey(allTrials, 'd20');
  const csbD40 = aggKey(csbTrials, 'd40'), compD40 = aggKey(compressionTrials, 'd40'), allD40 = aggKey(allTrials, 'd40');
  const csbMfe20 = aggKey(csbTrials, 'mfe20'), compMfe20 = aggKey(compressionTrials, 'mfe20'), allMfe20 = aggKey(allTrials, 'mfe20');
  const csbMfe40 = aggKey(csbTrials, 'mfe40'), compMfe40 = aggKey(compressionTrials, 'mfe40'), allMfe40 = aggKey(allTrials, 'mfe40');
  const csbHit20 = hitRate(csbTrials, 'hit20_10pct'), compHit20 = hitRate(compressionTrials, 'hit20_10pct'), allHit20 = hitRate(allTrials, 'hit20_10pct');
  const csbHit40 = hitRate(csbTrials, 'hit40_10pct'), compHit40 = hitRate(compressionTrials, 'hit40_10pct'), allHit40 = hitRate(allTrials, 'hit40_10pct');
  const csbHit40_20 = hitRate(csbTrials, 'hit40_20pct'), compHit40_20 = hitRate(compressionTrials, 'hit40_20pct'), allHit40_20 = hitRate(allTrials, 'hit40_20pct');

  console.log('\n[기준 1] d20/d40 또는 MFE20/MFE40 baseline 우위:');
  console.log(`  d20:  CSB ${csbD20?.mean}% vs comp ${compD20?.mean}% / all ${allD20?.mean}%   ${dom(csbD20, compD20) ? '✅ vs comp' : '✗ vs comp'} ${dom(csbD20, allD20) ? '✅ vs all' : '✗ vs all'}`);
  console.log(`  d40:  CSB ${csbD40?.mean}% vs comp ${compD40?.mean}% / all ${allD40?.mean}%   ${dom(csbD40, compD40) ? '✅ vs comp' : '✗ vs comp'} ${dom(csbD40, allD40) ? '✅ vs all' : '✗ vs all'}`);
  console.log(`  mfe20: CSB ${csbMfe20?.mean}% vs comp ${compMfe20?.mean}% / all ${allMfe20?.mean}%`);
  console.log(`  mfe40: CSB ${csbMfe40?.mean}% vs comp ${compMfe40?.mean}% / all ${allMfe40?.mean}%`);

  console.log('\n[기준 2] hit10/hit20 baseline 우위:');
  console.log(`  hit20_+10%: CSB ${csbHit20?.rate}% vs comp ${compHit20?.rate}% / all ${allHit20?.rate}%`);
  console.log(`  hit40_+10%: CSB ${csbHit40?.rate}% vs comp ${compHit40?.rate}% / all ${allHit40?.rate}%`);
  console.log(`  hit40_+20%: CSB ${csbHit40_20?.rate}% vs comp ${compHit40_20?.rate}% / all ${allHit40_20?.rate}%`);

  console.log('\n[기준 3] score bucket 단조 — d20 mean by bucket:');
  for (const [lab, f] of buckets) {
    const ts = csbTrials.filter(f);
    const d20 = aggKey(ts, 'd20');
    const mfe20 = aggKey(ts, 'mfe20');
    const hit20 = hitRate(ts, 'hit20_10pct');
    console.log(`  ${lab}: n=${d20?.n} d20=${d20?.mean}% mfe20=${mfe20?.mean}% hit20=${hit20?.rate}%`);
  }

  console.log('\n[기준 4] top5/top10 baseline 우위:');
  for (const r of topNRows) {
    console.log(`  ${r.group}: n=${r.n} d20=${r.d20_mean}% mfe20=${r.mfe20_mean}% hit20=${r.hit20_10pct} hit40_10=${r.hit40_10pct} hit40_20=${r.hit40_20pct}`);
  }

  console.log('\n[기준 5] sideways 도 baseline 못 잃지 않음:');
  const csbSide = csbTrials.filter((t) => t.regime === 'sideways');
  const compSide = compressionTrials.filter((t) => t.regime === 'sideways');
  const allSide = allTrials.filter((t) => t.regime === 'sideways');
  const csbSideD20 = aggKey(csbSide, 'd20'), compSideD20 = aggKey(compSide, 'd20'), allSideD20 = aggKey(allSide, 'd20');
  console.log(`  sideways d20: CSB ${csbSideD20?.mean}% vs comp ${compSideD20?.mean}% / all ${allSideD20?.mean}%`);
  console.log(`  sideways win: CSB ${csbSideD20?.win}% vs comp ${compSideD20?.win}% / all ${allSideD20?.win}%`);
  console.log(`  sideways hit20_10pct: CSB ${hitRate(csbSide, 'hit20_10pct')?.rate}% vs comp ${hitRate(compSide, 'hit20_10pct')?.rate}% / all ${hitRate(allSide, 'hit20_10pct')?.rate}%`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
