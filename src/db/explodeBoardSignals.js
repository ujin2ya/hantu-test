/**
 * 보드 candidate를 funnel 단계별 row 여러 개로 explosion.
 *
 * 정책:
 *   - 기존 saveXxxBoardToDB는 candidate → 1 row (가장 최근 stage)
 *   - 이 모듈은 candidate.raw_json의 *Date 필드를 추출해서 funnel 단계별 row N개
 *     예: QVA2 BREAKOUT_SUCCESS candidate (qva2SignalDate=4/10, vvi2Date=5/3, breakoutDate=5/12)
 *         → 3 rows: (QVA2_NEW, 4/10) + (VVI2_FIRED, 5/3) + (BREAKOUT_SUCCESS, 5/12)
 *   - board_name은 원본 보드 그대로 (시점 추적 유지)
 *   - source_type='CACHE_BACKFILL' 권장 (백필용)
 *   - UNIQUE 키 + ON DUPLICATE KEY UPDATE로 멱등
 *
 * 사용:
 *   const { explodeBoardJson, EXPLOSION_RULES } = require('./explodeBoardSignals');
 *   const rows = explodeBoardJson(boardName, boardJsonData);
 *   await repo.upsertBoardSignals(runId, rows, { sourceType: 'CACHE_BACKFILL' });
 */

function _toYMD(d) {
  if (!d) return null;
  const s = String(d);
  if (/^\d{8}$/.test(s)) return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}
function _num(v) { return (v == null || !Number.isFinite(Number(v))) ? null : Number(v); }
function _get(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}

// ─── 보드별 explosion 규칙 ───────────────────────────────────────────────
// 각 규칙: { kind, dateField (or dateFn), priceField (or priceFn), 또는 condition }
// candidate에서 가져올 가능한 funnel 단계들. 단계가 candidate에 존재하면 row 생성.

const EXPLOSION_RULES = {
  QVA_WATCHLIST: (c) => {
    const rows = [];
    if (c.qvaSignalDate) {
      rows.push({
        signal_kind: 'QVA_NEW',
        signal_date: _toYMD(c.qvaSignalDate),
        signal_price: _num(c.qvaSignalPrice),
        signal_close: _num(c.qvaSignalPrice),
        trading_value: _num(c.qvaSignalTradingValue),
        score: _num(c.watchScore),
        status_label: 'QVA 발생',
      });
    }
    if (c.vviDate) {
      rows.push({
        signal_kind: 'VVI_FIRED',
        signal_date: _toYMD(c.vviDate),
        signal_price: _num(c.vviClose),
        signal_high:  _num(c.vviHigh),
        signal_low:   _num(c.vviLow),
        signal_close: _num(c.vviClose),
        score: _num(c.watchScore),
        status_label: 'VVI2 발화',
      });
    }
    if (c.breakoutDate) {
      const success = !!c.breakoutSuccess;
      rows.push({
        signal_kind: success ? 'BREAKOUT_SUCCESS' : 'FAILED',
        signal_date: _toYMD(c.breakoutDate),
        signal_price: _num(c.breakoutNextClose),
        signal_high:  _num(c.breakoutNextHigh),
        signal_close: _num(c.breakoutNextClose),
        score: _num(c.watchScore),
        status_label: success ? '돌파 성공' : '돌파 실패',
      });
    }
    return rows;
  },

  QVA2_WATCHLIST: (c) => {
    const rows = [];
    if (c.qva2SignalDate) {
      rows.push({
        signal_kind: 'QVA2_NEW',
        signal_date: _toYMD(c.qva2SignalDate),
        signal_price: _num(c.qva2SignalPrice),
        signal_high: _num(c.signals && c.signals.high),
        signal_low:  _num(c.signals && c.signals.low),
        signal_close:_num(c.signals && c.signals.close),
        volume:       _num(c.signals && c.signals.volume),
        trading_value:_num(c.signals && c.signals.value),
        score: _num(c.qva2Score),
        grade: c.qva2Type || c.qva2Grade || null,
        status_label: 'QVA2 발생',
      });
    }
    if (c.vvi2Date) {
      rows.push({
        signal_kind: 'VVI2_FIRED',
        signal_date: _toYMD(c.vvi2Date),
        signal_price: _num(c.vvi2Close || (c.vvi2 && c.vvi2.signals && c.vvi2.signals.signalClose)),
        signal_high:  _num(c.vvi2High),
        score: _num(c.qva2Score),
        grade: c.qva2Type || null,
        status_label: 'VVI2 발화',
      });
    }
    if (c.breakoutDate && c.breakoutInfo) {
      const success = !!c.breakoutInfo.breakoutSuccess;
      rows.push({
        signal_kind: success ? 'BREAKOUT_SUCCESS' : 'FAILED',
        signal_date: _toYMD(c.breakoutDate),
        signal_price: _num(c.breakoutInfo.nextClose),
        signal_high:  _num(c.breakoutInfo.nextHigh),
        signal_close: _num(c.breakoutInfo.nextClose),
        score: _num(c.qva2Score),
        status_label: success ? '돌파 성공' : '돌파 실패',
      });
    }
    return rows;
  },

  QVA2_D5_REBREAK: (c) => {
    const rows = [];
    if (c.qva2SignalDate) rows.push({ signal_kind: 'QVA2_NEW',         signal_date: _toYMD(c.qva2SignalDate), score: _num(c.qva2Score), grade: c.qva2Grade || null, status_label: 'QVA2 발생' });
    if (c.vvi2Date)       rows.push({ signal_kind: 'VVI2_FIRED',       signal_date: _toYMD(c.vvi2Date),       signal_high: _num(c.vvi2High), score: _num(c.qva2Score), status_label: 'VVI2 발화' });
    if (c.breakoutDate)   rows.push({ signal_kind: 'BREAKOUT_SUCCESS', signal_date: _toYMD(c.breakoutDate),   signal_price: _num(c.entryPrice), signal_high: _num(c.breakoutHigh), signal_close: _num(c.breakoutClose), status_label: 'D+0 돌파' });
    if (c.rebreakDate)    rows.push({ signal_kind: 'CLOSE_REBREAK',    signal_date: _toYMD(c.rebreakDate),    signal_close: _num(c.rebreakClose), status_label: 'D+5 안 종가 재돌파' });
    if (c.breachDate)     rows.push({ signal_kind: 'BREACH_NO_RECOVER', signal_date: _toYMD(c.breachDate),    signal_close: _num(c.breachClose), status_label: '진입가 이탈' });
    return rows;
  },

  HGROUP_REBREAK: (c) => {
    const rows = [];
    if (c.breakoutDate) {
      rows.push({
        signal_kind: 'BREAKOUT_SUCCESS',  // H돌파일 자체는 항상 break success
        signal_date: _toYMD(c.breakoutDate),
        signal_price: _num(c.baseClose),
        signal_high:  _num(c.hDayHigh),
        signal_low:   _num(c.hDayLow),
        signal_close: _num(c.baseClose),
        grade: c.vprMain || null,
        status_label: 'H돌파일',
      });
    }
    if (c.firstRebreakDate) {
      rows.push({
        signal_kind: c.everLowBelowBaseClose ? 'CLOSE_REBREAK' : 'CLOSE_REBREAK_NO_BREACH',
        signal_date: _toYMD(c.firstRebreakDate),
        status_label: '재돌파일',
        grade: c.vprMain || null,
      });
    }
    return rows;
  },

  // 다음 3개 보드는 1 candidate = 1 row가 자연 — 기존 adapter 그대로 쓰는 게 정확.
  // explosion 안 한다.
  QVA_VVI_REDEFINED: null,
  QVA2_VVI: null,
  ONE_DAY_SURGE: null,
};

// ─── 보드 JSON 전체를 explode ─────────────────────────────────────────────
// data: 보드 generator가 출력한 result.json 객체
// 결과: row 배열 (board_name, signal_kind, signal_date, stock_code 포함)
function explodeBoardJson(boardName, data) {
  const rule = EXPLOSION_RULES[boardName];
  if (typeof rule !== 'function') return null;  // explosion 미지원 보드는 null (caller가 기존 adapter 사용)

  const asOfDate = _toYMD(_get(data.meta || {}, 'baseDate', 'baseDateFmt', 'analysisDate', 'analysisDateFmt', 'latestTradingDate', 'today'));

  // 모든 candidate 수집 (보드별 위치 다름)
  const candidates = [];
  function collect(arr) {
    if (Array.isArray(arr)) for (const c of arr) if (c && c.code) candidates.push(c);
  }
  // 일반적 위치 시도
  if (data.stages) for (const k of Object.keys(data.stages)) collect(data.stages[k]);
  if (data.byStatus) for (const k of Object.keys(data.byStatus)) collect(data.byStatus[k]);
  if (data.items) collect(data.items);
  if (data.followReactionList) collect(data.followReactionList);
  if (data.visibleGroups) for (const k of Object.keys(data.visibleGroups)) collect(data.visibleGroups[k]);
  if (data.todayNewVvi) collect(data.todayNewVvi);
  if (data.todayNewVvi2) collect(data.todayNewVvi2);
  if (data.attackTopCandidates) collect(data.attackTopCandidates);
  if (data.priorityRanked) {
    collect(data.priorityRanked.topPriority);
    collect(data.priorityRanked.extraPriority);
  }

  // dedupe by code (같은 candidate가 여러 stage list에 중복 들어가 있을 수 있음)
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    unique.push(c);
  }

  // explode
  const rows = [];
  for (const c of unique) {
    const stageRows = rule(c);
    if (!Array.isArray(stageRows)) continue;
    for (const r of stageRows) {
      if (!r.signal_date) continue;
      rows.push({
        board_name: boardName,
        signal_kind: r.signal_kind,
        signal_date: r.signal_date,
        as_of_date: asOfDate,
        stock_code: c.code,
        stock_name: c.name || c.code,
        market: c.market || null,
        signal_price: r.signal_price ?? null,
        signal_open:  r.signal_open  ?? null,
        signal_high:  r.signal_high  ?? null,
        signal_low:   r.signal_low   ?? null,
        signal_close: r.signal_close ?? null,
        volume:        r.volume        ?? null,
        trading_value: r.trading_value ?? null,
        score: r.score ?? null,
        rank_no: null,
        grade: r.grade ?? null,
        status_label: r.status_label ?? null,
        tags_json: r.tags_json ?? null,
        metrics_json: r.metrics_json ?? null,
        raw_json: c,  // 원본 candidate 전체 보존
      });
    }
  }
  return rows;
}

module.exports = { EXPLOSION_RULES, explodeBoardJson };
