// 모든 라우터 모음. app.js에서 한 번에 mount한다.
const express = require("express");
const authRoutes = require("./authRoutes");
const adminRoutes = require("./adminRoutes");
const qvaRoutes = require("./qvaRoutes");
const rebreakRoutes = require("./rebreakRoutes");
const oneDaySurgeRoutes = require("./oneDaySurgeRoutes");
const aiRoutes = require("./aiRoutes");

const router = express.Router();
router.use(authRoutes);
router.use(adminRoutes);
router.use(qvaRoutes);
router.use(rebreakRoutes);
router.use(oneDaySurgeRoutes);
router.use(aiRoutes);

module.exports = router;
