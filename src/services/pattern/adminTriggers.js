// 관리자가 트리거하는 패턴 파이프라인 작업 — seed, analyze, refresh, daily update.
// 모든 작업은 비동기로 백그라운드 실행. patternState로 진행 상황 추적.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const naverFetcher = require("../../../screeners/naver-fetcher");
const patternScreener = require("../../../screeners/pattern-screener");
const { ROOT, CACHE_DIR } = require("../../utils/paths");

const patternState = {
  seeding: false, seedStartedAt: null, seedFinishedAt: null, seedProgress: null, seedError: null,
  analyzing: false, analyzeStartedAt: null, analyzeFinishedAt: null, analyzeError: null,
  refreshingBoard: false, boardRefreshStartedAt: null, boardRefreshFinishedAt: null, boardRefreshError: null,
  qvaBacktesting: false, qvaBacktestStartedAt: null, qvaBacktestFinishedAt: null, qvaBacktestError: null,
  dailyUpdating: false, dailyUpdateStartedAt: null, dailyUpdateFinishedAt: null, dailyUpdateError: null,
  // 전체 보드 갱신 (QVA + D+5 재돌파 × 3 + 1DS) — cron 16:35 + /admin/refresh-all-boards
  refreshingAllBoards: false, allBoardsRefreshStartedAt: null, allBoardsRefreshFinishedAt: null,
  allBoardsRefreshError: null, allBoardsCurrent: null, allBoardsResults: [],
  // 1DS 분봉 수집 + 보드 재생성 — cron 평일 09:31 + /admin/refresh-1ds-intraday
  refreshing1dsIntraday: false, oneDsIntradayStartedAt: null, oneDsIntradayFinishedAt: null,
  oneDsIntradayError: null, oneDsIntradayPhase: null,
  oneDsIntradayCollected: 0, oneDsIntradayFailed: 0,
};

// 16:35 cron + admin 트리거가 같은 순서로 갱신하는 보드 스크립트 목록.
// 의존성 순서:
//   - QVA 보드(qva-watchlist-board.json 생성) → D+5 재돌파(QVA 결과 read) → 1DS(독립)
//   - QVA2 watchlist → QVA2 D+5 재돌파(watchlist json read) → QVA2 고점 재돌파(watchlist + VVI2 json read)
// 차트/수급/펀더멘탈 캐시는 16:20 일일 업데이트에서 이미 갱신됨. 보드는 캐시 read만 한다.
const BOARD_SCRIPTS = [
  { name: "QVA Watchlist Board",          file: "boards/qva/qva-watchlist-board.js" },
  { name: "QVA 고점 재돌파 보드",            file: "boards/qva/qva-vvi-redefined-board.js" },
  { name: "D+5 재돌파 운용 보드",            file: "boards/rebreak/hgroup-rebreak-operation-board.js" },
  { name: "1-Day Surge Board",            file: "boards/oneDaySurge/one-day-surge-board.js" },
  { name: "QVA2 H그룹/VPR 보드",            file: "boards/qva2/qva2-watchlist-board.js" },
  { name: "QVA2 D+5 재돌파 운용보드",        file: "boards/qva2/qva2-d5-rebreak-board.js" },
  { name: "QVA2 고점 재돌파 보드",           file: "boards/qva2/qva2-vvi-board.js" },
];

const PATTERN_RESULT_PATH = path.join(CACHE_DIR, "pattern-result.json");
const QVA_BACKTEST_PATH = path.join(CACHE_DIR, "qva-backtest.json");

function startSeed() {
  if (patternState.seeding) return { ok: false, reason: "already_running" };
  patternState.seeding = true;
  patternState.seedStartedAt = new Date().toISOString();
  patternState.seedFinishedAt = null;
  patternState.seedProgress = { i: 0, total: 0, code: "", name: "" };
  patternState.seedError = null;
  // Minervini Stage 2 분석 위해 250일 lookback (200일 SMA 계산용)
  naverFetcher.seedHistorical({
    lookbackDays: 250,
    onProgress: (p) => { patternState.seedProgress = p; },
  })
    .catch((e) => { patternState.seedError = e.message; })
    .finally(() => {
      patternState.seeding = false;
      patternState.seedFinishedAt = new Date().toISOString();
    });
  return { ok: true };
}

function startAnalyze() {
  if (patternState.analyzing) return { ok: false, reason: "already_running" };
  patternState.analyzing = true;
  patternState.analyzeStartedAt = new Date().toISOString();
  patternState.analyzeFinishedAt = null;
  patternState.analyzeError = null;
  patternScreener.analyzeAll({ logProgress: true })
    .then((result) => {
      fs.writeFileSync(PATTERN_RESULT_PATH, JSON.stringify(result, null, 2), "utf-8");
      console.log(`[분석] 완료 및 저장: vviCandidates=${result.vviCandidates?.length || 0}, CSB=${result.csbMainCandidates?.length || 0}`);
    })
    .catch((e) => { patternState.analyzeError = e.message; })
    .finally(() => {
      patternState.analyzing = false;
      patternState.analyzeFinishedAt = new Date().toISOString();
    });
  return { ok: true };
}

function startQvaBacktest() {
  if (patternState.qvaBacktesting) return { ok: false, reason: "already_running" };
  patternState.qvaBacktesting = true;
  patternState.qvaBacktestStartedAt = new Date().toISOString();
  patternState.qvaBacktestFinishedAt = null;
  patternState.qvaBacktestError = null;
  patternScreener.backtestQVA({ daysBack: 100 })
    .then((result) => {
      fs.writeFileSync(QVA_BACKTEST_PATH, JSON.stringify(result, null, 2), "utf-8");
      console.log(`[QVA 백테스트] 완료 — ready=${result.qvaReady?.n || 0}, watch=${result.qvaWatch?.n || 0}, risk=${result.qvaRisk?.n || 0}`);
    })
    .catch((e) => { patternState.qvaBacktestError = e.message; })
    .finally(() => {
      patternState.qvaBacktesting = false;
      patternState.qvaBacktestFinishedAt = new Date().toISOString();
    });
  return { ok: true };
}

// 캐시 강제 삭제 + 재계산 (원격 서버에서 신호가 안 나올 때)
function refreshPatternCache() {
  try {
    if (fs.existsSync(PATTERN_RESULT_PATH)) fs.unlinkSync(PATTERN_RESULT_PATH);
    if (patternState.analyzing) return { ok: false, message: "이미 분석 중입니다" };
    patternState.analyzing = true;
    patternState.analyzeStartedAt = new Date().toISOString();
    patternState.analyzeFinishedAt = null;
    patternState.analyzeError = null;
    patternScreener.analyzeAll({ logProgress: true })
      .catch((e) => { patternState.analyzeError = e.message; })
      .finally(() => {
        patternState.analyzing = false;
        patternState.analyzeFinishedAt = new Date().toISOString();
      });
    return { ok: true, message: "패턴 캐시 삭제 및 재분석 시작됨" };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// QVA Watchlist Board (HTML/JSON) 수동 갱신 — pattern-result.json은 그대로, 보드만 다시 만든다.
function refreshWatchlistBoard() {
  if (patternState.refreshingBoard) return { ok: false, message: "이미 보드 갱신 중입니다" };
  patternState.refreshingBoard = true;
  patternState.boardRefreshStartedAt = new Date().toISOString();
  patternState.boardRefreshFinishedAt = null;
  patternState.boardRefreshError = null;
  (async () => {
    try {
      const scriptPath = path.join(ROOT, "boards", "qva", "qva-watchlist-board.js");
      console.log("[Watchlist Refresh] 시작:", new Date().toISOString());
      const proc = spawn("node", [scriptPath], { cwd: ROOT });
      let stderr = "";
      proc.stdout.on("data", (d) => process.stdout.write("[WL] " + d.toString()));
      proc.stderr.on("data", (d) => { stderr += d.toString(); process.stderr.write("[WL ERR] " + d.toString()); });
      proc.on("close", (code) => {
        if (code === 0) console.log("[Watchlist Refresh] 완료");
        else patternState.boardRefreshError = `exit ${code}: ${stderr.slice(0, 500)}`;
        patternState.refreshingBoard = false;
        patternState.boardRefreshFinishedAt = new Date().toISOString();
      });
    } catch (e) {
      patternState.boardRefreshError = e.message;
      patternState.refreshingBoard = false;
      patternState.boardRefreshFinishedAt = new Date().toISOString();
    }
  })();
  return { ok: true, message: "QVA Watchlist Board 갱신 시작 (백그라운드)", startedAt: patternState.boardRefreshStartedAt };
}

// Daily update — 차트 + 수급 + 분석 일괄 실행 (run-daily-analysis.js spawn).
function runDailyUpdate() {
  if (patternState.dailyUpdating) return { ok: false, message: "이미 일일 업데이트 중입니다" };
  patternState.dailyUpdating = true;
  patternState.dailyUpdateStartedAt = new Date().toISOString();
  patternState.dailyUpdateFinishedAt = null;
  patternState.dailyUpdateError = null;

  (async () => {
    try {
      const scriptPath = path.join(ROOT, "pipeline", "run-daily-analysis.js");
      console.log("[Daily Update] 시작:", new Date().toISOString());
      const proc = spawn("node", [scriptPath], { cwd: ROOT });
      proc.stdout.on("data", (data) => console.log("[Daily Update stdout]", data.toString().trim()));
      proc.stderr.on("data", (data) => console.error("[Daily Update stderr]", data.toString().trim()));
      proc.on("close", (code) => {
        if (code === 0) console.log("[Daily Update] 완료:", new Date().toISOString());
        else {
          console.error("[Daily Update] 오류 (exit code:", code, ")");
          patternState.dailyUpdateError = `Exit code ${code}`;
        }
        patternState.dailyUpdating = false;
        patternState.dailyUpdateFinishedAt = new Date().toISOString();
      });
      proc.on("error", (err) => {
        console.error("[Daily Update] spawn 오류:", err.message);
        patternState.dailyUpdateError = err.message;
        patternState.dailyUpdating = false;
        patternState.dailyUpdateFinishedAt = new Date().toISOString();
      });
    } catch (e) {
      console.error("[Daily Update] 최종 오류:", e.message);
      patternState.dailyUpdateError = e.message;
      patternState.dailyUpdating = false;
      patternState.dailyUpdateFinishedAt = new Date().toISOString();
    }
  })();
  return { ok: true, message: "일일 업데이트 시작 (차트 + 수급 + 분석)", startedAt: patternState.dailyUpdateStartedAt };
}

// 단일 보드 스크립트를 spawn으로 실행하고 종료를 기다린다 (스트림은 stdout/stderr로 미러링).
function spawnBoardScript(scriptFile) {
  return new Promise((resolve) => {
    const scriptPath = path.join(ROOT, scriptFile);
    const proc = spawn("node", [scriptPath], { cwd: ROOT });
    let stderr = "";
    proc.stdout.on("data", (d) => process.stdout.write("[BD] " + d.toString()));
    proc.stderr.on("data", (d) => { stderr += d.toString(); process.stderr.write("[BD ERR] " + d.toString()); });
    proc.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `exit ${code}: ${stderr.slice(0, 500)}` });
    });
    proc.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

// 전체 보드 갱신 (cron 16:35 + /admin/refresh-all-boards 가 호출).
// QVA → QVA 고점 재돌파 → D+5 재돌파 운용 → 1DS → QVA2 × 3 순서로 순차 실행. 한 보드 실패해도 다음 진행.
function refreshAllBoards() {
  if (patternState.refreshingAllBoards) {
    return { ok: false, message: "이미 전체 보드 갱신 중입니다", startedAt: patternState.allBoardsRefreshStartedAt };
  }
  patternState.refreshingAllBoards = true;
  patternState.allBoardsRefreshStartedAt = new Date().toISOString();
  patternState.allBoardsRefreshFinishedAt = null;
  patternState.allBoardsRefreshError = null;
  patternState.allBoardsCurrent = null;
  patternState.allBoardsResults = [];

  (async () => {
    console.log(`[All Boards] 시작 (${BOARD_SCRIPTS.length}개): ${patternState.allBoardsRefreshStartedAt}`);
    for (const s of BOARD_SCRIPTS) {
      patternState.allBoardsCurrent = s.name;
      const t0 = Date.now();
      const r = await spawnBoardScript(s.file);
      const elapsedMs = Date.now() - t0;
      patternState.allBoardsResults.push({
        name: s.name, file: s.file, ok: r.ok, error: r.error || null, elapsedMs,
      });
      if (r.ok) console.log(`[All Boards] ✅ ${s.name} (${elapsedMs}ms)`);
      else console.error(`[All Boards] ❌ ${s.name}: ${r.error}`);
    }
    patternState.allBoardsCurrent = null;
    const failed = patternState.allBoardsResults.filter((r) => !r.ok);
    if (failed.length) {
      patternState.allBoardsRefreshError = `${failed.length}개 보드 실패: ${failed.map((f) => f.name).join(", ")}`;
    }
    patternState.refreshingAllBoards = false;
    patternState.allBoardsRefreshFinishedAt = new Date().toISOString();
    console.log(`[All Boards] 완료: ${patternState.allBoardsRefreshFinishedAt}` + (failed.length ? ` (${failed.length}개 실패)` : ""));
  })();

  return {
    ok: true,
    message: `전체 보드 갱신 시작 (${BOARD_SCRIPTS.length}개 — QVA + QVA 고점 재돌파 + D+5 재돌파 + 1DS + QVA2 × 3, 백그라운드 30~90초 예상)`,
    startedAt: patternState.allBoardsRefreshStartedAt,
  };
}

// 1DS 분봉 수집 + 09:30 스캐너 + 1DS 보드 재생성 — cron 평일 09:31 + /admin/refresh-1ds-intraday 가 호출.
// (1) collect-1ds-intraday.js --from-board 으로 보드 mainPool 코드만 KIS에서 분봉 수집
// (2) one-day-surge-0930-scanner.js 로 09:30 실시간 포착 스캐너 실행 (이미 수집된 분봉만 분석)
// (3) one-day-surge-board.js 로 보드 재생성 (전일 mainPool + 스캐너 결과 모두 반영)
function refresh1dsIntraday() {
  if (patternState.refreshing1dsIntraday) {
    return { ok: false, message: "이미 1DS 분봉 수집 중입니다", startedAt: patternState.oneDsIntradayStartedAt };
  }
  patternState.refreshing1dsIntraday = true;
  patternState.oneDsIntradayStartedAt = new Date().toISOString();
  patternState.oneDsIntradayFinishedAt = null;
  patternState.oneDsIntradayError = null;
  patternState.oneDsIntradayPhase = "collect";
  patternState.oneDsIntradayCollected = 0;
  patternState.oneDsIntradayFailed = 0;

  (async () => {
    try {
      // Phase 1: 분봉 수집
      const collectScript = path.join(ROOT, "pipeline", "collect-1ds-intraday.js");
      console.log("[1DS Intraday] 분봉 수집 시작");
      const collectRes = await new Promise((resolve) => {
        const proc = spawn("node", [collectScript, "--from-board"], { cwd: ROOT });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (d) => { const s = d.toString(); stdout += s; process.stdout.write("[1DS-COL] " + s); });
        proc.stderr.on("data", (d) => { const s = d.toString(); stderr += s; process.stderr.write("[1DS-COL ERR] " + s); });
        proc.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
        proc.on("error", (err) => resolve({ ok: false, code: -1, stdout, stderr: err.message }));
      });
      // collect 출력에서 success/fail 카운트 파싱 (best-effort)
      const okMatch = collectRes.stdout.match(/수집 성공:\s*(\d+)/);
      const failMatch = collectRes.stdout.match(/실패\/누락:\s*(\d+)/);
      patternState.oneDsIntradayCollected = okMatch ? parseInt(okMatch[1], 10) : 0;
      patternState.oneDsIntradayFailed    = failMatch ? parseInt(failMatch[1], 10) : 0;

      if (!collectRes.ok) {
        patternState.oneDsIntradayError = `collect 실패 (exit ${collectRes.code}): ${collectRes.stderr.slice(0, 300)}`;
        // collect 실패해도 보드는 재생성 시도 (이전 분봉 데이터는 살아있음)
      }

      // Phase 2: 09:30 실시간 스캐너 (이미 수집된 분봉만 분석 — 추가 KIS 호출 없음)
      patternState.oneDsIntradayPhase = "scanner";
      console.log("[1DS Intraday] 09:30 스캐너 시작");
      const scannerScript = path.join(ROOT, "boards", "oneDaySurge", "one-day-surge-0930-scanner.js");
      const scannerRes = await new Promise((resolve) => {
        const proc = spawn("node", [scannerScript], { cwd: ROOT });
        let stderr = "";
        proc.stdout.on("data", (d) => process.stdout.write("[1DS-SC] " + d.toString()));
        proc.stderr.on("data", (d) => { stderr += d.toString(); process.stderr.write("[1DS-SC ERR] " + d.toString()); });
        proc.on("close", (code) => resolve({ ok: code === 0, code, stderr }));
        proc.on("error", (err) => resolve({ ok: false, code: -1, stderr: err.message }));
      });
      if (!scannerRes.ok) {
        const prev = patternState.oneDsIntradayError ? patternState.oneDsIntradayError + " / " : "";
        patternState.oneDsIntradayError = prev + `scanner 실패 (exit ${scannerRes.code}): ${scannerRes.stderr.slice(0, 300)}`;
        // scanner 실패해도 보드 재생성은 진행 — 보드는 스캐너 JSON 없으면 미실행 안내만 표시.
      }

      // Phase 3: 보드 재생성
      patternState.oneDsIntradayPhase = "regen";
      console.log("[1DS Intraday] 보드 재생성 시작");
      const regenScript = path.join(ROOT, "boards", "oneDaySurge", "one-day-surge-board.js");
      const regenRes = await new Promise((resolve) => {
        const proc = spawn("node", [regenScript], { cwd: ROOT });
        let stderr = "";
        proc.stdout.on("data", (d) => process.stdout.write("[1DS-BD] " + d.toString()));
        proc.stderr.on("data", (d) => { stderr += d.toString(); process.stderr.write("[1DS-BD ERR] " + d.toString()); });
        proc.on("close", (code) => resolve({ ok: code === 0, code, stderr }));
        proc.on("error", (err) => resolve({ ok: false, code: -1, stderr: err.message }));
      });
      if (!regenRes.ok) {
        const prev = patternState.oneDsIntradayError ? patternState.oneDsIntradayError + " / " : "";
        patternState.oneDsIntradayError = prev + `regen 실패 (exit ${regenRes.code}): ${regenRes.stderr.slice(0, 300)}`;
      }
    } catch (e) {
      patternState.oneDsIntradayError = e.message;
    } finally {
      patternState.refreshing1dsIntraday = false;
      patternState.oneDsIntradayPhase = null;
      patternState.oneDsIntradayFinishedAt = new Date().toISOString();
      console.log(`[1DS Intraday] 완료: 수집 ${patternState.oneDsIntradayCollected}건 / 실패 ${patternState.oneDsIntradayFailed}건` + (patternState.oneDsIntradayError ? ` / 에러: ${patternState.oneDsIntradayError}` : ""));
    }
  })();

  return {
    ok: true,
    message: "1DS 분봉 수집 + 09:30 스캐너 + 보드 재생성 시작 (백그라운드, 약 30초~1분)",
    startedAt: patternState.oneDsIntradayStartedAt,
  };
}

module.exports = {
  patternState,
  BOARD_SCRIPTS,
  startSeed,
  startAnalyze,
  startQvaBacktest,
  refreshPatternCache,
  refreshWatchlistBoard,
  refresh1dsIntraday,
  refreshAllBoards,
  runDailyUpdate,
  PATTERN_RESULT_PATH,
};
