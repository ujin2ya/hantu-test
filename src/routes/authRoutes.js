const express = require("express");
const c = require("../controllers/authController");

const router = express.Router();
router.get("/login", c.getLogin);
router.post("/login", c.postLogin);

module.exports = router;
