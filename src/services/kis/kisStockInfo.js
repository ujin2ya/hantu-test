// KIS [국내주식] 종목정보 > 주식기본조회 (CTPF1002R) — 업종 분류 + 영문명 등 메타.
// URL: /uapi/domestic-stock/v1/quotations/search-stock-info
// 응답 핵심: prdt_name, prdt_eng_name, idx_bztp_lcls/mcls/scls_cd_name (업종 대/중/소분류), std_idst_clsf_cd_name (KSIC)
const axios = require("axios");
const { getAccessToken } = require("./kisToken");

const TTL_MS = 24 * 60 * 60 * 1000; // 24시간 in-memory cache (변동 거의 없음)
const cache = new Map();

async function fetchStockInfo(stockCode) {
  const key = stockCode;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value;

  try {
    const token = await getAccessToken();
    const url = `${process.env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/search-stock-info`;
    const r = await axios.get(url, {
      headers: {
        "content-type": "application/json; charset=UTF-8",
        authorization: `Bearer ${token}`,
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
        tr_id: "CTPF1002R",
      },
      params: {
        PRDT_TYPE_CD: "300", // 주식·ETF·ETN·ELW
        PDNO: stockCode,
      },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (r.data && r.data.rt_cd !== "0") {
      const value = { error: `${r.data.msg_cd} / ${r.data.msg1}` };
      cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
      return value;
    }
    const o = (r.data && r.data.output) || {};
    const value = {
      productName: o.prdt_name || null,
      productNameEng: o.prdt_eng_name || null,
      productAbrvName: o.prdt_abrv_name || null,
      industryLclsName: o.idx_bztp_lcls_cd_name || null,  // 지수업종 대분류
      industryMclsName: o.idx_bztp_mcls_cd_name || null,  // 지수업종 중분류
      industryScls: o.idx_bztp_scls_cd_name || null,      // 지수업종 소분류
      ksicName: o.std_idst_clsf_cd_name || null,          // 표준산업분류
      securityGroupCode: o.scty_grp_id_cd || null,
      raw: o,
    };
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { fetchStockInfo };
