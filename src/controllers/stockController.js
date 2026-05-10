// /stock/:code — 보드 어디서든 종목명을 클릭하면 떠오르는 단순 종목 상세 페이지.
// 기존 단건 검색 (/?query=...)는 8c863eaf에서 제거됐고, 이게 그 대체 페이지.
const fs = require("fs");
const path = require("path");
const { ROOT, REPORTS_DIR, CHART_DIR, STOCKS_PATH } = require("../utils/paths");
const { getAccessToken } = require("../services/kis/kisToken");
const { getCurrentPrice } = require("../services/kis/kisApi");
const { fetchCompanyOverview } = require("../services/dart/dartCompanyOverview");
const { fetchShareholders } = require("../services/dart/dartShareholders");
const { computeSharesInfo } = require("../utils/sharesInfo");

const NAVER_LIST_PATH = path.join(ROOT, "cache", "naver-stocks-list.json");
const QVA_BOARD_JSON = path.join(ROOT, "qva-watchlist-board.json");
const REBREAK_OPERATION_JSON = path.join(REPORTS_DIR, "hgroup-rebreak-operation-board-result.json");
const ONEDAY_SURGE_JSON = path.join(REPORTS_DIR, "one-day-surge-board-result.json");

// 종목 메타 lookup — naver-stocks-list 우선, stocks.json fallback
function lookupStockMeta(code) {
  try {
    if (fs.existsSync(NAVER_LIST_PATH)) {
      const j = JSON.parse(fs.readFileSync(NAVER_LIST_PATH, "utf-8"));
      const hit = (j.stocks || []).find((s) => s.code === code);
      if (hit) return { name: hit.name, market: hit.market, marketCap: hit.marketValue || 0, isEtf: !!hit.isEtf, isSpecial: !!hit.isSpecial };
    }
  } catch (_) {}
  try {
    if (fs.existsSync(STOCKS_PATH)) {
      const j = JSON.parse(fs.readFileSync(STOCKS_PATH, "utf-8"));
      const hit = (j.stocks || []).find((s) => s.shortCode === code);
      if (hit) return { name: hit.name, market: hit.market, marketCap: 0, isEtf: false, isSpecial: false };
    }
  } catch (_) {}
  return null;
}

// 전체 일봉 차트 (TradingView 차트가 200D/1Y/ALL 토글을 지원하므로 전체 행 그대로 넘긴다)
function loadFullChart(code) {
  const fp = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return { name: c.name, market: c.market, rows: c.rows || [] };
  } catch (_) { return null; }
}

// 이 종목이 현재 들어있는 보드 funnel 정보
function lookupBoardMembership(code) {
  const result = {};
  // QVA Watchlist
  if (fs.existsSync(QVA_BOARD_JSON)) {
    try {
      const b = JSON.parse(fs.readFileSync(QVA_BOARD_JSON, "utf-8"));
      const stages = b.stages || {};
      for (const [stage, list] of Object.entries(stages)) {
        if (Array.isArray(list)) {
          const hit = list.find((it) => it.code === code);
          if (hit) {
            result.qva = result.qva || [];
            result.qva.push({ stage, daysSinceQva: hit.daysSinceQva, qvaSignalDate: hit.qvaSignalDate, breakoutDate: hit.breakoutDate });
          }
        }
      }
    } catch (_) {}
  }
  // D+5 재돌파 운용
  if (fs.existsSync(REBREAK_OPERATION_JSON)) {
    try {
      const r = JSON.parse(fs.readFileSync(REBREAK_OPERATION_JSON, "utf-8"));
      const hit = (r.items || []).find((it) => it.code === code);
      if (hit) result.rebreak = { rebreakStatus: hit.rebreakStatus, rebreakStatusLabel: hit.rebreakStatusLabel, daysFromBreakout: hit.daysFromBreakout, breakoutDate: hit.breakoutDate };
    } catch (_) {}
  }
  // 1DS 단타
  if (fs.existsSync(ONEDAY_SURGE_JSON)) {
    try {
      const o = JSON.parse(fs.readFileSync(ONEDAY_SURGE_JSON, "utf-8"));
      const groups = o.groups || {};
      for (const [g, list] of Object.entries(groups)) {
        if (Array.isArray(list)) {
          const hit = list.find((it) => it.code === code);
          if (hit) {
            result.oneDaySurge = {
              gtGroup: g, valueToMarketCapRatio: hit.valueToMarketCapRatio,
              dayChangeRate: hit.changeRate, candleType: hit.candleType,
              dailyValueRank: hit.dailyValueRank,
            };
            break;
          }
        }
      }
    } catch (_) {}
  }
  return result;
}

async function getStockDetail(req, res) {
  try {
    const code = String(req.params.code || "").replace(/[^0-9A-Za-z]/g, "");
    if (!code) return res.status(400).send("종목 코드 누락");

    const meta = lookupStockMeta(code);
    if (!meta) return res.status(404).send(`종목 ${code}을(를) 찾을 수 없습니다.`);

    const chart = loadFullChart(code);
    const memberships = lookupBoardMembership(code);

    // 외부 호출 병렬 — KIS 실시간 + DART 보통주식수/주주현황 (모두 실패해도 페이지는 나가야 함)
    const [kisLive, companyOverview, shareholders] = await Promise.all([
      (async () => {
        try {
          const _token = await getAccessToken();
          const _kis = await getCurrentPrice(_token, code);
          const _o = _kis && _kis.output;
          if (!_o) return null;
          return {
            price: Number(_o.stck_prpr) || null,
            prevClose: Number(_o.stck_sdpr) || null,
            changeRate: Number(_o.prdy_ctrt),
            changeAbs: Number(_o.prdy_vrss) || null,
            open: Number(_o.stck_oprc) || null,
            high: Number(_o.stck_hgpr) || null,
            low: Number(_o.stck_lwpr) || null,
            volume: Number(_o.acml_vol) || null,
            listedShares: Number(_o.lstn_stcn) || null,
            fetchedAt: new Date().toISOString(),
          };
        } catch (_) { return null; }
      })(),
      fetchCompanyOverview(code).catch(() => null),
      fetchShareholders(code).catch(() => null),
    ]);

    const sharesInfo = computeSharesInfo({ companyOverview, kisLive, shareholders });

    res.render("stock-detail", {
      code,
      meta,
      chartRows: (chart && chart.rows) || [],
      kisLive,
      memberships,
      sharesInfo,
      from: req.query.from || null,
    });
  } catch (e) {
    console.error("[stock-detail]", e);
    res.status(500).send("상세 페이지 렌더 오류: " + e.message);
  }
}

// 레거시 /?query=CODE 처리 — qva-watchlist-board.html이 아직 캐시된 사용자 위한 fallback
function getStockDetailByQuery(req, res, next) {
  const q = String(req.query.query || "").replace(/[^0-9A-Za-z]/g, "");
  if (!q) return next(); // query 없으면 다른 핸들러로 넘김
  return res.redirect("/stock/" + q + (req.query.from ? "?from=" + encodeURIComponent(String(req.query.from)) : ""));
}

module.exports = { getStockDetail, getStockDetailByQuery };
