#!/usr/bin/env node
/**
 * signal_links 자동 생성 cron.
 *
 * 정책:
 *   - 매일 16:40에 populate-signal-outcomes 다음에 실행
 *   - 최근 LOOKBACK 일 이내 signal들에 대해 prior signal과의 시퀀스 link 생성
 *   - 멱등: UNIQUE(from_signal_id, to_signal_id, link_type) — INSERT IGNORE
 *
 * 현재 지원 link_type:
 *   - QVA2_TO_VVI2                       : QVA2_WATCHLIST.QVA2_NEW → QVA2_WATCHLIST.VVI2_FIRED (같은 stock, vvi.signal_date > qva.signal_date)
 *   - QVA2_NEW_TO_BREAKOUT_SUCCESS       : QVA2_NEW → QVA2_WATCHLIST.BREAKOUT_SUCCESS
 *   - VVI2_TO_BREAKOUT_SUCCESS           : QVA2_WATCHLIST.VVI2_FIRED → QVA2_WATCHLIST.BREAKOUT_SUCCESS
 *   - ONE_DAY_SURGE_MAIN_TO_ATTACK_TOP   : 같은 날 같은 종목이 MAIN + ATTACK_TOP 둘 다에 등장
 *
 * 향후 보드 확대 시 새 link_type을 RULES에 추가만 하면 됨.
 */

require('dotenv').config({ quiet: true });
const { query, closePool } = require('../src/db/mysql');
const repo = require('../src/db/boardSignalRepository');

const DEFAULT_LOOKBACK_DAYS = 30;

// Link 룰: from(board_name, signal_kind) → to(board_name, signal_kind), 시간 관계
// direction:
//   'forward'  — to.signal_date > from.signal_date, 같은 stock (보드 간 funnel 시퀀스)
//   'same_day' — to.signal_date = from.signal_date, 같은 stock (다른 보드에 동시 등장)
const LINK_RULES = [
  // === QVA2 funnel (1차 작업분) ===
  {
    type: 'QVA2_TO_VVI2',
    from: { board_name: 'QVA2_WATCHLIST', signal_kind: 'QVA2_NEW' },
    to:   { board_name: 'QVA2_WATCHLIST', signal_kind: 'VVI2_FIRED' },
    direction: 'forward',
  },
  {
    type: 'QVA2_NEW_TO_BREAKOUT_SUCCESS',
    from: { board_name: 'QVA2_WATCHLIST', signal_kind: 'QVA2_NEW' },
    to:   { board_name: 'QVA2_WATCHLIST', signal_kind: 'BREAKOUT_SUCCESS' },
    direction: 'forward',
  },
  {
    type: 'VVI2_TO_BREAKOUT_SUCCESS',
    from: { board_name: 'QVA2_WATCHLIST', signal_kind: 'VVI2_FIRED' },
    to:   { board_name: 'QVA2_WATCHLIST', signal_kind: 'BREAKOUT_SUCCESS' },
    direction: 'forward',
  },

  // === QVA (과거 보드) funnel — QVA_WATCHLIST 단일 보드 안 stage 전환 ===
  {
    type: 'QVA_TO_VVI',
    from: { board_name: 'QVA_WATCHLIST', signal_kind: 'QVA_NEW' },
    to:   { board_name: 'QVA_WATCHLIST', signal_kind: 'VVI_FIRED' },
    direction: 'forward',
  },
  {
    type: 'QVA_NEW_TO_BREAKOUT_SUCCESS',
    from: { board_name: 'QVA_WATCHLIST', signal_kind: 'QVA_NEW' },
    to:   { board_name: 'QVA_WATCHLIST', signal_kind: 'BREAKOUT_SUCCESS' },
    direction: 'forward',
  },
  {
    type: 'VVI_TO_BREAKOUT_SUCCESS',
    from: { board_name: 'QVA_WATCHLIST', signal_kind: 'VVI_FIRED' },
    to:   { board_name: 'QVA_WATCHLIST', signal_kind: 'BREAKOUT_SUCCESS' },
    direction: 'forward',
  },
  {
    type: 'QVA_NEW_TO_FAILED',
    from: { board_name: 'QVA_WATCHLIST', signal_kind: 'QVA_NEW' },
    to:   { board_name: 'QVA_WATCHLIST', signal_kind: 'FAILED' },
    direction: 'forward',
  },

  // === 보드 간 cross-board 시퀀스 ===
  // direction='forward_or_same' — 같은 날에도 매칭 (BREAKOUT 종목이 같은 날 D+5/REBREAK에 등장하는 정상 케이스)
  {
    type: 'QVA_BREAKOUT_TO_HGROUP_REBREAK',
    from: { board_name: 'QVA_WATCHLIST', signal_kind: 'BREAKOUT_SUCCESS' },
    to:   { board_name: 'HGROUP_REBREAK' },           // signal_kind 와일드카드: 모든 status
    direction: 'forward_or_same',
  },
  {
    type: 'QVA2_BREAKOUT_TO_D5',
    from: { board_name: 'QVA2_WATCHLIST', signal_kind: 'BREAKOUT_SUCCESS' },
    to:   { board_name: 'QVA2_D5_REBREAK' },
    direction: 'forward_or_same',
  },
  {
    type: 'QVA_TO_VVI_REDEFINED',
    from: { board_name: 'QVA_WATCHLIST', signal_kind: 'QVA_NEW' },
    to:   { board_name: 'QVA_VVI_REDEFINED' },
    direction: 'forward_or_same',
  },
  {
    type: 'QVA2_TO_QVA2_VVI',
    from: { board_name: 'QVA2_WATCHLIST', signal_kind: 'QVA2_NEW' },
    to:   { board_name: 'QVA2_VVI' },
    direction: 'forward_or_same',
  },

  // === 같은 날 동시 등장 ===
  {
    type: 'ONE_DAY_SURGE_MAIN_TO_ATTACK_TOP',
    from: { board_name: 'ONE_DAY_SURGE', signal_kind: 'MAIN' },
    to:   { board_name: 'ONE_DAY_SURGE', signal_kind: 'ATTACK_TOP' },
    direction: 'same_day',
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  function get(key, def) {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : def;
  }
  return {
    lookback: Number(get('--lookback', DEFAULT_LOOKBACK_DAYS)),
  };
}

async function reconcileRule(rule, lookback) {
  // signal_kind는 룰에서 생략 가능 (와일드카드 = board_name의 모든 stage)
  const fromHasKind = !!rule.from.signal_kind;
  const toHasKind   = !!rule.to.signal_kind;

  const fromKindClause = fromHasKind ? 'AND f.signal_kind = ?' : '';
  const toKindClause   = toHasKind   ? 'AND t.signal_kind = ?' : '';

  let sql, params;
  if (rule.direction === 'forward' || rule.direction === 'forward_or_same') {
    // forward: t.date > f.date
    // forward_or_same: t.date >= f.date AND t.id != f.id (자기 자신 link 방지)
    const dateOp = rule.direction === 'forward_or_same' ? '>=' : '>';
    const selfGuard = rule.direction === 'forward_or_same' ? 'AND f.id != t.id' : '';
    sql = `
      SELECT
        f.id AS from_id, f.signal_date AS from_date, f.signal_kind AS from_kind,
        t.id AS to_id,   t.signal_date AS to_date,   t.signal_kind AS to_kind,
        f.stock_code,
        DATEDIFF(t.signal_date, f.signal_date) AS days_between
      FROM board_signals f
      JOIN board_signals t
        ON  t.stock_code  = f.stock_code
        AND t.board_name  = ?
        ${toKindClause}
        AND t.signal_date ${dateOp} f.signal_date
        ${selfGuard}
      WHERE f.board_name  = ?
        ${fromKindClause}
        AND t.signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    `;
    params = [rule.to.board_name];
    if (toHasKind)   params.push(rule.to.signal_kind);
    params.push(rule.from.board_name);
    if (fromHasKind) params.push(rule.from.signal_kind);
    params.push(lookback);
  } else { // same_day
    sql = `
      SELECT
        f.id AS from_id, f.signal_date AS from_date, f.signal_kind AS from_kind,
        t.id AS to_id,   t.signal_date AS to_date,   t.signal_kind AS to_kind,
        f.stock_code,
        0 AS days_between
      FROM board_signals f
      JOIN board_signals t
        ON  t.stock_code  = f.stock_code
        AND t.signal_date = f.signal_date
        AND t.board_name  = ?
        ${toKindClause}
      WHERE f.board_name = ?
        ${fromKindClause}
        AND f.signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    `;
    params = [rule.to.board_name];
    if (toHasKind)   params.push(rule.to.signal_kind);
    params.push(rule.from.board_name);
    if (fromHasKind) params.push(rule.from.signal_kind);
    params.push(lookback);
  }

  const pairs = await query(sql, params);
  let inserted = 0;
  for (const p of pairs) {
    // 동일 stock의 첫 to 신호만 link 하기 위해 가장 가까운 거 1개만 (forward 한정)
    // — 여기서는 단순화: 모두 link IGNORE. UNIQUE 키가 중복 방지.
    await repo.linkSignals(p.from_id, p.to_id, rule.type, {
      days_between: p.days_between,
      meta_json: { from_date: p.from_date, to_date: p.to_date, stock_code: p.stock_code },
    });
    inserted++;
  }
  return { pairs: pairs.length, inserted };
}

(async () => {
  const t0 = Date.now();
  const { lookback } = parseArgs();
  console.log('🔗 reconcile-signal-links 시작 lookback=' + lookback);

  let totalLinks = 0;
  for (const rule of LINK_RULES) {
    try {
      const r = await reconcileRule(rule, lookback);
      console.log('  ' + rule.type.padEnd(35) + ' pairs=' + r.pairs + ' inserted/ignored=' + r.inserted);
      totalLinks += r.inserted;
    } catch (e) {
      console.warn('  ⚠ ' + rule.type + ' 실패: ' + e.message);
    }
  }

  // 현재 누적 links 통계
  const stats = await query(
    `SELECT link_type, COUNT(*) AS n, AVG(days_between) AS avg_days, MAX(days_between) AS max_days
     FROM signal_links GROUP BY link_type ORDER BY link_type`
  );
  console.log('\n📊 누적 signal_links:');
  for (const s of stats) {
    console.log('  ' + s.link_type.padEnd(35) + ' n=' + s.n + ' avg_days=' + (s.avg_days != null ? Number(s.avg_days).toFixed(1) : '-') + ' max_days=' + (s.max_days ?? '-'));
  }

  console.log('\n✅ 완료: 처리한 link=' + totalLinks + ' / elapsed ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  await closePool();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
