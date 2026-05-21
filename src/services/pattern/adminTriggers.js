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
  oneDsIntradayQuickFinishedAt: null,
  oneDsIntradayCandidatesCollected: 0, oneDsIntradayCandidatesFailed: 0,
  // 1DS 스캐너 + 보드만 재생성 (분봉 수집 X, ~10초) — /admin/regen-1ds-scanner-board
  regen1dsScannerBoard: false, regen1dsScannerBoardStartedAt: null, regen1dsScannerBoardFinishedAt: null,
  regen1dsScannerBoardError: null,
};

// 16:35 cron + admin 트리거가 같은 순서로 갱신하는 보드 스크립트 목록.
// 의존성 순서:
//   - QVA 보드(qva-watchlist-board.json 생성) → D+5 재돌파(QVA 결과 read) → 1DS(독립)
//   - QVA2 watchlist → QVA2 D+5 재돌파(watchlist json read) → QVA2 고점 재돌파(watchlist + VVI2 json read)
// 차트/수급/펀더멘탈 캐시는 16:20 일일 업데이트에서 이미 갱신됨. 보드는 캐시 read만 한다.
// 1DS 보드는 16:35 일괄 cron에서 제외 (2026-05-14): 1DS 운영 철학이 09:30 = 예선 / 10:00 = 본선 모델로
// 변경되면서 장 마감 후 1DS 보드를 다시 만들 이유가 없음. 1DS 보드는 09:30 cron + 10:01 survivor1000 cron으로만 갱신.
const BOARD_SCRIPTS = [
  { name: "QVA Watchlist Board",          file: "boards/qva/qva-watchlist-board.js" },
  { name: "QVA 고점 재돌파 보드",            file: "boards/qva/qva-vvi-redefined-board.js" },
  { name: "D+5 재돌파 운용 보드",            file: "boards/rebreak/hgroup-rebreak-operation-board.js" },
  { name: "QVA2 H그룹/VPR 보드",            file: "boards/qva2/qva2-watchlist-board.js" },
  { name: "QVA2 D+5 재돌파 운용보드",        file: "boards/qva2/qva2-d5-rebreak-board.js" },
  { name: "QVA2 고점 재돌파 보드",           file: "boards/qva2/qva2-vvi-board.js" },
  { name: "1DS 단타 후보 보드",              file: "boards/oneDaySurge/one-day-surge-board.js" },
  // QVA 장중 감시 보드 — DB board_signals (QVA Watchlist + QVA2 H그룹) 수정 후에 와야 오늘 신호까지 반영됨.
  { name: "QVA 장중 감시 보드",              file: "boards/qva/qva-live-watch-board.js" },
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
    message: `전체 보드 갱신 시작 (${BOARD_SCRIPTS.length}개 — QVA + QVA 고점 재돌파 + D+5 재돌파 + QVA2 × 3 + 1DS + QVA 장중 감시, 백그라운드 30~120초 예상)`,
    startedAt: patternState.allBoardsRefreshStartedAt,
  };
}

// 1DS 분봉 수집 + 09:30 스캐너 + 보드 재생성 — cron 평일 09:30:00 + /admin/refresh-1ds-intraday 호출.
//
// 흐름은 quick + full 2단계 (사용자 요구):
//   ── quick (1차, 메일 09:32 발송 보장) ──
//   Phase 1: collect_mainpool      — 보드 mainPool 코드 분봉만 수집 (~15초)
//   Phase 2: scanner_quick         — 0930 스캐너 quick 모드 (~1초)
//   Phase 3: regen_quick           — 1DS 보드 재생성 (~5초)
//   ── full (2차, 백그라운드 — 09:35 전후 완료) ──
//   Phase 4: collect_candidates    — 유동성 통과 종목 priorityScore 상위 N개 분봉 수집 (~1.8분 @ 300개)
//   Phase 5: scanner_full          — 0930 스캐너 full 모드 (확장 결과 반영)
//   Phase 6: regen_full            — 1DS 보드 재생성
//
// 환경변수:
//   ONEDS_SCANNER_LIMIT=300        full 단계 분봉 수집 상한 (기본 300)
//   ONEDS_SCANNER_DISABLED=1       full 단계 비활성화 (KIS 부담 줄이기용 안전 스위치)
function refresh1dsIntraday() {
  if (patternState.refreshing1dsIntraday) {
    return { ok: false, message: "이미 1DS 분봉 수집 중입니다", startedAt: patternState.oneDsIntradayStartedAt };
  }
  patternState.refreshing1dsIntraday = true;
  patternState.oneDsIntradayStartedAt = new Date().toISOString();
  patternState.oneDsIntradayFinishedAt = null;
  patternState.oneDsIntradayQuickFinishedAt = null;
  patternState.oneDsIntradayError = null;
  patternState.oneDsIntradayPhase = "collect_mainpool";
  patternState.oneDsIntradayCollected = 0;
  patternState.oneDsIntradayFailed = 0;
  patternState.oneDsIntradayCandidatesCollected = 0;
  patternState.oneDsIntradayCandidatesFailed = 0;

  const scannerLimit = Number(process.env.ONEDS_SCANNER_LIMIT) || 300;
  const fullDisabled = process.env.ONEDS_SCANNER_DISABLED === "1";

  const COLLECT_SCRIPT  = path.join(ROOT, "pipeline", "collect-1ds-intraday.js");
  const SCANNER_SCRIPT  = path.join(ROOT, "boards", "oneDaySurge", "one-day-surge-0930-scanner.js");
  const BOARD_SCRIPT    = path.join(ROOT, "boards", "oneDaySurge", "one-day-surge-board.js");

  function runStep(label, prefix, script, args) {
    return new Promise((resolve) => {
      const proc = spawn("node", [script, ...(args || [])], { cwd: ROOT });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => { const s = d.toString(); stdout += s; process.stdout.write(prefix + s); });
      proc.stderr.on("data", (d) => { const s = d.toString(); stderr += s; process.stderr.write(prefix + " ERR " + s); });
      proc.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr, label }));
      proc.on("error", (err) => resolve({ ok: false, code: -1, stdout, stderr: err.message, label }));
    });
  }
  function accumulateError(prefix, res) {
    if (!res.ok) {
      const prev = patternState.oneDsIntradayError ? patternState.oneDsIntradayError + " / " : "";
      patternState.oneDsIntradayError = prev + `${prefix} 실패 (exit ${res.code}): ${(res.stderr || "").slice(0, 300)}`;
    }
  }

  (async () => {
    try {
      // ─────── QUICK 단계 ───────
      // Phase 1: mainPool 분봉 수집
      patternState.oneDsIntradayPhase = "collect_mainpool";
      console.log("[1DS] Phase 1: mainPool 분봉 수집");
      const colMainRes = await runStep("collect_mainpool", "[1DS-COL-MP] ", COLLECT_SCRIPT, ["--from-board"]);
      const okMatch = colMainRes.stdout.match(/수집 성공:\s*(\d+)/);
      const failMatch = colMainRes.stdout.match(/실패\/누락:\s*(\d+)/);
      patternState.oneDsIntradayCollected = okMatch ? parseInt(okMatch[1], 10) : 0;
      patternState.oneDsIntradayFailed    = failMatch ? parseInt(failMatch[1], 10) : 0;
      accumulateError("collect_mainpool", colMainRes);

      // Phase 2: 0930 스캐너 (quick)
      patternState.oneDsIntradayPhase = "scanner_quick";
      console.log("[1DS] Phase 2: scanner quick");
      const scQuickRes = await runStep("scanner_quick", "[1DS-SC-Q] ", SCANNER_SCRIPT, ["--mode", "quick"]);
      accumulateError("scanner_quick", scQuickRes);

      // Phase 3: 보드 재생성 (quick — 메일 09:32 시점에 이 결과 사용)
      patternState.oneDsIntradayPhase = "regen_quick";
      console.log("[1DS] Phase 3: regen quick");
      const regenQuickRes = await runStep("regen_quick", "[1DS-BD-Q] ", BOARD_SCRIPT, []);
      accumulateError("regen_quick", regenQuickRes);

      patternState.oneDsIntradayQuickFinishedAt = new Date().toISOString();
      console.log("[1DS] ✅ Quick 완료 — 메일은 이 결과 사용");

      if (fullDisabled) {
        console.log("[1DS] full 단계 비활성화 (ONEDS_SCANNER_DISABLED=1) — 종료");
        return;
      }

      // ─────── FULL 단계 ───────
      // Phase 4: scanner candidates 분봉 수집 (priorityScore 상위 N개, ~1.8분 @ 300)
      patternState.oneDsIntradayPhase = "collect_candidates";
      console.log(`[1DS] Phase 4: scanner candidates 분봉 수집 (limit ${scannerLimit})`);
      const colCandRes = await runStep(
        "collect_candidates",
        "[1DS-COL-CA] ",
        COLLECT_SCRIPT,
        ["--from-scanner-candidates", "--scanner-limit", String(scannerLimit)]
      );
      const okMatchC = colCandRes.stdout.match(/수집 성공:\s*(\d+)/);
      const failMatchC = colCandRes.stdout.match(/실패\/누락:\s*(\d+)/);
      patternState.oneDsIntradayCandidatesCollected = okMatchC ? parseInt(okMatchC[1], 10) : 0;
      patternState.oneDsIntradayCandidatesFailed    = failMatchC ? parseInt(failMatchC[1], 10) : 0;
      accumulateError("collect_candidates", colCandRes);

      // Phase 5: 0930 스캐너 (full — 확장 분봉 반영)
      patternState.oneDsIntradayPhase = "scanner_full";
      console.log("[1DS] Phase 5: scanner full");
      const scFullRes = await runStep(
        "scanner_full",
        "[1DS-SC-F] ",
        SCANNER_SCRIPT,
        ["--mode", "full", "--candidates-target", String(scannerLimit)]
      );
      accumulateError("scanner_full", scFullRes);

      // Phase 6: 보드 재생성 (full)
      patternState.oneDsIntradayPhase = "regen_full";
      console.log("[1DS] Phase 6: regen full");
      const regenFullRes = await runStep("regen_full", "[1DS-BD-F] ", BOARD_SCRIPT, []);
      accumulateError("regen_full", regenFullRes);

      console.log("[1DS] ✅ Full 완료");
    } catch (e) {
      patternState.oneDsIntradayError = e.message;
    } finally {
      patternState.refreshing1dsIntraday = false;
      patternState.oneDsIntradayPhase = null;
      patternState.oneDsIntradayFinishedAt = new Date().toISOString();
      console.log(`[1DS Intraday] 완료: mainPool ${patternState.oneDsIntradayCollected}건 / candidates ${patternState.oneDsIntradayCandidatesCollected}건` + (patternState.oneDsIntradayError ? ` / 에러: ${patternState.oneDsIntradayError}` : ""));
    }
  })();

  return {
    ok: true,
    message: `1DS Quick+Full 흐름 시작 (백그라운드 — quick ~30s, full 추가 ~${Math.round(scannerLimit * 0.35 / 60)}분, limit ${scannerLimit})`,
    startedAt: patternState.oneDsIntradayStartedAt,
  };
}

// 1DS 10시 생존 확인 cron — 60거래일 검증 1위 모델 (READY + 10시 생존)
// 흐름:
//   Phase 1: collect_for_survivor — 09:30 READY 후보 + explosiveTop + attackRebreak 후보의 09:00~10:00 분봉 수집
//   Phase 2: scanner_full         — 스캐너 재실행 (10:00 분봉 반영 → survivor1000 채워짐)
//   Phase 3: regen                — 보드 재생성 (메인 섹션이 비어있던 → 생존 후보로 채워짐)
//
// KIS API 부담 줄이기 — 전체 300개 재수집 X. mainPool + scanner candidates 그대로 사용
// (이미 09:30 cron에서 받은 분봉 + 10:00까지의 추가 분봉만 fetch).
function refresh1dsSurvivor1000() {
  if (patternState.refreshing1dsSurvivor1000) {
    return { ok: false, message: "이미 1DS 10시 생존 확인 중입니다", startedAt: patternState.oneDsSurvivor1000StartedAt };
  }
  patternState.refreshing1dsSurvivor1000 = true;
  patternState.oneDsSurvivor1000StartedAt = new Date().toISOString();
  patternState.oneDsSurvivor1000FinishedAt = null;
  patternState.oneDsSurvivor1000Error = null;
  patternState.oneDsSurvivor1000Phase = "collect_for_survivor";

  const scannerLimit = Number(process.env.ONEDS_SCANNER_LIMIT) || 300;
  const COLLECT_SCRIPT  = path.join(ROOT, "pipeline", "collect-1ds-intraday.js");
  const SCANNER_SCRIPT  = path.join(ROOT, "boards", "oneDaySurge", "one-day-surge-0930-scanner.js");
  const BOARD_SCRIPT    = path.join(ROOT, "boards", "oneDaySurge", "one-day-surge-board.js");

  function runStep(label, prefix, script, args) {
    return new Promise((resolve) => {
      const proc = spawn("node", [script, ...(args || [])], { cwd: ROOT });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => { const s = d.toString(); stdout += s; process.stdout.write(prefix + s); });
      proc.stderr.on("data", (d) => { const s = d.toString(); stderr += s; process.stderr.write(prefix + " ERR " + s); });
      proc.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr, label }));
      proc.on("error", (err) => resolve({ ok: false, code: -1, stdout, stderr: err.message, label }));
    });
  }
  function accumulate(prefix, res) {
    if (!res.ok) {
      const prev = patternState.oneDsSurvivor1000Error ? patternState.oneDsSurvivor1000Error + " / " : "";
      patternState.oneDsSurvivor1000Error = prev + `${prefix} 실패 (exit ${res.code}): ${(res.stderr || "").slice(0, 300)}`;
    }
  }

  (async () => {
    try {
      // Phase 1: 09:00~10:00 분봉 수집 (--from-scanner-candidates, endHour=100000=10:00).
      //          이미 09:30 cron에서 받은 파일은 멱등 skip되므로 추가분만 fetch.
      patternState.oneDsSurvivor1000Phase = "collect_for_survivor";
      console.log("[1DS Survivor] Phase 1: 분봉 수집 (09:00~10:00, scanner candidates)");
      const col = await runStep(
        "collect_for_survivor",
        "[1DS-SV-COL] ",
        COLLECT_SCRIPT,
        ["--from-scanner-candidates", "--scanner-limit", String(scannerLimit), "--end-hour", "100000"]
      );
      accumulate("collect_for_survivor", col);

      // Phase 2: scanner 재실행 (10:00 분봉 반영 — survivor1000 검사)
      patternState.oneDsSurvivor1000Phase = "scanner";
      console.log("[1DS Survivor] Phase 2: scanner 재실행");
      const sc = await runStep("scanner", "[1DS-SV-SC] ", SCANNER_SCRIPT, ["--mode", "full", "--candidates-target", String(scannerLimit)]);
      accumulate("scanner", sc);

      // Phase 3: 보드 재생성 (10시 생존 섹션 채워짐)
      patternState.oneDsSurvivor1000Phase = "regen";
      console.log("[1DS Survivor] Phase 3: 보드 재생성");
      const bd = await runStep("regen", "[1DS-SV-BD] ", BOARD_SCRIPT, []);
      accumulate("regen", bd);

      console.log("[1DS Survivor] ✅ 10시 생존 확인 완료");
    } catch (e) {
      patternState.oneDsSurvivor1000Error = e.message;
    } finally {
      patternState.refreshing1dsSurvivor1000 = false;
      patternState.oneDsSurvivor1000Phase = null;
      patternState.oneDsSurvivor1000FinishedAt = new Date().toISOString();
    }
  })();

  return {
    ok: true,
    message: `1DS 10시 생존 확인 시작 (백그라운드, scanner candidates 분봉 09:00~10:00 보강 + scanner + board regen)`,
    startedAt: patternState.oneDsSurvivor1000StartedAt,
  };
}

// 1DS 스캐너 + 1DS 보드만 재생성 (KIS 분봉 수집 X). 이미 수집된 분봉으로 빠르게 결과만 새로 보고 싶을 때.
// `node boards/oneDaySurge/one-day-surge-0930-scanner.js --mode full --candidates-target 300`
// `node boards/oneDaySurge/one-day-surge-board.js` 와 동일.
function regen1dsScannerBoard() {
  if (patternState.regen1dsScannerBoard) {
    return { ok: false, message: "이미 스캐너+보드 재생성 중입니다", startedAt: patternState.regen1dsScannerBoardStartedAt };
  }
  patternState.regen1dsScannerBoard = true;
  patternState.regen1dsScannerBoardStartedAt = new Date().toISOString();
  patternState.regen1dsScannerBoardFinishedAt = null;
  patternState.regen1dsScannerBoardError = null;

  const scannerLimit = Number(process.env.ONEDS_SCANNER_LIMIT) || 300;
  const SCANNER_SCRIPT = path.join(ROOT, "boards", "oneDaySurge", "one-day-surge-0930-scanner.js");
  const BOARD_SCRIPT   = path.join(ROOT, "boards", "oneDaySurge", "one-day-surge-board.js");

  function runStep(label, prefix, script, args) {
    return new Promise((resolve) => {
      const proc = spawn("node", [script, ...(args || [])], { cwd: ROOT });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => { const s = d.toString(); stdout += s; process.stdout.write(prefix + s); });
      proc.stderr.on("data", (d) => { const s = d.toString(); stderr += s; process.stderr.write(prefix + " ERR " + s); });
      proc.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr, label }));
      proc.on("error", (err) => resolve({ ok: false, code: -1, stdout, stderr: err.message, label }));
    });
  }
  function accumulate(prefix, res) {
    if (!res.ok) {
      const prev = patternState.regen1dsScannerBoardError ? patternState.regen1dsScannerBoardError + " / " : "";
      patternState.regen1dsScannerBoardError = prev + `${prefix} 실패 (exit ${res.code}): ${(res.stderr || "").slice(0, 300)}`;
    }
  }

  (async () => {
    try {
      console.log("[1DS Regen] Phase 1: scanner full");
      const sc = await runStep("scanner_full", "[1DS-SC-F] ", SCANNER_SCRIPT, ["--mode", "full", "--candidates-target", String(scannerLimit)]);
      accumulate("scanner_full", sc);

      console.log("[1DS Regen] Phase 2: board regen");
      const bd = await runStep("regen_full", "[1DS-BD-F] ", BOARD_SCRIPT, []);
      accumulate("regen_full", bd);

      console.log("[1DS Regen] ✅ 완료");
    } catch (e) {
      patternState.regen1dsScannerBoardError = e.message;
    } finally {
      patternState.regen1dsScannerBoard = false;
      patternState.regen1dsScannerBoardFinishedAt = new Date().toISOString();
    }
  })();

  return {
    ok: true,
    message: `1DS 스캐너+보드 재생성 시작 (백그라운드, ~10초). 분봉 수집은 안 함 — 이미 받아둔 분봉으로 결과만 새로 만듦.`,
    startedAt: patternState.regen1dsScannerBoardStartedAt,
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
  refresh1dsSurvivor1000,
  regen1dsScannerBoard,
  refreshAllBoards,
  runDailyUpdate,
  PATTERN_RESULT_PATH,
};
