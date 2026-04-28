// Phase 4 — 시간(regime) 분리 검증
//
// 시장 인덱스 fetch 우회 — baseline 의 월별 평균 수익률로 그 시기 regime 추정
//   강세장: 월별 baseline d5 평균 > +2%
//   약세장: < -1%
//   횡보장: 그 사이
//
// 5가지 분리:
//   1. 강세 / 약세 / 횡보 (시기별)
//   2. KOSPI 강세 (KOSPI baseline 우위 시기)
//   3. KOSDAQ 강세
//   4. 대형주 (시총 1조+) 우위
//   5. 중형주 (1000억-3000억) 우위
//
// 그룹: 65-74, 75-84, 85+, baselineTrendRS, baseline, 전체

require('dotenv').config({ quiet: true });
const path = require('path');
const ps = require('./pattern-screener');

const FORWARD_DAYS = [1, 5, 20];
const DAYS_BACK = 700;  // 2023-01 ~ 2026-04 (3년 데이터 전체 활용)
const CACHE_DIR = path.join(__dirname, 'cache', 'stock-charts-long');

function summarize(rets) {
  if (!rets.length) return null;
  const sorted = [...rets].sort((a, b) => a - b);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = sum(rets) / rets.length;
  const avgWin = wins.length ? sum(wins) / wins.length : 0;
  const avgLoss = losses.length ? sum(losses) / losses.length : 0;
  const pf = losses.length ? sum(wins) / Math.abs(sum(losses)) : (wins.length ? Infinity : 0);
  const wl = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : (avgWin > 0 ? Infinity : 0);
  return {
    n: rets.length,
    mean: +(mean * 100).toFixed(2),
    median: +(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(2),
    win: Math.round(wins.length / rets.length * 100),
    avgWin: +(avgWin * 100).toFixed(2),
    avgLoss: +(avgLoss * 100).toFixed(2),
    wl: +wl.toFixed(2),
    pf: +pf.toFixed(2),
    worst: +(sorted[0] * 100).toFixed(2),
  };
}

function trimmed(rets, pct = 0.05) {
  if (rets.length < 20) return null;
  const sorted = [...rets].sort((a, b) => a - b);
  const cl = Math.floor(sorted.length * pct);
  const ch = Math.ceil(sorted.length * (1 - pct));
  return summarize(sorted.slice(cl, ch));
}

function row(label, s, t = null) {
  if (!s) return { group: label, n: 0 };
  return {
    group: label, n: s.n,
    mean: s.mean, median: s.median, win: s.win,
    avgW: s.avgWin, avgL: s.avgLoss, wl: s.wl, pf: s.pf, worst: s.worst,
    trMean: t?.mean, trPF: t?.pf,
  };
}

(async () => {
  console.log('================================================================');
  console.log('Phase 4 — 시간(regime) 분리 검증');
  console.log('================================================================');

  // ─── 백테스트 풀 1번 — useFinancials asOf, 250일 ───
  const r = await ps.backtestTotalScore({
    daysBack: DAYS_BACK,
    forwardDays: FORWARD_DAYS,
    entryMode: 'nextOpen',
    applyAtrStop: true,
    useFinancials: 'asOf',
    cacheDir: CACHE_DIR,
  });
  console.log('total scored:', r.allScored.length, '| trendRS:', r.trendRSTrials.length);
  console.log('전체 universe (필터 통과 모든 시점) baseline:', r.allTrials?.length || 'N/A');

  // ─── 1. baseline 월별 평균으로 regime 정의 ───
  // (baseline = filterStats 통과 모든 시점) — backtestTotalScore 가 별도 노출 안 함
  // → trendRS pool 의 entry month 별 평균 d5 사용 (universe 비슷)
  const allBaseline = []; // (date, d5)
  // backtestTotalScore.allTrials 노출 안 됨. 대신 r.baseline aggregate 만 있음.
  // trendRSTrials 가 가장 가까운 wide pool (Trend+RS pass) — universe regime 추정용.
  for (const t of r.trendRSTrials) {
    if (Number.isFinite(t.forward?.d5)) allBaseline.push({ date: t.date, ret: t.forward.d5 });
  }

  function monthOf(d) { return String(d).slice(0, 6); } // YYYYMM
  const monthMap = new Map();
  for (const t of allBaseline) {
    const m = monthOf(t.date);
    if (!monthMap.has(m)) monthMap.set(m, []);
    monthMap.get(m).push(t.ret);
  }
  const monthRegime = new Map();
  console.log('\n## 월별 baseline (trendRS 풀) d5 평균 — regime 정의');
  for (const m of [...monthMap.keys()].sort()) {
    const rets = monthMap.get(m);
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    let regime = 'sideways';
    if (mean > 0.02) regime = 'bull';
    else if (mean < -0.01) regime = 'bear';
    monthRegime.set(m, regime);
    console.log(`  ${m}: n=${rets.length}, mean=${(mean * 100).toFixed(2)}% → ${regime}`);
  }

  // 각 trial 에 regime 라벨링
  const labeled = r.allScored.map((t) => ({
    ...t,
    regime: monthRegime.get(monthOf(t.date)) || 'unknown',
  }));
  const labeledTrendRS = r.trendRSTrials.map((t) => ({
    ...t,
    regime: monthRegime.get(monthOf(t.date)) || 'unknown',
  }));

  // ─── 그룹 분류 헬퍼 ───
  function classify(t) {
    if (t.setupScore >= 75 && t.entryReady) return '85+';
    if (t.setupScore >= 75) return '75-84';
    if (t.setupScore >= 65) return '65-74';
    return null;
  }

  function aggGroup(trials, fwd) {
    const rets = trials.map((t) => t.forward?.[`d${fwd}`]).filter(Number.isFinite);
    return summarize(rets);
  }

  function tab(filter, label, fwd) {
    const allScoredFiltered = labeled.filter(filter);
    const trendRSFiltered = labeledTrendRS.filter(filter);
    const buy = allScoredFiltered.filter((t) => t.setupScore >= 75 && t.entryReady);
    const watch = allScoredFiltered.filter((t) => t.setupScore >= 75 && !t.entryReady);
    const obs = allScoredFiltered.filter((t) => t.setupScore >= 65 && t.setupScore < 75);
    const obsRets = obs.map((t) => t.forward?.[`d${fwd}`]).filter(Number.isFinite);
    const obsTrim = trimmed(obsRets);
    return [
      row('💎 85+',           aggGroup(buy, fwd)),
      row('👀 75-84',          aggGroup(watch, fwd)),
      row('👁 65-74',           aggGroup(obs, fwd), obsTrim),
      row('baselineTrendRS',  aggGroup(trendRSFiltered, fwd)),
    ];
  }

  // ─── 2. 강세/약세/횡보 ×  d1/d5/d20 ───
  for (const regime of ['bull', 'bear', 'sideways']) {
    console.log(`\n\n## REGIME = ${regime.toUpperCase()}`);
    for (const fwd of FORWARD_DAYS) {
      console.log(`\n### d${fwd} (${regime})`);
      console.table(tab((t) => t.regime === regime, regime, fwd));
    }
  }

  // ─── 3. KOSPI vs KOSDAQ ───
  console.log('\n\n## KOSPI / KOSDAQ 분리 — d5');
  for (const market of ['KOSPI', 'KOSDAQ']) {
    console.log(`\n### ${market} (d5)`);
    console.table(tab((t) => t.market === market, market, 5));
  }

  // ─── 4. 시총 구간별 ───
  console.log('\n\n## 시총 구간별 — d5');
  function mcGroup(t) {
    const mc = t.marketCap || 0;
    if (mc >= 1_000_000_000_000) return '1조+';
    if (mc >= 300_000_000_000) return '3000억-1조';
    if (mc >= 100_000_000_000) return '1000-3000억';
    return '<1000억';
  }
  for (const grp of ['1000-3000억', '3000억-1조', '1조+']) {
    console.log(`\n### ${grp} (d5)`);
    console.table(tab((t) => mcGroup(t) === grp, grp, 5));
  }

  // ─── 5. 거래대금 구간별 ───
  console.log('\n\n## 거래대금 구간별 — d5');
  function tvGroup(t) {
    const v = t.avg20Value || 0;
    if (v >= 30_000_000_000) return '300억+';
    if (v >= 10_000_000_000) return '100-300억';
    if (v >= 5_000_000_000) return '50-100억';
    return '<50억';
  }
  for (const grp of ['50-100억', '100-300억', '300억+']) {
    console.log(`\n### ${grp} (d5)`);
    console.table(tab((t) => tvGroup(t) === grp, grp, 5));
  }

  // ─── 판정 (사용자 4기준) ───
  console.log('\n\n================================================================');
  console.log('## 판정');
  console.log('================================================================');
  function obs65(filter) {
    const ts = labeled.filter((t) => filter(t) && t.setupScore >= 65 && t.setupScore < 75);
    const rets = ts.map((t) => t.forward?.d5).filter(Number.isFinite);
    return summarize(rets);
  }
  function trsAgg(filter) {
    const ts = labeledTrendRS.filter(filter);
    const rets = ts.map((t) => t.forward?.d5).filter(Number.isFinite);
    return summarize(rets);
  }
  const bullObs = obs65((t) => t.regime === 'bull');
  const bullTrs = trsAgg((t) => t.regime === 'bull');
  const bearObs = obs65((t) => t.regime === 'bear');
  const bearTrs = trsAgg((t) => t.regime === 'bear');
  const sideObs = obs65((t) => t.regime === 'sideways');
  const sideTrs = trsAgg((t) => t.regime === 'sideways');

  console.log('\n65-74 d5 vs baselineTrendRS d5 by regime:');
  console.log(`  bull:     ${bullObs?.mean ?? 'n/a'}% / PF ${bullObs?.pf ?? 'n/a'} vs trs ${bullTrs?.mean ?? 'n/a'}% / PF ${bullTrs?.pf ?? 'n/a'}`);
  console.log(`  bear:     ${bearObs?.mean ?? 'n/a'}% / PF ${bearObs?.pf ?? 'n/a'} vs trs ${bearTrs?.mean ?? 'n/a'}% / PF ${bearTrs?.pf ?? 'n/a'}`);
  console.log(`  sideways: ${sideObs?.mean ?? 'n/a'}% / PF ${sideObs?.pf ?? 'n/a'} vs trs ${sideTrs?.mean ?? 'n/a'}% / PF ${sideTrs?.pf ?? 'n/a'}`);

  const judgments = [];
  if (bullObs && bullTrs) {
    if (bullObs.mean < bullTrs.mean) {
      judgments.push('🚨 강세장에서도 65-74 가 baselineTrendRS 보다 나쁨 → 모델 폐기');
    } else {
      judgments.push('✓ 강세장에서는 65-74 가 baselineTrendRS 보다 우위');
    }
  }
  if (bullObs && bearObs && bullObs.mean > bearObs.mean + 2) {
    judgments.push('⚠️ 강세장에서만 좋고 약세장 깨짐 → market regime filter 도입 검토');
  }
  if ((bullObs?.mean ?? 0) <= 0 && (bearObs?.mean ?? 0) <= 0 && (sideObs?.mean ?? 0) <= 0) {
    judgments.push('🚨 모든 regime 에서 음의 알파 → 모델 전면 재설계 (🅐) 필요');
  }
  console.log('\n판정:');
  for (const j of judgments) console.log('  ' + j);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
