const express = require("express");
const c = require("../controllers/oneDaySurgeController");

const router = express.Router();

// 1차 일봉 기반 단타 관심 후보 보드 — reports/one-day-surge-board-result.html sendFile
router.get("/one-day-surge-board", c.getBoard);
router.get("/one-day-surge", (req, res) => res.redirect("/one-day-surge-board"));
router.get("/ods", (req, res) => res.redirect("/one-day-surge-board"));

module.exports = router;
