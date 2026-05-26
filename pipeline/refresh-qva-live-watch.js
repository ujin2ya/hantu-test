#!/usr/bin/env node
/**
 * QVA 장중 감시 보드 — 분봉 수집 + 보드 재생성 orchestrator
 *
 * 흐름:
 *   1) qva-live-watch-board.js 1차 실행 → DB(board_signals)에서 최근 20거래일 QVA 후보 추출
 *   2) reports/qva-live-watch-board-result.json 의 candidates[].code 추출
 *   3) collect-1ds-intraday.js --target-date {today} --codes ... --full-day 로 09:00~15:30 분봉 수집
 *   4) qva-live-watch-board.js 재실행 → 분봉 반영
 *
 * 사용:
 *   node pipeline/refresh-qva-live-watch.js                       # 기본 (single endHour=100000 → 09:00~10:00)
 *   node pipeline/refresh-qva-live-watch.js --end-hour 130000     # 13:00까지
 *   node pipeline/refresh-qva-live-watch.js --end-hour 153000     # 15:30까지
 *
 * 호출처:
 *   scheduledJobs.js 의 장중 cron (09:35 / 12:30 / 15:30) — 평일. 각 cron이 시각에 맞는 --end-hour 지정.
 *   16:35 BOARD_SCRIPTS 의 qva-live-watch-board.js 는 별도 (collect 없이 보드만 재생성, 15:30 cron 결과 사용).
 *
 * 가드:
 *   - 동시 실행 방지 lockfile (`reports/.qva-live-watch.lock`). 직전 실행이 종료 안 됐으면 즉시 종료.
 *   - collect-1ds-intraday.js 의 skip-if-exists (lastBar >= endHour-5분) 로 같은 endHour 재실행 시 재수집 안 함.
 *
 * KIS 부담:
 *   single endHour = 종목당 1 KIS 호출. 416종 × 1 × 350ms ≈ 2.4분. 3 runs/day ≈ 7분 collect time.
 *   (--full-day 대비 75% 감소). 단 KIS API가 endHour 기준 120 bars만 반환하므로 12:30/15:30 cron은
 *   해당 시점 직전 ~2시간 bars만 가져옴. collector 가 기존 파일과 merge 해서 cumulative 데이터 유지.
 *   09:35-10:30 / 12:30-13:30 시간대 bars는 갭으로 남을 수 있음 (그 갭 동안 board 의 high/low/volume 일부 누락).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BOARD_SCRIPT   = path.join(ROOT, 'boards', 'qva', 'qva-live-watch-board.js');
const COLLECT_SCRIPT = path.join(ROOT, 'pipeline', 'collect-1ds-intraday.js');
const RESULT_JSON    = path.join(ROOT, 'reports', 'qva-live-watch-board-result.json');
const LOCK_FILE      = path.join(ROOT, 'reports', '.qva-live-watch.lock');

function todayKstYmdDash() {
  const utcNow = Date.now();
  const kst = new Date(utcNow + 9 * 3600 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
      const ageMs = Date.now() - new Date(lock.startedAt).getTime();
      if (ageMs < 30 * 60 * 1000) {
        console.error(`[refresh-qva-live-watch] 이미 실행 중 (lock pid=${lock.pid} startedAt=${lock.startedAt}, ${Math.round(ageMs / 1000)}s 경과). 종료.`);
        return false;
      }
      console.warn(`[refresh-qva-live-watch] stale lock 발견 (${Math.round(ageMs / 1000)}s 경과) — 재획득`);
    } catch (_) { /* 깨진 lock은 덮어쓰기 */ }
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  return true;
}
function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (_) {}
}
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

function runScript(label, script, args = []) {
  return new Promise((resolve) => {
    console.log(`\n[refresh-qva-live-watch] ▶ ${label}`);
    const t0 = Date.now();
    const proc = spawn('node', [script, ...args], { stdio: 'inherit', cwd: ROOT });
    proc.on('close', (code) => {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`[refresh-qva-live-watch] ✅ ${label} (${dt}s)`);
        resolve(true);
      } else {
        console.error(`[refresh-qva-live-watch] ❌ ${label} exit=${code} (${dt}s)`);
        resolve(false);
      }
    });
    proc.on('error', (err) => {
      console.error(`[refresh-qva-live-watch] ❌ ${label} spawn 에러: ${err.message}`);
      resolve(false);
    });
  });
}

// CLI: --end-hour HHMMSS (single endHour 모드, full-day 대신)
function parseArgs(argv) {
  let endHour = '100000';
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--end-hour') endHour = argv[++i];
  }
  return { endHour };
}

(async function main() {
  const tStart = Date.now();
  const { endHour } = parseArgs(process.argv);
  console.log(`\n🎯 refresh-qva-live-watch 시작 — ${new Date().toLocaleString('ko-KR')} (end-hour=${endHour})`);

  if (!acquireLock()) process.exit(0);

  try {
    // Phase 1: 보드 1차 실행 — DB → 후보 코드 추출
    const ok1 = await runScript('Phase 1 (보드 1차, DB 조회)', BOARD_SCRIPT);
    if (!ok1 || !fs.existsSync(RESULT_JSON)) {
      console.error('[refresh-qva-live-watch] Phase 1 실패 또는 result JSON 없음 — 종료');
      process.exit(1);
    }

    let codes = [];
    try {
      const j = JSON.parse(fs.readFileSync(RESULT_JSON, 'utf-8'));
      codes = (j.candidates || []).map((c) => c.code).filter(Boolean);
    } catch (e) {
      console.error(`[refresh-qva-live-watch] result JSON 파싱 실패: ${e.message}`);
      process.exit(1);
    }

    if (codes.length === 0) {
      console.log('[refresh-qva-live-watch] 후보 0건 — 분봉 수집 스킵, 종료');
      return;
    }

    // collect-1ds-intraday.js --codes 모드는 targetDate의 차트 row를 찾아 D+1을 수집한다.
    // 당일 차트가 아직 없으므로 오늘(KST) 대신 차트 최신 거래일을 baseDate로 전달해야 한다.
    const CHART_DIR_PATH = path.join(ROOT, 'cache', 'stock-charts-long');
    let chartLatest = null;
    for (const code of codes.slice(0, 5)) {
      try {
        const chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR_PATH, code + '.json'), 'utf-8'));
        const rows = (chart.rows || chart).filter(r => r.volume > 0);
        const last = rows[rows.length - 1];
        if (last && last.date) { const d = String(last.date); chartLatest = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`; break; }
      } catch (_) {}
    }
    const targetDate = chartLatest || todayKstYmdDash();
    console.log(`[refresh-qva-live-watch] 후보 ${codes.length}건 / target-date=${targetDate} (chart latest 기준)`);

    // Phase 2: 분봉 수집 (single endHour 모드)
    // spawn 으로 args 배열 전달 — shell 파싱 안 거치므로 codes 리스트 길이 제약 없음.
    // endHour 에서 windowTo / skip 자동 추출. 기존 파일과 merge 되어 cumulative.
    const ok2 = await runScript(
      `Phase 2 (분봉 수집, ${codes.length}종, end-hour=${endHour})`,
      COLLECT_SCRIPT,
      ['--target-date', targetDate, '--codes', codes.join(','), '--end-hour', endHour, '--sleep', '350']
    );
    if (!ok2) {
      console.warn('[refresh-qva-live-watch] Phase 2 실패 — 그래도 Phase 3 (보드 재실행)는 진행');
    }

    // Phase 3: 보드 재실행 — 분봉 반영
    await runScript('Phase 3 (보드 재실행)', BOARD_SCRIPT);

    console.log(`\n✅ refresh-qva-live-watch 완료 (${((Date.now() - tStart) / 1000).toFixed(1)}s)`);
  } finally {
    releaseLock();
  }
})();
