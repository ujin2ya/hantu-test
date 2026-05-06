// D+5 재돌파 — 운용 보드 / 심층 검증 보고서 / 종목별 상세 페이지.
const fs = require("fs");
const path = require("path");
const { REPORTS_DIR, CHART_DIR } = require("../utils/paths");
const { getAccessToken } = require("../services/kis/kisToken");
const { getCurrentPrice } = require("../services/kis/kisApi");

const OPERATION_HTML = path.join(REPORTS_DIR, "hgroup-rebreak-operation-board-result.html");
const OPERATION_JSON = path.join(REPORTS_DIR, "hgroup-rebreak-operation-board-result.json");
const DEEP_DIVE_HTML = path.join(REPORTS_DIR, "hgroup-rebreak-deep-dive-result.html");

function getOperationBoard(req, res) {
  if (!fs.existsSync(OPERATION_HTML)) {
    return res.status(404).send("reports/hgroup-rebreak-operation-board-result.html 파일이 없습니다. `node hgroup-rebreak-operation-board.js`를 먼저 실행하세요.");
  }
  res.sendFile(OPERATION_HTML);
}

function getDeepDive(req, res) {
  if (!fs.existsSync(DEEP_DIVE_HTML)) {
    return res.status(404).send("reports/hgroup-rebreak-deep-dive-result.html 파일이 없습니다. `node hgroup-rebreak-deep-dive-report.js`를 먼저 실행하세요.");
  }
  res.sendFile(DEEP_DIVE_HTML);
}

// 종목별 상세 페이지: 보드 항목 + 차트 + KIS 실시간 가격
async function getDetail(req, res) {
  try {
    const code = String(req.params.code || "").replace(/[^0-9A-Za-z]/g, "");
    if (!code) return res.status(400).send("종목 코드 누락");

    if (!fs.existsSync(OPERATION_JSON)) {
      return res.status(404).send("reports/hgroup-rebreak-operation-board-result.json 없음. 먼저 `node hgroup-rebreak-operation-board.js`를 실행하세요.");
    }
    const rebData = JSON.parse(fs.readFileSync(OPERATION_JSON, "utf-8"));
    const item = (rebData.items || []).find((it) => it.code === code);
    if (!item) {
      return res.status(404).send(`종목 ${code}이(가) 재돌파 보드에 없습니다 (D+5 윈도우 만료 또는 H그룹 아님).`);
    }

    // 차트 데이터 (최근 60일)
    const chartPath = path.join(CHART_DIR, `${code}.json`);
    let chartRows = [];
    if (fs.existsSync(chartPath)) {
      try {
        const ch = JSON.parse(fs.readFileSync(chartPath, "utf-8"));
        chartRows = (ch.rows || []).slice(-60);
      } catch (_) {}
    }

    // KIS 실시간 가격
    let kisLive = null;
    try {
      const _token = await getAccessToken();
      const _kis = await getCurrentPrice(_token, code);
      const _o = _kis?.output;
      if (_o) {
        kisLive = {
          price: Number(_o.stck_prpr) || null,
          prevClose: Number(_o.stck_sdpr) || null,
          changeRate: Number(_o.prdy_ctrt),
          changeAbs: Number(_o.prdy_vrss) || null,
          open: Number(_o.stck_oprc) || null,
          high: Number(_o.stck_hgpr) || null,
          low: Number(_o.stck_lwpr) || null,
          volume: Number(_o.acml_vol) || null,
          fetchedAt: new Date().toISOString(),
        };
      }
    } catch (_) {}

    res.render("d5-rebreak-detail", {
      item, chartRows, kisLive,
      generatedAt: rebData.meta?.generatedAt,
      latestTradingDate: rebData.meta?.latestTradingDate,
    });
  } catch (e) {
    console.error("[d5-rebreak-detail]", e);
    res.status(500).send("상세 페이지 렌더 오류: " + e.message);
  }
}

module.exports = { getOperationBoard, getDeepDive, getDetail };
