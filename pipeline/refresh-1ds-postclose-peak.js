#!/usr/bin/env node
/**
 * 1DS — 장마감 후 mainResult 정확 peak time 보강
 *
 * 배경:
 *   09:30 1DS cron은 09:00~10:00 분봉만 수집. 그래서 mainResult 카드의 dayHigh가 10:00 이후
 *   발생한 경우 (예: 이랜텍 5/21 — 분봉 max 13700 @ 09:39 vs 일봉 dayHigh 13880)
 *   peakTime 표시가 부정확 ('10:00 이후 갱신' 라벨로 떨어짐).
 *
 * 흐름:
 *   1) reports/one-day-surge-board-result.json 의 mainResult 코드 (~30종) 추출
 *   2) collect-1ds-intraday.js --codes ... --full-day --target-date today
 *      → 09:00~15:30 전체 분봉 수집 (mainResult 종목만)
 *   3) one-day-surge-board.js 재실행 → getPeakTroughTime 이 full-day 분봉 보고 정확 peakTime 반환
 *
 * KIS 부담:
 *   mainResult ~30종 × full-day 4 calls × 350ms ≈ 42초.
 *
 * 호출:
 *   node pipeline/refresh-1ds-postclose-peak.js
 *
 * cron: 평일 16:42 (BOARD_SCRIPTS 16:35 완료 후 ~7분 마진).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BOARD_SCRIPT = path.join(ROOT, 'boards', 'oneDaySurge', 'one-day-surge-board.js');
const COLLECT_SCRIPT = path.join(ROOT, 'pipeline', 'collect-1ds-intraday.js');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const RESULT_JSON = path.join(ROOT, 'reports', 'one-day-surge-board-result.json');
const LOCK_FILE = path.join(ROOT, 'reports', '.1ds-postclose-peak.lock');

function todayKstYmdNum() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`;
}

// collect-1ds-intraday.js 의 --target-date 는 "D-day (= baseDate, intraday 전일)" 의미.
// nextDate = D+1 = intraday 대상일. 오늘 분봉 수집하려면 어제 영업일을 전달해야 함.
// 차트 cache (005930 삼성전자)의 row 중 intraday 대상일(=today)의 직전 row date 를 찾는다.
function findPrevBusinessDate(intradayTargetYmd) {
  const sampleCodes = ['005930', '000660', '035720']; // 삼성, 하이닉스, 카카오 — 하나라도 chart 있으면 OK
  for (const code of sampleCodes) {
    const fp = path.join(CHART_DIR, code + '.json');
    if (!fs.existsSync(fp)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      const rows = j.rows || [];
      // intraday 대상일과 일치하는 row 찾기
      let idx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].date === intradayTargetYmd) { idx = i; break; }
      }
      if (idx > 0) return rows[idx - 1].date;
      // 매칭 row 없으면 chart 의 마지막 row 가 어제 영업일 (intraday 대상일이 아직 차트에 없음 — 09:30 시점 등)
      if (idx < 0 && rows.length > 0) return rows[rows.length - 1].date;
    } catch (_) {}
  }
  return null;
}
function ymdToDash(s) { return s ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : null; }

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
      const ageMs = Date.now() - new Date(lock.startedAt).getTime();
      if (ageMs < 15 * 60 * 1000) {
        console.error(`[1DS-postclose] 이미 실행 중 (pid=${lock.pid}, ${Math.round(ageMs/1000)}s 경과) — 종료`);
        return false;
      }
      console.warn(`[1DS-postclose] stale lock 재획득`);
    } catch (_) {}
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  return true;
}
function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (_) {}
}
process.on('exit', releaseLock);
process.on('SIGINT',  () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

function runScript(label, script, args = []) {
  return new Promise((resolve) => {
    console.log(`\n[1DS-postclose] ▶ ${label}`);
    const t0 = Date.now();
    const proc = spawn('node', [script, ...args], { stdio: 'inherit', cwd: ROOT });
    proc.on('close', (code) => {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (code === 0) { console.log(`[1DS-postclose] ✅ ${label} (${dt}s)`); resolve(true); }
      else { console.error(`[1DS-postclose] ❌ ${label} exit=${code} (${dt}s)`); resolve(false); }
    });
    proc.on('error', (err) => { console.error(`[1DS-postclose] spawn 에러:`, err.message); resolve(false); });
  });
}

(async function main() {
  const tStart = Date.now();
  console.log(`\n🎯 1DS 장마감 후 정확 peak 갱신 — ${new Date().toLocaleString('ko-KR')}`);
  if (!acquireLock()) process.exit(0);

  try {
    if (!fs.existsSync(RESULT_JSON)) {
      console.error('[1DS-postclose] one-day-surge-board-result.json 없음 — 1DS 보드 먼저 실행되어야 함');
      process.exit(1);
    }

    const j = JSON.parse(fs.readFileSync(RESULT_JSON, 'utf-8'));
    const mr = j.todayResultCandidates?.mainResult || [];
    // mainResult 종목 외에도 attackTopHighRisk / attackTopCandidates(NORMAL) / 실제 카드 노출 종목도 포함하면 더 안전.
    const additional = []
      .concat((j.attackTopCandidates || []).map(c => c.code))
      .concat((j.attackTopHighRisk || []).map(c => c.code))
      .concat((j.priorityRanked?.scanner0930?.survivor1000 || []).map(c => c.code))
      .concat((j.priorityRanked?.scanner0930?.attackRebreak || []).map(c => c.code))
      .concat((j.priorityRanked?.scanner0930?.explosiveStable || []).map(c => c.code))
      .filter(Boolean);
    const codes = [...new Set([...mr.map(x => x.code).filter(Boolean), ...additional])];

    if (codes.length === 0) {
      console.log('[1DS-postclose] 대상 종목 0건 — 종료');
      return;
    }
    // collect 스크립트는 target-date 를 D-day (= 어제, intraday 전일) 로 해석. 오늘 분봉 받으려면 어제 영업일 필요.
    const todayYmd = todayKstYmdNum();
    const prevYmd = findPrevBusinessDate(todayYmd);
    if (!prevYmd) {
      console.error('[1DS-postclose] 직전 영업일 결정 실패 — 종료');
      process.exit(1);
    }
    const targetDate = ymdToDash(prevYmd);
    console.log(`[1DS-postclose] 대상 ${codes.length}종 / collect target-date=${targetDate} (intraday 대상일=${ymdToDash(todayYmd)})`);

    // Phase 1: full-day 분봉 수집 (기존 분봉과 merge 됨 — collect 가 merge 로직 가짐)
    const ok1 = await runScript(
      `Phase 1 (full-day 분봉 수집 ${codes.length}종)`,
      COLLECT_SCRIPT,
      ['--target-date', targetDate, '--codes', codes.join(','), '--full-day', '--sleep', '350']
    );
    if (!ok1) console.warn('[1DS-postclose] Phase 1 실패 — Phase 2는 진행 (이전 분봉으로라도 board 갱신)');

    // Phase 2: 1DS 보드 재실행 — getPeakTroughTime 이 full-day 분봉으로 정확 peakTime 추출
    await runScript('Phase 2 (1DS 보드 재실행)', BOARD_SCRIPT);

    console.log(`\n✅ 완료 (${((Date.now() - tStart) / 1000).toFixed(1)}s)`);
  } finally {
    releaseLock();
  }
})();
