// DART 재무 데이터 fetcher — 분기/연간 영업이익·매출 성장률 계산.
//
// API: https://opendart.fss.or.kr/api/fnlttSinglAcnt.json
//   - corp_code, bsns_year, reprt_code (11011=사업보고서, 11012=반기, 11013=1분기, 11014=3분기)
//   - 응답: 매출액·영업이익·당기순이익 등 line items
//
// 캐싱: cache/dart-financials/<stockCode>.json (분기당 1회 갱신, 30일 TTL)

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CORP_CODE_PATH = path.join(__dirname, ".dart-corp-code.json");
const FINANCIALS_DIR = path.join(__dirname, "cache", "dart-financials");
const FINANCIALS_HISTORY_DIR = path.join(__dirname, "cache", "dart-financials-history");
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

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

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 단일 분기 재무 fetch — rate-limit backoff 1회 retry 포함
async function fetchSingleQuarter(corpCode, year, reportCode, apiKey, retryDelayMs = 1500) {
  const url = "https://opendart.fss.or.kr/api/fnlttSinglAcnt.json";
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await axios.get(url, {
      params: { crtfc_key: apiKey, corp_code: corpCode, bsns_year: year, reprt_code: reportCode },
      timeout: 8000,
      validateStatus: () => true,
    });
    const data = response.data || {};
    // status 020 = "조회 한도 초과" — backoff 후 retry
    // HTTP 429 / 5xx — backoff 후 retry
    const httpThrottled = response.status === 429 || (response.status >= 500 && response.status < 600);
    const dartLimit = data.status === "020"; // DART 자체 limit
    if ((httpThrottled || dartLimit) && attempt === 0) {
      await sleep(retryDelayMs);
      continue;
    }
    break;
  }
  const data = response?.data || {};
  if (data.status === "013") return null;          // 데이터 없음
  if (data.status === "020") return null;          // 한도 초과 → 재시도해도 실패면 null (블로킹 회피)
  if (data.status && data.status !== "000") {
    throw new Error(`DART [${data.status}]: ${data.message}`);
  }
  // 연결재무제표 (CFS) 우선, 없으면 별도 (OFS)
  const items = (data.list || []).filter((it) => it.fs_div === "CFS");
  const baseItems = items.length ? items : (data.list || []).filter((it) => it.fs_div === "OFS");
  if (!baseItems.length) return null;

  // 주요 항목 추출 — 당기 누적
  const find = (names) => {
    for (const it of baseItems) {
      const nm = (it.account_nm || "").replace(/\s/g, "");
      if (names.some((n) => nm.includes(n))) {
        const v = Number(String(it.thstrm_amount || "0").replace(/,/g, ""));
        if (Number.isFinite(v) && v !== 0) return v;
      }
    }
    return null;
  };

  return {
    revenue: find(["매출액", "수익(매출액)", "영업수익"]),
    opIncome: find(["영업이익"]),
    netIncome: find(["당기순이익", "분기순이익", "반기순이익"]),
    bsnsYear: year,
    reportCode,
  };
}

// 최근 가능한 분기 + 전년 동기 fetch
async function fetchFinancials(stockCode, apiKey) {
  const map = loadCorpMap();
  if (!map) return null;
  const corpCode = map[stockCode];
  if (!corpCode) return null;

  // 최근 분기 시도 — 현재년도부터 거꾸로
  // 한국 분기보고 일정: 1Q ~ 5월, 반기 ~ 8월, 3Q ~ 11월, 사업 ~ 3월말
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;

  // 최근 가능한 reportCode 추정
  // 이 시점에 어떤 분기 보고서가 공시됐을지
  const candidates = [];
  if (month >= 5) candidates.push({ year, reportCode: "11013" }); // 1Q
  if (month >= 8) candidates.push({ year, reportCode: "11012" }); // 반기
  if (month >= 11) candidates.push({ year, reportCode: "11014" }); // 3Q
  if (month >= 3) candidates.push({ year: year - 1, reportCode: "11011" }); // 작년 사업보고서
  candidates.push({ year: year - 1, reportCode: "11014" }); // 작년 3Q
  candidates.push({ year: year - 1, reportCode: "11012" }); // 작년 반기

  let latest = null;
  let latestReportCode = null;
  let latestYear = null;
  for (const c of candidates) {
    try {
      const data = await fetchSingleQuarter(corpCode, c.year, c.reportCode, apiKey);
      if (data && data.opIncome != null) {
        latest = data;
        latestReportCode = c.reportCode;
        latestYear = c.year;
        break;
      }
    } catch (_) {}
  }

  if (!latest) return { stockCode, corpCode, error: "최근 재무 미발견" };

  // 전년 동기 fetch
  let prior = null;
  try {
    prior = await fetchSingleQuarter(corpCode, latestYear - 1, latestReportCode, apiKey);
  } catch (_) {}

  // YoY 성장률
  function growth(now, then) {
    if (now == null || then == null || then === 0) return null;
    return Number(((now - then) / Math.abs(then) * 100).toFixed(1));
  }

  return {
    stockCode, corpCode,
    fetchedAt: new Date().toISOString(),
    latest: { ...latest, year: latestYear, reportCode: latestReportCode },
    prior: prior || null,
    growth: prior ? {
      revenue: growth(latest.revenue, prior.revenue),
      opIncome: growth(latest.opIncome, prior.opIncome),
      netIncome: growth(latest.netIncome, prior.netIncome),
    } : null,
  };
}

// 캐싱 wrapper
async function getFinancialsCached(stockCode, apiKey) {
  ensureDir(FINANCIALS_DIR);
  const cachePath = path.join(FINANCIALS_DIR, stockCode + ".json");
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    const fetched = new Date(data.fetchedAt).getTime();
    if (Date.now() - fetched < TTL_MS) return data;
  } catch (_) {}

  const result = await fetchFinancials(stockCode, apiKey);
  if (result) {
    try {
      fs.writeFileSync(cachePath, JSON.stringify(result));
    } catch (_) {}
  }
  return result;
}

// 영업이익 + 매출 성장률 점수 (0~25)
//   - 영업이익 YoY +25%+: 10점
//   - 영업이익 YoY +10%+: 5점
//   - 매출 YoY +20%+: 10점
//   - 매출 YoY +10%+: 5점
//   - 영업이익률 (영업이익/매출) ≥ 10%: 5점
function computeGrowthScore(financials) {
  if (!financials || !financials.growth || !financials.latest) return { score: 0, breakdown: {} };
  const g = financials.growth;
  const l = financials.latest;
  const breakdown = {};
  let score = 0;

  if (g.opIncome != null) {
    if (g.opIncome >= 25) { score += 10; breakdown.opIncomeYoY = `+${g.opIncome}% (10점)`; }
    else if (g.opIncome >= 10) { score += 5; breakdown.opIncomeYoY = `+${g.opIncome}% (5점)`; }
    else { breakdown.opIncomeYoY = `${g.opIncome >= 0 ? '+' : ''}${g.opIncome}% (0점)`; }
  }
  if (g.revenue != null) {
    if (g.revenue >= 20) { score += 10; breakdown.revenueYoY = `+${g.revenue}% (10점)`; }
    else if (g.revenue >= 10) { score += 5; breakdown.revenueYoY = `+${g.revenue}% (5점)`; }
    else { breakdown.revenueYoY = `${g.revenue >= 0 ? '+' : ''}${g.revenue}% (0점)`; }
  }
  if (l.opIncome != null && l.revenue != null && l.revenue > 0) {
    const margin = (l.opIncome / l.revenue) * 100;
    breakdown.opMarginPct = Number(margin.toFixed(1));
    if (margin >= 10) { score += 5; breakdown.margin = `${margin.toFixed(1)}% (5점)`; }
    else { breakdown.margin = `${margin.toFixed(1)}% (0점)`; }
  }

  return { score, breakdown };
}

// ─────────── Phase 2: 시점별 공시 보정 (asOf) ───────────
//
// 문제: 기존 getFinancialsCached 는 항상 "현재 가장 최근" 분기만 반환 → 백테스트 시점 미래 데이터 누출
// 해결: 모든 분기를 history 로 저장 + 시점별 가용일 기준 lookup
//
// 가용일 표준 (한국 법정 공시 마감일 + 마진 10일):
//   1Q (11013, 결산 3/31)  → 5/25 (마감 5/15 + 10)
//   반기 (11012, 결산 6/30) → 8/25 (마감 8/14 + 10)
//   3Q (11014, 결산 9/30)  → 11/25 (마감 11/14 + 10)
//   사업 (11011, 결산 12/31) → 다음해 4/10 (마감 3/31 + 10)

function reportAvailableDate(year, reportCode) {
  const r = String(reportCode);
  if (r === "11013") return `${year}0525`;       // 1Q
  if (r === "11012") return `${year}0825`;       // 반기
  if (r === "11014") return `${year}1125`;       // 3Q
  if (r === "11011") return `${year + 1}0410`;   // 사업
  return null;
}

// 분기 라벨 (디버깅용)
function reportLabel(year, reportCode) {
  const r = String(reportCode);
  if (r === "11013") return `${year}Q1`;
  if (r === "11012") return `${year}H1`;
  if (r === "11014") return `${year}Q3`;
  if (r === "11011") return `${year}FY`;
  return `${year}-${reportCode}`;
}

// 여러 분기 raw fetch — lookback N년
async function fetchFinancialsHistory(corpCode, apiKey, lookbackYears = 3, throttleMs = 60) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const reports = [];

  for (let y = currentYear - lookbackYears; y <= currentYear; y++) {
    for (const rc of ["11013", "11012", "11014", "11011"]) {
      try {
        const data = await fetchSingleQuarter(corpCode, y, rc, apiKey);
        if (data && data.opIncome != null) {
          reports.push({
            year: y,
            reportCode: rc,
            label: reportLabel(y, rc),
            availableDate: reportAvailableDate(y, rc),
            revenue: data.revenue,
            opIncome: data.opIncome,
            netIncome: data.netIncome,
          });
        }
      } catch (_) {}
      if (throttleMs > 0) await sleep(throttleMs);
    }
  }

  // 가용일 오름차순 정렬
  return reports.sort((a, b) => String(a.availableDate).localeCompare(String(b.availableDate)));
}

// history 캐시 wrapper (긴 TTL 90일 — 분기 발표 후 변경 거의 없음)
async function getFinancialsHistoryCached(stockCode, apiKey, { lookbackYears = 3, ttlMs = 90 * 24 * 60 * 60 * 1000 } = {}) {
  const map = loadCorpMap();
  if (!map) return null;
  const corpCode = map[stockCode];
  if (!corpCode) return null;

  ensureDir(FINANCIALS_HISTORY_DIR);
  const cachePath = path.join(FINANCIALS_HISTORY_DIR, stockCode + ".json");
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (data && data.fetchedAt && Date.now() - new Date(data.fetchedAt).getTime() < ttlMs) {
      return data;
    }
  } catch (_) {}

  const reports = await fetchFinancialsHistory(corpCode, apiKey, lookbackYears);
  const result = {
    stockCode,
    corpCode,
    fetchedAt: new Date().toISOString(),
    reports,
  };
  try { fs.writeFileSync(cachePath, JSON.stringify(result)); } catch (_) {}
  return result;
}

// 시점 기준 — 그 날짜에 이미 공시된 가장 최근 분기 + 전년 동기 → YoY 계산
function getFinancialsAsOf(history, asOfDate) {
  if (!history?.reports?.length) return null;
  const dateStr = String(asOfDate || "").replace(/-/g, "");
  if (!dateStr) return null;

  // 가용일 ≤ asOf 인 분기만
  const available = history.reports.filter((r) => String(r.availableDate) <= dateStr);
  if (!available.length) return null;

  const latest = available[available.length - 1];
  const prior = available.find((r) =>
    r.year === latest.year - 1 && r.reportCode === latest.reportCode
  );

  function growth(now, then) {
    if (now == null || then == null || then === 0) return null;
    return Number(((now - then) / Math.abs(then) * 100).toFixed(1));
  }

  return {
    latest,
    prior: prior || null,
    growth: prior ? {
      revenue: growth(latest.revenue, prior.revenue),
      opIncome: growth(latest.opIncome, prior.opIncome),
      netIncome: growth(latest.netIncome, prior.netIncome),
    } : null,
    asOfDate: dateStr,
  };
}

// 일괄 시드 (history 모드)
async function fetchAllFinancialsHistory({ stocksList, apiKey, lookbackYears = 3, throttleMs = 60, onProgress = null, resume = true } = {}) {
  ensureDir(FINANCIALS_HISTORY_DIR);
  let success = 0, fail = 0, skipped = 0, cached = 0;

  for (let i = 0; i < stocksList.length; i++) {
    const meta = stocksList[i];
    if (meta.isSpecial) { skipped++; continue; }

    const cachePath = path.join(FINANCIALS_HISTORY_DIR, meta.code + ".json");
    if (resume && fs.existsSync(cachePath)) {
      cached++;
      if (onProgress) onProgress({ i, total: stocksList.length, code: meta.code, name: meta.name, status: "cached" });
      continue;
    }

    try {
      const r = await getFinancialsHistoryCached(meta.code, apiKey, { lookbackYears });
      if (r && r.reports?.length) {
        success++;
        if (onProgress) onProgress({ i, total: stocksList.length, code: meta.code, name: meta.name, status: "ok", reports: r.reports.length });
      } else {
        fail++;
        if (onProgress) onProgress({ i, total: stocksList.length, code: meta.code, name: meta.name, status: "empty" });
      }
    } catch (e) {
      fail++;
      if (onProgress) onProgress({ i, total: stocksList.length, code: meta.code, status: "error", error: e.message });
    }
    // throttle 은 fetchFinancialsHistory 내부에서 분기당 한 번 적용됨
  }

  return { success, fail, skipped, cached };
}

// 모든 시드된 종목 재무 일괄 수집 (실적 점수 계산용)
async function fetchAllFinancials({ stocksList, apiKey, throttleMs = 100, onProgress = null } = {}) {
  let success = 0, fail = 0, skipped = 0;
  for (let i = 0; i < stocksList.length; i++) {
    const meta = stocksList[i];
    if (meta.isSpecial) { skipped++; continue; }
    try {
      const r = await getFinancialsCached(meta.code, apiKey);
      if (r && !r.error) success++;
      else fail++;
      if (onProgress) onProgress({ i, total: stocksList.length, code: meta.code, name: meta.name, ok: !!r && !r.error });
    } catch (e) {
      fail++;
      if (onProgress) onProgress({ i, total: stocksList.length, code: meta.code, ok: false, error: e.message });
    }
    if (i < stocksList.length - 1) await sleep(throttleMs);
  }
  return { success, fail, skipped };
}

module.exports = {
  loadCorpMap,
  fetchFinancials,
  getFinancialsCached,
  computeGrowthScore,
  fetchAllFinancials,
  // Phase 2: 시점별 보정
  reportAvailableDate,
  reportLabel,
  fetchFinancialsHistory,
  getFinancialsHistoryCached,
  getFinancialsAsOf,
  fetchAllFinancialsHistory,
};
