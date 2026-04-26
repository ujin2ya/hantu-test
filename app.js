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
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3012;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ============================================================
// 사이트 전체 비밀번호 게이트 (SITE_PASSWORD)
// 봇/외부 무단 호출 차단용. /unsubscribe 와 /login 만 화이트리스트.
// 관리자 콘솔(/admin/*)은 별도 ADMIN_TOKEN 으로 한 번 더 보호됨 (이중).
// ============================================================

const SITE_COOKIE = "site_session";
const SITE_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30일
const SITE_PUBLIC_PATHS = new Set(["/login", "/unsubscribe"]);

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const m = header.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function setSiteCookie(res, value) {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${SITE_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SITE_COOKIE_MAX_AGE_SEC}`,
    "Path=/",
  ];
  if (isProd) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function isSiteAuthed(req) {
  const expected = process.env.SITE_PASSWORD;
  if (!expected) return true; // 환경변수 미설정 시 게이트 비활성 (개발 편의)
  const got = getCookie(req, SITE_COOKIE);
  return !!got && got === expected;
}

// 상대경로만 허용 — 오픈 리다이렉트(//evil.com, http://...) 방지
function safeNextUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

app.use((req, res, next) => {
  if (isSiteAuthed(req)) return next();
  if (SITE_PUBLIC_PATHS.has(req.path)) return next();
  // POST 등 비-GET 요청은 폼 재제출이 어려우므로 일단 GET /login 으로 리다이렉트.
  // 메일 링크에서 들어온 GET 요청은 next 로 보존되어 로그인 후 자동 이동.
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
});

app.get("/login", (req, res) => {
  if (isSiteAuthed(req)) return res.redirect(safeNextUrl(req.query.next));
  res.render("site-login", { error: null, next: req.query.next || "/" });
});

app.post("/login", (req, res) => {
  const password = String(req.body.password || "");
  const expected = process.env.SITE_PASSWORD;
  if (!expected || password !== expected) {
    return res.render("site-login", {
      error: "비밀번호가 일치하지 않습니다.",
      next: req.body.next || "/",
    });
  }
  setSiteCookie(res, password);
  res.redirect(safeNextUrl(req.body.next));
});

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

async function processBatched(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    results.push(...batchResults);
  }
  return results;
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

async function getIndexPrice(accessToken, indexCode) {
  const url = `${process.env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-index-price`;
  const res = await axios.get(url, {
    headers: {
      "content-type": "application/json; charset=UTF-8",
      authorization: `Bearer ${accessToken}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "FHPUP02100000",
    },
    params: {
      fid_cond_mrkt_div_code: "U",
      fid_input_iscd: indexCode,
    },
    timeout: 8000,
  });
  if (res.data.rt_cd !== "0") {
    throw new Error(`지수 API 오류 (${indexCode}): ${res.data.msg_cd} / ${res.data.msg1}`);
  }
  return res.data;
}

function normalizeIndex(apiData, label) {
  const o = apiData?.output || {};
  return {
    label,
    price: Number(o.bstp_nmix_prpr || 0),
    changeAbs: Number(o.bstp_nmix_prdy_vrss || o.prdy_vrss || 0),
    changeRate: Number(o.bstp_nmix_prdy_ctrt || o.prdy_ctrt || 0),
  };
}

async function getInvestorTrend(accessToken, stockCode) {
  const url = `${process.env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-investor`;
  const res = await axios.get(url, {
    headers: {
      "content-type": "application/json; charset=UTF-8",
      authorization: `Bearer ${accessToken}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "FHKST01010900",
    },
    params: {
      fid_cond_mrkt_div_code: "J",
      fid_input_iscd: stockCode,
    },
    timeout: 10000,
  });
  if (res.data.rt_cd !== "0") {
    throw new Error(`수급 API 오류: ${res.data.msg_cd} / ${res.data.msg1}`);
  }
  return res.data;
}

function normalizeInvestorTrend(apiData) {
  const rows = Array.isArray(apiData?.output) ? apiData.output : [];
  return rows
    .map((r) => {
      const dateStr = String(r.stck_bsop_date || "").trim();
      if (!/^\d{8}$/.test(dateStr)) return null;
      const closePrice = Number(r.stck_clpr || 0);
      const foreignNetQty = Number(r.frgn_ntby_qty || 0);
      const orgNetQty = Number(r.orgn_ntby_qty || 0);
      const personalNetQty = Number(r.prsn_ntby_qty || 0);
      const foreignNetValue = Number(r.frgn_ntby_tr_pbmn || 0);
      const orgNetValue = Number(r.orgn_ntby_tr_pbmn || 0);
      return {
        date: dateStr,
        closePrice,
        foreignNetQty,
        orgNetQty,
        personalNetQty,
        foreignNetValue,
        orgNetValue,
      };
    })
    .filter(Boolean);
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
    // KIS 응답이 비거나 다른 포맷일 때 우리가 가진 단축코드를 fallback 으로 사용
    stockCode: o.stck_shrn_iscd || stockMeta.shortCode,
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
    marketCap: Number(o.hts_avls || 0),
    listedShares: Number(o.lstn_stcn || 0),
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
    volume: 25,
    position: 17,
    trend: 8,
    rsi: 5,
    macd: 5,
    resistance: 15,
    volatility: 10,
    flow: 15,
  };

  const raw = {
    volume: Number(body.volumeWeight ?? defaults.volume),
    position: Number(body.positionWeight ?? defaults.position),
    trend: Number(body.trendWeight ?? defaults.trend),
    rsi: Number(body.rsiWeight ?? defaults.rsi),
    macd: Number(body.macdWeight ?? defaults.macd),
    resistance: Number(body.resistanceWeight ?? defaults.resistance),
    volatility: Number(body.volatilityWeight ?? defaults.volatility),
    flow: Number(body.flowWeight ?? defaults.flow),
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

function calculateFlowScore(investorRows) {
  if (!Array.isArray(investorRows) || investorRows.length === 0) {
    return { score: 50, explanation: "수급 데이터 없음 (중립 처리)" };
  }
  const sorted = [...investorRows].sort((a, b) => b.date.localeCompare(a.date));
  const sum = (rows, key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);

  const last5 = sorted.slice(0, 5);
  const last20 = sorted.slice(0, 20);

  const fgn5 = sum(last5, "foreignNetQty");
  const org5 = sum(last5, "orgNetQty");
  const fgn20 = sum(last20, "foreignNetQty");
  const org20 = sum(last20, "orgNetQty");

  const consensusDays5 = last5.filter((r) => r.foreignNetQty > 0 && r.orgNetQty > 0).length;
  const dumpDays5 = last5.filter((r) => r.foreignNetQty < 0 && r.orgNetQty < 0).length;

  let score = 50;
  if (fgn5 > 0) score += 8;
  if (org5 > 0) score += 8;
  if (fgn5 < 0) score -= 8;
  if (org5 < 0) score -= 8;
  if (fgn20 > 0) score += 6;
  if (org20 > 0) score += 6;
  if (fgn20 < 0) score -= 6;
  if (org20 < 0) score -= 6;
  score += consensusDays5 * 4;
  score -= dumpDays5 * 4;

  const fmtMan = (qty) => {
    const v = qty / 10000;
    if (Math.abs(v) >= 100) return `${Math.round(v).toLocaleString()}만주`;
    return `${v.toFixed(1)}만주`;
  };
  const sign = (v) => (v > 0 ? "+" : "");
  const explanation =
    `최근 5일 외국인 ${sign(fgn5)}${fmtMan(fgn5)} / 기관 ${sign(org5)}${fmtMan(org5)}, ` +
    `20일 외국인 ${sign(fgn20)}${fmtMan(fgn20)} / 기관 ${sign(org20)}${fmtMan(org20)}` +
    (consensusDays5 ? ` · 동반매수 ${consensusDays5}일` : "") +
    (dumpDays5 ? ` · 동반매도 ${dumpDays5}일` : "");

  return { score: clampScore(score), explanation };
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

function calculateFlowScore(investorRows) {
  if (!Array.isArray(investorRows) || investorRows.length < 3) {
    return { score: 50, explanation: "수급 데이터 부족" };
  }
  const sorted = [...investorRows].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const sumNet = (n) => sorted.slice(0, n).reduce(
    (acc, r) => acc + Number(r.foreignNetValue || 0) + Number(r.orgNetValue || 0),
    0
  );
  const sum5 = sumNet(Math.min(5, sorted.length));
  const sum10 = sumNet(Math.min(10, sorted.length));
  const fmt = (v) => `${(v / 1e8).toFixed(0)}억`;

  let score;
  let label;
  if (sum5 > 0 && sum10 > 0) {
    score = 85;
    label = "단기·중기 모두 순매수";
  } else if (sum5 > 0 && sum10 <= 0) {
    score = 65;
    label = "최근 5일 순매수 진입";
  } else if (sum5 <= 0 && sum10 > 0) {
    score = 45;
    label = "5일 차익 / 10일 누적 순매수";
  } else {
    score = 25;
    label = "5·10일 모두 순매도";
  }

  const accelBonus = sum5 > 0 && sum5 > Math.abs(sum10) * 0.6 ? 10 : 0;
  if (accelBonus) label += " · 최근 가속";

  return {
    score: clampScore(score + accelBonus),
    explanation: `외인+기관 5일 ${fmt(sum5)} / 10일 ${fmt(sum10)} (${label})`,
    detail: { sum5, sum10 },
  };
}

function calculateDryUpScore(dailyData) {
  const items = dailyData.items.slice(0, 20);
  if (items.length < 10) {
    return { score: 50, explanation: "데이터 부족" };
  }
  const recent5 = items.slice(0, 5);
  const last20 = items.slice(0, 20);
  const avg5 = recent5.reduce((acc, v) => acc + Number(v.volume || 0), 0) / recent5.length;
  const avg20 = last20.reduce((acc, v) => acc + Number(v.volume || 0), 0) / last20.length;
  const dryRatio = avg20 > 0 ? avg5 / avg20 : 1;

  const recent10 = items.slice(0, 10);
  const highs = recent10.map((v) => Number(v.highPrice || 0));
  const lows = recent10.map((v) => Number(v.lowPrice || 0));
  const closes = recent10.map((v) => Number(v.closePrice || 0));
  const avgClose = closes.reduce((a, b) => a + b, 0) / closes.length || 1;
  const rangePct = ((Math.max(...highs) - Math.min(...lows)) / avgClose) * 100;

  let score = 40;
  if (dryRatio < 0.55 && rangePct < 5) score = 90;
  else if (dryRatio < 0.7 && rangePct < 6) score = 78;
  else if (dryRatio < 0.85 && rangePct < 8) score = 62;
  else if (dryRatio < 1.0) score = 50;
  else score = 30;

  return {
    score: clampScore(score),
    explanation: `5일/20일 거래량 비 ${dryRatio.toFixed(2)} · 10일 변동폭 ${rangePct.toFixed(1)}%`,
    detail: { dryRatio, rangePct },
  };
}

function calculateSqueezeScore(dailyData, currentPrice) {
  const closes = dailyData.items.slice(0, 60).reverse().map((v) => Number(v.closePrice || 0));
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  if (!ma5 || !ma20 || !ma60 || !currentPrice) {
    return { score: 50, explanation: "이평선 데이터 부족" };
  }
  const maxMa = Math.max(ma5, ma20, ma60);
  const minMa = Math.min(ma5, ma20, ma60);
  const spreadPct = ((maxMa - minMa) / currentPrice) * 100;

  let score = 40;
  if (spreadPct < 1.5) score = 90;
  else if (spreadPct < 2.5) score = 75;
  else if (spreadPct < 4) score = 58;
  else if (spreadPct < 6) score = 45;
  else score = 30;

  return {
    score: clampScore(score),
    explanation: `5/20/60일선 수렴폭 ${spreadPct.toFixed(2)}%`,
    detail: { spreadPct, ma5, ma20, ma60 },
  };
}

// 추세 추종 점수 — trending 종목을 제대로 잡기 위한 컴포넌트.
// 박스권/조정만 잡던 모델의 약점을 보완 (강세 종목은 점수가 안 오르던 문제).
// 신고가·정배열·이평선 위는 모두 "추세가 살아있다"는 신호.
function calculateTrendFollowingScore(dailyData) {
  const items = dailyData?.items || [];
  if (items.length < 60) {
    return { score: 50, explanation: "추세 데이터 부족 (60일 미만)" };
  }
  const closes = items.map((it) => Number(it.closePrice || 0)).filter((v) => v > 0);
  const today = closes[0];
  if (!today) return { score: 50, explanation: "종가 없음" };

  // 최신 N개 종가 평균
  const smaN = (n) =>
    closes.length < n ? null : closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const ma5 = smaN(5);
  const ma20 = smaN(20);
  const ma60 = smaN(60);

  // 최근 N일 최고가 (today 포함)
  const highN = (n) =>
    items.length < n
      ? null
      : Math.max(...items.slice(0, n).map((it) => Number(it.highPrice || 0)).filter((v) => v > 0));
  const high20 = highN(20);
  const high60 = highN(60);

  let score = 0;
  const reasons = [];

  if (ma20 != null && today > ma20) { score += 25; reasons.push("20일선 위"); }
  if (ma60 != null && today > ma60) { score += 25; reasons.push("60일선 위"); }
  if (ma5 != null && ma20 != null && ma60 != null && ma5 > ma20 && ma20 > ma60) {
    score += 25;
    reasons.push("정배열");
  }
  // 부동소수점 + 장중 변동 마진 0.5% 허용
  if (high20 != null && today >= high20 * 0.995) { score += 15; reasons.push("20일 신고가"); }
  if (high60 != null && today >= high60 * 0.995) { score += 10; reasons.push("60일 신고가"); }

  return {
    score: clampScore(score),
    explanation: reasons.length ? `추세 양호: ${reasons.join(", ")}` : "추세 약함",
  };
}

// Phase 3 — 단기 폭등 직후 매수 페널티.
// 박스권 종목의 일시 반등 천장에서 매수하는 함정을 거른다.
// 추세 종목의 정상적 상승 (5일 ~5%) 은 거의 영향 없음.
function calculateOverheatPenalty(dailyData) {
  const items = dailyData?.items || [];
  if (items.length < 6) return { penalty: 0, change5d: 0, explanation: "데이터 부족" };

  const today = Number(items[0].closePrice || 0);
  const fiveAgo = Number(items[5]?.closePrice || 0);
  if (!today || !fiveAgo) return { penalty: 0, change5d: 0, explanation: "종가 부재" };

  const change5d = ((today - fiveAgo) / fiveAgo) * 100;

  // Phase 3.1 — 페널티 강도 절반으로 약화 (이전: -10/-20/-25/-30).
  // 정상적 추세 진행도 너무 많이 거르는 부작용 줄임. 큰 폭등만 명확히 페널티.
  let penalty = 0;
  let label = "";
  if (change5d >= 25)      { penalty = 20; label = "극심한 과열"; }
  else if (change5d >= 20) { penalty = 15; label = "과열"; }
  else if (change5d >= 15) { penalty = 10; label = "단기 급등"; }
  else if (change5d >= 10) { penalty = 5;  label = "단기 상승"; }
  else                     { penalty = 0;  label = "정상"; }

  return {
    penalty,
    change5d,
    explanation: `5일 ${change5d >= 0 ? "+" : ""}${change5d.toFixed(1)}% (${label})`,
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

function calculateMovingAverages(dailyData) {
  const closes = (dailyData?.items || [])
    .map((it) => Number(it.closePrice || 0))
    .filter((p) => p > 0);
  function sma(n) {
    if (closes.length < n) return null;
    return closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
  }
  return { sma5: sma(5), sma20: sma(20), sma60: sma(60), sma120: sma(120) };
}

function buildMATiers(currentPrice, mas) {
  const tiersConfig = [
    { key: "aggressive", label: "5일선 매수", maKey: "sma5", period: 5 },
    { key: "neutral", label: "20일선 매수", maKey: "sma20", period: 20 },
    { key: "conservative", label: "60일선 매수", maKey: "sma60", period: 60 },
  ];
  const tiers = {};
  tiersConfig.forEach((cfg) => {
    const ma = mas[cfg.maKey];
    if (!ma || ma <= 0) {
      tiers[cfg.key] = {
        label: cfg.label,
        bandLabel: `${cfg.period}일 SMA`,
        price: null,
        gapPercent: "-",
        description: `${cfg.period}일 이평선 계산 불가 (일봉 데이터 부족)`,
        unavailable: true,
      };
      return;
    }
    if (ma >= currentPrice) {
      const overGap = ((ma - currentPrice) / currentPrice) * 100;
      tiers[cfg.key] = {
        label: cfg.label,
        bandLabel: `${cfg.period}일 SMA`,
        price: Math.round(ma),
        gapPercent: overGap.toFixed(1),
        description: `${cfg.period}일선이 현재가 위(${overGap.toFixed(1)}% 상단)에 있어 저항 역할 — 돌파 후 진입 검토`,
        broken: true,
      };
      return;
    }
    const gap = ((currentPrice - ma) / currentPrice) * 100;
    tiers[cfg.key] = {
      label: cfg.label,
      bandLabel: `${cfg.period}일 SMA`,
      price: Math.round(ma),
      gapPercent: gap.toFixed(1),
      description: `${cfg.period}일 이동평균이 ${gap.toFixed(1)}% 아래에서 지지`,
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

  const mas = calculateMovingAverages(dailyData);
  const ma = (mas.sma5 || mas.sma20 || mas.sma60)
    ? {
        tiers: buildMATiers(currentPrice, mas),
        values: {
          sma5: mas.sma5 ? Math.round(mas.sma5) : null,
          sma20: mas.sma20 ? Math.round(mas.sma20) : null,
          sma60: mas.sma60 ? Math.round(mas.sma60) : null,
          sma120: mas.sma120 ? Math.round(mas.sma120) : null,
        },
      }
    : null;

  return {
    recommendedTier,
    tierExplanation,
    fixed,
    atr,
    ma,
    hasSupports: supportBins.length > 0,
  };
}

function buildScoreModel(currentData, dailyData, weeklyData, monthlyData, yearlyData, dailySeries, weeklySeries, monthlySeries, yearlySeries, weights, investorRows) {
  const volume = calculateVolumeScore(currentData, dailyData, weeklyData, monthlyData, yearlyData);
  const position = calculatePositionScore(dailySeries, weeklySeries, monthlySeries, yearlySeries);
  const trend = calculateTrendScore(dailyData, weeklyData, currentData.currentPrice);
  const rsi = calculateRSI(dailyData);
  const macd = calculateMACD(dailyData);
  const trapped = estimateTrappedZones(dailyData, currentData.currentPrice);
  const resistance = trapped.resistanceScore;
  const volatility = calculateVolatilityScore(dailyData);
  const flow = calculateFlowScore(investorRows);
  const buyZones = estimateBuyZones(dailyData, currentData.currentPrice);

  const total =
    volume.score * (weights.volume / 100) +
    position.score * (weights.position / 100) +
    trend.score * (weights.trend / 100) +
    rsi.score * (weights.rsi / 100) +
    macd.score * (weights.macd / 100) +
    resistance.score * (weights.resistance / 100) +
    volatility.score * (weights.volatility / 100) +
    flow.score * (weights.flow / 100);

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
    flow,
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

// ETN/ETF/액티브 펀드/레버리지·인버스 등 비-개별주 종목명 패턴.
// 점수 모델이 개별 주식용으로 설계됐기 때문에 이런 상품들은 후보에서 제외해야 의미 있는 결과가 나옴.
const NON_STOCK_PATTERNS = [
  /\bETN\b/i, /\bETF\b/i,
  /액티브/, /레버리지/, /인버스/, /선물/,
  /^KODEX\b/i, /^TIGER\b/i, /^KBSTAR\b/i, /^ARIRANG\b/i, /^KOSEF\b/i,
  /^HANARO\b/i, /^SOL\s/i, /^PLUS\s/i, /^RISE\s/i, /^ACE\s/i, /^KIWOOM\s/i,
  /^삼성\s.*ETN/i, /^한화\s.*ETN/i, /^메리츠\s.*ETN/i, /^신한\s.*ETN/i,
];

// 우선주 식별: 종목명 끝 "우"/"우B"/"숫자우"/"숫자우B" + 단축코드 끝자리 5/7/9/K/L (한국 거래소 관행).
// 두 조건 모두 만족해야 우선주로 분류 — 이름만 봤을 때의 false positive (에코글로우/이오플로우/성우 등) 방지.
function isPreferredStock(name, shortCode) {
  if (!name || !shortCode) return false;
  if (!/[0-9]?우B?$/.test(name)) return false;
  if (!/[579KL]$/i.test(shortCode)) return false;
  return true;
}

function isIndividualStock(name, shortCode) {
  if (!name) return true; // 이름 없으면 안전 디폴트로 통과
  if (NON_STOCK_PATTERNS.some((re) => re.test(name))) return false;
  if (isPreferredStock(name, shortCode)) return false;
  return true;
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
  // ETN/ETF/액티브 펀드 + 우선주 제외 (점수 모델은 개별 보통주 분석용)
  const beforeFilter = merged.length;
  const filtered = merged.filter((r) => isIndividualStock(r.name, r.shortCode));
  const filteredOut = beforeFilter - filtered.length;
  if (filteredOut > 0) {
    console.log(`[SCAN] ETN/ETF/우선주 등 비-보통주 ${filteredOut}건 제외 → ${filtered.length}건 남음`);
  }
  filtered.sort((a, b) => {
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return (b.tradeValue || 0) - (a.tradeValue || 0);
  });
  return filtered.slice(0, limit);
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

  async function processOne(cand, index) {
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
      if (index === 0) {
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
          if (index === 0) {
            console.log(`[SCAN] minute output2 rows (${cand.shortCode}): ${Array.isArray(minuteRaw.output2) ? minuteRaw.output2.length : "N/A"}`);
            logSample(`minute output2[0] (${cand.shortCode})`, Array.isArray(minuteRaw.output2) ? minuteRaw.output2[0] : null);
          }
          minuteRows = normalizeMinuteChart(minuteRaw);
        } catch (e) {
          // 분봉 실패는 종목 자체 실패로 보지 않음
        }
      }

      const score = buildShortTermScore(currentData, minuteRows);
      return {
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
      };
    } catch (e) {
      return {
        shortCode: cand.shortCode,
        name: cand.name,
        error: e.message || String(e),
        sources: cand.sources,
      };
    }
  }

  const t0 = Date.now();
  const results = await processBatched(candidates, 5, processOne);
  console.log(`[SCAN] per-stock fetch elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s (batch=5)`);

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

// 후보 풀 캐시 — 장중·장 마감 후 정상 호출 시 저장 → 새벽/주말 스캔에서 재사용.
// KIS 거래대금/거래증가율 순위 API 가 장 시작 전에 비정상 데이터를 반환하는 문제를 우회.
const SCAN_CANDIDATES_CACHE_PATH = path.join(__dirname, "cache", "scan-candidates.json");
const SCAN_CANDIDATES_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

function isOffMarketKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  if (day === 0 || day === 6) return true;          // 주말
  if (hour < 9) return true;                          // 장 시작 전
  if (hour > 15) return true;                         // 장 마감 후 (16시 이후)
  if (hour === 15 && minute > 30) return true;        // 15:30 이후
  return false;
}

function loadScanCandidatesCache() {
  try {
    const raw = fs.readFileSync(SCAN_CANDIDATES_CACHE_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (!data?.candidates?.length) return null;
    const ageMs = Date.now() - new Date(data.savedAt).getTime();
    if (ageMs > SCAN_CANDIDATES_CACHE_TTL_MS) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function saveScanCandidatesCache(candidates) {
  try {
    const dir = path.dirname(SCAN_CANDIDATES_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      SCAN_CANDIDATES_CACHE_PATH,
      JSON.stringify({ savedAt: new Date().toISOString(), candidates })
    );
  } catch (e) {
    console.warn("[SWING] candidates 캐시 저장 실패:", e.message);
  }
}

async function runSwingScan({ candidateLimit }) {
  const accessToken = await safeApiCall(() => getAccessToken(), 300);

  let candidates;

  // 장외 시간이면 캐시(직전 정상 시간대 결과) 우선 사용
  if (isOffMarketKST()) {
    const cache = loadScanCandidatesCache();
    if (cache) {
      candidates = cache.candidates.slice(0, candidateLimit);
      const ageH = ((Date.now() - new Date(cache.savedAt).getTime()) / 3600000).toFixed(1);
      console.log(`[SWING] 장외 시간 → 캐시된 후보 풀 사용 (저장 ${cache.savedAt}, ${ageH}시간 전, ${candidates.length}건)`);
    }
  }

  // 캐시 없거나 정상 시간대 → KIS 직접 호출
  if (!candidates) {
    const volumeRaw = await safeApiCall(() => getVolumeRank(accessToken, "3"), 600);
    console.log(`[SWING] volume-rank(BLNG=3) output rows: ${Array.isArray(volumeRaw.output) ? volumeRaw.output.length : "N/A"}`);
    const increaseRaw = await safeApiCall(() => getVolumeRank(accessToken, "1"), 600);
    console.log(`[SWING] volume-rank(BLNG=1, 거래증가율) output rows: ${Array.isArray(increaseRaw.output) ? increaseRaw.output.length : "N/A"}`);

    const volumeRows = normalizeRankRows(volumeRaw, "거래대금");
    const increaseRows = normalizeRankRows(increaseRaw, "거래증가율");
    candidates = mergeRankCandidates([
      { rows: volumeRows, label: "거래대금" },
      { rows: increaseRows, label: "거래증가율" },
    ], candidateLimit);
    console.log(`[SWING] candidates after merge: ${candidates.length}`);

    // 정상 시간대 호출 결과만 캐시 갱신 (장외 시간엔 비정상 데이터일 수 있어서 저장 안 함)
    if (!isOffMarketKST() && candidates.length > 0) {
      saveScanCandidatesCache(candidates);
      console.log(`[SWING] candidates 캐시 갱신 (${candidates.length}건)`);
    }
  }

  const { startDate, endDate } = getDateRange(6);
  const defaultWeights = { volume: 25, position: 17, trend: 8, rsi: 5, macd: 5, resistance: 15, volatility: 10, flow: 15 };
  // 백테스팅과 점수를 일치시키기 위해 nightlyWeights 에서 flow 제외 (KIS 가 historical 수급 데이터를 안 주므로 백테스트에 flow 를 못 넣음).
  // Phase 2: trendFollow 추가 (강세 종목 미반응 문제 보완) → 합 100, 정규화 불필요.
  const nightlyWeights = { volume: 18, position: 12, trend: 8, rsi: 5, macd: 5, resistance: 10, volatility: 8, dryUp: 12, squeeze: 10, trendFollow: 12 };
  const NIGHTLY_WEIGHT_DENOM = 100;

  async function processOne(cand, index) {
    try {
      const meta = stocksData.byShortCode?.[cand.shortCode] || null;
      const stockMeta = {
        shortCode: cand.shortCode,
        standardCode: meta?.standardCode || "",
        name: cand.name || meta?.name || cand.shortCode,
        market: meta?.market || "-",
      };

      const investorPromise = safeApiCall(() => getInvestorTrend(accessToken, cand.shortCode), 150)
        .catch((e) => {
          console.warn(`[SWING flow] 수급 조회 실패 (${cand.shortCode}): ${e.message || e}`);
          return null;
        });

      const [currentRaw, dailyRaw, weeklyRaw, monthlyRaw, yearlyRaw, investorRaw] = await Promise.all([
        safeApiCall(() => getCurrentPrice(accessToken, cand.shortCode), 150),
        safeApiCall(() => getPeriodChart(accessToken, cand.shortCode, "D", startDate, endDate), 150),
        safeApiCall(() => getPeriodChart(accessToken, cand.shortCode, "W", startDate, endDate), 150),
        safeApiCall(() => getPeriodChart(accessToken, cand.shortCode, "M", startDate, endDate), 150),
        safeApiCall(() => getPeriodChart(accessToken, cand.shortCode, "Y", startDate, endDate), 150),
        investorPromise,
      ]);

      if (index === 0) {
        logSample(`[SWING] inquire-price output (${cand.shortCode})`, currentRaw.output);
      }
      let currentData = normalizeCurrentPrice(currentRaw, stockMeta);

      const investorRows = investorRaw ? normalizeInvestorTrend(investorRaw) : [];

      const dailyData = normalizePeriodData(dailyRaw, stockMeta, "DAY");
      const weeklyData = normalizePeriodData(weeklyRaw, stockMeta, "WEEK");
      const monthlyData = normalizePeriodData(monthlyRaw, stockMeta, "MONTH");
      const yearlyData = normalizePeriodData(yearlyRaw, stockMeta, "YEAR");

      // 장 시작 전 / 휴장 시 currentData 가 "오늘 거래 0" 으로 채워져 volume 점수가 0 이 됨.
      // 이 경우 가장 최근 일봉(=어제 마감) 으로 currentData 대체 → 새벽/주말 스윙 스캔도 의미 있는 점수.
      const noTodayData = currentData.todayVolume === 0 && currentData.changeRate === 0;
      if ((isOffMarketKST() || noTodayData) && dailyData.items.length > 0) {
        // 오늘 날짜 일봉은 KIS 가 장 시작 전에도 빈 데이터로 미리 채워서 줄 수 있음 → 건너뛰고 진짜 직전 거래일 사용
        const todayStr = (() => {
          const k = new Date(Date.now() + 9 * 60 * 60 * 1000);
          const y = k.getUTCFullYear();
          const m = String(k.getUTCMonth() + 1).padStart(2, "0");
          const d = String(k.getUTCDate()).padStart(2, "0");
          return `${y}${m}${d}`;
        })();
        const startIdx = dailyData.items[0]?.date === todayStr ? 1 : 0;
        const yesterday = dailyData.items[startIdx];
        const dayBefore = dailyData.items[startIdx + 1];
        if (yesterday) {
          currentData = {
            ...currentData,
            currentPrice: yesterday.closePrice,
            todayVolume: yesterday.volume,
            openPrice: yesterday.openPrice,
            highPrice: yesterday.highPrice,
            lowPrice: yesterday.lowPrice,
            changeRate: dayBefore && dayBefore.closePrice
              ? ((yesterday.closePrice - dayBefore.closePrice) / dayBefore.closePrice) * 100
              : 0,
          };
          if (index === 0) {
            console.log(`[SWING] 장외 시간 → 직전 거래일(${yesterday.date}) 일봉을 currentData 로 사용 (오늘 ${todayStr} 빈 일봉 ${startIdx === 1 ? "건너뜀" : "없음"})`);
          }
        }
      }

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
        defaultWeights,
        investorRows
      );

      const recTier = scoreModel.buyRecommendation?.recommendedTier;
      const buyTierObj = recTier ? scoreModel.buyRecommendation?.fixed?.tiers?.[recTier] : null;

      const flow = calculateFlowScore(investorRows);
      const dryUp = calculateDryUpScore(dailyData);
      const squeeze = calculateSqueezeScore(dailyData, currentData.currentPrice);
      const trendFollow = calculateTrendFollowingScore(dailyData);
      const overheat = calculateOverheatPenalty(dailyData);

      const nightlyComponents = {
        volume: scoreModel.volume.score,
        position: scoreModel.position.score,
        trend: scoreModel.trend.score,
        rsi: scoreModel.rsi.score,
        macd: scoreModel.macd.score,
        resistance: scoreModel.resistance.score,
        volatility: scoreModel.volatility.score,
        dryUp: dryUp.score,
        squeeze: squeeze.score,
        trendFollow: trendFollow.score,
      };
      // 10요소 가중합 (만점 100) → 정규화 곱 1 이지만 코드는 일관성 위해 유지
      const nightlyRaw = Object.entries(nightlyWeights).reduce(
        (acc, [k, w]) => acc + (nightlyComponents[k] || 0) * (w / 100),
        0
      );
      // Phase 3 — 단기 폭등 직후 페널티 (천장 매수 거름). 0~30점 차감, 0 미만으로는 안 떨어짐.
      const nightlyTotal = Math.max(
        0,
        Math.round((nightlyRaw / NIGHTLY_WEIGHT_DENOM) * 100) - overheat.penalty
      );

      const yearHighDaily = dailyData.items.slice(0, 252);
      const yearHigh = yearHighDaily.length
        ? Math.max(...yearHighDaily.map((it) => Number(it.highPrice || 0)))
        : 0;
      const yearHighRatio = yearHigh > 0 ? currentData.currentPrice / yearHigh : null;

      return {
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
        nightlyExtras: {
          nightlyTotal,
          components: nightlyComponents,
          flow: { score: flow.score, explanation: flow.explanation },
          dryUp: { score: dryUp.score, explanation: dryUp.explanation },
          squeeze: { score: squeeze.score, explanation: squeeze.explanation },
          trendFollow: { score: trendFollow.score, explanation: trendFollow.explanation },
          overheat: { penalty: overheat.penalty, change5d: overheat.change5d, explanation: overheat.explanation },
          marketCap: currentData.marketCap,
          yearHigh,
          yearHighRatio,
        },
      };
    } catch (e) {
      return {
        shortCode: cand.shortCode,
        name: cand.name,
        error: e.message || String(e),
        sources: cand.sources,
      };
    }
  }

  const t0 = Date.now();
  const results = await processBatched(candidates, 3, processOne);
  console.log(`[SWING] per-stock fetch elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s (batch=3)`);

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

  const requestedMode = String(req.query.mode || "");
  const isReturning =
    requestedMode === "short" || requestedMode === "swing";

  if (isReturning) {
    const candidateLimit = Math.max(
      5,
      Math.min(60, Number(req.query.candidateLimit) || defaultLimitForMode(requestedMode))
    );
    const includeMinute = req.query.includeMinute !== "off";
    const cacheKey = `${requestedMode}:${candidateLimit}:${includeMinute ? 1 : 0}`;
    const cached = getScanCache(cacheKey);
    return res.render("scan", {
      error: null,
      scanResult: cached ? { ...cached, fromCache: true } : null,
      autoMode,
      options: {
        mode: requestedMode,
        effectiveMode: requestedMode,
        candidateLimit,
        includeMinute,
      },
    });
  }

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

const AI_CACHE_TTL_MS = 10 * 60 * 1000;
const aiCommentCache = new Map();
function getAiCache(key) {
  const hit = aiCommentCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    aiCommentCache.delete(key);
    return null;
  }
  return hit.value;
}
function setAiCache(key, value) {
  aiCommentCache.set(key, { value, expiresAt: Date.now() + AI_CACHE_TTL_MS });
}

const DART_CORP_CODE_PATH = path.join(__dirname, ".dart-corp-code.json");
let dartCorpMap = null;
let dartCorpLoadInflight = null;

async function loadDartCorpCodeMap() {
  if (dartCorpMap) return dartCorpMap;
  if (dartCorpLoadInflight) return dartCorpLoadInflight;
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY가 서버에 설정되지 않았습니다.");

  dartCorpLoadInflight = (async () => {
    try {
      const cached = JSON.parse(fs.readFileSync(DART_CORP_CODE_PATH, "utf-8"));
      if (cached && typeof cached === "object" && Object.keys(cached).length > 1000) {
        console.log(`[dart] corp_code 캐시 로드: ${Object.keys(cached).length}개`);
        dartCorpMap = cached;
        return dartCorpMap;
      }
    } catch (_) {
      console.log("[dart] corp_code 캐시 없음 — 신규 다운로드 시작");
    }

    const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`;
    const response = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(Buffer.from(response.data));
    const xmlEntry = zip.getEntries().find((e) => /CORPCODE\.xml$/i.test(e.entryName));
    if (!xmlEntry) throw new Error("DART corpCode ZIP 안에 CORPCODE.xml 없음");
    const xml = xmlEntry.getData().toString("utf-8");

    const map = {};
    const blockRegex = /<list>([\s\S]*?)<\/list>/g;
    const corpRegex = /<corp_code>\s*([0-9]+)\s*<\/corp_code>/;
    const stockRegex = /<stock_code>\s*([0-9]{6})\s*<\/stock_code>/;
    let m;
    while ((m = blockRegex.exec(xml)) !== null) {
      const block = m[1];
      const cm = corpRegex.exec(block);
      const sm = stockRegex.exec(block);
      if (cm && sm) map[sm[1]] = cm[1];
    }
    console.log(`[dart] corp_code XML 파싱 완료: ${Object.keys(map).length}개`);

    try {
      fs.writeFileSync(DART_CORP_CODE_PATH, JSON.stringify(map));
      console.log(`[dart] corp_code 캐시 저장: ${DART_CORP_CODE_PATH}`);
    } catch (e) {
      console.warn("[dart] 캐시 저장 실패:", e.message);
    }
    dartCorpMap = map;
    return dartCorpMap;
  })();

  try {
    return await dartCorpLoadInflight;
  } finally {
    dartCorpLoadInflight = null;
  }
}

const DISCLOSURE_CACHE_TTL_MS = 30 * 60 * 1000;
const disclosureCache = new Map();

async function fetchDartDisclosures(stockCode) {
  const hit = disclosureCache.get(stockCode);
  if (hit && Date.now() < hit.expiresAt) return hit.value;

  const map = await loadDartCorpCodeMap();
  const corpCode = map[stockCode];
  if (!corpCode) {
    const value = { items: [], note: "DART에 등록된 종목이 아닙니다." };
    disclosureCache.set(stockCode, { value, expiresAt: Date.now() + DISCLOSURE_CACHE_TTL_MS });
    return value;
  }

  const today = new Date();
  const past = new Date(today);
  past.setMonth(past.getMonth() - 6);
  const fmt = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  const response = await axios.get("https://opendart.fss.or.kr/api/list.json", {
    params: {
      crtfc_key: process.env.DART_API_KEY,
      corp_code: corpCode,
      bgn_de: fmt(past),
      end_de: fmt(today),
      page_count: 20,
      sort: "date",
      sort_mth: "desc",
    },
    timeout: 8000,
  });
  const data = response.data || {};
  if (data.status && data.status !== "000" && data.status !== "013") {
    throw new Error(`DART API 오류 [${data.status}]: ${data.message || "알 수 없음"}`);
  }
  const items = (data.list || []).slice(0, 20).map((it) => ({
    title: it.report_nm || "",
    submitter: it.flr_nm || "",
    date: it.rcept_dt
      ? `${it.rcept_dt.slice(0, 4)}-${it.rcept_dt.slice(4, 6)}-${it.rcept_dt.slice(6, 8)}`
      : "",
    url: it.rcept_no ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${it.rcept_no}` : "",
    rm: it.rm || "",
  })).filter((x) => x.title && x.url);

  const value = { items };
  disclosureCache.set(stockCode, { value, expiresAt: Date.now() + DISCLOSURE_CACHE_TTL_MS });
  return value;
}

app.get("/disclosures", async (req, res) => {
  const code = String(req.query.code || "").trim();
  if (!/^\d{5,6}$/.test(code)) {
    return res.status(400).json({ error: "code 파라미터가 올바르지 않습니다." });
  }
  if (!process.env.DART_API_KEY) {
    return res.status(503).json({ error: "DART_API_KEY가 서버에 설정되지 않았습니다." });
  }
  try {
    const result = await fetchDartDisclosures(code);
    res.json({ code, ...result });
  } catch (err) {
    console.error("[dart] error:", err.message || err);
    res.status(500).json({ error: err.message || "공시 조회 실패" });
  }
});

const NEWS_CACHE_TTL_MS = 30 * 60 * 1000;
const newsCache = new Map();

function decodeBasicHtmlEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function formatNaverDatetime(s) {
  if (!s || typeof s !== "string" || s.length < 12) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

async function fetchNaverStockNews(code) {
  const hit = newsCache.get(code);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  const url = `https://m.stock.naver.com/api/news/stock/${code}?pageSize=10&page=1`;
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; hantu-test/1.0)" },
    timeout: 6000,
  });
  const clusters = Array.isArray(data) ? data : [];
  const items = clusters
    .map((cluster) => (cluster.items || [])[0])
    .filter(Boolean)
    .slice(0, 10)
    .map((it) => ({
      title: decodeBasicHtmlEntities(it.titleFull || it.title || ""),
      office: it.officeName || "",
      datetime: formatNaverDatetime(it.datetime),
      url: it.mobileNewsUrl || "",
    }))
    .filter((x) => x.title && x.url);
  newsCache.set(code, { value: items, expiresAt: Date.now() + NEWS_CACHE_TTL_MS });
  return items;
}

app.get("/news", async (req, res) => {
  const code = String(req.query.code || "").trim();
  if (!/^\d{5,6}$/.test(code)) {
    return res.status(400).json({ error: "code 파라미터가 올바르지 않습니다." });
  }
  try {
    const items = await fetchNaverStockNews(code);
    res.json({ code, items });
  } catch (err) {
    console.error("[news] error:", err.message || err);
    res.status(500).json({ error: err.message || "뉴스 조회 실패" });
  }
});

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
    const cacheKey = `${snapshot.code || "_"}:${mode}`;
    const cached = getAiCache(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    const prompt = buildAiPrompt(snapshot, mode);
    const client = getGemini();
    const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const model = client.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const payload = { text, mode, model: modelName };
    setAiCache(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error("[AI] error:", err.message || err);
    res.status(500).json({ error: err.message || "AI 호출 실패" });
  }
});

app.get("/", (req, res) => {
  const incomingQuery = String(req.query.query || "").trim();
  if (incomingQuery) {
    req.body = { stockQuery: incomingQuery };
    return handleSearch(req, res);
  }
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
      volume: 25,
      position: 17,
      trend: 8,
      rsi: 5,
      macd: 5,
      resistance: 15,
      volatility: 10,
      flow: 15,
    },
    market: null,
    autoMode: pickAutoMode(),
    returnUrl: null,
  });
});

function buildScanReturnUrl(body) {
  if (body?.from !== "scan") return null;
  const mode = String(body.scanMode || "").replace(/[^a-z]/gi, "");
  const limit = Number(body.scanLimit) || 0;
  const includeMinute = body.scanIncludeMinute === "1" ? "on" : "off";
  if (!mode || !limit) return "/scan";
  return `/scan?mode=${encodeURIComponent(mode)}&candidateLimit=${limit}&includeMinute=${includeMinute}`;
}

const handleSearch = async (req, res) => {
  const returnUrl = buildScanReturnUrl(req.body);
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
        market: null,
        autoMode: pickAutoMode(),
        returnUrl,
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
        market: null,
        autoMode: pickAutoMode(),
        returnUrl,
      });
    }

    let selected = stockInfo;
    let candidates = [];

    if (Array.isArray(stockInfo)) {
      candidates = stockInfo;
      selected = stockInfo[0];
    }

    const accessToken = await safeApiCall(() => getAccessToken(), 300);

    const { startDate, endDate } = getDateRange(6);

    const investorPromise = safeApiCall(() => getInvestorTrend(accessToken, selected.shortCode), 150)
      .catch((e) => {
        console.warn(`[flow] 수급 데이터 조회 실패 (${selected.shortCode}): ${e.message || e}`);
        return null;
      });
    const kospiPromise = safeApiCall(() => getIndexPrice(accessToken, "0001"), 150)
      .catch((e) => {
        console.warn(`[market] KOSPI 조회 실패: ${e.message || e}`);
        return null;
      });
    const kosdaqPromise = safeApiCall(() => getIndexPrice(accessToken, "1001"), 150)
      .catch((e) => {
        console.warn(`[market] KOSDAQ 조회 실패: ${e.message || e}`);
        return null;
      });

    const [currentRaw, dailyRaw, weeklyRaw, monthlyRaw, yearlyRaw, investorRaw, kospiRaw, kosdaqRaw] = await Promise.all([
      safeApiCall(() => getCurrentPrice(accessToken, selected.shortCode), 150),
      safeApiCall(() => getPeriodChart(accessToken, selected.shortCode, "D", startDate, endDate), 150),
      safeApiCall(() => getPeriodChart(accessToken, selected.shortCode, "W", startDate, endDate), 150),
      safeApiCall(() => getPeriodChart(accessToken, selected.shortCode, "M", startDate, endDate), 150),
      safeApiCall(() => getPeriodChart(accessToken, selected.shortCode, "Y", startDate, endDate), 150),
      investorPromise,
      kospiPromise,
      kosdaqPromise,
    ]);

    const currentData = normalizeCurrentPrice(currentRaw, selected);
    const investorRows = investorRaw ? normalizeInvestorTrend(investorRaw) : [];
    const market = {
      kospi: kospiRaw ? normalizeIndex(kospiRaw, "코스피") : null,
      kosdaq: kosdaqRaw ? normalizeIndex(kosdaqRaw, "코스닥") : null,
    };
    const stockMarket = (selected.market || "").toUpperCase();
    const ownIndex = stockMarket.includes("KOSDAQ") ? market.kosdaq : market.kospi;
    market.relativeRate = ownIndex
      ? Number((currentData.changeRate - ownIndex.changeRate).toFixed(2))
      : null;
    market.ownIndexLabel = ownIndex?.label || null;

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
      weights,
      investorRows
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
      market,
      autoMode: pickAutoMode(),
      returnUrl,
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
      market: null,
      autoMode: pickAutoMode(),
      returnUrl,
    });
  }
};

app.post("/search", handleSearch);

// ============================================================
// 이메일 구독 / 발송 / 크론 (밤 배치 스윙 스캔 발송)
// ============================================================

const SUBSCRIBERS_PATH = path.join(__dirname, ".subscribers.json");
const MAX_SUBSCRIBERS = 10;

function loadSubscribers() {
  try {
    const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_PATH, "utf-8"));
    return Array.isArray(data.subscribers) ? data.subscribers : [];
  } catch (_) {
    return [];
  }
}

function saveSubscribers(list) {
  fs.writeFileSync(SUBSCRIBERS_PATH, JSON.stringify({ subscribers: list }, null, 2));
}

let mailerTransport = null;
function getMailer() {
  if (mailerTransport) return mailerTransport;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP_USER / SMTP_PASS 환경변수가 설정되지 않았습니다.");
  }
  mailerTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return mailerTransport;
}

function renderEmailHtml(template, data) {
  const ejs = require("ejs");
  const filePath = path.join(__dirname, "views", "email", `${template}.ejs`);
  return new Promise((resolve, reject) => {
    ejs.renderFile(filePath, data, (err, html) => {
      if (err) reject(err);
      else resolve(html);
    });
  });
}

async function fetchMarketIndices(accessToken) {
  const [kospiRaw, kosdaqRaw] = await Promise.all([
    safeApiCall(() => getIndexPrice(accessToken, "0001"), 150).catch(() => null),
    safeApiCall(() => getIndexPrice(accessToken, "1001"), 150).catch(() => null),
  ]);
  return {
    kospi: kospiRaw ? normalizeIndex(kospiRaw, "코스피") : null,
    kosdaq: kosdaqRaw ? normalizeIndex(kosdaqRaw, "코스닥") : null,
  };
}

async function sendSwingScanEmails(opts = {}) {
  const dryRun = !!opts.dryRun;
  const targetEmail = opts.targetEmail || null;

  const allSubscribers = loadSubscribers();
  const subscribers = targetEmail
    ? allSubscribers.filter((s) => s.email === targetEmail)
    : allSubscribers;

  if (subscribers.length === 0) {
    console.log("[mail] 발송 대상 0명, 종료");
    return { sent: 0, failed: 0, skipped: "no_subscribers" };
  }

  console.log("[mail] 스윙 스캔 시작 (candidateLimit=300, 밤 배치)");
  const t0 = Date.now();
  let scanResult;
  try {
    scanResult = await runSwingScan({ candidateLimit: 300 });
  } catch (e) {
    console.error("[mail] 스캔 실패:", e.message || e);
    return { sent: 0, failed: 0, skipped: "scan_error" };
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[mail] 스캔 완료 (${elapsed}s, ${scanResult.results?.length || 0}종목)`);

  const validResults = (scanResult.results || []).filter((r) => !r.error);
  if (validResults.length === 0) {
    console.log("[mail] 유효 결과 0건 (휴장 가능성), 발송 건너뜀");
    return { sent: 0, failed: 0, skipped: "empty_result" };
  }

  let market = null;
  try {
    const accessToken = await safeApiCall(() => getAccessToken(), 200);
    market = await fetchMarketIndices(accessToken);
  } catch (e) {
    console.warn("[mail] 시장 지수 조회 실패 (무시하고 진행):", e.message || e);
  }

  // KIS hts_avls 단위는 "억원". 500억 미만 (= 500) 컷.
  const MIN_MARKET_CAP_EOK = 500;
  const filtered = validResults.filter((r) => {
    const capEok = r.nightlyExtras?.marketCap || 0;
    return capEok >= MIN_MARKET_CAP_EOK;
  });
  console.log(`[mail] 시총 ${MIN_MARKET_CAP_EOK}억 필터: ${validResults.length} → ${filtered.length}`);

  filtered.sort(
    (a, b) =>
      (b.nightlyExtras?.nightlyTotal || -1) - (a.nightlyExtras?.nightlyTotal || -1)
  );

  const top = filtered.slice(0, 10);
  const dateStr = new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
  const baseUrl = process.env.PUBLIC_URL || "https://ydata.co.kr";

  if (dryRun) {
    const html = await renderEmailHtml("swing-scan", {
      top, market, dateStr, baseUrl,
      unsubscribeUrl: `${baseUrl}/unsubscribe?token=PREVIEW`,
    });
    return { sent: 0, failed: 0, dryRun: true, htmlLength: html.length, top: top.length };
  }

  const transport = getMailer();
  let sent = 0, failed = 0;
  for (const sub of subscribers) {
    try {
      const html = await renderEmailHtml("swing-scan", {
        top, market, dateStr, baseUrl,
        unsubscribeUrl: `${baseUrl}/unsubscribe?token=${encodeURIComponent(sub.unsubscribeToken)}`,
      });
      const unsubAddr = `${baseUrl}/unsubscribe?token=${encodeURIComponent(sub.unsubscribeToken)}`;
      await transport.sendMail({
        from: process.env.MAIL_FROM || `한투 스윙 스캔 <${process.env.SMTP_USER}>`,
        to: sub.email,
        subject: `[스윙 스캔] ${dateStr} · 상위 ${top.length}종목`,
        html,
        headers: {
          "List-Unsubscribe": `<${unsubAddr}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      sent++;
      console.log(`[mail] 발송 OK: ${sub.email}`);
    } catch (e) {
      failed++;
      console.error(`[mail] 발송 실패 (${sub.email}):`, e.message || e);
    }
  }
  console.log(`[mail] 일괄 발송 완료: 성공 ${sent} / 실패 ${failed}`);
  return { sent, failed };
}

app.get("/subscribe", (req, res) => {
  res.render("subscribe", { message: null, error: null });
});

app.post("/subscribe", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.render("subscribe", { error: "이메일 형식이 올바르지 않습니다.", message: null });
  }
  const list = loadSubscribers();
  if (list.find((s) => s.email === email)) {
    return res.render("subscribe", { error: "이미 구독 중인 이메일입니다.", message: null });
  }
  if (list.length >= MAX_SUBSCRIBERS) {
    return res.render("subscribe", {
      error: `구독 정원이 가득 찼습니다 (최대 ${MAX_SUBSCRIBERS}명). 기존 구독자가 취소한 뒤 다시 시도해 주세요.`,
      message: null,
    });
  }
  list.push({
    email,
    subscribedAt: new Date().toISOString(),
    unsubscribeToken: crypto.randomBytes(16).toString("hex"),
  });
  saveSubscribers(list);
  res.render("subscribe", {
    error: null,
    message: `구독 완료: ${email}. 매 평일 22시에 스윙 스캔 결과가 발송됩니다.`,
  });
});

app.get("/unsubscribe", (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(400).send("토큰이 필요합니다.");
  const list = loadSubscribers();
  const idx = list.findIndex((s) => s.unsubscribeToken === token);
  if (idx === -1) {
    return res.send("이미 구독 취소되었거나 잘못된 토큰입니다.");
  }
  const removed = list[idx].email;
  list.splice(idx, 1);
  saveSubscribers(list);
  res.send(`구독 취소 완료: ${removed}`);
});

app.get("/admin/send-mail", async (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).send("forbidden");
  }
  const dryRun = req.query.dryRun === "1";
  const targetEmail = req.query.email || null;
  try {
    const result = await sendSwingScanEmails({ dryRun, targetEmail });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ============================================================
// 관리자 로그인 + 대시보드 (수동 발송 / 구독자 관리)
// ============================================================

const ADMIN_COOKIE = "admin_session";
const ADMIN_COOKIE_MAX_AGE_SEC = 12 * 60 * 60;

// getCookie 는 사이트 게이트 섹션(파일 상단)에 정의됨 — 그대로 재사용

function setAdminCookie(res, value) {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ADMIN_COOKIE_MAX_AGE_SEC}`,
    "Path=/",
  ];
  if (isProd) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAdminCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`
  );
}

function isAdminAuthed(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const got = getCookie(req, ADMIN_COOKIE);
  return !!got && got === expected;
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthed(req)) return res.redirect("/admin/login");
  next();
}

let lastSendStatus = null;
let isSending = false;

function triggerBackgroundSend(opts = {}) {
  if (isSending) {
    return { ok: false, reason: "already_running" };
  }
  isSending = true;
  lastSendStatus = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    target: opts.targetEmail || "전체 구독자",
    dryRun: !!opts.dryRun,
    sent: null,
    failed: null,
    skipped: null,
    error: null,
  };
  setImmediate(() => {
    sendSwingScanEmails(opts)
      .then((result) => {
        lastSendStatus = {
          ...lastSendStatus,
          finishedAt: new Date().toISOString(),
          sent: result.sent || 0,
          failed: result.failed || 0,
          skipped: result.skipped || null,
          dryRun: !!result.dryRun,
        };
      })
      .catch((err) => {
        lastSendStatus = {
          ...lastSendStatus,
          finishedAt: new Date().toISOString(),
          error: err.message || String(err),
        };
      })
      .finally(() => {
        isSending = false;
      });
  });
  return { ok: true };
}

app.get("/admin/login", (req, res) => {
  if (isAdminAuthed(req)) return res.redirect("/admin");
  res.render("admin/login", { error: null });
});

app.post("/admin/login", (req, res) => {
  const password = String(req.body.password || "");
  if (!process.env.ADMIN_TOKEN || password !== process.env.ADMIN_TOKEN) {
    return res.render("admin/login", { error: "비밀번호가 일치하지 않습니다." });
  }
  setAdminCookie(res, password);
  res.redirect("/admin");
});

app.get("/admin/logout", (req, res) => {
  clearAdminCookie(res);
  res.redirect("/admin/login");
});

app.get("/admin", requireAdmin, (req, res) => {
  res.render("admin/dashboard", {
    subscribers: loadSubscribers(),
    maxSubscribers: MAX_SUBSCRIBERS,
    lastSendStatus,
    isSending,
    cronEnabled: process.env.MAIL_CRON_ENABLED === "1",
    flash: req.query.flash || null,
  });
});

app.post("/admin/send", requireAdmin, (req, res) => {
  const targetEmail = String(req.body.targetEmail || "").trim() || null;
  const dryRun = req.body.dryRun === "1";
  const result = triggerBackgroundSend({ targetEmail, dryRun });
  if (!result.ok && result.reason === "already_running") {
    return res.redirect("/admin?flash=already_running");
  }
  res.redirect("/admin?flash=started");
});

app.post("/admin/unsubscribe", requireAdmin, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!email) return res.redirect("/admin?flash=missing_email");
  const list = loadSubscribers();
  const idx = list.findIndex((s) => s.email === email);
  if (idx === -1) return res.redirect("/admin?flash=not_found");
  list.splice(idx, 1);
  saveSubscribers(list);
  res.redirect("/admin?flash=removed");
});

// ============================================================
// 백테스팅 — 스윙 점수 모델 검증 (단일 종목)
// 일봉만 KIS 호출 후 주/월/연봉 합성 → look-ahead 없는 시점별 점수 계산
// flow 점수 제외, 나머지 9요소로 정규화한 0~100 점수 사용
// ============================================================

const BACKTEST_CACHE_DIR = path.join(__dirname, "cache", "backtest");
const BACKTEST_CACHE_TTL_DAYS = 7;
// flow 제외 + trendFollow 추가 → 가중치 합 100 (정규화 곱 1, 코드는 일관성 위해 유지)
const BACKTEST_WEIGHT_DENOM = 100;

function ensureBacktestCacheDir() {
  if (!fs.existsSync(BACKTEST_CACHE_DIR)) {
    fs.mkdirSync(BACKTEST_CACHE_DIR, { recursive: true });
  }
}

function loadBacktestCache(code, monthsBack) {
  try {
    const raw = fs.readFileSync(path.join(BACKTEST_CACHE_DIR, `${code}.json`), "utf-8");
    const data = JSON.parse(raw);
    const ageMs = Date.now() - new Date(data.cachedAt).getTime();
    if (ageMs > BACKTEST_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) return null;
    if ((data.monthsBack || 0) < monthsBack) return null;
    return data.items;
  } catch (_) {
    return null;
  }
}

function saveBacktestCache(code, monthsBack, items) {
  ensureBacktestCacheDir();
  fs.writeFileSync(
    path.join(BACKTEST_CACHE_DIR, `${code}.json`),
    JSON.stringify({ code, monthsBack, items, cachedAt: new Date().toISOString() })
  );
}

// KIS 일봉 페이지네이션 — 약 5개월(100거래일)씩 끊어서 가져와 합치기
async function fetchDailyForBacktest(code, stockMeta, monthsBack) {
  const cached = loadBacktestCache(code, monthsBack);
  if (cached) return cached;

  const accessToken = await getAccessToken();
  const today = new Date();
  const startBoundary = new Date(today);
  startBoundary.setMonth(startBoundary.getMonth() - monthsBack);

  const allItems = [];
  let endCursor = new Date(today);

  while (endCursor > startBoundary) {
    const startCursor = new Date(endCursor);
    startCursor.setDate(startCursor.getDate() - 145); // ≈100 거래일
    const fromDate = formatDate(startCursor < startBoundary ? startBoundary : startCursor);
    const toDate = formatDate(endCursor);

    const raw = await safeApiCall(
      () => getPeriodChart(accessToken, code, "D", fromDate, toDate),
      300
    );
    const data = normalizePeriodData(raw, stockMeta, "DAY");
    for (const item of data.items) {
      if (!allItems.find((x) => x.date === item.date)) allItems.push(item);
    }

    endCursor = new Date(startCursor);
    endCursor.setDate(endCursor.getDate() - 1);
  }

  // 최신 → 과거 순서
  allItems.sort((a, b) => b.date.localeCompare(a.date));
  saveBacktestCache(code, monthsBack, allItems);
  return allItems;
}

// 일봉(과거→최신) → 주봉/월봉/연봉 합성 (모두 최신→과거 순서로 반환)
function aggregateBars(itemsAsc, keyFn) {
  const groups = new Map();
  for (const item of itemsAsc) {
    const k = keyFn(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  const bars = Array.from(groups.values()).map((items) => {
    const lows = items.map((x) => x.lowPrice).filter((v) => v > 0);
    return {
      date: items[items.length - 1].date,
      openPrice: items[0].openPrice,
      highPrice: Math.max(...items.map((x) => x.highPrice)),
      lowPrice: lows.length ? Math.min(...lows) : items[0].closePrice,
      closePrice: items[items.length - 1].closePrice,
      volume: items.reduce((a, b) => a + (b.volume || 0), 0),
      tradeValue: items.reduce((a, b) => a + (b.tradeValue || 0), 0),
    };
  });
  bars.sort((a, b) => b.date.localeCompare(a.date));
  return bars;
}

function synthesizeWeekly(itemsAsc) {
  const bars = [];
  for (let i = 0; i < itemsAsc.length; i += 5) {
    const chunk = itemsAsc.slice(i, i + 5);
    if (chunk.length === 0) continue;
    const lows = chunk.map((x) => x.lowPrice).filter((v) => v > 0);
    bars.push({
      date: chunk[chunk.length - 1].date,
      openPrice: chunk[0].openPrice,
      highPrice: Math.max(...chunk.map((x) => x.highPrice)),
      lowPrice: lows.length ? Math.min(...lows) : chunk[0].closePrice,
      closePrice: chunk[chunk.length - 1].closePrice,
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0),
      tradeValue: chunk.reduce((a, b) => a + (b.tradeValue || 0), 0),
    });
  }
  bars.sort((a, b) => b.date.localeCompare(a.date));
  return bars;
}

const synthesizeMonthly = (itemsAsc) => aggregateBars(itemsAsc, (x) => x.date.slice(0, 6));
const synthesizeYearly  = (itemsAsc) => aggregateBars(itemsAsc, (x) => x.date.slice(0, 4));

// 시점 T 에서 그날까지의 데이터만으로 점수 계산
function computeBacktestScoreAt(allItemsDesc, t, stockMeta) {
  const sliceDesc = allItemsDesc.slice(t); // 최신=t시점
  if (sliceDesc.length < 60) return null;

  const tDay = sliceDesc[0];
  const prevClose = sliceDesc[1] ? sliceDesc[1].closePrice : tDay.closePrice;
  const currentData = {
    currentPrice: tDay.closePrice,
    openPrice: tDay.openPrice,
    highPrice: tDay.highPrice,
    lowPrice: tDay.lowPrice,
    todayVolume: tDay.volume,
    changeRate: prevClose ? ((tDay.closePrice - prevClose) / prevClose) * 100 : 0,
  };

  const sliceAsc = [...sliceDesc].reverse();
  const meta = { stockCode: stockMeta.shortCode, stockName: stockMeta.name, market: stockMeta.market };
  const dailyData   = { period: "DAY",   ...meta, items: sliceDesc };
  const weeklyData  = { period: "WEEK",  ...meta, items: synthesizeWeekly(sliceAsc) };
  const monthlyData = { period: "MONTH", ...meta, items: synthesizeMonthly(sliceAsc) };
  const yearlyData  = { period: "YEAR",  ...meta, items: synthesizeYearly(sliceAsc) };

  const dailySeries   = buildSeries(dailyData,   currentData.currentPrice, 60);
  const weeklySeries  = buildSeries(weeklyData,  currentData.currentPrice, 52);
  const monthlySeries = buildSeries(monthlyData, currentData.currentPrice, 36);
  const yearlySeries  = buildSeries(yearlyData,  currentData.currentPrice, 5);

  // flow=0 으로 두고 buildScoreModel 호출 → flow 기여 0
  const weights = { volume: 18, position: 12, trend: 8, rsi: 5, macd: 5, resistance: 10, volatility: 8, flow: 0 };
  const sm = buildScoreModel(
    currentData, dailyData, weeklyData, monthlyData, yearlyData,
    dailySeries, weeklySeries, monthlySeries, yearlySeries,
    weights, []
  );

  const dryUp = calculateDryUpScore(dailyData);
  const squeeze = calculateSqueezeScore(dailyData, currentData.currentPrice);
  const trendFollow = calculateTrendFollowingScore(dailyData);
  const overheat = calculateOverheatPenalty(dailyData);

  // sm.totalScore 는 buildScoreModel 의 가중치 합 66 기준 (clampScore 로 정수화).
  // dryUp(12) + squeeze(10) + trendFollow(12) 추가 → 합 100 만점.
  const dryContrib = (dryUp.score || 0) * (12 / 100);
  const squeezeContrib = (squeeze.score || 0) * (10 / 100);
  const trendFollowContrib = (trendFollow.score || 0) * (12 / 100);
  const rawTotal = sm.totalScore + dryContrib + squeezeContrib + trendFollowContrib;
  // Phase 3 — 단기 폭등 페널티 차감 (천장 매수 거름)
  const totalScore = Math.max(
    0,
    Math.round((rawTotal / BACKTEST_WEIGHT_DENOM) * 100) - overheat.penalty
  );

  return {
    date: tDay.date,
    closePrice: tDay.closePrice,
    totalScore,
    components: {
      volume: sm.volume.score, position: sm.position.score, trend: sm.trend.score,
      rsi: sm.rsi.score, macd: sm.macd.score, resistance: sm.resistance.score,
      volatility: sm.volatility.score, dryUp: dryUp.score, squeeze: squeeze.score,
      trendFollow: trendFollow.score,
      overheatPenalty: overheat.penalty,
    },
  };
}

// 백테스트 메인
async function runBacktest({ stockMeta, monthsBack, threshold, horizons }) {
  if (!stockMeta || !stockMeta.shortCode) {
    throw new Error("종목 정보가 없습니다.");
  }
  const shortCode = stockMeta.shortCode;

  const allItemsDesc = await fetchDailyForBacktest(shortCode, stockMeta, monthsBack);
  if (!allItemsDesc || allItemsDesc.length < 70) {
    throw new Error(`일봉 데이터 부족 (${allItemsDesc?.length || 0}일). 60일 이상 필요.`);
  }

  // 모든 거래일에 대해 점수 계산 (look-ahead 없는 슬라이스)
  const series = [];
  for (let t = 0; t < allItemsDesc.length - 60; t++) {
    const s = computeBacktestScoreAt(allItemsDesc, t, stockMeta);
    if (s) series.push(s);
  }
  series.sort((a, b) => a.date.localeCompare(b.date));

  const signals = series.filter((s) => s.totalScore >= threshold);

  const dateIdx = new Map(series.map((s, i) => [s.date, i]));
  const horizonResults = horizons.map((h) => {
    const trades = [];
    for (const sig of signals) {
      const idx = dateIdx.get(sig.date);
      if (idx === undefined || idx + h >= series.length) continue;
      const exit = series[idx + h];
      const ret = ((exit.closePrice - sig.closePrice) / sig.closePrice) * 100;
      trades.push({
        entryDate: sig.date,
        entryPrice: sig.closePrice,
        score: sig.totalScore,
        exitDate: exit.date,
        exitPrice: exit.closePrice,
        returnPct: ret,
      });
    }
    const n = trades.length;
    const wins = trades.filter((t) => t.returnPct > 0).length;
    const winRate = n ? (wins / n) * 100 : 0;
    const avgReturn = n ? trades.reduce((a, t) => a + t.returnPct, 0) / n : 0;
    let cumulative = 1;
    for (const t of trades) cumulative *= 1 + t.returnPct / 100;
    const cumulativeReturn = (cumulative - 1) * 100;
    const mdd = trades.length ? Math.min(...trades.map((t) => t.returnPct)) : 0;
    return { horizon: h, n, winRate, avgReturn, cumulativeReturn, mdd, trades };
  });

  return { stockMeta, monthsBack, threshold, series, signals, horizonResults };
}

app.get("/backtest", (req, res) => {
  res.render("backtest", {
    options: {
      query: req.query.query || req.query.code || "",
      monthsBack: Number(req.query.months || 12),
      threshold: Number(req.query.threshold || 70),
      horizons: req.query.horizons ? String(req.query.horizons).split(",").map(Number) : [5, 10, 20],
    },
    result: null,
    error: null,
    candidates: null,
  });
});

app.post("/backtest", async (req, res) => {
  const query = String(req.body.query || "").trim();
  const monthsBack = Math.max(3, Math.min(24, Number(req.body.monthsBack) || 12));
  const threshold = Math.max(0, Math.min(100, Number(req.body.threshold) || 70));
  const horizons = (Array.isArray(req.body.horizons) ? req.body.horizons : [req.body.horizons])
    .filter(Boolean)
    .map((v) => Math.max(1, Math.min(60, Number(v))))
    .filter((v) => Number.isFinite(v));
  const finalHorizons = horizons.length ? Array.from(new Set(horizons)).sort((a, b) => a - b) : [5, 10, 20];

  const options = { query, monthsBack, threshold, horizons: finalHorizons };

  if (!query) {
    return res.render("backtest", {
      options, result: null, candidates: null,
      error: "종목명 또는 종목코드를 입력하세요.",
    });
  }

  const found = getStockInfoByQuery(query);
  if (!found) {
    return res.render("backtest", {
      options, result: null, candidates: null,
      error: `'${query}' 와 일치하는 종목이 없습니다.`,
    });
  }

  let selected;
  let candidates = null;
  if (Array.isArray(found)) {
    // 다중 매치 → 첫 번째 자동 선택, 나머지는 후보로 안내
    selected = found[0];
    candidates = found.slice(0, 10);
  } else {
    selected = found;
  }
  const stockMeta = {
    shortCode: selected.shortCode,
    name: selected.name,
    market: selected.market,
  };

  try {
    const result = await runBacktest({
      stockMeta, monthsBack, threshold, horizons: finalHorizons,
    });
    res.render("backtest", { options, result, error: null, candidates });
  } catch (e) {
    res.render("backtest", { options, result: null, error: e.message || String(e), candidates });
  }
});

if (process.env.MAIL_CRON_ENABLED === "1") {
  cron.schedule("0 22 * * 1-5", async () => {
    console.log("[cron] 평일 22:00 KST — 스윙 스캔 발송 시작");
    try {
      await sendSwingScanEmails();
    } catch (e) {
      console.error("[cron] 발송 중 오류:", e.message || e);
    }
  }, { timezone: "Asia/Seoul" });
  console.log("[cron] 평일 22:00 KST 스윙 스캔 발송 스케줄 등록 완료");
}

loadStocks();

app.listen(PORT, () => {
  console.log(`서버 실행: http://localhost:${PORT}`);
});