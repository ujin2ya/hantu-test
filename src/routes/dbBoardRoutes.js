// 공개 라우트 — DB 신호 운영판 (4차 추가, 2026-05-17 공개 전환).
// requireAdmin 게이트 없음. site password 게이트는 유지 (서버 부트스트랩에서 적용됨).
//
// 10차 (2026-05-22): 검색 중심 운영판으로 단순화. /db-board 가 검색 화면을 직접 호출하므로
// 검색용 API(search/suggest/summary) 도 동일한 게이트 레벨(site password)로 노출.
// URL 네임스페이스는 spec 호환 위해 /admin/db-signals/* 유지.
// 그 외 raw JSON API들(overlap/repeated/today-focus 등)은 여전히 adminRoutes 의 requireAdmin 게이트 안.

const express = require("express");
const c = require("../controllers/adminController");

const router = express.Router();

// 11차 (2026-05-22) — 종목 신호 이력 검색 화면
// /admin/db-signals 가 새 메인 URL. /db-board 는 기존 호환을 위해 같은 컨트롤러를 렌더.
//
// /admin/db-signals 는 기존 raw JSON API(adminRoutes의 getDbSignals — stockCode/boardName/date/signalId
// 쿼리 기반)와 path 충돌. query 가 있으면 next() 로 위임해 기존 JSON API 동작 보존.
router.get("/admin/db-signals", (req, res, next) => {
  const q = req.query || {};
  if (q.stockCode || q.boardName || q.date || q.signalId) return next();
  return c.getDbBoardDashboard(req, res, next);
});
router.get("/db-board",         c.getDbBoardDashboard); // 호환 alias

// 검색 API (10차) — site password 게이트만
router.get("/admin/db-signals/search",                c.getDbSignalsSearch);
router.get("/admin/db-signals/suggest",               c.getDbSignalsSuggest);
router.get("/admin/db-signals/summary/:stockCode",    c.getDbSignalsSummary);

module.exports = router;
