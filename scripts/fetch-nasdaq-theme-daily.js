#!/usr/bin/env node
/**
 * 나스닥 테마 강도 자동 계산 — FMP batch quote API
 *
 * 목표:
 *   data/theme/nasdaq-theme-map.json의 각 테마별 nasdaqTickers 바스켓의 전일 등락률을
 *   FMP API로 한 번에 조회 → 테마별 STRONG/MID/WEAK/DOWN/UNKNOWN 자동 판정 →
 *   data/theme/nasdaq-theme-daily.json에 저장.
 *
 * 중요:
 *   - 뉴스 크롤링 X, LLM 분류 X. 미국 ticker 등락률만 본다.
 *   - 기존 QVA/VVI/1DS/보드/라우터/cron 변경 X.
 *
 * 실행:
 *   node scripts/fetch-nasdaq-theme-daily.js
 *
 * 환경변수:
 *   FMP_API_KEY — Financial Modeling Prep API 키 (.env)
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const MAP_PATH   = path.join(ROOT, "data", "theme", "nasdaq-theme-map.json");
const DAILY_PATH = path.join(ROOT, "data", "theme", "nasdaq-theme-daily.json");
const BACKUP_DIR = path.join(ROOT, "data", "theme", ".backup");

// strength 기준
function classifyStrength(stat) {
  if (stat.totalValidTickers < 2) return "UNKNOWN";
  if (stat.avgChangePct >= 2.5 || stat.strongRatio >= 0.6) return "STRONG";
  if (stat.avgChangePct >= 1.0 || stat.strongRatio >= 0.35) return "MID";
  if (stat.avgChangePct >= 0) return "WEAK";
  return "DOWN";
}

// ─── 유틸 ────────────────────────────────────────────────────────────────
function fetchUrl(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = headers ? { headers } : {};
    https.get(url, opts, (res) => {
      const status = res.statusCode || 0;
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${body.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message} / body: ${body.slice(0, 300)}`)); }
      });
    }).on("error", reject);
  });
}

// Yahoo Finance v8 chart endpoint → changePct 추출 (User-Agent 필수)
async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const data = await fetchUrl(url, { "User-Agent": "Mozilla/5.0 (compatible; nasdaq-theme-fetcher)" });
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error("no chart meta");
  const price = Number(meta.regularMarketPrice);
  const prev = Number(meta.chartPreviousClose) || Number(meta.previousClose);
  if (!Number.isFinite(price) || !Number.isFinite(prev) || prev <= 0) throw new Error("no price/prev");
  const changePct = (price / prev - 1) * 100;
  return {
    symbol: symbol.toUpperCase(),
    price, change: price - prev, changePct,
    volume: Number(meta.regularMarketVolume) || null,
    timestamp: Number(meta.regularMarketTime) || null,
  };
}

function median(arr) {
  const xs = arr.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
function avg(arr) {
  const xs = arr.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}
function todayKstDate() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function yesterdayDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// FMP 응답에서 changePct 안전 추출 (필드명 다양)
function extractChangePct(q) {
  const cand = [
    q.changesPercentage, q.changePercentage, q.changePct,
    q.changesPercent, q.percentChange,
  ];
  for (const v of cand) {
    if (v == null) continue;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const cleaned = v.replace(/%/g, "").replace(/[()]/g, "").trim();
      const n = Number(cleaned);
      if (Number.isFinite(n)) return n;
    }
  }
  // change/price 로 계산 시도
  if (Number.isFinite(q.change) && Number.isFinite(q.price) && q.price !== q.change) {
    const prev = q.price - q.change;
    if (prev > 0) return (q.change / prev) * 100;
  }
  return null;
}

// ─── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    console.error("❌ FMP_API_KEY 환경변수가 없습니다.");
    console.error("   .env에 FMP_API_KEY=... 추가 후 다시 실행하세요.");
    console.error("   FMP 가입: https://site.financialmodelingprep.com/");
    process.exit(1);
  }

  if (!fs.existsSync(MAP_PATH)) {
    console.error(`❌ ${MAP_PATH} 파일이 없습니다. 보드 작업 turn에서 먼저 생성된 매핑 파일을 기대.`);
    process.exit(1);
  }

  const mapDoc = JSON.parse(fs.readFileSync(MAP_PATH, "utf-8"));
  const themesMap = mapDoc.themes || mapDoc; // 둘 다 지원 (top-level 또는 .themes)
  const themeKeys = Object.keys(themesMap).filter((k) => !k.startsWith("_"));
  console.log(`🌎 나스닥 테마 강도 자동 계산 시작`);
  console.log(`   테마 ${themeKeys.length}개 / map: ${MAP_PATH}`);

  // 1) 모든 ticker union
  const allTickers = new Set();
  for (const k of themeKeys) {
    const arr = themesMap[k].nasdaqTickers || [];
    for (const t of arr) allTickers.add(String(t).toUpperCase());
  }
  const tickerList = [...allTickers];
  console.log(`   조회 대상 unique ticker: ${tickerList.length}개`);

  if (tickerList.length === 0) {
    console.error("❌ 모든 테마의 nasdaqTickers가 비어 있습니다.");
    process.exit(1);
  }

  // 2) FMP quote 호출 — batch / v3 / single fallback 순으로 시도
  const symbolsParam = tickerList.join(",");
  let quotes = null;

  // (a) /stable/batch-quote — 유료 플랜만
  try {
    const url = `https://financialmodelingprep.com/stable/batch-quote?symbols=${encodeURIComponent(symbolsParam)}&apikey=${encodeURIComponent(apiKey)}`;
    console.log(`   FMP batch-quote 시도 (${tickerList.length} ticker)...`);
    quotes = await fetchUrl(url);
    console.log(`   ✓ batch-quote 성공`);
  } catch (e) {
    console.log(`   batch-quote 불가 (${e.message.split(":")[0]}), 다음 시도...`);
  }

  // (b) /api/v3/quote/SYMBOLS — legacy, August 2025 이전 가입자만
  if (!quotes) {
    try {
      const v3 = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(symbolsParam)}?apikey=${encodeURIComponent(apiKey)}`;
      console.log(`   v3 quote 시도...`);
      quotes = await fetchUrl(v3);
      console.log(`   ✓ v3 quote 성공`);
    } catch (e) {
      console.log(`   v3 quote 불가 (${e.message.split(":")[0]}), single-call fallback...`);
    }
  }

  // (c) /stable/quote?symbol=X — single call × N (무료 플랜 가용)
  if (!quotes) {
    console.log(`   single-call 모드: ${tickerList.length} ticker × 개별 호출 (sleep 80ms)`);
    quotes = [];
    let failed = 0;
    for (let i = 0; i < tickerList.length; i++) {
      const sym = tickerList[i];
      try {
        const u = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(apiKey)}`;
        const r = await fetchUrl(u);
        if (Array.isArray(r) && r.length > 0) quotes.push(r[0]);
        else { failed++; if (failed <= 3) console.log(`   ⚠ 빈 응답: ${sym}`); }
      } catch (e) {
        failed++;
        if (failed <= 3) console.log(`   ⚠ ${sym} 실패: ${e.message.split(":")[0]}`);
      }
      if (i < tickerList.length - 1) await new Promise(r => setTimeout(r, 80));
      if ((i + 1) % 20 === 0) console.log(`   진행 ${i + 1}/${tickerList.length}`);
    }
    if (failed > 0) console.log(`   single-call 완료 — 성공 ${quotes.length} / 실패 ${failed}`);
    else console.log(`   ✓ single-call 완료 — 모두 성공`);
  }

  if (!Array.isArray(quotes)) {
    console.error(`❌ FMP 응답이 array 아님: ${JSON.stringify(quotes).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`   응답 ${quotes.length}건 수신`);

  // 3) ticker별 등락률 + 가격 + 거래량 lookup (FMP 응답)
  const quoteByTicker = new Map();
  for (const q of quotes) {
    if (!q || !q.symbol) continue;
    const sym = String(q.symbol).toUpperCase();
    const changePct = extractChangePct(q);
    if (changePct == null) continue;
    quoteByTicker.set(sym, {
      symbol: sym,
      price: Number(q.price) || null,
      change: Number(q.change) || null,
      changePct,
      volume: Number(q.volume) || null,
      timestamp: q.timestamp || q.lastTradeTime || null,
    });
  }

  // (d) FMP에서 못 받은 ticker는 Yahoo v8 chart fallback
  let fmpMissing = tickerList.filter((t) => !quoteByTicker.has(t));
  if (fmpMissing.length > 0) {
    console.log(`   Yahoo v8 chart fallback: ${fmpMissing.length} ticker (FMP에서 못 받은 것)`);
    let yahooOk = 0, yahooFail = 0;
    for (let i = 0; i < fmpMissing.length; i++) {
      const sym = fmpMissing[i];
      try {
        const q = await fetchYahooQuote(sym);
        quoteByTicker.set(sym, q);
        yahooOk++;
      } catch (e) {
        yahooFail++;
        if (yahooFail <= 3) console.log(`   ⚠ Yahoo ${sym} 실패: ${e.message.split(":")[0]}`);
      }
      if (i < fmpMissing.length - 1) await new Promise(r => setTimeout(r, 100));
      if ((i + 1) % 20 === 0) console.log(`   Yahoo 진행 ${i + 1}/${fmpMissing.length}`);
    }
    console.log(`   Yahoo 완료 — 성공 ${yahooOk} / 실패 ${yahooFail}`);
  }

  const missing = tickerList.filter((t) => !quoteByTicker.has(t));
  if (missing.length > 0) {
    console.log(`   ⚠ 최종 데이터 없음 ticker ${missing.length}개: ${missing.join(", ")}`);
  }

  // usMarketDate — quote timestamp에서 추출 (Unix sec). 없으면 KR 어제로 fallback
  let usMarketDate = null;
  for (const q of quoteByTicker.values()) {
    if (q.timestamp && Number.isFinite(Number(q.timestamp))) {
      // 보통 Unix sec
      const ts = Number(q.timestamp);
      const ms = ts > 1e12 ? ts : ts * 1000;
      usMarketDate = new Date(ms).toISOString().slice(0, 10);
      break;
    }
  }
  const krDate = todayKstDate();
  if (!usMarketDate) usMarketDate = yesterdayDate(krDate);

  // 4) 테마별 계산
  const themesResult = {};
  for (const themeKey of themeKeys) {
    const tm = themesMap[themeKey];
    const tickers = (tm.nasdaqTickers || []).map((t) => String(t).toUpperCase());
    const validQuotes = tickers.map((t) => quoteByTicker.get(t)).filter(Boolean);
    const changePcts = validQuotes.map((q) => q.changePct);

    const stat = {
      label: tm.label || themeKey,
      avgChangePct: 0, medianChangePct: 0,
      upCount: 0, downCount: 0,
      strongTickerCount: 0, totalTickerCount: tickers.length, totalValidTickers: validQuotes.length,
      upRatio: 0, strongRatio: 0,
      topTickers: [], bottomTickers: [],
    };
    if (validQuotes.length === 0) {
      themesResult[themeKey] = {
        ...stat, strength: "UNKNOWN",
        reason: "유효 ticker 데이터 없음",
      };
      continue;
    }

    stat.avgChangePct = Number((avg(changePcts) ?? 0).toFixed(2));
    stat.medianChangePct = Number((median(changePcts) ?? 0).toFixed(2));
    stat.upCount = validQuotes.filter((q) => q.changePct > 0).length;
    stat.downCount = validQuotes.filter((q) => q.changePct < 0).length;
    stat.strongTickerCount = validQuotes.filter((q) => q.changePct >= 2).length;
    stat.upRatio = Number((stat.upCount / validQuotes.length).toFixed(2));
    stat.strongRatio = Number((stat.strongTickerCount / validQuotes.length).toFixed(2));

    const sortedByChange = validQuotes.slice().sort((a, b) => b.changePct - a.changePct);
    stat.topTickers = sortedByChange.slice(0, 3).map((q) => ({
      symbol: q.symbol, changePct: Number(q.changePct.toFixed(2)),
    }));
    const bottomCount = Math.min(3, validQuotes.filter((q) => q.changePct < 0).length);
    stat.bottomTickers = sortedByChange.slice(-bottomCount).reverse().map((q) => ({
      symbol: q.symbol, changePct: Number(q.changePct.toFixed(2)),
    }));

    const strength = classifyStrength(stat);

    // reason 자동 생성
    const reasonParts = [];
    if (stat.topTickers.length > 0) {
      const top = stat.topTickers.map((t) => `${t.symbol} ${t.changePct >= 0 ? "+" : ""}${t.changePct}%`).join(", ");
      if (strength === "STRONG" || strength === "MID") reasonParts.push(`${top} 중심 강세`);
      else if (strength === "DOWN") reasonParts.push("주요 ticker 약세");
      else reasonParts.push(top);
    }
    reasonParts.push(`상승 ${stat.upCount}/${validQuotes.length}개, 평균 ${stat.avgChangePct >= 0 ? "+" : ""}${stat.avgChangePct}%`);
    if (stat.strongRatio >= 0.35) reasonParts.push(`강한 상승 ${Math.round(stat.strongRatio * 100)}%`);
    if (validQuotes.length < tickers.length) reasonParts.push(`(${tickers.length - validQuotes.length} ticker 데이터 누락)`);

    themesResult[themeKey] = { ...stat, strength, reason: reasonParts.join(" / ") };
  }

  // 5) summary
  const strongThemes = themeKeys.filter((k) => themesResult[k].strength === "STRONG");
  const midThemes    = themeKeys.filter((k) => themesResult[k].strength === "MID");
  const weakThemes   = themeKeys.filter((k) => themesResult[k].strength === "WEAK");
  const downThemes   = themeKeys.filter((k) => themesResult[k].strength === "DOWN");
  const unknownThemes = themeKeys.filter((k) => themesResult[k].strength === "UNKNOWN");

  // 실행 trigger 구분 — cron(기본) / manual(어드민 새로고침). board generator가 화면 표시에 사용.
  const triggerSource = String(process.env.NASDAQ_THEME_SOURCE || "cron").toLowerCase();
  const result = {
    generatedAt: new Date().toISOString(),
    date: krDate,
    usMarketDate,
    source: "FMP",
    triggerSource,
    themes: themesResult,
    summary: {
      strongThemes, midThemes, weakThemes, downThemes, unknownThemes,
      totalThemes: themeKeys.length,
    },
  };

  // 6) 기존 파일 백업
  if (fs.existsSync(DAILY_PATH)) {
    try {
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const bakPath = path.join(BACKUP_DIR, `nasdaq-theme-daily-${stamp}.json`);
      fs.copyFileSync(DAILY_PATH, bakPath);
      console.log(`   📦 기존 파일 백업: ${bakPath}`);
    } catch (e) {
      console.log(`   ⚠ 백업 실패 (계속 진행): ${e.message}`);
    }
  }

  // 7) 저장 — 새 단일 객체 구조 + 기존 history 호환을 위해 history도 함께 갱신
  // history는 기존 파일의 history 배열을 읽어서 새 entry append (최신 N개만 유지)
  let history = [];
  try {
    if (fs.existsSync(DAILY_PATH)) {
      const old = JSON.parse(fs.readFileSync(DAILY_PATH, "utf-8"));
      if (Array.isArray(old.history)) history = old.history;
    }
  } catch (_) {}
  // 같은 date entry 있으면 교체, 아니면 append
  const newEntry = { date: krDate, usMarketDate, triggerSource, generatedAt: result.generatedAt, themes: themesResult };
  const idx = history.findIndex((e) => e.date === krDate);
  if (idx >= 0) history[idx] = newEntry;
  else history.push(newEntry);
  history.sort((a, b) => b.date.localeCompare(a.date));
  history = history.slice(0, 90); // 최근 90일치만 유지

  const docToSave = { ...result, history };
  fs.writeFileSync(DAILY_PATH, JSON.stringify(docToSave, null, 2));
  console.log(`✅ 저장: ${DAILY_PATH}`);

  // 8) 콘솔 출력
  console.log();
  console.log("━".repeat(80));
  console.log(`=== 나스닥 테마 강도 자동 계산 결과 ===`);
  console.log(`   KR date: ${krDate} / US market date: ${usMarketDate} (source: FMP)`);
  console.log();
  console.log(`STRONG 테마 (${strongThemes.length}): ${strongThemes.map((k) => themesMap[k].label || k).join(", ") || "—"}`);
  console.log(`MID 테마    (${midThemes.length}): ${midThemes.map((k) => themesMap[k].label || k).join(", ") || "—"}`);
  console.log(`WEAK 테마   (${weakThemes.length}): ${weakThemes.map((k) => themesMap[k].label || k).join(", ") || "—"}`);
  console.log(`DOWN 테마   (${downThemes.length}): ${downThemes.map((k) => themesMap[k].label || k).join(", ") || "—"}`);
  if (unknownThemes.length) console.log(`UNKNOWN     (${unknownThemes.length}): ${unknownThemes.map((k) => themesMap[k].label || k).join(", ")}`);
  console.log();

  if (strongThemes.length > 0) {
    console.log(`▶ STRONG 테마 상세:`);
    for (const k of strongThemes) {
      const t = themesResult[k];
      console.log(`  [${(themesMap[k].label || k).padEnd(18)}] avg ${t.avgChangePct >= 0 ? "+" : ""}${t.avgChangePct}% / strongRatio ${(t.strongRatio * 100).toFixed(0)}% / ${t.reason}`);
    }
    console.log();
  }
  if (midThemes.length > 0) {
    console.log(`▶ MID 테마 상세:`);
    for (const k of midThemes) {
      const t = themesResult[k];
      console.log(`  [${(themesMap[k].label || k).padEnd(18)}] avg ${t.avgChangePct >= 0 ? "+" : ""}${t.avgChangePct}% / ${t.reason}`);
    }
    console.log();
  }
  console.log(`결과 파일: ${DAILY_PATH}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
