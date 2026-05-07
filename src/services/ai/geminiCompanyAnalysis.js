// /qva-vvi-redefined/:code 페이지의 AI 분석 버튼이 호출하는 함수.
// 3개 섹션 (기업 분석 / 사업 내용 / 최근 이슈) 한 번에 생성.
// 입력: snapshot { code, name, market, marketCap, currentPrice, currentChangeRate, financials, disclosures, news, ... }
// 후처리: 회피 표현 정리 + 과다 출현 시 fallback.
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

function fmtMarketCap(won) {
  if (!won || won <= 0) return "-";
  const eok = won / 1e8;
  if (eok >= 10000) return (eok / 10000).toFixed(2) + "조";
  return Math.round(eok).toLocaleString() + "억";
}

function buildPrompt(snapshot) {
  // 헤더에 회사 기본정보 명시 — Gemini가 학습된 일반 지식과 결합해 분석할 수 있게.
  const headerLines = [
    `- 회사명: ${snapshot.name || "-"}`,
    `- 종목코드: ${snapshot.code || "-"}`,
    `- 시장: ${snapshot.market || "-"}`,
    `- 시가총액: ${fmtMarketCap(snapshot.marketCap)}`,
  ];
  if (snapshot.currentPrice != null) headerLines.push(`- 현재가: ${snapshot.currentPrice.toLocaleString()}원`);
  if (snapshot.currentChangeRate != null) headerLines.push(`- 등락률: ${snapshot.currentChangeRate.toFixed(2)}%`);

  return `
너는 한국 주식 상세종목 페이지에 들어가는 기업 리서치 요약 작성자다.

사용자는 이미 후보 보드에서 종목을 보고 들어왔다.
따라서 QVA/VVI, 차트, 수급, 후보 선정 이유는 설명하지 않는다.

너는 아래 세 섹션만 작성한다.

## 기업 분석
## 사업 내용
## 최근 이슈

작성 목표:
짧은 소개가 아니라, 사용자가 "이 회사가 뭘 하는 회사인지, 왜 시장에서 움직일 수 있는지, 최근 어떤 재료와 리스크가 있는지" 이해하게 해야 한다.

작성 규칙:
- 한국어로 쓴다.
- 초보자도 이해할 수 있게 쓰되, 내용은 구체적으로 쓴다.
- 각 섹션은 5~8문장 정도까지 허용한다.
- 핵심 정보가 많으면 bullet을 사용한다.
- 계열사, 그룹 소속, 대표 제품, 주요 고객, 전방산업, 최근 공시/뉴스/실적은 빠뜨리지 않는다.
- 호재와 악재를 모두 쓴다.
- 확인되지 않은 재료는 "가능성" 또는 "시장에서는 ~로 연결해 볼 수 있음"이라고 쓴다.
- 근거 없는 내용을 지어내지 않는다.
- 매수 추천, 매도 추천, 목표가, 투자 의견은 금지한다.
- "자료 부족", "확인 어렵다", "추가 정보 필요" 같은 변명 문장은 쓰지 않는다.
- 정보가 부족하면 "확인된 정보 기준으로는"이라고 짧게 쓰고 바로 설명한다.
- 회사명 자체로 알려진 사실(그룹 계열 관계, 업종, 대표 제품)은 학습된 지식에서 적극적으로 끌어와 작성한다.

특히 기업 분석에서는 아래를 최대한 확인해서 작성한다.
- 그룹 계열 여부 (대기업 그룹 계열사인지, 어느 그룹인지)
- 업종 (산업재/IT/바이오/반도체/2차전지 등)
- 시장 내 성격 (대형주/중형주/소형주, 경기민감/방어주/성장주)
- 시가총액 규모
- 연결 테마 (재난/지진/AI/방산/원전 등)

사업 내용에서는 아래를 최대한 확인해서 작성한다.
- 주요 제품
- 주요 서비스
- 고객군
- 전방산업 (건설/조선/반도체/공공기관/병원 등)
- 매출이 발생하는 구조
- 수요가 늘어나는 조건
- 사업상 약점 또는 변동성 요인

최근 이슈에서는 반드시 아래 세 그룹으로 나눠서 작성한다.
- 호재/재료: 뉴스·공시·실적·테마 중 주가에 긍정적으로 작용할 수 있는 항목
- 악재/부담: 실적 부진, 비용 부담, 규제, 희석 등 부정적으로 작용할 수 있는 항목
- 체크할 리스크: 일회성 재료 여부, 추세 지속 가능성, 추가 확인이 필요한 포인트

각 그룹은 1~3개 bullet로 정리하되, 각 항목은 "무엇이 / 왜 주가와 연결되는지" 한 문장으로 쓴다.

금지 표현 (절대 쓰지 마라):
- "정확한 산업 섹터를 알 수 없습니다"
- "공개 정보 부족"
- "추가 정보가 필요합니다"
- "제공된 자료에서 확인하기 어렵습니다"
- "핵심 비즈니스 모델을 파악하기 어렵습니다"

출력 형식 (반드시 이 형식 그대로):

## 기업 분석
내용

## 사업 내용
내용

## 최근 이슈
- 호재/재료:
  - 내용
- 악재/부담:
  - 내용
- 체크할 리스크:
  - 내용

[기본 정보]
${headerLines.join("\n")}

[종목 데이터 (JSON)]
${JSON.stringify({
  financials: snapshot.financials,
  disclosures: snapshot.disclosures,
  news: snapshot.news,
}, null, 2)}
`.trim();
}

// ── 후처리: 회피 표현 정리 + 과다 출현 시 fallback ──
const EVASION_PATTERNS = [
  /확인하기 어렵습니다/g,
  /파악하기 어렵습니다/g,
  /알 수 없습니다/g,
  /공개 정보 부족/g,
  /정보 부족/g,
  /추가 정보가? 필요합니다?/g,
  /제공된 자료에서 확인하기 어렵습니다/g,
  /정확한 산업 섹터/g,
];

function countEvasions(text) {
  let total = 0;
  for (const re of EVASION_PATTERNS) {
    const m = text.match(re);
    if (m) total += m.length;
  }
  return total;
}

function postProcess(text) {
  let out = String(text || "");
  // 회피 표현이 들어간 문장은 통째로 제거
  out = out.replace(
    /[^\n.]*?(확인하기 어렵습니다|파악하기 어렵습니다|알 수 없습니다|공개 정보 부족|정보 부족|추가 정보가? 필요합니다?|제공된 자료에서 확인하기 어렵습니다|정확한 산업 섹터)[^\n.]*[.\n]/g,
    ""
  );
  // 빈 줄 압축
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

const FALLBACK = `## 기업 분석
확인된 정보 기준으로 이 회사의 업종, 시장, 시가총액 규모, 그룹 계열 관계, 연결 테마를 정리합니다. 보드 카드에 표시된 시가총액과 시장 구분을 함께 참고해 규모와 성격을 판단할 수 있습니다.

## 사업 내용
확인된 제품/서비스와 전방산업, 주요 고객군을 중심으로 정리합니다. 매출 구조가 명확하지 않은 경우에는 알려진 사업 키워드 중심으로 짧게 설명합니다.

## 최근 이슈
- 호재/재료:
  - 최근 공시·뉴스에서 확인되는 호재성 재료를 정리합니다.
- 악재/부담:
  - 실적 부진, 규제, 비용 부담 등 부정적 항목을 정리합니다.
- 체크할 리스크:
  - 일회성 재료 여부, 추세 지속 가능성, 추가 확인이 필요한 포인트를 짧게 정리합니다.`;

async function generateCompanyAnalysis(snapshot) {
  const cacheKey = String(snapshot.code || "_");
  const hit = cache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) return { ...hit.value, cached: true };

  const prompt = buildPrompt(snapshot);
  const client = getGemini();
  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const model = client.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);
  const rawText = result.response.text();

  // 회피 표현 2건 이상이면 fallback 사용
  const evasionCount = countEvasions(rawText);
  let text, usedFallback = false;
  if (evasionCount >= 2) {
    text = FALLBACK;
    usedFallback = true;
  } else {
    text = postProcess(rawText);
  }

  const payload = { text, model: modelName, generatedAt: new Date().toISOString(), usedFallback, evasionCount };
  cache.set(cacheKey, { value: payload, expiresAt: Date.now() + TTL_MS });
  return payload;
}

module.exports = { generateCompanyAnalysis };
