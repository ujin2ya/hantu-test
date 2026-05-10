const express = require("express");
const c = require("../controllers/qvaVviRedefinedController");

const router = express.Router();

// 새 VVI 정의 보드 — qva-vvi-redefined-board.js 가 만든 HTML sendFile
router.get("/qva-vvi-redefined-board", c.getRedefinedVviBoard);

// 새 VVI 종목 상세 페이지 — 기본정보·재무·차트·뉴스·공시 + AI 버튼
router.get("/qva-vvi-redefined/:code", c.getRedefinedVviStockDetail);

// AI 기업분석 lazy 호출 — 상세 페이지의 버튼이 fetch로 호출
router.post("/qva-vvi-redefined/:code/ai", c.postCompanyAnalysis);

module.exports = router;
