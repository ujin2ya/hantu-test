#!/usr/bin/env node
/**
 * 새 VVI 정의 1차 백테스트
 *
 * 목적:
 *   새 VVI 정의 (QVA 고가 재돌파 + QVA 이상 거래량 + QVA 이상 거래대금)이 실제로
 *   상승 구간을 만드는지 단순 검증. 5 그룹 비교.
 *
 * 그룹:
 *   A. 새 VVI 발생 (전체)
 *   B. 새 VVI 발생 + 추격 부담 제외
 *   C. 추격 부담 후보 (VVI 발생했으나 QVA 종가 +25% 또는 VVI 후 +20%)
 *   D. 거래대금 부족 돌파 (가격은 넘었지만 거래량/거래대금 부족)
 *   E. VVI 대기 (참고)
 *
 * 진입 기준일·기준 가격:
 *   A/B/C: VVI 발생일 종가
 *   D:     가격만 돌파한 첫날 종가
 *   E:     분석 기준일 종가 (참고용)
 *
 * 출력:
 *   - reports/qva-vvi-redefined-backtest-result.json
 *   - reports/qva-vvi-redefined-backtest-result.html
 *
 * 라우트: GET /qva-vvi-redefined-backtest
 *
 * 환경변수:
 *   - BACKTEST_LOOKBACK_DAYS (기본 60): QVA 신호 윈도우 (calendar 기준 대략 환산)
 *
 * 향후 파일 관리:
 *   새 VVI 백테스트 관련은 이 파일 1개만 사용. v2/final/new 사본 만들지 않음.
 *   새 실험은 같은 파일에 섹션 추가/덮어쓰기.
 */

const fs = require('fs');
const path = require('path');
const board = require('./qva-vvi-redefined-board');

const ROOT = __dirname;
const CHART_DIR    = path.join(ROOT, 'cache', 'stock-charts-long');
const REPORTS_DIR  = path.join(ROOT, 'reports');
const OUT_JSON = path.join(REPORTS_DIR, 'qva-vvi-redefined-backtest-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'qva-vvi-redefined-backtest-result.html');

const LOOKBACK_DAYS = Number(process.env.BACKTEST_LOOKBACK_DAYS || 60);
const HORIZONS = [1, 3, 5, 10, 20];
const TOP_N = 20;

function isNum(v) { return v != null && Number.isFinite(v); }
function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}
function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}
function avg(arr) { return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : null; }
function rate(events, predicate) {
  if (events.length === 0) return null;
  const hits = events.filter(predicate).length;
  return hits / events.length * 100;
}
// ── 분포 헬퍼 (median / percentile / trimmed mean / top contribution) ──
// 평균 착시 제거용 — 일부 급등 종목이 평균을 끌어올리는지 검증
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const k = (s.length - 1) * (p / 100);
  const f = Math.floor(k), c = Math.ceil(k);
  if (f === c) return s[f];
  return s[f] + (s[c] - s[f]) * (k - f);
}
function trimmedMean(arr, removeTopPct) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const removeN = Math.floor(s.length * removeTopPct / 100);
  const trimmed = s.slice(0, s.length - removeN);
  if (!trimmed.length) return null;
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}
function topContributionPct(arr, topN) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => b - a);
  const topSum = s.slice(0, Math.min(topN, s.length)).reduce((a, b) => a + b, 0);
  const totalSum = s.reduce((a, b) => a + b, 0);
  if (totalSum === 0 || !Number.isFinite(totalSum)) return null;
  return topSum / totalSum * 100;
}

// ── VVI 발생일 raw row에서 캔들 형태 + 단기 흐름 추가 메트릭 추출 ──
function computeVviExtras(rows, vviIdx) {
  if (vviIdx == null || vviIdx < 0 || !rows || !rows[vviIdx]) return {};
  const v = rows[vviIdx];
  const range = (v.high || 0) - (v.low || 0);
  const closePosition = range > 0 ? (v.close - v.low) / range : null;
  const upperTailRatio = range > 0 ? (v.high - v.close) / range : null;
  const bodyRate = isNum(v.open) && v.open > 0 ? (v.close - v.open) / v.open * 100 : null;
  // VVI 당일 전일 종가 대비 등락률
  const prevClose = vviIdx > 0 ? rows[vviIdx - 1].close : null;
  const vviDayChangeRate = isNum(prevClose) && prevClose > 0 ? (v.close / prevClose - 1) * 100 : null;
  // 최근 N 거래일 누적 변화 (vviIdx 기준)
  function recentRate(n) {
    const idx = vviIdx - n;
    if (idx < 0 || !rows[idx]) return null;
    const prev = rows[idx].close;
    return isNum(prev) && prev > 0 ? (v.close / prev - 1) * 100 : null;
  }
  return {
    closePosition, upperTailRatio, bodyRate, vviDayChangeRate,
    recent3Rate: recentRate(3),
    recent5Rate: recentRate(5),
  };
}

// ── C 그룹 (추격 부담 후보) 세부 분류 — C1/C2/C3/C4 ──
// 우선순위: C3 (밀림) > C2 (과열) > C1 (강한 추세) > C4 (기타).
// matchedTags 배열에 모든 매칭 룰 기록.
function classifyOverheatSubtype(e) {
  const v = e.vviExtras || {};
  const valueRatio  = e.vviValueRatio;
  const volumeRatio = e.vviVolumeRatio;
  const qvaCloseToVviRate = e.vviCloseFromQvaCloseRate;
  const matchedTags = [];

  // C3 고점 돌파 후 밀림 — 윗꼬리 길거나 종가 위치 낮음
  const milin = (isNum(v.upperTailRatio) && v.upperTailRatio >= 0.5)
             || (isNum(v.closePosition)  && v.closePosition  <= 0.5);
  if (milin) matchedTags.push('milin');

  // C2 과열 재돌파
  const overheat = (isNum(qvaCloseToVviRate) && qvaCloseToVviRate > 50)
                || (isNum(v.recent5Rate)     && v.recent5Rate > 50)
                || (isNum(v.vviDayChangeRate) && v.vviDayChangeRate >= 25);
  if (overheat) matchedTags.push('overheat');

  // C1 강한 추세형
  const strongTrend =
    isNum(valueRatio)  && valueRatio  >= 3 &&
    isNum(volumeRatio) && volumeRatio >= 2 &&
    isNum(v.closePosition)  && v.closePosition  >= 0.7 &&
    isNum(v.upperTailRatio) && v.upperTailRatio <= 0.35 &&
    isNum(qvaCloseToVviRate) && qvaCloseToVviRate >= 15 && qvaCloseToVviRate <= 50;
  if (strongTrend) matchedTags.push('strongTrend');

  let primary;
  if (matchedTags.includes('milin')) primary = 'C3';
  else if (matchedTags.includes('overheat')) primary = 'C2';
  else if (matchedTags.includes('strongTrend')) primary = 'C1';
  else primary = 'C4';
  return { primary, matchedTags };
}

// ── 진입 기준일 + 기준 종가 결정 ──
function pickBaseline(ev, rows) {
  if (ev.status === 'VVI_FIRED' || ev.status === 'OVERHEATED') {
    return { date: ev.vviDate, close: ev.vviClose };
  }
  if (ev.status === 'PRICE_ONLY' && ev.priceOnlyDate) {
    const r = rows.find((x) => x.date === ev.priceOnlyDate);
    return { date: ev.priceOnlyDate, close: r ? r.close : null };
  }
  // WAITING — 분석 기준일 (chart 마지막)
  const last = rows[rows.length - 1];
  return { date: last.date, close: last.close };
}

// ── 단일 이벤트 outcome 계산: D+1/3/5/10/20 high/low/close ──
function computeOutcomes(rows, baselineIdx, baselineClose) {
  const outcome = {};
  for (const n of HORIZONS) {
    const endIdx = baselineIdx + n;
    if (endIdx >= rows.length || baselineIdx + 1 >= rows.length) {
      outcome['high' + n]  = null;
      outcome['low' + n]   = null;
      outcome['close' + n] = null;
      continue;
    }
    let maxH = -Infinity, minL = Infinity;
    for (let k = 1; k <= n; k++) {
      const r = rows[baselineIdx + k];
      if (!r) continue;
      if (isNum(r.high) && r.high > maxH) maxH = r.high;
      if (isNum(r.low)  && r.low  < minL) minL = r.low;
    }
    outcome['high' + n]  = baselineClose > 0 && Number.isFinite(maxH) ? (maxH / baselineClose - 1) * 100 : null;
    outcome['low' + n]   = baselineClose > 0 && Number.isFinite(minL) ? (minL / baselineClose - 1) * 100 : null;
    const lastRow = rows[endIdx];
    outcome['close' + n] = baselineClose > 0 && lastRow && isNum(lastRow.close) ? (lastRow.close / baselineClose - 1) * 100 : null;
  }
  return outcome;
}

// ── 그룹 통계 요약 ──
function summarizeBucket(events) {
  const result = { count: events.length };
  if (events.length === 0) return result;
  for (const n of HORIZONS) {
    const validHigh  = events.filter(e => e.outcome && isNum(e.outcome['high' + n]));
    const validLow   = events.filter(e => e.outcome && isNum(e.outcome['low' + n]));
    const validClose = events.filter(e => e.outcome && isNum(e.outcome['close' + n]));
    result['n' + n] = validHigh.length;
    result['avgHigh' + n]  = validHigh.length  ? avg(validHigh.map(e => e.outcome['high' + n]))    : null;
    result['avgLow' + n]   = validLow.length   ? avg(validLow.map(e => e.outcome['low' + n]))      : null;
    result['avgClose' + n] = validClose.length ? avg(validClose.map(e => e.outcome['close' + n]))  : null;
    // 도달률 / 하락률 / 종가 양수율
    result['hit5_' + n]   = rate(validHigh,  e => e.outcome['high' + n]  >= 5);
    result['hit10_' + n]  = rate(validHigh,  e => e.outcome['high' + n]  >= 10);
    result['hit15_' + n]  = rate(validHigh,  e => e.outcome['high' + n]  >= 15);
    result['hit20_' + n]  = rate(validHigh,  e => e.outcome['high' + n]  >= 20);
    result['hit30_' + n]  = rate(validHigh,  e => e.outcome['high' + n]  >= 30);
    result['fail5_' + n]  = rate(validLow,   e => e.outcome['low' + n]   <= -5);
    result['fail10_' + n] = rate(validLow,   e => e.outcome['low' + n]   <= -10);
    result['closePos' + n] = rate(validClose, e => e.outcome['close' + n] > 0);
  }
  return result;
}

// ── 단일 horizon에 대한 분포 요약 (평균 착시 검증용) ──
function summarizeDistribution(events, horizon) {
  const validHigh  = events.filter(e => e.outcome && isNum(e.outcome['high' + horizon]));
  const validLow   = events.filter(e => e.outcome && isNum(e.outcome['low' + horizon]));
  const validClose = events.filter(e => e.outcome && isNum(e.outcome['close' + horizon]));
  const highArr  = validHigh.map(e => e.outcome['high' + horizon]);
  const lowArr   = validLow.map(e => e.outcome['low' + horizon]);
  const closeArr = validClose.map(e => e.outcome['close' + horizon]);
  return {
    n: validHigh.length,
    avgHigh:    avg(highArr),
    medianHigh: median(highArr),
    p25High:    percentile(highArr, 25),
    p75High:    percentile(highArr, 75),
    p90High:    percentile(highArr, 90),
    medianClose: median(closeArr),
    medianLow:  median(lowArr),
    p25Low:     percentile(lowArr, 25),
    trimmedAvgHigh_top10:  trimmedMean(highArr, 10),
    trimmedAvgHigh_top5:   trimmedMean(highArr, 5),
    trimmedAvgClose_top10: trimmedMean(closeArr, 10),
    top3ContributionPct:   topContributionPct(highArr, 3),
    top5ContributionPct:   topContributionPct(highArr, 5),
    top10PctContributionPct: topContributionPct(highArr, Math.max(1, Math.floor(highArr.length / 10))),
    hit10:    rate(validHigh,  e => e.outcome['high' + horizon] >= 10),
    hit20:    rate(validHigh,  e => e.outcome['high' + horizon] >= 20),
    hit30:    rate(validHigh,  e => e.outcome['high' + horizon] >= 30),
    fail5:    rate(validLow,   e => e.outcome['low' + horizon]  <= -5),
    fail10:   rate(validLow,   e => e.outcome['low' + horizon]  <= -10),
    closePos: rate(validClose, e => e.outcome['close' + horizon] > 0),
    eatScore: (() => {
      const h10 = rate(validHigh, e => e.outcome['high' + horizon] >= 10);
      const f10 = rate(validLow,  e => e.outcome['low' + horizon]  <= -10);
      return isNum(h10) && isNum(f10) ? h10 - f10 : null;
    })(),
  };
}

// ── 자동 결론 V2 (8 질문 — 추격 부담 세분화 결과 해석) ──
function buildConclusionV2({ overheatBreakdown, valueRatioBuckets, daysFromQvaToVviBuckets, summary }) {
  const c = {};
  const fmtP = (v) => isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(2) + '%' : '-';
  const fmtR = (v) => isNum(v) ? v.toFixed(1) + '%' : '-';
  const ob = overheatBreakdown;
  const cAvg = ob.C.distribution.avgHigh;
  const cMed = ob.C.distribution.medianHigh;
  const cTrim10 = ob.C.distribution.trimmedAvgHigh_top10;
  const cTop5Contrib = ob.C.distribution.top5ContributionPct;

  // 1) 평균 착시 검증
  if (isNum(cAvg) && isNum(cMed)) {
    const gap = cAvg - cMed;
    c.avgVsMedian = `C 그룹 D+10 평균 ${fmtP(cAvg)} vs 중앙값 ${fmtP(cMed)} (gap ${fmtP(gap)}). ` +
      `상위 10% 제거 평균 ${fmtP(cTrim10)} · 상위 5건 기여도 ${fmtR(cTop5Contrib)}. ` +
      (gap > 15 ? '평균 착시 가능성 높음 — 일부 급등 종목이 평균 끌어올림.' :
       gap > 5  ? '약간 평균 착시 가능 — 추가 검증 필요.' :
                  '평균 착시 가능성 낮음 — 분포 비교적 균일.');
  }

  // 2) C1 vs B 비교
  if (ob.C1.count >= 5 && ob.B.count >= 10) {
    const c1H = ob.C1.distribution.avgHigh, c1Med = ob.C1.distribution.medianHigh;
    const bH  = ob.B.distribution.avgHigh,  bMed  = ob.B.distribution.medianHigh;
    c.c1VsB = `C1 강한 추세형 (n=${ob.C1.count}) D+10 평균 ${fmtP(c1H)} / 중앙값 ${fmtP(c1Med)} ` +
      `vs B 추격 부담 제외 (n=${ob.B.count}) 평균 ${fmtP(bH)} / 중앙값 ${fmtP(bMed)}. ` +
      ((c1H || 0) > (bH || 0) + 3 ? '강한 추세형이 B보다 우수 — 살릴 가치 있음 (1차).' :
                                     '아직 차이 모호 — 추가 검증 필요.');
  }

  // 3) C2 과열 — 대박 vs 위험
  if (ob.C2.count >= 5) {
    const c2H = ob.C2.distribution.avgHigh, c2Med = ob.C2.distribution.medianHigh;
    const c2Hit30 = ob.C2.distribution.hit30, c2Fail10 = ob.C2.distribution.fail10;
    c.c2Verdict = `C2 과열 재돌파 (n=${ob.C2.count}) D+10 평균 ${fmtP(c2H)} / 중앙값 ${fmtP(c2Med)} / +30% 도달 ${fmtR(c2Hit30)} / -10% 하락 ${fmtR(c2Fail10)}. ` +
      ((c2Hit30 || 0) > 30 && (c2Fail10 || 0) > 30 ? '대박 가능성 크지만 -10% 흔들림도 큼 — 고위험 고수익.' :
       (c2H || 0) > 15 ? '평균은 높지만 중앙값과 fail rate를 함께 봐야.' :
                          '평균만 높고 실제 분포는 약함.');
  }

  // 4) C3 — 피해야 할 유형인가?
  if (ob.C3.count >= 5) {
    const c3H = ob.C3.distribution.avgHigh, c3Med = ob.C3.distribution.medianHigh;
    const c3Fail10 = ob.C3.distribution.fail10, c3ClosePos = ob.C3.distribution.closePos;
    c.c3Verdict = `C3 고점 돌파 후 밀린 (n=${ob.C3.count}) D+10 평균 ${fmtP(c3H)} / 중앙값 ${fmtP(c3Med)} / -10% 하락 ${fmtR(c3Fail10)} / 종가>0 ${fmtR(c3ClosePos)}. ` +
      ((c3H || 0) < 5 || (c3ClosePos || 0) < 40 ? '실제로 피해야 할 유형 — 평균/중앙값 약함.' : '의외로 수익 — 추가 분석.');
  }

  // 5) 거래대금 배율별 성과
  c.valueRatioRanking = [];
  for (const [name, info] of Object.entries(valueRatioBuckets)) {
    if (info.count < 3) continue;
    c.valueRatioRanking.push({
      bucket: name, n: info.count,
      avgHigh: info.distribution.avgHigh,
      medianHigh: info.distribution.medianHigh,
      hit10: info.distribution.hit10,
      hit20: info.distribution.hit20,
      fail10: info.distribution.fail10,
      closePos: info.distribution.closePos,
    });
  }
  // 가장 좋은 배율 구간 식별
  const sortedByMedian = [...c.valueRatioRanking].sort((a, b) => (b.medianHigh || -999) - (a.medianHigh || -999));
  c.valueRatioBest = sortedByMedian[0] || null;

  // 6) QVA → VVI 소요일별 성과
  c.daysToVviRanking = [];
  for (const [name, info] of Object.entries(daysFromQvaToVviBuckets)) {
    if (info.count < 3) continue;
    c.daysToVviRanking.push({
      bucket: name, n: info.count,
      avgHigh: info.distribution.avgHigh,
      medianHigh: info.distribution.medianHigh,
      hit10: info.distribution.hit10,
      hit20: info.distribution.hit20,
      fail10: info.distribution.fail10,
      closePos: info.distribution.closePos,
    });
  }
  const sortedDays = [...c.daysToVviRanking].sort((a, b) => (b.medianHigh || -999) - (a.medianHigh || -999));
  c.daysToVviBest = sortedDays[0] || null;

  // 7) 강한 추세형 살릴 가치
  if (ob.C1.count >= 5) {
    c.c1Verdict = `C1 강한 추세형 (n=${ob.C1.count}) — ` +
      ((ob.C1.distribution.medianHigh || 0) > (ob.B.distribution.medianHigh || 0)
        ? '중앙값 기준으로도 B 그룹보다 강함 → 운영 보드에 살릴 가치 있음 (1차).'
        : '중앙값 기준으로는 B와 비슷 → 분리 표시 가치는 있지만 별도 가점은 보류.');
  } else {
    c.c1Verdict = `C1 강한 추세형 표본 부족 (n=${ob.C1.count}) — 추가 표본 확보 후 재평가.`;
  }

  // 8) 운영 반영 시 상단 후보
  const recommend = [];
  recommend.push('B 추격 부담 제외 새 VVI — 안정적 메인 후보');
  if (c.c1Verdict && c.c1Verdict.includes('살릴 가치')) recommend.push('C1 강한 추세형 — 보조 별도 분류로 살리기');
  recommend.push('C2 과열 — 별도 "고위험 급등 가능" 섹션 (보드 메인 X)');
  recommend.push('C3 고점 돌파 후 밀림 — 보드 제외 또는 경고 태그');
  recommend.push('D 거래대금 부족 돌파 — 보드 제외');
  c.boardRecommendation = recommend;

  c.disclaimer = '1차 세분화 결과 — 표본 작음, 운영 반영 전 단계. 실제 진입과 대응은 본인의 판단입니다.';
  return c;
}

// ── 자동 결론 (1차 — 기존) ──
function buildConclusion(summary, counts) {
  const c = {};
  const fmt = (v, p) => isNum(v) ? (p ? v.toFixed(p) : v.toFixed(1)) : '-';
  const fmtPct = (v) => isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(2) + '%' : '-';
  const fmtRate = (v) => isNum(v) ? v.toFixed(1) + '%' : '-';

  // 1) A vs D 비교
  if (summary.A.count >= 10 && summary.D.count >= 5) {
    const aHi10 = summary.A.avgHigh10, dHi10 = summary.D.avgHigh10;
    const aHi20 = summary.A.avgHigh20, dHi20 = summary.D.avgHigh20;
    const aClose10 = summary.A.closePos10, dClose10 = summary.D.closePos10;
    c.qVsPriceOnly = '새 VVI 발생 D+10 평균 최고가 ' + fmtPct(aHi10) + ' / 종가>0 ' + fmtRate(aClose10) +
      ' vs 거래대금 부족 ' + fmtPct(dHi10) + ' / ' + fmtRate(dClose10) +
      '. ' + ((aHi10 || 0) > (dHi10 || 0) + 0.5 ? '거래대금 재확인이 의미 있음 (1차).' : '아직 차이 작음 — 추가 검증 필요.');
  }
  // 2) B vs C (추격 부담 제외 효과)
  if (summary.B.count >= 10 && summary.C.count >= 5) {
    const bClose20 = summary.B.closePos20, cClose20 = summary.C.closePos20;
    const bAvg20 = summary.B.avgClose20, cAvg20 = summary.C.avgClose20;
    c.overheatFilter = '추격 부담 제외 D+20 종가>0 ' + fmtRate(bClose20) + ' / 평균종가 ' + fmtPct(bAvg20) +
      ' vs 추격 부담 후보 ' + fmtRate(cClose20) + ' / ' + fmtPct(cAvg20) +
      '. ' + ((bClose20 || 0) > (cClose20 || 0) + 5 ? '추격 부담 필터 효과 확인 (1차).' : '필터 효과 모호 — 임계값 조정 필요.');
  }
  // 3) 새 VVI 발생 후 D+10/D+20 상승 여지
  if (summary.A.count >= 10) {
    c.upsidePresent = '새 VVI 발생 후 D+10 평균 최고가 ' + fmtPct(summary.A.avgHigh10) +
      ' / D+20 평균 최고가 ' + fmtPct(summary.A.avgHigh20) +
      ' / +10% 도달률 D+20 ' + fmtRate(summary.A.hit10_20) +
      ' / +20% 도달률 D+20 ' + fmtRate(summary.A.hit20_20) +
      '. ' + ((summary.A.avgHigh20 || 0) > 5 ? '상승 여지 1차 확인.' : '상승 여지 약함 — 추가 분할 분석 필요.');
  }
  // 4) 늦은 H그룹/재돌파 문제 줄일 가능성
  c.lateRebreakComment = '새 VVI 정의는 거래대금 동반 첫 돌파만 보므로, 횡보 유지 조건 없이 더 빠른 신호를 잡을 가능성. 단, 1차 데이터(QVA 윈도우 ' + LOOKBACK_DAYS + '일)에서는 표본이 작아 단정 어려움.';
  // 5) 추가로 나눠봐야 할 조건
  c.furtherSplits = [
    '거래대금 배율 (×1.5↑ vs ×3↑ vs ×5↑) 별 outcome',
    'QVA → VVI 걸린 거래일 수 (1~3일 vs 4~10일 vs 11~20일)',
    'VVI 발생일 종가 vs 고가 차이 (윗꼬리 비중)',
    '시가총액 구간 (1,000억~5,000억 vs 5,000억~3조 vs 3조↑)',
    'QVA 종가 대비 VVI 종가 위치 (5% 이내 vs 5~15% vs 15%↑)',
  ];
  c.disclaimer = '1차 검증 — 표본 작음, 운영 반영 전. 실제 진입과 대응은 본인의 판단입니다.';
  return c;
}

// ── 메인 ──
function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`\n📊 새 VVI 정의 1차 백테스트 (lookback ${LOOKBACK_DAYS} 거래일)`);

  const signals = board.loadQvaSignals();
  console.log(`  QVA 신호 수: ${signals.length}건`);

  // chart의 가장 흔한 last row date를 today로 추정
  let todayDate = null;
  {
    const dateFreq = new Map();
    for (const sig of signals) {
      const c = loadChart(sig.code);
      if (c && c.rows && c.rows.length) {
        const d = c.rows[c.rows.length - 1].date;
        dateFreq.set(d, (dateFreq.get(d) || 0) + 1);
      }
    }
    let maxFreq = 0;
    for (const [d, n] of dateFreq) if (n > maxFreq) { maxFreq = n; todayDate = d; }
  }

  // LOOKBACK 윈도우 cutoff (calendar days × 7/5 ≈ trading days)
  const cutoffMs = todayDate ? (() => {
    const d = new Date(Number(todayDate.slice(0,4)), Number(todayDate.slice(4,6))-1, Number(todayDate.slice(6,8)));
    d.setDate(d.getDate() - Math.round(LOOKBACK_DAYS * 7 / 5));
    return d.getTime();
  })() : null;
  function inWindow(qvaDate) {
    if (!cutoffMs) return true;
    const d = new Date(Number(qvaDate.slice(0,4)), Number(qvaDate.slice(4,6))-1, Number(qvaDate.slice(6,8)));
    return d.getTime() >= cutoffMs;
  }

  // 분석 + outcome 계산
  let chartMissing = 0, qvaRowMissing = 0;
  const rawEvents = [];
  for (const sig of signals) {
    if (!inWindow(sig.qvaSignalDate)) continue;
    const chart = loadChart(sig.code);
    if (!chart) { chartMissing++; continue; }
    const ev = board.analyzeVvi(sig, chart, todayDate);
    if (!ev) { qvaRowMissing++; continue; }
    const baseline = pickBaseline(ev, chart.rows);
    if (!baseline.date || !isNum(baseline.close) || baseline.close <= 0) continue;
    const baselineIdx = chart.rows.findIndex((r) => r.date === baseline.date);
    if (baselineIdx < 0) continue;
    ev.baselineDate = baseline.date;
    ev.baselineClose = baseline.close;
    ev.outcome = computeOutcomes(chart.rows, baselineIdx, baseline.close);
    // VVI 발생일 raw row에서 추가 메트릭 (캔들 형태 + 단기 흐름)
    if (ev.vviDate) {
      const vviIdx = chart.rows.findIndex((r) => r.date === ev.vviDate);
      ev.vviExtras = computeVviExtras(chart.rows, vviIdx);
      ev.vviIdx = vviIdx;
    }
    rawEvents.push(ev);
  }
  console.log(`  분석 이벤트: ${rawEvents.length}건 (chart 없음 ${chartMissing} / qvaRow 없음 ${qvaRowMissing})`);

  // 종목별 dedup (VVI 발생 우선, 그 다음 최신 qvaSignalDate)
  const dedup = new Map();
  for (const e of rawEvents) {
    const cur = dedup.get(e.code);
    if (!cur) { dedup.set(e.code, e); continue; }
    const curHasVvi = cur.vviDate ? 1 : 0;
    const eHasVvi = e.vviDate ? 1 : 0;
    if (eHasVvi !== curHasVvi) { if (eHasVvi > curHasVvi) dedup.set(e.code, e); continue; }
    if (e.qvaSignalDate > cur.qvaSignalDate) dedup.set(e.code, e);
  }
  const events = [...dedup.values()];

  // 그룹 분류
  const A = events.filter(e => e.status === 'VVI_FIRED' || e.status === 'OVERHEATED');
  const B = events.filter(e => e.status === 'VVI_FIRED');
  const C = events.filter(e => e.status === 'OVERHEATED');
  const D = events.filter(e => e.status === 'PRICE_ONLY');
  const E = events.filter(e => e.status === 'WAITING');

  // 각 그룹 summary (1차 — 평균/도달률)
  const summary = {
    A: summarizeBucket(A),
    B: summarizeBucket(B),
    C: summarizeBucket(C),
    D: summarizeBucket(D),
    E: summarizeBucket(E),
  };

  // ── C 그룹 세분화 (C1/C2/C3/C4) ──
  for (const e of C) {
    const sub = classifyOverheatSubtype(e);
    e.overheatSubtype = sub.primary;
    e.overheatTags = sub.matchedTags;
  }
  const C1 = C.filter((e) => e.overheatSubtype === 'C1');
  const C2 = C.filter((e) => e.overheatSubtype === 'C2');
  const C3 = C.filter((e) => e.overheatSubtype === 'C3');
  const C4 = C.filter((e) => e.overheatSubtype === 'C4');

  // 분포 지표 (평균 착시 제거 — median / percentile / trimmed mean / top contribution)
  const overheatBreakdown = {
    C1: { count: C1.length, summary: summarizeBucket(C1), distribution: summarizeDistribution(C1, 10) },
    C2: { count: C2.length, summary: summarizeBucket(C2), distribution: summarizeDistribution(C2, 10) },
    C3: { count: C3.length, summary: summarizeBucket(C3), distribution: summarizeDistribution(C3, 10) },
    C4: { count: C4.length, summary: summarizeBucket(C4), distribution: summarizeDistribution(C4, 10) },
    // B/C/D 비교 분포 함께 (표 1용)
    B: { count: B.length, summary: summary.B, distribution: summarizeDistribution(B, 10) },
    C: { count: C.length, summary: summary.C, distribution: summarizeDistribution(C, 10) },
    D: { count: D.length, summary: summary.D, distribution: summarizeDistribution(D, 10) },
  };

  // ── 거래대금 배율 buckets ──
  const VALUE_RATIO_BUCKETS = [
    { name: '1~1.5×',  min: 1,    max: 1.5 },
    { name: '1.5~3×',  min: 1.5,  max: 3 },
    { name: '3~5×',    min: 3,    max: 5 },
    { name: '5~10×',   min: 5,    max: 10 },
    { name: '10×↑',    min: 10,   max: Infinity },
  ];
  const valueRatioBuckets = {};
  // VVI 발생 그룹(A) 기준으로 배율 분포
  for (const b of VALUE_RATIO_BUCKETS) {
    const inB = A.filter((e) => isNum(e.vviValueRatio) && e.vviValueRatio >= b.min && e.vviValueRatio < b.max);
    valueRatioBuckets[b.name] = {
      count: inB.length,
      summary: summarizeBucket(inB),
      distribution: summarizeDistribution(inB, 10),
    };
  }

  // ── QVA → VVI 소요일 buckets ──
  const DAYS_BUCKETS = [
    { name: '1~3일',   min: 1,  max: 3 },
    { name: '4~10일',  min: 4,  max: 10 },
    { name: '11~20일', min: 11, max: 20 },
    { name: '21일↑',   min: 21, max: Infinity },
  ];
  const daysFromQvaToVviBuckets = {};
  for (const b of DAYS_BUCKETS) {
    const inB = A.filter((e) => isNum(e.daysFromQvaToVvi) && e.daysFromQvaToVvi >= b.min && e.daysFromQvaToVvi <= b.max);
    daysFromQvaToVviBuckets[b.name] = {
      count: inB.length,
      summary: summarizeBucket(inB),
      distribution: summarizeDistribution(inB, 10),
    };
  }

  // C1 TOP 20 / C3 WORST 20 (D+10 기준)
  const c1Top20 = [...C1].filter(e => e.outcome && isNum(e.outcome.high10))
    .sort((a, b) => b.outcome.high10 - a.outcome.high10).slice(0, TOP_N).map(serializeEvent);
  const c3Worst20 = [...C3].filter(e => e.outcome && isNum(e.outcome.low10))
    .sort((a, b) => a.outcome.low10 - b.outcome.low10).slice(0, TOP_N).map(serializeEvent);

  // TOP / WORST (B 그룹 = 추격 부담 제외 VVI 발생 기준)
  const top20 = [...B]
    .filter(e => e.outcome && isNum(e.outcome.high20))
    .sort((a, b) => b.outcome.high20 - a.outcome.high20)
    .slice(0, TOP_N)
    .map(serializeEvent);
  const worst20 = [...B]
    .filter(e => e.outcome && isNum(e.outcome.low20))
    .sort((a, b) => a.outcome.low20 - b.outcome.low20)
    .slice(0, TOP_N)
    .map(serializeEvent);

  // 자동 결론 (1차 + V2 세분화)
  const conclusion = buildConclusion(summary, { A: A.length, B: B.length, C: C.length, D: D.length, E: E.length });
  const conclusionV2 = buildConclusionV2({ overheatBreakdown, valueRatioBuckets, daysFromQvaToVviBuckets, summary });

  const out = {
    meta: {
      title: '새 VVI 정의 1차 백테스트',
      subtitle: 'QVA 고가 + 거래량 + 거래대금 동시 재돌파의 D+1~D+20 outcome — 단순 검증 (1차)',
      generatedAt: new Date().toISOString(),
      lookbackDays: LOOKBACK_DAYS,
      analysisDate: todayDate,
      analysisDateFmt: todayDate ? fmtDate(todayDate) : null,
      definition: 'VVI = QVA 고가 재돌파 + QVA 이상 거래량 + QVA 이상 거래대금. 셋 다 만족하는 첫 거래일.',
      horizons: HORIZONS,
      groupNames: {
        A: '새 VVI 발생 (전체)',
        B: '새 VVI 발생 · 추격 부담 제외',
        C: '추격 부담 후보',
        D: '가격은 넘었지만 거래대금 부족',
        E: '고점 재돌파 대기 (참고)',
      },
    },
    counts: {
      raw: rawEvents.length,
      deduped: events.length,
      A: A.length, B: B.length, C: C.length, D: D.length, E: E.length,
    },
    summary,
    top20,
    worst20,
    conclusion,
    // ── 신규 V2: 추격 부담 세분화 ──
    overheatBreakdown,
    valueRatioBuckets,
    daysFromQvaToVviBuckets,
    c1Top20,
    c3Worst20,
    conclusionV2,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out)), 'utf-8');

  const fmtP = (v) => isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(2) + '%' : '-';
  const fmtR = (v) => isNum(v) ? v.toFixed(1) + '%' : '-';
  console.log(`\n  그룹별 n: A=${A.length} / B=${B.length} / C=${C.length} / D=${D.length} / E=${E.length}`);
  console.log(`  ── 그룹 평균 (D+5 / D+10 / D+20 평균 최고가) ──`);
  for (const [k, label] of Object.entries(out.meta.groupNames)) {
    const s = summary[k];
    console.log(`    ${k} ${label.padEnd(28)} n=${String(s.count).padStart(3)} | D+5 ${fmtP(s.avgHigh5).padStart(8)} / D+10 ${fmtP(s.avgHigh10).padStart(8)} / D+20 ${fmtP(s.avgHigh20).padStart(8)}`);
  }
  console.log(`  ── B 그룹 (VVI 발생 + 추격 부담 제외) 도달률/하락률 ──`);
  console.log(`    +10% D+10 ${fmtR(summary.B.hit10_10)} / +20% D+20 ${fmtR(summary.B.hit20_20)} / +30% D+20 ${fmtR(summary.B.hit30_20)}`);
  console.log(`    -10% D+10 ${fmtR(summary.B.fail10_10)} / 종가>0 D+20 ${fmtR(summary.B.closePos20)}`);
  console.log(`\n  ── C 그룹 세분화 (D+10 평균/중앙값/상위 10% 제거 평균) ──`);
  for (const k of ['B', 'C', 'C1', 'C2', 'C3', 'C4', 'D']) {
    const info = overheatBreakdown[k];
    if (!info) continue;
    const d = info.distribution;
    console.log(`    ${k.padEnd(3)} n=${String(info.count).padStart(3)} | avg ${fmtP(d.avgHigh).padStart(8)} / median ${fmtP(d.medianHigh).padStart(8)} / trim10% ${fmtP(d.trimmedAvgHigh_top10).padStart(8)} | hit10 ${fmtR(d.hit10).padStart(6)} / hit20 ${fmtR(d.hit20).padStart(6)} / fail10 ${fmtR(d.fail10).padStart(6)} / closePos ${fmtR(d.closePos).padStart(6)}`);
  }
  console.log(`  total elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

function serializeEvent(e) {
  return {
    code: e.code, name: e.name, market: e.market,
    qvaSignalDate: e.qvaSignalDate, qvaHigh: e.qvaHigh, qvaClose: e.qvaClose,
    qvaVolume: e.qvaVolume, qvaValue: e.qvaValue,
    vviDate: e.vviDate, vviClose: e.vviClose, vviHigh: e.vviHigh,
    vviVolume: e.vviVolume, vviValue: e.vviValue,
    vviValueRatio: e.vviValueRatio, vviVolumeRatio: e.vviVolumeRatio,
    daysFromQvaToVvi: e.daysFromQvaToVvi,
    vviCloseFromQvaCloseRate: e.vviCloseFromQvaCloseRate,
    currentClose: e.currentClose, currentFromQvaCloseRate: e.currentFromQvaCloseRate,
    status: e.status, statusLabel: e.statusLabel,
    baselineDate: e.baselineDate, baselineClose: e.baselineClose,
    outcome: e.outcome,
  };
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>새 VVI 정의 1차 백테스트</title>
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
.warn-box { background: #1e293b; border-left: 3px solid #94a3b8; padding: 8px 14px; border-radius: 6px; font-size: 11.5px; color: #94a3b8; margin-bottom: 14px; line-height: 1.6; }

table { width: 100%; border-collapse: collapse; margin-bottom: 14px; background: #1e293b; border-radius: 8px; overflow: hidden; font-size: 12px; }
th, td { padding: 7px 8px; text-align: right; border-bottom: 1px solid #334155; font-variant-numeric: tabular-nums; }
th { background: #0f172a; color: #94a3b8; font-weight: 600; }
th.left, td.left { text-align: left; }
tr:last-child td { border-bottom: none; }
tr:hover { background: #233044; }
.pos { color: #6ee7b7; }
.neg { color: #fca5a5; }
.muted { color: #64748b; }

.callout { background: #1e293b; border-left: 4px solid #14b8a6; padding: 10px 14px; border-radius: 6px; font-size: 12px; line-height: 1.7; color: #cbd5e1; margin-bottom: 12px; }
.callout strong { color: #5eead4; }
.callout.warn { border-left-color: #f59e0b; }
.callout.warn strong { color: #fbbf24; }
.callout.info { border-left-color: #38bdf8; }
.callout.info strong { color: #67e8f9; }

.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.summary-cell { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.summary-cell .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.summary-cell .value { font-size: 18px; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; margin-top: 4px; }
.summary-cell .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
.summary-cell.A { border-left: 4px solid #14b8a6; }
.summary-cell.B { border-left: 4px solid #10b981; }
.summary-cell.C { border-left: 4px solid #ef4444; }
.summary-cell.D { border-left: 4px solid #f59e0b; }
.summary-cell.E { border-left: 4px solid #94a3b8; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #cbd5e1; }
</style>
</head>
<body>
<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/rebreak">🔥 D+5 재돌파 운용</a>
  <a href="/one-day-surge-board">⚡ 1DS 단타 후보</a>
  <a href="/qva-vvi-redefined-board">🎯 QVA 고점 재돌파</a>
  <a href="/qva-vvi-redefined-backtest" class="active">🔬 새 VVI 1차 백테스트</a>
</nav>

<h1>🔬 새 VVI 정의 1차 백테스트</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  <strong>새 VVI 정의:</strong> QVA 고가 재돌파 + QVA 이상 거래량 + QVA 이상 거래대금. 셋 다 만족하는 첫 거래일.<br>
  이 1차 백테스트는 단순한 그룹 비교 — 새 VVI 발생 후 D+1~D+20 outcome이 거래대금 부족·VVI 대기 그룹보다 좋은지 본다.
</div>
<div class="warn-box">
  ⚠ <strong>1차 검증입니다.</strong> 표본이 작고 QVA 윈도우(<code>BACKTEST_LOOKBACK_DAYS</code>)가 제한적. 운영 반영 전 단계 — 표본 확대 + 추가 분할 필요. 실제 진입과 대응은 본인의 판단입니다.
</div>

<h2>📊 그룹별 후보 수</h2>
<div class="summary-grid" id="summary-grid"></div>

<h2>📋 표 1. 그룹별 성과 비교</h2>
<table id="t-group-summary"><thead><tr>
  <th class="left">그룹</th><th>n</th>
  <th>D+5 평균 고가</th><th>D+10 평균 고가</th><th>D+20 평균 고가</th>
  <th>D+10 +10%</th><th>D+20 +20%</th><th>D+20 +30%</th>
  <th>D+10 -10%</th><th>D+20 종가&gt;0</th>
</tr></thead><tbody></tbody></table>

<h2>📋 표 2. 새 VVI 상위 성과 TOP 20 (B 그룹 기준, D+20 최고가 순)</h2>
<table id="t-top"><thead><tr>
  <th class="left">종목</th><th class="left">코드</th>
  <th class="left">QVA일</th><th class="left">VVI일</th>
  <th>QVA→VVI</th><th>거래대금 ×</th><th>거래량 ×</th>
  <th>VVI 종가 vs QVA 종가</th>
  <th>D+5 고가</th><th>D+10 고가</th><th>D+20 고가</th><th>D+20 저가</th>
</tr></thead><tbody></tbody></table>

<h2>📋 표 3. 실패 사례 TOP 20 (B 그룹 기준, D+20 최저가 낮은 순)</h2>
<table id="t-worst"><thead><tr>
  <th class="left">종목</th><th class="left">코드</th>
  <th class="left">QVA일</th><th class="left">VVI일</th>
  <th>거래대금 ×</th><th>QVA 대비 위치</th>
  <th>D+10 저가</th><th>D+20 저가</th>
</tr></thead><tbody></tbody></table>

<h2>🧠 자동 결론 (1차)</h2>
<div id="conclusion"></div>

<hr style="border-color:#1e293b;margin:32px 0 18px;">

<h2>🔬 추격 부담 후보 세분화 (V2)</h2>
<div class="purpose-box">
  C 그룹 (추격 부담 후보)을 무조건 제외하지 않고, 그 안에서 의미 있는 "강한 추세형 재돌파"만 골라낼 수 있는지 본다.
  C1 강한 추세형 / C2 과열 / C3 고점 돌파 후 밀림 / C4 기타로 세분화 + 평균 착시 검증 (중앙값 + 상위 제거 평균 + 상위 기여도).
</div>
<div class="warn-box">
  ⚠ <strong>평균은 일부 급등 종목의 영향을 받을 수 있으므로 중앙값과 상위 제거 평균을 함께 봅니다.</strong>
</div>

<h3>📋 표 1. C그룹 세부 유형별 성과 (D+10)</h3>
<table id="t-overheat-breakdown"><thead><tr>
  <th class="left">유형</th><th>n</th>
  <th>D+10 평균 고가</th><th>D+10 중앙값</th><th>상위 10% 제거 평균</th>
  <th>+10% 도달</th><th>+20% 도달</th>
  <th>-10% 하락</th><th>종가&gt;0</th><th>먹을자리</th>
</tr></thead><tbody></tbody></table>

<h3>📋 표 2. C1 강한 추세형 후보 TOP 20 (D+10 최고가 순)</h3>
<table id="t-c1-top"><thead><tr>
  <th class="left">종목</th><th class="left">코드</th>
  <th class="left">QVA일</th><th class="left">VVI일</th>
  <th>QVA→VVI</th><th>거래대금 ×</th><th>거래량 ×</th>
  <th>VVI 종가 vs QVA 종가</th>
  <th>종가 위치</th><th>윗꼬리</th>
  <th>D+5 고가</th><th>D+10 고가</th><th>D+10 저가</th><th>D+10 종가</th>
</tr></thead><tbody></tbody></table>

<h3>📋 표 3. C3 고점 돌파 후 밀린 후보 TOP 20 (D+10 최저가 낮은 순)</h3>
<table id="t-c3-worst"><thead><tr>
  <th class="left">종목</th><th class="left">코드</th>
  <th class="left">QVA일</th><th class="left">VVI일</th>
  <th>거래대금 ×</th><th>QVA 대비 위치</th>
  <th>윗꼬리</th><th>종가 위치</th>
  <th>D+10 저가</th><th>D+10 고가</th><th>D+10 종가</th>
</tr></thead><tbody></tbody></table>

<h3>📋 표 4. 거래대금 배율별 성과 (A 그룹 기준, D+10)</h3>
<table id="t-value-buckets"><thead><tr>
  <th class="left">구간</th><th>n</th>
  <th>D+10 평균 고가</th><th>중앙값</th>
  <th>+10% 도달</th><th>+20% 도달</th>
  <th>-10% 하락</th><th>종가&gt;0</th>
</tr></thead><tbody></tbody></table>

<h3>📋 표 5. QVA→VVI 소요일별 성과 (A 그룹 기준, D+10)</h3>
<table id="t-days-buckets"><thead><tr>
  <th class="left">구간</th><th>n</th>
  <th>D+10 평균 고가</th><th>중앙값</th>
  <th>+10% 도달</th><th>+20% 도달</th>
  <th>-10% 하락</th><th>종가&gt;0</th>
</tr></thead><tbody></tbody></table>

<h2>🧠 자동 결론 V2 (추격 부담 세분화 해석)</h2>
<div id="conclusion-v2"></div>

<footer class="foot" id="foot"></footer>

<script>
const DATA = __JSON_DATA__;
function isNum(v) { return v != null && Number.isFinite(v); }
function fmtPct(v, p) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(p || 2) + '%' : '-'; }
function fmtRate(v, p) { return isNum(v) ? v.toFixed(p || 1) + '%' : '-'; }
function fmtRatio(v) { return isNum(v) ? '×' + v.toFixed(2) : '-'; }
function fmtDate(d) { if (!d || String(d).length !== 8) return d || '-'; const s = String(d); return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8); }

document.getElementById('subtitle').innerHTML =
  '분석 기준일 <strong style="color:#5eead4;">' + (DATA.meta.analysisDateFmt || '-') + '</strong>' +
  ' · QVA 윈도우 ' + DATA.meta.lookbackDays + '거래일' +
  ' · 분석 이벤트 ' + DATA.counts.raw + '건 (종목 dedup ' + DATA.counts.deduped + ')' +
  ' · 생성: ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

(function renderGroupCounts() {
  const groupNames = DATA.meta.groupNames;
  const cells = ['A', 'B', 'C', 'D', 'E'].map(k => ({
    lab: k + '. ' + groupNames[k],
    val: DATA.counts[k],
    sub: 'n=' + DATA.summary[k].count,
    cls: k,
  }));
  document.getElementById('summary-grid').innerHTML = cells.map(c =>
    '<div class="summary-cell ' + c.cls + '"><div class="label">' + c.lab + '</div>' +
    '<div class="value">' + c.val + '</div><div class="sub">' + c.sub + '</div></div>'
  ).join('');
})();

(function renderGroupSummary() {
  const tb = document.querySelector('#t-group-summary tbody');
  const groupNames = DATA.meta.groupNames;
  const order = ['A', 'B', 'C', 'D', 'E'];
  const rows = [];
  for (const k of order) {
    const s = DATA.summary[k];
    const cls = (v) => isNum(v) && v > 0 ? 'pos' : (isNum(v) && v < 0 ? 'neg' : '');
    rows.push('<tr>' +
      '<td class="left"><strong>' + k + '. ' + groupNames[k] + '</strong></td>' +
      '<td>' + s.count + '</td>' +
      '<td class="' + cls(s.avgHigh5) + '">' + fmtPct(s.avgHigh5) + '</td>' +
      '<td class="' + cls(s.avgHigh10) + '"><strong>' + fmtPct(s.avgHigh10) + '</strong></td>' +
      '<td class="' + cls(s.avgHigh20) + '"><strong>' + fmtPct(s.avgHigh20) + '</strong></td>' +
      '<td>' + fmtRate(s.hit10_10) + '</td>' +
      '<td>' + fmtRate(s.hit20_20) + '</td>' +
      '<td>' + fmtRate(s.hit30_20) + '</td>' +
      '<td class="' + (isNum(s.fail10_10) && s.fail10_10 >= 30 ? 'neg' : '') + '">' + fmtRate(s.fail10_10) + '</td>' +
      '<td class="' + (isNum(s.closePos20) && s.closePos20 >= 50 ? 'pos' : '') + '">' + fmtRate(s.closePos20) + '</td>' +
    '</tr>');
  }
  tb.innerHTML = rows.join('');
})();

(function renderTop20() {
  const tb = document.querySelector('#t-top tbody');
  const list = DATA.top20 || [];
  if (list.length === 0) { tb.innerHTML = '<tr><td class="muted left" colspan="12">데이터 없음 (B 그룹 표본 부족 또는 D+20 미도달)</td></tr>'; return; }
  tb.innerHTML = list.map(e => '<tr>' +
    '<td class="left">' + (e.name || '-') + '</td>' +
    '<td class="left muted">' + e.code + '</td>' +
    '<td class="left">' + fmtDate(e.qvaSignalDate) + '</td>' +
    '<td class="left">' + fmtDate(e.vviDate) + '</td>' +
    '<td>' + (isNum(e.daysFromQvaToVvi) ? e.daysFromQvaToVvi + '일' : '-') + '</td>' +
    '<td>' + fmtRatio(e.vviValueRatio) + '</td>' +
    '<td>' + fmtRatio(e.vviVolumeRatio) + '</td>' +
    '<td class="' + (isNum(e.vviCloseFromQvaCloseRate) && e.vviCloseFromQvaCloseRate > 0 ? 'pos' : '') + '">' + fmtPct(e.vviCloseFromQvaCloseRate, 1) + '</td>' +
    '<td class="pos">' + fmtPct(e.outcome.high5, 1) + '</td>' +
    '<td class="pos">' + fmtPct(e.outcome.high10, 1) + '</td>' +
    '<td class="pos"><strong>' + fmtPct(e.outcome.high20, 1) + '</strong></td>' +
    '<td class="' + (isNum(e.outcome.low20) && e.outcome.low20 <= -5 ? 'neg' : '') + '">' + fmtPct(e.outcome.low20, 1) + '</td>' +
  '</tr>').join('');
})();

(function renderWorst20() {
  const tb = document.querySelector('#t-worst tbody');
  const list = DATA.worst20 || [];
  if (list.length === 0) { tb.innerHTML = '<tr><td class="muted left" colspan="8">데이터 없음 (B 그룹 표본 부족 또는 D+20 미도달)</td></tr>'; return; }
  tb.innerHTML = list.map(e => '<tr>' +
    '<td class="left">' + (e.name || '-') + '</td>' +
    '<td class="left muted">' + e.code + '</td>' +
    '<td class="left">' + fmtDate(e.qvaSignalDate) + '</td>' +
    '<td class="left">' + fmtDate(e.vviDate) + '</td>' +
    '<td>' + fmtRatio(e.vviValueRatio) + '</td>' +
    '<td class="' + (isNum(e.currentFromQvaCloseRate) && e.currentFromQvaCloseRate > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.currentFromQvaCloseRate, 1) + '</td>' +
    '<td class="neg">' + fmtPct(e.outcome.low10, 1) + '</td>' +
    '<td class="neg"><strong>' + fmtPct(e.outcome.low20, 1) + '</strong></td>' +
  '</tr>').join('');
})();

(function renderConclusion() {
  const c = DATA.conclusion || {};
  const html = [];
  if (c.upsidePresent)     html.push('<div class="callout"><strong>① 새 VVI 발생 후 상승 여지</strong><br>' + c.upsidePresent + '</div>');
  if (c.qVsPriceOnly)      html.push('<div class="callout info"><strong>② 거래대금 재확인 효과 (A vs D)</strong><br>' + c.qVsPriceOnly + '</div>');
  if (c.overheatFilter)    html.push('<div class="callout info"><strong>③ 추격 부담 필터 효과 (B vs C)</strong><br>' + c.overheatFilter + '</div>');
  if (c.lateRebreakComment)html.push('<div class="callout"><strong>④ 늦은 재돌파 문제 가능성</strong><br>' + c.lateRebreakComment + '</div>');
  if ((c.furtherSplits || []).length) {
    html.push('<div class="callout"><strong>⑤ 추가로 나눠봐야 할 조건 (다음 단계)</strong><br>' +
      c.furtherSplits.map((s, i) => (i+1) + '. ' + s).join('<br>') + '</div>');
  }
  if (c.disclaimer) html.push('<div class="callout warn"><strong>⚠ 1차 검증 한계</strong><br>' + c.disclaimer + '</div>');
  document.getElementById('conclusion').innerHTML = html.join('') || '<div class="callout warn">자동 결론 산출 실패 — 데이터 확인 필요.</div>';
})();

// ── V2: C 그룹 세분화 비교표 ──
(function renderOverheatBreakdown() {
  const tb = document.querySelector('#t-overheat-breakdown tbody');
  if (!tb) return;
  const ob = DATA.overheatBreakdown || {};
  const labels = {
    B:  'B. 추격 부담 제외 새 VVI',
    C:  'C. 추격 부담 후보 전체',
    C1: 'C1. 강한 추세형 재돌파',
    C2: 'C2. 과열 재돌파',
    C3: 'C3. 고점 돌파 후 밀림',
    C4: 'C4. 기타 추격 부담',
    D:  'D. 가격은 넘었지만 거래대금 부족',
  };
  const order = ['B', 'C', 'C1', 'C2', 'C3', 'C4', 'D'];
  const rows = [];
  for (const k of order) {
    const info = ob[k];
    if (!info) continue;
    const d = info.distribution || {};
    rows.push('<tr>' +
      '<td class="left"><strong>' + labels[k] + '</strong></td>' +
      '<td>' + info.count + '</td>' +
      '<td class="' + (isNum(d.avgHigh) && d.avgHigh > 0 ? 'pos' : 'neg') + '">' + fmtPct(d.avgHigh) + '</td>' +
      '<td class="' + (isNum(d.medianHigh) && d.medianHigh > 0 ? 'pos' : 'neg') + '"><strong>' + fmtPct(d.medianHigh) + '</strong></td>' +
      '<td>' + fmtPct(d.trimmedAvgHigh_top10) + '</td>' +
      '<td>' + fmtRate(d.hit10) + '</td>' +
      '<td>' + fmtRate(d.hit20) + '</td>' +
      '<td class="' + (isNum(d.fail10) && d.fail10 >= 30 ? 'neg' : '') + '">' + fmtRate(d.fail10) + '</td>' +
      '<td class="' + (isNum(d.closePos) && d.closePos >= 50 ? 'pos' : '') + '">' + fmtRate(d.closePos) + '</td>' +
      '<td class="' + (isNum(d.eatScore) && d.eatScore > 0 ? 'pos' : 'neg') + '">' + fmtPct(d.eatScore) + '</td>' +
    '</tr>');
  }
  tb.innerHTML = rows.join('');
})();

// ── V2: C1 TOP 20 ──
(function renderC1Top() {
  const tb = document.querySelector('#t-c1-top tbody');
  if (!tb) return;
  const list = DATA.c1Top20 || [];
  if (!list.length) { tb.innerHTML = '<tr><td class="muted left" colspan="14">C1 강한 추세형 표본 부족</td></tr>'; return; }
  tb.innerHTML = list.map(e => {
    const v = e.vviExtras || {};
    return '<tr>' +
      '<td class="left">' + (e.name || '-') + '</td>' +
      '<td class="left muted">' + e.code + '</td>' +
      '<td class="left">' + fmtDate(e.qvaSignalDate) + '</td>' +
      '<td class="left">' + fmtDate(e.vviDate) + '</td>' +
      '<td>' + (isNum(e.daysFromQvaToVvi) ? e.daysFromQvaToVvi + '일' : '-') + '</td>' +
      '<td>' + fmtRatio(e.vviValueRatio) + '</td>' +
      '<td>' + fmtRatio(e.vviVolumeRatio) + '</td>' +
      '<td class="' + (isNum(e.vviCloseFromQvaCloseRate) && e.vviCloseFromQvaCloseRate > 0 ? 'pos' : '') + '">' + fmtPct(e.vviCloseFromQvaCloseRate, 1) + '</td>' +
      '<td>' + (isNum(v.closePosition) ? (v.closePosition * 100).toFixed(0) + '%' : '-') + '</td>' +
      '<td>' + (isNum(v.upperTailRatio) ? (v.upperTailRatio * 100).toFixed(0) + '%' : '-') + '</td>' +
      '<td class="pos">' + fmtPct(e.outcome.high5, 1) + '</td>' +
      '<td class="pos"><strong>' + fmtPct(e.outcome.high10, 1) + '</strong></td>' +
      '<td class="' + (isNum(e.outcome.low10) && e.outcome.low10 <= -5 ? 'neg' : '') + '">' + fmtPct(e.outcome.low10, 1) + '</td>' +
      '<td class="' + (isNum(e.outcome.close10) && e.outcome.close10 > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.outcome.close10, 1) + '</td>' +
    '</tr>';
  }).join('');
})();

// ── V2: C3 WORST 20 ──
(function renderC3Worst() {
  const tb = document.querySelector('#t-c3-worst tbody');
  if (!tb) return;
  const list = DATA.c3Worst20 || [];
  if (!list.length) { tb.innerHTML = '<tr><td class="muted left" colspan="11">C3 고점 돌파 후 밀린 후보 표본 부족</td></tr>'; return; }
  tb.innerHTML = list.map(e => {
    const v = e.vviExtras || {};
    return '<tr>' +
      '<td class="left">' + (e.name || '-') + '</td>' +
      '<td class="left muted">' + e.code + '</td>' +
      '<td class="left">' + fmtDate(e.qvaSignalDate) + '</td>' +
      '<td class="left">' + fmtDate(e.vviDate) + '</td>' +
      '<td>' + fmtRatio(e.vviValueRatio) + '</td>' +
      '<td class="' + (isNum(e.currentFromQvaCloseRate) && e.currentFromQvaCloseRate > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.currentFromQvaCloseRate, 1) + '</td>' +
      '<td>' + (isNum(v.upperTailRatio) ? (v.upperTailRatio * 100).toFixed(0) + '%' : '-') + '</td>' +
      '<td>' + (isNum(v.closePosition) ? (v.closePosition * 100).toFixed(0) + '%' : '-') + '</td>' +
      '<td class="neg"><strong>' + fmtPct(e.outcome.low10, 1) + '</strong></td>' +
      '<td>' + fmtPct(e.outcome.high10, 1) + '</td>' +
      '<td class="' + (isNum(e.outcome.close10) && e.outcome.close10 > 0 ? 'pos' : 'neg') + '">' + fmtPct(e.outcome.close10, 1) + '</td>' +
    '</tr>';
  }).join('');
})();

// ── V2: 거래대금 배율 / QVA→VVI 소요일 buckets ──
function renderBucketTable(tbId, buckets) {
  const tb = document.querySelector('#' + tbId + ' tbody');
  if (!tb) return;
  const rows = [];
  for (const [name, info] of Object.entries(buckets || {})) {
    const d = info.distribution || {};
    rows.push('<tr>' +
      '<td class="left"><strong>' + name + '</strong></td>' +
      '<td>' + info.count + '</td>' +
      '<td class="' + (isNum(d.avgHigh) && d.avgHigh > 0 ? 'pos' : 'neg') + '">' + fmtPct(d.avgHigh) + '</td>' +
      '<td class="' + (isNum(d.medianHigh) && d.medianHigh > 0 ? 'pos' : 'neg') + '"><strong>' + fmtPct(d.medianHigh) + '</strong></td>' +
      '<td>' + fmtRate(d.hit10) + '</td>' +
      '<td>' + fmtRate(d.hit20) + '</td>' +
      '<td class="' + (isNum(d.fail10) && d.fail10 >= 30 ? 'neg' : '') + '">' + fmtRate(d.fail10) + '</td>' +
      '<td class="' + (isNum(d.closePos) && d.closePos >= 50 ? 'pos' : '') + '">' + fmtRate(d.closePos) + '</td>' +
    '</tr>');
  }
  tb.innerHTML = rows.join('');
}
renderBucketTable('t-value-buckets', DATA.valueRatioBuckets);
renderBucketTable('t-days-buckets', DATA.daysFromQvaToVviBuckets);

// ── V2: 자동 결론 ──
(function renderConclusionV2() {
  const c = DATA.conclusionV2 || {};
  const html = [];
  if (c.avgVsMedian)  html.push('<div class="callout warn"><strong>① 평균 착시 검증</strong><br>' + c.avgVsMedian + '</div>');
  if (c.c1VsB)        html.push('<div class="callout"><strong>② C1 강한 추세형 vs B 비교</strong><br>' + c.c1VsB + '</div>');
  if (c.c2Verdict)    html.push('<div class="callout warn"><strong>③ C2 과열 — 대박 vs 위험</strong><br>' + c.c2Verdict + '</div>');
  if (c.c3Verdict)    html.push('<div class="callout warn"><strong>④ C3 피해야 할 유형 검증</strong><br>' + c.c3Verdict + '</div>');
  if ((c.valueRatioRanking || []).length) {
    html.push('<div class="callout info"><strong>⑤ 거래대금 배율별 성과 (D+10 중앙값 순)</strong><br>' +
      c.valueRatioRanking.map(r => '• ' + r.bucket + ' (n=' + r.n + ') 평균 ' + (r.avgHigh>0?'+':'') + (r.avgHigh||0).toFixed(1) + '% / 중앙값 ' + (r.medianHigh>0?'+':'') + (r.medianHigh||0).toFixed(1) + '% / +10% ' + (r.hit10||0).toFixed(0) + '% / -10% ' + (r.fail10||0).toFixed(0) + '%').join('<br>') +
      (c.valueRatioBest ? '<br><strong>→ 최선 구간: ' + c.valueRatioBest.bucket + '</strong>' : '') +
    '</div>');
  }
  if ((c.daysToVviRanking || []).length) {
    html.push('<div class="callout info"><strong>⑥ QVA → VVI 소요일별 성과 (D+10 중앙값 순)</strong><br>' +
      c.daysToVviRanking.map(r => '• ' + r.bucket + ' (n=' + r.n + ') 평균 ' + (r.avgHigh>0?'+':'') + (r.avgHigh||0).toFixed(1) + '% / 중앙값 ' + (r.medianHigh>0?'+':'') + (r.medianHigh||0).toFixed(1) + '% / +10% ' + (r.hit10||0).toFixed(0) + '% / -10% ' + (r.fail10||0).toFixed(0) + '%').join('<br>') +
      (c.daysToVviBest ? '<br><strong>→ 최선 구간: ' + c.daysToVviBest.bucket + '</strong>' : '') +
    '</div>');
  }
  if (c.c1Verdict) html.push('<div class="callout"><strong>⑦ 강한 추세형 살릴 가치</strong><br>' + c.c1Verdict + '</div>');
  if ((c.boardRecommendation || []).length) {
    html.push('<div class="callout"><strong>⑧ 운영 보드 반영 시 추천 노출 우선순위</strong><br>' +
      c.boardRecommendation.map((s, i) => (i + 1) + '. ' + s).join('<br>') + '</div>');
  }
  if (c.disclaimer) html.push('<div class="callout warn"><strong>⚠ 1차 세분화 한계</strong><br>' + c.disclaimer + '</div>');
  document.getElementById('conclusion-v2').innerHTML = html.join('') || '<div class="callout warn">V2 자동 결론 산출 실패.</div>';
})();

document.getElementById('foot').innerHTML =
  '<strong>새 VVI 정의 (이번 백테스트 한정):</strong><br>' +
  '• QVA 발생일 (high, volume, value) → 그 이후 첫 번째 거래일 중 high &gt; qvaHigh AND volume ≥ qvaVolume AND value ≥ qvaValue 만족하는 날.<br>' +
  '• 추격 부담 = QVA 종가 +25% 이상 또는 VVI 발생일 +20% 이상 위 (현재가 기준).<br>' +
  '<br><strong>baseline (진입 기준) 정의:</strong><br>' +
  '• A/B/C: VVI 발생일 종가 · D: 가격만 돌파한 첫날 종가 · E: 분석 기준일 종가 (참고용).<br>' +
  '<br><strong>주의:</strong> 1차 백테스트 — 표본 작음, 운영 반영 전. 실제 진입과 대응은 본인의 판단입니다.';
</script>
</body>
</html>
`;

if (require.main === module) main();

module.exports = { computeOutcomes, summarizeBucket };
