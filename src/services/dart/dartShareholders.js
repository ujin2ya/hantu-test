// DART /api/hyslrSttus.json — 최대주주 등의 주식소유 현황 (사업/반기/분기 보고서 기준)
// 응답 list: { nm, relate, stock_knd, bsis_posesn_stock_co, bsis_posesn_stock_qota_rt,
//              trmend_posesn_stock_co, trmend_posesn_stock_qota_rt, stlm_dt, ... }
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CORP_CODE_PATH = path.join(__dirname, "..", "..", "..", ".dart-corp-code.json");
const CACHE_DIR = path.join(__dirname, "..", "..", "..", "cache", "dart-shareholders");
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일 (분기 단위 갱신)

let corpMap = null;
function loadCorpMap() {
  if (corpMap) return corpMap;
  try { corpMap = JSON.parse(fs.readFileSync(CORP_CODE_PATH, "utf-8")); return corpMap; }
  catch (_) { return null; }
}
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

const REPORT_LABEL = { "11011": "사업보고서", "11012": "반기보고서", "11013": "1분기보고서", "11014": "3분기보고서" };

// 보고서 종류 fallback 순서 — 가장 최근 가능성 높은 것부터.
// 사업보고서(전년 4월 공시) → 3분기 → 반기 → 1분기.
// 연도는 현재 + 직전 두 개 시도.
function* candidatePairs() {
  const now = new Date();
  const y = now.getUTCFullYear();
  for (const year of [y, y - 1, y - 2]) {
    for (const code of ["11011", "11014", "11012", "11013"]) yield { year, code };
  }
}

async function fetchOnce(corpCode, year, reportCode, apiKey) {
  try {
    const r = await axios.get("https://opendart.fss.or.kr/api/hyslrSttus.json", {
      params: { crtfc_key: apiKey, corp_code: corpCode, bsns_year: year, reprt_code: reportCode },
      timeout: 8000, validateStatus: () => true,
    });
    return r.data || {};
  } catch (e) {
    return { status: "ERR", message: e.message };
  }
}

async function fetchShareholders(stockCode) {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return { error: "DART_API_KEY 미설정" };
  const map = loadCorpMap();
  const corpCode = map && map[stockCode];
  if (!corpCode) return { error: `corp_code 없음 (${stockCode})` };

  // 파일 캐시
  ensureDir(CACHE_DIR);
  const cachePath = path.join(CACHE_DIR, `${stockCode}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS) return cached;
    } catch (_) {}
  }

  // 보고서 fallback 시도
  let usedYear = null, usedCode = null, list = null, lastStatus = null, lastMessage = null;
  for (const { year, code } of candidatePairs()) {
    const data = await fetchOnce(corpCode, year, code, apiKey);
    lastStatus = data.status; lastMessage = data.message;
    if (data.status === "000" && Array.isArray(data.list) && data.list.length > 0) {
      usedYear = year; usedCode = code; list = data.list; break;
    }
    // status 013 = "조회된 데이타가 없습니다" → 다음 보고서 시도
    // 그 외 에러도 다음 시도 (rate limit 등)
  }

  if (!list) {
    return { error: `최근 보고서에서 주주현황 데이터 없음 (last: ${lastStatus} / ${lastMessage})` };
  }

  // 한 종목에 보통주·우선주 + 본인·특수관계인 row 여러 개. 마지막 "계" 합계 row는 별도 분리.
  const items = list.map((d) => ({
    name: (d.nm || "").trim() || null,
    relation: d.relate || null,                      // 본인 / 특수관계인 / etc
    stockKind: d.stock_knd || null,                  // 보통주 / 우선주
    sharesEnd: parseIntOr(d.trmend_posesn_stock_co),
    rateEnd: parseFloatOr(d.trmend_posesn_stock_qota_rt),
    sharesStart: parseIntOr(d.bsis_posesn_stock_co),
    rateStart: parseFloatOr(d.bsis_posesn_stock_qota_rt),
    note: d.rm && d.rm !== "-" ? d.rm : null,
  }));

  // 합계 row 식별 — name이 "계" 또는 "합계" 등이면 분리 (DART는 보통 마지막 row가 합계)
  function isSummaryRow(it) {
    if (!it.name) return false;
    const n = it.name.replace(/\s+/g, "");
    return n === "계" || n === "합계" || n === "총계" || n === "소계";
  }
  const summaryRow = items.find(isSummaryRow);
  const memberItems = items.filter((it) => !isSummaryRow(it));

  // 보통주만 (개별 주주 row)
  const commonItems = memberItems.filter((it) => it.stockKind === "보통주" || !it.stockKind);
  // 합계는 DART 응답의 합계 row가 있으면 그것을, 없으면 직접 계산
  const totalRateEnd = summaryRow && summaryRow.rateEnd != null ? summaryRow.rateEnd : commonItems.reduce((s, it) => s + (it.rateEnd || 0), 0);
  const totalSharesEnd = summaryRow && summaryRow.sharesEnd != null ? summaryRow.sharesEnd : commonItems.reduce((s, it) => s + (it.sharesEnd || 0), 0);

  // 최대주주 (지분율 가장 큰 본인 또는 첫 row)
  const sortedByRate = [...commonItems].sort((a, b) => (b.rateEnd || 0) - (a.rateEnd || 0));
  const topShareholder = sortedByRate[0] || null;

  const result = {
    stockCode,
    corpCode,
    reportYear: usedYear,
    reportCode: usedCode,
    reportLabel: REPORT_LABEL[usedCode] || usedCode,
    settlementDate: list[0] && list[0].stlm_dt,    // YYYY-MM-DD
    items,                                          // 전체 row
    commonItems,                                    // 보통주만
    topShareholder,
    totalRateEnd,                                   // 본인+특수관계인 합계 지분율
    totalSharesEnd,                                 // 본인+특수관계인 합계 주식수
    fetchedAt: new Date().toISOString(),
  };
  try { fs.writeFileSync(cachePath, JSON.stringify(result)); } catch (_) {}
  return result;
}

function parseIntOr(v) { if (v == null || v === "" || v === "-") return null; const n = parseInt(String(v).replace(/,/g, ""), 10); return Number.isFinite(n) ? n : null; }
function parseFloatOr(v) { if (v == null || v === "" || v === "-") return null; const n = parseFloat(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; }

module.exports = { fetchShareholders };
