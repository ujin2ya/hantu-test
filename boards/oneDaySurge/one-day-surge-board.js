#!/usr/bin/env node
/**
 * 1-Day Surge Board v5 — GOOD_TRADE 중심 리팩토링
 *
 * v4-extra2 검증 결과 반영:
 *   - HIT10 중심 A/B/C/D 그룹 → GOOD_TRADE 중심 GT 그룹 체계로 전환
 *   - 그룹: BALANCED-GT / LIGHT-GT / MID-CAP-GT / MOM-RISK / HEAVY-WATCH / MICRO-RISK / HEAVY-RISK
 *   - 시총 5조 이상 초대형주 / ETF / ETN / 리츠 / 스팩 / 우선주 기본 제외 (passesHardFilter)
 *   - gapRate는 다음날 시초가가 있어야 알 수 있어 카드에 "다음 거래일 시초가 확인 필요" 표시
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json (marketValue, isEtf, isSpecial)
 *   - stocks.json (보조)
 *   - qva-watchlist-board.json (있으면) QVA 참고 태그
 *   - cache/pattern-result.json (있으면) VVI 참고 태그
 *
 * 출력:
 *   - reports/one-day-surge-board-result.json
 *   - reports/one-day-surge-board-result.html
 *
 * 라우트: GET /one-day-surge-board (sendFile)
 */

const fs = require('fs');
const path = require('path');
const core = require('./one-day-surge-core');
const entryReport = require('./one-day-surge-entry-confirm-report');
const tradePlanModule = require('./one-day-surge-trade-plan');
const { isKrHoliday } = require('../../screeners/pattern-screener');
// 나스닥 테마 1DS 감시 후보풀 helper (1DS universe 확장용 — 본체 로직 변경 X, 태그 부착만)
const themeWatchPool = require('../../src/utils/theme1dsWatchPool');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');
const STOCKS_PATH = path.join(ROOT, 'stocks.json');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const QVA_BOARD_PATH = path.join(ROOT, 'qva-watchlist-board.json');
const PATTERN_RESULT_PATH = path.join(ROOT, 'cache', 'pattern-result.json');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const MANUAL_TARGETS_PATH = path.join(ROOT, 'data', 'manual-1ds-targets.json');
const SCANNER_0930_PATH = path.join(REPORTS_DIR, 'one-day-surge-0930-scanner.json');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-board-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-board-result.html');

// ─────────────────────────────────────────────────────────────────
// CLI 옵션 — 테스트용 --force-status intraday|closed|final_closed
// 실제 cron에서는 사용하지 않음. 장중/장마감 표시 동작 확인용.
// ─────────────────────────────────────────────────────────────────
const CLI_FORCE_MARKET_STATUS = (function () {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--force-status');
  if (idx >= 0 && args[idx + 1]) {
    const v = String(args[idx + 1]).toLowerCase();
    if (['intraday', 'closed', 'final_closed', 'holiday_closed'].includes(v)) return v;
    console.warn(`[WARN] --force-status 값이 잘못됨 (${args[idx + 1]}). intraday | closed | final_closed | holiday_closed 중 하나여야 함. 무시합니다.`);
  }
  return null;
})();

// ─────────────────────────────────────────────────────────────────
// 시장 상태 (KST 기준) — 장중/장마감/최종확정/휴장
//   주말 / 공휴일             : holiday_closed (직전 거래일 결과 표시)
//   09:00 ~ 15:35  (평일)     : intraday      (결과 미확정)
//   15:35 ~ 16:00  (평일)     : closed        (장마감 직후, 일봉 저장 약간 지연 가능)
//   16:00 ~ 다음 09:00 (평일) : final_closed  (확정 결과 사용 가능, 심야 포함)
// ─────────────────────────────────────────────────────────────────
// KST 기준 YYYYMMDD / YYYY-MM-DD 헬퍼
function _ymdKst(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value || '';
  const yyyy = get('year'), mm = get('month'), dd = get('day');
  const wd = get('weekday'); // 'Sun','Mon','Tue','Wed','Thu','Fri','Sat'
  return { yyyymmdd: yyyy + mm + dd, dashed: yyyy + '-' + mm + '-' + dd, weekday: wd };
}
function _isHolidayKst(yyyymmdd, weekdayStr) {
  if (weekdayStr === 'Sat' || weekdayStr === 'Sun') return true;
  if (isKrHoliday(yyyymmdd)) return true;
  return false;
}
function _previousTradingDateKst(fromDate) {
  // fromDate (Date) 기준 최대 14일 거슬러 첫 비휴장일을 찾는다.
  let d = new Date(fromDate.getTime() - 24 * 3600 * 1000);
  for (let i = 0; i < 14; i++) {
    const ymd = _ymdKst(d);
    if (!_isHolidayKst(ymd.yyyymmdd, ymd.weekday)) return ymd.dashed;
    d = new Date(d.getTime() - 24 * 3600 * 1000);
  }
  return null;
}

function getMarketStatus(forced) {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMin = (utcMin + 9 * 60) % (24 * 60);
  const hh = String(Math.floor(kstMin / 60)).padStart(2, '0');
  const mm = String(kstMin % 60).padStart(2, '0');
  const generatedAtTime = hh + ':' + mm;

  const today = _ymdKst(now);
  const isHoliday = _isHolidayKst(today.yyyymmdd, today.weekday);
  const previousTradingDate = isHoliday ? _previousTradingDateKst(now) : null;

  let status;
  let forcedNote = null;
  if (forced) {
    status = forced;
    forcedNote = `테스트용 --force-status=${forced} 적용 (실제 시각 ${generatedAtTime})`;
  } else if (isHoliday) status = 'holiday_closed';
  else if (kstMin >= 9 * 60 && kstMin < 15 * 60 + 35) status = 'intraday';
  else if (kstMin >= 15 * 60 + 35 && kstMin < 16 * 60)   status = 'closed';
  else                                                     status = 'final_closed';

  const isMarketClosed = (status === 'closed' || status === 'final_closed' || status === 'holiday_closed');
  const LABELS = {
    intraday:       '아직 장중',
    closed:         '장마감 후',
    final_closed:   '최종 결과 확인 가능',
    holiday_closed: '휴장일',
  };
  const GUIDES = {
    intraday:       '아직 장중입니다. 현재 후보는 장중 기준 후보이며, 당일 고가/종가 기준 최종 결과는 장마감 후 표시됩니다.',
    closed:         '장마감 후입니다. 오늘 1DS 후보의 당일 고가/종가 기준 결과를 집계했습니다.',
    final_closed:   '최종 결과 확인 가능 시간입니다. 오늘 1DS 후보들의 당일 결과를 확인할 수 있습니다.',
    holiday_closed: `오늘은 휴장일입니다 (주말/공휴일/대체공휴일). 직전 거래일${previousTradingDate ? ` (${previousTradingDate})` : ''} 기준 결과를 표시합니다.`,
  };
  return { status, label: LABELS[status], isMarketClosed, generatedAtTime, guide: GUIDES[status], forcedNote, todayDate: today.dashed, todayWeekday: today.weekday, isHoliday, previousTradingDate };
}

// ─────────────────────────────────────────────────────────────────
// 결과 계산용 차트 캐시 (기존 board의 메모리 차트와 별도. read-only 메모이즈)
// ─────────────────────────────────────────────────────────────────
const { filterRowsAsOf } = require('../../src/db/asOfChart');
const _resultChartCache = new Map();
function loadResultChartRows(code) {
  if (_resultChartCache.has(code)) return _resultChartCache.get(code);
  const p = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(p)) { _resultChartCache.set(code, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const rows = Array.isArray(j.rows) ? filterRowsAsOf(j.rows) : null;
    _resultChartCache.set(code, rows);
    return rows;
  } catch (_) { _resultChartCache.set(code, null); return null; }
}

// 한 후보의 당일 결과 계산. basePrice 기준 일봉 high/close/low.
//   - targetDateYYYYMMDD: 후보가 활동한 거래일 (entryConfirmDate 또는 baseDate)
//   - basePrice: 진입 기준가 (1DS는 09:30 close, attackTop은 decisionPrice)
// 반환:
//   - row 못 찾으면 { available: false, reason }
//   - 가격 sanity 어긋나면 { available: false, reason: 'price_mismatch' }
function calculateCandidateDayResult(code, basePrice, targetDateYYYYMMDD) {
  if (!code || !targetDateYYYYMMDD || !(basePrice > 0)) {
    return { available: false, reason: !code ? 'no_code' : !targetDateYYYYMMDD ? 'no_target_date' : 'no_base_price' };
  }
  const rows = loadResultChartRows(code);
  if (!rows) return { available: false, reason: 'no_chart' };
  const row = rows.find((r) => r && r.date === targetDateYYYYMMDD);
  if (!row) return { available: false, reason: 'no_row_for_date' };
  const dayHigh  = Number.isFinite(row.high)  ? row.high  : null;
  const dayClose = Number.isFinite(row.close) ? row.close : null;
  const dayLow   = Number.isFinite(row.low)   ? row.low   : null;
  const dayOpen  = Number.isFinite(row.open)  ? row.open  : null;
  if (!(dayHigh > 0) || !(dayClose > 0) || !(dayLow > 0)) {
    return { available: false, reason: 'invalid_ohlc' };
  }
  // 가격 sanity guard: basePrice vs dayOpen 1.5배 이상 차이 시 차트 오염 의심
  if (dayOpen && basePrice && (dayOpen / basePrice > 1.5 || dayOpen / basePrice < 0.67)) {
    return { available: false, reason: 'price_mismatch' };
  }
  const dayHighReturn  = Number(((dayHigh  / basePrice - 1) * 100).toFixed(2));
  const dayCloseReturn = Number(((dayClose / basePrice - 1) * 100).toFixed(2));
  const dayLowReturn   = Number(((dayLow   / basePrice - 1) * 100).toFixed(2));
  const highCloseDrop  = Number(((dayClose / dayHigh   - 1) * 100).toFixed(2));
  const reached3  = dayHighReturn >= 3;
  const reached5  = dayHighReturn >= 5;
  const reached10 = dayHighReturn >= 10;
  const reached15 = dayHighReturn >= 15;
  const reached20 = dayHighReturn >= 20;
  const reached25 = dayHighReturn >= 25;
  const closeStrong = dayCloseReturn >= 5;
  const closeStrongPlus = dayCloseReturn >= 10;
  const spikeFade = (dayHighReturn >= 5 && dayCloseReturn < 1) || highCloseDrop <= -7;
  const failedSpike = dayHighReturn < 3 && dayLowReturn <= -3;
  return {
    available: true,
    basePrice, dayOpen, dayHigh, dayClose, dayLow,
    dayHighReturn, dayCloseReturn, dayLowReturn, highCloseDrop,
    reached3, reached5, reached10, reached15, reached20, reached25,
    closeStrong, closeStrongPlus, spikeFade, failedSpike,
  };
}

// 분봉에서 당일 고점/저점 시각 추출 (mainResult 표시용)
function getPeakTroughTime(code, dateStr) {
  const fp = path.join(INTRADAY_BASE, dateStr, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const bars = d.bars || [];
    if (!bars.length) return null;
    let pk = bars[0], tr = bars[0];
    for (const b of bars) {
      if (b.high > pk.high) pk = b;
      if (b.low < tr.low) tr = b;
    }
    return { peakTime: pk.time || null, troughTime: tr.time || null };
  } catch (_) { return null; }
}

// 분봉에서 09:00~10:00 윈도우 안의 OHLC를 추출 (10시 시점 결과 표시용)
// dateStr: YYYY-MM-DD, basePrice: 09:30 진입가
// returns: { bars, high/highTime, low/lowTime, close(10:00 마지막 분봉)/closeTime, *Return: basePrice 대비 % }
function getEarlyResultFromIntraday(code, dateStr, basePrice) {
  if (!(basePrice > 0)) return null;
  const fp = path.join(INTRADAY_BASE, dateStr, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const bars = (d.bars || []).filter((b) => b && b.time && b.time <= '10:00' && Number.isFinite(b.close));
    if (bars.length === 0) return null;
    let pk = bars[0], tr = bars[0];
    for (const b of bars) {
      if (Number.isFinite(b.high) && b.high > pk.high) pk = b;
      if (Number.isFinite(b.low)  && b.low  < tr.low)  tr = b;
    }
    const closeBar = bars[bars.length - 1];
    return {
      bars: bars.length,
      high: pk.high, highTime: pk.time,
      low: tr.low,  lowTime: tr.time,
      close: closeBar.close, closeTime: closeBar.time,
      highReturn:  +((pk.high     / basePrice - 1) * 100).toFixed(2),
      lowReturn:   +((tr.low      / basePrice - 1) * 100).toFixed(2),
      closeReturn: +((closeBar.close / basePrice - 1) * 100).toFixed(2),
    };
  } catch (_) { return null; }
}

// 결과 태그 (성공 + 주의)
function assignResultTags(r) {
  if (!r || !r.available) return { tags: [], label: '결과 미확정', comment: '장중 결과는 아직 확정되지 않았습니다.' };
  const tags = [];
  // 성공 (높은 도달 우선)
  if (r.reached25)        tags.push('상한가 근처');
  if (r.reached20)        tags.push('BIG20 성공');
  if (r.reached15)        tags.push('BIG15 성공');
  if (r.reached10)        tags.push('BIG10 성공');
  if (r.reached5)         tags.push('BIG5 성공');
  if (r.closeStrongPlus)  tags.push('강한 종가');
  else if (r.closeStrong) tags.push('종가 유지');
  // 주의
  if (r.highCloseDrop != null && r.highCloseDrop <= -7) tags.push('고가 대비 밀림');
  if (r.dayHighReturn >= 10 && r.dayCloseReturn < 3)    tags.push('장중만 강함');
  if (r.dayCloseReturn < 0)                              tags.push('종가 약함');
  if (r.failedSpike)                                     tags.push('실패');
  if (r.dayLowReturn != null && r.dayLowReturn <= -3)   tags.push('-3% 구간 발생');

  // resultLabel — 가장 강한 신호 우선
  let label = '결과 평이';
  if (r.reached20)       label = 'BIG20 성공';
  else if (r.reached15)  label = 'BIG15 성공';
  else if (r.reached10)  label = 'BIG10 성공';
  else if (r.reached5)   label = 'BIG5 성공';
  else if (r.closeStrong) label = '종가 유지';
  else if (r.dayHighReturn >= 10 && r.dayCloseReturn < 3) label = '장중 상승 후 밀림';
  else if (r.failedSpike) label = '실패';
  else if (r.dayCloseReturn < 0 && r.dayHighReturn < 5) label = '약세';

  // resultComment
  let comment;
  if (r.reached15 && r.closeStrong) comment = `당일 고가 +${r.dayHighReturn}%로 BIG15 이상 도달, 종가도 +${r.dayCloseReturn}%로 양호하게 유지했습니다.`;
  else if (r.reached15) comment = `당일 고가 +${r.dayHighReturn}%로 BIG15 이상 도달했으나, 종가는 ${r.dayCloseReturn > 0 ? '+' : ''}${r.dayCloseReturn}%로 ${r.dayCloseReturn < 3 ? '많이 밀렸습니다' : '유지됐습니다'}.`;
  else if (r.reached10) comment = `당일 고가 +${r.dayHighReturn}%로 BIG10 도달. 종가 ${r.dayCloseReturn > 0 ? '+' : ''}${r.dayCloseReturn}%${r.highCloseDrop <= -7 ? ' (고가 대비 크게 밀림)' : ''}.`;
  else if (r.reached5)  comment = `당일 고가 +${r.dayHighReturn}%로 BIG5 도달. 종가 ${r.dayCloseReturn > 0 ? '+' : ''}${r.dayCloseReturn}%.`;
  else if (r.failedSpike) comment = `당일 고가 +${r.dayHighReturn}%로 약했고 -3% 이탈도 발생했습니다.`;
  else if (r.dayCloseReturn < 0) comment = `당일 고가 +${r.dayHighReturn}%, 종가는 음전됐습니다 (${r.dayCloseReturn}%).`;
  else comment = `당일 고가 +${r.dayHighReturn}%, 종가 ${r.dayCloseReturn > 0 ? '+' : ''}${r.dayCloseReturn}%.`;

  return { tags, label, comment };
}

// 09:30 실시간 스캐너 결과 로드 (없으면 null) — 전일 후보와 무관한 09:30 포착 결과.
function loadScanner0930() {
  if (!fs.existsSync(SCANNER_0930_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(SCANNER_0930_PATH, 'utf-8')); }
  catch (_) { return null; }
}

// 사용자가 외부 분석으로 정한 매수·매도 가이드를 카드에 띄우기 위한 파일.
// `data/manual-1ds-targets.json` (없거나 파싱 실패하면 무시).
function loadManualTargets() {
  if (!fs.existsSync(MANUAL_TARGETS_PATH)) return new Map();
  try {
    const j = JSON.parse(fs.readFileSync(MANUAL_TARGETS_PATH, 'utf-8'));
    const map = new Map();
    for (const t of (j.targets || [])) {
      if (t && t.code) map.set(String(t.code), t);
    }
    return map;
  } catch (e) {
    console.warn('[manual-targets] 파일 파싱 실패:', e.message);
    return new Map();
  }
}

// ── 장초 분봉 재상승 전략 정의 ── (운영자 친화 한국어 라벨)
// 내부 키는 유지 (분석 보고서 호환), 화면 chipLabel만 친절 한국어로.
const ENTRY_STRATEGY_DEFS = {
  SAFE_REBREAK: {
    label: '장초 재상승 확인',
    chipLabel: '장초 재상승 ✓',
    desc: '장초 첫 고점을 다시 넘겼고, 전일 고점 돌파 과열은 아직 없는 흐름.',
    filter: (it) => (it.gtGroup === 'BALANCED-GT' || it.gtGroup === 'LIGHT-GT')
                 && it.intraday?.rebreakMorningHigh_10_30 === true
                 && it.intraday?.rebreakPrevHighBy0930 === false,
    isTopShelf: true,
  },
  BALANCED_REBREAK: {
    label: '수급 균형 + 장초 재상승',
    chipLabel: '균형 재상승 ✓',
    desc: '시총·수급 균형이 좋은 후보가 장초 첫 고점을 다시 넘긴 상태.',
    filter: (it) => it.gtGroup === 'BALANCED-GT' && it.intraday?.rebreakMorningHigh_10_30 === true,
    isTopShelf: true,
  },
  CLEAN_REBREAK: {
    label: '무리 없는 장초 재상승',
    chipLabel: '깨끗한 재상승 ✓',
    desc: '장초 첫 고점을 다시 넘겼지만 전일 고점 돌파 과열은 아직 없는 흐름.',
    filter: (it) => it.intraday?.rebreakMorningHigh_10_30 === true && it.intraday?.rebreakPrevHighBy0930 === false,
    isTopShelf: true,
  },
  LIGHT_REBREAK: {
    label: '가벼운 종목의 장초 재상승',
    chipLabel: '가벼운 재상승 ✓',
    desc: '가볍게 움직일 수 있는 후보가 장초 첫 고점을 다시 넘긴 상태.',
    filter: (it) => it.gtGroup === 'LIGHT-GT' && it.intraday?.rebreakMorningHigh_10_30 === true,
    isTopShelf: true,
  },
  // RISK / SPIKE는 운영 보드에서 hard 필터 제외 — 화면 노출 X. 내부 분류용으로만 유지.
  RISK_REBREAK: {
    label: '위험형 재상승 (보드 제외)',
    chipLabel: '위험 재상승',
    desc: '위험 그룹의 장초 재상승 — 보드에서 제외됨.',
    filter: (it) => (it.gtGroup === 'MOM-RISK' || it.candleType === 'GAP_HOLD')
                 && it.intraday?.rebreakMorningHigh_10_30 === true,
    isTopShelf: false,
  },
  PREV_HIGH_SPIKE: {
    label: '전일고가 돌파 spike (보드 제외)',
    chipLabel: 'spike',
    desc: '전일 고점 돌파 spike — 보드에서 제외됨.',
    filter: (it) => it.intraday?.rebreakPrevHighBy0930 === true,
    isTopShelf: false,
  },
};

// 그룹 라벨도 운영자 친화 한국어로 override (core.GT_GROUP_LABEL은 다른 보드 호환을 위해 그대로 둠).
const FRIENDLY_GROUP_LABELS = {
  'BALANCED-GT': '🟢 수급 균형 후보 (3,000억~7,000억)',
  'LIGHT-GT':    '🔵 가볍게 움직일 후보 (1,000억~3,000억)',
  'MID-CAP-GT':  '🟣 중형 수급 후보 (7,000억~1.5조)',
  // 위험 그룹은 보드에 노출되지 않지만 카드 fallback 대비
  'MOM-RISK':    '🟠 위험형 (보드 제외)',
  'HEAVY-WATCH': '⚪ 저탄력 (보드 제외)',
  'MICRO-RISK':  '🟡 초경량 위험 (보드 제외)',
  'HEAVY-RISK':  '🔴 대형 (보드 제외)',
};
// TOP shelf 정렬 우선순위 (낮을수록 위)
const STRATEGY_PRIORITY = { SAFE_REBREAK: 0, BALANCED_REBREAK: 1, CLEAN_REBREAK: 2, LIGHT_REBREAK: 3 };
const ENTRY_TOP_STRATEGIES = ['SAFE_REBREAK', 'BALANCED_REBREAK', 'CLEAN_REBREAK', 'LIGHT_REBREAK'];
const ENTRY_BOTTOM_STRATEGIES = ['RISK_REBREAK', 'PREV_HIGH_SPIKE'];

// 그룹별 정렬·보관 상한 (cap된 후 JSON에 들어가는 최대치 — 메인 노출 ≠ 보관 cap)
const GT_CAP = {
  'BALANCED-GT': 80,
  'LIGHT-GT':    80,
  'MID-CAP-GT':  30,
  'MOM-RISK':    60,
  'HEAVY-WATCH': 40,
  'MICRO-RISK':  40,
  'HEAVY-RISK':  30,
};

const GT_GROUP_ORDER = ['BALANCED-GT', 'LIGHT-GT', 'MID-CAP-GT', 'MOM-RISK', 'HEAVY-WATCH', 'MICRO-RISK', 'HEAVY-RISK'];

// 화면 노출 정책 — 1DS 보드는 "내일 장초에 실제로 볼 추천 후보만" 노출.
// 위험 후보(MOM-RISK / GAP_HOLD / SPIKE / RISK_REBREAK / peakBefore / 저탄력 그룹)는 내부 필터로 제외.
// 위험 분석은 연구 보고서(entry-confirm / daily-backtest)에서만 유지 — 보드는 깔끔하게.
// UNCLASSIFIED는 결코 노출하지 않음 (이미 grouped에 들어가지 않음).
const MAIN_POOL_GROUPS = ['BALANCED-GT', 'LIGHT-GT', 'MID-CAP-GT'];
const TOP_PRIORITY_LIMIT   = 5;   // 최우선 노출 (기본 펼침)
const EXTRA_PRIORITY_LIMIT = 10;  // 추가 후보 노출 (접힘, 최대)

// 추천 후보에서 hard 제외할 위험 패턴 — passesRiskFilter()
// (penalty가 아니라 완전 제외. 위험 분석은 연구 보고서에서만 한다.)
//
// 면제 규칙: 09:10~30 morningHigh 재돌파(rebreakMorningHigh_10_30 ✓) 한 후보는
//   prev_high_spike / peak_before_entry 위험을 면제한다.
//   - "전일 고가 돌파 spike + 첫 10분 고점 재돌파" = 강한 한입 패턴
//   - "9:10에 한번 빠졌다가 첫 10분 고점 재돌파" = 회복 흐름
//   둘 다 단독 spike/peakBefore와는 완전히 다른 패턴이지만 기존 필터는 단독 조건만 보고 자동 제외했음.
//   사용자 단타 성공 실증 데이터 기반으로 morningHigh 재돌파 ✓ 면제 추가.
function passesRiskFilter(it) {
  // 1) 그룹이 추천 풀(BAL/LIGHT/MID-CAP) 아니면 제외
  if (!MAIN_POOL_GROUPS.includes(it.gtGroup)) return { ok: false, reason: 'group_off_pool' };
  // 2) GAP_HOLD 캔들 — 갭상승 후 종가 유지형, TRAP 위험. 백테스트에서 fail5 69%. (면제 X)
  if (it.candleType === 'GAP_HOLD') return { ok: false, reason: 'gap_hold_candle' };
  // 3) trap 위험 (윗꼬리 + 5d 과열) ≥ 60 — 일봉 기반, morningHigh와 무관 (면제 X)
  if (calcRiskTrapScore(it) >= 60) return { ok: false, reason: 'trap_risk_high' };
  // 4) RISK_REBREAK — MOM-RISK 그룹 morningHigh, 그룹 자체가 위험 (면제 X — 그룹이 위험 그룹)
  const tags = it.entryStrategies || [];
  if (tags.includes('RISK_REBREAK')) return { ok: false, reason: 'risk_rebreak' };

  // 5) 분봉 부족 — 분봉이 들어왔지만 봉 개수가 MIN_BARS_FOR_JUDGMENT 미만이면 mainPool 제외.
  //    KIS API가 거래량 없는 분봉을 응답에서 빼는 저유동성 종목 (예: 142210 유니트론텍).
  //    하루 거래대금 폭증으로 LIGHT-GT 자격을 따도 평소 유동성이 부족해 단타 진입 자체가
  //    불가능하므로 보드에서 빼는 게 맞다. 분봉 미수신(NO_MINUTE_DATA)은 컷 안 함 — 그건
  //    "아직 안 들어옴"이지 "받았는데 부족"이 아니므로 다음 cron 때 받을 수 있음.
  if (it.intraday
      && Number.isFinite(it.intraday.bars_total)
      && it.intraday.bars_total < tradePlanModule.MIN_BARS_FOR_JUDGMENT) {
    return { ok: false, reason: 'insufficient_bars' };
  }

  // 6) prev_high_spike / peak_before_entry — morningHigh 재돌파 ✓이면 면제
  const morningRebreak = it.intraday && it.intraday.rebreakMorningHigh_10_30 === true;
  if (tags.includes('PREV_HIGH_SPIKE')) {
    if (!morningRebreak) return { ok: false, reason: 'prev_high_spike' };
    it.riskExempted = (it.riskExempted || []).concat(['prev_high_spike']);
  }
  if (it.intraday && it.intraday.peakBeforeEntryLive === true) {
    if (!morningRebreak) return { ok: false, reason: 'peak_before_entry' };
    it.riskExempted = (it.riskExempted || []).concat(['peak_before_entry']);
  }
  return { ok: true, reason: null };
}

// ── 외부 데이터 lookup: 백테스트 dayType ──
const DAILY_BACKTEST_PATH = path.join(REPORTS_DIR, 'one-day-surge-entry-daily-backtest-result.json');
function loadLatestDayType() {
  if (!fs.existsSync(DAILY_BACKTEST_PATH)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(DAILY_BACKTEST_PATH, 'utf-8'));
    const lt = j.autoConclusion?.latestDayType;
    if (!lt) return null;
    const labels = j.dayTypeAnalysis?.labels || {};
    const descs  = j.dayTypeAnalysis?.descriptions || {};
    return {
      date: lt.date, nextDate: lt.nextDate, dayType: lt.dayType,
      label: labels[lt.dayType] || lt.dayType,
      desc:  descs[lt.dayType] || '',
      hit5: lt.hit5, closePos: lt.closePos, avgClose: lt.avgClose, eventCount: lt.eventCount,
      // backtest dayType 분포 (참고)
      distribution: j.dayTypeAnalysis?.counts || null,
      generatedAt: j.meta?.generatedAt || null,
    };
  } catch (_) { return null; }
}

// ── 외부 데이터 lookup: 시장 상태 (KOSPI/KOSDAQ daily) ──
// 코스피만 보지 말고 코스닥 괴리 + 대형주 쏠림 여부를 함께 해석한다.
// 데이터 없으면 state='UNKNOWN' + label="시장 상태 데이터 미연결" — 함수 구조만 유지.
const KOSPI_DAILY_PATH  = path.join(ROOT, 'cache', 'kospi-daily.json');
const KOSDAQ_DAILY_PATH = path.join(ROOT, 'cache', 'kosdaq-daily.json');
const MARKET_STATE_LIVE_PATH = path.join(ROOT, 'cache', 'market-state-live.json');
// 라이브 파일 신선도 기준 — 35분 (cron 주기 30분 + 5분 마진).
// 그보다 오래된 파일은 신뢰하지 않고 daily fallback.
const MARKET_STATE_LIVE_MAX_AGE_MS = 35 * 60 * 1000;
function loadIndexLatestChange(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const rows = Array.isArray(j) ? j : (j.rows || j.data || []);
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const lastClose = Number(last.close ?? last.cls ?? last.value);
    const prevClose = Number(prev.close ?? prev.cls ?? prev.value);
    if (!Number.isFinite(lastClose) || !Number.isFinite(prevClose) || prevClose <= 0) return null;
    return { date: last.date || last.dt || null, close: lastClose, changeRate: (lastClose / prevClose - 1) * 100 };
  } catch (_) { return null; }
}
const MARKET_STATE_LABELS = {
  BROAD_MARKET_UP: '🟢 코스피·코스닥 동반 상승 (1DS 우호)',
  LARGE_CAP_LED:   '🟡 대형주 쏠림장 (1DS 친화 X)',
  KOSDAQ_WEAK:     '🟠 코스닥 약세 (단타 후보 종가 유지 약화 가능)',
  WEAK_MARKET:     '🔴 코스피·코스닥 동반 하락',
  MIXED_MARKET:    '⚪ 혼합 (편차 큼)',
  UNKNOWN:         '◯ 시장 상태 데이터 미연결',
};
const MARKET_STATE_DESCS = {
  BROAD_MARKET_UP: '지수 동반 상승 + 중소형 우호. 1DS 후보의 종가 유지에도 도움.',
  LARGE_CAP_LED:   '지수는 강하지만 1DS 친화 장은 아닐 수 있습니다. 코스닥/중소형주 흐름이 약하면 장중 고점 후 빠지는 후보가 늘어날 수 있습니다.',
  KOSDAQ_WEAK:     '코스닥 약세 — 1DS 후보 다수가 코스닥 종목이라 종가 유지가 약해질 수 있음. 짧은 대응 우선.',
  WEAK_MARKET:     '시장 전체 약세 — 매매 자체를 줄이는 것이 적절.',
  MIXED_MARKET:    '지수 방향 혼재 — 종목별 편차 큼. 카드별 판단.',
  UNKNOWN:         'cache/kospi-daily.json / cache/kosdaq-daily.json 미존재 또는 read 실패. 함수 구조만 유지.',
};
// 라이브 파일 우선 — 35분 이내 갱신된 cache/market-state-live.json이 있으면 사용.
// 그 외엔 daily 파일 (전일 종가 vs 그 전일 종가) fallback. 라이브가 'OPEN' 마켓 상태로
// 갱신된 거라면 장중 흐름 반영, 그 외엔 daily 변화율로 폴백.
function classifyMarketState() {
  // 1) 라이브 파일 우선
  if (fs.existsSync(MARKET_STATE_LIVE_PATH)) {
    try {
      const live = JSON.parse(fs.readFileSync(MARKET_STATE_LIVE_PATH, 'utf-8'));
      const updatedAt = live.updatedAt ? new Date(live.updatedAt).getTime() : 0;
      const ageMs = Date.now() - updatedAt;
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= MARKET_STATE_LIVE_MAX_AGE_MS && live.state) {
        return { ...live, source: 'live', ageMinutes: Math.round(ageMs / 60000) };
      }
    } catch (_) { /* fallthrough to daily */ }
  }
  // 2) daily fallback
  const kospi = loadIndexLatestChange(KOSPI_DAILY_PATH);
  const kosdaq = loadIndexLatestChange(KOSDAQ_DAILY_PATH);
  if (!kospi && !kosdaq) {
    return { state: 'UNKNOWN', label: MARKET_STATE_LABELS.UNKNOWN, desc: MARKET_STATE_DESCS.UNKNOWN, kospi: null, kosdaq: null, source: 'daily' };
  }
  const kr = kospi?.changeRate;
  const dr = kosdaq?.changeRate;
  let state;
  if (kr != null && dr != null) {
    if (kr > 0.3 && dr > 0.3) state = 'BROAD_MARKET_UP';
    else if (kr > 0.3 && dr < -0.5) state = 'LARGE_CAP_LED';
    else if (dr <= -1) state = 'KOSDAQ_WEAK';
    else if (kr < -0.5 && dr < -0.5) state = 'WEAK_MARKET';
    else state = 'MIXED_MARKET';
  } else state = 'MIXED_MARKET';
  return {
    state,
    label: MARKET_STATE_LABELS[state],
    desc:  MARKET_STATE_DESCS[state],
    kospi, kosdaq,
    source: 'daily',
  };
}

// trap 위험도 — 윗꼬리 비중(%) + 5일 과열 초과분(%). 60↑ 이면 진입 후 흔들림 큼.
function calcRiskTrapScore(it) {
  const tail = (it.upperTailRatio || 0) * 100;          // 윗꼬리 50%면 50
  const overheat = Math.max(0, (it.ret5d || 0) - 30);   // 5일 +50%면 +20
  return tail + overheat;
}

// 화면 우선순위 점수 — 후보 선정 점수(oneDaySurgeScore)와 별개. 노출 ranking 전용.
// ENTRY_DAILY_BACKTEST 결과 반영 (40일):
//   - BALANCED_REBREAK가 HIT_AND_FADE_DAY/MIXED_DAY에서 SAFE보다 강함 → BAL +85 / SAFE +75
//   - peakBeforeEntry=true는 매우 강한 추격 위험 (avgClose -3.14% vs +2.59%) → -60 강한 감점
function calcDisplayPriorityScore(it) {
  let score = 0;
  // ── 가점: 그룹 품질
  if (it.gtGroup === 'BALANCED-GT') score += 40;
  else if (it.gtGroup === 'LIGHT-GT') score += 30;
  else if (it.gtGroup === 'MID-CAP-GT') score += 25;
  // ── 가점: 수급 강도
  const vmc = it.valueToMarketCapRatio || 0;
  if (vmc >= 10) score += 20;
  else if (vmc >= 5) score += 10;
  // ── 가점: 거래대금 시장 순위
  const rank = it.dailyValueRank || 9999;
  if (rank <= 10) score += 15;
  else if (rank <= 30) score += 10;
  // ── 가점: 과열 회피 + sweet zone
  if (it.recent5Up15Count != null && it.recent5Up15Count <= 1) score += 10;
  if (it.changeRate != null && it.changeRate >= 5 && it.changeRate <= 25) score += 10;
  // ── 가점: 장초 분봉 ENTRY_CONFIRM 통과 (최대 1개만 적용 — BAL > SAFE > CLEAN > LIGHT)
  // [ENTRY_DAILY_BACKTEST] HIT_AND_FADE_DAY에서 SAFE +0.16% vs BAL +3.33%, MIXED_DAY 마찬가지로 BAL 우세
  const tags = it.entryStrategies || [];
  if (tags.includes('BALANCED_REBREAK'))   score += 85;
  else if (tags.includes('SAFE_REBREAK'))  score += 75;
  else if (tags.includes('CLEAN_REBREAK')) score += 60;
  else if (tags.includes('LIGHT_REBREAK')) score += 50;
  // ── 감점: 그룹 위험도
  if (it.gtGroup === 'MOM-RISK') score -= 30;
  if (it.candleType === 'GAP_HOLD') score -= 30;
  if (it.gtGroup === 'MICRO-RISK') score -= 40;
  if (it.gtGroup === 'HEAVY-RISK') score -= 40;
  if (it.gtGroup === 'HEAVY-WATCH') score -= 20;
  // ── 감점: 분봉 위험 태그
  if (tags.includes('PREV_HIGH_SPIKE')) score -= 40;
  if (tags.includes('RISK_REBREAK')) score -= 50;
  // ── 감점: peakBeforeEntry 라이브 proxy (09:10 진입 시점에 이미 09:00~09:10 max 후)
  // 백테스트 검증: peakBefore=true 후보는 종가>0 17.9% (vs 정상 66.6%), avgClose -3.14% (vs +2.59%) — 강한 추격 위험
  if (it.intraday?.peakBeforeEntryLive === true) score -= 60;
  // ── 감점: trap 위험
  const trap = calcRiskTrapScore(it);
  if (trap >= 60) score -= 50;
  else if (trap >= 40) score -= 30;
  // ── 감점: 시총 무거움
  if (it.marketCap >= 1.5e12) score -= 20;
  // 시총 5조 이상은 passesHardFilter에서 이미 제외됨
  return score;
}

function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}

// ── meta map ──
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

// ── QVA / VVI 이력 lookup ──
// qvaSignalMap (신규): code → { signalDate (YYYYMMDD, 가장 최근), stage, label }
// 같은 코드가 여러 stage에 있으면 가장 최근(=큰 YYYYMMDD) 신호 선택.
// 정식 추적 stages는 qvaSignalDate, EARLY 계열은 latestEarlyQvaDate/bestEarlyQvaDate/firstEarlyQvaDate를 fallback.
function extractQvaDate(it) {
  return it.qvaSignalDate || it.latestEarlyQvaDate || it.bestEarlyQvaDate || it.firstEarlyQvaDate || null;
}
function loadHistoryLookups() {
  const qvaCodes = new Map();
  const qvaSignalMap = new Map();
  const vviCodes = new Map();
  if (fs.existsSync(QVA_BOARD_PATH)) {
    try {
      const b = JSON.parse(fs.readFileSync(QVA_BOARD_PATH, 'utf-8'));
      const stages = b.stages || {};
      const order = [
        ['BREAKOUT_SUCCESS', 'H그룹 출신'], ['VVI_FIRED', 'VVI 발생'],
        ['QVA_TODAY', '오늘 QVA'], ['QVA_NEW', 'QVA 신규(D+0)'],
        ['QVA_TRACKING', 'QVA 추적'], ['EARLY_QVA', 'EARLY QVA'],
        ['LONG_QVA_REACTIVE', '장기 QVA 재점화'], ['LONG_QVA_INTEREST', '장기 QVA'],
        ['LONG_QVA_BREAKOUT_DONE', '장기 QVA 돌파'],
      ];
      for (const [stage, label] of order) {
        for (const it of (stages[stage] || [])) {
          if (!it.code) continue;
          if (!qvaCodes.has(it.code)) qvaCodes.set(it.code, label);
          const sd = extractQvaDate(it);
          if (sd) {
            const cur = qvaSignalMap.get(it.code);
            if (!cur || sd > cur.signalDate) {
              qvaSignalMap.set(it.code, { signalDate: sd, stage, label });
            }
          }
        }
      }
      for (const it of (b.recentVviHistory || [])) {
        if (it.code && !vviCodes.has(it.code)) {
          vviCodes.set(it.code, { signalDate: it.signalDate, daysAfterSignal: it.daysAfterSignal, vviStatus: it.vviStatus });
        }
      }
    } catch (_) {}
  }
  if (fs.existsSync(PATTERN_RESULT_PATH)) {
    try {
      const p = JSON.parse(fs.readFileSync(PATTERN_RESULT_PATH, 'utf-8'));
      for (const it of (p.vviRecentSignals || [])) {
        if (it.code && !vviCodes.has(it.code)) {
          vviCodes.set(it.code, { signalDate: it.signalDate, daysAfterSignal: it.daysAfterSignal, vviStatus: it.vviStatus });
        }
      }
    } catch (_) {}
  }
  return { qvaCodes, qvaSignalMap, vviCodes };
}

// ── QVA 보조 태그 (이전 수급 흔적) ──
// 1DS 후보 baseDate 기준 최근 1~20 거래일 안에 QVA 신호가 있었는지 확인. display only — 점수 영향 X.
// 거래일 차이는 calendar days × 5/7 근사 (정확한 거래일 캘린더 없이 충분).
function tradingDaysBetween(d1Str, d2Str) {
  if (!d1Str || !d2Str || d1Str.length !== 8 || d2Str.length !== 8) return null;
  const a = new Date(Number(d1Str.slice(0,4)), Number(d1Str.slice(4,6))-1, Number(d1Str.slice(6,8)));
  const b = new Date(Number(d2Str.slice(0,4)), Number(d2Str.slice(4,6))-1, Number(d2Str.slice(6,8)));
  const calendarDays = Math.round((b - a) / (1000*60*60*24));
  // 7 calendar days ≈ 5 trading days. 7→5, 14→10, 21→15, 28→20.
  return Math.round(calendarDays * 5 / 7);
}
function classifyQvaWindow(daysAgo) {
  if (daysAgo < 1 || daysAgo > 20) return null;
  if (daysAgo <= 3)  return { label: '단기',       desc: '최근 며칠 안에 QVA 신호가 있었지만 급등 직전이라 의미가 약할 수 있습니다.' };
  if (daysAgo <= 7)  return { label: '1주일 이내', desc: '최근 1주일 안에 QVA 신호가 발생했던 후보입니다.' };
  if (daysAgo <= 14) return { label: '1~2주 전',   desc: '1~2주 전 QVA 신호가 발생했던 후보입니다.' };
  return                   { label: '2~3주 전',   desc: '2~3주 전 QVA 신호가 발생했던 후보입니다.' };
}
// ── 후보 유형별 과거 검증 성과 (40 거래일 운영형 백테스트 결과) ──
// 카드에 작은 박스로 노출 — 사용자가 후보 유형 성격을 즉시 이해할 수 있게 함.
// 4 안전 전략에만 적용. 위험 전략은 보드 미노출이라 매핑 X. 분봉 미반영은 pending 안내.
const PERFORMANCE_STATS = {
  BALANCED_REBREAK: { label: '수급 균형 + 장초 재상승',     hit5: 75.3, closePos: 67.5, avgClose: 3.55, fail5: 39.0 },
  SAFE_REBREAK:     { label: '장초 재상승 확인',             hit5: 57.5, closePos: 62.2, avgClose: 1.99, fail5: 24.9 },
  CLEAN_REBREAK:    { label: '무리 없는 장초 재상승',        hit5: 57.1, closePos: 61.6, avgClose: 1.95, fail5: 24.7 },
  LIGHT_REBREAK:    { label: '가벼운 종목의 장초 재상승',    hit5: 63.2, closePos: 61.0, avgClose: 1.82, fail5: 32.7 },
};
const PERFORMANCE_DISCLAIMER = '실제 대응은 본인의 판단입니다.';
const PERFORMANCE_SOURCE     = '과거 40거래일 운영형 백테스트';
function classifyPerformance(it) {
  const tags = it.entryStrategies || [];
  // 가장 강한 안전 전략 선택 (BAL > SAFE > CLEAN > LIGHT 순)
  const safeOrder = ['BALANCED_REBREAK', 'SAFE_REBREAK', 'CLEAN_REBREAK', 'LIGHT_REBREAK'];
  for (const k of safeOrder) {
    if (tags.includes(k)) {
      const s = PERFORMANCE_STATS[k];
      return {
        confirmed: true,
        label: s.label,
        stats: {
          intradayHit5Rate:  s.hit5,
          closePositiveRate: s.closePos,
          avgCloseRate:      s.avgClose,
          intradayFail5Rate: s.fail5,
        },
        source: PERFORMANCE_SOURCE,
        disclaimer: PERFORMANCE_DISCLAIMER,
      };
    }
  }
  // 분봉 미반영 또는 안전 전략 미통과 — pending
  return {
    confirmed: false,
    label: null,
    stats: null,
    source: null,
    disclaimer: PERFORMANCE_DISCLAIMER,
    pendingNote: '장초 재상승 확인 후 과거 성과가 표시됩니다.',
  };
}

function attachQvaHistory(candidates, qvaSignalMap) {
  let tagged = 0;
  for (const it of candidates) {
    it.hasRecentQva = false;
    const sig = qvaSignalMap.get(it.code);
    if (!sig || !sig.signalDate) continue;
    if (sig.signalDate > it.baseDate) continue; // 미래 시점 신호는 무시
    const days = tradingDaysBetween(sig.signalDate, it.baseDate);
    if (days == null || days < 1 || days > 20) continue;
    const win = classifyQvaWindow(days);
    if (!win) continue;
    it.hasRecentQva = true;
    it.qvaSignalDate = sig.signalDate;
    it.qvaDaysAgo = days;
    it.qvaWindowLabel = win.label;
    it.qvaWindowDesc = win.desc;
    it.qvaDisplayText = 'QVA · ' + days + '거래일 전';
    tagged++;
  }
  return tagged;
}

// ── 쉬운 말 한 줄 해석 (GT 그룹별) ──
function buildSummaryLine(it) {
  const m = it; // metrics fields are spread on item
  const parts = [];
  if (m.valueRatio >= 5) parts.push(`거래대금이 평소보다 ×${m.valueRatio.toFixed(1)}배 폭증`);
  else if (m.valueRatio >= 3) parts.push(`거래대금이 평소보다 ×${m.valueRatio.toFixed(1)}배 강하게 증가`);
  else if (m.valueRatio >= 2) parts.push(`거래대금이 평소보다 ×${m.valueRatio.toFixed(1)}배 늘었음`);

  if (m.valueToMarketCapRatio != null) {
    if (m.valueToMarketCapRatio >= 20) parts.push(`시총 대비 거래대금 ${m.valueToMarketCapRatio.toFixed(1)}% (회사 크기 대비 매우 강한 수급)`);
    else if (m.valueToMarketCapRatio >= 10) parts.push(`시총 대비 거래대금 ${m.valueToMarketCapRatio.toFixed(1)}% (회사 크기 대비 강한 수급)`);
    else if (m.valueToMarketCapRatio >= 5) parts.push(`시총 대비 거래대금 ${m.valueToMarketCapRatio.toFixed(1)}% (회사 크기에 비해 충분한 수급)`);
  }

  if (m.candleType === 'LOW_GAP_INTRADAY') parts.push('낮은 갭에서 장중 매수세로 끌어올린 캔들 (실전 단타에 유리)');
  else if (m.candleType === 'GAP_HOLD') parts.push('갭상승 후 종가 유지형 (HIT10 높지만 시초가 추격 위험)');
  else if (m.candleType === 'BIG_GREEN') parts.push('장대양봉 마감');
  else if (m.candleType === 'UPPER_WICK_GREEN') parts.push(`윗꼬리 양봉 (윗꼬리 ${(m.upperTailRatio*100).toFixed(0)}%)`);

  if (m.recent5Up15Count === 0) parts.push('최근 5일 첫 급등형');
  else if (m.recent5Up15Count === 1) parts.push('최근 5일 +15% 1회 (sweet spot)');
  else if (m.recent5Up15Count >= 3) parts.push(`최근 5일 +15% ${m.recent5Up15Count}회 (과열 주의)`);

  if (m.dailyValueRank != null && m.dailyValueRank <= 10) parts.push(`거래대금 시장 상위 ${m.dailyValueRank}위`);
  else if (m.dailyValueRank != null && m.dailyValueRank <= 30) parts.push(`거래대금 시장 상위 ${m.dailyValueRank}위`);

  let tail;
  switch (m.gtGroup) {
    case 'BALANCED-GT':
      tail = '균형형 단타 후보. 다음 거래일 장초 시초가가 갭 7% 미만이면 진입 검토.';
      break;
    case 'LIGHT-GT':
      tail = '경량 단타 후보. 다음 거래일 장초 시초가 흐름 확인 후 진입 검토.';
      break;
    case 'MID-CAP-GT':
      tail = '중형 단타 후보. 검증 보고서에서 의외로 강했던 영역 (LOW_GAP_INTRADAY 한정).';
      break;
    case 'MOM-RISK':
      tail = '상한가형(전일 +29%↑). HIT10률은 높지만 시초가 진입자에게 TRAP 위험이 큼 — 추격 금지.';
      break;
    case 'HEAVY-WATCH':
      tail = '준중대형(1.5조~3조). 단타 탄력이 약해 참고로만 봅니다.';
      break;
    case 'MICRO-RISK':
      tail = '초경량(500억~1,000억). 가볍게 튈 수는 있지만 장중 흔들림 큼 — 실전 진입 비추천.';
      break;
    case 'HEAVY-RISK':
      tail = '대형(3조~5조). 단타 탄력이 더 약함 — 보드 하단 배치.';
      break;
    default:
      tail = '';
  }
  return parts.join(', ') + '. ' + tail;
}

// ── 장초 분봉 lookup ──
// data/intraday/1ds/{YYYY-MM-DD}/ 디렉토리들을 스캔. 각 candidate의 baseDate 다음 거래일 분봉이 있으면 사용.
// 보드 cron이 D 장 종료 후(16:35) 실행되면 baseDate=D, D+1 분봉 없음 → 모두 NO_MINUTE_DATA 상태.
// 다음날 09:35+ collect-1ds-intraday 실행 + 보드 재생성하면 D+1 분봉 채워짐 → 전략 태그 활성화.
function loadIntradayDirs() {
  if (!fs.existsSync(INTRADAY_BASE)) return [];
  return fs.readdirSync(INTRADAY_BASE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}
function findNextDayDir(baseDate, intradayDirs) {
  const baseFmt = baseDate.slice(0, 4) + '-' + baseDate.slice(4, 6) + '-' + baseDate.slice(6, 8);
  // 가장 가까운 다음 거래일 디렉토리. 단 baseDate에서 7일 이상 떨어지면 stale로 간주 (보드는 "오늘 뜰 후보" 보드)
  const nextDir = intradayDirs.find((d) => d > baseFmt);
  if (!nextDir) return null;
  const baseMs = new Date(baseFmt + 'T00:00:00Z').getTime();
  const nextMs = new Date(nextDir + 'T00:00:00Z').getTime();
  if ((nextMs - baseMs) > 7 * 24 * 3600 * 1000) return null; // 7일 초과 = 데이터 fresh 매칭 X
  return nextDir;
}
function loadMinuteBars(nextDayDir, code) {
  if (!nextDayDir) return null;
  const fp = path.join(INTRADAY_BASE, nextDayDir, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch (_) { return null; }
}

// 각 candidate에 분봉 ENTRY_CONFIRM 메트릭 + 전략 태그 부착.
function attachIntradayMetrics(candidates) {
  const intradayDirs = loadIntradayDirs();
  let withMinute = 0, missing = 0;
  for (const it of candidates) {
    const nextDayDir = findNextDayDir(it.baseDate, intradayDirs);
    if (!nextDayDir) { it.entryStatus = 'NO_DIR'; missing++; continue; }
    const minuteData = loadMinuteBars(nextDayDir, it.code);
    if (!minuteData) { it.entryStatus = 'NO_MINUTE_DATA'; it.nextDayDir = nextDayDir; missing++; continue; }
    // ENTRY_CONFIRM 보고서와 동일 로직 재사용.
    // computeIntradayMetrics는 eventBase에서 close/high/valueAmount/avg20Value를 사용 — candidate에 모두 있음.
    const im = entryReport.computeIntradayMetrics(it, minuteData);
    if (!im) { it.entryStatus = 'INTRADAY_INVALID'; it.nextDayDir = nextDayDir; continue; }
    // 라이브 proxy: 09:10 close가 09:00~09:10 max보다 1%+ 낮으면 "이미 초반 고점 통과"
    // (백테스트의 peakBeforeEntry는 D+1 일봉 high 비교라 라이브엔 못 씀 — 분봉으로만 추정)
    im.peakBeforeEntryLive = im.preEntryMaxHigh != null && im.entryPrice != null
      && im.preEntryMaxHigh > im.entryPrice * 1.01;
    it.entryStatus = 'OK';
    it.nextDayDir = nextDayDir;
    it.intraday = im;
    it.entryStrategies = classifyEntryStrategies(it);
    withMinute++;
  }
  return { withMinute, missing, intradayDirs };
}

function classifyEntryStrategies(it) {
  const tags = [];
  for (const [name, def] of Object.entries(ENTRY_STRATEGY_DEFS)) {
    if (def.filter(it)) tags.push(name);
  }
  return tags;
}

function isTopShelf(it) {
  return (it.entryStrategies || []).some((s) => ENTRY_TOP_STRATEGIES.includes(s));
}
function isBottomShelf(it) {
  if (isTopShelf(it)) return false; // TOP 우선
  return (it.entryStrategies || []).some((s) => ENTRY_BOTTOM_STRATEGIES.includes(s));
}
function bestStrategyPriority(it) {
  return Math.min(...(it.entryStrategies || []).map((s) => STRATEGY_PRIORITY[s] ?? 99));
}
function topShelfSort(a, b) {
  const aBest = bestStrategyPriority(a);
  const bBest = bestStrategyPriority(b);
  if (aBest !== bBest) return aBest - bBest;
  return (b.valueToMarketCapRatio || 0) - (a.valueToMarketCapRatio || 0);
}

// ─────────────────────────────────────────────────────────────────
// 🔥 공격형 TOP 1DS — BIG RUNNER 감사 보고서 검증 결과 반영 (2026-05-17)
//
// 60일 감사 결과:
//   BASE 1DS: BIG10 7.9%, BIG15 3.5%, BIG20 1.7%, 평균 당일고가 4.01%
//   BIG_MONEY_REBREAK (거래대금 상위 10% + 장초 고가 재돌파):
//     n=541, 일평균 8.87개, BIG10 35.7% (+27.8pp), BIG15 18.1% (+14.7pp),
//     BIG20 8.1% (+6.4pp), 평균 당일고가 9.57%
//   → strong 등급 통과. --days 20과 --days 100 모두에서 Top 1 일관성 확인.
//
// 운영 보드 구현 원칙:
//   - 기존 1DS 후보 산출 로직은 일체 수정하지 않음
//   - lookahead 방지: 실행 시점까지의 분봉만 사용
//   - 매수 확정 신호 아님 — "큰 상승 가능성이 높았던 패턴" 필터
//   - 기존 후보 위에 "공격형 TOP" 섹션만 얹는다
// ─────────────────────────────────────────────────────────────────

// 60일 감사 결과 (HTML 상단 검증 요약에 표시)
const ATTACK_VALIDATION_SNAPSHOT = {
  source: '60일 BIG RUNNER 감사 (2026-02-13 ~ 2026-05-15)',
  base:           { big10: 7.9,  big15: 3.5,  big20: 1.7,  avgDayHigh: 4.01 },
  bigMoneyRebreak:{ n: 541, perDayAvg: 8.87, big10: 35.7, big15: 18.1, big20: 8.1, avgDayHigh: 9.57, minus3First: 13.5 },
  recent20:       { n: 193, big10: 32.1, big15: 14.5, big20: 3.6, avgDayHigh: 8.64, minus3First: 13.5 },
  passLevel: 'strong',
};

// 시간대별 안내 라벨
function attackDecisionMode(decisionTime) {
  if (!decisionTime) return { key: 'unknown', label: '시간대 미상', guide: '시간대 미상 — 분봉 데이터가 없습니다.' };
  if (decisionTime < '09:40')  return { key: 'early',   label: '빠른 확인 구간',     guide: '09:30 전후. 재돌파 여부가 아직 충분히 확인되지 않은 초기 공격 후보입니다.' };
  if (decisionTime < '09:50')  return { key: 'rebreak', label: '재돌파 확인 구간',   guide: '09:45 전후. 09:40~10:00 재돌파 흐름이 막 시작된 구간입니다.' };
  if (decisionTime <= '10:00') return { key: 'top',     label: '공격형 TOP 후보',    guide: '10:00 전후. 09:00~10:00 morning 전체가 보이는 구간. 가장 안정적.' };
  return { key: 'late', label: '상태 확인 구간', guide: '10시 이후. 일부 상승 구간이 지나갔을 수 있어 신규 추격 주의.' };
}

// 분봉 → 거래대금 segment + 재돌파 (lookahead-safe: decisionTime 이하 bar만 사용)
function computeAttackMetricsFromBars(bars, decisionTime) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const upto = bars.filter((b) => b && b.time && b.time <= decisionTime && Number.isFinite(b.close));
  if (upto.length < 5) return null;

  // segments
  function sumIn(min, max, inclusive) {
    let value = 0, volume = 0;
    for (const b of upto) {
      if (b.time < min) continue;
      if (inclusive ? b.time > max : b.time >= max) continue;
      const v = (b.value != null) ? b.value : ((b.close || 0) * (b.volume || 0));
      value += v || 0;
      volume += b.volume || 0;
    }
    return { value, volume };
  }
  function maxHighIn(min, max, inclusive) {
    let mh = -Infinity;
    for (const b of upto) {
      if (b.time < min) continue;
      if (inclusive ? b.time > max : b.time >= max) continue;
      if (Number.isFinite(b.high) && b.high > mh) mh = b.high;
    }
    return mh === -Infinity ? null : mh;
  }
  function firstBarMatch(min, max, predicate) {
    for (const b of upto) {
      if (b.time < min) continue;
      if (b.time > max) break;
      if (predicate(b)) return b;
    }
    return null;
  }

  const s_0900_0930 = sumIn('09:00', '09:30', false);  // [09:00, 09:30)
  const s_0930_0945 = sumIn('09:30', '09:45', false);
  const s_0945_1000 = sumIn('09:45', '10:00', true);   // [09:45, 10:00]
  const s_0930_1000 = sumIn('09:30', '10:00', true);
  const s_0900_1000 = sumIn('09:00', '10:00', true);

  const morningHigh_0_30 = maxHighIn('09:00', '09:30', false);
  const high_0940_now    = maxHighIn('09:40', decisionTime, true);

  const open0900 = upto[0].open != null ? upto[0].open : upto[0].close;
  const lastBar = upto[upto.length - 1];
  const decisionPrice = lastBar.close;
  const highSoFar = Math.max(...upto.map((b) => b.high).filter(Number.isFinite));
  const lowSoFar  = Math.min(...upto.map((b) => b.low ).filter(Number.isFinite));

  // 재돌파: 09:40 이후 분봉 중 09:00~09:30 morningHigh 초과한 첫 bar
  let rebreakTime = null;
  if (morningHigh_0_30 != null && decisionTime >= '09:40') {
    const r = firstBarMatch('09:40', decisionTime, (b) => Number.isFinite(b.high) && b.high > morningHigh_0_30);
    if (r) rebreakTime = r.time;
  }
  const rebreakMorningHigh = rebreakTime != null;

  // 2차 파동 거래대금 비율 — 09:45~현재 / 09:30~09:45
  const valueSecondWaveRatio = (s_0930_0945.value > 0) ? Number((s_0945_1000.value / s_0930_0945.value).toFixed(3)) : null;
  const valueContinueRatio   = (s_0900_0930.value > 0) ? Number((s_0930_1000.value / s_0900_0930.value).toFixed(3)) : null;
  const rebreakWithValue = rebreakMorningHigh && valueSecondWaveRatio != null && valueSecondWaveRatio >= 1.0;

  const morningRangeRate = (highSoFar > 0 && lowSoFar > 0) ? Number(((highSoFar / lowSoFar - 1) * 100).toFixed(2)) : null;

  return {
    decisionTime: lastBar.time,
    decisionPrice,
    open0900,
    morningHigh_0_30, high_0940_now,
    highSoFar, lowSoFar,
    morningRangeRate,
    morningValue: s_0900_1000.value,
    morningVolume: s_0900_1000.volume,
    rebreakMorningHigh, rebreakTime, rebreakWithValue,
    valueContinueRatio, valueSecondWaveRatio,
  };
}

// 공격형 태그 + 위험 태그
function assignAttackTags(m, isTop10Value, isBigValue) {
  const tags = [];
  if (isTop10Value)               tags.push('거래대금 상위 10%');
  if (isBigValue)                 tags.push('대형 거래대금');
  if (m.rebreakMorningHigh)       tags.push('장초 고가 재돌파');
  if (m.rebreakWithValue)         tags.push('재돌파 + 거래대금 동반');
  if (m.valueSecondWaveRatio != null && m.valueSecondWaveRatio >= 1.2) tags.push('2차 파동');
  if (m.valueContinueRatio   != null && m.valueContinueRatio   >= 0.8) tags.push('강한 거래대금 유지');
  if (m.decisionPrice && m.highSoFar && (m.decisionPrice / m.highSoFar) >= 0.97) tags.push('고가권 유지');
  if (isTop10Value && m.rebreakMorningHigh) tags.push('공격형 TOP');
  return tags;
}
function assignAttackRiskTags(m, prevClose) {
  const tags = [];
  const gapRate = (m.open0900 && prevClose) ? ((m.open0900 / prevClose) - 1) * 100 : null;
  if (gapRate != null && gapRate >= 8) tags.push('갭 과열');
  const fromOpen = (m.decisionPrice && m.open0900) ? ((m.decisionPrice / m.open0900) - 1) * 100 : null;
  if (fromOpen != null && fromOpen >= 8) tags.push('시가 대비 너무 멀어짐');
  if (m.morningRangeRate != null && m.morningRangeRate >= 8) tags.push('장초 변동성 큼');
  // 첫 급등만 (재돌파 없음) — 09:00~09:20 high가 시가 대비 +2% 이상이고 rebreak 안 됨
  if (m.decisionTime >= '09:40' && !m.rebreakMorningHigh) tags.push('재돌파 실패');
  if (m.valueContinueRatio != null && m.valueContinueRatio < 0.3) tags.push('거래대금 급감');
  // 고가 대비 밀림 (decisionPrice가 highSoFar 대비 -3% 이하)
  if (m.decisionPrice && m.highSoFar && (m.decisionPrice / m.highSoFar - 1) * 100 <= -3) tags.push('고가 대비 밀림');
  return tags;
}

// attackScore (우선순위 보조 — UI에는 등급 표시)
function calculateAttackScore(m, isTop10Value, riskTags, prevClose) {
  let s = 0;
  if (isTop10Value)         s += 30;
  if (m.rebreakMorningHigh) s += 30;
  if (m.rebreakWithValue)   s += 15;
  if (m.valueContinueRatio   != null && m.valueContinueRatio   >= 0.8) s += 10;
  if (m.valueSecondWaveRatio != null && m.valueSecondWaveRatio >= 1.2) s += 10;
  if (riskTags.includes('갭 과열'))                 s -= 8;
  if (riskTags.includes('시가 대비 너무 멀어짐'))    s -= 8;
  if (riskTags.includes('장초 변동성 큼'))           s -= 6;
  if (riskTags.includes('재돌파 실패'))              s -= 20;
  return Number(s.toFixed(1));
}

// 공격형 TOP 후보 빌드 (전체 1DS 후보 입력 → BIG_MONEY_REBREAK 우선 추출)
function buildAttackTopFromCandidates(candidates) {
  const intradayDirs = loadIntradayDirs();
  // 1단계: 분봉 로드 + metric 계산
  const enriched = [];
  let withMinute = 0, missingMinute = 0;
  let globalMaxBarTime = '09:30';
  // baseDate를 YYYY-MM-DD 디렉토리 이름으로 변환 (preview fallback용)
  function baseDateToDir(bd) {
    if (!bd || bd.length !== 8) return null;
    return bd.slice(0, 4) + '-' + bd.slice(4, 6) + '-' + bd.slice(6, 8);
  }
  for (const it of candidates) {
    if (!it || !it.code || !it.baseDate) continue;
    // 1차: 운영 모드 nextDayDir (cron 09:30 직후 시나리오 — 어제 close-of-day로 선정된 mainPool + 오늘 morning intraday)
    // 2차: baseDate 자체 dir (로컬 weekend 프리뷰/16:35 cron — next day intraday가 아직 없는 경우)
    let dir = it.nextDayDir || findNextDayDir(it.baseDate, intradayDirs);
    let dirSource = 'nextDay';
    if (!dir) {
      const bdDir = baseDateToDir(it.baseDate);
      if (bdDir && intradayDirs.includes(bdDir)) { dir = bdDir; dirSource = 'baseDate'; }
    }
    if (!dir) { missingMinute++; continue; }
    const minuteData = loadMinuteBars(dir, it.code);
    if (!minuteData || !Array.isArray(minuteData.bars) || minuteData.bars.length === 0) { missingMinute++; continue; }
    // 글로벌 max bar time 추적
    const lastBar = minuteData.bars.filter((b) => b && b.time && Number.isFinite(b.close)).slice(-1)[0];
    if (lastBar && lastBar.time > globalMaxBarTime) globalMaxBarTime = lastBar.time;
    enriched.push({ it, bars: minuteData.bars, prevClose: it.prevClose, dirUsed: dir, dirSource });
    withMinute++;
  }
  if (enriched.length === 0) {
    return {
      summary: { count: 0, bigMoneyRebreakCount: 0, rebreakWithValueCount: 0, secondWaveCount: 0, riskCount: 0,
        generatedAtDecisionTime: null, decisionMode: attackDecisionMode(null),
        totalCandidates: candidates.length, candidatesWithMinute: 0, missingMinute,
        validationSnapshot: ATTACK_VALIDATION_SNAPSHOT,
        message: '분봉 데이터가 없어 공격형 TOP 분석 불가.',
      },
      candidates: [],
    };
  }
  // 1DS는 "10시 새로고침 시점"의 후보를 잡는 보드 — 풀-데이 분봉이 있어도 decisionTime을 10:00로 클램프.
  // (보드 generator를 언제 돌려도 attackTop이 10시 시점 데이터로 일관되게 결정됨)
  const decisionTime = globalMaxBarTime > '10:00' ? '10:00' : globalMaxBarTime;
  // 2단계: metric 계산
  const computed = [];
  for (const e of enriched) {
    const m = computeAttackMetricsFromBars(e.bars, decisionTime);
    if (!m) continue;
    // 가격 sanity guard (intraday open vs daily candle 비교는 여기선 skip — 기존 board가 이미 필터)
    computed.push({ it: e.it, m, prevClose: e.prevClose, dirUsed: e.dirUsed, dirSource: e.dirSource });
  }
  // 3단계: morning value 랭킹 (전체 후보 풀 기준)
  computed.sort((a, b) => (b.m.morningValue || 0) - (a.m.morningValue || 0));
  const n = computed.length;
  const top10Threshold = Math.max(1, Math.ceil(n * 0.10));
  const top30Threshold = Math.max(1, Math.ceil(n * 0.30));
  computed.forEach((c, i) => {
    c.morningValueRank = i + 1;
    c.morningValuePercentile = Number((((i + 1) / n) * 100).toFixed(1));
    c.isTop10Value = (i + 1) <= top10Threshold;
    c.isBigValue   = (i + 1) <= top30Threshold;
  });
  // 4단계: 태그 + score
  for (const c of computed) {
    c.riskTags = assignAttackRiskTags(c.m, c.prevClose);
    c.attackTags = assignAttackTags(c.m, c.isTop10Value, c.isBigValue);
    c.attackScore = calculateAttackScore(c.m, c.isTop10Value, c.riskTags, c.prevClose);
    // BIG_MONEY_REBREAK = isTop10Value AND rebreakMorningHigh
    c.bigMoneyRebreak = c.isTop10Value && c.m.rebreakMorningHigh;
  }
  // 5단계: 정렬 (BIG_MONEY_REBREAK 우선 → rebreakWithValue → morningValueRank → valueContinue → secondWave → fromOpen → 위험 적음)
  computed.sort((a, b) => {
    if (a.bigMoneyRebreak !== b.bigMoneyRebreak) return b.bigMoneyRebreak ? 1 : -1;
    if (!!a.m.rebreakWithValue !== !!b.m.rebreakWithValue) return b.m.rebreakWithValue ? 1 : -1;
    if (a.morningValueRank !== b.morningValueRank) return a.morningValueRank - b.morningValueRank;
    const ac = a.m.valueContinueRatio   || 0, bc = b.m.valueContinueRatio   || 0; if (ac !== bc) return bc - ac;
    const aw = a.m.valueSecondWaveRatio || 0, bw = b.m.valueSecondWaveRatio || 0; if (aw !== bw) return bw - aw;
    const af = (a.m.decisionPrice && a.m.open0900) ? (a.m.decisionPrice / a.m.open0900 - 1) * 100 : 999;
    const bf = (b.m.decisionPrice && b.m.open0900) ? (b.m.decisionPrice / b.m.open0900 - 1) * 100 : 999;
    if (af !== bf) return af - bf;
    return (a.riskTags.length) - (b.riskTags.length);
  });
  // 6단계: BIG_MONEY_REBREAK 통과 후보만 추출 (메인) + rank
  const passing = computed.filter((c) => c.bigMoneyRebreak);
  passing.forEach((c, i) => { c.attackRank = i + 1; });

  function shortCommentOf(c) {
    if (c.bigMoneyRebreak && c.m.rebreakWithValue) return '큰 돈이 들어왔고 장초 고가를 다시 돌파했으며 거래대금까지 함께 따라온 강한 공격형 후보입니다.';
    if (c.bigMoneyRebreak) return '거래대금 상위권이면서 장초 고가를 다시 돌파한 공격형 후보입니다.';
    if (c.isTop10Value && !c.m.rebreakMorningHigh) return '거래대금은 크지만 재돌파 확인이 약해 추격 주의가 필요합니다.';
    if (c.m.rebreakMorningHigh && !c.isTop10Value) return '재돌파는 있지만 거래대금 상위권은 아니어서 공격형 TOP에서는 한 단계 낮습니다.';
    return '장초 첫 급등 이후 재돌파가 없어 공격형 TOP에서는 제외됩니다.';
  }

  const cards = passing.map((c) => {
    const fromPrev = (c.m.decisionPrice && c.prevClose) ? Number(((c.m.decisionPrice / c.prevClose - 1) * 100).toFixed(2)) : null;
    const fromOpen = (c.m.decisionPrice && c.m.open0900) ? Number(((c.m.decisionPrice / c.m.open0900 - 1) * 100).toFixed(2)) : null;
    const pposRng = (c.m.highSoFar && c.m.lowSoFar && c.m.highSoFar !== c.m.lowSoFar && c.m.decisionPrice)
      ? Number(((c.m.decisionPrice - c.m.lowSoFar) / (c.m.highSoFar - c.m.lowSoFar)).toFixed(3)) : null;
    const gapRate = (c.m.open0900 && c.prevClose) ? Number(((c.m.open0900 / c.prevClose - 1) * 100).toFixed(2)) : null;
    return {
      code: c.it.code,
      name: c.it.name,
      market: c.it.market || null,
      attackRank: c.attackRank,
      attackScore: c.attackScore,
      decisionTime,
      decisionPrice: c.m.decisionPrice,
      signalPrice: c.it.intraday?.close_0930 != null ? c.it.intraday.close_0930 : (c.m.decisionPrice || null),
      prevClose: c.prevClose,
      open0900: c.m.open0900,
      gapRate,
      morningValue: c.m.morningValue,
      morningValueRank: c.morningValueRank,
      morningValuePercentile: c.morningValuePercentile,
      isTop10Value: c.isTop10Value,
      morningHigh: c.m.morningHigh_0_30,
      rebreakMorningHigh: c.m.rebreakMorningHigh,
      rebreakTime: c.m.rebreakTime,
      rebreakWithValue: c.m.rebreakWithValue,
      valueContinueRatio: c.m.valueContinueRatio,
      valueSecondWaveRatio: c.m.valueSecondWaveRatio,
      decisionFromPrevClose: fromPrev,
      decisionFromOpen: fromOpen,
      morningRangeRate: c.m.morningRangeRate,
      pricePositionInMorningRange: pposRng,
      gtBand: c.it.gtBand || null,
      oneDaySurgeScore: c.it.oneDaySurgeScore != null ? c.it.oneDaySurgeScore : null,
      attackTags: c.attackTags,
      riskTags: c.riskTags,
      shortComment: shortCommentOf(c),
      // 결과 계산용 — 이 후보의 실제 활동 거래일 (분봉 dir = YYYY-MM-DD)
      targetDir: c.dirUsed,
      targetDirSource: c.dirSource,
    };
  });

  const summary = {
    count: cards.length,
    bigMoneyRebreakCount: cards.length,
    rebreakWithValueCount: cards.filter((c) => c.rebreakWithValue).length,
    secondWaveCount: cards.filter((c) => c.valueSecondWaveRatio != null && c.valueSecondWaveRatio >= 1.2).length,
    riskCount: cards.filter((c) => c.riskTags && c.riskTags.length > 0).length,
    generatedAtDecisionTime: decisionTime,
    decisionMode: attackDecisionMode(decisionTime),
    totalCandidates: candidates.length,
    candidatesWithMinute: withMinute,
    missingMinute,
    morningValueTop10Threshold: top10Threshold,
    morningValueUniverseSize: n,
    validationSnapshot: ATTACK_VALIDATION_SNAPSHOT,
    overflowWarning: cards.length >= 20,
  };
  return { summary, candidates: cards };
}

// ── 표시 정책 후처리 ──────────────────────────────────────────────────
// 1DS 탐지/점수/그룹 분류는 무수정. 표시 단계에서만:
//  - 메인 후보(10시 생존/09:30 강한 후보 등)에서 "이미 크게 발화" 분리 → 🚀 별도 섹션
//  - 공격형 후보는 위험 사유로 제거하지 않음. attackRiskLevel만 부여해 NORMAL vs HIGH_RISK 표시.
//
// 공격형 = 고위험 감시 영역. riskTrap/riskExcluded 단독으로 제외하지 않는다.
const ALREADY_FIRED_RATE_THRESHOLD = 20;
// 호환성용 alias (외부 일부 코드에서 참조할 수 있음)
const ALREADY_LIMIT_RATE_THRESHOLD = ALREADY_FIRED_RATE_THRESHOLD;

function classifyAlreadyLimitLikeAttack(card) {
  // attackTopCandidates 카드 기준 — decisionFromPrevClose / gapRate / morningRangeRate 사용
  if (Number.isFinite(card.decisionFromPrevClose) && card.decisionFromPrevClose >= ALREADY_LIMIT_RATE_THRESHOLD)
    return { yes: true, reason: `전일 대비 ${card.decisionFromPrevClose.toFixed(2)}% 진행 (≥${ALREADY_LIMIT_RATE_THRESHOLD}%)` };
  if (Number.isFinite(card.gapRate) && card.gapRate >= ALREADY_LIMIT_RATE_THRESHOLD)
    return { yes: true, reason: `갭 ${card.gapRate.toFixed(2)}%로 출발` };
  return { yes: false, reason: null };
}

function classifyOperatorRiskExcludedAttack(card, candidate) {
  if (candidate?.riskExcluded)
    return { yes: true, reason: `riskExcluded=${candidate.riskExcluded}` };
  if (candidate?.tradePlan?.status === 'AUTO_EXCLUDED_RISK')
    return { yes: true, reason: 'tradePlan AUTO_EXCLUDED_RISK' };
  if (Number.isFinite(candidate?.riskTrapScore) && candidate.riskTrapScore >= 70)
    return { yes: true, reason: `riskTrapScore ${candidate.riskTrapScore.toFixed(1)}` };
  const cp30 = candidate?.intraday?.closePosition_0_30;
  if (Number.isFinite(cp30) && cp30 < 0.35)
    return { yes: true, reason: `09:30 close 위치 ${cp30.toFixed(3)} < 0.35` };
  const hd30 = candidate?.intraday?.highToCloseDrop_0_30;
  if (Number.isFinite(hd30) && hd30 <= -4)
    return { yes: true, reason: `장초 고점 대비 ${hd30.toFixed(2)}% 밀림` };
  if (Number.isFinite(card.morningRangeRate) && card.morningRangeRate >= 25)
    return { yes: true, reason: `장초 변동폭 ${card.morningRangeRate.toFixed(2)}% (≥25%)` };
  return { yes: false, reason: null };
}

// scanner 항목의 prevClose가 candidate(mainPool)에 없을 때 chart에서 직접 lookup.
function lookupPrevCloseFromChart(code, baseDateYYYYMMDD) {
  try {
    const p = path.join(CHART_DIR, `${code}.json`);
    if (!fs.existsSync(p)) return null;
    const c = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const rows = c?.rows;
    if (!Array.isArray(rows)) return null;
    // baseDate 인덱스 찾고 그 직전 거래일 close
    const idx = rows.findIndex(r => r && r.date === baseDateYYYYMMDD);
    if (idx > 0) return rows[idx - 1].close;
    // baseDate 못 찾으면 가장 최근의 volume>0 row 직전
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i].volume > 0 && rows[i].close > 0) return rows[i - 1].close;
    }
    return null;
  } catch (_) { return null; }
}

function classifyAlreadyLimitLikeScan(item, candidate) {
  // scanner0930 항목 — metrics.last0930 / survivor1000.close1000 / candidate.prevClose
  let prevClose = candidate?.prevClose;
  if (!Number.isFinite(prevClose) && item?.baseDate) {
    prevClose = lookupPrevCloseFromChart(item.code, item.baseDate);
  }
  const last0930 = item?.metrics?.last0930;
  const close1000 = item?.survivor1000?.close1000;
  if (Number.isFinite(last0930) && Number.isFinite(prevClose) && prevClose > 0) {
    const rate = (last0930 / prevClose - 1) * 100;
    if (rate >= ALREADY_LIMIT_RATE_THRESHOLD) return { yes: true, reason: `09:30 close 전일 대비 +${rate.toFixed(2)}%` };
  }
  if (Number.isFinite(close1000) && Number.isFinite(prevClose) && prevClose > 0) {
    const rate = (close1000 / prevClose - 1) * 100;
    if (rate >= ALREADY_LIMIT_RATE_THRESHOLD) return { yes: true, reason: `10:00 close 전일 대비 +${rate.toFixed(2)}%` };
  }
  const openToLast = item?.metrics?.openToLastRate;
  if (Number.isFinite(openToLast) && openToLast >= ALREADY_LIMIT_RATE_THRESHOLD)
    return { yes: true, reason: `시가 대비 +${openToLast.toFixed(2)}% (≥${ALREADY_LIMIT_RATE_THRESHOLD}%)` };
  return { yes: false, reason: null };
}

function classifyOperatorRiskExcludedScan(item, candidate) {
  if (candidate?.riskExcluded)
    return { yes: true, reason: `riskExcluded=${candidate.riskExcluded}` };
  if (candidate?.tradePlan?.status === 'AUTO_EXCLUDED_RISK')
    return { yes: true, reason: 'tradePlan AUTO_EXCLUDED_RISK' };
  if (Number.isFinite(candidate?.riskTrapScore) && candidate.riskTrapScore >= 70)
    return { yes: true, reason: `riskTrapScore ${candidate.riskTrapScore.toFixed(1)}` };
  const cp30 = item?.metrics?.closePosition0930;
  if (Number.isFinite(cp30) && cp30 < 0.35)
    return { yes: true, reason: `09:30 close 위치 ${cp30.toFixed(3)}` };
  const ht = item?.metrics?.highToLastDrop;
  if (Number.isFinite(ht) && ht <= -4)
    return { yes: true, reason: `09:30 high 대비 ${ht.toFixed(2)}% 밀림` };
  return { yes: false, reason: null };
}

// attackTop 카드 위험 등급 — HIGH_RISK_ATTACK 또는 NORMAL_ATTACK. 제거 X.
function classifyAttackRiskLevel(card, candidate) {
  const reasons = [];
  if (candidate?.riskExcluded) reasons.push(`riskExcluded=${candidate.riskExcluded}`);
  if (candidate?.tradePlan?.status === 'AUTO_EXCLUDED_RISK') reasons.push('tradePlan AUTO_EXCLUDED_RISK');
  if (Number.isFinite(candidate?.riskTrapScore) && candidate.riskTrapScore >= 70)
    reasons.push(`riskTrapScore ${candidate.riskTrapScore.toFixed(1)}`);
  if (Number.isFinite(card.gapRate) && card.gapRate >= 15) reasons.push(`갭 ${card.gapRate.toFixed(2)}%`);
  if (Number.isFinite(card.decisionFromPrevClose) && card.decisionFromPrevClose >= 25)
    reasons.push(`전일 대비 +${card.decisionFromPrevClose.toFixed(2)}%`);
  const cp30 = candidate?.intraday?.closePosition_0_30;
  if (Number.isFinite(cp30) && cp30 < 0.35) reasons.push(`09:30 closePos ${cp30.toFixed(3)}`);
  const hd30 = candidate?.intraday?.highToCloseDrop_0_30;
  if (Number.isFinite(hd30) && hd30 <= -4) reasons.push(`09:30 고점 대비 ${hd30.toFixed(2)}%`);
  if (Number.isFinite(card.morningRangeRate) && card.morningRangeRate >= 20)
    reasons.push(`장초 변동폭 ${card.morningRangeRate.toFixed(2)}%`);
  return reasons.length > 0
    ? { level: 'HIGH_RISK_ATTACK', reasons }
    : { level: 'NORMAL_ATTACK', reasons: [] };
}

function applyDisplayPolicyPostProcess(out, allCandidates) {
  const byCode = new Map();
  for (const c of (allCandidates || [])) if (c && c.code) byCode.set(c.code, c);

  // ─── attackTopCandidates: 제거 안 함. attackRiskLevel + isAlreadyFired 표시만 ───
  // 공격형은 고위험 감시 영역 — riskTrap/riskExcluded 단독으로 제외하지 않는다.
  // NORMAL_ATTACK과 HIGH_RISK_ATTACK 두 그룹으로 분리해 UI에 표시한다.
  const attackNormal = [];
  const attackHighRisk = [];
  for (const card of (out.attackTopCandidates || [])) {
    const cand = byCode.get(card.code);
    const lvl = classifyAttackRiskLevel(card, cand);
    card.attackRiskLevel = lvl.level;
    card.attackRiskReasons = lvl.reasons;
    const aL = classifyAlreadyLimitLikeAttack(card);
    if (aL.yes) {
      card.isAlreadyFired = true;
      card.alreadyFiredReason = aL.reason;
    }
    if (lvl.level === 'HIGH_RISK_ATTACK') {
      card.displayPolicyNote = '위험 감수형 공격 후보 — 변동성이 크고 고점 이탈 위험이 있으나, 장초 재상승/재돌파 흐름이 있어 공격형 감시 대상으로 유지합니다.';
      attackHighRisk.push(card);
    } else {
      attackNormal.push(card);
    }
  }
  attackNormal.forEach((c, i) => { c.attackRank = i + 1; });
  attackHighRisk.forEach((c, i) => { c.attackRank = i + 1; });
  out.attackTopCandidates = attackNormal;
  out.attackTopHighRisk   = attackHighRisk;
  if (out.attackTopSummary) {
    out.attackTopSummary.normalCount = attackNormal.length;
    out.attackTopSummary.highRiskCount = attackHighRisk.length;
    out.attackTopSummary.count = attackNormal.length + attackHighRisk.length;
  }

  // ─── scanner0930: 메인 섹션에서 isAlreadyFired만 분리 ───
  // 공격형 섹션(attackRebreak)에는 위험 사유로 제거하지 않음. isAlreadyFired만 분리 기준.
  const sc = out.priorityRanked?.scanner0930;
  if (sc) {
    const splitFired = (arr) => {
      const main = [], fired = [];
      for (const item of (arr || [])) {
        const cand = byCode.get(item.code);
        const aF = classifyAlreadyLimitLikeScan(item, cand);
        if (aF.yes) {
          item.isAlreadyFired = true;
          item.alreadyFiredReason = aF.reason;
          item.displayPolicyNote = '09:30 기준 강했지만 이미 너무 진행되어 신규 감시 후보에서는 제외합니다.';
          fired.push(item);
        } else {
          main.push(item);
        }
      }
      return { main, fired };
    };
    const survivor = splitFired(sc.survivor1000);
    const expl     = splitFired(sc.explosiveStable);
    const attkR    = splitFired(sc.attackRebreak);
    const ready    = splitFired(sc.readyRestFinal);
    sc.survivor1000    = survivor.main;
    sc.explosiveStable = expl.main;
    sc.attackRebreak   = attkR.main;
    sc.readyRestFinal  = ready.main;
    sc.alreadyFired    = [...survivor.fired, ...expl.fired, ...attkR.fired, ...ready.fired];
    sc.displayPolicySummary = {
      alreadyFiredCount: sc.alreadyFired.length,
      threshold: ALREADY_FIRED_RATE_THRESHOLD,
      attackNormalCount: attackNormal.length,
      attackHighRiskCount: attackHighRisk.length,
    };
  }

  return out;
}

async function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(CHART_DIR)) {
    console.error('[ERROR] cache/stock-charts-long 디렉토리가 없습니다.');
    process.exit(1);
  }

  console.log('\n📊 1-Day Surge Board v5 (GOOD_TRADE 중심) 생성');
  const metaMap = loadStockMetaMap();
  const { qvaCodes, qvaSignalMap, vviCodes } = loadHistoryLookups();
  const naverCount = [...metaMap.values()].filter(x => x.marketCap > 0).length;
  console.log(`  종목 메타: ${metaMap.size}건 (시총 보유 ${naverCount}건) / QVA 이력: ${qvaCodes.size} / VVI 이력: ${vviCodes.size}`);

  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`  차트 캐시 파일: ${files.length}건`);

  // ─── 나스닥 테마 1DS 감시 후보풀 lookup (universe 확장 — 본체 변경 X) ───
  // 기존 1DS는 차트 캐시의 모든 종목을 검사하므로 theme WATCH_A/B 후보는 이미 universe에 포함됨.
  // 하지만 passesHardFilter / 기타 컷으로 빠질 수 있으므로 통과/미통과를 별도 카운트.
  // 통과 후보에는 themeWatchInfo 부착 → mainPool 카드에 "🌎 테마감시 A/B" 태그.
  const THEME_WATCH_GRADES_INCLUDE = ['WATCH_A', 'WATCH_B'];
  let themeWatchABList = [];
  try {
    themeWatchABList = themeWatchPool.getThemeWatchCandidates({ grades: THEME_WATCH_GRADES_INCLUDE });
  } catch (e) {
    console.warn(`  ⚠ theme-1ds-watch-pool 로드 실패 (1DS는 정상 진행): ${e.message}`);
  }
  const themeWatchInfoByCode = new Map();
  for (const tw of themeWatchABList) themeWatchInfoByCode.set(tw.code, tw);
  console.log(`  나스닥 테마 WATCH_A/B 후보: ${themeWatchABList.length}건 (universe 확장 대상)`);

  // 1DS 보드 baseDate 정책: KST 장 진행 중(09:00~16:30)에만 오늘 일봉이 부분값이라
  // fallback이 필요. 장 마감 후(16:30~다음날 09:00)엔 종가 확정이라 fallback X.
  //   KST 09:00 ~ 16:30 → 부분 일봉 → 한 행 앞(어제)으로 fallback
  //   KST 16:30 이후    → 종가 확정 → 오늘 baseDate 그대로 (내일 장초 후보 산출용)
  const todayParts = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).split('. ');
  const KST_TODAY_NUM = todayParts[0] + (todayParts[1] || '').padStart(2, '0') + ((todayParts[2] || '').replace('.', '')).padStart(2, '0');
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const KST_MIN = kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes();
  const PARTIAL_BAR_FALLBACK_ENABLED = KST_MIN >= (9 * 60) && KST_MIN < (16 * 60 + 30);
  let partialBarFallbackCount = 0;

  // 1차 통과 — passesHardFilter + analyze + 기본 메트릭 계산
  const candidates = [];
  const filterCounts = { no_meta: 0, etf: 0, special: 0, excluded_name: 0, no_marketcap: 0, mc_under_500: 0, mc_over_5t: 0 };
  let parseErrCount = 0;
  let skippedNoMetrics = 0;
  // 테마 universe 확장: hardFilter에서 컷되었지만 테마 WATCH_A/B 후보라 강제 포함된 카운트
  let themeBypassedHardFilter = 0;
  const themeBypassedReasons = {};

  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    const filt = core.passesHardFilter(meta);
    const isThemeWatch = themeWatchInfoByCode.has(code);
    if (!filt.ok) {
      filterCounts[filt.reason] = (filterCounts[filt.reason] || 0) + 1;
      // 테마 WATCH_A/B 후보는 universe 확장 — hardFilter 컷이어도 분석 진행.
      // 단 meta 자체가 없으면(no_meta) marketCap 등 후속 계산이 불가하므로 스킵.
      if (!isThemeWatch || !meta) continue;
      themeBypassedHardFilter++;
      themeBypassedReasons[filt.reason] = (themeBypassedReasons[filt.reason] || 0) + 1;
    }
    let chart;
    try {
      chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, f), 'utf-8'));
      if (chart && chart.rows) chart.rows = filterRowsAsOf(chart.rows);
    } catch (_) { parseErrCount++; continue; }
    const rows = chart && chart.rows;
    let baseIdx = core.pickLatestBaseIdx(rows);
    if (baseIdx < 0) { skippedNoMetrics++; continue; }
    // 오늘 부분 일봉이 latest로 잡히면 한 행 앞(어제 영업일)으로 fallback —
    // baseDate=오늘이면 nextDayDir=내일이라 09:30 분봉 매칭 실패하기 때문.
    // 단 장 마감 후(KST 16:30+)엔 오늘 일봉이 종가 확정이라 fallback 안 함 —
    // 그래야 "내일 장초 들여다볼 후보(=오늘 종가 강세 mainPool)"가 정상 산출됨.
    if (PARTIAL_BAR_FALLBACK_ENABLED
        && rows[baseIdx] && rows[baseIdx].date === KST_TODAY_NUM && baseIdx >= 21) {
      baseIdx = baseIdx - 1;
      partialBarFallbackCount++;
    }

    const m = core.analyzeAt(rows, baseIdx);
    if (!m) { skippedNoMetrics++; continue; }
    const s = core.scoreMetrics(m, meta.marketCap);

    // v5 신규 메트릭
    const valueToMarketCapRatio = (meta.marketCap > 0 && Number.isFinite(m.valueAmount))
      ? m.valueAmount / meta.marketCap * 100 : null;
    const candleType = core.classifyCandleType(m);
    const recent5Up7Count = core.countRecentSurges(rows, baseIdx, 5, 7);
    const recent5Up15Count = core.countRecentSurges(rows, baseIdx, 5, 15);
    const recent10Up15Count = core.countRecentSurges(rows, baseIdx, 10, 15);
    const baseGapRate = m.gapPct; // alias

    // 나스닥 테마 1DS 감시 후보풀 lookup (해당하면 태그 부착, 본체 분석 로직과 무관)
    const themeWatchHit = themeWatchInfoByCode.get(code) || null;

    candidates.push({
      code,
      name: chart.name || meta.name || code,
      market: chart.market || meta.market || '',
      marketCap: meta.marketCap,
      ...m,
      ...s,
      marketCapBandLabel: core.MARKET_CAP_BAND_LABEL[s.marketCapBand],
      gtBand: core.classifyGtBand(meta.marketCap),
      gtBandLabel: core.GT_BAND_LABEL[core.classifyGtBand(meta.marketCap)] || null,
      valueToMarketCapRatio: valueToMarketCapRatio != null ? core.round(valueToMarketCapRatio, 2) : null,
      candleType,
      recent5Up7Count, recent5Up15Count, recent10Up15Count,
      baseGapRate: baseGapRate != null ? core.round(baseGapRate, 2) : null,
      qvaHistoryLabel: qvaCodes.get(code) || null,
      vviHistory: vviCodes.get(code) || null,
      // ─── 나스닥 테마 감시 정보 (표시만 — 1DS 점수/판정에는 영향 X) ───
      isThemeWatchCandidate: !!themeWatchHit,
      themeWatchInfo: themeWatchHit ? {
        watchGrade:        themeWatchHit.watchGrade,
        watchGroup:        themeWatchHit.watchGroup,
        bestThemeKey:      themeWatchHit.bestThemeKey,
        bestThemeLabel:    themeWatchHit.bestThemeLabel,
        bestThemeStrength: themeWatchHit.bestThemeStrength,
        theme1dsWatchScore: themeWatchHit.theme1dsWatchScore,
        watchReason:       themeWatchHit.watchReason,
      } : null,
      sourceTags: themeWatchHit ? ['ONE_DAY_SURGE_BASE', 'NASDAQ_THEME_WATCH'] : ['ONE_DAY_SURGE_BASE'],
      poolAddedByTheme: !!themeWatchHit && !filt.ok,  // hardFilter는 컷했지만 테마 후보라 universe에 추가된 경우 true
    });
  }

  // 1.5차: stale 후보 제거 (거래정지/장기 미거래 종목)
  // chart 캐시는 매일 OHLC=0 row가 추가되지만 거래가 없는 종목은 baseDate(가장 최근 volume>0 row)가
  // 옛 날짜로 떨어진다. 이런 후보는 1DS 매수 의미 없음 + entryConfirmDate 계산 오염시킴.
  // → 가장 흔한 baseDate(=실제 최신 거래일) 기준 7 calendar days 이상 떨어진 후보는 제외.
  const _bdFreq = new Map();
  for (const it of candidates) _bdFreq.set(it.baseDate, (_bdFreq.get(it.baseDate) || 0) + 1);
  let _consensusBaseDate = null, _consensusFreq = 0;
  for (const [d, n] of _bdFreq) { if (n > _consensusFreq) { _consensusFreq = n; _consensusBaseDate = d; } }
  let staleExcluded = 0;
  const staleExcludedSamples = [];
  if (_consensusBaseDate && _consensusBaseDate.length === 8) {
    const cy = +_consensusBaseDate.slice(0, 4), cm = +_consensusBaseDate.slice(4, 6), cd = +_consensusBaseDate.slice(6, 8);
    const consensusMs = Date.UTC(cy, cm - 1, cd);
    const cutoffMs = consensusMs - 7 * 24 * 3600 * 1000;
    const filtered = [];
    for (const it of candidates) {
      if (!it.baseDate || it.baseDate.length !== 8) { filtered.push(it); continue; }
      const y = +it.baseDate.slice(0, 4), mo = +it.baseDate.slice(4, 6), dy = +it.baseDate.slice(6, 8);
      const itMs = Date.UTC(y, mo - 1, dy);
      if (itMs < cutoffMs) {
        staleExcluded++;
        if (staleExcludedSamples.length < 10) staleExcludedSamples.push({ code: it.code, name: it.name, baseDate: it.baseDate });
        continue;
      }
      filtered.push(it);
    }
    if (staleExcluded > 0) {
      console.log(`  🧹 stale 후보 ${staleExcluded}건 제외 (consensus baseDate ${_consensusBaseDate}에서 7일 이상 옛 후보 — 거래정지/미거래 추정)`);
      for (const s of staleExcludedSamples.slice(0, 5)) console.log(`     - ${s.baseDate} ${s.code} ${s.name}`);
      if (staleExcludedSamples.length > 5) console.log(`     ... +${staleExcluded - 5}건`);
    }
    candidates.length = 0;
    candidates.push(...filtered);
  }

  // 2차: 일자내 거래대금 순위 (같은 baseDate 안에서)
  const byDate = new Map();
  for (const it of candidates) {
    if (!byDate.has(it.baseDate)) byDate.set(it.baseDate, []);
    byDate.get(it.baseDate).push(it);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => (b.valueAmount || 0) - (a.valueAmount || 0));
    list.forEach((it, idx) => { it.dailyValueRank = idx + 1; });
  }

  // 3차: GT 그룹 분류
  const grouped = {};
  for (const k of GT_GROUP_ORDER) grouped[k] = [];
  let unclassified = 0;
  for (const it of candidates) {
    const g = core.classifyGtGroup({
      m: it,
      marketCap: it.marketCap,
      valueToMarketCapRatio: it.valueToMarketCapRatio,
      candleType: it.candleType,
      dailyValueRank: it.dailyValueRank,
      recent5Up15Count: it.recent5Up15Count,
    });
    it.gtGroup = g;
    it.summaryLine = buildSummaryLine(it);
    if (g === 'UNCLASSIFIED') { unclassified++; continue; }
    if (grouped[g]) grouped[g].push(it);
  }

  // 3.5차: 장초 분봉 ENTRY_CONFIRM 메트릭 부착 + 전략 태그 (data/intraday/1ds/ 가 있을 때만 채워짐)
  const { withMinute, missing, intradayDirs } = attachIntradayMetrics(candidates);
  console.log(`  장초 분봉 ENTRY_CONFIRM: ${withMinute}건 적용 / ${missing}건 분봉 없음 (디렉토리 ${intradayDirs.length}개)`);

  // 3.6차: QVA 보조 태그 (이전 수급 흔적) 부착 — display only, 점수 영향 없음
  const qvaTaggedAll = attachQvaHistory(candidates, qvaSignalMap);
  console.log(`  📈 QVA 보조 태그 (이전 수급 흔적): ${qvaTaggedAll}건 / 1DS 후보 ${candidates.length}건 (qvaSignalMap ${qvaSignalMap.size}건)`);

  // 4차: 그룹별 정렬
  // 기본 gtSort: valueToMcRatio 높은 순, 거래대금 순위 높은 순(낮은 숫자), recent5Up15Count 작은 순, LOW_GAP_INTRADAY 우선
  function gtSort(a, b) {
    const lowGapA = a.candleType === 'LOW_GAP_INTRADAY' ? 1 : 0;
    const lowGapB = b.candleType === 'LOW_GAP_INTRADAY' ? 1 : 0;
    if (lowGapB !== lowGapA) return lowGapB - lowGapA;
    const va = a.valueToMarketCapRatio || 0;
    const vb = b.valueToMarketCapRatio || 0;
    if (vb !== va) return vb - va;
    const ra = a.dailyValueRank || 9999;
    const rb = b.dailyValueRank || 9999;
    if (ra !== rb) return ra - rb;
    const r5a = a.recent5Up15Count != null ? a.recent5Up15Count : 99;
    const r5b = b.recent5Up15Count != null ? b.recent5Up15Count : 99;
    if (r5a !== r5b) return r5a - r5b;
    return (b.oneDaySurgeScore || 0) - (a.oneDaySurgeScore || 0);
  }
  // LIGHT-GT 전용 정렬 — 메인 상위 20개만 노출하므로 더 엄격한 6 criteria
  // 1) v/mc 높은 순 → 2) 거래대금 시장 순위 높은 순 → 3) changeRate 5~25% sweet 우선
  // → 4) recent5Up15Count ≤ 1 우선 → 5) trapRisk 낮은 순(윗꼬리+5d과열)
  // → 6) marketCap 1,000~3,000억은 그룹 정의 자체로 보장됨
  function lightGtSort(a, b) {
    const va = a.valueToMarketCapRatio || 0;
    const vb = b.valueToMarketCapRatio || 0;
    if (vb !== va) return vb - va;
    const ra = a.dailyValueRank || 9999;
    const rb = b.dailyValueRank || 9999;
    if (ra !== rb) return ra - rb;
    // sweet zone: changeRate 5~25%
    const aSweet = (a.changeRate >= 5 && a.changeRate <= 25) ? 0 : 1;
    const bSweet = (b.changeRate >= 5 && b.changeRate <= 25) ? 0 : 1;
    if (aSweet !== bSweet) return aSweet - bSweet;
    const aLow = (a.recent5Up15Count != null && a.recent5Up15Count <= 1) ? 0 : 1;
    const bLow = (b.recent5Up15Count != null && b.recent5Up15Count <= 1) ? 0 : 1;
    if (aLow !== bLow) return aLow - bLow;
    // trap risk = 윗꼬리 비중 + 5일 과열 (30% 초과분만 가산) — 낮을수록 안전
    const aRisk = (a.upperTailRatio || 0) + Math.max(0, ((a.ret5d || 0) - 30) / 100);
    const bRisk = (b.upperTailRatio || 0) + Math.max(0, ((b.ret5d || 0) - 30) / 100);
    if (aRisk !== bRisk) return aRisk - bRisk;
    return (b.oneDaySurgeScore || 0) - (a.oneDaySurgeScore || 0);
  }
  for (const g of GT_GROUP_ORDER) {
    const sortFn = g === 'LIGHT-GT' ? lightGtSort : gtSort;
    grouped[g].sort(sortFn);
    if (grouped[g].length > GT_CAP[g]) grouped[g] = grouped[g].slice(0, GT_CAP[g]);
  }

  // 분석 기준일
  const dateFreq = new Map();
  for (const it of candidates) dateFreq.set(it.baseDate, (dateFreq.get(it.baseDate) || 0) + 1);
  let analysisDate = null, maxFreq = 0;
  for (const [d, c] of dateFreq) { if (c > maxFreq) { maxFreq = c; analysisDate = d; } }

  // 요약 통계
  const all = GT_GROUP_ORDER.flatMap(g => grouped[g]);
  const valueSurgeCount = all.filter(x => x.valueRatio >= 3).length;
  const lowGapCount = all.filter(x => x.candleType === 'LOW_GAP_INTRADAY').length;
  const highVmcCount = all.filter(x => x.valueToMarketCapRatio >= 10).length;

  // ── displayPriorityScore + riskTrapScore + 후보 유형별 과거 성과 부착 ──
  for (const it of all) {
    it.riskTrapScore = calcRiskTrapScore(it);
    it.displayPriorityScore = calcDisplayPriorityScore(it);
    const perf = classifyPerformance(it);
    it.performanceConfirmed   = perf.confirmed;
    it.performanceLabel       = perf.label;
    it.performanceStats       = perf.stats;
    it.performanceSource      = perf.source;
    it.performanceDisclaimer  = perf.disclaimer;
    it.performancePendingNote = perf.pendingNote || null;
  }

  // ── 화면 노출 우선순위 풀 구성 (추천 후보만) ──
  // 위험 후보는 passesRiskFilter()로 hard 제외 — 보드는 추천만 노출, 위험 분석은 연구 보고서에서.
  const riskExcludeCounts = { group_off_pool: 0, gap_hold_candle: 0, prev_high_spike: 0, risk_rebreak: 0, peak_before_entry: 0, trap_risk_high: 0, insufficient_bars: 0 };
  const mainPool = [];
  for (const it of all) {
    const filt = passesRiskFilter(it);
    if (!filt.ok) {
      it.riskExcluded = filt.reason;
      riskExcludeCounts[filt.reason] = (riskExcludeCounts[filt.reason] || 0) + 1;
      continue;
    }
    mainPool.push(it);
  }
  mainPool.sort((a, b) => (b.displayPriorityScore || 0) - (a.displayPriorityScore || 0));

  // ── 자동 참고 매수가/매도가 계산 ──
  // mainPool(위험 필터 통과 + displayPriorityScore 내림차순) 모든 후보에 tradePlan 부착.
  // 매수 추천이 아닌 참고 가격이며 시장가 매수 전제로 계산하지 않는다.
  const { plansByCode: tradePlansByCode, summary: tradePlanCalcSummary } = tradePlanModule.buildTradePlans(mainPool);
  let tradePlanExcludedRiskCount = 0;
  for (const it of all) {
    if (it.riskExcluded) {
      it.tradePlan = { mode: 'NONE', status: 'AUTO_EXCLUDED_RISK', reason: '위험 태그로 자동 계산 제외' };
      tradePlanExcludedRiskCount++;
    } else if (tradePlansByCode.has(it.code)) {
      it.tradePlan = tradePlansByCode.get(it.code);
    } else {
      it.tradePlan = { mode: 'NONE', status: 'NOT_SELECTED' };
    }
  }

  // ── status별 풀 분리 (09:30 분봉 반영 후 진입 가능/보류 후보 명확 분리) ──
  // readyPool   = tradePlan.status === 'READY' (분봉 검증 통과 + 진입 가능)
  // holdingPool = 위험 신호 발생 (WAIT_PULLBACK / ENTRY_INVALIDATED / REBREAK_FADED)
  // pendingPool = 09:30 분봉 미확인 (NEED_INTRADAY_CONFIRM) — "아직 검증 안 됨"
  // READY 후보가 5개 미만이어도 holding/pending으로 자리를 채우지 않는다 — 부족하면 부족한 그대로.
  const HOLDING_STATUSES = new Set(['WAIT_PULLBACK', 'ENTRY_INVALIDATED', 'REBREAK_FADED']);
  const readyPool    = mainPool.filter((it) => it.tradePlan && it.tradePlan.status === 'READY');
  const holdingPool  = mainPool.filter((it) => it.tradePlan && HOLDING_STATUSES.has(it.tradePlan.status));
  // pendingPool = NEED_INTRADAY_CONFIRM 또는 NOT_SELECTED (AUTO_PLAN_LIMIT 초과로 trade plan 미계산)
  // 분봉 매칭이 안 됐거나 트레이드 플랜이 안 잡힌 mainPool 후보 모두 포함 — premarket 섹션에서 표시.
  const pendingPool  = mainPool.filter((it) => {
    const st = it.tradePlan && it.tradePlan.status;
    return st === 'NEED_INTRADAY_CONFIRM' || st === 'NOT_SELECTED';
  });
  const topPriority   = readyPool.slice(0, TOP_PRIORITY_LIMIT);
  const extraPriority = readyPool.slice(TOP_PRIORITY_LIMIT, TOP_PRIORITY_LIMIT + EXTRA_PRIORITY_LIMIT);
  const overflowPool  = readyPool.slice(TOP_PRIORITY_LIMIT + EXTRA_PRIORITY_LIMIT);

  // ── 재관찰 후보 풀 (peak_before_entry / trap_risk_high로 위험 필터에서 빠진 후보 중 일부) ──
  // 전일 일봉 조건은 강했지만 장초 진입은 부적합 — 다시 고점 회복 시에만 관찰.
  // 조건: BAL/LIGHT-GT + dps≥20 + v/mc≥10 + insufficient_bars 아님 (이미 다른 reason으로 제외된 케이스만).
  const REOBSERVE_REASONS = new Set(['peak_before_entry', 'trap_risk_high']);
  const reobservePool = all.filter((it) => {
    if (!REOBSERVE_REASONS.has(it.riskExcluded)) return false;
    if (!(it.gtGroup === 'BALANCED-GT' || it.gtGroup === 'LIGHT-GT')) return false;
    if (!(Number.isFinite(it.displayPriorityScore) && it.displayPriorityScore >= 20)) return false;
    if (!(Number.isFinite(it.valueToMarketCapRatio) && it.valueToMarketCapRatio >= 10)) return false;
    // 분봉 부족 종목은 명시적 제외 (riskExcluded는 위험 필터 우선순위 상 앞 reason이 잡힐 수 있음)
    if (it.intraday && Number.isFinite(it.intraday.bars_total)
        && it.intraday.bars_total < tradePlanModule.MIN_BARS_FOR_JUDGMENT) return false;
    return true;
  }).sort((a, b) => (b.displayPriorityScore || 0) - (a.displayPriorityScore || 0));
  const tradePlanSummary = {
    autoCount: tradePlanCalcSummary.autoCount,
    readyCount: tradePlanCalcSummary.readyCount,
    waitPullbackCount: tradePlanCalcSummary.waitPullbackCount,
    invalidatedCount: tradePlanCalcSummary.invalidatedCount,
    fadedCount: tradePlanCalcSummary.fadedCount,
    insufficientCount: tradePlanCalcSummary.insufficientCount,
    needConfirmCount: tradePlanCalcSummary.needConfirmCount,
    excludedRiskCount: tradePlanExcludedRiskCount,
    missingPriceCount: tradePlanCalcSummary.missingPriceCount,
    intradayConfirmedCount: tradePlanCalcSummary.intradayConfirmedCount,
    groupFallbackCount: tradePlanCalcSummary.groupFallbackCount,
    autoPlanLimit: tradePlanModule.AUTO_PLAN_LIMIT,
  };

  // 전략별 카운트 (참고용 — 카드 chip rendering)
  const strategyCounts = {};
  for (const name of [...ENTRY_TOP_STRATEGIES, ...ENTRY_BOTTOM_STRATEGIES]) {
    strategyCounts[name] = all.filter((it) => (it.entryStrategies || []).includes(name)).length;
  }

  // 수동 매수·매도 가이드 — `data/manual-1ds-targets.json` 매칭 코드 카드에 attach
  const manualTargets = loadManualTargets();
  if (manualTargets.size > 0) {
    let attached = 0;
    for (const it of all) {
      const t = manualTargets.get(it.code);
      if (t) { it.manualTargets = t; attached++; }
    }
    console.log(`  📌 수동 매수·매도 가이드 attach: ${attached}건 / 파일 entry ${manualTargets.size}건`);
  }

  // QVA 보조 태그 — 화면 노출 후보만 집계 (위험/숨김 후보는 카운트 X)
  const qvaTaggedTopCount = topPriority.filter((it) => it.hasRecentQva).length;
  const qvaTaggedExtraCount = extraPriority.filter((it) => it.hasRecentQva).length;
  const qvaSummary = {
    taggedTopCount: qvaTaggedTopCount,
    taggedExtraCount: qvaTaggedExtraCount,
    taggedTotalVisibleCount: qvaTaggedTopCount + qvaTaggedExtraCount,
    totalCandidatesTagged: qvaTaggedAll,
    qvaSignalMapSize: qvaSignalMap.size,
    displayOnly: true,
  };

  // ─── 나스닥 테마 1DS 감시 후보풀 통계 (1DS 본체 로직 변경 X — universe 확장만) ───
  // hardFilter 컷되었지만 테마 WATCH_A/B 후보라 candidates에 강제 추가된 종목 = poolAddedByTheme:true
  const candidatesCodes = new Set(candidates.map((c) => c.code));
  const themeWatchTotal = themeWatchABList.length;
  const themeInCandidatesAll = themeWatchABList.filter((tw) => candidatesCodes.has(tw.code)).length;
  const themeBypassedAdded = candidates.filter((c) => c.poolAddedByTheme).length;
  const themeNaturalPass = themeInCandidatesAll - themeBypassedAdded;
  const themeMissingFromCandidates = themeWatchTotal - themeInCandidatesAll;  // chart 없거나 no_meta 등으로 분석 자체 불가
  // 1DS 본체 candidates (테마 후보 제외)
  const basePoolCount = candidates.length - themeBypassedAdded;
  // mainPool에 들어간 테마 후보 (= 실제 1DS 발화)
  const themeTriggered = mainPool.filter((it) => it.isThemeWatchCandidate);
  const watchATriggered = themeTriggered.filter((it) => it.themeWatchInfo?.watchGrade === 'WATCH_A');
  const watchBTriggered = themeTriggered.filter((it) => it.themeWatchInfo?.watchGrade === 'WATCH_B');
  const themeWatchPoolSummary = {
    basePoolCount,                                     // 1DS 본체 1차 통과 (테마 bypass 제외)
    themePoolCount: themeWatchTotal,                   // theme WATCH_A/B 후보 수
    duplicatedThemeCount: themeNaturalPass,            // hardFilter 자연 통과 (기존 universe와 겹침)
    addedThemeCount: themeBypassedAdded,               // hardFilter 컷되었으나 테마라 bypass된 신규 추가
    themeMissingFromCandidates,                        // chart 없거나 no_meta 등으로 분석 불가
    mergedPoolCount: candidates.length,                // 최종 candidates 길이 (자연 + bypass)
    themeBypassedHardFilter,                           // bypass 카운트 (loop 단계)
    themeBypassedReasons,                              // bypass 사유 분포
    themeTriggeredCount: themeTriggered.length,        // 테마 후보 중 mainPool 발화
    watchATriggeredCount: watchATriggered.length,
    watchBTriggeredCount: watchBTriggered.length,
  };
  console.log(`\n🌎 나스닥 테마 1DS 감시 후보풀 (universe 확장):`);
  console.log(`  기존 1DS 본체 1차 통과 (테마 제외): ${themeWatchPoolSummary.basePoolCount}`);
  console.log(`  테마 WATCH_A/B 후보:                ${themeWatchPoolSummary.themePoolCount}`);
  console.log(`  중복 (hardFilter 자연 통과):        ${themeWatchPoolSummary.duplicatedThemeCount}`);
  console.log(`  신규 추가 (hardFilter bypass):      ${themeWatchPoolSummary.addedThemeCount} ${Object.keys(themeBypassedReasons).length ? '(사유 ' + JSON.stringify(themeBypassedReasons) + ')' : ''}`);
  if (themeWatchPoolSummary.themeMissingFromCandidates > 0) {
    console.log(`  분석 불가 (chart/meta 부재):        ${themeWatchPoolSummary.themeMissingFromCandidates}`);
  }
  console.log(`  병합 후 universe:                   ${themeWatchPoolSummary.mergedPoolCount}`);
  console.log(`  테마 후보 중 1DS 발화 (mainPool):    ${themeWatchPoolSummary.themeTriggeredCount}`);
  console.log(`    └ WATCH_A 발화: ${themeWatchPoolSummary.watchATriggeredCount} / WATCH_B 발화: ${themeWatchPoolSummary.watchBTriggeredCount}`);

  // 가시성 카운트 (요약 cards용)
  const totalRiskExcluded = Object.values(riskExcludeCounts).reduce((a, b) => a + b, 0);
  // morningHigh 재돌파 ✓로 위험 면제된 후보 수 (mainPool 통과)
  const riskExemptedCount = mainPool.filter((it) => it.riskExempted && it.riskExempted.length > 0).length;
  const visibilityCounts = {
    totalPool: candidates.length,        // 분류 가능한 모든 후보 (UNCLASSIFIED 포함 안 됨)
    unclassified,                        // 화면 표시 X
    mainPoolSize: mainPool.length,       // 위험 필터 통과 후 추천 풀 크기
    readyPoolSize: readyPool.length,     // mainPool 중 tradePlan READY (진입 가능)
    holdingPoolSize: holdingPool.length, // WAIT_PULLBACK + ENTRY_INVALIDATED + REBREAK_FADED
    pendingPoolSize: pendingPool.length, // NEED_INTRADAY_CONFIRM (09:30 분봉 미확인 — 신규 진입 후보 아님)
    reobservePoolSize: reobservePool.length, // 위험 필터 제외됐지만 dps/vmc 조건 만족 (재관찰)
    insufficientBarsExcluded: riskExcludeCounts.insufficient_bars || 0, // 분봉 부족 제외 (화면 미노출)
    topPriorityShown: topPriority.length,
    extraPriorityShown: extraPriority.length,
    overflowHidden: overflowPool.length, // READY 풀 16+ 위 — 화면 숨김
    riskExcluded: totalRiskExcluded,     // 위험 필터로 제외된 수
    riskExcludeBreakdown: riskExcludeCounts,
    riskExemptedCount,                   // morningHigh 재돌파로 위험 면제된 mainPool 후보 수
  };

  // 백테스트 dayType + 시장 상태 로드
  const latestDayType = loadLatestDayType();
  const marketState = classifyMarketState();

  // 분봉 적용 상태
  const entryStatusCounts = { ok: 0, no_dir: 0, no_minute_data: 0, intraday_invalid: 0 };
  for (const it of all) {
    if (it.entryStatus === 'OK') entryStatusCounts.ok++;
    else if (it.entryStatus === 'NO_DIR') entryStatusCounts.no_dir++;
    else if (it.entryStatus === 'NO_MINUTE_DATA') entryStatusCounts.no_minute_data++;
    else if (it.entryStatus === 'INTRADAY_INVALID') entryStatusCounts.intraday_invalid++;
  }
  // 분봉 적용된 candidate들이 가리키는 nextDayDir (모두 같은 거래일이어야 함; 다르면 가장 흔한 거 선택)
  // 단, 가장 최신 intraday dir 기준 5일 이상 오래된 후보는 stale로 보고 entryConfirmDate 결정에서 제외.
  // (drop 이유: 일부 종목의 chart 캐시가 비어서 baseDate가 2024년 같은 옛 날짜로 떨어지면
  //  findNextDayDir이 그 옛 baseDate의 다음 날(예: 2026-04-28)을 가리키게 되어 전체 운영 보드의
  //  targetDateForResult가 옛 날짜로 오염되는 사례 방지.)
  const _intradayDirsForCutoff = loadIntradayDirs();
  const _latestIntradayDir = _intradayDirsForCutoff.length ? _intradayDirsForCutoff[_intradayDirsForCutoff.length - 1] : null;
  const _cutoffMs = _latestIntradayDir ? new Date(_latestIntradayDir + 'T00:00:00Z').getTime() - 5 * 24 * 3600 * 1000 : null;
  const nextDirFreq = new Map();
  for (const it of all) {
    if (!it.nextDayDir) continue;
    if (_cutoffMs != null) {
      const ms = new Date(it.nextDayDir + 'T00:00:00Z').getTime();
      if (ms < _cutoffMs) continue; // stale chart 후보 제외
    }
    nextDirFreq.set(it.nextDayDir, (nextDirFreq.get(it.nextDayDir) || 0) + 1);
  }
  let entryConfirmDate = null, entryConfirmFreq = 0;
  for (const [d, n] of nextDirFreq) { if (n > entryConfirmFreq) { entryConfirmFreq = n; entryConfirmDate = d; } }
  // entryConfirmDate가 못 잡히면 (휴장일/주말 프리뷰 — 모든 후보가 NO_DIR) 가장 최신 intraday dir로 폴백.
  // 이것도 없으면 analysisDate를 YYYY-MM-DD로 변환해서 사용.
  if (!entryConfirmDate) {
    if (_latestIntradayDir) entryConfirmDate = _latestIntradayDir;
    else if (analysisDate && analysisDate.length === 8) {
      entryConfirmDate = analysisDate.slice(0, 4) + '-' + analysisDate.slice(4, 6) + '-' + analysisDate.slice(6, 8);
    }
  }

  // 🔥 공격형 TOP 1DS 계산 (BIG_MONEY_REBREAK 기반, lookahead-safe)
  // BIG RUNNER 감사 보고서 검증 결과: --days 20 / --days 100 모두 strong 등급 통과 (Top 1)
  // 기존 후보 산출 로직 무수정, 별도 함수로 추가 분석만 진행.
  const attackTopResult = buildAttackTopFromCandidates(all);
  // 근본 수정: decisionPrice를 분봉 09:30 close로 고정 (cron 시각 / 분봉 윈도우 무관)
  // 이전 동작: globalMaxBarTime이 풀-데이 분봉 시 15:30이 되어 decisionPrice가 종가로 잡히는 버그.
  // 1DS 의미는 항상 "09:30 진입가 기준" — 분봉 09:30 bar의 close가 정본.
  let _fixed0930 = 0;
  for (const c of attackTopResult.candidates || []) {
    if (!c || !c.targetDir || !c.code) continue;
    const fp = path.join(INTRADAY_BASE, c.targetDir, c.code + '.json');
    if (!fs.existsSync(fp)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      const bar0930 = (d.bars || []).find((b) => b && b.time === '09:30' && Number.isFinite(b.close));
      if (!bar0930) continue;
      const newPrice = bar0930.close;
      if (!(newPrice > 0) || newPrice === c.decisionPrice) continue;
      c.decisionPrice = newPrice;
      c.decisionTime  = '09:30';
      c.signalPrice   = newPrice;
      if (Number.isFinite(c.prevClose) && c.prevClose > 0) c.decisionFromPrevClose = +((newPrice / c.prevClose - 1) * 100).toFixed(2);
      if (Number.isFinite(c.open0900) && c.open0900 > 0)  c.decisionFromOpen      = +((newPrice / c.open0900 - 1) * 100).toFixed(2);
      _fixed0930++;
    } catch (_) { /* skip */ }
  }
  if (_fixed0930 > 0) console.log(`  🔧 attackTop decisionPrice 09:30 분봉 close로 ${_fixed0930}건 고정 (풀-데이 분봉 사용 시 종가로 빠지는 버그 차단)`);
  console.log(`  🔥 공격형 TOP 1DS: ${attackTopResult.summary.count}개 (BIG_MONEY_REBREAK 통과 — 거래대금 상위 10% + 장초 고가 재돌파)`);
  if (attackTopResult.summary.generatedAtDecisionTime) {
    console.log(`     기준 시점: ${attackTopResult.summary.generatedAtDecisionTime} (${attackTopResult.summary.decisionMode.label}) — ${attackTopResult.summary.candidatesWithMinute}/${attackTopResult.summary.totalCandidates}건 분봉 가용`);
  }

  // ── 📊 시장 상태 + 오늘 결과 ───────────────────────────────────
  // 장중: 결과 미확정 표시만. 장마감 후: attackTop / 전체 1DS의 당일 일봉 결과 집계.
  // 기존 1DS / attackTop 산출 로직 무수정 — 결과 필드만 추가 부착.
  const marketStatus = getMarketStatus(CLI_FORCE_MARKET_STATUS);
  console.log(`  📊 시장 상태: ${marketStatus.label} (${marketStatus.status}, KST ${marketStatus.generatedAtTime})${marketStatus.forcedNote ? ' — ' + marketStatus.forcedNote : ''}`);

  // 결과 계산용 targetDate (후보들이 활동한 거래일)
  // 우선순위: entryConfirmDate (operational, next day intraday's date)
  //          → analysisDate (baseDate, weekend/local preview)
  const targetDateForResult = entryConfirmDate || analysisDate || null;
  const targetDateYYYYMMDD = targetDateForResult ? targetDateForResult.replace(/-/g, '') : null;

  // 휴장일이면 previousTradingDate를 실제 보드 데이터의 targetDate로 정정 (간단 holiday list 오차 보정)
  if (marketStatus.status === 'holiday_closed' && targetDateForResult) {
    marketStatus.previousTradingDate = targetDateForResult;
    marketStatus.guide = `오늘은 휴장일입니다 (주말/공휴일/대체공휴일). 직전 거래일 (${targetDateForResult}) 기준 결과를 표시합니다.`;
  }

  let todayResultSummary = {
    isAvailable: false, targetDate: targetDateForResult, total1ds: all.length, attackTopCount: attackTopResult.candidates.length,
    attackTopBig10: 0, attackTopBig15: 0, attackTopBig20: 0, attackTopCloseStrong: 0, attackTopFailed: 0,
    all1dsBig10: 0, all1dsBig15: 0, all1dsBig20: 0, all1dsCloseStrong: 0, all1dsFailed: 0,
    bigMoneyRebreakBig10: 0, bigMoneyRebreakBig15: 0, bigMoneyRebreakBig20: 0,
    rebreakWithValueBig10: 0, secondWaveBig10: 0,
    riskTagResult: { riskCount: 0, riskBig10: 0, noRiskCount: 0, noRiskBig10: 0 },
    missingResultPriceCount: 0,
    avgAttackTopDayHigh: null, avgAttackTopDayClose: null,
    avgAll1dsDayHigh: null, avgAll1dsDayClose: null,
    notes: [],
  };
  let todayResultCandidates = { mainResult: [], attackTop: [], big10: [], big15: [], big20: [], failed: [], spikeFade: [] };

  if (marketStatus.isMarketClosed) {
    if (!targetDateYYYYMMDD) {
      todayResultSummary.notes.push('targetDate 결정 불가 — 분석 기준일/entryConfirmDate 모두 없음.');
    } else {
      // 1) attackTop에 결과 부착 (decisionPrice + 각 후보의 targetDir 사용 — 분봉 로드한 실제 거래일)
      // 사용자 워크플로: 09:30~10:00 진입 판단 후 장 끝 확인 → 박스에 "10시 시점 결과" + "장 마감 결과" 둘 다.
      const attackTopWithResult = [];
      let attackMissingPrice = 0;
      for (const c of attackTopResult.candidates) {
        if (!(c.decisionPrice > 0)) { attackMissingPrice++; continue; }
        // 각 후보의 실제 거래일 (targetDir = YYYY-MM-DD) → YYYYMMDD
        const perCandTarget = c.targetDir ? c.targetDir.replace(/-/g, '') : targetDateYYYYMMDD;
        const r = calculateCandidateDayResult(c.code, c.decisionPrice, perCandTarget);
        const t = assignResultTags(r);
        c.dayResult = { ...r, resultTargetDate: c.targetDir || targetDateForResult, resultTags: t.tags, resultLabel: t.label, resultComment: t.comment };
        // 10시 시점 결과 (분봉 09:00~10:00 안의 OHLC, decisionPrice 기준)
        if (c.targetDir) {
          const er = getEarlyResultFromIntraday(c.code, c.targetDir, c.decisionPrice);
          if (er) c.earlyResult = er;
        }
        if (r.available) attackTopWithResult.push(c);
      }
      // 2) 전체 1DS 후보에 결과 부착
      //    각 후보의 nextDayDir 우선 사용 (운영 모드: today's intraday → today's daily row).
      //    nextDayDir이 없으면 baseDate dir로 fallback (weekend preview).
      //    basePrice: it.intraday.close_0930 → it.intraday.entryPrice → it.close.
      let allWithResult = [];
      let allMissingPrice = 0;
      function itTargetDir(it) {
        if (it.nextDayDir) return it.nextDayDir;
        if (it.baseDate && it.baseDate.length === 8) {
          return it.baseDate.slice(0, 4) + '-' + it.baseDate.slice(4, 6) + '-' + it.baseDate.slice(6, 8);
        }
        return null;
      }
      for (const it of all) {
        // basePrice는 반드시 morning 진입 기준가 (09:30 close)여야 의미 있음.
        // D close를 basePrice로 쓰면 같은 날 dayHigh와 비교 시 dayHigh>=dayClose가 trivially 성립해 결과가 왜곡됨.
        // → it.intraday.close_0930 또는 it.intraday.entryPrice만 사용. 둘 다 없으면 skip.
        const basePrice = (it.intraday && Number.isFinite(it.intraday.close_0930) ? it.intraday.close_0930
                         : it.intraday && Number.isFinite(it.intraday.entryPrice) ? it.intraday.entryPrice
                         : null);
        if (!(basePrice > 0)) { allMissingPrice++; continue; }
        // perDir: 진입가가 it.intraday에서 왔으므로 it.nextDayDir이 반드시 있어야 함.
        const perDir = it.nextDayDir;
        const perTarget = perDir ? perDir.replace(/-/g, '') : null;
        if (!perTarget) { allMissingPrice++; continue; }
        const r = calculateCandidateDayResult(it.code, basePrice, perTarget);
        if (!r.available) { allMissingPrice++; continue; }
        const t = assignResultTags(r);
        it.dayResult = { ...r, resultTargetDate: perDir,
                          basePriceSource: (it.intraday?.close_0930 ? 'intraday_0930' : 'intraday_entry'),
                          resultTags: t.tags, resultLabel: t.label, resultComment: t.comment };
        allWithResult.push(it);
      }
      // 3) 집계
      function countBy(list, pred) { return list.filter(pred).length; }
      function avgBy(list, getter) {
        const xs = list.map(getter).filter((x) => Number.isFinite(x));
        return xs.length ? Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2)) : null;
      }
      todayResultSummary.isAvailable = true;
      todayResultSummary.targetDate = targetDateForResult;
      todayResultSummary.attackTopBig10        = countBy(attackTopWithResult, (c) => c.dayResult.reached10);
      todayResultSummary.attackTopBig15        = countBy(attackTopWithResult, (c) => c.dayResult.reached15);
      todayResultSummary.attackTopBig20        = countBy(attackTopWithResult, (c) => c.dayResult.reached20);
      todayResultSummary.attackTopBig25        = countBy(attackTopWithResult, (c) => c.dayResult.reached25);
      todayResultSummary.attackTopCloseStrong  = countBy(attackTopWithResult, (c) => c.dayResult.closeStrong);
      todayResultSummary.attackTopFailed       = countBy(attackTopWithResult, (c) => c.dayResult.failedSpike);
      todayResultSummary.attackTopSpikeFade    = countBy(attackTopWithResult, (c) => c.dayResult.spikeFade);
      todayResultSummary.avgAttackTopDayHigh   = avgBy(attackTopWithResult, (c) => c.dayResult.dayHighReturn);
      todayResultSummary.avgAttackTopDayClose  = avgBy(attackTopWithResult, (c) => c.dayResult.dayCloseReturn);

      todayResultSummary.all1dsBig10        = countBy(allWithResult, (it) => it.dayResult.reached10);
      todayResultSummary.all1dsBig15        = countBy(allWithResult, (it) => it.dayResult.reached15);
      todayResultSummary.all1dsBig20        = countBy(allWithResult, (it) => it.dayResult.reached20);
      todayResultSummary.all1dsBig25        = countBy(allWithResult, (it) => it.dayResult.reached25);
      todayResultSummary.all1dsCloseStrong  = countBy(allWithResult, (it) => it.dayResult.closeStrong);
      todayResultSummary.all1dsFailed       = countBy(allWithResult, (it) => it.dayResult.failedSpike);
      todayResultSummary.all1dsWithResult   = allWithResult.length;
      todayResultSummary.avgAll1dsDayHigh   = avgBy(allWithResult, (it) => it.dayResult.dayHighReturn);
      todayResultSummary.avgAll1dsDayClose  = avgBy(allWithResult, (it) => it.dayResult.dayCloseReturn);

      // attackTop과 모든 1DS는 사실상 같은 집합 (attackTop은 BIG_MONEY_REBREAK 필터한 부분집합)
      // BIG_MONEY_REBREAK = attackTop과 동일 (현재 정의상)
      todayResultSummary.bigMoneyRebreakBig10 = todayResultSummary.attackTopBig10;
      todayResultSummary.bigMoneyRebreakBig15 = todayResultSummary.attackTopBig15;
      todayResultSummary.bigMoneyRebreakBig20 = todayResultSummary.attackTopBig20;
      todayResultSummary.rebreakWithValueBig10 = countBy(attackTopWithResult, (c) => c.dayResult.reached10 && c.rebreakWithValue);
      todayResultSummary.secondWaveBig10       = countBy(attackTopWithResult, (c) => c.dayResult.reached10 && c.valueSecondWaveRatio != null && c.valueSecondWaveRatio >= 1.2);

      const withRisk    = attackTopWithResult.filter((c) => Array.isArray(c.riskTags) && c.riskTags.length > 0);
      const withoutRisk = attackTopWithResult.filter((c) => !Array.isArray(c.riskTags) || c.riskTags.length === 0);
      todayResultSummary.riskTagResult = {
        riskCount: withRisk.length,
        riskBig10: countBy(withRisk, (c) => c.dayResult.reached10),
        riskBig15: countBy(withRisk, (c) => c.dayResult.reached15),
        noRiskCount: withoutRisk.length,
        noRiskBig10: countBy(withoutRisk, (c) => c.dayResult.reached10),
        noRiskBig15: countBy(withoutRisk, (c) => c.dayResult.reached15),
      };
      todayResultSummary.missingResultPriceCount = attackMissingPrice + allMissingPrice;
      if (allWithResult.length === 0 && attackTopWithResult.length === 0) {
        todayResultSummary.notes.push(`오늘 일봉 데이터(${targetDateYYYYMMDD})가 아직 저장되지 않았거나 분봉 미수집으로 결과 미확정.`);
        todayResultSummary.isAvailable = false;
      }

      // candidate 카드용 데이터 (light shape — 카드 표시에 필요한 필드만)
      function lightCard(it, src) {
        const r = it.dayResult || {};
        const o = src === 'attack' ? it : null;
        return {
          code: it.code, name: it.name, market: it.market || null,
          source: src,                 // 'attack' | 'all'
          attackRank: o ? o.attackRank : null,
          gtBand: it.gtBand || it.gtGroup || null,
          basePrice: r.basePrice ?? null,
          dayHigh: r.dayHigh ?? null, dayClose: r.dayClose ?? null, dayLow: r.dayLow ?? null,
          dayHighReturn: r.dayHighReturn ?? null,
          dayCloseReturn: r.dayCloseReturn ?? null,
          dayLowReturn: r.dayLowReturn ?? null,
          highCloseDrop: r.highCloseDrop ?? null,
          reached5: !!r.reached5, reached10: !!r.reached10, reached15: !!r.reached15, reached20: !!r.reached20, reached25: !!r.reached25,
          closeStrong: !!r.closeStrong, spikeFade: !!r.spikeFade, failedSpike: !!r.failedSpike,
          resultTags: r.resultTags || [], resultLabel: r.resultLabel || '', resultComment: r.resultComment || '',
          attackTags: o ? (o.attackTags || []) : null,
          riskTags:   o ? (o.riskTags   || []) : null,
        };
      }
      todayResultCandidates.attackTop = attackTopWithResult
        .slice()
        .sort((a, b) => (b.dayResult.dayHighReturn || 0) - (a.dayResult.dayHighReturn || 0))
        .map((c) => lightCard(c, 'attack'));
      // BIG10/BIG15/BIG20 (전체 1DS에서) — attackTop 포함 여부 표시
      const attackCodes = new Set(attackTopWithResult.map((c) => c.code));
      function pickBig(list, minHigh, limit) {
        return list.filter((it) => (it.dayResult.dayHighReturn || 0) >= minHigh)
          .slice().sort((a, b) => (b.dayResult.dayHighReturn || 0) - (a.dayResult.dayHighReturn || 0))
          .slice(0, limit)
          .map((it) => {
            const c = lightCard(it, attackCodes.has(it.code) ? 'attack' : 'all');
            c.inAttackTop = attackCodes.has(it.code);
            return c;
          });
      }
      todayResultCandidates.big10 = pickBig(allWithResult, 10, 30);
      todayResultCandidates.big15 = pickBig(allWithResult, 15, 30);
      todayResultCandidates.big20 = pickBig(allWithResult, 20, 30);
      todayResultCandidates.failed = allWithResult.filter((it) => it.dayResult.failedSpike)
        .slice().sort((a, b) => (a.dayResult.dayCloseReturn || 0) - (b.dayResult.dayCloseReturn || 0))
        .slice(0, 20).map((it) => lightCard(it, attackCodes.has(it.code) ? 'attack' : 'all'));
      todayResultCandidates.spikeFade = allWithResult.filter((it) => it.dayResult.spikeFade)
        .slice().sort((a, b) => (b.dayResult.highCloseDrop || 0) - (a.dayResult.highCloseDrop || 0))
        .slice(0, 20).map((it) => lightCard(it, attackCodes.has(it.code) ? 'attack' : 'all'));

      // mainResult: 오늘 09:30 스냅샷의 survivor1000 + attackTop 결과 계산
      // 스냅샷 날짜를 result 기준일로 사용 (외부 targetDateYYYYMMDD와 무관)
      // 표시 기준: 전일종가 대비 % (오늘 어디까지 갔다 어디까지 떨어졌고 어떻게 끝났나)
      {
        const _sd = KST_TODAY_NUM.slice(0,4)+'-'+KST_TODAY_NUM.slice(4,6)+'-'+KST_TODAY_NUM.slice(6,8);
        const _snapPath = path.join(REPORTS_DIR, `one-day-surge-0930-snapshot-${_sd}.json`);
        // 전일종가 추출 (차트의 target row 직전 거래일 close)
        function _prevClose(code, targetYYYYMMDD) {
          const rows = loadResultChartRows(code);
          if (!rows) return null;
          const idx = rows.findIndex(r => String(r.date) === targetYYYYMMDD);
          if (idx <= 0) return null;
          return rows[idx - 1].close ?? null;
        }
        function _pct(num, denom) {
          if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return null;
          return +((num / denom - 1) * 100).toFixed(2);
        }
        if (fs.existsSync(_snapPath)) {
          try {
            const snap = JSON.parse(fs.readFileSync(_snapPath, 'utf-8'));
            const _snapDateStr = snap.snapshotDate || _sd;
            const _snapTarget = _snapDateStr.replace(/-/g, '');
            const seen = new Set();
            function pushItem(code, name, basePrice, source) {
              if (!code || seen.has(code)) return;
              seen.add(code);
              if (!(basePrice > 0)) return;
              const r = calculateCandidateDayResult(code, basePrice, _snapTarget);
              if (!r.available) return;
              // DB 저장용 — 결과가 측정된 실제 거래일을 dayResult에 기록 (snapshot 날짜와 동일)
              r.resultTargetDate = _snapDateStr;
              const pt = getPeakTroughTime(code, _snapDateStr);
              const prevClose = _prevClose(code, _snapTarget);
              // 전일종가 대비 % (사용자 요청: 기준가 기준 X)
              const prevRefHigh  = _pct(r.dayHigh,  prevClose);
              const prevRefLow   = _pct(r.dayLow,   prevClose);
              const prevRefClose = _pct(r.dayClose, prevClose);
              todayResultCandidates.mainResult.push({
                code, name, basePrice, basePriceSource: source,
                prevClose,
                dayHigh: r.dayHigh, dayLow: r.dayLow, dayClose: r.dayClose,
                prevRefHigh, prevRefLow, prevRefClose,
                dayResult: r, resultTags: assignResultTags(r).tags,
                peakTime: pt?.peakTime || null, troughTime: pt?.troughTime || null,
              });
            }
            for (const s of (snap.survivor1000 || [])) pushItem(s.code, s.name, s.metrics?.last0930, 'survivor1000');
            for (const c of (snap.attackTopCandidates || [])) pushItem(c.code, c.name, c.decisionPrice, 'attackTop');
            // 조기 포착(explosiveStable) — survivor1000에 흡수 안 된 09:30 조기 포착 후보
            for (const e of (snap.explosiveStable || [])) pushItem(e.code, e.name, e.metrics?.last0930, 'explosiveStable');
            console.log(`     mainResult: ${todayResultCandidates.mainResult.length}종목 (스냅샷 ${_snapDateStr}, 전일종가 기준)`);
          } catch(e) {
            console.warn(`  ⚠ mainResult 계산 실패: ${e.message}`);
          }
        } else {
          console.log(`     mainResult: 스냅샷 없음 (${_snapPath})`);
        }
      }

      console.log(`  📊 오늘 결과 (targetDate ${targetDateForResult}):`);
      console.log(`     1DS 전체 ${allWithResult.length}개 결과 가능 / 결과 미계산 ${allMissingPrice}건`);
      console.log(`     공격형 TOP ${attackTopWithResult.length}개 결과 가능`);
      console.log(`     공격형 TOP — BIG10 ${todayResultSummary.attackTopBig10} / BIG15 ${todayResultSummary.attackTopBig15} / BIG20 ${todayResultSummary.attackTopBig20} / 종가유지 ${todayResultSummary.attackTopCloseStrong} / 실패 ${todayResultSummary.attackTopFailed}`);
      console.log(`     전체 1DS  — BIG10 ${todayResultSummary.all1dsBig10} / BIG15 ${todayResultSummary.all1dsBig15} / BIG20 ${todayResultSummary.all1dsBig20} / 종가유지 ${todayResultSummary.all1dsCloseStrong} / 실패 ${todayResultSummary.all1dsFailed}`);
    }
  } else {
    console.log(`  📊 오늘 결과: 장중 — 결과 미확정 (장마감 후 자동 표시)`);
  }

  const out = {
    meta: {
      title: '1-Day Surge Board v5 · GOOD_TRADE 중심 단타 후보 보드',
      generatedAt: new Date().toISOString(),
      analysisDate,
      analysisDateFmt: analysisDate ? fmtDate(analysisDate) : null,
      stockUniverse: files.length,
      candidateTotal: candidates.length,
      shownTotal: all.length,
      basis: '일봉 캐시 기준. 실시간 분봉/호가 미사용. 우선주/ETF/리츠/스팩/관리종목/시총 5조↑·500억↓ 제외. v4-extra2 검증 결과 반영 GT 그룹 체계.',
      filterConfig: {
        marketCapHardMin: core.CONFIG.MARKET_CAP_HARD_MIN,
        marketCapHardMax: core.CONFIG.MARKET_CAP_HARD_MAX,
      },
    },
    counts: Object.assign(
      {},
      ...GT_GROUP_ORDER.map(g => ({ [g]: grouped[g].length })),
      {
        unclassified,
        valueSurgeCount,
        lowGapCount,
        highVmcCount,
        filterRejected: filterCounts,
        skippedNoMetrics,
        parseErrCount,
      }
    ),
    groups: grouped,
    groupOrder: GT_GROUP_ORDER,
    groupLabels: FRIENDLY_GROUP_LABELS,        // 운영자 친화 라벨 (내부명 ENTRY_CONFIRM/SAFE 노출 방지)
    groupDescriptions: core.GT_GROUP_DESC,
    visibilityCounts,
    themeWatchPoolSummary,
    priorityRanked: {
      // 09:30 분봉 반영 후 status별 분리:
      // topPriority/extraPriority = READY 후보만 (진입 가능)
      // holdingCandidates       = WAIT_PULLBACK / ENTRY_INVALIDATED / REBREAK_FADED (보류/재관찰)
      // reobserveCandidates     = peak_before_entry / trap_risk_high로 빠진 후보 중 dps/vmc 조건 통과 (재관찰)
      topPriority:    topPriority.map((it) => it.code),
      extraPriority:  extraPriority.map((it) => it.code),
      holdingCandidates:   holdingPool.map((it) => it.code),
      pendingCandidates:   pendingPool.map((it) => it.code),
      reobserveCandidates: reobservePool.map((it) => it.code),
      overflowHiddenCount: overflowPool.length,
      topPriorityLimit:   TOP_PRIORITY_LIMIT,
      extraPriorityLimit: EXTRA_PRIORITY_LIMIT,
      // 위험 필터 통과한 추천 풀 전체 코드 (READY + holding). collect-1ds-intraday.js --from-board 가 이 리스트로 분봉 수집.
      mainPoolCodes: mainPool.map((it) => it.code),
      // ── 09:30 실시간 스캐너 결과 (전일 mainPool과 무관) ──
      // scanner JSON이 있으면 그대로 통합. 없으면 null — 보드는 "스캔 미실행" 안내 표시.
      scanner0930: (function () {
        const sc = loadScanner0930();
        if (!sc) return null;
        const m = sc.meta || {};
        return {
          nextDate: m.nextDate,
          mode: m.mode || 'quick',
          candidatesTarget: m.candidatesTarget || null,
          scannedCount: m.scannedCount || 0,
          successCount: m.successCount || 0,
          startedAt: m.startedAt,
          finishedAt: m.finishedAt,
          elapsedSec: m.elapsedSec,
          generatedAt: m.generatedAt,
          counts: sc.counts,
          statusLabels: sc.statusLabels,
          ready:     sc.scanner0930Ready     || [],   // 호환성 — readyTop + readyRest 합본
          readyTop:  sc.scanner0930ReadyTop  || [],   // 상위 5 (실전 우선 후보)
          readyRest: sc.scanner0930ReadyRest || [],   // 6번째 이후 (1차 통과 후보)
          readyTopLimit: sc.readyTopLimit || 5,
          wait:      sc.scanner0930Wait      || [],   // WAIT_PULLBACK 단독 — 추격 부담
          faded:     sc.scanner0930Faded     || [],   // FADED 단독 (카드 노출 X, 통계만)
          holding:   sc.scanner0930Holding   || [],   // 호환성 (기존 코드 잔존)
          rejected:  sc.scanner0930Rejected  || [],   // WEAK (카드 노출 X, 통계만)
          explosiveTop:   sc.scanner0930ExplosiveTop   || [],   // 🚀 폭발형 후보 (호환성 유지)
          explosiveWatch: sc.scanner0930ExplosiveWatch || [],   // 🚀 폭발형 관찰 후보 (호환성 유지)
          explosiveCounts: sc.explosiveCounts || null,
          // ── 60거래일 백테스트 결과 기반 신규 5섹션 구조 (2026-05-14) ──
          // 우선순위: survivor1000 > explosiveStable > attackRebreak > readyRestFinal > watchOnly
          survivor1000:    sc.scanner0930Survivor1000    || [],  // ✅ [1] 10시 생존 확인 후보 (메인, 60일 검증 1위)
          explosiveStable: sc.scanner0930ExplosiveStable || [],  // 🚀 [2] 09:30 조기 포착 후보 (explosiveTop, survivor 제외)
          attackRebreak:   sc.scanner0930AttackRebreak   || [],  // 🔥 [3] 공격형 재돌파 감시 후보 (survivor + explosiveStable 제외)
          readyRestFinal:  sc.scanner0930ReadyRestFinal  || [],  // 📡 [4] 09:30 READY 1차 후보
          watchOnly:       sc.scanner0930WatchOnly       || [],  // 👀 [5] 관찰/제외 후보
          survivor1000Ready: !!sc.survivor1000Ready,             // 10:00 분봉 도달 여부 (false면 "확인 대기")
          summary:         sc.summary || null,                   // { readyCount, survivor1000Count, ..., mainSectionLabel }
          suggestedStrategies: sc.suggestedStrategies || null,
        };
      })(),
    },
    latestDayType,
    marketState,
    qvaSummary,
    summary: {
      tradePlan: tradePlanSummary,
    },
    entryShelf: {
      // 신규 priorityRanked로 대체됐지만, strategyDefs/counts는 카드 chip + 요약에 계속 필요
      strategyDefs: Object.fromEntries(Object.entries(ENTRY_STRATEGY_DEFS).map(([k, v]) => [k, { label: v.label, chipLabel: v.chipLabel, desc: v.desc, isTopShelf: v.isTopShelf }])),
      topStrategies: ENTRY_TOP_STRATEGIES,
      bottomStrategies: ENTRY_BOTTOM_STRATEGIES,
      strategyCounts,
      entryStatusCounts,
      entryConfirmDate,
      entryConfirmDateFreq: entryConfirmFreq,
      withMinute,
      missing,
      analysisDateConfirmReady: !!findNextDayDir(analysisDate || '', intradayDirs),
      analysisDateNextDir: analysisDate ? findNextDayDir(analysisDate, intradayDirs) : null,
    },
    // 🔥 공격형 TOP 1DS — 기존 1DS 후보 중 BIG_MONEY_REBREAK 통과 (60일 감사 strong 등급)
    attackTopSummary: attackTopResult.summary,
    attackTopCandidates: attackTopResult.candidates,
    // 📊 시장 상태 + 오늘 결과 — 장중에는 안내만, 장마감 후 일봉 기준 결과 표시
    marketStatus,
    todayResultSummary,
    todayResultCandidates,
  };

  // ── 표시 정책 후처리 (1DS 본체 탐지 로직 무수정 — 분류/표시만 정리) ──
  // 이미 상한가 근접까지 진행된 후보를 "🚀 이미 크게 발화한 종목" 섹션으로,
  // 위험 자동 제외 후보를 "⚠ 관찰/제외 후보" 섹션으로 메인에서 분리.
  applyDisplayPolicyPostProcess(out, all);
  const _sc = out.priorityRanked?.scanner0930 || {};
  console.log(`\n📋 표시 정책 후처리:`);
  console.log(`  ✅ 10시 생존 확인:                 ${(_sc.survivor1000||[]).length}건`);
  console.log(`  ⚡ 09:30 강한 후보 (조기 포착):    ${(_sc.explosiveStable||[]).length}건`);
  console.log(`  🔥 공격형 TOP (NORMAL):            ${(out.attackTopCandidates||[]).length}건`);
  console.log(`  ⚠ 고위험 공격형 TOP (HIGH_RISK):   ${(out.attackTopHighRisk||[]).length}건`);
  console.log(`  🔥 공격형 재돌파 (scanner):        ${(_sc.attackRebreak||[]).length}건`);
  console.log(`  🚀 이미 크게 발화 (≥+${ALREADY_FIRED_RATE_THRESHOLD}%):     ${(_sc.alreadyFired||[]).length}건`);
  console.log(`  👀 관찰/제외 (기존 watchOnly):     ${(_sc.watchOnly||[]).length}건`);
  // 흥아해운 / 아이로보틱스 / 아이씨티케이 분류 확인
  const _trace = (code, name) => {
    let where = '없음';
    if ((out.attackTopCandidates||[]).some(x=>x.code===code)) where = 'attackTopCandidates (🔥 공격형 NORMAL)';
    else if ((out.attackTopHighRisk||[]).some(x=>x.code===code)) where = 'attackTopHighRisk (⚠ 고위험 공격형)';
    else if ((_sc.survivor1000||[]).some(x=>x.code===code)) where = 'scanner.survivor1000 (✅ 10시 생존)';
    else if ((_sc.alreadyFired||[]).some(x=>x.code===code)) where = 'scanner.alreadyFired (🚀 이미 크게 발화)';
    else if ((_sc.explosiveStable||[]).some(x=>x.code===code)) where = 'scanner.explosiveStable (⚡ 09:30 강한 후보)';
    else if ((_sc.attackRebreak||[]).some(x=>x.code===code)) where = 'scanner.attackRebreak (🔥 공격형 재돌파)';
    else if ((_sc.readyRestFinal||[]).some(x=>x.code===code)) where = 'scanner.readyRestFinal (📡 1차)';
    else if ((_sc.watchOnly||[]).some(x=>x.code===code)) where = 'scanner.watchOnly (👀 관찰)';
    console.log(`  ${name}(${code}): ${where}`);
  };
  _trace('003280', '흥아해운');
  _trace('066430', '아이로보틱스');
  _trace('456010', '아이씨티케이');

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out)), 'utf-8');

  // 09:00~10:00 실행 (09:30 cron 한정) 또는 FORCE_0930_SNAPSHOT=1 이면 스냅샷 저장
  // 10:01~10:05 survivor cron은 제외 — 09:30 기준 attackTopCandidates를 보존해야 함
  // 16:35 cron이 이 스냅샷을 읽어 mainResult를 채움
  if ((KST_MIN >= 9*60 && KST_MIN < 10*60) || process.env.FORCE_0930_SNAPSHOT === '1') {
    const _sd = KST_TODAY_NUM.slice(0,4)+'-'+KST_TODAY_NUM.slice(4,6)+'-'+KST_TODAY_NUM.slice(6,8);
    const _snapPath = path.join(REPORTS_DIR, `one-day-surge-0930-snapshot-${_sd}.json`);
    const _snap = {
      snapshotDate: _sd,
      savedAt: new Date().toISOString(),
      survivor1000: out.priorityRanked?.scanner0930?.survivor1000 || [],
      explosiveStable: out.priorityRanked?.scanner0930?.explosiveStable || [],
      attackTopCandidates: out.attackTopCandidates || [],
    };
    fs.writeFileSync(_snapPath, JSON.stringify(_snap, null, 2));
    console.log(`  📸 09:30 스냅샷 저장 (${_sd}): survivor=${_snap.survivor1000.length}개 / explosive=${_snap.explosiveStable.length}개 / attackTop=${_snap.attackTopCandidates.length}개`);
  }

  // DB 저장 (실패해도 HTML/JSON은 이미 정상 저장됐으므로 보드 출력에 영향 없음)
  try {
    const { saveOneDaySurgeBoardToDB } = require('../../src/db/saveBoardSignals');
    const r = await saveOneDaySurgeBoardToDB(out, { jsonPath: OUT_JSON, htmlPath: OUT_HTML });
    if (r) console.log(`  🗄  DB 저장: runId=${r.runId} rows=${r.totalRows} (inserted=${r.inserted} updated=${r.updated})`);
  } catch (e) {
    console.warn(`  ⚠ DB 저장 실패 (HTML/JSON은 정상 저장됨): ${e.message}`);
  } finally {
    // 보드 generator는 일회성 spawn이므로 pool을 닫아서 process가 정상 종료되도록
    try { await require('../../src/db/mysql').closePool(); } catch (_) {}
  }

  console.log(`\n  분석 기준일: ${analysisDate ? fmtDate(analysisDate) : '-'} (가장 흔한 baseDate, 빈도 ${maxFreq})`);
  const fbHrMm = String(Math.floor(KST_MIN / 60)).padStart(2, '0') + ':' + String(KST_MIN % 60).padStart(2, '0');
  if (PARTIAL_BAR_FALLBACK_ENABLED) {
    console.log(`  ⓘ KST ${fbHrMm} (장 진행 중) — 부분 일봉 fallback 활성 (${partialBarFallbackCount}개 종목 → 어제 영업일로)`);
  } else {
    console.log(`  ⓘ KST ${fbHrMm} (장 마감 후) — 종가 확정 일봉 그대로 baseDate=오늘 사용 (내일 장초 후보 산출 모드)`);
  }
  console.log(`  필터 제외: ETF=${filterCounts.etf} 특수=${filterCounts.special} 키워드=${filterCounts.excluded_name} 시총미확인=${filterCounts.no_marketcap} <500억=${filterCounts.mc_under_500} ≥5조=${filterCounts.mc_over_5t}`);
  console.log(`  후보 풀: ${candidates.length}건 / 노출: ${all.length}건 / 미분류: ${unclassified}건`);
  for (const g of GT_GROUP_ORDER) console.log(`    ${g.padEnd(13)} ${grouped[g].length}건`);
  console.log(`  거래대금 ×3↑ ${valueSurgeCount} / LOW_GAP_INTRADAY ${lowGapCount} / v/mc≥10% ${highVmcCount}`);
  console.log(`  🎯 09:30 분봉 반영 후 화면 노출 정책:`);
  console.log(`     READY 진입 가능 후보       ${tradePlanSummary.readyCount}개  (메인 ${topPriority.length} + 추가 ${extraPriority.length}, overflow ${overflowPool.length})`);
  console.log(`     WAIT_PULLBACK 추격 부담     ${tradePlanSummary.waitPullbackCount}개`);
  console.log(`     ENTRY_INVALIDATED 흐름 약화 ${tradePlanSummary.invalidatedCount}개`);
  console.log(`     REBREAK_FADED 고점 후 밀림  ${tradePlanSummary.fadedCount}개`);
  console.log(`     NEED_INTRADAY_CONFIRM       ${tradePlanSummary.needConfirmCount || 0}개  (09:30 분봉 미확인 — 신규 진입 X)`);
  console.log(`     재관찰 후보                 ${reobservePool.length}개  (peak_before_entry/trap_risk_high 중 dps≥20+v/mc≥10)`);
  console.log(`     분봉 부족 제외              ${riskExcludeCounts.insufficient_bars || 0}개  (화면 미노출)`);
  console.log(`     위험 필터 제외              ${totalRiskExcluded}건:`);
  for (const [reason, n] of Object.entries(riskExcludeCounts)) {
    if (n > 0) console.log(`        - ${reason}: ${n}건`);
  }
  console.log(`     UNCLASSIFIED ${unclassified}건 (영구 숨김)`);
  if (latestDayType) console.log(`  🌊 최근 거래일 (${latestDayType.date} → ${latestDayType.nextDate}) 분류: ${latestDayType.dayType}`);
  console.log(`  📈 시장 상태: ${marketState.label}` + (marketState.kospi ? ` (KOSPI ${marketState.kospi.changeRate.toFixed(2)}% / KOSDAQ ${marketState.kosdaq?.changeRate?.toFixed(2) || '-'}%)` : ''));
  if (topPriority.length > 0) {
    console.log(`  📋 READY 최우선 ${topPriority.length}건 (displayPriorityScore):`);
    for (const it of topPriority) {
      const tagsStr = (it.entryStrategies || []).length > 0 ? ' [' + it.entryStrategies.join(',') + ']' : '';
      console.log(`     ${it.displayPriorityScore.toString().padStart(4)} | ${it.code} ${(it.name || '').padEnd(15)} | ${it.gtGroup}${tagsStr}`);
    }
  } else {
    console.log(`  📋 READY 최우선 0건 — 오늘 09:30 기준 장초 흐름 유지 후보 없음`);
  }
  if (reobservePool.length > 0) {
    console.log(`  👀 재관찰 후보 ${reobservePool.length}건:`);
    for (const it of reobservePool.slice(0, 10)) {
      console.log(`     dps=${(it.displayPriorityScore||0).toString().padStart(3)} v/mc=${(it.valueToMarketCapRatio||0).toFixed(1).padStart(5)}% | ${it.code} ${(it.name||'').padEnd(15)} | ${it.gtGroup} | 제외사유: ${it.riskExcluded}`);
    }
  }
  console.log(`  🚪 장초 ENTRY_CONFIRM 적용: ${withMinute}건 / 분봉 누락 ${missing}건 (확인 거래일 ${entryConfirmDate || '없음'})`);
  if (withMinute === 0) {
    console.log(`     장초 분봉 확인 전 — 다음 거래일 09:35+ 분봉 수집 후 보드 재생성 시 적용됩니다.`);
  }
  console.log(`  💰 trade plan 상태 (자동 계산 ${tradePlanSummary.autoCount}건 / 최대 ${tradePlanSummary.autoPlanLimit}건):`);
  console.log(`     READY              ${tradePlanSummary.readyCount}개 — 장초 흐름 유지 중`);
  console.log(`     WAIT_PULLBACK      ${tradePlanSummary.waitPullbackCount}개 — 이미 기준가보다 많이 올라 추격 부담`);
  console.log(`     ENTRY_INVALIDATED  ${tradePlanSummary.invalidatedCount}개 — 장초 기준가를 이탈해 흐름 약화`);
  console.log(`     REBREAK_FADED      ${tradePlanSummary.fadedCount}개 — 장초 고점 돌파 후 다시 밀림`);
  console.log(`     NEED_INTRADAY_CONFIRM ${tradePlanSummary.needConfirmCount || 0}개 — 09:30 분봉 확인 없음 (신규 진입 후보 아님)`);
  console.log(`     INSUFFICIENT_BARS  ${tradePlanSummary.insufficientCount}개 — 분봉 부족 (KIS 응답 누락)`);
  if (tradePlanSummary.missingPriceCount > 0) {
    console.log(`     MISSING_PRICE_DATA ${tradePlanSummary.missingPriceCount}개 — 가격 데이터 부족`);
  }
  // 09:30 실시간 스캐너 결과 요약 (있으면)
  const sc0930 = out.priorityRanked.scanner0930;
  if (sc0930) {
    const c = sc0930.counts || {};
    const modeTxt = sc0930.candidatesTarget
      ? `mode=${sc0930.mode} / 확장 ${sc0930.candidatesTarget}개 시도 → 분봉 ${sc0930.scannedCount}개 (${(sc0930.scannedCount / sc0930.candidatesTarget * 100).toFixed(1)}%)`
      : `mode=${sc0930.mode} / 분봉 ${sc0930.scannedCount || 0}개`;
    console.log(`  📡 09:30 실시간 스캐너 [${modeTxt}, ${sc0930.elapsedSec || 0}s]:`);
    console.log(`     READY              ${c.READY || 0}개`);
    console.log(`     WAIT_PULLBACK      ${c.WAIT_PULLBACK || 0}개`);
    console.log(`     FADED              ${c.FADED || 0}개`);
    console.log(`     WEAK               ${c.WEAK || 0}개`);
    console.log(`     INSUFFICIENT_BARS  ${c.INSUFFICIENT_BARS || 0}개`);
  } else {
    console.log(`  📡 09:30 실시간 스캐너: 미실행 (reports/one-day-surge-0930-scanner.json 없음)`);
  }
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>1-Day Surge Board v5 · 단타 관심 후보</title>
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
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #0f172a; border-left: 3px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #67e8f9; }
.warn-box { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }
.warn-box strong { color: #fcd34d; }
.filter-info { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 12px; font-size: 11px; color: #94a3b8; margin-bottom: 14px; line-height: 1.7; }
.filter-info strong { color: #cbd5e1; }

.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.summary-cell { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.summary-cell .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.summary-cell .value { font-size: 20px; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; margin-top: 4px; }
.summary-cell .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
.summary-cell.balanced { border-left: 4px solid #10b981; }
.summary-cell.light    { border-left: 4px solid #38bdf8; }
.summary-cell.mid      { border-left: 4px solid #a78bfa; }
.summary-cell.mom      { border-left: 4px solid #f97316; }
.summary-cell.heavy-w  { border-left: 4px solid #94a3b8; }
.summary-cell.micro    { border-left: 4px solid #fbbf24; }
.summary-cell.heavy-r  { border-left: 4px solid #ef4444; }
.summary-cell.entry-safe     { border-left: 4px solid #14b8a6; background: #042f2e; }
.summary-cell.entry-balanced { border-left: 4px solid #10b981; background: #052e1f; }
.summary-cell.entry-clean    { border-left: 4px solid #818cf8; background: #1e1b4b; }
.summary-cell.entry-light    { border-left: 4px solid #38bdf8; background: #0c2540; }
.summary-cell.entry-warn     { border-left: 4px solid #f59e0b; background: #422006; }

/* ── 장초 분봉 재상승 확인 섹션 ── */
.entry-shelf-banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 14px; font-size: 12px; line-height: 1.7; }
.entry-shelf-banner.ok   { background: #042f2e; border-left: 4px solid #14b8a6; color: #99f6e4; }
.entry-shelf-banner.warn { background: #1e293b; border-left: 4px solid #94a3b8; color: #cbd5e1; }
.entry-shelf-banner strong { color: #67e8f9; }

.entry-shelf-section { margin-bottom: 22px; padding: 14px 16px; border-radius: 10px; }
.entry-shelf-section.top    { background: linear-gradient(180deg, #042f2e 0%, #0f172a 60%); border: 1px solid #14b8a6; }
.entry-shelf-section.bottom { background: linear-gradient(180deg, #422006 0%, #0f172a 60%); border: 1px solid #f59e0b; }
.entry-shelf-section h2 { margin-top: 0; color: #f1f5f9; }
.entry-shelf-section .shelf-desc { font-size: 12px; color: #cbd5e1; margin-bottom: 12px; line-height: 1.7; }

/* 전략 chip — 카드 안에 표시되는 작은 태그 */
.strategy-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; line-height: 1.3; border: 1px solid; margin-right: 4px; }
.strategy-chip.SAFE_REBREAK     { background: #042f2e; color: #5eead4; border-color: #14b8a6; }
.strategy-chip.BALANCED_REBREAK { background: #052e1f; color: #6ee7b7; border-color: #10b981; }
.strategy-chip.CLEAN_REBREAK    { background: #1e1b4b; color: #c7d2fe; border-color: #818cf8; }
.strategy-chip.LIGHT_REBREAK    { background: #0c2540; color: #7dd3fc; border-color: #38bdf8; }
.strategy-chip.RISK_REBREAK     { background: #7c2d12; color: #fdba74; border-color: #f97316; }
.strategy-chip.PREV_HIGH_SPIKE  { background: #422006; color: #fbbf24; border-color: #ca8a04; }
.strategy-chip.PEAK_BEFORE_WARN { background: #7f1d1d; color: #fca5a5; border-color: #ef4444; font-weight: 800; }
.strategy-chip.RISK_EXEMPTED    { background: #422006; color: #fcd34d; border-color: #d97706; font-weight: 700; }

/* 시장 상태 banner */
.market-banner { padding: 10px 16px; border-radius: 8px; margin-bottom: 14px; font-size: 12px; line-height: 1.7; border-left: 4px solid; }
.market-banner.broad   { background: #042f2e; border-color: #14b8a6; color: #99f6e4; }
.market-banner.large   { background: #422006; border-color: #f59e0b; color: #fde68a; }
.market-banner.kosdaq  { background: #422006; border-color: #f97316; color: #fed7aa; }
.market-banner.weak    { background: #7f1d1d; border-color: #ef4444; color: #fca5a5; }
.market-banner.mixed   { background: #1e293b; border-color: #94a3b8; color: #cbd5e1; }
.market-banner.unknown { background: #1e293b; border-color: #475569; color: #94a3b8; }
.market-banner strong { color: #f1f5f9; }
.market-banner .idx-num { font-variant-numeric: tabular-nums; font-weight: 700; }
.market-banner .idx-num.pos { color: #6ee7b7; }
.market-banner .idx-num.neg { color: #fca5a5; }

/* dayType banner — 백테스트 latestDayType 표시 */
.daytype-banner { padding: 10px 16px; border-radius: 8px; margin-bottom: 14px; font-size: 12px; line-height: 1.7; border-left: 4px solid; }
.daytype-banner.HIT_AND_FADE_DAY { background: #1e3a8a; border-color: #3b82f6; color: #bfdbfe; }
.daytype-banner.HOLDING_DAY      { background: #064e3b; border-color: #10b981; color: #6ee7b7; }
.daytype-banner.WEAK_DAY         { background: #7f1d1d; border-color: #ef4444; color: #fca5a5; }
.daytype-banner.MIXED_DAY        { background: #1e293b; border-color: #94a3b8; color: #cbd5e1; }
.daytype-banner strong { color: #f1f5f9; }

/* ── 운영자 상단 상태 배너 (sticky 컴팩트 카드) ── */
/* sticky: 카드 목록 아래로 스크롤해도 상단 고정 — 보드 상태 + 시계 + 새로고침 항상 보임 */
.status-banner-host-wrap {
  position: sticky;
  top: 0;
  z-index: 100;
  margin-left: -24px;     /* body padding 24px를 상쇄 → viewport 양 끝까지 */
  margin-right: -24px;
  margin-top: -18px;       /* body padding-top 18px를 상쇄 → viewport 최상단 부착 */
  margin-bottom: 14px;
  background: #0f172a;     /* sticky 시 뒷배경 노출 방지 */
  border-bottom: 1px solid #1e293b;
  box-shadow: 0 2px 8px -4px rgba(0,0,0,0.6);
}
.status-banner { padding: 10px 24px; border-left: 5px solid; display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: center; }
.status-banner .status-body .status-label { font-size: 10px; font-weight: 600; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 2px; }
.status-banner .status-body .status-title { font-size: 15px; font-weight: 700; line-height: 1.3; margin-bottom: 3px; color: #f1f5f9; }
.status-banner .status-body .status-desc  { font-size: 12px; line-height: 1.55; opacity: 0.92; }
.status-banner .status-body .status-action { font-size: 11px; margin-top: 4px; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,0.07); display: inline-block; }
.status-banner .status-action-area { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
.status-banner .status-clock { font-size: 12px; font-variant-numeric: tabular-nums; color: #f1f5f9; font-weight: 600; opacity: 0.95; white-space: nowrap; }
.status-banner .status-clock .lbl { font-size: 9px; font-weight: 400; opacity: 0.7; margin-right: 3px; text-transform: uppercase; letter-spacing: 0.4px; }
.status-banner .reload-btn { padding: 6px 12px; font-size: 12px; font-weight: 700; border-radius: 6px; border: 1px solid; cursor: pointer; transition: transform 0.1s; white-space: nowrap; }
.status-banner .reload-btn:hover { transform: translateY(-1px); }

.status-banner.previous-close { background: linear-gradient(180deg,#1e293b 0%,#0f172a 80%); border-color: #64748b; color: #cbd5e1; }
.status-banner.previous-close .reload-btn { background: #475569; border-color: #64748b; color: #f1f5f9; }
.status-banner.waiting        { background: linear-gradient(180deg,#422006 0%,#0f172a 80%); border-color: #f59e0b; color: #fde68a; }
.status-banner.waiting .reload-btn { background: #d97706; border-color: #f59e0b; color: #fff8eb; }
.status-banner.needs-refresh  { background: linear-gradient(180deg,#7c2d12 0%,#0f172a 80%); border-color: #ef4444; color: #fca5a5; animation: status-blink 1.4s ease-in-out infinite; }
.status-banner.needs-refresh .reload-btn { background: #dc2626; border-color: #ef4444; color: #ffffff; font-weight: 800; }
.status-banner.confirmed      { background: linear-gradient(180deg,#042f2e 0%,#0f172a 80%); border-color: #14b8a6; color: #99f6e4; }
.status-banner.confirmed .reload-btn { background: #0d9488; border-color: #14b8a6; color: #f0fdfa; }
.status-banner.late           { background: linear-gradient(180deg,#422006 0%,#0f172a 80%); border-color: #ea580c; color: #fed7aa; }
.status-banner.late .reload-btn { background: #ea580c; border-color: #fb923c; color: #fff7ed; }
.status-banner.past           { background: linear-gradient(180deg,#312e81 0%,#0f172a 80%); border-color: #818cf8; color: #c7d2fe; }
.status-banner.past .reload-btn { background: #4f46e5; border-color: #818cf8; color: #eef2ff; }
.status-banner.after-market   { background: linear-gradient(180deg,#1e3a8a 0%,#0f172a 80%); border-color: #3b82f6; color: #bfdbfe; }
.status-banner.after-market .reload-btn { background: #2563eb; border-color: #3b82f6; color: #eff6ff; }

@keyframes status-blink {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.0); }
  50%      { box-shadow: 0 0 0 6px rgba(239,68,68,0.25); border-color: #f87171; }
}

@media (max-width: 700px) {
  .status-banner { grid-template-columns: 1fr; padding: 8px 14px; gap: 6px; }
  .status-banner .status-action-area { align-items: flex-start; flex-direction: row; gap: 10px; }
  .status-banner-host-wrap { margin-left: -12px; margin-right: -12px; margin-top: -12px; }
  .status-banner .status-body .status-title { font-size: 13px; }
  .status-banner .status-body .status-desc { font-size: 11px; }
}

.entry-status-pill { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 3px; background: #1e293b; color: #94a3b8; border: 1px solid #334155; margin-left: 6px; }
.entry-status-pill.confirmed { background: #042f2e; color: #5eead4; border-color: #14b8a6; }
.entry-status-pill.pending   { background: #1e293b; color: #94a3b8; border-color: #475569; }
/* 09:30 status 배지 (전일 후보 카드 헤더에 노출 — 사용자 요구 2번) */
.status-30-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; margin-left: 8px; vertical-align: middle; }
.status-30-badge.sb-ready          { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }
.status-30-badge.sb-wait           { background: #422006; color: #fcd34d; border: 1px solid #f59e0b; }
.status-30-badge.sb-invalid        { background: #4c0519; color: #fda4af; border: 1px solid #f43f5e; }
.status-30-badge.sb-faded          { background: #3b0764; color: #d8b4fe; border: 1px solid #a855f7; }
.status-30-badge.sb-insufficient   { background: #1e293b; color: #cbd5e1; border: 1px solid #64748b; }
.status-30-badge.sb-need-confirm   { background: #1e293b; color: #94a3b8; border: 1px dashed #475569; }
.intraday-metrics-box { margin-top: 10px; padding: 10px 12px; background: rgba(15, 23, 42, 0.6); border-left: 3px solid #14b8a6; border-radius: 6px; }
.intraday-metrics-box .im-label { font-size: 12px; font-weight: 700; color: #5eead4; }
.intraday-metrics-box .metrics-grid { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); }
.intraday-metrics-box .metric { background: rgba(2, 6, 23, 0.5); padding: 6px 8px; }
/* 스캐너 카드 "어제도 강함" 배지 (사용자 요구 6번) */
.prev-day-overlap-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; margin-left: 6px; background: #1e1b4b; color: #c4b5fd; border: 1px solid #8b5cf6; }

.filter-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.filter-btn { padding: 6px 12px; border-radius: 999px; border: 1px solid #334155; background: #1e293b; color: #cbd5e1; font-size: 12px; cursor: pointer; }
.filter-btn:hover { background: #334155; }
.filter-btn.active { background: #1d4ed8; color: #f1f5f9; border-color: #3b82f6; }

.group-section { margin-bottom: 18px; }
.group-header { display: flex; align-items: center; gap: 10px; padding: 10px 0; cursor: pointer; user-select: none; }
.group-header h2 { margin: 0; }
.group-header .toggle { color: #64748b; font-size: 16px; }
.group-desc { font-size: 12px; color: #94a3b8; margin-bottom: 8px; line-height: 1.6; }
.group-body { display: block; }
.group-body.collapsed { display: none; }

.card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
.card.g-BALANCED-GT { border-left: 6px solid #10b981; box-shadow: -3px 0 12px -8px #10b981; }
.card.g-LIGHT-GT    { border-left: 5px solid #38bdf8; }
.card.g-MID-CAP-GT  { border-left: 5px solid #a78bfa; }
.card.g-MOM-RISK    { border-left: 5px solid #f97316; }
.card.g-HEAVY-WATCH { border-left: 5px solid #94a3b8; opacity: 0.95; }
.card.g-MICRO-RISK  { border-left: 5px solid #fbbf24; opacity: 0.92; }
.card.g-HEAVY-RISK  { border-left: 5px solid #ef4444; opacity: 0.85; }

.card h3 { margin: 0 0 6px; font-size: 15px; color: #f1f5f9; font-weight: 700; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.card h3 .code { color: #64748b; font-size: 12px; font-weight: 400; }
.card h3 .market { color: #94a3b8; font-size: 11px; font-weight: 400; padding: 1px 6px; border: 1px solid #334155; border-radius: 4px; }
/* 종목명 상세 페이지 링크 — 다른 보드들과 같은 통일 상세(/one-day-surge-board/:code, qvaVviRedefinedController) 사용 */
.card h3 a.name-link { color: #f1f5f9; text-decoration: none; border-bottom: 1px dashed transparent; }
.card h3 a.name-link:hover { color: #5eead4; border-bottom-color: #5eead4; }
.attack-card .ac-title a.name-link { color: #f1f5f9; text-decoration: none; border-bottom: 1px dashed transparent; }
.attack-card .ac-title a.name-link:hover { color: #fbbf24; border-bottom-color: #fbbf24; }
.card .meta { font-size: 11px; color: #94a3b8; margin-bottom: 8px; display:flex; flex-wrap:wrap; gap:4px; align-items:center; }

.badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px; line-height: 1.3; border: 1px solid transparent; }
.badge.score    { background: #1e293b; color: #f1f5f9; border-color: #475569; font-weight: 700; }
.badge.g-BALANCED-GT { background: #064e3b; color: #6ee7b7; border-color: #10b981; font-weight: 700; }
.badge.g-LIGHT-GT    { background: #0c4a6e; color: #7dd3fc; border-color: #0ea5e9; font-weight: 700; }
.badge.g-MID-CAP-GT  { background: #4c1d95; color: #c4b5fd; border-color: #8b5cf6; font-weight: 700; }
.badge.g-MOM-RISK    { background: #7c2d12; color: #fdba74; border-color: #f97316; font-weight: 700; }
.badge.g-HEAVY-WATCH { background: #1e293b; color: #cbd5e1; border-color: #475569; }
.badge.g-MICRO-RISK  { background: #422006; color: #fde047; border-color: #ca8a04; }
.badge.g-HEAVY-RISK  { background: #7f1d1d; color: #fca5a5; border-color: #ef4444; }
.badge.value-strong { background: #064e3b; color: #a7f3d0; border-color: #10b981; }
.badge.value-mid    { background: #134e4a; color: #5eead4; border-color: #14b8a6; }
.badge.tail      { background: #422006; color: #fde047; border-color: #ca8a04; }
.badge.overheat  { background: #7c2d12; color: #fdba74; border-color: #f97316; }
.badge.breakout  { background: #064e3b; color: #6ee7b7; border-color: #10b981; }
.badge.aux       { background: #1e293b; color: #cbd5e1; border-color: #334155; }
.badge.qva       { background: #312e81; color: #c7d2fe; border-color: #818cf8; }
.badge.qva-history { background: #042f2e; color: #5eead4; border-color: #14b8a6; font-size: 11px; font-weight: 600; }

/* ── QVA 보조 태그 — 카드 상단에 눈에 띄는 strip + 카드 우측 highlight ── */
.qva-strip {
  display: flex; align-items: center; gap: 8px;
  margin: 6px 0 10px;
  padding: 7px 12px;
  background: linear-gradient(90deg, #042f2e 0%, #064e3b 70%, #042f2e 100%);
  border-left: 4px solid #14b8a6;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: #6ee7b7;
  box-shadow: 0 1px 2px -1px rgba(20, 184, 166, 0.4);
}
.qva-strip .qva-icon  { font-size: 15px; line-height: 1; }
.qva-strip .qva-window { color: #99f6e4; font-weight: 700; }
.qva-strip .qva-days   { color: #f0fdfa; opacity: 0.85; font-size: 11px; font-weight: 500; margin-left: auto; padding: 2px 8px; background: rgba(20,184,166,0.15); border-radius: 999px; }
.qva-strip .qva-date   { color: #94a3b8; opacity: 0.75; font-size: 11px; font-weight: 400; }

/* QVA 이력이 있는 카드는 우측 상단에 작은 시각 마크 + 우측 가장자리 subtle teal accent */
.card[data-has-qva="1"] {
  background: linear-gradient(90deg, #1e293b 0%, #1e293b 92%, #064e3b 100%);
  position: relative;
}
.card[data-has-qva="1"]::after {
  content: '📈';
  position: absolute;
  top: 10px; right: 12px;
  font-size: 14px;
  opacity: 0.7;
  pointer-events: none;
}
.badge.vvi       { background: #1e3a8a; color: #bfdbfe; border-color: #3b82f6; }
.badge.candle-low-gap { background: #4c1d95; color: #ddd6fe; border-color: #8b5cf6; font-weight: 700; }
.badge.candle-gap-hold { background: #7c2d12; color: #fdba74; border-color: #f97316; }
.badge.candle-big-green { background: #064e3b; color: #6ee7b7; border-color: #10b981; }
.badge.candle-other { background: #1e293b; color: #cbd5e1; border-color: #334155; }
.badge.vmc-strong { background: #064e3b; color: #a7f3d0; border-color: #10b981; font-weight: 700; }
.badge.vmc-mid    { background: #134e4a; color: #5eead4; border-color: #14b8a6; }
.badge.first-surge   { background: #1e293b; color: #cbd5e1; border-color: #475569; }
.badge.surge-sweet   { background: #064e3b; color: #6ee7b7; border-color: #10b981; }
.badge.surge-overheat { background: #7c2d12; color: #fdba74; border-color: #f97316; }
.badge.gap-info { background: #1e293b; color: #94a3b8; border-color: #334155; }
.badge.gap-warn { background: #422006; color: #fcd34d; border-color: #f59e0b; }
.badge.gap-strong { background: #7c2d12; color: #fdba74; border-color: #f97316; font-weight: 700; }
.badge.gap-extreme { background: #7f1d1d; color: #fca5a5; border-color: #ef4444; font-weight: 700; }
.badge.value-rank-top10 { background: #064e3b; color: #a7f3d0; border-color: #10b981; font-weight: 700; }
.badge.value-rank-top30 { background: #134e4a; color: #5eead4; border-color: #14b8a6; }

.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin: 8px 0; }
.metric { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 7px 10px; }
.metric .label { font-size: 10px; color: #94a3b8; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.3px; }
.metric .value { font-size: 14px; font-weight: 600; color: #e2e8f0; font-variant-numeric: tabular-nums; }
.metric .sub { font-size: 10px; color: #64748b; margin-top: 2px; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-warn { color: #fbbf24; }

.summary-line { margin-top: 8px; padding: 8px 12px; background: #0f172a; border-left: 2px solid #38bdf8; border-radius: 4px; font-size: 12px; line-height: 1.7; color: #cbd5e1; }
.gap-note { margin-top: 8px; padding: 6px 10px; background: #0f172a; border-left: 2px solid #94a3b8; border-radius: 4px; font-size: 11px; color: #94a3b8; }

/* ── 후보 유형별 과거 검증 성과 박스 (중립 배경, +/- 동등 표시) ── */
.perf-box {
  margin: 8px 0 6px;
  padding: 8px 12px;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
  font-size: 11.5px;
  line-height: 1.7;
}
.perf-box .perf-source { font-size: 10px; color: #64748b; margin-bottom: 3px; letter-spacing: 0.2px; }
.perf-box .perf-stats  { color: #cbd5e1; }
.perf-box .perf-stats .perf-pos  { color: #6ee7b7; font-weight: 600; }
.perf-box .perf-stats .perf-warn { color: #fca5a5; font-weight: 600; }
.perf-box .perf-stats .perf-sep  { color: #475569; margin: 0 2px; }
.perf-box .perf-disclaimer { font-size: 10px; color: #64748b; margin-top: 5px; opacity: 0.9; }
.perf-box.pending { background: #1e293b; border-style: dashed; }
.perf-box.pending .perf-pending { color: #94a3b8; font-size: 11.5px; font-style: italic; }

/* ── 📌 수동 매수·매도 가이드 (manualTargets) ── */
.manual-targets-box {
  margin: 10px 0 8px;
  padding: 10px 14px;
  background: linear-gradient(135deg, #422006 0%, #1e293b 100%);
  border: 1px solid #f59e0b;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.7;
}
.manual-targets-box .mt-header {
  font-size: 13px; font-weight: 700; color: #fcd34d;
  margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #78350f;
}
.manual-targets-box .mt-header .mt-sub {
  font-size: 10.5px; color: #d4a574; font-weight: 400; margin-left: 8px;
}
.manual-targets-box .mt-section {
  margin-top: 6px; padding: 8px 10px; background: rgba(15,23,42,0.6); border-radius: 5px;
}
.manual-targets-box .mt-section.pre-open { border-left: 3px solid #14b8a6; }
.manual-targets-box .mt-section.after-930 { border-left: 3px solid #f59e0b; }
.manual-targets-box .mt-section-label {
  font-size: 11px; color: #cbd5e1; font-weight: 600; margin-bottom: 5px;
}
.manual-targets-box .mt-row {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 2px 0; font-variant-numeric: tabular-nums;
}
.manual-targets-box .mt-row.sub { font-size: 11px; opacity: 0.9; }
.manual-targets-box .mt-key { color: #94a3b8; }
.manual-targets-box .mt-val { font-weight: 700; }
.manual-targets-box .mt-val.buy      { color: #6ee7b7; }
.manual-targets-box .mt-val.buy-safe { color: #5eead4; }
.manual-targets-box .mt-val.sell     { color: #fca5a5; }
.manual-targets-box .mt-val.risk     { color: #fbbf24; }
.manual-targets-box .mt-note {
  margin-top: 4px; padding: 4px 8px;
  background: rgba(15,23,42,0.8); border-radius: 4px;
  font-size: 10.5px; color: #d4d4d8; font-style: italic;
}

/* ── 🤖 자동 참고 매매가 (tradePlan) ── */
/* 매수 추천이 아닌 참고 가격. 시장가 매수 전제 X. 기준가 근처 눌림 지정가 개념. */
.trade-plan-box {
  margin: 10px 0 8px;
  padding: 10px 14px;
  background: linear-gradient(135deg, #042f2e 0%, #1e293b 100%);
  border: 1px solid #14b8a6;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.7;
}
.trade-plan-box.wait    { background: linear-gradient(135deg, #422006 0%, #1e293b 100%); border-color: #f59e0b; }
.trade-plan-box.invalid { background: linear-gradient(135deg, #4c0519 0%, #1e293b 100%); border-color: #f43f5e; }
.trade-plan-box.faded   { background: linear-gradient(135deg, #3b0764 0%, #1e293b 100%); border-color: #a855f7; }
.trade-plan-box.insufficient { background: #1e293b; border-style: dashed; border-color: #64748b; }
.trade-plan-box.pending { background: #0f172a; border-style: dashed; border-color: #64748b; opacity: 0.85; }
.trade-plan-box.missing { background: #1e293b; border-style: dashed; border-color: #475569; }
.trade-plan-box .tp-header {
  font-size: 13px; font-weight: 700; color: #5eead4;
  margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #134e4a;
}
.trade-plan-box.wait    .tp-header { color: #fcd34d; border-bottom-color: #78350f; }
.trade-plan-box.invalid .tp-header { color: #fda4af; border-bottom-color: #881337; }
.trade-plan-box.faded   .tp-header { color: #d8b4fe; border-bottom-color: #6b21a8; }
.trade-plan-box.insufficient .tp-header { color: #cbd5e1; border-bottom-color: #475569; }
.trade-plan-box.pending .tp-header { color: #94a3b8; border-bottom-color: #334155; }
.trade-plan-box .tp-badge {
  display: inline-block; font-size: 10.5px; font-weight: 700;
  padding: 2px 7px; border-radius: 999px; margin-right: 6px;
  background: rgba(20,184,166,0.18); color: #5eead4; border: 1px solid #14b8a6;
}
.trade-plan-box.wait    .tp-badge { background: rgba(245,158,11,0.18); color: #fcd34d; border-color: #f59e0b; }
.trade-plan-box.invalid .tp-badge { background: rgba(244,63,94,0.18); color: #fda4af; border-color: #f43f5e; }
.trade-plan-box.faded   .tp-badge { background: rgba(168,85,247,0.18); color: #d8b4fe; border-color: #a855f7; }
.trade-plan-box.insufficient .tp-badge { background: rgba(100,116,139,0.18); color: #cbd5e1; border-color: #64748b; }
.trade-plan-box.pending .tp-badge { background: rgba(148,163,184,0.15); color: #94a3b8; border-color: #64748b; }
.trade-plan-box .tp-ratio { font-size: 10.5px; color: #94a3b8; font-weight: 400; }
.trade-plan-box .tp-strategy { font-size: 10.5px; color: #94a3b8; font-weight: 400; margin-left: 4px; }
.trade-plan-box .tp-row {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 2px 0; font-variant-numeric: tabular-nums;
}
.trade-plan-box .tp-row.sub { font-size: 11px; opacity: 0.9; }
.trade-plan-box .tp-key { color: #94a3b8; }
.trade-plan-box .tp-val { font-weight: 700; }
.trade-plan-box .tp-val.buy   { color: #6ee7b7; }
.trade-plan-box .tp-val.sell  { color: #fca5a5; }
.trade-plan-box .tp-val.stop  { color: #fbbf24; }
.trade-plan-box .tp-val.base  { color: #cbd5e1; }
.trade-plan-box .tp-val.rr    { color: #93c5fd; }
.trade-plan-box .tp-pause     { color: #fcd34d; font-weight: 700; font-size: 13px; }
.trade-plan-box .tp-reason {
  margin-top: 4px; padding: 4px 8px;
  background: rgba(15,23,42,0.8); border-radius: 4px;
  font-size: 10.5px; color: #d4d4d8;
}
.trade-plan-box .tp-risknote {
  margin-top: 4px; padding: 4px 8px;
  background: rgba(15,23,42,0.5); border-left: 2px solid #94a3b8;
  font-size: 10.5px; color: #cbd5e1; font-style: italic;
}
.trade-plan-box .tp-disclaimer {
  margin-top: 6px; font-size: 10px; color: #64748b; font-style: italic;
}

.tp-summary-strip {
  margin: 6px 0 14px; padding: 10px 14px;
  background: linear-gradient(90deg, #042f2e 0%, #0f172a 100%);
  border: 1px solid #14b8a6; border-radius: 8px;
  font-size: 12px; line-height: 1.6; color: #e2e8f0;
}
.tp-summary-strip .tps-title { color: #5eead4; font-weight: 700; margin-right: 10px; }
.tp-summary-strip .tps-pill {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  background: rgba(15,23,42,0.6); margin: 0 4px 0 0; font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.tp-summary-strip .tps-pill .num { font-weight: 700; }
.tp-summary-strip .tps-pill.ready    { color: #6ee7b7; }
.tp-summary-strip .tps-pill.wait     { color: #fcd34d; }
.tp-summary-strip .tps-pill.invalid  { color: #fda4af; }
.tp-summary-strip .tps-pill.faded    { color: #d8b4fe; }
.tp-summary-strip .tps-pill.insufficient { color: #cbd5e1; }
.tp-summary-strip .tps-pill.pending  { color: #94a3b8; font-style: italic; }
.tp-summary-strip .tps-pill.risk     { color: #fb923c; }
.tp-summary-strip .tps-pill.missing  { color: #94a3b8; }
.tp-summary-strip .tps-disclaimer { display: block; margin-top: 6px; font-size: 10.5px; color: #94a3b8; font-style: italic; }

.empty-list { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 24px; text-align: center; color: #64748b; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }

/* 🔥 공격형 TOP 1DS — 60일 감사 strong 등급 검증된 BIG_MONEY_REBREAK 조건 */
.attack-top-section { background: linear-gradient(180deg, #7c2d12 0%, #1e293b 90%); border: 1px solid #ea580c; border-radius: 12px; padding: 16px 18px; margin-bottom: 18px; }
.attack-top-section h2 { margin: 0 0 4px; color: #fdba74; font-size: 18px; }
.attack-top-section .subhdr { color: #fed7aa; font-size: 12px; margin-bottom: 10px; line-height: 1.6; }
.attack-top-section .desc { background: rgba(0,0,0,0.25); border-left: 3px solid #fb923c; padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; font-size: 12px; color: #fed7aa; line-height: 1.7; }
.attack-top-section .desc strong { color: #fdba74; }
.attack-top-section .validation { font-size: 11.5px; color: #fcd34d; margin-bottom: 10px; padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 6px; line-height: 1.6; }
.attack-top-section .validation strong { color: #fef08a; }
.attack-top-section .mode-banner { font-size: 12px; padding: 6px 12px; background: rgba(0,0,0,0.3); border-radius: 6px; margin-bottom: 10px; color: #fcd34d; }
.attack-top-section .mode-banner .mode-pill { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #ea580c; color: #fff; font-weight: 700; margin-right: 8px; font-size: 11px; }
.attack-top-section .warn-overflow { background: #7f1d1d; border-left: 3px solid #ef4444; padding: 8px 12px; border-radius: 6px; margin-bottom: 10px; color: #fca5a5; font-size: 12px; }
.attack-top-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 12px; }
.attack-top-grid .cell { background: rgba(0,0,0,0.3); border: 1px solid #92400e; border-radius: 6px; padding: 8px 12px; }
.attack-top-grid .cell .lbl { font-size: 10.5px; color: #fdba74; text-transform: uppercase; letter-spacing: 0.4px; }
.attack-top-grid .cell .val { font-size: 18px; font-weight: 700; color: #fef08a; margin-top: 2px; font-variant-numeric: tabular-nums; }
.attack-top-grid .cell .sub { font-size: 10.5px; color: #fed7aa; margin-top: 2px; }
.attack-card { background: #1e293b; border: 1px solid #334155; border-left: 5px solid #fb923c; border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; }
.attack-card.is-top { background: linear-gradient(90deg, #7c2d12 0%, #1e293b 25%); border-left-color: #fbbf24; }
.attack-card.has-second-wave { border-left-color: #ef4444; }
.attack-card .ac-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.attack-card .ac-rank { font-size: 13px; font-weight: 800; color: #fbbf24; background: #422006; padding: 2px 8px; border-radius: 5px; min-width: 30px; text-align: center; }
.attack-card .ac-title { font-size: 14px; font-weight: 700; display: flex; gap: 6px; align-items: baseline; }
.attack-card .ac-title .name { color: #f1f5f9; }
.attack-card .ac-title .code { color: #94a3b8; font-size: 11px; font-weight: 400; }
.attack-card .ac-title .market { color: #cbd5e1; font-size: 11px; padding: 1px 5px; border: 1px solid #334155; border-radius: 4px; }
.attack-card .ac-score { margin-left: auto; font-size: 11px; color: #fcd34d; }
.attack-card .ac-meta { font-size: 11.5px; color: #cbd5e1; margin: 2px 0; }
.attack-card .ac-meta b { color: #f1f5f9; }
.attack-card .ac-meta .pos { color: #5eead4; }
.attack-card .ac-meta .neg { color: #fca5a5; }
.attack-card .ac-meta .warn { color: #fbbf24; }
.attack-card .ac-tags { margin-top: 4px; }
.attack-chip { display: inline-block; font-size: 10.5px; padding: 2px 7px; border-radius: 4px; margin: 1px 3px 1px 0; border: 1px solid; }
.attack-chip.pos { background: #422006; color: #fdba74; border-color: #ea580c; }
.attack-chip.risk { background: #7f1d1d; color: #fca5a5; border-color: #ef4444; }
.attack-card .ac-comment { font-size: 11.5px; color: #fed7aa; margin-top: 5px; font-style: italic; }
.attack-empty { padding: 16px; background: rgba(0,0,0,0.3); border: 1px dashed #92400e; border-radius: 6px; color: #fdba74; text-align: center; font-size: 12.5px; }
.attack-top-section details { margin-top: 8px; }
.attack-top-section details summary { cursor: pointer; padding: 6px 12px; background: rgba(0,0,0,0.3); border-radius: 6px; font-size: 12px; color: #fdba74; user-select: none; }
/* 공격형 TOP 카드 inline 결과 (장마감 후) */
.attack-card .ac-result { margin-top: 6px; padding: 6px 10px; background: rgba(0,0,0,0.35); border-radius: 5px; font-size: 11.5px; }
.attack-card .ac-result .result-pos { color: #5eead4; font-weight: 700; }
.attack-card .ac-result .result-neg { color: #fca5a5; font-weight: 700; }
.attack-card .ac-result .result-warn { color: #fbbf24; font-weight: 700; }
.attack-card .ac-result .result-label-big { color: #5eead4; font-weight: 700; }
.attack-card .ac-result .result-label-mid { color: #93c5fd; font-weight: 700; }
.attack-card .ac-result .result-label-warn { color: #fbbf24; font-weight: 700; }
.attack-card .ac-result .result-label-fail { color: #fca5a5; font-weight: 700; }
.attack-card .ac-result-pending { font-size: 11px; color: #94a3b8; margin-top: 6px; font-style: italic; }

/* 📊 오늘 결과 섹션 (장마감 후) — 통일된 다크 + 청록 강조 */
.today-result-section { background: linear-gradient(180deg, #042f2e 0%, #0f172a 90%); border: 1px solid #14b8a6; border-radius: 12px; padding: 16px 18px; margin-bottom: 18px; }
.today-result-section h2 { margin: 0 0 4px; color: #5eead4; font-size: 18px; }
.today-result-section .subhdr { color: #99f6e4; font-size: 12px; margin-bottom: 10px; line-height: 1.6; }
.today-result-section .desc { background: rgba(0,0,0,0.25); border-left: 3px solid #14b8a6; padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; font-size: 12px; color: #99f6e4; line-height: 1.7; }
.today-result-section .desc strong { color: #5eead4; }
.today-result-section .warn-note { background: #422006; border-left: 3px solid #f59e0b; padding: 8px 12px; border-radius: 6px; margin-bottom: 10px; color: #fde68a; font-size: 11.5px; line-height: 1.6; }
.today-result-section .target-line { font-size: 11.5px; color: #94a3b8; margin-bottom: 10px; }
.today-result-section .target-line strong { color: #cbd5e1; }
.today-result-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 12px; }
.today-result-grid .cell { background: rgba(0,0,0,0.3); border: 1px solid #134e4a; border-radius: 6px; padding: 8px 12px; }
.today-result-grid .cell.attack { border-color: #ea580c; }
.today-result-grid .cell.fail { border-color: #ef4444; }
.today-result-grid .cell .lbl { font-size: 10.5px; color: #5eead4; text-transform: uppercase; letter-spacing: 0.4px; }
.today-result-grid .cell.attack .lbl { color: #fdba74; }
.today-result-grid .cell.fail .lbl { color: #fca5a5; }
.today-result-grid .cell .val { font-size: 18px; font-weight: 700; color: #f1f5f9; margin-top: 2px; font-variant-numeric: tabular-nums; }
.today-result-grid .cell .sub { font-size: 10.5px; color: #94a3b8; margin-top: 2px; }
.today-result-table { width: 100%; border-collapse: collapse; background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; font-size: 11.5px; margin-bottom: 12px; }
.today-result-table th, .today-result-table td { padding: 7px 9px; text-align: left; border-bottom: 1px solid #334155; color: #cbd5e1; vertical-align: top; }
.today-result-table th { background: #0f172a; color: #5eead4; font-weight: 600; font-size: 11px; }
.today-result-table td.pos { color: #5eead4; font-weight: 600; }
.today-result-table td.neg { color: #fca5a5; font-weight: 600; }
.today-result-table td.warn { color: #fbbf24; font-weight: 600; }
.today-result-table .chip-big { display: inline-block; font-size: 10.5px; padding: 1px 6px; border-radius: 3px; margin: 1px 2px; background: #042f2e; color: #5eead4; border: 1px solid #14b8a6; }
.today-result-table .chip-warn { display: inline-block; font-size: 10.5px; padding: 1px 6px; border-radius: 3px; margin: 1px 2px; background: #422006; color: #fde68a; border: 1px solid #d97706; }
.today-result-table .chip-fail { display: inline-block; font-size: 10.5px; padding: 1px 6px; border-radius: 3px; margin: 1px 2px; background: #7f1d1d; color: #fca5a5; border: 1px solid #ef4444; }
.today-result-table .chip-attack-mark { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 3px; margin-left: 4px; background: #7c2d12; color: #fdba74; border: 1px solid #ea580c; }
.today-result-section .intraday-banner { background: #422006; border: 1px solid #f59e0b; border-radius: 10px; padding: 18px 22px; text-align: center; }
.today-result-section .intraday-banner .ib-title { font-size: 18px; font-weight: 700; color: #fde68a; margin-bottom: 8px; }
.today-result-section .intraday-banner .ib-line { font-size: 13px; color: #fcd34d; margin: 4px 0; line-height: 1.6; }
.today-result-section .empty-note { background: rgba(0,0,0,0.3); border: 1px dashed #334155; padding: 12px; text-align: center; border-radius: 6px; color: #94a3b8; font-size: 12px; }
.today-result-section details summary { cursor: pointer; padding: 6px 12px; background: rgba(0,0,0,0.3); border-radius: 6px; font-size: 12px; color: #5eead4; user-select: none; margin: 8px 0; }

/* 🕐 1DS 오전 갱신 일정 카드 */
.cron-schedule-card { background: linear-gradient(180deg, #0c4a6e 0%, #0f172a 90%); border: 1px solid #0ea5e9; border-radius: 10px; padding: 12px 16px; margin: 12px 0; color: #e0f2fe; }
.cron-schedule-card .cs-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.cron-schedule-card .cs-title { font-size: 14px; font-weight: 700; color: #7dd3fc; }
.cron-schedule-card .cs-now   { font-size: 12px; color: #bae6fd; background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 4px; }
.cron-schedule-card .cs-next  { font-size: 12px; color: #fde68a; background: rgba(252,211,77,0.12); border: 1px solid #fbbf24; padding: 2px 8px; border-radius: 4px; }
.cron-schedule-card .cs-row { display: grid; grid-template-columns: 28px 100px 1fr; gap: 8px; padding: 4px 0; font-size: 12.5px; color: #cbd5e1; align-items: center; }
.cron-schedule-card .cs-row.done   { color: #cbd5e1; }
.cron-schedule-card .cs-row.now    { color: #fde68a; font-weight: 600; background: rgba(252,211,77,0.08); border-left: 3px solid #fbbf24; padding-left: 6px; margin-left: -9px; border-radius: 3px; }
.cron-schedule-card .cs-row.future { color: #64748b; }
.cron-schedule-card .cs-icon { text-align: center; }
.cron-schedule-card .cs-time { color: #94a3b8; font-variant-numeric: tabular-nums; }
.cron-schedule-card .cs-row.done .cs-time { color: #94a3b8; }
.cron-schedule-card .cs-row.now  .cs-time { color: #fde68a; }
.cron-schedule-card .cs-note { font-size: 11px; color: #94a3b8; margin-top: 6px; line-height: 1.55; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; }
  .metrics-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
</head>
<body>

<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
  <div style="background:linear-gradient(90deg,#064e3b 0%,#065f46 100%);border:1px solid #10b981;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#a7f3d0;font-weight:700;letter-spacing:0.3px;">🟢 운영 보드</span><a href="/qva2-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR</a><a href="/qva2-d5-rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파</a><a href="/qva2-vvi" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파</a></div>
  <div style="background:linear-gradient(90deg,#1e1b4b 0%,#312e81 100%);border:1px solid #6366f1;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#c4b5fd;font-weight:700;letter-spacing:0.3px;">🟣 실험 라인</span><a href="/one-day-surge-board" style="color:#fff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.22);border:1px solid #fff;font-weight:700;">⚡ 1DS 단타 후보</a><a href="/nasdaq-theme-watch" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🌎 나스닥 테마 감시</a><a href="/qva-live-watch" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">⚡ QVA 장중 감시</a></div>
  <div style="background:linear-gradient(90deg,#1e293b 0%,#334155 100%);border:1px solid #64748b;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;opacity:0.92;"><span style="color:#cbd5e1;font-weight:700;letter-spacing:0.3px;">📜 과거 보드</span><a href="/qva-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR (구)</a><a href="/rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파 (구)</a><a href="/qva-vvi-redefined-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파 (구)</a></div>
  <div style="background:linear-gradient(90deg,#042f2e 0%,#134e4a 100%);border:1px solid #14b8a6;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#5eead4;font-weight:700;letter-spacing:0.3px;">📊 통합 보기</span><a href="/db-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🗄 DB 신호 운영판</a></div>
</div>

<!-- 운영자 상단 sticky 상태 배너 (스크롤 내려도 항상 보임) -->
<div class="status-banner-host-wrap"><div id="status-banner-host"></div></div>

<h1 id="board-h1">🎯 1DS — 09:30 예선 → 10:00 본선 단타 후보</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  <strong>1DS는 09:30에 바로 들어가는 모델이 아닙니다.</strong> 60거래일 백테스트 결과, 09:30 후보 중 <strong>10:00까지 09:30 기준가 위에서 살아남은 종목</strong>이 평균 <strong>+2.49%</strong>, 승률 <strong>69.9%</strong>로 가장 좋았습니다.
  <br>화면 첫 섹션 <strong>✅ 10시 생존 확인 후보</strong>를 우선 보세요. 그 외는 보조 감시/관찰 후보입니다.
  <br><br>
  <span style="font-size:11.5px;color:#94a3b8;line-height:1.7;">
    카드의 과거 성과 수치는 <strong>과거 40거래일 운영형 백테스트 결과</strong>입니다.
    참고용이며 <strong>오늘도 그대로 된다는 뜻은 아닙니다.</strong> 실제 진입과 대응은 본인의 판단입니다.
  </span>
</div>
<div id="market-banner-host"></div>
<div id="daytype-banner-host"></div>
<!-- 🕐 1DS 오전 갱신 일정 — 현재 KST 기준으로 어느 cron이 끝났고 다음 새로고침은 언제가 좋은지 안내 -->
<div id="cron-schedule-host"></div>
<div class="filter-info" id="filter-info"></div>

<!-- 🔥 공격형 TOP 1DS — 60일 BIG RUNNER 감사 strong 등급 (거래대금 상위 10% + 장초 고가 재돌파) -->
<div id="attack-top-host"></div>

<h2>📊 화면 요약</h2>
<div class="summary-grid" id="summary-grid"></div>
<div id="trade-plan-summary"></div>
<div id="qva-summary-line"></div>

<!-- ⓪ 오늘 09:30 실제 포착 후보 (전일 mainPool과 무관) — 신규 5섹션 구조: survivor1000 / explosiveStable / attackRebreak / readyRest / watchOnly -->
<!-- premarket-host(내일 장초 들여다볼 후보)는 2026-05-14 제거. 1DS는 09:30/10:00 모델로 통일됨. -->
<div id="scanner-0930-host"></div>

<!-- 장전 보조 영역(전일 후보 09:30 상태표, 보류/재관찰)은 2026-05-14 제거.
     1DS 운영 철학이 09:30 = 예선 / 10:00 = 본선으로 바뀌면서 "어제 mainPool" 관점 후보군은 더 이상 필요 없음. -->
<div id="risk-excluded-note"></div>

<!-- 📊 오늘 1DS 결과 — 장중에는 안내만, 장마감 후 mainResult 표시 (페이지 최하단) -->
<div id="today-result-host"></div>

<footer class="foot" id="foot"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtNum(v) { return v != null && Number.isFinite(v) ? Math.round(v).toLocaleString() : '-'; }
function fmtPct(v, prec) {
  if (v == null || !Number.isFinite(v)) return '-';
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(prec || 2) + '%';
}
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8); }
function fmtMoney(v) {
  if (v == null) return '-';
  if (v >= 1e12) return (v/1e12).toFixed(2) + '조';
  if (v >= 1e8) return (v/1e8).toFixed(1) + '억';
  if (v >= 1e4) return (v/1e4).toFixed(0) + '만';
  return Math.round(v).toLocaleString();
}

document.getElementById('subtitle').textContent =
  '분석 기준일: ' + (DATA.meta.analysisDateFmt || '-') +
  ' · 사용 종목 수: ' + DATA.meta.stockUniverse +
  ' · 후보 노출: ' + DATA.meta.shownTotal +
  ' · 생성: ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

(function renderFilterInfo() {
  const r = DATA.counts.filterRejected || {};
  document.getElementById('filter-info').innerHTML =
    '<strong>필터 제외 통계</strong> · 총 ' + DATA.meta.stockUniverse + '개 차트 중 ETF ' + (r.etf||0) +
    ' / 우선주·리츠·스팩·관리종목 등 ' + (r.special||0) +
    ' / 키워드 매칭 ' + (r.excluded_name||0) +
    ' / 시총 미확인 ' + (r.no_marketcap||0) +
    ' / 시총 500억 미만 ' + (r.mc_under_500||0) +
    ' / 시총 5조 이상 ' + (r.mc_over_5t||0) + ' 제외';
})();

function renderSummary() {
  const v = DATA.visibilityCounts || {};
  const e = DATA.entryShelf || {};
  const minuteState = e.analysisDateConfirmReady
    ? '✅ 적용 중'
    : (e.withMinute > 0 ? '⏳ 부분 적용' : '⏳ 확인 전');
  const cells = [
    { lab: '전체 후보 풀', val: v.totalPool, sub: '분류 가능 후보 (UNCLASSIFIED 제외)', cls: '' },
    { lab: '최우선 노출',  val: v.topPriorityShown, sub: 'displayPriorityScore 상위, 메인 펼침', cls: 'entry-safe' },
    { lab: '추가 후보',    val: v.extraPriorityShown, sub: '6~15위, 접힘', cls: 'entry-light' },
    { lab: '추천 풀 합계',  val: v.mainPoolSize, sub: '위험 필터 통과 후' + (v.riskExemptedCount ? ' · 면제 ' + v.riskExemptedCount + '건' : ''), cls: '' },
    { lab: '위험 필터 제외', val: v.riskExcluded, sub: 'MOM-RISK·GAP_HOLD·SPIKE·peakBefore 등 (morningHigh 재돌파 ✓는 면제)', cls: 'entry-warn' },
    { lab: '숨김',         val: (v.overflowHidden || 0) + (v.unclassified || 0),
      sub: 'overflow ' + (v.overflowHidden || 0) + ' + 미분류 ' + (v.unclassified || 0), cls: '' },
    { lab: '장초 분봉 상태', val: minuteState, sub: '분봉 적용 ' + (e.withMinute || 0) + '건', cls: 'entry-clean' },
  ];
  document.getElementById('summary-grid').innerHTML = cells.map(c =>
    '<div class="summary-cell ' + (c.cls || '') + '"><div class="label">' + c.lab + '</div>' +
    '<div class="value">' + c.val + '</div>' +
    '<div class="sub">' + c.sub + '</div></div>'
  ).join('');
}
renderSummary();

// 🤖 자동 참고 매매가 요약 strip — 상단에 한 줄로 표시 (autoCount/READY/대기/이탈/위험제외/가격부족)
(function renderTradePlanSummary() {
  const host = document.getElementById('trade-plan-summary');
  if (!host) return;
  const tp = (DATA.summary && DATA.summary.tradePlan) || null;
  if (!tp) return;
  const lim = tp.autoPlanLimit || 10;
  const pills = [
    '<span class="tps-pill ready">READY <span class="num">' + (tp.readyCount || 0) + '</span></span>',
    '<span class="tps-pill wait">추격 부담 <span class="num">' + (tp.waitPullbackCount || 0) + '</span></span>',
    '<span class="tps-pill invalid">기준가 이탈 <span class="num">' + (tp.invalidatedCount || 0) + '</span></span>',
    '<span class="tps-pill faded">돌파 후 밀림 <span class="num">' + (tp.fadedCount || 0) + '</span></span>',
    '<span class="tps-pill pending">분봉 미확인 <span class="num">' + (tp.needConfirmCount || 0) + '</span></span>',
    '<span class="tps-pill insufficient">분봉 부족 <span class="num">' + (tp.insufficientCount || 0) + '</span></span>',
    '<span class="tps-pill missing">가격 데이터 부족 <span class="num">' + (tp.missingPriceCount || 0) + '</span></span>',
    '<span class="tps-pill risk">위험 태그 제외 <span class="num">' + (tp.excludedRiskCount || 0) + '</span></span>',
  ].join('');
  const sourceLine = (tp.intradayConfirmedCount > 0 || tp.groupFallbackCount > 0)
    ? '<span class="tps-pill" style="color:#5eead4;">분봉 재상승 확인 <span class="num">' + (tp.intradayConfirmedCount || 0) + '</span></span>' +
      '<span class="tps-pill" style="color:#fcd34d;">분봉 미확인 / 그룹 기본 <span class="num">' + (tp.groupFallbackCount || 0) + '</span></span>'
    : '';
  host.innerHTML = '<div class="tp-summary-strip">' +
    '<span class="tps-title">🤖 자동 참고 매매가 (상위 ' + lim + '개)</span>' +
    '<span class="tps-pill"><span class="num">' + (tp.autoCount || 0) + '</span> / ' + lim + ' 자동 계산</span>' +
    pills +
    (sourceLine ? '<br>' + sourceLine : '') +
    '<span class="tps-disclaimer">자동 계산 가격은 참고용입니다. 시장가 매수 지시가 아닙니다. 실제 진입과 대응은 본인의 판단입니다.</span>' +
    '</div>';
})();

// QVA 보조 요약 — 이전 수급 흔적이 있는 후보 수를 카드형 안내 박스로 표시
(function renderQvaSummaryLine() {
  const host = document.getElementById('qva-summary-line');
  if (!host) return;
  const q = DATA.qvaSummary || {};
  const top = q.taggedTopCount || 0;
  const extra = q.taggedExtraCount || 0;
  if (top + extra === 0) { host.style.display = 'none'; return; }
  const topN = (DATA.priorityRanked && DATA.priorityRanked.topPriority || []).length;
  const extraN = (DATA.priorityRanked && DATA.priorityRanked.extraPriority || []).length;
  const parts = [];
  if (top > 0)   parts.push('최우선 ' + topN + '종목 중 <strong style="color:#f0fdfa;">' + top + '개</strong>');
  if (extra > 0) parts.push('추가 후보 ' + extraN + '개 중 <strong style="color:#f0fdfa;">' + extra + '개</strong>');
  host.innerHTML = '<div style="background:linear-gradient(90deg,#042f2e 0%,#064e3b 100%);border-left:4px solid #14b8a6;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px;color:#6ee7b7;line-height:1.6;">' +
    '<strong style="color:#5eead4;">📈 QVA 신호 보유</strong> · ' + parts.join(' · ') +
    '<br><span style="font-size:11px;color:#99f6e4;opacity:0.85;">최근 20거래일 안에 QVA 신호가 발생했던 후보입니다. 카드 상단의 초록 띠로 표시됩니다.</span>' +
  '</div>';
})();

// ── 운영자 상단 상태 배너: 4종 상태 (시간 + 분봉 매칭 여부) ──
// A. 전일 장마감 후보  (시간 < 09:00 또는 분봉 미매칭)
// B. 장초 확인 대기 중 (09:00 ~ 09:30)
// C. 장초 확인 필요    (09:30 이후 + 분봉 미매칭) — blink + reload 버튼
// D. 장초 움직임 반영 완료 (분봉 매칭 + analysisDateConfirmReady)
function getSeoulHHMM() {
  // Asia/Seoul 시간 HH*100+MM 정수 반환
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const hh = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const mm = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return hh * 100 + mm;
}
function formatSeoulNow() {
  const fmt = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  // ko-KR 포맷이 "2026. 05. 07. 17:32:18" 형태 — 깔끔하게 정리
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value || '';
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute') + ':' + get('second');
}
// 다음 09:30 KST까지 남은 ms (오늘 09:30 미경과면 오늘, 지났으면 다음 거래일 — 주말 skip)
function getRemainingToNext930() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value || '0';
  const yy = parseInt(get('year'), 10);
  const mm = parseInt(get('month'), 10);
  const dd = parseInt(get('day'), 10);
  // KST 09:30 = UTC 00:30 (시차 +9). UTC epoch로 계산해서 시차 영향 회피.
  let target = Date.UTC(yy, mm - 1, dd, 0, 30, 0);
  const nowEpoch = Date.now();
  if (target <= nowEpoch) {
    // 오늘 09:30 지남 → 다음 평일 09:30
    let next = new Date(target);
    do {
      next.setUTCDate(next.getUTCDate() + 1);
    } while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
    target = next.getTime();
  }
  return target - nowEpoch;
}
function fmtRemaining(ms) {
  if (ms < 0 || !Number.isFinite(ms)) return '-';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return h + '시간 ' + m + '분';
  return m + '분';
}

// 신 모델 (2026-05-14 개편): 09:30 = 예선 / 10:00 = 본선 / 10:00 이후 = 대응
// status: 시각 + scanner0930 survivor1000Ready 플래그 결합
function computeBoardStatus() {
  // 휴장일(주말/공휴일)은 시각과 무관하게 holiday 상태
  if (DATA.marketStatus && DATA.marketStatus.status === 'holiday_closed') return 'holiday';
  const sc = DATA.priorityRanked && DATA.priorityRanked.scanner0930;
  const survivorReady = !!(sc && sc.survivor1000Ready);
  const hhmm = getSeoulHHMM();
  if (hhmm < 900)  return 'pre-market';            // 09:00 이전 — 개장 대기
  if (hhmm < 930)  return 'preliminary-running';   // 09:00~09:30 — 예선 진행 중
  if (hhmm < 1000) return 'preliminary-done';      // 09:30~10:00 — 예선 완료, 본선(10:00) 대기
  if (hhmm < 1030) return survivorReady ? 'main-confirmed' : 'main-waiting';  // 10:00~10:30 — 본선 확인
  if (hhmm < 1300) return survivorReady ? 'response-window' : 'main-needs-refresh';  // 10:30~13:00 — 대응 구간
  if (hhmm < 1530) return 'response-late';         // 13:00~15:30 — 대응 후반
  return 'after-market';                            // 장 마감 후
}
function renderStatusBanner() {
  const host = document.getElementById('status-banner-host');
  if (!host) return;
  const status = computeBoardStatus();
  const sc = DATA.priorityRanked && DATA.priorityRanked.scanner0930;
  const survivorCount = (sc && Array.isArray(sc.survivor1000)) ? sc.survivor1000.length : 0;
  const readyCount    = (sc && sc.summary && sc.summary.readyCount != null) ? sc.summary.readyCount : ((sc && Array.isArray(sc.ready)) ? sc.ready.length : 0);
  const nowStr = formatSeoulNow();
  const remStr = fmtRemaining(getRemainingToNext930());
  const cfgMap = {
    'pre-market': {
      cls: 'previous-close',
      title: '⏳ 시장 개장 대기',
      desc: '<strong>09:00 시장 개장 전입니다.</strong> 09:30까지 분봉으로 예선 후보가 산출됩니다. 다음 09:30까지 약 <strong>' + remStr + '</strong> 남았습니다.',
      action: '09:30 이후 새로고침 — 예선 후보 확인',
    },
    'preliminary-running': {
      cls: 'waiting',
      title: '⏰ 예선 진행 중 (09:00~09:30)',
      desc: '<strong>예선 분봉 수집 중입니다.</strong> 09:30 직후 readyRest / explosiveStable / attackRebreak가 채워집니다. 본격 대응은 10:00 본선 확인 후.',
      action: '09:30 이후 새로고침',
    },
    'preliminary-done': {
      cls: 'needs-refresh',
      title: '🟡 예선 완료 — 본선 진출(10:00) 대기 중',
      desc: '<strong>09:30 예선 후보 ' + readyCount + '개가 산출됐습니다.</strong> 메인 후보(10시 생존 확인 후보)는 10:00 cron 이후 채워집니다. 이 시간은 후보 관찰만, 진입은 보류.',
      action: '10:01 cron 이후 새로고침',
    },
    'main-waiting': {
      cls: 'needs-refresh',
      title: '⚠ 10:00 본선 확인 대기 — 새로고침 필요',
      desc: '<strong>10:00이 지났지만 아직 본선 확인 결과가 반영 안 됐습니다.</strong> 10:01 cron 또는 admin trigger 후 보드를 새로고침해야 메인 후보가 채워집니다.',
      action: '🔄 보드 새로고침',
    },
    'main-confirmed': {
      cls: 'confirmed',
      title: '✅ 10:00 본선 확인 완료 — 메인 후보 ' + survivorCount + '개',
      desc: '<strong>10시 생존 확인 후보가 채워졌습니다.</strong> 위 첫 섹션의 <strong>✅ 10시 생존 확인 후보</strong>를 우선 검토하세요. +5%/+10% 익절, -3% 손절 기준.',
      action: '메인 후보 진입 검토 (지금이 최적 시간)',
    },
    'response-window': {
      cls: 'confirmed',
      title: '🎯 대응 구간 (10:30~13:00) — 메인 후보 ' + survivorCount + '개',
      desc: '<strong>10시 생존 확인 후보를 중심으로 실제 대응하는 시간대입니다.</strong> 11시까지 미돌파 후보는 강등 검토. 늦은 진입은 신중하게.',
      action: '진입/관망 결정',
    },
    'main-needs-refresh': {
      cls: 'late',
      title: '⚠ 본선 결과 미반영 (이미 늦음 신호)',
      desc: '<strong>10:30이 지났습니다.</strong> 본선 결과가 아직 반영되지 않았으면 보드를 새로고침하세요. 다만 진입 신선도는 낮아졌습니다.',
      action: '신선도 낮음 — 신중하게',
    },
    'response-late': {
      cls: 'past',
      title: '📉 대응 후반 (13:00~15:30)',
      desc: '<strong>이미 들어간 포지션 관리 시간대입니다.</strong> 본선 후보의 종가 추세를 확인하고 익절/손절 기준대로 정리. 새 진입은 부적합.',
      action: '포지션 관리 위주',
    },
    'after-market': {
      cls: 'after-market',
      title: '🌙 장 마감 — 다음 거래일 09:30 대기',
      desc: '<strong>오늘 대응 시간은 종료되었습니다.</strong> 결과 복기 또는 다음 거래일 준비용. 다음 09:30까지 약 <strong>' + remStr + '</strong> 후.',
      action: '다음 거래일 09:30 이후 새로고침',
    },
    'holiday': {
      cls: 'previous-close',
      title: '📅 휴장일 (주말/공휴일/대체공휴일)',
      desc: '<strong>오늘은 한국 증시가 휴장입니다.</strong>' +
            (DATA.marketStatus && DATA.marketStatus.previousTradingDate
              ? ' 직전 거래일 <strong>' + DATA.marketStatus.previousTradingDate + '</strong> 결과를 표시합니다.'
              : '') +
            ' 다음 거래일 09:30까지 약 <strong>' + remStr + '</strong> 후.',
      action: '다음 거래일 09:30 이후 새로고침',
    },
  };
  const cfg = cfgMap[status] || cfgMap['after-market'];
  host.innerHTML = '<div class="status-banner ' + cfg.cls + '">' +
    '<div class="status-body">' +
      '<div class="status-label">현재 위치</div>' +
      '<div class="status-title">' + cfg.title + '</div>' +
      '<div class="status-desc">' + cfg.desc + '</div>' +
      '<div class="status-action">→ ' + cfg.action + '</div>' +
    '</div>' +
    '<div class="status-action-area">' +
      '<div class="status-clock"><span class="lbl">현재 시간</span><span id="status-clock-text">' + nowStr + '</span></div>' +
      '<button class="reload-btn" onclick="window.location.reload()">🔄 보드 새로고침</button>' +
    '</div>' +
  '</div>';
  // H1 제목은 HTML에 적힌 그대로 두고 더 이상 JS에서 덮어쓰지 않는다.
  // 옛 top-priority-desc / .card-watch-note 요소는 모두 제거됐으므로 업데이트 X.
}
renderStatusBanner();
// 시계 1초마다 갱신 + 매 분 status 재평가
setInterval(function() {
  const el = document.getElementById('status-clock-text');
  if (el) el.textContent = formatSeoulNow();
}, 1000);
setInterval(function() {
  // 시간이 09:30 등 임계값을 지났을 때 자동 상태 갱신
  renderStatusBanner();
}, 30 * 1000);

// 시장 상태 banner — 코스피/코스닥 + 대형주 쏠림 분류
(function renderMarketBanner() {
  const ms = DATA.marketState || {};
  const host = document.getElementById('market-banner-host');
  if (!host) return;
  const stateMap = {
    BROAD_MARKET_UP: 'broad', LARGE_CAP_LED: 'large', KOSDAQ_WEAK: 'kosdaq',
    WEAK_MARKET: 'weak', MIXED_MARKET: 'mixed', UNKNOWN: 'unknown',
  };
  const cls = stateMap[ms.state] || 'unknown';
  const idxFmt = (idx, name) => idx
    ? name + ' <span class="idx-num ' + (idx.changeRate > 0 ? 'pos' : 'neg') + '">' + (idx.changeRate > 0 ? '+' : '') + idx.changeRate.toFixed(2) + '%</span>'
    : name + ' <span class="muted">-</span>';
  const indices = (ms.kospi || ms.kosdaq) ? '<br>' + idxFmt(ms.kospi, 'KOSPI') + ' · ' + idxFmt(ms.kosdaq, 'KOSDAQ') : '';
  // 라이브 vs daily 표시
  const liveBadge = ms.source === 'live' && ms.asOfTime
    ? ' <span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:3px;background:rgba(16,185,129,0.18);color:#a7f3d0;font-size:10px;font-weight:700;" title="실시간 polling — ' + (ms.ageMinutes != null ? ms.ageMinutes + '분 전 갱신' : '최근 갱신') + '">⏱ ' + ms.asOfTime + ' 기준 (라이브)</span>'
    : ms.source === 'daily' ? ' <span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:3px;background:rgba(148,163,184,0.18);color:#cbd5e1;font-size:10px;font-weight:600;" title="cache/kospi-daily.json — 전일 종가 기준">📅 daily</span>' : '';
  host.innerHTML = '<div class="market-banner ' + cls + '">' +
    '<strong>📈 시장 상태:</strong> ' + (ms.label || '시장 상태 미확인') + liveBadge + indices +
    (ms.desc ? '<br><span style="font-size:11px;opacity:0.85;">' + ms.desc + '</span>' : '') +
  '</div>';
})();

// 최근 거래일 성격 banner (장마감 후 확정 — 장중에는 참고용)
// 내부 수치(hit5/closePos/avgClose)는 운영 화면에서 제거. 서술 중심.
(function renderDayTypeBanner() {
  const lt = DATA.latestDayType;
  const host = document.getElementById('daytype-banner-host');
  if (!host || !lt) return;
  host.innerHTML = '<div class="daytype-banner ' + lt.dayType + '">' +
    '<strong>🌊 최근 거래일 성격</strong> (' + lt.date + ' → ' + lt.nextDate + ')<br>' +
    '<span style="font-size:12px;line-height:1.7;">' + (lt.desc || lt.label || '') + '</span>' +
    ' <span class="muted" style="font-size:10px;">— 장중에는 참고용</span>' +
  '</div>';
})();

// (구 entry-shelf-banner는 새로운 운영자 status banner로 대체됨 — 렌더 X)

// 모든 candidate를 code → item으로 lookup (각 섹션이 priority list의 코드로 카드 가져옴)
const CODE_MAP = (function() {
  const m = new Map();
  for (const g of (DATA.groupOrder || [])) {
    for (const it of (DATA.groups[g] || [])) m.set(it.code, it);
  }
  return m;
})();
function itemsByCodes(codes) {
  return (codes || []).map((c) => CODE_MAP.get(c)).filter(Boolean);
}

const CANDLE_LABEL = {
  LOW_GAP_INTRADAY: '🟣 낮은 갭 + 장중 끌어올림',
  GAP_HOLD:         '🟠 갭상승 유지형 (TRAP 주의)',
  BIG_GREEN:        '🟢 장대양봉',
  UPPER_WICK_GREEN: '🟡 윗꼬리 양봉',
  RED_CLOSE:        '🔴 음봉 마감',
  OTHER:            '⚪ 기타',
};

// ── 🤖 자동 참고 매매가 박스 (tradePlan) ──
// 매수 추천이 아닌 참고 가격. 기준가 근처 눌림 지정가 개념. 시장가 매수 지시가 아닙니다.
const TP_STRATEGY_LABEL = {
  BALANCED_REBREAK: '수급 균형 + 장초 재상승',
  SAFE_REBREAK:     '장초 재상승 확인',
  CLEAN_REBREAK:    '무리 없는 장초 재상승',
  LIGHT_REBREAK:    '가벼운 종목의 장초 재상승',
};
const TP_BASE_SOURCE_LABEL = {
  rebreakPrice:    '09:00~09:10 첫 10분 고점 (재돌파 trigger)',
  entryPrice0910:  '09:10 종가',
  baseClose:       '기준일 종가 (분봉 미확인)',
  todayOpen:       '기준일 시가',
  prevClose:       '전일 종가',
};
function renderTradePlanBox(it) {
  const tp = it.tradePlan;
  if (!tp || tp.mode !== 'AUTO') return '';
  const fmtN = (v) => v != null ? Math.round(v).toLocaleString() + '원' : '-';
  const stratLabel = TP_STRATEGY_LABEL[tp.strategy] || tp.strategy || '-';
  const baseLabel  = TP_BASE_SOURCE_LABEL[tp.baseEntrySource] || tp.baseEntrySource || '-';
  const sourceTag  = (tp.strategySource === 'group_fallback')
    ? ' <span class="tp-strategy" style="color:#fcd34d;">· 분봉 미확인 / 그룹 기본</span>'
    : ' <span class="tp-strategy" style="color:#5eead4;">· 분봉 재상승 확인</span>';
  const disclaimer = '<div class="tp-disclaimer">자동 계산 가격은 참고용입니다. 시장가 매수 지시가 아닙니다. 실제 진입과 대응은 본인의 판단입니다.</div>';

  // 보류/주의 카드 — READY 외 상태 공통 렌더. 매수가는 강조하지 않고 사유를 명확히.
  const renderHoldCard = (cssClass, headerLabel, pauseLabel) => {
    const currentRow = (tp.currentPrice != null)
      ? '<div class="tp-row"><span class="tp-key">분봉 마지막 가격</span><span class="tp-val base">' + fmtN(tp.currentPrice) +
        (tp.ratioPct != null ? ' <span class="tp-ratio">(기준 대비 ' + (tp.ratioPct >= 0 ? '+' : '') + tp.ratioPct.toFixed(2) + '%)</span>' : '') +
        '</span></div>'
      : '';
    return '<div class="trade-plan-box ' + cssClass + '">' +
      '<div class="tp-header"><span class="tp-badge">자동 계산</span>' + headerLabel + '<span class="tp-strategy">' + stratLabel + '</span>' + sourceTag + '</div>' +
      '<div class="tp-row"><span class="tp-key">기준가</span><span class="tp-val base">' + fmtN(tp.baseEntryPrice) + '</span></div>' +
      '<div class="tp-row sub"><span class="tp-key">· 기준가 출처</span><span class="tp-val base">' + baseLabel + '</span></div>' +
      currentRow +
      '<div class="tp-row"><span class="tp-key">참고 매수가</span><span class="tp-pause">' + pauseLabel + '</span></div>' +
      (tp.reason ? '<div class="tp-reason">' + tp.reason + '</div>' : '') +
      (tp.riskNote ? '<div class="tp-risknote">' + tp.riskNote + '</div>' : '') +
      disclaimer +
    '</div>';
  };

  if (tp.status === 'WAIT_PULLBACK')         return renderHoldCard('wait',         '추격 부담 — 보류',         '추격 부담 / 눌림 대기');
  if (tp.status === 'ENTRY_INVALIDATED')     return renderHoldCard('invalid',      '기준가 이탈 — 진입 보류',  '자동 진입 보류');
  if (tp.status === 'REBREAK_FADED')         return renderHoldCard('faded',        '돌파 후 밀림 — 주의',      '돌파 후 밀림 / 보류');
  if (tp.status === 'INSUFFICIENT_BARS')     return renderHoldCard('insufficient', '분봉 부족 — 판정 불가',    '분봉 부족 / 보류');
  if (tp.status === 'NEED_INTRADAY_CONFIRM') return renderHoldCard('pending',      '09:30 분봉 확인 없음',     '분봉 미확인 / 보류');
  if (tp.status === 'MISSING_PRICE_DATA') {
    return '<div class="trade-plan-box missing">' +
      '<div class="tp-header"><span class="tp-badge">자동 계산</span>가격 데이터 부족<span class="tp-strategy">' + stratLabel + '</span>' + sourceTag + '</div>' +
      '<div class="tp-reason">' + (tp.reason || '가격 데이터 부족') + '</div>' +
      disclaimer +
    '</div>';
  }
  // READY
  const rrLine = (tp.rewardRisk1 != null || tp.rewardRisk2 != null)
    ? '<div class="tp-row"><span class="tp-key">손익비</span><span class="tp-val rr">1차 ' + (tp.rewardRisk1 != null ? tp.rewardRisk1.toFixed(2) : '-') + ' / 2차 ' + (tp.rewardRisk2 != null ? tp.rewardRisk2.toFixed(2) : '-') + '</span></div>'
    : '';
  return '<div class="trade-plan-box">' +
    '<div class="tp-header"><span class="tp-badge">자동 계산</span>참고 매매가<span class="tp-strategy">' + stratLabel + '</span>' + sourceTag + '</div>' +
    '<div class="tp-row"><span class="tp-key">기준가</span><span class="tp-val base">' + fmtN(tp.baseEntryPrice) + '</span></div>' +
    '<div class="tp-row sub"><span class="tp-key">· 기준가 출처</span><span class="tp-val base">' + baseLabel + '</span></div>' +
    '<div class="tp-row"><span class="tp-key">참고 매수가</span><span class="tp-val buy">' + fmtN(tp.buyPrice) + '</span></div>' +
    '<div class="tp-row"><span class="tp-key">1차 목표</span><span class="tp-val sell">' + fmtN(tp.sellPrice1) + '</span></div>' +
    '<div class="tp-row"><span class="tp-key">2차 목표</span><span class="tp-val sell">' + fmtN(tp.sellPrice2) + '</span></div>' +
    '<div class="tp-row"><span class="tp-key">손절 기준</span><span class="tp-val stop">' + fmtN(tp.stopPrice) + '</span></div>' +
    rrLine +
    (tp.reason ? '<div class="tp-reason">' + tp.reason + '</div>' : '') +
    (tp.riskNote ? '<div class="tp-risknote">' + tp.riskNote + '</div>' : '') +
    disclaimer +
  '</div>';
}

function strategyChips(it) {
  const list = it.entryStrategies || [];
  const defs = (DATA.entryShelf && DATA.entryShelf.strategyDefs) || {};
  const chips = list.map((s) => {
    const d = defs[s] || {};
    return '<span class="strategy-chip ' + s + '" title="' + (d.desc || '').replace(/"/g, '&quot;') + '">' + (d.chipLabel || s) + '</span>';
  });
  // morningHigh 재돌파 ✓로 면제된 위험 표시 — 사용자가 위험을 인지하면서 선택할 수 있게
  const exempted = it.riskExempted || [];
  if (exempted.includes('peak_before_entry')) {
    chips.push('<span class="strategy-chip RISK_EXEMPTED" title="09:10에 첫 10분 고점 통과했지만 09:10~30 사이에 그 고점을 다시 재돌파해 회복 흐름. 위험 자동 제외에서 면제됨 — 다만 추격 시점 주의.">↗ 재돌파 회복 (peakBefore 면제)</span>');
  } else if (it.intraday && it.intraday.peakBeforeEntryLive === true) {
    // 면제 안 된 경우만 (즉 morningHigh 재돌파 X) — 기존 경고 유지
    chips.push('<span class="strategy-chip PEAK_BEFORE_WARN" title="09:10 기준으로는 장중 고점이 이미 나온 뒤일 가능성이 큽니다. 추격 주의가 필요합니다.">⚠ 이미 초반 고점 통과</span>');
  }
  if (exempted.includes('prev_high_spike')) {
    chips.push('<span class="strategy-chip RISK_EXEMPTED" title="전일 고가 돌파 spike이지만 첫 10분 고점 재돌파도 함께 — 강한 한입 패턴. 위험 자동 제외에서 면제됨 — 다만 spike 후 빠질 가능성 인지.">↗ 강한 한입 (spike 면제)</span>');
  }
  return chips.join('');
}

function entryStatusPill(it) {
  if (it.entryStatus === 'OK') return '';
  // 분봉 확인 전인 경우만 명시 (개별 카드 너무 시끄러우면 제거 가능)
  return '<span class="entry-status-pill pending" title="장초 분봉 데이터 아직 없음 — 다음 거래일 09:35+ 분봉 수집 후 표시">장초 분봉 확인 전</span>';
}

// 전일 후보 카드의 09:30 tradePlan 상태 배지 — 카드 헤더에 강조 표시.
// READY는 청록, 위험 신호는 색상별, 분봉 미확인은 회색 dashed.
function tradePlanStatusBadge(it) {
  const st = it.tradePlan && it.tradePlan.status;
  if (!st || st === 'NOT_SELECTED' || st === 'AUTO_EXCLUDED_RISK') return '';
  const map = {
    READY:                 { cls: 'status-ready',   label: '✓ READY · 장초 흐름 유지' },
    WAIT_PULLBACK:         { cls: 'status-wait',    label: '⚠ WAIT_PULLBACK · 추격 부담' },
    ENTRY_INVALIDATED:     { cls: 'status-invalid', label: '✕ ENTRY_INVALIDATED · 기준가 이탈' },
    REBREAK_FADED:         { cls: 'status-faded',   label: '↘ REBREAK_FADED · 돌파 후 밀림' },
    INSUFFICIENT_BARS:     { cls: 'status-insuff',  label: '· INSUFFICIENT_BARS · 분봉 부족' },
    NEED_INTRADAY_CONFIRM: { cls: 'status-pending', label: '· NEED_INTRADAY_CONFIRM · 09:30 분봉 미확인' },
    MISSING_PRICE_DATA:    { cls: 'status-insuff',  label: '· MISSING_PRICE_DATA · 가격 부족' },
  };
  const m = map[st];
  if (!m) return '';
  return '<span class="prev-status-badge ' + m.cls + '" title="전일 mainPool 후보의 09:30 분봉 검증 상태">' + m.label + '</span>';
}

// 오늘 스캐너 결과와 전일 mainPool 후보가 겹치는지 — "어제도 강함" 배지용.
function scannerOverlapBadge(it) {
  const sc = DATA.priorityRanked && DATA.priorityRanked.scanner0930;
  if (!sc) return '';
  const inReady    = (sc.ready    || []).some((e) => e.code === it.code);
  const inHolding  = (sc.holding  || []).some((e) => e.code === it.code);
  const inRejected = (sc.rejected || []).some((e) => e.code === it.code);
  if (inReady)    return '<span class="prev-day-overlap-badge" title="오늘 09:30 스캐너에서도 READY로 잡힘 — 어제·오늘 연속 확인">🔥 어제도 강함 · 연속 확인</span>';
  if (inHolding)  return '<span class="prev-day-overlap-badge" style="background:#422006;color:#fcd34d;border-color:#f59e0b;" title="오늘 09:30 스캐너에서 보류/재관찰로 잡힘">🔁 전일 후보 겹침 (스캐너 보류)</span>';
  if (inRejected) return '<span class="prev-day-overlap-badge" style="background:#1e293b;color:#94a3b8;border-color:#475569;" title="오늘 09:30 스캐너에서 WEAK로 분류">· 전일 후보 겹침 (스캐너 WEAK)</span>';
  return '';
}

function buildCardHtml(it) {
  const badges = [];
  // 그룹 라벨
  const groupLabel = (DATA.groupLabels && DATA.groupLabels[it.gtGroup]) || it.gtGroup;
  badges.push('<span class="badge g-' + it.gtGroup + '">' + groupLabel + '</span>');
  // 시총 (총점 oneDaySurgeScore는 화면 노출 X — 정렬에 안 쓰이고 우선순위 점수와 혼동 방지. JSON에는 그대로 유지.)
  badges.push('<span class="badge aux" title="' + (it.gtBandLabel || '') + '">' + fmtMoney(it.marketCap) + '</span>');
  // displayPriorityScore (화면 우선순위 — 정렬 기준)
  if (typeof it.displayPriorityScore === 'number') {
    const ps = it.displayPriorityScore;
    const psCls = ps >= 80 ? 'value-strong' : (ps >= 50 ? 'value-mid' : (ps < 0 ? 'overheat' : 'aux'));
    badges.push('<span class="badge ' + psCls + '" title="화면 우선순위 점수 (그룹 + 수급 + 분봉 가산 - 위험 감점)">우선순위 ' + ps + '</span>');
  }

  // v/mc 비율
  if (it.valueToMarketCapRatio != null) {
    if (it.valueToMarketCapRatio >= 20)      badges.push('<span class="badge vmc-strong">시총대비 ' + it.valueToMarketCapRatio.toFixed(1) + '% 폭증</span>');
    else if (it.valueToMarketCapRatio >= 10) badges.push('<span class="badge vmc-strong">시총대비 ' + it.valueToMarketCapRatio.toFixed(1) + '% 강함</span>');
    else if (it.valueToMarketCapRatio >= 5)  badges.push('<span class="badge vmc-mid">시총대비 ' + it.valueToMarketCapRatio.toFixed(1) + '%</span>');
  }

  // 캔들
  if (it.candleType === 'LOW_GAP_INTRADAY') badges.push('<span class="badge candle-low-gap" title="낮은 갭에서 장중 매수세로 끌어올림 — 실전 단타 유리">' + CANDLE_LABEL[it.candleType] + '</span>');
  else if (it.candleType === 'GAP_HOLD')    badges.push('<span class="badge candle-gap-hold" title="갭상승 후 종가 유지 — HIT10 높지만 시초가 추격 위험">' + CANDLE_LABEL[it.candleType] + '</span>');
  else if (it.candleType === 'BIG_GREEN')   badges.push('<span class="badge candle-big-green">' + CANDLE_LABEL[it.candleType] + '</span>');
  else if (it.candleType && it.candleType !== 'OTHER') badges.push('<span class="badge candle-other">' + (CANDLE_LABEL[it.candleType] || it.candleType) + '</span>');

  // 거래대금 일자내 순위
  if (it.dailyValueRank != null) {
    if (it.dailyValueRank <= 10) badges.push('<span class="badge value-rank-top10">시장 거래대금 #' + it.dailyValueRank + '</span>');
    else if (it.dailyValueRank <= 30) badges.push('<span class="badge value-rank-top30">시장 거래대금 #' + it.dailyValueRank + '</span>');
  }

  // 최근 급등 횟수
  if (it.recent5Up15Count != null) {
    if (it.recent5Up15Count === 0) badges.push('<span class="badge first-surge">첫 급등형</span>');
    else if (it.recent5Up15Count === 1) badges.push('<span class="badge surge-sweet">최근 5일 +15% 1회 (sweet spot)</span>');
    else if (it.recent5Up15Count >= 3) badges.push('<span class="badge surge-overheat">최근 5일 +15% ' + it.recent5Up15Count + '회 (과열)</span>');
  }

  // 거래대금 배율
  if (it.valueRatio >= 5) badges.push('<span class="badge value-strong">거래대금 ×' + it.valueRatio.toFixed(1) + ' 폭증</span>');
  else if (it.valueRatio >= 3) badges.push('<span class="badge value-strong">거래대금 ×' + it.valueRatio.toFixed(1) + ' 강함</span>');
  else if (it.valueRatio >= 2) badges.push('<span class="badge value-mid">거래대금 ×' + it.valueRatio.toFixed(1) + '</span>');

  if (it.isBreakoutOf20) badges.push('<span class="badge breakout">20일 고점 돌파</span>');
  else if (it.nearHigh20) badges.push('<span class="badge breakout">20일 고점 근접</span>');
  if (it.upperTailRatio >= 0.4) badges.push('<span class="badge tail">윗꼬리 ' + (it.upperTailRatio*100).toFixed(0) + '%</span>');
  if ((it.ret3d != null && it.ret3d >= 25) || (it.ret5d != null && it.ret5d >= 40)) {
    badges.push('<span class="badge overheat">최근 과열</span>');
  }

  // 이전 수급 흔적은 카드 상단 별도 strip으로 표시 (눈에 띄게) — 메타 badges에 중복 추가 X
  // VVI 이력 — 별도 보조 정보 (참고용, 점수 영향 없음)
  if (it.vviHistory && it.vviHistory.signalDate) {
    badges.push('<span class="badge vvi" title="참고용: 본 보드 점수와 무관">VVI 이력 ' + fmtDate(it.vviHistory.signalDate) + (it.vviHistory.daysAfterSignal != null ? ' (D+' + it.vviHistory.daysAfterSignal + ')' : '') + '</span>');
  }

  const chgCls = it.changeRate > 0 ? 'cell-pos' : (it.changeRate < 0 ? 'cell-neg' : '');
  const cpCls  = it.closePosition >= 0.7 ? 'cell-pos' : (it.closePosition < 0.4 ? 'cell-neg' : '');
  const tailCls = it.upperTailRatio >= 0.4 ? 'cell-warn' : '';
  const distCls = it.distFromHigh20 == null ? '' : (it.distFromHigh20 >= 0 ? 'cell-pos' : (it.distFromHigh20 < -10 ? 'cell-neg' : ''));

  // 장초 ENTRY_CONFIRM 분봉 메트릭 메시지 (있을 때만)
  let intradayLine = '';
  let intradayMetricsBox = '';
  if (it.entryStatus === 'OK' && it.intraday) {
    const im = it.intraday;
    const mh = im.rebreakMorningHigh_10_30;
    const ph = im.rebreakPrevHighBy0930;
    const mhTxt = mh ? '<span class="cell-pos">✓ 09:10~30 첫 10분 고점 재돌파</span>' : '<span class="muted">· 첫 10분 고점 미돌파</span>';
    const phTxt = ph ? '<span class="cell-warn">⚠ 전일 고점 돌파(spike 위험)</span>' : '<span class="muted">· 전일 고점 미돌파</span>';
    const gapPctTxt = im.gapRate != null ? fmtPct(im.gapRate, 2) : '-';
    intradayLine = '<div class="gap-note" style="border-left-color:#14b8a6;color:#cbd5e1;">🚪 장초 분봉 확인 (' + (DATA.entryShelf && DATA.entryShelf.entryConfirmDate || '-') + '): 시초가 갭 ' + gapPctTxt + ' · ' + mhTxt + ' · ' + phTxt + '</div>';
    // 사용자 요구 4번 — 09:00~09:30 분봉 메트릭 6개 카드 표시
    const v0930 = im.value_0_30 != null ? im.value_0_30 : (im.value_0_10 || 0) * 3;
    const oc = im.openToCloseRate_0_30;
    const hd = im.highToCloseDrop_0_30;
    const cp = im.closePosition_0_30;
    const ocCls = oc == null ? '' : (oc > 0 ? 'cell-pos' : (oc < 0 ? 'cell-neg' : ''));
    const hdCls = hd == null ? '' : (hd <= -2.5 ? 'cell-neg' : (hd <= -1.0 ? 'cell-warn' : 'cell-pos'));
    const cpCls2 = cp == null ? '' : (cp >= 0.65 ? 'cell-pos' : (cp < 0.4 ? 'cell-neg' : ''));
    intradayMetricsBox = '<div class="intraday-metrics-box">' +
      '<div class="im-label">📊 09:00~09:30 분봉 메트릭</div>' +
      '<div class="metrics-grid" style="margin-top:6px;">' +
        '<div class="metric"><div class="label">누적 거래대금</div><div class="value">' + fmtMoney(v0930) + '원</div><div class="sub">09:00~09:30 합</div></div>' +
        '<div class="metric"><div class="label">시가 대비 09:30</div><div class="value ' + ocCls + '">' + (oc != null ? (oc >= 0 ? '+' : '') + oc.toFixed(2) + '%' : '-') + '</div><div class="sub">+1~8% 양호</div></div>' +
        '<div class="metric"><div class="label">고점 대비 09:30</div><div class="value ' + hdCls + '">' + (hd != null ? hd.toFixed(2) + '%' : '-') + '</div><div class="sub">-2.5%↓ FADED</div></div>' +
        '<div class="metric"><div class="label">09:30 종가 위치</div><div class="value ' + cpCls2 + '">' + (cp != null ? (cp * 100).toFixed(0) + '%' : '-') + '</div><div class="sub">≥65% 양호</div></div>' +
        '<div class="metric"><div class="label">첫 고점 재돌파</div><div class="value ' + (mh ? 'cell-pos' : '') + '">' + (mh ? '✓ 재돌파' : '· 미돌파') + '</div><div class="sub">09:10~30 사이</div></div>' +
        '<div class="metric"><div class="label">분봉 수</div><div class="value">' + (im.bars_total || 0) + '개</div><div class="sub">≥20 정상</div></div>' +
      '</div>' +
    '</div>';
  }

  // 09:30 현재 상태 배지 — 전일 후보 카드에 반드시 표시 (사용자 요구 2번)
  const STATUS_BADGE_CLS = {
    READY:                 'sb-ready',
    WAIT_PULLBACK:         'sb-wait',
    ENTRY_INVALIDATED:     'sb-invalid',
    REBREAK_FADED:         'sb-faded',
    INSUFFICIENT_BARS:     'sb-insufficient',
    NEED_INTRADAY_CONFIRM: 'sb-need-confirm',
  };
  const STATUS_BADGE_LABEL = {
    READY:                 '✅ READY 장초 흐름 유지',
    WAIT_PULLBACK:         '⚠ 추격 부담',
    ENTRY_INVALIDATED:     '⚠ 기준가 이탈',
    REBREAK_FADED:         '⚠ 고점 후 밀림',
    INSUFFICIENT_BARS:     '❓ 분봉 부족',
    NEED_INTRADAY_CONFIRM: '❓ 09:30 분봉 미확인',
  };
  const tpStatus = it.tradePlan && it.tradePlan.status;
  const statusBadge = STATUS_BADGE_LABEL[tpStatus]
    ? '<span class="status-30-badge ' + (STATUS_BADGE_CLS[tpStatus] || '') + '">' + STATUS_BADGE_LABEL[tpStatus] + '</span>'
    : '';

  // QVA 보조 태그 strip — H3 바로 아래 눈에 띄는 독립 줄로 표시
  const qvaStrip = it.hasRecentQva
    ? '<div class="qva-strip" title="' + (it.qvaWindowDesc || '').replace(/"/g, '&quot;') + '">' +
        '<span class="qva-icon">📈</span>' +
        '<span class="qva-window">QVA</span>' +
        '<span class="qva-date">' + (it.qvaWindowLabel || '') + ' · ' + fmtDate(it.qvaSignalDate) + '</span>' +
        '<span class="qva-days">' + it.qvaDaysAgo + '거래일 전</span>' +
      '</div>'
    : '';

  // 후보 유형별 과거 검증 성과 박스 (4 안전 전략 통과 시만 확정 수치, 아니면 pending)
  let perfBox = '';
  if (it.performanceConfirmed && it.performanceStats) {
    const s = it.performanceStats;
    perfBox = '<div class="perf-box">' +
      '<div class="perf-source">' + (it.performanceSource || '') + ' · 유형: ' + (it.performanceLabel || '') + '</div>' +
      '<div class="perf-stats">' +
        '<span class="perf-pos">장중 +5% 도달 ' + s.intradayHit5Rate.toFixed(0) + '%</span>' +
        '<span class="perf-sep">·</span>' +
        '<span class="perf-pos">종가 플러스 ' + s.closePositiveRate.toFixed(0) + '%</span><br>' +
        '<span class="perf-pos">평균 종가 ' + (s.avgCloseRate > 0 ? '+' : '') + s.avgCloseRate.toFixed(1) + '%</span>' +
        '<span class="perf-sep">·</span>' +
        '<span class="perf-warn">-5% 흔들림 ' + s.intradayFail5Rate.toFixed(0) + '%</span>' +
      '</div>' +
      '<div class="perf-disclaimer">' + (it.performanceDisclaimer || '실제 대응은 본인의 판단입니다.') + '</div>' +
    '</div>';
  } else if (it.performancePendingNote) {
    perfBox = '<div class="perf-box pending">' +
      '<div class="perf-pending">' + it.performancePendingNote + '</div>' +
      '<div class="perf-disclaimer">' + (it.performanceDisclaimer || '실제 대응은 본인의 판단입니다.') + '</div>' +
    '</div>';
  }

  // 🤖 자동 참고 매매가 (tradePlan)
  // 매수 추천이 아닌 참고 가격. 시장가 매수 전제 X.
  const tradePlanBox = renderTradePlanBox(it);

  // 📌 수동 매수·매도 가이드 (manualTargets 있는 카드만)
  let manualTargetsBox = '';
  if (it.manualTargets && (it.manualTargets.preOpen || it.manualTargets.after930)) {
    const mt = it.manualTargets;
    const pre = mt.preOpen || {};
    const aft = mt.after930 || {};
    const fmtN = (v) => v != null ? Math.round(v).toLocaleString() + '원' : '-';
    manualTargetsBox = '<div class="manual-targets-box">' +
      '<div class="mt-header">📌 단타 매수·매도 가이드 <span class="mt-sub">사용자 수동 입력 · 외부 분석 기반</span></div>' +
      // 9:30 이전
      (Object.keys(pre).length ? (
        '<div class="mt-section pre-open">' +
          '<div class="mt-section-label">⏰ 9:30 이전 (장 시작 전 가이드)</div>' +
          (pre.realisticBuyMax != null ? '<div class="mt-row"><span class="mt-key">현실적 매수가</span><span class="mt-val buy">' + fmtN(pre.realisticBuyMax) + ' 이하</span></div>' : '') +
          (pre.sellMin != null         ? '<div class="mt-row"><span class="mt-key">매도가</span><span class="mt-val sell">' + fmtN(pre.sellMin) + ' 이상</span></div>' : '') +
          (pre.safeBuyMax != null      ? '<div class="mt-row sub"><span class="mt-key">· 안정적 매수가</span><span class="mt-val buy-safe">' + fmtN(pre.safeBuyMax) + ' 이하</span></div>' : '') +
          (pre.downsideRiskPrice != null ? '<div class="mt-row sub"><span class="mt-key">⚠ 하락 리스크</span><span class="mt-val risk">' + fmtN(pre.downsideRiskPrice) + ' 까지 가능</span></div>' : '') +
          (pre.downsideRiskNote ? '<div class="mt-note">' + pre.downsideRiskNote + '</div>' : '') +
        '</div>'
      ) : '') +
      // 9:30 이후
      (Object.keys(aft).length ? (
        '<div class="mt-section after-930">' +
          '<div class="mt-section-label">🕘 9:30 이후 (장중 매수 가이드)</div>' +
          ((aft.buyRangeLow != null && aft.buyRangeHigh != null) ? '<div class="mt-row"><span class="mt-key">매수 구간</span><span class="mt-val buy">' + fmtN(aft.buyRangeLow) + ' ~ ' + fmtN(aft.buyRangeHigh) + '</span></div>' : '') +
          (aft.sellMin != null ? '<div class="mt-row"><span class="mt-key">매도가</span><span class="mt-val sell">' + fmtN(aft.sellMin) + ' 이상</span></div>' : '') +
          (aft.guidanceNote ? '<div class="mt-note">' + aft.guidanceNote + '</div>' : '') +
        '</div>'
      ) : '') +
    '</div>';
  }

  return '<div class="card g-' + it.gtGroup + '" data-group="' + it.gtGroup + '" data-candle="' + (it.candleType || '') + '" data-qva="' + (it.qvaHistoryLabel ? '1' : '0') + '" data-has-qva="' + (it.hasRecentQva ? '1' : '0') + '" data-vvi="' + (it.vviHistory ? '1' : '0') + '" data-strategies="' + ((it.entryStrategies || []).join(',')) + '" data-manual-targets="' + (it.manualTargets ? '1' : '0') + '" data-trade-plan="' + (it.tradePlan && it.tradePlan.status || 'NONE') + '">' +
    '<h3><a class="name-link" href="/one-day-surge-board/' + it.code + '" title="' + (it.name || '-').replace(/"/g,'&quot;') + ' 상세 (통일 상세 페이지)">' + (it.name || '-') + '</a> <span class="code">' + it.code + '</span> <span class="market">' + (it.market || '-') + '</span> ' + statusBadge + ' ' + scannerOverlapBadge(it) + ' ' + entryStatusPill(it) + '</h3>' +
    qvaStrip +
    '<div class="meta">' + strategyChips(it) + badges.join('') + '</div>' +
    perfBox +
    '<div class="metrics-grid">' +
      '<div class="metric"><div class="label">기준일 종가</div><div class="value">' + fmtNum(it.close) + '원</div><div class="sub">' + fmtDate(it.baseDate) + '</div></div>' +
      '<div class="metric"><div class="label">전일 등락률</div><div class="value ' + chgCls + '">' + fmtPct(it.changeRate, 2) + '</div><div class="sub">기준일 갭 ' + fmtPct(it.baseGapRate, 2) + '</div></div>' +
      '<div class="metric"><div class="label">시가총액</div><div class="value">' + fmtMoney(it.marketCap) + '원</div><div class="sub">' + (it.gtBandLabel || '-') + '</div></div>' +
      '<div class="metric"><div class="label">시총 대비 거래대금</div><div class="value">' + (it.valueToMarketCapRatio != null ? it.valueToMarketCapRatio.toFixed(1) + '%' : '-') + '</div><div class="sub">v/mc — 5%↑ 의미 / 10%↑ 강함</div></div>' +
      '<div class="metric"><div class="label">거래대금</div><div class="value">' + fmtMoney(it.valueAmount) + '원</div><div class="sub">평소 대비 ×' + (it.valueRatio != null ? it.valueRatio.toFixed(2) : '-') + '</div></div>' +
      '<div class="metric"><div class="label">시장 거래대금 순위</div><div class="value">#' + (it.dailyValueRank || '-') + '</div><div class="sub">일자내 valueAmount 순</div></div>' +
      '<div class="metric"><div class="label">종가 위치</div><div class="value ' + cpCls + '">' + (it.closePosition*100).toFixed(0) + '%</div><div class="sub">고가 1.0 / 저가 0.0</div></div>' +
      '<div class="metric"><div class="label">윗꼬리</div><div class="value ' + tailCls + '">' + (it.upperTailRatio*100).toFixed(0) + '%</div><div class="sub">≥40% 부담 / ≥60% 강함</div></div>' +
      '<div class="metric"><div class="label">최근 5일 +15% 횟수</div><div class="value">' + (it.recent5Up15Count != null ? it.recent5Up15Count + '회' : '-') + '</div><div class="sub">0~1회 sweet / 3회↑ 과열</div></div>' +
      '<div class="metric"><div class="label">최근 3일 / 5일</div><div class="value">' + fmtPct(it.ret3d, 1) + ' / ' + fmtPct(it.ret5d, 1) + '</div><div class="sub">누적 상승률</div></div>' +
      '<div class="metric"><div class="label">20일 고점 대비</div><div class="value ' + distCls + '">' + fmtPct(it.distFromHigh20, 2) + '</div><div class="sub">' + (it.high20 != null ? fmtNum(it.high20) + '원' : '-') + '</div></div>' +
      '<div class="metric"><div class="label">캔들 구조</div><div class="value">' + (CANDLE_LABEL[it.candleType] || '-') + '</div><div class="sub">실전 단타 우선 = LOW_GAP</div></div>' +
    '</div>' +
    '<div class="summary-line">💡 ' + (it.summaryLine || '') + '</div>' +
    intradayLine +
    intradayMetricsBox +
    (intradayLine ? '' : '<div class="gap-note">🚪 다음 거래일 시초가가 나오면 갭 7% 이상은 "갭 과열 주의", 12% 이상은 "강한 추격 주의", 20% 이상은 "초고위험 갭"으로 표시됩니다. 7% 미만이면 "장초 확인 가능 구간".</div>') +
    // ── 카드 하단 가격 박스 묶음 (위: 사용자 수동 분석가 → 아래: 프로그램 자동 참고 예상가) ──
    manualTargetsBox +
    tradePlanBox +
    // 장초 확인 전 카드 하단 작은 안내 — status에 따라 JS가 텍스트 갱신/숨김
    '<div class="card-watch-note" style="margin-top:6px;font-size:11px;color:#94a3b8;border-top:1px dashed #334155;padding-top:6px;">' +
      '장초 확인 전 · 장 시작 후 09:30 이후 다시 확인 필요' +
    '</div>' +
    '</div>';
}

// ── KST 시간대 감지 — premarket(장 마감 후~다음날 09:00) vs intraday(09:00~16:30) ──
// premarket 모드일 때 첫 자리에 "🔮 내일 장초 들여다볼 후보" 섹션을 노출하고,
// 기존 pending-host의 NEED 섹션은 숨겨 중복을 피한다.
function getKstMinutesOfDay() {
  const now = new Date();
  // KST = UTC+9
  const kstMs = now.getTime() + 9 * 3600 * 1000;
  const k = new Date(kstMs);
  return k.getUTCHours() * 60 + k.getUTCMinutes();
}
function isPremarketMode() {
  const m = getKstMinutesOfDay();
  // 16:30 ~ 09:00 (다음날) → premarket
  return m >= (16 * 60 + 30) || m < (9 * 60);
}
const PREMARKET_MODE = isPremarketMode();

// ── premarket "내일 장초 들여다볼 후보" 섹션 제거 (2026-05-14) ──
// 1DS 운영 철학 변경: 09:30 = 예선, 10:00 = 본선. 장전에 "내일 들여다볼 후보"를 미리 보는 의미가 줄어듦.
// 09:30 cron 후 scanner-0930 섹션이 메인이므로 premarket 섹션은 더 이상 렌더링하지 않는다.
// (관련 host div도 1645번 줄에서 제거됨. PREMARKET_MODE 상수는 다른 곳에서 참조하므로 유지.)

// ── ⓪ 오늘 09:30 실제 포착 후보 (전일 mainPool과 무관) ──
// 09:00~09:30 분봉 기준 실시간 포착. 분봉이 없으면 후보가 아니다.
(function renderScanner0930() {
  const host = document.getElementById('scanner-0930-host');
  if (!host) return;
  const sc = DATA.priorityRanked && DATA.priorityRanked.scanner0930;
  if (!sc) {
    host.innerHTML = '<section class="entry-shelf-section" style="border:1px solid #475569;background:#0f172a;">' +
      '<h2>📡 오늘 09:30 실제 포착 후보 — 스캐너 미실행</h2>' +
      '<div class="shelf-desc" style="color:#94a3b8;">스캐너 결과 파일이 없습니다. 09:30 cron 또는 admin trigger 후 다시 보세요.</div></section>';
    return;
  }
  const fmtN = (v) => (v != null && Number.isFinite(v)) ? Math.round(v).toLocaleString() : '-';
  const fmtMoneyKR = (v) => {
    if (v == null) return '-';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + '조';
    if (v >= 1e8)  return (v / 1e8).toFixed(0) + '억';
    if (v >= 1e4)  return (v / 1e4).toFixed(0) + '만';
    return Math.round(v).toLocaleString();
  };
  // 사용자 요구 6번: 스캐너 카드에서 전일 mainPool과 겹치면 "🔥 어제도 강함" 배지
  const prevDayCodesSet = new Set((DATA.priorityRanked && DATA.priorityRanked.mainPoolCodes) || []);
  // 신규 overlapBadges 렌더링
  const BADGE_STYLE = {
    '10시 생존 확인': 'background:#a7f3d0;color:#064e3b;',
    '조기 포착':      'background:#fde68a;color:#92400e;',
    '안정형':         'background:#fde68a;color:#92400e;',
    '공격형 재돌파':   'background:#fecaca;color:#7f1d1d;',
    '공격형 재돌파 동시': 'background:#fecaca;color:#7f1d1d;',
    '공격형 재돌파도 통과': 'background:#fecaca;color:#7f1d1d;',
    'FADED 회복 동시': 'background:#bfdbfe;color:#1e3a8a;',
    '10시 확인 필요':  'background:#e5e7eb;color:#374151;',
    '추격 주의':      'background:#fed7aa;color:#7c2d12;',
    '추격 부담':      'background:#fed7aa;color:#7c2d12;',
    '폭발형 관찰':    'background:#fed7aa;color:#7c2d12;',
    'FADED 단독 위험': 'background:#fecaca;color:#7f1d1d;',
    '시총 대비 거래대금만 큰 유형': 'background:#fecaca;color:#7f1d1d;',
  };
  const renderOverlapBadges = (badges) => {
    if (!Array.isArray(badges) || badges.length === 0) return '';
    return badges.map((b) => '<span class="overlap-badge" style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;margin-left:4px;' + (BADGE_STYLE[b] || 'background:#e5e7eb;color:#374151;') + '">' + b + '</span>').join('');
  };
  const renderCard = (e, statusCls) => {
    const m = e.metrics || {};
    const sign = (m.openToLastRate >= 0 ? '+' : '');
    const strategy = e.suggestedStrategy;
    let strategyChip = '';
    if (strategy) {
      if (strategy.type === 'READY_ALIVE_1000') {
        strategyChip = '<div class="summary-line" style="color:#064e3b;background:#a7f3d0;padding:5px 9px;border-radius:4px;margin-top:4px;font-size:11px;">✅ 10시 생존형: 진입 시점 <strong>10:00 확인 후</strong>, TP <strong>' + strategy.takeProfit + '</strong> / SL <strong>' + strategy.stopLoss + '</strong> — ' + strategy.note + '</div>';
      } else if (strategy.type === 'STABLE_SCALP') {
        strategyChip = '<div class="summary-line" style="color:#92400e;background:#fde68a;padding:5px 9px;border-radius:4px;margin-top:4px;font-size:11px;">💰 안정형 (조기 포착): TP <strong>' + strategy.takeProfit + '</strong> / SL <strong>' + strategy.stopLoss + '</strong> — ' + strategy.note + '</div>';
      } else if (strategy.type === 'ATTACK_REBREAK') {
        strategyChip = '<div class="summary-line" style="color:#7f1d1d;background:#fecaca;padding:5px 9px;border-radius:4px;margin-top:4px;font-size:11px;">🔥 공격형 감시: TP <strong>' + strategy.takeProfit + '</strong> / SL <strong>' + strategy.stopLoss + '</strong> (보수형 ' + strategy.conservativeTakeProfit + '/' + strategy.conservativeStopLoss + ') — ' + strategy.note + '</div>';
      }
    }
    const survivorChip = e.isSurvivor1000 && e.survivor1000
      ? '<div class="summary-line" style="color:#064e3b;font-size:11px;margin-top:3px;">✅ 10:00 close ' + fmtN(e.survivor1000.close1000) + '원 — 09:30 기준 <strong>+' + e.survivor1000.aliveRate1000 + '%</strong> 유지 (high 대비 ' + e.survivor1000.closeToHighDrop_1000 + '%, 저점 ' + e.survivor1000.minLowDrop_0931_1000 + '%)</div>'
      : '';
    const tenRebreakChip = e.hasTenRebreak && e.tenRebreakTrigger
      ? '<div class="summary-line" style="color:#7f1d1d;font-size:11px;margin-top:3px;">↗ TEN_REBREAK 재돌파 @' + e.tenRebreakTrigger.triggerTime + ' (' + fmtN(e.tenRebreakTrigger.triggerPrice) + '원)</div>'
      : '';
    const reasonChip = e.reason
      ? '<div class="summary-line" style="color:#94a3b8;font-size:10.5px;margin-top:3px;font-style:italic;">└ ' + e.reason + '</div>'
      : '';
    return '<div class="card s-' + e.status + '">' +
      '<h3><a class="name-link" href="/one-day-surge-board/' + e.code + '" title="' + (e.name || e.code).replace(/"/g,'&quot;') + ' 상세">' + (e.name || e.code) + '</a> <span class="code">' + e.code + '</span> <span class="market">' + (e.market || '') + '</span>' +
      ' <span class="badge ' + statusCls + '">' + (e.statusLabel || e.status) + '</span>' +
      // finalScore 배지 (READY 상태만 의미 있음)
      (e.status === 'READY' && Number.isFinite(e.finalScore) ? ' <span class="badge aux" title="실전 우선 후보 선출용 종합 점수 (finalScore)">final ' + e.finalScore.toFixed(1) + '</span>' : '') +
      // attackScore 배지 (공격형 후보만)
      (e.isAttackRebreak && Number.isFinite(e.attackScore) ? ' <span class="badge aux" style="background:#7f1d1d;color:#fecaca;" title="공격형 후보 정렬용 점수">attack ' + e.attackScore.toFixed(1) + '</span>' : '') +
      // overlapBadges (안정형 / 공격형 재돌파 / FADED 회복 / 추격 주의)
      renderOverlapBadges(e.overlapBadges) +
      // 전일 mainPool 겹침 배지
      (prevDayCodesSet.has(e.code) ? ' <span class="prev-day-overlap-badge" title="전일 mainPool에도 들어왔던 종목">🔥 어제도 강함</span>' : '') +
      '</h3>' +
      '<div class="metrics-grid">' +
        '<div class="metric"><div class="label">시가 → 09:30 close</div><div class="value">' + fmtN(m.open0900) + ' → ' + fmtN(m.last0930) + '원</div><div class="sub">' + sign + (m.openToLastRate || 0).toFixed(2) + '%</div></div>' +
        '<div class="metric"><div class="label">09:30 누적 거래대금</div><div class="value">' + fmtMoneyKR(m.value_0930) + '원</div><div class="sub">평균 30분 대비 ×' + (m.valueToAvgRatio_0930 || 0).toFixed(2) + '</div></div>' +
        '<div class="metric"><div class="label">종가 위치</div><div class="value">' + (m.closePosition0930 * 100).toFixed(0) + '%</div><div class="sub">고가-저가 중 마지막 close</div></div>' +
        '<div class="metric"><div class="label">고가 대비 마지막</div><div class="value">' + (m.highToLastDrop != null ? m.highToLastDrop.toFixed(2) + '%' : '-') + '</div><div class="sub">-2.5%↓ FADED</div></div>' +
        '<div class="metric"><div class="label">분봉 수</div><div class="value">' + (m.bars_total || 0) + '개</div><div class="sub">≥20 필요</div></div>' +
        '<div class="metric"><div class="label">시가총액</div><div class="value">' + fmtMoneyKR(e.marketCap) + '원</div><div class="sub">' + (e.market || '') + '</div></div>' +
      '</div>' +
      (m.rebreakMorningHigh ? '<div class="summary-line" style="color:#5eead4;">↗ 첫 10분 고점 재돌파 ✓</div>' : '') +
      survivorChip +
      tenRebreakChip +
      strategyChip +
      reasonChip +
    '</div>';
  };
  const c = sc.counts || {};
  const breakdown =
    '<span class="tps-pill ready">READY <span class="num">' + (c.READY || 0) + '</span></span>' +
    '<span class="tps-pill wait">WAIT_PULLBACK <span class="num">' + (c.WAIT_PULLBACK || 0) + '</span></span>' +
    '<span class="tps-pill faded">FADED <span class="num">' + (c.FADED || 0) + '</span></span>' +
    '<span class="tps-pill missing">WEAK <span class="num">' + (c.WEAK || 0) + '</span></span>' +
    '<span class="tps-pill insufficient">분봉 부족 <span class="num">' + (c.INSUFFICIENT_BARS || 0) + '</span></span>';
  // 스캐너 모드 + 후보/수집 메타 표시
  const modeLabel = sc.mode === 'full' ? '🔭 확장 스캔 (full)' : '⚡ 빠른 스캔 (quick)';
  const scanRange = sc.candidatesTarget
    ? '확장 스캔 ' + sc.candidatesTarget + '개 중 분봉 수집 ' + (sc.scannedCount || 0) + '개 완료 (' + ((sc.scannedCount || 0) / sc.candidatesTarget * 100).toFixed(1) + '%)'
    : '분봉 수집 ' + (sc.scannedCount || 0) + '개 (메인풀 기준)';
  const elapsedTxt = sc.elapsedSec != null ? ' · 스캐너 소요 ' + sc.elapsedSec + 's' : '';
  const headerInfo = '<div class="shelf-desc">' +
    '<div style="font-size:12px;margin-bottom:6px;">' +
      '<span style="color:#5eead4;font-weight:700;">' + modeLabel + '</span> · ' + scanRange + elapsedTxt +
    '</div>' +
    '<strong>오늘 09:00~09:30 분봉 기준으로 새로 잡힌 종목입니다.</strong> (전일 mainPool과 무관, 09:30 시점 강세 종목)<br>' +
    '유동성 통과 + 메트릭 계산 <strong>' + (sc.successCount || 0) + '개</strong> 중 위 상태로 분류.' +
    '</div>' +
    '<div style="margin:8px 0 14px;">' + breakdown + '</div>';
  // ── 신규 5섹션 구조 (60거래일 백테스트 결과 반영, 2026-05-14) ──
  // 운영 철학: 09:30 = 예선, 10:00 = 본선, 10:00 이후 = 실제 대응 후보
  // [1] ✅ 10시 생존 확인 후보 (메인, 60일 검증 1위 — 평균 +2.49% / 승률 69.9%)
  // [2] 🚀 09:30 조기 포착 후보 (= 기존 explosiveTop, 감시 후보로 강등)
  // [3] 🔥 공격형 재돌파 감시 후보 (= 기존 I 조건, 감시 후보)
  // [4] 📡 09:30 READY 1차 후보 (접힘)
  // [5] 👀 관찰/제외 후보 (WAIT_PULLBACK / FADED+cp 단독 / v/mc 단독 등 위험 유형)
  const survivor1000    = sc.survivor1000    || [];
  const explosiveStable = sc.explosiveStable || sc.explosiveTop || [];
  const attackRebreak   = sc.attackRebreak   || [];
  const readyRestFinal  = sc.readyRestFinal  || [];
  const watchOnly       = sc.watchOnly       || sc.explosiveWatch || [];
  const survivor1000Ready = !!sc.survivor1000Ready;
  const summary = sc.summary || {};
  const readyTotal = (sc.ready || []).length;

  let body = '';

  // 보드 상단 — 친절한 운영 철학 소개 + 오늘 상태 요약
  body += '<div style="margin:14px 0 14px;padding:14px 18px;background:linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(20,184,166,0.06) 100%);border-left:4px solid #10b981;border-radius:8px;color:#d1fae5;line-height:1.8;">' +
    '<div style="font-size:14px;color:#a7f3d0;font-weight:700;margin-bottom:8px;">📘 1DS는 이렇게 봅니다</div>' +
    '<div style="font-size:12px;color:#d1fae5;">' +
      '<div style="margin-bottom:6px;">' +
        '<span style="display:inline-block;min-width:120px;color:#fcd34d;font-weight:700;">⏰ 09:30 — 예선</span>' +
        '09:00~09:30 분봉으로 후보 풀을 만들고, 강한 종목을 1차로 추립니다. <strong>이 시점에는 아직 진입하지 않습니다.</strong>' +
      '</div>' +
      '<div style="margin-bottom:6px;">' +
        '<span style="display:inline-block;min-width:120px;color:#a7f3d0;font-weight:700;">⏰ 10:00 — 본선 진출 확인</span>' +
        '예선 통과 후보 중 10시까지 09:30 기준가 위에서 살아남았는지 확인합니다. <strong>여기서 살아남은 종목이 진짜 메인 후보입니다.</strong>' +
      '</div>' +
      '<div style="margin-bottom:8px;">' +
        '<span style="display:inline-block;min-width:120px;color:#fff;font-weight:700;">🎯 10:00 이후 — 대응</span>' +
        '10시 생존 후보를 중심으로 실제 진입을 검토합니다. 09:30 조기 포착 / 공격형 재돌파는 보조 감시 후보일 뿐입니다.' +
      '</div>' +
      '<div style="padding:8px 12px;background:rgba(255,255,255,0.05);border-radius:4px;font-size:11.5px;line-height:1.7;">' +
        '<strong style="color:#a7f3d0;">📊 60거래일 백테스트 결과</strong>: ' +
        '<strong>READY + 10시 생존</strong> 후보가 평균 <strong>+2.49%</strong>, 승률 <strong>69.9%</strong>, ' +
        '+5% 도달 52.6%, +10% 도달 18.2%로 가장 좋은 결과를 보였습니다. 다른 신규/기존 모델을 전부 압도. ' +
        '<span style="color:#fcd34d;">09:30에 바로 들어가는 모델이 아니라, 09:30 후보 중 10:00까지 살아남은 종목을 찾는 모델입니다.</span><br>' +
        '<span style="color:#fda4af;">⚠ 단, 장중 급락 사례가 있으므로 손절 기준(-3%) 없이 보유하면 위험합니다.</span>' +
      '</div>' +
    '</div>' +
    '<div style="margin-top:10px;padding:9px 12px;background:rgba(255,255,255,0.04);border-radius:4px;font-size:12px;">' +
      '<strong style="color:#fff;">오늘 1DS 상태</strong> · ' +
      '09:30 READY ' + (summary.readyCount != null ? summary.readyCount : readyTotal) + '개' +
      ' &nbsp;/&nbsp; <span style="color:#a7f3d0;">✅ 10시 생존 ' + (survivor1000.length) + '개</span>' +
      ' &nbsp;/&nbsp; 🚀 조기 포착 ' + explosiveStable.length + '개' +
      ' &nbsp;/&nbsp; 🔥 공격형 감시 ' + attackRebreak.length + '개' +
      ' &nbsp;/&nbsp; 📡 1차 ' + readyRestFinal.length + '개' +
      ' &nbsp;/&nbsp; 👀 관찰/제외 ' + watchOnly.length + '개<br>' +
      (survivor1000Ready
        ? '<span style="color:#a7f3d0;font-weight:700;margin-top:4px;display:inline-block;">✅ 10:00 생존 확인 완료 — 메인 후보는 위 <strong>10시 생존 확인 후보</strong>입니다. 그 종목들을 우선 보세요.</span>'
        : '<span style="color:#fcd34d;font-weight:700;margin-top:4px;display:inline-block;">⏳ 10:00 생존 확인 전 — 지금 보이는 후보는 모두 <strong>예선 단계</strong>입니다. 10:01 이후 새로고침하면 메인 후보가 채워집니다.</span>') +
    '</div>' +
  '</div>';

  // ── [1] ✅ 10시 생존 확인 후보 (메인) ──
  if (survivor1000.length > 0) {
    body += '<h3 style="margin:14px 0 6px;color:#a7f3d0;font-size:19px;">✅ 10시 생존 확인 후보 (' + survivor1000.length + '건) — 메인 후보</h3>' +
      '<div class="shelf-desc" style="color:#d1fae5;line-height:1.8;">' +
        '09:30 READY 후보 중 <strong>10:00까지 09:30 기준가 위에서 살아남은 종목</strong>입니다. ' +
        '60거래일 백테스트에서 평균 <strong>+2.49%</strong>, 승률 <strong>69.9%</strong>, +5% 도달률 <strong>52.6%</strong>, +10% 도달률 <strong>18.2%</strong>로 가장 좋은 결과를 보였습니다.<br>' +
        '<strong>기본 대응</strong>: 10:00 생존 확인 후 진입 검토. <strong>+5% 구간은 1차 수익 실현</strong>, <strong>+10%는 확장 목표</strong>, <strong>-3% 이탈은 실패</strong>로 봅니다.<br>' +
        '<span style="color:#fda4af;font-weight:700;">⚠ 10시 생존 후보라도 손절 기준 없이 보유하면 위험합니다. 장중 급락 사례가 있으므로 기준가 이탈과 고점 이탈을 반드시 확인하세요.</span>' +
      '</div>' +
      '<div style="margin-top:8px;">' + survivor1000.map((e) => renderCard(e, 'value-strong')).join('') + '</div>';
  } else if (!survivor1000Ready) {
    body += '<h3 style="margin:14px 0 6px;color:#fcd34d;font-size:19px;">⏳ 10시 생존 확인 후보 — 10:00 확인 대기</h3>' +
      '<div class="empty-list" style="padding:14px;color:#fde68a;line-height:1.7;background:rgba(252,211,77,0.06);border-left:3px solid #fcd34d;border-radius:4px;">' +
        '<strong>10:00 생존 확인 전입니다.</strong> 현재는 09:30 예선 후보만 표시됩니다.<br>' +
        '<span style="font-size:11px;color:#fed7aa;">10:00 cron 또는 admin trigger 실행 후 이 섹션이 채워집니다 (60거래일 검증 1위 모델).</span>' +
      '</div>';
  } else {
    body += '<h3 style="margin:14px 0 6px;color:#94a3b8;font-size:19px;">✅ 10시 생존 확인 후보 (0건)</h3>' +
      '<div class="empty-list" style="padding:14px;color:#94a3b8;">10:00 분봉 확인 결과 살아남은 READY 후보가 없습니다. 아래 09:30 조기 포착 / 공격형 감시 후보를 참고하세요.</div>';
  }

  // ── [2] 🚀 09:30 조기 포착 후보 (= 기존 explosiveTop, 감시 후보) ──
  if (explosiveStable.length > 0) {
    body += '<h3 style="margin:18px 0 6px;color:#fcd34d;font-size:17px;">🚀 09:30 조기 포착 후보 (' + explosiveStable.length + '건)</h3>' +
      '<div class="shelf-desc" style="color:#fde68a;line-height:1.7;">' +
        '09:00~09:30 사이 거래대금과 가격 흐름이 강하게 잡힌 <strong>조기 포착 후보</strong>입니다. ' +
        '단, 60거래일 검증 결과 최종 성과는 <strong>10:00까지 살아남은 READY 후보가 더 좋았습니다</strong>. ' +
        '이 섹션은 <strong>10시 생존 여부를 확인하기 전 감시 후보</strong>로 봅니다.<br>' +
        '09:30 조기 대응 시 <strong>+5%/-2% 또는 +10%/-3%</strong> 전략을 참고할 수 있지만, 우선순위는 10시 생존 확인 후보보다 낮습니다.' +
      '</div>' +
      '<div style="margin-top:8px;">' + explosiveStable.map((e) => renderCard(e, 'value-strong')).join('') + '</div>';
  }

  // ── [3] 🔥 공격형 재돌파 감시 후보 (기본 접힘) ──
  if (attackRebreak.length > 0) {
    body += '<details style="margin-top:16px;border:1px solid #7f1d1d;background:rgba(127,29,29,0.06);border-radius:8px;padding:0 10px;"><summary style="cursor:pointer;font-size:15px;font-weight:700;color:#fca5a5;padding:10px 0;">🔥 공격형 재돌파 감시 후보 (' + attackRebreak.length + '건) — 펼쳐서 보기</summary>' +
      '<div class="shelf-desc" style="color:#fecaca;line-height:1.7;padding-top:6px;">' +
        '09:30 조건과 재돌파 흐름을 함께 만족한 <strong>공격형 감시 후보</strong>입니다. ' +
        '60거래일 검증에서 <strong>+10%/-3% 기준 평균 +1.62%</strong>로 유효했지만, 하루 단위로는 실패가 크게 나올 수 있습니다. ' +
        '10시 생존 여부를 함께 확인하세요.<br>' +
        '<strong>공격형 기준</strong>: +10% 익절 / -3% 손절 · <strong>보수형 기준</strong>: +5% 익절 / -2% 손절.<br>' +
        '<span style="color:#fda4af;font-weight:700;">⚠ 재돌파 분봉이 마지막 고점이 되는 실패 사례가 있습니다. 즉시 추격보다 10시 생존 확인과 손절 기준을 함께 봅니다.</span>' +
      '</div>' +
      '<div style="margin-top:8px;padding-bottom:10px;">' + attackRebreak.map((e) => renderCard(e, 'value-strong')).join('') + '</div></details>';
  }

  // ── [3.5] 🚀 이미 크게 발화한 종목 (표시 정책 후처리 — 메인 섹션에서 분리) ─────
  // 10시 생존 / 09:30 강한 후보 등 메인 섹션에서 +20% 이상 진행된 종목을 별도 노출.
  // 공격형 후보는 위험 사유로 제거하지 않으며, attackRiskLevel만 부여한다.
  const alreadyFiredList = sc.alreadyFired || [];
  if (alreadyFiredList.length > 0) {
    body += '<h3 style="margin:18px 0 6px;color:#fdba74;font-size:16px;">🚀 이미 크게 발화한 종목 (' + alreadyFiredList.length + '건) — 추격 주의</h3>' +
      '<div class="shelf-desc" style="color:#fed7aa;line-height:1.7;background:rgba(251,146,60,0.06);border-left:3px solid #fb923c;padding:8px 12px;border-radius:4px;">' +
        '09:30 기준 강하게 잡혔더라도 이미 상한가 또는 상한가 근처까지 진행된 종목입니다. ' +
        '<strong>신규 감시 후보가 아니라 발화 완료/추격 주의 대상으로 분리</strong>합니다. ' +
        '09:30 또는 10:00 기준으로 전일 종가 대비 +' + (sc.displayPolicySummary?.threshold || 20) + '% 이상 진행됐거나 시가 대비 큰 폭으로 올라간 상태입니다.<br>' +
        '<span style="color:#fda4af;font-weight:700;">⚠ 큰 변동 후 흔들림/차익 매물 출회 위험이 있어 신규 진입 후보처럼 다루지 않습니다.</span>' +
      '</div>' +
      '<div style="margin-top:8px;">' + alreadyFiredList.map((e) => renderCard(e, 'value-strong')).join('') + '</div>';
  }

  // ── [4] 📡 09:30 READY 1차 후보 (기본 접힘) ──
  if (readyRestFinal.length > 0) {
    body += '<details style="margin-top:14px;border:1px solid #475569;background:#0f172a;border-radius:8px;padding:0 10px;"><summary style="cursor:pointer;font-size:14px;font-weight:700;color:#5eead4;padding:10px 0;">📡 09:30 READY 1차 후보 (' + readyRestFinal.length + '건) — 펼쳐서 보기</summary>' +
      '<div class="shelf-desc" style="color:#94a3b8;margin-top:6px;padding-bottom:8px;">' +
        '09:30 기준 기본 조건을 통과한 <strong>예선 후보</strong>입니다. ' +
        '60거래일 검증상 이 후보 전체보다 10시까지 살아남은 후보의 성과가 훨씬 좋았습니다. ' +
        '<strong>10시 확인 전까지는 최종 진입 후보로 보지 않습니다.</strong>' +
      '</div>' +
      '<div style="margin-top:8px;padding-bottom:10px;">' + readyRestFinal.map((e) => renderCard(e, 'value-mid')).join('') + '</div></details>';
  }

  // ── [5] 👀 관찰/제외 후보 (기본 접힘) ──
  if (watchOnly.length > 0) {
    body += '<details style="margin-top:12px;"><summary style="cursor:pointer;font-size:14px;font-weight:700;color:#fb923c;padding:6px 0;">👀 관찰/제외 후보 (' + watchOnly.length + '건, 즉시 진입 X) — 펼쳐서 보기</summary>' +
      '<div class="shelf-desc" style="color:#fed7aa;margin-top:6px;background:rgba(251,146,60,0.08);border-left:3px solid #fb923c;padding:8px 12px;border-radius:4px;line-height:1.7;">' +
        '추격 부담, 과열, FADED 단독, WAIT_PULLBACK 등 <strong>즉시 진입에 부적합한 후보</strong>입니다. ' +
        '조건이 좋아 보이더라도 60거래일 검증에서 위험하거나 성과가 약했던 유형은 진입 후보로 표시하지 않습니다.<br>' +
        '<span style="font-size:11px;color:#fde68a;">제외 사유: WAIT_PULLBACK / open≥8% / v/mc≥5% 단독 / FADED+cp≥0.70 / FADED 단독 등 (60일 검증 fail3 60% 이상 유형)</span>' +
      '</div>' +
      '<div style="margin-top:8px;">' + watchOnly.map((e) => renderCard(e, 'aux')).join('') + '</div></details>';
  }

  const headerCount = '✅ 10시생존 ' + survivor1000.length + ' / 🚀 조기포착 ' + explosiveStable.length + ' / 🔥 공격형 ' + attackRebreak.length;
  const headerTitle = sc.candidatesTarget
    ? '📡 오늘 09:30 실제 포착 후보 — ' + headerCount + ' <span style="font-size:13px;color:#94a3b8;font-weight:400;">(확장 스캔 ' + sc.candidatesTarget + '개 중 분봉 ' + (sc.scannedCount || 0) + '개)</span>'
    : '📡 오늘 09:30 실제 포착 후보 — ' + headerCount + ' <span style="font-size:13px;color:#94a3b8;font-weight:400;">(분봉 ' + (sc.scannedCount || 0) + '개)</span>';
  host.innerHTML = '<section class="entry-shelf-section top" style="border:2px solid #5eead4;background:linear-gradient(135deg,#042f2e 0%,#1e293b 100%);">' +
    '<h2>' + headerTitle + '</h2>' +
    headerInfo + body +
  '</section>';
})();

// ── 장전 보조 섹션 제거 (2026-05-14) ──
// 기존 ① 전일 후보 09:30 상태표 / ② 추가 확인 / ③ 보류/재관찰 / ③-2 분봉 미확인 / ④ 재관찰 후보 섹션 모두 제거.
// 이유: 1DS 운영 철학이 09:30 = 예선 / 10:00 = 본선 모델로 변경되면서 "어제 mainPool" 관점 후보군은
// 더 이상 메인 의사결정에 사용되지 않음. 위 scanner0930 5섹션 구조가 모든 정보를 대체.

// ── 위험 후보 제외 안내 (보드는 추천만 노출 — 위험 분석은 연구 보고서) ──
(function renderRiskExcludedNote() {
  const host = document.getElementById('risk-excluded-note');
  if (!host) return;
  const v = DATA.visibilityCounts || {};
  const breakdown = v.riskExcludeBreakdown || {};
  const total = v.riskExcluded || 0;
  if (total === 0) return;
  const reasonLabels = {
    group_off_pool:    '위험형/저탄력 그룹 (상한가형·초경량·대형·준중대형)',
    gap_hold_candle:   '갭상승 후 종가 유지형 (시초가 추격 위험)',
    prev_high_spike:   '전일 고점 돌파 spike (단발성 급등 후 흔들림 큼)',
    risk_rebreak:      '위험 그룹의 장초 재상승',
    peak_before_entry: '이미 초반 고점 통과 (09:10 진입 시점에 고점 후)',
    trap_risk_high:    '윗꼬리·최근 과열 누적 위험',
  };
  const items = Object.entries(breakdown).filter(([_, n]) => n > 0)
    .map(([reason, n]) => '<li>' + (reasonLabels[reason] || reason) + ': <strong>' + n + '건</strong></li>').join('');
  host.innerHTML = '<section class="entry-shelf-section" style="border:1px solid #475569;background:#0f172a;margin-top:14px;">' +
    '<details><summary style="cursor:pointer;font-size:13px;font-weight:600;color:#94a3b8;padding:6px 0;">' +
      '🛡 위험 신호가 큰 후보는 운영 화면에서 제외됨 (' + total + '건) — 사유만 보기</summary>' +
    '<div style="margin-top:10px;font-size:12px;color:#cbd5e1;line-height:1.7;">' +
      '<div style="color:#94a3b8;margin-bottom:8px;">제외된 종목명은 운영 화면에 노출하지 않습니다. 사유와 건수만 표시합니다.</div>' +
      '<ul style="margin:0;padding-left:20px;">' + items + '</ul>' +
    '</div></details>' +
  '</section>';
})();

document.getElementById('foot').innerHTML =
  '<strong>🎯 1DS 운영 철학 — 09:30 = 예선, 10:00 = 본선, 10:00 이후 = 실제 대응</strong><br><br>' +
  '<strong>왜 09:30에 바로 들어가지 않는가?</strong><br>' +
  '• 60거래일 백테스트 결과, 09:30에 강해 보였던 종목 중 절반 이상이 10시 전에 무너졌습니다.<br>' +
  '• 09:30 후보를 그대로 매수하면 평균 +0.37%, 승률 39% 수준입니다 (READY 전체 기준).<br>' +
  '• 반면 09:30 READY 후보 중 <strong>10:00까지 09:30 기준가 위에서 살아남은 종목</strong>만 골라 보유했을 때 평균 <strong>+2.49%</strong>, 승률 <strong>69.9%</strong>로 가장 좋은 결과를 보였습니다.<br>' +
  '• 즉, 09:30은 후보를 만드는 <strong>예선</strong>이고, 10:00까지의 흐름을 본 뒤에 진입하는 게 <strong>본선</strong>입니다.<br><br>' +
  '<strong>📌 5섹션 구조</strong><br>' +
  '• <strong>1️⃣ ✅ 10시 생존 확인 후보</strong> — 메인. 10:00 분봉 확인 후에만 채워짐. 진입 검토 1순위.<br>' +
  '• <strong>2️⃣ 🚀 09:30 조기 포착 후보</strong> — 09:30에 강하게 잡힌 explosiveTop. 10시 생존 확인 전 감시 후보.<br>' +
  '• <strong>3️⃣ 🔥 공격형 재돌파 감시 후보</strong> — 09:30 조건 + TEN_REBREAK 동시 충족. +10%/-3% 노리는 공격형, 감시만.<br>' +
  '• <strong>4️⃣ 📡 09:30 READY 1차 후보</strong> — 예선 통과만 한 나머지. 메인 후보 아님.<br>' +
  '• <strong>5️⃣ 👀 관찰/제외 후보</strong> — WAIT_PULLBACK / FADED+cp 단독 / v/mc 단독 등 60일 검증 위험 유형.<br><br>' +
  '<strong>🛡 메인 후보가 자동 제외하는 종목</strong><br>' +
  '• ETF / ETN / 리츠 / 스팩 / 우선주 / 관리종목 / 시총 500억 미만·5조 이상<br>' +
  '• 60거래일 검증에서 fail3 60% 이상이었던 유형 (v/mc≥5% 단독, FADED+cp≥0.70 단독, open≥8%, WAIT_PULLBACK 등)<br><br>' +
  '<strong>⚠ 운영 주의</strong><br>' +
  '• <strong>10시 생존 후보라도 손절 기준 없이 보유하면 위험합니다.</strong> 장중 급락 사례가 있으므로 -3% 이탈은 실패로 보고 정리하세요.<br>' +
  '• <strong>09:30에 즉시 매수 확정 신호가 아닙니다.</strong> 09:30~10:00은 후보 관찰만, 10:00 본선 확인 후 진입 검토.<br>' +
  '• 본 보드는 일봉 캐시 + 09:30 분봉 + 10:00 분봉을 결합한 의사결정 도구이며, 매수 추천이 아니라 <strong>후보를 좁혀주는 운영 보드</strong>입니다.';

// ─────────────────────────────────────────────────────────────────
// 🕐 1DS 오전 갱신 일정 카드 — 현재 KST 시각 기준으로 cron 흐름 + 다음 새로고침 권장 시각 안내
// ─────────────────────────────────────────────────────────────────
(function renderCronSchedule() {
  const host = document.getElementById('cron-schedule-host');
  if (!host) return;
  const ms = DATA.marketStatus || {};
  // 휴장일 / 장 마감 후는 숨김
  if (ms.status === 'holiday_closed' || ms.isMarketClosed) return;
  // 현재 KST 시각 (분 단위) — generatedAtTime은 보드 생성 시점, 페이지 시각이 더 최신일 수 있어 클라이언트 Date 사용
  const now = new Date();
  // KST = UTC+9
  const kst = new Date(now.getTime() + (now.getTimezoneOffset() + 9 * 60) * 60 * 1000);
  const hh = kst.getHours(), mm = kst.getMinutes();
  const kstMin = hh * 60 + mm;
  const nowLabel = String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0');
  // 단계 정의
  const T_0930 = 9 * 60 + 30;
  const T_0942 = 9 * 60 + 42;
  const T_1003 = 10 * 60 + 3;
  const T_1530 = 15 * 60 + 30;
  function stage(t) {
    if (kstMin < t) return 'future';
    if (kstMin < t + 2) return 'now'; // 시작 2분 안은 진행 중
    return 'done';
  }
  const s0930 = stage(T_0930);
  const s0942 = stage(T_0942);
  const s1003 = stage(T_1003);
  const s1530 = stage(T_1530);
  // 현재 위치 — 가장 가까운 미완료 cron
  let nextHint = '';
  if (kstMin < T_0930)      nextHint = '곧 09:30 — 메인 후보 산출 예정';
  else if (kstMin < T_0942) nextHint = '⏳ 다음 새로고침: 09:42 (공격형 TOP 잡힘)';
  else if (kstMin < T_1003) nextHint = '⏳ 다음 새로고침: 10:03분쯤 (10시 생존 후보 확정)';
  else if (kstMin < T_1530) nextHint = '✅ 모든 갱신 완료 — 결과는 장 마감 후 자동';
  else                       nextHint = '🏁 장 마감 — 페이지 최하단 결과 표 확인';

  // 첫 미완료 stage를 'now' 강조
  function mark(s, t) {
    if (kstMin < t) return 'future';
    if (kstMin >= t && kstMin < t + 8) return 'now'; // 시작 후 8분 내는 'now'
    return 'done';
  }
  // 더 직관적인 'now' = 다음에 대기 중인 stage
  function rowCls(t, _idx) {
    if (kstMin < t) {
      // 이게 다음 단계인가?
      const prev = (_idx === 0) ? 0 : [T_0930, T_0942, T_1003, T_1530][_idx - 1];
      return (kstMin >= prev) ? 'now' : 'future';
    }
    return 'done';
  }
  const rows = [
    { t: T_0930, label: '09:30',     desc: '메인 후보 산출 (분봉 09:00~09:30 수집)' },
    { t: T_0942, label: '09:42',     desc: '공격형 TOP 재판단 (09:40 분봉 보완)' },
    { t: T_1003, label: '10:03분쯤', desc: '10시 생존 후보 확정 (10:01 첫 시도 / 10:03·10:05 retry)' },
    { t: T_1530, label: '15:30',     desc: '장 마감 후 결과 표시 (mainResult 표 자동 채워짐)' },
  ];
  const rowsHtml = rows.map((r, i) => {
    const cls = rowCls(r.t, i);
    const icon = cls === 'done' ? '✅' : cls === 'now' ? '⏳' : '○';
    return '<div class="cs-row ' + cls + '"><span class="cs-icon">' + icon + '</span><span class="cs-time">' + r.label + '</span><span>' + r.desc + '</span></div>';
  }).join('');

  host.innerHTML = (
    '<div class="cron-schedule-card">' +
    '<div class="cs-head">' +
      '<span class="cs-title">🕐 오늘 1DS 갱신 일정</span>' +
      '<span class="cs-now">현재 KST ' + nowLabel + '</span>' +
      '<span class="cs-next">' + nextHint + '</span>' +
    '</div>' +
    rowsHtml +
    '<div class="cs-note">10:03분쯤 새로고침이 가장 안정적 — 10시 생존 후보가 모두 확정된 후이고 공격형 TOP도 10:00 분봉 반영으로 더 정확해집니다.</div>' +
    '</div>'
  );
})();

// ─────────────────────────────────────────────────────────────────
// 🔥 공격형 TOP 1DS 섹션 (BIG_MONEY_REBREAK 기반)
// 60일 BIG RUNNER 감사 strong 등급 검증된 조건. 기존 1DS 후보 위에 얹는 상위 필터.
// ─────────────────────────────────────────────────────────────────
(function renderAttackTop() {
  const host = document.getElementById('attack-top-host');
  if (!host) return;
  const sum = DATA.attackTopSummary;
  const cards = DATA.attackTopCandidates || [];
  if (!sum) return;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fnum(v, p) { return v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(p != null ? p : 2); }
  function fpct(v, p) { return v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(p != null ? p : 2) + '%'; }
  function fmoneyLocal(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + '조';
    if (v >= 1e8)  return (v / 1e8 ).toFixed(1) + '억';
    if (v >= 1e4)  return (v / 1e4 ).toFixed(0) + '만';
    return Math.round(v).toLocaleString();
  }

  const vs = sum.validationSnapshot || {};
  const bmr = vs.bigMoneyRebreak || {};
  const base = vs.base || {};

  const modeBanner = sum.decisionMode ? (
    '<div class="mode-banner">' +
    '<span class="mode-pill">' + esc(sum.decisionMode.label) + '</span>' +
    '기준 시점 <b>' + esc(sum.generatedAtDecisionTime || '—') + '</b> · ' +
    esc(sum.decisionMode.guide) +
    '</div>'
  ) : '';

  const overflow = sum.overflowWarning ? (
    '<div class="warn-overflow">⚠ 공격형 TOP 후보가 ' + sum.count + '개 — 후보 과다. 거래대금 순위와 재돌파 동반 여부를 우선 확인하세요.</div>'
  ) : '';

  const summaryGrid = (
    '<div class="attack-top-grid">' +
    '<div class="cell"><div class="lbl">공격형 TOP 후보</div><div class="val">' + sum.count + '</div><div class="sub">BIG_MONEY_REBREAK 통과</div></div>' +
    '<div class="cell"><div class="lbl">재돌파 + 거래대금</div><div class="val">' + sum.rebreakWithValueCount + '</div><div class="sub">동반 후보</div></div>' +
    '<div class="cell"><div class="lbl">2차 파동</div><div class="val">' + sum.secondWaveCount + '</div><div class="sub">09:45~ 거래대금 1.2배+</div></div>' +
    '<div class="cell"><div class="lbl">위험 태그 후보</div><div class="val">' + sum.riskCount + '</div><div class="sub">갭/변동성/추격</div></div>' +
    '<div class="cell"><div class="lbl">분봉 가용</div><div class="val">' + sum.candidatesWithMinute + '</div><div class="sub">/' + sum.totalCandidates + ' (모집단)</div></div>' +
    '</div>'
  );

  const validationLine = (
    '<div class="validation">' +
    '<strong>60일 감사 검증 (' + (vs.passLevel || 'strong') + '):</strong> 거래대금 상위 10% + 재돌파 = BIG10 ' +
    (bmr.big10 != null ? bmr.big10 + '%' : '—') + ', BIG15 ' +
    (bmr.big15 != null ? bmr.big15 + '%' : '—') + ', BIG20 ' +
    (bmr.big20 != null ? bmr.big20 + '%' : '—') + ', 평균 당일고가 ' +
    (bmr.avgDayHigh != null ? bmr.avgDayHigh + '%' : '—') + ' · BASE 1DS 전체: BIG10 ' +
    (base.big10 != null ? base.big10 + '%' : '—') + ', BIG15 ' +
    (base.big15 != null ? base.big15 + '%' : '—') + ', BIG20 ' +
    (base.big20 != null ? base.big20 + '%' : '—') + ', 평균고가 ' +
    (base.avgDayHigh != null ? base.avgDayHigh + '%' : '—') +
    '</div>'
  );

  function renderCard(c) {
    const cls = ['attack-card'];
    if (c.attackRank <= 5) cls.push('is-top');
    if (c.valueSecondWaveRatio != null && c.valueSecondWaveRatio >= 1.2) cls.push('has-second-wave');
    const tagsPos  = (c.attackTags || []).map((t) => '<span class="attack-chip pos">' + esc(t) + '</span>').join('');
    const tagsRisk = (c.riskTags   || []).map((t) => '<span class="attack-chip risk">' + esc(t) + '</span>').join('');
    return (
      '<div class="' + cls.join(' ') + '">' +
      '<div class="ac-head">' +
        '<span class="ac-rank">#' + c.attackRank + '</span>' +
        '<div class="ac-title">' +
          '<a class="name-link" href="/one-day-surge-board/' + esc(c.code) + '" title="' + esc(c.name) + ' 상세 (통일 상세 페이지)">' + esc(c.name) + '</a>' +
          '<span class="code">' + esc(c.code) + '</span>' +
          (c.market ? '<span class="market">' + esc(c.market) + '</span>' : '') +
        '</div>' +
        '<div class="ac-score">attackScore ' + fnum(c.attackScore, 1) +
          (c.oneDaySurgeScore != null ? ' · 1DS ' + fnum(c.oneDaySurgeScore, 0) : '') +
          (c.gtBand ? ' · ' + esc(c.gtBand) : '') +
        '</div>' +
      '</div>' +
      '<div class="ac-meta">기준 시각 <b>' + esc(c.decisionTime) + '</b> · 1DS 신호가 <b>' + fmt0(c.signalPrice) + '</b> · 현재가 <b>' + fmt0(c.decisionPrice) + '</b> · 전일종가 ' + fmt0(c.prevClose) + ' · 시가 ' + fmt0(c.open0900) + '</div>' +
      '<div class="ac-meta">09:00~현재 거래대금 <b>' + fmoneyLocal(c.morningValue) + '</b> · 거래대금 순위 <b>' + c.morningValueRank + '위 (상위 ' + fnum(c.morningValuePercentile, 1) + '%)</b> · 장초 고가 ' + fmt0(c.morningHigh) + '</div>' +
      '<div class="ac-meta">재돌파: <b class="pos">' + (c.rebreakMorningHigh ? '✓ ' + esc(c.rebreakTime || '') : '—') + '</b> · 거래대금 동반: <b class="' + (c.rebreakWithValue ? 'pos' : '') + '">' + (c.rebreakWithValue ? '✓' : '—') + '</b> · 2차 파동: <b class="' + (c.valueSecondWaveRatio != null && c.valueSecondWaveRatio >= 1.2 ? 'pos' : '') + '">' + (c.valueSecondWaveRatio != null && c.valueSecondWaveRatio >= 1.2 ? '✓ (' + fnum(c.valueSecondWaveRatio, 2) + 'x)' : '—') + '</b></div>' +
      '<div class="ac-meta">시가 대비 <b class="' + (c.decisionFromOpen >= 8 ? 'warn' : 'pos') + '">' + fpct(c.decisionFromOpen) + '</b> · 전일종가 대비 ' + fpct(c.decisionFromPrevClose) + ' · 갭 ' + fpct(c.gapRate) + ' · 장초 고저폭 ' + fpct(c.morningRangeRate) + '</div>' +
      (tagsPos  ? '<div class="ac-tags">' + tagsPos  + '</div>' : '') +
      (tagsRisk ? '<div class="ac-tags">' + tagsRisk + '</div>' : '') +
      '<div class="ac-comment">' + esc(c.shortComment) + '</div>' +
      // 장마감 후: 결과 inline 표시 (10시 시점 + 장 마감 두 줄). 장중: 안내.
      (function () {
        const r = c.dayResult;
        const e = c.earlyResult;
        const ms = DATA.marketStatus || {};
        if (!ms.isMarketClosed) return (
          '<div style="margin:6px 0;padding:8px 12px;background:rgba(252,211,77,0.12);border-left:3px solid #fbbf24;border-radius:4px;color:#fde68a;">' +
          '<div style="font-size:13px;font-weight:600;">📊 ⏳ 아직 장중입니다 <span style="font-weight:400;font-size:11.5px;color:#fcd34d;">(KST ' + esc(ms.generatedAtTime || '') + ')</span></div>' +
          '<div style="font-size:11px;color:#fcd34d;margin-top:3px;">결과(⏱ 10시까지 + 🏁 장 마감)는 장마감 후 자동 표시됩니다.</div>' +
          '</div>'
        );
        if (!r || !r.available) return '<div class="ac-result-pending">📊 결과: 미확정 (' + esc(r && r.reason ? r.reason : '데이터 부족') + ')</div>';
        function cls(v) { return v >= 5 ? 'result-pos' : v >= 0 ? 'result-warn' : 'result-neg'; }
        const dayHighCls  = cls(r.dayHighReturn);
        const dayCloseCls = cls(r.dayCloseReturn);
        const lblCls = r.reached15 ? 'result-label-big' : r.reached10 ? 'result-label-mid' : r.failedSpike ? 'result-label-fail' : 'result-label-warn';
        const baseHeader = (
          '<div style="margin:2px 0 6px;padding:6px 10px;background:rgba(252,211,77,0.12);border-left:3px solid #fbbf24;border-radius:4px;font-size:12.5px;color:#fde68a;">' +
          '💰 <b>진입 기준가 ' + Math.round(c.decisionPrice).toLocaleString() + '원</b> ' +
          '<span style="font-size:10.5px;color:#fcd34d;">(09:30 분봉 종가 — 아래 % 는 이 가격 대비 등락)</span>' +
          '</div>'
        );
        const earlyLine = e ? (
          '<div style="margin-top:4px;font-size:11px;">' +
          '<b style="color:#7dd3fc;">⏱ 10시까지:</b> ' +
          '고가 <b class="' + cls(e.highReturn)  + '">' + (e.highReturn  > 0 ? '+' : '') + e.highReturn  + '%</b> (' + Math.round(e.high).toLocaleString()  + ' @' + esc(e.highTime)  + ') · ' +
          '저가 <b class="' + cls(e.lowReturn)   + '">' + (e.lowReturn   > 0 ? '+' : '') + e.lowReturn   + '%</b> (' + Math.round(e.low).toLocaleString()   + ' @' + esc(e.lowTime)   + ') · ' +
          '10시 종가 <b class="' + cls(e.closeReturn) + '">' + (e.closeReturn > 0 ? '+' : '') + e.closeReturn + '%</b> (' + Math.round(e.close).toLocaleString() + ')' +
          '</div>'
        ) : '';
        const dayLine = (
          '<div style="margin-top:2px;font-size:11px;">' +
          '<b style="color:#fdba74;">🏁 장 마감:</b> ' +
          '고가 <b class="' + dayHighCls + '">' + (r.dayHighReturn  > 0 ? '+' : '') + r.dayHighReturn  + '%</b> (' + Math.round(r.dayHigh).toLocaleString()  + ')' +
          ' · 저가 <b class="' + cls(r.dayLowReturn) + '">' + (r.dayLowReturn > 0 ? '+' : '') + r.dayLowReturn + '%</b> (' + Math.round(r.dayLow).toLocaleString() + ')' +
          ' · 종가 <b class="' + dayCloseCls + '">' + (r.dayCloseReturn > 0 ? '+' : '') + r.dayCloseReturn + '%</b> (' + Math.round(r.dayClose).toLocaleString() + ')' +
          '</div>'
        );
        return '<div class="ac-result">' +
          '📊 <span class="' + lblCls + '">' + esc(r.resultLabel || '-') + '</span>' +
          baseHeader +
          earlyLine +
          dayLine +
          '</div>';
      })() +
      '</div>'
    );
  }
  function fmt0(v) { return v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString(); }

  let cardListHtml;
  if (cards.length === 0) {
    cardListHtml = '<div class="attack-empty">' +
      '현재 공격형 TOP 조건 (거래대금 상위 10% + 장초 고가 재돌파)을 만족한 후보가 없습니다.<br>' +
      '<span style="color:#fed7aa;font-size:11px;">' + (sum.message || '09:40 이후 분봉이 부족하거나 모집단이 부족할 수 있습니다.') + '</span>' +
      '</div>';
  } else if (cards.length <= 15) {
    cardListHtml = cards.map(renderCard).join('');
  } else {
    const first15 = cards.slice(0, 15).map(renderCard).join('');
    const rest = cards.slice(15).map(renderCard).join('');
    cardListHtml = first15 +
      '<details><summary>나머지 ' + (cards.length - 15) + '개 펼치기</summary>' + rest + '</details>';
  }

  // 고위험 공격형 sub-section (HIGH_RISK_ATTACK)
  const highRiskCards = DATA.attackTopHighRisk || [];
  const highRiskBlock = highRiskCards.length > 0
    ? ('<div style="margin-top:18px;padding:12px;border:1px solid #f59e0b;background:rgba(245,158,11,0.06);border-radius:8px;">' +
       '<h3 style="margin:0 0 6px;color:#fbbf24;font-size:15px;">⚠ 고위험 공격형 감시 후보 (' + highRiskCards.length + '건)</h3>' +
       '<div style="color:#fde68a;font-size:12px;line-height:1.6;margin-bottom:8px;">' +
       '<strong>위험 감수형 공격 후보</strong>입니다. 변동성이 크고 고점 이탈 위험이 있으나, ' +
       '장초 재상승/재돌파 흐름이 있어 공격형 감시 대상으로 유지합니다. ' +
       '<strong>제외가 아니라 위험 표시 강화</strong>로 분류합니다.' +
       '</div>' +
       highRiskCards.map(renderCard).join('') +
       '</div>')
    : '';

  host.innerHTML = (
    '<div class="attack-top-section">' +
    '<h2>🔥 공격형 TOP 1DS</h2>' +
    '<div class="subhdr">기존 1DS 중 거래대금이 크고, 장초 고가를 다시 뚫은 후보</div>' +
    '<div class="desc">' +
    '공격형 후보는 <strong>안전한 후보가 아니라 장초 거래대금, 고가 재돌파, 급등 흐름을 보는 고위험 감시 영역</strong>입니다. ' +
    '위험 태그가 있더라도 재상승 흐름이 있으면 후보로 유지하며, 이미 상한가성으로 너무 진행된 종목은 <strong>별도 발화 완료 섹션</strong>으로 분리합니다. ' +
    '<br>감사 결과, 이 조건은 기존 1DS 전체보다 당일 +10%, +15%, +20% 도달률이 높았습니다. ' +
    '<br>이 섹션은 매수 확정 신호가 아니라, 기존 1DS 중 큰 상승이 나올 가능성이 높았던 패턴을 우선 보여주는 필터입니다.' +
    '</div>' +
    validationLine +
    modeBanner +
    overflow +
    summaryGrid +
    cardListHtml +
    highRiskBlock +
    '</div>'
  );
})();

// ─────────────────────────────────────────────────────────────────
// 📊 오늘 1DS 결과 섹션 (장중: 안내만 / 장마감 후: 실제 결과 집계)
// ─────────────────────────────────────────────────────────────────
(function renderTodayResult() {
  const host = document.getElementById('today-result-host');
  if (!host) return;
  const ms = DATA.marketStatus;
  const sum = DATA.todayResultSummary;
  const cands = DATA.todayResultCandidates || { mainResult: [], attackTop: [], big10: [], big15: [], big20: [], failed: [], spikeFade: [] };
  if (!ms) return;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fn(v, p) { return v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(p != null ? p : 2); }
  function fp(v, p) { return v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(p != null ? p : 2) + '%'; }
  function f0(v) { return v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString(); }
  function chip(t) { return '<span style="font-size:10.5px;padding:1px 5px;border-radius:3px;background:#1e293b;color:#cbd5e1;margin:1px 2px 1px 0;display:inline-block;">' + esc(t) + '</span>'; }
  function chipBig(t) { return '<span class="chip-big">' + esc(t) + '</span>'; }
  function chipWarn(t) { return '<span class="chip-warn">' + esc(t) + '</span>'; }
  function chipFail(t) { return '<span class="chip-fail">' + esc(t) + '</span>'; }
  function tagChips(tags) {
    return (tags || []).map((t) => {
      if (t.startsWith('BIG') || t === '상한가 근처' || t === '강한 종가' || t === '종가 유지') return chipBig(t);
      if (t === '실패' || t === '종가 약함') return chipFail(t);
      return chipWarn(t);
    }).join('');
  }

  // 장중: 안내 배너만
  if (!ms.isMarketClosed) {
    host.innerHTML = (
      '<div class="today-result-section">' +
      '<h2>📊 오늘 1DS 결과</h2>' +
      '<div class="intraday-banner">' +
      '<div class="ib-title">📌 아직 장중입니다 (KST ' + esc(ms.generatedAtTime) + ')</div>' +
      '<div class="ib-line">현재 후보는 장중 기준으로 계산된 1DS 후보입니다.</div>' +
      '<div class="ib-line">당일 고가, 종가, BIG10/BIG15/BIG20 도달 여부는 <b>장마감 후 자동으로 표시</b>됩니다.</div>' +
      (ms.forcedNote ? '<div class="ib-line" style="color:#94a3b8;font-size:11px;margin-top:8px;">⚙ ' + esc(ms.forcedNote) + '</div>' : '') +
      '</div>' +
      '</div>'
    );
    return;
  }

  // 휴장 안내 (주말/공휴일/대체공휴일)
  let holidayNote = '';
  if (ms.status === 'holiday_closed') {
    holidayNote = (
      '<div class="intraday-banner" style="background:#1e1b4b;border-color:#a78bfa;margin-bottom:12px;">' +
      '<div class="ib-title" style="color:#c4b5fd;">📌 오늘은 휴장일입니다 (주말/공휴일/대체공휴일)</div>' +
      '<div class="ib-line" style="color:#ddd6fe;">' + esc(ms.todayDate || '') + (ms.todayWeekday ? ' (' + esc(ms.todayWeekday) + ')' : '') + ' — 한국 증시 휴장</div>' +
      (ms.previousTradingDate
        ? '<div class="ib-line" style="color:#ddd6fe;">직전 거래일 <b>' + esc(ms.previousTradingDate) + '</b> 결과를 아래에 표시합니다.</div>'
        : '<div class="ib-line" style="color:#fca5a5;">직전 거래일을 찾을 수 없습니다.</div>') +
      (ms.forcedNote ? '<div class="ib-line" style="color:#94a3b8;font-size:11px;margin-top:8px;">⚙ ' + esc(ms.forcedNote) + '</div>' : '') +
      '</div>'
    );
  }

  // 장마감 후: 결과 표시 (결과 데이터 없으면 안내)
  const sectionTitle = ms.status === 'holiday_closed'
    ? '📊 직전 거래일 1DS 결과' + (ms.previousTradingDate ? ' (' + ms.previousTradingDate + ')' : '')
    : '📊 오늘 1DS 결과';
  if (!sum || !sum.isAvailable) {
    host.innerHTML = (
      '<div class="today-result-section">' +
      '<h2>' + sectionTitle + '</h2>' +
      holidayNote +
      '<div class="warn-note">' +
      '⚠ ' + (ms.status === 'holiday_closed' ? '직전 거래일' : '장마감 후이지만') + ' 결과 집계 불가 — ' +
      (sum && sum.notes && sum.notes.length ? sum.notes.map(esc).join(' / ') : '일봉 데이터가 아직 저장되지 않았거나 분봉 미수집') +
      '</div>' +
      '<div class="empty-note">장마감 데이터가 저장된 뒤 보드를 다시 생성하면 결과가 표시됩니다.</div>' +
      '</div>'
    );
    return;
  }

  // mainResult 표: 09:30 cron이 실제로 포착한 핵심 후보 (survivor1000 + 공격형TOP)
  // 표시 기준: 전일종가 대비 % (오늘 어디까지 갔다, 어디까지 떨어졌다, 어떻게 끝났나)
  let mainResultTable = '';
  if (cands.mainResult && cands.mainResult.length > 0) {
    function clsFor(v) {
      if (!Number.isFinite(v)) return '';
      if (v >=  5) return 'pos';
      if (v >=  0) return 'warn';
      return 'neg';
    }
    function mrRow(c) {
      let srcChip;
      if (c.basePriceSource === 'survivor1000') {
        srcChip = '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:#064e3b;color:#a7f3d0;">✅ 10시생존</span>';
      } else if (c.basePriceSource === 'explosiveStable') {
        srcChip = '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:#3a1a04;color:#fdba74;">🚀 조기포착</span>';
      } else {
        srcChip = '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:#1e3a5f;color:#93c5fd;">⚡ 공격형</span>';
      }
      const hC = clsFor(c.prevRefHigh);
      const lC = clsFor(c.prevRefLow);
      const cC = clsFor(c.prevRefClose);
      return '<tr>' +
        '<td>' + srcChip + '</td>' +
        '<td><b>' + esc(c.name) + '</b><br><span style="color:#64748b;font-size:10.5px;">' + esc(c.code) + '</span></td>' +
        '<td style="text-align:right;color:#94a3b8;">' + f0(c.prevClose) + '</td>' +
        '<td class="' + hC + '" style="text-align:right;"><b>' + fp(c.prevRefHigh) + '</b>' +
          '<br><span style="color:#cbd5e1;font-size:10px;font-weight:400;">' + f0(c.dayHigh) + '원</span>' +
          (c.peakTime ? '<br><span style="color:#94a3b8;font-size:10px;">⏱ ' + esc(c.peakTime) + '</span>' : '') +
        '</td>' +
        '<td class="' + lC + '" style="text-align:right;"><b>' + fp(c.prevRefLow) + '</b>' +
          '<br><span style="color:#cbd5e1;font-size:10px;font-weight:400;">' + f0(c.dayLow) + '원</span>' +
          (c.troughTime ? '<br><span style="color:#94a3b8;font-size:10px;">⏱ ' + esc(c.troughTime) + '</span>' : '') +
        '</td>' +
        '<td class="' + cC + '" style="text-align:right;"><b>' + fp(c.prevRefClose) + '</b>' +
          '<br><span style="color:#cbd5e1;font-size:10px;font-weight:400;">' + f0(c.dayClose) + '원</span>' +
        '</td>' +
        '</tr>';
    }
    mainResultTable = (
      '<div style="margin-bottom:18px;">' +
      '<h3 style="margin:0 0 8px;font-size:16px;color:#e2e8f0;">📊 오늘 09:30 실제 후보 결과 (survivor1000 + 공격형TOP)</h3>' +
      '<div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">전일종가 대비 — 오늘 어디까지 올랐고(고가) / 어디까지 떨어졌고(저가) / 어떻게 마감했나(종가). 시각은 1분봉 기준.</div>' +
      '<table class="today-result-table">' +
      '<thead><tr><th>구분</th><th>종목</th><th style="text-align:right;">전일종가</th><th style="text-align:right;">당일 고가</th><th style="text-align:right;">당일 저가</th><th style="text-align:right;">종가</th></tr></thead>' +
      '<tbody>' + cands.mainResult.map(mrRow).join('') + '</tbody>' +
      '</table>' +
      '</div>'
    );
  }

  // 화면에는 mainResult 표 하나만 표시 (요약 카드/공격형 TOP/전체 1DS 요약/BIG10·15·20/실패/spikeFade 모두 제거)
  const body = mainResultTable || '<div class="empty-note">오늘 09:30 스냅샷이 없거나 결과 계산 불가입니다.</div>';
  host.innerHTML = (
    '<div class="today-result-section">' +
    '<h2>' + sectionTitle + '</h2>' +
    holidayNote +
    body +
    '</div>'
  );
})();
</script>

</body>
</html>
`;

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
