#!/usr/bin/env node
/**
 * 나스닥 테마 → 한국 오늘 지켜볼 후보 보드
 *
 * 출발점:
 *   이 보드는 QVA 보드에 테마를 붙이는 것이 아니다. 1DS 보드에 붙이는 것도 아니다.
 *   출발점은 "전일 미국장에서 강했던 테마"다. 그 테마와 연결되는 국내 종목 중
 *   최근 QVA1/QVA2/VVI2/1DS 수급·발화 흔적이 있는 종목을 "오늘 지켜볼 후보"로 정리.
 *
 * 중요:
 *   - 매수 신호 보드 아님 — "오늘 지켜볼 후보", "테마 관련 수급 흔적", "우선 관찰"
 *   - 기존 QVA1/QVA2/VVI2/1DS 본체 / 운영 보드 / 라우터 / cron 변경 X
 *   - 수동 매핑 JSON 기반. 자동 수집 X.
 *   - 라우터 추가는 별도 보고 후 진행 (이 파일은 generator만).
 *
 * 입력:
 *   - data/theme/nasdaq-theme-map.json
 *   - data/theme/nasdaq-theme-daily.json
 *   - DB board_signals (QVA1/QVA2/VVI2/1DS 신호 이력)
 *   - cache/stock-charts-long/{code}.json (최신 흐름)
 *   - cache/naver-stocks-list.json (시총·종목명 보강)
 *
 * 출력:
 *   - reports/nasdaq-theme-watch-board-result.json
 *   - reports/nasdaq-theme-watch-board-result.html
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { query, closePool, isEnabled } = require(path.join(ROOT, 'src', 'db', 'mysql'));
const renderHtml = require(path.join(__dirname, 'nasdaq-theme-watch-board-render.js'));

const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const THEME_MAP_PATH = path.join(ROOT, 'data', 'theme', 'nasdaq-theme-map.json');
const THEME_DAILY_PATH = path.join(ROOT, 'data', 'theme', 'nasdaq-theme-daily.json');
const OUT_JSON = path.join(ROOT, 'reports', 'nasdaq-theme-watch-board-result.json');
const OUT_HTML = path.join(ROOT, 'reports', 'nasdaq-theme-watch-board-result.html');

const QVA_LOOKBACK_TRADING_DAYS = 20;
const VVI2_LOOKBACK_TRADING_DAYS = 10;
const ONEDS_LOOKBACK_TRADING_DAYS = 5;
const STOCKS_LIMIT_PER_THEME = 50;

// ─── 유틸 ────────────────────────────────────────────────────────────────
function loadJsonSafe(fp) {
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}
function loadChart(code) { return loadJsonSafe(path.join(CHART_DIR, code + '.json')); }
function pct(num, denom) {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return null;
  return Number(((num / denom - 1) * 100).toFixed(2));
}
function fmtPct(v, p = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + Number(v).toFixed(p) + '%';
}
function fmtInt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString();
}
function fmtValue(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e12) return (v/1e12).toFixed(1) + '조';
  if (v >= 1e8)  return (v/1e8).toFixed(0) + '억';
  if (v >= 1e4)  return (v/1e4).toFixed(0) + '만';
  return Math.round(v).toLocaleString();
}
function avg(arr) {
  const xs = arr.filter(v => Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function todayKstDate() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// 한국 거래일 → 가장 가까운 이전(또는 같은 날) daily entry
function findLatestDailyEntry(history, krDate) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const sorted = history.slice().sort((a, b) => b.date.localeCompare(a.date));
  for (const e of sorted) if (e.date <= krDate) return e;
  return sorted[sorted.length - 1] || null;
}

// 종목명 → 테마 매칭 (단순 directStockMatch — 향후 keyword/업종 매칭으로 확장 가능)
function matchThemeForStock(stockName, themesMap) {
  const matched = [];
  for (const key of Object.keys(themesMap)) {
    const t = themesMap[key];
    if (!t.krStocks) continue;
    if (t.krStocks.some(s => s === stockName)) {
      matched.push({ themeKey: key, label: t.label, matchType: 'directStockMatch' });
    }
  }
  return matched;
}

// ─── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  if (!isEnabled()) { console.error('❌ .env DB_* 미설정'); process.exit(1); }
  console.log('🔍 나스닥 테마 → 오늘 지켜볼 후보 보드 생성');
  const t0 = Date.now();

  // 1) 테마 데이터 로드
  const themeMapDoc = loadJsonSafe(THEME_MAP_PATH);
  const themeDailyDoc = loadJsonSafe(THEME_DAILY_PATH);
  const themesMap = themeMapDoc?.themes || {};
  const dailyHistory = themeDailyDoc?.history || [];
  const themeKeys = Object.keys(themesMap);
  console.log(`  테마 ${themeKeys.length}개 / 일일 강도 ${dailyHistory.length}일치`);

  const krToday = todayKstDate();
  const latestDaily = findLatestDailyEntry(dailyHistory, krToday);
  const themeStrength = latestDaily?.themes || {};
  console.log(`  최근 강도 데이터: ${latestDaily?.date || '없음'} (us ${latestDaily?.usMarketDate || '—'})`);

  // STRONG/MID 테마 식별
  const strongThemes = themeKeys.filter(k => themeStrength[k]?.strength === 'STRONG');
  const midThemes    = themeKeys.filter(k => themeStrength[k]?.strength === 'MID');
  console.log(`  STRONG: ${strongThemes.length} / MID: ${midThemes.length}`);

  // 2) DB 신호 로드 — 최근 윈도우
  // 가장 최근 거래일 추출 (DB 1DS 가장 최근 날짜를 today로 본다)
  const onedsRecent = await query(`
    SELECT signal_date, stock_code, stock_name, signal_kind, raw_json
    FROM board_signals
    WHERE board_name = 'ONE_DAY_SURGE'
    ORDER BY signal_date DESC, stock_code
    LIMIT 200
  `);
  const qva1Recent = await query(`
    SELECT signal_date, stock_code, stock_name, raw_json
    FROM board_signals
    WHERE board_name = 'QVA_WATCHLIST' AND signal_kind = 'QVA_NEW'
    ORDER BY signal_date DESC, stock_code
    LIMIT 500
  `);
  const qva2Recent = await query(`
    SELECT signal_date, stock_code, stock_name, raw_json
    FROM board_signals
    WHERE board_name = 'QVA2_WATCHLIST' AND signal_kind = 'QVA2_NEW'
    ORDER BY signal_date DESC, stock_code
    LIMIT 500
  `);
  const vvi2Recent = await query(`
    SELECT signal_date, stock_code, stock_name, raw_json
    FROM board_signals
    WHERE (board_name = 'QVA_WATCHLIST' AND signal_kind = 'VVI_FIRED')
       OR (board_name = 'QVA2_WATCHLIST' AND signal_kind = 'VVI2_FIRED')
       OR (board_name = 'QVA_VVI_REDEFINED')
       OR (board_name = 'QVA2_VVI')
    ORDER BY signal_date DESC, stock_code
    LIMIT 500
  `);
  console.log(`  DB 신호 — 1DS ${onedsRecent.length} / QVA1 ${qva1Recent.length} / QVA2 ${qva2Recent.length} / VVI2 ${vvi2Recent.length}`);

  // 거래일 윈도우 cutoff (calendar 기준 — 거래일과 약간 다르지만 단순화)
  function calendarCutoff(referenceDate, tradingDays) {
    // 1.5배 calendar day 대략적 (주말 포함)
    const calDays = Math.ceil(tradingDays * 1.5);
    const d = new Date(referenceDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - calDays);
    return d.toISOString().slice(0, 10);
  }
  const qva1Cutoff  = calendarCutoff(krToday, QVA_LOOKBACK_TRADING_DAYS);
  const qva2Cutoff  = calendarCutoff(krToday, QVA_LOOKBACK_TRADING_DAYS);
  const vvi2Cutoff  = calendarCutoff(krToday, VVI2_LOOKBACK_TRADING_DAYS);
  const onedsCutoff = calendarCutoff(krToday, ONEDS_LOOKBACK_TRADING_DAYS);

  // 종목별 신호 lookup
  const sigByCode = new Map();
  function ensureCode(code) {
    if (!sigByCode.has(code)) sigByCode.set(code, {
      code, name: null,
      qva1: null, qva2: null, vvi2: null, oneds: null,
    });
    return sigByCode.get(code);
  }
  function parseRawScore(raw) {
    try {
      const r = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      return r?.bestEarlyQvaScore ?? r?.score ?? 0;
    } catch (_) { return 0; }
  }
  for (const r of qva1Recent) {
    const date = String(r.signal_date).slice(0,10);
    if (date < qva1Cutoff) continue;
    const e = ensureCode(r.stock_code);
    if (!e.name) e.name = r.stock_name;
    if (!e.qva1 || date > e.qva1.date) e.qva1 = { date, score: parseRawScore(r.raw_json) };
  }
  for (const r of qva2Recent) {
    const date = String(r.signal_date).slice(0,10);
    if (date < qva2Cutoff) continue;
    const e = ensureCode(r.stock_code);
    if (!e.name) e.name = r.stock_name;
    if (!e.qva2 || date > e.qva2.date) {
      const raw = (() => { try { return r.raw_json ? (typeof r.raw_json === 'string' ? JSON.parse(r.raw_json) : r.raw_json) : null; } catch (_) { return null; } })();
      e.qva2 = { date, score: parseRawScore(r.raw_json), type: raw?.qva2Type || null };
    }
  }
  for (const r of vvi2Recent) {
    const date = String(r.signal_date).slice(0,10);
    if (date < vvi2Cutoff) continue;
    const e = ensureCode(r.stock_code);
    if (!e.name) e.name = r.stock_name;
    if (!e.vvi2 || date > e.vvi2.date) e.vvi2 = { date };
  }
  for (const r of onedsRecent) {
    const date = String(r.signal_date).slice(0,10);
    if (date < onedsCutoff) continue;
    const e = ensureCode(r.stock_code);
    if (!e.name) e.name = r.stock_name;
    let score = 0;
    try {
      const raw = r.raw_json ? (typeof r.raw_json === 'string' ? JSON.parse(r.raw_json) : r.raw_json) : null;
      score = raw?.score ?? raw?.totalScore ?? raw?.priorityScore ?? raw?.finalScore ?? 0;
    } catch (_) {}
    if (!e.oneds || date > e.oneds.date) e.oneds = { date, score, signalKind: r.signal_kind };
  }

  // 5) 추가로: themeMap.krStocks 직접 매칭 종목 (신호 이력 없어도 포함) — naver list에서 종목명 → 코드 lookup
  const naverList = loadJsonSafe(NAVER_LIST);
  const nameToCode = new Map();
  if (naverList && Array.isArray(naverList.stocks)) {
    for (const s of naverList.stocks) {
      if (s.name && s.code) nameToCode.set(s.name, { code: s.code, marketCap: s.marketValue, isEtf: s.isEtf, isSpecial: s.isSpecial });
    }
  }
  // 모든 테마 krStocks를 후보 풀에 추가 (신호 없어도)
  for (const tk of themeKeys) {
    const t = themesMap[tk];
    if (!t.krStocks) continue;
    for (const name of t.krStocks) {
      const meta = nameToCode.get(name);
      if (!meta) continue;
      const e = ensureCode(meta.code);
      if (!e.name) e.name = name;
    }
  }
  console.log(`  후보 풀 (신호 + 테마 매칭 종목): ${sigByCode.size}건`);

  // 6) 각 후보에 테마 매칭 + 최신 흐름 + 점수
  const candidates = [];
  // ─── 후보 포함 기준 (사용자 spec, 2026-05-19 강화) ───
  // 이 보드는 "전일 미국장 강세 테마 + 국내 수급 흔적"이 겹친 종목만 본다.
  // 테마 매칭 없는 국내 신호 후보는 무조건 제외 → 기존 QVA/VVI/1DS 보드에서 보면 됨.
  let excludedNoThemeCount = 0;
  for (const sig of sigByCode.values()) {
    const code = sig.code;
    const name = sig.name || '';
    const themeMatches = matchThemeForStock(name, themesMap);
    if (themeMatches.length === 0) {
      // 테마 매칭 없는 후보는 무조건 제외 (국내 신호 유무 무관)
      excludedNoThemeCount++;
      continue;
    }

    // 가장 강한 테마
    let bestThemeKey = null, bestThemeLabel = null, bestThemeStrength = 'NONE';
    let bestThemeReason = null, bestStrongRatio = 0, bestAvgChange = -999;
    for (const m of themeMatches) {
      const td = themeStrength[m.themeKey];
      if (!td) continue;
      const ratio = td.totalTickerCount > 0 ? td.strongTickerCount / td.totalTickerCount : 0;
      const rank = { STRONG: 3, MID: 2, WEAK: 1, NONE: 0 };
      if (rank[td.strength] > (rank[bestThemeStrength] || 0)) {
        bestThemeKey = m.themeKey;
        bestThemeLabel = m.label;
        bestThemeStrength = td.strength;
        bestStrongRatio = ratio;
        bestAvgChange = td.avgChangePct;
        bestThemeReason = td.reason || null;
      }
    }
    // 테마 매칭 없으면 강도 NONE — 신호 있으면 포함되지만 점수 낮음
    const themeMatchReason = themeMatches.length > 0 ? 'directStockMatch' : 'no_match';

    // 최신 흐름 (chart 캐시)
    const chart = loadChart(code);
    let latestDate = null, latestClose = null, latestChangePct = null;
    let latestValue = null, latestVolume = null;
    let valueRatio5 = null, valueRatio20 = null;
    let nearRecentHigh = false, closeStrong = false, alreadyExtended = false;
    let recentMaxDrop = null;
    if (chart && Array.isArray(chart.rows) && chart.rows.length > 0) {
      const rows = chart.rows;
      const idx = rows.length - 1;
      const r = rows[idx];
      latestDate = String(r.date);
      latestClose = r.close;
      latestVolume = r.volume;
      latestValue = r.valueApprox;
      const prev = idx > 0 ? rows[idx - 1] : null;
      if (prev && prev.close > 0) latestChangePct = pct(r.close, prev.close);

      const last5  = rows.slice(Math.max(0, idx - 4), idx + 1);
      const last20 = rows.slice(Math.max(0, idx - 19), idx + 1);
      const avg5Val  = avg(last5.map(x => x.valueApprox || 0));
      const avg20Val = avg(last20.map(x => x.valueApprox || 0));
      valueRatio5  = avg5Val > 0 && latestValue ? Number((latestValue / avg5Val).toFixed(2)) : null;
      valueRatio20 = avg20Val > 0 && latestValue ? Number((latestValue / avg20Val).toFixed(2)) : null;

      // 최근 60일 고가 대비
      const last60 = rows.slice(Math.max(0, idx - 59), idx + 1);
      const high60 = Math.max(...last60.map(x => x.high || 0));
      if (high60 > 0 && latestClose) {
        const distFromHigh = (latestClose / high60 - 1) * 100;
        nearRecentHigh = distFromHigh >= -5;
        alreadyExtended = distFromHigh >= 0; // 신고가 또는 그 위 = 너무 멀리 옴
      }

      // 종가 강도 (당일 high 대비 close 위치 ≥ 0.6)
      if (r.high && r.low && r.high > r.low) {
        const closeLoc = (r.close - r.low) / (r.high - r.low);
        closeStrong = closeLoc >= 0.6;
      }

      // 최근 10일 최대 종가 대비 현재 종가 하락폭
      const last10 = rows.slice(Math.max(0, idx - 9), idx + 1);
      const maxClose10 = Math.max(...last10.map(x => x.close || 0));
      if (maxClose10 > 0 && latestClose) {
        recentMaxDrop = pct(latestClose, maxClose10);
      }
    }

    // 신호 종합
    const hasQva1 = !!sig.qva1;
    const hasQva2 = !!sig.qva2;
    const hasVvi2 = !!sig.vvi2;
    const hasOneds = !!sig.oneds;
    const hasAnySignal = hasQva1 || hasQva2 || hasVvi2 || hasOneds;

    // daysAgo 계산
    function daysAgo(date) {
      if (!date) return null;
      const a = new Date(date + 'T00:00:00Z'), b = new Date(krToday + 'T00:00:00Z');
      return Math.round((b - a) / (24 * 3600 * 1000));
    }
    const qva1DaysAgo = daysAgo(sig.qva1?.date);
    const qva2DaysAgo = daysAgo(sig.qva2?.date);
    const vvi2DaysAgo = daysAgo(sig.vvi2?.date);
    const onedsDaysAgo = daysAgo(sig.oneds?.date);

    // ─── 점수 계산 ────────────────────────────────────────────
    let score = 0;
    // 테마
    if (bestThemeStrength === 'STRONG') score += 25;
    else if (bestThemeStrength === 'MID') score += 15;
    else if (bestThemeStrength === 'WEAK') score += 5;
    if (themeMatchReason === 'directStockMatch') score += 10;
    if (bestStrongRatio >= 0.6) score += 5; // strongTickerCount 비율 높음
    // 국내 신호
    if (hasQva1) score += 10;
    if (hasQva2) score += 15;
    if (hasVvi2) score += 15;
    if (hasOneds) score += 15;
    if (sig.qva1 && sig.qva1.score >= 80) score += 5;
    if (sig.qva2 && sig.qva2.score >= 70) score += 5;
    if (qva1DaysAgo != null && qva1DaysAgo <= 7) score += 5;
    if (qva2DaysAgo != null && qva2DaysAgo <= 7) score += 5;
    // 오늘 흐름
    if (valueRatio20 != null && valueRatio20 >= 2) score += 10;
    if (latestChangePct != null && latestChangePct > 3) score += 5;
    if (closeStrong) score += 5;
    if (nearRecentHigh) score += 5;
    // 감점
    if (alreadyExtended) score -= 10;
    if (recentMaxDrop != null && recentMaxDrop <= -10) score -= 10;
    if (!chart) score -= 3;
    score = Math.max(0, Math.min(150, score));

    let grade = 'D';
    if (score >= 70) grade = 'A';
    else if (score >= 55) grade = 'B';
    else if (score >= 40) grade = 'C';

    // 해석 문구
    const interp = [];
    if (bestThemeStrength === 'STRONG' && hasQva2)      interp.push(`전일 미국장 ${bestThemeLabel} STRONG + 최근 QVA2 수급`);
    else if (bestThemeStrength === 'STRONG' && hasQva1) interp.push(`전일 미국장 ${bestThemeLabel} STRONG + 최근 QVA1 발생`);
    else if (bestThemeStrength === 'STRONG' && hasVvi2) interp.push(`${bestThemeLabel} STRONG + 최근 VVI2 발화`);
    else if (bestThemeStrength === 'STRONG' && hasOneds) interp.push(`${bestThemeLabel} STRONG + 최근 1DS 발화`);
    else if (bestThemeStrength === 'STRONG' && !hasAnySignal) interp.push(`${bestThemeLabel} STRONG이지만 국내 수급 신호는 아직 약함`);
    else if (bestThemeStrength === 'MID' && hasAnySignal) interp.push(`${bestThemeLabel} MID + ${hasQva2 ? 'QVA2' : hasQva1 ? 'QVA1' : hasVvi2 ? 'VVI2' : '1DS'} 신호`);
    else if (hasAnySignal && themeMatches.length === 0)  interp.push('국내 수급 신호 있으나 나스닥 테마 매칭 없음');
    else if (themeMatches.length > 0 && !hasAnySignal)   interp.push('테마 매칭은 있지만 최근 국내 신호 없음');
    else if (!hasAnySignal && themeMatches.length === 0) interp.push('테마/신호 모두 약함');
    if (alreadyExtended)                                  interp.push('이미 많이 오른 상태 — 추격 주의');
    if (recentMaxDrop != null && recentMaxDrop <= -10)    interp.push('최근 -10% 이상 흔들림 — 위험');

    // ─── 추가 방어 필터: bestThemeStrength NONE도 제외 (SHIPBUILDING 등 UNKNOWN 강도 테마) ───
    if (bestThemeStrength === 'NONE') {
      excludedNoThemeCount++;
      continue;
    }

    candidates.push({
      code, name,
      // 테마
      matchedThemes: themeMatches.map(m => m.themeKey),
      bestThemeKey, bestThemeLabel, bestThemeStrength,
      themeMatchReason, bestStrongRatio: Number(bestStrongRatio.toFixed(3)),
      bestAvgChange: bestAvgChange === -999 ? null : bestAvgChange,
      bestThemeReason,
      isStrongTheme: bestThemeStrength === 'STRONG',
      isMidTheme: bestThemeStrength === 'MID',
      // 신호
      hasQva1, qva1Date: sig.qva1?.date || null, qva1Score: sig.qva1?.score || null, qva1DaysAgo,
      hasQva2, qva2Date: sig.qva2?.date || null, qva2Score: sig.qva2?.score || null, qva2Type: sig.qva2?.type || null, qva2DaysAgo,
      hasVvi2, vvi2Date: sig.vvi2?.date || null, vvi2DaysAgo,
      hasOneDaySurge: hasOneds, oneDaySurgeDate: sig.oneds?.date || null,
      oneDaySurgeScore: sig.oneds?.score || null, oneDaySurgeDaysAgo: onedsDaysAgo,
      oneDaySurgeKind: sig.oneds?.signalKind || null,
      hasAnySignal,
      signalSummary: [
        hasQva1 ? `QVA1(${qva1DaysAgo}일전)` : null,
        hasQva2 ? `QVA2(${qva2DaysAgo}일전)` : null,
        hasVvi2 ? `VVI2(${vvi2DaysAgo}일전)` : null,
        hasOneds ? `1DS(${onedsDaysAgo}일전)` : null,
      ].filter(Boolean).join(' · '),
      // 오늘 흐름
      latestDate, latestClose, latestChangePct, latestValue, latestVolume,
      valueRatio5, valueRatio20,
      nearRecentHigh, closeStrong, alreadyExtended,
      recentMaxDrop,
      // 점수
      themeWatchScore: score, grade,
      interpret: interp.join(' / '),
    });
  }

  // 7) 정렬
  const rank = { STRONG: 3, MID: 2, WEAK: 1, NONE: 0 };
  candidates.sort((a, b) => {
    const ra = rank[a.bestThemeStrength] || 0;
    const rb = rank[b.bestThemeStrength] || 0;
    if (ra !== rb) return rb - ra;
    if (a.themeWatchScore !== b.themeWatchScore) return b.themeWatchScore - a.themeWatchScore;
    const aRecent = (a.hasVvi2 || a.hasOneDaySurge) ? 1 : 0;
    const bRecent = (b.hasVvi2 || b.hasOneDaySurge) ? 1 : 0;
    if (aRecent !== bRecent) return bRecent - aRecent;
    if (a.hasQva2 !== b.hasQva2) return b.hasQva2 ? 1 : -1;
    if (a.hasQva1 !== b.hasQva1) return b.hasQva1 ? 1 : -1;
    if ((b.latestValue || 0) !== (a.latestValue || 0)) return (b.latestValue || 0) - (a.latestValue || 0);
    return 0;
  });

  // 8) 그룹핑
  const gradeA = candidates.filter(c => c.grade === 'A');
  const gradeB = candidates.filter(c => c.grade === 'B');
  const gradeC = candidates.filter(c => c.grade === 'C');
  const gradeD = candidates.filter(c => c.grade === 'D');

  const groupedByTheme = {};
  for (const tk of themeKeys) {
    const list = candidates.filter(c => c.matchedThemes.includes(tk));
    groupedByTheme[tk] = list.slice(0, STOCKS_LIMIT_PER_THEME);
  }
  const groupedBySignal = {
    QVA1: candidates.filter(c => c.hasQva1),
    QVA2: candidates.filter(c => c.hasQva2),
    VVI2: candidates.filter(c => c.hasVvi2),
    ONE_DAY_SURGE: candidates.filter(c => c.hasOneDaySurge),
    THEME_ONLY: candidates.filter(c => !c.hasAnySignal && c.matchedThemes.length > 0),
  };

  const summary = {
    totalCandidates: candidates.length,
    gradeA: gradeA.length,
    gradeB: gradeB.length,
    gradeC: gradeC.length,
    gradeD: gradeD.length,
    strongThemeCandidates: candidates.filter(c => c.isStrongTheme).length,
    midThemeCandidates: candidates.filter(c => c.isMidTheme).length,
    qva1Candidates: candidates.filter(c => c.hasQva1).length,
    qva2Candidates: candidates.filter(c => c.hasQva2).length,
    vvi2Candidates: candidates.filter(c => c.hasVvi2).length,
    oneDaySurgeCandidates: candidates.filter(c => c.hasOneDaySurge).length,
  };

  // 9) JSON 저장
  const result = {
    generatedAt: new Date().toISOString(),
    themeDate: latestDaily?.date || null,
    usMarketDate: latestDaily?.usMarketDate || null,
    strongThemes: strongThemes.map(k => ({
      themeKey: k, label: themesMap[k].label, ...themeStrength[k],
    })),
    midThemes: midThemes.map(k => ({
      themeKey: k, label: themesMap[k].label, ...themeStrength[k],
    })),
    candidates,
    groupedByTheme,
    groupedBySignal,
    summary,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  console.log(`✅ JSON: ${OUT_JSON}`);
  fs.writeFileSync(OUT_HTML, renderHtml({ themesMap, themeStrength, latestDaily, result }));
  console.log(`✅ HTML: ${OUT_HTML}`);

  // 10) 콘솔
  console.log();
  console.log('━'.repeat(80));
  console.log('=== 오늘 지켜볼 후보 보드 요약 ===');
  console.log(`테마 기준 날짜: ${latestDaily?.date || '—'} (US ${latestDaily?.usMarketDate || '—'})`);
  console.log(`STRONG 테마: ${strongThemes.map(k => themesMap[k].label).join(', ') || '—'}`);
  console.log(`MID 테마:    ${midThemes.map(k => themesMap[k].label).join(', ') || '—'}`);
  console.log();
  // ─── 후보 포함 기준 검증 ───
  console.log(`원본 후보 풀:        ${sigByCode.size}`);
  console.log(`제외 (테마 매칭 X): ${excludedNoThemeCount}`);
  console.log(`최종 후보 (테마 O): ${candidates.length}`);
  const noneStrengthCount = candidates.filter(c => c.bestThemeStrength === 'NONE').length;
  const emptyMatchedCount = candidates.filter(c => !c.matchedThemes || c.matchedThemes.length === 0).length;
  console.log(`  └ bestThemeStrength=NONE: ${noneStrengthCount} (기대 0) ${noneStrengthCount === 0 ? '✓' : '❌'}`);
  console.log(`  └ matchedThemes 비어있음: ${emptyMatchedCount} (기대 0) ${emptyMatchedCount === 0 ? '✓' : '❌'}`);
  console.log(`  A (최우선 관찰):   ${summary.gradeA}`);
  console.log(`  B (우선 관찰):     ${summary.gradeB}`);
  console.log(`  C (테마 후보):     ${summary.gradeC}`);
  console.log(`  D (참고):          ${summary.gradeD}`);
  console.log(`STRONG 테마 매칭:   ${summary.strongThemeCandidates}`);
  console.log(`MID 테마 매칭:      ${summary.midThemeCandidates}`);
  console.log(`QVA1 연결: ${summary.qva1Candidates} / QVA2: ${summary.qva2Candidates} / VVI2: ${summary.vvi2Candidates} / 1DS: ${summary.oneDaySurgeCandidates}`);
  console.log();
  console.log('테마별 후보:');
  for (const tk of themeKeys) {
    const n = groupedByTheme[tk].length;
    const strength = themeStrength[tk]?.strength || 'NONE';
    if (n > 0) console.log(`  ${themesMap[tk].label.padEnd(18)} [${strength.padEnd(6)}] ${n}건`);
  }
  console.log();
  console.log(`⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`결과 파일:`);
  console.log(`  ${OUT_JSON}`);
  console.log(`  ${OUT_HTML}`);

  await closePool();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
