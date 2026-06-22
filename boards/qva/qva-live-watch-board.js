// QVA 장중 감시 보드.
// 최근 QVA/QVA2 후보들을 "오늘" 또는 가장 최근 거래일 1일에 한해 장중 움직임을 감시한다.
// 사후 분석(qva-followup-reaction-board)이 아니라 "지금 움직이는지" 확인용.
// 1DS / QVA / VVI 본체 무수정. 라우터/cron 추가 없음.
//
// 입력:
//   - DB board_signals: 최근 lookback 거래일 QVA1/QVA2 신호
//   - cache/stock-charts-long/{code}.json: 일봉 (prevClose 및 일봉 fallback용)
//   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json: 분봉 (있으면 우선)
//
// 산출:
//   reports/qva-live-watch-board-result.json
//   reports/qva-live-watch-board-result.html

'use strict';

const fs = require('fs');
const path = require('path');
const { getBoardNavHtml } = require('../../src/utils/boardNav');
const { isKrHoliday } = require('../../screeners/pattern-screener');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR    = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_DIR = path.join(ROOT, 'data', 'intraday', '1ds');
const NAVER_LIST   = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const OUT_JSON     = path.join(ROOT, 'reports', 'qva-live-watch-board-result.json');
const OUT_HTML     = path.join(ROOT, 'reports', 'qva-live-watch-board-result.html');

const LOOKBACK_DAYS = 20;
const HVM_CODE = '295310';
const STALE_DAYS = 7;     // chart latest와 watchDate가 N일 이상 떨어진 후보는 제외 (거래정지 추정)

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
function calendarDaysBetween(ymdA, ymdB) {
  if (!ymdA || !ymdB) return Infinity;
  const a = new Date(`${ymdA.slice(0,4)}-${ymdA.slice(4,6)}-${ymdA.slice(6,8)}`).getTime();
  const b = new Date(`${ymdB.slice(0,4)}-${ymdB.slice(4,6)}-${ymdB.slice(6,8)}`).getTime();
  return Math.abs(a - b) / (1000 * 86400);
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
function loadChart(code) {
  const p = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}
function loadIntraday(dirYmdDash, code) {
  const p = path.join(INTRADAY_DIR, dirYmdDash, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}

// ── DB lookup ──
async function loadQvaSeed() {
  const { query } = require('../../src/db/mysql');
  const qvaRows = await query(`
    SELECT board_name, signal_kind, signal_date, stock_code
    FROM board_signals
    WHERE signal_date >= DATE_SUB(CURDATE(), INTERVAL 45 DAY)
      AND (
        (board_name = 'QVA_WATCHLIST'  AND signal_kind = 'QVA_NEW') OR
        (board_name = 'QVA2_WATCHLIST' AND signal_kind = 'QVA2_NEW')
      )
    ORDER BY signal_date DESC
  `);
  return qvaRows;
}

// ── watchDate 결정 ──
// 우선순위: (1) intraday 디렉토리 중 가장 최근 ymdDash (2) chart 다수 일봉의 latest
function decideWatchDate(metaMap) {
  let intradayLatest = null;
  if (fs.existsSync(INTRADAY_DIR)) {
    const dirs = fs.readdirSync(INTRADAY_DIR)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isKrHoliday(d.replace(/-/g, '')))
      .sort();
    if (dirs.length) intradayLatest = dirs[dirs.length - 1];
  }
  // chart 최신 baseDate (sample 5종목으로 추정)
  const sampleCodes = [...metaMap.keys()].slice(0, 5);
  const baseDateFreq = new Map();
  for (const code of sampleCodes) {
    const c = loadChart(code);
    if (!c || !Array.isArray(c.rows) || c.rows.length === 0) continue;
    const last = c.rows[c.rows.length - 1];
    if (last && last.date) baseDateFreq.set(last.date, (baseDateFreq.get(last.date) || 0) + 1);
  }
  let chartLatest = null, maxFreq = 0;
  for (const [d, n] of baseDateFreq) { if (n > maxFreq) { maxFreq = n; chartLatest = d; } }
  const chartLatestDash = chartLatest ? ymdDash(chartLatest) : null;
  // 두 후보 중 더 최근
  if (intradayLatest && chartLatestDash) {
    return intradayLatest >= chartLatestDash ? intradayLatest : chartLatestDash;
  }
  return intradayLatest || chartLatestDash;
}

// ── watchDate row 추출 (분봉 우선, 일봉 fallback) ──
function buildWatchSnapshot(code, chart, watchDateYmd, watchDateDash) {
  const rows = (chart && chart.rows) || [];
  if (rows.length === 0) return null;

  // 분봉 시도
  const intraday = loadIntraday(watchDateDash, code);
  // 일봉 row of watchDate (없으면 직전 일봉)
  let dailyIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === watchDateYmd) { dailyIdx = i; break; }
  }
  // 일봉 row가 없으면 가장 최근 row로 fallback
  if (dailyIdx < 0) dailyIdx = rows.length - 1;
  const dayRow = rows[dailyIdx];

  // prevClose는 dailyIdx 직전 거래일의 close
  const prevRow = dailyIdx - 1 >= 0 ? rows[dailyIdx - 1] : null;
  const prevClose = prevRow?.close || null;

  let mode, open, high, low, current, volume, valueAmount, lastBarTime;
  if (intraday && Array.isArray(intraday.bars) && intraday.bars.length > 0) {
    mode = 'intraday';
    const bars = intraday.bars;
    open = bars[0].open;
    high = Math.max(...bars.map(b => b.high || 0));
    low  = Math.min(...bars.map(b => b.low || Infinity));
    current = bars[bars.length - 1].close;
    volume = bars.reduce((s, b) => s + (b.volume || 0), 0);
    valueAmount = bars.reduce((s, b) => s + (b.value || 0), 0);
    lastBarTime = bars[bars.length - 1].time || null;
  } else {
    mode = 'dailySnapshot';
    open = dayRow.open; high = dayRow.high; low = dayRow.low; current = dayRow.close;
    volume = dayRow.volume; valueAmount = dayRow.valueApprox || dayRow.close * dayRow.volume;
    lastBarTime = null;
  }

  // 20일 평균 (watchDate 직전 20거래일 — dailyIdx 이전 데이터로)
  let sumV = 0, sumQ = 0, n = 0;
  for (let i = dailyIdx - 20; i < dailyIdx; i++) {
    const r = rows[i];
    if (r && r.volume > 0) {
      sumV += (r.valueApprox || 0);
      sumQ += (r.volume || 0);
      n++;
    }
  }
  const avg20Value = n > 0 ? sumV / n : 0;
  const avg20Volume = n > 0 ? sumQ / n : 0;

  return {
    mode, lastBarTime,
    open, high, low, current, volume, valueAmount,
    prevClose,
    avg20Value, avg20Volume,
    dailyIdx,
    chartLatestDate: rows[rows.length - 1]?.date,
  };
}

// ── 분봉 시간 보정 ──
// 09:10 이하 2.5, 09:30 이하 2.2, 10:00 이하 2.0, 10:30 이하 1.7,
// 11:00 이하 1.5, 13:00 이하 1.25, 14:00 이하 1.1, 그 외 1.0
function getIntradayTimeWeight(lastBarTime) {
  if (!lastBarTime) return 1.0;
  const parts = String(lastBarTime).split(':');
  const hh = parseInt(parts[0], 10);
  const mm = parseInt(parts[1] || '0', 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 1.0;
  const m = hh * 60 + mm;
  if (m <= 9 * 60 + 10)  return 2.5;
  if (m <= 9 * 60 + 30)  return 2.2;
  if (m <= 10 * 60 + 0)  return 2.0;
  if (m <= 10 * 60 + 30) return 1.7;
  if (m <= 11 * 60 + 0)  return 1.5;
  if (m <= 13 * 60 + 0)  return 1.25;
  if (m <= 14 * 60 + 0)  return 1.1;
  return 1.0;
}
function timeBucketLabel(lastBarTime) {
  if (!lastBarTime) return 'full_day';
  const parts = String(lastBarTime).split(':');
  const hh = parseInt(parts[0], 10);
  const mm = parseInt(parts[1] || '0', 10);
  const m = hh * 60 + mm;
  if (m <= 9 * 60 + 10)  return 'lt_0910';
  if (m <= 9 * 60 + 30)  return 'lt_0930';
  if (m <= 10 * 60 + 0)  return 'lt_1000';
  if (m <= 10 * 60 + 30) return 'lt_1030';
  if (m <= 11 * 60 + 0)  return 'lt_1100';
  if (m <= 13 * 60 + 0)  return 'lt_1300';
  if (m <= 14 * 60 + 0)  return 'lt_1400';
  return 'lt_1530';
}
function capMul(x, cap = 10) {
  if (x == null || !Number.isFinite(x)) return null;
  return x > cap ? cap : x;
}

// ── 분석 + 점수 + 등급 ──
function evaluateLiveWatch(snap, qva) {
  // 기본 메트릭
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
  const isAboveQvaHigh = qva.qvaHigh > 0 && snap.current >= qva.qvaHigh;
  const isNearQvaHigh  = qva.qvaHigh > 0 && snap.current >= qva.qvaHigh * 0.98;

  // QVA 이후 누적 (과열 가드)
  const cumReturnFromQvaClose = qva.qvaClose > 0 ? (snap.current / qva.qvaClose - 1) * 100 : null;

  // ── intraday 시간 보정 ──
  const isIntraday = snap.mode === 'intraday';
  const intradayTimeWeight = isIntraday ? getIntradayTimeWeight(snap.lastBarTime) : 1.0;
  const intradayTimeBucket = isIntraday ? timeBucketLabel(snap.lastBarTime) : 'full_day';
  const timeAdjustedValueRatio20    = isIntraday && valueRatio20    != null ? capMul(valueRatio20    * intradayTimeWeight) : (valueRatio20    ?? null);
  const timeAdjustedVolumeRatio20   = isIntraday && volumeRatio20   != null ? capMul(volumeRatio20   * intradayTimeWeight) : (volumeRatio20   ?? null);
  const timeAdjustedValueToQvaRatio = isIntraday && valueToQvaRatio != null ? capMul(valueToQvaRatio * intradayTimeWeight) : (valueToQvaRatio ?? null);
  const timeAdjustedVolumeToQvaRatio= isIntraday && volumeToQvaRatio!= null ? capMul(volumeToQvaRatio* intradayTimeWeight) : (volumeToQvaRatio?? null);

  // 태그 — raw 기준 (시간보정 전)
  const tRaw = {};
  tRaw.VALUE_WAKE        = (valueRatio20 ?? 0) >= 2 || (valueToQvaRatio ?? 0) >= 0.8;
  tRaw.STRONG_VALUE_WAKE = (valueRatio20 ?? 0) >= 4 || (valueToQvaRatio ?? 0) >= 1.5;

  // 태그 — 보정 포함 (intraday만 보정값 OR 추가)
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

  // J. EARLY_REACTION — D+1~D+5 + 위 조건 2개 이상 충족
  const baseTagCount = ['GAP_UP','STRONG_GAP_UP','VALUE_WAKE','STRONG_VALUE_WAKE',
    'QVA_HIGH_APPROACH','QVA_HIGH_BREAK','HOLDING_HIGH_ZONE','STRONG_MOMENTUM','LIMIT_UP_LIKE']
    .filter(k => t[k]).length;
  t.EARLY_REACTION = qva.daysFromQva >= 1 && qva.daysFromQva <= 5 && baseTagCount >= 2;

  // 점수
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
  if (qva.qvaType === 'QVA2' || qva.qvaTypeAll?.includes('QVA2')) score += 5;

  // 감점
  let penalty = 0;
  if ((upperTailRatio ?? 0) >= 0.60) penalty -= 15;
  if ((currentPositionInDayRange ?? 1) < 0.40) penalty -= 15;
  if ((gapPct ?? 0) >= 10 && (currentPositionInDayRange ?? 1) < 0.50) penalty -= 15;
  if ((changeRate ?? 0) >= 20 && (upperTailRatio ?? 0) >= 0.40) penalty -= 10;
  let overheat = false;
  if ((cumReturnFromQvaClose ?? 0) >= 40) { penalty -= 10; overheat = true; }

  const liveWatchScore = Math.max(0, Math.min(100, score + penalty));

  // 위험 태그 (현재 봉)
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

  const liveGradeLabel = {
    LIVE_A: '지금 강하게 움직임',
    LIVE_B: '움직일 기세',
    LIVE_C: '예열',
    WAIT:   '대기',
    RISK:   '추격 주의',
  }[liveGrade] || null;

  // 표시 태그
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

  // ── raw 기준 grade 시뮬레이션 (보정 없음일 때 어떤 등급이었는지) ──
  let rawScore = 0;
  if (t.STRONG_GAP_UP)         rawScore += 15;
  else if (t.GAP_UP)           rawScore += 8;
  if (tRaw.STRONG_VALUE_WAKE)  rawScore += 20;
  else if (tRaw.VALUE_WAKE)    rawScore += 12;
  if (t.QVA_HIGH_BREAK)        rawScore += 15;
  else if (t.QVA_HIGH_APPROACH) rawScore += 10;
  if (t.HOLDING_HIGH_ZONE)     rawScore += 12;
  if (t.STRONG_MOMENTUM)       rawScore += 15;
  if (t.LIMIT_UP_LIKE)         rawScore += 20;
  if (qva.daysFromQva <= 3)    rawScore += 8;
  else if (qva.daysFromQva <= 5) rawScore += 5;
  if (qva.qvaType === 'QVA2' || qva.qvaTypeAll?.includes('QVA2')) rawScore += 5;
  rawScore = Math.max(0, Math.min(100, rawScore + penalty));
  let rawGrade;
  if (rawScore >= 70)      rawGrade = 'LIVE_A';
  else if (rawScore >= 50) rawGrade = 'LIVE_B';
  else if (rawScore >= 35) rawGrade = 'LIVE_C';
  else if (rawScore >= 20) rawGrade = 'WAIT';
  else                     rawGrade = baseTagCount > 0 ? 'WAIT' : null;
  if (risky && rawScore < 70) rawGrade = 'RISK';

  // 보정으로 새로 켜진 태그 (raw로는 false → 보정으로 true)
  const valueWakeAddedByTimeAdj        = !tRaw.VALUE_WAKE        && t.VALUE_WAKE;
  const strongValueWakeAddedByTimeAdj  = !tRaw.STRONG_VALUE_WAKE && t.STRONG_VALUE_WAKE;
  const promotedByTimeAdj              = isIntraday && rawGrade !== liveGrade
                                        && (liveGrade === 'LIVE_A' || liveGrade === 'LIVE_B');
  const promotedToLiveAByTimeAdj       = isIntraday && rawGrade !== 'LIVE_A' && liveGrade === 'LIVE_A';

  return {
    gapPct: round(gapPct),
    changeRate: round(changeRate),
    openToCurrentPct: round(openToCurrentPct),
    currentPositionInDayRange: round(currentPositionInDayRange, 3),
    upperTailRatio: round(upperTailRatio, 3),
    valueRatio20: round(valueRatio20),
    volumeRatio20: round(volumeRatio20),
    valueToQvaRatio: round(valueToQvaRatio),
    volumeToQvaRatio: round(volumeToQvaRatio),
    // intraday 시간 보정
    intradayTimeWeight,
    intradayTimeBucket,
    timeAdjustedValueRatio20:    round(timeAdjustedValueRatio20),
    timeAdjustedVolumeRatio20:   round(timeAdjustedVolumeRatio20),
    timeAdjustedValueToQvaRatio: round(timeAdjustedValueToQvaRatio),
    timeAdjustedVolumeToQvaRatio:round(timeAdjustedVolumeToQvaRatio),
    valueWakeAddedByTimeAdj, strongValueWakeAddedByTimeAdj,
    promotedByTimeAdj, promotedToLiveAByTimeAdj,
    rawScore, rawGrade,
    highToQvaHighPct: round(highToQvaHighPct),
    currentToQvaHighPct: round(currentToQvaHighPct),
    isAboveQvaHigh,
    isNearQvaHigh,
    cumReturnFromQvaClose: round(cumReturnFromQvaClose),
    tags: t,
    rawTags: tRaw,
    extraTags,
    liveWatchScore,
    scoreRaw: score,
    penalty,
    liveGrade,
    liveGradeLabel,
    overheat,
    risky,
  };
}

function buildHeadline(snap, qva, ev) {
  const dN = `D+${qva.daysFromQva}`;
  if (ev.tags.LIMIT_UP_LIKE && ev.overheat) return `상한가 근접 흐름이지만 QVA 이후 이미 많이 올라 추격 주의가 필요해요.`;
  if (ev.tags.LIMIT_UP_LIKE) return `${dN} 장중에 상한가 근접 흐름이 나오고 있어요.`;
  if (ev.tags.STRONG_GAP_UP && ev.tags.QVA_HIGH_BREAK) return `${dN}에 큰 갭 상승으로 출발했고 QVA 고가를 장중 돌파했어요.`;
  if (ev.tags.STRONG_GAP_UP && ev.tags.HOLDING_HIGH_ZONE) return `${dN}에 큰 갭으로 출발해 현재 고가권을 유지 중이에요.`;
  if (ev.tags.QVA_HIGH_BREAK && ev.tags.STRONG_VALUE_WAKE) return `거래대금이 강하게 깨어나며 QVA 고가를 돌파했어요.`;
  if (ev.tags.QVA_HIGH_BREAK) return `${dN} 장중 QVA 고가를 돌파했어요.`;
  if (ev.tags.QVA_HIGH_APPROACH) return `${dN} 장중 QVA 고가 근처까지 올라왔어요.`;
  if (ev.tags.STRONG_VALUE_WAKE) return `거래대금이 QVA일 이후 다시 강하게 깨어나는 모습이에요.`;
  if (ev.tags.VALUE_WAKE) return `거래대금이 살아나고 있어요.`;
  if (ev.tags.STRONG_MOMENTUM) return `${dN} 장중에 강한 상승 흐름이 이어지고 있어요.`;
  if (ev.tags.GAP_UP && ev.tags.HOLDING_HIGH_ZONE) return `${dN}에 갭 상승 후 현재 고가권을 유지하고 있어요.`;
  if (ev.tags.HOLDING_HIGH_ZONE) return `현재 고가권을 유지하며 흐름이 살아있어요.`;
  if (ev.risky) return `거래대금은 있지만 위꼬리/약한 종가권으로 추격 주의가 필요해요.`;
  return `${dN} 장중 관찰 중.`;
}

// ── 메인 ──
async function main() {
  console.log('🔍 QVA 장중 감시 보드 생성\n');

  const metaMap = loadMetaMap();
  const qvaSeed = await loadQvaSeed();
  console.log(`  DB seed: QVA_NEW + QVA2_NEW ${qvaSeed.length}건`);

  // dedup: code별 가장 최근 QVA 신호. 같은 종목에 QVA1/QVA2 다 있으면 BOTH 표시.
  const byCode = new Map();
  for (const r of qvaSeed) {
    const code = r.stock_code;
    const date = ymdDash(r.signal_date);
    const type = r.board_name === 'QVA2_WATCHLIST' ? 'QVA2' : 'QVA1';
    const cur = byCode.get(code);
    const types = cur ? new Set(cur.qvaTypeAll) : new Set();
    types.add(type);
    if (!cur || date > cur.qvaDate) {
      byCode.set(code, { code, qvaDate: date, qvaType: type, qvaTypeAll: [...types] });
    } else {
      cur.qvaTypeAll = [...types];
    }
  }
  // BOTH 라벨링
  for (const v of byCode.values()) {
    if (v.qvaTypeAll.length >= 2) v.qvaType = 'BOTH';
  }
  console.log(`  종목 dedup: ${byCode.size}건 (가장 최근 QVA 기준)`);

  // watchDate 결정
  const watchDateDash = decideWatchDate(metaMap);
  const watchDateYmd = dashToYmd(watchDateDash);
  console.log(`  watchDate: ${watchDateDash} (분봉 디렉토리 또는 chart latest 중 더 최근)`);

  // 거래일 lookback 컷오프
  const sampleChart = loadChart('005930');
  let cutoffYmd = null;
  if (sampleChart) {
    const rows = sampleChart.rows;
    const idx = rows.findIndex(r => r.date === watchDateYmd);
    const baseIdx = idx >= 0 ? idx : rows.length - 1;
    const cutIdx = Math.max(0, baseIdx - LOOKBACK_DAYS);
    cutoffYmd = rows[cutIdx]?.date || null;
  }
  console.log(`  lookback 컷오프 (${LOOKBACK_DAYS}거래일): ${cutoffYmd}\n`);

  const candidates = [];
  const skipReasons = { chart_missing: 0, qva_idx_missing: 0, stale: 0, snap_fail: 0, no_grade: 0, no_prev_close: 0 };
  let intradayCount = 0, dailyCount = 0;

  for (const [code, seed] of byCode) {
    const qvaYmd = dashToYmd(seed.qvaDate);
    if (cutoffYmd && qvaYmd < cutoffYmd) continue;

    const meta = metaMap.get(code) || {};
    const chart = loadChart(code);
    if (!chart || !Array.isArray(chart.rows)) { skipReasons.chart_missing++; continue; }
    const rows = chart.rows;
    // chart latest와 watchDate 거리 체크 (stale 가드)
    const chartLatest = rows[rows.length - 1]?.date;
    if (chartLatest && watchDateYmd && calendarDaysBetween(chartLatest, watchDateYmd) > STALE_DAYS) {
      skipReasons.stale++; continue;
    }
    // QVA row 찾기
    const qvaIdx = rows.findIndex(r => r.date === qvaYmd);
    if (qvaIdx < 0) { skipReasons.qva_idx_missing++; continue; }
    const qvaRow = rows[qvaIdx];
    const qvaInfo = {
      qvaDate: seed.qvaDate, qvaType: seed.qvaType, qvaTypeAll: seed.qvaTypeAll,
      qvaOpen: qvaRow.open, qvaHigh: qvaRow.high, qvaLow: qvaRow.low, qvaClose: qvaRow.close,
      qvaVolume: qvaRow.volume,
      qvaValue: qvaRow.valueApprox || qvaRow.close * qvaRow.volume,
    };

    // watchDate 스냅샷
    const snap = buildWatchSnapshot(code, chart, watchDateYmd, watchDateDash);
    if (!snap) { skipReasons.snap_fail++; continue; }
    if (!snap.prevClose) { skipReasons.no_prev_close++; continue; }

    // daysFromQva = qvaIdx → snap.dailyIdx
    const daysFromQva = snap.dailyIdx - qvaIdx;
    if (daysFromQva <= 0) continue;  // 같은 날 또는 미래 데이터는 제외

    if (snap.mode === 'intraday') intradayCount++; else dailyCount++;

    const qva = { ...qvaInfo, daysFromQva };
    const ev = evaluateLiveWatch(snap, qva);
    if (!ev.liveGrade) { skipReasons.no_grade++; continue; }

    const card = {
      code,
      name: meta.name || chart.name || code,
      market: meta.market || chart.market || '',
      marketCap: meta.marketCap || 0,
      ...qvaInfo,
      daysFromQva,
      watchDate: watchDateDash,
      snapshot: {
        mode: snap.mode,
        lastBarTime: snap.lastBarTime,
        open: snap.open, high: snap.high, low: snap.low, current: snap.current,
        volume: snap.volume, valueAmount: snap.valueAmount, prevClose: snap.prevClose,
      },
      live: ev,
      headline: buildHeadline(snap, qva, ev),
    };
    candidates.push(card);
  }

  candidates.sort((a, b) => b.live.liveWatchScore - a.live.liveWatchScore);

  const grouped = {
    LIVE_A: [], LIVE_B: [], LIVE_C: [], WAIT: [], RISK: [],
    GAP_UP: [], VALUE_WAKE: [], QVA_HIGH_BREAK: [], LIMIT_UP_LIKE: [],
  };
  for (const c of candidates) {
    if (grouped[c.live.liveGrade]) grouped[c.live.liveGrade].push(c);
    if (c.live.tags.GAP_UP)         grouped.GAP_UP.push(c);
    if (c.live.tags.VALUE_WAKE)     grouped.VALUE_WAKE.push(c);
    if (c.live.tags.QVA_HIGH_BREAK) grouped.QVA_HIGH_BREAK.push(c);
    if (c.live.tags.LIMIT_UP_LIKE)  grouped.LIMIT_UP_LIKE.push(c);
  }

  // 보정 통계
  const timeAdjAppliedCount       = candidates.filter(c => c.snapshot.mode === 'intraday').length;
  const valueWakeByTimeAdjCount   = candidates.filter(c => c.live.valueWakeAddedByTimeAdj).length;
  const strongVWakeByTimeAdjCount = candidates.filter(c => c.live.strongValueWakeAddedByTimeAdj).length;
  const promotedByTimeAdjCount    = candidates.filter(c => c.live.promotedByTimeAdj).length;
  const promotedToLiveAByTimeAdjCount = candidates.filter(c => c.live.promotedToLiveAByTimeAdj).length;

  const summary = {
    qvaSeedCount: byCode.size,
    candidatesCount: candidates.length,
    LIVE_A: grouped.LIVE_A.length,
    LIVE_B: grouped.LIVE_B.length,
    LIVE_C: grouped.LIVE_C.length,
    WAIT:   grouped.WAIT.length,
    RISK:   grouped.RISK.length,
    QVA_HIGH_BREAK:     grouped.QVA_HIGH_BREAK.length,
    STRONG_VALUE_WAKE:  candidates.filter(c => c.live.tags.STRONG_VALUE_WAKE).length,
    VALUE_WAKE:         grouped.VALUE_WAKE.length,
    LIMIT_UP_LIKE:      grouped.LIMIT_UP_LIKE.length,
    intradayMode:       intradayCount,
    dailySnapshotMode:  dailyCount,
    // intraday 시간 보정 통계
    timeAdjAppliedCount,
    valueWakeByTimeAdjCount,
    strongVWakeByTimeAdjCount,
    promotedByTimeAdjCount,
    promotedToLiveAByTimeAdjCount,
    skipReasons,
  };

  const mode = intradayCount > dailyCount ? 'intraday' : 'dailySnapshot';

  // 에이치브이엠 확인
  const hvm = candidates.find(c => c.code === HVM_CODE);
  const hvmCheck = { found: !!hvm, candidate: hvm || null };

  // 분봉 모드 후보 중 가장 늦은 lastBarTime — “어디까지의 분봉으로 비교됐나” 표시용
  let latestIntradayBarTime = null;
  for (const c of candidates) {
    if (c.snapshot && c.snapshot.mode === 'intraday' && c.snapshot.lastBarTime) {
      if (!latestIntradayBarTime || c.snapshot.lastBarTime > latestIntradayBarTime) {
        latestIntradayBarTime = c.snapshot.lastBarTime;
      }
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    watchDate: watchDateDash,
    lookbackDays: LOOKBACK_DAYS,
    mode,
    latestIntradayBarTime,         // 분봉 모드 후보 중 가장 늦은 분봉 시각 (= 비교 기준 시점)
    intradayCount, dailyCount,     // 모드별 후보 수
    nextCronTimes: ['09:35', '12:30', '15:30'],  // QVA 장중 감시 갱신 cron
    summary,
    candidates,
    grouped,
    hvmCheck,
    notes: [
      '이 보드는 매수 신호가 아닙니다. QVA 후보의 당일 움직임을 감시합니다.',
      'VVI 확정 신호가 아니라 QVA 이후 “움직이기 시작한 조짐”을 보여주는 화면입니다.',
      'intraday 모드: 분봉 데이터 기준 / dailySnapshot 모드: 일봉 기준 (장 마감 후 또는 분봉 미수신).',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), 'utf-8');
  fs.writeFileSync(OUT_HTML, renderHtml(out), 'utf-8');

  // ── 콘솔 ──
  console.log('📋 결과 요약');
  console.log(`  watchDate / mode:                       ${watchDateDash} / ${mode} (intraday ${intradayCount} / daily ${dailyCount})`);
  console.log(`  전체 QVA 감시 후보 (lookback ${LOOKBACK_DAYS}거래일):  ${summary.qvaSeedCount}건`);
  console.log(`  분석 통과 후보:                          ${summary.candidatesCount}건`);
  console.log(`  LIVE_A (지금 강하게 움직임):             ${summary.LIVE_A}건`);
  console.log(`  LIVE_B (움직일 기세):                    ${summary.LIVE_B}건`);
  console.log(`  LIVE_C (예열):                           ${summary.LIVE_C}건`);
  console.log(`  WAIT  (대기):                            ${summary.WAIT}건`);
  console.log(`  RISK  (추격 주의):                       ${summary.RISK}건`);
  console.log(`  QVA_HIGH_BREAK:                          ${summary.QVA_HIGH_BREAK}건`);
  console.log(`  STRONG_VALUE_WAKE:                       ${summary.STRONG_VALUE_WAKE}건`);
  console.log(`  LIMIT_UP_LIKE:                           ${summary.LIMIT_UP_LIKE}건`);
  console.log(`  intraday 보정 적용:                      ${summary.timeAdjAppliedCount}건`);
  console.log(`  보정으로 VALUE_WAKE 신규:                ${summary.valueWakeByTimeAdjCount}건 (STRONG ${summary.strongVWakeByTimeAdjCount}건)`);
  console.log(`  보정으로 상위 등급 승격:                  ${summary.promotedByTimeAdjCount}건 (LIVE_A 승격 ${summary.promotedToLiveAByTimeAdjCount}건)`);
  console.log(`  스킵: ${JSON.stringify(skipReasons)}`);
  console.log(`  에이치브이엠(${HVM_CODE}) 포함:          ${hvmCheck.found ? '✅' : '❌'}`);
  if (hvm) {
    const e = hvm.live;
    console.log(`    qvaDate=${hvm.qvaDate} watchDate=${hvm.watchDate} D+${hvm.daysFromQva} mode=${hvm.snapshot.mode} lastBar=${hvm.snapshot.lastBarTime}`);
    console.log(`    grade=${e.liveGrade}(${e.liveGradeLabel}) score=${e.liveWatchScore}  (raw grade=${e.rawGrade} score=${e.rawScore})`);
    console.log(`    changeRate=${e.changeRate}% gapPct=${e.gapPct}% closePos=${e.currentPositionInDayRange}`);
    console.log(`    valueRatio20=${e.valueRatio20} × weight ${e.intradayTimeWeight} = adj ${e.timeAdjustedValueRatio20}`);
    console.log(`    valueToQvaRatio=${e.valueToQvaRatio} × weight = adj ${e.timeAdjustedValueToQvaRatio}`);
    console.log(`    tags=${e.extraTags.join(',')}`);
    if (e.valueWakeAddedByTimeAdj || e.promotedByTimeAdj) {
      console.log(`    ※ 시간 보정으로 VALUE_WAKE/등급이 활성화됨`);
    }
  }
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);

  try { const { closePool } = require('../../src/db/mysql'); await closePool(); } catch (_) {}
}

// ── HTML ──
function safe(v) {
  if (v == null) return '-';
  return String(v).replace(/[<>&"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch]));
}
function fmtMoney(v) {
  if (!v || !Number.isFinite(v)) return '-';
  if (v >= 1e12) return (v / 1e12).toFixed(2) + '조';
  if (v >= 1e8)  return Math.round(v / 1e8) + '억';
  if (v >= 1e4)  return Math.round(v / 1e4) + '만';
  return String(v);
}
function gradeBadge(g) {
  const cls = g === 'LIVE_A' ? 'a' : g === 'LIVE_B' ? 'b' : g === 'LIVE_C' ? 'c' : g === 'RISK' ? 'r' : 'w';
  const lbl = { LIVE_A:'지금 강하게 움직임', LIVE_B:'움직일 기세', LIVE_C:'예열', WAIT:'대기', RISK:'추격 주의' }[g] || g;
  return `<span class="grade ${cls}">${lbl}</span>`;
}
function renderCard(c) {
  const e = c.live;
  const tagsHtml = (e.extraTags || []).map(t => `<span class="tag">${safe(t)}</span>`).join(' ');
  const qvaRel = e.currentToQvaHighPct != null
    ? (e.currentToQvaHighPct >= 0 ? `+${e.currentToQvaHighPct}%` : `${e.currentToQvaHighPct}%`) : '-';
  return `
  <div class="card">
    <div class="card-head">
      <div class="name"><a href="/qva-live-watch/${safe(c.code)}" class="name-link" title="상세 페이지로 이동" target="_blank" rel="noopener">${safe(c.name)}</a> <span class="code">${safe(c.code)}</span></div>
      <div class="meta">QVA ${safe(c.qvaDate)} (${safe(c.qvaType)}) → 감시 ${safe(c.watchDate)} <span class="dN">D+${safe(c.daysFromQva)}</span>
        <span class="data-mode-badge ${c.snapshot.mode === 'intraday' ? 'intraday' : 'daily'}">${c.snapshot.mode === 'intraday' ? '📊 분봉' : '📅 일봉'}</span>${c.snapshot.lastBarTime ? '<span class="data-mode-badge lastbar">~' + safe(c.snapshot.lastBarTime) + '</span>' : ''}</div>
    </div>
    <div class="card-row">
      ${gradeBadge(e.liveGrade)}
      <span class="score">score ${safe(e.liveWatchScore)}</span>
      ${tagsHtml}
    </div>
    <div class="card-grid">
      <div><span class="lbl">gap</span> ${safe(e.gapPct)}%</div>
      <div><span class="lbl">change</span> ${safe(e.changeRate)}%</div>
      <div><span class="lbl">currentPos</span> ${safe(e.currentPositionInDayRange)}</div>
      ${c.snapshot.mode === 'intraday'
        ? `<div><span class="lbl">v/avg20 (raw→adj ×${safe(e.intradayTimeWeight)})</span> ${safe(e.valueRatio20)}× → <b>${safe(e.timeAdjustedValueRatio20)}×</b></div>
           <div><span class="lbl">v/qva (raw→adj)</span> ${safe(e.valueToQvaRatio)}× → <b>${safe(e.timeAdjustedValueToQvaRatio)}×</b></div>`
        : `<div><span class="lbl">v/avg20</span> ${safe(e.valueRatio20)}×</div>
           <div><span class="lbl">v/qva</span> ${safe(e.valueToQvaRatio)}×</div>`}
      <div><span class="lbl">QVA高 대비</span> ${qvaRel}</div>
      <div><span class="lbl">현재가</span> ${safe(c.snapshot.current)}원${c.snapshot.lastBarTime ? ' @'+safe(c.snapshot.lastBarTime) : ''}</div>
      <div><span class="lbl">시총</span> ${fmtMoney(c.marketCap)}</div>
    </div>
    <div class="headline">${safe(c.headline)}</div>
  </div>`;
}
function renderHtml(data) {
  const cards = (arr, max) => (arr || []).slice(0, max).map(renderCard).join('\n');
  const s = data.summary;
  const hvmBlock = data.hvmCheck.found
    ? renderCard(data.hvmCheck.candidate)
    : `<p>에이치브이엠(${HVM_CODE})은 이 보드에 포함되지 않았어요.</p>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>QVA 장중 감시 보드</title>
<style>
  body { font-family:'Segoe UI','Malgun Gothic',Arial,sans-serif; background:#0f172a; color:#cbd5e1; margin:0; padding:24px; }
  h1 { margin:0 0 4px; font-size:24px; color:#f1f5f9; }
  h1 span { color:#94a3b8 !important; }
  h2 { margin:24px 0 8px; font-size:16px; color:#5eead4; border-left:3px solid #14b8a6; border-bottom:none; padding-left:8px; }
  a { color:#7dd3fc; }
  .meta { color:#94a3b8; font-size:13px; margin-bottom:8px; }
  .intro { background:#1e293b; border:1px solid #334155; border-left:3px solid #14b8a6; border-radius:6px; padding:12px 14px; margin-bottom:16px; font-size:13px; line-height:1.55; color:#cbd5e1; }
  .intro b { color:#fde68a; }
  .summary { background:#1e293b; border:1px solid #334155; border-radius:8px; padding:14px; display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
  .summary .item { background:#0f172a; border:1px solid #334155; padding:10px; border-radius:6px; }
  .summary .lbl { color:#94a3b8; font-size:11px; text-transform:uppercase; letter-spacing:0.2px; }
  .summary .val { font-size:20px; font-weight:700; color:#f1f5f9; margin-top:2px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(360px, 1fr)); gap:10px; }
  .card { background:#1e293b; border:1px solid #334155; border-radius:6px; padding:11px; color:#cbd5e1; }
  .card-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px; gap:8px; }
  .card-head .name { font-size:14px; font-weight:700; color:#f1f5f9; }
  .card-head .name-link { color:#f1f5f9; text-decoration:none; border-bottom:1px dotted #475569; }
  .card-head .name-link:hover { color:#7dd3fc; border-bottom-color:#7dd3fc; }
  .card-head .code { font-size:11px; color:#94a3b8; }
  .card-head .meta { font-size:11px; color:#94a3b8; margin-bottom:0; text-align:right; }
  .dN { color:#7dd3fc; font-weight:600; }
  .card-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:8px; }
  .grade { padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; }
  .grade.a { background:#064e3b; color:#a7f3d0; border:1px solid #10b981; }
  .grade.b { background:#1e3a8a; color:#bfdbfe; border:1px solid #3b82f6; }
  .grade.c { background:#713f12; color:#fde68a; border:1px solid #d97706; }
  .grade.w { background:#334155; color:#cbd5e1; border:1px solid #64748b; }
  .grade.r { background:#7f1d1d; color:#fecaca; border:1px solid #ef4444; }
  .score { font-size:11px; color:#94a3b8; }
  .tag { background:#0f172a; color:#7dd3fc; border:1px solid #334155; font-size:10px; padding:1px 6px; border-radius:8px; }
  .card-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; font-size:11px; margin:6px 0; }
  .card-grid .lbl { color:#94a3b8; }
  .card-grid b { color:#fde68a; }
  .headline { font-size:12px; color:#cbd5e1; background:#0f172a; border:1px solid #334155; padding:8px 10px; border-radius:6px; line-height:1.5; }
  details { margin-top:12px; background:#1e293b; border:1px solid #334155; border-radius:6px; padding:6px 10px; }
  details > summary { cursor:pointer; padding:4px 0; font-weight:600; color:#7dd3fc; font-size:13px; }
  details > summary:hover { color:#a5f3fc; }
  details .cards { margin-top:8px; }
  .notes { background:#1e293b; border:1px solid #f59e0b; border-left:3px solid #f59e0b; border-radius:6px; padding:10px 12px; margin-top:16px; font-size:12px; color:#fde68a; line-height:1.6; }

  /* 신선도 banner — 언제 갱신됐고 어떻게 비교됐는지 */
  .freshness-banner {
    background: linear-gradient(135deg, #042f2e 0%, #1e293b 100%);
    border: 1px solid #14b8a6; border-left: 4px solid #14b8a6;
    border-radius: 8px; padding: 14px 18px; margin: 10px 0 16px;
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px;
  }
  .freshness-banner .fb-cell { display: flex; flex-direction: column; gap: 3px; }
  .freshness-banner .fb-lbl { font-size: 10.5px; color: #5eead4; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .freshness-banner .fb-val { font-size: 14px; color: #e2e8f0; font-weight: 700; font-variant-numeric: tabular-nums; }
  .freshness-banner .fb-sub { font-size: 10.5px; color: #94a3b8; }
  .freshness-banner .fb-age-fresh   { color: #5eead4; }
  .freshness-banner .fb-age-medium  { color: #fcd34d; }
  .freshness-banner .fb-age-stale   { color: #fca5a5; }

  /* 데이터 비교 방식 박스 */
  .compare-info {
    background: rgba(167,139,250,0.08); border-left: 3px solid #a78bfa;
    border-radius: 6px; padding: 10px 14px; margin-bottom: 14px;
    font-size: 12px; line-height: 1.7; color: #e9d5ff;
  }
  .compare-info strong { color: #c4b5fd; }
  .compare-info .mode-pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; margin: 0 2px; }
  .compare-info .mode-intraday { background: #042f2e; color: #5eead4; border: 1px solid #14b8a6; }
  .compare-info .mode-daily    { background: #422006; color: #fcd34d; border: 1px solid #f59e0b; }

  /* 카드 내 mode/lastBar 배지 강화 */
  .meta .data-mode-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; margin-left: 4px; }
  .meta .data-mode-badge.intraday { background: #042f2e; color: #5eead4; border: 1px solid #14b8a6; }
  .meta .data-mode-badge.daily    { background: #422006; color: #fcd34d; border: 1px solid #f59e0b; }
  .meta .data-mode-badge.lastbar  { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; margin-left: 3px; }
</style>
</head>
<body>
${getBoardNavHtml('/qva-live-watch')}

<h1>⚡ QVA 장중 감시 보드 <span style="font-size:12px;color:#6c757d;font-weight:400;">— 관찰용 (매수/진입 신호 아님)</span></h1>

${(function() {
  // freshness banner — 언제 갱신됐는지 + 어디까지의 분봉으로 비교됐는지 + 다음 갱신 시각
  const genDateObj = new Date(data.generatedAt);
  const genKstStr = genDateObj.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  // 경과시간 (분 단위)
  const ageMin = Math.max(0, Math.floor((Date.now() - genDateObj.getTime()) / 60000));
  let ageText, ageCls;
  if (ageMin < 30) { ageText = ageMin + '분 전'; ageCls = 'fb-age-fresh'; }
  else if (ageMin < 120) { ageText = ageMin + '분 전'; ageCls = 'fb-age-medium'; }
  else if (ageMin < 60 * 24) { ageText = Math.floor(ageMin / 60) + '시간 ' + (ageMin % 60) + '분 전'; ageCls = 'fb-age-stale'; }
  else { ageText = Math.floor(ageMin / 60 / 24) + '일 전'; ageCls = 'fb-age-stale'; }
  // 다음 cron 시각 — KST 기준 현재 시각 이후의 가장 가까운 cron
  const nowKstStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  const nowKstHm = nowKstStr.slice(11, 16);  // "HH:MM"
  const crons = data.nextCronTimes || ['09:35', '12:30', '15:30'];
  let nextCron = '내일 09:35';
  for (const t of crons) { if (t > nowKstHm) { nextCron = '오늘 ' + t + ' KST'; break; } }
  const latestBar = data.latestIntradayBarTime;
  // 분봉 윈도우 안내
  let barRangeText = '—';
  if (latestBar) {
    barRangeText = '09:00 ~ ' + latestBar;
  } else if (data.intradayCount === 0) {
    barRangeText = '분봉 없음 (일봉 fallback)';
  }
  return '<div class="freshness-banner">' +
    '<div class="fb-cell"><div class="fb-lbl">🕐 마지막 갱신</div><div class="fb-val">' + safe(genKstStr) + '</div><div class="fb-sub ' + ageCls + '">' + safe(ageText) + '</div></div>' +
    '<div class="fb-cell"><div class="fb-lbl">📅 감시 기준일</div><div class="fb-val">' + safe(data.watchDate) + '</div><div class="fb-sub">lookback ' + safe(data.lookbackDays) + '거래일</div></div>' +
    '<div class="fb-cell"><div class="fb-lbl">📊 분봉 비교 범위</div><div class="fb-val">' + safe(barRangeText) + '</div><div class="fb-sub">' + (data.intradayCount || 0) + '종 intraday / ' + (data.dailyCount || 0) + '종 일봉 fallback</div></div>' +
    '<div class="fb-cell"><div class="fb-lbl">🔄 다음 자동 갱신</div><div class="fb-val">' + safe(nextCron) + '</div><div class="fb-sub">평일 09:35 / 12:30 / 15:30 cron</div></div>' +
  '</div>';
})()}

<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:4px 0 14px;">
  <button type="button" id="qvaLiveWatchRefreshBtn" onclick="refreshQvaLiveWatchNow()"
    title="지금 시각까지의 분봉을 KIS에서 다시 받아 QVA 장중 감시 보드를 재생성합니다 (약 2~3분)."
    style="background:#16a34a;color:#fff;border:none;border-radius:7px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;">
    📡 지금 분봉 다시 받아 갱신
  </button>
  <span id="qvaLiveWatchRefreshStatus" style="font-size:12px;color:#94a3b8;"></span>
</div>

<div class="compare-info">
  <strong>📐 어떻게 비교됐나:</strong>
  각 종목별로 <strong>최근 QVA/QVA2 발생일</strong>의 가격·거래대금을 기준으로 <strong>오늘(${safe(data.watchDate)})</strong>의 가격·거래대금을 비교합니다.
  <span class="mode-pill mode-intraday">intraday</span> 표시는 <strong>09:00 ~ ${safe(data.latestIntradayBarTime || '진행중')}</strong>까지의 분봉 누적 거래대금/고저 기준,
  <span class="mode-pill mode-daily">dailySnapshot</span> 표시는 <strong>일봉 OHLC 1개</strong> 기준입니다 (분봉 미수신 종목).
  분봉은 1시간 분량일 때 거래대금이 과소평가되므로 <strong>시간대별 가중치</strong>를 곱해 보정합니다 (09:10↓ ×2.5 / 10:00↓ ×2.0 / 12:30↓ ×1.25 등).
</div>
<div class="intro">
  이 화면은 <b>QVA 후보 중 오늘 강하게 움직이는 종목을 보여주는 관찰용 보드</b>입니다.
  최근 QVA/QVA2 후보 중 오늘 장중에 갭 상승, 거래대금 증가, QVA 고가 접근/돌파, 고가권 유지 등 움직임이 시작된 종목을 감시합니다.
  VVI나 1DS 확정 신호가 아닙니다.
  <br><br>
  <b>LIVE_A</b>는 강한 반응 후보를 뜻하지만, 백테스트(60거래일·9,126 이벤트)상 D+1~D+5 안에 −5% 흔들림도 자주 발생(<b>breach5Rate 79.2%</b>)하므로 진입 신호로 해석하지 않습니다.
  <b>LIVE_A의 평균 D+5 최대 상승은 +31.85%</b>, <b>hit10 78% / hit15 72%</b>로 "강한 후보 식별"엔 의미가 있지만 변동성이 큽니다.
  <br><br>
  <span style="color:#94a3b8;">💡 카드의 <b>종목명을 클릭</b>하면 상세 페이지(차트·재무·뉴스·공시·AI 분석)로 이동합니다.</span>
</div>

<details style="margin-bottom:14px;">
  <summary>📖 등급/태그/점수 기준 자세히 보기</summary>
  <div style="padding:10px 4px;line-height:1.7;font-size:12.5px;color:#cbd5e1;">
    <div style="margin-bottom:10px;">
      <b style="color:#fde68a;">등급 정의 (liveWatchScore 기준, intraday 시간 보정 후)</b>
      <ul style="margin:6px 0 0 18px;padding:0;">
        <li><span style="color:#a7f3d0;font-weight:700;">LIVE_A — 지금 강하게 움직임</span> (70+): 갭 상승 + 거래대금 깨어남 + QVA 고가 접근/돌파 + 고가권 유지가 동시에 만족된 후보.</li>
        <li><span style="color:#bfdbfe;font-weight:700;">LIVE_B — 움직일 기세</span> (50~69): 일부 조건은 만족하나 아직 약함. 흐름 확인 필요.</li>
        <li><span style="color:#fde68a;font-weight:700;">LIVE_C — 예열</span> (35~49): 거래대금/가격이 깨어나기 시작.</li>
        <li><span style="color:#cbd5e1;font-weight:700;">WAIT — 대기</span> (20~34): 태그가 켜졌지만 점수가 낮음.</li>
        <li><span style="color:#fecaca;font-weight:700;">RISK — 추격 주의</span>: 위꼬리 큼 / 갭 깨짐 / closePos 약 등 위험 우세. 단타로 추격 위험.</li>
      </ul>
    </div>
    <div style="margin-bottom:10px;">
      <b style="color:#fde68a;">주요 태그</b>
      <ul style="margin:6px 0 0 18px;padding:0;">
        <li><b>STRONG_GAP_UP</b>: 갭 +7% 이상</li>
        <li><b>GAP_UP</b>: 갭 +3% 이상</li>
        <li><b>STRONG_VALUE_WAKE</b>: 20일 평균 거래대금 4× 이상 또는 QVA일 대비 1.5× 이상 (intraday는 시간 보정 후 4× / 2×)</li>
        <li><b>VALUE_WAKE</b>: 20일 평균 2× 이상 또는 QVA일 대비 0.8× 이상 (intraday는 보정 후 2.5× / 1.2×)</li>
        <li><b>QVA_HIGH_BREAK</b>: 장중 high 또는 현재가가 QVA일 high 돌파</li>
        <li><b>QVA_HIGH_APPROACH</b>: high가 QVA일 high의 98%까지 근접</li>
        <li><b>HOLDING_HIGH_ZONE</b>: currentPos ≥ 0.70, 위꼬리 ≤ 0.40</li>
        <li><b>STRONG_MOMENTUM</b>: 전일 종가 대비 +7% 이상 + currentPos ≥ 0.70</li>
        <li><b>LIMIT_UP_LIKE</b>: 전일 종가 대비 +20% 이상 + currentPos ≥ 0.80 (상한가 근접)</li>
        <li><b>EARLY_REACTION</b>: QVA 발생 후 D+1~D+5 안에 위 조건 2개 이상 동시 만족</li>
        <li><b>OVERHEAT_CAUTION / UPPER_TAIL_CAUTION / GAP_FAIL_CAUTION</b>: 위험 표시</li>
      </ul>
    </div>
    <div style="margin-bottom:10px;">
      <b style="color:#fde68a;">intraday 시간 보정</b>
      <div style="margin:4px 0 0 6px;">분봉이 아직 1시간 분량이면 거래대금 배수가 과소평가되므로 시간대별 가중치 곱:
        09:10↓ ×2.5 / 09:30↓ ×2.2 / 10:00↓ ×2.0 / 10:30↓ ×1.7 / 11:00↓ ×1.5 / 13:00↓ ×1.25 / 14:00↓ ×1.1. (cap 10)
      </div>
    </div>
    <div>
      <b style="color:#fde68a;">반드시 알아둘 것</b>
      <ul style="margin:6px 0 0 18px;padding:0;">
        <li>이 보드는 <b>매수/진입 신호가 아닙니다</b>. QVA 후보의 당일 움직임을 관찰하는 화면.</li>
        <li>LIVE_A라도 D+1~D+5 안 −5% 빠짐 빈도(breach5Rate)가 79.2%로 높습니다. <b>변동성이 큽니다.</b></li>
        <li>10시 분봉 수집 cron(09:30 평일)이 도착해야 분봉 기반 정확 판정. 그 전엔 일봉 fallback(dailySnapshot).</li>
      </ul>
    </div>
  </div>
</details>

<h2>섹션 1 — 요약</h2>
<div class="summary">
  <div class="item"><div class="lbl">전체 QVA 감시 후보</div><div class="val">${s.qvaSeedCount}</div></div>
  <div class="item"><div class="lbl">분석 통과</div><div class="val">${s.candidatesCount}</div></div>
  <div class="item"><div class="lbl">LIVE_A (지금 강하게 움직임)</div><div class="val">${s.LIVE_A}</div></div>
  <div class="item"><div class="lbl">LIVE_B (움직일 기세)</div><div class="val">${s.LIVE_B}</div></div>
  <div class="item"><div class="lbl">LIVE_C (예열)</div><div class="val">${s.LIVE_C}</div></div>
  <div class="item"><div class="lbl">WAIT</div><div class="val">${s.WAIT}</div></div>
  <div class="item"><div class="lbl">QVA_HIGH_BREAK</div><div class="val">${s.QVA_HIGH_BREAK}</div></div>
  <div class="item"><div class="lbl">STRONG_VALUE_WAKE</div><div class="val">${s.STRONG_VALUE_WAKE}</div></div>
  <div class="item"><div class="lbl">LIMIT_UP_LIKE</div><div class="val">${s.LIMIT_UP_LIKE}</div></div>
  <div class="item"><div class="lbl">RISK</div><div class="val">${s.RISK}</div></div>
  <div class="item"><div class="lbl">intraday / daily</div><div class="val">${s.intradayMode} / ${s.dailySnapshotMode}</div></div>
  <div class="item"><div class="lbl">intraday 보정 적용</div><div class="val">${s.timeAdjAppliedCount}</div></div>
  <div class="item"><div class="lbl">보정 → VALUE_WAKE 신규</div><div class="val">${s.valueWakeByTimeAdjCount}</div></div>
  <div class="item"><div class="lbl">보정 → 등급 승격</div><div class="val">${s.promotedByTimeAdjCount}</div></div>
  <div class="item"><div class="lbl">보정 → LIVE_A 승격</div><div class="val">${s.promotedToLiveAByTimeAdjCount}</div></div>
</div>

<h2>섹션 2 — 지금 강하게 움직임 (LIVE_A · 최대 20)</h2>
<div class="cards">${cards(data.grouped.LIVE_A, 20) || '<div>해당 없음</div>'}</div>

<h2>섹션 3 — 움직일 기세 (LIVE_B · 최대 30)</h2>
<div class="cards">${cards(data.grouped.LIVE_B, 30) || '<div>해당 없음</div>'}</div>

<h2>섹션 4 — 예열 (LIVE_C)</h2>
<details><summary>${data.grouped.LIVE_C.length}건 펼치기</summary>
  <div class="cards">${cards(data.grouped.LIVE_C, 9999)}</div>
</details>

<h2>섹션 5 — 유형별 보기</h2>
<details><summary>갭 상승 (GAP_UP · ${data.grouped.GAP_UP.length}건)</summary><div class="cards">${cards(data.grouped.GAP_UP, 30)}</div></details>
<details><summary>거래대금 깨어남 (VALUE_WAKE · ${data.grouped.VALUE_WAKE.length}건)</summary><div class="cards">${cards(data.grouped.VALUE_WAKE, 30)}</div></details>
<details><summary>QVA 고가 접근/돌파 (QVA_HIGH_BREAK · ${data.grouped.QVA_HIGH_BREAK.length}건)</summary><div class="cards">${cards(data.grouped.QVA_HIGH_BREAK, 30)}</div></details>
<details><summary>상한가 근처 (LIMIT_UP_LIKE · ${data.grouped.LIMIT_UP_LIKE.length}건)</summary><div class="cards">${cards(data.grouped.LIMIT_UP_LIKE, 30)}</div></details>
<details><summary>추격 주의 (RISK · ${data.grouped.RISK.length}건)</summary><div class="cards">${cards(data.grouped.RISK, 30)}</div></details>

<h2>섹션 6 — 전체 QVA 감시 후보</h2>
<details><summary>전체 ${data.candidates.length}건 펼치기</summary>
  <div class="cards">${cards(data.candidates, 9999)}</div>
</details>

<h2>에이치브이엠(${HVM_CODE}) 추적</h2>
<div class="cards">${hvmBlock}</div>

<div class="notes">
  ${data.notes.map(n => '<div>· ' + safe(n) + '</div>').join('')}
</div>

<script>
// 보드 화면에서 직접 "지금 분봉 다시 받아 갱신" — /admin/refresh-qva-live-watch (requireAdmin 없음)
var _qvaLwPoll = null;
async function refreshQvaLiveWatchNow() {
  var btn = document.getElementById('qvaLiveWatchRefreshBtn');
  var sts = document.getElementById('qvaLiveWatchRefreshStatus');
  if (!confirm('지금 시각까지의 분봉을 KIS에서 다시 받아 보드를 재생성할까요?\\n\\n· QVA 후보(~400종) 분봉을 현재 시각까지 수집\\n· 약 2~3분 소요 (백그라운드)')) return;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.textContent = '⏳ 갱신 중...'; }
  if (sts) { sts.style.color = '#94a3b8'; sts.textContent = '분봉 수집 + 보드 재생성 시작...'; }
  try {
    var resp = await fetch('/admin/refresh-qva-live-watch', { method: 'POST', credentials: 'same-origin' });
    if (!resp.ok || resp.redirected) { throw new Error('요청 실패 (status ' + resp.status + ')'); }
    var data = await resp.json();
    if (sts) sts.textContent = (data.message || '갱신 시작됨') + ' — 진행 상황 확인 중...';
    pollQvaLiveWatchStatus();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '📡 지금 분봉 다시 받아 갱신'; }
    if (sts) { sts.style.color = '#f87171'; sts.textContent = '⚠ ' + e.message; }
  }
}
function pollQvaLiveWatchStatus() {
  var btn = document.getElementById('qvaLiveWatchRefreshBtn');
  var sts = document.getElementById('qvaLiveWatchRefreshStatus');
  var waited = 0;
  if (_qvaLwPoll) clearInterval(_qvaLwPoll);
  _qvaLwPoll = setInterval(async () => {
    waited += 3;
    if (waited > 360) { // 6분 타임아웃
      clearInterval(_qvaLwPoll);
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '📡 지금 분봉 다시 받아 갱신'; }
      if (sts) { sts.style.color = '#f87171'; sts.textContent = '⚠ 타임아웃 — 페이지를 새로고침해 결과를 확인하세요'; }
      return;
    }
    try {
      var r = await fetch('/admin/qva-live-watch-status', { credentials: 'same-origin' });
      var s = await r.json();
      if (!s.running) {
        clearInterval(_qvaLwPoll);
        if (s.lastError) {
          if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '📡 지금 분봉 다시 받아 갱신'; }
          if (sts) { sts.style.color = '#f87171'; sts.textContent = '⚠ 실패: ' + s.lastError; }
        } else {
          if (sts) { sts.style.color = '#4ade80'; sts.textContent = '✅ 완료 — 3초 후 화면 새로고침'; }
          setTimeout(() => location.reload(), 3000);
        }
      } else if (sts) {
        sts.textContent = '⏳ 갱신 중... (' + waited + 's 경과, end-hour ' + (s.endHour || '-') + ')';
      }
    } catch (_) { /* polling 일시 실패는 무시 */ }
  }, 3000);
}
</script>
</body>
</html>`;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
