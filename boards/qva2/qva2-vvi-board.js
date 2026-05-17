#!/usr/bin/env node
/**
 * QVA2 VVI2 Board — QVA2 신호 후 고가/거래량/거래대금 재돌파 후보 (실험)
 *
 * VVI2 정의:
 *   QVA2 발생일의 (high, volume, value)를 기준으로, 그 이후 첫 번째로 다음을 모두 만족하는 날을 VVI2로 본다:
 *     1) close ≥ qva2Close × (1 + minClosePullback)  (= -5% 이상 무너지지 않음)
 *     2) high  > qva2High
 *     3) volume ≥ qva2Volume
 *     4) value  ≥ qva2Value
 *     5) closeLocation ≥ 0.50 (당일 강한 마감)
 *
 * 입력: reports/qva2-watchlist-board.json (QVA2 신호 list, dedup 종목)
 * 출력: reports/qva2-vvi-board.{json,html}
 * 라우트: GET /qva2-vvi
 *
 * 환경변수:
 *   - VVI2_LOOKBACK_DAYS (기본 30) — QVA2 신호 후 N 거래일 안에서 VVI2 탐색
 *   - VVI2_TOP_LIMIT     (기본 30)
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { findQVA2Events } = require('./qva2-screener');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR    = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST   = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const REPORTS_DIR  = path.join(ROOT, 'reports');
const QVA2_BOARD   = path.join(REPORTS_DIR, 'qva2-watchlist-board.json');
const OUT_JSON     = path.join(REPORTS_DIR, 'qva2-vvi-board.json');
const OUT_HTML     = path.join(REPORTS_DIR, 'qva2-vvi-board.html');

const VVI2_LOOKBACK_DAYS = Number(process.env.VVI2_LOOKBACK_DAYS || 30);
const TOP_LIMIT          = Number(process.env.VVI2_TOP_LIMIT || 30);
const MIN_CLOSE_PULLBACK = -0.05;   // QVA2 종가 대비 -5% 이상 무너졌으면 자격 상실
const MIN_VVI2_CLOSE_LOCATION = 0.50;

function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

function loadMetaMap() {
  if (!fs.existsSync(NAVER_LIST)) return new Map();
  try {
    const j = JSON.parse(fs.readFileSync(NAVER_LIST, 'utf-8'));
    const m = new Map();
    for (const s of (j.stocks || [])) {
      if (!s.code) continue;
      m.set(s.code, { code: s.code, name: s.name, market: s.market, marketValue: s.marketValue || 0, isEtf: !!s.isEtf, isSpecial: !!s.isSpecial });
    }
    return m;
  } catch (_) { return new Map(); }
}

const { filterRowsAsOf } = require('../../src/db/asOfChart');
function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (j && j.rows) j.rows = filterRowsAsOf(j.rows);
    return j;
  } catch (_) { return null; }
}

function loadQva2Signals() {
  if (!fs.existsSync(QVA2_BOARD)) return null;
  try { return JSON.parse(fs.readFileSync(QVA2_BOARD, 'utf-8')); } catch (_) { return null; }
}

/**
 * 한 종목의 QVA2 이벤트들에 대해 VVI2 탐색.
 * qva2Type별로 다른 정의 (qva2-watchlist-board.js의 findVvi2AfterQva2와 통일):
 *   absorption: high > qva2High + vol ≥ qva2Vol + val ≥ qva2Val + closeLoc ≥ 0.5
 *   spike     : close > qva2Close + closeLoc ≥ 0.5 + (valRatio ≥ 2 OR val ≥ qva2Val × 0.8) + (volRatio ≥ 1.5 OR vol ≥ qva2Vol × 0.8)
 *   both      : 둘 중 하나라도 통과
 *
 * 분류 (status):
 *   VVI2_FIRED  : 통과
 *   BROKEN      : qva2Close × 0.95 이탈
 *   CLOSE_WEAK  : high/vol/val은 통과, closeLoc 부족 (마음AI 5/7 같은 케이스)
 *   VALUE_WEAK  : high는 넘었지만 거래대금/거래량 부족
 *   PRICE_ONLY  : 가격만 넘고 그 외 다 부족 (legacy)
 *   NEAR_HIGH   : QVA2 고가 -3% 이내 도달, 미돌파
 *   WAITING     : 아직 기준 돌파 없음
 */
function analyzeVvi2ForEvent(qva2Event, chart) {
  const rows = chart && chart.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const qva2Idx = rows.findIndex(r => r.date === qva2Event.signalDate);
  if (qva2Idx < 0) return null;
  const qva2Row = rows[qva2Idx];
  const qva2High = qva2Row.high, qva2Close = qva2Row.close;
  const qva2Volume = qva2Row.volume || 0, qva2Value = qva2Row.valueApprox || 0;
  if (!qva2High || !qva2Close || qva2Volume <= 0 || qva2Value <= 0) return null;

  const qva2Type = qva2Event.qva2Type || 'absorption';

  // spike 경로용: prev20 median value/volume — 단 매일 갱신 (i 시점 직전 20일).
  // qva2Idx 직전 20일 고정이 아니라 평가일 직전 20일을 봐야 valueRatio/volumeRatio가 정확.
  function medianAt(idx, key) {
    const start = Math.max(0, idx - 20);
    const arr = rows.slice(start, idx).map(r => (key === 'volume' ? (r.volume || 0) : (r.valueApprox || 0)));
    if (arr.length < 10) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    return n % 2 === 0 ? (sorted[n/2 - 1] + sorted[n/2]) / 2 : sorted[Math.floor(n/2)];
  }

  const last = rows[rows.length - 1];
  const lookbackEnd = Math.min(rows.length - 1, qva2Idx + VVI2_LOOKBACK_DAYS);

  let breakBeforeVvi2 = false, breakDate = null;
  let vviRow = null, vviIdx = -1, vviPath = null;       // 'absorption' | 'spike' (성공 경로)
  let closeWeakRow = null, closeWeakIdx = -1;            // high/vol/val 통과 but closeLoc 부족
  let valueWeakRow = null, valueWeakIdx = -1;            // high만 넘고 vol/val 부족
  let priceOnlyRow = null, priceOnlyIdx = -1;            // 어느 path에도 안 잡힌 단순 가격 통과 (드뭄)
  let postQvaMaxHigh = null;

  for (let i = qva2Idx + 1; i <= lookbackEnd; i++) {
    const r = rows[i];
    if (!r || !r.close) continue;
    if (postQvaMaxHigh == null || r.high > postQvaMaxHigh) postQvaMaxHigh = r.high;

    // 자격 상실 (BROKEN) — 공통 우선 적용
    if (r.close < qva2Close * (1 + MIN_CLOSE_PULLBACK)) {
      breakBeforeVvi2 = true;
      breakDate = r.date;
      break;
    }

    const candleRange = r.high - r.low;
    const closeLocation = candleRange > 0 ? (r.close - r.low) / candleRange : 0.5;
    const okClose = closeLocation >= MIN_VVI2_CLOSE_LOCATION;

    // ─── 경로 A: absorption 정의 (high 재돌파) ───
    let absorptionPass = false, absorptionHighOk = false, absorptionValOk = false;
    if (qva2Type === 'absorption' || qva2Type === 'both') {
      absorptionHighOk = r.high > qva2High;
      const okVol = (r.volume || 0) >= qva2Volume;
      const okVal = (r.valueApprox || 0) >= qva2Value;
      absorptionValOk = okVol && okVal;
      absorptionPass = absorptionHighOk && absorptionValOk && okClose;
    }

    // ─── 경로 B: spike 정의 (사용자 spec 통일) ───
    //   close > qva2Close + closeLoc ≥ 0.5
    //   AND (valueRatio ≥ 2.0 OR value ≥ qva2Value × 0.8)
    //   AND (volumeRatio ≥ 1.5 OR volume ≥ qva2Volume × 0.8)
    let spikePass = false;
    if (qva2Type === 'spike' || qva2Type === 'both') {
      const closeOverQva2 = r.close > qva2Close;
      const m20Val = medianAt(i, 'value');
      const m20Vol = medianAt(i, 'volume');
      const valueRatio  = m20Val > 0 ? (r.valueApprox || 0) / m20Val : 0;
      const volumeRatio = m20Vol > 0 ? (r.volume || 0) / m20Vol : 0;
      const valOk = valueRatio >= 2.0 || (r.valueApprox || 0) >= qva2Value * 0.8;
      const volOk = volumeRatio >= 1.5 || (r.volume || 0) >= qva2Volume * 0.8;
      spikePass = closeOverQva2 && okClose && valOk && volOk;
    }

    if (absorptionPass || spikePass) {
      vviRow = r; vviIdx = i;
      vviPath = absorptionPass && spikePass ? 'both' : (absorptionPass ? 'absorption' : 'spike');
      break;
    }

    // 통과는 못 했지만 어느 정도 진입한 케이스 — 분류 기록 (덜 진척한 게 우선 기록)
    if (qva2Type === 'absorption' || qva2Type === 'both') {
      if (absorptionHighOk && absorptionValOk && !okClose && closeWeakRow == null) {
        closeWeakRow = r; closeWeakIdx = i;
      } else if (absorptionHighOk && !absorptionValOk && valueWeakRow == null) {
        valueWeakRow = r; valueWeakIdx = i;
      } else if (absorptionHighOk && priceOnlyRow == null) {
        priceOnlyRow = r; priceOnlyIdx = i;
      }
    }
    if ((qva2Type === 'spike' || qva2Type === 'both') && !absorptionHighOk) {
      // spike 종목에서 close > qva2Close 도달했지만 다른 조건 미달
      if (r.close > qva2Close && !okClose && closeWeakRow == null) {
        closeWeakRow = r; closeWeakIdx = i;
      }
    }
  }

  // 현재 상태
  const currentClose = last.close;
  const currentDate = last.date;
  const currentFromQva2Close = qva2Close > 0 ? ((currentClose / qva2Close) - 1) * 100 : null;
  const distanceToQva2High = qva2High > 0 ? ((qva2High - currentClose) / qva2High) * 100 : null;

  let status, statusLabel, isMain = false;
  if (vviRow) {
    status = 'VVI2_FIRED';
    statusLabel = vviPath === 'spike' ? '재돌파 성공 (VVI2 spike)'
                : vviPath === 'both'  ? '재돌파 성공 (VVI2 both)'
                : '재돌파 성공 (VVI2 absorption)';
    isMain = true;
  } else if (breakBeforeVvi2) {
    status = 'BROKEN';
    statusLabel = 'QVA2 종가 -5% 이탈';
  } else if (closeWeakRow) {
    status = 'CLOSE_WEAK';
    statusLabel = '거래량·거래대금 충족, 종가 위치 부족';
  } else if (valueWeakRow) {
    status = 'VALUE_WEAK';
    statusLabel = '가격 돌파, 거래량/거래대금 부족';
  } else if (priceOnlyRow) {
    status = 'PRICE_ONLY';
    statusLabel = '가격만 돌파';
  } else if (postQvaMaxHigh != null && qva2High > 0 && postQvaMaxHigh / qva2High >= 0.97) {
    status = 'NEAR_HIGH';
    statusLabel = '고가 근처 대기';
  } else {
    status = 'WAITING';
    statusLabel = '재돌파 대기';
  }

  let vviStats = null;
  if (vviRow) {
    const candleRange = vviRow.high - vviRow.low;
    const closeLocation = candleRange > 0 ? (vviRow.close - vviRow.low) / candleRange : 0.5;
    vviStats = {
      vvi2Date: vviRow.date,
      vvi2Close: vviRow.close,
      vvi2High: vviRow.high,
      vvi2Volume: vviRow.volume || 0,
      vvi2Value: vviRow.valueApprox || 0,
      vvi2CloseLocation: +closeLocation.toFixed(3),
      vvi2VolumeRatio: qva2Volume > 0 ? +((vviRow.volume || 0) / qva2Volume).toFixed(2) : null,
      vvi2ValueRatio:  qva2Value  > 0 ? +((vviRow.valueApprox || 0) / qva2Value).toFixed(2) : null,
      vvi2HighFromQva2HighPct: qva2High > 0 ? +(((vviRow.high / qva2High) - 1) * 100).toFixed(2) : null,
      daysFromQva2ToVvi2: vviIdx - qva2Idx,
      currentFromVvi2ClosePct: vviRow.close > 0 ? +(((currentClose / vviRow.close) - 1) * 100).toFixed(2) : null,
    };
  }

  // 가장 최근 weak 분류일의 closeLocation도 같이 (사용자가 "왜 0.499로 missed인가" 같은 borderline 케이스 확인용)
  let closeWeakInfo = null;
  if (closeWeakRow) {
    const cr = closeWeakRow.high - closeWeakRow.low;
    const cl = cr > 0 ? (closeWeakRow.close - closeWeakRow.low) / cr : 0.5;
    closeWeakInfo = {
      date: closeWeakRow.date,
      close: closeWeakRow.close, high: closeWeakRow.high, low: closeWeakRow.low,
      closeLocation: +cl.toFixed(3),
      volumeRatio: qva2Volume > 0 ? +((closeWeakRow.volume || 0) / qva2Volume).toFixed(2) : null,
      valueRatio:  qva2Value  > 0 ? +((closeWeakRow.valueApprox || 0) / qva2Value).toFixed(2)  : null,
    };
  }

  return {
    status, statusLabel, isMain, qva2Type, vviPath,
    qva2Date: qva2Event.signalDate, qva2High, qva2Close, qva2Volume, qva2Value,
    qva2Score: qva2Event.score, qva2Grade: qva2Event.grade,
    vviStats,
    closeWeakInfo,
    valueWeakDate: valueWeakRow ? valueWeakRow.date : null,
    priceOnlyDate: priceOnlyRow ? priceOnlyRow.date : null,
    priceOnlyHigh: priceOnlyRow ? priceOnlyRow.high : null,
    priceOnlyVolume: priceOnlyRow ? (priceOnlyRow.volume || 0) : null,
    priceOnlyValue: priceOnlyRow ? (priceOnlyRow.valueApprox || 0) : null,
    breakBeforeVvi2, breakDate,
    postQvaMaxHigh,
    currentDate, currentClose,
    chartLastDate: last.date,            // chart에 데이터가 있는 마지막 일자 (5/8 평가 가능 여부 확인용)
    lookbackEndDate: rows[lookbackEnd] ? rows[lookbackEnd].date : null,
    currentFromQva2ClosePct: currentFromQva2Close != null ? +currentFromQva2Close.toFixed(2) : null,
    distanceToQva2HighPct: distanceToQva2High != null ? +distanceToQva2High.toFixed(2) : null,
  };
}

async function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`\n📊 QVA2 VVI2 Board (lookback ${VVI2_LOOKBACK_DAYS} 거래일)`);

  const board = loadQva2Signals();
  if (!board) {
    console.error(`  qva2-watchlist-board.json 이 없습니다. 먼저 'node qva2-watchlist-board.js'를 실행하세요.`);
    process.exit(1);
  }
  const baseDate = board.meta && board.meta.baseDate;
  console.log(`  기준일 (QVA2 보드): ${baseDate ? fmtDate(baseDate) : '-'}`);

  // qva2-watchlist-board.json의 funnel 모든 stage(QVA2_NEW/TRACKING/VVI2_FIRED/BREAKOUT_SUCCESS/FAILED)를
  // 합쳐서 종목당 가장 최근 QVA2 신호를 추출한다. funnel 종목당 단일 상태이므로 자연스럽게 dedup된다.
  const stages = (board.stages) || {};
  const flatEvents = [];
  for (const list of Object.values(stages)) {
    if (Array.isArray(list)) flatEvents.push(...list);
  }
  // 호환을 위해 signalDate 필드를 qva2SignalDate에서 미러링 + qva2Type 보존 (type별 VVI2 분기에 필수)
  const dedup = new Map();
  for (const ev of flatEvents) {
    if (!ev.code) continue;
    const sig = {
      code: ev.code, name: ev.name, market: ev.market, marketValue: ev.marketValue,
      signalDate: ev.qva2SignalDate,
      score: ev.qva2Score, grade: ev.qva2Grade,
      qva2Type: ev.qva2Type || 'absorption',
    };
    const cur = dedup.get(ev.code);
    if (!cur || (sig.signalDate || '') > (cur.signalDate || '')) dedup.set(ev.code, sig);
  }
  const qva2Signals = [...dedup.values()];
  console.log(`  QVA2 신호 수: ${qva2Signals.length}건 (funnel 전체 stage 합산)`);

  const metaMap = loadMetaMap();
  const events = [];
  let chartMissing = 0, qvaRowMissing = 0;
  for (const sig of qva2Signals) {
    const chart = loadChart(sig.code);
    if (!chart) { chartMissing++; continue; }
    const r = analyzeVvi2ForEvent(sig, chart);
    if (!r) { qvaRowMissing++; continue; }
    const meta = metaMap.get(sig.code);
    events.push({
      code: sig.code, name: sig.name || (meta && meta.name), market: sig.market || (meta && meta.market),
      marketValue: sig.marketValue || (meta && meta.marketValue) || 0,
      ...r,
    });
  }
  console.log(`  분석 이벤트: ${events.length}건 (chart 없음 ${chartMissing} / qvaRow 없음 ${qvaRowMissing})`);

  const byStatus = { VVI2_FIRED: [], CLOSE_WEAK: [], VALUE_WEAK: [], PRICE_ONLY: [], NEAR_HIGH: [], WAITING: [], BROKEN: [] };
  for (const e of events) (byStatus[e.status] || (byStatus[e.status] = [])).push(e);

  // 정렬
  byStatus.VVI2_FIRED.sort((a, b) => {
    const da = a.vviStats?.vvi2Date || '', db = b.vviStats?.vvi2Date || '';
    if (db !== da) return db.localeCompare(da);
    const va = a.vviStats?.vvi2ValueRatio || 0, vb = b.vviStats?.vvi2ValueRatio || 0;
    if (vb !== va) return vb - va;
    return (a.vviStats?.daysFromQva2ToVvi2 || 999) - (b.vviStats?.daysFromQva2ToVvi2 || 999);
  });
  byStatus.CLOSE_WEAK.sort((a, b) => (b.closeWeakInfo?.date || '').localeCompare(a.closeWeakInfo?.date || ''));
  byStatus.VALUE_WEAK.sort((a, b) => (b.valueWeakDate || '').localeCompare(a.valueWeakDate || ''));
  byStatus.NEAR_HIGH.sort((a, b) => (a.distanceToQva2HighPct || 999) - (b.distanceToQva2HighPct || 999));
  byStatus.WAITING.sort((a, b) => (b.qva2Score || 0) - (a.qva2Score || 0));
  byStatus.PRICE_ONLY.sort((a, b) => (b.priceOnlyDate || '').localeCompare(a.priceOnlyDate || ''));
  byStatus.BROKEN.sort((a, b) => (b.breakDate || '').localeCompare(a.breakDate || ''));

  const todayNewVvi2 = byStatus.VVI2_FIRED.filter(e => e.vviStats?.vvi2Date === baseDate);

  // chart end check — events 중 가장 흔한 chartLastDate가 baseDate보다 빠르면 5/8 미수집
  const chartEndCounts = new Map();
  for (const e of events) {
    if (e.chartLastDate) chartEndCounts.set(e.chartLastDate, (chartEndCounts.get(e.chartLastDate) || 0) + 1);
  }
  let mostCommonChartEnd = null, mostN = 0;
  for (const [d, n] of chartEndCounts) { if (n > mostN) { mostN = n; mostCommonChartEnd = d; } }
  const chartUpToBaseDate = mostCommonChartEnd === baseDate;
  const nextDayMissing = chartUpToBaseDate; // chart 마지막이 baseDate면 다음 거래일은 평가 불가

  const counts = {
    total: events.length,
    vvi2Fired: byStatus.VVI2_FIRED.length,
    closeWeak: byStatus.CLOSE_WEAK.length,
    valueWeak: byStatus.VALUE_WEAK.length,
    priceOnly: byStatus.PRICE_ONLY.length,
    nearHigh:  byStatus.NEAR_HIGH.length,
    waiting:   byStatus.WAITING.length,
    broken:    byStatus.BROKEN.length,
    todayNewVvi2: todayNewVvi2.length,
  };

  const out = {
    meta: {
      title: 'QVA2 → VVI2: 약했던 마감을 다시 뚫는 후보',
      subtitle: 'QVA2 발생 후 type별 다른 정의로 재돌파를 추적합니다 (qva2-watchlist와 통일).',
      caution: '실험 라인. 매수 신호가 아니라 관찰 후보입니다.',
      generatedAt: new Date().toISOString(),
      baseDate, baseDateFmt: baseDate ? fmtDate(baseDate) : null,
      lookbackDays: VVI2_LOOKBACK_DAYS,
      topLimit: TOP_LIMIT,
      mostCommonChartEnd,
      chartEndFmt: mostCommonChartEnd ? fmtDate(mostCommonChartEnd) : null,
      nextDayMissing,
      thresholds: {
        minClosePullback: MIN_CLOSE_PULLBACK,
        minVvi2CloseLocation: MIN_VVI2_CLOSE_LOCATION,
      },
    },
    counts,
    todayNewVvi2: todayNewVvi2.slice(0, TOP_LIMIT),
    byStatus: {
      VVI2_FIRED: byStatus.VVI2_FIRED.slice(0, TOP_LIMIT),
      CLOSE_WEAK: byStatus.CLOSE_WEAK.slice(0, TOP_LIMIT),
      VALUE_WEAK: byStatus.VALUE_WEAK.slice(0, TOP_LIMIT),
      NEAR_HIGH:  byStatus.NEAR_HIGH.slice(0, TOP_LIMIT),
      WAITING:    byStatus.WAITING.slice(0, TOP_LIMIT),
      PRICE_ONLY: byStatus.PRICE_ONLY.slice(0, TOP_LIMIT),
      BROKEN:     byStatus.BROKEN.slice(0, TOP_LIMIT),
    },
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  // DB 저장 (실패해도 HTML/JSON은 정상)
  try {
    const { saveQva2VviBoardToDB } = require('../../src/db/saveBoardSignals');
    const r = await saveQva2VviBoardToDB(out, { jsonPath: OUT_JSON, htmlPath: OUT_HTML });
    if (r) console.log(`  🗄  DB 저장: runId=${r.runId} rows=${r.totalRows} (inserted=${r.inserted} updated=${r.updated})`);
  } catch (e) {
    console.warn(`  ⚠ DB 저장 실패 (HTML/JSON은 정상 저장됨): ${e.message}`);
  } finally {
    try { await require('../../src/db/mysql').closePool(); } catch (_) {}
  }

  console.log(`\n  chart 마지막 일자: ${mostCommonChartEnd ? fmtDate(mostCommonChartEnd) : '-'}` + (nextDayMissing ? ' ⚠ baseDate 다음 거래일 미수집 — 5/8 같은 신규 데이터 추가 후 재실행 필요' : ''));
  console.log(`\n  요약:`);
  console.log(`    🟣 VVI2 재돌파 성공: ${counts.vvi2Fired}건 (오늘 신규 ${counts.todayNewVvi2}건)`);
  console.log(`    🟠 종가 위치 부족 (CLOSE_WEAK): ${counts.closeWeak}건  ← high/vol/val OK, closeLoc만 < 0.50`);
  console.log(`    🟡 거래대금/거래량 부족 (VALUE_WEAK): ${counts.valueWeak}건`);
  console.log(`    ⚪ 가격만 돌파 (PRICE_ONLY): ${counts.priceOnly}건`);
  console.log(`    🔵 고가 근처 대기:    ${counts.nearHigh}건`);
  console.log(`    ⏳ 재돌파 대기:       ${counts.waiting}건`);
  console.log(`    🔴 QVA2 -5% 이탈:    ${counts.broken}건`);
  if (byStatus.VVI2_FIRED.length > 0) {
    console.log(`\n  ── VVI2 재돌파 성공 상위 ${Math.min(8, byStatus.VVI2_FIRED.length)} ──`);
    for (const e of byStatus.VVI2_FIRED.slice(0, 8)) {
      const v = e.vviStats;
      console.log(`    ${fmtDate(e.qva2Date)} → ${fmtDate(v.vvi2Date)} | ${e.code} ${(e.name || '').padEnd(13)} | days ${v.daysFromQva2ToVvi2} | val×${v.vvi2ValueRatio} / vol×${v.vvi2VolumeRatio} | high+${v.vvi2HighFromQva2HighPct}%`);
    }
  }
  console.log(`  elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

function buildHtml(data) {
  return HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(data));
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>QVA2 → VVI2 재돌파 후보</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
}
nav.boards { display:flex; gap:6px; flex-wrap:wrap; padding:8px 0 14px; border-bottom:1px solid #1e293b; margin-bottom:14px; align-items:center; }
nav.boards .group-label { font-size:11px; color:#64748b; padding:4px 8px 4px 0; font-weight:600; letter-spacing:0.4px; text-transform:uppercase; }
nav.boards a { color:#94a3b8; text-decoration:none; font-size:12px; padding:5px 10px; border-radius:6px; border:1px solid transparent; }
nav.boards a:hover { color:#e2e8f0; background:#1e293b; }
nav.boards a.live { border-color:#1e293b; }
nav.boards a.experiment { border-color:#7c3aed; color:#c4b5fd; background:#1e1b4b; }
nav.boards a.experiment:hover { background:#312e81; color:#e0e7ff; }
nav.boards a.active { background:#1e293b; color:#f1f5f9; border-color:#334155; }
nav.boards a.experiment.active { background:#312e81; color:#e0e7ff; border-color:#a78bfa; }
nav.boards .sep { color:#475569; padding:0 6px; }

h1 { font-size: 22px; margin: 6px 0 4px; color: #f1f5f9; font-weight: 700; }
.exp-pill { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; background:#312e81; color:#c4b5fd; border:1px solid #6366f1; margin-left:8px; vertical-align:middle; font-weight:600; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 12px; line-height:1.6; }
.purpose-box { background: #0f172a; border-left: 3px solid #a78bfa; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #c4b5fd; }
.funnel-chip { display:inline-block; text-decoration:none; padding:4px 10px; border-radius:5px; font-size:12px; font-weight:600; transition: transform 0.1s, filter 0.15s; }
.funnel-chip:hover { transform: translateY(-1px); filter: brightness(1.25); }
h2[id^="sec-"] { scroll-margin-top: 14px; }
.caution-box { background:#1f1b14; border-left:3px solid #fbbf24; padding:10px 14px; border-radius:6px; margin-bottom:14px; color:#fcd34d; font-size:12px; line-height:1.6; }

.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
.summary-cell { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.summary-cell .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.summary-cell .value { font-size: 22px; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; margin-top: 4px; }
.summary-cell .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
.summary-cell.vvi2 { border-left: 4px solid #14b8a6; }
.summary-cell.near { border-left: 4px solid #3b82f6; }
.summary-cell.wait { border-left: 4px solid #94a3b8; }
.summary-cell.po   { border-left: 4px solid #f59e0b; }
.summary-cell.brk  { border-left: 4px solid #ef4444; }

h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h2 .count { font-size: 13px; color: #64748b; font-weight: 400; margin-left: 6px; }

.card { background:#1e293b; border:1px solid #334155; border-radius:10px; padding:14px 16px; margin-bottom:10px; }
.card.s-VVI2_FIRED { border-left:5px solid #14b8a6; background:linear-gradient(90deg, #042f2e 0%, #1e293b 25%); }
.card.s-NEAR_HIGH  { border-left:4px solid #3b82f6; }
.card.s-WAITING    { border-left:4px solid #94a3b8; opacity:0.92; }
.card.s-PRICE_ONLY { border-left:4px solid #f59e0b; opacity:0.88; }
.card.s-BROKEN     { border-left:4px solid #ef4444; opacity:0.7; }
.card h3 { margin: 0 0 6px; font-size: 15px; color:#f1f5f9; font-weight:700; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.card h3 .code { color: #64748b; font-size: 12px; font-weight: 400; }
.card h3 .market { color:#94a3b8; font-size:11px; padding:1px 6px; border:1px solid #334155; border-radius:4px; }
.card h3 a.name-link { color:#f1f5f9; text-decoration:none; border-bottom:1px dashed transparent; }
.card h3 a.name-link:hover { color:#5eead4; border-bottom-color:#5eead4; }
.card .status-badge { font-size:11px; padding:2px 8px; border-radius:999px; font-weight:600; border:1px solid; }
.card.s-VVI2_FIRED .status-badge { background:#042f2e; color:#5eead4; border-color:#14b8a6; }
.card.s-NEAR_HIGH  .status-badge { background:#172554; color:#93c5fd; border-color:#3b82f6; }
.card.s-WAITING    .status-badge { background:#1e293b; color:#cbd5e1; border-color:#475569; }
.card.s-PRICE_ONLY .status-badge { background:#422006; color:#fde68a; border-color:#f59e0b; }
.card.s-BROKEN     .status-badge { background:#7f1d1d; color:#fca5a5; border-color:#ef4444; }

.metrics-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(135px, 1fr)); gap:8px; margin:8px 0; }
.metric { background:#0f172a; border:1px solid #334155; border-radius:6px; padding:7px 10px; }
.metric .label { font-size:10px; color:#94a3b8; margin-bottom:2px; text-transform:uppercase; letter-spacing:0.3px; }
.metric .value { font-size:14px; font-weight:600; color:#e2e8f0; font-variant-numeric:tabular-nums; }
.cell-pos { color:#6ee7b7; }
.cell-neg { color:#fca5a5; }
.cell-warn { color:#fbbf24; }

details.section { margin-bottom: 16px; }
details.section > summary { cursor: pointer; font-size: 14px; font-weight: 700; color: #cbd5e1; padding: 10px 14px; user-select: none; background: #0f172a; border-radius: 8px; border: 1px solid #1e293b; }
details.section > .section-body { padding: 12px 6px; }

.section-empty { padding: 18px; background:#1e293b; border:1px dashed #475569; border-radius:8px; color:#64748b; text-align:center; font-size:12px; }
footer.foot { margin-top:30px; padding:14px; background:#1e293b; border-radius:8px; font-size:12px; color:#94a3b8; line-height:1.7; }
</style>
</head>
<body>
<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
  <div style="background:linear-gradient(90deg,#064e3b 0%,#065f46 100%);border:1px solid #10b981;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#a7f3d0;font-weight:700;letter-spacing:0.3px;">🟢 운영 보드</span><a href="/qva2-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR</a><a href="/qva2-d5-rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파</a><a href="/qva2-vvi" style="color:#fff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.22);border:1px solid #fff;font-weight:700;">🎯 고점 재돌파</a></div>
  <div style="background:linear-gradient(90deg,#1e1b4b 0%,#312e81 100%);border:1px solid #6366f1;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#c4b5fd;font-weight:700;letter-spacing:0.3px;">🟣 실험 라인</span><a href="/one-day-surge-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">⚡ 1DS 단타 후보</a></div>
  <div style="background:linear-gradient(90deg,#1e293b 0%,#334155 100%);border:1px solid #64748b;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;opacity:0.92;"><span style="color:#cbd5e1;font-weight:700;letter-spacing:0.3px;">📜 과거 보드</span><a href="/qva-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR (구)</a><a href="/rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파 (구)</a><a href="/qva-vvi-redefined-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파 (구)</a></div>
  <div style="background:linear-gradient(90deg,#042f2e 0%,#134e4a 100%);border:1px solid #14b8a6;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#5eead4;font-weight:700;letter-spacing:0.3px;">📊 통합 보기</span><a href="/db-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🗄 DB 신호 운영판</a></div>
</div>

<h1>🟣 QVA2 → VVI2: 약했던 마감을 다시 뚫는 후보 <span class="exp-pill">실험 라인</span></h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  <strong>VVI2란?</strong> QVA2 신호일의 (high, volume, value)를 기준으로, 그 이후 처음으로
  ① 고가 재돌파, ② 거래량 ≥ QVA2 당일, ③ 거래대금 ≥ QVA2 당일, ④ 종가가 캔들 중간 이상에서 마감한 날을 VVI2로 봅니다.
  <br>QVA2 종가 대비 -5% 이상 무너지면 자격 박탈 (BROKEN).
  <br><br><span style="color:#94a3b8;font-size:12px;">상태 분포 (chip 클릭 = 해당 섹션으로 이동):</span><br>
  <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px;">
    <a href="#sec-today" class="funnel-chip" style="background:#1e1b4b;border:1px solid #a78bfa;color:#c4b5fd;">📅 오늘 신규 VVI2</a>
    <a href="#sec-vvi2"  class="funnel-chip" style="background:#052e16;border:1px solid #22c55e;color:#86efac;">🟢 VVI2 재돌파 성공</a>
    <a href="#sec-cw"    class="funnel-chip" style="background:#3a1a04;border:1px solid #fb923c;color:#fdba74;">🟠 종가 위치 부족</a>
    <a href="#sec-vw"    class="funnel-chip" style="background:#3a2a08;border:1px solid #eab308;color:#fde047;">🟡 거래대금/량 부족</a>
    <a href="#sec-near"  class="funnel-chip" style="background:#0c2740;border:1px solid #3b82f6;color:#93c5fd;">🔵 고가 근처 대기</a>
    <a href="#sec-wait"  class="funnel-chip" style="background:#1e293b;border:1px solid #64748b;color:#cbd5e1;">⏳ 재돌파 대기</a>
    <a href="#sec-po"    class="funnel-chip" style="background:#1e293b;border:1px solid #94a3b8;color:#cbd5e1;">⚪ 가격만 돌파 (참고)</a>
    <a href="#sec-brk"   class="funnel-chip" style="background:#450a0a;border:1px solid #f87171;color:#fca5a5;">🔴 QVA2 -5% 이탈</a>
  </div>
</div>

<div class="caution-box">
  ⚠️ <strong>실험 라인:</strong> 검증 단계. 매수 확정 신호 아님.
</div>

<h2>📊 화면 요약</h2>
<div class="summary-grid" id="summary-grid"></div>

<h2 id="sec-today">📅 오늘 신규 VVI2 <span class="count" id="today-count"></span></h2>
<div id="today-host"></div>

<div id="chart-end-banner"></div>

<h2 id="sec-vvi2">🟢 VVI2 재돌파 성공 <span class="count" id="vvi2-count"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">qva2-watchlist와 동일 정의 — type별 분기. absorption: high+vol+val+closeLoc / spike: close+closeLoc+val·vol(OR 절).</div>
<div id="vvi2-host"></div>

<h2 id="sec-cw">🟠 종가 위치 부족 (CLOSE_WEAK) <span class="count" id="cw-count"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">가격·거래량·거래대금은 통과했지만 closeLocation이 0.50 미만이라 미달한 후보입니다 (마음AI 5/7 같은 borderline). chart 다음 거래일 데이터가 들어오면 결과가 바뀔 수 있습니다.</div>
<div id="cw-host"></div>

<h2 id="sec-vw">🟡 거래대금/거래량 부족 (VALUE_WEAK) <span class="count" id="vw-count"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">가격은 QVA2 high를 넘었지만 거래대금 또는 거래량이 QVA2 당일에 못 미친 후보.</div>
<div id="vw-host"></div>

<h2 id="sec-near">🔵 고가 근처 대기 <span class="count" id="near-count"></span></h2>
<div id="near-host"></div>

<h2 id="sec-wait">⏳ 재돌파 대기 <span class="count" id="wait-count"></span></h2>
<div id="wait-host"></div>

<h2 id="sec-po">⚪ 가격만 돌파 (참고) <span class="count" id="po-count"></span></h2>
<div id="po-host"></div>

<h2 id="sec-brk">🔴 QVA2 -5% 이탈 <span class="count" id="brk-count"></span></h2>
<div id="brk-host"></div>

<footer class="foot" id="foot"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}
function fmtMarketcap(v) {
  if (!v) return '-';
  if (v >= 1e12) return (v / 1e12).toFixed(1) + '조';
  if (v >= 1e8) return Math.round(v / 1e8) + '억';
  return v;
}
function fmtNum(v) { if (v == null) return '-'; return v.toLocaleString(); }
function pctClass(v) { if (v == null) return ''; return v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : ''); }

document.getElementById('subtitle').textContent =
  '기준일 ' + (DATA.meta.baseDateFmt || '-') + ' · 탐색 윈도우 ' + DATA.meta.lookbackDays + '거래일 · 생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

const sg = document.getElementById('summary-grid');
const c = DATA.counts;
sg.innerHTML = [
  cell('vvi2', 'VVI2 재돌파', c.vvi2Fired,  '오늘 ' + c.todayNewVvi2 + '건 신규'),
  cell('near', '고가 근처',   c.nearHigh,  'QVA2 고점 -3% 이내'),
  cell('wait', '재돌파 대기', c.waiting,   ''),
  cell('po',   '거래량 부족', c.priceOnly, '가격은 넘었지만 거래대금 부족'),
  cell('brk',  '-5% 이탈',    c.broken,    'QVA2 종가 대비 무너짐'),
].join('');

function cell(cls, label, value, sub) {
  return '<div class="summary-cell ' + cls + '"><div class="label">' + label + '</div><div class="value">' + (value ?? 0) + '</div><div class="sub">' + (sub || '') + '</div></div>';
}

document.getElementById('today-count').textContent  = '(' + (DATA.todayNewVvi2?.length || 0) + ')';
document.getElementById('vvi2-count').textContent   = '(' + (DATA.byStatus.VVI2_FIRED?.length || 0) + ')';
document.getElementById('cw-count').textContent     = '(' + (DATA.byStatus.CLOSE_WEAK?.length || 0) + ')';
document.getElementById('vw-count').textContent     = '(' + (DATA.byStatus.VALUE_WEAK?.length || 0) + ')';
document.getElementById('near-count').textContent   = '(' + (DATA.byStatus.NEAR_HIGH?.length || 0) + ')';
document.getElementById('wait-count').textContent   = '(' + (DATA.byStatus.WAITING?.length || 0) + ')';
document.getElementById('po-count').textContent     = '(' + (DATA.byStatus.PRICE_ONLY?.length || 0) + ')';
document.getElementById('brk-count').textContent    = '(' + (DATA.byStatus.BROKEN?.length || 0) + ')';

// chart 다음 거래일 미수집 알림
if (DATA.meta.nextDayMissing) {
  document.getElementById('chart-end-banner').innerHTML =
    '<div style="background:#1f1b14;border-left:4px solid #fbbf24;padding:12px 16px;border-radius:6px;margin-bottom:14px;color:#fcd34d;font-size:12.5px;line-height:1.6;">' +
    '⚠ <strong>chart 마지막 일자 = baseDate (' + DATA.meta.chartEndFmt + ')</strong>. ' +
    'baseDate 다음 거래일 데이터가 아직 chart에 없어서 평가가 한 거래일 부족합니다. ' +
    '운영 서버에서는 다음 거래일 16:20 cron이 chart를 갱신하면 16:35에 보드가 자동 재생성됩니다.' +
    '</div>';
}

renderCards('today-host', DATA.todayNewVvi2, '오늘 신규 VVI2가 없습니다.');
renderCards('vvi2-host',  DATA.byStatus.VVI2_FIRED, 'VVI2 재돌파 후보가 없습니다.');
renderCards('cw-host',    DATA.byStatus.CLOSE_WEAK, 'CLOSE_WEAK 후보 없음.');
renderCards('vw-host',    DATA.byStatus.VALUE_WEAK, 'VALUE_WEAK 후보 없음.');
renderCards('near-host',  DATA.byStatus.NEAR_HIGH,  '');
renderCards('wait-host',  DATA.byStatus.WAITING,    '');
renderCards('po-host',    DATA.byStatus.PRICE_ONLY, '');
renderCards('brk-host',   DATA.byStatus.BROKEN,     '');

document.getElementById('foot').innerHTML =
  '<strong>VVI2 정의:</strong> QVA2 발생일 high/volume/value 기준, ' +
  'high 재돌파 + volume ≥ QVA2 + value ≥ QVA2 + closeLocation ≥ ' + DATA.meta.thresholds.minVvi2CloseLocation + '. ' +
  'QVA2 종가 대비 ' + (DATA.meta.thresholds.minClosePullback * 100) + '% 이상 무너지면 BROKEN.';

function renderCards(hostId, items, emptyMsg) {
  const host = document.getElementById(hostId);
  if (!items || items.length === 0) {
    host.innerHTML = emptyMsg ? '<div class="section-empty">' + emptyMsg + '</div>' : '';
    return;
  }
  host.innerHTML = items.map(card).join('');
}

function card(e) {
  const v = e.vviStats || {};
  const isVvi = e.status === 'VVI2_FIRED';
  return '<div class="card s-' + e.status + '">' +
    '<h3>' +
      '<a class="name-link" href="/qva2-vvi/' + e.code + '">' + (e.name || e.code) + '</a>' +
      '<span class="code">' + e.code + '</span>' +
      '<span class="market">' + (e.market || '') + '</span>' +
      '<span class="status-badge">' + e.statusLabel + '</span>' +
    '</h3>' +
    '<div class="metrics-grid">' +
      m('QVA2 신호일', fmtDate(e.qva2Date)) +
      (isVvi
        ? m('VVI2 발생일', fmtDate(v.vvi2Date) + ' (D+' + v.daysFromQva2ToVvi2 + ')')
        : (e.priceOnlyDate ? m('가격만 돌파', fmtDate(e.priceOnlyDate)) : m('현재', fmtDate(e.currentDate)))) +
      (isVvi
        ? m('VVI2 종가', fmtNum(v.vvi2Close))
        : m('현재 종가', fmtNum(e.currentClose))) +
      (isVvi
        ? m('거래대금 배율', '×' + (v.vvi2ValueRatio ?? '-'), 'cell-pos')
        : m('QVA2 → 현재', (e.currentFromQva2ClosePct >= 0 ? '+' : '') + (e.currentFromQva2ClosePct ?? 0).toFixed(1) + '%', pctClass(e.currentFromQva2ClosePct))) +
      (isVvi
        ? m('거래량 배율', '×' + (v.vvi2VolumeRatio ?? '-'), 'cell-pos')
        : (e.distanceToQva2HighPct != null ? m('QVA2 고점까지', '-' + e.distanceToQva2HighPct.toFixed(1) + '%') : m('', ''))) +
      (isVvi
        ? m('QVA2 high 대비', '+' + (v.vvi2HighFromQva2HighPct ?? '-') + '%', 'cell-pos')
        : m('QVA2 점수', e.qva2Score + ' (' + e.qva2Grade + ')')) +
      m('시총', fmtMarketcap(e.marketValue)) +
    '</div>' +
  '</div>';
}

function m(label, value, cls) {
  return '<div class="metric"><div class="label">' + label + '</div><div class="value' + (cls ? ' ' + cls : '') + '">' + value + '</div></div>';
}
</script>
</body>
</html>
`;

if (require.main === module) {
  main().catch(e => { console.error('❌', e); process.exit(1); });
}

module.exports = { main };
