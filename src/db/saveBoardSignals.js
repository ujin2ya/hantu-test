/**
 * 보드 JSON → DB 저장 공통 adapter.
 *
 * 핵심 원칙:
 *   - DB 저장 실패는 절대 보드 생성을 깨면 안 된다.
 *   - 모든 함수는 try/catch 안에서 호출. 실패 시 console.warn으로만 로깅.
 *   - 보드별 normalize 함수를 여기서 보관.
 *
 * 사용 (보드 generator 끝부분):
 *   const { saveOneDaySurgeBoardToDB, saveQva2WatchlistBoardToDB } = require('../../src/db/saveBoardSignals');
 *   try { await saveOneDaySurgeBoardToDB(data, { jsonPath, htmlPath }); }
 *   catch (e) { console.warn('[DB] 저장 실패:', e.message); }
 */

const { isEnabled } = require('./mysql');
const repo = require('./boardSignalRepository');

function _toYMD(d) {
  if (!d) return null;
  if (typeof d === 'string') {
    if (/^\d{8}$/.test(d)) return d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8);
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  }
  return null;
}

function _num(v) { return (v == null || !Number.isFinite(Number(v))) ? null : Number(v); }

// ─────────────────────────────────────────────────────────────────────────
// ONE_DAY_SURGE 보드 adapter
//
// 입력: reports/one-day-surge-board-result.json 파싱 결과
// 저장 대상:
//   signal_kind = 'MAIN'         — priorityRanked.topPriority + extraPriority (mainPoolCodes)
//   signal_kind = 'ATTACK_TOP'   — attackTopCandidates (BIG_MONEY_REBREAK)
// ─────────────────────────────────────────────────────────────────────────
function _normalizeOneDaySurgeMain(it, asOfDate) {
  const basePrice = (it.intraday && Number.isFinite(it.intraday.close_0930)) ? it.intraday.close_0930
                  : (it.intraday && Number.isFinite(it.intraday.entryPrice))  ? it.intraday.entryPrice
                  : _num(it.close);
  return {
    board_name: 'ONE_DAY_SURGE',
    signal_kind: 'MAIN',
    signal_date: _toYMD(it.baseDate) || asOfDate,
    as_of_date: asOfDate,
    stock_code: it.code,
    stock_name: it.name || it.code,
    market: it.market || null,
    signal_price: basePrice,
    signal_open:  _num(it.open),
    signal_high:  _num(it.high),
    signal_low:   _num(it.low),
    signal_close: _num(it.close),
    volume: _num(it.volume),
    trading_value: _num(it.valueAmount),
    score: _num(it.oneDaySurgeScore),
    rank_no: _num(it.priorityRank),
    grade: it.gtBand || it.gtGroup || null,
    status_label: it.gtBandLabel || it.entryStatus || null,
    tags_json: {
      attackTags: it.attackTags || [],
      riskTags: it.riskTags || [],
      entryStrategies: it.entryStrategies || [],
      candleType: it.candleType,
    },
    metrics_json: {
      valueRatio: it.valueRatio,
      volumeRatio: it.volumeRatio,
      closePosition: it.closePosition,
      changeRate: it.changeRate,
      gapPct: it.gapPct,
      distFromHigh20: it.distFromHigh20,
      marketCap: it.marketCap,
      dailyValueRank: it.dailyValueRank,
      intraday: it.intraday || null,
    },
    raw_json: it,
  };
}

function _normalizeOneDaySurgeAttackTop(c, asOfDate) {
  return {
    board_name: 'ONE_DAY_SURGE',
    signal_kind: 'ATTACK_TOP',
    signal_date: _toYMD(c.date) || asOfDate,
    as_of_date: asOfDate,
    stock_code: c.code,
    stock_name: c.name || c.code,
    market: c.market || null,
    signal_price: _num(c.decisionPrice),
    signal_open:  _num(c.open0900),
    signal_high:  _num(c.morningHigh),
    signal_low:   null,
    signal_close: _num(c.decisionPrice),
    volume: null,
    trading_value: _num(c.morningValue),
    score: _num(c.attackScore),
    rank_no: _num(c.attackRank),
    grade: c.gtBand || null,
    status_label: c.entryStatusLabel || null,
    tags_json: { attackTags: c.attackTags || [], riskTags: c.riskTags || [] },
    metrics_json: {
      morningValueRank: c.morningValueRank,
      morningValuePercentile: c.morningValuePercentile,
      isTop10Value: c.isTop10Value,
      rebreakMorningHigh: c.rebreakMorningHigh,
      rebreakTime: c.rebreakTime,
      rebreakWithValue: c.rebreakWithValue,
      valueContinueRatio: c.valueContinueRatio,
      valueSecondWaveRatio: c.valueSecondWaveRatio,
      prevClose: c.prevClose,
      gapRate: c.gapRate,
      decisionFromOpen: c.decisionFromOpen,
      pricePositionInMorningRange: c.pricePositionInMorningRange,
    },
    raw_json: c,
  };
}

// mainResult 항목 — 09:30 스냅샷의 survivor1000 / explosiveStable / attackTop의 당일 결과
// signal_kind: SURVIVOR1000 (10시 생존) / EXPLOSIVE_STABLE (조기 포착) / 기존 ATTACK_TOP은 별도 처리
function _normalizeOneDaySurgeMainResult(c, asOfDate, resultDate) {
  const srcMap = { survivor1000: 'SURVIVOR1000', explosiveStable: 'EXPLOSIVE_STABLE', attackTop: 'ATTACK_TOP_RESULT' };
  const signalKind = srcMap[c.basePriceSource] || 'MAIN_RESULT';
  const r = c.dayResult || {};
  // signal_date = mainResult가 측정한 실제 거래일
  // 우선순위: dayResult.resultTargetDate (보드 generator가 직접 잡은 result row의 date)
  //          → resultDate (인자, snapshot/summary 기반)
  //          → asOfDate fallback
  const sigDate = _toYMD(r.resultTargetDate) || _toYMD(resultDate) || asOfDate;
  return {
    board_name: 'ONE_DAY_SURGE',
    signal_kind: signalKind,
    signal_date: sigDate,
    as_of_date: asOfDate,
    stock_code: c.code,
    stock_name: c.name || c.code,
    market: null,
    signal_price: _num(c.basePrice),
    signal_open:  _num(r.dayOpen),
    signal_high:  _num(r.dayHigh ?? c.dayHigh),
    signal_low:   _num(r.dayLow  ?? c.dayLow),
    signal_close: _num(r.dayClose ?? c.dayClose),
    volume: null,
    trading_value: null,
    score: _num(r.dayHighReturn),
    rank_no: null,
    grade: c.basePriceSource || null,
    status_label: r.resultLabel || null,
    tags_json: { resultTags: r.resultTags || [], source: c.basePriceSource },
    metrics_json: {
      // 진입 기준 (09:30 close)
      basePrice: c.basePrice,
      basePriceSource: c.basePriceSource,
      // 전일종가 + 그 대비 % (사용자 화면 표 기준)
      prevClose: c.prevClose,
      prevRefHigh: c.prevRefHigh,
      prevRefLow: c.prevRefLow,
      prevRefClose: c.prevRefClose,
      // 기준가 대비 % (BIG 박스 기준)
      dayHighReturn: r.dayHighReturn,
      dayLowReturn:  r.dayLowReturn,
      dayCloseReturn: r.dayCloseReturn,
      // 일중 시각 (분봉 기준)
      peakTime: c.peakTime,
      troughTime: c.troughTime,
    },
    raw_json: c,
  };
}

async function saveOneDaySurgeBoardToDB(data, opts = {}) {
  if (!isEnabled()) return null;
  if (!data || !data.meta) throw new Error('1DS data.meta missing');
  const asOfDate = _toYMD(data.meta.analysisDate || data.meta.analysisDateFmt);
  if (!asOfDate) throw new Error('1DS analysisDate missing');

  // 후보 수집
  const rows = [];
  const top    = (data.priorityRanked && data.priorityRanked.topPriority)    || [];
  const extra  = (data.priorityRanked && data.priorityRanked.extraPriority)  || [];
  for (const it of [...top, ...extra]) {
    if (!it || !it.code) continue;
    rows.push(_normalizeOneDaySurgeMain(it, asOfDate));
  }
  const attack = data.attackTopCandidates || [];
  for (const c of attack) {
    if (!c || !c.code) continue;
    rows.push(_normalizeOneDaySurgeAttackTop(c, asOfDate));
  }
  // mainResult — 09:30 후보들의 당일 결과 (장 마감 후에만 채워짐)
  const mainResult = (data.todayResultCandidates && data.todayResultCandidates.mainResult) || [];
  // 결과 거래일 = todayResultSummary.targetDate (mainResult가 가리키는 실제 거래일)
  const resultDate = (data.todayResultSummary && data.todayResultSummary.targetDate) || asOfDate;
  for (const c of mainResult) {
    if (!c || !c.code) continue;
    rows.push(_normalizeOneDaySurgeMainResult(c, asOfDate, resultDate));
  }

  const runId = await repo.createBoardRun({
    board_name: 'ONE_DAY_SURGE',
    run_date: new Date().toISOString().slice(0, 10),
    as_of_date: asOfDate,
    source_file: opts.jsonPath || null,
    report_json_path: opts.jsonPath || null,
    report_html_path: opts.htmlPath || null,
    candidate_count: rows.length,
    meta_json: {
      mainCount: top.length + extra.length,
      attackTopCount: attack.length,
      mainResultCount: mainResult.length,
      mainResultDate: resultDate,
      marketState: data.marketState || null,
      marketStatus: data.marketStatus ? { status: data.marketStatus.status, label: data.marketStatus.label } : null,
    },
  });
  const result = await repo.upsertBoardSignals(runId, rows, { sourceType: opts.sourceType });
  return { runId, ...result, totalRows: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────
// QVA2_WATCHLIST 보드 adapter
//
// 입력: reports/qva2-watchlist-board.json
// 저장 대상: stages.QVA2_NEW / QVA2_TRACKING / VVI2_FIRED / BREAKOUT_SUCCESS / FAILED 각 종목
// ─────────────────────────────────────────────────────────────────────────
function _normalizeQva2Stage(c, stage, asOfDate) {
  // 각 stage의 신호일은 의미가 다름
  let signalDate = null;
  if (stage === 'VVI2_FIRED') {
    signalDate = _toYMD(c.vvi2Date || c.vviDate || c.qva2SignalDate);
  } else if (stage === 'BREAKOUT_SUCCESS') {
    signalDate = _toYMD(c.breakoutDate || c.vvi2Date || c.qva2SignalDate);
  } else {
    // QVA2_NEW / QVA2_TRACKING / FAILED — qva2SignalDate (= qva2 발생일) 기준
    signalDate = _toYMD(c.qva2SignalDate);
  }
  if (!signalDate) signalDate = asOfDate;

  return {
    board_name: 'QVA2_WATCHLIST',
    signal_kind: stage,
    signal_date: signalDate,
    as_of_date: asOfDate,
    stock_code: c.code,
    stock_name: c.name || c.code,
    market: c.market || null,
    signal_price: _num(c.qva2SignalPrice || c.anchorPrice || c.signalPrice),
    signal_open:  null,
    signal_high:  _num(c.signals && c.signals.high),
    signal_low:   _num(c.signals && c.signals.low),
    signal_close: _num(c.signals && c.signals.close),
    volume:        _num(c.signals && c.signals.volume),
    trading_value: _num(c.signals && c.signals.value),
    score: _num(c.qva2Score || c.bestQva2Score),
    rank_no: null,
    grade: c.qva2Grade || c.bestQva2Grade || c.qva2Type || null,
    status_label: c.qva2GradeLabel || c.bestQva2GradeLabel || c.stageReason || null,
    tags_json: { auxTags: c.auxTags || [], qva2Tags: c.qva2Tags || [] },
    metrics_json: {
      qva2Type: c.qva2Type,
      isPreferred: c.isPreferred,
      marketValue: c.marketValue,
      daysSinceFirst: c.daysSinceFirst,
      daysSinceLatest: c.daysSinceLatest,
      currentClose: c.currentClose,
      currentReturnFromSignal: c.currentReturnFromSignal,
      followInfo: c.followInfo || null,
      breakoutInfo: c.breakoutInfo || null,
      vviInfo: c.vviInfo || null,
    },
    raw_json: c,
  };
}

async function saveQva2WatchlistBoardToDB(data, opts = {}) {
  if (!isEnabled()) return null;
  if (!data || !data.meta) throw new Error('QVA2 watchlist data.meta missing');
  const asOfDate = _toYMD(data.meta.baseDate || data.meta.baseDateFmt || data.meta.analysisDate || data.meta.analysisDateFmt || data.meta.todayDate);
  if (!asOfDate) throw new Error('QVA2 watchlist baseDate/analysisDate missing');

  const stages = data.stages || {};
  const stageNames = ['QVA2_NEW', 'QVA2_TRACKING', 'VVI2_FIRED', 'BREAKOUT_SUCCESS', 'FAILED'];

  const rows = [];
  for (const sn of stageNames) {
    const list = stages[sn] || [];
    for (const c of list) {
      if (!c || !c.code) continue;
      rows.push(_normalizeQva2Stage(c, sn, asOfDate));
    }
  }

  const runId = await repo.createBoardRun({
    board_name: 'QVA2_WATCHLIST',
    run_date: new Date().toISOString().slice(0, 10),
    as_of_date: asOfDate,
    source_file: opts.jsonPath || null,
    report_json_path: opts.jsonPath || null,
    report_html_path: opts.htmlPath || null,
    candidate_count: rows.length,
    meta_json: {
      stageCounts: stageNames.reduce((acc, sn) => { acc[sn] = (stages[sn] || []).length; return acc; }, {}),
      trackingDays: data.meta && data.meta.trackingDays,
    },
  });
  const result = await repo.upsertBoardSignals(runId, rows, { sourceType: opts.sourceType });
  return { runId, ...result, totalRows: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────
// QVA_WATCHLIST 보드 adapter (과거 보드, 운영 시간선상에선 retired 됐지만 데이터는 계속 누적)
//
// 입력: qva-watchlist-board.json (ROOT 경로, reports/ 아님)
// 저장 대상 signal_kind:
//   QVA_NEW / QVA_TRACKING / VVI_FIRED / BREAKOUT_SUCCESS / FAILED (공통 shape)
//   LONG_QVA_ALL (다른 shape — D+21~40 장기 추적 후보)
// ─────────────────────────────────────────────────────────────────────────
function _normalizeQvaWatchlistStage(c, stage, asOfDate) {
  // LONG_QVA_ALL은 별도 shape
  if (stage === 'LONG_QVA_ALL') {
    return {
      board_name: 'QVA_WATCHLIST',
      signal_kind: 'LONG_QVA_ALL',
      signal_date: _toYMD(c.firstEarlyQvaDate) || asOfDate,
      as_of_date: asOfDate,
      stock_code: c.code,
      stock_name: c.name || c.code,
      market: c.market || null,
      signal_price: _num(c.anchorPrice),
      signal_open:  null,
      signal_high:  _num(c.signals && c.signals.high),
      signal_low:   _num(c.signals && c.signals.low),
      signal_close: _num(c.signals && c.signals.close),
      volume:        _num(c.signals && c.signals.volume),
      trading_value: _num(c.signals && c.signals.value),
      score: _num(c.bestEarlyQvaScore || c.longQvaReactivationScore),
      rank_no: null,
      grade: c.bestEarlyQvaGrade || c.longQvaTier || null,
      status_label: c.bestEarlyQvaGradeLabel || c.longQvaLabel || null,
      tags_json: { auxTags: c.auxTags || [] },
      metrics_json: {
        marketValue: c.marketValue,
        daysSinceFirst: c.daysSinceFirst,
        currentClose: c.currentClose,
        currentReturnFromSignal: c.currentReturnFromSignal,
        mfeFromSignal: c.mfeFromSignal,
        maeFromSignal: c.maeFromSignal,
        dropFromMfeHigh: c.dropFromMfeHigh,
        daysSinceMfeHigh: c.daysSinceMfeHigh,
        longQvaTier: c.longQvaTier,
        longQvaChecks: c.longQvaChecks,
        longQvaMetrics: c.longQvaMetrics,
        pullbackWait: c.pullbackWait,
        confirmedQvaPass: c.confirmedQvaPass,
      },
      raw_json: c,
    };
  }
  // 공통 funnel stage (QVA_NEW / QVA_TRACKING / VVI_FIRED / BREAKOUT_SUCCESS / FAILED)
  let signalDate = null;
  if (stage === 'VVI_FIRED') signalDate = _toYMD(c.vviDate);
  else if (stage === 'BREAKOUT_SUCCESS') signalDate = _toYMD(c.breakoutDate);
  else signalDate = _toYMD(c.qvaSignalDate);
  if (!signalDate) signalDate = asOfDate;

  return {
    board_name: 'QVA_WATCHLIST',
    signal_kind: stage,
    signal_date: signalDate,
    as_of_date: asOfDate,
    stock_code: c.code,
    stock_name: c.name || c.code,
    market: c.market || null,
    signal_price: _num(c.qvaSignalPrice),
    signal_open:  null,
    signal_high:  _num(c.vviHigh),
    signal_low:   _num(c.vviLow),
    signal_close: _num(c.vviClose || c.qvaSignalPrice),
    volume:        _num(c.currentVolume),
    trading_value: _num(c.qvaSignalTradingValue),
    score: _num(c.watchScore),
    rank_no: null,
    grade: c.vprMain || null,
    status_label: c.vprMainLabel || c.stageReason || null,
    tags_json: { auxTags: c.auxTags || [], vprTags: c.vprTags || [], riskTag: c.riskTag || null },
    metrics_json: {
      marketValue: c.marketValue,
      daysSinceQva: c.daysSinceQva,
      daysSinceVvi: c.daysSinceVvi,
      daysFromBreakout: c.daysFromBreakout,
      currentClose: c.currentClose,
      currentReturnFromSignal: c.currentReturnFromSignal,
      currentReturnFromEntry: c.currentReturnFromEntry,
      judgmentStatus: c.judgmentStatus,
      breakoutEntryPrice1Pct: c.breakoutEntryPrice1Pct,
      breakoutSuccess: c.breakoutSuccess,
      vprMain: c.vprMain,
      vprBaseClose: c.vprBaseClose,
      vprBreakoutLine: c.vprBreakoutLine,
      vprDistanceFromBasePct: c.vprDistanceFromBasePct,
      vprDistanceFromBreakoutPct: c.vprDistanceFromBreakoutPct,
      vprClosePosition: c.vprClosePosition,
      expiringSoon: c.expiringSoon,
    },
    raw_json: c,
  };
}

async function saveQvaWatchlistBoardToDB(data, opts = {}) {
  if (!isEnabled()) return null;
  if (!data || !data.meta) throw new Error('QVA_WATCHLIST data.meta missing');
  const asOfDate = _toYMD(data.meta.latestTradingDate || data.meta.today);
  if (!asOfDate) throw new Error('QVA_WATCHLIST latestTradingDate/today missing');

  const stages = data.stages || {};
  const stageNames = ['QVA_NEW', 'QVA_TRACKING', 'VVI_FIRED', 'BREAKOUT_SUCCESS', 'FAILED'];
  const rows = [];
  for (const sn of stageNames) {
    for (const c of (stages[sn] || [])) {
      if (c && c.code) rows.push(_normalizeQvaWatchlistStage(c, sn, asOfDate));
    }
  }
  // LONG_QVA_ALL (장기 QVA — 별도 shape)
  for (const c of (stages.LONG_QVA_ALL || [])) {
    if (c && c.code) rows.push(_normalizeQvaWatchlistStage(c, 'LONG_QVA_ALL', asOfDate));
  }

  const runId = await repo.createBoardRun({
    board_name: 'QVA_WATCHLIST',
    run_date: new Date().toISOString().slice(0, 10),
    as_of_date: asOfDate,
    source_file: opts.jsonPath || null,
    report_json_path: opts.jsonPath || null,
    report_html_path: opts.htmlPath || null,
    candidate_count: rows.length,
    meta_json: {
      stageCounts: [...stageNames, 'LONG_QVA_ALL'].reduce((a, s) => { a[s] = (stages[s] || []).length; return a; }, {}),
      trackingDays: data.meta && data.meta.trackingDays,
    },
  });
  const result = await repo.upsertBoardSignals(runId, rows, { sourceType: opts.sourceType });
  return { runId, ...result, totalRows: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────
// QVA_VVI_REDEFINED 보드 adapter
//
// 입력: reports/qva-vvi-redefined-board-result.json
// 저장 대상: visibleGroups.{4종} + todayNewVvi
//   signal_kind = candidate.status (CONFIRMED_VVI / NEAR_HIGH / WAITING 등 보드가 부여한 상태)
// ─────────────────────────────────────────────────────────────────────────
function _normalizeQvaVviRedefined(c, asOfDate, kindOverride) {
  return {
    board_name: 'QVA_VVI_REDEFINED',
    signal_kind: kindOverride || c.status || 'UNKNOWN',
    signal_date: _toYMD(c.vviDate) || _toYMD(c.qvaSignalDate) || asOfDate,
    as_of_date: asOfDate,
    stock_code: c.code,
    stock_name: c.name || c.code,
    market: c.market || null,
    signal_price: _num(c.vviClose),
    signal_open:  null,
    signal_high:  _num(c.vviHigh),
    signal_low:   null,
    signal_close: _num(c.vviClose),
    volume:        _num(c.vviVolume),
    trading_value: _num(c.vviValue),
    score: _num(c.vviValueRatio),
    rank_no: null,
    grade: c.qvaStage || null,
    status_label: c.statusLabel || c.displayGroupName || null,
    tags_json: { isMainCandidate: !!c.isMainCandidate, isTodayNewVvi: !!c.isTodayNewVvi },
    metrics_json: {
      marketValue: c.marketValue,
      qvaSignalDate: c.qvaSignalDate,
      qvaHigh: c.qvaHigh, qvaClose: c.qvaClose, qvaVolume: c.qvaVolume, qvaValue: c.qvaValue,
      vviValueRatio: c.vviValueRatio, vviVolumeRatio: c.vviVolumeRatio,
      vviCloseFromQvaCloseRate: c.vviCloseFromQvaCloseRate,
      vviHighFromQvaHighRate: c.vviHighFromQvaHighRate,
      daysFromQvaToVvi: c.daysFromQvaToVvi,
      currentClose: c.currentClose,
      currentFromVviCloseRate: c.currentFromVviCloseRate,
      currentFromQvaCloseRate: c.currentFromQvaCloseRate,
      distanceToQvaHighRate: c.distanceToQvaHighRate,
      next1HighRate: c.next1HighRate, next3HighRate: c.next3HighRate, next5HighRate: c.next5HighRate, next10HighRate: c.next10HighRate,
    },
    raw_json: c,
  };
}

async function saveQvaVviRedefinedBoardToDB(data, opts = {}) {
  if (!isEnabled()) return null;
  if (!data || !data.meta) throw new Error('QVA_VVI_REDEFINED data.meta missing');
  const asOfDate = _toYMD(data.meta.analysisDate || data.meta.analysisDateFmt);
  if (!asOfDate) throw new Error('QVA_VVI_REDEFINED analysisDate missing');

  const rows = [];
  const groups = data.visibleGroups || {};
  for (const groupKey of Object.keys(groups)) {
    for (const c of (groups[groupKey] || [])) {
      if (c && c.code) rows.push(_normalizeQvaVviRedefined(c, asOfDate));
    }
  }
  // todayNewVvi (top-level) — 별도 signal_kind 'TODAY_NEW_VVI' (status 컬럼 중복 가능하니 override)
  for (const c of (data.todayNewVvi || [])) {
    if (c && c.code) rows.push(_normalizeQvaVviRedefined(c, asOfDate, 'TODAY_NEW_VVI'));
  }

  const runId = await repo.createBoardRun({
    board_name: 'QVA_VVI_REDEFINED',
    run_date: new Date().toISOString().slice(0, 10),
    as_of_date: asOfDate,
    source_file: opts.jsonPath || null,
    report_json_path: opts.jsonPath || null,
    report_html_path: opts.htmlPath || null,
    candidate_count: rows.length,
    meta_json: {
      groupCounts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, (v || []).length])),
      todayNewVviCount: (data.todayNewVvi || []).length,
      lookbackDays: data.meta && data.meta.lookbackDays,
    },
  });
  const result = await repo.upsertBoardSignals(runId, rows, { sourceType: opts.sourceType });
  return { runId, ...result, totalRows: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────
// HGROUP_REBREAK 보드 adapter (D+5 재돌파 운용)
//
// 입력: reports/hgroup-rebreak-operation-board-result.json
// 저장 대상: items 배열. signal_kind = c.rebreakStatus
// ─────────────────────────────────────────────────────────────────────────
function _normalizeHgroupRebreak(c, asOfDate) {
  return {
    board_name: 'HGROUP_REBREAK',
    signal_kind: c.rebreakStatus || 'UNKNOWN',
    signal_date: _toYMD(c.breakoutDate) || asOfDate,
    as_of_date: asOfDate,
    stock_code: c.code,
    stock_name: c.name || c.code,
    market: c.market || null,
    signal_price: _num(c.baseClose),
    signal_open:  null,
    signal_high:  _num(c.hDayHigh),
    signal_low:   _num(c.hDayLow),
    signal_close: _num(c.baseClose),
    volume:        null,
    trading_value: null,
    score: null,
    rank_no: null,
    grade: c.vprMain || null,
    status_label: c.rebreakStatusLabel || null,
    tags_json: {
      vprTags: c.vprTags || [],
      flowTags: c.flowTags || [],
      hasVolumeSupport: !!c.hasVolumeSupport,
      everClosedAboveHHigh: !!c.everClosedAboveHHigh,
      everIntradayAboveHHigh: !!c.everIntradayAboveHHigh,
      everLowBelowBaseClose: !!c.everLowBelowBaseClose,
      breakdownEverRecovered: !!c.breakdownEverRecovered,
    },
    metrics_json: {
      daysFromBreakout: c.daysFromBreakout,
      breakoutLine: c.breakoutLine,
      currentClose: c.currentClose,
      distFromBase: c.distFromBase,
      distToHHigh: c.distToHHigh,
      aboveHDayHigh: c.aboveHDayHigh,
      belowBaseClose: c.belowBaseClose,
      gapPct: c.gapPct,
      firstRebreakDate: c.firstRebreakDate,
      firstRebreakDayOffset: c.firstRebreakDayOffset,
      rebreakValueRatio: c.rebreakValueRatio,
      volumeStrength: c.volumeStrength,
      nextDayHoldAfterRebreak: c.nextDayHoldAfterRebreak,
      postRebreakDistPct: c.postRebreakDistPct,
      rebreakDistanceClass: c.rebreakDistanceClass,
      todayChangePct: c.todayChangePct,
      todayHighVsHHighPct: c.todayHighVsHHighPct,
    },
    raw_json: c,
  };
}

async function saveHgroupRebreakBoardToDB(data, opts = {}) {
  if (!isEnabled()) return null;
  if (!data || !data.meta) throw new Error('HGROUP_REBREAK data.meta missing');
  const asOfDate = _toYMD(data.meta.latestTradingDate);
  if (!asOfDate) throw new Error('HGROUP_REBREAK latestTradingDate missing');

  const rows = [];
  for (const c of (data.items || [])) {
    if (c && c.code) rows.push(_normalizeHgroupRebreak(c, asOfDate));
  }

  // status별 카운트 집계
  const statusCounts = {};
  for (const r of rows) statusCounts[r.signal_kind] = (statusCounts[r.signal_kind] || 0) + 1;

  const runId = await repo.createBoardRun({
    board_name: 'HGROUP_REBREAK',
    run_date: new Date().toISOString().slice(0, 10),
    as_of_date: asOfDate,
    source_file: opts.jsonPath || null,
    report_json_path: opts.jsonPath || null,
    report_html_path: opts.htmlPath || null,
    candidate_count: rows.length,
    meta_json: { statusCounts, sourceBoard: data.meta && data.meta.sourceBoard },
  });
  const result = await repo.upsertBoardSignals(runId, rows, { sourceType: opts.sourceType });
  return { runId, ...result, totalRows: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────
// QVA2_VVI 보드 adapter
//
// 입력: reports/qva2-vvi-board.json
// 저장 대상: byStatus.* 8 statuses + todayNewVvi2
//   signal_kind = candidate.status (이미 statuses: VVI2_FIRED, CLOSE_WEAK, VALUE_WEAK, NEAR_HIGH, WAITING, PRICE_ONLY, BROKEN)
// ─────────────────────────────────────────────────────────────────────────
function _normalizeQva2Vvi(c, asOfDate, kindOverride) {
  return {
    board_name: 'QVA2_VVI',
    signal_kind: kindOverride || c.status || 'UNKNOWN',
    signal_date: _toYMD(c.qva2Date) || asOfDate,
    as_of_date: asOfDate,
    stock_code: c.code,
    stock_name: c.name || c.code,
    market: c.market || null,
    signal_price: _num(c.qva2Close),
    signal_open:  null,
    signal_high:  _num(c.qva2High),
    signal_low:   null,
    signal_close: _num(c.qva2Close),
    volume:        _num(c.qva2Volume),
    trading_value: _num(c.qva2Value),
    score: _num(c.qva2Score),
    rank_no: null,
    grade: c.qva2Grade || c.qva2Type || null,
    status_label: c.statusLabel || null,
    tags_json: { isMain: !!c.isMain, qva2Type: c.qva2Type, vviPath: c.vviPath },
    metrics_json: {
      marketValue: c.marketValue,
      vviStats: c.vviStats || null,
      closeWeakInfo: c.closeWeakInfo || null,
      breakBeforeVvi2: !!c.breakBeforeVvi2,
      breakDate: c.breakDate,
      postQvaMaxHigh: c.postQvaMaxHigh,
      currentClose: c.currentClose,
      currentFromQva2ClosePct: c.currentFromQva2ClosePct,
      distanceToQva2HighPct: c.distanceToQva2HighPct,
      priceOnlyDate: c.priceOnlyDate, priceOnlyHigh: c.priceOnlyHigh,
      priceOnlyVolume: c.priceOnlyVolume, priceOnlyValue: c.priceOnlyValue,
      valueWeakDate: c.valueWeakDate,
    },
    raw_json: c,
  };
}

async function saveQva2VviBoardToDB(data, opts = {}) {
  if (!isEnabled()) return null;
  if (!data || !data.meta) throw new Error('QVA2_VVI data.meta missing');
  const asOfDate = _toYMD(data.meta.baseDate || data.meta.baseDateFmt);
  if (!asOfDate) throw new Error('QVA2_VVI baseDate missing');

  const rows = [];
  const byStatus = data.byStatus || {};
  for (const st of Object.keys(byStatus)) {
    for (const c of (byStatus[st] || [])) {
      if (c && c.code) rows.push(_normalizeQva2Vvi(c, asOfDate));
    }
  }
  // todayNewVvi2 (top-level별도 — 'TODAY_NEW_VVI2' override)
  for (const c of (data.todayNewVvi2 || [])) {
    if (c && c.code) rows.push(_normalizeQva2Vvi(c, asOfDate, 'TODAY_NEW_VVI2'));
  }

  const statusCounts = Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, (v || []).length]));
  statusCounts.todayNewVvi2 = (data.todayNewVvi2 || []).length;

  const runId = await repo.createBoardRun({
    board_name: 'QVA2_VVI',
    run_date: new Date().toISOString().slice(0, 10),
    as_of_date: asOfDate,
    source_file: opts.jsonPath || null,
    report_json_path: opts.jsonPath || null,
    report_html_path: opts.htmlPath || null,
    candidate_count: rows.length,
    meta_json: { statusCounts, lookbackDays: data.meta && data.meta.lookbackDays },
  });
  const result = await repo.upsertBoardSignals(runId, rows, { sourceType: opts.sourceType });
  return { runId, ...result, totalRows: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────
// QVA2_D5_REBREAK 보드 adapter
//
// 입력: reports/qva2-d5-rebreak-board.json
// 저장 대상: byStatus.* 5 statuses (CLOSE_REBREAK / TODAY_INITIAL_BREAKOUT / INTRADAY_PUSHBACK / BREACH_NO_RECOVER / NO_REBREAK)
// ─────────────────────────────────────────────────────────────────────────
function _normalizeQva2D5Rebreak(c, asOfDate) {
  return {
    board_name: 'QVA2_D5_REBREAK',
    signal_kind: c.status || 'UNKNOWN',
    signal_date: _toYMD(c.breakoutDate) || asOfDate,
    as_of_date: asOfDate,
    stock_code: c.code,
    stock_name: c.name || c.code,
    market: c.market || null,
    signal_price: _num(c.entryPrice),
    signal_open:  null,
    signal_high:  _num(c.breakoutHigh),
    signal_low:   null,
    signal_close: _num(c.breakoutClose),
    volume:        null,
    trading_value: null,
    score: _num(c.qva2Score),
    rank_no: null,
    grade: c.qva2Grade || null,
    status_label: c.statusLabel || null,
    tags_json: {},
    metrics_json: {
      marketValue: c.marketValue,
      qva2SignalDate: c.qva2SignalDate,
      vvi2Date: c.vvi2Date,
      vvi2High: c.vvi2High,
      daysFromBreakout: c.daysFromBreakout,
      trackingEnd: c.trackingEnd,
      rebreakDate: c.rebreakDate,
      rebreakClose: c.rebreakClose,
      rebreakDayOffset: c.rebreakDayOffset,
      rebreakValueRatio: c.rebreakValueRatio,
      intradayDate: c.intradayDate,
      intradayHigh: c.intradayHigh,
      breachDate: c.breachDate,
      breachClose: c.breachClose,
      recoveredAfterBreach: !!c.recoveredAfterBreach,
      maxHighAfter: c.maxHighAfter,
      maxHighDate: c.maxHighDate,
      currentClose: c.currentClose,
      currentVsBreakoutHighPct: c.currentVsBreakoutHighPct,
      currentVsEntryPct: c.currentVsEntryPct,
      trackedDays: c.trackedDays,
    },
    raw_json: c,
  };
}

async function saveQva2D5RebreakBoardToDB(data, opts = {}) {
  if (!isEnabled()) return null;
  if (!data || !data.meta) throw new Error('QVA2_D5_REBREAK data.meta missing');
  const asOfDate = _toYMD(data.meta.baseDate || data.meta.baseDateFmt);
  if (!asOfDate) throw new Error('QVA2_D5_REBREAK baseDate missing');

  const rows = [];
  const byStatus = data.byStatus || {};
  for (const st of Object.keys(byStatus)) {
    for (const c of (byStatus[st] || [])) {
      if (c && c.code) rows.push(_normalizeQva2D5Rebreak(c, asOfDate));
    }
  }

  const statusCounts = Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, (v || []).length]));

  const runId = await repo.createBoardRun({
    board_name: 'QVA2_D5_REBREAK',
    run_date: new Date().toISOString().slice(0, 10),
    as_of_date: asOfDate,
    source_file: opts.jsonPath || null,
    report_json_path: opts.jsonPath || null,
    report_html_path: opts.htmlPath || null,
    candidate_count: rows.length,
    meta_json: { statusCounts, maxDays: data.meta && data.meta.maxDays },
  });
  const result = await repo.upsertBoardSignals(runId, rows, { sourceType: opts.sourceType });
  return { runId, ...result, totalRows: rows.length };
}

module.exports = {
  saveOneDaySurgeBoardToDB,
  saveQva2WatchlistBoardToDB,
  saveQvaWatchlistBoardToDB,
  saveQvaVviRedefinedBoardToDB,
  saveHgroupRebreakBoardToDB,
  saveQva2VviBoardToDB,
  saveQva2D5RebreakBoardToDB,
};
