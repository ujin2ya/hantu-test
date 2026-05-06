// /qva-watchlist — H그룹/VPR 운영 보드. qva-watchlist-board.js가 ROOT에 생성한 정적 HTML 서빙.
const fs = require("fs");
const path = require("path");
const { ROOT } = require("../utils/paths");

const BOARD_HTML = path.join(ROOT, "qva-watchlist-board.html");

function getBoard(req, res) {
  if (!fs.existsSync(BOARD_HTML)) {
    return res.status(404).send("qva-watchlist-board.html 파일이 없습니다. `node qva-watchlist-board.js`를 먼저 실행하세요.");
  }
  res.sendFile(BOARD_HTML);
}

module.exports = { getBoard };
