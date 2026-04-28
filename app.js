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
const { GoogleGenerativeAI } = require("@google/generative-ai");
const {
  getAiAdjustForStock,
  loadDailyCounter: loadAiGroundingDailyCounter,
} = require("./ai-grounding");
const naverFetcher = require("./naver-fetcher");
const patternScreener = require("./pattern-screener");

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
let stocksMasterMtime = null;

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

  try {
    stocksMasterMtime = fs.statSync(stocksJsonPath).mtime;
  } catch (_) {
    stocksMasterMtime = null;
  }
}

// 종목 마스터 (stocks.json) 의 신선도 정보. UI 푸터에 "N일 전 갱신" 표시용.
function getStocksMasterAge() {
  if (!stocksMasterMtime) return null;
  const ageDays = Math.floor((Date.now() - stocksMasterMtime.getTime()) / (24 * 60 * 60 * 1000));
  return {
    mtime: stocksMasterMtime.toISOString(),
    ageDays,
    stale: ageDays >= 30,
  };
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

const DEFAULT_MANUAL_WEIGHTS = Object.freeze({
  volume: 25,
  position: 17,
  trend: 8,
  rsi: 5,
  macd: 5,
  resistance: 15,
  volatility: 10,
  flow: 15,
});

const WEIGHT_PARAM_KEYS = Object.freeze([
  "volumeWeight",
  "positionWeight",
  "trendWeight",
  "rsiWeight",
  "macdWeight",
  "resistanceWeight",
  "volatilityWeight",
  "flowWeight",
]);


function normalizeWeights(rawWeights, defaults = DEFAULT_MANUAL_WEIGHTS) {
  const clean = {};
  let total = 0;

  for (const key of Object.keys(defaults)) {
    const rawValue = Number(rawWeights?.[key]);
    const fallback = Number(defaults[key] || 0);
    const value = Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : fallback;
    clean[key] = value;
    total += value;
  }

  if (total <= 0) return { ...defaults };

  const normalized = {};
  for (const key of Object.keys(clean)) {
    normalized[key] = Math.round((clean[key] / total) * 100);
  }

  const keys = Object.keys(normalized);
  const sum = keys.reduce((acc, key) => acc + normalized[key], 0);
  if (sum !== 100) {
    normalized[keys[0]] += 100 - sum;
  }

  return normalized;
}

function parseWeights(body = {}) {
  const raw = {
    volume: Number(body.volumeWeight ?? DEFAULT_MANUAL_WEIGHTS.volume),
    position: Number(body.positionWeight ?? DEFAULT_MANUAL_WEIGHTS.position),
    trend: Number(body.trendWeight ?? DEFAULT_MANUAL_WEIGHTS.trend),
    rsi: Number(body.rsiWeight ?? DEFAULT_MANUAL_WEIGHTS.rsi),
    macd: Number(body.macdWeight ?? DEFAULT_MANUAL_WEIGHTS.macd),
    resistance: Number(body.resistanceWeight ?? DEFAULT_MANUAL_WEIGHTS.resistance),
    volatility: Number(body.volatilityWeight ?? DEFAULT_MANUAL_WEIGHTS.volatility),
    flow: Number(body.flowWeight ?? DEFAULT_MANUAL_WEIGHTS.flow),
  };

  return normalizeWeights(raw, DEFAULT_MANUAL_WEIGHTS);
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


function calculateMovingAverages(dailyData) {
  const closes = (dailyData?.items || [])
    .map((it) => Number(it.closePrice || 0))
    .filter((p) => p > 0);
  function sma(n) {
    if (closes.length < n) return null;
    return closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
  }
  return { sma5: sma(5), sma10: sma(10), sma20: sma(20), sma60: sma(60), sma120: sma(120) };
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

// 현실적 매수가 — 한국 시장 *오늘~며칠 내 도달 가능*한 자리만 후보화.
// 5일선 / 5일 저점 / 10일선 / 20일선 / 20일 저점 → 현재가에서 가까운 순으로 3 tier 추출.
// "60일 가장 강한 매물대" 는 너무 멀어서 *못 사는* 추천이 되니 단독 추천에선 제외 (AI 검증에서만 참조).
function buildRealisticBuyTiers({ totalScore, currentPrice, dailyData, mas }) {
  const items = (dailyData?.items || []).slice(0, 60);
  if (!items.length || !currentPrice) {
    return { grade: "관망", gradeColor: "bad", tiers: [], conditions: [], reasonDetail: "데이터 부족." };
  }

  const last5lows = items.slice(0, 5).map((x) => Number(x.lowPrice || 0)).filter((v) => v > 0);
  const last20lows = items.slice(0, 20).map((x) => Number(x.lowPrice || 0)).filter((v) => v > 0);
  const low5 = last5lows.length ? Math.min(...last5lows) : null;
  const low20 = last20lows.length ? Math.min(...last20lows) : null;

  // 후보 산출 — 현재가 -10% 이내만 (그 밖은 비현실적이라 제외)
  const minReach = currentPrice * 0.90;
  const raw = [];
  const push = (type, label, price, hint) => {
    if (!price || price <= 0) return;
    if (price >= currentPrice) return;       // 현재가 이상은 매수가 아님
    if (price < minReach) return;            // -10% 밖은 비현실적
    raw.push({ type, label, price: Math.round(price), hint });
  };

  push("5일선", "5일 이동평균선 — 강한 추세 종목의 첫 눌림", mas?.sma5,
    "추세 유효 시 가장 자주 닿는 자리. 도달 빈도 높음.");
  push("5일 저점", "최근 5거래일 저점 — 단기 박스 하단", low5,
    "최근 일주일 안에 형성된 단기 지지. 직접 본 가격이라 신뢰도 높음.");
  push("10일선", "10일 이동평균선 — 두 번째 눌림", mas?.sma10,
    "5일선 깨질 때 다음 지지. 정상적 조정 자리.");
  push("20일선", "20일 이동평균선 — 정상 눌림목 한계선", mas?.sma20,
    "여기까지 내려가면 단기 추세 의심. 매수 후 손절 빠르게.");
  push("20일 저점", "최근 20거래일 저점 — 깊은 조정 라인", low20,
    "20일 박스권 하단. 여기 깨지면 추세 전환 위험.");

  // 가까운 순 정렬 (price 큰 순 = 현재가에 가까움)
  raw.sort((a, b) => b.price - a.price);

  // 중복/근접 제거 — 가격 차이가 0.5% 미만이면 더 의미 있는 type 선택
  const dedup = [];
  for (const c of raw) {
    const near = dedup.find((d) => Math.abs(d.price - c.price) / c.price < 0.005);
    if (!near) dedup.push(c);
  }

  // 추세 / 컨디션 진단
  const aboveSma60 = mas?.sma60 ? currentPrice > mas.sma60 : true;
  const trendUp = (mas?.sma5 && mas?.sma20) ? mas.sma5 > mas.sma20 : null;
  const trendStrong = aboveSma60 && trendUp === true && totalScore >= 65;
  const conditions = [];
  conditions.push(`점수 ${totalScore}`);
  conditions.push(aboveSma60 ? "60일선 위" : "⚠ 60일선 아래 (추세 깨짐)");
  if (trendUp === true) conditions.push("5일선 ≥ 20일선 (단기 추세 유효)");
  else if (trendUp === false) conditions.push("⚠ 5일선 < 20일선 (단기 약세)");

  // 등급
  let grade, gradeColor;
  if (totalScore >= 65 && aboveSma60 && trendUp === true) {
    grade = "매수 가능"; gradeColor = "good";
  } else if (totalScore >= 50 && aboveSma60) {
    grade = "조건부 매수"; gradeColor = "warn";
  } else {
    grade = "관망"; gradeColor = "bad";
  }

  // 후보 없으면 관망
  if (dedup.length === 0) {
    return {
      grade: "관망", gradeColor: "bad", tiers: [],
      conditions,
      reasonDetail: `${conditions.join(" · ")} · 현재가 -10% 안에 매수가 후보 없음. 단기 강세이거나 저항선까지 가까이 닿지 않음 — 약간의 조정 후 재검토 권장.`,
    };
  }

  // 추세 강할수록 *얕은 자리* 우선 (5일선/5일저점), 약할수록 *깊은 자리* (10일선/20일선)
  // dedup 가까운 순 → 그대로 위에서 3개. 단 추세 약한데 5일선만 가까이 있으면 무리한 추격이 될 수 있음.
  // 단순화: 그냥 가까운 순 3개. 사용자가 자기 성향에 맞게 선택.
  const top3 = dedup.slice(0, 3);

  // 3 tier 부여 — 가까움 / 중간 / 깊음
  const labels = ["1차 (가까움)", "2차", "3차 (깊음)"];
  const tiers = top3.map((c, i) => {
    const gap = ((currentPrice - c.price) / currentPrice) * 100;
    const stopPct = trendStrong ? 2.5 : (i === 0 ? 2 : i === 1 ? 2.5 : 3);
    const stopLoss = Math.round(c.price * (1 - stopPct / 100));
    return {
      tierLabel: labels[i],
      type: c.type,
      label: c.label,
      hint: c.hint,
      price: c.price,
      gapPct: gap.toFixed(2),
      stopLoss,
      maxLossPct: stopPct.toFixed(1),
    };
  });

  // 추천 tier — 추세 강하면 1차 (얕은 자리), 중립이면 2차, 약하면 3차 또는 관망
  let recommendedIdx;
  if (grade === "매수 가능") recommendedIdx = 0;
  else if (grade === "조건부 매수") recommendedIdx = Math.min(1, tiers.length - 1);
  else recommendedIdx = -1; // 관망 — 강조 표시 안 함

  const reasonDetail = `${conditions.join(" · ")} · ${tiers.length}개 매수가 후보 (-${(((currentPrice - tiers[tiers.length - 1].price) / currentPrice) * 100).toFixed(1)}% 까지)`;

  return {
    grade, gradeColor,
    tiers,
    recommendedIdx,
    conditions,
    reasonDetail,
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
  const mas = calculateMovingAverages(dailyData);

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

  // 현실적 매수가 후보 3개 — 5일선/5일저점/10일선/20일선 등 가까운 자리 위주 (오늘~며칠 내 도달 가능).
  const buyRecommendation = buildRealisticBuyTiers({
    totalScore,
    currentPrice: currentData.currentPrice,
    dailyData,
    mas,
  });

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
    movingAverages: {
      sma5: mas.sma5 ? Math.round(mas.sma5) : null,
      sma20: mas.sma20 ? Math.round(mas.sma20) : null,
      sma60: mas.sma60 ? Math.round(mas.sma60) : null,
    },
    buyRecommendation,
  };
}

// 60일 약세/박스권 판정용 임계값. 원래 normalizeRankRows 옆에 있던 상수인데
// 스캔 코드 제거하면서 isWeakTrendStock 만 단독으로 살아남음.
const WEAK_TREND_RETURN_PCT = 10;
const WEAK_TREND_HIGH_RATIO = 0.95;

function isWeakTrendStock(dailyData) {
  const items = dailyData?.items?.slice(0, 60) || [];
  if (items.length < 60) return false; // 데이터 부족하면 판정 안 함
  const today = Number(items[0].closePrice || 0);
  const sixtyAgo = Number(items[59].closePrice || 0);
  if (!today || !sixtyAgo) return false;

  // 조건 1: 60일 수익률
  const returnPct = ((today - sixtyAgo) / sixtyAgo) * 100;
  if (returnPct < WEAK_TREND_RETURN_PCT) return true;

  // 조건 2: 60일 최고가 대비 위치
  const highs = items.map((x) => Number(x.highPrice || 0)).filter((v) => v > 0);
  if (highs.length === 0) return false;
  const high60 = Math.max(...highs);
  if (high60 <= 0) return false;
  if (today < high60 * WEAK_TREND_HIGH_RATIO) return true;

  return false;
}

// 시장 시간대 컨텍스트 — 자동 추천이 phase 별로 다른 설정을 쓰도록 한다.
// phase: intraday(장중) / pre_open(장 시작 전) / post_close(장마감 후) / weekend(주말·휴장)
// horizon: short(단타) / swing(스윙)
// breakoutMargin: 돌파 vs 눌림목 박빙 임계 — 장중은 작게, 그 외는 크게(보수)
function getMarketContext(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const totalMin = hour * 60 + minute;
  const openMin = 9 * 60;
  const closeMin = 15 * 60 + 30;
  const isWeekday = day >= 1 && day <= 5;

  if (!isWeekday) {
    return {
      phase: "weekend",
      horizon: "swing",
      label: "주말 / 휴장",
      breakoutMargin: 8,
      description: "다음 거래일을 위한 스윙 자리 점검 모드. 단타·돌파 추격은 자제하고 매물대 지지·이평선 위치를 우선 본다.",
    };
  }
  if (totalMin < openMin) {
    return {
      phase: "pre_open",
      horizon: "swing",
      label: "장 시작 전 (당일)",
      breakoutMargin: 8,
      description: "갭 가능성과 전일 미국장 영향. 시가 직후 변동이 크니 9:30 이후 추적이 안전. 돌파 신호는 장중 재확인 권장.",
    };
  }
  if (totalMin < closeMin) {
    return {
      phase: "intraday",
      horizon: "short",
      label: "장중",
      breakoutMargin: 3,
      description: "분봉 모멘텀 활용 가능. 빠른 진입/이탈로 단타 친화적 — 돌파 신호는 즉시 행동 가능.",
    };
  }
  return {
    phase: "post_close",
    horizon: "swing",
    label: "장마감 후 (당일)",
    breakoutMargin: 8,
    description: "오늘 종가 + 전체 흐름 본 뒤 내일 자리 준비. 명확한 돌파가 아니면 눌림목 우선 — 다음날 갭 변동 감안.",
  };
}

function pickAutoMode(now = new Date()) {
  return getMarketContext(now).horizon;
}

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

// ─── 패턴 상세 페이지 AI 관찰 포인트 (Gemini) ───
const AI_COMMENTS_DIR = path.join(__dirname, "cache", "ai-comments");
const PATTERN_AI_PROMPT_VERSION = "v2";  // prompt 변경 시 bump → 모든 캐시 자동 무효화

function ensureAiCommentsDir() {
  if (!fs.existsSync(AI_COMMENTS_DIR)) fs.mkdirSync(AI_COMMENTS_DIR, { recursive: true });
}

function computePatternAiHash(detail) {
  const crypto = require("crypto");
  const payload = {
    promptVersion: PATTERN_AI_PROMPT_VERSION,
    code: detail.code,
    updatedAt: detail.updatedAt,
    category: detail.category,
    scores: detail.scores,
    returns: detail.returns,
    flow: detail.flow,
    risk: detail.risk,
    warnings: detail.warnings,
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

function loadPatternAiCache(code, dataHash) {
  try {
    const p = path.join(AI_COMMENTS_DIR, `${code}.json`);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data.dataHash === dataHash) return data;
  } catch (_) { /* skip */ }
  return null;
}

function savePatternAiCache(code, dataHash, payload) {
  try {
    ensureAiCommentsDir();
    const p = path.join(AI_COMMENTS_DIR, `${code}.json`);
    fs.writeFileSync(p, JSON.stringify({ dataHash, ...payload }));
  } catch (e) {
    console.error("[AI Pattern] cache save failed:", e.message);
  }
}

function buildPatternAiPrompt(detail) {
  const tagLabel = (t) => ({
    FLOW_LEAD: "자금 선행", REBOUND: "과매도 반등", BULL_TREND_WATCH: "강세장 추세",
    OVERHEAT_WARNING: "과열 주의", HIGH_VOLATILITY: "고변동성",
    STRUCTURE_BROKEN: "구조 붕괴", NO_SIGNAL: "신호 없음",
  })[t] || t;
  return [
    "당신은 신중한 한국 주식 분석가입니다. 아래 JSON 데이터만 근거로 종목 \"" + detail.name + "\" (" + detail.code + ") 의 \"AI 관찰 포인트\"를 한국어로 작성하세요.",
    "",
    "[행동 권유 금지 — 사용자에게 행동을 권하지 말 것]",
    "1. 매수하세요 / 매도하세요 / 진입하세요 / 추천합니다 / 강력 추천 같은 권유 표현을 절대 쓰지 않는다.",
    "2. 목표가 X원 / 상승 확률 X% / 수익 가능성 / 확실 / 안전 / 무조건 / 바닥 / 저점매수 같은 단정 표현을 쓰지 않는다.",
    "3. 데이터에 없는 재료, 뉴스, 이벤트, 기업가치 평가를 추측하지 않는다.",
    "",
    "[허용 — 시장 데이터 표준 용어]",
    "\"외국인 순매수\", \"기관 순매도\", \"순매수대금\", \"매수세\", \"매도세\" 같은 시장 데이터 용어는 자연스러운 한국 주식 시장 표현이므로 그대로 사용해도 좋다. 단, 이는 어디까지나 데이터 묘사이며 사용자에게 \"매수하세요\" 같은 권유로 해석되지 않게 신중히 표현한다.",
    "",
    "[권장 표현]",
    "관찰, 후보, 상태, 신호, 확인 필요, 리스크, 약화될 수 있음, 강화될 수 있음, 둔화, 둔화 신호, 회복.",
    "",
    "[작성 구조 — 3개 섹션, 각 2~4문장 정도, 데이터 인용]",
    "1. 분류 사유: 이 종목이 왜 \"" + tagLabel(detail.category) + "\" 카테고리로 분류됐는지. 점수·수급·수익률·이격 등 데이터를 근거로.",
    "2. 관찰 포인트: 앞으로 무엇을 확인하면 신호가 강화/약화되는지. 구체적 지표.",
    "3. 리스크: 신호가 약해지거나 무효화될 수 있는 조건. 변동성·구조 등.",
    "",
    "[출력 형식]",
    "각 섹션 제목 (분류 사유 / 관찰 포인트 / 리스크) 을 \"■\" 로 표시하고 줄바꿈. 너무 짧지 말고 데이터를 충분히 인용. 단, 같은 내용 반복 금지.",
    "",
    "[데이터]",
    JSON.stringify(detail, null, 2),
  ].join("\n");
}

async function getPatternAiComment(detail) {
  const dataHash = computePatternAiHash(detail);
  const cached = loadPatternAiCache(detail.code, dataHash);
  if (cached?.text) return { text: cached.text, model: cached.model, generatedAt: cached.generatedAt, cached: true };
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const client = getGemini();
    const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const model = client.getGenerativeModel({ model: modelName });
    const prompt = buildPatternAiPrompt(detail);
    const result = await model.generateContent(prompt);
    const text = (result.response.text() || "").trim();
    const payload = { text, model: modelName, generatedAt: new Date().toISOString() };
    savePatternAiCache(detail.code, dataHash, payload);
    return { ...payload, cached: false };
  } catch (e) {
    console.error("[AI Pattern] error:", e.message);
    return { error: e.message };
  }
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

function renderIndex(res, overrides = {}) {
  return res.render("index", {
    query: "",
    error: null,
    candidates: [],
    stockMeta: null,
    chartRows: null,
    patternData: null,
    csbDetail: null,
    flowSummary: null,
    flowRecent: null,
    aiComment: null,
    high60: null,
    low60: null,
    lastDate: null,
    cacheStale: null,
    ...overrides,
  });
}

app.get("/", (req, res) => {
  const incomingQuery = String(req.query.query || "").trim();
  if (incomingQuery) {
    req.body = { ...req.query, stockQuery: incomingQuery };
    return handleSearch(req, res);
  }
  // 첫 화면을 패턴 대시보드로 — 검색 쿼리 없을 때 /pattern 으로 이동
  return res.redirect("/pattern");
});

function buildScanReturnUrl(body) {
  if (body?.from !== "scan") return null;
  const mode = String(body.scanMode || "").replace(/[^a-z]/gi, "");
  const limit = Number(body.scanLimit) || 0;
  const includeMinute = body.scanIncludeMinute === "1" ? "on" : "off";
  if (!mode || !limit) return "/scan";
  return `/scan?mode=${encodeURIComponent(mode)}&candidateLimit=${limit}&includeMinute=${includeMinute}`;
}

// 단순화된 상세 분석 — Naver 캐시만 사용 (KIS 호출 제거).
// 종목 정보 + 130일 일봉/거래량 + 14개 패턴 features 만 표시.
const handleSearch = async (req, res) => {
  try {
    const query = String(req.body.stockQuery || "").trim();
    if (!query) {
      return renderIndex(res, { query, error: "종목명 또는 종목코드를 입력하세요." });
    }

    const stockInfo = getStockInfoByQuery(query);
    if (!stockInfo) {
      return renderIndex(res, { query, error: "일치하는 종목이 없습니다." });
    }
    const candidates = Array.isArray(stockInfo) ? stockInfo : [stockInfo];
    const selected = candidates[0];
    const code = selected.shortCode || selected.standardCode || "";

    // 1) 캐시 우선, 없으면 라이브 fetch
    let cache = naverFetcher.loadStockChart(code);
    let rows = cache?.rows || [];
    let cacheFetchedAt = cache?.meta?.fetchedAt || null;

    if (!rows.length) {
      try {
        rows = await naverFetcher.fetchDailyChart(code, 130);
        if (rows.length) {
          naverFetcher.saveStockChart(code, rows);
          cacheFetchedAt = new Date().toISOString();
        }
      } catch (e) {
        return renderIndex(res, { query, error: `차트 조회 실패: ${e.message}` });
      }
    }

    if (!rows.length) {
      return renderIndex(res, { query, error: "차트 데이터가 없습니다." });
    }

    // 캐시 stale 일수
    let cacheStale = null;
    if (cacheFetchedAt) {
      const ageDays = Math.floor((Date.now() - new Date(cacheFetchedAt).getTime()) / (24 * 60 * 60 * 1000));
      if (ageDays >= 2) cacheStale = ageDays;
    }

    // 2) Naver master 메타 (시총·종가·등락)
    const naverList = naverFetcher.loadStocksList();
    const naverMeta = naverList?.stocks?.find((s) => s.code === code);
    const lastRow = rows[rows.length - 1];
    const stockMeta = {
      name: selected.name || naverMeta?.name || "-",
      code,
      market: naverMeta?.market || selected.market || null,
      marketCap: naverMeta?.marketValue || 0,
      closePrice: naverMeta?.closePrice || lastRow.close,
      changeRate: naverMeta?.changeRate != null ? naverMeta.changeRate : 0,
    };

    // 3) 새 모델 진단 lookup — pattern-result.json 의 taggedAll
    let patternData = null;
    try {
      const patternPath = path.join(__dirname, "cache", "pattern-result.json");
      if (fs.existsSync(patternPath)) {
        const pr = JSON.parse(fs.readFileSync(patternPath, "utf-8"));
        patternData = (pr.taggedAll || []).find((t) => t.code === code) || null;
      }
    } catch (_) {}

    // 3b) CSB 재계산 — patternData 의 csb 필드는 cache 의 분석 시점 기준이라 옛 분석이면 누락됨.
    //     상세 페이지는 항상 최신 chart 기준으로 재계산해서 전달.
    let csbDetail = null;
    try {
      let flowRowsArr = [];
      const flowPath = path.join(__dirname, "cache", "flow-history", `${code}.json`);
      if (fs.existsSync(flowPath)) {
        flowRowsArr = JSON.parse(fs.readFileSync(flowPath, "utf-8")).rows || [];
      }
      const csbMeta = { ...stockMeta, marketValue: stockMeta?.marketValue || 0 };
      const csbRes = patternScreener.calculateCompressionSupportBreakoutScore(rows, flowRowsArr, csbMeta, rows.length - 1);
      if (csbRes?.passed) {
        const stages = csbRes.stages || {};
        const stageCount = Object.values(stages).filter(Boolean).length;
        const allFour = stages.compressionFormed && stages.supportConfirmed && stages.breakoutReady && stages.volumeReturning;
        const three = !allFour && stages.supportConfirmed && stages.volumeReturning
          && (stages.compressionFormed || stages.breakoutReady);
        let category = 'NONE';
        let categoryLabel = '해당 없음';
        if (allFour) { category = 'CSB_BREAKOUT'; categoryLabel = '상승 전 압축 후보'; }
        else if (three) { category = 'CSB_COMPRESSION'; categoryLabel = '예비 압축 후보'; }

        let stopGuide = null;
        const lastClose = lastRow.close;
        if (csbRes.metrics?.atrPct && lastClose > 0) {
          const stopPctFinal = Math.max(0.08, Math.min(0.12, csbRes.metrics.atrPct * 2.5));
          stopGuide = {
            method: 'relaxed-close',
            stopPct: +(stopPctFinal * 100).toFixed(1),
            stopPrice: Math.round(lastClose * (1 - stopPctFinal)),
            atrMultiplier: 2.5,
            formula: 'clamp(ATR%×2.5, 8%, 12%) — 종가 기준',
          };
        }
        const tradePlan = patternScreener.buildCsbTradePlan(csbRes.metrics, lastClose);

        csbDetail = {
          passed: true, category, categoryLabel,
          score: csbRes.score, bucket: csbRes.bucket, displayGrade: csbRes.displayGrade,
          stages, stageCount, tags: csbRes.tags, warnings: csbRes.warnings,
          metrics: csbRes.metrics, breakdown: csbRes.breakdown, stopGuide, tradePlan,
        };
      } else if (csbRes) {
        csbDetail = { passed: false, rejectReason: csbRes.rejectReason };
      }
    } catch (e) { csbDetail = { passed: false, rejectReason: e.message }; }

    // 4) flow-history (외국인/기관 일별 순매수) 로드 + 1d/5d/20d 합계
    let flowSummary = null;
    let flowRecent = null;
    let flowByDate = null;   // chartRows merge 용
    try {
      const flowPath = path.join(__dirname, "cache", "flow-history", `${code}.json`);
      if (fs.existsSync(flowPath)) {
        const flowRows = JSON.parse(fs.readFileSync(flowPath, "utf-8")).rows || [];
        if (flowRows.length >= 1) {
          const sumKey = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
          const last1 = flowRows.slice(-1);
          const last5 = flowRows.slice(-5);
          const last20 = flowRows.slice(-20);
          flowSummary = {
            f1: sumKey(last1, "foreignNetValue"),
            i1: sumKey(last1, "instNetValue"),
            f5: sumKey(last5, "foreignNetValue"),
            i5: sumKey(last5, "instNetValue"),
            f20: sumKey(last20, "foreignNetValue"),
            i20: sumKey(last20, "instNetValue"),
            lastDate: flowRows[flowRows.length - 1].date,
            days: flowRows.length,
          };
          flowRecent = flowRows.slice(-10);
          flowByDate = new Map(flowRows.map((r) => [r.date, r]));
        }
      }
    } catch (_) {}

    // 5) 60일 고/저
    const last60 = rows.slice(-60);
    const high60 = Math.max(...last60.map((r) => r.high || 0)) || null;
    const lows60 = last60.map((r) => r.low).filter((v) => v > 0);
    const low60 = lows60.length ? Math.min(...lows60) : null;

    // 6) 차트 — 마지막 250일 (1Y) + MA5/20/60/120 + flow merge
    function smaSeries(arr, period, key) {
      const out = new Array(arr.length).fill(null);
      let sum = 0;
      for (let i = 0; i < arr.length; i++) {
        sum += arr[i][key] || 0;
        if (i >= period) sum -= arr[i - period][key] || 0;
        if (i >= period - 1) out[i] = sum / period;
      }
      return out;
    }
    const ma5All = smaSeries(rows, 5, "close");
    const ma20All = smaSeries(rows, 20, "close");
    const ma60All = smaSeries(rows, 60, "close");
    const ma120All = smaSeries(rows, 120, "close");
    const startIdx = Math.max(0, rows.length - 250);
    const chartRows = rows.slice(startIdx).map((r, i) => {
      const absIdx = startIdx + i;
      const f = flowByDate?.get(r.date) || null;
      const foreignValue = f?.foreignNetValue ?? null;
      const instValue = f?.instNetValue ?? null;
      const totalFlowValue = (foreignValue != null || instValue != null)
        ? (foreignValue || 0) + (instValue || 0) : null;
      return {
        date: r.date,
        open: r.open, high: r.high, low: r.low, close: r.close,
        volume: r.volume,
        valueApprox: r.valueApprox || null,
        ma5: ma5All[absIdx], ma20: ma20All[absIdx], ma60: ma60All[absIdx], ma120: ma120All[absIdx],
        foreignValue, instValue, totalFlowValue,
      };
    });

    // 7) AI 관찰 포인트 (Gemini) — pattern 데이터 있을 때만, dataHash 기반 캐시
    let aiComment = null;
    if (patternData) {
      const detail = {
        name: stockMeta.name,
        code: stockMeta.code,
        market: stockMeta.market,
        updatedAt: lastRow.date,
        category: patternData.primaryTag,
        scores: {
          flowLead: patternData.flowLead?.score ?? null,
          rebound: patternData.rebound?.score ?? null,
          bullTrend: patternData.setupScore ?? null,
        },
        returns: {
          d5: patternData.ret5d, d10: patternData.rebound?.signals?.ret10d != null ? +(patternData.rebound.signals.ret10d * 100).toFixed(2) : null,
          d20: patternData.ret20d, d60: patternData.ret60d,
        },
        flow: flowSummary ? {
          total1d: flowSummary.f1 + flowSummary.i1,
          total5d: flowSummary.f5 + flowSummary.i5,
          total20d: flowSummary.f20 + flowSummary.i20,
          foreign5d: flowSummary.f5,
          inst5d: flowSummary.i5,
          flowRatio5d: patternData.flowLead?.signals?.flowRatio5d ?? null,
        } : null,
        risk: {
          atrPct: patternData.atrPct,
          dist20pct: patternData.dist20pct,
        },
        regime: patternData.regime,
        warnings: (patternData.tags || []).filter((t) => ["OVERHEAT_WARNING", "HIGH_VOLATILITY", "STRUCTURE_BROKEN"].includes(t)),
        tags: patternData.tags || [],
      };
      try { aiComment = await getPatternAiComment(detail); } catch (_) { aiComment = null; }
    }

    return renderIndex(res, {
      query,
      candidates: candidates.length > 1 ? candidates : [],
      stockMeta,
      chartRows,
      patternData,
      csbDetail,
      flowSummary,
      flowRecent,
      aiComment,
      high60,
      low60,
      lastDate: lastRow.date,
      cacheStale,
    });
  } catch (err) {
    return renderIndex(res, {
      query: req.body.stockQuery || "",
      error: err.message || "알 수 없는 오류",
    });
  }
};

app.post("/search", handleSearch);

// AI 그라운딩 보정 단건 호출 — index 상세 페이지의 "AI 보정 받기" 버튼이 fetch 로 사용.
// 캐시 적중 시 즉시 반환, 아니면 Gemini Google 검색 그라운딩 1회 호출 (~3~10초).
app.post("/ai/adjust", express.json(), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: "GEMINI_API_KEY가 서버에 설정되지 않았습니다." });
    }
    const shortCode = String(req.body.shortCode || "").trim();
    const name = String(req.body.name || "").trim();
    const currentPrice = Number(req.body.currentPrice) || 0;
    const changeRate = Number(req.body.changeRate) || 0;
    const baselineScore = Number(req.body.baselineScore) || 0;
    const market = String(req.body.market || "").trim();
    // 기술적 추천 매수가/손절선 — AI 가 ±10% 안에서 조정하도록 anchor 로 전달
    const technicalBuyPrice = Number(req.body.technicalBuyPrice) || null;
    const technicalStopLoss = Number(req.body.technicalStopLoss) || null;
    if (!shortCode || !name) {
      return res.status(400).json({ error: "shortCode 및 name 필수" });
    }
    const adj = await getAiAdjustForStock({
      shortCode, name, currentPrice, changeRate, baselineScore, market,
      technicalBuyPrice, technicalStopLoss,
    });
    res.json({ ok: true, aiAdjust: adj, daily: loadAiGroundingDailyCounter() });
  } catch (err) {
    console.error("[/ai/adjust] error:", err.message || err);
    res.status(500).json({ error: err.message || "AI 보정 실패" });
  }
});

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
    message: `구독 완료: ${email}. 메일 발송 기능은 현재 개발중입니다.`,
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
    flash: req.query.flash || null,
    stocksMaster: getStocksMasterAge(),
    patternState,
    seededCount: patternScreener.listSeededStocks().length,
  });
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



// 스윙/단타 스캔과 백테스트는 점수 모델 재설계 중 — 화면만 stub 으로 유지.
app.get("/scan", (req, res) => res.render("scan", {}));
app.post("/scan", (req, res) => res.render("scan", {}));
app.get("/backtest", (req, res) => res.render("backtest", {}));
app.post("/backtest", (req, res) => res.render("backtest", {}));

// ─────────── 패턴 스크리너 ───────────
const patternState = {
  seeding: false, seedStartedAt: null, seedFinishedAt: null, seedProgress: null, seedError: null,
  analyzing: false, analyzeStartedAt: null, analyzeFinishedAt: null, analyzeError: null,
};

app.get("/pattern", (req, res) => {
  let result = null;
  try {
    const fs = require("fs");
    const p = path.join(__dirname, "cache", "pattern-result.json");
    if (fs.existsSync(p)) result = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {}
  const seededCount = patternScreener.listSeededStocks().length;

  const cQuery = String(req.query.cq || "").trim();
  const matchSearch = (item) => !cQuery || (item.name || "").toLowerCase().includes(cQuery.toLowerCase()) || (item.code || "").toLowerCase().includes(cQuery.toLowerCase());

  // ─── Phase 8 새 카테고리 ───
  const flowLeadCandidates = (result?.flowLeadCandidates || []).filter(matchSearch);
  const reboundCandidates = (result?.reboundCandidates || []).filter(matchSearch);
  const bullTrendWatch = (result?.bullTrendWatch || []).filter(matchSearch);
  const overheatWarnings = (result?.overheatWarnings || []).filter(matchSearch);
  const taggedAll = (result?.taggedAll || []).filter(matchSearch);

  // ─── CSB-Lite 중소형 분류 (500억~3000억) ───
  const smallCsbReadyCandidates = (result?.smallCsbReady || []).filter(matchSearch);
  const smallCsbWatchCandidates = (result?.smallCsbWatch || []).filter(matchSearch);

  // ─── 보유/관심종목 점검 — 사용자 입력 코드 → 통합 카드 ───
  const holdingsRaw = String(req.query.holdings || "").trim();
  const holdingsCodes = holdingsRaw.split(/[\s,]+/).filter(Boolean);
  const holdingsCards = holdingsCodes.length
    ? holdingsCodes.map((q) => {
        // 코드 또는 이름 매칭
        const lower = q.toLowerCase();
        const found = (result?.taggedAll || []).find((t) => t.code === q || (t.name || "").toLowerCase() === lower || (t.name || "").toLowerCase().includes(lower));
        return found ? { query: q, found: true, ...found } : { query: q, found: false };
      })
    : [];

  // ─── 기존 (역호환 — 모델 검증 페이지에서 사용) ───
  const buyCandidates = (result?.buyCandidates || []).filter(matchSearch);
  const watchlist = (result?.watchlist || []).filter(matchSearch);
  const observationList = (result?.observationList || []).filter(matchSearch);
  const stage1to2Transitions = (result?.stage1to2Transitions || []).filter(matchSearch);
  const todaysBreakouts = (result?.todaysBreakouts || []).filter(matchSearch);
  const vcpForming = (result?.vcpForming || []).filter(matchSearch);
  const stage2Pool = (result?.stage2Pool || []).filter(matchSearch);

  res.render("pattern", {
    result, seededCount, patternState,
    cQuery, holdingsRaw,
    // 새 카테고리
    flowLeadCandidates, reboundCandidates, bullTrendWatch, overheatWarnings, taggedAll, holdingsCards,
    // CSB-Lite 중소형 분류
    smallCsbReadyCandidates, smallCsbWatchCandidates,
    // 기존 — 모델 검증 / 역호환
    buyCandidates, watchlist, observationList,
    stage1to2Transitions, todaysBreakouts, vcpForming, stage2Pool,
  });
});

app.post("/admin/pattern/seed", requireAdmin, (req, res) => {
  if (patternState.seeding) return res.redirect("/admin?flash=pattern_seeding");
  patternState.seeding = true;
  patternState.seedStartedAt = new Date().toISOString();
  patternState.seedFinishedAt = null;
  patternState.seedProgress = { i: 0, total: 0, code: "", name: "" };
  patternState.seedError = null;
  res.redirect("/admin?flash=pattern_seed_started");
  // Minervini Stage 2 분석 위해 250일 lookback (200일 SMA 계산용)
  naverFetcher.seedHistorical({
    lookbackDays: 250,
    onProgress: (p) => { patternState.seedProgress = p; },
  })
    .catch((e) => { patternState.seedError = e.message; })
    .finally(() => {
      patternState.seeding = false;
      patternState.seedFinishedAt = new Date().toISOString();
    });
});

app.post("/admin/pattern/analyze", requireAdmin, (req, res) => {
  if (patternState.analyzing) return res.redirect("/admin?flash=pattern_analyzing");
  patternState.analyzing = true;
  patternState.analyzeStartedAt = new Date().toISOString();
  patternState.analyzeFinishedAt = null;
  patternState.analyzeError = null;
  res.redirect("/admin?flash=pattern_analyze_started");
  patternScreener.analyzeAll({ logProgress: true })
    .catch((e) => { patternState.analyzeError = e.message; })
    .finally(() => {
      patternState.analyzing = false;
      patternState.analyzeFinishedAt = new Date().toISOString();
    });
});

loadStocks();

app.listen(PORT, () => {
  console.log(`서버 실행: http://localhost:${PORT}`);
});
