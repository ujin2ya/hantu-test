// 종목 마스터(stocks.json) 로더 — 메모리 인덱스를 한 번 만들고 검색에 재사용.
const fs = require("fs");
const { STOCKS_PATH } = require("../../utils/paths");

let stocksData = null;
let stocksMasterMtime = null;

function loadStocks() {
  const content = fs.readFileSync(STOCKS_PATH, "utf-8");
  stocksData = JSON.parse(content);

  if (!stocksData || !Array.isArray(stocksData.stocks)) {
    throw new Error("stocks.json 형식이 올바르지 않습니다.");
  }

  stocksData.byShortCode = {};
  for (const s of stocksData.stocks) {
    if (s.shortCode) stocksData.byShortCode[s.shortCode] = s;
  }

  try {
    stocksMasterMtime = fs.statSync(STOCKS_PATH).mtime;
  } catch (_) {
    stocksMasterMtime = null;
  }

  return stocksData;
}

// 종목 마스터 신선도 (UI 푸터 "N일 전 갱신" 표시용)
function getStocksMasterAge() {
  if (!stocksMasterMtime) return null;
  const ageDays = Math.floor((Date.now() - stocksMasterMtime.getTime()) / (24 * 60 * 60 * 1000));
  return {
    mtime: stocksMasterMtime.toISOString(),
    ageDays,
    stale: ageDays >= 30,
  };
}

function getStocksData() { return stocksData; }

module.exports = { loadStocks, getStocksMasterAge, getStocksData };
