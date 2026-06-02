#!/usr/bin/env node
/**
 * 1DS 관찰 제외 +8% 고가권 유지/재돌파 사전탐지 백테스트 — 분봉 필요 목록 생성기
 *
 * 기존 1DS 백테스트가 식별한 3개 이벤트 그룹(A 공격형 / B 10시 생존 / D 관찰 제외 +8%)에 대해
 * 운영서버에서 받아야 할 분봉 date-code 목록을 산출한다.
 *
 * **C 관찰 제외 전체는 제외** (너무 많음, 가설 핵심은 D 내부 구분).
 * **수집 시간 범위는 09:00~15:30** (장중 hold/rebreak 조건 계산용).
 *
 * 새 임계값 도입 금지 — 기존 backtest와 동일한 scanner status + finalScore 기반 분류 재사용.
 *
 * 입력:
 *   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json (기존 분봉)
 *   - cache/stock-charts-long/{code}.json         (일봉)
 *   - stocks.json / cache/naver-stocks-list.json
 *
 * 출력:
 *   - reports/one-ds-minute-required-list.json
 *   - reports/one-ds-minute-required-summary.html
 *   - reports/one-ds-minute-required-date-code.csv
 *
 * CLI:
 *   node scripts/one-ds-minute-requirement-builder.js              # 기본 --days=20
 *   node scripts/one-ds-minute-requirement-builder.js --days=20
 *   node scripts/one-ds-minute-requirement-builder.js --days=60
 *   node scripts/one-ds-minute-requirement-builder.js --days=all
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'one-ds-minute-required-list.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-ds-minute-required-summary.html');
const OUT_CSV  = path.join(REPORTS_DIR, 'one-ds-minute-required-date-code.csv');

const scanner = require(path.join(ROOT, 'boards', 'oneDaySurge', 'one-day-surge-0930-scanner'));

const ATTACK_TOP_N    = 5;     // 기존 backtest와 동일
const PLUS8_THRESHOLD = 0.08;
const BARS_PER_DAY    = 390;   // 정규장 09:01~15:30 ≈ 390 분봉 (close 단일 + opening 30s 단일)

function parseArgs(argv) {
  const a = { days: 20 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--days') a.days = argv[++i];
    else if (k.startsWith('--days=')) a.days = k.split('=')[1];
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node scripts/one-ds-minute-requirement-builder.js [--days=20|60|all]');
      process.exit(0);
    }
  }
  return a;
}

function listIntradayDates() {
  if (!fs.existsSync(INTRADAY_BASE)) return [];
  return fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

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

function findDayAndBase(rows, dateNumStr) {
  if (!Array.isArray(rows)) return null;
  const idx = rows.findIndex((r) => r.date === dateNumStr);
  if (idx < 22) return null;
  return { dIdx: idx, dRow: rows[idx], baseRow: rows[idx - 1] };
}

function calcAvg20Value(rows, dIdx) {
  let sum = 0, n = 0;
  for (let i = dIdx - 21; i < dIdx - 1; i++) {
    const r = rows[i];
    if (r && r.volume > 0) { sum += (r.valueApprox || 0); n++; }
  }
  return n > 0 ? sum / n : 0;
}

function extractSnapshot(bars, cutoff) {
  const inWin = bars.filter((b) => b && b.time && b.time <= cutoff && b.close > 0);
  if (inWin.length === 0) return { available: false };
  const last = inWin[inWin.length - 1];
  return { available: true, signalPrice: last.close };
}

// 한 날의 A/B/D 이벤트 식별
function analyzeDay(dateDir, metaMap) {
  const dir = path.join(INTRADAY_BASE, dateDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return [];
  const dateNumStr = dateDir.replace(/-/g, '');

  const dayCands = [];

  for (const fname of files) {
    const code = fname.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    if (!meta) continue;

    const rows = loadChartRows(code);
    if (!rows) continue;

    const dayInfo = findDayAndBase(rows, dateNumStr);
    if (!dayInfo) continue;
    const { dIdx, dRow, baseRow } = dayInfo;
    if (!baseRow || !(baseRow.close > 0) || !dRow || !(dRow.close > 0)) continue;

    const avg20 = calcAvg20Value(rows, dIdx);
    const baseValue = baseRow.valueApprox || 0;
    const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
    if (!liq.ok) continue;

    let bars;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8'));
      bars = j.bars || [];
    } catch (_) { continue; }
    if (bars.length === 0) continue;

    const m = scanner.computeMetrics0930(bars, baseRow);
    if (!m) continue;
    const status = scanner.classifyStatus(m);
    if (status === 'INSUFFICIENT_BARS') continue;

    const finalScore = scanner.computeFinalScore(m);
    const snap0930 = extractSnapshot(bars, '09:30');
    const snap1000 = extractSnapshot(bars, '10:00');

    const prevClose = baseRow.close;
    const isC = (status === 'WAIT_PULLBACK' || status === 'FADED' || status === 'WEAK');
    const isReady = status === 'READY';

    dayCands.push({
      code, name: meta.name || code,
      status, finalScore, prevClose,
      snap0930, snap1000,
      isReady, isC,
    });
  }

  // 같은 날 안에서 READY 후보 finalScore desc, 상위 N = A
  const readyEvents = dayCands.filter((c) => c.isReady).sort((a, b) => b.finalScore - a.finalScore);
  readyEvents.forEach((c, i) => { c.isA = (i + 1) <= ATTACK_TOP_N; });

  const events = [];
  for (const c of dayCands) {
    const groups = [];
    if (c.isReady && c.isA) groups.push('A_ATTACK');
    if (c.isReady && c.snap1000.available && c.snap0930.available && c.snap1000.signalPrice > c.snap0930.signalPrice) {
      groups.push('B_SURVIVOR_1000');
    }
    if (c.isC && c.snap1000.available && (c.snap1000.signalPrice / c.prevClose - 1) >= PLUS8_THRESHOLD) {
      groups.push('D_EXCLUDED_PLUS8');
    }
    if (groups.length === 0) continue;
    events.push({
      date: dateDir,
      code: c.code,
      name: c.name,
      status: c.status,
      groups,
    });
  }
  return events;
}

// 그룹별 + 그룹병합 dedupe
function buildRequiredList(allEvents) {
  // unique date+code → groups merged
  const map = new Map();
  let eventCountByGroup = { A_ATTACK: 0, B_SURVIVOR_1000: 0, D_EXCLUDED_PLUS8: 0 };
  for (const e of allEvents) {
    for (const g of e.groups) eventCountByGroup[g] = (eventCountByGroup[g] || 0) + 1;
    const key = `${e.date}|${e.code}`;
    if (!map.has(key)) {
      map.set(key, {
        trade_date: e.date,
        code: e.code,
        name: e.name,
        status: e.status,
        groups: new Set(e.groups),
        event_count: 0,
      });
    }
    const r = map.get(key);
    for (const g of e.groups) r.groups.add(g);
    r.event_count += e.groups.length;
  }
  const list = [...map.values()]
    .map((r) => ({ ...r, groups: [...r.groups].sort() }))
    .sort((a, b) => a.trade_date === b.trade_date ? a.code.localeCompare(b.code) : a.trade_date.localeCompare(b.trade_date));
  return { list, eventCountByGroup };
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderHtml(meta, summary, list, projections) {
  const top20 = list.slice(0, 20);
  const tableRows = top20.map((r) => `<tr>
    <td>${escapeHtml(r.trade_date)}</td>
    <td>${escapeHtml(r.code)}</td>
    <td>${escapeHtml(r.name)}</td>
    <td>${escapeHtml(r.status)}</td>
    <td>${r.groups.join('|')}</td>
    <td>${r.event_count}</td>
  </tr>`).join('');

  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<title>1DS 분봉 필요 목록 요약</title>
<style>
  body { background:#0f172a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; margin:0; padding:20px; }
  h1 { color:#fde047; font-size:22px; margin:0 0 8px; }
  .sub { color:#94a3b8; font-size:13px; margin-bottom:16px; }
  .card { background:#1e293b; padding:14px 18px; border-radius:8px; margin:0 0 14px; border-left:4px solid #fde047; }
  .card strong { color:#fde047; }
  table { border-collapse:collapse; width:100%; font-size:13px; background:#0b1320; margin-top:8px; }
  th, td { padding:6px 10px; border:1px solid #1e293b; text-align:left; }
  th { color:#fde047; background:#1e293b; font-weight:700; }
  .note { font-size:12px; color:#94a3b8; background:#1e293b; padding:10px 14px; border-radius:6px; margin:14px 0; }
</style>
</head><body>

<h1>1DS 분봉 필요 목록 — ${escapeHtml(meta.daysOption)}</h1>
<div class="sub">
  생성: ${escapeHtml(meta.generatedAt)} · 분봉 가용 ${escapeHtml(meta.intradayDateFrom)} ~ ${escapeHtml(meta.intradayDateTo)} ·
  대상 거래일 ${meta.tradingDaysUsed}일 (${escapeHtml(meta.windowFrom)} ~ ${escapeHtml(meta.windowTo)})
</div>

<div class="card">
  <strong>📌 수집 대상 정의</strong><br>
  이번 분봉 수집은 <strong>전체 종목 대상이 아니라</strong> A 공격형 + B 10시 생존 + D 관찰 제외 +8% <strong>이벤트 종목만</strong> 대상으로 한다.<br>
  C 관찰 제외 전체(약 18,000건)는 수집 대상에서 제외.
</div>

<div class="card">
  <strong>📊 이벤트 카운트</strong><br>
  A 공격형:           ${summary.eventCountByGroup.A_ATTACK || 0} 건<br>
  B 10시 생존:        ${summary.eventCountByGroup.B_SURVIVOR_1000 || 0} 건<br>
  D 관찰 제외 +8%:    ${summary.eventCountByGroup.D_EXCLUDED_PLUS8 || 0} 건<br>
  합계 (중복 포함):   ${(summary.eventCountByGroup.A_ATTACK||0)+(summary.eventCountByGroup.B_SURVIVOR_1000||0)+(summary.eventCountByGroup.D_EXCLUDED_PLUS8||0)} 건
</div>

<div class="card">
  <strong>🎯 분봉 수집 대상</strong><br>
  중복 제거 전 date-code: <strong>${summary.dateCodePairsRaw}</strong>건<br>
  중복 제거 후 unique:    <strong>${summary.uniqueDateCodes}</strong>건<br>
  예상 1분봉 row 수:      <strong>${summary.uniqueDateCodes * BARS_PER_DAY}</strong> rows (× ${BARS_PER_DAY} bars/day)
</div>

<div class="card">
  <strong>🗓 기간별 예상 row 수 (이번 윈도우의 일평균 unique date-code × N일 × 390 으로 추산)</strong><br>
  20거래일: ${projections.proj20.toLocaleString()} rows (${projections.proj20Codes} unique date-codes)<br>
  60거래일: ${projections.proj60.toLocaleString()} rows (${projections.proj60Codes} unique date-codes)<br>
  all 거래일 (${meta.totalAvailableDays}일): ${projections.projAll.toLocaleString()} rows (${projections.projAllCodes} unique date-codes)
</div>

<div class="note">
  <strong>분봉 수집 시간 범위:</strong> 09:00~15:30 (정규장 전체).<br>
  hold/rebreak 조건 계산에 10:00, 11:00, 13:00, 14:00 시점이 모두 필요해 부분 분봉 불가.
</div>

<h2 style="color:#fde047;font-size:16px;margin:18px 0 8px;">상위 20건 미리보기 (전체는 CSV/JSON 참고)</h2>
<table>
  <thead><tr><th>trade_date</th><th>code</th><th>name</th><th>status</th><th>groups</th><th>event_count</th></tr></thead>
  <tbody>${tableRows}</tbody>
</table>

<div class="note" style="margin-top:18px;">
  <strong>다음 단계:</strong><br>
  1. <code>node scripts/one-ds-minute-coverage-check.js --input=reports/one-ds-minute-required-list.json</code><br>
  2. 결과의 missing CSV를 운영서버로 복사해 KIS 분봉 수집 실행<br>
  3. 수집 완료 후 로컬로 sync<br>
  4. <code>node scripts/one-ds-excluded-plus8-intraday-hold-rebreak-audit.js --days=20</code>
</div>

</body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  console.log(`🔍 1DS 분봉 필요 목록 생성 — days=${args.days}`);
  const metaMap = scanner.loadStockMetaMap();
  const allDates = listIntradayDates();
  if (allDates.length === 0) {
    console.error('❌ data/intraday/1ds/ 디렉토리 없음');
    process.exit(1);
  }

  // 날짜 윈도우 선택
  let windowDates;
  if (args.days === 'all' || args.days === 'ALL') {
    windowDates = allDates;
  } else {
    const n = parseInt(args.days, 10);
    if (!Number.isFinite(n) || n <= 0) { console.error('❌ --days는 양의 정수 또는 all'); process.exit(1); }
    windowDates = allDates.slice(-n);
  }
  console.log(`  분봉 가용 거래일: ${allDates.length}일 (${allDates[0]} ~ ${allDates[allDates.length-1]})`);
  console.log(`  대상 윈도우:      ${windowDates.length}일 (${windowDates[0]} ~ ${windowDates[windowDates.length-1]})`);

  const allEvents = [];
  for (const dateDir of windowDates) {
    const evts = analyzeDay(dateDir, metaMap);
    const a = evts.filter((e) => e.groups.includes('A_ATTACK')).length;
    const b = evts.filter((e) => e.groups.includes('B_SURVIVOR_1000')).length;
    const d = evts.filter((e) => e.groups.includes('D_EXCLUDED_PLUS8')).length;
    console.log(`  ${dateDir}: A=${a} B=${b} D=${d} (unique events=${evts.length})`);
    allEvents.push(...evts);
  }

  const { list, eventCountByGroup } = buildRequiredList(allEvents);
  const dateCodePairsRaw = allEvents.reduce((s, e) => s + e.groups.length, 0);
  const uniqueDateCodes = list.length;
  const uniquePerDay = windowDates.length > 0 ? uniqueDateCodes / windowDates.length : 0;
  const projections = {
    proj20Codes:  Math.round(uniquePerDay * 20),
    proj60Codes:  Math.round(uniquePerDay * 60),
    projAllCodes: Math.round(uniquePerDay * allDates.length),
    proj20:  Math.round(uniquePerDay * 20  * BARS_PER_DAY),
    proj60:  Math.round(uniquePerDay * 60  * BARS_PER_DAY),
    projAll: Math.round(uniquePerDay * allDates.length * BARS_PER_DAY),
  };

  const meta = {
    generatedAt: new Date().toISOString(),
    daysOption: args.days === 'all' ? 'all (전체 가용 기간)' : `최근 ${args.days}거래일`,
    intradayDateFrom: allDates[0],
    intradayDateTo: allDates[allDates.length - 1],
    totalAvailableDays: allDates.length,
    tradingDaysUsed: windowDates.length,
    windowFrom: windowDates[0],
    windowTo: windowDates[windowDates.length - 1],
    barsPerDay: BARS_PER_DAY,
  };

  const summary = {
    eventCountByGroup,
    totalEvents: allEvents.length,
    dateCodePairsRaw,
    uniqueDateCodes,
    estimatedTotalRows: uniqueDateCodes * BARS_PER_DAY,
  };

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // JSON
  fs.writeFileSync(OUT_JSON, JSON.stringify({ meta, summary, projections, list }, null, 2), 'utf-8');
  console.log(`✅ JSON  저장: ${OUT_JSON} (${uniqueDateCodes}건)`);

  // CSV
  const csvRows = ['trade_date,code,name,required_from_time,required_to_time,reason,group,event_count'];
  for (const r of list) {
    const reason = r.groups.includes('D_EXCLUDED_PLUS8') ? 'excluded_plus8_at_1000' :
                   r.groups.includes('B_SURVIVOR_1000') ? 'survivor_1000' :
                   'attack_top_finalscore';
    const nameEsc = (r.name || '').replace(/"/g, '""');
    csvRows.push(`${r.trade_date},${r.code},"${nameEsc}",09:00,15:30,${reason},${r.groups.join('|')},${r.event_count}`);
  }
  fs.writeFileSync(OUT_CSV, csvRows.join('\r\n') + '\r\n', 'utf-8');
  console.log(`✅ CSV   저장: ${OUT_CSV} (${list.length} rows)`);

  // HTML
  fs.writeFileSync(OUT_HTML, renderHtml(meta, summary, list, projections), 'utf-8');
  console.log(`✅ HTML  저장: ${OUT_HTML}`);

  console.log(`\n📋 요약:`);
  console.log(`  A 이벤트:        ${eventCountByGroup.A_ATTACK || 0}`);
  console.log(`  B 이벤트:        ${eventCountByGroup.B_SURVIVOR_1000 || 0}`);
  console.log(`  D 이벤트:        ${eventCountByGroup.D_EXCLUDED_PLUS8 || 0}`);
  console.log(`  중복 제거 전:    ${dateCodePairsRaw}`);
  console.log(`  unique date-code: ${uniqueDateCodes}`);
  console.log(`  예상 1분봉 rows: ${(uniqueDateCodes * BARS_PER_DAY).toLocaleString()}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}
