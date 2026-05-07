// 모든 라우터 모음. app.js에서 한 번에 mount한다.
const express = require("express");
const authRoutes = require("./authRoutes");
const adminRoutes = require("./adminRoutes");
const stockRoutes = require("./stockRoutes");
const qvaRoutes = require("./qvaRoutes");
const qvaVviRedefinedRoutes = require("./qvaVviRedefinedRoutes");
const rebreakRoutes = require("./rebreakRoutes");
const oneDaySurgeRoutes = require("./oneDaySurgeRoutes");
const aiRoutes = require("./aiRoutes");

const router = express.Router();
router.use(authRoutes);
router.use(adminRoutes);
// stockRoutes가 /?query=CODE 레거시 링크를 가로채기 위해 qvaRoutes(/) 보다 먼저 와야 한다.
router.use(stockRoutes);
router.use(qvaRoutes);
router.use(qvaVviRedefinedRoutes);
router.use(rebreakRoutes);
router.use(oneDaySurgeRoutes);
router.use(aiRoutes);

module.exports = router;
