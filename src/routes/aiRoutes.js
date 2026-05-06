const express = require("express");
const c = require("../controllers/aiController");

const router = express.Router();
router.post("/ai/comment", c.postComment);

module.exports = router;
