#!/usr/bin/env node
/**
 * QVA 고점 재돌파 후보 보드 (새 VVI 정의)
 *
 * 새 VVI 정의:
 *   QVA 발생일의 (high, volume, value)를 저장하고, 그 이후 첫 번째로 다음을 모두 만족하는 날을 VVI로 본다:
 *     1) 당일 high > qvaHigh
 *     2) 당일 volume >= qvaVolume
 *     3) 당일 value >= qvaValue
 *
 *   이번 정의에서는 횡보/저점 유지/H그룹/종가 위치 등의 추가 조건은 넣지 않는다 — 단순 시작.
 *
 * 입력:
 *   - qva-watchlist-board.json (QVA 신호 list)
 *   - cache/stock-charts-long/{code}.json (일봉)
 *
 * 출력:
 *   - reports/qva-vvi-redefined-board-result.json
 *   - reports/qva-vvi-redefined-board-result.html
 *
 * 라우트: GET /qva-vvi-redefined-board
 *
 * 환경변수:
 *   - VVI_LOOKBACK_DAYS (기본 20): 최근 N 거래일 안의 QVA 신호만 처리
 *   - VVI_TOP_LIMIT (기본 10): 상단 노출 후보 수
 *
 * 향후 파일 관리:
 *   v2/final/new 같은 사본 만들지 말고 이 파일에 섹션 추가 또는 결과 덮어쓰기.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const QVA_BOARD_PATH = path.join(ROOT, 'qva-watchlist-board.json');
const CHART_DIR      = path.join(ROOT, 'cache', 'stock-charts-long');
const REPORTS_DIR    = path.join(ROOT, 'reports');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const OUT_JSON = path.join(REPORTS_DIR, 'qva-vvi-redefined-board-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'qva-vvi-redefined-board-result.html');

const VVI_LOOKBACK_DAYS = Number(process.env.VVI_LOOKBACK_DAYS || 20);
const TOP_LIMIT         = Number(process.env.VVI_TOP_LIMIT || 10);
// 추격 부담 임계값
const OVERHEAT_FROM_QVA_PCT = 25;
const OVERHEAT_FROM_VVI_PCT = 20;
// 시가총액 상한 — "뚱뚱이"(대형주) 제외. 2조 이하만 운영 후보로.
const MAX_MARKET_CAP = Number(process.env.VVI_MAX_MARKET_CAP || 2e12);

// ── 유틸 ──
function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}
function isNum(v) { return v != null && Number.isFinite(v); }

// ── 종목 메타 (시총·이름 보강) ──
function loadMetaMap() {
  const map = new Map();
  if (fs.existsSync(NAVER_LIST_PATH)) {
    try {
      const j = JSON.parse(fs.readFileSync(NAVER_LIST_PATH, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (!s.code) continue;
        map.set(s.code, { name: s.name, market: s.market, marketCap: s.marketValue || 0 });
      }
    } catch (_) {}
  }
  return map;
}

// ── QVA 신호 추출 (qva-watchlist-board.json snapshot) ──
function loadQvaSignals() {
  if (!fs.existsSync(QVA_BOARD_PATH)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(QVA_BOARD_PATH, 'utf-8'));
    const stages = j.stages || {};
    const seen = new Set();
    const out = [];
    for (const [stage, list] of Object.entries(stages)) {
      if (!Array.isArray(list)) continue;
      for (const it of list) {
        if (!it.code || !it.qvaSignalDate) continue;
        const key = it.code + '_' + it.qvaSignalDate;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          code: it.code,
          name: it.name || '',
          market: it.market || '',
          marketValue: it.marketValue || 0,
          qvaSignalDate: it.qvaSignalDate,
          stage,
        });
      }
    }
    return out;
  } catch (_) { return []; }
}

function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}

// ── VVI 분석 (한 QVA 이벤트당) ──
// 새 VVI 정의: high > qvaHigh + volume ≥ qvaVolume + value ≥ qvaValue 셋 다 만족 첫 row
function analyzeVvi(sig, chart, todayDateNum) {
  const rows = chart && chart.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const qvaIdx = rows.findIndex((r) => r.date === sig.qvaSignalDate);
  if (qvaIdx < 0) return null;
  const qva = rows[qvaIdx];
  const qvaHigh   = qva.high;
  const qvaClose  = qva.close;
  const qvaVolume = qva.volume || 0;
  const qvaValue  = qva.valueApprox || 0;
  if (!isNum(qvaHigh) || !isNum(qvaClose) || qvaVolume <= 0 || qvaValue <= 0) return null;

  let vviRow = null, vviIdx = -1;
  let priceOnlyRow = null, priceOnlyIdx = -1; // 가격은 넘었지만 거래량/거래대금 부족인 첫 row (VVI 미발생 시 표시용)
  for (let i = qvaIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!isNum(r.high)) continue;
    if (r.high > qvaHigh) {
      const okVol = (r.volume || 0) >= qvaVolume;
      const okVal = (r.valueApprox || 0) >= qvaValue;
      if (okVol && okVal) {
        vviRow = r; vviIdx = i;
        break;
      } else if (priceOnlyRow == null) {
        priceOnlyRow = r; priceOnlyIdx = i;
      }
    }
  }

  const lastIdx = rows.length - 1;
  const lastRow = rows[lastIdx];
  const currentClose = lastRow.close;
  const currentDate  = lastRow.date;
  const currentVolume = lastRow.volume || 0;
  const currentValue  = lastRow.valueApprox || 0;
  const currentFromQvaCloseRate = qvaClose > 0 ? (currentClose / qvaClose - 1) * 100 : null;
  const currentValueRatio  = qvaValue  > 0 ? currentValue  / qvaValue  : null;
  const currentVolumeRatio = qvaVolume > 0 ? currentVolume / qvaVolume : null;
  const daysFromQvaToVvi = vviRow ? (vviIdx - qvaIdx) : null;

  // 대기(E) 그룹 정렬용 — QVA 고점까지 남은 거리, 그리고 QVA 이후 만들어본 최고가가 QVA 고점에 얼마나 가까웠는지
  let postQvaMaxHigh = null;
  for (let i = qvaIdx + 1; i < rows.length; i++) {
    if (isNum(rows[i].high) && (postQvaMaxHigh == null || rows[i].high > postQvaMaxHigh)) postQvaMaxHigh = rows[i].high;
  }
  const distanceToQvaHighRate     = qvaHigh > 0 ? (qvaHigh - currentClose) / qvaHigh * 100 : null;
  const highDistanceToQvaHighRate = qvaHigh > 0 && postQvaMaxHigh != null ? (qvaHigh - postQvaMaxHigh) / qvaHigh * 100 : null;

  // 거래대금 부족 돌파(D) 그룹 정렬용 — 가격은 넘었으나 거래량/거래대금이 QVA 대비 얼마나 붙었는지
  const valueFillRatio  = priceOnlyRow && qvaValue  > 0 ? (priceOnlyRow.valueApprox || 0) / qvaValue  : null;
  const volumeFillRatio = priceOnlyRow && qvaVolume > 0 ? (priceOnlyRow.volume      || 0) / qvaVolume : null;

  let vviStats = {
    vviDate: null, vviClose: null, vviHigh: null, vviVolume: null, vviValue: null,
    vviValueRatio: null, vviVolumeRatio: null,
    vviCloseFromQvaCloseRate: null,
    vviHighFromQvaHighRate: null,
    next1HighRate: null, next1CloseRate: null,
    next3HighRate: null, next5HighRate: null, next10HighRate: null,
    maxHighAfterVvi10: null, maxHighAfterVvi20: null,
    currentFromVviCloseRate: null,
  };
  if (vviRow) {
    vviStats.vviDate    = vviRow.date;
    vviStats.vviClose   = vviRow.close;
    vviStats.vviHigh    = vviRow.high;
    vviStats.vviVolume  = vviRow.volume || 0;
    vviStats.vviValue   = vviRow.valueApprox || 0;
    vviStats.vviValueRatio  = qvaValue  > 0 ? vviStats.vviValue  / qvaValue  : null;
    vviStats.vviVolumeRatio = qvaVolume > 0 ? vviStats.vviVolume / qvaVolume : null;
    vviStats.vviCloseFromQvaCloseRate = qvaClose > 0 ? (vviRow.close / qvaClose - 1) * 100 : null;
    vviStats.vviHighFromQvaHighRate   = qvaHigh  > 0 ? (vviRow.high  / qvaHigh  - 1) * 100 : null;
    vviStats.currentFromVviCloseRate  = vviRow.close > 0 ? (currentClose / vviRow.close - 1) * 100 : null;
    // VVI 이후 next N + max highrate
    function maxHighRate(n) {
      let max = -Infinity;
      for (let k = 1; k <= n && vviIdx + k < rows.length; k++) {
        if (isNum(rows[vviIdx + k].high) && rows[vviIdx + k].high > max) max = rows[vviIdx + k].high;
      }
      if (!Number.isFinite(max)) return null;
      return vviRow.close > 0 ? (max / vviRow.close - 1) * 100 : null;
    }
    function nextNHighRate(n) {
      if (vviIdx + n >= rows.length) return null;
      return vviRow.close > 0 ? (rows[vviIdx + n].high / vviRow.close - 1) * 100 : null;
    }
    function nextNCloseRate(n) {
      if (vviIdx + n >= rows.length) return null;
      return vviRow.close > 0 ? (rows[vviIdx + n].close / vviRow.close - 1) * 100 : null;
    }
    vviStats.next1HighRate    = nextNHighRate(1);
    vviStats.next1CloseRate   = nextNCloseRate(1);
    vviStats.next3HighRate    = maxHighRate(3);
    vviStats.next5HighRate    = maxHighRate(5);
    vviStats.next10HighRate   = maxHighRate(10);
    vviStats.maxHighAfterVvi10 = maxHighRate(10);
    vviStats.maxHighAfterVvi20 = maxHighRate(20);
  }

  // 상태 분류
  let status;
  if (vviRow) {
    const overheatFromQva = isNum(currentFromQvaCloseRate) && currentFromQvaCloseRate >= OVERHEAT_FROM_QVA_PCT;
    const overheatFromVvi = isNum(vviStats.currentFromVviCloseRate) && vviStats.currentFromVviCloseRate >= OVERHEAT_FROM_VVI_PCT;
    status = (overheatFromQva || overheatFromVvi) ? 'OVERHEATED' : 'VVI_FIRED';
  } else if (priceOnlyRow) {
    status = 'PRICE_ONLY';
  } else {
    status = 'WAITING';
  }
  // 상태 라벨 (1차 백테스트 결론 반영 — 추격 부담 후보가 실제로 강했음 → 표현 변경)
  const statusLabel = {
    VVI_FIRED:  '안정형 고점 재돌파',
    OVERHEATED: '강한 거래대금 재돌파',
    WAITING:    '고점 재돌파 대기',
    PRICE_ONLY: '거래대금 부족',
  }[status];

  return {
    code: sig.code, name: sig.name, market: sig.market, marketValue: sig.marketValue,
    qvaSignalDate: sig.qvaSignalDate,
    qvaHigh, qvaClose, qvaVolume, qvaValue,
    ...vviStats,
    daysFromQvaToVvi,
    priceOnlyDate: priceOnlyRow ? priceOnlyRow.date : null,
    priceOnlyHigh: priceOnlyRow ? priceOnlyRow.high : null,
    priceOnlyVolume: priceOnlyRow ? (priceOnlyRow.volume || 0) : null,
    priceOnlyValue:  priceOnlyRow ? (priceOnlyRow.valueApprox || 0) : null,
    valueFillRatio, volumeFillRatio,
    postQvaMaxHigh, distanceToQvaHighRate, highDistanceToQvaHighRate,
    currentDate, currentClose, currentVolume, currentValue,
    currentValueRatio, currentVolumeRatio,
    currentFromQvaCloseRate,
    status, statusLabel,
    qvaStage: sig.stage,
  };
}

// ── 메인 ──
async function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`\n📊 QVA 고점 재돌파 후보 보드 (새 VVI 정의, lookback ${VVI_LOOKBACK_DAYS} 거래일)`);

  const metaMap = loadMetaMap();
  const qvaSignals = loadQvaSignals();
  console.log(`  QVA 신호 수: ${qvaSignals.length}건`);

  // chart의 가장 흔한 last row date를 today로 추정
  const dateFreq = new Map();
  for (const sig of qvaSignals) {
    const c = loadChart(sig.code);
    if (c && c.rows && c.rows.length) {
      const d = c.rows[c.rows.length - 1].date;
      dateFreq.set(d, (dateFreq.get(d) || 0) + 1);
    }
  }
  let todayDate = null, maxFreq = 0;
  for (const [d, n] of dateFreq) { if (n > maxFreq) { maxFreq = n; todayDate = d; } }
  console.log(`  분석 기준일 (today): ${todayDate ? fmtDate(todayDate) : '-'}`);

  // VVI_LOOKBACK_DAYS 기준 cutoff (calendar days × 7/5 ≈ trading days, 단순 근사)
  // 정확히 하려면 trading day calendar 필요 — 여기서는 calendar days로 28일 컷오프 (20 거래일 ≈ 28 calendar)
  const cutoffMs = todayDate ? (() => {
    const d = new Date(Number(todayDate.slice(0,4)), Number(todayDate.slice(4,6))-1, Number(todayDate.slice(6,8)));
    d.setDate(d.getDate() - Math.round(VVI_LOOKBACK_DAYS * 7 / 5));
    return d.getTime();
  })() : null;
  function isWithinLookback(qvaDate) {
    if (!cutoffMs) return true;
    const d = new Date(Number(qvaDate.slice(0,4)), Number(qvaDate.slice(4,6))-1, Number(qvaDate.slice(6,8)));
    return d.getTime() >= cutoffMs;
  }

  // 분석
  const events = [];
  let chartMissing = 0, qvaRowMissing = 0, marketCapFiltered = 0;
  for (const sig of qvaSignals) {
    if (!isWithinLookback(sig.qvaSignalDate)) continue;
    // 이름·시총 보강 (qva-watchlist 데이터 + naver 데이터) — 시총 필터를 위해 chart 로드 전에 먼저 적용
    const meta = metaMap.get(sig.code);
    if (meta) {
      sig.name = sig.name || meta.name;
      sig.market = sig.market || meta.market;
      sig.marketValue = sig.marketValue || meta.marketCap;
    }
    // 시총 필터: MAX_MARKET_CAP 초과 제외 (시총 미상도 보수적으로 제외)
    if (!sig.marketValue || sig.marketValue > MAX_MARKET_CAP) { marketCapFiltered++; continue; }
    const chart = loadChart(sig.code);
    if (!chart) { chartMissing++; continue; }
    const ev = analyzeVvi(sig, chart, todayDate);
    if (!ev) { qvaRowMissing++; continue; }
    events.push(ev);
  }
  console.log(`  분석 이벤트: ${events.length}건 / chart 없음 ${chartMissing} / qvaRow 없음 ${qvaRowMissing} / 시총>${(MAX_MARKET_CAP/1e12).toFixed(1)}조 제외 ${marketCapFiltered}`);

  // 종목별 dedup (VVI 발생 우선, 그 다음 최신 qvaSignalDate)
  const dedupMap = new Map();
  for (const e of events) {
    const cur = dedupMap.get(e.code);
    if (!cur) { dedupMap.set(e.code, e); continue; }
    const curHasVvi = cur.vviDate ? 1 : 0;
    const eHasVvi = e.vviDate ? 1 : 0;
    if (eHasVvi !== curHasVvi) { if (eHasVvi > curHasVvi) dedupMap.set(e.code, e); continue; }
    if (e.qvaSignalDate > cur.qvaSignalDate) dedupMap.set(e.code, e);
  }
  const dedupedEvents = [...dedupMap.values()];

  // 상태별 분류
  const byStatus = { VVI_FIRED: [], OVERHEATED: [], PRICE_ONLY: [], WAITING: [] };
  for (const e of dedupedEvents) byStatus[e.status].push(e);

  // 운영 보드 표시용 필드 부여
  // 메인 후보 (B/C) — 운영 노출
  for (const e of byStatus.VVI_FIRED) {
    e.displayGroupName  = '안정형 고점 재돌파';
    e.displayDescription = 'QVA 때 만든 고점을 다시 넘었고, 거래대금도 다시 붙었습니다. 아직 가격 부담이 상대적으로 낮은 후보입니다.';
    e.isTodayNewVvi = e.vviDate === todayDate;
    e.isMainCandidate = true;
  }
  for (const e of byStatus.OVERHEATED) {
    e.displayGroupName  = '강한 거래대금 재돌파';
    e.displayDescription = '이미 어느 정도 오른 상태지만, 거래대금이 강하게 다시 붙은 재돌파 후보입니다.';
    e.isTodayNewVvi = e.vviDate === todayDate;
    e.isMainCandidate = true;
  }
  // 참고/대기 (D/E) — 메인 후보 아님
  for (const e of byStatus.PRICE_ONLY) {
    e.displayGroupName  = '거래대금 부족 돌파 참고';
    e.displayDescription = 'QVA 때 만든 고점은 넘었지만, 거래량이나 거래대금이 아직 QVA 당일만큼 붙지 않은 후보입니다. 거래대금이 다시 붙으면 새 VVI 후보로 바뀔 수 있어 참고용으로만 표시합니다.';
    e.isTodayNewVvi = false;
    e.isMainCandidate = false;
  }
  for (const e of byStatus.WAITING) {
    e.displayGroupName  = '고점 재돌파 대기';
    e.displayDescription = '아직 QVA 때 만든 고점을 다시 넘지는 못했지만, 고점에 가까워졌거나 거래대금이 다시 붙는 후보입니다. 돌파 전 대기 후보로만 봅니다.';
    e.isTodayNewVvi = false;
    e.isMainCandidate = false;
  }

  // 안정형 고점 재돌파 정렬:
  // 1) vviDate 최신순  2) valueRatio 높은 순  3) currentFromQvaCloseRate 절대값 낮은 순
  const stableSorted = [...byStatus.VVI_FIRED].sort((a, b) => {
    if ((b.vviDate || '') !== (a.vviDate || '')) return (b.vviDate || '').localeCompare(a.vviDate || '');
    const va = a.vviValueRatio || 0, vb = b.vviValueRatio || 0;
    if (vb !== va) return vb - va;
    return Math.abs(a.currentFromQvaCloseRate || 0) - Math.abs(b.currentFromQvaCloseRate || 0);
  });

  // 강한 거래대금 재돌파 정렬:
  // 1) valueRatio 높은 순  2) vviDate 최신순  3) volumeRatio 높은 순  4) daysFromQvaToVvi 짧은 순
  const strongSorted = [...byStatus.OVERHEATED].sort((a, b) => {
    const va = a.vviValueRatio || 0, vb = b.vviValueRatio || 0;
    if (vb !== va) return vb - va;
    if ((b.vviDate || '') !== (a.vviDate || '')) return (b.vviDate || '').localeCompare(a.vviDate || '');
    const vola = a.vviVolumeRatio || 0, volb = b.vviVolumeRatio || 0;
    if (volb !== vola) return volb - vola;
    const da = a.daysFromQvaToVvi ?? 9999, db = b.daysFromQvaToVvi ?? 9999;
    return da - db;
  });

  // 오늘 신규 VVI = vviDate === todayDate (안정형 + 강한 거래대금 모두 포함)
  const todayNewSorted = [...byStatus.VVI_FIRED, ...byStatus.OVERHEATED]
    .filter((e) => e.vviDate === todayDate)
    .sort((a, b) => (b.vviValueRatio || 0) - (a.vviValueRatio || 0));

  // 거래대금 부족 돌파 참고(D) 정렬:
  // 1) valueFillRatio 높은 순  2) volumeFillRatio 높은 순  3) priceOnlyDate 최신순  4) currentFromQvaCloseRate 작은(덜 오른) 순
  const valueInsufSorted = [...byStatus.PRICE_ONLY].sort((a, b) => {
    const va = a.valueFillRatio || 0, vb = b.valueFillRatio || 0;
    if (vb !== va) return vb - va;
    const vola = a.volumeFillRatio || 0, volb = b.volumeFillRatio || 0;
    if (volb !== vola) return volb - vola;
    if ((b.priceOnlyDate || '') !== (a.priceOnlyDate || '')) return (b.priceOnlyDate || '').localeCompare(a.priceOnlyDate || '');
    return (a.currentFromQvaCloseRate || 0) - (b.currentFromQvaCloseRate || 0);
  });

  // 고점 재돌파 대기(E) 정렬:
  // 1) distanceToQvaHighRate 작은 순 (남은 거리 짧음)  2) highDistanceToQvaHighRate 작은 순 (최근 고가가 가까움)
  // 3) currentValueRatio 높은 순 (거래대금 다시 붙음)  4) qvaSignalDate 최신순
  const waitingSorted = [...byStatus.WAITING].sort((a, b) => {
    const da = a.distanceToQvaHighRate ?? 9999, db = b.distanceToQvaHighRate ?? 9999;
    if (da !== db) return da - db;
    const ha = a.highDistanceToQvaHighRate ?? 9999, hb = b.highDistanceToQvaHighRate ?? 9999;
    if (ha !== hb) return ha - hb;
    const va = a.currentValueRatio || 0, vb = b.currentValueRatio || 0;
    if (vb !== va) return vb - va;
    return (b.qvaSignalDate || '').localeCompare(a.qvaSignalDate || '');
  });

  // 표시 limits — 메인 후보 (B/C) 상위 20, 참고/대기 (D/E) 상위 10, 오늘 신규 상위 10
  const SECTION_LIMIT = 20;
  const TODAY_NEW_LIMIT = 10;
  const VALUE_INSUF_LIMIT = 10;
  const WAITING_LIMIT = 10;
  const stableTopList     = stableSorted.slice(0, SECTION_LIMIT);
  const strongTopList     = strongSorted.slice(0, SECTION_LIMIT);
  const todayNewList      = todayNewSorted.slice(0, TODAY_NEW_LIMIT);
  const valueInsufTopList = valueInsufSorted.slice(0, VALUE_INSUF_LIMIT);
  const waitingTopList    = waitingSorted.slice(0, WAITING_LIMIT);

  // 요약 카운트 (운영 보드 spec)
  const counts = {
    totalQvaEvents: qvaSignals.length,
    qvaSignalsInLookback: events.length,
    marketCapFilteredOut: marketCapFiltered,
    dedupedCandidates: dedupedEvents.length,
    newVviTotal: byStatus.VVI_FIRED.length + byStatus.OVERHEATED.length,
    stableBreakoutCount: byStatus.VVI_FIRED.length,
    strongValueBreakoutCount: byStatus.OVERHEATED.length,
    excludedValueInsufficientCount: byStatus.PRICE_ONLY.length,
    waitingCount: byStatus.WAITING.length,
    todayNewVviCount: todayNewSorted.length,
  };

  const out = {
    meta: {
      title: '새 VVI 후보 보드',
      subtitle: 'QVA 때 만든 고점을 다시 넘었고, 그때만큼 거래량과 거래대금이 다시 붙은 후보를 보여줍니다.',
      generatedAt: new Date().toISOString(),
      lookbackDays: VVI_LOOKBACK_DAYS,
      sectionLimit: SECTION_LIMIT,
      todayNewLimit: TODAY_NEW_LIMIT,
      maxMarketCap: MAX_MARKET_CAP,
      analysisDate: todayDate,
      analysisDateFmt: todayDate ? fmtDate(todayDate) : null,
      definition: 'VVI = QVA 고가 재돌파 + QVA 이상 거래량 + QVA 이상 거래대금. 셋 다 만족하는 첫 거래일.',
      overheatThreshold: { fromQvaCloseRate: OVERHEAT_FROM_QVA_PCT, fromVviCloseRate: OVERHEAT_FROM_VVI_PCT },
      backtestSummary: {
        stable:  { D10AvgHigh: 14.94, D10HitPlus10: 48.8, D10Fail10: 23.3, D10ClosePos: 53.5 },
        strong:  { D10AvgHigh: 46.83, D10MedianHigh: 37.04, D10HitPlus20: 90.6, D10Fail10: 9.4 },
      },
    },
    limits: {
      stableLimit: SECTION_LIMIT,
      strongLimit: SECTION_LIMIT,
      todayNewLimit: TODAY_NEW_LIMIT,
      valueInsufficientLimit: VALUE_INSUF_LIMIT,
      waitingLimit: WAITING_LIMIT,
    },
    counts,
    visibleGroups: {
      stableBreakoutCandidates:           stableTopList,
      strongValueBreakoutCandidates:      strongTopList,
      valueInsufficientPreviewCandidates: valueInsufTopList,
      waitingPreviewCandidates:           waitingTopList,
    },
    todayNewVvi: todayNewList,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out)), 'utf-8');

  // DB 저장 (실패해도 HTML/JSON은 정상)
  try {
    const { saveQvaVviRedefinedBoardToDB } = require('../../src/db/saveBoardSignals');
    const r = await saveQvaVviRedefinedBoardToDB(out, { jsonPath: OUT_JSON, htmlPath: OUT_HTML });
    if (r) console.log(`  🗄  DB 저장: runId=${r.runId} rows=${r.totalRows} (inserted=${r.inserted} updated=${r.updated})`);
  } catch (e) {
    console.warn(`  ⚠ DB 저장 실패 (HTML/JSON은 정상 저장됨): ${e.message}`);
  } finally {
    try { await require('../../src/db/mysql').closePool(); } catch (_) {}
  }

  console.log(`\n  최근 ${VVI_LOOKBACK_DAYS}거래일 안 QVA: ${counts.qvaSignalsInLookback}건 → 종목별 dedup ${counts.dedupedCandidates}건`);
  console.log(`    🟢 안정형 고점 재돌파:     ${counts.stableBreakoutCount}건 → 상위 ${stableTopList.length}건 표시 (메인 후보)`);
  console.log(`    🌟 강한 거래대금 재돌파:    ${counts.strongValueBreakoutCount}건 → 상위 ${strongTopList.length}건 표시 (메인 후보)`);
  console.log(`    📅 오늘 신규 VVI:         ${counts.todayNewVviCount}건 → 상위 ${todayNewList.length}건 표시 (B+C 합산)`);
  console.log(`    ────────────────────────`);
  console.log(`    ⚠️  거래대금 부족 돌파 참고: ${counts.excludedValueInsufficientCount}건 → 상위 ${valueInsufTopList.length}건 표시 (참고용)`);
  console.log(`    ⏳ 고점 재돌파 대기:        ${counts.waitingCount}건 → 상위 ${waitingTopList.length}건 표시 (대기)`);
  if (stableTopList.length > 0) {
    console.log(`\n  ── 안정형 고점 재돌파 상위 ${Math.min(10, stableTopList.length)} ──`);
    for (const e of stableTopList.slice(0, 10)) {
      console.log(`    ${fmtDate(e.qvaSignalDate)} → ${fmtDate(e.vviDate)}  | ${e.code} ${(e.name || '').padEnd(13)} | days ${e.daysFromQvaToVvi} | valueRatio ×${(e.vviValueRatio || 0).toFixed(2)} / volumeRatio ×${(e.vviVolumeRatio || 0).toFixed(2)} | QVA→현재 ${(e.currentFromQvaCloseRate || 0).toFixed(1)}%`);
    }
  }
  if (strongTopList.length > 0) {
    console.log(`\n  ── 강한 거래대금 재돌파 상위 ${Math.min(10, strongTopList.length)} ──`);
    for (const e of strongTopList.slice(0, 10)) {
      console.log(`    ${fmtDate(e.qvaSignalDate)} → ${fmtDate(e.vviDate)}  | ${e.code} ${(e.name || '').padEnd(13)} | days ${e.daysFromQvaToVvi} | valueRatio ×${(e.vviValueRatio || 0).toFixed(2)} / volumeRatio ×${(e.vviVolumeRatio || 0).toFixed(2)} | QVA→현재 ${(e.currentFromQvaCloseRate || 0).toFixed(1)}%`);
    }
  }
  if (valueInsufTopList.length > 0) {
    console.log(`\n  ── 거래대금 부족 돌파 참고 상위 ${valueInsufTopList.length} (참고용) ──`);
    for (const e of valueInsufTopList) {
      console.log(`    ${fmtDate(e.qvaSignalDate)} → ${fmtDate(e.priceOnlyDate)}  | ${e.code} ${(e.name || '').padEnd(13)} | 거래대금 충족률 ${((e.valueFillRatio || 0) * 100).toFixed(0)}% / 거래량 충족률 ${((e.volumeFillRatio || 0) * 100).toFixed(0)}% | QVA→현재 ${(e.currentFromQvaCloseRate || 0).toFixed(1)}%`);
    }
  }
  if (waitingTopList.length > 0) {
    console.log(`\n  ── 고점 재돌파 대기 상위 ${waitingTopList.length} (대기) ──`);
    for (const e of waitingTopList) {
      console.log(`    ${fmtDate(e.qvaSignalDate)}  | ${e.code} ${(e.name || '').padEnd(13)} | QVA 고점까지 ${(e.distanceToQvaHighRate || 0).toFixed(1)}% 남음 / 최근 고가 도달 ${(e.highDistanceToQvaHighRate || 0).toFixed(1)}% 남았음 | 거래대금 ×${(e.currentValueRatio || 0).toFixed(2)}`);
    }
  }
  console.log(`  total elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

// ── HTML 템플릿 ──
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>QVA 고점 재돌파 후보</title>
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
.purpose-box { background: #0f172a; border-left: 3px solid #14b8a6; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #5eead4; }

.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.summary-cell { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.summary-cell .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.summary-cell .value { font-size: 20px; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; margin-top: 4px; }
.summary-cell .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
.summary-cell.fired { border-left: 4px solid #14b8a6; }
.summary-cell.waiting { border-left: 4px solid #94a3b8; }
.summary-cell.price-only { border-left: 4px solid #f59e0b; }
.summary-cell.overheated { border-left: 4px solid #ef4444; }
.summary-cell.today { border-left: 4px solid #3b82f6; }

.card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
.card.s-VVI_FIRED  { border-left: 6px solid #14b8a6; }
.card.s-WAITING    { border-left: 4px solid #94a3b8; }
.card.s-PRICE_ONLY { border-left: 4px solid #f59e0b; }
.card.s-OVERHEATED { border-left: 4px solid #ef4444; opacity: 0.92; }
.card h3 { margin: 0 0 6px; font-size: 15px; color: #f1f5f9; font-weight: 700; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.card h3 .code { color: #64748b; font-size: 12px; font-weight: 400; }
.card h3 a.name-link { color: #f1f5f9; text-decoration: none; border-bottom: 1px dashed transparent; }
.card h3 a.name-link:hover { color: #5eead4; border-bottom-color: #5eead4; }
.card h3 .market { color: #94a3b8; font-size: 11px; font-weight: 400; padding: 1px 6px; border: 1px solid #334155; border-radius: 4px; }
.card .status-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; border: 1px solid; }
.card.s-VVI_FIRED .status-badge  { background: #042f2e; color: #5eead4; border-color: #14b8a6; }
.card.s-WAITING .status-badge    { background: #1e293b; color: #cbd5e1; border-color: #475569; }
.card.s-PRICE_ONLY .status-badge { background: #422006; color: #fde68a; border-color: #f59e0b; }
.card.s-OVERHEATED .status-badge { background: #7f1d1d; color: #fca5a5; border-color: #ef4444; }

.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin: 8px 0; }
.metric { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 7px 10px; }
.metric .label { font-size: 10px; color: #94a3b8; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.3px; }
.metric .value { font-size: 14px; font-weight: 600; color: #e2e8f0; font-variant-numeric: tabular-nums; }
.metric .sub { font-size: 10px; color: #64748b; margin-top: 2px; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-warn { color: #fbbf24; }

.summary-line { margin-top: 8px; padding: 8px 12px; background: #0f172a; border-left: 2px solid #38bdf8; border-radius: 4px; font-size: 12px; line-height: 1.7; color: #cbd5e1; }

/* 참고/대기 (D/E) 카드 — 메인 후보보다 약하게 표현 */
.preview-note { background: #0f172a; border-left: 2px solid #475569; padding: 8px 12px; border-radius: 4px; font-size: 12px; color: #94a3b8; line-height: 1.7; margin-bottom: 10px; }
.card.preview { background: #161e2e; border: 1px solid #2d3a4f; padding: 10px 14px; opacity: 0.88; }
.card.preview.s-PRICE_ONLY { border-left: 3px solid #94a3b8; }
.card.preview.s-WAITING    { border-left: 3px solid #64748b; }
.card.preview h3 { font-size: 13px; color: #cbd5e1; }
.card.preview .metric { padding: 5px 8px; }
.card.preview .metric .value { font-size: 12px; }
.card.preview .summary-line { background: #0d1424; border-left-color: #475569; color: #94a3b8; }
.card .badge-ref  { background: #1e293b; color: #cbd5e1; border-color: #64748b; }
.card .badge-wait { background: #1e293b; color: #cbd5e1; border-color: #64748b; }

h2.section-soft { color: #94a3b8; font-size: 14px; }

details.section { margin-bottom: 16px; }
details.section > summary { cursor: pointer; font-size: 14px; font-weight: 700; color: #cbd5e1; padding: 10px 14px; user-select: none; background: #0f172a; border-radius: 8px; border: 1px solid #1e293b; }
details.section > .section-body { padding: 12px 6px; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #cbd5e1; }
.empty { padding: 20px; background: #1e293b; border-radius: 6px; color: #64748b; text-align: center; font-size: 12px; }
</style>
</head>
<body>
<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
  <div style="background:linear-gradient(90deg,#064e3b 0%,#065f46 100%);border:1px solid #10b981;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#a7f3d0;font-weight:700;letter-spacing:0.3px;">🟢 운영 보드</span><a href="/qva2-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR</a><a href="/qva2-d5-rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파</a><a href="/qva2-vvi" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파</a></div>
  <div style="background:linear-gradient(90deg,#1e1b4b 0%,#312e81 100%);border:1px solid #6366f1;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#c4b5fd;font-weight:700;letter-spacing:0.3px;">🟣 실험 라인</span><a href="/one-day-surge-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">⚡ 1DS 단타 후보</a></div>
  <div style="background:linear-gradient(90deg,#1e293b 0%,#334155 100%);border:1px solid #64748b;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;opacity:0.92;"><span style="color:#cbd5e1;font-weight:700;letter-spacing:0.3px;">📜 과거 보드</span><a href="/qva-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR (구)</a><a href="/rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파 (구)</a><a href="/qva-vvi-redefined-board" style="color:#fff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.22);border:1px solid #fff;font-weight:700;">🎯 고점 재돌파 (구)</a></div>
  <div style="background:linear-gradient(90deg,#042f2e 0%,#134e4a 100%);border:1px solid #14b8a6;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#5eead4;font-weight:700;letter-spacing:0.3px;">📊 통합 보기</span><a href="/db-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🗄 DB 신호 운영판</a></div>
</div>

<h1 id="board-title">🎯 새 VVI 후보 보드</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  <strong>새 VVI 정의:</strong> QVA 때 만든 고점을 다시 넘었고, 그때만큼 거래량과 거래대금이 다시 붙은 후보.<br>
  메인 후보는 <strong>"안정형 고점 재돌파"</strong> · <strong>"강한 거래대금 재돌파"</strong> 두 그룹입니다.
  그 아래에 참고용 <strong>"거래대금 부족 돌파 참고"</strong>와 대기용 <strong>"고점 재돌파 대기"</strong>를 약하게 표시합니다 — 메인 후보가 아니므로 약한 색으로 보입니다.<br>
  <strong style="color:#fbbf24;">시가총액 필터:</strong> <span id="market-cap-filter-info"></span><br>
  <span style="font-size:11.5px;color:#94a3b8;">
    <strong>과거 검증상 이런 흐름이 많았다는 뜻입니다.</strong> 실제 진입과 대응은 본인의 판단입니다.
  </span>
</div>

<h2>📊 화면 요약</h2>
<div class="summary-grid" id="summary-grid"></div>

<h2>📅 오늘 신규 VVI <span id="today-new-count" style="color:#64748b;font-size:13px;font-weight:400;"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">오늘 새로 VVI 조건을 만족한 후보 (안정형 + 강한 거래대금 모두 포함, 최대 10개).</div>
<div id="today-new-host"></div>

<h2>🟢 안정형 고점 재돌파 <span id="stable-count" style="color:#64748b;font-size:13px;font-weight:400;"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;line-height:1.6;">
  <strong>1차 백테스트 기준:</strong> D+10 평균 고가 +14.9%, +10% 도달률 48.8%, -10% 하락률 23.3%, 종가 플러스율 53.5%.<br>
  <span style="color:#64748b;">과거 검증상 이런 흐름이 많았다는 뜻이며, 실제 진입과 대응은 본인의 판단입니다.</span>
</div>
<div id="stable-host"></div>

<h2>🌟 강한 거래대금 재돌파 <span id="strong-count" style="color:#64748b;font-size:13px;font-weight:400;"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;line-height:1.6;">
  <strong>1차 백테스트 기준:</strong> D+10 평균 고가 +46.8%, 중앙값 +37.0%, +20% 도달률 90.6%, -10% 하락률 9.4%.<br>
  <span style="color:#64748b;">이미 어느 정도 오른 상태지만 거래대금이 강하게 다시 붙은 유형 — 후속 상승이 강하게 나왔던 패턴.
    과거 검증상 이런 흐름이 많았다는 뜻이며, 실제 진입과 대응은 본인의 판단입니다.</span>
</div>
<div id="strong-host"></div>

<h2 class="section-soft">⚠️ 거래대금 부족 돌파 참고 후보 <span id="value-insuf-count" style="color:#64748b;font-size:13px;font-weight:400;"></span></h2>
<div class="preview-note">
  QVA 때 만든 고점은 넘었지만, 거래량이나 거래대금이 아직 QVA 당일만큼 붙지 않은 후보입니다.
  거래대금이 다시 붙으면 새 VVI 후보로 바뀔 수 있어 <strong>참고용</strong>으로만 표시합니다.
</div>
<div id="value-insuf-host"></div>

<h2 class="section-soft">⏳ 고점 재돌파 대기 후보 <span id="waiting-count" style="color:#64748b;font-size:13px;font-weight:400;"></span></h2>
<div class="preview-note">
  아직 QVA 때 만든 고점을 다시 넘지는 못했지만, 고점에 가까워졌거나 거래대금이 다시 붙는 후보입니다.
  돌파 전 <strong>대기 후보</strong>로만 봅니다.
</div>
<div id="waiting-host"></div>

<footer class="foot" id="foot"></footer>

<script>
const DATA = __JSON_DATA__;
function isNum(v) { return v != null && Number.isFinite(v); }
function fmtPct(v, p) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(p || 2) + '%' : '-'; }
function fmtNum(v) { return isNum(v) ? Math.round(v).toLocaleString() : '-'; }
function fmtMoney(v) {
  if (!isNum(v) || v === 0) return '-';
  if (v >= 1e12) return (v/1e12).toFixed(2) + '조';
  if (v >= 1e8)  return (v/1e8).toFixed(1) + '억';
  if (v >= 1e4)  return (v/1e4).toFixed(0) + '만';
  return Math.round(v).toLocaleString();
}
function fmtDate(d) { if (!d || String(d).length !== 8) return d || '-'; const s = String(d); return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8); }
function fmtRatio(v) { return isNum(v) ? '×' + v.toFixed(2) : '-'; }

document.getElementById('subtitle').innerHTML =
  '분석 기준일: <strong style="color:#5eead4;">' + (DATA.meta.analysisDateFmt || '-') + '</strong>' +
  ' · 최근 ' + DATA.meta.lookbackDays + '거래일 안 QVA 신호 ' + DATA.counts.qvaSignalsInLookback + '건' +
  ' (전체 ' + DATA.counts.totalQvaEvents + ', 종목 dedup ' + DATA.counts.dedupedCandidates + ')' +
  ' · 생성: ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

(function fillMarketCapFilterInfo() {
  const host = document.getElementById('market-cap-filter-info');
  if (!host) return;
  const cap = DATA.meta.maxMarketCap;
  const filtered = DATA.counts.marketCapFilteredOut || 0;
  const capLabel = cap >= 1e12 ? (cap / 1e12).toFixed(1).replace(/\.0$/, '') + '조' : (cap / 1e8).toFixed(0) + '억';
  host.innerHTML = '시가총액 ' + capLabel + ' 이하만 후보로. ' +
    '시총이 더 큰 종목은 <strong>' + filtered + '건 제외</strong>됐습니다.';
})();

(function renderSummary() {
  const c = DATA.counts;
  const lim = DATA.limits || {};
  const vg  = DATA.visibleGroups || {};
  const stableShown = (vg.stableBreakoutCandidates || []).length;
  const strongShown = (vg.strongValueBreakoutCandidates || []).length;
  const valueInsufShown = (vg.valueInsufficientPreviewCandidates || []).length;
  const waitingShown    = (vg.waitingPreviewCandidates || []).length;
  const todayShown      = (DATA.todayNewVvi || []).length;
  const cells = [
    { lab: '오늘 신규 VVI',           val: c.todayNewVviCount,                sub: '전체 ' + c.todayNewVviCount + '건 중 상위 ' + todayShown + '건 표시', cls: 'today' },
    { lab: '안정형 고점 재돌파',       val: c.stableBreakoutCount,             sub: '전체 ' + c.stableBreakoutCount + '건 중 상위 ' + stableShown + '건 표시', cls: 'fired' },
    { lab: '강한 거래대금 재돌파',     val: c.strongValueBreakoutCount,        sub: '전체 ' + c.strongValueBreakoutCount + '건 중 상위 ' + strongShown + '건 표시', cls: 'overheated' },
    { lab: '거래대금 부족 돌파 참고',  val: c.excludedValueInsufficientCount,  sub: '전체 ' + c.excludedValueInsufficientCount + '건 중 상위 ' + valueInsufShown + '건 표시 (참고용)', cls: 'price-only' },
    { lab: '고점 재돌파 대기',         val: c.waitingCount,                    sub: '전체 ' + c.waitingCount + '건 중 상위 ' + waitingShown + '건 표시 (대기)', cls: 'waiting' },
    { lab: 'QVA 신호 (윈도우)',       val: c.qvaSignalsInLookback,            sub: '종목 dedup ' + c.dedupedCandidates },
  ];
  document.getElementById('summary-grid').innerHTML = cells.map(c =>
    '<div class="summary-cell ' + (c.cls || '') + '"><div class="label">' + c.lab + '</div>' +
    '<div class="value">' + c.val + '</div>' +
    '<div class="sub">' + c.sub + '</div></div>'
  ).join('');
})();

function buildSummaryLineFor(it) {
  if (it.displayDescription) return it.displayDescription;
  return '';
}

function buildCardHtml(it) {
  const valueRatio = isNum(it.vviValueRatio) ? fmtRatio(it.vviValueRatio) : '-';
  const volumeRatio = isNum(it.vviVolumeRatio) ? fmtRatio(it.vviVolumeRatio) : '-';
  const ratioCls = (r) => isNum(r) ? (r >= 1.5 ? 'cell-pos' : (r >= 1 ? '' : 'cell-warn')) : '';
  const groupBadge = '<span class="status-badge">' + (it.displayGroupName || it.statusLabel || '') + '</span>';
  const todayBadge = it.isTodayNewVvi
    ? '<span class="status-badge" style="background:#1e3a8a;color:#bfdbfe;border-color:#3b82f6;">📅 오늘 신규 VVI</span>'
    : '';
  return '<div class="card s-' + it.status + '">' +
    '<h3><a class="name-link" href="/qva-vvi-redefined/' + it.code + '">' + (it.name || '-') + '</a> <span class="code">' + it.code + '</span> <span class="market">' + (it.market || '-') + '</span> ' +
      groupBadge + ' ' + todayBadge + '</h3>' +
    '<div class="metrics-grid">' +
      '<div class="metric"><div class="label">QVA 때 만든 고점</div><div class="value">' + fmtNum(it.qvaHigh) + '원</div><div class="sub">' + fmtDate(it.qvaSignalDate) + ' 종가 ' + fmtNum(it.qvaClose) + '</div></div>' +
      '<div class="metric"><div class="label">재돌파일 고가</div><div class="value">' + (it.vviHigh ? fmtNum(it.vviHigh) + '원' : '-') + '</div><div class="sub">' + (it.vviDate ? fmtDate(it.vviDate) + ' 종가 ' + fmtNum(it.vviClose) : '-') + '</div></div>' +
      '<div class="metric"><div class="label">QVA → VVI 거래일</div><div class="value">' + (isNum(it.daysFromQvaToVvi) ? it.daysFromQvaToVvi + '거래일' : '-') + '</div><div class="sub">짧을수록 강한 신호</div></div>' +
      '<div class="metric"><div class="label">거래대금 배율</div><div class="value ' + ratioCls(it.vviValueRatio) + '">' + valueRatio + '</div><div class="sub">QVA ' + fmtMoney(it.qvaValue) + ' → VVI ' + fmtMoney(it.vviValue) + '</div></div>' +
      '<div class="metric"><div class="label">거래량 배율</div><div class="value ' + ratioCls(it.vviVolumeRatio) + '">' + volumeRatio + '</div><div class="sub">QVA ' + fmtNum(it.qvaVolume) + ' → VVI ' + fmtNum(it.vviVolume) + '</div></div>' +
      '<div class="metric"><div class="label">QVA 종가 대비 현재 위치</div><div class="value ' + (isNum(it.currentFromQvaCloseRate) && it.currentFromQvaCloseRate > 0 ? 'cell-pos' : 'cell-neg') + '">' + fmtPct(it.currentFromQvaCloseRate, 1) + '</div><div class="sub">' + fmtNum(it.qvaClose) + '원 → ' + fmtNum(it.currentClose) + '원</div></div>' +
      '<div class="metric"><div class="label">시가총액</div><div class="value">' + fmtMoney(it.marketValue) + '원</div><div class="sub">' + (it.market || '-') + '</div></div>' +
      (isNum(it.vviCloseFromQvaCloseRate) ? '<div class="metric"><div class="label">VVI 종가 vs QVA 종가</div><div class="value ' + (it.vviCloseFromQvaCloseRate > 0 ? 'cell-pos' : 'cell-neg') + '">' + fmtPct(it.vviCloseFromQvaCloseRate, 1) + '</div><div class="sub">재돌파일 종가 위치</div></div>' : '') +
    '</div>' +
    '<div class="summary-line">💡 ' + buildSummaryLineFor(it) + '</div>' +
  '</div>';
}

function renderHost(hostId, list, emptyMsg) {
  const host = document.getElementById(hostId);
  if (!host) return;
  if (!list || list.length === 0) { host.innerHTML = '<div class="empty">' + (emptyMsg || '해당 후보 없음') + '</div>'; return; }
  host.innerHTML = list.map(buildCardHtml).join('');
}

// 거래대금 부족 돌파 참고 (D그룹) — 메인 후보 아님, 작은 회색 카드
function buildValueInsufCardHtml(it) {
  const valueFillPct  = isNum(it.valueFillRatio)  ? Math.round(it.valueFillRatio  * 100) : null;
  const volumeFillPct = isNum(it.volumeFillRatio) ? Math.round(it.volumeFillRatio * 100) : null;
  return '<div class="card preview s-PRICE_ONLY">' +
    '<h3><a class="name-link" href="/qva-vvi-redefined/' + it.code + '">' + (it.name || '-') + '</a> <span class="code">' + it.code + '</span> <span class="market">' + (it.market || '-') + '</span> ' +
      '<span class="status-badge badge-ref">⚠️ 거래대금 부족 돌파 참고</span> ' +
      '<span class="status-badge badge-ref">참고용</span></h3>' +
    '<div class="metrics-grid">' +
      '<div class="metric"><div class="label">QVA 발생일</div><div class="value">' + fmtDate(it.qvaSignalDate) + '</div><div class="sub">QVA 종가 ' + fmtNum(it.qvaClose) + '원</div></div>' +
      '<div class="metric"><div class="label">가격 돌파일</div><div class="value">' + fmtDate(it.priceOnlyDate) + '</div><div class="sub">돌파일 고가 ' + fmtNum(it.priceOnlyHigh) + '원</div></div>' +
      '<div class="metric"><div class="label">QVA 때 만든 고점</div><div class="value">' + fmtNum(it.qvaHigh) + '원</div></div>' +
      '<div class="metric"><div class="label">거래대금 충족률</div><div class="value cell-warn">' + (valueFillPct != null ? valueFillPct + '%' : '-') + '</div><div class="sub">QVA 당일 대비</div></div>' +
      '<div class="metric"><div class="label">거래량 충족률</div><div class="value cell-warn">' + (volumeFillPct != null ? volumeFillPct + '%' : '-') + '</div><div class="sub">QVA 당일 대비</div></div>' +
      '<div class="metric"><div class="label">QVA 종가 대비 현재 위치</div><div class="value ' + (isNum(it.currentFromQvaCloseRate) && it.currentFromQvaCloseRate > 0 ? 'cell-pos' : 'cell-neg') + '">' + fmtPct(it.currentFromQvaCloseRate, 1) + '</div><div class="sub">현재 ' + fmtNum(it.currentClose) + '원</div></div>' +
      '<div class="metric"><div class="label">시가총액</div><div class="value">' + fmtMoney(it.marketValue) + '원</div><div class="sub">' + (it.market || '-') + '</div></div>' +
    '</div>' +
    '<div class="summary-line">💡 아직 새 VVI 조건 미충족 — 거래대금이 다시 붙으면 새 VVI 후보로 바뀔 수 있어요.</div>' +
  '</div>';
}

// 고점 재돌파 대기 (E그룹) — 메인 후보 아님, 작은 회색 카드
function buildWaitingCardHtml(it) {
  return '<div class="card preview s-WAITING">' +
    '<h3><a class="name-link" href="/qva-vvi-redefined/' + it.code + '">' + (it.name || '-') + '</a> <span class="code">' + it.code + '</span> <span class="market">' + (it.market || '-') + '</span> ' +
      '<span class="status-badge badge-wait">⏳ 고점 재돌파 대기</span> ' +
      '<span class="status-badge badge-wait">대기 후보</span></h3>' +
    '<div class="metrics-grid">' +
      '<div class="metric"><div class="label">QVA 발생일</div><div class="value">' + fmtDate(it.qvaSignalDate) + '</div><div class="sub">QVA 종가 ' + fmtNum(it.qvaClose) + '원</div></div>' +
      '<div class="metric"><div class="label">QVA 때 만든 고점</div><div class="value">' + fmtNum(it.qvaHigh) + '원</div></div>' +
      '<div class="metric"><div class="label">현재 종가</div><div class="value">' + fmtNum(it.currentClose) + '원</div><div class="sub">' + fmtDate(it.currentDate) + '</div></div>' +
      '<div class="metric"><div class="label">QVA 고점까지 남은 거리</div><div class="value cell-warn">' + (isNum(it.distanceToQvaHighRate) ? it.distanceToQvaHighRate.toFixed(1) + '% 남음' : '-') + '</div><div class="sub">아직 재돌파 전</div></div>' +
      '<div class="metric"><div class="label">최근 고가 도달거리</div><div class="value">' + (isNum(it.highDistanceToQvaHighRate) ? it.highDistanceToQvaHighRate.toFixed(1) + '% 남음' : '-') + '</div><div class="sub">QVA 이후 만든 최고가 기준</div></div>' +
      '<div class="metric"><div class="label">거래대금 배율</div><div class="value">' + (isNum(it.currentValueRatio) ? '×' + it.currentValueRatio.toFixed(2) : '-') + '</div><div class="sub">QVA 당일 대비 현재</div></div>' +
      '<div class="metric"><div class="label">QVA 종가 대비 현재 위치</div><div class="value ' + (isNum(it.currentFromQvaCloseRate) && it.currentFromQvaCloseRate > 0 ? 'cell-pos' : 'cell-neg') + '">' + fmtPct(it.currentFromQvaCloseRate, 1) + '</div></div>' +
      '<div class="metric"><div class="label">시가총액</div><div class="value">' + fmtMoney(it.marketValue) + '원</div><div class="sub">' + (it.market || '-') + '</div></div>' +
    '</div>' +
    '<div class="summary-line">💡 아직 새 VVI 조건 미충족 — QVA 고점을 다시 넘는지 지켜보는 단계입니다.</div>' +
  '</div>';
}

function renderHostWith(hostId, list, builder, emptyMsg) {
  const host = document.getElementById(hostId);
  if (!host) return;
  if (!list || list.length === 0) { host.innerHTML = '<div class="empty">' + (emptyMsg || '해당 후보 없음') + '</div>'; return; }
  host.innerHTML = list.map(builder).join('');
}

// 메인 후보 (B/C) + 오늘 신규
const stableShown     = (DATA.visibleGroups.stableBreakoutCandidates || []).length;
const strongShown     = (DATA.visibleGroups.strongValueBreakoutCandidates || []).length;
const valueInsufShown = (DATA.visibleGroups.valueInsufficientPreviewCandidates || []).length;
const waitingShown    = (DATA.visibleGroups.waitingPreviewCandidates || []).length;
const todayShown      = (DATA.todayNewVvi || []).length;

document.getElementById('today-new-count').textContent =
  '(전체 ' + (DATA.counts.todayNewVviCount || 0) + '건 중 상위 ' + todayShown + '건 표시 · B+C 합산)';
renderHost('today-new-host', DATA.todayNewVvi, '오늘자 신규 VVI 없음.');

document.getElementById('stable-count').textContent =
  '(전체 ' + (DATA.counts.stableBreakoutCount || 0) + '건 중 상위 ' + stableShown + '건 표시)';
renderHost('stable-host', DATA.visibleGroups.stableBreakoutCandidates, '안정형 고점 재돌파 후보 없음.');

document.getElementById('strong-count').textContent =
  '(전체 ' + (DATA.counts.strongValueBreakoutCount || 0) + '건 중 상위 ' + strongShown + '건 표시)';
renderHost('strong-host', DATA.visibleGroups.strongValueBreakoutCandidates, '강한 거래대금 재돌파 후보 없음.');

// 참고/대기 (D/E) — 메인 후보 아님, 작은 회색 카드
document.getElementById('value-insuf-count').textContent =
  '(전체 ' + (DATA.counts.excludedValueInsufficientCount || 0) + '건 중 상위 ' + valueInsufShown + '건 표시 · 참고용)';
renderHostWith('value-insuf-host', DATA.visibleGroups.valueInsufficientPreviewCandidates, buildValueInsufCardHtml, '거래대금 부족 돌파 참고 후보 없음.');

document.getElementById('waiting-count').textContent =
  '(전체 ' + (DATA.counts.waitingCount || 0) + '건 중 상위 ' + waitingShown + '건 표시 · 대기)';
renderHostWith('waiting-host', DATA.visibleGroups.waitingPreviewCandidates, buildWaitingCardHtml, '고점 재돌파 대기 후보 없음.');

document.getElementById('foot').innerHTML =
  '<strong>새 VVI 정의 (이번 보드 한정):</strong><br>' +
  '• QVA 발생일 (high, volume, value) 저장 → 그 이후 첫 번째 거래일 중 high &gt; qvaHigh AND volume ≥ qvaVolume AND value ≥ qvaValue 만족하는 날.<br>' +
  '• 횡보 유지 / 종가 위치 / H그룹 / 기존 재돌파 조건 없음 — 단순 정의로 시작.<br>' +
  '<br><strong>화면 구성:</strong><br>' +
  '• <strong>메인 후보</strong>: 안정형 고점 재돌파 / 강한 거래대금 재돌파 (각 상위 20건)<br>' +
  '• <strong>참고/대기</strong>: 거래대금 부족 돌파 참고 / 고점 재돌파 대기 (각 상위 10건, 메인 후보 아님)<br>' +
  '<br><strong>과거 검증상 이런 흐름이 많았다는 뜻이며, 실제 진입과 대응은 본인의 판단입니다.</strong>';
</script>
</body>
</html>
`;

if (require.main === module) main().catch(e => { console.error('FATAL:', e); process.exit(1); });

module.exports = { analyzeVvi, loadQvaSignals };
