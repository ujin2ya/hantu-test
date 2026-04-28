// CSB 실거래형 백테스트 v2 — stop 완화 실험
//
// 7그룹:
//   A. day0 no stop
//   B. trigger no stop
//   C. trigger + tight stop  (max(-7%, -ATR×1.5) — 가까운 쪽, intraday low)
//   D. day0 + relaxed stop  (clamp(ATR×2.5, 8%, 12%), intraday low)
//   E. trigger + relaxed stop (intraday)
//   F. day0 + structure stop (20MA 종가이탈 2일 OR 20일 저점 종가이탈)
//   G. trigger + structure stop
//
// 추가 비교 (intraday vs close):
//   D-close. day0 + relaxed stop (close 기준)
//   E-close. trigger + relaxed stop (close 기준)
//
// 진입 룰 (trigger): 후보 발생 후 3거래일 안
//   1) 종가 > 전일 고가
//   2) 거래대금 ≥ 20일 평균
//   3) 종가 ≥ ma20 OR ma20 -2% 이내

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const FORWARD_DAYS = [5, 10, 20, 40];
const MFE_DAYS = [20, 40];
const HIT_DAYS = [10, 20];
const HIT_THRESHOLD = 0.10;
const TRIGGER_LOOKAHEAD = 3;
const DAYS_BACK = 700;

const STOP_TIGHT_PCT = 0.07;
const STOP_TIGHT_ATR_MULT = 1.5;
const STOP_RELAXED_ATR_MULT = 2.5;
const STOP_RELAXED_MIN = 0.08;
const STOP_RELAXED_MAX = 0.12;

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
function aggKey(arr, k) { return summarize(arr.map((t) => t[k]).filter(Number.isFinite)); }
function hitRate(arr, k) {
  const xs = arr.map((t) => t[k]).filter((v) => v === true || v === false);
  if (!xs.length) return null;
  const h = xs.filter((v) => v === true).length;
  return { n: xs.length, rate: Math.round((h / xs.length) * 100) };
}
function sma(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mcG(mc) {
  if (mc >= 1_000_000_000_000) return '1조+';
  if (mc >= 300_000_000_000) return '3000억-1조';
  if (mc >= 100_000_000_000) return '1000-3000억';
  if (mc >= 50_000_000_000) return '500-1000억';
  return '<500억';
}

// stop 평가 — entry 이후 forward 윈도우 별 stop hit 검사
//   stopType: 'none' | 'tight' | 'relaxed-intra' | 'relaxed-close' | 'structure'
//   atrAbs : ATR 절대값 (KRW)
//   stopPriceTight = max(entry*(1-7%), entry - atr*1.5)
//   stopPriceRelaxed = entry * (1 - clamp(atrAbs/entry * 2.5, 0.08, 0.12))
function applyStop(rows, entryIdx, entryPrice, atrAbs, stopType) {
  const result = {};
  const atrPct = atrAbs > 0 ? atrAbs / entryPrice : 0;

  let stopPrice = null;
  if (stopType === 'tight') {
    const fromPct = entryPrice * (1 - STOP_TIGHT_PCT);
    const fromATR = entryPrice - atrAbs * STOP_TIGHT_ATR_MULT;
    stopPrice = Math.max(fromPct, fromATR);
  } else if (stopType === 'relaxed-intra' || stopType === 'relaxed-close') {
    const stopPctFinal = clamp(atrPct * STOP_RELAXED_ATR_MULT, STOP_RELAXED_MIN, STOP_RELAXED_MAX);
    stopPrice = entryPrice * (1 - stopPctFinal);
  }

  // forward 별 stop hit 검사 + 수익률 계산
  let stoppedAtIdx = null;
  let stopReturn = null;

  // structure stop: 진입 이후 매일 검사
  //   조건 1: 20일선 종가 이탈 후 2거래일 연속 회복 실패
  //   조건 2: 20일 저점 종가 이탈
  // 둘 중 발생 시 청산 (해당일 종가)
  if (stopType === 'structure') {
    let belowMaCount = 0;
    for (let j = entryIdx + 1; j <= entryIdx + 40; j++) {
      const r = rows[j]; if (!r) break;
      const close = r.close;
      const start = Math.max(0, j - 19);
      const ma20 = sma(rows.slice(start, j + 1).map((x) => x.close));
      const low20 = Math.min(...rows.slice(start, j + 1).map((x) => x.low || x.close));
      // 조건 2: 20일 저점 종가 이탈
      if (close < low20 * 0.999) {
        stoppedAtIdx = j;
        stopReturn = close / entryPrice - 1;
        break;
      }
      // 조건 1: ma20 종가 이탈 + 2일 연속
      if (ma20 && close < ma20) belowMaCount++;
      else belowMaCount = 0;
      if (belowMaCount >= 2) {
        stoppedAtIdx = j;
        stopReturn = close / entryPrice - 1;
        break;
      }
    }
  } else if (stopType === 'tight' || stopType === 'relaxed-intra') {
    // intraday low 기준
    for (let j = entryIdx + 1; j <= entryIdx + 40; j++) {
      const r = rows[j]; if (!r) break;
      const low = r.low || r.close;
      if (low <= stopPrice) {
        stoppedAtIdx = j;
        stopReturn = stopPrice / entryPrice - 1;
        break;
      }
    }
  } else if (stopType === 'relaxed-close') {
    // close 기준
    for (let j = entryIdx + 1; j <= entryIdx + 40; j++) {
      const r = rows[j]; if (!r) break;
      if (r.close <= stopPrice) {
        stoppedAtIdx = j;
        stopReturn = r.close / entryPrice - 1;
        break;
      }
    }
  }

  result.stopHit = stoppedAtIdx != null;
  result.stoppedAtIdx = stoppedAtIdx;
  result.stopReturn = stopReturn;

  for (const fwd of FORWARD_DAYS) {
    const targetIdx = entryIdx + fwd;
    if (stoppedAtIdx != null && stoppedAtIdx <= targetIdx) {
      result[`d${fwd}`] = stopReturn;
      result[`d${fwd}_stopped`] = true;
    } else {
      const fut = rows[targetIdx];
      if (fut && fut.close > 0) result[`d${fwd}`] = fut.close / entryPrice - 1;
      result[`d${fwd}_stopped`] = false;
    }
  }

  // mfe/mae (stop hit 무관 — full window high/low)
  for (const win of MFE_DAYS) {
    let maxH = 0, minL = Infinity;
    const endIdx = stoppedAtIdx != null && stoppedAtIdx < entryIdx + win ? stoppedAtIdx : entryIdx + win;
    for (let j = entryIdx + 1; j <= endIdx; j++) {
      const r = rows[j]; if (!r) break;
      const h = r.high || r.close;
      const l = r.low || r.close;
      if (h > maxH) maxH = h;
      if (l < minL) minL = l;
    }
    result[`mfe${win}`] = maxH > 0 ? maxH / entryPrice - 1 : null;
    result[`mae${win}`] = minL < Infinity ? minL / entryPrice - 1 : null;
  }

  // hit10/hit20 (stop hit 까지만 카운트)
  let maxRun = 0;
  let hitAt = null;
  const endHit = stoppedAtIdx != null ? Math.min(stoppedAtIdx, entryIdx + Math.max(...HIT_DAYS)) : entryIdx + Math.max(...HIT_DAYS);
  for (let j = entryIdx + 1; j <= endHit; j++) {
    const r = rows[j]; if (!r) break;
    const h = r.high || r.close;
    if (h > maxRun) maxRun = h;
    if (hitAt == null && maxRun / entryPrice - 1 >= HIT_THRESHOLD) hitAt = j - entryIdx;
  }
  for (const win of HIT_DAYS) {
    result[`hit${win}`] = hitAt != null && hitAt <= win;
  }

  return result;
}

const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

(async () => {
  console.log('================================================================');
  console.log('CSB 실거래 v2 — 7그룹 stop 완화 실험');
  console.log('================================================================');
  console.log(`tight: max(-${STOP_TIGHT_PCT*100}%, -ATR×${STOP_TIGHT_ATR_MULT})`);
  console.log(`relaxed: clamp(ATR×${STOP_RELAXED_ATR_MULT}, ${STOP_RELAXED_MIN*100}%, ${STOP_RELAXED_MAX*100}%)`);
  console.log(`structure: 20MA 종가이탈 2일 OR 20일저점 종가이탈\n`);

  console.log('[1/2] trial 수집…');
  const codes = fs.readdirSync(FLOW_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

  // 7 + 2 그룹
  const G = { A: [], B: [], C: [], D: [], E: [], F: [], G: [], Dc: [], Ec: [] };
  const allTrials = [];
  const compTrials = [];
  let candidateCount = 0;
  let triggerCount = 0;

  for (let ci = 0; ci < codes.length; ci++) {
    const code = codes[ci];
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
    const N = chartRows.length;
    const startIdx = Math.max(60, N - DAYS_BACK);
    const maxFwd = Math.max(...FORWARD_DAYS) + TRIGGER_LOOKAHEAD;

    for (let t = startIdx; t < N - maxFwd - 1; t++) {
      const today = chartRows[t];
      const close = today.close;
      if (!(close > 0)) continue;

      const start20 = Math.max(0, t - 19);
      const last20 = chartRows.slice(start20, t + 1);
      const avg20Value = last20.reduce((s, x) => s + (x.valueApprox || 0), 0) / last20.length;
      if (avg20Value < 5_000_000_000) continue;

      // baseline 수집 (참고)
      const baseTrial = { code, date: today.date, market: meta.market, marketCap: meta.marketValue };
      const f20 = chartRows[t + 20], f40 = chartRows[t + 40];
      if (f20 && f20.close > 0) baseTrial.d20 = f20.close / close - 1;
      if (f40 && f40.close > 0) baseTrial.d40 = f40.close / close - 1;
      allTrials.push(baseTrial);
      try {
        const u3 = ps.flowLeadV3CompressionUniverse(chartRows.slice(0, t + 1), meta);
        if (u3 && u3.passed) compTrials.push(baseTrial);
      } catch (_) {}

      // CSB 4-tag 검사
      let flowsUpTo = null;
      if (flowDateSet.has(today.date)) {
        flowsUpTo = flowRows.filter((f) => f.date <= today.date);
        if (flowsUpTo.length < 20) flowsUpTo = null;
      }
      let sc;
      try { sc = ps.calculateCompressionSupportBreakoutScore(chartRows, flowsUpTo, meta, t); } catch (_) { sc = null; }
      if (!sc || !sc.passed) continue;
      const stages = sc.stages || {};
      if (!(stages.compressionFormed && stages.supportConfirmed && stages.breakoutReady && stages.volumeReturning)) continue;

      candidateCount++;
      const tag = { code, date: today.date, market: meta.market, marketCap: meta.marketValue };

      // ATR @ candidate (day0 평가용)
      const atr0 = ps.computeATR(chartRows, t, 14);
      const atr0Abs = atr0?.atr || 0;

      // ─── A. day0 no stop ───
      const aRes = applyStop(chartRows, t, close, atr0Abs, 'none');
      G.A.push({ ...tag, atrPct: atr0Abs / close, ...aRes });

      // ─── D. day0 + relaxed (intraday) ───
      const dRes = applyStop(chartRows, t, close, atr0Abs, 'relaxed-intra');
      G.D.push({ ...tag, atrPct: atr0Abs / close, ...dRes });

      // ─── D-close. day0 + relaxed (close) ───
      const dcRes = applyStop(chartRows, t, close, atr0Abs, 'relaxed-close');
      G.Dc.push({ ...tag, atrPct: atr0Abs / close, ...dcRes });

      // ─── F. day0 + structure ───
      const fRes = applyStop(chartRows, t, close, atr0Abs, 'structure');
      G.F.push({ ...tag, atrPct: atr0Abs / close, ...fRes });

      // ─── trigger 검사 ───
      let entryIdx = null;
      let entryPrice = null;
      for (let i = 1; i <= TRIGGER_LOOKAHEAD; i++) {
        const j = t + i;
        const r = chartRows[j];
        const prev = chartRows[j - 1];
        if (!r || !prev) break;
        const start = Math.max(0, j - 19);
        const ma20 = sma(chartRows.slice(start, j + 1).map((x) => x.close));
        const avg20Val = sma(chartRows.slice(start, j + 1).map((x) => x.valueApprox || 0));
        const cond1 = r.close > prev.high;
        const cond2 = (r.valueApprox || 0) >= avg20Val;
        const cond3 = ma20 ? r.close >= ma20 * 0.98 : true;
        if (cond1 && cond2 && cond3) {
          entryIdx = j;
          entryPrice = r.close;
          break;
        }
      }
      if (entryIdx == null) continue;
      triggerCount++;

      const atrT = ps.computeATR(chartRows, entryIdx, 14);
      const atrTAbs = atrT?.atr || 0;
      const trTag = { ...tag, entryDate: chartRows[entryIdx].date, atrPct: atrTAbs / entryPrice };

      G.B.push({ ...trTag, ...applyStop(chartRows, entryIdx, entryPrice, atrTAbs, 'none') });
      G.C.push({ ...trTag, ...applyStop(chartRows, entryIdx, entryPrice, atrTAbs, 'tight') });
      G.E.push({ ...trTag, ...applyStop(chartRows, entryIdx, entryPrice, atrTAbs, 'relaxed-intra') });
      G.Ec.push({ ...trTag, ...applyStop(chartRows, entryIdx, entryPrice, atrTAbs, 'relaxed-close') });
      G.G.push({ ...trTag, ...applyStop(chartRows, entryIdx, entryPrice, atrTAbs, 'structure') });
    }

    if ((ci + 1) % 50 === 0 || ci === codes.length - 1) {
      console.log(`  ${ci + 1}/${codes.length}: cand=${candidateCount}, trigger=${triggerCount}`);
    }
  }
  console.log(`\n→ 4-tag 후보: ${candidateCount}, trigger 통과: ${triggerCount} (${candidateCount > 0 ? Math.round(triggerCount/candidateCount*100) : 0}%)`);
  console.log(`  baselineAll=${allTrials.length}, compressionBaseline=${compTrials.length}`);

  // regime
  console.log('\n[2/2] regime + 출력…');
  const monthOf = (d) => String(d).slice(0, 6);
  const monthMap = new Map();
  for (const tr of allTrials) {
    if (!Number.isFinite(tr.d20)) continue;
    const m = monthOf(tr.date);
    if (!monthMap.has(m)) monthMap.set(m, []);
    monthMap.get(m).push(tr.d20);
  }
  const monthRegime = new Map();
  for (const m of [...monthMap.keys()].sort()) {
    const arr = monthMap.get(m);
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    let regime = 'sideways';
    if (mean > 0.04) regime = 'bull';
    else if (mean < -0.02) regime = 'bear';
    monthRegime.set(m, regime);
  }
  for (const arrName of Object.keys(G)) {
    for (const tr of G[arrName]) tr.regime = monthRegime.get(monthOf(tr.date)) || 'unknown';
  }
  for (const tr of allTrials) tr.regime = monthRegime.get(monthOf(tr.date)) || 'unknown';
  for (const tr of compTrials) tr.regime = monthRegime.get(monthOf(tr.date)) || 'unknown';

  function dump(label, trials) {
    const d20 = aggKey(trials, 'd20'), d40 = aggKey(trials, 'd40');
    const mfe20 = aggKey(trials, 'mfe20'), mfe40 = aggKey(trials, 'mfe40');
    const mae20 = aggKey(trials, 'mae20'), mae40 = aggKey(trials, 'mae40');
    const hit10 = hitRate(trials, 'hit10'), hit20 = hitRate(trials, 'hit20');
    const stopH = hitRate(trials, 'stopHit');
    return {
      group: label, n: d20?.n || 0,
      d20: d20?.mean, d40: d40?.mean,
      d20_med: d20?.median, win: d20?.win + '%', PF: d20?.pf, worst: d20?.worst,
      mfe20: mfe20?.mean, mfe40: mfe40?.mean, mae20: mae20?.mean, mae40: mae40?.mean,
      hit10: hit10 ? `${hit10.rate}%` : null,
      hit20: hit20 ? `${hit20.rate}%` : null,
      stopHit: stopH ? `${stopH.rate}%` : null,
    };
  }

  // 1. 7그룹 + relaxed close 비교
  console.log('\n\n## 1. 9그룹 전체 비교');
  console.table([
    dump('A. day0 no stop', G.A),
    dump('B. trigger no stop', G.B),
    dump('C. trigger + tight', G.C),
    dump('D. day0 + relaxed (intra)', G.D),
    dump('Dc. day0 + relaxed (close)', G.Dc),
    dump('E. trigger + relaxed (intra)', G.E),
    dump('Ec. trigger + relaxed (close)', G.Ec),
    dump('F. day0 + structure', G.F),
    dump('G. trigger + structure', G.G),
    dump('baselineAll', allTrials),
    dump('compressionBaseline', compTrials),
  ]);

  // 2. 장세별
  console.log('\n\n## 2. 장세별 (7 그룹 — bull/bear/sideways)');
  for (const reg of ['bull', 'bear', 'sideways']) {
    console.log(`\n### ${reg}`);
    console.table([
      dump('A. day0 no stop',     G.A.filter((t) => t.regime === reg)),
      dump('B. trigger no stop',  G.B.filter((t) => t.regime === reg)),
      dump('C. trigger + tight',  G.C.filter((t) => t.regime === reg)),
      dump('D. day0 + relaxed',   G.D.filter((t) => t.regime === reg)),
      dump('E. trigger + relaxed',G.E.filter((t) => t.regime === reg)),
      dump('F. day0 + structure', G.F.filter((t) => t.regime === reg)),
      dump('G. trigger + struct', G.G.filter((t) => t.regime === reg)),
      dump('baselineAll',         allTrials.filter((t) => t.regime === reg)),
    ]);
  }

  // 3. 시총 구간별 (메인 후보 = E. trigger + relaxed)
  console.log('\n\n## 3. 시총 구간별 — E. trigger + relaxed (intraday)');
  console.table([
    dump('500-1000억',  G.E.filter((t) => mcG(t.marketCap) === '500-1000억')),
    dump('1000-3000억', G.E.filter((t) => mcG(t.marketCap) === '1000-3000억')),
    dump('3000억-1조',  G.E.filter((t) => mcG(t.marketCap) === '3000억-1조')),
    dump('1조+',        G.E.filter((t) => mcG(t.marketCap) === '1조+')),
  ]);

  console.log('\n## 3b. 시총 구간별 — D. day0 + relaxed (intraday)');
  console.table([
    dump('500-1000억',  G.D.filter((t) => mcG(t.marketCap) === '500-1000억')),
    dump('1000-3000억', G.D.filter((t) => mcG(t.marketCap) === '1000-3000억')),
    dump('3000억-1조',  G.D.filter((t) => mcG(t.marketCap) === '3000억-1조')),
    dump('1조+',        G.D.filter((t) => mcG(t.marketCap) === '1조+')),
  ]);

  console.log('\n## 3c. 시총 구간별 — A. day0 no stop');
  console.table([
    dump('500-1000억',  G.A.filter((t) => mcG(t.marketCap) === '500-1000억')),
    dump('1000-3000억', G.A.filter((t) => mcG(t.marketCap) === '1000-3000억')),
    dump('3000억-1조',  G.A.filter((t) => mcG(t.marketCap) === '3000억-1조')),
    dump('1조+',        G.A.filter((t) => mcG(t.marketCap) === '1조+')),
  ]);

  // 4. 성공 기준 (각 그룹)
  console.log('\n\n================================================================');
  console.log('## 성공 기준 체크 — 그룹별');
  console.log('================================================================');
  console.log('  기준: win ≥ 55% / bull win ≥ 60% / PF ≥ 1.5 / worst ≥ -12% / stopHit ≤ 30~40% / d20·d40 baseline 우위');

  const criteria = [
    { label: 'A. day0 no stop',      arr: G.A },
    { label: 'B. trigger no stop',   arr: G.B },
    { label: 'C. trigger + tight',   arr: G.C },
    { label: 'D. day0 + relaxed(I)', arr: G.D },
    { label: 'Dc. day0 + relaxed(C)',arr: G.Dc },
    { label: 'E. trigger + relax(I)',arr: G.E },
    { label: 'Ec. trig + relax(C)',  arr: G.Ec },
    { label: 'F. day0 + structure',  arr: G.F },
    { label: 'G. trig + structure',  arr: G.G },
  ];
  const crRows = criteria.map(({ label, arr }) => {
    const d20 = aggKey(arr, 'd20'), d40 = aggKey(arr, 'd40');
    const bullD20 = aggKey(arr.filter(t => t.regime === 'bull'), 'd20');
    const stopH = hitRate(arr, 'stopHit');
    const winOK = (d20?.win || 0) >= 55 ? '✅' : '✗';
    const bullOK = (bullD20?.win || 0) >= 60 ? '✅' : '✗';
    const pfOK = (d20?.pf || 0) >= 1.5 ? '✅' : '✗';
    const worstOK = (d20?.worst || -100) >= -12 ? '✅' : '✗';
    const stopOK = (!stopH || stopH.rate <= 40) ? '✅' : '✗';
    const baseAllD20 = aggKey(allTrials, 'd20')?.mean || 0;
    const baseOK = (d20?.mean || -100) > baseAllD20 ? '✅' : '✗';
    return {
      group: label, n: d20?.n,
      win: `${d20?.win}% ${winOK}`,
      bullWin: `${bullD20?.win || '-'}% ${bullOK}`,
      PF: `${d20?.pf} ${pfOK}`,
      worst: `${d20?.worst}% ${worstOK}`,
      stopHit: stopH ? `${stopH.rate}% ${stopOK}` : 'n/a',
      'd20 vs all': `${d20?.mean} vs ${baseAllD20.toFixed(2)} ${baseOK}`,
      d40: d40?.mean,
    };
  });
  console.table(crRows);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
