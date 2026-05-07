// /one-day-surge-board (라이브 보드) + /one-day-surge-validation (다음날 검증 백테스트).
// one-day-surge-board.js / one-day-surge-nextday-validation-report.js 가 reports/에 생성한 정적 HTML sendFile.
const fs = require("fs");
const path = require("path");
const { REPORTS_DIR } = require("../utils/paths");

const BOARD_HTML = path.join(REPORTS_DIR, "one-day-surge-board-result.html");
const VALIDATION_HTML = path.join(REPORTS_DIR, "one-day-surge-nextday-validation-result.html");
const ENTRY_CONFIRM_HTML = path.join(REPORTS_DIR, "one-day-surge-entry-confirm-result.html");

function getBoard(req, res) {
  if (!fs.existsSync(BOARD_HTML)) {
    return res.status(404).send("reports/one-day-surge-board-result.html 파일이 없습니다. `node one-day-surge-board.js`를 먼저 실행하세요.");
  }
  res.sendFile(BOARD_HTML);
}

function getValidation(req, res) {
  if (!fs.existsSync(VALIDATION_HTML)) {
    return res.status(404).send("reports/one-day-surge-nextday-validation-result.html 파일이 없습니다. `node one-day-surge-nextday-validation-report.js`를 먼저 실행하세요.");
  }
  res.sendFile(VALIDATION_HTML);
}

function getEntryConfirm(req, res) {
  if (!fs.existsSync(ENTRY_CONFIRM_HTML)) {
    return res.status(404).send("reports/one-day-surge-entry-confirm-result.html 파일이 없습니다. `node one-day-surge-entry-confirm-report.js`를 먼저 실행하세요.");
  }
  res.sendFile(ENTRY_CONFIRM_HTML);
}

module.exports = { getBoard, getValidation, getEntryConfirm };
