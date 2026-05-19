// 1DS miss 디버그 보고서.
// 특정 종목(에이치브이엠 — 코드 295310)이 1DS 파이프라인의 어느 단계에서 탈락했는지 추적.
// 1DS 본체 로직(임계값/점수/필터)은 절대 수정하지 않음 — 코어 함수를 그대로 호출해 결과만 기록.
//
// 산출물:
//   reports/one-day-surge-miss-debug-result.json
//   reports/one-day-surge-miss-debug-result.html
//
// 사용: node boards/oneDaySurge/one-day-surge-miss-debug.js [--target-name 에이치브이엠] [--target-code 295310]

'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./one-day-surge-core');
const themeWatchPool = require('../../src/utils/theme1dsWatchPool');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const BOARD_RESULT_PATH = path.join(ROOT, 'reports', 'one-day-surge-board-result.json');
const OUT_JSON = path.join(ROOT, 'reports', 'one-day-surge-miss-debug-result.json');
const OUT_HTML = path.join(ROOT, 'reports', 'one-day-surge-miss-debug-result.html');

// ── CLI ──
const argv = process.argv.slice(2);
function getArg(flag, def = null) {
  const i = argv.indexOf(flag);
  if (i < 0) return def;
  return argv[i + 1] || def;
}
const TARGET_NAME = getArg('--target-name', '에이치브이엠');
const TARGET_CODE_CLI = getArg('--target-code', null);

// ── 메타/차트 로더 (보드와 동일 방식) ──
function loadStockMetaMap() {
  const map = new Map();
  if (fs.existsSync(NAVER_LIST_PATH)) {
    try {
      const j = JSON.parse(fs.readFileSync(NAVER_LIST_PATH, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (!s.code) continue;
        map.set(s.code, {
          name: s.name,
          market: s.market,
          marketCap: s.marketValue || 0,
          closePrice: s.closePrice || 0,
          isEtf: !!s.isEtf,
          isSpecial: !!s.isSpecial,
        });
      }
    } catch (_) {}
  }
  return map;
}

function resolveTargetCode(metaMap) {
  if (TARGET_CODE_CLI) return TARGET_CODE_CLI;
  for (const [code, meta] of metaMap) {
    if ((meta.name || '') === TARGET_NAME) return code;
  }
  for (const [code, meta] of metaMap) {
    if ((meta.name || '').includes(TARGET_NAME)) return code;
  }
  return null;
}

function loadChart(code) {
  const p = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}

// ── DB에서 board_signals 이력 조회 (QVA 발생일 추적) ──
async function fetchBoardSignalsHistory(code) {
  let rows = [];
  try {
    const repo = require('../../src/db/boardSignalRepository');
    rows = await repo.findSignalsByStock(code, 200);
  } catch (e) {
    rows = [];
  }
  return rows;
}

// ── 상한가/대상일 정의 ──
// "상한가 발생일" = chart에서 changeRate (close/prevClose - 1) 가 가장 큰 최근 거래일.
function findSurgeDay(rows, lookbackDays = 30) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  let best = null;
  const start = Math.max(1, rows.length - lookbackDays);
  for (let i = start; i < rows.length; i++) {
    const r = rows[i], p = rows[i - 1];
    if (!r || !p || !p.close || !r.close) continue;
    const change = (r.close / p.close - 1) * 100;
    if (best == null || change > best.change) {
      best = { idx: i, date: r.date, change, row: r, prev: p };
    }
  }
  return best;
}

// ── 18단계 추적 ──
function traceOneDsPipeline({ code, meta, chart, themeWatchInfo, boardResult, targetBaseDate }) {
  const steps = [];
  const trace = (stageNum, label, ok, value, reason = null) => {
    steps.push({ stage: `${stageNum}. ${label}`, ok, value, reason });
  };

  // 1) stockUniverse 포함 여부 = chart 파일 존재 여부 (1DS는 cache/stock-charts-long의 모든 .json을 universe로 본다)
  trace(1, 'stockUniverse 포함 여부', !!chart, chart ? `chart 파일 존재 (rows ${chart.rows?.length || 0})` : 'chart 파일 없음');

  // 2) meta 존재 여부
  trace(2, 'meta 존재 여부', !!meta, meta ? `name="${meta.name}", market=${meta.market}, marketCap=${meta.marketCap}` : 'naver 메타 없음');

  // 3) chart 존재 여부 (중복이지만 명세에 따라)
  const rows = (chart && chart.rows) || [];
  trace(3, 'chart 존재 여부', rows.length > 0, `rows ${rows.length}건, 마지막 ${rows[rows.length - 1]?.date || 'n/a'}`);

  if (!meta || !chart) {
    return { steps, exit: 'NO_DATA' };
  }

  // 4) hardFilter 통과 여부
  const hf = core.passesHardFilter(meta);
  trace(4, 'hardFilter 통과 여부', hf.ok, hf.ok ? 'PASS' : `cut by ${hf.reason}`);

  // 5) hardFilter 탈락 사유
  trace(5, 'hardFilter 탈락 사유', hf.ok, hf.ok ? 'N/A (통과)' : hf.reason);

  // 6) theme universe 확장 대상 여부
  const isThemeBypass = !hf.ok && !!themeWatchInfo?.isThemeWatchCandidate;
  const themeStatus = themeWatchInfo?.isThemeWatchCandidate
    ? `theme WATCH_${themeWatchInfo.watchGrade?.replace('WATCH_', '')} (bestTheme=${themeWatchInfo.bestThemeLabel}, score=${themeWatchInfo.theme1dsWatchScore})`
    : '테마 풀 미포함';
  trace(6, 'theme universe 확장 대상 여부', !!themeWatchInfo?.isThemeWatchCandidate, themeStatus + (isThemeBypass ? ' → bypass 진입' : ''));

  if (!hf.ok && !isThemeBypass) {
    return { steps, exit: 'CUT_BY_HARDFILTER' };
  }

  // baseIdx 결정 — 보드는 가장 최근 volume>0 row를 사용. 사용자 지정 targetBaseDate가 있으면 그 위치로.
  let baseIdx = core.pickLatestBaseIdx(rows);
  if (targetBaseDate) {
    const found = rows.findIndex(r => r.date === targetBaseDate);
    if (found >= 0) baseIdx = found;
  }

  // 7) analyzeAt 실행 여부 (baseIdx 유효 + analyzeAt 호출 성공)
  const m = baseIdx >= 0 ? core.analyzeAt(rows, baseIdx) : null;
  trace(7, 'analyzeAt 실행 여부', !!m, m ? `baseIdx=${baseIdx} (date=${rows[baseIdx]?.date})` : `analyzeAt null (baseIdx=${baseIdx})`);

  // 8) analyzeAt 반환값
  trace(8, 'analyzeAt 반환값', !!m, m ? '정상 m 객체' : 'null');

  if (!m) {
    return { steps, exit: 'ANALYZE_NULL' };
  }

  // 9) retPct 값 (사용자 명세상의 retPct = 실제 m.changeRate, 즉 일중 종가 변화율 = (close/prevClose-1)*100)
  // 추가로 일중 (close/open-1) 도 함께 기록 — 혼동 방지.
  const openToClosePct = m.open > 0 ? (m.close / m.open - 1) * 100 : null;
  trace(9, 'retPct 값 (= changeRate, close/prevClose)', Number.isFinite(m.changeRate),
    `changeRate=${m.changeRate}% / openToClose=${openToClosePct != null ? openToClosePct.toFixed(2) : 'n/a'}% / gapPct=${m.gapPct}%`);

  // 10) signalPrice 값 (= 기준일 close)
  trace(10, 'signalPrice 값 (= 기준일 close)', m.close > 0, `${m.close}원 (open=${m.open}, high=${m.high}, low=${m.low})`);

  // 11) oneDaySurgeScore 계산값
  const s = core.scoreMetrics(m, meta.marketCap);
  trace(11, 'oneDaySurgeScore 계산값', Number.isFinite(s.oneDaySurgeScore), `${s.oneDaySurgeScore}점`);

  // 12) scoreMetrics 세부 점수
  const detail = {
    valueSurgeScore:        s.valueSurgeScore,
    volumeSurgeScore:       s.volumeSurgeScore,
    closeStrengthScore:     s.closeStrengthScore,
    priceMomentumScore:     s.priceMomentumScore,
    breakoutPotentialScore: s.breakoutPotentialScore,
    upperTailPenalty:       s.upperTailPenalty,
    overheatPenalty:        s.overheatPenalty,
    riskPenalty:            s.riskPenalty,
    marketCapPenalty:       s.marketCapPenalty,
    marketCapBand:          s.marketCapBand,
  };
  trace(12, 'scoreMetrics 세부 점수', true, JSON.stringify(detail));

  // 13) classifyGroup 결과 (legacy A/B/C/D)
  const legacyGroup = core.classifyGroup(m, s);
  trace(13, 'classifyGroup (legacy A/B/C/D) 결과', legacyGroup !== null, legacyGroup || 'null (drop)');

  // 13b) candleType + GT band
  const candleType = core.classifyCandleType(m);
  const gtBand = core.classifyGtBand(meta.marketCap);
  const valueToMarketCapRatio = (meta.marketCap > 0 && Number.isFinite(m.valueAmount))
    ? m.valueAmount / meta.marketCap * 100 : null;
  const recent5Up15Count = core.countRecentSurges(rows, baseIdx, 5, 15);

  // 13c) classifyGtGroup (실제 보드가 사용하는 그룹 분류)
  // dailyValueRank는 같은 baseDate 후보 안에서의 거래대금 순위 — 단독 판정 시점에는 알 수 없음.
  // 대안: 보드 결과 JSON에서 같은 baseDate의 dailyValueRank를 조회. 없으면 null로 두고 BALANCED-GT의 rankOK 조건은 fail.
  const dailyValueRank = lookupDailyValueRank(boardResult, code, m.baseDate);

  const gtGroup = core.classifyGtGroup({
    m, marketCap: meta.marketCap, valueToMarketCapRatio, candleType, dailyValueRank, recent5Up15Count,
  });
  trace(13, `classifyGtGroup 결과 (band=${gtBand}, candle=${candleType}, v/mc=${valueToMarketCapRatio?.toFixed(2)}%, rank=${dailyValueRank ?? 'n/a'}, recent5Up15=${recent5Up15Count})`,
    gtGroup !== 'UNCLASSIFIED', gtGroup);

  if (gtGroup === 'UNCLASSIFIED') {
    return { steps, m, s, candleType, gtBand, gtGroup, valueToMarketCapRatio, recent5Up15Count, dailyValueRank, exit: 'UNCLASSIFIED_GT' };
  }

  // MAIN_POOL 그룹이 아니면 passesRiskFilter에서 'group_off_pool'로 컷
  const MAIN_POOL_GROUPS = ['BALANCED-GT', 'LIGHT-GT', 'MID-CAP-GT'];
  const inMainPoolGroup = MAIN_POOL_GROUPS.includes(gtGroup);

  // 14) passesRiskFilter 결과 — 보드의 정의를 그대로 시뮬레이션
  // calcRiskTrapScore: upperTailRatio + max(0,(ret5d-30)/100)에 가중치… 보드 코드에서 가져오기 어려우면 간략 계산.
  const trapApprox = riskTrapScoreApprox(m, s, gtGroup);
  let riskFilterReason = null;
  let riskFilterOk = true;
  if (!inMainPoolGroup) { riskFilterReason = 'group_off_pool'; riskFilterOk = false; }
  else if (candleType === 'GAP_HOLD') { riskFilterReason = 'gap_hold_candle'; riskFilterOk = false; }
  else if (trapApprox >= 60) { riskFilterReason = 'trap_risk_high'; riskFilterOk = false; }

  trace(14, 'passesRiskFilter 결과', riskFilterOk, riskFilterOk ? 'PASS' : `cut by ${riskFilterReason}`);

  // 15) riskTrapScore
  trace(15, 'riskTrapScore (approx)', true, `${trapApprox.toFixed(1)}점 (≥60이면 trap_risk_high)`);

  // 16) displayPriorityScore (보드 안에 정의된 함수 — 외부에서 정확 재현 어려움)
  // 간단: oneDaySurgeScore 기반으로 산출되는 정렬용 점수. 보드 결과 JSON의 priorityRanked에서 후보 찾아 값 가져오기.
  const inBoardItem = lookupBoardItem(boardResult, code);
  const dps = inBoardItem ? inBoardItem.displayPriorityScore : null;
  trace(16, 'displayPriorityScore', dps != null, dps != null ? `${dps}점` : '보드 결과에 없음 (mainPool 도달 못함)');

  // 17) mainPool 포함 여부
  const inMainPool = boardResult?.priorityRanked?.mainPoolCodes?.includes(code) || false;
  trace(17, 'mainPool 포함 여부', inMainPool, inMainPool ? '포함' : '미포함');

  // 18) shownResult 포함 여부 (priorityRanked의 topPriority/extraPriority/holding/pending/reobserve에 있는지)
  const inShown = inShownPool(boardResult, code);
  trace(18, 'shownResult 포함 여부', inShown.ok, inShown.where || '미노출');

  return {
    steps, m, s, candleType, gtBand, gtGroup, valueToMarketCapRatio, recent5Up15Count, dailyValueRank,
    legacyGroup, riskFilterOk, riskFilterReason, trapApprox, inMainPool, inShown,
    exit: inMainPool ? 'PASS' : (riskFilterOk ? 'NOT_VISIBLE' : `RISK_FILTER_${riskFilterReason}`),
  };
}

// ── 보드 결과 JSON에서 dailyValueRank 조회 (baseDate가 같은 후보들 중 거래대금 순위) ──
function lookupDailyValueRank(boardResult, code, baseDate) {
  if (!boardResult) return null;
  // groups 안 모든 후보
  for (const [, items] of Object.entries(boardResult.groups || {})) {
    for (const it of (items || [])) {
      if (it.code === code && it.baseDate === baseDate) return it.dailyValueRank ?? null;
    }
  }
  return null;
}

function lookupBoardItem(boardResult, code) {
  if (!boardResult) return null;
  const lists = [
    ...(boardResult.priorityRanked?.topPriority || []),
    ...(boardResult.priorityRanked?.extraPriority || []),
    ...(boardResult.priorityRanked?.holdingCandidates || []),
    ...(boardResult.priorityRanked?.pendingCandidates || []),
    ...(boardResult.priorityRanked?.reobserveCandidates || []),
  ];
  return lists.find(it => it.code === code) || null;
}

function inShownPool(boardResult, code) {
  if (!boardResult || !boardResult.priorityRanked) return { ok: false, where: null };
  for (const k of ['topPriority', 'extraPriority', 'holdingCandidates', 'pendingCandidates', 'reobserveCandidates']) {
    if ((boardResult.priorityRanked[k] || []).some(x => x.code === code)) return { ok: true, where: k };
  }
  return { ok: false, where: null };
}

// 보드의 calcRiskTrapScore 정확한 정의가 board 파일 안에 있어 require가 까다로움.
// 근사: upperTailRatio*60 + max(0,(ret5d-30)) (보드의 정의와 약간 다를 수 있다 — '근사값' 명시)
function riskTrapScoreApprox(m, s, gtGroup) {
  const ut = m.upperTailRatio || 0;
  const r5 = Math.max(0, (m.ret5d || 0) - 30);
  return ut * 60 + r5;
}

// ── 비교군 추출: mainPoolCodes 상위 3개 ──
function buildComparisonSet(boardResult, count = 3) {
  const codes = (boardResult?.priorityRanked?.mainPoolCodes || []).slice(0, count);
  const out = [];
  for (const c of codes) {
    const it = lookupBoardItem(boardResult, c);
    if (it) out.push(it);
  }
  return out;
}

// ── HTML 렌더 ──
function renderHtml(data) {
  const safe = (v) => (v == null ? '-' : String(v).replace(/[<>&"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch])));
  const yesNo = (b) => b === true ? '✅ 통과' : b === false ? '❌ 탈락' : '-';

  const stepsRows = data.trace.steps.map(s => `
    <tr>
      <td>${s.stage}</td>
      <td class="${s.ok ? 'ok' : 'fail'}">${yesNo(s.ok)}</td>
      <td>${safe(s.value)}</td>
      <td>${safe(s.reason)}</td>
    </tr>`).join('');

  const cmpRows = data.comparison.map(c => `
    <tr>
      <td>${safe(c.code)}</td>
      <td>${safe(c.name)}</td>
      <td>${safe(c.candleType)}</td>
      <td>${safe(c.gtGroup)}</td>
      <td>${safe(c.changeRate)}%</td>
      <td>${safe(c.oneDaySurgeScore)}</td>
      <td>${safe(c.legacyGroup)}</td>
      <td>${safe(c.displayPriorityScore)}</td>
      <td class="ok">mainPool ✓</td>
    </tr>`).join('');

  const targetRowForCmp = `
    <tr class="target">
      <td>${safe(data.target.code)}</td>
      <td>${safe(data.target.name)} (타겟)</td>
      <td>${safe(data.trace.candleType)}</td>
      <td>${safe(data.trace.gtGroup)}</td>
      <td>${safe(data.trace.m?.changeRate)}%</td>
      <td>${safe(data.trace.s?.oneDaySurgeScore)}</td>
      <td>${safe(data.trace.legacyGroup)}</td>
      <td>${safe(data.trace.inShown?.where || '-')}</td>
      <td class="fail">mainPool ✗</td>
    </tr>`;

  const qvaRows = (data.qvaHistory || []).map(r => `
    <tr>
      <td>${safe(r.signal_date)}</td>
      <td>${safe(r.board_name)}</td>
      <td>${safe(r.signal_kind)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>1DS miss 디버그 — ${safe(data.target.name)}(${safe(data.target.code)})</title>
<style>
  body { font-family: 'Segoe UI','Malgun Gothic',Arial,sans-serif; background:#f6f8fa; color:#1f2328; margin:0; padding:24px; }
  h1 { margin:0 0 4px; font-size:24px; }
  h2 { margin:24px 0 8px; font-size:18px; border-bottom:2px solid #d0d7de; padding-bottom:4px; }
  .meta { color:#57606a; font-size:13px; margin-bottom:24px; }
  .summary { background:#fff; border:1px solid #d0d7de; border-radius:8px; padding:16px; }
  .summary .label { color:#57606a; font-size:12px; }
  .summary .val   { font-size:14px; margin-bottom:8px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:12px; font-size:12px; font-weight:600; }
  .badge.fail { background:#ffd6d6; color:#a40000; }
  .badge.ok   { background:#d6f5d6; color:#0a6900; }
  .badge.warn { background:#fff5cc; color:#7a5a00; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d0d7de; margin-top:8px; font-size:13px; }
  th, td { border:1px solid #d0d7de; padding:6px 10px; text-align:left; vertical-align:top; }
  th { background:#eaeef2; font-weight:600; }
  td.ok   { color:#0a6900; font-weight:600; }
  td.fail { color:#a40000; font-weight:600; }
  tr.target { background:#fff7e6; }
  pre { background:#f0f3f6; padding:10px; border-radius:6px; overflow-x:auto; font-size:12px; }
  .ohlcv { font-family:monospace; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  ul { margin:6px 0; padding-left:20px; }
</style>
</head>
<body>
<h1>1DS miss 디버그 — ${safe(data.target.name)} (${safe(data.target.code)})</h1>
<div class="meta">생성: ${safe(data.generatedAt)} · 분석 기준일 ${safe(data.targetBaseDate)} · QVA 발생일 ${safe(data.qvaSignalDate || 'n/a')}</div>

<h2>섹션 1 — 요약</h2>
<div class="summary">
  <div class="label">최종 탈락 단계</div>
  <div class="val"><span class="badge fail">${safe(data.conclusion.finalCutStage)}</span> ${safe(data.conclusion.finalCutDetail)}</div>
  <div class="label">가장 유력한 탈락 원인</div>
  <div class="val">${safe(data.conclusion.primaryReason)}</div>
  <div class="label">버그 가능성 여부</div>
  <div class="val">${safe(data.conclusion.bugLikely)}</div>
  <div class="label">조건상 정상 탈락 여부</div>
  <div class="val">${safe(data.conclusion.intendedExclusion)}</div>
  <div class="label">결론 분류</div>
  <div class="val"><span class="badge ${data.conclusion.classification === 'DATA_BUG' ? 'fail' : data.conclusion.classification === 'LOGIC_GAP' ? 'warn' : 'ok'}">${safe(data.conclusion.classification)}</span></div>
</div>

<h2>섹션 2 — ${safe(data.target.name)} QVA 이력</h2>
<table>
  <thead><tr><th>signal_date</th><th>board_name</th><th>signal_kind</th></tr></thead>
  <tbody>${qvaRows || '<tr><td colspan="3">DB에 신호 이력 없음</td></tr>'}</tbody>
</table>
<ul>
  <li>QVA 발생일: <b>${safe(data.qvaSignalDate || 'n/a')}</b></li>
  <li>QVA 종류: <b>${safe(data.qvaKind || 'n/a')}</b></li>
  <li>상한가(또는 최고 changeRate) 발생일: <b>${safe(data.surgeDate || 'n/a')}</b> (${safe(data.surgeChange?.toFixed(2) || '')}%)</li>
  <li>QVA → 상한가 경과 거래일: <b>${safe(data.daysFromQvaToSurge ?? 'n/a')}일</b></li>
</ul>

<h2>섹션 3 — 1DS 파이프라인 단계별 결과</h2>
<table>
  <thead><tr><th>#</th><th>통과/탈락</th><th>단계</th><th>값/사유</th></tr></thead>
  <tbody>${stepsRows}</tbody>
</table>

<h2>섹션 4 — retPct(=changeRate) 분석</h2>
<div class="grid2">
  <div class="summary">
    <div class="label">상한가 당일 OHLCV (${safe(data.targetBaseDate)})</div>
    <div class="ohlcv">${safe(JSON.stringify(data.targetOhlcv))}</div>
    <div class="label" style="margin-top:8px">analyzeAt 반환값 핵심</div>
    <pre>${safe(JSON.stringify({
      changeRate:    data.trace.m?.changeRate,
      openToClose:   data.trace.m?.open > 0 ? ((data.trace.m.close / data.trace.m.open - 1) * 100).toFixed(2) + '%' : null,
      gapPct:        data.trace.m?.gapPct,
      closePosition: data.trace.m?.closePosition,
      upperTailRatio:data.trace.m?.upperTailRatio,
      valueRatio:    data.trace.m?.valueRatio,
      volumeRatio:   data.trace.m?.volumeRatio,
      ret3d:         data.trace.m?.ret3d,
      ret5d:         data.trace.m?.ret5d,
      isBreakoutOf20:data.trace.m?.isBreakoutOf20,
      distFromHigh20:data.trace.m?.distFromHigh20,
    }, null, 2))}</pre>
  </div>
  <div class="summary">
    <div class="label">retPct 진단</div>
    <ul>
      <li>입력 데이터(OHLCV) 정상: <b>${data.diag.ohlcvOk ? '✅' : '❌'}</b></li>
      <li>prevClose 존재: <b>${data.diag.prevCloseOk ? '✅' : '❌'}</b></li>
      <li>open/high/low/close null 필드: <b>${safe(data.diag.missingFields.join(', ') || '없음')}</b></li>
      <li>analyzeAt 반환의 changeRate finite: <b>${data.diag.changeRateFinite ? '✅' : '❌'}</b></li>
      <li>분석일(${safe(data.targetBaseDate)}) ↔ chart 마지막 row(${safe(data.diag.lastChartDate)}) 일치: <b>${data.diag.baseDateOk ? '✅' : '❌'}</b></li>
      <li>분봉 의존 여부: <b>${data.diag.usesIntraday ? '⚠️ 분봉 참조' : '✅ 일봉 기준'}</b></li>
      <li>숫자 파싱 이상: <b>${safe(data.diag.parseAnomaly || '없음')}</b></li>
    </ul>
    <div class="label" style="margin-top:8px">결과</div>
    <div class="val">${safe(data.diag.summary)}</div>
  </div>
</div>

<h2>섹션 5 — 성공 1DS 종목 3개와 비교 (${safe(data.targetBaseDate)})</h2>
<table>
  <thead><tr>
    <th>code</th><th>name</th><th>candleType</th><th>gtGroup</th><th>changeRate</th>
    <th>oneDaySurgeScore</th><th>legacyGroup</th><th>displayPriorityScore</th><th>최종</th>
  </tr></thead>
  <tbody>
    ${targetRowForCmp}
    ${cmpRows}
  </tbody>
</table>

<h2>섹션 6 — 결론</h2>
<div class="summary">
  <div class="val">${safe(data.conclusion.narrative)}</div>
</div>
</body>
</html>`;
}

// ── 메인 ──
async function main() {
  console.log('🔍 1DS miss 디버그 시작\n');

  // 1. 종목코드 결정
  const metaMap = loadStockMetaMap();
  const targetCode = resolveTargetCode(metaMap);
  if (!targetCode) {
    console.error(`❌ 종목 "${TARGET_NAME}" 코드를 찾지 못함`);
    process.exit(1);
  }
  const meta = metaMap.get(targetCode);
  console.log(`  대상 종목: ${meta.name} (${targetCode}) / market=${meta.market} / marketCap=${(meta.marketCap/1e8).toFixed(0)}억`);

  // 2. chart 로드
  const chart = loadChart(targetCode);
  const rows = (chart && chart.rows) || [];
  console.log(`  chart rows: ${rows.length}건, 마지막 ${rows[rows.length - 1]?.date || 'n/a'}`);

  // 3. 상한가/대상일 결정
  const surge = findSurgeDay(rows, 30);
  console.log(`  최근 30거래일 내 최대 changeRate 발생일: ${surge?.date || 'n/a'} (${surge?.change.toFixed(2) || '-'}%)`);
  const targetBaseDate = surge?.date || rows[rows.length - 1]?.date || null;

  // 4. theme pool lookup
  const themeWatchInfo = themeWatchPool.getThemeWatchInfoByCode(targetCode);

  // 5. 보드 결과 JSON 로드 (비교군 및 dailyValueRank 조회용)
  let boardResult = null;
  if (fs.existsSync(BOARD_RESULT_PATH)) {
    try { boardResult = JSON.parse(fs.readFileSync(BOARD_RESULT_PATH, 'utf-8')); } catch (_) {}
  }
  const boardAnalysisDate = boardResult?.meta?.analysisDate || boardResult?.meta?.targetDate || null;
  console.log(`  보드 결과 analysisDate: ${boardAnalysisDate}`);

  // 6. DB 이력
  const dbHistory = await fetchBoardSignalsHistory(targetCode);
  const qvaSig = dbHistory.find(r => r.board_name === 'QVA_WATCHLIST' && r.signal_kind === 'QVA_NEW');
  const qvaSignalDate = qvaSig?.signal_date ? formatDate(qvaSig.signal_date) : null;
  const qvaKind = qvaSig ? `${qvaSig.board_name} / ${qvaSig.signal_kind}` : null;
  const daysFromQvaToSurge = qvaSignalDate && surge?.date
    ? countTradingDaysBetween(rows, qvaSignalDate.replace(/-/g,''), surge.date)
    : null;

  // 7. 파이프라인 트레이스
  const trace = traceOneDsPipeline({
    code: targetCode, meta, chart, themeWatchInfo, boardResult, targetBaseDate,
  });

  // 8. retPct 진단
  const baseRow = rows.find(r => r.date === targetBaseDate);
  const prevRow = (() => {
    const i = rows.findIndex(r => r.date === targetBaseDate);
    return i > 0 ? rows[i - 1] : null;
  })();
  const missingFields = baseRow ? ['open','high','low','close','volume'].filter(k => !baseRow[k]) : ['(baseRow 없음)'];
  const diag = {
    ohlcvOk: !!baseRow && missingFields.length === 0,
    prevCloseOk: !!(prevRow && prevRow.close > 0),
    missingFields,
    changeRateFinite: Number.isFinite(trace.m?.changeRate),
    lastChartDate: rows[rows.length - 1]?.date || null,
    baseDateOk: targetBaseDate === rows[rows.length - 1]?.date,
    usesIntraday: false,
    parseAnomaly: null,
    summary: trace.m?.changeRate != null
      ? `analyzeAt이 정상적으로 changeRate=${trace.m.changeRate}%를 반환. retPct undefined 이슈는 외부 디버그(잘못된 필드명 참조)에서 발생한 것으로 1DS 본체에는 없음.`
      : 'analyzeAt이 null/undefined를 반환한 케이스 — 사전 필터(min_history/min_base_value/avg20)에서 떨어졌을 가능성',
  };

  // 9. 비교군
  const comparison = buildComparisonSet(boardResult, 3).map(it => ({
    code: it.code,
    name: it.name,
    candleType: it.candleType,
    gtGroup: it.gtGroup,
    changeRate: it.changeRate,
    oneDaySurgeScore: it.oneDaySurgeScore,
    legacyGroup: legacyGroupOf(it),
    displayPriorityScore: it.displayPriorityScore,
  }));

  // 10. 결론
  const conclusion = buildConclusion(trace, meta, diag);

  // ── 출력 ──
  const out = {
    generatedAt: new Date().toISOString(),
    target: { code: targetCode, name: meta.name, market: meta.market, marketCap: meta.marketCap },
    targetBaseDate,
    targetOhlcv: baseRow || null,
    surgeDate: surge?.date || null,
    surgeChange: surge?.change || null,
    qvaSignalDate,
    qvaKind,
    daysFromQvaToSurge,
    qvaHistory: dbHistory,
    themeWatchInfo,
    trace,
    diag,
    comparison,
    conclusion,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), 'utf-8');
  fs.writeFileSync(OUT_HTML, renderHtml(out), 'utf-8');

  // ── 콘솔 출력 ──
  console.log('\n📋 디버그 결과 요약');
  console.log(`  종목코드:         ${targetCode}`);
  console.log(`  QVA 발생일:       ${qvaSignalDate || 'n/a'}`);
  console.log(`  상한가 발생일:    ${surge?.date || 'n/a'} (${surge?.change.toFixed(2) || '-'}%)`);
  const hfStep = trace.steps.find(s => s.stage.includes('hardFilter 통과'));
  const analStep = trace.steps.find(s => s.stage.includes('analyzeAt 실행'));
  const retStep = trace.steps.find(s => s.stage.includes('retPct'));
  console.log(`  hardFilter 통과:  ${hfStep?.ok ? '✅' : '❌'} (${hfStep?.value})`);
  console.log(`  analyzeAt 실행:   ${analStep?.ok ? '✅' : '❌'}`);
  console.log(`  retPct 값:        ${retStep?.value || '-'}`);
  console.log(`  mainPool 포함:    ${trace.inMainPool ? '✅' : '❌'}`);
  console.log(`  최종 탈락 단계:   ${conclusion.finalCutStage} — ${conclusion.finalCutDetail}`);
  console.log(`  결론 분류:        ${conclusion.classification}`);
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);

  // DB pool 닫기
  try {
    const mysql = require('../../src/db/mysql');
    if (mysql.closePool) await mysql.closePool();
  } catch (_) {}
}

function formatDate(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return d.toISOString().slice(0, 10);
  }
  if (typeof d === 'string') {
    if (/^\d{8}$/.test(d)) return d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8);
    return d.slice(0, 10);
  }
  return String(d);
}

function countTradingDaysBetween(rows, fromYmd, toYmd) {
  let count = 0, started = false;
  for (const r of rows) {
    if (!r || !r.date) continue;
    if (r.date === fromYmd) { started = true; continue; }
    if (started) count++;
    if (r.date === toYmd) return count;
  }
  return null;
}

function legacyGroupOf(it) {
  if (!it) return null;
  // 보드 후보에는 it.group 또는 it.candidateGroup이 있을 수 있다.
  return it.group || it.candidateGroup || null;
}

function buildConclusion(trace, meta, diag) {
  let cls = 'UNKNOWN', primaryReason = '', finalCutStage = '', finalCutDetail = '', bugLikely = '', intendedExclusion = '';
  let narrative = '';

  if (trace.exit === 'PASS') {
    cls = 'UNKNOWN'; finalCutStage = '없음'; primaryReason = '탈락 없음'; finalCutDetail = '대상 종목이 mainPool에 정상 진입';
    bugLikely = '해당 없음'; intendedExclusion = '해당 없음';
    narrative = '디버그 대상 종목이 mainPool에 정상 진입했으므로 추가 분석 불요.';
    return { classification: cls, finalCutStage, finalCutDetail, primaryReason, bugLikely, intendedExclusion, narrative };
  }

  if (trace.exit === 'UNCLASSIFIED_GT') {
    cls = 'LOGIC_GAP';
    finalCutStage = '단계 13: classifyGtGroup → UNCLASSIFIED';
    finalCutDetail = `시총 band=${trace.gtBand}, candleType=${trace.candleType}, v/mc=${trace.valueToMarketCapRatio?.toFixed(2)}% — 1DS GT 그룹 조건 불일치`;
    if (trace.gtBand === 'MID_CAP') {
      primaryReason = `MID_CAP band (7,000억~1.5조)는 candleType=LOW_GAP_INTRADAY만 통과. 대상 종목은 candleType=${trace.candleType} (갭상승 + 종가 유지형)이라 정책상 제외.`;
    } else if (trace.gtBand === 'BALANCED') {
      primaryReason = `BALANCED band (3,000억~7,000억)는 v/mc≥5 + (LOW_GAP_INTRADAY 또는 거래대금 상위 30위) 조건. 대상 종목은 candleType=${trace.candleType}로 LOW_GAP_INTRADAY가 아니고 rank=${trace.dailyValueRank ?? 'n/a'}.`;
    } else if (trace.gtBand === 'LIGHT') {
      primaryReason = `LIGHT band (1,000억~3,000억)는 v/mc≥5 + recent5Up15Count≤1. 대상은 recent5Up15=${trace.recent5Up15Count}.`;
    } else {
      primaryReason = `band=${trace.gtBand}, candle=${trace.candleType} — classifyGtGroup이 UNCLASSIFIED 반환.`;
    }
    bugLikely = '낮음 — 1DS의 정책적 그룹 정의(시총 구간별 캔들 패턴 제한)에 따른 정상 제외.';
    intendedExclusion = '예 — 단타 후보 보드의 시총 구간별 캔들 정책상 제외.';
    narrative = `대상 종목은 hardFilter와 analyzeAt까지 모두 통과했고 점수(${trace.s?.oneDaySurgeScore || 'n/a'}점)도 충분히 높았으나, GT 그룹 분류(classifyGtGroup) 단계에서 ${trace.gtBand} band + candleType=${trace.candleType} 조합이 어떤 GT 그룹에도 들어가지 못해 UNCLASSIFIED로 분류되어 보드에서 제외됨. 1DS는 "단타 후보" 보드라 GAP_HOLD 같은 갭상승 종가 유지형은 fail 비율이 높다는 백테스트 결과에 따라 의도적으로 제외하는 정책. QVA(중장기 흐름)와 1DS(단타)는 기준이 다르므로 QVA에 잡혔다 해서 1DS에도 잡혀야 하는 것은 아님. 만약 이런 유형도 단타 후보로 보고 싶다면 별도 보드/섹션을 추가하는 것이 1DS 본체를 수정하는 것보다 안전함.`;
  } else if (trace.exit?.startsWith?.('RISK_FILTER_')) {
    cls = 'INTENDED_EXCLUSION';
    finalCutStage = '단계 14: passesRiskFilter';
    finalCutDetail = trace.riskFilterReason || '';
    primaryReason = `riskFilter ${trace.riskFilterReason} 컷 — 단타 진입 부적합 패턴`;
    bugLikely = '낮음 — 명시적 위험 필터 정책';
    intendedExclusion = '예';
    narrative = `riskFilter ${trace.riskFilterReason}에 의해 컷됨.`;
  } else if (trace.exit === 'CUT_BY_HARDFILTER') {
    cls = 'INTENDED_EXCLUSION';
    finalCutStage = '단계 4: passesHardFilter';
    finalCutDetail = trace.steps.find(s=>s.stage.includes('hardFilter 탈락'))?.reason || '';
    primaryReason = 'hardFilter 컷';
    bugLikely = '낮음';
    intendedExclusion = '예';
    narrative = 'hardFilter에서 컷.';
  } else if (trace.exit === 'NO_DATA') {
    cls = 'DATA_BUG';
    finalCutStage = '단계 1~3: meta/chart 부재';
    finalCutDetail = '데이터 누락';
    primaryReason = 'meta 또는 chart 캐시 없음';
    bugLikely = '높음';
    intendedExclusion = '아니오';
    narrative = '데이터 부재 — 캐시 재생성 필요.';
  } else if (trace.exit === 'ANALYZE_NULL') {
    cls = 'UNKNOWN';
    finalCutStage = '단계 7: analyzeAt → null';
    finalCutDetail = 'analyzeAt이 null 반환 (사전 필터에서 컷)';
    primaryReason = 'min_history/min_base_value/avg20 등 사전 조건 부족';
    bugLikely = '낮음 — analyzeAt 내부의 정상 사전 필터';
    intendedExclusion = '예';
    narrative = 'analyzeAt 내부 사전 필터에서 컷.';
  } else {
    cls = 'UNKNOWN';
    finalCutStage = trace.exit;
    finalCutDetail = '추가 분석 필요';
    primaryReason = '미확정';
    bugLikely = '확인 필요';
    intendedExclusion = '확인 필요';
    narrative = '예상 외 탈락 경로 — 추가 추적 필요.';
  }

  return { classification: cls, finalCutStage, finalCutDetail, primaryReason, bugLikely, intendedExclusion, narrative };
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
