// 모든 라우터 모음. app.js에서 한 번에 mount한다.
const express = require("express");
const authRoutes = require("./authRoutes");
const adminRoutes = require("./adminRoutes");
const stockRoutes = require("./stockRoutes");
const qvaRoutes = require("./qvaRoutes");
const qvaVviRedefinedRoutes = require("./qvaVviRedefinedRoutes");
const qva2Routes = require("./qva2Routes");
const rebreakRoutes = require("./rebreakRoutes");
const oneDaySurgeRoutes = require("./oneDaySurgeRoutes");
const themeRoutes = require("./themeRoutes");
const qvaLiveWatchRoutes = require("./qvaLiveWatchRoutes");
const aiRoutes = require("./aiRoutes");
const dbBoardRoutes = require("./dbBoardRoutes");

const router = express.Router();
router.use(authRoutes);
// dbBoardRoutes 는 adminRoutes 보다 먼저 mount — /admin/db-signals path 가 두 라우터에 모두
// 등록되어 있어서 (페이지 vs raw JSON API), dbBoardRoutes 가 먼저 검사한 뒤 query 가 있으면
// next() 로 adminRoutes 의 getDbSignals 로 위임한다.
router.use(dbBoardRoutes);
router.use(adminRoutes);
// stockRoutes가 /?query=CODE 레거시 링크를 가로채기 위해 qvaRoutes(/) 보다 먼저 와야 한다.
router.use(stockRoutes);
router.use(qvaRoutes);
router.use(qvaVviRedefinedRoutes);
router.use(qva2Routes);
router.use(rebreakRoutes);
router.use(oneDaySurgeRoutes);
router.use(themeRoutes);          // /nasdaq-theme-watch (실험 라인 — 전일 미국장 테마 기반 감시 후보)
router.use(qvaLiveWatchRoutes);   // /qva-live-watch  (실험 라인 — QVA 후보 장중 감시, 관찰용)
router.use(aiRoutes);

module.exports = router;
