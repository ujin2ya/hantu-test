#!/usr/bin/env node
/**
 * H그룹 재돌파 가설 — 심층 검증 (Deep Dive)
 *
 * 목적:
 *   "H돌파일 고가 재돌파 = 강한 시그널"이 이미 검증됨 (n=186, 승률 75.27%, +6.83%).
 *   이번에는 재돌파를 중심축으로 두고 속도·유지력·거래대금·이탈/회복·갭·종가 위치·
 *   사후 거리·눌림 회복형을 깊게 분해해 D+5 운용 보드의 보조 기준을 찾는다.
 *
 * 입력: reports/vpr-hgroup-three-year-with-flow-backtest-result.json (events 448건)
 *       cache/stock-charts-long/{code}.json
 *
 * 출력:
 *   reports/hgroup-rebreak-deep-dive-result.json
 *   reports/hgroup-rebreak-deep-dive-result.html
 *
 * 라우트: /d5-rebreak-deep-dive
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INPUT_PATH = path.join(REPORTS_DIR, 'vpr-hgroup-three-year-with-flow-backtest-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'hgroup-rebreak-deep-dive-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'hgroup-rebreak-deep-dive-result.html');

const HOLD_DAYS = 5;

// ─── 헬퍼 ───
function round(v, d = 2) { if (v == null || !Number.isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function mean(arr) { const v = arr.filter(x => x != null && Number.isFinite(x)); if (v.length === 0) return null; return v.reduce((s, x) => s + x, 0) / v.length; }
function median(arr) {
  const v = arr.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function rate(num, denom) { if (!denom) return null; return round(num / denom * 100, 2); }

// ─── 이벤트별 모든 feature 계산 ───
function computeEventFeatures(e, rows) {
  const hIdx = rows.findIndex(r => r.date === e.hDate);
  const vviIdx = rows.findIndex(r => r.date === e.vviDate);
  if (hIdx < 0 || vviIdx < 0) return null;
  const hRow = rows[hIdx];
  const vviRow = rows[vviIdx];
  if (!hRow || !vviRow) return null;
  const hClose = hRow.close, hHigh = hRow.high, hLow = hRow.low;
  const baseClose = vviRow.close;
  const breakoutLine = baseClose * 1.01;
  if (!hClose || !baseClose) return null;

  // VVI 이전 20거래일 평균 거래대금 (H돌파일 거래대금 동반 판정용)
  const prev20Start = Math.max(0, vviIdx - 20);
  const prev20Rows = rows.slice(prev20Start, vviIdx);
  const prev20AvgValue = prev20Rows.length > 0
    ? prev20Rows.reduce((s, r) => s + (r.valueApprox || (r.close * r.volume) || 0), 0) / prev20Rows.length
    : 0;
  const hValue = hRow.valueApprox || (hRow.close * hRow.volume) || 0;

  // H돌파일 closePosition + 위꼬리
  const hClosePos = hHigh > hLow ? (hClose - hLow) / (hHigh - hLow) : 1;
  const hUpperWickPct = hClose > 0 ? (hHigh / hClose - 1) * 100 : 0;
  const hVolumeRatio = prev20AvgValue > 0 ? hValue / prev20AvgValue : null;
  const hHasVolumeSupport = hVolumeRatio != null && hVolumeRatio >= 2;
  const hVolumeExplosion = hVolumeRatio != null && hVolumeRatio >= 3;
  const hUpperWickSmall = hClosePos >= 0.85;

  // D+1 시가 갭%
  const day1 = rows[hIdx + 1];
  const gapPct = day1 ? round((day1.open / baseClose - 1) * 100) : null;

  // D+1~D+5 추적
  let firstRebreakDay = null, firstRebreakDate = null, firstRebreakRow = null;
  let intradayOnly = false;  // 종가 재돌파 없이 장중 고가만 H高 도달
  let highMax = -Infinity, lowMin = Infinity;
  let everBelowBase = false;
  let firstBreakdownDay = null;  // 처음으로 baseClose 미만 low 발생일
  let breakdownSameDayRecovered = false;
  let breakdownNextDayRecovered = false;
  let breakdownEverRecovered = false;  // 이탈 후 baseClose 이상 종가 회복
  let breakdownThenRebreakOK = false;  // 이탈 후 H高 재돌파까지 성공
  let everPullbackToBreakoutLine = false;
  let everPullbackToBaseClose = false;
  let close5 = null;
  let timeStuck = false;
  let nextDayHoldAfterRebreak = null;  // 재돌파 다음 날도 종가 H高 위인지

  for (let k = 1; k <= HOLD_DAYS; k++) {
    const r = rows[hIdx + k];
    if (!r) break;
    if (r.high > highMax) highMax = r.high;
    if (r.low < lowMin) lowMin = r.low;
    // 종가 재돌파 첫 날
    if (firstRebreakDay == null && r.close >= hHigh) {
      firstRebreakDay = k;
      firstRebreakDate = r.date;
      firstRebreakRow = r;
      // 다음 거래일 유지 여부
      const nx = rows[hIdx + k + 1];
      if (nx) nextDayHoldAfterRebreak = nx.close >= hHigh;
    }
    // 기준 종가 이탈
    if (r.low < baseClose) {
      if (!everBelowBase) firstBreakdownDay = k;
      everBelowBase = true;
      // 같은 날 종가 회복?
      if (r.close >= baseClose && firstBreakdownDay === k) breakdownSameDayRecovered = true;
    }
    // 이탈 후 회복 (다른 날에 baseClose 종가 회복)
    if (everBelowBase && r.close >= baseClose) breakdownEverRecovered = true;
    // 이탈 후 재돌파 성공
    if (everBelowBase && r.close >= hHigh) breakdownThenRebreakOK = true;
    // 다음 거래일 회복
    if (firstBreakdownDay != null && k === firstBreakdownDay + 1 && r.close >= baseClose) breakdownNextDayRecovered = true;
    // 눌림 패턴
    if (r.low <= breakoutLine) everPullbackToBreakoutLine = true;
    if (r.low <= baseClose * 1.005) everPullbackToBaseClose = true;
    if (k === HOLD_DAYS) close5 = r.close;
  }
  if (close5 == null) {
    // D+5까지 데이터 없으면 마지막 가용 row의 close
    for (let k = HOLD_DAYS; k >= 1; k--) {
      if (rows[hIdx + k]) { close5 = rows[hIdx + k].close; break; }
    }
  }
  if (close5 == null) return null;

  // 장중만 재돌파
  intradayOnly = (highMax >= hHigh) && (firstRebreakDay == null);

  // D+5 수익률 + MFE/MAE
  const close5Return = (close5 / hClose - 1) * 100;
  const mfe5 = (highMax / hClose - 1) * 100;
  const mae5 = (lowMin / hClose - 1) * 100;
  timeStuck = mfe5 < 6 && mae5 > -5;

  // 재돌파일의 거래대금/종가 위치/사후 거리
  let rebreakValueRatio = null, rebreakClosePos = null, rebreakCloseDistPct = null;
  if (firstRebreakRow) {
    const rv = firstRebreakRow.valueApprox || (firstRebreakRow.close * firstRebreakRow.volume) || 0;
    rebreakValueRatio = prev20AvgValue > 0 ? rv / prev20AvgValue : null;
    rebreakClosePos = firstRebreakRow.high > firstRebreakRow.low
      ? (firstRebreakRow.close - firstRebreakRow.low) / (firstRebreakRow.high - firstRebreakRow.low) : 1;
    rebreakCloseDistPct = (firstRebreakRow.close / hHigh - 1) * 100;
  }

  // 첫 눌림 회복 패턴
  let pullbackPattern;
  if (!everPullbackToBreakoutLine) pullbackPattern = 'NO_PULLBACK';
  else if (!everPullbackToBaseClose && firstRebreakDay != null) pullbackPattern = 'NEAR_HHIGH_THEN_REBREAK';  // (loose proxy)
  else if (!everPullbackToBaseClose) pullbackPattern = 'LINE_PULLBACK';
  else if (everBelowBase && breakdownThenRebreakOK) pullbackPattern = 'BREACH_THEN_RECOVER';
  else if (everBelowBase && breakdownEverRecovered) pullbackPattern = 'BREACH_THEN_RECOVER';
  else if (everBelowBase) pullbackPattern = 'BREACH_NO_RECOVER';
  else if (everPullbackToBaseClose) pullbackPattern = 'BASE_PULLBACK';
  else pullbackPattern = 'OTHER';

  // breakdown state 분류 (가설 4용)
  let breakdownState;
  if (!everBelowBase) breakdownState = 'NONE';
  else if (breakdownThenRebreakOK) breakdownState = 'BREACH_REBREAK_OK';
  else if (breakdownSameDayRecovered) breakdownState = 'BREACH_SAMEDAY_RECOVER';
  else if (breakdownNextDayRecovered) breakdownState = 'BREACH_NEXTDAY_RECOVER';
  else if (breakdownEverRecovered) breakdownState = 'BREACH_LATER_RECOVER';
  else breakdownState = 'BREACH_NO_RECOVER';

  return {
    code: e.code, name: e.name, hDate: e.hDate, vviDate: e.vviDate,
    hClose, hHigh, hLow, baseClose, breakoutLine,
    hClosePos: round(hClosePos, 3),
    hUpperWickPct: round(hUpperWickPct),
    hVolumeRatio: round(hVolumeRatio),
    hHasVolumeSupport, hVolumeExplosion, hUpperWickSmall,
    gapPct,
    // 재돌파
    firstRebreakDay, firstRebreakDate,
    intradayOnly,
    nextDayHoldAfterRebreak,
    rebreakValueRatio: round(rebreakValueRatio),
    rebreakClosePos: round(rebreakClosePos, 3),
    rebreakCloseDistPct: round(rebreakCloseDistPct),
    // 이탈
    everBelowBase, firstBreakdownDay,
    breakdownState,
    breakdownEverRecovered, breakdownThenRebreakOK,
    // 눌림
    everPullbackToBreakoutLine, everPullbackToBaseClose,
    pullbackPattern,
    // D+5 결과
    close5,
    close5Return: round(close5Return),
    mfe5: round(mfe5), mae5: round(mae5),
    reach3: highMax >= hClose * 1.03,
    reach5: highMax >= hClose * 1.05,
    breachedBaseClose: lowMin < baseClose,
    timeStuck,
    win: close5Return > 0,
  };
}

// ─── 그룹 통계 (기준값 baseStat 옵션) ───
function summarize(label, rows, baseStat = null) {
  const valid = rows.filter(r => r != null);
  if (valid.length === 0) return { label, n: 0 };
  const closes = valid.map(r => r.close5Return);
  const wins = valid.filter(r => r.win).length;
  const winRate = wins / valid.length * 100;
  const avgClose5 = mean(closes);
  const stat = {
    label,
    n: valid.length,
    winRate: round(winRate),
    avgClose5: round(avgClose5),
    medianClose5: round(median(closes)),
    avgMFE5: round(mean(valid.map(r => r.mfe5))),
    avgMAE5: round(mean(valid.map(r => r.mae5))),
    reach3Rate: rate(valid.filter(r => r.reach3).length, valid.length),
    reach5Rate: rate(valid.filter(r => r.reach5).length, valid.length),
    breachRate: rate(valid.filter(r => r.breachedBaseClose).length, valid.length),
    noRebreakRate: rate(valid.filter(r => r.firstRebreakDay == null).length, valid.length),
    timeStuckRate: rate(valid.filter(r => r.timeStuck).length, valid.length),
  };
  if (baseStat) {
    stat.dWR = stat.winRate != null && baseStat.winRate != null ? round(stat.winRate - baseStat.winRate) : null;
    stat.dE = stat.avgClose5 != null && baseStat.avgClose5 != null ? round(stat.avgClose5 - baseStat.avgClose5) : null;
  }
  return stat;
}

// ─── 메인 ───
function main() {
  if (!fs.existsSync(INPUT_PATH)) { console.error('[ERROR] 입력 없음:', INPUT_PATH); process.exit(1); }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  console.log('\n📊 H그룹 재돌파 심층 검증');

  const inputData = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const events = inputData.events || [];
  console.log(`  입력 이벤트: ${events.length}건`);

  const trades = [];
  for (const e of events) {
    const chartPath = path.join(CHART_DIR, `${e.code}.json`);
    if (!fs.existsSync(chartPath)) continue;
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8')); } catch (_) { continue; }
    const rows = chart.rows || [];
    const f = computeEventFeatures(e, rows);
    if (f) trades.push(f);
  }
  console.log(`  실효 trade: ${trades.length}건`);

  const baseStat = summarize('베이스 (전체 H그룹)', trades);
  console.log(`  베이스: 승률 ${baseStat.winRate}% / 매번 ${baseStat.avgClose5}%`);

  // ─────────────────────── 가설 1: 재돌파 속도 ───────────────────────
  const h1 = [];
  h1.push({ key: 'BASE', ...summarize('베이스 (전체)', trades, baseStat) });
  for (let d = 1; d <= 5; d++) {
    h1.push({ key: 'D' + d, ...summarize(`D+${d} 재돌파`, trades.filter(t => t.firstRebreakDay === d), baseStat) });
  }
  h1.push({ key: 'NONE', ...summarize('재돌파 없음', trades.filter(t => t.firstRebreakDay == null), baseStat) });

  // ─────────────────────── 가설 2: 재돌파 유지력 ───────────────────────
  const h2 = [];
  h2.push({ key: 'BASE', ...summarize('베이스', trades, baseStat) });
  h2.push({ key: 'INTRADAY_ONLY', ...summarize('A. 장중 재돌파만 (종가 X)', trades.filter(t => t.intradayOnly), baseStat) });
  h2.push({ key: 'CLOSE_REBREAK', ...summarize('B. 종가 재돌파 있음', trades.filter(t => t.firstRebreakDay != null), baseStat) });
  h2.push({ key: 'CLOSE_REBREAK_HOLD', ...summarize('C. 종가 재돌파 + 다음 거래일도 유지', trades.filter(t => t.firstRebreakDay != null && t.nextDayHoldAfterRebreak === true), baseStat) });
  h2.push({ key: 'INTRADAY_PUSHBACK', ...summarize('D. 장중 재돌파 후 같은 날 밀림', trades.filter(t => t.intradayOnly), baseStat) });

  // ─────────────────────── 가설 3: 거래대금 강도 ───────────────────────
  const h3 = [];
  h3.push({ key: 'BASE', ...summarize('베이스', trades, baseStat) });
  const buckets3 = [
    { key: 'V_LT1', label: 'valueRatio < 1', test: r => r >= 0 && r < 1 },
    { key: 'V_1_2', label: '1 ≤ valueRatio < 2', test: r => r >= 1 && r < 2 },
    { key: 'V_2_3', label: '2 ≤ valueRatio < 3', test: r => r >= 2 && r < 3 },
    { key: 'V_3_5', label: '3 ≤ valueRatio < 5', test: r => r >= 3 && r < 5 },
    { key: 'V_5P', label: 'valueRatio ≥ 5', test: r => r >= 5 },
  ];
  for (const b of buckets3) {
    h3.push({ key: b.key, ...summarize(b.label + ' (재돌파일)', trades.filter(t => t.rebreakValueRatio != null && b.test(t.rebreakValueRatio)), baseStat) });
  }
  h3.push({ key: 'CLOSE_VOL2', ...summarize('종가 재돌파 + valueRatio ≥ 2', trades.filter(t => t.firstRebreakDay != null && t.rebreakValueRatio != null && t.rebreakValueRatio >= 2), baseStat) });
  h3.push({ key: 'CLOSE_VOL3', ...summarize('종가 재돌파 + valueRatio ≥ 3', trades.filter(t => t.firstRebreakDay != null && t.rebreakValueRatio != null && t.rebreakValueRatio >= 3), baseStat) });
  h3.push({ key: 'CLOSE_VOL5', ...summarize('종가 재돌파 + valueRatio ≥ 5', trades.filter(t => t.firstRebreakDay != null && t.rebreakValueRatio != null && t.rebreakValueRatio >= 5), baseStat) });

  // ─────────────────────── 가설 4: 기준 종가 이탈/회복 ───────────────────────
  const h4 = [];
  h4.push({ key: 'BASE', ...summarize('베이스', trades, baseStat) });
  h4.push({ key: 'NONE', ...summarize('이탈 없음', trades.filter(t => t.breakdownState === 'NONE'), baseStat) });
  h4.push({ key: 'SAMEDAY', ...summarize('이탈 후 당일 회복', trades.filter(t => t.breakdownState === 'BREACH_SAMEDAY_RECOVER'), baseStat) });
  h4.push({ key: 'NEXTDAY', ...summarize('이탈 후 다음 거래일 회복', trades.filter(t => t.breakdownState === 'BREACH_NEXTDAY_RECOVER'), baseStat) });
  h4.push({ key: 'NO_RECOVER', ...summarize('이탈 후 회복 실패', trades.filter(t => t.breakdownState === 'BREACH_NO_RECOVER'), baseStat) });
  h4.push({ key: 'REBREAK_OK', ...summarize('이탈 후 재돌파까지 성공', trades.filter(t => t.breakdownState === 'BREACH_REBREAK_OK'), baseStat) });

  // ─────────────────────── 가설 5: 갭 크기 재검증 ───────────────────────
  const h5 = [];
  h5.push({ key: 'BASE', ...summarize('베이스', trades, baseStat) });
  const buckets5 = [
    { key: 'GN', label: 'gap% < 0', test: g => g < 0 },
    { key: 'G0_2', label: '0 ≤ gap% < 2', test: g => g >= 0 && g < 2 },
    { key: 'G2_5', label: '2 ≤ gap% < 5', test: g => g >= 2 && g < 5 },
    { key: 'G5_8', label: '5 ≤ gap% < 8', test: g => g >= 5 && g < 8 },
    { key: 'G8_12', label: '8 ≤ gap% < 12', test: g => g >= 8 && g < 12 },
    { key: 'G12P', label: 'gap% ≥ 12', test: g => g >= 12 },
  ];
  for (const b of buckets5) {
    h5.push({ key: b.key, ...summarize(b.label, trades.filter(t => t.gapPct != null && b.test(t.gapPct)), baseStat) });
  }
  h5.push({ key: 'G8_CLOSE', ...summarize('gap ≥ 8 + 종가 재돌파', trades.filter(t => t.gapPct != null && t.gapPct >= 8 && t.firstRebreakDay != null), baseStat) });
  h5.push({ key: 'G8_NOREB', ...summarize('gap ≥ 8 + 재돌파 실패', trades.filter(t => t.gapPct != null && t.gapPct >= 8 && t.firstRebreakDay == null), baseStat) });
  h5.push({ key: 'G8_VOL', ...summarize('gap ≥ 8 + 거래대금 동반(H돌파일)', trades.filter(t => t.gapPct != null && t.gapPct >= 8 && t.hHasVolumeSupport), baseStat) });
  h5.push({ key: 'G8_WICK', ...summarize('gap ≥ 8 + 위꼬리 적음(H돌파일)', trades.filter(t => t.gapPct != null && t.gapPct >= 8 && t.hUpperWickSmall), baseStat) });

  // ─────────────────────── 가설 6: 종가 위치 (재돌파일) ───────────────────────
  const h6 = [];
  h6.push({ key: 'BASE', ...summarize('베이스', trades, baseStat) });
  h6.push({ key: 'CP_80P', ...summarize('재돌파일 closePos ≥ 0.8', trades.filter(t => t.rebreakClosePos != null && t.rebreakClosePos >= 0.8), baseStat) });
  h6.push({ key: 'CP_60_80', ...summarize('재돌파일 0.6 ≤ closePos < 0.8', trades.filter(t => t.rebreakClosePos != null && t.rebreakClosePos >= 0.6 && t.rebreakClosePos < 0.8), baseStat) });
  h6.push({ key: 'CP_40_60', ...summarize('재돌파일 0.4 ≤ closePos < 0.6', trades.filter(t => t.rebreakClosePos != null && t.rebreakClosePos >= 0.4 && t.rebreakClosePos < 0.6), baseStat) });
  h6.push({ key: 'CP_LT40', ...summarize('재돌파일 closePos < 0.4', trades.filter(t => t.rebreakClosePos != null && t.rebreakClosePos < 0.4), baseStat) });
  h6.push({ key: 'CR_CP80', ...summarize('종가 재돌파 + closePos ≥ 0.8', trades.filter(t => t.firstRebreakDay != null && t.rebreakClosePos != null && t.rebreakClosePos >= 0.8), baseStat) });
  h6.push({ key: 'CR_CP60', ...summarize('종가 재돌파 + closePos ≥ 0.6', trades.filter(t => t.firstRebreakDay != null && t.rebreakClosePos != null && t.rebreakClosePos >= 0.6), baseStat) });
  h6.push({ key: 'INT_CP40', ...summarize('장중 재돌파 + closePos < 0.4', trades.filter(t => t.intradayOnly && t.rebreakClosePos != null && t.rebreakClosePos < 0.4), baseStat) });

  // ─────────────────────── 가설 7: 재돌파 후 거리 ───────────────────────
  const h7 = [];
  h7.push({ key: 'BASE', ...summarize('베이스', trades, baseStat) });
  const buckets7 = [
    { key: 'D0_2', label: '0~2%', test: d => d >= 0 && d < 2 },
    { key: 'D2_5', label: '2~5%', test: d => d >= 2 && d < 5 },
    { key: 'D5_8', label: '5~8%', test: d => d >= 5 && d < 8 },
    { key: 'D8_12', label: '8~12%', test: d => d >= 8 && d < 12 },
    { key: 'D12P', label: '12% 이상', test: d => d >= 12 },
  ];
  for (const b of buckets7) {
    h7.push({ key: b.key, ...summarize('재돌파 후 거리 ' + b.label, trades.filter(t => t.rebreakCloseDistPct != null && b.test(t.rebreakCloseDistPct)), baseStat) });
  }

  // ─────────────────────── 가설 8: 첫 눌림 회복 ───────────────────────
  const h8 = [];
  h8.push({ key: 'BASE', ...summarize('베이스', trades, baseStat) });
  h8.push({ key: 'NO_PULL', ...summarize('눌림 없이 상승', trades.filter(t => !t.everPullbackToBreakoutLine), baseStat) });
  h8.push({ key: 'LINE_PULL', ...summarize('기준선 근처 눌림 후 회복 (이탈 X)', trades.filter(t => t.everPullbackToBreakoutLine && !t.everPullbackToBaseClose), baseStat) });
  h8.push({ key: 'BASE_NEAR', ...summarize('기준 종가 근처 눌림 후 회복', trades.filter(t => t.everPullbackToBaseClose && !t.everBelowBase), baseStat) });
  h8.push({ key: 'BREACH_REC', ...summarize('기준 종가 이탈 후 회복', trades.filter(t => t.everBelowBase && t.breakdownEverRecovered), baseStat) });
  h8.push({ key: 'BREACH_FAIL', ...summarize('기준 종가 이탈 후 회복 실패', trades.filter(t => t.everBelowBase && !t.breakdownEverRecovered), baseStat) });

  // ─────────────────────── 가설 9: 실전 운용 조합 TOP ───────────────────────
  const COMBOS = [
    { key: 'CR', label: '종가 재돌파', match: t => t.firstRebreakDay != null },
    { key: 'CR_V2', label: '종가 재돌파 + 거래대금 ≥ 2', match: t => t.firstRebreakDay != null && t.rebreakValueRatio >= 2 },
    { key: 'CR_V3', label: '종가 재돌파 + 거래대금 ≥ 3', match: t => t.firstRebreakDay != null && t.rebreakValueRatio >= 3 },
    { key: 'CR_CP70', label: '종가 재돌파 + closePos ≥ 0.7', match: t => t.firstRebreakDay != null && t.rebreakClosePos >= 0.7 },
    { key: 'CR_NO_BREACH', label: '종가 재돌파 + 기준 종가 이탈 없음', match: t => t.firstRebreakDay != null && !t.everBelowBase },
    { key: 'CR_FAST', label: '종가 재돌파 + D+1~D+2', match: t => t.firstRebreakDay != null && t.firstRebreakDay <= 2 },
    { key: 'CR_V2_NB', label: '종가 재돌파 + 거래대금 ≥ 2 + 이탈 없음', match: t => t.firstRebreakDay != null && t.rebreakValueRatio >= 2 && !t.everBelowBase },
    { key: 'CR_V2_CP70', label: '종가 재돌파 + 거래대금 ≥ 2 + closePos ≥ 0.7', match: t => t.firstRebreakDay != null && t.rebreakValueRatio >= 2 && t.rebreakClosePos >= 0.7 },
    { key: 'CR_V2_G8', label: '종가 재돌파 + 거래대금 ≥ 2 + gap ≥ 8', match: t => t.firstRebreakDay != null && t.rebreakValueRatio >= 2 && t.gapPct >= 8 },
    { key: 'CR_WICK', label: '종가 재돌파 + 위꼬리 적음(H돌파일)', match: t => t.firstRebreakDay != null && t.hUpperWickSmall },
    { key: 'CR_NO_OVERHEAT', label: '종가 재돌파 + 과열 거리 제외 (재돌파 후 거리 < 12%)', match: t => t.firstRebreakDay != null && t.rebreakCloseDistPct != null && t.rebreakCloseDistPct < 12 },
  ];
  const h9 = [{ key: 'BASE', ...summarize('베이스', trades, baseStat) }];
  for (const c of COMBOS) {
    h9.push({ key: c.key, ...summarize(c.label, trades.filter(c.match), baseStat) });
  }

  // ─────────────────────── 추천 + 제외 조건 ───────────────────────
  // n≥50, 승률·매번 평균 동시 개선, 종합 점수
  function score(s) { return (s.dWR || 0) + (s.dE || 0) * 5; }
  const allCells = [
    ...h1.map(s => ({ ...s, hyp: 'H1 재돌파 속도' })),
    ...h2.map(s => ({ ...s, hyp: 'H2 유지력' })),
    ...h3.map(s => ({ ...s, hyp: 'H3 거래대금' })),
    ...h4.map(s => ({ ...s, hyp: 'H4 이탈/회복' })),
    ...h5.map(s => ({ ...s, hyp: 'H5 갭' })),
    ...h6.map(s => ({ ...s, hyp: 'H6 종가 위치' })),
    ...h7.map(s => ({ ...s, hyp: 'H7 사후 거리' })),
    ...h8.map(s => ({ ...s, hyp: 'H8 눌림' })),
    ...h9.map(s => ({ ...s, hyp: 'H9 조합' })),
  ];
  const recs = allCells
    .filter(s => s.key !== 'BASE' && s.n >= 50 && s.dWR > 0 && s.dE > 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 20)
    .map(s => ({ ...s, score: round(score(s), 2), tier: s.n >= 80 ? 'HIGH' : 'MID', isCore: s.winRate >= 70 && s.avgClose5 >= 5 }));

  const exclusions = allCells
    .filter(s => s.key !== 'BASE' && s.n >= 30 && (s.dE != null && s.dE < -1))
    .sort((a, b) => (a.dE || 0) - (b.dE || 0))
    .slice(0, 10);

  // 보드 반영 추천
  const boardRecommendations = [
    {
      title: '✅ 핵심 긍정 조건 (보드 강조 표시)',
      items: recs.filter(r => r.isCore).slice(0, 5),
      note: '승률 70%↑ + 매번 평균 +5%↑ 동시 충족. 핵심 운용 시그널.',
    },
    {
      title: '⭐ 보조 긍정 조건 (보드 일반 표시)',
      items: recs.filter(r => !r.isCore && r.tier === 'HIGH').slice(0, 5),
      note: 'n≥80 신뢰 표본, 베이스 대비 명확한 개선.',
    },
    {
      title: '❌ 강력한 제외 조건 (보드 경고 표시)',
      items: exclusions.slice(0, 5),
      note: '베이스 대비 매번 평균 -1%p 이상 악화. 신규 진입 회피 권장.',
    },
  ];

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'H그룹 재돌파 심층 검증 (Deep Dive)',
      purpose: '재돌파를 중심축으로 두고 속도·유지력·거래대금·이탈/회복·갭·종가 위치·사후 거리·눌림 회복형을 깊게 분해해 D+5 운용 보드 보조 기준 도출.',
      noFutureInfo: '필터는 모두 매수 시점 또는 D+1~D+5 장중 실시간 확인 가능한 정보만 사용.',
      entry: 'H돌파일 종가 (D+0)',
      hold: 'D+1~D+5 단순 보유 (TP/SL 없음)',
    },
    counts: { totalEvents: events.length, effectiveTrades: trades.length },
    baseline: baseStat,
    hypothesis: {
      h1: { label: 'H1. 재돌파 속도', items: h1 },
      h2: { label: 'H2. 재돌파 유지력', items: h2 },
      h3: { label: 'H3. 거래대금 강도 (재돌파일)', items: h3 },
      h4: { label: 'H4. 기준 종가 이탈/회복', items: h4 },
      h5: { label: 'H5. 갭 크기', items: h5 },
      h6: { label: 'H6. 종가 위치 (재돌파일)', items: h6 },
      h7: { label: 'H7. 재돌파 후 거리', items: h7 },
      h8: { label: 'H8. 첫 눌림 회복', items: h8 },
      h9: { label: 'H9. 실전 운용 조합', items: h9 },
    },
    recommendations: recs,
    exclusions,
    boardRecommendations,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // ─── 콘솔 출력 ───
  function dump(label, rows) {
    console.log(`\n📊 ${label}`);
    console.log(`  조건                                                  n     승률   매번    중간   MFE   MAE   +3%   +5%   이탈   재돌X  시초  ΔWR    ΔE`);
    for (const r of rows) {
      const lowN = r.n < 30 ? ' ⚠' : (r.n < 50 ? ' (참)' : '');
      const dWR = r.dWR != null ? (r.dWR >= 0 ? '+' : '') + r.dWR : '-';
      const dE = r.dE != null ? (r.dE >= 0 ? '+' : '') + r.dE : '-';
      console.log(`  ${(r.label || '-').padEnd(50)} ${String(r.n).padStart(4)}  ${String(r.winRate ?? '-').padStart(5)}%  ${String(r.avgClose5 ?? '-').padStart(6)}%  ${String(r.medianClose5 ?? '-').padStart(5)}%  ${String(r.avgMFE5 ?? '-').padStart(4)}%  ${String(r.avgMAE5 ?? '-').padStart(5)}%  ${String(r.reach3Rate ?? '-').padStart(4)}%  ${String(r.reach5Rate ?? '-').padStart(4)}%  ${String(r.breachRate ?? '-').padStart(4)}%  ${String(r.noRebreakRate ?? '-').padStart(4)}%  ${String(r.timeStuckRate ?? '-').padStart(4)}%  ${dWR.padStart(5)}  ${dE.padStart(5)}${lowN}`);
    }
  }
  dump('H1. 재돌파 속도', h1);
  dump('H2. 재돌파 유지력', h2);
  dump('H3. 거래대금 강도', h3);
  dump('H4. 기준 종가 이탈/회복', h4);
  dump('H5. 갭 크기', h5);
  dump('H6. 종가 위치', h6);
  dump('H7. 재돌파 후 거리', h7);
  dump('H8. 첫 눌림 회복', h8);
  dump('H9. 실전 운용 조합', h9);

  console.log(`\n🏆 추천 운영 조건 TOP 20 (n≥50, 승률+평균 동시 개선):`);
  for (const r of recs) {
    const tag = r.isCore ? '⭐핵심' : (r.tier === 'HIGH' ? '🟢고신뢰' : '🟡중간');
    console.log(`  ${tag} [${r.hyp}] ${r.label} → n=${r.n}, 승률 ${r.winRate}% (Δ${r.dWR > 0 ? '+' : ''}${r.dWR}), 매번 ${r.avgClose5}% (Δ${r.dE > 0 ? '+' : ''}${r.dE})`);
  }
  console.log(`\n❌ 강력한 제외 조건 TOP 10 (베이스 대비 매번 -1%p 이상):`);
  for (const r of exclusions) {
    console.log(`  [${r.hyp}] ${r.label} → n=${r.n}, 승률 ${r.winRate}%, 매번 ${r.avgClose5}% (Δ${r.dE})`);
  }

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>H그룹 재돌파 심층 검증</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px; -webkit-overflow-scrolling: touch;
}
nav { display:flex; gap:10px; flex-wrap:wrap; padding:8px 0 14px; border-bottom:1px solid #1e293b; margin-bottom:14px; }
nav a { color:#94a3b8; text-decoration:none; font-size:12px; padding:4px 8px; border-radius:4px; }
nav a:hover { color:#e2e8f0; background:#1e293b; }
nav a.active { color:#f1f5f9; background:#1e293b; }
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 16px 0 8px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #0f172a; border-left: 3px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.warn { color:#fbbf24; }
.scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; margin-bottom: 14px; border-radius: 8px; }
table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 8px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; white-space: nowrap; }
table.cmp thead th:first-child { text-align: left; }
table.cmp tbody td { padding: 7px 8px; border-bottom: 1px solid #334155; text-align: right; }
table.cmp tbody td:first-child { text-align: left; color: #cbd5e1; font-weight: 600; max-width: 320px; }
table.cmp tbody tr:hover td { background: #273549; }
.row-base td { background: rgba(99,102,241,0.10) !important; font-weight: 600; }
.row-good td { background: rgba(16,185,129,0.12) !important; }
.row-bad td { background: rgba(239,68,68,0.10) !important; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-neutral { color: #94a3b8; }
.cell-strong-pos { color: #34d399; font-weight: 700; }   /* 사용자 spec: 수익 비율 ≥70 / 평균 결과 ≥+5 강한 긍정 */
.cell-warn { color: #fbbf24; font-weight: 600; }          /* 사용자 spec: 재돌파 실패율/기준가 깨짐 높음 주의 */
.tag-low-n { color: #fbbf24; font-size: 10px; }
.tag-ref-only { color: #fbbf24; font-size: 10px; }
.cell-interp { font-size: 11.5px; line-height: 1.5; max-width: 220px; white-space: normal; text-align: left; }
.cell-interp.is-strong { color: #6ee7b7; font-weight: 600; }
.cell-interp.is-weak { color: #fca5a5; }
.cell-interp.is-warn { color: #fbbf24; }
.cell-interp.is-base { color: #94a3b8; font-style: italic; }
.cell-interp.is-ref { color: #fbbf24; font-style: italic; }

/* 컬럼 헤더 툴팁 (?) */
.col-tip { display: inline-flex; align-items: center; gap: 4px; cursor: help; position: relative; }
.col-tip .ico { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; border: 1px solid #475569; color: #94a3b8; font-size: 9px; font-weight: 700; background: #0f172a; }
.col-tip:hover .ico { border-color: #38bdf8; color: #38bdf8; }
.col-tip:hover::after {
  content: attr(data-tip);
  position: absolute;
  bottom: 130%;
  left: 50%;
  transform: translateX(-50%);
  background: #0f172a;
  color: #f1f5f9;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 11px;
  white-space: normal;
  width: 240px;
  z-index: 100;
  border: 1px solid #475569;
  line-height: 1.6;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  text-align: left;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

/* 상세 보기 토글 */
.table-wrap { margin-bottom: 14px; }
.toggle-detail-btn { background:#0f172a; border:1px solid #334155; color:#cbd5e1; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:11px; margin-bottom:6px; }
.toggle-detail-btn:hover { background:#273549; color:#f1f5f9; border-color:#475569; }
table.cmp .col-detail { display: none; }
table.cmp.show-detail .col-detail { display: table-cell; }

/* 표 상단 안내 박스 */
.table-help { background: #0f172a; border-left: 3px solid #fbbf24; padding: 9px 14px; border-radius: 6px; margin-bottom: 10px; line-height: 1.6; color: #fde68a; font-size: 12px; }

.summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin-bottom: 14px; }
.summary-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 14px; }
.summary-card.core { border-left: 4px solid #10b981; }
.summary-card.aux { border-left: 4px solid #38bdf8; }
.summary-card.bad { border-left: 4px solid #ef4444; }
.summary-card h3 { margin: 0 0 6px; font-size: 13px; color: #f1f5f9; }
.summary-card .item { font-size: 11.5px; line-height: 1.7; color: #cbd5e1; padding: 3px 0; border-bottom: 1px dashed #334155; }
.summary-card .item:last-child { border-bottom: none; }
.summary-card .stat { color: #94a3b8; font-size: 10.5px; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; }
  .scroll-x table.cmp { width: max-content; min-width: 100%; white-space: nowrap; }
}
</style>
</head>
<body>

<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/d5-rebreak-board">🔥 D+5 재돌파 운용</a>
  <a href="/d5-rebreak-deep-dive" class="active">🔬 재돌파 심층 검증</a>
  <a href="/d5-hyp">🧪 D+5 가설 검증</a>
</nav>

<h1>🔬 H그룹 재돌파 심층 검증 (Deep Dive)</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  H돌파일 고가 재돌파가 D+5 성과를 가르는 핵심 시그널이라는 점은 확인됐다 (재돌파 있음 승률 75% / 매번 +6.83%, 없음 8% / -5.54%).
  이번에는 <strong>재돌파를 중심축으로 두고 속도·유지력·거래대금·이탈/회복·갭·종가 위치·사후 거리·눌림 회복형</strong>을 깊게 분해해
  D+5 운용 보드의 보조 기준을 찾는다. 진입 = H돌파일 종가, 청산 = D+5 종가 (단순 보유).
</div>

<h2>🏆 1. 핵심 요약 — 보드 반영 추천</h2>
<div class="summary-cards" id="summary-cards"></div>

<div class="table-help">
  💡 <strong>이 표 보는 법</strong> — 이 표는 개발자용 수치가 아니라, 과거 D+5 검증에서 어떤 조건이 실제로 좋았는지 쉽게 보기 위한 요약표입니다. 기본은 8개 항목만 보여주고, 더 자세한 수치는 각 표의 <strong>"상세 보기"</strong>를 누르면 펼쳐집니다. <strong>사례 수가 30개 미만</strong>인 조건은 참고용으로만 봅니다 (⚠ 표시).
</div>

<h2>📊 2. H1. 재돌파 속도 (D+1~D+5 + 없음)</h2>
<p class="subtitle">처음 종가 재돌파한 날(rebreakDay) 기준. 빠를수록 좋은지 검증.</p>
<div id="h1-table"></div>

<h2>📊 3. H2. 재돌파 유지력 (장중 vs 종가 vs 다음날 유지)</h2>
<p class="subtitle">장중만 재돌파 vs 종가 재돌파 vs 다음 거래일도 위 유지.</p>
<div id="h2-table"></div>

<h2>📊 4. H3. 거래대금 강도 (재돌파일 거래대금 / 이전 20일 평균)</h2>
<p class="subtitle">재돌파한 날의 거래대금이 평소보다 얼마나 큰지. 1=평소, 2=2배, 5=5배. (개발자용: valueRatio)</p>
<div id="h3-table"></div>

<h2>📊 5. H4. 기준 종가 이탈/회복</h2>
<p class="subtitle">D+1~D+5 동안 baseClose 이탈/회복 패턴.</p>
<div id="h4-table"></div>

<h2>📊 6. H5. 갭 크기 재검증</h2>
<p class="subtitle">D+1 시가 / baseClose - 1. 단독 vs 결합 효과.</p>
<div id="h5-table"></div>

<h2>📊 7. H6. 종가 위치 (재돌파일)</h2>
<p class="subtitle">재돌파일의 closePosition. 고가권 마감일수록 강한 신호인지.</p>
<div id="h6-table"></div>

<h2>📊 8. H7. 재돌파 후 거리 (재돌파일 종가 / hHigh - 1)</h2>
<p class="subtitle">재돌파 후 너무 멀리 가면 추격 위험인지, 강한 모멘텀인지.</p>
<div id="h7-table"></div>

<h2>📊 9. H8. 첫 눌림 회복형</h2>
<p class="subtitle">눌림 패턴 5종 비교.</p>
<div id="h8-table"></div>

<h2>🎯 10. H9. 실전 운용 조합 TOP</h2>
<p class="subtitle">재돌파 + 거래대금/위치/이탈/속도/갭 조합. 보드에 직접 활용 후보.</p>
<div id="h9-table"></div>

<h2>🏅 11. 추천 운영 조건 TOP 20 (사례 50건 이상, 수익 비율과 평균 결과 동시 개선)</h2>
<div id="rec-table"></div>

<h2>🚨 12. 강력한 제외 조건 TOP 10 (평균 결과가 전체 대비 -1%p 이상 나빠진 조건)</h2>
<div id="excl-table"></div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;
const baseline = DATA.baseline;

function fmtPct(v) {
  if (v == null || !isFinite(v)) return '<span class="cell-neutral">-</span>';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%</span>';
}
// 수익 비율 (구 승률) — 70%↑ 강한 긍정
function fmtWinRate(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v >= 70 ? 'cell-strong-pos' : (v >= 60 ? 'cell-pos' : (v < 35 ? 'cell-neg' : 'cell-neutral'));
  return '<span class="' + cls + '">' + Number(v).toFixed(1) + '%</span>';
}
// 평균 결과 — +5%↑ 강한 긍정
function fmtAvg(v) {
  if (v == null || !isFinite(v)) return '<span class="cell-neutral">-</span>';
  const cls = v >= 5 ? 'cell-strong-pos' : (v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral'));
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%</span>';
}
// 기준가 깨짐 — 50%↑ 주의
function fmtBreachRate(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v >= 50 ? 'cell-warn' : (v >= 30 ? 'cell-neutral' : 'cell-pos');
  return '<span class="' + cls + '">' + Number(v).toFixed(1) + '%</span>';
}
// 재돌파 실패 — 70%↑ 주의
function fmtNoRebreakRate(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v >= 70 ? 'cell-warn' : (v >= 30 ? 'cell-neutral' : 'cell-pos');
  return '<span class="' + cls + '">' + Number(v).toFixed(1) + '%</span>';
}
function fmtPlainRate(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  return Number(v).toFixed(1) + '%';
}
function fmtDelta(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral');
  const arrow = v > 0 ? '▲' : (v < 0 ? '▼' : '─');
  return '<span class="' + cls + '">' + arrow + Math.abs(v).toFixed(2) + '</span>';
}
function fmtN(n) {
  if (n == null) return '-';
  if (n < 30) return '<span class="tag-low-n">' + n + ' ⚠</span>';
  if (n < 50) return n + ' <span class="tag-ref-only">(참고용)</span>';
  return n;
}

// 한 줄 해석 — 통계 결과를 사용자가 바로 이해할 수 있는 문장으로
function buildRowInterpretation(r) {
  if (r.key === 'BASE') return { text: '전체 H그룹 평균 — 비교 기준', cls: 'is-base' };
  if (r.n == null || r.n === 0) return { text: '데이터 없음', cls: 'is-base' };
  if (r.n < 30) return { text: '사례가 적어 참고용으로만 봅니다 (n<30)', cls: 'is-ref' };

  const wr = r.winRate, avg = r.avgClose5, br = r.breachRate, nr = r.noRebreakRate;
  if (wr != null && wr >= 70 && avg != null && avg >= 5) {
    return { text: '강한 긍정 — 이번 검증의 핵심 조건', cls: 'is-strong' };
  }
  if ((wr != null && wr <= 15) || (avg != null && avg <= -3)) {
    return { text: '검증상 매우 약함 — 제외 우선 구간', cls: 'is-weak' };
  }
  if (br != null && br >= 70 && wr != null && wr <= 35) {
    return { text: '기준가 자주 깨지고 결과도 약함', cls: 'is-warn' };
  }
  if (nr != null && nr >= 90 && wr != null && wr <= 25) {
    return { text: '재돌파 실패 비중이 높아 약한 구간', cls: 'is-warn' };
  }
  if (r.dWR != null && r.dWR >= 15 && r.dE != null && r.dE >= 3) {
    return { text: '베이스 대비 명확히 개선', cls: 'is-strong' };
  }
  if (r.dWR != null && r.dWR > 0 && r.dE != null && r.dE > 0) {
    return { text: '베이스 대비 약간 개선', cls: 'is-strong' };
  }
  if (r.dE != null && r.dE < -1) {
    return { text: '베이스 대비 악화', cls: 'is-weak' };
  }
  if (r.n < 50) {
    return { text: '사례가 다소 적어 참고용에 가까움 (n<50)', cls: 'is-ref' };
  }
  return { text: '베이스 근처', cls: 'is-base' };
}

document.getElementById('subtitle').textContent =
  '입력 ' + DATA.counts.totalEvents + '건 → 실효 ' + DATA.counts.effectiveTrades + '건 · ' +
  '전체 H그룹 평균: 수익 비율 ' + baseline.winRate + '%, 평균 결과 ' + baseline.avgClose5 + '% · ' +
  '생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

// 핵심 요약 카드
function renderSummaryCards() {
  const html = [];
  for (const sec of (DATA.boardRecommendations || [])) {
    const cls = sec.title.startsWith('✅') ? 'core' : (sec.title.startsWith('⭐') ? 'aux' : 'bad');
    html.push('<div class="summary-card ' + cls + '">' +
      '<h3>' + sec.title + '</h3>' +
      '<div style="color:#94a3b8;font-size:11px;line-height:1.6;margin-bottom:6px;">' + sec.note + '</div>');
    if (!sec.items || sec.items.length === 0) {
      html.push('<div class="item"><span class="cell-neutral">— 해당 조건 없음 —</span></div>');
    } else {
      for (const it of sec.items) {
        html.push('<div class="item">' +
          '<strong>' + it.label + '</strong> ' +
          '<span class="stat">[' + it.hyp + ']</span><br>' +
          '<span class="stat">사례 ' + it.n + '건 · 수익 비율 ' + (it.winRate || 0) + '% (개선 ' + (it.dWR > 0 ? '+' : '') + it.dWR + ')</span> · ' +
          '<span class="stat">평균 결과 ' + (it.avgClose5 != null ? (it.avgClose5 > 0 ? '+' : '') + it.avgClose5 : '-') + '% (개선 ' + (it.dE != null ? (it.dE > 0 ? '+' : '') + it.dE : '-') + ')</span>' +
        '</div>');
      }
    }
    html.push('</div>');
  }
  document.getElementById('summary-cards').innerHTML = html.join('');
}
renderSummaryCards();

// 헤더 셀 — 툴팁 ? 아이콘 포함
function thWithTip(label, tip, extraCls) {
  const cls = extraCls ? ' class="' + extraCls + '"' : '';
  if (!tip) return '<th' + cls + '>' + label + '</th>';
  return '<th' + cls + '><span class="col-tip" data-tip="' + tip.replace(/"/g, '&quot;') + '">' + label + '<span class="ico">?</span></span></th>';
}

function toggleDetailBtn(btn) {
  const wrap = btn.closest('.table-wrap');
  if (!wrap) return;
  const tbl = wrap.querySelector('table.cmp');
  if (!tbl) return;
  tbl.classList.toggle('show-detail');
  btn.textContent = tbl.classList.contains('show-detail') ? '◀ 상세 숨기기' : '상세 보기 ▶';
}
window.toggleDetailBtn = toggleDetailBtn;

function renderHypTable(elId, items) {
  // 컬럼 순서:
  //   기본:  조건 | 사례 수 | 수익 비율 | 평균 결과 | 5일 최고 상승 | 5일 최대 하락 | 재돌파 실패 | 해석
  //   상세:  보통 결과 | +3% 기회 | +5% 기회 | 기준가 깨짐 | 5일 내 결론 없음 | 승률 개선 | 평균 개선
  const T = {
    n: '과거에 이 조건에 해당한 종목 수입니다. 50개 이상이면 어느 정도 의미 있게 볼 수 있습니다.',
    winRate: 'D+5 안의 운용 기준으로 수익으로 끝난 비율입니다.',
    avg: '이 조건에 해당한 종목을 매번 운용했다고 가정했을 때의 평균 수익률입니다.',
    median: '극단적인 급등/급락 영향을 줄이고 가운데에 가까운 결과를 보여줍니다.',
    mfe: 'D+5 안에 한 번이라도 가장 많이 올라간 수익률입니다. (개발자용: MFE5)',
    mae: 'D+5 안에 한 번이라도 가장 많이 밀린 손실률입니다. (개발자용: MAE5)',
    r3: 'D+5 안에 한 번이라도 +3% 이상 수익권을 준 비율입니다.',
    r5: 'D+5 안에 한 번이라도 +5% 이상 수익권을 준 비율입니다.',
    breach: '기준 종가 아래로 내려간 비율입니다. 이번 검증에서는 기준가 이탈이 매우 나쁜 신호였습니다.',
    norb: 'H돌파일 고가를 종가 기준으로 다시 넘지 못한 비율입니다.',
    stuck: 'D+5 안에 뚜렷한 상승/하락 결과가 나오지 않고 끝난 비율입니다.',
    dwr: '전체 H그룹 대비 수익 비율이 얼마나 좋아졌는지 보여줍니다. (개발자용: ΔWR)',
    de: '전체 H그룹 대비 평균 결과가 얼마나 좋아졌는지 보여줍니다. (개발자용: ΔE)',
    interp: '이 조건의 통계 결과를 한 줄 문장으로 요약합니다.',
  };

  const html = [
    '<div class="table-wrap">',
    '<button class="toggle-detail-btn" onclick="toggleDetailBtn(this)">상세 보기 ▶</button>',
    '<div class="scroll-x"><table class="cmp"><thead><tr>',
    thWithTip('조건', null),
    thWithTip('사례 수', T.n),
    thWithTip('수익 비율', T.winRate),
    thWithTip('평균 결과', T.avg),
    thWithTip('보통 결과', T.median, 'col-detail'),
    thWithTip('5일 최고 상승', T.mfe),
    thWithTip('5일 최대 하락', T.mae),
    thWithTip('+3% 기회', T.r3, 'col-detail'),
    thWithTip('+5% 기회', T.r5, 'col-detail'),
    thWithTip('기준가 깨짐', T.breach, 'col-detail'),
    thWithTip('재돌파 실패', T.norb),
    thWithTip('5일 내 결론 없음', T.stuck, 'col-detail'),
    thWithTip('승률 개선', T.dwr, 'col-detail'),
    thWithTip('평균 개선', T.de, 'col-detail'),
    thWithTip('해석', T.interp),
    '</tr></thead><tbody>'];
  for (const r of items) {
    let cls = '';
    if (r.key === 'BASE') cls = ' class="row-base"';
    else if (r.n >= 50 && r.dWR > 0 && r.dE > 0) cls = ' class="row-good"';
    else if (r.n >= 30 && r.dE != null && r.dE < -1) cls = ' class="row-bad"';
    const interp = buildRowInterpretation(r);
    const isBase = r.key === 'BASE';
    html.push('<tr' + cls + '>' +
      '<td>' + r.label + '</td>' +
      '<td>' + fmtN(r.n) + '</td>' +
      '<td>' + fmtWinRate(r.winRate) + '</td>' +
      '<td>' + fmtAvg(r.avgClose5) + '</td>' +
      '<td class="col-detail">' + fmtAvg(r.medianClose5) + '</td>' +
      '<td>' + fmtPct(r.avgMFE5) + '</td>' +
      '<td>' + fmtPct(r.avgMAE5) + '</td>' +
      '<td class="col-detail">' + fmtPlainRate(r.reach3Rate) + '</td>' +
      '<td class="col-detail">' + fmtPlainRate(r.reach5Rate) + '</td>' +
      '<td class="col-detail">' + fmtBreachRate(r.breachRate) + '</td>' +
      '<td>' + fmtNoRebreakRate(r.noRebreakRate) + '</td>' +
      '<td class="col-detail">' + fmtPlainRate(r.timeStuckRate) + '</td>' +
      '<td class="col-detail">' + (isBase ? '-' : fmtDelta(r.dWR)) + '</td>' +
      '<td class="col-detail">' + (isBase ? '-' : fmtDelta(r.dE)) + '</td>' +
      '<td class="cell-interp ' + interp.cls + '">' + interp.text + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div></div>');
  document.getElementById(elId).innerHTML = html.join('');
}
renderHypTable('h1-table', DATA.hypothesis.h1.items);
renderHypTable('h2-table', DATA.hypothesis.h2.items);
renderHypTable('h3-table', DATA.hypothesis.h3.items);
renderHypTable('h4-table', DATA.hypothesis.h4.items);
renderHypTable('h5-table', DATA.hypothesis.h5.items);
renderHypTable('h6-table', DATA.hypothesis.h6.items);
renderHypTable('h7-table', DATA.hypothesis.h7.items);
renderHypTable('h8-table', DATA.hypothesis.h8.items);
renderHypTable('h9-table', DATA.hypothesis.h9.items);

// 추천 표
function renderRecTable() {
  const recs = DATA.recommendations || [];
  if (recs.length === 0) {
    document.getElementById('rec-table').innerHTML = '<div class="purpose-box" style="border-left-color:#fbbf24;color:#fde68a;">⚠️ 사례 수 50개 이상 + 동시 개선 조건 추천 없음.</div>';
    return;
  }
  const T = {
    n: '과거에 이 조건에 해당한 종목 수입니다.',
    winRate: 'D+5 안의 운용 기준으로 수익으로 끝난 비율입니다.',
    avg: '이 조건에 해당한 종목을 매번 운용했다고 가정했을 때의 평균 수익률입니다.',
    dwr: '전체 H그룹 대비 수익 비율이 얼마나 좋아졌는지 보여줍니다. (개발자용: ΔWR)',
    de: '전체 H그룹 대비 평균 결과가 얼마나 좋아졌는지 보여줍니다. (개발자용: ΔE)',
  };
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>#</th>',
    '<th>가설</th>',
    '<th>조건</th>',
    thWithTip('사례 수', T.n),
    thWithTip('수익 비율', T.winRate),
    thWithTip('평균 결과', T.avg),
    thWithTip('승률 개선', T.dwr),
    thWithTip('평균 개선', T.de),
    '<th>등급</th>',
    '</tr></thead><tbody>'];
  recs.forEach((r, i) => {
    const cls = r.isCore ? ' class="row-good"' : '';
    const tier = r.isCore ? '⭐ 핵심 (수익 비율 70%↑ + 평균 +5%↑)' : (r.tier === 'HIGH' ? '🟢 고신뢰 (사례 수 80↑)' : '🟡 중간');
    html.push('<tr' + cls + '>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + r.hyp + '</td>' +
      '<td>' + r.label + '</td>' +
      '<td>' + fmtN(r.n) + '</td>' +
      '<td>' + fmtWinRate(r.winRate) + '</td>' +
      '<td>' + fmtAvg(r.avgClose5) + '</td>' +
      '<td>' + fmtDelta(r.dWR) + '</td>' +
      '<td>' + fmtDelta(r.dE) + '</td>' +
      '<td>' + tier + '</td>' +
      '</tr>');
  });
  html.push('</tbody></table></div>');
  document.getElementById('rec-table').innerHTML = html.join('');
}
renderRecTable();

// 제외 표
function renderExclTable() {
  const ex = DATA.exclusions || [];
  if (ex.length === 0) {
    document.getElementById('excl-table').innerHTML = '<div class="purpose-box" style="border-left-color:#94a3b8;color:#cbd5e1;">제외 후보 없음.</div>';
    return;
  }
  const T = {
    n: '과거에 이 조건에 해당한 종목 수입니다.',
    winRate: 'D+5 안의 운용 기준으로 수익으로 끝난 비율입니다.',
    avg: '이 조건에 해당한 종목을 매번 운용했다고 가정했을 때의 평균 수익률입니다.',
    dwr: '전체 H그룹 대비 수익 비율이 얼마나 좋아졌는지 보여줍니다. (개발자용: ΔWR)',
    de: '전체 H그룹 대비 평균 결과가 얼마나 좋아졌는지 보여줍니다. (개발자용: ΔE)',
  };
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>#</th>',
    '<th>가설</th>',
    '<th>조건</th>',
    thWithTip('사례 수', T.n),
    thWithTip('수익 비율', T.winRate),
    thWithTip('평균 결과', T.avg),
    thWithTip('승률 개선', T.dwr),
    thWithTip('평균 개선', T.de),
    '</tr></thead><tbody>'];
  ex.forEach((r, i) => {
    html.push('<tr class="row-bad">' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + r.hyp + '</td>' +
      '<td>' + r.label + '</td>' +
      '<td>' + fmtN(r.n) + '</td>' +
      '<td>' + fmtWinRate(r.winRate) + '</td>' +
      '<td>' + fmtAvg(r.avgClose5) + '</td>' +
      '<td>' + fmtDelta(r.dWR) + '</td>' +
      '<td>' + fmtDelta(r.dE) + '</td>' +
      '</tr>');
  });
  html.push('</tbody></table></div>');
  document.getElementById('excl-table').innerHTML = html.join('');
}
renderExclTable();

document.getElementById('data-limit').innerHTML =
  '<strong>이 보고서가 다룬 것</strong><br>' +
  '• 가정: H돌파일 종가에 사서, D+5 종가까지 단순 보유 (손절/익절 없음)<br>' +
  '• 모든 조건은 매수 시점 또는 D+1~D+5 장중에 실시간으로 확인 가능 (미래 정보 사용 X)<br>' +
  '• <strong>매수 추천이 아닙니다.</strong> 과거 검증을 통한 가설 평가입니다.<br>' +
  '<br>' +
  '<strong>컬럼 의미 (요약)</strong><br>' +
  '• 사례 수 = 과거에 이 조건에 해당했던 종목 수 (50개 이상이면 어느 정도 의미 있게 봄)<br>' +
  '• 수익 비율 = D+5 시점에 수익으로 끝난 비율 (개발자용: 승률)<br>' +
  '• 평균 결과 = 매번 운용했다고 가정한 평균 수익률 (개발자용: 매번 평균)<br>' +
  '• 보통 결과 = 극단치 영향을 줄인 가운데값 (개발자용: 중앙값)<br>' +
  '• 5일 최고 상승 / 5일 최대 하락 = D+5 안에 한 번이라도 닿은 최고/최저 (개발자용: MFE5/MAE5)<br>' +
  '• +3% / +5% 기회 = D+5 안에 한 번이라도 +3% / +5% 이상 갔던 비율<br>' +
  '• 기준가 깨짐 = 기준 종가 아래로 내려간 비율 (이번 검증에서 매우 나쁜 신호였음)<br>' +
  '• 재돌파 실패 = H돌파일 고가를 종가 기준으로 다시 못 넘은 비율<br>' +
  '• 5일 내 결론 없음 = 5일 안에 뚜렷한 상승/하락이 안 나오고 끝난 비율 (개발자용: 시간초과)<br>' +
  '• 승률 개선 / 평균 개선 = 전체 H그룹 평균 대비 얼마나 좋아졌는지 (개발자용: ΔWR / ΔE)<br>' +
  '<br>' +
  '<strong>색상 기준</strong><br>' +
  '• 수익 비율 70% 이상 / 평균 결과 +5% 이상 → 강한 긍정 (밝은 초록)<br>' +
  '• 기준가 깨짐 50% 이상 / 재돌파 실패 70% 이상 → 주의 (노랑)<br>' +
  '• 사례 수 30 미만 → 참고용 표시 (⚠)';
</script>

</body>
</html>
`;

main();
