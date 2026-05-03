/**
 * REDEFINED_TIGHT QVA → VVI → H그룹 재검증 보고서 — 1년치
 *
 * 사용자 spec(2026-05): QVA 정의를 REDEFINED_TIGHT(저점권 거래대금 돌파형)로 채택.
 * 기존 H그룹 결과는 이전 QVA 기준이므로 새 정의로 funnel을 다시 검증.
 *
 * 비교 4개 코호트:
 *   1. NEW_QVA           — REDEFINED_TIGHT QVA 단독
 *   2. NEW_QVA_TO_VVI    — NEW_QVA + 20거래일 안에 VVI 발생
 *   3. NEW_HGROUP        — NEW_QVA → VVI → 다음 거래일 vviHigh×1.01 돌파 + 종가 ≥ vviHigh
 *   4. OLD_HGROUP        — 구 D안 QVA → VVI → H (baseline)
 *
 * 출력:
 *   qva-redefined-hgroup-report.json
 *   qva-redefined-hgroup-report.html (Express /qva-redefined-hgroup 라우트)
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const OUT_JSON = path.join(ROOT, 'qva-redefined-hgroup-report.json');
const OUT_HTML = path.join(ROOT, 'qva-redefined-hgroup-report.html');

const SCAN_START = '20250401';
const SCAN_END = '20260424';
const VVI_LOOKAHEAD = 20;             // QVA 후 VVI 탐색 윈도우
const FORWARD_HORIZONS = [5, 10, 20];
const EPISODE_MERGE_WINDOW = 10;      // 같은 episode 묶기

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

// ─── 통계 유틸 ─────────────────────────────────
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function mean(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function rate(num, denom) { return denom > 0 ? round2(num / denom * 100) : null; }
function round2(v) { return v == null || !Number.isFinite(v) ? null : parseFloat(v.toFixed(2)); }

function computeForwards(rows, entryIdx, entryPrice, horizons) {
  const out = { d: {} };
  for (const h of horizons) {
    const idx = entryIdx + h;
    out.d[h] = idx < rows.length && entryPrice > 0
      ? (rows[idx].close / entryPrice - 1) * 100 : null;
  }
  let mfe = null, mae = null;
  for (let k = 1; k <= 20 && entryIdx + k < rows.length; k++) {
    const r = rows[entryIdx + k];
    const up = (r.high / entryPrice - 1) * 100;
    const dn = (r.low / entryPrice - 1) * 100;
    if (mfe == null || up > mfe) mfe = up;
    if (mae == null || dn < mae) mae = dn;
  }
  out.mfe20 = mfe; out.mae20 = mae;
  return out;
}

function makeMetrics(items, fwdKey = 'fwd') {
  const N = items.length;
  const uniq = new Set(items.map(e => e.code)).size;
  const tradingDays = 240;
  function calcRet(h) {
    const arr = items.map(e => e[fwdKey]?.d?.[h]).filter(v => v != null && Number.isFinite(v));
    if (arr.length === 0) return null;
    return {
      n: arr.length,
      winRate: round2(arr.filter(v => v > 0).length / arr.length * 100),
      mean: round2(mean(arr)),
      median: round2(median(arr)),
    };
  }
  const d20 = items.map(e => e[fwdKey]?.d?.[20]).filter(v => v != null && Number.isFinite(v));
  const mfe = items.map(e => e[fwdKey]?.mfe20).filter(v => v != null);
  const mae = items.map(e => e[fwdKey]?.mae20).filter(v => v != null);
  return {
    n: N,
    uniqueStocks: uniq,
    dailyAvg: round2(N / tradingDays),
    d5: calcRet(5),
    d10: calcRet(10),
    d20: calcRet(20),
    win10pct20: round2(d20.filter(v => v >= 10).length / Math.max(d20.length, 1) * 100),
    win20pct20: round2(d20.filter(v => v >= 20).length / Math.max(d20.length, 1) * 100),
    loss10pct20: round2(d20.filter(v => v <= -10).length / Math.max(d20.length, 1) * 100),
    avgMfe20: round2(mean(mfe)),
    avgMae20: round2(mean(mae)),
  };
}

// 같은 종목 내 episode merge — firstSignalDate 기준 dedup
function episodeDedup(items) {
  // items: [{ code, idx, ... }] — 정렬 가정 (asc by idx within code)
  const byCode = new Map();
  for (const it of items) {
    if (!byCode.has(it.code)) byCode.set(it.code, []);
    byCode.get(it.code).push(it);
  }
  const dedup = [];
  for (const [code, arr] of byCode.entries()) {
    arr.sort((a, b) => a.idx - b.idx);
    let lastIdx = -EPISODE_MERGE_WINDOW - 1;
    for (const it of arr) {
      if (it.idx - lastIdx > EPISODE_MERGE_WINDOW) {
        dedup.push(it);
        lastIdx = it.idx;
      }
    }
  }
  return dedup;
}

// ─── QVA/VVI/H 스캔 코어 ──────────────────────
// QVA detector: 'NEW' = calculateRedefinedQVA, 'OLD' = calculateEarlyQVA (D안 default)
function scan(qvaDetector) {
  const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
  const codeMeta = new Map();
  for (const s of stocksList.stocks) codeMeta.set(s.code, s);

  const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));

  const qvaEvents = [];      // QVA 발생 (모든 이벤트)
  const vviEvents = [];      // QVA + VVI 발생 (VVI 기준 진입)
  const hgroupEvents = [];   // QVA + VVI + H통과

  for (let fi = 0; fi < files.length; fi++) {
    if (fi % 500 === 0) process.stdout.write(`  [${qvaDetector}] ${fi}/${files.length}\r`);
    const code = files[fi].replace('.json', '');
    const meta = codeMeta.get(code);
    if (!meta) continue;
    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8')); }
    catch (_) { continue; }
    const rows = chart.rows || [];
    if (rows.length < 65) continue;
    if (isExcludedProduct(chart.name || meta.name)) continue;

    let flow;
    try { flow = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, files[fi]), 'utf-8')); }
    catch (_) { flow = { rows: [] }; }
    const flowRows = flow.rows || [];
    const namedMeta = { ...meta, name: meta.name || chart.name };

    for (let t = 60; t < rows.length; t++) {
      const today = rows[t];
      if (today.date < SCAN_START || today.date > SCAN_END) continue;

      const sliced = rows.slice(0, t + 1);
      let res = null;
      try {
        res = qvaDetector === 'NEW'
          ? ps.calculateRedefinedQVA(sliced, [], namedMeta)
          : ps.calculateEarlyQVA(sliced, [], namedMeta);
      } catch (_) {}
      if (!res?.passed) continue;

      // QVA 이벤트 등록
      const qvaPrice = today.close;
      const qvaFwd = computeForwards(rows, t, qvaPrice, FORWARD_HORIZONS);
      const baseEvent = {
        code, name: chart.name || meta.name, market: meta.market,
        qvaDate: today.date, qvaIdx: t, qvaPrice,
        qvaScore: res.score, qvaGrade: res.grade,
        qvaSignals: res.signals,
        idx: t, // for dedup
      };
      qvaEvents.push({ ...baseEvent, fwd: qvaFwd });

      // VVI 탐색 (D+1 ~ D+VVI_LOOKAHEAD)
      const maxLook = Math.min(VVI_LOOKAHEAD, rows.length - 1 - t);
      let vviIdx = null;
      for (let k = 1; k <= maxLook; k++) {
        const candIdx = t + k;
        const candDate = rows[candIdx].date;
        const slC = rows.slice(0, candIdx + 1);
        const slF = flowRows.filter(r => r.date <= candDate);
        if (slF.length < 10) continue;
        let vvi = null;
        try { vvi = ps.calculateVolumeValueIgnition(slC, slF, namedMeta); } catch (_) {}
        if (vvi?.passed) { vviIdx = candIdx; break; }
      }
      if (vviIdx == null) continue;
      if (vviIdx + 1 >= rows.length) continue;

      const vviRow = rows[vviIdx];
      const nextRow = rows[vviIdx + 1];
      const entryPrice = vviRow.high;
      const entryPrice1Pct = vviRow.high * 1.01;
      const triggered1Pct = nextRow.high >= entryPrice1Pct;
      const breakoutFail = nextRow.close < vviRow.high;

      // VVI 코호트 — VVI 발생일 종가 기준 후속 성과 (vviIdx+1부터 D+5/D+10/D+20)
      const vviFwd = computeForwards(rows, vviIdx, vviRow.close, FORWARD_HORIZONS);
      vviEvents.push({
        ...baseEvent,
        vviDate: vviRow.date, vviIdx,
        daysToVvi: vviIdx - t,
        vviHigh: vviRow.high, vviClose: vviRow.close, vviLow: vviRow.low,
        vviFwd,
        idx: t,
      });

      // H그룹 — triggered1Pct AND nextClose >= vviHigh
      if (!triggered1Pct || breakoutFail) continue;
      const entryIdx = vviIdx + 1; // 돌파 성공 확인일
      // 두 가지 진입 기준 둘 다 계산
      const fwdAtEntry1Pct = computeForwards(rows, entryIdx, entryPrice1Pct, FORWARD_HORIZONS); // entryPrice 기준
      const fwdAtBreakoutClose = computeForwards(rows, entryIdx, nextRow.close, FORWARD_HORIZONS); // 돌파일 종가 기준

      hgroupEvents.push({
        ...baseEvent,
        vviDate: vviRow.date, vviIdx,
        daysToVvi: vviIdx - t,
        breakoutDate: nextRow.date, breakoutIdx: entryIdx,
        daysToHgroup: entryIdx - t,
        vviHigh: vviRow.high, vviClose: vviRow.close, vviLow: vviRow.low,
        nextHigh: nextRow.high, nextClose: nextRow.close,
        entryPrice1Pct, breakoutClose: nextRow.close,
        fwdAtEntry: fwdAtEntry1Pct, // primary metric: entryPrice 기준
        fwdAtBreakoutClose, // secondary
        idx: t,
      });
    }
  }
  process.stdout.write(`  [${qvaDetector}] ${files.length}/${files.length} (qva ${qvaEvents.length}, vvi ${vviEvents.length}, hgroup ${hgroupEvents.length})\n`);

  return { qvaEvents, vviEvents, hgroupEvents };
}

// ─── 실행 ────────────────────────────────────
console.log(`\n📊 REDEFINED_TIGHT QVA → VVI → H그룹 재검증 — ${SCAN_START} ~ ${SCAN_END}\n`);
console.log(`▶ NEW_QVA scan...`);
const NEW = scan('NEW');
console.log(`▶ OLD_QVA (D안) scan...`);
const OLD = scan('OLD');

// 코호트 빌드 (이벤트 기준 / 에피소드 기준 둘 다)
const cohorts = {
  NEW_QVA:        { all: NEW.qvaEvents,    fwdKey: 'fwd' },
  NEW_QVA_TO_VVI: { all: NEW.vviEvents,    fwdKey: 'vviFwd' },
  NEW_HGROUP:     { all: NEW.hgroupEvents, fwdKey: 'fwdAtEntry' },
  OLD_HGROUP:     { all: OLD.hgroupEvents, fwdKey: 'fwdAtEntry' },
};

const cohortMetrics = {};
for (const [name, c] of Object.entries(cohorts)) {
  const eventMetrics = makeMetrics(c.all, c.fwdKey);
  const dedup = episodeDedup(c.all);
  const episodeMetrics = makeMetrics(dedup, c.fwdKey);
  cohortMetrics[name] = {
    fwdKey: c.fwdKey,
    event: eventMetrics,
    episode: episodeMetrics,
  };
}

// H그룹은 추가로 'breakoutClose' 기준 메트릭도 같이
{
  const dedupNewH = episodeDedup(NEW.hgroupEvents);
  cohortMetrics.NEW_HGROUP.episodeBreakoutClose = makeMetrics(dedupNewH, 'fwdAtBreakoutClose');
  cohortMetrics.NEW_HGROUP.eventBreakoutClose = makeMetrics(NEW.hgroupEvents, 'fwdAtBreakoutClose');

  const dedupOldH = episodeDedup(OLD.hgroupEvents);
  cohortMetrics.OLD_HGROUP.episodeBreakoutClose = makeMetrics(dedupOldH, 'fwdAtBreakoutClose');
  cohortMetrics.OLD_HGROUP.eventBreakoutClose = makeMetrics(OLD.hgroupEvents, 'fwdAtBreakoutClose');
}

// 전환률 (NEW funnel) — 에피소드 기준
const newQvaEp = episodeDedup(NEW.qvaEvents);
const newVviEp = episodeDedup(NEW.vviEvents);
const newHgrEp = episodeDedup(NEW.hgroupEvents);

// daysToVvi/H 통계 (event 기준)
const daysToVviArr = NEW.vviEvents.map(e => e.daysToVvi);
const daysToHArr = NEW.hgroupEvents.map(e => e.daysToHgroup);

const funnel = {
  qvaEvents: NEW.qvaEvents.length,
  qvaEpisodes: newQvaEp.length,
  vviEvents: NEW.vviEvents.length,
  vviEpisodes: newVviEp.length,
  hgroupEvents: NEW.hgroupEvents.length,
  hgroupEpisodes: newHgrEp.length,
  qvaToVviRate_event: rate(NEW.vviEvents.length, NEW.qvaEvents.length),
  qvaToVviRate_episode: rate(newVviEp.length, newQvaEp.length),
  qvaToHgroupRate_event: rate(NEW.hgroupEvents.length, NEW.qvaEvents.length),
  qvaToHgroupRate_episode: rate(newHgrEp.length, newQvaEp.length),
  vviToHgroupRate_event: rate(NEW.hgroupEvents.length, NEW.vviEvents.length),
  vviToHgroupRate_episode: rate(newHgrEp.length, newVviEp.length),
  daysToVvi_mean: round2(mean(daysToVviArr)),
  daysToVvi_median: median(daysToVviArr),
  daysToHgroup_mean: round2(mean(daysToHArr)),
  daysToHgroup_median: median(daysToHArr),
};

// ─── 이노션 케이스 ──────────────────────────
function findInocian(events, dateStr) {
  return events.find(e => e.code === '214320' && (e.qvaDate === dateStr || e.qvaDate >= dateStr) && e.qvaDate <= '20260415');
}
const inoQva = NEW.qvaEvents.find(e => e.code === '214320' && e.qvaDate === '20260410') || null;
const inoVvi = NEW.vviEvents.find(e => e.code === '214320' && e.qvaDate === '20260410') || null;
const inoH = NEW.hgroupEvents.find(e => e.code === '214320' && e.qvaDate === '20260410') || null;
const inocianCase = inoQva ? {
  qvaDate: inoQva.qvaDate, qvaScore: inoQva.qvaScore, qvaGrade: inoQva.qvaGrade,
  signals: inoQva.qvaSignals,
  vvi: inoVvi ? { vviDate: inoVvi.vviDate, daysToVvi: inoVvi.daysToVvi, vviHigh: inoVvi.vviHigh } : null,
  hgroup: inoH ? { breakoutDate: inoH.breakoutDate, daysToHgroup: inoH.daysToHgroup, breakoutClose: inoH.breakoutClose, fwd: inoH.fwdAtEntry } : null,
  fwd: inoQva.fwd,
} : null;

// ─── TOP/WORST ─────────────────────────────
function topWorst(items, getter, n = 10) {
  const filtered = items.filter(e => getter(e) != null && Number.isFinite(getter(e)));
  filtered.sort((a, b) => getter(b) - getter(a));
  return {
    top: filtered.slice(0, n),
    worst: filtered.slice(-n).reverse(),
  };
}
function summarizeForList(e, valueGetter, label) {
  return {
    code: e.code, name: e.name, market: e.market,
    qvaDate: e.qvaDate,
    qvaScore: e.qvaScore,
    value: valueGetter(e),
    label,
    valueRatioMedian: e.qvaSignals?.valueRatioMedian,
    returnFromLow20: e.qvaSignals?.returnFromLow20,
  };
}

const newQvaDedup = episodeDedup(NEW.qvaEvents);
const newVviDedup = episodeDedup(NEW.vviEvents);
const newHgrDedup = episodeDedup(NEW.hgroupEvents);

const qvaTW_d20 = topWorst(newQvaDedup, e => e.fwd?.d?.[20]);
const qvaTW_mfe = topWorst(newQvaDedup, e => e.fwd?.mfe20);
const qvaTW_mae = topWorst(newQvaDedup, e => e.fwd?.mae20);
const vviTW_d20 = topWorst(newVviDedup, e => e.vviFwd?.d?.[20]);
const hgrTW_d20 = topWorst(newHgrDedup, e => e.fwdAtEntry?.d?.[20]);

const examples = {
  newQva_topD20: qvaTW_d20.top.map(e => summarizeForList(e, x => x.fwd?.d?.[20], 'D20%')),
  newQva_worstD20: qvaTW_d20.worst.map(e => summarizeForList(e, x => x.fwd?.d?.[20], 'D20%')),
  newQva_topMfe: qvaTW_mfe.top.map(e => summarizeForList(e, x => x.fwd?.mfe20, 'MFE20%')),
  newQva_worstMae: qvaTW_mae.worst.map(e => summarizeForList(e, x => x.fwd?.mae20, 'MAE20%')),
  newVvi_topD20: vviTW_d20.top.map(e => summarizeForList(e, x => x.vviFwd?.d?.[20], 'D20%')),
  newVvi_worstD20: vviTW_d20.worst.map(e => summarizeForList(e, x => x.vviFwd?.d?.[20], 'D20%')),
  newHgr_topD20: hgrTW_d20.top.map(e => summarizeForList(e, x => x.fwdAtEntry?.d?.[20], 'D20%')),
  newHgr_worstD20: hgrTW_d20.worst.map(e => summarizeForList(e, x => x.fwdAtEntry?.d?.[20], 'D20%')),
};

// ─── 자동 결론 ─────────────────────────────
function decideVerdict() {
  const newQ = cohortMetrics.NEW_QVA.episode;
  const oldH = cohortMetrics.OLD_HGROUP.episode;
  const newH = cohortMetrics.NEW_HGROUP.episode;
  const newVvi = cohortMetrics.NEW_QVA_TO_VVI.episode;

  const reasons = [];

  // TOO_NOISY 체크
  const newQDailyAvg = newQ.dailyAvg ?? 0;
  const newQLoss10 = newQ.loss10pct20 ?? 0;
  if (newQDailyAvg > 6 && newQLoss10 > 13) {
    reasons.push(`NEW_QVA dailyAvg ${newQDailyAvg} > 6 AND -10%↓ ${newQLoss10} > 13 → 노이즈 우려`);
    return { label: 'TOO_NOISY', reasons };
  }

  // KEEP_OLD_HGROUP 체크 (새 H가 구 H보다 D+20 평균 / 플러스 마감 둘 다 5pp 이상 떨어지면)
  const newHMean = newH.d20?.mean ?? -Infinity;
  const oldHMean = oldH.d20?.mean ?? -Infinity;
  const newHWin = newH.d20?.winRate ?? -Infinity;
  const oldHWin = oldH.d20?.winRate ?? -Infinity;
  if ((oldHMean - newHMean) > 5 && (oldHWin - newHWin) > 5) {
    reasons.push(`NEW_HGROUP D+20 평균 ${newHMean} (구 ${oldHMean}) AND win% ${newHWin} (구 ${oldHWin}) — 둘 다 5pp 이상 악화`);
    return { label: 'KEEP_OLD_HGROUP', reasons };
  }

  // ADOPT_QVA_BUT_RETUNE_VVI — VVI 전환률이 너무 낮아진 경우
  const oldQvaToVviRate_episode = OLD.vviEvents.length / Math.max(episodeDedup(OLD.qvaEvents).length, 1) * 100;
  const newRate = funnel.qvaToVviRate_episode ?? 0;
  if (newRate < (oldQvaToVviRate_episode - 5) && newRate < 12) {
    reasons.push(`NEW_QVA → VVI 전환률 ${newRate}% (구 ${round2(oldQvaToVviRate_episode)}%) — 5pp 이상 악화 + 12% 미만`);
    return { label: 'ADOPT_QVA_BUT_RETUNE_VVI', reasons };
  }

  // ADOPT_REDEFINED_QVA — 양호 조건
  const newQMean = newQ.d20?.mean ?? 0;
  const newQWin = newQ.d20?.winRate ?? 0;
  if (newQMean >= 5 && newQWin >= 55 && newQ.loss10pct20 <= 13) {
    reasons.push(`NEW_QVA D+20 평균 ${newQMean}, win% ${newQWin}, -10%↓ ${newQ.loss10pct20} — 모두 양호`);
    if (newH.d20?.mean != null && newH.d20.mean >= 8) {
      reasons.push(`NEW_HGROUP D+20 평균 ${newH.d20.mean} — 강한 후보군 확인`);
    }
    return { label: 'ADOPT_REDEFINED_QVA', reasons };
  }

  reasons.push('지표가 결정 임계 사이에 — 추가 기간 검증 권장');
  return { label: 'RETEST_MORE_PERIOD', reasons };
}
const verdict = decideVerdict();

// ─── 보고서 출력 ──────────────────────────
const report = {
  generatedAt: new Date().toISOString(),
  scanStart: SCAN_START,
  scanEnd: SCAN_END,
  qvaDefinition: {
    name: 'REDEFINED_TIGHT_FILTER_C30',
    displayName: 'QVA',
    label: '저점권 거래대금 돌파형 QVA',
    conditions: {
      lowZone: ['returnFromLow20 ≤ 20', 'returnFromLow60 ≤ 25', 'return20 ≤ 25'],
      valueBreak: ['todayValue ≥ prev20ValueMedian × 3.0', 'OR todayValue ≥ prev20ValueMax × 1.1'],
      volumeBreak: ['todayVolume ≥ prev20VolumeMedian × 2.0'],
      notExtended: ['return5 ≤ 15', 'return10 ≤ 20'],
      notWeakClose: ['close ≥ prevClose × 0.99', 'closeLocation ≥ 0.50'],
      liquidityFloor: ['todayValue ≥ 10억', 'medianPrev20Value ≥ 3억'],
      lowStabilizedEnough: ['recent5Low ≥ low20×1.03', 'OR higherLow', 'OR close ≥ ma5'],
      notCollapsedAfterPump: ['NOT (returnFromHigh60 ≤ -30 AND maxValue60 ≥ todayValue × 3)'],
      notTooBroken: ['close ≥ ma60 × 0.85'],
    },
  },
  hgroupDefinition: {
    entry: 'vviHigh × 1.01',
    success: 'nextHigh ≥ entryPrice AND nextClose ≥ vviHigh',
  },
  cohorts: cohortMetrics,
  funnel,
  inocianCase,
  examples,
  verdict,
};

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

// 콘솔 출력
console.log(`\n${'='.repeat(110)}`);
console.log('📊 코호트 비교 (에피소드 기준 dedup)');
console.log('-'.repeat(110));
console.log('Cohort                 N    Stocks Daily  D5+%   D5avg  D10+%  D10avg D20+%  D20avg D20med +20%↑ -10%↓  MFE20  MAE20');
console.log('-'.repeat(110));
for (const name of ['NEW_QVA', 'NEW_QVA_TO_VVI', 'NEW_HGROUP', 'OLD_HGROUP']) {
  const e = cohortMetrics[name].episode;
  console.log(
    name.padEnd(22) +
    String(e.n).padStart(5) + ' ' +
    String(e.uniqueStocks).padStart(6) + ' ' +
    String(e.dailyAvg ?? '-').padStart(5) + ' ' +
    String(e.d5?.winRate ?? '-').padStart(6) + ' ' +
    String(e.d5?.mean ?? '-').padStart(6) + ' ' +
    String(e.d10?.winRate ?? '-').padStart(6) + ' ' +
    String(e.d10?.mean ?? '-').padStart(6) + ' ' +
    String(e.d20?.winRate ?? '-').padStart(6) + ' ' +
    String(e.d20?.mean ?? '-').padStart(6) + ' ' +
    String(e.d20?.median ?? '-').padStart(6) + ' ' +
    String(e.win20pct20 ?? '-').padStart(6) + ' ' +
    String(e.loss10pct20 ?? '-').padStart(6) + ' ' +
    String(e.avgMfe20 ?? '-').padStart(6) + ' ' +
    String(e.avgMae20 ?? '-').padStart(6)
  );
}

console.log(`\n${'─'.repeat(70)}`);
console.log('🔁 NEW funnel 전환률 (에피소드 기준)');
console.log('─'.repeat(70));
console.log(`  QVA → VVI:        ${funnel.qvaEpisodes} → ${funnel.vviEpisodes}  (${funnel.qvaToVviRate_episode}%)`);
console.log(`  QVA → H그룹:      ${funnel.qvaEpisodes} → ${funnel.hgroupEpisodes}  (${funnel.qvaToHgroupRate_episode}%)`);
console.log(`  VVI → H그룹:      ${funnel.vviEpisodes} → ${funnel.hgroupEpisodes}  (${funnel.vviToHgroupRate_episode}%)`);
console.log(`  QVA→VVI 일수: 평균 ${funnel.daysToVvi_mean}, 중앙값 ${funnel.daysToVvi_median}`);
console.log(`  QVA→H 일수:   평균 ${funnel.daysToHgroup_mean}, 중앙값 ${funnel.daysToHgroup_median}`);

console.log(`\n${'─'.repeat(70)}`);
console.log('📍 이노션 214320 2026-04-10 사례');
console.log('─'.repeat(70));
if (inocianCase) {
  console.log(`  QVA: ✅ ${inocianCase.qvaDate}  score ${inocianCase.qvaScore}  ${inocianCase.qvaGrade}`);
  console.log(`  signals: valueRatioMedian ×${inocianCase.signals?.valueRatioMedian}, valueRatioMax ×${inocianCase.signals?.valueRatioMax}, volumeRatioMedian ×${inocianCase.signals?.volumeRatioMedian}, returnFromLow20 ${inocianCase.signals?.returnFromLow20}%`);
  console.log(`  D+5 ${inocianCase.fwd?.d?.[5]}%, D+10 ${inocianCase.fwd?.d?.[10]}%, D+20 ${inocianCase.fwd?.d?.[20]}%, MFE20 ${inocianCase.fwd?.mfe20}%, MAE20 ${inocianCase.fwd?.mae20}%`);
  console.log(`  VVI: ${inocianCase.vvi ? '✅ ' + inocianCase.vvi.vviDate + ' (D+' + inocianCase.vvi.daysToVvi + ', vviHigh ' + inocianCase.vvi.vviHigh + ')' : '❌ 미발생'}`);
  console.log(`  H그룹: ${inocianCase.hgroup ? '✅ ' + inocianCase.hgroup.breakoutDate + ' (D+' + inocianCase.hgroup.daysToHgroup + ')' : '❌ 미진행'}`);
} else {
  console.log('  ❌ 이노션 4/10 데이터 없음 (스캔 범위 확인)');
}

console.log(`\n${'─'.repeat(70)}`);
console.log('🎯 최종 판단');
console.log('─'.repeat(70));
console.log(`  결론: ${verdict.label}`);
verdict.reasons.forEach(r => console.log(`    · ${r}`));

// ─── HTML 빌드 ────────────────────────────
const HTML = buildHtml(report);
fs.writeFileSync(OUT_HTML, HTML);

console.log(`\n✅ JSON 저장: ${OUT_JSON}`);
console.log(`✅ HTML 저장: ${OUT_HTML}  (Express /qva-redefined-hgroup 라우트로 접근)`);

// ─── HTML 빌더 ────────────────────────────
function buildHtml(r) {
  const fmt = v => v == null ? '-' : v;
  const fmtPct = v => v == null ? '-' : (v >= 0 ? '+' : '') + v + '%';
  const cls = v => v == null ? 'muted' : (v > 0 ? 'pos' : (v < 0 ? 'neg' : 'muted'));

  function cohortRow(name, label, e, breakoutClose) {
    return `
      <tr>
        <td class="txt"><strong>${label}</strong></td>
        <td>${e.n}</td><td>${e.uniqueStocks}</td><td>${e.dailyAvg ?? '-'}</td>
        <td class="${cls(e.d5?.winRate - 50)}">${fmt(e.d5?.winRate)}%</td>
        <td class="${cls(e.d5?.mean)}">${fmtPct(e.d5?.mean)}</td>
        <td class="${cls(e.d10?.winRate - 50)}">${fmt(e.d10?.winRate)}%</td>
        <td class="${cls(e.d10?.mean)}">${fmtPct(e.d10?.mean)}</td>
        <td class="${cls(e.d20?.winRate - 50)}">${fmt(e.d20?.winRate)}%</td>
        <td class="${cls(e.d20?.mean)}">${fmtPct(e.d20?.mean)}</td>
        <td class="${cls(e.d20?.median)}">${fmtPct(e.d20?.median)}</td>
        <td>${fmt(e.win10pct20)}%</td>
        <td>${fmt(e.win20pct20)}%</td>
        <td class="neg">${fmt(e.loss10pct20)}%</td>
        <td class="pos">${fmtPct(e.avgMfe20)}</td>
        <td class="neg">${fmtPct(e.avgMae20)}</td>
      </tr>
      ${breakoutClose ? `
      <tr style="background:#0a1322;">
        <td class="txt muted">  └ 돌파일 종가 기준</td>
        <td colspan="3" class="muted">참고</td>
        <td class="${cls(breakoutClose.d5?.winRate - 50)}">${fmt(breakoutClose.d5?.winRate)}%</td>
        <td class="${cls(breakoutClose.d5?.mean)}">${fmtPct(breakoutClose.d5?.mean)}</td>
        <td class="${cls(breakoutClose.d10?.winRate - 50)}">${fmt(breakoutClose.d10?.winRate)}%</td>
        <td class="${cls(breakoutClose.d10?.mean)}">${fmtPct(breakoutClose.d10?.mean)}</td>
        <td class="${cls(breakoutClose.d20?.winRate - 50)}">${fmt(breakoutClose.d20?.winRate)}%</td>
        <td class="${cls(breakoutClose.d20?.mean)}">${fmtPct(breakoutClose.d20?.mean)}</td>
        <td class="${cls(breakoutClose.d20?.median)}">${fmtPct(breakoutClose.d20?.median)}</td>
        <td>${fmt(breakoutClose.win10pct20)}%</td>
        <td>${fmt(breakoutClose.win20pct20)}%</td>
        <td class="neg">${fmt(breakoutClose.loss10pct20)}%</td>
        <td class="pos">${fmtPct(breakoutClose.avgMfe20)}</td>
        <td class="neg">${fmtPct(breakoutClose.avgMae20)}</td>
      </tr>` : ''}
    `;
  }

  const cohortTable = (modeKey, title) => `
    <h3>${title}</h3>
    <table class="cohort">
      <thead><tr>
        <th class="txt">코호트</th><th>N</th><th>종목</th><th>하루평균</th>
        <th>D5+%</th><th>D5avg</th><th>D10+%</th><th>D10avg</th><th>D20+%</th><th>D20avg</th><th>D20mid</th>
        <th>+10%↑</th><th>+20%↑</th><th>-10%↓</th><th>MFE20</th><th>MAE20</th>
      </tr></thead>
      <tbody>
        ${cohortRow('NEW_QVA', '🟢 NEW QVA 단독 (REDEFINED_TIGHT)', r.cohorts.NEW_QVA[modeKey])}
        ${cohortRow('NEW_QVA_TO_VVI', '⏳ NEW QVA → VVI (VVI일 종가 기준)', r.cohorts.NEW_QVA_TO_VVI[modeKey])}
        ${cohortRow('NEW_HGROUP', '🔥 NEW H그룹 (entry=vviHigh×1.01 기준)', r.cohorts.NEW_HGROUP[modeKey], r.cohorts.NEW_HGROUP[modeKey === 'episode' ? 'episodeBreakoutClose' : 'eventBreakoutClose'])}
        ${cohortRow('OLD_HGROUP', '📦 OLD H그룹 (D안 기준 baseline)', r.cohorts.OLD_HGROUP[modeKey])}
      </tbody>
    </table>
  `;

  const exampleList = (items, title, color) => `
    <div class="example-block">
      <h4 style="color:${color};">${title}</h4>
      ${items.length === 0 ? '<p class="muted">데이터 없음</p>' : `
        <table class="ex-table">
          <thead><tr><th>종목</th><th>QVA일</th><th>점수</th><th>${items[0]?.label || '-'}</th><th>×median</th><th>저점대비</th></tr></thead>
          <tbody>
            ${items.map(it => `
              <tr>
                <td class="txt">${it.name || '-'} <span class="muted">${it.code}</span></td>
                <td>${(it.qvaDate || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}</td>
                <td>${it.qvaScore || '-'}</td>
                <td class="${cls(it.value)}">${fmtPct(round2(it.value))}</td>
                <td>×${fmt(it.valueRatioMedian)}</td>
                <td>+${fmt(it.returnFromLow20)}%</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;

  const verdictColors = {
    ADOPT_REDEFINED_QVA: '#34d399',
    ADOPT_QVA_BUT_RETUNE_VVI: '#fbbf24',
    KEEP_OLD_HGROUP: '#f87171',
    RETEST_MORE_PERIOD: '#94a3b8',
    TOO_NOISY: '#fb923c',
  };
  const verdictLabel = {
    ADOPT_REDEFINED_QVA: '✅ REDEFINED_TIGHT QVA 채택 권장',
    ADOPT_QVA_BUT_RETUNE_VVI: '⚠️ QVA 채택 + VVI 재튜닝 필요',
    KEEP_OLD_HGROUP: '❌ 기존 H그룹 유지 권장',
    RETEST_MORE_PERIOD: '⏸ 추가 기간 검증 필요',
    TOO_NOISY: '🔊 노이즈 우려 — 임계 강화 검토',
  };
  const vColor = verdictColors[r.verdict.label] || '#94a3b8';

  const ino = r.inocianCase;
  const sig = ino?.signals || {};

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>REDEFINED_TIGHT QVA → VVI → H그룹 재검증 보고서</title>
<style>
body{font-family:'Inter','Pretendard',-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px;font-size:13px;line-height:1.6;}
.container{max-width:1500px;margin:0 auto;}
h1{font-size:22px;color:#f1f5f9;border-bottom:2px solid #334155;padding-bottom:10px;margin:0 0 8px 0;}
h2{font-size:17px;color:#cbd5e1;margin:20px 0 8px 0;border-left:3px solid #34d399;padding-left:10px;}
h3{font-size:14px;color:#a5b4fc;margin:16px 0 6px 0;}
h4{font-size:13px;margin:0 0 8px 0;}
.subtitle{color:#94a3b8;font-size:12px;}
.warning{background:#422006;border-left:3px solid #fbbf24;padding:10px 14px;border-radius:6px;margin:12px 0;color:#fde68a;font-size:12px;line-height:1.7;}
.nav{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;}
.nav a{display:inline-block;padding:6px 12px;background:#1e293b;color:#cbd5e1;border-radius:6px;text-decoration:none;font-size:12px;border:1px solid #334155;}
.nav a:hover{border-color:#34d399;color:#34d399;}
.verdict{background:#1e293b;border:2px solid ${vColor};padding:16px 20px;border-radius:10px;margin:16px 0;}
.verdict h2{border:none;padding:0;color:${vColor};margin:0 0 8px 0;}
.verdict .reasons{font-size:12px;color:#cbd5e1;line-height:1.8;}
.verdict .reasons li{margin-left:16px;}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:6px;overflow:hidden;font-size:11px;margin-bottom:12px;}
th{background:#0f172a;padding:8px 6px;text-align:right;font-weight:600;color:#94a3b8;border-bottom:1px solid #334155;}
td{padding:7px 6px;text-align:right;border-bottom:1px solid #1e293b;}
td.txt,th.txt{text-align:left;}
.muted{color:#64748b;}
.pos{color:#34d399;}
.neg{color:#f87171;}
table.cohort tr:nth-child(odd) td{background:rgba(255,255,255,0.02);}
.funnel-flow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#1e293b;padding:14px;border-radius:8px;margin:12px 0;font-size:12px;}
.funnel-step{background:#0f172a;border:1px solid #334155;padding:8px 14px;border-radius:6px;min-width:160px;}
.funnel-step .lbl{color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;}
.funnel-step .cnt{font-size:18px;font-weight:700;color:#34d399;margin-top:3px;}
.funnel-step.qva .cnt{color:#34d399;}
.funnel-step.vvi .cnt{color:#fbbf24;}
.funnel-step.h .cnt{color:#f87171;}
.funnel-arrow{color:#475569;font-size:14px;font-weight:700;}
.funnel-rate{font-size:10px;color:#64748b;margin-top:3px;}
.ino-box{background:#1e293b;border:1px solid #34d399;border-radius:8px;padding:14px 18px;margin:12px 0;}
.ino-box .quote{background:#0a1322;border-left:3px solid #34d399;padding:8px 12px;border-radius:6px;color:#a7f3d0;margin-bottom:10px;font-style:italic;font-size:12px;}
.ino-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;}
.ino-card{background:#0a1322;padding:10px 12px;border-radius:6px;border-left:2px solid #475569;}
.ino-card .lbl{color:#94a3b8;font-size:10px;text-transform:uppercase;}
.ino-card .val{color:#e2e8f0;font-size:13px;font-weight:600;margin-top:2px;}
.ino-card.green{border-left-color:#34d399;}
.ino-card.amber{border-left-color:#fbbf24;}
.ino-card.red{border-left-color:#f87171;}
.examples-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:12px;}
.example-block{background:#1e293b;padding:12px 14px;border-radius:8px;}
.ex-table{font-size:11px;}
.ex-table th{padding:5px 4px;}
.ex-table td{padding:4px 4px;}
.cond-table{background:#0a1322;font-size:11px;}
.cond-table td{padding:5px 8px;}
.cond-table td.k{color:#94a3b8;width:140px;}
</style>
</head>
<body>
<div class="container">
  <div class="nav">
    <a href="/qva-watchlist">📋 매일 운영 보드</a>
    <a href="/qva-review-ok">📊 3단계 코호트 비교</a>
    <a href="/qva-vvi-breakout-entry">🚀 돌파 진입 검증 (구)</a>
  </div>

  <h1>QVA → VVI → H그룹 재검증 보고서 <span style="font-size:13px;color:#94a3b8;font-weight:400;">(저점권 거래대금 돌파형 QVA, 내부명 REDEFINED_TIGHT_FILTER_C30)</span></h1>
  <p class="subtitle">기간 ${r.scanStart.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')} ~ ${r.scanEnd.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')} · 생성 ${r.generatedAt.slice(0,10)}</p>

  <div class="warning">
    📌 본 보고서는 QVA 정의 변경에 따른 조건 조합의 과거 성과 검증입니다.
    매수 추천이 아니며, 실제 판단은 차트, 뉴스, 거래대금, 시장 상황을 함께 확인해야 합니다.
  </div>

  <div class="verdict">
    <h2>${verdictLabel[r.verdict.label] || r.verdict.label}</h2>
    <div class="reasons">
      <ul>${r.verdict.reasons.map(x => `<li>${x}</li>`).join('')}</ul>
    </div>
  </div>

  <h2>1. 최종 QVA 정의 — 저점권 거래대금 돌파형 (내부명 REDEFINED_TIGHT_FILTER_C30)</h2>
  <table class="cond-table">
    <tr><td class="k">lowZone</td><td>${r.qvaDefinition.conditions.lowZone.join(' / ')}</td></tr>
    <tr><td class="k">valueBreak</td><td>${r.qvaDefinition.conditions.valueBreak.join(' ')}</td></tr>
    <tr><td class="k">volumeBreak</td><td>${r.qvaDefinition.conditions.volumeBreak.join(' ')}</td></tr>
    <tr><td class="k">notExtended</td><td>${r.qvaDefinition.conditions.notExtended.join(' / ')}</td></tr>
    <tr><td class="k">notWeakClose</td><td>${r.qvaDefinition.conditions.notWeakClose.join(' / ')}</td></tr>
    <tr><td class="k">liquidityFloor</td><td>${(r.qvaDefinition.conditions.liquidityFloor || []).join(' / ')}</td></tr>
    <tr><td class="k">lowStabilizedEnough</td><td>${(r.qvaDefinition.conditions.lowStabilizedEnough || []).join(' ')}</td></tr>
    <tr><td class="k">notCollapsedAfterPump</td><td>${(r.qvaDefinition.conditions.notCollapsedAfterPump || []).join(' ')}</td></tr>
    <tr><td class="k">notTooBroken</td><td>${(r.qvaDefinition.conditions.notTooBroken || []).join(' ')}</td></tr>
    <tr><td class="k">H그룹 entry</td><td>${r.hgroupDefinition.entry}</td></tr>
    <tr><td class="k">H그룹 success</td><td>${r.hgroupDefinition.success}</td></tr>
  </table>

  <h2>2. funnel 전환률 (NEW QVA 기준 · 에피소드)</h2>
  <div class="funnel-flow">
    <div class="funnel-step qva">
      <div class="lbl">🟢 QVA</div>
      <div class="cnt">${r.funnel.qvaEpisodes}</div>
      <div class="funnel-rate">에피소드</div>
    </div>
    <div class="funnel-arrow">→</div>
    <div class="funnel-step vvi">
      <div class="lbl">⏳ VVI</div>
      <div class="cnt">${r.funnel.vviEpisodes}</div>
      <div class="funnel-rate">${r.funnel.qvaToVviRate_episode}% 전환 · 평균 ${r.funnel.daysToVvi_mean}일 / 중앙값 ${r.funnel.daysToVvi_median}일</div>
    </div>
    <div class="funnel-arrow">→</div>
    <div class="funnel-step h">
      <div class="lbl">🔥 H그룹</div>
      <div class="cnt">${r.funnel.hgroupEpisodes}</div>
      <div class="funnel-rate">QVA 대비 ${r.funnel.qvaToHgroupRate_episode}% · VVI 대비 ${r.funnel.vviToHgroupRate_episode}% · 평균 ${r.funnel.daysToHgroup_mean}일 / 중앙값 ${r.funnel.daysToHgroup_median}일</div>
    </div>
  </div>

  <h2>3. 코호트 성과 비교 — 에피소드 기준 (최종 판단용)</h2>
  ${cohortTable('episode', '에피소드 기준 (10거래일 merge window 적용)')}

  <h2>4. 코호트 성과 비교 — 이벤트 기준 (참고)</h2>
  ${cohortTable('event', '모든 신호를 개별 이벤트로 카운트')}

  <h2>5. 이노션 214320 사례 (필수 포함)</h2>
  ${ino ? `
  <div class="ino-box">
    <div class="quote">
      "이노션 2026-04-10은 저점권에서 기존 거래량·거래대금을 크게 뛰어넘은 사례입니다.
      새 QVA 정의에서는 QVA로 분류됩니다."
    </div>
    <div class="ino-grid">
      <div class="ino-card green">
        <div class="lbl">QVA 통과</div>
        <div class="val">✅ ${ino.qvaDate.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')} · score ${ino.qvaScore}</div>
      </div>
      <div class="ino-card">
        <div class="lbl">거래대금 / 중앙값 배수</div>
        <div class="val">×${sig.valueRatioMedian} (median) / ×${sig.valueRatioMax} (max)</div>
      </div>
      <div class="ino-card">
        <div class="lbl">거래량 / 중앙값 배수</div>
        <div class="val">×${sig.volumeRatioMedian}</div>
      </div>
      <div class="ino-card">
        <div class="lbl">저점 대비</div>
        <div class="val">+${sig.returnFromLow20}% (20일) / +${sig.returnFromLow60}% (60일)</div>
      </div>
      <div class="ino-card ${ino.fwd?.d?.[5] >= 0 ? 'green' : 'red'}">
        <div class="lbl">D+5</div>
        <div class="val">${fmtPct(round2(ino.fwd?.d?.[5]))}</div>
      </div>
      <div class="ino-card ${ino.fwd?.d?.[10] >= 0 ? 'green' : 'red'}">
        <div class="lbl">D+10</div>
        <div class="val">${fmtPct(round2(ino.fwd?.d?.[10]))}</div>
      </div>
      <div class="ino-card ${ino.fwd?.d?.[20] >= 0 ? 'green' : 'red'}">
        <div class="lbl">D+20</div>
        <div class="val">${fmtPct(round2(ino.fwd?.d?.[20]))}</div>
      </div>
      <div class="ino-card green">
        <div class="lbl">MFE20</div>
        <div class="val">${fmtPct(round2(ino.fwd?.mfe20))}</div>
      </div>
      <div class="ino-card red">
        <div class="lbl">MAE20</div>
        <div class="val">${fmtPct(round2(ino.fwd?.mae20))}</div>
      </div>
      <div class="ino-card ${ino.vvi ? 'amber' : 'red'}">
        <div class="lbl">VVI 발생</div>
        <div class="val">${ino.vvi ? '✅ ' + ino.vvi.vviDate.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3') + ' (D+' + ino.vvi.daysToVvi + ')' : '❌ 미발생'}</div>
      </div>
      <div class="ino-card ${ino.hgroup ? 'green' : 'red'}">
        <div class="lbl">H그룹 진행</div>
        <div class="val">${ino.hgroup ? '✅ ' + ino.hgroup.breakoutDate.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3') + ' (D+' + ino.hgroup.daysToHgroup + ')' : '❌ 미진행'}</div>
      </div>
      <div class="ino-card">
        <div class="lbl">차트 마커</div>
        <div class="val">2026-04-10 캔들 아래 🟢 초록 동그라미</div>
      </div>
    </div>
  </div>
  ` : '<p class="muted">이노션 214320 4/10 데이터가 스캔 결과에 없습니다.</p>'}

  <h2>6. TOP / WORST — 새 QVA 단독 (에피소드)</h2>
  <div class="examples-grid">
    ${exampleList(r.examples.newQva_topD20, 'D+20 수익률 TOP 10', '#34d399')}
    ${exampleList(r.examples.newQva_worstD20, 'D+20 수익률 WORST 10', '#f87171')}
    ${exampleList(r.examples.newQva_topMfe, 'MFE20 TOP 10', '#34d399')}
    ${exampleList(r.examples.newQva_worstMae, 'MAE20 WORST 10', '#f87171')}
  </div>

  <h2>7. TOP / WORST — 새 QVA → VVI</h2>
  <div class="examples-grid">
    ${exampleList(r.examples.newVvi_topD20, 'VVI 후 D+20 TOP 10', '#fbbf24')}
    ${exampleList(r.examples.newVvi_worstD20, 'VVI 후 D+20 WORST 10', '#f87171')}
  </div>

  <h2>8. TOP / WORST — 새 QVA → H그룹</h2>
  <div class="examples-grid">
    ${exampleList(r.examples.newHgr_topD20, 'H그룹 후 D+20 TOP 10', '#f87171')}
    ${exampleList(r.examples.newHgr_worstD20, 'H그룹 후 D+20 WORST 10', '#94a3b8')}
  </div>

  <div class="warning" style="margin-top:24px;">
    📌 본 보고서는 QVA 정의 변경에 따른 조건 조합의 과거 성과 검증입니다.
    매수 추천이 아니며, 실제 판단은 차트, 뉴스, 거래대금, 시장 상황을 함께 확인해야 합니다.
  </div>
</div>
</body>
</html>`;
}
