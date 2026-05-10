const express = require("express");
const c = require("../controllers/stockController");
const qvaVviRedefined = require("../controllers/qvaVviRedefinedController");

const router = express.Router();

// 보드에서 종목명을 클릭했을 때 떠오르는 종목 상세 페이지.
// 모든 보드의 상세 페이지는 QVA2 고점돌파(qvaVviRedefined.getRedefinedVviStockDetail) 페이지를 공유한다.
// 같은 EJS·차트·재무·뉴스·공시·AI 인프라를 한 군데에서 관리.
router.get("/stock/:code",       qvaVviRedefined.getRedefinedVviStockDetail);
router.post("/stock/:code/ai",   qvaVviRedefined.postCompanyAnalysis);

// 레거시 캐시된 보드의 /?query=CODE 링크 fallback — query 있으면 /stock/:code로 redirect, 없으면 다음 핸들러로.
// (qvaRoutes의 `/`보다 먼저 mount되어야 query를 가로챌 수 있다.)
router.get("/", c.getStockDetailByQuery);

module.exports = router;
