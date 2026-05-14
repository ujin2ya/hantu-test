#!/usr/bin/env node
/**
 * 1DS — +10% Winner Profile 보고서
 *
 * 09:30 스캐너 + 추가 가설 후보 풀에서, 당일 +10% 이상 상승한 종목들을 따로 추출해
 * 어떤 공통 조건을 가졌는지 분석한다. explosiveTop이 충분히 잡고 있는지, 놓친 +10%
 * 종목들이 어떤 패턴이었는지, 공격형 보조 후보 조건은 무엇인지 정리.
 *
 * 세 가지 +10% 기준 (각자 분리):
 *   A. 09:30 close 대비    : maxHigh after 09:30 / m.last0930  ≥ 1.10
 *   B. 당일 시가 대비       : maxHigh of day      / dayOpen     ≥ 1.10
 *   C. 가설 entryPrice 대비: maxHigh after entry / entryPrice  ≥ 1.10 (가설별)
 *
 * 입력:
 *   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json           (분봉, 09:00~15:30)
 *   - cache/stock-charts-long/{code}.json                  (유동성 필터용 전일 일봉)
 *   - cache/naver-stocks-list.json                         (메타)
 *   - reports/one-day-surge-extra-intraday-hypothesis-result.json  (가설별 trigger 정보)
 *
 * 출력:
 *   - reports/one-day-surge-10pct-winner-profile-result.{json,html}
 *
 * 사용:
 *   node boards/oneDaySurge/one-day-surge-10pct-winner-profile-report.js
 *   node boards/oneDaySurge/one-day-surge-10pct-winner-profile-report.js --from 2026-04-16 --to 2026-05-14
 *
 * 누수 분리:
 *   - 사전 정보 (09:30 시점까지 확정): status, 09:30 metrics, isExplosiveTop, 가설 trigger 조건
 *   - 사후 정보 (당일 종료 후 확정): dayHigh, hit10*, +10% 도달 시간, closeAtEnd
 *   각 필드를 HTML에서도 "사전" / "사후" 컬럼 그룹으로 구분.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
let HYPO_JSON_PATH = path.join(REPORTS_DIR, 'one-day-surge-extra-intraday-hypothesis-result.json');
let OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-10pct-winner-profile-result.json');
let OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-10pct-winner-profile-result.html');

const scanner = require('./one-day-surge-0930-scanner');

// ── CLI ──
function parseArgs(argv) {
  const a = { from: null, to: null, days: null, minDirSize: 200 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from' || k === '--from-date') a.from = argv[++i];
    else if (k === '--to' || k === '--to-date') a.to = argv[++i];
    else if (k === '--days') a.days = parseInt(argv[++i], 10) || null;
    else if (k === '--min-dir-size') a.minDirSize = parseInt(argv[++i], 10) || 200;
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node one-day-surge-10pct-winner-profile-report.js [--from-date YYYY-MM-DD] [--to-date YYYY-MM-DD] [--days N]');
      process.exit(0);
    }
  }
  return a;
}
function applyDaysSuffix(days) {
  if (!days || days < 30) return;
  OUT_JSON = path.join(REPORTS_DIR, `one-day-surge-10pct-winner-profile-${days}d-result.json`);
  OUT_HTML = path.join(REPORTS_DIR, `one-day-surge-10pct-winner-profile-${days}d-result.html`);
  // 짝이 되는 60일 hypothesis 결과가 있으면 우선 사용
  const sized = path.join(REPORTS_DIR, `one-day-surge-extra-intraday-hypothesis-${days}d-result.json`);
  if (fs.existsSync(sized)) HYPO_JSON_PATH = sized;
}

// ── 베이스라인 explosiveTop 판정 (scanner와 동일 규칙) ──
function passesExplosive(m) {
  if (!m || !m.rebreakMorningHigh) return false;
  if ((m.closePosition0930 || 0) < 0.85) return false;
  if ((m.value_0930 || 0) < 1e10) return false;
  return true;
}

// ── 차트 캐시 ──
const chartCache = new Map();
function loadChartRows(code) {
  if (chartCache.has(code)) return chartCache.get(code);
  const p = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(p)) { chartCache.set(code, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    chartCache.set(code, j.rows || null);
    return j.rows || null;
  } catch (_) { chartCache.set(code, null); return null; }
}
function findBaseRow(rows, nextDateNum) {
  if (!Array.isArray(rows)) return null;
  const idx = rows.findIndex((r) => r.date === nextDateNum);
  if (idx < 21) return null;
  return { baseIdx: idx - 1, baseRow: rows[idx - 1] };
}

// ── 가설 trigger 인덱스 로드 ──
function loadHypothesisTriggers() {
  if (!fs.existsSync(HYPO_JSON_PATH)) {
    console.error(`[ERROR] ${HYPO_JSON_PATH} 가 없습니다. 먼저 one-day-surge-extra-intraday-hypothesis-report.js를 실행하세요.`);
    process.exit(1);
  }
  const j = JSON.parse(fs.readFileSync(HYPO_JSON_PATH, 'utf-8'));
  // entriesByBucket: { TEN_REBREAK: [{date, code, name, status, trig, perf}], ... }
  const idx = new Map();  // key = `${date}|${code}` → { TEN_REBREAK: trig, FADED_RECOVERY: trig, ... }
  for (const hypo of Object.keys(j.entriesByBucket || {})) {
    for (const e of j.entriesByBucket[hypo]) {
      const key = `${e.date}|${e.code}`;
      if (!idx.has(key)) idx.set(key, {});
      idx.get(key)[hypo] = e.trig;  // entryTime, entryPrice, slPct, tpPct, exitTime, reason
    }
  }
  return idx;
}

// ── 분봉 → 일중 측정 ──
function computeDayMetrics(bars, last0930) {
  // dayOpen: 가장 빠른 분봉의 open
  const sorted = bars.filter((b) => b && b.time && b.close > 0).slice().sort((a, b) => a.time.localeCompare(b.time));
  if (sorted.length === 0) return null;
  const dayOpen = sorted[0].open;
  const lastBar = sorted[sorted.length - 1];
  const closeAtEnd = lastBar.close;

  // 분봉 시간순으로 dayHigh / firstHit10* 추적
  let dayHigh = 0, dayHighTime = null;
  let dayHighAfter0930 = 0, dayHighAfter0930Time = null;
  let firstHit10FromOpen_Time = null;
  let firstHit10From0930_Time = null;
  let rebreak0930HighTime = null;  // 첫 09:30 high 재돌파 시간
  let bar1000Close = null;

  for (const b of sorted) {
    if (b.high > dayHigh) { dayHigh = b.high; dayHighTime = b.time; }
    if (b.time > '09:30' && b.high > dayHighAfter0930) { dayHighAfter0930 = b.high; dayHighAfter0930Time = b.time; }
    if (firstHit10FromOpen_Time == null && dayOpen > 0 && b.high >= dayOpen * 1.10) firstHit10FromOpen_Time = b.time;
    if (firstHit10From0930_Time == null && last0930 > 0 && b.time > '09:30' && b.high >= last0930 * 1.10) firstHit10From0930_Time = b.time;
    if (rebreak0930HighTime == null && b.time > '09:30' && last0930 > 0 && b.high > 0) {
      // m.high0930 기준 — 외부에서 전달 받기 어렵지만 last0930과 별개이므로 호출처에서 처리
    }
    if (b.time === '10:00') bar1000Close = b.close;
    if (b.time > '10:00' && bar1000Close == null) bar1000Close = b.close;  // 10:00 분봉 없으면 그 직후
  }

  return {
    dayOpen,
    dayHigh, dayHighTime,
    dayHighAfter0930, dayHighAfter0930Time,
    closeAtEnd,
    firstHit10FromOpen_Time, firstHit10From0930_Time,
    bar1000Close,
  };
}

// 09:30 high 재돌파 시간 (별도 함수 — m.high0930 필요)
function findRebreak0930HighTime(bars, high0930) {
  if (!(high0930 > 0)) return null;
  for (const b of bars) {
    if (!b || !b.time || b.time <= '09:30') continue;
    if (!(b.high > 0)) continue;
    if (b.high > high0930) return b.time;
  }
  return null;
}

// 가설 trigger의 진입 후 maxHigh / +10% 도달 시간 (당일 종료까지)
function computeEntryMaxHigh(bars, trig) {
  if (!trig || !(trig.entryPrice > 0)) return null;
  const after = bars.filter((b) => b && b.time && b.close > 0 && b.time > trig.entryTime);
  if (after.length === 0) return null;
  let maxHi = 0, maxHiTime = null;
  let hit10Time = null;
  for (const b of after) {
    if (b.high > maxHi) { maxHi = b.high; maxHiTime = b.time; }
    if (hit10Time == null && b.high >= trig.entryPrice * 1.10) hit10Time = b.time;
  }
  return {
    maxHi, maxHiTime,
    maxReturn: Number(((maxHi / trig.entryPrice - 1) * 100).toFixed(2)),
    hit10FromEntry: maxHi >= trig.entryPrice * 1.10,
    hit10FromEntry_Time: hit10Time,
  };
}

// ── 시총 구간 ──
function marketCapBand(mc) {
  if (!(mc > 0)) return '미상';
  if (mc < 1e11) return '<1000억';
  if (mc < 3e11) return '1000~3000억';
  if (mc < 5e11) return '3000~5000억';
  if (mc < 1e12) return '5000억~1조';
  if (mc < 3e12) return '1조~3조';
  return '3조+';
}

// ── 분석 ──
function analyzeDay(dirName, metaMap, hypoIdx) {
  const dir = path.join(INTRADAY_BASE, dirName);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;
  const nextDateNum = dirName.replace(/-/g, '');

  const profiles = [];

  for (const fname of files) {
    const code = fname.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    if (!meta) continue;

    const rows = loadChartRows(code);
    if (!rows) continue;
    const baseInfo = findBaseRow(rows, nextDateNum);
    if (!baseInfo) continue;
    const baseRow = baseInfo.baseRow;
    if (!baseRow || !(baseRow.close > 0)) continue;

    let sum = 0, cnt = 0;
    for (let i = baseInfo.baseIdx - 20; i < baseInfo.baseIdx; i++) {
      const r = rows[i];
      if (r && r.volume > 0) { sum += (r.valueApprox || 0); cnt++; }
    }
    const avg20 = cnt > 0 ? sum / cnt : 0;
    const baseValue = baseRow.valueApprox || 0;
    const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) continue;

    let bars = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8'));
      bars = j.bars || [];
    } catch (_) { continue; }
    if (bars.length === 0) continue;

    const m = scanner.computeMetrics0930(bars, baseRow);
    if (!m) continue;
    const status = scanner.classifyStatus(m);
    const isExplosiveTop = (status === 'READY') && passesExplosive(m);

    const day = computeDayMetrics(bars, m.last0930);
    if (!day) continue;
    const rebreak0930HighTime = findRebreak0930HighTime(bars, m.high0930);

    const hypoKey = `${dirName}|${code}`;
    const triggers = hypoIdx.get(hypoKey) || {};
    const triggeredHypos = Object.keys(triggers);

    // 가설별 maxHigh / +10% 도달
    const triggerOutcomes = {};
    for (const [hname, trig] of Object.entries(triggers)) {
      triggerOutcomes[hname] = computeEntryMaxHigh(bars, trig);
    }

    // +10% 기준 3종
    const ret10FromOpen   = day.dayOpen > 0 ? (day.dayHigh / day.dayOpen - 1) * 100 : null;
    const ret10From0930   = m.last0930 > 0  ? (day.dayHighAfter0930 / m.last0930 - 1) * 100 : null;
    const hit10FromOpen   = ret10FromOpen != null && ret10FromOpen >= 10;
    const hit10From0930   = ret10From0930 != null && ret10From0930 >= 10;
    const hit10FromAnyEntry = Object.values(triggerOutcomes).some((o) => o && o.hit10FromEntry);

    // 일중 closeReturn (사후)
    const closeReturnFrom0930 = (day.closeAtEnd / m.last0930 - 1) * 100;
    const closeReturnFromOpen = (day.closeAtEnd / day.dayOpen - 1) * 100;
    const hold1000 = day.bar1000Close != null ? day.bar1000Close > m.last0930 : null;

    profiles.push({
      date: dirName,
      code,
      name: meta.name || code,
      market: meta.market || '',
      marketCap: meta.marketCap || 0,
      mcBand: marketCapBand(meta.marketCap || 0),

      // 사전 정보 (09:30 시점까지)
      pre: {
        status,
        isExplosiveTop,
        triggeredHypos,
        value_0930: m.value_0930,
        valueToAvgRatio_0930: m.valueToAvgRatio_0930,
        closePosition0930: m.closePosition0930,
        highToLastDrop: m.highToLastDrop,
        openToLastRate: m.openToLastRate,
        rebreakMorningHigh: m.rebreakMorningHigh,
        high0930: m.high0930,
        last0930: m.last0930,
        open0900: m.open0900,
        prevDayValue: baseValue,
        avg20Value: Math.round(avg20),
        valueToMcRatio_0930: (meta.marketCap || 0) > 0 ? m.value_0930 / meta.marketCap : null,
      },

      // 사후 정보 (당일 종료 후)
      post: {
        dayOpen: day.dayOpen,
        dayHigh: day.dayHigh,
        dayHighTime: day.dayHighTime,
        dayHighAfter0930: day.dayHighAfter0930,
        dayHighAfter0930Time: day.dayHighAfter0930Time,
        closeAtEnd: day.closeAtEnd,
        ret10FromOpen: ret10FromOpen != null ? Number(ret10FromOpen.toFixed(2)) : null,
        ret10From0930: ret10From0930 != null ? Number(ret10From0930.toFixed(2)) : null,
        closeReturnFrom0930: Number(closeReturnFrom0930.toFixed(2)),
        closeReturnFromOpen: Number(closeReturnFromOpen.toFixed(2)),
        hit10FromOpen, hit10From0930, hit10FromAnyEntry,
        firstHit10FromOpen_Time: day.firstHit10FromOpen_Time,
        firstHit10From0930_Time: day.firstHit10From0930_Time,
        rebreak0930HighTime,
        bar1000Close: day.bar1000Close,
        hold1000,
        triggerOutcomes,
      },
    });
  }

  return { dirName, profiles };
}

// ── 통계 헬퍼 ──
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function avg(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null; }
function rate(n, total) { return total > 0 ? Number((n / total * 100).toFixed(1)) : 0; }

function commonRanges(profiles) {
  if (profiles.length === 0) return null;
  const v_0930   = profiles.map((p) => p.pre.value_0930).filter((x) => x > 0);
  const ratio    = profiles.map((p) => p.pre.valueToAvgRatio_0930).filter((x) => x != null);
  const cp       = profiles.map((p) => p.pre.closePosition0930).filter((x) => x != null);
  const drop     = profiles.map((p) => p.pre.highToLastDrop).filter((x) => x != null);
  const upRate   = profiles.map((p) => p.pre.openToLastRate).filter((x) => x != null);
  const mc       = profiles.map((p) => p.marketCap).filter((x) => x > 0);
  const reb      = profiles.map((p) => p.post.rebreak0930HighTime).filter(Boolean).sort();
  const vToMc    = profiles.map((p) => p.pre.valueToMcRatio_0930).filter((x) => x != null);

  function fmtMedTime(arr) {
    if (arr.length === 0) return null;
    return arr[Math.floor(arr.length / 2)];
  }

  return {
    n: profiles.length,
    value_0930:           { avg: avg(v_0930), median: median(v_0930), p25: v_0930.length ? [...v_0930].sort((a,b)=>a-b)[Math.floor(v_0930.length*0.25)] : null, p75: v_0930.length ? [...v_0930].sort((a,b)=>a-b)[Math.floor(v_0930.length*0.75)] : null },
    valueToAvgRatio_0930: { avg: avg(ratio), median: median(ratio) },
    closePosition0930:    { avg: avg(cp), median: median(cp) },
    highToLastDrop:       { avg: avg(drop), median: median(drop) },
    openToLastRate:       { avg: avg(upRate), median: median(upRate) },
    marketCap:            { avg: avg(mc), median: median(mc) },
    valueToMcRatio_0930:  { avg: avg(vToMc), median: median(vToMc) },
    rebreak0930HighTime_median: fmtMedTime(reb),
    rebreakMorningHighRate: rate(profiles.filter((p) => p.pre.rebreakMorningHigh).length, profiles.length),
    hold1000Rate:         rate(profiles.filter((p) => p.post.hold1000).length, profiles.length),
  };
}

function statusDistribution(profiles) {
  const out = {};
  for (const p of profiles) {
    const key = p.pre.isExplosiveTop ? 'explosiveTop' : p.pre.status;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
function hypoDistribution(profiles) {
  const out = { TEN_REBREAK: 0, FADED_RECOVERY: 0, SECOND_VALUE_SURGE: 0, TEN_SURVIVOR: 0, MORNING_TREND: 0, none: 0 };
  for (const p of profiles) {
    if (p.pre.triggeredHypos.length === 0) out.none++;
    for (const h of p.pre.triggeredHypos) out[h] = (out[h] || 0) + 1;
  }
  return out;
}

function mcBandDistribution(profiles) {
  const out = {};
  for (const p of profiles) out[p.mcBand] = (out[p.mcBand] || 0) + 1;
  return out;
}

// ── 공격형 보조 후보 조건 제안 ──
function buildAggressiveCriteria(winners) {
  // explosiveTop이 놓친 winners 중 공통 조건 추출
  const missed = winners.filter((p) => !p.pre.isExplosiveTop);
  if (missed.length < 5) {
    return {
      n: missed.length,
      note: '놓친 표본이 너무 적어 신뢰할 만한 보조 조건 도출 불가',
      proposedCriteria: null,
    };
  }
  const ranges = commonRanges(missed);
  // p25 / median 기준으로 보조 조건 제안 — "넓게 잡되 극단 제거"
  const v25 = ranges.value_0930.p25 || 0;
  const cpMed = ranges.closePosition0930.median || 0;
  const dropMed = ranges.highToLastDrop.median || 0;
  const upMed = ranges.openToLastRate.median || 0;
  const ratioMed = ranges.valueToAvgRatio_0930.median || 0;

  // 제안 조건 — explosiveTop보다 완화
  return {
    n: missed.length,
    note: '놓친 +10% 종목들의 p25~중앙값 기준으로 도출. explosiveTop보다 완화된 조건.',
    proposedCriteria: {
      MIN_VALUE_0930:       Math.max(2e9, Math.round(v25 / 1e8) * 1e8),    // p25, 최소 20억
      MIN_CLOSE_POSITION:   Math.max(0.50, Math.floor(cpMed * 20) / 20),   // 중앙값, 최소 0.5
      MAX_HIGH_TO_LAST_DROP: Math.min(-1.0, Math.round(dropMed * 10) / 10),
      MIN_OPEN_TO_LAST_RATE: Math.max(0.5, Math.floor(upMed * 2) / 2),
      MIN_VALUE_AVG_RATIO:  Math.max(2.0, Math.round(ratioMed)),
      requires: [
        'rebreakMorningHigh = true (놓친 종목 중 비율 검토)',
        'status = READY OR FADED (drop 완화)',
        'marketCap <= 5조 (1DS 동일)',
      ],
    },
    mcDistribution: mcBandDistribution(missed),
    statusDistribution: statusDistribution(missed),
    hypoDistribution: hypoDistribution(missed),
  };
}

// ── HTML ──
function renderHtml(out) {
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
  function fmtNum(v, d = 0) { if (v == null || !Number.isFinite(v)) return '-'; return Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }); }
  function fmtPct(v) { if (v == null || !Number.isFinite(v)) return '-'; const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : ''; return `<span class="${cls}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`; }
  function fmt억(v) { if (v == null) return '-'; return (v / 1e8).toFixed(1) + '억'; }
  function fmt조(v) { if (v == null) return '-'; return (v / 1e12).toFixed(2) + '조'; }

  function tableWinnerList(winners, limit) {
    const list = [...winners].sort((a, b) => (b.post.ret10From0930 || 0) - (a.post.ret10From0930 || 0)).slice(0, limit);
    const rows = list.map((p) => {
      const flags = [];
      if (p.pre.isExplosiveTop) flags.push('<span class="tag tag-exp">EXPLOSIVE</span>');
      if (p.pre.rebreakMorningHigh) flags.push('<span class="tag tag-reb">MH재돌파</span>');
      const hypos = p.pre.triggeredHypos.map((h) => `<span class="tag tag-hyp">${esc(h)}</span>`).join(' ');
      return `<tr>
        <td>${esc(p.date)}</td>
        <td>${esc(p.code)} <small>${esc(p.name)}</small></td>
        <td>${esc(p.pre.status)}${flags.length ? ' ' + flags.join(' ') : ''}</td>
        <td>${hypos}</td>
        <td class="num">${fmt억(p.pre.value_0930)}</td>
        <td class="num">${(p.pre.valueToAvgRatio_0930 || 0).toFixed(1)}×</td>
        <td class="num">${(p.pre.closePosition0930 || 0).toFixed(2)}</td>
        <td class="num">${fmtPct(p.pre.openToLastRate)}</td>
        <td class="num">${fmtPct(p.pre.highToLastDrop)}</td>
        <td class="num">${fmt조(p.marketCap)}</td>
        <td class="num post">${fmtPct(p.post.ret10From0930)}</td>
        <td class="num post">${esc(p.post.firstHit10From0930_Time || '-')}</td>
        <td class="num post">${esc(p.post.rebreak0930HighTime || '-')}</td>
        <td class="num post">${fmtPct(p.post.closeReturnFrom0930)}</td>
      </tr>`;
    }).join('');
    return `<table class="winners"><thead><tr>
      <th>날짜</th><th>코드/명</th>
      <th>상태</th><th>가설</th>
      <th>값09:30</th><th>v/avg</th><th>cp</th><th>open→last</th><th>drop</th><th>시총</th>
      <th class="post">최대(↑0930)</th><th class="post">+10%도달</th><th class="post">MH재돌파</th><th class="post">종가수익</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function dictTable(obj, sortByValue = true) {
    let entries = Object.entries(obj || {});
    if (sortByValue) entries.sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    return `<table class="dict"><thead><tr><th>키</th><th>개수</th><th>비중</th></tr></thead><tbody>
      ${entries.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td><td class="num">${total > 0 ? ((v/total)*100).toFixed(1) + '%' : '-'}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function rangeTable(r) {
    if (!r) return '<p style="color:#888;">샘플 없음</p>';
    return `<table class="ranges"><thead><tr><th>지표</th><th>중앙값</th><th>평균</th></tr></thead><tbody>
      <tr><td>09:30 거래대금</td><td class="num">${fmt억(r.value_0930.median)}</td><td class="num">${fmt억(r.value_0930.avg)}</td></tr>
      <tr><td>v/avg30 비율</td><td class="num">${(r.valueToAvgRatio_0930.median || 0).toFixed(1)}×</td><td class="num">${(r.valueToAvgRatio_0930.avg || 0).toFixed(1)}×</td></tr>
      <tr><td>closePosition0930</td><td class="num">${(r.closePosition0930.median || 0).toFixed(2)}</td><td class="num">${(r.closePosition0930.avg || 0).toFixed(2)}</td></tr>
      <tr><td>highToLastDrop</td><td class="num">${(r.highToLastDrop.median || 0).toFixed(2)}%</td><td class="num">${(r.highToLastDrop.avg || 0).toFixed(2)}%</td></tr>
      <tr><td>openToLastRate</td><td class="num">${(r.openToLastRate.median || 0).toFixed(2)}%</td><td class="num">${(r.openToLastRate.avg || 0).toFixed(2)}%</td></tr>
      <tr><td>시총</td><td class="num">${fmt조(r.marketCap.median)}</td><td class="num">${fmt조(r.marketCap.avg)}</td></tr>
      <tr><td>09:30 거래대금 / 시총</td><td class="num">${((r.valueToMcRatio_0930.median || 0) * 100).toFixed(2)}%</td><td class="num">${((r.valueToMcRatio_0930.avg || 0) * 100).toFixed(2)}%</td></tr>
      <tr><td>09:30 high 재돌파 시간 (중앙)</td><td colspan="2" class="num">${esc(r.rebreak0930HighTime_median || '-')}</td></tr>
      <tr><td>rebreakMorningHigh 비율</td><td colspan="2" class="num">${r.rebreakMorningHighRate}%</td></tr>
      <tr><td>10:00 close > 09:30 close 비율</td><td colspan="2" class="num">${r.hold1000Rate}%</td></tr>
    </tbody></table>`;
  }

  const winners0930 = out.winnersByBucket.from0930;
  const winnersOpen = out.winnersByBucket.fromOpen;
  const winnersEntry = out.winnersByBucket.fromEntry;

  const summaryLines = out.conclusion.lines.map((l) => `<li>${esc(l)}</li>`).join('');

  const proposed = out.aggressiveCriteria.proposedCriteria;
  const proposedBlock = proposed ? `
    <table class="proposed"><tbody>
      <tr><td>MIN_VALUE_0930</td><td>${fmt억(proposed.MIN_VALUE_0930)}</td></tr>
      <tr><td>MIN_CLOSE_POSITION</td><td>${proposed.MIN_CLOSE_POSITION.toFixed(2)}</td></tr>
      <tr><td>MAX_HIGH_TO_LAST_DROP</td><td>${proposed.MAX_HIGH_TO_LAST_DROP.toFixed(2)}%</td></tr>
      <tr><td>MIN_OPEN_TO_LAST_RATE</td><td>${proposed.MIN_OPEN_TO_LAST_RATE.toFixed(2)}%</td></tr>
      <tr><td>MIN_VALUE_AVG_RATIO</td><td>${proposed.MIN_VALUE_AVG_RATIO}</td></tr>
      <tr><td>추가 조건</td><td><ul style="margin:0;padding-left:18px;">${proposed.requires.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></td></tr>
    </tbody></table>` : `<p style="color:#888;">${esc(out.aggressiveCriteria.note)}</p>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>1DS — +10% Winner Profile</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; max-width: 1600px; margin: 0 auto; color: #222; background: #fafafa; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #ddd; }
  h3 { font-size: 14px; margin: 14px 0 6px; color: #444; }
  .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
  .summary { background: #fff; padding: 12px 16px; border-radius: 6px; border: 1px solid #e0e0e0; margin-bottom: 18px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 11.5px; margin-bottom: 14px; }
  th, td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; font-weight: 600; }
  th.post, td.post { background: #fff8e1; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #c62828; }
  .neg { color: #1565c0; }
  ul { padding-left: 20px; } li { margin: 3px 0; font-size: 13px; }
  .tag { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; margin-right: 2px; }
  .tag-exp { background: #ffe082; color: #6d4c41; }
  .tag-reb { background: #c8e6c9; color: #1b5e20; }
  .tag-hyp { background: #e1bee7; color: #4a148c; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  small { color: #666; }
  .ranges td:first-child { background: #f9f9f9; }
  .proposed td:first-child { background: #fff3e0; font-weight: 600; }
  .note { font-size: 11px; color: #888; }
</style>
</head>
<body>
<h1>1DS — +10% Winner Profile 보고서</h1>
<div class="meta">
  생성: ${out.meta.generatedAt} · 백테스트 대상: ${out.meta.totalDays}일 (${out.meta.datesAnalyzed[0]} ~ ${out.meta.datesAnalyzed[out.meta.datesAnalyzed.length - 1]}) · 소요 ${out.meta.elapsedSec}s
  <div class="note">사전 정보(09:30 시점까지 확정) vs 사후 정보(당일 종료 후 확정) — HTML 표에서 노란 배경 컬럼이 사후.</div>
</div>

<div class="summary">
  <h2 style="margin-top:0;border:none;">1. 요약 결론</h2>
  <ul>${summaryLines}</ul>
</div>

<h2>2. +10% 이상 종목 — 기준별 개수</h2>
<table class="dict"><thead><tr><th>+10% 기준</th><th>n</th><th>일평균</th><th>유니크 (date,code) 수</th></tr></thead><tbody>
  <tr><td>A. 09:30 close 대비</td><td class="num">${out.winnersByBucket.from0930.length}</td><td class="num">${(out.winnersByBucket.from0930.length / out.meta.totalDays).toFixed(2)}</td><td class="num">${out.winnersByBucket.from0930.length}</td></tr>
  <tr><td>B. 당일 시가 대비</td><td class="num">${out.winnersByBucket.fromOpen.length}</td><td class="num">${(out.winnersByBucket.fromOpen.length / out.meta.totalDays).toFixed(2)}</td><td class="num">${out.winnersByBucket.fromOpen.length}</td></tr>
  <tr><td>C. 가설 entryPrice 대비 (any)</td><td class="num">${out.winnersByBucket.fromEntry.length}</td><td class="num">${(out.winnersByBucket.fromEntry.length / out.meta.totalDays).toFixed(2)}</td><td class="num">${out.winnersByBucket.fromEntry.length}</td></tr>
</tbody></table>

<h3>A. 09:30 close 대비 +10% 종목 목록 (상위 80건, ret 내림차순)</h3>
${tableWinnerList(winners0930, 80)}

<h2>3. 상태별 분포 (09:30 close 기준 +10% 종목)</h2>
<div class="grid">
  <div>
    <h3>상태 (READY / FADED / WAIT_PULLBACK / WEAK / explosiveTop)</h3>
    ${dictTable(out.summary.from0930.statusDistribution)}
  </div>
  <div>
    <h3>시총 구간</h3>
    ${dictTable(out.summary.from0930.mcBandDistribution)}
  </div>
</div>

<h2>4. 가설별 분포 (09:30 close 기준 +10% 종목)</h2>
${dictTable(out.summary.from0930.hypoDistribution)}
<p class="note">한 종목이 여러 가설에 잡히면 각각 카운트됨. "none" = 어떤 가설에도 트리거 안 됨.</p>

<h2>5. +10% 종목의 공통 조건 범위 (09:30 close 기준)</h2>
${rangeTable(out.summary.from0930.commonRanges)}

<h2>6. explosiveTop이 놓친 +10% 종목 분석</h2>
<p>전체 +10% 종목 ${out.winnersByBucket.from0930.length}개 중 explosiveTop 통과 ${out.summary.from0930.explosiveCovered}개 / 놓침 ${out.summary.from0930.explosiveMissed}개 (coverage ${out.summary.from0930.explosiveCoverageRate}%)</p>
<div class="grid">
  <div>
    <h3>놓친 종목 — 상태 분포</h3>
    ${dictTable(out.aggressiveCriteria.statusDistribution)}
  </div>
  <div>
    <h3>놓친 종목 — 가설 분포</h3>
    ${dictTable(out.aggressiveCriteria.hypoDistribution)}
  </div>
</div>
<h3>놓친 종목 — 공통 조건 범위</h3>
${rangeTable(out.summary.from0930_missed.commonRanges)}
<h3>놓친 종목 — 시총 구간</h3>
${dictTable(out.aggressiveCriteria.mcDistribution)}

<h3>놓친 +10% 종목 목록 (상위 80건)</h3>
${tableWinnerList(out.summary.from0930_missed.profiles, 80)}

<h2>7. 공격형 보조 후보 조건 제안</h2>
${proposedBlock}
<p class="note">${esc(out.aggressiveCriteria.note)}</p>

<div class="note" style="margin-top:30px;border-top:1px dashed #ccc;padding-top:10px;">
  검증 일자: ${esc(out.meta.datesAnalyzed.join(', '))}
</div>
</body>
</html>`;
}

// ── main ──
function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(INTRADAY_BASE)) { console.error('[ERROR] data/intraday/1ds 없음'); process.exit(1); }

  console.log('\n📊 1DS +10% Winner Profile 보고서');
  const t0 = Date.now();

  const metaMap = scanner.loadStockMetaMap();
  console.log(`  메타 로드: ${metaMap.size}건`);

  const hypoIdx = loadHypothesisTriggers();
  console.log(`  가설 trigger 인덱스: ${hypoIdx.size}건`);

  const allDirs = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  let dirs = allDirs;
  if (args.from) dirs = dirs.filter((d) => d >= args.from);
  if (args.to)   dirs = dirs.filter((d) => d <= args.to);
  dirs = dirs.filter((d) => fs.readdirSync(path.join(INTRADAY_BASE, d)).length >= args.minDirSize);
  if (args.days && dirs.length > args.days) dirs = dirs.slice(-args.days);
  applyDaysSuffix(args.days);
  console.log(`  분봉 디렉토리: ${dirs.length}개 (min-dir-size ${args.minDirSize}${args.days ? `, --days ${args.days}` : ''})`);
  if (dirs.length === 0) { console.error('[ERROR] 대상 일자 없음'); process.exit(1); }

  // 일자별 분석
  const allProfiles = [];
  for (const d of dirs) {
    const r = analyzeDay(d, metaMap, hypoIdx);
    if (r) allProfiles.push(...r.profiles);
  }
  console.log(`  분석된 (date, code) 페어: ${allProfiles.length}건`);

  // 3종 winners 분리
  const winners0930  = allProfiles.filter((p) => p.post.hit10From0930);
  const winnersOpen  = allProfiles.filter((p) => p.post.hit10FromOpen);
  const winnersEntry = allProfiles.filter((p) => p.post.hit10FromAnyEntry);

  console.log(`\n  +10% from 09:30 close : ${winners0930.length}건 (일평균 ${(winners0930.length / dirs.length).toFixed(2)})`);
  console.log(`  +10% from day open    : ${winnersOpen.length}건 (일평균 ${(winnersOpen.length / dirs.length).toFixed(2)})`);
  console.log(`  +10% from any entry   : ${winnersEntry.length}건 (일평균 ${(winnersEntry.length / dirs.length).toFixed(2)})`);

  // 09:30 기준 winners → status/hypo/공통조건/explosiveTop coverage
  const statusDist0930 = statusDistribution(winners0930);
  const hypoDist0930   = hypoDistribution(winners0930);
  const mcDist0930     = mcBandDistribution(winners0930);
  const ranges0930     = commonRanges(winners0930);

  const explosiveCovered = winners0930.filter((p) => p.pre.isExplosiveTop).length;
  const explosiveMissed  = winners0930.length - explosiveCovered;
  const explosiveCoverageRate = winners0930.length > 0 ? Number((explosiveCovered / winners0930.length * 100).toFixed(1)) : 0;

  // 놓친 winners 별도 분석
  const missed0930 = winners0930.filter((p) => !p.pre.isExplosiveTop);
  const ranges_missed = commonRanges(missed0930);
  const aggressive = buildAggressiveCriteria(winners0930);

  // 결론 라인
  const lines = [];
  lines.push(`+10% from 09:30 close: ${winners0930.length}건 / ${dirs.length}일 = 일평균 ${(winners0930.length / dirs.length).toFixed(2)}개`);
  lines.push(`explosiveTop coverage: ${explosiveCovered}/${winners0930.length} = ${explosiveCoverageRate}% — ${explosiveCoverageRate >= 50 ? '⭕ 절반 이상 잡음' : (explosiveCoverageRate >= 25 ? '🟡 1/4~1/2 잡음, 보조 섹션 가치 있음' : '❌ 1/4 미만, explosiveTop으로는 부족 — 공격형 보조 필수')}`);
  if (ranges0930) {
    lines.push(`+10% 종목 공통: 09:30 value 중앙 ${(ranges0930.value_0930.median / 1e8).toFixed(0)}억, v/avg ${(ranges0930.valueToAvgRatio_0930.median || 0).toFixed(1)}×, cp ${(ranges0930.closePosition0930.median || 0).toFixed(2)}, open→last ${(ranges0930.openToLastRate.median || 0).toFixed(2)}%, drop ${(ranges0930.highToLastDrop.median || 0).toFixed(2)}%, 시총 ${(ranges0930.marketCap.median / 1e12).toFixed(2)}조`);
    lines.push(`MH재돌파 비율 ${ranges0930.rebreakMorningHighRate}%, 10시 생존 비율 ${ranges0930.hold1000Rate}%`);
  }
  if (explosiveMissed > 0) {
    const topHypo = Object.entries(hypoDistribution(missed0930)).filter(([k]) => k !== 'none').sort((a, b) => b[1] - a[1])[0];
    if (topHypo) lines.push(`놓친 ${explosiveMissed}건 중 가장 잘 잡는 가설: ${topHypo[0]} (${topHypo[1]}건)`);
  }

  const out = {
    meta: {
      title: '1DS — +10% Winner Profile',
      generatedAt: new Date().toISOString(),
      datesAnalyzed: dirs,
      totalDays: dirs.length,
      minDirSize: args.minDirSize,
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(2)),
      analyzedPairs: allProfiles.length,
      criteriaDefinition: {
        A_from0930: 'maxHigh after 09:30 / 09:30 close >= 1.10',
        B_fromOpen: 'maxHigh of day / first bar open >= 1.10',
        C_fromEntry: '(per hypothesis) maxHigh after entry / entryPrice >= 1.10',
      },
      leakageGuard: '사전(pre)/사후(post) 필드를 명시적으로 분리. trigger 조건은 trigger 시점 이전 분봉만 사용 (가설 보고서에서 동일 보장). 사후 측정은 trigger 직후 분봉부터 당일 종료까지.',
    },
    winnersByBucket: {
      from0930:  winners0930,
      fromOpen:  winnersOpen,
      fromEntry: winnersEntry,
    },
    summary: {
      from0930: {
        n: winners0930.length,
        perDayAvg: Number((winners0930.length / dirs.length).toFixed(2)),
        statusDistribution: statusDist0930,
        hypoDistribution: hypoDist0930,
        mcBandDistribution: mcDist0930,
        commonRanges: ranges0930,
        explosiveCovered,
        explosiveMissed,
        explosiveCoverageRate,
      },
      fromOpen: {
        n: winnersOpen.length,
        perDayAvg: Number((winnersOpen.length / dirs.length).toFixed(2)),
        statusDistribution: statusDistribution(winnersOpen),
        hypoDistribution: hypoDistribution(winnersOpen),
        commonRanges: commonRanges(winnersOpen),
      },
      fromEntry: {
        n: winnersEntry.length,
        perDayAvg: Number((winnersEntry.length / dirs.length).toFixed(2)),
        statusDistribution: statusDistribution(winnersEntry),
        hypoDistribution: hypoDistribution(winnersEntry),
        commonRanges: commonRanges(winnersEntry),
      },
      from0930_missed: {
        n: missed0930.length,
        profiles: missed0930,
        commonRanges: ranges_missed,
        statusDistribution: statusDistribution(missed0930),
        hypoDistribution: hypoDistribution(missed0930),
        mcBandDistribution: mcBandDistribution(missed0930),
      },
    },
    aggressiveCriteria: aggressive,
    conclusion: { lines },
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, renderHtml(out), 'utf-8');

  console.log(`\n  ⏱ 소요 ${out.meta.elapsedSec}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
  console.log(`\n  📌 결론:`);
  for (const l of lines) console.log(`     ${l}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}

module.exports = { main };
