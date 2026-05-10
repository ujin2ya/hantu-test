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
    fullDay: false,          // 09:00~15:30 전체 분봉 수집 (4 calls/stock-day) — pullback 백테스트용
  };
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
    else if (k === '--full-day') a.fullDay = true;
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0); }
  }
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
  --full-day                   09:00~15:30 전체 분봉 수집 (default 09:00~10:00). 종목당 4 KIS 호출. pullback 백테스트용`);
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

// ── main ──
async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(INTRADAY_BASE)) fs.mkdirSync(INTRADAY_BASE, { recursive: true });

  const t0 = Date.now();
  console.log('\n📡 1DS 분봉 백필 (ENTRY_CONFIRM 연구용)');
  if (args.dryRun) console.log('  ⚠ DRY RUN — 후보 카운트만, KIS 호출 X');

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

  // 1) 후보 산출
  const metaMap = report.loadStockMetaMap();
  const files = fs.readdirSync(CHART_DIR).filter((f) => f.endsWith('.json'));
  console.log(`  메타: ${metaMap.size}건 / 차트 파일: ${files.length}건`);

  // from-board 모드는 generateGtEventsByDate 우회 — 보드의 그룹 분류(classifyGtGroup)와 events의 그룹
  // 분류(classifyGroup)가 달라 매칭이 누락될 수 있으므로 mainPoolCodes를 직접 iterate한다.
  let allEvents = [], eventsByDate = new Map(), stocksProcessed = 0, stocksFiltered = 0;
  if (!boardMainPoolCodes) {
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
    if (boardMainPoolCodes) {
      // from-board 모드: D-day 차트에서 mainPoolCodes 코드들의 last row 정보를 직접 만들어 evs로 사용
      evs = [];
      for (const code of boardMainPoolCodes) {
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
          marketCap: meta.marketCap, gtGroup: 'BOARD_MAIN_POOL', // sort 시 사용 안 됨 (모두 같은 우선순위)
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
    // skip 조건: 파일 존재 + (full-day 모드면 마지막 bar가 15:00 이후, default 모드면 그냥 존재)
    if (fs.existsSync(outPath)) {
      let alreadyComplete = true;
      if (args.fullDay) {
        try {
          const existing = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
          const lastBar = (existing.bars || []).slice(-1)[0];
          alreadyComplete = lastBar && lastBar.time >= '15:00';
        } catch (_) { alreadyComplete = false; }
      }
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

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
