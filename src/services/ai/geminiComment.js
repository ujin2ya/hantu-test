// /ai/comment 엔드포인트 — D+5 재돌파 상세 페이지에서 lazy로 호출.
// snapshot(점수/가격/비율 등)을 받아 단타/스윙 관점 4섹션 코멘트를 생성한다.
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ─── 시장 컨텍스트 ───
function getMarketContext(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const totalMin = hour * 60 + minute;
  const openMin = 9 * 60;
  const closeMin = 15 * 60 + 30;
  const isWeekday = day >= 1 && day <= 5;

  if (!isWeekday) {
    return { phase: "weekend", horizon: "swing", label: "주말 / 휴장", breakoutMargin: 8,
      description: "다음 거래일을 위한 스윙 자리 점검 모드. 단타·돌파 추격은 자제하고 매물대 지지·이평선 위치를 우선 본다." };
  }
  if (totalMin < openMin) {
    return { phase: "pre_open", horizon: "swing", label: "장 시작 전 (당일)", breakoutMargin: 8,
      description: "갭 가능성과 전일 미국장 영향. 시가 직후 변동이 크니 9:30 이후 추적이 안전. 돌파 신호는 장중 재확인 권장." };
  }
  if (totalMin < closeMin) {
    return { phase: "intraday", horizon: "short", label: "장중", breakoutMargin: 3,
      description: "분봉 모멘텀 활용 가능. 빠른 진입/이탈로 단타 친화적 — 돌파 신호는 즉시 행동 가능." };
  }
  return { phase: "post_close", horizon: "swing", label: "장마감 후 (당일)", breakoutMargin: 8,
    description: "오늘 종가 + 전체 흐름 본 뒤 내일 자리 준비. 명확한 돌파가 아니면 눌림목 우선 — 다음날 갭 변동 감안." };
}

function pickAutoMode(now = new Date()) {
  return getMarketContext(now).horizon;
}

// ─── Gemini 클라이언트 (lazy) ───
let geminiClient = null;
function getGemini() {
  if (geminiClient) return geminiClient;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY가 서버에 설정되지 않았습니다.");
  geminiClient = new GoogleGenerativeAI(key);
  return geminiClient;
}

// ─── 프롬프트 ───
function buildAiPrompt(snapshot, mode) {
  const modeLabel = mode === "short" ? "단타 (분~시간 단위)" : "스윙 (수일~수주 단위)";
  return `
너는 한국 주식 시장 분석 보조 AI다. 아래는 한 종목의 정량 점수와 차트 요약이다.
전략은 ${modeLabel} 관점에서 해석한다.

[엄격한 규칙]
- 절대 새 숫자를 만들지 마라. 제공된 점수/가격/비율만 인용한다.
- 점수 합산이나 재계산을 시도하지 마라. 해석만 한다.
- 한국어로 답한다.
- 아래 4개 섹션을 정확히 그 제목과 순서로 출력한다. 다른 섹션·인사말·맺음말 금지.
- "강력 매수", "필승", "확정" 같은 단정적 표현 금지. "관심", "조건부", "관망" 등 톤 사용.

## 진입 시그널
${modeLabel} 관점에서 매수를 고려할 만한 근거를 점수와 차트 위치를 들어 2~4문장.

## 리스크 요인
약하거나 상충되는 신호를 2~4문장.

## 손절·관망 가이드
어느 가격대에서 손절하거나 관망 모드로 전환할지. 추천 매수 구간이 있다면 활용. 2~3문장.

## 한 줄 결론
한 문장.

[종목 데이터(JSON)]
${JSON.stringify(snapshot, null, 2)}
`.trim();
}

// ─── 인메모리 TTL 캐시 (10분) ───
const AI_CACHE_TTL_MS = 10 * 60 * 1000;
const aiCommentCache = new Map();

function getAiCache(key) {
  const hit = aiCommentCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    aiCommentCache.delete(key);
    return null;
  }
  return hit.value;
}

function setAiCache(key, value) {
  aiCommentCache.set(key, { value, expiresAt: Date.now() + AI_CACHE_TTL_MS });
}

// ─── 메인 ───
async function generateComment({ snapshot, mode }) {
  const cacheKey = `${snapshot.code || "_"}:${mode}`;
  const cached = getAiCache(cacheKey);
  if (cached) return { ...cached, cached: true };

  const prompt = buildAiPrompt(snapshot, mode);
  const client = getGemini();
  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const model = client.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const payload = { text, mode, model: modelName };
  setAiCache(cacheKey, payload);
  return payload;
}

module.exports = { generateComment, pickAutoMode, getMarketContext };
