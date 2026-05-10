// /qva-vvi-redefined-* 라우트 컨트롤러.
// - getRedefinedVviBoard / getRedefinedVviBacktest: 정적 HTML sendFile
// - getRedefinedVviStockDetail: 새 VVI 종목 상세 페이지 (CompanyGuide 스타일 기업정보 영역)
// - postCompanyAnalysis: AI 사업내용 요약 lazy 호출
const fs = require("fs");
const path = require("path");
const { ROOT, REPORTS_DIR, CHART_DIR, CACHE_DIR } = require("../utils/paths");
const { getAccessToken } = require("../services/kis/kisToken");
const { getCurrentPrice } = require("../services/kis/kisApi");
const { fetchStockInfo: fetchKisStockInfo } = require("../services/kis/kisStockInfo");
const { fetchCompanyInfo: fetchDartCompanyInfo } = require("../services/dart/dartCompanyInfo");
const { fetchShareholders: fetchDartShareholders } = require("../services/dart/dartShareholders");
const { fetchCompanyOverview: fetchDartCompanyOverview } = require("../services/dart/dartCompanyOverview");
const { computeSharesInfo } = require("../utils/sharesInfo");
const { fetchRecentNews } = require("../services/news/naverNewsFetcher");
const { fetchRecentDisclosures } = require("../services/dart/dartDisclosureFetcher");
const { generateCompanyAnalysis } = require("../services/ai/geminiCompanyAnalysis");
const dartFetcher = require("../../dart-fetcher");

const BOARD_HTML    = path.join(REPORTS_DIR, "qva-vvi-redefined-board-result.html");
const BACKTEST_HTML = path.join(REPORTS_DIR, "qva-vvi-redefined-backtest-result.html");
const BOARD_JSON    = path.join(REPORTS_DIR, "qva-vvi-redefined-board-result.json");
const NAVER_LIST    = path.join(CACHE_DIR, "naver-stocks-list.json");
const FINANCIALS_DIR = path.join(CACHE_DIR, "dart-financials");

function getRedefinedVviBoard(req, res) {
  if (!fs.existsSync(BOARD_HTML)) {
    return res.status(404).send("reports/qva-vvi-redefined-board-result.html 파일이 없습니다. `node qva-vvi-redefined-board.js`를 먼저 실행하세요.");
  }
  res.sendFile(BOARD_HTML);
}

function getRedefinedVviBacktest(req, res) {
  if (!fs.existsSync(BACKTEST_HTML)) {
    return res.status(404).send("reports/qva-vvi-redefined-backtest-result.html 파일이 없습니다. `node qva-vvi-redefined-backtest-report.js`를 먼저 실행하세요.");
  }
  res.sendFile(BACKTEST_HTML);
}

// ── 종목 메타·재무 lookup ──
function lookupStockMeta(code) {
  if (fs.existsSync(NAVER_LIST)) {
    try {
      const j = JSON.parse(fs.readFileSync(NAVER_LIST, "utf-8"));
      const hit = (j.stocks || []).find((s) => s.code === code);
      if (hit) return { name: hit.name, market: hit.market, marketCap: hit.marketValue || 0, isEtf: !!hit.isEtf, isSpecial: !!hit.isSpecial };
    } catch (_) {}
  }
  return null;
}

function loadFinancials(code) {
  const fp = path.join(FINANCIALS_DIR, `${code}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (_) { return null; }
}

// Lazy auto-fetch DART 재무 — 캐시 hit 즉답, miss 시 DART 호출 (12s timeout).
async function loadOrFetchFinancials(code) {
  const cached = loadFinancials(code);
  if (cached) return cached;
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return null;
  try {
    return await Promise.race([
      dartFetcher.getFinancialsCached(code, apiKey),
      new Promise((_, rej) => setTimeout(() => rej(new Error("DART fetch timeout (12s)")), 12000)),
    ]);
  } catch (e) {
    console.warn(`[qva-vvi-redefined] DART 재무 lazy fetch failed for ${code}: ${e.message}`);
    return null;
  }
}

function loadFullChart(code) {
  const fp = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return { name: c.name, market: c.market, rows: c.rows || [] };
  } catch (_) { return null; }
}

// 일봉 기반 기간 수익률 (영업일 기준 근사: 1M≈21, 3M≈63, 6M≈126, 1Y≈252).
function computePeriodReturns(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  if (!last || !last.close) return null;
  function rateBack(N) {
    const idx = rows.length - 1 - N;
    if (idx < 0) return null;
    const past = rows[idx];
    if (!past || !past.close) return null;
    return (last.close / past.close - 1) * 100;
  }
  return {
    ret1M: rateBack(21),
    ret3M: rateBack(63),
    ret6M: rateBack(126),
    ret1Y: rateBack(252),
  };
}

// 새 VVI 보드 funnel 정보
function lookupVviMembership(code) {
  if (!fs.existsSync(BOARD_JSON)) return null;
  try {
    const b = JSON.parse(fs.readFileSync(BOARD_JSON, "utf-8"));
    const groups = b.visibleGroups || {};
    const checks = [
      { key: "stableBreakoutCandidates",      group: "stable",     label: "안정형 고점 재돌파" },
      { key: "strongValueBreakoutCandidates", group: "strong",     label: "강한 거래대금 재돌파" },
      { key: "valueInsufficientPreviewCandidates", group: "valueInsuf", label: "거래대금 부족 돌파 참고" },
      { key: "waitingPreviewCandidates",      group: "waiting",    label: "고점 재돌파 대기" },
    ];
    for (const c of checks) {
      const hit = (groups[c.key] || []).find((it) => it.code === code);
      if (hit) return { group: c.group, label: c.label, item: hit };
    }
  } catch (_) {}
  return null;
}

// KIS 현재가 raw output → 시세현황·메타 view data로 정리
function extractPriceQuoteFromKis(o) {
  if (!o) return null;
  const num = (v) => v == null || v === "" ? null : Number(v);
  return {
    price: num(o.stck_prpr),
    prevClose: num(o.stck_sdpr),
    changeRate: num(o.prdy_ctrt),
    changeAbs: num(o.prdy_vrss),
    open: num(o.stck_oprc),
    high: num(o.stck_hgpr),
    low: num(o.stck_lwpr),
    volume: num(o.acml_vol),
    valueAmount: num(o.acml_tr_pbmn),
    upperLimit: num(o.stck_mxpr),
    lowerLimit: num(o.stck_llam),
    weightedAvgPrice: num(o.wghn_avrg_stck_prc),
    volumeTurnoverRate: num(o.vol_tnrt),
    // 52주 / 250일 / 연중
    week52High: num(o.w52_hgpr),
    week52Low: num(o.w52_lwpr),
    week52HighDate: o.w52_hgpr_date || null,
    week52LowDate: o.w52_lwpr_date || null,
    week52HighFromCurrent: num(o.w52_hgpr_vrss_prpr_ctrt),
    week52LowFromCurrent: num(o.w52_lwpr_vrss_prpr_ctrt),
    yearHigh: num(o.stck_dryy_hgpr),
    yearLow: num(o.stck_dryy_lwpr),
    // 밸류 지표
    per: num(o.per),
    pbr: num(o.pbr),
    eps: num(o.eps),
    bps: num(o.bps),
    // 외인 / 신용
    foreignHoldingQty: num(o.frgn_hldn_qty),
    foreignHoldingRate: num(o.hts_frgn_ehrt),
    // 종목 메타
    industryName: o.bstp_kor_isnm || null,        // 업종명 (e.g. "기계·장비")
    marketName: o.rprs_mrkt_kor_name || null,     // 대표 시장명
    accountingMonth: num(o.stac_month),           // 결산월
    faceValue: num(o.stck_fcam),                  // 액면가
    listedShares: num(o.lstn_stcn),               // 상장주식수
    capital: num(o.cpfn),                         // 자본금 (단위: 억)
    marketCapEokwon: num(o.hts_avls),             // 시가총액 (단위: 억)
    // 위험 플래그 — KIS는 "Y"(해당) / "N"(아님) 또는 "00"(정상)/"01"(경고)/"02"(위험) 등 다중 표기.
    // 안전하게 "Y" 또는 "00이 아닌 숫자 코드"일 때만 true.
    isManagement: o.mang_issu_cls_code === "Y",
    marketWarn: (o.mrkt_warn_cls_code && o.mrkt_warn_cls_code !== "00") ? o.mrkt_warn_cls_code : null,
    isShortOver: o.short_over_yn === "Y",
    tradeStop: o.temp_stop_yn === "Y",
    viCode: (o.vi_cls_code && o.vi_cls_code !== "N" && o.vi_cls_code !== "00") ? o.vi_cls_code : null,
    investCaution: o.invt_caful_yn === "Y",
  };
}

async function getRedefinedVviStockDetail(req, res) {
  try {
    const code = String(req.params.code || "").replace(/[^0-9A-Za-z]/g, "");
    if (!code) return res.status(400).send("종목 코드 누락");

    const meta = lookupStockMeta(code);
    if (!meta) return res.status(404).send(`종목 ${code}을(를) 찾을 수 없습니다.`);

    const chart = loadFullChart(code);
    const vviMembership = lookupVviMembership(code);
    const periodReturns = chart ? computePeriodReturns(chart.rows) : null;

    // 8개 외부 호출 병렬
    const [financials, kisRaw, kisStockInfo, companyInfo, shareholders, companyOverview, newsRes, disclosureRes] = await Promise.all([
      loadOrFetchFinancials(code),
      (async () => {
        try {
          const t = await getAccessToken();
          const k = await getCurrentPrice(t, code);
          return k && k.output ? k.output : null;
        } catch (_) { return null; }
      })(),
      fetchKisStockInfo(code),
      fetchDartCompanyInfo(code),
      fetchDartShareholders(code),
      fetchDartCompanyOverview(code).catch(() => null),
      fetchRecentNews(code, 8),
      fetchRecentDisclosures(code, { days: 90, limit: 10 }),
    ]);

    const priceQuote = extractPriceQuoteFromKis(kisRaw);
    const kisLiveForShares = priceQuote ? { listedShares: priceQuote.listedShares } : null;
    const sharesInfo = computeSharesInfo({ companyOverview, kisLive: kisLiveForShares, shareholders });

    res.render("qva-vvi-redefined-detail", {
      code,
      meta,
      chartRows: (chart && chart.rows) || [],
      financials,
      vviMembership,
      priceQuote,
      kisStockInfo: kisStockInfo && !kisStockInfo.error ? kisStockInfo : null,
      kisStockInfoError: kisStockInfo && kisStockInfo.error ? kisStockInfo.error : null,
      companyInfo: companyInfo && !companyInfo.error ? companyInfo : null,
      companyInfoError: companyInfo && companyInfo.error ? companyInfo.error : null,
      shareholders: shareholders && !shareholders.error ? shareholders : null,
      shareholdersError: shareholders && shareholders.error ? shareholders.error : null,
      sharesInfo,
      periodReturns,
      news: (newsRes && newsRes.news) || [],
      newsError: (newsRes && newsRes.error) || null,
      disclosures: (disclosureRes && disclosureRes.disclosures) || [],
      disclosureError: (disclosureRes && (disclosureRes.error || disclosureRes.message)) || null,
    });
  } catch (e) {
    console.error("[qva-vvi-redefined-detail]", e);
    res.status(500).send("상세 페이지 렌더 오류: " + e.message);
  }
}

// AI 사업내용 요약 — 공식 데이터(KIS 업종 + DART 회사정보 + 재무 + 공시·뉴스) 기반.
async function postCompanyAnalysis(req, res) {
  try {
    const code = String(req.params.code || "").replace(/[^0-9A-Za-z]/g, "");
    if (!code) return res.status(400).json({ error: "종목 코드 누락" });

    const meta = lookupStockMeta(code);
    if (!meta) return res.status(404).json({ error: `종목 ${code}을(를) 찾을 수 없습니다.` });

    const [financials, kisStockInfo, companyInfo, shareholders, newsRes, discRes] = await Promise.all([
      loadOrFetchFinancials(code),
      fetchKisStockInfo(code),
      fetchDartCompanyInfo(code),
      fetchDartShareholders(code),
      fetchRecentNews(code, 8),
      fetchRecentDisclosures(code, { days: 90, limit: 10 }),
    ]);

    const snapshot = {
      code,
      name: meta.name,
      market: meta.market,
      marketCap: meta.marketCap,
      industry: kisStockInfo && !kisStockInfo.error ? {
        lcls: kisStockInfo.industryLclsName,
        mcls: kisStockInfo.industryMclsName,
        scls: kisStockInfo.industryScls,
        ksic: kisStockInfo.ksicName,
      } : null,
      company: companyInfo && !companyInfo.error ? {
        ceoName: companyInfo.ceoName,
        establishedDate: companyInfo.establishedDateFmt,
        accountingMonth: companyInfo.accountingMonth,
        address: companyInfo.address,
        homepageUrl: companyInfo.homepageUrl,
        corpNameEng: companyInfo.corpNameEng,
      } : null,
      // 최대주주 정보 — AI가 그룹 계열·지배구조 추론에 활용
      shareholders: shareholders && !shareholders.error ? {
        topShareholder: shareholders.topShareholder,
        totalRateEnd: shareholders.totalRateEnd,
        commonItems: shareholders.commonItems,
        reportLabel: shareholders.reportLabel,
        settlementDate: shareholders.settlementDate,
      } : null,
      financials: financials ? {
        latest: financials.latest, prior: financials.prior, growth: financials.growth,
      } : null,
      disclosures: ((discRes && discRes.disclosures) || []).slice(0, 10).map((d) => ({
        date: d.receiptDateFmt, name: d.reportName,
      })),
      news: ((newsRes && newsRes.news) || []).slice(0, 8).map((n) => ({
        date: n.dateTimeFmt, title: n.title, source: n.source, body: n.body,
      })),
    };

    const result = await generateCompanyAnalysis(snapshot);
    res.json(result);
  } catch (e) {
    console.error("[qva-vvi-redefined-ai]", e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  getRedefinedVviBoard,
  getRedefinedVviBacktest,
  getRedefinedVviStockDetail,
  postCompanyAnalysis,
};
