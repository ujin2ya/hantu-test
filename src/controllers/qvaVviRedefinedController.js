// /qva-vvi-redefined-* 라우트 컨트롤러.
// - getRedefinedVviBoard / getRedefinedVviBacktest: 정적 HTML sendFile
// - getRedefinedVviStockDetail: 새 VVI 종목 상세 페이지 (재무·차트·뉴스·공시 + AI 버튼)
// - postCompanyAnalysis: AI 기업분석 lazy 호출
const fs = require("fs");
const path = require("path");
const { ROOT, REPORTS_DIR, CHART_DIR, CACHE_DIR } = require("../utils/paths");
const { getAccessToken } = require("../services/kis/kisToken");
const { getCurrentPrice } = require("../services/kis/kisApi");
const { fetchRecentNews } = require("../services/news/naverNewsFetcher");
const { fetchRecentDisclosures } = require("../services/dart/dartDisclosureFetcher");
const { generateCompanyAnalysis } = require("../services/ai/geminiCompanyAnalysis");

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

function loadRecentChart(code, days = 60) {
  const fp = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return { name: c.name, market: c.market, rows: (c.rows || []).slice(-days) };
  } catch (_) { return null; }
}

// 새 VVI 보드 funnel 정보 — 이 종목이 보드의 어느 그룹에 들어있는지
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

async function getRedefinedVviStockDetail(req, res) {
  try {
    const code = String(req.params.code || "").replace(/[^0-9A-Za-z]/g, "");
    if (!code) return res.status(400).send("종목 코드 누락");

    const meta = lookupStockMeta(code);
    if (!meta) return res.status(404).send(`종목 ${code}을(를) 찾을 수 없습니다.`);

    const chart = loadRecentChart(code, 60);
    const financials = loadFinancials(code);
    const vviMembership = lookupVviMembership(code);

    // 외부 호출 3개 병렬 — 각각 timeout/실패 fallback
    const [kisLive, newsRes, disclosureRes] = await Promise.all([
      (async () => {
        try {
          const t = await getAccessToken();
          const k = await getCurrentPrice(t, code);
          const o = k && k.output;
          if (!o) return null;
          return {
            price: Number(o.stck_prpr) || null,
            prevClose: Number(o.stck_sdpr) || null,
            changeRate: Number(o.prdy_ctrt),
            changeAbs: Number(o.prdy_vrss) || null,
            open: Number(o.stck_oprc) || null,
            high: Number(o.stck_hgpr) || null,
            low: Number(o.stck_lwpr) || null,
            volume: Number(o.acml_vol) || null,
          };
        } catch (_) { return null; }
      })(),
      fetchRecentNews(code, 8),
      fetchRecentDisclosures(code, { days: 90, limit: 10 }),
    ]);

    res.render("qva-vvi-redefined-detail", {
      code,
      meta,
      chartRows: (chart && chart.rows) || [],
      financials,
      vviMembership,
      kisLive,
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

// AI 기업분석 — 버튼 클릭 시 호출
async function postCompanyAnalysis(req, res) {
  try {
    const code = String(req.params.code || "").replace(/[^0-9A-Za-z]/g, "");
    if (!code) return res.status(400).json({ error: "종목 코드 누락" });

    const meta = lookupStockMeta(code);
    if (!meta) return res.status(404).json({ error: `종목 ${code}을(를) 찾을 수 없습니다.` });

    const financials = loadFinancials(code);
    const [newsRes, discRes] = await Promise.all([
      fetchRecentNews(code, 8),
      fetchRecentDisclosures(code, { days: 90, limit: 10 }),
    ]);

    const snapshot = {
      code,
      name: meta.name,
      market: meta.market,
      marketCap: meta.marketCap,
      financials: financials ? {
        latest: financials.latest, prior: financials.prior, growth: financials.growth,
      } : null,
      disclosures: ((discRes && discRes.disclosures) || []).slice(0, 10).map((d) => ({
        date: d.receiptDateFmt, name: d.reportName,
      })),
      news: ((newsRes && newsRes.news) || []).slice(0, 8).map((n) => ({
        date: n.dateTimeFmt, title: n.title, source: n.source,
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
