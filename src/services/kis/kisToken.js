// KIS Open API access token 캐시 + 발급. 24시간 유효, 1분당 1회 발급 제한(EGW00133)이 있어
// 디스크 캐시 + inflight coalesce 필수. 토큰 평문이라 .gitignore 됨.
const fs = require("fs");
const axios = require("axios");
const { TOKEN_CACHE_PATH } = require("../../utils/paths");

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function loadCachedToken() {
  try {
    const raw = fs.readFileSync(TOKEN_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "number") {
      return parsed;
    }
  } catch (_) {
    // 캐시 없음/깨짐 — 새로 발급
  }
  return { accessToken: null, expiresAt: 0 };
}

function saveCachedToken(token) {
  try {
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(token), "utf-8");
  } catch (e) {
    console.warn("[KIS] 토큰 캐시 저장 실패:", e.message);
  }
}

let tokenCache = loadCachedToken();
let inflightIssue = null;

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
    return tokenCache.accessToken;
  }
  if (inflightIssue) return inflightIssue;

  inflightIssue = (async () => {
    try {
      const url = `${process.env.KIS_BASE_URL}/oauth2/tokenP`;
      const body = {
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
      };
      const res = await axios.post(url, body, {
        headers: { "content-type": "application/json; charset=UTF-8" },
        timeout: 10000,
      });
      if (!res.data.access_token) {
        throw new Error("토큰 발급 실패");
      }
      const expiresInMs = (Number(res.data.expires_in) || 86400) * 1000;
      tokenCache = {
        accessToken: res.data.access_token,
        expiresAt: Date.now() + expiresInMs,
      };
      saveCachedToken(tokenCache);
      return tokenCache.accessToken;
    } finally {
      inflightIssue = null;
    }
  })();

  return inflightIssue;
}

module.exports = { getAccessToken };
