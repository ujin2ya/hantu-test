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
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const TRACKING_DAYS = 20;
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

// 가장 최근 거래일 (= TODAY = latestTradingDate) 결정 — 전체 캐시의 최신 날짜
// 동시에 모든 거래일 set을 모아 tradingDateCount/거래일 갭 분석에 사용
let TODAY = '';
const allTradingDateSet = new Set();
for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, f), 'utf-8'));
    const rows = d.rows || [];
    const last = rows[rows.length - 1]?.date;
    if (last && last > TODAY) TODAY = last;
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

const _now = new Date();
const todayCalendarDate = `${_now.getFullYear()}${String(_now.getMonth() + 1).padStart(2, '0')}${String(_now.getDate()).padStart(2, '0')}`;
const isMarketClosedToday = todayCalendarDate !== TODAY;
const nextTradingDate = nextTradingDayAfter(TODAY);

console.log(`기준일 (latestTradingDate): ${formatDate(TODAY)}`);
console.log(`달력 오늘 (todayCalendarDate): ${formatDate(todayCalendarDate)} ${isMarketClosedToday ? '(휴장/주말)' : '(거래일)'}`);
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
  try { chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8')); }
  catch (_) { continue; }
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

  // ─── VVI 검출 (QVA 이후) ───
  let vviIdx = null;
  let vviInfo = null;
  for (let k = 1; k <= daysSinceQva; k++) {
    const cand = qvaIdx + k;
    const candDate = rows[cand].date;
    const slicedChart = rows.slice(0, cand + 1);
    const slicedFlow = flowRows.filter(r => r.date <= candDate);
    if (slicedFlow.length < 10) continue;
    let vvi = null;
    try { vvi = ps.calculateVolumeValueIgnition(slicedChart, slicedFlow, namedMeta); }
    catch (_) { vvi = null; }
    if (vvi?.passed) { vviIdx = cand; vviInfo = vvi; break; }
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
          stageReason = `${formatDate(breakoutInfo.date)} 돌파 실패 (다음 종가 < VVI 고가)`;
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
      stageReason = `D+${TRACKING_DAYS} 만료, VVI 미발생`;
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

// ─────────── Early QVA 별도 스캔 ───────────
// 기존 Confirmed QVA가 잡지 못하는, 더 이른 바닥권 초기 흔적을 별도 스캔.
// 최근 TRACKING_DAYS 거래일 윈도우 안에서 ps.calculateEarlyQVA passed=true 인
// 모든 신호를 모아 first/best (= 점수 max) 추출.
const earlyQvaCandidates = [];
const t1 = Date.now();
console.log(`\n🌱 Early QVA 스캔 시작...`);
for (let fi = 0; fi < files.length; fi++) {
  if (fi % 500 === 0) process.stdout.write(`  Early QVA 진행 ${fi}/${files.length}\r`);
  const code = files[fi].replace('.json', '');
  const meta = codeMeta.get(code);
  if (!meta) continue;
  if (isExcludedProduct(meta.name)) continue;
  let chart;
  try { chart = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, files[fi]), 'utf-8')); }
  catch (_) { continue; }
  const rows = chart.rows || [];
  if (rows.length < 65) continue;

  const todayIdx = rows.findIndex(r => r.date === TODAY);
  if (todayIdx < 0) continue;
  const todayRow = rows[todayIdx];
  if (!todayRow.close || todayRow.close <= 0) continue;

  const namedMeta = { ...meta, name: meta.name || chart.name };

  // 윈도우 안 모든 Early QVA 신호 수집
  const earlySignals = [];
  for (let k = 0; k <= TRACKING_DAYS && todayIdx - k >= 60; k++) {
    const cand = todayIdx - k;
    const sliced = rows.slice(0, cand + 1);
    let res = null;
    try { res = ps.calculateEarlyQVA(sliced, [], namedMeta); }
    catch (_) { res = null; }
    if (res?.passed) {
      earlySignals.push({
        idx: cand, date: rows[cand].date, score: res.score,
        grade: res.grade, gradeLabel: res.gradeLabel, signals: res.signals,
      });
    }
  }
  if (earlySignals.length === 0) continue;

  // first = 가장 이른 (= 큰 k = 작은 idx), best = 점수 max
  earlySignals.sort((a, b) => a.idx - b.idx);
  const firstSig = earlySignals[0];
  const bestSig = earlySignals.reduce((acc, s) => (s.score > acc.score ? s : acc), earlySignals[0]);
  // 화면 anchor = 가장 이른 신호 (사용자 요청: "최초 감지일 우선 표시")
  const anchorSig = firstSig;

  const currentClose = todayRow.close;
  const signalPrice = rows[anchorSig.idx].close;
  const currentReturnFromSignal = (currentClose / signalPrice - 1) * 100;
  const daysSinceFirst = todayIdx - firstSig.idx;
  const daysSinceBest = todayIdx - bestSig.idx;

  earlyQvaCandidates.push({
    code,
    name: meta.name,
    market: meta.market,
    isPreferred: isPreferredStock(meta.name),
    marketValue: meta.marketValue,

    firstEarlyQvaDate: firstSig.date,
    bestEarlyQvaDate: bestSig.date,
    bestEarlyQvaScore: bestSig.score,
    bestEarlyQvaGrade: bestSig.grade,
    bestEarlyQvaGradeLabel: bestSig.gradeLabel,
    earlyQvaSignalCount: earlySignals.length,
    daysSinceFirst,
    daysSinceBest,

    anchorPrice: signalPrice,
    currentDate: TODAY,
    currentClose,
    currentReturnFromSignal: round2(currentReturnFromSignal),

    // 화면용 보조 데이터
    signals: anchorSig.signals,
    // 보조 태그 — Confirmed QVA 통과 여부는 아래에서 채움
    auxTags: [],
  });
}
process.stdout.write(`  Early QVA 진행 ${files.length}/${files.length}\n`);
console.log(`→ Early QVA 후보: ${earlyQvaCandidates.length}건 (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

// ─── Early QVA 후보에 'CONFIRMED_QVA_PASS' 보조 태그 부여 ───
// 메인 candidates 배열에 같은 code가 있으면 = Confirmed QVA 윈도우(D-20~D)에도 통과한 종목
// 사용자 spec: 초기 QVA 이후 가격 유지·저점 상승·거래대금 흐름이 한 번 더 확인된 상태
const confirmedQvaCodeSet = new Set(candidates.map(c => c.code));
let confirmedPassCount = 0;
for (const ec of earlyQvaCandidates) {
  if (confirmedQvaCodeSet.has(ec.code)) {
    ec.auxTags = ['CONFIRMED_QVA_PASS'];
    ec.confirmedQvaPass = true;
    confirmedPassCount++;
  } else {
    ec.confirmedQvaPass = false;
  }
}
console.log(`→ Early QVA 후보 중 '확인 QVA 통과' 태그: ${confirmedPassCount}건`);

// ─────────── 단계별 그룹핑 ───────────
// 메인 화면 표시 단계 — 사용자 spec에 따라 단순화 (Early QVA 중심).
// QVA_TRACKING / QVA_NEW (Confirmed QVA)는 내부 로직에는 유지하나 메인 화면에서 제거.
// 기존 Confirmed QVA 통과 여부는 Early QVA 후보의 'CONFIRMED_QVA_PASS' 보조 태그로 노출.
const stageOrder = ['BREAKOUT_SUCCESS', 'VVI_FIRED', 'EARLY_QVA', 'FAILED'];
// 내부 로직용 전체 단계 (백테스트, 전환률, 그룹 분류 등에서 계속 사용)
const allStageOrder = ['BREAKOUT_SUCCESS', 'VVI_FIRED', 'QVA_TRACKING', 'QVA_NEW', 'EARLY_QVA', 'FAILED'];
const stageLabels = {
  BREAKOUT_SUCCESS: '돌파 성공 확인 종목',
  VVI_FIRED: '다음 거래일 돌파 대기',
  QVA_TRACKING: '확인 QVA 추적 중 (기존 QVA)',
  QVA_NEW: '확인 QVA 신규 (기존 QVA)',
  EARLY_QVA: '🌱 초기 QVA (Early QVA)',
  FAILED: '실패/이탈',
};
const stageDescriptions = {
  BREAKOUT_SUCCESS:
    '돌파 성공 확인 종목은 QVA → VVI → +1% 돌파 → 종가 유지까지 통과한 후보입니다. 1년 검증에서 20일 뒤 플러스 마감 비율 71.0%, 평균 수익률 +15.1%를 기록했습니다 (QVA 단독 56.2% 대비 큰 폭 개선). 단, 매수 추천이 아니며 현재가가 기준 가격에서 많이 멀어진 경우에는 눌림 확인 또는 관리 구간으로 봐야 합니다.',
  VVI_FIRED:
    'VVI는 QVA 후보 중 실제 거래대금 초동이 확인된 상태입니다. VVI 다음 거래일에 vviHigh × 1.01 돌파 여부를 기다리는 후보입니다.',
  QVA_TRACKING:
    '기존 (Confirmed) QVA 발생 후 20거래일 동안 VVI 발생 여부를 지켜보는 후보입니다. 1년 검증에서 QVA 단독의 20일 뒤 플러스 마감 비율은 56.2%로, 바로 매수하기보다는 추적 후보로 보는 것이 적절합니다.',
  QVA_NEW:
    '기존 (Confirmed) QVA는 처음 관심 후보로 잡는 단계입니다. 1년 검증에서 QVA 단독의 20일 뒤 플러스 마감 비율은 56.2%로, 바로 매수하기보다는 20거래일 추적 후보로 보는 것이 적절합니다.',
  EARLY_QVA:
    '초기 QVA(Early QVA)는 기존 QVA보다 더 빠르게 수급 흔적을 잡기 위한 감시 후보입니다. 아직 크게 오르기 전, 거래대금이 조용히 살아나고 저점이 안정되는 종목을 찾습니다. 기존 QVA보다 빠른 대신 실패 가능성도 높기 때문에, 화면에는 점수가 높은 후보 위주로 표시합니다 (70점 이상, 최대 50개).',
  FAILED:
    'QVA 이후 가격이 크게 무너졌거나, 20거래일 안에 VVI가 발생하지 않았거나, 돌파에 실패한 종목입니다.',
};

const auxTagLabels = {
  PRICE_HOLD: '가격 유지',
  LOW_RISING: '저점 상승',
  VALUE_REACTIVATION: '거래대금 재활성',
  CONFIRMED_QVA_PASS: '확인 QVA 통과',
};
const auxTagDescriptions = {
  PRICE_HOLD: '현재 종가가 QVA 신호가의 95% 이상',
  LOW_RISING: '최근 5거래일 저가 최소값 > 그 이전 5거래일 저가 최소값',
  VALUE_REACTIVATION: '최근 3거래일 평균 거래대금이 신호 직전 20일 평균의 1.5배 이상',
  CONFIRMED_QVA_PASS: '초기 QVA 이후 가격 유지·저점 상승·거래대금 흐름이 한 번 더 확인된 상태입니다.',
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
const judgmentDescriptions = {
  REVIEW_OK: '기준 진입가에서 크게 멀어지지 않은 상태입니다. 매수 추천이 아니라 추격을 피하기 위한 가격 위치 확인 기준입니다.',
  CHASE_CAUTION: '진입가 대비 +3% ~ +7% — 추격 시 주의가 필요한 구간.',
  PULLBACK_WAIT: '진입가 대비 +7% 초과 또는 돌파 후 3일 경과 — 눌림 확인 후 재검토 권장.',
  MANAGEMENT: '진입가 대비 +15% 이상 — 이미 관리 영역. 신규 진입보다 보유/익절 관점.',
  BREAKDOWN_WEAK: '현재가가 진입가 또는 VVI 고가 아래로 밀림 — 돌파 약화 신호.',
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
// 내부 로직용 카운트는 모든 단계 (QVA_TRACKING/QVA_NEW 포함) — 백테스트/요약에서 사용
for (const s of allStageOrder) stageCounts[s] = byStage.get(s)?.length || 0;
// Early QVA는 별도 후보 리스트 (화면 표시 = 70점 이상 strict)
// 단계 pill 카운트는 화면 노출분 기준으로 표시
// (전체 raw 카운트는 earlyQvaSummary에서 별도 노출)
// 아래에서 stagedItems.EARLY_QVA가 채워진 후 stageCounts도 갱신함
stageCounts.EARLY_QVA = earlyQvaCandidates.length; // 임시값, 아래에서 displayed로 교체

// ─────────── 정렬 (각 단계별로 보기 좋게) ───────────
function sortStage(stage, items) {
  const arr = items.slice();
  switch (stage) {
    case 'BREAKOUT_SUCCESS':
      // 가장 최근 돌파부터, 같으면 신호가 대비 수익률 높은 순
      // 진입 판단 상태 순 (검토 → 추격 → 눌림 → 관리 → 약화) → 같은 상태 내 돌파 후 경과일 짧은 순
      arr.sort((a, b) => {
        const ai = judgmentOrder.indexOf(a.judgmentStatus);
        const bi = judgmentOrder.indexOf(b.judgmentStatus);
        if (ai !== bi) return ai - bi;
        return (a.daysFromBreakout ?? 0) - (b.daysFromBreakout ?? 0);
      });
      break;
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

const stagedItems = {};
// 내부 로직용 — 모든 단계를 stagedItems에 저장 (qvaTracking 미리보기, 백테스트 등)
for (const s of allStageOrder) {
  stagedItems[s] = sortStage(s, byStage.get(s) || []);
}
// Early QVA — 화면 노출 제한 + 정렬 (사용자 spec)
//   1) earlyQvaScore 높은 순
//   2) 거래대금 재활성 배율 (tv3Ratio) 높은 순
//   3) 저점 상승 태그 있는 순 (higherLow=true 우선)
//   4) 20일 저점 대비 상승폭 낮은 순
const earlyQvaSorted = earlyQvaCandidates.slice().sort((a, b) => {
  const sA = a.bestEarlyQvaScore ?? 0, sB = b.bestEarlyQvaScore ?? 0;
  if (sB !== sA) return sB - sA;
  const tA = a.signals?.tv3Ratio ?? 0, tB = b.signals?.tv3Ratio ?? 0;
  if (tB !== tA) return tB - tA;
  const hA = a.signals?.higherLow ? 1 : 0, hB = b.signals?.higherLow ? 1 : 0;
  if (hB !== hA) return hB - hA;
  const rA = a.signals?.returnFromLow20 ?? 0, rB = b.signals?.returnFromLow20 ?? 0;
  return rA - rB;
});

// 화면 표시 = 70점 이상 (EARLY_QVA + STRONG_EARLY_QVA), 최대 50개
const EARLY_QVA_DISPLAY_THRESHOLD = 70;
const EARLY_QVA_DISPLAY_LIMIT = 50;
const earlyQvaDisplayed = earlyQvaSorted
  .filter(c => (c.bestEarlyQvaScore ?? 0) >= EARLY_QVA_DISPLAY_THRESHOLD)
  .slice(0, EARLY_QVA_DISPLAY_LIMIT);

// stages.EARLY_QVA에는 화면 표시분만 (기본 보드는 정리된 상태)
// stages.EARLY_QVA_ALL에는 전체를 저장 (전체 보기 모드용)
stagedItems.EARLY_QVA = earlyQvaDisplayed;
stagedItems.EARLY_QVA_ALL = earlyQvaSorted;

// 요약 통계
const strongEarlyCount = earlyQvaSorted.filter(c => c.bestEarlyQvaGrade === 'STRONG_EARLY_QVA').length;
const earlyMidCount = earlyQvaSorted.filter(c => c.bestEarlyQvaGrade === 'EARLY_QVA').length;
const watchEarlyCount = earlyQvaSorted.filter(c => c.bestEarlyQvaGrade === 'WATCH_EARLY').length;
const avgEarlyScore = earlyQvaSorted.length > 0
  ? Math.round(earlyQvaSorted.reduce((s, c) => s + (c.bestEarlyQvaScore || 0), 0) / earlyQvaSorted.length)
  : 0;
const valueReactivationCount = earlyQvaSorted.filter(c => (c.signals?.tv3Ratio ?? 0) >= 1.5).length;
const higherLowCount = earlyQvaSorted.filter(c => c.signals?.higherLow).length;
const priceHoldCount = earlyQvaSorted.filter(c => {
  // close >= prevClose 와 비슷한 의미 (signals에 없으니 currentReturnFromSignal 양수로 근사)
  return (c.currentReturnFromSignal ?? -1) >= 0;
}).length;

const earlyQvaSummary = {
  totalCount: earlyQvaSorted.length,
  strongCount: strongEarlyCount,
  earlyCount: earlyMidCount,
  watchCount: watchEarlyCount,
  displayedCount: earlyQvaDisplayed.length,
  displayThreshold: EARLY_QVA_DISPLAY_THRESHOLD,
  displayLimit: EARLY_QVA_DISPLAY_LIMIT,
  avgScore: avgEarlyScore,
  valueReactivationCount,
  higherLowCount,
  priceHoldCount,
};

// Early QVA 디버그 로그 (raw / 등급별 / 표시)
console.log(`\n🌱 Early QVA 분포:`);
console.log(`  Early QVA raw candidates:    ${earlyQvaSorted.length}`);
console.log(`  STRONG_EARLY_QVA (80+):      ${strongEarlyCount}`);
console.log(`  EARLY_QVA (70~79):           ${earlyMidCount}`);
console.log(`  WATCH_EARLY (60~69):         ${watchEarlyCount}`);
console.log(`  Displayed (70+, max 50):     ${earlyQvaDisplayed.length}`);
console.log(`  평균 점수:                   ${avgEarlyScore}`);
console.log(`  거래대금 재활성 동반:        ${valueReactivationCount}`);
console.log(`  저점 상승 동반:              ${higherLowCount}`);

// stageCounts.EARLY_QVA는 화면 표시분 기준으로 갱신
stageCounts.EARLY_QVA = earlyQvaDisplayed.length;

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
    purpose: 'QVA → VVI → 돌파 성공의 funnel 전체를 한 화면에 보여주는 매일 운영용 보드',
    notice: '본 보드는 매수 추천이 아니라 후보 추적/모니터링용입니다. 실제 매매는 차트, 뉴스, 시장 상황을 함께 보고 판단해야 합니다.',
    boardBasisNotice: '현재 보드는 최신 거래일 기준으로 생성됩니다. 오늘이 휴장일이면 마지막 거래일 데이터를 기준으로 표시됩니다.',
    today: TODAY,
    todayCalendarDate,
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
    auxTagLabels,
    auxTagDescriptions,
    judgmentOrder,
    judgmentLabels,
    judgmentDescriptions,
    generatedAt: new Date().toISOString(),
  },
  summary,
  earlyQvaSummary,
  stages: stagedItems,
  recentVviHistory: {
    items: recentVviHistoryItems,
    summary: recentVviHistorySummary,
    note: '이 섹션은 매수 추천이 아니라 VVI 발생 이력과 돌파 판정 흐름을 보여주는 참고 정보입니다.',
  },
  qvaTracking: {
    summary: qvaTrackingSummary,
    topPreview: qvaTrackingTopPreview,
    note: 'QVA 추적 중 후보는 아직 VVI 확인 전 단계입니다. 많은 후보 중 가격 유지, 저점 상승, 거래대금 재활성 태그가 함께 붙은 종목을 우선적으로 관찰합니다.',
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
  th .help { display: inline-block; margin-left: 4px; color: #60a5fa; cursor: help; font-size: 10px; }

  .table-wrap { background: #1e293b; padding: 8px; border-radius: 8px; margin-bottom: 14px; overflow-x: auto; }
  .empty { color: #64748b; padding: 16px; text-align: center; font-size: 13px; }

  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; margin: 0 2px 2px 0; }
  .badge.tag-PRICE_HOLD { background: #1e3a8a; color: #93c5fd; }
  .badge.j-REVIEW_OK     { background: #1e3a8a; color: #93c5fd; }
  .badge.j-CHASE_CAUTION { background: #422006; color: #fbbf24; }
  .badge.j-PULLBACK_WAIT { background: #5c2c0f; color: #fb923c; }
  .badge.j-MANAGEMENT    { background: #4c1d95; color: #c4b5fd; }
  .badge.j-BREAKDOWN_WEAK{ background: #4c1d1d; color: #fca5a5; }
  .section-footer { color: #94a3b8; font-size: 12px; line-height: 1.6; padding: 10px 14px; background: #1e293b; border-radius: 6px; border-left: 3px solid #f59e0b; margin-top: -8px; margin-bottom: 14px; }
  .badge.tag-LOW_RISING { background: #14532d; color: #6ee7b7; }
  .badge.tag-VALUE_REACTIVATION { background: #422006; color: #fbbf24; }
  .badge.tag-CONFIRMED_QVA_PASS { background: #1e3a8a; color: #93c5fd; border: 1px solid #3b82f6; font-weight: 600; }
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
  <h1>📋 QVA 매일 운영 보드<span class="sub">— 매일 장마감 후 갱신되는 후보 추적 보드 (백테스트 보고서 아님)</span></h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="nav">
    <a href="/qva-watchlist" class="active">📋 매일 운영 보드</a>
    <a href="/qva-review-ok" title="QVA 단독, H그룹, 진입가 근처 후보의 성과를 비교한 검증 보고서">📊 3단계 코호트 비교 보고서</a>
  </div>

  <div class="info-box" style="background:#0f172a;border-left-color:#34d399;border-left-width:4px;padding:18px 22px;">
    <p>이 화면은 <strong>'살 종목'을 알려주는 곳이 아니라, 관심 있게 지켜볼 종목을 단계별로 정리해주는 화면</strong>입니다.</p>
    <p style="margin-top:10px;">흐름은 단순합니다.</p>
    <p style="margin-top:6px;font-size:15px;text-align:center;background:#1e293b;padding:10px 12px;border-radius:6px;">
      <strong style="color:#34d399;">🌱 초기 QVA</strong>
      <span style="color:#64748b;">→</span>
      <strong style="color:#3b82f6;">⏳ VVI</strong>
      <span style="color:#64748b;">→</span>
      <strong style="color:#10b981;">🔥 돌파 성공</strong>
    </p>
    <p style="margin-top:10px;"><strong style="color:#34d399;">초기 QVA</strong>는 아직 크게 오르기 전, 거래대금이 조용히 살아나고 저점이 안정되는 관심 후보입니다.<br>
    <strong style="color:#3b82f6;">VVI</strong>는 그중 실제로 거래대금이 강하게 붙은 단계입니다.<br>
    <strong style="color:#10b981;">돌파 성공</strong>은 VVI 이후 가격이 한 번 더 올라가고 종가도 버틴 상태입니다.</p>
    <p style="margin-top:10px;">과거 1년 검증에서는 초기 QVA의 20일 뒤 플러스 마감 비율이 <strong style="color:#34d399;">58.2%</strong>였고, 초기 QVA가 돌파 성공까지 진행된 경우에는 <strong style="color:#6ee7b7;">83.3%</strong>였습니다.</p>
    <p style="margin-top:8px;">즉, 단계가 진행될수록 과거 데이터상 좋은 흐름을 보인 비율이 높아졌습니다.</p>
    <p style="margin-top:10px;color:#fbbf24;">다만 이 결과는 과거 통계일 뿐이며, 매수 추천이 아닙니다. <strong>실제 판단은 현재 가격, 차트, 뉴스, 거래대금, 시장 상황을 함께 보고 사용자가 직접 해야 합니다.</strong></p>
  </div>

  <h2 style="font-size:14px;color:#cbd5e1;margin:0 0 8px 0;border:none;padding:0;">📊 1년 검증 요약</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:16px;">
    <div style="background:#1e293b;border-left:3px solid #34d399;padding:14px 16px;border-radius:6px;">
      <div style="color:#94a3b8;font-size:12px;">🌱 초기 QVA</div>
      <div style="color:#34d399;font-size:24px;font-weight:700;margin-top:4px;">58.2%</div>
      <div style="color:#cbd5e1;font-size:11px;margin-top:2px;">20일 뒤 플러스 마감 비율</div>
    </div>
    <div style="background:#1e293b;border-left:3px solid #10b981;padding:14px 16px;border-radius:6px;">
      <div style="color:#94a3b8;font-size:12px;">🔥 초기 QVA → 돌파 성공</div>
      <div style="color:#6ee7b7;font-size:24px;font-weight:700;margin-top:4px;">83.3%</div>
      <div style="color:#cbd5e1;font-size:11px;margin-top:2px;">20일 뒤 플러스 마감 비율</div>
      <div style="color:#94a3b8;font-size:10px;margin-top:4px;">단, 표본이 적어 참고 지표입니다.</div>
    </div>
    <div style="background:#1e293b;border-left:3px solid #60a5fa;padding:14px 16px;border-radius:6px;">
      <div style="color:#94a3b8;font-size:12px;">초기 QVA의 장점</div>
      <div style="color:#93c5fd;font-size:24px;font-weight:700;margin-top:4px;">4.6일 먼저</div>
      <div style="color:#cbd5e1;font-size:11px;margin-top:2px;">기존 QVA보다 평균 더 빠르게 포착</div>
    </div>
    <div style="background:#1e293b;border-left:3px solid #94a3b8;padding:14px 16px;border-radius:6px;">
      <div style="color:#94a3b8;font-size:12px;">해석</div>
      <div style="color:#cbd5e1;font-size:12px;line-height:1.5;margin-top:4px;">초기 QVA는 더 빠른 관심 후보입니다. VVI와 돌파 성공까지 진행될수록 과거 데이터상 좋은 흐름을 보인 비율이 높아졌습니다. 단, 매수 신호는 아닙니다.</div>
    </div>
  </div>

  <div class="info-box">
    <p><strong>이 보드는 매일 보는 QVA 운영 화면입니다.</strong> 과거 데이터를 검증하는 백테스트 보고서가 아니라, 오늘 시점에서 <strong>어떤 종목이 funnel의 어느 단계에 와 있는지</strong> 보여주는 운영용 추적 보드입니다.</p>
    <p>매일 평일 16:35 자동 갱신됩니다 (KST). 매수 추천이 아니라 관심 후보 추적/모니터링용입니다.</p>
    <p style="border-top:1px solid #334155;padding-top:6px;margin-top:6px;">
      📅 <strong>현재 보드는 최신 거래일 기준으로 생성됩니다.</strong> 오늘이 휴장일이면 마지막 거래일 데이터를 기준으로 표시됩니다.
    </p>
    <p id="trading-date-meta" style="font-family:monospace;font-size:12px;color:#94a3b8;"></p>
  </div>

  <details id="backtest-reports-details" style="margin-bottom:16px;">
    <summary style="cursor:pointer;padding:10px 14px;background:#1e293b;border-radius:8px;border-left:3px solid #94a3b8;color:#cbd5e1;font-size:13px;font-weight:600;list-style:none;display:flex;align-items:center;gap:8px;">
      <span>📑 백테스팅 보고서 보기/숨기기</span>
      <span style="color:#94a3b8;font-size:11px;font-weight:400;margin-left:auto;">5개 보고서 (모델 검증/분석용)</span>
    </summary>
    <div style="background:#1e293b;border-radius:8px;padding:14px 16px;margin-top:8px;border-left:3px solid #94a3b8;">
    <p style="font-size:12px;color:#94a3b8;margin:0 0 10px 0;line-height:1.6;">
      QVA → VVI → 돌파 성공 funnel의 각 단계가 과거 데이터에서 어떤 흐름을 보였는지 검증한 1년치 백테스팅 보고서들입니다.
      매수 추천이 아니라 모델 검증/분석 목적입니다.
    </p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px;">

      <a href="/qva-surge-day-report" style="display:block;background:#0f172a;padding:10px 14px;border-radius:6px;border:1px solid #334155;text-decoration:none;color:#cbd5e1;transition:border 0.15s;" onmouseover="this.style.borderColor='#60a5fa'" onmouseout="this.style.borderColor='#334155'">
        <div style="color:#fbbf24;font-size:13px;font-weight:700;">📈 QVA 단일일 급등 분석</div>
        <div style="font-size:11px;margin-top:4px;color:#94a3b8;line-height:1.5;">QVA 신호 후 20거래일 안에 +10/+15/+20/+30% 단일일 급등이 얼마나 자주 발생했는지 분석.</div>
        <div style="font-size:10px;margin-top:5px;color:#64748b;font-family:monospace;">/qva-surge</div>
      </a>

      <a href="/qva-to-vvi-report" style="display:block;background:#0f172a;padding:10px 14px;border-radius:6px;border:1px solid #334155;text-decoration:none;color:#cbd5e1;transition:border 0.15s;" onmouseover="this.style.borderColor='#60a5fa'" onmouseout="this.style.borderColor='#334155'">
        <div style="color:#93c5fd;font-size:13px;font-weight:700;">🔄 QVA → VVI 전환 검증</div>
        <div style="font-size:11px;margin-top:4px;color:#94a3b8;line-height:1.5;">QVA 신호 이후 20거래일 안에 VVI(거래대금 초동 확인)로 전환된 종목의 성과 검증.</div>
        <div style="font-size:10px;margin-top:5px;color:#64748b;font-family:monospace;">/qva-to-vvi</div>
      </a>

      <a href="/qva-vvi-breakout-entry-report" style="display:block;background:#0f172a;padding:10px 14px;border-radius:6px;border:1px solid #334155;text-decoration:none;color:#cbd5e1;transition:border 0.15s;" onmouseover="this.style.borderColor='#60a5fa'" onmouseout="this.style.borderColor='#334155'">
        <div style="color:#a5b4fc;font-size:13px;font-weight:700;">🚀 돌파 진입 검증 + 손절 시나리오</div>
        <div style="font-size:11px;margin-top:4px;color:#94a3b8;line-height:1.5;">QVA → VVI → 다음 거래일 +1% 돌파 진입 후 성과와 손절 시나리오 (A~E) 비교.</div>
        <div style="font-size:10px;margin-top:5px;color:#64748b;font-family:monospace;">/qva-vvi-breakout-entry</div>
      </a>

      <a href="/qva-vvi-breakout-exit-report" style="display:block;background:#0f172a;padding:10px 14px;border-radius:6px;border:1px solid #334155;text-decoration:none;color:#cbd5e1;transition:border 0.15s;" onmouseover="this.style.borderColor='#60a5fa'" onmouseout="this.style.borderColor='#334155'">
        <div style="color:#f9a8d4;font-size:13px;font-weight:700;">💰 익절/청산 시나리오 비교</div>
        <div style="font-size:11px;margin-top:4px;color:#94a3b8;line-height:1.5;">돌파 성공(H그룹) 진입 후 14개 익절/청산 규칙(TP/Trail/Stop) 조합의 성과 비교.</div>
        <div style="font-size:10px;margin-top:5px;color:#64748b;font-family:monospace;">/qva-vvi-breakout-exit</div>
      </a>

      <a href="/early-qva-backtest" style="display:block;background:#0f172a;padding:10px 14px;border-radius:6px;border:1px solid #334155;text-decoration:none;color:#cbd5e1;transition:border 0.15s;" onmouseover="this.style.borderColor='#34d399'" onmouseout="this.style.borderColor='#334155'">
        <div style="color:#34d399;font-size:13px;font-weight:700;">🌱 Early QVA 백테스트</div>
        <div style="font-size:11px;margin-top:4px;color:#94a3b8;line-height:1.5;">Early QVA가 기존 Confirmed QVA보다 평균 며칠 먼저 잡히는지, 그리고 품질이 너무 떨어지지 않는지 검증합니다.</div>
        <div style="font-size:10px;margin-top:5px;color:#64748b;font-family:monospace;">/early-qva-backtest</div>
      </a>

      <a href="/qva-review-ok-backtest-report" style="display:block;background:#0f172a;padding:10px 14px;border-radius:6px;border:1px solid #10b981;text-decoration:none;color:#cbd5e1;transition:border 0.15s;grid-column:1/-1;" onmouseover="this.style.borderColor='#34d399'" onmouseout="this.style.borderColor='#10b981'">
        <div style="color:#6ee7b7;font-size:13px;font-weight:700;">⭐ 3단계 코호트 비교 (요약본)</div>
        <div style="font-size:11px;margin-top:4px;color:#94a3b8;line-height:1.5;">QVA 단독 / H그룹 / 진입가 근처 — 세 코호트의 같은 기간 20일 뒤 플러스 마감 비율 비교.<br>QVA 단독 56.2% → H그룹 71.0% → 진입가 근처 71.4%로 funnel 단계가 진행될수록 좋은 흐름을 보인 비율이 높아짐을 정량 확인.</div>
        <div style="font-size:10px;margin-top:5px;color:#64748b;font-family:monospace;">/qva-review-ok</div>
      </a>

    </div>
    </div>
  </details>


  <div class="help-wrap">
    <button class="help-btn open" id="help-btn">
      <span>📖 QVA / VVI / H그룹 설명 닫기</span>
      <span class="arrow">▼</span>
    </button>
    <div class="help-content" id="help-content">

      <div class="help-section">
        <h3>📖 용어를 쉽게 말하면</h3>
        <ul style="list-style:none;padding-left:0;">
          <li style="margin-bottom:10px;"><strong style="color:#34d399;">🌱 초기 QVA</strong> — 아직 크게 오르기 전, 거래대금이 조용히 붙기 시작한 관심 후보입니다.</li>
          <li style="margin-bottom:10px;"><strong style="color:#3b82f6;">⏳ VVI</strong> — 초기 QVA 후보 중 실제로 거래대금이 강하게 붙은 상태입니다.</li>
          <li style="margin-bottom:10px;"><strong style="color:#10b981;">🔥 돌파 성공</strong> — VVI 이후 가격이 한 번 더 올라가고 종가도 버틴 상태입니다. 백테스트에서는 H그룹이라고 부릅니다.</li>
          <li style="margin-bottom:10px;"><strong style="color:#93c5fd;">진입가 근처</strong> — 기준 가격에서 너무 멀리 오르지 않은 상태입니다. '매수해도 된다'는 뜻이 아니라, 추격 매수 위험을 줄이기 위한 위치 확인입니다.</li>
          <li style="margin-bottom:10px;"><span class="badge tag-CONFIRMED_QVA_PASS" style="font-size:10px;padding:1px 6px;border-radius:3px;">확인 QVA 통과</span> — 초기 QVA 이후 가격 유지, 저점 상승, 거래대금 흐름이 한 번 더 확인된 경우 붙는 보조 태그입니다. 메인 단계는 아니고 참고용입니다.</li>
        </ul>
        <div style="background:#fef3c7;border-left:3px solid #f59e0b;padding:8px 12px;border-radius:6px;margin-top:8px;font-size:11px;line-height:1.7;color:#78350f;">
          💡 <strong>초기 QVA와 VVI의 경계</strong> — Early QVA는 거래대금이 조용히 붙기 시작한 관심 후보입니다.
          거래대금이 이미 크게 터진 날은 Early QVA보다 VVI 단계에 더 가깝습니다.
          따라서 일부 종목은 사람이 보기에 바닥 반등 시작처럼 보여도, 거래대금이 이미 과도하게 터진 경우 Early QVA가 아니라 VVI 후보로 분류될 수 있습니다.
        </div>
      </div>

      <div class="help-section">
        <h3>단계 흐름</h3>
        <div class="funnel">
          <span class="step" style="background:#064e3b;color:#34d399;">🌱 초기 QVA</span>
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
subtitleEl.innerHTML =
  '기준 거래일: <strong>' + baseDate + '</strong>' +
  ' · 다음 거래일: <strong>' + nextDate + '</strong>' +
  '<br><span style="color:#94a3b8;font-size:11px;">' +
  (closed ? '오늘은 휴장일이라 ' : '') +
  '마지막 거래일 기준으로 표시됩니다.' +
  ' · 갱신: ' + DATA.meta.generatedAt.slice(0, 16).replace('T', ' ') +
  ' · <a href="#" id="dev-info-toggle" style="color:#64748b;text-decoration:underline;font-size:11px;">개발자 정보 보기 ▾</a>' +
  '</span>' +
  '<div id="dev-info-detail" style="display:none;margin-top:8px;padding:8px 12px;background:#1e293b;border-radius:6px;border:1px solid #334155;font-family:monospace;font-size:11px;color:#94a3b8;">' +
    'latestTradingDate=' + DATA.meta.latestTradingDate +
    ' · todayCalendarDate=' + DATA.meta.todayCalendarDate +
    ' · nextTradingDate=' + DATA.meta.nextTradingDate +
    ' · isMarketClosedToday=' + DATA.meta.isMarketClosedToday +
    ' · tradingDateCount=' + DATA.meta.tradingDateCount +
    ' · recentVviCount=' + DATA.meta.recentVviCount +
    ' · trackingDays=' + DATA.meta.trackingDays +
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
  for (const t of (c.auxTags || [])) {
    b += '<span class="badge tag-' + t + '" title="' + (TAG_DESCS[t] || '') + '">' + (TAG_LABELS[t] || t) + '</span>';
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
    { key: 'name', label: '종목', txt: true, render: c => '<a href="/?query=' + c.code + '&from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 상세 페이지 열기 (AI 뉴스 분석 포함, 첫 조회 10~30초 소요)"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
    { key: 'breakoutDate', label: '돌파일', txt: true, render: c => fmtDate(c.breakoutDate) + ' <span class="muted">D+' + (c.daysFromBreakout ?? 0) + '</span>' },
    { key: 'breakoutEntryPrice1Pct', label: '기준 진입가', render: c => fmtNum(c.breakoutEntryPrice1Pct) + '원' },
    { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
    { key: 'currentReturnFromEntry', label: '진입가 대비%', render: c => fmtPct(c.currentReturnFromEntry, true) },
    { key: 'qvaSignalPrice', label: 'QVA 신호가', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
    { key: 'qvaSignalDate', label: 'QVA일', txt: true, render: c => fmtDate(c.qvaSignalDate) + ' <span class="muted">D+' + c.daysSinceQva + '</span>' },
    { key: 'vviDate', label: 'VVI일', txt: true, render: c => fmtDate(c.vviDate) },
  ],
  VVI_FIRED: [
    { key: 'qvaSignalDate', label: 'QVA일', txt: true, render: c => fmtDate(c.qvaSignalDate) + ' <span class="muted">D+' + c.daysSinceQva + '</span>' },
    { key: 'vviDate', label: 'VVI일', txt: true, render: c => fmtDate(c.vviDate) },
    { key: 'name', label: '종목', txt: true, render: c => '<a href="/?query=' + c.code + '&from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 상세 페이지 열기 (AI 뉴스 분석 포함, 첫 조회 10~30초 소요)"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
    { key: 'qvaSignalPrice', label: 'QVA 신호가', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'vviHigh', label: 'VVI 고가', render: c => fmtNum(c.vviHigh) + '원' },
    { key: 'vviClose', label: 'VVI 종가', render: c => fmtNum(c.vviClose) + '원' },
    { key: 'breakoutEntryPrice1Pct', label: '내일 진입가 (×1.01)<span class="help" title="vviHigh × 1.01">ⓘ</span>', render: c => fmtNum(c.vviHigh * 1.01) + '원' },
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
      return '<a href="/?query=' + c.code + '&from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 상세 페이지 열기 (AI 뉴스 분석 포함, 첫 조회 10~30초 소요)"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + risk + badges(c);
    }},
    { key: 'qvaSignalPrice', label: 'QVA 신호가', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
    { key: 'currentValue', label: '현재 거래대금', render: c => fmtValue(c.currentValue) },
    { key: 'auxTagsCount', label: '보조태그', render: c => (c.auxTags?.length || 0) + '/3' },
  ],
  QVA_NEW: [
    { key: 'name', label: '종목', txt: true, render: c => '<a href="/?query=' + c.code + '&from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 상세 페이지 열기 (AI 뉴스 분석 포함, 첫 조회 10~30초 소요)"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
    { key: 'qvaSignalPrice', label: '신호가 (= 종가)', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'qvaSignalTradingValue', label: '거래대금', render: c => fmtValue(c.qvaSignalTradingValue) },
    { key: 'marketValue', label: '시총', render: c => fmtValue(c.marketValue) },
    { key: 'market', label: '시장', txt: true, render: c => c.market },
  ],
  FAILED: [
    { key: 'qvaSignalDate', label: 'QVA일', txt: true, render: c => fmtDate(c.qvaSignalDate) + ' <span class="muted">D+' + c.daysSinceQva + '</span>' },
    { key: 'name', label: '종목', txt: true, render: c => '<a href="/?query=' + c.code + '&from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 상세 페이지 열기 (AI 뉴스 분석 포함, 첫 조회 10~30초 소요)"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
    { key: 'qvaSignalPrice', label: '신호가', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
    { key: 'stageReason', label: '사유', txt: true, render: c => '<span class="muted">' + (c.stageReason || '-') + '</span>' },
  ],
  EARLY_QVA: [
    { key: 'bestEarlyQvaScore', label: '점수', render: c => '<strong style="color:#6ee7b7;">' + (c.bestEarlyQvaScore ?? 0) + '</strong>' },
    { key: 'bestEarlyQvaGradeLabel', label: '등급', txt: true, render: c => {
      const g = c.bestEarlyQvaGrade;
      const colors = { STRONG_EARLY_QVA: '#10b981', EARLY_QVA: '#34d399', WATCH_EARLY: '#94a3b8' };
      return '<span style="color:' + (colors[g] || '#94a3b8') + ';font-weight:600;">' + (c.bestEarlyQvaGradeLabel || '-') + '</span>';
    }},
    { key: 'firstEarlyQvaDate', label: '최초 감지일', txt: true, render: c => fmtDate(c.firstEarlyQvaDate) + ' <span class="muted">D+' + (c.daysSinceFirst ?? 0) + '</span>' },
    { key: 'bestEarlyQvaDate', label: '최고 점수일', txt: true, render: c => fmtDate(c.bestEarlyQvaDate) + ' <span class="muted">D+' + (c.daysSinceBest ?? 0) + '</span>' },
    { key: 'name', label: '종목', txt: true, render: c => '<a href="/?query=' + c.code + '&from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 상세 페이지 열기 (AI 뉴스 분석 포함, 첫 조회 10~30초 소요)"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + badges(c) },
    { key: 'anchorPrice', label: '신호가', render: c => fmtNum(c.anchorPrice) + '원' },
    { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
    { key: 'earlyQvaSignalCount', label: '신호일수', render: c => (c.earlyQvaSignalCount || 0) + '회' },
    { key: 'marketValue', label: '시총', render: c => fmtValue(c.marketValue) },
  ],
};

const stagesWrap = document.getElementById('stages-wrap');
const stageContent = {};

function buildStageSection(stage) {
  const items = DATA.stages[stage] || [];
  const cols = COLS_BY_STAGE[stage] || [];
  // 모든 섹션 기본 펼침으로 통일 (사용자 요청: "나머지 목록들은 다 펼침으로 가고 싶다 일관되게")
  const collapsed = false;
  const sec = document.createElement('div');
  sec.className = 'stage-section' + (collapsed ? ' collapsed' : '') + (stage === 'QVA_TRACKING' ? ' q-tracking' : '') + (stage === 'EARLY_QVA' ? ' early-qva' : '');
  sec.dataset.stage = stage;

  // 토글 라벨 — QVA_TRACKING / EARLY_QVA는 별도 문구
  let toggleCollapsedText = '▼ 펼치기';
  let toggleExpandedText = '▲ 접기';
  let toggleClass = 'toggle';
  if (stage === 'QVA_TRACKING') {
    toggleCollapsedText = 'QVA 추적 후보 전체 보기';
    toggleExpandedText = 'QVA 추적 후보 접기';
    toggleClass = 'toggle toggle-large';
  } else if (stage === 'EARLY_QVA') {
    toggleCollapsedText = '🌱 초기 QVA 후보 보기';
    toggleExpandedText = '🌱 초기 QVA 후보 접기';
    toggleClass = 'toggle toggle-large';
  }

  const title = document.createElement('h2');
  title.className = 'h-section';
  const stageColor = { BREAKOUT_SUCCESS: '🔥', VVI_FIRED: '⏳', QVA_TRACKING: '👀', QVA_NEW: '🆕', EARLY_QVA: '🌱', FAILED: '❌' }[stage] || '';
  // EARLY_QVA: 전체/화면표시/강한 카운트를 같이 보여줌
  let pillContent;
  if (stage === 'EARLY_QVA') {
    const eq = DATA.earlyQvaSummary || {};
    pillContent = '<span class="pill">전체 ' + (eq.totalCount ?? 0) + '건</span>' +
                  '<span class="pill" style="background:#34d399;color:#064e3b;">화면 ' + (eq.displayedCount ?? 0) + '건</span>' +
                  '<span class="pill" style="background:#10b981;color:#fff;">강한 ' + (eq.strongCount ?? 0) + '건</span>';
  } else {
    pillContent = '<span class="pill">' + items.length + '건</span>';
  }
  title.innerHTML = '<span>' + stageColor + ' ' + DATA.meta.stageLabels[stage] + '</span>' +
    pillContent +
    '<span class="desc">' + DATA.meta.stageDescriptions[stage] + '</span>' +
    '<span class="' + toggleClass + '" data-stage="' + stage + '"' +
    ' data-collapsed-text="' + toggleCollapsedText + '"' +
    ' data-expanded-text="' + toggleExpandedText + '">' +
    (collapsed ? toggleCollapsedText : toggleExpandedText) + '</span>';
  sec.appendChild(title);

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

  // ─── EARLY_QVA: 요약 카드 (접힘 상태에서도 표시) ───
  if (stage === 'EARLY_QVA') {
    const eq = DATA.earlyQvaSummary || { totalCount: 0, strongCount: 0, earlyCount: 0, watchCount: 0, displayedCount: 0, displayThreshold: 70, displayLimit: 50, avgScore: 0, valueReactivationCount: 0, higherLowCount: 0, priceHoldCount: 0 };
    const summaryEl = document.createElement('div');
    summaryEl.className = 'tracking-summary';
    summaryEl.innerHTML =
      '<div class="card"><div class="lbl">전체 초기 QVA 후보</div><div class="cnt">' + eq.totalCount + '</div></div>' +
      '<div class="card strong"><div class="lbl">강한 초기 QVA (' + 80 + '+)</div><div class="cnt">' + eq.strongCount + '</div></div>' +
      '<div class="card"><div class="lbl">화면 표시 (' + eq.displayThreshold + '+, 최대 ' + eq.displayLimit + ')</div><div class="cnt">' + eq.displayedCount + '</div></div>' +
      '<div class="card"><div class="lbl">평균 점수</div><div class="cnt">' + eq.avgScore + '</div></div>' +
      '<div class="card"><div class="lbl">거래대금 재활성 동반</div><div class="cnt">' + eq.valueReactivationCount + '</div></div>' +
      '<div class="card"><div class="lbl">저점 상승 동반</div><div class="cnt">' + eq.higherLowCount + '</div></div>' +
      '<div class="card"><div class="lbl">가격 유지 동반</div><div class="cnt">' + eq.priceHoldCount + '</div></div>';
    sec.appendChild(summaryEl);

    // Early QVA 안내문
    const noteEl = document.createElement('div');
    noteEl.style.cssText = 'background:#0f172a;border-left:3px solid #34d399;padding:10px 14px;border-radius:6px;margin-bottom:12px;color:#cbd5e1;font-size:12px;line-height:1.6;';
    noteEl.innerHTML =
      '초기 QVA는 기존 QVA보다 더 빠르게 수급 흔적을 잡기 위한 감시 후보입니다. ' +
      '아직 크게 오르기 전, 거래대금이 조용히 살아나고 저점이 안정되는 종목을 찾습니다. ' +
      '<strong style="color:#fbbf24;">기존 QVA보다 빠른 대신 실패 가능성도 높기 때문에, 화면에는 점수가 높은 후보 위주로 표시합니다.</strong>';
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
      emptyMsg = '최신 거래일 기준 새 VVI 발생 종목이 없어 다음 거래일 돌파 판정 대기 후보가 없습니다. ' +
        '최근 5거래일 내 VVI 발생 종목은 별도 카운터로 표시되며, 이미 판정이 끝난 종목은 돌파 성공 또는 실패/이탈로 분류됩니다.';
      if (DATA.meta.isMarketClosedToday) {
        emptyMsg += ' (오늘 ' + fmtDate(DATA.meta.todayCalendarDate) + '은 휴장/주말이라 ' + fmtDate(DATA.meta.latestTradingDate) + ' 데이터 기준입니다.)';
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

  // ─── 섹션 하단 주의 문구 ───
  if (stage === 'BREAKOUT_SUCCESS' && items.length > 0) {
    const footer = document.createElement('div');
    footer.className = 'section-footer';
    footer.innerHTML =
      '⚠️ 돌파 성공은 <strong>조건 통과</strong>를 의미하며, <strong>현재가에서의 신규 진입 적합성</strong>을 의미하지 않습니다.<br>' +
      '현재가가 기준 진입가에서 많이 멀어진 경우에는 <strong>추격보다 눌림 확인</strong>이 필요합니다.';
    sec.appendChild(footer);
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
    '<span>🎯 최근 VVI 발생 이력</span>' +
    '<span class="pill">' + items.length + '건</span>' +
    '<span class="desc">최근 5거래일 안에 VVI가 발생한 종목과 이후 돌파 판정 결과를 보여주는 참고 영역입니다.</span>' +
    '<span class="toggle" data-stage="RECENT_VVI_HISTORY">▲ 접기</span>';
  sec.appendChild(title);

  // 상단 요약 바
  const summary = document.createElement('div');
  summary.style.cssText = 'display:flex;gap:14px;margin-bottom:10px;font-size:13px;color:#cbd5e1;flex-wrap:wrap;padding:8px 12px;background:#0f172a;border-radius:6px;border:1px solid #334155;';
  summary.innerHTML =
    '<span>최근 5거래일 VVI 발생 총 <strong style="color:#f1f5f9;">' + sm.total + '</strong>건</span>' +
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
    wrap.innerHTML = '<div class="empty">최근 5거래일 내 VVI 발생 종목이 없습니다.</div>';
  } else {
    const outcomeRender = (o) => {
      if (o === 'SUCCESS') return '<span style="color:#10b981;font-weight:600;">돌파 성공</span>';
      if (o === 'FAIL') return '<span style="color:#f87171;font-weight:600;">돌파 실패</span>';
      return '<span style="color:#fbbf24;font-weight:600;">판정 대기</span>';
    };
    const cols = [
      { label: 'VVI일', txt: true, render: c => fmtDate(c.vviDate) },
      { label: '종목', txt: true, render: c => '<a href="/?query=' + c.code + '&from=qva-watchlist" target="_blank" rel="noopener" class="stock-link" title="새 창에서 상세 페이지 열기 (AI 뉴스 분석 포함, 첫 조회 10~30초 소요)"><span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span></a>' + (c.isPreferred ? '<span class="badge pref">우</span>' : '') },
      { label: 'VVI 고가', render: c => fmtNum(c.vviHigh) + '원' },
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
  footer.innerHTML = '⚠️ 이 섹션은 <strong>매수 추천이 아니라</strong> VVI 발생 이력과 돌파 판정 흐름을 보여주는 <strong>참고 정보</strong>입니다.';
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
      ? '📖 QVA / VVI / H그룹 설명 보기'
      : '📖 QVA / VVI / H그룹 설명 닫기';
  });
}

// ─── 전체 종목 검색 — 모든 stage-section 테이블 행 필터링 ───
const globalSearch = document.getElementById('global-search');
const globalSearchStatus = document.getElementById('global-search-status');
const globalSearchClear = document.getElementById('global-search-clear');
if (globalSearch) {
  function applyGlobalSearch() {
    const q = (globalSearch.value || '').trim().toLowerCase();
    let totalRows = 0, matchRows = 0;
    const matchByStage = {};
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
        // 데이터 attr 없는 경우 textContent로 fallback
        const text = (name || code) ? '' : (tr.textContent || '').toLowerCase();
        const match = name.includes(q) || code.includes(q) || text.includes(q);
        tr.style.display = match ? '' : 'none';
        if (match) secMatch++;
      });
      totalRows += secTotal;
      matchRows += secMatch;
      matchByStage[stage] = { total: secTotal, match: secMatch };
      // 섹션 타이틀에 매칭 카운트 갱신 (일시적)
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
