// QVA 장중 감시 보드 라우트.
// reports/qva-live-watch-board-result.html을 sendFile.
// 매수/진입 신호 보드 아님 — QVA 후보 중 오늘 강하게 움직이는 종목 관찰용.
// 종목 상세는 통일 EJS(qva-vvi-redefined-detail) 사용 — 다른 보드와 동일.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { REPORTS_DIR } = require("../utils/paths");
const qvaVviRedefined = require("../controllers/qvaVviRedefinedController");

const router = express.Router();
const BOARD_HTML = path.join(REPORTS_DIR, "qva-live-watch-board-result.html");

router.get("/qva-live-watch", (req, res) => {
  if (!fs.existsSync(BOARD_HTML)) {
    return res.status(404).send(
      "QVA 장중 감시 보드 결과 파일이 아직 생성되지 않았습니다. " +
      "`node boards/qva/qva-live-watch-board.js` 실행 후 다시 확인하세요."
    );
  }
  res.sendFile(BOARD_HTML);
});

// 종목 상세 (통일 페이지 공유) — /qva-live-watch/:code
router.get("/qva-live-watch/:code",     qvaVviRedefined.getRedefinedVviStockDetail);
router.post("/qva-live-watch/:code/ai", qvaVviRedefined.postCompanyAnalysis);

module.exports = router;
