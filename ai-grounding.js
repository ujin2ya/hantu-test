// Gemini 그라운딩(Google 검색) 기반 AI 점수 보정 모듈.
//
// 목적: 베이스라인(기술적 점수)에 *별도 컬럼*으로 ±10p 보정만 추가. 베이스라인 점수는 손대지 않음.
// 입력: 종목 메타 + 베이스라인 점수
// 출력: { bonus: -10..+10 정수, reasoning: 1줄, error?: 있으면 fallback }
//
// 캐시: 종목별 일 단위 (`cache/ai-grounding/<shortCode>.json`). 같은 날 여러 번 호출돼도 1회만 실제 API 콜.
// 가드레일: 일일 한도 (디폴트 30회). 한도 초과 시 bonus=0, "한도 초과" 라벨.

const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const CACHE_DIR = path.join(__dirname, "cache", "ai-grounding");
const COUNTER_PATH = path.join(CACHE_DIR, "_daily.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간
const DEFAULT_DAILY_LIMIT = Number(process.env.AI_GROUNDING_DAILY_LIMIT) || 30;

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function todayKST() {
  // YYYY-MM-DD KST
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function loadStockCache(shortCode) {
  try {
    const p = path.join(CACHE_DIR, `${shortCode}.json`);
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
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
      JSON.stringify(payload, null, 2)
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

function buildPrompt({ name, shortCode, currentPrice, changeRate, baselineScore, market }) {
  return [
    "한국 주식 종목 하나에 대해 Google 검색으로 최근 1개월 뉴스/공시/실적/섹터 동향을 확인하고,",
    "기술적 분석 베이스라인 점수에 정성 보정값(-10 ~ +10)을 제안해주세요.",
    "",
    `종목명: ${name}`,
    `종목코드: ${shortCode}${market && market !== "-" ? ` (${market})` : ""}`,
    `현재가: ${currentPrice}원`,
    `당일 등락: ${changeRate}%`,
    `기술적 베이스라인 점수: ${baselineScore} / 100`,
    "",
    "보정 가이드:",
    "- 강한 호재(어닝 서프라이즈, 대형 수주, 우호적 정책, 섹터 강세): +5 ~ +10",
    "- 약한 호재 또는 시장 호의적 분위기: +1 ~ +5",
    "- 특별한 뉴스 없음 또는 검색 결과 없음: 0",
    "- 약한 악재(소폭 부진, 경쟁사 호조, 노이즈성 부정): -1 ~ -5",
    "- 강한 악재(어닝 쇼크, 대형 소송/제재, 핵심 이탈, 섹터 구조적 악화): -5 ~ -10",
    "",
    "검색 시 고려:",
    "- 한국 시장 정시 뉴스(연합인포맥스, 머니투데이, 한국경제, 매일경제 등) 우선",
    "- 종목명 + 동음이의어 주의 (반드시 종목코드 또는 사업영역 일치 확인)",
    "- 1개월 이상 오래된 뉴스는 가중치 낮춤",
    "",
    "출력은 정확히 다음 JSON 코드블록만:",
    "```json",
    `{"bonus": <정수 -10..+10>, "reasoning": "<한 줄 핵심 근거, 50자 이내>"}`,
    "```",
    "검색 결과가 없거나 종목을 특정할 수 없으면 bonus=0, reasoning=\"특이 뉴스 없음\".",
  ].join("\n");
}

function parseResponse(text) {
  const m = text.match(/```json\s*(\{[\s\S]+?\})\s*```/) || text.match(/(\{[\s\S]*?"bonus"[\s\S]*?\})/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    let bonus = Number(parsed.bonus);
    if (!Number.isFinite(bonus)) return null;
    bonus = Math.round(bonus);
    if (bonus < -10) bonus = -10;
    if (bonus > 10) bonus = 10;
    const reasoning = String(parsed.reasoning || "").slice(0, 100);
    return { bonus, reasoning };
  } catch (_) {
    return null;
  }
}

async function callGroundingOnce(meta) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY 미설정");
  const client = new GoogleGenerativeAI(key);
  const modelName = getModelName();
  // gemini-2.x → googleSearch, 1.5 → googleSearchRetrieval. 둘 다 시도.
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
        error: "parse_failed",
        date: todayKST(),
        calledAt: new Date().toISOString(),
        rawText: text.slice(0, 200),
      };
    }
    bumpCounter();
    const payload = {
      bonus: parsed.bonus,
      reasoning: parsed.reasoning,
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
      error: "api_failed",
      date: todayKST(),
      calledAt: new Date().toISOString(),
    };
  }
}

// 스캔 결과의 상위 N개에 aiAdjust 필드를 부착. 베이스라인 점수는 손대지 않음.
async function applyAiAdjustToTopN(results, n = 5) {
  if (!Array.isArray(results) || !results.length) return { applied: 0 };
  const top = results.filter((r) => !r.error).slice(0, n);
  let applied = 0;
  for (const r of top) {
    const baseline =
      r.scoreModel?.totalScore ??
      r.nightlyExtras?.nightlyTotal ??
      r.score?.totalScore ??
      0;
    const adj = await getAiAdjustForStock({
      shortCode: r.shortCode,
      name: r.name,
      currentPrice: r.currentPrice,
      changeRate: r.changeRate ?? r.currentData?.changeRate ?? 0,
      baselineScore: Math.round(baseline),
      market: r.market,
    });
    r.aiAdjust = adj;
    applied++;
  }
  return { applied, dailyCounter: loadCounter() };
}

module.exports = {
  applyAiAdjustToTopN,
  getAiAdjustForStock,
  loadDailyCounter: loadCounter,
};
