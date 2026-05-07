const express = require("express");
const c = require("../controllers/stockController");

const router = express.Router();

// 보드에서 종목명을 클릭했을 때 떠오르는 단순 종목 상세 페이지.
router.get("/stock/:code", c.getStockDetail);

// 레거시 캐시된 보드의 /?query=CODE 링크 fallback — query 있으면 /stock/:code로 redirect, 없으면 다음 핸들러로.
// (qvaRoutes의 `/`보다 먼저 mount되어야 query를 가로챌 수 있다.)
router.get("/", c.getStockDetailByQuery);

module.exports = router;
