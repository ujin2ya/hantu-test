// 사이트 비밀번호(SITE_PASSWORD) + 비공개 토큰(PRIVATE_SITE_TOKEN) 게이트.
// 봇/외부 무단 호출 차단. /login, /unsubscribe 만 화이트리스트.

const SITE_COOKIE = "site_session";
const SITE_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const SITE_PUBLIC_PATHS = new Set(["/login", "/unsubscribe"]);
const PRIVATE_TOKEN_COOKIE = "private_token";

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const m = header.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function setSiteCookie(res, value) {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${SITE_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SITE_COOKIE_MAX_AGE_SEC}`,
    "Path=/",
  ];
  if (isProd) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function isSiteAuthed(req) {
  const expected = process.env.SITE_PASSWORD;
  if (!expected) return true;
  const got = getCookie(req, SITE_COOKIE);
  return !!got && got === expected;
}

// 상대경로만 허용 (오픈 리다이렉트 방지)
function safeNextUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

function isPrivateAllowed(req) {
  const expected = process.env.PRIVATE_SITE_TOKEN;
  if (!expected) return true;
  if (process.env.NODE_ENV !== "production") return true;
  const got = getCookie(req, PRIVATE_TOKEN_COOKIE);
  return got === expected;
}

function setPrivateTokenCookie(res, value) {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${PRIVATE_TOKEN_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${365 * 24 * 60 * 60}`,
    "Path=/",
  ];
  if (isProd) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

module.exports = {
  SITE_PUBLIC_PATHS,
  getCookie,
  setSiteCookie,
  isSiteAuthed,
  safeNextUrl,
  isPrivateAllowed,
  setPrivateTokenCookie,
};
