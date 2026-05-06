// /login GET, POST — SITE_PASSWORD 게이트.
const { isSiteAuthed, setSiteCookie, safeNextUrl } = require("../services/auth/siteAuth");

function getLogin(req, res) {
  if (isSiteAuthed(req)) return res.redirect(safeNextUrl(req.query.next));
  res.render("site-login", { error: null, next: req.query.next || "/" });
}

function postLogin(req, res) {
  const password = String(req.body.password || "");
  const expected = process.env.SITE_PASSWORD;
  if (!expected || password !== expected) {
    return res.render("site-login", {
      error: "비밀번호가 일치하지 않습니다.",
      next: req.body.next || "/",
    });
  }
  setSiteCookie(res, password);
  res.redirect(safeNextUrl(req.body.next));
}

module.exports = { getLogin, postLogin };
