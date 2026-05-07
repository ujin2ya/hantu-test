const express = require("express");
const c = require("../controllers/qvaVviRedefinedController");

const router = express.Router();

// 새 VVI 정의 보드 — qva-vvi-redefined-board.js 가 만든 HTML sendFile
router.get("/qva-vvi-redefined-board", c.getRedefinedVviBoard);

// 새 VVI 정의 1차 백테스트 — qva-vvi-redefined-backtest-report.js 가 만든 HTML sendFile
router.get("/qva-vvi-redefined-backtest", c.getRedefinedVviBacktest);

module.exports = router;
