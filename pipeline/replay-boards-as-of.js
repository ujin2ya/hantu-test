#!/usr/bin/env node
/**
 * board_signals 과거 시점 백필.
 *
 * 정책:
 *   - chart 캐시(cache/stock-charts-long/)의 마지막 N 거래일을 차례로 as_of_date로 설정
 *   - 각 as_of_date에 대해 7 보드를 의존성 순서로 spawnSync 실행
 *   - 각 보드 generator의 chart 로더에 filterRowsAsOf hook이 들어가 있어서
 *     AS_OF_DATE 환경변수 주입으로 그 시점의 chart row만 보고 보드 생성됨
 *   - 보드 generator가 DB 저장(saveXxxBoardToDB)을 try/catch로 호출하므로
 *     자동으로 board_runs / board_signals 누적
 *
 * 사용:
 *   node pipeline/backfill-board-signals.js --days 60
 *   node pipeline/backfill-board-signals.js --start 2026-03-01 --end 2026-05-15
 *   node pipeline/backfill-board-signals.js --dates 2026-05-12,2026-05-13,2026-05-14
 *   node pipeline/backfill-board-signals.js --boards qva-watchlist,qva2-watchlist --days 30
 *
 * 옵션:
 *   --days N           최근 N 거래일 (default 60)
 *   --start YYYY-MM-DD --end YYYY-MM-DD  특정 구간
 *   --dates 콤마구분    명시 날짜 리스트
 *   --boards 이름들    보드 일부만 (default: 전부 7개, 의존성 순서)
 *   --skip-html        HTML/JSON 출력은 어차피 덮어써질 거라 무시 가능. (현재는 의존성 보드용이라 항상 출력)
 *
 * 주의:
 *   - 보드 generator는 출력 파일(reports/*.json, qva-watchlist-board.json 등)도 매 회 덮어씀.
 *     백필 끝나면 최신 날짜로 한 번 더 돌려 .json/.html 최신 상태 복구하는 단계가 별도 필요.
 *   - 백필 1회 ≈ qva-watchlist 30-60초 + 나머지 1-5초씩 = 약 1-2분/일. 60일 ≈ 1-2시간.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');

// 의존성 순서 ↓ 위가 먼저 — 아래 보드들이 위 보드의 .json을 읽음.
const BOARD_PIPELINE = [
  { key: 'qva-watchlist',     file: 'boards/qva/qva-watchlist-board.js' },
  { key: 'qva-vvi-redefined', file: 'boards/qva/qva-vvi-redefined-board.js' },
  { key: 'rebreak',           file: 'boards/rebreak/hgroup-rebreak-operation-board.js' },
  { key: 'qva2-watchlist',    file: 'boards/qva2/qva2-watchlist-board.js' },
  { key: 'qva2-d5-rebreak',   file: 'boards/qva2/qva2-d5-rebreak-board.js' },
  { key: 'qva2-vvi',          file: 'boards/qva2/qva2-vvi-board.js' },
  { key: 'one-day-surge',     file: 'boards/oneDaySurge/one-day-surge-board.js' },
];

function parseArgs() {
  const argv = process.argv.slice(2);
  function get(k, def) { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : def; }
  return {
    days: Number(get('--days', 60)),
    start: get('--start', null),
    end: get('--end', null),
    dates: get('--dates', null),
    boards: get('--boards', null),
  };
}

// 거래일 리스트 추출 — 가장 거래량 많은 종목(005930) chart 사용. 없으면 다른 큰 종목.
function getTradingDates() {
  const candidates = ['005930.json', '000660.json', '035720.json'];
  for (const f of candidates) {
    const fp = path.join(CHART_DIR, f);
    if (!fs.existsSync(fp)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      const rows = (j.rows || []).filter(r => r && r.date && r.volume > 0);
      return rows.map(r => String(r.date)).sort();
    } catch (_) {}
  }
  throw new Error('chart 캐시에서 거래일 추출 실패 (005930/000660/035720 모두 부재)');
}

function ymd(s) { // 20260515 → 2026-05-15
  s = String(s);
  return s.length === 8 ? s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8) : s;
}
function ymdNoDash(s) { return String(s || '').replace(/-/g, ''); }

function pickDates(opts, allDates) {
  if (opts.dates) {
    return opts.dates.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (opts.start || opts.end) {
    const start = ymdNoDash(opts.start || allDates[0]);
    const end   = ymdNoDash(opts.end   || allDates[allDates.length - 1]);
    return allDates.filter(d => d >= start && d <= end).map(ymd);
  }
  const tail = allDates.slice(-Math.max(1, opts.days | 0));
  return tail.map(ymd);
}

function pickBoards(opts) {
  if (!opts.boards) return BOARD_PIPELINE;
  const keys = opts.boards.split(',').map(s => s.trim()).filter(Boolean);
  return BOARD_PIPELINE.filter(b => keys.includes(b.key));
}

(async () => {
  const t0 = Date.now();
  const opts = parseArgs();
  const allDates = getTradingDates();
  const targetDates = pickDates(opts, allDates);
  const boards = pickBoards(opts);

  if (targetDates.length === 0) { console.error('대상 날짜 없음'); process.exit(1); }

  console.log('🗓 board_signals 백필 시작');
  console.log('   대상 거래일: ' + targetDates.length + '개 (' + targetDates[0] + ' ~ ' + targetDates[targetDates.length-1] + ')');
  console.log('   대상 보드:   ' + boards.length + '개 (' + boards.map(b => b.key).join(', ') + ')');
  console.log('   예상 시간:   약 ' + Math.round(targetDates.length * boards.length * 8 / 60) + '분');
  console.log();

  let totalOk = 0, totalFail = 0;
  for (let i = 0; i < targetDates.length; i++) {
    const date = targetDates[i];
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`▶ [${i+1}/${targetDates.length}] as_of=${date} (elapsed ${elapsed}s)`);
    for (const b of boards) {
      const t1 = Date.now();
      try {
        execSync(`node ${path.join(ROOT, b.file)}`, {
          stdio: 'pipe',
          env: { ...process.env, AS_OF_DATE: date },
        });
        const dt = ((Date.now() - t1) / 1000).toFixed(1);
        console.log(`    ✓ ${b.key.padEnd(20)} (${dt}s)`);
        totalOk++;
      } catch (e) {
        const msg = (e.stderr ? e.stderr.toString() : e.message || '').slice(0, 200);
        console.log(`    ✗ ${b.key.padEnd(20)} ERROR: ${msg}`);
        totalFail++;
      }
    }
  }
  const totalElapsed = ((Date.now() - t0) / 60000).toFixed(1);
  console.log();
  console.log(`✅ 백필 완료: OK ${totalOk} / FAIL ${totalFail} / 총 ${totalElapsed}분`);
  console.log(`   다음 단계:`);
  console.log(`     1. node pipeline/populate-signal-outcomes.js --lookback ${(opts.days || 60) + 30}`);
  console.log(`     2. node pipeline/reconcile-signal-links.js --lookback ${(opts.days || 60) + 30}`);
  console.log(`     3. (선택) 최신 날짜 보드 1회 재실행 — .json/.html 최신 상태 복구`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
