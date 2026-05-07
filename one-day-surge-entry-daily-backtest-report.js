#!/usr/bin/env node
/**
 * 1-Day Surge ENTRY 날짜별 운영형 백테스트 보고서
 *
 * 목적:
 *   조건별 평균이 아니라, 실제 운영처럼 "D일 장마감 → D+1 09:30 ENTRY_CONFIRM" 사이클을
 *   날짜별로 simulate해서 매일 후보가 몇 개 뜨고 그중 몇 개가 성공/실패하는지 검증.
 *
 * 분리 원칙:
 *   - 후보 생성 = D일까지의 데이터만 (look-ahead 금지)
 *   - 분봉 ENTRY_CONFIRM = D+1 09:00~09:30
 *   - 성과 검증 = D+1 일봉 high/low/close
 *   - 모든 데이터 흐름은 ENTRY_CONFIRM 보고서와 동일 (재사용)
 *   - 이번 보고서는 보드 UI에 영향 X — 백테스트 단계
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json (D일 일봉, ~3년)
 *   - cache/naver-stocks-list.json (시총/ETF/특수)
 *   - data/intraday/1ds/YYYY-MM-DD/{code}.json (D+1 장초 분봉)
 *
 * 출력:
 *   - reports/one-day-surge-entry-daily-backtest-result.json
 *   - reports/one-day-surge-entry-daily-backtest-result.html
 *
 * 라우트: GET /one-day-surge-entry-daily-backtest
 *
 * 환경변수:
 *   - ENTRY_BACKTEST_DAYS (기본 40): 백테스트 윈도우 거래일 수
 */

const fs = require('fs');
const path = require('path');
const report = require('./one-day-surge-entry-confirm-report');

const ROOT = __dirname;
const REPORTS_DIR = report.REPORTS_DIR;
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-entry-daily-backtest-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-entry-daily-backtest-result.html');

const VALIDATION_DAYS = Number(process.env.ENTRY_BACKTEST_DAYS || 40);
const GROUPS_FILTER = report.GROUPS_FILTER; // BALANCED-GT,LIGHT-GT,MID-CAP-GT,MOM-RISK

// ── 백테스트 전략 정의 ──
// 각 전략은 (event) => boolean 형태의 filter. 동일 event가 여러 전략에 동시 매칭될 수 있음 (cross-cutting).
const STRATEGIES = {
  BALANCED_REBREAK: {
    label: 'BALANCED + morningHigh',
    desc: 'BALANCED-GT 그룹 + 09:10~30 사이 첫 10분 고점 재돌파',
    filter: (e) => e.gtGroup === 'BALANCED-GT' && e.intraday?.rebreakMorningHigh_10_30 === true,
  },
  LIGHT_REBREAK: {
    label: 'LIGHT + morningHigh',
    desc: 'LIGHT-GT 그룹 + morningHigh 재돌파',
    filter: (e) => e.gtGroup === 'LIGHT-GT' && e.intraday?.rebreakMorningHigh_10_30 === true,
  },
  CLEAN_REBREAK: {
    label: 'morningHigh + prevHigh 돌파 X',
    desc: 'spike 동반하지 않은 깨끗한 morningHigh 재돌파 — 위험 동반 케이스 제외',
    filter: (e) => e.intraday?.rebreakMorningHigh_10_30 === true && e.intraday.rebreakPrevHighBy0930 === false,
  },
  SAFE_REBREAK: {
    label: '(BALANCED|LIGHT) + morningHigh + prevHigh X',
    desc: '실전 가장 안전한 조합 — 추천 후보군',
    filter: (e) => (e.gtGroup === 'BALANCED-GT' || e.gtGroup === 'LIGHT-GT')
                && e.intraday?.rebreakMorningHigh_10_30 === true
                && e.intraday.rebreakPrevHighBy0930 === false,
  },
  RISK_REBREAK: {
    label: '(MOM-RISK | GAP_HOLD) + morningHigh',
    desc: '비교용 — 위험 그룹의 morningHigh 통과가 정말 못 살리는지 검증',
    filter: (e) => (e.gtGroup === 'MOM-RISK' || e.candleType === 'GAP_HOLD')
                && e.intraday?.rebreakMorningHigh_10_30 === true,
  },
  PREV_HIGH_SPIKE: {
    label: 'prevHigh 돌파 단독',
    desc: '비교용 — 전일고가 돌파 단독은 spike 위험인지 검증',
    filter: (e) => e.intraday?.rebreakPrevHighBy0930 === true,
  },
};
const STRATEGY_NAMES = Object.keys(STRATEGIES);

// ── 날짜 성격 분류 (dayType) ──
// 같은 후보군이라도 그날 시장 분위기에 따라 "장중 한 번 튀고 빠진 날"과 "종가까지 유지된 날"이 다르다.
// dayType별로 SAFE/BAL/LIGHT/RISK 전략 성과가 갈리는지 보면, 1DS를 짧은 익절형으로 써야 할 날 vs
// 종가까지 유지해도 되는 날을 구분할 수 있다.
const DAY_TYPE_LABELS = {
  HIT_AND_FADE_DAY: '🌊 장중 한 번 튀었지만 종가 유지 약함',
  HOLDING_DAY:      '✅ 종가까지 유지된 강한 날',
  WEAK_DAY:         '❌ 후보들이 전반적으로 부진한 날',
  MIXED_DAY:        '◯ 혼합 (어느 한쪽 성격 아님)',
};
const DAY_TYPE_DESCS = {
  HIT_AND_FADE_DAY: '장초 한 번은 잘 튀었지만 후반부에 빠짐. 짧은 익절형으로만 사용하고 종가 유지에는 베팅하지 않음.',
  HOLDING_DAY:      '튀고 종가까지 유지된 날. 종가 베팅이 통한 날 — 1DS 본연의 흐름.',
  WEAK_DAY:         '시장 전체가 약했음. 후보들도 안 튀고 종가도 약함. 매매 자체를 줄여야 했던 날.',
  MIXED_DAY:        '명확한 한쪽 성격이 아님. 케이스별 판단.',
};
function classifyDayType(daySummary) {
  const h5 = daySummary.hit5Rate || 0;
  const cp = daySummary.closePositiveRate || 0;
  const ac = daySummary.avgAfterClose || 0;
  if (h5 >= 50 && cp <= 40 && ac < 0) return 'HIT_AND_FADE_DAY';
  if (h5 >= 50 && cp >= 55 && ac > 0) return 'HOLDING_DAY';
  if (h5 < 40 && ac <= 0) return 'WEAK_DAY';
  return 'MIXED_DAY';
}

// ── 유틸 ──
function isNum(v) { return v != null && Number.isFinite(v); }
function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}
function dateNumToStr(yyyymmdd) {
  return yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8);
}

// ── 메인 ──
function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const t0 = Date.now();
  console.log(`\n📡 1DS ENTRY 날짜별 운영형 백테스트 (windowDays=${VALIDATION_DAYS})`);
  console.log(`  전략: ${STRATEGY_NAMES.join(', ')}`);

  // 1) ENTRY_CONFIRM과 동일한 후보 생성 (D일까지만)
  const metaMap = report.loadStockMetaMap();
  const files = fs.readdirSync(report.CHART_DIR).filter((f) => f.endsWith('.json'));
  console.log(`  메타: ${metaMap.size}건 / 차트 파일: ${files.length}건`);

  const { allEvents, eventsByDate, stocksProcessed, stocksFiltered } =
    report.generateGtEventsByDate({ windowDays: VALIDATION_DAYS, groupsFilter: GROUPS_FILTER, metaMap, files });
  console.log(`  처리 종목: ${stocksProcessed} / 필터 제외: ${stocksFiltered} / GT 그룹 후보: ${allEvents.length}건 (${eventsByDate.size}일)`);

  // 2) 분봉 + ENTRY 조건 + outcome 계산 (ENTRY_CONFIRM 동일 로직)
  let withMinute = 0, missingMinute = 0;
  for (const ev of allEvents) {
    if (!ev.nextDayRow || !ev.nextDayRow.date) { ev.minuteAvailable = false; missingMinute++; continue; }
    const nextDateStr = dateNumToStr(ev.nextDayRow.date);
    const minuteData = report.loadMinuteBars(nextDateStr, ev.code);
    if (!minuteData) { ev.minuteAvailable = false; missingMinute++; continue; }
    ev.minuteAvailable = true;
    ev.nextDateStr = nextDateStr;
    const im = report.computeIntradayMetrics(ev, minuteData);
    if (!im) { ev.intradayInvalid = true; continue; }
    ev.intraday = im;
    ev.entry = report.applyEntryConditions(im);
    ev.outcome = report.computeOutcomes(im, ev.nextDayRow);
    withMinute++;
  }
  console.log(`  분봉 확보: ${withMinute}건 / 누락: ${missingMinute}건`);

  const eventsWithMinute = allEvents.filter((e) => e.minuteAvailable && e.outcome);

  // 3) 날짜별 그룹화
  const dateMap = new Map();
  // GT 후보 전체 (분봉 누락 포함) 도 같이 셈
  for (const ev of allEvents) {
    const d = ev.baseDate;
    if (!dateMap.has(d)) {
      dateMap.set(d, {
        date: d, dateFmt: fmtDate(d),
        nextDate: ev.nextDayRow?.date || null,
        nextDateFmt: ev.nextDayRow?.date ? fmtDate(ev.nextDayRow.date) : null,
        totalCandidates: 0,    // GT 분류 통과한 D일 후보 전체 (분봉 모름)
        withMinuteCount: 0,    // 분봉 확보 된 후보 (실제 backtest 가능)
        events: [],            // 분봉 확보 된 events 만
        strategies: {},
      });
    }
    const r = dateMap.get(d);
    r.totalCandidates++;
    if (ev.minuteAvailable && ev.outcome) {
      r.withMinuteCount++;
      r.events.push(ev);
    }
  }

  // 4) 날짜별 × 전략별 분류 + 요약
  for (const r of dateMap.values()) {
    for (const [name, strat] of Object.entries(STRATEGIES)) {
      const matched = r.events.filter(strat.filter);
      const summ = report.summarizeBucket(matched);
      r.strategies[name] = {
        ...summ,
        n: matched.length,
        codes: matched.map((e) => makeEventDigest(e, [name])),
      };
    }
    // 전체 day 요약 (모든 분봉 확보 events 기준)
    r.daySummary = report.summarizeBucket(r.events);
  }

  // 5) 전략별 전체 요약
  const strategySummary = {};
  const totalDays = dateMap.size;
  for (const [name, strat] of Object.entries(STRATEGIES)) {
    const allMatched = eventsWithMinute.filter(strat.filter);
    const summ = report.summarizeBucket(allMatched);
    const dailyCounts = [...dateMap.values()].map((r) => r.strategies[name].n);
    const zeroDays = dailyCounts.filter((n) => n === 0).length;
    const heavyDays = dailyCounts.filter((n) => n >= 10).length; // "너무 많은" 기준 = 10+
    strategySummary[name] = {
      label: strat.label,
      desc: strat.desc,
      summary: summ,
      totalCandidates: allMatched.length,
      dailyAvg: dailyCounts.length ? allMatched.length / totalDays : 0,
      dailyMax: Math.max(0, ...dailyCounts),
      dailyMin: Math.min(...(dailyCounts.length ? dailyCounts : [0])),
      zeroDays,
      heavyDays,
      totalDays,
    };
  }

  // 6) 날짜별 detail (각 event가 어떤 전략에 매칭됐는지 표기)
  const byDateDetail = [...dateMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({
      date: r.date,
      dateFmt: r.dateFmt,
      nextDate: r.nextDate,
      nextDateFmt: r.nextDateFmt,
      totalCandidates: r.totalCandidates,
      withMinute: r.withMinuteCount,
      strategyCounts: Object.fromEntries(STRATEGY_NAMES.map((n) => [n, r.strategies[n].n])),
      daySummary: r.daySummary,
      events: r.events.map((e) => makeEventDigest(e, matchedStrategies(e))),
    }));

  // 6.5) 날짜별 dayType 분류 + 분포
  for (const r of byDateDetail) {
    r.dayType = classifyDayType(r.daySummary || {});
  }
  const dayTypeCounts = {};
  for (const k of Object.keys(DAY_TYPE_LABELS)) dayTypeCounts[k] = 0;
  for (const r of byDateDetail) dayTypeCounts[r.dayType]++;

  // 6.6) dayType × 전략 cross-tab
  // 각 dayType에 속한 날짜의 모든 events를 모아서 각 전략 filter 적용 → summarizeBucket
  const STRAT_FOR_CROSSTAB = ['SAFE_REBREAK', 'BALANCED_REBREAK', 'LIGHT_REBREAK', 'CLEAN_REBREAK', 'RISK_REBREAK', 'PREV_HIGH_SPIKE'];
  const dayTypeStrategy = {};
  for (const dt of Object.keys(DAY_TYPE_LABELS)) {
    const datesOfType = new Set(byDateDetail.filter((r) => r.dayType === dt).map((r) => r.date));
    const eventsOfType = eventsWithMinute.filter((e) => datesOfType.has(e.baseDate));
    const overall = report.summarizeBucket(eventsOfType);
    const byStrategy = {};
    for (const sName of STRAT_FOR_CROSSTAB) {
      const strat = STRATEGIES[sName];
      const matched = eventsOfType.filter(strat.filter);
      byStrategy[sName] = report.summarizeBucket(matched);
    }
    dayTypeStrategy[dt] = {
      dayCount: dayTypeCounts[dt],
      eventCount: eventsOfType.length,
      overall,
      byStrategy,
    };
  }

  // 6.7) peakBeforeEntry 분석 (true vs false, overall)
  // peakBefore=true 면 D+1 일봉 high가 09:00~09:10 안에서 발생했음. 09:10 진입 시점엔 이미 고점 후 → 추격 위험.
  const peakBeforeAnalysis = {
    withPeak:    report.summarizeBucket(eventsWithMinute.filter((e) => e.outcome.peakBeforeEntry === true)),
    withoutPeak: report.summarizeBucket(eventsWithMinute.filter((e) => e.outcome.peakBeforeEntry !== true)),
  };
  // dayType × peakBefore 비율 (어떤 dayType에서 peakBefore가 높은가)
  const peakBeforeByDayType = {};
  for (const dt of Object.keys(DAY_TYPE_LABELS)) {
    const datesOfType = new Set(byDateDetail.filter((r) => r.dayType === dt).map((r) => r.date));
    const eventsOfType = eventsWithMinute.filter((e) => datesOfType.has(e.baseDate));
    peakBeforeByDayType[dt] = {
      n: eventsOfType.length,
      peakBeforeCount: eventsOfType.filter((e) => e.outcome.peakBeforeEntry === true).length,
    };
    peakBeforeByDayType[dt].peakBeforeRate = peakBeforeByDayType[dt].n > 0
      ? peakBeforeByDayType[dt].peakBeforeCount / peakBeforeByDayType[dt].n * 100 : null;
  }

  // 6.8) 고위험 급등 가능 후보 분석 (MOM-RISK + PREV_HIGH_SPIKE)
  // "제외"가 아니라 "고위험 급등 가능 후보"로 별도 분류. 평균은 위험하지만 큰 상승 사례 있음.
  const highRiskEvents = eventsWithMinute.filter((e) =>
    e.gtGroup === 'MOM-RISK' || e.candleType === 'GAP_HOLD'
    || (e.intraday && e.intraday.rebreakPrevHighBy0930 === true)
  );
  const highRiskOverall = report.summarizeBucket(highRiskEvents);
  // 큰 상승 사례 (afterEntryHighRate ≥ 15% 만 추출, 상위 15)
  const highRiskBigGains = highRiskEvents
    .filter((e) => (e.outcome.afterEntryHighRate || 0) >= 15)
    .sort((a, b) => (b.outcome.afterEntryHighRate || 0) - (a.outcome.afterEntryHighRate || 0))
    .slice(0, 15)
    .map((e) => ({
      code: e.code, name: e.name, baseDate: e.baseDate, nextDate: e.nextDateStr,
      gtGroup: e.gtGroup, candleType: e.candleType,
      gapRate: e.intraday.gapRate,
      afterEntryHighRate: e.outcome.afterEntryHighRate,
      afterEntryLowRate: e.outcome.afterEntryLowRate,
      afterEntryCloseRate: e.outcome.afterEntryCloseRate,
      peakBeforeEntry: e.outcome.peakBeforeEntry,
      morningHigh: e.intraday.rebreakMorningHigh_10_30,
      prevHigh: e.intraday.rebreakPrevHighBy0930,
    }));
  // 고위험 카테고리별 잔여 통계
  const highRiskBuckets = {
    momRisk:    report.summarizeBucket(eventsWithMinute.filter((e) => e.gtGroup === 'MOM-RISK')),
    gapHold:    report.summarizeBucket(eventsWithMinute.filter((e) => e.candleType === 'GAP_HOLD')),
    prevHighSpike: report.summarizeBucket(eventsWithMinute.filter((e) => e.intraday?.rebreakPrevHighBy0930 === true)),
  };

  // 7) best/worst days (SAFE_REBREAK 후보들의 평균 종가 기준; 표본 부족 시 전체 day 평균)
  const dayPerf = byDateDetail.map((r) => {
    const safe = r.strategyCounts.SAFE_REBREAK;
    // SAFE_REBREAK가 있으면 그 평균 종가, 없으면 day 전체 평균
    const safeEvents = r.events.filter((e) => e.strategies?.includes('SAFE_REBREAK'));
    const usedEvents = safeEvents.length > 0 ? safeEvents : r.events;
    const avg = usedEvents.length
      ? usedEvents.reduce((s, e) => s + (isNum(e.afterEntryCloseRate) ? e.afterEntryCloseRate : 0), 0) / usedEvents.length
      : null;
    return {
      date: r.date, dateFmt: r.dateFmt, nextDate: r.nextDate, nextDateFmt: r.nextDateFmt,
      safeN: safe, totalN: r.withMinute,
      avgClose: avg,
      basedOn: safeEvents.length > 0 ? 'SAFE_REBREAK' : 'all events',
    };
  }).filter((d) => d.totalN > 0 && isNum(d.avgClose));
  const bestDays = [...dayPerf].sort((a, b) => (b.avgClose || 0) - (a.avgClose || 0)).slice(0, 5);
  const worstDays = [...dayPerf].sort((a, b) => (a.avgClose || 0) - (b.avgClose || 0)).slice(0, 5);

  // 8) 자동 결론
  const autoConclusion = buildAutoConclusion({
    strategySummary, bestDays, worstDays, totalDays,
    byDateDetail, dayTypeCounts, dayTypeStrategy,
    peakBeforeAnalysis, peakBeforeByDayType,
    highRiskOverall, highRiskBuckets, highRiskBigGains,
  });

  // 9) 분석 윈도우
  const allDates = [...dateMap.keys()].sort();
  const windowFrom = allDates[0] || null;
  const windowTo   = allDates[allDates.length - 1] || null;

  const out = {
    meta: {
      title: '1-Day Surge ENTRY 날짜별 운영형 백테스트',
      subtitle: 'D일 후보 → D+1 09:30 ENTRY_CONFIRM → D+1 일봉 outcome 사이클을 날짜별로 simulate',
      generatedAt: new Date().toISOString(),
      windowDays: VALIDATION_DAYS,
      windowFrom, windowFromFmt: windowFrom ? fmtDate(windowFrom) : null,
      windowTo,   windowToFmt:   windowTo   ? fmtDate(windowTo)   : null,
      groupsFilter: GROUPS_FILTER,
      strategies: STRATEGY_NAMES,
      strategyLabels: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, v.label])),
      strategyDescs: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, v.desc])),
      stocksProcessed, stocksFiltered,
      candidateEvents: allEvents.length,
      withMinuteData: withMinute,
      missingMinuteData: missingMinute,
      minuteCoverage: allEvents.length ? withMinute / allEvents.length * 100 : 0,
      totalDays,
      elapsedMs: Date.now() - t0,
      assumption: {
        entryPrice: '09:10 close (ENTRY_AT_0910)',
        afterEntryRange: 'D+1 일봉 high/low/close. 일봉 high가 09:00~09:10 안에서 발생한 경우 afterEntryHighRate 과대 추정 가능 (peakBeforeEntry 플래그).',
        lookAhead: '없음 — D일 후보 산출에는 D일까지의 일봉만 사용. D+1 분봉/일봉은 outcome 검증에만.',
      },
    },
    strategySummary,
    byDateDetail,
    bestDays,
    worstDays,
    // ── 신규: 날짜 성격 + 추격 위험 + 고위험 급등 분석 ──
    dayTypeAnalysis: {
      labels: DAY_TYPE_LABELS,
      descriptions: DAY_TYPE_DESCS,
      counts: dayTypeCounts,
      byStrategy: dayTypeStrategy,
      strategiesForCrosstab: STRAT_FOR_CROSSTAB,
    },
    peakBeforeAnalysis: {
      ...peakBeforeAnalysis,
      byDayType: peakBeforeByDayType,
    },
    highRiskAnalysis: {
      overall: highRiskOverall,
      buckets: highRiskBuckets,
      bigGains: highRiskBigGains,
      interpretation: '이 그룹은 평균적으로 실패폭이 크지만, 장중 큰 상승도 나올 수 있습니다. ' +
        '메인 안전 후보가 아니라 고위험 급등 가능 후보로 별도 확인하는 것이 적절합니다.',
    },
    autoConclusion,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out)), 'utf-8');

  console.log(`\n  날짜 수: ${totalDays} / 후보 평균 ${(eventsWithMinute.length / totalDays).toFixed(1)}건/일`);
  for (const name of STRATEGY_NAMES) {
    const s = strategySummary[name];
    console.log(`  ${name.padEnd(20)} 총 ${String(s.totalCandidates).padStart(4)}건 (일평균 ${s.dailyAvg.toFixed(1)}, 0일 ${s.zeroDays}/${totalDays}) hit5 ${s.summary.hit5Rate ? s.summary.hit5Rate.toFixed(1) : '-'}% / fail5 ${s.summary.fail5Rate ? s.summary.fail5Rate.toFixed(1) : '-'}% / 종가>0 ${s.summary.closePositiveRate ? s.summary.closePositiveRate.toFixed(1) : '-'}% / avgClose ${s.summary.avgAfterClose != null ? (s.summary.avgAfterClose > 0 ? '+' : '') + s.summary.avgAfterClose.toFixed(2) : '-'}%`);
  }
  console.log(`  total elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);

  function matchedStrategies(e) {
    const out = [];
    for (const [name, strat] of Object.entries(STRATEGIES)) {
      if (strat.filter(e)) out.push(name);
    }
    return out;
  }
}

function makeEventDigest(e, strategies) {
  return {
    code: e.code, name: e.name,
    gtGroup: e.gtGroup, candleType: e.candleType,
    gapRate: e.intraday.gapRate,
    morningHigh: e.intraday.rebreakMorningHigh_10_30,
    prevHigh: e.intraday.rebreakPrevHighBy0930,
    sustainedPrevHigh: e.intraday.isAbovePrevHighAt0930,
    afterEntryHighRate: e.outcome.afterEntryHighRate,
    afterEntryLowRate: e.outcome.afterEntryLowRate,
    afterEntryCloseRate: e.outcome.afterEntryCloseRate,
    hit5: e.outcome.hit5,
    fail5: e.outcome.fail5,
    closePos: e.outcome.closePositive,
    peakBeforeEntry: e.outcome.peakBeforeEntry,
    strategies,
  };
}

function buildAutoConclusion({
  strategySummary, bestDays, worstDays, totalDays,
  byDateDetail, dayTypeCounts, dayTypeStrategy,
  peakBeforeAnalysis, peakBeforeByDayType,
  highRiskOverall, highRiskBuckets, highRiskBigGains,
}) {
  const c = {};
  const fmt = (v) => v != null && Number.isFinite(v) ? v.toFixed(1) : '-';
  const fmtSign = (v) => v != null && Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(2) : '-';

  // 1) 실제 운영 가능한 후보 수가 나오는가?
  const safe = strategySummary.SAFE_REBREAK;
  const balanced = strategySummary.BALANCED_REBREAK;
  const light = strategySummary.LIGHT_REBREAK;
  const clean = strategySummary.CLEAN_REBREAK;
  const risk = strategySummary.RISK_REBREAK;
  const spike = strategySummary.PREV_HIGH_SPIKE;

  c.operationalViability = {
    SAFE_REBREAK: { dailyAvg: safe.dailyAvg, zeroDays: safe.zeroDays, totalDays },
    BALANCED_REBREAK: { dailyAvg: balanced.dailyAvg, zeroDays: balanced.zeroDays, totalDays },
    LIGHT_REBREAK: { dailyAvg: light.dailyAvg, zeroDays: light.zeroDays, totalDays },
    note: `SAFE_REBREAK 일평균 ${safe.dailyAvg.toFixed(1)}건, 후보 0개 ${safe.zeroDays}/${totalDays}일. ` +
      (safe.dailyAvg < 1
        ? '일평균 1건 미만 — 운영 보드 상단 후보로 너무 적을 수 있음.'
        : safe.dailyAvg <= 5
          ? '일평균 1~5건 — 운영 보드에 적정 분량.'
          : '일평균 5건 초과 — 보드 상단에 너무 많을 수 있음, 추가 필터 필요.'),
  };

  // 2) 어떤 전략이 가장 좋은가? (closePositive rate 기준)
  const ranked = Object.entries(strategySummary)
    .filter(([_, s]) => s.summary.count >= 20)
    .map(([k, s]) => ({
      name: k, label: s.label,
      n: s.summary.count, dailyAvg: s.dailyAvg,
      hit5: s.summary.hit5Rate, fail5: s.summary.fail5Rate,
      closePos: s.summary.closePositiveRate, avgClose: s.summary.avgAfterClose,
      score: (s.summary.closePositiveRate || 0) - (s.summary.fail5Rate || 0) * 0.5,
    }))
    .sort((a, b) => b.score - a.score);
  c.bestStrategy = ranked[0] || null;
  c.allStrategiesRanked = ranked;

  // 3) HIT5는 높지만 FAIL5도 높은 전략은? (= spike 위험)
  c.spikeStrategies = ranked
    .filter((r) => (r.hit5 || 0) >= 60 && (r.fail5 || 0) >= 50)
    .map((r) => ({ name: r.name, hit5: r.hit5, fail5: r.fail5, closePos: r.closePos, avgClose: r.avgClose }));

  // 4) 보드 상단 후보 (closePos ≥ 55 + avgClose > 0 + dailyAvg ≥ 0.5)
  c.topShelfCandidates = ranked
    .filter((r) => (r.closePos || 0) >= 55 && (r.avgClose || 0) > 0 && r.dailyAvg >= 0.5)
    .map((r) => r.name);

  // 5) 하단/제외 (closePos < 45 || avgClose < 0)
  c.bottomShelfCandidates = ranked
    .filter((r) => (r.closePos || 0) < 45 || (r.avgClose || 0) < 0)
    .map((r) => r.name);

  // 6) 표본 부족 (n < 20)
  c.underSampled = Object.entries(strategySummary)
    .filter(([_, s]) => s.summary.count < 20)
    .map(([k, s]) => ({ name: k, n: s.summary.count }));

  // 7) one-day-surge-board.js 반영해도 되는가?
  const top = c.topShelfCandidates.length;
  const days40Plus = totalDays >= 40;
  c.boardReadiness = {
    boardReady: top > 0 && days40Plus,
    note: top === 0
      ? '아직 보드 상단 권장 전략이 없음. 추가 표본/조건 튜닝 필요.'
      : !days40Plus
        ? `백테스트 윈도우 ${totalDays}일 — 40일 미만이라 안정성 판단 부족. ENTRY_BACKTEST_DAYS=60 등으로 늘린 뒤 재검토 권장.`
        : `${top}개 전략(${c.topShelfCandidates.join(', ')})이 상단 후보 기준(종가>0 ≥55%, 평균종가>0, 일평균≥0.5건) 통과. 보드 반영 단계 진입 가능 — 단 SAFE_REBREAK 위주로 우선 적용 권장.`,
  };

  // 8) best/worst days
  c.bestDays = bestDays;
  c.worstDays = worstDays;

  // ── 9) 가장 최근 거래일의 dayType 해석 ──
  const sortedDates = (byDateDetail || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const latestDay = sortedDates[sortedDates.length - 1];
  if (latestDay) {
    const ds = latestDay.daySummary || {};
    const dt = latestDay.dayType;
    c.latestDayType = {
      date: latestDay.dateFmt,
      nextDate: latestDay.nextDateFmt,
      dayType: dt,
      label: (dayTypeStrategy && dayTypeStrategy[dt]) ? null : null, // populated below
      hit5: ds.hit5Rate, closePos: ds.closePositiveRate, avgClose: ds.avgAfterClose,
      eventCount: ds.count,
    };
    // dayType별 전략 성과를 함께
    if (dayTypeStrategy && dayTypeStrategy[dt]) {
      const dts = dayTypeStrategy[dt].byStrategy;
      c.latestDayType.safeOnDay = dts.SAFE_REBREAK;
      c.latestDayType.balOnDay = dts.BALANCED_REBREAK;
      c.latestDayType.lightOnDay = dts.LIGHT_REBREAK;
    }
  }

  // ── 10) dayType 분포 ──
  c.dayTypeDistribution = dayTypeCounts ? Object.entries(dayTypeCounts)
    .map(([k, v]) => ({ dayType: k, count: v, pct: totalDays > 0 ? v / totalDays * 100 : 0 }))
    .sort((a, b) => b.count - a.count) : [];

  // ── 11) dayType별 SAFE/BAL/LIGHT 평균 종가 비교 (1DS 본질: 어떤 날에 종가까지 유지되는가) ──
  c.dayTypeStrategyClose = [];
  if (dayTypeStrategy) {
    for (const dt of Object.keys(dayTypeStrategy)) {
      const info = dayTypeStrategy[dt];
      if (info.dayCount === 0) continue;
      const safe = info.byStrategy.SAFE_REBREAK || {};
      const bal  = info.byStrategy.BALANCED_REBREAK || {};
      const light= info.byStrategy.LIGHT_REBREAK || {};
      const risk = info.byStrategy.RISK_REBREAK || {};
      const spike= info.byStrategy.PREV_HIGH_SPIKE || {};
      c.dayTypeStrategyClose.push({
        dayType: dt,
        dayCount: info.dayCount,
        eventCount: info.eventCount,
        overallAvgClose: info.overall?.avgAfterClose,
        overallClosePos: info.overall?.closePositiveRate,
        safeAvgClose: safe.avgAfterClose, safeN: safe.count,
        balAvgClose: bal.avgAfterClose, balN: bal.count,
        lightAvgClose: light.avgAfterClose, lightN: light.count,
        riskAvgClose: risk.avgAfterClose, riskN: risk.count,
        spikeAvgClose: spike.avgAfterClose, spikeN: spike.count,
      });
    }
  }

  // ── 12) peakBeforeEntry 영향 ──
  if (peakBeforeAnalysis) {
    const wp = peakBeforeAnalysis.withPeak || {};
    const np = peakBeforeAnalysis.withoutPeak || {};
    c.peakBeforeEffect = {
      withPeak:    { n: wp.count, hit5: wp.hit5Rate, fail5: wp.fail5Rate, closePos: wp.closePositiveRate, avgClose: wp.avgAfterClose },
      withoutPeak: { n: np.count, hit5: np.hit5Rate, fail5: np.fail5Rate, closePos: np.closePositiveRate, avgClose: np.avgAfterClose },
      // 영향 = (without - with) — without가 더 좋아야 'peakBefore가 위험 신호'임이 입증
      closePositiveLift: (np.closePositiveRate || 0) - (wp.closePositiveRate || 0),
      avgCloseLift:      (np.avgAfterClose || 0) - (wp.avgAfterClose || 0),
    };
  }

  // ── 13) 고위험 급등 가능 후보 — 큰 상승 사례 + 평균 ──
  if (highRiskOverall && highRiskBigGains) {
    c.highRiskMessage = {
      overall: {
        n: highRiskOverall.count,
        hit5: highRiskOverall.hit5Rate, fail5: highRiskOverall.fail5Rate,
        closePos: highRiskOverall.closePositiveRate, avgClose: highRiskOverall.avgAfterClose,
        avgHigh: highRiskOverall.avgAfterHigh,
      },
      bigGainsCount: highRiskBigGains.length,
      topGain: highRiskBigGains[0] || null,
      // "메인 안전 후보가 아니라 고위험 급등 가능 후보로 별도 확인" 문구
      interpretation: '평균은 위험하지만 장중 +15% 이상 큰 상승 사례 ' + (highRiskBigGains.length) + '건 존재. ' +
        '메인 안전 후보(SAFE_REBREAK)와 분리해서 "고위험 급등 가능 후보" 별도 섹션으로 운영하는 것이 적절.',
    };
  }

  // ── 14) 핵심 권고 (텍스트 권고 — 기존 + 신규 dayType/peakBefore/highRisk 강조) ──
  c.recommendations = [];
  c.recommendations.push(`최우선 전략: ${c.bestStrategy ? c.bestStrategy.name + ' (n=' + c.bestStrategy.n + ', 종가>0 ' + fmt(c.bestStrategy.closePos) + '%, 평균종가 ' + fmtSign(c.bestStrategy.avgClose) + '%, 일평균 ' + c.bestStrategy.dailyAvg.toFixed(1) + '건)' : '판단 보류 (표본 부족)'}.`);
  c.recommendations.push(`SAFE_REBREAK 일평균 ${safe.dailyAvg.toFixed(1)}건 / 0일 ${safe.zeroDays}/${totalDays} — ${safe.dailyAvg >= 0.5 ? '운영 가능' : '표본 너무 적음, 조건 완화 검토'}.`);
  c.recommendations.push(`BALANCED_REBREAK vs LIGHT_REBREAK: closePos ${fmt(balanced.summary.closePositiveRate)}% vs ${fmt(light.summary.closePositiveRate)}% / avgClose ${fmtSign(balanced.summary.avgAfterClose)}% vs ${fmtSign(light.summary.avgAfterClose)}% — ${(balanced.summary.closePositiveRate || 0) > (light.summary.closePositiveRate || 0) ? 'BALANCED 우세' : 'LIGHT 우세 또는 동률'}.`);
  c.recommendations.push(`RISK_REBREAK (위험 그룹): closePos ${fmt(risk.summary.closePositiveRate)}% / avgClose ${fmtSign(risk.summary.avgAfterClose)}% — ${(risk.summary.avgAfterClose || 0) < 0 ? 'morningHigh로도 못 살림 → 메인 안전 후보 제외, 단 큰 상승 사례 있으니 "고위험 급등 가능" 분리 운영' : '제한적 사용'}.`);
  c.recommendations.push(`PREV_HIGH_SPIKE: closePos ${fmt(spike.summary.closePositiveRate)}% / fail5 ${fmt(spike.summary.fail5Rate)}% — spike 위험 확인. 진입 신호 X, 큰 상승 가능성 있으니 "고위험 급등 가능 후보"로만 노출.`);
  c.recommendations.push(`CLEAN_REBREAK (morningHigh + !prevHigh): fail5 ${fmt(clean.summary.fail5Rate)}% — fail 가장 깨끗 — SAFE의 핵심 구성 조건 검증.`);
  // 신규: dayType / peakBefore / highRisk 권고
  if (c.latestDayType) {
    const lt = c.latestDayType;
    c.recommendations.push(`최근 거래일 (${lt.date} → ${lt.nextDate}) 분류: ${lt.dayType} — hit5 ${fmt(lt.hit5)}% / 종가>0 ${fmt(lt.closePos)}% / 평균종가 ${fmtSign(lt.avgClose)}% (n=${lt.eventCount}). ${lt.dayType === 'HIT_AND_FADE_DAY' ? '장중 한 번 튀었지만 종가 유지 약함 — 짧은 익절형으로만 사용했어야 했음.' : ''}`);
  }
  if (c.peakBeforeEffect) {
    const pe = c.peakBeforeEffect;
    c.recommendations.push(`peakBeforeEntry 영향: 진입 전 고점 발생(n=${pe.withPeak.n}) avgClose ${fmtSign(pe.withPeak.avgClose)}% vs 진입 후 고점(n=${pe.withoutPeak.n}) avgClose ${fmtSign(pe.withoutPeak.avgClose)}% — 차이 ${fmtSign(pe.avgCloseLift)}pp. peakBefore=true는 강한 추격 주의 신호로 카드에 명시 권고.`);
  }
  if (c.highRiskMessage) {
    c.recommendations.push(`고위험 급등 가능 후보 (MOM-RISK + GAP_HOLD + PREV_HIGH_SPIKE, n=${c.highRiskMessage.overall.n}): 평균 종가 ${fmtSign(c.highRiskMessage.overall.avgClose)}%지만 +15% 이상 큰 상승 ${c.highRiskMessage.bigGainsCount}건. "제외"가 아니라 별도 섹션으로 분리해서 노출하는 것이 적절.`);
  }
  c.recommendations.push(`보드 반영 여부: ${c.boardReadiness.boardReady ? '✅ 진입 가능' : '⏸ 아직 대기'} — 안정형(SAFE)과 고위험 급등 가능 후보를 분리한 2-tier 보드가 결론.`);

  return c;
}

// ── HTML 템플릿 ──
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>1-Day Surge ENTRY 날짜별 백테스트</title>
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
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
.summary-cell { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.summary-cell .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.summary-cell .value { font-size: 18px; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; margin-top: 4px; }
.summary-cell .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 14px; background: #1e293b; border-radius: 8px; overflow: hidden; font-size: 12px; }
th, td { padding: 7px 9px; text-align: right; border-bottom: 1px solid #334155; font-variant-numeric: tabular-nums; }
th { background: #0f172a; color: #94a3b8; font-weight: 600; }
th.left, td.left { text-align: left; }
tr:last-child td { border-bottom: none; }
tr:hover { background: #233044; }
.pos { color: #6ee7b7; }
.neg { color: #fca5a5; }
.muted { color: #64748b; }
.chip { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; margin-right:3px; }
.chip-balanced { background: #064e3b; color: #6ee7b7; }
.chip-light    { background: #134e4a; color: #5eead4; }
.chip-clean    { background: #312e81; color: #c7d2fe; }
.chip-safe     { background: #14532d; color: #86efac; }
.chip-risk     { background: #7c2d12; color: #fdba74; }
.chip-spike    { background: #422006; color: #fbbf24; }
.callout { background: #1e293b; border-left: 4px solid #14b8a6; padding: 10px 14px; border-radius: 6px; font-size: 12px; line-height: 1.7; color: #cbd5e1; margin-bottom: 14px; }
.callout strong { color: #5eead4; }
.callout.warn { border-left-color: #f59e0b; }
.callout.warn strong { color: #fbbf24; }
.callout.success { border-left-color: #10b981; }
.callout.success strong { color: #6ee7b7; }
details.section { margin-bottom: 16px; border: 1px solid #1e293b; border-radius: 8px; }
details.section > summary { cursor: pointer; font-size: 13px; font-weight: 700; color: #cbd5e1; padding: 8px 12px; user-select: none; background: #0f172a; border-radius: 8px; }
details.section[open] > summary { color: #f1f5f9; border-radius: 8px 8px 0 0; }
details.section > .section-body { padding: 8px 10px; }
.event-row { font-size: 11px; padding: 4px 6px; border-bottom: 1px solid #233044; display: grid; grid-template-columns: 1.5fr 0.7fr 0.7fr 0.5fr 0.5fr 0.5fr 0.5fr 1.2fr; gap: 6px; align-items: center; }
.event-row.head { font-weight: 600; color: #94a3b8; background: #0f172a; }
</style>
</head>
<body>
<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/rebreak">🔥 D+5 재돌파 운용</a>
  <a href="/one-day-surge-board">⚡ 1DS 단타 후보</a>
  <a href="/one-day-surge-validation">🔬 1DS 다음날 검증</a>
  <a href="/one-day-surge-entry-confirm">🚪 1DS 장초 조건 연구</a>
  <a href="/one-day-surge-entry-daily-backtest" class="active">📅 1DS 운영 검증</a>
</nav>

<h1>📅 1-Day Surge ENTRY 날짜별 운영형 백테스트</h1>
<div class="subtitle"><strong>D일 후보 → D+1 09:30 ENTRY_CONFIRM → D+1 일봉 outcome 사이클을 날짜별로 simulate</strong></div>
<div class="subtitle" id="meta-line"></div>

<div class="purpose-box">
  조건별 평균이 아니라, 실제 운영처럼 <strong>"매일 후보가 몇 개 뜨고 그중 몇 개가 성공/실패"</strong>를 검증합니다.
  6개 전략(SAFE_REBREAK, BALANCED_REBREAK, LIGHT_REBREAK, CLEAN_REBREAK, RISK_REBREAK 비교용, PREV_HIGH_SPIKE 비교용)을
  날짜별로 추적해서 보드 반영 가능 여부를 판단합니다.
</div>
<div class="warn-box">
  ⚠ 후보 산출은 D일까지의 일봉 데이터만 사용 (look-ahead 금지). D+1 분봉/일봉은 outcome 검증에만 사용.
  진입가 = D+1 09:10 close. 진입 후 high/low/close = D+1 일봉.
</div>

<h2>📊 핵심 요약</h2>
<div class="summary-grid" id="summary-grid"></div>

<h2>🎯 전략별 백테스트 요약</h2>
<table id="t-strategy"><thead><tr>
  <th class="left">전략</th>
  <th>총 후보</th><th>일평균</th><th>0건 일</th><th>10건+ 일</th>
  <th>HIT3</th><th>HIT5</th><th>HIT7</th><th>FAIL3</th><th>FAIL5</th>
  <th>종가&gt;0</th>
  <th>평균 고가</th><th>평균 저가</th><th>평균 종가</th>
  <th>peakBefore</th>
</tr></thead><tbody></tbody></table>

<h2>📅 날짜별 요약 (dayType 분류 포함)</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">
  dayType 분류 = 그날 후보들이 장중 한 번 튀고 빠졌는지(HIT_AND_FADE), 종가까지 유지됐는지(HOLDING), 전반적으로 부진했는지(WEAK), 혼합인지(MIXED).
  HIT5/FAIL5/종가&gt;0 수는 분봉 확보 후보 전체 기준.
</div>
<table id="t-bydate"><thead><tr>
  <th class="left">기준일</th><th class="left">다음날</th><th class="left">dayType</th>
  <th>전체</th><th>분봉</th>
  <th>BAL</th><th>LIGHT</th><th>CLEAN</th><th>SAFE</th><th>RISK</th><th>SPIKE</th>
  <th>HIT5</th><th>FAIL5</th><th>종가&gt;0</th>
  <th>평균 종가</th>
</tr></thead><tbody></tbody></table>

<h2>🌊 날짜 성격 (dayType) 분포 + 전략별 cross-tab</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">
  같은 후보군이라도 그날 시장 분위기에 따라 결과가 갈림. dayType별로 SAFE/BAL/LIGHT/RISK 평균 종가가 어떻게 달라지는지 본다.
  → 1DS를 짧은 익절형으로 써야 하는 날 vs 종가까지 유지해도 되는 날 구분.
</div>
<table id="t-daytype"><thead><tr>
  <th class="left">dayType</th><th>거래일 수</th><th>이벤트 n</th>
  <th>day overall avgClose</th>
  <th>SAFE n / avgClose</th>
  <th>BAL n / avgClose</th>
  <th>LIGHT n / avgClose</th>
  <th>CLEAN n / avgClose</th>
  <th>RISK n / avgClose</th>
  <th>SPIKE n / avgClose</th>
  <th>peakBefore 비율</th>
</tr></thead><tbody></tbody></table>

<h2>⚠ peakBeforeEntry 영향 (진입 전 고점이 이미 발생했는지)</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;">
  peakBeforeEntry=true 면 D+1 일봉 high가 09:00~09:10 안에서 발생한 후라 09:10 진입 시점엔 이미 고점 후. 추격 위험 신호.
</div>
<table id="t-peakbefore"><thead><tr>
  <th class="left">구분</th><th>n</th>
  <th>HIT5</th><th>FAIL5</th><th>종가&gt;0</th><th>평균 진입후 종가</th>
</tr></thead><tbody></tbody></table>

<h2>🚀 고위험 급등 가능 후보 (MOM-RISK + GAP_HOLD + PREV_HIGH_SPIKE)</h2>
<div class="muted" style="font-size:11px;margin-bottom:6px;" id="highrisk-interpretation"></div>
<table id="t-highrisk-bucket"><thead><tr>
  <th class="left">버킷</th><th>n</th>
  <th>HIT5</th><th>FAIL5</th><th>종가&gt;0</th><th>평균 고가</th><th>평균 종가</th>
</tr></thead><tbody></tbody></table>

<h3>📈 +15% 이상 큰 상승 사례 (top 15)</h3>
<details class="section" open><summary>펼쳐서 보기</summary><div class="section-body">
<table id="t-highrisk-bigwin"><thead><tr>
  <th class="left">종목</th><th class="left">코드</th>
  <th class="left">기준일</th><th class="left">다음날</th>
  <th class="left">그룹</th><th class="left">캔들</th>
  <th>gap%</th><th>mh</th><th>ph</th><th>pBE</th>
  <th>고가%</th><th>저가%</th><th>종가%</th>
</tr></thead><tbody></tbody></table>
</div></details>

<h2>📋 날짜별 상세 (각 후보의 전략 매칭)</h2>
<div id="bydate-detail"></div>

<h2>🏆 가장 좋은 날 TOP 5 / 가장 나쁜 날 TOP 5</h2>
<div style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px;">
  <div>
    <h3>좋은 날 TOP 5</h3>
    <table id="t-best"><thead><tr>
      <th class="left">기준일</th><th class="left">다음날</th>
      <th>전체 n</th><th>SAFE n</th><th>평균 종가</th><th class="left">기준</th>
    </tr></thead><tbody></tbody></table>
  </div>
  <div>
    <h3>나쁜 날 TOP 5</h3>
    <table id="t-worst"><thead><tr>
      <th class="left">기준일</th><th class="left">다음날</th>
      <th>전체 n</th><th>SAFE n</th><th>평균 종가</th><th class="left">기준</th>
    </tr></thead><tbody></tbody></table>
  </div>
</div>

<h2>🧠 자동 결론</h2>
<div id="auto-conclusion"></div>

<script>
const DATA = __JSON_DATA__;
function isNum(v) { return v != null && Number.isFinite(v); }
function fmtRate(v, p) { return isNum(v) ? v.toFixed(p || 1) + '%' : '-'; }
function fmtPct(v, p) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(p || 2) + '%' : '-'; }
function fmtNum(v) { return isNum(v) ? Math.round(v).toLocaleString() : '-'; }
function fmtFloat(v, p) { return isNum(v) ? v.toFixed(p || 1) : '-'; }
function fmtDate(d) { if (!d || String(d).length !== 8) return d || '-'; const s=String(d); return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8); }
function chip(s) {
  const m = { BALANCED_REBREAK: 'chip-balanced', LIGHT_REBREAK: 'chip-light', CLEAN_REBREAK: 'chip-clean', SAFE_REBREAK: 'chip-safe', RISK_REBREAK: 'chip-risk', PREV_HIGH_SPIKE: 'chip-spike' };
  const lab = { BALANCED_REBREAK: 'BAL', LIGHT_REBREAK: 'LIGHT', CLEAN_REBREAK: 'CLEAN', SAFE_REBREAK: 'SAFE', RISK_REBREAK: 'RISK', PREV_HIGH_SPIKE: 'SPIKE' };
  return '<span class="chip ' + (m[s] || '') + '">' + (lab[s] || s) + '</span>';
}

document.getElementById('meta-line').innerHTML =
  '윈도우: <strong>' + (DATA.meta.windowFromFmt || '-') + ' ~ ' + (DATA.meta.windowToFmt || '-') + '</strong> (' + DATA.meta.windowDays + '거래일, ' + DATA.meta.totalDays + '일 데이터)' +
  ' · 그룹: ' + DATA.meta.groupsFilter.join(', ') +
  ' · 후보 ' + DATA.meta.candidateEvents +
  ' · 분봉 확보 <strong>' + DATA.meta.withMinuteData + ' (' + (DATA.meta.minuteCoverage||0).toFixed(1) + '%)</strong>' +
  ' · 처리시간 ' + ((DATA.meta.elapsedMs||0)/1000).toFixed(1) + 's';

(function() {
  const safe = DATA.strategySummary?.SAFE_REBREAK || {};
  const bal  = DATA.strategySummary?.BALANCED_REBREAK || {};
  const light= DATA.strategySummary?.LIGHT_REBREAK || {};
  const cells = [
    { lab: '백테스트 윈도우', val: DATA.meta.totalDays + '일', sub: DATA.meta.windowFromFmt + ' ~ ' + DATA.meta.windowToFmt },
    { lab: '전체 GT 후보', val: fmtNum(DATA.meta.candidateEvents), sub: '분봉 확보 ' + DATA.meta.withMinuteData + ' (' + (DATA.meta.minuteCoverage||0).toFixed(1) + '%)' },
    { lab: 'SAFE 일평균', val: (safe.dailyAvg||0).toFixed(1) + '건/일', sub: '0건 ' + (safe.zeroDays||0) + '/' + DATA.meta.totalDays + '일' },
    { lab: 'SAFE HIT5', val: fmtRate(safe.summary?.hit5Rate), sub: 'fail5 ' + fmtRate(safe.summary?.fail5Rate) },
    { lab: 'SAFE 종가>0', val: fmtRate(safe.summary?.closePositiveRate), sub: '평균종가 ' + fmtPct(safe.summary?.avgAfterClose) },
    { lab: 'BAL 일평균', val: (bal.dailyAvg||0).toFixed(1) + '건/일', sub: '종가>0 ' + fmtRate(bal.summary?.closePositiveRate) },
    { lab: 'LIGHT 일평균', val: (light.dailyAvg||0).toFixed(1) + '건/일', sub: '종가>0 ' + fmtRate(light.summary?.closePositiveRate) },
    { lab: '보드 반영', val: DATA.autoConclusion?.boardReadiness?.boardReady ? '✅ 가능' : '⏸ 대기', sub: (DATA.autoConclusion?.topShelfCandidates||[]).length + '개 전략 통과' },
  ];
  document.getElementById('summary-grid').innerHTML = cells.map(c =>
    '<div class="summary-cell"><div class="label">' + c.lab + '</div><div class="value">' + c.val + '</div><div class="sub">' + c.sub + '</div></div>'
  ).join('');
})();

(function() {
  const tb = document.querySelector('#t-strategy tbody');
  const rows = [];
  for (const [name, info] of Object.entries(DATA.strategySummary || {})) {
    const s = info.summary || {};
    rows.push('<tr>' +
      '<td class="left"><strong>' + name + '</strong><br><span class="muted" style="font-size:10px;">' + (info.label||'') + '</span></td>' +
      '<td>' + fmtNum(info.totalCandidates) + '</td>' +
      '<td>' + (info.dailyAvg||0).toFixed(1) + '</td>' +
      '<td>' + info.zeroDays + '/' + info.totalDays + '</td>' +
      '<td>' + (info.heavyDays||0) + '</td>' +
      '<td>' + fmtRate(s.hit3Rate) + '</td>' +
      '<td><strong>' + fmtRate(s.hit5Rate) + '</strong></td>' +
      '<td>' + fmtRate(s.hit7Rate) + '</td>' +
      '<td>' + fmtRate(s.fail3Rate) + '</td>' +
      '<td class="' + (isNum(s.fail5Rate) && s.fail5Rate >= 50 ? 'neg' : '') + '">' + fmtRate(s.fail5Rate) + '</td>' +
      '<td><strong>' + fmtRate(s.closePositiveRate) + '</strong></td>' +
      '<td>' + fmtPct(s.avgAfterHigh) + '</td>' +
      '<td>' + fmtPct(s.avgAfterLow) + '</td>' +
      '<td class="' + (isNum(s.avgAfterClose) && s.avgAfterClose > 0 ? 'pos' : 'neg') + '"><strong>' + fmtPct(s.avgAfterClose) + '</strong></td>' +
      '<td class="muted">' + fmtRate(s.peakBeforeEntryRate) + '</td>' +
    '</tr>');
  }
  tb.innerHTML = rows.join('');
})();

function dayTypeChipHtml(dt) {
  const labels = (DATA.dayTypeAnalysis && DATA.dayTypeAnalysis.labels) || {};
  const cls = {
    HIT_AND_FADE_DAY: 'background:#1e3a8a;color:#bfdbfe;border-color:#3b82f6;',
    HOLDING_DAY:      'background:#064e3b;color:#6ee7b7;border-color:#10b981;',
    WEAK_DAY:         'background:#7f1d1d;color:#fca5a5;border-color:#ef4444;',
    MIXED_DAY:        'background:#1e293b;color:#cbd5e1;border-color:#475569;',
  };
  return '<span class="chip" style="' + (cls[dt] || cls.MIXED_DAY) + '" title="' + (labels[dt] || dt) + '">' + dt + '</span>';
}

(function() {
  const tb = document.querySelector('#t-bydate tbody');
  const rows = [];
  for (const r of (DATA.byDateDetail || [])) {
    const ds = r.daySummary || {};
    rows.push('<tr>' +
      '<td class="left">' + r.dateFmt + '</td>' +
      '<td class="left">' + (r.nextDateFmt||'-') + '</td>' +
      '<td class="left">' + dayTypeChipHtml(r.dayType) + '</td>' +
      '<td>' + r.totalCandidates + '</td>' +
      '<td>' + r.withMinute + '</td>' +
      '<td>' + r.strategyCounts.BALANCED_REBREAK + '</td>' +
      '<td>' + r.strategyCounts.LIGHT_REBREAK + '</td>' +
      '<td>' + r.strategyCounts.CLEAN_REBREAK + '</td>' +
      '<td><strong>' + r.strategyCounts.SAFE_REBREAK + '</strong></td>' +
      '<td>' + r.strategyCounts.RISK_REBREAK + '</td>' +
      '<td>' + r.strategyCounts.PREV_HIGH_SPIKE + '</td>' +
      '<td>' + (ds.hit5||0) + '</td>' +
      '<td>' + (ds.fail5||0) + '</td>' +
      '<td>' + (ds.closePositive||0) + '</td>' +
      '<td class="' + (isNum(ds.avgAfterClose) && ds.avgAfterClose > 0 ? 'pos' : 'neg') + '">' + fmtPct(ds.avgAfterClose) + '</td>' +
    '</tr>');
  }
  tb.innerHTML = rows.join('');
})();

// ── dayType cross-tab ──
(function() {
  const tb = document.querySelector('#t-daytype tbody');
  if (!tb) return;
  const dta = DATA.dayTypeAnalysis || {};
  const rows = [];
  function cellAvg(s) {
    if (!s || !s.count) return '<span class="muted">-</span>';
    const n = s.count;
    const ac = s.avgAfterClose;
    const cls = isNum(ac) ? (ac > 0 ? 'pos' : 'neg') : '';
    return '<strong>' + n + '</strong> / <span class="' + cls + '">' + fmtPct(ac) + '</span>';
  }
  const order = ['HIT_AND_FADE_DAY', 'HOLDING_DAY', 'WEAK_DAY', 'MIXED_DAY'];
  for (const dt of order) {
    const info = (dta.byStrategy && dta.byStrategy[dt]) || {};
    const ov = info.overall || {};
    if ((info.dayCount || 0) === 0) continue;
    const peakRate = (DATA.peakBeforeAnalysis && DATA.peakBeforeAnalysis.byDayType && DATA.peakBeforeAnalysis.byDayType[dt]) || {};
    const bs = info.byStrategy || {};
    rows.push('<tr>' +
      '<td class="left">' + dayTypeChipHtml(dt) + '<br><span class="muted" style="font-size:10px;">' + (dta.descriptions && dta.descriptions[dt] || '') + '</span></td>' +
      '<td>' + info.dayCount + '</td>' +
      '<td>' + info.eventCount + '</td>' +
      '<td class="' + (isNum(ov.avgAfterClose) && ov.avgAfterClose > 0 ? 'pos' : 'neg') + '"><strong>' + fmtPct(ov.avgAfterClose) + '</strong> (종가>0 ' + fmtRate(ov.closePositiveRate) + ')</td>' +
      '<td>' + cellAvg(bs.SAFE_REBREAK) + '</td>' +
      '<td>' + cellAvg(bs.BALANCED_REBREAK) + '</td>' +
      '<td>' + cellAvg(bs.LIGHT_REBREAK) + '</td>' +
      '<td>' + cellAvg(bs.CLEAN_REBREAK) + '</td>' +
      '<td>' + cellAvg(bs.RISK_REBREAK) + '</td>' +
      '<td>' + cellAvg(bs.PREV_HIGH_SPIKE) + '</td>' +
      '<td class="' + (isNum(peakRate.peakBeforeRate) && peakRate.peakBeforeRate >= 50 ? 'neg' : '') + '">' + fmtRate(peakRate.peakBeforeRate) + ' <span class="muted">(' + (peakRate.peakBeforeCount || 0) + '/' + (peakRate.n || 0) + ')</span></td>' +
    '</tr>');
  }
  tb.innerHTML = rows.join('') || '<tr><td class="muted left" colspan="11">데이터 없음</td></tr>';
})();

// ── peakBeforeEntry 영향 ──
(function() {
  const tb = document.querySelector('#t-peakbefore tbody');
  if (!tb) return;
  const a = DATA.peakBeforeAnalysis || {};
  const rows = [];
  function row(label, x, isWarn) {
    if (!x || !x.count) return '<tr><td class="left">' + label + '</td><td colspan="5" class="muted">데이터 없음</td></tr>';
    return '<tr>' +
      '<td class="left">' + label + '</td>' +
      '<td>' + x.count + '</td>' +
      '<td>' + fmtRate(x.hit5Rate) + '</td>' +
      '<td class="' + (isWarn ? 'neg' : '') + '">' + fmtRate(x.fail5Rate) + '</td>' +
      '<td>' + fmtRate(x.closePositiveRate) + '</td>' +
      '<td class="' + (isNum(x.avgAfterClose) && x.avgAfterClose > 0 ? 'pos' : 'neg') + '"><strong>' + fmtPct(x.avgAfterClose) + '</strong></td>' +
    '</tr>';
  }
  rows.push(row('진입 전 고점 발생 (peakBeforeEntry=true) — 추격 위험', a.withPeak, true));
  rows.push(row('진입 후 고점 발생 (peakBeforeEntry=false) — 정상', a.withoutPeak, false));
  tb.innerHTML = rows.join('');
})();

// ── 고위험 급등 가능 후보 ──
(function() {
  const root = document.getElementById('highrisk-interpretation');
  if (root) root.innerHTML = '<strong>해석:</strong> ' + ((DATA.highRiskAnalysis && DATA.highRiskAnalysis.interpretation) || '');
  const tb = document.querySelector('#t-highrisk-bucket tbody');
  if (tb) {
    const b = (DATA.highRiskAnalysis && DATA.highRiskAnalysis.buckets) || {};
    const overall = (DATA.highRiskAnalysis && DATA.highRiskAnalysis.overall) || {};
    function row(label, x) {
      if (!x || !x.count) return '<tr><td class="left">' + label + '</td><td colspan="6" class="muted">데이터 없음</td></tr>';
      return '<tr>' +
        '<td class="left"><strong>' + label + '</strong></td>' +
        '<td>' + x.count + '</td>' +
        '<td>' + fmtRate(x.hit5Rate) + '</td>' +
        '<td class="neg">' + fmtRate(x.fail5Rate) + '</td>' +
        '<td>' + fmtRate(x.closePositiveRate) + '</td>' +
        '<td>' + fmtPct(x.avgAfterHigh) + '</td>' +
        '<td class="' + (isNum(x.avgAfterClose) && x.avgAfterClose > 0 ? 'pos' : 'neg') + '">' + fmtPct(x.avgAfterClose) + '</td>' +
      '</tr>';
    }
    tb.innerHTML = [
      row('전체 고위험 통합 (MOM-RISK ∪ GAP_HOLD ∪ PREV_HIGH_SPIKE)', overall),
      row('MOM-RISK', b.momRisk),
      row('GAP_HOLD candleType', b.gapHold),
      row('PREV_HIGH_SPIKE 단독', b.prevHighSpike),
    ].join('');
  }

  const tbBig = document.querySelector('#t-highrisk-bigwin tbody');
  if (tbBig) {
    const list = (DATA.highRiskAnalysis && DATA.highRiskAnalysis.bigGains) || [];
    if (!list.length) {
      tbBig.innerHTML = '<tr><td class="muted left" colspan="13">+15% 이상 급등 사례 없음</td></tr>';
    } else {
      tbBig.innerHTML = list.map(e => '<tr>' +
        '<td class="left">' + (e.name||'-') + '</td>' +
        '<td class="left muted">' + (e.code||'-') + '</td>' +
        '<td class="left">' + fmtDate(e.baseDate) + '</td>' +
        '<td class="left">' + (e.nextDate||'-') + '</td>' +
        '<td class="left">' + (e.gtGroup||'-') + '</td>' +
        '<td class="left muted">' + (e.candleType||'-') + '</td>' +
        '<td>' + fmtPct(e.gapRate, 1) + '</td>' +
        '<td>' + (e.morningHigh ? '<span class="pos">✓</span>' : '·') + '</td>' +
        '<td>' + (e.prevHigh ? '<span class="neg">✓</span>' : '·') + '</td>' +
        '<td>' + (e.peakBeforeEntry ? '<span class="neg">Y</span>' : '·') + '</td>' +
        '<td class="pos"><strong>' + fmtPct(e.afterEntryHighRate, 1) + '</strong></td>' +
        '<td class="' + (isNum(e.afterEntryLowRate) && e.afterEntryLowRate <= -3 ? 'neg' : '') + '">' + fmtPct(e.afterEntryLowRate, 1) + '</td>' +
        '<td class="' + (isNum(e.afterEntryCloseRate) && e.afterEntryCloseRate > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.afterEntryCloseRate, 1) + '</td>' +
      '</tr>').join('');
    }
  }
})();

(function() {
  const root = document.getElementById('bydate-detail');
  const html = [];
  for (const r of (DATA.byDateDetail || [])) {
    if (!r.events || r.events.length === 0) continue;
    const totalSafe = r.strategyCounts.SAFE_REBREAK;
    const headSummary = '<span class="muted" style="font-weight:400;">전체 ' + r.events.length + '건 · SAFE ' + totalSafe + '건 · BAL ' + r.strategyCounts.BALANCED_REBREAK + ' · LIGHT ' + r.strategyCounts.LIGHT_REBREAK + ' · CLEAN ' + r.strategyCounts.CLEAN_REBREAK + ' · RISK ' + r.strategyCounts.RISK_REBREAK + ' · SPIKE ' + r.strategyCounts.PREV_HIGH_SPIKE + '</span>';
    const isOpen = totalSafe > 0; // SAFE 후보 있는 날만 펼침
    const evRows = ['<div class="event-row head"><div>종목 (코드)</div><div>그룹</div><div>gap%</div><div>mh</div><div>ph</div><div>고가%</div><div>저가%</div><div>종가% / hit·fail · 전략</div></div>'];
    for (const e of r.events) {
      evRows.push('<div class="event-row">' +
        '<div>' + (e.name||'-') + ' <span class="muted">' + (e.code||'') + '</span></div>' +
        '<div class="muted" style="font-size:10px;">' + (e.gtGroup||'') + (e.candleType ? ' / ' + e.candleType : '') + '</div>' +
        '<div>' + fmtPct(e.gapRate, 1) + '</div>' +
        '<div>' + (e.morningHigh ? '<span class="pos">✓</span>' : '·') + '</div>' +
        '<div>' + (e.prevHigh ? '<span class="neg">✓</span>' : '·') + '</div>' +
        '<div>' + fmtPct(e.afterEntryHighRate, 1) + '</div>' +
        '<div class="' + (isNum(e.afterEntryLowRate) && e.afterEntryLowRate <= -3 ? 'neg' : '') + '">' + fmtPct(e.afterEntryLowRate, 1) + '</div>' +
        '<div><span class="' + (isNum(e.afterEntryCloseRate) && e.afterEntryCloseRate > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.afterEntryCloseRate, 1) + '</span> ' +
          (e.hit5 ? '<span class="chip" style="background:#064e3b;color:#6ee7b7;">H5</span>' : '') +
          (e.fail5 ? '<span class="chip" style="background:#7c2d12;color:#fdba74;">F5</span>' : '') +
          ' ' + (e.strategies||[]).map(chip).join('') + '</div>' +
      '</div>');
    }
    html.push('<details class="section"' + (isOpen ? ' open' : '') + '><summary>' + r.dateFmt + ' → ' + (r.nextDateFmt||'-') + ' &nbsp;&nbsp; ' + headSummary + '</summary><div class="section-body">' + evRows.join('') + '</div></details>');
  }
  root.innerHTML = html.join('') || '<div class="callout warn">날짜 detail 데이터 없음</div>';
})();

(function() {
  function fillDays(tb, days) {
    const rows = (days||[]).map(d => '<tr>' +
      '<td class="left">' + d.dateFmt + '</td>' +
      '<td class="left">' + (d.nextDateFmt||'-') + '</td>' +
      '<td>' + d.totalN + '</td>' +
      '<td>' + d.safeN + '</td>' +
      '<td class="' + (d.avgClose > 0 ? 'pos' : 'neg') + '"><strong>' + fmtPct(d.avgClose, 2) + '</strong></td>' +
      '<td class="left muted" style="font-size:10px;">' + (d.basedOn||'-') + '</td>' +
    '</tr>');
    tb.innerHTML = rows.join('') || '<tr><td colspan="6" class="muted left">데이터 없음</td></tr>';
  }
  fillDays(document.querySelector('#t-best tbody'), DATA.bestDays);
  fillDays(document.querySelector('#t-worst tbody'), DATA.worstDays);
})();

(function() {
  const c = DATA.autoConclusion || {};
  const html = [];
  // 1) operational viability
  if (c.operationalViability) {
    const v = c.operationalViability;
    html.push('<div class="callout"><strong>① 실제 운영 가능한 후보 수</strong><br>' +
      '• SAFE: 일평균 ' + v.SAFE_REBREAK.dailyAvg.toFixed(1) + '건, 0건 ' + v.SAFE_REBREAK.zeroDays + '/' + v.SAFE_REBREAK.totalDays + '일<br>' +
      '• BALANCED: 일평균 ' + v.BALANCED_REBREAK.dailyAvg.toFixed(1) + '건, 0건 ' + v.BALANCED_REBREAK.zeroDays + '일<br>' +
      '• LIGHT: 일평균 ' + v.LIGHT_REBREAK.dailyAvg.toFixed(1) + '건, 0건 ' + v.LIGHT_REBREAK.zeroDays + '일<br>' +
      '<span class="muted">' + v.note + '</span></div>');
  }
  // 2) best
  if (c.bestStrategy) {
    const b = c.bestStrategy;
    html.push('<div class="callout success"><strong>② 가장 좋은 전략</strong> (closePos − fail5 × 0.5 score 기준)<br>' +
      b.name + ' (' + b.label + ')<br>' +
      'n=' + b.n + ', 일평균 ' + b.dailyAvg.toFixed(1) + '건, hit5 ' + (b.hit5||0).toFixed(1) + '% / fail5 ' + (b.fail5||0).toFixed(1) + '% / 종가>0 ' + (b.closePos||0).toFixed(1) + '% / 평균종가 ' + (b.avgClose>0?'+':'') + (b.avgClose||0).toFixed(2) + '%</div>');
  }
  // 3) all ranked
  if ((c.allStrategiesRanked||[]).length) {
    html.push('<div class="callout"><strong>③ 전략 랭킹</strong><br>' +
      c.allStrategiesRanked.map((r, i) => (i+1) + '. ' + r.name + ' (n=' + r.n + ', 일평균 ' + r.dailyAvg.toFixed(1) + ') · 종가>0 ' + (r.closePos||0).toFixed(1) + '% / fail5 ' + (r.fail5||0).toFixed(1) + '% / 평균종가 ' + (r.avgClose>0?'+':'') + (r.avgClose||0).toFixed(2) + '% / score ' + r.score.toFixed(1)).join('<br>') + '</div>');
  }
  // 4) spike strategies
  if ((c.spikeStrategies||[]).length) {
    html.push('<div class="callout warn"><strong>④ HIT5 높지만 FAIL5도 높음 (spike 위험)</strong><br>' +
      c.spikeStrategies.map(r => r.name + ' — hit5 ' + (r.hit5||0).toFixed(1) + '% / fail5 ' + (r.fail5||0).toFixed(1) + '% / 종가>0 ' + (r.closePos||0).toFixed(1) + '% / 평균종가 ' + (r.avgClose>0?'+':'') + (r.avgClose||0).toFixed(2) + '%').join('<br>') + '</div>');
  }
  // 5) top shelf
  if ((c.topShelfCandidates||[]).length) {
    html.push('<div class="callout success"><strong>⑤ 보드 상단 후보</strong> (종가>0 ≥55% + 평균종가>0 + 일평균≥0.5건)<br>' +
      c.topShelfCandidates.join(', ') + '</div>');
  } else {
    html.push('<div class="callout warn"><strong>⑤ 보드 상단 후보</strong><br>아직 기준 통과한 전략 없음 — 추가 표본/조건 튜닝 필요</div>');
  }
  // 5.1) 최근 거래일 dayType
  if (c.latestDayType) {
    const lt = c.latestDayType;
    const cls = lt.dayType === 'HOLDING_DAY' ? 'success' : (lt.dayType === 'WEAK_DAY' ? 'warn' : '');
    html.push('<div class="callout ' + cls + '"><strong>🕒 최근 거래일 분류 — ' + lt.date + ' → ' + lt.nextDate + '</strong><br>' +
      'dayType: <strong>' + lt.dayType + '</strong> · hit5 ' + (lt.hit5||0).toFixed(1) + '% / 종가>0 ' + (lt.closePos||0).toFixed(1) + '% / 평균종가 ' + (lt.avgClose>0?'+':'') + (lt.avgClose||0).toFixed(2) + '% (n=' + lt.eventCount + ')<br>' +
      (lt.safeOnDay && lt.safeOnDay.count > 0 ? '오늘 SAFE_REBREAK 통과 ' + lt.safeOnDay.count + '건 평균종가 ' + (lt.safeOnDay.avgAfterClose>0?'+':'') + (lt.safeOnDay.avgAfterClose||0).toFixed(2) + '%' : 'SAFE_REBREAK 통과 0건') +
    '</div>');
  }
  // 5.2) dayType 분포
  if ((c.dayTypeDistribution||[]).length) {
    html.push('<div class="callout"><strong>🌊 dayType 분포 (' + (DATA.meta.totalDays||0) + '일)</strong><br>' +
      c.dayTypeDistribution.map(d => '• ' + d.dayType + ': ' + d.count + '일 (' + d.pct.toFixed(1) + '%)').join('<br>') +
    '</div>');
  }
  // 5.3) dayType별 SAFE/BAL/LIGHT 평균 종가 (어떤 날에 잘 통하는지)
  if ((c.dayTypeStrategyClose||[]).length) {
    html.push('<div class="callout"><strong>📊 dayType별 SAFE/BAL/LIGHT 평균 종가</strong> (1DS 본질: 어떤 날에 종가까지 유지되는가)<br>' +
      c.dayTypeStrategyClose.map(d => '• ' + d.dayType + ' (' + d.dayCount + '일, n=' + d.eventCount + '): ' +
        'SAFE ' + (d.safeN||0) + '/' + (d.safeAvgClose==null?'-':(d.safeAvgClose>0?'+':'')+d.safeAvgClose.toFixed(2)+'%') + ' · ' +
        'BAL ' + (d.balN||0) + '/' + (d.balAvgClose==null?'-':(d.balAvgClose>0?'+':'')+d.balAvgClose.toFixed(2)+'%') + ' · ' +
        'LIGHT ' + (d.lightN||0) + '/' + (d.lightAvgClose==null?'-':(d.lightAvgClose>0?'+':'')+d.lightAvgClose.toFixed(2)+'%')
      ).join('<br>') +
    '</div>');
  }
  // 5.4) peakBeforeEntry 영향
  if (c.peakBeforeEffect) {
    const pe = c.peakBeforeEffect;
    html.push('<div class="callout warn"><strong>⚠ peakBeforeEntry 영향 (강한 추격 주의 신호)</strong><br>' +
      'peakBefore=true (n=' + pe.withPeak.n + '): 평균종가 ' + (pe.withPeak.avgClose>0?'+':'') + (pe.withPeak.avgClose||0).toFixed(2) + '% / 종가>0 ' + (pe.withPeak.closePos||0).toFixed(1) + '%<br>' +
      'peakBefore=false (n=' + pe.withoutPeak.n + '): 평균종가 ' + (pe.withoutPeak.avgClose>0?'+':'') + (pe.withoutPeak.avgClose||0).toFixed(2) + '% / 종가>0 ' + (pe.withoutPeak.closePos||0).toFixed(1) + '%<br>' +
      '차이: 평균종가 ' + (pe.avgCloseLift>0?'+':'') + pe.avgCloseLift.toFixed(2) + 'pp / 종가>0 ' + (pe.closePositiveLift>0?'+':'') + pe.closePositiveLift.toFixed(1) + 'pp — peakBefore=true는 09:10 진입 시점에 이미 고점 후. 카드에 명시 권고.' +
    '</div>');
  }
  // 5.5) 고위험 급등 가능 후보 메시지
  if (c.highRiskMessage) {
    const hr = c.highRiskMessage;
    html.push('<div class="callout warn"><strong>🚀 고위험 급등 가능 후보</strong> (MOM-RISK + GAP_HOLD + PREV_HIGH_SPIKE)<br>' +
      '평균: 종가>0 ' + (hr.overall.closePos||0).toFixed(1) + '% / 평균종가 ' + (hr.overall.avgClose>0?'+':'') + (hr.overall.avgClose||0).toFixed(2) + '% / 평균 고가 ' + (hr.overall.avgHigh>0?'+':'') + (hr.overall.avgHigh||0).toFixed(2) + '%<br>' +
      '+15% 이상 큰 상승 사례: ' + hr.bigGainsCount + '건' +
      (hr.topGain ? ' (대표: ' + hr.topGain.name + ' ' + (hr.topGain.afterEntryHighRate||0).toFixed(1) + '%, ' + hr.topGain.gtGroup + ')' : '') + '<br>' +
      '<em>' + hr.interpretation + '</em>' +
    '</div>');
  }
  // 6) bottom shelf
  if ((c.bottomShelfCandidates||[]).length) {
    html.push('<div class="callout warn"><strong>⑥ 보드 제외/하단 권고</strong> (종가>0 &lt;45% 또는 평균종가&lt;0)<br>' +
      c.bottomShelfCandidates.join(', ') + '</div>');
  }
  // 7) under-sampled
  if ((c.underSampled||[]).length) {
    html.push('<div class="callout"><strong>⑦ 표본 부족 (n &lt; 20)</strong><br>' +
      c.underSampled.map(r => r.name + ' (n=' + r.n + ')').join(', ') + '</div>');
  }
  // 8) board readiness
  if (c.boardReadiness) {
    html.push('<div class="callout ' + (c.boardReadiness.boardReady ? 'success' : 'warn') + '"><strong>⑧ one-day-surge-board.js 반영 가능 여부</strong><br>' +
      (c.boardReadiness.boardReady ? '✅ 진입 가능' : '⏸ 아직 대기') + '<br>' + c.boardReadiness.note + '</div>');
  }
  // 9) recommendations
  if ((c.recommendations||[]).length) {
    html.push('<div class="callout success"><strong>⑨ 핵심 권고</strong><br>' +
      c.recommendations.map((s, i) => (i+1) + '. ' + s).join('<br>') + '</div>');
  }
  if (!html.length) html.push('<div class="callout warn">자동 결론 산출 실패 — 데이터 확인 필요.</div>');
  document.getElementById('auto-conclusion').innerHTML = html.join('');
})();
</script>
</body>
</html>
`;

if (require.main === module) main();

module.exports = { STRATEGIES };
