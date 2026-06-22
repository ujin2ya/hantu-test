// /admin/* — 로그인 + 대시보드 + 패턴 트리거.
const fs = require("fs");
const patternScreener = require("../../screeners/pattern-screener");
const {
  setAdminCookie, clearAdminCookie, isAdminAuthed,
} = require("../services/auth/adminAuth");
const path = require("path");
const { loadSubscribers, saveSubscribers, MAX_SUBSCRIBERS } = require("../services/mail/subscribers");
const { sendOneDaySurgeMail, sendOneDaySurgeMailToOne } = require("../services/mail/oneDaySurgeMail");
const { getStocksMasterAge } = require("../services/stocks/stocksLoader");
const { REPORTS_DIR } = require("../utils/paths");
const triggers = require("../services/pattern/adminTriggers");

const ONE_DAY_SURGE_RESULT_PATH = path.join(REPORTS_DIR, "one-day-surge-board-result.json");

function readOneDaySurgeResult() {
  if (!fs.existsSync(ONE_DAY_SURGE_RESULT_PATH)) return null;
  return JSON.parse(fs.readFileSync(ONE_DAY_SURGE_RESULT_PATH, "utf-8"));
}

function getLogin(req, res) {
  if (isAdminAuthed(req)) return res.redirect("/admin");
  res.render("admin/login", { error: null });
}

function postLogin(req, res) {
  const password = String(req.body.password || "");
  if (!process.env.ADMIN_TOKEN || password !== process.env.ADMIN_TOKEN) {
    return res.render("admin/login", { error: "비밀번호가 일치하지 않습니다." });
  }
  setAdminCookie(res, password);
  res.redirect("/admin");
}

function getLogout(req, res) {
  clearAdminCookie(res);
  res.redirect("/admin/login");
}

function getDashboard(req, res) {
  const { getBoardNavHtml } = require("../utils/boardNav");
  res.render("admin/dashboard", {
    subscribers: loadSubscribers(),
    maxSubscribers: MAX_SUBSCRIBERS,
    flash: req.query.flash || null,
    query: req.query,
    stocksMaster: getStocksMasterAge(),
    patternState: triggers.patternState,
    seededCount: patternScreener.listSeededStocks().length,
    navHtml: getBoardNavHtml(""),
  });
}

function postUnsubscribe(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!email) return res.redirect("/admin?flash=missing_email");
  const list = loadSubscribers();
  const idx = list.findIndex((s) => s.email === email);
  if (idx === -1) return res.redirect("/admin?flash=not_found");
  list.splice(idx, 1);
  saveSubscribers(list);
  res.redirect("/admin?flash=removed");
}

async function postSend1dsMailAll(req, res) {
  try {
    const result = readOneDaySurgeResult();
    if (!result) return res.redirect("/admin?flash=no_1ds_result");
    const r = await sendOneDaySurgeMail(result);
    if (r.reason === "no_subscribers") return res.redirect("/admin?flash=no_subscribers");
    if (r.reason === "no_candidates") return res.redirect("/admin?flash=no_1ds_candidates");
    if (r.reason === "no_transporter") return res.redirect("/admin?flash=no_smtp");
    return res.redirect(`/admin?flash=1ds_mail_sent&n=${r.sent}/${r.total}`);
  } catch (e) {
    console.error("[1DS메일·수동] 에러:", e.message);
    return res.redirect("/admin?flash=mail_error");
  }
}

async function postSend1dsMailOne(req, res) {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.redirect("/admin?flash=missing_email");
    const result = readOneDaySurgeResult();
    if (!result) return res.redirect("/admin?flash=no_1ds_result");
    const r = await sendOneDaySurgeMailToOne(result, email);
    if (r.ok) return res.redirect(`/admin?flash=1ds_mail_one_sent&email=${encodeURIComponent(email)}`);
    if (r.reason === "not_found") return res.redirect("/admin?flash=not_found");
    if (r.reason === "no_candidates") return res.redirect("/admin?flash=no_1ds_candidates");
    if (r.reason === "no_transporter") return res.redirect("/admin?flash=no_smtp");
    return res.redirect("/admin?flash=mail_error");
  } catch (e) {
    console.error("[1DS메일·개별] 에러:", e.message);
    return res.redirect("/admin?flash=mail_error");
  }
}

function postPatternSeed(req, res) {
  const r = triggers.startSeed();
  res.redirect(r.ok ? "/admin?flash=pattern_seed_started" : "/admin?flash=pattern_seeding");
}

function postPatternAnalyze(req, res) {
  const r = triggers.startAnalyze();
  res.redirect(r.ok ? "/admin?flash=pattern_analyze_started" : "/admin?flash=pattern_analyzing");
}

function postQvaBacktest(req, res) {
  const r = triggers.startQvaBacktest();
  res.redirect(r.ok ? "/admin?flash=qva_backtest_started" : "/admin?flash=qva_backtest_running");
}

function postRefreshPatternCache(req, res) {
  const r = triggers.refreshPatternCache();
  if (r.ok) res.json({ success: true, message: r.message });
  else res.status(r.message === "이미 분석 중입니다" ? 200 : 500).json({ success: false, message: r.message });
}

function postRefreshWatchlistBoard(req, res) {
  const r = triggers.refreshWatchlistBoard();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRefreshAllBoards(req, res) {
  const r = triggers.refreshAllBoards();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRefresh1dsIntraday(req, res) {
  const r = triggers.refresh1dsIntraday();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRefresh1dsSurvivor1000(req, res) {
  const r = triggers.refresh1dsSurvivor1000();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRefreshQvaLiveWatch(req, res) {
  const r = triggers.refreshQvaLiveWatch();
  if (r.ok) return res.json({ ok: true, success: true, message: r.message, startedAt: r.startedAt });
  // 이미 실행 중 — 409 아닌 200 + running 플래그 (보드 polling이 그대로 이어받게)
  return res.status(200).json({ ok: false, running: true, message: r.message, startedAt: r.startedAt });
}

// GET /admin/qva-live-watch-status — 새로고침 실행 상태 polling (보드 화면 버튼용).
function getQvaLiveWatchStatus(req, res) {
  res.json(triggers.getQvaLiveWatchStatus());
}

function postRegen1dsScannerBoard(req, res) {
  const r = triggers.regen1dsScannerBoard();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRunDailyUpdate(req, res) {
  const r = triggers.runDailyUpdate();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

// POST /admin/refresh-nasdaq-theme — 나스닥 테마 감시 수동 새로고침.
// 06:30 cron과 동일한 시퀀스(fetch + watch 보드 + 1DS pool)를 백그라운드 spawn.
// 중복 실행 시 success=false, running=true.
function postRefreshNasdaqTheme(req, res) {
  const r = triggers.refreshNasdaqTheme();
  if (r.ok) {
    return res.json({ ok: true, success: true, message: r.message, startedAt: r.startedAt });
  }
  if (r.running) {
    return res.status(200).json({ ok: false, running: true, message: r.message, startedAt: r.startedAt });
  }
  return res.status(500).json({ ok: false, success: false, message: r.message || "failed" });
}

// GET /admin/nasdaq-theme-status — 새로고침 실행 상태 polling.
function getNasdaqThemeStatus(req, res) {
  res.json(triggers.getNasdaqThemeStatus());
}

// GET /admin/db-signals — 보드 신호 히스토리 조회
// 쿼리 파라미터 (1개 필수):
//   ?stockCode=005930
//   ?boardName=ONE_DAY_SURGE
//   ?date=2026-05-15
//   ?signalId=123
// 옵션: &limit=200 (기본), boardName+date 조합 가능
async function getDbSignals(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const { stockCode, boardName, date, signalId, limit } = req.query || {};
    const lim = Math.min(Number(limit || 200), 1000);

    let result;
    if (signalId) {
      const { query } = require('../db/mysql');
      const sig = await query('SELECT * FROM board_signals WHERE id = ?', [Number(signalId)]);
      const outcomes = await query('SELECT * FROM board_signal_outcomes WHERE signal_id = ? ORDER BY horizon_days', [Number(signalId)]);
      const links = await query(
        `SELECT 'out' AS direction, link_type, to_signal_id AS other_id, days_between FROM signal_links WHERE from_signal_id = ?
         UNION ALL
         SELECT 'in' AS direction, link_type, from_signal_id AS other_id, days_between FROM signal_links WHERE to_signal_id = ?`,
        [Number(signalId), Number(signalId)]
      );
      result = { signal: (sig && sig[0]) || null, outcomes, links };
    } else if (stockCode) {
      result = { mode: 'stock', stockCode, signals: await repo.findSignalsByStock(stockCode, { limit: lim }) };
    } else if (boardName && date) {
      result = { mode: 'board+date', boardName, date, signals: await repo.findSignalsByBoard(boardName, { date, limit: lim }) };
    } else if (boardName) {
      result = { mode: 'board', boardName, signals: await repo.findSignalsByBoard(boardName, { limit: lim }) };
    } else if (date) {
      result = { mode: 'date', date, signals: await repo.findSignalsByDate(date, { limit: lim }) };
    } else {
      return res.status(400).json({
        error: 'one of stockCode / boardName / date / signalId is required',
        examples: [
          '/admin/db-signals?stockCode=005930',
          '/admin/db-signals?boardName=ONE_DAY_SURGE',
          '/admin/db-signals?date=2026-05-15',
          '/admin/db-signals?signalId=123',
          '/admin/db-signals?boardName=QVA2_WATCHLIST&date=2026-05-15',
        ],
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─── 3차 조회 API (2026-05-17) ────────────────────────────────────────────
// 모두 requireAdmin 게이트 뒤. JSON 응답.

// GET /admin/db-signals/overlap?date=YYYY-MM-DD&minBoards=2&includeFailed=false&limit=100
//   같은 날짜에 2+ board_name에 동시 등장한 종목
async function getDbSignalsOverlap(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const { date, minBoards, includeFailed, limit } = req.query || {};
    if (!date) return res.status(400).json({ error: 'date is required', example: '/admin/db-signals/overlap?date=2026-05-15&minBoards=2' });
    const rows = await repo.findOverlap(date, {
      minBoards: Number(minBoards || 2),
      includeFailed: includeFailed === 'true' || includeFailed === '1',
      limit: Number(limit || 100),
    });
    res.json({ date, minBoards: Number(minBoards || 2), includeFailed: !!(includeFailed === 'true' || includeFailed === '1'), count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/repeated?days=20&minCount=2&limit=100
async function getDbSignalsRepeated(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const { days, minCount, limit } = req.query || {};
    const rows = await repo.findRepeated({
      days: Number(days || 20),
      minCount: Number(minCount || 2),
      limit: Number(limit || 100),
    });
    res.json({ days: Number(days || 20), minCount: Number(minCount || 2), count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/stock/:stockCode/history?days=180
async function getDbSignalsStockHistory(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const code = (req.params && req.params.stockCode) || '';
    if (!/^\d{4,6}$/.test(code)) return res.status(400).json({ error: 'stockCode must be 4-6 digits', example: '/admin/db-signals/stock/005930/history?days=180' });
    const days = Number((req.query && req.query.days) || 180);
    const result = await repo.findStockHistory(code, { days });
    res.json({ days, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/performance?boardName=QVA_WATCHLIST&signalKind=QVA_NEW&horizon=5&days=60
async function getDbSignalsPerformance(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const { boardName, signalKind, horizon, days } = req.query || {};
    if (!boardName) return res.status(400).json({
      error: 'boardName is required',
      example: '/admin/db-signals/performance?boardName=QVA_WATCHLIST&signalKind=QVA_NEW&horizon=5&days=60',
    });
    const result = await repo.findPerformance({
      boardName,
      signalKind: signalKind || null,
      horizon: Number(horizon || 5),
      days: Number(days || 60),
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/link-summary?days=180
async function getDbSignalsLinkSummary(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const days = Number((req.query && req.query.days) || 180);
    const rows = await repo.findLinkSummary({ days });
    res.json({ days, count: rows.length, link_types: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/today-focus?date=YYYY-MM-DD&minBoards=1&limit=50
async function getDbSignalsTodayFocus(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const { date, minBoards, limit } = req.query || {};
    if (!date) return res.status(400).json({ error: 'date is required', example: '/admin/db-signals/today-focus?date=2026-05-15' });
    const rows = await repo.findTodayFocus(date, {
      minBoards: Number(minBoards || 1),
      limit: Number(limit || 50),
    });
    res.json({
      date,
      minBoards: Number(minBoards || 1),
      note: '매수 추천 아님 — priority_score는 (board_count×10 + positive_kind×5 - failed_kind×8 + recent_repeat×3 + strong_kind×10) 단순 합산',
      count: rows.length,
      rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ─── 10차 (2026-05-22) — 검색 중심 운영판 ───────────────────────────────
// 3개 API: search / suggest / summary

// GET /admin/db-signals/search?q=KG&limit=200
//   stock_name LIKE 또는 stock_code LIKE → 매칭 종목 + 신호 행
async function getDbSignalsSearch(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const q = (req.query && req.query.q) || '';
    const limit = Number((req.query && req.query.limit) || 200);
    const result = await repo.searchSignalsByStockKeyword(q, { limit });
    res.json({
      q: result.keyword,
      stock_count: result.stocks.length,
      signal_count: result.signals.length,
      stocks: result.stocks,
      signals: result.signals,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/suggest?q=KG&limit=15
//   자동완성. q 없으면 최근 신호 종목 상위 N (기본 15).
async function getDbSignalsSuggest(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const q = (req.query && req.query.q) || '';
    const limit = Number((req.query && req.query.limit) || 15);
    const rows = await repo.suggestStocks(q, { limit });
    res.json({ q: q || null, count: rows.length, suggestions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/summary/:stockCode
async function getDbSignalsSummary(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const code = (req.params && req.params.stockCode) || '';
    if (!/^\d{4,6}$/.test(code)) {
      return res.status(400).json({ error: 'stockCode must be 4-6 digits', example: '/admin/db-signals/summary/005930' });
    }
    const result = await repo.getStockSignalSummary(code, { latestLimit: 20 });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals (또는 /db-board) — 종목 신호 이력 검색 화면 (11차, 2026-05-22)
// 검색 전에는 추천/랭킹/최근 신호 목록을 일체 보여주지 않음.
// 검색 후 결과는 클라이언트가 /admin/db-signals/* API 로 가져옴.
async function getDbBoardDashboard(req, res) {
  try {
    const labels = require('../db/boardSignalLabels');
    // URL 의 ?q= 또는 ?stockCode= 로 도착하면 첫 렌더에 그대로 표시
    const initialQ = (req.query && (req.query.q || req.query.stockCode)) || '';

    const { getBoardNavHtml } = require('../utils/boardNav');
    res.render('admin/db-signal-search', {
      initialQ,
      navHtml: getBoardNavHtml('/admin/db-signals'),
      BOARD_LABELS: labels.BOARD_LABELS,
      KIND_LABELS: labels.KIND_LABELS,
    });
  } catch (e) {
    res.status(500).send(`<h1>화면 로딩 실패</h1><pre>${(e && e.stack) || e}</pre>`);
  }
}

module.exports = {
  getLogin, postLogin, getLogout,
  getDashboard, postUnsubscribe,
  postSend1dsMailAll, postSend1dsMailOne,
  postPatternSeed, postPatternAnalyze, postQvaBacktest,
  postRefreshPatternCache, postRefreshWatchlistBoard, postRefreshAllBoards, postRefresh1dsIntraday, postRefresh1dsSurvivor1000, postRegen1dsScannerBoard, postRefreshQvaLiveWatch, getQvaLiveWatchStatus, postRunDailyUpdate,
  postRefreshNasdaqTheme, getNasdaqThemeStatus,
  getDbSignals,
  getDbSignalsOverlap,
  getDbSignalsRepeated,
  getDbSignalsStockHistory,
  getDbSignalsPerformance,
  getDbSignalsLinkSummary,
  getDbSignalsTodayFocus,
  getDbSignalsSearch,
  getDbSignalsSuggest,
  getDbSignalsSummary,
  getDbBoardDashboard,
};
