/**
 * board_runs / board_signals / board_signal_outcomes / signal_links CRUD.
 *
 * upsert 정책:
 *   - board_signals: UNIQUE(board_name, signal_kind, signal_date, stock_code) → ON DUPLICATE KEY UPDATE
 *   - board_signal_outcomes: UNIQUE(signal_id, horizon_days) → ON DUPLICATE KEY UPDATE
 *   - signal_links: UNIQUE(from_signal_id, to_signal_id, link_type) → ON DUPLICATE KEY UPDATE (no-op)
 */

const { withConnection, withTransaction, query } = require('./mysql');

function _jsonOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (_) { return null; }
}

function _dateOrNull(d) {
  if (!d) return null;
  if (typeof d === 'string') {
    // YYYYMMDD → YYYY-MM-DD
    if (/^\d{8}$/.test(d)) return d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8);
    // 이미 YYYY-MM-DD or ISO
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  }
  return null;
}

async function createBoardRun(meta) {
  return withConnection(async (conn) => {
    const sql = `
      INSERT INTO board_runs (board_name, run_date, as_of_date, source_file, report_json_path, report_html_path, candidate_count, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      meta.board_name,
      _dateOrNull(meta.run_date) || new Date().toISOString().slice(0,10),
      _dateOrNull(meta.as_of_date),
      meta.source_file || null,
      meta.report_json_path || null,
      meta.report_html_path || null,
      Number(meta.candidate_count || 0),
      _jsonOrNull(meta.meta_json),
    ];
    const [r] = await conn.execute(sql, params);
    return r.insertId;
  });
}

// signals: 배열로 받아 BULK upsert (run_id 동일).
// row 형식: { board_name, signal_kind, signal_date, as_of_date, stock_code, stock_name, market,
//             signal_price, signal_open, signal_high, signal_low, signal_close,
//             volume, trading_value, score, rank_no, grade, status_label,
//             tags_json, metrics_json, raw_json }
async function upsertBoardSignals(runId, rows) {
  if (!rows || rows.length === 0) return { inserted: 0, updated: 0 };
  return withTransaction(async (conn) => {
    const sql = `
      INSERT INTO board_signals (
        run_id, board_name, signal_kind, signal_date, as_of_date,
        stock_code, stock_name, market,
        signal_price, signal_open, signal_high, signal_low, signal_close,
        volume, trading_value,
        score, rank_no, grade, status_label,
        tags_json, metrics_json, raw_json
      ) VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?, ?,?,?,?, ?,?,?)
      ON DUPLICATE KEY UPDATE
        run_id        = VALUES(run_id),
        as_of_date    = VALUES(as_of_date),
        stock_name    = VALUES(stock_name),
        market        = VALUES(market),
        signal_price  = VALUES(signal_price),
        signal_open   = VALUES(signal_open),
        signal_high   = VALUES(signal_high),
        signal_low    = VALUES(signal_low),
        signal_close  = VALUES(signal_close),
        volume        = VALUES(volume),
        trading_value = VALUES(trading_value),
        score         = VALUES(score),
        rank_no       = VALUES(rank_no),
        grade         = VALUES(grade),
        status_label  = VALUES(status_label),
        tags_json     = VALUES(tags_json),
        metrics_json  = VALUES(metrics_json),
        raw_json      = VALUES(raw_json),
        updated_at    = CURRENT_TIMESTAMP
    `;
    let inserted = 0, updated = 0;
    for (const r of rows) {
      const params = [
        runId,
        r.board_name,
        r.signal_kind,
        _dateOrNull(r.signal_date),
        _dateOrNull(r.as_of_date),
        r.stock_code, r.stock_name, r.market || null,
        r.signal_price != null ? Number(r.signal_price) : null,
        r.signal_open  != null ? Number(r.signal_open)  : null,
        r.signal_high  != null ? Number(r.signal_high)  : null,
        r.signal_low   != null ? Number(r.signal_low)   : null,
        r.signal_close != null ? Number(r.signal_close) : null,
        r.volume        != null ? Number(r.volume)        : null,
        r.trading_value != null ? Number(r.trading_value) : null,
        r.score   != null ? Number(r.score)   : null,
        r.rank_no != null ? Number(r.rank_no) : null,
        r.grade || null,
        r.status_label || null,
        _jsonOrNull(r.tags_json),
        _jsonOrNull(r.metrics_json),
        _jsonOrNull(r.raw_json),
      ];
      const [res] = await conn.execute(sql, params);
      // mysql2: affectedRows = 1 (insert) / 2 (update on duplicate)
      if (res.affectedRows === 1 && res.insertId) inserted++;
      else updated++;
    }
    return { inserted, updated };
  });
}

async function upsertSignalOutcome(signalId, horizonDays, outcome) {
  const sql = `
    INSERT INTO board_signal_outcomes (
      signal_id, horizon_days,
      base_price, close_price, high_price, low_price,
      max_high_price, min_low_price,
      close_return_pct, max_high_return_pct, min_low_return_pct,
      hit_3, hit_5, hit_10, hit_15, hit_20, hit_30,
      fail_3, fail_5, fail_10,
      outcome_json
    ) VALUES (?,?, ?,?,?,?, ?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?, ?)
    ON DUPLICATE KEY UPDATE
      base_price          = VALUES(base_price),
      close_price         = VALUES(close_price),
      high_price          = VALUES(high_price),
      low_price           = VALUES(low_price),
      max_high_price      = VALUES(max_high_price),
      min_low_price       = VALUES(min_low_price),
      close_return_pct    = VALUES(close_return_pct),
      max_high_return_pct = VALUES(max_high_return_pct),
      min_low_return_pct  = VALUES(min_low_return_pct),
      hit_3 = VALUES(hit_3), hit_5 = VALUES(hit_5), hit_10 = VALUES(hit_10),
      hit_15 = VALUES(hit_15), hit_20 = VALUES(hit_20), hit_30 = VALUES(hit_30),
      fail_3 = VALUES(fail_3), fail_5 = VALUES(fail_5), fail_10 = VALUES(fail_10),
      outcome_json = VALUES(outcome_json),
      updated_at = CURRENT_TIMESTAMP
  `;
  const params = [
    signalId, horizonDays,
    outcome.base_price ?? null, outcome.close_price ?? null, outcome.high_price ?? null, outcome.low_price ?? null,
    outcome.max_high_price ?? null, outcome.min_low_price ?? null,
    outcome.close_return_pct ?? null, outcome.max_high_return_pct ?? null, outcome.min_low_return_pct ?? null,
    outcome.hit_3 ? 1 : 0, outcome.hit_5 ? 1 : 0, outcome.hit_10 ? 1 : 0,
    outcome.hit_15 ? 1 : 0, outcome.hit_20 ? 1 : 0, outcome.hit_30 ? 1 : 0,
    outcome.fail_3 ? 1 : 0, outcome.fail_5 ? 1 : 0, outcome.fail_10 ? 1 : 0,
    _jsonOrNull(outcome.outcome_json),
  ];
  await query(sql, params);
}

async function linkSignals(fromSignalId, toSignalId, linkType, opts = {}) {
  const sql = `
    INSERT IGNORE INTO signal_links (from_signal_id, to_signal_id, link_type, days_between, link_note, meta_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  await query(sql, [
    fromSignalId, toSignalId, linkType,
    opts.days_between != null ? Number(opts.days_between) : null,
    opts.link_note || null,
    _jsonOrNull(opts.meta_json),
  ]);
}

// ─── 조회 헬퍼 ───────────────────────────────────────────────────────────

async function findSignalByBoardKindDateCode(boardName, signalKind, signalDate, stockCode) {
  const rows = await query(
    'SELECT * FROM board_signals WHERE board_name=? AND signal_kind=? AND signal_date=? AND stock_code=? LIMIT 1',
    [boardName, signalKind, _dateOrNull(signalDate), stockCode]
  );
  return (rows && rows[0]) || null;
}

// 주의: mysql2 prepared statement는 LIMIT bind 미지원 → Number clamp 후 SQL inline
function _safeLimit(v, def, max) {
  const n = Math.min(Math.max(1, Number(v || def) | 0), max);
  return Number.isFinite(n) ? n : def;
}

async function findSignalsByStock(stockCode, opts = {}) {
  const limit = _safeLimit(opts.limit, 200, 1000);
  const sql = `
    SELECT id, board_name, signal_kind, signal_date, stock_code, stock_name, market,
           signal_price, score, grade, status_label, tags_json, created_at
    FROM board_signals
    WHERE stock_code = ?
    ORDER BY signal_date DESC, id DESC
    LIMIT ${limit}
  `;
  return await query(sql, [stockCode]);
}

async function findSignalsByBoard(boardName, opts = {}) {
  const limit = _safeLimit(opts.limit, 200, 1000);
  if (opts.date) {
    return await query(
      `SELECT id, board_name, signal_kind, signal_date, stock_code, stock_name, market,
              signal_price, score, grade, status_label, tags_json
       FROM board_signals
       WHERE board_name = ? AND signal_date = ?
       ORDER BY rank_no ASC, score DESC, id ASC
       LIMIT ${limit}`,
      [boardName, _dateOrNull(opts.date)]
    );
  }
  return await query(
    `SELECT id, board_name, signal_kind, signal_date, stock_code, stock_name, market,
            signal_price, score, grade, status_label, tags_json
     FROM board_signals
     WHERE board_name = ?
     ORDER BY signal_date DESC, rank_no ASC, score DESC, id ASC
     LIMIT ${limit}`,
    [boardName]
  );
}

async function findSignalsByDate(signalDate, opts = {}) {
  const limit = _safeLimit(opts.limit, 500, 2000);
  return await query(
    `SELECT id, board_name, signal_kind, signal_date, stock_code, stock_name, market,
            signal_price, score, grade, status_label, tags_json
     FROM board_signals
     WHERE signal_date = ?
     ORDER BY board_name, signal_kind, rank_no ASC, score DESC, id ASC
     LIMIT ${limit}`,
    [_dateOrNull(signalDate)]
  );
}

module.exports = {
  createBoardRun,
  upsertBoardSignals,
  upsertSignalOutcome,
  linkSignals,
  findSignalByBoardKindDateCode,
  findSignalsByStock,
  findSignalsByBoard,
  findSignalsByDate,
};
