/**
 * board_signals 의 OHLC + volume + trading_value 를 cache/stock-charts-long/{code}.json 기준으로
 * 일괄 backfill. signal_close 가 보드별로 다른 의미 (= "기준 종가" 같은 시점 종가) 였던 문제를 정리.
 *
 * 정책:
 *   - signal_open / signal_high / signal_low / signal_close = signal_date 의 실제 일봉 OHLC
 *   - volume / trading_value = signal_date 의 실제 일봉 값
 *   - signal_price 는 그대로 (보드별 "기준가" 의미 보존)
 *   - 차트 캐시 없거나 그날 봉이 없는 종목은 skip (변경 안 함)
 *   - OHLC 가 이미 차트와 일치하면 UPDATE skip (불필요 쓰기 방지)
 *
 * 사용:
 *   node scripts/backfill-board-signal-ohlc.js                   # 전체 backfill
 *   node scripts/backfill-board-signal-ohlc.js --dry-run         # 실행하지 않고 변경 예정 건수만
 *   node scripts/backfill-board-signal-ohlc.js --code 185490     # 단일 종목
 *   node scripts/backfill-board-signal-ohlc.js --from 2026-05-01 # signal_date 시작일
 *   node scripts/backfill-board-signal-ohlc.js --to 2026-05-22
 *   node scripts/backfill-board-signal-ohlc.js --batch 500       # 배치 size (default 500)
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const ROOT = path.join(__dirname, '..');
const CHART_LONG_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const { query, closePool } = require('../src/db/mysql');

function parseArgs(argv) {
  const a = { dryRun: false, code: null, from: null, to: null, batch: 500 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--code')  a.code  = argv[++i];
    else if (k === '--from')  a.from  = argv[++i];
    else if (k === '--to')    a.to    = argv[++i];
    else if (k === '--batch') a.batch = Number(argv[++i] || 500);
  }
  return a;
}

const _chartRowCache = new Map();
function loadChartRows(stockCode) {
  if (_chartRowCache.has(stockCode)) return _chartRowCache.get(stockCode);
  const fp = path.join(CHART_LONG_DIR, stockCode + '.json');
  if (!fs.existsSync(fp)) { _chartRowCache.set(stockCode, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const rows = Array.isArray(j) ? j : (j.rows || []);
    const byDate = new Map();
    for (const r of rows) if (r && r.date) byDate.set(String(r.date), r);
    _chartRowCache.set(stockCode, byDate);
    return byDate;
  } catch (_) {
    _chartRowCache.set(stockCode, null);
    return null;
  }
}

function toYmdNum(d) {
  if (!d) return null;
  const s = String(d);
  if (/^\d{8}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + m[2] + m[3] : null;
}

function approxEq(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.5; // 정수 가격 비교 — 0.5 미만이면 같음
}

async function main() {
  const args = parseArgs(process.argv);
  const where = [];
  const params = [];
  if (args.code) { where.push('stock_code = ?'); params.push(args.code); }
  if (args.from) { where.push('signal_date >= ?'); params.push(args.from); }
  if (args.to)   { where.push('signal_date <= ?'); params.push(args.to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 1) 총 row 수
  const [total] = await query(`SELECT COUNT(*) AS n FROM board_signals ${whereSql}`, params);
  console.log(`📊 대상 row: ${total.n} (filter: ${JSON.stringify(args)})`);
  if (total.n === 0) { await closePool(); return; }

  // 2) 페이지네이션 backfill
  const stats = {
    seen: 0,
    updated: 0,
    skipped_chart_missing: 0,
    skipped_day_missing: 0,
    skipped_already_correct: 0,
    skipped_halted: 0,
  };

  let offset = 0;
  const batchSize = Math.max(50, Math.min(args.batch | 0, 5000));
  while (true) {
    const rows = await query(
      `SELECT id, stock_code, signal_date,
              signal_open, signal_high, signal_low, signal_close, volume, trading_value
       FROM board_signals
       ${whereSql}
       ORDER BY id ASC
       LIMIT ${batchSize} OFFSET ${offset}`,
      params
    );
    if (rows.length === 0) break;

    for (const r of rows) {
      stats.seen++;
      const byDate = loadChartRows(r.stock_code);
      if (!byDate) { stats.skipped_chart_missing++; continue; }
      const dateNum = toYmdNum(r.signal_date);
      if (!dateNum) { stats.skipped_day_missing++; continue; }
      const dr = byDate.get(dateNum);
      if (!dr) { stats.skipped_day_missing++; continue; }
      // 거래정지 — OHLC 가 모두 0/null 이면 skip
      if (!(dr.close > 0) && !(dr.high > 0) && !(dr.low > 0) && !(dr.open > 0)) {
        stats.skipped_halted++; continue;
      }

      // 이미 정확하면 skip
      if (approxEq(r.signal_open,  dr.open)  && approxEq(r.signal_high, dr.high) &&
          approxEq(r.signal_low,   dr.low)   && approxEq(r.signal_close, dr.close) &&
          (r.volume == null || Number(r.volume) === Number(dr.volume || 0)) &&
          (r.trading_value == null || Number(r.trading_value) === Number(dr.valueApprox || 0))) {
        stats.skipped_already_correct++;
        continue;
      }

      if (!args.dryRun) {
        await query(
          `UPDATE board_signals
              SET signal_open  = ?, signal_high = ?, signal_low = ?, signal_close = ?,
                  volume       = COALESCE(?, volume),
                  trading_value = COALESCE(?, trading_value)
            WHERE id = ?`,
          [
            Number(dr.open) || null,
            Number(dr.high) || null,
            Number(dr.low)  || null,
            Number(dr.close) || null,
            dr.volume       != null ? Number(dr.volume)       : null,
            dr.valueApprox  != null ? Number(dr.valueApprox)  : null,
            r.id,
          ]
        );
      }
      stats.updated++;
    }

    offset += rows.length;
    if (offset % (batchSize * 4) === 0) {
      console.log(`  진행 ${offset}/${total.n} (updated=${stats.updated}, chart_missing=${stats.skipped_chart_missing}, day_missing=${stats.skipped_day_missing}, already_correct=${stats.skipped_already_correct})`);
    }
  }

  console.log('');
  console.log('✅ 완료');
  console.log('  대상            :', stats.seen);
  console.log('  업데이트         :', stats.updated, args.dryRun ? '(dry-run — 실제 UPDATE 안 함)' : '');
  console.log('  이미 정확        :', stats.skipped_already_correct);
  console.log('  차트 캐시 없음   :', stats.skipped_chart_missing);
  console.log('  그날 봉 없음     :', stats.skipped_day_missing);
  console.log('  거래정지         :', stats.skipped_halted);

  await closePool();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
