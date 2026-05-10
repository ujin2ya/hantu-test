// /one-day-surge-board (라이브 보드) sendFile. 검증/연구 보고서는 모두 제거됨.
const fs = require("fs");
const path = require("path");
const { REPORTS_DIR } = require("../utils/paths");

const BOARD_HTML = path.join(REPORTS_DIR, "one-day-surge-board-result.html");

function getBoard(req, res) {
  if (!fs.existsSync(BOARD_HTML)) {
    return res.status(404).send("reports/one-day-surge-board-result.html 파일이 없습니다. `node one-day-surge-board.js`를 먼저 실행하세요.");
  }
  res.sendFile(BOARD_HTML);
}

module.exports = { getBoard };
