// Naver 모바일 종목 뉴스 fetcher.
// 엔드포인트: https://api.stock.naver.com/news/stock/{code}?pageSize=N
// 응답 형식: [ { total, items: [ { title, body, datetime, officeName, mobileNewsUrl, ... } ] } ]
const axios = require("axios");

const TTL_MS = 30 * 60 * 1000; // 30분 in-memory cache
const cache = new Map();

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json",
};

function decodeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function fmtDateTime(dt) {
  if (!dt || String(dt).length < 12) return null;
  const s = String(dt);
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}`;
}

async function fetchRecentNews(code, limit = 8) {
  const key = `${code}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value;

  try {
    const url = `https://api.stock.naver.com/news/stock/${code}?pageSize=${limit}&page=1`;
    const r = await axios.get(url, { headers: HEADERS, timeout: 6000 });
    const clusters = Array.isArray(r.data) ? r.data : [];
    const news = [];
    for (const cluster of clusters) {
      const items = (cluster && cluster.items) || [];
      for (const it of items) {
        if (news.length >= limit) break;
        news.push({
          title: decodeHtml(it.titleFull || it.title || ""),
          body: decodeHtml(it.body || "").slice(0, 200),
          source: it.officeName || "",
          dateTimeFmt: fmtDateTime(it.datetime),
          dateRaw: it.datetime || "",
          url: it.mobileNewsUrl || "",
        });
      }
      if (news.length >= limit) break;
    }
    const value = { news, fetchedAt: new Date().toISOString() };
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch (e) {
    return { news: [], fetchedAt: new Date().toISOString(), error: e.message };
  }
}

module.exports = { fetchRecentNews };
