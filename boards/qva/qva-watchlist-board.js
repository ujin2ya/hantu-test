/**
 * QVA Watchlist Board — 매일 장마감 후 갱신되는 추적 보드
 *
 * 목적:
 *   매일 운영용 후보 보드. QVA → VVI → 돌파 성공의 funnel 전체를 한 화면에 보여준다.
 *   H그룹(돌파 성공)은 1년에 90개 정도라 너무 적으니, QVA 추적 중·VVI 발생 후보도
 *   함께 표시해서 어느 단계까지 진척됐는지 시각화한다.
 *
 * 메인 단계 (mutually exclusive 스냅샷 상태):
 *   - QVA_NEW          : 오늘 (D=0) QVA 발생
 *   - QVA_TRACKING     : D+1 ~ D+20, VVI 미발생, 미이탈
 *   - VVI_FIRED        : 가장 최근 거래일이 VVI 발생일 (내일 돌파 결과 봐야 함)
 *   - BREAKOUT_SUCCESS : VVI 다음 거래일 돌파 성공 (오늘 또는 최근 며칠)
 *   - FAILED           : 종가 ≤ 신호가 × 0.85, D+20 만료, 또는 돌파 실패
 *
 * 보조 태그 (다중 적용):
 *   - PRICE_HOLD          : 현재 종가 ≥ 신호가 × 0.95
 *   - LOW_RISING          : min(low 최근 5일) > min(low 그 이전 5일)
 *   - VALUE_REACTIVATION  : avg value 최근 3일 ≥ 신호 직전 20일 평균 × 1.5
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ps = require('../../screeners/pattern-screener');
const { findVvi2AfterQva2 } = require('../qva2/qva2-screener');
const vprAnalyzer = require('./vpr-analyzer');
const { filterRowsAsOf } = require('../../src/db/asOfChart');

const ROOT = path.join(__dirname, '..', '..');
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const TRACKING_DAYS = 20;
const LONG_QVA_START = 21;            // 장기 QVA 시작 (D+21)
const LONG_QVA_END = 40;              // 장기 QVA 종료 (D+40)
const LONG_QVA_DROP_THRESHOLD_PCT = -10;  // currentClose < signalPrice × 0.90 이면 만료
const EXIT_THRESHOLD_PCT = -15;       // 신호가 대비 -15% 이탈 시 FAILED
const RECENT_BREAKOUT_DAYS = 5;       // 돌파 성공 후보를 며칠까지 보드에 유지할지
const RECENT_FAILED_DAYS = 5;         // 실패/이탈도 최근 5일까지만 표시

// ─────────── 종목 분류 ───────────
const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}
function isPreferredStock(name) {
  if (!name) return false;
  return /우[A-Z]?$/.test(name);
}

// ─────────── 통계 헬퍼 ───────────
function sma(values, period) {
  if (!values || values.length < period) return null;
  const recent = values.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / period;
}
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function round2(v) {
  return v == null || !Number.isFinite(v) ? null : parseFloat(v.toFixed(2));
}
function formatDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// ─────────── QVA 검출 (기존 보고서와 동일) ───────────
function checkQVASignalAtIdx(rows, idx) {
  if (!rows || idx < 60) return false;
  const today = rows[idx];
  const close = today?.close;
  if (!close || close <= 0) return false;

  const last20 = rows.slice(idx - 19, idx + 1);
  const last5 = rows.slice(idx - 4, idx + 1);
  const avg20Value = last20.reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = last20.reduce((s, r) => s + (r.volume || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return false;

  const todayValue = today.valueApprox || today.close * today.volume;
  const valueRatio20 = todayValue / (avg20Value || 1);
  const volumeRatio20 = today.volume / (avg20Vol || 1);
  if (valueRatio20 < 1.5 || volumeRatio20 < 1.5) return false;

  const lows5 = last5.map(r => r.low);
  const lows20to25 = rows.slice(idx - 24, idx - 4).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;
  if (min5 <= min20) return false;

  const ma20 = sma(last20.map(r => r.close), 20);
  if (ma20 && close < ma20 * 0.95) return false;

  const todayReturn = today.open > 0 ? close / today.open - 1 : 0;
  if (todayReturn > 0.05) return false;

  const ret20d = idx >= 20 ? close / rows[idx - 20].close - 1 : 0;
  if (ret20d > 0.15) return false;

  const medianVal20 = median(last20.map(r => r.valueApprox || 0));
  const valueMedianRatio = medianVal20 > 0 ? todayValue / medianVal20 : 0;
  if (valueMedianRatio < 1.8) return false;

  const last3 = rows.slice(idx - 2, idx + 1);
  const hasRecentValueSpike = last3.some(r => {
    const v = r.valueApprox || r.close * r.volume;
    const vRatio = v / (avg20Value || 1);
    const medRatio = medianVal20 > 0 ? v / medianVal20 : 0;
    return vRatio >= 1.5 || medRatio >= 2.0;
  });
  if (!hasRecentValueSpike) return false;

  const last10hl = rows.slice(idx - 9, idx + 1);
  const high10 = Math.max(...last10hl.map(r => r.high));
  const low10 = Math.min(...last10hl.map(r => r.low));
  const rangeExpansion10 = low10 > 0 ? high10 / low10 - 1 : 0;
  if (rangeExpansion10 < 0.03) return false;

  return true;
}

// ─────────── 메인 ───────────
console.log(`\n📊 QVA Watchlist Board — 매일 장마감 후 갱신`);

const stocksList = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
const codeMeta = new Map();
for (const s of stocksList.stocks) codeMeta.set(s.code, s);

const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));

// 모든 거래일 set 수집 (tradingDateCount + TODAY 결정용)
const allTradingDateSet = new Set();
const cacheMaxDates = [];
for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, f), 'utf-8'));
    const rows = filterRowsAsOf(d.rows || []);
    const last = rows[rows.length - 1]?.date;
    if (last) cacheMaxDates.push(last);
    for (const r of rows) if (r?.date) allTradingDateSet.add(r.date);
  } catch (_) {}
}
const tradingDates = Array.from(allTradingDateSet).sort();
const tradingDateCount = tradingDates.length;

// 한국 증시 공휴일 (정기 휴장일 — 임시 휴장은 별도 갱신 필요)
// 2025~2027 주요 휴장일. 추후 연단위 갱신 권장.
const KR_HOLIDAYS = new Set([
  // 2025
  '20250101', '20250127', '20250128', '20250129', '20250130', '20250303',
  '20250505', '20250506', '20250606', '20250815', '20251006', '20251007',
  '20251008', '20251009', '20251225',
  // 2026
  '20260101', '20260216', '20260217', '20260218', '20260302', '20260501',
  '20260505', '20260525', '20260606', '20260815', '20260924', '20260925',
  '20260928', '20261005', '20261009', '20261225',
  // 2027
  '20270101', '20270208', '20270209', '20270210', '20270301', '20270505',
  '20270513', '20270607', '20270816', '20271004', '20271005', '20271006',
  '20271011', '20271227',
]);

function nextTradingDayAfter(yyyymmdd) {
  const y = parseInt(yyyymmdd.slice(0, 4));
  const m = parseInt(yyyymmdd.slice(4, 6)) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8));
  const dt = new Date(y, m, d);
  for (let i = 0; i < 14; i++) {
    dt.setDate(dt.getDate() + 1);
    const k = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
    if (dt.getDay() === 0 || dt.getDay() === 6) continue;
    if (KR_HOLIDAYS.has(k)) continue;
    return k;
  }
  return null;
}

// ─── 운영 기준일(operationalReferenceDate) 결정 ─────────────────────────
// 한국 시간 09:00(장 시작) 전이면 어제부터, 그 후면 오늘부터 가까운 거래일을 기준일로 잡는다.
// 캐시가 미래 일자(예: 새벽 cron이 partial로 다음 거래일을 기록)로 갱신되어도
// 시장이 열리기 전엔 전 거래일을 기준으로 보여줘야 사용자 혼란이 없다.
function kstNow() {
  // UTC + 9시간 → KST 시각 객체 (UTC 메서드로 읽으면 KST 값)
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function ymdFromUtcParts(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function isKrTradingDay(d /* UTC parts = KST */, ymd) {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (KR_HOLIDAYS.has(ymd)) return false;
  return true;
}
function operationalReferenceDate() {
  const kst = kstNow();
  // KST 09:00 전이면 하루 전부터 검색 (시장 미개장)
  if (kst.getUTCHours() < 9) kst.setUTCDate(kst.getUTCDate() - 1);
  for (let i = 0; i < 14; i++) {
    const k = ymdFromUtcParts(kst);
    if (isKrTradingDay(kst, k)) return k;
    kst.setUTCDate(kst.getUTCDate() - 1);
  }
  return null;
}

const _now = new Date();
const todayCalendarDate = `${_now.getFullYear()}${String(_now.getMonth() + 1).padStart(2, '0')}${String(_now.getDate()).padStart(2, '0')}`;
const opRef = operationalReferenceDate();

// 캐시 max 날짜 중 opRef를 넘지 않는 가장 최근 날짜를 TODAY로 잡되,
// 그 날짜의 데이터 커버리지가 너무 낮으면 (cron partial 갱신 중) 전 거래일로 fallback.
const COVERAGE_THRESHOLD = 0.50;  // 50% 이상이어야 그 날을 TODAY로 채택
const dateCoverageMap = new Map();
for (const last of cacheMaxDates) {
  if (!last || last > opRef) continue;
  dateCoverageMap.set(last, (dateCoverageMap.get(last) || 0) + 1);
}
const sortedDateCandidates = Array.from(dateCoverageMap.entries())
  .filter(([d]) => d <= opRef)
  .sort((a, b) => b[0].localeCompare(a[0])); // 최근 → 과거 순

let TODAY = '';
for (const [d, count] of sortedDateCandidates) {
  const coverage = count / Math.max(cacheMaxDates.length, 1);
  if (coverage >= COVERAGE_THRESHOLD) { TODAY = d; break; }
}
// fallback: 50% 이상인 날짜가 없으면 가장 최근 날짜 사용
if (!TODAY && sortedDateCandidates.length > 0) TODAY = sortedDateCandidates[0][0];
if (!TODAY) {
  // 최후 fallback: 캐시 max 어떤 거라도 사용
  for (const last of cacheMaxDates) if (last && last > TODAY) TODAY = last;
}

const isMarketClosedToday = todayCalendarDate !== TODAY;
const nextTradingDate = nextTradingDayAfter(TODAY);

// 사용자 표시용 — todayCalendar 가 거래일인지 + KST 09:00 전인지 분리
const _kstForLabel = kstNow();
const _todayIsHoliday = !isKrTradingDay(_kstForLabel, todayCalendarDate);
const _beforeMarketOpen = _kstForLabel.getUTCHours() < 9;
const todayCalendarLabel = _todayIsHoliday ? '휴장/주말'
  : (_beforeMarketOpen ? '거래일 — 장 시작 전' : '거래일');

const _kst = kstNow();
const _kstStr = `${_kst.getUTCFullYear()}-${String(_kst.getUTCMonth()+1).padStart(2,'0')}-${String(_kst.getUTCDate()).padStart(2,'0')} ${String(_kst.getUTCHours()).padStart(2,'0')}:${String(_kst.getUTCMinutes()).padStart(2,'0')} KST`;
console.log(`KST 현재: ${_kstStr} (${_kst.getUTCHours() < 9 ? '장 시작 전 — 전 거래일 기준' : '장 시작 후'})`);
console.log(`운영 기준일 (opRef): ${formatDate(opRef)}`);
console.log(`기준일 (latestTradingDate): ${formatDate(TODAY)}`);
console.log(`달력 오늘 (todayCalendarDate): ${formatDate(todayCalendarDate)} (${todayCalendarLabel})`);
console.log(`다음 거래일 (nextTradingDate): ${formatDate(nextTradingDate)}`);
console.log(`총 거래일 수 (tradingDateCount): ${tradingDateCount}`);
console.log(`종목 수: ${files.length}\n`);

const candidates = [];
const t0 = Date.now();

for (let fi = 0; fi < files.length; fi++) {
  if (fi % 500 === 0) process.stdout.write(`  진행 ${fi}/${files.length}\r`);
  const code = files[fi].replace('.json', '');
  const meta = codeMeta.get(code);
  if (!meta) continue;
  if (isExcludedProduct(meta.name)) continue;

  let chart;
  try {
    chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8'));
    if (chart && chart.rows) chart.rows = filterRowsAsOf(chart.rows);
  } catch (_) { continue; }
  const rows = chart.rows || [];
  if (rows.length < 65) continue;

  const todayIdx = rows.findIndex(r => r.date === TODAY);
  // todayIdx 없는 종목 (해당일 거래 없음)은 스킵
  if (todayIdx < 0) continue;
  const todayRow = rows[todayIdx];
  if (!todayRow.close || todayRow.close <= 0) continue;

  let flow;
  try { flow = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, files[fi]), 'utf-8')); }
  catch (_) { flow = { rows: [] }; }
  const flowRows = flow.rows || [];
  const namedMeta = { ...meta, name: meta.name || chart.name };

  // ─── 가장 최근 QVA 신호 + first/best (today 포함, 최대 D+20 이전까지) ───
  let qvaIdx = null;
  const confirmedQvaIdxList = [];
  for (let k = 0; k <= TRACKING_DAYS && todayIdx - k >= 60; k++) {
    if (checkQVASignalAtIdx(rows, todayIdx - k)) {
      const cand = todayIdx - k;
      confirmedQvaIdxList.push(cand);
      if (qvaIdx == null) qvaIdx = cand; // 가장 최근 = funnel anchor
    }
  }
  if (qvaIdx == null) continue;
  // first = 가장 이른 (= 최대 k), best = 현재 anchor (Confirmed QVA는 score 없음)
  const firstConfirmedQvaIdx = confirmedQvaIdxList.length > 0
    ? confirmedQvaIdxList[confirmedQvaIdxList.length - 1] : qvaIdx;
  const bestConfirmedQvaIdx = qvaIdx;

  const qvaDate = rows[qvaIdx].date;
  const signalPrice = rows[qvaIdx].close;
  const signalValue = rows[qvaIdx].valueApprox || rows[qvaIdx].close * rows[qvaIdx].volume;
  const daysSinceQva = todayIdx - qvaIdx;

  // ─── 이탈 검출 ───
  let exited = false;
  let exitDate = null;
  for (let k = 1; k <= daysSinceQva; k++) {
    const r = rows[qvaIdx + k];
    if (r.close > 0 && r.close <= signalPrice * (1 + EXIT_THRESHOLD_PCT / 100)) {
      exited = true;
      exitDate = r.date;
      break;
    }
  }

  // ─── VVI 검출 (QVA 이후) — VVI2 absorption (2026-05-17 통일) ───
  // anchor: qvaIdx (이 종목의 QVA 발생일). today까지 VVI2 발화 여부 스캔.
  let vviIdx = null;
  let vviInfo = null;
  if (daysSinceQva >= 1) {
    const v2 = findVvi2AfterQva2(rows, qvaIdx, daysSinceQva, { qva2Type: 'absorption' });
    if (v2.vvi2Idx > qvaIdx) {
      vviIdx = v2.vvi2Idx;
      const vRow = rows[vviIdx];
      vviInfo = {
        passed: true,
        category: 'VVI2_ABSORPTION',
        signals: { signalHigh: vRow.high, signalClose: vRow.close, qvaAnchorIdx: qvaIdx, daysSinceQva: vviIdx - qvaIdx },
      };
    }
  }

  // ─── 돌파 결과 (VVI 발생 시) ───
  let breakoutIdx = null;
  let breakoutInfo = null;
  if (vviIdx != null && vviIdx + 1 <= todayIdx) {
    const next = rows[vviIdx + 1];
    const vviRow = rows[vviIdx];
    const triggered1Pct = next.high >= vviRow.high * 1.01;
    const breakoutFail = next.close < vviRow.high;
    breakoutIdx = vviIdx + 1;
    breakoutInfo = {
      date: next.date,
      vviHigh: vviRow.high,
      vviClose: vviRow.close,
      vviLow: vviRow.low,
      nextHigh: next.high,
      nextClose: next.close,
      entryPrice1Pct: vviRow.high * 1.01,
      triggered1Pct,
      breakoutFail,
      breakoutSuccess: triggered1Pct && !breakoutFail,
    };
  }

  // ─── 메인 단계 결정 ───
  let mainStage;
  let stageReason = null;

  if (daysSinceQva === 0) {
    mainStage = 'QVA_NEW';
  } else if (exited) {
    mainStage = 'FAILED';
    stageReason = `${formatDate(exitDate)} 종가 -15% 이탈`;
  } else if (vviIdx != null) {
    if (vviIdx === todayIdx) {
      // VVI가 오늘 발생 — 내일 돌파일
      mainStage = 'VVI_FIRED';
    } else if (breakoutInfo) {
      // 돌파일 데이터 도래
      if (breakoutInfo.breakoutSuccess) {
        // 최근 N일 내 돌파 성공이면 보드에 유지, 그 이전이면 BREAKOUT_PASSED
        const daysSinceBreakout = todayIdx - breakoutIdx;
        if (daysSinceBreakout <= RECENT_BREAKOUT_DAYS) {
          mainStage = 'BREAKOUT_SUCCESS';
        } else {
          // 이미 며칠 지난 후보 — 진입 시점 지남, 보드에서 내림
          continue;
        }
      } else {
        // 돌파 실패
        const daysSinceBreakout = todayIdx - breakoutIdx;
        if (daysSinceBreakout <= RECENT_FAILED_DAYS) {
          mainStage = 'FAILED';
          stageReason = `${formatDate(breakoutInfo.date)} 돌파 실패 (다음 종가 < VVI2 고가)`;
        } else {
          continue;  // 너무 오래된 실패 — 보드에서 내림
        }
      }
    } else {
      // 이론상 도달 안 함 (vviIdx < todayIdx인데 breakoutInfo 없는 경우)
      mainStage = 'VVI_FIRED';
    }
  } else {
    // No VVI yet
    if (daysSinceQva >= TRACKING_DAYS) {
      mainStage = 'FAILED';
      stageReason = `D+${TRACKING_DAYS} 만료, VVI2 미발생`;
    } else {
      mainStage = 'QVA_TRACKING';
    }
  }

  // ─── 진입 판단 상태 (BREAKOUT_SUCCESS 그룹용) ───
  // 돌파 성공은 매수 신호가 아니라 "강한 후보 상태"이므로 현재가 위치에 따라 진입 적합성을 분류.
  let judgmentStatus = null;
  let currentReturnFromEntry = null;
  let daysFromBreakout = null;

  if (mainStage === 'BREAKOUT_SUCCESS' && breakoutInfo) {
    const entryPrice = breakoutInfo.entryPrice1Pct;
    const c = todayRow.close;
    daysFromBreakout = todayIdx - breakoutIdx;
    currentReturnFromEntry = (c - entryPrice) / entryPrice * 100;

    // 우선순위: 약화 > 관리 > 눌림 > 추격 > 검토
    if (c < entryPrice || c < breakoutInfo.vviHigh) {
      judgmentStatus = 'BREAKDOWN_WEAK';     // 돌파 약화
    } else if (c >= entryPrice * 1.15) {
      judgmentStatus = 'MANAGEMENT';         // 관리 구간
    } else if (c > entryPrice * 1.07 || daysFromBreakout >= 3) {
      judgmentStatus = 'PULLBACK_WAIT';      // 눌림 대기
    } else if (c > entryPrice * 1.03) {
      judgmentStatus = 'CHASE_CAUTION';      // 추격 주의
    } else {
      judgmentStatus = 'REVIEW_OK';          // 검토 가능 (days <= 2 AND close <= 1.03)
    }
  }

  // ─── VPR — H그룹 내부에서만 적용하는 "돌파 이후 반응 분류" ───
  // 사용자 spec(2026-05): 성공/실패 판정이 아니라 돌파 이후 단일 거래일 반응을 5개 메인 + 10개 보조 태그로 분류.
  // 기준선 = VVI 돌파대기일 종가 × 1.01. H그룹이 아닌 종목에는 적용하지 않음.
  let vpr = null;
  if (mainStage === 'BREAKOUT_SUCCESS' && breakoutInfo && breakoutIdx != null && vviIdx != null) {
    try {
      vpr = vprAnalyzer.analyzeBreakoutReaction({ vviIdx, breakoutIdx }, rows);
    } catch (e) {
      vpr = null;
    }
  }

  // ─── 보조 태그 ───
  const auxTags = [];
  const currentClose = todayRow.close;
  const currentReturnFromSignal = (currentClose / signalPrice - 1) * 100;

  // 가격 유지: 현재 종가 ≥ 신호가 × 0.95
  if (currentClose >= signalPrice * 0.95) auxTags.push('PRICE_HOLD');

  // 저점 상승: min(low 최근 5일) > min(low 그 이전 5일)
  if (todayIdx >= 9) {
    const last5lows = rows.slice(todayIdx - 4, todayIdx + 1).map(r => r.low).filter(v => v > 0);
    const prev5lows = rows.slice(todayIdx - 9, todayIdx - 4).map(r => r.low).filter(v => v > 0);
    if (last5lows.length === 5 && prev5lows.length === 5) {
      if (Math.min(...last5lows) > Math.min(...prev5lows)) auxTags.push('LOW_RISING');
    }
  }

  // 거래대금 재활성: avg(value 최근 3일) ≥ avg(value 신호 직전 20일) × 1.5
  if (todayIdx >= 2 && qvaIdx >= 1) {
    const last3 = rows.slice(todayIdx - 2, todayIdx + 1).map(r => r.valueApprox || 0);
    const last3Avg = last3.reduce((s, v) => s + v, 0) / 3;
    const baseStart = Math.max(0, qvaIdx - 19);
    const baseRows = rows.slice(baseStart, qvaIdx);
    const baseAvg = baseRows.length > 0
      ? baseRows.reduce((s, r) => s + (r.valueApprox || 0), 0) / baseRows.length
      : 0;
    if (baseAvg > 0 && last3Avg >= baseAvg * 1.5) auxTags.push('VALUE_REACTIVATION');
  }

  // ─── QVA_TRACKING 보조 신호: 위험 / 만료 임박 / 관심도 점수 ───
  // 위험: 신호가 대비 -5% 이하 (가격이 무너지기 시작한 후보)
  const riskTag = currentReturnFromSignal != null && currentReturnFromSignal <= -5;
  // 만료 임박: D+15 이상 (TRACKING_DAYS=20 중 마지막 5거래일)
  const expiringSoon = daysSinceQva >= 15;
  // 관심도 점수 (watchScore 0~100): 보조 태그 ×25 + 가격 유지 보너스 - 위험/만료 감점
  let _ws = (auxTags.length || 0) * 25;
  if (currentReturnFromSignal != null) {
    if (currentReturnFromSignal >= 5) _ws += 15;
    else if (currentReturnFromSignal >= 0) _ws += 10;
    else if (currentReturnFromSignal <= -5) _ws -= 15;
  }
  if (expiringSoon) _ws -= 10;
  if (daysSinceQva <= 5) _ws += 5;
  const watchScore = Math.max(0, Math.min(100, Math.round(_ws)));

  // ─── 후보 레코드 ───
  candidates.push({
    code,
    name: meta.name,
    market: meta.market,
    isPreferred: isPreferredStock(meta.name),
    marketValue: meta.marketValue,

    qvaSignalDate: qvaDate,
    qvaSignalPrice: signalPrice,
    qvaSignalTradingValue: Math.round(signalValue),
    daysSinceQva,

    currentDate: TODAY,
    currentClose,
    currentVolume: todayRow.volume,
    currentValue: todayRow.valueApprox || todayRow.close * todayRow.volume,
    currentReturnFromSignal: round2(currentReturnFromSignal),

    vviDate: vviIdx != null ? rows[vviIdx].date : null,
    vviHigh: vviIdx != null ? rows[vviIdx].high : null,
    vviClose: vviIdx != null ? rows[vviIdx].close : null,
    vviLow: vviIdx != null ? rows[vviIdx].low : null,
    daysSinceVvi: vviIdx != null ? todayIdx - vviIdx : null,

    breakoutDate: breakoutInfo?.date || null,
    breakoutEntryPrice1Pct: breakoutInfo ? round2(breakoutInfo.entryPrice1Pct) : null,
    breakoutNextHigh: breakoutInfo?.nextHigh || null,
    breakoutNextClose: breakoutInfo?.nextClose || null,
    breakoutSuccess: breakoutInfo?.breakoutSuccess ?? null,
    daysFromBreakout,
    currentReturnFromEntry: round2(currentReturnFromEntry),
    judgmentStatus,

    // VPR 돌파 이후 반응 분류 (H그룹 전용 — 매수확정 신호 아님)
    vprMain: vpr?.vprMain || null,
    vprMainLabel: vpr?.vprMainLabel || null,
    vprTags: vpr?.vprTags || [],
    vprTagLabels: vpr?.vprTagLabels || [],
    vprDescription: vpr?.vprDescription || null,
    vprBaseClose: vpr?.vprBaseClose ?? null,
    vprBreakoutLine: vpr?.vprBreakoutLine ?? null,
    vprDistanceFromBasePct: vpr?.vprDistanceFromBasePct ?? null,
    vprDistanceFromBreakoutPct: vpr?.vprDistanceFromBreakoutPct ?? null,
    vprClosePosition: vpr?.vprClosePosition ?? null,
    // 라이브 거리 — 오늘 종가가 기준 종가에서 얼마나 떨어졌는지 (운영 태그 판정용)
    liveDistanceFromBasePct: (vpr?.vprBaseClose && currentClose) ? round2((currentClose / vpr.vprBaseClose - 1) * 100) : null,

    mainStage,
    stageReason,
    auxTags,

    // QVA 추적 중 전용 신호
    riskTag,
    expiringSoon,
    watchScore,

    // first/best 추적 (Confirmed QVA)
    firstConfirmedQvaDate: rows[firstConfirmedQvaIdx]?.date || qvaDate,
    bestConfirmedQvaDate: rows[bestConfirmedQvaIdx]?.date || qvaDate,
  });
}

console.log(`\n→ 전체 후보: ${candidates.length}건 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// ─────────── QVA 별도 스캔 (저점권 거래대금 돌파 — REDEFINED_TIGHT_FILTER_C30) ───
// 사용자 spec(2026-05): 2개 섹션으로 통합 (UX 단순화).
//   QVA_TODAY    = 오늘 통과한 종목 (신규 + 재확인 모두) — 행에 'NEW_TODAY' / 'TODAY_RECONFIRMED' 태그
//   EARLY_QVA    = 최근 20거래일 안 발화 + 오늘 미통과 + VVI 전 (= QVA 추적 중)
const earlyQvaCandidates = [];        // QVA_TRACKING (D+1~D+20, VVI 전)
const todayQvaCandidates = [];        // QVA_TODAY (오늘 신규 + 오늘 재확인 통합)
const longQvaCandidates = [];         // 장기 QVA (D+21~D+40, VVI/H 미전환, -10% 이상 무너지지 않음)
const debugCounts = {
  totalUniverseCount: files.length,
  chartDataAvailableCount: 0,
  flowDataAvailableCount: 0,
  qvaCandidatesTodayRaw: 0,
  qvaCandidatesTodayAfterFilters: 0,
  qvaTodayReconfirmedCount: 0,
  qvaTrackingCandidates20d: 0,
  qvaTrackingHasVviCount: 0,
  longQvaScanned: 0,                   // D+21~D+40 안에서 통과 흔적 발견
  longQvaExpired: 0,                   // 신호가 대비 -10% 이상 무너져 만료
  longQvaIncluded: 0,                  // 장기 QVA 후보로 채택
};

// ─── 장기 QVA 재점화 점수 계산 (사용자 spec) ───
function computeLongQvaReactivationScore(rows, todayIdx, qvaIdx, signalPrice) {
  const today = rows[todayIdx];
  let score = 0;
  const checks = {};

  // (1) 거래대금 재활성 — 30점
  const last3 = rows.slice(todayIdx - 2, todayIdx + 1);
  const recent3AvgValue = last3.reduce((s, r) => s + (r.valueApprox || 0), 0) / 3;
  const prev20 = rows.slice(todayIdx - 20, todayIdx);
  const prev20Values = prev20.map(r => r.valueApprox || 0).filter(v => v > 0).sort((a, b) => a - b);
  const prev20ValueMedian = prev20Values.length > 0
    ? (prev20Values.length % 2 === 0
        ? (prev20Values[prev20Values.length / 2 - 1] + prev20Values[prev20Values.length / 2]) / 2
        : prev20Values[Math.floor(prev20Values.length / 2)])
    : 0;
  const todayValue = today.valueApprox || 0;
  const valueReactivated = (recent3AvgValue >= prev20ValueMedian * 1.5) ||
                           (todayValue >= prev20ValueMedian * 2.0);
  checks.valueReactivated = valueReactivated;
  if (valueReactivated) score += 30;

  // (2) QVA 신호가 위 유지 — 20점 (부분 점수: 95% 이상이면 10점)
  let priceHoldScore = 0;
  if (today.close >= signalPrice) priceHoldScore = 20;
  else if (today.close >= signalPrice * 0.95) priceHoldScore = 10;
  checks.priceHoldAboveSignal = today.close >= signalPrice;
  checks.priceHoldNear = today.close >= signalPrice * 0.95;
  score += priceHoldScore;

  // (3) 최근 고점 돌파 재시도 — 20점
  const last10 = rows.slice(todayIdx - 9, todayIdx + 1);
  const recent10High = Math.max(...last10.map(r => r.high));
  const breakoutRetry = (today.close >= recent10High * 0.95) || (today.high >= recent10High);
  checks.breakoutRetry = breakoutRetry;
  if (breakoutRetry) score += 20;

  // (4) 저점 상승 — 15점
  const last5 = rows.slice(todayIdx - 4, todayIdx + 1);
  const prev5 = rows.slice(todayIdx - 9, todayIdx - 4);
  const recent5Low = Math.min(...last5.map(r => r.low));
  const previous5Low = prev5.length > 0 ? Math.min(...prev5.map(r => r.low)) : Infinity;
  const lowRising = recent5Low > previous5Low;
  checks.lowRising = lowRising;
  if (lowRising) score += 15;

  // (5) 20일선 회복 또는 유지 — 15점
  const ma20 = prev20.length === 20
    ? rows.slice(todayIdx - 19, todayIdx + 1).reduce((s, r) => s + r.close, 0) / 20
    : null;
  const ma20Recovery = ma20 != null && (today.close >= ma20 || today.close >= ma20 * 0.98);
  checks.ma20Recovery = ma20Recovery;
  if (ma20Recovery) score += 15;

  return {
    score,
    checks,
    metrics: {
      recent3AvgValue: Math.round(recent3AvgValue),
      prev20ValueMedian: Math.round(prev20ValueMedian),
      valueRatio3Avg: prev20ValueMedian > 0 ? +(recent3AvgValue / prev20ValueMedian).toFixed(2) : null,
      todayValue,
      valueRatioToday: prev20ValueMedian > 0 ? +(todayValue / prev20ValueMedian).toFixed(2) : null,
      recent10High,
      recent5Low,
      previous5Low: previous5Low === Infinity ? null : previous5Low,
      ma20: ma20 != null ? Math.round(ma20) : null,
      currentClose: today.close,
      signalPrice,
    },
  };
}

// 장기 QVA tier — 인라인 분류 (qvaReturnPct + score 조합)로 결정 (사용자 spec 2026-05)
const t1 = Date.now();
console.log(`\n🌱 QVA 스캔 시작 (window=${TRACKING_DAYS}d, TODAY=${TODAY})...`);

for (let fi = 0; fi < files.length; fi++) {
  if (fi % 500 === 0) process.stdout.write(`  QVA 진행 ${fi}/${files.length}\r`);
  const code = files[fi].replace('.json', '');
  const meta = codeMeta.get(code);
  if (!meta) continue;
  if (isExcludedProduct(meta.name)) continue;
  let chart;
  try {
    chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8'));
    if (chart && chart.rows) chart.rows = filterRowsAsOf(chart.rows);
  } catch (_) { continue; }
  const rows = chart.rows || [];
  if (rows.length < 65) continue;

  const todayIdx = rows.findIndex(r => r.date === TODAY);
  if (todayIdx < 0) continue;
  const todayRow = rows[todayIdx];
  if (!todayRow.close || todayRow.close <= 0) continue;
  debugCounts.chartDataAvailableCount++;

  // flow 데이터 가용 여부
  let flowRowsForVvi = [];
  try {
    const flowRaw = JSON.parse(fs.readFileSync(path.join(FLOW_DIR, code + '.json'), 'utf-8'));
    flowRowsForVvi = flowRaw?.rows || [];
    if (flowRowsForVvi.some(r => r?.date && r.date <= TODAY)) debugCounts.flowDataAvailableCount++;
  } catch (_) { flowRowsForVvi = []; }

  const namedMeta = { ...meta, name: meta.name || chart.name };

  // 윈도우 안 모든 QVA 신호 수집 — D+0 ~ D+40 (D+0~20 정식 추적, D+21~40 장기 추적)
  const earlySignals = [];        // D+0 ~ D+20 안의 신호 (기존 추적)
  const longQvaSignals = [];      // D+21 ~ D+40 안의 신호 (장기 추적용)
  for (let k = 0; k <= LONG_QVA_END && todayIdx - k >= 60; k++) {
    const cand = todayIdx - k;
    const sliced = rows.slice(0, cand + 1);
    let r = null;
    try { r = ps.calculateRedefinedQVA(sliced, [], namedMeta); } catch (_) {}
    if (r?.passed) {
      const sig = {
        idx: cand, date: rows[cand].date, score: r.score,
        grade: r.grade, gradeLabel: r.gradeLabel, signals: r.signals,
      };
      if (k <= TRACKING_DAYS) earlySignals.push(sig);
      else longQvaSignals.push(sig);
    }
  }
  if (earlySignals.length === 0 && longQvaSignals.length === 0) continue;

  // earlySignals: idx asc 로 정렬 (장기 QVA만 있는 종목은 이 블록 건너뜀)
  let firstSig, latestSig, bestSig;
  if (earlySignals.length > 0) {
    earlySignals.sort((a, b) => a.idx - b.idx);
    firstSig = earlySignals[0];
    latestSig = earlySignals[earlySignals.length - 1];
    bestSig = earlySignals.reduce((acc, s) => (s.score > acc.score ? s : acc), earlySignals[0]);
  }
  // 사용자 spec(2026-05): 분류 기준 강화
  //   isTodayNew      = firstSignalDate === TODAY   → "오늘 신규"
  //   isTodayReconfirm = firstSig < TODAY AND latestSig === TODAY → "오늘 재확인" (추적 중 안에 태그)
  //   isPastOnly      = latestSig < TODAY  → 추적 중 (재확인 없음)
  const isTodayNew = firstSig && firstSig.date === TODAY;
  const isTodayReconfirm = firstSig && latestSig && !isTodayNew && latestSig.date === TODAY;
  if (latestSig && latestSig.date === TODAY) debugCounts.qvaCandidatesTodayRaw++;

  // VVI 체크 (VVI2 absorption, 2026-05-17 통일): firstSig.idx 이후 today까지 발화 여부
  let hasVvi = false;
  let vviDateLocal = null;
  if (firstSig && firstSig.idx < todayIdx) {
    const maxScan = todayIdx - firstSig.idx;
    const v2 = findVvi2AfterQva2(rows, firstSig.idx, maxScan, { qva2Type: 'absorption' });
    if (v2.vvi2Idx > firstSig.idx) { hasVvi = true; vviDateLocal = rows[v2.vvi2Idx].date; }
  }

  const currentClose = todayRow.close;
  const signalPrice = firstSig ? rows[firstSig.idx].close : null;
  const currentReturnFromSignal = signalPrice ? (currentClose / signalPrice - 1) * 100 : null;
  const daysSinceFirst = firstSig ? todayIdx - firstSig.idx : null;
  const daysSinceLatest = latestSig ? todayIdx - latestSig.idx : null;

  const baseRecord = firstSig ? {
    code,
    name: meta.name,
    market: meta.market,
    isPreferred: isPreferredStock(meta.name),
    marketValue: meta.marketValue,

    firstEarlyQvaDate: firstSig.date,
    bestEarlyQvaDate: bestSig.date,
    latestEarlyQvaDate: latestSig.date,
    bestEarlyQvaScore: bestSig.score,
    bestEarlyQvaGrade: bestSig.grade,
    bestEarlyQvaGradeLabel: bestSig.gradeLabel,
    earlyQvaSignalCount: earlySignals.length,
    daysSinceFirst,
    daysSinceLatest,
    daysSinceBest: todayIdx - bestSig.idx,

    anchorPrice: signalPrice,
    currentDate: TODAY,
    currentClose,
    currentReturnFromSignal: round2(currentReturnFromSignal),

    // 표시용 — best signal 시점 signals (점수 가장 높은 발화일)
    signals: bestSig.signals,
    hasVvi,
    vviDateInternal: vviDateLocal,
    auxTags: [],
  } : null;

  // 분류 (D+0~D+20 그룹):
  //   isTodayNew  OR (isTodayReconfirm + !hasVvi) → QVA_TODAY (행에 태그로 구분)
  //   latestSig < TODAY + !hasVvi                  → EARLY_QVA (추적 중)
  // earlySignals가 비어있는 경우 (D+21~D+40 신호만 있는 경우)는 D+0~D+20 그룹 분류 건너뜀
  if (earlySignals.length > 0) {
    if (isTodayNew) {
      const rec = { ...baseRecord, isTodayNew: true };
      rec.auxTags = ['NEW_TODAY', ...(rec.auxTags || [])];
      todayQvaCandidates.push(rec);
      debugCounts.qvaCandidatesTodayAfterFilters++;
    } else if (isTodayReconfirm && !hasVvi) {
      const rec = { ...baseRecord };
      rec.auxTags = ['TODAY_RECONFIRMED', ...(rec.auxTags || [])];
      rec.todayReconfirmed = true;
      todayQvaCandidates.push(rec);
      debugCounts.qvaTodayReconfirmedCount++;
    } else if (!hasVvi) {
      earlyQvaCandidates.push(baseRecord);
      debugCounts.qvaTrackingCandidates20d++;
    }
    if (hasVvi) debugCounts.qvaTrackingHasVviCount++;
  }

  // ─── 장기 QVA 분류 (D+21 ~ D+40) ─────────────────────────────────────
  // 조건: D+0~D+20 안에 통과 흔적은 없고, D+21~D+40에만 firstSignal이 있음.
  //       VVI/H 미전환 + signalPrice 대비 -10% 이상 무너지지 않음.
  // earlySignals 안에 통과가 있으면 그건 정식 추적 단계라 장기 분류 안 함.
  // (= earlySignals가 비어있고 longQvaSignals만 있는 종목만 장기 후보)
  if (earlySignals.length === 0 && longQvaSignals.length > 0) {
    debugCounts.longQvaScanned++;
    longQvaSignals.sort((a, b) => a.idx - b.idx);
    const longFirstSig = longQvaSignals[0];
    const longBestSig = longQvaSignals.reduce((acc, s) => s.score > acc.score ? s : acc, longQvaSignals[0]);
    const longLatestSig = longQvaSignals[longQvaSignals.length - 1];
    const daysSinceLong = todayIdx - longFirstSig.idx;
    const longSignalPrice = rows[longFirstSig.idx].close;
    const longCurrentReturn = (todayRow.close / longSignalPrice - 1) * 100;

    // 만료 — signalPrice 대비 -10% 이상 무너짐
    if (longCurrentReturn <= LONG_QVA_DROP_THRESHOLD_PCT) {
      debugCounts.longQvaExpired++;
      continue; // 보드에서 제외 (장기 추적 가치 없음)
    }

    // VVI/H 미전환 (VVI2 absorption, 2026-05-17 통일) — longFirstSig.idx 이후 VVI2 발화 여부
    let longHasVvi = false;
    let longVviDate = null;
    if (longFirstSig.idx < todayIdx) {
      const maxScan = todayIdx - longFirstSig.idx;
      const v2 = findVvi2AfterQva2(rows, longFirstSig.idx, maxScan, { qva2Type: 'absorption' });
      if (v2.vvi2Idx > longFirstSig.idx) { longHasVvi = true; longVviDate = rows[v2.vvi2Idx].date; }
    }
    if (longHasVvi) continue; // VVI/H로 이미 진행 — 별도 단계에서 추적

    // 재점화 점수 계산
    const reactScore = computeLongQvaReactivationScore(rows, todayIdx, longFirstSig.idx, longSignalPrice);

    // signalIdx ~ todayIdx 사이 최대/최저 추적 — MFE / 최근 고점 / 그 후 하락폭
    let mfeHigh = longSignalPrice, mfeHighIdx = longFirstSig.idx;
    let maeLow = longSignalPrice;
    for (let k = longFirstSig.idx; k <= todayIdx; k++) {
      const r = rows[k];
      if (r.high > mfeHigh) { mfeHigh = r.high; mfeHighIdx = k; }
      if (r.low < maeLow) maeLow = r.low;
    }
    const mfeFromSignal = (mfeHigh / longSignalPrice - 1) * 100;
    const maeFromSignal = (maeLow / longSignalPrice - 1) * 100;
    const dropFromMfeHigh = mfeHigh > 0 ? (todayRow.close / mfeHigh - 1) * 100 : 0;
    const daysSinceMfeHigh = todayIdx - mfeHighIdx;

    // ─── 강화된 분류 (사용자 spec 2026-05 v2) ───
    //   BREAKOUT_DONE : qvaReturnPct > 20  OR  mfeFromSignal > 20
    //                   (현재가가 안 올라 보여도 한 번이라도 +20% 찍었으면 분리)
    //   REACTIVE      : qvaReturnPct ≤ 12  AND  mfeFromSignal ≤ 20  AND  score ≥ 80
    //                   (정말 아직 안 오른 신규 후보)
    //   INTEREST      : qvaReturnPct ≤ 20  AND  mfeFromSignal ≤ 25  AND  score ≥ 60
    //                   (점수 80+여도 +12% 초과면 자연스럽게 INTEREST로 강등)
    //   WATCH         : score 40~59
    //   TRACKING      : 그 외
    const qvaReturnPct = longCurrentReturn;
    let tier, label;
    if (qvaReturnPct > 20 || mfeFromSignal > 20) {
      tier = 'BREAKOUT_DONE';
      label = 'QVA 성공 후 상승';
    } else if (qvaReturnPct <= 12 && mfeFromSignal <= 20 && reactScore.score >= 80) {
      tier = 'REACTIVE';
      label = '장기 QVA 재점화';
    } else if (qvaReturnPct <= 20 && mfeFromSignal <= 25 && reactScore.score >= 60) {
      tier = 'INTEREST';
      label = '장기 QVA 관심';
    } else if (reactScore.score >= 40) {
      tier = 'WATCH';
      label = '장기 QVA 관찰';
    } else {
      tier = 'TRACKING';
      label = '장기 추적 유지';
    }

    // 눌림 대기 태그 — BREAKOUT_DONE 안에서 다음 조건 충족 시 (사용자 spec v2)
    //   maxGainSinceQva ≥ 20 AND  -15 ≤ dropFromMfeHigh ≤ -7  AND  close ≥ ma20 × 0.98
    let pullbackWait = false;
    if (tier === 'BREAKOUT_DONE') {
      const ma20 = reactScore.metrics?.ma20;
      const dropOk = dropFromMfeHigh <= -7 && dropFromMfeHigh >= -15;
      const ma20Ok = ma20 != null && todayRow.close >= ma20 * 0.98;
      pullbackWait = mfeFromSignal >= 20 && dropOk && ma20Ok;
    }

    const auxTags = ['LONG_QVA_' + tier];
    if (pullbackWait) auxTags.push('PULLBACK_WAIT');

    longQvaCandidates.push({
      code,
      name: meta.name,
      market: meta.market,
      isPreferred: isPreferredStock(meta.name),
      marketValue: meta.marketValue,

      firstEarlyQvaDate: longFirstSig.date,
      latestEarlyQvaDate: longLatestSig.date,
      bestEarlyQvaDate: longBestSig.date,
      bestEarlyQvaScore: longBestSig.score,
      bestEarlyQvaGrade: longBestSig.grade,
      bestEarlyQvaGradeLabel: longBestSig.gradeLabel,
      earlyQvaSignalCount: longQvaSignals.length,
      daysSinceFirst: daysSinceLong,

      anchorPrice: longSignalPrice,
      currentDate: TODAY,
      currentClose: todayRow.close,
      currentReturnFromSignal: round2(qvaReturnPct),

      // 새 추적 필드
      mfeFromSignal: round2(mfeFromSignal),
      maeFromSignal: round2(maeFromSignal),
      mfeHighDate: rows[mfeHighIdx].date,
      mfeHighPrice: mfeHigh,
      dropFromMfeHigh: round2(dropFromMfeHigh),
      daysSinceMfeHigh,

      longQvaReactivationScore: reactScore.score,
      longQvaTier: tier,
      longQvaLabel: label,
      longQvaChecks: reactScore.checks,
      longQvaMetrics: reactScore.metrics,
      pullbackWait,

      signals: longBestSig.signals,
      auxTags,
    });
    debugCounts.longQvaIncluded++;
  }
}
process.stdout.write(`  QVA 진행 ${files.length}/${files.length}\n`);

// ─── Cross-reference: 같은 종목이 여러 stage / 다른 보드에 동시 등장하는 경우 명시 ───
// 헷갈림 방지용 (같은 종목 다중 노출 자체는 보드 설계상 정상이지만 카드에 명시해서 사용자 혼선 방지).
{
  const trackingByCode = new Map();
  for (const c of candidates) {
    if (['BREAKOUT_SUCCESS', 'VVI_FIRED', 'QVA_TRACKING', 'QVA_NEW'].includes(c.mainStage)) {
      trackingByCode.set(c.code, c);
    }
  }
  // QVA_TODAY 종목이 funnel에 이미 살아있으면 그 사이클 정보 부착
  for (const t of todayQvaCandidates) {
    const existing = trackingByCode.get(t.code);
    if (existing) {
      t.existingTracking = {
        mainStage: existing.mainStage,
        qvaSignalDate: existing.qvaSignalDate,
        daysSinceQva: existing.daysSinceQva,
        vviDate: existing.vviDate || null,
        breakoutDate: existing.breakoutDate || null,
      };
    }
  }
  // candidates(QVA_TRACKING/VVI_FIRED/BREAKOUT_SUCCESS) → 오늘 새 QVA 이벤트가 있으면 부착
  // QVA_NEW main stage는 자체가 D=0 신규라 중복 의미 없어서 제외.
  const todayByCode = new Map(todayQvaCandidates.map(t => [t.code, t]));
  for (const c of candidates) {
    if (c.mainStage === 'QVA_NEW') continue;
    const today = todayByCode.get(c.code);
    if (today && (today.todayReconfirmed === true || today.isTodayNew === true)) {
      c.todayReconfirmEvent = {
        score: today.bestEarlyQvaScore,
        grade: today.bestEarlyQvaGrade,
        date: today.bestEarlyQvaDate,
      };
    }
  }

  // 다른 보드와의 cross-reference (qva-vvi-redefined / qva2-watchlist)
  const crossBoardLookup = new Map();
  function addCross(code, ref) {
    if (!crossBoardLookup.has(code)) crossBoardLookup.set(code, []);
    crossBoardLookup.get(code).push(ref);
  }
  try {
    const vviPath = path.join(ROOT, 'reports', 'qva-vvi-redefined-board-result.json');
    if (fs.existsSync(vviPath)) {
      const vvi = JSON.parse(fs.readFileSync(vviPath, 'utf-8'));
      const groups = vvi.visibleGroups || {};
      const labels = {
        stableBreakoutCandidates: '🎯 VVI2 확정 (안정형)',
        strongValueBreakoutCandidates: '🎯 VVI2 확정 (강한 거래)',
        valueInsufficientPreviewCandidates: '👀 거래대금 부족 돌파',
        waitingPreviewCandidates: '⏳ VVI2 대기',
      };
      for (const k of Object.keys(labels)) {
        for (const it of (groups[k] || [])) addCross(it.code, { board: 'vvi-redefined', label: labels[k] });
      }
    }
  } catch (_) {}
  try {
    const q2Path = path.join(ROOT, 'reports', 'qva2-watchlist-board.json');
    if (fs.existsSync(q2Path)) {
      const q2 = JSON.parse(fs.readFileSync(q2Path, 'utf-8'));
      const stagesQ2 = q2.stages || {};
      const labels = {
        BREAKOUT_SUCCESS: 'QVA2 H그룹',
        VVI2_FIRED: 'QVA2 VVI2 발화',
        QVA2_NEW: 'QVA2 신규',
        QVA2_TRACKING: 'QVA2 추적',
      };
      for (const k of Object.keys(labels)) {
        for (const it of (stagesQ2[k] || [])) addCross(it.code, { board: 'qva2', label: labels[k] });
      }
    }
  } catch (_) {}
  for (const arr of [candidates, todayQvaCandidates, longQvaCandidates]) {
    for (const c of arr) {
      const refs = crossBoardLookup.get(c.code);
      if (refs) c.crossBoardRefs = refs;
    }
  }
}

console.log(`→ QVA_TODAY (오늘 통과 = 신규 + 재확인): ${todayQvaCandidates.length}건  (신규 ${debugCounts.qvaCandidatesTodayAfterFilters} + 재확인 ${debugCounts.qvaTodayReconfirmedCount})`);
console.log(`→ EARLY_QVA (추적 중, D+1~D+20, VVI 전): ${earlyQvaCandidates.length}건`);
console.log(`  (윈도우 안 통과 후 VVI 이미 발생: ${debugCounts.qvaTrackingHasVviCount}건 — VVI_FIRED/BREAKOUT_SUCCESS 단계에서 추적)`);
console.log(`→ 장기 QVA (D+${LONG_QVA_START}~D+${LONG_QVA_END}, VVI/H 미전환): ${longQvaCandidates.length}건  (스캔 ${debugCounts.longQvaScanned} 중 만료 ${debugCounts.longQvaExpired}건 제외)`);
const longTierBreakdown = longQvaCandidates.reduce((acc, c) => { acc[c.longQvaTier] = (acc[c.longQvaTier] || 0) + 1; return acc; }, {});
const pullbackCount = longQvaCandidates.filter(c => c.pullbackWait).length;
console.log(`  └ 재점화 ${longTierBreakdown.REACTIVE || 0} / 관심 ${longTierBreakdown.INTEREST || 0} / 이미 급등 ${longTierBreakdown.BREAKOUT_DONE || 0} (눌림 대기 ${pullbackCount}) / 관찰 ${longTierBreakdown.WATCH || 0} / 추적 ${longTierBreakdown.TRACKING || 0}`);
console.log(`  (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

// ─── QVA 후보에 'CONFIRMED_QVA_PASS' 보조 태그 부여 (기존 태그 보존) ───
const confirmedQvaCodeSet = new Set(candidates.map(c => c.code));
let confirmedPassCount = 0;
for (const arr of [todayQvaCandidates, earlyQvaCandidates, longQvaCandidates]) {
  for (const ec of arr) {
    if (confirmedQvaCodeSet.has(ec.code)) {
      ec.auxTags = [...(ec.auxTags || []), 'CONFIRMED_QVA_PASS'];
      ec.confirmedQvaPass = true;
      confirmedPassCount++;
    } else {
      ec.confirmedQvaPass = false;
    }
  }
}
console.log(`→ QVA 후보 중 '확인 QVA 통과' 태그: ${confirmedPassCount}건`);

// ─────────── 단계별 그룹핑 ───────────
// 사용자 spec(2026-05): UX 단순화 + 장기 QVA 추가.
//   QVA_TODAY            = 오늘 통과 (신규 + 재확인) — 행 태그로 구분
//   EARLY_QVA            = D+1~D+20 추적 중 (VVI 전)
//   LONG_QVA_REACTIVE    = D+21~D+40, longQvaReactivationScore ≥ 80 (재점화)
//   LONG_QVA_INTEREST    = D+21~D+40, score 60~79 (관심)
//   LONG_QVA_ALL         = D+21~D+40 전체 (기본 접힘)
const stageOrder = ['BREAKOUT_SUCCESS', 'VVI_FIRED', 'QVA_TODAY', 'EARLY_QVA', 'LONG_QVA_REACTIVE', 'LONG_QVA_INTEREST', 'LONG_QVA_BREAKOUT_DONE', 'LONG_QVA_ALL', 'FAILED'];
const allStageOrder = ['BREAKOUT_SUCCESS', 'VVI_FIRED', 'QVA_TODAY', 'QVA_TRACKING', 'QVA_NEW', 'EARLY_QVA', 'LONG_QVA_REACTIVE', 'LONG_QVA_INTEREST', 'LONG_QVA_BREAKOUT_DONE', 'LONG_QVA_ALL', 'FAILED'];
const stageLabels = {
  BREAKOUT_SUCCESS: '돌파 성공 확인 종목',
  VVI_FIRED: '다음 거래일 돌파 대기',
  QVA_TRACKING: 'QVA 확인 추적 중',
  QVA_NEW: 'QVA 확인 신규',
  QVA_TODAY: '오늘 QVA',
  EARLY_QVA: 'QVA 추적 중',
  LONG_QVA_REACTIVE: '장기 QVA 재점화',
  LONG_QVA_INTEREST: '장기 QVA 관심',
  LONG_QVA_BREAKOUT_DONE: 'QVA 성공 후 상승',
  LONG_QVA_ALL: '장기 QVA 전체',
  FAILED: '실패/이탈',
};
const stageDescriptions = {
  BREAKOUT_SUCCESS:
    '돌파 성공(H그룹) 종목은 VVI2 돌파대기일 종가 × 1.01(=기준선)을 다음 거래일 고가가 돌파한 후보입니다. 각 종목의 VPR 태그는 그 돌파 이후 반응(고가권 유지/기준선 위 마감/기준 종가 위 유지/장중 돌파 후 밀림/과열 돌파)을 분류한 해석 라벨이며, 성공/실패 판정이나 매수 추천이 아닙니다.',
  VVI_FIRED:
    'VVI2는 QVA 후보 중 실제 거래대금 초동이 더 강하게 확인된 상태입니다. VVI2 다음 거래일에 vviHigh × 1.01 돌파 여부를 기다리는 후보입니다.',
  QVA_TRACKING:
    'QVA 발생 후 20거래일 동안 VVI2 발생 여부를 지켜보는 후보입니다. QVA 단독은 관심 후보로 보고, VVI2/돌파 단계까지 진행되는지 추적합니다.',
  QVA_NEW:
    'QVA 확인 신규는 처음 관심 후보로 잡는 단계입니다. 바로 매수하기보다는 20거래일 동안 VVI2 발생 여부를 추적하는 후보로 보는 것이 적절합니다.',
  QVA_TODAY:
    '오늘 QVA 조건을 통과한 종목입니다. "오늘 신규" 태그는 오늘 처음 QVA로 감지된 종목, "오늘 재확인" 태그는 과거에 잡혔고 오늘도 조건을 다시 만족한 종목입니다 (같은 흐름의 연속 발화). QVA는 발생 후 20거래일 동안 VVI2로 이어지는지 추적합니다.',
  EARLY_QVA:
    '최근 20거래일 안에 QVA가 발생했고, 오늘은 통과 못했지만 아직 VVI2 확인 전인 관심 후보입니다. QVA → VVI2 전환률은 1년 검증에서 약 11%이므로 대부분의 추적 후보는 VVI2까지 진행되지 않지만, 일부는 VVI2/돌파 성공으로 진화합니다. 매수 신호가 아니라 관찰 후보입니다.',
  LONG_QVA_REACTIVE:
    '장기 QVA 재점화는 D+21~D+40 구간에서 아직 크게 오르지 않은 종목 중, 거래대금과 가격 흐름이 다시 살아나는 후보입니다. QVA 대비 현재 수익률(+12% 이내)과 최고 상승률(+20% 이내)이 모두 과하지 않은 종목만 표시합니다 (재점화 점수 80+).',
  LONG_QVA_INTEREST:
    '장기 QVA 관심은 D+21~D+40 구간, QVA 대비 +20% 이내 + 최고 상승률 +25% 이내, 재점화 점수 60~79인 후보입니다. 점수 80+여도 현재 수익률이 +12% 초과면 이 섹션으로 내려옵니다.',
  LONG_QVA_BREAKOUT_DONE:
    'QVA 이후 이미 +20% 이상 상승 구간이 나온 종목입니다 (현재가 +20% 초과 OR 최고 상승 +20% 초과). 신규 진입 후보라기보다 성과 확인 또는 눌림 관찰 대상으로 봅니다. "눌림 대기" 태그는 최고 상승 +20% 이상 + 고점 대비 -7~-15% 조정 + MA20 × 0.98 위 유지 — 눌림 확인용 후보입니다.',
  LONG_QVA_ALL:
    '장기 QVA 전체는 D+21~D+40 구간에 머물러 있는 모든 추적 후보입니다 (분류 무관). 위쪽 섹션에 노출되지 않은 종목까지 포함합니다. 기본 접힘.',
  FAILED:
    'QVA 이후 가격이 크게 무너졌거나, 20거래일 안에 VVI2가 발생하지 않았거나, 돌파에 실패한 종목입니다.',
};

// 섹션 상단 안내 박스 (백테스트 요약) — 작은 톤
// 헤더에 VPR 정의 + 7개 라벨 펼침 도움말이 이미 있으므로, 섹션은 백테스트 요약 1줄만.
const stageBacktestNotes = {
  BREAKOUT_SUCCESS: {
    summary: '⚠️ <strong>먼저 "돌파일(기준일)" 컬럼을 꼭 확인하세요.</strong> H그룹은 돌파일 후 <strong>최대 5거래일(D+0~D+5)간 계속 노출</strong>되므로 어제 돌파한 종목과 5일 전 돌파한 종목이 같이 표시됩니다. <strong>정렬 기준: 돌파일 최신순 → VPR 메인 태그 → 수익률.</strong> 오늘 종가가 하락했어도 5일 안이면 정상 관찰 구간이고, D+5가 지나면 자동으로 목록에서 빠집니다. 종목별 매수 등급 태그는 붙이지 않습니다 — VPR · 거리 · 위꼬리 · 거래대금 정보를 직접 보고 판단하세요. (조건 조합별 성과 참고는 화면 상단의 "D+5 백테스트 조합별 성과표" 펼쳐 보기.)',
  },
};

const auxTagLabels = {
  PRICE_HOLD: '가격 유지',
  LOW_RISING: '저점 상승',
  VALUE_REACTIVATION: '거래대금 재활성',
  CONFIRMED_QVA_PASS: 'QVA 확인 통과',
  NEW_TODAY: '오늘 신규',
  TODAY_RECONFIRMED: '오늘 재확인',
  LONG_QVA_REACTIVE: '장기 재점화',
  LONG_QVA_INTEREST: '장기 관심',
  LONG_QVA_BREAKOUT_DONE: '이미 급등',
  LONG_QVA_WATCH: '장기 관찰',
  LONG_QVA_TRACKING: '장기 추적',
  PULLBACK_WAIT: '눌림 대기',
};
const auxTagDescriptions = {
  PRICE_HOLD: '현재 종가가 QVA 신호가의 95% 이상',
  LOW_RISING: '최근 5거래일 저가 최소값 > 그 이전 5거래일 저가 최소값',
  VALUE_REACTIVATION: '오늘 거래대금이 직전 20일 중앙값의 3배 이상',
  CONFIRMED_QVA_PASS: 'QVA 이후 가격 유지·저점 상승·거래대금 흐름이 한 번 더 확인된 상태입니다.',
  NEW_TODAY: '오늘 처음 QVA로 감지된 종목입니다 (firstSignalDate === 오늘).',
  TODAY_RECONFIRMED: '과거에 QVA로 잡혔고 오늘도 조건을 다시 만족한 종목입니다 (같은 흐름의 연속 발화).',
  LONG_QVA_REACTIVE: 'D+21~D+40, QVA 대비 ≤ +12% AND 최고 ≤ +20%, 재점화 점수 80+',
  LONG_QVA_INTEREST: 'D+21~D+40, QVA 대비 ≤ +20% AND 최고 ≤ +25%, 점수 60+',
  LONG_QVA_BREAKOUT_DONE: 'QVA 이후 +20% 이상 상승 구간 발생 — 신규 진입보다는 성과/눌림 관찰',
  LONG_QVA_WATCH: 'D+21~D+40, 재점화 점수 40~59',
  LONG_QVA_TRACKING: 'D+21~D+40, 재점화 점수 40 미만',
  PULLBACK_WAIT: '최고 상승 +20% 이상 + 고점 대비 -7~-15% 조정 + MA20 × 0.98 위 유지 — 눌림 확인용 후보',
};

// 진입 판단 상태 — BREAKOUT_SUCCESS 그룹 내 분류
const judgmentOrder = ['REVIEW_OK', 'CHASE_CAUTION', 'PULLBACK_WAIT', 'MANAGEMENT', 'BREAKDOWN_WEAK'];
const judgmentLabels = {
  REVIEW_OK: '진입가 근처',
  CHASE_CAUTION: '추격 주의',
  PULLBACK_WAIT: '눌림 대기',
  MANAGEMENT: '관리 구간',
  BREAKDOWN_WEAK: '돌파 약화',
};
// 문구는 3년+flow 백테스트(이벤트 448건) 운영 해석 기준 (2026-05-05).
const judgmentDescriptions = {
  REVIEW_OK: '기준 진입가에서 크게 멀어지지 않은 상태입니다. 매수 추천이 아니라 추격을 피하기 위한 가격 위치 확인 기준입니다.',
  CHASE_CAUTION: '진입가 대비 +3% ~ +7% — 추격 시 주의가 필요한 구간.',
  PULLBACK_WAIT: '진입가 대비 +7% 초과 또는 돌파 후 3일 경과 — 눌림 확인 후 재검토 권장.',
  MANAGEMENT: '이미 상승이 진행된 상태입니다. 단기 흔들림은 있을 수 있지만, H+10 기준으로는 강한 추세가 이어진 경우가 많았습니다. 신규 진입은 기준가와의 거리 확인이 필요하고, 보유자는 관리 관점으로 볼 수 있습니다.',
  BREAKDOWN_WEAK: '돌파 이후 흐름이 약해진 상태입니다 (기준선 또는 기준 진입가 아래로 마감). 신규 진입은 피하는 것이 안전한 구간입니다.',
};

function groupBy(items, fn) {
  const m = new Map();
  for (const it of items) {
    const k = fn(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

const byStage = groupBy(candidates, c => c.mainStage);
const stageCounts = {};
for (const s of allStageOrder) stageCounts[s] = byStage.get(s)?.length || 0;
// QVA_TODAY/EARLY_QVA/LONG_QVA_*는 별도 후보 리스트
stageCounts.QVA_TODAY = todayQvaCandidates.length;
stageCounts.EARLY_QVA = earlyQvaCandidates.length;
stageCounts.LONG_QVA_REACTIVE = longQvaCandidates.filter(c => c.longQvaTier === 'REACTIVE').length;
stageCounts.LONG_QVA_INTEREST = longQvaCandidates.filter(c => c.longQvaTier === 'INTEREST').length;
stageCounts.LONG_QVA_BREAKOUT_DONE = longQvaCandidates.filter(c => c.longQvaTier === 'BREAKOUT_DONE').length;
stageCounts.LONG_QVA_ALL = longQvaCandidates.length;

// ─────────── 정렬 (각 단계별로 보기 좋게) ───────────
function sortStage(stage, items) {
  const arr = items.slice();
  switch (stage) {
    case 'BREAKOUT_SUCCESS': {
      // VPR 메인 태그 기반 정렬 (안정적 반응 → 밀림 → 과열은 별도 그룹):
      // 1. 고가권 유지        HIGH_ZONE_HOLD
      // 2. 기준선 위 마감     ABOVE_BREAKOUT_LINE
      // 3. 기준 종가 위 유지  ABOVE_BASE_CLOSE
      // 4. 장중 돌파 후 밀림   INTRADAY_PUSHBACK
      // 5. 과열 돌파          OVERHEATED_BREAKOUT (별도 주의 — 좋은 신호 아님)
      // 6. 미분류 (vprMain 없음)
      function bsRank(c) {
        const m = c.vprMain;
        if (m === 'HIGH_ZONE_HOLD') return 1;
        if (m === 'ABOVE_BREAKOUT_LINE') return 2;
        if (m === 'ABOVE_BASE_CLOSE') return 3;
        if (m === 'INTRADAY_PUSHBACK') return 4;
        if (m === 'OVERHEATED_BREAKOUT') return 5;
        return 6;
      }
      // 사용자 요청(2026-05-06): 기준일(돌파일) 최신순 우선 정렬.
      // D+5 노출 윈도우 안에서 같은 종목이 5일간 계속 보이는데 새 돌파 종목이 위에 와야 인지 쉬움.
      arr.sort((a, b) => {
        // 1차: 기준일(돌파일) 최신순 — 오늘 돌파한 게 맨 위
        const da = a.breakoutDate || '00000000';
        const db = b.breakoutDate || '00000000';
        if (da !== db) return db.localeCompare(da);
        // 2차: VPR 메인 태그 우선순위
        const ra = bsRank(a), rb = bsRank(b);
        if (ra !== rb) return ra - rb;
        // 3차: 신호가 대비 수익률
        return (b.currentReturnFromSignal ?? -Infinity) - (a.currentReturnFromSignal ?? -Infinity);
      });
      break;
    }
    case 'VVI_FIRED':
      // 신호가 대비 수익률 높은 순 (= 돌파 가능성 높을 가능성)
      arr.sort((a, b) => (b.currentReturnFromSignal ?? -Infinity) - (a.currentReturnFromSignal ?? -Infinity));
      break;
    case 'QVA_TRACKING':
      // watchScore 높은 순 → 거래대금 큰 순 → D+ 작은 순
      arr.sort((a, b) => {
        if ((b.watchScore ?? 0) !== (a.watchScore ?? 0)) return (b.watchScore ?? 0) - (a.watchScore ?? 0);
        if ((b.currentValue ?? 0) !== (a.currentValue ?? 0)) return (b.currentValue ?? 0) - (a.currentValue ?? 0);
        return (a.daysSinceQva ?? 0) - (b.daysSinceQva ?? 0);
      });
      break;
    case 'QVA_NEW':
      // 거래대금 큰 순
      arr.sort((a, b) => (b.qvaSignalTradingValue ?? 0) - (a.qvaSignalTradingValue ?? 0));
      break;
    case 'FAILED':
      // 가장 최근 이탈/실패부터
      arr.sort((a, b) => (b.daysSinceQva ?? 0) - (a.daysSinceQva ?? 0));
      break;
  }
  return arr;
}

// 사용자 spec(2026-05-06): 정예형/보수형/공격형/기본형 같은 운영 태그는 종목 행에 부착하지 않는다.
// 분류는 헤더의 "D+5 백테스트 조합별 성과표"에서만 노출. 개별 종목은 사용자가 VPR·거리·위꼬리·거래대금을
// 직접 보고 판단하도록 단순하게 유지한다.

const stagedItems = {};
// 내부 로직용 — 모든 단계를 stagedItems에 저장 (qvaTracking 미리보기, 백테스트 등)
for (const s of allStageOrder) {
  stagedItems[s] = sortStage(s, byStage.get(s) || []);
}
// QVA 정렬 함수 (사용자 spec)
//   1) QVA 점수 높은 순 → 2) valueRatioMedian → 3) returnFromLow20 ↑ → 4) todayValue ↓
function sortQvaCandidates(arr) {
  return arr.slice().sort((a, b) => {
    const sA = a.bestEarlyQvaScore ?? 0, sB = b.bestEarlyQvaScore ?? 0;
    if (sB !== sA) return sB - sA;
    const tA = a.signals?.valueRatioMedian ?? 0, tB = b.signals?.valueRatioMedian ?? 0;
    if (tB !== tA) return tB - tA;
    const rA = a.signals?.returnFromLow20 ?? 0, rB = b.signals?.returnFromLow20 ?? 0;
    if (rA !== rB) return rA - rB;
    const vA = a.signals?.todayValue ?? 0, vB = b.signals?.todayValue ?? 0;
    return vB - vA;
  });
}
// 추적 중 섹션 — '오늘 재확인' 항목을 상단으로 우선 정렬한 다음 일반 점수 순
function sortTrackingCandidates(arr) {
  return arr.slice().sort((a, b) => {
    const reconfA = a.todayReconfirmed ? 0 : 1;
    const reconfB = b.todayReconfirmed ? 0 : 1;
    if (reconfA !== reconfB) return reconfA - reconfB;
    const sA = a.bestEarlyQvaScore ?? 0, sB = b.bestEarlyQvaScore ?? 0;
    if (sB !== sA) return sB - sA;
    const tA = a.signals?.valueRatioMedian ?? 0, tB = b.signals?.valueRatioMedian ?? 0;
    if (tB !== tA) return tB - tA;
    const rA = a.signals?.returnFromLow20 ?? 0, rB = b.signals?.returnFromLow20 ?? 0;
    if (rA !== rB) return rA - rB;
    const vA = a.signals?.todayValue ?? 0, vB = b.signals?.todayValue ?? 0;
    return vB - vA;
  });
}

// QVA_TODAY 정렬: 점수 높은 순 (신규/재확인 구분 없이) — 사용자 spec
const todayQvaSorted = sortQvaCandidates(todayQvaCandidates);
const earlyQvaSorted = sortTrackingCandidates(earlyQvaCandidates);

// 장기 QVA 정렬 (사용자 spec)
//   1) longQvaReactivationScore 높은 순
//   2) currentReturnFromSignal 높은 순 (QVA 대비 현재 수익률)
//   3) recent3 거래대금 배율 높은 순
//   4) bestEarlyQvaScore 높은 순
//   5) daysSinceFirst 낮은 순
function sortLongQvaCandidates(arr) {
  return arr.slice().sort((a, b) => {
    const sA = a.longQvaReactivationScore ?? 0, sB = b.longQvaReactivationScore ?? 0;
    if (sB !== sA) return sB - sA;
    const rA = a.currentReturnFromSignal ?? 0, rB = b.currentReturnFromSignal ?? 0;
    if (rB !== rA) return rB - rA;
    const vA = a.longQvaMetrics?.valueRatio3Avg ?? 0, vB = b.longQvaMetrics?.valueRatio3Avg ?? 0;
    if (vB !== vA) return vB - vA;
    const qA = a.bestEarlyQvaScore ?? 0, qB = b.bestEarlyQvaScore ?? 0;
    if (qB !== qA) return qB - qA;
    return (a.daysSinceFirst ?? 0) - (b.daysSinceFirst ?? 0);
  });
}
const longQvaSorted = sortLongQvaCandidates(longQvaCandidates);
const longQvaReactiveDisplayed = longQvaSorted.filter(c => c.longQvaTier === 'REACTIVE');
const longQvaInterestDisplayed = longQvaSorted.filter(c => c.longQvaTier === 'INTEREST');
// 이미 급등 — qvaReturnPct 높은 순으로 정렬 (Large gain 먼저), 같으면 재점화 점수
const longQvaBreakoutDoneDisplayed = longQvaSorted.filter(c => c.longQvaTier === 'BREAKOUT_DONE')
  .sort((a, b) => {
    if (a.pullbackWait !== b.pullbackWait) return a.pullbackWait ? -1 : 1; // 눌림 대기 우선
    return (b.currentReturnFromSignal ?? 0) - (a.currentReturnFromSignal ?? 0);
  });

// 화면 표시 — 통과한 모든 종목을 보여주되 최대 50개로 제한 (사용자 spec).
// 50건 이하면 전부 표시 / 50건 초과면 상위 50개 + 나머지는 '전체 보기' 토글.
const EARLY_QVA_DISPLAY_THRESHOLD = 0;
const EARLY_QVA_DISPLAY_LIMIT = 50;
const todayQvaDisplayed = todayQvaSorted.slice(0, EARLY_QVA_DISPLAY_LIMIT);
const earlyQvaDisplayed = earlyQvaSorted.slice(0, EARLY_QVA_DISPLAY_LIMIT);

stagedItems.QVA_TODAY = todayQvaDisplayed;
stagedItems.QVA_TODAY_ALL = todayQvaSorted;
stagedItems.EARLY_QVA = earlyQvaDisplayed;
stagedItems.EARLY_QVA_ALL = earlyQvaSorted;
// 장기 QVA — 4개 섹션 (사용자 spec)
stagedItems.LONG_QVA_REACTIVE = longQvaReactiveDisplayed.slice(0, EARLY_QVA_DISPLAY_LIMIT);
stagedItems.LONG_QVA_INTEREST = longQvaInterestDisplayed.slice(0, EARLY_QVA_DISPLAY_LIMIT);
stagedItems.LONG_QVA_BREAKOUT_DONE = longQvaBreakoutDoneDisplayed.slice(0, EARLY_QVA_DISPLAY_LIMIT);
stagedItems.LONG_QVA_ALL = longQvaSorted.slice(0, EARLY_QVA_DISPLAY_LIMIT);
stagedItems.LONG_QVA_ALL_FULL = longQvaSorted;

// 요약 통계 — TODAY(신규+재확인 통합) + TRACKING 합쳐서 계산
const allQvaCandidates = [...todayQvaSorted, ...earlyQvaSorted];
const strongEarlyCount = allQvaCandidates.filter(c => c.bestEarlyQvaGrade === 'STRONG_REDEFINED_QVA' || c.bestEarlyQvaGrade === 'STRONG_EARLY_QVA').length;
const earlyMidCount = allQvaCandidates.filter(c => c.bestEarlyQvaGrade === 'REDEFINED_QVA' || c.bestEarlyQvaGrade === 'EARLY_QVA').length;
const watchEarlyCount = allQvaCandidates.filter(c => c.bestEarlyQvaGrade === 'WATCH_REDEFINED' || c.bestEarlyQvaGrade === 'WATCH_EARLY').length;
const avgEarlyScore = allQvaCandidates.length > 0
  ? Math.round(allQvaCandidates.reduce((s, c) => s + (c.bestEarlyQvaScore || 0), 0) / allQvaCandidates.length)
  : 0;
const valueReactivationCount = allQvaCandidates.filter(c => (c.signals?.valueRatioMedian ?? 0) >= 3.0).length;
const higherLowCount = allQvaCandidates.filter(c => (c.signals?.returnFromLow20 ?? 99) <= 5).length;
const priceHoldCount = allQvaCandidates.filter(c => (c.currentReturnFromSignal ?? -1) >= 0).length;

// 오늘 통과 안에서 신규/재확인 카운트 (행 태그 기반)
const todayNewCount = todayQvaSorted.filter(c => c.isTodayNew === true).length;
const todayReconfirmedCount = todayQvaSorted.filter(c => c.todayReconfirmed === true).length;
const longQvaReactiveCount = longQvaSorted.filter(c => c.longQvaTier === 'REACTIVE').length;
const longQvaInterestCount = longQvaSorted.filter(c => c.longQvaTier === 'INTEREST').length;
const longQvaBreakoutDoneCount = longQvaSorted.filter(c => c.longQvaTier === 'BREAKOUT_DONE').length;
const longQvaWatchCount = longQvaSorted.filter(c => c.longQvaTier === 'WATCH').length;
const longQvaTrackingCount = longQvaSorted.filter(c => c.longQvaTier === 'TRACKING').length;
const longQvaPullbackWaitCount = longQvaSorted.filter(c => c.pullbackWait === true).length;
const earlyQvaSummary = {
  todayCount: todayQvaSorted.length,
  todayNewCount,
  todayReconfirmedCount,
  trackingCount: earlyQvaSorted.length,
  pureTrackingCount: earlyQvaSorted.length,
  totalWindowCount: todayQvaSorted.length + earlyQvaSorted.length,
  totalCount: allQvaCandidates.length,
  longQvaTotal: longQvaSorted.length,
  longQvaReactiveCount,
  longQvaInterestCount,
  longQvaBreakoutDoneCount,
  longQvaWatchCount,
  longQvaTrackingCount,
  longQvaPullbackWaitCount,
  strongCount: strongEarlyCount,
  earlyCount: earlyMidCount,
  watchCount: watchEarlyCount,
  displayedCount: earlyQvaDisplayed.length,
  todayDisplayedCount: todayQvaDisplayed.length,
  displayThreshold: EARLY_QVA_DISPLAY_THRESHOLD,
  displayLimit: EARLY_QVA_DISPLAY_LIMIT,
  avgScore: avgEarlyScore,
  valueReactivationCount,
  higherLowCount,
  priceHoldCount,
};

// QVA 디버그 로그
console.log(`\n🌱 QVA 분포 (윈도우 전체 = 오늘 + 추적):`);
console.log(`  오늘 신규:                   ${todayQvaSorted.length}건`);
console.log(`  추적 중 (VVI 전):            ${earlyQvaSorted.length}건`);
console.log(`  STRONG (80+):                ${strongEarlyCount}`);
console.log(`  EARLY (70~79):               ${earlyMidCount}`);
console.log(`  WATCH (60~69):               ${watchEarlyCount}`);
console.log(`  평균 점수:                   ${avgEarlyScore}`);
console.log(`  거래대금 재활성 동반:        ${valueReactivationCount}`);
console.log(`  저점권 (≤+5%):               ${higherLowCount}`);

// stageCounts 갱신 (화면 표시분 기준)
stageCounts.QVA_TODAY = todayQvaDisplayed.length;
stageCounts.EARLY_QVA = earlyQvaDisplayed.length;
stageCounts.LONG_QVA_REACTIVE = stagedItems.LONG_QVA_REACTIVE.length;
stageCounts.LONG_QVA_INTEREST = stagedItems.LONG_QVA_INTEREST.length;
stageCounts.LONG_QVA_BREAKOUT_DONE = stagedItems.LONG_QVA_BREAKOUT_DONE.length;
stageCounts.LONG_QVA_ALL = stagedItems.LONG_QVA_ALL.length;

// ─── 데이터 상태 점검 디버그 (사용자 spec 4번) ───
const recentBreakoutSuccessCount = (stagedItems.BREAKOUT_SUCCESS || []).length;
const vviFiredCount = (stagedItems.VVI_FIRED || []).length;
debugCounts.vviCandidatesToday = vviFiredCount;
debugCounts.breakoutSuccessRecent = recentBreakoutSuccessCount;
debugCounts.latestTradingDate = TODAY;
console.log(`\n🔧 데이터 상태 점검:`);
console.log(`  latestTradingDate:                  ${TODAY}`);
console.log(`  totalUniverseCount (캐시 파일):     ${debugCounts.totalUniverseCount}`);
console.log(`  chartDataAvailableCount(${TODAY}):  ${debugCounts.chartDataAvailableCount}`);
console.log(`  flowDataAvailableCount(${TODAY}):   ${debugCounts.flowDataAvailableCount}`);
console.log(`  qvaCandidatesTodayRaw:              ${debugCounts.qvaCandidatesTodayRaw}`);
console.log(`  qvaCandidatesTodayAfterFilters:     ${debugCounts.qvaCandidatesTodayAfterFilters}`);
console.log(`  qvaTrackingCandidates20d:           ${debugCounts.qvaTrackingCandidates20d}`);
console.log(`  vviCandidatesToday:                 ${debugCounts.vviCandidatesToday}`);
console.log(`  breakoutSuccessRecent:              ${debugCounts.breakoutSuccessRecent}`);
const chartCoverage = debugCounts.totalUniverseCount > 0
  ? (debugCounts.chartDataAvailableCount / debugCounts.totalUniverseCount * 100).toFixed(1)
  : '0';
console.log(`  → 차트 데이터 ${TODAY} 커버리지: ${chartCoverage}% (${debugCounts.chartDataAvailableCount}/${debugCounts.totalUniverseCount})`);

// ─────────── 콘솔 출력 ───────────
console.log(`\n${'='.repeat(120)}`);
console.log(`📊 단계별 후보 수 (메인)`);
for (const s of stageOrder) {
  console.log(`  ${stageLabels[s].padEnd(20)} ${String(stageCounts[s]).padStart(4)} 건`);
}
console.log(`\n📊 단계별 후보 수 (내부 — 화면 비표시)`);
for (const s of allStageOrder) {
  if (stageOrder.includes(s)) continue;
  console.log(`  ${stageLabels[s].padEnd(20)} ${String(stageCounts[s]).padStart(4)} 건`);
}

console.log(`\n💡 보조 태그 분포 (QVA_TRACKING 그룹 내)`);
const tracking = byStage.get('QVA_TRACKING') || [];
for (const tag of Object.keys(auxTagLabels)) {
  const n = tracking.filter(c => c.auxTags.includes(tag)).length;
  const pct = tracking.length > 0 ? (n / tracking.length * 100).toFixed(0) : '0';
  console.log(`  ${auxTagLabels[tag].padEnd(16)} ${String(n).padStart(3)} 건 (${pct}%)`);
}

// 메인 단계별 상위 종목 미리보기
for (const s of ['BREAKOUT_SUCCESS', 'VVI_FIRED', 'QVA_NEW']) {
  const items = stagedItems[s];
  if (items.length === 0) continue;
  console.log(`\n[${stageLabels[s]}] 상위 ${Math.min(items.length, 5)}개`);
  for (const c of items.slice(0, 5)) {
    const ret = c.currentReturnFromSignal != null
      ? (c.currentReturnFromSignal >= 0 ? '+' : '') + c.currentReturnFromSignal.toFixed(2) + '%'
      : '-';
    const vviInfo = c.vviDate ? ` VVI ${formatDate(c.vviDate)}` : '';
    console.log(`  ${c.name?.padEnd(12)} ${c.code} | QVA ${formatDate(c.qvaSignalDate)} D+${c.daysSinceQva}${vviInfo} | 신호가 ${c.qvaSignalPrice?.toLocaleString()} → 현재 ${c.currentClose?.toLocaleString()} (${ret}) | ${c.auxTags.join(',')}`);
  }
}

// ─────────── JSON ───────────
// 최근 5거래일 내 VVI 발생 이력 (참고 섹션) — 메인 단계 분류와 별개로,
// VVI 발생 후 돌파 성공/실패로 어떻게 흘러갔는지 한 화면에 보여준다.
const recentTradingDates = tradingDates.slice(-5);
const recentVviCount = candidates.filter(c => c.vviDate && recentTradingDates.includes(c.vviDate)).length;

const recentVviHistoryItems = candidates
  .filter(c => c.vviDate && recentTradingDates.includes(c.vviDate))
  .map(c => {
    let vviOutcome;
    if (c.breakoutSuccess === true) vviOutcome = 'SUCCESS';
    else if (c.breakoutSuccess === false) vviOutcome = 'FAIL';
    else vviOutcome = 'PENDING';
    return { ...c, vviOutcome };
  })
  .sort((a, b) => {
    if (a.vviDate !== b.vviDate) return b.vviDate.localeCompare(a.vviDate); // 최신 VVI일 우선
    const order = { PENDING: 0, SUCCESS: 1, FAIL: 2 };
    return (order[a.vviOutcome] ?? 9) - (order[b.vviOutcome] ?? 9);
  });

const recentVviHistorySummary = {
  total: recentVviHistoryItems.length,
  success: recentVviHistoryItems.filter(c => c.vviOutcome === 'SUCCESS').length,
  fail: recentVviHistoryItems.filter(c => c.vviOutcome === 'FAIL').length,
  pending: recentVviHistoryItems.filter(c => c.vviOutcome === 'PENDING').length,
};

// QVA 추적 중 그룹 요약 (접힘 상태에서도 보여주는 카드)
const _trk = byStage.get('QVA_TRACKING') || [];
const qvaTrackingSummary = {
  total: _trk.length,
  tag3: _trk.filter(c => (c.auxTags?.length || 0) === 3).length,
  tag2plus: _trk.filter(c => (c.auxTags?.length || 0) >= 2).length,
  priceHold: _trk.filter(c => c.auxTags?.includes('PRICE_HOLD')).length,
  lowRising: _trk.filter(c => c.auxTags?.includes('LOW_RISING')).length,
  valueReactivation: _trk.filter(c => c.auxTags?.includes('VALUE_REACTIVATION')).length,
  riskTag: _trk.filter(c => c.riskTag).length,
  expiringSoon: _trk.filter(c => c.expiringSoon).length,
};
const qvaTrackingTopPreview = (stagedItems['QVA_TRACKING'] || []).slice(0, 10);

const summary = {
  today: TODAY,
  todayDateLabel: formatDate(TODAY),
  todayCalendarDate,
  todayCalendarLabel,
  beforeMarketOpen: _beforeMarketOpen,
  latestTradingDate: TODAY,
  nextTradingDate,
  isMarketClosedToday,
  tradingDateCount,
  recentVviCount,
  trackingDays: TRACKING_DAYS,
  exitThresholdPct: EXIT_THRESHOLD_PCT,
  recentBreakoutDays: RECENT_BREAKOUT_DAYS,
  recentFailedDays: RECENT_FAILED_DAYS,
  totalCandidates: candidates.length,
  stageCounts,
  generatedAt: new Date().toISOString(),
};

const jsonOut = {
  meta: {
    purpose: 'QVA → VVI2 → 돌파 성공의 funnel 전체를 한 화면에 보여주는 매일 운영용 보드',
    notice: '본 보드는 매수 추천이 아니라 후보 추적/모니터링용입니다. 실제 매매는 차트, 뉴스, 시장 상황을 함께 보고 판단해야 합니다.',
    boardBasisNotice: '현재 보드는 최신 거래일 기준으로 생성됩니다. 오늘이 휴장일이면 마지막 거래일 데이터를 기준으로 표시됩니다.',
    today: TODAY,
    todayCalendarDate,
    todayCalendarLabel,
    beforeMarketOpen: _beforeMarketOpen,
    latestTradingDate: TODAY,
    nextTradingDate,
    isMarketClosedToday,
    tradingDateCount,
    recentVviCount,
    trackingDays: TRACKING_DAYS,
    exitThresholdPct: EXIT_THRESHOLD_PCT,
    recentBreakoutDays: RECENT_BREAKOUT_DAYS,
    recentFailedDays: RECENT_FAILED_DAYS,
    stageOrder,
    stageLabels,
    stageDescriptions,
    stageBacktestNotes,
    auxTagLabels,
    auxTagDescriptions,
    judgmentOrder,
    judgmentLabels,
    judgmentDescriptions,
    // 신규 VPR (돌파 이후 반응 분류) — H그룹 내부 전용
    vprMainOrder: ['HIGH_ZONE_HOLD', 'ABOVE_BREAKOUT_LINE', 'ABOVE_BASE_CLOSE', 'INTRADAY_PUSHBACK', 'OVERHEATED_BREAKOUT'],
    vprMainLabels: vprAnalyzer.VPR_MAIN_LABELS,
    vprMainDescriptions: vprAnalyzer.VPR_MAIN_DESCRIPTIONS,
    vprAuxLabels: vprAnalyzer.VPR_AUX_LABELS,
    vprAuxDescriptions: vprAnalyzer.VPR_AUX_DESCRIPTIONS,
    generatedAt: new Date().toISOString(),
  },
  summary,
  earlyQvaSummary,
  debugCounts,
  stages: stagedItems,
  recentVviHistory: {
    items: recentVviHistoryItems,
    summary: recentVviHistorySummary,
    note: '이 섹션은 매수 추천이 아니라 VVI2 발생 이력과 돌파 판정 흐름을 보여주는 참고 정보입니다.',
  },
  qvaTracking: {
    summary: qvaTrackingSummary,
    topPreview: qvaTrackingTopPreview,
    note: 'QVA 추적 중 후보는 아직 VVI2 확인 전 단계입니다. 많은 후보 중 가격 유지, 저점 상승, 거래대금 재활성 태그가 함께 붙은 종목을 우선적으로 관찰합니다.',
  },
};

fs.writeFileSync(
  path.join(ROOT, 'qva-watchlist-board.json'),
  JSON.stringify(jsonOut, null, 2),
  'utf-8'
);
console.log(`\n✅ JSON 저장: qva-watchlist-board.json`);

// ─────────── HTML ───────────
const htmlTemplate = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QVA Watchlist Board — 매일 추적 보드</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
  h1 { color: #f1f5f9; margin: 0 0 4px 0; font-size: 24px; }
  h1 .sub { color: #94a3b8; font-size: 14px; font-weight: 400; margin-left: 6px; }
  h2 { color: #f1f5f9; margin: 24px 0 8px 0; font-size: 17px; padding: 8px 0; }
  .h-section { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .h-section .desc { color: #94a3b8; font-size: 12px; font-weight: 400; }
  .h-section .pill { font-size: 12px; padding: 2px 10px; border-radius: 999px; background: #334155; color: #fff; font-weight: 600; }
  .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 12px; }

  .nav { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  .nav a { color: #93c5fd; text-decoration: none; font-size: 12px; padding: 6px 10px; background: #1e293b; border-radius: 6px; }
  .nav a.active { background: #1e3a8a; color: #fff; }

  .info-box { background: #1e293b; padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; border-left: 3px solid #60a5fa; }
  .info-box p { margin: 0 0 6px 0; font-size: 13px; line-height: 1.6; color: #cbd5e1; }
  .info-box p:last-child { margin-bottom: 0; }
  .info-box strong { color: #f1f5f9; }

  /* QVA/VVI/H그룹 도움말 토글 */
  .help-wrap { margin-bottom: 14px; }
  .help-btn { width: 100%; padding: 10px 14px; background: #1e3a8a; color: #f1f5f9; border: 1px solid #3b82f6; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; text-align: left; display: flex; align-items: center; gap: 8px; }
  .help-btn:hover { background: #1e40af; }
  .help-btn .arrow { margin-left: auto; transition: transform 0.15s; }
  .help-btn.open .arrow { transform: rotate(180deg); }
  .help-content { background: #1e293b; padding: 16px 20px; border-radius: 8px; margin-top: 8px; border-left: 3px solid #3b82f6; line-height: 1.7; color: #cbd5e1; }
  .help-content.collapsed { display: none; }
  .help-content h3 { color: #f1f5f9; font-size: 15px; margin: 0 0 8px 0; padding-bottom: 6px; border-bottom: 1px solid #334155; }
  .help-content .help-section { margin-bottom: 18px; }
  .help-content .help-section:last-child { margin-bottom: 0; }
  .help-content p { margin: 0 0 8px 0; font-size: 13px; }
  .help-content ul { margin: 6px 0; padding-left: 20px; font-size: 13px; }
  .help-content ul li { margin-bottom: 4px; }
  .help-content strong { color: #f1f5f9; }
  .help-content .funnel { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; margin: 8px 0; font-size: 12px; }
  .help-content .funnel .step { padding: 4px 10px; background: #334155; border-radius: 999px; color: #f1f5f9; white-space: nowrap; }
  .help-content .funnel .step.h-group { background: #14532d; color: #6ee7b7; }
  .help-content .funnel .arrow-r { color: #64748b; }
  .help-content .h-group-card { background: #0f172a; border: 1px solid #14532d; border-left: 3px solid #10b981; padding: 10px 14px; border-radius: 6px; margin-top: 8px; }
  .help-content .h-group-card ol { margin: 4px 0 8px 0; padding-left: 22px; font-size: 13px; }
  .help-content .h-group-card ol li { margin-bottom: 2px; }
  .help-content .warn { color: #fbbf24; font-size: 12px; margin-top: 6px; padding: 6px 10px; background: #422006; border-radius: 4px; }

  /* QVA 추적 중 — 요약 카드 / 미리보기 (접힘 상태에서도 노출) */
  .tracking-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 12px; }
  .tracking-summary .card { background: #0f172a; padding: 10px 12px; border-radius: 6px; border: 1px solid #334155; }
  .tracking-summary .card .lbl { color: #94a3b8; font-size: 11px; }
  .tracking-summary .card .cnt { color: #f1f5f9; font-size: 20px; font-weight: 700; margin-top: 2px; }
  .tracking-summary .card.warn { border-left: 3px solid #f87171; }
  .tracking-summary .card.expiring { border-left: 3px solid #fbbf24; }
  .tracking-summary .card.strong { border-left: 3px solid #10b981; }

  .tracking-preview { background: #0f172a; padding: 10px 12px; border-radius: 6px; border: 1px solid #334155; margin-bottom: 12px; }
  .tracking-preview .preview-title { color: #cbd5e1; font-size: 12px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
  .tracking-preview .preview-title .pill { font-size: 10px; padding: 1px 8px; background: #14532d; color: #6ee7b7; }
  .tracking-preview table { width: 100%; font-size: 12px; }
  .tracking-preview td, .tracking-preview th { padding: 5px 8px; border-bottom: 1px solid #1e293b; }

  /* 펼치기 버튼 (QVA_TRACKING 전용 큰 토글) */
  .toggle-large { display: inline-block; padding: 4px 12px; background: #1e3a8a; color: #f1f5f9; border-radius: 999px; font-size: 12px; font-weight: 600; cursor: pointer; user-select: none; border: 1px solid #3b82f6; }
  .toggle-large:hover { background: #1e40af; }

  .stage-section.collapsed.q-tracking .table-wrap { display: none; }
  .stage-section.collapsed.early-qva .table-wrap { display: none; }
  .stage-section.collapsed.early-qva .controls { display: none; }
  .stage-section .toggle.tag-active { background: #14532d; color: #6ee7b7; border-color: #10b981; }

  .stage-bar { display: flex; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; }
  .stage-pill { display: flex; flex-direction: column; padding: 10px 14px; border-radius: 8px; background: #1e293b; min-width: 110px; cursor: pointer; user-select: none; border: 2px solid transparent; transition: border 0.15s; }
  .stage-pill:hover { border-color: #475569; }
  .stage-pill.active { border-color: #60a5fa; background: #1e3a8a; }
  .stage-pill .lbl { color: #94a3b8; font-size: 11px; }
  .stage-pill .cnt { color: #f1f5f9; font-size: 22px; font-weight: 700; }
  .stage-pill.s-BREAKOUT_SUCCESS { border-left: 3px solid #10b981; }
  .stage-pill.s-VVI_FIRED { border-left: 3px solid #3b82f6; }
  .stage-pill.s-QVA_TRACKING { border-left: 3px solid #fbbf24; }
  .stage-pill.s-QVA_NEW { border-left: 3px solid #f59e0b; }
  .stage-pill.s-EARLY_QVA { border-left: 3px solid #34d399; background: #064e3b22; }
  .stage-pill.s-FAILED { border-left: 3px solid #94a3b8; opacity: 0.7; }

  .controls { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .controls input[type=text] { flex: 1; min-width: 180px; padding: 7px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 13px; }
  .tag-filter { display: flex; gap: 6px; flex-wrap: wrap; }
  .tag-filter button { padding: 5px 10px; background: #1e293b; border: 1px solid #334155; border-radius: 999px; color: #cbd5e1; font-size: 12px; cursor: pointer; }
  .tag-filter button.active { background: #14532d; color: #6ee7b7; border-color: #10b981; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 7px 10px; text-align: right; border-bottom: 1px solid #334155; white-space: nowrap; }
  th.txt, td.txt { text-align: left; }
  th { background: #283447; color: #cbd5e1; font-weight: 600; cursor: pointer; user-select: none; }
  tr:hover { background: #283447; }
  th .help { display: inline-block; margin-left: 4px; color: #60a5fa; cursor: help; font-size: 10px; position: relative; }
  /* 커스텀 툴팁 — th 안 있는 .help[data-tip]에 호버 시 즉시 표시 (브라우저 기본 title 대체) */
  th .help[data-tip]:hover::after {
    content: attr(data-tip);
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: #0b1322;
    color: #e2e8f0;
    border: 1px solid #475569;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 12px;
    line-height: 1.55;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
    text-align: left;
    white-space: normal;
    width: max-content;
    max-width: 320px;
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    pointer-events: none;
  }
  th .help[data-tip]:hover::before {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-bottom-color: #475569;
    z-index: 100;
  }

  .table-wrap { background: #1e293b; padding: 8px; border-radius: 8px; margin-bottom: 14px; overflow-x: auto; }
  .empty { color: #64748b; padding: 16px; text-align: center; font-size: 13px; }

  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; margin: 0 2px 2px 0; }
  .badge.tag-PRICE_HOLD { background: #1e3a8a; color: #93c5fd; }
  .badge.j-REVIEW_OK     { background: #1e3a8a; color: #93c5fd; }
  .badge.j-CHASE_CAUTION { background: #422006; color: #fbbf24; }
  .badge.j-PULLBACK_WAIT { background: #5c2c0f; color: #fb923c; }
  .badge.j-MANAGEMENT    { background: #4c1d95; color: #c4b5fd; }
  .badge.j-BREAKDOWN_WEAK{ background: #4c1d1d; color: #fca5a5; }
  /* VPR 메인 태그 (5종) — 안정적 반응 → 밀림 → 과열 (과열은 좋은 신호 아님, 주의 색상) */
  .badge.vpr-HIGH_ZONE_HOLD       { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; font-weight: 600; }
  .badge.vpr-ABOVE_BREAKOUT_LINE  { background: #134e4a; color: #5eead4; }
  .badge.vpr-ABOVE_BASE_CLOSE     { background: #312e81; color: #c7d2fe; }
  .badge.vpr-INTRADAY_PUSHBACK    { background: #422006; color: #fde047; border: 1px solid #ca8a04; }
  .badge.vpr-OVERHEATED_BREAKOUT  { background: #7c2d12; color: #fdba74; border: 1px solid #f97316; font-weight: 600; }
  /* VPR 보조 태그 (10종) — 한 가지 스타일로 통일 */
  .badge.vpr-aux                  { display: inline-block; background: #1e293b; color: #cbd5e1; border: 1px solid #334155; padding: 1px 6px; border-radius: 3px; font-size: 10px; margin-right: 3px; margin-bottom: 2px; }
  .section-footer { color: #94a3b8; font-size: 12px; line-height: 1.6; padding: 10px 14px; background: #1e293b; border-radius: 6px; border-left: 3px solid #f59e0b; margin-top: -8px; margin-bottom: 14px; }
  .badge.tag-LOW_RISING { background: #14532d; color: #6ee7b7; }
  .badge.tag-VALUE_REACTIVATION { background: #422006; color: #fbbf24; }
  .badge.tag-CONFIRMED_QVA_PASS { background: #1e3a8a; color: #93c5fd; border: 1px solid #3b82f6; font-weight: 600; }
  .badge.tag-NEW_TODAY { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; font-weight: 600; }
  .badge.tag-TODAY_RECONFIRMED { background: #4c1d95; color: #c4b5fd; border: 1px solid #a78bfa; font-weight: 600; }
  .badge.tag-LONG_QVA_REACTIVE { background: #5b21b6; color: #ddd6fe; border: 1px solid #c4b5fd; font-weight: 600; }
  .badge.tag-LONG_QVA_INTEREST { background: #312e81; color: #a5b4fc; border: 1px solid #818cf8; font-weight: 600; }
  .badge.tag-LONG_QVA_BREAKOUT_DONE { background: #422006; color: #fbbf24; border: 1px solid #f59e0b; font-weight: 600; }
  .badge.tag-LONG_QVA_WATCH { background: #1e1b4b; color: #c7d2fe; }
  .badge.tag-LONG_QVA_TRACKING { background: #1e1b4b; color: #818cf8; }
  .badge.tag-PULLBACK_WAIT { background: #5c2c0f; color: #fb923c; border: 1px solid #fb923c; font-weight: 600; }
  /* 같은 종목 다중 노출 명시 (헷갈림 방지 — 별도 사이클을 한 화면에 보일 때) */
  .badge.tag-RECONFIRM_DUAL      { background: #4c1d1d; color: #fca5a5; border: 1px solid #f87171; font-weight: 600; }
  .badge.tag-TODAY_RECONFIRM_NEW { background: #422006; color: #fde047; border: 1px solid #facc15; font-weight: 600; }
  .badge.tag-CROSS_BOARD         { background: #134e4a; color: #5eead4; border: 1px solid #2dd4bf; font-weight: 500; }
  .badge.pref { background: #4c1d1d; color: #fca5a5; }

  .stage-section { margin-bottom: 24px; }
  .stage-section.collapsed .table-wrap { display: none; }
  .stage-section .toggle { font-size: 11px; color: #60a5fa; cursor: pointer; margin-left: 8px; }

  .pos { color: #10b981; }
  .neg { color: #f87171; }
  .muted { color: #64748b; }
  .market-K { color: #60a5fa; }
  .market-Q { color: #c084fc; }
  .stock-link { color: inherit; text-decoration: none; cursor: pointer; }
  .stock-link:hover { text-decoration: underline; filter: brightness(1.2); }
  .stock-link:hover .market-K, .stock-link:hover .market-Q { text-shadow: 0 0 6px currentColor; }

  .narrative { font-size: 12px; color: #cbd5e1; line-height: 1.7; padding: 10px 14px; background: #0f172a; border-radius: 6px; border: 1px solid #334155; margin-bottom: 12px; }
  .narrative strong { color: #fbbf24; }

  @media (max-width: 800px) {
    body { padding: 12px; }
    h1 { font-size: 18px; }
    h1 .sub { display: block; font-size: 12px; margin: 2px 0 0 0; }
    h2 { font-size: 14px; }
    .stage-pill { min-width: 90px; padding: 8px 10px; }
    .stage-pill .cnt { font-size: 18px; }
    .table-wrap table { font-size: 11px; }
    .table-wrap th, .table-wrap td { padding: 6px 6px; }
  }
</style>
</head>
<body>
  <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
    <div style="background:linear-gradient(90deg,#064e3b 0%,#065f46 100%);border:1px solid #10b981;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#a7f3d0;font-weight:700;letter-spacing:0.3px;">🟢 운영 보드</span><a href="/qva2-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR</a><a href="/qva2-d5-rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파</a><a href="/qva2-vvi" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파</a></div>
    <div style="background:linear-gradient(90deg,#1e1b4b 0%,#312e81 100%);border:1px solid #6366f1;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#c4b5fd;font-weight:700;letter-spacing:0.3px;">🟣 실험 라인</span><a href="/one-day-surge-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">⚡ 1DS 단타 후보</a><a href="/nasdaq-theme-watch" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🌎 나스닥 테마 감시</a></div>
    <div style="background:linear-gradient(90deg,#1e293b 0%,#334155 100%);border:1px solid #64748b;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;opacity:0.92;"><span style="color:#cbd5e1;font-weight:700;letter-spacing:0.3px;">📜 과거 보드</span><a href="/qva-watchlist" style="color:#fff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.22);border:1px solid #fff;font-weight:700;">📋 H그룹/VPR (구)</a><a href="/rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파 (구)</a><a href="/qva-vvi-redefined-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파 (구)</a></div>
    <div style="background:linear-gradient(90deg,#042f2e 0%,#134e4a 100%);border:1px solid #14b8a6;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#5eead4;font-weight:700;letter-spacing:0.3px;">📊 통합 보기</span><a href="/db-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🗄 DB 신호 운영판</a></div>
  </div>
  <h1>📋 QVA 매일 운영 보드<span class="sub">— 매일 장마감 후 갱신되는 후보 추적 보드 (백테스트 보고서 아님)</span></h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="info-box" style="background:#0f172a;border-left-color:#34d399;border-left-width:4px;padding:18px 22px;">
    <p>이 화면은 <strong>'살 종목'을 알려주는 곳이 아니라, 관심 있게 지켜볼 종목을 단계별로 정리해주는 화면</strong>입니다.</p>
    <p style="margin-top:10px;">흐름은 단순합니다.</p>
    <p style="margin-top:6px;font-size:14px;text-align:center;background:#1e293b;padding:10px 12px;border-radius:6px;line-height:1.8;">
      <strong style="color:#34d399;">🟢 QVA</strong>
      <span style="color:#64748b;">→</span>
      <strong style="color:#3b82f6;">⏳ VVI</strong>
      <span style="color:#64748b;">→</span>
      <strong style="color:#10b981;">🔥 돌파 성공 (H그룹)</strong>
      <span style="color:#64748b;">→</span>
      <strong style="color:#5eead4;">📊 VPR 반응 분류</strong>
    </p>
    <p style="margin-top:10px;"><strong style="color:#34d399;">QVA</strong>는 저점권에서 기존 거래량·거래대금을 확실히 뛰어넘는 수급 흔적이 나타난 관심 후보입니다 (저점권 거래대금 돌파).<br>
    <strong style="color:#3b82f6;">VVI2</strong>는 거래대금이 더 강하게 확인되고 종가가 고가권에서 양호하게 마감한 단계입니다.<br>
    <strong style="color:#10b981;">돌파 성공(H그룹)</strong>은 VVI2 다음 거래일 고가가 <span style="color:#fbbf24;font-family:monospace;">기준선(= VVI2 돌파대기일 종가 × 1.01)</span>을 넘은 종목군입니다.</p>

    <div style="background:#0f172a;border:1px dashed #475569;border-radius:6px;padding:10px 14px;margin-top:10px;font-size:12px;line-height:1.75;color:#cbd5e1;">
      💡 <strong style="color:#fde68a;">H그룹과 VPR — 같은 기준, 다른 표현</strong><br>
      두 개념은 같은 가격 기준을 사용하지만 결과 표현이 다릅니다.<br>
      핵심 기준은 한 가격: <span style="color:#fbbf24;font-family:monospace;">VVI 돌파대기일 종가 × 1.01 (= 기준선)</span>
      <ul style="list-style:none;padding-left:0;margin:6px 0 0 0;">
        <li style="margin:3px 0;"><strong style="color:#10b981;">H그룹</strong> — <em>"돌파했냐? 예 / 아니오"</em> 검증 결과 이름.</li>
        <li style="margin:3px 0;"><strong style="color:#5eead4;">VPR</strong> — <em>"돌파했는데 강한가? 밀렸나? 눌림인가? 너무 멀리 갔나?"</em> H그룹 내부에서만 표시되는 돌파 이후 반응 분류.</li>
      </ul>
    </div>

    <p style="margin-top:10px;"><strong style="color:#5eead4;">VPR</strong>은 H그룹 내부에서만 표시되는 돌파 이후 반응 분류입니다.
    H그룹은 VVI 돌파대기일 종가 × 1.01을 다음 거래일 고가가 돌파한 종목군이므로, <strong>VPR은 성공/실패를 다시 판정하는 값이 아닙니다.</strong>
    이미 기준선을 돌파한 종목이 종가를 고가권에서 유지했는지, 기준선 위에서 마감했는지, 기준 종가를 지켰는지, 장중 밀렸는지, 과열 상태인지 등을 나눠 보여주는 해석 라벨입니다.
    <strong style="color:#fbbf24;">매수 확정 신호도, H그룹보다 더 좋은 조건도 아닙니다.</strong></p>

    <details style="margin-top:10px;background:#1e293b;border-radius:6px;padding:8px 12px;">
      <summary style="cursor:pointer;color:#5eead4;font-size:13px;font-weight:600;">▸ VPR 메인 태그 5종 의미 보기</summary>
      <div style="margin-top:8px;padding-left:8px;border-left:2px solid #334155;font-size:12px;line-height:1.7;">
        <div style="margin:4px 0;"><strong style="color:#6ee7b7;">고가권 유지</strong> <span style="color:#94a3b8;">— 기준선을 돌파한 뒤 종가가 고가권(종가 위치 70% 이상)에서 유지되었습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#5eead4;">기준선 위 마감</strong> <span style="color:#94a3b8;">— 기준선 위에서 마감했지만 장중 고점 대비 일부 밀림이 있었습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#c7d2fe;">기준 종가 위 유지</strong> <span style="color:#94a3b8;">— 장중 기준선을 돌파했지만 종가는 돌파 기준가 아래로 내려왔고, 기준 종가는 지켰습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#fde047;">장중 돌파 후 밀림</strong> <span style="color:#94a3b8;">— 장중 기준선을 돌파했지만 종가가 기준 종가 아래로 내려와 밀림이 있었습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#fdba74;">과열 돌파</strong> <span style="color:#94a3b8;">— 기준선은 돌파했지만 기준 종가 대비 +12% 이상 떠 있어 추격 위험이 큽니다 (좋은 신호 아님, 주의).</span></div>
      </div>
    </details>

    <details style="margin-top:6px;background:#1e293b;border-radius:6px;padding:8px 12px;">
      <summary style="cursor:pointer;color:#5eead4;font-size:13px;font-weight:600;">▸ VPR 보조 태그 10종 의미 보기</summary>
      <div style="margin-top:8px;padding-left:8px;border-left:2px solid #334155;font-size:12px;line-height:1.7;">
        <div style="margin:4px 0;"><strong style="color:#cbd5e1;">거래대금 폭발</strong> <span style="color:#94a3b8;">— 거래대금이 평소(20일 평균) 대비 3배 이상 증가했습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#cbd5e1;">거래대금 동반</strong> <span style="color:#94a3b8;">— 기준선 돌파와 함께 거래대금도 평소 대비 2배 이상 늘었습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#cbd5e1;">거래대금 약함</strong> <span style="color:#94a3b8;">— 기준선은 돌파했지만 거래대금은 평소보다 약했습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#cbd5e1;">갭상승 출발</strong> <span style="color:#94a3b8;">— 시가부터 기준선 위에서 출발했습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#cbd5e1;">갭상승 후 흔들림</strong> <span style="color:#94a3b8;">— 시가부터 기준선 위에서 출발했지만 종가는 시가보다 낮게 마감했습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#cbd5e1;">위꼬리 주의</strong> <span style="color:#94a3b8;">— 장중 고점 대비 종가가 5% 이상 내려왔습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#cbd5e1;">위꼬리 적음</strong> <span style="color:#94a3b8;">— 종가가 당일 고가에 가깝게(85% 이상) 마감했습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#cbd5e1;">아래꼬리 회복</strong> <span style="color:#94a3b8;">— 장중 기준 종가 아래로 밀렸지만 종가가 회복되었습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#cbd5e1;">기준가 대비 거리 큼</strong> <span style="color:#94a3b8;">— 기준 종가 대비 +12% 이상 떠 있어 추격 위험이 있습니다.</span></div>
        <div style="margin:4px 0;"><strong style="color:#cbd5e1;">조용한 돌파</strong> <span style="color:#94a3b8;">— 기준선은 돌파했지만 거래대금 증가는 보통 수준(평균 1~2배)입니다.</span></div>
      </div>
    </details>

    <p style="margin-top:10px;color:#fbbf24;font-size:12px;">⚠️ VPR은 매수 추천이 아닙니다. <strong>실제 판단은 현재 가격, 차트, 뉴스, 거래대금, 시장 상황을 함께 보고 사용자가 직접 해야 합니다.</strong></p>
  </div>

  <div class="info-box">
    <p><strong>이 보드는 매일 보는 QVA 운영 화면입니다.</strong> 과거 데이터를 검증하는 백테스트 보고서가 아니라, 오늘 시점에서 <strong>어떤 종목이 funnel의 어느 단계에 와 있는지</strong> 보여주는 운영용 추적 보드입니다.</p>
    <p>매일 평일 16:35 자동 갱신됩니다 (KST). 매수 추천이 아니라 관심 후보 추적/모니터링용입니다.</p>
    <p style="border-top:1px solid #334155;padding-top:6px;margin-top:6px;">
      📅 <strong>현재 보드는 최신 거래일 기준으로 생성됩니다.</strong> 오늘이 휴장일이면 마지막 거래일 데이터를 기준으로 표시됩니다.
    </p>
    <p id="trading-date-meta" style="font-family:monospace;font-size:12px;color:#94a3b8;"></p>
  </div>


  <div class="help-wrap">
    <button class="help-btn open" id="help-btn">
      <span>📖 단계 흐름 닫기</span>
      <span class="arrow">▼</span>
    </button>
    <div class="help-content" id="help-content">

      <div class="help-section">
        <h3>단계 흐름</h3>
        <div class="funnel">
          <span class="step" style="background:#064e3b;color:#34d399;">🟢 QVA</span>
          <span class="arrow-r">→</span>
          <span class="step">⏳ VVI</span>
          <span class="arrow-r">→</span>
          <span class="step">🚀 다음 거래일 돌파 대기</span>
          <span class="arrow-r">→</span>
          <span class="step h-group">🔥 돌파 성공</span>
          <span class="arrow-r">→</span>
          <span class="step">현재 위치 확인</span>
        </div>
      </div>

    </div>
  </div>

  <div id="global-search-wrap" style="background:#1e293b;border:2px solid #3b82f6;border-radius:8px;padding:14px 16px;margin-bottom:14px;">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span style="color:#93c5fd;font-size:14px;font-weight:600;">🔍 전체 종목 검색</span>
      <input id="global-search" type="text" placeholder="관심 종목명 또는 6자리 코드 입력 (예: 이노션, 214320)"
        style="flex:1;min-width:240px;padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;" />
      <span id="global-search-status" style="color:#94a3b8;font-size:12px;"></span>
      <button id="global-search-clear" style="padding:6px 12px;background:#334155;color:#cbd5e1;border:none;border-radius:6px;cursor:pointer;font-size:12px;">✕ 지우기</button>
    </div>
    <p style="margin:8px 0 0 0;font-size:11px;color:#94a3b8;">관심 종목이 이 보드의 어느 섹션에 있는지 한 번에 찾을 수 있습니다. 입력하면 모든 섹션의 행이 자동으로 필터링됩니다.</p>
    <p style="margin:6px 0 0 0;font-size:11px;color:#fbbf24;">💡 종목명을 클릭하면 새 창에서 상세 페이지가 열립니다. AI 뉴스/공시 분석이 포함돼 있어 첫 조회 시 10~30초 정도 걸릴 수 있습니다(재조회는 캐시 사용으로 빠름).</p>
  </div>

  <h2 class="h-section">단계별 후보 수 <span class="pill" id="total-pill"></span></h2>
  <div class="stage-bar" id="stage-bar"></div>

  <div id="stages-wrap"></div>

<script>
// file:// 로 직접 열린 경우 nav 절대경로를 상대 .html 파일 경로로 재작성
(function rewriteNavForFileProtocol(){
  if (location.protocol !== 'file:') return;
  const map = {
    '/qva-watchlist': 'qva-watchlist-board.html',
    '/qva-to-vvi-report': 'qva-to-vvi-report.html',
    '/qva-vvi-breakout-entry-report': 'qva-vvi-breakout-entry-report.html',
    '/qva-vvi-breakout-exit-report': 'qva-vvi-breakout-exit-report.html',
    '/qva-review-ok': 'qva-review-ok-backtest-report.html',
    '/qva-review-ok-backtest-report': 'qva-review-ok-backtest-report.html',
  };
  document.querySelectorAll('a[href]').forEach(a => {
    const h = a.getAttribute('href');
    if (map[h]) a.setAttribute('href', map[h]);
  });
})();

const DATA = __JSON_DATA__;

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8) : (d || '-'); }
function fmtNum(n) { return n != null ? Math.round(n).toLocaleString() : '-'; }
function fmtValue(v) { return v == null ? '-' : (v / 1e8).toFixed(0) + '억'; }
function fmtPct(n, sign) {
  if (n == null || !Number.isFinite(n)) return '<span class="muted">-</span>';
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : 'muted');
  const s = (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
  return '<span class="' + cls + '">' + s + '</span>';
}
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }

// 사용자 친화 subtitle + 개발자 정보 접힘 영역
const subtitleEl = document.getElementById('subtitle');
const baseDate = fmtDate(DATA.meta.latestTradingDate);
const nextDate = fmtDate(DATA.meta.nextTradingDate);
const closed = DATA.meta.isMarketClosedToday;
const closedReason = DATA.meta.beforeMarketOpen ? '장 시작 전(09:00 KST)이라 ' : (closed ? '오늘은 휴장일이라 ' : '');
subtitleEl.innerHTML =
  '기준 거래일: <strong>' + baseDate + '</strong>' +
  ' · 다음 거래일: <strong>' + nextDate + '</strong>' +
  '<br><span style="color:#94a3b8;font-size:11px;">' +
  closedReason +
  '마지막 거래일 기준으로 표시됩니다.' +
  ' · 갱신: ' + DATA.meta.generatedAt.slice(0, 16).replace('T', ' ') +
  ' · <a href="#" id="dev-info-toggle" style="color:#64748b;text-decoration:underline;font-size:11px;">개발자 정보 보기 ▾</a>' +
  '</span>' +
  '<div id="dev-info-detail" style="display:none;margin-top:8px;padding:8px 12px;background:#1e293b;border-radius:6px;border:1px solid #334155;font-family:monospace;font-size:11px;color:#94a3b8;line-height:1.7;">' +
    '<strong style="color:#cbd5e1;">기준일/거래일</strong><br>' +
    'latestTradingDate=' + DATA.meta.latestTradingDate +
    ' · todayCalendarDate=' + DATA.meta.todayCalendarDate +
    ' · nextTradingDate=' + DATA.meta.nextTradingDate +
    ' · isMarketClosedToday=' + DATA.meta.isMarketClosedToday +
    ' · tradingDateCount=' + DATA.meta.tradingDateCount +
    ' · recentVviCount=' + DATA.meta.recentVviCount +
    ' · trackingDays=' + DATA.meta.trackingDays +
    (DATA.debugCounts ? (
      '<br><br><strong style="color:#cbd5e1;">데이터 상태 점검</strong><br>' +
      'totalUniverseCount=' + DATA.debugCounts.totalUniverseCount +
      ' · chartDataAvailable=' + DATA.debugCounts.chartDataAvailableCount +
      ' (' + (DATA.debugCounts.chartDataAvailableCount / DATA.debugCounts.totalUniverseCount * 100).toFixed(1) + '%)' +
      ' · flowDataAvailable=' + DATA.debugCounts.flowDataAvailableCount +
      '<br>qvaCandidatesTodayRaw=' + DATA.debugCounts.qvaCandidatesTodayRaw +
      ' · qvaCandidatesTodayAfterFilters=' + DATA.debugCounts.qvaCandidatesTodayAfterFilters +
      ' · qvaTrackingCandidates20d=' + DATA.debugCounts.qvaTrackingCandidates20d +
      ' · qvaTrackingHasVviCount=' + DATA.debugCounts.qvaTrackingHasVviCount +
      '<br>vviCandidatesToday=' + DATA.debugCounts.vviCandidatesToday +
      ' · breakoutSuccessRecent=' + DATA.debugCounts.breakoutSuccessRecent
    ) : '') +
  '</div>';
const devInfoToggle = document.getElementById('dev-info-toggle');
const devInfoDetail = document.getElementById('dev-info-detail');
if (devInfoToggle && devInfoDetail) {
  devInfoToggle.addEventListener('click', (e) => {
    e.preventDefault();
    const open = devInfoDetail.style.display !== 'none';
    devInfoDetail.style.display = open ? 'none' : 'block';
    devInfoToggle.textContent = open ? '개발자 정보 보기 ▾' : '개발자 정보 닫기 ▴';
  });
}

// 디버그 메타 표시 (info-box 하단)
const metaEl = document.getElementById('trading-date-meta');
if (metaEl) {
  metaEl.textContent =
    'latestTradingDate=' + fmtDate(DATA.meta.latestTradingDate) +
    ' · todayCalendarDate=' + fmtDate(DATA.meta.todayCalendarDate) +
    ' · nextTradingDate=' + fmtDate(DATA.meta.nextTradingDate) +
    ' · isMarketClosedToday=' + DATA.meta.isMarketClosedToday +
    ' · tradingDateCount=' + DATA.meta.tradingDateCount +
    ' · recentVviCount(5d)=' + (DATA.meta.recentVviCount ?? '-');
}

// 단계별 카드
const stageOrder = DATA.meta.stageOrder;
document.getElementById('total-pill').textContent = '전체 ' + DATA.summary.totalCandidates + '건';

const stageBar = document.getElementById('stage-bar');
stageBar.innerHTML = stageOrder.map(s =>
  '<div class="stage-pill s-' + s + '" data-stage="' + s + '">' +
    '<span class="lbl">' + DATA.meta.stageLabels[s] + '</span>' +
    '<span class="cnt">' + (DATA.summary.stageCounts[s] || 0) + '</span>' +
  '</div>'
).join('');

// 보조 태그 집합
const TAG_LABELS = DATA.meta.auxTagLabels;
const TAG_DESCS = DATA.meta.auxTagDescriptions;

function badges(c) {
  let b = '';
  if (c.isPreferred) b += '<span class="badge pref">우</span>';

  // ─── 같은 종목 다중 노출 명시 배지 (헷갈림 방지) ───
  // 1) QVA_TODAY 카드 — funnel에 이미 살아있는 사이클이 따로 있으면 표시
  //    (todayReconfirmed/isTodayNew 분기 무관 — existingTracking 자체가 "다른 사이클 동시 진행" 신호)
  if (c.existingTracking) {
    const e = c.existingTracking;
    const stageKr = { QVA_TRACKING: '추적중', VVI_FIRED: 'VVI', BREAKOUT_SUCCESS: 'H그룹', QVA_NEW: '신규' }[e.mainStage] || e.mainStage;
    const dStr = e.qvaSignalDate ? (e.qvaSignalDate.slice(4,6) + '/' + e.qvaSignalDate.slice(6,8)) : '';
    const dPlus = (e.daysSinceQva != null) ? ('D+' + e.daysSinceQva) : '';
    b += '<span class="badge tag-RECONFIRM_DUAL" title="funnel에 이미 살아있는 종목이 오늘 다시 QVA 조건을 통과 — 같은 사이클이 아닌 새 발화">🔄 ' + dStr + ' ' + stageKr + ' ' + dPlus + ' 사이클 동시</span>';
  }
  // 2) candidates 카드 (QVA_TRACKING / VVI_FIRED / BREAKOUT_SUCCESS) — 오늘 새 QVA 발화 동반 시
  if (c.todayReconfirmEvent) {
    const ev = c.todayReconfirmEvent;
    b += '<span class="badge tag-TODAY_RECONFIRM_NEW" title="이 추적 사이클이 진행 중인데 오늘 새 QVA 조건이 또 통과됨 (재발화)">⚡ 오늘 재발화 ' + (ev.score || '') + 'p</span>';
  }

  // H그룹(VPR 적용 종목)은 VPR 보조 태그를 종목명 옆에 표시 — 일반 추적 태그(PRICE_HOLD/LOW_RISING/VALUE_REACTIVATION)는 H그룹에서는 숨김
  if (c.vprMain && c.vprTags && c.vprTags.length > 0) {
    const vprAuxLabels = (DATA.meta.vprAuxLabels || {});
    const vprAuxDescs = (DATA.meta.vprAuxDescriptions || {});
    for (const t of c.vprTags) {
      b += '<span class="badge vpr-aux" title="' + (vprAuxDescs[t] || '').replace(/"/g, '&quot;') + '">' + (vprAuxLabels[t] || t) + '</span>';
    }
    // 다른 보드 매칭 배지 (H그룹도 동시 표시)
    if (c.crossBoardRefs) {
      for (const r of c.crossBoardRefs) {
        b += '<span class="badge tag-CROSS_BOARD" title="' + r.board + ' 보드에도 같은 종목">' + r.label + '</span>';
      }
    }
    return b;
  }
  for (const t of (c.auxTags || [])) {
    b += '<span class="badge tag-' + t + '" title="' + (TAG_DESCS[t] || '') + '">' + (TAG_LABELS[t] || t) + '</span>';
  }
  // 다른 보드 매칭 배지
  if (c.crossBoardRefs) {
    for (const r of c.crossBoardRefs) {
      b += '<span class="badge tag-CROSS_BOARD" title="' + r.board + ' 보드에도 같은 종목">' + r.label + '</span>';
    }
  }
  return b;
}

// 단계별 테이블
const COLS_BY_STAGE = {
  BREAKOUT_SUCCESS: [
    { key: 'judgmentStatus', label: '진입 판단 상태', txt: true, render: c => {
      const j = c.judgmentStatus;
      if (!j) return '<span class="muted">-</span>';
      const lbl = DATA.meta.judgmentLabels[j] || j;
      const desc = DATA.meta.judgmentDescriptions[j] || '';
      return '<span class="badge j-' + j + '" title="' + desc.replace(/"/g, '&quot;') + '">' + lbl + '</span>';
    }},
    { key: 'vprMain', label: 'VPR', txt: true, render: c => {
      const m = c.vprMain;
      if (!m) return '<span class="muted">-</span>';
      const mainLbl = (DATA.meta.vprMainLabels && DATA.meta.vprMainLabels[m]) || m;
      const mainDesc = (DATA.meta.vprMainDescriptions && DATA.meta.vprMainDescriptions[m]) || '';
      // 메인 태그만 표시 — 보조 태그는 종목명 옆으로 이동했음
      return '<span class="badge vpr-' + m + '" title="' + mainDesc.replace(/"/g, '&quot;') + '">' + mainLbl + '</span>';
    }},
    { key: 'name', label: '종목', txt: true, render: c => '<a href="/stock/' + c.code + '?from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 종목 상세 페이지 열기"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
    { key: 'breakoutDate', label: '돌파일(기준일)<span class="help" data-tip="기준일 확인 필수. D+0이 오늘 돌파, D+5는 5거래일 전 돌파. 5일 노출 윈도우.">ⓘ</span>', txt: true, render: c => {
      const d = c.daysFromBreakout ?? 0;
      const dCls = d === 0 ? 'color:#10b981;font-weight:700;' : (d <= 2 ? 'color:#34d399;font-weight:600;' : (d >= 5 ? 'color:#fbbf24;' : 'color:#94a3b8;'));
      return '<strong style="color:#f1f5f9;">' + fmtDate(c.breakoutDate) + '</strong> <span style="' + dCls + '">D+' + d + '</span>';
    } },
    { key: 'vprBaseClose', label: '기준 종가<span class="help" data-tip="VVI 돌파대기일 종가">ⓘ</span>', render: c => c.vprBaseClose != null ? fmtNum(c.vprBaseClose) + '원' : '-' },
    { key: 'vprBreakoutLine', label: '기준선<span class="help" data-tip="기준 종가 × 1.01">ⓘ</span>', render: c => c.vprBreakoutLine != null ? fmtNum(c.vprBreakoutLine) + '원' : '-' },
    { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
    { key: 'liveDistanceFromBasePct', label: '거리<span class="help" data-tip="현재가가 기준 종가(VVI 돌파대기일 종가)에서 얼마나 떨어졌는지 %. 아래 백테스트 성과표의 &quot;거리&quot;와 같은 개념. 작을수록 추격 위험 작음.">ⓘ</span>', render: c => {
      const d = c.liveDistanceFromBasePct;
      if (d == null) return '-';
      // 거리에 따라 색상 — 백테스트 운영 기준 (≤8 보수, ≤10 기본/정예, ≤12 공격)과 일치
      let cls = 'color:#94a3b8;';
      if (d <= 8) cls = 'color:#6ee7b7;font-weight:600;';
      else if (d <= 10) cls = 'color:#5eead4;';
      else if (d <= 12) cls = 'color:#c7d2fe;';
      else cls = 'color:#fdba74;';
      return '<span style="' + cls + '">' + fmtPct(d, true) + '</span>';
    } },
    { key: 'vprClosePosition', label: '종가 위치<span class="help" data-tip="다음날 종가가 당일 가격 범위에서 차지하는 위치 (100%=고가)">ⓘ</span>', render: c => c.vprClosePosition != null ? c.vprClosePosition + '%' : '-' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
    { key: 'qvaSignalDate', label: 'QVA일', txt: true, render: c => fmtDate(c.qvaSignalDate) + ' <span class="muted">D+' + c.daysSinceQva + '</span>' },
    { key: 'vviDate', label: 'VVI2일', txt: true, render: c => fmtDate(c.vviDate) },
  ],
  VVI_FIRED: [
    { key: 'qvaSignalDate', label: 'QVA일', txt: true, render: c => fmtDate(c.qvaSignalDate) + ' <span class="muted">D+' + c.daysSinceQva + '</span>' },
    { key: 'vviDate', label: 'VVI2일', txt: true, render: c => fmtDate(c.vviDate) },
    { key: 'name', label: '종목', txt: true, render: c => '<a href="/stock/' + c.code + '?from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 종목 상세 페이지 열기"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
    { key: 'qvaSignalPrice', label: 'QVA 신호가', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'vviHigh', label: 'VVI2 고가', render: c => fmtNum(c.vviHigh) + '원' },
    { key: 'vviClose', label: 'VVI2 종가', render: c => fmtNum(c.vviClose) + '원' },
    { key: 'breakoutEntryPrice1Pct', label: '내일 진입가 (×1.01)<span class="help" data-tip="vviHigh × 1.01">ⓘ</span>', render: c => fmtNum(c.vviHigh * 1.01) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
  ],
  QVA_TRACKING: [
    { key: 'watchScore', label: '관심도', render: c => '<strong style="color:#f1f5f9;">' + (c.watchScore ?? 0) + '</strong>' },
    { key: 'qvaSignalDate', label: 'QVA일', txt: true, render: c => fmtDate(c.qvaSignalDate) },
    { key: 'daysSinceQva', label: 'D+', render: c => {
      const tag = c.expiringSoon ? ' <span style="color:#fbbf24;font-size:10px;">만료임박</span>' : '';
      return 'D+' + c.daysSinceQva + tag;
    }},
    { key: 'name', label: '종목', txt: true, render: c => {
      const risk = c.riskTag ? '<span class="badge" style="background:#4c1d1d;color:#fca5a5;">위험</span>' : '';
      return '<a href="/stock/' + c.code + '?from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 종목 상세 페이지 열기"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + risk + badges(c);
    }},
    { key: 'qvaSignalPrice', label: 'QVA 신호가', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
    { key: 'currentValue', label: '현재 거래대금', render: c => fmtValue(c.currentValue) },
    { key: 'auxTagsCount', label: '보조태그', render: c => (c.auxTags?.length || 0) + '/3' },
  ],
  QVA_NEW: [
    { key: 'name', label: '종목', txt: true, render: c => '<a href="/stock/' + c.code + '?from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 종목 상세 페이지 열기"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
    { key: 'qvaSignalPrice', label: '신호가 (= 종가)', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'qvaSignalTradingValue', label: '거래대금', render: c => fmtValue(c.qvaSignalTradingValue) },
    { key: 'marketValue', label: '시총', render: c => fmtValue(c.marketValue) },
    { key: 'market', label: '시장', txt: true, render: c => c.market },
  ],
  FAILED: [
    { key: 'qvaSignalDate', label: 'QVA일', txt: true, render: c => fmtDate(c.qvaSignalDate) + ' <span class="muted">D+' + c.daysSinceQva + '</span>' },
    { key: 'name', label: '종목', txt: true, render: c => '<a href="/stock/' + c.code + '?from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 종목 상세 페이지 열기"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
    { key: 'qvaSignalPrice', label: '신호가', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
    { key: 'stageReason', label: '사유', txt: true, render: c => '<span class="muted">' + (c.stageReason || '-') + '</span>' },
  ],
  EARLY_QVA: [
    { key: 'bestEarlyQvaScore', label: '점수', render: c => '<strong style="color:#6ee7b7;">' + (c.bestEarlyQvaScore ?? 0) + '</strong>' },
    { key: 'bestEarlyQvaGradeLabel', label: '등급', txt: true, render: c => {
      const g = c.bestEarlyQvaGrade;
      const colors = { STRONG_REDEFINED_QVA: '#10b981', REDEFINED_QVA: '#34d399', WATCH_REDEFINED: '#94a3b8', STRONG_EARLY_QVA: '#10b981', EARLY_QVA: '#34d399', WATCH_EARLY: '#94a3b8' };
      return '<span style="color:' + (colors[g] || '#94a3b8') + ';font-weight:600;">' + (c.bestEarlyQvaGradeLabel || '-') + '</span>';
    }},
    { key: 'firstEarlyQvaDate', label: '최초 감지일', txt: true, render: c => fmtDate(c.firstEarlyQvaDate) + ' <span class="muted">D+' + (c.daysSinceFirst ?? 0) + '</span>' },
    { key: 'latestEarlyQvaDate', label: '최근 발화일', txt: true, render: c => fmtDate(c.latestEarlyQvaDate || c.bestEarlyQvaDate) + ' <span class="muted">D+' + (c.daysSinceLatest ?? c.daysSinceBest ?? 0) + '</span>' },
    { key: 'name', label: '종목', txt: true, render: c => '<a href="/stock/' + c.code + '?from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 종목 상세 페이지 열기"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
    { key: 'anchorPrice', label: '신호가', render: c => fmtNum(c.anchorPrice) + '원' },
    { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
    { key: 'earlyQvaSignalCount', label: '신호일수', render: c => (c.earlyQvaSignalCount || 0) + '회' },
    { key: 'marketValue', label: '시총', render: c => fmtValue(c.marketValue) },
  ],
};
// QVA_TODAY는 EARLY_QVA와 같은 컬럼 사용 (행에 NEW_TODAY/TODAY_RECONFIRMED 태그)
COLS_BY_STAGE.QVA_TODAY = COLS_BY_STAGE.EARLY_QVA;

// 장기 QVA 전용 컬럼 — 재점화/관심/전체 공통
COLS_BY_STAGE.LONG_QVA_REACTIVE = [
  { key: 'longQvaReactivationScore', label: '재점화', render: c => '<strong style="color:#c4b5fd;">' + (c.longQvaReactivationScore ?? 0) + '</strong>' },
  { key: 'longQvaLabel', label: '등급', txt: true, render: c => {
    const t = c.longQvaTier;
    const colors = { REACTIVE: '#c4b5fd', INTEREST: '#a5b4fc', BREAKOUT_DONE: '#fbbf24', WATCH: '#94a3b8', TRACKING: '#64748b' };
    return '<span style="color:' + (colors[t] || '#94a3b8') + ';font-weight:600;">' + (c.longQvaLabel || '-') + '</span>';
  }},
  { key: 'firstEarlyQvaDate', label: 'QVA일', txt: true, render: c => fmtDate(c.firstEarlyQvaDate) + ' <span class="muted">D+' + (c.daysSinceFirst ?? 0) + '</span>' },
  { key: 'name', label: '종목', txt: true, render: c => '<a href="/stock/' + c.code + '?from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 종목 상세 페이지 열기"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
  { key: 'anchorPrice', label: 'QVA 신호가', render: c => fmtNum(c.anchorPrice) + '원' },
  { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
  { key: 'currentReturnFromSignal', label: 'QVA 대비%', render: c => {
    const v = c.currentReturnFromSignal;
    if (v == null || !Number.isFinite(v)) return '<span class="muted">-</span>';
    // +25% 이상이면 강조
    if (v >= 25) return '<strong style="color:#fbbf24;">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%</strong>';
    const cls = v > 0 ? 'pos' : (v < 0 ? 'neg' : 'muted');
    return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>';
  }},
  { key: 'mfeFromSignal', label: '최고%', render: c => {
    const v = c.mfeFromSignal;
    if (v == null) return '<span class="muted">-</span>';
    return '<span style="color:#34d399;">+' + v.toFixed(2) + '%</span>';
  }},
  { key: 'longQvaChecks', label: '체크', txt: true, render: c => {
    const ch = c.longQvaChecks || {};
    const dot = (ok) => ok ? '<span style="color:#34d399;">●</span>' : '<span style="color:#475569;">○</span>';
    return '<span title="거래대금 재활성">' + dot(ch.valueReactivated) + '</span>' +
           '<span title="신호가 위 유지" style="margin-left:3px;">' + dot(ch.priceHoldAboveSignal) + '</span>' +
           '<span title="고점 돌파 재시도" style="margin-left:3px;">' + dot(ch.breakoutRetry) + '</span>' +
           '<span title="저점 상승" style="margin-left:3px;">' + dot(ch.lowRising) + '</span>' +
           '<span title="MA20 회복" style="margin-left:3px;">' + dot(ch.ma20Recovery) + '</span>';
  }},
  { key: 'bestEarlyQvaScore', label: 'QVA점수', render: c => (c.bestEarlyQvaScore ?? 0) },
];
COLS_BY_STAGE.LONG_QVA_INTEREST = COLS_BY_STAGE.LONG_QVA_REACTIVE;
COLS_BY_STAGE.LONG_QVA_ALL = COLS_BY_STAGE.LONG_QVA_REACTIVE;
// BREAKOUT_DONE 전용 컬럼 — 최고 상승/현재/고점 대비 하락 강조
COLS_BY_STAGE.LONG_QVA_BREAKOUT_DONE = [
  { key: 'currentReturnFromSignal', label: 'QVA 대비%', render: c => {
    const v = c.currentReturnFromSignal;
    if (v == null) return '<span class="muted">-</span>';
    return '<strong style="color:#fbbf24;">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%</strong>';
  }},
  { key: 'mfeFromSignal', label: '최고%', render: c => {
    const v = c.mfeFromSignal;
    if (v == null) return '<span class="muted">-</span>';
    return '<strong style="color:#34d399;">+' + v.toFixed(2) + '%</strong>';
  }},
  { key: 'dropFromMfeHigh', label: '고점 대비', render: c => {
    const v = c.dropFromMfeHigh;
    if (v == null) return '<span class="muted">-</span>';
    const cls = v <= -10 ? 'neg' : (v <= -5 ? 'muted' : 'pos');
    return '<span class="' + cls + '">' + v.toFixed(2) + '%</span> <span class="muted">(D+' + (c.daysSinceMfeHigh ?? 0) + ')</span>';
  }},
  { key: 'firstEarlyQvaDate', label: 'QVA일', txt: true, render: c => fmtDate(c.firstEarlyQvaDate) + ' <span class="muted">D+' + (c.daysSinceFirst ?? 0) + '</span>' },
  { key: 'name', label: '종목', txt: true, render: c => '<a href="/stock/' + c.code + '?from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 상세 페이지 열기"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
  { key: 'anchorPrice', label: 'QVA 신호가', render: c => fmtNum(c.anchorPrice) + '원' },
  { key: 'mfeHighPrice', label: '최고가', render: c => fmtNum(c.mfeHighPrice) + '원' },
  { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
  { key: 'longQvaReactivationScore', label: '재점화', render: c => (c.longQvaReactivationScore ?? 0) },
];

const stagesWrap = document.getElementById('stages-wrap');
const stageContent = {};

function buildStageSection(stage) {
  const items = DATA.stages[stage] || [];
  const cols = COLS_BY_STAGE[stage] || [];
  // 후보가 많은 추적 섹션은 기본 접힘, 오늘 신규/오늘 재확인은 펼침
  const eqSummary = DATA.earlyQvaSummary || {};
  const collapsed = (stage === 'EARLY_QVA' && (eqSummary.trackingCount ?? items.length) > 10);
  const sec = document.createElement('div');
  // 장기 QVA: REACTIVE / INTEREST 펼침 (INTEREST는 길어지면 "더보기"로 일부 숨김)
  //          BREAKOUT_DONE / ALL 은 기본 접힘
  const isLongReactive = stage === 'LONG_QVA_REACTIVE';
  const isLongInterest = stage === 'LONG_QVA_INTEREST';
  const isLongBreakoutDone = stage === 'LONG_QVA_BREAKOUT_DONE';
  const isLongAll = stage === 'LONG_QVA_ALL';
  const isLongAny = isLongReactive || isLongInterest || isLongBreakoutDone || isLongAll;
  const longCollapseDefault = (isLongBreakoutDone || isLongAll) && items.length > 0;
  const finalCollapsed = collapsed || longCollapseDefault;

  sec.className = 'stage-section'
    + (finalCollapsed ? ' collapsed' : '')
    + (stage === 'QVA_TRACKING' ? ' q-tracking' : '')
    + (stage === 'EARLY_QVA' ? ' early-qva' : '')
    + (stage === 'QVA_TODAY' ? ' qva-today' : '')
    + (isLongAny ? ' long-qva' : '')
    + (isLongBreakoutDone ? ' long-qva-breakout-done' : '');
  sec.dataset.stage = stage;

  let toggleCollapsedText = '▼ 펼치기';
  let toggleExpandedText = '▲ 접기';
  let toggleClass = 'toggle';
  if (stage === 'QVA_TRACKING') {
    toggleCollapsedText = 'QVA 추적 후보 전체 보기';
    toggleExpandedText = 'QVA 추적 후보 접기';
    toggleClass = 'toggle toggle-large';
  } else if (stage === 'EARLY_QVA') {
    toggleCollapsedText = '👀 QVA 추적 후보 보기 (' + (eqSummary.trackingCount ?? items.length) + '건)';
    toggleExpandedText = '👀 QVA 추적 후보 접기';
    toggleClass = 'toggle toggle-large';
  } else if (stage === 'QVA_TODAY') {
    toggleCollapsedText = '🟢 오늘 QVA 보기';
    toggleExpandedText = '🟢 오늘 QVA 접기';
    toggleClass = 'toggle toggle-large';
  } else if (isLongReactive) {
    toggleCollapsedText = '🔄 장기 QVA 재점화 보기 (' + items.length + '건)';
    toggleExpandedText = '🔄 장기 QVA 재점화 접기';
    toggleClass = 'toggle toggle-large';
  } else if (isLongInterest) {
    toggleCollapsedText = '🔍 장기 QVA 관심 보기 (' + items.length + '건)';
    toggleExpandedText = '🔍 장기 QVA 관심 접기';
    toggleClass = 'toggle toggle-large';
  } else if (isLongBreakoutDone) {
    toggleCollapsedText = '🚀 QVA 성공 후 급등 보기 (' + items.length + '건)';
    toggleExpandedText = '🚀 QVA 성공 후 급등 접기';
    toggleClass = 'toggle toggle-large';
  } else if (isLongAll) {
    toggleCollapsedText = '📋 장기 QVA 전체 보기 (' + items.length + '건)';
    toggleExpandedText = '📋 장기 QVA 전체 접기';
    toggleClass = 'toggle toggle-large';
  }

  const title = document.createElement('h2');
  title.className = 'h-section';
  const stageColor = { BREAKOUT_SUCCESS: '🔥', VVI_FIRED: '⏳', QVA_TRACKING: '👀', QVA_NEW: '🆕', QVA_TODAY: '🟢', EARLY_QVA: '👀',
    LONG_QVA_REACTIVE: '🔄', LONG_QVA_INTEREST: '🔍', LONG_QVA_BREAKOUT_DONE: '🚀', LONG_QVA_ALL: '📋', FAILED: '❌' }[stage] || '';
  let pillContent;
  if (stage === 'QVA_TODAY') {
    const newN = eqSummary.todayNewCount ?? 0;
    const reN = eqSummary.todayReconfirmedCount ?? 0;
    pillContent = '<span class="pill" style="background:#10b981;color:#fff;">오늘 통과 ' + (eqSummary.todayCount ?? 0) + '건</span>' +
      (newN > 0 ? '<span class="pill" style="background:#064e3b;color:#6ee7b7;border:1px solid #10b981;">신규 ' + newN + '</span>' : '') +
      (reN > 0 ? '<span class="pill" style="background:#4c1d95;color:#c4b5fd;border:1px solid #a78bfa;">재확인 ' + reN + '</span>' : '');
  } else if (stage === 'EARLY_QVA') {
    pillContent = '<span class="pill">추적 중 ' + (eqSummary.trackingCount ?? 0) + '건</span>' +
                  '<span class="pill" style="background:#34d399;color:#064e3b;">화면 ' + (eqSummary.displayedCount ?? 0) + '건</span>';
  } else if (isLongReactive) {
    pillContent = '<span class="pill" style="background:#5b21b6;color:#ddd6fe;border:1px solid #c4b5fd;">' + items.length + '건</span>' +
      '<span class="pill muted" style="font-size:10px;">≤+20% AND 점수 80+</span>';
  } else if (isLongInterest) {
    pillContent = '<span class="pill" style="background:#312e81;color:#a5b4fc;">' + items.length + '건</span>' +
      '<span class="pill muted" style="font-size:10px;">≤+20% AND 60~79</span>';
  } else if (isLongBreakoutDone) {
    const pbCount = (eqSummary.longQvaPullbackWaitCount ?? 0);
    pillContent = '<span class="pill" style="background:#422006;color:#fbbf24;border:1px solid #f59e0b;">' + items.length + '건 (이미 급등)</span>' +
      (pbCount > 0 ? '<span class="pill" style="background:#5c2c0f;color:#fb923c;border:1px solid #fb923c;">눌림 대기 ' + pbCount + '</span>' : '');
  } else if (isLongAll) {
    pillContent = '<span class="pill" style="background:#1e1b4b;color:#c7d2fe;">' + items.length + '건 (전체)</span>';
  } else {
    pillContent = '<span class="pill">' + items.length + '건</span>';
  }
  title.innerHTML = '<span>' + stageColor + ' ' + DATA.meta.stageLabels[stage] + '</span>' +
    pillContent +
    '<span class="desc">' + DATA.meta.stageDescriptions[stage] + '</span>' +
    '<span class="' + toggleClass + '" data-stage="' + stage + '"' +
    ' data-collapsed-text="' + toggleCollapsedText + '"' +
    ' data-expanded-text="' + toggleExpandedText + '">' +
    (finalCollapsed ? toggleCollapsedText : toggleExpandedText) + '</span>';
  sec.appendChild(title);

  // ─── stageBacktestNotes (3년+flow 백테스트 운영 해석 요약 + VPR 도움말) ───
  // BREAKOUT_SUCCESS 등 백테스트 통계 운영 해석이 부착된 섹션 상단에 표시.
  if (DATA.meta.stageBacktestNotes && DATA.meta.stageBacktestNotes[stage] && items.length > 0) {
    const noteData = DATA.meta.stageBacktestNotes[stage];
    const btNote = document.createElement('div');
    btNote.style.cssText = 'background:#0c1729;border-left:3px solid #14b8a6;padding:10px 14px;border-radius:6px;margin-bottom:10px;color:#cbd5e1;font-size:11.5px;line-height:1.65;';
    if (typeof noteData === 'string') {
      btNote.innerHTML = '📊 ' + noteData;
    } else {
      btNote.innerHTML = '📊 ' + (noteData.summary || '');
    }
    sec.appendChild(btNote);
  }

  // ─── LONG_QVA_REACTIVE: 안내문 ───
  if (isLongReactive && items.length > 0) {
    const noteEl = document.createElement('div');
    noteEl.style.cssText = 'background:#0f172a;border-left:3px solid #c4b5fd;padding:10px 14px;border-radius:6px;margin-bottom:12px;color:#cbd5e1;font-size:12px;line-height:1.7;';
    noteEl.innerHTML =
      '<strong style="color:#c4b5fd;">장기 QVA 재점화</strong>는 D+21~D+40 구간에서 <strong>아직 크게 오르지 않은 종목</strong> 중 거래대금과 가격 흐름이 다시 살아나는 후보입니다.<br>' +
      'QVA 대비 현재 수익률 ≤ <strong>+12%</strong> AND 최고 상승률 ≤ <strong>+20%</strong> AND 재점화 점수 80+ — 모두 과하지 않은 종목만 표시.<br>' +
      'QVA 이후 이미 +20% 이상 상승 구간이 나온 종목은 <strong style="color:#fbbf24;">"QVA 성공 후 상승"</strong> 섹션으로 분리됩니다.<br>' +
      '<strong style="color:#fbbf24;">매수 추천이 아니라 뒤늦게 반응하는 신규 관심 후보를 골라주는 보조 관찰 영역입니다.</strong>';
    sec.appendChild(noteEl);
  }
  if (isLongInterest && items.length > 0) {
    const noteEl = document.createElement('div');
    noteEl.style.cssText = 'background:#0f172a;border-left:3px solid #818cf8;padding:8px 14px;border-radius:6px;margin-bottom:12px;color:#cbd5e1;font-size:11px;line-height:1.6;';
    noteEl.innerHTML =
      '<strong style="color:#a5b4fc;">장기 QVA 관심</strong>: QVA 대비 ≤ +20% AND 최고 ≤ +25% AND 점수 60+. 점수 80+여도 현재 +12% 초과면 자연스럽게 이 섹션으로 강등됩니다.';
    sec.appendChild(noteEl);
  }
  if (isLongBreakoutDone && items.length > 0) {
    const noteEl = document.createElement('div');
    noteEl.style.cssText = 'background:#0f172a;border-left:3px solid #f59e0b;padding:10px 14px;border-radius:6px;margin-bottom:12px;color:#cbd5e1;font-size:12px;line-height:1.7;';
    noteEl.innerHTML =
      '<strong style="color:#fbbf24;">QVA 성공 후 상승</strong>은 QVA 이후 이미 +20% 이상 상승 구간이 나온 종목입니다 (현재가 +20% 초과 OR 최고 +20% 초과).<br>' +
      '<strong style="color:#fb923c;">신규 진입 후보가 아니라 성과 확인 또는 눌림 관찰 대상</strong>으로 봅니다. ' +
      '<span class="badge tag-PULLBACK_WAIT" style="font-size:10px;padding:1px 6px;border-radius:3px;">눌림 대기</span> 태그: 최고 +20% 이상 + 고점 대비 -7~-15% 조정 + MA20 × 0.98 위 유지 — 눌림 확인용 후보.';
    sec.appendChild(noteEl);
  }
  if (isLongAll && items.length > 0) {
    const noteEl = document.createElement('div');
    noteEl.style.cssText = 'background:#0f172a;border-left:3px solid #475569;padding:8px 14px;border-radius:6px;margin-bottom:12px;color:#94a3b8;font-size:11px;line-height:1.6;';
    noteEl.innerHTML =
      '<strong>장기 QVA 전체</strong>: D+21~D+40 구간 모든 추적 후보 (재점화 점수 무관, -10% 이상 무너진 종목 제외). 위쪽 재점화/관심 섹션에 노출되지 않은 종목 포함.';
    sec.appendChild(noteEl);
  }

  // ─── QVA_TRACKING: 요약 카드 (접힘 상태에서도 표시) ───
  if (stage === 'QVA_TRACKING') {
    const sm = DATA.qvaTracking?.summary || { total: 0, tag3: 0, tag2plus: 0, priceHold: 0, lowRising: 0, valueReactivation: 0, riskTag: 0, expiringSoon: 0 };
    const summaryEl = document.createElement('div');
    summaryEl.className = 'tracking-summary';
    summaryEl.innerHTML =
      '<div class="card"><div class="lbl">전체 추적 중</div><div class="cnt">' + sm.total + '</div></div>' +
      '<div class="card strong"><div class="lbl">보조 태그 3/3</div><div class="cnt">' + sm.tag3 + '</div></div>' +
      '<div class="card"><div class="lbl">보조 태그 2/3 이상</div><div class="cnt">' + sm.tag2plus + '</div></div>' +
      '<div class="card"><div class="lbl">가격 유지</div><div class="cnt">' + sm.priceHold + '</div></div>' +
      '<div class="card"><div class="lbl">저점 상승</div><div class="cnt">' + sm.lowRising + '</div></div>' +
      '<div class="card"><div class="lbl">거래대금 재활성</div><div class="cnt">' + sm.valueReactivation + '</div></div>' +
      '<div class="card warn"><div class="lbl">위험 태그</div><div class="cnt">' + sm.riskTag + '</div></div>' +
      '<div class="card expiring"><div class="lbl">만료 임박</div><div class="cnt">' + sm.expiringSoon + '</div></div>';
    sec.appendChild(summaryEl);
  }

  // ─── QVA_TODAY: 안내문 (신규 + 재확인 통합) ───
  if (stage === 'QVA_TODAY') {
    const noteEl = document.createElement('div');
    noteEl.style.cssText = 'background:#0f172a;border-left:3px solid #10b981;padding:10px 14px;border-radius:6px;margin-bottom:12px;color:#cbd5e1;font-size:12px;line-height:1.7;';
    noteEl.innerHTML =
      '오늘 QVA 조건을 통과한 종목입니다. 점수 높은 순으로 정렬됩니다.<br>' +
      '<span class="badge tag-NEW_TODAY" style="font-size:10px;padding:1px 6px;border-radius:3px;">오늘 신규</span> 태그는 오늘 처음 QVA로 감지된 종목, ' +
      '<span class="badge tag-TODAY_RECONFIRMED" style="font-size:10px;padding:1px 6px;border-radius:3px;">오늘 재확인</span> 태그는 과거에 잡혔고 오늘도 다시 만족한 종목 (같은 흐름의 연속 발화).<br>' +
      '<strong style="color:#fbbf24;">QVA는 발생 후 20거래일 동안 VVI로 이어지는지 추적합니다. 매수 신호가 아니라 관찰 후보입니다.</strong>';
    sec.appendChild(noteEl);
  }

  // ─── EARLY_QVA: 요약 카드 + 안내문 ───
  if (stage === 'EARLY_QVA') {
    const eq = DATA.earlyQvaSummary || {};
    const summaryEl = document.createElement('div');
    summaryEl.className = 'tracking-summary';
    summaryEl.innerHTML =
      '<div class="card" style="border-color:#10b981;"><div class="lbl">오늘 통과 (위 섹션)</div><div class="cnt" style="color:#34d399;">' + (eq.todayCount ?? 0) + '</div></div>' +
      '<div class="card"><div class="lbl">추적 중 (VVI 전)</div><div class="cnt">' + (eq.trackingCount ?? 0) + '</div></div>' +
      '<div class="card strong"><div class="lbl">강한 QVA (80+)</div><div class="cnt">' + (eq.strongCount ?? 0) + '</div></div>' +
      '<div class="card"><div class="lbl">평균 점수</div><div class="cnt">' + (eq.avgScore ?? 0) + '</div></div>' +
      '<div class="card"><div class="lbl">거래대금 강돌파 (×3+)</div><div class="cnt">' + (eq.valueReactivationCount ?? 0) + '</div></div>' +
      '<div class="card"><div class="lbl">실질 저점 (≤+5%)</div><div class="cnt">' + (eq.higherLowCount ?? 0) + '</div></div>' +
      '<div class="card"><div class="lbl">가격 유지 동반</div><div class="cnt">' + (eq.priceHoldCount ?? 0) + '</div></div>';
    sec.appendChild(summaryEl);

    const noteEl = document.createElement('div');
    noteEl.style.cssText = 'background:#0f172a;border-left:3px solid #34d399;padding:10px 14px;border-radius:6px;margin-bottom:12px;color:#cbd5e1;font-size:12px;line-height:1.7;';
    noteEl.innerHTML =
      '<strong style="color:#34d399;">QVA 추적 중</strong>은 최근 20거래일 안에 QVA가 발생했고, 오늘은 통과 못했지만 아직 VVI2 확인 전인 관심 후보입니다.<br>' +
      'QVA → VVI2 전환률은 1년 검증에서 약 11%이므로 대부분의 추적 후보는 VVI2까지 진행되지 않지만, 일부는 VVI2/돌파 성공으로 진화합니다.<br>' +
      '<strong style="color:#fbbf24;">매수 신호가 아니라 관찰 후보입니다. 후보가 많을 경우 기본 접힘 처리되며, 펼쳐서 확인하세요 (최대 50건).</strong>';
    sec.appendChild(noteEl);
  }

  // ─── 컨트롤 (검색 + 빠른 필터) ───
  if (stage === 'QVA_TRACKING') {
    const ctrls = document.createElement('div');
    ctrls.className = 'controls';
    ctrls.innerHTML =
      '<input type="text" class="search" placeholder="종목명 또는 코드 검색…" data-stage="' + stage + '">' +
      '<div class="tag-filter">' +
        '<button data-qfilter="ALL" data-stage="' + stage + '">전체</button>' +
        '<button data-qfilter="TAG3" data-stage="' + stage + '">3/3</button>' +
        '<button data-qfilter="TAG2PLUS" data-stage="' + stage + '">2/3 이상</button>' +
        '<button data-qfilter="PRICE_HOLD" data-stage="' + stage + '">가격 유지</button>' +
        '<button data-qfilter="LOW_RISING" data-stage="' + stage + '">저점 상승</button>' +
        '<button data-qfilter="VALUE_REACTIVATION" data-stage="' + stage + '">거래대금 재활성</button>' +
        '<button data-qfilter="NO_RISK" data-stage="' + stage + '">위험 제외</button>' +
        '<button data-qfilter="EXPIRING" data-stage="' + stage + '">만료 임박</button>' +
      '</div>';
    sec.appendChild(ctrls);
  } else if (stage !== 'QVA_NEW' && stage !== 'FAILED') {
    const ctrls = document.createElement('div');
    ctrls.className = 'controls';
    ctrls.innerHTML = '<input type="text" class="search" placeholder="종목명 또는 코드 검색…" data-stage="' + stage + '">';
    sec.appendChild(ctrls);
  }

  // ─── QVA_TRACKING: 관심도 상위 10개 미리보기 (접힘 상태에서도 표시) ───
  if (stage === 'QVA_TRACKING') {
    const top = DATA.qvaTracking?.topPreview || [];
    const previewEl = document.createElement('div');
    previewEl.className = 'tracking-preview';
    if (top.length === 0) {
      previewEl.innerHTML = '<div class="preview-title">관심도 상위 10개 <span class="pill">없음</span></div>';
    } else {
      const head = '<thead><tr><th class="txt">종목</th><th>D+</th><th>현재 수익률</th><th>보조 태그</th><th>거래대금</th><th>관심도</th></tr></thead>';
      const body = '<tbody>' + top.map(c =>
        '<tr>' +
          '<td class="txt"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span>' + (c.expiringSoon ? '<span class="badge" style="background:#422006;color:#fbbf24;">만료임박</span>' : '') + (c.riskTag ? '<span class="badge" style="background:#4c1d1d;color:#fca5a5;">위험</span>' : '') + '</td>' +
          '<td>D+' + c.daysSinceQva + '</td>' +
          '<td>' + fmtPct(c.currentReturnFromSignal, true) + '</td>' +
          '<td>' + (c.auxTags?.length || 0) + '/3</td>' +
          '<td>' + fmtValue(c.currentValue) + '</td>' +
          '<td><strong style="color:#f1f5f9;">' + (c.watchScore ?? 0) + '</strong></td>' +
        '</tr>'
      ).join('') + '</tbody>';
      previewEl.innerHTML =
        '<div class="preview-title">🎯 관심도 상위 10개 <span class="pill">미리보기</span></div>' +
        '<table>' + head + body + '</table>';
    }
    sec.appendChild(previewEl);
  }

  // ─── 전체 테이블 (collapsed 시 .table-wrap만 hide) ───
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  if (items.length === 0) {
    let emptyMsg = '해당 후보가 없습니다.';
    if (stage === 'VVI_FIRED') {
      emptyMsg = '최신 거래일 기준 새 VVI2 발생 종목이 없어 다음 거래일 돌파 판정 대기 후보가 없습니다. ' +
        '최근 5거래일 내 VVI2 발생 종목은 별도 카운터로 표시되며, 이미 판정이 끝난 종목은 돌파 성공 또는 실패/이탈로 분류됩니다.';
      if (DATA.meta.isMarketClosedToday) {
        const why = DATA.meta.beforeMarketOpen ? '장 시작 전' : '휴장/주말';
        emptyMsg += ' (오늘 ' + fmtDate(DATA.meta.todayCalendarDate) + '은 ' + why + '이라 ' + fmtDate(DATA.meta.latestTradingDate) + ' 데이터 기준입니다.)';
      }
    }
    wrap.innerHTML = '<div class="empty">' + emptyMsg + '</div>';
  } else {
    const head = '<thead><tr>' + cols.map(c => '<th class="' + (c.txt ? 'txt' : '') + '">' + c.label + '</th>').join('') + '</tr></thead>';
    const body = '<tbody>' + items.map(c => {
      const dataAttrs = 'data-name="' + (c.name || '') + '" data-code="' + c.code + '"' +
        ' data-tags="' + (c.auxTags || []).join(',') + '"' +
        ' data-tagcount="' + (c.auxTags?.length || 0) + '"' +
        ' data-risk="' + !!c.riskTag + '"' +
        ' data-expiring="' + !!c.expiringSoon + '"';
      return '<tr ' + dataAttrs + '>' + cols.map(col => {
        const cell = col.render(c);
        return '<td' + (col.txt ? ' class="txt"' : '') + '>' + cell + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody>';
    wrap.innerHTML = '<table>' + head + body + '</table>';
  }
  sec.appendChild(wrap);

  // ─── 더보기 패턴: 행이 너무 많으면 처음 N개만 보이고 나머지는 토글로 노출 ───
  // 적용 대상: LONG_QVA_INTEREST / LONG_QVA_BREAKOUT_DONE / LONG_QVA_ALL
  //   - INTEREST는 기본 펼침이라 진입 즉시 더보기 버튼 노출
  //   - BREAKOUT_DONE / ALL은 기본 접힘이라 사용자가 섹션을 펼쳤을 때 더보기 버튼이 보임
  // 행 수가 SHOW_MORE_LIMIT 이하면 모두 보이고 버튼 없음.
  // 버튼은 wrap(.table-wrap) 안에 둬서 섹션 collapsed 시 함께 숨겨짐.
  const SHOW_MORE_LIMIT = 10;
  const showMoreApply = isLongInterest || isLongBreakoutDone || isLongAll;
  if (showMoreApply && items.length > SHOW_MORE_LIMIT) {
    const trs = wrap.querySelectorAll('tbody tr');
    let hiddenCount = 0;
    trs.forEach((tr, i) => {
      if (i >= SHOW_MORE_LIMIT) {
        tr.classList.add('row-extra');
        tr.style.display = 'none';
        hiddenCount++;
      }
    });
    if (hiddenCount > 0) {
      const showMoreBtn = document.createElement('button');
      showMoreBtn.type = 'button';
      showMoreBtn.className = 'show-more-btn';
      showMoreBtn.dataset.stage = stage;
      showMoreBtn.style.cssText = 'display:block;width:100%;margin-top:8px;padding:9px 14px;background:#1e293b;border:1px dashed #334155;border-radius:6px;color:#94a3b8;font-size:12px;font-weight:600;cursor:pointer;transition:all 0.12s;';
      showMoreBtn.textContent = '+ ' + hiddenCount + '개 더 보기 (전체 ' + items.length + '건)';
      showMoreBtn.addEventListener('mouseenter', () => { showMoreBtn.style.color = '#cbd5e1'; showMoreBtn.style.borderColor = '#475569'; });
      showMoreBtn.addEventListener('mouseleave', () => { showMoreBtn.style.color = '#94a3b8'; showMoreBtn.style.borderColor = '#334155'; });
      let expanded = false;
      showMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        expanded = !expanded;
        wrap.querySelectorAll('tr.row-extra').forEach(tr => {
          tr.style.display = expanded ? '' : 'none';
        });
        showMoreBtn.textContent = expanded
          ? '− 접기 (상위 ' + SHOW_MORE_LIMIT + '건만 보기)'
          : '+ ' + hiddenCount + '개 더 보기 (전체 ' + items.length + '건)';
      });
      wrap.appendChild(showMoreBtn);
    }
  }

  // ─── 섹션 하단 주의 문구 ───
  if (stage === 'BREAKOUT_SUCCESS' && items.length > 0) {
    const footer = document.createElement('div');
    footer.className = 'section-footer';
    footer.innerHTML =
      '⚠️ 현재가가 기준 진입가에서 많이 멀어진 경우에는 <strong>추격보다 눌림 확인</strong>이 필요합니다.';
    sec.appendChild(footer);

    // ─── D+5 백테스트 조합별 성과표 (H그룹 리스트 바로 아래) ───
    const btBox = document.createElement('div');
    btBox.style.cssText = 'background:#0f172a;border:1px solid #334155;border-left:3px solid #94a3b8;border-radius:8px;padding:12px 16px;margin-bottom:14px;';
    btBox.innerHTML =
      '<p style="margin:0;color:#cbd5e1;font-size:13px;line-height:1.7;">' +
        '📊 <strong style="color:#cbd5e1;">D+5 백테스트 기준</strong>, 가장 성과가 좋았던 조합은 ' +
        '<span style="color:#a7f3d0;font-weight:600;">거리 ≤10% + VPR 고가권 유지 + 위꼬리 적음</span>이었고, ' +
        '<strong>승률 59.38%, 매번 평균 +1.18%</strong>였습니다. ' +
        '이 표는 <em>개별 종목의 매수 등급이 아니라, 과거 조건 조합별 성과 참고표</em>입니다.' +
      '</p>' +
      '<p style="margin:6px 0 0 0;color:#94a3b8;font-size:11px;line-height:1.6;">' +
        '💡 <strong>거리</strong> = 매수 시점 가격이 기준 종가(VVI 돌파대기일 종가)에서 얼마나 떨어졌는지 %. ' +
        'H그룹 표의 "거리" 컬럼과 같은 개념. 작을수록 추격 위험이 작습니다.' +
      '</p>' +
      '<details open style="margin-top:8px;">' +
        '<summary style="cursor:pointer;color:#94a3b8;font-size:12px;">조합별 성과표 (클릭으로 접기)</summary>' +
        '<div style="margin-top:10px;overflow-x:auto;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;">' +
          '<thead><tr style="background:#1e293b;color:#94a3b8;">' +
            '<th style="text-align:left;padding:8px 10px;border-bottom:1px solid #334155;font-weight:600;">조합명</th>' +
            '<th style="text-align:left;padding:8px 10px;border-bottom:1px solid #334155;font-weight:600;">조건</th>' +
            '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid #334155;font-weight:600;">n</th>' +
            '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid #334155;font-weight:600;">승률</th>' +
            '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid #334155;font-weight:600;">매번 평균</th>' +
            '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid #334155;font-weight:600;">ΔWR</th>' +
            '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid #334155;font-weight:600;">ΔE</th>' +
            '<th style="text-align:left;padding:8px 10px;border-bottom:1px solid #334155;font-weight:600;">해석</th>' +
          '</tr></thead>' +
          '<tbody style="color:#cbd5e1;">' +
            '<tr style="background:rgba(99,102,241,0.10);">' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;font-weight:600;">전체 H그룹</td>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;color:#94a3b8;">전체</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">448</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">49.11%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">+0.26%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#94a3b8;">—</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#94a3b8;">—</td>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;color:#94a3b8;">기준값</td>' +
            '</tr>' +
            '<tr>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;font-weight:600;">기본 조합</td>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;color:#94a3b8;">거리 ≤10%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">334</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">50.60%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">+0.40%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#cbd5e1;">+1.49</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#cbd5e1;">+0.14</td>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;color:#94a3b8;">가장 넓은 기본 필터</td>' +
            '</tr>' +
            '<tr>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;font-weight:600;">공격 조합</td>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;color:#94a3b8;">거리 ≤12% + VPR 기준선 위 이상 + 거래대금 동반</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">252</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">51.98%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">+0.68%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#cbd5e1;">+2.87</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#cbd5e1;">+0.42</td>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;color:#94a3b8;">표본을 넓게 유지하면서 거래대금 동반을 보는 조합</td>' +
            '</tr>' +
            '<tr>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;font-weight:600;">보수 조합</td>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;color:#94a3b8;">거리 ≤8% + 위꼬리 적음</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">64</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">59.38%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">+0.98%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#cbd5e1;">+10.27</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#cbd5e1;">+0.72</td>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;color:#94a3b8;">거리와 위꼬리를 엄격하게 본 조합</td>' +
            '</tr>' +
            '<tr style="background:rgba(110,231,183,0.06);">' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;font-weight:600;color:#a7f3d0;">최상위 조합</td>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;color:#cbd5e1;">거리 ≤10% + VPR 고가권 유지 + 위꼬리 적음</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;">64</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#a7f3d0;">59.38%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#a7f3d0;">+1.18%</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#a7f3d0;">+10.27</td>' +
              '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #334155;color:#a7f3d0;">+0.92</td>' +
              '<td style="padding:7px 10px;border-bottom:1px solid #334155;color:#94a3b8;">검증상 가장 균형이 좋았던 조합</td>' +
            '</tr>' +
          '</tbody>' +
        '</table>' +
        '<p style="margin-top:8px;color:#94a3b8;font-size:11px;line-height:1.6;">' +
          '이 보드는 H그룹 종목의 D+5 단기 반응을 보는 화면입니다. <strong>종목별 운영 태그는 붙이지 않고</strong>, ' +
          '사용자가 VPR · 거리 · 위꼬리 · 거래대금 정보를 직접 확인해 판단할 수 있도록 구성합니다. ' +
          '위 조합별 성과표는 과거 백테스트에서 어떤 조건 조합이 더 좋은 결과를 보였는지 참고하기 위한 자료입니다.<br>' +
          '※ n이 50 이상인 조합은 의미 있는 통계로 보고, 그 미만은 참고용입니다. 보수 조합과 최상위 조합은 n=64로 경계선상.' +
        '</p>' +
        '</div>' +
      '</details>';
    sec.appendChild(btBox);
  } else if (stage === 'QVA_TRACKING') {
    const footer = document.createElement('div');
    footer.className = 'section-footer';
    footer.innerHTML = 'QVA 추적 중 후보는 <strong>아직 VVI 확인 전 단계</strong>입니다. 많은 후보 중 <strong>가격 유지, 저점 상승, 거래대금 재활성</strong> 태그가 함께 붙은 종목을 우선적으로 관찰합니다.';
    sec.appendChild(footer);
  }
  return sec;
}

// 메인 단계 렌더링 + 최근 VVI 발생 이력은 VVI_FIRED 다음 자리에 삽입
for (const s of stageOrder) {
  stagesWrap.appendChild(buildStageSection(s));
  if (s === 'VVI_FIRED') {
    stagesWrap.appendChild(buildRecentVviHistorySection());
  }
}

// ─── 최근 VVI 발생 이력 (참고 섹션) — 메인 단계 분류와 별개 ───
function buildRecentVviHistorySection() {
  const items = DATA.recentVviHistory?.items || [];
  const sm = DATA.recentVviHistory?.summary || { total: 0, success: 0, fail: 0, pending: 0 };

  const sec = document.createElement('div');
  sec.className = 'stage-section';
  sec.dataset.stage = 'RECENT_VVI_HISTORY';

  const title = document.createElement('h2');
  title.className = 'h-section';
  title.innerHTML =
    '<span>🎯 최근 VVI2 발생 이력</span>' +
    '<span class="pill">' + items.length + '건</span>' +
    '<span class="desc">최근 5거래일 안에 VVI2가 발생한 종목과 이후 돌파 판정 결과를 보여주는 참고 영역입니다.</span>' +
    '<span class="toggle" data-stage="RECENT_VVI_HISTORY">▲ 접기</span>';
  sec.appendChild(title);

  // 상단 요약 바
  const summary = document.createElement('div');
  summary.style.cssText = 'display:flex;gap:14px;margin-bottom:10px;font-size:13px;color:#cbd5e1;flex-wrap:wrap;padding:8px 12px;background:#0f172a;border-radius:6px;border:1px solid #334155;';
  summary.innerHTML =
    '<span>최근 5거래일 VVI2 발생 총 <strong style="color:#f1f5f9;">' + sm.total + '</strong>건</span>' +
    '<span class="muted">·</span>' +
    '<span>돌파 성공 <strong style="color:#10b981;">' + sm.success + '</strong>건</span>' +
    '<span class="muted">·</span>' +
    '<span>돌파 실패/이탈 <strong style="color:#f87171;">' + sm.fail + '</strong>건</span>' +
    '<span class="muted">·</span>' +
    '<span>판정 대기 <strong style="color:#fbbf24;">' + sm.pending + '</strong>건</span>';
  sec.appendChild(summary);

  // 검색 + 결과 필터
  const ctrls = document.createElement('div');
  ctrls.className = 'controls';
  ctrls.innerHTML =
    '<input type="text" class="search" placeholder="종목명 또는 코드 검색…" data-stage="RECENT_VVI_HISTORY">' +
    '<div class="tag-filter">' +
      '<button data-outcome="SUCCESS" data-stage="RECENT_VVI_HISTORY">돌파 성공</button>' +
      '<button data-outcome="FAIL" data-stage="RECENT_VVI_HISTORY">돌파 실패</button>' +
      '<button data-outcome="PENDING" data-stage="RECENT_VVI_HISTORY">판정 대기</button>' +
    '</div>';
  sec.appendChild(ctrls);

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  if (items.length === 0) {
    wrap.innerHTML = '<div class="empty">최근 5거래일 내 VVI2 발생 종목이 없습니다.</div>';
  } else {
    const outcomeRender = (o) => {
      if (o === 'SUCCESS') return '<span style="color:#10b981;font-weight:600;">돌파 성공</span>';
      if (o === 'FAIL') return '<span style="color:#f87171;font-weight:600;">돌파 실패</span>';
      return '<span style="color:#fbbf24;font-weight:600;">판정 대기</span>';
    };
    const cols = [
      { label: 'VVI2일', txt: true, render: c => fmtDate(c.vviDate) },
      { label: '종목', txt: true, render: c => '<a href="/stock/' + c.code + '?from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 종목 상세 페이지 열기"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + (c.isPreferred ? '<span class="badge pref">우</span>' : '') },
      { label: 'VVI2 고가', render: c => fmtNum(c.vviHigh) + '원' },
      { label: '+1% 기준가', render: c => fmtNum(c.breakoutEntryPrice1Pct) + '원' },
      { label: '다음 거래일 결과', txt: true, render: c => outcomeRender(c.vviOutcome) },
      { label: '현재 단계', txt: true, render: c => '<span class="muted">' + (DATA.meta.stageLabels[c.mainStage] || c.mainStage) + '</span>' },
      { label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
      { label: 'QVA 신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
      { label: '진입가 대비%', render: c => fmtPct(c.currentReturnFromEntry, true) },
    ];
    const head = '<thead><tr>' + cols.map(c => '<th class="' + (c.txt ? 'txt' : '') + '">' + c.label + '</th>').join('') + '</tr></thead>';
    const body = '<tbody>' + items.map(c => {
      const dataAttrs = 'data-name="' + (c.name || '') + '" data-code="' + c.code + '" data-outcome="' + c.vviOutcome + '" data-tags=""';
      return '<tr ' + dataAttrs + '>' + cols.map(col => '<td' + (col.txt ? ' class="txt"' : '') + '>' + col.render(c) + '</td>').join('') + '</tr>';
    }).join('') + '</tbody>';
    wrap.innerHTML = '<table>' + head + body + '</table>';
  }
  sec.appendChild(wrap);

  // 하단 주의 문구
  const footer = document.createElement('div');
  footer.className = 'section-footer';
  footer.innerHTML = '⚠️ 이 섹션은 <strong>매수 추천이 아니라</strong> VVI2 발생 이력과 돌파 판정 흐름을 보여주는 <strong>참고 정보</strong>입니다.';
  sec.appendChild(footer);

  return sec;
}

// 최근 VVI 발생 이력은 메인 render 루프에서 VVI_FIRED 다음 자리에 삽입됨

// QVA / VVI / H그룹 도움말 토글
const helpBtn = document.getElementById('help-btn');
const helpContent = document.getElementById('help-content');
if (helpBtn && helpContent) {
  helpBtn.addEventListener('click', () => {
    const collapsed = helpContent.classList.toggle('collapsed');
    helpBtn.classList.toggle('open', !collapsed);
    helpBtn.querySelector('span:first-child').textContent = collapsed
      ? '📖 단계 흐름 보기'
      : '📖 단계 흐름 닫기';
  });
}

// ─── 전체 종목 검색 — 모든 stage-section 테이블 행 필터링 ───
// 사용자 spec: 매칭 행이 접힌 섹션 안에 있으면 자동으로 펼쳐서 노출하고,
// 검색어를 비우면 원래 상태(접힘)로 복귀.
const globalSearch = document.getElementById('global-search');
const globalSearchStatus = document.getElementById('global-search-status');
const globalSearchClear = document.getElementById('global-search-clear');
if (globalSearch) {
  // 각 섹션의 사용자 의도 collapsed 상태(검색 전)를 기억
  const originalCollapsed = new Map();
  document.querySelectorAll('.stage-section').forEach(sec => {
    originalCollapsed.set(sec.dataset.stage, sec.classList.contains('collapsed'));
  });

  function setSectionCollapsed(sec, collapsed) {
    if (collapsed) sec.classList.add('collapsed');
    else sec.classList.remove('collapsed');
    const toggle = sec.querySelector('.toggle');
    if (toggle) {
      const cText = toggle.dataset.collapsedText || '▼ 펼치기';
      const eText = toggle.dataset.expandedText || '▲ 접기';
      toggle.textContent = collapsed ? cText : eText;
    }
  }

  function applyGlobalSearch() {
    const q = (globalSearch.value || '').trim().toLowerCase();
    let totalRows = 0, matchRows = 0;
    document.querySelectorAll('.stage-section').forEach(sec => {
      const stage = sec.dataset.stage;
      let secTotal = 0, secMatch = 0;
      sec.querySelectorAll('table tbody tr').forEach(tr => {
        secTotal++;
        if (q.length === 0) {
          tr.style.display = '';
          secMatch++;
          return;
        }
        const name = (tr.dataset.name || '').toLowerCase();
        const code = (tr.dataset.code || '').toLowerCase();
        const text = (name || code) ? '' : (tr.textContent || '').toLowerCase();
        const match = name.includes(q) || code.includes(q) || text.includes(q);
        tr.style.display = match ? '' : 'none';
        if (match) secMatch++;
      });
      totalRows += secTotal;
      matchRows += secMatch;

      // 매칭 카운트 pill 갱신
      const matchPill = sec.querySelector('.search-match-pill');
      if (matchPill) matchPill.remove();
      if (q.length > 0 && secTotal > 0) {
        const title = sec.querySelector('.h-section');
        if (title) {
          const pill = document.createElement('span');
          pill.className = 'pill search-match-pill';
          pill.style.cssText = 'background:' + (secMatch > 0 ? '#1e3a8a' : '#334155') + ';color:#fff;font-weight:600;';
          pill.textContent = '🔍 ' + secMatch + '/' + secTotal;
          title.appendChild(pill);
        }
      }

      // 핵심 fix: 검색어가 있고 매칭 행이 있으면 섹션을 자동으로 펼친다.
      // 검색어가 비면 원래(검색 전) collapsed 상태로 복귀.
      if (q.length === 0) {
        setSectionCollapsed(sec, originalCollapsed.get(stage) === true);
      } else if (secMatch > 0) {
        setSectionCollapsed(sec, false);
      }
    });
    if (q.length === 0) {
      globalSearchStatus.textContent = '';
    } else {
      globalSearchStatus.innerHTML = '전체 <strong style="color:#f1f5f9;">' + totalRows +
        '</strong>건 중 <strong style="color:#6ee7b7;">' + matchRows + '</strong>건 매칭';
    }
  }
  globalSearch.addEventListener('input', applyGlobalSearch);
  if (globalSearchClear) {
    globalSearchClear.addEventListener('click', () => {
      globalSearch.value = '';
      applyGlobalSearch();
      globalSearch.focus();
    });
  }
}

// 단계 카드 클릭 — 해당 섹션으로 스크롤
document.querySelectorAll('.stage-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const stage = pill.dataset.stage;
    const sec = document.querySelector('.stage-section[data-stage="' + stage + '"]');
    if (sec) {
      // 접혀있으면 펴기
      sec.classList.remove('collapsed');
      const toggle = sec.querySelector('.toggle');
      if (toggle) toggle.textContent = '▲ 접기';
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// 펼침/접기 토글 — 단계별 라벨은 data-collapsed-text / data-expanded-text 사용
document.querySelectorAll('.toggle').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const stage = btn.dataset.stage;
    const sec = document.querySelector('.stage-section[data-stage="' + stage + '"]');
    if (sec) {
      sec.classList.toggle('collapsed');
      const collapsed = sec.classList.contains('collapsed');
      const txtCollapsed = btn.dataset.collapsedText || '▼ 펼치기';
      const txtExpanded = btn.dataset.expandedText || '▲ 접기';
      btn.textContent = collapsed ? txtCollapsed : txtExpanded;
    }
  });
});

// 검색 + 태그 + outcome + qfilter (QVA_TRACKING 전용)
function applyFiltersForStage(stage) {
  const sec = document.querySelector('.stage-section[data-stage="' + stage + '"]');
  if (!sec) return;
  const searchInput = sec.querySelector('input.search');
  const q = (searchInput?.value || '').trim().toLowerCase();
  const activeBtns = Array.from(sec.querySelectorAll('.tag-filter button.active'));
  const activeTags = activeBtns.filter(b => b.dataset.tag).map(b => b.dataset.tag);
  const activeOutcomes = activeBtns.filter(b => b.dataset.outcome).map(b => b.dataset.outcome);
  const activeQfilters = activeBtns.filter(b => b.dataset.qfilter).map(b => b.dataset.qfilter);

  // 'ALL' 필터가 active면 그것만 유효하게 — 다른 qfilter는 무시
  const isAll = activeQfilters.includes('ALL');

  sec.querySelectorAll('tbody tr').forEach(tr => {
    const name = (tr.dataset.name || '').toLowerCase();
    const code = (tr.dataset.code || '').toLowerCase();
    const tags = (tr.dataset.tags || '').split(',');
    const outcome = tr.dataset.outcome || '';
    const tagcount = parseInt(tr.dataset.tagcount || '0', 10);
    const isRisk = tr.dataset.risk === 'true';
    const isExpiring = tr.dataset.expiring === 'true';

    const matchQ = !q || name.includes(q) || code.includes(q);
    const matchT = activeTags.length === 0 || activeTags.every(t => tags.includes(t));
    const matchO = activeOutcomes.length === 0 || activeOutcomes.includes(outcome);

    let matchF = true;
    if (!isAll && activeQfilters.length > 0) {
      for (const f of activeQfilters) {
        if (f === 'TAG3' && tagcount !== 3) { matchF = false; break; }
        if (f === 'TAG2PLUS' && tagcount < 2) { matchF = false; break; }
        if ((f === 'PRICE_HOLD' || f === 'LOW_RISING' || f === 'VALUE_REACTIVATION') && !tags.includes(f)) { matchF = false; break; }
        if (f === 'NO_RISK' && isRisk) { matchF = false; break; }
        if (f === 'EXPIRING' && !isExpiring) { matchF = false; break; }
      }
    }

    tr.style.display = matchQ && matchT && matchO && matchF ? '' : 'none';
  });
}
document.querySelectorAll('input.search').forEach(input => {
  input.addEventListener('input', () => applyFiltersForStage(input.dataset.stage));
});
document.querySelectorAll('.tag-filter button').forEach(btn => {
  btn.addEventListener('click', () => {
    // QVA_TRACKING의 'ALL' 버튼은 다른 qfilter를 모두 끔
    if (btn.dataset.qfilter === 'ALL') {
      const sec = btn.closest('.stage-section');
      if (sec) {
        sec.querySelectorAll('.tag-filter button[data-qfilter]').forEach(b => {
          if (b !== btn) b.classList.remove('active');
        });
      }
      btn.classList.add('active');
    } else {
      // 다른 qfilter 클릭 시 'ALL'은 끈다
      const sec = btn.closest('.stage-section');
      if (sec && btn.dataset.qfilter) {
        const allBtn = sec.querySelector('.tag-filter button[data-qfilter="ALL"]');
        if (allBtn) allBtn.classList.remove('active');
      }
      btn.classList.toggle('active');
    }

    // 접힘 상태에서 필터를 누르면 자동 펼침
    const sec = btn.closest('.stage-section');
    if (sec && sec.classList.contains('collapsed')) {
      sec.classList.remove('collapsed');
      const toggleEl = sec.querySelector('.toggle');
      if (toggleEl) {
        toggleEl.textContent = toggleEl.dataset.expandedText || '▲ 접기';
      }
    }

    applyFiltersForStage(btn.dataset.stage);
  });
});
</script>
</body>
</html>
`;

const html = htmlTemplate.replace('__JSON_DATA__', JSON.stringify(jsonOut));
fs.writeFileSync(path.join(ROOT, 'qva-watchlist-board.html'), html, 'utf-8');
console.log(`✅ HTML 저장: qva-watchlist-board.html  (Express /qva-watchlist 라우트로 접근)\n`);

// DB 저장 (실패해도 HTML/JSON은 정상)
(async () => {
  try {
    const { saveQvaWatchlistBoardToDB } = require('../../src/db/saveBoardSignals');
    const r = await saveQvaWatchlistBoardToDB(jsonOut, {
      jsonPath: path.join(ROOT, 'qva-watchlist-board.json'),
      htmlPath: path.join(ROOT, 'qva-watchlist-board.html'),
    });
    if (r) console.log(`🗄  DB 저장: runId=${r.runId} rows=${r.totalRows} (inserted=${r.inserted} updated=${r.updated})`);
  } catch (e) {
    console.warn(`⚠ DB 저장 실패 (HTML/JSON은 정상 저장됨): ${e.message}`);
  } finally {
    try { await require('../../src/db/mysql').closePool(); } catch (_) {}
  }
})();
