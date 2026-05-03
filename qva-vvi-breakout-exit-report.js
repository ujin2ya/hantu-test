/**
 * QVA → VVI → 다음날 +1% 돌파 → 돌파 성공 후 익절/청산 시나리오 검증
 *
 * 흐름:
 *   QVA = 감시 시작
 *   VVI = 거래대금 초동 확인
 *   다음날 vviHigh × 1.01 돌파 = 진입 트리거
 *   다음날 종가 ≥ vviHigh = 돌파 성공 (H그룹)
 *   다음날 종가 <  vviHigh = 돌파 실패 (E그룹에는 포함, H그룹에선 제외)
 *
 * 본 보고서는 매수 추천이 아니라 익절/청산 규칙 조합의 성과 검증용이다.
 * 14개 시나리오를 H/E 두 그룹 × 신호기준/이벤트기준으로 비교한다.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ENTRY_JSON = path.join(ROOT, 'qva-vvi-breakout-entry-report.json');
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');

const TRACKING_DAYS = 10;
const DEDUP_MODE = process.env.DEDUP_MODE || 'latestQva';
if (!['earliestQva', 'latestQva', 'bestQva'].includes(DEDUP_MODE)) {
  console.error(`Invalid DEDUP_MODE: ${DEDUP_MODE}. Use earliestQva | latestQva | bestQva`);
  process.exit(1);
}

// ─────────── 시나리오 정의 ───────────
const SCENARIOS = [
  { name: 'HOLD_D10',                  label: '10일 단순 보유',                       kind: 'hold' },
  { name: 'TP10',                      label: '+10% 전량 익절',                       kind: 'tp',         target: 0.10 },
  { name: 'TP15',                      label: '+15% 전량 익절',                       kind: 'tp',         target: 0.15 },
  { name: 'TP20',                      label: '+20% 전량 익절',                       kind: 'tp',         target: 0.20 },
  { name: 'TP30',                      label: '+30% 전량 익절',                       kind: 'tp',         target: 0.30 },
  { name: 'TP10_HALF',                 label: '+10% 절반 익절',                       kind: 'tphalf',     target: 0.10 },
  { name: 'TP15_HALF',                 label: '+15% 절반 익절',                       kind: 'tphalf',     target: 0.15 },
  { name: 'TP20_HALF',                 label: '+20% 절반 익절',                       kind: 'tphalf',     target: 0.20 },
  { name: 'TRAIL_FROM_HIGH_5',         label: '+10% 상승 후 고점 대비 -5% 청산',      kind: 'trail',      activation: 0.10, trailingPct: 0.05 },
  { name: 'TRAIL_FROM_HIGH_7',         label: '+10% 상승 후 고점 대비 -7% 청산',      kind: 'trail',      activation: 0.10, trailingPct: 0.07 },
  { name: 'STOP_VVI_LOW_TP15_HALF',    label: '+15% 절반 익절 + VVI 저가 이탈 청산', kind: 'stoptphalf', target: 0.15, stopType: 'vviLow' },
  { name: 'STOP_MINUS_7_TP15_HALF',    label: '+15% 절반 익절 + -7% 청산',            kind: 'stoptphalf', target: 0.15, stopType: 'minus7' },
  { name: 'TP15_HALF_THEN_TRAIL_7',    label: '+15% 절반 익절 후 고점 대비 -7% 청산', kind: 'tphalftrail', target: 0.15, trailingPct: 0.07 },
  { name: 'TP20_HALF_THEN_TRAIL_7',    label: '+20% 절반 익절 후 고점 대비 -7% 청산', kind: 'tphalftrail', target: 0.20, trailingPct: 0.07 },
];

// ─────────── 통계 헬퍼 ───────────
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function avg(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function quantile(arr, q) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
}
function rate(num, denom) {
  return denom > 0 ? (num / denom) * 100 : null;
}
function round2(v) {
  return v == null || !Number.isFinite(v) ? null : parseFloat(v.toFixed(2));
}
function formatDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// ─────────── 진입 후 시나리오 시뮬레이터 ───────────
// rows: 차트 전체, entryIdx: 진입 거래일 인덱스, entryPrice: 진입가, vviLow: VVI 저가
// 측정 윈도우: entryIdx+1 ~ entryIdx+TRACKING_DAYS (진입 당일 제외)
function simulateScenario(rows, entryIdx, entryPrice, vviLow, scenario) {
  const r = {
    scenarioName: scenario.name,
    scenarioLabel: scenario.label,
    exitDate: null,
    exitReason: null,
    exitPrice: null,
    finalReturn: null,
    hitTarget: false,
    targetDate: null,
    targetPrice: scenario.target ? entryPrice * (1 + scenario.target) : null,
    partialTaken: false,
    partialTargetDate: null,
    partialTargetReturn: null,
    remainingReturn: null,
    stoppedOut: false,
    stopDate: null,
    stopPrice: null,
    stopReturn: null,
    trailingActivated: false,
    trailingActivatedDate: null,
    highestHighBeforeExit: null,
    maxReturnBeforeExit: null,
    maxDrawdownBeforeExit: null,
    holdingDays: null,
    sameDayTargetAndStop: false,
    conservativeAssumptionApplied: false,
  };
  if (!(entryPrice > 0) || entryIdx + 1 >= rows.length) return r;

  const targetPrice = r.targetPrice;
  let stopPrice = null;
  if (scenario.stopType === 'vviLow') stopPrice = vviLow;
  else if (scenario.stopType === 'minus7') stopPrice = entryPrice * 0.93;
  if (stopPrice) r.stopPrice = stopPrice;

  let highestHigh = -Infinity;
  let mfe = null, mae = null;
  let highestAfterTarget = -Infinity;
  let exited = false;

  const days = TRACKING_DAYS;
  for (let k = 1; k <= days && entryIdx + k < rows.length; k++) {
    const bar = rows[entryIdx + k];
    if (bar.high > highestHigh) highestHigh = bar.high;
    const upPct = (bar.high - entryPrice) / entryPrice * 100;
    const downPct = (bar.low - entryPrice) / entryPrice * 100;
    if (mfe == null || upPct > mfe) mfe = upPct;
    if (mae == null || downPct < mae) mae = downPct;

    const hitsTarget = targetPrice ? bar.high >= targetPrice : false;
    const hitsStop = stopPrice ? bar.low <= stopPrice : false;

    switch (scenario.kind) {
      case 'hold':
        // No early exit — runs to D10
        break;

      case 'tp': {
        if (hitsTarget) {
          r.hitTarget = true;
          r.targetDate = bar.date;
          r.exitDate = bar.date;
          r.exitReason = 'TARGET_HIT';
          r.exitPrice = targetPrice;
          r.finalReturn = scenario.target * 100;
          r.holdingDays = k;
          exited = true;
        }
        break;
      }

      case 'tphalf': {
        // Partial at target; remaining holds to D10 close
        if (hitsTarget && !r.partialTaken) {
          r.partialTaken = true;
          r.partialTargetDate = bar.date;
          r.partialTargetReturn = scenario.target * 100;
          r.hitTarget = true;
          r.targetDate = bar.date;
        }
        break;
      }

      case 'trail': {
        const activationPrice = entryPrice * (1 + scenario.activation);
        if (!r.trailingActivated && highestHigh >= activationPrice) {
          r.trailingActivated = true;
          r.trailingActivatedDate = bar.date;
        }
        if (r.trailingActivated) {
          const trailingStop = highestHigh * (1 - scenario.trailingPct);
          if (bar.low <= trailingStop) {
            r.stoppedOut = true;
            r.stopDate = bar.date;
            r.stopPrice = trailingStop;
            r.stopReturn = (trailingStop - entryPrice) / entryPrice * 100;
            r.exitDate = bar.date;
            r.exitReason = 'TRAILING_STOP';
            r.exitPrice = trailingStop;
            r.finalReturn = r.stopReturn;
            r.holdingDays = k;
            exited = true;
          }
        }
        break;
      }

      case 'stoptphalf': {
        // Same-day target+stop → conservative: stop first
        if (hitsTarget && hitsStop) {
          r.sameDayTargetAndStop = true;
          r.conservativeAssumptionApplied = true;
          if (!r.partialTaken) {
            // Full position out at stop (no partial taken)
            r.stoppedOut = true;
            r.stopDate = bar.date;
            r.stopReturn = (stopPrice - entryPrice) / entryPrice * 100;
            r.exitDate = bar.date;
            r.exitReason = 'STOP_BEFORE_TARGET_SAMEDAY';
            r.exitPrice = stopPrice;
            r.finalReturn = r.stopReturn;
            r.holdingDays = k;
            exited = true;
          } else {
            // Remaining 50% out at stop
            const remRet = (stopPrice - entryPrice) / entryPrice * 100;
            r.remainingReturn = remRet;
            r.stoppedOut = true;
            r.stopDate = bar.date;
            r.stopReturn = remRet;
            r.exitDate = bar.date;
            r.exitReason = 'STOP_AFTER_PARTIAL_SAMEDAY';
            r.exitPrice = stopPrice;
            r.finalReturn = 0.5 * scenario.target * 100 + 0.5 * remRet;
            r.holdingDays = k;
            exited = true;
          }
          break;
        }
        if (hitsStop) {
          if (!r.partialTaken) {
            r.stoppedOut = true;
            r.stopDate = bar.date;
            r.stopReturn = (stopPrice - entryPrice) / entryPrice * 100;
            r.exitDate = bar.date;
            r.exitReason = 'STOP_LOSS';
            r.exitPrice = stopPrice;
            r.finalReturn = r.stopReturn;
            r.holdingDays = k;
          } else {
            const remRet = (stopPrice - entryPrice) / entryPrice * 100;
            r.remainingReturn = remRet;
            r.stoppedOut = true;
            r.stopDate = bar.date;
            r.stopReturn = remRet;
            r.exitDate = bar.date;
            r.exitReason = 'STOP_AFTER_PARTIAL';
            r.exitPrice = stopPrice;
            r.finalReturn = 0.5 * scenario.target * 100 + 0.5 * remRet;
            r.holdingDays = k;
          }
          exited = true;
          break;
        }
        if (hitsTarget && !r.partialTaken) {
          r.partialTaken = true;
          r.partialTargetDate = bar.date;
          r.partialTargetReturn = scenario.target * 100;
          r.hitTarget = true;
          r.targetDate = bar.date;
        }
        break;
      }

      case 'tphalftrail': {
        if (!r.partialTaken && hitsTarget) {
          r.partialTaken = true;
          r.partialTargetDate = bar.date;
          r.partialTargetReturn = scenario.target * 100;
          r.hitTarget = true;
          r.targetDate = bar.date;
          r.trailingActivated = true;
          r.trailingActivatedDate = bar.date;
          highestAfterTarget = bar.high;
          break;
        }
        if (r.trailingActivated) {
          if (bar.high > highestAfterTarget) highestAfterTarget = bar.high;
          const trailingStop = highestAfterTarget * (1 - scenario.trailingPct);
          if (bar.low <= trailingStop) {
            const remRet = (trailingStop - entryPrice) / entryPrice * 100;
            r.remainingReturn = remRet;
            r.stoppedOut = true;
            r.stopDate = bar.date;
            r.stopPrice = trailingStop;
            r.stopReturn = remRet;
            r.exitDate = bar.date;
            r.exitReason = 'TRAILING_STOP_AFTER_PARTIAL';
            r.exitPrice = trailingStop;
            r.finalReturn = 0.5 * scenario.target * 100 + 0.5 * remRet;
            r.holdingDays = k;
            exited = true;
          }
        }
        break;
      }
    }

    if (exited) break;
  }

  // 종료 미발생 → D10 종가 청산
  if (!exited) {
    const lastIdx = Math.min(entryIdx + days, rows.length - 1);
    const lastBar = rows[lastIdx];
    if (lastBar) {
      r.exitDate = lastBar.date;
      r.exitPrice = lastBar.close;
      r.holdingDays = lastIdx - entryIdx;
      const closeRet = (lastBar.close - entryPrice) / entryPrice * 100;

      if (scenario.kind === 'hold') {
        r.exitReason = 'HOLD_D10';
        r.finalReturn = closeRet;
      } else if (scenario.kind === 'tp') {
        r.exitReason = 'D10_CLOSE';
        r.finalReturn = closeRet;
      } else if (scenario.kind === 'tphalf') {
        if (r.partialTaken) {
          r.remainingReturn = closeRet;
          r.exitReason = 'D10_CLOSE_AFTER_PARTIAL';
          r.finalReturn = 0.5 * scenario.target * 100 + 0.5 * closeRet;
        } else {
          r.exitReason = 'D10_CLOSE';
          r.finalReturn = closeRet;
        }
      } else if (scenario.kind === 'trail') {
        r.exitReason = 'D10_CLOSE';
        r.finalReturn = closeRet;
      } else if (scenario.kind === 'stoptphalf') {
        if (r.partialTaken) {
          r.remainingReturn = closeRet;
          r.exitReason = 'D10_CLOSE_AFTER_PARTIAL';
          r.finalReturn = 0.5 * scenario.target * 100 + 0.5 * closeRet;
        } else {
          r.exitReason = 'D10_CLOSE';
          r.finalReturn = closeRet;
        }
      } else if (scenario.kind === 'tphalftrail') {
        if (r.partialTaken) {
          r.remainingReturn = closeRet;
          r.exitReason = 'D10_CLOSE_AFTER_PARTIAL';
          r.finalReturn = 0.5 * scenario.target * 100 + 0.5 * closeRet;
        } else {
          r.exitReason = 'D10_CLOSE';
          r.finalReturn = closeRet;
        }
      }
    }
  }

  r.highestHighBeforeExit = highestHigh > 0 ? highestHigh : null;
  r.maxReturnBeforeExit = mfe;
  r.maxDrawdownBeforeExit = mae;
  return r;
}

// ─────────── 메인 ───────────
console.log(`\n📊 QVA → VVI → 돌파 후 익절/청산 시나리오 검증 보고서`);
if (!fs.existsSync(ENTRY_JSON)) {
  console.error(`❌ ${ENTRY_JSON} 없습니다. 먼저 \`node qva-vvi-breakout-entry-report.js\`를 실행하세요.`);
  process.exit(1);
}
const entryReport = JSON.parse(fs.readFileSync(ENTRY_JSON, 'utf-8'));
console.log(`스캔 기간: ${formatDate(entryReport.meta.scanStart)} ~ ${formatDate(entryReport.meta.scanEnd)} (entry 보고서 기준)`);

// E/H 그룹 필터 (entry 보고서 details 기준)
const allDetails = entryReport.details || [];
const eGroup = allDetails.filter(d =>
  d.vviCloseLocation != null && d.vviCloseLocation >= 0.75 && d.entryTriggered1Pct
);
const hGroup = eGroup.filter(d => !d.breakoutFail);

console.log(`E그룹 (+1% 돌파 진입): ${eGroup.length}건 / 고유 종목 ${new Set(eGroup.map(d => d.code)).size}`);
console.log(`H그룹 (돌파 성공):      ${hGroup.length}건 / 고유 종목 ${new Set(hGroup.map(d => d.code)).size}\n`);

// 차트 캐시 (코드별 한 번만 로드)
const chartCache = new Map();
function loadChart(code) {
  if (chartCache.has(code)) return chartCache.get(code);
  const p = path.join(LONG_CACHE_DIR, `${code}.json`);
  if (!fs.existsSync(p)) { chartCache.set(code, null); return null; }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    chartCache.set(code, data);
    return data;
  } catch (_) { chartCache.set(code, null); return null; }
}

// 시나리오 시뮬레이션 — 그룹별로
const t0 = Date.now();
function buildEnrichedRecords(group) {
  const out = [];
  for (const d of group) {
    const chart = loadChart(d.code);
    if (!chart) continue;
    const rows = chart.rows || [];
    const entryIdx = rows.findIndex(r => r.date === d.entryDate);
    if (entryIdx < 0) continue;
    const entryPrice = d.entryPrice1Pct;
    const scenarios = {};
    for (const s of SCENARIOS) {
      scenarios[s.name] = simulateScenario(rows, entryIdx, entryPrice, d.vviLow, s);
    }
    out.push({
      code: d.code,
      name: d.name,
      market: d.market,
      isPreferred: d.isPreferred,
      qvaSignalDate: d.qvaSignalDate,
      qvaSignalPrice: d.qvaSignalPrice,
      vviDate: d.vviDate,
      daysToVvi: d.daysToVvi,
      entryDate: d.entryDate,
      entryPrice,
      vviHigh: d.vviHigh,
      vviClose: d.vviClose,
      vviLow: d.vviLow,
      vviCloseLocation: d.vviCloseLocation,
      nextHigh: d.nextHigh,
      nextClose: d.nextClose,
      breakoutSuccess: !d.breakoutFail,
      breakoutFail: d.breakoutFail,
      entryD5Return: d.entry1PctD5Return ?? d.entryD5Return,
      entryD10Return: d.entry1PctD10Return ?? d.entryD10Return,
      entryMFE10: d.entry1PctMFE10 ?? d.entryMFE10,
      entryMAE10: d.entry1PctMAE10 ?? d.entryMAE10,
      scenarios,
    });
  }
  return out;
}

const eEnriched = buildEnrichedRecords(eGroup);
const hEnriched = buildEnrichedRecords(hGroup);
console.log(`시뮬레이션 완료 — E ${eEnriched.length}건, H ${hEnriched.length}건 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// ─────────── dedup ───────────
function dedupEvents(items, mode) {
  const groups = new Map();
  for (const r of items) {
    const key = `${r.code}|${r.vviDate}|${r.entryDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const reps = [];
  for (const group of groups.values()) {
    if (group.length === 1) { reps.push(group[0]); continue; }
    let rep;
    if (mode === 'earliestQva') {
      rep = group.reduce((a, b) => a.qvaSignalDate <= b.qvaSignalDate ? a : b);
    } else if (mode === 'bestQva') {
      // bestQva는 entry 보고서에서 maxDropBeforeVvi 필요 — 여기는 latestQva와 동일하게 처리
      // (이 보고서는 entry 보고서를 input으로 받으므로 maxDropBeforeVvi는 details에 없음)
      rep = group.reduce((a, b) => a.qvaSignalDate >= b.qvaSignalDate ? a : b);
    } else {
      rep = group.reduce((a, b) => a.qvaSignalDate >= b.qvaSignalDate ? a : b);
    }
    reps.push(rep);
  }
  return reps;
}

// ─────────── 시나리오별 집계 ───────────
function aggregateScenario(records, scenarioName, holdBaseline) {
  const items = records.map(r => r.scenarios?.[scenarioName]).filter(s => s != null);
  const finalReturns = items.map(s => s.finalReturn).filter(Number.isFinite);
  const holdingDays = items.map(s => s.holdingDays).filter(Number.isFinite);
  const mfe = items.map(s => s.maxReturnBeforeExit).filter(Number.isFinite);
  const mae = items.map(s => s.maxDrawdownBeforeExit).filter(Number.isFinite);
  const targetHits = items.filter(s => s.hitTarget).length;
  const partialHits = items.filter(s => s.partialTaken).length;
  const stops = items.filter(s => s.stoppedOut).length;
  const trailingActs = items.filter(s => s.trailingActivated).length;

  const out = {
    scenarioName,
    scenarioLabel: SCENARIOS.find(s => s.name === scenarioName)?.label || scenarioName,
    count: records.length,
    uniqueStocks: new Set(records.map(r => r.code)).size,
    avgReturn: round2(avg(finalReturns)),
    medianReturn: round2(median(finalReturns)),
    minReturn: finalReturns.length ? round2(Math.min(...finalReturns)) : null,
    maxReturn: finalReturns.length ? round2(Math.max(...finalReturns)) : null,
    p25Return: round2(quantile(finalReturns, 0.25)),
    p75Return: round2(quantile(finalReturns, 0.75)),
    positiveReturnRate: round2(rate(finalReturns.filter(v => v > 0).length, finalReturns.length)),
    avgHoldingDays: round2(avg(holdingDays)),
    medianHoldingDays: round2(median(holdingDays)),
    targetHitRate: round2(rate(targetHits, items.length)),
    partialTargetHitRate: round2(rate(partialHits, items.length)),
    stopRate: round2(rate(stops, items.length)),
    trailingActivatedRate: round2(rate(trailingActs, items.length)),
    avgMFEBeforeExit: round2(avg(mfe)),
    avgMAEBeforeExit: round2(avg(mae)),
    worstCaseReturn: finalReturns.length ? round2(Math.min(...finalReturns)) : null,
    bestCaseReturn: finalReturns.length ? round2(Math.max(...finalReturns)) : null,
  };
  out.returnToRiskRatio = (out.avgReturn != null && out.avgMAEBeforeExit != null && Math.abs(out.avgMAEBeforeExit) > 0.0001)
    ? round2(out.avgReturn / Math.abs(out.avgMAEBeforeExit))
    : null;

  // vs HOLD_D10
  if (holdBaseline && scenarioName !== 'HOLD_D10') {
    out.avgReturnDiffVsHoldD10 = (out.avgReturn != null && holdBaseline.avgReturn != null)
      ? round2(out.avgReturn - holdBaseline.avgReturn) : null;
    out.medianReturnDiffVsHoldD10 = (out.medianReturn != null && holdBaseline.medianReturn != null)
      ? round2(out.medianReturn - holdBaseline.medianReturn) : null;
    out.riskReductionVsHoldD10 = (out.avgMAEBeforeExit != null && holdBaseline.avgMAEBeforeExit != null)
      ? round2(holdBaseline.avgMAEBeforeExit - out.avgMAEBeforeExit) : null; // positive = better
    out.worstCaseImprovementVsHoldD10 = (out.worstCaseReturn != null && holdBaseline.worstCaseReturn != null)
      ? round2(out.worstCaseReturn - holdBaseline.worstCaseReturn) : null;
  }
  return out;
}

function aggregateGroup(records) {
  const hold = aggregateScenario(records, 'HOLD_D10', null);
  const result = { HOLD_D10: hold };
  for (const s of SCENARIOS) {
    if (s.name === 'HOLD_D10') continue;
    result[s.name] = aggregateScenario(records, s.name, hold);
  }
  return result;
}

// ─────────── 표본 요약 ───────────
function describeGroup(records, label) {
  const d10s = records.map(r => r.entryD10Return).filter(Number.isFinite);
  const d5s = records.map(r => r.entryD5Return).filter(Number.isFinite);
  const mfe = records.map(r => r.entryMFE10).filter(Number.isFinite);
  const mae = records.map(r => r.entryMAE10).filter(Number.isFinite);
  return {
    groupName: label,
    count: records.length,
    uniqueStocks: new Set(records.map(r => r.code)).size,
    avgEntryD5Return: round2(avg(d5s)),
    avgEntryD10Return: round2(avg(d10s)),
    medianEntryD10Return: round2(median(d10s)),
    posRateD5: round2(rate(d5s.filter(v => v > 0).length, d5s.length)),
    posRateD10: round2(rate(d10s.filter(v => v > 0).length, d10s.length)),
    avgEntryMFE10: round2(avg(mfe)),
    avgEntryMAE10: round2(avg(mae)),
    mfe10Hit10Rate: round2(rate(mfe.filter(v => v >= 10).length, mfe.length)),
    mfe10Hit15Rate: round2(rate(mfe.filter(v => v >= 15).length, mfe.length)),
    mfe10Hit20Rate: round2(rate(mfe.filter(v => v >= 20).length, mfe.length)),
    mae10BelowMinus5Rate: round2(rate(mae.filter(v => v <= -5).length, mae.length)),
    mae10BelowMinus10Rate: round2(rate(mae.filter(v => v <= -10).length, mae.length)),
  };
}

const eDedup = dedupEvents(eEnriched, DEDUP_MODE);
const hDedup = dedupEvents(hEnriched, DEDUP_MODE);

const summary = {
  scanStart: entryReport.meta.scanStart,
  scanEnd: entryReport.meta.scanEnd,
  signalBased: {
    E: describeGroup(eEnriched, 'E그룹: +1% 돌파 진입 전체'),
    H: describeGroup(hEnriched, 'H그룹: 돌파 성공 후보'),
  },
  eventDedupBased: {
    mode: DEDUP_MODE,
    E: describeGroup(eDedup, 'E그룹 (이벤트 기준): +1% 돌파 진입 전체'),
    H: describeGroup(hDedup, 'H그룹 (이벤트 기준): 돌파 성공 후보'),
  },
};

const scenarioResults = {
  signalBased: {
    E: aggregateGroup(eEnriched),
    H: aggregateGroup(hEnriched),
  },
  eventDedupBased: {
    E: aggregateGroup(eDedup),
    H: aggregateGroup(hDedup),
  },
};

// ─────────── TOP 시나리오 (H그룹 이벤트 기준) ───────────
function rankByMetric(scenarioResultMap, metric, ascending = false) {
  const arr = Object.values(scenarioResultMap).filter(s => s[metric] != null);
  arr.sort((a, b) => ascending ? a[metric] - b[metric] : b[metric] - a[metric]);
  return arr.map(s => ({
    scenarioName: s.scenarioName,
    scenarioLabel: s.scenarioLabel,
    value: s[metric],
    count: s.count,
  }));
}

const topScenarios = {
  byAvgReturn: rankByMetric(scenarioResults.eventDedupBased.H, 'avgReturn'),
  byMedianReturn: rankByMetric(scenarioResults.eventDedupBased.H, 'medianReturn'),
  byBestWorstCase: rankByMetric(scenarioResults.eventDedupBased.H, 'worstCaseReturn'), // higher worst = better
  byReturnToRisk: rankByMetric(scenarioResults.eventDedupBased.H, 'returnToRiskRatio'),
};

// ─────────── 종목별 상세 + Best/Worst ───────────
function flattenScenarios(record) {
  const out = {
    code: record.code,
    name: record.name,
    market: record.market,
    qvaSignalDate: record.qvaSignalDate,
    vviDate: record.vviDate,
    entryDate: record.entryDate,
    entryPrice: record.entryPrice,
    vviHigh: record.vviHigh,
    vviClose: record.vviClose,
    vviLow: record.vviLow,
    vviCloseLocation: record.vviCloseLocation,
    nextHigh: record.nextHigh,
    nextClose: record.nextClose,
    breakoutSuccess: record.breakoutSuccess,
    breakoutFail: record.breakoutFail,
    entryD5Return: round2(record.entryD5Return),
    entryD10Return: round2(record.entryD10Return),
    entryMFE10: round2(record.entryMFE10),
    entryMAE10: round2(record.entryMAE10),
    scenarios: {},
  };
  for (const [name, s] of Object.entries(record.scenarios || {})) {
    out.scenarios[name] = {
      scenarioName: s.scenarioName,
      scenarioLabel: s.scenarioLabel,
      exitDate: s.exitDate,
      exitReason: s.exitReason,
      exitPrice: s.exitPrice ? round2(s.exitPrice) : null,
      finalReturn: round2(s.finalReturn),
      hitTarget: s.hitTarget,
      partialTaken: s.partialTaken,
      stoppedOut: s.stoppedOut,
      trailingActivated: s.trailingActivated,
      maxReturnBeforeExit: round2(s.maxReturnBeforeExit),
      maxDrawdownBeforeExit: round2(s.maxDrawdownBeforeExit),
      holdingDays: s.holdingDays,
      sameDayTargetAndStop: s.sameDayTargetAndStop,
    };
  }
  return out;
}

const hSorted = [...hEnriched].sort((a, b) => {
  const ar = a.scenarios?.HOLD_D10?.finalReturn ?? -Infinity;
  const br = b.scenarios?.HOLD_D10?.finalReturn ?? -Infinity;
  return br - ar;
});
const top10 = hSorted.slice(0, 10).map(flattenScenarios);
const worst10 = hSorted.slice(-10).reverse().map(flattenScenarios);
const detailsAll = hSorted.map(flattenScenarios);

// ─────────── 출력 ───────────
const jsonOut = {
  meta: {
    purpose: 'QVA → VVI → 다음날 +1% 돌파 → 돌파 성공 후 익절/청산 규칙 검증',
    notice: '본 보고서는 매수 추천이 아니라 조건 조합 성과 검증용입니다. 본 검증은 ' +
      formatDate(entryReport.meta.scanStart) + ' ~ ' + formatDate(entryReport.meta.scanEnd) +
      ' 단일 시장 사이클 기준입니다. 다른 시장 국면에서도 동일하게 작동하는지는 추가 검증이 필요합니다.',
    trackingDays: TRACKING_DAYS,
    dedupMode: DEDUP_MODE,
    scanStart: entryReport.meta.scanStart,
    scanEnd: entryReport.meta.scanEnd,
    generatedAt: new Date().toISOString(),
  },
  summary,
  scenarioResults,
  topScenarios,
  top10,
  worst10,
  details: detailsAll,
};

fs.writeFileSync(
  path.join(ROOT, 'qva-vvi-breakout-exit-report.json'),
  JSON.stringify(jsonOut, null, 2),
  'utf-8'
);
console.log(`\n✅ JSON 저장: qva-vvi-breakout-exit-report.json`);

// ─────────── 콘솔 요약 ───────────
const fmtNum = (v) => v == null ? '   -  ' : (v >= 0 ? '+' : '') + v.toFixed(2).padStart(6);
const fmtPct = (v) => v == null ? '   -  ' : v.toFixed(1).padStart(5) + '%';

console.log(`\n${'='.repeat(120)}`);
console.log(`📊 H그룹 (이벤트 기준) 시나리오별 성과`);
console.log(`${'시나리오'.padEnd(36)} | n   | 평균  중간   최악   | D10+ 비율 | 목표% | 청산% | adj MAE | RR`);
const hScenEvent = scenarioResults.eventDedupBased.H;
for (const s of SCENARIOS) {
  const r = hScenEvent[s.name];
  if (!r) continue;
  console.log(
    `${s.label.padEnd(36)} | ` +
    `${String(r.count).padStart(3)} | ` +
    `${fmtNum(r.avgReturn)} ${fmtNum(r.medianReturn)} ${fmtNum(r.worstCaseReturn)} | ` +
    `${fmtPct(r.positiveReturnRate)} | ${fmtPct(r.targetHitRate)} | ${fmtPct(r.stopRate)} | ` +
    `${fmtNum(r.avgMAEBeforeExit)} | ${(r.returnToRiskRatio ?? '-').toString().padStart(5)}`
  );
}

console.log(`\n📊 신호기준 vs 이벤트기준 (H그룹, HOLD_D10)`);
const sH = scenarioResults.signalBased.H.HOLD_D10;
const eH = scenarioResults.eventDedupBased.H.HOLD_D10;
console.log(`  신호 기준: n=${sH.count} 종목 ${sH.uniqueStocks} | 평균 ${fmtNum(sH.avgReturn)} 중간 ${fmtNum(sH.medianReturn)} D10+ ${fmtPct(sH.positiveReturnRate)} MAE ${fmtNum(sH.avgMAEBeforeExit)}`);
console.log(`  이벤트 기준: n=${eH.count} 종목 ${eH.uniqueStocks} | 평균 ${fmtNum(eH.avgReturn)} 중간 ${fmtNum(eH.medianReturn)} D10+ ${fmtPct(eH.positiveReturnRate)} MAE ${fmtNum(eH.avgMAEBeforeExit)}`);

// ─────────── HTML 출력 ───────────
const SCENARIO_TOOLTIPS = {
  HOLD_D10: '진입 후 10거래일 종가까지 단순 보유한 결과입니다.',
  TP10: '진입가 대비 +10% 도달 시 전량 익절. 도달 못하면 10일 종가 청산.',
  TP15: '진입가 대비 +15% 도달 시 전량 익절. 도달 못하면 10일 종가 청산.',
  TP20: '진입가 대비 +20% 도달 시 전량 익절. 도달 못하면 10일 종가 청산.',
  TP30: '진입가 대비 +30% 도달 시 전량 익절. 도달 못하면 10일 종가 청산.',
  TP10_HALF: '+10% 도달 시 절반 익절, 나머지 절반은 10일 종가 청산.',
  TP15_HALF: '+15% 도달 시 절반 익절, 나머지 절반은 10일 종가 청산.',
  TP20_HALF: '+20% 도달 시 절반 익절, 나머지 절반은 10일 종가 청산.',
  TRAIL_FROM_HIGH_5: '+10% 상승 후부터 trailing 활성화, 최고가 대비 -5% 하락 시 청산.',
  TRAIL_FROM_HIGH_7: '+10% 상승 후부터 trailing 활성화, 최고가 대비 -7% 하락 시 청산.',
  STOP_VVI_LOW_TP15_HALF: '+15% 절반 익절 + VVI 저가 이탈 시 손절. 같은 날 둘 다 닿으면 보수적으로 손절 우선.',
  STOP_MINUS_7_TP15_HALF: '+15% 절반 익절 + 진입가 -7% 손절. 같은 날 둘 다 닿으면 보수적으로 손절 우선.',
  TP15_HALF_THEN_TRAIL_7: '+15% 절반 익절 후, 나머지 절반은 그 시점 고점 대비 -7% trailing.',
  TP20_HALF_THEN_TRAIL_7: '+20% 절반 익절 후, 나머지 절반은 그 시점 고점 대비 -7% trailing.',
};

const htmlTemplate = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QVA → VVI → 돌파 성공 후 익절/청산 시나리오 검증</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
  h1 { color: #f1f5f9; margin: 0 0 4px 0; font-size: 24px; }
  h1 .sub { color: #94a3b8; font-size: 14px; font-weight: 400; margin-left: 6px; }
  h2 { color: #f1f5f9; margin: 32px 0 12px 0; font-size: 18px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
  h3 { color: #cbd5e1; font-size: 14px; margin: 18px 0 8px 0; font-weight: 600; }
  .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 16px; }
  .nav { display: flex; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .nav a { color: #93c5fd; text-decoration: none; font-size: 13px; padding: 6px 10px; background: #1e293b; border-radius: 6px; }
  .nav a:hover { background: #334155; }
  .nav a.active { background: #1e3a8a; color: #fff; }

  .info-box { background: #1e293b; padding: 14px 18px; border-radius: 8px; margin-bottom: 14px; border-left: 3px solid #60a5fa; }
  .info-box p { margin: 0 0 8px 0; font-size: 13px; line-height: 1.65; color: #cbd5e1; }
  .info-box p:last-child { margin-bottom: 0; }
  .info-box strong { color: #f1f5f9; }

  .group-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
  .group-card { background: #1e293b; padding: 14px 18px; border-radius: 8px; border-left: 3px solid #10b981; }
  .group-card.e { border-left-color: #94a3b8; }
  .group-card .title { font-weight: 700; color: #f1f5f9; font-size: 15px; margin-bottom: 6px; }
  .group-card .desc { color: #94a3b8; font-size: 12px; margin-bottom: 10px; line-height: 1.6; }
  .group-card .narrative { color: #e2e8f0; font-size: 13px; line-height: 1.75; padding: 10px 12px; background: #0f172a; border-radius: 6px; border: 1px solid #334155; margin-bottom: 10px; }
  .group-card .narrative strong { color: #fbbf24; }
  .quad { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .quad .panel { background: #0f172a; padding: 8px 10px; border-radius: 6px; }
  .quad .panel-title { color: #94a3b8; font-size: 11px; margin-bottom: 4px; }
  .quad .panel-row { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
  .quad .panel-row .lbl { color: #94a3b8; }
  .quad .panel-row .val { color: #e2e8f0; font-weight: 600; }

  .note { color: #94a3b8; font-size: 12px; line-height: 1.6; margin-bottom: 6px; }
  .note strong { color: #cbd5e1; }
  .note.warn { color: #fcd34d; background: #1e293b; padding: 10px 14px; border-radius: 6px; border-left: 3px solid #f59e0b; }
  .note.dedup { background: #1e293b; padding: 10px 14px; border-radius: 6px; border-left: 3px solid #fbbf24; color: #cbd5e1; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #334155; white-space: nowrap; }
  th.txt, td.txt { text-align: left; }
  th { background: #283447; color: #cbd5e1; font-weight: 600; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 1; }
  th:hover { background: #334155; }
  tr:hover { background: #283447; }
  th .help { display: inline-block; margin-left: 4px; color: #60a5fa; cursor: help; font-size: 10px; }
  .table-wrap { background: #1e293b; padding: 8px; border-radius: 8px; margin-bottom: 14px; overflow-x: auto; }
  tr.highlighted td { background: #14532d; }

  .pos { color: #10b981; }
  .neg { color: #f87171; }
  .muted { color: #64748b; }
  .market-K { color: #60a5fa; }
  .market-Q { color: #c084fc; }

  .top-rank { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 14px; }
  .rank-card { background: #1e293b; padding: 12px 14px; border-radius: 8px; }
  .rank-card .title { color: #f1f5f9; font-weight: 700; font-size: 13px; margin-bottom: 4px; }
  .rank-card .subtitle { color: #94a3b8; font-size: 11px; margin-bottom: 8px; }
  .rank-card .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #334155; font-size: 12px; }
  .rank-card .row:last-child { border-bottom: 0; }
  .rank-card .row .label { color: #cbd5e1; }
  .rank-card .row .val { color: #fbbf24; font-weight: 600; }

  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .controls input[type=text] { flex: 1; min-width: 200px; padding: 8px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 13px; }
  .controls select { padding: 8px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 13px; }

  @media (max-width: 800px) {
    body { padding: 12px; }
    h1 { font-size: 18px; }
    h2 { font-size: 15px; }
    .group-summary { grid-template-columns: 1fr; }
    .table-wrap table { font-size: 11px; }
    .table-wrap th, .table-wrap td { padding: 6px 6px; }
  }
</style>
</head>
<body>
  <h1>📊 QVA → VVI → 돌파 성공 후 익절/청산 시나리오 검증<span class="sub">— 진입 후 어떤 청산 규칙이 가장 적합한지</span></h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="nav">
    <a href="/qva-watchlist">📋 매일 운영 보드</a>
    <span style="color:#475569;font-size:11px;align-self:center;">검증 ▶</span>
    <a href="/qva-to-vvi-report">QVA → VVI 전환</a>
    <a href="/qva-vvi-breakout-entry-report">진입</a>
    <a href="/qva-vvi-breakout-exit-report" class="active">익절/청산</a>
  </div>

  <div class="note" style="color:#94a3b8;font-size:12px;margin-bottom:6px;">📚 <strong style="color:#cbd5e1;">검증 보고서</strong> — 매일 운영 화면이 아닌 과거 데이터 분석. 매일 보드는 <a href="/qva-watchlist" style="color:#93c5fd;">📋 매일 운영 보드</a>로 이동하세요.</div>

  <div class="info-box">
    <p>이 보고서는 <strong>QVA 후보 중 VVI 전환과 다음날 돌파 성공까지 확인된 종목</strong>을 대상으로, 진입 후 어떤 익절/청산 규칙이 더 적합한지 검증합니다.</p>
    <p>QVA는 <strong>감시 시작</strong>, VVI는 <strong>거래대금 초동 확인</strong>, 다음날 <strong>vviHigh × 1.01 돌파</strong>와 <strong>종가 vviHigh 이상 마감</strong>은 돌파 성공 조건입니다.</p>
    <p>본 보고서는 <strong>매수 추천이 아니라 조건 조합의 성과 검증용</strong>입니다.</p>
  </div>

  <div class="note warn" id="period-warn"></div>

  <h2>그룹별 기본 성과</h2>
  <div class="group-summary" id="group-summary"></div>

  <h2>익절/청산 시나리오별 성과 비교 — H그룹</h2>
  <div class="note dedup">
    <strong>신호 기준</strong>은 QVA 신호 건수 기준이며, 같은 종목의 같은 VVI 이벤트가 여러 번 포함될 수 있습니다.<br>
    <strong>이벤트 기준</strong>은 <code>code + vviDate + entryDate</code> 기준으로 중복을 제거한 실제 이벤트 기준 결과입니다.<br>
    최종 판단은 <strong>이벤트 기준</strong>을 더 중요하게 보세요.
  </div>
  <h3>이벤트 기준 (중복 제거됨)</h3>
  <div class="table-wrap"><table id="scen-table-event-h"></table></div>
  <h3>신호 기준 (참고)</h3>
  <div class="table-wrap"><table id="scen-table-signal-h"></table></div>

  <h2>익절/청산 시나리오별 성과 비교 — E그룹 (참고)</h2>
  <h3>이벤트 기준</h3>
  <div class="table-wrap"><table id="scen-table-event-e"></table></div>

  <h2>TOP 시나리오 (H그룹 이벤트 기준)</h2>
  <div class="top-rank" id="top-rank"></div>

  <h2>잘 된 사례 TOP 10 <span style="color:#94a3b8;font-weight:400;font-size:13px">(H그룹, 10일 단순 보유 수익률 상위)</span></h2>
  <div class="table-wrap"><table id="top10-table"></table></div>

  <h2>아쉬운 사례 WORST 10</h2>
  <div class="table-wrap"><table id="worst10-table"></table></div>

  <h2>종목별 시나리오 상세 (H그룹)</h2>
  <div class="controls">
    <input type="text" id="filter" placeholder="종목명 또는 코드 검색…">
    <select id="scen-pick">
      ${SCENARIOS.map(s => `<option value="${s.name}">${s.label}</option>`).join('')}
    </select>
  </div>
  <div class="table-wrap"><table id="details-table"></table></div>

  <div class="note warn">
    ⚠️ 본 화면은 <strong>매수 추천이 아닙니다</strong>. 조건 조합의 성과 검증입니다.
  </div>

<script>
(function rewriteNavForFileProtocol(){
  if (location.protocol !== 'file:') return;
  const map = {
    '/qva-watchlist': 'qva-watchlist-board.html',
    '/qva-to-vvi-report': 'qva-to-vvi-report.html',
    '/qva-vvi-breakout-entry-report': 'qva-vvi-breakout-entry-report.html',
    '/qva-vvi-breakout-exit-report': 'qva-vvi-breakout-exit-report.html',
  };
  document.querySelectorAll('a[href]').forEach(a => {
    const h = a.getAttribute('href');
    if (map[h]) a.setAttribute('href', map[h]);
  });
})();

const DATA = __JSON_DATA__;
const SCEN_TOOLTIPS = __SCEN_TOOLTIPS__;
const SCEN_LIST = __SCEN_LIST__;

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8) : (d || '-'); }
function fmtNum(n) { return n != null ? Math.round(n).toLocaleString() : '-'; }
function fmtPct(n, sign) {
  if (n == null || !Number.isFinite(n)) return '<span class="muted">-</span>';
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : 'muted');
  const s = (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
  return '<span class="' + cls + '">' + s + '</span>';
}
function fmtRatio(n) { return n == null ? '-' : n.toFixed(2); }
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }

document.getElementById('subtitle').textContent =
  '스캔 ' + fmtDate(DATA.meta.scanStart) + ' ~ ' + fmtDate(DATA.meta.scanEnd) +
  ' · 진입 후 추적 D+1~D+' + DATA.meta.trackingDays +
  ' · dedup mode = ' + DATA.meta.dedupMode +
  ' · 생성: ' + DATA.meta.generatedAt.slice(0, 19).replace('T', ' ');

document.getElementById('period-warn').innerHTML =
  '⚠️ 본 검증은 <strong>' + fmtDate(DATA.meta.scanStart) + ' ~ ' + fmtDate(DATA.meta.scanEnd) + ' 단일 시장 사이클</strong> 기준입니다. 다른 시장 국면에서도 동일하게 작동하는지는 추가 검증이 필요합니다.';

// 그룹 카드 + 4분면
function groupCardHtml(g, klass, narrative) {
  const fmtPosPct = (v) => v == null ? '-' : v.toFixed(2) + '%';
  const fmtSignPct = (v) => v == null ? '-' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  return '<div class="group-card ' + klass + '">' +
    '<div class="title">' + g.groupName + '</div>' +
    '<div class="desc">' + (klass === 'h' ? 'QVA 이후 VVI가 발생했고, 다음날 VVI 고가보다 1% 이상 돌파한 뒤, 종가가 VVI 고가 위에서 마감한 후보입니다.' : 'QVA 이후 VVI가 발생했고, 다음날 VVI 고가보다 1% 이상 돌파한 후보입니다 (돌파 실패 포함).') + '</div>' +
    (narrative ? '<div class="narrative">' + narrative + '</div>' : '') +
    '<div class="quad">' +
      '<div class="panel"><div class="panel-title">📊 표본</div>' +
        '<div class="panel-row"><span class="lbl">신호 수</span><span class="val">' + g.count + '건</span></div>' +
        '<div class="panel-row"><span class="lbl">고유 종목</span><span class="val">' + g.uniqueStocks + '개</span></div>' +
      '</div>' +
      '<div class="panel"><div class="panel-title">📈 보유 결과</div>' +
        '<div class="panel-row"><span class="lbl">5일 뒤 평균</span><span class="val">' + fmtSignPct(g.avgEntryD5Return) + '</span></div>' +
        '<div class="panel-row"><span class="lbl">10일 뒤 평균</span><span class="val">' + fmtSignPct(g.avgEntryD10Return) + '</span></div>' +
        '<div class="panel-row"><span class="lbl">10일 뒤 중간</span><span class="val">' + fmtSignPct(g.medianEntryD10Return) + '</span></div>' +
        '<div class="panel-row"><span class="lbl">10일 뒤 플러스 마감 비율</span><span class="val">' + fmtPosPct(g.posRateD10) + '</span></div>' +
      '</div>' +
      '<div class="panel"><div class="panel-title">🚀 상승 기회</div>' +
        '<div class="panel-row"><span class="lbl">10일 안 최고 상승률 평균</span><span class="val">' + fmtSignPct(g.avgEntryMFE10) + '</span></div>' +
        '<div class="panel-row"><span class="lbl">+10% 이상 도달</span><span class="val">' + fmtPosPct(g.mfe10Hit10Rate) + '</span></div>' +
        '<div class="panel-row"><span class="lbl">+20% 이상 도달</span><span class="val">' + fmtPosPct(g.mfe10Hit20Rate) + '</span></div>' +
      '</div>' +
      '<div class="panel"><div class="panel-title">🛑 하락 위험</div>' +
        '<div class="panel-row"><span class="lbl">10일 안 최대 하락률 평균</span><span class="val">' + fmtSignPct(g.avgEntryMAE10) + '</span></div>' +
        '<div class="panel-row"><span class="lbl">-10% 이상 하락 비율</span><span class="val">' + fmtPosPct(g.mae10BelowMinus10Rate) + '</span></div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function buildHNarrative(h) {
  const f = (v) => v == null ? '-' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const p = (v) => v == null ? '-' : v.toFixed(2) + '%';
  return 'H그룹은 총 <strong>' + h.count + '건</strong>, 고유 종목 ' + h.uniqueStocks + '개가 발견되었습니다.<br>' +
    '진입 후 10일 뒤 평균 수익률은 <strong>' + f(h.avgEntryD10Return) + '</strong>, 중간 수익률은 ' + f(h.medianEntryD10Return) + '였습니다.<br>' +
    '10일 뒤 플러스 마감 비율은 ' + p(h.posRateD10) + '였고, 10일 안 +20% 이상 도달 비율은 ' + p(h.mfe10Hit20Rate) + '였습니다.<br>' +
    '반대로 10일 안 최대 하락률 평균은 ' + f(h.avgEntryMAE10) + ', -10% 이상 크게 밀린 비율은 ' + p(h.mae10BelowMinus10Rate) + '였습니다.';
}

const eEvent = DATA.summary.eventDedupBased.E;
const hEvent = DATA.summary.eventDedupBased.H;
document.getElementById('group-summary').innerHTML =
  groupCardHtml(eEvent, 'e', null) +
  groupCardHtml(hEvent, 'h', buildHNarrative(hEvent));

// 시나리오 비교 테이블
const SCEN_COLS = [
  { key: 'scenarioLabel', label: '시나리오', txt: true, tooltip: null },
  { key: 'count', label: '신호 수', tooltip: null },
  { key: 'uniqueStocks', label: '고유 종목 수', tooltip: null },
  { key: 'avgReturn', label: '평균 최종 수익률', sign: true, tooltip: '시나리오 적용 후 최종 수익률의 평균입니다.' },
  { key: 'medianReturn', label: '중간 최종 수익률', sign: true, tooltip: '극단값 영향을 줄인 중간값입니다.' },
  { key: 'positiveReturnRate', label: '플러스 마감 비율', tooltip: '최종 수익률이 플러스인 신호의 비율입니다.' },
  { key: 'targetHitRate', label: '목표 도달률', tooltip: '정해진 익절 목표 가격에 도달한 비율입니다.' },
  { key: 'stopRate', label: '청산 발생률', tooltip: '정해진 손절/청산 조건에 걸린 비율입니다.' },
  { key: 'avgHoldingDays', label: '평균 보유일', tooltip: '진입에서 청산까지 평균 거래일 수입니다.' },
  { key: 'avgMAEBeforeExit', label: '청산 전 최대 하락률 평균', sign: true, tooltip: '청산 전까지 진입가 대비 가장 깊었던 하락률의 평균입니다.' },
  { key: 'worstCaseReturn', label: '최악 수익률', sign: true, tooltip: '시나리오 적용 후 최종 수익률 중 가장 나빴던 케이스입니다.' },
  { key: 'returnToRiskRatio', label: '수익 대비 하락 위험 비율', tooltip: '평균 수익률을 평균 하락폭으로 나눈 값. 높을수록 수익 대비 하락 위험이 작습니다.' },
  { key: 'avgReturnDiffVsHoldD10', label: '10일 단순 보유 대비 평균 개선폭', sign: true, tooltip: '같은 그룹의 10일 단순 보유 평균 수익률과의 차이입니다.' },
  { key: 'riskReductionVsHoldD10', label: '10일 단순 보유 대비 위험 감소폭', tooltip: '10일 단순 보유 평균 하락률 - 본 시나리오 평균 하락률. 양수면 위험 완화.' },
];

function fillScenTable(tableId, scenMap, baselineName) {
  const tbl = document.getElementById(tableId);
  const headTooltip = (c) => c.tooltip ? '<span class="help" title="' + c.tooltip.replace(/"/g, '&quot;') + '">ⓘ</span>' : '';
  const thead = '<thead><tr>' + SCEN_COLS.map(c => '<th class="' + (c.txt ? 'txt' : '') + '">' + c.label + headTooltip(c) + '</th>').join('') + '</tr></thead>';
  const tbody = '<tbody>' + SCEN_LIST.map(name => {
    const s = scenMap[name];
    if (!s) return '';
    const cls = name === baselineName ? 'highlighted' : '';
    return '<tr class="' + cls + '">' + SCEN_COLS.map(c => {
      let v = s[c.key];
      let cell;
      if (c.txt) { cell = v != null ? String(v) : '-'; if (c.key === 'scenarioLabel' && SCEN_TOOLTIPS[name]) cell += ' <span class="help" title="' + SCEN_TOOLTIPS[name].replace(/"/g, '&quot;') + '">ⓘ</span>'; }
      else if (typeof v === 'number') {
        if (c.sign) cell = fmtPct(v, true);
        else if (c.key === 'avgHoldingDays') cell = v != null ? v.toFixed(1) + '일' : '-';
        else if (c.key === 'returnToRiskRatio') cell = fmtRatio(v);
        else if (['count','uniqueStocks'].includes(c.key)) cell = v.toLocaleString();
        else cell = fmtPct(v);
      } else {
        cell = '<span class="muted">-</span>';
      }
      return '<td' + (c.txt ? ' class="txt"' : '') + '>' + cell + '</td>';
    }).join('') + '</tr>';
  }).join('') + '</tbody>';
  tbl.innerHTML = thead + tbody;
}

fillScenTable('scen-table-event-h', DATA.scenarioResults.eventDedupBased.H, 'HOLD_D10');
fillScenTable('scen-table-signal-h', DATA.scenarioResults.signalBased.H, 'HOLD_D10');
fillScenTable('scen-table-event-e', DATA.scenarioResults.eventDedupBased.E, 'HOLD_D10');

// TOP 시나리오 카드
function rankCard(title, subtitle, rank) {
  return '<div class="rank-card"><div class="title">' + title + '</div><div class="subtitle">' + subtitle + '</div>' +
    rank.slice(0, 5).map(r => '<div class="row"><span class="label">' + r.scenarioLabel + ' <span class="muted" style="font-size:10px">(n=' + r.count + ')</span></span><span class="val">' + (typeof r.value === 'number' ? (r.value >= 0 ? '+' : '') + r.value.toFixed(2) + (r.value > 0 && r.value < 1 ? '' : '%') : r.value) + '</span></div>').join('') +
  '</div>';
}
document.getElementById('top-rank').innerHTML =
  rankCard('평균 수익률 기준 TOP', '평균 최종 수익률이 높은 순', DATA.topScenarios.byAvgReturn) +
  rankCard('중간 수익률 기준 TOP', '극단값 영향을 줄인 중간값 순', DATA.topScenarios.byMedianReturn) +
  rankCard('최악 손실 최소화 기준 TOP', '최악 수익률이 가장 덜 나빴던 순', DATA.topScenarios.byBestWorstCase) +
  rankCard('수익 대비 하락 위험 비율 기준 TOP', '평균 수익률 / 평균 하락폭', DATA.topScenarios.byReturnToRisk);

// TOP 10 / WORST 10
function caseTable(items) {
  const head = '<thead><tr>' +
    '<th class="txt">QVA일</th><th class="txt">VVI일</th><th class="txt">진입일</th><th class="txt">종목</th>' +
    '<th>VVI 종가위치</th><th>10일 뒤 수익률</th><th>10일 안 최고 상승률</th><th>10일 안 최대 하락률</th>' +
    '<th>+10% 익절 결과</th><th>+15% 절반 + 고점-7% 결과</th>' +
    '</tr></thead>';
  const body = '<tbody>' + items.map(d => {
    const tp10 = d.scenarios?.TP10;
    const tp15ht = d.scenarios?.TP15_HALF_THEN_TRAIL_7;
    return '<tr>' +
      '<td class="txt">' + fmtDate(d.qvaSignalDate) + '</td>' +
      '<td class="txt">' + fmtDate(d.vviDate) + '</td>' +
      '<td class="txt">' + fmtDate(d.entryDate) + '</td>' +
      '<td class="txt"><span class="' + marketCls(d.market) + '">' + (d.name || '') + '</span> <span class="muted">' + d.code + '</span></td>' +
      '<td>' + fmtRatio(d.vviCloseLocation) + '</td>' +
      '<td>' + fmtPct(d.entryD10Return, true) + '</td>' +
      '<td>' + fmtPct(d.entryMFE10, true) + '</td>' +
      '<td>' + fmtPct(d.entryMAE10, true) + '</td>' +
      '<td>' + (tp10 ? fmtPct(tp10.finalReturn, true) + ' <span class="muted" style="font-size:10px">(' + (tp10.hitTarget ? '도달' : (tp10.exitReason || '-')) + ')</span>' : '-') + '</td>' +
      '<td>' + (tp15ht ? fmtPct(tp15ht.finalReturn, true) + ' <span class="muted" style="font-size:10px">(' + (tp15ht.hitTarget ? '익절+' : '') + (tp15ht.stoppedOut ? 'trail' : (tp15ht.exitReason || '-')) + ')</span>' : '-') + '</td>' +
      '</tr>';
  }).join('') + '</tbody>';
  return head + body;
}
document.getElementById('top10-table').innerHTML = caseTable(DATA.top10);
document.getElementById('worst10-table').innerHTML = caseTable(DATA.worst10);

// 종목별 상세 (시나리오 선택)
const detailsTable = document.getElementById('details-table');
function renderDetails(scenName) {
  const head = '<thead><tr>' +
    '<th class="txt">QVA일</th><th class="txt">VVI일</th><th class="txt">진입일</th><th class="txt">종목</th>' +
    '<th>진입가</th><th>VVI 종가위치</th>' +
    '<th>최종 수익률</th><th class="txt">청산 사유</th><th>보유일</th>' +
    '<th>목표 도달</th><th>손절/청산</th><th>청산 전 최고</th><th>청산 전 최저</th>' +
    '</tr></thead>';
  const body = '<tbody>' + DATA.details.map(d => {
    const s = d.scenarios?.[scenName];
    if (!s) return '';
    const dataAttrs = ' data-name="' + (d.name || '') + '" data-code="' + d.code + '"';
    return '<tr' + dataAttrs + '>' +
      '<td class="txt">' + fmtDate(d.qvaSignalDate) + '</td>' +
      '<td class="txt">' + fmtDate(d.vviDate) + '</td>' +
      '<td class="txt">' + fmtDate(d.entryDate) + '</td>' +
      '<td class="txt"><span class="' + marketCls(d.market) + '">' + (d.name || '') + '</span> <span class="muted">' + d.code + '</span></td>' +
      '<td>' + fmtNum(d.entryPrice) + '</td>' +
      '<td>' + fmtRatio(d.vviCloseLocation) + '</td>' +
      '<td>' + fmtPct(s.finalReturn, true) + '</td>' +
      '<td class="txt"><span class="muted">' + (s.exitReason || '-') + '</span>' + (s.sameDayTargetAndStop ? ' <span class="muted" style="font-size:10px">(같은날 둘다 닿음, 보수)</span>' : '') + '</td>' +
      '<td>' + (s.holdingDays != null ? s.holdingDays + '일' : '-') + '</td>' +
      '<td>' + (s.hitTarget ? '<span class="pos">○</span>' : (s.partialTaken ? '<span class="pos">절반</span>' : '<span class="muted">×</span>')) + '</td>' +
      '<td>' + (s.stoppedOut ? '<span class="neg">○</span>' : '<span class="muted">×</span>') + '</td>' +
      '<td>' + fmtPct(s.maxReturnBeforeExit, true) + '</td>' +
      '<td>' + fmtPct(s.maxDrawdownBeforeExit, true) + '</td>' +
      '</tr>';
  }).join('') + '</tbody>';
  detailsTable.innerHTML = head + body;
  applyFilter();
}
document.getElementById('scen-pick').addEventListener('change', (e) => renderDetails(e.target.value));
renderDetails('TP15_HALF_THEN_TRAIL_7');

// 검색 필터
function applyFilter() {
  const q = document.getElementById('filter').value.trim().toLowerCase();
  detailsTable.querySelectorAll('tbody tr').forEach(tr => {
    const name = (tr.dataset.name || '').toLowerCase();
    const code = (tr.dataset.code || '').toLowerCase();
    tr.style.display = (!q || name.includes(q) || code.includes(q)) ? '' : 'none';
  });
}
document.getElementById('filter').addEventListener('input', applyFilter);
</script>
</body>
</html>
`;

const html = htmlTemplate
  .replace('__JSON_DATA__', JSON.stringify(jsonOut))
  .replace('__SCEN_TOOLTIPS__', JSON.stringify(SCENARIO_TOOLTIPS))
  .replace('__SCEN_LIST__', JSON.stringify(SCENARIOS.map(s => s.name)));

fs.writeFileSync(path.join(ROOT, 'qva-vvi-breakout-exit-report.html'), html, 'utf-8');
console.log(`✅ HTML 저장: qva-vvi-breakout-exit-report.html  (Express /qva-vvi-breakout-exit-report 라우트로 접근)\n`);
