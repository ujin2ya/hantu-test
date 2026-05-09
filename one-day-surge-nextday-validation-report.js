#!/usr/bin/env node
/**
 * 1-Day Surge Board — HIT10 연구 보고서 v3 (시초가 기준 + 갭 + QVA 교차)
 *
 * v3 추가 (이번 단계):
 *   1. 다음날 "시초가 기준" 성과 — openHit3/5/10, openFailMinus3/5, nextCloseFromOpenRate
 *      → "전일 종가 기준 HIT10이 좋아도 시초가 진입자에게 먹을 자리가 있었나?"
 *   2. 다음날 시초가 갭 구간별 cross-tab — gapRate = nextOpenRate
 *      → "갭 몇 % 이상이면 장초 추격 위험이 커지나?"
 *   3. QVA 선행 신호 교차분석
 *      - pattern-screener.calculateQuietVolumeAnomaly로 baseDate 이전 [D-1, D-20] 안의 QVA 통과 인덱스를 코드별로 미리 계산
 *      - HIT10 vs NON_HIT10 의 QVA 이력 비율 비교
 *      - QVA 선행 간격 D-1~3 / D-4~7 / D-8~14 / D-15~20 / 없음 cross-tab
 *      - S후보 × QVA / R후보 × QVA
 *      - HIT10 + QVA 상위 100 종목 리스트
 *   4. 자동 결론 — 상따 vs 장초 확인 framing + QVA 운영 권고 + 향후 보드 문구 제안
 *
 * 중요:
 *   - 새 파일 / 새 라우터 만들지 않음
 *   - 기존 reports/one-day-surge-nextday-validation-result.{json,html} 덮어쓰기
 *   - 기존 라우트 /one-day-surge-validation 그대로 사용
 *   - one-day-surge-board.js 와 점수식은 수정하지 않음
 *   - 외부 HTTP 없음, 로컬 캐시 + core + pattern-screener 만 사용
 */

const fs = require('fs');
const path = require('path');
const core = require('./one-day-surge-core');
const pscore = require('./pattern-screener'); // QVA 함수 재사용

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');
const STOCKS_PATH = path.join(ROOT, 'stocks.json');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-nextday-validation-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-nextday-validation-result.html');

const VALIDATION_DAYS = Number(process.env.VALIDATION_DAYS || 60);
const VALIDATION_MAX_STOCKS = Number(process.env.VALIDATION_MAX_STOCKS || 0);

const N_RELIABLE = 50;
const N_REFERENCE = 30;
const TOP_RULE_KEEP = 50;

const QVA_LOOKBACK = 20; // baseDate 이전 N거래일 안 QVA 스캔

// ─── 60일 baseline 스냅샷 (이전 v3 60거래일 검증 결과) ───
// 다른 windowDays로 돌렸을 때 핵심 결론이 유지되는지 비교하는 기준점.
// 한 번 박아두면 매번 같은 baseline에 대해 검증 가능. 60거래일 자체로 다시 돌리면 모두 일치해야 함.
const BASELINE_60D = {
  windowDays: 60,
  T1_E: { count: 456, hit10Rate: 61.8, openHit5Rate: 58.1, openFail5Rate: 67.8, avgNextCloseFromOpen: -1.47 },
  gap_3_7:   { count: 820, hit10Rate: 36.2, openHit5Rate: 38.7, openFail5Rate: 52.7, avgNextCloseFromOpen: -1.08, avgNextLowFromOpen: -6.04 },
  gap_7_12:  { count: 233, hit10Rate: 79.8, openHit5Rate: 55.4, openFail5Rate: 67.0, avgNextCloseFromOpen: -1.78, avgNextLowFromOpen: -8.54 },
  gap_12_20: { count: 144, hit10Rate: 100.0, openHit5Rate: 56.3, openFail5Rate: 81.9, avgNextCloseFromOpen: -3.33, avgNextLowFromOpen: -10.58 },
  gap_20p:   { count: 49,  hit10Rate: 100.0, openHit5Rate: 20.4, openFail5Rate: 71.4, avgNextCloseFromOpen: -4.49, avgNextLowFromOpen: -11.42 },
  qvaWith:    { count: 598,  hit10Rate: 20.6, failCloseRate: 27.8, failLowPlungeRate: 29.6, openHit5Rate: null, openFail5Rate: null },
  qvaNo:      { count: 6826, hit10Rate: 17.4, failCloseRate: 25.9, failLowPlungeRate: 29.5, openHit5Rate: null, openFail5Rate: null },
  qvaGap_1_3:   { count: 135, hit10Rate: 17.0 },
  qvaGap_4_7:   { count: 118, hit10Rate: 19.5 },
  qvaGap_8_14:  { count: 186, hit10Rate: 17.7 },
  qvaGap_15_20: { count: 159, hit10Rate: 27.7 },
  sQvaWith:   { count: 11,  hit10Rate: 81.8, failCloseRate: 9.1,  failLowPlungeRate: 18.2, openHit5Rate: 54.5, openFail5Rate: 45.5 },
  sQvaNo:     { count: 50,  hit10Rate: 60.0, failCloseRate: 18.0, failLowPlungeRate: 38.0, openHit5Rate: 58.0, openFail5Rate: 58.0 },
  rQvaWith:   { count: 9,   hit10Rate: 88.9, failCloseRate: 44.4, failLowPlungeRate: 44.4, openHit5Rate: 88.9, openFail5Rate: 55.6 },
  rQvaNo:     { count: 100, hit10Rate: 71.0, failCloseRate: 32.0, failLowPlungeRate: 53.0, openHit5Rate: 68.0, openFail5Rate: 70.0 },
};

// 비교 항목 정의 (사용자 spec 7번)
const COMPARE_SPEC = [
  { sec: 'T1_E 상한가형', key: 'T1_E.count',                metric: 'n',                fmt: 'int', concern: null },
  { sec: 'T1_E 상한가형', key: 'T1_E.hit10Rate',            metric: '전일종가 HIT10',    fmt: 'pct', concern: null },
  { sec: 'T1_E 상한가형', key: 'T1_E.openHit5Rate',         metric: 'openHit5',         fmt: 'pct', concern: null },
  { sec: 'T1_E 상한가형', key: 'T1_E.openFail5Rate',        metric: 'openFail-5%',      fmt: 'pct', concern: 'high_is_bad' },
  { sec: 'T1_E 상한가형', key: 'T1_E.avgNextCloseFromOpen', metric: '시초→종가 평균',    fmt: 'pct', concern: 'low_is_bad' },
  { sec: '갭 7~12%',      key: 'gap_7_12.openFail5Rate',    metric: 'openFail-5%',      fmt: 'pct', concern: 'high_is_bad' },
  { sec: '갭 7~12%',      key: 'gap_7_12.avgNextCloseFromOpen', metric: '시초→종가 평균', fmt: 'pct', concern: 'low_is_bad' },
  { sec: '갭 12~20%',     key: 'gap_12_20.openFail5Rate',   metric: 'openFail-5%',      fmt: 'pct', concern: 'high_is_bad' },
  { sec: '갭 12~20%',     key: 'gap_12_20.avgNextCloseFromOpen', metric: '시초→종가 평균', fmt: 'pct', concern: 'low_is_bad' },
  { sec: 'QVA 있음',       key: 'qvaWith.hit10Rate',        metric: 'HIT10',            fmt: 'pct', concern: null },
  { sec: 'QVA 있음',       key: 'qvaWith.failCloseRate',    metric: '실패 종가',         fmt: 'pct', concern: 'high_is_bad' },
  { sec: 'QVA 있음',       key: 'qvaWith.failLowPlungeRate',metric: '실패 저가',         fmt: 'pct', concern: 'high_is_bad' },
  { sec: 'QVA 선행',       key: 'qvaGap_15_20.hit10Rate',   metric: 'D-15~D-20 HIT10',  fmt: 'pct', concern: null },
  { sec: 'S + QVA 있음',   key: 'sQvaWith.count',           metric: 'n (표본)',         fmt: 'int', concern: null },
  { sec: 'S + QVA 있음',   key: 'sQvaWith.hit10Rate',       metric: 'HIT10',            fmt: 'pct', concern: null },
  { sec: 'S + QVA 있음',   key: 'sQvaWith.failCloseRate',   metric: '실패 종가',         fmt: 'pct', concern: 'high_is_bad' },
  { sec: 'S + QVA 있음',   key: 'sQvaWith.failLowPlungeRate', metric: '실패 저가',       fmt: 'pct', concern: 'high_is_bad' },
  { sec: 'S + QVA 없음',   key: 'sQvaNo.hit10Rate',         metric: 'HIT10',            fmt: 'pct', concern: null },
  { sec: 'S + QVA 없음',   key: 'sQvaNo.failCloseRate',     metric: '실패 종가',         fmt: 'pct', concern: 'high_is_bad' },
  { sec: 'R + QVA 있음',   key: 'rQvaWith.openFail5Rate',   metric: 'openFail-5%',      fmt: 'pct', concern: 'high_is_bad' },
  { sec: 'R + QVA 없음',   key: 'rQvaNo.openFail5Rate',     metric: 'openFail-5%',      fmt: 'pct', concern: 'high_is_bad' },
];

function getByPath(obj, p) {
  const parts = p.split('.');
  let v = obj;
  for (const k of parts) { if (v == null) return null; v = v[k]; }
  return v;
}

function judgeHold(curVal, baseVal, fmt) {
  if (curVal == null || baseVal == null || !Number.isFinite(curVal) || !Number.isFinite(baseVal)) return { verdict: '데이터 없음', cls: 'na' };
  const delta = curVal - baseVal;
  const abs = Math.abs(delta);
  if (fmt === 'pct') {
    if (abs < 3) return { verdict: '유지', cls: 'hold' };
    if (abs < 8) return { verdict: '소폭 변화', cls: 'minor' };
    if (abs < 15) return { verdict: '중간 변동', cls: 'change' };
    return { verdict: '큰 변화', cls: 'major' };
  }
  if (fmt === 'int') {
    if (baseVal === 0) return { verdict: '비교 불가', cls: 'na' };
    const ratio = abs / baseVal;
    if (ratio < 0.15) return { verdict: '유지', cls: 'hold' };
    if (ratio < 0.5) return { verdict: '변동', cls: 'change' };
    return { verdict: '큰 변화', cls: 'major' };
  }
  return { verdict: '-', cls: 'na' };
}

function extractComparisonSnapshot(out) {
  const ncByKey = Object.fromEntries(out.namedConditions.map(c => [c.key, c]));
  const t1e = out.type1Subtypes.T1_E_LIMIT_UP_STYLE || {};
  const gapByLabel = Object.fromEntries(out.gapTab.map(g => [g.label, g]));
  const qvaWith = (out.qvaPresenceTab || [])[0] || {};
  const qvaNo = (out.qvaPresenceTab || [])[1] || {};
  const qvaGapByLabel = Object.fromEntries((out.qvaGapTab || []).map(g => [g.label, g]));
  const find = (arr, lab) => (arr || []).find(x => x.label === lab) || {};
  return {
    T1_E: t1e,
    gap_3_7:   gapByLabel['3~7%']     || {},
    gap_7_12:  gapByLabel['7~12%']    || {},
    gap_12_20: gapByLabel['12~20%']   || {},
    gap_20p:   gapByLabel['20% 이상']  || {},
    qvaWith, qvaNo,
    qvaGap_1_3:   qvaGapByLabel['D-1~D-3']   || {},
    qvaGap_4_7:   qvaGapByLabel['D-4~D-7']   || {},
    qvaGap_8_14:  qvaGapByLabel['D-8~D-14']  || {},
    qvaGap_15_20: qvaGapByLabel['D-15~D-20'] || {},
    sQvaWith: find(out.sCandQvaTab, 'S 후보 + QVA 있음'),
    sQvaNo:   find(out.sCandQvaTab, 'S 후보 + QVA 없음'),
    rQvaWith: find(out.rCandQvaTab, 'R 후보 + QVA 있음'),
    rQvaNo:   find(out.rCandQvaTab, 'R 후보 + QVA 없음'),
  };
}

function buildComparisonRows(currentSnapshot) {
  return COMPARE_SPEC.map(s => {
    const baseVal = getByPath(BASELINE_60D, s.key);
    const curVal = getByPath(currentSnapshot, s.key);
    const judg = judgeHold(curVal, baseVal, s.fmt);
    const delta = (Number.isFinite(curVal) && Number.isFinite(baseVal)) ? curVal - baseVal : null;
    return { ...s, baseVal, curVal, delta, ...judg };
  });
}

// ── 안전 유틸 ──
function isNum(v) { return v != null && Number.isFinite(v); }
function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}
function safeMean(arr) {
  const xs = arr.filter(isNum);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function safeMedian(arr) {
  const xs = arr.filter(isNum).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
function safeRate(num, denom) { return denom > 0 ? (num / denom * 100) : null; }

// ── 마스터 ──
function loadStockMetaMap() {
  const map = new Map();
  if (fs.existsSync(STOCKS_PATH)) {
    try {
      const j = JSON.parse(fs.readFileSync(STOCKS_PATH, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (s.shortCode) map.set(s.shortCode, { name: s.name, market: s.market });
      }
    } catch (_) {}
  }
  if (fs.existsSync(NAVER_LIST_PATH)) {
    try {
      const j = JSON.parse(fs.readFileSync(NAVER_LIST_PATH, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (!s.code) continue;
        const cur = map.get(s.code) || {};
        map.set(s.code, {
          ...cur,
          name: s.name || cur.name,
          market: s.market || cur.market,
          marketCap: s.marketValue || 0,
          isEtf: !!s.isEtf,
          isSpecial: !!s.isSpecial,
        });
      }
    } catch (_) {}
  }
  return map;
}

// ── 단일 (chart, baseIdx) → event ──
// v3: 시초가 기준 지표 추가
// v4: GOOD_TRADE/GREAT_TRADE/TRAP + valueToMcRatio + 캔들 구조 + 신고가 + 최근 급등 횟수
function evaluateAt(rows, baseIdx, marketCap) {
  const m = core.analyzeAt(rows, baseIdx);
  if (!m) return null;
  const s = core.scoreMetrics(m, marketCap);
  const group = core.classifyGroup(m, s);
  if (!group) return null;
  const next = rows[baseIdx + 1];
  if (!next || !isNum(next.open) || !isNum(next.high) || !isNum(next.low) || !isNum(next.close)) return null;
  const baseClose = m.close;
  if (!isNum(baseClose) || baseClose <= 0) return null;
  if (!(next.open > 0)) return null;

  const nextOpenRate = (next.open / baseClose - 1) * 100;
  const nextHighRate = (next.high / baseClose - 1) * 100;
  const nextCloseRate = (next.close / baseClose - 1) * 100;
  const nextLowRate = (next.low / baseClose - 1) * 100;
  const nextHighFromOpenRate  = (next.high  / next.open - 1) * 100;
  const nextLowFromOpenRate   = (next.low   / next.open - 1) * 100;
  const nextCloseFromOpenRate = (next.close / next.open - 1) * 100;
  const highToCloseDropRate = (m.high > 0) ? (m.high - m.close) / m.high * 100 : null;

  // ── v4: 전일 캔들 구조 ──
  const range = m.high - m.low;
  const bodyAbs = Math.abs(m.close - m.open);
  const bodyToRange = range > 0 ? bodyAbs / range : null;
  const baseGapRate = m.prevClose > 0 ? (m.open / m.prevClose - 1) * 100 : null; // = analyzeAt의 gapPct와 동일
  const baseOpenToCloseRate = m.open > 0 ? (m.close / m.open - 1) * 100 : null;
  // ── v4: 시총 대비 거래대금 비율 ──
  const valueToMarketCapRatio = (marketCap > 0 && isNum(m.valueAmount)) ? m.valueAmount / marketCap * 100 : null;

  // ── v4: 신고가 (60/120일) — analyzeAt이 high20만 줘서 여기서 60/120 추가 ──
  let high60 = 0, high120 = 0;
  for (let i = Math.max(0, baseIdx - 60); i < baseIdx; i++) if (rows[i] && rows[i].high > high60) high60 = rows[i].high;
  for (let i = Math.max(0, baseIdx - 120); i < baseIdx; i++) if (rows[i] && rows[i].high > high120) high120 = rows[i].high;
  const isHigh20Break  = m.high20 > 0 ? m.close >= m.high20  : false;
  const isHigh60Break  = high60   > 0 ? m.close >= high60    : false;
  const isHigh120Break = high120  > 0 ? m.close >= high120   : false;
  const distanceFromHigh60 = high60 > 0 ? (m.close / high60 - 1) * 100 : null;

  // ── v4: 최근 5/10일 급등 횟수 ──
  function countSurges(lookback, threshold) {
    let cnt = 0;
    for (let i = baseIdx - lookback; i < baseIdx; i++) {
      const r = rows[i], pr = rows[i - 1];
      if (r && pr && pr.close > 0) {
        const ch = (r.close / pr.close - 1) * 100;
        if (ch >= threshold) cnt++;
      }
    }
    return cnt;
  }
  const recent5Up7Count       = countSurges(5,  7);
  const recent5Up15Count      = countSurges(5, 15);
  const recent10Up7Count      = countSurges(10, 7);
  const recent10Up15Count     = countSurges(10,15);
  const recent10LimitStyleCount = countSurges(10, 20);

  // ── v4: 캔들 구조 분류 (배타, 우선순위 RED → UPPER_WICK_GREEN → GAP_HOLD → LOW_GAP_INTRADAY → BIG_GREEN → OTHER) ──
  let candleType = 'OTHER';
  if (isNum(m.close) && isNum(m.open)) {
    if (m.close < m.open) candleType = 'RED_CLOSE';
    else if (m.close > m.open && isNum(m.upperTailRatio) && m.upperTailRatio >= 0.35) candleType = 'UPPER_WICK_GREEN';
    else if (isNum(baseGapRate) && baseGapRate >= 7 && isNum(baseOpenToCloseRate) && baseOpenToCloseRate >= 0 && isNum(m.closePosition) && m.closePosition >= 0.8) candleType = 'GAP_HOLD';
    else if (isNum(baseGapRate) && baseGapRate < 7 && isNum(baseOpenToCloseRate) && baseOpenToCloseRate >= 10 && isNum(m.closePosition) && m.closePosition >= 0.8) candleType = 'LOW_GAP_INTRADAY';
    else if (m.close > m.open && isNum(bodyToRange) && bodyToRange >= 0.6 && isNum(m.closePosition) && m.closePosition >= 0.8) candleType = 'BIG_GREEN';
  }

  // ── v4: GOOD_TRADE / GREAT_TRADE / TRAP (시초가 기준 실전 지표) ──
  const goodTrade  = nextHighFromOpenRate >= 5 && nextLowFromOpenRate > -5 && nextCloseFromOpenRate > -3;
  const greatTrade = nextHighFromOpenRate >= 7 && nextLowFromOpenRate > -4 && nextCloseFromOpenRate >= 0;
  const trap       = nextHighRate >= 10 && nextLowFromOpenRate <= -5;
  // ── v5: 위험 지표 (분봉 없이 일봉만으로 진입 위험 식별) ──
  const gapRisk       = nextOpenRate >= 7;                                  // 다음날 갭 ≥7%
  const bigGapRisk    = nextOpenRate >= 12;                                 // 다음날 갭 ≥12%
  const overheatTrap  = nextOpenRate >= 7 && nextLowFromOpenRate <= -5;     // 갭 과열 + 시초가 -5% 흔들림
  const noEntryZone   = nextOpenRate >= 7 || nextLowFromOpenRate <= -5;     // "장초 진입 불가능 영역"

  return {
    code: null, name: null, market: null,
    baseDate: m.baseDate, baseIdx, nextDate: next.date,
    valueRatio: m.valueRatio, volumeRatio: m.volumeRatio,
    valueAmount: m.valueAmount, volume: m.volume,
    marketCap, marketCapBand: s.marketCapBand,
    dayChangeRate: m.changeRate,
    closePosition: m.closePosition,
    upperTailRatio: m.upperTailRatio,
    highToCloseDropRate,
    recent3Rate: m.ret3d, recent5Rate: m.ret5d,
    distFromHigh20: m.distFromHigh20, high20: m.high20,
    high: m.high, low: m.low, close: m.close, open: m.open,
    oneDaySurgeScore: s.oneDaySurgeScore,
    group,
    // 다음날 outcome — 전일종가 기준
    nextOpen: next.open, nextHigh: next.high, nextLow: next.low, nextClose: next.close,
    nextOpenRate, nextHighRate, nextCloseRate, nextLowRate,
    hit3: nextHighRate >= 3, hit5: nextHighRate >= 5, hit10: nextHighRate >= 10,
    failCloseMinus3: nextCloseRate <= -3,
    failOpenGapDown3: nextOpenRate <= -3,
    failLowMinus5: nextLowRate <= -5,
    // 시초가 기준
    nextHighFromOpenRate, nextLowFromOpenRate, nextCloseFromOpenRate,
    openHit3: nextHighFromOpenRate >= 3,
    openHit5: nextHighFromOpenRate >= 5,
    openHit10: nextHighFromOpenRate >= 10,
    openFailMinus3: nextLowFromOpenRate <= -3,
    openFailMinus5: nextLowFromOpenRate <= -5,
    openCloseFailMinus3: nextCloseFromOpenRate <= -3,
    gapRate: nextOpenRate,
    // v4 신규
    bodyToRange, baseGapRate, baseOpenToCloseRate,
    valueToMarketCapRatio,
    high60, high120, distanceFromHigh60,
    isHigh20Break, isHigh60Break, isHigh120Break,
    recent5Up7Count, recent5Up15Count, recent10Up7Count, recent10Up15Count, recent10LimitStyleCount,
    candleType,
    goodTrade, greatTrade, trap,
    // v5 위험 지표
    gapRisk, bigGapRisk, overheatTrap, noEntryZone,
    // QVA (메인 루프에서 채움)
    hasPriorQva20: false, priorQvaCount: 0,
    mostRecentPriorQvaGap: null, mostRecentPriorQvaDate: null,
    // 일자 내 거래대금 순위 (메인 루프에서 채움)
    dailyValueRank: null,
  };
}

// ── HIT10 유형 ──
function classifyHit10Type(e) {
  const cp = e.closePosition, tail = e.upperTailRatio, vR = e.valueRatio;
  const dC = e.dayChangeRate, r3 = e.recent3Rate, r5 = e.recent5Rate, h2c = e.highToCloseDropRate;
  if (isNum(cp) && isNum(tail) && isNum(vR) && isNum(dC) &&
      cp >= 0.8 && tail <= 0.3 && vR >= 3 && dC >= 5) return 'TYPE_1_STRONG_CLOSE';
  if (isNum(vR) && isNum(tail) && isNum(cp) && isNum(h2c) &&
      vR >= 3 && tail >= 0.35 && tail <= 0.65 && cp >= 0.4 && h2c <= 8) return 'TYPE_2_TAIL_REBREAK';
  if (isNum(vR) && isNum(dC) && isNum(cp) &&
      vR >= 3 && (r3 == null || r3 <= 15) && (r5 == null || r5 <= 25) && dC >= 3 && cp >= 0.6) return 'TYPE_3_FIRST_VALUE_SURGE';
  return 'TYPE_ETC';
}

function classifyT1Subtype(e) {
  const cp = e.closePosition, tail = e.upperTailRatio, vR = e.valueRatio, dC = e.dayChangeRate;
  if (!(isNum(cp) && isNum(tail) && isNum(vR) && isNum(dC))) return null;
  if (dC >= 20 && cp >= 0.9 && tail <= 0.2) return 'T1_E_LIMIT_UP_STYLE';
  const inT1Base = cp >= 0.8 && tail <= 0.3 && vR >= 3 && dC >= 5;
  if (!inT1Base) return null;
  if (cp >= 0.9 && tail <= 0.2 && vR >= 5 && dC >= 7) return 'T1_A_SUPER_CLOSE_VALUE';
  if (cp >= 0.9 && tail <= 0.2 && vR >= 3 && vR < 5 && dC >= 7) return 'T1_B_SUPER_CLOSE_LOW_VALUE';
  if (cp >= 0.8 && cp < 0.9 && tail <= 0.3 && vR >= 5 && dC >= 7) return 'T1_C_GOOD_CLOSE_HIGH_VALUE';
  if (cp >= 0.8 && cp < 0.9 && tail <= 0.3 && vR >= 3 && vR < 5 && dC >= 5) return 'T1_D_GOOD_CLOSE_NORMAL_VALUE';
  return 'TYPE_1_OTHER';
}

// ── 버킷 요약 (open-base 지표 포함) ──
function summarizeBucket(events) {
  const n = events.length;
  if (n === 0) {
    return {
      count: 0, hit3: 0, hit5: 0, hit10: 0,
      hit3Rate: null, hit5Rate: null, hit10Rate: null,
      failCloseRate: null, failGapDownRate: null, failLowPlungeRate: null,
      avgNextOpen: null, avgNextHigh: null, avgNextClose: null, avgNextLow: null,
      medianNextHigh: null, avgMarketCap: null, avgValueRatio: null,
      // open-base
      openHit3: 0, openHit5: 0, openHit10: 0,
      openHit3Rate: null, openHit5Rate: null, openHit10Rate: null,
      openFail3Rate: null, openFail5Rate: null, openCloseFail3Rate: null,
      avgNextHighFromOpen: null, avgNextLowFromOpen: null, avgNextCloseFromOpen: null,
      // v4 신규
      goodTrade: 0, greatTrade: 0, trap: 0,
      goodTradeRate: null, greatTradeRate: null, trapRate: null,
      // v5 위험
      gapRisk: 0, bigGapRisk: 0, overheatTrap: 0, noEntryZone: 0,
      gapRiskRate: null, bigGapRiskRate: null, overheatTrapRate: null, noEntryZoneRate: null,
    };
  }
  let hit3 = 0, hit5 = 0, hit10 = 0, failClose = 0, failGap = 0, failLow = 0;
  let openHit3 = 0, openHit5 = 0, openHit10 = 0, openFail3 = 0, openFail5 = 0, openCloseFail3 = 0;
  let goodTrade = 0, greatTrade = 0, trap = 0;
  let gapRisk = 0, bigGapRisk = 0, overheatTrap = 0, noEntryZone = 0;
  let sumOpen = 0, sumHigh = 0, sumClose = 0, sumLow = 0;
  let sumOpHigh = 0, sumOpLow = 0, sumOpClose = 0;
  let sumMC = 0, nMC = 0, sumVR = 0, nVR = 0;
  const highs = [];
  for (const e of events) {
    if (e.hit3) hit3++;
    if (e.hit5) hit5++;
    if (e.hit10) hit10++;
    if (e.failCloseMinus3) failClose++;
    if (e.failOpenGapDown3) failGap++;
    if (e.failLowMinus5) failLow++;
    if (e.openHit3) openHit3++;
    if (e.openHit5) openHit5++;
    if (e.openHit10) openHit10++;
    if (e.openFailMinus3) openFail3++;
    if (e.openFailMinus5) openFail5++;
    if (e.openCloseFailMinus3) openCloseFail3++;
    if (e.goodTrade) goodTrade++;
    if (e.greatTrade) greatTrade++;
    if (e.trap) trap++;
    if (e.gapRisk) gapRisk++;
    if (e.bigGapRisk) bigGapRisk++;
    if (e.overheatTrap) overheatTrap++;
    if (e.noEntryZone) noEntryZone++;
    if (isNum(e.nextOpenRate)) sumOpen += e.nextOpenRate;
    if (isNum(e.nextHighRate)) { sumHigh += e.nextHighRate; highs.push(e.nextHighRate); }
    if (isNum(e.nextCloseRate)) sumClose += e.nextCloseRate;
    if (isNum(e.nextLowRate)) sumLow += e.nextLowRate;
    if (isNum(e.nextHighFromOpenRate)) sumOpHigh += e.nextHighFromOpenRate;
    if (isNum(e.nextLowFromOpenRate)) sumOpLow += e.nextLowFromOpenRate;
    if (isNum(e.nextCloseFromOpenRate)) sumOpClose += e.nextCloseFromOpenRate;
    if (isNum(e.marketCap)) { sumMC += e.marketCap; nMC++; }
    if (isNum(e.valueRatio)) { sumVR += e.valueRatio; nVR++; }
  }
  highs.sort((a, b) => a - b);
  const median = highs.length ? (highs.length % 2 ? highs[Math.floor(highs.length / 2)] : (highs[highs.length/2 - 1] + highs[highs.length/2]) / 2) : null;
  return {
    count: n, hit3, hit5, hit10,
    hit3Rate: safeRate(hit3, n),
    hit5Rate: safeRate(hit5, n),
    hit10Rate: safeRate(hit10, n),
    failCloseRate: safeRate(failClose, n),
    failGapDownRate: safeRate(failGap, n),
    failLowPlungeRate: safeRate(failLow, n),
    avgNextOpen: sumOpen / n,
    avgNextHigh: sumHigh / n,
    avgNextClose: sumClose / n,
    avgNextLow: sumLow / n,
    medianNextHigh: median,
    avgMarketCap: nMC ? sumMC / nMC : null,
    avgValueRatio: nVR ? sumVR / nVR : null,
    openHit3, openHit5, openHit10,
    openHit3Rate: safeRate(openHit3, n),
    openHit5Rate: safeRate(openHit5, n),
    openHit10Rate: safeRate(openHit10, n),
    openFail3Rate: safeRate(openFail3, n),
    openFail5Rate: safeRate(openFail5, n),
    openCloseFail3Rate: safeRate(openCloseFail3, n),
    avgNextHighFromOpen: sumOpHigh / n,
    avgNextLowFromOpen: sumOpLow / n,
    avgNextCloseFromOpen: sumOpClose / n,
    // v4 신규
    goodTrade, greatTrade, trap,
    goodTradeRate: safeRate(goodTrade, n),
    greatTradeRate: safeRate(greatTrade, n),
    trapRate: safeRate(trap, n),
    // v5 위험
    gapRisk, bigGapRisk, overheatTrap, noEntryZone,
    gapRiskRate: safeRate(gapRisk, n),
    bigGapRiskRate: safeRate(bigGapRisk, n),
    overheatTrapRate: safeRate(overheatTrap, n),
    noEntryZoneRate: safeRate(noEntryZone, n),
  };
}

function bucketize(events, getValue, bands) {
  return bands.map(b => {
    const sub = events.filter(e => {
      const v = getValue(e);
      if (!isNum(v)) return false;
      if (v < b.min) return false;
      if (b.max != null && v >= b.max) return false;
      return true;
    });
    return { label: b.label, min: b.min, max: b.max, ...summarizeBucket(sub) };
  });
}

function bucketize2D(events, getX, xBands, getY, yBands) {
  const cells = [];
  for (let yi = 0; yi < yBands.length; yi++) {
    const yb = yBands[yi];
    for (let xi = 0; xi < xBands.length; xi++) {
      const xb = xBands[xi];
      const sub = events.filter(e => {
        const xv = getX(e), yv = getY(e);
        if (!isNum(xv) || !isNum(yv)) return false;
        if (xv < xb.min || (xb.max != null && xv >= xb.max)) return false;
        if (yv < yb.min || (yb.max != null && yv >= yb.max)) return false;
        return true;
      });
      cells.push({ x: xi, y: yi, xLabel: xb.label, yLabel: yb.label, ...summarizeBucket(sub) });
    }
  }
  return { xBands: xBands.map(b => b.label), yBands: yBands.map(b => b.label), cells };
}

// ── HIT10 vs NON_HIT10 비교 (단일 지표) ──
const COMPARE_METRICS = [
  { key: 'valueRatio',          label: '거래대금 배율 (×N)',         unit: 'x'    },
  { key: 'volumeRatio',         label: '거래량 배율 (×N)',           unit: 'x'    },
  { key: 'marketCap',           label: '시가총액 (원)',              unit: 'won'  },
  { key: 'dayChangeRate',       label: '전일 등락률 (%)',            unit: 'pct'  },
  { key: 'closePosition',       label: '종가 위치 (0~1)',            unit: 'unit' },
  { key: 'upperTailRatio',      label: '윗꼬리 비율 (0~1)',          unit: 'unit' },
  { key: 'highToCloseDropRate', label: '고점→종가 하락률 (%)',       unit: 'pct'  },
  { key: 'recent3Rate',         label: '최근 3일 누적 (%)',          unit: 'pct'  },
  { key: 'recent5Rate',         label: '최근 5일 누적 (%)',          unit: 'pct'  },
  { key: 'distFromHigh20',      label: '20일 고점 대비 위치 (%)',    unit: 'pct'  },
  { key: 'oneDaySurgeScore',    label: '점수 (oneDaySurgeScore)',    unit: 'num'  },
  { key: 'valueAmount',         label: '거래대금 (원)',              unit: 'won'  },
  { key: 'volume',              label: '거래량 (주)',                unit: 'num'  },
];

function compareMetrics(hit10, non) {
  return COMPARE_METRICS.map(({ key, label, unit }) => {
    const hVals = hit10.map(e => e[key]);
    const nVals = non.map(e => e[key]);
    const hMean = safeMean(hVals);
    const hMed  = safeMedian(hVals);
    const nMean = safeMean(nVals);
    const nMed  = safeMedian(nVals);
    const diffMean = (isNum(hMean) && isNum(nMean)) ? hMean - nMean : null;
    const relDiff = (isNum(diffMean) && isNum(nMean) && Math.abs(nMean) > 1e-9) ? diffMean / Math.abs(nMean) : null;
    return { key, label, unit, hit10Mean: hMean, hit10Median: hMed, nonMean: nMean, nonMedian: nMed, diffMean, relDiff };
  });
}

// ── 룰 차원 (변경 없음) ──
const RULE_DIMENSIONS = {
  closePosition: [
    { label: 'any',     test: () => true },
    { label: 'cp≥0.8',  test: e => isNum(e.closePosition) && e.closePosition >= 0.80 },
    { label: 'cp≥0.85', test: e => isNum(e.closePosition) && e.closePosition >= 0.85 },
    { label: 'cp≥0.9',  test: e => isNum(e.closePosition) && e.closePosition >= 0.90 },
  ],
  upperTailRatio: [
    { label: 'any',     test: () => true },
    { label: 'tail≤0.3', test: e => isNum(e.upperTailRatio) && e.upperTailRatio <= 0.30 },
    { label: 'tail≤0.2', test: e => isNum(e.upperTailRatio) && e.upperTailRatio <= 0.20 },
    { label: 'tail≤0.1', test: e => isNum(e.upperTailRatio) && e.upperTailRatio <= 0.10 },
  ],
  valueRatio: [
    { label: 'any',     test: () => true },
    { label: 'val×3↑',  test: e => isNum(e.valueRatio) && e.valueRatio >= 3 },
    { label: 'val×5↑',  test: e => isNum(e.valueRatio) && e.valueRatio >= 5 },
    { label: 'val×10↑', test: e => isNum(e.valueRatio) && e.valueRatio >= 10 },
  ],
  dayChangeRate: [
    { label: 'any',     test: () => true },
    { label: 'chg≥5%',  test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 5 },
    { label: 'chg≥7%',  test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 7 },
    { label: 'chg≥12%', test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 12 },
    { label: 'chg≥20%', test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 20 },
  ],
  recent3Rate: [
    { label: 'any',     test: () => true },
    { label: 'r3≥10%',  test: e => isNum(e.recent3Rate) && e.recent3Rate >= 10 },
    { label: 'r3≥20%',  test: e => isNum(e.recent3Rate) && e.recent3Rate >= 20 },
    { label: 'r3≥35%',  test: e => isNum(e.recent3Rate) && e.recent3Rate >= 35 },
  ],
  recent5Rate: [
    { label: 'any',     test: () => true },
    { label: 'r5≥20%',  test: e => isNum(e.recent5Rate) && e.recent5Rate >= 20 },
    { label: 'r5≥35%',  test: e => isNum(e.recent5Rate) && e.recent5Rate >= 35 },
    { label: 'r5≥50%',  test: e => isNum(e.recent5Rate) && e.recent5Rate >= 50 },
  ],
  marketCap: [
    { label: 'any',          test: () => true },
    { label: 'mc 500억~1.5조',  test: e => isNum(e.marketCap) && e.marketCap >= 5e10  && e.marketCap < 1.5e12 },
    { label: 'mc 1000억~7000억', test: e => isNum(e.marketCap) && e.marketCap >= 1e11  && e.marketCap < 7e11   },
    { label: 'mc 1000억~1.5조',  test: e => isNum(e.marketCap) && e.marketCap >= 1e11  && e.marketCap < 1.5e12 },
    { label: 'mc 3000억~7000억', test: e => isNum(e.marketCap) && e.marketCap >= 3e11  && e.marketCap < 7e11   },
  ],
};

function generateRules() {
  const dims = Object.keys(RULE_DIMENSIONS);
  const limits = dims.map(d => RULE_DIMENSIONS[d].length);
  const idx = dims.map(() => 0);
  const rules = [];
  while (true) {
    const conds = {}; const tests = []; let active = 0; const labels = [];
    for (let i = 0; i < dims.length; i++) {
      const opt = RULE_DIMENSIONS[dims[i]][idx[i]];
      conds[dims[i]] = opt.label;
      if (opt.label !== 'any') { active++; labels.push(opt.label); tests.push(opt.test); }
    }
    if (active > 0) rules.push({ id: rules.length, conds, label: labels.join(' · '), activeCount: active, tests });
    let k = dims.length - 1;
    while (k >= 0) { idx[k]++; if (idx[k] < limits[k]) break; idx[k] = 0; k--; }
    if (k < 0) break;
  }
  return rules;
}

function evaluateRule(events, tests) {
  let n = 0, hit3 = 0, hit5 = 0, hit10 = 0;
  let failClose = 0, failGap = 0, failLow = 0;
  let sumOpen = 0, sumHigh = 0, sumClose = 0;
  outer: for (const e of events) {
    for (const t of tests) { if (!t(e)) continue outer; }
    n++;
    if (e.hit3) hit3++;
    if (e.hit5) hit5++;
    if (e.hit10) hit10++;
    if (e.failCloseMinus3) failClose++;
    if (e.failOpenGapDown3) failGap++;
    if (e.failLowMinus5) failLow++;
    if (isNum(e.nextOpenRate)) sumOpen += e.nextOpenRate;
    if (isNum(e.nextHighRate)) sumHigh += e.nextHighRate;
    if (isNum(e.nextCloseRate)) sumClose += e.nextCloseRate;
  }
  return {
    n,
    hit3Rate: safeRate(hit3, n),
    hit5Rate: safeRate(hit5, n),
    hit10Rate: safeRate(hit10, n),
    failCloseRate: safeRate(failClose, n),
    failGapDownRate: safeRate(failGap, n),
    failLowPlungeRate: safeRate(failLow, n),
    avgNextOpen: n ? sumOpen / n : null,
    avgNextHigh: n ? sumHigh / n : null,
    avgNextClose: n ? sumClose / n : null,
  };
}

// ── 명명된 조건 (open-base + QVA cross 분석용) ──
const NAMED_CONDITIONS = [
  { key: 'T1_E', label: 'T1_E 상한가형 (chg≥20% + cp≥0.9 + tail≤0.2)',
    test: e => e.t1Subtype === 'T1_E_LIMIT_UP_STYLE' },
  { key: 'S_CAND', label: 'S 후보 (시총 3000억~7000억 강한마감 급등)',
    test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 20
            && isNum(e.closePosition) && e.closePosition >= 0.8
            && isNum(e.upperTailRatio) && e.upperTailRatio <= 0.1
            && isNum(e.valueRatio) && e.valueRatio >= 3
            && ((isNum(e.recent3Rate) && e.recent3Rate >= 35) || (isNum(e.recent5Rate) && e.recent5Rate >= 35))
            && isNum(e.marketCap) && e.marketCap >= 3e11 && e.marketCap < 7e11 },
  { key: 'R_CAND', label: 'R 후보 (시총 500억~1.5조 강한마감 급등 + 최근5일 50%+)',
    test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 20
            && isNum(e.closePosition) && e.closePosition >= 0.8
            && isNum(e.upperTailRatio) && e.upperTailRatio <= 0.1
            && isNum(e.valueRatio) && e.valueRatio >= 3
            && isNum(e.recent5Rate) && e.recent5Rate >= 50
            && isNum(e.marketCap) && e.marketCap >= 5e10 && e.marketCap < 1.5e12 },
  { key: 'MC_3K_7K', label: '시총 3,000억~7,000억',
    test: e => isNum(e.marketCap) && e.marketCap >= 3e11 && e.marketCap < 7e11 },
  { key: 'MC_500_1_5T', label: '시총 500억~1.5조',
    test: e => isNum(e.marketCap) && e.marketCap >= 5e10 && e.marketCap < 1.5e12 },
  { key: 'CHG_20', label: '전일 등락률 ≥ 20%',
    test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 20 },
  { key: 'CP_08', label: 'closePosition ≥ 0.8',
    test: e => isNum(e.closePosition) && e.closePosition >= 0.8 },
  { key: 'CP_09', label: 'closePosition ≥ 0.9',
    test: e => isNum(e.closePosition) && e.closePosition >= 0.9 },
  { key: 'TAIL_01', label: 'upperTailRatio ≤ 0.1',
    test: e => isNum(e.upperTailRatio) && e.upperTailRatio <= 0.1 },
  { key: 'VAL_3', label: 'valueRatio ≥ 3',
    test: e => isNum(e.valueRatio) && e.valueRatio >= 3 },
  { key: 'R3_35', label: 'recent3Rate ≥ 35%',
    test: e => isNum(e.recent3Rate) && e.recent3Rate >= 35 },
  { key: 'R5_35', label: 'recent5Rate ≥ 35%',
    test: e => isNum(e.recent5Rate) && e.recent5Rate >= 35 },
];

// ── 자동 결론 ──
function buildAutoConclusion({ comparison, crossTabs, crossTabs2D, hit10Types, type1Subtypes, byGroup, baseRate, baseFailClose, baseFailLow, baseOpenFail5, ruleSearch, qvaSummary, sCandQvaTab, rCandQvaTab, gapTab, namedConditions,
  // v4 추가
  valueToMcRatioTab, valueAmountTab, dayChangeFineTab, candleTab, highBreakTab,
  recentSurgeTabs, valueRankTab, sVariantTab, ruleSearchV2,
  baseGoodTrade, baseGreatTrade, baseTrap,
  // v4-extra
  gtCombos,
  // v4-extra2
  lightGtCombos, lightGtMatrix,
  // v5
  goodVsTrapCompare, gapPredictTabs, matrixGapVsOpenClose, matrixR5VsVmc, perMcRuleSearch,
}) {
  const c = {};

  c.topSingleMetrics = comparison
    .filter(x => isNum(x.relDiff))
    .map(x => ({ ...x, abs: Math.abs(x.relDiff) }))
    .sort((a, b) => b.abs - a.abs)
    .slice(0, 5)
    .map(x => ({
      label: x.label, hit10Mean: x.hit10Mean, nonMean: x.nonMean, diffMean: x.diffMean, relDiff: x.relDiff,
      direction: x.diffMean > 0 ? 'HIT10이 더 큼' : 'HIT10이 더 작음',
    }));

  const flat2D = [];
  for (const [key, mtx] of Object.entries(crossTabs2D)) {
    for (const cell of mtx.cells) {
      if (cell.count >= N_REFERENCE && isNum(cell.hit10Rate)) {
        flat2D.push({ tab: key, label: `${cell.yLabel} × ${cell.xLabel}`, count: cell.count, hit10Rate: cell.hit10Rate, lift: cell.hit10Rate - baseRate, failCloseRate: cell.failCloseRate, failLowPlungeRate: cell.failLowPlungeRate });
      }
    }
  }
  c.topCombos2D = flat2D.sort((a, b) => b.lift - a.lift).slice(0, 5);

  const t1Sorted = Object.entries(type1Subtypes)
    .filter(([_, v]) => v.count >= N_REFERENCE && isNum(v.hit10Rate))
    .map(([k, v]) => ({ subtype: k, count: v.count, hit10Rate: v.hit10Rate, failCloseRate: v.failCloseRate, avgNextHigh: v.avgNextHigh }))
    .sort((a, b) => b.hit10Rate - a.hit10Rate);
  c.topT1Subtype = t1Sorted[0] || null;

  c.topRulesByHit10 = (ruleSearch.topByHit10 || []).slice(0, 5);
  c.topRulesByRiskAdj = (ruleSearch.topByRiskAdj || []).slice(0, 5);
  c.highRiskCombos = (ruleSearch.highRisk || []).slice(0, 5);
  c.highQualityCombos = (ruleSearch.highQuality || []).slice(0, 5);

  // S/R 후보
  const sGroupCandidates = [];
  for (const r of (ruleSearch.highQuality || []).slice(0, 5)) {
    sGroupCandidates.push({ source: 'rule', label: r.label, n: r.n,
      hit10Rate: r.hit10Rate, failCloseRate: r.failCloseRate, failLowPlungeRate: r.failLowPlungeRate });
  }
  c.sGroupCandidates = sGroupCandidates;
  c.rGroupCandidates = (ruleSearch.highRisk || []).slice(0, 5);

  // 결론 보류
  const onHold = [];
  const scoreRows = (crossTabs.score || []).filter(r => r.count >= N_REFERENCE && isNum(r.hit10Rate));
  if (scoreRows.length >= 3) {
    let hasInversion = false;
    for (let i = 1; i < scoreRows.length; i++) {
      if (scoreRows[i].hit10Rate > scoreRows[i - 1].hit10Rate + 5) hasInversion = true;
    }
    if (hasInversion) onHold.push('현재 oneDaySurgeScore 차원에서 HIT10률이 단조 증가하지 않음 — 점수식 자체를 다시 설계해야 할 가능성.');
  }
  if (ruleSearch.totalRulesEvaluated > 0) {
    const reliableRatio = ruleSearch.rulesWithNGte50 / ruleSearch.totalRulesEvaluated;
    if (reliableRatio < 0.05) onHold.push(`룰 탐색 결과 n≥${N_RELIABLE} 신뢰 룰이 전체의 ${(reliableRatio*100).toFixed(1)}%로 적음. VALIDATION_DAYS=120으로 표본 보강 권장.`);
  }
  c.onHold = onHold;

  const aRate = byGroup.A?.hit10Rate, dRate = byGroup.D?.hit10Rate;
  if (isNum(aRate) && isNum(dRate)) {
    c.groupIssue = (dRate > aRate)
      ? `D그룹 HIT10률(${dRate.toFixed(1)}%)이 A그룹(${aRate.toFixed(1)}%)보다 높음. D 안에 진짜 위험형과 강한 모멘텀형이 섞임 — 분해 필요.`
      : `A그룹 HIT10률(${aRate.toFixed(1)}%)이 D(${dRate.toFixed(1)}%)보다 높음. A 표본(${byGroup.A.count})이 충분한지 점검.`;
  }

  // ─── v3 추가: 상따 vs 장초 진입 분석 ───
  const openInsights = [];
  // 명명된 조건 중 prevClose-base hit10률은 높은데 openHit5는 낮은 것
  for (const nc of namedConditions) {
    if (nc.count < N_REFERENCE) continue;
    if (!isNum(nc.hit10Rate) || !isNum(nc.openHit5Rate)) continue;
    const trapDelta = nc.hit10Rate - nc.openHit5Rate * 1.5;
    if (nc.hit10Rate >= baseRate + 15 && trapDelta > 15) {
      openInsights.push(`${nc.label}: 전일종가 기준 HIT10 ${nc.hit10Rate.toFixed(1)}% vs 시초가 진입자 +5%↑ ${nc.openHit5Rate.toFixed(1)}% — 시초가가 이미 떠서 먹을 자리 줄어듦`);
    }
  }
  c.openVsCloseInsights = openInsights;

  // 갭 위험 임계 — 갭 구간별로 openHit5 vs openFailMinus5 비교해서 임계 추정
  if (gapTab && gapTab.length) {
    const gapWarnings = [];
    for (const g of gapTab) {
      if (!isNum(g.hit10Rate) || g.count < N_REFERENCE) continue;
      // 시초가 기준으로 보면 net = openHit5Rate - openFail5Rate
      const net = (g.openHit5Rate || 0) - (g.openFail5Rate || 0);
      gapWarnings.push({ band: g.label, count: g.count, hit10Rate: g.hit10Rate, openHit5Rate: g.openHit5Rate, openFail5Rate: g.openFail5Rate, openCloseAvg: g.avgNextCloseFromOpen, net });
    }
    c.gapInsights = gapWarnings;
    // 갭 위험 임계: net이 음수가 되는 첫 갭 구간
    const dangerGap = gapWarnings.find(g => g.net != null && g.net < 0);
    c.gapDangerThreshold = dangerGap ? dangerGap.band : null;
  }

  // ─── v3 추가: QVA 운영 권고 ───
  const qvaRecs = [];
  if (qvaSummary && isNum(qvaSummary.hit10RateWithQva) && isNum(qvaSummary.hit10RateNoQva)) {
    const liftQva = qvaSummary.hit10RateWithQva - qvaSummary.hit10RateNoQva;
    const failDeltaClose = (qvaSummary.failCloseWithQva || 0) - (qvaSummary.failCloseNoQva || 0);
    const failDeltaLow = (qvaSummary.failLowWithQva || 0) - (qvaSummary.failLowNoQva || 0);
    qvaRecs.push(`QVA 있음 그룹 HIT10 ${qvaSummary.hit10RateWithQva.toFixed(1)}% vs 없음 ${qvaSummary.hit10RateNoQva.toFixed(1)}% (lift ${liftQva > 0 ? '+' : ''}${liftQva.toFixed(1)}pp)`);
    qvaRecs.push(`실패 종가 차이: ${failDeltaClose > 0 ? '+' : ''}${failDeltaClose.toFixed(1)}pp · 실패 저가 차이: ${failDeltaLow > 0 ? '+' : ''}${failDeltaLow.toFixed(1)}pp`);
    if (Math.abs(liftQva) < 3 && Math.abs(failDeltaClose) < 3 && Math.abs(failDeltaLow) < 3) {
      qvaRecs.push('판정: QVA가 1DS HIT10에 의미 있는 차이를 만들지 않음 — **1DS 점수식에 넣지 말고 별도 운영** 권장.');
      c.qvaVerdict = 'INDEPENDENT';
    } else if (liftQva >= 3 && failDeltaClose <= 0 && failDeltaLow <= 0) {
      qvaRecs.push('판정: QVA가 HIT10률을 올리고 실패율은 낮춤 — **품질 보조 태그**로 적합. 점수식 가점 검토 가능.');
      c.qvaVerdict = 'QUALITY_TAG';
    } else if (liftQva >= 3 && (failDeltaClose > 3 || failDeltaLow > 3)) {
      qvaRecs.push('판정: QVA가 HIT10률은 높이지만 실패율도 함께 높음 — **위험 모멘텀 태그**. 가점 X, 표시만.');
      c.qvaVerdict = 'RISK_MOMENTUM';
    } else if (liftQva < 0 && failDeltaClose < -3) {
      qvaRecs.push('판정: QVA가 HIT10률은 낮추지만 실패율도 함께 낮춤 — **안전성 보조 태그**. 보수적 후보 분리에 사용.');
      c.qvaVerdict = 'SAFETY_TAG';
    } else {
      qvaRecs.push('판정: 혼합 신호 — 결론 보류. 윈도우 늘려서 재확인 필요.');
      c.qvaVerdict = 'MIXED';
    }
  }
  // S × QVA / R × QVA 추가 권고
  if (sCandQvaTab) {
    const sWith = sCandQvaTab.find(x => x.label === 'S 후보 + QVA 있음');
    const sNo = sCandQvaTab.find(x => x.label === 'S 후보 + QVA 없음');
    if (sWith && sNo && sWith.count >= 10 && sNo.count >= 10) {
      const liftS = (sWith.hit10Rate || 0) - (sNo.hit10Rate || 0);
      qvaRecs.push(`S 후보 안에서 QVA 있음 vs 없음 HIT10 차이: ${liftS > 0 ? '+' : ''}${liftS.toFixed(1)}pp (n=${sWith.count} vs ${sNo.count})`);
    }
  }
  if (rCandQvaTab) {
    const rWith = rCandQvaTab.find(x => x.label === 'R 후보 + QVA 있음');
    const rNo = rCandQvaTab.find(x => x.label === 'R 후보 + QVA 없음');
    if (rWith && rNo && rWith.count >= 10 && rNo.count >= 10) {
      const failDeltaR = (rWith.failLowPlungeRate || 0) - (rNo.failLowPlungeRate || 0);
      qvaRecs.push(`R 후보 안에서 QVA 있음 저가급락 ${(rWith.failLowPlungeRate||0).toFixed(1)}% vs 없음 ${(rNo.failLowPlungeRate||0).toFixed(1)}% (차이 ${failDeltaR > 0 ? '+' : ''}${failDeltaR.toFixed(1)}pp)`);
    }
  }
  c.qvaRecommendations = qvaRecs;

  // 향후 보드 문구 제안
  c.boardPhrasing = [
    { groupName: 'S 후보 (다음날 장초 최우선 확인 후보)',
      text: '전일 강하게 마감했지만, 바로 추격하기보다 다음 거래일 초반 거래대금과 고점 재돌파를 확인해야 하는 후보입니다.' },
    { groupName: '상한가형 장초 확인 후보',
      text: '전일 강하게 오른 종목입니다. 다음날 크게 튈 가능성도 있지만, 장중 급락 위험도 함께 확인해야 합니다.' },
    { groupName: '고위험 급등형',
      text: '다음날 고가 상승 가능성은 높지만, 장중 -5% 이상 흔들릴 가능성도 큰 유형입니다.' },
    { groupName: 'QVA 선행 흔적 있음 (보조 태그)',
      text: '급등 전에 이미 거래대금과 저점 상승 흐름이 포착됐던 종목입니다.' },
    { groupName: 'QVA 선행 흔적 없음 (보조 태그)',
      text: '갑작스러운 뉴스·테마·단기 수급으로 급등했을 가능성이 있어 장초 확인이 더 중요합니다.' },
  ];

  // ─── v4 자동 결론 ───
  c.v4 = {};

  // 1) HIT10 높지만 TRAP 높은 조건 — namedConditions 중
  if (Array.isArray(namedConditions)) {
    c.v4.hit10HighButTrap = namedConditions
      .filter(nc => nc.count >= N_REFERENCE && isNum(nc.hit10Rate) && isNum(nc.trapRate)
                 && nc.hit10Rate >= baseRate + 15 && nc.trapRate >= (baseTrap || 0) * 1.5)
      .sort((a, b) => b.trapRate - a.trapRate)
      .slice(0, 5)
      .map(nc => ({ label: nc.label, n: nc.count, hit10Rate: nc.hit10Rate, trapRate: nc.trapRate, openFail5Rate: nc.openFail5Rate }));
  }

  // 2,3) GOOD_TRADE / GREAT_TRADE TOP5 (룰 V2)
  if (ruleSearchV2) {
    c.v4.topGoodTrade = (ruleSearchV2.topByGoodTrade || [])
      .filter(r => r.n >= N_RELIABLE && isNum(r.goodTradeRate)).slice(0, 5)
      .map(r => ({ label: r.label, n: r.n, goodTradeRate: r.goodTradeRate, greatTradeRate: r.greatTradeRate, trapRate: r.trapRate, gtScore: r.gtScore }));
    c.v4.topGreatTrade = (ruleSearchV2.topByGoodTrade || [])
      .filter(r => r.n >= N_RELIABLE && isNum(r.greatTradeRate))
      .sort((a, b) => (b.greatTradeRate || 0) - (a.greatTradeRate || 0)).slice(0, 5)
      .map(r => ({ label: r.label, n: r.n, goodTradeRate: r.goodTradeRate, greatTradeRate: r.greatTradeRate, trapRate: r.trapRate }));
    c.v4.topByGtScore = (ruleSearchV2.topByGtScore || [])
      .filter(r => r.n >= N_RELIABLE).slice(0, 5)
      .map(r => ({ label: r.label, n: r.n, goodTradeRate: r.goodTradeRate, greatTradeRate: r.greatTradeRate, trapRate: r.trapRate, openFail5Rate: r.openFail5Rate, gtScore: r.gtScore }));
    c.v4.topByLowestTrap = (ruleSearchV2.topByLowestTrap || []).slice(0, 5)
      .map(r => ({ label: r.label, n: r.n, closeHit10Rate: r.closeHit10Rate, trapRate: r.trapRate, openFail5Rate: r.openFail5Rate, goodTradeRate: r.goodTradeRate }));
  }

  // 4) S2/S3 best — n>=N_RELIABLE 우선, 없으면 n>=N_REFERENCE
  if (Array.isArray(sVariantTab)) {
    const reliable = sVariantTab.filter(v => v.all.count >= N_RELIABLE && isNum(v.all.goodTradeRate));
    const ref = sVariantTab.filter(v => v.all.count >= N_REFERENCE && v.all.count < N_RELIABLE && isNum(v.all.goodTradeRate));
    const sorted = [...reliable].sort((a, b) => (b.all.goodTradeRate || 0) - (a.all.goodTradeRate || 0));
    const refSorted = [...ref].sort((a, b) => (b.all.goodTradeRate || 0) - (a.all.goodTradeRate || 0));
    c.v4.bestSVariant = sorted[0] ? {
      key: sorted[0].key, label: sorted[0].label, n: sorted[0].all.count,
      goodTradeRate: sorted[0].all.goodTradeRate, greatTradeRate: sorted[0].all.greatTradeRate,
      trapRate: sorted[0].all.trapRate, hit10Rate: sorted[0].all.hit10Rate,
      reliable: true,
    } : (refSorted[0] ? {
      key: refSorted[0].key, label: refSorted[0].label, n: refSorted[0].all.count,
      goodTradeRate: refSorted[0].all.goodTradeRate, greatTradeRate: refSorted[0].all.greatTradeRate,
      trapRate: refSorted[0].all.trapRate, hit10Rate: refSorted[0].all.hit10Rate,
      reliable: false,
    } : null);
    c.v4.allSVariants = sVariantTab.map(v => ({
      key: v.key, label: v.label, n: v.all.count,
      goodTradeRate: v.all.goodTradeRate, greatTradeRate: v.all.greatTradeRate,
      trapRate: v.all.trapRate, hit10Rate: v.all.hit10Rate,
      openFail5Rate: v.all.openFail5Rate,
    }));
  }

  // 5) 상따/갭 위험 피하면서 OPEN_HIT5 높은 조건 (룰 V2 중 baseGap 'gap<7%' 포함하면서 openHit5 높은)
  if (ruleSearchV2 && ruleSearchV2.topByGoodTrade) {
    const safeRules = ruleSearchV2.topByGoodTrade
      .filter(r => r.n >= N_RELIABLE && isNum(r.openHit5Rate) && isNum(r.trapRate)
                && r.openHit5Rate >= 35 && r.trapRate <= (baseTrap || 0) * 1.2)
      .sort((a, b) => (b.openHit5Rate || 0) - (a.openHit5Rate || 0))
      .slice(0, 5);
    c.v4.safeOpenHit5Rules = safeRules.map(r => ({ label: r.label, n: r.n, openHit5Rate: r.openHit5Rate, trapRate: r.trapRate, goodTradeRate: r.goodTradeRate }));
  }

  // 6) valueToMcRatio 의미 있는 구간 — goodTradeRate가 baseGoodTrade 대비 가장 큰 lift
  if (Array.isArray(valueToMcRatioTab)) {
    const sorted = valueToMcRatioTab.filter(b => b.count >= N_REFERENCE && isNum(b.goodTradeRate))
      .map(b => ({ ...b, lift: b.goodTradeRate - (baseGoodTrade || 0) }))
      .sort((a, b) => b.lift - a.lift);
    c.v4.bestValueToMcBand = sorted[0] ? { label: sorted[0].label, n: sorted[0].count, goodTradeRate: sorted[0].goodTradeRate, lift: sorted[0].lift } : null;
  }

  // 7) 캔들 구조 best
  if (Array.isArray(candleTab)) {
    const sorted = candleTab.filter(b => b.count >= N_REFERENCE && isNum(b.goodTradeRate))
      .sort((a, b) => (b.goodTradeRate || 0) - (a.goodTradeRate || 0));
    c.v4.bestCandle = sorted[0] ? { type: sorted[0].type, label: sorted[0].label, n: sorted[0].count, goodTradeRate: sorted[0].goodTradeRate, hit10Rate: sorted[0].hit10Rate, trapRate: sorted[0].trapRate } : null;
  }

  // 8) 신고가 돌파가 도움이 되는지
  if (Array.isArray(highBreakTab)) {
    const breakers = highBreakTab.filter(b => ['HIGH_120','HIGH_60','HIGH_20'].includes(b.key) && b.count >= N_REFERENCE);
    const belowAll = highBreakTab.filter(b => b.key && b.key.startsWith('BELOW') && b.count >= N_REFERENCE);
    const breakAvg = breakers.length ? safeMean(breakers.map(b => b.goodTradeRate)) : null;
    const belowAvg = belowAll.length ? safeMean(belowAll.map(b => b.goodTradeRate)) : null;
    if (isNum(breakAvg) && isNum(belowAvg)) {
      c.v4.highBreakHelps = `신고가 돌파 그룹 GOOD_TRADE 평균 ${breakAvg.toFixed(1)}% vs 고점 아래 ${belowAvg.toFixed(1)}% — ${breakAvg > belowAvg + 3 ? '돌파가 유의미하게 더 좋음' : Math.abs(breakAvg - belowAvg) < 3 ? '차이 미미' : '오히려 돌파 안 한 그룹이 좋음'}`;
    }
  }

  // 9) 첫 급등 vs 연속 급등
  if (recentSurgeTabs && recentSurgeTabs.recent10Up15) {
    const tab = recentSurgeTabs.recent10Up15.filter(b => b.count >= N_REFERENCE && isNum(b.goodTradeRate));
    if (tab.length >= 2) {
      const zero = tab.find(b => b.label === '0회');
      const multi = tab.filter(b => b.label !== '0회');
      const multiAvg = multi.length ? safeMean(multi.map(b => b.goodTradeRate)) : null;
      if (zero && isNum(zero.goodTradeRate) && isNum(multiAvg)) {
        c.v4.firstVsContinuous = `첫 급등형(최근10일 +15%↑ 0회) GOOD_TRADE ${zero.goodTradeRate.toFixed(1)}% vs 연속 급등형 평균 ${multiAvg.toFixed(1)}% — ${zero.goodTradeRate > multiAvg + 3 ? '첫 급등형이 유의미하게 좋음' : multiAvg > zero.goodTradeRate + 3 ? '연속 급등형이 유의미하게 좋음' : '차이 미미'}`;
      }
    }
  }

  // 10) 다음 보드 리팩토링에 반영할 확정/보류
  const confirmed = [];
  const onHoldV4 = [];
  if (c.v4.topByGtScore && c.v4.topByGtScore.length) {
    const top = c.v4.topByGtScore[0];
    if (top.n >= N_RELIABLE && top.gtScore > 30) {
      confirmed.push(`GOOD_TRADE 룰 best: ${top.label} (n=${top.n}, GOOD ${top.goodTradeRate.toFixed(1)}%, TRAP ${top.trapRate.toFixed(1)}%, gtScore ${top.gtScore.toFixed(1)})`);
    }
  }
  if (c.v4.bestSVariant && c.v4.bestSVariant.reliable) {
    confirmed.push(`S2 best: ${c.v4.bestSVariant.key} n=${c.v4.bestSVariant.n} GOOD ${c.v4.bestSVariant.goodTradeRate.toFixed(1)}% — 보드 후보로 검토 가능`);
  } else if (c.v4.bestSVariant) {
    onHoldV4.push(`S2 best는 ${c.v4.bestSVariant.key}이지만 n=${c.v4.bestSVariant.n}로 신뢰 표본 미달 — 보류`);
  }
  c.v4.confirmed = confirmed;
  c.v4.onHold = onHoldV4;

  // ── v4-extra: GT_BASE 정제 결과 + 최종 보드 그룹 초안 ──
  if (Array.isArray(gtCombos)) {
    const gtSorted = [...gtCombos]
      .filter(c => isNum(c.gtScore))
      .sort((a, b) => b.gtScore - a.gtScore);
    c.v4.gtBestByScore = gtSorted.slice(0, 5).map(c => ({
      key: c.key, label: c.label, n: c.count,
      goodTradeRate: c.goodTradeRate, greatTradeRate: c.greatTradeRate,
      trapRate: c.trapRate, openFail5Rate: c.openFail5Rate,
      hit10Rate: c.hit10Rate, gtScore: c.gtScore,
      reliability: c.reliability, meetsGoals: c.meetsGoals,
    }));
    c.v4.gtMeetsGoals = gtCombos.filter(c => c.meetsGoals).map(c => ({
      key: c.key, label: c.label, n: c.count,
      goodTradeRate: c.goodTradeRate, trapRate: c.trapRate,
      openFail5Rate: c.openFail5Rate, gtScore: c.gtScore,
    }));

    // S-GT / A-GT / MOM-RISK / HIGH-RISK 그룹 초안
    const sGtBest = gtCombos.find(c => ['M','P','D','E'].includes(c.key) && c.count >= 30) || gtCombos.find(c => c.key === 'D');
    const aGtBest = gtCombos.find(c => c.key === 'C') || gtCombos.find(c => c.key === 'A');
    c.v4.boardGroupProposals = {
      'S-GT': {
        title: '실전형 GOOD_TRADE 최우선 후보',
        prevConditions: 'v/mc≥5% + mc 3000억~7000억 + LOW_GAP_INTRADAY 또는 거래대금 순위 상위 30위 + 전일 등락률 12~25%',
        intradayConditions: '다음날 gapRate < 7%',
        recommendedCombo: sGtBest ? sGtBest.key : null,
        candidateStats: sGtBest ? {
          n: sGtBest.count, goodTradeRate: sGtBest.goodTradeRate,
          trapRate: sGtBest.trapRate, openFail5Rate: sGtBest.openFail5Rate,
          gtScore: sGtBest.gtScore, reliability: sGtBest.reliability,
        } : null,
      },
      'A-GT': {
        title: '장초 확인 후보',
        prevConditions: 'v/mc≥5% + mc 1000억~7000억 + 거래대금 순위 상위 30위 또는 LOW_GAP_INTRADAY',
        intradayConditions: '다음날 gapRate < 7%',
        recommendedCombo: aGtBest ? aGtBest.key : null,
        candidateStats: aGtBest ? {
          n: aGtBest.count, goodTradeRate: aGtBest.goodTradeRate,
          trapRate: aGtBest.trapRate, openFail5Rate: aGtBest.openFail5Rate,
          gtScore: aGtBest.gtScore, reliability: aGtBest.reliability,
        } : null,
      },
      'MOM-RISK': {
        title: '급등 모멘텀 있지만 함정 위험',
        prevConditions: 'dayChangeRate ≥ 29% (상한가형) 또는 GAP_HOLD 캔들',
        intradayConditions: 'gapRate ≥ 7% 면 추격 위험 강조',
        notes: 'HIT10률은 높지만 GOOD/TRAP 균형 나쁨 — S-GT 분류 금지',
      },
      'HIGH-RISK': {
        title: '강한 추격 주의',
        prevConditions: 'recent5Up15Count ≥ 3 (연속 급등 과열)',
        intradayConditions: 'gapRate ≥ 12% 갭상승 추격',
        notes: '실전 진입 비추천 — 표시만',
      },
      'QVA_TAG': {
        title: 'QVA 보조 태그 (점수 가점 X)',
        prevConditions: 'D-15~D-20 QVA 선행 신호 보유 시 표시만',
        intradayConditions: '-',
        notes: 'v3 결론 그대로 — 단독 가점 금지, 참고 태그만',
      },
    };

    // 최종 결론 정리 메시지
    const finalNotes = [];
    finalNotes.push('🔄 HIT10 중심 보드 → GOOD_TRADE 중심 보드로 전환 권고.');
    finalNotes.push('⚠ 상한가형(dayChangeRate ≥ 29%)은 HIT10 71.6%지만 GOOD 24.5% / TRAP 45.8% — S-GT가 아니라 MOM-RISK 또는 HIGH-RISK.');
    finalNotes.push('🕯 LOW_GAP_INTRADAY 캔들이 GAP_HOLD보다 실전성 명확 (GOOD 29% vs 22%, TRAP 17% vs 43%).');
    finalNotes.push('💰 v/mc ≥ 5% + mc 3000억~7000억은 실전 후보의 핵심 결합.');
    finalNotes.push('🚪 gapRate < 7%는 다음날 시초가 확인 후에만 알 수 있으므로 장초 확인 조건 — 전일 예비 조건이 아님.');
    finalNotes.push('🥇 거래대금 순위 상위 10/30위는 강한 보조 조건.');
    finalNotes.push('🔁 최근 5일 +15% 1회가 sweet spot, 3회 이상은 과열.');
    if (c.v4.gtMeetsGoals && c.v4.gtMeetsGoals.length) {
      finalNotes.push(`✅ 목표(GOOD≥30, TRAP≤10, openFail-5≤30, n≥50) 달성 조합: ${c.v4.gtMeetsGoals.map(x => x.key).join(', ')}`);
    } else {
      finalNotes.push('⚠ 목표(GOOD≥30, TRAP≤10, openFail-5≤30, n≥50) 모두 충족하는 조합 없음 — 어느 한쪽 양보 필요. gtScore 상위 조합 중 N≥50 조건을 검토.');
    }
    c.v4.finalNotes = finalNotes;
  }

  // ── v4-extra2: 경량 GOOD_TRADE 결론 ──
  if (Array.isArray(lightGtCombos)) {
    const lgcByKey = Object.fromEntries(lightGtCombos.map(x => [x.key, x]));
    c.v4.lightGt = {
      combos: lightGtCombos,
      bestByScore: [...lightGtCombos]
        .filter(c2 => isNum(c2.gtScore))
        .sort((a, b) => b.gtScore - a.gtScore)
        .slice(0, 5)
        .map(c2 => ({ key: c2.key, label: c2.label, n: c2.count, goodTradeRate: c2.goodTradeRate, trapRate: c2.trapRate, openFail5Rate: c2.openFail5Rate, gtScore: c2.gtScore, reliability: c2.reliability, meetsGoals: c2.meetsGoals })),
      meetsGoals: lightGtCombos.filter(c2 => c2.meetsGoals).map(c2 => ({ key: c2.key, label: c2.label, n: c2.count, goodTradeRate: c2.goodTradeRate, trapRate: c2.trapRate, openFail5Rate: c2.openFail5Rate, gtScore: c2.gtScore })),
    };

    // 5가지 질문에 대한 자동 답변
    const qa = {};
    // Q1: 1000~3000억 경량주에서 GOOD 높은 조건?
    const lightCombos = lightGtCombos.filter(x => ['B','C','D','E','F','G','H','I'].includes(x.key) && x.count >= N_REFERENCE);
    const bestLight = lightCombos.filter(x => isNum(x.gtScore)).sort((a, b) => b.gtScore - a.gtScore)[0];
    if (bestLight) {
      qa.q1 = `있음. 경량 (mc 1000~3000억) best: <strong>${bestLight.key}</strong> n=${bestLight.count} GOOD ${bestLight.goodTradeRate.toFixed(1)}% / TRAP ${bestLight.trapRate.toFixed(1)}% / gtScore ${bestLight.gtScore.toFixed(1)}` + (bestLight.meetsGoals ? ' ✅ 목표 달성' : '');
    } else {
      qa.q1 = '경량 후보군 표본 부족 — 결론 보류.';
    }
    // Q2: 500~1000억 초경량은?
    const microJ = lgcByKey.J, microK = lgcByKey.K;
    if (microJ && microK) {
      qa.q2 = `초경량 J 기본 n=${microJ.count} GOOD ${(microJ.goodTradeRate||0).toFixed(1)}% / TRAP ${(microJ.trapRate||0).toFixed(1)}% / openFail-5% ${(microJ.openFail5Rate||0).toFixed(1)}%` +
              (microK.count >= N_REFERENCE ? ` → 위험 제한 K n=${microK.count} GOOD ${(microK.goodTradeRate||0).toFixed(1)}% / TRAP ${(microK.trapRate||0).toFixed(1)}% (${microK.gtScore > microJ.gtScore ? '제한 후 개선' : '제한해도 개선 미미'})` : ` → K 표본 부족(n=${microK.count}) — 제한 효과 보류`);
    }
    // Q3: 균형형 3000~7000억이 여전히 best?
    if (lightGtMatrix) {
      const balanced = lightGtMatrix.find(g => g.group === 'BALANCED');
      const light = lightGtMatrix.find(g => g.group === 'LIGHT');
      const balC1 = balanced?.cells.find(c2 => c2.sub === 'C1');
      const lightC1 = light?.cells.find(c2 => c2.sub === 'C1');
      if (balC1 && lightC1 && isNum(balC1.gtScore) && isNum(lightC1.gtScore)) {
        const diff = balC1.gtScore - lightC1.gtScore;
        qa.q3 = `균형형 v/mc≥5+gap<7 gtScore ${balC1.gtScore.toFixed(1)} (n=${balC1.count}) vs 경량 ${lightC1.gtScore.toFixed(1)} (n=${lightC1.count}) — ${Math.abs(diff) < 2 ? '거의 동등' : (diff > 0 ? '균형형 우위' : '경량형 우위')}`;
      }
    }
    // Q4: 3000억 이상만 쓰면 놓치는 좋은 후보?
    const lightBest = lightCombos.filter(x => x.count >= N_RELIABLE && isNum(x.gtScore)).sort((a, b) => b.gtScore - a.gtScore)[0];
    if (lightBest && lightBest.gtScore >= 18) {
      qa.q4 = `있음. 경량 ${lightBest.key} (gtScore ${lightBest.gtScore.toFixed(1)}, n=${lightBest.count})은 GT_BASE 평균(gtScore 24.0)에 근접 — 보드 LIGHT-GT 그룹 분리 가치 있음.`;
    } else {
      qa.q4 = '경량 best가 GT_BASE 대비 명확한 우위는 아님 — 균형형 단일 그룹으로 충분할 가능성.';
    }
    // Q5: 경량 별도 그룹 여부
    if (lightBest && lightBest.count >= N_RELIABLE) {
      qa.q5 = `<strong>권장</strong>: LIGHT-GT 별도 그룹 (best ${lightBest.key} n=${lightBest.count}, gtScore ${lightBest.gtScore.toFixed(1)}). 균형형 BALANCED-GT와 병렬 운영. 초경량은 MICRO-RISK로 표시만 (실전 진입 비추천).`;
    } else {
      qa.q5 = '경량 표본이 작아 별도 그룹 권장은 보류. BALANCED-GT 단일 그룹으로 시작 후 데이터 누적 시 LIGHT-GT 분리 검토.';
    }
    c.v4.lightGt.qa = qa;

    // 그룹 라벨 제안
    c.v4.lightGroupNames = {
      'LIGHT-GT':    '경량 단타 후보 (mc 1000~3000억) — 별도 그룹',
      'BALANCED-GT': '균형형 단타 후보 (mc 3000~7000억) — 메인 그룹',
      'MICRO-RISK':  '초경량 고위험 후보 (mc 500~1000억) — 표시만, 실전 진입 비추천',
    };
  }

  // ─── v5: 위험 제거 연구 결론 ───
  c.v5 = {};

  // 1) GOOD vs TRAP 가장 잘 가르는 지표 TOP 5
  if (Array.isArray(goodVsTrapCompare)) {
    c.v5.topGtVsTrapMetrics = goodVsTrapCompare
      .filter(x => isNum(x.relDiff))
      .map(x => ({ ...x, abs: Math.abs(x.relDiff) }))
      .sort((a, b) => b.abs - a.abs)
      .slice(0, 5)
      .map(x => ({ label: x.label, gMean: x.gMean, tMean: x.tMean, diff: x.diff, relDiff: x.relDiff, interp: x.interp }));
  }

  // 2~4) 위험 룰 / 안전형 룰
  c.v5.topByTrapHigh    = (ruleSearchV2 && ruleSearchV2.topByTrapHigh    || []).slice(0, 5);
  c.v5.topByNoEntryHigh = (ruleSearchV2 && ruleSearchV2.topByNoEntryHigh || []).slice(0, 5);
  c.v5.topByOverheatHigh = (ruleSearchV2 && ruleSearchV2.topByOverheatHigh || []).slice(0, 5);
  c.v5.topBySafeGtScore = (ruleSearchV2 && ruleSearchV2.topBySafeGtScore || []).slice(0, 5);
  c.v5.topMeetsSafeGoals = (ruleSearchV2 && ruleSearchV2.topMeetsSafeGoals || []).slice(0, 10);

  // 5) 다음날 갭 예측 — 각 차원 best (gapRiskRate 가장 높은 버킷)
  if (gapPredictTabs && typeof gapPredictTabs === 'object') {
    const flat = [];
    for (const [dim, rows] of Object.entries(gapPredictTabs)) {
      for (const r of (rows || [])) {
        if (r.count >= 30 && isNum(r.gapRiskRate)) flat.push({ dim, label: r.label, count: r.count, gapRiskRate: r.gapRiskRate, bigGapRiskRate: r.bigGapRiskRate, trapRate: r.trapRate });
      }
    }
    c.v5.topGapPredictors = flat.sort((a, b) => b.gapRiskRate - a.gapRiskRate).slice(0, 5);
  }

  // 6) LOW_GAP_INTRADAY 정밀 정의 — matrixGapVsOpenClose 의 가장 안전한 셀
  if (matrixGapVsOpenClose && Array.isArray(matrixGapVsOpenClose.cells)) {
    const safeCells = matrixGapVsOpenClose.cells
      .filter(c2 => c2.count >= 30 && isNum(c2.goodTradeRate) && isNum(c2.trapRate))
      .map(c2 => ({ ...c2, safeScore: c2.goodTradeRate - c2.trapRate * 1.5 - (c2.gapRiskRate || 0) * 0.3 }))
      .sort((a, b) => b.safeScore - a.safeScore)
      .slice(0, 3);
    c.v5.bestLowGapCells = safeCells.map(c2 => ({
      label: `${c2.yLabel} × ${c2.xLabel}`, count: c2.count,
      goodTradeRate: c2.goodTradeRate, trapRate: c2.trapRate, gapRiskRate: c2.gapRiskRate,
      safeScore: c2.safeScore,
    }));
  }

  // 7) recent5Up15 × v/mc 최적
  if (matrixR5VsVmc && Array.isArray(matrixR5VsVmc.cells)) {
    const safeR5 = matrixR5VsVmc.cells
      .filter(c2 => c2.count >= 30 && isNum(c2.goodTradeRate))
      .map(c2 => ({ ...c2, safeScore: c2.goodTradeRate - (c2.trapRate || 0) * 1.5 - (c2.noEntryZoneRate || 0) * 0.3 }))
      .sort((a, b) => b.safeScore - a.safeScore)
      .slice(0, 3);
    c.v5.bestR5VmcCells = safeR5.map(c2 => ({
      label: `${c2.yLabel} × ${c2.xLabel}`, count: c2.count,
      goodTradeRate: c2.goodTradeRate, trapRate: c2.trapRate, noEntryZoneRate: c2.noEntryZoneRate,
    }));
  }

  // 8) 시총 구간별 추천 — 각 그룹의 safeGt 1위
  if (perMcRuleSearch && typeof perMcRuleSearch === 'object') {
    const perMcBest = {};
    for (const [k, g] of Object.entries(perMcRuleSearch)) {
      const top = (g.topSafeGt || [])[0] || (g.topGood || [])[0];
      if (top) {
        perMcBest[k] = {
          groupLabel: g.groupLabel, n: top.n,
          goodTradeRate: top.goodTradeRate, trapRate: top.trapRate,
          openFail5Rate: top.openFail5Rate, safeGtScore: top.safeGtScore,
          label: top.label,
        };
      }
    }
    c.v5.perMcBest = perMcBest;
  }

  // 9) 보드에 즉시 반영 가능한 위험 태그
  c.v5.boardRiskTags = [];
  if ((c.v5.topGapPredictors || []).length) {
    for (const p of c.v5.topGapPredictors.slice(0, 3)) {
      c.v5.boardRiskTags.push(`${p.dim}=${p.label} (n=${p.count}) 다음날 갭 ≥7% 발생률 ${p.gapRiskRate.toFixed(1)}% — "다음날 갭 과열 가능성" 태그 표시`);
    }
  }
  if ((c.v5.topByTrapHigh || []).length) {
    const top1 = c.v5.topByTrapHigh[0];
    c.v5.boardRiskTags.push(`TRAP 최고 위험 룰: ${top1.label} (n=${top1.n}, TRAP ${(top1.trapRate||0).toFixed(1)}%) — 보드 하단 또는 경고 표시`);
  }

  // 10) 보류
  c.v5.onHold = [];
  if ((c.v5.topMeetsSafeGoals || []).length === 0) {
    c.v5.onHold.push('GOOD≥28 + TRAP≤8 + openFail-5≤40 + n≥50 모두 충족 룰 없음 — 한쪽 양보 필요. safeGtScore 상위 룰 검토.');
  }
  c.v5.onHold.push('분봉 데이터 없음 — ENTRY_CONFIRM 연구 보류. 일봉만으로는 진입 신호가 아닌 위험 제거 필터로만 사용.');

  return c;
}

// ── 메인 ──
function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(CHART_DIR)) {
    console.error('[ERROR] cache/stock-charts-long 디렉토리가 없습니다.');
    process.exit(1);
  }

  console.log(`\n📊 1-Day Surge HIT10 연구 보고서 v3 (windowDays=${VALIDATION_DAYS})`);
  const t0 = Date.now();
  const metaMap = loadStockMetaMap();
  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`  메타: ${metaMap.size}건 / 차트 파일: ${files.length}건`);

  const events = [];
  let stocksProcessed = 0, stocksFiltered = 0;
  let totalQvaCalls = 0, totalQvaPassed = 0;

  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    const filt = core.passesHardFilter(meta);
    if (!filt.ok) { stocksFiltered++; continue; }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, f), 'utf-8')); }
    catch (_) { continue; }
    const rows = chart && chart.rows;
    if (!Array.isArray(rows) || rows.length < core.CONFIG.MIN_HISTORY) continue;

    // 1) 이벤트 후보 생성
    const lastUsableIdx = rows.length - 2;
    const startIdx = Math.max(20, lastUsableIdx - VALIDATION_DAYS + 1);
    const codeEvents = [];
    for (let bi = startIdx; bi <= lastUsableIdx; bi++) {
      const ev = evaluateAt(rows, bi, meta.marketCap);
      if (!ev) continue;
      ev.code = code;
      ev.name = chart.name || meta.name || code;
      ev.market = chart.market || meta.market || '';
      codeEvents.push(ev);
    }

    if (codeEvents.length > 0) {
      // 2) 이 코드의 QVA 통과 인덱스 사전 계산
      // 필요 범위: minBaseIdx-QVA_LOOKBACK ~ maxBaseIdx-1 (baseDate 이전 신호만)
      let minBI = Infinity, maxBI = -Infinity;
      for (const ev of codeEvents) {
        if (ev.baseIdx < minBI) minBI = ev.baseIdx;
        if (ev.baseIdx > maxBI) maxBI = ev.baseIdx;
      }
      const qvaScanStart = Math.max(60, minBI - QVA_LOOKBACK); // QVA는 chartRows.length>=60 필요
      const qvaScanEnd = maxBI - 1;
      const qvaPassedIdx = new Set();
      const psMeta = { isSpecial: meta.isSpecial, isEtf: meta.isEtf, marketValue: meta.marketCap };
      if (qvaScanEnd >= qvaScanStart) {
        for (let qi = qvaScanStart; qi <= qvaScanEnd; qi++) {
          if (qi < 0 || qi >= rows.length) continue;
          const sub = rows.slice(0, qi + 1);
          totalQvaCalls++;
          let r = null;
          // 운영 보드(qva-watchlist-board.js)와 동일한 calculateRedefinedQVA 사용
          try { r = pscore.calculateRedefinedQVA(sub, [], psMeta); }
          catch (_) { r = null; }
          if (r && r.passed) { qvaPassedIdx.add(qi); totalQvaPassed++; }
        }
      }

      // 3) 각 event에 prior QVA 메타 부착
      for (const ev of codeEvents) {
        const lookbackHits = [];
        for (let qi = ev.baseIdx - 1; qi >= ev.baseIdx - QVA_LOOKBACK; qi--) {
          if (qi < 0) break;
          if (qvaPassedIdx.has(qi)) lookbackHits.push(qi);
        }
        ev.priorQvaCount = lookbackHits.length;
        ev.hasPriorQva20 = lookbackHits.length > 0;
        if (lookbackHits.length > 0) {
          // 가장 최근 (baseIdx에서 가장 가까운) = 첫 번째 (역순 push이므로)
          const mostRecentQi = lookbackHits[0];
          ev.mostRecentPriorQvaGap = ev.baseIdx - mostRecentQi;
          ev.mostRecentPriorQvaDate = rows[mostRecentQi]?.date || null;
        }
        events.push(ev);
      }
    }

    stocksProcessed++;
    if (VALIDATION_MAX_STOCKS > 0 && stocksProcessed >= VALIDATION_MAX_STOCKS) break;
  }

  // type 태그
  for (const e of events) {
    e.hit10Type = classifyHit10Type(e);
    e.t1Subtype = classifyT1Subtype(e);
  }

  // v4: 일자 내 거래대금 순위 (시장 전체 — 같은 baseDate 안에서 valueAmount 내림차순 rank)
  const _eventsByDate = new Map();
  for (const e of events) {
    if (!_eventsByDate.has(e.baseDate)) _eventsByDate.set(e.baseDate, []);
    _eventsByDate.get(e.baseDate).push(e);
  }
  for (const list of _eventsByDate.values()) {
    list.sort((a, b) => (b.valueAmount || 0) - (a.valueAmount || 0));
    list.forEach((e, idx) => { e.dailyValueRank = idx + 1; });
  }

  const hit10Events = events.filter(e => e.hit10);
  const nonEvents = events.filter(e => !e.hit10);
  const baseRate = events.length ? (hit10Events.length / events.length * 100) : 0;
  const baseFailClose = events.length ? (events.filter(e => e.failCloseMinus3).length / events.length * 100) : 0;
  const baseFailLow = events.length ? (events.filter(e => e.failLowMinus5).length / events.length * 100) : 0;
  const baseOpenFail5 = events.length ? (events.filter(e => e.openFailMinus5).length / events.length * 100) : 0;

  console.log(`  처리 종목: ${stocksProcessed} / 필터 제외: ${stocksFiltered} / 분류 이벤트: ${events.length} / HIT10: ${hit10Events.length} (${baseRate.toFixed(1)}%)`);
  console.log(`  base failClose: ${baseFailClose.toFixed(1)}% / base failLow: ${baseFailLow.toFixed(1)}% / base openFail5: ${baseOpenFail5.toFixed(1)}%`);
  console.log(`  QVA 호출: ${totalQvaCalls.toLocaleString()}건 / 통과: ${totalQvaPassed.toLocaleString()}건 (통과율 ${totalQvaCalls > 0 ? (totalQvaPassed/totalQvaCalls*100).toFixed(2) : '0'}%)`);
  const eventsWithQva = events.filter(e => e.hasPriorQva20).length;
  console.log(`  prior QVA 보유 이벤트: ${eventsWithQva.toLocaleString()} / ${events.length.toLocaleString()} (${(eventsWithQva/events.length*100).toFixed(1)}%)`);

  // ── 핵심 요약 ──
  const summary = {
    totalEvents: events.length,
    hit10Count: hit10Events.length,
    hit10Rate: baseRate,
    nonHit10Count: nonEvents.length,
    avgNextOpen: safeMean(events.map(e => e.nextOpenRate)),
    avgNextHigh: safeMean(events.map(e => e.nextHighRate)),
    avgNextClose: safeMean(events.map(e => e.nextCloseRate)),
    avgNextLow: safeMean(events.map(e => e.nextLowRate)),
    hit3Rate: safeRate(events.filter(e => e.hit3).length, events.length),
    hit5Rate: safeRate(events.filter(e => e.hit5).length, events.length),
    hit10RateAlias: baseRate,
    failCloseRate: baseFailClose,
    failGapDownRate: safeRate(events.filter(e => e.failOpenGapDown3).length, events.length),
    failLowPlungeRate: baseFailLow,
    // open-base
    openHit3Rate: safeRate(events.filter(e => e.openHit3).length, events.length),
    openHit5Rate: safeRate(events.filter(e => e.openHit5).length, events.length),
    openHit10Rate: safeRate(events.filter(e => e.openHit10).length, events.length),
    openFail3Rate: safeRate(events.filter(e => e.openFailMinus3).length, events.length),
    openFail5Rate: baseOpenFail5,
    avgNextHighFromOpen: safeMean(events.map(e => e.nextHighFromOpenRate)),
    avgNextLowFromOpen: safeMean(events.map(e => e.nextLowFromOpenRate)),
    avgNextCloseFromOpen: safeMean(events.map(e => e.nextCloseFromOpenRate)),
    // v4: GOOD_TRADE / GREAT_TRADE / TRAP
    goodTradeRate:  safeRate(events.filter(e => e.goodTrade).length, events.length),
    greatTradeRate: safeRate(events.filter(e => e.greatTrade).length, events.length),
    trapRate:       safeRate(events.filter(e => e.trap).length, events.length),
    // v5: 위험 비율
    gapRiskRate:      safeRate(events.filter(e => e.gapRisk).length, events.length),
    bigGapRiskRate:   safeRate(events.filter(e => e.bigGapRisk).length, events.length),
    overheatTrapRate: safeRate(events.filter(e => e.overheatTrap).length, events.length),
    noEntryZoneRate:  safeRate(events.filter(e => e.noEntryZone).length, events.length),
  };

  const comparison = compareMetrics(hit10Events, nonEvents);

  // 1차원 cross-tabs
  const crossTabs = {
    valueRatio: bucketize(events, e => e.valueRatio, [
      { label: '1.5~2배', min: 1.5, max: 2 }, { label: '2~3배', min: 2, max: 3 },
      { label: '3~5배', min: 3, max: 5 }, { label: '5~10배', min: 5, max: 10 },
      { label: '10배 이상', min: 10, max: null },
    ]),
    marketCap: bucketize(events, e => e.marketCap, [
      { label: '500억~1,000억', min: 5e10, max: 1e11 }, { label: '1,000억~3,000억', min: 1e11, max: 3e11 },
      { label: '3,000억~7,000억', min: 3e11, max: 7e11 }, { label: '7,000억~1.5조', min: 7e11, max: 1.5e12 },
      { label: '1.5조~3조', min: 1.5e12, max: 3e12 }, { label: '3조 이상', min: 3e12, max: null },
    ]),
    closePosition: bucketize(events, e => e.closePosition, [
      { label: '0.0~0.4', min: 0, max: 0.4 }, { label: '0.4~0.6', min: 0.4, max: 0.6 },
      { label: '0.6~0.75', min: 0.6, max: 0.75 }, { label: '0.75~0.9', min: 0.75, max: 0.9 },
      { label: '0.9~1.0', min: 0.9, max: null },
    ]),
    upperTailRatio: bucketize(events, e => e.upperTailRatio, [
      { label: '0~0.2', min: 0, max: 0.2 }, { label: '0.2~0.35', min: 0.2, max: 0.35 },
      { label: '0.35~0.5', min: 0.35, max: 0.5 }, { label: '0.5~0.7', min: 0.5, max: 0.7 },
      { label: '0.7 이상', min: 0.7, max: null },
    ]),
    dayChangeRate: bucketize(events, e => e.dayChangeRate, [
      { label: '0~3%', min: 0, max: 3 }, { label: '3~7%', min: 3, max: 7 },
      { label: '7~12%', min: 7, max: 12 }, { label: '12~20%', min: 12, max: 20 },
      { label: '20% 이상', min: 20, max: null },
    ]),
    recent3Rate: bucketize(events, e => e.recent3Rate, [
      { label: '0~5%', min: 0, max: 5 }, { label: '5~10%', min: 5, max: 10 },
      { label: '10~20%', min: 10, max: 20 }, { label: '20~35%', min: 20, max: 35 },
      { label: '35% 이상', min: 35, max: null },
    ]),
    recent5Rate: bucketize(events, e => e.recent5Rate, [
      { label: '0~10%', min: 0, max: 10 }, { label: '10~20%', min: 10, max: 20 },
      { label: '20~35%', min: 20, max: 35 }, { label: '35~50%', min: 35, max: 50 },
      { label: '50% 이상', min: 50, max: null },
    ]),
    score: bucketize(events, e => e.oneDaySurgeScore, [
      { label: '95 이상', min: 95, max: null }, { label: '85~94', min: 85, max: 95 },
      { label: '75~84', min: 75, max: 85 }, { label: '65~74', min: 65, max: 75 },
      { label: '55~64', min: 55, max: 65 }, { label: '35~54', min: 35, max: 55 },
    ]),
  };
  const groupTab = ['A', 'B', 'C', 'D'].map(g => ({ label: g, ...summarizeBucket(events.filter(e => e.group === g)) }));

  // 2D cross-tabs
  const dayChgBands = [
    { label: '0~3%', min: 0, max: 3 }, { label: '3~7%', min: 3, max: 7 },
    { label: '7~12%', min: 7, max: 12 }, { label: '12~20%', min: 12, max: 20 },
    { label: '20% 이상', min: 20, max: null },
  ];
  const closePosBands2D = [
    { label: '0.0~0.6', min: 0, max: 0.6 }, { label: '0.6~0.8', min: 0.6, max: 0.8 },
    { label: '0.8~0.9', min: 0.8, max: 0.9 }, { label: '0.9~1.0', min: 0.9, max: null },
  ];
  const tailBands = [
    { label: '0~0.2', min: 0, max: 0.2 }, { label: '0.2~0.35', min: 0.2, max: 0.35 },
    { label: '0.35~0.5', min: 0.35, max: 0.5 }, { label: '0.5~0.7', min: 0.5, max: 0.7 },
    { label: '0.7 이상', min: 0.7, max: null },
  ];
  const valBandsCoarse = [
    { label: '2~3배', min: 2, max: 3 }, { label: '3~5배', min: 3, max: 5 },
    { label: '5~10배', min: 5, max: 10 }, { label: '10배 이상', min: 10, max: null },
  ];
  const recent5Bands = [
    { label: '0~10%', min: 0, max: 10 }, { label: '10~20%', min: 10, max: 20 },
    { label: '20~35%', min: 20, max: 35 }, { label: '35~50%', min: 35, max: 50 },
    { label: '50% 이상', min: 50, max: null },
  ];
  const recent3Bands = [
    { label: '0~5%', min: 0, max: 5 }, { label: '5~10%', min: 5, max: 10 },
    { label: '10~20%', min: 10, max: 20 }, { label: '20~35%', min: 20, max: 35 },
    { label: '35% 이상', min: 35, max: null },
  ];
  const mcBands = [
    { label: '500억~1,000억', min: 5e10, max: 1e11 }, { label: '1,000억~3,000억', min: 1e11, max: 3e11 },
    { label: '3,000억~7,000억', min: 3e11, max: 7e11 }, { label: '7,000억~1.5조', min: 7e11, max: 1.5e12 },
    { label: '1.5조~3조', min: 1.5e12, max: 3e12 }, { label: '3조 이상', min: 3e12, max: null },
  ];

  const crossTabs2D = {
    A_dayChg_x_closePos: { title: 'A. 전일 등락률 × 종가 위치', xLabel: '전일 등락률', yLabel: '종가 위치',
      ...bucketize2D(events, e => e.dayChangeRate, dayChgBands, e => e.closePosition, closePosBands2D) },
    B_dayChg_x_tail: { title: 'B. 전일 등락률 × 윗꼬리 비율', xLabel: '전일 등락률', yLabel: '윗꼬리 비율',
      ...bucketize2D(events, e => e.dayChangeRate, dayChgBands, e => e.upperTailRatio, tailBands) },
    C_value_x_dayChg: { title: 'C. 거래대금 배율 × 전일 등락률', xLabel: '전일 등락률', yLabel: '거래대금 배율',
      ...bucketize2D(events, e => e.dayChangeRate, dayChgBands, e => e.valueRatio, valBandsCoarse) },
    D_recent5_x_tail: { title: 'D. 최근 5일 상승률 × 윗꼬리 비율', xLabel: '윗꼬리 비율', yLabel: '최근 5일',
      ...bucketize2D(events, e => e.upperTailRatio, tailBands, e => e.recent5Rate, recent5Bands) },
    E_recent3_x_closePos: { title: 'E. 최근 3일 상승률 × 종가 위치', xLabel: '종가 위치', yLabel: '최근 3일',
      ...bucketize2D(events, e => e.closePosition, closePosBands2D, e => e.recent3Rate, recent3Bands) },
    F_mc_x_dayChg: { title: 'F. 시총 × 전일 등락률', xLabel: '전일 등락률', yLabel: '시가총액',
      ...bucketize2D(events, e => e.dayChangeRate, dayChgBands, e => e.marketCap, mcBands) },
  };

  // HIT10 유형
  const hit10Types = {};
  for (const t of ['TYPE_1_STRONG_CLOSE', 'TYPE_2_TAIL_REBREAK', 'TYPE_3_FIRST_VALUE_SURGE', 'TYPE_ETC']) {
    hit10Types[t] = summarizeBucket(events.filter(e => e.hit10Type === t));
  }
  const T1_DEFS = {
    T1_E_LIMIT_UP_STYLE:        { label: 'T1_E 상한가형 (≥20% + cp≥0.9 + tail≤0.2)' },
    T1_A_SUPER_CLOSE_VALUE:     { label: 'T1_A 초강마감 + 폭증' },
    T1_B_SUPER_CLOSE_LOW_VALUE: { label: 'T1_B 초강마감 + 보통배율' },
    T1_C_GOOD_CLOSE_HIGH_VALUE: { label: 'T1_C 좋은마감 + 폭증' },
    T1_D_GOOD_CLOSE_NORMAL_VALUE: { label: 'T1_D 좋은마감 + 보통배율' },
    TYPE_1_OTHER:               { label: 'TYPE_1_OTHER' },
  };
  const type1Subtypes = {};
  for (const t of Object.keys(T1_DEFS)) {
    type1Subtypes[t] = { ...T1_DEFS[t], ...summarizeBucket(events.filter(e => e.t1Subtype === t)) };
  }

  // 룰 탐색
  console.log(`  ── 룰 조합 자동 탐색 시작...`);
  const ruleT1 = Date.now();
  const rules = generateRules();
  let n30 = 0, n50 = 0;
  const evaluated = [];
  for (const r of rules) {
    const result = evaluateRule(events, r.tests);
    if (result.n < N_REFERENCE) continue;
    n30++;
    if (result.n >= N_RELIABLE) n50++;
    const lift = isNum(result.hit10Rate) ? result.hit10Rate - baseRate : null;
    const riskAdj = isNum(result.hit10Rate)
      ? result.hit10Rate - (result.failCloseRate || 0) * 0.5 - (result.failLowPlungeRate || 0) * 0.3
      : null;
    evaluated.push({ label: r.label, conds: r.conds, activeCount: r.activeCount, ...result, lift, riskAdj });
  }
  console.log(`  ── 룰 ${rules.length}건 중 n≥${N_REFERENCE}: ${n30}건, n≥${N_RELIABLE}: ${n50}건 (${Date.now() - ruleT1}ms)`);

  const topByHit10 = [...evaluated].sort((a, b) => (b.hit10Rate || 0) - (a.hit10Rate || 0)).slice(0, TOP_RULE_KEEP);
  const topByRiskAdj = [...evaluated].sort((a, b) => (b.riskAdj || 0) - (a.riskAdj || 0)).slice(0, TOP_RULE_KEEP);
  const reliable = evaluated.filter(r => r.n >= N_RELIABLE && isNum(r.hit10Rate));
  const highQuality = reliable
    .filter(r => r.hit10Rate >= baseRate + 10
              && (r.failCloseRate || 0) <= baseFailClose * 1.2
              && (r.failLowPlungeRate || 0) <= baseFailLow * 1.2)
    .sort((a, b) => b.hit10Rate - a.hit10Rate).slice(0, 30);
  const highRisk = reliable
    .filter(r => r.hit10Rate >= baseRate + 10
              && ((r.failCloseRate || 0) >= baseFailClose * 1.5
                  || (r.failLowPlungeRate || 0) >= baseFailLow * 1.5))
    .sort((a, b) => b.hit10Rate - a.hit10Rate).slice(0, 30);
  const ruleSearch = { totalRulesEvaluated: rules.length, rulesWithNGte30: n30, rulesWithNGte50: n50, topByHit10, topByRiskAdj, highQuality, highRisk };

  // ─── v3 추가: 명명된 조건의 prevClose vs open-base 성과 ───
  const namedConditions = NAMED_CONDITIONS.map(nc => ({
    key: nc.key, label: nc.label,
    ...summarizeBucket(events.filter(nc.test)),
  }));

  // ─── v3 추가: 갭 cross-tab ───
  const gapBands = [
    { label: '갭 ≤ 0%',     min: -Infinity, max: 0 },
    { label: '0~3%',        min: 0,  max: 3 },
    { label: '3~7%',        min: 3,  max: 7 },
    { label: '7~12%',       min: 7,  max: 12 },
    { label: '12~20%',      min: 12, max: 20 },
    { label: '20% 이상',    min: 20, max: null },
  ];
  const gapTab = bucketize(events, e => e.nextOpenRate, gapBands);

  // ─── v3 추가: QVA 교차분석 ───
  const eventsWithQ = events.filter(e => e.hasPriorQva20);
  const eventsNoQ   = events.filter(e => !e.hasPriorQva20);
  const hit10WithQ  = eventsWithQ.filter(e => e.hit10);
  const hit10NoQ    = eventsNoQ.filter(e => e.hit10);

  const qvaSummary = {
    totalEvents: events.length,
    hit10Count: hit10Events.length,
    hit10WithQvaCount: hit10WithQ.length,
    hit10WithQvaShare: safeRate(hit10WithQ.length, hit10Events.length),
    nonHit10WithQvaShare: safeRate(eventsWithQ.length - hit10WithQ.length, nonEvents.length),
    eventsWithQvaCount: eventsWithQ.length,
    eventsNoQvaCount: eventsNoQ.length,
    hit10RateWithQva: safeRate(hit10WithQ.length, eventsWithQ.length),
    hit10RateNoQva: safeRate(hit10NoQ.length, eventsNoQ.length),
    failCloseWithQva: safeRate(eventsWithQ.filter(e => e.failCloseMinus3).length, eventsWithQ.length),
    failCloseNoQva: safeRate(eventsNoQ.filter(e => e.failCloseMinus3).length, eventsNoQ.length),
    failLowWithQva: safeRate(eventsWithQ.filter(e => e.failLowMinus5).length, eventsWithQ.length),
    failLowNoQva: safeRate(eventsNoQ.filter(e => e.failLowMinus5).length, eventsNoQ.length),
  };

  const qvaPresenceTab = [
    { label: 'QVA 있음 (D-1~D-20 안 1건 이상)', ...summarizeBucket(eventsWithQ) },
    { label: 'QVA 없음', ...summarizeBucket(eventsNoQ) },
  ];

  // QVA 선행 간격 cross-tab (mostRecentPriorQvaGap 기준)
  const qvaGapTab = [
    { label: 'D-1~D-3',   min: 1,  max: 4 },
    { label: 'D-4~D-7',   min: 4,  max: 8 },
    { label: 'D-8~D-14',  min: 8,  max: 15 },
    { label: 'D-15~D-20', min: 15, max: 21 },
  ].map(b => {
    const sub = events.filter(e => isNum(e.mostRecentPriorQvaGap) && e.mostRecentPriorQvaGap >= b.min && e.mostRecentPriorQvaGap < b.max);
    return { label: b.label, min: b.min, max: b.max, ...summarizeBucket(sub) };
  });
  qvaGapTab.push({ label: 'QVA 없음', min: null, max: null, ...summarizeBucket(eventsNoQ) });

  // S × QVA / R × QVA cross-tab (4-cell 또는 2-cell)
  const sCondTest = NAMED_CONDITIONS.find(x => x.key === 'S_CAND').test;
  const rCondTest = NAMED_CONDITIONS.find(x => x.key === 'R_CAND').test;
  const sCandQvaTab = [
    { label: 'S 후보 + QVA 있음', ...summarizeBucket(events.filter(e => sCondTest(e) && e.hasPriorQva20)) },
    { label: 'S 후보 + QVA 없음', ...summarizeBucket(events.filter(e => sCondTest(e) && !e.hasPriorQva20)) },
    { label: '비S 후보 + QVA 있음', ...summarizeBucket(events.filter(e => !sCondTest(e) && e.hasPriorQva20)) },
    { label: '비S 후보 + QVA 없음', ...summarizeBucket(events.filter(e => !sCondTest(e) && !e.hasPriorQva20)) },
  ];
  const rCandQvaTab = [
    { label: 'R 후보 + QVA 있음', ...summarizeBucket(events.filter(e => rCondTest(e) && e.hasPriorQva20)) },
    { label: 'R 후보 + QVA 없음', ...summarizeBucket(events.filter(e => rCondTest(e) && !e.hasPriorQva20)) },
  ];

  // HIT10 + QVA 상위 100
  const topHit10Qva = [...hit10Events]
    .filter(e => e.hasPriorQva20)
    .sort((a, b) => b.nextHighRate - a.nextHighRate)
    .slice(0, 100);

  // 상위 100 HIT10 (전체)
  const topHit10 = [...hit10Events].sort((a, b) => b.nextHighRate - a.nextHighRate).slice(0, 100);

  const byGroup = {};
  for (const g of ['A', 'B', 'C', 'D']) byGroup[g] = summarizeBucket(events.filter(e => e.group === g));
  byGroup.ALL = summarizeBucket(events);

  // ─────────────────────────────────────────────────────────
  // v4 신규 분석
  // ─────────────────────────────────────────────────────────

  // baseline GOOD/GREAT/TRAP 비율
  const baseGoodTrade  = events.length ? (events.filter(e => e.goodTrade).length  / events.length * 100) : 0;
  const baseGreatTrade = events.length ? (events.filter(e => e.greatTrade).length / events.length * 100) : 0;
  const baseTrap       = events.length ? (events.filter(e => e.trap).length       / events.length * 100) : 0;

  // 1. valueToMarketCapRatio cross-tab
  const valueToMcRatioTab = bucketize(events, e => e.valueToMarketCapRatio, [
    { label: '1% 미만', min: 0, max: 1 },
    { label: '1~3%',   min: 1, max: 3 },
    { label: '3~5%',   min: 3, max: 5 },
    { label: '5~10%',  min: 5, max: 10 },
    { label: '10~20%', min: 10, max: 20 },
    { label: '20% 이상', min: 20, max: null },
  ]);

  // 2. 거래대금 절대값 cross-tab
  const valueAmountTab = bucketize(events, e => e.valueAmount, [
    { label: '50억 미만',     min: 0,    max: 5e9   },
    { label: '50~100억',      min: 5e9,  max: 1e10  },
    { label: '100~300억',     min: 1e10, max: 3e10  },
    { label: '300~700억',     min: 3e10, max: 7e10  },
    { label: '700~1,500억',   min: 7e10, max: 1.5e11},
    { label: '1,500억 이상',  min: 1.5e11, max: null },
  ]);

  // 3. dayChangeRate 세분화
  const dayChangeFineTab = bucketize(events, e => e.dayChangeRate, [
    { label: '0~3%',   min: 0,  max: 3  },
    { label: '3~7%',   min: 3,  max: 7  },
    { label: '7~12%',  min: 7,  max: 12 },
    { label: '12~15%', min: 12, max: 15 },
    { label: '15~20%', min: 15, max: 20 },
    { label: '20~25%', min: 20, max: 25 },
    { label: '25~29%', min: 25, max: 29 },
    { label: '29% 이상', min: 29, max: null },
  ]);

  // 4. 캔들 구조 분류 (배타)
  const CANDLE_LABELS = {
    BIG_GREEN:        '장대양봉 (몸통 ≥60% + cp ≥0.8)',
    GAP_HOLD:         '갭상승 유지형 (gap ≥7% + 시가→종가 ≥0% + cp ≥0.8)',
    LOW_GAP_INTRADAY: '낮은 갭 + 장중 강세 (gap <7% + 시가→종가 ≥10% + cp ≥0.8)',
    UPPER_WICK_GREEN: '윗꼬리 양봉 (양봉 + 윗꼬리 ≥0.35)',
    RED_CLOSE:        '음봉 마감',
    OTHER:            '기타',
  };
  const candleTab = ['RED_CLOSE','UPPER_WICK_GREEN','GAP_HOLD','LOW_GAP_INTRADAY','BIG_GREEN','OTHER'].map(t => ({
    type: t, label: CANDLE_LABELS[t],
    ...summarizeBucket(events.filter(e => e.candleType === t)),
  }));

  // 5. 신고가 / 고점 돌파 (배타 priority: 120 > 60 > 20 > below 0~3 > 3~7 > 7+)
  function highBreakBucket(e) {
    if (!isNum(e.distFromHigh20)) return 'NA';
    if (e.isHigh120Break) return 'HIGH_120';
    if (e.isHigh60Break)  return 'HIGH_60';
    if (e.isHigh20Break)  return 'HIGH_20';
    if (e.distFromHigh20 >= -3) return 'BELOW_0_3';
    if (e.distFromHigh20 >= -7) return 'BELOW_3_7';
    return 'BELOW_7P';
  }
  const HIGH_BREAK_LABELS = {
    HIGH_120:  '120일 신고가 돌파',
    HIGH_60:   '60일 신고가 돌파 (120 미만)',
    HIGH_20:   '20일 신고가 돌파 (60 미만)',
    BELOW_0_3: '20일 고점 아래 0~3%',
    BELOW_3_7: '20일 고점 아래 3~7%',
    BELOW_7P:  '20일 고점 아래 7%↑',
  };
  for (const e of events) e._highBreakBucket = highBreakBucket(e);
  const highBreakTab = ['HIGH_120','HIGH_60','HIGH_20','BELOW_0_3','BELOW_3_7','BELOW_7P'].map(k => ({
    key: k, label: HIGH_BREAK_LABELS[k],
    ...summarizeBucket(events.filter(e => e._highBreakBucket === k)),
  }));

  // 6. 최근 급등 횟수 cross-tab (recent5Up15Count, recent10Up15Count, recent10LimitStyleCount)
  function makeCountTab(getter) {
    const buckets = [
      { label: '0회',     test: v => v === 0 },
      { label: '1회',     test: v => v === 1 },
      { label: '2회',     test: v => v === 2 },
      { label: '3회 이상', test: v => v >= 3 },
    ];
    return buckets.map(b => ({
      label: b.label,
      ...summarizeBucket(events.filter(e => isNum(getter(e)) && b.test(getter(e)))),
    }));
  }
  const recentSurgeTabs = {
    recent5Up7:        makeCountTab(e => e.recent5Up7Count),
    recent5Up15:       makeCountTab(e => e.recent5Up15Count),
    recent10Up7:       makeCountTab(e => e.recent10Up7Count),
    recent10Up15:      makeCountTab(e => e.recent10Up15Count),
    recent10LimitStyle: makeCountTab(e => e.recent10LimitStyleCount),
  };

  // 7. 거래대금 순위 cross-tab (일자 내 valueAmount rank)
  const valueRankTab = [
    { label: '상위 10위',   test: e => e.dailyValueRank <= 10 },
    { label: '상위 11~30위', test: e => e.dailyValueRank > 10 && e.dailyValueRank <= 30 },
    { label: '상위 31~50위', test: e => e.dailyValueRank > 30 && e.dailyValueRank <= 50 },
    { label: '상위 51~100위', test: e => e.dailyValueRank > 50 && e.dailyValueRank <= 100 },
    { label: '101위 이하',  test: e => e.dailyValueRank > 100 },
  ].map(b => ({
    label: b.label,
    ...summarizeBucket(events.filter(e => isNum(e.dailyValueRank) && b.test(e))),
  }));

  // 8. S2/S3 조건 완화 실험
  const S_VARIANTS = [
    { key: 'S_ORIG', label: 'S 원본 (chg≥20% + cp≥0.8 + tail≤0.1 + val×3↑ + r3≥35% or r5≥35% + mc 3000억~7000억)',
      test: e => e.dayChangeRate >= 20 && e.closePosition >= 0.8 && e.upperTailRatio <= 0.1 && e.valueRatio >= 3
              && ((isNum(e.recent3Rate) && e.recent3Rate >= 35) || (isNum(e.recent5Rate) && e.recent5Rate >= 35))
              && e.marketCap >= 3e11 && e.marketCap < 7e11 },
    { key: 'S2_A', label: 'S2-A (tail≤0.2, recent 조건 제거, mc 3000억~7000억)',
      test: e => e.dayChangeRate >= 20 && e.closePosition >= 0.8 && e.upperTailRatio <= 0.2 && e.valueRatio >= 3
              && e.marketCap >= 3e11 && e.marketCap < 7e11 },
    { key: 'S2_B', label: 'S2-B (cp≥0.85 + tail≤0.2 + mc 1000억~7000억)',
      test: e => e.dayChangeRate >= 20 && e.closePosition >= 0.85 && e.upperTailRatio <= 0.2 && e.valueRatio >= 3
              && e.marketCap >= 1e11 && e.marketCap < 7e11 },
    { key: 'S2_C', label: 'S2-C (chg≥15% + cp≥0.9 + tail≤0.1 + mc 3000억~7000억)',
      test: e => e.dayChangeRate >= 15 && e.closePosition >= 0.9 && e.upperTailRatio <= 0.1 && e.valueRatio >= 3
              && e.marketCap >= 3e11 && e.marketCap < 7e11 },
    { key: 'S2_D', label: 'S2-D (tail≤0.15 + valueToMcRatio≥5%, mc 3000억~7000억)',
      test: e => e.dayChangeRate >= 20 && e.closePosition >= 0.8 && e.upperTailRatio <= 0.15
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5
              && e.marketCap >= 3e11 && e.marketCap < 7e11 },
    { key: 'S2_E', label: 'S2-E (val×5↑ + tail≤0.2, mc 3000억~7000억)',
      test: e => e.dayChangeRate >= 20 && e.closePosition >= 0.8 && e.upperTailRatio <= 0.2 && e.valueRatio >= 5
              && e.marketCap >= 3e11 && e.marketCap < 7e11 },
  ];
  const sVariantTab = S_VARIANTS.map(v => {
    const all = events.filter(v.test);
    const withQva15_20 = all.filter(e => e.hasPriorQva20 && isNum(e.mostRecentPriorQvaGap) && e.mostRecentPriorQvaGap >= 15 && e.mostRecentPriorQvaGap <= 20);
    const woQva15_20  = all.filter(e => !(e.hasPriorQva20 && isNum(e.mostRecentPriorQvaGap) && e.mostRecentPriorQvaGap >= 15 && e.mostRecentPriorQvaGap <= 20));
    return {
      key: v.key, label: v.label,
      all: summarizeBucket(all),
      withQva15_20: summarizeBucket(withQva15_20),
      woQva15_20: summarizeBucket(woQva15_20),
    };
  });

  // 9. GOOD_TRADE 룰 자동 탐색 (V2 dimensions)
  console.log(`  ── GOOD_TRADE 룰 자동 탐색 시작...`);
  const ruleV2T1 = Date.now();
  const RULE_DIMENSIONS_V2 = {
    dayChangeRate: [
      { label: 'any',     test: () => true },
      { label: 'chg≥12%', test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 12 },
      { label: 'chg≥15%', test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 15 },
      { label: 'chg≥20%', test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 20 },
      { label: 'chg≥25%', test: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 25 },
    ],
    closePosition: [
      { label: 'any',     test: () => true },
      { label: 'cp≥0.8',  test: e => isNum(e.closePosition) && e.closePosition >= 0.80 },
      { label: 'cp≥0.85', test: e => isNum(e.closePosition) && e.closePosition >= 0.85 },
      { label: 'cp≥0.9',  test: e => isNum(e.closePosition) && e.closePosition >= 0.90 },
    ],
    upperTailRatio: [
      { label: 'any',     test: () => true },
      { label: 'tail≤0.2', test: e => isNum(e.upperTailRatio) && e.upperTailRatio <= 0.20 },
      { label: 'tail≤0.1', test: e => isNum(e.upperTailRatio) && e.upperTailRatio <= 0.10 },
    ],
    valueRatio: [
      { label: 'any',     test: () => true },
      { label: 'val×3↑',  test: e => isNum(e.valueRatio) && e.valueRatio >= 3 },
      { label: 'val×5↑',  test: e => isNum(e.valueRatio) && e.valueRatio >= 5 },
    ],
    valueToMcRatio: [
      { label: 'any',          test: () => true },
      { label: 'v/mc≥3%',      test: e => isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 3 },
      { label: 'v/mc≥5%',      test: e => isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 },
      { label: 'v/mc≥10%',     test: e => isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 10 },
    ],
    marketCap: [
      { label: 'any',          test: () => true },
      { label: 'mc 3000억~7000억', test: e => isNum(e.marketCap) && e.marketCap >= 3e11 && e.marketCap < 7e11 },
      { label: 'mc 1000억~7000억', test: e => isNum(e.marketCap) && e.marketCap >= 1e11 && e.marketCap < 7e11 },
    ],
    baseGap: [
      { label: 'any',  test: () => true },
      { label: 'gap<7%', test: e => isNum(e.baseGapRate) && e.baseGapRate < 7 },
    ],
    high20: [
      { label: 'any',         test: () => true },
      { label: 'high20Break', test: e => e.isHigh20Break === true },
    ],
  };
  function generateRulesV2() {
    const dims = Object.keys(RULE_DIMENSIONS_V2);
    const limits = dims.map(d => RULE_DIMENSIONS_V2[d].length);
    const idx = dims.map(() => 0);
    const rules = [];
    while (true) {
      const conds = {}; const tests = []; let active = 0; const labels = [];
      for (let i = 0; i < dims.length; i++) {
        const opt = RULE_DIMENSIONS_V2[dims[i]][idx[i]];
        conds[dims[i]] = opt.label;
        if (opt.label !== 'any') { active++; labels.push(opt.label); tests.push(opt.test); }
      }
      if (active > 0) rules.push({ id: rules.length, conds, label: labels.join(' · '), activeCount: active, tests });
      let k = dims.length - 1;
      while (k >= 0) { idx[k]++; if (idx[k] < limits[k]) break; idx[k] = 0; k--; }
      if (k < 0) break;
    }
    return rules;
  }
  function evaluateRuleV2(events, tests) {
    let n = 0, closeHit10 = 0, openHit5 = 0, good = 0, great = 0, trap = 0, openFail5 = 0;
    let gapRisk = 0, bigGapRisk = 0, overheatTrap = 0, noEntryZone = 0;
    let sumOpClose = 0, sumOpHigh = 0, sumOpLow = 0;
    outer: for (const e of events) {
      for (const t of tests) { if (!t(e)) continue outer; }
      n++;
      if (e.hit10) closeHit10++;
      if (e.openHit5) openHit5++;
      if (e.goodTrade) good++;
      if (e.greatTrade) great++;
      if (e.trap) trap++;
      if (e.openFailMinus5) openFail5++;
      if (e.gapRisk) gapRisk++;
      if (e.bigGapRisk) bigGapRisk++;
      if (e.overheatTrap) overheatTrap++;
      if (e.noEntryZone) noEntryZone++;
      if (isNum(e.nextCloseFromOpenRate)) sumOpClose += e.nextCloseFromOpenRate;
      if (isNum(e.nextHighFromOpenRate)) sumOpHigh += e.nextHighFromOpenRate;
      if (isNum(e.nextLowFromOpenRate)) sumOpLow += e.nextLowFromOpenRate;
    }
    return {
      n,
      closeHit10Rate: safeRate(closeHit10, n),
      openHit5Rate: safeRate(openHit5, n),
      goodTradeRate: safeRate(good, n),
      greatTradeRate: safeRate(great, n),
      trapRate: safeRate(trap, n),
      openFail5Rate: safeRate(openFail5, n),
      gapRiskRate: safeRate(gapRisk, n),
      bigGapRiskRate: safeRate(bigGapRisk, n),
      overheatTrapRate: safeRate(overheatTrap, n),
      noEntryZoneRate: safeRate(noEntryZone, n),
      avgNextCloseFromOpen: n ? sumOpClose / n : null,
      avgNextHighFromOpen: n ? sumOpHigh / n : null,
      avgNextLowFromOpen: n ? sumOpLow / n : null,
    };
  }
  const rulesV2 = generateRulesV2();
  let n30v2 = 0, n50v2 = 0;
  const evaluatedV2 = [];
  for (const r of rulesV2) {
    const result = evaluateRuleV2(events, r.tests);
    if (result.n < N_REFERENCE) continue;
    n30v2++;
    if (result.n >= N_RELIABLE) n50v2++;
    const liftGood = isNum(result.goodTradeRate) ? result.goodTradeRate - baseGoodTrade : null;
    // 사용자 spec score: GOOD + GREAT*0.5 - TRAP*0.7 - openFail5*0.3
    const score = (isNum(result.goodTradeRate) && isNum(result.greatTradeRate) && isNum(result.trapRate) && isNum(result.openFail5Rate))
      ? result.goodTradeRate + result.greatTradeRate * 0.5 - result.trapRate * 0.7 - result.openFail5Rate * 0.3
      : null;
    evaluatedV2.push({ label: r.label, conds: r.conds, activeCount: r.activeCount, ...result, liftGood, gtScore: score });
  }
  console.log(`  ── V2 룰 ${rulesV2.length}건 중 n≥${N_REFERENCE}: ${n30v2}, n≥${N_RELIABLE}: ${n50v2} (${Date.now() - ruleV2T1}ms)`);

  // v5: safeGtScore 계산 — TRAP 가중치를 더 무겁게 + NO_ENTRY_ZONE 페널티 추가
  for (const r of evaluatedV2) {
    r.safeGtScore = (isNum(r.goodTradeRate) && isNum(r.greatTradeRate) && isNum(r.trapRate) && isNum(r.openFail5Rate))
      ? r.goodTradeRate + (r.greatTradeRate || 0) * 0.5 - r.trapRate * 0.8 - r.openFail5Rate * 0.25 - (r.noEntryZoneRate || 0) * 0.2
      : null;
  }

  const topByGoodTrade   = [...evaluatedV2].sort((a, b) => (b.goodTradeRate || 0) - (a.goodTradeRate || 0)).slice(0, 30);
  const topByGtScore     = [...evaluatedV2].sort((a, b) => (b.gtScore || 0) - (a.gtScore || 0)).slice(0, 30);
  const topByLowestTrap  = [...evaluatedV2]
    .filter(r => r.n >= N_RELIABLE && isNum(r.closeHit10Rate) && r.closeHit10Rate >= baseRate + 5)
    .sort((a, b) => (a.trapRate || 0) - (b.trapRate || 0)).slice(0, 30);
  // v5: 위험 룰 정렬
  const topByTrapHigh    = [...evaluatedV2].filter(r => r.n >= N_REFERENCE).sort((a, b) => (b.trapRate || 0) - (a.trapRate || 0)).slice(0, 30);
  const topByNoEntryHigh = [...evaluatedV2].filter(r => r.n >= N_REFERENCE).sort((a, b) => (b.noEntryZoneRate || 0) - (a.noEntryZoneRate || 0)).slice(0, 30);
  const topByOverheatHigh = [...evaluatedV2].filter(r => r.n >= N_REFERENCE).sort((a, b) => (b.overheatTrapRate || 0) - (a.overheatTrapRate || 0)).slice(0, 30);
  // v5: 안전형 GOOD (목표 GOOD≥28 + TRAP≤8 + openFail5≤40)
  const topBySafeGtScore = [...evaluatedV2]
    .filter(r => r.n >= N_RELIABLE && isNum(r.safeGtScore))
    .sort((a, b) => (b.safeGtScore || 0) - (a.safeGtScore || 0)).slice(0, 30);
  const topMeetsSafeGoals = [...evaluatedV2].filter(r =>
    r.n >= N_RELIABLE
    && (r.goodTradeRate || 0) >= 28
    && (r.trapRate || 0) <= 8
    && (r.openFail5Rate || 0) <= 40
  ).sort((a, b) => (b.safeGtScore || 0) - (a.safeGtScore || 0)).slice(0, 30);

  const ruleSearchV2 = {
    totalRulesEvaluated: rulesV2.length,
    rulesWithNGte30: n30v2, rulesWithNGte50: n50v2,
    topByGoodTrade, topByGtScore, topByLowestTrap,
    topByTrapHigh, topByNoEntryHigh, topByOverheatHigh,
    topBySafeGtScore, topMeetsSafeGoals,
    baseGoodTrade, baseGreatTrade, baseTrap,
  };

  // ─────────────────────────────────────────────────────────
  // v5 신규 분석 1: GOOD vs TRAP 전일 조건 비교
  // ─────────────────────────────────────────────────────────
  const goodEvents = events.filter(e => e.goodTrade);
  const trapEvents = events.filter(e => e.trap);
  const GT_VS_TRAP_METRICS = [
    { key: 'dayChangeRate',          label: '전일 등락률 (%)',        unit: 'pct' },
    { key: 'valueRatio',             label: '거래대금 배율 (×N)',     unit: 'x'   },
    { key: 'valueToMarketCapRatio',  label: '시총 대비 거래대금 (%)', unit: 'pct' },
    { key: 'valueAmount',            label: '거래대금 (원)',          unit: 'won' },
    { key: 'dailyValueRank',         label: '일자내 거래대금 순위',   unit: 'num' },
    { key: 'marketCap',              label: '시가총액 (원)',          unit: 'won' },
    { key: 'recent5Up15Count',       label: '최근 5일 +15% 횟수',     unit: 'num' },
    { key: 'recent10Up15Count',      label: '최근 10일 +15% 횟수',    unit: 'num' },
    { key: 'recent5Rate',            label: '최근 5일 누적 (%)',      unit: 'pct' },
    { key: 'closePosition',          label: '종가 위치 (0~1)',        unit: 'unit' },
    { key: 'upperTailRatio',         label: '윗꼬리 비율 (0~1)',      unit: 'unit' },
    { key: 'highToCloseDropRate',    label: '고점→종가 하락률 (%)',   unit: 'pct' },
    { key: 'baseGapRate',            label: '기준일 갭 (%)',          unit: 'pct' },
    { key: 'baseOpenToCloseRate',    label: '기준일 시가→종가 (%)',   unit: 'pct' },
    { key: 'bodyToRange',            label: '몸통/범위 (0~1)',        unit: 'unit' },
  ];
  const goodVsTrapCompare = GT_VS_TRAP_METRICS.map(({ key, label, unit }) => {
    const gv = goodEvents.map(e => e[key]);
    const tv = trapEvents.map(e => e[key]);
    const gMean = safeMean(gv), gMed = safeMedian(gv);
    const tMean = safeMean(tv), tMed = safeMedian(tv);
    const diff = (isNum(gMean) && isNum(tMean)) ? gMean - tMean : null;
    const relDiff = (isNum(diff) && isNum(tMean) && Math.abs(tMean) > 1e-9) ? diff / Math.abs(tMean) : null;
    let interp = '-';
    if (isNum(diff)) {
      if (Math.abs(relDiff || 0) < 0.05) interp = '거의 차이 없음';
      else if (diff > 0) interp = 'GOOD이 더 큼 → GOOD 식별 단서';
      else interp = 'TRAP이 더 큼 → TRAP 위험 단서';
    }
    return { key, label, unit, gMean, gMed, tMean, tMed, diff, relDiff, interp };
  });

  // ─────────────────────────────────────────────────────────
  // v5 신규 분석 2: 다음날 과열 갭 예측 cross-tabs
  //   각 전일 차원별로 "다음날 갭 ≥7% / ≥12% 가 얼마나 발생하나"
  // ─────────────────────────────────────────────────────────
  const gapPredictTabs = {
    dayChangeRate: bucketize(events, e => e.dayChangeRate, [
      { label: '0~3%', min: 0, max: 3 }, { label: '3~7%', min: 3, max: 7 },
      { label: '7~12%', min: 7, max: 12 }, { label: '12~20%', min: 12, max: 20 },
      { label: '20~25%', min: 20, max: 25 }, { label: '25~29%', min: 25, max: 29 },
      { label: '29% 이상', min: 29, max: null },
    ]),
    candleType: ['RED_CLOSE','UPPER_WICK_GREEN','GAP_HOLD','LOW_GAP_INTRADAY','BIG_GREEN','OTHER'].map(t => ({
      label: t, ...summarizeBucket(events.filter(e => e.candleType === t)),
    })),
    valueToMcRatio: bucketize(events, e => e.valueToMarketCapRatio, [
      { label: '1~3%', min: 1, max: 3 }, { label: '3~5%', min: 3, max: 5 },
      { label: '5~10%', min: 5, max: 10 }, { label: '10~20%', min: 10, max: 20 },
      { label: '20% 이상', min: 20, max: null },
    ]),
    recent5Up15Count: [0, 1, 2].map(v => ({
      label: v + '회', ...summarizeBucket(events.filter(e => e.recent5Up15Count === v)),
    })).concat([{
      label: '3회 이상', ...summarizeBucket(events.filter(e => e.recent5Up15Count >= 3)),
    }]),
    marketCap: bucketize(events, e => e.marketCap, [
      { label: '500억~1,000억', min: 5e10, max: 1e11 }, { label: '1,000억~3,000억', min: 1e11, max: 3e11 },
      { label: '3,000억~7,000억', min: 3e11, max: 7e11 }, { label: '7,000억~1.5조', min: 7e11, max: 1.5e12 },
      { label: '1.5조~3조', min: 1.5e12, max: 3e12 }, { label: '3조 이상', min: 3e12, max: null },
    ]),
    valueRank: [
      { label: '상위 10위', test: e => e.dailyValueRank <= 10 },
      { label: '상위 11~30위', test: e => e.dailyValueRank > 10 && e.dailyValueRank <= 30 },
      { label: '상위 31~50위', test: e => e.dailyValueRank > 30 && e.dailyValueRank <= 50 },
      { label: '상위 51~100위', test: e => e.dailyValueRank > 50 && e.dailyValueRank <= 100 },
      { label: '101위 이하', test: e => e.dailyValueRank > 100 },
    ].map(b => ({ label: b.label, ...summarizeBucket(events.filter(e => isNum(e.dailyValueRank) && b.test(e))) })),
    baseGapRate: bucketize(events, e => e.baseGapRate, [
      { label: '갭 ≤ 0%', min: -Infinity, max: 0 }, { label: '0~3%', min: 0, max: 3 },
      { label: '3~7%', min: 3, max: 7 }, { label: '7~12%', min: 7, max: 12 },
      { label: '12% 이상', min: 12, max: null },
    ]),
    baseOpenToCloseRate: bucketize(events, e => e.baseOpenToCloseRate, [
      { label: '0% 이하', min: -Infinity, max: 0 }, { label: '0~5%', min: 0, max: 5 },
      { label: '5~10%', min: 5, max: 10 }, { label: '10~15%', min: 10, max: 15 },
      { label: '15% 이상', min: 15, max: null },
    ]),
    closePosition: bucketize(events, e => e.closePosition, [
      { label: '0.0~0.4', min: 0, max: 0.4 }, { label: '0.4~0.6', min: 0.4, max: 0.6 },
      { label: '0.6~0.8', min: 0.6, max: 0.8 }, { label: '0.8~0.9', min: 0.8, max: 0.9 },
      { label: '0.9~1.0', min: 0.9, max: null },
    ]),
    upperTailRatio: bucketize(events, e => e.upperTailRatio, [
      { label: '0~0.2', min: 0, max: 0.2 }, { label: '0.2~0.35', min: 0.2, max: 0.35 },
      { label: '0.35~0.5', min: 0.35, max: 0.5 }, { label: '0.5~0.7', min: 0.5, max: 0.7 },
      { label: '0.7 이상', min: 0.7, max: null },
    ]),
  };

  // ─────────────────────────────────────────────────────────
  // v5 신규 분석 3: baseGapRate × baseOpenToCloseRate 2D 매트릭스
  //   "갭으로 오른 것인지 vs 장중 매수세로 오른 것인지" 정밀 분리
  // ─────────────────────────────────────────────────────────
  const baseGapBands = [
    { label: '갭 ≤ 0%', min: -Infinity, max: 0 }, { label: '0~3%', min: 0, max: 3 },
    { label: '3~7%', min: 3, max: 7 }, { label: '7~12%', min: 7, max: 12 },
    { label: '12% 이상', min: 12, max: null },
  ];
  const baseOpenToCloseBands = [
    { label: '0% 이하', min: -Infinity, max: 0 }, { label: '0~5%', min: 0, max: 5 },
    { label: '5~10%', min: 5, max: 10 }, { label: '10~15%', min: 10, max: 15 },
    { label: '15% 이상', min: 15, max: null },
  ];
  const matrixGapVsOpenClose = bucketize2D(events,
    e => e.baseGapRate, baseGapBands,
    e => e.baseOpenToCloseRate, baseOpenToCloseBands);
  matrixGapVsOpenClose.title = 'baseGapRate × baseOpenToCloseRate (LOW_GAP_INTRADAY 정밀 정의)';
  matrixGapVsOpenClose.xLabel = '기준일 갭 (open vs prev close)';
  matrixGapVsOpenClose.yLabel = '기준일 시가→종가 (장중 변화)';

  // recent5Up15Count × valueToMcRatio 2D
  const r5BandsCat = [
    { label: '0회', test: e => e.recent5Up15Count === 0 },
    { label: '1회', test: e => e.recent5Up15Count === 1 },
    { label: '2회', test: e => e.recent5Up15Count === 2 },
    { label: '3회 이상', test: e => e.recent5Up15Count >= 3 },
  ];
  const vmcBands = [
    { label: '1~3%', min: 1, max: 3 }, { label: '3~5%', min: 3, max: 5 },
    { label: '5~10%', min: 5, max: 10 }, { label: '10~20%', min: 10, max: 20 },
    { label: '20% 이상', min: 20, max: null },
  ];
  const matrixR5VsVmc = (function() {
    const cells = [];
    for (let yi = 0; yi < r5BandsCat.length; yi++) {
      const yb = r5BandsCat[yi];
      for (let xi = 0; xi < vmcBands.length; xi++) {
        const xb = vmcBands[xi];
        const sub = events.filter(e => {
          if (!isNum(e.recent5Up15Count) || !isNum(e.valueToMarketCapRatio)) return false;
          if (!yb.test(e)) return false;
          if (e.valueToMarketCapRatio < xb.min || (xb.max != null && e.valueToMarketCapRatio >= xb.max)) return false;
          return true;
        });
        cells.push({ x: xi, y: yi, xLabel: xb.label, yLabel: yb.label, ...summarizeBucket(sub) });
      }
    }
    return {
      title: 'recent5Up15Count × valueToMarketCapRatio (연속 급등 + 수급 과열 결합 위험)',
      xLabel: 'valueToMarketCapRatio', yLabel: '최근 5일 +15%↑ 횟수',
      xBands: vmcBands.map(b => b.label), yBands: r5BandsCat.map(b => b.label),
      cells,
    };
  })();

  // ─────────────────────────────────────────────────────────
  // v5 신규 분석 4: 시총 구간별 전용 룰 sub-search
  //   MICRO/LIGHT/BALANCED/MID 각 영역에서 동일 V2 룰을 재평가 (mc 차원 무시)
  // ─────────────────────────────────────────────────────────
  const MC_SUB_GROUPS = [
    { key: 'MICRO',    label: 'MICRO 500억~1000억',    test: e => e.marketCap >= 5e10 && e.marketCap < 1e11 },
    { key: 'LIGHT',    label: 'LIGHT 1000억~3000억',   test: e => e.marketCap >= 1e11 && e.marketCap < 3e11 },
    { key: 'BALANCED', label: 'BALANCED 3000억~7000억', test: e => e.marketCap >= 3e11 && e.marketCap < 7e11 },
    { key: 'MID',      label: 'MID 7000억~1.5조',      test: e => e.marketCap >= 7e11 && e.marketCap < 1.5e12 },
  ];
  const perMcRuleSearch = {};
  for (const g of MC_SUB_GROUPS) {
    const subEvents = events.filter(g.test);
    const subRules = []; // V2 dimensions 그대로 사용 (mc dim은 'any'만 의미 있음)
    for (const r of rulesV2) {
      // mc dim 변형은 mc 'any' 하나만 사용 (이미 시총 필터 적용했으므로 중복 회피)
      if (r.conds.marketCap !== 'any') continue;
      const result = evaluateRuleV2(subEvents, r.tests);
      if (result.n < N_REFERENCE) continue;
      const safeGt = (isNum(result.goodTradeRate) && isNum(result.greatTradeRate) && isNum(result.trapRate) && isNum(result.openFail5Rate))
        ? result.goodTradeRate + (result.greatTradeRate || 0) * 0.5 - result.trapRate * 0.8 - result.openFail5Rate * 0.25 - (result.noEntryZoneRate || 0) * 0.2
        : null;
      subRules.push({ label: r.label, conds: r.conds, ...result, safeGtScore: safeGt });
    }
    const baseGood = subEvents.length ? safeRate(subEvents.filter(e => e.goodTrade).length, subEvents.length) : 0;
    const baseTrapSub = subEvents.length ? safeRate(subEvents.filter(e => e.trap).length, subEvents.length) : 0;
    perMcRuleSearch[g.key] = {
      groupLabel: g.label, n: subEvents.length, baseGood, baseTrap: baseTrapSub,
      topGood: [...subRules].sort((a, b) => (b.goodTradeRate || 0) - (a.goodTradeRate || 0)).slice(0, 10),
      topLowTrap: [...subRules].filter(r => r.n >= N_RELIABLE && (r.closeHit10Rate || 0) >= baseRate + 5)
        .sort((a, b) => (a.trapRate || 0) - (b.trapRate || 0)).slice(0, 10),
      topSafeGt: [...subRules].filter(r => r.n >= N_RELIABLE && isNum(r.safeGtScore))
        .sort((a, b) => (b.safeGtScore || 0) - (a.safeGtScore || 0)).slice(0, 10),
      rulesEvaluated: subRules.length,
    };
  }
  console.log(`  ── 시총별 룰 sub-search 완료 (4 그룹 × ~${(rulesV2.length / 3).toFixed(0)}룰)`);

  // ─────────────────────────────────────────────────────────
  // v4 GT_BASE 정제 — GTscore #1 룰을 베이스로 하위 조합 17종 비교
  // ─────────────────────────────────────────────────────────
  // GT_BASE: v/mc≥5% + mc 3000억~7000억 + 다음날 갭 < 7%
  // (gapRate는 다음날 시초가가 있어야 알 수 있으므로 "장초 확인 조건"으로 분리해서 결론에 표기)
  const GT_BASE_TEST = e =>
    isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5
    && isNum(e.marketCap) && e.marketCap >= 3e11 && e.marketCap < 7e11
    && isNum(e.gapRate) && e.gapRate < 7;

  // 각 combo의 추가 조건 — isPrev: true 면 전일 예비, false 면 장초 확인 조건 포함
  const GT_COMBOS = [
    { key: 'GT_BASE', label: 'GT_BASE (v/mc≥5% + mc 3000억~7000억 + gap<7%)', isPrev: false, addTest: () => true },
    { key: 'A',  label: 'A. + LOW_GAP_INTRADAY 캔들',                isPrev: true,  addTest: e => e.candleType === 'LOW_GAP_INTRADAY' },
    { key: 'B',  label: 'B. + 거래대금 순위 상위 10위',                isPrev: true,  addTest: e => isNum(e.dailyValueRank) && e.dailyValueRank <= 10 },
    { key: 'C',  label: 'C. + 거래대금 순위 상위 30위',                isPrev: true,  addTest: e => isNum(e.dailyValueRank) && e.dailyValueRank <= 30 },
    { key: 'D',  label: 'D. + 전일 등락률 12~25%',                  isPrev: true,  addTest: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 12 && e.dayChangeRate < 25 },
    { key: 'E',  label: 'E. + 전일 등락률 15~25%',                  isPrev: true,  addTest: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 15 && e.dayChangeRate < 25 },
    { key: 'F',  label: 'F. + 전일 등락률 20~25%',                  isPrev: true,  addTest: e => isNum(e.dayChangeRate) && e.dayChangeRate >= 20 && e.dayChangeRate < 25 },
    { key: 'G',  label: 'G. + 최근 5일 +15%↑ 1회',                  isPrev: true,  addTest: e => isNum(e.recent5Up15Count) && e.recent5Up15Count === 1 },
    { key: 'H',  label: 'H. + 최근 5일 +15%↑ 0~1회',                isPrev: true,  addTest: e => isNum(e.recent5Up15Count) && e.recent5Up15Count <= 1 },
    { key: 'I',  label: 'I. + valueToMcRatio ≥ 10%',              isPrev: true,  addTest: e => isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 10 },
    { key: 'J',  label: 'J. + 전일 거래대금 ≥ 300억',                 isPrev: true,  addTest: e => isNum(e.valueAmount) && e.valueAmount >= 3e10 },
    { key: 'K',  label: 'K. + 전일 거래대금 ≥ 700억',                 isPrev: true,  addTest: e => isNum(e.valueAmount) && e.valueAmount >= 7e10 },
    { key: 'L',  label: 'L. + LOW_GAP_INTRADAY + 거래대금 순위 상위 30위',
      isPrev: true, addTest: e => e.candleType === 'LOW_GAP_INTRADAY' && isNum(e.dailyValueRank) && e.dailyValueRank <= 30 },
    { key: 'M',  label: 'M. + LOW_GAP_INTRADAY + 전일 등락률 12~25%',
      isPrev: true, addTest: e => e.candleType === 'LOW_GAP_INTRADAY' && isNum(e.dayChangeRate) && e.dayChangeRate >= 12 && e.dayChangeRate < 25 },
    { key: 'N',  label: 'N. + LOW_GAP_INTRADAY + 최근 5일 +15%↑ 1회',
      isPrev: true, addTest: e => e.candleType === 'LOW_GAP_INTRADAY' && isNum(e.recent5Up15Count) && e.recent5Up15Count === 1 },
    { key: 'O',  label: 'O. + 거래대금 순위 상위 30위 + 전일 등락률 12~25%',
      isPrev: true, addTest: e => isNum(e.dailyValueRank) && e.dailyValueRank <= 30 && isNum(e.dayChangeRate) && e.dayChangeRate >= 12 && e.dayChangeRate < 25 },
    { key: 'P',  label: 'P. + LOW_GAP_INTRADAY + 거래대금 순위 상위 30위 + 전일 등락률 12~25%',
      isPrev: true, addTest: e => e.candleType === 'LOW_GAP_INTRADAY' && isNum(e.dailyValueRank) && e.dailyValueRank <= 30 && isNum(e.dayChangeRate) && e.dayChangeRate >= 12 && e.dayChangeRate < 25 },
    { key: 'Q',  label: 'Q. + LOW_GAP_INTRADAY + 거래대금 순위 상위 30위 + 최근 5일 +15%↑ 1회',
      isPrev: true, addTest: e => e.candleType === 'LOW_GAP_INTRADAY' && isNum(e.dailyValueRank) && e.dailyValueRank <= 30 && isNum(e.recent5Up15Count) && e.recent5Up15Count === 1 },
  ];

  function reliabilityLevel(n) {
    if (n >= 100) return 'STRONG';
    if (n >= 50) return 'RELIABLE';
    if (n >= 30) return 'REFERENCE';
    return 'INSUFFICIENT';
  }
  function meetsGoals(s) {
    // GOOD_TRADE률 30%↑ AND TRAP률 10%↓ AND openFail-5% 30%↓ AND n≥50
    return s.count >= 50
        && isNum(s.goodTradeRate) && s.goodTradeRate >= 30
        && isNum(s.trapRate) && s.trapRate <= 10
        && isNum(s.openFail5Rate) && s.openFail5Rate <= 30;
  }

  const gtCombos = GT_COMBOS.map(c => {
    const sub = events.filter(e => GT_BASE_TEST(e) && c.addTest(e));
    const summ = summarizeBucket(sub);
    const gtScore = (isNum(summ.goodTradeRate) && isNum(summ.greatTradeRate) && isNum(summ.trapRate) && isNum(summ.openFail5Rate))
      ? summ.goodTradeRate + summ.greatTradeRate * 0.5 - summ.trapRate * 0.7 - summ.openFail5Rate * 0.3
      : null;
    return {
      key: c.key, label: c.label, isPrev: c.isPrev,
      reliability: reliabilityLevel(summ.count),
      meetsGoals: meetsGoals(summ),
      gtScore,
      ...summ,
    };
  });

  // ─────────────────────────────────────────────────────────
  // v4-extra2: 경량 GOOD_TRADE 후보 연구
  //   "1,000억~3,000억 경량주에서도 GOOD이 높고 TRAP이 낮은 조건이 있나?"
  //   "500억~1,000억 초경량주는 위험이 너무 큰가? 제한 조건을 걸면 쓸 수 있나?"
  // ─────────────────────────────────────────────────────────
  function gtScoreOf(s) {
    return (isNum(s.goodTradeRate) && isNum(s.greatTradeRate) && isNum(s.trapRate) && isNum(s.openFail5Rate))
      ? s.goodTradeRate + s.greatTradeRate * 0.5 - s.trapRate * 0.7 - s.openFail5Rate * 0.3
      : null;
  }

  // 11개 경량 후보 조합
  const LIGHT_COMBOS = [
    { key: 'A', label: '기본 (v/mc≥5 + gap<7, mc 무제한)',
      test: e => isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7 },
    { key: 'B', label: '경량 기본 (mc 1000~3000억 + v/mc≥5 + gap<7)',
      test: e => isNum(e.marketCap) && e.marketCap >= 1e11 && e.marketCap < 3e11
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7 },
    { key: 'C', label: '경량 과열 제한 (mc 1000~3000억 + v/mc 5~20 + gap<7)',
      test: e => isNum(e.marketCap) && e.marketCap >= 1e11 && e.marketCap < 3e11
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && e.valueToMarketCapRatio < 20
              && isNum(e.gapRate) && e.gapRate < 7 },
    { key: 'D', label: '경량 강한 마감 (+ cp≥0.8 + tail≤0.2)',
      test: e => isNum(e.marketCap) && e.marketCap >= 1e11 && e.marketCap < 3e11
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7
              && isNum(e.closePosition) && e.closePosition >= 0.8
              && isNum(e.upperTailRatio) && e.upperTailRatio <= 0.2 },
    { key: 'E', label: '경량 LOW_GAP_INTRADAY (+ candle = LOW_GAP_INTRADAY)',
      test: e => isNum(e.marketCap) && e.marketCap >= 1e11 && e.marketCap < 3e11
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7
              && e.candleType === 'LOW_GAP_INTRADAY' },
    { key: 'F', label: '경량 거래대금 상위 30위 (+ valueRank ≤ 30)',
      test: e => isNum(e.marketCap) && e.marketCap >= 1e11 && e.marketCap < 3e11
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7
              && isNum(e.dailyValueRank) && e.dailyValueRank <= 30 },
    { key: 'G', label: '경량 적정 상승률 (+ chg 12~25%)',
      test: e => isNum(e.marketCap) && e.marketCap >= 1e11 && e.marketCap < 3e11
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7
              && isNum(e.dayChangeRate) && e.dayChangeRate >= 12 && e.dayChangeRate < 25 },
    { key: 'H', label: '경량 연속 급등 제한 (+ recent5Up15Count ≤ 1)',
      test: e => isNum(e.marketCap) && e.marketCap >= 1e11 && e.marketCap < 3e11
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7
              && isNum(e.recent5Up15Count) && e.recent5Up15Count <= 1 },
    { key: 'I', label: '경량 종합 (모든 안정 조건 결합)',
      test: e => isNum(e.marketCap) && e.marketCap >= 1e11 && e.marketCap < 3e11
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && e.valueToMarketCapRatio < 20
              && isNum(e.gapRate) && e.gapRate < 7
              && isNum(e.dayChangeRate) && e.dayChangeRate >= 12 && e.dayChangeRate < 25
              && isNum(e.closePosition) && e.closePosition >= 0.8
              && isNum(e.upperTailRatio) && e.upperTailRatio <= 0.2
              && isNum(e.recent5Up15Count) && e.recent5Up15Count <= 1 },
    { key: 'J', label: '초경량 고위험 (mc 500~1000억 + v/mc≥5 + gap<7)',
      test: e => isNum(e.marketCap) && e.marketCap >= 5e10 && e.marketCap < 1e11
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7 },
    { key: 'K', label: '초경량 위험 제한 (mc 500~1000억 + 안정 조건 결합)',
      test: e => isNum(e.marketCap) && e.marketCap >= 5e10 && e.marketCap < 1e11
              && isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && e.valueToMarketCapRatio < 20
              && isNum(e.gapRate) && e.gapRate < 7
              && isNum(e.closePosition) && e.closePosition >= 0.8
              && isNum(e.upperTailRatio) && e.upperTailRatio <= 0.2
              && isNum(e.recent5Up15Count) && e.recent5Up15Count <= 1 },
  ];
  const lightGtCombos = LIGHT_COMBOS.map(c => {
    const sub = events.filter(c.test);
    const summ = summarizeBucket(sub);
    return {
      key: c.key, label: c.label,
      reliability: reliabilityLevel(summ.count),
      meetsGoals: meetsGoals(summ),
      gtScore: gtScoreOf(summ),
      ...summ,
    };
  });

  // ── 4 mc 그룹 × 5 sub-condition matrix ──
  const MC_GROUPS = [
    { key: 'MICRO',     label: '초경량 500억~1,000억',  test: e => isNum(e.marketCap) && e.marketCap >= 5e10 && e.marketCap < 1e11 },
    { key: 'LIGHT',     label: '경량 1,000억~3,000억',  test: e => isNum(e.marketCap) && e.marketCap >= 1e11 && e.marketCap < 3e11 },
    { key: 'BALANCED',  label: '균형형 3,000억~7,000억', test: e => isNum(e.marketCap) && e.marketCap >= 3e11 && e.marketCap < 7e11 },
    { key: 'MID',       label: '중형 7,000억~1.5조',    test: e => isNum(e.marketCap) && e.marketCap >= 7e11 && e.marketCap < 1.5e12 },
  ];
  const SUB_CONDITIONS = [
    { key: 'C1', label: 'v/mc≥5 + gap<7',
      test: e => isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7 },
    { key: 'C2', label: 'v/mc 5~20 + gap<7',
      test: e => isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && e.valueToMarketCapRatio < 20 && isNum(e.gapRate) && e.gapRate < 7 },
    { key: 'C3', label: '+ LOW_GAP_INTRADAY',
      test: e => isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7
              && e.candleType === 'LOW_GAP_INTRADAY' },
    { key: 'C4', label: '+ chg 12~25%',
      test: e => isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7
              && isNum(e.dayChangeRate) && e.dayChangeRate >= 12 && e.dayChangeRate < 25 },
    { key: 'C5', label: '+ recent5Up15Count = 1',
      test: e => isNum(e.valueToMarketCapRatio) && e.valueToMarketCapRatio >= 5 && isNum(e.gapRate) && e.gapRate < 7
              && isNum(e.recent5Up15Count) && e.recent5Up15Count === 1 },
  ];
  const lightGtMatrix = MC_GROUPS.map(g => ({
    group: g.key, groupLabel: g.label,
    cells: SUB_CONDITIONS.map(s => {
      const sub = events.filter(e => g.test(e) && s.test(e));
      const summ = summarizeBucket(sub);
      return {
        sub: s.key, subLabel: s.label,
        reliability: reliabilityLevel(summ.count),
        meetsGoals: meetsGoals(summ),
        gtScore: gtScoreOf(summ),
        ...summ,
      };
    }),
  }));

  // 자동 결론
  const autoConclusion = buildAutoConclusion({
    comparison, crossTabs: { ...crossTabs, group: groupTab }, crossTabs2D,
    hit10Types, type1Subtypes, byGroup, baseRate, baseFailClose, baseFailLow, baseOpenFail5,
    ruleSearch, qvaSummary, sCandQvaTab, rCandQvaTab, gapTab, namedConditions,
    // v4 추가 컨텍스트
    valueToMcRatioTab, valueAmountTab, dayChangeFineTab, candleTab, highBreakTab,
    recentSurgeTabs, valueRankTab, sVariantTab, ruleSearchV2,
    baseGoodTrade, baseGreatTrade, baseTrap,
    // v4-extra: GT_BASE 정제
    gtCombos,
    // v4-extra2: 경량 GOOD_TRADE
    lightGtCombos, lightGtMatrix,
    // v5: 위험 제거 연구
    goodVsTrapCompare, gapPredictTabs, matrixGapVsOpenClose, matrixR5VsVmc, perMcRuleSearch,
  });

  // ─── 60일 baseline vs 현재 windowDays 비교 ───
  const currentSnap = extractComparisonSnapshot({
    namedConditions, type1Subtypes, gapTab, qvaPresenceTab, qvaGapTab, sCandQvaTab, rCandQvaTab,
  });
  const compareRows = buildComparisonRows(currentSnap);

  // baseline verdict 자동 판단 (사용자 spec 7번 자동 결론용)
  const baselineVerdicts = {};
  // 헬퍼 — 특정 row 찾기
  const findRow = (sec, metric) => compareRows.find(r => r.sec === sec && r.metric === metric);
  // 1) 상따 위험 결론
  const t1eOpenFail = findRow('T1_E 상한가형', 'openFail-5%');
  const t1eOpenClose = findRow('T1_E 상한가형', '시초→종가 평균');
  if (t1eOpenFail && t1eOpenClose && Number.isFinite(t1eOpenFail.curVal) && Number.isFinite(t1eOpenClose.curVal)) {
    if (t1eOpenFail.curVal >= 50 && t1eOpenClose.curVal < 0) {
      baselineVerdicts.sangttaTrap = `유지: T1_E의 openFail-5% ${t1eOpenFail.curVal.toFixed(1)}% (60일 ${BASELINE_60D.T1_E.openFail5Rate}%) + 시초→종가 평균 ${t1eOpenClose.curVal.toFixed(2)}% (60일 ${BASELINE_60D.T1_E.avgNextCloseFromOpen}%) — 상한가형 상따는 여전히 위험.`;
    } else {
      baselineVerdicts.sangttaTrap = `약화: T1_E openFail-5%가 ${t1eOpenFail.curVal.toFixed(1)}%로 60일(${BASELINE_60D.T1_E.openFail5Rate}%)보다 낮아짐. 재검토 필요.`;
    }
  }
  // 2) 갭 위험 임계
  const gap712Fail = findRow('갭 7~12%', 'openFail-5%');
  const gap1220Fail = findRow('갭 12~20%', 'openFail-5%');
  if (gap712Fail && gap1220Fail && Number.isFinite(gap712Fail.curVal)) {
    if (gap712Fail.curVal >= 60) {
      baselineVerdicts.gapThreshold = `유지: 갭 7~12% openFail-5% ${gap712Fail.curVal.toFixed(1)}% (60일 ${BASELINE_60D.gap_7_12.openFail5Rate}%) — 갭 7%↑부터 장초 추격 위험 임계로 보는 게 타당.`;
    } else if (gap1220Fail && Number.isFinite(gap1220Fail.curVal) && gap1220Fail.curVal >= 60) {
      baselineVerdicts.gapThreshold = `완화: 갭 7~12% openFail-5%는 ${gap712Fail.curVal.toFixed(1)}%로 낮아졌지만, 갭 12~20% openFail-5% ${gap1220Fail.curVal.toFixed(1)}% — 위험 임계를 12%로 상향 검토.`;
    } else {
      baselineVerdicts.gapThreshold = `약화: 갭 위험 임계가 흐려짐 — 60일 결과는 우연일 가능성.`;
    }
  }
  // 3) QVA 단독 효과
  const qvaWithRow = findRow('QVA 있음', 'HIT10');
  const qvaWithFailClose = findRow('QVA 있음', '실패 종가');
  const qvaWithFailLow = findRow('QVA 있음', '실패 저가');
  if (qvaWithRow && qvaSummary && Number.isFinite(qvaSummary.hit10RateWithQva) && Number.isFinite(qvaSummary.hit10RateNoQva)) {
    const lift = qvaSummary.hit10RateWithQva - qvaSummary.hit10RateNoQva;
    const failDeltaC = (qvaSummary.failCloseWithQva || 0) - (qvaSummary.failCloseNoQva || 0);
    const failDeltaL = (qvaSummary.failLowWithQva || 0) - (qvaSummary.failLowNoQva || 0);
    if (lift >= 5 && failDeltaC <= 1 && failDeltaL <= 1) {
      baselineVerdicts.qvaStandalone = `강화: QVA 단독 효과가 명확해짐 (HIT10 lift +${lift.toFixed(1)}pp, 실패율은 동등/낮음) — 단독 신호로 사용 검토 가능.`;
    } else if (Math.abs(lift) < 3 && Math.abs(failDeltaC) < 3) {
      baselineVerdicts.qvaStandalone = `유지(MIXED): QVA 단독 lift +${lift.toFixed(1)}pp / 실패 종가 차이 ${failDeltaC > 0 ? '+' : ''}${failDeltaC.toFixed(1)}pp — 60일과 같은 혼합 신호. 단독 조건 X, 보조 태그 후보.`;
    } else {
      baselineVerdicts.qvaStandalone = `lift +${lift.toFixed(1)}pp / 실패 차이 종가 ${failDeltaC.toFixed(1)}pp / 저가 ${failDeltaL.toFixed(1)}pp — 결론 보류, 추가 검증 필요.`;
    }
  }
  // 4) QVA 선행 간격 best
  const qvaGapRows = ['D-1~D-3', 'D-4~D-7', 'D-8~D-14', 'D-15~D-20']
    .map(lab => qvaGapTab.find(g => g.label === lab))
    .filter(g => g && Number.isFinite(g.hit10Rate) && g.count >= 30);
  if (qvaGapRows.length) {
    const best = qvaGapRows.reduce((a, b) => (b.hit10Rate > a.hit10Rate ? b : a));
    baselineVerdicts.qvaBestGap = `현재 best 선행 간격: ${best.label} (HIT10 ${best.hit10Rate.toFixed(1)}%, n=${best.count}). 60일 best는 D-15~D-20 (${BASELINE_60D.qvaGap_15_20.hit10Rate}%).`;
  }
  // 5) S + QVA 조합
  const sQvaWithCur = currentSnap.sQvaWith;
  const sQvaNoCur = currentSnap.sQvaNo;
  if (sQvaWithCur && sQvaNoCur && Number.isFinite(sQvaWithCur.hit10Rate) && Number.isFinite(sQvaNoCur.hit10Rate) && sQvaWithCur.count > 0) {
    const sLift = sQvaWithCur.hit10Rate - sQvaNoCur.hit10Rate;
    const sFailDelta = (sQvaWithCur.failCloseRate || 0) - (sQvaNoCur.failCloseRate || 0);
    if (sQvaWithCur.count >= 30 && sLift >= 10 && sFailDelta <= 0) {
      baselineVerdicts.sQvaCombo = `강화/유지: S + QVA 있음 n=${sQvaWithCur.count} (60일 ${BASELINE_60D.sQvaWith.count}), HIT10 ${sQvaWithCur.hit10Rate.toFixed(1)}% (lift vs S+QVA없음 +${sLift.toFixed(1)}pp), 실패 종가 차이 ${sFailDelta.toFixed(1)}pp — 다음 보드 최상위 태그로 사용 가능.`;
    } else if (sQvaWithCur.count < 30) {
      baselineVerdicts.sQvaCombo = `보류: S + QVA 있음 n=${sQvaWithCur.count}로 표본 여전히 부족. (60일 n=${BASELINE_60D.sQvaWith.count}) — 더 긴 윈도우 또는 S 조건 완화 검토.`;
    } else {
      baselineVerdicts.sQvaCombo = `약화: S + QVA 있음 n=${sQvaWithCur.count}, HIT10 lift ${sLift > 0 ? '+' : ''}${sLift.toFixed(1)}pp / 실패 차이 ${sFailDelta.toFixed(1)}pp — 60일만큼의 강한 우위 사라짐. 추가 검증.`;
    }
  }
  // 6) R 후보 + QVA 위험 상쇄
  const rQvaWithCur = currentSnap.rQvaWith;
  const rQvaNoCur = currentSnap.rQvaNo;
  if (rQvaWithCur && rQvaNoCur && Number.isFinite(rQvaWithCur.openFail5Rate) && Number.isFinite(rQvaNoCur.openFail5Rate) && rQvaWithCur.count > 0) {
    const rFailDelta = (rQvaWithCur.openFail5Rate || 0) - (rQvaNoCur.openFail5Rate || 0);
    if (rFailDelta <= -10) {
      baselineVerdicts.rQvaSafety = `완화 효과 발견: R + QVA 있음 openFail-5% ${rQvaWithCur.openFail5Rate.toFixed(1)}% vs 없음 ${rQvaNoCur.openFail5Rate.toFixed(1)}% (${rFailDelta.toFixed(1)}pp) — QVA가 R후보 위험을 일부 완화.`;
    } else {
      baselineVerdicts.rQvaSafety = `유지(상쇄 안 됨): R + QVA 있음 openFail-5% ${rQvaWithCur.openFail5Rate.toFixed(1)}% vs 없음 ${rQvaNoCur.openFail5Rate.toFixed(1)}% (차이 ${rFailDelta > 0 ? '+' : ''}${rFailDelta.toFixed(1)}pp) — QVA로 R후보 위험 본질적 상쇄 X.`;
    }
  }
  // 7) 보류 항목
  const onHold = [];
  if (sQvaWithCur && sQvaWithCur.count < N_RELIABLE) onHold.push(`S + QVA 있음 표본(n=${sQvaWithCur.count})이 ${N_RELIABLE} 미만 — 강한 결론은 보류.`);
  if (rQvaWithCur && rQvaWithCur.count < 20) onHold.push(`R + QVA 있음 표본(n=${rQvaWithCur.count}) 너무 적음 — R후보 위험 완화 결론은 보류.`);
  baselineVerdicts.onHold = onHold;

  const allDates = [...new Set(events.map(e => e.baseDate))].sort();
  const windowFrom = allDates[0] || null;
  const windowTo = allDates[allDates.length - 1] || null;

  const out = {
    meta: {
      title: '1-Day Surge HIT10 연구 보고서 v3 (시초가/갭/QVA 교차)',
      subtitle: '상따 검증 + 다음날 시초가 진입 시뮬레이션 + QVA 선행 신호 교차분석',
      generatedAt: new Date().toISOString(),
      windowDays: VALIDATION_DAYS,
      windowFrom, windowFromFmt: windowFrom ? fmtDate(windowFrom) : null,
      windowTo, windowToFmt: windowTo ? fmtDate(windowTo) : null,
      stocksProcessed, stocksFiltered, totalEvents: events.length,
      hit10Total: hit10Events.length, hit10Rate: baseRate,
      baseFailClose, baseFailLow, baseOpenFail5,
      baseGoodTrade, baseGreatTrade, baseTrap,
      qvaCallsTotal: totalQvaCalls, qvaPassedTotal: totalQvaPassed,
      eventsWithQvaCount: eventsWithQ.length,
      elapsedMs: Date.now() - t0,
    },
    summary,
    comparison,
    crossTabs: { ...crossTabs, group: groupTab },
    crossTabs2D,
    hit10Types,
    type1Subtypes,
    namedConditions,
    gapTab,
    qvaSummary,
    qvaPresenceTab,
    qvaGapTab,
    sCandQvaTab,
    rCandQvaTab,
    topHit10Qva,
    ruleSearch,
    topHit10,
    byGroup,
    autoConclusion,
    baseline60d: BASELINE_60D,
    compareRows,
    baselineVerdicts,
    // v4 신규
    valueToMcRatioTab, valueAmountTab, dayChangeFineTab, candleTab, highBreakTab,
    recentSurgeTabs, valueRankTab, sVariantTab, ruleSearchV2,
    // v4-extra
    gtCombos,
    // v4-extra2
    lightGtCombos, lightGtMatrix,
    // v5: 위험 제거 연구
    goodVsTrapCompare, gapPredictTabs, matrixGapVsOpenClose, matrixR5VsVmc, perMcRuleSearch,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out)), 'utf-8');

  console.log(`\n  HIT10 ${baseRate.toFixed(1)}% / QVA 보유 HIT10: ${hit10WithQ.length} (${qvaSummary.hit10WithQvaShare?.toFixed(1)}%)`);
  console.log(`  QVA 있음 HIT10률: ${(qvaSummary.hit10RateWithQva||0).toFixed(1)}% vs QVA 없음: ${(qvaSummary.hit10RateNoQva||0).toFixed(1)}% (lift ${((qvaSummary.hit10RateWithQva||0) - (qvaSummary.hit10RateNoQva||0)).toFixed(1)}pp)`);
  console.log(`  total elapsed: ${((Date.now() - t0)/1000).toFixed(1)}s`);
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>1-Day Surge HIT10 연구 보고서 v3</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
}
nav { display:flex; gap:10px; flex-wrap:wrap; padding:8px 0 14px; border-bottom:1px solid #1e293b; margin-bottom:14px; }
nav a { color:#94a3b8; text-decoration:none; font-size:12px; padding:4px 8px; border-radius:4px; }
nav a:hover { color:#e2e8f0; background:#1e293b; }
nav a.active { color:#f1f5f9; background:#1e293b; }
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 18px 0 8px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.subtitle strong { color: #67e8f9; }
.purpose-box { background: #0f172a; border-left: 3px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #67e8f9; }

.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 14px; }
.summary-cell { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.summary-cell .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.summary-cell .value { font-size: 18px; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; margin-top: 4px; }
.summary-cell .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
.summary-cell.hit10 { border-left: 4px solid #10b981; }
.summary-cell.fail  { border-left: 4px solid #ef4444; }
.summary-cell.open  { border-left: 4px solid #a78bfa; }
.summary-cell.qva   { border-left: 4px solid #38bdf8; }

table { width: 100%; border-collapse: collapse; margin-bottom: 14px; background: #1e293b; border-radius: 8px; overflow: hidden; font-size: 12px; }
th, td { padding: 7px 9px; text-align: right; border-bottom: 1px solid #334155; font-variant-numeric: tabular-nums; }
th { background: #0f172a; color: #94a3b8; font-weight: 600; text-align: right; }
th.left, td.left { text-align: left; }
tr:last-child td { border-bottom: none; }
tr.row-A td.left { color: #6ee7b7; font-weight: 700; }
tr.row-B td.left { color: #7dd3fc; font-weight: 700; }
tr.row-C td.left { color: #fbbf24; font-weight: 700; }
tr.row-D td.left { color: #fca5a5; font-weight: 700; }
tr.row-ALL td { background: #0f172a; font-weight: 700; }
tr.hit10-row td { background: #064e3b22; }
tr.qva-row td { background: #1e3a8a22; }
.pos { color: #6ee7b7; }
.neg { color: #fca5a5; }
.warn { color: #fbbf24; }
.muted { color: #64748b; }
.diff-pos { color: #6ee7b7; font-weight: 700; }
.diff-neg { color: #fca5a5; font-weight: 700; }

.callout { background: #1e293b; border-left: 4px solid #14b8a6; padding: 10px 14px; border-radius: 6px; font-size: 12px; line-height: 1.7; color: #cbd5e1; margin-bottom: 14px; }
.callout strong { color: #5eead4; }
.callout.warn { border-left-color: #f59e0b; }
.callout.warn strong { color: #fbbf24; }
.callout.danger { border-left-color: #ef4444; }
.callout.danger strong { color: #fca5a5; }
.callout.success { border-left-color: #10b981; }
.callout.success strong { color: #6ee7b7; }
.callout.qva { border-left-color: #38bdf8; }
.callout.qva strong { color: #7dd3fc; }
.callout.open { border-left-color: #a78bfa; }
.callout.open strong { color: #c4b5fd; }

.types-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin-bottom: 14px; }
.type-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 14px; }
.type-card.t-T1 { border-left: 4px solid #10b981; }
.type-card.t-T2 { border-left: 4px solid #f59e0b; }
.type-card.t-T3 { border-left: 4px solid #38bdf8; }
.type-card.t-TE { border-left: 4px solid #64748b; }
.type-card h4 { margin: 0 0 4px; font-size: 13px; color: #f1f5f9; }
.type-card .desc { font-size: 11px; color: #94a3b8; line-height: 1.6; margin-bottom: 6px; }
.type-card .stats { font-size: 12px; color: #cbd5e1; line-height: 1.7; }
.type-card .stats strong { color: #f1f5f9; }

details.section { margin-bottom: 16px; border: 1px solid #1e293b; border-radius: 8px; }
details.section > summary { cursor: pointer; font-size: 14px; font-weight: 700; color: #cbd5e1; padding: 10px 14px; user-select: none; background: #0f172a; border-radius: 8px; }
details.section[open] > summary { color: #f1f5f9; border-radius: 8px 8px 0 0; }
details.section > .section-body { padding: 12px 14px; }

table.matrix { width: 100%; border-collapse: separate; border-spacing: 2px; background: transparent; }
table.matrix th, table.matrix td { padding: 0; border: none; background: transparent; }
table.matrix th.col-h, table.matrix th.row-h {
  background: #0f172a; color: #94a3b8; font-weight: 600; padding: 6px 8px; text-align: center; font-size: 11px; border-radius: 4px;
}
table.matrix td.cell { padding: 6px 8px; text-align: center; border-radius: 4px; min-width: 90px; line-height: 1.4; }
table.matrix td.cell .rate { font-size: 14px; font-weight: 700; display: block; }
table.matrix td.cell .meta { font-size: 10px; color: #94a3b8; display: block; }
.cell.cell-na    { background: #0f172a; color: #475569; }
.cell.cell-low   { background: #1e293b; color: #cbd5e1; }
.cell.cell-base  { background: #1e293b; color: #cbd5e1; }
.cell.cell-up5   { background: #134e4a; color: #5eead4; }
.cell.cell-up10  { background: #064e3b; color: #6ee7b7; }
.cell.cell-up20  { background: #047857; color: #a7f3d0; font-weight: 700; }
.cell.cell-up30  { background: #059669; color: #d1fae5; font-weight: 700; }
.cell.cell-down  { background: #422006; color: #fbbf24; }
.cell.cell-low-n { opacity: 0.4; }

table.rules { font-size: 11px; }
table.rules td.label { text-align: left; font-family: ui-monospace, monospace; color: #cbd5e1; max-width: 380px; word-break: break-word; }
table.rules tr.high-q td { background: #064e3b15; }
table.rules tr.high-r td { background: #7f1d1d15; }
.tag { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; }
.tag.tag-q { background:#064e3b; color:#6ee7b7; border:1px solid #10b981; }
.tag.tag-r { background:#7f1d1d; color:#fca5a5; border:1px solid #ef4444; }
.tag.tag-ref { background:#1e293b; color:#94a3b8; border:1px solid #475569; }
.tag.tag-qva { background:#1e3a8a; color:#bfdbfe; border:1px solid #3b82f6; }
/* 비교표 verdict tag */
.tag.v-hold   { background:#064e3b; color:#a7f3d0; border:1px solid #10b981; }
.tag.v-minor  { background:#134e4a; color:#5eead4; border:1px solid #14b8a6; }
.tag.v-change { background:#422006; color:#fbbf24; border:1px solid #f59e0b; }
.tag.v-major  { background:#7f1d1d; color:#fca5a5; border:1px solid #ef4444; }
.tag.v-na     { background:#1e293b; color:#64748b; border:1px solid #334155; }
.delta-pos { color: #6ee7b7; }
.delta-neg { color: #fca5a5; }
</style>
</head>
<body>
<div style="background:linear-gradient(90deg,#1e1b4b 0%,#312e81 100%);border:1px solid #6366f1;border-radius:8px;padding:8px 14px;margin-bottom:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#c4b5fd;font-weight:700;letter-spacing:0.3px;">🟣 실험 라인 (QVA2)</span><a href="/qva2-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR (QVA2)</a><a href="/qva2-d5-rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파 (QVA2)</a><a href="/qva2-vvi" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파 (QVA2)</a><a href="/qva2-validation" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📊 검증</a></div>
<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/rebreak">🔥 D+5 재돌파 운용</a>
  <a href="/one-day-surge-board">⚡ 1DS 단타 후보</a>
  <a href="/one-day-surge-validation" class="active">🔬 1DS 다음날 검증</a>
</nav>

<h1>🔬 1-Day Surge HIT10 연구 보고서 v3</h1>
<div class="subtitle"><strong>상따 검증 + 다음날 시초가 진입 시뮬레이션 + QVA 선행 신호 교차분석</strong></div>
<div class="subtitle" id="meta-line"></div>

<div class="purpose-box">
  v2까지 발견한 단일/조합 cross-tab 위에 두 가지를 더한다:<br>
  ① <strong>상따 vs 장초 진입 분리</strong> — 전일종가 기준 HIT10이 좋아도 다음날 시초가가 이미 떠 있으면 실제 장초 진입자에게는 먹을 자리가 없을 수 있다. 시초가 기준 openHit5/openFail5/갭 구간별 검증.<br>
  ② <strong>QVA 선행 신호 교차</strong> — HIT10 종목 중 baseDate 이전 [D-1, D-20] 안에 QVA 신호가 있었는가? QVA가 1DS 점수에 가점할 가치가 있는지, 별도 운영해야 하는지 판정.
</div>

<h2>📊 핵심 요약</h2>
<div class="summary-grid" id="summary-grid"></div>

<h2>🆚 HIT10 vs NON_HIT10 비교 (단일 지표)</h2>
<details class="section"><summary>펼쳐서 보기</summary><div class="section-body">
<table id="t-compare">
  <thead><tr>
    <th class="left">지표</th>
    <th>HIT10 평균</th><th>HIT10 중앙값</th>
    <th>NON 평균</th><th>NON 중앙값</th>
    <th>차이 (평균)</th><th>relDiff</th>
  </tr></thead>
  <tbody></tbody>
</table>
</div></details>

<h2>📐 1차원 cross-tab</h2>
<details class="section"><summary>A~I 펼쳐서 보기</summary><div class="section-body">
  <h3>A. 거래대금 배율</h3><table id="ct-valueRatio"><thead></thead><tbody></tbody></table>
  <h3>B. 시가총액</h3><table id="ct-marketCap"><thead></thead><tbody></tbody></table>
  <h3>C. 종가 위치</h3><table id="ct-closePosition"><thead></thead><tbody></tbody></table>
  <h3>D. 윗꼬리 비율</h3><table id="ct-upperTailRatio"><thead></thead><tbody></tbody></table>
  <h3>E. 전일 상승률</h3><table id="ct-dayChangeRate"><thead></thead><tbody></tbody></table>
  <h3>최근 3일</h3><table id="ct-recent3Rate"><thead></thead><tbody></tbody></table>
  <h3>최근 5일</h3><table id="ct-recent5Rate"><thead></thead><tbody></tbody></table>
  <h3>점수</h3><table id="ct-score"><thead></thead><tbody></tbody></table>
  <h3>그룹</h3><table id="ct-group"><thead></thead><tbody></tbody></table>
</div></details>

<h2>📐📐 2차원 조합표</h2>
<details class="section"><summary>2D matrix 6종 펼쳐서 보기</summary><div class="section-body">
  <div class="muted" style="font-size:11px;margin-bottom:6px;">셀 색: HIT10률이 baseline 대비 얼마나 올라갔는지. 표본 n&lt;20은 흐리게.</div>
  <h3 id="m2-A-sum"></h3><div id="m2-A"></div>
  <h3 id="m2-B-sum"></h3><div id="m2-B"></div>
  <h3 id="m2-C-sum"></h3><div id="m2-C"></div>
  <h3 id="m2-D-sum"></h3><div id="m2-D"></div>
  <h3 id="m2-E-sum"></h3><div id="m2-E"></div>
  <h3 id="m2-F-sum"></h3><div id="m2-F"></div>
</div></details>

<h2>🚪 v3 다음날 시초가 기준 성과 (장초 진입 시뮬레이션)</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">전일종가 기준 HIT10이 높아도 시초가가 이미 떠 있으면 장초 진입자에게는 먹을 자리가 줄어든다. 같은 조건을 두 기준으로 비교.</div>
<table id="t-named-cond">
  <thead><tr>
    <th class="left">조건</th>
    <th>n</th>
    <th>전일종가 HIT10</th>
    <th>openHit3</th><th>openHit5</th><th>openHit10</th>
    <th>openFail-3%</th><th>openFail-5%</th>
    <th>시초→종가 평균</th>
  </tr></thead>
  <tbody></tbody>
</table>

<h2>🌅 v3 다음날 갭 구간별 성과</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">gapRate = (다음날 시초가 - 전일종가) / 전일종가. 갭이 클수록 장초 추격 위험이 커지는지 확인.</div>
<table id="t-gap">
  <thead><tr>
    <th class="left">갭 구간</th>
    <th>n</th>
    <th>전일종가 HIT10</th>
    <th>openHit3</th><th>openHit5</th><th>openHit10</th>
    <th>openFail-3%</th><th>openFail-5%</th>
    <th>시초→고가 평균</th><th>시초→종가 평균</th><th>시초→저가 평균</th>
  </tr></thead>
  <tbody></tbody>
</table>

<h2>🧬 HIT10 유형 분류 + TYPE_1 세부</h2>
<details class="section" open><summary>유형 카드 + TYPE_1 6종 분해</summary><div class="section-body">
  <div class="types-grid" id="types-grid"></div>
  <h3>TYPE_1 세부 분해</h3>
  <table id="t-t1subtypes">
    <thead><tr>
      <th class="left">세부 유형</th><th>n</th><th>HIT5</th><th>HIT10</th>
      <th>평균 시초</th><th>평균 고가</th><th>평균 종가</th>
      <th>실패 종가</th><th>실패 저가</th><th>평균 시총</th><th>평균 배율</th>
    </tr></thead><tbody></tbody>
  </table>
</div></details>

<h2>🤖 룰 조합 자동 탐색</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;" id="rule-meta"></div>
<details class="section"><summary>HIT10률 상위 30 (단순 도달률)</summary><div class="section-body">
  <table class="rules" id="t-rules-hit10"><thead><tr><th class="left">조건</th><th>n</th><th>HIT10</th><th>HIT5</th><th>lift</th><th>고가</th><th>종가</th><th>실패 종가</th><th>실패 저가</th><th>riskAdj</th><th>신뢰</th></tr></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>riskAdj 상위 30</summary><div class="section-body">
  <table class="rules" id="t-rules-riskadj"><thead><tr><th class="left">조건</th><th>n</th><th>HIT10</th><th>HIT5</th><th>lift</th><th>고가</th><th>종가</th><th>실패 종가</th><th>실패 저가</th><th>riskAdj</th><th>신뢰</th></tr></thead><tbody></tbody></table>
</div></details>
<details class="section" open><summary>🟢 고품질 후보</summary><div class="section-body">
  <table class="rules" id="t-rules-quality"><thead><tr><th class="left">조건</th><th>n</th><th>HIT10</th><th>HIT5</th><th>lift</th><th>고가</th><th>종가</th><th>실패 종가</th><th>실패 저가</th></tr></thead><tbody></tbody></table>
</div></details>
<details class="section" open><summary>🔴 고위험 후보</summary><div class="section-body">
  <table class="rules" id="t-rules-risk"><thead><tr><th class="left">조건</th><th>n</th><th>HIT10</th><th>HIT5</th><th>lift</th><th>고가</th><th>종가</th><th>실패 종가</th><th>실패 저가</th></tr></thead><tbody></tbody></table>
</div></details>

<h2>🛰 v3 QVA 선행 신호 교차분석</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">baseDate 이전 [D-1, D-20] 안에 같은 종목의 QVA 신호가 있었는지로 분류. baseDate 당일 QVA는 제외(선행 신호만 분석).</div>

<h3>QVA 이력 요약</h3>
<table id="t-qva-summary"><thead></thead><tbody></tbody></table>

<h3>QVA 이력 여부별 다음날 성과</h3>
<table id="t-qva-presence">
  <thead><tr>
    <th class="left">구분</th><th>n</th>
    <th>HIT3</th><th>HIT5</th><th>HIT10</th>
    <th>평균 고가</th><th>평균 종가</th>
    <th>실패 종가</th><th>실패 저가</th>
    <th>openHit5</th><th>openFail-5%</th>
  </tr></thead><tbody></tbody>
</table>

<h3>QVA 선행 간격별 성과</h3>
<table id="t-qva-gap">
  <thead><tr>
    <th class="left">QVA 선행 간격</th><th>n</th>
    <th>HIT10</th>
    <th>평균 고가</th><th>평균 종가</th>
    <th>실패 종가</th><th>실패 저가</th>
    <th>openHit5</th><th>openFail-5%</th>
  </tr></thead><tbody></tbody>
</table>

<h3>S 후보 × QVA 교차 (현재 연구의 임시 S 조건)</h3>
<table id="t-s-qva">
  <thead><tr>
    <th class="left">구분</th><th>n</th>
    <th>HIT10</th>
    <th>평균 고가</th>
    <th>실패 종가</th><th>실패 저가</th>
    <th>openHit5</th><th>openFail-5%</th>
    <th>시초→종가 평균</th>
  </tr></thead><tbody></tbody>
</table>

<h3>R 후보 × QVA 교차 (현재 연구의 임시 R 조건)</h3>
<table id="t-r-qva">
  <thead><tr>
    <th class="left">구분</th><th>n</th>
    <th>HIT10</th>
    <th>평균 고가</th>
    <th>실패 종가</th><th>실패 저가</th>
    <th>openHit5</th><th>openFail-5%</th>
    <th>시초→종가 평균</th>
  </tr></thead><tbody></tbody>
</table>

<h2>🏆 HIT10 + QVA 선행 이력 종목 상위 100 (다음날 고가 순)</h2>
<details class="section"><summary>펼쳐서 보기</summary><div class="section-body">
<table id="t-top-qva">
  <thead><tr>
    <th class="left">종목</th><th class="left">코드</th><th class="left">기준일</th><th class="left">다음일</th>
    <th>다음 시초%</th><th>다음 고가%</th><th>다음 종가%</th><th>다음 저가%</th>
    <th>시초→고가</th><th>시초→저가</th><th>시초→종가</th>
    <th class="left">QVA일</th><th>QVA 간격</th>
    <th>×배율</th><th>전일%</th><th>cp</th><th>tail</th>
    <th>3일%</th><th>5일%</th><th>시총</th><th>그룹</th><th class="left">유형</th>
  </tr></thead><tbody></tbody>
</table>
</div></details>

<h2>🏆 실제 HIT10 종목 상위 100 (전체)</h2>
<details class="section"><summary>펼쳐서 보기 (100건)</summary><div class="section-body">
<table id="t-top">
  <thead><tr>
    <th class="left">종목</th><th class="left">코드</th><th class="left">기준일</th><th class="left">다음일</th>
    <th>시초%</th><th>고가%</th><th>종가%</th><th>저가%</th>
    <th>×배율</th><th>×거래량</th><th>시총</th>
    <th>전일%</th><th>cp</th><th>tail</th>
    <th>3일%</th><th>5일%</th>
    <th>점수</th><th>그룹</th><th class="left">유형</th><th class="left">QVA</th>
  </tr></thead><tbody></tbody>
</table>
</div></details>

<h2>🛒 v4 GOOD_TRADE / GREAT_TRADE / TRAP 정의</h2>
<div class="callout">
  <strong>실전 시초가 진입 가정 지표</strong>: 시초가에 들어갔다고 가정하고 다음날 흐름을 평가.<br>
  • <strong>GOOD_TRADE</strong> = 시초→고가 ≥ +5% AND 시초→저가 > -5% AND 시초→종가 > -3%<br>
  • <strong>GREAT_TRADE</strong> = 시초→고가 ≥ +7% AND 시초→저가 > -4% AND 시초→종가 ≥ 0%<br>
  • <strong>TRAP</strong> = 전일종가 기준 HIT10 (다음날 고가 +10%) 인데 시초→저가 ≤ -5% (큰 흔들림)
</div>

<h2>💰 v4 거래대금 / 시총 비율 (valueToMcRatio) 별 성과</h2>
<table id="ct-vmcratio"><thead></thead><tbody></tbody></table>

<h2>💵 v4 전일 거래대금 절대값 별 성과</h2>
<table id="ct-vamount"><thead></thead><tbody></tbody></table>

<h2>📈 v4 전일 등락률 세분화 (chg 8개 구간)</h2>
<table id="ct-chgfine"><thead></thead><tbody></tbody></table>

<h2>🕯 v4 전일 캔들 구조 분류</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">배타. 우선순위: 음봉 → 윗꼬리양봉 → 갭상승유지 → 낮은갭+장중강세 → 장대양봉 → 기타</div>
<table id="ct-candle"><thead></thead><tbody></tbody></table>

<h2>🏔 v4 신고가 / 고점 돌파 별 성과</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">배타. 우선순위: 120일 돌파 → 60일 돌파 → 20일 돌파 → 20일 고점 아래 0~3% / 3~7% / 7%↑</div>
<table id="ct-highbreak"><thead></thead><tbody></tbody></table>

<h2>🔁 v4 최근 급등 횟수 (연속 급등 vs 첫 급등)</h2>
<details class="section" open><summary>최근 5일 +15%↑ 횟수</summary><div class="section-body">
  <table id="ct-r5up15"><thead></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>최근 5일 +7%↑ 횟수</summary><div class="section-body">
  <table id="ct-r5up7"><thead></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>최근 10일 +15%↑ 횟수</summary><div class="section-body">
  <table id="ct-r10up15"><thead></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>최근 10일 +20%↑ 횟수 (상한가형)</summary><div class="section-body">
  <table id="ct-r10limit"><thead></thead><tbody></tbody></table>
</div></details>

<h2>🥇 v4 일자 내 거래대금 순위별 성과</h2>
<table id="ct-vrank"><thead></thead><tbody></tbody></table>

<h2>🅂 v4 S2/S3 조건 완화 실험</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">기존 S 표본이 작아서 조건을 일부 완화. 각 변형별로 전체 / QVA D-15~D-20 있음 / 없음 분리.</div>
<table id="t-svariant">
  <thead><tr>
    <th class="left">변형</th><th class="left">조건</th><th>구분</th><th>n</th>
    <th>HIT10</th><th>OPEN_HIT5</th><th>GOOD_TRADE</th><th>GREAT_TRADE</th>
    <th>TRAP</th><th>openFail-5%</th><th>시초→종가 평균</th>
  </tr></thead><tbody></tbody>
</table>

<h2>🤖 v4 GOOD_TRADE 룰 자동 탐색</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;" id="rulev2-meta"></div>

<details class="section" open><summary>gtScore 상위 30 (= GOOD + GREAT×0.5 - TRAP×0.7 - openFail5×0.3)</summary><div class="section-body">
  <table class="rules" id="t-rulev2-score"><thead><tr>
    <th class="left">조건</th><th>n</th><th>CLOSE_HIT10</th><th>OPEN_HIT5</th>
    <th>GOOD</th><th>GREAT</th><th>TRAP</th><th>openFail-5%</th>
    <th>시초→종가</th><th>gtScore</th><th>신뢰</th>
  </tr></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>GOOD_TRADE률 상위 30</summary><div class="section-body">
  <table class="rules" id="t-rulev2-good"><thead><tr>
    <th class="left">조건</th><th>n</th><th>GOOD</th><th>GREAT</th><th>TRAP</th>
    <th>openFail-5%</th><th>시초→종가</th><th>신뢰</th>
  </tr></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>TRAP률 낮은 상위 30 (CLOSE_HIT10 ≥ baseline+5pp 조건)</summary><div class="section-body">
  <table class="rules" id="t-rulev2-lowtrap"><thead><tr>
    <th class="left">조건</th><th>n</th><th>CLOSE_HIT10</th><th>GOOD</th><th>TRAP</th>
    <th>openFail-5%</th><th>시초→종가</th><th>신뢰</th>
  </tr></thead><tbody></tbody></table>
</div></details>

<h2>🎯 v4-extra GT_BASE 정제 — 실전형 GOOD_TRADE 조합</h2>
<div class="callout">
  <strong>GT_BASE</strong> = v/mc≥5% + 시총 3000억~7000억 + 다음날 갭&lt;7%<br>
  여기에 LOW_GAP_INTRADAY, 거래대금 순위, 전일 등락률, 최근 급등 횟수를 조합해서 GOOD_TRADE률은 높고 TRAP은 낮은 실전 후보를 좁힌다.<br>
  ⚠ <strong>gapRate &lt; 7%는 다음날 시초가가 있어야 알 수 있는 "장초 확인 조건"</strong> — 전일 예비 조건이 아님. 보드는 전일 저녁에 후보를 뽑고, 다음날 장초에 gapRate로 위험 태그를 갱신하는 구조여야 함.<br>
  목표: <strong>GOOD ≥ 30%, TRAP ≤ 10%, openFail-5% ≤ 30%, n ≥ 50</strong> 모두 만족.
</div>
<table id="t-gtcombo">
  <thead><tr>
    <th class="left">key</th><th class="left">조건</th>
    <th>n</th><th>신뢰</th>
    <th>CLOSE_HIT10</th><th>OPEN_HIT5</th>
    <th>GOOD</th><th>GREAT</th><th>TRAP</th>
    <th>openFail-5%</th>
    <th>시초→고가</th><th>시초→저가</th><th>시초→종가</th>
    <th>gtScore</th><th class="left">목표 달성</th>
  </tr></thead><tbody></tbody>
</table>

<h2>🪧 v4-extra 다음 보드 그룹 초안 제안</h2>
<div id="board-group-proposals"></div>

<h2>🛡 v5 위험 지표 정의</h2>
<div class="callout warn">
  <strong>분봉 데이터 없이 일봉만으로 TRAP/openFail 위험을 식별하는 보조 지표</strong> — 진입 신호가 아니라 보드에서 후보를 제거하기 위한 위험 필터.<br>
  • <strong>GAP_RISK</strong> = 다음날 시초가 갭 ≥ +7% (장초 추격 위험 임계)<br>
  • <strong>BIG_GAP_RISK</strong> = 다음날 시초가 갭 ≥ +12% (강한 추격 주의)<br>
  • <strong>OVERHEAT_TRAP</strong> = 갭 ≥ 7% AND 시초→저가 ≤ -5% (과열 갭 + 큰 흔들림 동반)<br>
  • <strong>NO_ENTRY_ZONE</strong> = 갭 ≥ 7% OR 시초→저가 ≤ -5% (진입 자체가 위험한 영역)
</div>

<h2>🆚 v5 GOOD vs TRAP 전일 조건 비교</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">GOOD 그룹과 TRAP 그룹의 전일 지표를 비교. 차이가 큰 항목이 GOOD/TRAP 식별 단서.</div>
<table id="t-good-vs-trap">
  <thead><tr>
    <th class="left">지표</th>
    <th>GOOD 평균</th><th>GOOD 중앙값</th>
    <th>TRAP 평균</th><th>TRAP 중앙값</th>
    <th>차이</th><th>relDiff</th>
    <th class="left">해석</th>
  </tr></thead><tbody></tbody>
</table>

<h2>🔴 v5 위험 룰 자동 탐색</h2>
<details class="section" open><summary>TRAP률 가장 높은 룰 TOP 30 (보드 경고/하단 배치 후보)</summary><div class="section-body">
  <table class="rules" id="t-trap-high"><thead><tr>
    <th class="left">조건</th><th>n</th>
    <th>TRAP</th><th>NO_ENTRY</th><th>OVERHEAT</th>
    <th>GOOD</th><th>openFail-5%</th><th>GAP_RISK</th><th>시초→종가</th><th>신뢰</th>
  </tr></thead><tbody></tbody></table>
</div></details>
<details class="section" open><summary>NO_ENTRY_ZONE률 가장 높은 룰 TOP 30</summary><div class="section-body">
  <table class="rules" id="t-noentry-high"><thead><tr>
    <th class="left">조건</th><th>n</th>
    <th>NO_ENTRY</th><th>TRAP</th><th>GAP_RISK</th><th>BIG_GAP</th>
    <th>GOOD</th><th>시초→종가</th><th>신뢰</th>
  </tr></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>OVERHEAT_TRAP률 가장 높은 룰 TOP 30</summary><div class="section-body">
  <table class="rules" id="t-overheat-high"><thead><tr>
    <th class="left">조건</th><th>n</th>
    <th>OVERHEAT</th><th>GAP_RISK</th><th>TRAP</th>
    <th>GOOD</th><th>openFail-5%</th><th>신뢰</th>
  </tr></thead><tbody></tbody></table>
</div></details>

<h2>🟢 v5 안전형 GOOD 룰 (safeGtScore 상위)</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">safeGtScore = GOOD + GREAT×0.5 − TRAP×0.8 − openFail-5×0.25 − NO_ENTRY×0.2 (TRAP 가중 강화)</div>
<details class="section" open><summary>safeGtScore 상위 30</summary><div class="section-body">
  <table class="rules" id="t-safegt"><thead><tr>
    <th class="left">조건</th><th>n</th>
    <th>GOOD</th><th>GREAT</th><th>TRAP</th>
    <th>openFail-5%</th><th>NO_ENTRY</th><th>safeGtScore</th><th>신뢰</th>
  </tr></thead><tbody></tbody></table>
</div></details>
<details class="section" open><summary>✅ 목표 달성 룰 (GOOD≥28 + TRAP≤8 + openFail-5≤40 + n≥50)</summary><div class="section-body">
  <table class="rules" id="t-meet-safe"><thead><tr>
    <th class="left">조건</th><th>n</th>
    <th>GOOD</th><th>TRAP</th>
    <th>openFail-5%</th><th>NO_ENTRY</th><th>safeGtScore</th>
  </tr></thead><tbody></tbody></table>
</div></details>

<h2>🌅 v5 다음날 과열 갭 예측 cross-tabs</h2>
<details class="section" open><summary>전일 등락률별 GAP_RISK / BIG_GAP_RISK</summary><div class="section-body">
  <table class="rules" id="t-gap-by-chg"><thead><tr>
    <th class="left">구간</th><th>n</th>
    <th>GAP_RISK</th><th>BIG_GAP</th>
    <th>GOOD</th><th>TRAP</th><th>openFail-5%</th><th>시초→종가</th>
  </tr></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>캔들 구조별</summary><div class="section-body">
  <table class="rules" id="t-gap-by-candle"><thead><tr>
    <th class="left">구간</th><th>n</th><th>GAP_RISK</th><th>BIG_GAP</th><th>GOOD</th><th>TRAP</th><th>openFail-5%</th><th>시초→종가</th>
  </tr></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>v/mc 구간별</summary><div class="section-body">
  <table class="rules" id="t-gap-by-vmc"><thead><tr>
    <th class="left">구간</th><th>n</th><th>GAP_RISK</th><th>BIG_GAP</th><th>GOOD</th><th>TRAP</th><th>openFail-5%</th><th>시초→종가</th>
  </tr></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>recent5Up15Count별</summary><div class="section-body">
  <table class="rules" id="t-gap-by-r5"><thead><tr>
    <th class="left">구간</th><th>n</th><th>GAP_RISK</th><th>BIG_GAP</th><th>GOOD</th><th>TRAP</th><th>openFail-5%</th><th>시초→종가</th>
  </tr></thead><tbody></tbody></table>
</div></details>
<details class="section"><summary>시총별 / 거래대금 순위별 / 갭 / 시가→종가 / 종가위치 / 윗꼬리</summary><div class="section-body">
  <h3>시총 구간별</h3><table class="rules" id="t-gap-by-mc"><thead></thead><tbody></tbody></table>
  <h3>거래대금 순위별</h3><table class="rules" id="t-gap-by-rank"><thead></thead><tbody></tbody></table>
  <h3>baseGapRate별</h3><table class="rules" id="t-gap-by-bgap"><thead></thead><tbody></tbody></table>
  <h3>baseOpenToClose별</h3><table class="rules" id="t-gap-by-bopc"><thead></thead><tbody></tbody></table>
  <h3>종가 위치별</h3><table class="rules" id="t-gap-by-cp"><thead></thead><tbody></tbody></table>
  <h3>윗꼬리별</h3><table class="rules" id="t-gap-by-tail"><thead></thead><tbody></tbody></table>
</div></details>

<h2>🧮 v5 baseGapRate × baseOpenToCloseRate (LOW_GAP_INTRADAY 정밀 정의)</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">셀: GOOD% / TRAP% (n). 색은 (GOOD - TRAP×1.5) 기반.</div>
<div id="m-gap-vs-opc"></div>

<h2>🧬 v5 recent5Up15Count × valueToMcRatio (연속 급등 + 수급 과열 결합)</h2>
<div id="m-r5-vs-vmc"></div>

<h2>🅼 v5 시총 구간별 전용 룰 sub-search</h2>
<div id="per-mc-search"></div>

<h2>🪶 v4-extra2 경량 GOOD_TRADE 후보 연구 (LIGHT/MICRO-cap 별도 검증)</h2>
<div class="callout">
  <strong>질문</strong>: 시총 3,000억~7,000억 균형형 외에, <strong>1,000억~3,000억 경량주</strong>나 <strong>500억~1,000억 초경량주</strong> 안에서도 GOOD_TRADE가 높고 TRAP이 낮은 조건이 있는가?<br>
  목표: GOOD ≥ 30%, TRAP ≤ 10%, openFail-5% ≤ 30%, n ≥ 50 모두 만족하는 조합 찾기.
</div>

<h3>11개 경량 후보 조합 (A~K)</h3>
<table id="t-lightcombo">
  <thead><tr>
    <th class="left">key</th><th class="left">조건</th>
    <th>n</th><th>신뢰</th>
    <th>CLOSE_HIT10</th><th>OPEN_HIT5</th>
    <th>GOOD</th><th>GREAT</th><th>TRAP</th>
    <th>openFail-5%</th>
    <th>시초→고가</th><th>시초→저가</th><th>시초→종가</th>
    <th>gtScore</th><th class="left">목표 달성</th>
  </tr></thead><tbody></tbody>
</table>

<h3>4개 시총 그룹 × 5개 조건 매트릭스</h3>
<div class="muted" style="font-size:11px;margin-bottom:6px;">각 셀: GOOD% / TRAP% / n / gtScore. 셀 색은 gtScore 기반.</div>
<table class="matrix" id="t-light-matrix"></table>

<h2>📊 60일 baseline vs 현재 (windowDays) 비교</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;" id="compare-meta"></div>
<table id="t-compare-baseline">
  <thead><tr>
    <th class="left">섹션</th>
    <th class="left">지표</th>
    <th>60일 baseline</th>
    <th>현재</th>
    <th>delta</th>
    <th class="left">판정</th>
  </tr></thead>
  <tbody></tbody>
</table>
<div class="callout" id="baseline-verdicts"></div>

<h2>📂 [보조] 기존 A/B/C/D 그룹별 성과</h2>
<table id="t-group-summary">
  <thead><tr>
    <th class="left">그룹</th><th>n</th>
    <th>+3%</th><th>+5%</th><th>+10%</th>
    <th>평균 시초</th><th>평균 고가</th><th>평균 종가</th>
    <th>실패율 (-3%↓)</th>
  </tr></thead><tbody></tbody>
</table>

<h2>🧠 자동 결론</h2>
<div id="auto-conclusion"></div>

<script>
const DATA = __JSON_DATA__;
const BASE_RATE = DATA.meta.hit10Rate || 0;

function isNum(v) { return v != null && Number.isFinite(v); }
function fmtPct(v, prec) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(prec || 2) + '%' : '-'; }
function fmtRate(v, prec) { return isNum(v) ? v.toFixed(prec || 1) + '%' : '-'; }
function fmtNum(v) { return isNum(v) ? Math.round(v).toLocaleString() : '-'; }
function fmtFix(v, prec) { return isNum(v) ? v.toFixed(prec || 2) : '-'; }
function fmtMoney(v) {
  if (!isNum(v)) return '-';
  if (v >= 1e12) return (v/1e12).toFixed(2) + '조';
  if (v >= 1e8) return (v/1e8).toFixed(1) + '억';
  if (v >= 1e4) return (v/1e4).toFixed(0) + '만';
  return Math.round(v).toLocaleString();
}
function fmtDate(d) { if (!d || String(d).length !== 8) return d || '-'; const s=String(d); return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8); }
function fmtMetricValue(v, unit, prec) {
  if (!isNum(v)) return '-';
  if (unit === 'pct') return v.toFixed(prec != null ? prec : 2) + '%';
  if (unit === 'won') return fmtMoney(v);
  if (unit === 'x')   return '×' + v.toFixed(prec != null ? prec : 2);
  return v.toFixed(prec != null ? prec : 2);
}

document.getElementById('meta-line').innerHTML =
  '검증 윈도우: <strong>' + (DATA.meta.windowFromFmt || '-') + ' ~ ' + (DATA.meta.windowToFmt || '-') + '</strong> (' + DATA.meta.windowDays + '거래일)' +
  ' · 처리 종목: ' + DATA.meta.stocksProcessed +
  ' · 분류 이벤트: ' + DATA.meta.totalEvents +
  ' · HIT10: <strong>' + DATA.meta.hit10Total + ' (' + (DATA.meta.hit10Rate||0).toFixed(1) + '%)</strong>' +
  ' · base 실패 종가/저가/openLow5: ' + (DATA.meta.baseFailClose||0).toFixed(1) + '% / ' + (DATA.meta.baseFailLow||0).toFixed(1) + '% / ' + (DATA.meta.baseOpenFail5||0).toFixed(1) + '%' +
  ' · QVA 호출 ' + (DATA.meta.qvaCallsTotal||0).toLocaleString() + ' / 통과 ' + (DATA.meta.qvaPassedTotal||0).toLocaleString() +
  ' · 처리시간 ' + ((DATA.meta.elapsedMs||0)/1000).toFixed(1) + 's';

// ── 핵심 요약 ──
(function() {
  const s = DATA.summary;
  const cells = [
    { lab: '전체 후보', val: fmtNum(s.totalEvents), sub: '분류 이벤트 총수' },
    { lab: 'HIT10', val: fmtNum(s.hit10Count) + ' (' + fmtRate(s.hit10Rate) + ')', sub: '다음날 고가 ≥ +10%', cls: 'hit10' },
    { lab: '평균 다음날 고가', val: fmtPct(s.avgNextHigh), sub: '전일종가 기준' },
    { lab: '평균 다음날 종가', val: fmtPct(s.avgNextClose), sub: '전일종가 기준' },
    { lab: '평균 다음날 저가', val: fmtPct(s.avgNextLow), sub: '전일종가 기준' },
    { lab: '+5% 도달률', val: fmtRate(s.hit5Rate), sub: '전일종가 기준' },
    { lab: '+10% 도달률', val: fmtRate(s.hit10RateAlias), sub: '전일종가 기준', cls: 'hit10' },
    { lab: '종가 -3%↓ 실패율', val: fmtRate(s.failCloseRate), sub: '전일종가 기준', cls: 'fail' },
    { lab: '저가 -5%↓ 급락', val: fmtRate(s.failLowPlungeRate), sub: '전일종가 기준', cls: 'fail' },
    { lab: '🚪 openHit5', val: fmtRate(s.openHit5Rate), sub: '시초가 진입자 +5% 도달', cls: 'open' },
    { lab: '🚪 openHit10', val: fmtRate(s.openHit10Rate), sub: '시초가 진입자 +10% 도달', cls: 'open' },
    { lab: '🚪 openFail-5%', val: fmtRate(s.openFail5Rate), sub: '시초가 대비 저가 -5%', cls: 'fail' },
    { lab: '🚪 시초→종가 평균', val: fmtPct(s.avgNextCloseFromOpen), sub: '시초가 진입자 종가 손익', cls: 'open' },
    { lab: '🛒 GOOD_TRADE률', val: fmtRate(s.goodTradeRate), sub: '시초 진입 + 흔들림 적음', cls: 'open' },
    { lab: '⭐ GREAT_TRADE률', val: fmtRate(s.greatTradeRate), sub: 'GOOD + 종가 ≥ 0%', cls: 'open' },
    { lab: '⚠ TRAP률', val: fmtRate(s.trapRate), sub: 'HIT10인데 시초→저가 ≤ -5%', cls: 'fail' },
    { lab: '🌅 GAP_RISK', val: fmtRate(s.gapRiskRate), sub: '다음날 갭 ≥ +7%', cls: 'fail' },
    { lab: '🌪 BIG_GAP_RISK', val: fmtRate(s.bigGapRiskRate), sub: '다음날 갭 ≥ +12%', cls: 'fail' },
    { lab: '☢ OVERHEAT_TRAP', val: fmtRate(s.overheatTrapRate), sub: '갭≥7% AND 시초→저가 ≤-5%', cls: 'fail' },
    { lab: '🚫 NO_ENTRY_ZONE', val: fmtRate(s.noEntryZoneRate), sub: '갭≥7% OR 시초→저가 ≤-5%', cls: 'fail' },
    { lab: '🛰 QVA 보유 이벤트', val: fmtNum(DATA.meta.eventsWithQvaCount), sub: 'baseDate 이전 [D-1,D-20] QVA 1건+', cls: 'qva' },
  ];
  document.getElementById('summary-grid').innerHTML = cells.map(c =>
    '<div class="summary-cell ' + (c.cls || '') + '">' +
      '<div class="label">' + c.lab + '</div>' +
      '<div class="value">' + c.val + '</div>' +
      '<div class="sub">' + c.sub + '</div>' +
    '</div>'
  ).join('');
})();

// ── 비교표 ──
(function() {
  const tb = document.querySelector('#t-compare tbody');
  tb.innerHTML = (DATA.comparison || []).map(c => {
    const diffCls = !isNum(c.diffMean) ? '' : (c.diffMean > 0 ? 'diff-pos' : 'diff-neg');
    return '<tr>' +
      '<td class="left">' + c.label + '</td>' +
      '<td>' + fmtMetricValue(c.hit10Mean, c.unit) + '</td>' +
      '<td>' + fmtMetricValue(c.hit10Median, c.unit) + '</td>' +
      '<td>' + fmtMetricValue(c.nonMean, c.unit) + '</td>' +
      '<td>' + fmtMetricValue(c.nonMedian, c.unit) + '</td>' +
      '<td class="' + diffCls + '">' + fmtMetricValue(c.diffMean, c.unit) + '</td>' +
      '<td class="' + diffCls + '">' + (isNum(c.relDiff) ? (c.relDiff > 0 ? '+' : '') + (c.relDiff * 100).toFixed(1) + '%' : '-') + '</td>' +
    '</tr>';
  }).join('');
})();

// ── 1D Cross-tab ──
function renderCrossTab(elemId, rows, includeAvgClose) {
  const el = document.getElementById(elemId);
  if (!el) return;
  el.querySelector('thead').innerHTML =
    '<tr><th class="left">구간</th><th>n</th><th>HIT10</th><th>HIT10률</th>' +
    '<th>평균 고가</th>' + (includeAvgClose ? '<th>평균 종가</th>' : '') +
    '<th>실패율 (-3%↓)</th><th>갭다운 -3%↓</th><th>저가 -5%↓</th></tr>';
  el.querySelector('tbody').innerHTML = (rows || []).map(r =>
    '<tr><td class="left">' + r.label + '</td>' +
    '<td>' + fmtNum(r.count) + '</td>' +
    '<td>' + fmtNum(r.hit10) + '</td>' +
    '<td><strong>' + fmtRate(r.hit10Rate) + '</strong></td>' +
    '<td>' + fmtPct(r.avgNextHigh) + '</td>' +
    (includeAvgClose ? '<td>' + fmtPct(r.avgNextClose) + '</td>' : '') +
    '<td>' + fmtRate(r.failCloseRate) + '</td>' +
    '<td>' + fmtRate(r.failGapDownRate) + '</td>' +
    '<td>' + fmtRate(r.failLowPlungeRate) + '</td></tr>'
  ).join('');
}
renderCrossTab('ct-valueRatio',     DATA.crossTabs.valueRatio,     true);
renderCrossTab('ct-marketCap',      DATA.crossTabs.marketCap,      true);
renderCrossTab('ct-closePosition',  DATA.crossTabs.closePosition,  true);
renderCrossTab('ct-upperTailRatio', DATA.crossTabs.upperTailRatio, true);
renderCrossTab('ct-dayChangeRate',  DATA.crossTabs.dayChangeRate,  true);
renderCrossTab('ct-recent3Rate',    DATA.crossTabs.recent3Rate,    true);
renderCrossTab('ct-recent5Rate',    DATA.crossTabs.recent5Rate,    true);
renderCrossTab('ct-score',          DATA.crossTabs.score,          true);
renderCrossTab('ct-group',          DATA.crossTabs.group,          true);

// ── 2D matrix ──
function cellClass(rate, count) {
  if (count < 20) return 'cell cell-low-n cell-na';
  if (!isNum(rate)) return 'cell cell-na';
  const lift = rate - BASE_RATE;
  if (lift >= 30) return 'cell cell-up30';
  if (lift >= 20) return 'cell cell-up20';
  if (lift >= 10) return 'cell cell-up10';
  if (lift >= 5)  return 'cell cell-up5';
  if (lift >= -5) return 'cell cell-base';
  return 'cell cell-down';
}
function renderMatrix(containerId, mtx) {
  const el = document.getElementById(containerId);
  if (!el || !mtx) return;
  const rows = [];
  rows.push('<tr><th class="row-h"></th>' + mtx.xBands.map(x => '<th class="col-h">' + x + '</th>').join('') + '</tr>');
  for (let yi = 0; yi < mtx.yBands.length; yi++) {
    const cells = [];
    cells.push('<th class="row-h">' + mtx.yBands[yi] + '</th>');
    for (let xi = 0; xi < mtx.xBands.length; xi++) {
      const cell = mtx.cells.find(c => c.x === xi && c.y === yi);
      if (!cell || cell.count === 0) {
        cells.push('<td class="cell cell-na"><span class="rate">-</span><span class="meta">n=0</span></td>');
      } else if (cell.count < 20) {
        cells.push('<td class="cell cell-low-n cell-na"><span class="rate">' + fmtRate(cell.hit10Rate) + '</span><span class="meta">n=' + cell.count + ' 표본부족</span></td>');
      } else {
        cells.push('<td class="' + cellClass(cell.hit10Rate, cell.count) + '">' +
          '<span class="rate">' + fmtRate(cell.hit10Rate) + '</span>' +
          '<span class="meta">n=' + cell.count + ' · ' + fmtPct(cell.avgNextHigh, 1) + ' · 실패 ' + fmtRate(cell.failCloseRate, 0) + '</span>' +
        '</td>');
      }
    }
    rows.push('<tr>' + cells.join('') + '</tr>');
  }
  el.innerHTML = '<table class="matrix">' + rows.join('') + '</table>';
}
const M2 = DATA.crossTabs2D || {};
[['A','A_dayChg_x_closePos'],['B','B_dayChg_x_tail'],['C','C_value_x_dayChg'],['D','D_recent5_x_tail'],['E','E_recent3_x_closePos'],['F','F_mc_x_dayChg']].forEach(([k, key]) => {
  const m = M2[key];
  if (m) {
    document.getElementById('m2-' + k + '-sum').textContent = m.title;
    renderMatrix('m2-' + k, m);
  }
});

// ── 명명된 조건 (open-base) ──
(function() {
  const tb = document.querySelector('#t-named-cond tbody');
  tb.innerHTML = (DATA.namedConditions || []).map(c => {
    const trapBad = isNum(c.hit10Rate) && isNum(c.openHit5Rate) && c.hit10Rate >= BASE_RATE + 15 && c.openHit5Rate < c.hit10Rate * 0.6;
    return '<tr>' +
      '<td class="left">' + c.label + (trapBad ? ' <span class="tag tag-r">상따 함정</span>' : '') + '</td>' +
      '<td>' + fmtNum(c.count) + '</td>' +
      '<td><strong>' + fmtRate(c.hit10Rate) + '</strong></td>' +
      '<td>' + fmtRate(c.openHit3Rate) + '</td>' +
      '<td>' + fmtRate(c.openHit5Rate) + '</td>' +
      '<td>' + fmtRate(c.openHit10Rate) + '</td>' +
      '<td>' + fmtRate(c.openFail3Rate) + '</td>' +
      '<td>' + fmtRate(c.openFail5Rate) + '</td>' +
      '<td>' + fmtPct(c.avgNextCloseFromOpen) + '</td>' +
    '</tr>';
  }).join('');
})();

// ── 갭 cross-tab ──
(function() {
  const tb = document.querySelector('#t-gap tbody');
  tb.innerHTML = (DATA.gapTab || []).map(c =>
    '<tr><td class="left">' + c.label + '</td>' +
    '<td>' + fmtNum(c.count) + '</td>' +
    '<td><strong>' + fmtRate(c.hit10Rate) + '</strong></td>' +
    '<td>' + fmtRate(c.openHit3Rate) + '</td>' +
    '<td>' + fmtRate(c.openHit5Rate) + '</td>' +
    '<td>' + fmtRate(c.openHit10Rate) + '</td>' +
    '<td>' + fmtRate(c.openFail3Rate) + '</td>' +
    '<td>' + fmtRate(c.openFail5Rate) + '</td>' +
    '<td>' + fmtPct(c.avgNextHighFromOpen) + '</td>' +
    '<td>' + fmtPct(c.avgNextCloseFromOpen) + '</td>' +
    '<td>' + fmtPct(c.avgNextLowFromOpen) + '</td></tr>'
  ).join('');
})();

// ── HIT10 유형 카드 ──
(function() {
  const TYPE_META = {
    TYPE_1_STRONG_CLOSE:      { cls: 't-T1', title: '🟢 TYPE_1 강한 마감 후 연속 급등형', desc: '전날 강하게 오른 뒤 고가권에서 마감해 다음 거래일에도 수급이 이어진 유형.' },
    TYPE_2_TAIL_REBREAK:      { cls: 't-T2', title: '🟠 TYPE_2 윗꼬리 후 재돌파형', desc: '전날 고점에서 일부 밀렸지만 거래대금이 크게 들어왔고, 다음 거래일 다시 고점을 넘기며 급등한 유형.' },
    TYPE_3_FIRST_VALUE_SURGE: { cls: 't-T3', title: '🔵 TYPE_3 초동 거래대금 폭발형', desc: '최근 조용하다가 전날 처음으로 큰 거래대금이 들어온 뒤 다음 거래일 급등한 유형.' },
    TYPE_ETC:                 { cls: 't-TE', title: '⚪ TYPE_ETC 미분류', desc: '위 3개 유형 어디에도 들어가지 않은 케이스.' },
  };
  document.getElementById('types-grid').innerHTML = Object.keys(TYPE_META).map(t => {
    const x = DATA.hit10Types[t] || {};
    const m = TYPE_META[t];
    return '<div class="type-card ' + m.cls + '">' +
      '<h4>' + m.title + '</h4><div class="desc">' + m.desc + '</div>' +
      '<div class="stats"><strong>' + fmtNum(x.count) + '</strong>건 · HIT10 <strong>' + fmtNum(x.hit10) + '</strong> (도달률 <strong>' + fmtRate(x.hit10Rate) + '</strong>)<br>' +
      '평균 시초 ' + fmtPct(x.avgNextOpen) + ' · 고가 ' + fmtPct(x.avgNextHigh) + ' · 종가 ' + fmtPct(x.avgNextClose) + '<br>' +
      '실패 종가 ' + fmtRate(x.failCloseRate) + ' / 저가 ' + fmtRate(x.failLowPlungeRate) + '<br>' +
      '🚪 openHit5 ' + fmtRate(x.openHit5Rate) + ' · openFail-5% ' + fmtRate(x.openFail5Rate) + '</div></div>';
  }).join('');

  // T1 세부
  const tb = document.querySelector('#t-t1subtypes tbody');
  const order = ['T1_E_LIMIT_UP_STYLE','T1_A_SUPER_CLOSE_VALUE','T1_B_SUPER_CLOSE_LOW_VALUE','T1_C_GOOD_CLOSE_HIGH_VALUE','T1_D_GOOD_CLOSE_NORMAL_VALUE','TYPE_1_OTHER'];
  tb.innerHTML = order.map(k => {
    const x = DATA.type1Subtypes[k] || {};
    return '<tr><td class="left"><strong>' + k + '</strong><br><span class="muted" style="font-size:10px;">' + (x.label || '') + '</span></td>' +
      '<td>' + fmtNum(x.count) + '</td><td>' + fmtRate(x.hit5Rate) + '</td>' +
      '<td><strong>' + fmtRate(x.hit10Rate) + '</strong></td>' +
      '<td>' + fmtPct(x.avgNextOpen) + '</td><td>' + fmtPct(x.avgNextHigh) + '</td><td>' + fmtPct(x.avgNextClose) + '</td>' +
      '<td>' + fmtRate(x.failCloseRate) + '</td><td>' + fmtRate(x.failLowPlungeRate) + '</td>' +
      '<td>' + fmtMoney(x.avgMarketCap) + '</td><td>×' + fmtFix(x.avgValueRatio, 1) + '</td></tr>';
  }).join('');
})();

// ── 룰 표 ──
function reliabilityTag(n) {
  if (n >= 50) return '<span class="tag tag-q">신뢰</span>';
  if (n >= 30) return '<span class="tag tag-ref">참고</span>';
  return '';
}
function renderRules(elemId, rows, withTag) {
  const tb = document.querySelector('#' + elemId + ' tbody');
  if (!tb) return;
  tb.innerHTML = (rows || []).map(r => {
    const cls = withTag === 'q' ? 'high-q' : (withTag === 'r' ? 'high-r' : '');
    return '<tr class="' + cls + '">' +
      '<td class="label">' + r.label + '</td>' +
      '<td>' + fmtNum(r.n) + '</td>' +
      '<td><strong>' + fmtRate(r.hit10Rate) + '</strong></td>' +
      '<td>' + fmtRate(r.hit5Rate) + '</td>' +
      '<td>' + (isNum(r.lift) ? (r.lift > 0 ? '+' : '') + r.lift.toFixed(1) + 'pp' : '-') + '</td>' +
      '<td>' + fmtPct(r.avgNextHigh) + '</td>' +
      '<td>' + fmtPct(r.avgNextClose) + '</td>' +
      '<td>' + fmtRate(r.failCloseRate) + '</td>' +
      '<td>' + fmtRate(r.failLowPlungeRate) + '</td>' +
      (withTag ? '' : '<td>' + (isNum(r.riskAdj) ? r.riskAdj.toFixed(1) : '-') + '</td><td>' + reliabilityTag(r.n) + '</td>') +
    '</tr>';
  }).join('');
}
document.getElementById('rule-meta').textContent =
  '룰 ' + DATA.ruleSearch.totalRulesEvaluated + '건 평가 · n≥30 ' + DATA.ruleSearch.rulesWithNGte30 + '건 · n≥50 ' + DATA.ruleSearch.rulesWithNGte50 + '건';
renderRules('t-rules-hit10',    (DATA.ruleSearch.topByHit10 || []).slice(0, 30));
renderRules('t-rules-riskadj',  (DATA.ruleSearch.topByRiskAdj || []).slice(0, 30));
renderRules('t-rules-quality',  (DATA.ruleSearch.highQuality || []).slice(0, 30), 'q');
renderRules('t-rules-risk',     (DATA.ruleSearch.highRisk || []).slice(0, 30), 'r');

// ── QVA 요약 ──
(function() {
  const q = DATA.qvaSummary || {};
  const el = document.querySelector('#t-qva-summary');
  el.querySelector('thead').innerHTML = '<tr><th class="left">항목</th><th>값</th></tr>';
  const rows = [
    ['전체 후보', fmtNum(q.totalEvents)],
    ['HIT10 수', fmtNum(q.hit10Count)],
    ['HIT10 중 QVA 이력 있음', fmtNum(q.hit10WithQvaCount) + ' (' + fmtRate(q.hit10WithQvaShare) + ')'],
    ['NON_HIT10 중 QVA 이력 있음 비율', fmtRate(q.nonHit10WithQvaShare)],
    ['QVA 있음 그룹 HIT10률', '<strong>' + fmtRate(q.hit10RateWithQva) + '</strong>'],
    ['QVA 없음 그룹 HIT10률', '<strong>' + fmtRate(q.hit10RateNoQva) + '</strong>'],
    ['QVA 보유 이벤트 / 미보유 이벤트', fmtNum(q.eventsWithQvaCount) + ' / ' + fmtNum(q.eventsNoQvaCount)],
  ];
  el.querySelector('tbody').innerHTML = rows.map(r => '<tr><td class="left">' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('');
})();

(function() {
  const tb = document.querySelector('#t-qva-presence tbody');
  tb.innerHTML = (DATA.qvaPresenceTab || []).map(c =>
    '<tr class="qva-row"><td class="left">' + c.label + '</td>' +
    '<td>' + fmtNum(c.count) + '</td>' +
    '<td>' + fmtRate(c.hit3Rate) + '</td>' +
    '<td>' + fmtRate(c.hit5Rate) + '</td>' +
    '<td><strong>' + fmtRate(c.hit10Rate) + '</strong></td>' +
    '<td>' + fmtPct(c.avgNextHigh) + '</td>' +
    '<td>' + fmtPct(c.avgNextClose) + '</td>' +
    '<td>' + fmtRate(c.failCloseRate) + '</td>' +
    '<td>' + fmtRate(c.failLowPlungeRate) + '</td>' +
    '<td>' + fmtRate(c.openHit5Rate) + '</td>' +
    '<td>' + fmtRate(c.openFail5Rate) + '</td></tr>'
  ).join('');
})();

(function() {
  const tb = document.querySelector('#t-qva-gap tbody');
  tb.innerHTML = (DATA.qvaGapTab || []).map(c =>
    '<tr><td class="left">' + c.label + '</td>' +
    '<td>' + fmtNum(c.count) + '</td>' +
    '<td><strong>' + fmtRate(c.hit10Rate) + '</strong></td>' +
    '<td>' + fmtPct(c.avgNextHigh) + '</td>' +
    '<td>' + fmtPct(c.avgNextClose) + '</td>' +
    '<td>' + fmtRate(c.failCloseRate) + '</td>' +
    '<td>' + fmtRate(c.failLowPlungeRate) + '</td>' +
    '<td>' + fmtRate(c.openHit5Rate) + '</td>' +
    '<td>' + fmtRate(c.openFail5Rate) + '</td></tr>'
  ).join('');
})();

function renderQvaCross(elemId, rows) {
  const tb = document.querySelector('#' + elemId + ' tbody');
  tb.innerHTML = (rows || []).map(c =>
    '<tr><td class="left">' + c.label + '</td>' +
    '<td>' + fmtNum(c.count) + '</td>' +
    '<td><strong>' + fmtRate(c.hit10Rate) + '</strong></td>' +
    '<td>' + fmtPct(c.avgNextHigh) + '</td>' +
    '<td>' + fmtRate(c.failCloseRate) + '</td>' +
    '<td>' + fmtRate(c.failLowPlungeRate) + '</td>' +
    '<td>' + fmtRate(c.openHit5Rate) + '</td>' +
    '<td>' + fmtRate(c.openFail5Rate) + '</td>' +
    '<td>' + fmtPct(c.avgNextCloseFromOpen) + '</td></tr>'
  ).join('');
}
renderQvaCross('t-s-qva', DATA.sCandQvaTab);
renderQvaCross('t-r-qva', DATA.rCandQvaTab);

// ── HIT10 + QVA 상위 100 ──
(function() {
  const TYPE_SHORT = {
    TYPE_1_STRONG_CLOSE: 'T1', TYPE_2_TAIL_REBREAK: 'T2',
    TYPE_3_FIRST_VALUE_SURGE: 'T3', TYPE_ETC: 'ETC',
  };
  const tb = document.querySelector('#t-top-qva tbody');
  tb.innerHTML = (DATA.topHit10Qva || []).map(e => '<tr class="qva-row">' +
    '<td class="left">' + (e.name || '-') + '</td>' +
    '<td class="left muted">' + (e.code || '-') + '</td>' +
    '<td class="left">' + fmtDate(e.baseDate) + '</td>' +
    '<td class="left">' + fmtDate(e.nextDate) + '</td>' +
    '<td class="' + (isNum(e.nextOpenRate) && e.nextOpenRate > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.nextOpenRate, 1) + '</td>' +
    '<td class="pos"><strong>' + fmtPct(e.nextHighRate, 1) + '</strong></td>' +
    '<td class="' + (isNum(e.nextCloseRate) && e.nextCloseRate > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.nextCloseRate, 1) + '</td>' +
    '<td class="' + (isNum(e.nextLowRate) && e.nextLowRate > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.nextLowRate, 1) + '</td>' +
    '<td>' + fmtPct(e.nextHighFromOpenRate, 1) + '</td>' +
    '<td>' + fmtPct(e.nextLowFromOpenRate, 1) + '</td>' +
    '<td>' + fmtPct(e.nextCloseFromOpenRate, 1) + '</td>' +
    '<td class="left">' + fmtDate(e.mostRecentPriorQvaDate) + '</td>' +
    '<td>D-' + (e.mostRecentPriorQvaGap || '-') + '</td>' +
    '<td>×' + fmtFix(e.valueRatio, 1) + '</td>' +
    '<td>' + fmtPct(e.dayChangeRate, 1) + '</td>' +
    '<td>' + (isNum(e.closePosition) ? (e.closePosition*100).toFixed(0) + '%' : '-') + '</td>' +
    '<td>' + (isNum(e.upperTailRatio) ? (e.upperTailRatio*100).toFixed(0) + '%' : '-') + '</td>' +
    '<td>' + fmtPct(e.recent3Rate, 1) + '</td>' +
    '<td>' + fmtPct(e.recent5Rate, 1) + '</td>' +
    '<td>' + fmtMoney(e.marketCap) + '</td>' +
    '<td>' + (e.group || '-') + '</td>' +
    '<td class="left muted">' + (TYPE_SHORT[e.hit10Type] || e.hit10Type || '-') + '</td>' +
  '</tr>').join('');
})();

// ── 상위 100 HIT10 (전체) ──
(function() {
  const TYPE_SHORT = {
    TYPE_1_STRONG_CLOSE: 'T1', TYPE_2_TAIL_REBREAK: 'T2',
    TYPE_3_FIRST_VALUE_SURGE: 'T3', TYPE_ETC: 'ETC',
  };
  const tb = document.querySelector('#t-top tbody');
  tb.innerHTML = (DATA.topHit10 || []).map(e => '<tr class="hit10-row">' +
    '<td class="left">' + (e.name || '-') + '</td>' +
    '<td class="left muted">' + (e.code || '-') + '</td>' +
    '<td class="left">' + fmtDate(e.baseDate) + '</td>' +
    '<td class="left">' + fmtDate(e.nextDate) + '</td>' +
    '<td class="' + (isNum(e.nextOpenRate) && e.nextOpenRate > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.nextOpenRate, 1) + '</td>' +
    '<td class="pos"><strong>' + fmtPct(e.nextHighRate, 1) + '</strong></td>' +
    '<td class="' + (isNum(e.nextCloseRate) && e.nextCloseRate > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.nextCloseRate, 1) + '</td>' +
    '<td class="' + (isNum(e.nextLowRate) && e.nextLowRate > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.nextLowRate, 1) + '</td>' +
    '<td>×' + fmtFix(e.valueRatio, 1) + '</td>' +
    '<td>×' + fmtFix(e.volumeRatio, 1) + '</td>' +
    '<td>' + fmtMoney(e.marketCap) + '</td>' +
    '<td>' + fmtPct(e.dayChangeRate, 1) + '</td>' +
    '<td>' + (isNum(e.closePosition) ? (e.closePosition*100).toFixed(0) + '%' : '-') + '</td>' +
    '<td>' + (isNum(e.upperTailRatio) ? (e.upperTailRatio*100).toFixed(0) + '%' : '-') + '</td>' +
    '<td>' + fmtPct(e.recent3Rate, 1) + '</td>' +
    '<td>' + fmtPct(e.recent5Rate, 1) + '</td>' +
    '<td><strong>' + fmtNum(e.oneDaySurgeScore) + '</strong></td>' +
    '<td>' + (e.group || '-') + '</td>' +
    '<td class="left muted">' + (TYPE_SHORT[e.hit10Type] || e.hit10Type || '-') + '</td>' +
    '<td class="left">' + (e.hasPriorQva20 ? '<span class="tag tag-qva">D-' + (e.mostRecentPriorQvaGap || '?') + '</span>' : '-') + '</td>' +
  '</tr>').join('');
})();

// ── 그룹별 ──
(function() {
  const tb = document.querySelector('#t-group-summary tbody');
  tb.innerHTML = ['A','B','C','D','ALL'].map(g => {
    const x = DATA.byGroup[g] || {};
    return '<tr class="row-' + g + '"><td class="left">' + g + '</td>' +
      '<td>' + fmtNum(x.count) + '</td>' +
      '<td>' + fmtRate(x.hit3Rate) + '</td>' +
      '<td>' + fmtRate(x.hit5Rate) + '</td>' +
      '<td><strong>' + fmtRate(x.hit10Rate) + '</strong></td>' +
      '<td>' + fmtPct(x.avgNextOpen) + '</td>' +
      '<td>' + fmtPct(x.avgNextHigh) + '</td>' +
      '<td>' + fmtPct(x.avgNextClose) + '</td>' +
      '<td>' + fmtRate(x.failCloseRate) + '</td></tr>';
  }).join('');
})();

// ── v4 신규 cross-tab 렌더 (GOOD/GREAT/TRAP 포함) ──
function renderRichTab(elemId, rows, withClose) {
  const el = document.getElementById(elemId);
  if (!el) return;
  el.querySelector('thead').innerHTML =
    '<tr><th class="left">구간</th><th>n</th>' +
    (withClose ? '<th>CLOSE_HIT10</th>' : '') +
    '<th>OPEN_HIT5</th><th>GOOD_TRADE</th><th>GREAT_TRADE</th><th>TRAP</th>' +
    '<th>openFail-5%</th><th>시초→종가 평균</th><th>시초→고가 평균</th><th>시초→저가 평균</th></tr>';
  el.querySelector('tbody').innerHTML = (rows || []).map(r => {
    const trapCls = isNum(r.trapRate) && r.trapRate >= 30 ? 'neg' : '';
    const goodCls = isNum(r.goodTradeRate) && r.goodTradeRate >= 25 ? 'pos' : '';
    return '<tr><td class="left">' + (r.label || r.type || '-') + '</td>' +
      '<td>' + fmtNum(r.count) + '</td>' +
      (withClose ? '<td>' + fmtRate(r.hit10Rate) + '</td>' : '') +
      '<td>' + fmtRate(r.openHit5Rate) + '</td>' +
      '<td class="' + goodCls + '"><strong>' + fmtRate(r.goodTradeRate) + '</strong></td>' +
      '<td>' + fmtRate(r.greatTradeRate) + '</td>' +
      '<td class="' + trapCls + '">' + fmtRate(r.trapRate) + '</td>' +
      '<td>' + fmtRate(r.openFail5Rate) + '</td>' +
      '<td>' + fmtPct(r.avgNextCloseFromOpen) + '</td>' +
      '<td>' + fmtPct(r.avgNextHighFromOpen) + '</td>' +
      '<td>' + fmtPct(r.avgNextLowFromOpen) + '</td></tr>';
  }).join('');
}
renderRichTab('ct-vmcratio',  DATA.valueToMcRatioTab, true);
renderRichTab('ct-vamount',   DATA.valueAmountTab,    true);
renderRichTab('ct-chgfine',   DATA.dayChangeFineTab,  true);
renderRichTab('ct-candle',    DATA.candleTab,         true);
renderRichTab('ct-highbreak', DATA.highBreakTab,      true);
renderRichTab('ct-r5up15',    DATA.recentSurgeTabs && DATA.recentSurgeTabs.recent5Up15,  true);
renderRichTab('ct-r5up7',     DATA.recentSurgeTabs && DATA.recentSurgeTabs.recent5Up7,   true);
renderRichTab('ct-r10up15',   DATA.recentSurgeTabs && DATA.recentSurgeTabs.recent10Up15, true);
renderRichTab('ct-r10limit',  DATA.recentSurgeTabs && DATA.recentSurgeTabs.recent10LimitStyle, true);
renderRichTab('ct-vrank',     DATA.valueRankTab,      true);

// ── S2/S3 변형 ──
(function() {
  const tb = document.querySelector('#t-svariant tbody');
  if (!tb) return;
  const rows = [];
  for (const v of (DATA.sVariantTab || [])) {
    const subs = [
      { label: '전체',           data: v.all },
      { label: 'QVA D-15~D-20 있음', data: v.withQva15_20 },
      { label: 'QVA D-15~D-20 없음', data: v.woQva15_20 },
    ];
    let first = true;
    for (const s of subs) {
      const d = s.data || {};
      rows.push('<tr>' +
        (first ? '<td class="left" rowspan="3"><strong>' + v.key + '</strong></td><td class="left" rowspan="3" style="font-size:10px;color:#94a3b8;">' + v.label + '</td>' : '') +
        '<td>' + s.label + '</td>' +
        '<td>' + fmtNum(d.count) + '</td>' +
        '<td>' + fmtRate(d.hit10Rate) + '</td>' +
        '<td>' + fmtRate(d.openHit5Rate) + '</td>' +
        '<td><strong>' + fmtRate(d.goodTradeRate) + '</strong></td>' +
        '<td>' + fmtRate(d.greatTradeRate) + '</td>' +
        '<td>' + fmtRate(d.trapRate) + '</td>' +
        '<td>' + fmtRate(d.openFail5Rate) + '</td>' +
        '<td>' + fmtPct(d.avgNextCloseFromOpen) + '</td>' +
      '</tr>');
      first = false;
    }
  }
  tb.innerHTML = rows.join('');
})();

// ── V2 룰 탐색 ──
(function() {
  const meta = document.getElementById('rulev2-meta');
  if (meta && DATA.ruleSearchV2) {
    meta.textContent = 'V2 룰 ' + DATA.ruleSearchV2.totalRulesEvaluated + '건 평가 · n≥30 ' + DATA.ruleSearchV2.rulesWithNGte30 + '건 · n≥50 ' + DATA.ruleSearchV2.rulesWithNGte50 + '건. base GOOD ' + (DATA.ruleSearchV2.baseGoodTrade||0).toFixed(1) + '% / GREAT ' + (DATA.ruleSearchV2.baseGreatTrade||0).toFixed(1) + '% / TRAP ' + (DATA.ruleSearchV2.baseTrap||0).toFixed(1) + '%';
  }
  function tagN(n) { return n >= 50 ? '<span class="tag v-hold">신뢰</span>' : (n >= 30 ? '<span class="tag tag-ref">참고</span>' : ''); }
  const tbScore = document.querySelector('#t-rulev2-score tbody');
  if (tbScore && DATA.ruleSearchV2) {
    tbScore.innerHTML = (DATA.ruleSearchV2.topByGtScore || []).map(r =>
      '<tr><td class="label">' + r.label + '</td>' +
      '<td>' + fmtNum(r.n) + '</td>' +
      '<td>' + fmtRate(r.closeHit10Rate) + '</td>' +
      '<td>' + fmtRate(r.openHit5Rate) + '</td>' +
      '<td><strong>' + fmtRate(r.goodTradeRate) + '</strong></td>' +
      '<td>' + fmtRate(r.greatTradeRate) + '</td>' +
      '<td>' + fmtRate(r.trapRate) + '</td>' +
      '<td>' + fmtRate(r.openFail5Rate) + '</td>' +
      '<td>' + fmtPct(r.avgNextCloseFromOpen) + '</td>' +
      '<td><strong>' + (isNum(r.gtScore) ? r.gtScore.toFixed(1) : '-') + '</strong></td>' +
      '<td>' + tagN(r.n) + '</td></tr>'
    ).join('');
  }
  const tbGood = document.querySelector('#t-rulev2-good tbody');
  if (tbGood && DATA.ruleSearchV2) {
    tbGood.innerHTML = (DATA.ruleSearchV2.topByGoodTrade || []).map(r =>
      '<tr><td class="label">' + r.label + '</td>' +
      '<td>' + fmtNum(r.n) + '</td>' +
      '<td><strong>' + fmtRate(r.goodTradeRate) + '</strong></td>' +
      '<td>' + fmtRate(r.greatTradeRate) + '</td>' +
      '<td>' + fmtRate(r.trapRate) + '</td>' +
      '<td>' + fmtRate(r.openFail5Rate) + '</td>' +
      '<td>' + fmtPct(r.avgNextCloseFromOpen) + '</td>' +
      '<td>' + tagN(r.n) + '</td></tr>'
    ).join('');
  }
  const tbTrap = document.querySelector('#t-rulev2-lowtrap tbody');
  if (tbTrap && DATA.ruleSearchV2) {
    tbTrap.innerHTML = (DATA.ruleSearchV2.topByLowestTrap || []).map(r =>
      '<tr><td class="label">' + r.label + '</td>' +
      '<td>' + fmtNum(r.n) + '</td>' +
      '<td>' + fmtRate(r.closeHit10Rate) + '</td>' +
      '<td>' + fmtRate(r.goodTradeRate) + '</td>' +
      '<td><strong>' + fmtRate(r.trapRate) + '</strong></td>' +
      '<td>' + fmtRate(r.openFail5Rate) + '</td>' +
      '<td>' + fmtPct(r.avgNextCloseFromOpen) + '</td>' +
      '<td>' + tagN(r.n) + '</td></tr>'
    ).join('');
  }
})();

// ── v4-extra GT_BASE 정제 ──
(function() {
  const tb = document.querySelector('#t-gtcombo tbody');
  if (!tb) return;
  const RELIAB_TAG = {
    STRONG:       '<span class="tag v-hold">강한 신뢰 (n≥100)</span>',
    RELIABLE:     '<span class="tag v-hold">신뢰 (n≥50)</span>',
    REFERENCE:    '<span class="tag tag-ref">참고 (n≥30)</span>',
    INSUFFICIENT: '<span class="tag v-major">표본 부족 (n&lt;30)</span>',
  };
  tb.innerHTML = (DATA.gtCombos || []).map(c => {
    const trapCls = isNum(c.trapRate) && c.trapRate <= 10 ? 'pos' : (c.trapRate >= 20 ? 'neg' : '');
    const goodCls = isNum(c.goodTradeRate) && c.goodTradeRate >= 30 ? 'pos' : '';
    const failCls = isNum(c.openFail5Rate) && c.openFail5Rate <= 30 ? 'pos' : (c.openFail5Rate >= 40 ? 'neg' : '');
    const goalTag = c.meetsGoals
      ? '<span class="tag v-hold">✅ 목표 달성</span>'
      : '<span class="tag tag-ref">미달</span>';
    return '<tr>' +
      '<td class="left"><strong>' + c.key + '</strong></td>' +
      '<td class="left" style="font-size:11px;">' + c.label + '</td>' +
      '<td>' + fmtNum(c.count) + '</td>' +
      '<td>' + (RELIAB_TAG[c.reliability] || '-') + '</td>' +
      '<td>' + fmtRate(c.hit10Rate) + '</td>' +
      '<td>' + fmtRate(c.openHit5Rate) + '</td>' +
      '<td class="' + goodCls + '"><strong>' + fmtRate(c.goodTradeRate) + '</strong></td>' +
      '<td>' + fmtRate(c.greatTradeRate) + '</td>' +
      '<td class="' + trapCls + '"><strong>' + fmtRate(c.trapRate) + '</strong></td>' +
      '<td class="' + failCls + '">' + fmtRate(c.openFail5Rate) + '</td>' +
      '<td>' + fmtPct(c.avgNextHighFromOpen) + '</td>' +
      '<td>' + fmtPct(c.avgNextLowFromOpen) + '</td>' +
      '<td>' + fmtPct(c.avgNextCloseFromOpen) + '</td>' +
      '<td><strong>' + (isNum(c.gtScore) ? c.gtScore.toFixed(1) : '-') + '</strong></td>' +
      '<td class="left">' + goalTag + '</td>' +
    '</tr>';
  }).join('');
})();

// ── 보드 그룹 초안 ──
(function() {
  const proposals = (DATA.autoConclusion && DATA.autoConclusion.v4 && DATA.autoConclusion.v4.boardGroupProposals) || {};
  const order = ['S-GT','A-GT','MOM-RISK','HIGH-RISK','QVA_TAG'];
  const html = [];
  for (const key of order) {
    const p = proposals[key];
    if (!p) continue;
    const cls = (key === 'S-GT' || key === 'A-GT') ? 'success'
              : (key === 'MOM-RISK') ? 'warn'
              : (key === 'HIGH-RISK') ? 'danger' : 'qva';
    const stat = p.candidateStats;
    html.push('<div class="callout ' + cls + '"><strong>' + key + ' — ' + p.title + '</strong>' +
      '<br><strong>전일 예비 조건:</strong> ' + p.prevConditions +
      '<br><strong>다음날 장초 확인 조건:</strong> ' + p.intradayConditions +
      (p.recommendedCombo ? '<br><strong>추천 combo:</strong> ' + p.recommendedCombo + (stat ? ' (n=' + stat.n + ', GOOD ' + (stat.goodTradeRate||0).toFixed(1) + '%, TRAP ' + (stat.trapRate||0).toFixed(1) + '%, openFail-5% ' + (stat.openFail5Rate||0).toFixed(1) + '%, gtScore ' + (isNum(stat.gtScore) ? stat.gtScore.toFixed(1) : '-') + ')' : '') : '') +
      (p.notes ? '<br><strong>메모:</strong> ' + p.notes : '') +
    '</div>');
  }
  document.getElementById('board-group-proposals').innerHTML = html.join('');
})();

// ── v5 GOOD vs TRAP 비교 ──
(function() {
  const tb = document.querySelector('#t-good-vs-trap tbody');
  if (!tb) return;
  function fmtVal(v, unit) {
    if (!isNum(v)) return '-';
    if (unit === 'pct') return v.toFixed(2) + '%';
    if (unit === 'won') return fmtMoney(v);
    if (unit === 'x')   return '×' + v.toFixed(2);
    return v.toFixed(2);
  }
  tb.innerHTML = (DATA.goodVsTrapCompare || []).map(c => {
    const cls = !isNum(c.diff) ? '' : (c.diff > 0 ? 'diff-pos' : 'diff-neg');
    return '<tr><td class="left">' + c.label + '</td>' +
      '<td>' + fmtVal(c.gMean, c.unit) + '</td>' +
      '<td>' + fmtVal(c.gMed, c.unit) + '</td>' +
      '<td>' + fmtVal(c.tMean, c.unit) + '</td>' +
      '<td>' + fmtVal(c.tMed, c.unit) + '</td>' +
      '<td class="' + cls + '">' + fmtVal(c.diff, c.unit) + '</td>' +
      '<td class="' + cls + '">' + (isNum(c.relDiff) ? (c.relDiff > 0 ? '+' : '') + (c.relDiff*100).toFixed(1) + '%' : '-') + '</td>' +
      '<td class="left">' + (c.interp || '-') + '</td>' +
    '</tr>';
  }).join('');
})();

// ── v5 위험 룰 / 안전형 룰 ──
function tagN(n) { return n >= 50 ? '<span class="tag v-hold">신뢰</span>' : (n >= 30 ? '<span class="tag tag-ref">참고</span>' : ''); }
(function() {
  const trapTb = document.querySelector('#t-trap-high tbody');
  if (trapTb && DATA.ruleSearchV2) {
    trapTb.innerHTML = (DATA.ruleSearchV2.topByTrapHigh || []).map(r =>
      '<tr><td class="label">' + r.label + '</td><td>' + fmtNum(r.n) + '</td>' +
      '<td><strong class="neg">' + fmtRate(r.trapRate) + '</strong></td>' +
      '<td>' + fmtRate(r.noEntryZoneRate) + '</td>' +
      '<td>' + fmtRate(r.overheatTrapRate) + '</td>' +
      '<td>' + fmtRate(r.goodTradeRate) + '</td>' +
      '<td>' + fmtRate(r.openFail5Rate) + '</td>' +
      '<td>' + fmtRate(r.gapRiskRate) + '</td>' +
      '<td>' + fmtPct(r.avgNextCloseFromOpen) + '</td>' +
      '<td>' + tagN(r.n) + '</td></tr>'
    ).join('');
  }
  const noTb = document.querySelector('#t-noentry-high tbody');
  if (noTb && DATA.ruleSearchV2) {
    noTb.innerHTML = (DATA.ruleSearchV2.topByNoEntryHigh || []).map(r =>
      '<tr><td class="label">' + r.label + '</td><td>' + fmtNum(r.n) + '</td>' +
      '<td><strong class="neg">' + fmtRate(r.noEntryZoneRate) + '</strong></td>' +
      '<td>' + fmtRate(r.trapRate) + '</td>' +
      '<td>' + fmtRate(r.gapRiskRate) + '</td>' +
      '<td>' + fmtRate(r.bigGapRiskRate) + '</td>' +
      '<td>' + fmtRate(r.goodTradeRate) + '</td>' +
      '<td>' + fmtPct(r.avgNextCloseFromOpen) + '</td>' +
      '<td>' + tagN(r.n) + '</td></tr>'
    ).join('');
  }
  const ovTb = document.querySelector('#t-overheat-high tbody');
  if (ovTb && DATA.ruleSearchV2) {
    ovTb.innerHTML = (DATA.ruleSearchV2.topByOverheatHigh || []).map(r =>
      '<tr><td class="label">' + r.label + '</td><td>' + fmtNum(r.n) + '</td>' +
      '<td><strong class="neg">' + fmtRate(r.overheatTrapRate) + '</strong></td>' +
      '<td>' + fmtRate(r.gapRiskRate) + '</td>' +
      '<td>' + fmtRate(r.trapRate) + '</td>' +
      '<td>' + fmtRate(r.goodTradeRate) + '</td>' +
      '<td>' + fmtRate(r.openFail5Rate) + '</td>' +
      '<td>' + tagN(r.n) + '</td></tr>'
    ).join('');
  }
  const safeTb = document.querySelector('#t-safegt tbody');
  if (safeTb && DATA.ruleSearchV2) {
    safeTb.innerHTML = (DATA.ruleSearchV2.topBySafeGtScore || []).map(r =>
      '<tr class="high-q"><td class="label">' + r.label + '</td><td>' + fmtNum(r.n) + '</td>' +
      '<td><strong class="pos">' + fmtRate(r.goodTradeRate) + '</strong></td>' +
      '<td>' + fmtRate(r.greatTradeRate) + '</td>' +
      '<td>' + fmtRate(r.trapRate) + '</td>' +
      '<td>' + fmtRate(r.openFail5Rate) + '</td>' +
      '<td>' + fmtRate(r.noEntryZoneRate) + '</td>' +
      '<td><strong>' + (isNum(r.safeGtScore) ? r.safeGtScore.toFixed(1) : '-') + '</strong></td>' +
      '<td>' + tagN(r.n) + '</td></tr>'
    ).join('');
  }
  const meetTb = document.querySelector('#t-meet-safe tbody');
  if (meetTb && DATA.ruleSearchV2) {
    meetTb.innerHTML = (DATA.ruleSearchV2.topMeetsSafeGoals || []).map(r =>
      '<tr class="high-q"><td class="label">' + r.label + '</td><td>' + fmtNum(r.n) + '</td>' +
      '<td><strong class="pos">' + fmtRate(r.goodTradeRate) + '</strong></td>' +
      '<td>' + fmtRate(r.trapRate) + '</td>' +
      '<td>' + fmtRate(r.openFail5Rate) + '</td>' +
      '<td>' + fmtRate(r.noEntryZoneRate) + '</td>' +
      '<td><strong>' + (isNum(r.safeGtScore) ? r.safeGtScore.toFixed(1) : '-') + '</strong></td></tr>'
    ).join('');
  }
})();

// ── v5 갭 예측 cross-tabs ──
function renderGapTab(elemId, rows) {
  const el = document.getElementById(elemId);
  if (!el) return;
  const head = el.querySelector('thead');
  if (head && !head.innerHTML.trim()) {
    head.innerHTML = '<tr><th class="left">구간</th><th>n</th><th>GAP_RISK</th><th>BIG_GAP</th><th>GOOD</th><th>TRAP</th><th>openFail-5%</th><th>시초→종가</th></tr>';
  }
  el.querySelector('tbody').innerHTML = (rows || []).map(r => {
    const gapCls = isNum(r.gapRiskRate) && r.gapRiskRate >= 30 ? 'neg' : '';
    return '<tr><td class="left">' + r.label + '</td>' +
      '<td>' + fmtNum(r.count) + '</td>' +
      '<td class="' + gapCls + '"><strong>' + fmtRate(r.gapRiskRate) + '</strong></td>' +
      '<td>' + fmtRate(r.bigGapRiskRate) + '</td>' +
      '<td>' + fmtRate(r.goodTradeRate) + '</td>' +
      '<td>' + fmtRate(r.trapRate) + '</td>' +
      '<td>' + fmtRate(r.openFail5Rate) + '</td>' +
      '<td>' + fmtPct(r.avgNextCloseFromOpen) + '</td></tr>';
  }).join('');
}
const gpt = DATA.gapPredictTabs || {};
renderGapTab('t-gap-by-chg',   gpt.dayChangeRate);
renderGapTab('t-gap-by-candle',gpt.candleType);
renderGapTab('t-gap-by-vmc',   gpt.valueToMcRatio);
renderGapTab('t-gap-by-r5',    gpt.recent5Up15Count);
renderGapTab('t-gap-by-mc',    gpt.marketCap);
renderGapTab('t-gap-by-rank',  gpt.valueRank);
renderGapTab('t-gap-by-bgap',  gpt.baseGapRate);
renderGapTab('t-gap-by-bopc',  gpt.baseOpenToCloseRate);
renderGapTab('t-gap-by-cp',    gpt.closePosition);
renderGapTab('t-gap-by-tail',  gpt.upperTailRatio);

// ── v5 2D matrix (gap × openToClose) ──
function renderV5Matrix(containerId, mtx, scoreFn, baseRateRef) {
  const el = document.getElementById(containerId);
  if (!el || !mtx) return;
  function cellCls(score, count) {
    if (count < 20) return 'cell cell-low-n cell-na';
    if (!isNum(score)) return 'cell cell-na';
    if (score >= 25) return 'cell cell-up30';
    if (score >= 20) return 'cell cell-up20';
    if (score >= 15) return 'cell cell-up10';
    if (score >= 10) return 'cell cell-up5';
    if (score >= 0)  return 'cell cell-base';
    return 'cell cell-down';
  }
  const rows = [];
  rows.push('<tr><th class="row-h"></th>' + mtx.xBands.map(x => '<th class="col-h">' + x + '</th>').join('') + '</tr>');
  for (let yi = 0; yi < mtx.yBands.length; yi++) {
    const cells = ['<th class="row-h">' + mtx.yBands[yi] + '</th>'];
    for (let xi = 0; xi < mtx.xBands.length; xi++) {
      const c = mtx.cells.find(cell => cell.x === xi && cell.y === yi);
      if (!c || c.count === 0) {
        cells.push('<td class="cell cell-na"><span class="rate">-</span><span class="meta">n=0</span></td>');
      } else {
        const sc = scoreFn(c);
        cells.push('<td class="' + cellCls(sc, c.count) + '">' +
          '<span class="rate">' + fmtRate(c.goodTradeRate) + '</span>' +
          '<span class="meta">TRAP ' + fmtRate(c.trapRate, 0) + ' · n=' + c.count + (c.count<20?' 표본부족':'') + '</span>' +
        '</td>');
      }
    }
    rows.push('<tr>' + cells.join('') + '</tr>');
  }
  el.innerHTML = '<div class="muted" style="font-size:11px;margin-bottom:6px;">' + (mtx.title || '') + ' (X=' + (mtx.xLabel||'') + ' / Y=' + (mtx.yLabel||'') + ')</div><table class="matrix">' + rows.join('') + '</table>';
}
renderV5Matrix('m-gap-vs-opc', DATA.matrixGapVsOpenClose, c => (c.goodTradeRate || 0) - (c.trapRate || 0) * 1.5);
renderV5Matrix('m-r5-vs-vmc',  DATA.matrixR5VsVmc,        c => (c.goodTradeRate || 0) - (c.trapRate || 0) * 1.5 - (c.noEntryZoneRate || 0) * 0.3);

// ── v5 시총별 sub-search ──
(function() {
  const el = document.getElementById('per-mc-search');
  if (!el || !DATA.perMcRuleSearch) return;
  const html = [];
  for (const k of ['MICRO','LIGHT','BALANCED','MID']) {
    const g = DATA.perMcRuleSearch[k];
    if (!g) continue;
    html.push('<div class="callout"><strong>' + g.groupLabel + '</strong> — n=' + fmtNum(g.n) + ', base GOOD ' + (g.baseGood||0).toFixed(1) + '% / base TRAP ' + (g.baseTrap||0).toFixed(1) + '%, 룰 평가 ' + g.rulesEvaluated + '</div>');
    function renderSubRules(title, rows) {
      if (!rows || !rows.length) return;
      html.push('<div style="margin-left:8px;"><strong style="font-size:12px;color:#94a3b8;">' + title + '</strong>');
      html.push('<table class="rules"><thead><tr><th class="left">조건</th><th>n</th><th>GOOD</th><th>TRAP</th><th>openFail-5%</th><th>safeGt</th></tr></thead><tbody>');
      for (const r of rows) {
        html.push('<tr><td class="label">' + r.label + '</td><td>' + fmtNum(r.n) + '</td>' +
          '<td><strong>' + fmtRate(r.goodTradeRate) + '</strong></td>' +
          '<td>' + fmtRate(r.trapRate) + '</td>' +
          '<td>' + fmtRate(r.openFail5Rate) + '</td>' +
          '<td>' + (isNum(r.safeGtScore) ? r.safeGtScore.toFixed(1) : '-') + '</td></tr>');
      }
      html.push('</tbody></table></div>');
    }
    renderSubRules('GOOD_TRADE 상위 10', g.topGood);
    renderSubRules('TRAP 낮은 룰 상위 10 (CLOSE_HIT10 ≥ base+5pp)', g.topLowTrap);
    renderSubRules('safeGtScore 상위 10', g.topSafeGt);
  }
  el.innerHTML = html.join('');
})();

// ── v4-extra2 경량 GOOD_TRADE 후보 ──
(function() {
  const tb = document.querySelector('#t-lightcombo tbody');
  if (!tb) return;
  const RELIAB_TAG = {
    STRONG:       '<span class="tag v-hold">강한 신뢰 (n≥100)</span>',
    RELIABLE:     '<span class="tag v-hold">신뢰 (n≥50)</span>',
    REFERENCE:    '<span class="tag tag-ref">참고 (n≥30)</span>',
    INSUFFICIENT: '<span class="tag v-major">표본 부족 (n&lt;30)</span>',
  };
  tb.innerHTML = (DATA.lightGtCombos || []).map(c => {
    const trapCls = isNum(c.trapRate) && c.trapRate <= 10 ? 'pos' : (c.trapRate >= 20 ? 'neg' : '');
    const goodCls = isNum(c.goodTradeRate) && c.goodTradeRate >= 30 ? 'pos' : '';
    const failCls = isNum(c.openFail5Rate) && c.openFail5Rate <= 30 ? 'pos' : (c.openFail5Rate >= 50 ? 'neg' : '');
    const goalTag = c.meetsGoals ? '<span class="tag v-hold">✅ 목표 달성</span>' : '<span class="tag tag-ref">미달</span>';
    return '<tr>' +
      '<td class="left"><strong>' + c.key + '</strong></td>' +
      '<td class="left" style="font-size:11px;">' + c.label + '</td>' +
      '<td>' + fmtNum(c.count) + '</td>' +
      '<td>' + (RELIAB_TAG[c.reliability] || '-') + '</td>' +
      '<td>' + fmtRate(c.hit10Rate) + '</td>' +
      '<td>' + fmtRate(c.openHit5Rate) + '</td>' +
      '<td class="' + goodCls + '"><strong>' + fmtRate(c.goodTradeRate) + '</strong></td>' +
      '<td>' + fmtRate(c.greatTradeRate) + '</td>' +
      '<td class="' + trapCls + '"><strong>' + fmtRate(c.trapRate) + '</strong></td>' +
      '<td class="' + failCls + '">' + fmtRate(c.openFail5Rate) + '</td>' +
      '<td>' + fmtPct(c.avgNextHighFromOpen) + '</td>' +
      '<td>' + fmtPct(c.avgNextLowFromOpen) + '</td>' +
      '<td>' + fmtPct(c.avgNextCloseFromOpen) + '</td>' +
      '<td><strong>' + (isNum(c.gtScore) ? c.gtScore.toFixed(1) : '-') + '</strong></td>' +
      '<td class="left">' + goalTag + '</td>' +
    '</tr>';
  }).join('');
})();

// ── 시총 × 조건 matrix ──
(function() {
  const el = document.getElementById('t-light-matrix');
  if (!el || !DATA.lightGtMatrix || !DATA.lightGtMatrix.length) return;
  function cellCls(score, n) {
    if (n < 20) return 'cell cell-low-n cell-na';
    if (!isNum(score)) return 'cell cell-na';
    if (score >= 30) return 'cell cell-up30';
    if (score >= 25) return 'cell cell-up20';
    if (score >= 20) return 'cell cell-up10';
    if (score >= 15) return 'cell cell-up5';
    if (score >= 5)  return 'cell cell-base';
    return 'cell cell-down';
  }
  // 헤더 = sub conditions
  const subs = DATA.lightGtMatrix[0].cells.map(c => ({ key: c.sub, label: c.subLabel }));
  const rows = [];
  rows.push('<tr><th class="row-h"></th>' + subs.map(s => '<th class="col-h">' + s.label + '</th>').join('') + '</tr>');
  for (const g of DATA.lightGtMatrix) {
    const cells = ['<th class="row-h">' + g.groupLabel + '</th>'];
    for (const c of g.cells) {
      if (c.count === 0) {
        cells.push('<td class="cell cell-na"><span class="rate">-</span><span class="meta">n=0</span></td>');
      } else {
        const cls = cellCls(c.gtScore, c.count);
        const lowN = c.count < 20 ? ' 표본부족' : '';
        cells.push('<td class="' + cls + '">' +
          '<span class="rate">' + fmtRate(c.goodTradeRate) + '</span>' +
          '<span class="meta">TRAP ' + fmtRate(c.trapRate, 0) + ' · n=' + c.count + lowN + ' · gt=' + (isNum(c.gtScore) ? c.gtScore.toFixed(1) : '-') + (c.meetsGoals ? ' ✅' : '') + '</span>' +
        '</td>');
      }
    }
    rows.push('<tr>' + cells.join('') + '</tr>');
  }
  el.innerHTML = rows.join('');
})();

// ── 60일 baseline 비교표 ──
(function() {
  const rows = DATA.compareRows || [];
  const baseDays = (DATA.baseline60d && DATA.baseline60d.windowDays) || 60;
  const curDays = DATA.meta.windowDays;
  document.getElementById('compare-meta').innerHTML =
    'baseline: <strong>' + baseDays + '거래일</strong> 스냅샷 (스크립트 상수에 박혀있음) vs 현재 검증: <strong>' + curDays + '거래일</strong>. ' +
    '판정: 유지(≤3pp) / 소폭(3~8pp) / 중간(8~15pp) / 큰 변화(>15pp). ' +
    '60거래일로 다시 돌리면 모두 "유지"여야 정상.';
  function fmtVal(v, fmt) {
    if (v == null || !Number.isFinite(v)) return '-';
    if (fmt === 'int') return Math.round(v).toLocaleString();
    return v.toFixed(2) + '%';
  }
  function fmtDelta(d, fmt) {
    if (d == null || !Number.isFinite(d)) return '-';
    const sign = d > 0 ? '+' : '';
    if (fmt === 'int') return '<span class="' + (d > 0 ? 'delta-pos' : 'delta-neg') + '">' + sign + Math.round(d).toLocaleString() + '</span>';
    return '<span class="' + (d > 0 ? 'delta-pos' : 'delta-neg') + '">' + sign + d.toFixed(2) + 'pp</span>';
  }
  document.querySelector('#t-compare-baseline tbody').innerHTML = rows.map(r =>
    '<tr><td class="left muted">' + r.sec + '</td>' +
    '<td class="left">' + r.metric + '</td>' +
    '<td>' + fmtVal(r.baseVal, r.fmt) + '</td>' +
    '<td><strong>' + fmtVal(r.curVal, r.fmt) + '</strong></td>' +
    '<td>' + fmtDelta(r.delta, r.fmt) + '</td>' +
    '<td class="left"><span class="tag v-' + r.cls + '">' + r.verdict + '</span></td></tr>'
  ).join('');

  // verdict 결론
  const v = DATA.baselineVerdicts || {};
  const vHtml = ['<strong>🧪 60일 vs 현재 — 결론 유지 여부 판정</strong>'];
  if (v.sangttaTrap) vHtml.push('• <strong>상따 위험:</strong> ' + v.sangttaTrap);
  if (v.gapThreshold) vHtml.push('• <strong>갭 위험 임계:</strong> ' + v.gapThreshold);
  if (v.qvaStandalone) vHtml.push('• <strong>QVA 단독 효과:</strong> ' + v.qvaStandalone);
  if (v.qvaBestGap) vHtml.push('• <strong>QVA 선행 best 간격:</strong> ' + v.qvaBestGap);
  if (v.sQvaCombo) vHtml.push('• <strong>S + QVA 조합:</strong> ' + v.sQvaCombo);
  if (v.rQvaSafety) vHtml.push('• <strong>R + QVA 위험 상쇄:</strong> ' + v.rQvaSafety);
  if ((v.onHold || []).length) {
    vHtml.push('• <strong>보류 항목:</strong>');
    for (const s of v.onHold) vHtml.push('&nbsp;&nbsp;◦ ' + s);
  }
  document.getElementById('baseline-verdicts').innerHTML = vHtml.join('<br>');
})();

// ── 자동 결론 ──
(function() {
  const c = DATA.autoConclusion || {};
  const html = [];

  // ── v4-extra 자동 결론 ──
  const v4x = (c.v4 || {});
  if ((v4x.gtBestByScore || []).length) {
    html.push('<div class="callout success"><strong>🎯 v4-extra GT_BASE 정제 — gtScore 상위 5</strong><br>' +
      v4x.gtBestByScore.map(c2 => {
        const goalTag = c2.meetsGoals ? ' ✅' : '';
        return '• <strong>' + c2.key + '</strong> n=' + c2.n + ' · GOOD ' + (c2.goodTradeRate||0).toFixed(1) + '% · TRAP ' + (c2.trapRate||0).toFixed(1) + '% · openFail-5% ' + (c2.openFail5Rate||0).toFixed(1) + '% · gtScore <strong>' + (isNum(c2.gtScore) ? c2.gtScore.toFixed(1) : '-') + '</strong>' + goalTag + '<br><span class="muted" style="font-size:10px;">' + c2.label + '</span>';
      }).join('<br>') +
    '</div>');
  }
  if ((v4x.gtMeetsGoals || []).length) {
    html.push('<div class="callout success"><strong>✅ v4-extra 목표 모두 달성 조합 (GOOD≥30, TRAP≤10, openFail-5≤30, n≥50)</strong><br>' +
      v4x.gtMeetsGoals.map(c2 => '• ' + c2.key + ' n=' + c2.n + ' · GOOD ' + c2.goodTradeRate.toFixed(1) + '% · TRAP ' + c2.trapRate.toFixed(1) + '% · openFail-5% ' + c2.openFail5Rate.toFixed(1) + '% · gtScore ' + c2.gtScore.toFixed(1)).join('<br>') +
    '</div>');
  } else if (v4x.gtBestByScore && v4x.gtBestByScore.length) {
    html.push('<div class="callout warn"><strong>⚠ v4-extra 목표 모두 충족 조합 없음</strong><br>' +
      'GOOD≥30, TRAP≤10, openFail-5≤30, n≥50 모두 만족하는 조합이 없으므로 어느 한쪽 양보 필요. 위 gtScore 상위 조합 중 n≥50 조건을 검토.' +
    '</div>');
  }
  if ((v4x.finalNotes || []).length) {
    html.push('<div class="callout"><strong>🧭 v4-extra 최종 결론 정리 (HIT10 → GOOD_TRADE 전환)</strong><br>' +
      v4x.finalNotes.map(s => '• ' + s).join('<br>') +
    '</div>');
  }

  // ── v5 위험 제거 결론 ──
  const v5 = c.v5 || {};
  if ((v5.topGtVsTrapMetrics || []).length) {
    html.push('<div class="callout"><strong>① v5 GOOD vs TRAP 가장 잘 가르는 전일 지표 TOP 5</strong><br>' +
      v5.topGtVsTrapMetrics.map(m => '• <strong>' + m.label + '</strong> — GOOD 평균 ' + (isNum(m.gMean)?m.gMean.toFixed(2):'-') + ' / TRAP 평균 ' + (isNum(m.tMean)?m.tMean.toFixed(2):'-') + ' · ' + m.interp).join('<br>') +
    '</div>');
  }
  if ((v5.topByTrapHigh || []).length) {
    html.push('<div class="callout danger"><strong>② v5 TRAP률 가장 높은 위험 룰 TOP 5</strong><br>' +
      v5.topByTrapHigh.map(r => '• <code>' + r.label + '</code> n=' + r.n + ' · TRAP <strong>' + (r.trapRate||0).toFixed(1) + '%</strong> · openFail-5% ' + (r.openFail5Rate||0).toFixed(1) + '% · GOOD ' + (r.goodTradeRate||0).toFixed(1) + '%').join('<br>') +
    '</div>');
  }
  if ((v5.topByNoEntryHigh || []).length) {
    html.push('<div class="callout danger"><strong>③ v5 NO_ENTRY_ZONE 가장 높은 룰 TOP 5</strong><br>' +
      v5.topByNoEntryHigh.map(r => '• <code>' + r.label + '</code> n=' + r.n + ' · NO_ENTRY <strong>' + (r.noEntryZoneRate||0).toFixed(1) + '%</strong> · GAP_RISK ' + (r.gapRiskRate||0).toFixed(1) + '%').join('<br>') +
    '</div>');
  }
  if ((v5.topBySafeGtScore || []).length) {
    html.push('<div class="callout success"><strong>④ v5 안전형 GOOD 룰 (safeGtScore) 상위 5</strong><br>' +
      v5.topBySafeGtScore.map(r => '• <code>' + r.label + '</code> n=' + r.n + ' · GOOD ' + (r.goodTradeRate||0).toFixed(1) + '% / TRAP ' + (r.trapRate||0).toFixed(1) + '% / openFail-5% ' + (r.openFail5Rate||0).toFixed(1) + '% · safeGt <strong>' + (isNum(r.safeGtScore)?r.safeGtScore.toFixed(1):'-') + '</strong>').join('<br>') +
    '</div>');
  }
  if ((v5.topMeetsSafeGoals || []).length) {
    html.push('<div class="callout success"><strong>✅ v5 목표 모두 달성 룰 (GOOD≥28 + TRAP≤8 + openFail-5≤40 + n≥50)</strong><br>' +
      v5.topMeetsSafeGoals.slice(0, 5).map(r => '• <code>' + r.label + '</code> n=' + r.n + ' · GOOD ' + (r.goodTradeRate||0).toFixed(1) + '% / TRAP ' + (r.trapRate||0).toFixed(1) + '% / openFail-5% ' + (r.openFail5Rate||0).toFixed(1) + '%').join('<br>') +
    '</div>');
  }
  if ((v5.topGapPredictors || []).length) {
    html.push('<div class="callout warn"><strong>⑤ v5 다음날 과열 갭 예측하는 전일 조건 TOP 5</strong><br>' +
      v5.topGapPredictors.map(p => '• [' + p.dim + '] <strong>' + p.label + '</strong> n=' + p.count + ' · 다음날 GAP ≥7% 발생률 <strong>' + p.gapRiskRate.toFixed(1) + '%</strong> · BIG_GAP ' + (p.bigGapRiskRate||0).toFixed(1) + '%').join('<br>') +
    '</div>');
  }
  if ((v5.bestLowGapCells || []).length) {
    html.push('<div class="callout success"><strong>⑥ v5 LOW_GAP_INTRADAY 정밀 정의 — 가장 안전한 (gap × 시가→종가) 셀</strong><br>' +
      v5.bestLowGapCells.map(c2 => '• <strong>' + c2.label + '</strong> n=' + c2.count + ' · GOOD ' + c2.goodTradeRate.toFixed(1) + '% · TRAP ' + c2.trapRate.toFixed(1) + '% · GAP_RISK ' + (c2.gapRiskRate||0).toFixed(1) + '% · safeScore ' + c2.safeScore.toFixed(1)).join('<br>') +
    '</div>');
  }
  if ((v5.bestR5VmcCells || []).length) {
    html.push('<div class="callout"><strong>⑦ v5 recent5Up15 × v/mc 최적 조합</strong><br>' +
      v5.bestR5VmcCells.map(c2 => '• <strong>' + c2.label + '</strong> n=' + c2.count + ' · GOOD ' + c2.goodTradeRate.toFixed(1) + '% · TRAP ' + c2.trapRate.toFixed(1) + '% · NO_ENTRY ' + (c2.noEntryZoneRate||0).toFixed(1) + '%').join('<br>') +
    '</div>');
  }
  if (v5.perMcBest && Object.keys(v5.perMcBest).length) {
    html.push('<div class="callout success"><strong>⑧ v5 시총 구간별 추천 룰 (safeGt/GOOD 1위)</strong><br>' +
      Object.entries(v5.perMcBest).map(([k, p]) => '• <strong>' + p.groupLabel + '</strong> — <code>' + p.label + '</code> n=' + p.n + ' · GOOD ' + (p.goodTradeRate||0).toFixed(1) + '% / TRAP ' + (p.trapRate||0).toFixed(1) + '% / safeGt ' + (isNum(p.safeGtScore) ? p.safeGtScore.toFixed(1) : '-')).join('<br>') +
    '</div>');
  }
  if ((v5.boardRiskTags || []).length) {
    html.push('<div class="callout warn"><strong>⑨ v5 보드 즉시 반영 가능한 위험 태그</strong><br>' +
      v5.boardRiskTags.map(s => '• ' + s).join('<br>') +
    '</div>');
  }
  if ((v5.onHold || []).length) {
    html.push('<div class="callout warn"><strong>⑩ v5 결론 보류</strong><br>' +
      v5.onHold.map(s => '• ' + s).join('<br>') +
    '</div>');
  }
  html.push('<div class="callout"><strong>🧭 v5 해석 원칙</strong><br>' +
    '• 분봉 데이터 없음 — 진입 확정 신호 만들지 않고 위험 후보 제거 필터로만 사용<br>' +
    '• GOOD_TRADE만 보지 말고 TRAP, openFail-5, NO_ENTRY_ZONE 함께 평가<br>' +
    '• openFail-5 ≤ 40%를 현실적 기준으로 사용 (≤30%는 너무 빡빡)<br>' +
    '• 최종 보드는 매수 신호가 아니라 다음날 장초 확인 후보 보드 — gapRate < 7% 일 때만 진입 검토' +
  '</div>');

  // ── v4-extra2 경량 GT 결론 ──
  if (v4x.lightGt) {
    const qa = v4x.lightGt.qa || {};
    if ((v4x.lightGt.bestByScore || []).length) {
      html.push('<div class="callout"><strong>🪶 v4-extra2 경량 GOOD_TRADE — gtScore 상위 5</strong><br>' +
        v4x.lightGt.bestByScore.map(c2 => {
          const goal = c2.meetsGoals ? ' ✅' : '';
          return '• <strong>' + c2.key + '</strong> n=' + c2.n + ' · GOOD ' + (c2.goodTradeRate||0).toFixed(1) + '% · TRAP ' + (c2.trapRate||0).toFixed(1) + '% · openFail-5% ' + (c2.openFail5Rate||0).toFixed(1) + '% · gtScore <strong>' + (isNum(c2.gtScore) ? c2.gtScore.toFixed(1) : '-') + '</strong>' + goal + '<br><span class="muted" style="font-size:10px;">' + c2.label + '</span>';
        }).join('<br>') +
      '</div>');
    }
    if ((v4x.lightGt.meetsGoals || []).length) {
      html.push('<div class="callout success"><strong>✅ v4-extra2 경량/초경량 — 목표 달성 조합</strong><br>' +
        v4x.lightGt.meetsGoals.map(c2 => '• ' + c2.key + ' n=' + c2.n + ' · GOOD ' + c2.goodTradeRate.toFixed(1) + '% · TRAP ' + c2.trapRate.toFixed(1) + '%').join('<br>') +
      '</div>');
    } else {
      html.push('<div class="callout warn"><strong>⚠ v4-extra2 경량/초경량 — 목표 달성 조합 없음</strong><br>경량 영역에서도 GOOD≥30 + TRAP≤10 + openFail-5≤30 + n≥50 동시 충족 조건 없음.</div>');
    }
    html.push('<div class="callout"><strong>❓ v4-extra2 5가지 질문 자동 답변</strong>' +
      (qa.q1 ? '<br>1. 1,000~3,000억 경량주에서 GOOD 높은 조건? — ' + qa.q1 : '') +
      (qa.q2 ? '<br>2. 500~1,000억 초경량은 위험 너무 큰가? — ' + qa.q2 : '') +
      (qa.q3 ? '<br>3. 3,000~7,000억 균형형이 여전히 best? — ' + qa.q3 : '') +
      (qa.q4 ? '<br>4. 3,000억 이상만 쓰면 놓치는 후보? — ' + qa.q4 : '') +
      (qa.q5 ? '<br>5. 경량을 별도 그룹으로? — ' + qa.q5 : '') +
    '</div>');
    if (v4x.lightGroupNames) {
      html.push('<div class="callout success"><strong>🪧 v4-extra2 경량 보드 그룹 라벨 제안</strong><br>' +
        Object.entries(v4x.lightGroupNames).map(([k, v]) => '• <strong>' + k + '</strong>: ' + v).join('<br>') +
      '</div>');
    }
  }

  // ── v4 자동 결론 ──
  const v4 = c.v4 || {};
  if ((v4.confirmed || []).length || (v4.onHold || []).length) {
    html.push('<div class="callout success"><strong>🎯 v4 다음 보드 리팩토링 — 확정 / 보류</strong>' +
      ((v4.confirmed||[]).length ? '<br><strong>확정 후보:</strong><br>' + v4.confirmed.map(s => '• ' + s).join('<br>') : '') +
      ((v4.onHold||[]).length ? '<br><strong>보류:</strong><br>' + v4.onHold.map(s => '• ' + s).join('<br>') : '') +
    '</div>');
  }
  if ((v4.topByGtScore || []).length) {
    html.push('<div class="callout success"><strong>🤖 v4 GOOD_TRADE 룰 — gtScore 상위 5</strong> (= GOOD + GREAT×0.5 - TRAP×0.7 - openFail5×0.3)<br>' +
      v4.topByGtScore.map(r => '• <code>' + r.label + '</code> — n=' + r.n + ', GOOD ' + r.goodTradeRate.toFixed(1) + '% / GREAT ' + r.greatTradeRate.toFixed(1) + '% / TRAP ' + r.trapRate.toFixed(1) + '% / gtScore <strong>' + r.gtScore.toFixed(1) + '</strong>').join('<br>') +
    '</div>');
  }
  if ((v4.topGoodTrade || []).length) {
    html.push('<div class="callout"><strong>🛒 v4 GOOD_TRADE률 상위 5</strong><br>' +
      v4.topGoodTrade.map(r => '• <code>' + r.label + '</code> — n=' + r.n + ', GOOD ' + r.goodTradeRate.toFixed(1) + '% / GREAT ' + r.greatTradeRate.toFixed(1) + '% / TRAP ' + r.trapRate.toFixed(1) + '%').join('<br>') +
    '</div>');
  }
  if ((v4.topByLowestTrap || []).length) {
    html.push('<div class="callout success"><strong>🛡 v4 TRAP 낮으면서 CLOSE_HIT10 ≥ baseline+5pp 룰 상위 5</strong><br>' +
      v4.topByLowestTrap.map(r => '• <code>' + r.label + '</code> — n=' + r.n + ', CLOSE_HIT10 ' + r.closeHit10Rate.toFixed(1) + '%, GOOD ' + r.goodTradeRate.toFixed(1) + '%, TRAP <strong>' + r.trapRate.toFixed(1) + '%</strong>').join('<br>') +
    '</div>');
  }
  if ((v4.hit10HighButTrap || []).length) {
    html.push('<div class="callout danger"><strong>⚠ v4 HIT10 높지만 TRAP도 높은 조건</strong><br>' +
      v4.hit10HighButTrap.map(r => '• <strong>' + r.label + '</strong> — n=' + r.n + ', HIT10 ' + r.hit10Rate.toFixed(1) + '%, TRAP ' + r.trapRate.toFixed(1) + '%, openFail-5% ' + (r.openFail5Rate||0).toFixed(1) + '%').join('<br>') +
    '</div>');
  }
  if (v4.bestSVariant) {
    const v = v4.bestSVariant;
    const cls = v.reliable ? 'success' : 'warn';
    html.push('<div class="callout ' + cls + '"><strong>🅂 v4 S2/S3 best</strong><br>' +
      '• <strong>' + v.key + '</strong> (n=' + v.n + (v.reliable ? '' : ' — 표본 부족') + ') — GOOD ' + (v.goodTradeRate||0).toFixed(1) + '% / GREAT ' + (v.greatTradeRate||0).toFixed(1) + '% / TRAP ' + (v.trapRate||0).toFixed(1) + '% / HIT10 ' + (v.hit10Rate||0).toFixed(1) + '%<br>' +
      '<span class="muted">' + v.label + '</span>' +
    '</div>');
  }
  if ((v4.safeOpenHit5Rules || []).length) {
    html.push('<div class="callout success"><strong>🚪 v4 상따/갭 위험 피하면서 OPEN_HIT5 높은 룰</strong><br>' +
      v4.safeOpenHit5Rules.map(r => '• <code>' + r.label + '</code> — n=' + r.n + ', OPEN_HIT5 ' + r.openHit5Rate.toFixed(1) + '%, TRAP ' + r.trapRate.toFixed(1) + '%').join('<br>') +
    '</div>');
  }
  if (v4.bestValueToMcBand) {
    html.push('<div class="callout"><strong>💰 v4 valueToMcRatio best 구간</strong><br>' +
      '• <strong>' + v4.bestValueToMcBand.label + '</strong> n=' + v4.bestValueToMcBand.n + ', GOOD ' + v4.bestValueToMcBand.goodTradeRate.toFixed(1) + '% (lift ' + (v4.bestValueToMcBand.lift > 0 ? '+' : '') + v4.bestValueToMcBand.lift.toFixed(1) + 'pp vs base)' +
    '</div>');
  }
  if (v4.bestCandle) {
    html.push('<div class="callout"><strong>🕯 v4 캔들 구조 best</strong><br>' +
      '• <strong>' + v4.bestCandle.label + '</strong> n=' + v4.bestCandle.n + ', GOOD ' + v4.bestCandle.goodTradeRate.toFixed(1) + '%, HIT10 ' + (v4.bestCandle.hit10Rate||0).toFixed(1) + '%, TRAP ' + (v4.bestCandle.trapRate||0).toFixed(1) + '%' +
    '</div>');
  }
  if (v4.highBreakHelps) {
    html.push('<div class="callout"><strong>🏔 v4 신고가 돌파 효과</strong><br>• ' + v4.highBreakHelps + '</div>');
  }
  if (v4.firstVsContinuous) {
    html.push('<div class="callout"><strong>🔁 v4 첫 급등형 vs 연속 급등형</strong><br>• ' + v4.firstVsContinuous + '</div>');
  }

  // open vs close insights (상따 함정)
  if ((c.openVsCloseInsights || []).length) {
    html.push('<div class="callout open"><strong>🚪 상따 함정 — 전일종가 기준 HIT10이 좋아도 시초가 진입자에게는 먹을 자리가 줄어드는 조건</strong><br>' +
      c.openVsCloseInsights.map(s => '• ' + s).join('<br>') +
    '</div>');
  }

  // 갭 위험
  if ((c.gapInsights || []).length) {
    html.push('<div class="callout open"><strong>🌅 갭 구간별 장초 진입 net 손익 (openHit5 − openFail5)</strong><br>' +
      c.gapInsights.map(g => '• <strong>' + g.band + '</strong> n=' + g.count + ' · HIT10 ' + (g.hit10Rate||0).toFixed(1) + '% · openHit5 ' + (g.openHit5Rate||0).toFixed(1) + '% · openFail-5% ' + (g.openFail5Rate||0).toFixed(1) + '% · net ' + (g.net > 0 ? '+' : '') + g.net.toFixed(1) + 'pp · 시초→종가 평균 ' + (isNum(g.openCloseAvg) ? (g.openCloseAvg > 0 ? '+' : '') + g.openCloseAvg.toFixed(2) + '%' : '-')).join('<br>') +
      (c.gapDangerThreshold ? '<br><strong>⚠ 갭 ' + c.gapDangerThreshold + ' 부터 net이 음수로 전환 — 장초 추격 위험 임계.</strong>' : '') +
    '</div>');
  }

  // QVA 권고
  if ((c.qvaRecommendations || []).length) {
    const verdictCls = (c.qvaVerdict === 'INDEPENDENT') ? 'qva' :
                      (c.qvaVerdict === 'QUALITY_TAG') ? 'success' :
                      (c.qvaVerdict === 'RISK_MOMENTUM') ? 'danger' :
                      (c.qvaVerdict === 'SAFETY_TAG') ? 'success' : 'warn';
    html.push('<div class="callout ' + verdictCls + '"><strong>🛰 QVA 운영 권고 (판정: ' + (c.qvaVerdict || 'MIXED') + ')</strong><br>' +
      c.qvaRecommendations.map(s => '• ' + s).join('<br>') +
    '</div>');
  }

  // 단일 지표
  if ((c.topSingleMetrics || []).length) {
    html.push('<div class="callout"><strong>① 단일 지표 HIT10 관련도 TOP 5</strong><br>' +
      c.topSingleMetrics.map(m => '• <strong>' + m.label + '</strong> — HIT10 ' + (isNum(m.hit10Mean) ? m.hit10Mean.toFixed(2) : '-') + ' / NON ' + (isNum(m.nonMean) ? m.nonMean.toFixed(2) : '-') + ' (relDiff ' + (isNum(m.relDiff) ? (m.relDiff*100).toFixed(1) + '%' : '-') + ')').join('<br>') +
    '</div>');
  }
  // 2D best
  if ((c.topCombos2D || []).length) {
    html.push('<div class="callout success"><strong>② 2차원 조합표 best TOP 5</strong><br>' +
      c.topCombos2D.map(b => '• [' + b.tab + '] <strong>' + b.label + '</strong> — n=' + b.count + ', HIT10 ' + b.hit10Rate.toFixed(1) + '% (lift +' + b.lift.toFixed(1) + 'pp), 실패 ' + (isNum(b.failCloseRate) ? b.failCloseRate.toFixed(1) + '%' : '-')).join('<br>') +
    '</div>');
  }
  // T1 best
  if (c.topT1Subtype) {
    html.push('<div class="callout success"><strong>③ TYPE_1 세부 best</strong><br>' +
      '• <strong>' + c.topT1Subtype.subtype + '</strong> (n=' + c.topT1Subtype.count + ', HIT10 ' + c.topT1Subtype.hit10Rate.toFixed(1) + '%, 평균 고가 ' + (isNum(c.topT1Subtype.avgNextHigh) ? '+' + c.topT1Subtype.avgNextHigh.toFixed(2) + '%' : '-') + ', 실패 종가 ' + c.topT1Subtype.failCloseRate.toFixed(1) + '%)' +
    '</div>');
  }
  // 룰 best
  if ((c.topRulesByRiskAdj || []).length) {
    html.push('<div class="callout success"><strong>④ riskAdj 상위 5 (실전 후보)</strong><br>' +
      c.topRulesByRiskAdj.map(r => '• <code>' + r.label + '</code> — n=' + r.n + ', HIT10 ' + r.hit10Rate.toFixed(1) + '%, 실패 ' + r.failCloseRate.toFixed(1) + '%, riskAdj <strong>' + (isNum(r.riskAdj) ? r.riskAdj.toFixed(1) : '-') + '</strong>').join('<br>') +
    '</div>');
  }
  // S/R
  if ((c.sGroupCandidates || []).length) {
    html.push('<div class="callout success"><strong>⑤ S그룹 후보 — "다음날 장초 최우선 확인 후보" 라벨링 권장</strong><br>' +
      c.sGroupCandidates.map(s => '• <code>' + s.label + '</code> — n=' + s.n + ', HIT10 ' + s.hit10Rate.toFixed(1) + '%, 실패 ' + (isNum(s.failCloseRate) ? s.failCloseRate.toFixed(1) + '%' : '-')).join('<br>') +
    '</div>');
  }
  if ((c.rGroupCandidates || []).length) {
    html.push('<div class="callout danger"><strong>⑥ R그룹 후보 — "급등 가능성과 급락 위험이 함께 큰 후보" 경고</strong><br>' +
      c.rGroupCandidates.map(r => '• <code>' + r.label + '</code> — n=' + r.n + ', HIT10 ' + r.hit10Rate.toFixed(1) + '%, 실패 종가 ' + r.failCloseRate.toFixed(1) + '%, 저가 ' + r.failLowPlungeRate.toFixed(1) + '%').join('<br>') +
    '</div>');
  }
  // 보류
  if ((c.onHold || []).length) {
    html.push('<div class="callout warn"><strong>⑦ 결론 보류</strong><br>' + c.onHold.map(s => '• ' + s).join('<br>') + '</div>');
  }
  // 그룹 이슈
  if (c.groupIssue) {
    html.push('<div class="callout warn"><strong>⊕ 기존 A/B/C/D 그룹 이슈</strong><br>' + c.groupIssue + '</div>');
  }

  // 향후 보드 문구 제안
  if ((c.boardPhrasing || []).length) {
    html.push('<div class="callout"><strong>🪧 향후 보드 문구 방향 제안 (이번 작업에서 보드는 수정 X — 다음 단계에서 사용)</strong><br>' +
      c.boardPhrasing.map(p => '• <strong>' + p.groupName + '</strong>: "' + p.text + '"').join('<br>') +
    '</div>');
  }

  // 해석 원칙
  html.push('<div class="callout"><strong>🧭 해석 원칙</strong><br>' +
    '• 이번 결과만으로 1DS 점수식을 바꾸지 않는다.<br>' +
    '• 상한가형은 "상따 추천"이 아니라 "장초 확인 후보"로 표시한다.<br>' +
    '• QVA가 좋게 나와도 바로 1DS 점수에 넣지 말고, 우선 보조 태그로 운영한다.<br>' +
    '• HIT10률만 높고 실패율도 높은 룰은 R그룹(진짜 위험)으로 분리.<br>' +
    '• 표본 n<50 룰은 결론으로 쓰지 않고 추가 윈도우(VALIDATION_DAYS=120 등)로 보강.<br>' +
    '• 갭이 큰 구간은 시초가 진입자에게 net이 음수로 갈 수 있어 추격 보류.' +
  '</div>');

  document.getElementById('auto-conclusion').innerHTML = html.join('');
})();
</script>
</body>
</html>
`;

main();
