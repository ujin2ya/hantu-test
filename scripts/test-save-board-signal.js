#!/usr/bin/env node
/**
 * 기존 보드 JSON을 읽어서 DB에 저장하는 dry-run 테스트.
 *
 * 실행:
 *   node scripts/test-save-board-signal.js                # 전체 7개 보드
 *   node scripts/test-save-board-signal.js --board 1ds    # 단일 보드
 *
 * 지원 --board 값:
 *   1ds, qva2-watchlist, qva-watchlist, qva-vvi-redefined, rebreak, qva2-vvi, qva2-d5-rebreak
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const adapters = require('../src/db/saveBoardSignals');
const { closePool } = require('../src/db/mysql');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const boardArg = (() => {
  const i = args.indexOf('--board');
  return i >= 0 ? args[i + 1] : null;
})();

// 7개 보드 정의
const BOARDS = [
  {
    key: '1ds', label: 'ONE_DAY_SURGE',
    jsonPath: path.join(ROOT, 'reports', 'one-day-surge-board-result.json'),
    htmlPath: path.join(ROOT, 'reports', 'one-day-surge-board-result.html'),
    fn: adapters.saveOneDaySurgeBoardToDB,
  },
  {
    key: 'qva2-watchlist', label: 'QVA2_WATCHLIST',
    jsonPath: path.join(ROOT, 'reports', 'qva2-watchlist-board.json'),
    htmlPath: path.join(ROOT, 'reports', 'qva2-watchlist-board.html'),
    fn: adapters.saveQva2WatchlistBoardToDB,
  },
  {
    key: 'qva-watchlist', label: 'QVA_WATCHLIST',
    jsonPath: path.join(ROOT, 'qva-watchlist-board.json'),
    htmlPath: path.join(ROOT, 'qva-watchlist-board.html'),
    fn: adapters.saveQvaWatchlistBoardToDB,
  },
  {
    key: 'qva-vvi-redefined', label: 'QVA_VVI_REDEFINED',
    jsonPath: path.join(ROOT, 'reports', 'qva-vvi-redefined-board-result.json'),
    htmlPath: path.join(ROOT, 'reports', 'qva-vvi-redefined-board-result.html'),
    fn: adapters.saveQvaVviRedefinedBoardToDB,
  },
  {
    key: 'rebreak', label: 'HGROUP_REBREAK',
    jsonPath: path.join(ROOT, 'reports', 'hgroup-rebreak-operation-board-result.json'),
    htmlPath: path.join(ROOT, 'reports', 'hgroup-rebreak-operation-board-result.html'),
    fn: adapters.saveHgroupRebreakBoardToDB,
  },
  {
    key: 'qva2-vvi', label: 'QVA2_VVI',
    jsonPath: path.join(ROOT, 'reports', 'qva2-vvi-board.json'),
    htmlPath: path.join(ROOT, 'reports', 'qva2-vvi-board.html'),
    fn: adapters.saveQva2VviBoardToDB,
  },
  {
    key: 'qva2-d5-rebreak', label: 'QVA2_D5_REBREAK',
    jsonPath: path.join(ROOT, 'reports', 'qva2-d5-rebreak-board.json'),
    htmlPath: path.join(ROOT, 'reports', 'qva2-d5-rebreak-board.html'),
    fn: adapters.saveQva2D5RebreakBoardToDB,
  },
];

(async () => {
  let totalRows = 0, totalInserted = 0, totalUpdated = 0, failed = 0;
  for (const b of BOARDS) {
    if (boardArg && boardArg !== b.key) continue;
    if (!fs.existsSync(b.jsonPath)) {
      console.warn(`⚠ skip ${b.label}: file not found ${b.jsonPath}`);
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(b.jsonPath, 'utf8'));
      console.log(`▶ ${b.label} 저장 시도`);
      const r = await b.fn(data, { jsonPath: b.jsonPath, htmlPath: b.htmlPath });
      if (r) {
        console.log(`  ✅ runId=${r.runId} rows=${r.totalRows} (inserted=${r.inserted} updated=${r.updated})`);
        totalRows += r.totalRows; totalInserted += r.inserted; totalUpdated += r.updated;
      } else {
        console.warn(`  ⚠ DB 비활성 (.env 미설정)`);
      }
    } catch (e) {
      console.error(`  ❌ FAIL: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n✅ 완료 — total rows: ${totalRows} (inserted ${totalInserted} / updated ${totalUpdated}) / failed boards: ${failed}`);
  await closePool();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
