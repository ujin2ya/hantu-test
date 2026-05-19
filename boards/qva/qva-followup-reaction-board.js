// QVA 후속 반응 감시 보드.
// QVA(QVA1/QVA2)가 발생한 종목이 D+1~D+5 사이에 보이는 "움직이기 시작한 조짐"을 모은다.
// 1DS 본체/QVA 본체/VVI 본체/라우터/cron 일체 무수정 — 신호 lookup + chart 읽기만.
// 매수 신호 아님. 후속 반응 감시 보고서.
//
// 산출물:
//   reports/qva-followup-reaction-board-result.json
//   reports/qva-followup-reaction-board-result.html

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const OUT_JSON = path.join(ROOT, 'reports', 'qva-followup-reaction-board-result.json');
const OUT_HTML = path.join(ROOT, 'reports', 'qva-followup-reaction-board-result.html');

const LOOKBACK_DAYS = 20;        // QVA 발생일 lookback (거래일)
const REACTION_MAX_D = 5;        // 후속 반응 검사 윈도우: D+1 ~ D+5
const HVM_CODE = '295310';       // 추적 사례 (에이치브이엠)

// ── 메타 로드 ──
function loadMetaMap() {
  const map = new Map();
  if (!fs.existsSync(NAVER_LIST_PATH)) return map;
  try {
    const j = JSON.parse(fs.readFileSync(NAVER_LIST_PATH, 'utf-8'));
    for (const s of (j.stocks || [])) {
      if (!s.code) continue;
      map.set(s.code, { name: s.name, market: s.market, marketCap: s.marketValue || 0 });
    }
  } catch (_) {}
  return map;
}

function loadChart(code) {
  const p = path.join(CHART_DIR, `${code}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}

function ymdDash(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return s.slice(0, 10);
}
function dashToYmd(s) { return s ? String(s).replace(/-/g, '').slice(0, 8) : null; }

// ── DB lookup ──
async function loadQvaCandidatesFromDB() {
  const { query } = require('../../src/db/mysql');
  // QVA1 (QVA_WATCHLIST.QVA_NEW) + QVA2 (QVA2_WATCHLIST.QVA2_NEW) — 최근 30 calendar days
  const qvaSeed = await query(`
    SELECT board_name, signal_kind, signal_date, stock_code
    FROM board_signals
    WHERE signal_date >= DATE_SUB(CURDATE(), INTERVAL 45 DAY)
      AND (
        (board_name = 'QVA_WATCHLIST'  AND signal_kind = 'QVA_NEW')
        OR (board_name = 'QVA2_WATCHLIST' AND signal_kind = 'QVA2_NEW')
      )
    ORDER BY signal_date DESC
  `);
  // VVI 발화 신호 (후속 반응 판정용)
  const vviSignals = await query(`
    SELECT board_name, signal_kind, signal_date, stock_code
    FROM board_signals
    WHERE signal_date >= DATE_SUB(CURDATE(), INTERVAL 45 DAY)
      AND (
        (board_name = 'QVA_WATCHLIST'      AND signal_kind = 'VVI_FIRED')
        OR (board_name = 'QVA_VVI_REDEFINED' AND signal_kind IN ('VVI_FIRED','TODAY_NEW_VVI'))
        OR (board_name = 'QVA2_WATCHLIST'    AND signal_kind = 'VVI2_FIRED')
        OR (board_name = 'QVA2_VVI'          AND signal_kind IN ('VVI2_FIRED','TODAY_NEW_VVI2'))
      )
    ORDER BY signal_date DESC
  `);
  return { qvaSeed, vviSignals };
}

// ── 차트 인덱스 헬퍼 ──
function findRowIdxByYmd(rows, ymd) {
  if (!rows || !ymd) return -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === ymd) return i;
  }
  return -1;
}

// ── 20일 평균 거래대금/거래량 ──
function calcAvg20(rows, baseIdx) {
  let sumV = 0, sumQ = 0, n = 0;
  for (let i = baseIdx - 20; i < baseIdx; i++) {
    const r = rows[i];
    if (r && r.volume > 0) {
      sumV += (r.valueApprox || 0);
      sumQ += (r.volume || 0);
      n++;
    }
  }
  return { avg20Value: n > 0 ? sumV / n : 0, avg20Volume: n > 0 ? sumQ / n : 0, n };
}

// ── 후속 반응 1일 분석 ──
function analyzeReactionDay(rows, qvaIdx, dN) {
  const idx = qvaIdx + dN;
  if (idx <= qvaIdx || idx >= rows.length) return null;
  const r = rows[idx];
  const prev = rows[idx - 1];
  const qva = rows[qvaIdx];
  if (!r || !prev || !qva || !r.close || !prev.close || !qva.close) return null;
  if (!(r.volume > 0)) return null;

  const valueAmount = r.valueApprox || r.close * r.volume;
  const range = r.high - r.low;
  const closePosition = range > 0 ? (r.close - r.low) / range : 0.5;
  const upperTailRatio = range > 0 ? (r.high - r.close) / range : 0;
  const gapPct = prev.close > 0 ? (r.open / prev.close - 1) * 100 : null;
  const changeRate = (r.close / prev.close - 1) * 100;
  const openToClosePct = r.open > 0 ? (r.close / r.open - 1) * 100 : null;

  // 20일 평균 (reaction 시점 기준)
  const { avg20Value, avg20Volume } = calcAvg20(rows, idx);
  const valueRatio20 = avg20Value > 0 ? valueAmount / avg20Value : null;
  const volumeRatio20 = avg20Volume > 0 ? r.volume / avg20Volume : null;

  // QVA일 대비
  const qvaValue = qva.valueApprox || qva.close * qva.volume;
  const valueToQvaRatio = qvaValue > 0 ? valueAmount / qvaValue : null;
  const volumeToQvaRatio = qva.volume > 0 ? r.volume / qva.volume : null;
  const highToQvaHighPct = qva.high > 0 ? (r.high / qva.high - 1) * 100 : null;
  const closeToQvaHighPct = qva.high > 0 ? (r.close / qva.high - 1) * 100 : null;

  return {
    reactionDate: r.date,
    daysAfterQva: dN,
    open: r.open, high: r.high, low: r.low, close: r.close,
    prevClose: prev.close, volume: r.volume, valueAmount,
    gapPct: round(gapPct, 2),
    changeRate: round(changeRate, 2),
    openToClosePct: round(openToClosePct, 2),
    closePosition: round(closePosition, 3),
    upperTailRatio: round(upperTailRatio, 3),
    valueRatio20: round(valueRatio20, 2),
    volumeRatio20: round(volumeRatio20, 2),
    valueToQvaRatio: round(valueToQvaRatio, 2),
    volumeToQvaRatio: round(volumeToQvaRatio, 2),
    highToQvaHighPct: round(highToQvaHighPct, 2),
    closeToQvaHighPct: round(closeToQvaHighPct, 2),
  };
}

function round(v, d) {
  if (v == null || !Number.isFinite(v)) return null;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

// ── 후속 반응 태그 + 점수 ──
function evaluateReaction(rx) {
  const tags = {};
  const t = {};

  t.GAP_HOLD_REACTION =
    (rx.gapPct ?? -999) >= 5 &&
    (rx.closePosition ?? 0) >= 0.70 &&
    (rx.upperTailRatio ?? 1) <= 0.40 &&
    rx.close >= rx.open * 0.98;

  t.STRONG_GAP_HOLD =
    (rx.gapPct ?? -999) >= 8 &&
    (rx.changeRate ?? -999) >= 10 &&
    (rx.closePosition ?? 0) >= 0.80 &&
    (rx.upperTailRatio ?? 1) <= 0.30;

  t.LIMIT_UP_LIKE =
    (rx.changeRate ?? -999) >= 20 &&
    (rx.closePosition ?? 0) >= 0.80 &&
    (rx.upperTailRatio ?? 1) <= 0.25;

  t.VALUE_REACTIVATION =
    (rx.valueRatio20 ?? 0) >= 2 ||
    (rx.valueToQvaRatio ?? 0) >= 1;

  t.STRONG_VALUE_REACTIVATION =
    (rx.valueRatio20 ?? 0) >= 4 ||
    (rx.valueToQvaRatio ?? 0) >= 2;

  t.QVA_HIGH_APPROACH =
    rx.qvaHigh > 0 && rx.high >= rx.qvaHigh * 0.98;

  t.QVA_HIGH_BREAK =
    rx.qvaHigh > 0 && (rx.high >= rx.qvaHigh || rx.close >= rx.qvaHigh);

  t.STRONG_CLOSE =
    (rx.closePosition ?? 0) >= 0.75 &&
    (rx.upperTailRatio ?? 1) <= 0.35;

  // VVI_FIRED_AFTER_QVA는 호출자가 채워줌 (DB lookup 필요)
  t.VVI_FIRED_AFTER_QVA = !!rx.vviFiredAfterQva;

  // 점수
  let score = 0;
  if (t.STRONG_GAP_HOLD)        score += 20;
  else if (t.GAP_HOLD_REACTION) score += 12;
  if (t.LIMIT_UP_LIKE)          score += 25;
  if (t.STRONG_VALUE_REACTIVATION) score += 18;
  else if (t.VALUE_REACTIVATION)   score += 12;
  if (t.QVA_HIGH_BREAK)         score += 15;
  else if (t.QVA_HIGH_APPROACH) score += 10;
  if (t.STRONG_CLOSE)           score += 12;
  if (t.VVI_FIRED_AFTER_QVA)    score += 20;
  if (rx.qvaType === 'QVA2')    score += 5;
  if (rx.daysAfterQva >= 1 && rx.daysAfterQva <= 3) score += 5;

  // 감점
  let penalty = 0;
  if ((rx.upperTailRatio ?? 0) >= 0.60) penalty -= 15;
  if ((rx.closePosition ?? 1) < 0.40)   penalty -= 15;
  if ((rx.gapPct ?? 0) >= 15 && (rx.closePosition ?? 1) < 0.60) penalty -= 10;
  if ((rx.changeRate ?? 0) >= 25 && (rx.upperTailRatio ?? 0) >= 0.40) penalty -= 10;
  let overheat = false;
  if ((rx.qvaToReactionCloseReturnPct ?? 0) >= 40) { penalty -= 10; overheat = true; }

  const reactionScore = Math.max(0, Math.min(100, score + penalty));

  // 등급
  let grade;
  if (reactionScore >= 70)      grade = 'A_READY';
  else if (reactionScore >= 50) grade = 'B_WATCH';
  else if (reactionScore >= 35) grade = 'C_EARLY';
  else if (Object.values(t).some(Boolean)) grade = 'D_RISK';
  else                          grade = null;

  const gradeLabel = {
    A_READY: '강한 후속 반응',
    B_WATCH: '움직일 기세',
    C_EARLY: '초기 반응',
    D_RISK:  '참고/추격 주의',
  }[grade] || null;

  // 추가 태그
  const extraTags = [];
  if (t.LIMIT_UP_LIKE)        extraTags.push('LIMIT_UP_REACTION');
  if (t.STRONG_GAP_HOLD || t.GAP_HOLD_REACTION) extraTags.push('GAP_HOLD_REACTION');
  if (t.STRONG_VALUE_REACTIVATION || t.VALUE_REACTIVATION) extraTags.push('VALUE_REACTIVATION');
  if (t.QVA_HIGH_BREAK)       extraTags.push('QVA_HIGH_BREAK');
  if (t.VVI_FIRED_AFTER_QVA)  extraTags.push('VVI_AFTER_QVA');
  if (overheat)               extraTags.push('OVERHEAT_CAUTION');

  return { tags: t, reactionScore, scoreRaw: score, penalty, grade, gradeLabel, extraTags, overheat };
}

function buildHeadline(rx, ev) {
  const dN = `D+${rx.daysAfterQva}`;
  if (ev.tags.LIMIT_UP_LIKE && ev.overheat) {
    return `상한가 근접 반응이지만 QVA 이후 이미 많이 올라 추격 주의가 필요해요.`;
  }
  if (ev.tags.LIMIT_UP_LIKE) {
    return `QVA 이후 ${dN}에 상한가 근접 반응이 나왔고 종가가 고가권에 유지됐어요.`;
  }
  if (ev.tags.STRONG_GAP_HOLD && ev.tags.QVA_HIGH_BREAK) {
    return `${dN}에 큰 갭으로 출발해 종가가 고가권에 유지됐고 QVA 고가도 돌파했어요.`;
  }
  if (ev.tags.STRONG_GAP_HOLD) {
    return `${dN}에 큰 갭으로 출발해 종가가 고가권에 유지된 강한 후속 반응이에요.`;
  }
  if (ev.tags.GAP_HOLD_REACTION) {
    return `${dN}에 갭 상승이 나오고 종가가 고가권에 유지됐어요.`;
  }
  if (ev.tags.QVA_HIGH_BREAK && ev.tags.STRONG_VALUE_REACTIVATION) {
    return `거래대금이 QVA일보다 강하게 다시 커지며 QVA 고가를 돌파했어요.`;
  }
  if (ev.tags.QVA_HIGH_BREAK) {
    return `${dN}에 QVA 고가를 돌파했어요.`;
  }
  if (ev.tags.QVA_HIGH_APPROACH) {
    return `${dN}에 QVA 고가 근처까지 올라왔어요.`;
  }
  if (ev.tags.STRONG_VALUE_REACTIVATION) {
    return `거래대금이 QVA일 이후 다시 강하게 커지며 관심이 들어오는 모습이에요.`;
  }
  if (ev.tags.VALUE_REACTIVATION) {
    return `거래대금이 QVA일 이후 다시 커지고 있어요.`;
  }
  if (ev.tags.STRONG_CLOSE) {
    return `${dN}에 종가가 고가권에서 마감되며 흐름이 살아있어요.`;
  }
  return `${dN} 후속 반응 관찰 중.`;
}

// ── 메인 ──
async function main() {
  console.log('🔍 QVA 후속 반응 감시 보드 생성\n');

  const metaMap = loadMetaMap();
  const { qvaSeed, vviSignals } = await loadQvaCandidatesFromDB();
  console.log(`  DB seed: QVA_NEW + QVA2_NEW ${qvaSeed.length}건 / VVI 발화 ${vviSignals.length}건`);

  // 종목 → 가장 최근 QVA 발생일 (QVA1 우선? QVA2 우선? 명세상 가장 최근 1건)
  // 같은 종목에 QVA1과 QVA2가 모두 있다면 가장 최근 신호를 메인으로 잡되, qvaTypeAll에 모두 기록.
  const byCode = new Map();
  for (const row of qvaSeed) {
    const code = row.stock_code;
    const date = ymdDash(row.signal_date);
    const qvaType = row.board_name === 'QVA2_WATCHLIST' ? 'QVA2' : 'QVA1';
    const cur = byCode.get(code);
    if (!cur || date > cur.qvaDate) {
      byCode.set(code, {
        code, qvaDate: date, qvaType,
        qvaTypeAll: cur ? Array.from(new Set([...(cur.qvaTypeAll||[]), qvaType])) : [qvaType],
      });
    } else {
      cur.qvaTypeAll = Array.from(new Set([...(cur.qvaTypeAll||[]), qvaType]));
    }
  }
  console.log(`  종목 dedup: ${byCode.size}건 (가장 최근 QVA 기준)`);

  // VVI 발화 신호 (code별)
  const vviByCode = new Map();
  for (const row of vviSignals) {
    const arr = vviByCode.get(row.stock_code) || [];
    arr.push({ board: row.board_name, kind: row.signal_kind, date: ymdDash(row.signal_date) });
    vviByCode.set(row.stock_code, arr);
  }

  // 거래일 기준 lookback 컷오프 — 가장 최근 거래일 기준 LOOKBACK_DAYS
  // (chart에서 latest date를 구해 그 기준 거래일 N개 이전을 컷)
  const sampleChart = loadChart('005930') || loadChart([...byCode.keys()][0] || '');
  let cutoffYmd = null;
  if (sampleChart && Array.isArray(sampleChart.rows)) {
    const rows = sampleChart.rows;
    const latestIdx = rows.length - 1;
    const cutIdx = Math.max(0, latestIdx - LOOKBACK_DAYS);
    cutoffYmd = rows[cutIdx]?.date || null;
  }
  console.log(`  거래일 lookback 컷오프 (LOOKBACK_DAYS=${LOOKBACK_DAYS}): ${cutoffYmd}\n`);

  const candidates = [];
  let chartMissing = 0, qvaIdxMissing = 0, noReaction = 0;

  for (const [code, seed] of byCode) {
    const qvaYmd = dashToYmd(seed.qvaDate);
    if (cutoffYmd && qvaYmd < cutoffYmd) continue;  // lookback 밖 (오래된 QVA)

    const meta = metaMap.get(code) || {};
    const chart = loadChart(code);
    if (!chart || !Array.isArray(chart.rows)) { chartMissing++; continue; }
    const rows = chart.rows;
    const qvaIdx = findRowIdxByYmd(rows, qvaYmd);
    if (qvaIdx < 0) { qvaIdxMissing++; continue; }

    const qva = rows[qvaIdx];
    const qvaInfo = {
      qvaDate: seed.qvaDate,
      qvaType: seed.qvaType,
      qvaTypeAll: seed.qvaTypeAll,
      qvaOpen: qva.open, qvaHigh: qva.high, qvaLow: qva.low, qvaClose: qva.close,
      qvaVolume: qva.volume,
      qvaValue: qva.valueApprox || qva.close * qva.volume,
    };

    // D+1~D+5 각각 분석 후 최고 score 한 날 선택
    const dayResults = [];
    for (let dN = 1; dN <= REACTION_MAX_D; dN++) {
      const rx = analyzeReactionDay(rows, qvaIdx, dN);
      if (!rx) continue;
      // QVA 고가/이후 누적 수익률 부가 정보
      const qvaToReactionCloseReturnPct = qvaInfo.qvaClose > 0
        ? (rx.close / qvaInfo.qvaClose - 1) * 100 : null;
      // VVI 발화: QVA 이후 ~ 해당 reactionDate 사이에 발화한 VVI 신호가 있는지
      const vviArr = vviByCode.get(code) || [];
      const vviAfter = vviArr.find(v => v.date > seed.qvaDate && v.date <= ymdDash(rx.reactionDate));
      const enrichedRx = {
        ...rx,
        qvaHigh: qvaInfo.qvaHigh,
        qvaClose: qvaInfo.qvaClose,
        qvaValue: qvaInfo.qvaValue,
        qvaType: seed.qvaType,
        qvaToReactionCloseReturnPct: round(qvaToReactionCloseReturnPct, 2),
        vviFiredAfterQva: !!vviAfter,
        vviAfterDetail: vviAfter || null,
      };
      const ev = evaluateReaction(enrichedRx);
      dayResults.push({ ...enrichedRx, ...ev });
    }
    if (dayResults.length === 0) { noReaction++; continue; }

    // 가장 점수 높은 1일 선택 (동점이면 더 최근 D)
    dayResults.sort((a, b) => (b.reactionScore - a.reactionScore) || (b.daysAfterQva - a.daysAfterQva));
    const best = dayResults[0];
    if (!best.grade) continue;  // 어떤 태그도 없으면 후보 아님

    const card = {
      code,
      name: meta.name || chart.name || code,
      market: meta.market || chart.market || '',
      marketCap: meta.marketCap || 0,
      ...qvaInfo,
      daysFromQva: best.daysAfterQva,
      reaction: best,
      headline: buildHeadline(best, best),
    };
    candidates.push(card);
  }

  // 정렬: reactionScore 내림차순
  candidates.sort((a, b) => b.reaction.reactionScore - a.reaction.reactionScore);

  // 등급별 / 태그별 그룹화
  const grouped = {
    A_READY: [], B_WATCH: [], C_EARLY: [], D_RISK: [],
    LIMIT_UP_REACTION: [], GAP_HOLD_REACTION: [], VALUE_REACTIVATION: [],
    QVA_HIGH_BREAK: [], VVI_AFTER_QVA: [],
  };
  for (const c of candidates) {
    if (grouped[c.reaction.grade]) grouped[c.reaction.grade].push(c);
    for (const tag of c.reaction.extraTags) {
      if (grouped[tag]) grouped[tag].push(c);
    }
  }

  const summary = {
    qvaSeedCount: byCode.size,
    candidatesCount: candidates.length,
    A_READY: grouped.A_READY.length,
    B_WATCH: grouped.B_WATCH.length,
    C_EARLY: grouped.C_EARLY.length,
    D_RISK:  grouped.D_RISK.length,
    LIMIT_UP_REACTION: grouped.LIMIT_UP_REACTION.length,
    GAP_HOLD_REACTION: grouped.GAP_HOLD_REACTION.length,
    VALUE_REACTIVATION: grouped.VALUE_REACTIVATION.length,
    QVA_HIGH_BREAK:    grouped.QVA_HIGH_BREAK.length,
    VVI_AFTER_QVA:     grouped.VVI_AFTER_QVA.length,
    chartMissing, qvaIdxMissing, noReaction,
  };

  // 에이치브이엠 추적
  const hvm = candidates.find(c => c.code === HVM_CODE);
  const hvmCheck = { found: !!hvm, candidate: hvm || null };

  const out = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    reactionMaxD: REACTION_MAX_D,
    cutoffYmd,
    summary,
    candidates,
    grouped,
    hvmCheck,
    notes: [
      '이 보드는 매수 신호가 아니라 QVA 이후 후속 반응 감시용입니다.',
      '“오를 기세” 표현은 보조 표현이며 보장이 아닙니다.',
      '1DS는 단타 정책상 GAP_HOLD 유형을 보수적으로 제외하지만, 이 보드는 QVA 이후 후속 반응 관점에서 같은 유형을 따로 잡습니다.',
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), 'utf-8');
  fs.writeFileSync(OUT_HTML, renderHtml(out), 'utf-8');

  // ── 콘솔 출력 ──
  console.log('📋 결과 요약');
  console.log(`  전체 QVA 후보 (lookback ${LOOKBACK_DAYS}거래일):  ${summary.qvaSeedCount}건`);
  console.log(`  후속 반응 후보:                       ${summary.candidatesCount}건`);
  console.log(`  A_READY:                              ${summary.A_READY}건`);
  console.log(`  B_WATCH:                              ${summary.B_WATCH}건`);
  console.log(`  C_EARLY:                              ${summary.C_EARLY}건`);
  console.log(`  D_RISK:                               ${summary.D_RISK}건`);
  console.log(`  LIMIT_UP_REACTION:                    ${summary.LIMIT_UP_REACTION}건`);
  console.log(`  GAP_HOLD_REACTION:                    ${summary.GAP_HOLD_REACTION}건`);
  console.log(`  VVI_AFTER_QVA:                        ${summary.VVI_AFTER_QVA}건`);
  console.log(`  에이치브이엠(${HVM_CODE}) 포함:        ${hvmCheck.found ? '✅' : '❌'}`);
  if (hvm) {
    const r = hvm.reaction;
    console.log(`    qvaDate=${hvm.qvaDate} reactionDate=${r.reactionDate} D+${r.daysAfterQva}`);
    console.log(`    grade=${r.grade}(${r.gradeLabel}) score=${r.reactionScore} tags=${r.extraTags.join(',')}`);
    console.log(`    changeRate=${r.changeRate}% gapPct=${r.gapPct}% closePos=${r.closePosition} valueRatio20=${r.valueRatio20}`);
  }
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);

  try { const { closePool } = require('../../src/db/mysql'); await closePool(); } catch (_) {}
}

// ── HTML 렌더 ──
function safe(v) {
  if (v == null) return '-';
  return String(v).replace(/[<>&"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch]));
}
function fmtMoney(v) {
  if (!v || !Number.isFinite(v)) return '-';
  if (v >= 1e12) return (v / 1e12).toFixed(2) + '조';
  if (v >= 1e8)  return Math.round(v / 1e8) + '억';
  if (v >= 1e4)  return Math.round(v / 1e4) + '만';
  return String(v);
}
function gradeBadge(g) {
  const cls = g === 'A_READY' ? 'a' : g === 'B_WATCH' ? 'b' : g === 'C_EARLY' ? 'c' : 'd';
  const lbl = { A_READY:'강한 후속 반응', B_WATCH:'움직일 기세', C_EARLY:'초기 반응', D_RISK:'참고/추격 주의' }[g] || g;
  return `<span class="grade ${cls}">${lbl}</span>`;
}

function renderCard(c) {
  const r = c.reaction;
  const tagsHtml = (r.extraTags || []).map(t => `<span class="tag">${safe(t)}</span>`).join(' ');
  const qvaHighRel = r.closeToQvaHighPct != null
    ? (r.closeToQvaHighPct >= 0 ? `+${r.closeToQvaHighPct}%` : `${r.closeToQvaHighPct}%`)
    : '-';
  return `
  <div class="card">
    <div class="card-head">
      <div class="name">${safe(c.name)} <span class="code">${safe(c.code)}</span></div>
      <div class="meta">QVA ${safe(c.qvaDate)} (${safe(c.qvaType)}) → 반응 ${safe(ymdDash(r.reactionDate))} <span class="dN">D+${safe(r.daysAfterQva)}</span></div>
    </div>
    <div class="card-row">
      ${gradeBadge(r.grade)}
      <span class="score">score ${safe(r.reactionScore)}</span>
      ${tagsHtml}
    </div>
    <div class="card-grid">
      <div><span class="lbl">gap</span> ${safe(r.gapPct)}%</div>
      <div><span class="lbl">change</span> ${safe(r.changeRate)}%</div>
      <div><span class="lbl">closePos</span> ${safe(r.closePosition)}</div>
      <div><span class="lbl">v/avg20</span> ${safe(r.valueRatio20)}×</div>
      <div><span class="lbl">v/qva</span> ${safe(r.valueToQvaRatio)}×</div>
      <div><span class="lbl">QVA高 대비</span> ${qvaHighRel}</div>
      <div><span class="lbl">VVI</span> ${r.vviFiredAfterQva ? '✅' : '–'}</div>
      <div><span class="lbl">시총</span> ${fmtMoney(c.marketCap)}</div>
    </div>
    <div class="headline">${safe(c.headline)}</div>
  </div>`;
}

function renderHtml(data) {
  const cards = (arr, max) => (arr || []).slice(0, max).map(renderCard).join('\n');
  const s = data.summary;

  const hvmBlock = (() => {
    if (!data.hvmCheck.found) {
      return `<p>에이치브이엠(${HVM_CODE})은 이 보드에 잡히지 않았어요. 원인을 확인해야 합니다.</p>`;
    }
    const c = data.hvmCheck.candidate;
    const r = c.reaction;
    return `
      <div class="hvm-wrap">
        ${renderCard(c)}
        <div class="hvm-note">
          <h4>왜 1DS에서는 제외됐고 이 보드에서는 잡혔는지</h4>
          <ul>
            <li>1DS는 단타 정책상 "갭상승 후 종가 고가권 유지(GAP_HOLD)" 유형을 보수적으로 제외합니다. 백테스트에서 fail 확률이 높은 유형이라 의도된 제외.</li>
            <li>이 보드는 단타 진입이 아니라 <b>QVA 이후 후속 반응</b>을 잡는 게 목적이라서, 같은 GAP_HOLD가 오히려 <b>강한 후속 반응 신호</b>로 평가됩니다.</li>
            <li>에이치브이엠은 QVA 발생일(${safe(c.qvaDate)}) 이후 D+${safe(r.daysAfterQva)}에 gapPct ${safe(r.gapPct)}%, changeRate ${safe(r.changeRate)}%, closePosition ${safe(r.closePosition)}, valueRatio20 ${safe(r.valueRatio20)}×의 강한 후속 반응을 보였고 이 보드의 ${gradeBadge(r.grade)} 등급으로 잡힙니다.</li>
          </ul>
        </div>
      </div>`;
  })();

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>QVA 후속 반응 감시 보드</title>
<style>
  body { font-family:'Segoe UI','Malgun Gothic',Arial,sans-serif; background:#f6f8fa; color:#1f2328; margin:0; padding:24px; }
  h1 { margin:0 0 4px; font-size:24px; }
  h2 { margin:24px 0 8px; font-size:18px; border-bottom:2px solid #d0d7de; padding-bottom:4px; }
  .meta { color:#57606a; font-size:13px; margin-bottom:24px; }
  .summary { background:#fff; border:1px solid #d0d7de; border-radius:8px; padding:16px; display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  .summary .item { background:#f6f8fa; padding:10px; border-radius:6px; }
  .summary .lbl { color:#57606a; font-size:12px; }
  .summary .val { font-size:18px; font-weight:700; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:12px; }
  .card { background:#fff; border:1px solid #d0d7de; border-radius:8px; padding:12px; }
  .card-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px; }
  .card-head .name { font-size:15px; font-weight:700; }
  .card-head .code { font-size:11px; color:#57606a; }
  .card-head .meta { font-size:11px; color:#57606a; margin-bottom:0; }
  .dN { color:#0969da; font-weight:600; }
  .card-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:8px; }
  .grade { padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; }
  .grade.a { background:#d6f5d6; color:#0a6900; }
  .grade.b { background:#cce6ff; color:#0a4480; }
  .grade.c { background:#fff5cc; color:#7a5a00; }
  .grade.d { background:#f0e0e0; color:#7a3030; }
  .score { font-size:12px; color:#57606a; }
  .tag { background:#eef2f5; color:#0a4480; font-size:10px; padding:1px 6px; border-radius:8px; }
  .card-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; font-size:11px; margin:6px 0; }
  .card-grid .lbl { color:#57606a; }
  .headline { font-size:12px; color:#1f2328; background:#f0f3f6; padding:8px; border-radius:6px; line-height:1.4; }
  details { margin-top:12px; }
  summary { cursor:pointer; padding:6px 0; font-weight:600; }
  .notes { background:#fff3cd; border:1px solid #f0c14b; border-radius:8px; padding:12px; margin-top:16px; font-size:13px; }
  .hvm-wrap { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .hvm-note { background:#fff; border:1px solid #d0d7de; border-radius:8px; padding:12px; font-size:13px; }
  .hvm-note h4 { margin-top:0; }
</style>
</head>
<body>
<h1>QVA 후속 반응 감시 보드</h1>
<div class="meta">생성 ${safe(data.generatedAt)} · lookback ${safe(data.lookbackDays)}거래일 · 컷오프 ${safe(data.cutoffYmd)}</div>

<h2>섹션 1 — 요약</h2>
<div class="summary">
  <div class="item"><div class="lbl">전체 QVA 후보 (lookback)</div><div class="val">${s.qvaSeedCount}</div></div>
  <div class="item"><div class="lbl">후속 반응 후보</div><div class="val">${s.candidatesCount}</div></div>
  <div class="item"><div class="lbl">A_READY (강한 후속 반응)</div><div class="val">${s.A_READY}</div></div>
  <div class="item"><div class="lbl">B_WATCH (움직일 기세)</div><div class="val">${s.B_WATCH}</div></div>
  <div class="item"><div class="lbl">LIMIT_UP_REACTION</div><div class="val">${s.LIMIT_UP_REACTION}</div></div>
  <div class="item"><div class="lbl">GAP_HOLD_REACTION</div><div class="val">${s.GAP_HOLD_REACTION}</div></div>
  <div class="item"><div class="lbl">VVI_AFTER_QVA</div><div class="val">${s.VVI_AFTER_QVA}</div></div>
  <div class="item"><div class="lbl">QVA_HIGH_BREAK</div><div class="val">${s.QVA_HIGH_BREAK}</div></div>
</div>

<h2>섹션 2 — 강한 후속 반응 (A_READY · 최대 20)</h2>
<div class="cards">${cards(data.grouped.A_READY, 20) || '<div>해당 없음</div>'}</div>

<h2>섹션 3 — 움직일 기세 (B_WATCH · 최대 30)</h2>
<div class="cards">${cards(data.grouped.B_WATCH, 30) || '<div>해당 없음</div>'}</div>

<h2>섹션 4 — 반응 유형별 보기</h2>
<details><summary>갭상승 유지형 (GAP_HOLD_REACTION · ${data.grouped.GAP_HOLD_REACTION.length}건)</summary>
  <div class="cards">${cards(data.grouped.GAP_HOLD_REACTION, 30)}</div>
</details>
<details><summary>거래대금 재증가형 (VALUE_REACTIVATION · ${data.grouped.VALUE_REACTIVATION.length}건)</summary>
  <div class="cards">${cards(data.grouped.VALUE_REACTIVATION, 30)}</div>
</details>
<details><summary>QVA 고가 접근/돌파형 (QVA_HIGH_BREAK · ${data.grouped.QVA_HIGH_BREAK.length}건)</summary>
  <div class="cards">${cards(data.grouped.QVA_HIGH_BREAK, 30)}</div>
</details>
<details><summary>상한가 근처형 (LIMIT_UP_REACTION · ${data.grouped.LIMIT_UP_REACTION.length}건)</summary>
  <div class="cards">${cards(data.grouped.LIMIT_UP_REACTION, 30)}</div>
</details>
<details><summary>VVI 발화형 (VVI_AFTER_QVA · ${data.grouped.VVI_AFTER_QVA.length}건)</summary>
  <div class="cards">${cards(data.grouped.VVI_AFTER_QVA, 30)}</div>
</details>

<h2>섹션 5 — 에이치브이엠 추적 사례</h2>
${hvmBlock}

<h2>섹션 6 — 전체 후보</h2>
<details><summary>전체 ${data.candidates.length}건 펼치기</summary>
  <div class="cards">${cards(data.candidates, 9999)}</div>
</details>

<div class="notes">
  ${data.notes.map(n => '<div>· ' + safe(n) + '</div>').join('')}
</div>
</body>
</html>`;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
