// /qva-vvi-redefined/:code 페이지의 AI 분석 버튼이 호출하는 함수.
// 3개 섹션 (기업 분석 / 사업 내용 / 최근 이슈) 한 번에 생성.
// 입력: snapshot { code, name, market, marketCap, currentPrice, currentChangeRate, financials, disclosures, news, ... }
// 후처리: 회피 표현 정리 + 과다 출현 시 fallback.
// 2026-06-11: Gemini → OpenAI(ChatGPT) 전환. 생성부만 openaiClient로 교체, 나머지 로직 유지.
const { generateText } = require("./openaiClient");

const TTL_MS = 30 * 60 * 1000; // 30분 in-memory TTL — 같은 종목 다시 누르면 즉답
const cache = new Map();

function fmtMarketCap(won) {
  if (!won || won <= 0) return "-";
  const eok = won / 1e8;
  if (eok >= 10000) return (eok / 10000).toFixed(2) + "조";
  return Math.round(eok).toLocaleString() + "억";
}

function buildPrompt(snapshot) {
  // 사용자는 이미 상세페이지에서 기본정보·시세·재무·공시·뉴스 표를 보고 들어왔다.
  // AI는 표에 없는 것 (사업내용 텍스트 + 최근 이슈 정리 + 체크 포인트) 만 짧게 채운다.
  const headerLines = [
    `회사명: ${snapshot.name || "-"} (${snapshot.code || "-"}) · ${snapshot.market || "-"}`,
    `시가총액: ${fmtMarketCap(snapshot.marketCap)}`,
  ];
  if (snapshot.industry) {
    const ind = snapshot.industry;
    if (ind.lcls || ind.mcls || ind.scls) headerLines.push(`업종: ${[ind.lcls, ind.mcls, ind.scls].filter(Boolean).join(" › ")}`);
    if (ind.ksic) headerLines.push(`표준산업분류 (KSIC): ${ind.ksic}`);
  }
  if (snapshot.company) {
    const c = snapshot.company;
    const bits = [];
    if (c.ceoName) bits.push(`대표 ${c.ceoName}`);
    if (c.establishedDate) bits.push(`설립 ${c.establishedDate}`);
    if (c.corpNameEng) bits.push(`영문명 ${c.corpNameEng}`);
    if (bits.length) headerLines.push(`회사 정보: ${bits.join(" · ")}`);
  }
  // 최대주주 — AI가 그룹 계열사·지배구조 추론에 활용
  if (snapshot.shareholders && snapshot.shareholders.topShareholder) {
    const ts = snapshot.shareholders.topShareholder;
    headerLines.push(`최대주주: ${ts.name} (지분 ${ts.rateEnd != null ? Number(ts.rateEnd).toFixed(2) + "%" : "-"})`);
    if (snapshot.shareholders.totalRateEnd != null) {
      headerLines.push(`본인+특수관계인 합계 지분율: ${Number(snapshot.shareholders.totalRateEnd).toFixed(2)}%`);
    }
  }

  return `
너는 한국 주식 상세종목 페이지의 **"사업내용 요약"** 영역에 들어가는 짧은 정보 정리자다.

이 페이지에는 이미 다음이 표·리스트로 표시되어 있다 — **다시 풀어 쓰지 마라**:
- 기본정보 (대표이사·설립일·결산월·자본금·상장주식수·업종 분류·KSIC·주소·홈페이지)
- 시세현황 (현재가·등락·52주 고저·PER·PBR·EPS·BPS·외국인보유율 등)
- 기간 수익률 (1M/3M/6M/1Y)
- 재무 (매출·영익·순익 + YoY)
- 최근 공시 10건, 최근 뉴스 8건 (제목·날짜·요약 표시됨)

너는 표에 **없는** 것만 짧게 쓴다. 다음 세 섹션, 정확히 이 순서·제목으로 출력한다:

## 사업내용
회사가 실제로 무엇을 만들거나 어떤 서비스를 제공하는지 3~4문장.
주요 제품·고객·전방산업을 구체적인 이름으로.
업종 분류에 "기계·장비" 같은 큰 분류만 있으면, 회사명과 학습 지식으로 **구체적 제품군**까지 풀어 써라 (예: "콘크리트 펌프카·타워크레인·소방차" 식).

## 최근 이슈
제공된 disclosures(공시)·news(뉴스)를 읽고 호재/악재로 분류한다.
형식:
- 🟢 호재 (1~3개 bullet)
  * {공시/뉴스 제목 또는 키워드} — {왜 주가에 영향 줄 수 있는지 한 문장}
- 🔴 악재 (1~3개 bullet)
  * {공시/뉴스 제목 또는 키워드} — {왜 주가에 영향 줄 수 있는지 한 문장}

호재가 정말 없으면 "🟢 호재: 특별한 재료 없음", 악재가 없으면 "🔴 악재: 특별한 리스크 없음".

## 체크 포인트
1~3개 bullet — 단기 트레이딩 관점에서 추가 확인 필요한 포인트.
일회성 재료 여부 / 추세 지속 가능성 / 추가 검증 필요한 지표 등.

작성 규칙:
- 한국어, 간결하게. 표에 이미 있는 숫자(현재가·시총·PER 등)를 다시 풀어 쓰지 마라.
- 매수·매도 추천, 목표가 금지.
- "공개 정보 부족", "확인 어렵다", "추가 정보 필요" 같은 변명 표현 금지.
- 회사가 무슨 일을 하는지는 학습 지식으로 적극적으로 풀어 써라 (모른다고 도망가지 마라).
- 호재/악재는 반드시 제공된 공시·뉴스 근거로만. 없는 사실 추측 금지.

[종목 컨텍스트]
${headerLines.join("\n")}

[제공된 데이터 (JSON)]
${JSON.stringify({
  financialsSummary: snapshot.financials ? {
    year: snapshot.financials.latest && snapshot.financials.latest.bsnsYear,
    revenue: snapshot.financials.latest && snapshot.financials.latest.revenue,
    opIncome: snapshot.financials.latest && snapshot.financials.latest.opIncome,
    growth: snapshot.financials.growth,
  } : null,
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

const FALLBACK = `## 사업내용
위 표의 업종 분류와 회사명을 기준으로 이 회사의 주요 사업을 짧게 요약합니다. 구체적 제품군이 표에 충분히 드러나면 그 키워드 중심으로 정리합니다.

## 최근 이슈
- 🟢 호재: 위에 표시된 최근 공시·뉴스에서 호재성 재료가 보이면 정리합니다.
- 🔴 악재: 실적 부진·규제·비용 부담 등 부정 재료를 정리합니다.

## 체크 포인트
- 일회성 재료 여부, 추세 지속 가능성, 추가 검증 필요한 포인트를 짧게 정리합니다.`;

async function generateCompanyAnalysis(snapshot) {
  const cacheKey = String(snapshot.code || "_");
  const hit = cache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) return { ...hit.value, cached: true };

  const prompt = buildPrompt(snapshot);
  const { text: rawText, model: modelName } = await generateText(prompt);

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
