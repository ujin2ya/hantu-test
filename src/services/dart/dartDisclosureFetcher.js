// DART 공시 list fetcher.
// 엔드포인트: https://opendart.fss.or.kr/api/list.json (날짜 범위 + corp_code 필요)
// .dart-corp-code.json (stockCode → corpCode) 매핑 사용.
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CORP_CODE_PATH = path.join(__dirname, "..", "..", "..", ".dart-corp-code.json");
const TTL_MS = 60 * 60 * 1000; // 1시간 in-memory cache
const cache = new Map();

let corpMap = null;
function loadCorpMap() {
  if (corpMap) return corpMap;
  try {
    corpMap = JSON.parse(fs.readFileSync(CORP_CODE_PATH, "utf-8"));
    return corpMap;
  } catch (_) {
    return null;
  }
}

function fmtYmd(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function trimReportName(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function disclosureUrl(rceptNo) {
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`;
}

async function fetchRecentDisclosures(code, { days = 90, limit = 10 } = {}) {
  const key = `${code}:${days}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value;

  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return { disclosures: [], error: "DART_API_KEY 미설정" };

  const map = loadCorpMap();
  const corpCode = map && map[code];
  if (!corpCode) return { disclosures: [], error: `corp_code 없음 (${code})` };

  const today = new Date();
  const past = new Date(today.getTime() - days * 24 * 3600 * 1000);
  try {
    const r = await axios.get("https://opendart.fss.or.kr/api/list.json", {
      params: {
        crtfc_key: apiKey,
        corp_code: corpCode,
        bgn_de: fmtYmd(past),
        end_de: fmtYmd(today),
        page_count: limit,
      },
      timeout: 8000,
      validateStatus: () => true,
    });
    const data = r.data || {};
    if (data.status !== "000") {
      const value = { disclosures: [], status: data.status, message: data.message };
      cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
      return value;
    }
    const disclosures = (data.list || []).slice(0, limit).map((it) => ({
      reportName: trimReportName(it.report_nm),
      receiptDate: it.rcept_dt,
      receiptDateFmt: it.rcept_dt ? `${it.rcept_dt.slice(0,4)}-${it.rcept_dt.slice(4,6)}-${it.rcept_dt.slice(6,8)}` : null,
      filerName: it.flr_nm,
      receiptNo: it.rcept_no,
      url: disclosureUrl(it.rcept_no),
    }));
    const value = { disclosures, fetchedAt: new Date().toISOString() };
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch (e) {
    return { disclosures: [], error: e.message };
  }
}

module.exports = { fetchRecentDisclosures };
