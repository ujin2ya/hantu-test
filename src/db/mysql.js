/**
 * MySQL connection pool — 단일 진입점.
 *
 * 정책:
 *   - 자격증명은 process.env.DB_*에서만 read (코드에 평문 금지)
 *   - mysql2/promise pool (async/await 친화)
 *   - JSON 컬럼 자동 파싱 (typeCast)
 *   - 첫 호출 시 lazy initialize
 *
 * 사용:
 *   const { getPool, query, withConnection, withTransaction } = require('../db/mysql');
 *   const rows = await query('SELECT * FROM board_signals WHERE stock_code = ?', [code]);
 */

require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');

let _pool = null;
let _initWarned = false;

function _isEnabled() {
  return !!(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME);
}

function getPool() {
  if (_pool) return _pool;
  if (!_isEnabled()) {
    if (!_initWarned) {
      console.warn('[DB] .env에 DB_HOST/DB_USER/DB_PASSWORD/DB_NAME 미설정 — DB 비활성 모드로 동작');
      _initWarned = true;
    }
    return null;
  }
  _pool = mysql.createPool({
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT || 3306),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 5),
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
    // JSON 자동 파싱은 mysql2가 이미 기본 제공 (컬럼 타입 JSON)
    dateStrings: true,           // DATE/DATETIME을 문자열로 (Date 객체 변환 시 KST/UTC 혼선 방지)
    multipleStatements: false,   // 멱등 안전성. multi-statement는 mysqlsh로
    charset: 'utf8mb4_general_ci', // mysql2 charset 옵션은 collation 이름 받음 (utf8mb4_unicode_ci는 supported 아님 — utf8mb4_general_ci로 협상 후 server-side에서 자동 변환)
  });
  // SET NAMES — pool의 매 connection이 처음 쓰일 때 charset 정렬 강제.
  // mysql2의 charset 옵션만으론 일부 환경에서 utf8mb3 fallback 발생 (Conversion ... impossible 에러).
  _pool.on('connection', (conn) => {
    conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
  });
  return _pool;
}

async function query(sql, params) {
  const pool = getPool();
  if (!pool) return null;
  const [rows] = await pool.execute(sql, params || []);
  return rows;
}

async function withConnection(fn) {
  const pool = getPool();
  if (!pool) return null;
  const conn = await pool.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function withTransaction(fn) {
  return withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      throw e;
    }
  });
}

async function closePool() {
  if (_pool) {
    try { await _pool.end(); } catch (_) {}
    _pool = null;
  }
}

module.exports = { getPool, query, withConnection, withTransaction, closePool, isEnabled: _isEnabled };
