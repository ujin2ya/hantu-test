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
async function upsertBoardSignals(runId, rows, opts = {}) {
  if (!rows || rows.length === 0) return { inserted: 0, updated: 0 };
  const defaultSourceType = opts.sourceType || 'DAILY_RUN';
  return withTransaction(async (conn) => {
    const sql = `
      INSERT INTO board_signals (
        run_id, board_name, signal_kind, source_type, signal_date, as_of_date,
        stock_code, stock_name, market,
        signal_price, signal_open, signal_high, signal_low, signal_close,
        volume, trading_value,
        score, rank_no, grade, status_label,
        tags_json, metrics_json, raw_json
      ) VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?, ?,?,?,?, ?,?,?)
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
        -- source_type은 DAILY_RUN으로 들어온 후 CACHE_BACKFILL이 덮어쓰지 않도록 보호.
        --   기존 'DAILY_RUN' + 새 'CACHE_BACKFILL' → 'DAILY_RUN' 유지 (실데이터 우선)
        source_type   = CASE
          WHEN source_type = 'DAILY_RUN' THEN 'DAILY_RUN'
          ELSE VALUES(source_type)
        END,
        updated_at    = CURRENT_TIMESTAMP
    `;
    let inserted = 0, updated = 0;
    for (const r of rows) {
      const params = [
        runId,
        r.board_name,
        r.signal_kind,
        r.source_type || defaultSourceType,
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

// ─── 3차 조회 API (2026-05-17) ────────────────────────────────────────────

// signal_kind 분류 — controller/repo 양쪽에서 reuse
const NEGATIVE_KINDS = ['FAILED', 'BROKEN', 'BREACH_NO_RECOVER', 'BREACH_RECOVER_ILLUSION', 'NO_REBREAK'];
const POSITIVE_KINDS = [
  'VVI_FIRED', 'VVI2_FIRED', 'BREAKOUT_SUCCESS',
  'CLOSE_REBREAK', 'CLOSE_REBREAK_NO_BREACH', 'TODAY_INITIAL_BREAKOUT',
  'TODAY_NEW_VVI', 'TODAY_NEW_VVI2', 'ATTACK_TOP',
];

function _placeholders(arr) { return arr.map(() => '?').join(','); }

// 1) overlap — 특정 날짜에 2+ board_name 에 동시 등장한 종목
async function findOverlap(dateYMD, opts = {}) {
  const limit = _safeLimit(opts.limit, 100, 500);
  const minBoards = Math.max(2, Number(opts.minBoards || 2) | 0);
  const includeFailed = !!opts.includeFailed;
  const excludeClause = includeFailed ? '' : `AND signal_kind NOT IN (${_placeholders(NEGATIVE_KINDS)})`;
  const params = [_dateOrNull(dateYMD)];
  if (!includeFailed) params.push(...NEGATIVE_KINDS);
  params.push(minBoards);
  const sql = `
    SELECT
      stock_code,
      MAX(stock_name) AS stock_name,
      MAX(market)     AS market,
      COUNT(DISTINCT board_name) AS board_count,
      COUNT(*)        AS raw_count,
      MAX(signal_date) AS latest_signal_date,
      SUM(IFNULL(score,0)) AS total_score,
      GROUP_CONCAT(DISTINCT CONCAT(board_name, '/', signal_kind) ORDER BY board_name SEPARATOR ', ') AS boards
    FROM board_signals
    WHERE signal_date = ?
      ${excludeClause}
    GROUP BY stock_code
    HAVING board_count >= ?
    ORDER BY board_count DESC, total_score DESC, stock_code ASC
    LIMIT ${limit}
  `;
  return await query(sql, params);
}

// 2) repeated — 최근 N일 동안 minCount 이상 등장한 종목
async function findRepeated(opts = {}) {
  const limit = _safeLimit(opts.limit, 100, 500);
  const days = Math.max(1, Number(opts.days || 20) | 0);
  const minCount = Math.max(2, Number(opts.minCount || 2) | 0);
  const sql = `
    SELECT
      stock_code,
      MAX(stock_name) AS stock_name,
      MAX(market)     AS market,
      COUNT(*) AS signal_count,
      COUNT(DISTINCT board_name) AS board_count,
      MIN(signal_date) AS first_signal_date,
      MAX(signal_date) AS last_signal_date,
      GROUP_CONCAT(DISTINCT CONCAT(board_name, '/', signal_kind) ORDER BY board_name SEPARATOR ', ') AS board_kind_summary,
      SUM(CASE WHEN signal_kind IN (${_placeholders(NEGATIVE_KINDS)}) THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN signal_kind NOT IN (${_placeholders(NEGATIVE_KINDS)}) THEN 1 ELSE 0 END) AS positive_kind_count
    FROM board_signals
    WHERE signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    GROUP BY stock_code
    HAVING signal_count >= ?
    ORDER BY signal_count DESC, board_count DESC, stock_code ASC
    LIMIT ${limit}
  `;
  const params = [...NEGATIVE_KINDS, ...NEGATIVE_KINDS, days, minCount];
  return await query(sql, params);
}

// 3) stockHistory — 종목별 signals + outcomes + links 타임라인
async function findStockHistory(stockCode, opts = {}) {
  const days = Math.max(1, Number(opts.days || 180) | 0);
  const signals = await query(
    `SELECT id, board_name, signal_kind, signal_date, signal_price, score, grade, status_label, tags_json, market
     FROM board_signals
     WHERE stock_code = ?
       AND signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY signal_date DESC, id DESC`,
    [stockCode, days]
  );
  if (!signals.length) return { stock_code: stockCode, stock_name: null, signals: [] };

  const ids = signals.map(s => s.id);
  // mysql2 prepared statement: IN (...) 에 array는 IN 절 expand 안 됨 — 동적 placeholder
  const inList = ids.map(() => '?').join(',');
  const outcomes = ids.length
    ? await query(
        `SELECT signal_id, horizon_days, close_return_pct, max_high_return_pct, min_low_return_pct,
                hit_3, hit_5, hit_10, hit_15, hit_20, hit_30, fail_3, fail_5, fail_10
         FROM board_signal_outcomes
         WHERE signal_id IN (${inList})
         ORDER BY signal_id, horizon_days`,
        ids
      )
    : [];
  const linksOut = ids.length
    ? await query(
        `SELECT from_signal_id AS this_id, to_signal_id AS other_id, link_type, days_between
         FROM signal_links
         WHERE from_signal_id IN (${inList})`,
        ids
      )
    : [];
  const linksIn = ids.length
    ? await query(
        `SELECT to_signal_id AS this_id, from_signal_id AS other_id, link_type, days_between
         FROM signal_links
         WHERE to_signal_id IN (${inList})`,
        ids
      )
    : [];

  const outcomesBy = new Map();
  for (const o of outcomes) {
    if (!outcomesBy.has(o.signal_id)) outcomesBy.set(o.signal_id, []);
    outcomesBy.get(o.signal_id).push(o);
  }
  const outBy = new Map(), inBy = new Map();
  for (const l of linksOut) { if (!outBy.has(l.this_id)) outBy.set(l.this_id, []); outBy.get(l.this_id).push(l); }
  for (const l of linksIn)  { if (!inBy.has(l.this_id))  inBy.set(l.this_id,  []); inBy.get(l.this_id).push(l); }

  const stockName = (await query(
    'SELECT stock_name FROM board_signals WHERE stock_code = ? ORDER BY signal_date DESC LIMIT 1',
    [stockCode]
  ))[0]?.stock_name || null;

  return {
    stock_code: stockCode,
    stock_name: stockName,
    market: signals[0]?.market || null,
    signal_count: signals.length,
    signals: signals.map(s => ({
      ...s,
      outcomes:        outcomesBy.get(s.id) || [],
      outgoing_links:  outBy.get(s.id) || [],
      incoming_links:  inBy.get(s.id) || [],
    })),
  };
}

// 4) performance — 특정 (board_name, signal_kind, horizon) 의 D+N 성과 (not_ready 제외)
async function findPerformance(opts = {}) {
  const boardName = opts.boardName;
  const signalKind = opts.signalKind || null;
  const horizon = Math.max(1, Number(opts.horizon || 5) | 0);
  const days = Math.max(1, Number(opts.days || 60) | 0);
  if (!boardName) throw new Error('boardName required');

  const params = [boardName, horizon, days];
  let kindClause = '';
  if (signalKind) { kindClause = 'AND s.signal_kind = ?'; params.splice(1, 0, signalKind); }

  // 성과율: not_ready (close_return_pct IS NULL) 제외
  const sql = `
    SELECT
      COUNT(*) AS sample_count,
      AVG(close_return_pct)    AS avg_close_return_pct,
      AVG(max_high_return_pct) AS avg_max_high_return_pct,
      AVG(min_low_return_pct)  AS avg_min_low_return_pct,
      AVG(hit_3)  AS hit_3_rate,
      AVG(hit_5)  AS hit_5_rate,
      AVG(hit_10) AS hit_10_rate,
      AVG(hit_15) AS hit_15_rate,
      AVG(hit_20) AS hit_20_rate,
      AVG(hit_30) AS hit_30_rate,
      AVG(fail_3)  AS fail_3_rate,
      AVG(fail_5)  AS fail_5_rate,
      AVG(fail_10) AS fail_10_rate
    FROM board_signal_outcomes o
    JOIN board_signals s ON s.id = o.signal_id
    WHERE s.board_name = ?
      ${kindClause}
      AND o.horizon_days = ?
      AND s.signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      AND o.close_return_pct IS NOT NULL
  `;
  const rows = await query(sql, params);
  const r = rows[0] || {};
  return {
    board_name: boardName,
    signal_kind: signalKind,
    horizon_days: horizon,
    lookback_days: days,
    sample_count: Number(r.sample_count || 0),
    avg_close_return_pct:    r.avg_close_return_pct    != null ? Number(Number(r.avg_close_return_pct).toFixed(2)) : null,
    avg_max_high_return_pct: r.avg_max_high_return_pct != null ? Number(Number(r.avg_max_high_return_pct).toFixed(2)) : null,
    avg_min_low_return_pct:  r.avg_min_low_return_pct  != null ? Number(Number(r.avg_min_low_return_pct).toFixed(2)) : null,
    hit_3_rate:  r.hit_3_rate  != null ? Number(Number(r.hit_3_rate).toFixed(4))  : null,
    hit_5_rate:  r.hit_5_rate  != null ? Number(Number(r.hit_5_rate).toFixed(4))  : null,
    hit_10_rate: r.hit_10_rate != null ? Number(Number(r.hit_10_rate).toFixed(4)) : null,
    hit_15_rate: r.hit_15_rate != null ? Number(Number(r.hit_15_rate).toFixed(4)) : null,
    hit_20_rate: r.hit_20_rate != null ? Number(Number(r.hit_20_rate).toFixed(4)) : null,
    hit_30_rate: r.hit_30_rate != null ? Number(Number(r.hit_30_rate).toFixed(4)) : null,
    fail_3_rate:  r.fail_3_rate  != null ? Number(Number(r.fail_3_rate).toFixed(4))  : null,
    fail_5_rate:  r.fail_5_rate  != null ? Number(Number(r.fail_5_rate).toFixed(4))  : null,
    fail_10_rate: r.fail_10_rate != null ? Number(Number(r.fail_10_rate).toFixed(4)) : null,
  };
}

// 5) linkSummary — link_type별 집계 + sample examples 5건
async function findLinkSummary(opts = {}) {
  const days = Math.max(1, Number(opts.days || 180) | 0);
  const summary = await query(
    `SELECT link_type,
            COUNT(*) AS link_count,
            AVG(days_between) AS avg_days_between,
            MIN(days_between) AS min_days_between,
            MAX(days_between) AS max_days_between
     FROM signal_links l
     JOIN board_signals s ON s.id = l.from_signal_id
     WHERE s.signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY link_type
     ORDER BY link_count DESC`,
    [days]
  );

  // 각 link_type별 sample 5건
  for (const row of summary) {
    const examples = await query(
      `SELECT l.from_signal_id, l.to_signal_id, l.days_between,
              sf.stock_code, sf.stock_name,
              sf.board_name AS from_board, sf.signal_kind AS from_kind, sf.signal_date AS from_date,
              st.board_name AS to_board,   st.signal_kind AS to_kind,   st.signal_date AS to_date
       FROM signal_links l
       JOIN board_signals sf ON sf.id = l.from_signal_id
       JOIN board_signals st ON st.id = l.to_signal_id
       WHERE l.link_type = ?
         AND sf.signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY sf.signal_date DESC, l.id DESC
       LIMIT 5`,
      [row.link_type, days]
    );
    row.avg_days_between = row.avg_days_between != null ? Number(Number(row.avg_days_between).toFixed(2)) : null;
    row.examples = examples;
  }
  return summary;
}

// 6) todayFocus — 종합 priority_score
//
// 점수:
//   + board_count * 10                    (서로 다른 board_name 수)
//   + positive_kind_count * 5             (POSITIVE_KINDS 매칭 수, 같은 보드에서 다수면 추가됨)
//   - failed_kind_count * 8               (NEGATIVE_KINDS 매칭)
//   + recent_repeat_count * 3             (최근 20일 동안 등장 횟수, 자기 자신 포함 가능)
//   + 강한 종류 등장 (BREAKOUT/REBREAK 계열) +10
async function findTodayFocus(dateYMD, opts = {}) {
  const limit = _safeLimit(opts.limit, 50, 200);
  const minBoards = Math.max(1, Number(opts.minBoards || 1) | 0);
  const date = _dateOrNull(dateYMD);
  // 1) 오늘 board_signals 집계 (per stock_code)
  const sql = `
    SELECT
      s.stock_code,
      MAX(s.stock_name) AS stock_name,
      MAX(s.market)     AS market,
      COUNT(DISTINCT s.board_name) AS board_count,
      COUNT(*)          AS raw_count,
      SUM(CASE WHEN s.signal_kind IN (${_placeholders(POSITIVE_KINDS)}) THEN 1 ELSE 0 END) AS positive_kind_count,
      SUM(CASE WHEN s.signal_kind IN (${_placeholders(NEGATIVE_KINDS)}) THEN 1 ELSE 0 END) AS failed_kind_count,
      SUM(CASE WHEN s.signal_kind LIKE 'BREAKOUT%' OR s.signal_kind LIKE 'CLOSE_REBREAK%' OR s.signal_kind = 'TODAY_INITIAL_BREAKOUT' THEN 1 ELSE 0 END) AS strong_kind_count,
      GROUP_CONCAT(DISTINCT CONCAT(s.board_name, '/', s.signal_kind) ORDER BY s.board_name SEPARATOR ', ') AS boards,
      SUM(IFNULL(s.score, 0)) AS total_score,
      (SELECT COUNT(*) FROM board_signals s2
        WHERE s2.stock_code = s.stock_code
          AND s2.signal_date >= DATE_SUB(s.signal_date, INTERVAL 20 DAY)
          AND s2.signal_date <= s.signal_date) AS recent_repeat_count
    FROM board_signals s
    WHERE s.signal_date = ?
    GROUP BY s.stock_code
    HAVING board_count >= ?
    LIMIT ${limit}
  `;
  const params = [...POSITIVE_KINDS, ...NEGATIVE_KINDS, date, minBoards];
  const rows = await query(sql, params);

  // priority_score JS에서 계산 (재현성과 가독성)
  for (const r of rows) {
    r.priority_score =
      Number(r.board_count) * 10 +
      Number(r.positive_kind_count) * 5 -
      Number(r.failed_kind_count) * 8 +
      Number(r.recent_repeat_count) * 3 +
      Number(r.strong_kind_count) * 10;
  }
  rows.sort((a, b) => b.priority_score - a.priority_score || b.board_count - a.board_count);
  return rows;
}

// 5차 (2026-05-17) — 사용자 정의 태그 조합 필터
//
// opts:
//   - date          (YYYY-MM-DD) — 있으면 해당 날짜만
//   - days          (number)     — 없으면 30일 default. date 없을 때 사용
//   - limit         (number)     — safeLimit, default 100, max 500
//   - includeBoard  (string[])   — 종목이 이들 보드 중 1+ 에 등장 (행 단위 필터)
//   - excludeBoard  (string[])   — 이들 보드 신호는 카운트에서 제외 (행 단위 필터)
//   - includeKind   (string[])   — matchMode=any: 1+ 매칭, all: 모두 매칭
//   - excludeKind   (string[])   — 종목 단위 제외 (한 번이라도 매칭되면 종목 자체 제외)
//   - matchMode     ('any'|'all') — default 'any'
//   - minBoardCount (number)     — HAVING board_count >= ?
//   - minRepeatCount(number)     — HAVING signal_count >= ?
// ─── 종목별 신호 타임라인 + 흐름 해석 (7차, 2026-05-17) ─────────────────

// A) 최근 N일 안에 minSignalCount 이상 누적된 종목의 단계 흐름
async function findStockTimelines(opts = {}) {
  const days = Math.max(1, Number(opts.days || 60) | 0);
  const limitStocks = _safeLimit(opts.limitStocks, 30, 200);
  const minSignalCount = Math.max(1, Number(opts.minSignalCount || 3) | 0);
  const sources = Array.isArray(opts.includeSourceTypes) && opts.includeSourceTypes.length
    ? opts.includeSourceTypes
    : ['DAILY_RUN', 'CACHE_BACKFILL'];

  // 1단계: 종목 선정 (signal_count DESC, board_count DESC, last DESC)
  const top = await query(
    `SELECT
       stock_code,
       MAX(stock_name) AS stock_name,
       MAX(market)     AS market,
       COUNT(*) AS signal_count,
       COUNT(DISTINCT board_name) AS board_count,
       MIN(signal_date) AS first_signal_date,
       MAX(signal_date) AS last_signal_date,
       GROUP_CONCAT(DISTINCT source_type ORDER BY source_type SEPARATOR ', ') AS source_types,
       GROUP_CONCAT(DISTINCT board_name  ORDER BY board_name  SEPARATOR ', ') AS boards,
       GROUP_CONCAT(DISTINCT signal_kind ORDER BY signal_kind SEPARATOR ', ') AS signal_kinds
     FROM board_signals
     WHERE signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       AND source_type IN (${_placeholders(sources)})
     GROUP BY stock_code
     HAVING signal_count >= ?
     ORDER BY signal_count DESC, board_count DESC, last_signal_date DESC, stock_code ASC
     LIMIT ${limitStocks}`,
    [days, ...sources, minSignalCount]
  );
  if (top.length === 0) return [];

  // 2단계: 선정된 종목들의 timeline (raw_json 제외)
  const codes = top.map(r => r.stock_code);
  const timelineRows = await query(
    `SELECT id, stock_code, signal_date, board_name, signal_kind, status_label, score, source_type
     FROM board_signals
     WHERE stock_code IN (${_placeholders(codes)})
       AND signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY signal_date ASC, board_name ASC, id ASC`,
    [...codes, days]
  );

  // JS grouping
  const byCode = new Map();
  for (const r of timelineRows) {
    if (!byCode.has(r.stock_code)) byCode.set(r.stock_code, []);
    byCode.get(r.stock_code).push({
      signal_date: r.signal_date,
      board_name: r.board_name,
      signal_kind: r.signal_kind,
      status_label: r.status_label,
      score: r.score,
      source_type: r.source_type,
    });
  }

  return top.map(r => ({
    stock_code: r.stock_code,
    stock_name: r.stock_name,
    market: r.market,
    signal_count: Number(r.signal_count),
    board_count: Number(r.board_count),
    first_signal_date: r.first_signal_date,
    last_signal_date: r.last_signal_date,
    source_types: r.source_types,
    boards: r.boards,
    signal_kinds: r.signal_kinds,
    timeline: byCode.get(r.stock_code) || [],
  }));
}

// B) 특정 funnel 조합을 모두 거친 종목
const FUNNEL_REQUIRED_KINDS = Object.freeze({
  QVA:      ['QVA_NEW', 'VVI_FIRED', 'BREAKOUT_SUCCESS'],
  QVA2:     ['QVA2_NEW', 'VVI2_FIRED', 'BREAKOUT_SUCCESS'],
  BOTH_VVI: ['VVI_FIRED', 'VVI2_FIRED'],
});

async function findFunnelPassedStocks(opts = {}) {
  const days = Math.max(1, Number(opts.days || 60) | 0);
  const limit = _safeLimit(opts.limit, 30, 200);
  const funnelType = opts.funnelType || 'QVA';
  const required = FUNNEL_REQUIRED_KINDS[funnelType];
  if (!required) throw new Error('Unknown funnelType: ' + funnelType);

  const sql = `
    SELECT
      stock_code,
      MAX(stock_name) AS stock_name,
      MAX(market)     AS market,
      COUNT(*) AS signal_count,
      COUNT(DISTINCT board_name) AS board_count,
      MIN(signal_date) AS first_signal_date,
      MAX(signal_date) AS last_signal_date,
      GROUP_CONCAT(DISTINCT
        CASE WHEN signal_kind IN (${_placeholders(required)}) THEN signal_kind END
        ORDER BY signal_kind SEPARATOR ', ') AS matched_kinds,
      GROUP_CONCAT(DISTINCT board_name  ORDER BY board_name  SEPARATOR ', ') AS boards,
      GROUP_CONCAT(DISTINCT source_type ORDER BY source_type SEPARATOR ', ') AS source_types
    FROM board_signals
    WHERE signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    GROUP BY stock_code
    HAVING COUNT(DISTINCT CASE WHEN signal_kind IN (${_placeholders(required)}) THEN signal_kind END) = ?
    ORDER BY signal_count DESC, board_count DESC, stock_code ASC
    LIMIT ${limit}
  `;
  // params: GROUP_CONCAT의 IN, WHERE, HAVING의 IN, requiredLength
  const params = [...required, days, ...required, required.length];
  return await query(sql, params);
}

// C) 최근 반복 등장 종목 (단순 signal_count 기준)
async function findRecentRepeatedStocks(opts = {}) {
  const days = Math.max(1, Number(opts.days || 20) | 0);
  const minSignalCount = Math.max(1, Number(opts.minSignalCount || 3) | 0);
  const limit = _safeLimit(opts.limit, 50, 300);
  return await query(
    `SELECT
       stock_code,
       MAX(stock_name) AS stock_name,
       MAX(market)     AS market,
       COUNT(*) AS signal_count,
       COUNT(DISTINCT board_name) AS board_count,
       MIN(signal_date) AS first_signal_date,
       MAX(signal_date) AS last_signal_date,
       GROUP_CONCAT(DISTINCT board_name  ORDER BY board_name  SEPARATOR ', ') AS boards,
       GROUP_CONCAT(DISTINCT signal_kind ORDER BY signal_kind SEPARATOR ', ') AS signal_kinds,
       GROUP_CONCAT(DISTINCT source_type ORDER BY source_type SEPARATOR ', ') AS source_types
     FROM board_signals
     WHERE signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY stock_code
     HAVING signal_count >= ?
     ORDER BY signal_count DESC, board_count DESC, last_signal_date DESC, stock_code ASC
     LIMIT ${limit}`,
    [days, minSignalCount]
  );
}

// DB 신호 누적 상태 요약 — /db-board 상단 카드용
async function findDbSummary() {
  const totals = await query(`
    SELECT
      COUNT(*) AS total_signals,
      COUNT(DISTINCT board_name) AS boards,
      COUNT(DISTINCT stock_code) AS stocks,
      MIN(signal_date) AS min_date,
      MAX(signal_date) AS max_date,
      MAX(created_at)  AS latest_inserted_at,
      MAX(updated_at)  AS latest_updated_at
    FROM board_signals
  `);
  const bySource = await query(
    `SELECT source_type, COUNT(*) AS n FROM board_signals GROUP BY source_type ORDER BY n DESC`
  );
  const byBoard = await query(
    `SELECT board_name, COUNT(*) AS n, COUNT(DISTINCT stock_code) AS stocks
     FROM board_signals GROUP BY board_name ORDER BY n DESC`
  );
  const recentDates = await query(
    `SELECT signal_date, COUNT(*) AS n FROM board_signals
     WHERE signal_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
     GROUP BY signal_date ORDER BY signal_date DESC LIMIT 10`
  );
  const outcomesAndLinks = await query(
    `SELECT
       (SELECT COUNT(*) FROM board_signal_outcomes) AS outcomes,
       (SELECT COUNT(*) FROM signal_links)          AS links,
       (SELECT COUNT(*) FROM board_runs)            AS runs`
  );
  return {
    totals: totals[0] || {},
    bySource,
    byBoard,
    recentDates,
    counts: outcomesAndLinks[0] || {},
  };
}

async function findFilteredSignals(opts = {}) {
  const limit = _safeLimit(opts.limit, 100, 500);
  const date = _dateOrNull(opts.date);
  const days = Math.max(1, Number(opts.days || 30) | 0);
  const matchMode = opts.matchMode === 'all' ? 'all' : 'any';

  const includeBoard = Array.isArray(opts.includeBoard) ? opts.includeBoard.filter(Boolean) : [];
  const excludeBoard = Array.isArray(opts.excludeBoard) ? opts.excludeBoard.filter(Boolean) : [];
  const includeKind  = Array.isArray(opts.includeKind)  ? opts.includeKind.filter(Boolean)  : [];
  const excludeKind  = Array.isArray(opts.excludeKind)  ? opts.excludeKind.filter(Boolean)  : [];

  const minBoardCount  = Math.max(0, Number(opts.minBoardCount  || 0) | 0);
  const minRepeatCount = Math.max(0, Number(opts.minRepeatCount || 0) | 0);

  // ─── WHERE 절 (행 단위) ──────────────────────────────────────────────
  const where = [];
  const params = [];

  if (date) { where.push('s.signal_date = ?'); params.push(date); }
  else      { where.push('s.signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)'); params.push(days); }

  if (includeBoard.length) {
    where.push('s.board_name IN (' + _placeholders(includeBoard) + ')');
    params.push(...includeBoard);
  }
  if (excludeBoard.length) {
    where.push('s.board_name NOT IN (' + _placeholders(excludeBoard) + ')');
    params.push(...excludeBoard);
  }
  if (includeKind.length && matchMode === 'any') {
    // any: 행에 includeKind 매칭만 통과. (all 모드는 HAVING에서 처리)
    where.push('s.signal_kind IN (' + _placeholders(includeKind) + ')');
    params.push(...includeKind);
  }
  // excludeKind는 종목 단위 — WHERE에 서브쿼리로 NOT IN 처리 (인덱스 활용)
  if (excludeKind.length) {
    where.push(
      's.stock_code NOT IN (SELECT stock_code FROM board_signals WHERE signal_kind IN (' + _placeholders(excludeKind) + ')' +
      (date ? ' AND signal_date = ?' : ' AND signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)') +
      ')'
    );
    params.push(...excludeKind);
    params.push(date ? date : days);
  }

  // ─── HAVING (그룹 단위) ──────────────────────────────────────────────
  const having = [];
  const havingParams = [];

  if (minBoardCount > 0)  { having.push('COUNT(DISTINCT s.board_name) >= ?'); havingParams.push(minBoardCount); }
  if (minRepeatCount > 0) { having.push('COUNT(*) >= ?'); havingParams.push(minRepeatCount); }
  if (matchMode === 'all' && includeKind.length) {
    // all: 종목이 includeKind 의 모든 종류를 가져야 함
    having.push('COUNT(DISTINCT CASE WHEN s.signal_kind IN (' + _placeholders(includeKind) + ') THEN s.signal_kind END) = ?');
    havingParams.push(...includeKind);
    havingParams.push(includeKind.length);
  }

  const whereSQL  = where.length  ? 'WHERE '  + where.join(' AND ')  : '';
  const havingSQL = having.length ? 'HAVING ' + having.join(' AND ') : '';

  // ─── 최종 쿼리 ───────────────────────────────────────────────────────
  const sql = `
    SELECT
      s.stock_code,
      MAX(s.stock_name) AS stock_name,
      MAX(s.market)     AS market,
      COUNT(*)          AS signal_count,
      COUNT(DISTINCT s.board_name) AS board_count,
      SUM(CASE WHEN s.signal_kind IN (${_placeholders(POSITIVE_KINDS)}) THEN 1 ELSE 0 END) AS positive_kind_count,
      SUM(CASE WHEN s.signal_kind IN (${_placeholders(NEGATIVE_KINDS)}) THEN 1 ELSE 0 END) AS negative_kind_count,
      MIN(s.signal_date) AS first_signal_date,
      MAX(s.signal_date) AS last_signal_date,
      GROUP_CONCAT(DISTINCT s.board_name  ORDER BY s.board_name  SEPARATOR ', ') AS matched_boards,
      GROUP_CONCAT(DISTINCT s.signal_kind ORDER BY s.signal_kind SEPARATOR ', ') AS matched_kinds,
      GROUP_CONCAT(DISTINCT CONCAT(s.board_name, '/', s.signal_kind) ORDER BY s.board_name SEPARATOR ', ') AS raw_boards
    FROM board_signals s
    ${whereSQL}
    GROUP BY s.stock_code
    ${havingSQL}
    ORDER BY signal_count DESC, board_count DESC, stock_code ASC
    LIMIT ${limit}
  `;
  // POSITIVE/NEGATIVE param 두 set + WHERE params + HAVING params
  const finalParams = [...POSITIVE_KINDS, ...NEGATIVE_KINDS, ...params, ...havingParams];

  return await query(sql, finalParams);
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
  findOverlap,
  findRepeated,
  findStockHistory,
  findPerformance,
  findLinkSummary,
  findTodayFocus,
  findFilteredSignals,
  findDbSummary,
  findStockTimelines,
  findFunnelPassedStocks,
  findRecentRepeatedStocks,
  FUNNEL_REQUIRED_KINDS,
  NEGATIVE_KINDS,
  POSITIVE_KINDS,
};
