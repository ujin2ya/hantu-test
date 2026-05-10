const express = require("express");
const c = require("../controllers/rebreakController");
const qvaVviRedefined = require("../controllers/qvaVviRedefinedController");

const router = express.Router();

// 운용 보드 — 짧은 alias /rebreak 권장
router.get("/hgroup-rebreak-operation", c.getOperationBoard);
router.get("/d5-rebreak-board", (req, res) => res.redirect("/hgroup-rebreak-operation"));
router.get("/rebreak", (req, res) => res.redirect("/hgroup-rebreak-operation"));

// 심층 검증 보고서 — 짧은 alias /rebreak-deep 권장
router.get("/hgroup-rebreak-deep-dive", c.getDeepDive);
router.get("/d5-rebreak-deep-dive", (req, res) => res.redirect("/hgroup-rebreak-deep-dive"));
router.get("/rebreak-deep", (req, res) => res.redirect("/hgroup-rebreak-deep-dive"));

// 수급 결합 백테스트 — spec 라우트 /d5-rebreak-flow
router.get("/d5-rebreak-flow", c.getFlowBacktest);
router.get("/rebreak-flow", (req, res) => res.redirect("/d5-rebreak-flow"));

// 종목 상세 — QVA2 고점돌파 상세 페이지(qvaVviRedefined)를 공유한다.
router.get("/d5-rebreak/:code",      qvaVviRedefined.getRedefinedVviStockDetail);
router.post("/d5-rebreak/:code/ai",  qvaVviRedefined.postCompanyAnalysis);

module.exports = router;
