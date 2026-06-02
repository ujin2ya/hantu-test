#!/usr/bin/env node
/**
 * 1DS 분봉 필요 목록 로컬 커버리지 확인
 *
 * 입력 (required list)의 각 date-code에 대해 로컬 분봉이 09:00~15:30 전체를 커버하는지 검사.
 *
 * 분류:
 *   - complete: 파일 존재 AND 마지막 분봉 time >= '15:30' AND 첫 분봉 time <= '09:01'
 *   - partial:  파일 존재하지만 위 조건 미달 (예: 09:00~10:00만 수집)
 *   - missing:  파일 자체가 없음
 *
 * 입력:
 *   - reports/one-ds-minute-required-list.json  (또는 --input 경로)
 *
 * 출력:
 *   - reports/one-ds-minute-coverage-result.json
 *   - reports/one-ds-minute-coverage-result.html
 *   - reports/one-ds-minute-missing-list.csv      (운영서버 수집용)
 *
 * CLI:
 *   node scripts/one-ds-minute-coverage-check.js
 *   node scripts/one-ds-minute-coverage-check.js --input=reports/one-ds-minute-required-list.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
const DEFAULT_INPUT = path.join(REPORTS_DIR, 'one-ds-minute-required-list.json');
const OUT_JSON = path.join(REPORTS_DIR, 'one-ds-minute-coverage-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-ds-minute-coverage-result.html');
const OUT_MISSING_CSV = path.join(REPORTS_DIR, 'one-ds-minute-missing-list.csv');

const BARS_PER_DAY = 390;
const COMPLETE_LAST_BAR_GE  = '15:30';  // 마지막 분봉이 ≥ 15:30 이면 정규장 끝까지 받은 것
const COMPLETE_FIRST_BAR_LE = '09:01';  // 첫 분봉이 ≤ 09:01 이면 정규장 시작부터 받은 것 (09:00:00~09:01:00 = 09:01)
const MIN_BARS_COMPLETE = 300;          // 전체 정규장 분봉 ~390개. 휴장 일부/지점 결측 감안 300+ 면 complete

function parseArgs(argv) {
  const a = { input: DEFAULT_INPUT };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--input') a.input = argv[++i];
    else if (k.startsWith('--input=')) a.input = k.split('=')[1];
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node scripts/one-ds-minute-coverage-check.js [--input=PATH]');
      process.exit(0);
    }
  }
  return a;
}

function checkOne(date, code) {
  const p = path.join(INTRADAY_BASE, date, code + '.json');
  if (!fs.existsSync(p)) return { status: 'missing', reason: 'file_not_found' };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const bars = Array.isArray(j.bars) ? j.bars : [];
    if (bars.length === 0) return { status: 'missing', reason: 'empty_bars' };
    const firstTime = bars[0].time || '';
    const lastTime  = bars[bars.length - 1].time || '';
    const barsCount = bars.length;
    const firstOk = firstTime !== '' && firstTime <= COMPLETE_FIRST_BAR_LE;
    const lastOk  = lastTime  !== '' && lastTime  >= COMPLETE_LAST_BAR_GE;
    const countOk = barsCount >= MIN_BARS_COMPLETE;
    if (firstOk && lastOk && countOk) {
      return { status: 'complete', firstTime, lastTime, barsCount };
    }
    let reason;
    if (!lastOk)       reason = `last_bar_${lastTime || 'none'}`;
    else if (!firstOk) reason = `first_bar_${firstTime || 'none'}`;
    else               reason = `low_bar_count_${barsCount}`;
    return { status: 'partial', firstTime, lastTime, barsCount, reason };
  } catch (e) {
    return { status: 'missing', reason: 'parse_error' };
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderHtml(meta, summary, perDate, missingPreview, partialPreview) {
  const perDateRows = perDate.map((d) => `<tr>
    <td>${escapeHtml(d.date)}</td>
    <td>${d.required}</td>
    <td>${d.complete}</td>
    <td>${d.partial}</td>
    <td>${d.missing}</td>
    <td>${d.completeRate.toFixed(1)}%</td>
  </tr>`).join('');

  const missingRows = missingPreview.map((r) => `<tr>
    <td>${escapeHtml(r.trade_date)}</td>
    <td>${escapeHtml(r.code)}</td>
    <td>${escapeHtml(r.name)}</td>
    <td>${r.groups.join('|')}</td>
    <td>${escapeHtml(r.missing_reason)}</td>
  </tr>`).join('');

  const partialRows = partialPreview.map((r) => `<tr>
    <td>${escapeHtml(r.trade_date)}</td>
    <td>${escapeHtml(r.code)}</td>
    <td>${escapeHtml(r.name)}</td>
    <td>${r.barsCount}</td>
    <td>${escapeHtml(r.firstTime || '')}</td>
    <td>${escapeHtml(r.lastTime  || '')}</td>
    <td>${escapeHtml(r.reason || '')}</td>
  </tr>`).join('');

  const warning = summary.completeCoverageRate < 80
    ? `<div style="background:#7f1d1d;color:#fef3c7;padding:14px 18px;border-radius:8px;margin:0 0 16px;">
        ⚠ <strong>분봉 커버리지가 낮습니다 (${summary.completeCoverageRate.toFixed(1)}%)</strong>.
        missing CSV를 운영서버로 복사해 분봉을 수집한 뒤 다시 실행하세요.
       </div>`
    : `<div style="background:#14532d;color:#dcfce7;padding:14px 18px;border-radius:8px;margin:0 0 16px;">
        ✅ <strong>커버리지 충분 (${summary.completeCoverageRate.toFixed(1)}%)</strong>. 백테스트 진행 가능.
       </div>`;

  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<title>1DS 분봉 커버리지</title>
<style>
  body { background:#0f172a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; margin:0; padding:20px; }
  h1 { color:#fde047; font-size:22px; margin:0 0 8px; }
  h2 { color:#fde047; font-size:16px; margin:18px 0 8px; }
  .sub { color:#94a3b8; font-size:13px; margin-bottom:16px; }
  .card { background:#1e293b; padding:14px 18px; border-radius:8px; margin:0 0 14px; border-left:4px solid #fde047; }
  table { border-collapse:collapse; width:100%; font-size:13px; background:#0b1320; margin-top:8px; }
  th, td { padding:6px 10px; border:1px solid #1e293b; text-align:left; }
  th { color:#fde047; background:#1e293b; font-weight:700; }
  .note { font-size:12px; color:#94a3b8; background:#1e293b; padding:10px 14px; border-radius:6px; margin:14px 0; }
</style>
</head><body>

<h1>1DS 분봉 커버리지 — ${escapeHtml(meta.inputLabel)}</h1>
<div class="sub">생성: ${escapeHtml(meta.generatedAt)} · 입력 ${escapeHtml(meta.input)}</div>

${warning}

<div class="card">
  <strong>📊 커버리지 요약</strong><br>
  required date-code:  <strong>${summary.requiredDateCodeCount}</strong> 건<br>
  complete:            <strong>${summary.completeDateCodeCount}</strong> 건 (${summary.completeCoverageRate.toFixed(1)}%)<br>
  partial:             <strong>${summary.partialDateCodeCount}</strong> 건 (${summary.partialCoverageRate.toFixed(1)}%)<br>
  missing:             <strong>${summary.missingDateCodeCount}</strong> 건 (${summary.missingRate.toFixed(1)}%)<br>
  추정 missing rows:   ~${summary.estimatedMissingRows.toLocaleString()} (${BARS_PER_DAY} bars × missing)<br>
  추정 partial 보충 rows: ~${summary.estimatedPartialMissingRows.toLocaleString()}
</div>

<h2>📅 거래일별 커버리지</h2>
<table>
  <thead><tr><th>날짜</th><th>required</th><th>complete</th><th>partial</th><th>missing</th><th>complete %</th></tr></thead>
  <tbody>${perDateRows}</tbody>
</table>

${missingPreview.length > 0 ? `
<h2>❌ Missing 미리보기 (상위 ${missingPreview.length}건)</h2>
<table>
  <thead><tr><th>trade_date</th><th>code</th><th>name</th><th>groups</th><th>missing_reason</th></tr></thead>
  <tbody>${missingRows}</tbody>
</table>` : ''}

${partialPreview.length > 0 ? `
<h2>⚠ Partial 미리보기 (상위 ${partialPreview.length}건)</h2>
<table>
  <thead><tr><th>trade_date</th><th>code</th><th>name</th><th>bars</th><th>first</th><th>last</th><th>reason</th></tr></thead>
  <tbody>${partialRows}</tbody>
</table>` : ''}

<div class="note">
  <strong>missing CSV:</strong> ${escapeHtml(path.basename(OUT_MISSING_CSV))} — 운영서버 분봉 수집 입력으로 사용.<br>
  <strong>partial은 missing CSV에 포함</strong> — 부분 데이터를 덮어써서 완전 데이터로 갱신.<br>
  <strong>complete 판정 기준:</strong> 첫 분봉 ≤ ${COMPLETE_FIRST_BAR_LE}, 마지막 분봉 ≥ ${COMPLETE_LAST_BAR_GE}, 분봉 수 ≥ ${MIN_BARS_COMPLETE}.
</div>

</body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  console.log(`🔍 1DS 분봉 커버리지 확인 — input=${args.input}`);
  if (!fs.existsSync(args.input)) {
    console.error(`❌ input 파일 없음: ${args.input}`);
    console.error('   먼저 node scripts/one-ds-minute-requirement-builder.js 를 실행하세요.');
    process.exit(1);
  }
  let req;
  try { req = JSON.parse(fs.readFileSync(args.input, 'utf-8')); }
  catch (e) { console.error('❌ JSON parse 실패:', e.message); process.exit(1); }
  const list = Array.isArray(req.list) ? req.list : [];
  if (list.length === 0) { console.error('❌ list 비어있음'); process.exit(1); }
  console.log(`  required: ${list.length}건`);

  const results = [];
  const perDateMap = new Map();
  let complete = 0, partial = 0, missing = 0;

  for (const r of list) {
    const chk = checkOne(r.trade_date, r.code);
    const out = { ...r, ...chk };
    results.push(out);
    if (chk.status === 'complete') complete++;
    else if (chk.status === 'partial') partial++;
    else missing++;

    const pd = perDateMap.get(r.trade_date) || { date: r.trade_date, required: 0, complete: 0, partial: 0, missing: 0 };
    pd.required++;
    if (chk.status === 'complete') pd.complete++;
    else if (chk.status === 'partial') pd.partial++;
    else pd.missing++;
    perDateMap.set(r.trade_date, pd);
  }

  const total = list.length;
  const summary = {
    requiredDateCodeCount: total,
    completeDateCodeCount: complete,
    partialDateCodeCount:  partial,
    missingDateCodeCount:  missing,
    completeCoverageRate:  total > 0 ? (complete / total) * 100 : 0,
    partialCoverageRate:   total > 0 ? (partial  / total) * 100 : 0,
    missingRate:           total > 0 ? (missing  / total) * 100 : 0,
    estimatedMissingRows:  missing * BARS_PER_DAY,
    estimatedPartialMissingRows: partial * BARS_PER_DAY, // partial도 다시 받아야 한다는 가정
  };

  const perDate = [...perDateMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, completeRate: d.required > 0 ? (d.complete / d.required) * 100 : 0 }));

  const meta = {
    generatedAt: new Date().toISOString(),
    input: args.input,
    inputLabel: req.meta && req.meta.daysOption ? req.meta.daysOption : path.basename(args.input),
    requiredMetaFrom: req.meta && req.meta.windowFrom,
    requiredMetaTo:   req.meta && req.meta.windowTo,
  };

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // JSON
  fs.writeFileSync(OUT_JSON, JSON.stringify({ meta, summary, perDate, results }, null, 2), 'utf-8');
  console.log(`✅ JSON 저장: ${OUT_JSON}`);

  // Missing CSV (partial도 포함 — 다시 받아야 함)
  const csvRows = ['trade_date,code,name,required_from_time,required_to_time,group,event_count,missing_reason'];
  for (const r of results) {
    if (r.status === 'complete') continue;
    const nameEsc = (r.name || '').replace(/"/g, '""');
    csvRows.push(`${r.trade_date},${r.code},"${nameEsc}",09:00,15:30,${(r.groups||[]).join('|')},${r.event_count || 1},${r.reason || r.status}`);
  }
  fs.writeFileSync(OUT_MISSING_CSV, csvRows.join('\r\n') + '\r\n', 'utf-8');
  console.log(`✅ Missing CSV 저장: ${OUT_MISSING_CSV} (${csvRows.length - 1} rows)`);

  // HTML
  const missingPreview = results.filter((r) => r.status === 'missing').slice(0, 30);
  const partialPreview = results.filter((r) => r.status === 'partial').slice(0, 30);
  fs.writeFileSync(OUT_HTML, renderHtml(meta, summary, perDate, missingPreview, partialPreview), 'utf-8');
  console.log(`✅ HTML 저장: ${OUT_HTML}`);

  console.log(`\n📋 커버리지:`);
  console.log(`  complete: ${complete} (${summary.completeCoverageRate.toFixed(1)}%)`);
  console.log(`  partial:  ${partial} (${summary.partialCoverageRate.toFixed(1)}%)`);
  console.log(`  missing:  ${missing} (${summary.missingRate.toFixed(1)}%)`);
  console.log(`  → missing CSV: ${OUT_MISSING_CSV}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}
