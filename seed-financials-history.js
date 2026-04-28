// DART 분기별 history seed (Phase 2 — 시점별 공시 보정용)
//
// 모든 종목의 최근 lookback 년치 분기 보고서 raw 수집 → cache/dart-financials-history/<code>.json
// 가용일 (표준 공시 마감 + 마진 10일) 포함 → 백테스트 시점 기준 lookup 가능
//
// 실행: node seed-financials-history.js [lookbackYears=3] [throttleMs=60]
//
// 예상 시간: 종목당 분기 12개 (3년 × 4분기) × 60ms = 720ms
//   2533 종목 (isSpecial 제외) × 720ms ≈ 30분
//
// 진행률 출력 + resume 지원 (이미 캐시 있으면 skip)

require('dotenv').config({ quiet: true });
const fs = require("fs");
const path = require("path");
const dart = require("./dart-fetcher");

const lookbackYears = parseInt(process.argv[2] || "3", 10);
const throttleMs = parseInt(process.argv[3] || "60", 10);

const apiKey = process.env.DART_API_KEY;
if (!apiKey) {
  console.error("FATAL: DART_API_KEY 환경변수가 없습니다.");
  process.exit(1);
}

(async () => {
  const stocksListPath = path.join(__dirname, "cache", "naver-stocks-list.json");
  const stocksList = JSON.parse(fs.readFileSync(stocksListPath, "utf-8")).stocks;
  console.log(`총 ${stocksList.length} 종목, lookback=${lookbackYears}년, throttle=${throttleMs}ms`);
  console.log(`예상 시간: ~${Math.round(stocksList.length * lookbackYears * 4 * throttleMs / 1000 / 60)} 분 (resume 미고려)`);

  const t0 = Date.now();
  let lastLog = 0;

  const result = await dart.fetchAllFinancialsHistory({
    stocksList,
    apiKey,
    lookbackYears,
    throttleMs,
    resume: true,
    onProgress: ({ i, total, code, name, status, reports }) => {
      const now = Date.now();
      if (now - lastLog > 5000 || i % 50 === 0 || i === total - 1) {
        const elapsed = ((now - t0) / 1000).toFixed(0);
        const pct = ((i + 1) / total * 100).toFixed(1);
        const eta = i > 0 ? ((now - t0) / (i + 1) * (total - i - 1) / 1000 / 60).toFixed(1) : '?';
        console.log(`[${i + 1}/${total} ${pct}%] ${code} ${name || ''} → ${status}${reports != null ? ` (${reports} reports)` : ''} | elapsed ${elapsed}s, ETA ${eta}분`);
        lastLog = now;
      }
    },
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n=== 완료 (${elapsed}초) ===`);
  console.log(`success: ${result.success}, fail: ${result.fail}, skipped: ${result.skipped}, cached: ${result.cached}`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
