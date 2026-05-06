const express = require("express");
const c = require("../controllers/rebreakController");

const router = express.Router();

// 운용 보드 — 짧은 alias /rebreak 권장
router.get("/hgroup-rebreak-operation", c.getOperationBoard);
router.get("/d5-rebreak-board", (req, res) => res.redirect("/hgroup-rebreak-operation"));
router.get("/rebreak", (req, res) => res.redirect("/hgroup-rebreak-operation"));

// 심층 검증 보고서 — 짧은 alias /rebreak-deep 권장
router.get("/hgroup-rebreak-deep-dive", c.getDeepDive);
router.get("/d5-rebreak-deep-dive", (req, res) => res.redirect("/hgroup-rebreak-deep-dive"));
router.get("/rebreak-deep", (req, res) => res.redirect("/hgroup-rebreak-deep-dive"));

// 종목 상세 — KIS 실시간 가격 + 차트 + AI lazy 호출
router.get("/d5-rebreak/:code", c.getDetail);

module.exports = router;
