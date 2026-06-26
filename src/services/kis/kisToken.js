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

// KIS가 "토큰 만료/무효"를 알리는 msg_cd. 로컬 expiresAt(24h)이 지나기 전에도
// KIS가 서버 측에서 토큰을 무효화하는 경우가 있어(같은 appkey로 다른 인스턴스가 재발급하면
// 이전 토큰 무효화 등), 이 코드들을 만나면 캐시를 버리고 강제 재발급해야 한다.
const EXPIRED_TOKEN_MSG_CODES = new Set(["EGW00123", "EGW00121", "EGW00105"]);

// KIS 호출 에러가 "토큰 만료/무효"인지 판별. KIS는 만료 토큰에 HTTP 500 + body.msg_cd를 준다.
function isExpiredTokenError(err) {
  if (!err) return false;
  const body = err.response && err.response.data;
  if (body && body.msg_cd && EXPIRED_TOKEN_MSG_CODES.has(body.msg_cd)) return true;
  const msg = (body && (body.msg1 || body.msg)) || err.message || "";
  return /기간이 만료된 token|expired token|만료된 토큰/i.test(String(msg));
}

let tokenCache = loadCachedToken();
let inflightIssue = null;

// 만료/무효 토큰 응답을 받았을 때 호출 — 캐시를 비워 다음 getAccessToken이 강제 재발급하게 한다.
function invalidateCachedToken() {
  tokenCache = { accessToken: null, expiresAt: 0 };
}

async function getAccessToken(options = {}) {
  const { force = false } = options;
  const now = Date.now();
  if (force) invalidateCachedToken();
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

module.exports = { getAccessToken, invalidateCachedToken, isExpiredTokenError };
