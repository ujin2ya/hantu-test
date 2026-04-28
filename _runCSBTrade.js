// CSB 실거래형 백테스트
//
// 대상: CSB 4개 stage tag 모두 통과 종목 (압축+지지+돌파+거래대금)
//
// 진입 룰 (후보 발생 후 3거래일 안):
//   1) 종가 > 전일 고가 (돌파)
//   2) 거래대금 ≥ 20일 평균 거래대금
//   3) 종가 ≥ ma20 OR ma20 -2% 이내
//   → 조건 충족일 종가 = 진입가
//
// 손절 룰:
//   - 진입가 -7% OR ATR×1.5 (가까운 쪽 = 더 높은 손절가)
//   - ATR% ≥ 16% 이면 "highVol" 그룹 별도 분리
//   - intraday low ≤ stopPrice → stop hit (체결가 = stopPrice 근사)
//
// 비교 그룹:
//   A. 후보 발생일 종가 매수 (stop 없음, no trigger)         = csbDay0
//   B. 트리거 후 매수 (stop 없음)                             = csbTrigger
//   C. 트리거 + ATR stop 적용 (메인)                          = csbTriggerStop
//   D. 트리거 + ATR stop, ATR%≥16 분리                        = csbTriggerStopLowVol / HighVol
//   E. baselineAll                                              (참고)
//   F. compressionBaseline                                       (참고)
//
// 메트릭: d5/d10/d20/d40 close return, MFE20/40, MAE20/40, hit10/hit20, stopHitRate, mean/median/win/PF/worst
// 장세별: bull / bear / sideways

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
const STOP_PCT = 0.07;
const STOP_ATR_MULT = 1.5;
const HIGH_VOL_THRESHOLD = 0.16;

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
function aggKey(trials, k) { return summarize(trials.map((t) => t[k]).filter(Number.isFinite)); }
function row(label, s) {
  if (!s) return { group: label, n: 0 };
  return { group: label, n: s.n, mean: s.mean, median: s.median, win: s.win, pf: s.pf, worst: s.worst };
}
function hitRate(trials, k) {
  const arr = trials.map((t) => t[k]).filter((v) => v === true || v === false);
  if (!arr.length) return null;
  const hits = arr.filter((v) => v === true).length;
  return { n: arr.length, rate: Math.round((hits / arr.length) * 100) };
}
function sma(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

(async () => {
  console.log('================================================================');
  console.log('CSB 실거래형 백테스트 — 4-tag + trigger + ATR stop');
  console.log('================================================================');
  console.log(`triggerLookahead=${TRIGGER_LOOKAHEAD}일, stop = max(-${STOP_PCT * 100}%, -ATR×${STOP_ATR_MULT}), highVol cutoff ATR%≥${HIGH_VOL_THRESHOLD * 100}\n`);

  // ─── compressionBaseline & baselineAll 참고용 백테스트 (단순 close return) ───
  console.log('[1/3] 참고 baseline 호출…');
  const baselineRows = [];
  const compRows = [];

  console.log('\n[2/3] CSB 4-tag 후보 + trigger + stop 처리…');
  const codes = fs.readdirSync(FLOW_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

  // trial 그룹
  const csbDay0 = [];          // A: 후보 발생일 매수, no stop
  const csbTrigger = [];       // B: 트리거 후 매수, no stop
  const csbTriggerStop = [];   // C: 트리거 + stop
  const csbStopHighVol = [];   // D-1: ATR% ≥ 16
  const csbStopLowVol = [];    // D-2: ATR% < 16
  const noTriggerCount = { total: 0, byRegime: { bull: 0, bear: 0, sideways: 0 } };

  // baseline
  const allTrials = [];
  const compTrials = [];

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

      // baselineAll, compressionBaseline 동시 수집
      const start20 = Math.max(0, t - 19);
      const last20 = chartRows.slice(start20, t + 1);
      const avg20Value = last20.reduce((s, x) => s + (x.valueApprox || 0), 0) / last20.length;
      if (avg20Value < 5_000_000_000) continue;

      const baseTrial = { code, date: today.date, market: meta.market, marketCap: meta.marketValue };
      const fut20 = chartRows[t + 20];
      const fut40 = chartRows[t + 40];
      if (fut20 && fut20.close > 0) baseTrial.d20 = fut20.close / close - 1;
      if (fut40 && fut40.close > 0) baseTrial.d40 = fut40.close / close - 1;
      allTrials.push(baseTrial);

      let compPass = false;
      try {
        const u3 = ps.flowLeadV3CompressionUniverse(chartRows.slice(0, t + 1), meta);
        compPass = u3 && u3.passed;
      } catch (_) {}
      if (compPass) compTrials.push(baseTrial);

      // CSB 4-tag 통과 검사
      let flowsUpTo = null;
      if (flowDateSet.has(today.date)) {
        flowsUpTo = flowRows.filter((f) => f.date <= today.date);
        if (flowsUpTo.length < 20) flowsUpTo = null;
      }
      let sc;
      try { sc = ps.calculateCompressionSupportBreakoutScore(chartRows, flowsUpTo, meta, t); } catch (_) { sc = null; }
      if (!sc || !sc.passed) continue;
      const stages = sc.stages || {};
      const allFour = stages.compressionFormed && stages.supportConfirmed && stages.breakoutReady && stages.volumeReturning;
      if (!allFour) continue;

      // ─── A: 후보 발생일 종가 매수, no stop ───
      const day0 = { code, date: today.date, market: meta.market, marketCap: meta.marketValue };
      for (const fwd of FORWARD_DAYS) {
        const fut = chartRows[t + fwd];
        if (fut && fut.close > 0) day0[`d${fwd}`] = fut.close / close - 1;
      }
      // mfe/hit
      let runMaxHigh = 0;
      for (const win of MFE_DAYS) {
        for (let j = t + 1; j <= t + win; j++) {
          const r = chartRows[j];
          if (!r) break;
          const h = r.high || r.close;
          if (h > runMaxHigh) runMaxHigh = h;
        }
        day0[`mfe${win}`] = runMaxHigh > 0 ? runMaxHigh / close - 1 : null;
      }
      let runMinLow = Infinity;
      for (const win of MFE_DAYS) {
        for (let j = t + 1; j <= t + win; j++) {
          const r = chartRows[j];
          if (!r) break;
          const l = r.low || r.close;
          if (l < runMinLow) runMinLow = l;
        }
        day0[`mae${win}`] = runMinLow < Infinity ? runMinLow / close - 1 : null;
      }
      let maxHitDay = 0;
      const hitsAt = {};
      for (let j = t + 1; j <= t + Math.max(...HIT_DAYS); j++) {
        const r = chartRows[j];
        if (!r) break;
        const h = r.high || r.close;
        if (h > maxHitDay) maxHitDay = h;
        const ret = maxHitDay / close - 1;
        if (hitsAt['hit'] == null && ret >= HIT_THRESHOLD) hitsAt['hit'] = j - t;
      }
      for (const win of HIT_DAYS) {
        day0[`hit${win}`] = hitsAt['hit'] != null && hitsAt['hit'] <= win;
      }
      csbDay0.push(day0);

      // ─── B/C: 트리거 검색 ───
      let entryIdx = null;
      let entryPrice = null;
      for (let i = 1; i <= TRIGGER_LOOKAHEAD; i++) {
        const j = t + i;
        const r = chartRows[j];
        const prev = chartRows[j - 1];
        if (!r || !prev) break;
        // ma20 at j
        const start = Math.max(0, j - 19);
        const ma20 = sma(chartRows.slice(start, j + 1).map((x) => x.close));
        // 20일 평균 거래대금 (j 기준)
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
      if (entryIdx == null) {
        noTriggerCount.total++;
        continue;
      }

      // ATR (entryIdx 기준)
      const atrObj = ps.computeATR(chartRows, entryIdx, 14);
      const atrAbs = atrObj?.atr || 0;
      const atrPct = atrAbs > 0 ? atrAbs / entryPrice : 0;
      const stopFromPct = entryPrice * (1 - STOP_PCT);
      const stopFromATR = entryPrice - atrAbs * STOP_ATR_MULT;
      // 가까운 쪽 = 더 높은 가격
      const stopPrice = Math.max(stopFromPct, stopFromATR);

      // ─── B: 트리거 후 매수, no stop ───
      const trig = { code, date: today.date, entryDate: chartRows[entryIdx].date, market: meta.market, marketCap: meta.marketValue, atrPct };
      for (const fwd of FORWARD_DAYS) {
        const fut = chartRows[entryIdx + fwd];
        if (fut && fut.close > 0) trig[`d${fwd}`] = fut.close / entryPrice - 1;
      }
      let runMaxH = 0, runMinL = Infinity;
      for (const win of MFE_DAYS) {
        for (let j = entryIdx + 1; j <= entryIdx + win; j++) {
          const r = chartRows[j];
          if (!r) break;
          const h = r.high || r.close;
          const l = r.low || r.close;
          if (h > runMaxH) runMaxH = h;
          if (l < runMinL) runMinL = l;
        }
        trig[`mfe${win}`] = runMaxH > 0 ? runMaxH / entryPrice - 1 : null;
        trig[`mae${win}`] = runMinL < Infinity ? runMinL / entryPrice - 1 : null;
      }
      let maxHit = 0;
      const trHits = {};
      for (let j = entryIdx + 1; j <= entryIdx + Math.max(...HIT_DAYS); j++) {
        const r = chartRows[j];
        if (!r) break;
        const h = r.high || r.close;
        if (h > maxHit) maxHit = h;
        const ret = maxHit / entryPrice - 1;
        if (trHits['hit'] == null && ret >= HIT_THRESHOLD) trHits['hit'] = j - entryIdx;
      }
      for (const win of HIT_DAYS) {
        trig[`hit${win}`] = trHits['hit'] != null && trHits['hit'] <= win;
      }
      csbTrigger.push(trig);

      // ─── C: 트리거 + ATR stop ───
      const stopT = { ...trig };
      // 윈도우별 stop hit 검사
      for (const fwd of FORWARD_DAYS) {
        let stopHitDay = null;
        for (let j = entryIdx + 1; j <= entryIdx + fwd; j++) {
          const r = chartRows[j];
          if (!r) break;
          const low = r.low || r.close;
          if (low <= stopPrice) {
            stopHitDay = j;
            break;
          }
        }
        if (stopHitDay != null) {
          stopT[`d${fwd}`] = stopPrice / entryPrice - 1;
          stopT[`d${fwd}_stopped`] = true;
        } else {
          stopT[`d${fwd}_stopped`] = false;
        }
      }
      // 전체 stop hit (40일 안)
      let anyStop = false;
      for (let j = entryIdx + 1; j <= entryIdx + 40; j++) {
        const r = chartRows[j];
        if (!r) break;
        if ((r.low || r.close) <= stopPrice) { anyStop = true; break; }
      }
      stopT.stopHit = anyStop;
      stopT.stopPrice = stopPrice;
      stopT.stopReturn = stopPrice / entryPrice - 1;

      csbTriggerStop.push(stopT);
      if (atrPct >= HIGH_VOL_THRESHOLD) csbStopHighVol.push(stopT);
      else csbStopLowVol.push(stopT);
    }

    if ((ci + 1) % 50 === 0 || ci === codes.length - 1) {
      console.log(`  ${ci + 1}/${codes.length}: csbDay0=${csbDay0.length}, csbTrigger=${csbTrigger.length}, csbStop=${csbTriggerStop.length}, noTrigger=${noTriggerCount.total}`);
    }
  }
  console.log(`\n→ csbDay0=${csbDay0.length}, csbTrigger=${csbTrigger.length}, csbTriggerStop=${csbTriggerStop.length}, noTrigger=${noTriggerCount.total} (트리거 못 잡음)`);
  console.log(`  csbStopLowVol=${csbStopLowVol.length} (ATR%<16), csbStopHighVol=${csbStopHighVol.length} (ATR%≥16)`);
  console.log(`  baselineAll=${allTrials.length}, compressionBaseline=${compTrials.length}`);
  const triggerHitRate = csbDay0.length > 0 ? Math.round((csbTrigger.length / csbDay0.length) * 100) : 0;
  console.log(`  trigger hit rate: ${triggerHitRate}% (${csbTrigger.length}/${csbDay0.length})`);

  // regime
  console.log('\n[3/3] regime + 그룹 분석…');
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
    // d20 평균 — d5 보다 임계값 살짝 크게
    if (mean > 0.04) regime = 'bull';
    else if (mean < -0.02) regime = 'bear';
    monthRegime.set(m, regime);
  }
  for (const arr of [csbDay0, csbTrigger, csbTriggerStop, csbStopLowVol, csbStopHighVol, allTrials, compTrials]) {
    for (const tr of arr) tr.regime = monthRegime.get(monthOf(tr.date)) || 'unknown';
  }

  // ─── 출력 ───
  function dumpGroup(label, trials, options = {}) {
    const d20 = aggKey(trials, 'd20'), d40 = aggKey(trials, 'd40');
    const d5 = aggKey(trials, 'd5'), d10 = aggKey(trials, 'd10');
    const mfe20 = aggKey(trials, 'mfe20'), mfe40 = aggKey(trials, 'mfe40');
    const mae20 = aggKey(trials, 'mae20'), mae40 = aggKey(trials, 'mae40');
    const hit10 = hitRate(trials, 'hit10'), hit20 = hitRate(trials, 'hit20');
    let stopRate = null;
    if (options.includeStop) stopRate = hitRate(trials, 'stopHit');
    return {
      group: label, n: d20?.n || 0,
      d5: d5?.mean, d10: d10?.mean, d20: d20?.mean, d40: d40?.mean,
      d20_med: d20?.median, d20_win: d20?.win + '%', d20_pf: d20?.pf, d20_worst: d20?.worst,
      mfe20: mfe20?.mean, mfe40: mfe40?.mean,
      mae20: mae20?.mean, mae40: mae40?.mean,
      hit10: hit10 ? `${hit10.rate}%` : null,
      hit20: hit20 ? `${hit20.rate}%` : null,
      stopHit: stopRate ? `${stopRate.rate}%` : null,
    };
  }

  // 1. 전체 비교
  console.log('\n\n## 1. 전체 비교 — 5 그룹');
  console.table([
    dumpGroup('A. csbDay0 (no trigger, no stop)', csbDay0),
    dumpGroup('B. csbTrigger (no stop)', csbTrigger),
    dumpGroup('C. csbTriggerStop (메인)', csbTriggerStop, { includeStop: true }),
    dumpGroup('D-1. lowVol (ATR%<16) +stop', csbStopLowVol, { includeStop: true }),
    dumpGroup('D-2. highVol (ATR%≥16) +stop', csbStopHighVol, { includeStop: true }),
    dumpGroup('E. baselineAll', allTrials),
    dumpGroup('F. compressionBaseline', compTrials),
  ]);

  // 2. 장세별
  console.log('\n\n## 2. 장세별 (csbTriggerStop = 메인)');
  for (const reg of ['bull', 'bear', 'sideways']) {
    console.log(`\n### ${reg}`);
    console.table([
      dumpGroup(`A. csbDay0 ${reg}`,        csbDay0.filter((t) => t.regime === reg)),
      dumpGroup(`B. csbTrigger ${reg}`,     csbTrigger.filter((t) => t.regime === reg)),
      dumpGroup(`C. csbTriggerStop ${reg}`, csbTriggerStop.filter((t) => t.regime === reg), { includeStop: true }),
      dumpGroup(`D-2. highVol ${reg}`,      csbStopHighVol.filter((t) => t.regime === reg), { includeStop: true }),
      dumpGroup(`E. baselineAll ${reg}`,    allTrials.filter((t) => t.regime === reg)),
      dumpGroup(`F. compression ${reg}`,    compTrials.filter((t) => t.regime === reg)),
    ]);
  }

  // 3. 시총 구간별 (csbTriggerStop 만)
  console.log('\n\n## 3. 시총 구간별 — csbTriggerStop');
  function mcG(mc) {
    if (mc >= 1_000_000_000_000) return '1조+';
    if (mc >= 300_000_000_000) return '3000억-1조';
    if (mc >= 100_000_000_000) return '1000-3000억';
    if (mc >= 50_000_000_000) return '500-1000억';
    return '<500억';
  }
  console.table([
    dumpGroup('500-1000억',  csbTriggerStop.filter((t) => mcG(t.marketCap) === '500-1000억'), { includeStop: true }),
    dumpGroup('1000-3000억', csbTriggerStop.filter((t) => mcG(t.marketCap) === '1000-3000억'), { includeStop: true }),
    dumpGroup('3000억-1조',  csbTriggerStop.filter((t) => mcG(t.marketCap) === '3000억-1조'), { includeStop: true }),
    dumpGroup('1조+',        csbTriggerStop.filter((t) => mcG(t.marketCap) === '1조+'), { includeStop: true }),
  ]);

  // 4. 성공 기준
  console.log('\n\n================================================================');
  console.log('## 성공 기준 체크 (csbTriggerStop = 메인)');
  console.log('================================================================');
  const main = csbTriggerStop;
  const mainBull = main.filter((t) => t.regime === 'bull');
  const mainBear = main.filter((t) => t.regime === 'bear');
  const mainSide = main.filter((t) => t.regime === 'sideways');
  const mainD20 = aggKey(main, 'd20');
  const bullD20 = aggKey(mainBull, 'd20');
  const bearD20 = aggKey(mainBear, 'd20');
  const sideD20 = aggKey(mainSide, 'd20');
  const stopRate = hitRate(main, 'stopHit');

  console.log(`\n  표본 n: ${main.length}`);
  console.log(`  trigger hit rate: ${triggerHitRate}% (${csbTrigger.length}/${csbDay0.length})`);
  console.log(`  stop hit rate (40d 안): ${stopRate?.rate}% (${stopRate?.n})`);
  console.log(`\n[1] 전체 승률 ≥ 55% (양호): ${mainD20?.win}% ${mainD20?.win >= 55 ? '✅' : '✗'}`);
  console.log(`[2] bull 승률 ≥ 60% (매우 좋음): ${bullD20?.win}% ${bullD20?.win >= 60 ? '✅' : '✗'} (n=${bullD20?.n})`);
  console.log(`[3] sideways 승률 ≥ 50% (의미 있음): ${sideD20?.win}% ${sideD20?.win >= 50 ? '✅' : '✗'} (n=${sideD20?.n})`);
  console.log(`[4] bear 손실 축소 (vs baselineAll bear): csb ${bearD20?.mean}% vs all ${aggKey(allTrials.filter(t=>t.regime==='bear'),'d20')?.mean}% (n=${bearD20?.n})`);
  console.log(`[5] PF ≥ 1.3 (실전 후보): ${mainD20?.pf} ${mainD20?.pf >= 1.3 ? '✅' : '✗'}`);
  console.log(`[6] worst trade: ${mainD20?.worst}%`);
  console.log(`\n  비교 — A vs B vs C 의 d20:`);
  console.log(`    A. day0 매수:        ${aggKey(csbDay0, 'd20')?.mean}% (win ${aggKey(csbDay0, 'd20')?.win}%, PF ${aggKey(csbDay0, 'd20')?.pf})`);
  console.log(`    B. trigger 매수:     ${aggKey(csbTrigger, 'd20')?.mean}% (win ${aggKey(csbTrigger, 'd20')?.win}%, PF ${aggKey(csbTrigger, 'd20')?.pf})`);
  console.log(`    C. trigger+stop:     ${mainD20?.mean}% (win ${mainD20?.win}%, PF ${mainD20?.pf})`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
