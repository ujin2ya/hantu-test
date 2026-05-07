const express = require("express");
const c = require("../controllers/oneDaySurgeController");

const router = express.Router();

// 1차 일봉 기반 단타 관심 후보 보드 — reports/one-day-surge-board-result.html sendFile
router.get("/one-day-surge-board", c.getBoard);
router.get("/one-day-surge", (req, res) => res.redirect("/one-day-surge-board"));
router.get("/ods", (req, res) => res.redirect("/one-day-surge-board"));

// 다음날 검증 백테스트 보고서 — reports/one-day-surge-nextday-validation-result.html sendFile
router.get("/one-day-surge-validation", c.getValidation);
router.get("/ods-validation", (req, res) => res.redirect("/one-day-surge-validation"));

// 분봉 ENTRY_CONFIRM 연구 보고서 — reports/one-day-surge-entry-confirm-result.html sendFile
router.get("/one-day-surge-entry-confirm", c.getEntryConfirm);
router.get("/ods-entry-confirm", (req, res) => res.redirect("/one-day-surge-entry-confirm"));

// 날짜별 운영형 백테스트 보고서 — reports/one-day-surge-entry-daily-backtest-result.html sendFile
router.get("/one-day-surge-entry-daily-backtest", c.getEntryDailyBacktest);
router.get("/ods-entry-daily-backtest", (req, res) => res.redirect("/one-day-surge-entry-daily-backtest"));

module.exports = router;
