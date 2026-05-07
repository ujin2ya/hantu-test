const express = require("express");
const c = require("../controllers/adminController");
const { requireAdmin } = require("../services/auth/adminAuth");

const router = express.Router();

// /admin/login은 게이트 통과 전이므로 미들웨어 X
router.get("/admin/login", c.getLogin);
router.post("/admin/login", c.postLogin);
router.get("/admin/logout", c.getLogout);

// 이하 모든 관리자 라우트는 ADMIN_TOKEN 게이트 필요
router.get("/admin", requireAdmin, c.getDashboard);
router.post("/admin/unsubscribe", requireAdmin, c.postUnsubscribe);
router.post("/admin/send-pattern-mail", requireAdmin, c.postSendPatternMail);
router.post("/admin/pattern/seed", requireAdmin, c.postPatternSeed);
router.post("/admin/pattern/analyze", requireAdmin, c.postPatternAnalyze);
router.post("/admin/backtest/qva", requireAdmin, c.postQvaBacktest);
router.post("/admin/refresh-pattern-cache", requireAdmin, c.postRefreshPatternCache);
router.post("/admin/refresh-watchlist-board", requireAdmin, c.postRefreshWatchlistBoard);
router.post("/admin/refresh-all-boards", requireAdmin, c.postRefreshAllBoards);
router.post("/admin/run-daily-update", requireAdmin, c.postRunDailyUpdate);

module.exports = router;
