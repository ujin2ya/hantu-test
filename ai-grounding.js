// Gemini 그라운딩(Google 검색) 기반 AI 점수 보정 + 단일 추천 매수가 모듈.
//
// 입력: 종목 메타 + 베이스라인 점수 + (선택) 기술적 추천 매수가
// 출력: { bonus, reasoning, buyPriceRec: { price, stopLoss, confidence, rationale, context } }
//
// 캐시: 종목별 일 단위 (`cache/ai-grounding/<shortCode>.json`). schemaVersion 으로
// 스키마 변경 시 자동 무효화. 가드레일: 일일 한도 (디폴트 50).

const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const CACHE_DIR = path.join(__dirname, "cache", "ai-grounding");
const COUNTER_PATH = path.join(CACHE_DIR, "_daily.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간
const DEFAULT_DAILY_LIMIT = Number(process.env.AI_GROUNDING_DAILY_LIMIT) || 50;
const SCHEMA_VERSION = 3; // bonus + action recommendation

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function todayKST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function loadStockCache(shortCode) {
  try {
    const p = path.join(CACHE_DIR, `${shortCode}.json`);
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data.schemaVersion !== SCHEMA_VERSION) return null;
    if (data.date !== todayKST()) return null;
    if (Date.now() - new Date(data.calledAt).getTime() > CACHE_TTL_MS) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function saveStockCache(shortCode, payload) {
  try {
    ensureDir();
    fs.writeFileSync(
      path.join(CACHE_DIR, `${shortCode}.json`),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...payload }, null, 2)
    );
  } catch (e) {
    console.warn(`[ai-grounding] 캐시 저장 실패 (${shortCode}):`, e.message);
  }
}

function loadCounter() {
  try {
    const data = JSON.parse(fs.readFileSync(COUNTER_PATH, "utf-8"));
    if (data.date !== todayKST()) return { date: todayKST(), count: 0 };
    return data;
  } catch (_) {
    return { date: todayKST(), count: 0 };
  }
}

function bumpCounter() {
  ensureDir();
  const c = loadCounter();
  c.count += 1;
  fs.writeFileSync(COUNTER_PATH, JSON.stringify(c));
  return c;
}

function getModelName() {
  return process.env.GEMINI_GROUNDING_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function buildPrompt({ name, shortCode, currentPrice, changeRate, baselineScore, market, technicalBuyPrice, technicalStopLoss }) {
  const techLine = technicalBuyPrice
    ? `기술적 1차 매수가 후보: ${Math.round(technicalBuyPrice).toLocaleString()}원 (참고)`
    : "기술적 매수가 후보: 산출 안 됨";
  return [
    "한국 주식 종목 하나에 대해 Google 검색으로 *오늘~3거래일 내* 매수 액션 권고를 내려주세요.",
    "긴 호흡(분기 단위) 분석가 목표주가가 아니라 *지금 이 종목을 어떻게 다뤄야 하나* 를 핵심으로.",
    "",
    `종목명: ${name}`,
    `종목코드: ${shortCode}${market && market !== "-" ? ` (${market})` : ""}`,
    `현재가: ${currentPrice.toLocaleString()}원`,
    `당일 등락: ${changeRate}%`,
    `기술적 베이스라인 점수: ${baselineScore} / 100`,
    techLine,
    "",
    "검색해서 가능하면 다음을 확인:",
    "- 최근 1~2주 단기 모멘텀 (수급·체결·외인동향)",
    "- 단기 매수 추천 또는 경고 (증권사 단기 데일리 코멘트)",
    "- 최근 1개월 주요 뉴스/공시 (호재/악재)",
    "- 섹터 흐름 (반도체·2차전지·AI 등 — 오늘 강세/약세)",
    "- 종목명 동음이의어 주의 — 반드시 종목코드/사업영역 일치 확인",
    "",
    "출력 액션 권고 (action):",
    "- \"buy_now\": 지금 시가 또는 현재가 매수 가능. 단기 강한 모멘텀 + 호재.",
    "- \"wait_pullback\": 현재가에서 -1~-5% 가벼운 눌림 대기 후 매수. 추세 양호하나 추격 부담.",
    "- \"wait_deeper\": -5~-10% 깊은 조정 후 매수. 추세 약화 또는 단기 과열.",
    "- \"avoid\": 매수 비추 — 악재, 추세 깨짐, 섹터 구조적 약세.",
    "",
    "보정값 (bonus, -10~+10):",
    "- +5~+10: 강한 호재 (어닝 서프라이즈·대형 수주·정책 수혜·섹터 강세 명확)",
    "- +1~+5: 약한 호재 또는 시장 호의적 분위기",
    "- 0: 특이 정보 없음",
    "- -1~-5: 약한 악재 (소폭 부진·경쟁사 호조·노이즈)",
    "- -5~-10: 강한 악재 (어닝 쇼크·소송·핵심 이탈·섹터 구조적 악화)",
    "",
    "confidence:",
    "- high: 단기 코멘트 + 명확한 섹터 흐름 + 최근 실적 모두 확인",
    "- medium: 일부 정보만 확인",
    "- low: 정보 부족 또는 종목 특정 어려움",
    "",
    "출력은 정확히 다음 JSON 코드블록만:",
    "```json",
    `{
  "bonus": <정수 -10..+10>,
  "reasoning": "<bonus 근거 한 줄, 60자 이내>",
  "action": "buy_now" | "wait_pullback" | "wait_deeper" | "avoid",
  "actionDetail": "<액션 권고 근거 1~2문장, 200자 이내. 왜 지금/대기/회피인지>",
  "confidence": "low" | "medium" | "high",
  "context": {
    "shortTermComment": "<증권사 단기 코멘트 또는 시장 분위기 한 줄 또는 null>",
    "recentNews": "<주요 뉴스 한 줄 또는 null>",
    "sectorTrend": "<오늘 섹터 흐름 한 줄 또는 null>",
    "earnings": "<최근 실적 한 줄 또는 null>",
    "analystTarget": <정수 원 또는 null, 평균 목표주가 (참고용)>
  }
}`,
    "```",
    "검색 결과가 없거나 종목 특정이 어려우면: bonus=0, action=\"wait_pullback\", confidence=\"low\".",
  ].filter(Boolean).join("\n");
}

function parseResponse(text) {
  const m = text.match(/```json\s*(\{[\s\S]+?\})\s*```/) || text.match(/(\{[\s\S]*?"bonus"[\s\S]*?\})/);
  if (!m) return null;
  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch (_) {
    return null;
  }

  // bonus
  let bonus = Number(parsed.bonus);
  if (!Number.isFinite(bonus)) return null;
  bonus = Math.round(bonus);
  if (bonus < -10) bonus = -10;
  if (bonus > 10) bonus = 10;
  const reasoning = String(parsed.reasoning || "").slice(0, 200);

  // action — 알려진 값만 허용
  const validActions = ["buy_now", "wait_pullback", "wait_deeper", "avoid"];
  const action = validActions.includes(parsed.action) ? parsed.action : "wait_pullback";
  const actionDetail = String(parsed.actionDetail || "").slice(0, 400);
  const confidence = ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "low";

  const ctx = parsed.context || {};
  const cleanContext = {
    shortTermComment: ctx.shortTermComment ? String(ctx.shortTermComment).slice(0, 200) : null,
    recentNews: ctx.recentNews ? String(ctx.recentNews).slice(0, 200) : null,
    sectorTrend: ctx.sectorTrend ? String(ctx.sectorTrend).slice(0, 200) : null,
    earnings: ctx.earnings ? String(ctx.earnings).slice(0, 200) : null,
    analystTarget: Number.isFinite(Number(ctx.analystTarget)) ? Math.round(Number(ctx.analystTarget)) : null,
  };

  return {
    bonus,
    reasoning,
    action,
    actionDetail,
    confidence,
    context: cleanContext,
  };
}

async function callGroundingOnce(meta) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY 미설정");
  const client = new GoogleGenerativeAI(key);
  const modelName = getModelName();
  let model;
  try {
    model = client.getGenerativeModel({
      model: modelName,
      tools: [{ googleSearch: {} }],
    });
  } catch (_) {
    model = client.getGenerativeModel({
      model: modelName,
      tools: [{ googleSearchRetrieval: {} }],
    });
  }
  const prompt = buildPrompt(meta);
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  return { text, model: modelName };
}

async function getAiAdjustForStock(meta) {
  const cached = loadStockCache(meta.shortCode);
  if (cached) {
    return { ...cached, cached: true };
  }
  const counter = loadCounter();
  if (counter.count >= DEFAULT_DAILY_LIMIT) {
    return {
      bonus: 0,
      reasoning: `일일 한도 ${DEFAULT_DAILY_LIMIT}회 초과 — 보정 0`,
      action: "wait_pullback",
      actionDetail: "AI 일일 한도 초과로 액션 권고 없음.",
      confidence: "low",
      context: null,
      error: "daily_limit",
      date: todayKST(),
      calledAt: new Date().toISOString(),
    };
  }
  try {
    const { text, model } = await callGroundingOnce(meta);
    const parsed = parseResponse(text);
    if (!parsed) {
      return {
        bonus: 0,
        reasoning: "AI 응답 파싱 실패",
        action: "wait_pullback",
        actionDetail: "AI 응답 형식 오류 — 액션 권고 보류.",
        confidence: "low",
        context: null,
        error: "parse_failed",
        date: todayKST(),
        calledAt: new Date().toISOString(),
        rawText: text.slice(0, 300),
      };
    }
    bumpCounter();
    const payload = {
      bonus: parsed.bonus,
      reasoning: parsed.reasoning,
      action: parsed.action,
      actionDetail: parsed.actionDetail,
      confidence: parsed.confidence,
      context: parsed.context,
      model,
      date: todayKST(),
      calledAt: new Date().toISOString(),
    };
    saveStockCache(meta.shortCode, payload);
    return payload;
  } catch (e) {
    console.warn(`[ai-grounding] 호출 실패 (${meta.shortCode}):`, e.message);
    return {
      bonus: 0,
      reasoning: `AI 호출 실패: ${e.message?.slice(0, 80) || "unknown"}`,
      action: "wait_pullback",
      actionDetail: "AI 호출 실패로 액션 권고 없음.",
      confidence: "low",
      context: null,
      error: "api_failed",
      date: todayKST(),
      calledAt: new Date().toISOString(),
    };
  }
}

module.exports = {
  getAiAdjustForStock,
  loadDailyCounter: loadCounter,
};
