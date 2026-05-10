// D+5 재돌파 — 운용 보드 sendFile. 종목별 상세 페이지(/d5-rebreak/:code)는
// qvaVviRedefined.getRedefinedVviStockDetail로 직접 매핑되어 모든 보드가 같은 상세 페이지를 공유한다.
const fs = require("fs");
const path = require("path");
const { REPORTS_DIR } = require("../utils/paths");

const OPERATION_HTML = path.join(REPORTS_DIR, "hgroup-rebreak-operation-board-result.html");

function getOperationBoard(req, res) {
  if (!fs.existsSync(OPERATION_HTML)) {
    return res.status(404).send("reports/hgroup-rebreak-operation-board-result.html 파일이 없습니다. `node hgroup-rebreak-operation-board.js`를 먼저 실행하세요.");
  }
  res.sendFile(OPERATION_HTML);
}

module.exports = { getOperationBoard };
