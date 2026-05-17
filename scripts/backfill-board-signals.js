#!/usr/bin/env node
/**
 * 기존 reports/*.json + qva-watchlist-board.json (캐시된 1회 보드 결과)을
 * board_signals 테이블에 source_type='CACHE_BACKFILL'로 적재.
 *
 * 정책:
 *   - 보드 generator를 다시 실행하지 않는다 (chart 캐시 재분석 없음, 수초 안에 끝남)
 *   - 이미 적재된 (board_name, signal_kind, signal_date, stock_code) 조합은 UNIQUE 키로 멱등 upsert
 *   - source_type 보호: 기존이 'DAILY_RUN'이면 'CACHE_BACKFILL'로 덮어쓰지 않음 (실데이터 우선)
 *   - 새로 생성되는 daily 보드는 자기 generator의 try/catch에서 sourceType='DAILY_RUN'으로 자동 저장됨
 *
 * 사용:
 *   node scripts/backfill-board-signals.js            # 전체 7 보드
 *   node scripts/backfill-board-signals.js --board ONE_DAY_SURGE
 *
 * 멱등성:
 *   - 재실행해도 inserted=0 / updated=N (UNIQUE 키 + ON DUPLICATE KEY UPDATE)
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const adapters = require('../src/db/saveBoardSignals');
const { closePool, isEnabled } = require('../src/db/mysql');

const ROOT = path.join(__dirname, '..');
const SOURCE_TYPE = 'CACHE_BACKFILL';

// 7 보드 JSON 위치 — root + reports
const BOARDS = [
  {
    key: 'QVA_WATCHLIST',
    jsonPath: path.join(ROOT, 'qva-watchlist-board.json'),
    htmlPath: path.join(ROOT, 'qva-watchlist-board.html'),
    fn: adapters.saveQvaWatchlistBoardToDB,
  },
  {
    key: 'QVA_VVI_REDEFINED',
    jsonPath: path.join(ROOT, 'reports', 'qva-vvi-redefined-board-result.json'),
    htmlPath: path.join(ROOT, 'reports', 'qva-vvi-redefined-board-result.html'),
    fn: adapters.saveQvaVviRedefinedBoardToDB,
  },
  {
    key: 'HGROUP_REBREAK',
    jsonPath: path.join(ROOT, 'reports', 'hgroup-rebreak-operation-board-result.json'),
    htmlPath: path.join(ROOT, 'reports', 'hgroup-rebreak-operation-board-result.html'),
    fn: adapters.saveHgroupRebreakBoardToDB,
  },
  {
    key: 'ONE_DAY_SURGE',
    jsonPath: path.join(ROOT, 'reports', 'one-day-surge-board-result.json'),
    htmlPath: path.join(ROOT, 'reports', 'one-day-surge-board-result.html'),
    fn: adapters.saveOneDaySurgeBoardToDB,
  },
  {
    key: 'QVA2_WATCHLIST',
    jsonPath: path.join(ROOT, 'reports', 'qva2-watchlist-board.json'),
    htmlPath: path.join(ROOT, 'reports', 'qva2-watchlist-board.html'),
    fn: adapters.saveQva2WatchlistBoardToDB,
  },
  {
    key: 'QVA2_D5_REBREAK',
    jsonPath: path.join(ROOT, 'reports', 'qva2-d5-rebreak-board.json'),
    htmlPath: path.join(ROOT, 'reports', 'qva2-d5-rebreak-board.html'),
    fn: adapters.saveQva2D5RebreakBoardToDB,
  },
  {
    key: 'QVA2_VVI',
    jsonPath: path.join(ROOT, 'reports', 'qva2-vvi-board.json'),
    htmlPath: path.join(ROOT, 'reports', 'qva2-vvi-board.html'),
    fn: adapters.saveQva2VviBoardToDB,
  },
];

function parseArgs() {
  const argv = process.argv.slice(2);
  function get(k, def) { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : def; }
  return { board: get('--board', null) };
}

(async () => {
  const t0 = Date.now();
  if (!isEnabled()) { console.error('❌ .env DB_* 미설정. 백필 중단.'); process.exit(1); }

  const opts = parseArgs();
  const targets = opts.board ? BOARDS.filter(b => b.key === opts.board) : BOARDS;
  if (targets.length === 0) {
    console.error('❌ 대상 보드 없음. --board 옵션:', BOARDS.map(b => b.key).join(', '));
    process.exit(1);
  }

  console.log('🗄  board_signals 백필 시작 (source_type=' + SOURCE_TYPE + ')');
  console.log('   대상: ' + targets.length + '개 보드');
  console.log();

  let totalRows = 0, totalInserted = 0, totalUpdated = 0, failed = 0, skipped = 0;
  for (const b of targets) {
    if (!fs.existsSync(b.jsonPath)) {
      console.warn('   ⚠ skip ' + b.key.padEnd(20) + ' — 파일 없음: ' + b.jsonPath);
      skipped++;
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(b.jsonPath, 'utf8'));
      const t1 = Date.now();
      const r = await b.fn(data, {
        jsonPath: b.jsonPath,
        htmlPath: b.htmlPath,
        sourceType: SOURCE_TYPE,
      });
      const dt = ((Date.now() - t1) / 1000).toFixed(2);
      if (r) {
        console.log('   ✓ ' + b.key.padEnd(20) + ' runId=' + r.runId
          + ' rows=' + r.totalRows
          + ' (inserted=' + r.inserted + ' updated=' + r.updated + ')'
          + ' [' + dt + 's]');
        totalRows += r.totalRows;
        totalInserted += r.inserted;
        totalUpdated += r.updated;
      }
    } catch (e) {
      console.error('   ✗ ' + b.key.padEnd(20) + ' FAIL: ' + (e.message || e));
      failed++;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log();
  console.log('✅ 완료 — total rows: ' + totalRows + ' (inserted ' + totalInserted + ' / updated ' + totalUpdated + ')');
  console.log('   failed: ' + failed + ' / skipped: ' + skipped + ' / elapsed: ' + elapsed + 's');
  if (totalInserted === 0 && totalUpdated > 0) {
    console.log('   💡 모두 updated — 이전에 적재된 같은 신호들. 멱등성 정상 작동.');
  }
  await closePool();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
