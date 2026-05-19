// QVA 장중 감시 보드 백테스트.
// 각 거래일을 cutoffDate로 잡고 09:30/10:00/11:00 시점 스냅샷을 만들어
// liveGrade가 실제 이후 상승/하락을 얼마나 잘 구분하는지 검증한다.
//
// qva-live-watch-board.js의 핵심 함수(시간 보정, evaluateLiveWatch)를 그대로 복사해
// 본체 변경 없이 동일 결과를 재현한다.
//
// 산출:
//   reports/qva-live-watch-backtest-result.json
//   reports/qva-live-watch-backtest-result.html
//
// 사용:
//   node boards/qva/qva-live-watch-backtest.js [--days 60] [--lookback-qva 20]
//        [--times 09:30,10:00,11:00] [--min-sample 30]

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR    = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_DIR = path.join(ROOT, 'data', 'intraday', '1ds');
const NAVER_LIST   = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const OUT_JSON     = path.join(ROOT, 'reports', 'qva-live-watch-backtest-result.json');
const OUT_HTML     = path.join(ROOT, 'reports', 'qva-live-watch-backtest-result.html');

const HVM_CODE = '295310';

// ── CLI ──
function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i+1] : def; }
const DAYS         = parseInt(arg('--days', '60'), 10);
const LOOKBACK_QVA = parseInt(arg('--lookback-qva', '20'), 10);
const SIGNAL_TIMES = String(arg('--times', '09:30,10:00,11:00')).split(',').map(s => s.trim());
const MIN_SAMPLE   = parseInt(arg('--min-sample', '30'), 10);

// ── 유틸 ──
function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}
function ymdDash(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0,10);
  const s = String(d);
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return s.slice(0, 10);
}
function dashToYmd(s) { return s ? String(s).replace(/-/g, '').slice(0, 8) : null; }

// ── 시간 보정 (qva-live-watch-board.js와 동일) ──
function getIntradayTimeWeight(lastBarTime) {
  if (!lastBarTime) return 1.0;
  const [hhs, mms] = String(lastBarTime).split(':');
  const hh = parseInt(hhs, 10), mm = parseInt(mms || '0', 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 1.0;
  const m = hh * 60 + mm;
  if (m <= 9*60+10)  return 2.5;
  if (m <= 9*60+30)  return 2.2;
  if (m <= 10*60+0)  return 2.0;
  if (m <= 10*60+30) return 1.7;
  if (m <= 11*60+0)  return 1.5;
  if (m <= 13*60+0)  return 1.25;
  if (m <= 14*60+0)  return 1.1;
  return 1.0;
}
function timeBucketLabel(t) {
  if (!t) return 'full_day';
  const [hhs, mms] = String(t).split(':');
  const m = parseInt(hhs,10)*60 + parseInt(mms||'0',10);
  if (m <= 9*60+10)  return 'lt_0910';
  if (m <= 9*60+30)  return 'lt_0930';
  if (m <= 10*60+0)  return 'lt_1000';
  if (m <= 10*60+30) return 'lt_1030';
  if (m <= 11*60+0)  return 'lt_1100';
  if (m <= 13*60+0)  return 'lt_1300';
  if (m <= 14*60+0)  return 'lt_1400';
  return 'lt_1530';
}
function capMul(x, cap = 10) {
  if (x == null || !Number.isFinite(x)) return null;
  return x > cap ? cap : x;
}

// ── evaluateLiveWatch (qva-live-watch-board.js와 동일 결과) ──
function evaluateLiveWatch(snap, qva) {
  const range = snap.high - snap.low;
  const currentPositionInDayRange = range > 0 ? (snap.current - snap.low) / range : 0.5;
  const upperTailRatio = range > 0 ? (snap.high - snap.current) / range : 0;
  const gapPct = snap.prevClose > 0 ? (snap.open / snap.prevClose - 1) * 100 : null;
  const changeRate = snap.prevClose > 0 ? (snap.current / snap.prevClose - 1) * 100 : null;
  const openToCurrentPct = snap.open > 0 ? (snap.current / snap.open - 1) * 100 : null;
  const valueRatio20  = snap.avg20Value > 0 ? snap.valueAmount / snap.avg20Value : null;
  const volumeRatio20 = snap.avg20Volume > 0 ? snap.volume / snap.avg20Volume : null;
  const valueToQvaRatio  = qva.qvaValue > 0 ? snap.valueAmount / qva.qvaValue : null;
  const volumeToQvaRatio = qva.qvaVolume > 0 ? snap.volume / qva.qvaVolume : null;
  const highToQvaHighPct    = qva.qvaHigh > 0 ? (snap.high / qva.qvaHigh - 1) * 100 : null;
  const currentToQvaHighPct = qva.qvaHigh > 0 ? (snap.current / qva.qvaHigh - 1) * 100 : null;
  const cumReturnFromQvaClose = qva.qvaClose > 0 ? (snap.current / qva.qvaClose - 1) * 100 : null;

  const isIntraday = snap.mode === 'intraday';
  const intradayTimeWeight = isIntraday ? getIntradayTimeWeight(snap.lastBarTime) : 1.0;
  const intradayTimeBucket = isIntraday ? timeBucketLabel(snap.lastBarTime) : 'full_day';
  const timeAdjustedValueRatio20    = isIntraday && valueRatio20    != null ? capMul(valueRatio20    * intradayTimeWeight) : (valueRatio20    ?? null);
  const timeAdjustedVolumeRatio20   = isIntraday && volumeRatio20   != null ? capMul(volumeRatio20   * intradayTimeWeight) : (volumeRatio20   ?? null);
  const timeAdjustedValueToQvaRatio = isIntraday && valueToQvaRatio != null ? capMul(valueToQvaRatio * intradayTimeWeight) : (valueToQvaRatio ?? null);
  const timeAdjustedVolumeToQvaRatio= isIntraday && volumeToQvaRatio!= null ? capMul(volumeToQvaRatio* intradayTimeWeight) : (volumeToQvaRatio?? null);

  const tRaw = {};
  tRaw.VALUE_WAKE        = (valueRatio20 ?? 0) >= 2 || (valueToQvaRatio ?? 0) >= 0.8;
  tRaw.STRONG_VALUE_WAKE = (valueRatio20 ?? 0) >= 4 || (valueToQvaRatio ?? 0) >= 1.5;

  const t = {};
  t.GAP_UP             = (gapPct ?? -999) >= 3;
  t.STRONG_GAP_UP      = (gapPct ?? -999) >= 7;
  t.VALUE_WAKE         = tRaw.VALUE_WAKE || (isIntraday && (
                            (timeAdjustedValueRatio20 ?? 0) >= 2.5 ||
                            (timeAdjustedValueToQvaRatio ?? 0) >= 1.2));
  t.STRONG_VALUE_WAKE  = tRaw.STRONG_VALUE_WAKE || (isIntraday && (
                            (timeAdjustedValueRatio20 ?? 0) >= 4 ||
                            (timeAdjustedValueToQvaRatio ?? 0) >= 2));
  t.QVA_HIGH_APPROACH  = qva.qvaHigh > 0 && snap.high >= qva.qvaHigh * 0.98;
  t.QVA_HIGH_BREAK     = qva.qvaHigh > 0 && (snap.high >= qva.qvaHigh || snap.current >= qva.qvaHigh);
  t.HOLDING_HIGH_ZONE  = (currentPositionInDayRange ?? 0) >= 0.70 && (upperTailRatio ?? 1) <= 0.40;
  t.STRONG_MOMENTUM    = (changeRate ?? -999) >= 7 && (currentPositionInDayRange ?? 0) >= 0.70;
  t.LIMIT_UP_LIKE      = (changeRate ?? -999) >= 20 && (currentPositionInDayRange ?? 0) >= 0.80;
  const baseTagCount = ['GAP_UP','STRONG_GAP_UP','VALUE_WAKE','STRONG_VALUE_WAKE',
    'QVA_HIGH_APPROACH','QVA_HIGH_BREAK','HOLDING_HIGH_ZONE','STRONG_MOMENTUM','LIMIT_UP_LIKE']
    .filter(k => t[k]).length;
  t.EARLY_REACTION = qva.daysFromQva >= 1 && qva.daysFromQva <= 5 && baseTagCount >= 2;

  let score = 0;
  if (t.STRONG_GAP_UP)        score += 15;
  else if (t.GAP_UP)          score += 8;
  if (t.STRONG_VALUE_WAKE)    score += 20;
  else if (t.VALUE_WAKE)      score += 12;
  if (t.QVA_HIGH_BREAK)       score += 15;
  else if (t.QVA_HIGH_APPROACH) score += 10;
  if (t.HOLDING_HIGH_ZONE)    score += 12;
  if (t.STRONG_MOMENTUM)      score += 15;
  if (t.LIMIT_UP_LIKE)        score += 20;
  if (qva.daysFromQva <= 3)   score += 8;
  else if (qva.daysFromQva <= 5) score += 5;
  if (qva.qvaType === 'QVA2' || (qva.qvaTypeAll || []).includes('QVA2')) score += 5;

  let penalty = 0;
  if ((upperTailRatio ?? 0) >= 0.60) penalty -= 15;
  if ((currentPositionInDayRange ?? 1) < 0.40) penalty -= 15;
  if ((gapPct ?? 0) >= 10 && (currentPositionInDayRange ?? 1) < 0.50) penalty -= 15;
  if ((changeRate ?? 0) >= 20 && (upperTailRatio ?? 0) >= 0.40) penalty -= 10;
  let overheat = false;
  if ((cumReturnFromQvaClose ?? 0) >= 40) { penalty -= 10; overheat = true; }

  const liveWatchScore = Math.max(0, Math.min(100, score + penalty));
  const risky = (upperTailRatio ?? 0) >= 0.60
            || ((changeRate ?? 0) >= 20 && (upperTailRatio ?? 0) >= 0.40)
            || ((gapPct ?? 0) >= 10 && (currentPositionInDayRange ?? 1) < 0.50);

  let liveGrade;
  if (liveWatchScore >= 70)      liveGrade = 'LIVE_A';
  else if (liveWatchScore >= 50) liveGrade = 'LIVE_B';
  else if (liveWatchScore >= 35) liveGrade = 'LIVE_C';
  else if (liveWatchScore >= 20) liveGrade = 'WAIT';
  else                           liveGrade = baseTagCount > 0 ? 'WAIT' : null;
  if (risky && liveWatchScore < 70) liveGrade = 'RISK';

  const extraTags = [];
  if (t.STRONG_GAP_UP)       extraTags.push('STRONG_GAP_UP');
  else if (t.GAP_UP)         extraTags.push('GAP_UP');
  if (t.STRONG_VALUE_WAKE)   extraTags.push('STRONG_VALUE_WAKE');
  else if (t.VALUE_WAKE)     extraTags.push('VALUE_WAKE');
  if (t.QVA_HIGH_BREAK)      extraTags.push('QVA_HIGH_BREAK');
  else if (t.QVA_HIGH_APPROACH) extraTags.push('QVA_HIGH_APPROACH');
  if (t.HOLDING_HIGH_ZONE)   extraTags.push('HOLDING_HIGH_ZONE');
  if (t.STRONG_MOMENTUM)     extraTags.push('STRONG_MOMENTUM');
  if (t.LIMIT_UP_LIKE)       extraTags.push('LIMIT_UP_LIKE');
  if (t.EARLY_REACTION)      extraTags.push('EARLY_REACTION');
  if (overheat)              extraTags.push('OVERHEAT_CAUTION');
  if ((upperTailRatio ?? 0) >= 0.45) extraTags.push('UPPER_TAIL_CAUTION');
  if ((gapPct ?? 0) >= 10 && (currentPositionInDayRange ?? 1) < 0.50) extraTags.push('GAP_FAIL_CAUTION');

  return {
    gapPct: round(gapPct), changeRate: round(changeRate),
    openToCurrentPct: round(openToCurrentPct),
    currentPositionInDayRange: round(currentPositionInDayRange, 3),
    upperTailRatio: round(upperTailRatio, 3),
    valueRatio20: round(valueRatio20), volumeRatio20: round(volumeRatio20),
    valueToQvaRatio: round(valueToQvaRatio), volumeToQvaRatio: round(volumeToQvaRatio),
    intradayTimeWeight, intradayTimeBucket,
    timeAdjustedValueRatio20: round(timeAdjustedValueRatio20),
    timeAdjustedVolumeRatio20: round(timeAdjustedVolumeRatio20),
    timeAdjustedValueToQvaRatio: round(timeAdjustedValueToQvaRatio),
    timeAdjustedVolumeToQvaRatio: round(timeAdjustedVolumeToQvaRatio),
    highToQvaHighPct: round(highToQvaHighPct),
    currentToQvaHighPct: round(currentToQvaHighPct),
    cumReturnFromQvaClose: round(cumReturnFromQvaClose),
    tags: t, rawTags: tRaw, extraTags,
    liveWatchScore, liveGrade, overheat, risky,
  };
}

// ── 분봉 누적: untilTime "HH:MM" 이하까지 ──
function aggregateBarsUntil(bars, untilTime) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const [uh, um] = untilTime.split(':').map(Number);
  const limit = uh * 60 + um;
  let open = null, high = 0, low = Infinity, current = null;
  let volume = 0, valueAmount = 0, lastBarTime = null;
  for (const b of bars) {
    if (!b || !b.time) continue;
    const [bh, bm] = b.time.split(':').map(Number);
    const t = bh * 60 + bm;
    if (t > limit) break;
    if (open == null) open = b.open;
    if (b.high > high) high = b.high;
    if (b.low > 0 && b.low < low) low = b.low;
    current = b.close;
    volume += b.volume || 0;
    valueAmount += b.value || 0;
    lastBarTime = b.time;
  }
  if (open == null) return null;
  return { open, high, low: low === Infinity ? 0 : low, current, volume, valueAmount, lastBarTime };
}

// ── 로더 ──
function loadMetaMap() {
  const map = new Map();
  if (!fs.existsSync(NAVER_LIST)) return map;
  try {
    const j = JSON.parse(fs.readFileSync(NAVER_LIST, 'utf-8'));
    for (const s of (j.stocks || [])) {
      if (!s.code) continue;
      map.set(s.code, { name: s.name, market: s.market, marketCap: s.marketValue || 0 });
    }
  } catch (_) {}
  return map;
}
const chartCache = new Map();
function loadChart(code) {
  if (chartCache.has(code)) return chartCache.get(code);
  const p = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(p)) { chartCache.set(code, null); return null; }
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (c && Array.isArray(c.rows)) {
      c._idxByDate = new Map();
      for (let i = 0; i < c.rows.length; i++) c._idxByDate.set(c.rows[i].date, i);
    }
    chartCache.set(code, c);
    return c;
  } catch (_) { chartCache.set(code, null); return null; }
}
function loadIntradayBars(dirDash, code) {
  const p = path.join(INTRADAY_DIR, dirDash, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return j.bars || j.minutes || null;
  } catch (_) { return null; }
}

// ── DB QVA seed ──
async function loadAllQvaSignals() {
  const { query } = require('../../src/db/mysql');
  // 백테스트 전체 기간 + lookback 마진
  const margin = DAYS + LOOKBACK_QVA + 20;
  const rows = await query(`
    SELECT board_name, signal_kind, signal_date, stock_code
    FROM board_signals
    WHERE signal_date >= DATE_SUB(CURDATE(), INTERVAL ${margin} DAY)
      AND (
        (board_name = 'QVA_WATCHLIST'  AND signal_kind = 'QVA_NEW') OR
        (board_name = 'QVA2_WATCHLIST' AND signal_kind = 'QVA2_NEW')
      )
    ORDER BY signal_date DESC
  `);
  return rows.map(r => ({
    date: ymdDash(r.signal_date),
    type: r.board_name === 'QVA2_WATCHLIST' ? 'QVA2' : 'QVA1',
    code: r.stock_code,
  }));
}

// ── 사후 성과 계산 ──
function computePostPerformance(rows, cutoffIdx, snapshotPrice, snapHighSoFar) {
  const pct = (p) => p ? (p / snapshotPrice - 1) * 100 : null;
  const dayRow = rows[cutoffIdx];
  const sameDayHigh = dayRow ? dayRow.high : null;
  const sameDayClose = dayRow ? dayRow.close : null;
  // sameDayAfterSignalHigh — signal 시점까지의 high는 snap.high. day high가 더 크면 그 잔여에 도달했다고 추정.
  const sameDayAfterSignalHigh = (snapHighSoFar && sameDayHigh && sameDayHigh > snapHighSoFar)
    ? sameDayHigh : snapHighSoFar;

  const nextRows = [];
  for (let i = 1; i <= 20; i++) {
    const r = rows[cutoffIdx + i];
    if (!r) break;
    nextRows.push(r);
  }
  const maxHigh = (k) => {
    if (nextRows.length === 0) return null;
    const window = nextRows.slice(0, Math.min(k, nextRows.length));
    let mh = 0;
    for (const r of window) if (r.high > mh) mh = r.high;
    return mh > 0 ? mh : null;
  };
  const minLow = (k) => {
    if (nextRows.length === 0) return null;
    const window = nextRows.slice(0, Math.min(k, nextRows.length));
    let ml = Infinity;
    for (const r of window) if (r.low > 0 && r.low < ml) ml = r.low;
    return ml === Infinity ? null : ml;
  };
  const closeAt = (k) => nextRows[k - 1] ? nextRows[k - 1].close : null;

  // first hit / breach day
  let firstHit5 = null, firstHit10 = null, firstHit15 = null, firstHit20 = null;
  let firstBreach5 = null, firstBreach10 = null;
  for (let i = 0; i < Math.min(10, nextRows.length); i++) {
    const r = nextRows[i];
    const hp = pct(r.high), lp = pct(r.low);
    if (firstHit5  == null && hp >= 5)  firstHit5  = i + 1;
    if (firstHit10 == null && hp >= 10) firstHit10 = i + 1;
    if (firstHit15 == null && hp >= 15) firstHit15 = i + 1;
    if (firstHit20 == null && hp >= 20) firstHit20 = i + 1;
    if (firstBreach5  == null && lp <= -5)  firstBreach5  = i + 1;
    if (firstBreach10 == null && lp <= -10) firstBreach10 = i + 1;
  }

  return {
    sameDayHighAfterSignalPct: round(pct(sameDayAfterSignalHigh)),
    sameDayClosePct: round(pct(sameDayClose)),
    maxHighD1Pct:  round(pct(maxHigh(1))),
    maxHighD3Pct:  round(pct(maxHigh(3))),
    maxHighD5Pct:  round(pct(maxHigh(5))),
    maxHighD10Pct: round(pct(maxHigh(10))),
    closeD1Pct: round(pct(closeAt(1))),
    closeD3Pct: round(pct(closeAt(3))),
    closeD5Pct: round(pct(closeAt(5))),
    hit5:  firstHit5  != null,
    hit10: firstHit10 != null,
    hit15: firstHit15 != null,
    hit20: firstHit20 != null,
    breach5:  firstBreach5  != null,
    breach10: firstBreach10 != null,
    firstHit5BeforeBreach5:   firstHit5  != null && (firstBreach5  == null || firstHit5  < firstBreach5),
    firstHit10BeforeBreach5:  firstHit10 != null && (firstBreach5  == null || firstHit10 < firstBreach5),
    firstHit10BeforeBreach10: firstHit10 != null && (firstBreach10 == null || firstHit10 < firstBreach10),
    maxDrawdownD5:  round(pct(minLow(5))),
    maxDrawdownD10: round(pct(minLow(10))),
    nextRowsAvailable: nextRows.length,
  };
}

// ── 통계 ──
function aggStats(events) {
  if (!events.length) return { n: 0 };
  const num = (k) => events.map(e => e.perf?.[k]).filter(v => v != null && Number.isFinite(v));
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const rate = (k) => events.length ? (events.filter(e => e.perf?.[k]).length / events.length) * 100 : null;

  return {
    n: events.length,
    avgSameDayHigh:  round(avg(num('sameDayHighAfterSignalPct'))),
    avgSameDayClose: round(avg(num('sameDayClosePct'))),
    avgMaxHighD1:  round(avg(num('maxHighD1Pct'))),
    avgMaxHighD3:  round(avg(num('maxHighD3Pct'))),
    avgMaxHighD5:  round(avg(num('maxHighD5Pct'))),
    avgMaxHighD10: round(avg(num('maxHighD10Pct'))),
    hit5Rate:  round(rate('hit5')),
    hit10Rate: round(rate('hit10')),
    hit15Rate: round(rate('hit15')),
    hit20Rate: round(rate('hit20')),
    breach5Rate:  round(rate('breach5')),
    breach10Rate: round(rate('breach10')),
    firstHit5BeforeBreach5Rate:   round(rate('firstHit5BeforeBreach5')),
    firstHit10BeforeBreach5Rate:  round(rate('firstHit10BeforeBreach5')),
    firstHit10BeforeBreach10Rate: round(rate('firstHit10BeforeBreach10')),
    avgMaxDrawdownD5:    round(avg(num('maxDrawdownD5'))),
    medianMaxHighD5:     round(median(num('maxHighD5Pct'))),
    medianMaxDrawdownD5: round(median(num('maxDrawdownD5'))),
  };
}

// ── 메인 ──
async function main() {
  console.log(`🔍 QVA 장중 감시 백테스트 — days=${DAYS} lookback=${LOOKBACK_QVA} times=${SIGNAL_TIMES.join(',')}`);

  const metaMap = loadMetaMap();
  const allSig = await loadAllQvaSignals();
  console.log(`  DB seed: ${allSig.length}건`);

  // 가용 거래일: chart sample (005930)의 마지막 DAYS 거래일 + 1
  // (마지막 거래일은 cutoffDate로 쓰지 않을 수도 있음 — 사후 D+1 데이터가 없으면 성과 계산 불가)
  const sampleChart = loadChart('005930');
  if (!sampleChart) { console.error('샘플 차트 (005930) 없음'); process.exit(1); }
  const sampleRows = sampleChart.rows;
  const cutoffDates = [];  // {ymd, dash, sampleIdx}
  // 최근 거래일부터 거꾸로 — D+1 데이터가 있는 것까지만
  for (let i = sampleRows.length - 2; i >= 0 && cutoffDates.length < DAYS; i--) {
    const r = sampleRows[i];
    if (!r || !r.date) continue;
    cutoffDates.push({ ymd: r.date, dash: ymdDash(r.date), sampleIdx: i });
  }
  cutoffDates.reverse();  // 오래된 → 최근 순
  console.log(`  cutoffDate 범위: ${cutoffDates[0]?.dash} ~ ${cutoffDates[cutoffDates.length-1]?.dash} (${cutoffDates.length}거래일)`);

  // signal_date → set으로 lookup
  // 후보 추출: 각 cutoffDate별로 lookback 거래일 안 가장 최근 신호
  const events = [];
  const skipReasons = { no_intraday: 0, intraday_empty: 0, no_chart: 0, no_qva_idx: 0, no_snap: 0, no_prev_close: 0, no_grade: 0, same_day_or_future: 0 };
  let hvmRecord = null;

  for (const c of cutoffDates) {
    // lookback-qva 거래일 컷오프
    const lookbackIdx = Math.max(0, c.sampleIdx - LOOKBACK_QVA);
    const lookbackYmd = sampleRows[lookbackIdx]?.date;
    if (!lookbackYmd) continue;
    const cutoffYmd = c.ymd;

    // dedup: code → 가장 최근 QVA seed (cutoffYmd 이전 + lookback 안)
    const byCode = new Map();
    for (const sig of allSig) {
      const sigYmd = dashToYmd(sig.date);
      if (sigYmd >= cutoffYmd) continue;       // cutoff 시점에 안 보이는 신호 제외
      if (sigYmd < lookbackYmd) continue;       // lookback 밖 제외
      const cur = byCode.get(sig.code);
      const types = cur ? new Set(cur.qvaTypeAll) : new Set();
      types.add(sig.type);
      if (!cur || sig.date > cur.qvaDate) {
        byCode.set(sig.code, { qvaDate: sig.date, qvaType: sig.type, qvaTypeAll: [...types] });
      } else {
        cur.qvaTypeAll = [...types];
      }
    }
    for (const v of byCode.values()) if (v.qvaTypeAll.length >= 2) v.qvaType = 'BOTH';

    // 각 후보 × signalTime
    for (const [code, seed] of byCode) {
      const meta = metaMap.get(code) || {};
      const chart = loadChart(code);
      if (!chart || !Array.isArray(chart.rows)) { skipReasons.no_chart++; continue; }
      const rows = chart.rows;
      const qvaIdx = chart._idxByDate.get(dashToYmd(seed.qvaDate));
      if (qvaIdx == null) { skipReasons.no_qva_idx++; continue; }
      const cutoffIdx = chart._idxByDate.get(cutoffYmd);
      if (cutoffIdx == null) continue;
      const daysFromQva = cutoffIdx - qvaIdx;
      if (daysFromQva <= 0) { skipReasons.same_day_or_future++; continue; }

      const prevRow = rows[cutoffIdx - 1];
      const prevClose = prevRow ? prevRow.close : null;
      if (!prevClose) { skipReasons.no_prev_close++; continue; }

      const qvaRow = rows[qvaIdx];
      const qvaInfo = {
        qvaDate: seed.qvaDate, qvaType: seed.qvaType, qvaTypeAll: seed.qvaTypeAll,
        qvaHigh: qvaRow.high, qvaClose: qvaRow.close,
        qvaVolume: qvaRow.volume,
        qvaValue: qvaRow.valueApprox || qvaRow.close * qvaRow.volume,
        daysFromQva,
      };

      // 20일 평균 (cutoff 이전 20거래일)
      let sumV = 0, sumQ = 0, n = 0;
      for (let i = cutoffIdx - 20; i < cutoffIdx; i++) {
        const r = rows[i];
        if (r && r.volume > 0) { sumV += (r.valueApprox || 0); sumQ += r.volume; n++; }
      }
      const avg20Value  = n > 0 ? sumV / n : 0;
      const avg20Volume = n > 0 ? sumQ / n : 0;

      const bars = loadIntradayBars(c.dash, code);
      if (!bars) { skipReasons.no_intraday++; continue; }
      if (bars.length === 0) { skipReasons.intraday_empty++; continue; }

      for (const sigTime of SIGNAL_TIMES) {
        const aggr = aggregateBarsUntil(bars, sigTime);
        if (!aggr) continue;
        const snap = {
          mode: 'intraday', lastBarTime: aggr.lastBarTime,
          open: aggr.open, high: aggr.high, low: aggr.low, current: aggr.current,
          volume: aggr.volume, valueAmount: aggr.valueAmount,
          prevClose, avg20Value, avg20Volume,
        };
        const ev = evaluateLiveWatch(snap, qvaInfo);
        if (!ev.liveGrade) { skipReasons.no_grade++; continue; }
        const perf = computePostPerformance(rows, cutoffIdx, snap.current, snap.high);
        const event = {
          code, name: meta.name || chart.name || code,
          cutoffDate: c.dash, signalTime: sigTime,
          qvaDate: seed.qvaDate, qvaType: seed.qvaType, qvaTypeAll: seed.qvaTypeAll,
          daysFromQva,
          snapshotPrice: snap.current, snapshotHigh: snap.high, snapshotLow: snap.low,
          snapshotValue: snap.valueAmount,
          liveGrade: ev.liveGrade, liveWatchScore: ev.liveWatchScore,
          extraTags: ev.extraTags,
          tagsBool: ev.tags,
          gapPct: ev.gapPct, changeRate: ev.changeRate,
          currentPositionInDayRange: ev.currentPositionInDayRange,
          upperTailRatio: ev.upperTailRatio,
          valueRatio20: ev.valueRatio20,
          timeAdjustedValueRatio20: ev.timeAdjustedValueRatio20,
          valueToQvaRatio: ev.valueToQvaRatio,
          timeAdjustedValueToQvaRatio: ev.timeAdjustedValueToQvaRatio,
          qvaHighBreak: ev.tags.QVA_HIGH_BREAK,
          riskFlags: { overheat: ev.overheat, risky: ev.risky },
          perf,
        };
        events.push(event);
        if (code === HVM_CODE && c.dash === '2026-05-18' && sigTime === '10:00') hvmRecord = event;
      }
    }
  }

  console.log(`  이벤트 수: ${events.length}`);
  console.log(`  스킵: ${JSON.stringify(skipReasons)}`);

  // ── 통계 ──
  const byGrade = {};
  for (const g of ['LIVE_A','LIVE_B','LIVE_C','WAIT','RISK']) byGrade[g] = aggStats(events.filter(e => e.liveGrade === g));
  const bySignalTime = {};
  for (const t of SIGNAL_TIMES) bySignalTime[t] = aggStats(events.filter(e => e.signalTime === t));
  const byQvaType = {};
  for (const tp of ['QVA1','QVA2','BOTH']) byQvaType[tp] = aggStats(events.filter(e => e.qvaType === tp));
  const byDaysFromQva = {};
  const dayBuckets = [['D+1',(d)=>d===1], ['D+2~D+3',(d)=>d>=2&&d<=3], ['D+4~D+5',(d)=>d>=4&&d<=5], ['D+6~D+10',(d)=>d>=6&&d<=10], ['D+11~D+20',(d)=>d>=11&&d<=20]];
  for (const [name, fn] of dayBuckets) byDaysFromQva[name] = aggStats(events.filter(e => fn(e.daysFromQva)));
  const byTag = {};
  const tagKeys = ['STRONG_GAP_UP','GAP_UP','VALUE_WAKE','STRONG_VALUE_WAKE','QVA_HIGH_BREAK','HOLDING_HIGH_ZONE','STRONG_MOMENTUM','LIMIT_UP_LIKE','EARLY_REACTION','OVERHEAT_CAUTION','GAP_FAIL_CAUTION','UPPER_TAIL_CAUTION'];
  for (const k of tagKeys) byTag[k] = aggStats(events.filter(e => (e.extraTags || []).includes(k) || e.tagsBool?.[k]));
  const byCombo = {
    'LIVE_A + QVA_HIGH_BREAK':     aggStats(events.filter(e => e.liveGrade === 'LIVE_A' && e.tagsBool?.QVA_HIGH_BREAK)),
    'LIVE_A + VALUE_WAKE':         aggStats(events.filter(e => e.liveGrade === 'LIVE_A' && e.tagsBool?.VALUE_WAKE)),
    'LIVE_A + STRONG_GAP_UP':      aggStats(events.filter(e => e.liveGrade === 'LIVE_A' && e.tagsBool?.STRONG_GAP_UP)),
    'LIVE_A + EARLY_REACTION':     aggStats(events.filter(e => e.liveGrade === 'LIVE_A' && e.tagsBool?.EARLY_REACTION)),
    'LIVE_A + D+1~D+5':            aggStats(events.filter(e => e.liveGrade === 'LIVE_A' && e.daysFromQva <= 5)),
    'LIVE_B + QVA_HIGH_BREAK':     aggStats(events.filter(e => e.liveGrade === 'LIVE_B' && e.tagsBool?.QVA_HIGH_BREAK)),
    'RISK + GAP_FAIL_CAUTION':     aggStats(events.filter(e => e.liveGrade === 'RISK' && (e.extraTags||[]).includes('GAP_FAIL_CAUTION'))),
  };

  // ── 운영 판단 ──
  const A = byGrade.LIVE_A;
  const B = byGrade.LIVE_B;
  const R = byGrade.RISK;
  const checks = {
    'LIVE_A n>=50':                 (A.n || 0) >= 50,
    'LIVE_A hit10Rate>=45':         (A.hit10Rate || 0) >= 45,
    'LIVE_A hit15Rate>=30':         (A.hit15Rate || 0) >= 30,
    'LIVE_A breach5Rate<=45':       (A.breach5Rate ?? 100) <= 45,
    'LIVE_A firstHit10BeforeBreach5Rate>=35': (A.firstHit10BeforeBreach5Rate || 0) >= 35,
    'LIVE_A hit10>LIVE_B hit10':    (A.hit10Rate || 0) > (B.hit10Rate || 0),
    'LIVE_A hit15>LIVE_B hit15':    (A.hit15Rate || 0) > (B.hit15Rate || 0),
    'LIVE_A maxHighD5>RISK maxHighD5': (A.avgMaxHighD5 || 0) > (R.avgMaxHighD5 || -999),
  };
  const passCount = Object.values(checks).filter(v => v).length;
  const totalChecks = Object.keys(checks).length;
  let decision;
  if (A.n < MIN_SAMPLE) decision = 'NEED_TUNING';
  else if (passCount === totalChecks) decision = 'OPERATE_READY';
  else if (passCount >= 6) decision = 'WATCH_ONLY';
  else if (passCount >= 4) decision = 'NEED_TUNING';
  else decision = 'REJECT';
  const decisionLabel = {
    OPERATE_READY: '운영 보드화 가능',
    WATCH_ONLY:    '관찰 보드로는 가능, 진입 판단용 아님',
    NEED_TUNING:   '조건 튜닝 필요',
    REJECT:        '운영화 부적합',
  }[decision];

  // ── 성공/실패 예시 ──
  const liveA = events.filter(e => e.liveGrade === 'LIVE_A');
  const liveASuccess = [...liveA].sort((a,b)=>(b.perf?.maxHighD5Pct||0)-(a.perf?.maxHighD5Pct||0)).slice(0, 20);
  const liveAFail = [...liveA].sort((a,b)=>(a.perf?.sameDayClosePct||0)-(b.perf?.sameDayClosePct||0)).slice(0, 20);

  // ── 요약 ──
  const summary = {
    totalEvents: events.length,
    daysRange: { from: cutoffDates[0]?.dash, to: cutoffDates[cutoffDates.length-1]?.dash, count: cutoffDates.length },
    byGradeCount: {
      LIVE_A: byGrade.LIVE_A.n, LIVE_B: byGrade.LIVE_B.n, LIVE_C: byGrade.LIVE_C.n,
      WAIT: byGrade.WAIT.n, RISK: byGrade.RISK.n,
    },
    liveA: {
      n: A.n, hit10Rate: A.hit10Rate, hit15Rate: A.hit15Rate, hit20Rate: A.hit20Rate,
      breach5Rate: A.breach5Rate, breach10Rate: A.breach10Rate,
      avgMaxHighD5: A.avgMaxHighD5, firstHit10BeforeBreach5Rate: A.firstHit10BeforeBreach5Rate,
    },
    skipReasons,
  };

  const operationDecision = { decision, decisionLabel, checks, passCount, totalChecks, minSample: MIN_SAMPLE };

  // ── HVM check ──
  // 메인 백테스트 cutoff 범위가 D+1 사후 데이터 보장을 위해 가장 최근 거래일을 제외하므로,
  // 2026-05-18 같은 최신 cutoff는 메인 events에 없을 수 있다. 별도 1회 시뮬레이션으로 재현.
  if (!hvmRecord) {
    try {
      const dash = '2026-05-18', code = HVM_CODE, sigTime = '10:00';
      const chart = loadChart(code);
      const cutoffIdx = chart && chart._idxByDate.get(dashToYmd(dash));
      const lookbackIdx = Math.max(0, cutoffIdx - LOOKBACK_QVA);
      const lookbackYmd = chart.rows[lookbackIdx]?.date;
      let bestSeed = null;
      for (const sig of allSig) {
        if (sig.code !== code) continue;
        const sigYmd = dashToYmd(sig.date);
        if (sigYmd >= dash.replace(/-/g,'')) continue;
        if (sigYmd < lookbackYmd) continue;
        if (!bestSeed || sig.date > bestSeed.qvaDate) bestSeed = { qvaDate: sig.date, qvaType: sig.type, qvaTypeAll: [sig.type] };
      }
      const bars = loadIntradayBars(dash, code);
      if (bestSeed && bars && cutoffIdx != null) {
        const qvaIdx = chart._idxByDate.get(dashToYmd(bestSeed.qvaDate));
        const daysFromQva = cutoffIdx - qvaIdx;
        const prevClose = chart.rows[cutoffIdx - 1]?.close;
        const qvaRow = chart.rows[qvaIdx];
        const qvaInfo = {
          qvaDate: bestSeed.qvaDate, qvaType: bestSeed.qvaType, qvaTypeAll: bestSeed.qvaTypeAll,
          qvaHigh: qvaRow.high, qvaClose: qvaRow.close, qvaVolume: qvaRow.volume,
          qvaValue: qvaRow.valueApprox || qvaRow.close * qvaRow.volume,
          daysFromQva,
        };
        let sumV = 0, sumQ = 0, n = 0;
        for (let i = cutoffIdx - 20; i < cutoffIdx; i++) {
          const r = chart.rows[i];
          if (r && r.volume > 0) { sumV += (r.valueApprox || 0); sumQ += r.volume; n++; }
        }
        const aggr = aggregateBarsUntil(bars, sigTime);
        if (aggr && prevClose) {
          const snap = {
            mode: 'intraday', lastBarTime: aggr.lastBarTime,
            open: aggr.open, high: aggr.high, low: aggr.low, current: aggr.current,
            volume: aggr.volume, valueAmount: aggr.valueAmount,
            prevClose, avg20Value: n > 0 ? sumV / n : 0, avg20Volume: n > 0 ? sumQ / n : 0,
          };
          const ev = evaluateLiveWatch(snap, qvaInfo);
          const perf = computePostPerformance(chart.rows, cutoffIdx, snap.current, snap.high);
          hvmRecord = {
            code, name: '에이치브이엠',
            cutoffDate: dash, signalTime: sigTime,
            qvaDate: bestSeed.qvaDate, qvaType: bestSeed.qvaType, daysFromQva,
            snapshotPrice: snap.current, snapshotHigh: snap.high, snapshotLow: snap.low,
            snapshotValue: snap.valueAmount,
            liveGrade: ev.liveGrade, liveWatchScore: ev.liveWatchScore,
            extraTags: ev.extraTags, tagsBool: ev.tags,
            gapPct: ev.gapPct, changeRate: ev.changeRate,
            currentPositionInDayRange: ev.currentPositionInDayRange,
            upperTailRatio: ev.upperTailRatio,
            valueRatio20: ev.valueRatio20, timeAdjustedValueRatio20: ev.timeAdjustedValueRatio20,
            valueToQvaRatio: ev.valueToQvaRatio, timeAdjustedValueToQvaRatio: ev.timeAdjustedValueToQvaRatio,
            qvaHighBreak: ev.tags.QVA_HIGH_BREAK,
            riskFlags: { overheat: ev.overheat, risky: ev.risky },
            perf, _separateSim: true,
          };
        }
      }
    } catch (_) {}
  }
  const hvmCheck = {
    cutoffDate: '2026-05-18', signalTime: '10:00', code: HVM_CODE,
    found: !!hvmRecord, event: hvmRecord || null,
    note: hvmRecord?._separateSim ? '메인 cutoff 범위(최신 D+1 데이터 보장) 밖이라 별도 시뮬레이션' : null,
  };

  const out = {
    generatedAt: new Date().toISOString(),
    days: DAYS, lookbackQva: LOOKBACK_QVA, signalTimes: SIGNAL_TIMES, minSample: MIN_SAMPLE,
    summary, operationDecision,
    stats: { byGrade, bySignalTime, byQvaType, byDaysFromQva, byTag, byCombo },
    examples: { liveASuccess, liveAFail, hvmCheck },
    eventsCount: events.length,
    // events 자체는 크기 클 수 있어 JSON엔 sample만 (성공/실패는 examples에 들어감)
    eventsSample: events.slice(0, 200),
    notes: [
      '이 보고서는 백테스트입니다. 매수 신호 검증이 아니라 QVA 장중 감시 등급 변별력 검증입니다.',
      '분봉 데이터가 있는 거래일/종목만 대상 (intraday 모드).',
      'sameDayHighAfterSignal은 일봉 high를 보조 추정값으로 사용 — 분봉 잔여 시간대까지의 high를 정확히 측정하기는 어려움.',
      'firstHitNBeforeBreachM은 일별 단위 — 같은 날 hit/breach가 동시 발생 시 hit 우선.',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), 'utf-8');
  fs.writeFileSync(OUT_HTML, renderHtml(out, events), 'utf-8');

  // ── 콘솔 ──
  console.log(`\n📋 결과 요약`);
  console.log(`  기간: ${summary.daysRange.from} ~ ${summary.daysRange.to} (${summary.daysRange.count}거래일)`);
  console.log(`  전체 이벤트:                ${summary.totalEvents}건`);
  console.log(`  LIVE_A:                     ${summary.byGradeCount.LIVE_A}건`);
  console.log(`  LIVE_B:                     ${summary.byGradeCount.LIVE_B}건`);
  console.log(`  LIVE_C:                     ${summary.byGradeCount.LIVE_C}건`);
  console.log(`  WAIT:                       ${summary.byGradeCount.WAIT}건`);
  console.log(`  RISK:                       ${summary.byGradeCount.RISK}건`);
  console.log(`  LIVE_A hit10Rate:           ${summary.liveA.hit10Rate}%`);
  console.log(`  LIVE_A hit15Rate:           ${summary.liveA.hit15Rate}%`);
  console.log(`  LIVE_A hit20Rate:           ${summary.liveA.hit20Rate}%`);
  console.log(`  LIVE_A breach5Rate:         ${summary.liveA.breach5Rate}%`);
  console.log(`  LIVE_A breach10Rate:        ${summary.liveA.breach10Rate}%`);
  console.log(`  LIVE_A avgMaxHighD5:        ${summary.liveA.avgMaxHighD5}%`);
  console.log(`  LIVE_A firstHit10beforeBreach5: ${summary.liveA.firstHit10BeforeBreach5Rate}%`);
  console.log(`  HVM 재현(2026-05-18 10:00): ${hvmCheck.found ? '✅ LIVE_'+(hvmRecord.liveGrade.replace('LIVE_','')) +' score='+hvmRecord.liveWatchScore : '❌'}`);
  if (hvmRecord) {
    console.log(`    maxHighD5=${hvmRecord.perf.maxHighD5Pct}% sameDayHigh=${hvmRecord.perf.sameDayHighAfterSignalPct}%`);
  }
  console.log(`  운영 판단:                  ${decision} (${decisionLabel}) — ${passCount}/${totalChecks}`);
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);

  try { const { closePool } = require('../../src/db/mysql'); await closePool(); } catch (_) {}
}

// ── HTML ──
function safe(v) { if (v == null) return '-'; return String(v).replace(/[<>&"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch])); }
function statRow(name, s) {
  if (!s || !s.n) return `<tr><td>${safe(name)}</td><td colspan="14" style="color:#888">n=0</td></tr>`;
  return `<tr>
    <td>${safe(name)}</td>
    <td>${safe(s.n)}</td>
    <td>${safe(s.avgMaxHighD1)}%</td>
    <td>${safe(s.avgMaxHighD3)}%</td>
    <td>${safe(s.avgMaxHighD5)}%</td>
    <td>${safe(s.avgMaxHighD10)}%</td>
    <td>${safe(s.avgSameDayClose)}%</td>
    <td>${safe(s.hit5Rate)}%</td>
    <td>${safe(s.hit10Rate)}%</td>
    <td>${safe(s.hit15Rate)}%</td>
    <td>${safe(s.hit20Rate)}%</td>
    <td>${safe(s.breach5Rate)}%</td>
    <td>${safe(s.breach10Rate)}%</td>
    <td>${safe(s.firstHit10BeforeBreach5Rate)}%</td>
    <td>${safe(s.avgMaxDrawdownD5)}%</td>
  </tr>`;
}
function statTable(title, obj) {
  const rows = Object.entries(obj).map(([k, v]) => statRow(k, v)).join('\n');
  return `<h3>${safe(title)}</h3>
  <table>
    <thead><tr>
      <th>그룹</th><th>n</th><th>avgD1↑</th><th>avgD3↑</th><th>avgD5↑</th><th>avgD10↑</th><th>avgClose</th>
      <th>hit5%</th><th>hit10%</th><th>hit15%</th><th>hit20%</th><th>brch5%</th><th>brch10%</th>
      <th>hit10&lt;brch5%</th><th>avgDD5</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
function exampleRow(e) {
  return `<tr>
    <td>${safe(e.cutoffDate)} ${safe(e.signalTime)}</td>
    <td>${safe(e.code)}</td>
    <td>${safe(e.name)}</td>
    <td>${safe(e.liveGrade)}</td>
    <td>${safe(e.liveWatchScore)}</td>
    <td>${safe(e.gapPct)}%</td>
    <td>${safe(e.changeRate)}%</td>
    <td>D+${safe(e.daysFromQva)}</td>
    <td>${safe(e.perf?.maxHighD5Pct)}%</td>
    <td>${safe(e.perf?.sameDayClosePct)}%</td>
    <td>${safe(e.perf?.breach5)}/${safe(e.perf?.breach10)}</td>
    <td>${(e.extraTags||[]).slice(0,4).join(', ')}</td>
  </tr>`;
}
function renderHtml(data, allEvents) {
  const s = data.summary, op = data.operationDecision;
  const checkRows = Object.entries(op.checks).map(([k,v]) => `<tr><td>${safe(k)}</td><td>${v?'<span class="ok">✅</span>':'<span class="fail">❌</span>'}</td></tr>`).join('');
  const exTbl = (arr, title) => `<h3>${safe(title)} (${arr.length}건)</h3>
    <table><thead><tr><th>cutoff @time</th><th>code</th><th>name</th><th>grade</th><th>score</th><th>gap</th><th>chg</th><th>D+N</th><th>maxHighD5</th><th>closeDay</th><th>brch5/10</th><th>tags</th></tr></thead>
    <tbody>${arr.map(exampleRow).join('')}</tbody></table>`;

  const hvm = data.examples.hvmCheck;
  const hvmBlock = hvm.found
    ? `<div class="card"><b>2026-05-18 10:00</b> · ${safe(hvm.event.code)} ${safe(hvm.event.name)} · <b>${safe(hvm.event.liveGrade)} (score ${safe(hvm.event.liveWatchScore)})</b><br>
       gap=${safe(hvm.event.gapPct)}% change=${safe(hvm.event.changeRate)}% closePos=${safe(hvm.event.currentPositionInDayRange)} v/avg20=${safe(hvm.event.valueRatio20)}→${safe(hvm.event.timeAdjustedValueRatio20)} (adj)<br>
       성과 — sameDayHigh ${safe(hvm.event.perf.sameDayHighAfterSignalPct)}% / sameDayClose ${safe(hvm.event.perf.sameDayClosePct)}% / D+5 max ${safe(hvm.event.perf.maxHighD5Pct)}%</div>`
    : `<div class="card">에이치브이엠 2026-05-18 10:00 이벤트가 생성되지 않음 (분봉 또는 데이터 누락)</div>`;

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/><title>QVA 장중 감시 백테스트</title>
<style>
  body { font-family:'Segoe UI','Malgun Gothic',Arial,sans-serif; background:#f6f8fa; color:#1f2328; margin:0; padding:24px; }
  h1 { margin:0 0 4px; font-size:24px; }
  h2 { margin:24px 0 8px; font-size:18px; border-bottom:2px solid #d0d7de; padding-bottom:4px; }
  h3 { margin:18px 0 6px; font-size:14px; }
  .meta { color:#57606a; font-size:13px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; background:#fff; font-size:11px; margin-top:6px; }
  th, td { border:1px solid #d0d7de; padding:5px 7px; text-align:left; vertical-align:top; }
  th { background:#eaeef2; }
  tr:nth-child(even) td { background:#fafbfc; }
  .summary { background:#fff; border:1px solid #d0d7de; border-radius:8px; padding:16px; display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  .summary .item { background:#f6f8fa; padding:10px; border-radius:6px; }
  .summary .lbl { color:#57606a; font-size:12px; }
  .summary .val { font-size:18px; font-weight:700; }
  .decision { padding:12px; border-radius:8px; margin-top:12px; font-weight:700; }
  .decision.OPERATE_READY { background:#d6f5d6; color:#0a6900; }
  .decision.WATCH_ONLY    { background:#fff5cc; color:#7a5a00; }
  .decision.NEED_TUNING   { background:#ffd9b3; color:#7a4500; }
  .decision.REJECT        { background:#f0d0d0; color:#7a3030; }
  .ok { color:#0a6900; font-weight:700; } .fail { color:#a40000; font-weight:700; }
  .card { background:#fff; border:1px solid #d0d7de; padding:12px; border-radius:8px; margin:8px 0; font-size:13px; line-height:1.5; }
  .notes { background:#fff3cd; border:1px solid #f0c14b; border-radius:8px; padding:12px; margin-top:16px; font-size:13px; }
</style></head>
<body>
<h1>QVA 장중 감시 백테스트</h1>
<div class="meta">생성 ${safe(data.generatedAt)} · 기간 ${safe(s.daysRange.from)} ~ ${safe(s.daysRange.to)} (${safe(s.daysRange.count)}거래일) · signalTimes ${safe(data.signalTimes.join(','))}</div>

<h2>섹션 1 — 요약 & 운영 판단</h2>
<div class="summary">
  <div class="item"><div class="lbl">전체 이벤트</div><div class="val">${s.totalEvents}</div></div>
  <div class="item"><div class="lbl">LIVE_A</div><div class="val">${s.byGradeCount.LIVE_A}</div></div>
  <div class="item"><div class="lbl">LIVE_B</div><div class="val">${s.byGradeCount.LIVE_B}</div></div>
  <div class="item"><div class="lbl">LIVE_C</div><div class="val">${s.byGradeCount.LIVE_C}</div></div>
  <div class="item"><div class="lbl">WAIT</div><div class="val">${s.byGradeCount.WAIT}</div></div>
  <div class="item"><div class="lbl">RISK</div><div class="val">${s.byGradeCount.RISK}</div></div>
  <div class="item"><div class="lbl">LIVE_A hit10</div><div class="val">${safe(s.liveA.hit10Rate)}%</div></div>
  <div class="item"><div class="lbl">LIVE_A hit15</div><div class="val">${safe(s.liveA.hit15Rate)}%</div></div>
  <div class="item"><div class="lbl">LIVE_A hit20</div><div class="val">${safe(s.liveA.hit20Rate)}%</div></div>
  <div class="item"><div class="lbl">LIVE_A brch5</div><div class="val">${safe(s.liveA.breach5Rate)}%</div></div>
  <div class="item"><div class="lbl">LIVE_A brch10</div><div class="val">${safe(s.liveA.breach10Rate)}%</div></div>
  <div class="item"><div class="lbl">LIVE_A avgD5↑</div><div class="val">${safe(s.liveA.avgMaxHighD5)}%</div></div>
</div>

<div class="decision ${op.decision}">운영 판단: ${safe(op.decision)} — ${safe(op.decisionLabel)} (${op.passCount}/${op.totalChecks} 통과, minSample=${op.minSample})</div>
<table style="margin-top:8px">
  <thead><tr><th>판단 기준</th><th>통과</th></tr></thead>
  <tbody>${checkRows}</tbody>
</table>

<h2>섹션 2 — liveGrade별 성과표</h2>
${statTable('liveGrade', data.stats.byGrade)}

<h2>섹션 3 — 시점별 성과표</h2>
${statTable('signalTime', data.stats.bySignalTime)}

<h2>섹션 4 — QVA 경과일별 성과표</h2>
${statTable('daysFromQva', data.stats.byDaysFromQva)}

<h2>섹션 5 — 태그 조합별 성과표</h2>
${statTable('tag', data.stats.byTag)}
${statTable('combo', data.stats.byCombo)}
${statTable('qvaType', data.stats.byQvaType)}

<h2>섹션 6 — LIVE_A 성공 사례 (maxHighD5 상위 20)</h2>
${exTbl(data.examples.liveASuccess, 'liveASuccess')}

<h2>섹션 7 — LIVE_A 실패 사례 (sameDayClose 하위 20)</h2>
${exTbl(data.examples.liveAFail, 'liveAFail')}

<h2>섹션 8 — RISK 그룹 성과</h2>
${statTable('RISK 단독', { RISK: data.stats.byGrade.RISK })}

<h2>섹션 9 — 에이치브이엠 재현 확인</h2>
${hvmBlock}

<h2>섹션 10 — 결론</h2>
<div class="card">
  <b>운영 판단:</b> ${safe(op.decisionLabel)} (${safe(op.decision)})<br>
  <b>통과 체크:</b> ${op.passCount}/${op.totalChecks}<br>
  <b>추천 운영 방식:</b> ${
    op.decision === 'OPERATE_READY'
      ? 'LIVE_A 등급 우선 노출 + cron 등록 검토 가능. 운영화 진행 가능 수준.'
      : op.decision === 'WATCH_ONLY'
      ? '관찰 화면으로만 운영. LIVE_A를 진입 판단용으로 쓰진 않음.'
      : op.decision === 'NEED_TUNING'
      ? 'LIVE_A 임계값 / 시간 보정 가중치 / 태그 조건 추가 점검 필요.'
      : '현재 신호로는 운영화 부적합. 더 많은 데이터/태그 조합 검토 필요.'
  }<br>
  <b>주의점:</b> 분봉 수신이 cron에 의존하므로 09:00~10:00 외 시점은 실 운영 데이터 보강 필요.
  <br>sameDay 잔여 high는 일봉 high로 추정 — 분봉 전체 시간대 누적이 들어와야 정확.
</div>

<div class="notes">${data.notes.map(n => '<div>· ' + safe(n) + '</div>').join('')}</div>
</body></html>`;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
