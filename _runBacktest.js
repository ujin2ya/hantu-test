require('dotenv').config({ quiet: true });
const ps = require('./pattern-screener');

const FORWARD_DAYS = [1, 5];

// ─── 분리 버킷 ───
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

// outlier 제거 (winsorize) — 상위/하위 5% 제거 후 재집계
function trimmedAggregate(trials, label, fwd, aggregateFn, trimPct = 0.05) {
  if (trials.length < 20) return aggregateFn(trials, label);
  const valid = trials.filter((t) => Number.isFinite(t.forward?.[`d${fwd}`]));
  if (valid.length < 20) return aggregateFn(valid, label);
  const sorted = [...valid].sort((a, b) => a.forward[`d${fwd}`] - b.forward[`d${fwd}`]);
  const cutLow = Math.floor(sorted.length * trimPct);
  const cutHigh = Math.ceil(sorted.length * (1 - trimPct));
  const trimmed = sorted.slice(cutLow, cutHigh);
  return aggregateFn(trimmed, label + ` [trim ${trimPct * 100}%]`);
}

// 분리 그룹 헬퍼
function groupBy(trials, keyFn) {
  const m = new Map();
  for (const t of trials) {
    const k = keyFn(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return m;
}

async function runMode(mode) {
  const labelMap = {
    false: '🅐 useFinancials: false (재무 안 씀)',
    current: '🅑 useFinancials: current (현재 latest, 미래 누출 가능)',
    asOf: '🅒 useFinancials: asOf (시점별 보정, Phase 2)',
  };
  console.log('\n\n╔══════════════════════════════════════════════════════════════════');
  console.log('║ ' + labelMap[mode]);
  console.log('╚══════════════════════════════════════════════════════════════════');
  const t0 = Date.now();
  const r = await ps.backtestTotalScore({
    daysBack: 60, forwardDays: FORWARD_DAYS,
    entryMode: 'nextOpen', applyAtrStop: true,
    useFinancials: mode,
  });
  console.log('elapsed:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('total scored:', r.allScored.length, '| trendRS pass:', r.trendRSTrials.length);

  // ─── 그룹별 단조성 (d5) ───
  console.log('\n[1] d5 그룹별 (단조성: 85+ > 75-84 > 65-74 > baselineTrendRS > baseline)');
  console.table([
    row('💎 85+ buy',           r.buyCandidates?.d5),
    row('👀 75-84 watch',       r.watchlist?.d5),
    row('👁 65-74 observe',     r.observation?.d5),
    row('75+ 누적',             r.score75Plus?.d5),
    row('65+ 누적',             r.score65Plus?.d5),
    row('baselineTrendRS',      r.baselineTrendRS?.d5),
    row('baseline',             r.baseline?.d5),
  ]);

  // ─── 65~74 outlier 제거 검증 ───
  if (r.observation?.d5 && r.observation.d5.n >= 20) {
    const obs = r.allScored.filter((t) => t.setupScore >= 65 && t.setupScore < 75);
    const trimmed = trimmedAggregate(obs, '65-74 trimmed', 5, r.aggregate, 0.05);
    console.log('\n[2] 65-74 outlier 제거 (winsorize 5%)');
    console.table([
      row('65-74 raw', r.observation.d5),
      row('65-74 trimmed (5%)', trimmed.d5),
    ]);
  }

  // ─── 시장별 ───
  console.log('\n[3] 시장별 — 65-74 알파 유지 확인 (d5)');
  const obs65 = r.allScored.filter((t) => t.setupScore >= 65 && t.setupScore < 75);
  for (const market of ['KOSPI', 'KOSDAQ']) {
    const subset = obs65.filter((t) => t.market === market);
    if (subset.length >= 5) {
      const agg = r.aggregate(subset, market);
      console.log('  ' + market + ':', JSON.stringify(row(market, agg.d5)));
    } else {
      console.log('  ' + market + ': n<5 (' + subset.length + ')');
    }
  }

  // ─── 시총별 65-74 ───
  console.log('\n[4] 시총별 — 65-74 알파 (d5)');
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

  // ─── 거래대금별 65-74 ───
  console.log('\n[5] 거래대금(20일평균)별 — 65-74 알파 (d5)');
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

  return r;
}

(async () => {
  console.log('================================================================');
  console.log('Phase 2 검증 — 3모드 (false / current / asOf) 비교');
  console.log('================================================================');

  const rFalse = await runMode(false);
  const rCurrent = await runMode("current");

  // asOf 는 history 캐시 있을 때만 의미 있음
  const fs = require('fs');
  const path = require('path');
  const histDir = path.join(__dirname, 'cache', 'dart-financials-history');
  const histCount = fs.existsSync(histDir) ? fs.readdirSync(histDir).length : 0;
  console.log('\n\n💡 history 캐시 진행률:', histCount, '종목');
  let rAsOf = null;
  if (histCount >= 100) {
    rAsOf = await runMode("asOf");
  } else {
    console.log('⚠️ history 캐시 부족 (seed 미완료) → asOf 모드 skip');
  }

  // 종합 비교 — 매수 후보 d5 / 65-74 d5
  console.log('\n\n================================================================');
  console.log('## 종합 비교 — 매수 후보 (85+) d5');
  console.log('================================================================');
  console.table([
    row('🅐 false',   rFalse.buyCandidates?.d5),
    row('🅑 current', rCurrent.buyCandidates?.d5),
    row('🅒 asOf',    rAsOf?.buyCandidates?.d5),
  ]);

  console.log('\n## 종합 비교 — 65-74 관찰 d5');
  console.table([
    row('🅐 false',   rFalse.observation?.d5),
    row('🅑 current', rCurrent.observation?.d5),
    row('🅒 asOf',    rAsOf?.observation?.d5),
  ]);

  console.log('\n## 종합 비교 — baselineTrendRS d5 (점수 무관, Trend+RS pass)');
  console.table([
    row('🅐 false',   rFalse.baselineTrendRS?.d5),
    row('🅑 current', rCurrent.baselineTrendRS?.d5),
    row('🅒 asOf',    rAsOf?.baselineTrendRS?.d5),
  ]);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
