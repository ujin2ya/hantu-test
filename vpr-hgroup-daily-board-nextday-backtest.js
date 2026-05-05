#!/usr/bin/env node
/**
 * VPR H그룹 일별 보드 다음날 백테스트
 *
 * 목적:
 *   2026-04-01 ~ 2026-04-30 매일 QVA 보드를 재현해서, 그날 BREAKOUT_SUCCESS(H그룹)으로
 *   잡힌 종목들의 화면 상태/VPR 후속 태그가 다음 거래일 성과를 잘 구분했는지 검증한다.
 *
 *   - QVA/VVI/H그룹 정의 변경하지 않음 (qva-watchlist-board.js 검출 로직 동일)
 *   - VPR 정의 변경하지 않음 (vpr-analyzer.js 재사용)
 *   - 각 cutoff의 후보 선정·VPR 계산은 cutoff까지의 데이터만 사용
 *   - target(다음 거래일) 데이터는 결과 검증에만 사용
 *
 * 출력:
 *   reports/vpr-hgroup-daily-board-nextday-backtest-result.json
 *   reports/vpr-hgroup-daily-board-nextday-backtest-result.html
 *
 * 라우트: /vpr-hgroup-daily-backtest
 *
 * 실행:
 *   node vpr-hgroup-daily-board-nextday-backtest.js --from=20260401 --to=20260430
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
const FROM = String(args.from || '20260401').trim();
const TO = String(args.to || '20260430').trim();

const OUT_JSON = path.join(REPORTS_DIR, 'vpr-hgroup-daily-board-nextday-backtest-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'vpr-hgroup-daily-board-nextday-backtest-result.html');

const TRACKING_DAYS = 20;
// 보드 노출 기준 = 라이브 보드와 동일한 5일 (RECENT_BREAKOUT_DAYS).
// 같은 H이벤트의 D+5 시점 분류와 D+10 시점 성숙 분류를 별도로 계산해서 비교한다.
const RECENT_BREAKOUT_DAYS = 5;
const MATURE_LOOKAHEAD_DAYS = 10;       // 성숙 분석 윈도우 (vpr-analyzer 기본과 동일)
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

// ─────────── 한 후보의 BREAKOUT_SUCCESS 여부를 cutoff 기준으로 판정 ───────────
// 반환: BREAKOUT_SUCCESS면 { qvaIdx, vviIdx, breakoutIdx, vviRow, breakoutRow }, 아니면 null
function detectBreakoutSuccessAt(rows, flowRows, cutoffIdx, namedMeta) {
  if (cutoffIdx < 60) return null;

  // QVA 가장 최근 (보드와 동일: break 즉시 채택)
  let qvaIdx = null;
  for (let k = 0; k <= TRACKING_DAYS && cutoffIdx - k >= 60; k++) {
    if (checkQVASignalAtIdx(rows, cutoffIdx - k)) {
      qvaIdx = cutoffIdx - k;
      break;
    }
  }
  if (qvaIdx == null) return null;

  const daysSinceQva = cutoffIdx - qvaIdx;
  const signalPrice = rows[qvaIdx].close;

  // 이탈 (-15% 이상) 검사
  for (let k = 1; k <= daysSinceQva; k++) {
    const r = rows[qvaIdx + k];
    if (r.close > 0 && r.close <= signalPrice * (1 + EXIT_THRESHOLD_PCT / 100)) return null;
  }

  // VVI 첫 발화
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

  // 최근 RECENT_BREAKOUT_DAYS 내인지 (보드 노출 정의 그대로)
  if (cutoffIdx - breakoutIdx > RECENT_BREAKOUT_DAYS) return null;

  return { qvaIdx, vviIdx, breakoutIdx, vviRow, breakoutRow, signalPrice };
}

// ─────────── D+N 체크포인트 스냅샷 (성숙 분석용) ───────────
// 같은 H이벤트를 D+N 거래일 시점에서 cutoff을 잡았을 때의 VPR / judgmentStatus.
// 추적 윈도우는 vpr-analyzer 기본 (10일).
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
    vpr: vpr,
  };
}

// H돌파일 종가 기준 1~N거래일 forward 성과
function computeHForward(rows, breakoutIdx, N) {
  const hClose = rows[breakoutIdx].close;
  let maxHigh = null;
  let minLow = null;
  let closeN = null;
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

  console.log(`\n📊 VPR H그룹 일별 보드 다음날 백테스트 (${FROM} ~ ${TO})`);
  console.log(`  종목 수: ${files.length}`);

  // 1) 글로벌 거래일 수집 (캐시 union)
  const allDates = new Set();
  const chartCache = new Map(); // code -> { rows, name, flowRows }

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

  // 2) [FROM, TO] 사이의 거래일 (글로벌)
  const tradingDatesAll = Array.from(allDates).sort();
  const tradingDatesInRange = tradingDatesAll.filter(d => d >= FROM && d <= TO);
  const nextTradingMap = new Map(); // cutoff -> next trading date
  for (let i = 0; i < tradingDatesAll.length - 1; i++) {
    nextTradingMap.set(tradingDatesAll[i], tradingDatesAll[i + 1]);
  }
  console.log(`  분석 cutoff 일자: ${tradingDatesInRange.length}일 (${tradingDatesInRange.map(fmtDate).join(', ')})`);

  // 3) 각 종목 × 각 cutoff에 대해 BREAKOUT_SUCCESS 검출
  const candidates = [];
  let processed = 0;
  const t0 = Date.now();
  for (const [code, { rows, flowRows, meta, name }] of chartCache) {
    processed++;
    if (processed % 300 === 0) {
      process.stdout.write(`  검출 ${processed}/${chartCache.size} (cand ${candidates.length})\r`);
    }
    const namedMeta = { ...meta, name: name || meta.name };
    // cutoff 별로 entry 위치를 찾는다 (성능: 한 번 인덱싱 대신 each cutoff lookup OK)
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

      // VPR — cutoff까지의 rows만 사용
      const truncatedRows = rows.slice(0, cutoffIdx + 1);
      const vpr = vprAnalyzer.analyzeVPR({
        entryIdx: breakoutIdx,
        vviHigh: vviRow.high,
        vviClose: vviRow.close,
        vviLow: vviRow.low,
        qvaSignalPrice: signalPrice,
        entryPrice,
      }, truncatedRows);
      const vprStatus = vpr?.result?.vprStatus || 'DATA_INSUFFICIENT';
      const vprLabel = vpr?.result?.vprLabel || vprAnalyzer.VPR_LABELS.DATA_INSUFFICIENT;
      const vprConflictNote = vprAnalyzer.buildConflictNote(judgmentStatus, vpr);

      // 다음 거래일 (글로벌 기준)
      const nextDate = nextTradingMap.get(cutoff);
      let targetRow = null;
      let returns = null;
      if (nextDate) {
        const tIdx = rows.findIndex(r => r.date === nextDate);
        if (tIdx > cutoffIdx) {
          targetRow = rows[tIdx];
          const t = targetRow;
          returns = {
            closeFromCutoff: round((t.close / c - 1) * 100),
            highFromCutoff: round((t.high / c - 1) * 100),
            lowFromCutoff: round((t.low / c - 1) * 100),
            closeFromEntry: round((t.close / entryPrice - 1) * 100),
            highFromEntry: round((t.high / entryPrice - 1) * 100),
            lowFromEntry: round((t.low / entryPrice - 1) * 100),
          };
        }
      }

      const eventKey = `${code}|${vviRow.date}|${breakoutRow.date}`;
      candidates.push({
        cutoffDate: cutoff,
        targetDate: nextDate || null,
        code,
        name: meta.name,
        market: meta.market,
        qvaDate: rows[qvaIdx].date,
        vviDate: vviRow.date,
        hDate: breakoutRow.date,
        eventKey,
        mainStage: 'BREAKOUT_SUCCESS',
        judgmentStatus,
        judgmentLabel: JUDGMENT_LABEL[judgmentStatus],
        vprStatus,
        vprLabel,
        vprConflictNote,
        cutoffClose: c,
        entryPrice: round(entryPrice),
        vviHigh: vviRow.high,
        daysFromBreakout,
        targetOpen: targetRow?.open ?? null,
        targetHigh: targetRow?.high ?? null,
        targetLow: targetRow?.low ?? null,
        targetClose: targetRow?.close ?? null,
        returns,
        oneLineSummary: buildOneLineSummary(judgmentStatus, vprStatus, returns),
      });
    }
  }
  process.stdout.write(`  검출 ${chartCache.size}/${chartCache.size}            \n`);
  console.log(`  보드 노출 후보: ${candidates.length}건 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 4) eventKey 별 그룹핑 (이벤트 기준)
  const eventMap = new Map();
  // candidates는 (stock, cutoff) 순서 — eventKey 별로 시간 순서로 모이게 하려면 cutoffDate로 정렬 필요
  const sortedCands = [...candidates].sort((a, b) => a.cutoffDate.localeCompare(b.cutoffDate));
  for (const c of sortedCands) {
    if (!eventMap.has(c.eventKey)) {
      eventMap.set(c.eventKey, {
        eventKey: c.eventKey,
        code: c.code,
        name: c.name,
        market: c.market,
        qvaDates: new Set(),
        vviDate: c.vviDate,
        hDate: c.hDate,
        firstSeenDate: c.cutoffDate,
        lastSeenDate: c.cutoffDate,
        seenCount: 0,
        vprStatusTimeline: [],
        judgmentStatusTimeline: [],
        firstNextDayResult: null,
        lastNextDayResult: null,
      });
    }
    const e = eventMap.get(c.eventKey);
    e.qvaDates.add(c.qvaDate);
    e.lastSeenDate = c.cutoffDate;
    e.seenCount++;
    e.vprStatusTimeline.push({ date: c.cutoffDate, status: c.vprStatus });
    e.judgmentStatusTimeline.push({ date: c.cutoffDate, status: c.judgmentStatus });
    if (e.seenCount === 1) e.firstNextDayResult = c.returns;
    e.lastNextDayResult = c.returns;
  }
  // exposureIndex 부여 (각 eventKey 안에서 등장 순서)
  const eventCounter = new Map();
  for (const c of candidates) {
    const k = c.eventKey;
    eventCounter.set(k, (eventCounter.get(k) || 0) + 1);
    c.exposureIndex = eventCounter.get(k);
  }
  // 이벤트 객체 정리: bestVprStatus / worstVprStatus
  const VPR_RANK = {
    STRONG_VPR_SUCCESS: 0, CLASSIC_VPR_SUCCESS: 1, PULLBACK_PENDING: 2,
    NO_PULLBACK_RUNAWAY: 3, WEAK_VPR_REBOUND: 4, REBOUND_FAIL: 5,
    STRUCTURAL_BREAK: 6, DATA_INSUFFICIENT: 9,
  };
  const events = [];
  for (const e of eventMap.values()) {
    let best = null, worst = null;
    for (const t of e.vprStatusTimeline) {
      if (best == null || (VPR_RANK[t.status] ?? 99) < (VPR_RANK[best] ?? 99)) best = t.status;
      if (worst == null || (VPR_RANK[t.status] ?? 99) > (VPR_RANK[worst] ?? 99)) worst = t.status;
    }
    events.push({
      ...e,
      qvaDates: Array.from(e.qvaDates),
      bestVprStatus: best,
      worstVprStatus: worst,
    });
  }
  console.log(`  이벤트 기준: ${events.length}건 (중복 제거율 ${rate(candidates.length - events.length, candidates.length)}%)`);

  // 4-1) 각 이벤트별 D+5 / D+10 체크포인트 + H+10 forward 성과 (성숙 분석용)
  for (const e of events) {
    const cache = chartCache.get(e.code);
    if (!cache) continue;
    const { rows } = cache;
    const breakoutIdx = rows.findIndex(r => r.date === e.hDate);
    const vviIdx = rows.findIndex(r => r.date === e.vviDate);
    if (breakoutIdx < 0 || vviIdx < 0) continue;
    const vviRow = rows[vviIdx];
    // signalPrice = 첫 QVA일 종가
    const firstQvaDate = e.qvaDates.slice().sort()[0];
    const qvaIdx = rows.findIndex(r => r.date === firstQvaDate);
    const signalPrice = qvaIdx >= 0 ? rows[qvaIdx].close : null;

    e.d5Snapshot = checkpointSnapshot(rows, breakoutIdx, vviRow, signalPrice, RECENT_BREAKOUT_DAYS);
    e.d10Snapshot = checkpointSnapshot(rows, breakoutIdx, vviRow, signalPrice, MATURE_LOOKAHEAD_DAYS);
    e.h10Forward = computeHForward(rows, breakoutIdx, MATURE_LOOKAHEAD_DAYS);
    // VPR detail (D+10 기준 — H+10 성과 함께 보여주기 위해)
    if (e.d10Snapshot?.vpr?.pullback) {
      e.d10Pullback = {
        type: e.d10Snapshot.vpr.pullback.pullbackType,
        closeDD: e.d10Snapshot.vpr.pullback.closeDrawdownFromEntryPct,
        lowDD: e.d10Snapshot.vpr.pullback.lowDrawdownFromEntryPct,
      };
    }
    if (e.d10Snapshot?.vpr?.rebound) {
      e.d10Rebound = {
        hasRebound: e.d10Snapshot.vpr.rebound.hasVprRebound,
        daysToRebound: e.d10Snapshot.vpr.rebound.daysToRebound,
        closeHeld: e.d10Snapshot.vpr.rebound.closeHeldAboveReboundLevel,
      };
    }
    // VPR 객체 자체는 출력에서 빼서 JSON 가볍게 유지
    if (e.d5Snapshot) delete e.d5Snapshot.vpr;
    if (e.d10Snapshot) delete e.d10Snapshot.vpr;
  }

  // 4-2) D+5 / D+10 분포 + 전환 매트릭스
  const eventsWithBoth = events.filter(e => e.d5Snapshot && e.d10Snapshot);
  const eventsWithD10 = events.filter(e => e.d10Snapshot);
  function distOf(arr, key, sub) {
    const m = new Map();
    for (const e of arr) {
      const v = e[key]?.[sub];
      if (!v) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    return Array.from(m.entries()).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);
  }
  const d5VprDistribution = distOf(events.filter(e => e.d5Snapshot), 'd5Snapshot', 'vprStatus');
  const d10VprDistribution = distOf(eventsWithD10, 'd10Snapshot', 'vprStatus');
  const d5JudgmentDistribution = distOf(events.filter(e => e.d5Snapshot), 'd5Snapshot', 'judgmentStatus');
  const d10JudgmentDistribution = distOf(eventsWithD10, 'd10Snapshot', 'judgmentStatus');

  // 전환 매트릭스: D+5 VPR → D+10 VPR
  const transitionVpr = new Map(); // key = `${d5}::${d10}`, value = count
  for (const e of eventsWithBoth) {
    const k = `${e.d5Snapshot.vprStatus}::${e.d10Snapshot.vprStatus}`;
    transitionVpr.set(k, (transitionVpr.get(k) || 0) + 1);
  }
  const d5ToD10VprTransition = Array.from(transitionVpr.entries()).map(([k, count]) => {
    const [from, to] = k.split('::');
    return { from, fromLabel: vprAnalyzer.VPR_LABELS[from] || from, to, toLabel: vprAnalyzer.VPR_LABELS[to] || to, count };
  }).sort((a, b) => b.count - a.count);

  // 전환 매트릭스: D+5 judgmentStatus → D+10 VPR
  const transitionJudgmentToVpr = new Map();
  for (const e of eventsWithBoth) {
    const k = `${e.d5Snapshot.judgmentStatus}::${e.d10Snapshot.vprStatus}`;
    transitionJudgmentToVpr.set(k, (transitionJudgmentToVpr.get(k) || 0) + 1);
  }
  const d5JudgmentToD10VprTransition = Array.from(transitionJudgmentToVpr.entries()).map(([k, count]) => {
    const [from, to] = k.split('::');
    return { from, fromLabel: JUDGMENT_LABEL[from] || from, to, toLabel: vprAnalyzer.VPR_LABELS[to] || to, count };
  }).sort((a, b) => b.count - a.count);

  // 4-3) D+10 VPR 그룹별 H+10 성과
  function summarizeH10(group) {
    if (group.length === 0) return { count: 0 };
    const high = group.map(e => e.h10Forward?.maxHigh).filter(v => v != null);
    const close = group.map(e => e.h10Forward?.closeN).filter(v => v != null);
    const low = group.map(e => e.h10Forward?.minLow).filter(v => v != null);
    return {
      count: group.length,
      avgMaxHigh: round(mean(high)),
      medianMaxHigh: round(median(high)),
      avgCloseN: round(mean(close)),
      medianCloseN: round(median(close)),
      avgMinLow: round(mean(low)),
      plus10HighRate: rate(high.filter(v => v >= 10).length, high.length),
      plus20HighRate: rate(high.filter(v => v >= 20).length, high.length),
      minus5CloseRate: rate(close.filter(v => v <= -5).length, close.length),
      minus10CloseRate: rate(close.filter(v => v <= -10).length, close.length),
    };
  }
  const d10H10Performance = {
    all: { label: '전체 이벤트', ...summarizeH10(eventsWithD10) },
    strong: { label: '강한 VPR 성공', ...summarizeH10(eventsWithD10.filter(e => e.d10Snapshot.vprStatus === 'STRONG_VPR_SUCCESS')) },
    classic: { label: 'VPR 성공', ...summarizeH10(eventsWithD10.filter(e => e.d10Snapshot.vprStatus === 'CLASSIC_VPR_SUCCESS')) },
    weak: { label: 'VPR 재돌파 약함', ...summarizeH10(eventsWithD10.filter(e => e.d10Snapshot.vprStatus === 'WEAK_VPR_REBOUND')) },
    pending: { label: 'VPR 대기', ...summarizeH10(eventsWithD10.filter(e => e.d10Snapshot.vprStatus === 'PULLBACK_PENDING')) },
    runaway: { label: '눌림 없이 상승', ...summarizeH10(eventsWithD10.filter(e => e.d10Snapshot.vprStatus === 'NO_PULLBACK_RUNAWAY')) },
    structural: { label: '구조 훼손', ...summarizeH10(eventsWithD10.filter(e => e.d10Snapshot.vprStatus === 'STRUCTURAL_BREAK')) },
    reboundFail: { label: '재돌파 실패', ...summarizeH10(eventsWithD10.filter(e => e.d10Snapshot.vprStatus === 'REBOUND_FAIL')) },
  };

  // 4-4) 사용자 핵심 질문용 카운트
  const successD10Set = new Set(['STRONG_VPR_SUCCESS', 'CLASSIC_VPR_SUCCESS']);
  const transitionFacts = {
    // D+5 VPR 대기 → D+10 무엇으로?
    pendingAtD5: eventsWithBoth.filter(e => e.d5Snapshot.vprStatus === 'PULLBACK_PENDING')
      .reduce((acc, e) => {
        const t = e.d10Snapshot.vprStatus;
        acc[t] = (acc[t] || 0) + 1;
        return acc;
      }, {}),
    // D+5 눌림대기 → D+10 VPR 성공으로 전환?
    pwaitAtD5_toSuccessAtD10: eventsWithBoth.filter(e =>
      e.d5Snapshot.judgmentStatus === 'PULLBACK_WAIT' && successD10Set.has(e.d10Snapshot.vprStatus)
    ).length,
    pwaitAtD5_total: eventsWithBoth.filter(e => e.d5Snapshot.judgmentStatus === 'PULLBACK_WAIT').length,
    // D+5 재돌파 약함 → D+10 성공으로 회복?
    weakAtD5_toSuccessAtD10: eventsWithBoth.filter(e =>
      e.d5Snapshot.vprStatus === 'WEAK_VPR_REBOUND' && successD10Set.has(e.d10Snapshot.vprStatus)
    ).length,
    weakAtD5_total: eventsWithBoth.filter(e => e.d5Snapshot.vprStatus === 'WEAK_VPR_REBOUND').length,
  };

  // 5) 그룹 집계
  const verified = candidates.filter(c => c.returns != null);

  const judgmentOrder = ['REVIEW_OK', 'CHASE_CAUTION', 'PULLBACK_WAIT', 'MANAGEMENT', 'BREAKDOWN_WEAK'];
  const judgmentStatusPerformance = [
    summarizeGroup('H그룹 전체', verified, c => true, 'ALL'),
    ...judgmentOrder.map(s => summarizeGroup(JUDGMENT_LABEL[s], verified, c => c.judgmentStatus === s, s)),
  ].filter(g => g.count > 0);

  const vprOrder = ['STRONG_VPR_SUCCESS', 'CLASSIC_VPR_SUCCESS', 'WEAK_VPR_REBOUND', 'PULLBACK_PENDING', 'NO_PULLBACK_RUNAWAY', 'REBOUND_FAIL', 'STRUCTURAL_BREAK', 'DATA_INSUFFICIENT'];
  const vprStatusPerformance = [
    summarizeGroup('H그룹 전체', verified, c => true, 'ALL'),
    ...vprOrder.map(s => summarizeGroup(vprAnalyzer.VPR_LABELS[s], verified, c => c.vprStatus === s, s)),
  ].filter(g => g.count > 0);

  const combos = [
    { key: 'PWAIT_VPR_SUCCESS_ANY', label: '눌림 대기 + VPR 성공 (정석/강한)',
      filter: c => c.judgmentStatus === 'PULLBACK_WAIT' && (c.vprStatus === 'CLASSIC_VPR_SUCCESS' || c.vprStatus === 'STRONG_VPR_SUCCESS') },
    { key: 'PWAIT_STRONG', label: '눌림 대기 + 강한 VPR 성공',
      filter: c => c.judgmentStatus === 'PULLBACK_WAIT' && c.vprStatus === 'STRONG_VPR_SUCCESS' },
    { key: 'PWAIT_CLASSIC', label: '눌림 대기 + 정석 VPR 성공',
      filter: c => c.judgmentStatus === 'PULLBACK_WAIT' && c.vprStatus === 'CLASSIC_VPR_SUCCESS' },
    { key: 'PWAIT_PEND', label: '눌림 대기 + VPR 대기',
      filter: c => c.judgmentStatus === 'PULLBACK_WAIT' && c.vprStatus === 'PULLBACK_PENDING' },
    { key: 'PWAIT_NORUN', label: '눌림 대기 + 눌림 없이 상승',
      filter: c => c.judgmentStatus === 'PULLBACK_WAIT' && c.vprStatus === 'NO_PULLBACK_RUNAWAY' },
    { key: 'PWAIT_WEAK', label: '눌림 대기 + VPR 재돌파 약함',
      filter: c => c.judgmentStatus === 'PULLBACK_WAIT' && c.vprStatus === 'WEAK_VPR_REBOUND' },
    { key: 'PWAIT_STRUCT', label: '눌림 대기 + 구조 훼손',
      filter: c => c.judgmentStatus === 'PULLBACK_WAIT' && c.vprStatus === 'STRUCTURAL_BREAK' },
    { key: 'MGMT_NORUN', label: '관리 구간 + 눌림 없이 상승',
      filter: c => c.judgmentStatus === 'MANAGEMENT' && c.vprStatus === 'NO_PULLBACK_RUNAWAY' },
    { key: 'BWEAK_PEND', label: '돌파 악화 + VPR 대기',
      filter: c => c.judgmentStatus === 'BREAKDOWN_WEAK' && c.vprStatus === 'PULLBACK_PENDING' },
    { key: 'BWEAK_WEAK', label: '돌파 악화 + VPR 재돌파 약함',
      filter: c => c.judgmentStatus === 'BREAKDOWN_WEAK' && c.vprStatus === 'WEAK_VPR_REBOUND' },
    { key: 'BWEAK_STRUCT', label: '돌파 악화 + 구조 훼손',
      filter: c => c.judgmentStatus === 'BREAKDOWN_WEAK' && c.vprStatus === 'STRUCTURAL_BREAK' },
  ];
  const combinedStatusPerformance = combos.map(co => summarizeGroup(co.label, verified, co.filter, co.key));

  // 6) 이벤트 기준 — 마지막 노출(= 가장 성숙된 VPR 분류) 시점 다음날 결과로 집계
  // 이유: 첫 노출은 보통 D+0(돌파 당일)이라 VPR 분석 윈도우가 0일이라 DATA_INSUFFICIENT.
  //      마지막 노출은 D+5 근처라 VPR 분류가 의미 있는 시점이다.
  const eventCands = events.map(e => {
    const lastC = candidates.find(c => c.eventKey === e.eventKey && c.cutoffDate === e.lastSeenDate);
    return {
      eventKey: e.eventKey,
      code: e.code,
      name: e.name,
      cutoffDate: e.lastSeenDate,
      vprStatus: lastC?.vprStatus,
      judgmentStatus: lastC?.judgmentStatus,
      returns: e.lastNextDayResult,
    };
  });
  const eventVerified = eventCands.filter(c => c.returns != null);
  const eventVprPerformance = [
    summarizeGroup('이벤트 전체', eventVerified, c => true, 'ALL'),
    ...vprOrder.map(s => summarizeGroup(vprAnalyzer.VPR_LABELS[s], eventVerified, c => c.vprStatus === s, s)),
  ].filter(g => g.count > 0);
  const eventJudgmentPerformance = judgmentOrder
    .map(s => summarizeGroup(JUDGMENT_LABEL[s], eventVerified, c => c.judgmentStatus === s, s))
    .filter(g => g.count > 0);

  // 7) 일자별 요약
  const dailyResults = [];
  for (const d of tradingDatesInRange) {
    const dayCands = verified.filter(c => c.cutoffDate === d);
    if (dayCands.length === 0) {
      dailyResults.push({ date: d, count: 0 });
      continue;
    }
    dailyResults.push({
      date: d,
      count: dayCands.length,
      avgClose: round(mean(dayCands.map(c => c.returns.closeFromCutoff))),
      avgHigh: round(mean(dayCands.map(c => c.returns.highFromCutoff))),
      pwaitCount: dayCands.filter(c => c.judgmentStatus === 'PULLBACK_WAIT').length,
      structuralCount: dayCands.filter(c => c.vprStatus === 'STRUCTURAL_BREAK').length,
    });
  }

  // 8) 핵심 질문 자동 답변
  const allG = judgmentStatusPerformance.find(g => g.key === 'ALL');
  const pwaitG = judgmentStatusPerformance.find(g => g.key === 'PULLBACK_WAIT');
  const mgmtG = judgmentStatusPerformance.find(g => g.key === 'MANAGEMENT');
  const succG = vprStatusPerformance.find(g => g.key === 'CLASSIC_VPR_SUCCESS');
  const strongG = vprStatusPerformance.find(g => g.key === 'STRONG_VPR_SUCCESS');
  const weakG = vprStatusPerformance.find(g => g.key === 'WEAK_VPR_REBOUND');
  const structG = vprStatusPerformance.find(g => g.key === 'STRUCTURAL_BREAK');
  const pwaitVprSuccG = combinedStatusPerformance.find(g => g.key === 'PWAIT_VPR_SUCCESS_ANY');
  const pwaitPendG = combinedStatusPerformance.find(g => g.key === 'PWAIT_PEND');
  const eventAllG = eventVprPerformance.find(g => g.key === 'ALL');
  const eventPwaitG = eventJudgmentPerformance.find(g => g.key === 'PULLBACK_WAIT');

  const keyQuestions = [
    {
      q: '눌림대기 상태는 H그룹 전체보다 다음날 성과가 좋았는가?',
      a: cmpAvg('눌림 대기', pwaitG, 'H그룹 전체', allG),
    },
    {
      q: '눌림대기 + VPR 성공은 눌림대기 전체보다 다음날 성과가 좋았는가?',
      a: cmpAvg('눌림 대기 + VPR 성공(정석/강한)', pwaitVprSuccG, '눌림 대기 전체', pwaitG),
    },
    {
      q: '눌림대기 + VPR 대기는 실제로 아직 기다리는 편이 나았는가?',
      a: pwaitPendG && pwaitPendG.count > 0
        ? `눌림 대기 + VPR 대기(n=${pwaitPendG.count}) 다음날 평균 종가 ${fmtPctText(pwaitPendG.avgCloseFromCutoff)}, +5% 고가 반응 ${pwaitPendG.plus5HighRate ?? '-'}% — ${(pwaitPendG.avgCloseFromCutoff ?? 0) > (pwaitG?.avgCloseFromCutoff ?? 0) ? '눌림 대기 평균보다 좋음' : '눌림 대기 평균보다 약하거나 비슷'}.`
        : '눌림 대기 + VPR 대기 사례가 없어 비교 불가.',
    },
    {
      q: 'VPR 재돌파 약함은 다음날 성과가 약했는가?',
      a: cmpAvg('VPR 재돌파 약함', weakG, 'H그룹 전체', allG, { weakerIsAnswer: true }),
    },
    {
      q: '구조 훼손은 다음날 손실률이 높았는가?',
      a: structG && structG.count > 0
        ? `구조 훼손(n=${structG.count}) 다음날 평균 종가 ${fmtPctText(structG.avgCloseFromCutoff)}, -3% 종가 ${structG.minus3CloseRate ?? '-'}%, -5% 저가 ${structG.minus5LowRate ?? '-'}% — ${(structG.avgCloseFromCutoff ?? 0) < 0 ? '평균 음의 수익으로 위험 패턴 확인' : '단기로는 명확한 손실 패턴 미관측'}.`
        : '구조 훼손 사례가 없어 판단 보류.',
    },
    {
      q: '관리 구간은 다음날에도 계속 강했는가, 아니면 추격 위험이 컸는가?',
      a: mgmtG && mgmtG.count > 0
        ? `관리 구간(n=${mgmtG.count}) 다음날 평균 종가 ${fmtPctText(mgmtG.avgCloseFromCutoff)}, 평균 저가 ${fmtPctText(mgmtG.avgLowFromCutoff)}, -3% 종가 ${mgmtG.minus3CloseRate ?? '-'}% — ${(mgmtG.minus3CloseRate ?? 0) > 30 ? '추격 위험이 통계적으로 확인됨' : '평균적으로 추가 강세 또는 보합 흐름'}.`
        : '관리 구간 사례가 없어 판단 보류.',
    },
    {
      q: '화면 상태만 보는 것보다 VPR 태그를 같이 보는 것이 더 나았는가?',
      a: (() => {
        if (!pwaitG || !pwaitVprSuccG || pwaitG.count === 0) return '눌림 대기 사례가 없어 비교 불가.';
        const base = pwaitG.avgCloseFromCutoff;
        const enriched = pwaitVprSuccG.avgCloseFromCutoff;
        if (base == null || enriched == null) return '값 산출 불가.';
        return `눌림 대기 전체(n=${pwaitG.count}) 평균 ${fmtPctText(base)} vs 눌림 대기 + VPR 성공(n=${pwaitVprSuccG.count}) 평균 ${fmtPctText(enriched)} — ${enriched > base ? 'VPR 태그가 추가 분리력을 보였습니다.' : '단기 1일에서는 VPR 추가 분리력이 약하거나 사례 수가 부족합니다.'}`;
      })(),
    },
    {
      q: '중복 제거 후에도 같은 결론이 유지되는가?',
      a: (() => {
        if (!eventAllG || !eventPwaitG) return '이벤트 기준 사례가 부족해 비교 불가.';
        const expoBase = pwaitG?.avgCloseFromCutoff;
        const eventBase = eventPwaitG.avgCloseFromCutoff;
        if (expoBase == null || eventBase == null) return '값 산출 불가.';
        const sameDirection = (expoBase >= 0) === (eventBase >= 0);
        return `보드 노출 기준 눌림 대기 평균 ${fmtPctText(expoBase)} vs 이벤트 기준(마지막 노출일 다음날) 평균 ${fmtPctText(eventBase)} — ${sameDirection ? '방향성 일관됨.' : '중복 제거 시 방향성이 바뀌어 노출 빈도 효과 가능성 있음.'} 보드 노출 ${candidates.length}건 → 이벤트 ${events.length}건 (중복 제거율 ${rate(candidates.length - events.length, candidates.length) ?? 0}%).`;
      })(),
    },
  ];

  // 9) 대표 사례
  const successCases = verified
    .filter(c => c.judgmentStatus === 'PULLBACK_WAIT' && (c.vprStatus === 'CLASSIC_VPR_SUCCESS' || c.vprStatus === 'STRONG_VPR_SUCCESS'))
    .sort((a, b) => (b.returns?.highFromCutoff ?? -Infinity) - (a.returns?.highFromCutoff ?? -Infinity))
    .slice(0, 10);
  const failureCases = verified
    .filter(c => c.vprStatus === 'STRUCTURAL_BREAK' || c.vprStatus === 'WEAK_VPR_REBOUND')
    .sort((a, b) => (a.returns?.closeFromCutoff ?? 0) - (b.returns?.closeFromCutoff ?? 0))
    .slice(0, 10);

  const conclusion = buildConclusion({ allG, pwaitG, succG, strongG, weakG, structG, mgmtG, pwaitVprSuccG });

  // 사용자가 요구한 D+5↔D+10 전환 7개 질문
  const fmtDist = (distMap) => Object.entries(distMap).map(([k, v]) => `${vprAnalyzer.VPR_LABELS[k] || k} ${v}건`).join(', ');
  const d10SuccessG = (d10H10Performance.classic.count || 0) + (d10H10Performance.strong.count || 0);
  const d10StructG = d10H10Performance.structural;
  const transitionQuestions = [
    {
      q: '1. D+5 시점 VPR 상태 분포',
      a: d5VprDistribution.length > 0
        ? d5VprDistribution.map(d => `${vprAnalyzer.VPR_LABELS[d.status] || d.status} ${d.count}건`).join(', ')
        : 'D+5 시점 데이터 없음.',
    },
    {
      q: '2. D+10 시점 (성숙) VPR 상태 분포',
      a: d10VprDistribution.length > 0
        ? d10VprDistribution.map(d => `${vprAnalyzer.VPR_LABELS[d.status] || d.status} ${d.count}건`).join(', ')
        : 'D+10 시점 데이터 없음 (캐시 끝에 도달한 이벤트 부재).',
    },
    {
      q: '3. D+5 시점 VPR 대기였던 종목이 D+10에 무엇으로 전환됐는가?',
      a: Object.keys(transitionFacts.pendingAtD5).length > 0
        ? `D+5 VPR 대기 ${Object.values(transitionFacts.pendingAtD5).reduce((s, v) => s + v, 0)}건 → D+10에서: ${fmtDist(transitionFacts.pendingAtD5)}`
        : 'D+5 VPR 대기 사례가 없습니다.',
    },
    {
      q: '4. D+5 눌림대기였던 종목이 D+10에 VPR 성공(정석/강한)으로 전환됐는가?',
      a: transitionFacts.pwaitAtD5_total > 0
        ? `D+5 눌림대기 ${transitionFacts.pwaitAtD5_total}건 중 D+10 시점 VPR 성공으로 전환된 사례 = ${transitionFacts.pwaitAtD5_toSuccessAtD10}건 (${rate(transitionFacts.pwaitAtD5_toSuccessAtD10, transitionFacts.pwaitAtD5_total)}%).`
        : 'D+5 눌림대기 사례가 없습니다.',
    },
    {
      q: '5. D+5 재돌파 약함(WEAK)이 D+10에 성공으로 회복됐는가?',
      a: transitionFacts.weakAtD5_total > 0
        ? `D+5 재돌파 약함 ${transitionFacts.weakAtD5_total}건 중 D+10 시점 VPR 성공 회복 = ${transitionFacts.weakAtD5_toSuccessAtD10}건 (${rate(transitionFacts.weakAtD5_toSuccessAtD10, transitionFacts.weakAtD5_total)}%).`
        : 'D+5 재돌파 약함 사례가 없습니다.',
    },
    {
      q: '6. D+10 VPR 성공 그룹의 H+10 고가/종가 성과',
      a: (() => {
        const lines = [];
        if (d10H10Performance.strong.count > 0) {
          const g = d10H10Performance.strong;
          lines.push(`강한 VPR 성공(n=${g.count}): 평균 H+10 고가 ${fmtPctText(g.avgMaxHigh)} / 종가 ${fmtPctText(g.avgCloseN)} / +20% 고가 도달률 ${g.plus20HighRate}%`);
        }
        if (d10H10Performance.classic.count > 0) {
          const g = d10H10Performance.classic;
          lines.push(`정석 VPR 성공(n=${g.count}): 평균 H+10 고가 ${fmtPctText(g.avgMaxHigh)} / 종가 ${fmtPctText(g.avgCloseN)}`);
        }
        return lines.length > 0 ? lines.join(' | ') : 'D+10 VPR 성공 사례가 없습니다.';
      })(),
    },
    {
      q: '7. D+10 구조 훼손 그룹의 H+10 손실률',
      a: d10StructG.count > 0
        ? `구조 훼손(n=${d10StructG.count}): 평균 H+10 종가 ${fmtPctText(d10StructG.avgCloseN)} / 평균 최저 저가 ${fmtPctText(d10StructG.avgMinLow)} / -5% 종가 ${d10StructG.minus5CloseRate}% / -10% 종가 ${d10StructG.minus10CloseRate}%`
        : 'D+10 구조 훼손 사례가 없습니다.',
    },
  ];

  // 10) summary 타일
  const boardExposureSummary = {
    totalCandidates: candidates.length,
    verifiedCount: verified.length,
    avgHigh: allG?.avgHighFromCutoff ?? null,
    pwaitAvgHigh: pwaitG?.avgHighFromCutoff ?? null,
    pwaitVprSuccAvgHigh: pwaitVprSuccG?.avgHighFromCutoff ?? null,
    structMinus3Rate: structG?.minus3CloseRate ?? null,
    pwaitCount: pwaitG?.count ?? 0,
    structCount: structG?.count ?? 0,
  };
  const eventBasedSummary = {
    totalEvents: events.length,
    dedupRate: rate(candidates.length - events.length, candidates.length),
    avgHigh: eventAllG?.avgHighFromCutoff ?? null,
    pwaitAvgHigh: eventPwaitG?.avgHighFromCutoff ?? null,
  };

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'VPR H그룹 일별 보드 다음날 백테스트',
      purpose: `${fmtDate(FROM)} ~ ${fmtDate(TO)} 매일 QVA 보드를 재현해서 BREAKOUT_SUCCESS(H그룹) 종목의 화면 상태/VPR 후속 태그가 다음 거래일 성과를 잘 구분했는지 검증한다.`,
      notice: '각 cutoff의 후보 선정·VPR 계산에는 cutoff 이후 데이터를 사용하지 않았으며, 다음 거래일 데이터는 결과 검증에만 사용했습니다.',
      from: FROM, to: TO,
      boardSource: 'qva-watchlist-board.js의 BREAKOUT_SUCCESS 검출 로직을 동일하게 재현 (cutoff까지의 rows만 사용)',
      vprSource: 'vpr-analyzer.js 재사용 (정의 변경 없음)',
      judgmentLabels: JUDGMENT_LABEL,
      vprLabels: vprAnalyzer.VPR_LABELS,
      vprDescriptions: vprAnalyzer.VPR_DESCRIPTIONS,
    },
    config: {
      from: FROM, to: TO,
      trackingDays: TRACKING_DAYS,
      recentBreakoutDays: RECENT_BREAKOUT_DAYS,
      matureLookaheadDays: MATURE_LOOKAHEAD_DAYS,
      exitThresholdPct: EXIT_THRESHOLD_PCT,
      tradingDatesInRange,
      note: `보드 노출은 D+0~D+${RECENT_BREAKOUT_DAYS}거래일 (라이브 보드 그대로). 같은 H이벤트의 D+${RECENT_BREAKOUT_DAYS} 시점 분류 + D+${MATURE_LOOKAHEAD_DAYS} 시점 성숙 분류를 별도로 보여준다.`,
    },
    boardExposureSummary,
    eventBasedSummary,
    dailyResults,
    judgmentStatusPerformance,
    vprStatusPerformance,
    combinedStatusPerformance,
    eventVprPerformance,
    eventJudgmentPerformance,
    d5VprDistribution,
    d10VprDistribution,
    d5JudgmentDistribution,
    d10JudgmentDistribution,
    d5ToD10VprTransition,
    d5JudgmentToD10VprTransition,
    d10H10Performance,
    transitionFacts,
    candidates,
    events,
    examples: { successCases, failureCases },
    keyQuestions,
    transitionQuestions,
    conclusion,
    dataLimit: [
      `분석 기간은 ${fmtDate(FROM)} ~ ${fmtDate(TO)} (cutoff 거래일 ${tradingDatesInRange.length}일)입니다.`,
      '대상은 각 날짜 기준 BREAKOUT_SUCCESS(H그룹)만이며, 다른 단계는 분석에서 제외합니다.',
      'VPR은 H그룹 후속 관리 태그이며 독립 매수 신호가 아닙니다.',
      '다음 거래일 하루 성과만 보는 단기 검증입니다.',
      `보드 노출은 라이브 보드와 동일하게 D+0~D+${RECENT_BREAKOUT_DAYS}거래일까지만 인정합니다. 같은 H이벤트의 D+${MATURE_LOOKAHEAD_DAYS}거래일 시점 VPR/judgment를 별도로 계산해 보드 단계에서는 보이지 않던 정석/강한 VPR 성공이 어떻게 형성되는지 같이 보여줍니다.`,
      `D+${MATURE_LOOKAHEAD_DAYS} 시점 분석은 cutoffDate 이후 ${MATURE_LOOKAHEAD_DAYS - RECENT_BREAKOUT_DAYS}거래일이 더 흐른 뒤를 보는 것이라, 캐시 끝(${tradingDatesAll[tradingDatesAll.length - 1] || '-'})에 가까운 이벤트는 D+${MATURE_LOOKAHEAD_DAYS} 데이터가 없어 분석 누락됩니다.`,
      '같은 종목이 여러 날짜 반복 노출될 수 있어 보드 노출 기준과 이벤트 기준(eventKey = code+vviDate+hDate)을 모두 제공합니다.',
      `다음 거래일 데이터가 캐시에 없는 종목은 검증 불가 처리됩니다 (이번 분석에서 ${candidates.length - verified.length}건).`,
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  console.log(`\n📊 보드 노출 기준 — 화면 상태별 다음날 성과:`);
  for (const g of judgmentStatusPerformance) {
    if (!g.count) continue;
    console.log(`  ${g.label.padEnd(12)} n=${String(g.count).padStart(4)}  종가 ${fmtPctText(g.avgCloseFromCutoff).padStart(8)} / 고가 ${fmtPctText(g.avgHighFromCutoff).padStart(8)} / -3%종가 ${String(g.minus3CloseRate ?? '-').padStart(5)}%`);
  }
  console.log(`\n📊 보드 노출 기준 — VPR 상태별 다음날 성과:`);
  for (const g of vprStatusPerformance) {
    if (!g.count) continue;
    console.log(`  ${g.label.padEnd(16)} n=${String(g.count).padStart(4)}  종가 ${fmtPctText(g.avgCloseFromCutoff).padStart(8)} / 고가 ${fmtPctText(g.avgHighFromCutoff).padStart(8)} / -3%종가 ${String(g.minus3CloseRate ?? '-').padStart(5)}%`);
  }
  console.log(`\n📊 화면 + VPR 조합 (사례 발생만):`);
  for (const g of combinedStatusPerformance) {
    if (!g.count) continue;
    console.log(`  ${g.label.padEnd(34)} n=${String(g.count).padStart(3)}  종가 ${fmtPctText(g.avgCloseFromCutoff).padStart(8)} / 고가 ${fmtPctText(g.avgHighFromCutoff).padStart(8)}`);
  }
  console.log(`\n📊 이벤트 기준 (마지막 노출일 다음날 — VPR이 가장 성숙된 시점) — VPR 상태별:`);
  for (const g of eventVprPerformance) {
    if (!g.count) continue;
    console.log(`  ${g.label.padEnd(16)} n=${String(g.count).padStart(4)}  종가 ${fmtPctText(g.avgCloseFromCutoff).padStart(8)} / 고가 ${fmtPctText(g.avgHighFromCutoff).padStart(8)}`);
  }

  console.log(`\n📝 핵심 질문 자동 답변:`);
  for (const q of keyQuestions) {
    console.log(`  Q. ${q.q}`);
    console.log(`     → ${q.a}`);
  }

  console.log(`\n📈 D+${RECENT_BREAKOUT_DAYS} ↔ D+${MATURE_LOOKAHEAD_DAYS} 전환 분석:`);
  for (const q of transitionQuestions) {
    console.log(`  ${q.q}`);
    console.log(`     → ${q.a}`);
  }

  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

function summarizeGroup(label, items, filterFn, key) {
  const arr = items.filter(filterFn);
  const N = arr.length;
  if (N === 0) return { label, key, count: 0 };
  const close = arr.map(c => c.returns?.closeFromCutoff);
  const high = arr.map(c => c.returns?.highFromCutoff);
  const low = arr.map(c => c.returns?.lowFromCutoff);
  const closeFromEntry = arr.map(c => c.returns?.closeFromEntry);
  const validClose = close.filter(v => v != null && Number.isFinite(v));
  const validHigh = high.filter(v => v != null && Number.isFinite(v));
  const validLow = low.filter(v => v != null && Number.isFinite(v));
  return {
    label, key, count: N,
    verifiedCount: validClose.length,
    avgCloseFromCutoff: round(mean(close)),
    medianCloseFromCutoff: round(median(close)),
    avgHighFromCutoff: round(mean(high)),
    medianHighFromCutoff: round(median(high)),
    avgLowFromCutoff: round(mean(low)),
    avgCloseFromEntry: round(mean(closeFromEntry)),
    plus3CloseRate: rate(validClose.filter(v => v >= 3).length, validClose.length),
    plus5HighRate: rate(validHigh.filter(v => v >= 5).length, validHigh.length),
    plus10HighRate: rate(validHigh.filter(v => v >= 10).length, validHigh.length),
    minus3CloseRate: rate(validClose.filter(v => v <= -3).length, validClose.length),
    minus5LowRate: rate(validLow.filter(v => v <= -5).length, validLow.length),
  };
}

function cmpAvg(labelA, gA, labelB, gB, opts = {}) {
  if (!gA || gA.count === 0) return `${labelA} 사례가 없어 비교 불가.`;
  if (!gB || gB.count === 0) return `${labelB} 사례가 없어 비교 불가.`;
  const a = gA.avgCloseFromCutoff;
  const b = gB.avgCloseFromCutoff;
  if (a == null || b == null) return '값 산출 불가.';
  const better = opts.weakerIsAnswer ? a < b : a > b;
  const compareWord = opts.weakerIsAnswer ? '약했습니다' : '나았습니다';
  const oppositeWord = opts.weakerIsAnswer ? '오히려 강했거나 비슷했습니다' : '비슷하거나 더 약했습니다';
  return `${labelA}(n=${gA.count}) ${fmtPctText(a)} vs ${labelB}(n=${gB.count}) ${fmtPctText(b)} — ${better ? compareWord : oppositeWord}.`;
}

function buildOneLineSummary(judgmentStatus, vprStatus, returns) {
  const ret = returns?.closeFromCutoff;
  const high = returns?.highFromCutoff;
  if (ret == null) return '다음 거래일 데이터가 없어 검증 불가한 사례입니다.';
  const retText = fmtPctText(ret);
  const highText = high != null ? `장중 ${fmtPctText(high)}까지 반응` : '';
  const jl = JUDGMENT_LABEL[judgmentStatus] || judgmentStatus;
  const vl = vprAnalyzer.VPR_LABELS[vprStatus] || vprStatus;

  if (judgmentStatus === 'PULLBACK_WAIT' && (vprStatus === 'CLASSIC_VPR_SUCCESS' || vprStatus === 'STRONG_VPR_SUCCESS')) {
    return `기준일 당시 ${jl} + ${vl} 상태였고, 다음 거래일 ${highText || `종가 ${retText}`}.`;
  }
  if (judgmentStatus === 'PULLBACK_WAIT' && vprStatus === 'PULLBACK_PENDING') {
    return `${jl}였지만 ${vl} 상태였고, 다음 거래일 종가 ${retText}.`;
  }
  if (vprStatus === 'STRUCTURAL_BREAK') {
    return `${vl} 상태였으며, 다음 거래일 종가 ${retText}${highText ? ' (' + highText + ')' : ''}.`;
  }
  if (judgmentStatus === 'MANAGEMENT') {
    return `${jl}으로 이미 상승이 진행된 상태였고, 다음날 종가 ${retText}.`;
  }
  if (vprStatus === 'NO_PULLBACK_RUNAWAY') {
    return `${vl} 상태였고, 다음 거래일 종가 ${retText}.`;
  }
  return `${jl} / ${vl} 상태, 다음 거래일 종가 ${retText}${highText ? ' (' + highText + ')' : ''}.`;
}

function buildConclusion({ allG, pwaitG, succG, strongG, weakG, structG, mgmtG, pwaitVprSuccG }) {
  const out = [];
  if (pwaitG && allG && pwaitG.avgCloseFromCutoff != null && allG.avgCloseFromCutoff != null) {
    out.push(`눌림 대기 그룹(n=${pwaitG.count}) 다음날 평균 종가 ${fmtPctText(pwaitG.avgCloseFromCutoff)} / H그룹 전체(n=${allG.count}) ${fmtPctText(allG.avgCloseFromCutoff)} — ${pwaitG.avgCloseFromCutoff > allG.avgCloseFromCutoff ? '눌림 대기가 약간 우위' : '큰 차이는 미관측'}.`);
  }
  if (pwaitVprSuccG && pwaitG && pwaitVprSuccG.avgCloseFromCutoff != null && pwaitG.avgCloseFromCutoff != null && pwaitVprSuccG.count > 0) {
    if (pwaitVprSuccG.avgCloseFromCutoff > pwaitG.avgCloseFromCutoff) {
      out.push(`눌림 대기 + VPR 성공(n=${pwaitVprSuccG.count}) ${fmtPctText(pwaitVprSuccG.avgCloseFromCutoff)} > 눌림 대기 전체 ${fmtPctText(pwaitG.avgCloseFromCutoff)} — VPR 성공 태그가 추가 분리력을 보였습니다.`);
    }
  }
  if (strongG && strongG.count > 0 && strongG.avgCloseFromCutoff != null) {
    out.push(`강한 VPR 성공(n=${strongG.count}) ${fmtPctText(strongG.avgCloseFromCutoff)} / 평균 고가 ${fmtPctText(strongG.avgHighFromCutoff)} — 한 단계 더 강한 분리 신호.`);
  }
  if (weakG && weakG.count > 0 && weakG.avgCloseFromCutoff != null) {
    out.push(`VPR 재돌파 약함(n=${weakG.count}) ${fmtPctText(weakG.avgCloseFromCutoff)} — ${(weakG.avgCloseFromCutoff ?? 0) < 0 ? '약세 패턴 확인' : '단기로는 약함 라벨이 충분히 분리되지 않음'}.`);
  }
  if (structG && structG.count > 0 && structG.avgCloseFromCutoff != null) {
    out.push(`구조 훼손(n=${structG.count}) ${fmtPctText(structG.avgCloseFromCutoff)} / -3% 종가 ${structG.minus3CloseRate ?? '-'}% — ${(structG.avgCloseFromCutoff ?? 0) < -1 ? '실제 약세 흐름 확인' : '단기 1일에서는 명확한 약세 패턴 미관측'}.`);
  }
  if (mgmtG && mgmtG.count > 0 && mgmtG.avgCloseFromCutoff != null) {
    out.push(`관리 구간(n=${mgmtG.count}) 다음날 평균 종가 ${fmtPctText(mgmtG.avgCloseFromCutoff)} / -3% 종가 ${mgmtG.minus3CloseRate ?? '-'}% — ${(mgmtG.minus3CloseRate ?? 0) > 30 ? '추격 위험 통계적 확인' : '평균 추가 강세 또는 보합'}.`);
  }
  out.push('VPR 태그는 H그룹 후속 관리 태그로만 사용하고, 매수 확정 신호로 해석하지 마세요.');
  return out;
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>VPR H그룹 일별 보드 다음날 백테스트</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
  -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile.primary { border-left: 4px solid #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }
.big-tile.success { border-left: 4px solid #14b8a6; }
.big-tile.success .value { color: #5eead4; }
.big-tile.warn { border-left: 4px solid #f59e0b; }
.big-tile.warn .value { color: #fde047; }
.big-tile.fail { border-left: 4px solid #ef4444; }
.big-tile.fail .value { color: #fca5a5; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 18px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-top: 3px; }
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
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }

.tbl-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.list { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
table.list thead th { background: #0f172a; color: #94a3b8; font-weight: 600; text-align: left; padding: 9px 12px; border-bottom: 1px solid #334155; white-space: nowrap; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
table.list thead th.numeric { text-align: right; }
table.list tbody tr.row { border-bottom: 1px solid #1e293b; }
table.list tbody tr.row:hover { background: #273549; }
table.list tbody tr.row td { padding: 8px 12px; vertical-align: middle; line-height: 1.3; white-space: nowrap; }
table.list tbody tr.row td.numeric { text-align: right; }
table.list tbody tr.row td.col-name { font-weight: 600; color: #f1f5f9; min-width: 130px; }
table.list tbody tr.row td.col-name .meta { display: block; font-size: 10px; color: #64748b; font-weight: 400; margin-top: 2px; }
table.list tbody tr.row td.col-summary { color: #cbd5e1; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: normal; line-height: 1.4; font-size: 11.5px; }
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
.qa-block .q { color: #94a3b8; font-size: 12px; margin-bottom: 4px; }
.qa-block .q strong { color: #67e8f9; margin-right: 4px; }
.qa-block .a { color: #cbd5e1; line-height: 1.7; padding-left: 10px; }
.findings { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; }
.findings ul { margin: 0; padding-left: 20px; line-height: 1.8; }
.findings li { color: #cbd5e1; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

.scroll-x {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  max-width: 100%;
  margin-bottom: 14px;
  border-radius: 8px;
}
.scroll-x table.cmp { margin-bottom: 0; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; }
  .tbl-wrap { overflow-x: auto !important; }
  .col-mobile-hide,
  table.list thead th.col-mobile-hide { display: none; }
  .scroll-x table.cmp {
    width: max-content;
    min-width: 100%;
    white-space: nowrap;
  }
}
</style>
</head>
<body>

<h1>VPR H그룹 일별 보드 다음날 백테스트</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  이 보고서는 <strong>2026-04-01 ~ 2026-04-30</strong> 기간 동안 매일 QVA 보드에 나타난
  <strong>돌파 성공(H그룹)</strong> 종목을 대상으로, 당시 화면 상태와 VPR 후속 태그가
  <strong>다음 거래일</strong> 성과를 잘 구분했는지 확인합니다.
</div>

<div class="warn-banner">
  ⚠️ 각 cutoff의 후보 선정·VPR 계산에는 cutoff 이후 데이터를 사용하지 않았으며, 다음 거래일 데이터는 결과 검증에만 사용했습니다.
  같은 종목이 여러 날짜에 반복 노출될 수 있어 <strong>보드 노출 기준</strong>과 <strong>이벤트 기준</strong>을 모두 제공합니다.
  <br><strong>보드 노출 = D+0~D+<span id="recent-banner"></span>거래일</strong> (라이브 보드 그대로) /
  <strong>VPR 성숙 분석 = D+<span id="mature-banner"></span>거래일</strong> 시점 분류 (정석/강한 성공이 형성될 시간 확보).
  같은 H이벤트의 D+5와 D+10 두 시점을 별도로 계산해서 전환 매트릭스를 함께 제공합니다.
</div>

<h2>📊 핵심 타일</h2>
<div class="big-summary" id="big-summary"></div>

<h2>📅 날짜별 H그룹 수와 평균 성과</h2>
<div id="daily-results-table"></div>

<h2>📊 화면 상태별 다음날 성과 (보드 노출 기준)</h2>
<div id="judgment-perf-table"></div>

<h2>📊 VPR 상태별 다음날 성과 (보드 노출 기준)</h2>
<div id="vpr-perf-table"></div>

<h2>📊 화면 + VPR 조합 (사례 발생만)</h2>
<div id="combined-perf-table"></div>

<h2>📊 보드 노출 기준 vs 이벤트 기준 비교</h2>
<p class="subtitle">이벤트 = 같은 (code + vviDate + hDate) 묶음. <strong>마지막 노출일(가장 성숙된 VPR 분류 시점) 다음날 결과</strong>로 집계합니다. 첫 노출은 보통 돌파 당일이라 VPR 분석 윈도우가 0일이라 의미가 없어 마지막 노출 기준을 채택했습니다.</p>
<h3 style="font-size:14px;color:#cbd5e1;">이벤트 기준 — 화면 상태별</h3>
<div id="event-judgment-table"></div>
<h3 style="font-size:14px;color:#cbd5e1;">이벤트 기준 — VPR 상태별</h3>
<div id="event-vpr-table"></div>

<h2>📊 D+5 ↔ D+10 분포 비교</h2>
<p class="subtitle">같은 H이벤트에 대해 보드 노출 마감 시점(D+5)과 VPR 성숙 분석 시점(D+10)의 분류를 별도로 계산해 비교합니다.</p>
<div id="d5-d10-distribution"></div>

<h2>🔄 D+5 → D+10 VPR 전환 매트릭스</h2>
<div id="d5-d10-vpr-transition"></div>

<h2>🔄 D+5 화면 상태 → D+10 VPR 전환</h2>
<div id="d5j-d10v-transition"></div>

<h2>📊 D+10 VPR 그룹별 H+10 성과 (H돌파일 종가 기준 ~10거래일)</h2>
<div id="d10-h10-perf"></div>

<h2>🎯 D+5 ↔ D+10 전환 분석 (사용자 핵심 질문)</h2>
<div id="transition-questions"></div>

<h2>📝 핵심 질문 자동 답변 (다음 거래일 단기 검증)</h2>
<div id="key-questions"></div>

<h2>🏁 결론</h2>
<div class="findings" id="conclusion"></div>

<h2>🏆 H그룹 사례 리스트 (보드 노출 기준)</h2>
<div class="tabs" id="tabs"></div>
<div class="tbl-wrap">
  <table class="list">
    <thead>
      <tr>
        <th>#</th>
        <th>기준일</th>
        <th class="col-mobile-hide">다음날</th>
        <th>종목</th>
        <th class="col-mobile-hide">QVA</th>
        <th class="col-mobile-hide">VVI</th>
        <th class="col-mobile-hide">H돌파</th>
        <th>화면 상태</th>
        <th>VPR 상태</th>
        <th class="numeric col-mobile-hide">기준 종가</th>
        <th class="numeric">다음날 종가↑</th>
        <th class="numeric col-mobile-hide">다음날 고가↑</th>
        <th class="numeric col-mobile-hide">다음날 저가</th>
        <th class="numeric col-mobile-hide">노출 회차</th>
        <th class="col-summary">한 줄 해석</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;

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
  ' · 보드 D+0~D+' + DATA.config.recentBreakoutDays + ' / 성숙 D+' + DATA.config.matureLookaheadDays +
  ' · 보드 노출 ' + DATA.boardExposureSummary.totalCandidates + '건 · 이벤트 ' + DATA.eventBasedSummary.totalEvents + '건' +
  ' · 중복 제거율 ' + (DATA.eventBasedSummary.dedupRate ?? 0) + '%' +
  ' · 생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');
const _recentBanner = document.getElementById('recent-banner');
const _matureBanner = document.getElementById('mature-banner');
if (_recentBanner) _recentBanner.textContent = DATA.config.recentBreakoutDays;
if (_matureBanner) _matureBanner.textContent = DATA.config.matureLookaheadDays;

const tiles = [
  { cls: 'primary', label: '분석 기간', value: fmtDate(DATA.meta.from) + '~' + fmtDate(DATA.meta.to).slice(5), sub: DATA.config.tradingDatesInRange.length + '일' },
  { cls: 'primary', label: '보드 노출 기준 사례', value: DATA.boardExposureSummary.totalCandidates, sub: '검증 ' + DATA.boardExposureSummary.verifiedCount + '건' },
  { cls: 'primary', label: '이벤트 기준 사례', value: DATA.eventBasedSummary.totalEvents, sub: '중복 제거율 ' + (DATA.eventBasedSummary.dedupRate ?? 0) + '%' },
  { cls: 'success', label: 'H그룹 평균 다음날 고가', value: DATA.boardExposureSummary.avgHigh != null ? (DATA.boardExposureSummary.avgHigh > 0 ? '+' : '') + DATA.boardExposureSummary.avgHigh.toFixed(2) + '%' : '-' },
  { cls: 'success', label: '눌림대기 평균 다음날 고가', value: DATA.boardExposureSummary.pwaitAvgHigh != null ? (DATA.boardExposureSummary.pwaitAvgHigh > 0 ? '+' : '') + DATA.boardExposureSummary.pwaitAvgHigh.toFixed(2) + '%' : '-', sub: 'n=' + DATA.boardExposureSummary.pwaitCount },
  { cls: 'success', label: '눌림대기+VPR성공 평균 고가', value: DATA.boardExposureSummary.pwaitVprSuccAvgHigh != null ? (DATA.boardExposureSummary.pwaitVprSuccAvgHigh > 0 ? '+' : '') + DATA.boardExposureSummary.pwaitVprSuccAvgHigh.toFixed(2) + '%' : '-' },
  { cls: 'fail', label: '구조 훼손 -3% 종가', value: DATA.boardExposureSummary.structMinus3Rate != null ? DATA.boardExposureSummary.structMinus3Rate + '%' : '-', sub: 'n=' + DATA.boardExposureSummary.structCount },
  { cls: 'warn', label: '중복 제거율', value: (DATA.eventBasedSummary.dedupRate ?? 0) + '%' },
];
document.getElementById('big-summary').innerHTML = tiles.map(t =>
  '<div class="big-tile ' + t.cls + '">' +
    '<div class="label">' + t.label + '</div>' +
    '<div class="value">' + t.value + '</div>' +
    (t.sub ? '<div class="sub">' + t.sub + '</div>' : '') +
  '</div>'
).join('');

// ─── 일자별 ───
function dailyTable(rows) {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>날짜</th>', '<th>H그룹 수</th>', '<th>눌림 대기</th>', '<th>구조 훼손</th>',
    '<th>다음날 평균 종가↑</th>', '<th>다음날 평균 고가↑</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    html.push('<tr>' +
      '<td>' + fmtDate(r.date) + '</td>' +
      '<td>' + r.count + '</td>' +
      '<td>' + (r.pwaitCount ?? '-') + '</td>' +
      '<td>' + (r.structuralCount ?? '-') + '</td>' +
      '<td>' + fmtPct(r.avgClose) + '</td>' +
      '<td>' + fmtPct(r.avgHigh) + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('daily-results-table').innerHTML = dailyTable(DATA.dailyResults);

function perfTable(rows, highlightKeys = []) {
  if (!rows || rows.length === 0) return '<p style="color:#64748b;">사례 없음.</p>';
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>그룹</th>', '<th>n</th>', '<th>평균 종가↑</th>', '<th>중앙 종가↑</th>',
    '<th>평균 고가↑</th>', '<th>중앙 고가↑</th>', '<th>평균 저가↓</th>',
    '<th>+3% 종가</th>', '<th>+5% 고가</th>', '<th>+10% 고가</th>',
    '<th>-3% 종가</th>', '<th>-5% 저가</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    const hi = highlightKeys.includes(r.key) ? ' class="row-highlight"' : '';
    html.push('<tr' + hi + '>' +
      '<td>' + r.label + '</td>' +
      '<td>' + (r.count ?? '-') + '</td>' +
      '<td>' + fmtPct(r.avgCloseFromCutoff) + '</td>' +
      '<td>' + fmtPct(r.medianCloseFromCutoff) + '</td>' +
      '<td>' + fmtPct(r.avgHighFromCutoff) + '</td>' +
      '<td>' + fmtPct(r.medianHighFromCutoff) + '</td>' +
      '<td>' + fmtPct(r.avgLowFromCutoff) + '</td>' +
      '<td>' + (r.plus3CloseRate != null ? r.plus3CloseRate + '%' : '-') + '</td>' +
      '<td>' + (r.plus5HighRate != null ? r.plus5HighRate + '%' : '-') + '</td>' +
      '<td>' + (r.plus10HighRate != null ? r.plus10HighRate + '%' : '-') + '</td>' +
      '<td>' + (r.minus3CloseRate != null ? r.minus3CloseRate + '%' : '-') + '</td>' +
      '<td>' + (r.minus5LowRate != null ? r.minus5LowRate + '%' : '-') + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('judgment-perf-table').innerHTML = perfTable(DATA.judgmentStatusPerformance, ['PULLBACK_WAIT']);
document.getElementById('vpr-perf-table').innerHTML = perfTable(DATA.vprStatusPerformance, ['CLASSIC_VPR_SUCCESS', 'STRONG_VPR_SUCCESS']);
document.getElementById('combined-perf-table').innerHTML = perfTable(DATA.combinedStatusPerformance.filter(g => g.count > 0), ['PWAIT_VPR_SUCCESS_ANY']);
document.getElementById('event-judgment-table').innerHTML = perfTable(DATA.eventJudgmentPerformance, ['PULLBACK_WAIT']);
document.getElementById('event-vpr-table').innerHTML = perfTable(DATA.eventVprPerformance, ['CLASSIC_VPR_SUCCESS', 'STRONG_VPR_SUCCESS']);

document.getElementById('key-questions').innerHTML =
  (DATA.keyQuestions || []).map(qa =>
    '<div class="qa-block"><div class="q"><strong>Q.</strong> ' + qa.q + '</div><div class="a">→ ' + qa.a + '</div></div>'
  ).join('');

// D+5 / D+10 분포 비교
function distTable(d5, d10, labels) {
  const allKeys = new Set([...d5.map(x => x.status), ...d10.map(x => x.status)]);
  const d5Map = new Map(d5.map(x => [x.status, x.count]));
  const d10Map = new Map(d10.map(x => [x.status, x.count]));
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>분류</th><th>D+5 시점</th><th>D+10 시점 (성숙)</th><th>변화</th>',
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
  '<h3 style="font-size:14px;color:#cbd5e1;">VPR 상태 분포</h3>' +
  distTable(DATA.d5VprDistribution, DATA.d10VprDistribution, DATA.meta.vprLabels) +
  '<h3 style="font-size:14px;color:#cbd5e1;margin-top:14px;">화면 상태 (judgmentStatus) 분포</h3>' +
  distTable(DATA.d5JudgmentDistribution, DATA.d10JudgmentDistribution, DATA.meta.judgmentLabels);

// 전환 매트릭스
function transitionTable(rows, fromLabel, toLabel) {
  if (!rows || rows.length === 0) return '<p style="color:#64748b;">전환 사례 없음.</p>';
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>D+5 ' + fromLabel + '</th><th>→ D+10 ' + toLabel + '</th><th>건수</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    html.push('<tr><td>' + r.fromLabel + '</td><td>' + r.toLabel + '</td><td>' + r.count + '건</td></tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('d5-d10-vpr-transition').innerHTML = transitionTable(DATA.d5ToD10VprTransition, 'VPR', 'VPR');
document.getElementById('d5j-d10v-transition').innerHTML = transitionTable(DATA.d5JudgmentToD10VprTransition, '화면 상태', 'VPR');

// D+10 VPR 그룹별 H+10 성과
const h10Perf = DATA.d10H10Performance;
function h10PerfTable(perf) {
  const order = ['all', 'strong', 'classic', 'weak', 'pending', 'runaway', 'structural', 'reboundFail'];
  const highlight = new Set(['strong', 'classic', 'structural']);
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>그룹</th><th>n</th>', '<th>평균 H+10 고가↑</th>', '<th>중앙 H+10 고가↑</th>',
    '<th>평균 H+10 종가↑</th>', '<th>평균 최저 저가↓</th>',
    '<th>+10% 고가</th>', '<th>+20% 고가</th>',
    '<th>-5% 종가</th>', '<th>-10% 종가</th>',
    '</tr></thead><tbody>'];
  for (const k of order) {
    const g = perf[k];
    if (!g || g.count === 0) continue;
    const cls = highlight.has(k) ? ' class="row-highlight"' : '';
    html.push('<tr' + cls + '><td>' + g.label + '</td>' +
      '<td>' + g.count + '</td>' +
      '<td>' + fmtPct(g.avgMaxHigh) + '</td>' +
      '<td>' + fmtPct(g.medianMaxHigh) + '</td>' +
      '<td>' + fmtPct(g.avgCloseN) + '</td>' +
      '<td>' + fmtPct(g.avgMinLow) + '</td>' +
      '<td>' + (g.plus10HighRate != null ? g.plus10HighRate + '%' : '-') + '</td>' +
      '<td>' + (g.plus20HighRate != null ? g.plus20HighRate + '%' : '-') + '</td>' +
      '<td>' + (g.minus5CloseRate != null ? g.minus5CloseRate + '%' : '-') + '</td>' +
      '<td>' + (g.minus10CloseRate != null ? g.minus10CloseRate + '%' : '-') + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}
document.getElementById('d10-h10-perf').innerHTML = h10PerfTable(h10Perf);

// 전환 질문
document.getElementById('transition-questions').innerHTML =
  (DATA.transitionQuestions || []).map(qa =>
    '<div class="qa-block"><div class="q"><strong>•</strong> ' + qa.q + '</div><div class="a">→ ' + qa.a + '</div></div>'
  ).join('');

document.getElementById('conclusion').innerHTML =
  '<ul>' + (DATA.conclusion || []).map(c => '<li>' + c + '</li>').join('') + '</ul>';

// 탭
const TAB_DEF = [
  { key: 'all', label: '전체', filter: c => c.returns != null },
  { key: 'pwait', label: '눌림 대기', filter: c => c.judgmentStatus === 'PULLBACK_WAIT' },
  { key: 'pwait_succ', label: '눌림대기 + VPR 성공', filter: c => c.judgmentStatus === 'PULLBACK_WAIT' && (c.vprStatus === 'CLASSIC_VPR_SUCCESS' || c.vprStatus === 'STRONG_VPR_SUCCESS') },
  { key: 'pending', label: 'VPR 대기', filter: c => c.vprStatus === 'PULLBACK_PENDING' },
  { key: 'runaway', label: '눌림 없이 상승', filter: c => c.vprStatus === 'NO_PULLBACK_RUNAWAY' },
  { key: 'weak', label: '재돌파 약함', filter: c => c.vprStatus === 'WEAK_VPR_REBOUND' },
  { key: 'broken', label: '구조 훼손', filter: c => c.vprStatus === 'STRUCTURAL_BREAK' },
  { key: 'mgmt', label: '관리 구간', filter: c => c.judgmentStatus === 'MANAGEMENT' },
  { key: 'bweak', label: '돌파 악화', filter: c => c.judgmentStatus === 'BREAKDOWN_WEAK' },
];
let currentTab = 'all';
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
      return (b.returns?.closeFromCutoff ?? -Infinity) - (a.returns?.closeFromCutoff ?? -Infinity);
    });
  const html = filtered.map((c, i) => {
    return '<tr class="row">' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + fmtDate(c.cutoffDate) + '</td>' +
      '<td class="col-mobile-hide">' + fmtDate(c.targetDate) + '</td>' +
      '<td class="col-name">' + c.name + '<span class="meta">' + c.code + ' · ' + (c.market || '-') + '</span></td>' +
      '<td class="col-mobile-hide">' + fmtDate(c.qvaDate) + '</td>' +
      '<td class="col-mobile-hide">' + fmtDate(c.vviDate) + '</td>' +
      '<td class="col-mobile-hide">' + fmtDate(c.hDate) + '</td>' +
      '<td>' + (c.judgmentStatus
        ? '<span class="status-pill ' + c.judgmentStatus + '">' + (c.judgmentLabel || c.judgmentStatus) + '</span>'
        : '-') + '</td>' +
      '<td><span class="vpr-pill ' + (c.vprStatus || 'DATA_INSUFFICIENT') + '">' + (c.vprLabel || '-') + '</span></td>' +
      '<td class="numeric col-mobile-hide">' + (c.cutoffClose != null ? c.cutoffClose.toLocaleString() : '-') + '</td>' +
      '<td class="numeric">' + fmtPct(c.returns?.closeFromCutoff) + '</td>' +
      '<td class="numeric col-mobile-hide">' + fmtPct(c.returns?.highFromCutoff) + '</td>' +
      '<td class="numeric col-mobile-hide">' + fmtPct(c.returns?.lowFromCutoff) + '</td>' +
      '<td class="numeric col-mobile-hide">' + (c.exposureIndex || 1) + '회차</td>' +
      '<td class="col-summary">' + (c.oneLineSummary || '-') + '</td>' +
      '</tr>';
  }).join('');
  document.getElementById('list-body').innerHTML = html ||
    '<tr><td colspan="15" style="padding:20px; text-align:center; color:#64748b;">표시할 사례가 없습니다.</td></tr>';
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
