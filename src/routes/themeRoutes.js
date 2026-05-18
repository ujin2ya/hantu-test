// 나스닥 테마 → 오늘 지켜볼 후보 보드 라우트.
// 매수 신호 보드 아님 — 전일 미국장 강세 테마 기반 감시 후보.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { REPORTS_DIR } = require("../utils/paths");

const router = express.Router();
const BOARD_HTML = path.join(REPORTS_DIR, "nasdaq-theme-watch-board-result.html");

router.get("/nasdaq-theme-watch", (req, res) => {
  if (!fs.existsSync(BOARD_HTML)) {
    return res.status(404).send(
      "reports/nasdaq-theme-watch-board-result.html 파일이 없습니다. " +
      "`node boards/theme/nasdaq-theme-watch-board.js`를 먼저 실행하세요."
    );
  }
  res.sendFile(BOARD_HTML);
});

module.exports = router;
