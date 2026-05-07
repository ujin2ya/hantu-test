// DART /api/company.json — 회사 기본정보 (대표이사·설립일·결산월·주소·홈페이지·업종코드 등)
// `.dart-corp-code.json` (stockCode → corpCode) 매핑 사용.
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CORP_CODE_PATH = path.join(__dirname, "..", "..", "..", ".dart-corp-code.json");
const CACHE_DIR = path.join(__dirname, "..", "..", "..", "cache", "dart-company-info");
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일 (회사 기본정보는 변동 적음)

let corpMap = null;
function loadCorpMap() {
  if (corpMap) return corpMap;
  try {
    corpMap = JSON.parse(fs.readFileSync(CORP_CODE_PATH, "utf-8"));
    return corpMap;
  } catch (_) { return null; }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function fmtDateYmd(s) {
  if (!s || String(s).length !== 8) return s || null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

function normalizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return "http://" + s;
}

async function fetchCompanyInfo(stockCode) {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return { error: "DART_API_KEY 미설정" };

  const map = loadCorpMap();
  const corpCode = map && map[stockCode];
  if (!corpCode) return { error: `corp_code 없음 (${stockCode})` };

  // 파일 캐시 (30일)
  ensureDir(CACHE_DIR);
  const cachePath = path.join(CACHE_DIR, `${stockCode}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS) return cached;
    } catch (_) {}
  }

  try {
    const r = await axios.get("https://opendart.fss.or.kr/api/company.json", {
      params: { crtfc_key: apiKey, corp_code: corpCode },
      timeout: 8000,
      validateStatus: () => true,
    });
    const d = r.data || {};
    if (d.status !== "000") {
      return { error: `${d.status} / ${d.message}` };
    }
    const result = {
      stockCode,
      corpCode,
      corpName: d.corp_name || null,
      corpNameEng: d.corp_name_eng || null,
      stockName: d.stock_name || null,
      ceoName: d.ceo_nm || null,
      establishedDate: d.est_dt || null,
      establishedDateFmt: fmtDateYmd(d.est_dt),
      accountingMonth: d.acc_mt || null, // 결산월 (12 등)
      address: d.adres || null,
      homepageUrl: normalizeUrl(d.hm_url),
      irUrl: normalizeUrl(d.ir_url),
      phoneNumber: d.phn_no || null,
      faxNumber: d.fax_no || null,
      industryCode: d.induty_code || null,
      corpCls: d.corp_cls || null, // Y=KOSPI, K=KOSDAQ, N=코넥스, E=기타
      jurirNo: d.jurir_no || null,
      bizrNo: d.bizr_no || null,
      fetchedAt: new Date().toISOString(),
    };
    try { fs.writeFileSync(cachePath, JSON.stringify(result)); } catch (_) {}
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { fetchCompanyInfo };
