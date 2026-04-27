// 패턴 스크리너 — +40% 상승 이벤트 추출 + 점화점 분석.
//
// 입력: 종목별 일봉 데이터 (cache/stock-charts/<code>.json)
// 출력: 이벤트 리스트 + 점화 전 지표 + 버킷별 분포
//
// 핵심 알고리즘:
// 1. detectRiseEvents — local low → +40% 상승 이벤트 추출
// 2. detectFailedEvents — local low 였는데 +15~30% 정도만 오른 (실패 케이스, survivorship counter)
// 3. extractPreIgnitionFeatures — 점화 -20일 ~ -1일 사이 6개 지표
// 4. classifyMarketRegime — KOSPI 60일 SMA 기준 강세/횡보/약세
// 5. bucketByDuration — A(≤30) / B(31~50) / C(51~70) / D(71~90)

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CACHE_DIR = path.join(__dirname, "cache", "stock-charts");
const KOSPI_CACHE = path.join(__dirname, "cache", "kospi-daily.json");
const PATTERN_RESULT_CACHE = path.join(__dirname, "cache", "pattern-result.json");
const H = { "User-Agent": "Mozilla/5.0" };

// ─────────── 로컬 저점 / 고점 ───────────

function findLocalLows(rows, halfWindow = 5) {
  const lows = [];
  for (let i = halfWindow; i < rows.length - halfWindow; i++) {
    let isLow = true;
    for (let j = i - halfWindow; j <= i + halfWindow; j++) {
      if (j !== i && rows[j].low <= rows[i].low) { isLow = false; break; }
    }
    if (isLow) lows.push(i);
  }
  return lows;
}

// ─────────── 이벤트 추출 ───────────

// 성공 이벤트: 로컬 저점 → 90일 안에 +40% 이상
function detectRiseEvents(rows, {
  threshold = 0.40, maxDuration = 90, pullbackPct = 0.08, halfWindow = 5,
} = {}) {
  if (!rows || rows.length < 30) return [];
  const lows = findLocalLows(rows, halfWindow);
  const candidates = [];

  for (const lowIdx of lows) {
    const lowPrice = rows[lowIdx].low;
    if (lowPrice <= 0) continue;
    let peakIdx = -1, peakPrice = lowPrice;
    let confirmed = false;
    let inProgress = false;

    const maxJ = Math.min(lowIdx + maxDuration + 1, rows.length);
    for (let j = lowIdx + 1; j < maxJ; j++) {
      if (rows[j].high > peakPrice) {
        peakPrice = rows[j].high;
        peakIdx = j;
      }
      if (peakPrice >= lowPrice * (1 + threshold)) {
        const pulledBack = rows[j].close < peakPrice * (1 - pullbackPct);
        const lastDay = j === maxJ - 1;
        if (pulledBack) { confirmed = true; break; }
        if (lastDay) { confirmed = true; inProgress = true; break; }
      }
    }
    if (confirmed && peakIdx > lowIdx) {
      candidates.push({
        ignitionIdx: lowIdx,
        ignitionDate: rows[lowIdx].date,
        ignitionPrice: lowPrice,
        peakIdx,
        peakDate: rows[peakIdx].date,
        peakPrice,
        magnitude: (peakPrice / lowPrice) - 1,
        duration: peakIdx - lowIdx,
        inProgress,
      });
    }
  }

  // dedup: 같은 peakIdx → 가장 큰 magnitude
  const byPeak = new Map();
  for (const e of candidates) {
    const existing = byPeak.get(e.peakIdx);
    if (!existing || e.magnitude > existing.magnitude) byPeak.set(e.peakIdx, e);
  }
  return Array.from(byPeak.values()).sort((a, b) => a.ignitionIdx - b.ignitionIdx);
}

// 실패 이벤트: 로컬 저점 → 90일 안에 +15~30% 만 (40% 못 미침)
function detectFailedEvents(rows, {
  minRise = 0.15, maxRise = 0.30, maxDuration = 90, halfWindow = 5,
} = {}) {
  if (!rows || rows.length < 30) return [];
  const lows = findLocalLows(rows, halfWindow);
  const events = [];

  for (const lowIdx of lows) {
    const lowPrice = rows[lowIdx].low;
    if (lowPrice <= 0) continue;
    let peakIdx = lowIdx, peakPrice = lowPrice;
    const maxJ = Math.min(lowIdx + maxDuration + 1, rows.length);
    for (let j = lowIdx + 1; j < maxJ; j++) {
      if (rows[j].high > peakPrice) {
        peakPrice = rows[j].high;
        peakIdx = j;
      }
    }
    const magnitude = (peakPrice / lowPrice) - 1;
    if (magnitude >= minRise && magnitude <= maxRise) {
      events.push({
        ignitionIdx: lowIdx,
        ignitionDate: rows[lowIdx].date,
        ignitionPrice: lowPrice,
        peakIdx,
        peakDate: rows[peakIdx].date,
        peakPrice,
        magnitude,
        duration: peakIdx - lowIdx,
      });
    }
  }
  return events;
}

// ─────────── 점화 전 지표 ───────────

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

function calcAtr(rows, period = 14) {
  if (rows.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const tr = Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close)
    );
    trs.push(tr);
  }
  return avg(trs.slice(-period));
}

// 점화 idx 기준 [-20, -1] 구간의 6개 지표
function extractPreIgnitionFeatures(rows, ignitionIdx, marketCap, listedShares) {
  const N = 20;
  const start = Math.max(0, ignitionIdx - N);
  const window = rows.slice(start, ignitionIdx); // -20 ~ -1
  if (window.length < 5) return null;

  const ignitionRow = rows[ignitionIdx];
  // 시총 추정 — 시총 / 종가 → 상장주식수 → 그날 종가 × 상장주식수
  const sharesOut = listedShares || (marketCap && rows[rows.length - 1].close > 0
    ? marketCap / rows[rows.length - 1].close
    : null);

  // 1. 회전율: -20~-1 거래대금 / 점화일 시총
  const totalValue = sum(window.map((r) => r.valueApprox || 0));
  const ignitionMcap = sharesOut ? Math.round(ignitionRow.close * sharesOut) : marketCap;
  const turnover = ignitionMcap > 0 ? totalValue / ignitionMcap : 0;

  // 2. 양봉/음봉 거래대금 비율 (매수 우세도)
  const bullValue = sum(window.filter((r) => r.close > r.open).map((r) => r.valueApprox || 0));
  const bearValue = sum(window.filter((r) => r.close < r.open).map((r) => r.valueApprox || 0));
  const bullBearRatio = bearValue > 0 ? bullValue / bearValue : (bullValue > 0 ? 99 : 1);

  // 3. 거래량 급증: 마지막 5일 평균 / 직전 60일 평균
  const last5Vol = avg(window.slice(-5).map((r) => r.volume));
  const ref60Start = Math.max(0, ignitionIdx - 60);
  const ref60 = rows.slice(ref60Start, ignitionIdx - 5);
  const ref60Avg = avg(ref60.map((r) => r.volume));
  const volumeSurge = ref60Avg > 0 ? last5Vol / ref60Avg : 1;

  // 4. 외인 보유율 변화 (마지막 - 시작)
  const firstFr = window.find((r) => Number.isFinite(r.foreignRate))?.foreignRate;
  const lastFr = [...window].reverse().find((r) => Number.isFinite(r.foreignRate))?.foreignRate;
  const foreignDelta = (firstFr != null && lastFr != null) ? (lastFr - firstFr) : null;

  // 5. 변동성 수렴: 마지막 5일 ATR / 20일 ATR
  const atr20 = calcAtr(window, 14);
  const atr5 = calcAtr(window.slice(-5), 4);
  const atrCompress = atr20 > 0 ? atr5 / atr20 : 1;

  // 6. 60일 고점 대비 위치: 점화일 가격 / 직전 60일 고점
  const high60 = Math.max(...rows.slice(ref60Start, ignitionIdx).map((r) => r.high || 0));
  const positionPct = high60 > 0 ? ignitionRow.close / high60 : 1;

  // 6-2. 60일 저점 대비 상승률: 점화일 가격 / 직전 60일 저점 (1.0 = 저점, 1.5 = 저점 +50%)
  const lowsForRange = rows.slice(ref60Start, ignitionIdx).map((r) => r.low).filter((v) => v > 0);
  const low60 = lowsForRange.length ? Math.min(...lowsForRange) : null;
  const positionFromLow = low60 ? ignitionRow.close / low60 : null;

  // 7~8. 이평선 위치: 점화일 종가 / 20·60일 SMA
  const closes20 = window.map((r) => r.close).filter((v) => Number.isFinite(v) && v > 0);
  const ma20 = closes20.length >= 5 ? avg(closes20) : null;
  const ref60ForMa = rows.slice(ref60Start, ignitionIdx).map((r) => r.close).filter((v) => Number.isFinite(v) && v > 0);
  const ma60 = ref60ForMa.length >= 20 ? avg(ref60ForMa) : null;
  const maPos20 = ma20 ? ignitionRow.close / ma20 : null;
  const maPos60 = ma60 ? ignitionRow.close / ma60 : null;

  // 8-2. MA60 slope — 60일선이 상승 중인지 하락 중인지 (= 점화 직전 추세 방향)
  // today 의 MA60 / 30일 전 시점에서 본 MA60. 1.0 = 평탄, > 1.0 = 우상향, < 1.0 = 우하향.
  const ref90Start = Math.max(0, ignitionIdx - 90);
  const ma60PastSlice = rows.slice(ref90Start, Math.max(0, ignitionIdx - 30)).map((r) => r.close).filter((v) => v > 0);
  const ma60Past = ma60PastSlice.length >= 20 ? avg(ma60PastSlice) : null;
  const ma60Slope = (ma60 && ma60Past && ma60Past > 0) ? ma60 / ma60Past : null;

  // 8-3. MA20 slope — 20일선 추세
  const ma20PastSlice = rows.slice(Math.max(0, ignitionIdx - 40), Math.max(0, ignitionIdx - 20)).map((r) => r.close).filter((v) => v > 0);
  const ma20Past = ma20PastSlice.length >= 10 ? avg(ma20PastSlice) : null;
  const ma20Slope = (ma20 && ma20Past && ma20Past > 0) ? ma20 / ma20Past : null;

  // 9. 매물대: 60일 OHLC 거래량 가중 24-bin 히스토그램에서 점화일 종가 위쪽 비율 + 점화가 ±5% 매물 밀도
  const ref60Rows = rows.slice(ref60Start, ignitionIdx);
  let resistAbove = null;
  let localResistance = null;
  if (ref60Rows.length >= 20) {
    const lows = ref60Rows.map((r) => r.low).filter((v) => Number.isFinite(v) && v > 0);
    const highs = ref60Rows.map((r) => r.high).filter((v) => Number.isFinite(v) && v > 0);
    if (lows.length && highs.length) {
      const minP = Math.min(...lows);
      const maxP = Math.max(...highs);
      const range = maxP - minP;
      if (range > 0) {
        const BINS = 24;
        const bins = new Array(BINS).fill(0);
        for (const r of ref60Rows) {
          if (!(r.low > 0 && r.high > 0 && r.volume > 0)) continue;
          const bLow = Math.min(BINS - 1, Math.max(0, Math.floor((r.low - minP) / range * BINS)));
          const bHigh = Math.min(BINS - 1, Math.max(0, Math.floor((r.high - minP) / range * BINS)));
          const span = Math.max(1, bHigh - bLow + 1);
          for (let b = bLow; b <= bHigh; b++) bins[b] += r.volume / span;
        }
        const totalV = sum(bins);
        if (totalV > 0) {
          const igniteBin = Math.min(BINS - 1, Math.max(0, Math.floor((ignitionRow.close - minP) / range * BINS)));
          const above = sum(bins.slice(igniteBin + 1));
          resistAbove = above / totalV;
          // 점화가 ±5% 가격대 매물 밀도 (가격기준 ±5% → bin 단위 환산)
          const bandFrac = 0.05 * ignitionRow.close / range; // 가격 ±5%가 range 의 몇 비율
          const bandBins = Math.max(1, Math.round(bandFrac * BINS));
          const localStart = Math.max(0, igniteBin - bandBins);
          const localEnd = Math.min(BINS - 1, igniteBin + bandBins);
          const local = sum(bins.slice(localStart, localEnd + 1));
          localResistance = local / totalV;
        }
      }
    }
  }

  // 10. 박스권 횡보: 점화 직전 N일 동안 일일 변동폭 (high-low)/close ≤ 4% 인 연속 일수 (최대 30)
  let boxDays = 0;
  for (let i = ignitionIdx - 1; i >= Math.max(0, ignitionIdx - 30); i--) {
    const r = rows[i];
    if (!(r.close > 0)) break;
    const rangePct = (r.high - r.low) / r.close;
    if (rangePct <= 0.04) boxDays++;
    else break;
  }

  // 11. 점화일 거래대금 / 시총 (점화일 단독)
  const igniteValueRatio = ignitionMcap > 0 ? (ignitionRow.valueApprox || 0) / ignitionMcap : 0;

  // 12. 점화일 거래량 / 직전 20일 평균 거래량
  const ref20Vols = window.map((r) => r.volume).filter((v) => Number.isFinite(v) && v > 0);
  const ref20VolAvg = ref20Vols.length ? avg(ref20Vols) : 0;
  const igniteVolumeRatio = ref20VolAvg > 0 ? (ignitionRow.volume || 0) / ref20VolAvg : 0;

  return {
    turnover: Number(turnover.toFixed(3)),                  // 0~1+ (1 = 시총만큼 거래대금)
    bullBearRatio: Number(bullBearRatio.toFixed(2)),        // 1 미만 = 매도 우세, 1 초과 = 매수 우세
    volumeSurge: Number(volumeSurge.toFixed(2)),            // 1 = 평소 수준, 2+ = 급증
    foreignDelta: foreignDelta != null ? Number(foreignDelta.toFixed(2)) : null,
    atrCompress: Number(atrCompress.toFixed(2)),            // 1 미만 = 변동성 수렴
    positionPct: Number(positionPct.toFixed(3)),            // 1 = 60일 고점, 0.5 = 절반
    positionFromLow: positionFromLow != null ? Number(positionFromLow.toFixed(3)) : null,  // 1.0 = 저점, 1.5 = 저점 +50%
    maPos20: maPos20 != null ? Number(maPos20.toFixed(3)) : null,    // 1 = 20일선 위, <1 = 아래
    maPos60: maPos60 != null ? Number(maPos60.toFixed(3)) : null,    // 1 = 60일선 위, <1 = 아래
    ma20Slope: ma20Slope != null ? Number(ma20Slope.toFixed(3)) : null, // 20일선 기울기 (1.0 = 평탄)
    ma60Slope: ma60Slope != null ? Number(ma60Slope.toFixed(3)) : null, // 60일선 기울기 — 점화 전 추세 방향
    resistAbove: resistAbove != null ? Number(resistAbove.toFixed(3)) : null,  // 0 = 위쪽 매물대 없음, 1 = 모두 위
    localResistance: localResistance != null ? Number(localResistance.toFixed(3)) : null,  // 점화가 ±5% 매물 밀도
    boxDays,                                                 // 0~30 (점화 직전 좁은 변동폭 연속일)
    igniteValueRatio: Number(igniteValueRatio.toFixed(4)),  // 점화일 거래대금/시총
    igniteVolumeRatio: Number(igniteVolumeRatio.toFixed(2)),// 점화일 거래량 / 20일평균
  };
}

// ─────────── 시장 국면 ───────────

async function fetchKospiHistory(count = 130) {
  // 네이버 KOSPI 인덱스 일봉
  const url = `https://api.stock.naver.com/chart/domestic/index/KOSPI?periodType=dayCandle&count=${count}`;
  const r = await axios.get(url, { headers: H, timeout: 15000 });
  const rows = (r.data.priceInfos || []).map((p) => ({
    date: String(p.localDate || ""),
    close: Number(p.closePrice) || 0,
  })).sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

async function getKospiCached() {
  try {
    const data = JSON.parse(fs.readFileSync(KOSPI_CACHE, "utf-8"));
    if (data && Date.now() - data.fetchedAt < 24 * 60 * 60 * 1000) return data.rows;
  } catch (_) {}
  const rows = await fetchKospiHistory(130);
  fs.writeFileSync(KOSPI_CACHE, JSON.stringify({ fetchedAt: Date.now(), rows }));
  return rows;
}

function classifyMarketRegime(kospiRows, dateStr) {
  // ignition 일 기준 KOSPI 60일 SMA 비교
  const idx = kospiRows.findIndex((r) => r.date >= dateStr);
  if (idx < 60) return "unknown";
  const recent60 = kospiRows.slice(idx - 60, idx);
  const sma60 = avg(recent60.map((r) => r.close));
  const todayClose = kospiRows[idx].close;
  if (todayClose > sma60 * 1.03) return "강세";
  if (todayClose < sma60 * 0.97) return "약세";
  return "횡보";
}

// ─────────── 버킷 ───────────

function bucketByDuration(events) {
  const buckets = { A: [], B: [], C: [], D: [] };
  for (const e of events) {
    const d = e.duration;
    if (d <= 30) buckets.A.push(e);
    else if (d <= 50) buckets.B.push(e);
    else if (d <= 70) buckets.C.push(e);
    else if (d <= 90) buckets.D.push(e);
  }
  return buckets;
}

// 분포 통계
function quantile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

const FEATURE_KEYS = [
  "turnover", "bullBearRatio", "volumeSurge", "foreignDelta", "atrCompress",
  "positionPct", "positionFromLow",
  "maPos20", "maPos60", "ma20Slope", "ma60Slope",
  "resistAbove", "localResistance",
  "boxDays", "igniteValueRatio", "igniteVolumeRatio",
];

function summarizeFeatures(events) {
  if (!events.length) return null;
  const keys = FEATURE_KEYS;
  const summary = {};
  for (const k of keys) {
    const vals = events.map((e) => e.features?.[k]).filter((v) => Number.isFinite(v));
    if (vals.length) {
      summary[k] = {
        n: vals.length,
        mean: Number(avg(vals).toFixed(3)),
        p25: Number(Number(quantile(vals, 0.25)).toFixed(3)),
        median: Number(Number(quantile(vals, 0.5)).toFixed(3)),
        p75: Number(Number(quantile(vals, 0.75)).toFixed(3)),
      };
    } else summary[k] = null;
  }
  return summary;
}

// ─────────── Phase B-6: 시동 단계 품질 평가 ───────────
// 시동 단계 (5~10%) 후보 중 진짜 "조기 시그널" vs 추격 의심 분리.
// 3가지 필터: ① 5일내 fade 없음 ② 종가위치 ≥ 0.5 ③ 7일 base 진폭 ≤ 6%
function evaluateStartingQuality(rows, mover) {
  if (!rows || rows.length < 10) return null;
  const last = rows.length - 1;
  const flags = [];

  // ① 직전 5일에 -3% 이상 fade 없음 (fade-retry 차단)
  let fadePct = 0;
  for (let i = Math.max(1, last - 4); i < last; i++) {
    const r = rows[i];
    const prev = rows[i - 1];
    if (!prev || !(prev.close > 0)) continue;
    const change = (r.close - prev.close) / prev.close;
    if (change < fadePct) fadePct = change;
  }
  if (fadePct > -0.03) flags.push({ ok: true, msg: '5일내 큰 fade 없음 (fresh 시동)' });
  else flags.push({ ok: false, msg: `5일내 ${(fadePct * 100).toFixed(1)}% fade — fade-retry 의심` });

  // ② 종가위치 ≥ 0.5 (강한 마감)
  if (mover.closePos >= 0.5) flags.push({ ok: true, msg: `종가 위쪽 ${Math.round(mover.closePos * 100)}% (강한 마감)` });
  else flags.push({ ok: false, msg: `종가 위쪽 ${Math.round(mover.closePos * 100)}% (위쪽 매물 부담)` });

  // ③ 직전 7일 (오늘 제외) 가격 진폭 ≤ 6% (좁은 base)
  const prior7 = rows.slice(Math.max(0, last - 7), last);
  const highs = prior7.map((r) => r.high).filter((v) => v > 0);
  const lows = prior7.map((r) => r.low).filter((v) => v > 0);
  if (highs.length >= 5 && lows.length >= 5) {
    const hi = Math.max(...highs);
    const lo = Math.min(...lows);
    const range = lo > 0 ? (hi - lo) / lo : 0;
    if (range <= 0.06) flags.push({ ok: true, msg: `7일 base 진폭 ${(range * 100).toFixed(1)}% (좁음)` });
    else flags.push({ ok: false, msg: `7일 base 진폭 ${(range * 100).toFixed(1)}% (변동 큼)` });
  }

  const passCount = flags.filter((f) => f.ok).length;
  let quality;
  if (passCount === 3) quality = "PREMIUM";  // 모든 필터 통과 — 진짜 조기 시그널
  else if (passCount === 2) quality = "FRESH"; // 2개 통과 — 시동 가능성 있음
  else quality = "SUSPECT";                    // 0~1개 — 추격 의심
  return { quality, passCount, flags };
}

// ─────────── Phase B-5: 오늘의 모멘텀 스캐너 ───────────
// SHAPE 매칭과 별개로 *오늘* 큰 가격·거래량 움직임 있는 종목 전체에서 스캔.
// 점화 후 종목 (SHAPE 매칭 아닌) + 시동 종목 (SHAPE 매칭 + 모멘텀) 모두 잡음.
// 내일 상한가 후보의 가장 흔한 baseline 시그널.
function scanTodaysMomentum({
  stocksList,
  minPriceChange = 0.05,   // 5% 이상 상승
  minVolRatio = 3,         // 거래량 3배 이상
  topN = 30,
} = {}) {
  const movers = [];
  for (const meta of stocksList) {
    if (meta.isSpecial) continue;
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, meta.code + ".json"), "utf-8"));
      const rows = cache.rows || [];
      if (rows.length < 25) continue;
      const last = rows.length - 1;
      const today = rows[last];
      const prev = rows[last - 1];
      if (!prev || !(prev.close > 0)) continue;

      const dayChange = (today.close - prev.close) / prev.close;
      const prior20 = rows.slice(last - 20, last).map((r) => r.volume).filter((v) => v > 0);
      const avgVol = prior20.length ? prior20.reduce((a, b) => a + b, 0) / prior20.length : 0;
      const volRatio = avgVol > 0 ? today.volume / avgVol : 0;
      const valuePct = meta.marketValue > 0 ? (today.valueApprox || 0) / meta.marketValue : 0;

      // 둘 중 하나라도 충족 (큰 상승 OR 거래량 폭증)
      if (dayChange < minPriceChange && volRatio < minVolRatio) continue;
      // 일일 상한 (+30%) 초과는 액면분할·무상증자 등 anomaly — 제외
      if (dayChange > 0.31) continue;

      // 종가 위치 — 1.0 = 고가에 마감 (강한 마감), 0.0 = 저가에 마감 (약한 마감)
      const range = today.high - today.low;
      const closePos = range > 0 ? (today.close - today.low) / range : 0.5;

      // 종합 모멘텀 점수
      const score = (dayChange * 100) + (Math.min(volRatio, 20) * 3) + (Math.min(valuePct, 0.5) * 100) + (closePos * 5);

      const mover = {
        code: meta.code, name: meta.name, market: meta.market,
        marketCap: meta.marketValue, closePrice: today.close,
        dayChange: Number((dayChange * 100).toFixed(2)),
        volRatio: Number(volRatio.toFixed(2)),
        valuePct: Number((valuePct * 100).toFixed(2)),
        closePos: Number(closePos.toFixed(2)),
        score: Number(score.toFixed(1)),
        date: today.date,
      };
      // 모든 tier 에 품질 평가 — fade 없음 / 종가 강함 / 좁은 base 3가지 필터
      mover.startingQuality = evaluateStartingQuality(rows, mover);
      movers.push(mover);
    } catch (_) {}
  }
  movers.sort((a, b) => b.score - a.score);
  return movers.slice(0, topN);
}

// ─────────── 메인 분석 ───────────

function listSeededStocks() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs.readdirSync(CACHE_DIR)
    .filter((f) => /^\d{6}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""));
}

async function analyzeAll({ logProgress = false } = {}) {
  // 종목 마스터 (시총 정보)
  const stocksListPath = path.join(__dirname, "cache", "naver-stocks-list.json");
  const stocksList = JSON.parse(fs.readFileSync(stocksListPath, "utf-8")).stocks;
  const stockMeta = new Map(stocksList.map((s) => [s.code, s]));

  // KOSPI for market regime
  const kospi = await getKospiCached();

  const seededCodes = listSeededStocks();
  const successEvents = [];
  const failedEvents = [];
  let processed = 0;

  for (const code of seededCodes) {
    const cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${code}.json`), "utf-8"));
    const rows = cache.rows || [];
    if (rows.length < 30) continue;
    const meta = stockMeta.get(code);
    if (!meta) continue;

    const sharesOut = meta.closePrice > 0 ? meta.marketValue / meta.closePrice : 0;

    // 성공 이벤트 — "long base → 폭발" 패턴만 선택 (점화 전 MA60 가 큰 하락 중이 아닌 것)
    // 이 필터로 V자 반등·낙폭과대 종목·하락 추세 폭등은 제외됨.
    const successes = detectRiseEvents(rows);
    for (const e of successes) {
      const features = extractPreIgnitionFeatures(rows, e.ignitionIdx, meta.marketValue, sharesOut);
      if (!features) continue;
      // ⭐ 근본 필터: 점화 직전 MA60 가 -3% 이상 하락 중이었으면 "long base" 아님 → 제외
      if (features.ma60Slope != null && features.ma60Slope < 0.97) continue;
      const regime = classifyMarketRegime(kospi, e.ignitionDate);
      successEvents.push({
        code, name: meta.name, market: meta.market,
        marketCap: meta.marketValue,
        ...e,
        features,
        regime,
      });
    }

    // 실패 이벤트 (signature 비교용 — 동일 필터 적용 안함, 풀 사이즈 유지)
    const failures = detectFailedEvents(rows);
    for (const e of failures) {
      const features = extractPreIgnitionFeatures(rows, e.ignitionIdx, meta.marketValue, sharesOut);
      failedEvents.push({
        code, name: meta.name, market: meta.market,
        ...e, features,
      });
    }

    processed++;
    if (logProgress && processed % 50 === 0) {
      console.log(`[analyze] ${processed}/${seededCodes.length} (성공 ${successEvents.length} / 실패 ${failedEvents.length})`);
    }
  }

  const successBuckets = bucketByDuration(successEvents);
  const failedBuckets = bucketByDuration(failedEvents);

  // ─── Phase B: 현재 종목 후보 스코어링 ───
  const tables = buildLikelihoodTables(successEvents, failedEvents, FEATURE_KEYS, 10);
  const signature = buildSignature(successEvents, FEATURE_KEYS); // 공통점 시그니처
  const candidates = [];
  for (const code of seededCodes) {
    const meta = stockMeta.get(code);
    if (!meta) continue;
    let cache;
    try {
      cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${code}.json`), "utf-8"));
    } catch (_) { continue; }
    const rows = cache.rows || [];
    if (rows.length < 30) continue;
    const sharesOut = meta.closePrice > 0 ? meta.marketValue / meta.closePrice : 0;
    const features = extractPreIgnitionFeatures(rows, rows.length - 1, meta.marketValue, sharesOut);
    if (!features) continue;

    // ⭐ 후보 추세 필터 — 성공 이벤트와 동일 기준: 점화 직전 MA60 가 -3% 이상 하락 중이면 제외.
    // 인투셀 (5개월 다운트렌드) 같은 종목이 14/14 매칭 들어오는 걸 막음.
    if (features.ma60Slope != null && features.ma60Slope < 0.97) continue;
    // ⭐ "이미 한참 오른" 종목 제외 — MA60 이 +12% 이상 상승 중이면 base 단계 아님 (팜스코 같은 case).
    if (features.ma60Slope != null && features.ma60Slope > 1.12) continue;
    // ⭐ 박스권 확인 — 최근 30일 진폭이 25% 이상이면 base 패턴 아님 (쿠콘·아이텍 같은 변동 큰 case).
    const last30 = rows.slice(-30);
    const r30Hi = Math.max(...last30.map((r) => r.high || 0));
    const r30LowsArr = last30.map((r) => r.low).filter((v) => v > 0);
    if (r30LowsArr.length >= 20) {
      const r30Lo = Math.min(...r30LowsArr);
      if (r30Lo > 0 && (r30Hi - r30Lo) / r30Lo > 0.25) continue;
    }

    const { score, breakdown } = scoreFromTables(features, tables);
    const match = computeMatch(features, signature);
    const breakout = detectRecentBreakout(rows, 3);
    const chartAnalysis = breakout ? analyzeChartContext(rows, breakout) : null;
    candidates.push({
      code, name: meta.name, market: meta.market,
      marketCap: meta.marketValue,
      closePrice: meta.closePrice,
      changeRate: meta.changeRate,
      lastDate: rows[rows.length - 1].date,
      features, score, breakdown,
      matched: match.matched, totalKeys: match.total,
      sigBreakdown: match.breakdown,
      breakout, // 최근 3일 안 거래량+양봉 폭발 (있으면 객체, 없으면 null)
      chartAnalysis, // 차트 자동 검증 verdict (breakout 있을 때만)
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  // ─── Layer 2: 오늘의 모멘텀 스캔 ───
  const momentumMovers = scanTodaysMomentum({ stocksList });

  // ─── 교차 매칭 — SHAPE 후보 × 모멘텀 ───
  // 두 풀 다 들어간 종목은 가장 강력한 시그널 (setup 좋음 + 오늘 시동 시작)
  const candidateCodes = new Map(candidates.map((c) => [c.code, c]));
  const momentumCodes = new Set(momentumMovers.map((m) => m.code));
  for (const c of candidates) {
    c.inMomentum = momentumCodes.has(c.code);
  }
  for (const m of momentumMovers) {
    const cand = candidateCodes.get(m.code);
    m.inShape = !!cand;
    m.shapeMatched = cand?.matched || 0;
    m.shapeTotalKeys = cand?.totalKeys || 0;
  }

  const result = {
    analyzedAt: new Date().toISOString(),
    seeded: seededCodes.length,
    processed,
    successCount: successEvents.length,
    failedCount: failedEvents.length,
    success: {
      buckets: {
        A: { n: successBuckets.A.length, summary: summarizeFeatures(successBuckets.A) },
        B: { n: successBuckets.B.length, summary: summarizeFeatures(successBuckets.B) },
        C: { n: successBuckets.C.length, summary: summarizeFeatures(successBuckets.C) },
        D: { n: successBuckets.D.length, summary: summarizeFeatures(successBuckets.D) },
      },
      events: successEvents,
    },
    failed: {
      total: { n: failedEvents.length, summary: summarizeFeatures(failedEvents) },
    },
    candidates: {
      total: candidates.length,
      top: candidates, // 전체 저장 (점수·매칭 두 관점에서 필터링 가능하게)
      tables, // 디버깅용
      signature, // 공통점 시그니처 (p10~p90)
    },
    momentum: {
      date: candidates[0]?.lastDate || null,
      movers: momentumMovers,
    },
  };

  fs.writeFileSync(PATTERN_RESULT_CACHE, JSON.stringify(result, null, 0));
  return result;
}

// ─────────── Phase B-4: 차트 자동 검증 (verdict) ───────────
// 후보 카드의 시그니처 매칭만으론 부족 — 작전주, 점화 후 fade, 거래량 식음 등이 위양성으로 들어옴.
// 차트 휴리스틱 6가지로 자동 판정해서 STRONG/GOOD/MIXED/WEAK 등급 부여.
function analyzeChartContext(rows, breakout) {
  if (!breakout || rows.length < 90) return null;
  const last = rows.length - 1;
  const today = rows[last];
  const flags = { positive: [], negative: [] };
  const vol = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  // 1. breakout 후 follow-through (이후 추가 상승 vs 즉시 fade)
  if (breakout.daysAgo > 0) {
    const breakoutIdx = last - breakout.daysAgo;
    const breakoutClose = rows[breakoutIdx]?.close;
    if (breakoutClose > 0) {
      const since = (today.close - breakoutClose) / breakoutClose;
      if (since >= 0.02) flags.positive.push(`breakout 이후 +${(since * 100).toFixed(1)}% 추가 상승 (follow-through)`);
      else if (since <= -0.02) flags.negative.push(`breakout 이후 ${(since * 100).toFixed(1)}% 되돌림 (fade)`);
    }
  }

  // 2. 거래량 추세 — 최근 5일 vs 60일 평균
  const vol60 = vol(rows.slice(-60).map((r) => r.volume).filter((v) => v > 0));
  const vol5 = vol(rows.slice(-5).map((r) => r.volume).filter((v) => v > 0));
  if (vol60 > 0) {
    const ratio = vol5 / vol60;
    if (ratio >= 1.3) flags.positive.push(`거래량 증가 (60일 평균의 ${(ratio * 100).toFixed(0)}%)`);
    else if (ratio < 0.5) flags.negative.push(`거래량 식음 (60일 평균의 ${(ratio * 100).toFixed(0)}%)`);
  }

  // 3. 60일내 거래량+양봉 spike 누적 — 매집 (최근 집중) vs 반복 실패 (분산)
  const spikes = [];
  for (let i = Math.max(20, rows.length - 60); i < rows.length; i++) {
    const prior20Vol = vol(rows.slice(i - 20, i).map((r) => r.volume).filter((v) => v > 0));
    if (prior20Vol <= 0) continue;
    const r = rows[i];
    if (r.volume / prior20Vol >= 2 && r.close >= r.open) {
      spikes.push({ idx: i, daysAgo: last - i });
    }
  }
  const recentSpikes = spikes.filter((s) => s.daysAgo <= 7);
  if (recentSpikes.length >= 2) flags.positive.push(`최근 7일내 spike ${recentSpikes.length}회 (매집 패턴)`);
  // 트렌드 계산 — 가용 데이터의 시작점 기준 (보통 ~110일)
  const startIdx = Math.max(0, last - 129);
  const startClose = rows[startIdx]?.close;
  const trendDays = last - startIdx;
  const trendN = startClose > 0 ? (today.close - startClose) / startClose : 0;
  const oldSpikes = spikes.filter((s) => s.daysAgo > 14);
  if (oldSpikes.length >= 2 && trendN < -0.05) {
    flags.negative.push(`과거 spike ${oldSpikes.length}회 있었으나 ${trendDays}일 ${(trendN * 100).toFixed(0)}% 하락 (작전주 의심)`);
  }

  // 4. 장기 트렌드
  if (trendN >= 0.10) flags.positive.push(`${trendDays}일 +${(trendN * 100).toFixed(0)}% 우상향`);
  else if (trendN <= -0.10) flags.negative.push(`${trendDays}일 ${(trendN * 100).toFixed(0)}% 하락`);

  // 5. breakout 다음날 fade (오늘이 1일전 spike 다음날인 경우 — 가장 흔한 fade 시그널)
  if (breakout.daysAgo === 1 && rows[last - 1]) {
    const todayChange = (today.close - rows[last - 1].close) / rows[last - 1].close;
    if (todayChange <= -0.02) flags.negative.push(`breakout 다음날 ${(todayChange * 100).toFixed(1)}% fade`);
  }

  // 6. 30일 진폭 좁음 (깨끗한 base)
  const r30 = rows.slice(-30);
  const r30Hi = Math.max(...r30.map((r) => r.high || 0));
  const r30Lo = Math.min(...r30.map((r) => r.low || Infinity).filter((v) => v < Infinity));
  if (r30Lo > 0) {
    const range = (r30Hi - r30Lo) / r30Lo;
    if (range < 0.15) flags.positive.push(`30일 진폭 ${(range * 100).toFixed(0)}% (좁은 base)`);
  }

  const score = flags.positive.length - flags.negative.length;
  let verdict;
  if (score >= 3) verdict = "STRONG";
  else if (score >= 1) verdict = "GOOD";
  else if (score === 0) verdict = "MIXED";
  else verdict = "WEAK";
  return { verdict, score, flags };
}

// ─────────── Phase B-3: 최근 breakout 감지 ───────────
// 후보가 "막 시동 걸기 시작" 했는지 — 최근 N일 안에 거래량 폭증 + 양봉 일이 있었나.
// 모두투어 2/6 같은 점화일 패턴을 잡음 (거래량 ≥2x 평균 + 양봉 ≥+2%).
function detectRecentBreakout(rows, lookback = 3) {
  if (rows.length < 25) return null;
  let strongest = null;
  for (let offset = 0; offset < lookback; offset++) {
    const idx = rows.length - 1 - offset;
    const r = rows[idx];
    if (!r || idx < 20) continue;
    const prior20 = rows.slice(idx - 20, idx).map((rr) => rr.volume).filter((v) => v > 0);
    if (prior20.length < 10) continue;
    const avgVol = prior20.reduce((a, b) => a + b, 0) / prior20.length;
    if (avgVol <= 0) continue;
    const volRatio = r.volume / avgVol;
    const dayChange = idx > 0 && rows[idx - 1].close > 0
      ? (r.close - rows[idx - 1].close) / rows[idx - 1].close
      : 0;
    if (volRatio >= 2 && dayChange >= 0.02) {
      const score = volRatio * (1 + Math.max(0, dayChange));
      if (!strongest || score > strongest.score) {
        strongest = {
          daysAgo: offset,
          date: r.date,
          volRatio: Number(volRatio.toFixed(2)),
          dayChange: Number((dayChange * 100).toFixed(1)),
          score,
        };
      }
    }
  }
  return strongest;
}

// ─────────── Phase B-2: 성공 시그니처 (공통점 밴드) ───────────
// 성공 이벤트들 features 의 중심 밴드 (기본 p20~p80, 60%) 를 "공통 시그니처" 로 보고
// 후보가 몇 개의 시그니처 밴드 안에 있는지 매칭 카운트를 매긴다.
//
// p10-p90 (80%) 은 너무 넓어서 14/14 매칭 ≈ 0.8^14 = 4% 의 정상분포 종목이 그냥 통과 (변별력 약함).
// p20-p80 (60%) 으로 좁히면 0.6^14 = 0.08% → 진짜 유사 패턴만 통과.

const SIG_LO_PCTILE = 0.20;
const SIG_HI_PCTILE = 0.80;

function buildSignature(events, keys) {
  const sig = {};
  for (const k of keys) {
    const vals = events.map((e) => e.features?.[k]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (vals.length < 100) { sig[k] = null; continue; }
    sig[k] = {
      n: vals.length,
      lo: Number(vals[Math.floor(vals.length * SIG_LO_PCTILE)].toFixed(3)),
      p25: Number(vals[Math.floor(vals.length * 0.25)].toFixed(3)),
      p50: Number(vals[Math.floor(vals.length * 0.50)].toFixed(3)),
      p75: Number(vals[Math.floor(vals.length * 0.75)].toFixed(3)),
      hi: Number(vals[Math.floor(vals.length * SIG_HI_PCTILE)].toFixed(3)),
    };
  }
  return sig;
}

function computeMatch(features, signature) {
  let matched = 0;
  let total = 0;
  const breakdown = {};
  for (const [k, sig] of Object.entries(signature)) {
    if (!sig) continue;
    const v = features?.[k];
    if (!Number.isFinite(v)) continue;
    total++;
    const inBand = v >= sig.lo && v <= sig.hi;
    if (inBand) matched++;
    breakdown[k] = inBand;
  }
  return { matched, total, breakdown };
}

// ─────────── Phase B: Likelihood Ratio 후보 스코어링 ───────────

function buildLikelihoodTables(successEvents, failedEvents, keys, bins = 10) {
  const tables = {};
  for (const k of keys) {
    const sVals = successEvents.map((e) => e.features?.[k]).filter((v) => Number.isFinite(v));
    const fVals = failedEvents.map((e) => e.features?.[k]).filter((v) => Number.isFinite(v));
    if (sVals.length < bins || fVals.length < bins) { tables[k] = null; continue; }
    // 결합 분포 기준 quantile 경계
    const all = [...sVals, ...fVals].sort((a, b) => a - b);
    const boundaries = [];
    for (let i = 1; i < bins; i++) boundaries.push(all[Math.floor((all.length - 1) * i / bins)]);
    // 각 빈 카운트
    const sCounts = new Array(bins).fill(0);
    const fCounts = new Array(bins).fill(0);
    const findBin = (v) => {
      for (let i = 0; i < boundaries.length; i++) if (v < boundaries[i]) return i;
      return bins - 1;
    };
    sVals.forEach((v) => sCounts[findBin(v)]++);
    fVals.forEach((v) => fCounts[findBin(v)]++);
    // Laplace smoothing 후 log ratio
    const lr = new Array(bins);
    const sN = sVals.length, fN = fVals.length;
    for (let i = 0; i < bins; i++) {
      const ps = (sCounts[i] + 1) / (sN + bins);
      const pf = (fCounts[i] + 1) / (fN + bins);
      lr[i] = Number(Math.log(ps / pf).toFixed(3));
    }
    tables[k] = { boundaries: boundaries.map((b) => Number(b.toFixed(3))), lr };
  }
  return tables;
}

function scoreFromTables(features, tables) {
  let score = 0;
  const breakdown = {};
  for (const [k, t] of Object.entries(tables)) {
    if (!t) continue;
    const v = features[k];
    if (!Number.isFinite(v)) continue;
    let bin = t.boundaries.length;
    for (let i = 0; i < t.boundaries.length; i++) {
      if (v < t.boundaries[i]) { bin = i; break; }
    }
    score += t.lr[bin];
    breakdown[k] = t.lr[bin];
  }
  return { score: Number(score.toFixed(2)), breakdown };
}

module.exports = {
  detectRiseEvents,
  detectFailedEvents,
  extractPreIgnitionFeatures,
  classifyMarketRegime,
  bucketByDuration,
  summarizeFeatures,
  analyzeAll,
  listSeededStocks,
  fetchKospiHistory,
  getKospiCached,
  buildLikelihoodTables,
  scoreFromTables,
  buildSignature,
  computeMatch,
};
