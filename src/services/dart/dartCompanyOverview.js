// DART /api/cmpnyOvrviw.json — 기업개황 (corp_code → 회사 일반 정보).
// hyslrSttus는 분기 단위 보고서에서 주주현황만 받지만, cmpnyOvrviw는 발행주식 총수를 포함한다.
// 응답 예: { stk_total_no: '발행주식 총수 (보통주)', vstk_total_no: '기타주식 발행 총수' }
// 보통주식수/유동주식수 표시용 — 유동주식수는 dartShareholders의 totalRateEnd로 계산.
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CORP_CODE_PATH = path.join(__dirname, "..", "..", "..", ".dart-corp-code.json");
const CACHE_DIR = path.join(__dirname, "..", "..", "..", "cache", "dart-company-overview");
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

let corpMap = null;
function loadCorpMap() {
  if (corpMap) return corpMap;
  try { corpMap = JSON.parse(fs.readFileSync(CORP_CODE_PATH, "utf-8")); return corpMap; }
  catch (_) { return null; }
}
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function parseIntOr(v) {
  if (v == null || v === "" || v === "-") return null;
  const n = parseInt(String(v).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

async function fetchCompanyOverview(stockCode) {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return { error: "DART_API_KEY 미설정" };
  const map = loadCorpMap();
  const corpCode = map && map[stockCode];
  if (!corpCode) return { error: `corp_code 없음 (${stockCode})` };

  ensureDir(CACHE_DIR);
  const cachePath = path.join(CACHE_DIR, `${stockCode}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS) return cached;
    } catch (_) {}
  }

  let data;
  try {
    const r = await axios.get("https://opendart.fss.or.kr/api/company.json", {
      params: { crtfc_key: apiKey, corp_code: corpCode },
      timeout: 8000, validateStatus: () => true,
    });
    data = r.data || {};
  } catch (e) {
    return { error: `DART cmpnyOvrviw 호출 실패: ${e.message}` };
  }

  if (data.status !== "000") {
    return { error: `DART status ${data.status} / ${data.message || "-"}` };
  }

  const result = {
    stockCode,
    corpCode,
    corpName: data.corp_name || null,
    corpNameEng: data.corp_name_eng || null,
    stockName: data.stock_name || null,
    issuedShares: parseIntOr(data.stk_total_no),     // 보통주 발행주식 총수
    otherShares: parseIntOr(data.vstk_total_no),     // 기타(우선주 등) 발행주식 총수
    establishedDate: data.est_dt || null,
    accountingMonth: data.acc_mt || null,
    fetchedAt: new Date().toISOString(),
  };
  try { fs.writeFileSync(cachePath, JSON.stringify(result)); } catch (_) {}
  return result;
}

module.exports = { fetchCompanyOverview };
