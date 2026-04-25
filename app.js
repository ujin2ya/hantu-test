const path = require("path");
const fs = require("fs");
const ENV_PATH = path.join(__dirname, ".env");
const dotenvResult = require("dotenv").config({ path: ENV_PATH, override: true });
if (dotenvResult.error) {
  console.warn("[dotenv] .env 로드 실패:", dotenvResult.error.message);
} else {
  const parsedKeys = Object.keys(dotenvResult.parsed || {});
  console.log(`[dotenv] .env 로드 OK (override) / 파싱된 키 ${parsedKeys.length}개: [${parsedKeys.join(", ")}]`);
  const parsedGemini = (dotenvResult.parsed || {}).GEMINI_API_KEY || "";
  const envGemini = process.env.GEMINI_API_KEY || "";
  console.log(`[dotenv] GEMINI_API_KEY: parsed_len=${parsedGemini.length}, env_len=${envGemini.length}, exists=${!!envGemini}`);
}
try {
  const raw = fs.readFileSync(ENV_PATH, "utf-8");
  const summary = raw.split(/\r?\n/).map((line, i) => {
    if (!line) return `  ${i + 1}: <empty>`;
    if (line.trim().startsWith("#")) return `  ${i + 1}: <comment>`;
    const eq = line.indexOf("=");
    if (eq === -1) return `  ${i + 1}: <NO EQUALS> length=${line.length}`;
    return `  ${i + 1}: "${line.slice(0, eq)}" length=${line.length}`;
  }).join("\n");
  console.log(`[dotenv] .env raw line summary (line / key / length):\n${summary}`);
} catch (e) {
  console.warn("[dotenv] raw .env inspect 실패:", e.message);
}
const express = require("express");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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

  stocksData.byShortCode = {};
  for (const s of stocksData.stocks) {
    if (s.shortCode) stocksData.byShortCode[s.shortCode] = s;
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

async function safeApiCall(fn, delayMs = 1000, retries = 3) {
  await sleep(delayMs);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err?.message || "";
      const respMsg = err?.response?.data?.msg_cd || "";
      const isRateLimit = /EGW00201|초당/.test(msg) || respMsg === "EGW00201";
      if (!isRateLimit || attempt === retries) {
        throw err;
      }
      const backoff = 1500 * Math.pow(2, attempt); // 1500, 3000, 6000ms
      console.warn(`[KIS] rate limited (EGW00201), backoff ${backoff}ms then retry ${attempt + 1}/${retries}`);
      await sleep(backoff);
    }
  }
}

function logSample(label, obj) {
  if (obj === undefined || obj === null) {
    console.log(`[SAMPLE] ${label}: <empty>`);
    return;
  }
  const keys = Object.keys(obj);
  console.log(`[SAMPLE] ${label} (${keys.length} keys):`);
  for (const k of keys) {
    const v = obj[k];
    const s = typeof v === "string" ? `"${v}"` : JSON.stringify(v);
    console.log(`  ${k} = ${s}`);
  }
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

async function getMinuteChart(accessToken, stockCode, hourHHMMSS) {
  const url = `${process.env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice`;
  const res = await axios.get(url, {
    headers: {
      "content-type": "application/json; charset=UTF-8",
      authorization: `Bearer ${accessToken}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "FHKST03010200",
    },
    params: {
      fid_etc_cls_code: "",
      fid_cond_mrkt_div_code: "J",
      fid_input_iscd: stockCode,
      fid_input_hour_1: hourHHMMSS,
      fid_pw_data_incu_yn: "Y",
    },
    timeout: 10000,
  });

  if (res.data.rt_cd !== "0") {
    throw new Error(`분봉 API 오류: ${res.data.msg_cd} / ${res.data.msg1}`);
  }
  return res.data;
}

async function getVolumeRank(accessToken, blngClsCode = "3") {
  const url = `${process.env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/volume-rank`;
  const res = await axios.get(url, {
    headers: {
      "content-type": "application/json; charset=UTF-8",
      authorization: `Bearer ${accessToken}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "FHPST01710000",
    },
    params: {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_COND_SCR_DIV_CODE: "20171",
      FID_INPUT_ISCD: "0000",
      FID_DIV_CLS_CODE: "0",
      FID_BLNG_CLS_CODE: String(blngClsCode),
      FID_TRGT_CLS_CODE: "111111111",
      FID_TRGT_EXLS_CLS_CODE: "0000000000",
      FID_INPUT_PRICE_1: "",
      FID_INPUT_PRICE_2: "",
      FID_VOL_CNT: "",
      FID_INPUT_DATE_1: "",
    },
    timeout: 10000,
  });

  if (res.data.rt_cd !== "0") {
    throw new Error(`거래량/거래대금 순위 API 오류 (BLNG=${blngClsCode}): ${res.data.msg_cd} / ${res.data.msg1}`);
  }
  return res.data;
}

async function getVolumePowerRank(accessToken) {
  const url = `${process.env.KIS_BASE_URL}/uapi/domestic-stock/v1/ranking/volume-power`;
  const res = await axios.get(url, {
    headers: {
      "content-type": "application/json; charset=UTF-8",
      authorization: `Bearer ${accessToken}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "FHPST01680000",
    },
    params: {
      fid_cond_mrkt_div_code: "J",
      fid_cond_scr_div_code: "20168",
      fid_input_iscd: "0000",
      fid_div_cls_code: "0",
      fid_input_price_1: "",
      fid_input_price_2: "",
      fid_vol_cnt: "",
      fid_trgt_cls_code: "0",
      fid_trgt_exls_cls_code: "0",
    },
    timeout: 10000,
  });

  if (res.data.rt_cd !== "0") {
    throw new Error(`체결강도 순위 API 오류: ${res.data.msg_cd} / ${res.data.msg1}`);
  }
  return res.data;
}

function normalizeCurrentPrice(apiData, stockMeta) {
  const o = apiData.output;

  const buyVolume = Number(o.shnu_cntg_smtn || 0);
  const sellVolume = Number(o.seln_cntg_smtn || 0);
  const buySellRatio = sellVolume > 0 ? buyVolume / sellVolume : null;

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
    chegyeolStrength: Number(o.cttr || 0),
    buyVolume,
    sellVolume,
    buySellRatio,
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

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).length > 0) {
      return row[key];
    }
  }
  return null;
}

function normalizeRankRows(apiData, kind) {
  const rows = Array.isArray(apiData.output) ? apiData.output : [];
  return rows
    .map((r) => {
      const shortCode = String(pickField(r, ["mksc_shrn_iscd", "stck_shrn_iscd"]) || "").trim();
      if (!shortCode) return null;
      const name = String(pickField(r, ["hts_kor_isnm", "stck_hts_kor_isnm"]) || "").trim();
      const currentPrice = Number(pickField(r, ["stck_prpr"]) || 0);
      const changeRate = Number(pickField(r, ["prdy_ctrt"]) || 0);
      const volume = Number(pickField(r, ["acml_vol"]) || 0);
      const tradeValue = Number(pickField(r, ["acml_tr_pbmn"]) || 0);
      const cttr = Number(pickField(r, ["tday_rltv", "cttr"]) || 0);
      return { shortCode, name, currentPrice, changeRate, volume, tradeValue, cttr, source: kind };
    })
    .filter(Boolean);
}

function mergeRankCandidates(sources, limit) {
  const map = new Map();
  for (const { rows, label } of sources) {
    for (const row of rows) {
      const existing = map.get(row.shortCode);
      if (existing) {
        existing.sources.add(label);
        if (!existing.cttr && row.cttr) existing.cttr = row.cttr;
        if (!existing.tradeValue && row.tradeValue) existing.tradeValue = row.tradeValue;
      } else {
        map.set(row.shortCode, { ...row, sources: new Set([label]) });
      }
    }
  }
  const merged = Array.from(map.values()).map((r) => ({ ...r, sources: Array.from(r.sources) }));
  merged.sort((a, b) => {
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return (b.tradeValue || 0) - (a.tradeValue || 0);
  });
  return merged.slice(0, limit);
}

function normalizeMinuteChart(apiData) {
  const rows = Array.isArray(apiData.output2) ? apiData.output2 : [];
  return rows
    .map((row) => ({
      time: String(row.stck_cntg_hour || ""),
      openPrice: Number(row.stck_oprc || 0),
      highPrice: Number(row.stck_hgpr || 0),
      lowPrice: Number(row.stck_lwpr || 0),
      closePrice: Number(row.stck_prpr || 0),
      volume: Number(row.cntg_vol || 0),
    }))
    .filter((it) => it.closePrice > 0);
}

function calculateMinuteMomentum(minuteRows) {
  if (!Array.isArray(minuteRows) || minuteRows.length < 10) {
    return { score: 50, slope: 0, recentVsPrior: 0, explanation: "분봉 데이터 부족" };
  }
  const ordered = [...minuteRows].reverse();
  const closes = ordered.map((r) => r.closePrice);
  const n = closes.length;
  const recentN = Math.min(5, Math.floor(n / 3));
  const recent = closes.slice(-recentN);
  const prior = closes.slice(-recentN * 2, -recentN);
  if (prior.length === 0) {
    return { score: 50, slope: 0, recentVsPrior: 0, explanation: "분봉 비교 데이터 부족" };
  }
  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgPrior = prior.reduce((a, b) => a + b, 0) / prior.length;
  const recentVsPrior = avgPrior > 0 ? ((avgRecent - avgPrior) / avgPrior) * 100 : 0;

  const sumX = (n * (n - 1)) / 2;
  const sumY = closes.reduce((a, b) => a + b, 0);
  const sumXY = closes.reduce((acc, y, i) => acc + i * y, 0);
  const sumX2 = closes.reduce((acc, _, i) => acc + i * i, 0);
  const denom = n * sumX2 - sumX * sumX;
  const slopeRaw = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const lastPrice = closes[closes.length - 1] || 1;
  const slopePercent = (slopeRaw / lastPrice) * 100;

  let score = 50;
  if (recentVsPrior > 1.0) score = 85;
  else if (recentVsPrior > 0.3) score = 70;
  else if (recentVsPrior > -0.3) score = 50;
  else if (recentVsPrior > -1.0) score = 30;
  else score = 15;

  if (slopePercent > 0 && score < 100) score = Math.min(100, score + 5);
  if (slopePercent < 0 && score > 0) score = Math.max(0, score - 5);

  return {
    score: clampScore(score),
    slope: slopePercent,
    recentVsPrior,
    explanation: `최근 ${recentN}분 평균이 직전 ${recentN}분 대비 ${recentVsPrior.toFixed(2)}%`,
  };
}

function calcIntradayPosition(currentData) {
  const range = currentData.highPrice - currentData.lowPrice;
  if (range <= 0) return { ratio: 0.5, score: 50 };
  const ratio = (currentData.currentPrice - currentData.lowPrice) / range;
  let score = 50;
  if (ratio < 0.2) score = 80;
  else if (ratio < 0.4) score = 70;
  else if (ratio < 0.6) score = 55;
  else if (ratio < 0.8) score = 40;
  else score = 25;
  return { ratio, score };
}

function scoreChegyeolStrength(cttr) {
  if (!cttr) return { score: 50, explanation: "체결강도 0" };
  let score = 50;
  if (cttr >= 150) score = 95;
  else if (cttr >= 120) score = 85;
  else if (cttr >= 100) score = 70;
  else if (cttr >= 80) score = 45;
  else if (cttr >= 60) score = 25;
  else score = 10;
  return { score: clampScore(score), explanation: `체결강도 ${cttr.toFixed(1)}` };
}

function scoreBuySellRatio(ratio) {
  if (ratio === null || !isFinite(ratio)) return { score: 50, explanation: "매수/매도 비율 계산 불가" };
  let score = 50;
  if (ratio >= 1.5) score = 90;
  else if (ratio >= 1.2) score = 75;
  else if (ratio >= 1.0) score = 60;
  else if (ratio >= 0.8) score = 40;
  else score = 20;
  return { score: clampScore(score), explanation: `매수/매도 ${ratio.toFixed(2)}` };
}

function scoreChangeRateForShortTerm(changeRate) {
  const r = Math.abs(changeRate);
  let score = 60;
  if (r > 25) score = 5;
  else if (r > 20) score = 20;
  else if (r > 15) score = 40;
  else if (r > 10) score = 55;
  else if (r > 5) score = 75;
  else if (r > 1) score = 70;
  else score = 50;
  return { score: clampScore(score), explanation: `등락률 ${changeRate.toFixed(2)}%` };
}

function buildShortTermScore(currentData, minuteRows) {
  const cheg = scoreChegyeolStrength(currentData.chegyeolStrength);
  const buySell = scoreBuySellRatio(currentData.buySellRatio);
  const momentum = calculateMinuteMomentum(minuteRows);
  const intraday = calcIntradayPosition(currentData);
  const changeBand = scoreChangeRateForShortTerm(currentData.changeRate);

  const weights = { chegyeol: 30, buySell: 20, momentum: 20, intraday: 15, changeBand: 15 };
  const total =
    cheg.score * (weights.chegyeol / 100) +
    buySell.score * (weights.buySell / 100) +
    momentum.score * (weights.momentum / 100) +
    intraday.score * (weights.intraday / 100) +
    changeBand.score * (weights.changeBand / 100);

  const totalScore = clampScore(total);

  let verdict = "보류";
  if (totalScore >= 75) verdict = "단타 유망";
  else if (totalScore >= 60) verdict = "관심";
  else if (totalScore >= 45) verdict = "중립";
  else verdict = "약함";

  return {
    totalScore,
    verdict,
    components: { cheg, buySell, momentum, intraday, changeBand },
    weights,
  };
}

const SCAN_CACHE_TTL_MS = 5 * 60 * 1000;
const scanCache = new Map();

function getScanCache(key) {
  const hit = scanCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    scanCache.delete(key);
    return null;
  }
  return hit.value;
}

function setScanCache(key, value) {
  scanCache.set(key, { value, expiresAt: Date.now() + SCAN_CACHE_TTL_MS });
}

function nowHHMMSS() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

async function runScan({ candidateLimit, includeMinute }) {
  const accessToken = await safeApiCall(() => getAccessToken(), 300);

  const volumeRaw = await safeApiCall(() => getVolumeRank(accessToken), 600);
  console.log(`[SCAN] volume-rank output rows: ${Array.isArray(volumeRaw.output) ? volumeRaw.output.length : "N/A"}`);
  logSample("volume-rank output[0]", Array.isArray(volumeRaw.output) ? volumeRaw.output[0] : null);

  const powerRaw = await safeApiCall(() => getVolumePowerRank(accessToken), 600);
  console.log(`[SCAN] volume-power output rows: ${Array.isArray(powerRaw.output) ? powerRaw.output.length : "N/A"}`);
  logSample("volume-power output[0]", Array.isArray(powerRaw.output) ? powerRaw.output[0] : null);

  const volumeRows = normalizeRankRows(volumeRaw, "거래대금");
  const powerRows = normalizeRankRows(powerRaw, "체결강도");
  const candidates = mergeRankCandidates([
    { rows: volumeRows, label: "거래대금" },
    { rows: powerRows, label: "체결강도" },
  ], candidateLimit);
  console.log(`[SCAN] candidates after merge: ${candidates.length}`);

  const hour = nowHHMMSS();
  const results = [];
  let firstLogged = false;
  for (const cand of candidates) {
    try {
      const meta = stocksData.byShortCode?.[cand.shortCode] || null;
      const stockMeta = {
        shortCode: cand.shortCode,
        standardCode: meta?.standardCode || "",
        name: cand.name || meta?.name || cand.shortCode,
        market: meta?.market || "-",
      };

      const currentRaw = await safeApiCall(
        () => getCurrentPrice(accessToken, cand.shortCode),
        900
      );
      if (!firstLogged) {
        logSample(`inquire-price output (${cand.shortCode})`, currentRaw.output);
      }
      const currentData = normalizeCurrentPrice(currentRaw, stockMeta);

      let minuteRows = [];
      if (includeMinute) {
        try {
          const minuteRaw = await safeApiCall(
            () => getMinuteChart(accessToken, cand.shortCode, hour),
            1100
          );
          if (!firstLogged) {
            console.log(`[SCAN] minute output2 rows (${cand.shortCode}): ${Array.isArray(minuteRaw.output2) ? minuteRaw.output2.length : "N/A"}`);
            logSample(`minute output2[0] (${cand.shortCode})`, Array.isArray(minuteRaw.output2) ? minuteRaw.output2[0] : null);
          }
          minuteRows = normalizeMinuteChart(minuteRaw);
        } catch (e) {
          // 분봉 실패는 종목 자체 실패로 보지 않음
        }
      }
      firstLogged = true;

      const score = buildShortTermScore(currentData, minuteRows);
      results.push({
        shortCode: cand.shortCode,
        name: stockMeta.name,
        market: stockMeta.market,
        currentPrice: currentData.currentPrice,
        changeRate: currentData.changeRate,
        chegyeolStrength: currentData.chegyeolStrength,
        buyVolume: currentData.buyVolume,
        sellVolume: currentData.sellVolume,
        buySellRatio: currentData.buySellRatio,
        sources: cand.sources,
        score,
      });
    } catch (e) {
      results.push({
        shortCode: cand.shortCode,
        name: cand.name,
        error: e.message || String(e),
        sources: cand.sources,
      });
    }
  }

  results.sort((a, b) => (b.score?.totalScore || -1) - (a.score?.totalScore || -1));

  return {
    scannedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    includeMinute,
    results,
  };
}

function pickAutoMode(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay(); // 0=Sun, 6=Sat
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const totalMin = hour * 60 + minute;
  const openMin = 9 * 60;
  const closeMin = 15 * 60 + 30;
  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = totalMin >= openMin && totalMin < closeMin;
  return isWeekday && isMarketHours ? "short" : "swing";
}

async function runSwingScan({ candidateLimit }) {
  const accessToken = await safeApiCall(() => getAccessToken(), 300);

  const volumeRaw = await safeApiCall(() => getVolumeRank(accessToken, "3"), 600);
  console.log(`[SWING] volume-rank(BLNG=3) output rows: ${Array.isArray(volumeRaw.output) ? volumeRaw.output.length : "N/A"}`);
  const increaseRaw = await safeApiCall(() => getVolumeRank(accessToken, "1"), 600);
  console.log(`[SWING] volume-rank(BLNG=1, 거래증가율) output rows: ${Array.isArray(increaseRaw.output) ? increaseRaw.output.length : "N/A"}`);

  const volumeRows = normalizeRankRows(volumeRaw, "거래대금");
  const increaseRows = normalizeRankRows(increaseRaw, "거래증가율");
  const candidates = mergeRankCandidates([
    { rows: volumeRows, label: "거래대금" },
    { rows: increaseRows, label: "거래증가율" },
  ], candidateLimit);
  console.log(`[SWING] candidates after merge: ${candidates.length}`);

  const { startDate, endDate } = getDateRange(6);
  const defaultWeights = { volume: 30, position: 20, trend: 10, rsi: 5, macd: 5, resistance: 20, volatility: 10 };

  const results = [];
  let firstLogged = false;
  for (const cand of candidates) {
    try {
      const meta = stocksData.byShortCode?.[cand.shortCode] || null;
      const stockMeta = {
        shortCode: cand.shortCode,
        standardCode: meta?.standardCode || "",
        name: cand.name || meta?.name || cand.shortCode,
        market: meta?.market || "-",
      };

      const currentRaw = await safeApiCall(() => getCurrentPrice(accessToken, cand.shortCode), 900);
      if (!firstLogged) {
        logSample(`[SWING] inquire-price output (${cand.shortCode})`, currentRaw.output);
      }
      const currentData = normalizeCurrentPrice(currentRaw, stockMeta);

      const dailyRaw = await safeApiCall(() => getPeriodChart(accessToken, cand.shortCode, "D", startDate, endDate), 1100);
      const weeklyRaw = await safeApiCall(() => getPeriodChart(accessToken, cand.shortCode, "W", startDate, endDate), 1100);
      const monthlyRaw = await safeApiCall(() => getPeriodChart(accessToken, cand.shortCode, "M", startDate, endDate), 1100);
      const yearlyRaw = await safeApiCall(() => getPeriodChart(accessToken, cand.shortCode, "Y", startDate, endDate), 1100);

      const dailyData = normalizePeriodData(dailyRaw, stockMeta, "DAY");
      const weeklyData = normalizePeriodData(weeklyRaw, stockMeta, "WEEK");
      const monthlyData = normalizePeriodData(monthlyRaw, stockMeta, "MONTH");
      const yearlyData = normalizePeriodData(yearlyRaw, stockMeta, "YEAR");

      const dailySeries = buildSeries(dailyData, currentData.currentPrice, 60);
      const weeklySeries = buildSeries(weeklyData, currentData.currentPrice, 52);
      const monthlySeries = buildSeries(monthlyData, currentData.currentPrice, 36);
      const yearlySeries = buildSeries(yearlyData, currentData.currentPrice, 5);

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
        defaultWeights
      );

      const recTier = scoreModel.buyRecommendation?.recommendedTier;
      const buyTierObj = recTier ? scoreModel.buyRecommendation?.fixed?.tiers?.[recTier] : null;

      results.push({
        shortCode: cand.shortCode,
        name: stockMeta.name,
        market: stockMeta.market,
        currentPrice: currentData.currentPrice,
        changeRate: currentData.changeRate,
        sources: cand.sources,
        scoreModel: {
          totalScore: scoreModel.totalScore,
          verdict: scoreModel.verdict,
          components: {
            volume: scoreModel.volume.score,
            position: scoreModel.position.score,
            trend: scoreModel.trend.score,
            rsi: scoreModel.rsi.score,
            macd: scoreModel.macd.score,
            resistance: scoreModel.resistance.score,
            volatility: scoreModel.volatility.score,
          },
          buyTier: recTier,
          buyPrice: buyTierObj?.price || null,
          buyGapPercent: buyTierObj?.gapPercent || null,
        },
      });
      firstLogged = true;
    } catch (e) {
      results.push({
        shortCode: cand.shortCode,
        name: cand.name,
        error: e.message || String(e),
        sources: cand.sources,
      });
    }
  }

  results.sort((a, b) => (b.scoreModel?.totalScore || -1) - (a.scoreModel?.totalScore || -1));

  return {
    scannedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    mode: "swing",
    results,
  };
}

function defaultLimitForMode(mode) {
  return mode === "swing" ? 25 : 40;
}

app.get("/scan", (req, res) => {
  const autoMode = pickAutoMode();
  res.render("scan", {
    error: null,
    scanResult: null,
    autoMode,
    options: {
      mode: "auto",
      effectiveMode: autoMode,
      candidateLimit: defaultLimitForMode(autoMode),
      includeMinute: true,
    },
  });
});

app.post("/scan", async (req, res) => {
  const requestedMode = String(req.body.mode || "auto");
  const autoMode = pickAutoMode();
  const effectiveMode =
    requestedMode === "short" || requestedMode === "swing" ? requestedMode : autoMode;

  const candidateLimit = Math.max(
    5,
    Math.min(60, Number(req.body.candidateLimit) || defaultLimitForMode(effectiveMode))
  );
  const includeMinute = req.body.includeMinute !== "off";
  const cacheKey = `${effectiveMode}:${candidateLimit}:${includeMinute ? 1 : 0}`;

  const optionsForRender = {
    mode: requestedMode,
    effectiveMode,
    candidateLimit,
    includeMinute,
  };

  try {
    const cached = getScanCache(cacheKey);
    if (cached) {
      return res.render("scan", {
        error: null,
        scanResult: { ...cached, fromCache: true },
        autoMode,
        options: optionsForRender,
      });
    }
    let scanResult;
    if (effectiveMode === "swing") {
      scanResult = await runSwingScan({ candidateLimit });
    } else {
      scanResult = await runScan({ candidateLimit, includeMinute });
      scanResult.mode = "short";
    }
    setScanCache(cacheKey, scanResult);
    res.render("scan", {
      error: null,
      scanResult,
      autoMode,
      options: optionsForRender,
    });
  } catch (err) {
    let message = err.message || "알 수 없는 오류가 발생했습니다.";
    if (err.response?.data) {
      message = JSON.stringify(err.response.data, null, 2);
    }
    res.render("scan", {
      error: message,
      scanResult: null,
      autoMode,
      options: optionsForRender,
    });
  }
});

let geminiClient = null;
function getGemini() {
  if (geminiClient) return geminiClient;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY가 서버에 설정되지 않았습니다.");
  geminiClient = new GoogleGenerativeAI(key);
  return geminiClient;
}

function buildAiPrompt(snapshot, mode) {
  const modeLabel = mode === "short" ? "단타 (분~시간 단위)" : "스윙 (수일~수주 단위)";
  return `
너는 한국 주식 시장 분석 보조 AI다. 아래는 한 종목의 정량 점수와 차트 요약이다.
전략은 ${modeLabel} 관점에서 해석한다.

[엄격한 규칙]
- 절대 새 숫자를 만들지 마라. 제공된 점수/가격/비율만 인용한다.
- 점수 합산이나 재계산을 시도하지 마라. 해석만 한다.
- 한국어로 답한다.
- 아래 4개 섹션을 정확히 그 제목과 순서로 출력한다. 다른 섹션·인사말·맺음말 금지.
- "강력 매수", "필승", "확정" 같은 단정적 표현 금지. "관심", "조건부", "관망" 등 톤 사용.

## 진입 시그널
${modeLabel} 관점에서 매수를 고려할 만한 근거를 점수와 차트 위치를 들어 2~4문장.

## 리스크 요인
약하거나 상충되는 신호를 2~4문장.

## 손절·관망 가이드
어느 가격대에서 손절하거나 관망 모드로 전환할지. 추천 매수 구간이 있다면 활용. 2~3문장.

## 한 줄 결론
한 문장.

[종목 데이터(JSON)]
${JSON.stringify(snapshot, null, 2)}
`.trim();
}

app.post("/ai/comment", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: "GEMINI_API_KEY가 서버에 설정되지 않았습니다." });
    }
    const mode = req.body.mode === "short" ? "short" : "swing";
    const snapshot = req.body.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      return res.status(400).json({ error: "snapshot 데이터가 없습니다." });
    }
    const prompt = buildAiPrompt(snapshot, mode);
    const client = getGemini();
    const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const model = client.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    res.json({ text, mode, model: modelName });
  } catch (err) {
    console.error("[AI] error:", err.message || err);
    res.status(500).json({ error: err.message || "AI 호출 실패" });
  }
});

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