// /ai/comment — D+5 재돌파 상세 페이지에서 lazy 호출.
const { generateComment } = require("../services/ai/geminiComment");

async function postComment(req, res) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: "OPENAI_API_KEY가 서버에 설정되지 않았습니다." });
    }
    const mode = req.body.mode === "short" ? "short" : "swing";
    const snapshot = req.body.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      return res.status(400).json({ error: "snapshot 데이터가 없습니다." });
    }
    const payload = await generateComment({ snapshot, mode });
    res.json(payload);
  } catch (err) {
    console.error("[AI] error:", err.message || err);
    res.status(500).json({ error: err.message || "AI 호출 실패" });
  }
}

module.exports = { postComment };
