// /one-day-surge-board (라이브 보드) sendFile.
// /one-day-surge-board/backtest — 09:30 스캐너 백테스트 결과 리포트.
// /api/one-day-surge/live-entry-check — 클릭한 종목만 현재 진입 가능 여부 분석.
const fs = require("fs");
const path = require("path");
const { REPORTS_DIR } = require("../utils/paths");
const { analyzeLiveEntryFor1dsSurvivor, analyzeLiveEntrySimplified } = require("../services/oneDaySurge/liveEntryCheck");

const SIMPLIFIED_SECTIONS = new Set(['watchOnly', 'explosiveStable', 'attackRebreak']);

const BOARD_HTML = path.join(REPORTS_DIR, "one-day-surge-board-result.html");
const BACKTEST_HTML = path.join(REPORTS_DIR, "one-day-surge-0930-scanner-backtest-result.html");
const EXPLOSIVE_HTML = path.join(REPORTS_DIR, "one-day-surge-0930-explosive-backtest-result.html");
const BOARD_RESULT_JSON = path.join(REPORTS_DIR, "one-day-surge-board-result.json");

function getBoard(req, res) {
  if (!fs.existsSync(BOARD_HTML)) {
    return res.status(404).send("reports/one-day-surge-board-result.html 파일이 없습니다. `node one-day-surge-board.js`를 먼저 실행하세요.");
  }
  res.sendFile(BOARD_HTML);
}

function getBacktestReport(req, res) {
  if (!fs.existsSync(BACKTEST_HTML)) {
    return res.status(404).send("백테스트 리포트가 없습니다. `node boards/oneDaySurge/one-day-surge-0930-scanner-backtest.js`를 먼저 실행하세요.");
  }
  res.sendFile(BACKTEST_HTML);
}

function getExplosiveBacktestReport(req, res) {
  if (!fs.existsSync(EXPLOSIVE_HTML)) {
    return res.status(404).send("폭발형 백테스트 리포트가 없습니다. `node boards/oneDaySurge/one-day-surge-0930-explosive-backtest.js`를 먼저 실행하세요.");
  }
  res.sendFile(EXPLOSIVE_HTML);
}

async function getLiveEntryCheck(req, res) {
  try {
    const date = String(req.query.date || '').trim();
    const code = String(req.query.code || '').trim();
    // 입력 검증 (라우트 미들웨어에서도 검증되지만 안전망)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, reason: 'date 형식 오류 (YYYY-MM-DD)' });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ ok: false, reason: 'code 형식 오류 (6자리 숫자)' });
    }
    // 1DS 보드 result 에서 종목명 조회 (있으면)
    let name = null;
    try {
      if (fs.existsSync(BOARD_RESULT_JSON)) {
        const j = JSON.parse(fs.readFileSync(BOARD_RESULT_JSON, 'utf-8'));
        const mr = j.todayResultCandidates?.mainResult || [];
        const found = mr.find(x => x.code === code);
        if (found) name = found.name;
      }
    } catch (_) {}
    const section = String(req.query.section || '').trim();
    let result;
    if (SIMPLIFIED_SECTIONS.has(section)) {
      result = await analyzeLiveEntrySimplified({ date, code, name, sectionKind: section });
    } else {
      result = await analyzeLiveEntryFor1dsSurvivor({ date, code, name });
      if (result && result.ok) result.mode = 'survivor1000';
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, reason: 'internal_error', detail: String(e.message || e).slice(0, 300) });
  }
}

module.exports = { getBoard, getBacktestReport, getExplosiveBacktestReport, getLiveEntryCheck };
