// 공개 라우트 — DB 신호 운영판 (4차 추가, 2026-05-17 공개 전환).
// requireAdmin 게이트 없음. site password 게이트는 유지 (서버 부트스트랩에서 적용됨).
// 단, raw JSON API (/admin/db-signals/*)는 admin 안에 유지 (스크래핑 방지).

const express = require("express");
const c = require("../controllers/adminController");

const router = express.Router();

// 공개 진입점
router.get("/db-board", c.getDbBoardDashboard);

module.exports = router;
