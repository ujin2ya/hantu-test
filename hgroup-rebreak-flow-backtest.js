#!/usr/bin/env node
/**
 * D+5 재돌파 운용 보드 — 수급 결합 백테스트
 *
 * 목적:
 *   현재 가장 강한 조건은 "종가 재돌파 + 기준 종가 이탈 없음"이다.
 *   여기에 외국인/기관/개인 수급을 붙였을 때 수익 비율과 평균 결과가 더 좋아지는지 검증한다.
 *   목표는 D+5 재돌파 운용 보드에 "수급 동반", "손바뀜 수급", "개인 과열 주의" 같은 태그를
 *   추가할지 결정하기 위한 보조 자료.
 *
 * 전제:
 *   1. 기존 H그룹/VPR 보드는 수정하지 않음 (입력만 읽음).
 *   2. D+5 재돌파 운용 보드 기준만 사용.
 *   3. 시장 레짐 필터 사용하지 않음.
 *   4. D+10 지표 사용하지 않음.
 *   5. 재돌파는 반드시 "종가 기준 재돌파"만 인정 — 장중 고가만 넘은 것은 인정 안 함.
 *
 * 입력:
 *   reports/vpr-hgroup-three-year-with-flow-backtest-result.json (events 448건)
 *   cache/stock-charts-long/{code}.json (D+0~D+5 OHLCV)
 *   cache/flow-history/{code}.json (외국인/기관 일별 순매수 금액)
 *
 * 출력:
 *   reports/hgroup-rebreak-flow-result.json
 *   reports/hgroup-rebreak-flow-result.html
 *
 * 라우트: GET /d5-rebreak-flow
 *
 * 수급 데이터 한계:
 *   cache/flow-history 행 키: foreignNetValue, instNetValue (외국인·기관 순매수 금액)
 *   개인 순매수 금액 = -(외국인 + 기관)으로 근사 (시장 합산 ≈ 0).
 *   프로그램 순매수 데이터 없음 — 해당 표는 생성 안 함.
 *   당일 거래대금 = chart의 valueApprox (close × volume).
 *   수급 비율(%) = 순매수 금액 / 거래대금 × 100.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const INPUT_PATH = path.join(REPORTS_DIR, 'vpr-hgroup-three-year-with-flow-backtest-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'hgroup-rebreak-flow-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'hgroup-rebreak-flow-result.html');

const HOLD_DAYS = 5;

// ─── 헬퍼 ───
function round(v, d = 2) { if (v == null || !Number.isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function mean(arr) { const v = arr.filter(x => x != null && Number.isFinite(x)); if (v.length === 0) return null; return v.reduce((s, x) => s + x, 0) / v.length; }
function median(arr) {
  const v = arr.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function rate(num, denom) { if (!denom) return null; return round(num / denom * 100, 2); }

// ─── flow 캐시 로드 + map(date → row) ───
function loadFlowMap(code) {
  const p = path.join(FLOW_DIR, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const f = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const m = new Map();
    for (const r of (f.rows || [])) m.set(r.date, r);
    return m;
  } catch (_) { return null; }
}

// 한 거래일의 수급 한 묶음 산출. valueApprox는 chart row에서 가져온다.
function flowAtDate(flowMap, chartRow) {
  if (!flowMap || !chartRow) return null;
  const fr = flowMap.get(chartRow.date);
  if (!fr) return null;
  const fNet = Number(fr.foreignNetValue) || 0;
  const iNet = Number(fr.instNetValue) || 0;
  const sumNet = fNet + iNet;
  // 개인 순매수 ≈ -(외국인 + 기관)  (시장 합산 ≈ 0 근사)
  const pNet = -sumNet;
  const val = Number(chartRow.valueApprox) || 0;
  const fPct = val > 0 ? fNet / val * 100 : null;
  const iPct = val > 0 ? iNet / val * 100 : null;
  const sPct = val > 0 ? sumNet / val * 100 : null;
  const pPct = val > 0 ? pNet / val * 100 : null;
  return {
    foreignNet: fNet, instNet: iNet, sumNet, indNet: pNet,
    valueApprox: val,
    foreignPct: round(fPct), instPct: round(iPct), sumPct: round(sPct), indPct: round(pPct),
  };
}

// 누적 수급 (idxFrom..idxTo 포함)
function flowCumulative(flowMap, rows, idxFrom, idxTo) {
  if (idxFrom < 0 || idxTo >= rows.length || idxFrom > idxTo) return null;
  let f = 0, i = 0, val = 0; let any = false;
  for (let k = idxFrom; k <= idxTo; k++) {
    const cr = rows[k];
    if (!cr) continue;
    const fr = flowMap.get(cr.date);
    if (!fr) continue;
    f += Number(fr.foreignNetValue) || 0;
    i += Number(fr.instNetValue) || 0;
    val += Number(cr.valueApprox) || 0;
    any = true;
  }
  if (!any) return null;
  const sum = f + i;
  const ind = -sum;
  return {
    foreignNet: f, instNet: i, sumNet: sum, indNet: ind,
    valueApprox: val,
    foreignPct: val > 0 ? round(f / val * 100) : null,
    instPct: val > 0 ? round(i / val * 100) : null,
    sumPct: val > 0 ? round(sum / val * 100) : null,
    indPct: val > 0 ? round(ind / val * 100) : null,
  };
}

// ─── 이벤트별 feature 계산 ───
function computeEventFeatures(e, rows, flowMap) {
  const hIdx = rows.findIndex(r => r.date === e.hDate);
  const vviIdx = rows.findIndex(r => r.date === e.vviDate);
  if (hIdx < 0 || vviIdx < 0) return null;
  const hRow = rows[hIdx];
  const vviRow = rows[vviIdx];
  if (!hRow || !vviRow) return null;
  const hClose = hRow.close, hHigh = hRow.high, hLow = hRow.low;
  const baseClose = vviRow.close;
  if (!hClose || !baseClose) return null;

  // VVI 이전 20거래일 평균 거래대금 → 거래대금 비율(valueRatio)
  const prev20Start = Math.max(0, vviIdx - 20);
  const prev20Rows = rows.slice(prev20Start, vviIdx);
  const prev20AvgValue = prev20Rows.length > 0
    ? prev20Rows.reduce((s, r) => s + (r.valueApprox || (r.close * r.volume) || 0), 0) / prev20Rows.length
    : 0;

  // D+1~D+5 추적 — 종가 재돌파, 이탈, MFE/MAE, close5
  let firstRebreakDay = null, firstRebreakDate = null, firstRebreakIdx = null, firstRebreakRow = null;
  let highMax = -Infinity, lowMin = Infinity;
  let everBelowBase = false;
  let close5 = null;
  let nextDayHoldAfterRebreak = null;

  for (let k = 1; k <= HOLD_DAYS; k++) {
    const r = rows[hIdx + k];
    if (!r) break;
    if (r.high > highMax) highMax = r.high;
    if (r.low < lowMin) lowMin = r.low;
    // 종가 재돌파 첫 날 (장중 고가는 인정 X — spec)
    if (firstRebreakDay == null && r.close >= hHigh) {
      firstRebreakDay = k;
      firstRebreakDate = r.date;
      firstRebreakIdx = hIdx + k;
      firstRebreakRow = r;
      const nx = rows[hIdx + k + 1];
      if (nx) nextDayHoldAfterRebreak = nx.close >= hHigh;
    }
    if (r.low < baseClose) everBelowBase = true;
    if (k === HOLD_DAYS) close5 = r.close;
  }
  if (close5 == null) {
    for (let k = HOLD_DAYS; k >= 1; k--) {
      if (rows[hIdx + k]) { close5 = rows[hIdx + k].close; break; }
    }
  }
  if (close5 == null) return null;

  // D+5 수익률 + MFE/MAE
  const close5Return = (close5 / hClose - 1) * 100;
  const mfe5 = (highMax / hClose - 1) * 100;
  const mae5 = (lowMin / hClose - 1) * 100;
  const timeStuck = mfe5 < 6 && mae5 > -5;

  // 재돌파일 거래대금 비율 (재돌파일 valueApprox / 직전 20일 평균)
  let rebreakValueRatio = null;
  if (firstRebreakRow && prev20AvgValue > 0) {
    const rv = firstRebreakRow.valueApprox || (firstRebreakRow.close * firstRebreakRow.volume) || 0;
    rebreakValueRatio = rv / prev20AvgValue;
  }

  // ─── 수급 ───
  // 1) H돌파일 수급 (참고 — 본 백테스트는 재돌파일 수급 중심)
  const flowH = flowAtDate(flowMap, hRow);

  // 2) 재돌파일 수급
  const flowRebreak = firstRebreakRow ? flowAtDate(flowMap, firstRebreakRow) : null;

  // 3) 재돌파 전 3거래일 누적 수급 — [firstRebreakIdx-3, firstRebreakIdx-1]
  let flowPre3 = null;
  if (firstRebreakIdx != null) {
    flowPre3 = flowCumulative(flowMap, rows, Math.max(0, firstRebreakIdx - 3), firstRebreakIdx - 1);
  }

  // 4) 재돌파 다음날 수급 (D+1 유지 확인)
  let flowPost1 = null;
  if (firstRebreakIdx != null && firstRebreakIdx + 1 < rows.length) {
    flowPost1 = flowAtDate(flowMap, rows[firstRebreakIdx + 1]);
  }

  return {
    code: e.code, name: e.name, hDate: e.hDate, vviDate: e.vviDate,
    hClose, hHigh, hLow, baseClose,
    firstRebreakDay, firstRebreakDate, firstRebreakIdx,
    closeRebreak: firstRebreakDay != null,         // 종가 재돌파 했는가
    rebreakValueRatio: round(rebreakValueRatio),
    everBelowBase,
    nextDayHoldAfterRebreak,
    close5, close5Return: round(close5Return),
    mfe5: round(mfe5), mae5: round(mae5),
    reach3: highMax >= hClose * 1.03,
    reach5: highMax >= hClose * 1.05,
    breachedBaseClose: lowMin < baseClose,
    timeStuck,
    win: close5Return > 0,
    flowH, flowRebreak, flowPre3, flowPost1,
  };
}

// ─── 그룹 통계 (베이스 대비 dWR/dE 포함) ───
function summarize(label, rows, baseStat = null) {
  const valid = rows.filter(r => r != null);
  if (valid.length === 0) return { label, n: 0 };
  const closes = valid.map(r => r.close5Return);
  const wins = valid.filter(r => r.win).length;
  const winRate = wins / valid.length * 100;
  const avgClose5 = mean(closes);
  const stat = {
    label, n: valid.length,
    winRate: round(winRate),
    avgClose5: round(avgClose5),
    medianClose5: round(median(closes)),
    avgMFE5: round(mean(valid.map(r => r.mfe5))),
    avgMAE5: round(mean(valid.map(r => r.mae5))),
    reach3Rate: rate(valid.filter(r => r.reach3).length, valid.length),
    reach5Rate: rate(valid.filter(r => r.reach5).length, valid.length),
    breachRate: rate(valid.filter(r => r.breachedBaseClose).length, valid.length),
    noRebreakRate: rate(valid.filter(r => r.firstRebreakDay == null).length, valid.length),
    timeStuckRate: rate(valid.filter(r => r.timeStuck).length, valid.length),
  };
  if (baseStat) {
    stat.dWR = stat.winRate != null && baseStat.winRate != null ? round(stat.winRate - baseStat.winRate) : null;
    stat.dE = stat.avgClose5 != null && baseStat.avgClose5 != null ? round(stat.avgClose5 - baseStat.avgClose5) : null;
  }
  return stat;
}

// ─── 사용자 친화적 해석 + 추천 여부 ───
//   1. n<30 → 참고용
//   2. n>=50 + dWR>0 + dE>0 → 유효 조건
//   3. dWR>0 + dE<=0 → 제외 (수익 비율만 좋고 평균은 악화)
//   4. n<30이고 외인/기관 결합 → 실전성 낮음
//   5. 개인 순매수 조건이 dE<0 → 추격성 개인 매수 주의
//   6. 개인 순매도 + 외인/기관 순매수가 dE>0 → 손바뀜 수급
function interpretCondition(label, stat) {
  if (!stat || stat.n == null || stat.n === 0) return { tag: '데이터 없음', reco: 'NONE', text: '데이터 없음' };
  const n = stat.n, dWR = stat.dWR, dE = stat.dE;
  const isPersonalBuyOnly = /개인 순매수|개인 매수 비중/.test(label) && !/순매도/.test(label);
  const isHandover = /개인 순매도.*외인.*기관|손바뀜/.test(label);

  if (n < 30) {
    return {
      tag: '참고용', reco: 'REF',
      text: `사례가 적어 참고용 (n<30) ${dE != null ? `· 평균 ${dE >= 0 ? '+' : ''}${dE}%p` : ''}`.trim(),
    };
  }
  if (dWR != null && dE != null && dWR > 0 && dE > 0) {
    if (n >= 50) {
      if (isHandover) return { tag: '손바뀜 수급', reco: 'STRONG', text: `손바뀜 수급 — 베이스 대비 수익 비율 +${dWR}p / 평균 +${dE}%p 동시 개선 (n=${n})` };
      return { tag: '유효', reco: n >= 80 ? 'STRONG' : 'EFFECTIVE', text: `유효 조건 — 수익 비율 +${dWR}p / 평균 +${dE}%p (n=${n})` };
    }
    return { tag: '약한 유효', reco: 'WEAK', text: `n<50 — 효과는 있으나 표본 부족 (수익 비율 +${dWR}p / 평균 +${dE}%p)` };
  }
  if (dE != null && dE < -0.5 && isPersonalBuyOnly) {
    return { tag: '개인 과열 주의', reco: 'WARN', text: `추격성 개인 매수 주의 — 평균 ${dE}%p 악화 (n=${n})` };
  }
  if (dE != null && dE < -0.5) {
    return { tag: '제외 후보', reco: 'EXCLUDE', text: `평균 ${dE}%p 악화 (n=${n})` };
  }
  if (dWR != null && dWR > 0 && dE != null && dE <= 0) {
    return { tag: '평균은 악화', reco: 'EXCLUDE', text: `수익 비율은 +${dWR}p이나 평균은 ${dE}%p — 제외 권장` };
  }
  return { tag: '비슷', reco: 'NEUTRAL', text: `베이스 근처 (n=${n})` };
}

// ─── 메인 ───
function main() {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error('[ERROR] 입력 없음:', INPUT_PATH);
    console.error('  → 먼저 vpr-hgroup-three-year-with-flow-backtest 결과가 reports/에 있어야 합니다.');
    process.exit(1);
  }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  console.log('\n📊 D+5 재돌파 + 수급 결합 백테스트');

  const inputData = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const events = inputData.events || [];
  console.log(`  입력 이벤트: ${events.length}건`);

  const trades = [];
  let flowMissing = 0;
  for (const e of events) {
    const chartPath = path.join(CHART_DIR, `${e.code}.json`);
    if (!fs.existsSync(chartPath)) continue;
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8')); } catch (_) { continue; }
    const rows = chart.rows || [];
    const flowMap = loadFlowMap(e.code);
    if (!flowMap) { flowMissing++; continue; }
    const f = computeEventFeatures(e, rows, flowMap);
    if (f) trades.push(f);
  }
  console.log(`  실효 trade: ${trades.length}건 (수급 누락: ${flowMissing}건)`);

  const baseStat = summarize('베이스 (전체 H그룹)', trades);
  console.log(`  베이스: 수익 비율 ${baseStat.winRate}% / 평균 ${baseStat.avgClose5}%`);

  // ─── 1. 베이스 조건 비교 (6) ───
  const SECTION_BASE = [];
  SECTION_BASE.push({ key: 'BASE',    label: '1) 전체 H그룹 (베이스)',                      match: () => true });
  SECTION_BASE.push({ key: 'CR',      label: '2) 종가 재돌파',                               match: t => t.closeRebreak });
  SECTION_BASE.push({ key: 'CR_NB',   label: '3) 종가 재돌파 + 기준 종가 이탈 없음',         match: t => t.closeRebreak && !t.everBelowBase });
  SECTION_BASE.push({ key: 'CR_HOLD', label: '4) 종가 재돌파 + 다음날 유지',                 match: t => t.closeRebreak && t.nextDayHoldAfterRebreak === true });
  SECTION_BASE.push({ key: 'CR_V2',   label: '5) 종가 재돌파 + 거래대금 ×2 이상',            match: t => t.closeRebreak && t.rebreakValueRatio != null && t.rebreakValueRatio >= 2 });
  SECTION_BASE.push({ key: 'CR_V5',   label: '6) 종가 재돌파 + 거래대금 ×5 이상',            match: t => t.closeRebreak && t.rebreakValueRatio != null && t.rebreakValueRatio >= 5 });
  const baseRows = SECTION_BASE.map(c => ({ key: c.key, ...summarize(c.label, trades.filter(c.match), baseStat) }));

  // ─── 2. 재돌파일 수급별 성과 — 외국인 ───
  const SECTION_FOREIGN = [
    { key: 'FN_POS',  label: '재돌파일 외국인 순매수 > 0',          match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.foreignNet > 0 },
    { key: 'FN_P1',   label: '재돌파일 외국인 매수 비중 ≥ 1%',      match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.foreignPct != null && t.flowRebreak.foreignPct >= 1 },
    { key: 'FN_P3',   label: '재돌파일 외국인 매수 비중 ≥ 3%',      match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.foreignPct != null && t.flowRebreak.foreignPct >= 3 },
    { key: 'FN_P5',   label: '재돌파일 외국인 매수 비중 ≥ 5%',      match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.foreignPct != null && t.flowRebreak.foreignPct >= 5 },
  ];
  const foreignRows = [{ key: 'BASE_CR', ...summarize('베이스 (종가 재돌파)', trades.filter(t => t.closeRebreak), baseStat) }];
  for (const c of SECTION_FOREIGN) foreignRows.push({ key: c.key, ...summarize(c.label, trades.filter(c.match), baseStat) });

  // ─── 3. 기관 ───
  const SECTION_INST = [
    { key: 'IN_POS',  label: '재돌파일 기관 순매수 > 0',           match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.instNet > 0 },
    { key: 'IN_P1',   label: '재돌파일 기관 매수 비중 ≥ 1%',       match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.instPct != null && t.flowRebreak.instPct >= 1 },
    { key: 'IN_P3',   label: '재돌파일 기관 매수 비중 ≥ 3%',       match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.instPct != null && t.flowRebreak.instPct >= 3 },
    { key: 'IN_P5',   label: '재돌파일 기관 매수 비중 ≥ 5%',       match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.instPct != null && t.flowRebreak.instPct >= 5 },
  ];
  const instRows = [{ key: 'BASE_CR', ...summarize('베이스 (종가 재돌파)', trades.filter(t => t.closeRebreak), baseStat) }];
  for (const c of SECTION_INST) instRows.push({ key: c.key, ...summarize(c.label, trades.filter(c.match), baseStat) });

  // ─── 4. 외인+기관 합산 ───
  const SECTION_SUM = [
    { key: 'SM_POS',  label: '재돌파일 외인+기관 순매수 > 0',        match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.sumNet > 0 },
    { key: 'SM_P1',   label: '재돌파일 외인+기관 매수 비중 ≥ 1%',    match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.sumPct != null && t.flowRebreak.sumPct >= 1 },
    { key: 'SM_P3',   label: '재돌파일 외인+기관 매수 비중 ≥ 3%',    match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.sumPct != null && t.flowRebreak.sumPct >= 3 },
    { key: 'SM_P5',   label: '재돌파일 외인+기관 매수 비중 ≥ 5%',    match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.sumPct != null && t.flowRebreak.sumPct >= 5 },
  ];
  const sumRows = [{ key: 'BASE_CR', ...summarize('베이스 (종가 재돌파)', trades.filter(t => t.closeRebreak), baseStat) }];
  for (const c of SECTION_SUM) sumRows.push({ key: c.key, ...summarize(c.label, trades.filter(c.match), baseStat) });

  // ─── 5. 개인 ───
  const SECTION_IND = [
    { key: 'PN_POS',     label: '재돌파일 개인 순매수 > 0',                  match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.indNet > 0 },
    { key: 'PN_NEG',     label: '재돌파일 개인 순매도 (개인 < 0)',           match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.indNet < 0 },
    { key: 'PN_HAND',    label: '재돌파일 개인 순매도 + 외인/기관 순매수',   match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.indNet < 0 && t.flowRebreak.sumNet > 0 },
    { key: 'PN_P5',      label: '재돌파일 개인 매수 비중 ≥ 5%',              match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.indPct != null && t.flowRebreak.indPct >= 5 },
    { key: 'PN_P10',     label: '재돌파일 개인 매수 비중 ≥ 10%',             match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.indPct != null && t.flowRebreak.indPct >= 10 },
    { key: 'PN_NOTHIGH', label: '재돌파일 개인 과다 매수 제외 (개인 < 10%)', match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.indPct != null && t.flowRebreak.indPct < 10 },
  ];
  const indRows = [{ key: 'BASE_CR', ...summarize('베이스 (종가 재돌파)', trades.filter(t => t.closeRebreak), baseStat) }];
  for (const c of SECTION_IND) indRows.push({ key: c.key, ...summarize(c.label, trades.filter(c.match), baseStat) });

  // ─── 6. 재돌파일 수급별 성과 (요약 — 위 4표 통합 비교) ───
  const SECTION_REBREAK_DAY = [
    { key: 'CR',         label: '종가 재돌파 (베이스)',                 match: t => t.closeRebreak },
    { key: 'CR_F_POS',   label: '+ 외국인 순매수',                       match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.foreignNet > 0 },
    { key: 'CR_I_POS',   label: '+ 기관 순매수',                         match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.instNet > 0 },
    { key: 'CR_S_POS',   label: '+ 외인+기관 순매수',                    match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.sumNet > 0 },
    { key: 'CR_S_P3',    label: '+ 외인+기관 비중 ≥ 3%',                 match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.sumPct != null && t.flowRebreak.sumPct >= 3 },
    { key: 'CR_HAND',    label: '+ 손바뀜 수급 (개인 매도 + 외인/기관 매수)', match: t => t.closeRebreak && t.flowRebreak && t.flowRebreak.indNet < 0 && t.flowRebreak.sumNet > 0 },
  ];
  const rebreakDayRows = SECTION_REBREAK_DAY.map(c => ({ key: c.key, ...summarize(c.label, trades.filter(c.match), baseStat) }));

  // ─── 7. 재돌파 전 3일 누적 ───
  const SECTION_PRE3 = [
    { key: 'CR',          label: '종가 재돌파 (베이스)',                            match: t => t.closeRebreak },
    { key: 'PRE3_F_POS',  label: '+ 재돌파 전 3일 외국인 누적 > 0',                 match: t => t.closeRebreak && t.flowPre3 && t.flowPre3.foreignNet > 0 },
    { key: 'PRE3_I_POS',  label: '+ 재돌파 전 3일 기관 누적 > 0',                   match: t => t.closeRebreak && t.flowPre3 && t.flowPre3.instNet > 0 },
    { key: 'PRE3_S_POS',  label: '+ 재돌파 전 3일 외인+기관 누적 > 0',              match: t => t.closeRebreak && t.flowPre3 && t.flowPre3.sumNet > 0 },
    { key: 'PRE3_P_NEG',  label: '+ 재돌파 전 3일 개인 누적 순매도',                match: t => t.closeRebreak && t.flowPre3 && t.flowPre3.indNet < 0 },
    { key: 'PRE3_S_HAND', label: '+ 재돌파 전 3일 외인+기관 매수 + 개인 매도',      match: t => t.closeRebreak && t.flowPre3 && t.flowPre3.sumNet > 0 && t.flowPre3.indNet < 0 },
  ];
  const pre3Rows = SECTION_PRE3.map(c => ({ key: c.key, ...summarize(c.label, trades.filter(c.match), baseStat) }));

  // ─── 8. 재돌파 후 1일 유지 ───
  const SECTION_POST1 = [
    { key: 'CR',           label: '종가 재돌파 (베이스)',                                match: t => t.closeRebreak },
    { key: 'POST_F_POS',   label: '+ 재돌파 다음날 외국인 순매수 유지',                    match: t => t.closeRebreak && t.flowPost1 && t.flowPost1.foreignNet > 0 },
    { key: 'POST_I_POS',   label: '+ 재돌파 다음날 기관 순매수 유지',                      match: t => t.closeRebreak && t.flowPost1 && t.flowPost1.instNet > 0 },
    { key: 'POST_S_POS',   label: '+ 재돌파 다음날 외인+기관 순매수 유지',                  match: t => t.closeRebreak && t.flowPost1 && t.flowPost1.sumNet > 0 },
    { key: 'POST_HOLD_S',  label: '+ 다음날 종가 유지 + 다음날 외인/기관 순매수 유지',     match: t => t.closeRebreak && t.nextDayHoldAfterRebreak === true && t.flowPost1 && t.flowPost1.sumNet > 0 },
  ];
  const post1Rows = SECTION_POST1.map(c => ({ key: c.key, ...summarize(c.label, trades.filter(c.match), baseStat) }));

  // ─── 9. 수급 조합 12종 (spec) ───
  const COMBOS = [
    { key: 'C1',  label: '1) 종가 재돌파 + 기준 종가 이탈 없음 (현행 핵심)',                match: t => t.closeRebreak && !t.everBelowBase },
    { key: 'C2',  label: '2) + 외국인 순매수',                                                match: t => t.closeRebreak && !t.everBelowBase && t.flowRebreak && t.flowRebreak.foreignNet > 0 },
    { key: 'C3',  label: '3) + 기관 순매수',                                                  match: t => t.closeRebreak && !t.everBelowBase && t.flowRebreak && t.flowRebreak.instNet > 0 },
    { key: 'C4',  label: '4) + 외인+기관 순매수',                                             match: t => t.closeRebreak && !t.everBelowBase && t.flowRebreak && t.flowRebreak.sumNet > 0 },
    { key: 'C5',  label: '5) + 외인+기관 매수 비중 ≥ 1%',                                    match: t => t.closeRebreak && !t.everBelowBase && t.flowRebreak && t.flowRebreak.sumPct != null && t.flowRebreak.sumPct >= 1 },
    { key: 'C6',  label: '6) + 외인+기관 매수 비중 ≥ 3%',                                    match: t => t.closeRebreak && !t.everBelowBase && t.flowRebreak && t.flowRebreak.sumPct != null && t.flowRebreak.sumPct >= 3 },
    { key: 'C7',  label: '7) + 외인+기관 매수 비중 ≥ 5%',                                    match: t => t.closeRebreak && !t.everBelowBase && t.flowRebreak && t.flowRebreak.sumPct != null && t.flowRebreak.sumPct >= 5 },
    { key: 'C8',  label: '8) + 손바뀜 수급 (개인 매도 + 외인/기관 매수)',                    match: t => t.closeRebreak && !t.everBelowBase && t.flowRebreak && t.flowRebreak.indNet < 0 && t.flowRebreak.sumNet > 0 },
    { key: 'C9',  label: '9) + 개인 과다 매수 제외 (개인 비중 < 10%)',                       match: t => t.closeRebreak && !t.everBelowBase && t.flowRebreak && t.flowRebreak.indPct != null && t.flowRebreak.indPct < 10 },
    { key: 'C10', label: '10) 종가 재돌파 + 거래대금 ×5 + 외인+기관 순매수',                  match: t => t.closeRebreak && t.rebreakValueRatio != null && t.rebreakValueRatio >= 5 && t.flowRebreak && t.flowRebreak.sumNet > 0 },
    { key: 'C11', label: '11) 종가 재돌파 + 다음날 유지 + 외인+기관 순매수',                  match: t => t.closeRebreak && t.nextDayHoldAfterRebreak === true && t.flowRebreak && t.flowRebreak.sumNet > 0 },
    { key: 'C12', label: '12) 종가 재돌파 + 다음날 유지 + 다음날 외인/기관 순매수 유지',      match: t => t.closeRebreak && t.nextDayHoldAfterRebreak === true && t.flowPost1 && t.flowPost1.sumNet > 0 },
  ];
  const comboRows = [{ key: 'BASE', ...summarize('베이스 (전체 H그룹)', trades, baseStat) }];
  for (const c of COMBOS) comboRows.push({ key: c.key, ...summarize(c.label, trades.filter(c.match), baseStat) });

  // ─── 10. 재돌파 전 3일 단독 검증 (spec 추가 요청) ───
  const SECTION_PRE3_PLUS_CR = [
    { key: 'CR_PRE3_S_CR', label: '재돌파 전 3일 외인+기관 누적 > 0 + 재돌파일 종가 재돌파', match: t => t.closeRebreak && t.flowPre3 && t.flowPre3.sumNet > 0 },
  ];
  // (이미 pre3Rows에 PRE3_S_POS로 포함됨 — recommendations 산출에는 같이 들어감)

  // ─── 추천/제외 산출 ───
  function score(s) { return (s.dWR || 0) + (s.dE || 0) * 5; }
  const allCells = [
    ...baseRows.map(s => ({ ...s, hyp: '베이스 비교' })),
    ...rebreakDayRows.map(s => ({ ...s, hyp: '재돌파일 수급' })),
    ...pre3Rows.map(s => ({ ...s, hyp: '재돌파 전 3일 누적' })),
    ...post1Rows.map(s => ({ ...s, hyp: '재돌파 후 1일 유지' })),
    ...foreignRows.map(s => ({ ...s, hyp: '외국인' })),
    ...instRows.map(s => ({ ...s, hyp: '기관' })),
    ...sumRows.map(s => ({ ...s, hyp: '외인+기관 합산' })),
    ...indRows.map(s => ({ ...s, hyp: '개인' })),
    ...comboRows.map(s => ({ ...s, hyp: '수급 조합' })),
  ];
  // 해석 + 추천 태그 부여
  for (const c of allCells) {
    const ic = interpretCondition(c.label, c);
    c.tag = ic.tag; c.reco = ic.reco; c.interp = ic.text;
  }

  const recs = allCells
    .filter(s => s.key !== 'BASE' && s.key !== 'BASE_CR' && s.n >= 50 && s.dWR > 0 && s.dE > 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 20)
    .map(s => ({ ...s, score: round(score(s), 2), tier: s.n >= 80 ? 'HIGH' : 'MID', isCore: s.winRate >= 70 && s.avgClose5 >= 5 }));

  const exclusions = allCells
    .filter(s => s.key !== 'BASE' && s.key !== 'BASE_CR' && s.n >= 30 && s.dE != null && s.dE < -1)
    .sort((a, b) => (a.dE || 0) - (b.dE || 0))
    .slice(0, 10);

  // ─── 보드 반영 추천 (사용자 spec) ───
  const personalBuyHurts = allCells.filter(s =>
    /개인 매수 비중 ≥ 10|개인 순매수 > 0/.test(s.label)
    && s.n >= 30 && s.dE != null && s.dE < -0.5
  );
  const handoverHelps = allCells.filter(s =>
    /손바뀜|개인 매도 \+ 외인\/기관 매수|개인 순매도 \+ 외인\/기관 순매수/.test(s.label)
    && s.n >= 30 && s.dE != null && s.dE > 0
  );
  const flowSupportHelps = recs.filter(r =>
    /외인\+기관|외국인 순매수|기관 순매수/.test(r.label)
    && !/제외|손바뀜/.test(r.label)
  ).slice(0, 5);

  const boardRecommendations = [
    {
      title: '✅ 수급 동반 → 보드 강조 추천',
      items: flowSupportHelps,
      note: 'n≥50 + 수익 비율과 평균 결과 동시 개선. "수급 동반" 태그 부착 후보.',
    },
    {
      title: '🔄 손바뀜 수급 → 별도 태그 추천',
      items: handoverHelps.filter(s => s.n >= 30).slice(0, 5),
      note: '개인 매도 + 외인/기관 매수가 평균 결과를 끌어올리면 "손바뀜 수급" 태그 부착 후보.',
    },
    {
      title: '⚠ 개인 과열 주의 → 경고 태그 추천',
      items: personalBuyHurts.slice(0, 5),
      note: '개인 매수가 강할수록 D+5 평균 결과가 떨어지면 "개인 과열 주의" 태그 부착 후보.',
    },
    {
      title: '❌ 부정 수급 조건 (제외 후보)',
      items: exclusions.slice(0, 5),
      note: '베이스 대비 평균 결과 -1%p 이상 악화 — 신규 진입 회피 후보.',
    },
  ];

  // ─── 출력 ───
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'D+5 재돌파 운용 보드 — 수급 결합 백테스트',
      purpose: '종가 재돌파 조건에 외국인/기관/개인 수급을 붙였을 때 D+5 수익 비율과 평균 결과가 더 좋아지는지 확인. D+5 재돌파 운용 보드에 "수급 동반", "손바뀜 수급", "개인 과열 주의" 태그를 추가할지 결정하기 위한 보조 자료.',
      noFutureInfo: '필터는 모두 매수 시점 또는 D+1~D+5 장중 실시간 확인 가능한 정보만 사용.',
      entry: 'H돌파일 종가 (D+0)',
      hold: 'D+1~D+5 단순 보유 (TP/SL 없음)',
      flowDataNote: '외국인/기관 순매수 금액은 cache/flow-history. 개인 ≈ -(외국인 + 기관). 거래대금은 chart의 valueApprox(close × volume). 프로그램 순매수 데이터 없음 — 표 생략.',
      assumptions: [
        '재돌파는 "종가 기준 재돌파"만 인정 (장중 고가만 넘은 것은 제외).',
        '시장 레짐 필터 미사용.',
        'D+10 지표 미사용.',
        '기존 H그룹/VPR 보드 미수정 (입력만 읽음).',
      ],
    },
    counts: { totalEvents: events.length, effectiveTrades: trades.length, flowMissing },
    baseline: baseStat,
    sections: {
      base:        { label: '베이스 조건 비교',          items: baseRows },
      rebreakDay:  { label: '재돌파일 수급별 성과',       items: rebreakDayRows },
      pre3:        { label: '재돌파 전 3일 누적 수급',    items: pre3Rows },
      post1:       { label: '재돌파 후 1일 수급 유지',    items: post1Rows },
      foreign:     { label: '외국인 수급 조건표',         items: foreignRows },
      inst:        { label: '기관 수급 조건표',           items: instRows },
      sum:         { label: '외인+기관 합산 조건표',      items: sumRows },
      individual:  { label: '개인 수급 조건표',           items: indRows },
      combo:       { label: '수급 조합',                  items: comboRows },
    },
    recommendations: recs,
    exclusions,
    boardRecommendations,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // 콘솔 출력
  function dump(label, rows) {
    console.log(`\n📊 ${label}`);
    console.log(`  조건                                                                      n     수익    평균    중간    개선WR   개선E   추천`);
    for (const r of rows) {
      const dWR = r.dWR != null ? (r.dWR >= 0 ? '+' : '') + r.dWR : '-';
      const dE = r.dE != null ? (r.dE >= 0 ? '+' : '') + r.dE : '-';
      const mark = r.n != null && r.n < 30 ? '⚠' : (r.n < 50 ? '(참)' : '');
      console.log(`  ${(r.label || '-').padEnd(70)} ${String(r.n).padStart(4)}  ${String(r.winRate ?? '-').padStart(5)}%  ${String(r.avgClose5 ?? '-').padStart(6)}%  ${String(r.medianClose5 ?? '-').padStart(5)}%  ${dWR.padStart(6)}  ${dE.padStart(6)}  ${(r.tag || '').padEnd(12)} ${mark}`);
    }
  }
  dump('1. 베이스 조건 비교', baseRows);
  dump('2. 재돌파일 수급별', rebreakDayRows);
  dump('3. 재돌파 전 3일 누적', pre3Rows);
  dump('4. 재돌파 후 1일 유지', post1Rows);
  dump('5. 외국인 단독', foreignRows);
  dump('6. 기관 단독', instRows);
  dump('7. 외인+기관', sumRows);
  dump('8. 개인 단독', indRows);
  dump('9. 수급 조합', comboRows);

  console.log(`\n🏆 추천 수급 조건 TOP 20 (n≥50, 동시 개선):`);
  for (const r of recs) {
    const tag = r.isCore ? '⭐ 핵심' : (r.tier === 'HIGH' ? '🟢 고신뢰' : '🟡 중간');
    console.log(`  ${tag} [${r.hyp}] ${r.label} → n=${r.n}, 수익 비율 ${r.winRate}% (Δ${r.dWR > 0 ? '+' : ''}${r.dWR}), 평균 ${r.avgClose5}% (Δ${r.dE > 0 ? '+' : ''}${r.dE})`);
  }
  console.log(`\n❌ 부정 수급 조건 TOP 10 (베이스 대비 평균 -1%p 이상):`);
  for (const r of exclusions) {
    console.log(`  [${r.hyp}] ${r.label} → n=${r.n}, 수익 비율 ${r.winRate}%, 평균 ${r.avgClose5}% (Δ${r.dE})`);
  }

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>D+5 재돌파 운용 — 수급 결합 백테스트</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px; -webkit-overflow-scrolling: touch;
}
nav { display:flex; gap:10px; flex-wrap:wrap; padding:8px 0 14px; border-bottom:1px solid #1e293b; margin-bottom:14px; }
nav a { color:#94a3b8; text-decoration:none; font-size:12px; padding:4px 8px; border-radius:4px; }
nav a:hover { color:#e2e8f0; background:#1e293b; }
nav a.active { color:#f1f5f9; background:#1e293b; }
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 16px 0 8px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #0f172a; border-left: 3px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

.scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; margin-bottom: 14px; border-radius: 8px; }
table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 8px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; white-space: nowrap; }
table.cmp thead th:first-child { text-align: left; }
table.cmp tbody td { padding: 7px 8px; border-bottom: 1px solid #334155; text-align: right; }
table.cmp tbody td:first-child { text-align: left; color: #cbd5e1; font-weight: 600; max-width: 360px; }
table.cmp tbody tr:hover td { background: #273549; }
.row-base td { background: rgba(99,102,241,0.10) !important; font-weight: 600; }
.row-good td { background: rgba(16,185,129,0.12) !important; }
.row-bad td { background: rgba(239,68,68,0.10) !important; }
.row-handover td { background: rgba(56,189,248,0.10) !important; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-neutral { color: #94a3b8; }
.cell-strong-pos { color: #34d399; font-weight: 700; }
.cell-warn { color: #fbbf24; font-weight: 600; }
.tag-low-n { color: #fbbf24; font-size: 10px; }
.tag-ref-only { color: #fbbf24; font-size: 10px; }
.cell-interp { font-size: 11.5px; line-height: 1.5; max-width: 240px; white-space: normal; text-align: left; }
.cell-interp.is-strong { color: #6ee7b7; font-weight: 600; }
.cell-interp.is-weak { color: #fca5a5; }
.cell-interp.is-warn { color: #fbbf24; }
.cell-interp.is-base { color: #94a3b8; font-style: italic; }
.cell-interp.is-ref { color: #fbbf24; font-style: italic; }
.cell-interp.is-handover { color: #67e8f9; font-weight: 600; }

.tag-pill { display:inline-block; padding:1px 8px; border-radius:9px; font-size:10.5px; font-weight:600; }
.tag-pill.t-strong { background:#064e3b; color:#6ee7b7; }
.tag-pill.t-effective { background:#064e3b; color:#a7f3d0; }
.tag-pill.t-handover { background:#0c4a6e; color:#7dd3fc; }
.tag-pill.t-warn { background:#451a03; color:#fbbf24; }
.tag-pill.t-exclude { background:#450a0a; color:#fca5a5; }
.tag-pill.t-ref { background:#1f2937; color:#fbbf24; }
.tag-pill.t-neutral { background:#1f2937; color:#94a3b8; }
.tag-pill.t-weak { background:#1f2937; color:#a7f3d0; }
.tag-pill.t-none { background:#1f2937; color:#64748b; }

.col-tip { display: inline-flex; align-items: center; gap: 4px; cursor: help; position: relative; }
.col-tip .ico { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; border: 1px solid #475569; color: #94a3b8; font-size: 9px; font-weight: 700; background: #0f172a; }
.col-tip:hover .ico { border-color: #38bdf8; color: #38bdf8; }
.col-tip:hover::after {
  content: attr(data-tip);
  position: absolute; bottom: 130%; left: 50%; transform: translateX(-50%);
  background: #0f172a; color: #f1f5f9; padding: 8px 12px; border-radius: 6px;
  font-size: 11px; white-space: normal; width: 240px; z-index: 100;
  border: 1px solid #475569; line-height: 1.6; font-weight: 400;
  text-transform: none; letter-spacing: 0; text-align: left;
  pointer-events: none; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.table-wrap { margin-bottom: 14px; }
.toggle-detail-btn { background:#0f172a; border:1px solid #334155; color:#cbd5e1; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:11px; margin-bottom:6px; }
.toggle-detail-btn:hover { background:#273549; color:#f1f5f9; border-color:#475569; }
table.cmp .col-detail { display: none; }
table.cmp.show-detail .col-detail { display: table-cell; }

.table-help { background: #0f172a; border-left: 3px solid #fbbf24; padding: 9px 14px; border-radius: 6px; margin-bottom: 10px; line-height: 1.6; color: #fde68a; font-size: 12px; }

.summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin-bottom: 14px; }
.summary-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 14px; }
.summary-card.core { border-left: 4px solid #10b981; }
.summary-card.aux { border-left: 4px solid #38bdf8; }
.summary-card.warn { border-left: 4px solid #f59e0b; }
.summary-card.bad { border-left: 4px solid #ef4444; }
.summary-card h3 { margin: 0 0 6px; font-size: 13px; color: #f1f5f9; }
.summary-card .item { font-size: 11.5px; line-height: 1.7; color: #cbd5e1; padding: 3px 0; border-bottom: 1px dashed #334155; }
.summary-card .item:last-child { border-bottom: none; }
.summary-card .stat { color: #94a3b8; font-size: 10.5px; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; }
  .scroll-x table.cmp { width: max-content; min-width: 100%; white-space: nowrap; }
}
</style>
</head>
<body>

<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/rebreak">🔥 D+5 재돌파 운용</a>
  <a href="/rebreak-deep">🔬 재돌파 심층 검증</a>
  <a href="/d5-rebreak-flow" class="active">💱 재돌파 + 수급 결합</a>
</nav>

<h1>💱 D+5 재돌파 운용 — 수급 결합 백테스트</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  현재 가장 강한 조건은 <strong>"종가 재돌파 + 기준 종가 이탈 없음"</strong>이다.
  여기에 외국인/기관/개인 수급을 붙였을 때 <strong>수익 비율과 평균 결과가 동시에</strong> 더 좋아지는지 확인한다.
  목표는 D+5 재돌파 운용 보드에 <strong>"수급 동반", "손바뀜 수급", "개인 과열 주의"</strong> 같은 태그를 추가할지 결정하기 위한 보조 자료.
</div>

<div class="warn-banner" id="warn-banner"></div>

<h2>🏆 1. 핵심 요약 — 보드 반영 추천</h2>
<div class="summary-cards" id="summary-cards"></div>

<div class="table-help">
  💡 <strong>이 표 보는 법</strong> — <strong>사례 수 30개 미만은 참고용</strong>(⚠), <strong>50개 미만은 신호 약함</strong>(참고용 표시), <strong>50개 이상이면서 수익 비율과 평균 결과가 동시 개선</strong>이면 유효 조건으로 봅니다.
  외인/기관 수급을 붙였는데 사례 수가 너무 줄면 <strong>실전성 낮음</strong>으로 표시합니다.
</div>

<h2>📊 2. 베이스 조건 비교</h2>
<p class="subtitle">전체 H그룹 / 종가 재돌파 / + 이탈 없음 / + 다음날 유지 / + 거래대금 ×2/×5.</p>
<div id="base-table"></div>

<h2>📊 3. 재돌파일 수급별 성과 (요약)</h2>
<p class="subtitle">종가 재돌파를 이미 만족한 그룹에 대해 외국인/기관/외인+기관/손바뀜 수급을 붙인 비교.</p>
<div id="rebreakDay-table"></div>

<h2>📊 4. 재돌파 전 3일 누적 수급별 성과</h2>
<p class="subtitle">재돌파일 직전 3거래일 동안 외국인/기관 누적 수급이 어땠을 때 D+5가 더 좋은지.</p>
<div id="pre3-table"></div>

<h2>📊 5. 재돌파 후 1일 수급 유지 성과</h2>
<p class="subtitle">재돌파 다음날에도 외국인/기관 순매수가 이어졌는지가 D+5에 영향이 있는지.</p>
<div id="post1-table"></div>

<h2>📊 6. 외국인 수급 조건표</h2>
<p class="subtitle">재돌파일 외국인 순매수 / 매수 비중 1·3·5% 단계별 비교.</p>
<div id="foreign-table"></div>

<h2>📊 7. 기관 수급 조건표</h2>
<p class="subtitle">재돌파일 기관 순매수 / 매수 비중 1·3·5% 단계별 비교.</p>
<div id="inst-table"></div>

<h2>📊 8. 외인+기관 합산 조건표</h2>
<p class="subtitle">외국인 + 기관 합산 순매수 / 매수 비중 1·3·5% 단계별 비교.</p>
<div id="sum-table"></div>

<h2>📊 9. 개인 수급 조건표</h2>
<p class="subtitle">개인 순매수/매도 + 매수 비중 단계 + 손바뀜 + 과다 매수 제외.</p>
<div id="ind-table"></div>

<h2>📊 10. 수급 조합 (12종)</h2>
<p class="subtitle">기존 핵심(종가 재돌파 + 이탈 없음)에 수급을 한 단계씩 더해 가는 조합.</p>
<div id="combo-table"></div>

<h2>🏅 11. 수급 조합 TOP 20 (사례 50건 이상, 수익 비율과 평균 결과 동시 개선)</h2>
<div id="rec-table"></div>

<h2>🚨 12. 부정 수급 조건 TOP 10 (베이스 대비 평균 결과 -1%p 이상 악화)</h2>
<div id="excl-table"></div>

<h2>🎯 13. 보드 반영 추천 — 태그 추가 후보</h2>
<div id="board-reco" class="summary-cards"></div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;
const baseline = DATA.baseline;

function fmtPct(v) {
  if (v == null || !isFinite(v)) return '<span class="cell-neutral">-</span>';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%</span>';
}
function fmtWinRate(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v >= 70 ? 'cell-strong-pos' : (v >= 60 ? 'cell-pos' : (v < 35 ? 'cell-neg' : 'cell-neutral'));
  return '<span class="' + cls + '">' + Number(v).toFixed(1) + '%</span>';
}
function fmtAvg(v) {
  if (v == null || !isFinite(v)) return '<span class="cell-neutral">-</span>';
  const cls = v >= 5 ? 'cell-strong-pos' : (v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral'));
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%</span>';
}
function fmtBreachRate(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v >= 50 ? 'cell-warn' : (v >= 30 ? 'cell-neutral' : 'cell-pos');
  return '<span class="' + cls + '">' + Number(v).toFixed(1) + '%</span>';
}
function fmtNoRebreakRate(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v >= 70 ? 'cell-warn' : (v >= 30 ? 'cell-neutral' : 'cell-pos');
  return '<span class="' + cls + '">' + Number(v).toFixed(1) + '%</span>';
}
function fmtPlainRate(v) { if (v == null) return '<span class="cell-neutral">-</span>'; return Number(v).toFixed(1) + '%'; }
function fmtDelta(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral');
  const arrow = v > 0 ? '▲' : (v < 0 ? '▼' : '─');
  return '<span class="' + cls + '">' + arrow + Math.abs(v).toFixed(2) + '</span>';
}
function fmtN(n) {
  if (n == null) return '-';
  if (n < 30) return '<span class="tag-low-n">' + n + ' ⚠</span>';
  if (n < 50) return n + ' <span class="tag-ref-only">(참고용)</span>';
  return n;
}
function tagPill(tag, reco) {
  const map = {
    STRONG: 't-strong', EFFECTIVE: 't-effective', WEAK: 't-weak',
    WARN: 't-warn', EXCLUDE: 't-exclude', REF: 't-ref',
    NEUTRAL: 't-neutral', NONE: 't-none',
  };
  if (tag === '손바뀜 수급') return '<span class="tag-pill t-handover">' + tag + '</span>';
  const cls = map[reco] || 't-neutral';
  return '<span class="tag-pill ' + cls + '">' + (tag || '-') + '</span>';
}

function buildRowInterpretation(r, baseLabel) {
  if (r.key === 'BASE' || r.key === 'BASE_CR' || r.label === baseLabel) return { text: '비교 기준 (베이스)', cls: 'is-base' };
  if (r.n == null || r.n === 0) return { text: '데이터 없음', cls: 'is-base' };
  if (r.n < 30) return { text: '실전성 낮음 — 사례 부족 (n<30)', cls: 'is-ref' };
  const wr = r.winRate, avg = r.avgClose5;
  if (wr != null && wr >= 70 && avg != null && avg >= 5) {
    if (/손바뀜|개인 매도 \\+ 외인\\/기관 매수/.test(r.label)) return { text: '손바뀜 수급 — 강한 시그널', cls: 'is-handover' };
    return { text: '강한 긍정 — 핵심 수급 조건', cls: 'is-strong' };
  }
  if (r.dWR != null && r.dE != null && r.dWR > 0 && r.dE > 0) {
    if (/손바뀜|개인 매도 \\+ 외인\\/기관 매수/.test(r.label)) return { text: '손바뀜 수급 — 베이스 대비 동시 개선', cls: 'is-handover' };
    return { text: '베이스 대비 동시 개선 — 유효', cls: 'is-strong' };
  }
  if (r.dWR != null && r.dWR > 0 && r.dE != null && r.dE <= 0) {
    return { text: '수익 비율은 좋아졌지만 평균 결과는 악화 — 제외 권장', cls: 'is-warn' };
  }
  if (r.dE != null && r.dE < -1) {
    if (/개인 순매수 > 0|개인 매수 비중/.test(r.label)) return { text: '추격성 개인 매수 주의', cls: 'is-warn' };
    return { text: '평균 결과 악화', cls: 'is-weak' };
  }
  if (r.n < 50) return { text: '사례 부족 (n<50) — 참고용', cls: 'is-ref' };
  return { text: '베이스 근처', cls: 'is-base' };
}

document.getElementById('subtitle').textContent =
  '입력 ' + DATA.counts.totalEvents + '건 → 실효 ' + DATA.counts.effectiveTrades + '건 (수급 누락 ' + (DATA.counts.flowMissing || 0) + '건) · ' +
  '전체 H그룹 평균: 수익 비율 ' + baseline.winRate + '%, 평균 결과 ' + baseline.avgClose5 + '% · ' +
  '생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

document.getElementById('warn-banner').innerHTML =
  '⚠ <strong>전제</strong> — 재돌파는 종가 기준만 인정 (장중 고가만 넘은 것은 제외) · 시장 레짐 필터 미사용 · D+10 미사용 · 진입 = H돌파일 종가, 청산 = D+5 종가. ' +
  '<strong>개인 수급은 -(외국인 + 기관)으로 근사</strong>한 값 (시장 합산 ≈ 0). 프로그램 순매수 데이터는 cache에 없어 표 생략.';

function thWithTip(label, tip, extraCls) {
  const cls = extraCls ? ' class="' + extraCls + '"' : '';
  if (!tip) return '<th' + cls + '>' + label + '</th>';
  return '<th' + cls + '><span class="col-tip" data-tip="' + tip.replace(/"/g, '&quot;') + '">' + label + '<span class="ico">?</span></span></th>';
}
function toggleDetailBtn(btn) {
  const wrap = btn.closest('.table-wrap');
  if (!wrap) return;
  const tbl = wrap.querySelector('table.cmp');
  if (!tbl) return;
  tbl.classList.toggle('show-detail');
  btn.textContent = tbl.classList.contains('show-detail') ? '◀ 상세 숨기기' : '상세 보기 ▶';
}
window.toggleDetailBtn = toggleDetailBtn;

const T = {
  n: '과거에 이 조건에 해당한 종목 수입니다. 50개 이상이면 어느 정도 의미 있게 볼 수 있습니다.',
  winRate: 'D+5 안의 운용 기준으로 수익으로 끝난 비율입니다. (개발자용: 승률)',
  avg: '이 조건에 해당한 종목을 매번 운용했다고 가정했을 때의 평균 수익률입니다.',
  median: '극단치 영향을 줄인 가운데값입니다. (개발자용: 중앙값)',
  mfe: 'D+5 안에 한 번이라도 가장 많이 올라간 수익률입니다. (개발자용: MFE5)',
  mae: 'D+5 안에 한 번이라도 가장 많이 밀린 손실률입니다. (개발자용: MAE5)',
  r3: 'D+5 안에 한 번이라도 +3% 이상 수익권을 준 비율입니다.',
  r5: 'D+5 안에 한 번이라도 +5% 이상 수익권을 준 비율입니다.',
  breach: '기준 종가 아래로 내려간 비율입니다. (검증상 매우 나쁜 신호)',
  norb: 'H돌파일 고가를 종가 기준으로 다시 못 넘은 비율입니다.',
  stuck: 'D+5 안에 뚜렷한 상승/하락 결과가 나오지 않고 끝난 비율입니다.',
  dwr: '전체 H그룹 대비 수익 비율이 얼마나 좋아졌는지입니다. (개발자용: ΔWR)',
  de: '전체 H그룹 대비 평균 결과가 얼마나 좋아졌는지입니다. (개발자용: ΔE)',
  interp: '이 조건의 통계 결과를 한 줄 문장으로 요약합니다.',
  reco: '추천 여부 — 유효/손바뀜 수급/개인 과열 주의/제외 후보 등.',
};

function renderTable(elId, items, baseLabel) {
  const html = [
    '<div class="table-wrap">',
    '<button class="toggle-detail-btn" onclick="toggleDetailBtn(this)">상세 보기 ▶</button>',
    '<div class="scroll-x"><table class="cmp"><thead><tr>',
    thWithTip('조건', null),
    thWithTip('사례 수', T.n),
    thWithTip('수익 비율', T.winRate),
    thWithTip('평균 결과', T.avg),
    thWithTip('보통 결과', T.median, 'col-detail'),
    thWithTip('5일 최고 상승', T.mfe),
    thWithTip('5일 최대 하락', T.mae),
    thWithTip('+3% 기회', T.r3, 'col-detail'),
    thWithTip('+5% 기회', T.r5, 'col-detail'),
    thWithTip('기준가 깨짐', T.breach, 'col-detail'),
    thWithTip('재돌파 실패', T.norb),
    thWithTip('5일 내 결론 없음', T.stuck, 'col-detail'),
    thWithTip('승률 개선', T.dwr, 'col-detail'),
    thWithTip('평균 개선', T.de, 'col-detail'),
    thWithTip('해석', T.interp),
    thWithTip('추천 여부', T.reco),
    '</tr></thead><tbody>'];
  for (const r of items) {
    const isBase = r.key === 'BASE' || r.key === 'BASE_CR' || (baseLabel && r.label === baseLabel);
    const isHandover = /손바뀜|개인 매도 \\+ 외인\\/기관 매수/.test(r.label || '');
    let cls = '';
    if (isBase) cls = ' class="row-base"';
    else if (isHandover && r.n >= 30 && r.dE != null && r.dE > 0) cls = ' class="row-handover"';
    else if (r.n != null && r.n >= 50 && r.dWR > 0 && r.dE > 0) cls = ' class="row-good"';
    else if (r.n != null && r.n >= 30 && r.dE != null && r.dE < -1) cls = ' class="row-bad"';
    const interp = buildRowInterpretation(r, baseLabel);
    html.push('<tr' + cls + '>' +
      '<td>' + r.label + '</td>' +
      '<td>' + fmtN(r.n) + '</td>' +
      '<td>' + fmtWinRate(r.winRate) + '</td>' +
      '<td>' + fmtAvg(r.avgClose5) + '</td>' +
      '<td class="col-detail">' + fmtAvg(r.medianClose5) + '</td>' +
      '<td>' + fmtPct(r.avgMFE5) + '</td>' +
      '<td>' + fmtPct(r.avgMAE5) + '</td>' +
      '<td class="col-detail">' + fmtPlainRate(r.reach3Rate) + '</td>' +
      '<td class="col-detail">' + fmtPlainRate(r.reach5Rate) + '</td>' +
      '<td class="col-detail">' + fmtBreachRate(r.breachRate) + '</td>' +
      '<td>' + fmtNoRebreakRate(r.noRebreakRate) + '</td>' +
      '<td class="col-detail">' + fmtPlainRate(r.timeStuckRate) + '</td>' +
      '<td class="col-detail">' + (isBase ? '-' : fmtDelta(r.dWR)) + '</td>' +
      '<td class="col-detail">' + (isBase ? '-' : fmtDelta(r.dE)) + '</td>' +
      '<td class="cell-interp ' + interp.cls + '">' + interp.text + '</td>' +
      '<td>' + (isBase ? '-' : tagPill(r.tag, r.reco)) + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div></div>');
  document.getElementById(elId).innerHTML = html.join('');
}

renderTable('base-table',       DATA.sections.base.items);
renderTable('rebreakDay-table', DATA.sections.rebreakDay.items, '종가 재돌파 (베이스)');
renderTable('pre3-table',       DATA.sections.pre3.items,       '종가 재돌파 (베이스)');
renderTable('post1-table',      DATA.sections.post1.items,      '종가 재돌파 (베이스)');
renderTable('foreign-table',    DATA.sections.foreign.items,    '베이스 (종가 재돌파)');
renderTable('inst-table',       DATA.sections.inst.items,       '베이스 (종가 재돌파)');
renderTable('sum-table',        DATA.sections.sum.items,        '베이스 (종가 재돌파)');
renderTable('ind-table',        DATA.sections.individual.items, '베이스 (종가 재돌파)');
renderTable('combo-table',      DATA.sections.combo.items);

function renderRecTable() {
  const recs = DATA.recommendations || [];
  if (recs.length === 0) {
    document.getElementById('rec-table').innerHTML = '<div class="purpose-box" style="border-left-color:#fbbf24;color:#fde68a;">⚠ 사례 50개 이상 + 동시 개선 조건 없음.</div>';
    return;
  }
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>#</th>',
    '<th>가설</th>',
    '<th>조건</th>',
    thWithTip('사례 수', T.n),
    thWithTip('수익 비율', T.winRate),
    thWithTip('평균 결과', T.avg),
    thWithTip('승률 개선', T.dwr),
    thWithTip('평균 개선', T.de),
    '<th>등급</th>',
    '<th>추천</th>',
    '</tr></thead><tbody>'];
  recs.forEach((r, i) => {
    const isHandover = /손바뀜|개인 매도 \\+ 외인\\/기관 매수/.test(r.label);
    const cls = isHandover ? ' class="row-handover"' : (r.isCore ? ' class="row-good"' : '');
    const tier = r.isCore ? '⭐ 핵심 (수익 비율 70%↑ + 평균 +5%↑)' : (r.tier === 'HIGH' ? '🟢 고신뢰 (사례 80↑)' : '🟡 중간');
    html.push('<tr' + cls + '>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + r.hyp + '</td>' +
      '<td>' + r.label + '</td>' +
      '<td>' + fmtN(r.n) + '</td>' +
      '<td>' + fmtWinRate(r.winRate) + '</td>' +
      '<td>' + fmtAvg(r.avgClose5) + '</td>' +
      '<td>' + fmtDelta(r.dWR) + '</td>' +
      '<td>' + fmtDelta(r.dE) + '</td>' +
      '<td>' + tier + '</td>' +
      '<td>' + tagPill(r.tag, r.reco) + '</td>' +
      '</tr>');
  });
  html.push('</tbody></table></div>');
  document.getElementById('rec-table').innerHTML = html.join('');
}
renderRecTable();

function renderExclTable() {
  const ex = DATA.exclusions || [];
  if (ex.length === 0) {
    document.getElementById('excl-table').innerHTML = '<div class="purpose-box" style="border-left-color:#94a3b8;color:#cbd5e1;">제외 후보 없음.</div>';
    return;
  }
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>#</th>',
    '<th>가설</th>',
    '<th>조건</th>',
    thWithTip('사례 수', T.n),
    thWithTip('수익 비율', T.winRate),
    thWithTip('평균 결과', T.avg),
    thWithTip('승률 개선', T.dwr),
    thWithTip('평균 개선', T.de),
    '<th>해석</th>',
    '</tr></thead><tbody>'];
  ex.forEach((r, i) => {
    html.push('<tr class="row-bad">' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + r.hyp + '</td>' +
      '<td>' + r.label + '</td>' +
      '<td>' + fmtN(r.n) + '</td>' +
      '<td>' + fmtWinRate(r.winRate) + '</td>' +
      '<td>' + fmtAvg(r.avgClose5) + '</td>' +
      '<td>' + fmtDelta(r.dWR) + '</td>' +
      '<td>' + fmtDelta(r.dE) + '</td>' +
      '<td class="cell-interp is-weak">' + (r.interp || '평균 결과 악화') + '</td>' +
      '</tr>');
  });
  html.push('</tbody></table></div>');
  document.getElementById('excl-table').innerHTML = html.join('');
}
renderExclTable();

function renderSummaryCards() {
  const html = [];
  for (const sec of (DATA.boardRecommendations || [])) {
    const cls = sec.title.startsWith('✅') ? 'core' : (sec.title.startsWith('🔄') ? 'aux' : (sec.title.startsWith('⚠') ? 'warn' : 'bad'));
    html.push('<div class="summary-card ' + cls + '">' +
      '<h3>' + sec.title + '</h3>' +
      '<div style="color:#94a3b8;font-size:11px;line-height:1.6;margin-bottom:6px;">' + sec.note + '</div>');
    if (!sec.items || sec.items.length === 0) {
      html.push('<div class="item"><span class="cell-neutral">— 해당 조건 없음 —</span></div>');
    } else {
      for (const it of sec.items) {
        const dWRtxt = it.dWR != null ? (it.dWR > 0 ? '+' : '') + it.dWR : '-';
        const dEtxt  = it.dE  != null ? (it.dE  > 0 ? '+' : '') + it.dE  : '-';
        html.push('<div class="item">' +
          '<strong>' + it.label + '</strong> ' +
          '<span class="stat">[' + (it.hyp || '') + ']</span><br>' +
          '<span class="stat">사례 ' + (it.n || 0) + '건 · 수익 비율 ' + (it.winRate || 0) + '% (개선 ' + dWRtxt + ')</span> · ' +
          '<span class="stat">평균 결과 ' + (it.avgClose5 != null ? (it.avgClose5 > 0 ? '+' : '') + it.avgClose5 : '-') + '% (개선 ' + dEtxt + ')</span>' +
        '</div>');
      }
    }
    html.push('</div>');
  }
  document.getElementById('summary-cards').innerHTML = html.join('');
  // 보드 반영 추천 섹션도 같은 카드
  document.getElementById('board-reco').innerHTML = html.join('');
}
renderSummaryCards();

document.getElementById('data-limit').innerHTML =
  '<strong>이 보고서가 다룬 것</strong><br>' +
  '• 가정: H돌파일 종가에 사서, D+5 종가까지 단순 보유 (손절/익절 없음)<br>' +
  '• 모든 조건은 매수 시점 또는 D+1~D+5 장중에 실시간으로 확인 가능 (미래 정보 사용 X)<br>' +
  '• <strong>매수 추천이 아닙니다.</strong> 과거 검증을 통한 가설 평가입니다.<br>' +
  '<br>' +
  '<strong>수급 데이터 한계</strong><br>' +
  '• 외국인/기관 순매수 금액 = cache/flow-history (foreignNetValue, instNetValue)<br>' +
  '• 개인 ≈ -(외국인 + 기관) 으로 근사 — 시장 합산 ≈ 0 가정 (기타외국인/기타법인 배제)<br>' +
  '• 당일 거래대금 = chart의 valueApprox (close × volume 근사)<br>' +
  '• 수급 비율(%) = 순매수 금액 / 거래대금 × 100<br>' +
  '• 프로그램 순매수 금액 데이터는 cache에 없어 해당 표 생략<br>' +
  '<br>' +
  '<strong>추천 여부 태그</strong><br>' +
  '• ⭐ 핵심 / 🟢 고신뢰 / 유효 = n≥50 + 수익 비율과 평균 결과 동시 개선<br>' +
  '• 🔄 손바뀜 수급 = 개인 매도 + 외인/기관 매수 결합으로 평균 결과 개선<br>' +
  '• ⚠ 개인 과열 주의 = 개인 순매수가 강할수록 평균 결과 악화<br>' +
  '• ❌ 제외 후보 = 베이스 대비 평균 -1%p 이상 악화';
</script>

</body>
</html>
`;

main();
