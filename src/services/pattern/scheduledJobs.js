// 일일 cron 스케줄 — 16:10 분석 / 16:20 일일 갱신(평일) / 16:35 보드 갱신(평일, 1DS 포함 7개) / 평일 09:00~15:30 매 30분 시장 상태 라이브 / 평일 09:30 1DS 분봉+보드+스냅샷 / 평일 09:42 1DS 공격형 TOP 재판단 / 평일 10:01·10:03·10:05 1DS 10시 생존 확인 3중 retry / 평일 10:06 1DS 메일(MAIL_CRON_ENABLED).
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const cron = require("node-cron");
const patternScreener = require("../../../screeners/pattern-screener");
const { ROOT, CACHE_DIR, REPORTS_DIR } = require("../../utils/paths");
const { patternState, PATTERN_RESULT_PATH, BOARD_SCRIPTS, refresh1dsIntraday, refresh1dsSurvivor1000 } = require("./adminTriggers");
const { sendOneDaySurgeMail } = require("../mail/oneDaySurgeMail");
const { updateLiveMarketState } = require("../marketState/marketStateLive");

const ONE_DAY_SURGE_RESULT_PATH = path.join(REPORTS_DIR, "one-day-surge-board-result.json");

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
      const scriptPath = path.join(ROOT, "pipeline", "run-daily-analysis.js");
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

  // 16:35 평일 — 전체 보드 갱신 (QVA + QVA 고점 재돌파 + D+5 재돌파 운용 + QVA2 × 3)
  // 1DS는 09:30/10:01·03·05 cron 전용. 장 마감 후 1DS 보드를 다시 만들 의미 없음 (장전 보조 후보 제거됨).
  // 각 보드를 순차 실행. 한 보드가 실패해도 다음 보드로 진행해서 부분 갱신은 보장한다.
  cron.schedule("35 16 * * 1-5", () => {
    console.log(`[Boards] 16:35 시작 — 전체 보드 갱신 (${BOARD_SCRIPTS.length}개)`);
    let okCount = 0, failCount = 0;
    for (const s of BOARD_SCRIPTS) {
      try {
        const scriptPath = path.join(ROOT, s.file);
        const t0 = Date.now();
        execSync(`node ${scriptPath}`, { stdio: "pipe" });
        const elapsed = Date.now() - t0;
        console.log(`[Boards] ✅ ${s.name} (${elapsed}ms)`);
        okCount++;
      } catch (e) {
        console.error(`[Boards] ❌ ${s.name}: ${e.message.slice(0, 200)}`);
        failCount++;
      }
    }
    console.log(`[Boards] 16:35 완료 — 성공 ${okCount} / 실패 ${failCount}`);
  }, { scheduled: true, timezone: "Asia/Seoul" });
  console.log(`[스케줄] 매일 평일 16:35 전체 보드 갱신 활성화 (${BOARD_SCRIPTS.length}개 — QVA + QVA 고점 재돌파 + D+5 재돌파 운용 + QVA2 × 3 + 1DS)`);

  // 16:40 평일 — DB 신호 후속 작업: outcomes 채우기 + signal_links 재정렬
  // (보드 generators 16:35 완료 후 ~5분 마진. 같은 cron 안에서 순차 실행)
  cron.schedule("40 16 * * 1-5", () => {
    console.log("[DB] 16:40 시작 — populate-signal-outcomes + reconcile-signal-links");
    try {
      const t0 = Date.now();
      execSync(`node ${path.join(ROOT, "pipeline/populate-signal-outcomes.js")}`, { stdio: "pipe" });
      console.log(`[DB] ✅ populate-signal-outcomes (${Date.now() - t0}ms)`);
    } catch (e) {
      console.error(`[DB] ❌ populate-signal-outcomes: ${String(e.message || e).slice(0, 200)}`);
    }
    try {
      const t0 = Date.now();
      execSync(`node ${path.join(ROOT, "pipeline/reconcile-signal-links.js")}`, { stdio: "pipe" });
      console.log(`[DB] ✅ reconcile-signal-links (${Date.now() - t0}ms)`);
    } catch (e) {
      console.error(`[DB] ❌ reconcile-signal-links: ${String(e.message || e).slice(0, 200)}`);
    }
    console.log("[DB] 16:40 완료");
  }, { scheduled: true, timezone: "Asia/Seoul" });
  console.log("[스케줄] 매일 평일 16:40 DB outcomes + signal_links 갱신 활성화 (한국 시간)");

  // 평일 09:30:00 — 1DS 분봉 수집 + 보드 재생성
  // 사용자가 09:30 정각에 보드 새로고침할 때 분봉 반영된 후보를 보도록 정각에 시작.
  // KIS API의 09:30 1분봉 반영이 약간 지연되더라도 collect retry로 흡수, 보통 09:30:15~30 사이 완료.
  // 사용자는 09:30:30 정도에 새로고침하면 분봉 반영 결과 확인 가능.
  cron.schedule("0 30 9 * * 1-5", () => {
    console.log("[1DS Intraday cron] 09:30 시작");
    const r = refresh1dsIntraday();
    if (!r.ok) console.warn("[1DS Intraday cron] 실행 거부:", r.message);
  }, { scheduled: true, timezone: "Asia/Seoul" });
  console.log("[스케줄] 평일 09:30 1DS 분봉 수집 + 보드 재생성 활성화 (한국 시간)");

  // 평일 09:42 — 1DS 공격형 TOP 재판단
  // 09:30 cron이 생성한 분봉은 마지막 bar가 09:30이라 rebreakMorningHigh 조건(decisionTime >= '09:40')을 충족 못함.
  // 09:42에 재실행하면 collect가 09:30 파일을 skip하지 않고(last bar < 09:55) 09:41 bar까지 재취득 →
  // decisionTime ≈ '09:41' ≥ '09:40' 이 되어 공격형 TOP 후보가 정상 계산됨.
  cron.schedule("0 42 9 * * 1-5", () => {
    console.log("[1DS AttackTop cron] 09:42 시작 — 09:40 이후 분봉 재취득 + 공격형 TOP 재판단");
    const r = refresh1dsIntraday();
    if (!r.ok) console.warn("[1DS AttackTop cron] 실행 거부:", r.message);
  }, { scheduled: true, timezone: "Asia/Seoul" });
  console.log("[스케줄] 평일 09:42 1DS 공격형 TOP 재판단 활성화 (한국 시간)");

  // 평일 09:00 ~ 15:30 매 30분 — 시장 상태 라이브 (KOSPI/KOSDAQ 실시간 변화율)
  // 기존 cache/kospi-daily.json은 전일 종가 vs 그 전일 종가만 봤기 때문에 장중 흐름 변화를 반영 못 함.
  // (예: 09:00 +1.5% → 14:00 -0.8%로 바뀐 상황을 보드가 못 봄)
  // Naver 실시간 polling API로 지수 현재가/변화율을 받아 cache/market-state-live.json에 저장.
  // 보드는 이 파일을 우선 읽고 신선도가 35분 이내면 사용, 그 외엔 daily fallback.
  cron.schedule("*/30 9-15 * * 1-5", async () => {
    try { await updateLiveMarketState(); }
    catch (e) { console.error("[marketStateLive cron] 에러:", e.message); }
  }, { scheduled: true, timezone: "Asia/Seoul" });
  console.log("[스케줄] 평일 09:00~15:30 매 30분 시장 상태 라이브 업데이트 활성화 (한국 시간)");

  // 평일 10:01 / 10:03 / 10:05 — 1DS 10시 생존 확인 (60거래일 검증 1위 모델, 3회 retry)
  // 한 번만 돌리면 KIS 분봉이 늦게 도착해 일부 종목 10:00 분봉을 못 받는 timing race 가능.
  // 멱등 collect (skip-if-exists, 마지막 bar ≥ 09:55면 skip) 덕에 중복 KIS 호출 없음 —
  // 첫 cron이 늦게 도착한 분봉을 놓치면 다음 cron이 보충, 그 다음 cron이 또 보충하는 3중 안전망.
  // 각 cron은 refresh1dsSurvivor1000 내부 가드(이미 실행 중이면 거부)로 중첩 실행 방지.
  for (const minute of [1, 3, 5]) {
    cron.schedule(`0 ${minute} 10 * * 1-5`, () => {
      console.log(`[1DS Survivor cron] 10:${String(minute).padStart(2, '0')} — 10시 생존 확인 시작`);
      const r = refresh1dsSurvivor1000();
      if (!r.ok) console.warn(`[1DS Survivor cron] 10:${String(minute).padStart(2, '0')} 실행 거부:`, r.message);
    }, { scheduled: true, timezone: "Asia/Seoul" });
  }
  console.log("[스케줄] 평일 10:01 / 10:03 / 10:05 — 1DS 10시 생존 확인 3중 retry 활성화 (한국 시간)");

  // 평일 10:06 — 1-Day Surge 보드 메일 (MAIL_CRON_ENABLED=1 일 때만)
  // 10:05 마지막 survivor1000 cron이 끝난 후 약 60초 마진을 두고 발송.
  // 1DS 운영 철학 변경 (2026-05-14): 09:30 예선 시점에 메일 보내봤자 절반 이상이 10시 전에 무너지므로
  // 10시 본선 확인 후 발송으로 변경. 사용자가 보는 후보 = 실제 진입 검토 1순위.
  // 10:02 → 10:06 (2026-05-15): 10:01/03/05 3중 retry 후 안정된 결과를 보내기 위해 마진 확장.
  // 평일 06:30 — 미국 NYSE 정규장 종료 후 나스닥 테마 강도 fetch + 나스닥 테마 watch 보드 재생성
  // NYSE close: 16:00 ET → EDT 기간(3월 둘째 일요일~11월 첫째 일요일) KST 05:00, EST 기간 KST 06:00.
  // 06:30 KST = EDT 마감 1.5h 후 / EST 마감 30분 후 — 양쪽 다 quote 데이터 안정화 후.
  cron.schedule("0 30 6 * * 1-5", () => {
    console.log("[Nasdaq Theme] 06:30 시작 — FMP/Yahoo fetch + watch 보드 재생성");
    try {
      const t0 = Date.now();
      execSync(`node ${path.join(ROOT, "scripts/fetch-nasdaq-theme-daily.js")}`, { stdio: "pipe" });
      console.log(`[Nasdaq Theme] ✅ fetch (${Date.now() - t0}ms)`);
    } catch (e) {
      console.error(`[Nasdaq Theme] ❌ fetch: ${String(e.message || e).slice(0, 200)}`);
    }
    try {
      const t0 = Date.now();
      execSync(`node ${path.join(ROOT, "boards/theme/nasdaq-theme-watch-board.js")}`, { stdio: "pipe" });
      console.log(`[Nasdaq Theme] ✅ 보드 재생성 (${Date.now() - t0}ms)`);
    } catch (e) {
      console.error(`[Nasdaq Theme] ❌ 보드 재생성: ${String(e.message || e).slice(0, 200)}`);
    }
    try {
      const t0 = Date.now();
      execSync(`node ${path.join(ROOT, "boards/theme/build-theme-1ds-watch-pool.js")}`, { stdio: "pipe" });
      console.log(`[Nasdaq Theme] ✅ 1DS 감시 후보풀 빌드 (${Date.now() - t0}ms)`);
    } catch (e) {
      console.error(`[Nasdaq Theme] ❌ 후보풀 빌드: ${String(e.message || e).slice(0, 200)}`);
    }
    console.log("[Nasdaq Theme] 06:30 완료");
  }, { scheduled: true, timezone: "Asia/Seoul" });
  console.log("[스케줄] 매일 평일 06:30 나스닥 테마 fetch + watch 보드 재생성 활성화 (미국장 마감 후, 한국 시간)");

  // ─── (이전 1DS 메일 cron 블록 보존) ────────────────────────────────────
  if (process.env.MAIL_CRON_ENABLED === "1") {
    cron.schedule("0 6 10 * * 1-5", async () => {
      console.log("[1DS메일] 10:06 — one-day-surge-board-result.json 기반 (10시 생존 3중 확인 후) 메일 발송 시작");
      try {
        if (!fs.existsSync(ONE_DAY_SURGE_RESULT_PATH)) {
          console.log("[1DS메일] one-day-surge-board-result.json 없음 — 스킵");
          return;
        }
        const result = JSON.parse(fs.readFileSync(ONE_DAY_SURGE_RESULT_PATH, "utf-8"));
        await sendOneDaySurgeMail(result);
      } catch (e) {
        console.error("[1DS메일] 에러:", e.message);
      }
    }, { scheduled: true, timezone: "Asia/Seoul" });
    console.log("[스케줄] 평일 10:06 1DS 단타 후보 메일 자동 발송 활성화 — 10시 생존 3중 확인 후 (한국 시간)");
  }
}

module.exports = { registerSchedules };
