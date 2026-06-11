// 공용 OpenAI(ChatGPT) 클라이언트. 사업내용 요약·코멘트 두 서비스가 공유한다.
// Gemini → OpenAI 전환 (2026-06-11): 프롬프트/후처리/캐시 로직은 각 서비스에 그대로 두고
// "프롬프트 → 텍스트" 생성부만 이 모듈로 단일화.
const OpenAI = require("openai");

const DEFAULT_MODEL = "gpt-4o"; // 유료 모델. OPENAI_MODEL 환경변수로 오버라이드.

let client = null;
function getOpenAI() {
  if (client) return client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY가 서버에 설정되지 않았습니다.");
  client = new OpenAI({ apiKey: key });
  return client;
}

// 단일 user 프롬프트로 텍스트 1건 생성. { text, model } 반환.
async function generateText(prompt, { model } = {}) {
  const modelName = model || process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const resp = await getOpenAI().chat.completions.create({
    model: modelName,
    messages: [{ role: "user", content: prompt }],
  });
  const text = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || "";
  return { text, model: modelName };
}

module.exports = { getOpenAI, generateText, DEFAULT_MODEL };
