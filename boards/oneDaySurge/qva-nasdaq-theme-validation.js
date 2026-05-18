#!/usr/bin/env node
/**
 * QVA 후보 × 나스닥 테마 흐름 매칭 검증
 *
 * 목표:
 *   QVA1/QVA2 후보 중에서 전일 나스닥에서 강했던 테마와 연결되는 종목이 이후 더 좋은
 *   성과(BIG_20/30/50/SUPER_FIRE/실제 VVI2 전환)를 보이는지 검증.
 *
 * 중요:
 *   - 새 운영 보드/라우터/cron 추가 X.
 *   - 자동매수 신호 아님 — QVA 후보 우선순위 정렬 기준 검증.
 *   - 수동 매핑 JSON 기반 (data/theme/nasdaq-theme-map.json + nasdaq-theme-daily.json).
 *     실시간 뉴스/LLM 분류 X.
 *   - 기존 QVA1/QVA2/VVI2 본체 로직 변경 X.
 *
 * 입력:
 *   - DB board_signals (QVA1/QVA2 — raw_json에서 score 추출)
 *   - cache/stock-charts-long/{code}.json (일봉)
 *   - data/theme/nasdaq-theme-map.json (테마 ↔ 국내종목 매핑)
 *   - data/theme/nasdaq-theme-daily.json (전일 나스닥 테마 강도)
 *
 * 출력:
 *   - reports/qva-nasdaq-theme-validation-result.json
 *   - reports/qva-nasdaq-theme-validation-result.html
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { query, closePool, isEnabled } = require(path.join(ROOT, 'src', 'db', 'mysql'));
const { findVvi2AfterQva2 } = require(path.join(ROOT, 'boards', 'qva2', 'qva2-screener'));

const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const THEME_MAP_PATH = path.join(ROOT, 'data', 'theme', 'nasdaq-theme-map.json');
const THEME_DAILY_PATH = path.join(ROOT, 'data', 'theme', 'nasdaq-theme-daily.json');
const OUT_JSON = path.join(ROOT, 'reports', 'qva-nasdaq-theme-validation-result.json');
const OUT_HTML = path.join(ROOT, 'reports', 'qva-nasdaq-theme-validation-result.html');

const FOLLOW_DAYS = 20;

// ─── 유틸 ────────────────────────────────────────────────────────────────
function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}
function pct(num, denom) {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return null;
  return Number(((num / denom - 1) * 100).toFixed(2));
}
function fmtPct(v, p = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + Number(v).toFixed(p) + '%';
}
function avg(arr) {
  const xs = arr.filter(v => Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}
function rate(num, denom) { return denom > 0 ? Number((num / denom * 100).toFixed(1)) : 0; }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sampleQualityOf(n) {
  if (n >= 300) return '신뢰가능';
  if (n >= 100) return '참고가능';
  if (n >=  30) return '표본작음';
  return '해석주의';
}
function sampleQualityPill(q) {
  const map = { '신뢰가능': 'p-good', '참고가능': 'p-q2', '표본작음': 'p-neu', '해석주의': 'p-warn' };
  return `<span class="pill ${map[q] || 'p-neu'}">${esc(q)}</span>`;
}

// ─── 테마 강도 ──────────────────────────────────────────────────────────
function classifyThemeStrength(t) {
  if (!t) return 'NONE';
  const ratio = t.totalTickerCount > 0 ? t.strongTickerCount / t.totalTickerCount : 0;
  if (t.avgChangePct >= 2.5 || ratio >= 0.6) return 'STRONG';
  if (t.avgChangePct >= 1.0) return 'MID';
  return 'WEAK';
}

// QVA 신호 date에 가장 가까운 (그날 또는 그 이전) nasdaq daily entry 찾기
function findNasdaqThemeAt(dailyHistory, qvaDate) {
  // qvaDate: 'YYYY-MM-DD'
  // dailyHistory: [{date: 'YYYY-MM-DD', themes: {...}}, ...] 내림차순/오름차순 무관 — 단순 조회
  const sorted = dailyHistory.slice().sort((a, b) => b.date.localeCompare(a.date));
  for (const e of sorted) {
    if (e.date <= qvaDate) return e;
  }
  // 가장 가까운 게 미래라면 (history가 qvaDate보다 늦은 데이터만 있으면) 가장 최근 사용 (fallback)
  return sorted[sorted.length - 1] || null;
}

// 종목명 → 테마 매칭
function matchThemes(stockName, themesMap) {
  const matched = [];
  for (const key of Object.keys(themesMap)) {
    const t = themesMap[key];
    if (!t.krStocks) continue;
    if (t.krStocks.some(s => s === stockName)) {
      matched.push({ themeKey: key, label: t.label, matchType: 'directStockMatch' });
    }
  }
  // krKeywords는 종목명 부분 일치 (사용자 spec: "데이터가 없으면 일단 종목명 직접 매칭만")
  // 향후 업종 데이터 들어오면 확장. 일단 단순화.
  return matched;
}

// ─── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  if (!isEnabled()) { console.error('❌ .env DB_* 미설정'); process.exit(1); }
  console.log('🔍 QVA × 나스닥 테마 흐름 매칭 검증');
  const t0 = Date.now();

  // 테마 매핑 + 일일 강도 로드
  const themeMap = JSON.parse(fs.readFileSync(THEME_MAP_PATH, 'utf-8')).themes;
  const themeDaily = JSON.parse(fs.readFileSync(THEME_DAILY_PATH, 'utf-8')).history;
  const themeKeys = Object.keys(themeMap);
  console.log(`  테마 ${themeKeys.length}개 / 일일 강도 ${themeDaily.length}일치`);

  // QVA 신호 로드 (raw_json 포함)
  const qvaRows = await query(`
    SELECT signal_date, board_name, signal_kind, stock_code, stock_name, raw_json
    FROM board_signals
    WHERE (board_name = 'QVA_WATCHLIST'  AND signal_kind = 'QVA_NEW')
       OR (board_name = 'QVA2_WATCHLIST' AND signal_kind = 'QVA2_NEW')
    ORDER BY signal_date, stock_code
  `);
  console.log(`  QVA 신호 ${qvaRows.length}건`);

  // 각 신호 추적
  const chartCache = new Map();
  function getChart(code) {
    if (chartCache.has(code)) return chartCache.get(code);
    const c = loadChart(code);
    chartCache.set(code, c);
    return c;
  }

  const signals = [];
  let skipped = 0;

  for (const qva of qvaRows) {
    const code = qva.stock_code;
    const name = qva.stock_name;
    const qvaType = qva.board_name === 'QVA_WATCHLIST' ? 'QVA1' : 'QVA2';
    const qvaDate = String(qva.signal_date).slice(0,10);
    const qvaDateYMD = qvaDate.replace(/-/g, '');
    const chart = getChart(code);
    if (!chart || !chart.rows) { skipped++; continue; }
    const rows = chart.rows;
    const qvaIdx = rows.findIndex(r => String(r.date) === qvaDateYMD);
    if (qvaIdx < 0) { skipped++; continue; }
    const qvaRow = rows[qvaIdx];
    const qvaClose = qvaRow.close;
    const qvaHigh = qvaRow.high;
    if (!qvaClose || !qvaHigh) { skipped++; continue; }

    // QVA score (raw_json에서 추출)
    let qvaScore = 0;
    try {
      const raw = qva.raw_json ? (typeof qva.raw_json === 'string' ? JSON.parse(qva.raw_json) : qva.raw_json) : null;
      qvaScore = raw?.bestEarlyQvaScore ?? raw?.score ?? 0;
    } catch (_) {}

    // D+1~D+20 추적
    let maxHigh = qvaHigh, minClose = qvaClose;
    for (let d = 1; d <= FOLLOW_DAYS; d++) {
      const idx = qvaIdx + d;
      if (idx >= rows.length) break;
      const row = rows[idx];
      if (Number.isFinite(row.high))  maxHigh  = Math.max(maxHigh, row.high);
      if (Number.isFinite(row.close)) minClose = Math.min(minClose, row.close);
    }
    const maxUpsidePct = pct(maxHigh, qvaClose);
    const maxDropPct = pct(minClose, qvaClose);
    const bigGroups = [];
    if (maxUpsidePct != null) {
      if (maxUpsidePct >= 20)  bigGroups.push('BIG_20');
      if (maxUpsidePct >= 30)  bigGroups.push('BIG_30');
      if (maxUpsidePct >= 50)  bigGroups.push('BIG_50');
      if (maxUpsidePct >= 100) bigGroups.push('SUPER_FIRE');
      if (maxUpsidePct < 20)   bigGroups.push('NON_BIG');
    }

    // 실제 VVI2 확정
    const vvi2Res = findVvi2AfterQva2(rows, qvaIdx, FOLLOW_DAYS, { qva2Type: 'absorption' });
    const isActualVvi2 = vvi2Res.vvi2Idx > 0;

    // VVI2_PRE_A 근사 — D+1~D+20 중 일봉 PRE_A_STRONG 발생일 있으면 true (이전 검증과 동일 정의)
    let hasDailyPreA = false;
    const qvaVolume = qvaRow.volume || 0;
    const qvaValue = qvaRow.valueApprox || (qvaClose * qvaVolume);
    for (let d = 1; d <= FOLLOW_DAYS && qvaVolume > 0 && qvaValue > 0; d++) {
      const idx = qvaIdx + d;
      if (idx >= rows.length) break;
      const row = rows[idx];
      const dHigh = row.high, dClose = row.close;
      const dVol = row.volume || 0;
      const dVal = row.valueApprox || (dClose * dVol);
      if (dHigh >= qvaHigh && dVal >= qvaValue && dVol >= qvaVolume && dClose >= qvaHigh) {
        hasDailyPreA = true; break;
      }
    }

    // 테마 매칭
    const matched = matchThemes(name, themeMap);
    // 나스닥 테마 강도 lookup
    const nasdaqEntry = findNasdaqThemeAt(themeDaily, qvaDate);
    let bestThemeKey = null, bestThemeLabel = null, bestThemeStrength = 'NONE';
    let themeMatchReason = matched.length > 0 ? 'directStockMatch' : 'no_match';
    let bestStrongRatio = 0, bestAvgChange = -999;
    for (const m of matched) {
      const td = nasdaqEntry?.themes?.[m.themeKey];
      if (!td) continue;
      const strength = classifyThemeStrength(td);
      const ratio = td.totalTickerCount > 0 ? td.strongTickerCount / td.totalTickerCount : 0;
      const rank = { STRONG: 3, MID: 2, WEAK: 1, NONE: 0 };
      const curRank = rank[bestThemeStrength] || 0;
      if (rank[strength] > curRank || (rank[strength] === curRank && ratio > bestStrongRatio)) {
        bestThemeKey = m.themeKey;
        bestThemeLabel = m.label;
        bestThemeStrength = strength;
        bestStrongRatio = ratio;
        bestAvgChange = td.avgChangePct;
      }
    }

    // themeScore 계산
    let themeScore = 0;
    if (matched.length > 0) themeScore += 10; // directStockMatch
    if (bestThemeStrength === 'STRONG') themeScore += 10;
    else if (bestThemeStrength === 'MID') themeScore += 5;
    if (bestStrongRatio >= 0.6) themeScore += 5;
    if (qvaType === 'QVA2') themeScore += 3;
    if (qvaScore >= 80) themeScore += 2;
    themeScore = Math.min(30, themeScore);

    // 거래대금 강도 점수 (qvaScore와 별개)
    const last20 = rows.slice(Math.max(0, qvaIdx - 19), qvaIdx + 1);
    const avg20Value = avg(last20.map(r => r.valueApprox || 0));
    const todayValue = qvaRow.valueApprox || 0;
    const valStrength = avg20Value > 0 ? todayValue / avg20Value : 1;
    let valueStrengthScore = 0;
    if (valStrength >= 5) valueStrengthScore = 8;
    else if (valStrength >= 3) valueStrengthScore = 5;
    else if (valStrength >= 2) valueStrengthScore = 2;

    // finalScore = qvaScore + themeScore + valueStrengthScore (+ QVA2 가산점 — themeScore에 이미 포함)
    const finalScore = qvaScore + themeScore + valueStrengthScore;

    signals.push({
      code, name, qvaType, qvaDate,
      qvaClose, qvaHigh, qvaScore,
      maxUpsidePct, maxDropPct,
      bigGroups,
      isActualVvi2,
      hasDailyPreA,
      breach5:  maxDropPct != null && maxDropPct < -5,
      breach10: maxDropPct != null && maxDropPct < -10,
      // 테마
      matchedThemes: matched.map(m => m.themeKey),
      themeMatchCount: matched.length,
      bestThemeKey, bestThemeLabel, bestThemeStrength,
      themeMatchReason,
      bestStrongRatio: Number(bestStrongRatio.toFixed(3)),
      bestAvgChange: bestAvgChange === -999 ? null : bestAvgChange,
      // 점수
      themeScore, valueStrength: Number(valStrength.toFixed(2)), valueStrengthScore,
      finalScore,
    });
  }
  console.log(`  추적 ${signals.length} / skip ${skipped}`);

  // ─── 그룹 집계 ────────────────────────────────────────────────────────
  function makeGroupStat(label, items) {
    const n = items.length;
    if (n === 0) return { group: label, n: 0, sampleQuality: sampleQualityOf(0) };
    return {
      group: label, n, sampleQuality: sampleQualityOf(n),
      qva1Count: items.filter(x => x.qvaType === 'QVA1').length,
      qva2Count: items.filter(x => x.qvaType === 'QVA2').length,
      avgMaxUp: Number((avg(items.map(x => x.maxUpsidePct)) ?? 0).toFixed(2)),
      avgD5MaxUp: null, // (해당 정확 계산은 chart 추적 시 별도 필요 — 단순화로 maxUp만)
      big20Rate: rate(items.filter(x => x.bigGroups.includes('BIG_20')).length, n),
      big30Rate: rate(items.filter(x => x.bigGroups.includes('BIG_30')).length, n),
      big50Rate: rate(items.filter(x => x.bigGroups.includes('BIG_50')).length, n),
      superFireRate: rate(items.filter(x => x.bigGroups.includes('SUPER_FIRE')).length, n),
      actualVvi2Rate: rate(items.filter(x => x.isActualVvi2).length, n),
      dailyPreARate:  rate(items.filter(x => x.hasDailyPreA).length, n),
      breach5Rate:  rate(items.filter(x => x.breach5).length, n),
      breach10Rate: rate(items.filter(x => x.breach10).length, n),
      avgQvaScore:   Number((avg(items.map(x => x.qvaScore)) ?? 0).toFixed(1)),
      avgThemeScore: Number((avg(items.map(x => x.themeScore)) ?? 0).toFixed(1)),
      avgFinalScore: Number((avg(items.map(x => x.finalScore)) ?? 0).toFixed(1)),
    };
  }

  const groups = [
    makeGroupStat('ALL_QVA',                  signals),
    makeGroupStat('QVA_WITH_NASDAQ_THEME',    signals.filter(x => x.themeMatchCount > 0)),
    makeGroupStat('QVA_WITH_STRONG_THEME',    signals.filter(x => x.bestThemeStrength === 'STRONG')),
    makeGroupStat('QVA_WITH_MID_THEME',       signals.filter(x => x.bestThemeStrength === 'MID')),
    makeGroupStat('QVA_WITHOUT_THEME',        signals.filter(x => x.themeMatchCount === 0)),
    makeGroupStat('QVA1_WITH_STRONG_THEME',   signals.filter(x => x.qvaType === 'QVA1' && x.bestThemeStrength === 'STRONG')),
    makeGroupStat('QVA2_WITH_STRONG_THEME',   signals.filter(x => x.qvaType === 'QVA2' && x.bestThemeStrength === 'STRONG')),
  ];

  // 테마별
  const themeGroups = themeKeys.map(k => makeGroupStat('THEME_' + k, signals.filter(x => x.matchedThemes.includes(k))));

  // themeScore 구간별
  function inRange(n, lo, hi) { return n >= lo && n <= hi; }
  const themeScoreBuckets = [
    makeGroupStat('THEME_SCORE_0',     signals.filter(x => x.themeScore === 0)),
    makeGroupStat('THEME_SCORE_1_9',   signals.filter(x => inRange(x.themeScore, 1, 9))),
    makeGroupStat('THEME_SCORE_10_19', signals.filter(x => inRange(x.themeScore, 10, 19))),
    makeGroupStat('THEME_SCORE_20_30', signals.filter(x => inRange(x.themeScore, 20, 30))),
  ];

  // ─── finalScore 일자별 TOP-N 시뮬레이션 ────────────────────────────────
  // 각 qvaDate별로 finalScore 정렬, TOP-N에 해당하는 signal만 모음
  const byDate = new Map();
  for (const s of signals) {
    if (!byDate.has(s.qvaDate)) byDate.set(s.qvaDate, []);
    byDate.get(s.qvaDate).push(s);
  }
  function topNPerDay(n) {
    const picked = [];
    for (const [date, arr] of byDate) {
      const sorted = arr.slice().sort((a, b) => b.finalScore - a.finalScore);
      for (const s of sorted.slice(0, n)) picked.push(s);
    }
    return picked;
  }
  const topNGroups = [
    makeGroupStat('TOP_10_PER_DAY', topNPerDay(10)),
    makeGroupStat('TOP_20_PER_DAY', topNPerDay(20)),
    makeGroupStat('TOP_30_PER_DAY', topNPerDay(30)),
  ];

  // ─── 대표 사례 ───────────────────────────────────────────────────────
  function caseRow(s, interpret) {
    return {
      code: s.code, name: s.name, qvaType: s.qvaType, qvaDate: s.qvaDate,
      qvaScore: s.qvaScore, themeScore: s.themeScore, finalScore: s.finalScore,
      bestThemeKey: s.bestThemeKey, bestThemeLabel: s.bestThemeLabel,
      bestThemeStrength: s.bestThemeStrength,
      bestAvgChange: s.bestAvgChange,
      maxUpsidePct: s.maxUpsidePct, maxDropPct: s.maxDropPct,
      bigGroups: s.bigGroups,
      isActualVvi2: s.isActualVvi2, hasDailyPreA: s.hasDailyPreA,
      interpret,
    };
  }
  const winners = signals
    .filter(x => x.bestThemeStrength === 'STRONG' && x.bigGroups.includes('BIG_50'))
    .slice().sort((a, b) => (b.maxUpsidePct || 0) - (a.maxUpsidePct || 0))
    .slice(0, 15).map(s => caseRow(s, `QVA${s.qvaType.slice(-1)} + ${s.bestThemeLabel} STRONG → ${fmtPct(s.maxUpsidePct, 1)}` + (s.bigGroups.includes('SUPER_FIRE') ? ' (SUPER_FIRE)' : '')));
  const losers = signals
    .filter(x => x.bestThemeStrength === 'STRONG' && x.breach10)
    .slice().sort((a, b) => (a.maxDropPct || 0) - (b.maxDropPct || 0))
    .slice(0, 15).map(s => caseRow(s, `${s.bestThemeLabel} STRONG이었지만 ${fmtPct(s.maxDropPct, 1)} 이탈`));

  // 오늘 기준 예시 — 최신 QVA 후보 중 strong theme
  // signals에서 가장 최근 qvaDate 추출
  const dates = [...new Set(signals.map(s => s.qvaDate))].sort();
  const todayDate = dates[dates.length - 1];
  const todayCandidates = signals
    .filter(s => s.qvaDate === todayDate && s.bestThemeStrength === 'STRONG')
    .slice().sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 20)
    .map(s => caseRow(s, `${s.bestThemeLabel} STRONG (finalScore ${s.finalScore})`));

  // ─── 요약 ────────────────────────────────────────────────────────────
  const allG     = groups.find(g => g.group === 'ALL_QVA');
  const withT    = groups.find(g => g.group === 'QVA_WITH_NASDAQ_THEME');
  const withS    = groups.find(g => g.group === 'QVA_WITH_STRONG_THEME');
  const without  = groups.find(g => g.group === 'QVA_WITHOUT_THEME');
  // lift: STRONG_THEME big50 / WITHOUT_THEME big50
  const liftBig50 = without && without.big50Rate > 0 ? Number((withS.big50Rate / without.big50Rate).toFixed(2)) : null;
  // 가장 좋은 테마 (BIG_50 기준)
  const bestThemes = themeGroups.filter(g => g.n >= 30).slice().sort((a, b) => b.big50Rate - a.big50Rate).slice(0, 5);

  const summary = {
    totalCandidates: signals.length,
    withThemeN: withT?.n || 0,
    strongThemeN: withS?.n || 0,
    midThemeN: groups.find(g => g.group === 'QVA_WITH_MID_THEME')?.n || 0,
    withoutThemeN: without?.n || 0,
    strongThemeBig50: withS?.big50Rate || 0,
    withoutThemeBig50: without?.big50Rate || 0,
    liftBig50,
    bestThemes: bestThemes.map(t => ({ theme: t.group, n: t.n, big50Rate: t.big50Rate, big30Rate: t.big30Rate, superRate: t.superFireRate })),
    top10PerDay: topNGroups.find(g => g.group === 'TOP_10_PER_DAY'),
    top20PerDay: topNGroups.find(g => g.group === 'TOP_20_PER_DAY'),
    top30PerDay: topNGroups.find(g => g.group === 'TOP_30_PER_DAY'),
    todayDate,
    todayStrongCandidateCount: todayCandidates.length,
  };

  const result = {
    meta: {
      title: 'QVA × 나스닥 테마 흐름 매칭 검증',
      generatedAt: new Date().toISOString(),
      followDays: FOLLOW_DAYS,
      themeMapVersion: JSON.parse(fs.readFileSync(THEME_MAP_PATH, 'utf-8'))._meta?.version || 'unknown',
      themeDailyDates: themeDaily.map(d => d.date),
    },
    summary,
    groups,
    themeGroups,
    themeScoreBuckets,
    topNGroups,
    cases: { winners, losers, todayCandidates },
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  console.log(`✅ JSON: ${OUT_JSON}`);
  fs.writeFileSync(OUT_HTML, renderHtml(result));
  console.log(`✅ HTML: ${OUT_HTML}`);

  // 콘솔
  console.log();
  console.log('━'.repeat(80));
  console.log('=== QVA × 나스닥 테마 검증 요약 ===');
  console.log(`전체 QVA: ${signals.length} / 테마 매칭: ${withT.n} (${rate(withT.n, signals.length)}%) / STRONG_THEME: ${withS.n}`);
  console.log();
  console.log(`▶ QVA_WITH_STRONG_THEME BIG_50: ${withS.big50Rate}%`);
  console.log(`▶ QVA_WITHOUT_THEME    BIG_50: ${without.big50Rate}%`);
  if (liftBig50 != null) console.log(`▶ lift: ${liftBig50}x`);
  console.log();
  console.log('테마별 BIG_50 TOP 3:');
  for (let i = 0; i < Math.min(3, bestThemes.length); i++) {
    const t = bestThemes[i];
    console.log(`  ${i+1}. ${t.group} — n=${t.n} BIG_50 ${t.big50Rate}% BIG_30 ${t.big30Rate}% SUPER ${t.superFireRate}%`);
  }
  console.log();
  const top10 = summary.top10PerDay;
  if (top10 && top10.n > 0) {
    console.log(`▶ TOP_10_PER_DAY 성과: n=${top10.n} / BIG_20 ${top10.big20Rate}% / BIG_50 ${top10.big50Rate}% / SUPER ${top10.superFireRate}% / VVI2 ${top10.actualVvi2Rate}% / 이탈10 ${top10.breach10Rate}%`);
  }
  console.log();
  // 운영 적용 결론
  if (withS.n >= 30 && liftBig50 != null) {
    if (liftBig50 >= 1.5) console.log(`▶ 운영 적용 가능성: 나스닥 STRONG 테마 매칭이 BIG_50 ${liftBig50}x lift — 우선순위 정렬 기준으로 가치 있음`);
    else if (liftBig50 >= 1.2) console.log(`▶ 운영 적용 가능성: lift ${liftBig50}x — 약하지만 의미 있음, 추가 데이터 누적 필요`);
    else console.log(`▶ 운영 적용 가능성: lift ${liftBig50}x — 효과 약함, 추가 튜닝 또는 매핑 보완 필요`);
  } else {
    console.log(`▶ 운영 적용 가능성: 표본 부족 (STRONG_THEME n=${withS.n}) — 매핑 확장 + 일일 데이터 누적 필요`);
  }
  console.log(`⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await closePool();
}

// ─── HTML 렌더 ───────────────────────────────────────────────────────────
function renderHtml(result) {
  const { meta, summary, groups, themeGroups, themeScoreBuckets, topNGroups, cases } = result;

  function groupRow(g) {
    if (!g || g.n === 0) return `<tr><td><b>${esc(g.group)}</b></td><td colspan="14">데이터 없음</td></tr>`;
    return '<tr>' +
      `<td><b>${esc(g.group)}</b></td>` +
      `<td class="num">${g.n}</td>` +
      `<td>${sampleQualityPill(g.sampleQuality)}</td>` +
      `<td class="num">${g.qva1Count}/${g.qva2Count}</td>` +
      `<td class="num">${fmtPct(g.avgMaxUp)}</td>` +
      `<td class="num">${g.big20Rate}%</td>` +
      `<td class="num">${g.big30Rate}%</td>` +
      `<td class="num pos">${g.big50Rate}%</td>` +
      `<td class="num pos">${g.superFireRate}%</td>` +
      `<td class="num">${g.actualVvi2Rate}%</td>` +
      `<td class="num">${g.dailyPreARate}%</td>` +
      `<td class="num neg">${g.breach5Rate}%</td>` +
      `<td class="num neg">${g.breach10Rate}%</td>` +
      `<td class="num">${g.avgQvaScore}</td>` +
      `<td class="num">${g.avgThemeScore}</td>` +
      `<td class="num">${g.avgFinalScore}</td>` +
      '</tr>';
  }
  const headRow = '<thead><tr>' +
    '<th>그룹</th><th>n</th><th>표본</th><th>QVA1/QVA2</th><th>avg maxUp</th>' +
    '<th>BIG_20</th><th>BIG_30</th><th>BIG_50</th><th>SUPER</th>' +
    '<th>VVI2 확정</th><th>일봉 PreA</th>' +
    '<th>-5%</th><th>-10%</th>' +
    '<th>avg QVA</th><th>avg theme</th><th>avg final</th>' +
    '</tr></thead>';
  function groupTable(rows) { return '<table class="t">' + headRow + '<tbody>' + rows.map(groupRow).join('') + '</tbody></table>'; }

  function caseTable(list, emptyMsg) {
    if (!list || list.length === 0) return `<div class="empty">${esc(emptyMsg)}</div>`;
    return '<table class="t"><thead><tr>' +
      '<th>종목</th><th>QVA</th><th>QVA일</th>' +
      '<th>QVA score</th><th>theme score</th><th>final</th>' +
      '<th>테마</th><th>강도</th><th>나스닥 등락</th>' +
      '<th>maxUp</th><th>maxDown</th>' +
      '<th>BIG?</th><th>VVI2</th><th>일봉 PreA</th>' +
      '<th>해석</th>' +
      '</tr></thead><tbody>' +
      list.map(c => '<tr>' +
        `<td><b>${esc(c.name)}</b><div class="code">${esc(c.code)}</div></td>` +
        `<td><span class="pill ${c.qvaType === 'QVA1' ? 'p-q1' : 'p-q2'}">${c.qvaType}</span></td>` +
        `<td>${esc(c.qvaDate)}</td>` +
        `<td class="num">${c.qvaScore}</td>` +
        `<td class="num">${c.themeScore}</td>` +
        `<td class="num pos"><b>${c.finalScore}</b></td>` +
        `<td>${esc(c.bestThemeLabel || '—')}</td>` +
        `<td>${c.bestThemeStrength === 'STRONG' ? '<span class="pill p-good">STRONG</span>' :
            c.bestThemeStrength === 'MID' ? '<span class="pill p-q2">MID</span>' :
            c.bestThemeStrength === 'WEAK' ? '<span class="pill p-neu">WEAK</span>' :
            '<span class="pill p-neu">—</span>'}</td>` +
        `<td class="num">${fmtPct(c.bestAvgChange)}</td>` +
        `<td class="num pos">${fmtPct(c.maxUpsidePct)}</td>` +
        `<td class="num neg">${fmtPct(c.maxDropPct)}</td>` +
        `<td>${c.bigGroups.includes('SUPER_FIRE') ? '<span class="pill p-q2">SUPER</span>' : c.bigGroups.includes('BIG_50') ? '<span class="pill p-good">BIG_50</span>' : c.bigGroups.includes('BIG_30') ? '<span class="pill p-q2">BIG_30</span>' : c.bigGroups.includes('BIG_20') ? '<span class="pill p-neu">BIG_20</span>' : '—'}</td>` +
        `<td>${c.isActualVvi2 ? '<span class="pill p-good">확정</span>' : '—'}</td>` +
        `<td>${c.hasDailyPreA ? '<span class="pill p-good">✓</span>' : '—'}</td>` +
        `<td style="font-size:11px;color:#cbd5e1;max-width:280px;">${esc(c.interpret || '')}</td>` +
        '</tr>').join('') + '</tbody></table>';
  }

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>${esc(meta.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif; background: #0f172a; color: #cbd5e1; margin: 0; padding: 18px 22px 60px; max-width: 1800px; }
  h1 { color: #f1f5f9; font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: #94a3b8; font-size: 12px; margin-bottom: 16px; }
  h2 { color: #5eead4; font-size: 17px; margin: 24px 0 10px; border-left: 4px solid #14b8a6; padding-left: 10px; }
  h3 { color: #c4b5fd; font-size: 14px; margin: 14px 0 8px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 18px; margin-bottom: 14px; }
  .card-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
  .stat { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; }
  .stat .lbl { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
  .stat .val { color: #f1f5f9; font-size: 22px; font-weight: 700; margin-top: 4px; line-height: 1.1; }
  .stat .sub { color: #94a3b8; font-size: 11px; margin-top: 2px; }
  table.t { width: 100%; border-collapse: collapse; background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; font-size: 12px; margin-bottom: 12px; }
  table.t th, table.t td { padding: 7px 9px; text-align: left; border-bottom: 1px solid #334155; color: #cbd5e1; vertical-align: top; }
  table.t th { background: #0f172a; color: #5eead4; font-weight: 600; font-size: 11px; }
  table.t td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.t td.pos { color: #86efac; font-weight: 600; }
  table.t td.neg { color: #fca5a5; }
  .code { color: #64748b; font-size: 10.5px; font-family: ui-monospace, monospace; }
  .pill { display: inline-block; padding: 1.5px 7px; border-radius: 999px; font-size: .7rem; font-weight: 600; margin: 0 2px; }
  .p-q1   { background: #052e16; color: #86efac; border: 1px solid #166534; }
  .p-q2   { background: #1e1b4b; color: #c4b5fd; border: 1px solid #4338ca; }
  .p-good { background: #064e3b; color: #a7f3d0; border: 1px solid #10b981; }
  .p-neu  { background: #0f172a; color: #64748b; border: 1px solid #334155; }
  .p-warn { background: #422006; color: #fcd34d; border: 1px solid #b45309; }
  .empty { background: rgba(0,0,0,0.3); border: 1px dashed #334155; padding: 14px; text-align: center; border-radius: 6px; color: #94a3b8; }
  .hint { color: #94a3b8; font-size: 11.5px; line-height: 1.6; margin-bottom: 8px; }
  .warn-note { background:#422006; border:1px solid #b45309; color:#fde68a; padding:10px 14px; border-radius:8px; font-size:12px; margin: 12px 0; line-height: 1.6; }
</style></head>
<body>
<h1>${esc(meta.title)}</h1>
<div class="subtitle">생성: ${esc(meta.generatedAt)} · 추적 D+1~D+${meta.followDays} · 테마 맵 v${esc(meta.themeMapVersion)} · 나스닥 강도 ${meta.themeDailyDates.length}일치</div>

<div class="warn-note">
  ⚠ <b>수동 매핑 기반 검증입니다.</b> 자동 매수 신호 X. data/theme/nasdaq-theme-{map,daily}.json을 수동으로 확장해
  매핑 정확도와 일일 강도 데이터를 키워야 의미 있는 lift가 나옴.
</div>

<h2>1. 요약</h2>
<div class="card">
  <div class="card-row">
    <div class="stat"><div class="lbl">전체 QVA 후보</div><div class="val">${summary.totalCandidates}</div></div>
    <div class="stat"><div class="lbl">테마 매칭</div><div class="val">${summary.withThemeN}</div></div>
    <div class="stat"><div class="lbl">STRONG 테마</div><div class="val pos">${summary.strongThemeN}</div></div>
    <div class="stat"><div class="lbl">MID 테마</div><div class="val">${summary.midThemeN}</div></div>
    <div class="stat"><div class="lbl">테마 없음</div><div class="val">${summary.withoutThemeN}</div></div>
    <div class="stat"><div class="lbl">STRONG BIG_50</div><div class="val pos">${summary.strongThemeBig50}%</div></div>
    <div class="stat"><div class="lbl">테마 없음 BIG_50</div><div class="val">${summary.withoutThemeBig50}%</div></div>
    <div class="stat"><div class="lbl">BIG_50 lift</div><div class="val">${summary.liftBig50 != null ? summary.liftBig50 + 'x' : '—'}</div></div>
    ${summary.bestThemes && summary.bestThemes[0] ? `<div class="stat"><div class="lbl">최고 테마</div><div class="val">${esc(summary.bestThemes[0].theme)}</div><div class="sub">BIG_50 ${summary.bestThemes[0].big50Rate}% (n=${summary.bestThemes[0].n})</div></div>` : ''}
  </div>
</div>

<h2>2. 테마 매칭 여부별 성과</h2>
${groupTable(groups)}

<h2>3. 테마별 성과 비교</h2>
<div class="hint">각 테마별로 매칭된 QVA 후보의 D+20 성과. n이 충분한 테마부터 참고.</div>
${groupTable(themeGroups)}

<h2>4. themeScore 구간별 성과</h2>
<div class="hint">themeScore = directStockMatch(10) + STRONG(10)/MID(5) + strongRatio≥0.6(5) + QVA2(3) + qvaScore≥80(2). 최대 30.</div>
${groupTable(themeScoreBuckets)}

<h2>5. finalScore TOP N 시뮬레이션 (하루에 볼 후보 압축)</h2>
<div class="hint">finalScore = qvaScore + themeScore + valueStrengthScore. 매 qvaDate별로 finalScore 상위 N개만 추렸을 때 성과.</div>
${groupTable(topNGroups)}

<h2>6. 대표 성공 사례 — QVA + STRONG 테마 + BIG_50</h2>
${caseTable(cases.winners, 'STRONG 테마 + BIG_50 사례 없음 (매핑 확장 필요)')}

<h2>7. 대표 실패 사례 — STRONG 테마였지만 -10% 이탈</h2>
${caseTable(cases.losers, 'STRONG 테마였지만 실패한 사례 없음')}

<h2>8. 오늘(${esc(summary.todayDate)}) 기준 — STRONG 테마 매칭 후보 (참고용)</h2>
<div class="hint">검증 보고서 예시 목적. 운영 매수 신호 아님. finalScore 상위 20개.</div>
${caseTable(cases.todayCandidates, '오늘 기준 STRONG 테마 매칭 후보 없음')}

<footer style="margin-top: 24px; padding: 12px; background: #1e293b; border-radius: 6px; color: #64748b; font-size: 11.5px; text-align: center;">
  수동 테마 매핑 기반 검증. 운영 보드/cron/라우터 추가 X. 매핑 확장은 data/theme/ 하위 JSON 수정.
</footer>
</body></html>`;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
