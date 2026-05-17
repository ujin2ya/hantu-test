#!/usr/bin/env node
/**
 * board_signal_outcomes 채우는 cron 스크립트.
 *
 * 정책:
 *   - 매일 16:40에 실행 (보드 generators 16:35 다음)
 *   - signal_date가 (today - LOOKBACK_DAYS) 이내인 모든 signals 대상
 *   - HORIZONS = [1, 3, 5, 10, 20] 각 horizon별로 outcome 계산·upsert
 *   - chart 캐시(cache/stock-charts-long/{code}.json)에서 OHLC 읽어 계산
 *   - horizon 거래일이 아직 안 됐으면 SKIP (다음 실행 시 채워짐)
 *   - 멱등: ON DUPLICATE KEY UPDATE
 *
 * 사용:
 *   node pipeline/populate-signal-outcomes.js                # default LOOKBACK=30
 *   node pipeline/populate-signal-outcomes.js --lookback 60
 *   node pipeline/populate-signal-outcomes.js --signal-id 123  # 단일 신호만
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { query, closePool } = require('../src/db/mysql');
const repo = require('../src/db/boardSignalRepository');

const ROOT = path.join(__dirname, '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');

const HORIZONS = [1, 3, 5, 10, 20];

function parseArgs() {
  const args = process.argv.slice(2);
  function get(key, def) {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : def;
  }
  return {
    lookback: Number(get('--lookback', 30)),
    signalId: get('--signal-id', null),
  };
}

const _chartCache = new Map();
function loadChartRows(code) {
  if (_chartCache.has(code)) return _chartCache.get(code);
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) { _chartCache.set(code, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const rows = Array.isArray(j.rows) ? j.rows : null;
    _chartCache.set(code, rows);
    return rows;
  } catch (_) { _chartCache.set(code, null); return null; }
}

function _ymdNoDash(d) {
  if (!d) return null;
  if (typeof d === 'string') {
    if (/^\d{8}$/.test(d)) return d;
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10).replace(/-/g, '');
  }
  return null;
}

// 가장 가까운 거래일 row를 찾아 시작 인덱스 반환 (signalDate row 또는 가장 가까운 다음)
function findSignalIdx(rows, signalYMD) {
  if (!rows || !rows.length) return -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].date === signalYMD) return i;
  }
  return -1;
}

function computeOutcome(rows, signalIdx, horizon, basePrice) {
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null;
  const targetIdx = signalIdx + horizon;
  if (targetIdx >= rows.length) return { _notReady: true };  // 아직 horizon 안 됨

  const targetRow = rows[targetIdx];
  if (!targetRow || !targetRow.close) return { _notReady: true };

  // D+1 ~ D+horizon 구간 최고/최저
  let maxHigh = 0, minLow = Infinity;
  for (let i = signalIdx + 1; i <= targetIdx; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.high > maxHigh) maxHigh = r.high;
    if (r.low > 0 && r.low < minLow) minLow = r.low;
  }
  if (minLow === Infinity) minLow = null;

  const closeReturn = (targetRow.close / basePrice - 1) * 100;
  const maxHighReturn = maxHigh > 0 ? (maxHigh / basePrice - 1) * 100 : null;
  const minLowReturn  = minLow != null && minLow > 0 ? (minLow / basePrice - 1) * 100 : null;

  return {
    base_price: basePrice,
    close_price: targetRow.close,
    high_price:  targetRow.high,
    low_price:   targetRow.low,
    max_high_price: maxHigh || null,
    min_low_price:  minLow,
    close_return_pct:    Number(closeReturn.toFixed(4)),
    max_high_return_pct: maxHighReturn != null ? Number(maxHighReturn.toFixed(4)) : null,
    min_low_return_pct:  minLowReturn  != null ? Number(minLowReturn.toFixed(4))  : null,
    hit_3:  maxHighReturn != null && maxHighReturn >= 3,
    hit_5:  maxHighReturn != null && maxHighReturn >= 5,
    hit_10: maxHighReturn != null && maxHighReturn >= 10,
    hit_15: maxHighReturn != null && maxHighReturn >= 15,
    hit_20: maxHighReturn != null && maxHighReturn >= 20,
    hit_30: maxHighReturn != null && maxHighReturn >= 30,
    fail_3:  minLowReturn != null && minLowReturn <= -3,
    fail_5:  minLowReturn != null && minLowReturn <= -5,
    fail_10: minLowReturn != null && minLowReturn <= -10,
  };
}

(async () => {
  const t0 = Date.now();
  const { lookback, signalId } = parseArgs();
  console.log('🗓 populate-signal-outcomes 시작 lookback=' + lookback + (signalId ? ' signalId=' + signalId : ''));

  let signals;
  if (signalId) {
    signals = await query('SELECT id, board_name, signal_kind, signal_date, stock_code, signal_price FROM board_signals WHERE id = ?', [signalId]);
  } else {
    signals = await query(
      `SELECT id, board_name, signal_kind, signal_date, stock_code, signal_price
       FROM board_signals
       WHERE signal_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         AND signal_price IS NOT NULL`,
      [lookback]
    );
  }
  console.log('  대상 signals: ' + signals.length + '건');

  let computed = 0, skipped = 0, noChart = 0, notReady = 0, errors = 0;
  for (const sig of signals) {
    const code = sig.stock_code;
    const rows = loadChartRows(code);
    if (!rows) { noChart++; continue; }
    const signalYMD = _ymdNoDash(sig.signal_date);
    if (!signalYMD) { skipped++; continue; }
    const sIdx = findSignalIdx(rows, signalYMD);
    if (sIdx < 0) { skipped++; continue; }

    for (const h of HORIZONS) {
      try {
        const out = computeOutcome(rows, sIdx, h, Number(sig.signal_price));
        if (!out) { skipped++; continue; }
        if (out._notReady) { notReady++; continue; }
        await repo.upsertSignalOutcome(sig.id, h, out);
        computed++;
      } catch (e) {
        errors++;
        console.warn('  ⚠ ' + sig.id + ' h=' + h + ' err: ' + e.message);
      }
    }
  }

  console.log('✅ 완료: computed=' + computed + ' notReady=' + notReady + ' noChart=' + noChart + ' skipped=' + skipped + ' errors=' + errors);
  console.log('   elapsed: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  await closePool();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
