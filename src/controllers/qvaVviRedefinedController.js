// /qva-vvi-redefined-board — 새 VVI 정의 (QVA 고가 + 거래량 + 거래대금 동시 재돌파) 전용 보드.
// qva-vvi-redefined-board.js 가 reports/에 생성한 정적 HTML sendFile.
const fs = require("fs");
const path = require("path");
const { REPORTS_DIR } = require("../utils/paths");

const BOARD_HTML    = path.join(REPORTS_DIR, "qva-vvi-redefined-board-result.html");
const BACKTEST_HTML = path.join(REPORTS_DIR, "qva-vvi-redefined-backtest-result.html");

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

module.exports = { getRedefinedVviBoard, getRedefinedVviBacktest };
