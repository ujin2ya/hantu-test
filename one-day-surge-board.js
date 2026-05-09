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

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');
const STOCKS_PATH = path.join(ROOT, 'stocks.json');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const QVA_BOARD_PATH = path.join(ROOT, 'qva-watchlist-board.json');
const PATTERN_RESULT_PATH = path.join(ROOT, 'cache', 'pattern-result.json');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const MANUAL_TARGETS_PATH = path.join(ROOT, 'data', 'manual-1ds-targets.json');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-board-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-board-result.html');

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

  // 5) prev_high_spike / peak_before_entry — morningHigh 재돌파 ✓이면 면제
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
function classifyMarketState() {
  const kospi = loadIndexLatestChange(KOSPI_DAILY_PATH);
  const kosdaq = loadIndexLatestChange(KOSDAQ_DAILY_PATH);
  if (!kospi && !kosdaq) {
    return { state: 'UNKNOWN', label: MARKET_STATE_LABELS.UNKNOWN, desc: MARKET_STATE_DESCS.UNKNOWN, kospi: null, kosdaq: null };
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

function main() {
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

  // 1차 통과 — passesHardFilter + analyze + 기본 메트릭 계산
  const candidates = [];
  const filterCounts = { no_meta: 0, etf: 0, special: 0, excluded_name: 0, no_marketcap: 0, mc_under_500: 0, mc_over_5t: 0 };
  let parseErrCount = 0;
  let skippedNoMetrics = 0;

  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    const filt = core.passesHardFilter(meta);
    if (!filt.ok) {
      filterCounts[filt.reason] = (filterCounts[filt.reason] || 0) + 1;
      continue;
    }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, f), 'utf-8')); }
    catch (_) { parseErrCount++; continue; }
    const rows = chart && chart.rows;
    const baseIdx = core.pickLatestBaseIdx(rows);
    if (baseIdx < 0) { skippedNoMetrics++; continue; }

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
    });
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
  const riskExcludeCounts = { group_off_pool: 0, gap_hold_candle: 0, prev_high_spike: 0, risk_rebreak: 0, peak_before_entry: 0, trap_risk_high: 0 };
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
  const topPriority   = mainPool.slice(0, TOP_PRIORITY_LIMIT);
  const extraPriority = mainPool.slice(TOP_PRIORITY_LIMIT, TOP_PRIORITY_LIMIT + EXTRA_PRIORITY_LIMIT);
  const overflowPool  = mainPool.slice(TOP_PRIORITY_LIMIT + EXTRA_PRIORITY_LIMIT); // 메인 풀 안에 있어도 화면에선 숨김

  // ── 자동 참고 매수가/매도가 계산 ──
  // mainPool(위험 필터 통과 + displayPriorityScore 내림차순) 상위에서 자동 계산 가능한 후보 10개에 tradePlan 부착.
  // 후보 선정/정렬은 그대로. 매수 추천이 아닌 참고 가격이며 시장가 매수 전제로 계산하지 않는다.
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
  const tradePlanSummary = {
    autoCount: tradePlanCalcSummary.autoCount,
    readyCount: tradePlanCalcSummary.readyCount,
    waitPullbackCount: tradePlanCalcSummary.waitPullbackCount,
    invalidatedCount: tradePlanCalcSummary.invalidatedCount,
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

  // 가시성 카운트 (요약 cards용)
  const totalRiskExcluded = Object.values(riskExcludeCounts).reduce((a, b) => a + b, 0);
  // morningHigh 재돌파 ✓로 위험 면제된 후보 수 (mainPool 통과)
  const riskExemptedCount = mainPool.filter((it) => it.riskExempted && it.riskExempted.length > 0).length;
  const visibilityCounts = {
    totalPool: candidates.length,        // 분류 가능한 모든 후보 (UNCLASSIFIED 포함 안 됨)
    unclassified,                        // 화면 표시 X
    mainPoolSize: mainPool.length,       // 위험 필터 통과 후 추천 풀 크기
    topPriorityShown: topPriority.length,
    extraPriorityShown: extraPriority.length,
    overflowHidden: overflowPool.length, // 메인 풀 16+ 위 — 화면 숨김
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
  const nextDirFreq = new Map();
  for (const it of all) {
    if (!it.nextDayDir) continue;
    nextDirFreq.set(it.nextDayDir, (nextDirFreq.get(it.nextDayDir) || 0) + 1);
  }
  let entryConfirmDate = null, entryConfirmFreq = 0;
  for (const [d, n] of nextDirFreq) { if (n > entryConfirmFreq) { entryConfirmFreq = n; entryConfirmDate = d; } }

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
    priorityRanked: {
      topPriority:    topPriority.map((it) => it.code),
      extraPriority:  extraPriority.map((it) => it.code),
      overflowHiddenCount: overflowPool.length,
      topPriorityLimit:   TOP_PRIORITY_LIMIT,
      extraPriorityLimit: EXTRA_PRIORITY_LIMIT,
      // 위험 필터 통과한 추천 풀 전체 코드 (top + extra + overflow). collect-1ds-intraday.js --from-board 가 이 리스트로 분봉 수집.
      mainPoolCodes: mainPool.map((it) => it.code),
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
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out)), 'utf-8');

  console.log(`\n  분석 기준일: ${analysisDate ? fmtDate(analysisDate) : '-'} (가장 흔한 baseDate, 빈도 ${maxFreq})`);
  console.log(`  필터 제외: ETF=${filterCounts.etf} 특수=${filterCounts.special} 키워드=${filterCounts.excluded_name} 시총미확인=${filterCounts.no_marketcap} <500억=${filterCounts.mc_under_500} ≥5조=${filterCounts.mc_over_5t}`);
  console.log(`  후보 풀: ${candidates.length}건 / 노출: ${all.length}건 / 미분류: ${unclassified}건`);
  for (const g of GT_GROUP_ORDER) console.log(`    ${g.padEnd(13)} ${grouped[g].length}건`);
  console.log(`  거래대금 ×3↑ ${valueSurgeCount} / LOW_GAP_INTRADAY ${lowGapCount} / v/mc≥10% ${highVmcCount}`);
  console.log(`  🎯 화면 노출 정책 (추천 후보만):`);
  console.log(`     ① 최우선 ${topPriority.length}건 (메인 노출)`);
  console.log(`     ② 추가 후보 ${extraPriority.length}건 (접힘, 최대 ${EXTRA_PRIORITY_LIMIT}개)`);
  console.log(`     ③ 메인 풀 overflow ${overflowPool.length}건 (화면 숨김)`);
  console.log(`     ④ 위험 필터로 제외 ${totalRiskExcluded}건 (보드 미노출, 위험 분석은 연구 보고서 참조):`);
  for (const [reason, n] of Object.entries(riskExcludeCounts)) {
    if (n > 0) console.log(`        - ${reason}: ${n}건`);
  }
  console.log(`     ⑤ UNCLASSIFIED ${unclassified}건 (영구 숨김)`);
  if (latestDayType) console.log(`  🌊 최근 거래일 (${latestDayType.date} → ${latestDayType.nextDate}) 분류: ${latestDayType.dayType}`);
  console.log(`  📈 시장 상태: ${marketState.label}` + (marketState.kospi ? ` (KOSPI ${marketState.kospi.changeRate.toFixed(2)}% / KOSDAQ ${marketState.kosdaq?.changeRate?.toFixed(2) || '-'}%)` : ''));
  if (topPriority.length > 0) {
    console.log(`  📋 최우선 ${topPriority.length}건 (displayPriorityScore):`);
    for (const it of topPriority) {
      const tagsStr = (it.entryStrategies || []).length > 0 ? ' [' + it.entryStrategies.join(',') + ']' : '';
      console.log(`     ${it.displayPriorityScore.toString().padStart(4)} | ${it.code} ${(it.name || '').padEnd(15)} | ${it.gtGroup}${tagsStr}`);
    }
  }
  console.log(`  🚪 장초 ENTRY_CONFIRM 적용: ${withMinute}건 / 분봉 누락 ${missing}건 (확인 거래일 ${entryConfirmDate || '없음'})`);
  if (withMinute === 0) {
    console.log(`     장초 분봉 확인 전 — 다음 거래일 09:35+ 분봉 수집 후 보드 재생성 시 적용됩니다.`);
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
.trade-plan-box.missing { background: #1e293b; border-style: dashed; border-color: #475569; }
.trade-plan-box .tp-header {
  font-size: 13px; font-weight: 700; color: #5eead4;
  margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #134e4a;
}
.trade-plan-box.wait    .tp-header { color: #fcd34d; border-bottom-color: #78350f; }
.trade-plan-box.invalid .tp-header { color: #fda4af; border-bottom-color: #881337; }
.trade-plan-box .tp-badge {
  display: inline-block; font-size: 10.5px; font-weight: 700;
  padding: 2px 7px; border-radius: 999px; margin-right: 6px;
  background: rgba(20,184,166,0.18); color: #5eead4; border: 1px solid #14b8a6;
}
.trade-plan-box.wait    .tp-badge { background: rgba(245,158,11,0.18); color: #fcd34d; border-color: #f59e0b; }
.trade-plan-box.invalid .tp-badge { background: rgba(244,63,94,0.18); color: #fda4af; border-color: #f43f5e; }
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
.tp-summary-strip .tps-pill.risk     { color: #fb923c; }
.tp-summary-strip .tps-pill.missing  { color: #94a3b8; }
.tp-summary-strip .tps-disclaimer { display: block; margin-top: 6px; font-size: 10.5px; color: #94a3b8; font-style: italic; }

.empty-list { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 24px; text-align: center; color: #64748b; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; }
  .metrics-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
</head>
<body>

<div style="background:linear-gradient(90deg,#1e1b4b 0%,#312e81 100%);border:1px solid #6366f1;border-radius:8px;padding:8px 14px;margin-bottom:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#c4b5fd;font-weight:700;letter-spacing:0.3px;">🟣 실험 라인 (QVA2)</span><a href="/qva2-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR (QVA2)</a><a href="/qva2-d5-rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파 (QVA2)</a><a href="/qva2-vvi" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파 (QVA2)</a><a href="/qva2-validation" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📊 검증</a></div>
<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/rebreak">🔥 D+5 재돌파 운용</a>
  <a href="/one-day-surge-board" class="active">⚡ 1DS 단타 후보</a>
  <a href="/qva-vvi-redefined-board">🎯 QVA 고점 재돌파</a>
</nav>

<!-- 운영자 상단 sticky 상태 배너 (스크롤 내려도 항상 보임) -->
<div class="status-banner-host-wrap"><div id="status-banner-host"></div></div>

<h1 id="board-h1">🎯 내일 장초 우선 확인 후보</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  이 보드는 <strong>과거 검증에서 장초 반응이 좋았던 유형만</strong> 추려 보여줍니다.
  먼저 확인할 5종목 + 추가 확인 10개(접힘)만 노출하고, 위험 신호가 큰 후보는 화면에서 제외했습니다.
  <br><br>
  <span style="font-size:11.5px;color:#94a3b8;line-height:1.7;">
    카드의 과거 성과 수치는 <strong>과거 40거래일 운영형 백테스트 결과</strong>입니다.
    참고용이며 <strong>오늘도 그대로 된다는 뜻은 아닙니다.</strong> 실제 진입과 대응은 본인의 판단입니다.
  </span>
</div>
<div id="market-banner-host"></div>
<div id="daytype-banner-host"></div>
<div class="filter-info" id="filter-info"></div>

<h2>📊 화면 요약</h2>
<div class="summary-grid" id="summary-grid"></div>
<div id="trade-plan-summary"></div>
<div id="qva-summary-line"></div>

<!-- ① 최우선 5종목 -->
<div id="top-priority-host"></div>

<!-- ② 추가 확인 후보 (접힘, 최대 10개) -->
<div id="extra-priority-host"></div>

<!-- 위험 후보는 내부 필터로 제외 — 위험 분석은 연구 보고서(/one-day-surge-entry-confirm, /one-day-surge-entry-daily-backtest)에서 -->
<div id="risk-excluded-note"></div>

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
    '<span class="tps-pill wait">눌림 대기 <span class="num">' + (tp.waitPullbackCount || 0) + '</span></span>',
    '<span class="tps-pill invalid">기준가 이탈 <span class="num">' + (tp.invalidatedCount || 0) + '</span></span>',
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

// 시간대 + 분봉 매칭 여부 → 8단계 status
function computeBoardStatus() {
  const e = DATA.entryShelf || {};
  const hasIntraday = e.analysisDateConfirmReady === true && (e.withMinute || 0) > 0;
  const hhmm = getSeoulHHMM();
  if (hhmm < 900)  return 'pre-market';
  if (hhmm < 930)  return 'pre-open-waiting';
  if (hhmm < 1000) return hasIntraday ? 'prime-confirmed' : 'prime-needs-refresh';
  if (hhmm < 1030) return hasIntraday ? 'late-confirmed' : 'late-needs-refresh';
  if (hhmm < 1530) return 'past-prime';
  return 'after-market';
}
function renderStatusBanner() {
  const host = document.getElementById('status-banner-host');
  if (!host) return;
  const status = computeBoardStatus();
  const e = DATA.entryShelf || {};
  const ms = DATA.marketState || {};
  const nowStr = formatSeoulNow();
  const remStr = fmtRemaining(getRemainingToNext930());
  const cfgMap = {
    'pre-market': {
      label: '현재 위치', cls: 'previous-close',
      title: '장 시작 전 지켜볼 후보',
      desc: '<strong>아직 장초 움직임은 반영되지 않았습니다.</strong> 다음 장초 확인까지 약 <strong>' + remStr + '</strong> 남았습니다. 09:30 이후 다시 확인해야 합니다.',
      action: '내일 09:30 이후 다시 확인하세요.',
      btn: '보드 새로고침',
    },
    'pre-open-waiting': {
      label: '현재 위치', cls: 'waiting',
      title: '장초 확인 대기 중',
      desc: '<strong>장초 움직임을 확인 중입니다.</strong> 아직 첫 고점 재돌파 판단이 끝나지 않았습니다. 약 <strong>' + remStr + '</strong> 후 다시 확인하세요.',
      action: '09:30 이후 다시 확인하세요.',
      btn: '보드 새로고침',
    },
    'prime-confirmed': {
      label: '현재 위치', cls: 'confirmed',
      title: '오늘 장초 재상승 확인 후보 (지금이 최적 시간)',
      desc: '<strong>장초 움직임 반영 완료.</strong> 09:30~10:00 사이 — 장초 단타 확인 최적 구간입니다. 첫 고점 재돌파가 확인된 후보 중 위험 신호가 큰 종목은 제외하고 표시 중.',
      action: '아래 최우선 후보를 확인하세요.',
      btn: '보드 새로고침',
    },
    'prime-needs-refresh': {
      label: '현재 위치', cls: 'needs-refresh',
      title: '장초 확인 필요 (지금이 최적 시간)',
      desc: '<strong>09:30이 지났습니다. 이 화면은 아직 장초 확인 전 리스트입니다.</strong> 지금이 장초 단타 확인 최적 시간 — 장초 분봉 결과를 반영하려면 보드를 새로고침하세요.',
      action: '보드 새로고침 또는 장초 분봉 수집 후 다시 확인.',
      btn: '🔄 보드 새로고침',
    },
    'late-confirmed': {
      label: '현재 위치', cls: 'late',
      title: '장초 재상승 확인 후보 (신선도 약함)',
      desc: '장초 움직임은 반영됐지만 <strong>장초 확인 최적 시간(09:30~10:00)은 지났습니다.</strong> 후보로서의 신선도가 조금 떨어졌으니 신중하게 판단하세요.',
      action: '참고는 가능하지만 신중하게.',
      btn: '보드 새로고침',
    },
    'late-needs-refresh': {
      label: '현재 위치', cls: 'late',
      title: '장초 확인 결과 미반영 (이미 늦음)',
      desc: '<strong>장초 확인 결과가 아직 반영되지 않았습니다. 지금 확인하면 이미 늦을 수 있습니다.</strong> 새로고침은 가능하지만 신선도가 낮습니다.',
      action: '신선도 낮음 — 신중하게 판단.',
      btn: '보드 새로고침',
    },
    'past-prime': {
      label: '현재 위치', cls: 'past',
      title: '장초 확인 시간 지남',
      desc: '<strong>장초 단타 확인 시간(09:30~10:30)은 지났습니다.</strong> 이 보드는 장 시작 전 후보와 09:30 전후 장초 재상승 확인을 위한 보드입니다. 지금은 새 진입 후보보다 <strong>참고용</strong>으로 보세요.',
      action: '이미 장초 확인 시간이 지났습니다. 새 진입 후보로 보기는 늦을 수 있습니다.',
      btn: '참고용 새로고침',
    },
    'after-market': {
      label: '현재 위치', cls: 'after-market',
      title: '장마감 후 (다음 거래일 09:30 대기)',
      desc: '<strong>오늘 장초 확인 시간은 종료되었습니다.</strong> 현재 화면은 오늘 결과 복기 또는 다음 거래일 후보 준비용으로 보세요. 다음 확인은 다음 거래일 09:30 이후 (약 <strong>' + remStr + '</strong> 후) 입니다.',
      action: '다음 거래일 09:30 이후 다시 확인하세요.',
      btn: '보드 새로고침',
    },
  };
  const cfg = cfgMap[status] || cfgMap['pre-market'];
  host.innerHTML = '<div class="status-banner ' + cfg.cls + '">' +
    '<div class="status-body">' +
      '<div class="status-label">' + cfg.label + '</div>' +
      '<div class="status-title">' + cfg.title + '</div>' +
      '<div class="status-desc">' + cfg.desc + '</div>' +
      '<div class="status-action">→ ' + cfg.action + '</div>' +
    '</div>' +
    '<div class="status-action-area">' +
      '<div class="status-clock"><span class="lbl">현재 시간</span><span id="status-clock-text">' + nowStr + '</span></div>' +
      '<button class="reload-btn" onclick="window.location.reload()">' + cfg.btn + '</button>' +
    '</div>' +
  '</div>';
  // H1 제목도 상태에 맞춰 동적 변경
  const h1 = document.getElementById('board-h1');
  if (h1) {
    if (status === 'prime-confirmed' || status === 'late-confirmed') h1.textContent = '🎯 오늘 장초 재상승 확인 후보';
    else if (status === 'past-prime' || status === 'after-market') h1.textContent = '🎯 장초 확인 시간 지남 — 참고용 보드';
    else h1.textContent = '🎯 장 시작 전 지켜볼 후보 (5종목)';
  }
  // top-priority 섹션 설명도 상태에 따라 갱신
  const topDesc = document.getElementById('top-priority-desc');
  if (topDesc) {
    if (status === 'prime-confirmed' || status === 'late-confirmed') {
      topDesc.innerHTML = '<strong>장초 움직임 반영 완료.</strong> 첫 고점 재돌파가 확인된 후보만 표시 중. 위험 신호가 큰 종목은 자동 제외됨.';
    } else if (status === 'prime-needs-refresh' || status === 'late-needs-refresh') {
      topDesc.innerHTML = '<strong>⚠ 09:30이 지났습니다. 이 화면은 아직 장초 확인 전 리스트입니다.</strong> 보드를 새로고침하면 장초 분봉 확인 결과가 반영됩니다.';
    } else if (status === 'past-prime' || status === 'after-market') {
      topDesc.innerHTML = '<strong>장초 단타 확인 시간이 지났습니다.</strong> 새 진입 후보로 보기는 늦을 수 있으며, 현재 화면은 참고용 또는 다음 거래일 준비용입니다.';
    } else {
      topDesc.innerHTML = '아래 5종목은 <strong>내일 장 시작 전에 먼저 지켜볼 후보</strong>입니다. 09:30 이후 장초 움직임이 반영되면 실제 재상승 확인 후보로 다시 좁혀집니다.';
    }
  }
  // 카드별 작은 안내 문구도 일괄 업데이트
  document.querySelectorAll('.card-watch-note').forEach((el) => {
    if (status === 'prime-confirmed' || status === 'late-confirmed') {
      el.style.display = 'none';
    } else if (status === 'past-prime' || status === 'after-market') {
      el.style.display = '';
      el.textContent = '장초 확인 시간이 지났습니다 · 새 진입보다는 참고용';
    } else if (status === 'prime-needs-refresh' || status === 'late-needs-refresh') {
      el.style.display = '';
      el.textContent = '⚠ 장초 확인 전 · 09:30 경과, 새로고침 필요';
    } else {
      el.style.display = '';
      el.textContent = '장 시작 전 지켜볼 후보 · 09:30 이후 다시 확인';
    }
  });
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
  host.innerHTML = '<div class="market-banner ' + cls + '">' +
    '<strong>📈 시장 상태:</strong> ' + (ms.label || '시장 상태 미확인') + indices +
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

  if (tp.status === 'WAIT_PULLBACK') {
    return '<div class="trade-plan-box wait">' +
      '<div class="tp-header"><span class="tp-badge">자동 계산</span>눌림 대기<span class="tp-strategy">' + stratLabel + '</span>' + sourceTag + '</div>' +
      '<div class="tp-row"><span class="tp-key">기준가</span><span class="tp-val base">' + fmtN(tp.baseEntryPrice) + '</span></div>' +
      '<div class="tp-row sub"><span class="tp-key">· 기준가 출처</span><span class="tp-val base">' + baseLabel + '</span></div>' +
      '<div class="tp-row"><span class="tp-key">참고 매수가</span><span class="tp-pause">눌림 대기</span></div>' +
      (tp.reason ? '<div class="tp-reason">' + tp.reason + '</div>' : '') +
      (tp.riskNote ? '<div class="tp-risknote">' + tp.riskNote + '</div>' : '') +
      disclaimer +
    '</div>';
  }
  if (tp.status === 'ENTRY_INVALIDATED') {
    return '<div class="trade-plan-box invalid">' +
      '<div class="tp-header"><span class="tp-badge">자동 계산</span>자동 진입 보류<span class="tp-strategy">' + stratLabel + '</span>' + sourceTag + '</div>' +
      '<div class="tp-row"><span class="tp-key">기준가</span><span class="tp-val base">' + fmtN(tp.baseEntryPrice) + '</span></div>' +
      '<div class="tp-row sub"><span class="tp-key">· 기준가 출처</span><span class="tp-val base">' + baseLabel + '</span></div>' +
      '<div class="tp-row"><span class="tp-key">참고 매수가</span><span class="tp-pause">자동 진입 보류</span></div>' +
      (tp.reason ? '<div class="tp-reason">' + tp.reason + '</div>' : '') +
      (tp.riskNote ? '<div class="tp-risknote">' + tp.riskNote + '</div>' : '') +
      disclaimer +
    '</div>';
  }
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
  if (it.entryStatus === 'OK' && it.intraday) {
    const im = it.intraday;
    const mh = im.rebreakMorningHigh_10_30;
    const ph = im.rebreakPrevHighBy0930;
    const mhTxt = mh ? '<span class="cell-pos">✓ 09:10~30 첫 10분 고점 재돌파</span>' : '<span class="muted">· 첫 10분 고점 미돌파</span>';
    const phTxt = ph ? '<span class="cell-warn">⚠ 전일 고점 돌파(spike 위험)</span>' : '<span class="muted">· 전일 고점 미돌파</span>';
    const gapPctTxt = im.gapRate != null ? fmtPct(im.gapRate, 2) : '-';
    intradayLine = '<div class="gap-note" style="border-left-color:#14b8a6;color:#cbd5e1;">🚪 장초 분봉 확인 (' + (DATA.entryShelf && DATA.entryShelf.entryConfirmDate || '-') + '): 시초가 갭 ' + gapPctTxt + ' · ' + mhTxt + ' · ' + phTxt + '</div>';
  }

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
    '<h3>' + (it.name || '-') + ' <span class="code">' + it.code + '</span> <span class="market">' + (it.market || '-') + '</span> ' + entryStatusPill(it) + '</h3>' +
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

// ── ① 최우선 5종목 (메인 펼침) ──
// 섹션 설명은 status banner 렌더 시점에 다시 update됨 (장초 확인 전/후 다른 문구).
(function renderTopPriority() {
  const host = document.getElementById('top-priority-host');
  if (!host) return;
  const items = itemsByCodes(DATA.priorityRanked && DATA.priorityRanked.topPriority);
  if (items.length === 0) {
    host.innerHTML = '<section class="entry-shelf-section top"><h2>🎯 장 시작 전 지켜볼 후보 (5종목)</h2>' +
      '<div class="empty-list">조건을 만족하는 후보가 없습니다.</div></section>';
    return;
  }
  host.innerHTML = '<section class="entry-shelf-section top">' +
    '<h2 id="top-priority-h2">🎯 장 시작 전 지켜볼 후보 (' + items.length + '종목)</h2>' +
    '<div class="shelf-desc" id="top-priority-desc">아래 ' + items.length + '종목은 <strong>장 시작 전에 먼저 지켜볼 후보</strong>입니다. 09:30 이후 장초 움직임이 반영되면 실제 재상승 확인 후보로 다시 좁혀집니다.</div>' +
    items.map(buildCardHtml).join('') +
  '</section>';
})();

// ── ② 추가 확인 후보 (접힘, 6~15위, 최대 10) ──
(function renderExtraPriority() {
  const host = document.getElementById('extra-priority-host');
  if (!host) return;
  const items = itemsByCodes(DATA.priorityRanked && DATA.priorityRanked.extraPriority);
  if (items.length === 0) return;
  const overflow = (DATA.priorityRanked && DATA.priorityRanked.overflowHiddenCount) || 0;
  host.innerHTML = '<section class="entry-shelf-section" style="border:1px solid #475569;background:#0f172a;">' +
    '<details><summary style="cursor:pointer;font-size:15px;font-weight:700;color:#cbd5e1;padding:6px 0;">' +
      '📋 추가 확인 후보 (' + items.length + '건' + (overflow > 0 ? ', overflow ' + overflow + '건 숨김' : '') + ') — 펼쳐서 보기</summary>' +
    '<div style="margin-top:10px;">' +
    '<div class="shelf-desc">조건은 맞지만 최우선 5종목에는 들지 못한 후보입니다. displayPriorityScore 6~' + (5 + items.length) + '위.</div>' +
      items.map(buildCardHtml).join('') +
    '</div></details>' +
  '</section>';
})();

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
  '<strong>이 보드의 후보 선정 기준</strong><br>' +
  '• <strong>수급 균형 후보</strong> — 시총 3,000억~7,000억 + 시총 대비 거래대금 5% 이상 + 낮은 갭에서 장중 끌어올림 또는 거래대금 시장 상위 30위<br>' +
  '• <strong>가볍게 움직일 후보</strong> — 시총 1,000억~3,000억 + 시총 대비 거래대금 5% 이상 + 최근 급등이 1회 이하<br>' +
  '• <strong>중형 수급 후보</strong> — 시총 7,000억~1.5조 + 시총 대비 거래대금 5% 이상 + 낮은 갭 한정<br>' +
  '<br><strong>운영 화면에서 자동 제외하는 후보</strong><br>' +
  '• ETF / ETN / 리츠 / 스팩 / 우선주 / 관리종목 / 시가총액 500억 미만·5조 이상<br>' +
  '• 위험형(상한가형) · 갭상승 후 종가 유지형 · 전일 고점 돌파 spike · 이미 초반 고점 통과 · 윗꼬리·과열 trap 위험<br>' +
  '<br><strong>장초 분봉 확인이 반영되면</strong><br>' +
  '• 첫 10분 고점을 다시 넘긴 후보가 우선 노출됩니다 (장초 재상승 ✓ / 균형 재상승 ✓ / 깨끗한 재상승 ✓ / 가벼운 재상승 ✓ 칩).<br>' +
  '• 09:10 시점에 이미 고점이 지난 후보는 추격 위험으로 제외됩니다.<br>' +
  '<br><strong>참고/주의</strong><br>' +
  '• <strong>매수 확정 신호가 아닙니다.</strong> 내일 장초에 먼저 볼 후보를 좁혀주는 보드입니다.<br>' +
  '<br><div style="margin-top:10px;font-size:11px;color:#64748b;">' +
  '연구/복기 보고서: ' +
  '<a href="/one-day-surge-validation" style="color:#7dd3fc;">날짜별 복기 보고서 보기</a> · ' +
  '<a href="/one-day-surge-entry-confirm" style="color:#7dd3fc;">장초 조건 연구 보기</a> · ' +
  '<a href="/one-day-surge-entry-daily-backtest" style="color:#7dd3fc;">날짜별 운영 검증 보기</a>' +
  '</div>';
</script>

</body>
</html>
`;

main();
