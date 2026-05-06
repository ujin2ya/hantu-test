// ─────────── 부트스트랩 ───────────
// 라우터/컨트롤러/서비스 분리: src/ 하위. 이 파일은 dotenv 로드 → express 설정 → 라우터 mount → cron 스케줄 → listen 만 담당.

const path = require("path");
const fs = require("fs");

// dotenv 먼저 — 다른 모든 모듈은 process.env를 읽는 시점이 require 후이므로 OK
const ENV_PATH = path.join(__dirname, ".env");
const dotenvResult = require("dotenv").config({ path: ENV_PATH, override: true });
if (dotenvResult.error) {
  console.warn("[dotenv] .env 로드 실패:", dotenvResult.error.message);
} else {
  const parsedKeys = Object.keys(dotenvResult.parsed || {});
  console.log(`[dotenv] .env 로드 OK (override) / 파싱된 키 ${parsedKeys.length}개: [${parsedKeys.join(", ")}]`);
}

const express = require("express");
const { VIEWS_DIR } = require("./src/utils/paths");
const { privateTokenGate, sitePasswordGate } = require("./src/middleware/siteGate");
const routes = require("./src/routes");
const { loadStocks } = require("./src/services/stocks/stocksLoader");
const { registerSchedules } = require("./src/services/pattern/scheduledJobs");

const app = express();
const PORT = process.env.PORT || 3012;

app.set("view engine", "ejs");
app.set("views", VIEWS_DIR);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 사이트 진입 게이트 — PRIVATE_SITE_TOKEN(404) → SITE_PASSWORD(/login)
app.use(privateTokenGate);
app.use(sitePasswordGate);

// 라우터 mount
app.use(routes);

// stocks.json 시작 시 로드 (admin 대시보드의 마스터 신선도 표시 등에 필요)
loadStocks();

// cron 스케줄 등록 (16:10 분석 / 16:20 일일 갱신 / 16:35 보드 갱신 / 18:00 메일)
registerSchedules();

app.listen(PORT, () => {
  console.log(`서버 실행: http://localhost:${PORT}`);
  console.log(`📋 H그룹/VPR 운영 보드: http://localhost:${PORT}/qva-watchlist`);
  console.log(`🔥 D+5 재돌파 운용 보드: http://localhost:${PORT}/rebreak`);
  console.log(`🔬 재돌파 심층 검증: http://localhost:${PORT}/rebreak-deep`);
  console.log(`⚙ 관리자: http://localhost:${PORT}/admin`);
});
