// 사이트 진입 게이트 미들웨어 — PRIVATE_SITE_TOKEN(404 처리) + SITE_PASSWORD(/login redirect) 2단.
const {
  SITE_PUBLIC_PATHS,
  isSiteAuthed,
  isPrivateAllowed,
  setPrivateTokenCookie,
} = require("../services/auth/siteAuth");

// 비공개 토큰: 토큰 미통과 시 404 (사이트 자체가 없는 척).
// ?k=토큰 으로 진입 시 쿠키 1년 발급 후 토큰 제거하고 redirect.
function privateTokenGate(req, res, next) {
  const expected = process.env.PRIVATE_SITE_TOKEN;
  if (!expected || process.env.NODE_ENV !== "production") return next();
  if (req.query.k && req.query.k === expected) {
    setPrivateTokenCookie(res, expected);
    return res.redirect(req.path);
  }
  if (isPrivateAllowed(req)) return next();
  res.status(404).set("Content-Type", "text/html; charset=utf-8");
  return res.send("Cannot GET " + req.path);
}

// 사이트 비밀번호: 미통과 시 /login 으로 redirect (next 보존).
function sitePasswordGate(req, res, next) {
  if (isSiteAuthed(req)) return next();
  if (SITE_PUBLIC_PATHS.has(req.path)) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

module.exports = { privateTokenGate, sitePasswordGate };
