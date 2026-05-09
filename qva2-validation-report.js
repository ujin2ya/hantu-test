#!/usr/bin/env node
/**
 * QVA2 Validation Report — QVA2 신호의 D+5/D+10/D+20 outcome 검증
 *
 * 목적:
 *   QVA2 조건이 쓸 만한지 판단. 기존 QVA(qva-watchlist-board.json) 결과와는 별도.
 *   기존 reports/qva-* 파일은 읽기만 하고 수정하지 않는다.
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json (전 종목 일봉)
 *   - cache/naver-stocks-list.json (시총·이름 메타)
 *
 * 출력:
 *   - reports/qva2-validation-result.json
 *   - reports/qva2-validation-result.html
 * 라우트: GET /qva2-validation
 *
 * 환경변수:
 *   - QVA2_VALIDATION_DAYS (기본 180) — 과거 N 거래일 분량 시그널을 시뮬레이션
 *   - QVA2_VALIDATION_MAX_STOCKS (기본 무제한) — 디버깅용
 *
 * 검증 지표:
 *   - 시그널 수
 *   - D+5/D+10/D+20 평균 수익률 (close 기준)
 *   - D+5/D+10/D+20 평균 최고가 수익률 (high 기준 = MFE)
 *   - D+5/D+10/D+20 평균 최저가 수익률 (low 기준 = MAE)
 *   - +5% / +10% / +15% / +20% / +30% 도달률 (D+20 윈도우 안)
 *   - 종가 양수율 (D+5/D+10/D+20)
 *   - 등급별 (STRONG_QVA2 / QVA2 / WATCH_QVA2) 비교
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { calculateQVA2 } = require('./qva2-screener');

const ROOT = __dirname;
const CHART_DIR    = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST   = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const REPORTS_DIR  = path.join(ROOT, 'reports');
const OUT_JSON     = path.join(REPORTS_DIR, 'qva2-validation-result.json');
const OUT_HTML     = path.join(REPORTS_DIR, 'qva2-validation-result.html');

const VALIDATION_DAYS = Number(process.env.QVA2_VALIDATION_DAYS || 180);
const MAX_STOCKS      = Number(process.env.QVA2_VALIDATION_MAX_STOCKS || 0);  // 0 = unlimited
const MAX_MARKETCAP   = Number(process.env.QVA2_VALIDATION_MAX_MARKETCAP || 5e12);

function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

function loadMetaMap() {
  if (!fs.existsSync(NAVER_LIST)) return new Map();
  try {
    const j = JSON.parse(fs.readFileSync(NAVER_LIST, 'utf-8'));
    const m = new Map();
    for (const s of (j.stocks || [])) {
      if (!s.code) continue;
      m.set(s.code, { code: s.code, name: s.name, market: s.market, marketValue: s.marketValue || 0, isEtf: !!s.isEtf, isSpecial: !!s.isSpecial });
    }
    return m;
  } catch (_) { return new Map(); }
}

function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}

/**
 * 시그널 발생 후 N 거래일 outcome.
 * @returns { closePctD5, closePctD10, closePctD20, mfeD5, mfeD10, mfeD20, maeD5, maeD10, maeD20,
 *            hitPlus5/10/15/20/30 (boolean within 20d), maxDrawdown20, ... }
 */
function computeOutcomes(rows, signalIdx) {
  const signalClose = rows[signalIdx].close;
  const signalHigh = rows[signalIdx].high;
  if (!signalClose || signalClose <= 0) return null;
  const out = {
    closePctD1: null, closePctD3: null, closePctD5: null, closePctD10: null, closePctD20: null,
    mfeD5: null, mfeD10: null, mfeD20: null,
    maeD5: null, maeD10: null, maeD20: null,
    hitPlus5: false, hitPlus10: false, hitPlus15: false, hitPlus20: false, hitPlus30: false,
    drop5First: false, drop10First: false,    // -5% / -10% 먼저 하락 여부 (low 기준)
    peakDate: null, peakClose: null, peakDayOffset: null, peakReturnPct: null,
    troughDate: null, troughClose: null,
    daysAvailable: 0,
  };
  const horizons = [1, 3, 5, 10, 20];
  for (const h of horizons) {
    const idx = signalIdx + h;
    if (idx < rows.length) {
      const r = rows[idx];
      const pct = ((r.close / signalClose) - 1) * 100;
      out[`closePctD${h}`] = +pct.toFixed(2);
      if (h > out.daysAvailable) out.daysAvailable = h;
    }
  }

  for (const N of [5, 10, 20]) {
    let mfe = -Infinity, mae = Infinity;
    for (let i = signalIdx + 1; i <= Math.min(rows.length - 1, signalIdx + N); i++) {
      const r = rows[i];
      if (!r) continue;
      const highRet = ((r.high / signalClose) - 1) * 100;
      const lowRet  = ((r.low  / signalClose) - 1) * 100;
      if (highRet > mfe) mfe = highRet;
      if (lowRet  < mae) mae = lowRet;
    }
    if (Number.isFinite(mfe)) out[`mfeD${N}`] = +mfe.toFixed(2);
    if (Number.isFinite(mae)) out[`maeD${N}`] = +mae.toFixed(2);
  }

  // 20일 윈도우 내: hit 도달, 먼저 하락 여부, peak/trough 발생일
  let peakClose = signalClose, peakIdx = signalIdx;
  let troughClose = signalClose, troughIdx = signalIdx;
  let firstHit5 = -1, firstHit10 = -1, firstHit15 = -1, firstHit20 = -1, firstHit30 = -1;
  let firstDrop5 = -1, firstDrop10 = -1;
  for (let i = signalIdx + 1; i <= Math.min(rows.length - 1, signalIdx + 20); i++) {
    const r = rows[i];
    if (!r) continue;
    const highRet = ((r.high / signalClose) - 1) * 100;
    const lowRet  = ((r.low  / signalClose) - 1) * 100;
    if (highRet >= 5  && firstHit5  < 0) firstHit5  = i;
    if (highRet >= 10 && firstHit10 < 0) firstHit10 = i;
    if (highRet >= 15 && firstHit15 < 0) firstHit15 = i;
    if (highRet >= 20 && firstHit20 < 0) firstHit20 = i;
    if (highRet >= 30 && firstHit30 < 0) firstHit30 = i;
    if (lowRet  <= -5  && firstDrop5  < 0) firstDrop5  = i;
    if (lowRet  <= -10 && firstDrop10 < 0) firstDrop10 = i;
    if (r.close > peakClose)   { peakClose = r.close; peakIdx = i; }
    if (r.close < troughClose) { troughClose = r.close; troughIdx = i; }
  }
  out.hitPlus5  = firstHit5  >= 0;
  out.hitPlus10 = firstHit10 >= 0;
  out.hitPlus15 = firstHit15 >= 0;
  out.hitPlus20 = firstHit20 >= 0;
  out.hitPlus30 = firstHit30 >= 0;
  out.firstHit10DayOffset = firstHit10 >= 0 ? firstHit10 - signalIdx : null;
  out.firstHit20DayOffset = firstHit20 >= 0 ? firstHit20 - signalIdx : null;
  // -5% / -10% 가 +10% 도달보다 먼저 왔는가
  out.drop5First  = firstDrop5  >= 0 && (firstHit10 < 0 || firstDrop5  < firstHit10);
  out.drop10First = firstDrop10 >= 0 && (firstHit10 < 0 || firstDrop10 < firstHit10);
  if (peakIdx > signalIdx) {
    out.peakDate = rows[peakIdx].date;
    out.peakClose = peakClose;
    out.peakDayOffset = peakIdx - signalIdx;
    out.peakReturnPct = +(((peakClose / signalClose) - 1) * 100).toFixed(2);
  }
  if (troughIdx > signalIdx) {
    out.troughDate = rows[troughIdx].date;
    out.troughClose = troughClose;
  }

  return out;
}

function avg(arr, key) {
  const xs = arr.map(e => e[key]).filter(v => v != null && Number.isFinite(v));
  if (xs.length === 0) return null;
  return +(xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(2);
}

function median(arr, key) {
  const xs = arr.map(e => e[key]).filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const n = xs.length;
  return +(n % 2 === 0 ? (xs[n / 2 - 1] + xs[n / 2]) / 2 : xs[Math.floor(n / 2)]).toFixed(2);
}

function rate(arr, predicate) {
  if (arr.length === 0) return null;
  const n = arr.filter(predicate).length;
  return +((n / arr.length) * 100).toFixed(1);
}

function summarize(events, label) {
  if (events.length === 0) return { label, n: 0 };
  return {
    label,
    n: events.length,
    avg_closeD1:  avg(events, 'closePctD1'),
    avg_closeD3:  avg(events, 'closePctD3'),
    avg_closeD5:  avg(events, 'closePctD5'),
    avg_closeD10: avg(events, 'closePctD10'),
    avg_closeD20: avg(events, 'closePctD20'),
    median_closeD5:  median(events, 'closePctD5'),
    median_closeD10: median(events, 'closePctD10'),
    median_closeD20: median(events, 'closePctD20'),
    avg_mfeD5:  avg(events, 'mfeD5'),
    avg_mfeD10: avg(events, 'mfeD10'),
    avg_mfeD20: avg(events, 'mfeD20'),
    avg_maeD5:  avg(events, 'maeD5'),
    avg_maeD10: avg(events, 'maeD10'),
    avg_maeD20: avg(events, 'maeD20'),
    closePos_D5:  rate(events, e => e.closePctD5  != null && e.closePctD5  > 0),
    closePos_D10: rate(events, e => e.closePctD10 != null && e.closePctD10 > 0),
    closePos_D20: rate(events, e => e.closePctD20 != null && e.closePctD20 > 0),
    hitPlus5_pct:  rate(events, e => e.hitPlus5),
    hitPlus10_pct: rate(events, e => e.hitPlus10),
    hitPlus15_pct: rate(events, e => e.hitPlus15),
    hitPlus20_pct: rate(events, e => e.hitPlus20),
    hitPlus30_pct: rate(events, e => e.hitPlus30),
    closeD5_lt_minus3_pct: rate(events, e => e.closePctD5 != null && e.closePctD5 < -3),
  };
}

function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`\n📊 QVA2 Validation Report (validation 윈도우 ${VALIDATION_DAYS} 거래일)`);

  const metaMap = loadMetaMap();
  let codes = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  if (MAX_STOCKS > 0) codes = codes.slice(0, MAX_STOCKS);
  console.log(`  스캔 대상: ${codes.length}개 chart`);

  const allEvents = [];
  let scanned = 0, etfFiltered = 0, capFiltered = 0, chartShort = 0;
  let progressN = 0;

  for (const code of codes) {
    progressN++;
    if (progressN % 500 === 0) console.log(`  ... ${progressN}/${codes.length} (events=${allEvents.length})`);
    const meta = metaMap.get(code);
    if (!meta) continue;
    if (meta.isEtf || meta.isSpecial) { etfFiltered++; continue; }
    if (!meta.marketValue || meta.marketValue > MAX_MARKETCAP) { capFiltered++; continue; }
    const chart = loadChart(code);
    if (!chart || !chart.rows || chart.rows.length < 80) { chartShort++; continue; }
    scanned++;
    const rows = chart.rows;
    // 검증 윈도우: 마지막 20일은 outcome 미완성이라 제외, 그 앞으로 VALIDATION_DAYS 만큼
    const lastValidIdx = rows.length - 1 - 20;
    const startIdx = Math.max(60, lastValidIdx - VALIDATION_DAYS + 1);
    if (startIdx > lastValidIdx) continue;
    for (let i = startIdx; i <= lastValidIdx; i++) {
      const r = calculateQVA2(rows, i, meta);
      if (!r || !r.passed) continue;
      const outcome = computeOutcomes(rows, i);
      if (!outcome) continue;
      allEvents.push({
        code, name: meta.name, market: meta.market, marketValue: meta.marketValue,
        date: rows[i].date, idx: i,
        score: r.score, grade: r.grade,
        signals: r.signals,
        ...outcome,
      });
    }
  }
  console.log(`  scanned=${scanned}, etf/special=${etfFiltered}, capFiltered=${capFiltered}, chartShort=${chartShort}`);
  console.log(`  QVA2 시그널 (검증 윈도우 ${VALIDATION_DAYS}거래일): ${allEvents.length}건`);

  // 요약 — 전체, 등급별, 점수구간별, 거래대금배율 구간별, 시총구간별
  const overall  = summarize(allEvents, '전체 QVA2');
  const byGrade = {
    STRONG_QVA2: summarize(allEvents.filter(e => e.grade === 'STRONG_QVA2'), 'STRONG_QVA2'),
    QVA2:        summarize(allEvents.filter(e => e.grade === 'QVA2'),        'QVA2'),
    WATCH_QVA2:  summarize(allEvents.filter(e => e.grade === 'WATCH_QVA2'),  'WATCH_QVA2'),
    NONE:        summarize(allEvents.filter(e => e.grade === 'NONE'),        'NONE (점수<45)'),
  };
  const byScoreBand = {
    s75plus:  summarize(allEvents.filter(e => e.score >= 75), '75+'),
    s60_74:   summarize(allEvents.filter(e => e.score >= 60 && e.score < 75), '60–74'),
    s45_59:   summarize(allEvents.filter(e => e.score >= 45 && e.score < 60), '45–59'),
    sBelow45: summarize(allEvents.filter(e => e.score < 45), '<45'),
  };
  const byValueRatio = {
    vr_5plus:   summarize(allEvents.filter(e => e.signals.valueRatio20 >= 5),                                'val ×5+'),
    vr_3to5:    summarize(allEvents.filter(e => e.signals.valueRatio20 >= 3 && e.signals.valueRatio20 < 5), 'val ×3–5'),
    vr_2to3:    summarize(allEvents.filter(e => e.signals.valueRatio20 >= 2 && e.signals.valueRatio20 < 3), 'val ×2–3'),
  };
  const byMarketcap = {
    cap_under500B: summarize(allEvents.filter(e => e.marketValue < 5e11),                          '시총 <500억 (없어야 함)'),
    cap_500Bto1T:  summarize(allEvents.filter(e => e.marketValue >= 5e11 && e.marketValue < 1e12), '시총 500억–1조'),
    cap_1Tto3T:    summarize(allEvents.filter(e => e.marketValue >= 1e12 && e.marketValue < 3e12), '시총 1–3조'),
    cap_3Tto5T:    summarize(allEvents.filter(e => e.marketValue >= 3e12 && e.marketValue <= 5e12), '시총 3–5조'),
  };
  const byCloseLocation = {
    cl_065plus: summarize(allEvents.filter(e => e.signals.closeLocation >= 0.65),                                'closeLoc ≥0.65'),
    cl_05to065: summarize(allEvents.filter(e => e.signals.closeLocation >= 0.50 && e.signals.closeLocation < 0.65), 'closeLoc 0.50–0.65'),
    cl_035to05: summarize(allEvents.filter(e => e.signals.closeLocation >= 0.35 && e.signals.closeLocation < 0.50), 'closeLoc 0.35–0.50'),
  };
  const byChangePct = {
    chg_m1tom2:  summarize(allEvents.filter(e => e.signals.changePct >= -2  && e.signals.changePct < -1), '-2 ~ -1%'),
    chg_m2tom3:  summarize(allEvents.filter(e => e.signals.changePct >= -3  && e.signals.changePct < -2), '-3 ~ -2%'),
    chg_m3tom4:  summarize(allEvents.filter(e => e.signals.changePct >= -4  && e.signals.changePct < -3), '-4 ~ -3%'),
  };

  // TOP 20 winners (mfeD20)
  const topWinners = [...allEvents].sort((a, b) => (b.mfeD20 || -999) - (a.mfeD20 || -999)).slice(0, 20);
  // WORST 20 (closePctD20)
  const worstLosers = [...allEvents].sort((a, b) => (a.closePctD20 ?? 999) - (b.closePctD20 ?? 999)).slice(0, 20);

  const conclusions = autoConclusions(overall, byGrade, byScoreBand, byChangePct);

  const out = {
    meta: {
      title: 'QVA2 Validation Report',
      subtitle: 'QVA2 시그널의 과거 D+5/D+10/D+20 outcome 검증',
      generatedAt: new Date().toISOString(),
      validationDays: VALIDATION_DAYS,
      maxMarketcap: MAX_MARKETCAP,
      stocksScanned: scanned,
      totalEvents: allEvents.length,
    },
    overall,
    byGrade,
    byScoreBand,
    byValueRatio,
    byMarketcap,
    byCloseLocation,
    byChangePct,
    conclusions,
    topWinners: topWinners.map(e => ({
      code: e.code, name: e.name, date: e.date, grade: e.grade, score: e.score,
      changePct: e.signals.changePct, valueRatio20: e.signals.valueRatio20, closeLocation: e.signals.closeLocation,
      mfeD20: e.mfeD20, closePctD20: e.closePctD20,
    })),
    worstLosers: worstLosers.map(e => ({
      code: e.code, name: e.name, date: e.date, grade: e.grade, score: e.score,
      changePct: e.signals.changePct, valueRatio20: e.signals.valueRatio20, closeLocation: e.signals.closeLocation,
      maeD20: e.maeD20, closePctD20: e.closePctD20,
    })),
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  console.log(`\n  ── 전체 요약 ──`);
  console.log(`    n = ${overall.n}`);
  console.log(`    avg D+5/10/20 close: ${overall.avg_closeD5}% / ${overall.avg_closeD10}% / ${overall.avg_closeD20}%`);
  console.log(`    avg MFE D+5/10/20:   ${overall.avg_mfeD5}% / ${overall.avg_mfeD10}% / ${overall.avg_mfeD20}%`);
  console.log(`    avg MAE D+5/10/20:   ${overall.avg_maeD5}% / ${overall.avg_maeD10}% / ${overall.avg_maeD20}%`);
  console.log(`    +5/10/15/20/30 도달률: ${overall.hitPlus5_pct}% / ${overall.hitPlus10_pct}% / ${overall.hitPlus15_pct}% / ${overall.hitPlus20_pct}% / ${overall.hitPlus30_pct}%`);
  console.log(`    종가 양수율 D+5/10/20: ${overall.closePos_D5}% / ${overall.closePos_D10}% / ${overall.closePos_D20}%`);
  console.log(`\n  ── 등급별 ──`);
  for (const [k, s] of Object.entries(byGrade)) {
    if (!s.n) continue;
    console.log(`    ${k.padEnd(12)} n=${s.n} | D+10 close ${s.avg_closeD10}% | MFE10 ${s.avg_mfeD10}% | hit+10 ${s.hitPlus10_pct}%`);
  }
  console.log(`\n  elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

function autoConclusions(overall, byGrade, byScoreBand, byChangePct) {
  const out = [];
  if (overall.n === 0) return ['시그널이 0건입니다.'];
  out.push(`전체 QVA2 시그널 ${overall.n}건. 평균 D+10 종가수익률 ${overall.avg_closeD10}%, 평균 MFE10 ${overall.avg_mfeD10}%, +10% 도달률 ${overall.hitPlus10_pct}%, 종가 양수율 D+10 ${overall.closePos_D10}%.`);
  const strong = byGrade.STRONG_QVA2;
  const norm = byGrade.QVA2;
  if (strong && strong.n > 0 && norm && norm.n > 0) {
    out.push(`STRONG_QVA2(n=${strong.n}) vs QVA2(n=${norm.n}): D+10 close ${strong.avg_closeD10}% vs ${norm.avg_closeD10}%, +10% 도달률 ${strong.hitPlus10_pct}% vs ${norm.hitPlus10_pct}%.`);
  }
  // 약세 폭 비교
  const c12 = byChangePct.chg_m1tom2;
  const c23 = byChangePct.chg_m2tom3;
  const c34 = byChangePct.chg_m3tom4;
  if (c12.n > 0 && c34.n > 0) {
    out.push(`전일 대비 폭별 — -2~-1% (n=${c12.n}, hit+10 ${c12.hitPlus10_pct}%) vs -4~-3% (n=${c34.n}, hit+10 ${c34.hitPlus10_pct}%). 약세 폭이 클수록 결과가 ${c34.avg_closeD10 > c12.avg_closeD10 ? '나음' : '약함'}.`);
  }
  // 점수 효용성
  const high = byScoreBand.s75plus;
  const low  = byScoreBand.sBelow45;
  if (high && high.n > 0 && low && low.n > 0) {
    out.push(`점수 75+ (n=${high.n}, MFE10 ${high.avg_mfeD10}%) vs 점수<45 (n=${low.n}, MFE10 ${low.avg_mfeD10}%). 점수가 outcome과 ${high.avg_mfeD10 > low.avg_mfeD10 ? '양의 상관' : '약한 상관'}.`);
  }
  // 비교 결론
  if (overall.hitPlus10_pct >= 50 && overall.avg_closeD10 >= 2) {
    out.push(`✅ QVA2는 D+10 +10% 도달률 ${overall.hitPlus10_pct}% / 평균 종가수익률 ${overall.avg_closeD10}%로 운영 후보로 활용할 만한 수준.`);
  } else if (overall.hitPlus10_pct >= 35 && overall.avg_closeD10 >= 0) {
    out.push(`⚠️  QVA2는 중간 수준 — 등급/점수 필터링과 함께 사용 권장. STRONG/QVA2 등급만 운영.`);
  } else {
    out.push(`❌ QVA2는 단독 운영 부적절. 점수/등급 cut을 더 강하게 두거나 추가 필터(예: low20 hold 비율 강화)가 필요.`);
  }
  return out;
}

function buildHtml(data) {
  return HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(data));
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>QVA2 Validation Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
}
nav.boards { display:flex; gap:6px; flex-wrap:wrap; padding:8px 0 14px; border-bottom:1px solid #1e293b; margin-bottom:14px; align-items:center; }
nav.boards .group-label { font-size:11px; color:#64748b; padding:4px 8px 4px 0; font-weight:600; letter-spacing:0.4px; text-transform:uppercase; }
nav.boards a { color:#94a3b8; text-decoration:none; font-size:12px; padding:5px 10px; border-radius:6px; border:1px solid transparent; }
nav.boards a:hover { color:#e2e8f0; background:#1e293b; }
nav.boards a.live { border-color:#1e293b; }
nav.boards a.experiment { border-color:#7c3aed; color:#c4b5fd; background:#1e1b4b; }
nav.boards a.experiment:hover { background:#312e81; color:#e0e7ff; }
nav.boards a.active { background:#1e293b; color:#f1f5f9; border-color:#334155; }
nav.boards a.experiment.active { background:#312e81; color:#e0e7ff; border-color:#a78bfa; }
nav.boards .sep { color:#475569; padding:0 6px; }

h1 { font-size: 22px; margin: 6px 0 4px; color: #f1f5f9; font-weight: 700; }
.exp-pill { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; background:#312e81; color:#c4b5fd; border:1px solid #6366f1; margin-left:8px; vertical-align:middle; font-weight:600; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 12px; line-height:1.6; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
.summary-cell { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.summary-cell .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.summary-cell .value { font-size: 22px; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; margin-top: 4px; }
.summary-cell .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
.summary-cell.metric-pos { border-left: 4px solid #22c55e; }
.summary-cell.metric-warn { border-left: 4px solid #fbbf24; }
.summary-cell.metric-neg { border-left: 4px solid #ef4444; }

h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }

table.cohort { width:100%; border-collapse: collapse; margin-bottom: 18px; font-size:12px; }
table.cohort th, table.cohort td { padding: 7px 10px; border-bottom: 1px solid #1e293b; text-align: right; font-variant-numeric: tabular-nums; }
table.cohort th { color: #94a3b8; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.3px; background:#0f172a; }
table.cohort td.label { text-align:left; color:#cbd5e1; font-weight: 600; }
table.cohort tr:hover td { background:#1e293b; }
.cell-pos { color:#6ee7b7; }
.cell-neg { color:#fca5a5; }
.cell-warn { color:#fbbf24; }

.conclusion-box { background: #0f172a; border-left: 3px solid #a78bfa; padding: 14px 18px; border-radius: 6px; margin-bottom: 18px; }
.conclusion-box ul { margin: 0; padding-left: 20px; line-height: 1.8; }
.conclusion-box li { color: #cbd5e1; }
.conclusion-box li.pos { color: #6ee7b7; }
.conclusion-box li.warn { color: #fde68a; }
.conclusion-box li.neg { color: #fca5a5; }

table.list { width:100%; border-collapse: collapse; margin-bottom: 18px; font-size:11.5px; }
table.list th, table.list td { padding: 6px 8px; border-bottom: 1px solid #1e293b; }
table.list th { color: #94a3b8; text-align:left; font-size: 10.5px; }
table.list td { color: #cbd5e1; font-variant-numeric: tabular-nums; }
table.list td.code { color: #94a3b8; font-size: 11px; }
table.list td.name a { color: #f1f5f9; text-decoration: none; }
table.list td.name a:hover { color: #c4b5fd; text-decoration: underline; }
</style>
</head>
<body>
<nav class="boards">
  <span class="group-label">운영</span>
  <a href="/qva-watchlist" class="live">📋 QVA</a>
  <a href="/qva-vvi-redefined-board" class="live">🎯 VVI</a>
  <a href="/rebreak" class="live">🔥 D+5 재돌파</a>
  <a href="/one-day-surge-board" class="live">⚡ 1DS</a>
  <span class="sep">|</span>
  <span class="group-label">실험 QVA2</span>
  <a href="/qva2-watchlist" class="experiment">📋 H그룹/VPR (QVA2)</a>
  <a href="/qva2-d5-rebreak" class="experiment">🔥 D+5 재돌파 (QVA2)</a>
  <a href="/qva2-vvi" class="experiment">🎯 고점 재돌파 (QVA2)</a>
  <a href="/qva2-validation" class="experiment active">📊 검증</a>
</nav>

<h1>📊 QVA2 Validation Report <span class="exp-pill">실험 라인</span></h1>
<div class="subtitle" id="subtitle"></div>

<h2>📌 자동 결론</h2>
<div class="conclusion-box"><ul id="conclusions"></ul></div>

<h2>🎯 전체 요약</h2>
<div class="summary-grid" id="overall-grid"></div>

<h2>📊 등급별 비교</h2>
<div id="grade-table"></div>

<h2>📊 점수 구간별</h2>
<div id="score-table"></div>

<h2>📊 거래대금 배율 구간별</h2>
<div id="value-table"></div>

<h2>📊 시총 구간별</h2>
<div id="cap-table"></div>

<h2>📊 종가 위치 구간별</h2>
<div id="cl-table"></div>

<h2>📊 약세 폭 구간별 (changePct)</h2>
<div id="chg-table"></div>

<h2>🏆 TOP 20 (MFE D+20 기준)</h2>
<div id="winners-table"></div>

<h2>📉 WORST 20 (close D+20 기준)</h2>
<div id="losers-table"></div>

<script>
const DATA = __JSON_DATA__;

document.getElementById('subtitle').textContent =
  '검증 윈도우 ' + DATA.meta.validationDays + '거래일 · 스캔 종목 ' + DATA.meta.stocksScanned + ' · 시그널 ' + DATA.meta.totalEvents + '건 · 생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

// 자동 결론
const ulC = document.getElementById('conclusions');
ulC.innerHTML = (DATA.conclusions || []).map(c => {
  let cls = '';
  if (c.startsWith('✅')) cls = 'pos';
  else if (c.startsWith('⚠️')) cls = 'warn';
  else if (c.startsWith('❌')) cls = 'neg';
  return '<li class="' + cls + '">' + c + '</li>';
}).join('');

// 전체 요약
const o = DATA.overall || {};
const og = document.getElementById('overall-grid');
og.innerHTML = [
  cellSum('metric-pos',  '시그널 수',          o.n ?? 0, ''),
  cellSum(o.avg_closeD10 > 0 ? 'metric-pos' : 'metric-neg', '평균 D+10 종가', (o.avg_closeD10 ?? 0) + '%', ''),
  cellSum('metric-pos',  '평균 MFE D+10',      (o.avg_mfeD10 ?? 0) + '%', ''),
  cellSum('metric-warn', '평균 MAE D+10',      (o.avg_maeD10 ?? 0) + '%', ''),
  cellSum(o.hitPlus10_pct >= 50 ? 'metric-pos' : (o.hitPlus10_pct >= 35 ? 'metric-warn' : 'metric-neg'), '+10% 도달률', (o.hitPlus10_pct ?? 0) + '%', ''),
  cellSum('metric-warn', '+20% 도달률',         (o.hitPlus20_pct ?? 0) + '%', ''),
  cellSum('metric-warn', '종가 양수율 D+10',    (o.closePos_D10 ?? 0) + '%', ''),
].join('');

function cellSum(cls, label, value, sub) {
  return '<div class="summary-cell ' + cls + '"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub">' + (sub || '') + '</div></div>';
}

renderCohortTable('grade-table', Object.values(DATA.byGrade));
renderCohortTable('score-table', Object.values(DATA.byScoreBand));
renderCohortTable('value-table', Object.values(DATA.byValueRatio));
renderCohortTable('cap-table',   Object.values(DATA.byMarketcap));
renderCohortTable('cl-table',    Object.values(DATA.byCloseLocation));
renderCohortTable('chg-table',   Object.values(DATA.byChangePct));

function renderCohortTable(hostId, groups) {
  const rows = (groups || []).filter(g => g && g.n > 0);
  if (rows.length === 0) {
    document.getElementById(hostId).innerHTML = '<div style="padding:14px;background:#1e293b;border:1px dashed #475569;border-radius:6px;color:#64748b;text-align:center;">해당 코호트 데이터 없음</div>';
    return;
  }
  const headers = ['그룹', 'n', 'avg D+5', 'avg D+10', 'avg D+20', 'MFE D+10', 'MAE D+10', '+5%', '+10%', '+15%', '+20%', '종가양수 D+10'];
  let html = '<table class="cohort"><thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>';
  for (const g of rows) {
    html += '<tr>' +
      '<td class="label">' + g.label + '</td>' +
      '<td>' + g.n + '</td>' +
      tdPct(g.avg_closeD5)  +
      tdPct(g.avg_closeD10) +
      tdPct(g.avg_closeD20) +
      tdPct(g.avg_mfeD10, true) +
      tdPct(g.avg_maeD10, false, true) +
      tdPct(g.hitPlus5_pct, true) +
      tdPct(g.hitPlus10_pct, true) +
      tdPct(g.hitPlus15_pct, true) +
      tdPct(g.hitPlus20_pct, true) +
      tdPct(g.closePos_D10, true) +
    '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById(hostId).innerHTML = html;
}

function tdPct(v, alwaysPos, alwaysNeg) {
  if (v == null) return '<td>-</td>';
  let cls = '';
  if (alwaysPos) cls = v >= 50 ? 'cell-pos' : (v >= 30 ? 'cell-warn' : 'cell-neg');
  else if (alwaysNeg) cls = v <= -10 ? 'cell-neg' : (v <= -5 ? 'cell-warn' : '');
  else cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : '');
  const v2 = (typeof v === 'number') ? (v.toFixed(2) + '%') : v;
  return '<td class="' + cls + '">' + v2 + '</td>';
}

renderListTable('winners-table', DATA.topWinners, true);
renderListTable('losers-table',  DATA.worstLosers, false);

function renderListTable(hostId, items, isWinner) {
  if (!items || items.length === 0) {
    document.getElementById(hostId).innerHTML = '<div style="padding:14px;background:#1e293b;border:1px dashed #475569;border-radius:6px;color:#64748b;">데이터 없음</div>';
    return;
  }
  const valCol = isWinner ? 'mfeD20' : 'maeD20';
  const valLabel = isWinner ? 'MFE D+20' : 'MAE D+20';
  let html = '<table class="list"><thead><tr>' +
    ['일자', '종목', '코드', '등급', '점수', 'Δ', 'val×', 'closeLoc', valLabel, 'close D+20'].map(h => '<th>' + h + '</th>').join('') +
    '</tr></thead><tbody>';
  for (const e of items) {
    html += '<tr>' +
      '<td>' + fmtDate(e.date) + '</td>' +
      '<td class="name"><a href="/stock/' + e.code + '">' + (e.name || e.code) + '</a></td>' +
      '<td class="code">' + e.code + '</td>' +
      '<td>' + (e.grade || '') + '</td>' +
      '<td>' + (e.score ?? '-') + '</td>' +
      '<td>' + (e.changePct ?? 0).toFixed(2) + '%</td>' +
      '<td>×' + (e.valueRatio20 ?? 0).toFixed(2) + '</td>' +
      '<td>' + (e.closeLocation != null ? (e.closeLocation * 100).toFixed(0) + '%' : '-') + '</td>' +
      '<td class="' + (isWinner ? 'cell-pos' : 'cell-neg') + '">' + (e[valCol] != null ? e[valCol].toFixed(2) + '%' : '-') + '</td>' +
      '<td class="' + (e.closePctD20 > 0 ? 'cell-pos' : 'cell-neg') + '">' + (e.closePctD20 != null ? e.closePctD20.toFixed(2) + '%' : '-') + '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById(hostId).innerHTML = html;
}

function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}

module.exports = { main };
