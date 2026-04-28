// CSB v3 — 사용자 spec (정형화된 함수 + sweet spot + 시총 500억 + 종합 백테스트)
//
// 함수: calculateCompressionSupportBreakoutScore(rows, flowRows, meta, idx)
// 반환 정형화: { passed, score, bucket, displayGrade, stages, tags, warnings, rejectReason, metrics, breakdown }

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
  console.log('CSB v3 — 사용자 spec: 정형화 함수 + sweet spot 점수 + 시총 500억');
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
  const compressionTrials = [];   // v3 universe (flowLeadV3CompressionUniverse)
  const allTrials = [];
  const trendRSTrials = [];

  let scanned = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const meta = codeMeta.get(code) || {};
    if (meta.isSpecial || meta.isEtf) continue;
    if ((meta.marketValue || 0) < 50_000_000_000) continue;

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
    const flowByDate = new Map();
    for (const f of flowRows) flowByDate.set(f.date, f);

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

      // compressionBaseline — flowLeadV3CompressionUniverse 통과 시점
      let compPass = false;
      try {
        const u3 = ps.flowLeadV3CompressionUniverse(chartRows.slice(0, t + 1), meta);
        compPass = u3 && u3.passed;
      } catch (_) {}
      if (compPass) compressionTrials.push(baseTrial);

      // CSB v3 — score 함수 직접 호출 (idx 사용)
      let flowsUpTo = null;
      if (flowDateSet.has(today.date)) {
        flowsUpTo = flowRows.filter((f) => f.date <= today.date);
        if (flowsUpTo.length < 20) flowsUpTo = null;
      }
      let sc;
      try { sc = ps.calculateCompressionSupportBreakoutScore(chartRows, flowsUpTo, meta, t); } catch (_) { sc = null; }
      if (!sc || !sc.passed) continue;

      csbTrials.push({
        ...baseTrial,
        score: sc.score,
        bucket: sc.bucket,
        displayGrade: sc.displayGrade,
        stages: sc.stages,
        tags: sc.tags,
        warnings: sc.warnings,
        breakdown: sc.breakdown,
        metrics: sc.metrics,
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
      row('CSB v3',              aggKey(csb, fwdKey),  trimKey(csb, fwdKey)),
      row('compressionBaseline', aggKey(comp, fwdKey), trimKey(comp, fwdKey)),
      row('baselineTrendRS',     aggKey(trs, fwdKey),  trimKey(trs, fwdKey)),
      row('baselineAll',         aggKey(all, fwdKey),  trimKey(all, fwdKey)),
    ];
  }

  // 1. close return
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
  console.log('\n\n## 3. Hit rate');
  const hitRows = [];
  for (const win of HIT_DAYS) {
    for (const thr of HIT_THRESHOLDS) {
      if (thr === 0.20 && win < 20) continue;
      const key = `hit${win}_${Math.round(thr * 100)}pct`;
      hitRows.push({
        metric: `${win}d ≥+${Math.round(thr * 100)}%`,
        CSB: `${hitRate(csbTrials, key)?.rate}% (${hitRate(csbTrials, key)?.n})`,
        comp: `${hitRate(compressionTrials, key)?.rate}% (${hitRate(compressionTrials, key)?.n})`,
        trendRS: `${hitRate(trendRSTrials, key)?.rate}% (${hitRate(trendRSTrials, key)?.n})`,
        all: `${hitRate(allTrials, key)?.rate}% (${hitRate(allTrials, key)?.n})`,
      });
    }
  }
  console.table(hitRows);

  // 4. score bucket
  console.log('\n\n## 4. score bucket — d20 + mfe20 + hit10/hit20');
  const buckets = [
    ['70+',    (t) => t.score >= 70],
    ['60-69',  (t) => t.score >= 60 && t.score < 70],
    ['50-59',  (t) => t.score >= 50 && t.score < 60],
    ['<50',    (t) => t.score < 50],
  ];
  const bRows = buckets.map(([lab, f]) => {
    const ts = csbTrials.filter(f);
    const d20 = aggKey(ts, 'd20'), mfe20 = aggKey(ts, 'mfe20');
    return {
      bucket: lab, n: d20?.n || 0,
      d20_mean: d20?.mean, d20_median: d20?.median, d20_win: d20?.win + '%',
      mfe20_mean: mfe20?.mean,
      hit10_10: hitRate(ts, 'hit10_10pct') ? `${hitRate(ts, 'hit10_10pct').rate}%` : null,
      hit20_10: hitRate(ts, 'hit20_10pct') ? `${hitRate(ts, 'hit20_10pct').rate}%` : null,
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

  console.log('\n## 4b. score bucket — d40 + mfe40 + hit40');
  const bRows40 = buckets.map(([lab, f]) => {
    const ts = csbTrials.filter(f);
    const d40 = aggKey(ts, 'd40'), mfe40 = aggKey(ts, 'mfe40');
    return {
      bucket: lab, n: d40?.n || 0,
      d40_mean: d40?.mean, d40_median: d40?.median, d40_win: d40?.win + '%',
      mfe40_mean: mfe40?.mean,
      hit40_10: hitRate(ts, 'hit40_10pct') ? `${hitRate(ts, 'hit40_10pct').rate}%` : null,
      hit40_20: hitRate(ts, 'hit40_20pct') ? `${hitRate(ts, 'hit40_20pct').rate}%` : null,
    };
  });
  bRows40.push({
    bucket: 'compressionBaseline',
    n: compressionTrials.length,
    d40_mean: aggKey(compressionTrials, 'd40')?.mean,
    d40_median: aggKey(compressionTrials, 'd40')?.median,
    d40_win: aggKey(compressionTrials, 'd40')?.win + '%',
    mfe40_mean: aggKey(compressionTrials, 'mfe40')?.mean,
    hit40_10: hitRate(compressionTrials, 'hit40_10pct') ? `${hitRate(compressionTrials, 'hit40_10pct').rate}%` : null,
    hit40_20: hitRate(compressionTrials, 'hit40_20pct') ? `${hitRate(compressionTrials, 'hit40_20pct').rate}%` : null,
  });
  console.table(bRows40);

  // 5. regime
  console.log('\n\n## 5. regime × d20');
  for (const reg of ['bull', 'bear', 'sideways']) {
    console.log(`\n### ${reg}`);
    console.table(compareTab((t) => t.regime === reg, 'd20'));
  }
  console.log('\n## 5b. regime × d40');
  for (const reg of ['bull', 'bear', 'sideways']) {
    console.log(`\n### ${reg}`);
    console.table(compareTab((t) => t.regime === reg, 'd40'));
  }

  // 6. market
  console.log('\n\n## 6. market × d20');
  for (const m of ['KOSPI', 'KOSDAQ']) {
    console.log(`\n### ${m}`);
    console.table(compareTab((t) => t.market === m, 'd20'));
  }

  // 7. 시총 구간
  console.log('\n\n## 7. 시총 구간 × d20 / d40 / mfe20 / hit20_10pct / worst');
  const mcGroups = ['500-1000억', '1000-3000억', '3000억-1조', '1조+'];
  const mcRows = mcGroups.map((grp) => {
    const csbG = csbTrials.filter((t) => mcGroup(t.marketCap) === grp);
    const allG = allTrials.filter((t) => mcGroup(t.marketCap) === grp);
    const d20 = aggKey(csbG, 'd20'), d40 = aggKey(csbG, 'd40');
    const mfe20 = aggKey(csbG, 'mfe20'), mfe40 = aggKey(csbG, 'mfe40');
    return {
      mcGroup: grp, n: d20?.n || 0,
      d20_mean: d20?.mean, d20_win: d20?.win + '%', d20_pf: d20?.pf, d20_worst: d20?.worst,
      d40_mean: d40?.mean, d40_worst: d40?.worst,
      mfe20_mean: mfe20?.mean, mfe40_mean: mfe40?.mean,
      hit10_10: hitRate(csbG, 'hit10_10pct') ? `${hitRate(csbG, 'hit10_10pct').rate}%` : null,
      hit20_10: hitRate(csbG, 'hit20_10pct') ? `${hitRate(csbG, 'hit20_10pct').rate}%` : null,
      all_d20: aggKey(allG, 'd20')?.mean,
    };
  });
  console.table(mcRows);

  // 7b. 500-1000억 별도 위험 메트릭
  console.log('\n## 7b. 500-1000억 별도 — 위험 메트릭');
  const smallCap = csbTrials.filter((t) => t.marketCap >= 50_000_000_000 && t.marketCap < 100_000_000_000);
  const smallCapAll = allTrials.filter((t) => t.marketCap >= 50_000_000_000 && t.marketCap < 100_000_000_000);
  if (smallCap.length === 0) {
    console.log('  ⚠️ 500-1000억 cache 데이터 없음 (현재 백필된 511 종목은 모두 1000억+) — 추가 backfill 필요');
  } else {
    const sc20 = aggKey(smallCap, 'd20'), sc40 = aggKey(smallCap, 'd40');
    const scAll20 = aggKey(smallCapAll, 'd20');
    console.table([
      {
        metric: '500-1000억 CSB',
        n: sc20?.n || 0,
        d20_mean: sc20?.mean, d20_median: sc20?.median, d20_win: sc20?.win + '%',
        d20_pf: sc20?.pf, d20_worst: sc20?.worst,
        d40_mean: sc40?.mean, d40_worst: sc40?.worst,
      },
      {
        metric: '500-1000억 baselineAll',
        n: scAll20?.n || 0,
        d20_mean: scAll20?.mean, d20_median: scAll20?.median, d20_win: scAll20?.win + '%',
        d20_pf: scAll20?.pf, d20_worst: scAll20?.worst,
      },
    ]);
  }

  // 8. 거래대금 구간
  console.log('\n\n## 8. 거래대금 구간 × d20');
  for (const grp of ['50-100억', '100-300억', '300억+']) {
    console.log(`\n### ${grp}`);
    console.table(compareTab((t) => tvGroup(t.avg20Value) === grp, 'd20'));
  }

  // 9. topN
  console.log('\n\n## 9. topN — 매일 score 상위 N');
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
      group: `top${N}`, n: picks.length,
      d20_mean: aggKey(picks, 'd20')?.mean, d20_win: aggKey(picks, 'd20')?.win + '%',
      d40_mean: aggKey(picks, 'd40')?.mean,
      mfe20_mean: aggKey(picks, 'mfe20')?.mean, mfe40_mean: aggKey(picks, 'mfe40')?.mean,
      hit10: hitRate(picks, 'hit10_10pct') ? `${hitRate(picks, 'hit10_10pct').rate}%` : null,
      hit20: hitRate(picks, 'hit20_10pct') ? `${hitRate(picks, 'hit20_10pct').rate}%` : null,
      hit40_10: hitRate(picks, 'hit40_10pct') ? `${hitRate(picks, 'hit40_10pct').rate}%` : null,
      hit40_20: hitRate(picks, 'hit40_20pct') ? `${hitRate(picks, 'hit40_20pct').rate}%` : null,
    });
  }
  topNRows.push({
    group: 'compression all', n: compressionTrials.length,
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

  // 10. tag combination
  console.log('\n\n## 10. tag combination × d20 — stage tag 효과');
  const tagBuckets = [
    ['압축+지지+돌파+거래대금 (4개 모두)', (t) => t.stages?.compressionFormed && t.stages?.supportConfirmed && t.stages?.breakoutReady && t.stages?.volumeReturning],
    ['압축+지지+돌파',                    (t) => t.stages?.compressionFormed && t.stages?.supportConfirmed && t.stages?.breakoutReady && !t.stages?.volumeReturning],
    ['압축+지지+거래대금',                (t) => t.stages?.compressionFormed && t.stages?.supportConfirmed && !t.stages?.breakoutReady && t.stages?.volumeReturning],
    ['압축+돌파',                         (t) => t.stages?.compressionFormed && !t.stages?.supportConfirmed && t.stages?.breakoutReady],
    ['압축만',                            (t) => t.stages?.compressionFormed && !t.stages?.supportConfirmed && !t.stages?.breakoutReady && !t.stages?.volumeReturning],
    ['태그 없음',                         (t) => !t.stages?.compressionFormed && !t.stages?.supportConfirmed && !t.stages?.breakoutReady && !t.stages?.volumeReturning],
  ];
  const tagRows = tagBuckets.map(([lab, f]) => {
    const ts = csbTrials.filter(f);
    const d20 = aggKey(ts, 'd20'), mfe20 = aggKey(ts, 'mfe20');
    return {
      tags: lab, n: d20?.n || 0,
      d20_mean: d20?.mean, d20_win: d20?.win + '%',
      mfe20_mean: mfe20?.mean,
      hit10: hitRate(ts, 'hit10_10pct') ? `${hitRate(ts, 'hit10_10pct').rate}%` : null,
      hit20: hitRate(ts, 'hit20_10pct') ? `${hitRate(ts, 'hit20_10pct').rate}%` : null,
    };
  });
  console.table(tagRows);

  // ─── 성공 기준 ───
  console.log('\n\n================================================================');
  console.log('## 성공 기준 체크');
  console.log('================================================================');

  const csbD20 = aggKey(csbTrials, 'd20'), allD20 = aggKey(allTrials, 'd20'), compD20 = aggKey(compressionTrials, 'd20');
  const csbD40 = aggKey(csbTrials, 'd40'), allD40 = aggKey(allTrials, 'd40'), compD40 = aggKey(compressionTrials, 'd40');
  const csbMfe20 = aggKey(csbTrials, 'mfe20'), allMfe20 = aggKey(allTrials, 'mfe20'), compMfe20 = aggKey(compressionTrials, 'mfe20');
  const csbMfe40 = aggKey(csbTrials, 'mfe40'), allMfe40 = aggKey(allTrials, 'mfe40'), compMfe40 = aggKey(compressionTrials, 'mfe40');
  const csbHit10 = hitRate(csbTrials, 'hit10_10pct'), allHit10 = hitRate(allTrials, 'hit10_10pct');
  const csbHit20 = hitRate(csbTrials, 'hit20_10pct'), allHit20 = hitRate(allTrials, 'hit20_10pct');

  console.log(`\n[1] 표본 n: CSB ${csbTrials.length} (목표 1000+, ${csbTrials.length >= 1000 ? '✅' : '✗'})`);
  console.log(`\n[2] d20/d40/MFE20/MFE40 baseline 우위:`);
  console.log(`  d20:   CSB ${csbD20?.mean}% vs comp ${compD20?.mean}% / all ${allD20?.mean}%`);
  console.log(`  d40:   CSB ${csbD40?.mean}% vs comp ${compD40?.mean}% / all ${allD40?.mean}%`);
  console.log(`  mfe20: CSB ${csbMfe20?.mean}% vs comp ${compMfe20?.mean}% / all ${allMfe20?.mean}%`);
  console.log(`  mfe40: CSB ${csbMfe40?.mean}% vs comp ${compMfe40?.mean}% / all ${allMfe40?.mean}%`);
  console.log(`\n[3] hit10/hit20 baseline 개선:`);
  console.log(`  hit10_+10%: CSB ${csbHit10?.rate}% vs all ${allHit10?.rate}%`);
  console.log(`  hit20_+10%: CSB ${csbHit20?.rate}% vs all ${allHit20?.rate}%`);
  console.log(`\n[4] score bucket 단조 — d20 mean by bucket:`);
  for (const [lab, f] of buckets) {
    const ts = csbTrials.filter(f);
    const d20 = aggKey(ts, 'd20');
    const mfe20 = aggKey(ts, 'mfe20');
    const hit20 = hitRate(ts, 'hit20_10pct');
    console.log(`  ${lab}: n=${d20?.n} d20=${d20?.mean}% mfe20=${mfe20?.mean}% hit20=${hit20?.rate}%`);
  }
  console.log(`\n[5] sideways: CSB ${aggKey(csbTrials.filter(t=>t.regime==='sideways'),'d20')?.mean}% vs all ${aggKey(allTrials.filter(t=>t.regime==='sideways'),'d20')?.mean}%`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
