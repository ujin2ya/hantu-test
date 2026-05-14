// /one-day-surge-board (라이브 보드) sendFile.
// /one-day-surge-board/backtest — 09:30 스캐너 백테스트 결과 리포트.
const fs = require("fs");
const path = require("path");
const { REPORTS_DIR } = require("../utils/paths");

const BOARD_HTML = path.join(REPORTS_DIR, "one-day-surge-board-result.html");
const BACKTEST_HTML = path.join(REPORTS_DIR, "one-day-surge-0930-scanner-backtest-result.html");

function getBoard(req, res) {
  if (!fs.existsSync(BOARD_HTML)) {
    return res.status(404).send("reports/one-day-surge-board-result.html 파일이 없습니다. `node one-day-surge-board.js`를 먼저 실행하세요.");
  }
  res.sendFile(BOARD_HTML);
}

function getBacktestReport(req, res) {
  if (!fs.existsSync(BACKTEST_HTML)) {
    return res.status(404).send("백테스트 리포트가 없습니다. `node boards/oneDaySurge/one-day-surge-0930-scanner-backtest.js`를 먼저 실행하세요.");
  }
  res.sendFile(BACKTEST_HTML);
}

module.exports = { getBoard, getBacktestReport };
