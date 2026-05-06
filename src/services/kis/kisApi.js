// KIS 시세/차트 호출 — 현재가 + 일/주/월/년봉 차트.
const axios = require("axios");

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

module.exports = { getCurrentPrice, getPeriodChart };
