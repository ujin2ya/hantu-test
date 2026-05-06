const express = require("express");
const c = require("../controllers/qvaController");

const router = express.Router();
// 루트 진입 시 운영 보드(/qva-watchlist)로 리다이렉트 — bookmark 호환.
router.get("/", (req, res) => res.redirect("/qva-watchlist"));
router.get("/qva-watchlist", c.getBoard);
router.get("/qva-watchlist-board", (req, res) => res.redirect("/qva-watchlist"));

module.exports = router;
