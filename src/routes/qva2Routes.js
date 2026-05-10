// QVA2 실험 라인 라우터. 살아있는 보드 3개 + 종목 상세만 유지.
const express = require("express");
const c = require("../controllers/qva2Controller");
const qvaVviRedefined = require("../controllers/qvaVviRedefinedController");

const router = express.Router();
router.get("/qva2-watchlist",  c.getWatchlistBoard);   // H그룹/VPR mirror
router.get("/qva2-d5-rebreak", c.getD5RebreakBoard);   // /rebreak mirror
router.get("/qva2-vvi",        c.getVviBoard);         // /qva-vvi-redefined-board mirror

// QVA2 종목 상세 — 기존 /qva-vvi-redefined/:code의 detail 페이지(차트·재무·뉴스·AI)를 재사용한다.
router.get("/qva2-vvi/:code",        qvaVviRedefined.getRedefinedVviStockDetail);
router.get("/qva2-watchlist/:code",  qvaVviRedefined.getRedefinedVviStockDetail);
router.get("/qva2-d5-rebreak/:code", qvaVviRedefined.getRedefinedVviStockDetail);
// AI lazy 호출도 동일 controller 재사용
router.post("/qva2-vvi/:code/ai",        qvaVviRedefined.postCompanyAnalysis);
router.post("/qva2-watchlist/:code/ai",  qvaVviRedefined.postCompanyAnalysis);
router.post("/qva2-d5-rebreak/:code/ai", qvaVviRedefined.postCompanyAnalysis);

module.exports = router;
