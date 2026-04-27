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
    });
  }
  candidates.sort((a, b) => b.score - a.score);

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
  };

  fs.writeFileSync(PATTERN_RESULT_CACHE, JSON.stringify(result, null, 0));
  return result;
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
