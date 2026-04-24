require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3012;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const stocksJsonPath = path.join(__dirname, "stocks.json");
let stocksData = null;

function loadStocks() {
  const content = fs.readFileSync(stocksJsonPath, "utf-8");
  stocksData = JSON.parse(content);

  if (!stocksData || !Array.isArray(stocksData.stocks)) {
    throw new Error("stocks.json 형식이 올바르지 않습니다.");
  }
}

function findStockByQuery(query) {
  const keyword = String(query || "").trim();
  if (!keyword) return [];

  const upper = keyword.toUpperCase();

  const shortCodeMatches = stocksData.stocks.filter(
    (stock) => String(stock.shortCode || "").toUpperCase() === upper
  );
  if (shortCodeMatches.length > 0) return shortCodeMatches;

  const standardCodeMatches = stocksData.stocks.filter(
    (stock) => String(stock.standardCode || "").toUpperCase() === upper
  );
  if (standardCodeMatches.length > 0) return standardCodeMatches;

  const exactNameMatches = stocksData.stocks.filter((stock) => stock.name === keyword);
  if (exactNameMatches.length > 0) return exactNameMatches;

  return stocksData.stocks.filter((stock) => stock.name.includes(keyword));
}

function getStockInfoByQuery(query) {
  const matches = findStockByQuery(query);

  if (matches.length === 0) return null;

  if (matches.length === 1) {
    return {
      stdCode: matches[0].standardCode,
      shortCode: matches[0].shortCode,
      name: matches[0].name,
      market: matches[0].market,
    };
  }

  return matches.map((m) => ({
    stdCode: m.standardCode,
    shortCode: m.shortCode,
    name: m.name,
    market: m.market,
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeApiCall(fn, delayMs = 1000) {
  await sleep(delayMs);
  return await fn();
}

const TOKEN_CACHE_PATH = path.join(__dirname, ".kis-token.json");
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function loadCachedToken() {
  try {
    const raw = fs.readFileSync(TOKEN_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "number") {
      return parsed;
    }
  } catch (_) {
    // 캐시 없음/깨짐 — 새로 발급
  }
  return { accessToken: null, expiresAt: 0 };
}

function saveCachedToken(token) {
  try {
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(token), "utf-8");
  } catch (e) {
    console.warn("[KIS] 토큰 캐시 저장 실패:", e.message);
  }
}

let tokenCache = loadCachedToken();
let inflightIssue = null;

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
    return tokenCache.accessToken;
  }
  if (inflightIssue) return inflightIssue;

  inflightIssue = (async () => {
    try {
      const url = `${process.env.KIS_BASE_URL}/oauth2/tokenP`;
      const body = {
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
      };
      const res = await axios.post(url, body, {
        headers: { "content-type": "application/json; charset=UTF-8" },
        timeout: 10000,
      });
      if (!res.data.access_token) {
        throw new Error("토큰 발급 실패");
      }
      const expiresInMs = (Number(res.data.expires_in) || 86400) * 1000;
      tokenCache = {
        accessToken: res.data.access_token,
        expiresAt: Date.now() + expiresInMs,
      };
      saveCachedToken(tokenCache);
      return tokenCache.accessToken;
    } finally {
      inflightIssue = null;
    }
  })();

  return inflightIssue;
}

async function getCurrentPrice(accessToken, stockCode) {
  const url = `${process.env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`;

  const res = await axios.get(url, {
    headers: {
      "content-type": "application/json; charset=UTF-8",
      authorization: `Bearer ${accessToken}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "FHKST01010100",
    },
    params: {
      fid_cond_mrkt_div_code: "J",
      fid_input_iscd: stockCode,
    },
    timeout: 10000,
  });

  if (res.data.rt_cd !== "0") {
    throw new Error(`현재가 API 오류: ${res.data.msg_cd} / ${res.data.msg1}`);
  }

  return res.data;
}

async function getPeriodChart(accessToken, stockCode, periodCode, startDate, endDate) {
  const url = `${process.env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`;

  const res = await axios.get(url, {
    headers: {
      "content-type": "application/json; charset=UTF-8",
      authorization: `Bearer ${accessToken}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "FHKST03010100",
    },
    params: {
      fid_cond_mrkt_div_code: "J",
      fid_input_iscd: stockCode,
      fid_input_date_1: startDate,
      fid_input_date_2: endDate,
      fid_period_div_code: periodCode,
      fid_org_adj_prc: "1",
    },
    timeout: 10000,
  });

  if (res.data.rt_cd !== "0") {
    throw new Error(`기간별시세 API 오류: ${res.data.msg_cd} / ${res.data.msg1}`);
  }

  return res.data;
}

function normalizeCurrentPrice(apiData, stockMeta) {
  const o = apiData.output;

  return {
    stockCode: o.stck_shrn_iscd,
    stockName: stockMeta.name,
    market: stockMeta.market,
    currentPrice: Number(o.stck_prpr || 0),
    prevDiff: Number(o.prdy_vrss || 0),
    changeRate: Number(o.prdy_ctrt || 0),
    openPrice: Number(o.stck_oprc || 0),
    highPrice: Number(o.stck_hgpr || 0),
    lowPrice: Number(o.stck_lwpr || 0),
    prevClose: Number(o.stck_sdpr || 0),
    todayVolume: Number(o.acml_vol || 0),
    todayTradeValue: Number(o.acml_tr_pbmn || 0),
    foreignRate: Number(o.hts_frgn_ehrt || 0),
  };
}

function normalizePeriodData(apiData, stockMeta, period) {
  const rows = Array.isArray(apiData.output2) ? apiData.output2 : [];

  return {
    period,
    stockCode: stockMeta.shortCode,
    stockName: stockMeta.name,
    market: stockMeta.market,
    items: rows.map((row) => ({
      date: row.stck_bsop_date || "",
      openPrice: Number(row.stck_oprc || 0),
      highPrice: Number(row.stck_hgpr || 0),
      lowPrice: Number(row.stck_lwpr || 0),
      closePrice: Number(row.stck_clpr || 0),
      volume: Number(row.acml_vol || 0),
      tradeValue: Number(row.acml_tr_pbmn || 0),
    })),
  };
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function getDateRange(yearsBack = 6) {
  const end = new Date();
  const start = new Date();
  start.setFullYear(end.getFullYear() - yearsBack);

  return {
    startDate: formatDate(start),
    endDate: formatDate(end),
  };
}

function formatLabelByPeriod(dateStr, period) {
  const d = String(dateStr || "");
  if (d.length !== 8) return d;

  if (period === "DAY") return `${d.slice(2, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
  if (period === "WEEK" || period === "MONTH") return `${d.slice(2, 4)}.${d.slice(4, 6)}`;
  if (period === "YEAR") return d.slice(0, 4);
  return d;
}

function calcPositionInfo(currentPrice, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      minPrice: 0,
      maxPrice: 0,
      positionPercent: "0.0",
      positionRatio: 0,
      zoneLabel: "-",
    };
  }

  let minPrice = Infinity;
  let maxPrice = -Infinity;

  items.forEach((item) => {
    const low = Number(item.lowPrice || item.closePrice || 0);
    const high = Number(item.highPrice || item.closePrice || 0);
    if (low < minPrice) minPrice = low;
    if (high > maxPrice) maxPrice = high;
  });

  if (!isFinite(minPrice) || !isFinite(maxPrice) || maxPrice <= minPrice) {
    return {
      minPrice: 0,
      maxPrice: 0,
      positionPercent: "0.0",
      positionRatio: 0,
      zoneLabel: "-",
    };
  }

  let ratio = (currentPrice - minPrice) / (maxPrice - minPrice);
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;

  let zoneLabel = "중단";
  if (ratio < 0.2) zoneLabel = "바닥권";
  else if (ratio < 0.4) zoneLabel = "하단";
  else if (ratio < 0.6) zoneLabel = "중단";
  else if (ratio < 0.8) zoneLabel = "상단";
  else zoneLabel = "고점권";

  return {
    minPrice,
    maxPrice,
    positionPercent: (ratio * 100).toFixed(1),
    positionRatio: ratio,
    zoneLabel,
  };
}

function buildSeries(periodData, currentPrice, limit) {
  const src = Array.isArray(periodData.items) ? periodData.items.slice(0, limit).reverse() : [];
  const position = calcPositionInfo(currentPrice, src);

  return {
    period: periodData.period,
    labels: src.map((item) => formatLabelByPeriod(item.date, periodData.period)),
    closePrices: src.map((item) => Number(item.closePrice || 0)),
    volumes: src.map((item) => Number(item.volume || 0)),
    currentPriceLine: src.map(() => Number(currentPrice || 0)),
    position,
  };
}

function avgVolume(items, count, skipFirst = false) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const source = skipFirst ? items.slice(1) : items.slice(0);
  const target = source.slice(0, count);
  if (target.length === 0) return 0;
  const sum = target.reduce((acc, item) => acc + Number(item.volume || 0), 0);
  return Math.round(sum / target.length);
}

function buildSummary(currentData, dailyData, weeklyData, monthlyData, yearlyData) {
  const dailyAvg20 = avgVolume(dailyData.items, 20, true);
  const weeklyAvg20 = avgVolume(weeklyData.items, 20, true);
  const monthlyAvg12 = avgVolume(monthlyData.items, 12, true);
  const yearlyAvg5 = avgVolume(yearlyData.items, 5, true);

  return {
    todayRatio: dailyAvg20 ? (currentData.todayVolume / dailyAvg20).toFixed(2) : "-",
    weekRatio: weeklyAvg20 ? ((weeklyData.items?.[0]?.volume || 0) / weeklyAvg20).toFixed(2) : "-",
    monthRatio: monthlyAvg12 ? ((monthlyData.items?.[0]?.volume || 0) / monthlyAvg12).toFixed(2) : "-",
    yearRatio: yearlyAvg5 ? ((yearlyData.items?.[0]?.volume || 0) / yearlyAvg5).toFixed(2) : "-",
  };
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const target = values.slice(values.length - period);
  const sum = target.reduce((acc, v) => acc + Number(v || 0), 0);
  return sum / period;
}

function clampScore(v) {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return Math.round(v);
}

function scoreFromRatio(ratio) {
  if (!isFinite(ratio) || ratio <= 0) return 0;
  if (ratio < 0.7) return 20;
  if (ratio < 1.0) return 40;
  if (ratio < 1.5) return 60;
  if (ratio < 2.5) return 80;
  return 100;
}

/* 핵심 개선: 거래량 점수 정교화 */
function calculateVolumeScore(currentData, dailyData, weeklyData, monthlyData, yearlyData) {
  const dailyAvg20 = avgVolume(dailyData.items, 20, true);
  const weeklyAvg20 = avgVolume(weeklyData.items, 20, true);
  const monthlyAvg12 = avgVolume(monthlyData.items, 12, true);
  const yearlyAvg5 = avgVolume(yearlyData.items, 5, true);

  const todayRatio = dailyAvg20 ? currentData.todayVolume / dailyAvg20 : 0;
  const weekRatio = weeklyAvg20 ? (weeklyData.items?.[0]?.volume || 0) / weeklyAvg20 : 0;
  const monthRatio = monthlyAvg12 ? (monthlyData.items?.[0]?.volume || 0) / monthlyAvg12 : 0;
  const yearRatio = yearlyAvg5 ? (yearlyData.items?.[0]?.volume || 0) / yearlyAvg5 : 0;

  let baseScore =
    scoreFromRatio(todayRatio) * 0.5 +
    scoreFromRatio(weekRatio) * 0.2 +
    scoreFromRatio(monthRatio) * 0.2 +
    scoreFromRatio(yearRatio) * 0.1;

  const dayRange = Math.max(currentData.highPrice - currentData.lowPrice, 1);
  const closePosition = (currentData.currentPrice - currentData.lowPrice) / dayRange;

  let bonus = 0;
  const reasons = [];

  if (currentData.currentPrice > currentData.prevClose) {
    bonus += 10;
    reasons.push("양봉 보너스 +10");
  } else if (currentData.currentPrice < currentData.prevClose) {
    bonus -= 10;
    reasons.push("음봉 패널티 -10");
  }

  if (closePosition >= 0.8) {
    bonus += 10;
    reasons.push("고가권 마감 +10");
  } else if (closePosition <= 0.2) {
    bonus -= 10;
    reasons.push("저가권 마감 -10");
  }

  if (todayRatio >= 2 && currentData.currentPrice < currentData.prevClose && closePosition <= 0.3) {
    bonus -= 10;
    reasons.push("대량거래 음봉 추가 패널티 -10");
  }

  const tradeValueScore = scoreFromRatio(todayRatio);
  baseScore = baseScore * 0.85 + tradeValueScore * 0.15;

  const score = clampScore(baseScore + bonus);

  return {
    score,
    explanation: `오늘 ${dailyAvg20 ? todayRatio.toFixed(2) : "-"}배 / 주봉 ${weeklyAvg20 ? weekRatio.toFixed(2) : "-"}배 / 월봉 ${monthlyAvg12 ? monthRatio.toFixed(2) : "-"}배 / 연봉 ${yearlyAvg5 ? yearRatio.toFixed(2) : "-"}배`,
    detail: {
      todayRatio: dailyAvg20 ? todayRatio.toFixed(2) : "-",
      weekRatio: weeklyAvg20 ? weekRatio.toFixed(2) : "-",
      monthRatio: monthlyAvg12 ? monthRatio.toFixed(2) : "-",
      yearRatio: yearlyAvg5 ? yearRatio.toFixed(2) : "-",
      closePosition: closePosition.toFixed(2),
      adjustments: reasons,
    },
  };
}

function positionBandScore(ratio) {
  if (ratio < 0.2) return 70;
  if (ratio < 0.4) return 85;
  if (ratio < 0.6) return 65;
  if (ratio < 0.8) return 45;
  return 25;
}

function calculatePositionScore(dailySeries, weeklySeries, monthlySeries, yearlySeries) {
  const d = positionBandScore(dailySeries.position.positionRatio);
  const w = positionBandScore(weeklySeries.position.positionRatio);
  const m = positionBandScore(monthlySeries.position.positionRatio);
  const y = positionBandScore(yearlySeries.position.positionRatio);

  const score = d * 0.25 + w * 0.25 + m * 0.3 + y * 0.2;

  return {
    score: clampScore(score),
    explanation: `일봉 ${dailySeries.position.positionPercent}% / 주봉 ${weeklySeries.position.positionPercent}% / 월봉 ${monthlySeries.position.positionPercent}% / 연봉 ${yearlySeries.position.positionPercent}% 위치`,
  };
}

function calculateTrendScore(dailyData, weeklyData, currentPrice) {
  const dailyCloses = dailyData.items.slice(0, 60).reverse().map((v) => Number(v.closePrice || 0));
  const weeklyCloses = weeklyData.items.slice(0, 20).reverse().map((v) => Number(v.closePrice || 0));

  const ma5 = sma(dailyCloses, 5);
  const ma20 = sma(dailyCloses, 20);
  const ma60 = sma(dailyCloses, 60);
  const wma4 = sma(weeklyCloses, 4);
  const wma12 = sma(weeklyCloses, 12);

  let score = 0;
  if (ma5 && currentPrice > ma5) score += 20;
  if (ma20 && currentPrice > ma20) score += 20;
  if (ma60 && currentPrice > ma60) score += 15;
  if (ma5 && ma20 && ma5 > ma20) score += 20;
  if (ma20 && ma60 && ma20 > ma60) score += 15;
  if (wma4 && wma12 && wma4 > wma12) score += 10;

  return {
    score: clampScore(score),
    explanation: `5일선 ${ma5 ? Math.round(ma5).toLocaleString() : "-"}, 20일선 ${ma20 ? Math.round(ma20).toLocaleString() : "-"}, 60일선 ${ma60 ? Math.round(ma60).toLocaleString() : "-"}`,
  };
}

function calculateRSI(dailyData, period = 14) {
  const closes = dailyData.items.slice(0, 60).reverse().map((v) => Number(v.closePrice || 0));
  if (closes.length < period + 1) {
    return { score: 50, explanation: "RSI 계산 데이터 부족" };
  }

  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  let score = 50;
  if (rsi < 30) score = 80; // 과매도: 상승 가능
  else if (rsi > 70) score = 20; // 과매수: 하락 가능
  else if (rsi >= 40 && rsi <= 60) score = 60; // 중립

  return {
    score: clampScore(score),
    explanation: `RSI ${rsi.toFixed(2)} (기간 ${period})`,
  };
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateMACD(dailyData) {
  const closes = dailyData.items.slice(0, 60).reverse().map((v) => Number(v.closePrice || 0));
  if (closes.length < 26) {
    return { score: 50, explanation: "MACD 계산 데이터 부족" };
  }

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (!ema12 || !ema26) return { score: 50, explanation: "MACD 계산 불가" };

  const macdLine = ema12 - ema26;
  const macdValues = [];
  for (let i = 25; i < closes.length; i++) {
    const e12 = ema(closes.slice(0, i + 1), 12);
    const e26 = ema(closes.slice(0, i + 1), 26);
    if (e12 && e26) macdValues.push(e12 - e26);
  }
  const signalLine = ema(macdValues, 9);
  const histogram = macdLine - (signalLine || 0);

  let score = 50;
  if (macdLine > (signalLine || 0)) score = 70; // 상승 신호
  else score = 30; // 하락 신호

  return {
    score: clampScore(score),
    explanation: `MACD ${macdLine.toFixed(2)}, 시그널 ${signalLine ? signalLine.toFixed(2) : "-"}, 히스토그램 ${histogram.toFixed(2)}`,
  };
}

function estimateTrappedZones(dailyData, currentPrice) {
  const items = dailyData.items.slice(0, 120);
  if (!items.length) {
    return {
      trappedZones: [],
      resistanceScore: {
        score: 50,
        explanation: "데이터 부족",
      },
    };
  }

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  items.forEach((item) => {
    const low = Number(item.lowPrice || 0);
    const high = Number(item.highPrice || 0);
    if (low > 0 && low < minPrice) minPrice = low;
    if (high > 0 && high > maxPrice) maxPrice = high;
  });

  if (!isFinite(minPrice) || !isFinite(maxPrice) || maxPrice <= minPrice) {
    return {
      trappedZones: [],
      resistanceScore: {
        score: 50,
        explanation: "매물대 계산 불가",
      },
    };
  }

  const binCount = 24;
  const binSize = (maxPrice - minPrice) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    start: minPrice + binSize * i,
    end: minPrice + binSize * (i + 1),
    volume: 0,
  }));

  items.forEach((item) => {
    const avgPrice = (Number(item.highPrice || 0) + Number(item.lowPrice || 0) + Number(item.closePrice || 0)) / 3;
    const volume = Number(item.volume || 0);
    if (!isFinite(avgPrice) || avgPrice <= 0) return;
    let idx = Math.floor((avgPrice - minPrice) / binSize);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;
    bins[idx].volume += volume;
  });

  const overheadBins = bins
    .filter((b) => b.start > currentPrice)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 3)
    .map((b) => ({
      start: Math.round(b.start),
      end: Math.round(b.end),
      volume: Math.round(b.volume),
    }));

  const nearestOverhead = bins
    .filter((b) => b.start > currentPrice)
    .sort((a, b) => a.start - b.start)
    .slice(0, 5);

  const nearbyResistanceVolume = nearestOverhead.reduce((acc, b) => acc + b.volume, 0);
  const totalVolume = bins.reduce((acc, b) => acc + b.volume, 0) || 1;
  const nearbyRatio = nearbyResistanceVolume / totalVolume;

  let resistanceScoreValue = 100 - nearbyRatio * 400;
  resistanceScoreValue = clampScore(resistanceScoreValue);

  const explanation =
    overheadBins.length > 0
      ? `현재가 위 가장 큰 매물대: ${overheadBins.map((z) => `${z.start.toLocaleString()}~${z.end.toLocaleString()}`).join(", ")}`
      : "현재가 위 뚜렷한 매물대가 적음";

  return {
    trappedZones: overheadBins,
    resistanceScore: {
      score: resistanceScoreValue,
      explanation,
    },
  };
}

function parseWeights(body) {
  const defaults = {
    volume: 30,
    position: 20,
    trend: 10,
    rsi: 5,
    macd: 5,
    resistance: 20,
    volatility: 10,
  };

  const raw = {
    volume: Number(body.volumeWeight ?? defaults.volume),
    position: Number(body.positionWeight ?? defaults.position),
    trend: Number(body.trendWeight ?? defaults.trend),
    rsi: Number(body.rsiWeight ?? defaults.rsi),
    macd: Number(body.macdWeight ?? defaults.macd),
    resistance: Number(body.resistanceWeight ?? defaults.resistance),
    volatility: Number(body.volatilityWeight ?? defaults.volatility),
  };

  const clean = {};
  let total = 0;

  for (const key of Object.keys(raw)) {
    const v = Number.isFinite(raw[key]) && raw[key] >= 0 ? raw[key] : defaults[key];
    clean[key] = v;
    total += v;
  }

  if (total <= 0) return defaults;

  const normalized = {};
  for (const key of Object.keys(clean)) {
    normalized[key] = Math.round((clean[key] / total) * 100);
  }

  const keys = Object.keys(normalized);
  const sum = keys.reduce((acc, k) => acc + normalized[k], 0);
  if (sum !== 100) {
    normalized[keys[0]] += 100 - sum;
  }

  return normalized;
}

function calculateVolatilityScore(dailyData) {
  const items = dailyData.items.slice(0, 20);
  if (!items.length) {
    return { score: 50, explanation: "데이터 부족" };
  }

  const ranges = items.map((item) => {
    const high = Number(item.highPrice || 0);
    const low = Number(item.lowPrice || 0);
    const close = Number(item.closePrice || 1);
    if (close <= 0) return 0;
    return ((high - low) / close) * 100;
  });

  const avgRange = ranges.reduce((acc, v) => acc + v, 0) / ranges.length;

  let score = 100;
  if (avgRange > 12) score = 20;
  else if (avgRange > 9) score = 35;
  else if (avgRange > 7) score = 50;
  else if (avgRange > 5) score = 65;
  else if (avgRange > 3) score = 80;

  return {
    score: clampScore(score),
    explanation: `최근 20일 평균 변동폭 ${avgRange.toFixed(2)}%`,
  };
}

function estimateBuyZones(dailyData, currentPrice) {
  const items = dailyData.items.slice(0, 60);
  if (!items.length) return { supportBins: [] };

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  items.forEach((item) => {
    const low = Number(item.lowPrice || 0);
    const high = Number(item.highPrice || 0);
    if (low > 0 && low < minPrice) minPrice = low;
    if (high > 0 && high > maxPrice) maxPrice = high;
  });

  if (!isFinite(minPrice) || !isFinite(maxPrice) || maxPrice <= minPrice) {
    return { supportBins: [] };
  }

  const binCount = 24;
  const binSize = (maxPrice - minPrice) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    start: minPrice + binSize * i,
    end: minPrice + binSize * (i + 1),
    volume: 0,
  }));

  items.forEach((item) => {
    const avgPrice =
      (Number(item.highPrice || 0) + Number(item.lowPrice || 0) + Number(item.closePrice || 0)) / 3;
    const volume = Number(item.volume || 0);
    if (!isFinite(avgPrice) || avgPrice <= 0) return;
    let idx = Math.floor((avgPrice - minPrice) / binSize);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;
    bins[idx].volume += volume;
  });

  const supportBins = bins
    .filter((b) => b.end < currentPrice && b.volume > 0)
    .map((b) => ({
      start: Math.round(b.start),
      end: Math.round(b.end),
      mid: Math.round((b.start + b.end) / 2),
      volume: Math.round(b.volume),
    }));

  return { supportBins };
}

function buildTiersFromBands(supportBins, currentPrice, bands) {
  function pickSupportInBand(gapMin, gapMax) {
    const upperBound = currentPrice * (1 - gapMin);
    const lowerBound = currentPrice * (1 - gapMax);
    const candidates = supportBins.filter((b) => b.mid <= upperBound && b.mid >= lowerBound);
    if (candidates.length === 0) return null;
    return candidates.reduce((best, cur) => (cur.volume > best.volume ? cur : best), candidates[0]);
  }

  const tiers = {};
  bands.forEach(({ key, label, gapMin, gapMax, fallbackGap, ordinal }) => {
    const support = pickSupportInBand(gapMin, gapMax);
    let price;
    let description;
    if (support) {
      price = support.mid;
      description = `${ordinal}차 지지 매물대 (${support.start.toLocaleString()}~${support.end.toLocaleString()}원, 60일 거래량 집중 구간)`;
    } else {
      price = Math.round(currentPrice * (1 - fallbackGap));
      description = `현재가 -${(fallbackGap * 100).toFixed(1)}% 기본값 (해당 밴드에 지지 매물대 없음)`;
    }
    const gap = currentPrice > 0 ? ((currentPrice - price) / currentPrice) * 100 : 0;
    tiers[key] = {
      label,
      price,
      description,
      gapPercent: gap.toFixed(1),
      bandLabel: `-${(gapMin * 100).toFixed(1)}% ~ -${(gapMax * 100).toFixed(1)}%`,
    };
  });
  return tiers;
}

function calculateATRPercent(dailyData, period = 14) {
  const items = dailyData.items.slice(0, period + 1);
  if (items.length < period + 1) return null;

  const trValues = [];
  for (let i = 0; i < period; i++) {
    const cur = items[i];
    const prev = items[i + 1];
    const high = Number(cur.highPrice || 0);
    const low = Number(cur.lowPrice || 0);
    const prevClose = Number(prev.closePrice || 0);
    if (high <= 0 || low <= 0 || prevClose <= 0) continue;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);
  }
  if (trValues.length === 0) return null;

  const atr = trValues.reduce((a, b) => a + b, 0) / trValues.length;
  const refClose = Number(items[0].closePrice || 0);
  if (refClose <= 0) return null;

  return { atr, atrPercent: (atr / refClose) * 100 };
}

function buildBuyRecommendation(totalScore, buyZones, currentPrice, dailyData) {
  const supportBins = buyZones.supportBins || [];

  const fixedBands = [
    { key: "aggressive", label: "공격적 매수", gapMin: 0.01, gapMax: 0.05, fallbackGap: 0.03, ordinal: 1 },
    { key: "neutral", label: "중립적 매수", gapMin: 0.05, gapMax: 0.10, fallbackGap: 0.07, ordinal: 2 },
    { key: "conservative", label: "보수적 매수", gapMin: 0.10, gapMax: 0.18, fallbackGap: 0.15, ordinal: 3 },
  ];
  const fixed = { tiers: buildTiersFromBands(supportBins, currentPrice, fixedBands) };

  let atr = null;
  const atrInfo = calculateATRPercent(dailyData);
  if (atrInfo && atrInfo.atrPercent > 0) {
    const atrRatio = atrInfo.atrPercent / 100;
    const clampGap = (g) => Math.max(0.005, Math.min(0.3, g));
    const atrBands = [
      {
        key: "aggressive", label: "공격적 매수",
        gapMin: clampGap(atrRatio * 0.5), gapMax: clampGap(atrRatio * 1.5),
        fallbackGap: clampGap(atrRatio * 1.0), ordinal: 1,
      },
      {
        key: "neutral", label: "중립적 매수",
        gapMin: clampGap(atrRatio * 1.5), gapMax: clampGap(atrRatio * 3),
        fallbackGap: clampGap(atrRatio * 2.2), ordinal: 2,
      },
      {
        key: "conservative", label: "보수적 매수",
        gapMin: clampGap(atrRatio * 3), gapMax: clampGap(atrRatio * 5),
        fallbackGap: clampGap(atrRatio * 4), ordinal: 3,
      },
    ];
    atr = {
      tiers: buildTiersFromBands(supportBins, currentPrice, atrBands),
      atrPercent: atrInfo.atrPercent.toFixed(2),
      atrValue: Math.round(atrInfo.atr),
    };
  }

  let recommendedTier;
  let tierExplanation;
  if (totalScore >= 70) {
    recommendedTier = "aggressive";
    tierExplanation = "종합 점수가 높아 조건이 우호적이다. 얕은 되돌림(공격 구간)에서 진입해도 리스크가 크지 않다.";
  } else if (totalScore >= 50) {
    recommendedTier = "neutral";
    tierExplanation = "조건이 중립적이다. 중간 수준 되돌림까지 기다리며 분할 진입하는 편이 안전하다.";
  } else {
    recommendedTier = "conservative";
    tierExplanation = "조건이 취약하다. 깊은 조정(보수 구간)까지 기다리거나 관망을 권한다.";
  }

  return {
    recommendedTier,
    tierExplanation,
    fixed,
    atr,
    hasSupports: supportBins.length > 0,
  };
}

function buildScoreModel(currentData, dailyData, weeklyData, monthlyData, yearlyData, dailySeries, weeklySeries, monthlySeries, yearlySeries, weights) {
  const volume = calculateVolumeScore(currentData, dailyData, weeklyData, monthlyData, yearlyData);
  const position = calculatePositionScore(dailySeries, weeklySeries, monthlySeries, yearlySeries);
  const trend = calculateTrendScore(dailyData, weeklyData, currentData.currentPrice);
  const rsi = calculateRSI(dailyData);
  const macd = calculateMACD(dailyData);
  const trapped = estimateTrappedZones(dailyData, currentData.currentPrice);
  const resistance = trapped.resistanceScore;
  const volatility = calculateVolatilityScore(dailyData);
  const buyZones = estimateBuyZones(dailyData, currentData.currentPrice);

  const total =
    volume.score * (weights.volume / 100) +
    position.score * (weights.position / 100) +
    trend.score * (weights.trend / 100) +
    rsi.score * (weights.rsi / 100) +
    macd.score * (weights.macd / 100) +
    resistance.score * (weights.resistance / 100) +
    volatility.score * (weights.volatility / 100);

  const totalScore = clampScore(total);

  let verdict = "애매";
  if (total >= 80) verdict = "상승 조건 강함";
  else if (total >= 65) verdict = "조건부 긍정";
  else if (total >= 50) verdict = "중립";
  else verdict = "보수적 접근";

  const buyRecommendation = buildBuyRecommendation(totalScore, buyZones, currentData.currentPrice, dailyData);

  return {
    totalScore,
    verdict,
    weights,
    volume,
    position,
    trend,
    rsi,
    macd,
    resistance,
    volatility,
    trappedZones: trapped.trappedZones,
    supportBins: buyZones.supportBins,
    buyRecommendation,
  };
}

app.get("/", (req, res) => {
  res.render("index", {
    query: "",
    error: null,
    selected: null,
    currentData: null,
    candidates: [],
    dailySeries: null,
    weeklySeries: null,
    monthlySeries: null,
    yearlySeries: null,
    summary: null,
    scoreModel: null,
    weights: {
      volume: 30,
      position: 20,
      trend: 10,
      rsi: 5,
      macd: 5,
      resistance: 20,
      volatility: 10,
    },
  });
});

app.post("/search", async (req, res) => {
  try {
    const query = String(req.body.stockQuery || "").trim();
    const weights = parseWeights(req.body);

    if (!query) {
      return res.render("index", {
        query: "",
        error: "종목명 또는 종목코드를 입력하세요.",
        selected: null,
        currentData: null,
        candidates: [],
        dailySeries: null,
        weeklySeries: null,
        monthlySeries: null,
        yearlySeries: null,
        summary: null,
        scoreModel: null,
        weights,
      });
    }

    const stockInfo = getStockInfoByQuery(query);

    if (!stockInfo) {
      return res.render("index", {
        query,
        error: "일치하는 종목이 없습니다.",
        selected: null,
        currentData: null,
        candidates: [],
        dailySeries: null,
        weeklySeries: null,
        monthlySeries: null,
        yearlySeries: null,
        summary: null,
        scoreModel: null,
        weights,
      });
    }

    let selected = stockInfo;
    let candidates = [];

    if (Array.isArray(stockInfo)) {
      candidates = stockInfo;
      selected = stockInfo[0];
    }

    const accessToken = await safeApiCall(() => getAccessToken(), 300);

    const currentRaw = await safeApiCall(
      () => getCurrentPrice(accessToken, selected.shortCode),
      900
    );
    const currentData = normalizeCurrentPrice(currentRaw, selected);

    const { startDate, endDate } = getDateRange(6);

    const dailyRaw = await safeApiCall(
      () => getPeriodChart(accessToken, selected.shortCode, "D", startDate, endDate),
      1100
    );
    const weeklyRaw = await safeApiCall(
      () => getPeriodChart(accessToken, selected.shortCode, "W", startDate, endDate),
      1100
    );
    const monthlyRaw = await safeApiCall(
      () => getPeriodChart(accessToken, selected.shortCode, "M", startDate, endDate),
      1100
    );
    const yearlyRaw = await safeApiCall(
      () => getPeriodChart(accessToken, selected.shortCode, "Y", startDate, endDate),
      1100
    );

    const dailyData = normalizePeriodData(dailyRaw, selected, "DAY");
    const weeklyData = normalizePeriodData(weeklyRaw, selected, "WEEK");
    const monthlyData = normalizePeriodData(monthlyRaw, selected, "MONTH");
    const yearlyData = normalizePeriodData(yearlyRaw, selected, "YEAR");

    const dailySeries = buildSeries(dailyData, currentData.currentPrice, 60);
    const weeklySeries = buildSeries(weeklyData, currentData.currentPrice, 52);
    const monthlySeries = buildSeries(monthlyData, currentData.currentPrice, 36);
    const yearlySeries = buildSeries(yearlyData, currentData.currentPrice, 5);

    const summary = buildSummary(currentData, dailyData, weeklyData, monthlyData, yearlyData);
    const scoreModel = buildScoreModel(
      currentData,
      dailyData,
      weeklyData,
      monthlyData,
      yearlyData,
      dailySeries,
      weeklySeries,
      monthlySeries,
      yearlySeries,
      weights
    );

    res.render("index", {
      query,
      error: null,
      selected,
      currentData,
      candidates,
      dailySeries,
      weeklySeries,
      monthlySeries,
      yearlySeries,
      summary,
      scoreModel,
      weights,
    });
  } catch (err) {
    let message = err.message || "알 수 없는 오류가 발생했습니다.";
    if (err.response?.data) {
      message = JSON.stringify(err.response.data, null, 2);
    }

    res.render("index", {
      query: req.body.stockQuery || "",
      error: message,
      selected: null,
      currentData: null,
      candidates: [],
      dailySeries: null,
      weeklySeries: null,
      monthlySeries: null,
      yearlySeries: null,
      summary: null,
      scoreModel: null,
      weights: parseWeights(req.body || {}),
    });
  }
});

loadStocks();

app.listen(PORT, () => {
  console.log(`서버 실행: http://localhost:${PORT}`);
});