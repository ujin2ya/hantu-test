// Gemini 기반 가중치 추천 모듈 (스윙 + 단타)
//
// 스윙: 후보 가중치 6세트 × 상위 종목 N개로 12개월 백테스트 → 결과를 Gemini에 보내 추천 가중치 1세트 받음
// 단타: 분봉 historical 부재로 재백테스트 불가 → forward test 누적 통계만 Gemini에 전달, 신뢰도 라벨 부착

const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const CACHE_PATH = path.join(__dirname, "cache", "weight-tuner.json");

const SWING_PRESETS = [
  { name: "default",       label: "디폴트",     weights: { volume: 25, position: 17, trend: 8,  rsi: 5,  macd: 5,  resistance: 15, volatility: 10, flow: 15 } },
  { name: "trend",         label: "추세추종",   weights: { volume: 20, position: 10, trend: 18, rsi: 5,  macd: 12, resistance: 10, volatility: 5,  flow: 20 } },
  { name: "meanReversion", label: "역추세",     weights: { volume: 18, position: 25, trend: 5,  rsi: 15, macd: 5,  resistance: 12, volatility: 10, flow: 10 } },
  { name: "resistance",    label: "매물대중시", weights: { volume: 18, position: 17, trend: 8,  rsi: 5,  macd: 5,  resistance: 25, volatility: 12, flow: 10 } },
  { name: "volume",        label: "거래량추격", weights: { volume: 35, position: 13, trend: 7,  rsi: 3,  macd: 3,  resistance: 12, volatility: 7,  flow: 20 } },
  { name: "lowVol",        label: "변동성회피", weights: { volume: 15, position: 22, trend: 8,  rsi: 8,  macd: 5,  resistance: 15, volatility: 17, flow: 10 } },
];

const SWING_KEYS = ["volume", "position", "trend", "rsi", "macd", "resistance", "volatility", "flow"];
const SHORT_KEYS = ["chegyeol", "buySell", "momentum", "intraday", "changeBand"];

// 라이브 8개 가중치 (합 100) → 백테스트 8개 (합 66, flow=0). 나머지 34는 dryUp/squeeze/trendFollow 가 채움.
function mapLiveToBacktestWeights(live) {
  const exFlow =
    (live.volume || 0) + (live.position || 0) + (live.trend || 0) +
    (live.rsi || 0) + (live.macd || 0) + (live.resistance || 0) +
    (live.volatility || 0);
  if (exFlow <= 0) {
    return { volume: 18, position: 12, trend: 8, rsi: 5, macd: 5, resistance: 10, volatility: 8, flow: 0 };
  }
  const scale = 66 / exFlow;
  return {
    volume: live.volume * scale,
    position: live.position * scale,
    trend: live.trend * scale,
    rsi: live.rsi * scale,
    macd: live.macd * scale,
    resistance: live.resistance * scale,
    volatility: live.volatility * scale,
    flow: 0,
  };
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
  } catch (_) {
    return {};
  }
}

function saveCache(cache) {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("[weight-tuner] 캐시 저장 실패:", e.message);
  }
}

function getModelName() {
  return process.env.GEMINI_WEIGHT_TUNER_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
}

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY 미설정");
  const client = new GoogleGenerativeAI(key);
  const modelName = getModelName();
  const model = client.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);
  return { text: result.response.text(), model: modelName };
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function summarizeMarketRegime(scanCandidates) {
  if (!scanCandidates?.length) return null;
  const top = scanCandidates.slice(0, 30);
  const avgChange = top.reduce((a, c) => a + (c.changeRate || 0), 0) / top.length;
  const upCount = top.filter((c) => (c.changeRate || 0) > 0).length;
  const downCount = top.filter((c) => (c.changeRate || 0) < 0).length;
  let regime = "혼조";
  if (upCount > top.length * 0.7 && avgChange > 2) regime = "강세";
  else if (downCount > top.length * 0.6) regime = "약세";
  else if (Math.abs(avgChange) < 1.5) regime = "횡보";
  return {
    regime,
    avgChangePct: round1(avgChange),
    upCount,
    downCount,
    sampleSize: top.length,
  };
}

async function runSwingTuner({ runBacktest, loadScanCandidatesCache, stocksDataGetter, sampleSize = 8 }) {
  const cache = loadScanCandidatesCache();
  if (!cache?.candidates?.length) {
    return { ok: false, error: "scan-candidates 캐시 없음 (TTL 36시간)", runAt: new Date().toISOString() };
  }
  const sample = cache.candidates.slice(0, sampleSize);
  const marketRegime = summarizeMarketRegime(cache.candidates);
  const stocksData = stocksDataGetter ? stocksDataGetter() : null;

  const presetResults = [];
  for (const preset of SWING_PRESETS) {
    const stockResults = [];
    for (const c of sample) {
      const meta = stocksData?.byShortCode?.[c.shortCode] || {};
      try {
        const r = await runBacktest({
          stockMeta: { shortCode: c.shortCode, name: c.name, market: meta.market || "-" },
          monthsBack: 12,
          threshold: 60,
          horizons: [5, 10],
          weightsOverride: preset.weights,
        });
        const h5 = r.horizonResults.find((h) => h.horizon === 5);
        const h10 = r.horizonResults.find((h) => h.horizon === 10);
        stockResults.push({
          shortCode: c.shortCode,
          name: c.name,
          signals: r.signals.length,
          h5: h5 ? { n: h5.n, winRate: round1(h5.winRate), avgReturn: round1(h5.avgReturn), mdd: round1(h5.mdd), cum: round1(h5.cumulativeReturn) } : null,
          h10: h10 ? { n: h10.n, winRate: round1(h10.winRate), avgReturn: round1(h10.avgReturn), mdd: round1(h10.mdd), cum: round1(h10.cumulativeReturn) } : null,
        });
      } catch (e) {
        stockResults.push({ shortCode: c.shortCode, name: c.name, error: e.message });
      }
    }
    const valid = stockResults.filter((s) => !s.error && s.h10 && s.h10.n > 0);
    const avg = (h, key) => {
      const xs = stockResults.map((s) => s[h]?.[key]).filter((v) => Number.isFinite(v));
      return xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    };
    presetResults.push({
      name: preset.name,
      label: preset.label,
      weights: preset.weights,
      stockResults,
      aggregate: {
        validStocks: valid.length,
        h5AvgWinRate: avg("h5", "winRate"),
        h5AvgReturn:  avg("h5", "avgReturn"),
        h5AvgMdd:     avg("h5", "mdd"),
        h5AvgCum:     avg("h5", "cum"),
        h10AvgWinRate: avg("h10", "winRate"),
        h10AvgReturn:  avg("h10", "avgReturn"),
        h10AvgMdd:     avg("h10", "mdd"),
        h10AvgCum:     avg("h10", "cum"),
      },
    });
  }

  const prompt = buildSwingPrompt({ presetResults, marketRegime, sampleSize: sample.length });
  let recommendation;
  try {
    const { text, model } = await callGemini(prompt);
    recommendation = parseSwingRecommendation(text);
    recommendation.model = model;
    recommendation.rawText = text;
  } catch (e) {
    return {
      ok: false,
      error: `Gemini 호출 실패: ${e.message}`,
      runAt: new Date().toISOString(),
      sampleSize: sample.length,
      marketRegime,
      presets: presetResults,
    };
  }

  return {
    ok: true,
    runAt: new Date().toISOString(),
    sampleSize: sample.length,
    marketRegime,
    presets: presetResults,
    recommendation,
  };
}

function buildSwingPrompt({ presetResults, marketRegime, sampleSize }) {
  const tableRows = presetResults.map((p) => {
    const a = p.aggregate;
    const w = p.weights;
    return `${p.label.padEnd(8)} | vol${w.volume} pos${w.position} trd${w.trend} rsi${w.rsi} macd${w.macd} res${w.resistance} vlt${w.volatility} flw${w.flow} | h5:승률${a.h5AvgWinRate}% 수익${a.h5AvgReturn}% MDD${a.h5AvgMdd}% 누적${a.h5AvgCum}% | h10:승률${a.h10AvgWinRate}% 수익${a.h10AvgReturn}% MDD${a.h10AvgMdd}% 누적${a.h10AvgCum}%`;
  }).join("\n");
  const regimeText = marketRegime
    ? `시장 국면: ${marketRegime.regime} (상위 ${marketRegime.sampleSize}종목 평균 등락 ${marketRegime.avgChangePct}%, 상승 ${marketRegime.upCount} / 하락 ${marketRegime.downCount})`
    : "시장 국면 데이터 없음";

  return [
    "한국 주식 스윙 점수 모델의 가중치를 추천해주세요.",
    "",
    "가중치 항목 (8개, 합 정확히 100):",
    "- volume: 거래량 급등 (오늘 vs 20일 평균)",
    "- position: 가격대 위치 (저점일수록 가점)",
    "- trend: 추세 (5/20/60일 SMA 관계)",
    "- rsi: RSI(14)",
    "- macd: MACD(12,26,9)",
    "- resistance: 매물대 압력 (낮을수록 가점)",
    "- volatility: 변동성 안정성 (낮을수록 가점)",
    "- flow: 외국인/기관 수급",
    "",
    regimeText,
    "",
    `직전 12개월 백테스트 결과 (sample 종목 ${sampleSize}개, 임계점수 60, 가중치별 횡 비교):`,
    tableRows,
    "",
    "위 결과를 기반으로 다음을 출력해주세요:",
    "1. 추천 가중치 (8개 항목, 합 정확히 100)를 다음 JSON 코드블록 형식으로 출력. 정수만:",
    "```json",
    `{"volume":NN,"position":NN,"trend":NN,"rsi":NN,"macd":NN,"resistance":NN,"volatility":NN,"flow":NN}`,
    "```",
    "2. 추천 근거 2~3문장 (시장 국면과 백테스트 결과 모두 반영)",
    "",
    "주의: JSON은 반드시 코드블록 안에 넣고, 각 값은 0~50 범위 정수, 합 100. 8개 키 모두 포함.",
  ].join("\n");
}

function parseWeightsJson(text, keys) {
  const jsonMatch = text.match(/```json\s*(\{[\s\S]+?\})\s*```/);
  if (!jsonMatch) return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[1]);
  } catch (_) {
    return null;
  }
  if (!keys.every((k) => Number.isFinite(parsed[k]))) return null;
  let sum = keys.reduce((a, k) => a + parsed[k], 0);
  if (sum <= 0 || Math.abs(sum - 100) > 8) return null;
  // 합 100 정규화 — 마지막 키에 잔차 흡수
  const factor = 100 / sum;
  const out = {};
  let acc = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    out[keys[i]] = Math.round(parsed[keys[i]] * factor);
    acc += out[keys[i]];
  }
  out[keys[keys.length - 1]] = 100 - acc;
  // 음수 방어
  for (const k of keys) {
    if (out[k] < 0) return null;
  }
  return out;
}

function stripJsonBlocks(text) {
  return text.replace(/```json[\s\S]+?```/g, "").trim();
}

function parseSwingRecommendation(text) {
  return {
    weights: parseWeightsJson(text, SWING_KEYS),
    reasoning: stripJsonBlocks(text),
  };
}

async function runShortTuner({ getShortForwardStats }) {
  const stats = getShortForwardStats();
  if (!stats || !stats.totalDays) {
    return {
      ok: true,
      runAt: new Date().toISOString(),
      stats: null,
      recommendation: {
        weights: null,
        reasoning: "단타 forward test 데이터가 없습니다. 평일 9:05 cron으로 매일 누적됩니다.",
        confidence: "none",
        sampleNote: "표본 0일",
      },
    };
  }

  const prompt = buildShortPrompt(stats);
  let recommendation;
  try {
    const { text, model } = await callGemini(prompt);
    recommendation = parseShortRecommendation(text);
    recommendation.model = model;
    recommendation.rawText = text;
    recommendation.confidence =
      stats.totalDays >= 30 ? "medium" : (stats.totalDays >= 10 ? "low" : "very-low");
    recommendation.sampleNote = `forward test ${stats.totalDays}일 누적, 신뢰도 ${recommendation.confidence}`;
  } catch (e) {
    return {
      ok: false,
      error: `Gemini 호출 실패: ${e.message}`,
      runAt: new Date().toISOString(),
      stats,
    };
  }

  return {
    ok: true,
    runAt: new Date().toISOString(),
    stats,
    recommendation,
  };
}

function buildShortPrompt(stats) {
  const rows = [];
  for (const rank of [1, 2, 3, 4, 5]) {
    const byH = stats.byRank?.[rank] || {};
    const cells = ["p5", "p15", "p30", "p60"].map((h) => {
      const s = byH[h];
      return s
        ? `${h}: 승률${round1(s.winRate)}% 평균${round1(s.avgReturn)}% (n=${s.n})`
        : `${h}: -`;
    });
    rows.push(`#${rank}위 — ${cells.join(" / ")}`);
  }
  return [
    "한국 주식 단타 점수 모델의 가중치를 추천해주세요.",
    "",
    "현재 단타 가중치 (5개, 합 100, 하드코드):",
    "- chegyeol: 30 (체결강도 — 매수체결 우세도)",
    "- buySell: 20 (총매수/총매도 비율)",
    "- momentum: 20 (분봉 모멘텀)",
    "- intraday: 15 (장중 가격 위치 — 저점 선호)",
    "- changeBand: 15 (등락률 밴드)",
    "",
    `forward test 누적 통계 (${stats.totalDays}일, 매일 9:05 1~5위 시그널 기록 후 5/15/30/60분 추적):`,
    rows.join("\n"),
    "",
    "⚠ 중요: 단타는 historical 분봉 데이터가 없어 가중치를 바꿔 재백테스트할 수 없습니다.",
    "이 통계는 *현재 가중치*로 만든 1~5위 시그널의 N분 후 결과일 뿐이며,",
    "각 component별 효과 분리 측정은 불가합니다 — 전체 모델의 horizon 적합도만 확인 가능합니다.",
    "",
    "위 데이터를 기반으로:",
    "1. 추천 가중치 (5개 항목, 합 정확히 100)를 다음 JSON 코드블록으로 출력. 정수만:",
    "```json",
    `{"chegyeol":NN,"buySell":NN,"momentum":NN,"intraday":NN,"changeBand":NN}`,
    "```",
    "2. 추천 근거 2~3문장. 다음을 반영:",
    "   - 어느 horizon (p5/p15/p30/p60) 에서 모델이 잘 맞는가",
    "   - 표본이 작아 추천이 추측에 가깝다는 점 명시",
    "   - 데이터가 너무 빈약하면 '디폴트 유지'를 권장 가능",
    "",
    "주의: JSON은 반드시 코드블록 안, 각 값 0~60 범위 정수, 합 100, 5개 키 모두 포함.",
  ].join("\n");
}

function parseShortRecommendation(text) {
  return {
    weights: parseWeightsJson(text, SHORT_KEYS),
    reasoning: stripJsonBlocks(text),
  };
}

async function runWeightTuner(deps, { mode = "all" } = {}) {
  const cache = loadCache();
  const result = { startedAt: new Date().toISOString(), mode };
  if (mode === "swing" || mode === "all") {
    console.log("[weight-tuner] 스윙 튜너 시작…");
    const t0 = Date.now();
    try {
      result.swing = await runSwingTuner(deps);
      cache.swing = result.swing;
    } catch (e) {
      console.error("[weight-tuner] 스윙 튜너 예외:", e.message);
      result.swing = { ok: false, error: e.message, runAt: new Date().toISOString() };
      cache.swing = result.swing;
    }
    console.log(`[weight-tuner] 스윙 튜너 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s) — ok=${result.swing.ok}`);
  }
  if (mode === "short" || mode === "all") {
    console.log("[weight-tuner] 단타 튜너 시작…");
    const t0 = Date.now();
    try {
      result.short = await runShortTuner(deps);
      cache.short = result.short;
    } catch (e) {
      console.error("[weight-tuner] 단타 튜너 예외:", e.message);
      result.short = { ok: false, error: e.message, runAt: new Date().toISOString() };
      cache.short = result.short;
    }
    console.log(`[weight-tuner] 단타 튜너 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s) — ok=${result.short.ok}`);
  }
  result.finishedAt = new Date().toISOString();
  cache.lastResult = result;
  saveCache(cache);
  return result;
}

module.exports = {
  runWeightTuner,
  loadWeightTunerCache: loadCache,
  mapLiveToBacktestWeights,
  SWING_PRESETS,
  SWING_KEYS,
  SHORT_KEYS,
};
