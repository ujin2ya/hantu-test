// Phase 3 검증 — 250일 일봉 + asOf 보정 + 사용자 요구 8개 측정
//
// 사용자 조건:
//   1. asOf 65~74 d1/d5/d20
//   2. baselineTrendRS, baseline 대비 초과성과
//   3. winsorize 5% 후 mean/median/PF
//   4. KOSPI/KOSDAQ 분리
//   5. 시총 구간별 (특히 3000억~1조)
//   6. 거래대금 구간별 (특히 50~100억)
//   7. 75~84 / 85+ 약한지
//   8. 표본 수 n 증가 확인
//
// 채택 기준 (모두 만족 시 cutoff 65 채택):
//   - PF 1.5+
//   - median 양수
//   - baselineTrendRS 대비 우위
//   - outlier 제거 후 유지

require('dotenv').config({ quiet: true });
const path = require('path');
const ps = require('./pattern-screener');

const FORWARD_DAYS = [1, 5, 20];
const DAYS_BACK = 700;          // 2023-01 ~ 2026-04 (3년) — pykrx re-seed 후 전체 활용
const CACHE_DIR_LONG = path.join(__dirname, 'cache', 'stock-charts-long');

function marketCapBucket(mc) {
  if (!mc) return '?';
  if (mc < 100_000_000_000) return '<1000억';
  if (mc < 300_000_000_000) return '1000-3000억';
  if (mc < 1_000_000_000_000) return '3000억-1조';
  return '1조+';
}
function tradingValueBucket(v) {
  if (!v) return '?';
  if (v < 5_000_000_000) return '<50억';
  if (v < 10_000_000_000) return '50-100억';
  if (v < 30_000_000_000) return '100-300억';
  return '300억+';
}

function row(label, stat) {
  if (!stat) return { group: label, n: 0 };
  if (stat.n < 5 || stat.mean == null) return { group: label, n: stat.n || 0, _note: 'n<5' };
  return {
    group: label, n: stat.n,
    mean: stat.mean, median: stat.median, win: stat.winRate,
    avgWin: stat.avgWin, avgLoss: stat.avgLoss,
    wl: stat.winLossRatio, pf: stat.profitFactor,
    worst: stat.worstTrade ?? stat.worst,
  };
}

function trimmed(trials, fwd, aggregateFn, label, trimPct = 0.05) {
  if (trials.length < 20) return null;
  const valid = trials.filter((t) => Number.isFinite(t.forward?.[`d${fwd}`]));
  if (valid.length < 20) return null;
  const sorted = [...valid].sort((a, b) => a.forward[`d${fwd}`] - b.forward[`d${fwd}`]);
  const cutLow = Math.floor(sorted.length * trimPct);
  const cutHigh = Math.ceil(sorted.length * (1 - trimPct));
  return aggregateFn(sorted.slice(cutLow, cutHigh), label + ` [trim ${trimPct * 100}%]`);
}

function groupBy(trials, keyFn) {
  const m = new Map();
  for (const t of trials) {
    const k = keyFn(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return m;
}

(async () => {
  console.log('================================================================');
  console.log('Phase 3 검증 — pykrx 250일 + asOf 보정');
  console.log('================================================================');
  console.log(`daysBack=${DAYS_BACK}, forwardDays=${FORWARD_DAYS.join(',')}, cache=stock-charts-long`);

  const t0 = Date.now();
  const r = await ps.backtestTotalScore({
    daysBack: DAYS_BACK,
    forwardDays: FORWARD_DAYS,
    entryMode: 'nextOpen',
    applyAtrStop: true,
    useFinancials: 'asOf',
    cacheDir: CACHE_DIR_LONG,
  });
  console.log('elapsed:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('rule:', r.rule);
  console.log('total scored:', r.allScored.length, '| trendRS pass:', r.trendRSTrials.length);

  // ─── 1. d1/d5/d20 그룹별 (사용자 요구 #1, #7, #8) ───
  for (const fwd of FORWARD_DAYS) {
    const d = `d${fwd}`;
    console.log(`\n## d${fwd} 그룹별 (사용자 요구 #1, #7, #8)`);
    console.table([
      row('💎 85+ buy', r.buyCandidates?.[d]),
      row('👀 75-84 watch', r.watchlist?.[d]),
      row('👁 65-74 observe', r.observation?.[d]),
      row('75+ 누적', r.score75Plus?.[d]),
      row('65+ 누적', r.score65Plus?.[d]),
      row('baselineTrendRS', r.baselineTrendRS?.[d]),
      row('baseline', r.baseline?.[d]),
    ]);
  }

  // ─── 2. asOf 65-74 d1/d5/d20 vs baseline (사용자 요구 #2) ───
  console.log('\n\n## asOf 65-74 vs baselineTrendRS / baseline (사용자 요구 #2)');
  for (const fwd of FORWARD_DAYS) {
    const d = `d${fwd}`;
    const obs = r.observation?.[d];
    const trs = r.baselineTrendRS?.[d];
    const base = r.baseline?.[d];
    if (!obs || !trs || !base) continue;
    console.log(`\nd${fwd}:`);
    console.log(`  65-74:           mean=${obs.mean}% median=${obs.median}% win=${obs.winRate}% PF=${obs.profitFactor}`);
    console.log(`  baselineTrendRS: mean=${trs.mean}% median=${trs.median}% win=${trs.winRate}% PF=${trs.profitFactor}`);
    console.log(`  baseline:        mean=${base.mean}% median=${base.median}% win=${base.winRate}% PF=${base.profitFactor}`);
    console.log(`  → 초과성과(vs baselineTrendRS): mean +${(obs.mean - trs.mean).toFixed(2)}%p, PF ${(obs.profitFactor - trs.profitFactor).toFixed(2)}`);
  }

  // ─── 3. winsorize 5% (사용자 요구 #3) ───
  console.log('\n\n## winsorize 5% — 65-74 outlier 제거 후 (사용자 요구 #3)');
  const obs65 = r.allScored.filter((t) => t.setupScore >= 65 && t.setupScore < 75);
  for (const fwd of FORWARD_DAYS) {
    const trim = trimmed(obs65, fwd, r.aggregate, '65-74 trimmed');
    if (!trim || !trim[`d${fwd}`]) {
      console.log(`d${fwd}: 표본 부족 (n=${obs65.length})`);
      continue;
    }
    console.log(`\nd${fwd} trimmed:`, JSON.stringify(row('trimmed', trim[`d${fwd}`])));
  }

  // ─── 4. KOSPI/KOSDAQ 분리 (사용자 요구 #4) ───
  console.log('\n\n## KOSPI/KOSDAQ 분리 — 65-74 d5');
  for (const market of ['KOSPI', 'KOSDAQ']) {
    const subset = obs65.filter((t) => t.market === market);
    if (subset.length < 5) {
      console.log(`  ${market}: n=${subset.length} (표본 부족)`);
      continue;
    }
    const agg = r.aggregate(subset, market);
    console.log(`  ${market}:`, JSON.stringify(row(market, agg.d5)));
  }

  // ─── 5. 시총 구간별 (사용자 요구 #5) ───
  console.log('\n\n## 시총 구간별 — 65-74 d5 (특히 3000억~1조)');
  const mcGroups = groupBy(obs65, (t) => marketCapBucket(t.marketCap));
  const mcOrder = ['<1000억', '1000-3000억', '3000억-1조', '1조+', '?'];
  const mcRows = [];
  for (const k of mcOrder) {
    const ts = mcGroups.get(k) || [];
    if (ts.length < 5) { mcRows.push({ group: k, n: ts.length }); continue; }
    const agg = r.aggregate(ts, k);
    mcRows.push(row(k, agg.d5));
  }
  console.table(mcRows);

  // ─── 6. 거래대금 구간별 (사용자 요구 #6) ───
  console.log('\n## 거래대금 구간별 — 65-74 d5 (특히 50~100억)');
  const tvGroups = groupBy(obs65, (t) => tradingValueBucket(t.avg20Value));
  const tvOrder = ['<50억', '50-100억', '100-300억', '300억+', '?'];
  const tvRows = [];
  for (const k of tvOrder) {
    const ts = tvGroups.get(k) || [];
    if (ts.length < 5) { tvRows.push({ group: k, n: ts.length }); continue; }
    const agg = r.aggregate(ts, k);
    tvRows.push(row(k, agg.d5));
  }
  console.table(tvRows);

  // ─── 채택 판정 ───
  console.log('\n\n================================================================');
  console.log('## 채택 판정 (사용자 조건)');
  console.log('================================================================');
  const obs5 = r.observation?.d5;
  const trs5 = r.baselineTrendRS?.d5;
  if (obs5 && trs5) {
    const trim5 = trimmed(obs65, 5, r.aggregate, 'trim');
    const checks = [
      ['PF 1.5+',                        obs5.profitFactor >= 1.5,                      `${obs5.profitFactor}`],
      ['median 양수',                    obs5.median > 0,                                `${obs5.median}%`],
      ['baselineTrendRS 대비 우위 (PF)', obs5.profitFactor > trs5.profitFactor,          `${obs5.profitFactor} vs ${trs5.profitFactor}`],
      ['baselineTrendRS 대비 우위 (mean)', obs5.mean > trs5.mean,                         `${obs5.mean}% vs ${trs5.mean}%`],
      ['outlier 제거 후 PF 1.5+',         trim5?.d5?.profitFactor >= 1.5,                `${trim5?.d5?.profitFactor}`],
      ['n ≥ 50',                          obs5.n >= 50,                                  `${obs5.n}`],
      ['n ≥ 100',                         obs5.n >= 100,                                 `${obs5.n}`],
    ];
    for (const [name, pass, val] of checks) {
      console.log(`  ${pass ? '✅' : '❌'} ${name.padEnd(35)} → ${val}`);
    }
    const allCore = checks.slice(0, 5).every(([, p]) => p);
    console.log(`\n  종합 (핵심 5개): ${allCore ? '✅ cutoff 65 채택 검토 가능' : '❌ 추가 검증 필요'}`);
  } else {
    console.log('  표본 부족');
  }
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
