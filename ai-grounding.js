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
const SCHEMA_VERSION = 2; // bonus + buyPriceRec

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
    ? `기술적 추천 매수가: ${Math.round(technicalBuyPrice).toLocaleString()}원 (참고)`
    : "기술적 추천 매수가: 산출 안 됨";
  const stopLine = technicalStopLoss
    ? `기술적 손절선: ${Math.round(technicalStopLoss).toLocaleString()}원 (참고)`
    : "";
  return [
    "한국 주식 종목 하나에 대해 Google 검색으로 최근 1~3개월 뉴스/공시/실적/섹터 동향을 확인하고",
    "두 가지를 출력해주세요:",
    "(1) 기술적 베이스라인 점수에 정성 보정값(-10~+10)",
    "(2) 단일 추천 매수가와 손절선 + 근거",
    "",
    `종목명: ${name}`,
    `종목코드: ${shortCode}${market && market !== "-" ? ` (${market})` : ""}`,
    `현재가: ${currentPrice.toLocaleString()}원`,
    `당일 등락: ${changeRate}%`,
    `기술적 베이스라인 점수: ${baselineScore} / 100`,
    techLine,
    stopLine,
    "",
    "검색해서 가능하면 다음을 확인:",
    "- 최근 분석가 목표주가 (증권사 컨센서스)",
    "- 최근 실적 (어닝 서프라이즈/쇼크)",
    "- 최근 1개월 주요 뉴스/공시 (악재/호재)",
    "- 섹터 흐름 (반도체·2차전지·바이오 등 산업별 모멘텀)",
    "- 종목명 동음이의어 주의 — 반드시 종목코드/사업영역 일치 확인",
    "",
    "보정 가이드 (bonus):",
    "- 강한 호재(어닝 서프라이즈, 대형 수주, 우호적 정책, 섹터 강세): +5~+10",
    "- 약한 호재 또는 시장 호의적 분위기: +1~+5",
    "- 특이 뉴스 없음: 0",
    "- 약한 악재(소폭 부진, 경쟁사 호조): -1~-5",
    "- 강한 악재(어닝 쇼크, 대형 소송/제재, 섹터 구조적 악화): -5~-10",
    "",
    "매수가 가이드:",
    "- 기술적 추천 매수가가 있으면 그것을 *기준선*으로 삼고 ±10% 안에서 조정. 절대 그 범위 밖으로 벗어나지 말 것.",
    "- 강한 호재면 기준선보다 약간 높여도 OK (이미 시장이 반영하고 있어서). 강한 악재면 더 낮춤.",
    "- 손절선은 매수가 대비 -2~-5% 안. 보통 ATR 또는 직전 지지선 기반.",
    "- 정보가 부족하면 기준선 그대로 사용 + confidence='low'.",
    "",
    "confidence 가이드:",
    "- high: 분석가 컨센서스 + 최근 실적 + 명확한 섹터 흐름 모두 확인됨",
    "- medium: 일부 정보 확인됨 (예: 뉴스만 또는 컨센서스만)",
    "- low: 정보 거의 없음 또는 종목 특정 어려움 → 기술적 가격 그대로 사용 권장",
    "",
    "출력은 정확히 다음 JSON 코드블록만:",
    "```json",
    `{
  "bonus": <정수 -10..+10>,
  "reasoning": "<bonus 근거 한 줄, 60자 이내>",
  "buyPriceRec": {
    "price": <정수 원, 매수가>,
    "stopLoss": <정수 원, 손절선 (price 보다 작아야 함)>,
    "confidence": "low" | "medium" | "high",
    "rationale": "<매수가 근거 1~2문장, 200자 이내>",
    "context": {
      "analystTarget": <정수 원 또는 null, 분석가 목표주가>,
      "recentNews": "<주요 뉴스 한 줄 또는 null>",
      "sectorTrend": "<섹터 흐름 한 줄 또는 null>",
      "earnings": "<최근 실적 한 줄 또는 null>"
    }
  }
}`,
    "```",
    "검색 결과가 없거나 종목 특정이 어려우면: bonus=0, reasoning=\"특이 정보 없음\", price=기술적 매수가 그대로, confidence=\"low\".",
  ].filter(Boolean).join("\n");
}

function parseResponse(text, anchor) {
  const m = text.match(/```json\s*(\{[\s\S]+?\})\s*```/) || text.match(/(\{[\s\S]*?"bonus"[\s\S]*?\})/);
  if (!m) return null;
  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch (_) {
    return null;
  }

  // bonus 파싱
  let bonus = Number(parsed.bonus);
  if (!Number.isFinite(bonus)) return null;
  bonus = Math.round(bonus);
  if (bonus < -10) bonus = -10;
  if (bonus > 10) bonus = 10;

  const reasoning = String(parsed.reasoning || "").slice(0, 200);

  // buyPriceRec 파싱 + 클램프
  let buyPriceRec = null;
  const rec = parsed.buyPriceRec;
  if (rec && Number.isFinite(Number(rec.price))) {
    let price = Math.round(Number(rec.price));
    let stopLoss = Number.isFinite(Number(rec.stopLoss)) ? Math.round(Number(rec.stopLoss)) : null;
    let clamped = false;

    // 안전 장치: 기술적 매수가 ±10% 밖이면 강제 클램프
    if (anchor && anchor.technicalBuyPrice) {
      const lo = Math.round(anchor.technicalBuyPrice * 0.90);
      const hi = Math.round(anchor.technicalBuyPrice * 1.10);
      if (price < lo) { price = lo; clamped = true; }
      if (price > hi) { price = hi; clamped = true; }
    }
    // 추가 안전 장치: 현재가 ±20% 밖이면 무시 (할루시네이션)
    if (anchor && anchor.currentPrice) {
      const absLo = Math.round(anchor.currentPrice * 0.80);
      const absHi = Math.round(anchor.currentPrice * 1.20);
      if (price < absLo || price > absHi) {
        // 절대 범위 벗어나면 anchor 값으로 폴백
        price = anchor.technicalBuyPrice ? Math.round(anchor.technicalBuyPrice) : Math.round(anchor.currentPrice);
        clamped = true;
      }
    }
    // 손절선: 매수가 대비 -2~-8% 안에서만 허용
    if (stopLoss === null || stopLoss >= price) {
      stopLoss = Math.round(price * 0.97);
    } else if (stopLoss < price * 0.92) {
      stopLoss = Math.round(price * 0.92);
    }

    const confidence = ["low", "medium", "high"].includes(rec.confidence) ? rec.confidence : "low";
    const rationale = String(rec.rationale || "").slice(0, 400);

    const ctx = rec.context || {};
    const cleanContext = {
      analystTarget: Number.isFinite(Number(ctx.analystTarget)) ? Math.round(Number(ctx.analystTarget)) : null,
      recentNews: ctx.recentNews ? String(ctx.recentNews).slice(0, 200) : null,
      sectorTrend: ctx.sectorTrend ? String(ctx.sectorTrend).slice(0, 200) : null,
      earnings: ctx.earnings ? String(ctx.earnings).slice(0, 200) : null,
    };

    buyPriceRec = {
      price,
      stopLoss,
      confidence,
      rationale,
      context: cleanContext,
      clamped,
    };
  }

  return { bonus, reasoning, buyPriceRec };
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
      buyPriceRec: null,
      error: "daily_limit",
      date: todayKST(),
      calledAt: new Date().toISOString(),
    };
  }
  try {
    const { text, model } = await callGroundingOnce(meta);
    const parsed = parseResponse(text, {
      technicalBuyPrice: meta.technicalBuyPrice,
      currentPrice: meta.currentPrice,
    });
    if (!parsed) {
      return {
        bonus: 0,
        reasoning: "AI 응답 파싱 실패",
        buyPriceRec: null,
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
      buyPriceRec: parsed.buyPriceRec,
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
      buyPriceRec: null,
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
