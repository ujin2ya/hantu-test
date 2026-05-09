// QVA2 실험 라인 — 기존 운영 보드 3개 (/qva-watchlist, /rebreak, /qva-vvi-redefined-board)의 QVA2 버전을 sendFile.
//   - /qva2-watchlist     → reports/qva2-watchlist-board.html (H그룹/VPR mirror)
//   - /qva2-d5-rebreak    → reports/qva2-d5-rebreak-board.html (/rebreak mirror)
//   - /qva2-vvi           → reports/qva2-vvi-board.html (/qva-vvi-redefined-board mirror)
//   - /qva2-validation    → reports/qva2-validation-result.html (자체 검증)
// 기존 컨트롤러는 건드리지 않는다.
const path = require("path");
const fs = require("fs");
const { REPORTS_DIR } = require("../utils/paths");

const QVA2_WATCHLIST_HTML  = path.join(REPORTS_DIR, "qva2-watchlist-board.html");
const QVA2_D5_REBREAK_HTML = path.join(REPORTS_DIR, "qva2-d5-rebreak-board.html");
const QVA2_VVI_HTML        = path.join(REPORTS_DIR, "qva2-vvi-board.html");
const QVA2_VAL_HTML        = path.join(REPORTS_DIR, "qva2-validation-result.html");

function notReady(res, fileName, generateCmd) {
  res.status(503).type("html").send(
    `<html><body style="font-family:sans-serif;padding:30px;background:#0f172a;color:#e2e8f0;">
      <h2>${fileName} 보고서가 아직 생성되지 않았습니다.</h2>
      <p>다음 명령으로 생성 후 새로고침하세요:</p>
      <pre style="background:#1e293b;padding:12px;border-radius:6px;">${generateCmd}</pre>
    </body></html>`,
  );
}

function getWatchlistBoard(req, res) {
  if (!fs.existsSync(QVA2_WATCHLIST_HTML)) return notReady(res, "qva2-watchlist-board", "node qva2-watchlist-board.js");
  res.sendFile(QVA2_WATCHLIST_HTML);
}

function getD5RebreakBoard(req, res) {
  if (!fs.existsSync(QVA2_D5_REBREAK_HTML)) return notReady(res, "qva2-d5-rebreak-board", "node qva2-watchlist-board.js && node qva2-d5-rebreak-board.js");
  res.sendFile(QVA2_D5_REBREAK_HTML);
}

function getVviBoard(req, res) {
  if (!fs.existsSync(QVA2_VVI_HTML)) return notReady(res, "qva2-vvi-board", "node qva2-watchlist-board.js && node qva2-vvi-board.js");
  res.sendFile(QVA2_VVI_HTML);
}

function getValidation(req, res) {
  if (!fs.existsSync(QVA2_VAL_HTML)) return notReady(res, "qva2-validation-result", "node qva2-validation-report.js");
  res.sendFile(QVA2_VAL_HTML);
}

module.exports = {
  getWatchlistBoard,
  getD5RebreakBoard,
  getVviBoard,
  getValidation,
};
