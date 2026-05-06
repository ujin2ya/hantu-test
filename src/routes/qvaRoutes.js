const express = require("express");
const c = require("../controllers/qvaController");

const router = express.Router();
router.get("/qva-watchlist", c.getBoard);
router.get("/qva-watchlist-board", (req, res) => res.redirect("/qva-watchlist"));

module.exports = router;
