#!/usr/bin/env node
/**
 * 1DS BIG RUNNER 감사 보고서 (one-day-surge-big-runner-audit-report.js)
 *
 * 목적:
 *   기존 1DS 후보 중 당일 +10%, +15%, +20% 이상 크게 간 종목들이
 *   09:00~10:00 구간에 어떤 공통점을 가졌는지 분석한다.
 *
 *   "안전한 압축 필터"가 아니라 "큰 상승 가능성" 관점.
 *   QVA2는 보조 태그일 뿐, 핵심은 기존 1DS 안의 BIG RUNNER 공통점.
 *
 * 절대 수정하지 않는다:
 *   - 기존 1DS / QVA / QVA2 / VVI / H그룹 보드 + 라우터
 *   - 기존 검증/감사 보고서
 *   - 운영 보드 만들지 않음. 이 파일은 분석 보고서.
 *
 * 생성 파일:
 *   - boards/oneDaySurge/one-day-surge-big-runner-audit-report.js (이 파일)
 *   - reports/one-day-surge-big-runner-audit-result.json
 *   - reports/one-day-surge-big-runner-audit-result.html
 *
 * 실행:
 *   node boards/oneDaySurge/one-day-surge-big-runner-audit-report.js
 *   node boards/oneDaySurge/one-day-surge-big-runner-audit-report.js --days 60
 *   node boards/oneDaySurge/one-day-surge-big-runner-audit-report.js --days 20
 *   node boards/oneDaySurge/one-day-surge-big-runner-audit-report.js --from 2026-04-01 --to 2026-05-15
 *   node boards/oneDaySurge/one-day-surge-big-runner-audit-report.js --date 2026-05-15
 *
 * 조건 산정 방식 (감사 보고서 관점):
 *   - 거래대금/재돌파/위치 분류는 09:00~10:00 전체 morning 데이터로 계산 (사후 묘사)
 *   - decisionTime은 entry price 기준만 변경 (post-decision 구간을 재는 시작점)
 *   - 따라서 "조건 X가 사전에 알 수 있었는가"는 운영보드의 영역. 이 보고서는 묘사형.
 *
 * 매수 추천 아님. "큰 상승 종목의 공통점"을 찾는 분석.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const CHART_DIR     = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST    = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const STOCKS_PATH   = path.join(ROOT, 'stocks.json');
const REPORTS_DIR   = path.join(ROOT, 'reports');
const OUT_JSON      = path.join(REPORTS_DIR, 'one-day-surge-big-runner-audit-result.json');
const OUT_HTML      = path.join(REPORTS_DIR, 'one-day-surge-big-runner-audit-result.html');

// QVA/QVA2 보조 태그용 (있으면 사용, 없으면 skip)
const QVA_WATCH_JSON  = path.join(ROOT, 'qva-watchlist-board.json');
const QVA2_WATCH_JSON = path.join(REPORTS_DIR, 'qva2-watchlist-board.json');

const DECISION_TIMES = ['09:30', '09:45', '10:00'];

// ─────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { date: null, from: null, to: null, days: null, sampleLimit: 30 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--date') a.date = argv[++i];
    else if (k === '--from') a.from = argv[++i];
    else if (k === '--to') a.to = argv[++i];
    else if (k === '--days') a.days = parseInt(argv[++i], 10);
    else if (k === '--sample-limit') a.sampleLimit = parseInt(argv[++i], 10) || 30;
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node one-day-surge-big-runner-audit-report.js [--date Y-M-D | --from Y-M-D --to Y-M-D | --days N]');
      process.exit(0);
    }
  }
  return a;
}

// ─────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────
function safeNum(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function safePct(num, den, digits = 2) {
  const n = safeNum(num), d = safeNum(den);
  if (n == null || d == null || d === 0) return null;
  return Number(((n / d - 1) * 100).toFixed(digits));
}
function safeDiv(num, den, digits = 3) {
  const n = safeNum(num), d = safeNum(den);
  if (n == null || d == null || d === 0) return null;
  return Number((n / d).toFixed(digits));
}
function avg(arr) {
  const xs = arr.filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
function median(arr) {
  const xs = arr.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
}
function rate(n, total, digits = 1) { return (total > 0) ? Number((n / total * 100).toFixed(digits)) : null; }
function round(x, digits = 2) { return (x == null || !Number.isFinite(x)) ? null : Number(x.toFixed(digits)); }
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function dashToNum(s) { return String(s || '').replace(/-/g, ''); }

// ─────────────────────────────────────────────────────────────────
// 메타 + 차트
// ─────────────────────────────────────────────────────────────────
function loadMetaMap() {
  const map = new Map();
  if (fs.existsSync(STOCKS_PATH)) {
    try {
      const j = JSON.parse(fs.readFileSync(STOCKS_PATH, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (s.shortCode) map.set(s.shortCode, { name: s.name, market: s.market });
      }
    } catch (_) {}
  }
  if (fs.existsSync(NAVER_LIST)) {
    try {
      const j = JSON.parse(fs.readFileSync(NAVER_LIST, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (!s.code) continue;
        const cur = map.get(s.code) || {};
        map.set(s.code, { ...cur, name: s.name || cur.name, market: s.market || cur.market,
          marketCap: s.marketValue || 0 });
      }
    } catch (_) {}
  }
  return map;
}
const chartCache = new Map();
function loadDailyChart(code) {
  if (chartCache.has(code)) return chartCache.get(code);
  const p = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(p)) { chartCache.set(code, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const rows = Array.isArray(j.rows) ? j.rows : null;
    chartCache.set(code, rows);
    return rows;
  } catch (_) { chartCache.set(code, null); return null; }
}
function findDailyExtended(rows, signalDateDash) {
  if (!Array.isArray(rows) || rows.length === 0) return { dRow: null, d1Row: null, d2Row: null, d3Row: null, dM1Row: null, idx: -1 };
  const target = dashToNum(signalDateDash);
  const idx = rows.findIndex((r) => r.date === target);
  if (idx < 0) return { dRow: null, d1Row: null, d2Row: null, d3Row: null, dM1Row: null, idx: -1 };
  return {
    idx,
    dRow:   rows[idx],
    d1Row:  idx + 1 < rows.length ? rows[idx + 1] : null,
    d2Row:  idx + 2 < rows.length ? rows[idx + 2] : null,
    d3Row:  idx + 3 < rows.length ? rows[idx + 3] : null,
    dM1Row: idx - 1 >= 0           ? rows[idx - 1] : null,
  };
}
// 20일 최고가 (D 포함 X — 사전 알 수 있는 정보)
function recentHigh20(rows, idx) {
  if (!Array.isArray(rows) || idx < 1) return null;
  const start = Math.max(0, idx - 20);
  let max = -Infinity;
  for (let i = start; i < idx; i++) {
    if (Number.isFinite(rows[i]?.high) && rows[i].high > max) max = rows[i].high;
  }
  return max === -Infinity ? null : max;
}

// ─────────────────────────────────────────────────────────────────
// 거래일 인덱스 (eligible 기간 추출용)
// ─────────────────────────────────────────────────────────────────
function buildTradingDates() {
  const candidates = ['000020', '000080', '000500', '005930'];
  for (const code of candidates) {
    const rows = loadDailyChart(code);
    if (rows && rows.length > 200) return rows.map((r) => r.date);
  }
  const files = fs.existsSync(CHART_DIR) ? fs.readdirSync(CHART_DIR).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) {
    const rows = loadDailyChart(f.replace('.json', ''));
    if (rows && rows.length > 200) return rows.map((r) => r.date);
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────
// QVA/QVA2 보조 태그 인덱스 (있으면 사용)
// ─────────────────────────────────────────────────────────────────
function loadAuxQvaIndex() {
  const qva = new Map();   // code → Set(dateNum)
  const qva2 = new Map();
  function pushDate(map, code, date) {
    if (!code || !date) return;
    const dnum = dashToNum(date);
    if (!/^\d{8}$/.test(dnum)) return;
    if (!map.has(code)) map.set(code, new Set());
    map.get(code).add(dnum);
  }
  function ingestQva(j) {
    if (!j || !j.stages) return;
    for (const arr of Object.values(j.stages)) {
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        if (!it || !it.code) continue;
        if (it.qvaSignalDate)       pushDate(qva, it.code, it.qvaSignalDate);
        if (it.firstEarlyQvaDate)   pushDate(qva, it.code, it.firstEarlyQvaDate);
        if (it.bestEarlyQvaDate)    pushDate(qva, it.code, it.bestEarlyQvaDate);
        if (it.latestEarlyQvaDate)  pushDate(qva, it.code, it.latestEarlyQvaDate);
      }
    }
  }
  function ingestQva2(j) {
    if (!j) return;
    (function walk(o) {
      if (!o) return;
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (typeof o !== 'object') return;
      if (o.code && (o.qva2SignalDate || o.firstQva2Date || o.bestQva2Date || o.latestQva2Date || o.qvaSignalDate)) {
        pushDate(qva2, o.code, o.qva2SignalDate || o.firstQva2Date || o.bestQva2Date || o.latestQva2Date || o.qvaSignalDate);
      }
      for (const v of Object.values(o)) walk(v);
    })(j);
  }
  if (fs.existsSync(QVA_WATCH_JSON))  { try { ingestQva(JSON.parse(fs.readFileSync(QVA_WATCH_JSON,  'utf-8'))); } catch (_) {} }
  if (fs.existsSync(QVA2_WATCH_JSON)) { try { ingestQva2(JSON.parse(fs.readFileSync(QVA2_WATCH_JSON, 'utf-8'))); } catch (_) {} }
  return { qva, qva2 };
}
function hasRecentSetup(map, code, signalDateNum, withinDays) {
  const dates = map.get(code);
  if (!dates) return false;
  const sigD = new Date(signalDateNum.slice(0, 4) + '-' + signalDateNum.slice(4, 6) + '-' + signalDateNum.slice(6, 8));
  for (const d of dates) {
    const dd = new Date(d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8));
    const diff = (sigD - dd) / (1000 * 60 * 60 * 24);
    if (diff > 0 && diff <= withinDays * 1.5) return true; // 캘린더 일수 ≈ 거래일수 × 1.5 보정
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────
// 분봉 로딩
// ─────────────────────────────────────────────────────────────────
function load1dsCandidatesByDate(dateDash) {
  const dir = path.join(INTRADAY_BASE, dateDash);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}
function loadMinuteData(dateDash, code) {
  const p = path.join(INTRADAY_BASE, dateDash, code + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────
// decisionTime snapshot
// ─────────────────────────────────────────────────────────────────
function getDecisionSnapshot(bars, decisionTime) {
  if (!Array.isArray(bars)) return null;
  const upto = bars.filter((b) => b && b.time && b.time <= decisionTime && Number.isFinite(b.close));
  if (upto.length < 3) return null;
  const open0900 = upto[0].open != null ? upto[0].open : upto[0].close;
  const decisionPrice = upto[upto.length - 1].close;
  const high = Math.max(...upto.map((b) => b.high).filter(Number.isFinite));
  const low  = Math.min(...upto.map((b) => b.low ).filter(Number.isFinite));
  let cv = 0, cvol = 0;
  for (const b of upto) { cv += b.value || 0; cvol += b.volume || 0; }
  return {
    decisionTime, decisionPrice, open0900,
    highSoFar: high, lowSoFar: low,
    vwap: cvol > 0 ? round(cv / cvol, 2) : null,
    cumValueSoFar: cv, cumVolumeSoFar: cvol,
    barCount: upto.length,
  };
}

// ─────────────────────────────────────────────────────────────────
// 거래대금 흐름 (분봉 segment)
// ─────────────────────────────────────────────────────────────────
function calculateValueFlow(bars) {
  function sumIn(min, max) {
    let value = 0, volume = 0, n = 0;
    for (const b of bars) {
      if (!b || !b.time) continue;
      if (b.time < min || b.time >= max) continue;
      // value 필드 우선, 없으면 close × volume 추정
      const v = (b.value != null) ? b.value : ((b.close || 0) * (b.volume || 0));
      value  += v || 0;
      volume += b.volume || 0;
      n++;
    }
    return { value, volume, barCount: n };
  }
  function sumInIncl(min, max) {
    // max inclusive (e.g. '10:00' 포함)
    let value = 0, volume = 0, n = 0;
    for (const b of bars) {
      if (!b || !b.time) continue;
      if (b.time < min || b.time > max) continue;
      const v = (b.value != null) ? b.value : ((b.close || 0) * (b.volume || 0));
      value  += v || 0;
      volume += b.volume || 0;
      n++;
    }
    return { value, volume, barCount: n };
  }
  const s0900_0910 = sumIn('09:00', '09:10');
  const s0910_0920 = sumIn('09:10', '09:20');
  const s0920_0930 = sumIn('09:20', '09:30');
  const s0930_0945 = sumIn('09:30', '09:45');
  const s0945_1000 = sumInIncl('09:45', '10:00');
  const s0900_0930 = sumIn('09:00', '09:30');
  const s0930_1000 = sumInIncl('09:30', '10:00');
  const s0900_1000 = sumInIncl('09:00', '10:00');

  return {
    value_0900_0910: s0900_0910.value, value_0910_0920: s0910_0920.value, value_0920_0930: s0920_0930.value,
    value_0930_0945: s0930_0945.value, value_0945_1000: s0945_1000.value,
    value_0900_0930: s0900_0930.value, value_0930_1000: s0930_1000.value, value_0900_1000: s0900_1000.value,
    volume_0900_1000: s0900_1000.volume,
    valueContinueRatio:    safeDiv(s0930_1000.value, s0900_0930.value, 3),
    valueSecondWaveRatio:  safeDiv(s0945_1000.value, s0930_0945.value, 3),
    valueAccel_0930_0945:  safeDiv(s0930_0945.value, s0920_0930.value, 3),
    valueAccel_0945_1000:  safeDiv(s0945_1000.value, s0930_0945.value, 3),
  };
}

// ─────────────────────────────────────────────────────────────────
// 장초 고가 재돌파 분석
// ─────────────────────────────────────────────────────────────────
function calculateHighRebreak(bars, valueFlow) {
  function maxHigh(min, max, inclusive = false) {
    let max_h = -Infinity;
    for (const b of bars) {
      if (!b || !b.time) continue;
      if (b.time < min) continue;
      if (inclusive ? b.time > max : b.time >= max) continue;
      if (Number.isFinite(b.high) && b.high > max_h) max_h = b.high;
    }
    return max_h === -Infinity ? null : max_h;
  }
  function minLow(min, max, inclusive = false) {
    let min_l = Infinity;
    for (const b of bars) {
      if (!b || !b.time) continue;
      if (b.time < min) continue;
      if (inclusive ? b.time > max : b.time >= max) continue;
      if (Number.isFinite(b.low) && b.low < min_l) min_l = b.low;
    }
    return min_l === Infinity ? null : min_l;
  }
  const firstHigh   = maxHigh('09:00', '09:20');
  const morningHigh = maxHigh('09:00', '09:30');
  const pullbackLow = minLow('09:20', '09:40');
  const high_0940_1000 = maxHigh('09:40', '10:00', true);
  const last_1000      = (() => {
    const lastBar = bars.filter((b) => b && b.time && b.time <= '10:00' && Number.isFinite(b.close)).slice(-1)[0];
    return lastBar ? lastBar.close : null;
  })();
  const rebreakMorningHigh = (high_0940_1000 != null && morningHigh != null) && high_0940_1000 > morningHigh;
  const rebreakFirstHigh   = (high_0940_1000 != null && firstHigh != null)   && high_0940_1000 > firstHigh;
  const rebreakWithValue = rebreakMorningHigh
    && valueFlow.valueSecondWaveRatio != null && valueFlow.valueSecondWaveRatio >= 1.0;
  const rebreakAndHold = rebreakMorningHigh
    && last_1000 != null && morningHigh != null && last_1000 >= morningHigh;
  return {
    firstHigh_0900_0920: firstHigh,
    morningHigh_0900_0930: morningHigh,
    pullbackLow_0920_0940: pullbackLow,
    high_0940_1000,
    last_at_1000: last_1000,
    rebreakMorningHigh_0940_1000: rebreakMorningHigh,
    rebreakFirstHigh_0940_1000: rebreakFirstHigh,
    rebreakWithValue, rebreakAndHold,
  };
}

// ─────────────────────────────────────────────────────────────────
// 가격 위치 (decisionTime 기준)
// ─────────────────────────────────────────────────────────────────
function calculatePricePosition(snap, prevClose, rebreak, dailyExt) {
  const dp = snap.decisionPrice;
  const open = snap.open0900;
  const decisionFromPrevClose = (dp && prevClose) ? round(((dp / prevClose) - 1) * 100, 2) : null;
  const decisionFromOpen      = (dp && open) ? round(((dp / open) - 1) * 100, 2) : null;
  const decisionFromMorningLow  = (dp && snap.lowSoFar)  ? round(((dp / snap.lowSoFar)  - 1) * 100, 2) : null;
  const decisionFromMorningHigh = (dp && snap.highSoFar) ? round(((dp / snap.highSoFar) - 1) * 100, 2) : null;
  const gapRate = (open && prevClose) ? round(((open / prevClose) - 1) * 100, 2) : null;
  const range = (snap.highSoFar && snap.lowSoFar)
    ? round(((snap.highSoFar / snap.lowSoFar) - 1) * 100, 2) : null;
  const upperWickSoFar = (snap.highSoFar && dp && open)
    ? round(((snap.highSoFar - Math.max(open, dp)) / Math.max(snap.highSoFar - snap.lowSoFar, 1)), 3)
    : null;
  // 전일 high (dM1)
  const prevHigh = dailyExt.dM1Row ? safeNum(dailyExt.dM1Row.high) : null;
  const distanceToPrevHigh = (dp && prevHigh) ? round(((dp / prevHigh) - 1) * 100, 2) : null;
  // 20일 고가 (D 이전)
  const high20 = (dailyExt.idx > 0) ? recentHigh20(loadDailyChart(dailyExt._code || ''), dailyExt.idx) : null;
  const distanceToRecentHigh20 = (dp && high20) ? round(((dp / high20) - 1) * 100, 2) : null;
  const pricePositionInMorningRange = (snap.highSoFar && snap.lowSoFar && dp && snap.highSoFar !== snap.lowSoFar)
    ? round((dp - snap.lowSoFar) / (snap.highSoFar - snap.lowSoFar), 3) : null;
  return {
    decisionFromPrevClose, decisionFromOpen,
    decisionFromMorningLow, decisionFromMorningHigh,
    gapRate, intradayRangeRate_0900_decision: range,
    upperWickSoFar,
    prevHigh, distanceToPrevHigh,
    high20, distanceToRecentHigh20,
    pricePositionInMorningRange,
  };
}

// ─────────────────────────────────────────────────────────────────
// outcome 계산
// ─────────────────────────────────────────────────────────────────
function calculateOutcomesFromDecision(bars, decisionTime, decisionPrice, dailyExt) {
  if (!decisionPrice || !Array.isArray(bars)) return null;
  // pre-decision max (lookahead 판정용)
  const pre = bars.filter((b) => b && b.time && b.time <= decisionTime && Number.isFinite(b.high));
  const preMaxHigh = pre.length ? Math.max(...pre.map((b) => b.high)) : -Infinity;
  const preMinLow  = pre.length ? Math.min(...pre.map((b) => b.low).filter(Number.isFinite)) : Infinity;
  // post-window minute bars
  const post = bars.filter((b) => b && b.time && b.time > decisionTime && Number.isFinite(b.close));
  let inHigh = -Infinity, inLow = Infinity;
  const up3 = decisionPrice * 1.03, dn3 = decisionPrice * 0.97;
  const up5 = decisionPrice * 1.05, dn5 = decisionPrice * 0.95;
  let upIdx3 = -1, dnIdx3 = -1, upIdx5 = -1, dnIdx5 = -1;
  for (let i = 0; i < post.length; i++) {
    const b = post[i];
    if (Number.isFinite(b.high) && b.high > inHigh) inHigh = b.high;
    if (Number.isFinite(b.low)  && b.low  < inLow)  inLow  = b.low;
    if (upIdx3 < 0 && b.high >= up3) upIdx3 = i;
    if (dnIdx3 < 0 && b.low  <= dn3) dnIdx3 = i;
    if (upIdx5 < 0 && b.high >= up5) upIdx5 = i;
    if (dnIdx5 < 0 && b.low  <= dn5) dnIdx5 = i;
  }
  // 가격 sanity
  const { dRow, d1Row, d2Row, d3Row } = dailyExt;
  let priceMismatch = false;
  if (dRow && bars[0] && bars[0].open && dRow.open) {
    const r = dRow.open / bars[0].open;
    if (r > 1.5 || r < 0.67) priceMismatch = true;
  }
  const sd  = priceMismatch ? null : dRow;
  const sd1 = priceMismatch ? null : d1Row;
  const sd2 = priceMismatch ? null : d2Row;
  const sd3 = priceMismatch ? null : d3Row;

  const dailyHigh  = sd ? sd.high  : null;
  const dailyLow   = sd ? sd.low   : null;
  const dailyClose = sd ? sd.close : null;
  let postDayHigh = inHigh, postDayLow = inLow;
  if (dailyHigh != null && dailyHigh > preMaxHigh) postDayHigh = Math.max(postDayHigh, dailyHigh);
  if (dailyLow  != null && dailyLow  < preMinLow ) postDayLow  = Math.min(postDayLow,  dailyLow);
  if (postDayHigh === -Infinity) postDayHigh = null;
  if (postDayLow  === Infinity)  postDayLow  = null;

  const d1High = sd1 ? sd1.high : null;
  const d1Close = sd1 ? sd1.close : null;
  const d2High = sd2 ? sd2.high : null;
  const d3High = sd3 ? sd3.high : null;
  const maxD3 = Math.max(postDayHigh || 0, d1High || 0, d2High || 0, d3High || 0);

  function pct(v) { return (v != null && decisionPrice) ? round((v / decisionPrice - 1) * 100, 2) : null; }

  const dayHighReturn  = pct(postDayHigh);
  const dayCloseReturn = pct(dailyClose);
  const d1HighReturn   = pct(d1High);
  const d1CloseReturn  = pct(d1Close);
  const d3MaxReturn    = decisionPrice ? round((maxD3 / decisionPrice - 1) * 100, 2) : null;

  const reachedPlus3   = postDayHigh != null && postDayHigh >= up3;
  const reachedPlus5   = postDayHigh != null && postDayHigh >= up5;
  const reachedPlus10  = postDayHigh != null && postDayHigh >= decisionPrice * 1.10;
  const reachedPlus15  = postDayHigh != null && postDayHigh >= decisionPrice * 1.15;
  const reachedPlus20  = postDayHigh != null && postDayHigh >= decisionPrice * 1.20;
  const reachedPlus25  = postDayHigh != null && postDayHigh >= decisionPrice * 1.25;
  const reachedMinus3  = postDayLow  != null && postDayLow  <= dn3;
  const reachedMinus5  = postDayLow  != null && postDayLow  <= dn5;

  const reachedPlus5_byD1  = decisionPrice && (postDayHigh != null || d1High != null)
    ? Math.max(postDayHigh || 0, d1High || 0) >= up5 : null;
  const reachedPlus10_byD1 = decisionPrice && (postDayHigh != null || d1High != null)
    ? Math.max(postDayHigh || 0, d1High || 0) >= decisionPrice * 1.10 : null;
  const reachedPlus5_byD3  = decisionPrice ? maxD3 >= up5 : null;
  const reachedPlus10_byD3 = decisionPrice ? maxD3 >= decisionPrice * 1.10 : null;
  const reachedPlus15_byD3 = decisionPrice ? maxD3 >= decisionPrice * 1.15 : null;

  function order(upI, dnI) {
    if (upI < 0 && dnI < 0) return 'neither';
    if (upI >= 0 && (dnI < 0 || upI < dnI)) return 'plus_first';
    if (dnI >= 0 && (upI < 0 || dnI < upI)) return 'minus_first';
    return 'unavailable';
  }
  const order3 = order(upIdx3, dnIdx3);
  const order5 = order(upIdx5, dnIdx5);

  const highCloseDrop = (postDayHigh && dailyClose) ? round((dailyClose / postDayHigh - 1) * 100, 2) : null;
  return {
    priceMismatch,
    decisionPrice, postDayHigh, postDayLow, dailyClose,
    d1High, d1Close, d2High, d3High, maxD3,
    dayHighReturn, dayCloseReturn, d1HighReturn, d1CloseReturn, d3MaxReturn,
    reachedPlus3, reachedPlus5, reachedPlus10, reachedPlus15, reachedPlus20, reachedPlus25,
    reachedMinus3, reachedMinus5,
    reachedPlus5_byD1, reachedPlus10_byD1,
    reachedPlus5_byD3, reachedPlus10_byD3, reachedPlus15_byD3,
    plusMinus_order_3pct: order3,
    plusMinus_order_5pct: order5,
    highCloseDrop,
    inWindowPostBarCount: post.length,
  };
}

// ─────────────────────────────────────────────────────────────────
// outcome 그룹 (BIG10/BIG15/BIG20 등) — 중복 가능
// ─────────────────────────────────────────────────────────────────
function assignOutcomeGroups(outcomes) {
  const g = ['BASE_1DS'];
  if (!outcomes) return g;
  if (outcomes.reachedPlus10) g.push('BIG10');
  if (outcomes.reachedPlus15) g.push('BIG15');
  if (outcomes.reachedPlus20) g.push('BIG20');
  if (outcomes.reachedPlus25) g.push('LIMIT_NEAR');
  if (outcomes.dayCloseReturn != null && outcomes.dayCloseReturn >= 5) g.push('STRONG_CLOSE');
  if (outcomes.reachedPlus5
      && (outcomes.dayCloseReturn != null
          && (outcomes.dayCloseReturn < 0 || (outcomes.highCloseDrop != null && outcomes.highCloseDrop <= -7)))) {
    g.push('SPIKE_FADE');
  }
  if (outcomes.reachedPlus3 === false && outcomes.plusMinus_order_3pct === 'minus_first') {
    g.push('FAILED_SPIKE');
  }
  return g;
}

// ─────────────────────────────────────────────────────────────────
// 조건 그룹 (sample-level filter)
// ─────────────────────────────────────────────────────────────────
function assignConditionGroups(entry, valueFlow, rebreak, position, totalValueRank) {
  const g = [];
  // 거래대금 조건
  if (valueFlow.valueContinueRatio   != null && valueFlow.valueContinueRatio   >= 0.5) g.push('VALUE_CONTINUED');
  if (valueFlow.valueContinueRatio   != null && valueFlow.valueContinueRatio   >= 0.8) g.push('VALUE_STRONG_CONTINUED');
  if (valueFlow.valueSecondWaveRatio != null && valueFlow.valueSecondWaveRatio >= 1.2) g.push('SECOND_WAVE_VALUE');
  // 재돌파 조건
  if (rebreak.rebreakMorningHigh_0940_1000) g.push('HIGH_REBREAK');
  if (rebreak.rebreakWithValue)              g.push('REBREAK_WITH_VALUE');
  if (rebreak.rebreakMorningHigh_0940_1000 && valueFlow.valueContinueRatio != null && valueFlow.valueContinueRatio >= 0.5)
    g.push('HIGH_REBREAK_VALUE');
  if (rebreak.rebreakMorningHigh_0940_1000 && valueFlow.valueContinueRatio != null && valueFlow.valueContinueRatio >= 0.8)
    g.push('HIGH_REBREAK_STRONG_VALUE');
  if (rebreak.rebreakMorningHigh_0940_1000 && valueFlow.valueSecondWaveRatio != null && valueFlow.valueSecondWaveRatio >= 1.2)
    g.push('SECOND_WAVE_REBREAK');
  if (totalValueRank != null && totalValueRank.topPct <= 10) {
    if (rebreak.rebreakMorningHigh_0940_1000) g.push('BIG_MONEY_REBREAK');
    if (valueFlow.valueContinueRatio != null && valueFlow.valueContinueRatio >= 0.5) g.push('BIG_MONEY_CONTINUED');
  }
  // 가격 위치 조건
  if (position.distanceToPrevHigh != null && position.distanceToPrevHigh > 0) g.push('PREV_HIGH_BREAK');
  if (position.pricePositionInMorningRange != null && position.pricePositionInMorningRange >= 0.8) g.push('HIGH_ZONE');
  if (position.decisionFromOpen != null && position.decisionFromOpen >= 5)   g.push('EXTENDED_FROM_OPEN');
  if (position.decisionFromPrevClose != null && position.decisionFromPrevClose >= 10) g.push('VERY_EXTENDED');
  if (position.pricePositionInMorningRange != null && position.pricePositionInMorningRange >= 0.3
      && position.pricePositionInMorningRange <= 0.7
      && position.decisionFromMorningHigh != null && position.decisionFromMorningHigh <= -2) g.push('PULLBACK_ZONE');
  if (position.distanceToRecentHigh20 != null && position.distanceToRecentHigh20 >= -3 && position.distanceToRecentHigh20 <= 5)
    g.push('RECENT_HIGH_NEAR');
  if (position.decisionFromOpen != null && Math.abs(position.decisionFromOpen) <= 2) g.push('NEAR_OPEN');
  // 실패 보조 조건
  if (position.gapRate != null && position.gapRate >= 8) g.push('GAP_OVERHEAT');
  // FIRST_SPIKE_ONLY = 첫 급등은 강했지만 재돌파 없음
  const firstStrong = (rebreak.firstHigh_0900_0920 != null && entry.snap0930?.open0900
    && (rebreak.firstHigh_0900_0920 / entry.snap0930.open0900 - 1) * 100 >= 2);
  if (firstStrong && !rebreak.rebreakMorningHigh_0940_1000) g.push('FIRST_SPIKE_ONLY');
  return g;
}

// ─────────────────────────────────────────────────────────────────
// 실패 패턴 태그
// ─────────────────────────────────────────────────────────────────
function assignFailurePatternTags(entry, valueFlow, rebreak, position) {
  const tags = [];
  const out = entry.outcomesAtDecision['09:30'] || entry.outcomesAtDecision['09:45'] || entry.outcomesAtDecision['10:00'];
  if (!out) return tags;
  // EARLY_BURST_FADE: 09:00~09:20 강하고 이후 거래대금 급감
  const earlyValue = valueFlow.value_0900_0910 + valueFlow.value_0910_0920;
  const midValue   = valueFlow.value_0920_0930 + valueFlow.value_0930_0945;
  if (earlyValue > 0 && midValue / earlyValue < 0.3) tags.push('EARLY_BURST_FADE');
  // NO_VALUE_CONTINUATION
  if (valueFlow.valueContinueRatio != null && valueFlow.valueContinueRatio < 0.3) tags.push('NO_VALUE_CONTINUATION');
  // HIGH_REBREAK_FAIL: 0940_1000 시도했는데 morningHigh 못 넘김
  if (rebreak.high_0940_1000 != null && rebreak.morningHigh_0900_0930 != null
      && rebreak.high_0940_1000 < rebreak.morningHigh_0900_0930
      && rebreak.high_0940_1000 >= rebreak.morningHigh_0900_0930 * 0.985) tags.push('HIGH_REBREAK_FAIL');
  // TOO_EXTENDED_NO_REBREAK
  if (position.decisionFromPrevClose != null && position.decisionFromPrevClose >= 10
      && !rebreak.rebreakMorningHigh_0940_1000) tags.push('TOO_EXTENDED_NO_REBREAK');
  if (position.gapRate != null && position.gapRate >= 8) tags.push('GAP_OVERHEAT');
  if (position.intradayRangeRate_0900_decision != null && position.intradayRangeRate_0900_decision >= 8)
    tags.push('HIGH_VOLATILITY_WICK');
  // CLOSE_WEAK: 종가가 decisionPrice 대비 음봉 또는 고가 대비 -7% 이하
  if (out.dayCloseReturn != null && out.dayCloseReturn < 0) tags.push('CLOSE_WEAK');
  if (out.highCloseDrop != null && out.highCloseDrop <= -7 && !tags.includes('CLOSE_WEAK')) tags.push('CLOSE_WEAK');
  // FIRST_SPIKE_ONLY
  const firstStrong = (rebreak.firstHigh_0900_0920 != null && entry.snap0930?.open0900
    && (rebreak.firstHigh_0900_0920 / entry.snap0930.open0900 - 1) * 100 >= 2);
  if (firstStrong && !rebreak.rebreakMorningHigh_0940_1000) tags.push('FIRST_SPIKE_ONLY');
  return tags;
}

// ─────────────────────────────────────────────────────────────────
// 그룹 통계
// ─────────────────────────────────────────────────────────────────
function groupStats(entries, decisionTime, totalDays, baseline) {
  const n = entries.length;
  const stocks = new Set(entries.map((e) => e.code));
  const outs = entries.map((e) => e.outcomesAtDecision[decisionTime]).filter(Boolean);
  function val(arr, fn) { return arr.map(fn).filter(Number.isFinite); }
  const dh  = val(outs, (o) => o.dayHighReturn);
  const dc  = val(outs, (o) => o.dayCloseReturn);
  const d1h = val(outs, (o) => o.d1HighReturn);
  const d3m = val(outs, (o) => o.d3MaxReturn);
  const hcd = val(outs, (o) => o.highCloseDrop);
  function countTrue(fn) { return outs.filter(fn).length; }
  const valueAvg     = avg(entries.map((e) => e.valueFlow?.value_0900_1000).filter(Number.isFinite));
  const valueContAvg = avg(entries.map((e) => e.valueFlow?.valueContinueRatio).filter(Number.isFinite));
  const valueSWAvg   = avg(entries.map((e) => e.valueFlow?.valueSecondWaveRatio).filter(Number.isFinite));
  const rebreakRate  = rate(entries.filter((e) => e.rebreak?.rebreakMorningHigh_0940_1000).length, n);
  const rebreakWithValueRate = rate(entries.filter((e) => e.rebreak?.rebreakWithValue).length, n);
  const prevHighBreakRate = rate(entries.filter((e) => e.position?.distanceToPrevHigh != null && e.position.distanceToPrevHigh > 0).length, n);

  const s = {
    n, stockCount: stocks.size,
    perDayAvg: totalDays > 0 ? round(n / totalDays, 2) : null,
    plus3_rate:  rate(countTrue((o) => o.reachedPlus3),  outs.length),
    plus5_rate:  rate(countTrue((o) => o.reachedPlus5),  outs.length),
    plus10_rate: rate(countTrue((o) => o.reachedPlus10), outs.length),
    plus15_rate: rate(countTrue((o) => o.reachedPlus15), outs.length),
    plus20_rate: rate(countTrue((o) => o.reachedPlus20), outs.length),
    plus25_rate: rate(countTrue((o) => o.reachedPlus25), outs.length),
    minus3_first_rate: rate(countTrue((o) => o.plusMinus_order_3pct === 'minus_first'), outs.length),
    minus5_first_rate: rate(countTrue((o) => o.plusMinus_order_5pct === 'minus_first'), outs.length),
    avg_dayHighReturn:    round(avg(dh),    2),
    median_dayHighReturn: round(median(dh), 2),
    avg_dayCloseReturn:   round(avg(dc),    2),
    avg_d1HighReturn:     round(avg(d1h),   2),
    avg_d3MaxReturn:      round(avg(d3m),   2),
    avg_highCloseDrop:    round(avg(hcd),   2),
    avgValue_0900_1000:   valueAvg ? Math.round(valueAvg) : null,
    avgValueContinueRatio:   round(valueContAvg, 3),
    avgValueSecondWaveRatio: round(valueSWAvg, 3),
    rebreakRate, rebreakWithValueRate, prevHighBreakRate,
  };
  if (baseline) {
    s.big10_improvement = (s.plus10_rate != null && baseline.plus10_rate != null) ? round(s.plus10_rate - baseline.plus10_rate, 1) : null;
    s.big15_improvement = (s.plus15_rate != null && baseline.plus15_rate != null) ? round(s.plus15_rate - baseline.plus15_rate, 1) : null;
    s.big20_improvement = (s.plus20_rate != null && baseline.plus20_rate != null) ? round(s.plus20_rate - baseline.plus20_rate, 1) : null;
    s.plus5_improvement = (s.plus5_rate  != null && baseline.plus5_rate  != null) ? round(s.plus5_rate  - baseline.plus5_rate,  1) : null;
    s.minus3_reduction  = (s.minus3_first_rate != null && baseline.minus3_first_rate != null) ? round(baseline.minus3_first_rate - s.minus3_first_rate, 1) : null;
    s.avgHigh_improvement = (s.avg_dayHighReturn != null && baseline.avg_dayHighReturn != null) ? round(s.avg_dayHighReturn - baseline.avg_dayHighReturn, 2) : null;
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────
// 샘플 카드
// ─────────────────────────────────────────────────────────────────
function entryToCard(entry, decisionTime) {
  const o = entry.outcomesAtDecision[decisionTime];
  const snap = entry.snapsByDecision[decisionTime];
  return {
    code: entry.code, name: entry.name, market: entry.market,
    date: entry.date, decisionTime,
    decisionPrice: snap ? snap.decisionPrice : null,
    dayHighReturn:  o?.dayHighReturn  ?? null,
    dayCloseReturn: o?.dayCloseReturn ?? null,
    d1HighReturn:   o?.d1HighReturn   ?? null,
    d3MaxReturn:    o?.d3MaxReturn    ?? null,
    value_0900_1000: entry.valueFlow?.value_0900_1000 ?? null,
    valueContinueRatio:   entry.valueFlow?.valueContinueRatio   ?? null,
    valueSecondWaveRatio: entry.valueFlow?.valueSecondWaveRatio ?? null,
    morningHigh: entry.rebreak?.morningHigh_0900_0930 ?? null,
    rebreakMorningHigh: entry.rebreak?.rebreakMorningHigh_0940_1000 ?? null,
    rebreakWithValue:   entry.rebreak?.rebreakWithValue ?? null,
    rebreakAndHold:     entry.rebreak?.rebreakAndHold ?? null,
    decisionFromPrevClose: entry.positionByDecision[decisionTime]?.decisionFromPrevClose ?? null,
    decisionFromOpen:      entry.positionByDecision[decisionTime]?.decisionFromOpen ?? null,
    distanceToPrevHigh:    entry.positionByDecision[decisionTime]?.distanceToPrevHigh ?? null,
    gapRate:               entry.positionByDecision[decisionTime]?.gapRate ?? null,
    morningRangeRate:      entry.positionByDecision[decisionTime]?.intradayRangeRate_0900_decision ?? null,
    pricePositionInMorningRange: entry.positionByDecision[decisionTime]?.pricePositionInMorningRange ?? null,
    tags: entry.conditionGroups || [],
    auxTags: entry.auxTags || [],
    shortComment: shortCommentOf(entry, decisionTime),
  };
}
function shortCommentOf(entry, decisionTime) {
  const o = entry.outcomesAtDecision[decisionTime];
  if (!o) return '';
  const parts = [];
  if (o.dayHighReturn != null) parts.push(`고가 +${o.dayHighReturn}%`);
  if (o.dayCloseReturn != null) parts.push(`종가 ${o.dayCloseReturn > 0 ? '+' : ''}${o.dayCloseReturn}%`);
  if (entry.rebreak?.rebreakMorningHigh_0940_1000) parts.push('재돌파 ✓');
  if (entry.valueFlow?.valueContinueRatio != null) parts.push(`거래대금 유지 ${(entry.valueFlow.valueContinueRatio * 100).toFixed(0)}%`);
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────
// 메인 처리: 후보 모두 빌드
// ─────────────────────────────────────────────────────────────────
function buildAllEntries(dates, metaMap, auxIdx) {
  const all = [];
  let missingMinute = 0, priceMismatch = 0, totalFiles = 0;
  // morning value rank 계산 위한 일자별 vfMap
  for (const date of dates) {
    const codes = load1dsCandidatesByDate(date);
    const valuesForDay = []; // [{code, value_0900_1000}]
    const tempEntries = [];

    for (const code of codes) {
      totalFiles++;
      const raw = loadMinuteData(date, code);
      if (!raw || !Array.isArray(raw.bars) || raw.bars.length === 0) { missingMinute++; continue; }
      const meta = metaMap.get(code) || {};
      const name = raw.name || raw.kisMeta?.hts_kor_isnm || meta.name || code;
      const market = raw.market || meta.market || '';
      const marketCap = raw.boardSnapshot?.marketCap || meta.marketCap || 0;
      const prevClose = safeNum(raw.kisMeta?.stck_prdy_clpr);

      const rows = loadDailyChart(code);
      const dailyExt = findDailyExtended(rows, date);
      // 추가 정보: 20일 고가
      dailyExt._code = code;
      const high20 = (dailyExt.idx > 0) ? recentHigh20(rows, dailyExt.idx) : null;
      dailyExt._high20 = high20;

      // 공통 (decisionTime 무관) 계산: value flow + rebreak
      const valueFlow = calculateValueFlow(raw.bars);
      const rebreakBase = calculateHighRebreak(raw.bars, valueFlow);

      // 09:30 snap (price position 계산 anchor)
      const snap0930 = getDecisionSnapshot(raw.bars, '09:30');
      if (!snap0930) { missingMinute++; continue; }

      // 각 decisionTime snap + position + outcomes
      const snapsByDecision = {};
      const positionByDecision = {};
      const outcomesAtDecision = {};
      let skipForPriceMismatch = false;
      for (const dt of DECISION_TIMES) {
        const snap = getDecisionSnapshot(raw.bars, dt);
        snapsByDecision[dt] = snap;
        if (!snap) continue;
        const pos = calculatePricePosition(snap, prevClose, rebreakBase, dailyExt);
        // distanceToRecentHigh20를 dailyExt._high20로 교체
        pos.high20 = high20;
        pos.distanceToRecentHigh20 = (snap.decisionPrice && high20)
          ? round(((snap.decisionPrice / high20) - 1) * 100, 2) : null;
        positionByDecision[dt] = pos;
        const out = calculateOutcomesFromDecision(raw.bars, dt, snap.decisionPrice, dailyExt);
        if (out && out.priceMismatch) { skipForPriceMismatch = true; break; }
        outcomesAtDecision[dt] = out;
      }
      if (skipForPriceMismatch) { priceMismatch++; continue; }

      // aux QVA/QVA2 태그
      const auxTags = [];
      const sigNum = dashToNum(date);
      if (hasRecentSetup(auxIdx.qva,  code, sigNum, 5)) auxTags.push('RECENT_QVA_5D');
      if (hasRecentSetup(auxIdx.qva2, code, sigNum, 5)) auxTags.push('RECENT_QVA2_5D');

      const entry = {
        date, code, name, market, marketCap, prevClose,
        snap0930, snapsByDecision, positionByDecision, outcomesAtDecision,
        valueFlow, rebreak: rebreakBase, auxTags,
      };
      valuesForDay.push({ code, value: valueFlow.value_0900_1000 });
      tempEntries.push(entry);
    }
    // 일자별 morning value rank 계산
    valuesForDay.sort((a, b) => (b.value || 0) - (a.value || 0));
    const rankMap = new Map();
    valuesForDay.forEach((v, i) => {
      const pct = ((i + 1) / valuesForDay.length) * 100;
      rankMap.set(v.code, { rank: i + 1, topPct: pct });
    });
    for (const e of tempEntries) {
      e.totalValueRank = rankMap.get(e.code) || null;
      e.outcomeGroups = assignOutcomeGroups(e.outcomesAtDecision['09:30'] || e.outcomesAtDecision['09:45']);
      e.conditionGroups = assignConditionGroups(e, e.valueFlow, e.rebreak, e.positionByDecision['09:30'] || {}, e.totalValueRank);
      e.failurePatternTags = assignFailurePatternTags(e, e.valueFlow, e.rebreak, e.positionByDecision['09:30'] || {});
      all.push(e);
    }
  }
  return { all, missingMinute, priceMismatch, totalFiles };
}

// ─────────────────────────────────────────────────────────────────
// 추천 자동 (공격형 조건)
// ─────────────────────────────────────────────────────────────────
function recommendAttackConditions(conditionBigRates, baselineStats) {
  const baseBig10 = baselineStats.plus10_rate;
  const baseBig15 = baselineStats.plus15_rate;
  const baseBig20 = baselineStats.plus20_rate;
  const baseDayHigh = baselineStats.avg_dayHighReturn;
  const baseMinus3 = baselineStats.minus3_first_rate;

  const warnings = [];
  function score(t) {
    const big10imp = (t.stats.plus10_rate != null && baseBig10 != null) ? (t.stats.plus10_rate - baseBig10) : 0;
    const big15imp = (t.stats.plus15_rate != null && baseBig15 != null) ? (t.stats.plus15_rate - baseBig15) : 0;
    const big20imp = (t.stats.plus20_rate != null && baseBig20 != null) ? (t.stats.plus20_rate - baseBig20) : 0;
    const dhImp = (t.stats.avg_dayHighReturn != null && baseDayHigh != null) ? (t.stats.avg_dayHighReturn - baseDayHigh) : 0;
    const minus3Penalty = (t.stats.minus3_first_rate != null && baseMinus3 != null)
      ? Math.max(0, t.stats.minus3_first_rate - baseMinus3) : 0;
    const rebreakBonus  = (t.stats.rebreakRate || 0) >= 30 ? 1 : 0;
    const valueBonus    = (t.stats.avgValueContinueRatio || 0) >= 0.5 ? 1 : 0;
    const da = t.stats.perDayAvg || 0;
    const perDayPen = da <= 10 ? 0 : (da <= 20 ? (da - 10) * 0.5 : 5 + (da - 20) * 1);
    return round(big10imp * 2 + big15imp * 3 + big20imp * 4 + dhImp + rebreakBonus + valueBonus - minus3Penalty * 0.5 - perDayPen, 2);
  }
  const candidates = conditionBigRates.map((t) => ({ ...t, attackScore: score(t) }))
    .filter((t) => t.stats.n >= 50);
  candidates.sort((a, b) => (b.attackScore || 0) - (a.attackScore || 0));

  function meets(t, level) {
    const big10imp = (t.stats.plus10_rate != null && baseBig10 != null) ? (t.stats.plus10_rate - baseBig10) : 0;
    const big15imp = (t.stats.plus15_rate != null && baseBig15 != null) ? (t.stats.plus15_rate - baseBig15) : 0;
    const big20imp = (t.stats.plus20_rate != null && baseBig20 != null) ? (t.stats.plus20_rate - baseBig20) : 0;
    const dhImp = (t.stats.avg_dayHighReturn != null && baseDayHigh != null) ? (t.stats.avg_dayHighReturn - baseDayHigh) : 0;
    const da = t.stats.perDayAvg || 0;
    if (level === 'basic') return t.stats.n >= 100 && big10imp >= 5 && big15imp >= 3 && dhImp >= 2 && da <= 20;
    if (level === 'strong') return t.stats.n >= 100 && big10imp >= 8 && big15imp >= 5 && dhImp >= 3 && da <= 10;
    if (level === 'top') return t.stats.n >= 50 && big15imp >= 8 && big20imp >= 3 && dhImp >= 5 && da <= 5;
    return false;
  }
  const basic = candidates.filter((t) => meets(t, 'basic'));
  const strong = candidates.filter((t) => meets(t, 'strong'));
  const top = candidates.filter((t) => meets(t, 'top'));

  let best = top[0] || strong[0] || basic[0] || null;
  let level = top.length ? 'top' : strong.length ? 'strong' : basic.length ? 'basic' : 'none';

  if (best && best.stats.perDayAvg > 10) {
    warnings.push(`${best.label}: 일평균 ${best.stats.perDayAvg}개 (운영시 후보 과다, 조건 강화 검토)`);
  }
  for (const t of candidates.slice(0, 5)) {
    if (t.stats.minus3_first_rate != null && baseMinus3 != null && t.stats.minus3_first_rate > baseMinus3 + 5) {
      warnings.push(`${t.label}: -3% 먼저 ${t.stats.minus3_first_rate}% (BASE ${baseMinus3}% 대비 +${round(t.stats.minus3_first_rate - baseMinus3, 1)}pp, 공격형 트레이드오프)`);
    }
  }

  let reason;
  if (!best) {
    reason = 'BASE 대비 BIG10/BIG15/BIG20 유의미한 개선을 보인 조건 후보 없음. 표본 더 축적 후 재검증 필요.';
  } else {
    const big10imp = round(best.stats.plus10_rate - baseBig10, 1);
    const big15imp = round(best.stats.plus15_rate - baseBig15, 1);
    const big20imp = round(best.stats.plus20_rate - baseBig20, 1);
    reason = `${best.label}: BIG10 ${best.stats.plus10_rate}% (BASE ${baseBig10}% 대비 +${big10imp}pp), BIG15 ${best.stats.plus15_rate}% (+${big15imp}pp), BIG20 ${best.stats.plus20_rate}% (+${big20imp}pp). 평균 당일고가 ${best.stats.avg_dayHighReturn}% (BASE ${baseDayHigh}%). n=${best.stats.n}, 일평균 ${best.stats.perDayAvg}개. 통과 등급=${level}.`;
  }

  return {
    shouldBuildAttack1DS: !!best,
    bestConditionKey: best ? best.key : null,
    bestConditionLabel: best ? best.label : null,
    bestPassLevel: level,
    reason, warnings,
    topConditions: candidates.slice(0, 10).map((c) => ({
      key: c.key, label: c.label, attackScore: c.attackScore,
      n: c.stats.n, plus10: c.stats.plus10_rate, plus15: c.stats.plus15_rate, plus20: c.stats.plus20_rate,
      avgDayHigh: c.stats.avg_dayHighReturn, minus3First: c.stats.minus3_first_rate, perDayAvg: c.stats.perDayAvg,
    })),
    nextSteps: [
      '추천 조건이 nontrivial하면 동일 조건을 운영보드의 "공격형 TOP" 정렬 옵션으로 시범 적용 검토',
      '표본 60일 → 100일로 늘리고 같은 조건이 유지되는지 재검증',
      'BIG20/LIMIT_NEAR 사례를 시장 상황별(상승/하락/혼조)로 split해 패턴이 일관되는지 확인',
      '운영보드 생성 전 강한/최상 추천 등급에 도달할 때까지 보조 필터 추가 실험',
    ],
  };
}

// ─────────────────────────────────────────────────────────────────
// HTML 렌더링
// ─────────────────────────────────────────────────────────────────
function renderHtml(result) {
  const { meta, baseline, outcomeGroups, conditionBigRates, decisionTimeComparison,
          failurePatternComparison, attackConditionRecommendations, samples } = result;

  function pct(v) { return v == null ? '—' : (v.toFixed ? v.toFixed(1) : v) + '%'; }
  function num(v, digits = 2) { return v == null ? '—' : (Number.isFinite(v) ? Number(v).toFixed(digits) : '—'); }
  function fmtMoney(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 1e12) return (v / 1e12).toFixed(1) + '조';
    if (v >= 1e8)  return (v / 1e8).toFixed(1) + '억';
    if (v >= 1e4)  return (v / 1e4).toFixed(0) + '만';
    return String(v);
  }
  function sizeNote(n) {
    if (n == null) return '';
    if (n < 30) return ' <span class="warn">⚠ 표본 부족</span>';
    if (n < 100) return ' <span class="muted">(참고용)</span>';
    return '';
  }
  function impCell(v, dir = 1) {
    if (v == null) return '<td>—</td>';
    const cls = (dir > 0 ? v >= 3 : v <= -3) ? 'good' : (dir > 0 ? v <= -2 : v >= 2) ? 'bad' : '';
    const sign = v > 0 ? '+' : '';
    return `<td class="imp ${cls}">${sign}${v}pp</td>`;
  }
  function outcomeRow(t) {
    const s = t.stats;
    return `<tr>
      <td><b>${escapeHtml(t.label)}</b><div class="sub">${escapeHtml(t.key)}</div></td>
      <td>${s.n}${sizeNote(s.n)}</td>
      <td>${s.stockCount}</td>
      <td>${num(s.perDayAvg)}</td>
      <td>${num(s.avg_dayHighReturn)}%</td>
      <td>${num(s.median_dayHighReturn)}%</td>
      <td>${num(s.avg_dayCloseReturn)}%</td>
      <td>${num(s.avg_d1HighReturn)}%</td>
      <td>${num(s.avg_d3MaxReturn)}%</td>
      <td>${pct(s.minus3_first_rate)}</td>
      <td>${fmtMoney(s.avgValue_0900_1000)}</td>
      <td>${num(s.avgValueContinueRatio, 2)}</td>
      <td>${num(s.avgValueSecondWaveRatio, 2)}</td>
      <td>${pct(s.rebreakRate)}</td>
      <td>${pct(s.rebreakWithValueRate)}</td>
      <td>${pct(s.prevHighBreakRate)}</td>
    </tr>`;
  }
  function conditionRow(t) {
    const s = t.stats;
    let interp = '';
    if (s.n < 30) interp = '표본 부족';
    else if (s.big15_improvement >= 8 && s.big20_improvement >= 3) interp = '⭐ 공격형 핵심 조건';
    else if (s.big10_improvement >= 5 && s.avgHigh_improvement >= 2) interp = '✓ 공격형 후보';
    else if (s.big10_improvement < 0) interp = '✗ BASE보다 약함';
    else interp = '— 평이';
    return `<tr>
      <td><b>${escapeHtml(t.label)}</b><div class="sub">${escapeHtml(t.key)}</div></td>
      <td>${s.n}${sizeNote(s.n)}</td>
      <td>${pct(s.plus10_rate)}</td>
      <td>${pct(s.plus15_rate)}</td>
      <td>${pct(s.plus20_rate)}</td>
      <td>${pct(s.plus5_rate)}</td>
      <td>${pct(s.minus3_first_rate)}</td>
      <td>${num(s.avg_dayHighReturn)}%</td>
      <td>${num(s.avg_dayCloseReturn)}%</td>
      <td>${num(s.perDayAvg)}</td>
      ${impCell(s.big10_improvement)}
      ${impCell(s.big15_improvement)}
      ${impCell(s.big20_improvement)}
      <td class="interp">${escapeHtml(interp)}</td>
    </tr>`;
  }
  function dtRow(t) {
    const s = t.stats;
    return `<tr>
      <td><span class="dt-pill dt-${t.decisionTime === '09:30' ? '0' : t.decisionTime === '09:45' ? '1' : '2'}">${t.decisionTime}</span></td>
      <td><b>${escapeHtml(t.label)}</b><div class="sub">${escapeHtml(t.key)}</div></td>
      <td>${s.n}${sizeNote(s.n)}</td>
      <td>${pct(s.plus10_rate)}</td>
      <td>${pct(s.plus15_rate)}</td>
      <td>${pct(s.plus20_rate)}</td>
      <td>${pct(s.plus5_rate)}</td>
      <td>${pct(s.minus3_first_rate)}</td>
      <td>${num(s.avg_dayHighReturn)}%</td>
      <td>${num(s.avg_dayCloseReturn)}%</td>
    </tr>`;
  }
  function failRow(t) {
    const s = t.stats;
    return `<tr>
      <td><b>${escapeHtml(t.label)}</b><div class="sub">${escapeHtml(t.key)}</div></td>
      <td>${s.n}${sizeNote(s.n)}</td>
      <td>${pct(s.plus10_rate)}</td>
      <td>${pct(s.plus5_rate)}</td>
      <td>${pct(s.minus3_first_rate)}</td>
      <td>${num(s.avg_dayHighReturn)}%</td>
      <td>${num(s.avg_dayCloseReturn)}%</td>
      <td>${num(s.avg_highCloseDrop)}%</td>
    </tr>`;
  }
  function sampleCard(c) {
    return `<div class="card-cand">
      <div class="card-head">
        <span class="dt-pill dt-${c.decisionTime === '09:30' ? '0' : c.decisionTime === '09:45' ? '1' : '2'}">${c.decisionTime}</span>
        <div class="title"><span class="name">${escapeHtml(c.name)}</span><span class="code">${escapeHtml(c.code)}</span></div>
        <div class="score">${c.value_0900_1000 != null ? '거래대금 ' + fmtMoney(c.value_0900_1000) : ''}</div>
      </div>
      <div class="meta-line">신호 ${escapeHtml(c.date)} · decisionPrice ${num(c.decisionPrice, 0)} · 갭 ${num(c.gapRate)}% · 시가 대비 ${num(c.decisionFromOpen)}% · 전일종가 대비 ${num(c.decisionFromPrevClose)}%</div>
      <div class="meta-line">장초 고가 ${num(c.morningHigh, 0)} · 재돌파: <b style="color:${c.rebreakMorningHigh ? '#5eead4' : '#94a3b8'}">${c.rebreakMorningHigh ? '✓' : '—'}</b> · 거래대금 동반: <b style="color:${c.rebreakWithValue ? '#5eead4' : '#94a3b8'}">${c.rebreakWithValue ? '✓' : '—'}</b> · 유지: <b style="color:${c.rebreakAndHold ? '#5eead4' : '#94a3b8'}">${c.rebreakAndHold ? '✓' : '—'}</b></div>
      <div class="meta-line">거래대금 유지 비율 ${num(c.valueContinueRatio, 2)} · 2차 파동 ${num(c.valueSecondWaveRatio, 2)} · 장초 위치 ${num(c.pricePositionInMorningRange, 2)}</div>
      <div class="meta-line"><b>결과:</b> 당일고가 <b style="color:#fbbf24;">+${c.dayHighReturn}%</b> · 종가 ${c.dayCloseReturn > 0 ? '+' : ''}${c.dayCloseReturn}% · D+1 ${num(c.d1HighReturn)}% · D+3 max ${num(c.d3MaxReturn)}%</div>
      ${c.tags && c.tags.length ? `<div class="chips">${c.tags.slice(0, 8).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      ${c.auxTags && c.auxTags.length ? `<div class="chips">${c.auxTags.map((t) => `<span class="chip chip-aux">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <div class="comment muted">${escapeHtml(c.shortComment)}</div>
    </div>`;
  }
  function cardListOrEmpty(arr, emptyMsg) {
    if (!arr || !arr.length) return `<div class="empty">${escapeHtml(emptyMsg)}</div>`;
    return arr.map(sampleCard).join('');
  }

  // 상단 카드 통계
  const big10 = outcomeGroups.find((g) => g.key === 'BIG10');
  const big15 = outcomeGroups.find((g) => g.key === 'BIG15');
  const big20 = outcomeGroups.find((g) => g.key === 'BIG20');
  const limit = outcomeGroups.find((g) => g.key === 'LIMIT_NEAR');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>1DS BIG RUNNER 감사 보고서</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo','Noto Sans KR',sans-serif;background:#0f172a;color:#e2e8f0;margin:0 auto;padding:18px 24px 80px;max-width:1700px;line-height:1.55;font-size:13px;}
  h1{font-size:22px;margin:6px 0 4px;color:#f1f5f9;font-weight:700;}
  h2{font-size:16px;margin:26px 0 10px;color:#cbd5e1;border-bottom:1px solid #1e293b;padding-bottom:6px;}
  h3{font-size:14px;margin:14px 0 6px;color:#94a3b8;}
  .subtitle{color:#94a3b8;font-size:13px;margin-bottom:8px;line-height:1.6;}
  .exp-pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:#7c2d12;color:#fdba74;border:1px solid #ea580c;margin-left:8px;vertical-align:middle;font-weight:600;}
  nav.boards{display:flex;gap:6px;flex-wrap:wrap;padding:8px 0 14px;border-bottom:1px solid #1e293b;margin-bottom:14px;align-items:center;}
  nav.boards .group-label{font-size:11px;color:#64748b;padding:4px 8px 4px 0;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;}
  nav.boards a{color:#94a3b8;text-decoration:none;font-size:12px;padding:5px 10px;border-radius:6px;border:1px solid transparent;}
  nav.boards a:hover{color:#e2e8f0;background:#1e293b;}
  nav.boards a.live{border-color:#1e293b;}
  nav.boards a.experiment{border-color:#7c3aed;color:#c4b5fd;background:#1e1b4b;}
  nav.boards .sep{color:#475569;padding:0 6px;}
  .intro{background:#0f172a;border-left:3px solid #fb923c;padding:12px 16px;border-radius:6px;margin-bottom:14px;line-height:1.7;color:#cbd5e1;font-size:13px;}
  .intro b{color:#fdba74;}
  .meta-box{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 18px;margin-bottom:14px;font-size:12px;color:#94a3b8;}
  .meta-box span{margin-right:14px;}
  .meta-box b{color:#e2e8f0;}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px;}
  .card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 14px;}
  .card .lbl{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.4px;}
  .card .val{font-size:22px;font-weight:700;margin-top:4px;color:#f1f5f9;font-variant-numeric:tabular-nums;}
  .card .sub{font-size:11px;color:#64748b;margin-top:2px;}
  .card.big10{border-left:4px solid #fbbf24;}
  .card.big15{border-left:4px solid #fb923c;}
  .card.big20{border-left:4px solid #ef4444;}
  table{width:100%;border-collapse:collapse;background:#1e293b;border:1px solid #334155;border-radius:8px;overflow:hidden;font-size:12px;}
  th,td{padding:8px 9px;text-align:left;border-bottom:1px solid #334155;color:#cbd5e1;vertical-align:top;}
  th{background:#0f172a;color:#cbd5e1;font-weight:600;font-size:11px;}
  td .sub{font-size:10px;color:#64748b;}
  td.imp{font-weight:600;}
  td.imp.good{color:#5eead4;}
  td.imp.bad{color:#fca5a5;}
  .interp{font-size:11px;color:#94a3b8;max-width:180px;}
  .dt-pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:600;font-variant-numeric:tabular-nums;}
  .dt-0{background:#1e293b;color:#94a3b8;border:1px solid #334155;}
  .dt-1{background:#172554;color:#bfdbfe;border:1px solid #3b82f6;}
  .dt-2{background:#042f2e;color:#5eead4;border:1px solid #14b8a6;}
  .explain{background:#0f172a;border-left:3px solid #fbbf24;padding:10px 14px;margin:8px 0 14px;border-radius:6px;font-size:12px;color:#fcd34d;line-height:1.6;}
  .explain b{color:#fbbf24;}
  .recobox{background:#7c2d12;border-left:3px solid #fb923c;padding:12px 16px;border-radius:6px;margin:12px 0;}
  .recobox .row{margin:4px 0;font-size:13px;color:#fed7aa;}
  .recobox b{color:#fdba74;}
  .card-cand{background:#1e293b;border:1px solid #334155;border-left:5px solid #fbbf24;border-radius:10px;padding:10px 14px;margin-bottom:8px;}
  .card-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;}
  .card-head .title{font-size:14px;font-weight:700;display:flex;gap:6px;align-items:baseline;}
  .card-head .title .name{color:#f1f5f9;}
  .card-head .title .code{color:#64748b;font-size:11px;font-weight:400;}
  .card-head .score{margin-left:auto;font-size:11px;color:#94a3b8;}
  .meta-line{font-size:11px;color:#94a3b8;margin:2px 0;}
  .chips{margin-top:4px;}
  .chip{display:inline-block;font-size:10px;padding:2px 6px;border-radius:4px;margin:1px 2px 1px 0;background:#172554;color:#bfdbfe;border:1px solid #1e3a8a;}
  .chip-aux{background:#1e1b4b;color:#c4b5fd;border-color:#4c1d95;}
  .comment{font-size:11px;margin-top:4px;}
  .muted{color:#64748b;}
  .warn{color:#fca5a5;font-weight:600;}
  .empty{padding:14px;color:#64748b;font-size:12px;background:#1e293b;border:1px dashed #475569;border-radius:8px;}
  details{margin:6px 0 14px;}
  details summary{cursor:pointer;padding:8px 14px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;font-size:13px;font-weight:700;color:#cbd5e1;margin-bottom:8px;user-select:none;}
  .footer{margin-top:30px;padding:14px;background:#1e293b;border:1px solid #334155;border-radius:8px;font-size:12px;color:#94a3b8;line-height:1.7;}
  .table-wrap{overflow-x:auto;}
</style>
</head>
<body>
<nav class="boards">
  <span class="group-label">운영</span>
  <a href="/qva-watchlist" class="live">📋 QVA</a>
  <a href="/qva-vvi-redefined-board" class="live">🎯 VVI</a>
  <a href="/rebreak" class="live">🔥 D+5 재돌파</a>
  <a href="/one-day-surge-board" class="live">⚡ 1DS</a>
  <span class="sep">|</span>
  <span class="group-label">실험 QVA2</span>
  <a href="/qva2-watchlist" class="experiment">📋 H그룹/VPR (QVA2)</a>
  <a href="/qva2-d5-rebreak" class="experiment">🔥 D+5 재돌파 (QVA2)</a>
  <a href="/qva2-vvi" class="experiment">🎯 고점 재돌파 (QVA2)</a>
</nav>

<h1>🚀 1DS BIG RUNNER 감사 보고서 <span class="exp-pill">공격형 분석</span></h1>
<div class="subtitle">기존 1DS 중 당일 +10%, +15%, +20% 이상 크게 간 종목들이 장초에 어떤 공통점을 가졌는지 분석</div>

<div class="intro">
  기존 1DS 보드는 평균적으로 "몇 퍼센트 먹고 나오는" 안정형 신호에 가깝습니다. 이 보고서는 그 안에서
  <b>당일 +10%/+15%/+20% 이상 크게 간 종목들이 09:00~10:00에 어떤 공통점을 가졌는지</b>를 분석합니다.
  거래대금 흐름, 장초 고가 재돌파, 가격 위치, 거래대금+재돌파 조합 4축으로 본 뒤, 공격형 TOP 1DS 조건을 자동 제안합니다.
  <br/><b>주의</b>: 이 보고서는 매수 추천이 아니라 묘사형 감사. 공격형 조건은 수익 가능성과 함께 변동성도 커집니다.
</div>

<div class="meta-box">
  <span>생성: <b>${escapeHtml(meta.generatedAt)}</b></span>
  <span>모드: <b>${escapeHtml(meta.analysisMode)}</b></span>
  <span>분석 기간: <b>${escapeHtml(meta.periodFrom || '-')}</b> ~ <b>${escapeHtml(meta.periodTo || '-')}</b> (${meta.actualDays}일)</span>
  <span>decision times: <b>${meta.decisionTimes.join(', ')}</b></span>
  <span>전체 페어: <b>${meta.totalPairs}</b></span>
  <span>분봉 누락: <b>${meta.missingMinuteCount}</b></span>
  <span>가격 mismatch: <b>${meta.priceMismatchCount}</b></span>
</div>

<div class="cards">
  <div class="card"><div class="lbl">분석 거래일</div><div class="val">${meta.actualDays}</div><div class="sub">${meta.analysisMode}</div></div>
  <div class="card"><div class="lbl">전체 1DS 후보 (entries)</div><div class="val">${baseline.n}</div><div class="sub">decision 09:30 기준</div></div>
  <div class="card big10"><div class="lbl">BIG10 후보</div><div class="val" style="color:#fbbf24;">${big10 ? big10.stats.n : '—'}</div><div class="sub">+10% 이상 도달</div></div>
  <div class="card big15"><div class="lbl">BIG15 후보</div><div class="val" style="color:#fb923c;">${big15 ? big15.stats.n : '—'}</div><div class="sub">+15% 이상 도달</div></div>
  <div class="card big20"><div class="lbl">BIG20 후보</div><div class="val" style="color:#ef4444;">${big20 ? big20.stats.n : '—'}</div><div class="sub">+20% 이상 도달</div></div>
  <div class="card"><div class="lbl">BIG10 비율</div><div class="val" style="color:#fbbf24;">${pct(baseline.plus10_rate)}</div><div class="sub">BASE 전체 대비</div></div>
  <div class="card"><div class="lbl">BIG15 비율</div><div class="val" style="color:#fb923c;">${pct(baseline.plus15_rate)}</div><div class="sub">BASE 전체 대비</div></div>
  <div class="card"><div class="lbl">BIG20 비율</div><div class="val" style="color:#ef4444;">${pct(baseline.plus20_rate)}</div><div class="sub">BASE 전체 대비</div></div>
  <div class="card"><div class="lbl">가장 강한 공격형 조건</div><div class="val" style="font-size:14px;">${escapeHtml(attackConditionRecommendations.bestConditionLabel || '—')}</div><div class="sub">${escapeHtml(attackConditionRecommendations.bestPassLevel || 'none')}</div></div>
  <div class="card"><div class="lbl">추천 여부</div><div class="val" style="font-size:14px;">${attackConditionRecommendations.shouldBuildAttack1DS ? '있음' : '아직 부족'}</div><div class="sub">attackScore Top 1</div></div>
</div>

<h2>섹션 1 · 전체 요약</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 분석 기간 동안 기존 1DS 후보 중 얼마나 "크게 갔는지"의 베이스라인입니다.
  BIG10/15/20은 중복 가능 (BIG20은 BIG15와 BIG10에도 포함).
</div>
<table>
  <tbody>
    <tr><th>지표</th><th>BASE_1DS (decision 09:30 기준)</th></tr>
    <tr><td>분석 가능 entries</td><td>${baseline.n}</td></tr>
    <tr><td>+5% 도달률</td><td>${pct(baseline.plus5_rate)}</td></tr>
    <tr><td>+10% 도달률</td><td><b style="color:#fbbf24;">${pct(baseline.plus10_rate)}</b></td></tr>
    <tr><td>+15% 도달률</td><td><b style="color:#fb923c;">${pct(baseline.plus15_rate)}</b></td></tr>
    <tr><td>+20% 도달률</td><td><b style="color:#ef4444;">${pct(baseline.plus20_rate)}</b></td></tr>
    <tr><td>+25% (상한가 근처) 도달률</td><td>${pct(baseline.plus25_rate)}</td></tr>
    <tr><td>-3% 먼저 도달률</td><td>${pct(baseline.minus3_first_rate)}</td></tr>
    <tr><td>평균 당일 고가 수익률</td><td>${num(baseline.avg_dayHighReturn)}%</td></tr>
    <tr><td>중앙값 당일 고가</td><td>${num(baseline.median_dayHighReturn)}%</td></tr>
    <tr><td>평균 당일 종가 수익률</td><td>${num(baseline.avg_dayCloseReturn)}%</td></tr>
    <tr><td>평균 D+1 고가 수익률</td><td>${num(baseline.avg_d1HighReturn)}%</td></tr>
    <tr><td>평균 D+3 최고가 수익률</td><td>${num(baseline.avg_d3MaxReturn)}%</td></tr>
    <tr><td>고가 재돌파 비율 (전체 중)</td><td>${pct(baseline.rebreakRate)}</td></tr>
    <tr><td>거래대금 동반 재돌파 비율</td><td>${pct(baseline.rebreakWithValueRate)}</td></tr>
  </tbody>
</table>

<h2>섹션 2 · outcome 그룹별 특징</h2>
<div class="explain">
  <b>쉽게 말하면</b> — BIG10/15/20 그룹이 BASE 대비 거래대금 흐름·재돌파 비율에서 어떻게 다른지 한눈에 봅니다.
  "큰 상승 종목은 단순히 갭만 컸던 게 아니라 09:30 이후 거래대금이 유지되거나 재돌파 비율이 높았는가?"가 핵심.
</div>
<div class="table-wrap">
<table>
  <thead><tr>
    <th>그룹</th><th>n</th><th>종목</th><th>일평균</th>
    <th>평균고가</th><th>중앙고가</th><th>평균종가</th>
    <th>D+1 평균</th><th>D+3 평균최고</th>
    <th>-3% 먼저</th>
    <th>평균 거래대금</th><th>평균 유지비율</th><th>평균 2차파동비율</th>
    <th>재돌파 비율</th><th>재돌파+거래대금</th><th>전일고가 돌파</th>
  </tr></thead>
  <tbody>${outcomeGroups.map(outcomeRow).join('')}</tbody>
</table>
</div>

<h2>섹션 3 · 거래대금 + 재돌파 + 위치 조건별 BIG 확률</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 각 조건에 해당하는 후보들이 평균보다 +10%/+15%/+20% 도달률이 얼마나 높아지는지 비교.
  "공격형 TOP" 조건 후보를 여기서 찾습니다. <b>BIG10/15/20 차이가 base 대비 양수(+pp)</b>이면 공격형 우위.
</div>
<div class="table-wrap">
<table>
  <thead><tr>
    <th>조건</th><th>n</th>
    <th>BIG10</th><th>BIG15</th><th>BIG20</th>
    <th>+5%</th><th>-3% 먼저</th>
    <th>평균고가</th><th>평균종가</th><th>일평균</th>
    <th>BIG10 차이</th><th>BIG15 차이</th><th>BIG20 차이</th>
    <th>해석</th>
  </tr></thead>
  <tbody>${conditionBigRates.map(conditionRow).join('')}</tbody>
</table>
</div>

<h2>섹션 4 · 09:30 / 09:45 / 10:00 비교 (공격형 조건)</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 같은 공격형 조건이라도 entry 시점이 09:30이냐 10:00이냐에 따라 결과가 다를 수 있습니다.
  큰 상승을 노린다면 일찍 들어가는 게 좋은지(09:30) vs 확인 후 들어가는 게 좋은지(10:00).
  <br/><span class="muted">⚠ 조건 자체는 09:00~10:00 전체 데이터로 판정되므로 09:30 진입은 "사후적으로 그 조건을 만족할 후보를 봤다면"의 의미입니다.</span>
</div>
<div class="table-wrap">
<table>
  <thead><tr>
    <th>시점</th><th>조건</th><th>n</th>
    <th>BIG10</th><th>BIG15</th><th>BIG20</th>
    <th>+5%</th><th>-3% 먼저</th>
    <th>평균고가</th><th>평균종가</th>
  </tr></thead>
  <tbody>${decisionTimeComparison.map(dtRow).join('')}</tbody>
</table>
</div>

<h2>섹션 5 · 실패 패턴 비교 (BIG vs FAIL)</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 큰 상승 종목과 장초만 튀고 무너진 종목의 차이를 봅니다.
  실패 태그가 BIG 그룹에서 적게 나오면, 그 태그는 공격형 후보에서 <b>제외해야 할 신호</b>입니다.
</div>
<div class="table-wrap">
<table>
  <thead><tr>
    <th>실패 패턴</th><th>n</th>
    <th>BIG10</th><th>+5%</th><th>-3% 먼저</th>
    <th>평균고가</th><th>평균종가</th><th>고가→종가 밀림</th>
  </tr></thead>
  <tbody>${failurePatternComparison.map(failRow).join('')}</tbody>
</table>
</div>

<h2>섹션 6 · BIG10 / BIG15 / BIG20 / LIMIT_NEAR 대표 샘플</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 실제 큰 상승 종목 카드. 거래대금 흐름·재돌파·위치 패턴을 케이스로 확인.
  카드 색상: 노랑(BIG10+)에서 빨강(BIG20+/LIMIT_NEAR)으로 강해질수록 강조.
</div>
<details open><summary>BIG20 / LIMIT_NEAR 대표 (${(samples.limitNear||[]).length + (samples.big20||[]).length}건)</summary>
${cardListOrEmpty([...(samples.limitNear || []), ...(samples.big20 || [])], '없음')}
</details>
<details><summary>BIG15 대표 (${(samples.big15 || []).length}건)</summary>
${cardListOrEmpty(samples.big15, '없음')}
</details>
<details><summary>BIG10 대표 (${(samples.big10 || []).length}건)</summary>
${cardListOrEmpty(samples.big10, '없음')}
</details>
<details><summary>대조: 장초만 튀고 무너진 사례 (FAILED_SPIKE / SPIKE_FADE)</summary>
${cardListOrEmpty(samples.failedSpike, '없음')}
</details>

<h2>섹션 7 · 공격형 TOP 1DS 조건 제안 (자동)</h2>
<div class="recobox">
  <div class="row"><b>shouldBuildAttack1DS:</b> ${attackConditionRecommendations.shouldBuildAttack1DS ? '예 (추천 후보 있음)' : '아니오 (추천 후보 없음)'}</div>
  <div class="row"><b>최상위 추천 조건:</b> ${escapeHtml(attackConditionRecommendations.bestConditionLabel || '—')} (${escapeHtml(attackConditionRecommendations.bestPassLevel)})</div>
  <div class="row"><b>이유:</b> ${escapeHtml(attackConditionRecommendations.reason)}</div>
  ${(attackConditionRecommendations.warnings || []).length ? `<div class="row"><b>경고:</b><ul style="margin:4px 0 0;padding-left:18px;">${attackConditionRecommendations.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : ''}
</div>
<h3>attackScore Top 10 조건</h3>
<div class="table-wrap">
<table>
  <thead><tr><th>순위</th><th>조건</th><th>n</th><th>일평균</th><th>BIG10</th><th>BIG15</th><th>BIG20</th><th>평균고가</th><th>-3% 먼저</th><th>attackScore</th></tr></thead>
  <tbody>${(attackConditionRecommendations.topConditions || []).map((c, i) => `<tr>
    <td>${i + 1}</td>
    <td><b>${escapeHtml(c.label)}</b><div class="sub">${escapeHtml(c.key)}</div></td>
    <td>${c.n}${sizeNote(c.n)}</td>
    <td>${num(c.perDayAvg)}</td>
    <td>${pct(c.plus10)}</td>
    <td>${pct(c.plus15)}</td>
    <td>${pct(c.plus20)}</td>
    <td>${num(c.avgDayHigh)}%</td>
    <td>${pct(c.minus3First)}</td>
    <td><b>${num(c.attackScore)}</b></td>
  </tr>`).join('')}</tbody>
</table>
</div>

<h2>섹션 8 · 다음 단계 제안</h2>
<ol>${(attackConditionRecommendations.nextSteps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>

<h2>섹션 9 · 주의사항</h2>
<ul>
  <li>거래대금/재돌파/위치 분류는 09:00~10:00 <b>전체 morning 데이터</b>로 계산 (감사 보고서 관점 — 사후 묘사).</li>
  <li>decisionTime은 entry price 기준만 변경. 09:30 entry에서 "이후 재돌파 발생" 정보는 사전에 알 수 없음 — 운영보드 영역.</li>
  <li>분봉 데이터는 09:00~10:00 구간만 존재. 10:00 decision의 +3/-3 순서는 분봉 부재로 unavailable.</li>
  <li>일봉 high를 post-decision max로 인정하는 조건: dailyHigh &gt; pre-decision max high인 경우.</li>
  <li>가격 sanity guard: intraday open vs daily open 1.5배 이상 차이 시 제외.</li>
  <li>BIG10/15/20은 중복 가능 (BIG20은 BIG15와 BIG10에도 포함).</li>
  <li>QVA/QVA2 태그는 보조 정보 (있으면 카드 chip으로 표시). 분류 핵심은 1DS 자체의 morning 패턴.</li>
  <li>이 보고서는 매수 추천이 아니라 묘사형 감사. 공격형 조건은 수익 가능성과 함께 변동성도 커집니다.</li>
</ul>

<div class="footer">
  이 보고서는 "기존 1DS 안에서 무엇이 BIG RUNNER로 발전했는가"를 묘사하는 감사 보고서입니다.
  운영 보드를 만들 정도로 강한 조건이 발견됐다면 추가 검증 → 시범 정렬 옵션 → 정식 보드 순서로 보수적으로 진행하는 것을 권장합니다.
</div>
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────────────
// 샘플 추출
// ─────────────────────────────────────────────────────────────────
function pickSamples(all, limit) {
  const sortHigh09 = (a, b) => (b.outcomesAtDecision['09:30']?.dayHighReturn || -999) - (a.outcomesAtDecision['09:30']?.dayHighReturn || -999);
  const sortCloseAsc = (a, b) => (a.outcomesAtDecision['09:30']?.dayCloseReturn || 999) - (b.outcomesAtDecision['09:30']?.dayCloseReturn || 999);
  const big10 = all.filter((e) => e.outcomeGroups.includes('BIG10') && !e.outcomeGroups.includes('BIG15')).sort(sortHigh09).slice(0, limit);
  const big15 = all.filter((e) => e.outcomeGroups.includes('BIG15') && !e.outcomeGroups.includes('BIG20')).sort(sortHigh09).slice(0, limit);
  const big20 = all.filter((e) => e.outcomeGroups.includes('BIG20') && !e.outcomeGroups.includes('LIMIT_NEAR')).sort(sortHigh09).slice(0, limit);
  const limitNear = all.filter((e) => e.outcomeGroups.includes('LIMIT_NEAR')).sort(sortHigh09).slice(0, limit);
  const failedSpike = all.filter((e) => e.outcomeGroups.includes('FAILED_SPIKE') || e.outcomeGroups.includes('SPIKE_FADE'))
    .sort(sortCloseAsc).slice(0, limit);
  return {
    big10: big10.map((e) => entryToCard(e, '09:30')),
    big15: big15.map((e) => entryToCard(e, '09:30')),
    big20: big20.map((e) => entryToCard(e, '09:30')),
    limitNear: limitNear.map((e) => entryToCard(e, '09:30')),
    failedSpike: failedSpike.map((e) => entryToCard(e, '09:30')),
  };
}

// ─────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log('\n🚀 1DS BIG RUNNER 감사 보고서');
  const t0 = Date.now();

  if (!fs.existsSync(INTRADAY_BASE)) { console.error('  [ERROR] data/intraday/1ds 없음.'); process.exit(1); }
  const metaMap = loadMetaMap();
  const tdates = buildTradingDates();
  const auxIdx = loadAuxQvaIndex();
  console.log(`  메타: ${metaMap.size}건, 거래일 인덱스: ${tdates.length}일, QVA aux: ${auxIdx.qva.size}, QVA2 aux: ${auxIdx.qva2.size}`);

  const allDirs = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  let dates;
  let analysisMode;
  if (args.date) {
    dates = [args.date];
    analysisMode = `single_date (${args.date})`;
  } else if (args.from || args.to) {
    dates = allDirs.filter((d) => (!args.from || d >= args.from) && (!args.to || d <= args.to));
    analysisMode = `range (${args.from || allDirs[0]} ~ ${args.to || allDirs[allDirs.length - 1]})`;
  } else {
    const n = args.days || 60;
    dates = allDirs.slice(-Math.min(n, allDirs.length));
    analysisMode = `recent_${dates.length}d (requested=${n})`;
  }
  if (dates.length === 0) { console.error('  [ERROR] 분석할 날짜 없음.'); process.exit(1); }
  console.log(`  📅 ${analysisMode} — ${dates.length}일 (${dates[0]} ~ ${dates[dates.length - 1]})`);

  // 전 entries 빌드
  const { all, missingMinute, priceMismatch, totalFiles } = buildAllEntries(dates, metaMap, auxIdx);
  console.log(`  스캔 — 전체 파일: ${totalFiles}, 분봉 누락: ${missingMinute}, 가격 mismatch: ${priceMismatch}, 처리 entries: ${all.length}`);

  // baseline (09:30 기준)
  const baseline = groupStats(all, '09:30', dates.length);

  // outcomeGroups
  const OUTCOME_DEFS = [
    { key: 'BASE_1DS',      label: 'BASE 전체',         pred: () => true },
    { key: 'BIG10',         label: 'BIG10 (+10% 도달)',  pred: (e) => e.outcomeGroups.includes('BIG10') },
    { key: 'BIG15',         label: 'BIG15 (+15% 도달)',  pred: (e) => e.outcomeGroups.includes('BIG15') },
    { key: 'BIG20',         label: 'BIG20 (+20% 도달)',  pred: (e) => e.outcomeGroups.includes('BIG20') },
    { key: 'LIMIT_NEAR',    label: 'LIMIT_NEAR (+25% 이상)', pred: (e) => e.outcomeGroups.includes('LIMIT_NEAR') },
    { key: 'STRONG_CLOSE',  label: '종가도 +5% 이상',     pred: (e) => e.outcomeGroups.includes('STRONG_CLOSE') },
    { key: 'SPIKE_FADE',    label: '장초만 튀고 종가 무너짐', pred: (e) => e.outcomeGroups.includes('SPIKE_FADE') },
    { key: 'FAILED_SPIKE',  label: '+3% 못 가고 -3% 먼저',  pred: (e) => e.outcomeGroups.includes('FAILED_SPIKE') },
  ];
  const outcomeGroups = OUTCOME_DEFS.map((d) => {
    const sub = all.filter(d.pred);
    return { key: d.key, label: d.label, stats: groupStats(sub, '09:30', dates.length) };
  });

  // 조건별 BIG 확률 (대규모 표)
  const CONDITION_DEFS = [
    { key: 'VALUE_CONTINUED',         label: '거래대금 유지 (continueRatio≥0.5)' },
    { key: 'VALUE_STRONG_CONTINUED',  label: '강한 거래대금 유지 (≥0.8)' },
    { key: 'SECOND_WAVE_VALUE',       label: '2차 파동 거래대금 (secondWave≥1.2)' },
    { key: 'HIGH_REBREAK',            label: '장초 고가 재돌파' },
    { key: 'REBREAK_WITH_VALUE',      label: '재돌파 + 거래대금 동반' },
    { key: 'HIGH_REBREAK_VALUE',      label: '재돌파 + 유지(≥0.5)' },
    { key: 'HIGH_REBREAK_STRONG_VALUE', label: '재돌파 + 강한 유지(≥0.8)' },
    { key: 'SECOND_WAVE_REBREAK',     label: '재돌파 + 2차 파동' },
    { key: 'BIG_MONEY_REBREAK',       label: '거래대금 상위 10% + 재돌파' },
    { key: 'BIG_MONEY_CONTINUED',     label: '거래대금 상위 10% + 유지' },
    { key: 'PREV_HIGH_BREAK',         label: '전일 고가 돌파' },
    { key: 'HIGH_ZONE',               label: '장초 고가권 위치 (≥0.8)' },
    { key: 'EXTENDED_FROM_OPEN',      label: '시가 대비 +5% 이상' },
    { key: 'PULLBACK_ZONE',           label: '눌림 후 위치 (장초 중간권)' },
    { key: 'GAP_OVERHEAT',            label: '갭 +8% 이상 (참고용)' },
    { key: 'FIRST_SPIKE_ONLY',        label: '첫 급등만 (재돌파 없음)' },
  ];
  const conditionBigRates = CONDITION_DEFS.map((d) => {
    const sub = all.filter((e) => e.conditionGroups.includes(d.key));
    return { key: d.key, label: d.label, stats: groupStats(sub, '09:30', dates.length, baseline) };
  }).sort((a, b) => (b.stats.big10_improvement || -99) - (a.stats.big10_improvement || -99));

  // decisionTime 비교 (핵심 조건만 09:30/09:45/10:00)
  const DT_COND_KEYS = ['HIGH_REBREAK', 'REBREAK_WITH_VALUE', 'HIGH_REBREAK_STRONG_VALUE', 'SECOND_WAVE_REBREAK', 'BIG_MONEY_REBREAK', 'PULLBACK_ZONE'];
  const decisionTimeComparison = [];
  for (const dt of DECISION_TIMES) {
    const baseDt = groupStats(all, dt, dates.length);
    decisionTimeComparison.push({ decisionTime: dt, key: 'BASE_1DS', label: 'BASE 전체', stats: baseDt });
    for (const k of DT_COND_KEYS) {
      const def = CONDITION_DEFS.find((d) => d.key === k);
      if (!def) continue;
      const sub = all.filter((e) => e.conditionGroups.includes(k));
      decisionTimeComparison.push({ decisionTime: dt, key: k, label: def.label, stats: groupStats(sub, dt, dates.length, baseDt) });
    }
  }

  // 실패 패턴 비교 (09:30 기준)
  const FAIL_DEFS = [
    { key: 'EARLY_BURST_FADE',       label: '장초만 강하고 거래대금 급감' },
    { key: 'NO_VALUE_CONTINUATION',  label: '09:30 이후 거래대금 유지 실패' },
    { key: 'HIGH_REBREAK_FAIL',      label: '재돌파 시도했지만 실패' },
    { key: 'TOO_EXTENDED_NO_REBREAK', label: '많이 올랐지만 재돌파 없음' },
    { key: 'GAP_OVERHEAT',           label: '갭 +8% 이상' },
    { key: 'HIGH_VOLATILITY_WICK',   label: '장초 고저폭 8% 이상' },
    { key: 'CLOSE_WEAK',             label: '종가 약함 (decisionPrice 음봉/고가 -7% 밀림)' },
    { key: 'FIRST_SPIKE_ONLY',       label: '첫 급등만, 재돌파 없음' },
  ];
  const failurePatternComparison = FAIL_DEFS.map((d) => {
    const sub = all.filter((e) => e.failurePatternTags.includes(d.key));
    return { key: d.key, label: d.label, stats: groupStats(sub, '09:30', dates.length, baseline) };
  });

  // 추천
  const attackConditionRecommendations = recommendAttackConditions(conditionBigRates, baseline);

  // 샘플
  const samples = pickSamples(all, args.sampleLimit);

  // meta
  const meta = {
    generatedAt: new Date().toISOString(),
    analysisMode,
    periodFrom: dates[0],
    periodTo: dates[dates.length - 1],
    actualDays: dates.length,
    decisionTimes: DECISION_TIMES,
    sourceFiles: [
      'data/intraday/1ds/{date}/{code}.json',
      'cache/stock-charts-long/{code}.json',
      'cache/naver-stocks-list.json',
    ],
    totalPairs: all.length,
    missingMinuteCount: missingMinute,
    priceMismatchCount: priceMismatch,
    notes: [
      '거래대금/재돌파/위치 분류는 09:00~10:00 전체 morning 데이터로 계산 (감사 보고서 관점 — 사후 묘사). 운영보드의 사전 조건과는 다름.',
      'decisionTime은 entry price 기준만 변경. post-decision 구간을 재는 시작점.',
      'BIG10/15/20은 중복 가능 — BIG20은 BIG15와 BIG10 모두에 포함.',
      '일봉 high를 post-decision max로 인정하는 조건: dailyHigh > pre-decision max.',
      '가격 sanity guard: intraday open vs daily open 1.5x 차이 시 제외.',
      '분봉은 09:00~10:00만 사용. 10:00 decision의 +3/-3 ordering은 unavailable.',
    ],
  };

  const result = {
    meta, baseline,
    outcomeGroups, conditionBigRates, decisionTimeComparison, failurePatternComparison,
    attackConditionRecommendations, samples,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf-8');
  fs.writeFileSync(OUT_HTML, renderHtml(result), 'utf-8');

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\n📄 JSON: ${path.relative(ROOT, OUT_JSON)}`);
  console.log(`📄 HTML: ${path.relative(ROOT, OUT_HTML)}`);
  console.log(`📅 분석 기간: ${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length}일, ${analysisMode})`);
  console.log(`\n📊 BASE 1DS (09:30 기준): n=${baseline.n}`);
  console.log(`   BIG10 ${baseline.plus10_rate}% / BIG15 ${baseline.plus15_rate}% / BIG20 ${baseline.plus20_rate}% / LIMIT_NEAR ${baseline.plus25_rate}%`);
  console.log(`   평균 당일고가 ${baseline.avg_dayHighReturn}% / 평균 D+1 ${baseline.avg_d1HighReturn}% / 평균 D+3 ${baseline.avg_d3MaxReturn}%`);
  console.log(`   재돌파 비율 ${baseline.rebreakRate}% / 재돌파+거래대금 ${baseline.rebreakWithValueRate}%`);

  const big10g = outcomeGroups.find((g) => g.key === 'BIG10');
  const big15g = outcomeGroups.find((g) => g.key === 'BIG15');
  const big20g = outcomeGroups.find((g) => g.key === 'BIG20');
  console.log(`\n🚀 BIG10 n=${big10g?.stats.n || 0}, BIG15 n=${big15g?.stats.n || 0}, BIG20 n=${big20g?.stats.n || 0}`);

  console.log(`\n🔥 attackScore Top 5 조건:`);
  for (const c of (attackConditionRecommendations.topConditions || []).slice(0, 5)) {
    console.log(`   - ${c.label}: n=${c.n}, BIG10 ${c.plus10}% / BIG15 ${c.plus15}% / BIG20 ${c.plus20}%, 평균고가 ${c.avgDayHigh}%, -3% 먼저 ${c.minus3First}%, 일평균 ${c.perDayAvg}, score ${c.attackScore}`);
  }

  console.log(`\n🎯 추천:`);
  console.log(`   shouldBuildAttack1DS=${attackConditionRecommendations.shouldBuildAttack1DS}, 등급=${attackConditionRecommendations.bestPassLevel}`);
  console.log(`   best=${attackConditionRecommendations.bestConditionLabel || '없음'}`);
  console.log(`   ${attackConditionRecommendations.reason}`);
  if ((attackConditionRecommendations.warnings || []).length) {
    console.log(`\n⚠ 경고:`);
    for (const w of attackConditionRecommendations.warnings) console.log(`   - ${w}`);
  }

  console.log(`\n📝 다음 단계:`);
  for (const s of attackConditionRecommendations.nextSteps) console.log('   -', s);
  console.log(`\n⏱ elapsed: ${elapsed}s`);
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[FATAL]', e && e.stack || e);
    process.exit(1);
  }
}

module.exports = { main };
