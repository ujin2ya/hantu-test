#!/usr/bin/env node
/**
 * 1DS GT 후보 다음날 장초 분봉 백필 (ENTRY_CONFIRM 연구용)
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json (historical 후보 산출)
 *   - cache/naver-stocks-list.json (시총/ETF/특수 플래그)
 *   - 후보 산출 로직: one-day-surge-entry-confirm-report.js의 generateGtEventsByDate 재사용
 *
 * 출력:
 *   - data/intraday/1ds/YYYY-MM-DD/{code}.json (분봉 raw + 정규화 bars + boardSnapshot)
 *   - reports/one-day-surge-intraday-missing.json (실패/누락 로그, 누적)
 *
 * KIS API:
 *   - TR FHKST03010230 (주식기간별분봉시세) — fid_input_date_1로 과거 영업일 직접 지정
 *   - 1콜에 120 bars (대상일 09:00~10:00 60bars + 직전 영업일 후반 60bars 섞여 옴 → 우리는 대상일만 필터)
 *   - 종목당 ~1콜로 09:00~10:00 60bars 모두 회수
 *
 * 사용:
 *   node collect-1ds-intraday.js                                # 기본 — 최근 40 거래일 백필
 *   node collect-1ds-intraday.js --window-days 60               # 윈도우 60거래일
 *   node collect-1ds-intraday.js --target-date 2026-04-30       # 특정 D일 후보 → D+1 분봉 1일치만
 *   node collect-1ds-intraday.js --from 2026-04-01 --to 2026-04-30  # 기간 walk
 *   node collect-1ds-intraday.js --groups BALANCED-GT,LIGHT-GT  # 그룹 한정
 *   node collect-1ds-intraday.js --top-per-day 30               # 일별 상위 N개 (default: all GT)
 *   node collect-1ds-intraday.js --dry-run                      # 후보만 카운트, KIS 호출 X
 *
 * 주의:
 *   - 전 종목 분봉 수집이 아니라 1DS GT 후보(LIGHT-GT/BALANCED-GT/MID-CAP-GT/MOM-RISK)만 대상
 *   - D일 후보 산출은 D일까지 차트만 사용 → look-ahead 없음
 *   - 이미 저장된 분봉 JSON은 재수집하지 않음 (멱등성)
 *   - KIS rate limit 방어: 종목 사이 sleep + retry 2회 + missing log
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), override: true });

const { getAccessToken } = require('../src/services/kis/kisToken');
const { getMinuteBarsForDate, normalizeBars } = require('../src/services/kis/kisMinuteBars');
const report = require('../boards/oneDaySurge/one-day-surge-entry-confirm-report');
const core = require('../boards/oneDaySurge/one-day-surge-core');
const REPORTS_DIR = path.join(ROOT, 'reports');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const STOCKS_PATH = path.join(ROOT, 'stocks.json');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const MISSING_LOG = path.join(REPORTS_DIR, 'one-day-surge-intraday-missing.json');

// ── CLI ──
function parseArgs(argv) {
  const a = {
    targetDate: null,        // single D-day (YYYY-MM-DD)
    from: null, to: null,    // range D-days (YYYY-MM-DD)
    windowDays: 40,          // last N trading days (used when no targetDate / no range)
    groups: ['BALANCED-GT', 'LIGHT-GT', 'MID-CAP-GT', 'MOM-RISK'],
    topPerDay: 0,            // 0 = no cap
    sleepMs: 350,            // KIS throttle (ms between calls)
    retry: 2,                // retries per stock on failure
    endHour: '100000',       // KIS hour parameter (returns 120 bars going back)
    dryRun: false,
    fromBoard: false,        // reports/one-day-surge-board-result.json의 mainPoolCodes만 수집 (라이브 운영용)
    fromScannerCandidates: false, // 유동성 통과 종목 전체 대상 (09:30 실시간 스캐너용 넓은 후보군)
    scannerLimit: 300,       // 스캐너 후보 상한 (priorityScore 상위 N개)
    fullDay: false,          // 09:00~15:30 전체 분봉 수집 (4 calls/stock-day) — pullback 백테스트용
    fromScannerCandidatesHistory: false,  // 과거 N 거래일 백필 모드 (각 거래일별로 scanner candidates 산출 → 그 일자 분봉 수집)
    historyDays: 60,         // 과거 모드 기본 60거래일
    fromDate: null, toDate: null,  // 과거 모드 일자 범위 (--from-date / --to-date, --from/--to 와 별개)
    maxFetch: 0,             // 한 번 실행에서 최대 KIS 호출 수 (0 = 무제한)
    resume: false,           // 이전 실행에서 받지 못한 항목부터 이어받기 (실제로는 skip 로직이 동일하지만 명시적 플래그)
    retryFailed: false,      // missing log의 실패 항목만 재시도
    statusOutPath: null,     // 상태 파일 경로 (default reports/one-day-surge-intraday-collection-status.json)
    codes: null,             // 직접 코드 리스트 (comma-separated). --target-date 필수
  };
  // 환경변수 (history 모드에서 sleep / max-fetch 오버라이드)
  if (process.env.ONEDS_HISTORY_SLEEP_MS) a.sleepMs = parseInt(process.env.ONEDS_HISTORY_SLEEP_MS, 10) || a.sleepMs;
  if (process.env.ONEDS_HISTORY_LIMIT_PER_RUN) a.maxFetch = parseInt(process.env.ONEDS_HISTORY_LIMIT_PER_RUN, 10) || 0;
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--target-date') a.targetDate = argv[++i];
    else if (k === '--from') a.from = argv[++i];
    else if (k === '--to') a.to = argv[++i];
    else if (k === '--window-days') a.windowDays = parseInt(argv[++i], 10) || 40;
    else if (k === '--groups') a.groups = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--top-per-day') a.topPerDay = parseInt(argv[++i], 10) || 0;
    else if (k === '--sleep') a.sleepMs = parseInt(argv[++i], 10) || 350;
    else if (k === '--retry') a.retry = parseInt(argv[++i], 10) || 2;
    else if (k === '--end-hour') a.endHour = argv[++i];
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--from-board') a.fromBoard = true;
    else if (k === '--from-scanner-candidates') a.fromScannerCandidates = true;
    else if (k === '--scanner-limit') a.scannerLimit = parseInt(argv[++i], 10) || 300;
    else if (k === '--full-day') a.fullDay = true;
    else if (k === '--from-scanner-candidates-history') a.fromScannerCandidatesHistory = true;
    else if (k === '--days') a.historyDays = parseInt(argv[++i], 10) || 60;
    else if (k === '--from-date') a.fromDate = argv[++i];
    else if (k === '--to-date') a.toDate = argv[++i];
    else if (k === '--max-fetch') a.maxFetch = parseInt(argv[++i], 10) || 0;
    else if (k === '--resume') a.resume = true;
    else if (k === '--retry-failed') a.retryFailed = true;
    else if (k === '--status-out') a.statusOutPath = argv[++i];
    else if (k === '--codes') a.codes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0); }
  }
  // history 모드는 자동으로 full-day 분봉 수집 강제
  if (a.fromScannerCandidatesHistory) a.fullDay = true;
  return a;
}
function printHelp() {
  console.log(`Usage: node collect-1ds-intraday.js [options]
  --target-date YYYY-MM-DD     특정 D일 후보 → D+1 분봉만 수집
  --from YYYY-MM-DD            기간 시작 (D일 기준)
  --to   YYYY-MM-DD            기간 종료 (D일 기준)
  --window-days 40             기본: 최근 N 거래일 (target-date / from 미지정 시)
  --groups ...                 GT 그룹 필터 (default: BALANCED-GT,LIGHT-GT,MID-CAP-GT,MOM-RISK)
  --top-per-day N              일별 상위 N개로 제한 (default: all)
  --sleep 350                  KIS 콜 사이 대기 (ms)
  --retry 2                    실패 시 재시도 횟수
  --end-hour 100000            KIS hour 파라미터
  --dry-run                    후보만 카운트, KIS 호출 X
  --from-board                 reports/one-day-surge-board-result.json의 mainPoolCodes만 수집 (라이브 운영용 — target-date는 보드 analysisDate로 자동 설정)
  --from-scanner-candidates    유동성 통과 종목 전체 대상 (09:30 실시간 스캐너용 넓은 후보군). priorityScore 상위 N개 수집
  --scanner-limit 300          스캐너 후보 상한 (default 300)
  --full-day                   09:00~15:30 전체 분봉 수집 (default 09:00~10:00). 종목당 4 KIS 호출. pullback 백테스트용
  --from-scanner-candidates-history  과거 N 거래일 분봉 백필 (각 일자별 scanner top N 후보 09:00~15:30). full-day 자동 켜짐
  --days 60                    history 모드에서 과거 N 거래일 (default 60). --from-date/--to-date 미지정 시 적용
  --from-date YYYY-MM-DD       history 모드 시작일 (D-1 baseDate 기준 → 분봉은 D=다음 거래일에 저장)
  --to-date   YYYY-MM-DD       history 모드 종료일
  --max-fetch N                한 번 실행에서 최대 KIS 호출 수 (0=무제한). KIS rate limit 안전망. 환경변수 ONEDS_HISTORY_LIMIT_PER_RUN
  --resume                     이전 실행에서 못 받은 항목부터 이어받기 (skip-if-exists는 항상 적용, 이 플래그는 명시용)
  --retry-failed               missing log의 실패 항목만 재시도 (모든 history task 대신)
  --status-out PATH            상태 파일 출력 경로 (default reports/one-day-surge-intraday-collection-status.json)
  --codes CODE1,CODE2,...      직접 코드 리스트 지정. --target-date 필수. --full-day와 조합 가능
  환경변수: ONEDS_HISTORY_SLEEP_MS=350 / ONEDS_HISTORY_LIMIT_PER_RUN=1000`);
}

// ── 유틸 ──
function dateNumToStr(yyyymmdd) {
  return yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8);
}
function dateStrToNum(yyyy_mm_dd) {
  return yyyy_mm_dd.replace(/-/g, '');
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── missing log helpers ──
function loadMissingLog() {
  if (!fs.existsSync(MISSING_LOG)) return { lastUpdated: null, entries: [] };
  try { return JSON.parse(fs.readFileSync(MISSING_LOG, 'utf-8')); }
  catch (_) { return { lastUpdated: null, entries: [] }; }
}
function saveMissingLog(log) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  log.lastUpdated = new Date().toISOString();
  fs.writeFileSync(MISSING_LOG, JSON.stringify(log, null, 2), 'utf-8');
}
function appendMissing(log, entry) {
  // 같은 (date, code) 중복 추가 방지 — 마지막 항목만 유지
  log.entries = (log.entries || []).filter((e) => !(e.date === entry.date && e.code === entry.code));
  log.entries.push({ ...entry, recordedAt: new Date().toISOString() });
}

// ── KIS retry wrapper ──
async function fetchWithRetry(token, code, dateNum, endHour, retries) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await getMinuteBarsForDate(token, code, dateNum, endHour);
    } catch (e) {
      lastErr = e;
      // 429 / EGW00 토큰 류 에러는 재시도가 의미 있음 — 그 외 빠르게 fallthrough
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// 09:00~15:30 전체 분봉 수집 — KIS는 콜당 120 bars 반환, 6.5h × 60 = 390 bars 위해 4번 호출
// endHours: [110000, 130000, 150000, 153000] = 11:00 / 13:00 / 15:00 / 15:30 종료 시점에서 거꾸로 120bar씩
const FULL_DAY_END_HOURS = ['110000', '130000', '150000', '153000'];
async function fetchFullDayWithRetry(token, code, dateNum, retries, callSleepMs) {
  const allRaw = [];
  let lastMeta = null;
  for (const endHour of FULL_DAY_END_HOURS) {
    const { meta, raw } = await fetchWithRetry(token, code, dateNum, endHour, retries);
    if (meta && !lastMeta) lastMeta = meta;
    for (const b of raw) allRaw.push(b);
    await sleep(callSleepMs);
  }
  // 시간 키 dedupe + 오름차순 (raw는 이미 stck_bsop_date 필터됨, getMinuteBarsForDate에서)
  const map = new Map();
  for (const b of allRaw) {
    const key = (b.stck_bsop_date || '') + (b.stck_cntg_hour || '');
    if (!map.has(key)) map.set(key, b);
  }
  const sorted = [...map.values()].sort((a, b) => {
    const ka = (a.stck_bsop_date || '') + (a.stck_cntg_hour || '');
    const kb = (b.stck_bsop_date || '') + (b.stck_cntg_hour || '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return { meta: lastMeta, raw: sorted };
}

// ── 스캐너 후보군 빌더 ──
// 유동성 + 시총 + 종목 자격 통과 종목을 priorityScore 상위 N개로 추리는 함수.
// --from-scanner-candidates 모드에서 사용. 보드 mainPool과 무관하게 넓은 후보를 수집한다.
//
// 후보 조건:
//   - avg20Value ≥ 10억 OR baseValue ≥ 20억
//   - 시가총액 500억~5조
//   - ETF/ETN/스팩/우선주/리츠/관리종목성 이름 제외
//   - 최근 차트 데이터 (baseIdx ≥ 20) 있는 종목
//
// 정렬 priorityScore (사용자 명시 4개 가중치):
//   baseValue/1억 + avg20/1억*0.3 + max(0,changeRate)*10 + vmc*100
//   = 전일 거래대금 + 최근 평균 거래대금 + 전일 양봉 보너스 + 시총 대비 거래대금 비율
function buildScannerCandidates({ metaMap, files, limit, chartDir, debug = false }) {
  const candidates = [];
  const rejectCounts = { no_meta: 0, etf: 0, special: 0, excluded_name: 0, no_marketcap: 0, mc_outside: 0, no_chart: 0, short_history: 0, low_liquidity: 0 };
  // 오늘 KST yyyymmdd — 운영 서버가 장중에 부분 일봉을 받았을 수 있어 baseDate가 오늘로 잡히면
  // 09:30 스캐너 의도(어제 baseDate → 오늘 분봉)와 어긋남. 그래서 baseRow.date === todayNum 이면
  // 한 행 앞 (어제 영업일)을 baseRow로 본다.
  const todayParts = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).split('. ');
  const todayNum = todayParts[0] + (todayParts[1] || '').padStart(2, '0') + ((todayParts[2] || '').replace('.', '')).padStart(2, '0');
  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    if (!meta) { rejectCounts.no_meta++; continue; }
    if (meta.isEtf) { rejectCounts.etf++; continue; }
    if (meta.isSpecial) { rejectCounts.special++; continue; }
    if (core.isExcludedByName(meta.name)) { rejectCounts.excluded_name++; continue; }
    const mc = Number(meta.marketCap) || 0;
    if (mc <= 0) { rejectCounts.no_marketcap++; continue; }
    if (mc < 5e10 || mc >= 5e12) { rejectCounts.mc_outside++; continue; }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(chartDir, f), 'utf-8')); }
    catch (_) { rejectCounts.no_chart++; continue; }
    const rows = chart && chart.rows;
    if (!Array.isArray(rows) || rows.length < 25) { rejectCounts.short_history++; continue; }
    let baseIdx = core.pickLatestBaseIdx(rows);
    if (baseIdx < 20) { rejectCounts.short_history++; continue; }
    // 오늘 부분 일봉이 latest로 잡힌 경우 한 행 앞 (어제)으로 — 09:30 스캐너 흐름과 일치시킴
    if (rows[baseIdx] && rows[baseIdx].date === todayNum && baseIdx >= 21) {
      baseIdx = baseIdx - 1;
    }
    let sum = 0, n = 0;
    for (let i = baseIdx - 20; i < baseIdx; i++) {
      const r = rows[i];
      if (r && r.volume > 0) { sum += (r.valueApprox || 0); n++; }
    }
    const avg20 = n > 0 ? sum / n : 0;
    const baseRow = rows[baseIdx];
    const baseValue = baseRow.valueApprox || 0;
    if (avg20 < 1e9 && baseValue < 2e9) { rejectCounts.low_liquidity++; continue; }
    const prevRow = rows[baseIdx - 1];
    const changeRate = prevRow && prevRow.close > 0 ? (baseRow.close / prevRow.close - 1) * 100 : 0;
    const vmc = mc > 0 ? (baseValue / mc) * 100 : 0;
    const priorityScore =
      baseValue / 1e8                  // 전일 거래대금 (1억 단위)
      + (avg20 / 1e8) * 0.3            // 평균 거래대금 (보조 가중)
      + Math.max(0, changeRate) * 10   // 양봉 보너스 (음봉은 0)
      + vmc;                           // 시총 대비 거래대금 비율
    candidates.push({
      code, name: chart.name || meta.name || code,
      market: chart.market || meta.market || '',
      marketCap: mc, baseDate: baseRow.date,
      avg20Value: avg20, baseValue, changeRate, vmc, priorityScore,
    });
  }
  candidates.sort((a, b) => b.priorityScore - a.priorityScore);
  const top = candidates.slice(0, limit);
  if (debug) {
    console.log(`  스캐너 후보군 산정:`);
    console.log(`    전체 차트: ${files.length} / 유동성 통과: ${candidates.length} / 상한 ${limit} 적용 후 ${top.length}개`);
    console.log(`    필터 제외:`);
    for (const [r, n] of Object.entries(rejectCounts)) {
      if (n > 0) console.log(`      ${r}: ${n}개`);
    }
  }
  return { candidates: top, rejectCounts, totalCandidates: candidates.length };
}

// ── 과거 baseDate(특정 D-1일) 기준 스캐너 후보군 빌더 ──
// buildScannerCandidates는 "지금 차트의 latest row" 기준이지만,
// 과거 60일 분봉 수집은 각 거래일별로 "그 거래일 전일 일봉"까지만 사용해 후보를 산출해야 한다 (미래 누수 금지).
// targetBaseDateNum = 후보 산출 기준일 (YYYYMMDD, 후보 종목들의 "전일 일봉" 일자).
// 결과 후보들의 분봉은 targetBaseDateNum의 다음 거래일 = targetIntradayDateNum에서 수집한다.
function buildScannerCandidatesForDate({ metaMap, files, limit, chartDir, targetBaseDateNum, debug = false }) {
  const candidates = [];
  const rejectCounts = { no_meta: 0, etf: 0, special: 0, excluded_name: 0, no_marketcap: 0, mc_outside: 0, no_chart: 0, short_history: 0, no_target_date: 0, low_liquidity: 0 };
  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    if (!meta) { rejectCounts.no_meta++; continue; }
    if (meta.isEtf) { rejectCounts.etf++; continue; }
    if (meta.isSpecial) { rejectCounts.special++; continue; }
    if (core.isExcludedByName(meta.name)) { rejectCounts.excluded_name++; continue; }
    const mc = Number(meta.marketCap) || 0;
    if (mc <= 0) { rejectCounts.no_marketcap++; continue; }
    if (mc < 5e10 || mc >= 5e12) { rejectCounts.mc_outside++; continue; }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(chartDir, f), 'utf-8')); }
    catch (_) { rejectCounts.no_chart++; continue; }
    const rows = chart && chart.rows;
    if (!Array.isArray(rows) || rows.length < 25) { rejectCounts.short_history++; continue; }
    // targetBaseDateNum 행을 찾아 baseIdx로 사용
    const baseIdx = rows.findIndex((r) => r && r.date === targetBaseDateNum);
    if (baseIdx < 0) { rejectCounts.no_target_date++; continue; }
    if (baseIdx < 20) { rejectCounts.short_history++; continue; }
    let sum = 0, n = 0;
    for (let i = baseIdx - 20; i < baseIdx; i++) {
      const r = rows[i];
      if (r && r.volume > 0) { sum += (r.valueApprox || 0); n++; }
    }
    const avg20 = n > 0 ? sum / n : 0;
    const baseRow = rows[baseIdx];
    const baseValue = baseRow.valueApprox || 0;
    if (avg20 < 1e9 && baseValue < 2e9) { rejectCounts.low_liquidity++; continue; }
    const prevRow = rows[baseIdx - 1];
    const changeRate = prevRow && prevRow.close > 0 ? (baseRow.close / prevRow.close - 1) * 100 : 0;
    const vmc = mc > 0 ? (baseValue / mc) * 100 : 0;
    const priorityScore =
      baseValue / 1e8
      + (avg20 / 1e8) * 0.3
      + Math.max(0, changeRate) * 10
      + vmc;
    const nextRow = rows[baseIdx + 1] || null;
    candidates.push({
      code, name: chart.name || meta.name || code,
      market: chart.market || meta.market || '',
      marketCap: mc, baseDate: baseRow.date,
      nextDayRow: nextRow,  // 분봉 수집 일자 = nextRow.date (없으면 호출 측에서 처리)
      avg20Value: avg20, baseValue, changeRate, vmc, priorityScore,
    });
  }
  candidates.sort((a, b) => b.priorityScore - a.priorityScore);
  const top = candidates.slice(0, limit);
  if (debug) {
    console.log(`    baseDate=${targetBaseDateNum}: 후보 ${candidates.length}건 → top ${top.length}건`);
  }
  return { candidates: top, rejectCounts, totalCandidates: candidates.length };
}

// ── 과거 N 거래일 산출 ──
// 모든 차트의 row.date 중 빈도 상위 거래일을 안정적으로 sort해서 최근 N개를 반환.
// 운영 서버/로컬 모두 chart 파일이 같은 일자 인덱스를 공유하므로 표본은 충분히 크다.
function listRecentTradingDays(files, chartDir, n, options = {}) {
  const { excludeAfterDateNum = null } = options;
  const counts = new Map();
  const sample = files.slice(0, Math.min(files.length, 300));  // 빈도 산출용 샘플 — 300개면 충분
  for (const f of sample) {
    try {
      const chart = JSON.parse(fs.readFileSync(path.join(chartDir, f), 'utf-8'));
      const rows = chart && chart.rows;
      if (!Array.isArray(rows)) continue;
      const tail = rows.slice(-Math.max(n + 10, 80));  // 최근 ~70영업일만 보면 충분
      for (const r of tail) {
        if (!r || !r.date || !(r.volume > 0)) continue;
        if (excludeAfterDateNum && r.date > excludeAfterDateNum) continue;
        counts.set(r.date, (counts.get(r.date) || 0) + 1);
      }
    } catch (_) { /* skip */ }
  }
  // 빈도 ≥ sample.length × 0.5 → 시장 영업일로 인정 (개별 종목 거래정지 일자 제외)
  const threshold = Math.max(3, Math.floor(sample.length * 0.5));
  const valid = [...counts.entries()].filter(([_, c]) => c >= threshold).map(([d]) => d);
  valid.sort();
  return valid.slice(-n);
}

// ── main ──
async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(INTRADAY_BASE)) fs.mkdirSync(INTRADAY_BASE, { recursive: true });

  const t0 = Date.now();
  console.log('\n📡 1DS 분봉 백필 (ENTRY_CONFIRM 연구용)');
  if (args.dryRun) console.log('  ⚠ DRY RUN — 후보 카운트만, KIS 호출 X');

  if (args.fromBoard && args.fromScannerCandidates) {
    console.error('  [ERROR] --from-board 와 --from-scanner-candidates 는 동시 사용 불가.');
    process.exit(1);
  }
  if (args.fromScannerCandidatesHistory && (args.fromBoard || args.fromScannerCandidates)) {
    console.error('  [ERROR] --from-scanner-candidates-history 는 단독 모드. --from-board / --from-scanner-candidates와 동시 사용 불가.');
    process.exit(1);
  }

  // ── HISTORY 모드: 과거 N 거래일별 scanner candidates 분봉 백필 (단독 경로, 기존 흐름 우회) ──
  if (args.fromScannerCandidatesHistory) {
    await runHistoryMode(args, t0);
    return;
  }

  // --from-board: 보드 JSON에서 mainPool 코드 + analysisDate를 읽어 target-date 자동 세팅
  let boardMainPoolCodes = null;
  if (args.fromBoard) {
    const boardPath = path.join(REPORTS_DIR, 'one-day-surge-board-result.json');
    if (!fs.existsSync(boardPath)) {
      console.error(`  [ERROR] --from-board 모드인데 ${boardPath} 가 없습니다. 먼저 보드를 생성하세요.`);
      process.exit(1);
    }
    const board = JSON.parse(fs.readFileSync(boardPath, 'utf-8'));
    boardMainPoolCodes = new Set(board.priorityRanked && board.priorityRanked.mainPoolCodes || []);
    if (boardMainPoolCodes.size === 0) {
      console.warn(`  ⚠ 보드 mainPoolCodes 0건 — 분봉 수집 대상 없음. 보드 후보가 생기면 다시 실행.`);
      return;
    }
    if (!args.targetDate) {
      const ad = board.meta && board.meta.analysisDate;
      if (!ad) {
        console.error(`  [ERROR] 보드에 analysisDate가 없습니다.`);
        process.exit(1);
      }
      args.targetDate = ad.slice(0, 4) + '-' + ad.slice(4, 6) + '-' + ad.slice(6, 8);
    }
    console.log(`  📌 --from-board: ${boardMainPoolCodes.size}개 코드 / target-date=${args.targetDate}`);
  }

  // --codes: 직접 코드 리스트 지정 (--target-date 필수)
  if (args.codes && args.codes.length > 0 && !boardMainPoolCodes) {
    if (!args.targetDate) {
      console.error('  [ERROR] --codes 모드는 --target-date YYYY-MM-DD 가 필요합니다.');
      process.exit(1);
    }
    boardMainPoolCodes = new Set(args.codes);
    console.log(`  📌 --codes: ${boardMainPoolCodes.size}개 코드 / target-date=${args.targetDate}`);
  }

  // 1) 후보 산출
  const metaMap = report.loadStockMetaMap();
  const files = fs.readdirSync(CHART_DIR).filter((f) => f.endsWith('.json'));
  console.log(`  메타: ${metaMap.size}건 / 차트 파일: ${files.length}건`);

  // --from-scanner-candidates: 유동성 통과 종목 전체 대상 (보드 mainPool 무관, 넓은 09:30 스캐너용)
  let scannerCandidateCodes = null;
  let scannerCandidateMeta = null;
  if (args.fromScannerCandidates) {
    const { candidates, rejectCounts, totalCandidates } = buildScannerCandidates({
      metaMap, files, limit: args.scannerLimit, chartDir: CHART_DIR, debug: true,
    });
    scannerCandidateCodes = new Set(candidates.map((c) => c.code));
    scannerCandidateMeta = { totalCandidates, rejectCounts, picked: candidates.length, limit: args.scannerLimit };
    if (scannerCandidateCodes.size === 0) {
      console.warn('  ⚠ --from-scanner-candidates: 후보 0건. 종료.');
      return;
    }
    if (!args.targetDate) {
      // 가장 흔한 baseDate를 자동 산정 (운영 09:30 cron에서는 거의 어제 영업일이 됨)
      const freq = new Map();
      for (const c of candidates) freq.set(c.baseDate, (freq.get(c.baseDate) || 0) + 1);
      let maxDate = null, maxFreq = 0;
      for (const [d, n] of freq) { if (n > maxFreq) { maxFreq = n; maxDate = d; } }
      if (!maxDate) {
        console.error('  [ERROR] --from-scanner-candidates: baseDate 자동 산정 실패.');
        process.exit(1);
      }
      args.targetDate = dateNumToStr(maxDate);
    }
    console.log(`  📡 --from-scanner-candidates: ${scannerCandidateCodes.size}개 코드 / target-date=${args.targetDate}`);
  }

  // from-board / from-scanner-candidates 모드는 generateGtEventsByDate 우회 —
  // 코드 list를 직접 받아 D-day 차트의 last row를 ev로 만든다.
  const directCodes = boardMainPoolCodes || scannerCandidateCodes;
  let allEvents = [], eventsByDate = new Map(), stocksProcessed = 0, stocksFiltered = 0;
  if (!directCodes) {
    const effectiveWindow = args.targetDate || args.from || args.to ? Math.max(args.windowDays, 60) : args.windowDays;
    const r = report.generateGtEventsByDate({ windowDays: effectiveWindow, groupsFilter: args.groups, metaMap, files, requireNextDay: false });
    allEvents = r.allEvents; eventsByDate = r.eventsByDate;
    stocksProcessed = r.stocksProcessed; stocksFiltered = r.stocksFiltered;
    console.log(`  처리 종목: ${stocksProcessed} / 필터 제외: ${stocksFiltered} / 그룹 후보 이벤트: ${allEvents.length}건 (${eventsByDate.size}일)`);
  }

  // 2) D일 필터 적용
  let targetBaseDates;
  if (args.targetDate) {
    targetBaseDates = new Set([dateStrToNum(args.targetDate)]);
  } else if (args.from || args.to) {
    const fromNum = args.from ? dateStrToNum(args.from) : '00000000';
    const toNum   = args.to   ? dateStrToNum(args.to)   : '99999999';
    targetBaseDates = new Set([...eventsByDate.keys()].filter((d) => d >= fromNum && d <= toNum));
  } else {
    // last windowDays trading days
    const sortedDates = [...eventsByDate.keys()].sort();
    const tail = sortedDates.slice(-args.windowDays);
    targetBaseDates = new Set(tail);
  }
  const sortedTargetDates = [...targetBaseDates].sort();
  console.log(`  대상 D일 수: ${sortedTargetDates.length}일 (${sortedTargetDates[0] || '-'} ~ ${sortedTargetDates[sortedTargetDates.length - 1] || '-'})`);

  // 3) D일별로 후보 정리 + (옵션) top-per-day cut + nextDate 산출
  let totalCandidates = 0;
  const tasks = []; // [{ baseDate, nextDateNum, nextDateStr, code, name, gtGroup, ev }]
  for (const d of sortedTargetDates) {
    let evs;
    if (directCodes) {
      // from-board / from-scanner-candidates 모드: D-day 차트에서 직접 list된 코드들의 last row 정보를 ev로 사용
      const groupLabel = boardMainPoolCodes ? 'BOARD_MAIN_POOL' : 'SCANNER_CANDIDATE';
      evs = [];
      for (const code of directCodes) {
        const meta = metaMap.get(code);
        if (!meta) continue;
        const fp = path.join(CHART_DIR, code + '.json');
        if (!fs.existsSync(fp)) continue;
        let chart;
        try { chart = JSON.parse(fs.readFileSync(fp, 'utf-8')); }
        catch (_) { continue; }
        const rows = chart && chart.rows;
        if (!Array.isArray(rows) || rows.length < 2) continue;
        // D-day가 차트의 마지막 row와 일치하는지 확인
        const dayRowIdx = rows.findIndex((r) => r.date === d);
        if (dayRowIdx < 0) continue;
        const dayRow = rows[dayRowIdx];
        const nextRow = rows[dayRowIdx + 1] || null; // 차트에 D+1이 있으면 사용, 없으면 null (라이브 수집 fallback이 today로 채움)
        evs.push({
          code, name: chart.name || meta.name || code, market: chart.market || meta.market || '',
          marketCap: meta.marketCap, gtGroup: groupLabel, // sort 시 사용 안 됨 (모두 같은 우선순위)
          baseDate: d, nextDayRow: nextRow,
          // sort 보조 필드 (없으면 0/9999 fallback)
          valueToMarketCapRatio: 0, dailyValueRank: 9999,
          changeRate: 0, recent5Up15Count: 0, candleType: null,
        });
      }
    } else {
      evs = (eventsByDate.get(d) || []).filter((e) => args.groups.includes(e.gtGroup) && e.gtGroup !== 'UNCLASSIFIED');
    }
    // 정렬: 그룹 우선순위 → valueToMcRatio 내림차순 → dailyValueRank 오름차순
    const groupRank = { 'BALANCED-GT': 1, 'LIGHT-GT': 2, 'MID-CAP-GT': 3, 'MOM-RISK': 4 };
    evs.sort((a, b) => {
      const ga = groupRank[a.gtGroup] || 9, gb = groupRank[b.gtGroup] || 9;
      if (ga !== gb) return ga - gb;
      const va = a.valueToMarketCapRatio || 0, vb = b.valueToMarketCapRatio || 0;
      if (vb !== va) return vb - va;
      return (a.dailyValueRank || 9999) - (b.dailyValueRank || 9999);
    });
    if (args.topPerDay > 0 && evs.length > args.topPerDay) evs = evs.slice(0, args.topPerDay);
    // 라이브 수집 path: D+1 row가 아직 차트에 없으면 시스템 날짜(오늘)를 nextDate로 가정.
    // YYYYMMDD 형식 (KST 기준).
    const todayParts = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).split('. ');
    const todayNum = todayParts[0] + (todayParts[1] || '').padStart(2, '0') + ((todayParts[2] || '').replace('.', '')).padStart(2, '0');
    for (const ev of evs) {
      const next = ev.nextDayRow;
      let nextDateNum, nextDateStr;
      if (next && next.date) {
        nextDateNum = next.date;
        nextDateStr = dateNumToStr(next.date);
      } else {
        // D+1 row 미존재 — 오늘 분봉을 라이브로 수집한다고 가정
        if (todayNum <= d) continue; // 오늘이 D-day 이하면 D+1 분봉이 아직 없음 (skip)
        nextDateNum = todayNum;
        nextDateStr = dateNumToStr(todayNum);
      }
      tasks.push({
        baseDate: d, nextDateNum, nextDateStr,
        code: ev.code, name: ev.name, gtGroup: ev.gtGroup,
        marketCap: ev.marketCap, valueToMarketCapRatio: ev.valueToMarketCapRatio,
        dailyValueRank: ev.dailyValueRank, candleType: ev.candleType,
        dayChangeRate: ev.changeRate, recent5Up15Count: ev.recent5Up15Count, market: ev.market,
      });
    }
    totalCandidates += evs.length;
  }
  console.log(`  총 수집 대상 (task): ${tasks.length}건 (--top-per-day=${args.topPerDay || 'all'} 적용)`);

  if (args.dryRun) {
    // 일자별 분포 미리보기
    const perDay = new Map();
    for (const t of tasks) perDay.set(t.baseDate, (perDay.get(t.baseDate) || 0) + 1);
    const lines = [...perDay.entries()].sort().slice(0, 20)
      .map(([d, n]) => `    ${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}: ${n}건`);
    console.log(`  ── 일자별 task 수 (앞 20일) ──`);
    for (const l of lines) console.log(l);
    console.log(`\nDRY RUN 완료. --dry-run 빼고 실행하면 KIS 호출 시작 (예상 ${(tasks.length * args.sleepMs / 1000 / 60).toFixed(1)}분).`);
    return;
  }

  // 4) KIS 토큰
  let token;
  try { token = await getAccessToken(); console.log('  KIS 토큰 OK'); }
  catch (e) { console.error(`  [ERROR] KIS 토큰 실패: ${e.message}`); process.exit(1); }

  // 5) missing log 로드 (누적)
  const missingLog = loadMissingLog();

  // 6) 수집 루프
  let success = 0, skipped = 0, failed = 0;
  const failedDetails = [];
  console.log(`\n  ── 수집 시작 (sleep ${args.sleepMs}ms / retry ${args.retry}) ──`);
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const dirPath = path.join(INTRADAY_BASE, t.nextDateStr);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    const outPath = path.join(dirPath, `${t.code}.json`);
    // skip 조건: 파일 존재 + 마지막 bar가 윈도우 종료 근처에 도달
    // full-day: 마지막 bar >= 15:00 / default(09:00~10:00): 마지막 bar >= 09:55
    // 10:01 survivor cron이 재실행될 때 09:30 cron이 남긴 파일(last bar ~09:30)을 skip하지 않고 재취득해야 함.
    if (fs.existsSync(outPath)) {
      let alreadyComplete = false;
      try {
        const existing = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        const lastBar = (existing.bars || []).slice(-1)[0];
        alreadyComplete = lastBar && lastBar.time >= (args.fullDay ? '15:00' : '09:55');
      } catch (_) { alreadyComplete = false; }
      if (alreadyComplete) {
        skipped++;
        if ((i + 1) % 100 === 0) console.log(`  [${i + 1}/${tasks.length}] (진행률 ${((i + 1) / tasks.length * 100).toFixed(1)}% / 성공 ${success} / skip ${skipped} / 실패 ${failed})`);
        continue;
      }
    }

    try {
      const { meta, raw } = args.fullDay
        ? await fetchFullDayWithRetry(token, t.code, t.nextDateNum, args.retry, args.sleepMs)
        : await fetchWithRetry(token, t.code, t.nextDateNum, args.endHour, args.retry);
      const bars = normalizeBars(raw);
      // full-day 모드는 09:00~15:30, 기본은 09:00~10:00
      const windowTo = args.fullDay ? '15:30' : '10:00';
      const windowBars = bars.filter((b) => b.time <= windowTo);
      const out = {
        code: t.code, name: t.name, market: t.market || null,
        date: t.nextDateStr, interval: '1m',
        source: 'kis', tr: 'FHKST03010230',
        fetchedAt: new Date().toISOString(),
        windowFrom: '09:00', windowTo,
        boardSnapshot: {
          baseDate: t.baseDate, gtGroup: t.gtGroup,
          marketCap: t.marketCap, valueToMarketCapRatio: t.valueToMarketCapRatio,
          dailyValueRank: t.dailyValueRank, candleType: t.candleType,
          dayChangeRate: t.dayChangeRate, recent5Up15Count: t.recent5Up15Count,
        },
        kisMeta: meta,
        bars: windowBars,
      };
      fs.writeFileSync(outPath, JSON.stringify(out));
      success++;
      if (windowBars.length === 0) {
        // 분봉 0건 = 거래정지 가능성. 실패는 아니지만 missing log에는 남김.
        appendMissing(missingLog, { date: t.nextDateStr, code: t.code, name: t.name, reason: 'empty_bars (likely halted)' });
      }
    } catch (e) {
      failed++;
      const reason = (e.message || String(e)).slice(0, 200);
      failedDetails.push({ code: t.code, name: t.name, date: t.nextDateStr, reason });
      appendMissing(missingLog, { date: t.nextDateStr, code: t.code, name: t.name, reason });
    }

    if (i % 25 === 24 || i === tasks.length - 1) {
      console.log(`  [${i + 1}/${tasks.length}] 진행률 ${((i + 1) / tasks.length * 100).toFixed(1)}% / 성공 ${success} / skip ${skipped} / 실패 ${failed}`);
    }
    if (i < tasks.length - 1) await sleep(args.sleepMs);
  }

  saveMissingLog(missingLog);

  const elapsed = (Date.now() - t0) / 1000;
  const totalProcessed = success + skipped + failed;
  const coverage = totalProcessed > 0 ? ((success + skipped) / totalProcessed * 100).toFixed(1) : '0';
  console.log(`\n✅ 백필 완료 (${elapsed.toFixed(1)}s)`);
  console.log(`  대상 D일: ${sortedTargetDates.length}일 (${sortedTargetDates[0] || '-'} ~ ${sortedTargetDates[sortedTargetDates.length - 1] || '-'})`);
  console.log(`  대상 후보 task: ${tasks.length}건`);
  console.log(`  ▸ 수집 성공:    ${success}건`);
  console.log(`  ▸ 기존 파일 skip: ${skipped}건`);
  console.log(`  ▸ 실패/누락:    ${failed}건`);
  console.log(`  최종 커버리지 (성공+skip): ${coverage}%`);
  console.log(`  missing log: ${MISSING_LOG} (총 ${missingLog.entries.length}건 누적)`);
  if (failedDetails.length) {
    console.log(`\n  ── 실패 상세 (앞 10건) ──`);
    for (const f of failedDetails.slice(0, 10)) console.log(`    ${f.date} ${f.code} ${f.name}: ${f.reason}`);
  }
}

// ── HISTORY 모드 main 흐름 ──
// 1) 메타/차트 로드
// 2) 대상 거래일 결정 (--from-date/--to-date 우선, 아니면 최근 N거래일)
//    target 거래일 = "분봉 수집 일자" (D). 후보 산출 baseDate = D 직전 거래일 (D-1).
// 3) 각 D별로 buildScannerCandidatesForDate(targetBaseDateNum = D-1 date) 호출
//    → 분봉 수집 task는 각 후보의 nextDayRow.date(= D)로 빌드
// 4) skip-if-exists 적용 후 KIS fetch 루프 (--max-fetch 도달 시 중단)
// 5) status 파일 + missing log 저장
async function runHistoryMode(args, t0) {
  const metaMap = report.loadStockMetaMap();
  const files = fs.readdirSync(CHART_DIR).filter((f) => f.endsWith('.json'));
  console.log(`  메타: ${metaMap.size}건 / 차트 파일: ${files.length}건`);

  // 거래일 산출. 분봉 수집 일자(D) = baseDate(D-1)의 다음 거래일.
  // 사용자가 --from-date/--to-date를 D 기준(분봉 수집 일자)으로 지정한다고 가정.
  // 내부적으로는 baseDate 리스트(D-1)를 만든 뒤, 각 baseDate의 nextRow.date를 D로 사용.
  const todayParts = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).split('. ');
  const todayNum = todayParts[0] + (todayParts[1] || '').padStart(2, '0') + ((todayParts[2] || '').replace('.', '')).padStart(2, '0');

  // 최근 영업일 리스트 (오늘 포함 X — 오늘은 장중일 수 있고 일봉이 확정 안 됨)
  // 분봉 수집 가능한 마지막 D = 어제까지의 영업일.
  // baseDate 리스트는 이 D-1 영업일들의 한 영업일 전 = D-2 즉 두 단계 이전. 단순화 위해:
  //   targetIntradayDates(D list) = 최근 N+1 영업일 (오늘 제외) → 각 D의 baseDate는 그 차트 row의 직전 row
  // 사용자 옵션 분기:
  //   --from-date / --to-date : 그 범위의 영업일을 D로 사용
  //   --days N (기본 60)      : 최근 N 영업일을 D로 사용
  // 단, 운영 서버에서 오늘 일봉이 아직 cron으로 추가 안 됐을 수 있으니, latest row가 오늘이면 그 직전부터.
  let targetDDates;
  if (args.fromDate || args.toDate) {
    const fromNum = args.fromDate ? args.fromDate.replace(/-/g, '') : '00000000';
    const toNum   = args.toDate   ? args.toDate.replace(/-/g, '')   : '99999999';
    // listRecentTradingDays — 최근 ~100 영업일에서 범위 필터
    const recent100 = listRecentTradingDays(files, CHART_DIR, 100, { excludeAfterDateNum: todayNum });
    targetDDates = recent100.filter((d) => d >= fromNum && d <= toNum);
  } else {
    // 최근 N 거래일 (오늘 제외)
    targetDDates = listRecentTradingDays(files, CHART_DIR, args.historyDays, { excludeAfterDateNum: todayNum });
  }
  if (targetDDates.length === 0) {
    console.error('  [ERROR] HISTORY 모드: 대상 거래일 0건. 차트 데이터 확인 필요.');
    process.exit(1);
  }
  console.log(`  📅 HISTORY 모드 — 대상 거래일 ${targetDDates.length}일 (${targetDDates[0]} ~ ${targetDDates[targetDDates.length - 1]})`);

  // 각 D별로 candidates 빌드
  // candidatesByD[D] = top scannerLimit candidates (baseDate = 차트의 D 직전 row)
  // 분봉 수집 일자 = D
  const perDateSummary = [];
  const allTasks = [];  // { D_str, D_num, baseDate, code, name, market, marketCap, ev }
  for (const D of targetDDates) {
    // baseDate = D 직전 영업일을 찾아야 함 → buildScannerCandidatesForDate가 baseRow를 찾아주므로
    //  그 baseRow의 nextRow.date === D 인지 확인. baseRow를 D-1로 잡으려면:
    //  먼저 D 자체로 buildScannerCandidatesForDate를 한 번 호출해서 baseRow=rows[D] 의 직전(D-1) row를 찾는 방식 X
    //  대신 D 자체를 nextDate로 보고, baseRow=rows[D]의 prevRow를 찾기 위해 D의 한 단계 전(이전 영업일 D_prev)으로 빌드.
    // 단순화: 각 후보 차트에서 D row의 직전 row.date를 baseDate로 사용. 종목마다 다를 수 있지만 시장 영업일이 동일하므로 거의 같음.
    // 구현 — buildScannerCandidatesForDate(targetBaseDateNum=D_prev). D_prev 결정 방식:
    //   listRecentTradingDays(101)에서 D 직전 row를 찾는다.
    const cal = listRecentTradingDays(files, CHART_DIR, 200, { excludeAfterDateNum: D });
    const idx = cal.lastIndexOf(D);
    if (idx <= 0) {
      perDateSummary.push({ date: dateNumToStr(D), baseDate: null, candidates: 0, reason: 'no_prev_date' });
      continue;
    }
    const baseDateNum = cal[idx - 1];
    const { candidates } = buildScannerCandidatesForDate({
      metaMap, files, limit: args.scannerLimit, chartDir: CHART_DIR,
      targetBaseDateNum: baseDateNum, debug: false,
    });
    // candidates의 nextDayRow.date가 D와 일치하는 것만 task로 추가 (안전).
    // 또한 nextRow가 차트에 없는 종목은 D가 차트에 안 들어온 상태(아직 데이터 미반영) → skip.
    let pickedForD = 0;
    for (const c of candidates) {
      if (!c.nextDayRow || c.nextDayRow.date !== D) continue;
      allTasks.push({
        baseDate: baseDateNum, nextDateNum: D, nextDateStr: dateNumToStr(D),
        code: c.code, name: c.name, gtGroup: 'SCANNER_CANDIDATE_HISTORY',
        marketCap: c.marketCap, valueToMarketCapRatio: c.vmc / 100,
        dailyValueRank: 9999, candleType: null,
        dayChangeRate: c.changeRate, recent5Up15Count: 0, market: c.market,
      });
      pickedForD++;
    }
    perDateSummary.push({ date: dateNumToStr(D), baseDate: dateNumToStr(baseDateNum), candidates: pickedForD });
  }
  const totalTarget = allTasks.length;
  console.log(`  📦 전체 수집 후보 종목-일: ${totalTarget}건`);

  // --retry-failed: missing log의 실패 항목만 작업으로 제한
  if (args.retryFailed) {
    const missing = loadMissingLog();
    const failedKeys = new Set((missing.entries || []).filter((e) => /^(?!empty_bars)/.test(e.reason || '')).map((e) => `${e.date}|${e.code}`));
    const before = allTasks.length;
    const filtered = allTasks.filter((t) => failedKeys.has(`${t.nextDateStr}|${t.code}`));
    console.log(`  🔁 --retry-failed: missing log ${failedKeys.size}건 / 매칭 ${filtered.length}건 (전체 ${before} → ${filtered.length})`);
    allTasks.length = 0;
    for (const t of filtered) allTasks.push(t);
  }

  // skip-if-exists 분류
  const fetchQueue = [];  // 실제 KIS 호출 대상
  let alreadyExists = 0;
  for (const t of allTasks) {
    const dirPath = path.join(INTRADAY_BASE, t.nextDateStr);
    const outPath = path.join(dirPath, `${t.code}.json`);
    if (fs.existsSync(outPath)) {
      // full-day 모드 → 마지막 bar가 15:00 이후면 완료, 아니면 재수집
      try {
        const existing = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        const lastBar = (existing.bars || []).slice(-1)[0];
        if (lastBar && lastBar.time >= '15:00') { alreadyExists++; continue; }
      } catch (_) { /* 깨진 파일 → 재수집 */ }
    }
    fetchQueue.push(t);
  }
  console.log(`  📂 이미 존재 (완료): ${alreadyExists}건 / 새로 받아야 할 종목-일: ${fetchQueue.length}건`);

  // --max-fetch 적용
  let willFetch = fetchQueue;
  if (args.maxFetch > 0 && fetchQueue.length > args.maxFetch) {
    willFetch = fetchQueue.slice(0, args.maxFetch);
    console.log(`  🚦 --max-fetch ${args.maxFetch} 적용 → 이번 실행 ${willFetch.length}건만 수집 (나머지 ${fetchQueue.length - args.maxFetch}건은 다음 --resume 실행으로 이월)`);
  }

  // 예상 소요 시간 (sleep + 4 calls × full-day)
  const callsPerStock = 4;  // full-day = 4 KIS 호출
  const sleepPerCall = args.sleepMs;
  const estimateSec = willFetch.length * callsPerStock * sleepPerCall / 1000;
  console.log(`  ⏰ 예상 소요: ${(estimateSec / 60).toFixed(1)}분 (${willFetch.length} × ${callsPerStock} calls × ${sleepPerCall}ms)`);

  if (args.dryRun) {
    console.log(`\n  ── 일자별 분포 (앞 20일) ──`);
    for (const s of perDateSummary.slice(0, 20)) {
      console.log(`    ${s.date} (base=${s.baseDate}): ${s.candidates}건`);
    }
    console.log(`\n[1DS HISTORY DRY-RUN] days=${targetDDates.length} scannerLimit=${args.scannerLimit}`);
    console.log(`[1DS HISTORY DRY-RUN] target=${totalTarget} existing=${alreadyExists} willFetch=${willFetch.length}`);
    saveHistoryStatus(args, {
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(2)),
      mode: 'dry-run',
      targetDays: targetDDates.length, scannerLimit: args.scannerLimit,
      totalTargetCount: totalTarget, alreadyExistsCount: alreadyExists,
      fetchedCount: 0, failedCount: 0, emptyCount: 0, insufficientBarsCount: 0, skippedCount: 0,
      perDate: perDateSummary, failedItems: [],
    });
    return;
  }

  // 실제 수집
  let token;
  try { token = await getAccessToken(); console.log('  KIS 토큰 OK'); }
  catch (e) { console.error(`  [ERROR] KIS 토큰 실패: ${e.message}`); process.exit(1); }
  const missingLog = loadMissingLog();
  let fetched = 0, failedCount = 0, emptyCount = 0, insufficientBarsCount = 0;
  const failedItems = [];
  console.log(`\n  ── 수집 시작 (sleep ${args.sleepMs}ms × 4 calls / retry ${args.retry}) ──`);

  for (let i = 0; i < willFetch.length; i++) {
    const t = willFetch[i];
    const dirPath = path.join(INTRADAY_BASE, t.nextDateStr);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    const outPath = path.join(dirPath, `${t.code}.json`);
    try {
      const { meta, raw } = await fetchFullDayWithRetry(token, t.code, t.nextDateNum, args.retry, args.sleepMs);
      const bars = normalizeBars(raw);
      const windowBars = bars.filter((b) => b.time <= '15:30');
      const out = {
        code: t.code, name: t.name, market: t.market || null,
        date: t.nextDateStr, interval: '1m',
        source: 'kis', tr: 'FHKST03010230',
        fetchedAt: new Date().toISOString(),
        windowFrom: '09:00', windowTo: '15:30',
        boardSnapshot: {
          baseDate: t.baseDate, gtGroup: t.gtGroup,
          marketCap: t.marketCap, valueToMarketCapRatio: t.valueToMarketCapRatio,
          dailyValueRank: t.dailyValueRank, candleType: t.candleType,
          dayChangeRate: t.dayChangeRate, recent5Up15Count: t.recent5Up15Count,
        },
        kisMeta: meta, bars: windowBars,
      };
      fs.writeFileSync(outPath, JSON.stringify(out));
      fetched++;
      if (windowBars.length === 0) {
        emptyCount++;
        appendMissing(missingLog, { date: t.nextDateStr, code: t.code, name: t.name, reason: 'empty_bars' });
      } else if (windowBars.length < 100) {
        insufficientBarsCount++;
      }
    } catch (e) {
      failedCount++;
      const reason = (e.message || String(e)).slice(0, 200);
      failedItems.push({ date: t.nextDateStr, code: t.code, name: t.name, reason });
      appendMissing(missingLog, { date: t.nextDateStr, code: t.code, name: t.name, reason });
    }
    if ((i + 1) % 25 === 0 || i === willFetch.length - 1) {
      console.log(`  [${i + 1}/${willFetch.length}] 진행률 ${((i + 1) / willFetch.length * 100).toFixed(1)}% / fetched ${fetched} / failed ${failedCount} / empty ${emptyCount}`);
    }
    if (i < willFetch.length - 1) await sleep(args.sleepMs);
  }
  saveMissingLog(missingLog);

  const elapsedSec = Number(((Date.now() - t0) / 1000).toFixed(2));
  const skippedDueToLimit = fetchQueue.length - willFetch.length;
  saveHistoryStatus(args, {
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedSec, mode: args.dryRun ? 'dry-run' : 'live',
    targetDays: targetDDates.length, scannerLimit: args.scannerLimit,
    totalTargetCount: totalTarget,
    alreadyExistsCount: alreadyExists,
    fetchedCount: fetched, failedCount, emptyCount, insufficientBarsCount,
    skippedCount: skippedDueToLimit,
    perDate: perDateSummary,
    failedItems,
  });

  // 콘솔 최종 요약
  console.log(`\n✅ HISTORY 백필 완료 (${elapsedSec}s)`);
  console.log(`[1DS HISTORY] days=${targetDDates.length} scannerLimit=${args.scannerLimit}`);
  console.log(`[1DS HISTORY] target=${totalTarget} existing=${alreadyExists} fetched=${fetched} failed=${failedCount} empty=${emptyCount} skipped=${skippedDueToLimit}`);
  console.log(`[1DS HISTORY] status saved: ${getHistoryStatusPath(args)}`);
  if (skippedDueToLimit > 0) {
    console.log(`\n  📌 --max-fetch 한도로 ${skippedDueToLimit}건 이월. 다음 명령:`);
    console.log(`     node pipeline/collect-1ds-intraday.js --from-scanner-candidates-history --days ${args.historyDays} --scanner-limit ${args.scannerLimit} --max-fetch ${args.maxFetch} --resume`);
  } else {
    console.log(`\n  📌 다음 단계 — 60일 보고서 재실행:`);
    console.log(`     node boards/oneDaySurge/one-day-surge-attack-candidate-validation-report.js --days ${args.historyDays}`);
    console.log(`     node boards/oneDaySurge/one-day-surge-10pct-winner-profile-report.js --days ${args.historyDays}`);
    console.log(`     node boards/oneDaySurge/one-day-surge-extra-intraday-hypothesis-report.js --days ${args.historyDays}`);
    console.log(`     node boards/oneDaySurge/one-day-surge-0930-explosive-fullminute-validation.js --days ${args.historyDays}`);
  }
}

function getHistoryStatusPath(args) {
  return args.statusOutPath || path.join(REPORTS_DIR, 'one-day-surge-intraday-collection-status.json');
}
function saveHistoryStatus(args, statusObj) {
  const p = getHistoryStatusPath(args);
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(statusObj, null, 2), 'utf-8');
}

if (require.main === module) {
  main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
}

module.exports = { buildScannerCandidates, buildScannerCandidatesForDate, listRecentTradingDays };
