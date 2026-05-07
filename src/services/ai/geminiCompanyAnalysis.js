// /qva-vvi-redefined/:code 페이지의 AI 분석 버튼이 호출하는 함수.
// 3개 섹션 (기업 분석 / 사업 내용 / 최근 이슈) 한 번에 생성.
// 입력: snapshot { code, name, market, marketCap, financials, disclosures, news, currentClose, ... }
const { GoogleGenerativeAI } = require("@google/generative-ai");

const TTL_MS = 30 * 60 * 1000; // 30분 in-memory TTL — 같은 종목 다시 누르면 즉답
const cache = new Map();

let geminiClient = null;
function getGemini() {
  if (geminiClient) return geminiClient;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY가 서버에 설정되지 않았습니다.");
  geminiClient = new GoogleGenerativeAI(key);
  return geminiClient;
}

function buildPrompt(snapshot) {
  return `
너는 한국 주식 투자자에게 종목 정보를 정리해주는 보조 AI다.
아래 종목에 대해 다음 3개 섹션을 정확히 그 제목과 순서로 출력한다.
다른 섹션, 인사말, 맺음말, 표는 만들지 마라. 한국어로 답한다.

[엄격한 규칙]
- 모르는 사실은 추측 대신 "공개 정보 부족"이라고 명시한다.
- "필승", "강력 매수", "확정" 같은 단정적 매매 권유 금지. 정보 정리에 집중한다.
- 각 섹션은 4~6문장. 너무 짧지도 길지도 않게.
- 제공된 financials / disclosures / news 외의 새 숫자를 만들지 마라.

## 기업 분석
종목명, 시장(KOSPI/KOSDAQ), 시가총액 규모(대형/중형/소형/소형마이크로), 산업 섹터, 핵심 비즈니스 모델 요약.

## 사업 내용
이 회사의 주요 사업 부문, 제품/서비스, 매출 구성, 주요 고객·시장. 구체적으로.

## 최근 이슈
제공된 최근 공시·뉴스를 근거로 최근 1~3개월 내 주요 이슈 정리. 실적, 신사업/계약, 인사, 규제, M&A 등. 공시·뉴스에서 확인되지 않는 추측은 하지 말 것.

[종목 데이터 (JSON)]
${JSON.stringify(snapshot, null, 2)}
`.trim();
}

async function generateCompanyAnalysis(snapshot) {
  const cacheKey = String(snapshot.code || "_");
  const hit = cache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) return { ...hit.value, cached: true };

  const prompt = buildPrompt(snapshot);
  const client = getGemini();
  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const model = client.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const payload = { text, model: modelName, generatedAt: new Date().toISOString() };
  cache.set(cacheKey, { value: payload, expiresAt: Date.now() + TTL_MS });
  return payload;
}

module.exports = { generateCompanyAnalysis };
