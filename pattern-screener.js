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
  const overheatWarnings = [];
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
    let flowLead = null, rebound = null;
    if (flowRows?.length >= 10) {
      try { flowLead = calculateFlowLeadScore(rows, flowRows, meta); } catch (_) {}
      try { rebound = calculateReboundScore(rows, flowRows, meta); } catch (_) {}
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
    // 모델 통과
    if (flowLead?.passed) tags.push("FLOW_LEAD");
    if (rebound?.passed) tags.push("REBOUND");
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

    // primary tag — 카테고리 분류 우선순위
    //   FLOW_LEAD > REBOUND > BULL_TREND_WATCH > OVERHEAT_WARNING > 그 외
    const primaryOrder = ["FLOW_LEAD", "REBOUND", "BULL_TREND_WATCH", "OVERHEAT_WARNING", "HIGH_VOLATILITY", "STRUCTURE_BROKEN", "NO_SIGNAL"];
    const primaryTag = primaryOrder.find((t) => tags.includes(t));

    const tagged = {
      code, name: meta.name, market: meta.market,
      marketCap: meta.marketValue,
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
      tags,
      primaryTag,
    };
    taggedAll.push(tagged);

    if (flowLead?.passed) flowLeadCandidates.push(tagged);
    if (rebound?.passed) reboundCandidates.push(tagged);
    if (overheatHit) overheatWarnings.push(tagged);
  }

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

  const result = {
    analyzedAt: new Date().toISOString(),
    seeded: seededCodes.length,
    processed,
    marketDetail,
    marketRegime,

    // ─── 새 카테고리 (Phase 8) ───
    flowLeadCandidates: flowLeadCandidates.sort((a, b) => (b.flowLead?.score || 0) - (a.flowLead?.score || 0)),
    flowLeadCount: flowLeadCandidates.length,
    reboundCandidates: reboundCandidates.sort((a, b) => (b.rebound?.score || 0) - (a.rebound?.score || 0)),
    reboundCount: reboundCandidates.length,
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

// 옛 PREMIUM/FRESH 점수 모델용 14-feature 추출기 — 모델 자체는 폐기됐지만
// app.js 의 handleSearch (상세 페이지) 가 아직 참조해서 stub 으로 빈 객체 반환.
// EJS 의 <%= features.x %> 는 모두 빈 문자열 출력 → 페이지 안 깨짐.
function extractPreIgnitionFeatures(_rows, _idx, _marketCap, _sharesOut) {
  return {};
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
  listSeededStocks,
  fetchKospiHistory,
  getKospiCached,
  fetchKosdaqHistory,
  getKosdaqCached,
  calculateFlowLeadScore,
  calculateReboundScore,
  extractPreIgnitionFeatures,
};
