// 네이버 모바일 주식 API — KRX 직접 호출이 막혀(LOGOUT) 있어 우회. 한국 fintech 표준 패턴.
//
// Endpoints:
//   - https://m.stock.naver.com/api/stocks/marketValue/{KOSPI|KOSDAQ}?page=N&pageSize=100
//     → 전종목 시총 페이징 리스트 (시총·현재가·거래량 etc)
//   - https://api.stock.naver.com/chart/domestic/item/{code}?periodType=dayCandle&count=N
//     → 일봉 priceInfos: localDate, OHLCV, foreignRetentionRate
//
// ⚠ 거래대금은 chart endpoint 에 없음 → 종가 × 거래량 으로 근사 (오차 작음).

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
const CACHE_DIR = path.join(__dirname, "cache", "stock-charts");
const STOCKS_LIST_PATH = path.join(__dirname, "cache", "naver-stocks-list.json");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────── 종목 마스터 (시총 + 메타) ───────────

async function fetchMarketValuePage(market, page, pageSize = 100) {
  const url = `https://m.stock.naver.com/api/stocks/marketValue/${market}?page=${page}&pageSize=${pageSize}`;
  const r = await axios.get(url, { headers: H, timeout: 15000 });
  return {
    stocks: r.data.stocks || [],
    totalCount: r.data.totalCount || 0,
  };
}

// ETF/ETN 종목 코드 일괄 — 네이버 etf 카테고리 페이징 (pageSize=100 이 안전)
async function fetchEtfCodes({ throttleMs = 300, pageSize = 100, maxPages = 30 } = {}) {
  const codes = new Set();
  let totalCount = null;
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://m.stock.naver.com/api/stocks/etf?page=${page}&pageSize=${pageSize}`;
    let r;
    try {
      r = await axios.get(url, { headers: H, timeout: 15000, validateStatus: () => true });
    } catch (e) {
      console.warn(`[etf] page ${page} 호출 실패: ${e.message}`);
      break;
    }
    if (r.status !== 200) break;
    const stocks = r.data.stocks || [];
    if (!stocks.length) break;
    for (const s of stocks) codes.add(s.itemCode);
    if (totalCount === null) totalCount = r.data.totalCount || 0;
    if (page * pageSize >= totalCount) break;
    await sleep(throttleMs);
  }
  return codes;
}

// 우선주·스팩·ETF·ETN·리츠·신규파생 필터
const ETF_BRAND_PATTERNS = [
  "KODEX", "TIGER", "KOSEF", "ARIRANG", "HANARO", "KBSTAR", "FOCUS",
  "KIWOOM", "PLUS", "RISE", "ACE", "KINDEX", "SOL", "KOACT", "1Q",
  "TIMEFOLIO", "WOORI", "WON", "HK", "VITA", "마이다스", "삼성KODEX",
];
const ETF_BRAND_REGEX = new RegExp(`^(${ETF_BRAND_PATTERNS.join("|")})\\s`, "i");

function isSpecialStock(name, code) {
  if (!name || !code) return true;
  // 종목코드에 영문 포함 → 대부분 ETF/ETN/리츠/유동주식 (정상 종목은 6자리 숫자)
  if (!/^\d{6}$/.test(code)) return true;
  // 우선주: 코드 끝자리 5/7/9/K/L
  if (/[579KL]$/i.test(code)) return true;
  // 종목명 끝자리 우선주 표시
  if (/(우$|우[A-Z]$|2우B?$|3우B?$)/u.test(name)) return true;
  // ETF 브랜드 prefix (KODEX 미국S&P500 등)
  if (ETF_BRAND_REGEX.test(name)) return true;
  // 종목명 키워드
  if (/스팩|기업인수목적|ETF|ETN|리츠|REIT|인버스|레버리지|선물|합성/i.test(name)) return true;
  return false;
}

async function fetchAllStocks({ throttleMs = 300 } = {}) {
  // ETF/ETN 코드 먼저 모음 (정확한 제외용)
  const etfCodes = await fetchEtfCodes({ throttleMs });

  const all = [];
  for (const market of ["KOSPI", "KOSDAQ"]) {
    let page = 1;
    while (true) {
      const { stocks, totalCount } = await fetchMarketValuePage(market, page, 100);
      if (!stocks.length) break;
      for (const s of stocks) {
        const isEtf = etfCodes.has(s.itemCode);
        all.push({
          code: s.itemCode,
          name: s.stockName,
          market,
          closePrice: Number(s.closePriceRaw) || 0,
          marketValue: Number(s.marketValueRaw) || 0, // 원 단위
          tradingVolume: Number(s.accumulatedTradingVolumeRaw) || 0,
          tradingValue: Number(s.accumulatedTradingValueRaw) || 0,
          changeRate: Number(s.fluctuationsRatio) || 0,
          isSpecial: isEtf || isSpecialStock(s.stockName, s.itemCode),
          isEtf,
        });
      }
      if (page * 100 >= totalCount) break;
      page++;
      await sleep(throttleMs);
    }
  }
  return all;
}

// ─────────── 종목별 일봉 ───────────

async function fetchDailyChart(itemCode, count = 130) {
  const url = `https://api.stock.naver.com/chart/domestic/item/${itemCode}?periodType=dayCandle&count=${count}`;
  const r = await axios.get(url, { headers: H, timeout: 15000 });
  const rows = (r.data.priceInfos || []).map((p) => {
    const close = Number(p.closePrice);
    const volume = Number(p.accumulatedTradingVolume);
    return {
      date: String(p.localDate || ""),
      open: Number(p.openPrice) || 0,
      high: Number(p.highPrice) || 0,
      low: Number(p.lowPrice) || 0,
      close: close || 0,
      volume: volume || 0,
      // 거래대금은 chart 에 없어서 (고+저+종)/3 × 거래량 으로 근사
      valueApprox: Math.round(((Number(p.openPrice) + Number(p.highPrice) + Number(p.lowPrice) + close) / 4) * volume),
      foreignRate: Number(p.foreignRetentionRate) || null,
    };
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date)); // 오래된 순
}

// ─────────── 캐시 ───────────

function saveStockChart(code, rows) {
  ensureDir(CACHE_DIR);
  const meta = {
    code,
    fetchedAt: new Date().toISOString(),
    days: rows.length,
    firstDate: rows[0]?.date,
    lastDate: rows[rows.length - 1]?.date,
  };
  fs.writeFileSync(
    path.join(CACHE_DIR, `${code}.json`),
    JSON.stringify({ meta, rows })
  );
}

function loadStockChart(code) {
  try {
    const p = path.join(CACHE_DIR, `${code}.json`);
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {
    return null;
  }
}

function saveStocksList(stocks) {
  ensureDir(path.dirname(STOCKS_LIST_PATH));
  fs.writeFileSync(STOCKS_LIST_PATH, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    count: stocks.length,
    stocks,
  }, null, 0));
}

function loadStocksList() {
  try {
    return JSON.parse(fs.readFileSync(STOCKS_LIST_PATH, "utf-8"));
  } catch (_) {
    return null;
  }
}

// ─────────── 시드 ───────────

async function seedHistorical({
  maxMarketCap = Number(process.env.PATTERN_MAX_MARKETCAP) || 500_000_000_000, // 5,000억 (env 로 조정)
  minMarketCap = Number(process.env.PATTERN_MIN_MARKETCAP) || 5_000_000_000,   // 50억 (잡주 컷)
  lookbackDays = 130,
  throttleMs = 500,
  onProgress = null,
  resume = true, // true: 이미 캐시된 종목 skip (재실행 가능)
} = {}) {
  const t0 = Date.now();
  console.log("[seed] 종목 마스터 fetch …");
  const all = await fetchAllStocks();
  console.log(`[seed] 전체 종목: ${all.length}`);
  saveStocksList(all);

  const targets = all.filter((s) =>
    !s.isSpecial &&
    s.marketValue >= minMarketCap &&
    s.marketValue < maxMarketCap &&
    s.closePrice > 0
  );
  console.log(`[seed] 시총 ${minMarketCap / 1e8}억~${maxMarketCap / 1e8}억 + 잡주 컷 → ${targets.length}종목`);

  let success = 0;
  let fail = 0;
  let skipped = 0;
  for (let i = 0; i < targets.length; i++) {
    const s = targets[i];
    if (resume && loadStockChart(s.code)) {
      skipped++;
      continue;
    }
    try {
      const rows = await fetchDailyChart(s.code, lookbackDays);
      saveStockChart(s.code, rows);
      success++;
      if (onProgress) onProgress({ i, total: targets.length, code: s.code, name: s.name, ok: true });
    } catch (e) {
      fail++;
      if (onProgress) onProgress({ i, total: targets.length, code: s.code, name: s.name, ok: false, error: e.message });
    }
    if (i < targets.length - 1) await sleep(throttleMs);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`[seed] 완료 — 신규 ${success} / 실패 ${fail} / 캐시 적중 ${skipped} (${elapsed}s)`);
  return { success, fail, skipped, elapsed, targetCount: targets.length };
}

module.exports = {
  fetchMarketValuePage,
  fetchEtfCodes,
  fetchAllStocks,
  fetchDailyChart,
  isSpecialStock,
  saveStockChart,
  loadStockChart,
  saveStocksList,
  loadStocksList,
  seedHistorical,
};
