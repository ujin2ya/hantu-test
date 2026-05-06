// 관리자 콘솔 인증 — ADMIN_TOKEN 쿠키. 사이트 게이트보다 한 단계 더 보호.
const { getCookie } = require("./siteAuth");

const ADMIN_COOKIE = "admin_session";
const ADMIN_COOKIE_MAX_AGE_SEC = 12 * 60 * 60;

function setAdminCookie(res, value) {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ADMIN_COOKIE_MAX_AGE_SEC}`,
    "Path=/",
  ];
  if (isProd) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAdminCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`
  );
}

function isAdminAuthed(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const got = getCookie(req, ADMIN_COOKIE);
  return !!got && got === expected;
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthed(req)) return res.redirect("/admin/login");
  next();
}

module.exports = { setAdminCookie, clearAdminCookie, isAdminAuthed, requireAdmin };
