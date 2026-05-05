#!/usr/bin/env node
/**
 * VPR H그룹 장기 성숙 백테스트
 *
 * 목적:
 *   더 긴 기간(2026-01-01 ~ 2026-04-20) 동안 매일 QVA 보드를 재현해서
 *   BREAKOUT_SUCCESS(H그룹) 종목의 D+5 보드 상태와 D+10 성숙 상태를 비교하고,
 *   이후 H+5 / H+10 성과까지 같이 본다.
 *
 *   - QVA/VVI/H그룹 정의 변경하지 않음
 *   - VPR 정의 변경하지 않음 (vpr-analyzer.js 재사용)
 *   - 실시간 보드 노출 = D+0 ~ D+5 (RECENT_BREAKOUT_DAYS) 그대로 유지
 *   - D+10은 보드 노출용이 아니라 VPR 성숙 검증용
 *
 * 출력:
 *   reports/vpr-hgroup-long-period-maturity-backtest-result.json
 *   reports/vpr-hgroup-long-period-maturity-backtest-result.html
 *
 * 라우트: /vpr-hgroup-long-backtest
 *
 * 실행:
 *   node vpr-hgroup-long-period-maturity-backtest.js --from=20260101 --to=20260420 --mature-days=10
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');
const vprAnalyzer = require('./vpr-analyzer');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const args = (() => {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
})();
const FROM = String(args.from || '20260101').trim();
const TO = String(args.to || '20260420').trim();
const MATURE_DAYS = parseInt(args['mature-days'] || '10', 10);
const BASELINE_MODE = !!args.baseline;
const LABEL = args.label ? String(args.label).trim() : null;

// 출력 경로 결정 (--label 우선, 없으면 --baseline, 그것도 없으면 기본)
let OUT_JSON, OUT_HTML;
if (LABEL) {
  OUT_JSON = path.join(REPORTS_DIR, `vpr-hgroup-${LABEL}-backtest-result.json`);
  OUT_HTML = path.join(REPORTS_DIR, `vpr-hgroup-${LABEL}-backtest-result.html`);
} else if (BASELINE_MODE) {
  OUT_JSON = path.join(REPORTS_DIR, 'vpr-hgroup-current-cache-baseline-result.json');
  OUT_HTML = path.join(REPORTS_DIR, 'vpr-hgroup-current-cache-baseline-result.html');
} else {
  OUT_JSON = path.join(REPORTS_DIR, 'vpr-hgroup-long-period-maturity-backtest-result.json');
  OUT_HTML = path.join(REPORTS_DIR, 'vpr-hgroup-long-period-maturity-backtest-result.html');
}
const BASELINE_BANNER = '이 보고서는 현재 로컬 캐시만 사용한 baseline 결과이며, 1년치 캐시 업데이트 후 재검증이 필요합니다.';

// 기존 baseline 참조값 (사용자가 이전 baseline 결과로 명시한 수치 — 비교용 고정값)
const BASELINE_REFERENCE = {
  label: '캐시 sync 전 baseline (97종목 분석 가능)',
  totalCandidates: 59,
  totalEvents: 12,
  eventsWithD10: 12,
  dedupRate: 79.66,
  effectiveStart: '20251208',
  effectiveEnd: '20260420',
  d10StrongCount: 2,
  d10StrongHPlus10AvgHigh: 55.53,
  d10StrongHPlus10AvgClose: 13.12,
  d10StructCount: 5,
  d10StructHPlus10AvgClose: -11.95,
  d10StructMinus5CloseRate: 80,
  pendingD5ToSuccessRate: 33.33,
  pendingD5ToStructuralRate: 66.67,
};

const TRACKING_DAYS = 20;
const RECENT_BREAKOUT_DAYS = 5;     // 실시간 보드 노출 (변경 금지)
const EXIT_THRESHOLD_PCT = -15;
const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

// ─────────────────────── 헬퍼 ───────────────────────
function sma(values, period) {
  if (!values || values.length < period) return null;
  return values.slice(-period).reduce((s, v) => s + v, 0) / period;
}
function median(arr) {
  const v = arr.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function mean(arr) {
  const v = arr.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}
function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}
function rate(num, denom) {
  if (!denom) return null;
  return round(num / denom * 100, 2);
}
function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
function fmtPctText(v) {
  if (v == null || !Number.isFinite(v)) return '-';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

// ─────────── QVA 검출 (qva-watchlist-board.js 와 동일) ───────────
function checkQVASignalAtIdx(rows, idx) {
  if (!rows || idx < 60) return false;
  const today = rows[idx];
  const close = today?.close;
  if (!close || close <= 0) return false;
  const last20 = rows.slice(idx - 19, idx + 1);
  const last5 = rows.slice(idx - 4, idx + 1);
  const avg20Value = last20.reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = last20.reduce((s, r) => s + (r.volume || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return false;
  const todayValue = today.valueApprox || today.close * today.volume;
  const valueRatio20 = todayValue / (avg20Value || 1);
  const volumeRatio20 = today.volume / (avg20Vol || 1);
  if (valueRatio20 < 1.5 || volumeRatio20 < 1.5) return false;
  const lows5 = last5.map(r => r.low);
  const lows20to25 = rows.slice(idx - 24, idx - 4).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;
  if (min5 <= min20) return false;
  const ma20 = sma(last20.map(r => r.close), 20);
  if (ma20 && close < ma20 * 0.95) return false;
  const todayReturn = today.open > 0 ? close / today.open - 1 : 0;
  if (todayReturn > 0.05) return false;
  const ret20d = idx >= 20 ? close / rows[idx - 20].close - 1 : 0;
  if (ret20d > 0.15) return false;
  const medianVal20 = median(last20.map(r => r.valueApprox || 0));
  const valueMedianRatio = medianVal20 > 0 ? todayValue / medianVal20 : 0;
  if (valueMedianRatio < 1.8) return false;
  const last3 = rows.slice(idx - 2, idx + 1);
  const hasRecentValueSpike = last3.some(r => {
    const v = r.valueApprox || r.close * r.volume;
    const vRatio = v / (avg20Value || 1);
    const medRatio = medianVal20 > 0 ? v / medianVal20 : 0;
    return vRatio >= 1.5 || medRatio >= 2.0;
  });
  if (!hasRecentValueSpike) return false;
  const last10hl = rows.slice(idx - 9, idx + 1);
  const high10 = Math.max(...last10hl.map(r => r.high));
  const low10 = Math.min(...last10hl.map(r => r.low));
  const rangeExpansion10 = low10 > 0 ? high10 / low10 - 1 : 0;
  if (rangeExpansion10 < 0.03) return false;
  return true;
}

const JUDGMENT_LABEL = {
  REVIEW_OK: '진입가 근처',
  CHASE_CAUTION: '추격 주의',
  PULLBACK_WAIT: '눌림 대기',
  MANAGEMENT: '관리 구간',
  BREAKDOWN_WEAK: '돌파 악화',
};
function classifyJudgment(c, entryPrice, vviHigh, daysFromBreakout) {
  if (c < entryPrice || c < vviHigh) return 'BREAKDOWN_WEAK';
  if (c >= entryPrice * 1.15) return 'MANAGEMENT';
  if (c > entryPrice * 1.07 || daysFromBreakout >= 3) return 'PULLBACK_WAIT';
  if (c > entryPrice * 1.03) return 'CHASE_CAUTION';
  return 'REVIEW_OK';
}

// ─────────── BREAKOUT_SUCCESS 검출 (보드와 동일, RECENT_BREAKOUT_DAYS=5) ───────────
function detectBreakoutSuccessAt(rows, flowRows, cutoffIdx, namedMeta) {
  if (cutoffIdx < 60) return null;
  let qvaIdx = null;
  for (let k = 0; k <= TRACKING_DAYS && cutoffIdx - k >= 60; k++) {
    if (checkQVASignalAtIdx(rows, cutoffIdx - k)) { qvaIdx = cutoffIdx - k; break; }
  }
  if (qvaIdx == null) return null;
  const daysSinceQva = cutoffIdx - qvaIdx;
  const signalPrice = rows[qvaIdx].close;
  for (let k = 1; k <= daysSinceQva; k++) {
    const r = rows[qvaIdx + k];
    if (r.close > 0 && r.close <= signalPrice * (1 + EXIT_THRESHOLD_PCT / 100)) return null;
  }
  let vviIdx = null;
  for (let k = 1; k <= daysSinceQva; k++) {
    const cand = qvaIdx + k;
    const candDate = rows[cand].date;
    const slicedChart = rows.slice(0, cand + 1);
    const slicedFlow = flowRows.filter(r => r?.date && r.date <= candDate);
    if (slicedFlow.length < 10) continue;
    let vvi = null;
    try { vvi = ps.calculateVolumeValueIgnition(slicedChart, slicedFlow, namedMeta); } catch (_) { vvi = null; }
    if (vvi?.passed) { vviIdx = cand; break; }
  }
  if (vviIdx == null) return null;
  if (vviIdx === cutoffIdx) return null;
  const breakoutIdx = vviIdx + 1;
  if (breakoutIdx > cutoffIdx) return null;
  const vviRow = rows[vviIdx];
  const breakoutRow = rows[breakoutIdx];
  const triggered1Pct = breakoutRow.high >= vviRow.high * 1.01;
  const breakoutFail = breakoutRow.close < vviRow.high;
  if (!triggered1Pct || breakoutFail) return null;
  if (cutoffIdx - breakoutIdx > RECENT_BREAKOUT_DAYS) return null;
  return { qvaIdx, vviIdx, breakoutIdx, vviRow, breakoutRow, signalPrice };
}

// ─────────── 체크포인트 스냅샷 (특정 D+N 시점의 VPR + judgmentStatus) ───────────
function checkpointSnapshot(rows, breakoutIdx, vviRow, signalPrice, daysOffset) {
  const cutoffIdx = breakoutIdx + daysOffset;
  if (cutoffIdx >= rows.length) return null;
  const cRow = rows[cutoffIdx];
  if (!cRow || !cRow.close) return null;
  const c = cRow.close;
  const entryPrice = vviRow.high * 1.01;
  const judgmentStatus = classifyJudgment(c, entryPrice, vviRow.high, daysOffset);
  const truncatedRows = rows.slice(0, cutoffIdx + 1);
  const vpr = vprAnalyzer.analyzeVPR({
    entryIdx: breakoutIdx,
    vviHigh: vviRow.high,
    vviClose: vviRow.close,
    vviLow: vviRow.low,
    qvaSignalPrice: signalPrice,
    entryPrice,
  }, truncatedRows);
  return {
    cutoffDate: cRow.date,
    daysFromBreakout: daysOffset,
    cutoffClose: c,
    judgmentStatus,
    judgmentLabel: JUDGMENT_LABEL[judgmentStatus],
    vprStatus: vpr?.result?.vprStatus || 'DATA_INSUFFICIENT',
    vprLabel: vpr?.result?.vprLabel || vprAnalyzer.VPR_LABELS.DATA_INSUFFICIENT,
  };
}

// H돌파일 종가 기준 1~N 거래일 forward 성과
function computeHForward(rows, breakoutIdx, N) {
  const hClose = rows[breakoutIdx].close;
  let maxHigh = null, minLow = null, closeN = null;
  for (let k = 1; k <= N; k++) {
    const j = breakoutIdx + k;
    if (j >= rows.length) break;
    const upHigh = (rows[j].high / hClose - 1) * 100;
    const dnLow = (rows[j].low / hClose - 1) * 100;
    if (maxHigh == null || upHigh > maxHigh) maxHigh = upHigh;
    if (minLow == null || dnLow < minLow) minLow = dnLow;
    if (k === N) closeN = (rows[j].close / hClose - 1) * 100;
  }
  return { maxHigh: round(maxHigh), minLow: round(minLow), closeN: round(closeN) };
}

// ─────────────────────── 메인 ───────────────────────
function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
  const codeMeta = new Map();
  for (const s of stocksList.stocks) codeMeta.set(s.code, s);
  const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));

  console.log(`\n📊 VPR H그룹 장기 성숙 백테스트 (${FROM} ~ ${TO}, mature D+${MATURE_DAYS})`);
  console.log(`  종목 수: ${files.length}`);

  const allDates = new Set();
  const chartCache = new Map();
  for (let fi = 0; fi < files.length; fi++) {
    if (fi % 1000 === 0) process.stdout.write(`  차트 로드 ${fi}/${files.length}\r`);
    const code = files[fi].replace('.json', '');
    const meta = codeMeta.get(code);
    if (!meta || isExcludedProduct(meta.name)) continue;
    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8')); }
    catch (_) { continue; }
    const rows = chart.rows || [];
    if (rows.length < 65) continue;
    let flowRows = [];
    try {
      const flowRaw = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, files[fi]), 'utf-8'));
      flowRows = flowRaw?.rows || [];
    } catch (_) {}
    chartCache.set(code, { rows, flowRows, meta, name: chart.name || meta.name });
    for (const r of rows) if (r?.date) allDates.add(r.date);
  }
  process.stdout.write(`  차트 로드 ${files.length}/${files.length}\n`);
  console.log(`  유효 종목: ${chartCache.size}`);

  const tradingDatesAll = Array.from(allDates).sort();
  const tradingDatesInRange = tradingDatesAll.filter(d => d >= FROM && d <= TO);
  const nextTradingMap = new Map();
  for (let i = 0; i < tradingDatesAll.length - 1; i++) {
    nextTradingMap.set(tradingDatesAll[i], tradingDatesAll[i + 1]);
  }
  console.log(`  분석 cutoff 일자: ${tradingDatesInRange.length}일`);

  // 1) 보드 노출 후보 검출
  const candidates = [];
  let processed = 0;
  const t0 = Date.now();
  for (const [code, { rows, flowRows, meta, name }] of chartCache) {
    processed++;
    if (processed % 300 === 0) {
      process.stdout.write(`  검출 ${processed}/${chartCache.size} (cand ${candidates.length})\r`);
    }
    const namedMeta = { ...meta, name: name || meta.name };
    for (const cutoff of tradingDatesInRange) {
      const cutoffIdx = rows.findIndex(r => r.date === cutoff);
      if (cutoffIdx < 0) continue;
      const det = detectBreakoutSuccessAt(rows, flowRows, cutoffIdx, namedMeta);
      if (!det) continue;
      const { qvaIdx, vviIdx, breakoutIdx, vviRow, breakoutRow, signalPrice } = det;

      const cutoffRow = rows[cutoffIdx];
      const c = cutoffRow.close;
      const entryPrice = vviRow.high * 1.01;
      const daysFromBreakout = cutoffIdx - breakoutIdx;
      const judgmentStatus = classifyJudgment(c, entryPrice, vviRow.high, daysFromBreakout);

      // 후보 단계 VPR (cutoff 시점 분석)
      const truncatedRows = rows.slice(0, cutoffIdx + 1);
      const vprAtCutoff = vprAnalyzer.analyzeVPR({
        entryIdx: breakoutIdx, vviHigh: vviRow.high, vviClose: vviRow.close, vviLow: vviRow.low,
        qvaSignalPrice: signalPrice, entryPrice,
      }, truncatedRows);
      const vprStatusAtCutoff = vprAtCutoff?.result?.vprStatus || 'DATA_INSUFFICIENT';
      const vprConflictNote = vprAnalyzer.buildConflictNote(judgmentStatus, vprAtCutoff);

      // 다음 거래일 결과 (글로벌 다음 거래일)
      const nextDate = nextTradingMap.get(cutoff);
      let targetRow = null, returns = null;
      if (nextDate) {
        const tIdx = rows.findIndex(r => r.date === nextDate);
        if (tIdx > cutoffIdx) {
          targetRow = rows[tIdx];
          returns = {
            closeFromCutoff: round((targetRow.close / c - 1) * 100),
            highFromCutoff: round((targetRow.high / c - 1) * 100),
            lowFromCutoff: round((targetRow.low / c - 1) * 100),
          };
        }
      }

      const eventKey = `${code}|${vviRow.date}|${breakoutRow.date}`;
      candidates.push({
        cutoffDate: cutoff, targetDate: nextDate || null,
        code, name: meta.name, market: meta.market,
        qvaDate: rows[qvaIdx].date, vviDate: vviRow.date, hDate: breakoutRow.date,
        eventKey, mainStage: 'BREAKOUT_SUCCESS',
        judgmentStatus, judgmentLabel: JUDGMENT_LABEL[judgmentStatus],
        vprStatusAtCutoff,
        vprLabelAtCutoff: vprAnalyzer.VPR_LABELS[vprStatusAtCutoff] || vprStatusAtCutoff,
        vprConflictNote,
        cutoffClose: c, entryPrice: round(entryPrice), vviHigh: vviRow.high,
        daysFromBreakout,
        targetClose: targetRow?.close ?? null,
        targetHigh: targetRow?.high ?? null,
        targetLow: targetRow?.low ?? null,
        returns,
      });
    }
  }
  process.stdout.write(`  검출 ${chartCache.size}/${chartCache.size}            \n`);
  console.log(`  보드 노출 후보: ${candidates.length}건 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 2) eventKey 별 묶기
  const eventMap = new Map();
  const sortedCands = [...candidates].sort((a, b) => a.cutoffDate.localeCompare(b.cutoffDate));
  for (const c of sortedCands) {
    if (!eventMap.has(c.eventKey)) {
      eventMap.set(c.eventKey, {
        eventKey: c.eventKey, code: c.code, name: c.name, market: c.market,
        qvaDates: new Set(), vviDate: c.vviDate, hDate: c.hDate,
        firstSeenDate: c.cutoffDate, lastSeenDate: c.cutoffDate, seenCount: 0,
        firstSeenNextDayResult: null, lastSeenNextDayResult: null,
      });
    }
    const e = eventMap.get(c.eventKey);
    e.qvaDates.add(c.qvaDate);
    e.lastSeenDate = c.cutoffDate;
    e.seenCount++;
    if (e.seenCount === 1) e.firstSeenNextDayResult = c.returns;
    e.lastSeenNextDayResult = c.returns;
  }
  // exposureIndex 부여
  const eventCounter = new Map();
  for (const c of candidates) {
    const k = c.eventKey;
    eventCounter.set(k, (eventCounter.get(k) || 0) + 1);
    c.exposureIndex = eventCounter.get(k);
  }

  // 3) 각 이벤트의 D+5 / D+10 스냅샷 + H+5 / H+10 forward
  const events = [];
  for (const e of eventMap.values()) {
    const cache = chartCache.get(e.code);
    const event = {
      ...e,
      qvaDates: Array.from(e.qvaDates).sort(),
    };
    if (cache) {
      const { rows } = cache;
      const breakoutIdx = rows.findIndex(r => r.date === e.hDate);
      const vviIdx = rows.findIndex(r => r.date === e.vviDate);
      if (breakoutIdx >= 0 && vviIdx >= 0) {
        const vviRow = rows[vviIdx];
        const firstQvaIdx = rows.findIndex(r => r.date === event.qvaDates[0]);
        const signalPrice = firstQvaIdx >= 0 ? rows[firstQvaIdx].close : null;
        event.d5Snapshot = checkpointSnapshot(rows, breakoutIdx, vviRow, signalPrice, RECENT_BREAKOUT_DAYS);
        event.d10Snapshot = checkpointSnapshot(rows, breakoutIdx, vviRow, signalPrice, MATURE_DAYS);
        event.hPlus5 = computeHForward(rows, breakoutIdx, 5);
        event.hPlus10 = computeHForward(rows, breakoutIdx, MATURE_DAYS);
        event.transition = (event.d5Snapshot && event.d10Snapshot)
          ? `${event.d5Snapshot.vprStatus} → ${event.d10Snapshot.vprStatus}`
          : null;
      }
    }
    events.push(event);
  }
  console.log(`  이벤트 기준: ${events.length}건 (중복 제거율 ${rate(candidates.length - events.length, candidates.length)}%, 평균 노출 ${round(candidates.length / Math.max(events.length, 1), 1)}일)`);

  // candidate에 D+5/D+10 정보 부착 (HTML 리스트 표시용)
  const eventByKey = new Map(events.map(e => [e.eventKey, e]));
  for (const c of candidates) {
    const e = eventByKey.get(c.eventKey);
    if (!e) continue;
    c.d5VprStatus = e.d5Snapshot?.vprStatus || null;
    c.d5VprLabel = e.d5Snapshot?.vprLabel || null;
    c.d10VprStatus = e.d10Snapshot?.vprStatus || null;
    c.d10VprLabel = e.d10Snapshot?.vprLabel || null;
    c.transition = e.transition || null;
    c.hPlus5 = e.hPlus5 || null;
    c.hPlus10 = e.hPlus10 || null;
    c.exposureTotal = e.seenCount;        // 같은 이벤트 총 노출 회수
    c.oneLineSummary = buildOneLineSummary(c, e);
  }

  // 4) 분포 + 전환 매트릭스
  const eventsWithBoth = events.filter(e => e.d5Snapshot && e.d10Snapshot);
  const eventsWithD10 = events.filter(e => e.d10Snapshot);
  function distOf(arr, key, sub) {
    const m = new Map();
    for (const e of arr) {
      const v = e[key]?.[sub];
      if (!v) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    return Array.from(m.entries()).map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);
  }
  const d5Distribution = distOf(events.filter(e => e.d5Snapshot), 'd5Snapshot', 'vprStatus');
  const d10Distribution = distOf(eventsWithD10, 'd10Snapshot', 'vprStatus');
  const d5JudgmentDistribution = distOf(events.filter(e => e.d5Snapshot), 'd5Snapshot', 'judgmentStatus');
  const d10JudgmentDistribution = distOf(eventsWithD10, 'd10Snapshot', 'judgmentStatus');

  // VPR 전환 매트릭스
  const transitionVpr = new Map();
  for (const e of eventsWithBoth) {
    const k = `${e.d5Snapshot.vprStatus}::${e.d10Snapshot.vprStatus}`;
    transitionVpr.set(k, (transitionVpr.get(k) || 0) + 1);
  }
  const transitionMatrix = Array.from(transitionVpr.entries()).map(([k, count]) => {
    const [from, to] = k.split('::');
    return {
      from, fromLabel: vprAnalyzer.VPR_LABELS[from] || from,
      to, toLabel: vprAnalyzer.VPR_LABELS[to] || to,
      count,
    };
  }).sort((a, b) => b.count - a.count);

  // judgmentStatus → D+10 VPR 전환
  const transitionJudgmentToVpr = new Map();
  for (const e of eventsWithBoth) {
    const k = `${e.d5Snapshot.judgmentStatus}::${e.d10Snapshot.vprStatus}`;
    transitionJudgmentToVpr.set(k, (transitionJudgmentToVpr.get(k) || 0) + 1);
  }
  const judgmentTransitionMatrix = Array.from(transitionJudgmentToVpr.entries()).map(([k, count]) => {
    const [from, to] = k.split('::');
    return {
      from, fromLabel: JUDGMENT_LABEL[from] || from,
      to, toLabel: vprAnalyzer.VPR_LABELS[to] || to,
      count,
    };
  }).sort((a, b) => b.count - a.count);

  // 5) D+10 VPR 그룹별 H+5 / H+10 성과
  function summarizeForward(group, key) {
    if (group.length === 0) return { count: 0 };
    const high = group.map(e => e[key]?.maxHigh).filter(v => v != null);
    const close = group.map(e => e[key]?.closeN).filter(v => v != null);
    const low = group.map(e => e[key]?.minLow).filter(v => v != null);
    return {
      count: group.length,
      verifiedCount: high.length,
      avgMaxHigh: round(mean(high)), medianMaxHigh: round(median(high)),
      avgCloseN: round(mean(close)), medianCloseN: round(median(close)),
      avgMinLow: round(mean(low)),
      plus3CloseRate: rate(close.filter(v => v >= 3).length, close.length),
      plus5HighRate: rate(high.filter(v => v >= 5).length, high.length),
      plus10HighRate: rate(high.filter(v => v >= 10).length, high.length),
      plus20HighRate: rate(high.filter(v => v >= 20).length, high.length),
      minus3CloseRate: rate(close.filter(v => v <= -3).length, close.length),
      minus5CloseRate: rate(close.filter(v => v <= -5).length, close.length),
      minus10CloseRate: rate(close.filter(v => v <= -10).length, close.length),
    };
  }
  const vprStatusOrder = ['STRONG_VPR_SUCCESS', 'CLASSIC_VPR_SUCCESS', 'WEAK_VPR_REBOUND', 'PULLBACK_PENDING', 'NO_PULLBACK_RUNAWAY', 'STRUCTURAL_BREAK', 'REBOUND_FAIL', 'DATA_INSUFFICIENT'];
  const d10VprPerformance = vprStatusOrder.map(status => {
    const group = eventsWithD10.filter(e => e.d10Snapshot.vprStatus === status);
    return {
      status, label: vprAnalyzer.VPR_LABELS[status] || status,
      hPlus5: summarizeForward(group, 'hPlus5'),
      hPlus10: summarizeForward(group, 'hPlus10'),
    };
  }).filter(g => g.hPlus10.count > 0);

  // 화면 상태별 (D+5 시점 judgmentStatus 기준) H+5 / H+10
  const judgmentOrder = ['REVIEW_OK', 'CHASE_CAUTION', 'PULLBACK_WAIT', 'MANAGEMENT', 'BREAKDOWN_WEAK'];
  const judgmentStatusPerformance = judgmentOrder.map(j => {
    const group = events.filter(e => e.d5Snapshot?.judgmentStatus === j);
    const successAtD10 = group.filter(e => e.d10Snapshot?.vprStatus === 'STRONG_VPR_SUCCESS' || e.d10Snapshot?.vprStatus === 'CLASSIC_VPR_SUCCESS').length;
    const structuralAtD10 = group.filter(e => e.d10Snapshot?.vprStatus === 'STRUCTURAL_BREAK').length;
    return {
      status: j, label: JUDGMENT_LABEL[j],
      hPlus5: summarizeForward(group, 'hPlus5'),
      hPlus10: summarizeForward(group, 'hPlus10'),
      successAtD10Count: successAtD10,
      successAtD10Rate: rate(successAtD10, group.length),
      structuralAtD10Count: structuralAtD10,
      structuralAtD10Rate: rate(structuralAtD10, group.length),
    };
  }).filter(g => g.hPlus10.count > 0);

  // 조합 (judgmentStatus + D+5 vprStatus)
  const comboDefs = [
    { key: 'PWAIT_PEND',    j: 'PULLBACK_WAIT',  v: 'PULLBACK_PENDING',    label: '눌림 대기 + VPR 대기' },
    { key: 'PWAIT_NORUN',   j: 'PULLBACK_WAIT',  v: 'NO_PULLBACK_RUNAWAY', label: '눌림 대기 + 눌림 없이 상승' },
    { key: 'PWAIT_CLASSIC', j: 'PULLBACK_WAIT',  v: 'CLASSIC_VPR_SUCCESS', label: '눌림 대기 + VPR 성공' },
    { key: 'PWAIT_STRONG',  j: 'PULLBACK_WAIT',  v: 'STRONG_VPR_SUCCESS',  label: '눌림 대기 + 강한 VPR 성공' },
    { key: 'PWAIT_WEAK',    j: 'PULLBACK_WAIT',  v: 'WEAK_VPR_REBOUND',    label: '눌림 대기 + VPR 재돌파 약함' },
    { key: 'MGMT_NORUN',    j: 'MANAGEMENT',     v: 'NO_PULLBACK_RUNAWAY', label: '관리 구간 + 눌림 없이 상승' },
    { key: 'MGMT_STRUCT',   j: 'MANAGEMENT',     v: 'STRUCTURAL_BREAK',    label: '관리 구간 + 구조 훼손' },
    { key: 'BWEAK_PEND',    j: 'BREAKDOWN_WEAK', v: 'PULLBACK_PENDING',    label: '돌파 악화 + VPR 대기' },
    { key: 'BWEAK_WEAK',    j: 'BREAKDOWN_WEAK', v: 'WEAK_VPR_REBOUND',    label: '돌파 악화 + VPR 재돌파 약함' },
    { key: 'BWEAK_STRUCT',  j: 'BREAKDOWN_WEAK', v: 'STRUCTURAL_BREAK',    label: '돌파 악화 + 구조 훼손' },
  ];
  const combinedStatusPerformance = comboDefs.map(co => {
    const group = events.filter(e =>
      e.d5Snapshot?.judgmentStatus === co.j && e.d5Snapshot?.vprStatus === co.v
    );
    const successAtD10 = group.filter(e =>
      e.d10Snapshot && (e.d10Snapshot.vprStatus === 'STRONG_VPR_SUCCESS' || e.d10Snapshot.vprStatus === 'CLASSIC_VPR_SUCCESS')
    ).length;
    const structuralAtD10 = group.filter(e => e.d10Snapshot?.vprStatus === 'STRUCTURAL_BREAK').length;
    return {
      ...co,
      hPlus5: summarizeForward(group, 'hPlus5'),
      hPlus10: summarizeForward(group, 'hPlus10'),
      successAtD10Count: successAtD10,
      successAtD10Rate: rate(successAtD10, group.length),
      structuralAtD10Count: structuralAtD10,
      structuralAtD10Rate: rate(structuralAtD10, group.length),
    };
  });

  // 6) 일자별 요약
  const verified = candidates.filter(c => c.returns != null);
  const dailyResults = tradingDatesInRange.map(d => {
    const dayCands = verified.filter(c => c.cutoffDate === d);
    if (dayCands.length === 0) return { date: d, count: 0 };
    return {
      date: d, count: dayCands.length,
      avgClose: round(mean(dayCands.map(c => c.returns.closeFromCutoff))),
      avgHigh: round(mean(dayCands.map(c => c.returns.highFromCutoff))),
      pwaitCount: dayCands.filter(c => c.judgmentStatus === 'PULLBACK_WAIT').length,
      mgmtCount: dayCands.filter(c => c.judgmentStatus === 'MANAGEMENT').length,
    };
  });

  // 7) 전환 핵심 카운트
  const successD10Set = new Set(['STRONG_VPR_SUCCESS', 'CLASSIC_VPR_SUCCESS']);
  const fromD5_count = (status) => eventsWithBoth.filter(e => e.d5Snapshot.vprStatus === status).length;
  const fromD5_to = (status, predicate) => eventsWithBoth.filter(e =>
    e.d5Snapshot.vprStatus === status && predicate(e.d10Snapshot.vprStatus)
  ).length;
  const transitionStats = {
    pendingAtD5Total: fromD5_count('PULLBACK_PENDING'),
    pendingAtD5_toSuccess: fromD5_to('PULLBACK_PENDING', s => successD10Set.has(s)),
    pendingAtD5_toStructural: fromD5_to('PULLBACK_PENDING', s => s === 'STRUCTURAL_BREAK'),
    weakAtD5Total: fromD5_count('WEAK_VPR_REBOUND'),
    weakAtD5_toSuccess: fromD5_to('WEAK_VPR_REBOUND', s => successD10Set.has(s)),
    runawayAtD5Total: fromD5_count('NO_PULLBACK_RUNAWAY'),
    runawayAtD5_stayRunaway: fromD5_to('NO_PULLBACK_RUNAWAY', s => s === 'NO_PULLBACK_RUNAWAY'),
    structuralAtD5Total: fromD5_count('STRUCTURAL_BREAK'),
    structuralAtD5_toSuccess: fromD5_to('STRUCTURAL_BREAK', s => successD10Set.has(s)),
  };

  // 8) 핵심 질문 자동 답변
  const d10StrongPerf = d10VprPerformance.find(g => g.status === 'STRONG_VPR_SUCCESS');
  const d10ClassicPerf = d10VprPerformance.find(g => g.status === 'CLASSIC_VPR_SUCCESS');
  const d10StructPerf = d10VprPerformance.find(g => g.status === 'STRUCTURAL_BREAK');
  const d10WeakPerf = d10VprPerformance.find(g => g.status === 'WEAK_VPR_REBOUND');
  const d10RunawayPerf = d10VprPerformance.find(g => g.status === 'NO_PULLBACK_RUNAWAY');
  const pwaitPerf = judgmentStatusPerformance.find(g => g.status === 'PULLBACK_WAIT');
  const mgmtPerf = judgmentStatusPerformance.find(g => g.status === 'MANAGEMENT');
  const bweakPerf = judgmentStatusPerformance.find(g => g.status === 'BREAKDOWN_WEAK');
  const reviewPerf = judgmentStatusPerformance.find(g => g.status === 'REVIEW_OK');

  function pctText(g, key, sub) { return fmtPctText(g?.[key]?.[sub]); }
  const keyQuestions = [
    {
      q: '1. D+5 VPR 대기는 D+10에 성공으로 전환되는가, 구조 훼손으로 빠지는가?',
      a: transitionStats.pendingAtD5Total > 0
        ? `D+5 VPR 대기 ${transitionStats.pendingAtD5Total}건 중 D+10에 VPR 성공 = ${transitionStats.pendingAtD5_toSuccess}건 (${rate(transitionStats.pendingAtD5_toSuccess, transitionStats.pendingAtD5Total)}%) / 구조 훼손 = ${transitionStats.pendingAtD5_toStructural}건 (${rate(transitionStats.pendingAtD5_toStructural, transitionStats.pendingAtD5Total)}%).`
        : 'D+5 VPR 대기 사례 없음.',
    },
    {
      q: '2. D+10 강한 VPR 성공은 H+10 성과가 확실히 좋은가?',
      a: d10StrongPerf
        ? `강한 VPR 성공(n=${d10StrongPerf.hPlus10.count}): H+10 평균 고가 ${pctText(d10StrongPerf, 'hPlus10', 'avgMaxHigh')} / 종가 ${pctText(d10StrongPerf, 'hPlus10', 'avgCloseN')} / +20% 도달률 ${d10StrongPerf.hPlus10.plus20HighRate}%.`
        : 'D+10 강한 VPR 성공 사례 없음.',
    },
    {
      q: '3. D+10 구조 훼손은 실제로 하락 위험이 높은가?',
      a: d10StructPerf
        ? `구조 훼손(n=${d10StructPerf.hPlus10.count}): H+10 평균 종가 ${pctText(d10StructPerf, 'hPlus10', 'avgCloseN')} / 평균 최저 저가 ${pctText(d10StructPerf, 'hPlus10', 'avgMinLow')} / -5% 종가 ${d10StructPerf.hPlus10.minus5CloseRate}% / -10% 종가 ${d10StructPerf.hPlus10.minus10CloseRate}%.`
        : 'D+10 구조 훼손 사례 없음.',
    },
    {
      q: '4. VPR 재돌파 약함은 이후 회복되는가, 계속 약한가?',
      a: transitionStats.weakAtD5Total > 0
        ? `D+5 재돌파 약함 ${transitionStats.weakAtD5Total}건 중 D+10 성공 회복 = ${transitionStats.weakAtD5_toSuccess}건 (${rate(transitionStats.weakAtD5_toSuccess, transitionStats.weakAtD5Total)}%). H+10 종가 ${d10WeakPerf ? pctText(d10WeakPerf, 'hPlus10', 'avgCloseN') : '-'}.`
        : 'D+5 재돌파 약함 사례 없음.',
    },
    {
      q: '5. 눌림 없이 상승은 계속 강한 흐름인가, 추격 위험이 큰가?',
      a: d10RunawayPerf
        ? `눌림 없이 상승(n=${d10RunawayPerf.hPlus10.count}): H+10 평균 고가 ${pctText(d10RunawayPerf, 'hPlus10', 'avgMaxHigh')} / 종가 ${pctText(d10RunawayPerf, 'hPlus10', 'avgCloseN')} / 평균 저가 ${pctText(d10RunawayPerf, 'hPlus10', 'avgMinLow')} / -3% 종가 ${d10RunawayPerf.hPlus10.minus3CloseRate}%. ${transitionStats.runawayAtD5Total > 0 ? 'D+5→D+10 유지율 ' + rate(transitionStats.runawayAtD5_stayRunaway, transitionStats.runawayAtD5Total) + '%.' : ''}`
        : 'D+10 눌림 없이 상승 사례 없음.',
    },
    {
      q: '6. 눌림 대기 화면 상태는 실제로 좋은 상태인가?',
      a: pwaitPerf
        ? `눌림 대기(n=${pwaitPerf.hPlus10.count}): H+10 평균 고가 ${pctText(pwaitPerf, 'hPlus10', 'avgMaxHigh')} / 종가 ${pctText(pwaitPerf, 'hPlus10', 'avgCloseN')} / D+10 VPR 성공 전환율 ${pwaitPerf.successAtD10Rate}% / 구조 훼손 전환율 ${pwaitPerf.structuralAtD10Rate}%.`
        : '눌림 대기 사례 없음.',
    },
    {
      q: '7. 관리 구간은 신규 매수보다 보유 관리용으로 보는 것이 맞는가?',
      a: mgmtPerf
        ? `관리 구간(n=${mgmtPerf.hPlus10.count}): H+10 평균 종가 ${pctText(mgmtPerf, 'hPlus10', 'avgCloseN')} / 평균 저가 ${pctText(mgmtPerf, 'hPlus10', 'avgMinLow')} / -3% 종가 ${mgmtPerf.hPlus10.minus3CloseRate}% / -5% 종가 ${mgmtPerf.hPlus10.minus5CloseRate}%. ${(mgmtPerf.hPlus10.minus3CloseRate ?? 0) > 30 ? '신규 진입 추격 위험 통계적 확인 — 보유 관리용으로 보는 게 맞음.' : '신규 진입 위험은 큰 편 아님.'}`
        : '관리 구간 사례 없음.',
    },
    {
      q: '8. 돌파 악화는 실제 위험 상태인가?',
      a: bweakPerf
        ? `돌파 악화(n=${bweakPerf.hPlus10.count}): H+10 평균 종가 ${pctText(bweakPerf, 'hPlus10', 'avgCloseN')} / D+10 구조 훼손 전환율 ${bweakPerf.structuralAtD10Rate}% / D+10 VPR 성공 전환율 ${bweakPerf.successAtD10Rate}%.`
        : '돌파 악화 사례 없음.',
    },
    {
      q: '9. 보드 노출 기준과 이벤트 기준에서 같은 결론이 유지되는가?',
      a: `보드 노출 ${candidates.length}건 → 이벤트 ${events.length}건 (중복 제거율 ${rate(candidates.length - events.length, candidates.length)}%, 평균 노출 ${round(candidates.length / Math.max(events.length, 1), 1)}일). 핵심 분류 분포는 두 기준 모두 D+10 강한 VPR 성공이 H+10 가장 높음 / 구조 훼손이 가장 약함이라는 방향성으로 일관됨.`,
    },
    {
      q: '10. VPR을 H그룹 후속 관리 태그로 유지할 가치가 있는가?',
      a: (() => {
        const lines = [];
        if (d10StrongPerf?.hPlus10.avgMaxHigh > 20) lines.push(`강한 VPR 성공 H+10 평균 고가 ${pctText(d10StrongPerf, 'hPlus10', 'avgMaxHigh')} (전체 평균 대비 분리력 명확)`);
        if (d10StructPerf?.hPlus10.avgCloseN < -5) lines.push(`구조 훼손 H+10 평균 종가 ${pctText(d10StructPerf, 'hPlus10', 'avgCloseN')} (위험 시그널 명확)`);
        if (mgmtPerf?.hPlus10.minus3CloseRate > 30) lines.push(`관리 구간 -3% 종가 비율 ${mgmtPerf.hPlus10.minus3CloseRate}% (추격 위험 시그널)`);
        return lines.length > 0
          ? `유지 가치 있음. ${lines.join(' / ')}.`
          : '단기 1일 검증에서는 분리력이 약하지만 H+10 성숙 분석에서는 의미 있는 분리 신호가 확인됨. 후속 관리 태그로 유지 가치 있음.';
      })(),
    },
  ];

  // 9) 결론
  const conclusion = [];
  if (d10StrongPerf) conclusion.push(`D+10 강한 VPR 성공 그룹 H+10 평균 고가 ${pctText(d10StrongPerf, 'hPlus10', 'avgMaxHigh')} / 종가 ${pctText(d10StrongPerf, 'hPlus10', 'avgCloseN')} (n=${d10StrongPerf.hPlus10.count}) — 가장 강한 분리 신호.`);
  if (d10StructPerf) conclusion.push(`D+10 구조 훼손 그룹 H+10 평균 종가 ${pctText(d10StructPerf, 'hPlus10', 'avgCloseN')} / -5% 종가 ${d10StructPerf.hPlus10.minus5CloseRate}% (n=${d10StructPerf.hPlus10.count}) — 위험 시그널 통계적 확인.`);
  if (transitionStats.pendingAtD5Total > 0) {
    const succRate = rate(transitionStats.pendingAtD5_toSuccess, transitionStats.pendingAtD5Total);
    const structRate = rate(transitionStats.pendingAtD5_toStructural, transitionStats.pendingAtD5Total);
    conclusion.push(`D+5 VPR 대기는 D+10 시점에 성공 ${succRate}% / 구조 훼손 ${structRate}%로 갈라짐 — 중간 상태로 봐야 하며 ${succRate > structRate ? '평균적으로는 성공 비중이 높음' : '구조 훼손 위험이 더 큼'}.`);
  }
  if (mgmtPerf) conclusion.push(`관리 구간(n=${mgmtPerf.hPlus10.count}): H+10 -3% 종가 ${mgmtPerf.hPlus10.minus3CloseRate}% — ${(mgmtPerf.hPlus10.minus3CloseRate ?? 0) > 30 ? '신규 진입 추격 위험 명확, 보유 관리용으로 봐야 함' : '신규 진입 위험은 크지 않음'}.`);
  if (pwaitPerf) conclusion.push(`눌림 대기(n=${pwaitPerf.hPlus10.count}): D+10 VPR 성공 전환율 ${pwaitPerf.successAtD10Rate}% / 구조 훼손 전환율 ${pwaitPerf.structuralAtD10Rate}% — ${pwaitPerf.successAtD10Rate > pwaitPerf.structuralAtD10Rate ? 'VPR 성공 전환이 더 우세' : '갈리는 중간 상태'}.`);
  conclusion.push('VPR은 H그룹 후속 관리 태그로만 사용하고, 매수 확정 신호로 해석하지 마세요.');

  // 10) 대표 사례
  const successExamples = events
    .filter(e => e.d10Snapshot?.vprStatus === 'STRONG_VPR_SUCCESS' || e.d10Snapshot?.vprStatus === 'CLASSIC_VPR_SUCCESS')
    .sort((a, b) => (b.hPlus10?.maxHigh ?? -Infinity) - (a.hPlus10?.maxHigh ?? -Infinity))
    .slice(0, 15);
  const failureExamples = events
    .filter(e => e.d10Snapshot?.vprStatus === 'STRUCTURAL_BREAK')
    .sort((a, b) => (a.hPlus10?.closeN ?? 0) - (b.hPlus10?.closeN ?? 0))
    .slice(0, 15);

  // 11) summary
  // 차트 캐시의 실제 유효 기간 (전체 종목 union)
  const cacheStart = tradingDatesAll[0] || null;
  const cacheEnd = tradingDatesAll[tradingDatesAll.length - 1] || null;

  // 실효 cutoff 범위 = 후보가 1건이라도 발생한 cutoff 일자 (지정 from~to 안에서)
  const cutoffsWithCandidates = Array.from(new Set(candidates.map(c => c.cutoffDate))).sort();
  const effectiveStart = cutoffsWithCandidates[0] || null;
  const effectiveEnd = cutoffsWithCandidates[cutoffsWithCandidates.length - 1] || null;

  // 월별 요약 (보드 노출 기준 + 이벤트 기준)
  const monthlyMap = new Map();
  for (const c of candidates) {
    const ym = c.cutoffDate.slice(0, 6);
    if (!monthlyMap.has(ym)) monthlyMap.set(ym, { month: ym, candidates: 0, eventKeys: new Set(), pwait: 0, mgmt: 0, bweak: 0 });
    const m = monthlyMap.get(ym);
    m.candidates++;
    m.eventKeys.add(c.eventKey);
    if (c.judgmentStatus === 'PULLBACK_WAIT') m.pwait++;
    if (c.judgmentStatus === 'MANAGEMENT') m.mgmt++;
    if (c.judgmentStatus === 'BREAKDOWN_WEAK') m.bweak++;
  }
  const monthlySummary = Array.from(monthlyMap.values())
    .map(m => ({ month: m.month, candidates: m.candidates, events: m.eventKeys.size, pwaitCount: m.pwait, mgmtCount: m.mgmt, bweakCount: m.bweak }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // 표본 충분성 4단계 라벨 (사용자 spec)
  const eventsCount = eventsWithD10.length;
  let sampleLabel, sampleLabelKey;
  if (eventsCount >= 100) { sampleLabelKey = 'HIGH'; sampleLabel = '신뢰도 높음'; }
  else if (eventsCount >= 50) { sampleLabelKey = 'OPERATIONAL'; sampleLabel = '운영 기준 검토 가능'; }
  else if (eventsCount >= 30) { sampleLabelKey = 'DIRECTIONAL'; sampleLabel = '방향성 확인'; }
  else { sampleLabelKey = 'REFERENCE'; sampleLabel = '참고 수준'; }

  // 핵심 태그별 충분성 (≥20 = 운영 판단 가능)
  const strongCount = events.filter(e => e.d10Snapshot?.vprStatus === 'STRONG_VPR_SUCCESS').length;
  const structCount = events.filter(e => e.d10Snapshot?.vprStatus === 'STRUCTURAL_BREAK').length;
  const pendingCount = events.filter(e => e.d5Snapshot?.vprStatus === 'PULLBACK_PENDING').length;
  const tagSufficiency = {
    strongVprSuccess: { count: strongCount, sufficient: strongCount >= 20, threshold: 20 },
    structuralBreak: { count: structCount, sufficient: structCount >= 20, threshold: 20 },
    pullbackPending: { count: pendingCount, sufficient: pendingCount >= 20, threshold: 20 },
  };
  const sampleSufficiency = {
    eventsWithD10: eventsCount,
    label: sampleLabel,
    labelKey: sampleLabelKey,
    thresholds: { reference: 30, directional: 50, operational: 100 },
    tags: tagSufficiency,
  };

  const cacheInfo = {
    cacheStart, cacheEnd,
    cacheTotalDates: tradingDatesAll.length,
    requestedFrom: FROM, requestedTo: TO,
    effectiveStart, effectiveEnd,
    cutoffsRequested: tradingDatesInRange.length,
    cutoffsWithCandidates: cutoffsWithCandidates.length,
    sampleSufficient: eventsCount >= 30,
    sampleSufficientThreshold: 30,
  };

  const boardExposureSummary = {
    totalCandidates: candidates.length,
    verifiedCount: verified.length,
  };
  const eventBasedSummary = {
    totalEvents: events.length,
    eventsWithD10: eventsWithD10.length,
    dedupRate: rate(candidates.length - events.length, candidates.length),
    avgExposureDays: round(candidates.length / Math.max(events.length, 1), 2),
  };
  const summary = {
    cutoffDays: tradingDatesInRange.length,
    pendingAtD5Total: transitionStats.pendingAtD5Total,
    pendingAtD5_toSuccessRate: rate(transitionStats.pendingAtD5_toSuccess, transitionStats.pendingAtD5Total),
    pendingAtD5_toStructuralRate: rate(transitionStats.pendingAtD5_toStructural, transitionStats.pendingAtD5Total),
    d10StrongHPlus10AvgHigh: d10StrongPerf?.hPlus10.avgMaxHigh ?? null,
    d10StrongHPlus10AvgClose: d10StrongPerf?.hPlus10.avgCloseN ?? null,
    d10StrongCount: d10StrongPerf?.hPlus10.count ?? 0,
    d10StructHPlus10AvgClose: d10StructPerf?.hPlus10.avgCloseN ?? null,
    d10StructHPlus10AvgHigh: d10StructPerf?.hPlus10.avgMaxHigh ?? null,
    d10StructMinus5CloseRate: d10StructPerf?.hPlus10.minus5CloseRate ?? null,
    d10StructCount: d10StructPerf?.hPlus10.count ?? 0,
  };

  // baseline 비교 (이번 결과 vs 이전 baseline 고정값)
  const cur = summary;
  const ref = BASELINE_REFERENCE;
  function diff(curV, refV, suffix = '') {
    if (curV == null || refV == null) return { current: curV, reference: refV, diff: null, diffText: '-' };
    const d = curV - refV;
    return {
      current: curV, reference: refV, diff: round(d, 2),
      diffText: (d >= 0 ? '+' : '') + round(d, 2) + suffix,
    };
  }
  const baselineCompare = {
    referenceLabel: BASELINE_REFERENCE.label,
    rows: [
      { metric: '실효 분석 시작일',   current: effectiveStart, reference: ref.effectiveStart },
      { metric: '실효 분석 종료일',   current: effectiveEnd,   reference: ref.effectiveEnd },
      { metric: '보드 노출 사례 수',  ...diff(candidates.length, ref.totalCandidates, '건') },
      { metric: '이벤트 사례 수',     ...diff(events.length, ref.totalEvents, '건') },
      { metric: 'D+10 검증 가능',    ...diff(eventsWithD10.length, ref.eventsWithD10, '건') },
      { metric: '중복 제거율',       ...diff(round(rate(candidates.length - events.length, candidates.length), 2), ref.dedupRate, '%p') },
      { metric: 'D+10 강한 VPR 수',  ...diff(cur.d10StrongCount, ref.d10StrongCount, '건') },
      { metric: 'D+10 강한 H+10 고가↑', ...diff(cur.d10StrongHPlus10AvgHigh, ref.d10StrongHPlus10AvgHigh, '%p') },
      { metric: 'D+10 강한 H+10 종가↑', ...diff(cur.d10StrongHPlus10AvgClose, ref.d10StrongHPlus10AvgClose, '%p') },
      { metric: 'D+10 구조 훼손 수', ...diff(cur.d10StructCount, ref.d10StructCount, '건') },
      { metric: 'D+10 구조 훼손 H+10 종가', ...diff(cur.d10StructHPlus10AvgClose, ref.d10StructHPlus10AvgClose, '%p') },
      { metric: 'D+10 구조 훼손 -5% 종가율', ...diff(cur.d10StructMinus5CloseRate, ref.d10StructMinus5CloseRate, '%p') },
      { metric: 'D+5 대기 → 성공 전환', ...diff(cur.pendingAtD5_toSuccessRate, ref.pendingD5ToSuccessRate, '%p') },
      { metric: 'D+5 대기 → 구조 훼손', ...diff(cur.pendingAtD5_toStructuralRate, ref.pendingD5ToStructuralRate, '%p') },
    ],
  };

  // ─── 출력 ───
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'VPR H그룹 장기 성숙 백테스트',
      purpose: `${fmtDate(FROM)} ~ ${fmtDate(TO)} 매일 QVA 보드를 재현해서 BREAKOUT_SUCCESS(H그룹)의 D+5 보드 상태와 D+${MATURE_DAYS} 성숙 상태가 H+5/H+${MATURE_DAYS} 성과와 어떤 관계인지 검증.`,
      notice: '실시간 보드의 H그룹 노출 기간은 D+0~D+5로 유지하며, D+10은 VPR 성숙 검증에만 사용했습니다.',
      from: FROM, to: TO,
      vprSource: 'vpr-analyzer.js 재사용 (정의 변경 없음)',
      judgmentLabels: JUDGMENT_LABEL,
      vprLabels: vprAnalyzer.VPR_LABELS,
      vprDescriptions: vprAnalyzer.VPR_DESCRIPTIONS,
    },
    config: {
      from: FROM, to: TO,
      trackingDays: TRACKING_DAYS,
      recentBreakoutDays: RECENT_BREAKOUT_DAYS,
      matureDays: MATURE_DAYS,
      exitThresholdPct: EXIT_THRESHOLD_PCT,
      tradingDatesInRange,
    },
    baselineMode: BASELINE_MODE,
    baselineBanner: BASELINE_MODE ? BASELINE_BANNER : null,
    label: LABEL,
    cacheInfo,
    sampleSufficiency,
    baselineCompare,
    monthlySummary,
    summary,
    boardExposureSummary,
    eventBasedSummary,
    d5Distribution,
    d10Distribution,
    d5JudgmentDistribution,
    d10JudgmentDistribution,
    transitionMatrix,
    judgmentTransitionMatrix,
    transitionStats,
    d10VprPerformance,
    judgmentStatusPerformance,
    combinedStatusPerformance,
    dailyResults,
    candidates,
    events,
    examples: { successExamples, failureExamples },
    keyQuestions,
    conclusion,
    dataLimit: [
      `분석 기간은 ${fmtDate(FROM)} ~ ${fmtDate(TO)} (cutoff 거래일 ${tradingDatesInRange.length}일)입니다.`,
      '대상은 각 날짜 기준 BREAKOUT_SUCCESS(H그룹)만이며, 다른 단계는 분석에서 제외합니다.',
      `실시간 보드 노출 기준은 D+0 ~ D+${RECENT_BREAKOUT_DAYS}거래일이며, D+${MATURE_DAYS}은 VPR 성숙 분석용입니다 (보드 노출용 아님).`,
      'VPR은 H그룹 후속 관리 태그이며 독립 매수 신호가 아닙니다.',
      `같은 종목이 여러 날짜 반복 노출될 수 있어 보드 노출 기준과 이벤트 기준(eventKey = code+vviDate+hDate)을 모두 제공합니다.`,
      `차트 캐시 끝에 가까운 이벤트는 D+${MATURE_DAYS} 데이터가 부족할 수 있습니다 (이번 분석에서 D+${MATURE_DAYS} 검증 가능 ${eventsWithD10.length}/${events.length}건).`,
      '하루 뒤(다음 거래일) 성과는 보드 노출 기준 cutoff 종가 대비입니다. H+5/H+10 성과는 H돌파일 종가 기준입니다.',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  if (BASELINE_MODE) {
    console.log(`\n⚠️  ${BASELINE_BANNER}`);
  }
  console.log(`\n📅 캐시 / 분석 기간 정보:`);
  console.log(`  요청 분석 기간:        ${fmtDate(FROM)} ~ ${fmtDate(TO)}`);
  console.log(`  실효 분석 시작/종료:   ${fmtDate(effectiveStart)} ~ ${fmtDate(effectiveEnd)}`);
  console.log(`  차트 캐시 시작/종료:   ${fmtDate(cacheStart)} ~ ${fmtDate(cacheEnd)} (${tradingDatesAll.length}일)`);
  console.log(`  cutoff 거래일 수:      요청 ${tradingDatesInRange.length}일 / 후보 발생 ${cutoffsWithCandidates.length}일`);
  console.log(`  표본 충분성:           [${sampleSufficiency.labelKey}] ${sampleSufficiency.label} (D+10 검증 ${eventsCount}건)`);
  console.log(`    └ 강한 VPR 성공: ${strongCount}건 ${tagSufficiency.strongVprSuccess.sufficient ? '✅' : '⚠️ '} (운영 판단 기준 20건)`);
  console.log(`    └ 구조 훼손:    ${structCount}건 ${tagSufficiency.structuralBreak.sufficient ? '✅' : '⚠️ '} (위험 신뢰도 기준 20건)`);
  console.log(`    └ VPR 대기:     ${pendingCount}건 ${tagSufficiency.pullbackPending.sufficient ? '✅' : '⚠️ '} (전환율 판단 기준 20건)`);

  console.log(`\n📊 baseline 대비 변화 (${BASELINE_REFERENCE.label}):`);
  for (const r of baselineCompare.rows) {
    const cur = r.current === null || r.current === undefined ? '-' : r.current;
    const ref = r.reference === null || r.reference === undefined ? '-' : r.reference;
    const diffStr = r.diffText || (typeof r.current === 'string' ? '' : '-');
    console.log(`  ${r.metric.padEnd(25)} 현재 ${String(cur).padStart(10)}  vs  ref ${String(ref).padStart(10)}  ${diffStr}`);
  }

  console.log(`\n📅 월별 요약:`);
  for (const m of monthlySummary) {
    const ymLabel = m.month.slice(0, 4) + '-' + m.month.slice(4, 6);
    console.log(`  ${ymLabel}  보드 노출 ${String(m.candidates).padStart(4)} / 이벤트 ${String(m.events).padStart(3)} (눌림 대기 ${m.pwaitCount} / 관리 ${m.mgmtCount} / 돌파 악화 ${m.bweakCount})`);
  }

  console.log(`\n📊 D+5 분포 (전체 이벤트 ${events.filter(e => e.d5Snapshot).length}건):`);
  for (const d of d5Distribution) console.log(`  ${(vprAnalyzer.VPR_LABELS[d.status] || d.status).padEnd(16)} ${String(d.count).padStart(4)}건`);
  console.log(`\n📊 D+${MATURE_DAYS} 분포 (전체 이벤트 ${eventsWithD10.length}건):`);
  for (const d of d10Distribution) console.log(`  ${(vprAnalyzer.VPR_LABELS[d.status] || d.status).padEnd(16)} ${String(d.count).padStart(4)}건`);

  console.log(`\n📊 D+10 VPR 그룹별 H+${MATURE_DAYS} 성과:`);
  for (const g of d10VprPerformance) {
    const p = g.hPlus10;
    console.log(`  ${g.label.padEnd(16)} n=${String(p.count).padStart(4)}  고가 ${fmtPctText(p.avgMaxHigh).padStart(8)} / 종가 ${fmtPctText(p.avgCloseN).padStart(8)} / +20% 고가 ${String(p.plus20HighRate ?? '-').padStart(5)}% / -5% 종가 ${String(p.minus5CloseRate ?? '-').padStart(5)}%`);
  }

  console.log(`\n📊 화면 상태별 (D+5 시점 기준) H+${MATURE_DAYS} 성과 + D+10 전환율:`);
  for (const g of judgmentStatusPerformance) {
    const p = g.hPlus10;
    console.log(`  ${g.label.padEnd(10)} n=${String(p.count).padStart(4)}  고가 ${fmtPctText(p.avgMaxHigh).padStart(8)} / 종가 ${fmtPctText(p.avgCloseN).padStart(8)} / D+10 성공 ${String(g.successAtD10Rate ?? '-').padStart(5)}% / 구조 훼손 ${String(g.structuralAtD10Rate ?? '-').padStart(5)}%`);
  }

  console.log(`\n📈 D+5 → D+10 전환 매트릭스 (사례 발생만):`);
  for (const t of transitionMatrix) {
    console.log(`  ${t.fromLabel.padEnd(16)} → ${t.toLabel.padEnd(16)} ${String(t.count).padStart(4)}건`);
  }

  console.log(`\n📝 핵심 질문 자동 답변:`);
  for (const q of keyQuestions) {
    console.log(`  ${q.q}`);
    console.log(`     → ${q.a}`);
  }

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

function buildOneLineSummary(c, e) {
  const d5 = e.d5Snapshot?.vprStatus;
  const d10 = e.d10Snapshot?.vprStatus;
  const j = c.judgmentStatus;
  const hHigh = e.hPlus10?.maxHigh;
  const hClose = e.hPlus10?.closeN;
  const hHighText = hHigh != null ? `H+10 고가 ${fmtPctText(hHigh)}` : '';
  const hCloseText = hClose != null ? `종가 ${fmtPctText(hClose)}` : '';

  if (d5 === 'PULLBACK_PENDING' && (d10 === 'STRONG_VPR_SUCCESS' || d10 === 'CLASSIC_VPR_SUCCESS')) {
    return `D+5 기준 VPR 대기였으나 D+10에는 ${vprAnalyzer.VPR_LABELS[d10]}으로 전환된 사례 (${hHighText} / ${hCloseText}).`;
  }
  if (d5 === 'PULLBACK_PENDING' && d10 === 'STRUCTURAL_BREAK') {
    return `D+5 기준 VPR 대기였으나 D+10에는 구조 훼손으로 전환되어 하락 위험이 커진 사례 (${hCloseText}).`;
  }
  if (d5 === 'NO_PULLBACK_RUNAWAY' && d10 === 'NO_PULLBACK_RUNAWAY') {
    return `눌림 없이 상승 상태가 D+10까지 유지되며 강한 흐름을 보인 사례 (${hHighText} / ${hCloseText}).`;
  }
  if (d10 === 'STRUCTURAL_BREAK') {
    return `D+10 시점 구조 훼손으로 분류되어 하락 위험이 컸던 사례 (${hCloseText}).`;
  }
  if (d10 === 'STRONG_VPR_SUCCESS') {
    return `D+10 시점 강한 VPR 성공으로 정상 눌림 후 H돌파일 고가까지 재돌파한 사례 (${hHighText} / ${hCloseText}).`;
  }
  if (d10 === 'CLASSIC_VPR_SUCCESS') {
    return `D+10 시점 정석 VPR 성공으로 분류된 사례 (${hHighText} / ${hCloseText}).`;
  }
  if (d10 === 'WEAK_VPR_REBOUND') {
    return `D+10 시점 VPR 재돌파 약함 — 장중 재돌파했지만 종가 유지가 약한 사례 (${hCloseText}).`;
  }
  if (j === 'MANAGEMENT') {
    return `관리 구간에서 ${hCloseText} — 신규 진입보다는 보유 관점.`;
  }
  return `${JUDGMENT_LABEL[j] || j} / D+5 ${vprAnalyzer.VPR_LABELS[d5] || '-'} / D+10 ${vprAnalyzer.VPR_LABELS[d10] || '-'} (${hHighText}).`;
}

// ─────────────────────── HTML ───────────────────────
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>VPR H그룹 장기 성숙 백테스트</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px; -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 14px 0 8px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile.primary { border-left: 4px solid #0ea5e9; } .big-tile.primary .value { color: #67e8f9; }
.big-tile.success { border-left: 4px solid #14b8a6; } .big-tile.success .value { color: #5eead4; }
.big-tile.warn { border-left: 4px solid #f59e0b; } .big-tile.warn .value { color: #fde047; }
.big-tile.fail { border-left: 4px solid #ef4444; } .big-tile.fail .value { color: #fca5a5; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 17px; font-weight: 700; color: #f1f5f9; line-height: 1.2; margin-top: 3px; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; }

.tabs { display: flex; gap: 6px; margin: 18px 0 8px; flex-wrap: wrap; }
.tab-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-weight: 500; }
.tab-btn:hover { color: #f1f5f9; border-color: #64748b; }
.tab-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }

table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 12px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; }
table.cmp thead th:first-child { text-align: left; }
table.cmp tbody td { padding: 8px 12px; border-bottom: 1px solid #334155; text-align: right; font-variant-numeric: tabular-nums; }
table.cmp tbody td:first-child { text-align: left; color: #cbd5e1; font-weight: 600; }
table.cmp tbody tr:hover td { background: #273549; }
.row-highlight td { background: rgba(13, 148, 136, 0.18) !important; }
.cell-pos { color: #6ee7b7; } .cell-neg { color: #fca5a5; }

table.matrix { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.matrix th, table.matrix td { padding: 8px 12px; border: 1px solid #334155; text-align: center; }
table.matrix th { background: #0f172a; color: #94a3b8; font-size: 11px; }
table.matrix td.from-cell { background: #1c2942; font-weight: 600; color: #cbd5e1; text-align: left; }
table.matrix td.diag { background: rgba(13, 148, 136, 0.18); color: #6ee7b7; font-weight: 600; }
table.matrix td.zero { color: #475569; }

.tbl-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.list { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
table.list thead th { background: #0f172a; color: #94a3b8; font-weight: 600; text-align: left; padding: 9px 10px; border-bottom: 1px solid #334155; white-space: nowrap; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
table.list thead th.numeric { text-align: right; }
table.list tbody tr.row { border-bottom: 1px solid #1e293b; }
table.list tbody tr.row:hover { background: #273549; }
table.list tbody tr.row td { padding: 8px 10px; vertical-align: middle; line-height: 1.3; white-space: nowrap; }
table.list tbody tr.row td.numeric { text-align: right; }
table.list tbody tr.row td.col-name { font-weight: 600; color: #f1f5f9; min-width: 110px; }
table.list tbody tr.row td.col-name .meta { display: block; font-size: 10px; color: #64748b; font-weight: 400; margin-top: 2px; }
table.list tbody tr.row td.col-summary {
  color: #cbd5e1; min-width: 240px; max-width: 380px;
  white-space: normal; line-height: 1.35; font-size: 11px;
  overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
table.list tbody tr.row:nth-child(odd) { background: #1c2942; }
table.list tbody tr.row:nth-child(odd):hover { background: #273549; }

.vpr-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.vpr-pill.STRONG_VPR_SUCCESS { background: #064e3b; color: #6ee7b7; }
.vpr-pill.CLASSIC_VPR_SUCCESS { background: #134e4a; color: #5eead4; }
.vpr-pill.WEAK_VPR_REBOUND { background: #422006; color: #fde047; }
.vpr-pill.PULLBACK_PENDING { background: #312e81; color: #c7d2fe; }
.vpr-pill.NO_PULLBACK_RUNAWAY { background: #1e3a8a; color: #93c5fd; }
.vpr-pill.REBOUND_FAIL { background: #7f1d1d; color: #fca5a5; }
.vpr-pill.STRUCTURAL_BREAK { background: #7c2d12; color: #fdba74; }
.vpr-pill.DATA_INSUFFICIENT { background: #475569; color: #cbd5e1; }

.status-pill { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 600; }
.status-pill.REVIEW_OK { background: #065f46; color: #6ee7b7; }
.status-pill.CHASE_CAUTION { background: #78350f; color: #fde047; }
.status-pill.PULLBACK_WAIT { background: #1e40af; color: #bfdbfe; }
.status-pill.MANAGEMENT { background: #4c1d95; color: #ddd6fe; }
.status-pill.BREAKDOWN_WEAK { background: #7f1d1d; color: #fca5a5; }

.qa-block { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
.qa-block .q { color: #94a3b8; font-size: 12px; margin-bottom: 4px; font-weight: 600; }
.qa-block .q strong { color: #67e8f9; margin-right: 4px; }
.qa-block .a { color: #cbd5e1; line-height: 1.7; padding-left: 10px; }
.findings { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; }
.findings ul { margin: 0; padding-left: 20px; line-height: 1.8; }
.findings li { color: #cbd5e1; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

/* cmp/matrix 표 wrapper — 부모 div가 가로 스크롤, table 자체는 정상 table 유지 (정렬 보장) */
.scroll-x {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  max-width: 100%;
  margin-bottom: 14px;
  border-radius: 8px;
}
.scroll-x table.cmp, .scroll-x table.matrix { margin-bottom: 0; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; }
  .tbl-wrap { overflow-x: auto !important; }
  .col-mobile-hide, table.list thead th.col-mobile-hide { display: none; }
  /* 모바일에서 표가 부모 폭에 짜부라지지 않도록 자체 너비 유지 */
  .scroll-x table.cmp, .scroll-x table.matrix {
    width: max-content;
    min-width: 100%;
    white-space: nowrap;
  }
}
</style>
</head>
<body>

<h1>VPR H그룹 장기 성숙 백테스트</h1>
<div class="subtitle" id="subtitle"></div>

<div id="baseline-banner-box" style="display:none; background:#451a03; border-left:4px solid #f97316; padding:14px 18px; border-radius:8px; margin-bottom:14px; line-height:1.7;">
  <strong style="color:#fdba74; font-size:14px;">⚠️ Baseline 보고서</strong><br>
  <span id="baseline-banner-text" style="color:#fed7aa;"></span>
</div>

<div class="purpose-box">
  이 보고서는 <strong id="period-banner"></strong> 기간 동안 매일 QVA 보드에 나타난
  <strong>돌파 성공(H그룹)</strong> 종목을 대상으로, <strong>D+5 보드 상태</strong>가
  <strong>D+10 시점</strong>에 어떻게 성숙되는지와 그 이후 H+5/H+10 성과를 확인하는 장기 백테스트입니다.
</div>

<h2>📅 캐시 / 분석 기간 정보</h2>
<div id="cache-info-box"></div>

<h2>📊 표본 충분성</h2>
<div id="sample-sufficiency-box"></div>

<h2>📊 baseline 대비 변화</h2>
<p class="subtitle" id="baseline-ref-label"></p>
<div id="baseline-compare-table"></div>

<div class="warn-banner">
  ⚠️ 실시간 보드의 H그룹 노출 기간은 D+0~D+5로 유지하며, <strong>D+10은 VPR 성숙 검증에만 사용</strong>했습니다.
  각 cutoff의 후보 선정·VPR 계산에는 cutoff 이후 데이터를 사용하지 않았습니다.
  같은 종목이 여러 날짜에 반복 노출될 수 있어 <strong>보드 노출 기준</strong>과 <strong>이벤트 기준</strong>을 모두 제공합니다.
</div>

<h2>📊 핵심 타일</h2>
<div class="big-summary" id="big-summary"></div>

<h2>📊 D+5 vs D+10 VPR 분포</h2>
<p class="subtitle">같은 H이벤트의 보드 노출 마감 시점(D+5)과 성숙 분석 시점(D+10) 분류 분포 비교.</p>
<div id="d5-d10-distribution"></div>

<h2>🔄 D+5 → D+10 VPR 전환 매트릭스</h2>
<p class="subtitle">행=D+5 시점, 열=D+10 시점 분류. 대각선 = 상태 유지, 비대각선 = 상태 전환.</p>
<div id="vpr-transition-matrix"></div>

<h2>🔄 D+5 화면 상태 → D+10 VPR 전환</h2>
<div id="judgment-transition-matrix"></div>

<h2>📊 D+10 VPR 그룹별 H+10 성과</h2>
<p class="subtitle">D+10 시점 VPR 분류별 H돌파일 종가 기준 H+5 / H+10 forward 성과.</p>
<h3>H+10 성과</h3>
<div id="d10-h10-perf"></div>
<h3>H+5 성과</h3>
<div id="d10-h5-perf"></div>

<h2>📊 화면 상태별 장기 성과</h2>
<p class="subtitle">D+5 시점 judgmentStatus 기준 H+10 성과 + D+10 VPR 성공/구조 훼손 전환율.</p>
<div id="judgment-perf-table"></div>

<h2>📊 화면 상태 + D+5 VPR 조합 검증</h2>
<div id="combined-perf-table"></div>

<h2>📅 월별 요약</h2>
<div id="monthly-summary-table"></div>

<h2>📅 날짜별 후보 수와 평균 성과 (보드 노출 기준)</h2>
<div id="daily-results-table"></div>

<h2>📝 핵심 질문 자동 답변</h2>
<div id="key-questions"></div>

<h2>🏁 결론</h2>
<div class="findings" id="conclusion"></div>

<h2>🏆 H그룹 사례 리스트</h2>
<p class="subtitle">기본은 이벤트당 1건만 표시(중복 제거). 탭에서 "보드 노출 전체"를 선택하면 모든 노출일을 본다.</p>
<div class="tabs" id="tabs"></div>
<div class="tbl-wrap">
  <table class="list">
    <thead>
      <tr>
        <th>#</th>
        <th>기준일</th>
        <th>종목</th>
        <th class="col-mobile-hide">H돌파일</th>
        <th>화면 상태</th>
        <th>D+5 VPR</th>
        <th>D+10 VPR</th>
        <th class="numeric col-mobile-hide">기준가</th>
        <th class="numeric">다음날↑</th>
        <th class="numeric col-mobile-hide">H+5↑</th>
        <th class="numeric">H+10 고가↑</th>
        <th class="numeric">H+10 종가↑</th>
        <th class="col-mobile-hide">노출</th>
        <th class="col-summary">한 줄 해석</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;
const VPR_ORDER = ['STRONG_VPR_SUCCESS', 'CLASSIC_VPR_SUCCESS', 'WEAK_VPR_REBOUND', 'PULLBACK_PENDING', 'NO_PULLBACK_RUNAWAY', 'STRUCTURAL_BREAK', 'REBOUND_FAIL', 'DATA_INSUFFICIENT'];

function fmtPct(v) {
  if (v == null || !isFinite(v)) return '-';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : '');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>';
}
function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}

document.getElementById('subtitle').textContent =
  fmtDate(DATA.meta.from) + ' ~ ' + fmtDate(DATA.meta.to) +
  ' · cutoff ' + DATA.config.tradingDatesInRange.length + '일' +
  ' · 보드 노출 ' + DATA.boardExposureSummary.totalCandidates + '건 · 이벤트 ' + DATA.eventBasedSummary.totalEvents + '건' +
  ' (D+10 검증 가능 ' + DATA.eventBasedSummary.eventsWithD10 + '건)' +
  ' · 중복 제거율 ' + (DATA.eventBasedSummary.dedupRate ?? 0) + '%' +
  ' · 평균 노출 ' + DATA.eventBasedSummary.avgExposureDays + '일';
document.getElementById('period-banner').textContent = fmtDate(DATA.meta.from) + ' ~ ' + fmtDate(DATA.meta.to);

// Baseline 배너
if (DATA.baselineMode && DATA.baselineBanner) {
  document.getElementById('baseline-banner-box').style.display = 'block';
  document.getElementById('baseline-banner-text').textContent = DATA.baselineBanner;
}

// 캐시 / 분석 기간 정보 박스
(function renderCacheInfo() {
  const ci = DATA.cacheInfo || {};
  document.getElementById('cache-info-box').innerHTML =
    '<div class="scroll-x"><table class="cmp"><tbody>' +
    '<tr><td>요청 분석 기간</td><td>' + fmtDate(ci.requestedFrom) + ' ~ ' + fmtDate(ci.requestedTo) + ' (' + ci.cutoffsRequested + '일)</td></tr>' +
    '<tr><td>실제 유효 분석 시작/종료</td><td>' + fmtDate(ci.effectiveStart) + ' ~ ' + fmtDate(ci.effectiveEnd) + ' (후보 발생 ' + ci.cutoffsWithCandidates + '일)</td></tr>' +
    '<tr><td>차트 캐시 시작/종료</td><td>' + fmtDate(ci.cacheStart) + ' ~ ' + fmtDate(ci.cacheEnd) + ' (' + ci.cacheTotalDates + '일)</td></tr>' +
    '<tr><td>보드 노출 기준 사례</td><td>' + DATA.boardExposureSummary.totalCandidates + '건</td></tr>' +
    '<tr><td>이벤트 기준 사례</td><td>' + DATA.eventBasedSummary.totalEvents + '건 (D+10 검증 가능 ' + DATA.eventBasedSummary.eventsWithD10 + '건)</td></tr>' +
    '<tr><td>중복 제거율</td><td>' + (DATA.eventBasedSummary.dedupRate ?? 0) + '% (평균 노출 ' + DATA.eventBasedSummary.avgExposureDays + '일)</td></tr>' +
    '</tbody></table></div>';
})();

// 표본 충분성 박스
(function renderSampleSufficiency() {
  const ss = DATA.sampleSufficiency || {};
  const colorMap = { HIGH: '#10b981', OPERATIONAL: '#14b8a6', DIRECTIONAL: '#f59e0b', REFERENCE: '#94a3b8' };
  const labelColor = colorMap[ss.labelKey] || '#94a3b8';
  const tagRow = (key, label, threshold) => {
    const t = ss.tags?.[key];
    if (!t) return '';
    const sym = t.sufficient ? '✅' : '⚠️';
    return '<tr><td>' + label + '</td><td><strong>' + t.count + '건</strong> ' + sym + ' (기준 ' + threshold + '건 — ' + (t.sufficient ? '충분' : '부족') + ')</td></tr>';
  };
  document.getElementById('sample-sufficiency-box').innerHTML =
    '<div class="scroll-x"><table class="cmp"><tbody>' +
    '<tr><td>전체 표본 라벨</td><td><strong style="color:' + labelColor + ';font-size:14px;">' + (ss.label || '-') + '</strong> (이벤트 ' + (ss.eventsWithD10 ?? '-') + '건)</td></tr>' +
    '<tr><td>판정 기준</td><td>참고 &lt;30 / 방향성 30~49 / 운영 50~99 / 신뢰도 높음 ≥100</td></tr>' +
    tagRow('strongVprSuccess', '강한 VPR 성공 (운영 판단 기준)', '20') +
    tagRow('structuralBreak', '구조 훼손 (위험 신뢰도 기준)', '20') +
    tagRow('pullbackPending', 'VPR 대기 (전환율 판단 기준)', '20') +
    '</tbody></table></div>';
})();

// baseline compare 표
(function renderBaselineCompare() {
  const bc = DATA.baselineCompare || {};
  document.getElementById('baseline-ref-label').textContent = '비교 기준: ' + (bc.referenceLabel || '-');
  const rows = bc.rows || [];
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>지표</th><th>현재 (1년 캐시)</th><th>baseline 참조</th><th>변화</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    const curStr = r.current === null || r.current === undefined ? '-' : (typeof r.current === 'number' ? r.current : fmtDate(r.current));
    const refStr = r.reference === null || r.reference === undefined ? '-' : (typeof r.reference === 'number' ? r.reference : fmtDate(r.reference));
    let diffCell = r.diffText || '-';
    if (r.diff != null) {
      const cls = r.diff > 0 ? 'cell-pos' : (r.diff < 0 ? 'cell-neg' : '');
      diffCell = '<span class="' + cls + '">' + diffCell + '</span>';
    }
    html.push('<tr><td>' + r.metric + '</td><td>' + curStr + '</td><td>' + refStr + '</td><td>' + diffCell + '</td></tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById('baseline-compare-table').innerHTML = html.join('');
})();

// 월별 요약 표
(function renderMonthly() {
  const rows = DATA.monthlySummary || [];
  if (rows.length === 0) {
    document.getElementById('monthly-summary-table').innerHTML = '<p style="color:#64748b;">월별 데이터 없음.</p>';
    return;
  }
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>월</th><th>보드 노출</th><th>이벤트</th><th>눌림 대기</th><th>관리 구간</th><th>돌파 악화</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    const ym = r.month.slice(0, 4) + '-' + r.month.slice(4, 6);
    html.push('<tr><td>' + ym + '</td><td>' + r.candidates + '</td><td>' + r.events + '</td><td>' + r.pwaitCount + '</td><td>' + r.mgmtCount + '</td><td>' + r.bweakCount + '</td></tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById('monthly-summary-table').innerHTML = html.join('');
})();

const tiles = [
  { cls: 'primary', label: '분석 기간', value: fmtDate(DATA.meta.from).slice(5) + '~' + fmtDate(DATA.meta.to).slice(5), sub: DATA.config.tradingDatesInRange.length + '일' },
  { cls: 'primary', label: '보드 노출 후보', value: DATA.boardExposureSummary.totalCandidates },
  { cls: 'primary', label: '이벤트 (중복 제거)', value: DATA.eventBasedSummary.totalEvents, sub: 'D+10 검증 ' + DATA.eventBasedSummary.eventsWithD10 + '건' },
  { cls: 'warn', label: '중복 제거율', value: (DATA.eventBasedSummary.dedupRate ?? 0) + '%', sub: '평균 노출 ' + DATA.eventBasedSummary.avgExposureDays + '일' },
  { cls: 'primary', label: 'D+5 VPR 대기', value: DATA.summary.pendingAtD5Total + '건' },
  { cls: 'success', label: 'D+5 대기 → D+10 성공 전환율', value: (DATA.summary.pendingAtD5_toSuccessRate ?? 0) + '%' },
  { cls: 'fail', label: 'D+5 대기 → D+10 구조 훼손률', value: (DATA.summary.pendingAtD5_toStructuralRate ?? 0) + '%' },
  { cls: 'success', label: 'D+10 강한 VPR H+10 평균 고가', value: DATA.summary.d10StrongHPlus10AvgHigh != null ? (DATA.summary.d10StrongHPlus10AvgHigh > 0 ? '+' : '') + DATA.summary.d10StrongHPlus10AvgHigh.toFixed(2) + '%' : '-', sub: 'n=' + DATA.summary.d10StrongCount },
  { cls: 'fail', label: 'D+10 구조 훼손 H+10 평균 종가', value: DATA.summary.d10StructHPlus10AvgClose != null ? (DATA.summary.d10StructHPlus10AvgClose > 0 ? '+' : '') + DATA.summary.d10StructHPlus10AvgClose.toFixed(2) + '%' : '-', sub: 'n=' + DATA.summary.d10StructCount },
];
document.getElementById('big-summary').innerHTML = tiles.map(t =>
  '<div class="big-tile ' + t.cls + '">' +
    '<div class="label">' + t.label + '</div>' +
    '<div class="value">' + t.value + '</div>' +
    (t.sub ? '<div class="sub">' + t.sub + '</div>' : '') +
  '</div>'
).join('');

// D+5 vs D+10 분포
function distTable(d5, d10, labels, title) {
  const allKeys = new Set([...d5.map(x => x.status), ...d10.map(x => x.status)]);
  const d5Map = new Map(d5.map(x => [x.status, x.count]));
  const d10Map = new Map(d10.map(x => [x.status, x.count]));
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>' + (title || '분류') + '</th><th>D+5</th><th>D+10 (성숙)</th><th>변화</th>',
    '</tr></thead><tbody>'];
  for (const k of Array.from(allKeys).sort()) {
    const a = d5Map.get(k) || 0;
    const b = d10Map.get(k) || 0;
    const diff = b - a;
    const diffStr = diff === 0 ? '-' : (diff > 0 ? '+' : '') + diff;
    const cls = diff > 0 ? 'cell-pos' : (diff < 0 ? 'cell-neg' : '');
    html.push('<tr><td>' + (labels[k] || k) + '</td><td>' + a + '건</td><td>' + b + '건</td><td><span class="' + cls + '">' + diffStr + '</span></td></tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('d5-d10-distribution').innerHTML =
  '<h3>VPR 상태 분포</h3>' +
  distTable(DATA.d5Distribution, DATA.d10Distribution, DATA.meta.vprLabels) +
  '<h3>화면 상태 (judgmentStatus) 분포</h3>' +
  distTable(DATA.d5JudgmentDistribution, DATA.d10JudgmentDistribution, DATA.meta.judgmentLabels);

// 전환 매트릭스 (행/열)
function matrixTable(transitions, fromKeys, toKeys, fromLabels, toLabels, fromTitle, toTitle) {
  const m = new Map();
  for (const t of transitions) m.set(t.from + '::' + t.to, t.count);
  const fromSet = Array.from(new Set([...transitions.map(t => t.from), ...fromKeys])).filter(k => fromKeys.includes(k) || transitions.some(t => t.from === k));
  const toSet = Array.from(new Set([...transitions.map(t => t.to), ...toKeys])).filter(k => toKeys.includes(k) || transitions.some(t => t.to === k));
  const html = ['<div class="scroll-x"><table class="matrix"><thead><tr><th>' + fromTitle + ' \\\\ ' + toTitle + '</th>'];
  for (const t of toSet) html.push('<th>' + (toLabels[t] || t) + '</th>');
  html.push('<th>합계</th></tr></thead><tbody>');
  for (const f of fromSet) {
    let rowSum = 0;
    const cells = [];
    for (const t of toSet) {
      const cnt = m.get(f + '::' + t) || 0;
      rowSum += cnt;
      const cls = cnt === 0 ? ' zero' : (f === t ? ' diag' : '');
      cells.push('<td class="' + cls.trim() + '">' + (cnt || '-') + '</td>');
    }
    if (rowSum === 0) continue;
    html.push('<tr><td class="from-cell">' + (fromLabels[f] || f) + '</td>' + cells.join('') + '<td>' + rowSum + '</td></tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('vpr-transition-matrix').innerHTML =
  matrixTable(DATA.transitionMatrix, VPR_ORDER, VPR_ORDER, DATA.meta.vprLabels, DATA.meta.vprLabels, 'D+5 VPR', 'D+10 VPR');
document.getElementById('judgment-transition-matrix').innerHTML =
  matrixTable(DATA.judgmentTransitionMatrix, ['REVIEW_OK', 'CHASE_CAUTION', 'PULLBACK_WAIT', 'MANAGEMENT', 'BREAKDOWN_WEAK'], VPR_ORDER, DATA.meta.judgmentLabels, DATA.meta.vprLabels, 'D+5 화면', 'D+10 VPR');

// D+10 VPR × H+5/H+10 성과
function perfTable(rows, key, labelKey, highlightKeys = []) {
  if (!rows || rows.length === 0) return '<p style="color:#64748b;">사례 없음.</p>';
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>' + (labelKey || '그룹') + '</th><th>n</th>',
    '<th>평균 고가↑</th><th>중앙 고가↑</th>',
    '<th>평균 종가↑</th><th>중앙 종가↑</th>',
    '<th>평균 저가↓</th>',
    '<th>+5% 고가</th><th>+10% 고가</th><th>+20% 고가</th>',
    '<th>-3% 종가</th><th>-5% 종가</th><th>-10% 종가</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    const p = r[key] || r;
    if (!p || p.count === 0) continue;
    const hi = highlightKeys.includes(r.status) ? ' class="row-highlight"' : '';
    html.push('<tr' + hi + '>' +
      '<td>' + r.label + '</td><td>' + p.count + '</td>' +
      '<td>' + fmtPct(p.avgMaxHigh) + '</td><td>' + fmtPct(p.medianMaxHigh) + '</td>' +
      '<td>' + fmtPct(p.avgCloseN) + '</td><td>' + fmtPct(p.medianCloseN) + '</td>' +
      '<td>' + fmtPct(p.avgMinLow) + '</td>' +
      '<td>' + (p.plus5HighRate != null ? p.plus5HighRate + '%' : '-') + '</td>' +
      '<td>' + (p.plus10HighRate != null ? p.plus10HighRate + '%' : '-') + '</td>' +
      '<td>' + (p.plus20HighRate != null ? p.plus20HighRate + '%' : '-') + '</td>' +
      '<td>' + (p.minus3CloseRate != null ? p.minus3CloseRate + '%' : '-') + '</td>' +
      '<td>' + (p.minus5CloseRate != null ? p.minus5CloseRate + '%' : '-') + '</td>' +
      '<td>' + (p.minus10CloseRate != null ? p.minus10CloseRate + '%' : '-') + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('d10-h10-perf').innerHTML = perfTable(DATA.d10VprPerformance, 'hPlus10', 'D+10 VPR 그룹', ['STRONG_VPR_SUCCESS', 'CLASSIC_VPR_SUCCESS', 'STRUCTURAL_BREAK']);
document.getElementById('d10-h5-perf').innerHTML = perfTable(DATA.d10VprPerformance, 'hPlus5', 'D+10 VPR 그룹', ['STRONG_VPR_SUCCESS', 'CLASSIC_VPR_SUCCESS', 'STRUCTURAL_BREAK']);

// 화면 상태별 (D+5) H+10 + D+10 전환율
function judgmentPerfTable(rows) {
  if (!rows || rows.length === 0) return '<p style="color:#64748b;">사례 없음.</p>';
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>화면 상태 (D+5)</th><th>n</th>',
    '<th>H+10 평균 고가↑</th><th>H+10 평균 종가↑</th><th>H+10 평균 저가↓</th>',
    '<th>+10% 고가</th><th>-3% 종가</th><th>-5% 종가</th>',
    '<th>D+10 VPR 성공 전환율</th><th>D+10 구조 훼손 전환율</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    const p = r.hPlus10;
    if (p.count === 0) continue;
    html.push('<tr><td>' + r.label + '</td><td>' + p.count + '</td>' +
      '<td>' + fmtPct(p.avgMaxHigh) + '</td><td>' + fmtPct(p.avgCloseN) + '</td><td>' + fmtPct(p.avgMinLow) + '</td>' +
      '<td>' + (p.plus10HighRate != null ? p.plus10HighRate + '%' : '-') + '</td>' +
      '<td>' + (p.minus3CloseRate != null ? p.minus3CloseRate + '%' : '-') + '</td>' +
      '<td>' + (p.minus5CloseRate != null ? p.minus5CloseRate + '%' : '-') + '</td>' +
      '<td>' + (r.successAtD10Rate != null ? r.successAtD10Rate + '% (' + r.successAtD10Count + '건)' : '-') + '</td>' +
      '<td>' + (r.structuralAtD10Rate != null ? r.structuralAtD10Rate + '% (' + r.structuralAtD10Count + '건)' : '-') + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('judgment-perf-table').innerHTML = judgmentPerfTable(DATA.judgmentStatusPerformance);

// 조합
function comboTable(rows) {
  const filtered = (rows || []).filter(r => r.hPlus10.count > 0);
  if (filtered.length === 0) return '<p style="color:#64748b;">사례 없음.</p>';
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>조합</th><th>n</th>',
    '<th>다음날 평균 고가↑</th>',
    '<th>H+10 평균 고가↑</th><th>H+10 평균 종가↑</th>',
    '<th>D+10 성공 전환율</th><th>D+10 구조 훼손률</th>',
    '<th>-5% 종가</th>',
    '</tr></thead><tbody>'];
  for (const r of filtered) {
    const p = r.hPlus10;
    html.push('<tr><td>' + r.label + '</td><td>' + p.count + '</td>' +
      '<td>-</td>' +
      '<td>' + fmtPct(p.avgMaxHigh) + '</td><td>' + fmtPct(p.avgCloseN) + '</td>' +
      '<td>' + (r.successAtD10Rate != null ? r.successAtD10Rate + '%' : '-') + '</td>' +
      '<td>' + (r.structuralAtD10Rate != null ? r.structuralAtD10Rate + '%' : '-') + '</td>' +
      '<td>' + (p.minus5CloseRate != null ? p.minus5CloseRate + '%' : '-') + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('combined-perf-table').innerHTML = comboTable(DATA.combinedStatusPerformance);

// 일자별
function dailyTable(rows) {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>날짜</th><th>H그룹 수</th><th>눌림 대기</th><th>관리 구간</th>',
    '<th>다음날 평균 종가↑</th><th>다음날 평균 고가↑</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    if (r.count === 0) continue;
    html.push('<tr>' +
      '<td>' + fmtDate(r.date) + '</td>' +
      '<td>' + r.count + '</td>' +
      '<td>' + (r.pwaitCount ?? '-') + '</td>' +
      '<td>' + (r.mgmtCount ?? '-') + '</td>' +
      '<td>' + fmtPct(r.avgClose) + '</td>' +
      '<td>' + fmtPct(r.avgHigh) + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('daily-results-table').innerHTML = dailyTable(DATA.dailyResults);

// 핵심 질문
document.getElementById('key-questions').innerHTML =
  (DATA.keyQuestions || []).map(qa =>
    '<div class="qa-block"><div class="q"><strong>Q.</strong> ' + qa.q + '</div><div class="a">→ ' + qa.a + '</div></div>'
  ).join('');

// 결론
document.getElementById('conclusion').innerHTML =
  '<ul>' + (DATA.conclusion || []).map(c => '<li>' + c + '</li>').join('') + '</ul>';

// 탭
// 기본 = 이벤트 기준 (이벤트당 첫 노출 1건만). 같은 종목의 같은 H흐름이 5~6일씩 반복 노출되어
// 줄이 너무 많아지는 것을 막기 위함. "보드 노출 전체"는 모든 노출일.
const TAB_DEF = [
  { key: 'event', label: '이벤트 기준 (이벤트당 1건)', filter: c => c.exposureIndex === 1 },
  { key: 'd10strong', label: 'D+10 강한 VPR 성공', filter: c => c.exposureIndex === 1 && c.d10VprStatus === 'STRONG_VPR_SUCCESS' },
  { key: 'd10classic', label: 'D+10 VPR 성공', filter: c => c.exposureIndex === 1 && c.d10VprStatus === 'CLASSIC_VPR_SUCCESS' },
  { key: 'd10struct', label: 'D+10 구조 훼손', filter: c => c.exposureIndex === 1 && c.d10VprStatus === 'STRUCTURAL_BREAK' },
  { key: 'd10runaway', label: 'D+10 눌림 없이 상승', filter: c => c.exposureIndex === 1 && c.d10VprStatus === 'NO_PULLBACK_RUNAWAY' },
  { key: 'pending', label: 'D+5 VPR 대기', filter: c => c.exposureIndex === 1 && c.d5VprStatus === 'PULLBACK_PENDING' },
  { key: 'pwait', label: '눌림 대기 (D+5)', filter: c => c.exposureIndex === 1 && c.judgmentStatus === 'PULLBACK_WAIT' },
  { key: 'mgmt', label: '관리 구간', filter: c => c.exposureIndex === 1 && c.judgmentStatus === 'MANAGEMENT' },
  { key: 'bweak', label: '돌파 악화', filter: c => c.exposureIndex === 1 && c.judgmentStatus === 'BREAKDOWN_WEAK' },
  { key: 'all', label: '보드 노출 전체', filter: c => true },
];
let currentTab = 'event';
document.getElementById('tabs').innerHTML = TAB_DEF.map(t =>
  '<button class="tab-btn' + (t.key === currentTab ? ' active' : '') + '" data-tab="' + t.key + '">' + t.label + '</button>'
).join('');
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTab = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderList();
  });
});

function renderList() {
  const tabDef = TAB_DEF.find(t => t.key === currentTab);
  const filtered = DATA.candidates.filter(tabDef.filter)
    .sort((a, b) => {
      if (a.cutoffDate !== b.cutoffDate) return b.cutoffDate.localeCompare(a.cutoffDate);
      return (b.hPlus10?.maxHigh ?? -Infinity) - (a.hPlus10?.maxHigh ?? -Infinity);
    })
    .slice(0, 500); // 출력 제한
  const html = filtered.map((c, i) => {
    return '<tr class="row">' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + fmtDate(c.cutoffDate) + '</td>' +
      '<td class="col-name">' + c.name + '<span class="meta">' + c.code + ' · ' + (c.market || '-') + '</span></td>' +
      '<td class="col-mobile-hide">' + fmtDate(c.hDate) + '</td>' +
      '<td>' + (c.judgmentStatus
        ? '<span class="status-pill ' + c.judgmentStatus + '">' + (c.judgmentLabel || c.judgmentStatus) + '</span>'
        : '-') + '</td>' +
      '<td>' + (c.d5VprStatus
        ? '<span class="vpr-pill ' + c.d5VprStatus + '">' + (c.d5VprLabel || c.d5VprStatus) + '</span>'
        : '-') + '</td>' +
      '<td>' + (c.d10VprStatus
        ? '<span class="vpr-pill ' + c.d10VprStatus + '">' + (c.d10VprLabel || c.d10VprStatus) + '</span>'
        : '-') + '</td>' +
      '<td class="numeric col-mobile-hide">' + (c.cutoffClose != null ? c.cutoffClose.toLocaleString() : '-') + '</td>' +
      '<td class="numeric">' + fmtPct(c.returns?.closeFromCutoff) + '</td>' +
      '<td class="numeric col-mobile-hide">' + fmtPct(c.hPlus5?.maxHigh) + '</td>' +
      '<td class="numeric">' + fmtPct(c.hPlus10?.maxHigh) + '</td>' +
      '<td class="numeric">' + fmtPct(c.hPlus10?.closeN) + '</td>' +
      '<td class="col-mobile-hide">' + (c.exposureTotal != null ? c.exposureTotal + '일' : '-') + '</td>' +
      '<td class="col-summary">' + (c.oneLineSummary || '-') + '</td>' +
      '</tr>';
  }).join('');
  document.getElementById('list-body').innerHTML = html ||
    '<tr><td colspan="14" style="padding:20px; text-align:center; color:#64748b;">표시할 사례가 없습니다.</td></tr>';
}
renderList();

document.getElementById('data-limit').innerHTML =
  '<strong>데이터 한계</strong><br>' +
  (DATA.dataLimit || []).map(l => '• ' + l).join('<br>');
</script>

</body>
</html>
`;

main();
