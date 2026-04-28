// 한국시장용 보정 모듈 — 가이드 적용 (한국시장 보정 가이드 #2~#5, #16)
//
// 핵심 책임:
//   1. 거래대금 통계: 5/20/60일 평균 + 비율 (valueApprox 기반)
//   2. 제외 필터: 우선주·스팩·ETF/ETN/리츠·저시총·저거래대금
//   3. 과열 감점: 단기 폭등·이격도 페널티
//   4. 디폴트 옵션 (보수적): minAvg20TradingValue=50억, minMarketCap=1000억

function avg(arr) {
  const xs = arr.filter(Number.isFinite);
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sma(rows, idx, period) {
  if (idx + 1 < period) return null;
  const part = rows.slice(idx - period + 1, idx + 1);
  const closes = part.map((r) => r.close).filter(Number.isFinite);
  if (closes.length < period) return null;
  return closes.reduce((a, b) => a + b, 0) / closes.length;
}

// ─────────── 거래대금 통계 ───────────
function calcTradingValueStats(rows, idx) {
  if (!rows || idx == null || idx < 0) return null;
  const get = (r) => r?.valueApprox || 0;
  const safeIdx = Math.min(idx, rows.length - 1);

  const slice = (n) => rows.slice(Math.max(0, safeIdx - n + 1), safeIdx + 1).map(get).filter((v) => v > 0);
  const last5 = slice(5);
  const last20 = slice(20);
  const last60 = slice(60);

  const avg5 = avg(last5);
  const avg20 = avg(last20);
  const avg60 = avg(last60);

  return {
    avg5,
    avg20,
    avg60,
    ratio5To60: avg60 > 0 ? Number((avg5 / avg60).toFixed(2)) : 1,
    ratio5To20: avg20 > 0 ? Number((avg5 / avg20).toFixed(2)) : 1,
    todayValue: get(rows[safeIdx]),
  };
}

// ─────────── 종목명 기반 휴리스틱 ───────────
function isPreferredStockByName(name) {
  if (!name) return false;
  // "삼성전자우", "현대차2우B", "LG화학우" 등
  return /(\d?우[BC]?|우선주)$/.test(String(name).trim());
}

function isSpacByName(name) {
  if (!name) return false;
  return /(스팩|SPAC)/i.test(String(name));
}

function isReitByName(name) {
  if (!name) return false;
  // "신한알파리츠", "이리츠코크렙" 등
  return /리츠$/.test(String(name).trim());
}

function isEtfLikeByName(name) {
  if (!name) return false;
  // 보수적: KODEX/TIGER/HANARO/KBSTAR/SOL/ARIRANG/KINDEX/KOSEF/RISE/PLUS/ACE/HK/TIMEFOLIO 등
  return /^(KODEX|TIGER|HANARO|KBSTAR|SOL|ARIRANG|KINDEX|KOSEF|RISE|PLUS|ACE|TIMEFOLIO|HK )/i.test(
    String(name).trim()
  );
}

// ─────────── 제외 필터 ───────────
function passKoreaUniverseFilter(meta, valueStats, options = {}) {
  const {
    excludeSpecial = true,        // isSpecial=true (우선주)
    excludeEtf = true,             // isEtf=true (ETF/ETN)
    excludeSpac = true,
    excludeReit = true,
    excludePreferred = true,
    minMarketCap = 100_000_000_000,        // 1,000억
    minAvg20TradingValue = 5_000_000_000,  // 50억
  } = options;

  const name = meta?.name || "";

  if (excludeSpecial && meta?.isSpecial) return { pass: false, reason: "special" };
  if (excludeEtf && meta?.isEtf) return { pass: false, reason: "etf" };
  if (excludePreferred && isPreferredStockByName(name)) return { pass: false, reason: "preferred" };
  if (excludeSpac && isSpacByName(name)) return { pass: false, reason: "spac" };
  if (excludeReit && isReitByName(name)) return { pass: false, reason: "reit" };
  if (excludeEtf && isEtfLikeByName(name)) return { pass: false, reason: "etf-like" };

  const marketCap = meta?.marketValue || 0;
  if (Number.isFinite(marketCap) && marketCap > 0 && marketCap < minMarketCap) {
    return { pass: false, reason: `low_market_cap_${Math.round(marketCap / 1e8)}억` };
  }

  if (valueStats?.avg20 != null && valueStats.avg20 < minAvg20TradingValue) {
    return { pass: false, reason: `low_liquidity_${Math.round(valueStats.avg20 / 1e8)}억` };
  }

  return { pass: true, reason: "ok" };
}

// ─────────── 과열 감점 ───────────
function pctChange(rows, idx, lookback) {
  if (!rows || idx < lookback) return null;
  const now = rows[idx]?.close;
  const past = rows[idx - lookback]?.close;
  if (!Number.isFinite(now) || !Number.isFinite(past) || past <= 0) return null;
  return ((now - past) / past) * 100;
}

function distanceFromMA(rows, idx, period) {
  const ma = sma(rows, idx, period);
  const close = rows[idx]?.close;
  if (!ma || !Number.isFinite(close)) return null;
  return ((close - ma) / ma) * 100;
}

function computeOverheatPenalty(rows, idx) {
  let penalty = 0;
  const reasons = [];
  const ret3 = pctChange(rows, idx, 3);
  const ret5 = pctChange(rows, idx, 5);
  const ret20 = pctChange(rows, idx, 20);
  const dist20 = distanceFromMA(rows, idx, 20);

  if (ret3 != null && ret3 >= 25) {
    penalty -= 5;
    reasons.push(`3일 ${ret3.toFixed(1)}% 폭등 (-5)`);
  }
  if (ret5 != null && ret5 >= 40) {
    penalty -= 8;
    reasons.push(`5일 ${ret5.toFixed(1)}% 폭등 (-8)`);
  }
  if (ret20 != null && ret20 >= 100) {
    penalty -= 10;
    reasons.push(`20일 ${ret20.toFixed(1)}% 폭등 (-10)`);
  }
  if (dist20 != null && dist20 >= 30) {
    penalty -= 5;
    reasons.push(`20일선 이격 +${dist20.toFixed(1)}% (-5)`);
  }

  return { penalty, reasons, ret3, ret5, ret20, dist20 };
}

// ─────────── 거래대금/시총 점수 ───────────
function liquidityScore(valueStats) {
  if (!valueStats || !valueStats.avg20) return 0;
  const v = valueStats.avg20;
  if (v >= 30_000_000_000) return 5;       // 300억+
  if (v >= 10_000_000_000) return 4;       // 100억+
  if (v >= 5_000_000_000) return 3;        // 50억+
  if (v >= 3_000_000_000) return 2;        // 30억+
  return 0;
}

function marketCapScore(meta) {
  const mc = meta?.marketValue;
  if (!Number.isFinite(mc) || mc <= 0) return 0;
  if (mc >= 1_000_000_000_000) return 5;      // 1조+
  if (mc >= 300_000_000_000) return 4;        // 3000억+
  if (mc >= 100_000_000_000) return 3;        // 1000억+
  if (mc >= 50_000_000_000) return 1;         // 500억+
  return 0;
}

// ─────────── 거래대금 비율 점수 (5d/60d 모멘텀) ───────────
function valueMomentumScore(valueStats) {
  if (!valueStats) return 0;
  const r = valueStats.ratio5To60;
  if (r >= 2.0) return 3;
  if (r >= 1.5) return 2;
  if (r >= 1.2) return 1;
  return 0;
}

// ─────────── 디폴트 옵션 ───────────
const DEFAULT_KOREA_OPTIONS = {
  excludeSpecial: true,
  excludeEtf: true,
  excludeSpac: true,
  excludeReit: true,
  excludePreferred: true,
  minMarketCap: 100_000_000_000,        // 1,000억
  minAvg20TradingValue: 5_000_000_000,  // 50억
};

module.exports = {
  calcTradingValueStats,
  passKoreaUniverseFilter,
  computeOverheatPenalty,
  liquidityScore,
  marketCapScore,
  valueMomentumScore,
  isPreferredStockByName,
  isSpacByName,
  isReitByName,
  isEtfLikeByName,
  DEFAULT_KOREA_OPTIONS,
};
