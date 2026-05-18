#!/usr/bin/env node
/**
 * QVA → VVI2_PRE_A 분봉 백테스트 검증
 *
 * 목적:
 *   일봉 PRE_A_STRONG (n=2535, 실제 VVI2 71.2%, BIG_50 20.5%, QVA2_PRE_A BIG_50 34.9%)을
 *   KIS 분봉으로 09:10/09:30/10:00/10:30/11:00/13:00/14:00 시점에 미리 감지할 수 있는지 검증.
 *
 *   strict/base/loose 3개 모드별로 시간대별 적중률, VVI2 확정률, BIG_50 비율, 종가 실패율 비교.
 *
 * 중요:
 *   - 새 운영 보드 / 라우터 / cron / 실시간 알림 만들지 않는다.
 *   - 기존 QVA1/QVA2/VVI2 로직은 변경하지 않는다.
 *   - 기존 qva-vvi2-pre-validation.js는 건드리지 않는다.
 *   - 이번은 분봉 백테스트 검증.
 *
 * 입력:
 *   - DB board_signals (QVA1/QVA2)
 *   - cache/stock-charts-long/{code}.json (일봉 — qvaClose/High/Vol/Val + D+1~D+20 일봉 결과 산정)
 *   - cache/kis-minute/{code}/{yyyymmdd}.json (KIS FHKST03010230 분봉 — 09:00~14:30 raw)
 *
 * 출력:
 *   - reports/qva-vvi2-pre-intraday-minute-validation-result.json
 *   - reports/qva-vvi2-pre-intraday-minute-validation-result.html
 *
 * 모드:
 *   --no-fetch (기본)      cache에서만 분봉 read. 없으면 skip.
 *   --fetch                cache 없으면 KIS API 호출 → cache 저장 (운영 서버에서 실행 권장).
 *   --list-only            (code, date) 목록만 출력하고 종료. fetch/분석 X.
 *   --days N               최근 N 거래일 한정 (기본 30)
 *   --max-fetch N          한 실행에서 KIS 호출 최대 N건 (기본 0 = 무제한)
 *   --sleep N              KIS 호출 사이 ms (기본 350)
 *   --include-control      PRE_B/PRE_C/PRE_D/BREAK_FAIL/NO_PRE 일부를 비교군으로 포함 (기본은 PRE_A만)
 *   --control-cap N        비교군 grouping별 최대 N개 (기본 200)
 *   --dry-run              후보만 카운트, KIS 호출도 분석도 X
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { query, closePool, isEnabled } = require(path.join(ROOT, 'src', 'db', 'mysql'));
const { findVvi2AfterQva2 } = require(path.join(ROOT, 'boards', 'qva2', 'qva2-screener'));
const { getMinuteBarsForDate } = require(path.join(ROOT, 'src', 'services', 'kis', 'kisMinuteBars'));
const { getAccessToken } = require(path.join(ROOT, 'src', 'services', 'kis', 'kisToken'));

const CHART_DIR    = path.join(ROOT, 'cache', 'stock-charts-long');
const MINUTE_DIR   = path.join(ROOT, 'cache', 'kis-minute');
const OUT_JSON     = path.join(ROOT, 'reports', 'qva-vvi2-pre-intraday-minute-validation-result.json');
const OUT_HTML     = path.join(ROOT, 'reports', 'qva-vvi2-pre-intraday-minute-validation-result.html');
const LIST_OUTPUT  = path.join(ROOT, 'reports', 'qva-vvi2-pre-intraday-needed-list.json');

const FOLLOW_DAYS = 20;

// 검증 시점 (HHMMSS) — bar의 stck_cntg_hour와 직접 비교
const SNAPSHOT_TIMES = [
  { label: '09:10', hhmmss: '091000' },
  { label: '09:30', hhmmss: '093000' },
  { label: '10:00', hhmmss: '100000' },
  { label: '10:30', hhmmss: '103000' },
  { label: '11:00', hhmmss: '110000' },
  { label: '13:00', hhmmss: '130000' },
  { label: '14:00', hhmmss: '140000' },
];
// 시간대별 누적 거래량/거래대금 임계값 (base 모드)
const RATIO_THRESHOLD_BY_TIME = {
  '09:10': 0.25,
  '09:30': 0.40,
  '10:00': 0.60,
  '10:30': 0.75,
  '11:00': 0.90,
  '13:00': 1.00,
  '14:00': 1.00,
};
// 3개 KIS 호출로 09:00~14:30 분봉 커버
const FETCH_END_HOURS = ['103000', '123000', '143000'];

// ─── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    fetch: false,
    listOnly: false,
    days: 30,
    maxFetch: 0,
    sleepMs: 350,
    includeControl: false,
    controlCap: 200,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--fetch')            a.fetch = true;
    else if (k === '--no-fetch')    a.fetch = false;
    else if (k === '--list-only')   a.listOnly = true;
    else if (k === '--days')        a.days = parseInt(argv[++i], 10) || 30;
    else if (k === '--max-fetch')   a.maxFetch = parseInt(argv[++i], 10) || 0;
    else if (k === '--sleep')       a.sleepMs = parseInt(argv[++i], 10) || 350;
    else if (k === '--include-control') a.includeControl = true;
    else if (k === '--control-cap') a.controlCap = parseInt(argv[++i], 10) || 200;
    else if (k === '--dry-run')     a.dryRun = true;
    else if (k === '--help' || k === '-h') {
      console.log(`Usage: node qva-vvi2-pre-intraday-minute-validation.js [options]
  --no-fetch (기본)    cache에서만 read
  --fetch              KIS API 호출 (운영 서버에서 권장)
  --list-only          후보 (code,date) 목록만 출력
  --days N             최근 N 거래일 한정 (기본 30)
  --max-fetch N        한 실행에서 KIS 호출 최대 N건 (기본 0 = 무제한)
  --sleep N            KIS 호출 사이 ms (기본 350)
  --include-control    PRE_B/C/D/BREAK_FAIL/NO_PRE 비교군 포함
  --control-cap N      비교군 grouping별 최대 N개 (기본 200)
  --dry-run            후보 카운트만`);
      process.exit(0);
    }
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 유틸 ────────────────────────────────────────────────────────────────
function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}
function pct(num, denom) {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return null;
  return Number(((num / denom - 1) * 100).toFixed(2));
}
function fmtPct(v, p = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + Number(v).toFixed(p) + '%';
}
function fmtInt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString();
}
function fmtRatio(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(2) + 'x';
}
function ymdDash(ymd) {
  const s = String(ymd);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}
function avg(arr) {
  const xs = arr.filter(v => Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}
function rate(num, denom) { return denom > 0 ? Number((num / denom * 100).toFixed(1)) : 0; }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sampleQualityOf(n) {
  if (n >= 300) return '신뢰가능';
  if (n >= 100) return '참고가능';
  if (n >=  30) return '표본작음';
  return '해석주의';
}
function sampleQualityPill(q) {
  const map = { '신뢰가능': 'p-good', '참고가능': 'p-q2', '표본작음': 'p-neu', '해석주의': 'p-warn' };
  return `<span class="pill ${map[q] || 'p-neu'}">${esc(q)}</span>`;
}
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

// 일봉 PRE 분류 (qva-vvi2-pre-validation.js와 동일 로직)
function classifyDailyPre(d) {
  const { intradayBreakQvaHigh, valueNearQva, valueOverQva, volumeNearQva, volumeOverQva, closeHoldQvaHigh, closeNearQvaHigh } = d;
  if (intradayBreakQvaHigh && valueOverQva  && volumeOverQva  && closeHoldQvaHigh) return 'PRE_A_STRONG';
  if (intradayBreakQvaHigh && valueNearQva  && volumeNearQva  && closeNearQvaHigh) return 'PRE_B_EARLY';
  if (intradayBreakQvaHigh && valueNearQva  && volumeNearQva  && !closeHoldQvaHigh) return 'PRE_C_INTRADAY_ONLY';
  if (!intradayBreakQvaHigh && valueOverQva && volumeOverQva) return 'PRE_D_VALUE_ONLY';
  if (intradayBreakQvaHigh && !closeNearQvaHigh) return 'BREAK_FAIL';
  return 'NO_PRE';
}

// ─── 분봉 cache 로드/저장 ───────────────────────────────────────────────
function minuteCachePath(code, ymd) {
  return path.join(MINUTE_DIR, code, ymd + '.json');
}
function loadMinuteCache(code, ymd) {
  const fp = minuteCachePath(code, ymd);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}
function saveMinuteCache(code, ymd, payload) {
  const fp = minuteCachePath(code, ymd);
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, JSON.stringify(payload, null, 0));
}

// ─── 후보 분봉 fetch ─────────────────────────────────────────────────────
async function fetchMinuteForDate(accessToken, code, ymd, sleepMs) {
  const allRaw = [];
  let meta = null;
  for (const endHour of FETCH_END_HOURS) {
    const { meta: m, raw } = await getMinuteBarsForDate(accessToken, code, ymd, endHour);
    if (!meta) meta = m;
    allRaw.push(...raw);
    await sleep(sleepMs);
  }
  // 시간 키 dedup + 시간 오름차순
  const map = new Map();
  for (const b of allRaw) {
    const key = (b.stck_bsop_date || '') + (b.stck_cntg_hour || '');
    if (!map.has(key)) map.set(key, b);
  }
  const sorted = [...map.values()]
    .filter(b => b.stck_bsop_date === ymd)
    .sort((a, b) => (a.stck_cntg_hour || '').localeCompare(b.stck_cntg_hour || ''));
  return { meta, raw: sorted, fetchedAt: new Date().toISOString() };
}

// ─── 분봉 raw → snapshot 계산 ───────────────────────────────────────────
function buildSnapshots(rawBars, qvaHigh, qvaVolume, qvaValue) {
  // 정규화
  const bars = rawBars.map(r => ({
    hhmmss: r.stck_cntg_hour,
    open:  Number(r.stck_oprc) || null,
    high:  Number(r.stck_hgpr) || null,
    low:   Number(r.stck_lwpr) || null,
    close: Number(r.stck_prpr) || null,
    volume: Number(r.cntg_vol) || 0,
    acmlValue: Number(r.acml_tr_pbmn) || 0,
  })).filter(b => b.hhmmss && b.close);

  const snapshots = [];
  let cumVol = 0;
  let prevAcmlValue = 0;
  // bars는 오름차순 — 각 snapshotTime 직전 마지막 bar 찾기
  for (const snap of SNAPSHOT_TIMES) {
    // snapshot 시각 이하 마지막 bar의 인덱스
    let lastIdx = -1;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].hhmmss <= snap.hhmmss) lastIdx = i; else break;
    }
    if (lastIdx < 0) {
      snapshots.push({ snapshotTime: snap.label, hhmmss: snap.hhmmss, minuteCount: 0, dataQuality: 'NO_DATA' });
      continue;
    }
    // cumVol을 lastIdx까지 누적
    cumVol = 0;
    for (let i = 0; i <= lastIdx; i++) cumVol += (bars[i].volume || 0);
    let highSoFar = -Infinity, lowSoFar = Infinity;
    let brokenQvaHighSoFar = false;
    for (let i = 0; i <= lastIdx; i++) {
      if (bars[i].high != null && bars[i].high > highSoFar) highSoFar = bars[i].high;
      if (bars[i].low  != null && bars[i].low  < lowSoFar)  lowSoFar  = bars[i].low;
      if (bars[i].high >= qvaHigh) brokenQvaHighSoFar = true;
    }
    const lastBar = bars[lastIdx];
    const lastPrice = lastBar.close;
    const valueSoFar = lastBar.acmlValue || prevAcmlValue;
    prevAcmlValue = valueSoFar;

    const isAboveQvaHighNow   = lastPrice >= qvaHigh;
    const isHoldingQvaHighNow = lastPrice >= qvaHigh;
    const hasBrokenQvaHighSoFar = brokenQvaHighSoFar;
    const valueToQvaRatioSoFar  = qvaValue  > 0 ? Number((valueSoFar / qvaValue).toFixed(3))  : null;
    const volumeToQvaRatioSoFar = qvaVolume > 0 ? Number((cumVol     / qvaVolume).toFixed(3)) : null;

    // dataQuality
    let dataQuality;
    if (lastBar.hhmmss === snap.hhmmss) dataQuality = 'COMPLETE';
    else if (lastBar.hhmmss < snap.hhmmss && Number(snap.hhmmss) - Number(lastBar.hhmmss) <= 200) dataQuality = 'COMPLETE'; // 1~2분 차이 OK
    else dataQuality = 'PARTIAL';

    snapshots.push({
      snapshotTime: snap.label, hhmmss: snap.hhmmss,
      lastPrice,
      highSoFar: highSoFar === -Infinity ? null : highSoFar,
      lowSoFar:  lowSoFar  === Infinity  ? null : lowSoFar,
      volumeSoFar: cumVol,
      valueSoFar,
      valueEstimated: false,
      valueToQvaRatioSoFar,
      volumeToQvaRatioSoFar,
      highToQvaHighPct:  pct(highSoFar, qvaHigh),
      priceToQvaHighPct: pct(lastPrice, qvaHigh),
      isAboveQvaHighNow,
      hasBrokenQvaHighSoFar,
      isHoldingQvaHighNow,
      minuteCount: lastIdx + 1,
      dataQuality,
      // 최근 3개 bar 중 종가가 qvaHigh 이상인 개수 (strict 모드용)
      last3HoldCount: bars.slice(Math.max(0, lastIdx - 2), lastIdx + 1).filter(b => b.close >= qvaHigh).length,
      last3HoldQvaHigh: bars.slice(Math.max(0, lastIdx - 2), lastIdx + 1).filter(b => b.close >= qvaHigh).length >= 2,
    });
  }
  return snapshots;
}

// ─── snapshot → strict/base/loose 분류 ──────────────────────────────────
function classifyIntradayPreA(snap) {
  if (!snap || snap.dataQuality === 'NO_DATA') return { strict: false, base: false, loose: false };
  const thr = RATIO_THRESHOLD_BY_TIME[snap.snapshotTime];
  if (thr == null) return { strict: false, base: false, loose: false };
  const qvaHighPrice = snap.priceToQvaHighPct;
  // base
  const baseTime = snap.snapshotTime;
  let basePriceOk;
  if (baseTime === '09:10' || baseTime === '09:30') basePriceOk = qvaHighPrice != null && qvaHighPrice >= -1.0;
  else basePriceOk = snap.isAboveQvaHighNow;
  const base = snap.hasBrokenQvaHighSoFar
            && basePriceOk
            && (snap.valueToQvaRatioSoFar  ?? 0) >= thr
            && (snap.volumeToQvaRatioSoFar ?? 0) >= thr;
  // loose
  const loose = snap.hasBrokenQvaHighSoFar
             && qvaHighPrice != null && qvaHighPrice >= -1.5
             && (snap.valueToQvaRatioSoFar  ?? 0) >= thr * 0.8
             && (snap.volumeToQvaRatioSoFar ?? 0) >= thr * 0.8;
  // strict
  const strict = snap.hasBrokenQvaHighSoFar
              && snap.isAboveQvaHighNow
              && (snap.valueToQvaRatioSoFar  ?? 0) >= thr
              && (snap.volumeToQvaRatioSoFar ?? 0) >= thr
              && snap.last3HoldQvaHigh;
  return { strict, base, loose };
}

// ─── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (!isEnabled()) { console.error('❌ .env DB_* 미설정'); process.exit(1); }
  console.log('🔍 QVA → VVI2_PRE_A 분봉 백테스트 검증 시작');
  console.log(`   mode: ${args.fetch ? 'FETCH' : 'NO-FETCH'} ${args.listOnly ? '(LIST_ONLY)' : ''} ${args.dryRun ? '(DRY_RUN)' : ''} / days=${args.days} / maxFetch=${args.maxFetch || '∞'} / sleep=${args.sleepMs}ms`);
  const t0 = Date.now();

  // 1. QVA 신호 로드
  const qvaRows = await query(`
    SELECT signal_date, board_name, signal_kind, stock_code, stock_name
    FROM board_signals
    WHERE (board_name = 'QVA_WATCHLIST'  AND signal_kind = 'QVA_NEW')
       OR (board_name = 'QVA2_WATCHLIST' AND signal_kind = 'QVA2_NEW')
    ORDER BY signal_date, stock_code
  `);
  console.log(`  QVA 신호 ${qvaRows.length}건 로드`);

  // 2. 일봉으로 D+1~D+10 동안 dailyPreA 산출 → 후보 (code, dayDate) pair 작성
  const chartCache = new Map();
  function getChart(code) {
    if (chartCache.has(code)) return chartCache.get(code);
    const c = loadChart(code);
    chartCache.set(code, c);
    return c;
  }

  // days 윈도우: 최근 N 거래일
  // 모든 chart의 마지막 rows.date를 보고 거래일 추출 (어느 chart든 같은 거래일 캘린더)
  const dateSet = new Set();
  for (const r of qvaRows.slice(0, 200)) {
    const c = getChart(r.stock_code);
    if (c && c.rows) for (const row of c.rows) if (row.date) dateSet.add(String(row.date));
  }
  const allDates = [...dateSet].sort();
  const recentCutoff = args.days > 0 && allDates.length > args.days ? allDates[allDates.length - args.days] : '00000000';

  const candidates = []; // { code, name, qvaType, qvaDate, qvaIdx, qvaClose, qvaHigh, qvaVolume, qvaValue, dayDate, dayIdx, daysFromQva, dayPreGroup, dayClose, dayHigh, dayVolume, dayValue, isDailyPreA, ... }
  for (const qva of qvaRows) {
    const code = qva.stock_code;
    const qvaType = qva.board_name === 'QVA_WATCHLIST' ? 'QVA1' : 'QVA2';
    const qvaDate = String(qva.signal_date).slice(0,10);
    const qvaDateYMD = qvaDate.replace(/-/g, '');
    const chart = getChart(code);
    if (!chart || !chart.rows) continue;
    const rows = chart.rows;
    const qvaIdx = rows.findIndex(r => String(r.date) === qvaDateYMD);
    if (qvaIdx < 0) continue;
    const qvaRow = rows[qvaIdx];
    const qvaClose  = qvaRow.close;
    const qvaHigh   = qvaRow.high;
    const qvaVolume = qvaRow.volume || 0;
    const qvaValue  = qvaRow.valueApprox || (qvaRow.close * (qvaRow.volume || 0));
    if (!qvaClose || !qvaHigh || qvaVolume <= 0 || qvaValue <= 0) continue;

    let minClose = qvaClose;
    for (let d = 1; d <= 10; d++) {
      const idx = qvaIdx + d;
      if (idx >= rows.length) break;
      const row = rows[idx];
      if (Number.isFinite(row.close)) minClose = Math.min(minClose, row.close);
      const dayHigh = row.high;
      const dayClose = row.close;
      const dayVolume = row.volume || 0;
      const dayValue  = row.valueApprox || (dayClose * dayVolume);
      const ymd = String(row.date);
      if (ymd < recentCutoff) continue;

      const intradayBreakQvaHigh = dayHigh >= qvaHigh;
      const valueNearQva   = dayValue  >= qvaValue  * 0.7;
      const valueOverQva   = dayValue  >= qvaValue;
      const volumeNearQva  = dayVolume >= qvaVolume * 0.7;
      const volumeOverQva  = dayVolume >= qvaVolume;
      const closeHoldQvaHigh = dayClose >= qvaHigh;
      const closeNearQvaHigh = dayClose >= qvaHigh * 0.97;
      const dayPreGroup = classifyDailyPre({
        intradayBreakQvaHigh, valueNearQva, valueOverQva, volumeNearQva, volumeOverQva,
        closeHoldQvaHigh, closeNearQvaHigh,
      });
      const isDailyPreA = dayPreGroup === 'PRE_A_STRONG';

      // 기본은 PRE_A_STRONG만. --include-control이면 다른 그룹도 포함
      if (!isDailyPreA && !args.includeControl) continue;

      candidates.push({
        code, name: qva.stock_name, qvaType, qvaDate, qvaIdx,
        qvaClose, qvaHigh, qvaVolume, qvaValue,
        dayDate: ymd,
        dayIdx: idx,
        daysFromQva: d,
        dayPreGroup, isDailyPreA,
        dayOpen: row.open, dayClose, dayHigh, dayLow: row.low,
        dayVolume, dayValue,
        dayValueToQvaRatio:  qvaValue  > 0 ? Number((dayValue  / qvaValue).toFixed(3))  : null,
        dayVolumeToQvaRatio: qvaVolume > 0 ? Number((dayVolume / qvaVolume).toFixed(3)) : null,
        maxDropFromQvaCloseSoFar: pct(minClose, qvaClose),
      });
    }
  }

  // 비교군 cap
  if (args.includeControl) {
    const buckets = {};
    for (const c of candidates) {
      if (c.isDailyPreA) continue;
      buckets[c.dayPreGroup] = buckets[c.dayPreGroup] || [];
      buckets[c.dayPreGroup].push(c);
    }
    for (const k of Object.keys(buckets)) {
      if (buckets[k].length > args.controlCap) {
        const set = new Set(buckets[k].slice(args.controlCap));
        for (let i = candidates.length - 1; i >= 0; i--) {
          if (set.has(candidates[i])) candidates.splice(i, 1);
        }
      }
    }
  }

  console.log(`  후보 (code, dayDate) ${candidates.length}건 — PRE_A ${candidates.filter(c => c.isDailyPreA).length} / 비교군 ${candidates.filter(c => !c.isDailyPreA).length}`);
  if (args.days > 0) console.log(`  최근 ${args.days} 거래일 필터: ${ymdDash(recentCutoff)} 이후`);

  // 3. list-only / dry-run 처리
  if (args.listOnly) {
    const list = candidates.map(c => ({ code: c.code, name: c.name, qvaType: c.qvaType, qvaDate: c.qvaDate, dayDate: c.dayDate, daysFromQva: c.daysFromQva, dayPreGroup: c.dayPreGroup }));
    fs.writeFileSync(LIST_OUTPUT, JSON.stringify({ generatedAt: new Date().toISOString(), total: list.length, items: list }, null, 2));
    console.log(`✅ 후보 목록 JSON: ${LIST_OUTPUT}`);
    await closePool();
    return;
  }
  if (args.dryRun) {
    console.log('  dry-run — KIS 호출/분석 X');
    await closePool();
    return;
  }

  // 4. 분봉 fetch / cache load
  let accessToken = null;
  let fetchedCount = 0, cacheHitCount = 0, fetchFailCount = 0, skippedNoFetch = 0;
  const fetchFailures = [];

  // 같은 (code, dayDate)는 중복 fetch 방지 — 후보가 같은 dayDate를 공유할 수 있으므로 dedup
  const uniqKeys = new Map();
  for (const c of candidates) {
    const key = c.code + '|' + c.dayDate;
    if (!uniqKeys.has(key)) uniqKeys.set(key, c);
  }
  const uniqList = [...uniqKeys.values()];

  for (let i = 0; i < uniqList.length; i++) {
    const c = uniqList[i];
    const cached = loadMinuteCache(c.code, c.dayDate);
    if (cached && Array.isArray(cached.raw) && cached.raw.length > 0) {
      cacheHitCount++;
      continue;
    }
    if (!args.fetch) { skippedNoFetch++; continue; }
    if (args.maxFetch > 0 && fetchedCount >= args.maxFetch) {
      console.log(`  ⚠ maxFetch ${args.maxFetch} 도달 — 나머지 ${uniqList.length - i}건 cache 없이 skip`);
      skippedNoFetch += uniqList.length - i;
      break;
    }
    try {
      if (!accessToken) accessToken = await getAccessToken();
      const payload = await fetchMinuteForDate(accessToken, c.code, c.dayDate, args.sleepMs);
      if (payload.raw.length === 0) {
        fetchFailCount++;
        fetchFailures.push({ code: c.code, dayDate: c.dayDate, reason: 'empty_raw' });
      } else {
        saveMinuteCache(c.code, c.dayDate, payload);
        fetchedCount++;
        if (fetchedCount % 20 === 0) {
          console.log(`  fetch 진행: ${fetchedCount}/${uniqList.length - cacheHitCount} (cache ${cacheHitCount}, fail ${fetchFailCount})`);
        }
      }
    } catch (e) {
      fetchFailCount++;
      fetchFailures.push({ code: c.code, dayDate: c.dayDate, reason: String(e.message || e).slice(0, 200) });
      // 토큰 만료 등 치명적 오류 — 일정 횟수 이상이면 중단
      if (fetchFailCount > 50) {
        console.log(`  ⚠ 연속 실패 ${fetchFailCount}건 — fetch 중단`);
        break;
      }
    }
  }
  console.log(`  분봉 cache hit ${cacheHitCount} / 신규 fetch ${fetchedCount} / fetch fail ${fetchFailCount} / no-fetch skip ${skippedNoFetch}`);
  if (fetchFailures.length) {
    fs.writeFileSync(path.join(ROOT, 'reports', 'qva-vvi2-pre-intraday-fetch-failures.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), failures: fetchFailures }, null, 2));
  }

  // 5. 후보별 snapshot 계산 + 이후 성과 + VVI2 확정 비교
  const results = []; // { ...candidate, snapshots, snapshotClasses, isActualVvi2, ... }
  let analyzed = 0, missingMinute = 0;

  for (const c of candidates) {
    const cached = loadMinuteCache(c.code, c.dayDate);
    if (!cached || !Array.isArray(cached.raw) || cached.raw.length === 0) { missingMinute++; continue; }
    const snaps = buildSnapshots(cached.raw, c.qvaHigh, c.qvaVolume, c.qvaValue);
    const snapClasses = snaps.map(s => ({ snapshotTime: s.snapshotTime, ...classifyIntradayPreA(s) }));

    // 실제 VVI2 (absorption) 확정 검사
    const chart = getChart(c.code);
    const rows = chart.rows;
    const vvi2Res = findVvi2AfterQva2(rows, c.qvaIdx, FOLLOW_DAYS, { qva2Type: 'absorption' });
    const isActualVvi2 = vvi2Res.vvi2Idx > 0;
    const actualVvi2Date = isActualVvi2 ? ymdDash(rows[vvi2Res.vvi2Idx].date) : null;
    const sameDayVvi2Confirmed = isActualVvi2 && rows[vvi2Res.vvi2Idx].date === c.dayDate;

    // dayClose 기준 D+1~D+20 성과 (이 종목 chart에서 dayIdx 이후)
    let postMinClose = c.dayClose, postMaxHigh = c.dayClose;
    let d1=null,d3=null,d5=null,d10=null,d20=null;
    let hit10=false,hit20=false,hit30=false,hit50=false;
    let breach5=false, breach10=false;
    for (let k = 1; k <= FOLLOW_DAYS; k++) {
      const j = c.dayIdx + k;
      if (j >= rows.length) break;
      const r2 = rows[j];
      if (Number.isFinite(r2.close)) postMinClose = Math.min(postMinClose, r2.close);
      if (Number.isFinite(r2.high))  postMaxHigh  = Math.max(postMaxHigh, r2.high);
      const upSoFar = pct(postMaxHigh, c.dayClose);
      const dropSoFar = pct(postMinClose, c.dayClose);
      if (k===1)  d1=upSoFar;
      if (k===3)  d3=upSoFar;
      if (k===5)  d5=upSoFar;
      if (k===10) d10=upSoFar;
      if (k===20) d20=upSoFar;
      if (upSoFar != null) {
        if (upSoFar >= 10) hit10 = true;
        if (upSoFar >= 20) hit20 = true;
        if (upSoFar >= 30) hit30 = true;
        if (upSoFar >= 50) hit50 = true;
      }
      if (dropSoFar != null) {
        if (dropSoFar <= -5)  breach5  = true;
        if (dropSoFar <= -10) breach10 = true;
      }
    }
    // BIG_50 from QVA (qvaClose 기준)
    let qvaMaxHigh = c.qvaHigh;
    for (let k = c.qvaIdx + 1; k < Math.min(rows.length, c.qvaIdx + 1 + FOLLOW_DAYS); k++) {
      if (Number.isFinite(rows[k].high)) qvaMaxHigh = Math.max(qvaMaxHigh, rows[k].high);
    }
    const qvaMaxUp = pct(qvaMaxHigh, c.qvaClose);
    const isBig50      = qvaMaxUp != null && qvaMaxUp >= 50;
    const isSuperFire  = qvaMaxUp != null && qvaMaxUp >= 100;

    results.push({
      ...c,
      snapshots: snaps,
      snapshotClasses: snapClasses,
      isActualVvi2, actualVvi2Date, sameDayVvi2Confirmed,
      closeHoldQvaHigh: c.dayClose >= c.qvaHigh,
      d1MaxUpFromSignal: d1, d3MaxUpFromSignal: d3, d5MaxUpFromSignal: d5,
      d10MaxUpFromSignal: d10, d20MaxUpFromSignal: d20,
      hit10, hit20, hit30, hit50, breach5, breach10,
      qvaMaxUp, isBig50, isSuperFire,
    });
    analyzed++;
  }
  console.log(`  분석 ${analyzed}건 / 분봉 미존재 skip ${missingMinute}건`);

  if (analyzed === 0) {
    console.log('⚠ 분석 가능한 후보가 0건. --fetch 모드로 운영 서버에서 분봉을 받거나 --days를 줄여 다시 실행.');
    await closePool();
    return;
  }

  // 6. 시간대 × 모드별 집계
  function makeGroupForSnapshot(items, snapIdx, mode /* 'strict'|'base'|'loose' */) {
    const matched = items.filter(r => r.snapshotClasses[snapIdx] && r.snapshotClasses[snapIdx][mode]);
    const n = matched.length;
    if (n === 0) return { n: 0, sampleQuality: sampleQualityOf(0) };
    const withFollow = matched; // 모두 일봉 결과 있음
    const dailyPreAHit = matched.filter(r => r.isDailyPreA).length;
    const vvi2 = matched.filter(r => r.isActualVvi2).length;
    const sameDay = matched.filter(r => r.sameDayVvi2Confirmed).length;
    const closeHold = matched.filter(r => r.closeHoldQvaHigh).length;
    const closeFail = matched.filter(r => !r.closeHoldQvaHigh).length;
    const q1 = matched.filter(r => r.qvaType === 'QVA1').length;
    const q2 = n - q1;
    const q2items = matched.filter(r => r.qvaType === 'QVA2');
    return {
      n, sampleQuality: sampleQualityOf(n),
      dailyPreAHitRate: rate(dailyPreAHit, n),
      actualVvi2Rate:   rate(vvi2, n),
      sameDayVvi2Rate:  rate(sameDay, n),
      closeHoldRate:    rate(closeHold, n),
      closeFailRate:    rate(closeFail, n),
      hit10Rate: rate(matched.filter(r => r.hit10).length, n),
      hit20Rate: rate(matched.filter(r => r.hit20).length, n),
      hit30Rate: rate(matched.filter(r => r.hit30).length, n),
      hit50Rate: rate(matched.filter(r => r.hit50).length, n),
      avgD5:  Number((avg(withFollow.map(r => r.d5MaxUpFromSignal))  ?? 0).toFixed(2)),
      avgD20: Number((avg(withFollow.map(r => r.d20MaxUpFromSignal)) ?? 0).toFixed(2)),
      breach5Rate:  rate(matched.filter(r => r.breach5).length, n),
      breach10Rate: rate(matched.filter(r => r.breach10).length, n),
      qva1Count: q1, qva2Count: q2,
      big50Rate: rate(matched.filter(r => r.isBig50).length, n),
      superFireRate: rate(matched.filter(r => r.isSuperFire).length, n),
      qva2Big50Rate: rate(q2items.filter(r => r.isBig50).length, q2items.length || 1),
    };
  }

  function makeGroupForSnapshotNotMatch(items, snapIdx) {
    const matched = items.filter(r => r.snapshotClasses[snapIdx] && !(r.snapshotClasses[snapIdx].strict || r.snapshotClasses[snapIdx].base || r.snapshotClasses[snapIdx].loose));
    return makeGroupForSnapshot(matched.map(r => ({ ...r, snapshotClasses: r.snapshotClasses.map((s, i) => i === snapIdx ? { ...s, base: true } : s) })), snapIdx, 'base');
  }

  const snapshotStats = [];
  for (let i = 0; i < SNAPSHOT_TIMES.length; i++) {
    const t = SNAPSHOT_TIMES[i].label;
    snapshotStats.push({
      snapshotTime: t,
      strict: makeGroupForSnapshot(results, i, 'strict'),
      base:   makeGroupForSnapshot(results, i, 'base'),
      loose:  makeGroupForSnapshot(results, i, 'loose'),
      notMatch: makeGroupForSnapshotNotMatch(results, i),
    });
  }

  // QVA2 전용 시간대별
  const qva2Results = results.filter(r => r.qvaType === 'QVA2');
  const snapshotStatsQva2 = [];
  for (let i = 0; i < SNAPSHOT_TIMES.length; i++) {
    snapshotStatsQva2.push({
      snapshotTime: SNAPSHOT_TIMES[i].label,
      strict: makeGroupForSnapshot(qva2Results, i, 'strict'),
      base:   makeGroupForSnapshot(qva2Results, i, 'base'),
      loose:  makeGroupForSnapshot(qva2Results, i, 'loose'),
    });
  }

  // 7. 거짓 신호 분석 (base 모드 기준)
  function makeFalseSignalGroup(items, label, filter) {
    const matched = items.filter(filter);
    const n = matched.length;
    if (n === 0) return { group: label, n: 0 };
    return {
      group: label, n,
      sampleQuality: sampleQualityOf(n),
      dailyPreAHitRate: rate(matched.filter(r => r.isDailyPreA).length, n),
      actualVvi2Rate:   rate(matched.filter(r => r.isActualVvi2).length, n),
      closeHoldRate:    rate(matched.filter(r => r.closeHoldQvaHigh).length, n),
      hit10Rate: rate(matched.filter(r => r.hit10).length, n),
      hit20Rate: rate(matched.filter(r => r.hit20).length, n),
      big50Rate: rate(matched.filter(r => r.isBig50).length, n),
      breach10Rate: rate(matched.filter(r => r.breach10).length, n),
    };
  }
  // base 모드에서 09:30/10:00/10:30 중 하나라도 감지된 후보
  function detectedAtAny(r, times = ['09:30', '10:00', '10:30']) {
    return r.snapshotClasses.some(s => times.includes(s.snapshotTime) && s.base);
  }
  const falseSignalGroups = [
    makeFalseSignalGroup(results, 'INTRADAY_PRE_A_BUT_CLOSE_FAIL',     r => detectedAtAny(r) && !r.closeHoldQvaHigh),
    makeFalseSignalGroup(results, 'INTRADAY_PRE_A_BUT_NO_VVI2',        r => detectedAtAny(r) && !r.isActualVvi2),
    makeFalseSignalGroup(results, 'INTRADAY_PRE_A_AND_DAILY_PRE_A',    r => detectedAtAny(r) &&  r.isDailyPreA),
    makeFalseSignalGroup(results, 'INTRADAY_PRE_A_AND_ACTUAL_VVI2',    r => detectedAtAny(r) &&  r.isActualVvi2),
  ];

  // 8. 최적 시간대/모드 score Top 5
  const scores = [];
  for (let i = 0; i < SNAPSHOT_TIMES.length; i++) {
    for (const mode of ['strict', 'base', 'loose']) {
      const g = snapshotStats[i][mode];
      if (g.n < 10) continue; // 너무 작으면 제외
      const score = (g.actualVvi2Rate || 0) * 0.35
                  + (g.dailyPreAHitRate || 0) * 0.25
                  + (g.big50Rate || 0) * 0.25
                  - (g.closeFailRate || 0) * 0.15;
      scores.push({
        snapshotTime: SNAPSHOT_TIMES[i].label, mode, n: g.n,
        sampleQuality: g.sampleQuality,
        score: Number(score.toFixed(2)),
        actualVvi2Rate: g.actualVvi2Rate, dailyPreAHitRate: g.dailyPreAHitRate,
        big50Rate: g.big50Rate, closeFailRate: g.closeFailRate,
      });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  const topScores = scores.slice(0, 5);

  // 9. 대표 사례 — 5종
  function caseRow(r, snapIdx, mode, interpret) {
    const snap = r.snapshots[snapIdx] || {};
    return {
      code: r.code, name: r.name, qvaType: r.qvaType, qvaDate: r.qvaDate,
      dayDate: r.dayDate, daysFromQva: r.daysFromQva,
      snapshotTime: snap.snapshotTime, mode,
      qvaHigh: r.qvaHigh,
      lastPrice: snap.lastPrice, highSoFar: snap.highSoFar,
      valueToQvaRatio:  snap.valueToQvaRatioSoFar,
      volumeToQvaRatio: snap.volumeToQvaRatioSoFar,
      dayClose: r.dayClose,
      isDailyPreA: r.isDailyPreA,
      isActualVvi2: r.isActualVvi2,
      d5MaxUpFromSignal:  r.d5MaxUpFromSignal,
      d20MaxUpFromSignal: r.d20MaxUpFromSignal,
      isBig50: r.isBig50, isSuperFire: r.isSuperFire,
      interpret,
    };
  }
  function pickCases(filter, sortFn, n = 12, mode = 'base', snapIdx = 1 /* 09:30 */, interpretFn) {
    return results.filter(filter).slice().sort(sortFn).slice(0, n)
      .map(r => caseRow(r, snapIdx, mode, interpretFn ? interpretFn(r) : ''));
  }
  const case0930VviBig50 = pickCases(
    r => r.snapshotClasses[1].base && r.isActualVvi2 && r.isBig50,
    (a, b) => (b.qvaMaxUp||0) - (a.qvaMaxUp||0), 12, 'base', 1,
    r => '09:30 base 감지 → 종가 VVI2 확정 → BIG_50'
  );
  const case1000Vvi = pickCases(
    r => r.snapshotClasses[2].base && r.isActualVvi2,
    (a, b) => (b.qvaMaxUp||0) - (a.qvaMaxUp||0), 12, 'base', 2,
    r => '10:00 base 감지 → 종가 VVI2 확정' + (r.isBig50 ? ' → BIG_50' : '')
  );
  const case1030CloseFail = pickCases(
    r => r.snapshotClasses[3].base && !r.closeHoldQvaHigh,
    (a, b) => (b.qvaHigh - b.dayClose) - (a.qvaHigh - a.dayClose), 12, 'base', 3,
    r => '10:30 base 감지됐지만 종가 실패'
  );
  const caseQva2IntradayBig50 = pickCases(
    r => r.qvaType === 'QVA2' && (r.snapshotClasses[1].base || r.snapshotClasses[2].base) && r.isBig50,
    (a, b) => (b.qvaMaxUp||0) - (a.qvaMaxUp||0), 12, 'base', 1,
    r => 'QVA2 → 09:30/10:00 감지 → BIG_50' + (r.isSuperFire ? ' (SUPER_FIRE)' : '')
  );
  const caseDetectedButFail = pickCases(
    r => detectedAtAny(r) && r.breach10,
    (a, b) => (a.qvaMaxUp||0) - (b.qvaMaxUp||0), 12, 'base', 1,
    r => '장중 감지됐지만 -10% 이탈 (PRE_A 거짓 신호)'
  );

  // 10. 요약
  const preABase0930 = snapshotStats.find(s => s.snapshotTime === '09:30').base;
  const preABase1000 = snapshotStats.find(s => s.snapshotTime === '10:00').base;
  const preABase1030 = snapshotStats.find(s => s.snapshotTime === '10:30').base;
  const summary = {
    candidates: candidates.length,
    uniqueCodeDate: uniqList.length,
    analyzed,
    missingMinute,
    cacheHit: cacheHitCount,
    fetched: fetchedCount,
    fetchFail: fetchFailCount,
    skippedNoFetch,
    days: args.days,
    base_0930: preABase0930,
    base_1000: preABase1000,
    base_1030: preABase1030,
    topScores,
  };

  // 11. JSON / HTML 저장
  const result = {
    meta: {
      title: 'QVA → VVI2_PRE_A 분봉 백테스트 검증',
      generatedAt: new Date().toISOString(),
      followDays: FOLLOW_DAYS,
      args,
    },
    summary,
    snapshotStats,
    snapshotStatsQva2,
    falseSignalGroups,
    cases: { case0930VviBig50, case1000Vvi, case1030CloseFail, caseQva2IntradayBig50, caseDetectedButFail },
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  console.log(`✅ JSON: ${OUT_JSON}`);
  fs.writeFileSync(OUT_HTML, renderHtml(result));
  console.log(`✅ HTML: ${OUT_HTML}`);

  // 12. 콘솔 출력
  console.log();
  console.log('━'.repeat(80));
  console.log('=== QVA → VVI2_PRE_A 분봉 검증 요약 ===');
  console.log(`분봉 검증 대상: ${candidates.length}건 (uniq code-date ${uniqList.length})`);
  console.log(`분봉 데이터 확보: ${analyzed}건 (cache hit ${cacheHitCount}, new fetch ${fetchedCount}, miss ${missingMinute})`);
  if (fetchFailCount > 0) console.log(`  ⚠ fetch 실패 ${fetchFailCount}건 — reports/qva-vvi2-pre-intraday-fetch-failures.json 참고`);
  if (skippedNoFetch > 0) console.log(`  ⚠ no-fetch 모드 skip ${skippedNoFetch}건 (--fetch 옵션 또는 운영 서버에서 분봉 받기)`);
  console.log();
  function dumpSnap(label, g) {
    console.log(`${label}: n=${g.n||0} (${g.sampleQuality||'—'}) / dailyPreA 적중 ${g.dailyPreAHitRate||0}% / VVI2 ${g.actualVvi2Rate||0}% / 종가유지 ${g.closeHoldRate||0}% / BIG_50 ${g.big50Rate||0}% / -10% ${g.breach10Rate||0}%`);
  }
  dumpSnap('09:30 base', preABase0930);
  dumpSnap('10:00 base', preABase1000);
  dumpSnap('10:30 base', preABase1030);
  console.log();
  const q2_0930 = snapshotStatsQva2.find(s => s.snapshotTime === '09:30').base;
  const q2_1000 = snapshotStatsQva2.find(s => s.snapshotTime === '10:00').base;
  const q2_1030 = snapshotStatsQva2.find(s => s.snapshotTime === '10:30').base;
  console.log('QVA2 09:30~10:30 base 감지 성과:');
  dumpSnap('  QVA2 09:30', q2_0930);
  dumpSnap('  QVA2 10:00', q2_1000);
  dumpSnap('  QVA2 10:30', q2_1030);
  console.log();
  console.log('=== 최적 시간대/모드 Top 5 (score = VVI2 0.35 + PreA 0.25 + BIG_50 0.25 - closeFail 0.15) ===');
  for (let i = 0; i < topScores.length; i++) {
    const s = topScores[i];
    console.log(`  ${i+1}. ${s.snapshotTime} ${s.mode.padEnd(6)} — score ${s.score} / n=${s.n} (${s.sampleQuality}) / VVI2 ${s.actualVvi2Rate}% / PreA ${s.dailyPreAHitRate}% / BIG_50 ${s.big50Rate}% / closeFail ${s.closeFailRate}%`);
  }
  console.log();
  console.log('=== 다음 단계 추천 ===');
  if (analyzed < 30) {
    console.log('표본이 너무 작음. --fetch 모드로 운영 서버에서 분봉을 더 받아야 함.');
  } else if (topScores.length > 0) {
    const best = topScores[0];
    console.log(`최적 조합: ${best.snapshotTime} ${best.mode} (score ${best.score}, n=${best.n})`);
    console.log(`다음 단계: 이 조합으로 KIS API 실시간 호출 → 09:30/10:00 시점에 PRE_A_INTRADAY 감지 → 알림 보드 (별도 검증 필요)`);
  }
  console.log(`⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await closePool();
}

// ─── HTML 렌더 ───────────────────────────────────────────────────────────
function renderHtml(result) {
  const { meta, summary, snapshotStats, snapshotStatsQva2, falseSignalGroups, cases } = result;

  function snapRow(label, mode, g) {
    if (!g || g.n === 0) {
      return '<tr><td><b>' + esc(label) + '</b></td><td>' + esc(mode) + '</td>' +
        '<td class="num">0</td><td colspan="11" class="num">데이터 없음</td></tr>';
    }
    const vcls = (g.actualVvi2Rate || 0) >= 60 ? 'pos' : (g.actualVvi2Rate || 0) >= 40 ? 'mid' : 'neu';
    const bcls = (g.big50Rate || 0)     >= 20 ? 'pos' : (g.big50Rate || 0)     >= 10 ? 'mid' : 'neu';
    return '<tr>' +
      `<td><b>${esc(label)}</b></td>` +
      `<td><span class="pill p-${mode === 'strict' ? 'good' : mode === 'base' ? 'q2' : 'neu'}">${esc(mode)}</span></td>` +
      `<td class="num">${g.n}</td>` +
      `<td>${sampleQualityPill(g.sampleQuality)}</td>` +
      `<td class="num">${g.dailyPreAHitRate}%</td>` +
      `<td class="num ${vcls}">${g.actualVvi2Rate}%</td>` +
      `<td class="num">${g.sameDayVvi2Rate}%</td>` +
      `<td class="num">${g.closeHoldRate}%</td>` +
      `<td class="num neg">${g.closeFailRate}%</td>` +
      `<td class="num">${g.hit10Rate}%</td>` +
      `<td class="num">${g.hit20Rate}%</td>` +
      `<td class="num ${bcls}">${g.big50Rate}%</td>` +
      `<td class="num">${g.superFireRate}%</td>` +
      `<td class="num">${fmtPct(g.avgD5)}</td>` +
      `<td class="num">${fmtPct(g.avgD20)}</td>` +
      `<td class="num neg">${g.breach10Rate}%</td>` +
      `<td class="num">${g.qva1Count}/${g.qva2Count}</td>` +
      `<td class="num">${g.qva2Big50Rate||0}%</td>` +
      '</tr>';
  }

  const mainTableHead = '<table class="t"><thead><tr>' +
    '<th>시간</th><th>모드</th><th>n</th><th>표본</th>' +
    '<th>일봉 PreA 적중</th><th>실제 VVI2</th><th>same-day</th>' +
    '<th>종가 유지</th><th>종가 실패</th>' +
    '<th>+10%</th><th>+20%</th><th>BIG_50</th><th>SUPER</th>' +
    '<th>D+5 평균</th><th>D+20 평균</th><th>-10% 이탈</th>' +
    '<th>QVA1/QVA2</th><th>QVA2 BIG_50</th>' +
    '</tr></thead><tbody>';

  function buildSnapTable(stats) {
    let body = '';
    for (const s of stats) {
      body += snapRow(s.snapshotTime, 'strict', s.strict);
      body += snapRow(s.snapshotTime, 'base',   s.base);
      body += snapRow(s.snapshotTime, 'loose',  s.loose);
    }
    return mainTableHead + body + '</tbody></table>';
  }
  const snapTable     = buildSnapTable(snapshotStats);
  const snapTableQva2 = buildSnapTable(snapshotStatsQva2);

  // 거짓 신호 표
  const falseTable = '<table class="t"><thead><tr>' +
    '<th>그룹</th><th>n</th><th>표본</th><th>일봉 PreA 적중</th><th>실제 VVI2</th>' +
    '<th>종가 유지</th><th>+10%</th><th>+20%</th><th>BIG_50</th><th>-10% 이탈</th>' +
    '</tr></thead><tbody>' +
    falseSignalGroups.map(g => '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td>${g.n > 0 ? sampleQualityPill(g.sampleQuality) : '—'}</td>` +
      `<td class="num">${g.dailyPreAHitRate||0}%</td>` +
      `<td class="num">${g.actualVvi2Rate||0}%</td>` +
      `<td class="num">${g.closeHoldRate||0}%</td>` +
      `<td class="num">${g.hit10Rate||0}%</td>` +
      `<td class="num">${g.hit20Rate||0}%</td>` +
      `<td class="num pos">${g.big50Rate||0}%</td>` +
      `<td class="num neg">${g.breach10Rate||0}%</td>` +
      '</tr>').join('') + '</tbody></table>';

  // 최적 시간대 Top 5
  const topTable = '<table class="t"><thead><tr>' +
    '<th>순위</th><th>시간</th><th>모드</th><th>n</th><th>표본</th>' +
    '<th>score</th><th>VVI2</th><th>일봉 PreA</th><th>BIG_50</th><th>종가 실패</th>' +
    '</tr></thead><tbody>' +
    summary.topScores.map((s, i) => '<tr>' +
      `<td class="num">${i+1}</td>` +
      `<td><b>${esc(s.snapshotTime)}</b></td>` +
      `<td><span class="pill p-${s.mode === 'strict' ? 'good' : s.mode === 'base' ? 'q2' : 'neu'}">${esc(s.mode)}</span></td>` +
      `<td class="num">${s.n}</td>` +
      `<td>${sampleQualityPill(s.sampleQuality)}</td>` +
      `<td class="num pos"><b>${s.score}</b></td>` +
      `<td class="num">${s.actualVvi2Rate}%</td>` +
      `<td class="num">${s.dailyPreAHitRate}%</td>` +
      `<td class="num">${s.big50Rate}%</td>` +
      `<td class="num neg">${s.closeFailRate}%</td>` +
      '</tr>').join('') + '</tbody></table>';

  // 대표 사례
  function caseTable(list, emptyMsg) {
    if (!list || list.length === 0) return `<div class="empty">${esc(emptyMsg)}</div>`;
    return '<table class="t"><thead><tr>' +
      '<th>종목</th><th>QVA유형</th><th>QVA일</th><th>감지일</th><th>D+</th>' +
      '<th>시간</th><th>모드</th>' +
      '<th>QVA고가</th><th>현재가</th><th>high</th>' +
      '<th>val 비율</th><th>vol 비율</th>' +
      '<th>종가</th><th>일봉 PreA</th><th>실제 VVI2</th>' +
      '<th>D+5 max</th><th>D+20 max</th><th>BIG_50</th><th>해석</th>' +
      '</tr></thead><tbody>' +
      list.map(c => '<tr>' +
        `<td><b>${esc(c.name)}</b><div class="code">${esc(c.code)}</div></td>` +
        `<td><span class="pill ${c.qvaType === 'QVA1' ? 'p-q1' : 'p-q2'}">${c.qvaType}</span></td>` +
        `<td>${esc(c.qvaDate)}</td>` +
        `<td>${esc(ymdDash(c.dayDate))}</td>` +
        `<td class="num">D+${c.daysFromQva}</td>` +
        `<td><b>${esc(c.snapshotTime)}</b></td>` +
        `<td><span class="pill p-${c.mode === 'strict' ? 'good' : c.mode === 'base' ? 'q2' : 'neu'}">${esc(c.mode)}</span></td>` +
        `<td class="num">${fmtInt(c.qvaHigh)}</td>` +
        `<td class="num">${fmtInt(c.lastPrice)}</td>` +
        `<td class="num">${fmtInt(c.highSoFar)}</td>` +
        `<td class="num">${fmtRatio(c.valueToQvaRatio)}</td>` +
        `<td class="num">${fmtRatio(c.volumeToQvaRatio)}</td>` +
        `<td class="num">${fmtInt(c.dayClose)}</td>` +
        `<td>${c.isDailyPreA ? '<span class="pill p-good">PRE_A</span>' : '<span class="pill p-neu">—</span>'}</td>` +
        `<td>${c.isActualVvi2 ? '<span class="pill p-good">확정</span>' : '<span class="pill p-neu">미확정</span>'}</td>` +
        `<td class="num">${fmtPct(c.d5MaxUpFromSignal)}</td>` +
        `<td class="num">${fmtPct(c.d20MaxUpFromSignal)}</td>` +
        `<td>${c.isBig50 ? '<span class="pill p-good">BIG_50</span>' : '—'}${c.isSuperFire ? ' <span class="pill p-q2">SUPER</span>' : ''}</td>` +
        `<td style="font-size:11px;color:#cbd5e1;max-width:280px;">${esc(c.interpret || '')}</td>` +
        '</tr>').join('') + '</tbody></table>';
  }

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>${esc(meta.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif; background: #0f172a; color: #cbd5e1; margin: 0; padding: 18px 22px 60px; max-width: 1800px; }
  h1 { color: #f1f5f9; font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: #94a3b8; font-size: 12px; margin-bottom: 16px; }
  h2 { color: #5eead4; font-size: 17px; margin: 24px 0 10px; border-left: 4px solid #14b8a6; padding-left: 10px; }
  h3 { color: #c4b5fd; font-size: 14px; margin: 14px 0 8px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 18px; margin-bottom: 14px; }
  .card-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
  .stat { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; }
  .stat .lbl { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
  .stat .val { color: #f1f5f9; font-size: 22px; font-weight: 700; margin-top: 4px; line-height: 1.1; }
  .stat .sub { color: #94a3b8; font-size: 11px; margin-top: 2px; }
  table.t { width: 100%; border-collapse: collapse; background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; font-size: 12px; margin-bottom: 12px; }
  table.t th, table.t td { padding: 7px 9px; text-align: left; border-bottom: 1px solid #334155; color: #cbd5e1; vertical-align: top; }
  table.t th { background: #0f172a; color: #5eead4; font-weight: 600; font-size: 11px; }
  table.t td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.t td.pos { color: #86efac; font-weight: 600; }
  table.t td.mid { color: #fbbf24; font-weight: 600; }
  table.t td.neg { color: #fca5a5; }
  .code { color: #64748b; font-size: 10.5px; font-family: ui-monospace, monospace; }
  .pill { display: inline-block; padding: 1.5px 7px; border-radius: 999px; font-size: .7rem; font-weight: 600; margin: 0 2px; }
  .p-q1   { background: #052e16; color: #86efac; border: 1px solid #166534; }
  .p-q2   { background: #1e1b4b; color: #c4b5fd; border: 1px solid #4338ca; }
  .p-good { background: #064e3b; color: #a7f3d0; border: 1px solid #10b981; }
  .p-neu  { background: #0f172a; color: #64748b; border: 1px solid #334155; }
  .p-warn { background: #422006; color: #fcd34d; border: 1px solid #b45309; }
  .empty { background: rgba(0,0,0,0.3); border: 1px dashed #334155; padding: 14px; text-align: center; border-radius: 6px; color: #94a3b8; }
  .hint { color: #94a3b8; font-size: 11.5px; line-height: 1.6; margin-bottom: 8px; }
  .warn-note { background:#422006; border:1px solid #b45309; color:#fde68a; padding:10px 14px; border-radius:8px; font-size:12px; margin: 12px 0; line-height: 1.6; }
</style></head>
<body>
<h1>${esc(meta.title)}</h1>
<div class="subtitle">생성: ${esc(meta.generatedAt)} · KIS FHKST03010230 분봉 기반 · 추적 D+1~D+${meta.followDays}</div>

<div class="warn-note">
  ⚠ <b>분봉 백테스트 검증입니다.</b> 새 운영 보드/라우터/cron/실시간 알림은 만들지 않았습니다.
  분봉 부족 시 <code>--fetch</code> 모드로 운영 서버에서 분봉을 받아 cache/kis-minute/{code}/{date}.json에 저장 후 재실행.
</div>

<h2>1. 요약</h2>
<div class="card">
  <div class="card-row">
    <div class="stat"><div class="lbl">분봉 검증 대상</div><div class="val">${summary.candidates}</div><div class="sub">uniq ${summary.uniqueCodeDate}건</div></div>
    <div class="stat"><div class="lbl">분석 완료</div><div class="val pos">${summary.analyzed}</div><div class="sub">cache ${summary.cacheHit} / fetch ${summary.fetched}</div></div>
    <div class="stat" style="background:#3a1a04;"><div class="lbl">분봉 미존재 skip</div><div class="val" style="color:#fde68a;">${summary.missingMinute + summary.skippedNoFetch}</div></div>
    <div class="stat"><div class="lbl">최근 N 거래일</div><div class="val">${summary.days}</div></div>
    <div class="stat"><div class="lbl">09:30 base VVI2</div><div class="val">${summary.base_0930.actualVvi2Rate||0}%</div><div class="sub">n=${summary.base_0930.n||0} · BIG_50 ${summary.base_0930.big50Rate||0}%</div></div>
    <div class="stat"><div class="lbl">10:00 base VVI2</div><div class="val">${summary.base_1000.actualVvi2Rate||0}%</div><div class="sub">n=${summary.base_1000.n||0} · BIG_50 ${summary.base_1000.big50Rate||0}%</div></div>
    <div class="stat"><div class="lbl">10:30 base VVI2</div><div class="val">${summary.base_1030.actualVvi2Rate||0}%</div><div class="sub">n=${summary.base_1030.n||0} · BIG_50 ${summary.base_1030.big50Rate||0}%</div></div>
  </div>
</div>

<h2>2. 최적 시간대/모드 Top 5</h2>
<div class="hint">score = VVI2 0.35 + 일봉PreA 0.25 + BIG_50 0.25 - 종가실패 0.15 (n&lt;10 제외).</div>
${topTable}

<h2>3. 시간대 × strict/base/loose 비교표</h2>
<div class="hint">
  base 임계값: 09:10 → 0.25x / 09:30 → 0.40x / 10:00 → 0.60x / 10:30 → 0.75x / 11:00 → 0.90x / 13:00,14:00 → 1.00x.
  strict = base + 최근 3개 분봉 중 2개 종가가 qvaHigh 이상. loose = base × 0.8 + 종가 -1.5% 허용.
</div>
${snapTable}

<h2>4. QVA2 전용 시간대별 성과</h2>
<div class="hint">QVA2는 일봉 검증에서 BIG_50 34.9% / SUPER 13.7%로 강했음 — 분봉에서도 같은 경향인지.</div>
${snapTableQva2}

<h2>5. 거짓 신호 분석 (09:30/10:00/10:30 base 기준)</h2>
<div class="hint">장중에는 intradayPreA였지만 종가 기준 dailyPreA가 아니었던 케이스 분석.</div>
${falseTable}

<h2>6. 대표 사례</h2>
<h3>6-1. 09:30 base 감지 → 종가 VVI2 확정 → BIG_50</h3>
${caseTable(cases.case0930VviBig50, '09:30 base + VVI2 + BIG_50 사례 없음 (표본 부족)')}

<h3>6-2. 10:00 base 감지 → 종가 VVI2 확정</h3>
${caseTable(cases.case1000Vvi, '10:00 base + VVI2 사례 없음')}

<h3>6-3. 10:30 base 감지 → 종가 실패</h3>
${caseTable(cases.case1030CloseFail, '10:30 base 거짓 신호 사례 없음')}

<h3>6-4. QVA2 → 09:30/10:00 감지 → BIG_50</h3>
${caseTable(cases.caseQva2IntradayBig50, 'QVA2 + 09:30/10:00 + BIG_50 사례 없음')}

<h3>6-5. 장중 감지됐지만 -10% 이탈 (거짓 신호)</h3>
${caseTable(cases.caseDetectedButFail, '장중 감지 후 실패 사례 없음')}

<footer style="margin-top: 24px; padding: 12px; background: #1e293b; border-radius: 6px; color: #64748b; font-size: 11.5px; text-align: center;">
  분봉 백테스트 검증 — 분봉 캐시: cache/kis-minute/{code}/{date}.json. 실제 실시간 감지는 KIS 호출 + 차후 검증 필요.
</footer>
</body></html>`;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
