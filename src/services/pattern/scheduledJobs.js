// 일일 cron 스케줄 — 16:10 분석 / 16:20 일일 갱신(평일) / 16:35 보드 갱신(평일) / 18:00 메일(MAIL_CRON_ENABLED).
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const cron = require("node-cron");
const patternScreener = require("../../../pattern-screener");
const { ROOT, CACHE_DIR } = require("../../utils/paths");
const { patternState, PATTERN_RESULT_PATH } = require("./adminTriggers");
const { sendPatternMail } = require("../mail/patternMail");

function registerSchedules() {
  // 16:10 매일 — 종가 기준 신호 갱신
  cron.schedule("10 16 * * *", async () => {
    if (patternState.analyzing) {
      console.log("[자동분석] 16:10 — 이미 분석 중이므로 스킵");
      return;
    }
    console.log("[자동분석] 16:10 시작 — VVI, CSB, Rebound 등 모든 신호 종가 기준 갱신");
    patternState.analyzing = true;
    patternState.analyzeStartedAt = new Date().toISOString();
    patternState.analyzeError = null;
    try {
      const result = await patternScreener.analyzeAll({ logProgress: false });
      fs.writeFileSync(PATTERN_RESULT_PATH, JSON.stringify(result, null, 2), "utf-8");
      patternState.analyzeFinishedAt = new Date().toISOString();
      console.log(`[자동분석] 완료: ${patternState.analyzeFinishedAt} — 신호 수: CSB=${result.csbMainCandidates?.length || 0}, VVI=${result.vviCandidates?.length || 0}, Rebound=${result.reboundCandidates?.length || 0}`);
    } catch (e) {
      patternState.analyzeError = e.message;
      console.error("[자동분석] 에러:", e.message);
    } finally {
      patternState.analyzing = false;
    }
  }, { scheduled: true, timezone: "Asia/Seoul" });
  console.log("[스케줄] 매일 16:10 종가 기준 자동 분석 활성화 (한국 시간)");

  // 16:20 평일 — 차트 + 수급 + 재분석
  cron.schedule("20 16 * * 1-5", async () => {
    if (patternState.analyzing) {
      console.log("[일일업데이트] 16:20 — 이미 분석/업데이트 중이므로 스킵");
      return;
    }
    console.log("[일일업데이트] 16:20 시작 — pykrx + Naver 수급 데이터 갱신 + 재분석");
    patternState.analyzing = true;
    patternState.analyzeStartedAt = new Date().toISOString();
    patternState.analyzeError = null;
    try {
      const scriptPath = path.join(ROOT, "run-daily-analysis.js");
      execSync(`node ${scriptPath}`, { stdio: "pipe" });
      patternState.analyzeFinishedAt = new Date().toISOString();
      console.log(`[일일업데이트] 완료: ${patternState.analyzeFinishedAt}`);
    } catch (e) {
      patternState.analyzeError = e.message;
      console.error("[일일업데이트] 에러:", e.message);
    } finally {
      patternState.analyzing = false;
    }
  }, { scheduled: true, timezone: "Asia/Seoul" });
  console.log("[스케줄] 매일 평일 16:20 일일 데이터 업데이트 + 재분석 활성화 (한국 시간)");

  // 16:35 평일 — QVA Watchlist Board 갱신
  cron.schedule("35 16 * * 1-5", () => {
    console.log("[Watchlist] 16:35 시작 — qva-watchlist-board 갱신");
    try {
      const scriptPath = path.join(ROOT, "qva-watchlist-board.js");
      execSync(`node ${scriptPath}`, { stdio: "pipe" });
      console.log("[Watchlist] 갱신 완료");
    } catch (e) {
      console.error("[Watchlist] 에러:", e.message);
    }
  }, { scheduled: true, timezone: "Asia/Seoul" });
  console.log("[스케줄] 매일 평일 16:35 QVA Watchlist Board 갱신 활성화 (한국 시간)");

  // 18:00 매일 — VVI 신호 메일 (옵션, MAIL_CRON_ENABLED=1 일 때만)
  if (process.env.MAIL_CRON_ENABLED === "1") {
    cron.schedule("0 18 * * *", async () => {
      console.log("[메일발송] 18:00 — pattern-result.json 기반 VVI 신호 메일 발송 시작");
      try {
        if (!fs.existsSync(PATTERN_RESULT_PATH)) {
          console.log("[메일발송] pattern-result.json 없음 — 스킵");
          return;
        }
        const result = JSON.parse(fs.readFileSync(PATTERN_RESULT_PATH, "utf-8"));
        if (result.analyzeFinishedAt) {
          const resultDate = new Date(result.analyzeFinishedAt).toDateString();
          const today = new Date().toDateString();
          if (resultDate !== today) {
            console.log(`[메일발송] 결과가 오늘자 아님 (${resultDate}) — 스킵`);
            return;
          }
        }
        await sendPatternMail(result);
      } catch (e) {
        console.error("[메일발송] 에러:", e.message);
      }
    }, { scheduled: true, timezone: "Asia/Seoul" });
    console.log("[스케줄] 매일 18:00 VVI 신호 메일 자동 발송 활성화 (한국 시간)");
  }
}

module.exports = { registerSchedules };
