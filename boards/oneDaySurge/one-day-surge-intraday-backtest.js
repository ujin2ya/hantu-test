#!/usr/bin/env node
/*
 * 1DS 장초 분봉 ENTRY 조건 grid-search 백테스트 (복원판)
 * ---------------------------------------------------------------
 * 목적: 보드의 장초 분봉 게이트(peakBeforeEntry 컷 / ENTRY V1~V5 / morningHigh 재돌파)가
 *       실제로 forward 성과를 가르는지 measured 로 재검증.
 *
 * 재료:
 *   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json  (1분봉, 87일 × ~300~500 종목)
 *   - cache/stock-charts-long/{code}.json          (일봉 rows)
 *
 * 재구성 (보드와 동일 시맨틱):
 *   분봉 파일 날짜 = T (진입일 아침).
 *   eventBase  = 전일(T-1) 일봉   → close / high / valueAmount / avg20Value
 *   minuteData = T 아침 분봉
 *   entry      = T 09:10 종가 (im.entryPrice)
 *   outcome    = T 일봉 high/low/close (computeOutcomes)
 *
 * 보존된 라이브러리 재사용: computeIntradayMetrics / applyEntryConditions / computeOutcomes / summarizeBucket
 *
 * 실행: node boards/oneDaySurge/one-day-surge-intraday-backtest.js [--from YYYYMMDD] [--to YYYYMMDD] [--limit-per-day N]
 */
const fs = require('fs');
const path = require('path');
const entryReport = require('./one-day-surge-entry-confirm-report.js');

const ROOT = path.join(__dirname, '..', '..');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  return {
    from: get('--from'),
    to: get('--to'),
    limitPerDay: get('--limit-per-day') ? Number(get('--limit-per-day')) : null,
  };
}

// 일봉 캐시 메모이즈 — {code: rows[]}
const chartCache = new Map();
function loadDailyRows(code) {
  if (chartCache.has(code)) return chartCache.get(code);
  const fp = path.join(CHART_DIR, code + '.json');
  let rows = null;
  if (fs.existsSync(fp)) {
    try { rows = (JSON.parse(fs.readFileSync(fp, 'utf-8')).rows) || null; } catch (_) { rows = null; }
  }
  chartCache.set(code, rows);
  return rows;
}

// T(YYYYMMDD)에 대한 eventBase(T-1) + outcome(T) 재구성
function buildBaseAndOutcome(code, dateYmd) {
  const rows = loadDailyRows(code);
  if (!rows || rows.length < 25) return null;
  const i = rows.findIndex((r) => String(r.date) === dateYmd);
  if (i < 21) return null;                 // avg20 + 전일 확보 불가
  const cur = rows[i];                     // T 일봉 (outcome)
  const prev = rows[i - 1];                // T-1 일봉 (eventBase)
  if (!cur || !prev) return null;
  if (!(cur.high > 0) || !(cur.low > 0) || !(cur.close > 0)) return null;   // 거래정지일 제외
  if (!(prev.close > 0) || !(prev.high > 0)) return null;
  const win = rows.slice(i - 20, i);       // 전일 포함 직전 20봉
  const avg20Value = win.reduce((s, r) => s + (r.valueApprox || 0), 0) / win.length;
  return {
    eventBase: { close: prev.close, high: prev.high, valueAmount: prev.valueApprox || 0, avg20Value },
    nextDayRow: { high: cur.high, low: cur.low, close: cur.close },
  };
}

function pct(n, d) { return d > 0 ? (100 * n / d) : null; }

// ── lookahead-free outcome: 09:10 진입 후 (09:10, 10:00] 분봉 고가/저가/종가 ──
// 일봉 고가 프록시의 순환 오염 제거. 모든 날짜가 최소 10:00까지 분봉이 있어 horizon 일관.
function computeIntradayOutcome(bars, entryPrice) {
  if (!Array.isArray(bars) || !(entryPrice > 0)) return null;
  const post = bars.filter((b) => b && b.time > '09:10' && b.time <= '10:00' && Number.isFinite(b.high));
  if (post.length === 0) return null;
  const hi = Math.max(...post.map((b) => b.high || 0));
  const lo = Math.min(...post.map((b) => b.low || Infinity));
  const lastClose = post[post.length - 1].close;
  const afterEntryHighRate  = (hi / entryPrice - 1) * 100;
  const afterEntryLowRate   = (lo / entryPrice - 1) * 100;
  const afterEntryCloseRate = (lastClose / entryPrice - 1) * 100;
  return {
    afterEntryHighRate, afterEntryLowRate, afterEntryCloseRate,
    peakBeforeEntry: false, // 정의상 진입 이후만 보므로 lookahead 없음
    hit3: afterEntryHighRate >= 3, hit5: afterEntryHighRate >= 5, hit7: afterEntryHighRate >= 7,
    fail3: afterEntryLowRate <= -3, fail5: afterEntryLowRate <= -5,
    closePositive: afterEntryCloseRate > 0,
  };
}

function main() {
  const args = parseArgs();
  if (!fs.existsSync(INTRADAY_BASE)) { console.error('분봉 디렉토리 없음:', INTRADAY_BASE); process.exit(1); }
  let dirs = fs.readdirSync(INTRADAY_BASE).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (args.from) dirs = dirs.filter((d) => d.replace(/-/g, '') >= args.from);
  if (args.to) dirs = dirs.filter((d) => d.replace(/-/g, '') <= args.to);

  const events = [];   // { im, out, versions }
  let scanned = 0, noChart = 0, noIm = 0, noOut = 0;

  for (const dir of dirs) {
    const dateYmd = dir.replace(/-/g, '');
    const files = fs.readdirSync(path.join(INTRADAY_BASE, dir)).filter((f) => f.endsWith('.json'));
    let used = 0;
    for (const f of files) {
      if (args.limitPerDay && used >= args.limitPerDay) break;
      const code = f.replace('.json', '');
      scanned++;
      const bo = buildBaseAndOutcome(code, dateYmd);
      if (!bo) { noChart++; continue; }
      let minuteData;
      try { minuteData = JSON.parse(fs.readFileSync(path.join(INTRADAY_BASE, dir, f), 'utf-8')); } catch (_) { continue; }
      const im = entryReport.computeIntradayMetrics(bo.eventBase, minuteData);
      if (!im) { noIm++; continue; }
      const out = entryReport.computeOutcomes(im, bo.nextDayRow);
      if (!out) { noOut++; continue; }
      const outIntra = computeIntradayOutcome(minuteData.bars || [], im.entryPrice);
      const versions = entryReport.applyEntryConditions(im);
      events.push({ im, out, outIntra, versions, code, date: dateYmd });
      used++;
    }
  }

  console.log(`\n스캔 ${scanned} | 사용 ${events.length} | 일봉없음/부족 ${noChart} | IM무효 ${noIm} | OUT무효 ${noOut}`);
  console.log(`기간 ${dirs[0]} ~ ${dirs[dirs.length - 1]}  (${dirs.length} 거래일)\n`);

  // ── 버킷 헬퍼 ──  USE_INTRA=true → lookahead-free 분봉 outcome 사용
  let USE_INTRA = true;
  const evList = USE_INTRA ? events.filter((e) => e.outIntra) : events;
  const S = (evs) => entryReport.summarizeBucket(evs.map((e) => ({ outcome: USE_INTRA ? e.outIntra : e.out })));
  function row(label, evs, baseN) {
    const s = S(evs);
    const share = baseN ? `${(100 * s.count / baseN).toFixed(0)}%` : '';
    const fmt = (v) => v == null ? '  -  ' : `${v.toFixed(1)}%`;
    return [
      label.padEnd(28),
      String(s.count).padStart(6),
      share.padStart(5),
      fmt(s.hit5Rate).padStart(7),
      fmt(s.hit3Rate).padStart(7),
      fmt(s.fail5Rate).padStart(7),
      fmt(s.closePositiveRate).padStart(7),
      (s.avgAfterHigh == null ? '  -  ' : s.avgAfterHigh.toFixed(2)).padStart(8),
      (s.avgAfterClose == null ? '  -  ' : s.avgAfterClose.toFixed(2)).padStart(8),
      fmt(s.peakBeforeEntryRate).padStart(7),
    ].join(' ');
  }
  const HEAD = ['bucket'.padEnd(28), 'n'.padStart(6), 'share'.padStart(5),
    'hit5'.padStart(7), 'hit3'.padStart(7), 'fail5'.padStart(7), 'clos+'.padStart(7),
    'avgHi'.padStart(8), 'avgClo'.padStart(8), 'pkBfr'.padStart(7)].join(' ');
  const N = evList.length;
  const sep = '─'.repeat(HEAD.length);

  console.log('【 A. 베이스라인 + ENTRY 조건별 】');
  console.log(HEAD); console.log(sep);
  console.log(row('ALL (베이스라인)', evList, N));
  for (const v of ['entryV1', 'entryV2', 'entryV3', 'entryV4', 'entryV5']) {
    console.log(row(v, evList.filter((e) => e.versions[v]), N));
  }
  console.log(row('morningHigh 재돌파(10_30)', evList.filter((e) => e.im.rebreakMorningHigh_10_30), N));
  console.log(row('  └ 미재돌파', evList.filter((e) => !e.im.rebreakMorningHigh_10_30), N));
  console.log(row('prevHigh 돌파 by 0930', evList.filter((e) => e.im.rebreakPrevHighBy0930), N));
  console.log(row('  └ morningHigh & prevHigh 둘다', evList.filter((e) => e.im.rebreakMorningHigh_10_30 && e.im.rebreakPrevHighBy0930), N));

  // ── B. peakBeforeEntry 컷 임계값 sweep ──
  // 컷 = preEntryMaxHigh > entryPrice*(1+thr/100). 컷되면 보드에서 mainPool 제외 + 점수 -60.
  // 핵심: "컷되는 쪽(CUT)"이 실제로 성과가 나쁜가? 나쁘지 않으면 컷이 알파를 죽이는 것.
  console.log('\n【 B. peakBeforeEntryLive 컷 임계값 sweep — KEEP(통과) vs CUT(제외) 성과 비교 】');
  console.log(HEAD); console.log(sep);
  for (const thr of [1.0, 1.5, 2.0, 3.0]) {
    const cut = (e) => e.im.preEntryMaxHigh != null && e.im.entryPrice != null
      && e.im.preEntryMaxHigh > e.im.entryPrice * (1 + thr / 100);
    const keep = evList.filter((e) => !cut(e));
    const dropped = evList.filter((e) => cut(e));
    console.log(row(`thr=${thr}% KEEP(통과)`, keep, N));
    console.log(row(`thr=${thr}% CUT(제외→-60)`, dropped, N));
    console.log(sep);
  }

  // ── B2. peakBeforeEntry(2%) × morningHigh 재돌파 교차 ──
  // 보드는 재돌파 시 peakBefore를 면제함. 그래서 "재돌파 없는 peakBefore"만이 진짜 컷 대상.
  // 4분면으로 컷이 실제 어디서 알파를 죽이는지 확인.
  console.log('\n【 B2. peakBeforeEntry(2%) × morningHigh 재돌파 교차 — 컷의 진짜 타깃 분리 】');
  console.log(HEAD); console.log(sep);
  const pb2 = (e) => e.im.preEntryMaxHigh != null && e.im.entryPrice != null
    && e.im.preEntryMaxHigh > e.im.entryPrice * 1.02;
  const rb = (e) => e.im.rebreakMorningHigh_10_30;
  console.log(row('재돌파O & peakBeforeX', evList.filter((e) => rb(e) && !pb2(e)), N));
  console.log(row('재돌파O & peakBeforeO(면제됨)', evList.filter((e) => rb(e) && pb2(e)), N));
  console.log(row('재돌파X & peakBeforeX', evList.filter((e) => !rb(e) && !pb2(e)), N));
  console.log(row('재돌파X & peakBeforeO(순수컷)', evList.filter((e) => !rb(e) && pb2(e)), N));

  // ── C. morningHigh 재돌파 × 10:00 이후 유지 여부 ──
  // 보드는 10:00에서 윈도우 컷. 재돌파가 "유지"되는지(고점이 10:00 이후에도 안 깨졌는지)가
  // 진짜 알파인지 검증. raw bars 에서 직접 계산.
  console.log('\n【 C. morningHigh 재돌파 → 10:00 이후 유지 여부 (raw bars) 】');
  console.log('  (※ 분봉이 10:00 이후까지 있는 종목만 hold 판정 가능)');
  console.log(HEAD); console.log(sep);
  // 이미 events에는 im 만 있고 raw bars 없음 → 재로드 필요. events에 bars 보존 안 했으므로 스킵 표시.
  console.log('  (raw-bar hold 분석은 B/A 결과 확인 후 2차에서 추가 — 메모리 절약 위해 1차 생략)');

  // ── JSON 저장 ──
  const summaryJson = {
    period: { from: dirs[0], to: dirs[dirs.length - 1], tradingDays: dirs.length },
    scanned, used: events.length,
    baseline: S(evList),
    entryVersions: Object.fromEntries(['entryV1','entryV2','entryV3','entryV4','entryV5']
      .map((v) => [v, S(evList.filter((e) => e.versions[v]))])),
    morningHighRebreak: S(evList.filter((e) => e.im.rebreakMorningHigh_10_30)),
    peakBeforeSweep: [1.0, 1.5, 2.0, 3.0].map((thr) => {
      const cut = (e) => e.im.preEntryMaxHigh != null && e.im.entryPrice != null
        && e.im.preEntryMaxHigh > e.im.entryPrice * (1 + thr / 100);
      return { thr, keep: S(evList.filter((e) => !cut(e))), cut: S(evList.filter((e) => cut(e))) };
    }),
  };
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = path.join(REPORTS_DIR, 'one-day-surge-intraday-backtest.json');
  fs.writeFileSync(outPath, JSON.stringify(summaryJson, null, 2));
  console.log(`\n저장: ${path.relative(ROOT, outPath)}`);
  console.log('\n읽는 법(분봉 기준, lookahead 없음): hit5 = 09:10진입 후 (09:10,10:00] 분봉 고가 +5% 도달 비율, fail5 = 분봉 저가 -5% 도달, avgClo = 10:00 분봉종가 평균수익. pkBfr=0(정의상).');
}

main();
