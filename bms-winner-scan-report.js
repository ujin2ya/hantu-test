#!/usr/bin/env node
/**
 * BMS Winner Scan Report
 *
 * 목적:
 *   과거 데이터에서 일정 기간(기본 15거래일) 안에 +40% 이상 크게 오른 종목들을
 *   프로그램이 자동으로 찾아내고, 그 종목들이 오르기 전 어떤 거래대금·거래량·
 *   이평선·매물대·박스권·가격 위치 조건을 가졌는지 분석하는 HTML/JSON 보고서.
 *
 *   중요: 특정 종목명을 기준으로 맞추지 않는다. 시장 전체 데이터에서 스스로 발견.
 *   이번 단계는 점수화·후보 탐색이 아니라 "과거 상승 종목의 조건을 정확히 파악".
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json  (OHLCV + valueApprox, 약 120일)
 *   - cache/flow-history/{code}.json       (순매수금액 — 매수/매도 분리는 데이터 없음)
 *   - cache/naver-stocks-list.json         (종목 마스터 + marketValue)
 *
 * 출력:
 *   - reports/bms-winner-scan-result.json
 *   - reports/bms-winner-scan-result.html
 *
 * 실행:
 *   node bms-winner-scan-report.js
 *   node bms-winner-scan-report.js --window=15 --target=40
 *   node bms-winner-scan-report.js --window=20 --target=50
 *   node bms-winner-scan-report.js --pre=20 --post=10
 *
 * 화면 용어 통일 (내부 → 화면):
 *   winner → 크게 오른 종목 / startPoint → 상승 시작점
 *   preRunupWindow → 상승 전 준비 구간
 *   accumulatedValueRatio → 시총 대비 들어온 돈
 *   valueSpikeRatio → 평소보다 거래가 늘어난 정도
 *   supplyZoneAbove → 위쪽 매물 부담
 *   boxRangeDays → 상승 전 박스권 기간
 *   movingAverage → 이평선
 *   drawdownAfterPeak → 고점 이후 하락률
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache/flow-history');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'bms-winner-scan-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'bms-winner-scan-result.html');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  });
  return out;
})();

const CONFIG = {
  WINDOW_DAYS: parseInt(args['window'] || '15'),       // 관찰 기간
  TARGET_RETURN_PCT: parseFloat(args['target'] || '40'),  // 목표 상승률
  PRE_RUNUP_DAYS: parseInt(args['pre'] || '20'),       // 상승 전 준비 구간
  POST_PEAK_DAYS: parseInt(args['post'] || '10'),      // 상승 후 추적 구간
  BOX_MIN_DAYS: 10,
  BOX_MAX_DAYS: 30,
  SUPPLY_LOOKBACK_DAYS: 120,
  SUPPLY_BINS: 24,
  MIN_MARKET_CAP: parseInt(args['min-mc'] || '100') * 100_000_000,    // 시총 100억 이상
  MIN_HISTORY: 80,                                     // 최소 차트 데이터
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcluded(name) { return name && EXCLUDE_KEYWORDS.some(k => name.includes(k)); }

// ─────────────────────── 헬퍼 ───────────────────────

function round(v, d) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function pct(num, den) { if (!den || den === 0) return null; return round(num / den * 100, 2); }
function sma(arr, period, key) {
  if (!arr || arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += (key ? arr[i][key] : arr[i]) || 0;
  return sum / period;
}
function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }

// ─────────────────────── winner 탐색 ───────────────────────

// 차트에서 +TARGET% 사례 찾기
// 중첩 방지: 한 번 발견하면 peakIdx 다음부터 다시 스캔
function findWinners(rows) {
  const winners = [];
  let i = 0;
  while (i < rows.length - 1) {
    const startClose = rows[i].close;
    if (!startClose || startClose <= 0) { i++; continue; }
    const target = startClose * (1 + CONFIG.TARGET_RETURN_PCT / 100);

    let peakIdx = -1;
    let maxHigh = 0;
    let maxClose = 0;
    let maxHighIdx = -1;
    let maxCloseIdx = -1;

    const upper = Math.min(i + CONFIG.WINDOW_DAYS, rows.length - 1);
    for (let j = i + 1; j <= upper; j++) {
      if (rows[j].high >= target && peakIdx < 0) peakIdx = j;
      if (rows[j].high > maxHigh) { maxHigh = rows[j].high; maxHighIdx = j; }
      if (rows[j].close > maxClose) { maxClose = rows[j].close; maxCloseIdx = j; }
    }

    if (peakIdx > 0) {
      winners.push({
        startIdx: i,
        peakIdx,
        startDate: rows[i].date,
        peakDate: rows[peakIdx].date,
        startClose,
        peakHigh: maxHigh,
        peakClose: maxClose,
        peakHighIdx: maxHighIdx,
        peakCloseIdx: maxCloseIdx,
        daysToPeak: peakIdx - i,
        maxHighReturn: round((maxHigh - startClose) / startClose * 100, 2),
        maxCloseReturn: round((maxClose - startClose) / startClose * 100, 2),
      });
      // 중첩 방지: 같은 종목 안에서 다음 스캔은 peakIdx 다음부터
      i = (maxHighIdx > 0 ? maxHighIdx : peakIdx) + 1;
    } else {
      i++;
    }
  }
  return winners;
}

// ─────────────────────── winner 분석 ───────────────────────

function analyzeWinner(rows, flowRows, marketCap, w) {
  const startIdx = w.startIdx;
  const peakIdx = w.peakIdx;
  const peakHighIdx = w.peakHighIdx;

  // 상승 전 준비 구간 [startIdx-PRE, startIdx-1]
  const preStart = Math.max(0, startIdx - CONFIG.PRE_RUNUP_DAYS);
  const preRows = rows.slice(preStart, startIdx);
  const preLen = preRows.length;

  // 상승 진행 구간 [startIdx, peakIdx]
  const runRows = rows.slice(startIdx, peakIdx + 1);

  // 상승 후 추적 구간 [peakHighIdx+1, +POST]
  const postStart = Math.min(rows.length, (peakHighIdx > 0 ? peakHighIdx : peakIdx) + 1);
  const postEnd = Math.min(rows.length, postStart + CONFIG.POST_PEAK_DAYS);
  const postRows = rows.slice(postStart, postEnd);

  // 매물대 lookback [startIdx-SUPPLY_LOOKBACK, startIdx-1]
  const supplyStart = Math.max(0, startIdx - CONFIG.SUPPLY_LOOKBACK_DAYS);
  const supplyRows = rows.slice(supplyStart, startIdx);

  // 1) 상승 전 거래대금 ─────────────────────────────
  const preSumValue = preRows.reduce((s, r) => s + (r.valueApprox || 0), 0);
  const preAvgValue = preLen > 0 ? preSumValue / preLen : 0;
  const startDayValue = rows[startIdx].valueApprox || 0;
  const preAccumulation = {
    days: preLen,
    accumulatedValue: round(preSumValue, 0),
    accumulatedValueRatio: marketCap > 0 ? pct(preSumValue, marketCap) : null,    // 시총 대비
    startDayValue: round(startDayValue, 0),
    startDayValueRatio: marketCap > 0 ? pct(startDayValue, marketCap) : null,
    valueSpikeRatio: preAvgValue > 0 ? round(startDayValue / preAvgValue, 2) : null,
    avgPreValue: round(preAvgValue, 0),
  };

  // 2) 상승 중 거래대금/거래량 ─────────────────────────────
  const runSumValue = runRows.reduce((s, r) => s + (r.valueApprox || 0), 0);
  const runSumVolume = runRows.reduce((s, r) => s + (r.volume || 0), 0);
  const runMaxValue = runRows.reduce((m, r) => Math.max(m, r.valueApprox || 0), 0);
  const runAvgValue = runRows.length > 0 ? runSumValue / runRows.length : 0;
  // 평소(preAvg) 대비 1.5배 이상 거래대금일 수
  const valueSpikeDays = runRows.filter(r => preAvgValue > 0 && (r.valueApprox || 0) > preAvgValue * 1.5).length;
  const runAnalysis = {
    days: runRows.length,
    accumulatedValue: round(runSumValue, 0),
    accumulatedValueRatio: marketCap > 0 ? pct(runSumValue, marketCap) : null,
    accumulatedVolume: runSumVolume,
    avgValue: round(runAvgValue, 0),
    maxValue: round(runMaxValue, 0),
    maxValueRatio: marketCap > 0 ? pct(runMaxValue, marketCap) : null,
    spikeAvgRatio: preAvgValue > 0 ? round(runAvgValue / preAvgValue, 2) : null,
    spikeDays: valueSpikeDays,                            // 평소보다 거래대금 크게 늘어난 날 수
    spikeDaysRatio: pct(valueSpikeDays, runRows.length),
  };

  // 3) 매수/매도 — 데이터 한계: 매수금액·매도금액 분리 없음, 순매수만 있음 ──────
  let flowAnalysis = null;
  if (flowRows && flowRows.length > 0) {
    const flowByDate = new Map(flowRows.map(r => [r.date, r]));
    const sumNet = (rowsArr) => rowsArr.reduce((acc, r) => {
      const f = flowByDate.get(r.date);
      if (!f) return acc;
      const inst = Number(f.instNetValue || 0);
      const foreign = Number(f.foreignNetValue || 0);
      return { inst: acc.inst + inst, foreign: acc.foreign + foreign };
    }, { inst: 0, foreign: 0 });
    const preFlow = sumNet(preRows);
    const runFlow = sumNet(runRows);
    const postFlow = sumNet(postRows);
    flowAnalysis = {
      dataLimit: '매수금액/매도금액 분리 데이터 없음. 순매수금액만 가용 (외국인+기관 합산).',
      pre: {
        instNetValue: round(preFlow.inst, 0),
        foreignNetValue: round(preFlow.foreign, 0),
        totalNetValue: round(preFlow.inst + preFlow.foreign, 0),
        netValueToCap: marketCap > 0 ? pct(preFlow.inst + preFlow.foreign, marketCap) : null,
      },
      run: {
        instNetValue: round(runFlow.inst, 0),
        foreignNetValue: round(runFlow.foreign, 0),
        totalNetValue: round(runFlow.inst + runFlow.foreign, 0),
        netValueToCap: marketCap > 0 ? pct(runFlow.inst + runFlow.foreign, marketCap) : null,
      },
      post: {
        instNetValue: round(postFlow.inst, 0),
        foreignNetValue: round(postFlow.foreign, 0),
        totalNetValue: round(postFlow.inst + postFlow.foreign, 0),
        netValueToCap: marketCap > 0 ? pct(postFlow.inst + postFlow.foreign, marketCap) : null,
      },
    };
  } else {
    flowAnalysis = { dataLimit: '수급 데이터 없음', pre: null, run: null, post: null };
  }

  // 4) 상승 후 하락 전환 ─────────────────────────────
  const peakHigh = rows[peakHighIdx]?.high || w.peakHigh;
  let postAnalysis = null;
  if (postRows.length > 0) {
    const postSumValue = postRows.reduce((s, r) => s + (r.valueApprox || 0), 0);
    const postAvgValue = postSumValue / postRows.length;
    // 음봉 거래대금
    const downSumValue = postRows.reduce((s, r) => {
      const idx = rows.indexOf(r);
      const prev = rows[idx - 1];
      if (!prev) return s;
      return r.close < prev.close ? s + (r.valueApprox || 0) : s;
    }, 0);
    // 최저 종가
    const minClose = postRows.reduce((m, r) => Math.min(m, r.close), peakHigh);
    const minLow = postRows.reduce((m, r) => Math.min(m, r.low), peakHigh);
    postAnalysis = {
      days: postRows.length,
      avgValue: round(postAvgValue, 0),
      avgValueVsRun: runAvgValue > 0 ? round(postAvgValue / runAvgValue, 2) : null,    // 상승 중 대비
      downCandleValueRatio: postSumValue > 0 ? pct(downSumValue, postSumValue) : null,  // 음봉 거래대금 비율
      drawdownFromPeakClose: pct(peakHigh - minClose, peakHigh),                         // 고점 이후 종가 기준 하락률
      drawdownFromPeakLow: pct(peakHigh - minLow, peakHigh),                             // 고점 이후 저가 기준 하락률
      lastClosePosition: rows[postEnd - 1] ? round((rows[postEnd - 1].close - minLow) / Math.max(1, peakHigh - minLow), 2) : null,
    };
  }

  // 5) 이평선 위치 (상승 시작점 기준) ─────────────────────────────
  const startRow = rows[startIdx];
  const ma5  = sma(rows.slice(Math.max(0, startIdx - 4),   startIdx + 1), 5,  'close');
  const ma20 = sma(rows.slice(Math.max(0, startIdx - 19),  startIdx + 1), 20, 'close');
  const ma60 = sma(rows.slice(Math.max(0, startIdx - 59),  startIdx + 1), 60, 'close');
  const ma120 = sma(rows.slice(Math.max(0, startIdx - 119), startIdx + 1), 120, 'close');
  const movingAverage = {
    closeOverMa5: ma5 ? pct(startRow.close - ma5, ma5) : null,
    closeOverMa20: ma20 ? pct(startRow.close - ma20, ma20) : null,
    closeOverMa60: ma60 ? pct(startRow.close - ma60, ma60) : null,
    closeOverMa120: ma120 ? pct(startRow.close - ma120, ma120) : null,
    ma5OverMa20: (ma5 && ma20) ? pct(ma5 - ma20, ma20) : null,
    ma20OverMa60: (ma20 && ma60) ? pct(ma20 - ma60, ma60) : null,
    ma60OverMa120: (ma60 && ma120) ? pct(ma60 - ma120, ma120) : null,
    aboveMa20: ma20 ? startRow.close > ma20 : null,
    aboveMa60: ma60 ? startRow.close > ma60 : null,
    aboveMa120: ma120 ? startRow.close > ma120 : null,
    ma5: round(ma5, 0), ma20: round(ma20, 0), ma60: round(ma60, 0), ma120: round(ma120, 0),
    arrangement: classifyMaArrangement(startRow.close, ma5, ma20, ma60, ma120),
  };

  // 6) 매물대 (최근 SUPPLY_LOOKBACK일 가격대별 거래량) ─────────────────────────────
  const supplyZone = computeSupplyZone(supplyRows, startRow.close);

  // 7) 박스권 ─────────────────────────────
  const boxAnalysis = computeBoxRange(rows, startIdx);

  // 8) 가격 위치 ─────────────────────────────
  const last60 = rows.slice(Math.max(0, startIdx - 59), startIdx + 1);
  const last120 = rows.slice(Math.max(0, startIdx - 119), startIdx + 1);
  const last250 = rows.slice(Math.max(0, startIdx - 249), startIdx + 1);
  const low60 = Math.min(...last60.map(r => r.low));
  const high60 = Math.max(...last60.map(r => r.high));
  const low120 = Math.min(...last120.map(r => r.low));
  const high120 = Math.max(...last120.map(r => r.high));
  const high52w = last250.length > 0 ? Math.max(...last250.map(r => r.high)) : null;
  const pricePosition = {
    closeFromLow60: pct(startRow.close - low60, low60),
    closeFromLow120: pct(startRow.close - low120, low120),
    closeFromHigh60: pct(startRow.close - high60, high60),
    closeFromHigh120: pct(startRow.close - high120, high120),
    closeFrom52WeekHigh: high52w ? pct(startRow.close - high52w, high52w) : null,
    closeFromBoxLow: boxAnalysis.boxLow ? pct(startRow.close - boxAnalysis.boxLow, boxAnalysis.boxLow) : null,
    closeFromBoxHigh: boxAnalysis.boxHigh ? pct(startRow.close - boxAnalysis.boxHigh, boxAnalysis.boxHigh) : null,
  };

  return {
    preAccumulation,
    runAnalysis,
    flowAnalysis,
    postAnalysis,
    movingAverage,
    supplyZone,
    boxAnalysis,
    pricePosition,
  };
}

// 이평선 정렬 분류
function classifyMaArrangement(close, ma5, ma20, ma60, ma120) {
  if (!ma5 || !ma20 || !ma60 || !ma120) return 'INSUFFICIENT';
  const fullBull = close > ma5 && ma5 > ma20 && ma20 > ma60 && ma60 > ma120;
  const fullBear = close < ma5 && ma5 < ma20 && ma20 < ma60 && ma60 < ma120;
  if (fullBull) return 'FULL_BULL';
  if (fullBear) return 'FULL_BEAR';
  if (close > ma5 && ma5 > ma20 && ma20 < ma60) return 'SHORT_RECOVERY';   // 단기선만 회복
  if (close > ma5 && ma5 > ma20 && ma20 > ma60 && ma60 < ma120) return 'NEAR_BULL';
  if (close > ma20 && ma20 > ma60) return 'MID_BULL';
  return 'MIXED';
}

// 매물대 (가격 bin 거래량 누적)
function computeSupplyZone(supplyRows, currentClose) {
  if (supplyRows.length === 0) return { dataLimit: '데이터 없음' };
  const lows = supplyRows.map(r => r.low).filter(v => v > 0);
  const highs = supplyRows.map(r => r.high).filter(v => v > 0);
  if (lows.length === 0) return { dataLimit: '가격 데이터 없음' };
  const minPrice = Math.min(...lows);
  const maxPrice = Math.max(...highs);
  if (maxPrice <= minPrice) return { dataLimit: '가격 범위 없음' };

  const binCount = CONFIG.SUPPLY_BINS;
  const binSize = (maxPrice - minPrice) / binCount;
  const bins = new Array(binCount).fill(0);
  supplyRows.forEach(r => {
    const mid = (r.high + r.low) / 2;
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((mid - minPrice) / binSize)));
    bins[idx] += r.volume || 0;
  });
  const totalVol = bins.reduce((s, v) => s + v, 0);
  if (totalVol === 0) return { dataLimit: '거래량 없음' };

  // 현재가 위쪽 bin들 거래량 비율 (저항 매물대)
  let aboveVol = 0, belowVol = 0;
  bins.forEach((v, i) => {
    const binMid = minPrice + (i + 0.5) * binSize;
    if (binMid > currentClose) aboveVol += v;
    else belowVol += v;
  });

  // 가장 두꺼운 bin (peak supply zone)
  let peakBinIdx = 0, peakVol = 0;
  bins.forEach((v, i) => { if (v > peakVol) { peakVol = v; peakBinIdx = i; } });
  const peakBinPrice = minPrice + (peakBinIdx + 0.5) * binSize;

  return {
    minPrice: round(minPrice, 0),
    maxPrice: round(maxPrice, 0),
    binCount,
    aboveCloseRatio: pct(aboveVol, totalVol),       // 위쪽 매물 부담 (%)
    belowCloseRatio: pct(belowVol, totalVol),
    peakBinPrice: round(peakBinPrice, 0),
    peakBinPosition: peakBinPrice > currentClose ? 'ABOVE_CURRENT' : 'BELOW_CURRENT',
    peakBinVolumeRatio: pct(peakVol, totalVol),
  };
}

// 박스권 탐색 (상승 전 BOX_MIN~BOX_MAX일 범위에서 자동 탐색)
function computeBoxRange(rows, startIdx) {
  let best = null;
  for (let n = CONFIG.BOX_MIN_DAYS; n <= CONFIG.BOX_MAX_DAYS; n++) {
    const s = startIdx - n;
    if (s < 0) break;
    const slice = rows.slice(s, startIdx);
    const lows = slice.map(r => r.low).filter(v => v > 0);
    const highs = slice.map(r => r.high).filter(v => v > 0);
    if (lows.length === 0) continue;
    const lo = Math.min(...lows), hi = Math.max(...highs);
    if (lo <= 0) continue;
    const range = (hi - lo) / lo * 100;     // 박스 폭 %
    const score = -range;                    // 폭 좁을수록 좋은 박스
    if (!best || score > best.score) {
      best = { days: n, boxLow: lo, boxHigh: hi, rangePct: round(range, 2), score };
    }
  }
  if (!best) return { dataLimit: '데이터 없음' };

  const boxRows = rows.slice(startIdx - best.days, startIdx);
  // 박스권 안에서 거래대금 추세 (전반부 vs 후반부)
  const half = Math.floor(boxRows.length / 2);
  const firstHalf = boxRows.slice(0, half);
  const secondHalf = boxRows.slice(half);
  const firstAvgValue = firstHalf.length > 0 ? firstHalf.reduce((s, r) => s + (r.valueApprox || 0), 0) / firstHalf.length : 0;
  const secondAvgValue = secondHalf.length > 0 ? secondHalf.reduce((s, r) => s + (r.valueApprox || 0), 0) / secondHalf.length : 0;
  // 박스 상단 두드림 횟수 (boxHigh의 95% 이상 도달한 날)
  const touchedHigh = boxRows.filter(r => r.high >= best.boxHigh * 0.97).length;
  // 박스 하단 변화 (전반부 최저 vs 후반부 최저)
  const firstMinLow = firstHalf.length > 0 ? Math.min(...firstHalf.map(r => r.low)) : null;
  const secondMinLow = secondHalf.length > 0 ? Math.min(...secondHalf.map(r => r.low)) : null;
  const lowRising = firstMinLow != null && secondMinLow != null && secondMinLow > firstMinLow;

  // 돌파일 (startIdx) 거래대금
  const startDayValue = rows[startIdx].valueApprox || 0;
  const boxAvgValue = boxRows.length > 0 ? boxRows.reduce((s, r) => s + (r.valueApprox || 0), 0) / boxRows.length : 0;
  const breakoutValueRatio = boxAvgValue > 0 ? round(startDayValue / boxAvgValue, 2) : null;

  return {
    boxRangeDays: best.days,
    boxLow: round(best.boxLow, 0),
    boxHigh: round(best.boxHigh, 0),
    boxRangePct: best.rangePct,
    touchedHighTimes: touchedHigh,
    lowRising,
    valueTrendInBox: secondAvgValue > firstAvgValue * 1.2 ? 'INCREASING'
                  : secondAvgValue < firstAvgValue * 0.8 ? 'DECREASING'
                  : 'FLAT',
    breakoutValueRatio,                    // 돌파일 거래대금 / 박스권 평균
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Winner Scan Report');
  console.log(`목표 ${CONFIG.TARGET_RETURN_PCT}% (${CONFIG.WINDOW_DAYS}거래일 안), 상승 전 ${CONFIG.PRE_RUNUP_DAYS}일 분석`);
  console.log('═'.repeat(80));

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`\n차트 ${files.length}개 스캔 시작...`);

  const allWinners = [];
  let processed = 0, skipMeta = 0, skipExcl = 0, skipMc = 0, skipShort = 0;
  let scanStart = Date.now();

  files.forEach((file, idx) => {
    const code = file.replace('.json', '');
    const meta = stockMap[code];
    if (!meta) { skipMeta++; return; }
    if (isExcluded(meta.name) || meta.isSpecial || meta.isEtf) { skipExcl++; return; }
    const marketCap = meta.marketValue || 0;
    if (marketCap < CONFIG.MIN_MARKET_CAP) { skipMc++; return; }

    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8')); }
    catch (_) { return; }
    const rows = chart.rows || [];
    if (rows.length < CONFIG.MIN_HISTORY) { skipShort++; return; }

    let flowRows = null;
    try {
      const flowPath = path.join(FLOW_DIR, file);
      if (fs.existsSync(flowPath)) {
        const f = JSON.parse(fs.readFileSync(flowPath, 'utf-8'));
        flowRows = f.rows || null;
      }
    } catch (_) {}

    const winners = findWinners(rows);
    winners.forEach(w => {
      const analysis = analyzeWinner(rows, flowRows, marketCap, w);
      allWinners.push({
        code, name: meta.name, market: meta.market, marketCap,
        ...w,
        analysis,
      });
    });
    processed++;

    if ((idx + 1) % 500 === 0) {
      const e = (Date.now() - scanStart) / 1000;
      process.stdout.write(`\r${idx + 1}/${files.length} 사례=${allWinners.length} ${e.toFixed(0)}s`);
    }
  });
  const elapsed = (Date.now() - scanStart) / 1000;
  console.log(`\n스캔 완료: 처리 ${processed}, 사례 ${allWinners.length}, ${elapsed.toFixed(0)}초`);
  console.log(`스킵: meta=${skipMeta} excl=${skipExcl} mc=${skipMc} short=${skipShort}`);

  // 최대 상승률 내림차순 정렬
  allWinners.sort((a, b) => (b.maxHighReturn || 0) - (a.maxHighReturn || 0));

  // 요약 통계
  const summary = computeSummary(allWinners);

  // 콘솔 요약
  console.log('\n📊 발견 요약:');
  console.log(`  총 사례: ${summary.totalCount}건 (종목 ${summary.uniqueStockCount}개)`);
  console.log(`  평균 상승률(고가): ${summary.avgMaxHighReturn}%`);
  console.log(`  평균 상승률(종가): ${summary.avgMaxCloseReturn}%`);
  console.log(`  평균 +${CONFIG.TARGET_RETURN_PCT}% 도달 소요: ${summary.avgDaysToPeak}일`);
  console.log(`  평균 시총 대비 상승 전 들어온 돈: ${summary.avgPreAccumulationRatio}%`);
  console.log(`  평균 상승 시작일 거래대금 spike: ${summary.avgValueSpikeRatio}배`);
  console.log(`  평균 상승 전 박스권 기간: ${summary.avgBoxDays}일`);
  console.log(`  평균 박스권 폭: ${summary.avgBoxRangePct}%`);
  console.log(`  상승 시작점 정배열: ${summary.fullBullCount}건 / 단기선만 회복: ${summary.shortRecoveryCount}건`);

  console.log('\n🏆 상위 10건 (상승률 기준):');
  allWinners.slice(0, 10).forEach((w, i) => {
    console.log(`  ${(i+1).toString().padStart(2)}. ${w.name.padEnd(14)} ${w.code} | ${fmtDate(w.startDate)} → ${fmtDate(w.peakDate)} (${w.daysToPeak}일) | 고가 ${w.maxHighReturn}% / 종가 ${w.maxCloseReturn}%`);
  });

  // 출력
  const out = {
    meta: {
      version: 'bms-winner-scan-v1',
      generatedAt: new Date().toISOString(),
      title: `BMS 크게 오른 종목 발견 보고서 (${CONFIG.WINDOW_DAYS}거래일 +${CONFIG.TARGET_RETURN_PCT}%)`,
      purpose: '과거 일정 기간 안에 크게 오른 종목들을 자동 발견하고, 그 종목들이 오르기 전 어떤 거래대금·거래량·이평선·매물대·박스권·가격 위치 조건을 가졌는지 분석',
      dataLimit: '매수금액/매도금액 분리 데이터 없음. 순매수금액(외국인+기관)만 가용. 차트 데이터 약 120일.',
      executionSeconds: Math.round(elapsed),
    },
    config: CONFIG,
    summary,
    winners: allWinners,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length/1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length/1024).toFixed(0)}KB)`);
}

function computeSummary(winners) {
  if (winners.length === 0) return { totalCount: 0 };
  const uniqueStocks = new Set(winners.map(w => w.code));

  function avg(field) {
    const vals = winners.map(w => {
      const parts = field.split('.');
      let v = w;
      for (const p of parts) v = v?.[p];
      return v;
    }).filter(v => v != null && isFinite(v));
    return vals.length > 0 ? round(vals.reduce((s, v) => s + v, 0) / vals.length, 2) : null;
  }
  function median(field) {
    const vals = winners.map(w => {
      const parts = field.split('.');
      let v = w;
      for (const p of parts) v = v?.[p];
      return v;
    }).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    return vals.length > 0 ? round(vals[Math.floor(vals.length/2)], 2) : null;
  }
  function countWhere(field, predicate) {
    return winners.filter(w => {
      const parts = field.split('.');
      let v = w;
      for (const p of parts) v = v?.[p];
      return predicate(v);
    }).length;
  }

  return {
    totalCount: winners.length,
    uniqueStockCount: uniqueStocks.size,
    avgMaxHighReturn: avg('maxHighReturn'),
    medianMaxHighReturn: median('maxHighReturn'),
    avgMaxCloseReturn: avg('maxCloseReturn'),
    avgDaysToPeak: avg('daysToPeak'),
    avgPreAccumulationRatio: avg('analysis.preAccumulation.accumulatedValueRatio'),
    avgStartDayValueRatio: avg('analysis.preAccumulation.startDayValueRatio'),
    avgValueSpikeRatio: avg('analysis.preAccumulation.valueSpikeRatio'),
    avgRunAccumulationRatio: avg('analysis.runAnalysis.accumulatedValueRatio'),
    avgBoxDays: avg('analysis.boxAnalysis.boxRangeDays'),
    avgBoxRangePct: avg('analysis.boxAnalysis.boxRangePct'),
    avgBreakoutValueRatio: avg('analysis.boxAnalysis.breakoutValueRatio'),
    avgSupplyAboveRatio: avg('analysis.supplyZone.aboveCloseRatio'),
    avgCloseFromLow60: avg('analysis.pricePosition.closeFromLow60'),
    avgCloseFrom52WeekHigh: avg('analysis.pricePosition.closeFrom52WeekHigh'),
    avgDrawdownAfterPeak: avg('analysis.postAnalysis.drawdownFromPeakClose'),
    fullBullCount: countWhere('analysis.movingAverage.arrangement', v => v === 'FULL_BULL'),
    nearBullCount: countWhere('analysis.movingAverage.arrangement', v => v === 'NEAR_BULL'),
    shortRecoveryCount: countWhere('analysis.movingAverage.arrangement', v => v === 'SHORT_RECOVERY'),
    aboveMa20Count: countWhere('analysis.movingAverage.aboveMa20', v => v === true),
    aboveMa60Count: countWhere('analysis.movingAverage.aboveMa60', v => v === true),
    aboveMa120Count: countWhere('analysis.movingAverage.aboveMa120', v => v === true),
  };
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>BMS 크게 오른 종목 발견 보고서</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1400px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
  -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 14px 0 8px; color: #94a3b8; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

/* 용어 가이드 */
.glossary { background: #1e293b; border: 1px dashed #334155; border-radius: 8px; padding: 12px 16px; margin: 14px 0; font-size: 12px; line-height: 1.7; color: #cbd5e1; }
.glossary summary { cursor: pointer; color: #67e8f9; font-weight: 600; padding: 4px 0; }
.glossary[open] summary { margin-bottom: 8px; }
.glossary dt { color: #fbbf24; font-weight: 600; margin-top: 8px; }
.glossary dd { margin: 4px 0 0 0; padding-left: 0; color: #94a3b8; }

/* summary tiles */
.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 18px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-top: 3px; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; line-height: 1.4; }
.big-tile.primary { border-color: #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }

/* 표 */
.tbl-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.list { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
table.list thead th {
  background: #0f172a; color: #94a3b8; font-weight: 600; text-align: left;
  padding: 10px 12px; border-bottom: 1px solid #334155; white-space: nowrap;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px;
}
table.list thead th.numeric { text-align: right; }
table.list tbody tr.row { border-bottom: 1px solid #1e293b; cursor: pointer; }
table.list tbody tr.row:hover { background: #273549; }
table.list tbody tr.row.expanded { background: #1e3a5f; }
table.list tbody tr.row td { padding: 9px 12px; vertical-align: middle; line-height: 1.3; white-space: nowrap; }
table.list tbody tr.row td.numeric { text-align: right; }
table.list tbody tr.row td.col-name { font-weight: 600; color: #f1f5f9; min-width: 130px; }
table.list tbody tr.row td.col-name .meta { display: block; font-size: 10px; color: #64748b; font-weight: 400; margin-top: 2px; }
table.list tbody tr.row:nth-child(odd) { background: #1c2942; }
table.list tbody tr.row:nth-child(odd):hover { background: #273549; }
table.list tbody tr.row.expanded, table.list tbody tr.row.expanded:nth-child(odd) { background: #1e3a5f; }

.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-warn { color: #fde047; }
.cell-good { color: #93c5fd; }

table.list tbody tr.detail { display: none; background: #0c1729; }
table.list tbody tr.detail.show { display: table-row; }
table.list tbody tr.detail td { padding: 14px 18px; border-bottom: 1px solid #1e3a5f; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 24px; font-size: 12px; }
.detail-block h4 { margin: 0 0 6px; font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.detail-block p { margin: 0 0 4px; color: #cbd5e1; line-height: 1.6; }
.detail-block code { background: #1e293b; padding: 1px 5px; border-radius: 3px; color: #67e8f9; font-size: 11px; }
.detail-block .desc-line { color: #94a3b8; font-size: 11px; margin-top: 6px; line-height: 1.5; font-style: italic; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; line-height: 1.6; }
.kv .k { color: #64748b; }
.kv .v { color: #cbd5e1; font-variant-numeric: tabular-nums; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .tbl-wrap { overflow-x: auto !important; }
  /* 모바일에서는 일부 컬럼 숨김으로 헤더-셀 정렬 유지 */
  .col-mobile-hide,
  table.list thead th.col-mobile-hide { display: none; }
  .detail-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<h1 id="page-title">BMS 크게 오른 종목 발견 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>

<div class="warn-banner">
  ⚠️ <strong>매수 신호가 아닙니다.</strong> 과거에 크게 오른 종목들의 출발선 모습을 분석하는 보고서입니다.
  나중에 현재 종목 중 비슷한 모습의 종목을 찾는 단계는 별도 파일에서 합니다.
</div>

<details class="glossary" open>
  <summary>📖 용어 가이드 — 화면 표시 용어 풀이 (펼침/접기)</summary>
  <dl>
    <dt>크게 오른 종목 (winner)</dt>
    <dd>설정된 기간(기본 15거래일) 안에 +40% 이상 오른 종목입니다. 프로그램이 시장 전체에서 자동으로 찾습니다.</dd>
    <dt>상승 시작점 (startPoint)</dt>
    <dd>+40% 도달 직전의 출발 종가일입니다. 모든 분석은 이 시점을 기준으로 이뤄집니다.</dd>
    <dt>상승 전 들어온 거래대금 (accumulatedValue)</dt>
    <dd>상승 시작 직전 20거래일 동안 누적된 거래대금입니다. 시장 관심이 미리 모이는지 확인합니다.</dd>
    <dt>시총 대비 들어온 돈 (accumulatedValueRatio)</dt>
    <dd>해당 종목 시가총액 대비 위 거래대금 비율입니다. 예: 시총 3,000억에 900억 들어왔으면 30%.</dd>
    <dt>평소보다 거래가 늘어난 정도 (valueSpikeRatio)</dt>
    <dd>상승 시작일 거래대금이 직전 평균 대비 몇 배인지입니다. 큰 자금 유입 직후 상승이 흔합니다.</dd>
    <dt>상승 전 박스권 기간 (boxRangeDays)</dt>
    <dd>상승 직전 좁은 범위에서 횡보한 기간입니다. 좁고 길수록 힘이 모인 모양으로 볼 수 있습니다.</dd>
    <dt>박스권 폭 (boxRangePct)</dt>
    <dd>박스권 동안 최저~최고가 차이의 % 폭. 좁을수록 응축된 상태입니다.</dd>
    <dt>돌파일 거래대금 배수 (breakoutValueRatio)</dt>
    <dd>상승 시작일 거래대금이 박스권 평균의 몇 배였는지입니다. 클수록 돌파 강도가 큽니다.</dd>
    <dt>위쪽 매물 부담 (supplyZoneAbove)</dt>
    <dd>최근 120거래일을 24개 가격 구간으로 나눠 거래량을 합산했을 때, 현재가 위쪽에 누적된 거래량 비율입니다. 클수록 저항 매물이 무겁다는 뜻.</dd>
    <dt>이평선 위치 (movingAverage)</dt>
    <dd>상승 시작점 종가가 5/20/60/120일 이동평균선보다 위인지 아래인지입니다. 정배열·역배열·단기선 회복 같은 패턴 분류 포함.</dd>
    <dt>가격 위치</dt>
    <dd>최근 60일 저점·고점·52주 고점 대비 상승 시작점이 어디였는지입니다. 너무 많이 오른 뒤가 아니라 저점 부근에서 시작했는지 확인.</dd>
    <dt>고점 이후 하락률 (drawdownAfterPeak)</dt>
    <dd>+40% 도달 이후 추적 기간 동안 고점에서 얼마나 빠졌는지입니다. 상승 종목이 어떻게 식는지 패턴 파악.</dd>
  </dl>
</details>

<h2>📊 발견 요약</h2>
<div class="big-summary" id="big-summary"></div>

<h3>이평선 정렬 분포 (상승 시작점 기준)</h3>
<div id="ma-distribution"></div>

<h2>🏆 크게 오른 종목 리스트</h2>
<p style="color:#94a3b8;font-size:12px;line-height:1.6;">행을 클릭하면 그 종목의 상세 분석 (상승 전 / 상승 중 / 상승 후 / 매물대 / 박스권 / 이평선 / 가격 위치 / 수급)이 펼쳐집니다.</p>
<div class="tbl-wrap">
  <table class="list">
    <thead>
      <tr>
        <th>종목</th>
        <th class="numeric">상승률 (고가)</th>
        <th class="numeric">소요 일수</th>
        <th class="col-mobile-hide">상승 시작일</th>
        <th class="col-mobile-hide">정점일</th>
        <th class="numeric col-mobile-hide">시총</th>
        <th class="numeric">시총 대비 들어온 돈</th>
        <th class="numeric">상승 시작일 spike</th>
        <th class="numeric col-mobile-hide">박스권 기간</th>
        <th class="col-mobile-hide">이평선 정렬</th>
        <th class="numeric col-mobile-hide">위쪽 매물 부담</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<footer class="foot">
  <strong>매수 신호가 아닙니다.</strong> BMS Winner Scan은 <em>과거에 크게 오른 종목의 출발선 조건</em>을 정량적으로 정리한 분석 보고서입니다.
  현재 종목 중 비슷한 모습의 종목을 찾는 작업은 별도 파일(bms-current-similarity-scan.js, 미작성)에서 진행합니다.
  <br><br>
  <small style="color:#64748b;">
    데이터 한계: 매수금액/매도금액 분리 데이터는 현재 캐시에 없으며 순매수금액(외국인+기관)만 가용합니다.
    차트 약 120일 보유 → 그 이전의 매물대/박스권은 분석 불가.
  </small>
</footer>

<script id="report-data" type="application/json">__JSON_DATA__</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const meta = data.meta || {};
  const cfg = data.config || {};
  const summary = data.summary || {};
  const winners = data.winners || [];

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 1 : d); }
  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtMc(v) { if (!v) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; return Math.round(e) + '억'; }
  function fmtValue(v) { if (!v || !isFinite(v)) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; if (e >= 1) return e.toFixed(0) + '억'; return Math.round(v / 1e6) + '백만'; }
  function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d || '-'); }

  document.getElementById('subtitle').innerHTML =
    '<strong style="color:#cbd5e1;">' + cfg.WINDOW_DAYS + '거래일 안에 +' + cfg.TARGET_RETURN_PCT + '%</strong> 상승한 종목 ' +
    '<strong>' + summary.totalCount + '</strong>건 (종목 <strong>' + summary.uniqueStockCount + '</strong>개) · ' +
    '생성 ' + new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.purpose) +
    '<br><br><strong>⚠️ 데이터 한계:</strong> ' + escapeHtml(meta.dataLimit);

  // big tiles
  const tiles = [
    { label: '발견된 사례', value: summary.totalCount + '건', sub: '종목 ' + summary.uniqueStockCount + '개 (중복 가능)', cls: 'primary' },
    { label: '평균 상승률 (고가)', value: fmtPct(summary.avgMaxHighReturn), sub: '중앙값 ' + fmtPct(summary.medianMaxHighReturn), cls: '' },
    { label: '평균 +' + cfg.TARGET_RETURN_PCT + '% 도달 소요', value: fmtNum(summary.avgDaysToPeak, 1) + '거래일', sub: '관찰창 ' + cfg.WINDOW_DAYS + '일 중', cls: '' },
    { label: '평균 시총 대비 들어온 돈', value: fmtPct(summary.avgPreAccumulationRatio), sub: '상승 전 ' + cfg.PRE_RUNUP_DAYS + '일 누적', cls: '' },
    { label: '평균 거래대금 spike', value: fmtNum(summary.avgValueSpikeRatio) + '×', sub: '상승 시작일 / 평소 평균', cls: '' },
    { label: '평균 박스권 기간', value: fmtNum(summary.avgBoxDays, 1) + '일', sub: '폭 평균 ' + fmtNum(summary.avgBoxRangePct, 1) + '%', cls: '' },
    { label: '돌파일 거래대금 배수', value: fmtNum(summary.avgBreakoutValueRatio) + '×', sub: '박스 평균 대비', cls: '' },
    { label: '평균 위쪽 매물 부담', value: fmtPct(summary.avgSupplyAboveRatio), sub: '120일 거래량 분포 기준', cls: '' },
  ];
  const ts = document.getElementById('big-summary');
  tiles.forEach(t => {
    const el = document.createElement('div');
    el.className = 'big-tile ' + (t.cls || '');
    el.innerHTML = '<div class="label">' + t.label + '</div><div class="value">' + t.value + '</div><div class="sub">' + t.sub + '</div>';
    ts.appendChild(el);
  });

  // 이평선 정렬 분포
  let mdHtml = '<div class="kv">' +
    '<div class="k">정배열 (FULL_BULL)</div><div class="v">' + summary.fullBullCount + '건 (' + (summary.totalCount > 0 ? (summary.fullBullCount / summary.totalCount * 100).toFixed(1) : '0') + '%)</div>' +
    '<div class="k">정배열 직전 (NEAR_BULL)</div><div class="v">' + summary.nearBullCount + '건</div>' +
    '<div class="k">단기선만 회복 (SHORT_RECOVERY)</div><div class="v">' + summary.shortRecoveryCount + '건</div>' +
    '<div class="k">상승 시작점이 20일선 위</div><div class="v">' + summary.aboveMa20Count + '/' + summary.totalCount + '건</div>' +
    '<div class="k">상승 시작점이 60일선 위</div><div class="v">' + summary.aboveMa60Count + '/' + summary.totalCount + '건</div>' +
    '<div class="k">상승 시작점이 120일선 위</div><div class="v">' + summary.aboveMa120Count + '/' + summary.totalCount + '건</div>' +
    '</div>';
  document.getElementById('ma-distribution').innerHTML = mdHtml;

  // 종목 리스트
  const tbody = document.getElementById('list-body');
  winners.forEach((w, i) => {
    const a = w.analysis || {};
    const tr = document.createElement('tr');
    tr.className = 'row';
    tr.innerHTML =
      '<td class="col-name">' + escapeHtml(w.name) + '<span class="meta">' + w.code + ' · ' + (w.market || '-') + '</span></td>' +
      '<td class="numeric cell-pos" style="font-weight:700;">' + fmtPct(w.maxHighReturn) + '</td>' +
      '<td class="numeric">' + w.daysToPeak + '일</td>' +
      '<td class="col-mobile-hide">' + fmtDate(w.startDate) + '</td>' +
      '<td class="col-mobile-hide">' + fmtDate(w.peakDate) + '</td>' +
      '<td class="numeric col-mobile-hide">' + fmtMc(w.marketCap) + '</td>' +
      '<td class="numeric">' + fmtPct(a.preAccumulation?.accumulatedValueRatio) + '</td>' +
      '<td class="numeric">' + (a.preAccumulation?.valueSpikeRatio != null ? fmtNum(a.preAccumulation.valueSpikeRatio) + '×' : '-') + '</td>' +
      '<td class="numeric col-mobile-hide">' + (a.boxAnalysis?.boxRangeDays || '-') + '일</td>' +
      '<td class="col-mobile-hide">' + (a.movingAverage?.arrangement || '-') + '</td>' +
      '<td class="numeric col-mobile-hide">' + fmtPct(a.supplyZone?.aboveCloseRatio) + '</td>';

    const trd = document.createElement('tr');
    trd.className = 'detail';
    trd.innerHTML = '<td colspan="11">' + buildDetailHtml(w) + '</td>';

    tr.addEventListener('click', () => {
      tr.classList.toggle('expanded');
      trd.classList.toggle('show');
    });
    tbody.appendChild(tr);
    tbody.appendChild(trd);
  });

  function buildDetailHtml(w) {
    const a = w.analysis || {};
    const pa = a.preAccumulation || {};
    const ra = a.runAnalysis || {};
    const fa = a.flowAnalysis || {};
    const post = a.postAnalysis || {};
    const ma = a.movingAverage || {};
    const sz = a.supplyZone || {};
    const ba = a.boxAnalysis || {};
    const pp = a.pricePosition || {};

    return '<div class="detail-grid">' +
      '<div class="detail-block">' +
        '<h4>1️⃣ 상승 전 거래대금 (preRunupWindow ' + cfg.PRE_RUNUP_DAYS + '일)</h4>' +
        '<div class="kv">' +
          '<div class="k">시총 대비 들어온 돈</div><div class="v">' + fmtPct(pa.accumulatedValueRatio) + '</div>' +
          '<div class="k">상승 시작일 거래대금/시총</div><div class="v">' + fmtPct(pa.startDayValueRatio) + '</div>' +
          '<div class="k">평소보다 거래가 늘어난 정도</div><div class="v">' + (pa.valueSpikeRatio != null ? fmtNum(pa.valueSpikeRatio) + '×' : '-') + '</div>' +
          '<div class="k">상승 전 평균 거래대금</div><div class="v">' + fmtValue(pa.avgPreValue) + '</div>' +
          '<div class="k">상승 시작일 거래대금</div><div class="v">' + fmtValue(pa.startDayValue) + '</div>' +
        '</div>' +
        '<p class="desc-line">시총 대비 들어온 돈이 클수록 상승 직전 자금이 많이 들어왔다는 뜻입니다.</p>' +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>2️⃣ 상승 중 거래대금 / 거래량</h4>' +
        '<div class="kv">' +
          '<div class="k">상승 기간</div><div class="v">' + (ra.days || '-') + '거래일</div>' +
          '<div class="k">누적 거래대금</div><div class="v">' + fmtValue(ra.accumulatedValue) + '</div>' +
          '<div class="k">시총 대비</div><div class="v">' + fmtPct(ra.accumulatedValueRatio) + '</div>' +
          '<div class="k">최대 거래대금</div><div class="v">' + fmtValue(ra.maxValue) + '</div>' +
          '<div class="k">평소 대비 평균 spike</div><div class="v">' + (ra.spikeAvgRatio != null ? fmtNum(ra.spikeAvgRatio) + '×' : '-') + '</div>' +
          '<div class="k">거래가 크게 늘어난 날</div><div class="v">' + (ra.spikeDays || 0) + '/' + (ra.days || '-') + '일 (' + fmtPct(ra.spikeDaysRatio) + ')</div>' +
        '</div>' +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>3️⃣ 매수 / 매도 (수급)</h4>' +
        '<p class="desc-line" style="color:#fbbf24;">' + escapeHtml(fa.dataLimit || '데이터 없음') + '</p>' +
        (fa.pre ? (
          '<div class="kv">' +
          '<div class="k">상승 전 순매수</div><div class="v">' + fmtValue(fa.pre.totalNetValue) + ' (시총 대비 ' + fmtPct(fa.pre.netValueToCap) + ')</div>' +
          '<div class="k">상승 중 순매수</div><div class="v">' + fmtValue(fa.run.totalNetValue) + ' (시총 대비 ' + fmtPct(fa.run.netValueToCap) + ')</div>' +
          '<div class="k">상승 후 순매수</div><div class="v">' + fmtValue(fa.post.totalNetValue) + ' (시총 대비 ' + fmtPct(fa.post.netValueToCap) + ')</div>' +
          '</div>'
        ) : '<p>매수금액·매도금액 데이터 없음</p>') +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>4️⃣ 상승 후 하락 전환 (peak 이후 ' + cfg.POST_PEAK_DAYS + '일)</h4>' +
        (post.days ? (
          '<div class="kv">' +
          '<div class="k">고점 이후 평균 거래대금</div><div class="v">' + fmtValue(post.avgValue) + '</div>' +
          '<div class="k">상승 중 평균 대비</div><div class="v">' + (post.avgValueVsRun != null ? fmtNum(post.avgValueVsRun) + '×' : '-') + '</div>' +
          '<div class="k">음봉 거래대금 비율</div><div class="v">' + fmtPct(post.downCandleValueRatio) + '</div>' +
          '<div class="k">고점 이후 종가 기준 하락률</div><div class="v cell-neg">' + fmtPct(post.drawdownFromPeakClose) + '</div>' +
          '<div class="k">고점 이후 저가 기준 하락률</div><div class="v cell-neg">' + fmtPct(post.drawdownFromPeakLow) + '</div>' +
          '<div class="k">마지막 종가 위치</div><div class="v">' + (post.lastClosePosition != null ? fmtNum(post.lastClosePosition, 2) : '-') + '</div>' +
          '</div>'
        ) : '<p>고점 이후 추적 데이터 부족</p>') +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>5️⃣ 이평선 위치 (상승 시작점 기준)</h4>' +
        '<div class="kv">' +
          '<div class="k">정렬 분류</div><div class="v cell-good">' + (ma.arrangement || '-') + '</div>' +
          '<div class="k">종가 vs 5일선</div><div class="v">' + fmtPct(ma.closeOverMa5) + '</div>' +
          '<div class="k">종가 vs 20일선</div><div class="v">' + fmtPct(ma.closeOverMa20) + '</div>' +
          '<div class="k">종가 vs 60일선</div><div class="v">' + fmtPct(ma.closeOverMa60) + '</div>' +
          '<div class="k">종가 vs 120일선</div><div class="v">' + fmtPct(ma.closeOverMa120) + '</div>' +
          '<div class="k">5일선 vs 20일선</div><div class="v">' + fmtPct(ma.ma5OverMa20) + '</div>' +
          '<div class="k">20일선 vs 60일선</div><div class="v">' + fmtPct(ma.ma20OverMa60) + '</div>' +
          '<div class="k">60일선 vs 120일선</div><div class="v">' + fmtPct(ma.ma60OverMa120) + '</div>' +
        '</div>' +
        '<p class="desc-line">FULL_BULL=정배열 / NEAR_BULL=정배열 직전 / SHORT_RECOVERY=단기선만 먼저 회복.</p>' +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>6️⃣ 위쪽 매물 부담 (최근 120일 가격대 거래량)</h4>' +
        (sz.dataLimit ? '<p class="desc-line">' + escapeHtml(sz.dataLimit) + '</p>' : (
          '<div class="kv">' +
          '<div class="k">현재가 위쪽 매물 비율</div><div class="v">' + fmtPct(sz.aboveCloseRatio) + '</div>' +
          '<div class="k">현재가 아래쪽 매물 비율</div><div class="v">' + fmtPct(sz.belowCloseRatio) + '</div>' +
          '<div class="k">가장 두꺼운 매물대 가격</div><div class="v">' + (sz.peakBinPrice != null ? sz.peakBinPrice.toLocaleString() + '원' : '-') + '</div>' +
          '<div class="k">그 매물대 비중</div><div class="v">' + fmtPct(sz.peakBinVolumeRatio) + '</div>' +
          '<div class="k">매물대 위치</div><div class="v">' + (sz.peakBinPosition === 'ABOVE_CURRENT' ? '현재가 위쪽 (저항)' : '현재가 아래쪽 (지지)') + '</div>' +
          '</div>'
        )) +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>7️⃣ 박스권 (상승 전 횡보)</h4>' +
        (ba.dataLimit ? '<p class="desc-line">' + escapeHtml(ba.dataLimit) + '</p>' : (
          '<div class="kv">' +
          '<div class="k">박스권 기간</div><div class="v">' + (ba.boxRangeDays || '-') + '거래일</div>' +
          '<div class="k">박스 폭</div><div class="v">' + fmtNum(ba.boxRangePct) + '%</div>' +
          '<div class="k">박스 하단 가격</div><div class="v">' + (ba.boxLow != null ? ba.boxLow.toLocaleString() + '원' : '-') + '</div>' +
          '<div class="k">박스 상단 가격</div><div class="v">' + (ba.boxHigh != null ? ba.boxHigh.toLocaleString() + '원' : '-') + '</div>' +
          '<div class="k">상단 두드린 횟수</div><div class="v">' + ba.touchedHighTimes + '회</div>' +
          '<div class="k">박스 하단이 올라갔나</div><div class="v">' + (ba.lowRising ? '예' : '아니오') + '</div>' +
          '<div class="k">박스 안 거래대금 추세</div><div class="v">' + (ba.valueTrendInBox || '-') + '</div>' +
          '<div class="k">돌파일 거래대금 배수</div><div class="v">' + (ba.breakoutValueRatio != null ? fmtNum(ba.breakoutValueRatio) + '× (박스 평균 대비)' : '-') + '</div>' +
          '</div>'
        )) +
      '</div>' +

      '<div class="detail-block">' +
        '<h4>8️⃣ 가격 위치 (상승 시작점)</h4>' +
        '<div class="kv">' +
          '<div class="k">최근 60일 저점 대비</div><div class="v">' + fmtPct(pp.closeFromLow60) + ' 위</div>' +
          '<div class="k">최근 120일 저점 대비</div><div class="v">' + fmtPct(pp.closeFromLow120) + ' 위</div>' +
          '<div class="k">최근 60일 고점 대비</div><div class="v">' + fmtPct(pp.closeFromHigh60) + '</div>' +
          '<div class="k">최근 120일 고점 대비</div><div class="v">' + fmtPct(pp.closeFromHigh120) + '</div>' +
          '<div class="k">52주 고점 대비</div><div class="v">' + fmtPct(pp.closeFrom52WeekHigh) + '</div>' +
          '<div class="k">박스 하단 대비</div><div class="v">' + fmtPct(pp.closeFromBoxLow) + '</div>' +
          '<div class="k">박스 상단 대비</div><div class="v">' + fmtPct(pp.closeFromBoxHigh) + '</div>' +
        '</div>' +
      '</div>' +

      '</div>';
  }
})();
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main, findWinners, analyzeWinner };
