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

  // ─── 가장 최근 QVA 신호 (today 포함, 최대 D+20 이전까지) ───
  let qvaIdx = null;
  for (let k = 0; k <= TRACKING_DAYS && todayIdx - k >= 60; k++) {
    if (checkQVASignalAtIdx(rows, todayIdx - k)) {
      qvaIdx = todayIdx - k;
      break;
    }
  }
  if (qvaIdx == null) continue;

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
  });
}

console.log(`\n→ 전체 후보: ${candidates.length}건 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// ─────────── 단계별 그룹핑 ───────────
const stageOrder = ['BREAKOUT_SUCCESS', 'VVI_FIRED', 'QVA_TRACKING', 'QVA_NEW', 'FAILED'];
const stageLabels = {
  BREAKOUT_SUCCESS: '돌파 성공 확인 종목',
  VVI_FIRED: '다음 거래일 돌파 대기',
  QVA_TRACKING: 'QVA 추적 중',
  QVA_NEW: 'QVA 신규',
  FAILED: '실패/이탈',
};
const stageDescriptions = {
  BREAKOUT_SUCCESS:
    'VVI 다음 거래일에 vviHigh × 1.01을 돌파하고, 종가가 vviHigh 이상에서 마감한 후보입니다. 백테스트의 H그룹과 같은 의미입니다.',
  VVI_FIRED:
    '최신 거래일에 VVI가 발생해 아직 다음 거래일 돌파 성공/실패 판정이 끝나지 않은 후보입니다.',
  QVA_TRACKING:
    'QVA 발생 후 20거래일 동안 VVI 발생 여부를 지켜보는 후보입니다. 가격 유지, 저점 상승, 거래대금 재활성 같은 보조 태그로 흐름을 판단합니다.',
  QVA_NEW:
    '오늘 새로 QVA 신호가 발생한 종목입니다. 감시를 시작하는 단계입니다.',
  FAILED:
    'QVA 이후 가격이 크게 무너졌거나, 20거래일 안에 VVI가 발생하지 않았거나, 돌파에 실패한 종목입니다.',
};

const auxTagLabels = {
  PRICE_HOLD: '가격 유지',
  LOW_RISING: '저점 상승',
  VALUE_REACTIVATION: '거래대금 재활성',
};
const auxTagDescriptions = {
  PRICE_HOLD: '현재 종가가 QVA 신호가의 95% 이상',
  LOW_RISING: '최근 5거래일 저가 최소값 > 그 이전 5거래일 저가 최소값',
  VALUE_REACTIVATION: '최근 3거래일 평균 거래대금이 신호 직전 20일 평균의 1.5배 이상',
};

// 진입 판단 상태 — BREAKOUT_SUCCESS 그룹 내 분류
const judgmentOrder = ['REVIEW_OK', 'CHASE_CAUTION', 'PULLBACK_WAIT', 'MANAGEMENT', 'BREAKDOWN_WEAK'];
const judgmentLabels = {
  REVIEW_OK: '검토 가능',
  CHASE_CAUTION: '추격 주의',
  PULLBACK_WAIT: '눌림 대기',
  MANAGEMENT: '관리 구간',
  BREAKDOWN_WEAK: '돌파 약화',
};
const judgmentDescriptions = {
  REVIEW_OK: '돌파 후 2일 이내 + 진입가 대비 +3% 이내 — 신규 진입 검토 가능 구간.',
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
for (const s of stageOrder) stageCounts[s] = byStage.get(s)?.length || 0;

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
      // 보조 태그 많은 순 → 신호가 대비 수익률 높은 순
      arr.sort((a, b) => {
        if (b.auxTags.length !== a.auxTags.length) return b.auxTags.length - a.auxTags.length;
        return (b.currentReturnFromSignal ?? -Infinity) - (a.currentReturnFromSignal ?? -Infinity);
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
for (const s of stageOrder) {
  stagedItems[s] = sortStage(s, byStage.get(s) || []);
}

// ─────────── 콘솔 출력 ───────────
console.log(`\n${'='.repeat(120)}`);
console.log(`📊 단계별 후보 수`);
for (const s of stageOrder) {
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
  stages: stagedItems,
  recentVviHistory: {
    items: recentVviHistoryItems,
    summary: recentVviHistorySummary,
    note: '이 섹션은 매수 추천이 아니라 VVI 발생 이력과 돌파 판정 흐름을 보여주는 참고 정보입니다.',
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
  .badge.pref { background: #4c1d1d; color: #fca5a5; }

  .stage-section { margin-bottom: 24px; }
  .stage-section.collapsed .table-wrap { display: none; }
  .stage-section .toggle { font-size: 11px; color: #60a5fa; cursor: pointer; margin-left: 8px; }

  .pos { color: #10b981; }
  .neg { color: #f87171; }
  .muted { color: #64748b; }
  .market-K { color: #60a5fa; }
  .market-Q { color: #c084fc; }

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
  </div>

  <div class="info-box">
    <p><strong>이 보드는 매일 보는 QVA 운영 화면입니다.</strong> 과거 데이터를 검증하는 백테스트 보고서가 아니라, 오늘 시점에서 <strong>어떤 종목이 funnel의 어느 단계에 와 있는지</strong> 보여주는 운영용 추적 보드입니다.</p>
    <p>QVA는 <strong>감시 시작</strong>, VVI는 <strong>거래대금 초동 확인</strong>, 다음날 vviHigh×1.01 돌파 + 종가 ≥ vviHigh는 <strong>진입 후보 검토 조건</strong>입니다.</p>
    <p>매일 평일 16:35 자동 갱신됩니다 (KST). 매수 추천이 아니라 후보 추적/모니터링용입니다.</p>
    <p style="border-top:1px solid #334155;padding-top:6px;margin-top:6px;">
      📅 <strong>현재 보드는 최신 거래일 기준으로 생성됩니다.</strong> 오늘이 휴장일이면 마지막 거래일 데이터를 기준으로 표시됩니다.
    </p>
    <p id="trading-date-meta" style="font-family:monospace;font-size:12px;color:#94a3b8;"></p>
  </div>

  <div class="help-wrap">
    <button class="help-btn" id="help-btn">
      <span>📖 QVA / VVI / H그룹 설명 보기</span>
      <span class="arrow">▼</span>
    </button>
    <div class="help-content collapsed" id="help-content">

      <div class="help-section">
        <h3>QVA / VVI 모델 설명</h3>
        <p>이 화면은 <strong>QVA 신호가 발생한 종목을 20거래일 동안 추적</strong>하면서, VVI 발생과 다음 거래일 돌파 성공 여부까지 확인하는 운영 보드입니다.</p>
        <p><strong>QVA</strong>는 매수 신호가 아니라 <strong>"누군가 들어오기 시작한 흔적"</strong>을 찾는 감시 시작 후보입니다. 거래량·거래대금 이상징후, 저점 상승, 아직 크게 움직이지 않은 가격 흐름을 기반으로 후보를 좁힙니다.</p>
        <p><strong>VVI</strong>는 QVA 후보 중 실제 거래대금 초동이 터진 <strong>수급 확인 후보</strong>입니다. 거래량/거래대금이 강하게 증가하고, 종가가 양호하게 마감한 종목을 확인합니다.</p>
        <p><strong>돌파 성공 확인 종목</strong>은 VVI 다음 거래일에 vviHigh × 1.01을 돌파하고, 종가가 vviHigh 이상에서 마감한 종목입니다.</p>
        <p>백테스트 보고서에서 말한 <strong>H그룹</strong>은 이 화면의 <strong>'돌파 성공 확인 종목'과 같은 의미</strong>입니다.</p>
      </div>

      <div class="help-section">
        <h3>단계 흐름</h3>
        <div class="funnel">
          <span class="step">QVA 신규</span>
          <span class="arrow-r">→</span>
          <span class="step">QVA 추적 중</span>
          <span class="arrow-r">→</span>
          <span class="step">VVI 발생</span>
          <span class="arrow-r">→</span>
          <span class="step">다음 거래일 돌파 대기</span>
          <span class="arrow-r">→</span>
          <span class="step h-group">돌파 성공 확인 종목 = H그룹</span>
          <span class="arrow-r">→</span>
          <span class="step">익절/청산 시나리오 검토</span>
        </div>
        <ul>
          <li><strong>QVA 신규</strong> — 오늘 새로 감시를 시작한 종목</li>
          <li><strong>QVA 추적 중</strong> — QVA 발생 후 20거래일 동안 VVI 발생 여부를 지켜보는 종목</li>
          <li><strong>VVI 발생</strong> — 실제 거래대금 초동이 확인된 종목</li>
          <li><strong>다음 거래일 돌파 대기</strong> — VVI 다음 거래일에 vviHigh × 1.01 돌파 여부를 기다리는 종목</li>
          <li><strong>돌파 성공 확인 종목</strong> — vviHigh × 1.01 돌파 + 종가가 vviHigh 이상 마감한 종목</li>
          <li><strong>H그룹</strong> — 백테스트에서 검증한 돌파 성공 확인 종목 그룹</li>
        </ul>
      </div>

      <div class="help-section">
        <h3>H그룹이란?</h3>
        <div class="h-group-card">
          <p><strong>H그룹은 백테스트에서 가장 강하게 검증된 최종 확인 그룹입니다.</strong></p>
          <p>조건은 다음과 같습니다.</p>
          <ol>
            <li>QVA 발생</li>
            <li>QVA 이후 20거래일 안에 VVI 발생</li>
            <li>VVI 다음 거래일에 vviHigh × 1.01 이상 돌파</li>
            <li>그날 종가가 vviHigh 이상에서 마감</li>
          </ol>
          <p>즉, H그룹은 <strong>QVA 감시 → VVI 수급 확인 → 다음날 돌파 → 종가 유지</strong>까지 확인된 종목입니다. 이 화면에서는 H그룹을 <strong>'돌파 성공 확인 종목'</strong>으로 표시합니다.</p>
          <div class="warn">⚠️ 단, H그룹은 매수 추천이 아닙니다. 현재가가 기준 진입가에서 많이 멀어진 경우에는 신규 진입보다 <strong>눌림 대기 또는 추적 관점</strong>으로 봐야 합니다.</div>
        </div>
      </div>

    </div>
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

document.getElementById('subtitle').textContent =
  'latestTradingDate: ' + fmtDate(DATA.meta.latestTradingDate) +
  ' · todayCalendarDate: ' + fmtDate(DATA.meta.todayCalendarDate) +
  (DATA.meta.isMarketClosedToday ? ' (휴장/주말)' : ' (거래일)') +
  ' · nextTradingDate: ' + fmtDate(DATA.meta.nextTradingDate) +
  ' · 갱신: ' + DATA.meta.generatedAt.slice(0, 19).replace('T', ' ');

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
    { key: 'name', label: '종목', txt: true, render: c => '<span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span>' + badges(c) },
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
    { key: 'name', label: '종목', txt: true, render: c => '<span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span>' + badges(c) },
    { key: 'qvaSignalPrice', label: 'QVA 신호가', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'vviHigh', label: 'VVI 고가', render: c => fmtNum(c.vviHigh) + '원' },
    { key: 'vviClose', label: 'VVI 종가', render: c => fmtNum(c.vviClose) + '원' },
    { key: 'breakoutEntryPrice1Pct', label: '내일 진입가 (×1.01)<span class="help" title="vviHigh × 1.01">ⓘ</span>', render: c => fmtNum(c.vviHigh * 1.01) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
  ],
  QVA_TRACKING: [
    { key: 'qvaSignalDate', label: 'QVA일', txt: true, render: c => fmtDate(c.qvaSignalDate) },
    { key: 'daysSinceQva', label: 'D+', render: c => 'D+' + c.daysSinceQva },
    { key: 'name', label: '종목', txt: true, render: c => '<span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span>' + badges(c) },
    { key: 'qvaSignalPrice', label: 'QVA 신호가', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
    { key: 'currentValue', label: '현재 거래대금', render: c => fmtValue(c.currentValue) },
    { key: 'auxTagsCount', label: '보조태그', render: c => (c.auxTags?.length || 0) + '/3' },
  ],
  QVA_NEW: [
    { key: 'name', label: '종목', txt: true, render: c => '<span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span>' + badges(c) },
    { key: 'qvaSignalPrice', label: '신호가 (= 종가)', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'qvaSignalTradingValue', label: '거래대금', render: c => fmtValue(c.qvaSignalTradingValue) },
    { key: 'marketValue', label: '시총', render: c => fmtValue(c.marketValue) },
    { key: 'market', label: '시장', txt: true, render: c => c.market },
  ],
  FAILED: [
    { key: 'qvaSignalDate', label: 'QVA일', txt: true, render: c => fmtDate(c.qvaSignalDate) + ' <span class="muted">D+' + c.daysSinceQva + '</span>' },
    { key: 'name', label: '종목', txt: true, render: c => '<span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span>' + badges(c) },
    { key: 'qvaSignalPrice', label: '신호가', render: c => fmtNum(c.qvaSignalPrice) + '원' },
    { key: 'currentClose', label: '현재가', render: c => fmtNum(c.currentClose) + '원' },
    { key: 'currentReturnFromSignal', label: '신호가 대비%', render: c => fmtPct(c.currentReturnFromSignal, true) },
    { key: 'stageReason', label: '사유', txt: true, render: c => '<span class="muted">' + (c.stageReason || '-') + '</span>' },
  ],
};

const stagesWrap = document.getElementById('stages-wrap');
const stageContent = {};

function buildStageSection(stage) {
  const items = DATA.stages[stage] || [];
  const cols = COLS_BY_STAGE[stage] || [];
  const collapsed = stage === 'FAILED';
  const sec = document.createElement('div');
  sec.className = 'stage-section' + (collapsed ? ' collapsed' : '');
  sec.dataset.stage = stage;

  const title = document.createElement('h2');
  title.className = 'h-section';
  const stageColor = { BREAKOUT_SUCCESS: '🔥', VVI_FIRED: '⏳', QVA_TRACKING: '👀', QVA_NEW: '🆕', FAILED: '❌' }[stage] || '';
  title.innerHTML = '<span>' + stageColor + ' ' + DATA.meta.stageLabels[stage] + '</span>' +
    '<span class="pill">' + items.length + '건</span>' +
    '<span class="desc">' + DATA.meta.stageDescriptions[stage] + '</span>' +
    '<span class="toggle" data-stage="' + stage + '">' + (collapsed ? '▼ 펼치기' : '▲ 접기') + '</span>';
  sec.appendChild(title);

  // QVA_TRACKING 그룹은 보조 태그 필터 추가
  if (stage === 'QVA_TRACKING') {
    const ctrls = document.createElement('div');
    ctrls.className = 'controls';
    ctrls.innerHTML =
      '<input type="text" class="search" placeholder="종목명 또는 코드 검색…" data-stage="' + stage + '">' +
      '<div class="tag-filter">' +
        Object.entries(TAG_LABELS).map(([t, lbl]) =>
          '<button data-tag="' + t + '" data-stage="' + stage + '">' + lbl + '</button>'
        ).join('') +
      '</div>';
    sec.appendChild(ctrls);
  } else if (stage !== 'QVA_NEW' && stage !== 'FAILED') {
    const ctrls = document.createElement('div');
    ctrls.className = 'controls';
    ctrls.innerHTML = '<input type="text" class="search" placeholder="종목명 또는 코드 검색…" data-stage="' + stage + '">';
    sec.appendChild(ctrls);
  }

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
        ' data-tags="' + (c.auxTags || []).join(',') + '"';
      return '<tr ' + dataAttrs + '>' + cols.map(col => {
        const cell = col.render(c);
        return '<td' + (col.txt ? ' class="txt"' : '') + '>' + cell + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody>';
    wrap.innerHTML = '<table>' + head + body + '</table>';
  }
  sec.appendChild(wrap);

  // BREAKOUT_SUCCESS 섹션 하단 주의 문구
  if (stage === 'BREAKOUT_SUCCESS' && items.length > 0) {
    const footer = document.createElement('div');
    footer.className = 'section-footer';
    footer.innerHTML =
      '⚠️ 돌파 성공은 <strong>조건 통과</strong>를 의미하며, <strong>현재가에서의 신규 진입 적합성</strong>을 의미하지 않습니다.<br>' +
      '현재가가 기준 진입가에서 많이 멀어진 경우에는 <strong>추격보다 눌림 확인</strong>이 필요합니다.';
    sec.appendChild(footer);
  }
  return sec;
}

for (const s of stageOrder) {
  stagesWrap.appendChild(buildStageSection(s));
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
      { label: '종목', txt: true, render: c => '<span class="' + marketCls(c.market) + '">' + (c.name || '') + '</span> <span class="muted">' + c.code + '</span>' + (c.isPreferred ? '<span class="badge pref">우</span>' : '') },
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

stagesWrap.appendChild(buildRecentVviHistorySection());

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

// 펼침/접기 토글
document.querySelectorAll('.toggle').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const stage = btn.dataset.stage;
    const sec = document.querySelector('.stage-section[data-stage="' + stage + '"]');
    if (sec) {
      sec.classList.toggle('collapsed');
      btn.textContent = sec.classList.contains('collapsed') ? '▼ 펼치기' : '▲ 접기';
    }
  });
});

// 검색 + 태그 + outcome 필터
function applyFiltersForStage(stage) {
  const sec = document.querySelector('.stage-section[data-stage="' + stage + '"]');
  if (!sec) return;
  const searchInput = sec.querySelector('input.search');
  const q = (searchInput?.value || '').trim().toLowerCase();
  const activeBtns = Array.from(sec.querySelectorAll('.tag-filter button.active'));
  const activeTags = activeBtns.filter(b => b.dataset.tag).map(b => b.dataset.tag);
  const activeOutcomes = activeBtns.filter(b => b.dataset.outcome).map(b => b.dataset.outcome);
  sec.querySelectorAll('tbody tr').forEach(tr => {
    const name = (tr.dataset.name || '').toLowerCase();
    const code = (tr.dataset.code || '').toLowerCase();
    const tags = (tr.dataset.tags || '').split(',');
    const outcome = tr.dataset.outcome || '';
    const matchQ = !q || name.includes(q) || code.includes(q);
    const matchT = activeTags.length === 0 || activeTags.every(t => tags.includes(t));
    const matchO = activeOutcomes.length === 0 || activeOutcomes.includes(outcome);
    tr.style.display = matchQ && matchT && matchO ? '' : 'none';
  });
}
document.querySelectorAll('input.search').forEach(input => {
  input.addEventListener('input', () => applyFiltersForStage(input.dataset.stage));
});
document.querySelectorAll('.tag-filter button').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('active');
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
