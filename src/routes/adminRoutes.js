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
router.post("/admin/send-1ds-mail", requireAdmin, c.postSend1dsMailAll);
router.post("/admin/send-1ds-mail-one", requireAdmin, c.postSend1dsMailOne);
router.post("/admin/pattern/seed", requireAdmin, c.postPatternSeed);
router.post("/admin/pattern/analyze", requireAdmin, c.postPatternAnalyze);
router.post("/admin/backtest/qva", requireAdmin, c.postQvaBacktest);
router.post("/admin/refresh-pattern-cache", requireAdmin, c.postRefreshPatternCache);
router.post("/admin/refresh-watchlist-board", requireAdmin, c.postRefreshWatchlistBoard);
router.post("/admin/refresh-all-boards", requireAdmin, c.postRefreshAllBoards);
router.post("/admin/refresh-1ds-intraday", requireAdmin, c.postRefresh1dsIntraday);
router.post("/admin/refresh-1ds-survivor1000", requireAdmin, c.postRefresh1dsSurvivor1000);
router.post("/admin/regen-1ds-scanner-board", requireAdmin, c.postRegen1dsScannerBoard);
router.post("/admin/run-daily-update", requireAdmin, c.postRunDailyUpdate);

// QVA 장중 감시 보드 수동 새로고침 + 상태 polling.
// 의도적으로 requireAdmin 게이트 없음 — 보드 화면(/qva-live-watch, 사이트 비밀번호만 통과한 사용자)에서
// 보드를 보면서 바로 새로고침할 수 있어야 한다는 사용자 요구 (나스닥 테마 새로고침과 동일 정책).
// 중복 실행 가드는 patternState.refreshingQvaLiveWatch + refresh-qva-live-watch.js 자체 lockfile.
router.post("/admin/refresh-qva-live-watch", c.postRefreshQvaLiveWatch);
router.get("/admin/qva-live-watch-status",   c.getQvaLiveWatchStatus);

// 나스닥 테마 감시 수동 새로고침 + 상태 polling.
// POST: 06:30 cron과 동일한 시퀀스(fetch + watch 보드 + 1DS 감시 pool) 백그라운드 spawn.
// 의도적으로 requireAdmin 게이트 없음 — 보드 화면(/nasdaq-theme-watch, 사이트 비밀번호만 통과한 일반 사용자)에서도
// 새로고침할 수 있어야 한다는 사용자 요구. 중복 실행 가드는 patternState.refreshingNasdaqTheme로 처리.
router.post("/admin/refresh-nasdaq-theme", c.postRefreshNasdaqTheme);
router.get("/admin/nasdaq-theme-status",   c.getNasdaqThemeStatus);

// DB 신호 히스토리 조회 (JSON 응답)
router.get("/admin/db-signals",                       requireAdmin, c.getDbSignals);
// 3차 확장 (2026-05-17) — 운영 조회 API 6종
router.get("/admin/db-signals/overlap",               requireAdmin, c.getDbSignalsOverlap);
router.get("/admin/db-signals/repeated",              requireAdmin, c.getDbSignalsRepeated);
router.get("/admin/db-signals/stock/:stockCode/history", requireAdmin, c.getDbSignalsStockHistory);
router.get("/admin/db-signals/performance",           requireAdmin, c.getDbSignalsPerformance);
router.get("/admin/db-signals/link-summary",          requireAdmin, c.getDbSignalsLinkSummary);
router.get("/admin/db-signals/today-focus",           requireAdmin, c.getDbSignalsTodayFocus);

// 4차 (2026-05-17) — DB 신호 운영판 화면은 공개 라우트(/db-board)로 이전됨.
// 기존 /admin/db-board-dashboard URL은 redirect로 호환 유지 (admin gate도 거치지 않음).
router.get("/admin/db-board-dashboard", (req, res) => {
  const qs = req.url.split("?")[1];
  res.redirect("/db-board" + (qs ? "?" + qs : ""));
});

module.exports = router;
