// /admin/* — 로그인 + 대시보드 + 패턴 트리거.
const fs = require("fs");
const patternScreener = require("../../pattern-screener");
const {
  setAdminCookie, clearAdminCookie, isAdminAuthed,
} = require("../services/auth/adminAuth");
const { loadSubscribers, saveSubscribers, MAX_SUBSCRIBERS } = require("../services/mail/subscribers");
const { sendPatternMail } = require("../services/mail/patternMail");
const { getStocksMasterAge } = require("../services/stocks/stocksLoader");
const triggers = require("../services/pattern/adminTriggers");

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

async function postSendPatternMail(req, res) {
  try {
    if (!fs.existsSync(triggers.PATTERN_RESULT_PATH)) return res.redirect("/admin?flash=no_result");
    const result = JSON.parse(fs.readFileSync(triggers.PATTERN_RESULT_PATH, "utf-8"));
    await sendPatternMail(result);
    res.redirect("/admin?flash=mail_sent");
  } catch (e) {
    console.error("[수동발송] 에러:", e.message);
    res.redirect("/admin?flash=mail_error");
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

function postRunDailyUpdate(req, res) {
  const r = triggers.runDailyUpdate();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

module.exports = {
  getLogin, postLogin, getLogout,
  getDashboard, postUnsubscribe, postSendPatternMail,
  postPatternSeed, postPatternAnalyze, postQvaBacktest,
  postRefreshPatternCache, postRefreshWatchlistBoard, postRunDailyUpdate,
};
