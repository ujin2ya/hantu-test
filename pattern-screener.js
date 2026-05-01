// 패턴 스크리너 — Mark Minervini SEPA / Stan Weinstein Stage 2 방식
//
// 입력: 종목별 일봉 데이터 (cache/stock-charts/<code>.json, 250일+)
// 핵심 알고리즘:
//   1. Trend Template — Stage 2 확인 (Minervini's 6 criteria 중 5개 + RS)
//   2. VCP detection — Volatility Contraction Pattern (박스권 + 변동폭 수축)
//   3. Breakout 시그널 — pivot 돌파 + 거래량 폭발
//
// 폐기된 옛 모델:
//   - +40% 이벤트 기반 signature matching (예측력 lift 1.09x = 노이즈)
//   - PREMIUM/FRESH/SUSPECT 라벨링 (검증 안 됨)

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const dart = require("./dart-fetcher");
const korea = require("./korea-filter");

const CACHE_DIR = path.join(__dirname, "cache", "stock-charts");
const LONG_CACHE_DIR = path.join(__dirname, "cache", "stock-charts-long");
const WEEKLY_CACHE_DIR = path.join(__dirname, "cache", "stock-charts-weekly");
const FLOW_CACHE_DIR = path.join(__dirname, "cache", "flow-history");
const KOSPI_CACHE = path.join(__dirname, "cache", "kospi-daily.json");
const KOSDAQ_CACHE = path.join(__dirname, "cache", "kosdaq-daily.json");
const PATTERN_RESULT_CACHE = path.join(__dirname, "cache", "pattern-result.json");
const H = { "User-Agent": "Mozilla/5.0" };

// ─────────── 헬퍼 ───────────
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sma(prices, period) {
  if (prices.length < period) return null;
  return avg(prices.slice(-period));
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// expectedMarketDate 계산 — 분석 기준일
// ANALYSIS_DATE 환경변수가 있으면 그걸 사용, 없으면 KST 현재시각으로 계산
function getExpectedMarketDate() {
  if (process.env.ANALYSIS_DATE) return process.env.ANALYSIS_DATE;

  const kstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const hours = kstNow.getHours();
  const minutes = kstNow.getMinutes();
  const dayOfWeek = kstNow.getDay(); // 0=일, 1=월, ..., 6=토

  // 주중 16:20 이전 또는 주말/공휴일 → 직전 거래일
  if (dayOfWeek === 0 || dayOfWeek === 6 || hours < 16 || (hours === 16 && minutes < 20)) {
    // 직전 거래일 계산 (간단: 1일 전, 주말 고려 필요)
    const yesterday = new Date(kstNow);
    yesterday.setDate(yesterday.getDate() - 1);

    // 토요일(6) → 금요일, 일요일(0) → 금요일
    while (yesterday.getDay() === 0 || yesterday.getDay() === 6) {
      yesterday.setDate(yesterday.getDate() - 1);
    }

    return yesterday.toISOString().split('T')[0].replace(/-/g, '');
  }

  // 16:20 이후 → 오늘 거래일
  return kstNow.toISOString().split('T')[0].replace(/-/g, '');
}

// 한국 공휴일 리스트 (간단 버전, 나중에 보강 가능)
const KR_HOLIDAYS = new Set([
  '20260101', // 신정
  '20260217', '20260218', '20260219', // 설
  '20260301', // 삼일절
  '20260405', // 국회의원 선거일
  '20260505', // 어린이날
  '20260515', // 스승의 날
  '20260606', // 지방선거일
  '20260815', // 광복절
  '20260917', '20260918', '20260919', // 추석
  '20261003', // 개천절
  '20261009', // 한글날
  '20261225', // 성탄절
]);

function isKrHoliday(dateStr) {
  return KR_HOLIDAYS.has(dateStr);
}

// ─────────── KOSPI ───────────
async function fetchKospiHistory(count = 250) {
  const url = `https://api.stock.naver.com/chart/domestic/index/KOSPI?periodType=dayCandle&count=${count}`;
  const r = await axios.get(url, { headers: H, timeout: 15000 });
  return (r.data.priceInfos || []).map((p) => ({
    date: String(p.localDate || ""),
    close: Number(p.closePrice) || 0,
  })).sort((a, b) => a.date.localeCompare(b.date));
}

async function getKospiCached() {
  try {
    const data = JSON.parse(fs.readFileSync(KOSPI_CACHE, "utf-8"));
    if (data && Date.now() - data.fetchedAt < 24 * 60 * 60 * 1000) return data.rows;
  } catch (_) {}
  const rows = await fetchKospiHistory(250);
  fs.writeFileSync(KOSPI_CACHE, JSON.stringify({ fetchedAt: Date.now(), rows }));
  return rows;
}

async function fetchKosdaqHistory(count = 250) {
  const url = `https://api.stock.naver.com/chart/domestic/index/KOSDAQ?periodType=dayCandle&count=${count}`;
  const r = await axios.get(url, { headers: H, timeout: 15000 });
  return (r.data.priceInfos || []).map((p) => ({
    date: String(p.localDate || ""),
    close: Number(p.closePrice) || 0,
  })).sort((a, b) => a.date.localeCompare(b.date));
}

async function getKosdaqCached() {
  try {
    const data = JSON.parse(fs.readFileSync(KOSDAQ_CACHE, "utf-8"));
    if (data && Date.now() - data.fetchedAt < 24 * 60 * 60 * 1000) return data.rows;
  } catch (_) {}
  const rows = await fetchKosdaqHistory(250);
  fs.writeFileSync(KOSDAQ_CACHE, JSON.stringify({ fetchedAt: Date.now(), rows }));
  return rows;
}

// 종목 market (KOSPI/KOSDAQ) 에 맞는 index rows 반환
function getIndexForMarket(meta, kospiRows, kosdaqRows) {
  const m = (meta?.market || "").toUpperCase();
  if (m.includes("KOSDAQ")) return kosdaqRows;
  return kospiRows;
}

// ─────────── Trend Template (Stage 2 확인) — 110일 적응형 ───────────
// Naver 일봉 API 110일 cap 한계로 50/100일선 사용 (Minervini 의 50/150/200 변형).
// 정확한 200일선 위해선 주봉 별도 seed 필요 (TODO).
function checkTrendTemplate(rows, idx) {
  if (!rows || idx < 100) return null;
  const closes = rows.slice(0, idx + 1).map((r) => r.close);
  const today = closes[idx];
  if (!(today > 0)) return null;

  const sma50 = sma(closes.slice(idx - 49, idx + 1), 50);
  const sma100 = sma(closes.slice(idx - 99, idx + 1), 100);
  if (!sma50 || !sma100) return null;

  // 100일선 우상향 — 20일 전 SMA80 대비 비교 (110일 cap 적응)
  const sma80_20daysAgo = idx >= 100 ? sma(closes.slice(idx - 99, idx - 19), 80) : null;
  const sma100Rising = sma80_20daysAgo != null && sma100 > sma80_20daysAgo;

  // 100일 고저 (52주 proxy)
  const yearStart = Math.max(0, idx - 99);
  const yearWindow = rows.slice(yearStart, idx + 1);
  const high100 = Math.max(...yearWindow.map((r) => r.high || 0));
  const lows = yearWindow.map((r) => r.low).filter((v) => v > 0);
  const low100 = lows.length ? Math.min(...lows) : null;

  const checks = {
    aboveAllMAs: today > sma50 && today > sma100,
    maStack: sma50 > sma100,
    sma100Rising,
    near100High: high100 > 0 && (today / high100) >= 0.75,
    above100Low: low100 && (today / low100) >= 1.20, // 100일 저점 기준 +20% (52주 기준 +30% 대신)
  };

  const passed = Object.values(checks).filter((v) => v).length;
  return {
    passed,
    total: 5,
    checks,
    today,
    sma50: Math.round(sma50),
    sma100: Math.round(sma100),
    high100,
    low100,
    pctFromHigh: high100 > 0 ? Number(((today / high100 - 1) * 100).toFixed(1)) : null,
    pctFromLow: low100 ? Number(((today / low100 - 1) * 100).toFixed(1)) : null,
  };
}

// ─────────── Relative Strength (vs 시장 인덱스) ───────────
// 60일 종목 수익률 vs 같은 기간 시장 인덱스 (KOSPI 또는 KOSDAQ) 수익률
function computeRS(rows, indexRows, idx, period = 60, marketLabel = "KOSPI") {
  if (!rows || !indexRows || idx < period) return null;
  const today = rows[idx];
  const past = rows[idx - period];
  if (!past || !(past.close > 0)) return null;
  const stockRet = (today.close - past.close) / past.close;

  const todayDate = today.date;
  let indexIdx = -1;
  for (let i = indexRows.length - 1; i >= 0; i--) {
    if (indexRows[i].date <= todayDate) { indexIdx = i; break; }
  }
  if (indexIdx < period) return null;
  const indexPast = indexRows[indexIdx - period];
  if (!indexPast || !(indexPast.close > 0)) return null;
  const indexRet = (indexRows[indexIdx].close - indexPast.close) / indexPast.close;

  return {
    market: marketLabel,
    stockRet: Number((stockRet * 100).toFixed(1)),
    indexRet: Number((indexRet * 100).toFixed(1)),
    relative: Number(((stockRet - indexRet) * 100).toFixed(1)),
    outperformer: stockRet > indexRet,
  };
}

// ─────────── VCP (Volatility Contraction Pattern) ───────────
// 박스권 안에서 swing high/low 의 contraction 들이 점점 작아지는 패턴
// 알고리즘:
//   1. 최근 N일 (60일) 안에 swing pivot (5일 ±) 찾기
//   2. high → next low 의 pullback depth 계산
//   3. 후속 contraction 이 더 작아지는지 (tightening)
//   4. 마지막 contraction 충분히 tight (≤ 10%)
function detectVCP(rows, idx, lookback = 60) {
  if (!rows || idx < lookback) return null;
  const window = rows.slice(idx - lookback + 1, idx + 1);

  const halfW = 5;
  const pivots = [];
  for (let i = halfW; i < window.length - halfW; i++) {
    let isHigh = true, isLow = true;
    const r = window[i];
    if (!(r.high > 0) || !(r.low > 0)) continue;
    for (let j = i - halfW; j <= i + halfW; j++) {
      if (j === i) continue;
      const c = window[j];
      if (!c) continue;
      if (c.high >= r.high) isHigh = false;
      if (c.low <= r.low) isLow = false;
    }
    if (isHigh) pivots.push({ idx: i, type: "high", price: r.high });
    if (isLow) pivots.push({ idx: i, type: "low", price: r.low });
  }
  pivots.sort((a, b) => a.idx - b.idx);

  // High → next Low 의 contraction
  const contractions = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    const p = pivots[i], q = pivots[i + 1];
    if (p.type === "high" && q.type === "low" && p.price > 0) {
      contractions.push({
        startIdx: p.idx, endIdx: q.idx,
        high: p.price, low: q.price,
        depth: (p.price - q.price) / p.price,
      });
    }
  }
  if (contractions.length < 2) return null;

  // 후속 contraction 이 90% 이하로 작아지는지 (점진적 수축)
  let tightening = true;
  for (let i = 1; i < contractions.length; i++) {
    if (contractions[i].depth >= contractions[i - 1].depth * 0.9) {
      tightening = false;
      break;
    }
  }

  const last = contractions[contractions.length - 1];
  const today = window[window.length - 1];
  const pivotHigh = last.high;
  const distanceFromPivot = pivotHigh > 0 ? (today.close / pivotHigh - 1) : 0;

  // VCP 조건: 2+ contractions, tightening, 마지막 ≤ 12%
  const isVCP = contractions.length >= 2 && tightening && last.depth <= 0.12;

  return {
    contractionCount: contractions.length,
    contractions: contractions.map((c) => ({ depthPct: Number((c.depth * 100).toFixed(1)) })),
    tightening,
    pivotHigh: Math.round(pivotHigh),
    today: today.close,
    distanceFromPivotPct: Number((distanceFromPivot * 100).toFixed(2)),
    isVCP,
  };
}

// ─────────── Weinstein Stage 분석 (주봉 기반, 정통) ───────────
// 주봉 30주(150일 일봉 동등) SMA 사용 — Stan Weinstein 정석
//   Stage 1: 30주선 평탄 + 종가 30주선 부근
//   Stage 2: 30주선 우상향 + 종가 30주선 위
//   Stage 3: 30주선 평탄 후 하락
//   Stage 4: 30주선 우하향
function checkWeinsteinWeekly(weeklyRows, idx) {
  if (!weeklyRows || idx < 30) return null;
  const closes = weeklyRows.slice(0, idx + 1).map((r) => r.close);
  const today = closes[idx];
  if (!(today > 0)) return null;

  const sma30 = sma(closes.slice(idx - 29, idx + 1), 30);
  if (!sma30) return null;

  // 30주선 4주 전과 비교 (≈ 1개월) — slope
  const sma30Past = idx >= 34 ? sma(closes.slice(idx - 33, idx - 3), 30) : null;
  const slope = sma30Past && sma30Past > 0 ? (sma30 - sma30Past) / sma30Past : 0;

  // 52주 고저
  const yearStart = Math.max(0, idx - 51);
  const yearWindow = weeklyRows.slice(yearStart, idx + 1);
  const high52w = Math.max(...yearWindow.map((r) => r.high || 0));
  const lows = yearWindow.map((r) => r.low).filter((v) => v > 0);
  const low52w = lows.length ? Math.min(...lows) : null;

  // Stage 분류
  let stage;
  const above = today > sma30;
  const rising = slope > 0.01; // 1% 이상 우상향
  const falling = slope < -0.01;
  if (above && rising) stage = 2;
  else if (!above && falling) stage = 4;
  else if (above && !rising && !falling) stage = 3;
  else stage = 1;

  return {
    stage,
    today,
    sma30: Math.round(sma30),
    slopePct: Number((slope * 100).toFixed(1)),
    above,
    rising,
    high52w,
    low52w,
    pctFromHigh52w: high52w > 0 ? Number(((today / high52w - 1) * 100).toFixed(1)) : null,
    pctFromLow52w: low52w ? Number(((today / low52w - 1) * 100).toFixed(1)) : null,
  };
}

function loadWeeklyChart(code) {
  try {
    return JSON.parse(fs.readFileSync(path.join(WEEKLY_CACHE_DIR, `${code}.json`), "utf-8"));
  } catch (_) { return null; }
}

// ─────────── ATR (Average True Range) — 손절·비중 계산용 ───────────
// 14일 ATR = 평균 일일 변동폭 (절대 가격)
// 손절가 = 진입가 - 2 * ATR (보통 -7~-10%)
// 비중 = (계좌 risk %) / (ATR / 진입가) — risk-parity 방식
function computeATR(rows, idx, period = 14) {
  if (!rows || idx < period) return null;
  const trs = [];
  for (let i = idx - period + 1; i <= idx; i++) {
    if (i < 1) continue;
    const r = rows[i], p = rows[i - 1];
    if (!p || !(p.close > 0)) continue;
    const tr = Math.max(
      r.high - r.low,
      Math.abs(r.high - p.close),
      Math.abs(r.low - p.close)
    );
    trs.push(tr);
  }
  if (trs.length < period - 2) return null;
  const atr = avg(trs);
  const today = rows[idx];
  const stopLoss = Math.round(today.close - 2 * atr);
  const stopPct = today.close > 0 ? -((2 * atr) / today.close) * 100 : 0;
  return {
    atr: Math.round(atr),
    atrPct: today.close > 0 ? Number((atr / today.close * 100).toFixed(2)) : 0,
    stopLoss,
    stopPct: Number(stopPct.toFixed(1)),
    // 비중 — 1% 계좌 risk 기준 (예: 100만원 계좌, 1만원 risk → 종목당 손절폭 X원이면 1만원/X 주)
    suggestedPositionPct: stopPct < 0 ? Number((1 / Math.abs(stopPct) * 100).toFixed(1)) : 0,
  };
}

// ─────────── Stan Weinstein Stage 1 → Stage 2 전환점 ───────────
// 사용자 exemplars (모두투어, 서울반도체 등) 의 핵심 패턴.
// Stage 1 (긴 박스권) 에서 Stage 2 (상승) 로 진입하는 첫 돌파일 감지.
//
// 조건:
//   1. 직전 60일 박스권 (진폭 ≤ 25%) — Stage 1 확인
//   2. 30주 (150일) SMA 평탄 또는 약상승 (직전 30일 변화 ±5% 이내)
//   3. 오늘 종가 > 30주 SMA (Stage 2 첫 진입)
//   4. 오늘 가격 > 60일 박스권 상단 (resistance breakout)
//   5. 오늘 거래량 ≥ 50일 평균 × 1.5 (거래량 확인)
//   6. 양봉 (close > open)
function detectStage1to2(rows, idx) {
  if (!rows || idx < 100) return null;
  const today = rows[idx];
  if (!(today.close > 0)) return null;

  // 1) 60일 박스권 (Stage 1)
  const baseStart = Math.max(0, idx - 60);
  const baseEnd = idx; // 오늘 제외
  const baseRows = rows.slice(baseStart, baseEnd);
  if (baseRows.length < 50) return null;
  const baseLows = baseRows.map((r) => r.low).filter((v) => v > 0);
  const baseHighs = baseRows.map((r) => r.high).filter((v) => v > 0);
  if (baseLows.length < 30 || baseHighs.length < 30) return null;
  const baseLow = Math.min(...baseLows);
  const baseHigh = Math.max(...baseHighs);
  if (baseLow <= 0) return null;
  const baseRange = (baseHigh - baseLow) / baseLow;
  const isFlatBase = baseRange <= 0.25;

  // 2) 100일 SMA (장기선 proxy) + 평탄 여부 (110일 cap 적응)
  const closes100 = rows.slice(idx - 99, idx + 1).map((r) => r.close).filter((v) => v > 0);
  if (closes100.length < 70) return null;
  const sma150 = avg(closes100); // 변수명 유지
  const closes100Past = idx >= 130 ? rows.slice(idx - 129, idx - 29).map((r) => r.close).filter((v) => v > 0) : [];
  const sma150Past = closes100Past.length >= 70 ? avg(closes100Past) : null;
  const sma150Slope = sma150Past ? (sma150 / sma150Past - 1) : 0;
  const sma150Stable = sma150Slope >= -0.05 && sma150Slope <= 0.10; // 평탄 ~ 약상승

  // 3) 종가 > 100일선
  const aboveSma150 = today.close > sma150;

  // 4) 박스권 상단 돌파
  const aboveBaseHigh = today.close > baseHigh;

  // 5) 거래량
  const vols50 = rows.slice(idx - 49, idx + 1).map((r) => r.volume).filter((v) => v > 0);
  const vol50 = avg(vols50);
  const volRatio = vol50 > 0 ? today.volume / vol50 : 0;
  const volStrong = volRatio >= 1.5;

  // 6) 양봉
  const isBullCandle = today.close > today.open;

  const passed = [isFlatBase, sma150Stable, aboveSma150, aboveBaseHigh, volStrong, isBullCandle].filter((v) => v).length;
  const isTransition = passed === 6;

  return {
    isTransition,
    passed,
    total: 6,
    checks: { isFlatBase, sma150Stable, aboveSma150, aboveBaseHigh, volStrong, isBullCandle },
    baseHigh: Math.round(baseHigh),
    baseLow: Math.round(baseLow),
    baseRangePct: Number((baseRange * 100).toFixed(1)),
    sma150: Math.round(sma150),
    sma150SlopePct: Number((sma150Slope * 100).toFixed(1)),
    volRatio: Number(volRatio.toFixed(2)),
    dayChange: rows[idx - 1] && rows[idx - 1].close > 0
      ? Number(((today.close - rows[idx - 1].close) / rows[idx - 1].close * 100).toFixed(2))
      : 0,
  };
}

// ─────────── Breakout 시그널 ───────────
// VCP pivot 돌파 + 거래량 50일 평균 1.5x+ + 양봉 2%+
function detectBreakout(rows, idx, vcp) {
  if (!vcp || !vcp.pivotHigh) return null;
  const today = rows[idx];
  const yest = rows[idx - 1];
  if (!yest || !(yest.close > 0)) return null;

  const pivot = vcp.pivotHigh;
  const closeAbove = today.close > pivot;
  const intradayBreak = today.high > pivot;

  const vols50 = rows.slice(idx - 49, idx + 1).map((r) => r.volume).filter((v) => v > 0);
  const avgVol = avg(vols50);
  const volRatio = avgVol > 0 ? today.volume / avgVol : 0;

  const dayChange = (today.close - yest.close) / yest.close;

  return {
    pivot,
    closeAbove,
    intradayBreak,
    volRatio: Number(volRatio.toFixed(2)),
    dayChange: Number((dayChange * 100).toFixed(2)),
    isBreakout: closeAbove && volRatio >= 1.5 && dayChange >= 0.02,
  };
}

// ─────────── 종합 점수 (사용자 rubric — 100점 만점) ───────────
//   1. 시장 상태 (15) — 지수 20·60·120일 추세
//   2. Weinstein Stage (20) — 30주선 위 + 30주선 상승 + 박스 돌파
//   3. Minervini Trend Template (20) — 정배열 + 52주 고점 근접
//   4. CAN SLIM 품질 (20) — 매출·영업이익·EPS 성장 + 영업이익률
//   5. 수급/거래량 (10) — 돌파 거래량, 조정 중 거래량 감소
//   6. 진입 타이밍 (10) — VCP, 피벗 근접, 돌파 여부
//   7. 리스크 (5) — 손절폭, ATR 대비 위험도
//
// 임계값:
//   - 75점+ : 관심종목 (watchlist)
//   - 85점+ : 매수 후보 (action)
// ─────────── 한국시장용 100점 배점 (가이드 #8-1, #8-2) ───────────
//   1. 시장 상태       15
//   2. Weinstein Stage 15
//   3. Minervini Trend 15
//   4. 실적/품질       20  ← 영업이익 중심 재배점 (가이드 #6-1)
//   5. RS+거래대금+수급 15
//   6. 진입 타이밍     10
//   7. 리스크/과열/유동성 10
//   ─────────────────────
//   합계               100
//   추가: 과열 페널티 (별도 추적, score 에서 차감)
function computeTotalScore(item, ctx = {}) {
  const breakdown = {};
  let score = 0;

  // 1) 시장 상태 (15점)
  const isKosdaq = (item.market || "").toUpperCase().includes("KOSDAQ");
  const m = isKosdaq ? (ctx.marketDetail?.kosdaq || {}) : (ctx.marketDetail?.kospi || {});
  const aboveAll = m.above20 && m.above60 && m.above120;
  const allRising = m.rising20 && m.rising60 && m.rising120;
  let marketScore = 0;
  if (aboveAll && allRising) { marketScore = 15; breakdown.market = `${isKosdaq ? 'KOSDAQ' : 'KOSPI'} 강한 강세장 (15)`; }
  else if (aboveAll) { marketScore = 12; breakdown.market = `${isKosdaq ? 'KOSDAQ' : 'KOSPI'} 강세장 (12)`; }
  else if (m.above60 && m.rising60) { marketScore = 8; breakdown.market = `${isKosdaq ? 'KOSDAQ' : 'KOSPI'} 회복 (8)`; }
  else if (m.above120) { marketScore = 4; breakdown.market = `${isKosdaq ? 'KOSDAQ' : 'KOSPI'} 장기 추세 살아있음 (4)`; }
  else { breakdown.market = `${isKosdaq ? 'KOSDAQ' : 'KOSPI'} 약세장 (0)`; }
  score += marketScore;
  breakdown.marketScore = marketScore;
  breakdown.regime = m.regime || (aboveAll && allRising ? "bull" : aboveAll ? "bull-soft" : (!m.above60 && !m.above120 ? "bear" : "neutral"));

  // 2) Weinstein Stage (15점) — 주봉 30주선 우선
  let wScore = 0;
  if (item.weekly) {
    if (item.weekly.above) { wScore += 6; breakdown.weinstein_above = `✓ 주봉 30주선 위 (6) [stage ${item.weekly.stage}]`; }
    if (item.weekly.rising) { wScore += 6; breakdown.weinstein_rising = `✓ 주봉 30주선 우상향 ${item.weekly.slopePct}% (6)`; }
    if (item.transition?.isTransition || item.breakout?.isBreakout) { wScore += 3; breakdown.weinstein_breakout = "✓ 박스 돌파 (3)"; }
  } else {
    if (item.trend?.checks?.aboveAllMAs) { wScore += 6; breakdown.weinstein_above = "✓ 100일선 위 (6) [일봉 fallback]"; }
    if (item.trend?.checks?.sma100Rising) { wScore += 6; breakdown.weinstein_rising = "✓ 100일선 우상향 (6) [일봉 fallback]"; }
    if (item.transition?.isTransition || item.breakout?.isBreakout) { wScore += 3; breakdown.weinstein_breakout = "✓ 박스 돌파 (3)"; }
  }
  score += wScore;
  breakdown.weinsteinScore = wScore;

  // 3) Minervini Trend Template (15점) — 비율 0.75배 적용
  let mvScore = 0;
  if (item.trend?.checks?.maStack) { mvScore += 6; breakdown.minervini_stack = "✓ 50/100 정배열 (6)"; }
  if (item.trend?.checks?.near100High) { mvScore += 5; breakdown.minervini_high = `✓ 100일 고점 ${item.trend?.pctFromHigh ?? 0}% (5)`; }
  if (item.trend?.checks?.above100Low) { mvScore += 4; breakdown.minervini_low = `✓ 100일 저점 +${item.trend?.pctFromLow ?? 0}% (4)`; }
  score += mvScore;
  breakdown.minerviniScore = mvScore;

  // 4) 실적/품질 (20점) — 한국식 재배점 (가이드 #6-1)
  //   매출 5 / 영업이익 7 / 영업이익률 4 / 흑자전환·이익 안정성 2 / 순이익 2 = 20
  let csScore = 0;
  if (item.financials?.growth) {
    const g = item.financials.growth;
    const lat = item.financials.latest;
    // 매출 성장 5점
    if (g.revenue >= 20) { csScore += 5; breakdown.cs_revenue = `매출 +${g.revenue}% (5)`; }
    else if (g.revenue >= 10) { csScore += 3; breakdown.cs_revenue = `매출 +${g.revenue}% (3)`; }
    else if (g.revenue != null) { breakdown.cs_revenue = `매출 ${g.revenue >= 0 ? '+' : ''}${g.revenue}% (0)`; }
    // 영업이익 성장 7점 (가장 중요)
    if (g.opIncome >= 30) { csScore += 7; breakdown.cs_op = `영업이익 +${g.opIncome}% (7)`; }
    else if (g.opIncome >= 15) { csScore += 5; breakdown.cs_op = `영업이익 +${g.opIncome}% (5)`; }
    else if (g.opIncome >= 5) { csScore += 3; breakdown.cs_op = `영업이익 +${g.opIncome}% (3)`; }
    else if (g.opIncome != null) { breakdown.cs_op = `영업이익 ${g.opIncome >= 0 ? '+' : ''}${g.opIncome}% (0)`; }
    // 영업이익률 4점
    if (lat?.opIncome > 0 && lat?.revenue > 0) {
      const margin = (lat.opIncome / lat.revenue) * 100;
      if (margin >= 15) { csScore += 4; breakdown.cs_margin = `영업이익률 ${margin.toFixed(1)}% (4)`; }
      else if (margin >= 8) { csScore += 3; breakdown.cs_margin = `영업이익률 ${margin.toFixed(1)}% (3)`; }
      else if (margin >= 5) { csScore += 2; breakdown.cs_margin = `영업이익률 ${margin.toFixed(1)}% (2)`; }
      else { breakdown.cs_margin = `영업이익률 ${margin.toFixed(1)}% (0)`; }
    }
    // 흑자전환·이익 안정성 2점
    if (lat?.opIncome > 0 && lat?.netIncome > 0) {
      csScore += 2; breakdown.cs_stability = "✓ 영업·당기순이익 흑자 (2)";
    } else if (lat?.opIncome > 0) {
      csScore += 1; breakdown.cs_stability = "영업이익만 흑자 (1)";
    }
    // 순이익 성장 2점 (한국 특수성: 일회성 영향, 비중 낮음)
    if (g.netIncome >= 25) { csScore += 2; breakdown.cs_net = `순이익 +${g.netIncome}% (2)`; }
    else if (g.netIncome >= 10) { csScore += 1; breakdown.cs_net = `순이익 +${g.netIncome}% (1)`; }
    else if (g.netIncome != null) { breakdown.cs_net = `순이익 ${g.netIncome >= 0 ? '+' : ''}${g.netIncome}% (0)`; }
  } else {
    breakdown.cs_note = "재무 데이터 없음 (0)";
  }
  csScore = Math.min(20, csScore);
  score += csScore;
  breakdown.canslimScore = csScore;

  // 5) RS + 거래대금 + 수급 (15점)
  //   돌파 거래량 4 / RS 5 / 거래대금 절대(유동성) 3 / 거래대금 모멘텀 3 = 15
  let supplyScore = 0;
  if (item.transition?.volRatio >= 1.5 || item.breakout?.volRatio >= 1.5) {
    supplyScore += 4; breakdown.supply_breakVol = `돌파 거래량 ✓ (4)`;
  }
  if (item.rs?.relative >= 30) { supplyScore += 5; breakdown.supply_rs = `RS +${item.rs.relative}% (5)`; }
  else if (item.rs?.relative >= 15) { supplyScore += 3; breakdown.supply_rs = `RS +${item.rs.relative}% (3)`; }
  else if (item.rs?.relative >= 5) { supplyScore += 1; breakdown.supply_rs = `RS +${item.rs.relative}% (1)`; }
  // 거래대금 5d/60d 모멘텀
  const valueMomScore = require("./korea-filter").valueMomentumScore(item.valueStats);
  if (valueMomScore > 0) {
    supplyScore += valueMomScore;
    breakdown.supply_valueMom = `거래대금 5d/60d ${item.valueStats?.ratio5To60 ?? '?'}배 (${valueMomScore})`;
  }
  // 거래대금 절대 (한국장 액티브 거래)
  const liqAbs = require("./korea-filter").liquidityScore(item.valueStats);
  // 5점 만점 중 3점만 supply 에 (나머지는 risk 영역으로)
  const liqInSupply = Math.min(3, liqAbs);
  if (liqInSupply > 0) {
    supplyScore += liqInSupply;
    breakdown.supply_liq = `유동성 (20일 평균 거래대금 ${Math.round((item.valueStats?.avg20 || 0) / 1e8)}억) (${liqInSupply})`;
  }
  supplyScore = Math.min(15, supplyScore);
  score += supplyScore;
  breakdown.supplyScore = supplyScore;

  // 6) 진입 타이밍 (10점)
  let entryScore = 0;
  if (item.transition?.isTransition) { entryScore = 10; breakdown.entry = "🌟 Stage 1→2 진입 (10)"; }
  else if (item.breakout?.isBreakout) { entryScore = 9; breakdown.entry = "🚀 VCP Breakout (9)"; }
  else if (item.vcp?.isVCP) {
    const dist = Math.abs(item.vcp.distanceFromPivotPct);
    if (dist <= 3) { entryScore = 7; breakdown.entry = `🟡 VCP + 피벗 근접 ${item.vcp.distanceFromPivotPct}% (7)`; }
    else { entryScore = 5; breakdown.entry = `🟡 VCP 형성 (5)`; }
  } else if (item.vcp) {
    entryScore = 2; breakdown.entry = "박스 안 (2)";
  }
  score += entryScore;
  breakdown.entryScore = entryScore;

  // 7) 리스크/과열/유동성 (10점) — ATR 5 + 시총 3 + 거래대금 절대 2
  let riskScore = 0;
  if (item.atr?.stopPct >= -6) { riskScore += 5; breakdown.risk_atr = `손절 ${item.atr.stopPct}% (5)`; }
  else if (item.atr?.stopPct >= -8) { riskScore += 3; breakdown.risk_atr = `손절 ${item.atr.stopPct}% (3)`; }
  else if (item.atr?.stopPct >= -12) { riskScore += 1; breakdown.risk_atr = `손절 ${item.atr.stopPct}% (1)`; }
  // 시총 점수 (max 5 의 60% = 3 적용)
  const mcScore = require("./korea-filter").marketCapScore(item.meta || { marketValue: item.marketCap });
  const mcInRisk = Math.min(3, mcScore);
  if (mcInRisk > 0) {
    riskScore += mcInRisk;
    breakdown.risk_marketCap = `시총 ${Math.round((item.marketCap || 0) / 1e8)}억 (${mcInRisk})`;
  }
  // 거래대금 절대 나머지 2점
  const liqInRisk = Math.max(0, liqAbs - liqInSupply);
  const liqInRiskCapped = Math.min(2, liqInRisk);
  if (liqInRiskCapped > 0) {
    riskScore += liqInRiskCapped;
    breakdown.risk_liquidity = `유동성 보강 (${liqInRiskCapped})`;
  }
  riskScore = Math.min(10, riskScore);
  score += riskScore;
  breakdown.riskScore = riskScore;

  // ─── 과열 감점 (가이드 #4) — 점수에서 차감 (메타 별도 추적) ───
  let overheatPenalty = 0;
  if (item.overheat) {
    overheatPenalty = item.overheat.penalty || 0;
    score += overheatPenalty; // penalty 가 음수
    breakdown.overheatPenalty = overheatPenalty;
    breakdown.overheatReasons = item.overheat.reasons || [];
  }

  // score cap [0, 100]
  score = Math.max(0, Math.min(100, score));

  // ─── setupScore (품질) vs entryScore (타이밍) 분리 ───
  const setupScore = Math.max(0, score - entryScore);
  const entryReady = entryScore >= 7;
  breakdown.setupScore = setupScore;
  breakdown.entryReady = entryReady;

  return {
    score,
    setupScore,
    entryScore,
    entryReady,
    overheatPenalty,
    breakdown,
  };
}

// 시장 상태 — KOSPI + KOSDAQ 양쪽 분석
function _analyzeIndex(rows) {
  if (!rows || rows.length < 60) return { regime: "neutral" };
  const closes = rows.map((r) => r.close);
  const last = closes[closes.length - 1];
  const sma20 = avg(closes.slice(-20));
  const sma60 = avg(closes.slice(-60));
  const sma100 = closes.length >= 100 ? avg(closes.slice(-100)) : sma60;
  const past20 = closes.length >= 40 ? avg(closes.slice(-40, -20)) : sma20;
  const past60 = closes.length >= 80 ? avg(closes.slice(-80, -20)) : sma60;
  const past100 = closes.length >= 110 ? avg(closes.slice(-110, -10)) : sma100;
  const detail = {
    above20: last > sma20, above60: last > sma60, above120: last > sma100,
    rising20: sma20 > past20, rising60: sma60 > past60, rising120: sma100 > past100,
  };
  let regime = "neutral";
  if (detail.above20 && detail.above60 && detail.above120) regime = "bull";
  else if (!detail.above60 && !detail.above120) regime = "bear";
  return { ...detail, regime };
}

async function detectMarketDetail() {
  try {
    const kospi = await getKospiCached();
    const kosdaq = await getKosdaqCached();
    return {
      kospi: _analyzeIndex(kospi),
      kosdaq: _analyzeIndex(kosdaq),
    };
  } catch (_) {
    return { kospi: { regime: "neutral" }, kosdaq: { regime: "neutral" } };
  }
}

// ─────────── 유틸 ───────────
function listSeededStocks() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs.readdirSync(CACHE_DIR)
    .filter((f) => /^\d{6}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""));
}

// ─────────── 메인 분석 ───────────
async function analyzeAll({ logProgress = false } = {}) {
  const stocksListPath = path.join(__dirname, "cache", "naver-stocks-list.json");
  const stocksList = JSON.parse(fs.readFileSync(stocksListPath, "utf-8")).stocks;
  const stockMeta = new Map(stocksList.map((s) => [s.code, s]));
  const kospi = await getKospiCached();
  const kosdaq = await getKosdaqCached();
  const seededCodes = listSeededStocks();
  const marketDetail = await detectMarketDetail();
  const dartApiKey = process.env.DART_API_KEY;

  // ─── 분석 기준일 설정 ───
  const expectedMarketDate = getExpectedMarketDate();

  // 시장 regime — bull/bear/sideways (BullTrendWatch 게이트용)
  const marketRegime = detectMarketRegime(kospi, kosdaq);

  // long chart 캐시(stock-charts-long) 와 flow-history 도 가능하면 활용
  // 두 캐시 디렉토리 합집합 코드 — long 만 있는 종목도 분석에 포함
  const longCodes = (() => {
    try { return fs.readdirSync(LONG_CACHE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")); }
    catch (_) { return []; }
  })();
  const allCodes = Array.from(new Set([...seededCodes, ...longCodes]));

  const stage2Pool = [];
  const vcpForming = [];
  const todaysBreakouts = [];
  const stage1to2Transitions = []; // Weinstein 전환점

  // 새 모델 (Phase 8) — universe 전체 대상
  const flowLeadCandidates = [];
  const reboundCandidates = [];
  const vviCandidates = [];
  const qvaCandidates = [];  // 단일 QVA 후보 (passed === true만)
  const qvaStrongCandidates = [];     // QVA_STRONG: HIGHER_LOW + EVOLUTION 동시 통과
  const qvaHigherLowOnlyCandidates = [];  // QVA_HL: HIGHER_LOW 단독
  const qvaEvolutionCandidates = [];  // QVA_EVOLUTION: 품질 필터 (메인 후보 아님)
  const qvaHoldCandidates = [];  // QVA-HOLD: 거래대금 이상징후 다음날도 견디기
  const qvaHigherLowCandidates = [];  // QVA-HL: 저점 상승 + 거래대금 증가
  const overheatWarnings = [];
  const csbMainCandidates = [];   // CSB 4개 stage tag 모두 통과 — "상승 전 압축 후보"
  const csbSubCandidates = [];    // CSB 3개 stage (지지+거래대금+(압축 OR 돌파)) — "예비 압축 후보"
  const smallCsbReady = [];       // CSB-Lite 4개 조건 통과 (중소형 500억~3000억)
  const smallCsbWatch = [];       // CSB-Lite 3개 조건 통과 (중소형 500억~3000억)
  const taggedAll = [];   // 모든 처리 종목 + 태그 — 보유점검/검색용

  let processed = 0;

  for (const code of allCodes) {
    // chart 로드 — long 우선, 없으면 250일 캐시 fallback
    let cache;
    try {
      cache = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, `${code}.json`), "utf-8"));
    } catch (_) {
      try {
        cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${code}.json`), "utf-8"));
      } catch (_) { continue; }
    }
    const rows = cache.rows || [];
    if (rows.length < 100) continue;
    const meta = stockMeta.get(code);
    if (!meta) continue;

    // flow 로드 (없으면 null — FlowLead/Rebound 점수 계산 skip)
    let flowRows = null;
    try {
      const flowPath = path.join(FLOW_CACHE_DIR, `${code}.json`);
      if (fs.existsSync(flowPath)) {
        flowRows = JSON.parse(fs.readFileSync(flowPath, "utf-8")).rows || null;
      }
    } catch (_) { /* skip */ }

    const lastIdx = rows.length - 1;

    // ATR (모든 후보에 사용)
    const atr = computeATR(rows, lastIdx, 14);

    // Weinstein Stage 1 → 2 전환 (Trend Template 통과 안 해도 별도 풀)
    const transition = detectStage1to2(rows, lastIdx);
    if (transition?.isTransition) {
      stage1to2Transitions.push({
        code, name: meta.name, market: meta.market,
        marketCap: meta.marketValue,
        closePrice: rows[lastIdx].close,
        changeRate: meta.changeRate,
        lastDate: rows[lastIdx].date,
        transition, atr,
      });
    }

    const tt = checkTrendTemplate(rows, lastIdx);
    if (!tt || tt.passed < 5) { processed++; continue; }

    // 주봉 Weinstein — 데이터 있을 때만 (정통 30주선 분석)
    let weekly = null;
    const weeklyCache = loadWeeklyChart(code);
    if (weeklyCache?.rows?.length >= 30) {
      const weeklyRows = weeklyCache.rows;
      weekly = checkWeinsteinWeekly(weeklyRows, weeklyRows.length - 1);
    }

    // 종목 market 에 맞는 인덱스로 RS 계산
    const isKosdaq = (meta.market || "").toUpperCase().includes("KOSDAQ");
    const indexRows = isKosdaq ? kosdaq : kospi;
    const indexLabel = isKosdaq ? "KOSDAQ" : "KOSPI";
    const rs = computeRS(rows, indexRows, lastIdx, 60, indexLabel);
    if (!rs || !rs.outperformer) { processed++; continue; }

    const vcp = detectVCP(rows, lastIdx);
    const breakout = vcp ? detectBreakout(rows, lastIdx, vcp) : null;

    // 5일/60일 거래대금 비율 (RS 보조)
    const last5Vol = avg(rows.slice(-5).map((r) => r.valueApprox || 0).filter((v) => v > 0));
    const last60Vol = avg(rows.slice(-60).map((r) => r.valueApprox || 0).filter((v) => v > 0));
    const volRatio5d60d = last60Vol > 0 ? last5Vol / last60Vol : 1;

    // DART 재무 (캐시 사용 — 빠름)
    let financials = null;
    if (dartApiKey) {
      try {
        financials = await dart.getFinancialsCached(code, dartApiKey);
        if (financials?.error) financials = null;
      } catch (_) {}
    }

    const item = {
      code, name: meta.name, market: meta.market,
      marketCap: meta.marketValue,
      closePrice: rows[lastIdx].close,
      changeRate: meta.changeRate,
      lastDate: rows[lastIdx].date,
      trend: tt,
      weekly,
      rs,
      vcp,
      breakout,
      atr,
      financials,
      volRatio5d60d: Number(volRatio5d60d.toFixed(2)),
    };

    // 종합 점수 계산 — setup (품질) vs entry (타이밍) 분리
    const scoreResult = computeTotalScore(item, { marketDetail });
    item.totalScore = scoreResult.score;
    item.setupScore = scoreResult.setupScore;
    item.entryScore = scoreResult.entryScore;
    item.entryReady = scoreResult.entryReady;
    item.scoreBreakdown = scoreResult.breakdown;

    stage2Pool.push(item);
    if (breakout?.isBreakout) todaysBreakouts.push(item);
    else if (vcp?.isVCP) vcpForming.push(item);

    processed++;
    if (logProgress && processed % 100 === 0) {
      console.log(`[analyze] ${processed}/${allCodes.length} stage2=${stage2Pool.length} vcp=${vcpForming.length} bo=${todaysBreakouts.length} flow=${flowLeadCandidates.length} rebound=${reboundCandidates.length}`);
    }

    // ─── Phase 8 (FlowLead / Rebound / Overheat) — TT 통과 여부와 무관하게 산출 ───
    // 위 코드 흐름상 TT 미통과는 이미 continue 됐으므로, 이 블록은 TT 통과 종목만 처리.
    // TT 미통과 종목도 새 모델은 평가해야 함 → 별도 루프 분리 (아래 if/continue 제거 어렵게 얽혀 있음)
    // → 이 자리에서는 stage2 통과 종목만 새 모델 평가, TT 미통과는 다음 단계 별도 루프
  }

  // ─── Phase 8 — TT 미통과 + universe 전체에 FlowLead/Rebound/Overheat 평가 ───
  for (const code of allCodes) {
    let cache;
    try {
      cache = JSON.parse(fs.readFileSync(path.join(LONG_CACHE_DIR, `${code}.json`), "utf-8"));
    } catch (_) {
      try { cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${code}.json`), "utf-8")); }
      catch (_) { continue; }
    }
    const rows = cache.rows || [];
    if (rows.length < 100) continue;
    const meta = stockMeta.get(code);
    if (!meta) continue;
    if (meta.isSpecial || meta.isEtf) continue;

    let flowRows = null;
    try {
      const flowPath = path.join(FLOW_CACHE_DIR, `${code}.json`);
      if (fs.existsSync(flowPath)) {
        flowRows = JSON.parse(fs.readFileSync(flowPath, "utf-8")).rows || null;
      }
    } catch (_) { /* skip */ }

    const lastIdx = rows.length - 1;
    const today = rows[lastIdx];
    const closePrice = today?.close || 0;
    if (!closePrice) continue;

    // 새 모델 점수
    let flowLead = null, rebound = null, vvi = null;
    if (flowRows?.length >= 10) {
      try { flowLead = calculateFlowLeadScore(rows, flowRows, meta); } catch (_) {}
      try { rebound = calculateReboundScore(rows, flowRows, meta); } catch (_) {}
      // VVI: 전일 고가보다 낮으면 pullback/consolidation → 신호로 보지 않음 (중복 신호 방지)
      const skipVvi = lastIdx > 0 && today.close < rows[lastIdx - 1].high;
      if (!skipVvi) {
        try { vvi = calculateVolumeValueIgnition(rows, flowRows, meta); } catch (_) {}
      }
    }

    // QVA (거래량 이상징후 선행 감지)
    let qva = null;
    if (rows.length >= 60) {
      try { qva = calculateQuietVolumeAnomaly(rows, flowRows, { ...meta, code }); } catch (_) {}
    }

    // QVA-EVOLUTION (점수 기반 진화 가능성 모델)
    let qvaEvolution = null;
    if (rows.length >= 60) {
      try { qvaEvolution = calculateQvaEvolution(rows, flowRows, { ...meta, code }); } catch (_) {}
    }

    // QVA-HOLD (거래대금 이상징후 다음날도 견디기)
    let qvaHold = null;
    if (rows.length >= 60) {
      try { qvaHold = calculateQuietVolumeHold(rows, flowRows, { ...meta, code }); } catch (_) {}
    }

    // QVA-HL (저점 상승 + 거래대금 증가)
    let qvaHigherLow = null;
    if (rows.length >= 60) {
      try { qvaHigherLow = calculateQuietVolumeHigherLow(rows, flowRows, { ...meta, code }); } catch (_) {}
    }

    // QVA-BOTH (HOLD + HIGHER_LOW 동시 충족 — 가장 강한 신호)
    let qvaBoth = null;
    if (qvaHold?.passed && qvaHigherLow?.passed) {
      qvaBoth = {
        passed: true,
        model: 'BOTH',
        score: Math.max((qvaHold?.score || 0), (qvaHigherLow?.score || 0)) + 10,
        signals: { ...qvaHold.signals, ...qvaHigherLow.signals },
      };
    }

    // 제일기획(030000) 디버그 로그
    if (code === '030000') {
      console.log(`\n[DEBUG 제일기획 030000]`);
      console.log(`  qva.passed=${qva?.passed}`);
      console.log(`  qvaEvolution.passed=${qvaEvolution?.passed}, score=${qvaEvolution?.score}`);
      console.log(`    structureCount=${qvaEvolution?.breakdown?.structureCount}, valueMedianRatio=${qvaEvolution?.signals?.valueMedianRatio20?.toFixed(2)}`);
      console.log(`  qvaHold.passed=${qvaHold?.passed}, model=${qvaHold?.model}`);
      console.log(`  qvaHigherLow.passed=${qvaHigherLow?.passed}`);
      console.log(`  qvaBoth.passed=${qvaBoth?.passed}`);
    }

    // VVI 과거 신호 스캔 (최근 1~5 거래일)
    let recentVviSignal = null;
    if (rows.length >= 65 && (flowRows?.length || 0) >= 10) {
      try { recentVviSignal = scanRecentVviSignals(rows, flowRows, meta, 5); } catch (_) {}
    }

    // CSB — 매 종목 lastIdx 시점 기준 (수급은 보조 가점만)
    let csb = null;
    try { csb = calculateCompressionSupportBreakoutScore(rows, flowRows, meta, lastIdx); } catch (_) {}

    // CSB-Lite — 중소형 (500억~3000억) 전용
    let smallCsb = null;
    try { smallCsb = calculateSmallCapCSB(rows, flowRows, meta, lastIdx); } catch (_) {}

    // CSB stop 가이드 (Dc 채택: relaxed close stop = clamp(ATR×2.5, 8%, 12%))
    let csbStopGuide = null;
    let csbTradePlan = null;
    if (csb?.passed && csb.metrics?.atrPct && closePrice > 0) {
      const stopPctFinal = Math.max(0.08, Math.min(0.12, csb.metrics.atrPct * 2.5));
      csbStopGuide = {
        method: 'relaxed-close',
        stopPct: +(stopPctFinal * 100).toFixed(1),
        stopPrice: Math.round(closePrice * (1 - stopPctFinal)),
        atrMultiplier: 2.5,
        formula: 'clamp(ATR%×2.5, 8%, 12%) — 종가 기준',
      };
    }
    if (csb?.passed) {
      csbTradePlan = buildCsbTradePlan(csb.metrics, closePrice);
    }

    // 가격 컨텍스트 — 과열/구조붕괴/고변동 판정용
    const ret5d = rows.length >= 6 ? (closePrice / rows[lastIdx - 5].close - 1) : 0;
    const ret20d = rows.length >= 21 ? (closePrice / rows[lastIdx - 20].close - 1) : 0;
    const ret60d = rows.length >= 61 ? (closePrice / rows[lastIdx - 60].close - 1) : 0;
    const ma20 = sma(rows.slice(-20).map((r) => r.close), 20);
    const ma200 = rows.length >= 200 ? sma(rows.slice(-200).map((r) => r.close), 200) : null;
    const dist20 = ma20 ? (closePrice / ma20 - 1) : 0;
    const atrObj = computeATR(rows, lastIdx, 14);
    const atrPct = atrObj?.atrPct ? atrObj.atrPct / 100 : null;  // fraction
    const last5val = rows.slice(-5);
    const last60val = rows.slice(-60);
    const avg5Value = last5val.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last5val.length, 1);
    const avg60Value = last60val.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last60val.length, 1);
    const valueExpansion = avg60Value > 0 ? avg5Value / avg60Value : 1;

    // setupScore 기존 로직 결과를 pickup (위 stage2Pool 에 있는 종목)
    const stage2Item = stage2Pool.find((s) => s.code === code);
    const setupScore = stage2Item?.setupScore || 0;
    const entryReady = stage2Item?.entryReady || false;

    // 시장 regime 매핑 — 종목 시장
    const isKosdaq = (meta.market || "").toUpperCase().includes("KOSDAQ");
    const stockRegime = isKosdaq ? marketRegime.kosdaq : marketRegime.kospi;
    const isBull = stockRegime === "bull";

    // ─── 태그 부여 ───
    const tags = [];

    // CSB stage tag 분류 (메인 모델)
    const csbStages = csb?.stages || {};
    const csbAllFour = csb?.passed && csbStages.compressionFormed && csbStages.supportConfirmed
      && csbStages.breakoutReady && csbStages.volumeReturning;
    const csbThree = csb?.passed && !csbAllFour && csbStages.supportConfirmed
      && csbStages.volumeReturning
      && (csbStages.compressionFormed || csbStages.breakoutReady);
    if (csbAllFour) tags.push("CSB_BREAKOUT");
    else if (csbThree) tags.push("CSB_COMPRESSION");

    // 모델 통과
    if (flowLead?.passed) tags.push("FLOW_LEAD");
    if (rebound?.passed) tags.push("REBOUND");
    if (vvi?.passed) tags.push(vvi.category === 'STRONG_IGNITION' ? 'VVI_STRONG' : 'VVI_IGNITION');
    if (setupScore >= 75 && setupScore < 85 && entryReady && isBull) tags.push("BULL_TREND_WATCH");
    // 과열 — setupScore 85+ OR 복합 과열 시그널
    const overheatHit =
      (setupScore >= 85) ||
      (ret5d >= 0.15) ||
      (dist20 >= 0.20) ||
      (atrPct != null && atrPct >= 0.10 && ret20d >= 0.15) ||
      (valueExpansion >= 3.0);
    if (overheatHit) tags.push("OVERHEAT_WARNING");
    // 고변동성
    if (atrPct != null && atrPct >= 0.15) tags.push("HIGH_VOLATILITY");
    // 구조 붕괴
    if ((ma200 && closePrice < ma200 * 0.80) || ret60d <= -0.45 || ret20d <= -0.35) {
      tags.push("STRUCTURE_BROKEN");
    }
    if (!tags.length) tags.push("NO_SIGNAL");

    // primary tag — 카테고리 분류 우선순위 (CSB 메인 모델로 승격)
    //   VVI_STRONG > CSB_BREAKOUT > CSB_COMPRESSION > REBOUND > VVI_IGNITION > FLOW_LEAD > BULL_TREND_WATCH > OVERHEAT_WARNING > 그 외
    const primaryOrder = ["VVI_STRONG", "CSB_BREAKOUT", "CSB_COMPRESSION", "REBOUND", "VVI_IGNITION", "FLOW_LEAD", "BULL_TREND_WATCH", "OVERHEAT_WARNING", "HIGH_VOLATILITY", "STRUCTURE_BROKEN", "NO_SIGNAL"];
    const primaryTag = primaryOrder.find((t) => tags.includes(t));

    // 시총별 분류
    const getCapBucket = (cap) => {
      if (!cap) return "unknown";
      if (cap >= 50_000_000_000 && cap < 100_000_000_000) return "cap500to1000";
      if (cap >= 100_000_000_000 && cap < 300_000_000_000) return "cap1000to3000";
      if (cap >= 300_000_000_000 && cap < 1_000_000_000_000) return "cap3000to1t";
      if (cap >= 1_000_000_000_000) return "cap1tPlus";
      return "unknown";
    };

    const tagged = {
      code, name: meta.name, market: meta.market,
      marketCap: meta.marketValue,
      capBucket: getCapBucket(meta.marketValue),
      closePrice,
      changeRate: meta.changeRate,
      lastDate: today.date,
      atrPct: atrPct != null ? +(atrPct * 100).toFixed(2) : null,
      ret5d: +(ret5d * 100).toFixed(2),
      ret20d: +(ret20d * 100).toFixed(2),
      ret60d: +(ret60d * 100).toFixed(2),
      dist20pct: +(dist20 * 100).toFixed(2),
      valueExpansion: +valueExpansion.toFixed(2),
      avg20Value: stage2Item?.avg20Value || rows.slice(-20).reduce((s, r) => s + (r.valueApprox || 0), 0) / 20,
      setupScore: setupScore || null,
      entryReady: entryReady || false,
      regime: stockRegime,
      flowLead: flowLead?.passed ? { score: flowLead.score, breakdown: flowLead.breakdown, signals: flowLead.signals } : null,
      rebound: rebound?.passed ? { score: rebound.score, breakdown: rebound.breakdown, signals: rebound.signals } : null,
      vvi: vvi?.passed ? { score: vvi.score, category: vvi.category, breakdown: vvi.breakdown, signals: vvi.signals } : null,
      qva: qva?.passed ? { score: qva.score, category: qva.category, breakdown: qva.breakdown, signals: qva.signals } : null,
      qvaEvolution: qvaEvolution?.passed ? { score: qvaEvolution.score, breakdown: qvaEvolution.breakdown, signals: qvaEvolution.signals } : null,
      qvaHold: qvaHold?.passed ? { score: qvaHold.score, breakdown: qvaHold.breakdown, signals: qvaHold.signals } : null,
      qvaHigherLow: qvaHigherLow?.passed ? { score: qvaHigherLow.score, breakdown: qvaHigherLow.breakdown, signals: qvaHigherLow.signals } : null,
      qvaBoth: qvaBoth?.passed ? { score: qvaBoth.score, signals: qvaBoth.signals } : null,
      csb: csb?.passed ? {
        // 점수는 백테스트에서 변별력 실패했으므로 UI 메인 표시 X — 디버깅용 보조
        score: csb.score,
        bucket: csb.bucket,
        displayGrade: csb.displayGrade,
        stages: csb.stages,
        tags: csb.tags,
        warnings: csb.warnings,
        metrics: csb.metrics,
        breakdown: csb.breakdown,
        stopGuide: csbStopGuide,
        tradePlan: csbTradePlan,
        stageCount: Object.values(csb.stages || {}).filter(Boolean).length,
      } : null,
      smallCsb: smallCsb?.passed ? {
        displayGrade: smallCsb.bucket === 'SMALL_CSB_READY' ? '준비' : '관찰',
        stages: smallCsb.stages,
        metrics: smallCsb.metrics,
        capBucket: smallCsb.capBucket,
        buyGuidance: smallCsb.buyGuidance,
      } : null,
      recentVviSignal: recentVviSignal || null,
      tags,
      primaryTag,
    };
    taggedAll.push(tagged);

    if (csbAllFour) csbMainCandidates.push(tagged);
    if (csbThree) csbSubCandidates.push(tagged);
    if (smallCsb?.passed && smallCsb.bucket === 'SMALL_CSB_READY') smallCsbReady.push(tagged);
    if (smallCsb?.passed && smallCsb.bucket === 'SMALL_CSB_WATCH') smallCsbWatch.push(tagged);
    if (flowLead?.passed) flowLeadCandidates.push(tagged);
    if (rebound?.passed) reboundCandidates.push(tagged);
    if (vvi?.passed) vviCandidates.push(tagged);
    // 기본 QVA는 후보로 표시하지 않음 (내부 탐지 지표만으로 사용)
    // if (qva?.passed) qvaCandidates.push(tagged);

    // QVA_HIGHER_LOW를 메인 모델로, QVA_EVOLUTION을 품질 필터로 재구조화
    // 최종 우선순위: STRONG (HL+EV) > HIGHER_LOW (HL단독) > EVOLUTION (품질필터, 메인아님)
    if (qvaHigherLow?.passed) {
      const evolutionAlso = qvaEvolution?.passed;
      const hasPastExplosion = qvaHigherLow.signals?.hasPastExplosion || false;
      // 임시 플래그: 데이터 갱신 필요 여부 (나중에 확인)
      tagged.qvaDataStale = false;
      tagged.qvaDataStaleDays = 0;

      // 과거 거래량 폭발이 있으면 recovery 상태: 주의 필요 (메인 후보 제외)
      if (hasPastExplosion && !evolutionAlso) {
        // HIGHER_LOW_RECOVERY: 과거 폭발 후 재유입만 있는 상태
        tagged.qvaType = 'HIGHER_LOW_RECOVERY';
        tagged.qvaScore = qvaHigherLow.score ?? 0;
        tagged.qvaMedianRatio = qvaHigherLow.signals?.valueMedianRatio20 || 0;
        qvaHigherLowOnlyCandidates.push(tagged);
        if (code === '030000') console.log(`  → HIGHER_LOW_RECOVERY (메인 후보 제외)`);
      } else if (evolutionAlso && !hasPastExplosion) {
        // QVA_STRONG: HIGHER_LOW + EVOLUTION 동시 통과 (과거 폭발 무관)
        tagged.qvaType = 'STRONG';
        tagged.qvaScore = Math.max(qvaHigherLow.score ?? 0, qvaEvolution.score ?? 0);
        tagged.qvaHlScore = qvaHigherLow.score;
        tagged.qvaEvScore = qvaEvolution.score;
        tagged.qvaMedianRatio = qvaHigherLow.signals?.valueMedianRatio20 || 0;
        qvaStrongCandidates.push(tagged);
        if (code === '030000') console.log(`  → qvaStrongCandidates에 추가됨`);
      } else if (!evolutionAlso && !hasPastExplosion) {
        // QVA_HL: HIGHER_LOW 단독 (과거 폭발 없음)
        tagged.qvaType = 'HIGHER_LOW';
        tagged.qvaScore = qvaHigherLow.score ?? 0;
        tagged.qvaMedianRatio = qvaHigherLow.signals?.valueMedianRatio20 || 0;
        qvaHigherLowOnlyCandidates.push(tagged);
        if (code === '030000') console.log(`  → qvaHigherLowOnlyCandidates에 추가됨`);
      } else if (evolutionAlso && hasPastExplosion) {
        // EVOLUTION + RECOVERY: 강한 재유입 (배지용만)
        tagged.qvaType = 'EVOLUTION_RECOVERY';
        tagged.qvaScore = Math.max(qvaHigherLow.score ?? 0, qvaEvolution.score ?? 0);
        tagged.qvaHlScore = qvaHigherLow.score;
        tagged.qvaEvScore = qvaEvolution.score;
        tagged.qvaMedianRatio = qvaHigherLow.signals?.valueMedianRatio20 || 0;
        qvaEvolutionCandidates.push(tagged);
        if (code === '030000') console.log(`  → EVOLUTION_RECOVERY (배지용)`);
      }
      qvaHigherLowCandidates.push(tagged);  // 역호환용 포함
    } else if (qvaEvolution?.passed) {
      // QVA_EVOLUTION: 메인 후보 아님 (품질 필터/배지용)
      tagged.qvaType = 'EVOLUTION';
      tagged.qvaScore = qvaEvolution.score;
      qvaEvolutionCandidates.push(tagged);
      if (code === '030000') console.log(`  → qvaEvolutionCandidates에 추가됨 (메인후보아님)`);
    } else if (code === '030000') {
      console.log(`  → QVA 후보 모두 탈락 (hl=${qvaHigherLow?.passed}, ev=${qvaEvolution?.passed})`);
    }
    if (overheatHit) overheatWarnings.push(tagged);
  }

  // ─── latestMarketDate: 전체 종목 lastDate 최빈값 ───
  const dateFreq = {};
  taggedAll.forEach(t => { if (t.lastDate) dateFreq[t.lastDate] = (dateFreq[t.lastDate] || 0) + 1; });
  let latestMarketDate = null, availableModeDateCount = 0, maxFreq = 0;
  for (const [d, c] of Object.entries(dateFreq)) { if (c > maxFreq) { maxFreq = c; latestMarketDate = d; availableModeDateCount = c; } }
  const availableModeDate = latestMarketDate;  // 역호환

  // ─── QVA 후보 최근성 필터링 ───
  // QVA는 최근 거래일(또는 그 전날)의 신호만 유효
  const parseDate = (d) => d ? new Date(d) : null;
  const latestDate = parseDate(latestMarketDate);
  const oneDayMs = 24 * 60 * 60 * 1000;

  const filterQvaRecency = (candidates) => {
    return candidates.filter(c => {
      if (!c.lastDate || !latestMarketDate) return true;
      const dayDiff = Math.floor((latestDate - parseDate(c.lastDate)) / oneDayMs);
      c.qvaDataStaleDays = dayDiff;

      // 데이터가 최근 거래일로부터 3일 이상 차이나면 제외
      if (dayDiff > 2) {
        c.qvaDataStale = true;
        return false;
      }
      return true;
    });
  };

  qvaStrongCandidates.splice(0, qvaStrongCandidates.length, ...filterQvaRecency(qvaStrongCandidates));
  qvaHigherLowOnlyCandidates.splice(0, qvaHigherLowOnlyCandidates.length, ...filterQvaRecency(qvaHigherLowOnlyCandidates));

  // ─── 데이터 커버리지 계산 ───
  const totalStocks = taggedAll.length;
  const expectedDateCount = taggedAll.filter(t => t.lastDate === latestMarketDate).length;
  const coverageRatio = totalStocks > 0 ? expectedDateCount / totalStocks : 0;
  let dataStatus = 'OK';
  let dataWarning = null;
  if (coverageRatio < 0.6) {
    dataStatus = 'STALE';
    dataWarning = '최신 거래일 데이터가 부족합니다. 차트 데이터를 갱신한 후 다시 분석하세요.';
  }

  // ─── vviTodayCandidates: lastDate === latestMarketDate && signalDate === latestMarketDate ───
  const vviTodayCandidates = vviCandidates
    .filter(t => t.lastDate === latestMarketDate)
    .map(t => ({
      ...t,
      signalDate: t.lastDate,
      signalHigh: t.vvi?.signals?.signalHigh || t.closePrice,
      signalClose: t.vvi?.signals?.signalClose || t.closePrice,
      vviStatus: 'WAITING_CONFIRM',
    }));

  // ─── vviRecentSignals: 최근 1~5 거래일 신호 추적 (latestMarketDate 기준) ───
  const vviRecentSignals = [];

  // A) stale vviCandidates (lastDate < latestMarketDate)
  for (const t of vviCandidates) {
    if (t.lastDate < latestMarketDate) {
      vviRecentSignals.push({
        code: t.code, name: t.name, market: t.market, marketCap: t.marketCap,
        regime: t.regime, closePrice: t.closePrice, lastDate: t.lastDate,
        signalDate: t.lastDate,
        signalHigh: t.vvi?.signals?.signalHigh || t.closePrice,
        signalClose: t.vvi?.signals?.signalClose || t.closePrice,
        currentDate: latestMarketDate,
        currentPrice: null,
        daysAfterSignal: null,
        vviStatus: 'STALE',
        vvi: t.vvi,
      });
    }
  }

  // B) recentVviSignal이 있는 종목
  for (const t of taggedAll) {
    if (!t.recentVviSignal) continue;
    const sig = t.recentVviSignal;
    if (sig.signalDate === latestMarketDate) continue; // 오늘 신호는 vviTodayCandidates에서 처리
    vviRecentSignals.push({
      code: t.code, name: t.name, market: t.market, marketCap: t.marketCap,
      regime: t.regime, closePrice: t.closePrice, lastDate: t.lastDate,
      signalDate: sig.signalDate,
      signalHigh: sig.signalHigh,
      signalClose: sig.signalClose,
      currentDate: t.lastDate,
      currentPrice: sig.currentPrice,
      daysAfterSignal: sig.daysAfterSignal,
      vviStatus: sig.status,
      confirmHigh: sig.confirmHigh,
      vvi: sig.vvi,
    });
  }

  vviRecentSignals.sort((a, b) => (a.daysAfterSignal || 99) - (b.daysAfterSignal || 99));

  // 기존 분류 (역호환 — 모델 검증 페이지 / API 호환용)
  const buyCandidates = stage2Pool.filter((it) => it.setupScore >= 75 && it.entryReady)
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
  const watchlist = stage2Pool.filter((it) => it.setupScore >= 75 && !it.entryReady)
    .sort((a, b) => (b.setupScore || 0) - (a.setupScore || 0));
  const observationList = stage2Pool.filter((it) => it.setupScore >= 65 && it.setupScore < 75)
    .sort((a, b) => (b.setupScore || 0) - (a.setupScore || 0));

  // 강세장 추세 관찰 — 75-84 + entryReady + bull regime
  const bullTrendWatch = stage2Pool
    .filter((it) => {
      const isKosdaq = (it.market || "").toUpperCase().includes("KOSDAQ");
      const reg = isKosdaq ? marketRegime.kosdaq : marketRegime.kospi;
      return it.setupScore >= 75 && it.setupScore < 85 && it.entryReady && reg === "bull";
    })
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

  // ─── 시총별 분류 ───
  const csbMainSorted = csbMainCandidates.sort((a, b) => (b.csb?.metrics?.valueRatio5d20d || 0) - (a.csb?.metrics?.valueRatio5d20d || 0));
  const csbSubSorted = csbSubCandidates.sort((a, b) => (b.csb?.metrics?.valueRatio5d20d || 0) - (a.csb?.metrics?.valueRatio5d20d || 0));

  const csbMainByCap = {
    cap500to1000: csbMainSorted.filter(c => c.capBucket === "cap500to1000"),
    cap1000to3000: csbMainSorted.filter(c => c.capBucket === "cap1000to3000"),
    cap3000to1t: csbMainSorted.filter(c => c.capBucket === "cap3000to1t"),
    cap1tPlus: csbMainSorted.filter(c => c.capBucket === "cap1tPlus"),
  };
  const csbSubByCap = {
    cap500to1000: csbSubSorted.filter(c => c.capBucket === "cap500to1000"),
    cap1000to3000: csbSubSorted.filter(c => c.capBucket === "cap1000to3000"),
    cap3000to1t: csbSubSorted.filter(c => c.capBucket === "cap3000to1t"),
    cap1tPlus: csbSubSorted.filter(c => c.capBucket === "cap1tPlus"),
  };

  const csbSmallCapMainCandidates = csbMainByCap.cap500to1000;
  const csbSmallCapSubCandidates = csbSubByCap.cap500to1000;

  const csbStats = {
    mainTotal: csbMainSorted.length,
    subTotal: csbSubSorted.length,
    byCap: {
      cap500to1000: { main: csbMainByCap.cap500to1000.length, sub: csbSubByCap.cap500to1000.length },
      cap1000to3000: { main: csbMainByCap.cap1000to3000.length, sub: csbSubByCap.cap1000to3000.length },
      cap3000to1t: { main: csbMainByCap.cap3000to1t.length, sub: csbSubByCap.cap3000to1t.length },
      cap1tPlus: { main: csbMainByCap.cap1tPlus.length, sub: csbSubByCap.cap1tPlus.length },
    }
  };

  const result = {
    analyzedAt: new Date().toISOString(),
    analyzeFinishedAt: new Date().toISOString(),
    seeded: seededCodes.length,
    processed,
    marketDetail,
    marketRegime,

    // ─── CSB 메인 모델 (Phase 9 — Dc 채택) ───
    // CSB 4태그 통과 = 메인 후보, 3태그 (지지+거래대금 + (압축 OR 돌파)) = 보조
    // 정렬: 거래대금 재활성 비율 (valueRatio5d20d) 기준 — 점수는 변별력 없어 제외
    csbMainCandidates: csbMainSorted,
    csbMainCount: csbMainSorted.length,
    csbSubCandidates: csbSubSorted,
    csbSubCount: csbSubSorted.length,

    // ─── 시총별 분류 ───
    csbSmallCapMainCandidates,
    csbSmallCapSubCandidates,
    csbMainByCap,
    csbSubByCap,
    csbStats,

    // ─── CSB-Lite (중소형 500억~3000억) ───
    smallCsbReady: smallCsbReady.sort((a, b) => (b.avg20Value || 0) - (a.avg20Value || 0)),
    smallCsbWatch: smallCsbWatch.sort((a, b) => (b.avg20Value || 0) - (a.avg20Value || 0)),
    smallCsbStats: {
      readyCount: smallCsbReady.length,
      watchCount: smallCsbWatch.length,
      byCapRange: {
        cap500to1000: {
          ready: smallCsbReady.filter(c => c.capBucket === "cap500to1000").length,
          watch: smallCsbWatch.filter(c => c.capBucket === "cap500to1000").length,
        },
        cap1000to2000: {
          ready: smallCsbReady.filter(c => c.capBucket === "cap1000to3000" && (c.marketCap || 0) < 200_000_000_000).length,
          watch: smallCsbWatch.filter(c => c.capBucket === "cap1000to3000" && (c.marketCap || 0) < 200_000_000_000).length,
        },
        cap2000to3000: {
          ready: smallCsbReady.filter(c => c.capBucket === "cap1000to3000" && (c.marketCap || 0) >= 200_000_000_000).length,
          watch: smallCsbWatch.filter(c => c.capBucket === "cap1000to3000" && (c.marketCap || 0) >= 200_000_000_000).length,
        },
      }
    },

    // ─── 새 카테고리 (Phase 8) ───
    flowLeadCandidates: flowLeadCandidates.sort((a, b) => (b.flowLead?.score || 0) - (a.flowLead?.score || 0)),
    flowLeadCount: flowLeadCandidates.length,
    reboundCandidates: reboundCandidates.sort((a, b) => (b.rebound?.score || 0) - (a.rebound?.score || 0)),
    reboundCount: reboundCandidates.length,
    vviCandidates: vviCandidates.sort((a, b) => (b.vvi?.score || 0) - (a.vvi?.score || 0)),
    vviCount: vviCandidates.length,
    vviTodayCandidates,
    vviRecentSignals,
    latestMarketDate,

    // ─── QVA (거래량 이상징후 선행 감지) — HIGHER_LOW 메인 모델 ───
    qvaCandidates: qvaCandidates.sort((a, b) => (b.qva?.score || 0) - (a.qva?.score || 0)),
    qvaCount: qvaCandidates.length,

    // QVA_STRONG: HIGHER_LOW + EVOLUTION 동시 통과 (최우선)
    qvaStrongCandidates: qvaStrongCandidates.sort((a, b) => {
      const scoreCompare = (b.qvaScore || 0) - (a.qvaScore || 0);
      if (scoreCompare !== 0) return scoreCompare;
      return (b.qvaMedianRatio || 0) - (a.qvaMedianRatio || 0);
    }),
    qvaStrongCount: qvaStrongCandidates.length,

    // QVA_HL: HIGHER_LOW 단독 (메인 후보)
    qvaHigherLowCandidates: qvaHigherLowOnlyCandidates.sort((a, b) => {
      const medianCompare = (b.qvaMedianRatio || 0) - (a.qvaMedianRatio || 0);
      if (medianCompare !== 0) return medianCompare;
      return (b.qvaScore || 0) - (a.qvaScore || 0);
    }),
    qvaHigherLowCount: qvaHigherLowOnlyCandidates.length,

    // QVA_EVOLUTION: 품질 필터 (메인 후보 아님, 상세페이지 또는 배지용)
    qvaEvolutionCandidates: qvaEvolutionCandidates.sort((a, b) => (b.qvaScore || 0) - (a.qvaScore || 0)),
    qvaEvolutionCount: qvaEvolutionCandidates.length,

    // QVA_HOLD: 제외 (향후 약세장 방어형으로만 유지)
    qvaHoldCandidates: qvaHoldCandidates.sort((a, b) => (b.qvaScore || 0) - (a.qvaScore || 0)),
    qvaHoldCount: qvaHoldCandidates.length,

    // ─── 날짜 및 데이터 상태 ───
    expectedMarketDate,
    availableModeDate,
    availableModeDateCount,
    totalStocks,
    expectedDateCount,
    coverageRatio: +(coverageRatio * 100).toFixed(1),
    dataStatus,
    dataWarning,
    bullTrendWatch,
    bullTrendWatchCount: bullTrendWatch.length,
    overheatWarnings: overheatWarnings.sort((a, b) => (b.ret5d || 0) - (a.ret5d || 0)),
    overheatCount: overheatWarnings.length,
    taggedAll,

    // ─── 기존 (역호환 — 점진 deprecate) ───
    stage1to2TransitionsCount: stage1to2Transitions.length,
    stage2Count: stage2Pool.length,
    vcpFormingCount: vcpForming.length,
    todaysBreakoutsCount: todaysBreakouts.length,
    buyCandidatesCount: buyCandidates.length,
    watchlistCount: watchlist.length,
    observationListCount: observationList.length,
    stage1to2Transitions: stage1to2Transitions.sort((a, b) => (b.transition?.volRatio || 0) - (a.transition?.volRatio || 0)),
    todaysBreakouts: todaysBreakouts.sort((a, b) => (b.breakout?.volRatio || 0) - (a.breakout?.volRatio || 0)),
    vcpForming: vcpForming.sort((a, b) => Math.abs(a.vcp.distanceFromPivotPct) - Math.abs(b.vcp.distanceFromPivotPct)),
    stage2Pool: stage2Pool.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0)).slice(0, 200),
    buyCandidates,
    watchlist: watchlist.slice(0, 50),
    observationList: observationList.slice(0, 50),
  };

  fs.writeFileSync(PATTERN_RESULT_CACHE, JSON.stringify(result, null, 0));
  console.log(`[analyzeAll] 완료 — vviCandidates: ${result.vviCandidates?.length || 0}개, CSB: ${result.csbMainCandidates?.length || 0}개, Rebound: ${result.reboundCandidates?.length || 0}개, FlowLead: ${result.flowLeadCandidates?.length || 0}개`);
  return result;
}

// ─── 시장 regime 검출 — Phase 8 ───
// 60일 SMA 기울기 기반:
//   bull: 60MA 가 +2% 이상 상승 (60일 전 대비)
//   bear: 60MA 가 -1% 이상 하락
//   sideways: 그 사이
function detectMarketRegime(kospiRows, kosdaqRows) {
  function classify(rows) {
    if (!rows || rows.length < 80) return "unknown";
    const ma60Now = sma(rows.slice(-60).map((r) => r.close), 60);
    const ma60Prev = sma(rows.slice(-80, -20).map((r) => r.close), 60);
    if (!ma60Now || !ma60Prev) return "unknown";
    const ratio = ma60Now / ma60Prev;
    if (ratio >= 1.02) return "bull";
    if (ratio <= 0.99) return "bear";
    return "sideways";
  }
  return {
    kospi: classify(kospiRows),
    kosdaq: classify(kosdaqRows),
  };
}

// ─────────── 백테스트 ───────────
// VCP breakout 의 실제 예측력 측정 — lift > 1.5x 목표
async function backtestMinervini({ daysBack = 100, forwardDays = [1, 5, 20] } = {}) {
  const stocksListPath = path.join(__dirname, "cache", "naver-stocks-list.json");
  const stocksList = JSON.parse(fs.readFileSync(stocksListPath, "utf-8")).stocks;
  const kospi = await getKospiCached();
  const kosdaq = await getKosdaqCached();
  const maxFwd = Math.max(...forwardDays);

  const breakoutTrials = [];
  const stage2Trials = [];
  const transitionTrials = []; // Weinstein Stage 1→2
  const allTrials = [];

  for (const meta of stocksList) {
    if (meta.isSpecial) continue;
    let cache;
    try {
      cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${meta.code}.json`), "utf-8"));
    } catch (_) { continue; }
    const rows = cache.rows || [];
    if (rows.length < 100) continue;

    const N = rows.length;
    const startIdx = Math.max(100, N - daysBack);
    for (let idx = startIdx; idx < N - maxFwd; idx++) {
      const today = rows[idx];
      const forward = {};
      for (const fwd of forwardDays) {
        const fIdx = idx + fwd;
        if (fIdx >= N) continue;
        forward[`d${fwd}`] = (rows[fIdx].close - today.close) / today.close;
      }
      const trial = { code: meta.code, date: today.date, forward };
      allTrials.push(trial);

      // Weinstein Stage 1→2 transition (independent test)
      const transition = detectStage1to2(rows, idx);
      if (transition?.isTransition) transitionTrials.push(trial);

      const tt = checkTrendTemplate(rows, idx);
      if (!tt || tt.passed < 5) continue;
      const isKosdaq = (meta.market || "").toUpperCase().includes("KOSDAQ");
      const idxRows = isKosdaq ? kosdaq : kospi;
      const rs = computeRS(rows, idxRows, idx, 60, isKosdaq ? "KOSDAQ" : "KOSPI");
      if (!rs || !rs.outperformer) continue;
      stage2Trials.push(trial);

      const vcp = detectVCP(rows, idx);
      if (vcp) {
        const breakout = detectBreakout(rows, idx, vcp);
        if (breakout?.isBreakout) breakoutTrials.push(trial);
      }
    }
  }

  function aggregate(trials, label) {
    const out = { label, n: trials.length };
    for (const fwd of forwardDays) {
      const rets = trials.map((t) => t.forward[`d${fwd}`]).filter(Number.isFinite).sort((a, b) => a - b);
      if (rets.length < 5) continue;
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const winRate = rets.filter((r) => r > 0).length / rets.length;
      out[`d${fwd}`] = {
        n: rets.length,
        mean: Number((mean * 100).toFixed(2)),
        median: Number((rets[Math.floor(rets.length / 2)] * 100).toFixed(2)),
        winRate: Math.round(winRate * 100),
      };
    }
    return out;
  }

  const baseline = aggregate(allTrials, "baseline (random)");
  const stage2 = aggregate(stage2Trials, "Stage 2 only");
  const breakout = aggregate(breakoutTrials, "Stage 2 + VCP + Breakout");
  const transition = aggregate(transitionTrials, "Weinstein Stage 1→2 진입");

  return { baseline, stage2, breakout, transition };
}

// 종합 점수 시스템 백테스트 — Phase 1 정직화 적용:
//   1) entryMode: "nextOpen" 디폴트 — 신호 발생 다음날 시가 매수 (today.close 가정 제거)
//   2) ATR stop 갭하락 처리 — bar.open ≤ stop → bar.open 청산, bar.low ≤ stop → stop 청산
//   3) useFinancials 옵션 — DART 미래 데이터 누출 가능성 차단용 (기본 false 권장)
//   4) worst → worstTrade 이름 변경 (개별 거래 최저 수익률, MDD 아님)
//   5) stoppedRate / gapStoppedRate / expectancy 추가
async function backtestTotalScore({
  daysBack = 60,
  forwardDays = [1, 5, 20],
  minScore = 85,
  applyAtrStop = true,
  entryMode = "nextOpen",
  // useFinancials: false | "current" (=true, legacy 미래 누출) | "asOf" (Phase 2 시점 보정)
  useFinancials = false,
  koreaFilter = korea.DEFAULT_KOREA_OPTIONS,
  cacheDir = CACHE_DIR, // Phase 3: 250일 캐시 (cache/stock-charts-long/) 옵션
} = {}) {
  // 호환: true → "current"
  if (useFinancials === true) useFinancials = "current";
  const stocksListPath = path.join(__dirname, "cache", "naver-stocks-list.json");
  const stocksList = JSON.parse(fs.readFileSync(stocksListPath, "utf-8")).stocks;
  const kospi = await getKospiCached();
  const kosdaq = await getKosdaqCached();
  const marketDetail = await detectMarketDetail();
  const dartApiKey = process.env.DART_API_KEY;
  const maxFwd = Math.max(...forwardDays);

  // 한국장 universe 사전 제외 (meta 단계만 — 시총/우선주/스팩/ETF)
  const filterStats = { total: stocksList.length, excluded: {} };
  function metaPasses(meta) {
    const pre = korea.passKoreaUniverseFilter(meta, null, koreaFilter);
    if (!pre.pass && pre.reason !== "low_liquidity_NaN억") {
      // 거래대금은 valueStats 단계에서 다시 검사 — 여기선 시총/특수종목만 컷
      if (!pre.reason.startsWith("low_liquidity")) {
        filterStats.excluded[pre.reason] = (filterStats.excluded[pre.reason] || 0) + 1;
        return false;
      }
    }
    return true;
  }

  // 한 거래 시뮬 — entry/exit/stop 모두 처리
  function simulateTrade({ rows, idx, fwd, atr }) {
    let entryIdx, entryPrice;
    if (entryMode === "nextOpen") {
      entryIdx = idx + 1;
      if (entryIdx >= rows.length) return null;
      const e = rows[entryIdx];
      entryPrice = Number.isFinite(e?.open) && e.open > 0 ? e.open : e?.close;
    } else { // sameClose
      entryIdx = idx;
      entryPrice = rows[idx].close;
    }
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

    const exitIdx = entryIdx + fwd;
    if (exitIdx >= rows.length) return null;

    let exitPrice = rows[exitIdx].close;
    let stopped = false, gapStopped = false;

    if (applyAtrStop && atr?.stopPct != null) {
      const stopPrice = entryPrice * (1 + atr.stopPct / 100);
      for (let k = entryIdx; k <= exitIdx; k++) {
        const bar = rows[k];
        if (!bar) continue;
        // 갭하락: 시가가 이미 stop 이하 — entry 다음 bar 부터만 검사 (entry bar 자체의 open 은 entry)
        if (k > entryIdx && Number.isFinite(bar.open) && bar.open <= stopPrice) {
          exitPrice = bar.open;
          stopped = true;
          gapStopped = true;
          break;
        }
        // 장중 stop touch
        if (Number.isFinite(bar.low) && bar.low <= stopPrice) {
          exitPrice = stopPrice;
          stopped = true;
          gapStopped = false;
          break;
        }
      }
    }

    return {
      ret: (exitPrice - entryPrice) / entryPrice,
      stopped,
      gapStopped,
    };
  }

  const trials85 = [], trials75 = [], trials65 = [], allTrials = [], allScored = [], trendRSTrials = [];

  for (const meta of stocksList) {
    if (!metaPasses(meta)) continue; // 한국장 universe 필터 (시총/우선주/스팩/ETF)
    let cache;
    try {
      cache = JSON.parse(fs.readFileSync(path.join(cacheDir, `${meta.code}.json`), "utf-8"));
    } catch (_) { continue; }
    const rows = cache.rows || [];
    if (rows.length < 100) continue;

    const weeklyCache = loadWeeklyChart(meta.code);
    const weeklyRows = weeklyCache?.rows || null;

    // 재무 데이터 (3모드)
    //   "current" — 현재 latest 분기 (모든 idx 동일, 미래 누출 가능)
    //   "asOf"    — 백테스트 시점 ≤ 가용일 인 가장 최근 분기 (시점별 보정)
    //   false     — 재무 미사용
    let financialsCurrent = null, financialsHistory = null;
    if (dartApiKey) {
      try {
        if (useFinancials === "current") {
          financialsCurrent = await dart.getFinancialsCached(meta.code, dartApiKey);
          if (financialsCurrent?.error) financialsCurrent = null;
        } else if (useFinancials === "asOf") {
          financialsHistory = await dart.getFinancialsHistoryCached(meta.code, dartApiKey);
        }
      } catch (_) {}
    }

    const N = rows.length;
    const headroom = entryMode === "nextOpen" ? maxFwd + 1 : maxFwd;
    const startIdx = Math.max(100, N - daysBack);

    for (let idx = startIdx; idx < N - headroom; idx++) {
      const today = rows[idx];

      // 한국장 유동성 필터 (시점별 거래대금) — baseline 도 동일 universe 적용
      const valueStats = korea.calcTradingValueStats(rows, idx);
      const liqCheck = korea.passKoreaUniverseFilter(meta, valueStats, koreaFilter);
      if (!liqCheck.pass) {
        filterStats.excluded[liqCheck.reason] = (filterStats.excluded[liqCheck.reason] || 0) + 1;
        continue;
      }

      const forward = {};
      for (const fwd of forwardDays) {
        const sim = simulateTrade({ rows, idx, fwd, atr: null });
        if (sim == null) continue;
        forward[`d${fwd}`] = sim.ret;
      }
      allTrials.push({ code: meta.code, date: today.date, forward });

      const tt = checkTrendTemplate(rows, idx);
      if (!tt || tt.passed < 5) continue;
      const isKosdaq = (meta.market || "").toUpperCase().includes("KOSDAQ");
      const idxRows = isKosdaq ? kosdaq : kospi;
      const rs = computeRS(rows, idxRows, idx, 60, isKosdaq ? "KOSDAQ" : "KOSPI");
      if (!rs || !rs.outperformer) continue;

      let weekly = null;
      if (weeklyRows && weeklyRows.length >= 30) {
        let wIdx = -1;
        for (let i = weeklyRows.length - 1; i >= 0; i--) {
          if (weeklyRows[i].date <= today.date) { wIdx = i; break; }
        }
        if (wIdx >= 30) weekly = checkWeinsteinWeekly(weeklyRows, wIdx);
      }

      const vcp = detectVCP(rows, idx);
      const breakout = vcp ? detectBreakout(rows, idx, vcp) : null;
      const transition = detectStage1to2(rows, idx);
      const atr = computeATR(rows, idx, 14);
      const last5Vol = avg(rows.slice(idx - 4, idx + 1).map((r) => r.valueApprox || 0).filter((v) => v > 0));
      const last60Vol = avg(rows.slice(idx - 59, idx + 1).map((r) => r.valueApprox || 0).filter((v) => v > 0));
      const volRatio5d60d = last60Vol > 0 ? last5Vol / last60Vol : 1;
      const overheat = korea.computeOverheatPenalty(rows, idx);

      // 시점별 재무 (asOf 모드)
      let financials = null;
      if (useFinancials === "current") {
        financials = financialsCurrent;
      } else if (useFinancials === "asOf" && financialsHistory) {
        financials = dart.getFinancialsAsOf(financialsHistory, today.date);
      }

      const item = {
        market: meta.market,
        marketCap: meta.marketValue,
        meta,
        trend: tt, weekly, rs, vcp, breakout, transition, atr, financials, volRatio5d60d,
        valueStats,
        overheat,
      };
      const { setupScore, entryReady } = computeTotalScore(item, { marketDetail });

      // baselineTrendRS — Trend Template + RS pass 한 모든 시점 (점수 무관)
      // 일반 baseline 보다 좁은 universe → 점수 시스템의 진짜 추가 가치 측정
      // (이 push 는 점수 cutoff 와 별개로 기록만)
      // 메타 trial 은 아래에서 작성

      // 점수 통과 후보만 stop 적용 forward 재계산
      const candidateForward = {}, candidateStopped = {}, candidateGap = {};
      for (const fwd of forwardDays) {
        const sim = simulateTrade({ rows, idx, fwd, atr });
        if (sim == null) continue;
        candidateForward[`d${fwd}`] = sim.ret;
        candidateStopped[`d${fwd}`] = sim.stopped;
        candidateGap[`d${fwd}`] = sim.gapStopped;
      }

      const trial = {
        code: meta.code, name: meta.name, date: today.date,
        market: meta.market,
        marketCap: meta.marketValue,
        avg20Value: valueStats?.avg20 || 0,
        forward: candidateForward,
        stopped: candidateStopped,
        gapStopped: candidateGap,
        setupScore, entryReady,
      };
      if (setupScore >= 75 && entryReady) trials85.push(trial);
      else if (setupScore >= 75) trials75.push(trial);
      else if (setupScore >= 65) trials65.push(trial);
      allScored.push(trial);
      trendRSTrials.push(trial); // baselineTrendRS — Trend+RS pass 한 모든 시점
    }
  }

  function aggregate(trials, label) {
    const out = { label, n: trials.length };
    for (const fwd of forwardDays) {
      const valid = trials
        .map((t) => ({
          ret: t.forward?.[`d${fwd}`],
          stopped: !!t.stopped?.[`d${fwd}`],
          gapStopped: !!t.gapStopped?.[`d${fwd}`],
        }))
        .filter((x) => Number.isFinite(x.ret));
      if (valid.length < 5) continue;
      const rets = valid.map((v) => v.ret).sort((a, b) => a - b);
      const sum = (arr) => arr.reduce((a, b) => a + b, 0);
      const wins = rets.filter((r) => r > 0);
      const losses = rets.filter((r) => r < 0);
      const mean = sum(rets) / rets.length;
      const avgWin = wins.length ? sum(wins) / wins.length : 0;
      const avgLoss = losses.length ? sum(losses) / losses.length : 0;
      const profitFactor = losses.length ? sum(wins) / Math.abs(sum(losses)) : (wins.length ? Infinity : 0);
      const winLossRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : (avgWin > 0 ? Infinity : 0);
      const stoppedCount = valid.filter((v) => v.stopped).length;
      const gapStoppedCount = valid.filter((v) => v.gapStopped).length;
      const p = (q) => rets[Math.floor((rets.length - 1) * q)];
      out[`d${fwd}`] = {
        n: rets.length,
        mean: Number((mean * 100).toFixed(2)),
        expectancy: Number((mean * 100).toFixed(2)), // alias
        median: Number((rets[Math.floor(rets.length / 2)] * 100).toFixed(2)),
        p25: Number((p(0.25) * 100).toFixed(2)),
        p75: Number((p(0.75) * 100).toFixed(2)),
        winRate: Math.round((wins.length / rets.length) * 100),
        avgWin: Number((avgWin * 100).toFixed(2)),
        avgLoss: Number((avgLoss * 100).toFixed(2)),
        winLossRatio: Number(winLossRatio.toFixed(2)),
        profitFactor: Number(profitFactor.toFixed(2)),
        worstTrade: Number((rets[0] * 100).toFixed(2)),
        bestTrade: Number((rets[rets.length - 1] * 100).toFixed(2)),
        stoppedRate: Math.round((stoppedCount / valid.length) * 100),
        gapStoppedRate: Math.round((gapStoppedCount / valid.length) * 100),
      };
    }
    return out;
  }

  return {
    config: { entryMode, applyAtrStop, useFinancials, daysBack, forwardDays, koreaFilter },
    rule: [
      `entryMode=${entryMode}`,
      `applyAtrStop=${applyAtrStop}` + (applyAtrStop ? " (gap-down 처리 포함)" : ""),
      `useFinancials=${useFinancials}` + (useFinancials ? " ⚠️ 미래 데이터 누출 가능" : ""),
      `koreaFilter: 시총≥${(koreaFilter?.minMarketCap || 0) / 1e8}억, 거래대금≥${(koreaFilter?.minAvg20TradingValue || 0) / 1e8}억`,
    ].join(" / "),
    filterStats,
    // 단일 그룹
    baseline:           aggregate(allTrials,                                                "baseline (전체 필터통과)"),
    baselineTrendRS:    aggregate(trendRSTrials,                                            "baselineTrendRS (Trend+RS pass)"),
    buyCandidates:      aggregate(trials85,                                                 "💎 매수 후보 (setup≥75 AND entryReady)"),
    watchlist:          aggregate(trials75,                                                 "👀 관심종목 (setup≥75, 진입 대기)"),
    observation:        aggregate(trials65,                                                 "👁 관찰 (setup 65~74)"),
    // 누적 그룹 (가이드 #11)
    score75Plus:        aggregate(allScored.filter((t) => t.setupScore >= 75),              "75+ 누적"),
    score65Plus:        aggregate(allScored.filter((t) => t.setupScore >= 65),              "65+ 누적"),
    // raw trial 풀 (분리 집계용)
    allScored,
    trendRSTrials,
    aggregate,
  };
}

// ─────────── Korea Flow Lead Model ───────────
// Phase 6 — 한국장 실패한 v2(Weinstein+Minervini+CAN SLIM) 대체 모델.
// 가설: 가격이 이미 급등한 종목 추격 X, 외국인+기관 수급이 먼저 들어왔는데
//        주가는 아직 과열되지 않은 종목을 찾는다.
//
// 입력:
//   chartRows  — cache/stock-charts-long/<code>.json 의 rows
//   flowRows   — cache/flow-history/<code>.json 의 rows (외국인/기관 일별 순매수)
//   meta       — cache/naver-stocks-list.json 의 종목 메타 (marketValue, market, isSpecial, isEtf)
//
// 점수 (100점):
//   1. Market Regime         15
//   2. Foreign/Inst Flow     30
//   3. Price Not Overheated  15
//   4. Trading Value Expand  15
//   5. Financial Safety      10  (현재 default 5 — useFinancials 연결은 추후)
//   6. Recovery Momentum     10
//   7. Risk Control           5
//
// Hard filters (모두 통과해야 score 산출):
//   - 시총 ≥ 1000억, 우선/스팩/ETF/ETN 제외
//   - 20일 평균거래대금 ≥ 50억
//   - 5일 외+기 순매수 > 0, 20일 외+기 순매수 > 0
//   - 5일 외+기 순매수 / (avg20Value × 5) ≥ 0.3
//   - 5일 등락률 ≤ 12%, 20일 등락률 ≤ 25%
//   - 현재가가 20MA 또는 60MA 회복
//   - ATR 14d 계산 가능
function calculateFlowLeadScore(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  if (!flowRows || flowRows.length < 20) return null;

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const sumKey = (arr, k) => arr.reduce((s, r) => s + (r?.[k] || 0), 0);
  const flow20 = flowRows.slice(-20);
  const flow5 = flowRows.slice(-5);

  // ─── Hard filters ───
  const reject = (reason) => ({ passed: false, reason });

  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  if ((meta.marketValue || 0) < 100_000_000_000) return reject('marketCap<1000억');

  const last20rows = chartRows.slice(-20);
  const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last20rows.length, 1);
  if (avg20Value < 5_000_000_000) return reject('avg20Value<50억');

  const foreign5d = sumKey(flow5, 'foreignNetValue');
  const inst5d = sumKey(flow5, 'instNetValue');
  const total5d = foreign5d + inst5d;
  if (total5d <= 0) return reject('5d flow<=0');

  const foreign20d = sumKey(flow20, 'foreignNetValue');
  const inst20d = sumKey(flow20, 'instNetValue');
  const total20d = foreign20d + inst20d;
  if (total20d <= 0) return reject('20d flow<=0');

  // 5일 누적 순매수 / 20일 평균거래대금(1일 기준) — 사용자 정의 임계값 0.3
  const flowRatio5d = total5d / avg20Value;
  if (flowRatio5d < 0.3) return reject('flowRatio5d<0.3');

  const ret5d = chartRows.length >= 6 ? (close / chartRows[chartRows.length - 6].close - 1) : 0;
  if (ret5d > 0.12) return reject('ret5d>12%');
  const ret20d = chartRows.length >= 21 ? (close / chartRows[chartRows.length - 21].close - 1) : 0;
  if (ret20d > 0.25) return reject('ret20d>25%');

  const ma20 = sma(last20rows.map((r) => r.close), 20);
  const last60rows = chartRows.slice(-60);
  const ma60 = sma(last60rows.map((r) => r.close), 60);
  const above20 = ma20 != null && close >= ma20;
  const above60 = ma60 != null && close >= ma60;
  if (!above20 && !above60) return reject('below 20MA & 60MA');

  const atrObj = computeATR(chartRows, idx, 14);
  if (!atrObj || !(atrObj.atr > 0) || !Number.isFinite(atrObj.atr)) return reject('ATR n/a');
  const atrPct = atrObj.atr / close;  // fraction (e.g. 0.04 = 4%)

  // ─── Score ───
  // 1. Market Regime — 종목 자체 60MA 흐름 (외부 인덱스 연동 추후)
  let regimeScore = 0;
  const ma60Prev = chartRows.length >= 80
    ? sma(chartRows.slice(-80, -20).map((r) => r.close), 60)
    : null;
  if (ma60 != null && ma60Prev != null) {
    if (ma60 > ma60Prev * 1.02) regimeScore = 15;
    else if (ma60 > ma60Prev * 0.99) regimeScore = 8;
    else regimeScore = 0;
  } else {
    regimeScore = 8;
  }

  // 2. Foreign/Institution Flow
  let flowScore = 0;
  if (flowRatio5d >= 1.0) flowScore += 20;
  else if (flowRatio5d >= 0.6) flowScore += 14;
  else flowScore += 8;
  const positive5d = flow5.filter((r) => (r.foreignNetValue || 0) + (r.instNetValue || 0) > 0).length;
  if (positive5d >= 5) flowScore += 10;
  else if (positive5d >= 4) flowScore += 8;
  else if (positive5d >= 3) flowScore += 5;
  flowScore = Math.min(flowScore, 30);

  // 3. Price Not Overheated
  let overheatScore = 0;
  if (ret5d <= 0.03) overheatScore = 15;
  else if (ret5d <= 0.06) overheatScore = 12;
  else if (ret5d <= 0.09) overheatScore = 8;
  else overheatScore = 4;
  if (ret20d > 0.20) overheatScore = Math.max(0, overheatScore - 5);

  // 4. Trading Value Expansion (5d avg / 60d avg)
  const last5rows = chartRows.slice(-5);
  const avg5Value = last5rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last5rows.length, 1);
  const avg60Value = last60rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last60rows.length, 1);
  const valueExpansion = avg60Value > 0 ? avg5Value / avg60Value : 1;
  let valueScore = 0;
  if (valueExpansion >= 1.5) valueScore = 15;
  else if (valueExpansion >= 1.2) valueScore = 11;
  else if (valueExpansion >= 1.0) valueScore = 7;
  else valueScore = 3;

  // 5. Financial Safety — useFinancials 연결 추후
  const finScore = 5;

  // 6. Recovery Momentum
  let recoveryScore = 0;
  if (above20 && above60) recoveryScore = 10;
  else if (above20) recoveryScore = 7;
  else if (above60) recoveryScore = 5;

  // 7. Risk Control
  let riskScore = 0;
  if (atrPct < 0.04) riskScore = 5;
  else if (atrPct < 0.06) riskScore = 3;
  else riskScore = 0;

  const score = regimeScore + flowScore + overheatScore + valueScore + finScore + recoveryScore + riskScore;

  return {
    passed: true,
    score,
    breakdown: { regimeScore, flowScore, overheatScore, valueScore, finScore, recoveryScore, riskScore },
    signals: {
      foreign5d, inst5d, total5d,
      foreign20d, inst20d, total20d,
      flowRatio5d, ret5d, ret20d,
      above20, above60,
      avg5Value, avg20Value, avg60Value, valueExpansion,
      atrPct, positive5d,
    },
  };
}

// ─────────── FlowLead v2 — 수급 선행·가격 미반응 모델 ───────────
//
// 핵심 가설: 외국인·기관 순매수대금이 유입되는데 가격은 아직 강하게 오르지 않은
// 종목은 이후 d10/d20에서 반응할 수 있다.
//
// v1 과 차이:
//   1) Hard reject 양방향 강화 (ret5d ±12%, ret20d -25%/+35%, ATR% 20)
//   2) MA fallback chain (ma120 → ma60 → ret60d)
//   3) 점수 7카테고리 (수급강도25 / 지속성20 / 가격미반응20 / 유동성10 / 차트위치10 / 변동성10 / 리스크5)
//   4) 새 지표: netBuyDays5d / flowRatio20d / flowAcceleration / flowPriceDivergence
//   5) ret20d +25~+35% 구간은 soft penalty 로 통과
//   6) matched baseline 은 flowLeadV2Universe 만 통과하면 OK (수급 조건 X)
function flowLeadV2Universe(chartRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return { passed: false, reason: 'chart<60' };
  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return { passed: false, reason: 'close<=0' };

  if (meta.isSpecial || meta.isEtf) return { passed: false, reason: 'special/etf' };
  if ((meta.marketValue || 0) < 100_000_000_000) return { passed: false, reason: 'marketCap<1000억' };

  const last20rows = chartRows.slice(-20);
  const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last20rows.length, 1);
  if (avg20Value < 5_000_000_000) return { passed: false, reason: 'avg20Value<50억' };

  const ret5d = chartRows.length >= 6 ? (close / chartRows[chartRows.length - 6].close - 1) : 0;
  const ret20d = chartRows.length >= 21 ? (close / chartRows[chartRows.length - 21].close - 1) : 0;
  if (ret5d > 0.12) return { passed: false, reason: 'ret5d>+12%' };
  if (ret5d < -0.12) return { passed: false, reason: 'ret5d<-12%' };
  if (ret20d > 0.35) return { passed: false, reason: 'ret20d>+35%' };
  if (ret20d < -0.25) return { passed: false, reason: 'ret20d<-25%' };

  const atrObj = computeATR(chartRows, idx, 14);
  if (!atrObj || !(atrObj.atr > 0) || !Number.isFinite(atrObj.atr)) return { passed: false, reason: 'ATR n/a' };
  const atrPct = atrObj.atr / close;
  if (atrPct > 0.20) return { passed: false, reason: 'ATR%>20' };

  // 구조 살아있는지 — MA fallback chain
  const ma60 = chartRows.length >= 60 ? sma(chartRows.slice(-60).map((r) => r.close), 60) : null;
  const ma120 = chartRows.length >= 120 ? sma(chartRows.slice(-120).map((r) => r.close), 120) : null;
  if (ma120 != null && ma120 > 0) {
    if (close / ma120 < 0.85) return { passed: false, reason: 'close/ma120<0.85' };
  } else if (ma60 != null && ma60 > 0) {
    if (close / ma60 < 0.80) return { passed: false, reason: 'close/ma60<0.80' };
  } else {
    const ret60d = chartRows.length >= 61 ? (close / chartRows[chartRows.length - 61].close - 1) : 0;
    if (ret60d < -0.30) return { passed: false, reason: 'ret60d<-30%' };
  }

  return { passed: true, avg20Value, ret5d, ret20d, atrPct, ma60, ma120, close };
}

function calculateFlowLeadScoreV2(chartRows, flowRows, meta = {}) {
  const u = flowLeadV2Universe(chartRows, meta);
  if (!u.passed) return { passed: false, reason: u.reason };
  if (!flowRows || flowRows.length < 20) return { passed: false, reason: 'flow<20' };

  const { avg20Value, ret5d, ret20d, atrPct, ma60, ma120, close } = u;

  // 20MA 이격도 +20% 이하
  const ma20 = sma(chartRows.slice(-20).map((r) => r.close), 20);
  if (ma20 != null && ma20 > 0 && (close / ma20 - 1) > 0.20) {
    return { passed: false, reason: 'ma20 dev>+20%' };
  }

  // ret5d/ret20d 통과 범위 (1번 스펙: ret5d -5%~+10%, ret20d -10%~+25%, +25~+35% 는 soft penalty 로 통과)
  if (ret5d < -0.05 || ret5d > 0.10) return { passed: false, reason: `ret5d out (${(ret5d * 100).toFixed(1)}%)` };
  if (ret20d < -0.10) return { passed: false, reason: `ret20d<-10% (${(ret20d * 100).toFixed(1)}%)` };
  // ret20d 가 +25%~+35% 면 통과 (점수에서 penalty), +35% 초과는 universe 에서 이미 reject

  const sumKey = (arr, k) => arr.reduce((s, r) => s + (r?.[k] || 0), 0);
  const flow5 = flowRows.slice(-5);
  const flow20 = flowRows.slice(-20);

  const foreign5d = sumKey(flow5, 'foreignNetValue');
  const inst5d = sumKey(flow5, 'instNetValue');
  const total5d = foreign5d + inst5d;
  const foreign20d = sumKey(flow20, 'foreignNetValue');
  const inst20d = sumKey(flow20, 'instNetValue');
  const total20d = foreign20d + inst20d;

  if (total5d <= 0) return { passed: false, reason: '5d flow<=0' };
  if (total20d <= 0) return { passed: false, reason: '20d flow<=0' };

  const flowRatio5d = total5d / avg20Value;
  const flowRatio20d = total20d / avg20Value;
  if (flowRatio5d < 0.3) return { passed: false, reason: 'flowRatio5d<0.3' };

  const netBuyDays5d = flow5.filter((r) => (r.foreignNetValue || 0) + (r.instNetValue || 0) > 0).length;
  const flowAcceleration = total20d > 0 ? (4 * total5d / total20d) : 0;
  const priceResponse = ret5d;
  const flowPriceDivergence = flowRatio5d - Math.max(ret5d, 0) * 5;

  // ─── 점수 ───
  // 1. 수급 강도 25점
  let flowStrengthScore = 0;
  if (flowRatio5d >= 1.5) flowStrengthScore = 25;
  else if (flowRatio5d >= 1.0) flowStrengthScore = 22;
  else if (flowRatio5d >= 0.7) flowStrengthScore = 18;
  else if (flowRatio5d >= 0.5) flowStrengthScore = 14;
  else flowStrengthScore = 10;

  // 2. 수급 지속성 20점 (netBuyDays5d 8 + flowRatio20d 6 + flowAcceleration 6)
  let flowPersistenceScore = 0;
  if (netBuyDays5d >= 5) flowPersistenceScore += 8;
  else if (netBuyDays5d >= 4) flowPersistenceScore += 6;
  else if (netBuyDays5d >= 3) flowPersistenceScore += 4;
  else if (netBuyDays5d >= 2) flowPersistenceScore += 2;
  if (flowRatio20d >= 2.0) flowPersistenceScore += 6;
  else if (flowRatio20d >= 1.0) flowPersistenceScore += 4;
  else if (flowRatio20d >= 0.5) flowPersistenceScore += 2;
  if (flowAcceleration >= 1.5) flowPersistenceScore += 6;
  else if (flowAcceleration >= 1.0) flowPersistenceScore += 4;
  else if (flowAcceleration >= 0.7) flowPersistenceScore += 2;
  flowPersistenceScore = Math.min(flowPersistenceScore, 20);

  // 3. 가격 미반응 20점 (ret5d 12 + ret20d 8, 8 중 +25~+35% 면 -2 penalty)
  let priceQuietScore = 0;
  if (ret5d <= 0.00) priceQuietScore += 12;
  else if (ret5d <= 0.03) priceQuietScore += 10;
  else if (ret5d <= 0.06) priceQuietScore += 7;
  else priceQuietScore += 4;
  if (ret20d >= -0.10 && ret20d <= 0.20) priceQuietScore += 8;
  else if (ret20d > 0.20 && ret20d <= 0.25) priceQuietScore += 4;
  else if (ret20d > 0.25 && ret20d <= 0.35) priceQuietScore -= 2;
  priceQuietScore = Math.max(0, Math.min(priceQuietScore, 20));

  // 4. 유동성 10점 — 5일 평균 / 60일 평균
  const last5rows = chartRows.slice(-5);
  const last60rows = chartRows.slice(-60);
  const avg5Value = last5rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last5rows.length, 1);
  const avg60Value = last60rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last60rows.length, 1);
  const valueExpansion = avg60Value > 0 ? avg5Value / avg60Value : 1;
  let liquidityScore = 0;
  if (valueExpansion >= 1.5) liquidityScore = 10;
  else if (valueExpansion >= 1.2) liquidityScore = 8;
  else if (valueExpansion >= 1.0) liquidityScore = 5;
  else if (valueExpansion >= 0.8) liquidityScore = 3;

  // 5. 차트 위치 10점
  let chartScore = 0;
  if (ma20 != null && close >= ma20) chartScore += 4;
  if (ma60 != null && close >= ma60) chartScore += 3;
  if (ma120 != null && close >= ma120) chartScore += 3;
  if (ma120 == null) {
    const ret60d = chartRows.length >= 61 ? (close / chartRows[chartRows.length - 61].close - 1) : 0;
    if (ret60d > -0.10) chartScore += 2;
  }
  chartScore = Math.min(chartScore, 10);

  // 6. 변동성 안정 10점 — ATR%
  let volScore = 0;
  if (atrPct < 0.03) volScore = 10;
  else if (atrPct < 0.05) volScore = 7;
  else if (atrPct < 0.08) volScore = 4;
  else if (atrPct < 0.12) volScore = 2;

  // 7. 리스크 차감 5점 — 최근 5일 중 최대 단일일 하락
  let worst1d = 0;
  for (let i = chartRows.length - 5; i < chartRows.length; i++) {
    if (i <= 0) continue;
    const r = chartRows[i].close / chartRows[i - 1].close - 1;
    if (r < worst1d) worst1d = r;
  }
  let riskScore = 0;
  if (worst1d >= -0.03) riskScore = 5;
  else if (worst1d >= -0.05) riskScore = 3;
  else if (worst1d >= -0.07) riskScore = 1;

  const score = flowStrengthScore + flowPersistenceScore + priceQuietScore
    + liquidityScore + chartScore + volScore + riskScore;

  return {
    passed: true,
    score,
    breakdown: { flowStrengthScore, flowPersistenceScore, priceQuietScore, liquidityScore, chartScore, volScore, riskScore },
    signals: {
      foreign5d, inst5d, total5d, foreign20d, inst20d, total20d,
      flowRatio5d, flowRatio20d, flowAcceleration,
      netBuyDays5d, priceResponse, flowPriceDivergence,
      ret5d, ret20d, atrPct,
      avg5Value, avg20Value, avg60Value, valueExpansion,
      ma20, ma60, ma120, worst1d,
    },
  };
}

// ─────────── FlowLead v3 — 수급+압축+지지+트리거 실험 모델 ───────────
//
// v2 결과: matched baseline 못 이김 (sideways 0/4), score 변별력 zero
// v3 가설: "수급 + 가격미반응" 단독으로는 부족, 거기에 변동성 수축 + 지지 유지
//          + 저항선 근접까지 다축 결합하면 d10/d20 우위 확보 가능
//
// compressionBaseline = v3 의 universe 통과 시점 (수급 조건 X) — 공정 비교용
function flowLeadV3CompressionUniverse(chartRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return { passed: false, reason: 'chart<60' };
  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return { passed: false, reason: 'close<=0' };

  if (meta.isSpecial || meta.isEtf) return { passed: false, reason: 'special/etf' };
  if ((meta.marketValue || 0) < 100_000_000_000) return { passed: false, reason: 'marketCap<1000억' };

  const last20rows = chartRows.slice(-20);
  const last5rows = chartRows.slice(-5);
  const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last20rows.length, 1);
  if (avg20Value < 5_000_000_000) return { passed: false, reason: 'avg20Value<50억' };

  const ret5d = chartRows.length >= 6 ? (close / chartRows[chartRows.length - 6].close - 1) : 0;
  const ret20d = chartRows.length >= 21 ? (close / chartRows[chartRows.length - 21].close - 1) : 0;
  if (ret5d > 0.12) return { passed: false, reason: 'ret5d>+12%' };
  if (ret5d < -0.12) return { passed: false, reason: 'ret5d<-12%' };
  if (ret20d > 0.25) return { passed: false, reason: 'ret20d>+25%' };
  if (ret20d < -0.25) return { passed: false, reason: 'ret20d<-25%' };

  const atrObj = computeATR(chartRows, idx, 14);
  if (!atrObj || !(atrObj.atr > 0) || !Number.isFinite(atrObj.atr)) return { passed: false, reason: 'ATR n/a' };
  const atrPct = atrObj.atr / close;
  if (atrPct > 0.20) return { passed: false, reason: 'ATR%>20' };

  // 구조 — MA fallback chain
  const ma20 = sma(last20rows.map((r) => r.close), 20);
  const ma60 = chartRows.length >= 60 ? sma(chartRows.slice(-60).map((r) => r.close), 60) : null;
  const ma120 = chartRows.length >= 120 ? sma(chartRows.slice(-120).map((r) => r.close), 120) : null;
  if (ma120 != null && ma120 > 0) {
    if (close / ma120 < 0.85) return { passed: false, reason: 'close/ma120<0.85' };
  } else if (ma60 != null && ma60 > 0) {
    if (close / ma60 < 0.80) return { passed: false, reason: 'close/ma60<0.80' };
  } else {
    const ret60d = chartRows.length >= 61 ? (close / chartRows[chartRows.length - 61].close - 1) : 0;
    if (ret60d < -0.30) return { passed: false, reason: 'ret60d<-30%' };
  }

  // 지지 유지: close ≥ ma20 × 0.95 OR close ≥ ma60 × 0.93
  const supports20 = ma20 != null && close >= ma20 * 0.95;
  const supports60 = ma60 != null && close >= ma60 * 0.93;
  if (!supports20 && !supports60) return { passed: false, reason: 'support broken' };

  // 변동성 수축: range5d 평균 < range20d 평균
  const rangeOf = (r) => (r.high && r.low && r.close) ? (r.high - r.low) / r.close : 0;
  const range5d = last5rows.reduce((s, r) => s + rangeOf(r), 0) / Math.max(last5rows.length, 1);
  const range20d = last20rows.reduce((s, r) => s + rangeOf(r), 0) / Math.max(last20rows.length, 1);
  if (!(range5d < range20d) || !(range20d > 0)) return { passed: false, reason: 'no compression' };

  // 20일 고점 거리
  const high20 = Math.max(...last20rows.map((r) => r.high || r.close));
  const distFromHigh = high20 > 0 ? (high20 - close) / high20 : 0;

  // 5d/20d 거래대금 비율
  const avg5Value = last5rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last5rows.length, 1);
  const valueExp5_20 = avg20Value > 0 ? avg5Value / avg20Value : 1;

  return {
    passed: true,
    avg20Value, avg5Value, valueExp5_20,
    ret5d, ret20d, atrPct,
    ma20, ma60, ma120, close,
    range5d, range20d, rangeRatio: range5d / range20d,
    high20, distFromHigh,
    supports20, supports60,
  };
}

function calculateFlowLeadScoreV3(chartRows, flowRows, meta = {}) {
  const u = flowLeadV3CompressionUniverse(chartRows, meta);
  if (!u.passed) return { passed: false, reason: u.reason };
  if (!flowRows || flowRows.length < 20) return { passed: false, reason: 'flow<20' };

  const {
    avg20Value, avg5Value, valueExp5_20,
    ret5d, ret20d, atrPct,
    ma20, ma60, ma120, close,
    rangeRatio, distFromHigh,
    supports20, supports60,
  } = u;

  const sumKey = (arr, k) => arr.reduce((s, r) => s + (r?.[k] || 0), 0);
  const flow5 = flowRows.slice(-5);
  const flow20 = flowRows.slice(-20);
  const foreign5d = sumKey(flow5, 'foreignNetValue');
  const inst5d = sumKey(flow5, 'instNetValue');
  const total5d = foreign5d + inst5d;
  const foreign20d = sumKey(flow20, 'foreignNetValue');
  const inst20d = sumKey(flow20, 'instNetValue');
  const total20d = foreign20d + inst20d;

  if (total5d <= 0) return { passed: false, reason: '5d flow<=0' };
  if (total20d <= 0) return { passed: false, reason: '20d flow<=0' };

  const flowRatio5d = total5d / avg20Value;
  const flowRatio20d = total20d / avg20Value;
  if (flowRatio5d < 0.3) return { passed: false, reason: 'flowRatio5d<0.3' };

  const netBuyDays5d = flow5.filter((r) => (r.foreignNetValue || 0) + (r.instNetValue || 0) > 0).length;
  if (netBuyDays5d < 2) return { passed: false, reason: 'netBuyDays5d<2' };
  const flowAcceleration = total20d > 0 ? (4 * total5d / total20d) : 0;

  // ─── 점수 ───
  // 1. 수급 지속성 25 (netBuyDays5d 10 + flowRatio20d 8 + flowAcceleration 7)
  let persistenceScore = 0;
  if (netBuyDays5d >= 5) persistenceScore += 10;
  else if (netBuyDays5d >= 4) persistenceScore += 8;
  else if (netBuyDays5d >= 3) persistenceScore += 6;
  else persistenceScore += 2;
  if (flowRatio20d >= 2.0) persistenceScore += 8;
  else if (flowRatio20d >= 1.0) persistenceScore += 5;
  else if (flowRatio20d >= 0.5) persistenceScore += 3;
  if (flowAcceleration >= 1.5) persistenceScore += 7;
  else if (flowAcceleration >= 1.0) persistenceScore += 5;
  else if (flowAcceleration >= 0.7) persistenceScore += 3;
  persistenceScore = Math.min(persistenceScore, 25);

  // 2. 수급 강도 20 (flowRatio5d)
  let strengthScore;
  if (flowRatio5d >= 1.5) strengthScore = 20;
  else if (flowRatio5d >= 1.0) strengthScore = 16;
  else if (flowRatio5d >= 0.7) strengthScore = 12;
  else if (flowRatio5d >= 0.5) strengthScore = 8;
  else strengthScore = 4;

  // 3. 가격 미반응 15 (ret5d 8 + ret20d 7)
  let priceQuietScore = 0;
  if (ret5d >= -0.03 && ret5d <= 0.07) priceQuietScore += 8;
  else if (ret5d >= -0.05 && ret5d <= 0.10) priceQuietScore += 5;
  else if (ret5d > 0.10 && ret5d <= 0.12) priceQuietScore += 2;
  if (ret20d >= -0.05 && ret20d <= 0.15) priceQuietScore += 7;
  else if (ret20d > 0.15 && ret20d <= 0.25) priceQuietScore += 3;
  else if (ret20d < -0.05 && ret20d >= -0.10) priceQuietScore += 4;
  priceQuietScore = Math.max(0, Math.min(priceQuietScore, 15));

  // 4. 거래대금 증가 10
  let liquidityScore;
  if (valueExp5_20 >= 1.5) liquidityScore = 10;
  else if (valueExp5_20 >= 1.2) liquidityScore = 8;
  else if (valueExp5_20 >= 1.0) liquidityScore = 5;
  else if (valueExp5_20 >= 0.8) liquidityScore = 3;
  else liquidityScore = 0;

  // 5. 지지 유지 10
  let supportScore = 0;
  if (supports20 && supports60) supportScore = 9;
  else if (supports20) supportScore = 6;
  else if (supports60) supportScore = 4;
  if (ma120 != null && close >= ma120) supportScore = Math.min(10, supportScore + 1);

  // 6. 변동성 수축 10 (rangeRatio 6 + ATR% 4)
  let compressionScore = 0;
  if (rangeRatio <= 0.6) compressionScore += 6;
  else if (rangeRatio <= 0.8) compressionScore += 4;
  else if (rangeRatio < 1.0) compressionScore += 2;
  if (atrPct < 0.04) compressionScore += 4;
  else if (atrPct < 0.08) compressionScore += 2;
  else if (atrPct > 0.16) compressionScore -= 2;
  compressionScore = Math.max(0, Math.min(compressionScore, 10));

  // 7. 저항선 근접 5
  let triggerScore = 0;
  if (distFromHigh <= 0.03) triggerScore = 5;
  else if (distFromHigh <= 0.05) triggerScore = 4;
  else if (distFromHigh <= 0.08) triggerScore = 2;

  // 8. 리스크 차감 5
  let worst1d = 0;
  for (let i = chartRows.length - 5; i < chartRows.length; i++) {
    if (i <= 0) continue;
    const r = chartRows[i].close / chartRows[i - 1].close - 1;
    if (r < worst1d) worst1d = r;
  }
  let riskScore = 0;
  if (worst1d >= -0.03) riskScore = 5;
  else if (worst1d >= -0.05) riskScore = 3;
  else if (worst1d >= -0.07) riskScore = 1;
  if (atrPct > 0.16) riskScore = Math.max(0, riskScore - 2);

  const score = persistenceScore + strengthScore + priceQuietScore + liquidityScore
    + supportScore + compressionScore + triggerScore + riskScore;

  const stage = {
    flowDetected: flowRatio5d >= 0.3,
    flowSustained: netBuyDays5d >= 3 && flowRatio20d >= 0.5,
    priceCompressed: rangeRatio <= 0.7,
    triggerReady: distFromHigh <= 0.05,
  };

  return {
    passed: true,
    score,
    breakdown: { persistenceScore, strengthScore, priceQuietScore, liquidityScore, supportScore, compressionScore, triggerScore, riskScore },
    stage,
    signals: {
      foreign5d, inst5d, total5d, foreign20d, inst20d, total20d,
      flowRatio5d, flowRatio20d, flowAcceleration,
      netBuyDays5d, ret5d, ret20d, atrPct,
      avg5Value, avg20Value, valueExp5_20,
      ma20, ma60, ma120, rangeRatio, distFromHigh,
      worst1d, supports20, supports60,
    },
  };
}

// ─────────── FlowLead v4 — Ignition (수급 + 가격 막 움직임 시작) ───────────
//
// v3 결론: 수급 시그널이 후행 — 같은 압축 universe 에서 수급 추가 시 오히려 ↓
// v4 가설: 가격이 0~+5% 막 움직이기 시작한 순간이 진짜 ignition. 거기에 수급 양수면 추가 알파.
//
// v3 universe 그대로 통과 + ret5d 0%~+5% 만 추가 hard reject
// ignitionBaseline = v4 universe 통과 시점 (수급 조건 X) — 공정 비교용
function flowLeadV4IgnitionUniverse(chartRows, meta = {}) {
  const v3 = flowLeadV3CompressionUniverse(chartRows, meta);
  if (!v3.passed) return v3;
  const { ret5d } = v3;
  if (ret5d < 0) return { passed: false, reason: 'ret5d<0%' };
  if (ret5d > 0.05) return { passed: false, reason: 'ret5d>+5%' };
  return v3;
}

function calculateFlowLeadScoreV4(chartRows, flowRows, meta = {}) {
  const u = flowLeadV4IgnitionUniverse(chartRows, meta);
  if (!u.passed) return { passed: false, reason: u.reason };
  if (!flowRows || flowRows.length < 20) return { passed: false, reason: 'flow<20' };

  const {
    avg20Value, avg5Value, valueExp5_20,
    ret5d, ret20d, atrPct,
    ma20, ma60, ma120, close,
    rangeRatio, distFromHigh,
    supports20, supports60,
  } = u;

  const sumKey = (arr, k) => arr.reduce((s, r) => s + (r?.[k] || 0), 0);
  const flow5 = flowRows.slice(-5);
  const flow20 = flowRows.slice(-20);
  const foreign5d = sumKey(flow5, 'foreignNetValue');
  const inst5d = sumKey(flow5, 'instNetValue');
  const total5d = foreign5d + inst5d;
  const foreign20d = sumKey(flow20, 'foreignNetValue');
  const inst20d = sumKey(flow20, 'instNetValue');
  const total20d = foreign20d + inst20d;

  if (total5d <= 0) return { passed: false, reason: '5d flow<=0' };
  if (total20d <= 0) return { passed: false, reason: '20d flow<=0' };

  const flowRatio5d = total5d / avg20Value;
  const flowRatio20d = total20d / avg20Value;
  if (flowRatio5d < 0.3) return { passed: false, reason: 'flowRatio5d<0.3' };

  const netBuyDays5d = flow5.filter((r) => (r.foreignNetValue || 0) + (r.instNetValue || 0) > 0).length;
  if (netBuyDays5d < 2) return { passed: false, reason: 'netBuyDays5d<2' };
  const flowAcceleration = total20d > 0 ? (4 * total5d / total20d) : 0;

  // 점수 — v3 와 동일하되 priceQuietScore 만 0~+5% 분포에 맞게 재조정
  let persistenceScore = 0;
  if (netBuyDays5d >= 5) persistenceScore += 10;
  else if (netBuyDays5d >= 4) persistenceScore += 8;
  else if (netBuyDays5d >= 3) persistenceScore += 6;
  else persistenceScore += 2;
  if (flowRatio20d >= 2.0) persistenceScore += 8;
  else if (flowRatio20d >= 1.0) persistenceScore += 5;
  else if (flowRatio20d >= 0.5) persistenceScore += 3;
  if (flowAcceleration >= 1.5) persistenceScore += 7;
  else if (flowAcceleration >= 1.0) persistenceScore += 5;
  else if (flowAcceleration >= 0.7) persistenceScore += 3;
  persistenceScore = Math.min(persistenceScore, 25);

  let strengthScore;
  if (flowRatio5d >= 1.5) strengthScore = 20;
  else if (flowRatio5d >= 1.0) strengthScore = 16;
  else if (flowRatio5d >= 0.7) strengthScore = 12;
  else if (flowRatio5d >= 0.5) strengthScore = 8;
  else strengthScore = 4;

  // v4 의 priceIgnitionScore 15: ret5d 가 0~+1.5% 가장 선호 (= 막 움직임 시작), 3~5% 는 살짝 차감
  let priceIgnitionScore = 0;
  if (ret5d >= 0 && ret5d <= 0.015) priceIgnitionScore += 8;
  else if (ret5d > 0.015 && ret5d <= 0.03) priceIgnitionScore += 6;
  else if (ret5d > 0.03 && ret5d <= 0.05) priceIgnitionScore += 3;
  if (ret20d >= -0.05 && ret20d <= 0.15) priceIgnitionScore += 7;
  else if (ret20d > 0.15 && ret20d <= 0.25) priceIgnitionScore += 3;
  else if (ret20d < -0.05 && ret20d >= -0.10) priceIgnitionScore += 4;
  priceIgnitionScore = Math.max(0, Math.min(priceIgnitionScore, 15));

  let liquidityScore;
  if (valueExp5_20 >= 1.5) liquidityScore = 10;
  else if (valueExp5_20 >= 1.2) liquidityScore = 8;
  else if (valueExp5_20 >= 1.0) liquidityScore = 5;
  else if (valueExp5_20 >= 0.8) liquidityScore = 3;
  else liquidityScore = 0;

  let supportScore = 0;
  if (supports20 && supports60) supportScore = 9;
  else if (supports20) supportScore = 6;
  else if (supports60) supportScore = 4;
  if (ma120 != null && close >= ma120) supportScore = Math.min(10, supportScore + 1);

  let compressionScore = 0;
  if (rangeRatio <= 0.6) compressionScore += 6;
  else if (rangeRatio <= 0.8) compressionScore += 4;
  else if (rangeRatio < 1.0) compressionScore += 2;
  if (atrPct < 0.04) compressionScore += 4;
  else if (atrPct < 0.08) compressionScore += 2;
  else if (atrPct > 0.16) compressionScore -= 2;
  compressionScore = Math.max(0, Math.min(compressionScore, 10));

  let triggerScore = 0;
  if (distFromHigh <= 0.03) triggerScore = 5;
  else if (distFromHigh <= 0.05) triggerScore = 4;
  else if (distFromHigh <= 0.08) triggerScore = 2;

  let worst1d = 0;
  for (let i = chartRows.length - 5; i < chartRows.length; i++) {
    if (i <= 0) continue;
    const r = chartRows[i].close / chartRows[i - 1].close - 1;
    if (r < worst1d) worst1d = r;
  }
  let riskScore = 0;
  if (worst1d >= -0.03) riskScore = 5;
  else if (worst1d >= -0.05) riskScore = 3;
  else if (worst1d >= -0.07) riskScore = 1;
  if (atrPct > 0.16) riskScore = Math.max(0, riskScore - 2);

  const score = persistenceScore + strengthScore + priceIgnitionScore + liquidityScore
    + supportScore + compressionScore + triggerScore + riskScore;

  return {
    passed: true,
    score,
    breakdown: { persistenceScore, strengthScore, priceIgnitionScore, liquidityScore, supportScore, compressionScore, triggerScore, riskScore },
    signals: {
      foreign5d, inst5d, total5d, foreign20d, inst20d, total20d,
      flowRatio5d, flowRatio20d, flowAcceleration,
      netBuyDays5d, ret5d, ret20d, atrPct,
      avg5Value, avg20Value, valueExp5_20,
      ma20, ma60, ma120, rangeRatio, distFromHigh,
      worst1d, supports20, supports60,
    },
  };
}

// ─────────── CompressionSupportBreakout — "상승 전 압축 후보" ───────────
//
// 사용자 spec (B+C+D 결합):
//   - 시총 500억+
//   - 점수보다 stage tag 중심 (UI)
//   - sweet spot 점수 (compressionRatio 0.55~0.75 최고, valueRatio 1.1~1.8 최고, distHigh20 2~8% 최고)
//   - 수급은 보조 가점 5점만
//
// 시그니처: calculateCompressionSupportBreakoutScore(rows, flowRows, meta, idx)
// 반환: { passed, score, bucket, displayGrade, stages, tags, warnings, rejectReason, metrics, breakdown }
function calculateCompressionSupportBreakoutScore(rows, flowRows, meta = {}, idx = null) {
  if (!rows || !rows.length) return { passed: false, rejectReason: 'no rows' };
  if (idx == null) idx = rows.length - 1;
  if (idx < 60) return { passed: false, rejectReason: 'idx<60' };

  const today = rows[idx];
  const close = today?.close;
  if (!close || close <= 0) return { passed: false, rejectReason: 'close<=0' };

  // ─── Hard reject (universe) ───
  if (meta.isSpecial || meta.isEtf) return { passed: false, rejectReason: 'special/etf' };
  if ((meta.marketValue || 0) < 50_000_000_000) return { passed: false, rejectReason: 'marketCap<500억' };

  const last20rows = []; for (let i = Math.max(0, idx - 19); i <= idx; i++) last20rows.push(rows[i]);
  const last5rows  = []; for (let i = Math.max(0, idx - 4);  i <= idx; i++) last5rows.push(rows[i]);
  const last60rows = []; for (let i = Math.max(0, idx - 59); i <= idx; i++) last60rows.push(rows[i]);

  const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last20rows.length, 1);
  if (avg20Value < 5_000_000_000) return { passed: false, rejectReason: 'avg20Value<50억' };

  const ret5d = idx >= 5 ? (close / rows[idx - 5].close - 1) : 0;
  const ret20d = idx >= 20 ? (close / rows[idx - 20].close - 1) : 0;
  if (ret5d > 0.12) return { passed: false, rejectReason: 'ret5d>+12%' };
  if (ret20d > 0.30) return { passed: false, rejectReason: 'ret20d>+30%' };
  if (ret20d < -0.25) return { passed: false, rejectReason: 'ret20d<-25%' };

  const atrObj = computeATR(rows, idx, 14);
  if (!atrObj || !(atrObj.atr > 0) || !Number.isFinite(atrObj.atr)) return { passed: false, rejectReason: 'ATR n/a' };
  const atrPct = atrObj.atr / close;
  if (atrPct > 0.20) return { passed: false, rejectReason: 'ATR%>20' };

  // MA fallback chain
  const ma20 = sma(last20rows.map((r) => r.close), 20);
  const ma60 = idx >= 59 ? sma(last60rows.map((r) => r.close), 60) : null;
  let ma120 = null;
  if (idx >= 119) {
    const arr120 = []; for (let i = idx - 119; i <= idx; i++) arr120.push(rows[i].close);
    ma120 = sma(arr120, 120);
  }
  if (ma120 != null && ma120 > 0) {
    if (close / ma120 < 0.85) return { passed: false, rejectReason: 'close/ma120<0.85' };
  } else if (ma60 != null && ma60 > 0) {
    if (close / ma60 < 0.80) return { passed: false, rejectReason: 'close/ma60<0.80' };
  } else {
    const ret60d = idx >= 60 ? (close / rows[idx - 60].close - 1) : 0;
    if (ret60d < -0.30) return { passed: false, rejectReason: 'ret60d<-30%' };
  }

  // ─── Metrics ───
  const trueRange = (i) => {
    const r = rows[i];
    if (!r || !r.high || !r.low || !r.close) return 0;
    const prev = i > 0 ? rows[i - 1] : null;
    if (!prev || !prev.close) return (r.high - r.low) / r.close;
    const tr = Math.max(r.high - r.low, Math.abs(r.high - prev.close), Math.abs(r.low - prev.close));
    return tr / r.close;
  };
  let tr5sum = 0, tr5n = 0, tr20sum = 0, tr20n = 0;
  for (let i = Math.max(0, idx - 4);  i <= idx; i++) { tr5sum  += trueRange(i); tr5n++; }
  for (let i = Math.max(0, idx - 19); i <= idx; i++) { tr20sum += trueRange(i); tr20n++; }
  const tr5avg = tr5n > 0 ? tr5sum / tr5n : 0;
  const tr20avg = tr20n > 0 ? tr20sum / tr20n : 0;
  const compressionRatio = tr20avg > 0 ? tr5avg / tr20avg : null;

  const avg5Value = last5rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last5rows.length, 1);
  const valueRatio5d20d = avg20Value > 0 ? avg5Value / avg20Value : 0;

  const high20 = Math.max(...last20rows.map((r) => r.high || r.close));
  const high60 = Math.max(...last60rows.map((r) => r.high || r.close));
  const distFromHigh20 = high20 > 0 ? (high20 - close) / high20 : 1;
  const distFromHigh60 = high60 > 0 ? (high60 - close) / high60 : 1;

  const supports20 = ma20 != null && close >= ma20 * 0.97;
  const supports60 = ma60 != null && close >= ma60 * 0.95;
  const low5 = Math.min(...last5rows.map((r) => r.low || r.close));
  const low20 = Math.min(...last20rows.map((r) => r.low || r.close));

  let worst1d = 0;
  for (let i = Math.max(1, idx - 4); i <= idx; i++) {
    const r = rows[i].close / rows[i - 1].close - 1;
    if (r < worst1d) worst1d = r;
  }

  // ─── Sweet-spot 점수 ───

  // 1. 적정 압축 25
  let compressionScore = 0;
  if (compressionRatio != null) {
    if (compressionRatio >= 0.55 && compressionRatio <= 0.75) compressionScore = 25;
    else if (compressionRatio > 0.75 && compressionRatio <= 0.90) compressionScore = 18;
    else if (compressionRatio > 0.90 && compressionRatio <= 1.00) compressionScore = 10;
    else if (compressionRatio >= 0.40 && compressionRatio < 0.55) compressionScore = 8;
    else compressionScore = 0;
  }

  // 2. 지지 유지 20
  let supportScore = 0;
  if (supports20 && supports60) supportScore = 14;
  else if (supports20) supportScore = 10;
  else if (supports60) supportScore = 7;
  if (ma20 != null && ma20 > 0) {
    const dev = close / ma20;
    if (dev >= 0.99 && dev <= 1.03) supportScore += 4;
    else if (dev >= 0.97 && dev <= 1.05) supportScore += 2;
  }
  if (low5 >= low20) supportScore += 2;
  supportScore = Math.min(supportScore, 20);

  // 3. 돌파 대기 위치 20 — 2~8% 최고, 0~2% 양호, 8~12% 보통, >12% 감점
  let breakoutScore = 0;
  if (distFromHigh20 >= 0.02 && distFromHigh20 <= 0.08) breakoutScore += 12;
  else if (distFromHigh20 >= 0 && distFromHigh20 < 0.02) breakoutScore += 8;
  else if (distFromHigh20 > 0.08 && distFromHigh20 <= 0.12) breakoutScore += 5;
  else breakoutScore -= 2;
  if (distFromHigh60 <= 0.05) breakoutScore += 8;
  else if (distFromHigh60 <= 0.08) breakoutScore += 5;
  else if (distFromHigh60 <= 0.12) breakoutScore += 2;
  breakoutScore = Math.max(0, Math.min(breakoutScore, 20));

  // 4. 거래대금 재활성 15 — 1.1~1.8 최고, 1.8~2.5 감점, >2.5 / <0.8 = 0
  let liquidityScore = 0;
  if (valueRatio5d20d >= 1.1 && valueRatio5d20d <= 1.8) liquidityScore = 15;
  else if (valueRatio5d20d >= 1.0 && valueRatio5d20d < 1.1) liquidityScore = 10;
  else if (valueRatio5d20d >= 0.8 && valueRatio5d20d < 1.0) liquidityScore = 5;
  else if (valueRatio5d20d > 1.8 && valueRatio5d20d <= 2.5) liquidityScore = 8;
  else liquidityScore = 0;

  // 5. 과열 회피 10
  let overheatScore = 0;
  if (ret5d >= -0.03 && ret5d <= 0.04) overheatScore += 6;
  else if (ret5d > 0.04 && ret5d <= 0.06) overheatScore += 4;
  else if (ret5d > 0.06 && ret5d <= 0.08) overheatScore += 2;
  if (ret20d >= -0.05 && ret20d <= 0.10) overheatScore += 4;
  else if (ret20d > 0.10 && ret20d <= 0.15) overheatScore += 2;
  overheatScore = Math.min(overheatScore, 10);

  // 6. 리스크 안정 5
  let riskScore = 0;
  if (atrPct < 0.04) riskScore += 3;
  else if (atrPct < 0.08) riskScore += 2;
  else if (atrPct > 0.16) riskScore -= 1;
  if (worst1d >= -0.03) riskScore += 2;
  else if (worst1d >= -0.05) riskScore += 1;
  riskScore = Math.max(0, Math.min(riskScore, 5));

  // 7. 수급 보조 5
  let flowBonusScore = 0;
  let flowSignals = null;
  if (flowRows && flowRows.length >= 20) {
    const sumKey = (arr, k) => arr.reduce((s, r) => s + (r?.[k] || 0), 0);
    const flow5 = flowRows.slice(-5);
    const flow20 = flowRows.slice(-20);
    const total5d = sumKey(flow5, 'foreignNetValue') + sumKey(flow5, 'instNetValue');
    const total20d = sumKey(flow20, 'foreignNetValue') + sumKey(flow20, 'instNetValue');
    const flowRatio5d = avg20Value > 0 ? total5d / avg20Value : 0;
    const netBuyDays5d = flow5.filter((r) => (r.foreignNetValue || 0) + (r.instNetValue || 0) > 0).length;
    if (total5d > 0) flowBonusScore += 2;
    if (netBuyDays5d >= 3) flowBonusScore += 2;
    if (flowRatio5d >= 0.3) flowBonusScore += 1;
    flowBonusScore = Math.min(flowBonusScore, 5);
    flowSignals = { total5d, total20d, flowRatio5d, netBuyDays5d };
  }

  const score = compressionScore + supportScore + breakoutScore + liquidityScore
    + overheatScore + riskScore + flowBonusScore;

  // bucket / displayGrade
  let bucket, displayGrade;
  if (score >= 70) { bucket = '70+'; displayGrade = '준비'; }
  else if (score >= 60) { bucket = '60-69'; displayGrade = '진행'; }
  else if (score >= 50) { bucket = '50-59'; displayGrade = '초기'; }
  else { bucket = '<50'; displayGrade = '관찰'; }

  // stages + tags
  const stages = {
    compressionFormed: compressionRatio != null && compressionRatio >= 0.40 && compressionRatio <= 0.75,
    supportConfirmed: supports20 && low5 >= low20 * 0.99,
    breakoutReady: distFromHigh20 <= 0.05,
    volumeReturning: valueRatio5d20d >= 1.1,
  };
  const tags = [];
  if (stages.compressionFormed) tags.push('압축 형성');
  if (stages.supportConfirmed) tags.push('지지 확인');
  if (stages.breakoutReady) tags.push('돌파 대기');
  if (stages.volumeReturning) tags.push('거래대금 재활성');

  // warnings
  const warnings = [];
  if ((meta.marketValue || 0) >= 50_000_000_000 && (meta.marketValue || 0) < 100_000_000_000) {
    warnings.push('시총 1,000억 미만 중소형 구간');
  }
  if (atrPct > 0.16) warnings.push('고변동성 (ATR% > 16)');
  if (worst1d <= -0.05) warnings.push('최근 5일 단일일 -5% 이상 하락');

  // prevHigh — 매매 계획용 (전일 고가)
  const prevHigh = idx > 0 ? (rows[idx - 1].high || rows[idx - 1].close) : null;

  const metrics = {
    close, ret5d, ret20d, atrPct,
    avg5Value, avg20Value, valueRatio5d20d,
    ma20, ma60, ma120,
    tr5avg, tr20avg, compressionRatio,
    high20, high60, prevHigh, distFromHigh20, distFromHigh60,
    supports20, supports60, low5, low20, worst1d,
    flow: flowSignals,
  };
  const breakdown = {
    compressionScore, supportScore, breakoutScore, liquidityScore,
    overheatScore, riskScore, flowBonusScore,
  };

  return {
    passed: true,
    score,
    bucket,
    displayGrade,
    stages,
    tags,
    warnings,
    rejectReason: null,
    metrics,
    breakdown,
  };
}

// universe wrapper (백테스트의 compressionBaseline 비교 등 효율성을 위해)
function compressionSupportBreakoutUniverse(rows, meta = {}, idx = null) {
  const r = calculateCompressionSupportBreakoutScore(rows, [], meta, idx);
  return { passed: r.passed, reason: r.rejectReason };
}

// CSB 매매 계획 가이드 — Dc 룰 기반 (관찰가 / 확인 진입 / 종가 손절 / 1차·2차 목표 / 손익비)
// 표현 규칙: 매수/매도 추천 X, "관찰 / 확인 / 손절 / 목표 구간"으로만.
function buildCsbTradePlan(metrics, currentPrice) {
  if (!metrics || !currentPrice) return null;
  const high20 = metrics.high20 || null;
  const prevHigh = metrics.prevHigh || null;
  const atrPct = metrics.atrPct || null;

  // 확인 진입가 = max(전일 고가, 20일 고점) × 1.003 (+0.3% 여유)
  let triggerPrice = null;
  let triggerSource = null;
  if (high20 || prevHigh) {
    const ref = Math.max(high20 || 0, prevHigh || 0);
    triggerPrice = Math.round(ref * 1.003);
    if (high20 && (!prevHigh || high20 >= prevHigh)) triggerSource = '20일 고점 +0.3%';
    else triggerSource = '전일 고가 +0.3%';
  } else if (currentPrice > 0) {
    // fallback — 현재가 +1%
    triggerPrice = Math.round(currentPrice * 1.01);
    triggerSource = '20일 고점 돌파 시 (현재가 +1% 임시 추정)';
  }
  if (!triggerPrice) return null;

  // 손절폭 = clamp(ATR%×2.5, 8%, 12%), atrPct 없으면 10%
  const stopPct = atrPct
    ? Math.max(0.08, Math.min(0.12, atrPct * 2.5))
    : 0.10;
  const stopPrice = Math.round(triggerPrice * (1 - stopPct));

  const target1 = Math.round(triggerPrice * 1.10);
  const target2 = Math.round(triggerPrice * 1.20);

  const risk = triggerPrice - stopPrice;
  const rr1 = risk > 0 ? +((target1 - triggerPrice) / risk).toFixed(2) : null;
  const rr2 = risk > 0 ? +((target2 - triggerPrice) / risk).toFixed(2) : null;

  return {
    observePrice: Math.round(currentPrice),
    triggerPrice,
    triggerSource,
    stopPct: +(stopPct * 100).toFixed(1),
    stopPrice,
    stopBasis: '종가 기준',
    target1,
    target2,
    rr1, rr2,
    horizon: '20~40거래일 관찰',
  };
}

// ─────────── CSB v2 — 조건 완화 + sweet spot 점수 + 시총 500억 universe ───────────
//
// v1 결론: n=277 너무 작음 + 점수 70+ 가 최악 (역방향)
// v2 변경:
//   - 시총 500억+ (v1 1000억)
//   - 압축 ≤0.9 (v1 0.8)
//   - 거래대금 ≥1.0 (v1 1.1)
//   - 20일 고점 거리 ≤10% (v1 8%)
//   - 압축 <0.40 reject (너무 죽음)
//   - 점수: 모든 sub-score sweet spot 방식
function compressionSupportBreakoutUniverseV2(chartRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return { passed: false, reason: 'chart<60' };
  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return { passed: false, reason: 'close<=0' };

  if (meta.isSpecial || meta.isEtf) return { passed: false, reason: 'special/etf' };
  if ((meta.marketValue || 0) < 50_000_000_000) return { passed: false, reason: 'marketCap<500억' };

  const last20rows = chartRows.slice(-20);
  const last5rows = chartRows.slice(-5);
  const last60rows = chartRows.slice(-60);
  const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last20rows.length, 1);
  if (avg20Value < 5_000_000_000) return { passed: false, reason: 'avg20Value<50억' };

  const ret5d = chartRows.length >= 6 ? (close / chartRows[chartRows.length - 6].close - 1) : 0;
  const ret20d = chartRows.length >= 21 ? (close / chartRows[chartRows.length - 21].close - 1) : 0;
  if (ret5d < -0.03 || ret5d > 0.08) return { passed: false, reason: 'ret5d out' };
  if (ret20d < -0.05 || ret20d > 0.18) return { passed: false, reason: 'ret20d out' };
  if (ret5d > 0.12 || ret20d > 0.30) return { passed: false, reason: 'overheat guard' };

  const atrObj = computeATR(chartRows, idx, 14);
  if (!atrObj || !(atrObj.atr > 0) || !Number.isFinite(atrObj.atr)) return { passed: false, reason: 'ATR n/a' };
  const atrPct = atrObj.atr / close;
  if (atrPct > 0.20) return { passed: false, reason: 'ATR%>20' };

  const ma20 = sma(last20rows.map((r) => r.close), 20);
  const ma60 = chartRows.length >= 60 ? sma(last60rows.map((r) => r.close), 60) : null;
  const ma120 = chartRows.length >= 120 ? sma(chartRows.slice(-120).map((r) => r.close), 120) : null;
  if (ma120 != null && ma120 > 0) {
    if (close / ma120 < 0.85) return { passed: false, reason: 'close/ma120<0.85' };
  } else if (ma60 != null && ma60 > 0) {
    if (close / ma60 < 0.80) return { passed: false, reason: 'close/ma60<0.80' };
  } else {
    const ret60d = chartRows.length >= 61 ? (close / chartRows[chartRows.length - 61].close - 1) : 0;
    if (ret60d < -0.30) return { passed: false, reason: 'ret60d<-30%' };
  }

  if (ma20 != null && ma20 > 0 && (close / ma20 - 1) > 0.20) {
    return { passed: false, reason: 'ma20 dev>+20%' };
  }

  // 압축 — v2: ≤0.9 통과, <0.40 reject (너무 죽음)
  const trueRange = (i) => {
    const r = chartRows[i];
    if (!r || !r.high || !r.low || !r.close) return 0;
    const prev = i > 0 ? chartRows[i - 1] : null;
    if (!prev || !prev.close) return (r.high - r.low) / r.close;
    const tr = Math.max(r.high - r.low, Math.abs(r.high - prev.close), Math.abs(r.low - prev.close));
    return tr / r.close;
  };
  let tr5sum = 0, tr5n = 0, tr20sum = 0, tr20n = 0;
  for (let i = chartRows.length - 5; i < chartRows.length; i++) { if (i >= 0) { tr5sum += trueRange(i); tr5n++; } }
  for (let i = chartRows.length - 20; i < chartRows.length; i++) { if (i >= 0) { tr20sum += trueRange(i); tr20n++; } }
  const tr5avg = tr5n > 0 ? tr5sum / tr5n : 0;
  const tr20avg = tr20n > 0 ? tr20sum / tr20n : 0;
  if (!(tr20avg > 0)) return { passed: false, reason: 'tr20=0' };
  const compressionRatio = tr5avg / tr20avg;
  if (compressionRatio > 0.9) return { passed: false, reason: 'compRatio>0.9' };
  if (compressionRatio < 0.40) return { passed: false, reason: 'compRatio<0.40 (too dead)' };

  // 지지 (동일)
  const supports20 = ma20 != null && close >= ma20 * 0.97;
  const supports60 = ma60 != null && close >= ma60 * 0.95;
  if (!supports20 && !supports60) return { passed: false, reason: 'support broken' };
  const low5 = Math.min(...last5rows.map((r) => r.low || r.close));
  const low20 = Math.min(...last20rows.map((r) => r.low || r.close));
  if (low5 < low20 * 0.99) return { passed: false, reason: '5d low broke 20d low' };

  // 돌파 대기 — v2: 10% 까지
  const high20 = Math.max(...last20rows.map((r) => r.high || r.close));
  const high60 = Math.max(...last60rows.map((r) => r.high || r.close));
  const distFromHigh20 = high20 > 0 ? (high20 - close) / high20 : 1;
  const distFromHigh60 = high60 > 0 ? (high60 - close) / high60 : 1;
  if (!(distFromHigh20 <= 0.10 || distFromHigh60 <= 0.12)) return { passed: false, reason: 'too far from high' };

  // 거래대금 재증가 — v2: ≥1.0
  const avg5Value = last5rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last5rows.length, 1);
  const valueExp5_20 = avg20Value > 0 ? avg5Value / avg20Value : 1;
  if (valueExp5_20 < 1.0) return { passed: false, reason: 'vol5/20<1.0' };

  return {
    passed: true,
    avg20Value, avg5Value, valueExp5_20,
    ret5d, ret20d, atrPct,
    ma20, ma60, ma120, close,
    tr5avg, tr20avg, compressionRatio,
    high20, high60, distFromHigh20, distFromHigh60,
    supports20, supports60, low5, low20,
  };
}

// ─────────── 중소형 CSB-Lite (500억~3000억) ───────────
// 시총별 compressionRatio p50 임계값 (상수 → 나중에 동적 계산으로 전환 가능)
const SMALL_CAP_COMPRESSION_THRESHOLDS = {
  cap500to1000: 0.6071,   // 500억~1000억
  cap1000to2000: 0.5977,  // 1000억~2000억
  cap2000to3000: 0.5920,  // 2000억~3000억
};

function calculateSmallCapCSB(rows, flowRows, meta = {}, idx = null) {
  if (!rows || !rows.length) return { passed: false, rejectReason: 'no rows' };
  if (idx == null) idx = rows.length - 1;
  if (idx < 60) return { passed: false, rejectReason: 'idx<60' };

  const today = rows[idx];
  const close = today?.close;
  if (!close || close <= 0) return { passed: false, rejectReason: 'close<=0' };

  // 시총 필터: 500억 이상 3000억 미만 (1조 미만 범위로 수정)
  const cap = meta.marketValue || 0;
  if (cap < 50_000_000_000) return { passed: false, rejectReason: 'cap<500억' };
  if (cap >= 300_000_000_000) return { passed: false, rejectReason: 'cap>=3000억' };

  // capBucket 결정 — 압축 임계값 선택용
  let capBucket;
  let compressionThreshold;
  if (cap >= 50_000_000_000 && cap < 100_000_000_000) {
    capBucket = 'cap500to1000';
    compressionThreshold = SMALL_CAP_COMPRESSION_THRESHOLDS.cap500to1000;
  } else if (cap >= 100_000_000_000 && cap < 200_000_000_000) {
    capBucket = 'cap1000to2000';
    compressionThreshold = SMALL_CAP_COMPRESSION_THRESHOLDS.cap1000to2000;
  } else if (cap >= 200_000_000_000 && cap < 300_000_000_000) {
    capBucket = 'cap2000to3000';
    compressionThreshold = SMALL_CAP_COMPRESSION_THRESHOLDS.cap2000to3000;
  } else {
    return { passed: false, rejectReason: 'invalid capBucket' };
  }

  // 20일 평균 거래대금 50억 이상
  const last20rows = [];
  for (let i = Math.max(0, idx - 19); i <= idx; i++) last20rows.push(rows[i]);
  const last5rows = [];
  for (let i = Math.max(0, idx - 4); i <= idx; i++) last5rows.push(rows[i]);
  const last60rows = [];
  for (let i = Math.max(0, idx - 59); i <= idx; i++) last60rows.push(rows[i]);

  const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last20rows.length, 1);
  if (avg20Value < 5_000_000_000) return { passed: false, rejectReason: 'avg20Value<50억' };

  // ret5d <= +15%, ret20d <= +35%
  const ret5d = idx >= 5 ? (close / rows[idx - 5].close - 1) : 0;
  const ret20d = idx >= 20 ? (close / rows[idx - 20].close - 1) : 0;
  if (ret5d > 0.15) return { passed: false, rejectReason: 'ret5d>+15%' };
  if (ret20d > 0.35) return { passed: false, rejectReason: 'ret20d>+35%' };

  // ATR% <= 25%
  const atrObj = computeATR(rows, idx, 14);
  if (!atrObj || !(atrObj.atr > 0)) return { passed: false, rejectReason: 'ATR n/a' };
  const atrPct = atrObj.atr / close;
  if (atrPct > 0.25) return { passed: false, rejectReason: 'ATR%>25' };

  // 20일선, 60일선 안정성
  const ma20 = sma(last20rows.map((r) => r.close), 20);
  const ma60 = idx >= 59 ? sma(last60rows.map((r) => r.close), 60) : null;

  // 지지 확인: 현재가 >= 20일선 * 0.95 OR 60일선 * 0.92
  const supportFrom20 = ma20 > 0 && close >= ma20 * 0.95;
  const supportFrom60 = ma60 > 0 && close >= ma60 * 0.92;
  const supportConfirmed = supportFrom20 || supportFrom60;
  if (!supportConfirmed) return { passed: false, rejectReason: 'no support' };

  // 거래대금 재활성: valueRatio5d20d >= 0.9
  const avg5Value = last5rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last5rows.length, 1);
  const valueRatio5d20d = avg20Value > 0 ? avg5Value / avg20Value : 0;
  if (valueRatio5d20d < 0.9) return { passed: false, rejectReason: 'valueRatio<0.9' };

  // 압축 형성: 시총별 p50 기준 (상위 50% 압축 상태 = 높은 compressionRatio)
  const last20high = Math.max(...last20rows.map((r) => r.high || r.close));
  const last20low = Math.min(...last20rows.map((r) => r.low || r.close));
  const compressionRatio = last20high > 0 ? last20low / last20high : 1;
  const compressionFormed = compressionRatio >= compressionThreshold;

  // 돌파 대기: distanceToHigh20 <= 12%
  const distFromHigh20 = last20high > 0 ? (last20high - close) / last20high : 1;
  const breakoutReady = distFromHigh20 <= 0.12;

  // 4태그: 지지+거래+압축+돌파
  const smallCsbReady = supportConfirmed && valueRatio5d20d >= 0.9 && compressionFormed && breakoutReady;

  // 3태그: 지지+거래+(압축 또는 돌파)
  const smallCsbWatch = supportConfirmed && valueRatio5d20d >= 0.9 && (compressionFormed || breakoutReady);

  if (!smallCsbWatch) return { passed: false, rejectReason: 'not smallCsb' };

  // 거래 가이드 계산 (확인 진입가, 손절가, 목표 구간)
  const prevHigh = (idx > 0 && rows[idx - 1]?.high) ? rows[idx - 1].high : close;
  const triggerPrice = Math.max(prevHigh, last20high);
  const stopPct = Math.max(0.08, Math.min(0.12, atrPct * 2.5));
  const stopPrice = close * (1 - stopPct);
  const target1 = triggerPrice * 1.10;
  const target2 = triggerPrice * 1.20;
  const profitRange = triggerPrice - stopPrice;
  const ratio1 = profitRange > 0 ? (target1 - triggerPrice) / profitRange : 0;
  const ratio2 = profitRange > 0 ? (target2 - triggerPrice) / profitRange : 0;

  return {
    passed: true,
    bucket: smallCsbReady ? 'SMALL_CSB_READY' : 'SMALL_CSB_WATCH',
    capBucket,
    compressionThreshold,
    stageCount: (supportConfirmed ? 1 : 0) + (valueRatio5d20d >= 0.9 ? 1 : 0) + (compressionFormed ? 1 : 0) + (breakoutReady ? 1 : 0),
    stages: {
      supportConfirmed,
      volumeReturning: valueRatio5d20d >= 0.9,
      compressionFormed,
      breakoutReady,
    },
    metrics: {
      compressionRatio,
      distFromHigh20: distFromHigh20 * 100,
      valueRatio5d20d,
      avg20Value,
      avg5Value,
      ret5d: ret5d * 100,
      ret20d: ret20d * 100,
      atrPct: atrPct * 100,
    },
    buyGuidance: {
      observationPrice: close,
      triggerPrice,
      stopPrice,
      target1,
      target2,
      ratio1: Math.max(0, ratio1),
      ratio2: Math.max(0, ratio2),
      stopPct: stopPct * 100,
      isHighVolatility: atrPct > 0.20,
    },
  };
}

function calculateCompressionSupportBreakoutScoreV2(chartRows, flowRows, meta = {}) {
  const u = compressionSupportBreakoutUniverseV2(chartRows, meta);
  if (!u.passed) return { passed: false, reason: u.reason };

  const {
    avg20Value, avg5Value, valueExp5_20,
    ret5d, ret20d, atrPct,
    ma20, ma60, ma120, close,
    compressionRatio, distFromHigh20, distFromHigh60,
    supports20, supports60, low5, low20,
  } = u;

  // 1. 적정 압축 25 — sweet spot 0.55~0.75 최고, 0.40~0.55 감점
  let compressionScore;
  if (compressionRatio >= 0.55 && compressionRatio <= 0.75) compressionScore = 25;
  else if (compressionRatio > 0.75 && compressionRatio <= 0.90) compressionScore = 18;
  else if (compressionRatio > 0.90 && compressionRatio <= 1.00) compressionScore = 10;
  else if (compressionRatio >= 0.40 && compressionRatio < 0.55) compressionScore = 12;
  else compressionScore = 0;

  // 2. 지지 유지 20
  let supportScore = 0;
  if (supports20 && supports60) supportScore = 14;
  else if (supports20) supportScore = 10;
  else if (supports60) supportScore = 7;
  if (ma20 != null && ma20 > 0) {
    const dev = close / ma20;
    if (dev >= 0.99 && dev <= 1.03) supportScore += 4;
    else if (dev >= 0.97 && dev <= 1.05) supportScore += 2;
  }
  if (low5 >= low20) supportScore += 2;
  supportScore = Math.min(supportScore, 20);

  // 3. 돌파 대기 위치 20 — sweet spot 2~8% 최고
  let breakoutScore = 0;
  if (distFromHigh20 >= 0.02 && distFromHigh20 <= 0.08) breakoutScore += 12;
  else if (distFromHigh20 >= 0 && distFromHigh20 < 0.02) breakoutScore += 8;
  else if (distFromHigh20 > 0.08 && distFromHigh20 <= 0.12) breakoutScore += 5;
  else breakoutScore -= 2;
  if (distFromHigh60 <= 0.05) breakoutScore += 8;
  else if (distFromHigh60 <= 0.08) breakoutScore += 5;
  else if (distFromHigh60 <= 0.12) breakoutScore += 2;
  breakoutScore = Math.max(0, Math.min(breakoutScore, 20));

  // 4. 거래대금 재활성 15 — sweet spot 1.1~1.8 최고, >1.8 감점, <0.8 감점
  let liquidityScore;
  if (valueExp5_20 >= 1.1 && valueExp5_20 <= 1.8) liquidityScore = 15;
  else if (valueExp5_20 >= 1.0 && valueExp5_20 < 1.1) liquidityScore = 10;
  else if (valueExp5_20 >= 0.8 && valueExp5_20 < 1.0) liquidityScore = 5;
  else if (valueExp5_20 > 1.8) liquidityScore = 8;
  else liquidityScore = 2;

  // 5. 과열 회피 10
  let overheatScore = 0;
  if (ret5d >= -0.03 && ret5d <= 0.04) overheatScore += 6;
  else if (ret5d > 0.04 && ret5d <= 0.06) overheatScore += 4;
  else if (ret5d > 0.06) overheatScore += 1;
  if (ret20d >= -0.05 && ret20d <= 0.10) overheatScore += 4;
  else if (ret20d > 0.10 && ret20d <= 0.15) overheatScore += 2;
  overheatScore = Math.min(overheatScore, 10);

  // 6. 리스크 안정 5
  let worst1d = 0;
  for (let i = chartRows.length - 5; i < chartRows.length; i++) {
    if (i <= 0) continue;
    const r = chartRows[i].close / chartRows[i - 1].close - 1;
    if (r < worst1d) worst1d = r;
  }
  let riskScore = 0;
  if (atrPct < 0.04) riskScore += 3;
  else if (atrPct < 0.08) riskScore += 2;
  else if (atrPct > 0.16) riskScore -= 1;
  if (worst1d >= -0.03) riskScore += 2;
  else if (worst1d >= -0.05) riskScore += 1;
  riskScore = Math.max(0, Math.min(riskScore, 5));

  // 7. 수급 보조 5 (보조 가점만)
  let flowBonusScore = 0;
  let flowSignals = null;
  if (flowRows && flowRows.length >= 20) {
    const sumKey = (arr, k) => arr.reduce((s, r) => s + (r?.[k] || 0), 0);
    const flow5 = flowRows.slice(-5);
    const flow20 = flowRows.slice(-20);
    const total5d = sumKey(flow5, 'foreignNetValue') + sumKey(flow5, 'instNetValue');
    const total20d = sumKey(flow20, 'foreignNetValue') + sumKey(flow20, 'instNetValue');
    const flowRatio5d = avg20Value > 0 ? total5d / avg20Value : 0;
    const netBuyDays5d = flow5.filter((r) => (r.foreignNetValue || 0) + (r.instNetValue || 0) > 0).length;
    if (total5d > 0) flowBonusScore += 2;
    if (netBuyDays5d >= 3) flowBonusScore += 2;
    if (flowRatio5d >= 0.3) flowBonusScore += 1;
    flowBonusScore = Math.min(flowBonusScore, 5);
    flowSignals = { total5d, total20d, flowRatio5d, netBuyDays5d };
  }

  const score = compressionScore + supportScore + breakoutScore + liquidityScore
    + overheatScore + riskScore + flowBonusScore;

  const stage = {
    compressionFormed: compressionRatio <= 0.75,
    supportConfirmed: supports20 && low5 >= low20,
    breakoutReady: distFromHigh20 <= 0.05,
    volumeReturning: valueExp5_20 >= 1.1,
  };

  return {
    passed: true,
    score,
    breakdown: { compressionScore, supportScore, breakoutScore, liquidityScore, overheatScore, riskScore, flowBonusScore },
    stage,
    signals: {
      ret5d, ret20d, atrPct,
      avg5Value, avg20Value, valueExp5_20,
      ma20, ma60, ma120,
      compressionRatio,
      distFromHigh20, distFromHigh60,
      supports20, supports60, low5, low20, worst1d,
      flow: flowSignals,
    },
  };
}

// ─────────── Korea Rebound Model ───────────
// Phase 6 보조 모델 — d20 추세 모델이 한국장에서 실패했으므로,
// 반대로 정상 종목의 단기 과매도 후 d1~d5 반등을 노리는 모델.
//
// 가설:
//   시총/거래대금 충분 + 장기 추세 살아있는 종목이 5~10일 과매도 후
//   매도 압력 둔화 + 수급 개선 → d1~d5 반등 가능.
//
// 점수 100점:
//   1. Universe Quality           15  (필터 pass 시 15)
//   2. Short-term Oversold        20
//   3. Long-term Structure Alive  15
//   4. Selling Pressure Exhaust   20
//   5. Flow Improvement           15
//   6. Rebound Trigger            10
//   7. Risk Control                5
//
// Hard filters (통과시 score 산출):
//   - 시총 ≥ 1000억, 우선/스팩/ETF/ETN 제외
//   - 20일 평균거래대금 ≥ 50억
//   - chart 200일 이상 (200MA 계산용)
//   - flow 10일 이상
//   - ATR 14d 계산 가능
function calculateReboundScore(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 200) return null;
  if (!flowRows || flowRows.length < 10) return null;

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const reject = (reason) => ({ passed: false, reason });

  // ─── Universe filter ───
  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  if ((meta.marketValue || 0) < 100_000_000_000) return reject('marketCap<1000억');

  const last20rows = chartRows.slice(-20);
  const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last20rows.length, 1);
  if (avg20Value < 5_000_000_000) return reject('avg20Value<50억');

  const atrObj = computeATR(chartRows, idx, 14);
  if (!atrObj || !(atrObj.atr > 0) || !Number.isFinite(atrObj.atr)) return reject('ATR n/a');
  const atrPct = atrObj.atr / close;  // fraction
  // ATR 변동성 폭탄 reject — 광전자 40%, 빛과전자 35.5% 같은 종목 제외
  if (atrPct >= 0.25) return reject('atrPct>=25%');

  // ─── 가격 시리즈 ───
  const ret5d = chartRows.length >= 6 ? (close / chartRows[idx - 5].close - 1) : 0;
  const ret10d = chartRows.length >= 11 ? (close / chartRows[idx - 10].close - 1) : 0;
  const ret20d = chartRows.length >= 21 ? (close / chartRows[idx - 20].close - 1) : 0;
  const ret60d = chartRows.length >= 61 ? (close / chartRows[idx - 60].close - 1) : 0;
  // 구조 붕괴 reject — 단기 과매도 아닌 추세 붕괴
  if (ret20d <= -0.35) return reject('ret20d<=-35%');
  if (chartRows.length >= 61 && ret60d <= -0.45) return reject('ret60d<=-45%');

  const ma5 = sma(chartRows.slice(-5).map((r) => r.close), 5);
  const ma60 = sma(chartRows.slice(-60).map((r) => r.close), 60);
  const ma120 = sma(chartRows.slice(-120).map((r) => r.close), 120);
  const ma200 = sma(chartRows.slice(-200).map((r) => r.close), 200);
  // 장기 기준선 붕괴 reject
  if (ma120 != null && close < ma120 * 0.85) return reject('close<ma120*0.85');
  if (ma200 != null && close < ma200 * 0.80) return reject('close<ma200*0.80');

  // ─── 1. Universe Quality (15) ───
  const universeScore = 15;

  // ─── 2. Short-term Oversold (20) — 5d≤-8% 또는 10d≤-10% Hard filter ───
  const cond5 = ret5d <= -0.08;
  const cond10 = ret10d <= -0.10;
  if (!cond5 && !cond10) return reject('not oversold');
  const oversoldScore = (cond5 && cond10) ? 20 : 12;

  // ─── 3. Long-term Structure Alive (15) ───
  // hard reject 통과 후 — 추가 score 룰
  let structureScore = 0;
  if (ma120 != null && close >= ma120 * 0.90) structureScore += 10;
  if (ma60 != null && close >= ma60 * 0.95) structureScore += 5;
  structureScore = Math.max(0, Math.min(15, structureScore));

  // ─── 4. Selling Pressure Exhaustion (20) ───
  let exhaustScore = 0;
  // (a) 최근 3일 거래량 < 직전 5일 평균 거래량
  const last3 = chartRows.slice(-3);
  const prev5 = chartRows.slice(-8, -3);
  const avg3vol = last3.reduce((s, r) => s + (r.volume || 0), 0) / Math.max(last3.length, 1);
  const avg5volPrev = prev5.reduce((s, r) => s + (r.volume || 0), 0) / Math.max(prev5.length, 1);
  if (avg5volPrev > 0 && avg3vol < avg5volPrev) exhaustScore += 5;

  // (b) 음봉 크기 축소
  const barSize = (r) => (r.open > 0 ? Math.max(0, (r.open - r.close) / r.open) : 0);
  const negBars = (arr) => arr.filter((r) => r.close < r.open);
  const avgNegSize = (arr) => (arr.length ? arr.reduce((s, r) => s + barSize(r), 0) / arr.length : 0);
  const last3NegSize = avgNegSize(negBars(last3));
  const prev5NegSize = avgNegSize(negBars(prev5));
  if (prev5NegSize > 0 && last3NegSize > 0 && last3NegSize < prev5NegSize * 0.7) exhaustScore += 5;

  // (c) 5일 저가 갱신 실패 — 최근 3일 모두 5일 저가 위
  const last5lows = chartRows.slice(-5).map((r) => r.low);
  const min5 = Math.min(...last5lows);
  if (last3.every((r) => r.low > min5)) exhaustScore += 5;

  // (d) 장대음봉 후 일중 변동폭 둔화
  const last5 = chartRows.slice(-5);
  let bigDropIdxLast5 = -1;
  for (let j = 0; j < last5.length; j++) {
    const r = last5[j];
    if (r.open > 0 && (r.close - r.open) / r.open <= -0.05) bigDropIdxLast5 = j;
  }
  if (bigDropIdxLast5 >= 0 && bigDropIdxLast5 < last5.length - 1) {
    const dropRange = (last5[bigDropIdxLast5].high - last5[bigDropIdxLast5].low) / Math.max(last5[bigDropIdxLast5].open, 1);
    const after = last5.slice(bigDropIdxLast5 + 1);
    const afterRange = after.reduce((s, r) => s + (r.high - r.low) / Math.max(r.open, 1), 0) / Math.max(after.length, 1);
    if (afterRange > 0 && afterRange < dropRange * 0.5) exhaustScore += 5;
  }
  exhaustScore = Math.max(0, Math.min(20, exhaustScore));

  // ─── 5. Flow Improvement (15) ───
  const sumNet = (arr) => arr.reduce((s, r) => s + ((r?.foreignNetValue || 0) + (r?.instNetValue || 0)), 0);
  const flow3 = flowRows.slice(-3);
  const flow5 = flowRows.slice(-5);
  const flow10 = flowRows.slice(-10);
  const sum3 = sumNet(flow3);
  const sum5 = sumNet(flow5);
  const sum10 = sumNet(flow10);
  let flowScore = 0;
  // (a) 3일 합 > 5일 합 (가장 최근 3일이 더 좋음 → 매도 둔화/매수 전환)
  if (sum3 > sum5) flowScore += 5;
  // (b) 최근 3일 양수 일수 ≥ 2
  const positive3 = flow3.filter((r) => ((r.foreignNetValue || 0) + (r.instNetValue || 0)) > 0).length;
  if (positive3 >= 2) flowScore += 5;
  // (c) 5일 합 > 10일 합 (5일 추세 개선)
  if (sum5 > sum10) flowScore += 5;
  flowScore = Math.max(0, Math.min(15, flowScore));

  // ─── 6. Rebound Trigger (10) ───
  let triggerScore = 0;
  const yesterday = chartRows[idx - 1];
  // (a) 전일 고가 돌파
  if (yesterday && close > yesterday.high) triggerScore += 3;
  // (b) 5일선 회복
  if (ma5 != null && close >= ma5) triggerScore += 3;
  // (c) 양봉 전환
  if (today.close > today.open) triggerScore += 2;
  // (d) 갭하락 후 회복 — 시가 < 어제 종가 AND 종가 > 시가
  if (yesterday && today.open < yesterday.close && today.close > today.open) triggerScore += 2;
  triggerScore = Math.min(10, triggerScore);

  // ─── 7. Risk Control (5, 단 15~25% 는 감점) ───
  let riskScore = 0;
  if (atrPct < 0.05) riskScore = 5;
  else if (atrPct < 0.07) riskScore = 3;
  else if (atrPct < 0.10) riskScore = 1;
  else if (atrPct < 0.15) riskScore = 0;
  else riskScore = -3;  // 15~25% 변동성 큰 종목 감점 (≥25% 는 위에서 reject)

  const score = universeScore + oversoldScore + structureScore + exhaustScore + flowScore + triggerScore + riskScore;

  return {
    passed: true,
    score,
    breakdown: { universeScore, oversoldScore, structureScore, exhaustScore, flowScore, triggerScore, riskScore },
    signals: {
      ret5d, ret10d, ret20d, ret60d,
      close, ma5, ma60, ma120, ma200,
      atrPct,
      avg3vol, avg5volPrev,
      sum3, sum5, sum10,
      positive3,
      bigDropInLast5: bigDropIdxLast5 >= 0,
    },
  };
}

// ─── VolumeValueIgnition (거래대금 초동 후보) ───
// 평소 거래대금 대비 폭증 + 양호한 종가 마감 → 다음날 진입 성과 검증
function calculateVolumeValueIgnition(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  if (!flowRows || flowRows.length < 10) return null;

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const reject = (reason) => ({ passed: false, reason });

  // ─── Hard filter ───
  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  if ((meta.marketValue || 0) < 50_000_000_000) return reject('marketCap<500억');

  const last20rows = chartRows.slice(-20);
  const avg20Value = last20rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last20rows.length, 1);
  if (avg20Value < 2_000_000_000) return reject('avg20Value<20억');

  const atrObj = computeATR(chartRows, idx, 14);
  const atrPct = atrObj ? atrObj.atr / close : null;
  if (!atrPct) return reject('ATR n/a');
  if (atrPct >= 0.30) return reject('atrPct>=30%');

  const ret5d = chartRows.length >= 6 ? (close / chartRows[idx - 5].close - 1) : 0;
  const ret20d = chartRows.length >= 21 ? (close / chartRows[idx - 20].close - 1) : 0;
  if (ret5d > 0.18) return reject('ret5d>18%');
  if (ret20d > 0.40) return reject('ret20d>40%');

  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  if (todayReturn <= 0) return reject('todayReturn<=0');

  const range = today.high - today.low;
  const closeLocation = range > 0 ? (close - today.low) / range : 0;
  if (closeLocation < 0.4) return reject('closeLocation<0.4');

  // ─── 핵심 지표 ───
  const last20vol = last20rows.map(r => r.volume || 0);
  const avg20Vol = last20vol.reduce((s, v) => s + v, 0) / Math.max(last20rows.length, 1);
  const volumeRatio20 = avg20Vol > 0 ? (today.volume || 0) / avg20Vol : 0;

  const valueRatio20 = avg20Value > 0 ? (today.valueApprox || 0) / avg20Value : 0;
  const last60rows = chartRows.slice(-60);
  const avg60Value = last60rows.reduce((s, r) => s + (r.valueApprox || 0), 0) / Math.max(last60rows.length, 1);
  const valueRatio60 = avg60Value > 0 ? (today.valueApprox || 0) / avg60Value : 0;

  const ma20 = sma(chartRows.slice(-20).map(r => r.close), 20);
  const distance20 = ma20 ? (close / ma20 - 1) : 0;

  const upperWick = today.high > today.close ? (today.high - today.close) : 0;
  const bodyHeight = Math.abs(today.close - today.open);
  const upperWickRatio = bodyHeight > 0 ? upperWick / bodyHeight : 0;

  // ─── 초동 조건 판정 ───
  const isIgnition = volumeRatio20 >= 2.0 && valueRatio20 >= 2.0 && valueRatio20 <= 5.0
    && todayReturn >= 0.02 && todayReturn <= 0.12 && closeLocation >= 0.7 && upperWickRatio <= 0.35;
  const isStrongIgnition = volumeRatio20 >= 2.5 && valueRatio20 >= 3.0 && valueRatio20 <= 5.0
    && todayReturn >= 0.03 && todayReturn <= 0.15 && closeLocation >= 0.8 && upperWickRatio <= 0.25;
  const isOverheat = valueRatio20 > 5.0 || todayReturn > 0.15 || ret5d > 0.18 || upperWickRatio > 0.45;

  if (!isIgnition && !isStrongIgnition) return reject('not ignition');
  if (isOverheat) return reject('overheat');

  // ─── 점수 계산 ───
  let valueExplosionScore = 0;
  if (valueRatio20 >= 5.0) valueExplosionScore = 25;
  else if (valueRatio20 >= 3.0) valueExplosionScore = 20;
  else if (valueRatio20 >= 2.0) valueExplosionScore = 12;
  if (valueRatio60 >= 3.0) valueExplosionScore = Math.min(30, valueExplosionScore + 5);

  let volumeExplosionScore = 0;
  if (volumeRatio20 >= 3.0) volumeExplosionScore = 20;
  else if (volumeRatio20 >= 2.5) volumeExplosionScore = 16;
  else if (volumeRatio20 >= 2.0) volumeExplosionScore = 10;

  let candleQualityScore = 0;
  if (closeLocation >= 0.8) candleQualityScore += 10;
  else if (closeLocation >= 0.6) candleQualityScore += 6;
  if (today.close > today.open) candleQualityScore += 5;
  if (upperWick < 0.02) candleQualityScore += 5;
  else if (upperWick < 0.05) candleQualityScore += 2;

  let cooldownScore = 0;
  if (ret5d <= 0.10) cooldownScore += 5;
  else if (ret5d <= 0.15) cooldownScore += 2;
  if (ret20d <= 0.20) cooldownScore += 5;
  else if (ret20d <= 0.35) cooldownScore += 2;

  let structureScore = 0;
  if (ma20 && close >= ma20) structureScore += 5;
  if (distance20 >= -0.05 && distance20 <= 0.15) structureScore += 5;

  let liquidityScore = 0;
  if (avg20Value >= 30_000_000_000) liquidityScore = 5;
  else if (avg20Value >= 10_000_000_000) liquidityScore = 3;
  else if (avg20Value >= 2_000_000_000) liquidityScore = 1;

  let flowScore = 0;
  if (flowRows?.length >= 3) {
    const flow3 = flowRows.slice(-3);
    const net3 = flow3.reduce((s, r) => s + ((r.foreignNetValue || 0) + (r.instNetValue || 0)), 0);
    if (net3 > 0) flowScore = 5;
    else if (net3 > -5_000_000_000) flowScore = 2;
  }

  const category = isStrongIgnition ? 'STRONG_IGNITION' : 'IGNITION';
  const score = valueExplosionScore + volumeExplosionScore + candleQualityScore
    + cooldownScore + structureScore + liquidityScore + flowScore;

  return {
    passed: true,
    category,
    score,
    breakdown: { valueExplosionScore, volumeExplosionScore, candleQualityScore,
      cooldownScore, structureScore, liquidityScore, flowScore },
    signals: { volumeRatio20: +(volumeRatio20.toFixed(2)), valueRatio20: +(valueRatio20.toFixed(2)), valueRatio60: +(valueRatio60.toFixed(2)),
      closeLocation: +(closeLocation.toFixed(2)), todayReturn: +(todayReturn * 100).toFixed(2), ret5d: +(ret5d * 100).toFixed(2),
      ret20d: +(ret20d * 100).toFixed(2), distance20: +(distance20 * 100).toFixed(2), atrPct: +(atrPct * 100).toFixed(2),
      avg20Value, upperWickRatio: +(upperWickRatio.toFixed(2)), signalHigh: today.high, signalClose: today.close },
  };
}

// ─── VVI 신호 발생 후 사후 추적 상태 판정 ───
function computeVviStatus(subsequentRows, signalHigh) {
  if (!subsequentRows || subsequentRows.length === 0) {
    return { status: 'WAITING_CONFIRM', daysAfterSignal: 0 };
  }
  const days = subsequentRows.length;
  const currentRow = subsequentRows[days - 1];
  const currentPrice = currentRow.close;
  const maxHigh = Math.max(...subsequentRows.map(r => r.high));
  const confirmed = maxHigh > signalHigh;

  if (!confirmed) {
    if (days >= 5) return { status: 'EXPIRED', daysAfterSignal: days, currentPrice };
    return { status: 'FAILED_CONFIRM', daysAfterSignal: days, currentPrice };
  }
  // 돌파 확인 이후
  if (currentPrice > signalHigh * 1.08) return { status: 'CHASE_RISK', daysAfterSignal: days, currentPrice, confirmHigh: maxHigh };
  if (currentPrice < maxHigh * 0.93)    return { status: 'PULLBACK_AFTER_CONFIRM', daysAfterSignal: days, currentPrice, confirmHigh: maxHigh };
  return { status: 'CONFIRMED', daysAfterSignal: days, currentPrice, confirmHigh: maxHigh };
}

// ─── 최근 N 거래일 VVI 신호 스캔 ───
function scanRecentVviSignals(rows, flowRows, meta, lookback) {
  lookback = lookback || 5;
  if (!rows || rows.length < 65) return null;
  const lastIdx = rows.length - 1;
  // rows[-2] ~ rows[-(lookback+1)] 스캔
  for (let back = 1; back <= lookback; back++) {
    const signalIdx = lastIdx - back;
    if (signalIdx < 60) break;
    const slicedChart = rows.slice(0, signalIdx + 1);
    const signalDate = rows[signalIdx].date;
    const slicedFlow = (flowRows || []).filter(r => r.date <= signalDate);
    if (slicedFlow.length < 10) continue;
    let vvi = null;
    try { vvi = calculateVolumeValueIgnition(slicedChart, slicedFlow, meta); } catch (_) { continue; }
    if (!vvi?.passed) continue;
    // 신호 발생! 이후 거래일 상태 판정
    const subsequentRows = rows.slice(signalIdx + 1);
    const { signalHigh, signalClose } = vvi.signals;
    const statusResult = computeVviStatus(subsequentRows, signalHigh);
    return { signalDate, signalHigh, signalClose, vvi, ...statusResult };
  }
  return null;
}

// ─── QVA (QuietVolumeAnomaly) — 순수 거래량 이상징후 선행 감지 모델 ───
// 단일 후보 모델: 조건에 맞으면 QVA, 아니면 제외 (억지로 분류하지 않음)
// 조용한 구간에서 거래량/거래대금 선행 증가 포착 — 재료 반응형 제외
function calculateQuietVolumeAnomaly(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  // ─── 필터 1: 기본 조건 ───
  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  const marketValue = meta.marketValue || 0;
  if (marketValue > 0 && marketValue < 50_000_000_000) return reject('marketcap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  // ─── 필터 2: 유동성 조건 ───
  const avg20Value = chartRows.slice(-20).reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  // ─── 필터 3: 거래량/거래대금 이상징후 ───
  const avg20Vol  = chartRows.slice(-20).reduce((s, r) => s + (r.volume || 0), 0) / 20;
  const avg60Value = chartRows.slice(-60).reduce((s, r) => s + (r.valueApprox || 0), 0) / 60;
  const todayValue = today.valueApprox || (today.close * today.volume);
  const volumeRatio20 = today.volume / (avg20Vol || 1);
  const valueRatio20  = todayValue / (avg20Value || 1);
  const valueDryness  = avg20Value / (avg60Value || 1);

  if (volumeRatio20 < 1.7) return reject('volRatio20<1.7');
  if (valueRatio20 < 1.7) return reject('valRatio20<1.7');

  // ─── 필터 4: 조용한 구간 확인 (거래대금 건조도) ───
  if (valueDryness > 1.1) return reject('dryness>1.1');

  // ─── 필터 5: 가격 안정성 (재료 반응형 제외) ───
  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  if (todayReturn < -0.015) return reject('todayReturn<-1.5%');
  if (todayReturn > 0.035) return reject('todayReturn>3.5%');

  const ret5d  = idx >= 5  ? (close / chartRows[idx - 5].close  - 1) : 0;
  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;
  if (ret5d > 0.05) return reject('ret5d>5%');
  if (ret20d > 0.10) return reject('ret20d>10%');

  // ─── 필터 6: 윗꼬리 (폭등/낙심 신호 제외) ───
  const upperWick = today.high > today.close ? today.high - today.close : 0;
  const bodyRange = Math.abs(today.close - today.open) || 1;
  const upperWickRatio = upperWick / bodyRange;
  if (upperWickRatio > 0.40) return reject('upperWick>0.4');

  // ─── 필터 7: 변동성 ───
  const { atr } = computeATR(chartRows, idx, 14);
  const atrPct = atr / close;
  if (atrPct > 0.25) return reject('atr%>25%');

  // ─── 필터 8: 구조 유지 ───
  const ma20 = sma(chartRows.slice(-20).map(r => r.close), 20);
  const ma60 = chartRows.length >= 60 ? sma(chartRows.slice(-60).map(r => r.close), 60) : null;
  const hasStructure = (ma20 != null && close >= ma20 * 0.93)
                    || (ma60 != null && close >= ma60 * 0.90);
  if (!hasStructure) return reject('structure_broken');

  // ─── 필터 9: 상방 압력 필수 ───
  const last5 = chartRows.slice(-5);
  const last10 = chartRows.slice(-10);
  const lows5 = last5.map(r => r.low);
  const lows20to25 = chartRows.slice(-25, -5).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;
  const higherLow5 = min5 > min20;

  const closeHigh5 = Math.max(...last5.map(r => r.close));
  const closeHigh20to25 = Math.max(...chartRows.slice(-25, -5).map(r => r.close));
  const high5 = Math.max(...last5.map(r => r.high));
  const high20to25 = Math.max(...chartRows.slice(-25, -5).map(r => r.high));
  const recentCloseHighBreak = closeHigh5 > closeHigh20to25;
  const recentHighNearBreak = high5 >= high20to25 * 0.97;

  const ma5 = sma(last5.map(r => r.close), 5);
  const ma5Slope = chartRows.length >= 9 ? sma(chartRows.slice(-9, -4).map(r => r.close), 5) : null;
  const ma5IsUp = ma5 && ma5Slope ? (ma5 > ma5Slope) : false;

  // 상방 압력 필수: 고점 돌파 OR 고가 근처 OR (저점상승 AND 20선위 AND 5선상향)
  const hasUpsidePressure = recentCloseHighBreak || recentHighNearBreak || (higherLow5 && close >= ma20 && ma5IsUp);

  // DEBUG: 제일기획 상방 압력 조건 상세 로그
  if (meta?.code === '030000') {
    console.log(`    상방압력 체크:`);
    console.log(`      recentCloseHighBreak=${recentCloseHighBreak} (closeHigh5=${closeHigh5.toFixed(0)} vs 20to25=${closeHigh20to25.toFixed(0)})`);
    console.log(`      recentHighNearBreak=${recentHighNearBreak} (high5=${high5.toFixed(0)} vs 20to25*0.97=${(high20to25*0.97).toFixed(0)})`);
    console.log(`      higherLow5=${higherLow5}, close>=ma20=${close >= ma20}, ma5IsUp=${ma5IsUp}`);
    console.log(`      hasUpsidePressure=${hasUpsidePressure}`);
  }

  if (!hasUpsidePressure) return reject('no_upside_pressure');

  // ─── 모든 조건 통과 ───
  return {
    passed: true,
    signals: {
      volumeRatio20: +(volumeRatio20.toFixed(2)),
      valueRatio20: +(valueRatio20.toFixed(2)),
      valueDryness: +(valueDryness.toFixed(2)),
      todayReturn: +(todayReturn * 100).toFixed(2),
      ret5d: +(ret5d * 100).toFixed(2),
      ret20d: +(ret20d * 100).toFixed(2),
      upperWickRatio: +(upperWickRatio.toFixed(2)),
      atrPct: +(atrPct * 100).toFixed(2),
      avg20Value,
    },
  };
}

// ─── QVA_STRICT — 더 엄격한 실험 버전 ───
// 기본 QVA보다 훨씬 까다로운 조건으로 더 순수한 신호만 포착
function calculateQuietVolumeAnomalyStrict(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  const marketValue = meta.marketValue || 0;
  if (marketValue > 0 && marketValue < 50_000_000_000) return reject('marketcap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const avg20Value = chartRows.slice(-20).reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  const avg20Vol  = chartRows.slice(-20).reduce((s, r) => s + (r.volume || 0), 0) / 20;
  const avg60Value = chartRows.slice(-60).reduce((s, r) => s + (r.valueApprox || 0), 0) / 60;
  const todayValue = today.valueApprox || (today.close * today.volume);
  const volumeRatio20 = today.volume / (avg20Vol || 1);
  const valueRatio20  = todayValue / (avg20Value || 1);
  const valueDryness  = avg20Value / (avg60Value || 1);

  // STRICT: 거래량/거래대금 비율 더 높게
  if (volumeRatio20 < 1.8) return reject('volRatio20<1.8');
  if (valueRatio20 < 1.8) return reject('valRatio20<1.8');

  // STRICT: 건조도 더 엄격
  if (valueDryness > 1.0) return reject('dryness>1.0');

  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  if (todayReturn < -0.01) return reject('todayReturn<-1%');
  if (todayReturn > 0.03) return reject('todayReturn>3%');

  const ret5d  = idx >= 5  ? (close / chartRows[idx - 5].close  - 1) : 0;
  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;

  // STRICT: 5일/20일 상승률 더 낮게
  if (ret5d > 0.04) return reject('ret5d>4%');
  if (ret20d > 0.08) return reject('ret20d>8%');

  const upperWick = today.high > today.close ? today.high - today.close : 0;
  const bodyRange = Math.abs(today.close - today.open) || 1;
  const upperWickRatio = upperWick / bodyRange;

  // STRICT: 윗꼬리 더 엄격
  if (upperWickRatio > 0.35) return reject('upperWick>0.35');

  const { atr } = computeATR(chartRows, idx, 14);
  const atrPct = atr / close;
  if (atrPct > 0.25) return reject('atr%>25%');

  const ma20 = sma(chartRows.slice(-20).map(r => r.close), 20);
  const ma60 = chartRows.length >= 60 ? sma(chartRows.slice(-60).map(r => r.close), 60) : null;
  const hasStructure = (ma20 != null && close >= ma20 * 0.93)
                    || (ma60 != null && close >= ma60 * 0.90);
  if (!hasStructure) return reject('structure_broken');

  return {
    passed: true,
    signals: {
      volumeRatio20: +(volumeRatio20.toFixed(2)),
      valueRatio20: +(valueRatio20.toFixed(2)),
      valueDryness: +(valueDryness.toFixed(2)),
      todayReturn: +(todayReturn * 100).toFixed(2),
      ret5d: +(ret5d * 100).toFixed(2),
      ret20d: +(ret20d * 100).toFixed(2),
      upperWickRatio: +(upperWickRatio.toFixed(2)),
      atrPct: +(atrPct * 100).toFixed(2),
      avg20Value,
    },
  };
}

function calculateQuietVolumeAnomalyLoose(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  const marketValue = meta.marketValue || 0;
  if (marketValue > 0 && marketValue < 50_000_000_000) return reject('marketcap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const avg20Value = chartRows.slice(-20).reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  const avg20Vol  = chartRows.slice(-20).reduce((s, r) => s + (r.volume || 0), 0) / 20;
  const avg60Value = chartRows.slice(-60).reduce((s, r) => s + (r.valueApprox || 0), 0) / 60;
  const todayValue = today.valueApprox || (today.close * today.volume);
  const volumeRatio20 = today.volume / (avg20Vol || 1);
  const valueRatio20  = todayValue / (avg20Value || 1);
  const valueDryness  = avg20Value / (avg60Value || 1);

  // LOOSE: 거래량/거래대금 비율 더 낮게
  if (volumeRatio20 < 1.5) return reject('volRatio20<1.5');
  if (valueRatio20 < 1.5) return reject('valRatio20<1.5');

  // LOOSE: 건조도 더 완화
  if (valueDryness > 1.2) return reject('dryness>1.2');

  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  if (todayReturn < -0.02) return reject('todayReturn<-2%');
  if (todayReturn > 0.05) return reject('todayReturn>5%');

  const ret5d  = idx >= 5  ? (close / chartRows[idx - 5].close  - 1) : 0;
  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;

  // LOOSE: 5일/20일 상승률 더 높게 허용
  if (ret5d > 0.08) return reject('ret5d>8%');
  if (ret20d > 0.15) return reject('ret20d>15%');

  const upperWick = today.high > today.close ? today.high - today.close : 0;
  const bodyRange = Math.abs(today.close - today.open) || 1;
  const upperWickRatio = upperWick / bodyRange;

  // LOOSE: 윗꼬리 덜 엄격
  if (upperWickRatio > 0.45) return reject('upperWick>0.45');

  const { atr } = computeATR(chartRows, idx, 14);
  const atrPct = atr / close;
  if (atrPct > 0.30) return reject('atr%>30%');

  return {
    passed: true,
    signals: {
      volumeRatio20: +(volumeRatio20.toFixed(2)),
      valueRatio20: +(valueRatio20.toFixed(2)),
      valueDryness: +(valueDryness.toFixed(2)),
      todayReturn: +(todayReturn * 100).toFixed(2),
      ret5d: +(ret5d * 100).toFixed(2),
      ret20d: +(ret20d * 100).toFixed(2),
      upperWickRatio: +(upperWickRatio.toFixed(2)),
      atrPct: +(atrPct * 100).toFixed(2),
      avg20Value,
    },
  };
}

// ─── QVA 새로운 설계: 5가지 세부 가설 ───

function calculateQuietVolumeFirst(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  if ((meta.marketValue || 0) > 0 && meta.marketValue < 50_000_000_000) return reject('cap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const avg20Value = chartRows.slice(-20).reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  const { atr } = computeATR(chartRows, idx, 14);
  const atrPct = atr / close;
  if (atrPct > 0.30) return reject('atr>30%');

  const todayValue = today.valueApprox || (today.close * today.volume);
  const valueRatio20 = todayValue / (avg20Value || 1);
  if (valueRatio20 < 1.5) return reject('valRatio20<1.5');

  // FIRST: 20/60일 중 순위 기반 (처음으로 튈 때)
  const values20 = chartRows.slice(-20).map(r => r.valueApprox || 0).sort((a, b) => b - a);
  const values60 = chartRows.slice(-60).map(r => r.valueApprox || 0).sort((a, b) => b - a);
  const rank20 = values20.findIndex(v => v <= todayValue) + 1;
  const rank60 = values60.findIndex(v => v <= todayValue) + 1;
  const rankPct20 = (1 - rank20 / 20) * 100;
  const rankPct60 = (1 - rank60 / 60) * 100;

  if (rankPct20 < 90 || rankPct60 < 80) return reject('rank_too_low');

  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  if (todayReturn < -0.01 || todayReturn > 0.05) return reject('todayReturn_range');

  const ret5d = idx >= 5 ? (close / chartRows[idx - 5].close - 1) : 0;
  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;
  if (ret5d > 0.08 || ret20d > 0.15) return reject('ret_range');

  const upperWick = today.high > today.close ? today.high - today.close : 0;
  const bodyRange = Math.abs(today.close - today.open) || 1;
  const upperWickRatio = upperWick / bodyRange;
  if (upperWickRatio > 0.45) return reject('upperWick>0.45');

  return { passed: true, model: 'FIRST', signals: { valueRatio20: +valueRatio20.toFixed(2), rankPct20: +rankPct20.toFixed(1), rankPct60: +rankPct60.toFixed(1) } };
}

function calculateQuietVolume2Day(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  if ((meta.marketValue || 0) > 0 && meta.marketValue < 50_000_000_000) return reject('cap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const yesterday = idx > 0 ? chartRows[idx - 1] : null;
  const close = today?.close;
  if (!close || !yesterday) return null;

  const avg20Value = chartRows.slice(-20).reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = chartRows.slice(-20).reduce((s, r) => s + (r.volume || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  const todayValue = today.valueApprox || 0;
  const yesterdayValue = yesterday.valueApprox || 0;
  const value2d = todayValue + yesterdayValue;
  const vol2d = (today.volume || 0) + (yesterday.volume || 0);

  const value2dRatio20 = value2d / (avg20Value * 2);
  const volume2dRatio20 = vol2d / (avg20Vol * 2);

  if (value2dRatio20 < 1.8 || volume2dRatio20 < 1.8) return reject('2d_ratio_low');

  const ret2d = close / chartRows[Math.max(0, idx - 2)].close - 1;
  if (ret2d < -0.01 || ret2d > 0.08) return reject('ret2d_range');

  const ret5d = idx >= 5 ? (close / chartRows[idx - 5].close - 1) : 0;
  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;
  if (ret5d > 0.10 || ret20d > 0.18) return reject('ret_range');

  // 2일 중 최소 하나 양봉
  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  const yesterdayReturn = yesterday.open > 0 ? (yesterday.close / yesterday.open - 1) : 0;
  if (todayReturn <= 0 && yesterdayReturn <= 0) return reject('no_bullish_day');

  return { passed: true, model: '2DAY', signals: { value2dRatio20: +value2dRatio20.toFixed(2), volume2dRatio20: +volume2dRatio20.toFixed(2) } };
}

function calculateQuietVolumeAbsorb(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  if ((meta.marketValue || 0) > 0 && meta.marketValue < 50_000_000_000) return reject('cap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const avg20Value = chartRows.slice(-20).reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = chartRows.slice(-20).reduce((s, r) => s + (r.volume || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  const todayValue = today.valueApprox || (today.close * today.volume);
  const valueRatio20 = todayValue / (avg20Value || 1);
  const volumeRatio20 = today.volume / (avg20Vol || 1);

  if (valueRatio20 < 1.7 || volumeRatio20 < 1.5) return reject('ratio_low');

  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  if (todayReturn < -0.01 || todayReturn > 0.04) return reject('todayReturn_range');

  // ABSORB 스코어: 거래대금은 많은데 가격은 약함
  const absorptionScore = valueRatio20 / (Math.abs(todayReturn) + 1);
  if (absorptionScore < 0.8) return reject('absorption_low');

  const ret5d = idx >= 5 ? (close / chartRows[idx - 5].close - 1) : 0;
  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;
  if (ret5d > 0.07 || ret20d > 0.12) return reject('ret_range');

  const upperWick = today.high > today.close ? today.high - today.close : 0;
  const bodyRange = Math.abs(today.close - today.open) || 1;
  const upperWickRatio = upperWick / bodyRange;
  if (upperWickRatio > 0.50) return reject('upperWick>0.50');

  return { passed: true, model: 'ABSORB', signals: { valueRatio20: +valueRatio20.toFixed(2), absorptionScore: +absorptionScore.toFixed(2) } };
}

function calculateQvaEvolution(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  // ─── 기본 필터 ───
  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  if ((meta.marketValue || 0) > 0 && meta.marketValue < 50_000_000_000) return reject('cap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const last5 = chartRows.slice(-5);
  const last10 = chartRows.slice(-10);
  const last20 = chartRows.slice(-20);
  const last60 = chartRows.slice(-60);

  const avg20Value = last20.reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = last20.reduce((s, r) => s + (r.volume || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  const todayValue = today.valueApprox || (today.close * today.volume);
  const valueRatio20 = todayValue / (avg20Value || 1);
  const volumeRatio20 = (today.volume || 0) / (avg20Vol || 1);

  // ─── 1. 거래대금 돌출 (25점) ───
  const median20Values = median(last20.map(r => r.valueApprox || 0));
  const valueMedianRatio20 = median20Values > 0 ? todayValue / median20Values : 0;

  let valueScore = 0;
  if (valueRatio20 >= 3.0) valueScore += 10;
  else if (valueRatio20 >= 2.5) valueScore += 8;
  else if (valueRatio20 >= 2.0) valueScore += 6;
  else if (valueRatio20 >= 1.7) valueScore += 4;
  else if (valueRatio20 >= 1.5) valueScore += 2;

  if (valueMedianRatio20 >= 3.0) valueScore += 15;
  else if (valueMedianRatio20 >= 2.5) valueScore += 10;
  else if (valueMedianRatio20 >= 2.0) valueScore += 8;
  else if (valueMedianRatio20 >= 1.8) valueScore += 5;

  // ─── 2. 거래량 돌출 (15점) ───
  let volumeScore = 0;
  if (volumeRatio20 >= 3.0) volumeScore = 15;
  else if (volumeRatio20 >= 2.5) volumeScore = 12;
  else if (volumeRatio20 >= 2.0) volumeScore = 10;
  else if (volumeRatio20 >= 1.7) volumeScore = 7;
  else if (volumeRatio20 >= 1.5) volumeScore = 4;

  // ─── 3. 가격 미반응 (15점) ───
  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  const ret5d = idx >= 5 ? (close / chartRows[idx - 5].close - 1) : 0;
  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;

  let priceScore = 0;
  if (todayReturn >= 0 && todayReturn <= 0.03) priceScore += 10;
  else if (todayReturn > 0.03 && todayReturn <= 0.05) priceScore += 6;
  else if (todayReturn >= -0.01 && todayReturn < 0) priceScore += 5;
  else if (todayReturn > 0.05) priceScore -= 5;

  if (ret5d <= 0.08) priceScore += 3;
  if (ret20d <= 0.15) priceScore += 2;

  // ─── 4. 구조 진화 (25점) — 6개 조건 중 개수 세기 ───
  // 조건 1: higherLow5
  const lows5 = last5.map(r => r.low);
  const lows20to25 = chartRows.slice(-25, -5).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;
  const higherLow5 = min5 > min20;

  // 조건 2: recentCloseLowHigher
  const closeLow5 = Math.min(...last5.map(r => r.close));
  const closeLow20to25 = Math.min(...chartRows.slice(-25, -5).map(r => r.close));
  const recentCloseLowHigher = closeLow5 > closeLow20to25;

  // 조건 3: ma5SlopeUp
  const ma5 = sma(last5.map(r => r.close), 5);
  const ma5Prev = chartRows.length >= 9 ? sma(chartRows.slice(-9, -4).map(r => r.close), 5) : null;
  const ma5SlopeUp = ma5 && ma5Prev ? (ma5 > ma5Prev) : false;

  // 조건 4: ma20SlopeUp (상향 또는 하락 둔화 >= 0.995)
  const ma20 = sma(last20.map(r => r.close), 20);
  const ma20Prev = chartRows.length >= 25 ? sma(chartRows.slice(-25, -5).map(r => r.close), 20) : null;
  const ma20SlopeUp = ma20 && ma20Prev ? (ma20 >= ma20Prev * 0.995) : false;

  // 조건 5: closeAboveMa20
  const closeAboveMa20 = ma20 != null && close >= ma20;

  // 조건 6: recentHighNearBreak
  const high5 = Math.max(...last5.map(r => r.high));
  const high20to25 = Math.max(...chartRows.slice(-25, -5).map(r => r.high));
  const recentHighNearBreak = high5 >= high20to25 * 0.97;

  // 6개 조건 중 개수 세기 (recentCloseHighBreak는 제외)
  const structureConditions = [
    higherLow5,
    recentCloseLowHigher,
    ma5SlopeUp,
    ma20SlopeUp,
    closeAboveMa20,
    recentHighNearBreak,
  ];
  const structureCount = structureConditions.filter(Boolean).length;

  let structureScore = 0;
  if (structureCount >= 5) structureScore = 25;
  else if (structureCount >= 4) structureScore = 20;
  else if (structureCount >= 3) structureScore = 15;
  else if (structureCount >= 2) structureScore = 8;

  // ─── 5. 탄력/위치 (10점) ───
  const high10 = Math.max(...last10.map(r => r.high));
  const low10 = Math.min(...last10.map(r => r.low));
  const rangeExpansion10 = low10 > 0 ? (high10 / low10 - 1) : 0;

  const high20 = Math.max(...last20.map(r => r.high));
  const high60 = Math.max(...last60.map(r => r.high));
  const distToHigh20 = high20 > 0 ? ((high20 - close) / high20) : 1;
  const distToHigh60 = high60 > 0 ? ((high60 - close) / high60) : 1;

  let elasticityScore = 0;
  if (rangeExpansion10 >= 0.04 && rangeExpansion10 <= 0.18) elasticityScore += 5;
  else if (rangeExpansion10 > 0 && rangeExpansion10 < 0.04) elasticityScore += 2;
  if (distToHigh20 <= 0.12) elasticityScore += 3;
  if (distToHigh60 <= 0.25) elasticityScore += 2;

  // ─── 6. 리스크 감점 (최대 -10점) ───
  const upperWick = today.high > close ? today.high - close : 0;
  const bodyRange = Math.abs(close - today.open) || 1;
  const upperWickRatio = upperWick / bodyRange;
  const { atr } = computeATR(chartRows, idx, 14);
  const atrPct = atr / close;

  let riskDeduction = 0;
  if (upperWickRatio > 0.45) riskDeduction += 5;
  if (ret5d > 0.12) riskDeduction += 5;
  if (ret20d > 0.25) riskDeduction += 5;
  if (atrPct > 0.30) riskDeduction += 5;
  riskDeduction = Math.min(riskDeduction, 10);

  // ─── 총점 계산 ───
  const totalScore = Math.round(valueScore + volumeScore + priceScore + structureScore + elasticityScore - riskDeduction);

  // DEBUG: 제일기획 로그 (거부 이유 포함)
  if (meta?.code === '030000') {
    console.log(`    QVA_EVOLUTION 상세:`);
    console.log(`      valueScore=${valueScore}, volumeScore=${volumeScore}, priceScore=${priceScore}`);
    console.log(`      structureScore=${structureScore} (count=${structureCount}/6)`);
    console.log(`      elasticityScore=${elasticityScore}, riskDeduction=${riskDeduction}`);
    console.log(`      totalScore=${totalScore}`);
    console.log(`      valueMedianRatio20=${valueMedianRatio20.toFixed(2)}, rangeExpansion10=${(rangeExpansion10*100).toFixed(1)}%`);
  }

  // ─── 최종 통과 조건 ───
  if (structureCount < 3) {
    if (meta?.code === '030000') console.log(`    ✗ 거부: structureCount=${structureCount} < 3`);
    return reject('structure<3');
  }
  if (valueMedianRatio20 < 2.0) {
    if (meta?.code === '030000') console.log(`    ✗ 거부: valueMedianRatio20=${valueMedianRatio20.toFixed(2)} < 2.0`);
    return reject('valueMedianRatio<2.0');
  }
  if (totalScore < 70) {
    if (meta?.code === '030000') console.log(`    ✗ 거부: totalScore=${totalScore} < 70`);
    return reject(`score<70_${totalScore}`);
  }

  return {
    passed: true,
    model: 'QVA_EVOLUTION',
    score: totalScore,
    breakdown: {
      valueScore,
      volumeScore,
      priceScore,
      structureScore,
      elasticityScore,
      riskDeduction,
      structureCount,
    },
    signals: {
      valueRatio20: +valueRatio20.toFixed(2),
      volumeRatio20: +volumeRatio20.toFixed(2),
      valueMedianRatio20: +valueMedianRatio20.toFixed(2),
      todayReturn: +(todayReturn * 100).toFixed(2),
      ret5d: +(ret5d * 100).toFixed(2),
      ret20d: +(ret20d * 100).toFixed(2),
      upperWickRatio: +upperWickRatio.toFixed(2),
      atrPct: +(atrPct * 100).toFixed(2),
      rangeExpansion10: +(rangeExpansion10 * 100).toFixed(1),
      distToHigh20Pct: +(distToHigh20 * 100).toFixed(1),
      distToHigh60Pct: +(distToHigh60 * 100).toFixed(1),
      // 구조 지표 (bool)
      higherLow5,
      recentCloseLowHigher,
      ma5SlopeUp,
      ma20SlopeUp,
      closeAboveMa20,
      recentHighNearBreak,
      structureCount,
    },
  };
}

function calculateQuietVolumeHigherLow(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  if ((meta.marketValue || 0) > 0 && meta.marketValue < 50_000_000_000) return reject('cap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const last20 = chartRows.slice(-20);
  const last5 = chartRows.slice(-5);
  const avg20Value = last20.reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = last20.reduce((s, r) => s + (r.volume || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  const todayValue = today.valueApprox || (today.close * today.volume);
  const valueRatio20 = todayValue / (avg20Value || 1);
  const volumeRatio20 = today.volume / (avg20Vol || 1);

  if (valueRatio20 < 1.5 || volumeRatio20 < 1.5) return reject('ratio_low');

  // HIGHER_LOW: 최근 5일 저점 > 직전 20일 저점
  const lows5 = last5.map(r => r.low);
  const lows20to25 = chartRows.slice(-25, -5).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;

  if (min5 <= min20) return reject('low_not_higher');

  const ma20 = sma(last20.map(r => r.close), 20);
  if (ma20 && close < ma20 * 0.95) return reject('below_ma20');

  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  if (todayReturn > 0.05) return reject('todayReturn>5%');

  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;
  if (ret20d > 0.15) return reject('ret20d>15%');

  // ─── 상방 압력 필수 ───
  const closeHigh5 = Math.max(...last5.map(r => r.close));
  const closeHigh20to25 = Math.max(...chartRows.slice(-25, -5).map(r => r.close));
  const high5 = Math.max(...last5.map(r => r.high));
  const high20to25 = Math.max(...chartRows.slice(-25, -5).map(r => r.high));
  const recentCloseHighBreak = closeHigh5 > closeHigh20to25;
  const recentHighNearBreak = high5 >= high20to25 * 0.97;
  const ma5 = sma(last5.map(r => r.close), 5);
  const ma5Slope = chartRows.length >= 9 ? sma(chartRows.slice(-9, -4).map(r => r.close), 5) : null;
  const ma5IsUp = ma5 && ma5Slope ? (ma5 > ma5Slope) : false;
  // 상방 압력: 고점 돌파 OR 고가 근처 OR (저점상승 AND 20선위 AND 5선상향)
  const hasUpsidePressure = recentCloseHighBreak || recentHighNearBreak || (min5 > min20 && close >= ma20 && ma5IsUp);
  if (!hasUpsidePressure) return reject('no_upside_pressure');

  // ─── 거래대금 이상징후 + 중앙값 필수 ───
  const medianVal20 = median(last20.map(r => r.valueApprox || 0));
  const valueMedianRatio = medianVal20 > 0 ? todayValue / medianVal20 : 0;
  if (valueMedianRatio < 1.8) return reject('valueMedianRatio<1.8');

  // ─── 최근성 조건: 최근 3거래일 안에 거래대금 돌출 필요 ───
  const last3 = chartRows.slice(-3);
  const hasRecentValueSpike = last3.some(r => {
    const v = r.valueApprox || (r.close * r.volume);
    const vRatio = v / (avg20Value || 1);
    const medRatio = medianVal20 > 0 ? (v / medianVal20) : 0;
    return vRatio >= 1.5 || medRatio >= 2.0;
  });
  if (!hasRecentValueSpike) return reject('no_recent_value_spike');

  // ─── 과거 폭발 후 재유입 검사 ───
  // 지난 20~40일 전에 현재보다 2배 이상 큰 거래대금이 있었는지 확인
  const past20to40 = chartRows.slice(-40, -20);
  const maxPastValue = past20to40.length > 0 ? Math.max(...past20to40.map(r => r.valueApprox || 0)) : 0;
  const isPastSpikeRecovery = maxPastValue > todayValue * 2;

  // 따라서 hasPastExplosion 플래그를 signals에 추가
  const hasPastExplosion = isPastSpikeRecovery;

  // ─── 범위 확장 필터 ───
  const last10hl = chartRows.slice(-10);
  const high10 = Math.max(...last10hl.map(r => r.high));
  const low10 = Math.min(...last10hl.map(r => r.low));
  const rangeExpansion10 = low10 > 0 ? (high10 / low10 - 1) : 0;
  if (rangeExpansion10 < 0.03) return reject('range_expansion<3%');

  // ─── 신호 & 점수 계산 ───
  const rangeToday = today.high - today.low || 1;
  const closeLocation = (close - today.low) / rangeToday;

  // higherLowScore: 구조 개선도
  const higherLowScore = ((min5 - min20) / min20) * 100;

  // distance20: MA20까지 거리 (%)
  const distance20 = ma20 ? ((close - ma20) / ma20) * 100 : 0;

  // score: 기본 60 + 추가 조건
  let score = 60;
  if (higherLowScore >= 5) score += 10;
  else if (higherLowScore >= 2) score += 5;
  if (closeLocation >= 0.6) score += 5;
  if (distance20 >= 0) score += 5;

  // 중앙값 돌출
  const median20Values = median(last20.map(r => r.valueApprox || 0));
  const valueSpikeMedian20 = median20Values > 0 ? todayValue / median20Values : 0;
  if (valueSpikeMedian20 >= 2.5) score += 10;
  else if (valueSpikeMedian20 >= 1.8) score += 5;

  // 추가 신호 계산
  const ret5d = last5.length >= 5 ? (close / last5[0].close - 1) : 0;
  const upperWickRatio = rangeToday > 0 ? ((today.high - close) / rangeToday) : 0;

  return {
    passed: true,
    model: 'HIGHER_LOW',
    score: Math.min(score, 100),
    signals: {
      valueRatio20: +valueRatio20.toFixed(2),
      valueMedianRatio20: +valueMedianRatio.toFixed(2),
      volumeRatio20: +volumeRatio20.toFixed(2),
      valueSpikeMedian20: +valueSpikeMedian20.toFixed(2),
      higherLowScore: +higherLowScore.toFixed(2),
      distance20: +distance20.toFixed(2),
      closeLocation: +closeLocation.toFixed(2),
      todayReturn: +(todayReturn * 100).toFixed(2),
      ret20d: +(ret20d * 100).toFixed(2),
      ret5d: +(ret5d * 100).toFixed(2),
      rangeExpansion10: +(rangeExpansion10 * 100).toFixed(2),
      upperWickRatio: +upperWickRatio.toFixed(2),
      higherLow5: min5 > min20,
      closeAboveMa20: close >= ma20,
      hasPastExplosion,
    },
  };
}

function calculateQuietVolumeHold(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  if ((meta.marketValue || 0) > 0 && meta.marketValue < 50_000_000_000) return reject('cap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const last20 = chartRows.slice(-20);
  const last10 = chartRows.slice(-10);
  const last5 = chartRows.slice(-5);
  const avg20Value = last20.reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  const avg20Vol = last20.reduce((s, r) => s + (r.volume || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  // ─── 공통 필터 ───
  const todayValue = today.valueApprox || (today.close * today.volume);
  const todayVol = today.volume || 0;
  const valueRatio20 = todayValue / (avg20Value || 1);
  const volumeRatio20 = todayVol / (avg20Vol || 1);

  // 거래 이상징후 필터
  if (valueRatio20 < 1.5 || volumeRatio20 < 1.5) return reject('anomaly_low');

  // ATR, 수익률 필터
  const { atr } = computeATR(chartRows, idx, 14);
  const atrPct = atr / close;
  if (atrPct > 0.30) return reject('atr>30%');

  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  if (todayReturn < -0.015 || todayReturn > 0.06) return reject('todayReturn_range');

  const ret5d = idx >= 5 ? (close / chartRows[idx - 5].close - 1) : 0;
  if (ret5d > 0.12) return reject('ret5d>12%');

  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;
  if (ret20d > 0.20) return reject('ret20d>20%');

  // 가격 미과열
  const upperWick = today.high > close ? today.high - close : 0;
  const bodyRange = Math.abs(close - today.open) || 1;
  const upperWickRatio = upperWick / bodyRange;
  if (upperWickRatio > 0.45) return reject('upperWick>0.45');

  // ─── 거래대금 이상징후 + 중앙값 필수 ───
  const median20Values = median(last20.map(r => r.valueApprox || 0));
  const valueMedianRatio20 = median20Values > 0 ? todayValue / median20Values : 0;
  if (valueMedianRatio20 < 2.0) return reject('valueMedianRatio<2.0');

  // ─── 구조 변화 5개 지표 계산 ───
  // 1. higherLow5
  const lows5 = last5.map(r => r.low);
  const lows20to25 = chartRows.slice(-25, -5).map(r => r.low);
  const min5 = Math.min(...lows5);
  const min20 = lows20to25.length > 0 ? Math.min(...lows20to25) : Infinity;
  const higherLow5 = min5 > min20;

  // 2. close >= ma20
  const ma20 = sma(last20.map(r => r.close), 20);
  const closeAboveMa20 = ma20 != null && close >= ma20;

  // 3. ma5Slope
  const ma5 = last5.length >= 5 ? sma(last5.map(r => r.close), 5) : null;
  const ma5Prev = chartRows.length >= 9 ? sma(chartRows.slice(-9, -4).map(r => r.close), 5) : null;
  const ma5Slope = ma5 && ma5Prev ? (ma5 > ma5Prev ? 1 : 0) : 0;

  // 4. recentCloseHighBreak (최근 5일 종가 고점 > 직전 20일 종가 고점)
  const closeHigh5 = Math.max(...last5.map(r => r.close));
  const closeHigh20to25 = Math.max(...chartRows.slice(-25, -5).map(r => r.close));
  const recentCloseHighBreak = closeHigh5 > closeHigh20to25;

  // 5. recentHighNearBreak (최근 5일 고가 >= 직전 20일 고가 * 0.97)
  const high5 = Math.max(...last5.map(r => r.high));
  const high20to25 = Math.max(...chartRows.slice(-25, -5).map(r => r.high));
  const recentHighNearBreak = high5 >= high20to25 * 0.97;

  // 구조 변화 조건 계산: 5개 중 2개 이상 필요
  const structureConditions = [
    higherLow5,
    closeAboveMa20,
    ma5Slope > 0,
    recentCloseHighBreak,
    recentHighNearBreak,
  ];
  const structureCount = structureConditions.filter(Boolean).length;
  if (structureCount < 2) return reject('structure_insufficient');

  // ─── 상방 압력 필수 ───
  // 상방 압력 = 최근 고점 돌파 OR 최근 고가 근처 OR (저점상승 AND 20선위 AND 5선상향)
  const hasUpsidePressure = recentCloseHighBreak || recentHighNearBreak || (higherLow5 && closeAboveMa20 && ma5Slope > 0);
  if (!hasUpsidePressure) return reject('no_upside_pressure');

  // ─── 밋밋함 필터 ───
  const high10 = Math.max(...last10.map(r => r.high));
  const low10 = Math.min(...last10.map(r => r.low));
  const rangeExpansion10 = low10 > 0 ? (high10 / low10 - 1) : 0;
  if (rangeExpansion10 < 0.04) return reject('range_expansion<4%');

  return {
    passed: true,
    model: 'QVA_TURN',
    score: 75,  // 고정 점수 (구조 변화 2개 이상 통과한 것만)
    breakdown: { structureCount },
    signals: {
      valueRatio20: +valueRatio20.toFixed(2),
      volumeRatio20: +volumeRatio20.toFixed(2),
      valueMedianRatio20: +valueMedianRatio20.toFixed(2),
      todayReturn: +(todayReturn * 100).toFixed(2),
      ret5d: +(ret5d * 100).toFixed(2),
      ret20d: +(ret20d * 100).toFixed(2),
      atrPct: +(atrPct * 100).toFixed(2),
      upperWickRatio: +upperWickRatio.toFixed(2),
      rangeExpansion10: +(rangeExpansion10 * 100).toFixed(1),
      // 구조 지표
      higherLow5,
      closeAboveMa20,
      ma5Slope,
      recentCloseHighBreak,
      recentHighNearBreak,
      structureCount,
    },
  };
}

function calculateQuietVolumeAnomalyV2(chartRows, flowRows, meta = {}) {
  if (!chartRows || chartRows.length < 60) return null;
  const reject = (reason) => ({ passed: false, reason });

  if (meta.isSpecial || meta.isEtf) return reject('special/etf');
  const marketValue = meta.marketValue || 0;
  if (marketValue > 0 && marketValue < 50_000_000_000) return reject('marketcap<500B');

  const idx = chartRows.length - 1;
  const today = chartRows[idx];
  const close = today?.close;
  if (!close || close <= 0) return null;

  const avg20Value = chartRows.slice(-20).reduce((s, r) => s + (r.valueApprox || 0), 0) / 20;
  if (avg20Value < 1_000_000_000) return reject('value<1B');

  const avg20Vol  = chartRows.slice(-20).reduce((s, r) => s + (r.volume || 0), 0) / 20;
  const avg60Value = chartRows.slice(-60).reduce((s, r) => s + (r.valueApprox || 0), 0) / 60;
  const todayValue = today.valueApprox || (today.close * today.volume);
  const volumeRatio20 = today.volume / (avg20Vol || 1);
  const valueRatio20  = todayValue / (avg20Value || 1);
  const valueDryness  = avg20Value / (avg60Value || 1);

  // v2: 거래량/거래대금 기본
  if (volumeRatio20 < 1.5) return reject('volRatio20<1.5');
  if (valueRatio20 < 1.5) return reject('valRatio20<1.5');
  if (valueDryness > 1.2) return reject('dryness>1.2');

  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  if (todayReturn < 0) return reject('todayReturn<0');  // v2: 양봉만
  if (todayReturn > 0.05) return reject('todayReturn>5%');

  const ret5d  = idx >= 5  ? (close / chartRows[idx - 5].close  - 1) : 0;
  const ret20d = idx >= 20 ? (close / chartRows[idx - 20].close - 1) : 0;
  if (ret5d > 0.08) return reject('ret5d>8%');
  if (ret20d > 0.15) return reject('ret20d>15%');

  const rangeToday = today.high - today.low || 1;
  const closeLocation = (close - today.low) / rangeToday;
  if (closeLocation < 0.55) return reject('closeLocation<0.55');  // v2: 종가 위치 >= 55%

  const upperWick = today.high > today.close ? today.high - today.close : 0;
  const bodyRange = Math.abs(today.close - today.open) || 1;
  const upperWickRatio = upperWick / bodyRange;
  if (upperWickRatio > 0.45) return reject('upperWick>0.45');

  const { atr } = computeATR(chartRows, idx, 14);
  const atrPct = atr / close;
  if (atrPct > 0.30) return reject('atr%>30%');

  // v2: 구조 확인 강화 (종가 > 전일 종가 required)
  const prevClose = idx > 0 ? chartRows[idx - 1]?.close : close;
  if (close < prevClose) return reject('close<prevClose');

  const ma20 = sma(chartRows.slice(-20).map(r => r.close), 20);
  const ma60 = chartRows.length >= 60 ? sma(chartRows.slice(-60).map(r => r.close), 60) : null;
  const hasStructure = (ma20 != null && close >= ma20 * 0.95) || (ma60 != null && close >= ma60 * 0.92);
  if (!hasStructure) return reject('structure_broken');

  return {
    passed: true,
    signals: {
      volumeRatio20: +(volumeRatio20.toFixed(2)),
      valueRatio20: +(valueRatio20.toFixed(2)),
      valueDryness: +(valueDryness.toFixed(2)),
      todayReturn: +(todayReturn * 100).toFixed(2),
      ret5d: +(ret5d * 100).toFixed(2),
      ret20d: +(ret20d * 100).toFixed(2),
      closeLocation: +(closeLocation.toFixed(2)),
      upperWickRatio: +(upperWickRatio.toFixed(2)),
      atrPct: +(atrPct * 100).toFixed(2),
      avg20Value,
    },
  };
}

// 옛 PREMIUM/FRESH 점수 모델용 14-feature 추출기 — 모델 자체는 폐기됐지만
// app.js 의 handleSearch (상세 페이지) 가 아직 참조해서 stub 으로 빈 객체 반환.
// EJS 의 <%= features.x %> 는 모두 빈 문자열 출력 → 페이지 안 깨짐.
function extractPreIgnitionFeatures(_rows, _idx, _marketCap, _sharesOut) {
  return {};
}

// ─── backtestQVA — QVA 모델 포괄적 백테스트 ───
async function backtestQVA(options = {}) {
  const { daysBack = 100 } = options;

  // 헬퍼: 지표 계산
  const calcStats = (returns) => {
    if (!returns.length) {
      return { n: 0, d5: 0, d10: 0, d20: 0, d40: 0, MFE10: 0, MFE20: 0, MFE40: 0,
               MAE10: 0, MAE20: 0, hit10: 0, hit20: 0, hit3pct10: 0, hit3pct20: 0, winRate: 0, PF: 0, worst: 0,
               csbConv5d: 0, csbConv10d: 0, csbConv20d: 0, vviConv20d: 0 };
    }

    const d5s = returns.map(r => r.d5), d10s = returns.map(r => r.d10), d20s = returns.map(r => r.d20), d40s = returns.map(r => r.d40);
    const MFE10s = returns.map(r => r.MFE10), MFE20s = returns.map(r => r.MFE20), MFE40s = returns.map(r => r.MFE40);
    const MAE10s = returns.map(r => r.MAE10), MAE20s = returns.map(r => r.MAE20);
    const hit10s = returns.map(r => r.hit10), hit20s = returns.map(r => r.hit20);
    const hit3pct10s = returns.map(r => r.hit3pct10), hit3pct20s = returns.map(r => r.hit3pct20);
    const csbConv5ds = returns.map(r => r.csbConv5d), csbConv10ds = returns.map(r => r.csbConv10d), csbConv20ds = returns.map(r => r.csbConv20d);
    const vviConv20ds = returns.map(r => r.vviConv20d);

    const wins = returns.filter(r => r.d20 > 0), losses = returns.filter(r => r.d20 <= 0);
    const avgWin = wins.length ? wins.reduce((s, r) => s + r.d20, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, r) => s + r.d20, 0) / losses.length) : 0;

    return {
      n: returns.length,
      d5: +(d5s.reduce((a,b)=>a+b,0)/d5s.length*100).toFixed(2),
      d10: +(d10s.reduce((a,b)=>a+b,0)/d10s.length*100).toFixed(2),
      d20: +(d20s.reduce((a,b)=>a+b,0)/d20s.length*100).toFixed(2),
      d40: +(d40s.reduce((a,b)=>a+b,0)/d40s.length*100).toFixed(2),
      MFE10: +(MFE10s.reduce((a,b)=>a+b,0)/MFE10s.length*100).toFixed(2),
      MFE20: +(MFE20s.reduce((a,b)=>a+b,0)/MFE20s.length*100).toFixed(2),
      MFE40: +(MFE40s.reduce((a,b)=>a+b,0)/MFE40s.length*100).toFixed(2),
      MAE10: +(MAE10s.reduce((a,b)=>a+b,0)/MAE10s.length*100).toFixed(2),
      MAE20: +(MAE20s.reduce((a,b)=>a+b,0)/MAE20s.length*100).toFixed(2),
      hit10: +(hit10s.filter(h=>h).length/hit10s.length*100).toFixed(1),
      hit20: +(hit20s.filter(h=>h).length/hit20s.length*100).toFixed(1),
      hit3pct10: +(hit3pct10s.filter(h=>h).length/hit3pct10s.length*100).toFixed(1),
      hit3pct20: +(hit3pct20s.filter(h=>h).length/hit3pct20s.length*100).toFixed(1),
      csbConv5d: +(csbConv5ds.filter(c=>c).length/csbConv5ds.length*100).toFixed(1),
      csbConv10d: +(csbConv10ds.filter(c=>c).length/csbConv10ds.length*100).toFixed(1),
      csbConv20d: +(csbConv20ds.filter(c=>c).length/csbConv20ds.length*100).toFixed(1),
      vviConv20d: +(vviConv20ds.filter(c=>c).length/vviConv20ds.length*100).toFixed(1),
      winRate: +(wins.length/returns.length*100).toFixed(1),
      PF: avgLoss > 0 ? +(avgWin/avgLoss).toFixed(2) : 0,
      worst: +(Math.min(...d40s)*100).toFixed(2),
    };
  };

  const results = {
    baseline: calcStats([]),
    qvaStrict: calcStats([]),
    qvaBase: calcStats([]),
    qvaLoose: calcStats([]),
    qvaV2: calcStats([]),
    qvaEvolution: calcStats([]),
    qvaHold: calcStats([]),
    qvaHigherLow: calcStats([]),
    byMarket: { KOSPI: { qvaBase: calcStats([]), qvaV2: calcStats([]), qvaEvolution: calcStats([]) }, KOSDAQ: { qvaBase: calcStats([]), qvaV2: calcStats([]), qvaEvolution: calcStats([]) } },
    processed: 0, signals: { strict: 0, base: 0, loose: 0, v2: 0, evolution: 0, hold: 0, higherLow: 0 },
  };

  try {
    const rootDir = __dirname;
    const LONG_STOCKS = path.join(rootDir, 'cache', 'stock-charts-long');
    const stocksFile = path.join(rootDir, 'cache', 'naver-stocks-list.json');

    if (!fs.existsSync(LONG_STOCKS)) throw new Error(`LONG_STOCKS not found: ${LONG_STOCKS}`);
    if (!fs.existsSync(stocksFile)) throw new Error(`stocksFile not found: ${stocksFile}`);

    const stocksData = JSON.parse(fs.readFileSync(stocksFile, 'utf-8'));
    const stockMap = {};
    (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

    let baselineReturns = [], strictReturns = [], baseReturns = [], looseReturns = [], v2Returns = [];
    let evolutionReturns = [], holdReturns = [], higherLowReturns = [];
    let kospiBase = [], kosdaqBase = [], kospiV2 = [], kosdaqV2 = [], kospiEvolution = [], kosdaqEvolution = [];

    // 장기 데이터 (120일+) 종목에서만 테스트
    const files = fs.readdirSync(LONG_STOCKS).filter(f => f.endsWith('.json'));
    console.error(`[backtestQVA] Files found: ${files.length}, stockMap size: ${Object.keys(stockMap).length}`);

    for (const file of files) {
      const code = file.replace('.json', '');
      const stock = stockMap[code];
      if (!stock) continue;

      let chart;
      try {
        chart = JSON.parse(fs.readFileSync(path.join(LONG_STOCKS, file), 'utf-8'));
      } catch (_) { continue; }

      const rows = chart.rows || [];
      if (rows.length < 60 + 40) continue;  // 최소 100일: 60일 데이터 + 40일 미래

      // 최근 최대 100일에서 신호 스캔 (장기 데이터는 최대 120일)
      const daysToScan = Math.min(daysBack, rows.length - 40);
      const startIdx = Math.max(0, rows.length - daysToScan);
      for (let i = startIdx; i < rows.length - 40; i++) {
        const signalRow = rows[i];
        const histRows = rows.slice(0, i + 1);

        // 7가지 모델 계산
        let qvaStrict = null, qvaBase = null, qvaLoose = null, qvaV2 = null, qvaEvolution = null, qvaHold = null, qvaHigherLow = null;
        try {
          qvaStrict = calculateQuietVolumeAnomalyStrict(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
          qvaBase = calculateQuietVolumeAnomaly(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
          qvaLoose = calculateQuietVolumeAnomalyLoose(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
          qvaV2 = calculateQuietVolumeAnomalyV2(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
          qvaEvolution = calculateQvaEvolution(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
          qvaHold = calculateQuietVolumeHold(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
          qvaHigherLow = calculateQuietVolumeHigherLow(histRows, [], { code, marketValue: stock.marketValue, isEtf: stock.isEtf });
        } catch (_) {}

        // d5, d10, d20, d40 계산
        const getReturn = (days) => {
          const futureIdx = Math.min(i + days, rows.length - 1);
          if (futureIdx <= i) return 0;
          const futureClose = rows[futureIdx]?.close || signalRow.close;
          return futureClose / signalRow.close - 1;
        };

        const getMFE = (days) => {
          let mfe = 0;
          for (let j = i + 1; j <= Math.min(i + days, rows.length - 1); j++) {
            const high = rows[j]?.high || rows[j]?.close;
            mfe = Math.max(mfe, (high - signalRow.close) / signalRow.close);
          }
          return mfe;
        };

        const getMAE = (days) => {
          let mae = 0;
          for (let j = i + 1; j <= Math.min(i + days, rows.length - 1); j++) {
            const low = rows[j]?.low || rows[j]?.close;
            mae = Math.min(mae, (low - signalRow.close) / signalRow.close);
          }
          return mae;
        };

        // 전환 지표 계산 (3% 이상 도달, 고가 기반)
        const getHit3pct = (days) => {
          let maxHigh = signalRow.close;
          for (let j = i + 1; j <= Math.min(i + days, rows.length - 1); j++) {
            maxHigh = Math.max(maxHigh, rows[j]?.high || rows[j]?.close);
          }
          return (maxHigh / signalRow.close - 1) >= 0.03;
        };

        // CSB 전환 지표 (MFE20 >= 5% 도달)
        const getCsbConversion = (days) => {
          const mfe = getMFE(days);
          return mfe >= 0.05;
        };

        // VVI 전환 지표 (고변동성 + 거래량 폭발 신호)
        const getVviConversion = (days) => {
          const futureRows = rows.slice(Math.max(0, i + 1), Math.min(i + 1 + days, rows.length));
          if (futureRows.length < 3) return false;
          const volatility = (Math.max(...futureRows.map(r => r.high)) - Math.min(...futureRows.map(r => r.low))) / signalRow.close;
          const avgVol = futureRows.reduce((s, r) => s + (r.volume || 0), 0) / futureRows.length;
          const baselineVol = Math.max(...histRows.slice(-20).map(r => r.volume || 0));
          return volatility > 0.08 && avgVol > baselineVol * 1.5;
        };

        const ret = {
          d5: getReturn(5), d10: getReturn(10), d20: getReturn(20), d40: getReturn(40),
          MFE10: getMFE(10), MFE20: getMFE(20), MFE40: getMFE(40),
          MAE10: getMAE(10), MAE20: getMAE(20),
          hit10: getReturn(10) > 0 ? 1 : 0, hit20: getReturn(20) > 0 ? 1 : 0,
          hit3pct10: getHit3pct(10) ? 1 : 0, hit3pct20: getHit3pct(20) ? 1 : 0,
          csbConv5d: getCsbConversion(5) ? 1 : 0, csbConv10d: getCsbConversion(10) ? 1 : 0, csbConv20d: getCsbConversion(20) ? 1 : 0,
          vviConv20d: getVviConversion(20) ? 1 : 0,
        };

        baselineReturns.push(ret);
        if (qvaStrict?.passed) { strictReturns.push(ret); results.signals.strict++; }
        if (qvaBase?.passed) {
          baseReturns.push(ret); results.signals.base++;
          if (stock.market === 'KOSPI') kospiBase.push(ret);
          else if (stock.market === 'KOSDAQ') kosdaqBase.push(ret);
        }
        if (qvaLoose?.passed) { looseReturns.push(ret); results.signals.loose++; }
        if (qvaV2?.passed) {
          v2Returns.push(ret); results.signals.v2++;
          if (stock.market === 'KOSPI') kospiV2.push(ret);
          else if (stock.market === 'KOSDAQ') kosdaqV2.push(ret);
        }
        if (qvaEvolution?.passed) {
          evolutionReturns.push(ret); results.signals.evolution++;
          if (stock.market === 'KOSPI') kospiEvolution.push(ret);
          else if (stock.market === 'KOSDAQ') kosdaqEvolution.push(ret);
        }
        if (qvaHold?.passed) { holdReturns.push(ret); results.signals.hold++; }
        if (qvaHigherLow?.passed) { higherLowReturns.push(ret); results.signals.higherLow++; }
      }

      results.processed++;
    }

    results.baseline = calcStats(baselineReturns);
    results.qvaStrict = calcStats(strictReturns);
    results.qvaBase = calcStats(baseReturns);
    results.qvaLoose = calcStats(looseReturns);
    results.qvaV2 = calcStats(v2Returns);
    results.qvaEvolution = calcStats(evolutionReturns);
    results.qvaHold = calcStats(holdReturns);
    results.qvaHigherLow = calcStats(higherLowReturns);
    results.byMarket.KOSPI.qvaBase = calcStats(kospiBase);
    results.byMarket.KOSDAQ.qvaBase = calcStats(kosdaqBase);
    results.byMarket.KOSPI.qvaV2 = calcStats(kospiV2);
    results.byMarket.KOSDAQ.qvaV2 = calcStats(kosdaqV2);
    results.byMarket.KOSPI.qvaEvolution = calcStats(kospiEvolution);
    results.byMarket.KOSDAQ.qvaEvolution = calcStats(kosdaqEvolution);

  } catch (e) {
    console.error('[backtestQVA]', e.message);
  }

  return results;
}

module.exports = {
  checkTrendTemplate,
  computeRS,
  detectVCP,
  detectBreakout,
  detectStage1to2,
  computeATR,
  analyzeAll,
  backtestMinervini,
  backtestTotalScore,
  backtestQVA,
  listSeededStocks,
  fetchKospiHistory,
  getKospiCached,
  fetchKosdaqHistory,
  getKosdaqCached,
  calculateFlowLeadScore,
  calculateFlowLeadScoreV2,
  flowLeadV2Universe,
  calculateFlowLeadScoreV3,
  flowLeadV3CompressionUniverse,
  calculateFlowLeadScoreV4,
  flowLeadV4IgnitionUniverse,
  calculateCompressionSupportBreakoutScore,
  compressionSupportBreakoutUniverse,
  calculateCompressionSupportBreakoutScoreV2,
  compressionSupportBreakoutUniverseV2,
  buildCsbTradePlan,
  calculateReboundScore,
  calculateVolumeValueIgnition,
  calculateQuietVolumeAnomaly,
  calculateQuietVolumeAnomalyStrict,
  calculateQuietVolumeAnomalyLoose,
  calculateQuietVolumeAnomalyV2,
  calculateQuietVolumeFirst,
  calculateQuietVolume2Day,
  calculateQuietVolumeAbsorb,
  calculateQvaEvolution,
  calculateQuietVolumeHigherLow,
  calculateQuietVolumeHold,
  extractPreIgnitionFeatures,
};
