#!/usr/bin/env node
/**
 * reports/*.json + qva-watchlist-board.json 의 candidate를
 * funnel 단계별 row 여러 개로 explosion해서 DB에 적재.
 *
 * - explosion 지원 보드 (4개): QVA_WATCHLIST / QVA2_WATCHLIST / QVA2_D5_REBREAK / HGROUP_REBREAK
 * - 다른 3개 보드 (QVA_VVI_REDEFINED / QVA2_VVI / ONE_DAY_SURGE)는 explosion 효과 없어 skip
 *   (기존 scripts/backfill-board-signals.js 가 1 candidate = 1 row로 이미 적재함)
 *
 * 효과:
 *   - 한 BREAKOUT_SUCCESS candidate (4/10 QVA2 발생 → 5/3 VVI2 발화 → 5/12 돌파) →
 *     3 rows (QVA2_NEW 4/10, VVI2_FIRED 5/3, BREAKOUT_SUCCESS 5/12)
 *   - matchMode=all "VVI2_FIRED + BREAKOUT_SUCCESS 모두 가진 종목" 같은 쿼리가 의미있어짐
 *
 * 사용:
 *   node scripts/explode-and-backfill.js
 *   node scripts/explode-and-backfill.js --board QVA2_WATCHLIST
 *
 * 멱등: UNIQUE(board_name, signal_kind, signal_date, stock_code) + ON DUPLICATE KEY UPDATE.
 *       source_type='DAILY_RUN'으로 이미 들어가 있는 행은 보호됨 (덮어쓰지 않음).
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { explodeBoardJson, EXPLOSION_RULES } = require('../src/db/explodeBoardSignals');
const repo = require('../src/db/boardSignalRepository');
const { closePool, isEnabled } = require('../src/db/mysql');

const ROOT = path.join(__dirname, '..');
const SOURCE_TYPE = 'CACHE_BACKFILL';

const BOARDS = [
  { key: 'QVA_WATCHLIST',     jsonPath: path.join(ROOT, 'qva-watchlist-board.json'),                              htmlPath: path.join(ROOT, 'qva-watchlist-board.html') },
  { key: 'QVA2_WATCHLIST',    jsonPath: path.join(ROOT, 'reports', 'qva2-watchlist-board.json'),                  htmlPath: path.join(ROOT, 'reports', 'qva2-watchlist-board.html') },
  { key: 'QVA2_D5_REBREAK',   jsonPath: path.join(ROOT, 'reports', 'qva2-d5-rebreak-board.json'),                 htmlPath: path.join(ROOT, 'reports', 'qva2-d5-rebreak-board.html') },
  { key: 'HGROUP_REBREAK',    jsonPath: path.join(ROOT, 'reports', 'hgroup-rebreak-operation-board-result.json'), htmlPath: path.join(ROOT, 'reports', 'hgroup-rebreak-operation-board-result.html') },
];

function parseArgs() {
  const argv = process.argv.slice(2);
  function get(k, def) { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : def; }
  return { board: get('--board', null) };
}

(async () => {
  const t0 = Date.now();
  if (!isEnabled()) { console.error('❌ .env DB_* 미설정.'); process.exit(1); }

  const opts = parseArgs();
  const targets = opts.board ? BOARDS.filter(b => b.key === opts.board) : BOARDS;
  if (targets.length === 0) {
    console.error('❌ 대상 보드 없음. --board 옵션:', BOARDS.map(b => b.key).join(', '));
    process.exit(1);
  }

  console.log('💥 board_signals explosion 백필 시작 (source_type=' + SOURCE_TYPE + ')');
  console.log('   대상: ' + targets.length + '개 보드 (explosion 지원)');
  console.log();

  let totalRows = 0, totalInserted = 0, totalUpdated = 0, failed = 0;
  for (const b of targets) {
    if (!fs.existsSync(b.jsonPath)) {
      console.warn('   ⚠ skip ' + b.key + ' — 파일 없음: ' + b.jsonPath);
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(b.jsonPath, 'utf8'));
      const t1 = Date.now();
      const rows = explodeBoardJson(b.key, data);
      if (!rows) {
        console.warn('   ⚠ skip ' + b.key + ' — explosion rule 없음');
        continue;
      }

      const asOfDate = (rows[0] && rows[0].as_of_date) || null;
      const runId = await repo.createBoardRun({
        board_name: b.key,
        run_date: new Date().toISOString().slice(0, 10),
        as_of_date: asOfDate,
        source_file: b.jsonPath,
        report_json_path: b.jsonPath,
        report_html_path: b.htmlPath,
        candidate_count: rows.length,
        meta_json: { source: 'explosion_backfill', candidate_count_unique_codes: new Set(rows.map(r => r.stock_code)).size },
      });

      // bulk upsert
      const result = await repo.upsertBoardSignals(runId, rows, { sourceType: SOURCE_TYPE });
      const dt = ((Date.now() - t1) / 1000).toFixed(2);
      console.log('   ✓ ' + b.key.padEnd(20) + ' runId=' + runId
        + ' rows=' + rows.length
        + ' (inserted=' + result.inserted + ' updated=' + result.updated + ')'
        + ' [' + dt + 's]');
      totalRows += rows.length;
      totalInserted += result.inserted;
      totalUpdated += result.updated;
    } catch (e) {
      console.error('   ✗ ' + b.key + ' FAIL: ' + (e.message || e));
      console.error(e.stack);
      failed++;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log();
  console.log('✅ 완료 — total rows: ' + totalRows + ' (inserted ' + totalInserted + ' / updated ' + totalUpdated + ')');
  console.log('   failed: ' + failed + ' / elapsed: ' + elapsed + 's');

  // 결과 분포 출력
  const { query } = require('../src/db/mysql');
  const dist = await query("SELECT board_name, signal_kind, COUNT(*) AS n FROM board_signals WHERE board_name IN ('QVA_WATCHLIST','QVA2_WATCHLIST','QVA2_D5_REBREAK','HGROUP_REBREAK') GROUP BY board_name, signal_kind ORDER BY board_name, n DESC");
  console.log('\n📊 explosion 대상 보드 신호 종류별 분포:');
  for (const r of dist) console.log('   ' + r.board_name.padEnd(20) + ' ' + r.signal_kind.padEnd(28) + ' n=' + r.n);

  await closePool();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
