#!/usr/bin/env node
/**
 * 1-Day Surge ENTRY_CONFIRM 연구 보고서
 *
 * 목적:
 *   D일 장마감 기준 1DS 후보가 D+1일 장초 분봉에서 실제 진입 확인 조건(ENTRY_V1~V5)을
 *   만족했는지, 그리고 진입(09:10 close 가정) 후 +3%/+5%/+7% 수익 기회와 -3%/-5% 위험이
 *   ENTRY 조건 통과/미통과로 어떻게 갈리는지 검증한다.
 *
 * 분리 원칙:
 *   - 기존 /one-day-surge-validation (일봉 GOOD_TRADE 연구) 와 별개의 보고서.
 *   - 후보 산출은 one-day-surge-core.js 그대로 재사용 — 시간 축만 historical로 walk.
 *   - 외부 HTTP 호출 X — 미리 저장된 분봉 JSON만 read.
 *   - D일 후보 산출에는 D일까지의 데이터만 사용 (look-ahead 없음).
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json (일봉, ~3년)
 *   - cache/naver-stocks-list.json (시총/ETF/특수)
 *   - data/intraday/1ds/YYYY-MM-DD/{code}.json (D+1 장초 분봉, 별도 수집 스크립트가 채움)
 *
 * 출력:
 *   - reports/one-day-surge-entry-confirm-result.json
 *   - reports/one-day-surge-entry-confirm-result.html
 *
 * 라우트: GET /one-day-surge-entry-confirm
 *
 * 환경변수:
 *   - ENTRY_VALIDATION_DAYS (기본 40): 분석 윈도우 거래일 수
 *   - ENTRY_GROUPS (기본 BALANCED-GT,LIGHT-GT,MID-CAP-GT,MOM-RISK)
 */

const fs = require('fs');
const path = require('path');
const core = require('./one-day-surge-core');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');
const STOCKS_PATH = path.join(ROOT, 'stocks.json');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-entry-confirm-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-entry-confirm-result.html');

const VALIDATION_DAYS = Number(process.env.ENTRY_VALIDATION_DAYS || 40);
const GROUPS_FILTER = (process.env.ENTRY_GROUPS || 'BALANCED-GT,LIGHT-GT,MID-CAP-GT,MOM-RISK')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ── 유틸 ──
function isNum(v) { return v != null && Number.isFinite(v); }
function safeRate(num, denom) { return denom > 0 ? (num / denom * 100) : null; }
function safeMean(arr) {
  const xs = arr.filter(isNum);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}
function dateNumToStr(yyyymmdd) {
  return yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8);
}

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
          ...cur, name: s.name || cur.name, market: s.market || cur.market,
          marketCap: s.marketValue || 0, isEtf: !!s.isEtf, isSpecial: !!s.isSpecial,
        });
      }
    } catch (_) {}
  }
  return map;
}

// ── 분봉 로드 ──
function loadMinuteBars(dateStr, code) {
  const fp = path.join(INTRADAY_BASE, dateStr, `${code}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch (_) { return null; }
}

// ── 분봉 → 장초 지표 ──
function computeIntradayMetrics(eventBase, minuteData) {
  const bars = (minuteData && minuteData.bars) || [];
  if (!bars.length) return null;

  // 시각 비교는 문자열 그대로 (HH:MM 형식이므로 lex 비교 OK)
  const bars0_10  = bars.filter((b) => b.time <= '09:10');
  const bars10_30 = bars.filter((b) => b.time > '09:10' && b.time <= '09:30');
  const bars0_30  = bars.filter((b) => b.time <= '09:30');
  const bars0_60  = bars.filter((b) => b.time <= '10:00');
  if (bars0_10.length === 0) return null;

  // 첫 유효 bar의 open을 장초 시초가로 간주
  const firstBar = bars0_10.find((b) => b.open > 0) || bars0_10[0];
  const nextOpen = firstBar.open;
  if (!isNum(nextOpen) || nextOpen <= 0) return null;

  const baseClose = eventBase.close;
  const gapRate = baseClose > 0 ? (nextOpen / baseClose - 1) * 100 : null;

  const max0_10 = Math.max(...bars0_10.map((b) => b.high || 0));
  const min0_10 = Math.min(...bars0_10.map((b) => b.low || Infinity));
  const close0910 = bars0_10[bars0_10.length - 1].close;
  const value_0_10  = bars0_10.reduce((s, b) => s + (b.value  || 0), 0);
  const volume_0_10 = bars0_10.reduce((s, b) => s + (b.volume || 0), 0);

  const highFromOpen_0_10 = (max0_10  / nextOpen - 1) * 100;
  const lowFromOpen_0_10  = (min0_10  / nextOpen - 1) * 100;
  const closeFromOpen_0910 = (close0910 / nextOpen - 1) * 100;

  // VWAP 계산 — typical price * volume
  function vwap(bs) {
    let num = 0, den = 0;
    for (const b of bs) {
      const tp = ((b.high || 0) + (b.low || 0) + (b.close || 0)) / 3;
      const vol = b.volume || 0;
      num += tp * vol; den += vol;
    }
    return den > 0 ? num / den : null;
  }
  const vwap_0_10 = vwap(bars0_10);
  const vwap_0_30 = vwap(bars0_30);

  const isAboveOpenAt0910 = close0910 > nextOpen;
  const isAboveVwapAt0910 = vwap_0_10 != null && close0910 >= vwap_0_10;
  const isLowDropLessThan3At0910 = lowFromOpen_0_10 > -3;

  // 09:10~09:30
  const max10_30 = bars10_30.length ? Math.max(...bars10_30.map((b) => b.high || 0)) : null;
  const min10_30 = bars10_30.length ? Math.min(...bars10_30.map((b) => b.low || Infinity)) : null;
  const close0930 = bars10_30.length ? bars10_30[bars10_30.length - 1].close : close0910;
  const highFrom0910_10_30 = max10_30 != null && close0910 > 0 ? (max10_30 / close0910 - 1) * 100 : null;
  const lowFrom0910_10_30  = min10_30 != null && close0910 > 0 ? (min10_30 / close0910 - 1) * 100 : null;
  const rebreakMorningHigh_10_30 = max10_30 != null && max10_30 > max0_10;
  const prevHigh = eventBase.high; // D-day high
  const rebreakPrevHighBy0930 = max10_30 != null ? max10_30 > prevHigh : (max0_10 > prevHigh);
  const isAboveVwapAt0930 = vwap_0_30 != null && close0930 >= vwap_0_30;

  // 09:00~10:00
  const max0_60 = bars0_60.length ? Math.max(...bars0_60.map((b) => b.high || 0)) : max0_10;
  const min0_60 = bars0_60.length ? Math.min(...bars0_60.map((b) => b.low || Infinity)) : min0_10;
  const highFromOpen_0_60 = (max0_60 / nextOpen - 1) * 100;
  const lowFromOpen_0_60  = (min0_60 / nextOpen - 1) * 100;
  const rebreakPrevHighBy1000 = max0_60 > prevHigh;

  // 거래대금 비율 (D-day 일봉 valueApprox 기준)
  const prevValue   = eventBase.valueAmount || 0;
  const avg20Value  = eventBase.avg20Value || 0;
  const value_0_10_to_prevValue = prevValue > 0 ? value_0_10 / prevValue : null;
  const value_0_10_to_avg20Value = avg20Value > 0 ? value_0_10 / avg20Value : null;

  return {
    nextOpen, gapRate,
    bars_0_10_count: bars0_10.length, bars_total: bars.length,
    highFromOpen_0_10, lowFromOpen_0_10, closeFromOpen_0910,
    value_0_10, volume_0_10, vwap_0_10,
    value_0_10_to_prevValue, value_0_10_to_avg20Value,
    isAboveOpenAt0910, isAboveVwapAt0910, isLowDropLessThan3At0910,
    highFrom0910_10_30, lowFrom0910_10_30,
    rebreakMorningHigh_10_30, rebreakPrevHighBy0930, isAboveVwapAt0930, vwap_0_30,
    highFromOpen_0_60, lowFromOpen_0_60, rebreakPrevHighBy1000,
    maxGainBefore1000: highFromOpen_0_60, maxDropBefore1000: lowFromOpen_0_60,
    entryPrice: close0910,
    preEntryMaxHigh: max0_10, // 09:00~09:10 max — used to detect peak-before-entry bias
  };
}

// ── ENTRY 조건 적용 ──
function applyEntryConditions(im) {
  const v_to_prev = isNum(im.value_0_10_to_prevValue) ? im.value_0_10_to_prevValue : 0;
  const versions = {};
  versions.entryV1 = isNum(im.gapRate) && im.gapRate < 7
    && isNum(im.lowFromOpen_0_10) && im.lowFromOpen_0_10 > -3
    && isNum(im.closeFromOpen_0910) && im.closeFromOpen_0910 >= 0
    && v_to_prev >= 0.05;
  versions.entryV2 = versions.entryV1 && im.isAboveVwapAt0910 === true;
  versions.entryV3 = isNum(im.gapRate) && im.gapRate < 7
    && isNum(im.lowFromOpen_0_10) && im.lowFromOpen_0_10 > -4
    && im.rebreakMorningHigh_10_30 === true
    && v_to_prev >= 0.05;
  versions.entryV4 = isNum(im.gapRate) && im.gapRate < 7
    && im.rebreakPrevHighBy0930 === true
    && im.isAboveVwapAt0910 === true;
  versions.entryV5 = isNum(im.gapRate) && im.gapRate < 7
    && isNum(im.lowFromOpen_0_10) && im.lowFromOpen_0_10 > -3
    && isNum(im.closeFromOpen_0910) && im.closeFromOpen_0910 >= 0
    && im.rebreakMorningHigh_10_30 === true;
  return versions;
}

// ── ENTRY 후 성과 (entry = 09:10 close, 이후는 D+1 일봉 high/low/close 사용) ──
// 주의: D+1 일봉 high가 09:00~09:10 안에서 발생했다면 afterEntryHighRate는 과대 추정될 수 있음.
//       peakBeforeEntry 플래그로 노출.
function computeOutcomes(im, nextDayRow) {
  if (!nextDayRow || !isNum(nextDayRow.high) || !isNum(nextDayRow.low) || !isNum(nextDayRow.close)) return null;
  const ep = im.entryPrice;
  if (!isNum(ep) || ep <= 0) return null;
  const afterEntryHighRate  = (nextDayRow.high  / ep - 1) * 100;
  const afterEntryLowRate   = (nextDayRow.low   / ep - 1) * 100;
  const afterEntryCloseRate = (nextDayRow.close / ep - 1) * 100;
  const peakBeforeEntry = isNum(im.preEntryMaxHigh) && im.preEntryMaxHigh >= nextDayRow.high; // 일봉 high가 사전 시간대에 있었음
  return {
    afterEntryHighRate, afterEntryLowRate, afterEntryCloseRate,
    peakBeforeEntry,
    hit3: afterEntryHighRate >= 3,
    hit5: afterEntryHighRate >= 5,
    hit7: afterEntryHighRate >= 7,
    fail3: afterEntryLowRate <= -3,
    fail5: afterEntryLowRate <= -5,
    closePositive: afterEntryCloseRate > 0,
  };
}

// ── 버킷 요약 ──
function summarizeBucket(events) {
  const n = events.length;
  if (n === 0) {
    return {
      count: 0,
      hit3: 0, hit5: 0, hit7: 0, fail3: 0, fail5: 0, closePositive: 0,
      hit3Rate: null, hit5Rate: null, hit7Rate: null, fail3Rate: null, fail5Rate: null, closePositiveRate: null,
      avgAfterHigh: null, avgAfterLow: null, avgAfterClose: null,
    };
  }
  let h3=0, h5=0, h7=0, f3=0, f5=0, cp=0;
  let sumHigh=0, sumLow=0, sumClose=0;
  for (const e of events) {
    if (e.outcome) {
      if (e.outcome.hit3) h3++;
      if (e.outcome.hit5) h5++;
      if (e.outcome.hit7) h7++;
      if (e.outcome.fail3) f3++;
      if (e.outcome.fail5) f5++;
      if (e.outcome.closePositive) cp++;
      if (isNum(e.outcome.afterEntryHighRate))  sumHigh  += e.outcome.afterEntryHighRate;
      if (isNum(e.outcome.afterEntryLowRate))   sumLow   += e.outcome.afterEntryLowRate;
      if (isNum(e.outcome.afterEntryCloseRate)) sumClose += e.outcome.afterEntryCloseRate;
    }
  }
  return {
    count: n,
    hit3: h3, hit5: h5, hit7: h7, fail3: f3, fail5: f5, closePositive: cp,
    hit3Rate: safeRate(h3, n), hit5Rate: safeRate(h5, n), hit7Rate: safeRate(h7, n),
    fail3Rate: safeRate(f3, n), fail5Rate: safeRate(f5, n), closePositiveRate: safeRate(cp, n),
    avgAfterHigh: sumHigh / n, avgAfterLow: sumLow / n, avgAfterClose: sumClose / n,
  };
}

// ── 공용: D일별 GT 후보 이벤트 생성 (collect script와 공유) ──
// 주어진 윈도우 일수만큼 historical baseIdx를 walk하면서 각 일자의 GT 후보를 분류한다.
// returns { allEvents, eventsByDate, stocksProcessed, stocksFiltered }
function generateGtEventsByDate({ windowDays, groupsFilter, metaMap, files }) {
  const eventsByDate = new Map();
  let stocksProcessed = 0, stocksFiltered = 0;

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

    const lastUsableIdx = rows.length - 2; // D+1 outcome 있어야 함
    const startIdx = Math.max(20, lastUsableIdx - windowDays + 1);
    for (let bi = startIdx; bi <= lastUsableIdx; bi++) {
      const m = core.analyzeAt(rows, bi);
      if (!m) continue;
      const s = core.scoreMetrics(m, meta.marketCap);
      const baseGroup = core.classifyGroup(m, s);
      if (!baseGroup) continue;
      const ev = {
        code, name: chart.name || meta.name || code,
        market: chart.market || meta.market || '',
        marketCap: meta.marketCap,
        ...m, ...s,
        nextDayRow: rows[bi + 1] || null,
        recent5Up15Count: core.countRecentSurges(rows, bi, 5, 15),
        candleType: core.classifyCandleType(m),
      };
      if (!eventsByDate.has(m.baseDate)) eventsByDate.set(m.baseDate, []);
      eventsByDate.get(m.baseDate).push(ev);
    }
    stocksProcessed++;
  }

  // 2차: 일자별 dailyValueRank + classifyGtGroup
  const allEvents = [];
  for (const [d, list] of eventsByDate) {
    list.sort((a, b) => (b.valueAmount || 0) - (a.valueAmount || 0));
    list.forEach((e, idx) => { e.dailyValueRank = idx + 1; });
    for (const ev of list) {
      ev.valueToMarketCapRatio = ev.marketCap > 0 ? ev.valueAmount / ev.marketCap * 100 : null;
      ev.gtGroup = core.classifyGtGroup({
        m: ev,
        marketCap: ev.marketCap,
        valueToMarketCapRatio: ev.valueToMarketCapRatio,
        candleType: ev.candleType,
        dailyValueRank: ev.dailyValueRank,
        recent5Up15Count: ev.recent5Up15Count,
      });
      if (ev.gtGroup === 'UNCLASSIFIED') continue;
      if (!groupsFilter.includes(ev.gtGroup)) continue;
      allEvents.push(ev);
    }
  }
  return { allEvents, eventsByDate, stocksProcessed, stocksFiltered };
}

// ── 메인 ──
function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(CHART_DIR)) {
    console.error('[ERROR] cache/stock-charts-long 디렉토리가 없습니다.');
    process.exit(1);
  }

  const t0 = Date.now();
  console.log(`\n📡 1DS ENTRY_CONFIRM 연구 보고서 (windowDays=${VALIDATION_DAYS}, groups=${GROUPS_FILTER.join(',')})`);
  const metaMap = loadStockMetaMap();
  const files = fs.readdirSync(CHART_DIR).filter((f) => f.endsWith('.json'));
  console.log(`  메타: ${metaMap.size}건 / 차트 파일: ${files.length}건`);

  const { allEvents, eventsByDate, stocksProcessed, stocksFiltered } =
    generateGtEventsByDate({ windowDays: VALIDATION_DAYS, groupsFilter: GROUPS_FILTER, metaMap, files });
  console.log(`  처리 종목: ${stocksProcessed} / 필터 제외: ${stocksFiltered} / GT 그룹 후보 이벤트: ${allEvents.length}건 (${eventsByDate.size}일)`);

  // 3차: 분봉 lookup + 지표 계산 + ENTRY 조건 + outcome
  let withMinute = 0, missingMinute = 0;
  for (const ev of allEvents) {
    if (!ev.nextDayRow || !ev.nextDayRow.date) { ev.minuteAvailable = false; missingMinute++; continue; }
    const nextDateStr = dateNumToStr(ev.nextDayRow.date);
    const minuteData = loadMinuteBars(nextDateStr, ev.code);
    if (!minuteData) { ev.minuteAvailable = false; missingMinute++; continue; }
    ev.minuteAvailable = true;
    ev.nextDateStr = nextDateStr;
    const im = computeIntradayMetrics(ev, minuteData);
    if (!im) { ev.intradayInvalid = true; continue; }
    ev.intraday = im;
    ev.entry = applyEntryConditions(im);
    ev.outcome = computeOutcomes(im, ev.nextDayRow);
    withMinute++;
  }
  console.log(`  분봉 확보: ${withMinute}건 / 분봉 누락: ${missingMinute}건`);

  // ── 집계 ──
  const eventsWithMinute = allEvents.filter((e) => e.minuteAvailable && e.outcome);
  const baseSum = summarizeBucket(eventsWithMinute);
  const ENTRY_VERSIONS = ['entryV1', 'entryV2', 'entryV3', 'entryV4', 'entryV5'];

  // 1) ENTRY 조건별 성과
  const byEntry = {};
  for (const v of ENTRY_VERSIONS) {
    const passed = eventsWithMinute.filter((e) => e.entry && e.entry[v]);
    byEntry[v] = { ...summarizeBucket(passed), n: passed.length };
  }
  // ENTRY 통과 not-applied 비교
  const noEntryFilter = baseSum;

  // 2) 그룹별 ENTRY 성과 (각 그룹 × 각 ENTRY 통과)
  const byGroup = {};
  for (const g of GROUPS_FILTER) {
    const subset = eventsWithMinute.filter((e) => e.gtGroup === g);
    const groupRow = {
      group: g, all: summarizeBucket(subset),
      byEntry: {},
    };
    for (const v of ENTRY_VERSIONS) {
      groupRow.byEntry[v] = summarizeBucket(subset.filter((e) => e.entry && e.entry[v]));
    }
    // GAP_HOLD/상한가 추가 분류
    groupRow.byCandleType = {};
    for (const ct of ['GAP_HOLD', 'LOW_GAP_INTRADAY', 'BIG_GREEN', 'UPPER_WICK_GREEN', 'RED_CLOSE', 'OTHER']) {
      groupRow.byCandleType[ct] = summarizeBucket(subset.filter((e) => e.candleType === ct));
    }
    byGroup[g] = groupRow;
  }

  // 3) 09:10 조건별
  const by0910Cond = {
    aboveOpen:    summarizeBucket(eventsWithMinute.filter((e) => e.intraday?.isAboveOpenAt0910)),
    aboveVwap:    summarizeBucket(eventsWithMinute.filter((e) => e.intraday?.isAboveVwapAt0910)),
    lowAbove_3:   summarizeBucket(eventsWithMinute.filter((e) => e.intraday?.isLowDropLessThan3At0910)),
    valGte5pct:   summarizeBucket(eventsWithMinute.filter((e) => isNum(e.intraday?.value_0_10_to_prevValue) && e.intraday.value_0_10_to_prevValue >= 0.05)),
    allFour:      summarizeBucket(eventsWithMinute.filter((e) => {
      const im = e.intraday; if (!im) return false;
      return im.isAboveOpenAt0910 && im.isAboveVwapAt0910 && im.isLowDropLessThan3At0910
        && isNum(im.value_0_10_to_prevValue) && im.value_0_10_to_prevValue >= 0.05;
    })),
  };

  // 4) 재돌파 조건별
  const byRebreak = {
    prevHigh0930:  summarizeBucket(eventsWithMinute.filter((e) => e.intraday?.rebreakPrevHighBy0930)),
    morningHigh:   summarizeBucket(eventsWithMinute.filter((e) => e.intraday?.rebreakMorningHigh_10_30)),
    both:          summarizeBucket(eventsWithMinute.filter((e) => e.intraday?.rebreakPrevHighBy0930 && e.intraday?.rebreakMorningHigh_10_30)),
    neither:       summarizeBucket(eventsWithMinute.filter((e) => e.intraday && !e.intraday.rebreakPrevHighBy0930 && !e.intraday.rebreakMorningHigh_10_30)),
  };

  // 5) 위험 후보 개선 (MOM-RISK + GAP_HOLD candleType)
  const riskGroupCodes = ['MOM-RISK'];
  const riskEvents = eventsWithMinute.filter((e) => riskGroupCodes.includes(e.gtGroup) || e.candleType === 'GAP_HOLD');
  const riskWithEntry = {};
  for (const v of ENTRY_VERSIONS) {
    riskWithEntry[v] = summarizeBucket(riskEvents.filter((e) => e.entry && e.entry[v]));
  }
  const riskAll = summarizeBucket(riskEvents);

  // 6) ENTRY 통과 종목 리스트 (V1 통과만, 상위 100건 by afterEntryHighRate)
  const passedV1 = eventsWithMinute
    .filter((e) => e.entry && e.entry.entryV1)
    .sort((a, b) => (b.outcome?.afterEntryHighRate || 0) - (a.outcome?.afterEntryHighRate || 0))
    .slice(0, 100);

  // ── 자동 결론 ──
  const autoConclusion = buildAutoConclusion({ baseSum, byEntry, by0910Cond, byRebreak, byGroup, riskAll, riskWithEntry });

  // 분석 윈도우
  const allDates = [...eventsByDate.keys()].sort();
  const windowFrom = allDates[0] || null;
  const windowTo   = allDates[allDates.length - 1] || null;

  const out = {
    meta: {
      title: '1-Day Surge ENTRY_CONFIRM 연구 보고서',
      subtitle: 'D+1 장초 분봉으로 진입 확인 조건이 GOOD_TRADE 대비 실전 성과를 개선하는지 검증',
      generatedAt: new Date().toISOString(),
      windowDays: VALIDATION_DAYS,
      windowFrom, windowFromFmt: windowFrom ? fmtDate(windowFrom) : null,
      windowTo,   windowToFmt:   windowTo   ? fmtDate(windowTo)   : null,
      groupsFilter: GROUPS_FILTER,
      stocksProcessed, stocksFiltered,
      candidateEvents: allEvents.length,
      withMinuteData: withMinute,
      missingMinuteData: missingMinute,
      minuteCoverage: allEvents.length ? withMinute / allEvents.length * 100 : 0,
      elapsedMs: Date.now() - t0,
      assumption: {
        entryPrice: '09:10 close (ENTRY_AT_0910 only — REBREAK 가격은 미구현)',
        afterEntryRange: 'D+1 일봉 high/low/close 사용. 일봉 high가 09:00~09:10 안에서 발생한 경우 afterEntryHighRate 과대 추정 가능 (peakBeforeEntry 플래그로 노출).',
      },
    },
    summary: {
      noEntryFilter: baseSum,
      byEntry,
    },
    byGroup,
    by0910Cond,
    byRebreak,
    riskCheck: { allRisk: riskAll, byEntry: riskWithEntry },
    passedV1Top: passedV1.map((e) => ({
      code: e.code, name: e.name,
      baseDate: e.baseDate, nextDate: e.nextDateStr,
      gtGroup: e.gtGroup, candleType: e.candleType,
      gapRate: e.intraday.gapRate,
      lowFromOpen_0_10: e.intraday.lowFromOpen_0_10,
      closeFromOpen_0910: e.intraday.closeFromOpen_0910,
      value_0_10_to_prevValue: e.intraday.value_0_10_to_prevValue,
      rebreakMorningHigh_10_30: e.intraday.rebreakMorningHigh_10_30,
      rebreakPrevHighBy0930: e.intraday.rebreakPrevHighBy0930,
      afterEntryHighRate: e.outcome.afterEntryHighRate,
      afterEntryLowRate: e.outcome.afterEntryLowRate,
      afterEntryCloseRate: e.outcome.afterEntryCloseRate,
      peakBeforeEntry: e.outcome.peakBeforeEntry,
    })),
    autoConclusion,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out)), 'utf-8');

  console.log(`\n  분봉 확보: ${withMinute} / 누락: ${missingMinute} (커버리지 ${out.meta.minuteCoverage.toFixed(1)}%)`);
  console.log(`  ENTRY 통과 수: V1=${byEntry.entryV1.n} V2=${byEntry.entryV2.n} V3=${byEntry.entryV3.n} V4=${byEntry.entryV4.n} V5=${byEntry.entryV5.n}`);
  console.log(`  total elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

function buildAutoConclusion({ baseSum, byEntry, by0910Cond, byRebreak, byGroup, riskAll, riskWithEntry }) {
  const c = {};
  // 1) ENTRY가 GOOD_TRADE 대비 개선?
  if (baseSum.count >= 30 && byEntry.entryV1 && byEntry.entryV1.count >= 30) {
    const liftHit5 = (byEntry.entryV1.hit5Rate || 0) - (baseSum.hit5Rate || 0);
    const liftFail5 = (byEntry.entryV1.fail5Rate || 0) - (baseSum.fail5Rate || 0);
    c.entryImprovement = `ENTRY_V1 통과 후 hit5률 ${liftHit5 > 0 ? '+' : ''}${liftHit5.toFixed(1)}pp / fail5률 ${liftFail5 > 0 ? '+' : ''}${liftFail5.toFixed(1)}pp (n=${byEntry.entryV1.count} vs base ${baseSum.count})`;
  }
  // 2) ENTRY 버전 best
  const entryRanked = Object.entries(byEntry)
    .filter(([_, v]) => v.count >= 20 && isNum(v.hit5Rate))
    .map(([k, v]) => ({ ver: k, n: v.count, hit5: v.hit5Rate, fail5: v.fail5Rate, score: (v.hit5Rate || 0) - (v.fail5Rate || 0) * 0.7 }))
    .sort((a, b) => b.score - a.score);
  c.bestEntryVersion = entryRanked[0] || null;
  c.allEntryVersions = entryRanked;
  // 3) 09:10 조건이 fail5 줄였는가
  if (baseSum.count >= 30 && by0910Cond.allFour.count >= 20) {
    c.openConditionEffect = `09:10 4조건 모두 통과 후 fail5률 ${(by0910Cond.allFour.fail5Rate || 0).toFixed(1)}% (base ${(baseSum.fail5Rate || 0).toFixed(1)}%)`;
  }
  // 4) 재돌파가 hit5 올렸는가
  if (byRebreak.both.count >= 20 && baseSum.count >= 30) {
    c.rebreakEffect = `재돌파 둘 다 통과 hit5률 ${(byRebreak.both.hit5Rate || 0).toFixed(1)}% (base ${(baseSum.hit5Rate || 0).toFixed(1)}%, n=${byRebreak.both.count})`;
  }
  // 5) 그룹별 베스트
  const groupRanked = Object.values(byGroup)
    .filter((g) => g.all.count >= 20)
    .map((g) => ({
      group: g.group, n: g.all.count,
      baseHit5: g.all.hit5Rate, v1Hit5: g.byEntry.entryV1?.hit5Rate, v1n: g.byEntry.entryV1?.count,
      improvement: (g.byEntry.entryV1?.hit5Rate || 0) - (g.all.hit5Rate || 0),
    }))
    .sort((a, b) => b.improvement - a.improvement);
  c.groupEntryImprovement = groupRanked;
  // 6) 위험 후보 살릴 수 있는가
  if (riskAll.count >= 20 && riskWithEntry.entryV1 && riskWithEntry.entryV1.count >= 10) {
    c.riskGroupRescue = `MOM-RISK/GAP_HOLD 전체 hit5률 ${(riskAll.hit5Rate || 0).toFixed(1)}% (n=${riskAll.count}) → ENTRY_V1 통과 후 hit5률 ${(riskWithEntry.entryV1.hit5Rate || 0).toFixed(1)}% (n=${riskWithEntry.entryV1.count})`;
  }
  // 7) 권고
  c.recommendations = [];
  if (entryRanked[0]) {
    c.recommendations.push(`최우선 ENTRY 조건: ${entryRanked[0].ver} (hit5 ${entryRanked[0].hit5.toFixed(1)}% / fail5 ${entryRanked[0].fail5.toFixed(1)}%, n=${entryRanked[0].n})`);
  }
  return c;
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>1-Day Surge ENTRY_CONFIRM 연구</title>
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
.warn-box { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.summary-cell { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.summary-cell .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.summary-cell .value { font-size: 18px; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; margin-top: 4px; }
.summary-cell .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 14px; background: #1e293b; border-radius: 8px; overflow: hidden; font-size: 12px; }
th, td { padding: 7px 9px; text-align: right; border-bottom: 1px solid #334155; font-variant-numeric: tabular-nums; }
th { background: #0f172a; color: #94a3b8; font-weight: 600; }
th.left, td.left { text-align: left; }
tr:last-child td { border-bottom: none; }
.pos { color: #6ee7b7; }
.neg { color: #fca5a5; }
.muted { color: #64748b; }
.callout { background: #1e293b; border-left: 4px solid #14b8a6; padding: 10px 14px; border-radius: 6px; font-size: 12px; line-height: 1.7; color: #cbd5e1; margin-bottom: 14px; }
.callout strong { color: #5eead4; }
.callout.warn { border-left-color: #f59e0b; }
.callout.warn strong { color: #fbbf24; }
.callout.success { border-left-color: #10b981; }
.callout.success strong { color: #6ee7b7; }
details.section { margin-bottom: 16px; border: 1px solid #1e293b; border-radius: 8px; }
details.section > summary { cursor: pointer; font-size: 14px; font-weight: 700; color: #cbd5e1; padding: 10px 14px; user-select: none; background: #0f172a; border-radius: 8px; }
details.section[open] > summary { color: #f1f5f9; border-radius: 8px 8px 0 0; }
details.section > .section-body { padding: 12px 14px; }
.tag { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; }
</style>
</head>
<body>
<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/rebreak">🔥 D+5 재돌파 운용</a>
  <a href="/one-day-surge-board">⚡ 1DS 단타 후보</a>
  <a href="/one-day-surge-validation">🔬 1DS 일봉 검증</a>
  <a href="/one-day-surge-entry-confirm" class="active">🚪 1DS ENTRY_CONFIRM</a>
</nav>

<h1>🚪 1-Day Surge ENTRY_CONFIRM 연구 보고서</h1>
<div class="subtitle"><strong>D+1 장초 분봉 진입 확인 조건이 실전 성과를 개선하는지 검증</strong></div>
<div class="subtitle" id="meta-line"></div>

<div class="purpose-box">
  D일 장마감 기준 1DS 후보 (BALANCED-GT/LIGHT-GT/MID-CAP-GT/MOM-RISK 등) 가 D+1일 장초 분봉에서
  실제 ENTRY 조건(V1~V5)을 만족했는지, 그리고 만족 종목들이 진입(09:10 close 기준) 후 +3%/+5%/+7%
  수익 기회와 -3%/-5% 위험이 베이스라인 대비 어떻게 갈리는지 측정합니다.
</div>
<div class="warn-box">
  ⚠ 진입가 = D+1 09:10 close. 진입 후 high/low/close = D+1 일봉. 일봉 high가 09:00~09:10 안에서
  발생한 경우 afterEntryHighRate가 과대 추정될 수 있어 peakBeforeEntry 플래그로 노출합니다.
  ENTRY_AT_REBREAK 진입 가격은 미구현 (09:10 close만).
</div>

<h2>📊 핵심 요약</h2>
<div class="summary-grid" id="summary-grid"></div>

<h2>🎯 ENTRY 조건별 성과</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">
  base = ENTRY 미적용 (분봉 확보 + outcome 가능 후보 전체)
</div>
<table id="t-entry"><thead><tr>
  <th class="left">조건</th><th>n</th>
  <th>HIT3</th><th>HIT5</th><th>HIT7</th><th>FAIL3</th><th>FAIL5</th>
  <th>종가&gt;0</th>
  <th>평균 진입후 고가</th><th>평균 진입후 종가</th>
</tr></thead><tbody></tbody></table>

<h2>📂 그룹별 ENTRY 성과 (V1 통과 기준)</h2>
<table id="t-group"><thead><tr>
  <th class="left">그룹</th>
  <th>전체 n</th><th>전체 HIT5</th><th>전체 FAIL5</th>
  <th>V1 통과 n</th><th>V1 HIT5</th><th>V1 FAIL5</th>
  <th>V1 평균 진입후 고가</th>
</tr></thead><tbody></tbody></table>

<h2>⏰ 09:10 조건별 성과</h2>
<table id="t-0910"><thead><tr>
  <th class="left">조건</th><th>n</th>
  <th>HIT5</th><th>FAIL5</th><th>FAIL3</th>
  <th>평균 진입후 고가</th><th>평균 진입후 종가</th>
</tr></thead><tbody></tbody></table>

<h2>🔁 재돌파 조건별 성과</h2>
<table id="t-rebreak"><thead><tr>
  <th class="left">조건</th><th>n</th>
  <th>HIT5</th><th>HIT7</th><th>FAIL5</th>
  <th>평균 진입후 고가</th>
</tr></thead><tbody></tbody></table>

<h2>⚠ 위험 후보 ENTRY 통과 후 개선 여부</h2>
<table id="t-risk"><thead><tr>
  <th class="left">구분</th><th>n</th><th>HIT5</th><th>FAIL5</th><th>평균 고가</th><th>평균 종가</th>
</tr></thead><tbody></tbody></table>

<h2>🏆 ENTRY_V1 통과 종목 상위 100 (afterEntryHighRate 순)</h2>
<details class="section"><summary>펼쳐서 보기</summary><div class="section-body">
<table id="t-passed"><thead><tr>
  <th class="left">종목</th><th class="left">코드</th>
  <th class="left">기준일</th><th class="left">다음일</th>
  <th class="left">그룹</th><th class="left">캔들</th>
  <th>gap%</th><th>09:10 저가%</th><th>09:10 종가%</th>
  <th>v0_10/prev</th><th>고점 재돌파</th>
  <th>진입 후 고가%</th><th>진입 후 저가%</th><th>진입 후 종가%</th>
</tr></thead><tbody></tbody></table>
</div></details>

<h2>🧠 자동 결론</h2>
<div id="auto-conclusion"></div>

<script>
const DATA = __JSON_DATA__;
function isNum(v) { return v != null && Number.isFinite(v); }
function fmtRate(v, p) { return isNum(v) ? v.toFixed(p || 1) + '%' : '-'; }
function fmtPct(v, p) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(p || 2) + '%' : '-'; }
function fmtNum(v) { return isNum(v) ? Math.round(v).toLocaleString() : '-'; }
function fmtDate(d) { if (!d || String(d).length !== 8) return d || '-'; const s=String(d); return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8); }

document.getElementById('meta-line').innerHTML =
  '윈도우: <strong>' + (DATA.meta.windowFromFmt || '-') + ' ~ ' + (DATA.meta.windowToFmt || '-') + '</strong> (' + DATA.meta.windowDays + '거래일)' +
  ' · 그룹 필터: ' + DATA.meta.groupsFilter.join(', ') +
  ' · 후보 이벤트: ' + DATA.meta.candidateEvents +
  ' · 분봉 확보: <strong>' + DATA.meta.withMinuteData + ' (' + (DATA.meta.minuteCoverage||0).toFixed(1) + '%)</strong>' +
  ' · 누락: ' + DATA.meta.missingMinuteData +
  ' · 처리시간 ' + ((DATA.meta.elapsedMs||0)/1000).toFixed(1) + 's';

(function() {
  const s = DATA.summary.noEntryFilter || {};
  const cells = [
    { lab: '후보 이벤트', val: fmtNum(DATA.meta.candidateEvents), sub: 'D일 1DS 분류 통과' },
    { lab: '분봉 확보', val: fmtNum(DATA.meta.withMinuteData) + ' (' + (DATA.meta.minuteCoverage||0).toFixed(1) + '%)', sub: 'D+1 09:00~10:00 분봉' },
    { lab: '분봉 누락', val: fmtNum(DATA.meta.missingMinuteData), sub: '수집 안 됨 또는 거래정지' },
    { lab: 'base HIT5', val: fmtRate(s.hit5Rate), sub: '진입 후 +5% 도달' },
    { lab: 'base FAIL5', val: fmtRate(s.fail5Rate), sub: '진입 후 -5% 흔들림' },
    { lab: 'base 종가>0', val: fmtRate(s.closePositiveRate), sub: 'D+1 종가 진입가 위' },
    { lab: 'V1 통과', val: fmtNum(DATA.summary.byEntry.entryV1?.n || 0), sub: 'gap<7 + 안전 + 거래대금' },
    { lab: 'V2 통과', val: fmtNum(DATA.summary.byEntry.entryV2?.n || 0), sub: 'V1 + VWAP 위' },
    { lab: 'V3 통과', val: fmtNum(DATA.summary.byEntry.entryV3?.n || 0), sub: '아침고점 재돌파 + 거래대금' },
    { lab: 'V4 통과', val: fmtNum(DATA.summary.byEntry.entryV4?.n || 0), sub: '전일고가 돌파 + VWAP' },
    { lab: 'V5 통과', val: fmtNum(DATA.summary.byEntry.entryV5?.n || 0), sub: 'V1 안전 + 아침고점 재돌파' },
  ];
  document.getElementById('summary-grid').innerHTML = cells.map(c =>
    '<div class="summary-cell"><div class="label">' + c.lab + '</div>' +
    '<div class="value">' + c.val + '</div>' +
    '<div class="sub">' + c.sub + '</div></div>'
  ).join('');
})();

(function() {
  const tb = document.querySelector('#t-entry tbody');
  const rows = [];
  const base = DATA.summary.noEntryFilter || {};
  const baseRow = (label, x) => '<tr><td class="left">' + label + '</td>' +
    '<td>' + fmtNum(x.count) + '</td>' +
    '<td>' + fmtRate(x.hit3Rate) + '</td>' +
    '<td><strong>' + fmtRate(x.hit5Rate) + '</strong></td>' +
    '<td>' + fmtRate(x.hit7Rate) + '</td>' +
    '<td>' + fmtRate(x.fail3Rate) + '</td>' +
    '<td>' + fmtRate(x.fail5Rate) + '</td>' +
    '<td>' + fmtRate(x.closePositiveRate) + '</td>' +
    '<td>' + fmtPct(x.avgAfterHigh) + '</td>' +
    '<td>' + fmtPct(x.avgAfterClose) + '</td></tr>';
  rows.push(baseRow('base (ENTRY 미적용)', base));
  for (const v of ['entryV1','entryV2','entryV3','entryV4','entryV5']) {
    const x = DATA.summary.byEntry[v] || {};
    rows.push(baseRow(v, x));
  }
  tb.innerHTML = rows.join('');
})();

(function() {
  const tb = document.querySelector('#t-group tbody');
  const rows = [];
  for (const [g, info] of Object.entries(DATA.byGroup || {})) {
    const all = info.all || {};
    const v1 = info.byEntry?.entryV1 || {};
    rows.push('<tr><td class="left"><strong>' + g + '</strong></td>' +
      '<td>' + fmtNum(all.count) + '</td>' +
      '<td>' + fmtRate(all.hit5Rate) + '</td>' +
      '<td>' + fmtRate(all.fail5Rate) + '</td>' +
      '<td>' + fmtNum(v1.count) + '</td>' +
      '<td><strong>' + fmtRate(v1.hit5Rate) + '</strong></td>' +
      '<td>' + fmtRate(v1.fail5Rate) + '</td>' +
      '<td>' + fmtPct(v1.avgAfterHigh) + '</td></tr>');
  }
  tb.innerHTML = rows.join('') || '<tr><td class="left muted" colspan="8">데이터 없음</td></tr>';
})();

(function() {
  const tb = document.querySelector('#t-0910 tbody');
  const conds = DATA.by0910Cond || {};
  const labels = {
    aboveOpen: '09:10 시초가 위',
    aboveVwap: '09:10 VWAP 위',
    lowAbove_3: '09:10 저가 -3% 이내',
    valGte5pct: '09:10 거래대금 ≥ 전일 5%',
    allFour: '위 4 조건 모두',
  };
  const rows = [];
  for (const [k, lab] of Object.entries(labels)) {
    const x = conds[k] || {};
    rows.push('<tr><td class="left">' + lab + '</td>' +
      '<td>' + fmtNum(x.count) + '</td>' +
      '<td><strong>' + fmtRate(x.hit5Rate) + '</strong></td>' +
      '<td>' + fmtRate(x.fail5Rate) + '</td>' +
      '<td>' + fmtRate(x.fail3Rate) + '</td>' +
      '<td>' + fmtPct(x.avgAfterHigh) + '</td>' +
      '<td>' + fmtPct(x.avgAfterClose) + '</td></tr>');
  }
  tb.innerHTML = rows.join('');
})();

(function() {
  const tb = document.querySelector('#t-rebreak tbody');
  const r = DATA.byRebreak || {};
  const labels = {
    prevHigh0930: '09:30까지 전일 고가 돌파',
    morningHigh: '09:30까지 아침 첫 10분 고점 재돌파',
    both: '둘 다',
    neither: '둘 다 실패',
  };
  const rows = [];
  for (const [k, lab] of Object.entries(labels)) {
    const x = r[k] || {};
    rows.push('<tr><td class="left">' + lab + '</td>' +
      '<td>' + fmtNum(x.count) + '</td>' +
      '<td><strong>' + fmtRate(x.hit5Rate) + '</strong></td>' +
      '<td>' + fmtRate(x.hit7Rate) + '</td>' +
      '<td>' + fmtRate(x.fail5Rate) + '</td>' +
      '<td>' + fmtPct(x.avgAfterHigh) + '</td></tr>');
  }
  tb.innerHTML = rows.join('');
})();

(function() {
  const tb = document.querySelector('#t-risk tbody');
  const all = DATA.riskCheck?.allRisk || {};
  const rows = ['<tr><td class="left">위험 전체 (MOM-RISK + GAP_HOLD)</td>' +
    '<td>' + fmtNum(all.count) + '</td>' +
    '<td>' + fmtRate(all.hit5Rate) + '</td>' +
    '<td>' + fmtRate(all.fail5Rate) + '</td>' +
    '<td>' + fmtPct(all.avgAfterHigh) + '</td>' +
    '<td>' + fmtPct(all.avgAfterClose) + '</td></tr>'];
  for (const v of ['entryV1','entryV2','entryV3','entryV4','entryV5']) {
    const x = DATA.riskCheck?.byEntry?.[v] || {};
    rows.push('<tr><td class="left">위험 + ' + v + '</td>' +
      '<td>' + fmtNum(x.count) + '</td>' +
      '<td><strong>' + fmtRate(x.hit5Rate) + '</strong></td>' +
      '<td>' + fmtRate(x.fail5Rate) + '</td>' +
      '<td>' + fmtPct(x.avgAfterHigh) + '</td>' +
      '<td>' + fmtPct(x.avgAfterClose) + '</td></tr>');
  }
  tb.innerHTML = rows.join('');
})();

(function() {
  const tb = document.querySelector('#t-passed tbody');
  const list = DATA.passedV1Top || [];
  if (!list.length) {
    tb.innerHTML = '<tr><td class="left muted" colspan="14">ENTRY_V1 통과 종목 없음 (분봉 데이터 부족 가능성)</td></tr>';
    return;
  }
  const rows = [];
  for (const e of list) {
    rows.push('<tr>' +
      '<td class="left">' + (e.name||'-') + '</td>' +
      '<td class="left muted">' + (e.code||'-') + '</td>' +
      '<td class="left">' + fmtDate(e.baseDate) + '</td>' +
      '<td class="left">' + (e.nextDate||'-') + '</td>' +
      '<td class="left">' + (e.gtGroup||'-') + '</td>' +
      '<td class="left muted">' + (e.candleType||'-') + '</td>' +
      '<td>' + fmtPct(e.gapRate, 1) + '</td>' +
      '<td>' + fmtPct(e.lowFromOpen_0_10, 1) + '</td>' +
      '<td>' + fmtPct(e.closeFromOpen_0910, 1) + '</td>' +
      '<td>' + (isNum(e.value_0_10_to_prevValue) ? (e.value_0_10_to_prevValue*100).toFixed(1)+'%' : '-') + '</td>' +
      '<td>' + (e.rebreakMorningHigh_10_30 ? '✓' : '·') + '</td>' +
      '<td class="' + (isNum(e.afterEntryHighRate) && e.afterEntryHighRate >= 5 ? 'pos' : '') + '"><strong>' + fmtPct(e.afterEntryHighRate, 1) + '</strong></td>' +
      '<td class="' + (isNum(e.afterEntryLowRate) && e.afterEntryLowRate <= -3 ? 'neg' : '') + '">' + fmtPct(e.afterEntryLowRate, 1) + '</td>' +
      '<td>' + fmtPct(e.afterEntryCloseRate, 1) + '</td>' +
    '</tr>');
  }
  tb.innerHTML = rows.join('');
})();

(function() {
  const c = DATA.autoConclusion || {};
  const html = [];
  if (c.entryImprovement) html.push('<div class="callout"><strong>① ENTRY 통과 후 개선</strong><br>' + c.entryImprovement + '</div>');
  if (c.bestEntryVersion) html.push('<div class="callout success"><strong>② Best ENTRY 버전</strong><br>' + c.bestEntryVersion.ver + ' (n=' + c.bestEntryVersion.n + ', hit5 ' + c.bestEntryVersion.hit5.toFixed(1) + '% / fail5 ' + c.bestEntryVersion.fail5.toFixed(1) + '%, score ' + c.bestEntryVersion.score.toFixed(1) + ')</div>');
  if ((c.allEntryVersions||[]).length) {
    html.push('<div class="callout"><strong>③ ENTRY V1~V5 비교</strong><br>' +
      c.allEntryVersions.map(v => '• ' + v.ver + ' n=' + v.n + ' / hit5 ' + v.hit5.toFixed(1) + '% / fail5 ' + v.fail5.toFixed(1) + '% / score ' + v.score.toFixed(1)).join('<br>') +
    '</div>');
  }
  if (c.openConditionEffect) html.push('<div class="callout"><strong>④ 09:10 4 조건 효과</strong><br>' + c.openConditionEffect + '</div>');
  if (c.rebreakEffect) html.push('<div class="callout"><strong>⑤ 재돌파 효과</strong><br>' + c.rebreakEffect + '</div>');
  if ((c.groupEntryImprovement||[]).length) {
    html.push('<div class="callout"><strong>⑥ 그룹별 ENTRY_V1 개선</strong><br>' +
      c.groupEntryImprovement.map(g => '• ' + g.group + ' (n=' + g.n + ', V1 n=' + (g.v1n||0) + ') hit5 ' + (g.baseHit5||0).toFixed(1) + '% → ' + (g.v1Hit5||0).toFixed(1) + '% (' + (g.improvement >= 0 ? '+' : '') + g.improvement.toFixed(1) + 'pp)').join('<br>') +
    '</div>');
  }
  if (c.riskGroupRescue) html.push('<div class="callout warn"><strong>⑦ 위험 후보 ENTRY 살림</strong><br>' + c.riskGroupRescue + '</div>');
  if ((c.recommendations||[]).length) {
    html.push('<div class="callout success"><strong>⑧ 보드 반영 권고</strong><br>' + c.recommendations.map(s => '• ' + s).join('<br>') + '</div>');
  }
  if (!html.length) html.push('<div class="callout warn">분봉 데이터가 부족해 자동 결론을 산출하지 못했습니다. 별도 수집 스크립트로 분봉을 누적한 뒤 다시 실행하세요.</div>');
  document.getElementById('auto-conclusion').innerHTML = html.join('');
})();
</script>
</body>
</html>
`;

// 직접 실행 시에만 main(). require로 import 시 (collect script가 사용) helper만 노출.
if (require.main === module) main();

module.exports = {
  generateGtEventsByDate,
  loadStockMetaMap,
  computeIntradayMetrics,
  applyEntryConditions,
  computeOutcomes,
  GROUPS_FILTER,
  CHART_DIR,
  INTRADAY_BASE,
};
