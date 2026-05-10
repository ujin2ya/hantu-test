// D+5 재돌파 — 운용 보드 / 심층 검증 보고서. 종목별 상세 페이지(/d5-rebreak/:code)는
// qvaVviRedefined.getRedefinedVviStockDetail로 직접 매핑되어 모든 보드가 같은 상세 페이지를 공유한다.
const fs = require("fs");
const path = require("path");
const { REPORTS_DIR } = require("../utils/paths");

const OPERATION_HTML = path.join(REPORTS_DIR, "hgroup-rebreak-operation-board-result.html");
const DEEP_DIVE_HTML = path.join(REPORTS_DIR, "hgroup-rebreak-deep-dive-result.html");
const FLOW_HTML = path.join(REPORTS_DIR, "hgroup-rebreak-flow-result.html");

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

function getFlowBacktest(req, res) {
  if (!fs.existsSync(FLOW_HTML)) {
    return res.status(404).send("reports/hgroup-rebreak-flow-result.html 파일이 없습니다. `node hgroup-rebreak-flow-backtest.js`를 먼저 실행하세요.");
  }
  res.sendFile(FLOW_HTML);
}

module.exports = { getOperationBoard, getDeepDive, getFlowBacktest };
