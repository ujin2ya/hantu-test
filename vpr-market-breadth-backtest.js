#!/usr/bin/env node
/**
 * VPR 시장 레짐 비교 — KOSPI 단독 vs marketBreadthScore (체감 시장 레짐)
 *
 * 목적:
 *   KOSPI 단독 필터(KOSPI 200일선 등)는 삼성전자/SK하이닉스 같은 초대형주 영향이 커서
 *   중소형 개별주 위주의 H그룹/VPR 후보군에는 왜곡될 수 있다.
 *
 *   대안으로 KOSDAQ 흐름 + 시장 breadth(상승종목 비율) + 쏠림 패널티 + H그룹 후보군
 *   최근 흐름을 종합한 "체감 시장 레짐 점수(marketBreadthScore, 100점 만점)"를 만들고
 *   기존 단순 필터와 성과를 비교한다.
 *
 *   모든 필터는 매수 시점(D+5)에 알 수 있는 정보만 사용 (look-ahead 없음).
 *
 * 입력:
 *   reports/vpr-hgroup-three-year-with-flow-backtest-result.json
 *   cache/stock-charts-long/{code}.json (전체 — 시장 breadth 계산용)
 *   cache/kospi-daily.json, cache/kosdaq-daily.json
 *
 * 출력:
 *   reports/vpr-market-breadth-backtest-result.json
 *   reports/vpr-market-breadth-backtest-result.html
 *
 * 라우트: /vpr-market-breadth
 */

const fs = require('fs');
const path = require('path');
const vprAnalyzer = require('./vpr-analyzer');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INPUT_PATH = path.join(REPORTS_DIR, 'vpr-hgroup-three-year-with-flow-backtest-result.json');
const KOSPI_PATH = path.join(ROOT, 'cache', 'kospi-daily.json');
const KOSDAQ_PATH = path.join(ROOT, 'cache', 'kosdaq-daily.json');
const OUT_JSON = path.join(REPORTS_DIR, 'vpr-market-breadth-backtest-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'vpr-market-breadth-backtest-result.html');

const args = (() => {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
})();
const ENTRY_DAY = parseInt(args['entry-day'] || '5', 10);
const ENTRY_PRICE_KIND = (args['entry-price'] || 'open').toLowerCase();
const HOLD_DAYS = parseInt(args['hold-days'] || '10', 10);

// ─── 헬퍼 ───
function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}
function mean(arr) {
  const v = arr.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}
function rate(num, denom) { if (!denom) return null; return round(num / denom * 100, 2); }

// ─── 분할 청산 시뮬레이션 (기존과 동일) ───
const SPLIT_TIERS = [
  { pct: 6, weight: 0.5 }, { pct: 12, weight: 0.3 }, { pct: 16, weight: 0.2 },
];
const SL_PCT = -5;

function simulateSplit(rows, buyIdx, buyPrice, entryKind = 'open') {
  let remaining = 1.0, realized = 0;
  let stopPrice = buyPrice * (1 + SL_PCT / 100);
  let nextTier = 0;
  let mfe = 0, mae = 0;
  if (entryKind === 'open' && rows[buyIdx]) {
    const r = rows[buyIdx];
    mfe = Math.max(mfe, (r.high / buyPrice - 1) * 100);
    mae = Math.min(mae, (r.low / buyPrice - 1) * 100);
    if (r.low <= stopPrice) {
      realized += remaining * (stopPrice / buyPrice - 1) * 100;
      remaining = 0;
    } else {
      while (nextTier < SPLIT_TIERS.length) {
        const t = SPLIT_TIERS[nextTier];
        const tp = buyPrice * (1 + t.pct / 100);
        if (r.high >= tp) {
          realized += t.weight * t.pct;
          remaining -= t.weight;
          nextTier++;
          if (nextTier === 1) stopPrice = buyPrice;
          else stopPrice = buyPrice * (1 + SPLIT_TIERS[nextTier - 2].pct / 100);
        } else break;
      }
    }
  }
  for (let k = 1; k <= HOLD_DAYS; k++) {
    if (remaining <= 0) break;
    const idx = buyIdx + k;
    if (idx >= rows.length) break;
    const r = rows[idx];
    mfe = Math.max(mfe, (r.high / buyPrice - 1) * 100);
    mae = Math.min(mae, (r.low / buyPrice - 1) * 100);
    if (r.open <= stopPrice) {
      realized += remaining * (r.open / buyPrice - 1) * 100;
      remaining = 0; break;
    }
    while (nextTier < SPLIT_TIERS.length) {
      const t = SPLIT_TIERS[nextTier];
      const tp = buyPrice * (1 + t.pct / 100);
      if (r.open >= tp) {
        realized += t.weight * t.pct;
        remaining -= t.weight;
        nextTier++;
        if (nextTier === 1) stopPrice = buyPrice;
        else stopPrice = buyPrice * (1 + SPLIT_TIERS[nextTier - 2].pct / 100);
      } else break;
    }
    if (remaining <= 0) break;
    if (r.low <= stopPrice) {
      realized += remaining * (stopPrice / buyPrice - 1) * 100;
      remaining = 0; break;
    }
    while (nextTier < SPLIT_TIERS.length) {
      const t = SPLIT_TIERS[nextTier];
      const tp = buyPrice * (1 + t.pct / 100);
      if (r.high >= tp) {
        realized += t.weight * t.pct;
        remaining -= t.weight;
        nextTier++;
        if (nextTier === 1) stopPrice = buyPrice;
        else stopPrice = buyPrice * (1 + SPLIT_TIERS[nextTier - 2].pct / 100);
      } else break;
    }
  }
  if (remaining > 0) {
    const idx = buyIdx + HOLD_DAYS;
    if (idx < rows.length) realized += remaining * (rows[idx].close / buyPrice - 1) * 100;
  }
  let exitType = 'TIME';
  if (nextTier === SPLIT_TIERS.length) exitType = 'TP';
  else if (remaining === 0 && nextTier === 0) exitType = 'SL';
  else if (remaining < 1 && remaining > 0) exitType = 'PARTIAL_TIME';
  return { returnPct: round(realized), exitType, mfe: round(mfe), mae: round(mae) };
}

// ─── 인덱스 로드 + MA 계산 + daily return ───
function loadIndex(p) {
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const rows = (j.rows || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const closes = rows.map(r => r.close);
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ma60 = i >= 59 ? closes.slice(i - 59, i + 1).reduce((s, v) => s + v, 0) / 60 : null;
    const ma200 = i >= 199 ? closes.slice(i - 199, i + 1).reduce((s, v) => s + v, 0) / 200 : null;
    const dailyReturn = i >= 1 && closes[i - 1] > 0 ? (r.close / closes[i - 1] - 1) * 100 : null;
    map.set(r.date, { close: r.close, ma60, ma200, dailyReturn });
  }
  return map;
}

// ─── 시장 breadth 계산 (전체 차트 캐시 → 일별 상승/하락 종목 수) ───
function computeMarketBreadth() {
  console.log(`  시장 breadth 계산 중...`);
  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  const breadth = new Map();  // date → { advancers, decliners, unchanged, total }
  let processed = 0;
  for (const file of files) {
    processed++;
    if (processed % 500 === 0) process.stdout.write(`    ${processed}/${files.length}\r`);
    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8')); }
    catch (_) { continue; }
    const rows = chart.rows || [];
    if (rows.length < 2) continue;
    for (let i = 1; i < rows.length; i++) {
      const today = rows[i], prev = rows[i - 1];
      if (!today?.close || !prev?.close) continue;
      const date = today.date;
      let b = breadth.get(date);
      if (!b) { b = { advancers: 0, decliners: 0, unchanged: 0, total: 0 }; breadth.set(date, b); }
      if (today.close > prev.close) b.advancers++;
      else if (today.close < prev.close) b.decliners++;
      else b.unchanged++;
      b.total++;
    }
  }
  process.stdout.write(`    ${processed}/${files.length}\n`);
  // Compute breadth ratio
  for (const [d, b] of breadth) {
    b.advanceRatio = b.total > 0 ? b.advancers / b.total : 0;
    b.advancersOverDecliners = b.advancers > b.decliners;
  }
  console.log(`  breadth 산출: ${breadth.size} 거래일`);
  return breadth;
}

// ─── H그룹 후보군 최근 흐름 (5일 윈도우) ───
// 해석: buy_date 기준 hDate가 [buy_date - 20, buy_date - 5] 범위에 있는 H그룹 이벤트들의
//       hPlus5.closeN(=H+5 종가 수익률) 평균. window 20일 사용 — 통계 안정성 확보.
function buildHgroupRollingMap(events, tradingDates) {
  const dateIdx = new Map();
  tradingDates.forEach((d, i) => dateIdx.set(d, i));
  const rolling = new Map();
  // hDate별 h+5 수익률 모음
  const eventsByDate = new Map();
  for (const e of events) {
    if (!e.hDate || e.hPlus5?.closeN == null) continue;
    if (!eventsByDate.has(e.hDate)) eventsByDate.set(e.hDate, []);
    eventsByDate.get(e.hDate).push(e.hPlus5.closeN);
  }
  // 각 cutoff일 기준 [cutoff-20, cutoff-5] 윈도우 내 hPlus5 평균
  for (const cutoffDate of tradingDates) {
    const ci = dateIdx.get(cutoffDate);
    if (ci == null) continue;
    const lo = Math.max(0, ci - 20);
    const hi = ci - 5;
    if (hi < lo) continue;
    const collected = [];
    for (let i = lo; i <= hi; i++) {
      const d = tradingDates[i];
      const arr = eventsByDate.get(d) || [];
      collected.push(...arr);
    }
    if (collected.length > 0) {
      rolling.set(cutoffDate, {
        hgroupAvgReturn: collected.reduce((s, v) => s + v, 0) / collected.length,
        sampleCount: collected.length,
      });
    }
  }
  return rolling;
}

// ─── marketBreadthScore 계산 (사용자 spec) ───
function computeMarketBreadthScore({ kospi, kosdaq, breadth, hgroup }) {
  let score = 0;
  const factors = [];

  // KOSDAQ 흐름 (각 +20)
  if (kosdaq && kosdaq.ma60 != null && kosdaq.close > kosdaq.ma60) {
    score += 20; factors.push('KOSDAQ > 60일선 (+20)');
  }
  if (kosdaq && kosdaq.ma200 != null && kosdaq.close > kosdaq.ma200) {
    score += 20; factors.push('KOSDAQ > 200일선 (+20)');
  }
  // 상승종목 비율 (>= 50%, +20)
  if (breadth && breadth.advanceRatio >= 0.5) {
    score += 20; factors.push(`상승비율 ${(breadth.advanceRatio * 100).toFixed(0)}% (+20)`);
  }
  // 상승종목 수 > 하락종목 수 (+15)
  if (breadth && breadth.advancersOverDecliners) {
    score += 15; factors.push('상승 > 하락 (+15)');
  }
  // H그룹 후보군 최근 평균 수익률 > 0 (+15)
  if (hgroup && hgroup.hgroupAvgReturn > 0) {
    score += 15; factors.push(`H그룹 최근 +${hgroup.hgroupAvgReturn.toFixed(2)}% (+15)`);
  }
  // KOSPI 흐름 (각 +5)
  if (kospi && kospi.ma60 != null && kospi.close > kospi.ma60) {
    score += 5; factors.push('KOSPI > 60일선 (+5)');
  }
  if (kospi && kospi.ma200 != null && kospi.close > kospi.ma200) {
    score += 5; factors.push('KOSPI > 200일선 (+5)');
  }

  // ─── 쏠림 패널티 ───
  // 1. KOSPI 상승률 ≥ +1% AND 상승종목 비율 < 45% → -20
  if (kospi && kospi.dailyReturn != null && kospi.dailyReturn >= 1.0 &&
      breadth && breadth.advanceRatio < 0.45) {
    score -= 20; factors.push('대형주 쏠림 (KP+1% & 상승비율<45%) (-20)');
  }
  // 2. KOSPI > 60일선 AND KOSDAQ < 60일선 → -15
  if (kospi && kospi.ma60 != null && kospi.close > kospi.ma60 &&
      kosdaq && kosdaq.ma60 != null && kosdaq.close < kosdaq.ma60) {
    score -= 15; factors.push('KOSPI 강 / KOSDAQ 약 디버전스 (-15)');
  }
  // 3. KOSPI 상승률 > KOSDAQ 상승률 + 1.5%p → -10
  if (kospi && kospi.dailyReturn != null && kosdaq && kosdaq.dailyReturn != null &&
      kospi.dailyReturn - kosdaq.dailyReturn > 1.5) {
    score -= 10; factors.push('KP 일간 ≫ KQ 일간 (-10)');
  }

  // 등급 분류
  let grade;
  if (score >= 75) grade = 'STRONG_INDIVIDUAL';      // 개별주 장세 양호
  else if (score >= 55) grade = 'NORMAL';            // 보통
  else if (score >= 35) grade = 'SELECTIVE';         // 선별 필요
  else grade = 'CAUTION';                            // 신규 진입 주의

  return { score: Math.max(0, score), grade, factors };
}
const GRADE_LABELS = {
  STRONG_INDIVIDUAL: '개별주 장세 양호',
  NORMAL: '보통',
  SELECTIVE: '선별 필요',
  CAUTION: '신규 진입 주의',
};

// ─── 통계 요약 ───
function summarize(results, baseStat) {
  if (results.length === 0) return { n: 0 };
  const valid = results.filter(r => r != null && Number.isFinite(r.returnPct));
  if (valid.length === 0) return { n: 0 };
  const returns = valid.map(r => r.returnPct);
  const wins = valid.filter(r => r.returnPct > 0);
  const losses = valid.filter(r => r.returnPct <= 0);
  const slExits = valid.filter(r => r.exitType === 'SL');
  const tpExits = valid.filter(r => r.exitType === 'TP');
  const winRate = wins.length / valid.length * 100;
  const avgWin = mean(wins.map(r => r.returnPct));
  const avgLoss = mean(losses.map(r => r.returnPct));
  const expectancy = winRate / 100 * (avgWin || 0) + (1 - winRate / 100) * (avgLoss || 0);
  const mfes = valid.map(r => r.mfe).filter(v => v != null);
  const maes = valid.map(r => r.mae).filter(v => v != null);
  const summary = {
    n: valid.length,
    winRate: round(winRate),
    avgReturn: round(mean(returns)),
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    expectancy: round(expectancy),
    slRate: rate(slExits.length, valid.length),
    tpRate: rate(tpExits.length, valid.length),
    avgMFE: round(mean(mfes)),
    avgMAE: round(mean(maes)),
  };
  if (baseStat) {
    summary.removed = baseStat.n - summary.n;
    summary.deltaWinRate = baseStat.winRate != null ? round(summary.winRate - baseStat.winRate) : null;
    summary.deltaExpectancy = baseStat.expectancy != null ? round(summary.expectancy - baseStat.expectancy) : null;
  }
  return summary;
}

// ─── 메인 ───
function main() {
  if (!fs.existsSync(INPUT_PATH)) { console.error('[ERROR] 입력 없음:', INPUT_PATH); process.exit(1); }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log(`\n📊 VPR 시장 레짐 비교 — KOSPI 단독 vs marketBreadthScore`);
  console.log(`  매수: D+${ENTRY_DAY} ${ENTRY_PRICE_KIND === 'open' ? '시가' : '종가'}, 보유: ${HOLD_DAYS}거래일`);

  const inputData = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const events = inputData.events || [];
  console.log(`  입력 이벤트: ${events.length}건`);

  const kospiMap = loadIndex(KOSPI_PATH);
  const kosdaqMap = loadIndex(KOSDAQ_PATH);
  console.log(`  KOSPI/KOSDAQ 일봉 로드 완료`);

  const breadthMap = computeMarketBreadth();
  const tradingDates = Array.from(breadthMap.keys()).sort();
  const hgroupRolling = buildHgroupRollingMap(events, tradingDates);
  console.log(`  H그룹 rolling 평균: ${hgroupRolling.size}일`);

  // ─── 각 이벤트 처리 ───
  const trades = [];
  let skipNoChart = 0, skipNoEntry = 0, skipNoVpr = 0;
  for (const e of events) {
    const chartPath = path.join(CHART_DIR, `${e.code}.json`);
    if (!fs.existsSync(chartPath)) { skipNoChart++; continue; }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8')); }
    catch (_) { skipNoChart++; continue; }
    const rows = chart.rows || [];
    const hIdx = rows.findIndex(r => r.date === e.hDate);
    const vviIdx = rows.findIndex(r => r.date === e.vviDate);
    if (hIdx < 0 || vviIdx < 0) { skipNoEntry++; continue; }
    const buyIdx = hIdx + ENTRY_DAY;
    if (buyIdx >= rows.length) { skipNoEntry++; continue; }
    const buyPrice = ENTRY_PRICE_KIND === 'open' ? rows[buyIdx].open : rows[buyIdx].close;
    if (!buyPrice || buyPrice <= 0 || buyIdx + 3 >= rows.length) { skipNoEntry++; continue; }

    const vpr = vprAnalyzer.analyzeBreakoutReaction({ vviIdx, breakoutIdx: hIdx }, rows);
    if (!vpr || !vpr.vprMain) { skipNoVpr++; continue; }

    const buyDate = rows[buyIdx].date;
    const entryDistancePct = (buyPrice / vpr.vprBaseClose - 1) * 100;
    const kospi = kospiMap?.get(buyDate) || null;
    const kosdaq = kosdaqMap?.get(buyDate) || null;
    const breadth = breadthMap.get(buyDate) || null;
    const hgroup = hgroupRolling.get(buyDate) || null;
    const breadthScore = computeMarketBreadthScore({ kospi, kosdaq, breadth, hgroup });
    const sim = simulateSplit(rows, buyIdx, buyPrice, ENTRY_PRICE_KIND);

    trades.push({
      code: e.code, name: e.name,
      hDate: e.hDate, buyDate, buyPrice,
      vprMain: vpr.vprMain, vprMainLabel: vpr.vprMainLabel, vprTags: vpr.vprTags,
      entryDistancePct: round(entryDistancePct),
      kospi, kosdaq, breadth, hgroup,
      breadthScore: breadthScore.score,
      breadthGrade: breadthScore.grade,
      breadthFactors: breadthScore.factors,
      sim,
    });
  }
  console.log(`  실효 trade: ${trades.length}건 (skip: chart ${skipNoChart}, entry ${skipNoEntry}, vpr ${skipNoVpr})`);

  // ─── 비교 조건 9종 (사용자 spec) ───
  const FILTERS = [
    { key: 'NONE', label: '필터 없음', match: () => true },
    { key: 'KP200', label: 'KOSPI 200일선 위', match: t => t.kospi && t.kospi.ma200 != null && t.kospi.close > t.kospi.ma200 },
    { key: 'KQ200', label: 'KOSDAQ 200일선 위', match: t => t.kosdaq && t.kosdaq.ma200 != null && t.kosdaq.close > t.kosdaq.ma200 },
    { key: 'KQ60', label: 'KOSDAQ 60일선 위', match: t => t.kosdaq && t.kosdaq.ma60 != null && t.kosdaq.close > t.kosdaq.ma60 },
    { key: 'BREADTH50', label: '상승종목 비율 ≥ 50%', match: t => t.breadth && t.breadth.advanceRatio >= 0.5 },
    { key: 'SCORE55', label: 'marketBreadthScore ≥ 55', match: t => t.breadthScore >= 55 },
    { key: 'SCORE75', label: 'marketBreadthScore ≥ 75', match: t => t.breadthScore >= 75 },
    { key: 'SCORE55_D10', label: 'Score ≥ 55 + 거리 ≤ 10%', match: t => t.breadthScore >= 55 && t.entryDistancePct <= 10 },
    { key: 'SCORE75_D10', label: 'Score ≥ 75 + 거리 ≤ 10%', match: t => t.breadthScore >= 75 && t.entryDistancePct <= 10 },
  ];

  // 베이스라인 (NONE)
  const baseStat = summarize(trades.map(t => t.sim));
  const summary = FILTERS.map(f => {
    const filtered = trades.filter(f.match);
    const stat = summarize(filtered.map(t => t.sim), baseStat);
    return { key: f.key, label: f.label, ...stat };
  });

  // ─── 등급별 분포 + 성과 ───
  const grades = ['STRONG_INDIVIDUAL', 'NORMAL', 'SELECTIVE', 'CAUTION'];
  const byGrade = grades.map(g => {
    const subset = trades.filter(t => t.breadthGrade === g);
    return { grade: g, label: GRADE_LABELS[g], ...summarize(subset.map(t => t.sim), baseStat) };
  });

  // ─── VPR 메인 태그별 + Score ≥ 55 적용 시 ───
  const VPR_MAIN_FILTERS = [
    { key: 'ALL', label: 'H그룹 전체', match: () => true },
    { key: 'M_HIGH', label: 'VPR: 고가권 유지', match: t => t.vprMain === 'HIGH_ZONE_HOLD' },
    { key: 'M_ABOVE_LINE', label: 'VPR: 기준선 위 마감', match: t => t.vprMain === 'ABOVE_BREAKOUT_LINE' },
    { key: 'M_ABOVE_BASE', label: 'VPR: 기준 종가 위 유지', match: t => t.vprMain === 'ABOVE_BASE_CLOSE' },
    { key: 'M_OVER', label: 'VPR: 과열 돌파', match: t => t.vprMain === 'OVERHEATED_BREAKOUT' },
  ];
  const vprByFilter = VPR_MAIN_FILTERS.map(vf => {
    const sub = trades.filter(vf.match);
    const baseV = summarize(sub.map(t => t.sim));
    return {
      ...vf,
      noFilter: baseV,
      score55: summarize(sub.filter(t => t.breadthScore >= 55).map(t => t.sim), baseV),
      score55_d10: summarize(sub.filter(t => t.breadthScore >= 55 && t.entryDistancePct <= 10).map(t => t.sim), baseV),
    };
  });

  // 점수 분포
  const scoreBuckets = { '0~34': 0, '35~54': 0, '55~74': 0, '75~100': 0 };
  for (const t of trades) {
    if (t.breadthScore < 35) scoreBuckets['0~34']++;
    else if (t.breadthScore < 55) scoreBuckets['35~54']++;
    else if (t.breadthScore < 75) scoreBuckets['55~74']++;
    else scoreBuckets['75~100']++;
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: 'VPR 시장 레짐 비교 — KOSPI 단독 vs marketBreadthScore',
      purpose: 'KOSPI 단독 필터는 대형주 영향이 크다. KOSDAQ + 시장 breadth + 쏠림 패널티 + H그룹 후보군 흐름을 종합한 marketBreadthScore가 H그룹/VPR 후보 매수 시 더 나은 필터인지 검증.',
      noFutureInfo: '모든 필터는 매수 시점(D+5)에 알 수 있는 정보만. 사후 정보 없음.',
      buySource: `D+${ENTRY_DAY} ${ENTRY_PRICE_KIND === 'open' ? '시가' : '종가'}`,
      holdPattern: `분할 청산 (50% +6 / 30% +12 / 20% +16, 손절 -5%, 본전 ratchet, 최대 ${HOLD_DAYS}일)`,
    },
    config: {
      entryDay: ENTRY_DAY, entryPriceKind: ENTRY_PRICE_KIND, holdDays: HOLD_DAYS,
      filters: FILTERS.map(f => ({ key: f.key, label: f.label })),
      grades: GRADE_LABELS,
      scoreFormula: {
        plus: [
          'KOSDAQ > 60일선: +20', 'KOSDAQ > 200일선: +20',
          '상승종목 비율 ≥ 50%: +20', '상승 > 하락: +15',
          'H그룹 최근 평균 > 0: +15',
          'KOSPI > 60일선: +5', 'KOSPI > 200일선: +5',
        ],
        minus: [
          'KOSPI +1%↑ & 상승비율<45%: -20',
          'KOSPI 강 & KOSDAQ 약 디버전스: -15',
          'KP 일간 ≫ KQ 일간 +1.5%p: -10',
        ],
      },
    },
    counts: {
      totalEvents: events.length,
      effectiveTrades: trades.length,
      skipNoChart, skipNoEntry, skipNoVpr,
    },
    baseline: baseStat,
    summary,
    byGrade,
    vprByFilter,
    scoreBuckets,
    trades: trades.map(t => ({
      code: t.code, name: t.name, hDate: t.hDate, buyDate: t.buyDate,
      vprMainLabel: t.vprMainLabel, entryDistancePct: t.entryDistancePct,
      breadthScore: t.breadthScore, breadthGrade: t.breadthGrade,
      breadthFactors: t.breadthFactors,
      kospiAbove200: t.kospi?.ma200 != null ? t.kospi.close > t.kospi.ma200 : null,
      kosdaqAbove60: t.kosdaq?.ma60 != null ? t.kosdaq.close > t.kosdaq.ma60 : null,
      advanceRatio: t.breadth ? round(t.breadth.advanceRatio * 100, 1) : null,
      hgroupAvg: t.hgroup ? round(t.hgroup.hgroupAvgReturn, 2) : null,
      returnPct: t.sim?.returnPct,
      exitType: t.sim?.exitType,
    })),
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // ─── 콘솔 요약 ───
  console.log(`\n📊 점수 분포:`);
  for (const [k, v] of Object.entries(scoreBuckets)) {
    console.log(`  ${k.padStart(7)}점: ${String(v).padStart(4)}건 (${rate(v, trades.length)}%)`);
  }

  console.log(`\n📊 필터 비교 (분할청산):`);
  console.log(`  필터                                   n   승률   매번 평균  손절률  ΔWR    ΔE`);
  for (const s of summary) {
    if (!s.n) continue;
    const ok = (s.deltaWinRate >= 0 && s.deltaExpectancy >= 0) ? '🟢' : (s.deltaExpectancy < -0.2 ? '🔴' : '⚪');
    const dwr = s.deltaWinRate != null ? (s.deltaWinRate >= 0 ? '+' : '') + s.deltaWinRate : '-';
    const de = s.deltaExpectancy != null ? (s.deltaExpectancy >= 0 ? '+' : '') + s.deltaExpectancy : '-';
    console.log(`  ${ok} ${s.label.padEnd(34)} ${String(s.n).padStart(4)}  ${String(s.winRate).padStart(5)}%  ${String(s.expectancy).padStart(7)}%  ${String(s.slRate).padStart(5)}%  ${String(dwr).padStart(5)}  ${String(de).padStart(5)}`);
  }

  console.log(`\n📊 등급별 성과:`);
  for (const g of byGrade) {
    if (!g.n) continue;
    console.log(`  [${g.label}] (${g.grade}) n=${g.n}, 승률 ${g.winRate}%, 매번 ${g.expectancy}%, 손절률 ${g.slRate}%, ΔE ${g.deltaExpectancy}`);
  }

  console.log(`\n📊 VPR 메인 × 새 필터 적용:`);
  for (const v of vprByFilter) {
    const a = v.noFilter, b = v.score55, c = v.score55_d10;
    console.log(`  [${v.label}] 필터없음 n=${a.n} 승률 ${a.winRate}% 매번 ${a.expectancy}%`);
    if (b.n) console.log(`    + Score≥55      n=${b.n} 승률 ${b.winRate}% 매번 ${b.expectancy}% (ΔE ${b.deltaExpectancy})`);
    if (c.n) console.log(`    + Score≥55+D10  n=${c.n} 승률 ${c.winRate}% 매번 ${c.expectancy}% (ΔE ${c.deltaExpectancy})`);
  }

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

// ─── HTML ───
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>VPR 시장 레짐 비교 — marketBreadthScore</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px; -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 16px 0 8px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }

.score-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 14px; }
.score-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 14px; }
.score-card.strong { border-left: 4px solid #10b981; } .score-card.strong h3 { color: #6ee7b7; }
.score-card.normal { border-left: 4px solid #38bdf8; } .score-card.normal h3 { color: #93c5fd; }
.score-card.select { border-left: 4px solid #f59e0b; } .score-card.select h3 { color: #fbbf24; }
.score-card.caution { border-left: 4px solid #ef4444; } .score-card.caution h3 { color: #fca5a5; }
.score-card h3 { margin: 0 0 6px; font-size: 13px; }
.score-card .nums { font-size: 12px; line-height: 1.7; color: #cbd5e1; }
.score-card .num-big { font-size: 20px; font-weight: 700; }

.scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; margin-bottom: 14px; border-radius: 8px; }
.scroll-x table.cmp { margin-bottom: 0; }
table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 10px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; white-space: nowrap; }
table.cmp thead th:first-child { text-align: left; }
table.cmp tbody td { padding: 7px 10px; border-bottom: 1px solid #334155; text-align: right; font-variant-numeric: tabular-nums; }
table.cmp tbody td:first-child { text-align: left; color: #cbd5e1; font-weight: 600; }
table.cmp tbody tr:hover td { background: #273549; }
.row-good td { background: rgba(13, 148, 136, 0.18) !important; }
.row-bad td { background: rgba(239, 68, 68, 0.10) !important; }
.row-base td { background: rgba(99, 102, 241, 0.12) !important; font-weight: 600; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-neutral { color: #94a3b8; }
.score-badge { display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.sb-strong { background: #064e3b; color: #6ee7b7; }
.sb-normal { background: #1e3a8a; color: #93c5fd; }
.sb-select { background: #422006; color: #fbbf24; }
.sb-caution { background: #7f1d1d; color: #fca5a5; }
.formula-box { background: #0f172a; border: 1px dashed #475569; border-radius: 6px; padding: 10px 14px; margin: 10px 0; font-size: 11.5px; line-height: 1.7; color: #cbd5e1; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }
@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; }
  .scroll-x table.cmp { width: max-content; min-width: 100%; white-space: nowrap; }
}
</style>
</head>
<body>

<h1>VPR 시장 레짐 비교 — marketBreadthScore</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  KOSPI 단독 필터는 삼성전자/SK하이닉스 같은 초대형 반도체주의 영향이 커서 중소형 H그룹/VPR 후보 판단에 왜곡 가능.
  대안으로 <strong>KOSDAQ + 시장 breadth(상승종목 비율) + 쏠림 패널티 + H그룹 후보군 최근 흐름</strong>을 종합한
  <strong>marketBreadthScore (100점 만점)</strong>를 만들고 비교합니다. 모든 필터는 매수 시점(D+5)에 알 수 있는 정보만 사용.
</div>

<div class="warn-banner">
  ⚠️ <strong>승률만 높이는 게 좋은 게 아닙니다.</strong> n이 작거나 매번 평균이 떨어지는 조건은 추천에서 제외합니다.
</div>

<h2>📐 marketBreadthScore 산식</h2>
<div class="formula-box" id="formula-box"></div>

<h2>🎯 점수 등급별 분포 + 성과 (분할청산)</h2>
<div class="score-grid" id="grade-grid"></div>

<h2>📊 9개 필터 비교 (분할청산)</h2>
<p class="subtitle">필터 적용 전(베이스) 대비 변화 비교. 🟢 = 승률·매번 평균 동시 개선 / ⚪ = 한쪽만 / 🔴 = 매번 평균 악화.</p>
<div id="filter-table"></div>

<h2>📊 VPR 메인 태그별 — 새 점수 필터 효과</h2>
<p class="subtitle">베이스 = VPR 분류별 필터 없음. 비교 = + Score≥55, + Score≥55 & 거리≤10%.</p>
<div id="vpr-table"></div>

<h2>📈 점수 분포</h2>
<div id="score-dist"></div>

<h2>📋 개별 매매 결과 (최대 200건, 점수 내림차순)</h2>
<div id="trades-table"></div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;
const cfg = DATA.config;

function fmtPct(v) {
  if (v == null || !isFinite(v)) return '<span class="cell-neutral">-</span>';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%</span>';
}
function fmtRate(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v >= 50 ? 'cell-pos' : (v < 35 ? 'cell-neg' : 'cell-neutral');
  return '<span class="' + cls + '">' + Number(v).toFixed(1) + '%</span>';
}
function fmtDelta(v) {
  if (v == null) return '<span class="cell-neutral">-</span>';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : 'cell-neutral');
  const arrow = v > 0 ? '▲' : (v < 0 ? '▼' : '─');
  return '<span class="' + cls + '">' + arrow + Math.abs(v).toFixed(2) + '</span>';
}
function fmtN(n) {
  if (n == null) return '-';
  if (n < 30) return '<span style="color:#fbbf24;">' + n + ' ⚠</span>';
  return n;
}
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8); }
function gradeBadge(g) {
  const map = { STRONG_INDIVIDUAL: ['sb-strong', '양호'], NORMAL: ['sb-normal', '보통'], SELECTIVE: ['sb-select', '선별'], CAUTION: ['sb-caution', '주의'] };
  const [cls, lbl] = map[g] || ['', g];
  return '<span class="score-badge ' + cls + '">' + lbl + '</span>';
}

document.getElementById('subtitle').textContent =
  '입력 ' + DATA.counts.totalEvents + '건 → 실효 매매 ' + DATA.counts.effectiveTrades + '건 · ' +
  '매수: ' + DATA.meta.buySource + ' · 청산: ' + DATA.meta.holdPattern + ' · ' +
  '생성: ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

// 산식 박스
function renderFormula() {
  const html = ['<strong style="color:#fde68a;">100점 만점 (가산):</strong><ul style="margin:4px 0 8px 18px;padding:0;">'];
  for (const s of cfg.scoreFormula.plus) html.push('<li>' + s + '</li>');
  html.push('</ul><strong style="color:#fca5a5;">쏠림 패널티 (감산):</strong><ul style="margin:4px 0 8px 18px;padding:0;">');
  for (const s of cfg.scoreFormula.minus) html.push('<li>' + s + '</li>');
  html.push('</ul><strong>등급:</strong> 75↑ ' + gradeBadge('STRONG_INDIVIDUAL') + ' · 55~74 ' + gradeBadge('NORMAL') + ' · 35~54 ' + gradeBadge('SELECTIVE') + ' · &lt;35 ' + gradeBadge('CAUTION'));
  document.getElementById('formula-box').innerHTML = html.join('');
}
renderFormula();

// 등급 카드
function renderGradeCards() {
  const html = [];
  const clsMap = { STRONG_INDIVIDUAL: 'strong', NORMAL: 'normal', SELECTIVE: 'select', CAUTION: 'caution' };
  for (const g of DATA.byGrade) {
    if (!g.n) continue;
    const cls = clsMap[g.grade] || '';
    html.push('<div class="score-card ' + cls + '">' +
      '<h3>' + g.label + '</h3>' +
      '<div class="nums">표본 <strong>' + g.n + '건</strong></div>' +
      '<div class="nums">승률 <span class="num-big">' + g.winRate + '%</span></div>' +
      '<div class="nums">매번 평균 <span class="num-big">' + fmtPct(g.expectancy) + '</span></div>' +
      '<div class="nums" style="font-size:11px;color:#94a3b8;">손절률 ' + g.slRate + '% · 평균 MAE ' + fmtPct(g.avgMAE) + '</div>' +
      '<div class="nums" style="font-size:11px;color:#94a3b8;">ΔE vs 전체 ' + fmtDelta(g.deltaExpectancy) + '</div>' +
      '</div>');
  }
  document.getElementById('grade-grid').innerHTML = html.join('');
}
renderGradeCards();

// 필터 비교 표
function renderFilterTable() {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>필터</th><th>n</th><th>승률</th><th>매번 평균</th>',
    '<th>평균 MFE</th><th>평균 MAE</th><th>손절률</th><th>익절률</th>',
    '<th>제거수</th><th>ΔWR</th><th>ΔE</th>',
    '</tr></thead><tbody>'];
  for (const s of DATA.summary) {
    if (!s.n) continue;
    const isBase = s.key === 'NONE';
    let cls = '';
    if (isBase) cls = ' class="row-base"';
    else if (s.deltaWinRate >= 0 && s.deltaExpectancy >= 0) cls = ' class="row-good"';
    else if (s.deltaExpectancy < -0.2) cls = ' class="row-bad"';
    html.push('<tr' + cls + '><td>' + s.label + '</td>' +
      '<td>' + fmtN(s.n) + '</td>' +
      '<td>' + fmtRate(s.winRate) + '</td>' +
      '<td>' + fmtPct(s.expectancy) + '</td>' +
      '<td>' + fmtPct(s.avgMFE) + '</td>' +
      '<td>' + fmtPct(s.avgMAE) + '</td>' +
      '<td>' + (s.slRate != null ? s.slRate + '%' : '-') + '</td>' +
      '<td>' + (s.tpRate != null ? s.tpRate + '%' : '-') + '</td>' +
      '<td>' + (isBase ? 0 : (s.removed != null ? s.removed : '-')) + '</td>' +
      '<td>' + (isBase ? '-' : fmtDelta(s.deltaWinRate)) + '</td>' +
      '<td>' + (isBase ? '-' : fmtDelta(s.deltaExpectancy)) + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById('filter-table').innerHTML = html.join('');
}
renderFilterTable();

// VPR × 새 필터
function renderVprTable() {
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>VPR 분류</th>',
    '<th>n (필터 없음)</th><th>승률</th><th>매번 평균</th>',
    '<th>n (Score≥55)</th><th>승률</th><th>매번 평균</th><th>ΔE</th>',
    '<th>n (Score≥55+D10)</th><th>승률</th><th>매번 평균</th><th>ΔE</th>',
    '</tr></thead><tbody>'];
  for (const v of DATA.vprByFilter) {
    const a = v.noFilter, b = v.score55, c = v.score55_d10;
    html.push('<tr><td>' + v.label + '</td>' +
      '<td>' + fmtN(a.n) + '</td>' +
      '<td>' + fmtRate(a.winRate) + '</td>' +
      '<td>' + fmtPct(a.expectancy) + '</td>' +
      '<td>' + (b.n ? fmtN(b.n) : '-') + '</td>' +
      '<td>' + (b.n ? fmtRate(b.winRate) : '-') + '</td>' +
      '<td>' + (b.n ? fmtPct(b.expectancy) : '-') + '</td>' +
      '<td>' + (b.n ? fmtDelta(b.deltaExpectancy) : '-') + '</td>' +
      '<td>' + (c.n ? fmtN(c.n) : '-') + '</td>' +
      '<td>' + (c.n ? fmtRate(c.winRate) : '-') + '</td>' +
      '<td>' + (c.n ? fmtPct(c.expectancy) : '-') + '</td>' +
      '<td>' + (c.n ? fmtDelta(c.deltaExpectancy) : '-') + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById('vpr-table').innerHTML = html.join('');
}
renderVprTable();

// 점수 분포
function renderScoreDist() {
  const total = DATA.counts.effectiveTrades;
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr><th>점수 구간</th><th>건수</th><th>비율</th></tr></thead><tbody>'];
  for (const [k, v] of Object.entries(DATA.scoreBuckets)) {
    html.push('<tr><td>' + k + '</td><td>' + v + '</td><td>' + (total ? (v/total*100).toFixed(1) : 0) + '%</td></tr>');
  }
  html.push('</tbody></table></div>');
  document.getElementById('score-dist').innerHTML = html.join('');
}
renderScoreDist();

// 개별 매매 결과
function renderTrades() {
  const sorted = (DATA.trades || []).slice().sort((a, b) => b.breadthScore - a.breadthScore).slice(0, 200);
  const html = ['<div class="scroll-x"><table class="cmp"><thead><tr>',
    '<th>#</th><th>종목</th><th>매수일</th><th>VPR</th>',
    '<th>거리%</th><th>점수</th><th>등급</th>',
    '<th>상승비율</th><th>H그룹 최근</th><th>수익률</th>',
    '</tr></thead><tbody>'];
  sorted.forEach((t, i) => {
    const ret = t.returnPct;
    const cls = ret > 0 ? 'cell-pos' : (ret < 0 ? 'cell-neg' : 'cell-neutral');
    const exit = t.exitType;
    const exitTag = exit === 'TP' ? '✅' : (exit === 'SL' ? '❌' : (exit === 'PARTIAL_TIME' ? '🔀' : '⏱'));
    html.push('<tr><td>' + (i + 1) + '</td>' +
      '<td>' + (t.name || '') + ' <span style="color:#64748b;">' + t.code + '</span></td>' +
      '<td>' + fmtDate(t.buyDate) + '</td>' +
      '<td><span style="font-size:11px;color:#cbd5e1;">' + (t.vprMainLabel || '-') + '</span></td>' +
      '<td>' + (t.entryDistancePct != null ? fmtPct(t.entryDistancePct) : '-') + '</td>' +
      '<td><strong>' + t.breadthScore + '</strong></td>' +
      '<td>' + gradeBadge(t.breadthGrade) + '</td>' +
      '<td>' + (t.advanceRatio != null ? t.advanceRatio + '%' : '-') + '</td>' +
      '<td>' + (t.hgroupAvg != null ? fmtPct(t.hgroupAvg) : '-') + '</td>' +
      '<td><span class="' + cls + '">' + exitTag + ' ' + (ret > 0 ? '+' : '') + Number(ret).toFixed(2) + '%</span></td>' +
      '</tr>');
  });
  html.push('</tbody></table></div>');
  document.getElementById('trades-table').innerHTML = html.join('');
}
renderTrades();

document.getElementById('data-limit').innerHTML =
  '<strong>데이터 한계 / 가정</strong><br>' +
  '• 매수: ' + DATA.meta.buySource + ' · 분할청산 (50% +6 / 30% +12 / 20% +16, 손절 -5%, 본전 ratchet)<br>' +
  '• 시장 breadth: 캐시 내 추적 종목 (~2700) 기준 일별 상승/하락 종목 비율<br>' +
  '• H그룹 최근 평균: 매수일 기준 [-20, -5] 거래일 windowed hPlus5.closeN 평균<br>' +
  '• marketBreadthScore: 매수 시점에 알 수 있는 정보만 사용 (look-ahead 없음)<br>' +
  '• <strong>매수 추천이 아닙니다.</strong> 통계 검증입니다.';
</script>

</body>
</html>
`;

main();
