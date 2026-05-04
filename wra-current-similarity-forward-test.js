#!/usr/bin/env node
/**
 * WRA 현재 유사도 보고서 — Forward Test (사후 검증)
 *
 * 목적:
 *   wra-current-similarity-report-v2의 라벨/점수 로직이 실제로 좋은 후속 성과로 이어지는지
 *   사후 검증한다.
 *
 * 데이터 한계:
 *   v2의 latestTradingDate=20260504 시점에서는 forward 데이터(5거래일 이후)가 없다.
 *   따라서 본 스크립트는 "backtest 모드"로 동작한다.
 *   각 종목의 latestIdx - BACKWARD_OFFSET 시점을 가상의 latestTradingDate로 가정하여
 *   v2 logic으로 라벨/등급을 평가하고, 그 후 BACKWARD_OFFSET일 동안의 실제 가격으로 forward를 측정한다.
 *
 * 데이터 누수 방지:
 *   - 라벨/점수 계산은 "T 시점까지의 데이터만" 사용 (wra의 measureT0/analyzeT0 동일)
 *   - forward 측정은 T+1 ~ T+20 데이터 사용 (사후 측정용)
 *
 * 입력:
 *   - reports/wra-current-similarity-report-v2.json (universe로 candidate code list 사용)
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json
 *
 * 출력:
 *   - reports/wra-current-similarity-forward-test-result.json
 *
 * 옵션:
 *   --offset=21    (기본) backward offset 거래일 수
 *   --top=20       각 그룹 상위/하위 종목 N개 저장
 *
 * 매수 신호 아님. 사후 검증 보고서.
 */

const fs = require('fs');
const path = require('path');
const wra = require('./wra-winner-reverse-audit');
const v2 = require('./wra-current-similarity-report-v2');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');
const V2_INPUT = path.join(REPORTS_DIR, 'wra-current-similarity-report-v2.json');

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
})();

const CONFIG = {
  // 여러 backward offset에서 rolling backtest (단일 시점은 표본 부족)
  BACKWARD_OFFSETS: (args.offsets || '21,35,50,70,90,120').split(',').map(s => parseInt(s.trim())),
  // 같은 종목·같은 라벨 활성화 시점이 가까우면 dedup (cooldown 거래일)
  DEDUP_DAYS: parseInt(args.dedup || '20'),
  MIN_HISTORY: 60,
  MIN_MARKET_CAP: 30_000_000_000,
  TOP_N: parseInt(args.top || '20'),
  RISK_THRESHOLD: 20,
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcluded(name) { return name && EXCLUDE_KEYWORDS.some(k => name.includes(k)); }

// ─────────────────────── 헬퍼 ───────────────────────

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d||'-'); }

function avg(arr) {
  const f = arr.filter(v => v != null && Number.isFinite(v));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}
function median(arr) {
  const f = arr.filter(v => v != null && Number.isFinite(v));
  if (!f.length) return null;
  const s = [...f].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function rate(arr) {
  const f = arr.filter(v => v != null);
  return f.length ? f.filter(v => v).length / f.length : null;
}

// ─────────────────────── 측정: T 시점에서 라벨 + 점수 + forward ───────────────────────

function measureAtIdx(rows, indi, idx, marketCap) {
  const today = rows[idx];
  const prev = rows[idx - 1];
  if (!today || !prev) return null;

  const measurements = wra.measureT0(rows, indi, idx, marketCap, idx);
  if (!measurements) return null;
  const t0Detail = wra.analyzeT0(rows, indi, idx, marketCap);
  if (!t0Detail) return null;
  const prep = wra.analyzePreparation(rows, indi, idx, marketCap);

  return {
    idx, date: today.date, close: today.close, prevClose: prev.close,
    dayReturn: t0Detail.dayReturn,
    valueRatio20: measurements.valueRatio20,
    volumeRatio20: measurements.volumeRatio20,
    valueToMarketCap: measurements.valueToMarketCap,
    closeLocation: measurements.closeLocation,
    closeToMA5: measurements.closeToMA5,
    closeToMA20: measurements.closeToMA20,
    closeToMA60: measurements.closeToMA60,
    closeFrom52WeekHigh: measurements.closeFrom52WeekHigh,
    closeFromRecentLow20: measurements.closeFromRecentLow20,
    closeFromRecentHigh20: measurements.closeFromRecentHigh20,
    boxRangePct: measurements.boxRangePct,
    dynamicBoxDuration: measurements.dynamicBoxDuration,
    boxFallback: measurements.boxFallback,
    overheadRatio: measurements.overheadRatio,
    supportRatio: measurements.supportRatio,
    boxUpperBreak: t0Detail.boxUpperBreak,
    chartLen: idx + 1,                    // T 시점까지 사용 가능 길이
    prep,
  };
}

function computeForward(rows, idx, entryClose) {
  const out = {};
  const w5 = rows.slice(idx + 1, idx + 1 + 5);
  const w10 = rows.slice(idx + 1, idx + 1 + 10);
  const w20 = rows.slice(idx + 1, idx + 1 + 20);

  out.d5Return = w5.length === 5 ? (w5[4].close / entryClose - 1) * 100 : null;
  out.d10Return = w10.length === 10 ? (w10[9].close / entryClose - 1) * 100 : null;
  out.d20Return = w20.length === 20 ? (w20[19].close / entryClose - 1) * 100 : null;

  if (w5.length) {
    out.mfe5 = (Math.max(...w5.map(r => r.high)) / entryClose - 1) * 100;
    out.mae5 = (Math.min(...w5.map(r => r.low)) / entryClose - 1) * 100;
  }
  if (w10.length) {
    out.mfe10 = (Math.max(...w10.map(r => r.high)) / entryClose - 1) * 100;
    out.mae10 = (Math.min(...w10.map(r => r.low)) / entryClose - 1) * 100;
  }
  if (w20.length) {
    out.mfe20 = (Math.max(...w20.map(r => r.high)) / entryClose - 1) * 100;
    out.mae20 = (Math.min(...w20.map(r => r.low)) / entryClose - 1) * 100;
    out.hit10Within20 = w20.some(r => r.high >= entryClose * 1.10);
    out.hit15Within20 = w20.some(r => r.high >= entryClose * 1.15);
    out.hit20Within20 = w20.some(r => r.high >= entryClose * 1.20);
    out.drop10Within20 = w20.some(r => r.low <= entryClose * 0.90);
  }
  // 다음 거래일 단일 측정
  if (rows[idx + 1]) {
    const nx = rows[idx + 1];
    out.nextDayHighBreak = nx.high > rows[idx].high;
    out.nextDayClosePositive = nx.close > entryClose;
  }
  return out;
}

// ─────────────────────── 그룹 분류 ───────────────────────

function isCoreBStrong(c, m) {
  return c.labels.includes('BMS_VALUE')
    && c.riskScore < 10
    && c.totalScore >= 55
    && (m.valueRatio20 || 0) >= 2
    && (m.volumeRatio20 || 0) >= 1.8
    && (m.closeLocation || 0) >= 0.6;
}

function assignGroups(c, m) {
  const groups = ['ALL'];
  if (c.watchTagV2 === 'CORE_A') {
    groups.push('CORE_A');
    if (c.riskScore === 0) groups.push('CORE_A_RISK0');
    if (c.historyQuality === 'MID_HISTORY' || c.historyQuality === 'FULL_HISTORY') groups.push('CORE_A_MIDFULL');
  }
  if (c.watchTagV2 === 'CORE_B') {
    groups.push('CORE_B');
    if (isCoreBStrong(c, m)) groups.push('CORE_B_STRONG');
  }
  if (c.watchTagV2 === 'EARLY_WATCH') groups.push('EARLY_WATCH');
  if (c.watchTagV2 === 'BREAKOUT_CHASE') groups.push('BREAKOUT_CHASE');
  if (c.watchTagV2 === 'CHASE_RISK') groups.push('CHASE_RISK');
  return groups;
}

// ─────────────────────── 통계 집계 ───────────────────────

function statsForGroup(records, groupKey) {
  const filtered = records.filter(r => r.groups.includes(groupKey));
  if (filtered.length === 0) return { groupKey, count: 0 };
  const pickAvg = (k) => avg(filtered.map(r => r.forward?.[k]));
  const pickMed = (k) => median(filtered.map(r => r.forward?.[k]));
  const pickRate = (k) => rate(filtered.map(r => r.forward?.[k]));
  return {
    groupKey,
    count: filtered.length,
    uniqueStocks: new Set(filtered.map(r => r.code)).size,
    avgD5: pickAvg('d5Return'), medD5: pickMed('d5Return'),
    avgD10: pickAvg('d10Return'), medD10: pickMed('d10Return'),
    avgD20: pickAvg('d20Return'), medD20: pickMed('d20Return'),
    avgMfe5: pickAvg('mfe5'), avgMfe10: pickAvg('mfe10'), avgMfe20: pickAvg('mfe20'),
    avgMae5: pickAvg('mae5'), avgMae10: pickAvg('mae10'), avgMae20: pickAvg('mae20'),
    hit10Rate: pickRate('hit10Within20'),
    hit15Rate: pickRate('hit15Within20'),
    hit20Rate: pickRate('hit20Within20'),
    drop10Rate: pickRate('drop10Within20'),
    nextDayHighBreakRate: pickRate('nextDayHighBreak'),
    nextDayPosCloseRate: pickRate('nextDayClosePositive'),
    posD10Rate: rate(filtered.map(r => r.forward?.d10Return != null ? r.forward.d10Return > 0 : null)),
    posD20Rate: rate(filtered.map(r => r.forward?.d20Return != null ? r.forward.d20Return > 0 : null)),
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('WRA Current Similarity — Forward Test (backtest mode)');
  console.log('═'.repeat(80));
  console.log(`backward offsets: ${CONFIG.BACKWARD_OFFSETS.join('/')}거래일 (rolling backtest)`);

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(V2_INPUT)) {
    console.error('❌ v2 결과 없음. 먼저 wra-current-similarity-report-v2.js 실행 필요.');
    process.exit(1);
  }
  const v2Result = JSON.parse(fs.readFileSync(V2_INPUT, 'utf-8'));
  console.log(`v2 입력: 후보 ${v2Result.summary?.candidatesCount}개, latestTradingDate=${fmtDate(v2Result.meta?.latestTradingDate)}`);

  const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const stockMap = {};
  (stocksData.stocks || []).forEach(s => { stockMap[s.code] = s; });

  // universe: v2 후보 종목들 (code만 사용, 라벨/점수는 T-N 시점에서 재평가)
  const universeCodes = new Set(v2Result.candidates.map(c => c.code));
  console.log(`universe (v2 후보 종목 코드): ${universeCodes.size}개`);

  const records = [];
  let processed = 0, skipShort = 0, skipNoLabel = 0;
  const startTime = Date.now();

  universeCodes.forEach(code => {
    const meta = stockMap[code];
    if (!meta) return;
    if (isExcluded(meta.name)) return;
    const marketCap = meta.marketValue || 0;
    if (marketCap < CONFIG.MIN_MARKET_CAP) return;

    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, code + '.json'), 'utf-8')); }
    catch (_) { return; }
    const rows = chart.rows || [];
    // 가장 작은 offset(첫 항목)으로도 evalIdx >= MIN_HISTORY가 안 되는 종목만 skip
    const minNeeded = CONFIG.MIN_HISTORY + Math.min(...CONFIG.BACKWARD_OFFSETS);
    if (rows.length < minNeeded) { skipShort++; return; }

    const indi = wra.precomputeIndicators(rows);
    const tIdx = rows.length - 1;
    let lastEventIdx = -Infinity;

    // 여러 offset에서 rolling 평가
    for (const offset of CONFIG.BACKWARD_OFFSETS) {
      const evalIdx = tIdx - offset;
      if (evalIdx < CONFIG.MIN_HISTORY) continue;
      // 같은 종목 내 dedup (앞서 잡힌 이벤트와 가까우면 skip)
      if (evalIdx - lastEventIdx <= CONFIG.DEDUP_DAYS) continue;

      const m = measureAtIdx(rows, indi, evalIdx, marketCap);
      if (!m) continue;

      const labels = v2.evaluateLabels(m);
      if (labels.length === 0) { skipNoLabel++; continue; }

      const hasBmsValue = labels.includes('BMS_VALUE');
      const scores = v2.computeScores(m, m.prep, hasBmsValue);
      const tagV2 = v2.watchTagV2(labels, scores.riskScore, scores.warnings);

      const forward = computeForward(rows, evalIdx, rows[evalIdx].close);

      const cand = {
        code,
        name: meta.name,
        market: meta.market,
        marketCap,
        evalIdx,
        evalDate: rows[evalIdx].date,
        offsetUsed: offset,
        latestDate: rows[tIdx].date,
        labels,
        watchTagV2: tagV2,
        historyQuality: m.chartLen >= 250 ? 'FULL_HISTORY' : (m.chartLen >= 120 ? 'MID_HISTORY' : 'SHORT_HISTORY'),
        ...scores,
        metrics: {
          valueRatio20: m.valueRatio20,
          volumeRatio20: m.volumeRatio20,
          valueToMarketCap: m.valueToMarketCap,
          closeLocation: m.closeLocation,
          closeToMA20: m.closeToMA20,
          closeFromRecentLow20: m.closeFromRecentLow20,
          dayReturn: m.dayReturn,
        },
        forward,
      };
      cand.groups = assignGroups(cand, m);
      records.push(cand);
      lastEventIdx = evalIdx;
    }
    processed++;
  });
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n분석 완료: 종목 ${processed}개, events ${records.length}개, ${elapsed.toFixed(0)}초`);
  console.log(`  스킵: 차트짧음=${skipShort} 라벨없음(per offset)=${skipNoLabel}`);

  // 그룹별 통계
  const GROUPS = ['ALL', 'CORE_A', 'CORE_A_RISK0', 'CORE_A_MIDFULL', 'CORE_B', 'CORE_B_STRONG', 'EARLY_WATCH', 'BREAKOUT_CHASE', 'CHASE_RISK'];
  const groupStats = {};
  GROUPS.forEach(g => { groupStats[g] = statsForGroup(records, g); });

  // 그룹별 상위/하위 N개 (D+10 기준)
  const groupTop = {};
  GROUPS.forEach(g => {
    const filtered = records.filter(r => r.groups.includes(g));
    const sortedByD10 = [...filtered]
      .filter(r => r.forward?.d10Return != null)
      .sort((a, b) => (b.forward.d10Return) - (a.forward.d10Return));
    groupTop[g] = {
      top: sortedByD10.slice(0, CONFIG.TOP_N),
      bottom: sortedByD10.slice(-CONFIG.TOP_N).reverse(),
    };
  });

  // 콘솔 출력
  console.log('\n📊 그룹별 forward 성과:');
  console.log('  group               n   stocks  D+5    D+10   D+20   medD20  MFE10  MAE10  +10%   +20%   -10%   posD10');
  GROUPS.forEach(g => {
    const s = groupStats[g];
    if (s.count === 0) { console.log(`  ${g.padEnd(18)}: 사례 없음`); return; }
    const f = (n, d=2) => n != null && Number.isFinite(n) ? n.toFixed(d) : '--';
    const r = (n) => n != null ? (n*100).toFixed(0)+'%' : '--';
    console.log(`  ${g.padEnd(18)} ${String(s.count).padStart(4)} ${String(s.uniqueStocks).padStart(5)}  ${f(s.avgD5).padStart(5)} ${f(s.avgD10).padStart(5)} ${f(s.avgD20).padStart(5)}  ${f(s.medD20).padStart(5)}  ${f(s.avgMfe10).padStart(5)} ${f(s.avgMae10).padStart(5)} ${r(s.hit10Rate).padStart(4)} ${r(s.hit20Rate).padStart(4)} ${r(s.drop10Rate).padStart(4)} ${r(s.posD10Rate).padStart(5)}`);
  });

  // JSON 출력
  const out = {
    meta: {
      version: 'wra-current-similarity-forward-test-v1',
      generatedAt: new Date().toISOString(),
      backwardOffset: CONFIG.BACKWARD_OFFSET,
      mode: 'backtest',
      modeNote: `latestTradingDate(${fmtDate(v2Result.meta?.latestTradingDate)})에서 forward 데이터가 없으므로, 각 종목의 latestIdx-${CONFIG.BACKWARD_OFFSET} 시점을 가상의 evalDate로 가정하여 v2 logic 적용 후 forward 측정. 정확한 forward test는 latestTradingDate 이후 ${CONFIG.BACKWARD_OFFSET}거래일이 지난 후 다시 실행해야 한다.`,
      universeFromV2: universeCodes.size,
      candidates: records.length,
      executionSeconds: Math.round(elapsed),
      notice: '본 보고서는 매수 신호가 아닙니다. v2 logic의 사후 검증용 forward test입니다.',
    },
    config: CONFIG,
    groupStats,
    groupTop,
    records,
  };

  const outPath = path.join(REPORTS_DIR, 'wra-current-similarity-forward-test-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  const sizeKB = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`\n✅ JSON 저장: ${outPath} (${sizeKB}KB)`);
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main, computeForward, statsForGroup };
