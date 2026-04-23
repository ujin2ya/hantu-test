require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const stocksJsonPath = path.join(__dirname, "stocks.json");
let stocksData = null;

function loadStocks() {
  const content = fs.readFileSync(stocksJsonPath, "utf-8");
  stocksData = JSON.parse(content);

  if (!stocksData || !Array.isArray(stocksData.stocks)) {
    throw new Error("stocks.json 형식이 올바르지 않습니다. stocks 배열이 필요합니다.");
  }
}

function findStockByName(name) {
  if (!stocksData) {
    throw new Error("stocks.json not loaded");
  }

  const keyword = name.trim();

  const exactMatches = stocksData.stocks.filter(
    (stock) => stock.name === keyword
  );

  if (exactMatches.length > 0) {
    return exactMatches;
  }

  return stocksData.stocks.filter((stock) =>
    stock.name.includes(keyword)
  );
}

function getStockCodeByName(name) {
  const matches = findStockByName(name);

  if (matches.length === 0) {
    return null;
  }

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

function promptQuestion(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptForStockName() {
  return promptQuestion("종목명을 입력하세요: ");
}

async function promptForSelection(max) {
  const answer = await promptQuestion(`번호를 선택하세요 (1-${max}): `);
  const num = Number(answer);

  if (!Number.isInteger(num) || num < 1 || num > max) {
    throw new Error("잘못된 번호를 입력했습니다.");
  }

  return num - 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeApiCall(fn, label, delayMs = 700) {
  await sleep(delayMs);
  console.log(`\n[호출] ${label}`);
  return await fn();
}

async function getAccessToken() {
  const url = `${process.env.KIS_BASE_URL}/oauth2/tokenP`;

  const body = {
    grant_type: "client_credentials",
    appkey: process.env.KIS_APP_KEY,
    appsecret: process.env.KIS_APP_SECRET,
  };

  const res = await axios.post(url, body, {
    headers: {
      "content-type": "application/json; charset=UTF-8",
    },
    timeout: 10000,
  });

  if (!res.data.access_token) {
    throw new Error("토큰 발급 실패: access_token 이 없습니다.");
  }

  return res.data.access_token;
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
    collectedAt: new Date().toISOString(),
  };
}

function normalizePeriodVolume(apiData, stockMeta, periodLabel) {
  const rows = Array.isArray(apiData.output2) ? apiData.output2 : [];

  return {
    stockCode: stockMeta.shortCode,
    stockName: stockMeta.name,
    market: stockMeta.market,
    period: periodLabel,
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

function getDateRange(yearsBack = 5) {
  const end = new Date();
  const start = new Date();
  start.setFullYear(end.getFullYear() - yearsBack);

  return {
    startDate: formatDate(start),
    endDate: formatDate(end),
  };
}

function printSummary(currentData) {
  console.log("\n================ 현재 정보 ================");
  console.log(`종목명        : ${currentData.stockName}`);
  console.log(`종목코드      : ${currentData.stockCode}`);
  console.log(`시장          : ${currentData.market}`);
  console.log(`현재가        : ${currentData.currentPrice.toLocaleString()}`);
  console.log(`전일대비      : ${currentData.prevDiff.toLocaleString()}`);
  console.log(`등락률        : ${currentData.changeRate}%`);
  console.log(`시가          : ${currentData.openPrice.toLocaleString()}`);
  console.log(`고가          : ${currentData.highPrice.toLocaleString()}`);
  console.log(`저가          : ${currentData.lowPrice.toLocaleString()}`);
  console.log(`전일종가      : ${currentData.prevClose.toLocaleString()}`);
  console.log(`오늘 거래량   : ${currentData.todayVolume.toLocaleString()}`);
  console.log(`오늘 거래대금 : ${currentData.todayTradeValue.toLocaleString()}`);
}

function printPeriodVolumes(title, data, limit = 10) {
  console.log(`\n================ ${title} ================`);

  if (!data.items.length) {
    console.log("데이터가 없습니다.");
    return;
  }

  data.items.slice(0, limit).forEach((item, idx) => {
    console.log(
      `${idx + 1}. 날짜=${item.date}, 종가=${item.closePrice.toLocaleString()}, 거래량=${item.volume.toLocaleString()}, 거래대금=${item.tradeValue.toLocaleString()}`
    );
  });
}

(async () => {
  try {
    loadStocks();

    const stockName = await promptForStockName();
    console.log(`\n[검색] 입력한 종목명: "${stockName}"`);

    const stockInfo = getStockCodeByName(stockName);

    if (!stockInfo) {
      console.log("일치하는 종목이 없습니다.");
      process.exit(1);
    }

    let selected = stockInfo;

    if (Array.isArray(stockInfo)) {
      console.log(`\n동일/유사한 종목이 ${stockInfo.length}개 있습니다.`);
      stockInfo.forEach((stock, idx) => {
        console.log(
          `${idx + 1}. ${stock.name} (${stock.market}) - 단축코드: ${stock.shortCode}`
        );
      });

      const selectedIndex = await promptForSelection(stockInfo.length);
      selected = stockInfo[selectedIndex];
    }

    console.log("\n선택된 종목");
    console.log(`종목명   : ${selected.name}`);
    console.log(`시장     : ${selected.market}`);
    console.log(`표준코드 : ${selected.stdCode}`);
    console.log(`단축코드 : ${selected.shortCode}`);

    const accessToken = await safeApiCall(
      () => getAccessToken(),
      "토큰 발급",
      300
    );
    console.log("토큰 발급 성공");

    const currentRaw = await safeApiCall(
      () => getCurrentPrice(accessToken, selected.shortCode),
      "현재가 조회",
      800
    );
    const currentData = normalizeCurrentPrice(currentRaw, selected);

    const { startDate, endDate } = getDateRange(5);

    const dailyRaw = await safeApiCall(
      () => getPeriodChart(accessToken, selected.shortCode, "D", startDate, endDate),
      "일봉 조회",
      1200
    );

    const weeklyRaw = await safeApiCall(
      () => getPeriodChart(accessToken, selected.shortCode, "W", startDate, endDate),
      "주봉 조회",
      1200
    );

    const monthlyRaw = await safeApiCall(
      () => getPeriodChart(accessToken, selected.shortCode, "M", startDate, endDate),
      "월봉 조회",
      1200
    );

    const yearlyRaw = await safeApiCall(
      () => getPeriodChart(accessToken, selected.shortCode, "Y", startDate, endDate),
      "연봉 조회",
      1200
    );

    const dailyData = normalizePeriodVolume(dailyRaw, selected, "DAY");
    const weeklyData = normalizePeriodVolume(weeklyRaw, selected, "WEEK");
    const monthlyData = normalizePeriodVolume(monthlyRaw, selected, "MONTH");
    const yearlyData = normalizePeriodVolume(yearlyRaw, selected, "YEAR");

    printSummary(currentData);
    printPeriodVolumes("일봉 거래량", dailyData, 10);
    printPeriodVolumes("주봉 거래량", weeklyData, 10);
    printPeriodVolumes("월봉 거래량", monthlyData, 10);
    printPeriodVolumes("연봉 거래량", yearlyData, 10);
  } catch (err) {
    console.error("\n실패");

    if (err.response) {
      console.error("status:", err.response.status);
      console.error("data:", JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message);
    }

    process.exit(1);
  }
})();