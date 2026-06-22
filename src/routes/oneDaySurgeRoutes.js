const express = require("express");
const c = require("../controllers/oneDaySurgeController");
const qvaVviRedefined = require("../controllers/qvaVviRedefinedController");

const router = express.Router();

// 1차 일봉 기반 단타 관심 후보 보드 — reports/one-day-surge-board-result.html sendFile
router.get("/one-day-surge-board", c.getBoard);
router.get("/one-day-surge", (req, res) => res.redirect("/one-day-surge-board"));
router.get("/ods", (req, res) => res.redirect("/one-day-surge-board"));
// 09:30 스캐너 백테스트 결과 리포트 (보드 상단 배너에서 링크)
router.get("/one-day-surge-board/backtest", c.getBacktestReport);
router.get("/one-day-surge-board/explosive-backtest", c.getExplosiveBacktestReport);

// 1DS ver2 (복제 실험판) — reports/one-day-surge-v2-board-result.html sendFile
router.get("/one-day-surge-board-v2", c.getBoardV2);

// 클릭한 종목만 현재 진입 가능 여부 분석 (10시 생존 후보 모달용)
router.get("/api/one-day-surge/live-entry-check", c.getLiveEntryCheck);

// 1DS 종목 상세 — 기존 통일 상세 페이지(qvaVviRedefinedController.getRedefinedVviStockDetail) 재사용.
// 다른 보드들(/qva-vvi-redefined/:code, /qva2-*/:code, /d5-rebreak/:code, /stock/:code)과 동일 컨트롤러·EJS.
// 주의: /:code 라우트는 위의 literal 경로(/backtest, /explosive-backtest) 뒤에 등록해야 literal이 먼저 매칭됨.
router.get("/one-day-surge-board/:code",     qvaVviRedefined.getRedefinedVviStockDetail);
router.post("/one-day-surge-board/:code/ai", qvaVviRedefined.postCompanyAnalysis);
router.get("/one-day-surge/:code",           qvaVviRedefined.getRedefinedVviStockDetail);
router.post("/one-day-surge/:code/ai",       qvaVviRedefined.postCompanyAnalysis);
// 1DS ver2 종목 상세 — 동일 통일 상세 페이지 공유
router.get("/one-day-surge-board-v2/:code",     qvaVviRedefined.getRedefinedVviStockDetail);
router.post("/one-day-surge-board-v2/:code/ai", qvaVviRedefined.postCompanyAnalysis);

module.exports = router;
