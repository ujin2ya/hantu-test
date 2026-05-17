#!/usr/bin/env node
/**
 * DB 연결 + 스키마 sanity 점검 스크립트.
 *
 * 실행: node scripts/test-db-connection.js
 *
 * 검증:
 *   1) .env DB_* 변수 로드
 *   2) pool 생성 + ping 성공
 *   3) 4개 테이블 존재
 *   4) 각 테이블 row count (현재 상태)
 */

require('dotenv').config({ quiet: true });
const { query, closePool, isEnabled } = require('../src/db/mysql');

(async () => {
  console.log('🔍 DB 연결 점검');
  if (!isEnabled()) {
    console.error('❌ .env에 DB_HOST/DB_USER/DB_PASSWORD/DB_NAME 누락');
    process.exit(1);
  }
  console.log('  ENV: DB_HOST=' + process.env.DB_HOST + ' DB_NAME=' + process.env.DB_NAME + ' DB_USER=' + process.env.DB_USER);

  try {
    const ver = await query('SELECT VERSION() AS v, NOW() AS t, DATABASE() AS db, CURRENT_USER() AS who');
    console.log('  ✅ 접속 OK — MySQL', ver[0].v);
    console.log('     time:', ver[0].t);
    console.log('     db:  ', ver[0].db);
    console.log('     user:', ver[0].who);

    const tables = await query("SHOW TABLES");
    const tableNames = tables.map(r => Object.values(r)[0]);
    console.log('  📋 tables:', tableNames.join(', '));

    const required = ['board_runs', 'board_signals', 'board_signal_outcomes', 'signal_links'];
    const missing = required.filter(t => !tableNames.includes(t));
    if (missing.length) {
      console.error('  ❌ 누락된 테이블:', missing.join(', '));
      console.error('     해결: mysqlsh --sql --uri "..." --file db/schema.sql');
      process.exit(2);
    }

    for (const t of required) {
      const r = await query('SELECT COUNT(*) AS c FROM ' + t);
      console.log('     ' + t.padEnd(25), 'rows:', r[0].c);
    }
    console.log('✅ 모든 점검 통과');
  } catch (e) {
    console.error('❌ 에러:', e.message);
    process.exit(3);
  } finally {
    await closePool();
  }
})();
