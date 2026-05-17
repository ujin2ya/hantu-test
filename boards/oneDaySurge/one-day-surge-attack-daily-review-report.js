#!/usr/bin/env node
/**
 * 1DS 공격형 TOP 날짜별 복기 보고서 (one-day-surge-attack-daily-review-report.js)
 *
 * 목적:
 *   기존 1DS BIG RUNNER 감사에서 BIG_MONEY_REBREAK (거래대금 상위 10% + 장초 고가 재돌파)
 *   조건이 60일/20일/100일 단위로 strong 등급이라는 게 확인됐다.
 *   이번 보고서는 그 조건의 "날짜별" 실전 복기다. 각 거래일에 공격형 TOP 후보가 몇 개였고,
 *   그중 실제 BIG10/BIG15/BIG20에 도달한 후보가 몇 개였는지 날짜별로 본다.
 *
 *   매수 추천 아님. 조건 개선과 운영 판단을 위한 기록.
 *
 * 절대 수정하지 않음:
 *   - 기존 1DS / QVA / QVA2 / VVI / H그룹 보드 + 라우터
 *   - 기존 검증/감사 보고서
 *   - 운영 보드 만들지 않음
 *
 * 생성 파일:
 *   - boards/oneDaySurge/one-day-surge-attack-daily-review-report.js (이 파일)
 *   - reports/one-day-surge-attack-daily-review-result.json
 *   - reports/one-day-surge-attack-daily-review-result.html
 *
 * 실행:
 *   node boards/oneDaySurge/one-day-surge-attack-daily-review-report.js              # 기본 최근 60일
 *   node boards/oneDaySurge/one-day-surge-attack-daily-review-report.js --days 20
 *   node boards/oneDaySurge/one-day-surge-attack-daily-review-report.js --days 100
 *   node boards/oneDaySurge/one-day-surge-attack-daily-review-report.js --from 2026-04-01 --to 2026-05-15
 *   node boards/oneDaySurge/one-day-surge-attack-daily-review-report.js --date 2026-05-15
 *
 * 분석 기준 (감사 보고서와 일관):
 *   - BIG_MONEY_REBREAK = 거래대금 상위 10% + 09:40~10:00에 09:00~09:30 고가 재돌파
 *   - 모집단: 같은 날짜의 1DS 후보 (분봉 가용)
 *   - decisionPrice: 09:30 close (기본). 09:45/10:00은 메인 복기에선 사용하지 않음
 *     (이전 백테스트에서 09:30 기준이 가장 강했음 — 09:45/10:00은 수익 runway 짧아짐).
 *   - dayHigh/dayClose/dayLow: 일봉 chart의 OHLC (전체 일봉 max/close/min)
 *
 * lookahead 주의:
 *   - 묘사형 감사. 조건 자체는 09:00~10:00 전체 데이터로 판정.
 *   - decisionPrice는 09:30까지의 분봉만 사용 (lookahead 없음).
 *   - 결과는 decisionPrice 기준 dayHigh/dayClose (post-decision return — 사후 데이터 사용 OK).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const CHART_DIR     = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST    = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const STOCKS_PATH   = path.join(ROOT, 'stocks.json');
const REPORTS_DIR   = path.join(ROOT, 'reports');
const OUT_JSON      = path.join(REPORTS_DIR, 'one-day-surge-attack-daily-review-result.json');
const OUT_HTML      = path.join(REPORTS_DIR, 'one-day-surge-attack-daily-review-result.html');

const DECISION_TIME = '09:30'; // 메인 복기 기준
const DEFAULT_DAYS  = 60;
const SAMPLE_LIMIT  = 30;
const DAILY_DETAIL_LIMIT = 30;     // 상세 collapsible로 펼쳐 보여줄 날짜 수
const WEEKDAY_KR = ['일', '월', '화', '수', '목', '금', '토'];

// ─────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { date: null, from: null, to: null, days: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--date')      a.date = argv[++i];
    else if (k === '--from') a.from = argv[++i];
    else if (k === '--to')   a.to   = argv[++i];
    else if (k === '--days') a.days = parseInt(argv[++i], 10);
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node one-day-surge-attack-daily-review-report.js [--date Y-M-D | --from Y-M-D --to Y-M-D | --days N]');
      process.exit(0);
    }
  }
  return a;
}

// ─────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────
function safeNum(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function safePct(num, den, digits = 2) {
  const n = safeNum(num), d = safeNum(den);
  if (n == null || d == null || d === 0) return null;
  return Number(((n / d - 1) * 100).toFixed(digits));
}
function safeDiv(num, den, digits = 3) {
  const n = safeNum(num), d = safeNum(den);
  if (n == null || d == null || d === 0) return null;
  return Number((n / d).toFixed(digits));
}
function avg(arr) {
  const xs = arr.filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
function median(arr) {
  const xs = arr.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
}
function rate(n, total, digits = 1) { return (total > 0) ? Number((n / total * 100).toFixed(digits)) : null; }
function round(x, digits = 2) { return (x == null || !Number.isFinite(x)) ? null : Number(x.toFixed(digits)); }
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function dashToNum(s) { return String(s || '').replace(/-/g, ''); }
function weekdayOf(dashDate) {
  // YYYY-MM-DD → 요일 (UTC 기준 — 거래일 이름만 필요하니 timezone 영향 미미)
  const d = new Date(dashDate + 'T00:00:00Z');
  return WEEKDAY_KR[d.getUTCDay()];
}

// ─────────────────────────────────────────────────────────────────
// 메타 + 차트
// ─────────────────────────────────────────────────────────────────
function loadMetaMap() {
  const map = new Map();
  if (fs.existsSync(STOCKS_PATH)) {
    try {
      const j = JSON.parse(fs.readFileSync(STOCKS_PATH, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (s.shortCode) map.set(s.shortCode, { name: s.name, market: s.market });
      }
    } catch (_) {}
  }
  if (fs.existsSync(NAVER_LIST)) {
    try {
      const j = JSON.parse(fs.readFileSync(NAVER_LIST, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (!s.code) continue;
        const cur = map.get(s.code) || {};
        map.set(s.code, { ...cur, name: s.name || cur.name, market: s.market || cur.market,
          marketCap: s.marketValue || 0 });
      }
    } catch (_) {}
  }
  return map;
}
const chartCache = new Map();
function loadDailyChart(code) {
  if (chartCache.has(code)) return chartCache.get(code);
  const p = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(p)) { chartCache.set(code, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const rows = Array.isArray(j.rows) ? j.rows : null;
    chartCache.set(code, rows);
    return rows;
  } catch (_) { chartCache.set(code, null); return null; }
}

// ─────────────────────────────────────────────────────────────────
// 분봉 로딩
// ─────────────────────────────────────────────────────────────────
function load1dsCandidatesByDate(dateDash) {
  const dir = path.join(INTRADAY_BASE, dateDash);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}
function loadMinuteData(dateDash, code) {
  const p = path.join(INTRADAY_BASE, dateDash, code + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────
// 분봉 → 09:30 snapshot + value flow + rebreak
// ─────────────────────────────────────────────────────────────────
function getSnapshot0930(bars) {
  if (!Array.isArray(bars)) return null;
  const upto = bars.filter((b) => b && b.time && b.time <= DECISION_TIME && Number.isFinite(b.close));
  if (upto.length < 3) return null;
  const open0900 = upto[0].open != null ? upto[0].open : upto[0].close;
  const decisionPrice = upto[upto.length - 1].close;
  const high = Math.max(...upto.map((b) => b.high).filter(Number.isFinite));
  const low  = Math.min(...upto.map((b) => b.low ).filter(Number.isFinite));
  return {
    decisionTime: DECISION_TIME, decisionPrice, open0900,
    highSoFar: high, lowSoFar: low,
  };
}
function calculateValueFlow(bars) {
  function sumIn(min, max, inclusive) {
    let value = 0, volume = 0;
    for (const b of bars) {
      if (!b || !b.time) continue;
      if (b.time < min) continue;
      if (inclusive ? b.time > max : b.time >= max) continue;
      const v = (b.value != null) ? b.value : ((b.close || 0) * (b.volume || 0));
      value  += v || 0;
      volume += b.volume || 0;
    }
    return { value, volume };
  }
  const s_0900_0930 = sumIn('09:00', '09:30', false);
  const s_0930_0945 = sumIn('09:30', '09:45', false);
  const s_0945_1000 = sumIn('09:45', '10:00', true);
  const s_0930_1000 = sumIn('09:30', '10:00', true);
  const s_0900_1000 = sumIn('09:00', '10:00', true);
  return {
    value_0900_0930: s_0900_0930.value, value_0930_0945: s_0930_0945.value, value_0945_1000: s_0945_1000.value,
    value_0930_1000: s_0930_1000.value, value_0900_1000: s_0900_1000.value,
    volume_0900_1000: s_0900_1000.volume,
    valueContinueRatio:   safeDiv(s_0930_1000.value, s_0900_0930.value, 3),
    valueSecondWaveRatio: safeDiv(s_0945_1000.value, s_0930_0945.value, 3),
  };
}
function calculateHighRebreak(bars, valueFlow) {
  function maxHigh(min, max, inclusive) {
    let mh = -Infinity;
    for (const b of bars) {
      if (!b || !b.time) continue;
      if (b.time < min) continue;
      if (inclusive ? b.time > max : b.time >= max) continue;
      if (Number.isFinite(b.high) && b.high > mh) mh = b.high;
    }
    return mh === -Infinity ? null : mh;
  }
  function firstRebreakBar(min, max, threshold) {
    for (const b of bars) {
      if (!b || !b.time) continue;
      if (b.time < min) continue;
      if (b.time > max) break;
      if (Number.isFinite(b.high) && b.high > threshold) return b;
    }
    return null;
  }
  const firstHigh_0900_0920 = maxHigh('09:00', '09:20', false);
  const morningHigh_0900_0930 = maxHigh('09:00', '09:30', false);
  const high_0940_1000 = maxHigh('09:40', '10:00', true);
  const rebreakMorningHigh = (high_0940_1000 != null && morningHigh_0900_0930 != null)
    && high_0940_1000 > morningHigh_0900_0930;
  let rebreakTime = null;
  if (rebreakMorningHigh) {
    const b = firstRebreakBar('09:40', '10:00', morningHigh_0900_0930);
    if (b) rebreakTime = b.time;
  }
  const rebreakWithValue = rebreakMorningHigh
    && valueFlow.valueSecondWaveRatio != null && valueFlow.valueSecondWaveRatio >= 1.0;
  return {
    firstHigh_0900_0920, morningHigh_0900_0930, high_0940_1000,
    rebreakMorningHigh, rebreakTime, rebreakWithValue,
  };
}

// ─────────────────────────────────────────────────────────────────
// 가격 위치
// ─────────────────────────────────────────────────────────────────
function calculatePricePosition(snap, prevClose) {
  const dp = snap.decisionPrice, open = snap.open0900;
  const gapRate = (open && prevClose) ? Number(((open / prevClose - 1) * 100).toFixed(2)) : null;
  const decisionFromOpen = (dp && open) ? Number(((dp / open - 1) * 100).toFixed(2)) : null;
  const decisionFromPrevClose = (dp && prevClose) ? Number(((dp / prevClose - 1) * 100).toFixed(2)) : null;
  const intradayRangeRate = (snap.highSoFar > 0 && snap.lowSoFar > 0)
    ? Number(((snap.highSoFar / snap.lowSoFar - 1) * 100).toFixed(2)) : null;
  const pricePositionInMorningRange = (snap.highSoFar > 0 && snap.lowSoFar > 0
    && snap.highSoFar !== snap.lowSoFar && dp)
    ? Number(((dp - snap.lowSoFar) / (snap.highSoFar - snap.lowSoFar)).toFixed(3)) : null;
  return { gapRate, decisionFromOpen, decisionFromPrevClose, intradayRangeRate, pricePositionInMorningRange };
}

// ─────────────────────────────────────────────────────────────────
// 태그 + score
// ─────────────────────────────────────────────────────────────────
function assignAttackTags(rebreak, valueFlow, isTop10Value) {
  const tags = [];
  if (isTop10Value)             tags.push('거래대금 상위 10%');
  if (rebreak.rebreakMorningHigh) tags.push('장초 고가 재돌파');
  if (rebreak.rebreakWithValue) tags.push('재돌파 + 거래대금 동반');
  if (valueFlow.valueSecondWaveRatio != null && valueFlow.valueSecondWaveRatio >= 1.2) tags.push('2차 파동');
  if (valueFlow.valueContinueRatio   != null && valueFlow.valueContinueRatio   >= 0.8) tags.push('강한 거래대금 유지');
  if (isTop10Value && rebreak.rebreakMorningHigh) tags.push('공격형 TOP');
  return tags;
}
function assignAttackRiskTags(snap, position, valueFlow, rebreak) {
  const tags = [];
  if (position.gapRate != null && position.gapRate >= 8) tags.push('갭 과열');
  if (position.decisionFromOpen != null && position.decisionFromOpen >= 8) tags.push('시가 대비 너무 멀어짐');
  if (position.intradayRangeRate != null && position.intradayRangeRate >= 8) tags.push('장초 변동성 큼');
  if (!rebreak.rebreakMorningHigh) tags.push('재돌파 실패'); // 0940~1000 기준
  if (valueFlow.valueContinueRatio != null && valueFlow.valueContinueRatio < 0.3) tags.push('거래대금 급감');
  // 고가 대비 밀림 — decisionPrice vs highSoFar
  if (snap.decisionPrice && snap.highSoFar
      && (snap.decisionPrice / snap.highSoFar - 1) * 100 <= -3) tags.push('고가 대비 밀림');
  return tags;
}
function calculateAttackScore(rebreak, valueFlow, isTop10Value, riskTags) {
  let s = 0;
  if (isTop10Value)               s += 30;
  if (rebreak.rebreakMorningHigh) s += 30;
  if (rebreak.rebreakWithValue)   s += 15;
  if (valueFlow.valueContinueRatio   != null && valueFlow.valueContinueRatio   >= 0.8) s += 10;
  if (valueFlow.valueSecondWaveRatio != null && valueFlow.valueSecondWaveRatio >= 1.2) s += 10;
  if (riskTags.includes('갭 과열'))                 s -= 8;
  if (riskTags.includes('시가 대비 너무 멀어짐'))    s -= 8;
  if (riskTags.includes('장초 변동성 큼'))           s -= 6;
  if (riskTags.includes('재돌파 실패'))              s -= 20;
  return Number(s.toFixed(1));
}

// ─────────────────────────────────────────────────────────────────
// 당일 결과 (decisionPrice 기준)
// ─────────────────────────────────────────────────────────────────
function calculateDayResult(code, decisionPrice, dateYYYYMMDD, bars) {
  if (!(decisionPrice > 0) || !dateYYYYMMDD) return { available: false, reason: 'no_input' };
  const rows = loadDailyChart(code);
  if (!rows) return { available: false, reason: 'no_chart' };
  const row = rows.find((r) => r && r.date === dateYYYYMMDD);
  if (!row) return { available: false, reason: 'no_row' };
  const dayHigh = Number.isFinite(row.high) ? row.high : null;
  const dayClose = Number.isFinite(row.close) ? row.close : null;
  const dayLow = Number.isFinite(row.low) ? row.low : null;
  const dayOpen = Number.isFinite(row.open) ? row.open : null;
  if (!(dayHigh > 0 && dayClose > 0 && dayLow > 0)) return { available: false, reason: 'invalid_ohlc' };
  // 가격 sanity guard — intraday open vs daily open 1.5배 이상 차이 시 차트 오염
  if (bars && bars[0] && bars[0].open && dayOpen) {
    const r = dayOpen / bars[0].open;
    if (r > 1.5 || r < 0.67) return { available: false, reason: 'price_mismatch' };
  }
  const dayHighReturn  = Number(((dayHigh  / decisionPrice - 1) * 100).toFixed(2));
  const dayCloseReturn = Number(((dayClose / decisionPrice - 1) * 100).toFixed(2));
  const dayLowReturn   = Number(((dayLow   / decisionPrice - 1) * 100).toFixed(2));
  const highCloseDrop  = Number(((dayClose / dayHigh - 1) * 100).toFixed(2));
  return {
    available: true,
    dayOpen, dayHigh, dayClose, dayLow,
    dayHighReturn, dayCloseReturn, dayLowReturn, highCloseDrop,
    reached5:  dayHighReturn >= 5,
    reached10: dayHighReturn >= 10,
    reached15: dayHighReturn >= 15,
    reached20: dayHighReturn >= 20,
    reached25: dayHighReturn >= 25,
    closeStrong: dayCloseReturn >= 5,
    closeStrongPlus: dayCloseReturn >= 10,
    spikeFade: (dayHighReturn >= 10 && dayCloseReturn < 3) || highCloseDrop <= -7,
    failedSpike: (dayHighReturn < 3 && dayLowReturn <= -3) || (dayHighReturn < 3 && dayCloseReturn < 0),
  };
}
function assignResultTags(r) {
  if (!r || !r.available) return { tags: [], label: '결과 미확정', comment: '결과 계산 불가.' };
  const tags = [];
  if (r.reached25)        tags.push('상한가 근처');
  if (r.reached20)        tags.push('BIG20 성공');
  if (r.reached15)        tags.push('BIG15 성공');
  if (r.reached10)        tags.push('BIG10 성공');
  if (r.reached5)         tags.push('BIG5 성공');
  if (r.closeStrongPlus)  tags.push('강한 종가');
  else if (r.closeStrong) tags.push('종가 유지');
  if (r.highCloseDrop != null && r.highCloseDrop <= -7) tags.push('고가 대비 밀림');
  if (r.dayHighReturn >= 10 && r.dayCloseReturn < 3)    tags.push('장중만 강함');
  if (r.dayCloseReturn < 0)                              tags.push('종가 약함');
  if (r.failedSpike)                                     tags.push('실패');
  if (r.dayLowReturn != null && r.dayLowReturn <= -3)   tags.push('-3% 구간 발생');

  let label = '결과 평이';
  if (r.reached20)       label = 'BIG20 성공';
  else if (r.reached15)  label = 'BIG15 성공';
  else if (r.reached10)  label = 'BIG10 성공';
  else if (r.reached5)   label = 'BIG5 성공';
  else if (r.closeStrong) label = '종가 유지';
  else if (r.dayHighReturn >= 10 && r.dayCloseReturn < 3) label = '장중 상승 후 밀림';
  else if (r.failedSpike) label = '실패';
  else if (r.dayCloseReturn < 0 && r.dayHighReturn < 5) label = '약세';

  let comment;
  if (r.reached15 && r.closeStrong) comment = `당일 고가 +${r.dayHighReturn}%로 BIG15 이상 도달, 종가도 +${r.dayCloseReturn}%로 양호.`;
  else if (r.reached15) comment = `당일 고가 +${r.dayHighReturn}%로 BIG15 이상, 종가 ${r.dayCloseReturn > 0 ? '+' : ''}${r.dayCloseReturn}%${r.dayCloseReturn < 3 ? ' (많이 밀림)' : ''}.`;
  else if (r.reached10) comment = `당일 고가 +${r.dayHighReturn}%로 BIG10 도달. 종가 ${r.dayCloseReturn > 0 ? '+' : ''}${r.dayCloseReturn}%${r.highCloseDrop <= -7 ? ' (고가 대비 크게 밀림)' : ''}.`;
  else if (r.reached5)  comment = `당일 고가 +${r.dayHighReturn}%로 BIG5 도달. 종가 ${r.dayCloseReturn > 0 ? '+' : ''}${r.dayCloseReturn}%.`;
  else if (r.failedSpike) comment = `당일 고가 +${r.dayHighReturn}%로 약했고 -3% 이탈도 발생.`;
  else if (r.dayCloseReturn < 0) comment = `당일 고가 +${r.dayHighReturn}%, 종가 음전 (${r.dayCloseReturn}%).`;
  else comment = `당일 고가 +${r.dayHighReturn}%, 종가 ${r.dayCloseReturn > 0 ? '+' : ''}${r.dayCloseReturn}%.`;

  return { tags, label, comment };
}

// ─────────────────────────────────────────────────────────────────
// 한 후보 처리
// ─────────────────────────────────────────────────────────────────
function processOneCandidate(date, code, metaMap, raw) {
  const meta = metaMap.get(code) || {};
  const name = raw.name || raw.kisMeta?.hts_kor_isnm || meta.name || code;
  const market = raw.market || meta.market || '';
  const prevClose = safeNum(raw.kisMeta?.stck_prdy_clpr);
  const snap = getSnapshot0930(raw.bars);
  if (!snap) return null;
  const valueFlow = calculateValueFlow(raw.bars);
  const rebreak = calculateHighRebreak(raw.bars, valueFlow);
  const position = calculatePricePosition(snap, prevClose);
  const result = calculateDayResult(code, snap.decisionPrice, dashToNum(date), raw.bars);
  if (result && result.reason === 'price_mismatch') return { _priceMismatch: true };
  const resultTagsObj = assignResultTags(result);
  // attackTags/riskTags는 isTop10Value 정보가 있어야 부착되므로, 일단 metric만 모으고 day 단위에서 마무리
  return {
    code, name, market, prevClose,
    snap, valueFlow, rebreak, position,
    result, resultTags: resultTagsObj.tags, resultLabel: resultTagsObj.label, resultComment: resultTagsObj.comment,
  };
}

// ─────────────────────────────────────────────────────────────────
// 날짜별 분석
// ─────────────────────────────────────────────────────────────────
function buildDailyReview(date, metaMap) {
  const codes = load1dsCandidatesByDate(date);
  const raws = [];
  let missingMinute = 0;
  for (const code of codes) {
    const raw = loadMinuteData(date, code);
    if (!raw || !Array.isArray(raw.bars) || raw.bars.length === 0) { missingMinute++; continue; }
    raws.push({ code, raw });
  }
  // 1단계: per-candidate metric 계산
  const cands = [];
  let priceMismatch = 0, snapFail = 0;
  for (const { code, raw } of raws) {
    const c = processOneCandidate(date, code, metaMap, raw);
    if (!c) { snapFail++; continue; }
    if (c._priceMismatch) { priceMismatch++; continue; }
    cands.push(c);
  }
  // 2단계: 거래대금 순위 (날짜별)
  cands.sort((a, b) => (b.valueFlow.value_0900_1000 || 0) - (a.valueFlow.value_0900_1000 || 0));
  const n = cands.length;
  const top10Threshold = Math.max(1, Math.ceil(n * 0.10));
  cands.forEach((c, i) => {
    c.morningValueRank = i + 1;
    c.morningValuePercentile = Number((((i + 1) / n) * 100).toFixed(1));
    c.isTop10Value = (i + 1) <= top10Threshold;
  });
  // 3단계: 태그 + score
  for (const c of cands) {
    c.attackTags = assignAttackTags(c.rebreak, c.valueFlow, c.isTop10Value);
    c.riskTags   = assignAttackRiskTags(c.snap, c.position, c.valueFlow, c.rebreak);
    c.attackScore = calculateAttackScore(c.rebreak, c.valueFlow, c.isTop10Value, c.riskTags);
    c.bigMoneyRebreak = c.isTop10Value && c.rebreak.rebreakMorningHigh;
  }
  // 4단계: 분류 (결과 가능 후보만 집계)
  const withResult = cands.filter((c) => c.result && c.result.available);
  const attackTopAll = cands.filter((c) => c.bigMoneyRebreak);
  const attackTop    = withResult.filter((c) => c.bigMoneyRebreak);
  const rebreakWithValueGroup = withResult.filter((c) => c.bigMoneyRebreak && c.rebreak.rebreakWithValue);
  const secondWaveGroup       = withResult.filter((c) => c.bigMoneyRebreak && c.valueFlow.valueSecondWaveRatio != null && c.valueFlow.valueSecondWaveRatio >= 1.2);

  function cnt(list, fn) { return list.filter(fn).length; }
  function avgOf(list, getter) {
    const xs = list.map(getter).filter((x) => Number.isFinite(x));
    return xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length, 2) : null;
  }

  const attackTopBig10 = cnt(attackTop, (c) => c.result.reached10);
  const attackTopBig15 = cnt(attackTop, (c) => c.result.reached15);
  const attackTopBig20 = cnt(attackTop, (c) => c.result.reached20);
  const attackTopBig25 = cnt(attackTop, (c) => c.result.reached25);
  const attackTopBig5  = cnt(attackTop, (c) => c.result.reached5);
  const attackTopCloseStrong = cnt(attackTop, (c) => c.result.closeStrong);
  const attackTopFailed      = cnt(attackTop, (c) => c.result.failedSpike);
  const attackTopSpikeFade   = cnt(attackTop, (c) => c.result.spikeFade);

  const allBig5  = cnt(withResult, (c) => c.result.reached5);
  const allBig10 = cnt(withResult, (c) => c.result.reached10);
  const allBig15 = cnt(withResult, (c) => c.result.reached15);
  const allBig20 = cnt(withResult, (c) => c.result.reached20);
  const allCloseStrong = cnt(withResult, (c) => c.result.closeStrong);
  const allFailed = cnt(withResult, (c) => c.result.failedSpike);

  const noRiskAttack = attackTop.filter((c) => c.riskTags.length === 0);
  const riskAttack   = attackTop.filter((c) => c.riskTags.length > 0);

  // 대표 종목
  function pickTop(list, getter, dir) {
    const xs = list.filter((c) => Number.isFinite(getter(c)));
    if (!xs.length) return null;
    xs.sort((a, b) => dir === 'desc' ? getter(b) - getter(a) : getter(a) - getter(b));
    return xs[0];
  }
  const topHighCandidate     = pickTop(attackTop,  (c) => c.result.dayHighReturn,  'desc');
  const topCloseCandidate    = pickTop(attackTop,  (c) => c.result.dayCloseReturn, 'desc');
  const topBigMoneyCandidate = pickTop(attackTop,  (c) => c.valueFlow.value_0900_1000, 'desc');
  const worstAttackCandidate = pickTop(attackTop,  (c) => c.result.dayCloseReturn, 'asc');

  const attackTopAvgHighReturn  = avgOf(attackTop, (c) => c.result.dayHighReturn);
  const attackTopAvgCloseReturn = avgOf(attackTop, (c) => c.result.dayCloseReturn);
  const allAvgHighReturn  = avgOf(withResult, (c) => c.result.dayHighReturn);
  const allAvgCloseReturn = avgOf(withResult, (c) => c.result.dayCloseReturn);
  const bigMoneyRebreakAvgHighReturn  = attackTopAvgHighReturn;
  const bigMoneyRebreakAvgCloseReturn = attackTopAvgCloseReturn;

  const attackTopBig10Rate  = rate(attackTopBig10, attackTop.length);
  const attackTopBig15Rate  = rate(attackTopBig15, attackTop.length);
  const attackTopBig20Rate  = rate(attackTopBig20, attackTop.length);
  const attackTopFailedRate = rate(attackTopFailed, attackTop.length);

  // 날짜 판정
  let label, labelText, sampleNote = null;
  if (attackTop.length === 0) {
    label = 'NO_SIGNAL_DAY'; labelText = '후보 없음';
  } else {
    if (attackTop.length < 3) sampleNote = '표본 적음 (n<3)';
    if ((attackTopBig10Rate != null && attackTopBig10Rate >= 40
         && attackTopBig15Rate != null && attackTopBig15Rate >= 20)
        || attackTopBig20 >= 1) {
      label = 'EXCELLENT_DAY'; labelText = '매우 좋음';
    } else if (attackTopBig10Rate != null && attackTopBig10Rate >= 25
        && attackTopAvgHighReturn != null && attackTopAvgHighReturn >= 7) {
      label = 'GOOD_DAY'; labelText = '좋음';
    } else if (attackTopBig10 === 0
        && (attackTopAvgHighReturn == null || attackTopAvgHighReturn < 4)) {
      label = 'BAD_DAY'; labelText = '약함';
    } else if (attackTopBig10 > 0 && attackTopFailedRate != null && attackTopFailedRate >= 30) {
      label = 'MIXED_DAY'; labelText = '혼조';
    } else {
      label = attackTopBig10 > 0 ? 'MIXED_DAY' : 'BAD_DAY';
      labelText = attackTopBig10 > 0 ? '혼조' : '약함';
    }
  }

  return {
    date, weekday: weekdayOf(date), label, labelText, sampleNote,
    total1ds: cands.length, withResultCount: withResult.length,
    missingMinute, priceMismatch, snapFail,
    morningValueTop10Threshold: top10Threshold,
    // 전체
    allBig5, allBig10, allBig15, allBig20, allCloseStrong, allFailed,
    allAvgHighReturn, allAvgCloseReturn,
    allBig10Rate: rate(allBig10, withResult.length),
    allBig15Rate: rate(allBig15, withResult.length),
    allFailedRate: rate(allFailed, withResult.length),
    // 공격형 TOP
    attackTopCountAll: attackTopAll.length,
    attackTopCount: attackTop.length,
    attackTopBig5, attackTopBig10, attackTopBig15, attackTopBig20, attackTopBig25,
    attackTopCloseStrong, attackTopFailed, attackTopSpikeFade,
    attackTopAvgHighReturn, attackTopAvgCloseReturn,
    attackTopBig10Rate, attackTopBig15Rate, attackTopBig20Rate, attackTopFailedRate,
    // BIG_MONEY_REBREAK (현 정의상 attack TOP과 동일)
    bigMoneyRebreakCount: attackTop.length,
    bigMoneyRebreakBig10: attackTopBig10,
    bigMoneyRebreakBig15: attackTopBig15,
    bigMoneyRebreakBig20: attackTopBig20,
    bigMoneyRebreakAvgHighReturn, bigMoneyRebreakAvgCloseReturn,
    rebreakWithValueCount: rebreakWithValueGroup.length,
    rebreakWithValueBig10: cnt(rebreakWithValueGroup, (c) => c.result.reached10),
    secondWaveCount: secondWaveGroup.length,
    secondWaveBig10: cnt(secondWaveGroup, (c) => c.result.reached10),
    // 위험 비교
    riskAttackCount: riskAttack.length,
    riskAttackBig10: cnt(riskAttack, (c) => c.result.reached10),
    riskAttackFailed: cnt(riskAttack, (c) => c.result.failedSpike),
    noRiskAttackCount: noRiskAttack.length,
    noRiskAttackBig10: cnt(noRiskAttack, (c) => c.result.reached10),
    noRiskAttackFailed: cnt(noRiskAttack, (c) => c.result.failedSpike),
    // 대표 종목
    topHighCandidate:     topHighCandidate     ? candidateCard(topHighCandidate, date) : null,
    topCloseCandidate:    topCloseCandidate    ? candidateCard(topCloseCandidate, date) : null,
    topBigMoneyCandidate: topBigMoneyCandidate ? candidateCard(topBigMoneyCandidate, date) : null,
    worstAttackCandidate: worstAttackCandidate ? candidateCard(worstAttackCandidate, date) : null,
    // 전체 후보 카드 (attackTop만, 정렬 — dayHighReturn 내림차순)
    candidates: attackTop.slice().sort((a, b) => (b.result.dayHighReturn || 0) - (a.result.dayHighReturn || 0))
      .map((c, i) => ({ ...candidateCard(c, date), rank: i + 1 })),
  };
}

function candidateCard(c, date) {
  return {
    code: c.code, name: c.name, market: c.market,
    date,
    attackScore: c.attackScore,
    isAttackTop: !!c.bigMoneyRebreak,
    bigMoneyRebreak: !!c.bigMoneyRebreak,
    morningValueRank: c.morningValueRank,
    morningValuePercentile: c.morningValuePercentile,
    isTop10Value: c.isTop10Value,
    morningValue: c.valueFlow.value_0900_1000,
    morningHigh: c.rebreak.morningHigh_0900_0930,
    rebreakMorningHigh: c.rebreak.rebreakMorningHigh,
    rebreakTime: c.rebreak.rebreakTime,
    rebreakWithValue: c.rebreak.rebreakWithValue,
    valueContinueRatio: c.valueFlow.valueContinueRatio,
    valueSecondWaveRatio: c.valueFlow.valueSecondWaveRatio,
    decisionTime: c.snap.decisionTime,
    decisionPrice: c.snap.decisionPrice,
    open0900: c.snap.open0900,
    prevClose: c.prevClose,
    gapRate: c.position.gapRate,
    decisionFromOpen: c.position.decisionFromOpen,
    decisionFromPrevClose: c.position.decisionFromPrevClose,
    pricePositionInMorningRange: c.position.pricePositionInMorningRange,
    attackTags: c.attackTags,
    riskTags: c.riskTags,
    // result
    dayResult: c.result && c.result.available ? {
      dayHigh: c.result.dayHigh, dayClose: c.result.dayClose, dayLow: c.result.dayLow,
      dayHighReturn: c.result.dayHighReturn, dayCloseReturn: c.result.dayCloseReturn,
      dayLowReturn: c.result.dayLowReturn, highCloseDrop: c.result.highCloseDrop,
      reached5: c.result.reached5, reached10: c.result.reached10, reached15: c.result.reached15,
      reached20: c.result.reached20, reached25: c.result.reached25,
      closeStrong: c.result.closeStrong, spikeFade: c.result.spikeFade, failedSpike: c.result.failedSpike,
    } : null,
    resultTags: c.resultTags, resultLabel: c.resultLabel, resultComment: c.resultComment,
  };
}

// ─────────────────────────────────────────────────────────────────
// 비교/요일/샘플 빌더
// ─────────────────────────────────────────────────────────────────
function buildBaseVsAttackByDate(reviews) {
  return reviews.map((r) => {
    let interpretation = '';
    const aRate = r.attackTopBig10Rate;
    const bRate = r.allBig10Rate;
    if (r.attackTopCount === 0) interpretation = '후보 없음';
    else if (aRate != null && bRate != null && aRate - bRate >= 10) interpretation = '공격형 TOP이 전체 1DS보다 크게 우위';
    else if (aRate != null && bRate != null && aRate - bRate >= 3)  interpretation = '공격형 TOP이 전체보다 우위';
    else if (aRate != null && bRate != null && aRate - bRate < -3)  interpretation = '공격형 TOP이 있었지만 성과 약함';
    else if (aRate === 0 && bRate > 5) interpretation = '전체 1DS는 좋았지만 공격형 TOP은 놓침';
    else interpretation = '평이한 차이';
    return {
      date: r.date, weekday: r.weekday,
      baseBig10Rate: r.allBig10Rate, attackBig10Rate: r.attackTopBig10Rate,
      big10Diff: (r.attackTopBig10Rate != null && r.allBig10Rate != null) ? round(r.attackTopBig10Rate - r.allBig10Rate, 1) : null,
      baseAvgHigh: r.allAvgHighReturn, attackAvgHigh: r.attackTopAvgHighReturn,
      avgHighDiff: (r.attackTopAvgHighReturn != null && r.allAvgHighReturn != null) ? round(r.attackTopAvgHighReturn - r.allAvgHighReturn, 2) : null,
      baseFailedRate: r.allFailedRate, attackFailedRate: r.attackTopFailedRate,
      interpretation,
    };
  });
}
function buildRiskTagComparison(allCandidates) {
  // 전체 기간 attackTop 후보 (result 있는 것)에서 위험 태그 그룹별 통계
  const attackTopAll = allCandidates.filter((c) => c.bigMoneyRebreak && c.dayResult);
  function bucket(label, predicate) {
    const sub = attackTopAll.filter(predicate);
    function cnt(fn) { return sub.filter(fn).length; }
    function avgOf(getter) {
      const xs = sub.map((c) => getter(c)).filter((x) => Number.isFinite(x));
      return xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length, 2) : null;
    }
    return {
      label, n: sub.length,
      big10: cnt((c) => c.dayResult.reached10), big15: cnt((c) => c.dayResult.reached15), big20: cnt((c) => c.dayResult.reached20),
      avgHigh: avgOf((c) => c.dayResult.dayHighReturn),
      avgClose: avgOf((c) => c.dayResult.dayCloseReturn),
      failedRate: rate(cnt((c) => c.dayResult.failedSpike), sub.length),
      big10Rate: rate(cnt((c) => c.dayResult.reached10), sub.length),
    };
  }
  const has = (c, t) => (c.riskTags || []).includes(t);
  return [
    bucket('공격형 TOP + 위험 태그 있음',     (c) => (c.riskTags || []).length > 0),
    bucket('공격형 TOP + 위험 태그 없음',     (c) => (c.riskTags || []).length === 0),
    bucket('갭 과열',                       (c) => has(c, '갭 과열')),
    bucket('시가 대비 너무 멀어짐',          (c) => has(c, '시가 대비 너무 멀어짐')),
    bucket('장초 변동성 큼',                (c) => has(c, '장초 변동성 큼')),
    bucket('고가 대비 밀림',                (c) => has(c, '고가 대비 밀림')),
    bucket('거래대금 급감',                 (c) => has(c, '거래대금 급감')),
  ];
}
function buildWeekdayStats(reviews) {
  const order = ['월', '화', '수', '목', '금'];
  return order.map((wd) => {
    const days = reviews.filter((r) => r.weekday === wd);
    const sumAttackTop = days.reduce((s, r) => s + r.attackTopCount, 0);
    const sumBig10     = days.reduce((s, r) => s + r.attackTopBig10, 0);
    const sumBig15     = days.reduce((s, r) => s + r.attackTopBig15, 0);
    const sumBig20     = days.reduce((s, r) => s + r.attackTopBig20, 0);
    const sumFailed    = days.reduce((s, r) => s + r.attackTopFailed, 0);
    const highs = days.map((r) => r.attackTopAvgHighReturn).filter((x) => Number.isFinite(x));
    return {
      weekday: wd, dayCount: days.length, attackTopCount: sumAttackTop,
      big10: sumBig10, big15: sumBig15, big20: sumBig20, failed: sumFailed,
      big10Rate: rate(sumBig10, sumAttackTop),
      avgHigh: highs.length ? round(highs.reduce((s, x) => s + x, 0) / highs.length, 2) : null,
      failedRate: rate(sumFailed, sumAttackTop),
    };
  });
}
function pickSuccessDays(reviews, limit) {
  return reviews
    .filter((r) => r.label === 'EXCELLENT_DAY' || r.label === 'GOOD_DAY')
    .slice().sort((a, b) => {
      const sb = (b.attackTopBig20 * 100) + (b.attackTopBig15 * 10) + (b.attackTopBig10);
      const sa = (a.attackTopBig20 * 100) + (a.attackTopBig15 * 10) + (a.attackTopBig10);
      return sb - sa;
    })
    .slice(0, limit);
}
function pickFailureDays(reviews, limit) {
  return reviews
    .filter((r) => r.label === 'BAD_DAY' && r.attackTopCount >= 3)
    .slice().sort((a, b) => a.attackTopAvgHighReturn - b.attackTopAvgHighReturn || a.attackTopCount - b.attackTopCount)
    .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────
// 결론 자동
// ─────────────────────────────────────────────────────────────────
function buildConclusion(summary, riskComp) {
  const lines = [];
  const aBig10Rate = summary.attackTopBig10Rate || 0;
  const goodPlus = summary.excellentDays + summary.goodDays;
  const totalActiveDays = summary.totalDays - summary.noSignalDays;
  if (aBig10Rate >= 30 && goodPlus >= Math.ceil(totalActiveDays / 2)) {
    lines.push('✓ 공격형 TOP 조건은 날짜별로도 실전 추적 가치가 높습니다.');
  } else if (aBig10Rate >= 20) {
    lines.push('= 공격형 TOP 조건은 강한 날과 약한 날의 편차가 있으므로, 시장 상황 또는 위험 태그 보정이 필요합니다.');
  } else {
    lines.push('⚠ 공격형 TOP 조건 단독 운영은 위험하며 추가 필터가 필요합니다.');
  }
  if (summary.badDays > summary.goodDays + summary.excellentDays) {
    lines.push('⚠ BAD_DAY가 GOOD+EXCELLENT 합보다 많음 — 단독 추격 주의.');
  }
  // 위험 태그 비교
  const withRisk = riskComp.find((g) => g.label === '공격형 TOP + 위험 태그 있음');
  const noRisk   = riskComp.find((g) => g.label === '공격형 TOP + 위험 태그 없음');
  if (withRisk && noRisk && withRisk.n >= 10 && noRisk.n >= 10) {
    if (noRisk.big10Rate != null && withRisk.big10Rate != null) {
      if (noRisk.big10Rate >= withRisk.big10Rate + 3) {
        lines.push(`✓ 위험 태그 없는 공격형 TOP(BIG10 ${noRisk.big10Rate}%)이 있는 그룹(${withRisk.big10Rate}%)보다 유리 — noRisk 우선 봐야 함.`);
      } else if (withRisk.big10Rate > noRisk.big10Rate + 3) {
        lines.push(`! 위험 태그 있는 그룹이 오히려 더 잘 감 — 공격형 조건에서 위험 태그가 단순 제외가 아닐 수 있음 (태그별 세분화 필요).`);
      } else {
        lines.push(`= 위험 태그 유무 차이가 크지 않음 (noRisk ${noRisk.big10Rate}% vs risk ${withRisk.big10Rate}%).`);
      }
    }
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────
// HTML 렌더링
// ─────────────────────────────────────────────────────────────────
function renderHtml(result) {
  const { meta, summary, dailyReviews, baseVsAttackByDate, riskTagComparison,
          weekdayStats, successDays, failureDays, samples, conclusionLines } = result;

  function pct(v) { return v == null ? '—' : (v.toFixed ? v.toFixed(1) : v) + '%'; }
  function num(v, p) { return v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(p != null ? p : 2); }
  function f0(v) { return v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString(); }
  function fmoneyLocal(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + '조';
    if (v >= 1e8)  return (v / 1e8 ).toFixed(1) + '억';
    if (v >= 1e4)  return (v / 1e4 ).toFixed(0) + '만';
    return Math.round(v).toLocaleString();
  }
  function sizeNote(n) {
    if (n == null) return '';
    if (n < 3)   return ' <span class="warn">⚠ 표본 적음</span>';
    if (n < 10)  return ' <span class="muted">(참고용)</span>';
    return '';
  }
  function labelPill(label, text) {
    return `<span class="label-pill label-${label.toLowerCase()}">${escapeHtml(text)}</span>`;
  }
  function diffCell(v, dir) {
    if (v == null) return '<td>—</td>';
    const good = dir == null ? (v >= 3 ? true : v <= -3 ? false : null)
                              : (dir > 0 ? v >= 3 : v <= -3);
    const cls = good === true ? 'good' : good === false ? 'bad' : '';
    const sign = v > 0 ? '+' : '';
    return `<td class="imp ${cls}">${sign}${v}pp</td>`;
  }

  function reviewRow(r) {
    const topName = r.topHighCandidate ? r.topHighCandidate.name + ' (' + r.topHighCandidate.code + ')' : '—';
    const topHigh = r.topHighCandidate && r.topHighCandidate.dayResult ? r.topHighCandidate.dayResult.dayHighReturn : null;
    return `<tr class="row-${r.label.toLowerCase()}">
      <td><b>${escapeHtml(r.date)}</b><div class="sub">${escapeHtml(r.weekday)}</div></td>
      <td>${r.total1ds}</td>
      <td>${r.attackTopCount}${sizeNote(r.attackTopCount)}</td>
      <td class="pos">${r.attackTopBig10}</td>
      <td class="pos">${r.attackTopBig15}</td>
      <td class="pos-strong">${r.attackTopBig20}</td>
      <td>${pct(r.attackTopBig10Rate)}</td>
      <td>${num(r.attackTopAvgHighReturn)}%</td>
      <td>${num(r.attackTopAvgCloseReturn)}%</td>
      <td class="neg">${r.attackTopFailed}</td>
      <td>${r.noRiskAttackCount}</td>
      <td>${escapeHtml(topName)}</td>
      <td>${num(topHigh)}%</td>
      <td>${labelPill(r.label, r.labelText)}${r.sampleNote ? '<div class="sub warn">' + escapeHtml(r.sampleNote) + '</div>' : ''}</td>
    </tr>`;
  }
  function compareRow(r) {
    let cls = '';
    if (r.big10Diff != null && r.big10Diff >= 10) cls = 'row-good';
    else if (r.big10Diff != null && r.big10Diff <= -5) cls = 'row-bad';
    return `<tr class="${cls}">
      <td><b>${escapeHtml(r.date)}</b><div class="sub">${escapeHtml(r.weekday)}</div></td>
      <td>${pct(r.baseBig10Rate)}</td>
      <td class="pos">${pct(r.attackBig10Rate)}</td>
      ${diffCell(r.big10Diff)}
      <td>${num(r.baseAvgHigh)}%</td>
      <td class="pos">${num(r.attackAvgHigh)}%</td>
      ${diffCell(r.avgHighDiff)}
      <td>${pct(r.baseFailedRate)}</td>
      <td>${pct(r.attackFailedRate)}</td>
      <td class="interp">${escapeHtml(r.interpretation)}</td>
    </tr>`;
  }
  function riskRow(r) {
    let interp = '';
    if (r.n < 10) interp = '표본 부족';
    else if (r.label === '공격형 TOP + 위험 태그 없음') interp = r.big10Rate >= 35 ? '⭐ 깔끔한 공격형 우위' : '평이';
    else if (r.label === '공격형 TOP + 위험 태그 있음') interp = r.big10Rate >= 35 ? '위험 태그가 단점이 아닐 수도' : '주의';
    else if (r.label === '갭 과열' && r.failedRate >= 30) interp = '실패율 높음 — 제외 후보';
    else interp = r.failedRate >= 30 ? '실패율 높음' : '참고';
    return `<tr>
      <td><b>${escapeHtml(r.label)}</b></td>
      <td>${r.n}${sizeNote(r.n)}</td>
      <td class="pos">${r.big10}</td>
      <td class="pos">${r.big15}</td>
      <td class="pos-strong">${r.big20}</td>
      <td>${num(r.avgHigh)}%</td>
      <td>${num(r.avgClose)}%</td>
      <td class="neg">${pct(r.failedRate)}</td>
      <td class="interp">${escapeHtml(interp)}</td>
    </tr>`;
  }
  function weekdayRow(w) {
    return `<tr>
      <td><b>${escapeHtml(w.weekday)}</b></td>
      <td>${w.dayCount}</td>
      <td>${w.attackTopCount}</td>
      <td class="pos">${w.big10}</td>
      <td>${pct(w.big10Rate)}</td>
      <td>${num(w.avgHigh)}%</td>
      <td class="neg">${w.failed} (${pct(w.failedRate)})</td>
    </tr>`;
  }
  function candidateCardHtml(c) {
    const cls = ['attack-card'];
    if (c.rank <= 3) cls.push('is-top');
    const r = c.dayResult;
    const hCls = r ? (r.dayHighReturn  >= 15 ? 'pos-strong' : r.dayHighReturn  >= 10 ? 'pos' : r.dayHighReturn  >= 3 ? 'warn' : 'neg') : '';
    const cCls = r ? (r.dayCloseReturn >= 5  ? 'pos' : r.dayCloseReturn >= 0 ? 'warn' : 'neg') : '';
    const labelCls = r && r.reached20 ? 'lbl-big' : r && r.reached15 ? 'lbl-big' : r && r.reached10 ? 'lbl-mid' : c.resultLabel.includes('실패') ? 'lbl-fail' : 'lbl-warn';
    return `<div class="${cls.join(' ')}">
      <div class="ac-head">
        <span class="ac-rank">#${c.rank}</span>
        <div class="ac-title">
          <span class="name">${escapeHtml(c.name)}</span>
          <span class="code">${escapeHtml(c.code)}</span>
        </div>
        <div class="ac-score">score ${num(c.attackScore, 1)}</div>
      </div>
      <div class="ac-meta">거래대금 <b>${fmoneyLocal(c.morningValue)}</b> (순위 <b>${c.morningValueRank}위</b>, 상위 ${num(c.morningValuePercentile, 1)}%) · 재돌파 ${c.rebreakMorningHigh ? '<b class="pos">✓ ' + escapeHtml(c.rebreakTime || '') + '</b>' : '—'} · 거래대금 동반 ${c.rebreakWithValue ? '<b class="pos">✓</b>' : '—'}</div>
      <div class="ac-meta">decisionPrice ${f0(c.decisionPrice)} · 시가 대비 ${num(c.decisionFromOpen)}% · 갭 ${num(c.gapRate)}%</div>
      ${r ? `<div class="ac-result">📊 <span class="${labelCls}">${escapeHtml(c.resultLabel)}</span> · 당일 고가 <b class="${hCls}">${num(r.dayHighReturn)}%</b> · 종가 <b class="${cCls}">${num(r.dayCloseReturn)}%</b> · 고가→종가 ${num(r.highCloseDrop)}%</div>` : '<div class="ac-result-pending">결과 미확정</div>'}
      <div class="ac-tags">
        ${(c.resultTags || []).slice(0, 5).map((t) => '<span class="chip chip-result">' + escapeHtml(t) + '</span>').join('')}
      </div>
      ${(c.riskTags && c.riskTags.length) ? '<div class="ac-tags">' + c.riskTags.map((t) => '<span class="chip chip-risk">' + escapeHtml(t) + '</span>').join('') + '</div>' : ''}
      <div class="ac-comment">${escapeHtml(c.resultComment || '')}</div>
    </div>`;
  }

  // 상단 카드
  const bestDateStr = summary.bestDate ? `${summary.bestDate.date} (${summary.bestDate.attackTopBig20}/${summary.bestDate.attackTopBig15}/${summary.bestDate.attackTopBig10} BIG20/15/10)` : '—';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>1DS 공격형 TOP 날짜별 복기 보고서</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo','Noto Sans KR',sans-serif;background:#0f172a;color:#e2e8f0;margin:0 auto;padding:18px 24px 80px;max-width:1700px;line-height:1.55;font-size:13px;}
  h1{font-size:22px;margin:6px 0 4px;color:#f1f5f9;font-weight:700;}
  h2{font-size:16px;margin:26px 0 10px;color:#cbd5e1;border-bottom:1px solid #1e293b;padding-bottom:6px;}
  h3{font-size:14px;margin:14px 0 6px;color:#94a3b8;}
  .subtitle{color:#94a3b8;font-size:13px;margin-bottom:8px;line-height:1.6;}
  .exp-pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:#7c2d12;color:#fdba74;border:1px solid #ea580c;margin-left:8px;vertical-align:middle;font-weight:600;}
  .intro{background:#0f172a;border-left:3px solid #fb923c;padding:12px 16px;border-radius:6px;margin-bottom:14px;line-height:1.7;color:#cbd5e1;font-size:13px;}
  .intro b{color:#fdba74;}
  .meta-box{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 18px;margin-bottom:14px;font-size:12px;color:#94a3b8;}
  .meta-box span{margin-right:14px;}
  .meta-box b{color:#e2e8f0;}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px;}
  .card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 14px;}
  .card .lbl{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.4px;}
  .card .val{font-size:22px;font-weight:700;margin-top:4px;color:#f1f5f9;font-variant-numeric:tabular-nums;}
  .card .sub{font-size:11px;color:#64748b;margin-top:2px;}
  .card.excellent{border-left:4px solid #ef4444;}
  .card.good{border-left:4px solid #14b8a6;}
  .card.bad{border-left:4px solid #94a3b8;}
  .card.attack{border-left:4px solid #ea580c;}
  table{width:100%;border-collapse:collapse;background:#1e293b;border:1px solid #334155;border-radius:8px;overflow:hidden;font-size:12px;}
  th,td{padding:8px 9px;text-align:left;border-bottom:1px solid #334155;color:#cbd5e1;vertical-align:top;}
  th{background:#0f172a;color:#cbd5e1;font-weight:600;font-size:11px;}
  td .sub{font-size:10px;color:#64748b;}
  td.imp{font-weight:600;}
  td.imp.good{color:#5eead4;}
  td.imp.bad{color:#fca5a5;}
  td.pos{color:#5eead4;font-weight:600;}
  td.pos-strong{color:#fbbf24;font-weight:700;}
  td.neg{color:#fca5a5;font-weight:600;}
  td.warn{color:#fbbf24;font-weight:600;}
  .interp{font-size:11px;color:#94a3b8;max-width:180px;}
  /* 라벨 pill */
  .label-pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:700;}
  .label-pill.label-excellent_day{background:#7f1d1d;color:#fecaca;border:1px solid #ef4444;}
  .label-pill.label-good_day{background:#042f2e;color:#5eead4;border:1px solid #14b8a6;}
  .label-pill.label-mixed_day{background:#422006;color:#fde68a;border:1px solid #f59e0b;}
  .label-pill.label-bad_day{background:#1e293b;color:#fca5a5;border:1px solid #94a3b8;}
  .label-pill.label-no_signal_day{background:#0f172a;color:#64748b;border:1px solid #334155;}
  /* row 색상 (옅게) */
  tr.row-excellent_day td{background:rgba(127,29,29,0.15);}
  tr.row-good_day td{background:rgba(4,47,46,0.25);}
  tr.row-mixed_day td{background:rgba(66,32,6,0.15);}
  tr.row-bad_day td{background:rgba(30,41,59,0.5);}
  tr.row-no_signal_day td{color:#64748b;}
  tr.row-good td{background:rgba(4,47,46,0.2);}
  tr.row-bad td{background:rgba(127,29,29,0.15);}

  .explain{background:#0f172a;border-left:3px solid #fbbf24;padding:10px 14px;margin:8px 0 14px;border-radius:6px;font-size:12px;color:#fcd34d;line-height:1.6;}
  .explain b{color:#fbbf24;}
  .recobox{background:#7c2d12;border-left:3px solid #fb923c;padding:12px 16px;border-radius:6px;margin:12px 0;}
  .recobox .row{margin:4px 0;font-size:13px;color:#fed7aa;}
  .recobox b{color:#fdba74;}
  .muted{color:#64748b;}
  .warn{color:#fca5a5;font-weight:600;}
  .empty{padding:14px;color:#64748b;font-size:12px;background:#1e293b;border:1px dashed #475569;border-radius:8px;}
  details{margin:6px 0 14px;}
  details summary{cursor:pointer;padding:8px 14px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;font-size:13px;font-weight:700;color:#cbd5e1;margin-bottom:8px;user-select:none;}
  /* 후보 카드 */
  .attack-card{background:#1e293b;border:1px solid #334155;border-left:5px solid #fb923c;border-radius:8px;padding:10px 14px;margin-bottom:8px;}
  .attack-card.is-top{background:linear-gradient(90deg,#7c2d12 0%,#1e293b 25%);border-left-color:#fbbf24;}
  .attack-card .ac-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;}
  .attack-card .ac-rank{font-size:13px;font-weight:800;color:#fbbf24;background:#422006;padding:2px 8px;border-radius:5px;min-width:30px;text-align:center;}
  .attack-card .ac-title{font-size:14px;font-weight:700;display:flex;gap:6px;align-items:baseline;}
  .attack-card .ac-title .name{color:#f1f5f9;}
  .attack-card .ac-title .code{color:#94a3b8;font-size:11px;font-weight:400;}
  .attack-card .ac-score{margin-left:auto;font-size:11px;color:#fcd34d;}
  .attack-card .ac-meta{font-size:11.5px;color:#cbd5e1;margin:2px 0;}
  .attack-card .ac-meta .pos{color:#5eead4;}
  .attack-card .ac-meta .neg{color:#fca5a5;}
  .attack-card .ac-meta b{color:#f1f5f9;}
  .attack-card .ac-result{margin-top:6px;padding:6px 10px;background:rgba(0,0,0,0.35);border-radius:5px;font-size:11.5px;color:#cbd5e1;}
  .attack-card .ac-result .pos{color:#5eead4;font-weight:700;}
  .attack-card .ac-result .pos-strong{color:#fbbf24;font-weight:700;}
  .attack-card .ac-result .neg{color:#fca5a5;font-weight:700;}
  .attack-card .ac-result .warn{color:#fbbf24;font-weight:700;}
  .attack-card .ac-result .lbl-big{color:#5eead4;font-weight:700;}
  .attack-card .ac-result .lbl-mid{color:#93c5fd;font-weight:700;}
  .attack-card .ac-result .lbl-warn{color:#fbbf24;font-weight:700;}
  .attack-card .ac-result .lbl-fail{color:#fca5a5;font-weight:700;}
  .attack-card .ac-result-pending{font-size:11px;color:#64748b;margin-top:6px;font-style:italic;}
  .attack-card .ac-tags{margin-top:4px;}
  .chip{display:inline-block;font-size:10px;padding:1px 6px;border-radius:3px;margin:1px 2px 1px 0;border:1px solid transparent;}
  .chip-result{background:#172554;color:#bfdbfe;border-color:#1e3a8a;}
  .chip-risk{background:#7f1d1d;color:#fca5a5;border-color:#ef4444;}
  .attack-card .ac-comment{font-size:11px;color:#94a3b8;margin-top:4px;font-style:italic;}

  .footer{margin-top:30px;padding:14px;background:#1e293b;border:1px solid #334155;border-radius:8px;font-size:12px;color:#94a3b8;line-height:1.7;}
  .table-wrap{overflow-x:auto;}
</style>
</head>
<body>

<h1>🗓 1DS 공격형 TOP 날짜별 복기 보고서 <span class="exp-pill">날짜별 복기</span></h1>
<div class="subtitle">거래대금 상위 10% + 장초 고가 재돌파 후보가 날짜별로 실제 어떤 결과를 냈는지 확인</div>

<div class="intro">
  이 보고서는 기존 1DS 공격형 TOP 조건이 <b>날짜별로 실제로 얼마나 맞았는지 복기</b>하기 위한 보고서입니다.
  60일/20일/100일 단위 감사에서 BIG_MONEY_REBREAK는 strong 등급으로 검증됐지만, 실전 운영에서는 "어느 날 좋았고 어느 날 약했는가"의 편차도 중요합니다.
  매수 추천이 아니라 <b>조건 개선과 운영 판단을 위한 기록</b>입니다.
</div>

<div class="meta-box">
  <span>생성: <b>${escapeHtml(meta.generatedAt)}</b></span>
  <span>모드: <b>${escapeHtml(meta.analysisMode)}</b></span>
  <span>분석 기간: <b>${escapeHtml(meta.periodFrom || '-')}</b> ~ <b>${escapeHtml(meta.periodTo || '-')}</b> (${meta.actualDays}일)</span>
  <span>decision: <b>${escapeHtml(meta.decisionTime)}</b></span>
  <span>분봉 누락: <b>${meta.missingMinuteCount}</b></span>
  <span>가격 mismatch: <b>${meta.priceMismatchCount}</b></span>
</div>

<div class="cards">
  <div class="card"><div class="lbl">분석 거래일</div><div class="val">${summary.totalDays}</div><div class="sub">${escapeHtml(meta.analysisMode)}</div></div>
  <div class="card"><div class="lbl">전체 1DS 후보</div><div class="val">${summary.total1ds}</div><div class="sub">결과 가능 entries</div></div>
  <div class="card attack"><div class="lbl">공격형 TOP 누적</div><div class="val" style="color:#fdba74;">${summary.attackTopTotal}</div><div class="sub">전 기간 합산</div></div>
  <div class="card attack"><div class="lbl">공격형 TOP 일평균</div><div class="val" style="color:#fdba74;">${num(summary.attackTopPerDay, 2)}</div><div class="sub">개/일</div></div>
  <div class="card"><div class="lbl">공격형 BIG10</div><div class="val" style="color:#5eead4;">${pct(summary.attackTopBig10Rate)}</div><div class="sub">+10% 이상 도달</div></div>
  <div class="card"><div class="lbl">공격형 BIG15</div><div class="val" style="color:#5eead4;">${pct(summary.attackTopBig15Rate)}</div><div class="sub">+15% 이상</div></div>
  <div class="card"><div class="lbl">공격형 BIG20</div><div class="val" style="color:#fbbf24;">${pct(summary.attackTopBig20Rate)}</div><div class="sub">+20% 이상</div></div>
  <div class="card excellent"><div class="lbl">매우 좋음 / 좋음</div><div class="val" style="color:#5eead4;">${summary.excellentDays + summary.goodDays}</div><div class="sub">EXCELLENT + GOOD</div></div>
  <div class="card bad"><div class="lbl">약함 / 혼조</div><div class="val" style="color:#fca5a5;">${summary.badDays + summary.mixedDays}</div><div class="sub">BAD + MIXED</div></div>
  <div class="card"><div class="lbl">후보 없는 날</div><div class="val">${summary.noSignalDays}</div><div class="sub">attackTop 0개</div></div>
  <div class="card"><div class="lbl">최고 성과 날짜</div><div class="val" style="font-size:14px;">${escapeHtml(bestDateStr)}</div><div class="sub">BIG20/15/10 합산 기준</div></div>
  <div class="card"><div class="lbl">최악 날짜</div><div class="val" style="font-size:14px;">${escapeHtml(summary.worstDate ? summary.worstDate.date + ' (avg ' + num(summary.worstDate.attackTopAvgHighReturn) + '%)' : '—')}</div><div class="sub">BAD_DAY 중 평균고가 최저</div></div>
</div>

<h2>섹션 1 · 전체 요약</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 분석 기간 동안 공격형 TOP 후보가 평균적으로 얼마나 강했는지, 그리고 좋은 날 / 약한 날의 분포를 한눈에 봅니다.
</div>
<table>
  <tbody>
    <tr><th>지표</th><th>값</th></tr>
    <tr><td>분석 거래일</td><td>${summary.totalDays}</td></tr>
    <tr><td>전체 1DS 후보 (결과 가능)</td><td>${summary.total1ds}</td></tr>
    <tr><td>공격형 TOP 누적</td><td>${summary.attackTopTotal}</td></tr>
    <tr><td>일평균</td><td>${num(summary.attackTopPerDay, 2)}</td></tr>
    <tr><td>BIG10 비율</td><td><b style="color:#5eead4;">${pct(summary.attackTopBig10Rate)}</b></td></tr>
    <tr><td>BIG15 비율</td><td><b style="color:#5eead4;">${pct(summary.attackTopBig15Rate)}</b></td></tr>
    <tr><td>BIG20 비율</td><td><b style="color:#fbbf24;">${pct(summary.attackTopBig20Rate)}</b></td></tr>
    <tr><td>평균 당일 고가</td><td>${num(summary.attackTopAvgHighReturn)}%</td></tr>
    <tr><td>평균 당일 종가</td><td>${num(summary.attackTopAvgCloseReturn)}%</td></tr>
    <tr><td>실패율</td><td><b style="color:#fca5a5;">${pct(summary.attackTopFailedRate)}</b></td></tr>
    <tr><td>EXCELLENT 날 수</td><td>${summary.excellentDays}</td></tr>
    <tr><td>GOOD 날 수</td><td>${summary.goodDays}</td></tr>
    <tr><td>MIXED 날 수</td><td>${summary.mixedDays}</td></tr>
    <tr><td>BAD 날 수</td><td>${summary.badDays}</td></tr>
    <tr><td>NO_SIGNAL 날 수 (공격형 TOP 0개)</td><td>${summary.noSignalDays}</td></tr>
    <tr><td>활성 일자 (NO_SIGNAL 제외)</td><td>${summary.totalDays - summary.noSignalDays}</td></tr>
  </tbody>
</table>

<h2>섹션 2 · 날짜별 요약표</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 각 거래일에 공격형 TOP 후보가 몇 개였고, 그중 실제 BIG10/BIG15/BIG20에 몇 개가 도달했는지를 한 줄씩 봅니다.
  날짜 판정 색상: <span class="label-pill label-excellent_day">매우 좋음</span> <span class="label-pill label-good_day">좋음</span> <span class="label-pill label-mixed_day">혼조</span> <span class="label-pill label-bad_day">약함</span> <span class="label-pill label-no_signal_day">후보 없음</span>
</div>
<div class="table-wrap">
<table>
  <thead><tr>
    <th>날짜</th><th>전체 1DS</th><th>공격형 TOP</th>
    <th>BIG10</th><th>BIG15</th><th>BIG20</th><th>BIG10 비율</th>
    <th>평균고가</th><th>평균종가</th><th>실패</th>
    <th>위험태그 없음</th><th>최고 종목</th><th>최고 고가%</th><th>판정</th>
  </tr></thead>
  <tbody>${dailyReviews.map(reviewRow).join('')}</tbody>
</table>
</div>

<h2>섹션 3 · 날짜별 상세 후보 (최근 ${Math.min(DAILY_DETAIL_LIMIT, dailyReviews.length)}일)</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 각 날짜의 공격형 TOP 후보 카드. 거래대금 순위 · 재돌파 시각 · 결과 태그까지 한 카드에서 확인.
  attackTop이 0개인 날은 펼치지 않습니다.
</div>
${dailyReviews.slice(0, DAILY_DETAIL_LIMIT).filter((r) => r.attackTopCount > 0).map((r) => `<details${r.label === 'EXCELLENT_DAY' || r.label === 'GOOD_DAY' ? ' open' : ''}>
  <summary>${escapeHtml(r.date)} (${escapeHtml(r.weekday)}) · ${labelPill(r.label, r.labelText)} · 공격형 TOP ${r.attackTopCount}개 · BIG10 ${r.attackTopBig10} / BIG15 ${r.attackTopBig15} / BIG20 ${r.attackTopBig20} · 평균고가 ${num(r.attackTopAvgHighReturn)}%</summary>
  ${r.candidates.map(candidateCardHtml).join('')}
</details>`).join('')}

<h2>섹션 4 · 날짜별 BASE vs 공격형 TOP 비교</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 같은 날 기존 1DS 전체와 공격형 TOP의 결과 차이. 공격형이 그날도 실제로 우위였는지, 아니면 그날은 공격형이 약했는지 확인.
</div>
<div class="table-wrap">
<table>
  <thead><tr>
    <th>날짜</th><th>BASE BIG10</th><th>공격형 BIG10</th><th>차이</th>
    <th>BASE 평균고가</th><th>공격형 평균고가</th><th>차이</th>
    <th>BASE 실패율</th><th>공격형 실패율</th><th>해석</th>
  </tr></thead>
  <tbody>${baseVsAttackByDate.map(compareRow).join('')}</tbody>
</table>
</div>

<h2>섹션 5 · 위험 태그 유무 비교 (전체 기간)</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 공격형 TOP 중 위험 태그가 붙은 후보와 안 붙은 후보의 성과를 비교합니다. 위험 태그가 정말 제외 신호인지 확인.
</div>
<table>
  <thead><tr>
    <th>그룹</th><th>n</th><th>BIG10</th><th>BIG15</th><th>BIG20</th>
    <th>평균고가</th><th>평균종가</th><th>실패율</th><th>해석</th>
  </tr></thead>
  <tbody>${riskTagComparison.map(riskRow).join('')}</tbody>
</table>

<h2>섹션 6 · 요일별 성과</h2>
<div class="explain">
  <b>쉽게 말하면</b> — 월/화/수/목/금 중 공격형 TOP이 잘 맞는 요일이 있는지 본다. (시장 지수 split은 데이터 부족으로 생략)
</div>
<table>
  <thead><tr>
    <th>요일</th><th>거래일 수</th><th>공격형 TOP 합산</th>
    <th>BIG10</th><th>BIG10 비율</th><th>평균고가</th><th>실패</th>
  </tr></thead>
  <tbody>${weekdayStats.map(weekdayRow).join('')}</tbody>
</table>

<h2>섹션 7 · 대표 성공일</h2>
<div class="explain">
  <b>쉽게 말하면</b> — EXCELLENT/GOOD 등급 중 BIG20·BIG15·BIG10 합산이 가장 큰 5일. 어떤 시장 흐름에서 공격형 TOP이 강했는지 케이스로 확인.
</div>
${successDays.length === 0 ? '<div class="empty">대표 성공일이 없습니다 (EXCELLENT/GOOD 등급 후보 없음).</div>' :
  successDays.map((r) => `<details open>
    <summary>${escapeHtml(r.date)} (${escapeHtml(r.weekday)}) · ${labelPill(r.label, r.labelText)} · BIG20 ${r.attackTopBig20} / BIG15 ${r.attackTopBig15} / BIG10 ${r.attackTopBig10} · 평균고가 ${num(r.attackTopAvgHighReturn)}%</summary>
    ${r.candidates.slice(0, 8).map(candidateCardHtml).join('')}
  </details>`).join('')}

<h2>섹션 8 · 대표 실패일</h2>
<div class="explain">
  <b>쉽게 말하면</b> — BAD_DAY 중 공격형 TOP 후보는 많았지만 BIG10이 없거나 평균고가가 낮았던 5일. 어떤 날 약했고 어떤 위험 태그가 많았는지 확인.
</div>
${failureDays.length === 0 ? '<div class="empty">대표 실패일이 없습니다 (BAD_DAY + 후보 3개 이상 조건 미충족).</div>' :
  failureDays.map((r) => `<details>
    <summary>${escapeHtml(r.date)} (${escapeHtml(r.weekday)}) · ${labelPill(r.label, r.labelText)} · 후보 ${r.attackTopCount}개 / 평균고가 ${num(r.attackTopAvgHighReturn)}% / 실패 ${r.attackTopFailed}</summary>
    ${r.candidates.slice(0, 8).map(candidateCardHtml).join('')}
  </details>`).join('')}

<h2>섹션 9 · 결론 및 운영 제안</h2>
<div class="recobox">
  ${conclusionLines.map((l) => `<div class="row">${escapeHtml(l)}</div>`).join('')}
  <div class="row" style="margin-top:8px;"><b>다음 단계:</b></div>
  <div class="row">1. 최고 성과 날짜의 공통점(시장 지수, 섹터, 거래대금 절대 규모 등)을 별도로 split해 검증</div>
  <div class="row">2. BAD_DAY가 많으면 시장 지수/지수 변동률을 추가 필터로 검토</div>
  <div class="row">3. 위험 태그 유무 차이가 크면 운영 보드에서 위험 태그 자동 강조 추가 검토</div>
  <div class="row">4. 본 결과는 묘사형 — 실제 운영 전 최근 20일 재검증 권장</div>
</div>

<h2>섹션 10 · 주의사항</h2>
<ul>
  <li>이 보고서는 매수 추천이 아니라 묘사형 복기. 결과는 일봉 high/close/low 기준 (분봉 순서 미사용).</li>
  <li>decisionPrice = 09:30 close. 분봉이 없으면 해당 후보는 제외.</li>
  <li>거래대금 상위 10%는 <b>날짜별</b>로 계산. 전체 기간 합산이 아님.</li>
  <li>장초 고가 재돌파 = 09:00~09:30 morningHigh를 09:40~10:00에 다시 돌파.</li>
  <li>BIG_MONEY_REBREAK = 거래대금 상위 10% + 장초 고가 재돌파 — 현재 공격형 TOP 정의와 동일.</li>
  <li>가격 sanity guard: intraday open vs daily open 1.5배 이상 차이 시 차트 오염으로 보고 제외.</li>
  <li>attackTopCount &lt; 3인 날은 "표본 적음" 표시 — 라벨 판정에 과한 의미 부여 금지.</li>
  <li>요일별 split은 단순 합산. 시장 상태(상승/하락) split은 KOSPI/KOSDAQ 지수 데이터가 보고서에 포함되지 않아 생략.</li>
</ul>

<div class="footer">
  이 보고서는 1DS 공격형 TOP(BIG_MONEY_REBREAK) 조건의 "날짜별 실전 복기" 결과입니다.
  운영 보드는 별도. 본 결과는 조건 개선과 운영 판단 보조 자료로 사용하세요.
</div>

</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log('\n🗓 1DS 공격형 TOP 날짜별 복기 보고서');
  const t0 = Date.now();

  if (!fs.existsSync(INTRADAY_BASE)) { console.error('  [ERROR] data/intraday/1ds 없음.'); process.exit(1); }
  const metaMap = loadMetaMap();
  console.log(`  메타 로드: ${metaMap.size}건`);

  // 날짜 결정
  const allDirs = fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  let dates;
  let analysisMode;
  if (args.date) {
    dates = [args.date];
    analysisMode = `single_date (${args.date})`;
  } else if (args.from || args.to) {
    dates = allDirs.filter((d) => (!args.from || d >= args.from) && (!args.to || d <= args.to));
    analysisMode = `range (${args.from || allDirs[0]} ~ ${args.to || allDirs[allDirs.length - 1]})`;
  } else {
    const n = args.days || DEFAULT_DAYS;
    dates = allDirs.slice(-Math.min(n, allDirs.length));
    analysisMode = `recent_${dates.length}d (requested=${n})`;
  }
  if (dates.length === 0) { console.error('  [ERROR] 분석할 날짜 없음.'); process.exit(1); }
  console.log(`  📅 ${analysisMode} — ${dates.length}일 (${dates[0]} ~ ${dates[dates.length - 1]})`);

  // 날짜별 review
  const dailyReviews = [];
  let totalMissingMinute = 0, totalPriceMismatch = 0, totalSnapFail = 0;
  for (const date of dates) {
    const review = buildDailyReview(date, metaMap);
    dailyReviews.push(review);
    totalMissingMinute += review.missingMinute;
    totalPriceMismatch += review.priceMismatch;
    totalSnapFail      += review.snapFail;
  }

  // 전체 기간 summary
  const totalDays = dates.length;
  const total1ds = dailyReviews.reduce((s, r) => s + r.withResultCount, 0);
  const attackTopTotal = dailyReviews.reduce((s, r) => s + r.attackTopCount, 0);
  const attackTopBig10 = dailyReviews.reduce((s, r) => s + r.attackTopBig10, 0);
  const attackTopBig15 = dailyReviews.reduce((s, r) => s + r.attackTopBig15, 0);
  const attackTopBig20 = dailyReviews.reduce((s, r) => s + r.attackTopBig20, 0);
  const attackTopFailed = dailyReviews.reduce((s, r) => s + r.attackTopFailed, 0);
  const highSum  = dailyReviews.map((r) => r.attackTopAvgHighReturn).filter((x) => Number.isFinite(x));
  const closeSum = dailyReviews.map((r) => r.attackTopAvgCloseReturn).filter((x) => Number.isFinite(x));
  const excellentDays = dailyReviews.filter((r) => r.label === 'EXCELLENT_DAY').length;
  const goodDays      = dailyReviews.filter((r) => r.label === 'GOOD_DAY').length;
  const mixedDays     = dailyReviews.filter((r) => r.label === 'MIXED_DAY').length;
  const badDays       = dailyReviews.filter((r) => r.label === 'BAD_DAY').length;
  const noSignalDays  = dailyReviews.filter((r) => r.label === 'NO_SIGNAL_DAY').length;

  // best/worst
  const sortedBest = dailyReviews.slice().sort((a, b) => {
    const sb = (b.attackTopBig20 * 100) + (b.attackTopBig15 * 10) + (b.attackTopBig10);
    const sa = (a.attackTopBig20 * 100) + (a.attackTopBig15 * 10) + (a.attackTopBig10);
    return sb - sa;
  });
  const bestDate = sortedBest[0] && sortedBest[0].attackTopCount > 0 ? sortedBest[0] : null;
  const worstCands = dailyReviews.filter((r) => r.label === 'BAD_DAY' && r.attackTopCount >= 3);
  worstCands.sort((a, b) => (a.attackTopAvgHighReturn || 0) - (b.attackTopAvgHighReturn || 0));
  const worstDate = worstCands[0] || null;

  const summary = {
    totalDays,
    total1ds,
    attackTopTotal,
    attackTopPerDay: totalDays > 0 ? round(attackTopTotal / totalDays, 2) : null,
    attackTopBig10Rate: rate(attackTopBig10, attackTopTotal),
    attackTopBig15Rate: rate(attackTopBig15, attackTopTotal),
    attackTopBig20Rate: rate(attackTopBig20, attackTopTotal),
    attackTopAvgHighReturn:  highSum.length ? round(highSum.reduce((s, x) => s + x, 0) / highSum.length, 2) : null,
    attackTopAvgCloseReturn: closeSum.length ? round(closeSum.reduce((s, x) => s + x, 0) / closeSum.length, 2) : null,
    attackTopFailedRate: rate(attackTopFailed, attackTopTotal),
    excellentDays, goodDays, mixedDays, badDays, noSignalDays,
    bestDate: bestDate ? { date: bestDate.date, weekday: bestDate.weekday, label: bestDate.label,
                          attackTopCount: bestDate.attackTopCount, attackTopBig10: bestDate.attackTopBig10,
                          attackTopBig15: bestDate.attackTopBig15, attackTopBig20: bestDate.attackTopBig20,
                          attackTopAvgHighReturn: bestDate.attackTopAvgHighReturn } : null,
    worstDate: worstDate ? { date: worstDate.date, weekday: worstDate.weekday, label: worstDate.label,
                            attackTopCount: worstDate.attackTopCount, attackTopAvgHighReturn: worstDate.attackTopAvgHighReturn } : null,
  };

  // 비교/요일/위험태그
  const baseVsAttackByDate = buildBaseVsAttackByDate(dailyReviews);
  const allCandidatesFlat = [].concat(...dailyReviews.map((r) => r.candidates));
  const riskTagComparison = buildRiskTagComparison(allCandidatesFlat);
  const weekdayStats = buildWeekdayStats(dailyReviews);
  const successDays = pickSuccessDays(dailyReviews, 5);
  const failureDays = pickFailureDays(dailyReviews, 5);

  // 샘플
  function flatSort(arr, getter, dir) {
    return arr.slice().filter((c) => c.dayResult && Number.isFinite(getter(c)))
      .sort((a, b) => dir === 'desc' ? getter(b) - getter(a) : getter(a) - getter(b));
  }
  const samples = {
    bestAttackCandidates: flatSort(allCandidatesFlat, (c) => c.dayResult.dayHighReturn, 'desc').slice(0, SAMPLE_LIMIT),
    failedAttackCandidates: flatSort(allCandidatesFlat, (c) => c.dayResult.dayCloseReturn, 'asc').slice(0, SAMPLE_LIMIT),
    big20Candidates: allCandidatesFlat.filter((c) => c.dayResult && c.dayResult.reached20).slice(0, SAMPLE_LIMIT),
  };

  const conclusionLines = buildConclusion(summary, riskTagComparison);

  // meta
  const meta = {
    generatedAt: new Date().toISOString(),
    analysisMode,
    periodFrom: dates[0],
    periodTo: dates[dates.length - 1],
    actualDays: dates.length,
    decisionTime: DECISION_TIME,
    sourceFiles: [
      'data/intraday/1ds/{date}/{code}.json',
      'cache/stock-charts-long/{code}.json',
      'cache/naver-stocks-list.json',
    ],
    missingMinuteCount: totalMissingMinute,
    priceMismatchCount: totalPriceMismatch,
    snapFailCount: totalSnapFail,
    notes: [
      '거래대금 상위 10% 계산은 날짜별 (1DS 후보 중). 전체 기간 합산이 아님.',
      'BIG_MONEY_REBREAK = 거래대금 상위 10% + 장초 고가 재돌파. 60일 감사에서 strong 등급 검증된 조건.',
      'decisionPrice = 09:30 close. dayHigh/Close/Low = 일봉 OHLC. dayHighReturn = (dayHigh / decisionPrice - 1) × 100.',
      '분봉 순서 기반 +3/-3 먼저 도달은 이 보고서에서 미사용 (일봉 결과로 충분).',
      '날짜별 attackTopCount < 3은 "표본 적음" — 라벨 판정에 과한 의미 부여 금지.',
      '시장 지수(KOSPI/KOSDAQ) split은 데이터 비포함으로 생략. 향후 추가 검증 가능.',
    ],
  };

  const result = {
    meta, summary, dailyReviews,
    baseVsAttackByDate, riskTagComparison, weekdayStats,
    successDays, failureDays, samples, conclusionLines,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf-8');
  fs.writeFileSync(OUT_HTML, renderHtml(result), 'utf-8');

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\n📄 JSON: ${path.relative(ROOT, OUT_JSON)}`);
  console.log(`📄 HTML: ${path.relative(ROOT, OUT_HTML)}`);
  console.log(`📅 분석 기간: ${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length}일, ${analysisMode})`);
  console.log(`\n📊 전체 1DS (결과 가능): ${total1ds} / 공격형 TOP 누적: ${attackTopTotal} (일평균 ${summary.attackTopPerDay})`);
  console.log(`   BIG10 ${pct(summary.attackTopBig10Rate)} / BIG15 ${pct(summary.attackTopBig15Rate)} / BIG20 ${pct(summary.attackTopBig20Rate)}`);
  console.log(`   평균 당일고가 ${num(summary.attackTopAvgHighReturn)}% / 평균 종가 ${num(summary.attackTopAvgCloseReturn)}% / 실패율 ${pct(summary.attackTopFailedRate)}`);
  console.log(`\n📅 날짜 분포 — EXCELLENT ${excellentDays} / GOOD ${goodDays} / MIXED ${mixedDays} / BAD ${badDays} / NO_SIGNAL ${noSignalDays}`);
  if (bestDate) console.log(`   최고 날짜: ${bestDate.date} (${bestDate.weekday}, ${bestDate.label}) BIG20 ${bestDate.attackTopBig20} / BIG15 ${bestDate.attackTopBig15} / BIG10 ${bestDate.attackTopBig10}`);
  if (worstDate) console.log(`   최악 날짜: ${worstDate.date} (${worstDate.weekday}, ${worstDate.label}) 평균고가 ${worstDate.attackTopAvgHighReturn}%`);
  const withRisk = riskTagComparison.find((g) => g.label === '공격형 TOP + 위험 태그 있음');
  const noRisk   = riskTagComparison.find((g) => g.label === '공격형 TOP + 위험 태그 없음');
  console.log(`\n🛡 위험 태그 비교 — 있음 n=${withRisk?.n} BIG10 ${pct(withRisk?.big10Rate)} / 없음 n=${noRisk?.n} BIG10 ${pct(noRisk?.big10Rate)}`);
  console.log(`\n🎯 결론:`);
  for (const l of conclusionLines) console.log('   ' + l);
  console.log(`\n📝 다음 단계 제안:`);
  console.log('   1. 최고 성과 날짜의 공통점(시장 지수, 섹터, 거래대금 절대 규모) split 검증');
  console.log('   2. BAD_DAY가 많으면 시장 지수/변동률 추가 필터 검토');
  console.log('   3. 위험 태그 유무 차이 크면 운영 보드에 위험 태그 자동 강조 추가');
  console.log('   4. 본 결과는 묘사형 — 실제 운영 전 최근 20일 재검증 권장');
  console.log(`\n⏱ elapsed: ${elapsed}s`);

  function pct(v) { return v == null ? '—' : (v.toFixed ? v.toFixed(1) : v) + '%'; }
  function num(v, p) { return v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(p != null ? p : 2); }
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[FATAL]', e && e.stack || e);
    process.exit(1);
  }
}

module.exports = { main };
