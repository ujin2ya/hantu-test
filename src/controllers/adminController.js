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
  res.render("admin/dashboard", {
    subscribers: loadSubscribers(),
    maxSubscribers: MAX_SUBSCRIBERS,
    flash: req.query.flash || null,
    query: req.query,
    stocksMaster: getStocksMasterAge(),
    patternState: triggers.patternState,
    seededCount: patternScreener.listSeededStocks().length,
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

function postRegen1dsScannerBoard(req, res) {
  const r = triggers.regen1dsScannerBoard();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRunDailyUpdate(req, res) {
  const r = triggers.runDailyUpdate();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
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

module.exports = {
  getLogin, postLogin, getLogout,
  getDashboard, postUnsubscribe,
  postSend1dsMailAll, postSend1dsMailOne,
  postPatternSeed, postPatternAnalyze, postQvaBacktest,
  postRefreshPatternCache, postRefreshWatchlistBoard, postRefreshAllBoards, postRefresh1dsIntraday, postRefresh1dsSurvivor1000, postRegen1dsScannerBoard, postRunDailyUpdate,
  getDbSignals,
};
