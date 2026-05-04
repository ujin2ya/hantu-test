#!/usr/bin/env node
/**
 * BMS Forward Performance Backtest
 *
 * 각 거래일 장마감 기준으로 BMS 후보군 (12종)을 분류하고,
 * 그 후 D+1 / D+3 / D+5 / D+10 / D+20 성과를 측정한다.
 * 어떤 후보군이 실제로 가장 강한 후속 상승을 보였는지 검증해서
 * BMS-H (BMS의 H그룹)을 자동 도출한다.
 *
 * 미래 데이터 누수 방지:
 *   - 각 기준일 d 의 BMS 점수는 d 이전 데이터만 사용
 *   - 미래 D+N 성과는 사후 측정용으로만 별도 단계에서 계산
 *
 * 입력:
 *   - big-move-similarity-report.json (baselines)
 *   - cache/stock-charts-long/{code}.json
 *   - cache/flow-history/{code}.json
 *
 * 출력:
 *   - bms-forward-performance-report.json
 *   - bms-forward-performance-report.html
 *
 * 옵션:
 *   --start=YYYYMMDD    분석 시작일 (기본 20250401)
 *   --end=YYYYMMDD      분석 종료일 (기본 20260430)
 *   --sample=N          처음 N 거래일만 (테스트용)
 *
 * 매수 추천이 아니라 모델 검증·실험 보고서다.
 */

const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');
const bms = require('./big-move-similarity-report');

const ROOT = __dirname;
const STOCKS_FILE = path.join(ROOT, 'cache/naver-stocks-list.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache/flow-history');
const REPORT_JSON = path.join(ROOT, 'big-move-similarity-report.json');

// ─────────────────────── 설정 ───────────────────────

const args = (() => {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
})();

const config = {
  ANALYSIS_START: args.start || '20250401',
  ANALYSIS_END: args.end || '20260430',
  HORIZONS: [1, 3, 5, 10, 20],
  EPISODE_COOLDOWN: 10,
  MIN_BMS_SCORE: 65,        // events 저장 컷
  MIN_MARKET_CAP: 30_000_000_000,
  SAMPLE_DAYS: args.sample ? parseInt(args.sample) : null,
  GROUP_DEFINITIONS: {
    A: { label: 'BMS 80+', desc: 'BMS Score ≥ 80' },
    B: { label: 'BMS 90+', desc: 'BMS Score ≥ 90' },
    C: { label: 'BMS 강한+신선', desc: 'Score ≥ 80, ret20≤25, ret40≤30, L60≤50' },
    D: { label: 'BMS 강한+추세 후반', desc: 'Score ≥ 80, ret40>30 또는 L60>50' },
    E: { label: '거래대금 폭발', desc: 'today×Med≥4, 10d/시총≥10%, 양봉, closeLoc≥0.5' },
    F: { label: 'BMS + QVA-HL', desc: 'Score ≥ 80, QVA-HL ≥ 80' },
    G: { label: 'BMS + QVA-Ev', desc: 'Score ≥ 80, QVA-Evolution ≥ 70' },
    H: { label: 'BMS + QVA 변형', desc: 'Score ≥ 80, (HL≥80 OR Ev≥70)' },
    I: { label: 'BMS + 최근 VVI', desc: 'Score ≥ 80, 40일 내 VVI 발화, close≥VVI×0.95' },
    J: { label: 'BMS + 폭발 + 매물대 낮음', desc: 'Score ≥ 80, today×≥4, 매물대≤15%, closeLoc≥0.5' },
    K: { label: 'BMS 눌림 대기', desc: '65≤Score<80, H60≤-20, MA20위, 매물대≥20%' },
    L: { label: 'BMS + QVA + VVI', desc: 'Score ≥ 80, QVA 변형, 40일 내 VVI' },
  },
};

const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  return name && EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

// ─────────────────────── 헬퍼 ───────────────────────

function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}
function average(values) {
  if (!values || values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function quartile(values, q) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] != null) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

// ─────────────────────── 로드 ───────────────────────

function loadStocks() {
  const data = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const map = {};
  (data.stocks || []).forEach(s => { map[s.code] = s; });
  return map;
}

function loadAllCharts() {
  const map = {};
  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  files.forEach(f => {
    const code = f.replace('.json', '');
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CHART_DIR, f), 'utf-8'));
      const rows = c.rows || [];
      if (rows.length >= 60) map[code] = rows;
    } catch (_) {}
  });
  return map;
}

function loadAllFlows(codes) {
  const map = {};
  codes.forEach(code => {
    const fp = path.join(FLOW_DIR, `${code}.json`);
    if (!fs.existsSync(fp)) return;
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      map[code] = j.rows || [];
    } catch (_) {}
  });
  return map;
}

// ─────────────────────── 핵심 분석 ───────────────────────

// 종목 별 차트에서 d 시점까지의 마지막 인덱스를 binary search로 찾기
function findIdxByDate(rows, d) {
  let lo = 0, hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].date === d) return mid;
    if (rows[mid].date < d) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1; // 그날 거래 없음
}

// 미래 D+N 성과 계산 (idx 이후 horizon 일)
function computeForwardReturns(rows, idx, entryClose) {
  const out = {};
  config.HORIZONS.forEach(h => {
    if (idx + h < rows.length) {
      out['d' + h] = (rows[idx + h].close / entryClose - 1) * 100;
    }
  });
  ['5', '10', '20'].forEach(h => {
    const n = parseInt(h);
    const w = rows.slice(idx + 1, idx + 1 + n);
    if (w.length === n) {
      out['mfe' + h] = (Math.max(...w.map(r => r.high)) / entryClose - 1) * 100;
      out['mae' + h] = (Math.min(...w.map(r => r.low)) / entryClose - 1) * 100;
    }
  });
  // 도달률 (20일 안에 +5/+10/+20% 도달, -5/-10% 하락)
  const w20 = rows.slice(idx + 1, idx + 21);
  if (w20.length > 0) {
    out.hit5 = w20.some(r => r.high >= entryClose * 1.05);
    out.hit10 = w20.some(r => r.high >= entryClose * 1.10);
    out.hit20 = w20.some(r => r.high >= entryClose * 1.20);
    out.hitNeg5 = w20.some(r => r.low <= entryClose * 0.95);
    out.hitNeg10 = w20.some(r => r.low <= entryClose * 0.90);
  }
  return out;
}

// 한 종목, 한 거래일에서 BMS + 교차 신호 측정
function analyzeStockOnDay(rows, idx, marketCap, flowRows, baselines) {
  if (idx < 60) return null;
  const slice = rows.slice(0, idx + 1);
  const today = slice[slice.length - 1];

  const result = bms.scoreCurrentCandidate(slice, marketCap, flowRows, baselines, today.date);
  if (!result) return null;
  if (result.normalizedScore < config.MIN_BMS_SCORE) return null;

  // recent5/10/20/40 Return
  const closeAt = (n) => slice[slice.length - 1 - n]?.close;
  const ret = (n) => closeAt(n) ? (today.close / closeAt(n) - 1) * 100 : null;

  // closeLocation
  const closeLocation = (today.high - today.low) > 0
    ? (today.close - today.low) / (today.high - today.low)
    : 0.5;

  // QVA HL / Evolution / VVI — BMS 80+만 계산 (계산 비용 절감)
  let qvaHL = null, qvaEv = null, recentVVI = null;
  if (result.normalizedScore >= 80) {
    try {
      const r = ps.calculateQuietVolumeHigherLow(slice, flowRows || [], { code: '_', marketValue: marketCap });
      if (r && r.score) qvaHL = r.score;
    } catch (_) {}
    try {
      if (ps.calculateQvaEvolution) {
        const r = ps.calculateQvaEvolution(slice, flowRows || [], { code: '_', marketValue: marketCap });
        if (r && r.score) qvaEv = r.score;
      }
    } catch (_) {}
    // 최근 40일 VVI 발화 (D+0 ~ D+40) — 가장 최근 1개만
    for (let lb = 0; lb <= 40; lb++) {
      const sliceEnd = slice.length - lb;
      if (sliceEnd < 60) break;
      const past = slice.slice(0, sliceEnd);
      try {
        const v = ps.calculateVolumeValueIgnition(past, flowRows || [], { code: '_', marketValue: marketCap });
        if (v && v.passed) {
          recentVVI = {
            date: past[past.length - 1].date,
            daysAgo: lb,
            score: v.score || v.totalScore || null,
            signalClose: past[past.length - 1].close,
          };
          break;
        }
      } catch (_) {}
    }
  }

  return {
    bmsScore: result.normalizedScore,
    bmsLabel: result.label,
    todayClose: today.close,
    todayReturn: result.today.todayReturn,
    todayValueRatio: result.today.todayValueRatio,
    recent3ValueRatio: result.snapshot.recent3ValueRatio,
    value10dRatio: result.snapshot.value10dRatio,
    value20dRatio: result.snapshot.value20dRatio,
    returnFromLow60: result.snapshot.returnFromLow60,
    distanceFromHigh60: result.snapshot.distanceFromHigh60,
    overheadSupply10: result.snapshot.overheadSupply10,
    closeAboveMa20: result.snapshot.closeAboveMa20,
    closeMa20Gap: result.snapshot.closeMa20Gap,
    closeLocation,
    qvaHL,
    qvaEv,
    recentVVI,
    recent5Return: ret(5),
    recent10Return: ret(10),
    recent20Return: ret(20),
    recent40Return: ret(40),
    matched: result.matched,
    warnings: result.warnings,
  };
}

// 후보군 분류 (12개)
function classifyEvent(e) {
  const groups = [];
  const s = e.bmsScore;

  if (s >= 80) groups.push('A');
  if (s >= 90) groups.push('B');

  const isFresh = (e.recent20Return == null || e.recent20Return <= 25) &&
                  (e.recent40Return == null || e.recent40Return <= 30) &&
                  e.returnFromLow60 <= 50;
  const isLate = (e.recent40Return != null && e.recent40Return > 30) || e.returnFromLow60 > 50;
  if (s >= 80 && isFresh) groups.push('C');
  if (s >= 80 && isLate) groups.push('D');

  if (e.todayValueRatio >= 4 && e.value10dRatio >= 0.10 &&
      e.todayReturn > 0 && e.closeLocation >= 0.5) groups.push('E');

  if (s >= 80 && e.qvaHL != null && e.qvaHL >= 80) groups.push('F');
  if (s >= 80 && e.qvaEv != null && e.qvaEv >= 70) groups.push('G');
  if (s >= 80 && ((e.qvaHL != null && e.qvaHL >= 80) || (e.qvaEv != null && e.qvaEv >= 70))) groups.push('H');

  if (s >= 80 && e.recentVVI && e.recentVVI.daysAgo <= 40 &&
      e.todayClose >= e.recentVVI.signalClose * 0.95) groups.push('I');

  if (s >= 80 && e.todayValueRatio >= 4 && e.overheadSupply10 <= 0.15 &&
      e.closeLocation >= 0.5) groups.push('J');

  if (s >= 65 && s < 80 && e.distanceFromHigh60 <= -20 &&
      e.closeAboveMa20 && e.closeMa20Gap >= -5 && e.overheadSupply10 >= 0.20) groups.push('K');

  if (s >= 80 && ((e.qvaHL != null && e.qvaHL >= 80) || (e.qvaEv != null && e.qvaEv >= 70)) &&
      e.recentVVI && e.recentVVI.daysAgo <= 40) groups.push('L');

  return groups;
}

// 후보군별 통계 집계
function aggregate(events, groupKey) {
  const filtered = events.filter(e => (e.groups || []).includes(groupKey));
  const stats = {
    count: filtered.length,
    uniqueStocks: new Set(filtered.map(e => e.code)).size,
  };
  if (filtered.length === 0) return stats;

  config.HORIZONS.forEach(h => {
    const vals = filtered.map(e => e.forward?.['d' + h]).filter(v => v != null && Number.isFinite(v));
    stats['avgRet' + h] = average(vals);
    if (h === 20) stats['medianRet20'] = median(vals);
    stats['posRate' + h] = vals.length ? vals.filter(v => v > 0).length / vals.length : 0;
  });

  ['5', '10', '20'].forEach(h => {
    const mfe = filtered.map(e => e.forward?.['mfe' + h]).filter(v => v != null && Number.isFinite(v));
    const mae = filtered.map(e => e.forward?.['mae' + h]).filter(v => v != null && Number.isFinite(v));
    stats['mfe' + h] = average(mfe);
    stats['mae' + h] = average(mae);
  });

  ['hit5', 'hit10', 'hit20', 'hitNeg5', 'hitNeg10'].forEach(k => {
    const vals = filtered.map(e => e.forward?.[k]).filter(v => v != null);
    stats[k + 'Rate'] = vals.length ? vals.filter(v => v).length / vals.length : 0;
  });

  stats.returnToRiskRatio = stats.avgRet10 != null && stats.mae10 != null && Math.abs(stats.mae10) > 0.01
    ? stats.avgRet10 / Math.abs(stats.mae10)
    : null;

  return stats;
}

// Episode 기준: 같은 종목에서 10일 안 첫 신호만 유지
function makeEpisodes(events) {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const seen = {};  // code → 마지막 episode 시작 idx (events sort 후의 idx 기준이지만 단순화 위해 date 기준)
  const out = [];
  sorted.forEach(e => {
    const last = seen[e.code];
    if (last != null) {
      // 거래일 차이 — 캘린더 일자 차이로 근사. 실제로 10거래일 ≈ 14 캘린더일
      const lastDate = new Date(last.slice(0,4)+'-'+last.slice(4,6)+'-'+last.slice(6,8));
      const curDate = new Date(e.date.slice(0,4)+'-'+e.date.slice(4,6)+'-'+e.date.slice(6,8));
      const days = Math.round((curDate - lastDate) / 86400000);
      if (days <= 14) return; // 같은 episode로 간주 → 스킵
    }
    seen[e.code] = e.date;
    out.push(e);
  });
  return out;
}

// BMS-H 자동 도출
function decideBmsH(groupStats) {
  const candidates = ['A','B','C','D','F','G','H','I','J','L'].filter(k => {
    const s = groupStats[k];
    return s && s.count >= 30 && s.avgRet10 != null;
  });
  if (candidates.length === 0) return null;

  // 각 지표 정규화 후 종합 점수
  const score = (k) => {
    const s = groupStats[k];
    return (s.avgRet10 || 0) * 0.30
         + (s.mfe10 || 0) * 0.20
         + (s.posRate10 || 0) * 30 // 0~1 → 0~30
         + (s.hit10Rate || 0) * 20
         - Math.abs(s.mae10 || 0) * 0.15
         + (s.returnToRiskRatio || 0) * 5;
  };

  const ranked = candidates.map(k => ({
    key: k,
    label: config.GROUP_DEFINITIONS[k].label,
    desc: config.GROUP_DEFINITIONS[k].desc,
    composite: score(k),
    stats: groupStats[k],
  })).sort((a, b) => b.composite - a.composite);

  return { winner: ranked[0], ranking: ranked };
}

// 후보군별 랭킹 (6가지 기준)
function buildRankings(groupStats) {
  const validGroups = Object.keys(groupStats).filter(k => groupStats[k].count >= 30);
  const ranked = (key, asc = false) => {
    return [...validGroups].sort((a, b) => {
      const va = groupStats[a][key];
      const vb = groupStats[b][key];
      if (va == null) return 1;
      if (vb == null) return -1;
      return asc ? va - vb : vb - va;
    }).slice(0, 5).map(k => ({ key: k, label: config.GROUP_DEFINITIONS[k].label, value: groupStats[k][key] }));
  };
  return {
    avgRet10: ranked('avgRet10'),
    mfe10: ranked('mfe10'),
    posRate10: ranked('posRate10'),
    hit10Rate: ranked('hit10Rate'),
    mae10Asc: ranked('mae10', true), // MAE는 음수, 작은 절댓값 = 0에 가까움 → 큰 값(0에 가까운 음수)이 좋음. 실제로 desc.
    returnToRiskRatio: ranked('returnToRiskRatio'),
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('BMS Forward Performance Backtest');
  console.log('═'.repeat(80));
  console.log(`기간: ${fmtDate(config.ANALYSIS_START)} ~ ${fmtDate(config.ANALYSIS_END)}`);
  if (config.SAMPLE_DAYS) console.log(`⚠ 테스트 모드: 처음 ${config.SAMPLE_DAYS} 거래일만 분석`);
  console.log();

  // 1. baseline 로드
  if (!fs.existsSync(REPORT_JSON)) {
    console.error('big-move-similarity-report.json이 없습니다. 먼저 node big-move-similarity-report.js 실행.');
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(REPORT_JSON, 'utf-8'));
  const baselines = report.baselines;
  const latestDate = report.meta.latestTradingDate;
  console.log(`baselines 로드: episode ${report.meta.totalEpisodes}, latestDate ${fmtDate(latestDate)}`);

  // 2. stocks 메타
  const stockMap = loadStocks();

  // 3. 차트 메모리 로드
  console.log('차트 로드 중...');
  const charts = loadAllCharts();
  console.log(`  ${Object.keys(charts).length}개 차트 로드`);

  // 4. universe 결정
  const universe = [];
  Object.keys(charts).forEach(code => {
    const meta = stockMap[code];
    if (!meta) return;
    if (isExcludedProduct(meta.name)) return;
    if ((meta.marketValue || 0) < config.MIN_MARKET_CAP) return;
    universe.push({ code, name: meta.name, market: meta.market, marketCap: meta.marketValue });
  });
  console.log(`universe: ${universe.length}개`);

  // 5. flow 로드 (universe 종목만)
  console.log('flow 데이터 로드 중...');
  const flowMap = loadAllFlows(universe.map(u => u.code));
  console.log(`  ${Object.keys(flowMap).length}개 flow 로드`);

  // 6. 거래일 추출
  const dateSet = new Set();
  Object.values(charts).forEach(rows => {
    rows.forEach(r => {
      if (r.date >= config.ANALYSIS_START && r.date <= config.ANALYSIS_END) dateSet.add(r.date);
    });
  });
  let tradingDays = [...dateSet].sort();
  if (config.SAMPLE_DAYS) tradingDays = tradingDays.slice(0, config.SAMPLE_DAYS);
  console.log(`거래일: ${tradingDays.length}일 (${fmtDate(tradingDays[0])} ~ ${fmtDate(tradingDays[tradingDays.length-1])})`);

  // 7. 매 거래일 분석
  console.log('\nrolling 분석 시작...');
  const allEvents = [];
  const startTime = Date.now();
  tradingDays.forEach((d, dayIdx) => {
    universe.forEach(u => {
      const fullRows = charts[u.code];
      if (!fullRows) return;
      const idx = findIdxByDate(fullRows, d);
      if (idx < 0) return;  // 그날 거래 없음
      const flowAll = flowMap[u.code] || [];
      const flowRows = flowAll.filter(r => r.date <= d);
      const result = analyzeStockOnDay(fullRows, idx, u.marketCap, flowRows, baselines);
      if (!result) return;
      allEvents.push({
        date: d,
        code: u.code,
        name: u.name,
        market: u.market,
        marketCap: u.marketCap,
        idx, // 후처리용
        ...result,
      });
    });
    if ((dayIdx + 1) % 10 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const eta = (elapsed / (dayIdx + 1)) * (tradingDays.length - dayIdx - 1);
      process.stdout.write(`\r${d} (${dayIdx+1}/${tradingDays.length}) events=${allEvents.length} 경과 ${elapsed.toFixed(0)}s ETA ${eta.toFixed(0)}s`);
    }
  });
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\nrolling 완료: ${allEvents.length} events, ${elapsed.toFixed(0)}초 소요`);

  // 8. 미래 D+N 성과 계산
  console.log('forward returns 계산 중...');
  allEvents.forEach(e => {
    e.forward = computeForwardReturns(charts[e.code], e.idx, e.todayClose);
    delete e.idx;
  });

  // 9. 후보군 분류
  allEvents.forEach(e => { e.groups = classifyEvent(e); });

  // 10. event 기준 통계
  console.log('event 기준 집계 중...');
  const eventStats = {};
  Object.keys(config.GROUP_DEFINITIONS).forEach(k => {
    eventStats[k] = aggregate(allEvents, k);
  });

  // 11. episode 기준 (10거래일 cooldown)
  console.log('episode 기준 집계 중...');
  const episodeEvents = makeEpisodes(allEvents);
  const episodeStats = {};
  Object.keys(config.GROUP_DEFINITIONS).forEach(k => {
    episodeStats[k] = aggregate(episodeEvents, k);
  });

  // 12. 랭킹 + BMS-H 자동 도출 (episode 기준 우선)
  const rankings = buildRankings(episodeStats);
  const bmsH = decideBmsH(episodeStats);

  // 13. 5/4 스냅샷 (latestDate가 4/30이면 5/4 데이터 있는지 확인)
  const snapshot = computeSnapshotMay4(allEvents, charts, latestDate);

  // 14. QVA H그룹 비교 — 별도 데이터 없으면 group H를 'BMS QVA 변형'으로 대체
  const qvaHComparison = buildQvaHComparison(episodeStats, episodeEvents);

  // 15. 후보군별 sample events (HTML 표시용)
  const sampleEvents = {};
  Object.keys(config.GROUP_DEFINITIONS).forEach(k => {
    const filtered = episodeEvents.filter(e => (e.groups || []).includes(k));
    // 최근 일자 + 가장 강한 forward 성과 순
    sampleEvents[k] = filtered
      .sort((a, b) => (b.forward?.d10 || -999) - (a.forward?.d10 || -999))
      .slice(0, 30)
      .map(e => ({
        date: e.date,
        code: e.code,
        name: e.name,
        market: e.market,
        bmsScore: e.bmsScore,
        todayClose: e.todayClose,
        ret10: e.forward?.d10,
        ret20: e.forward?.d20,
        mfe10: e.forward?.mfe10,
        mae10: e.forward?.mae10,
        qvaHL: e.qvaHL,
        qvaEv: e.qvaEv,
        recentVVI: e.recentVVI,
      }));
  });

  // 16. 필수 검증 종목 (와이엠티, 한온시스템) — 4/30에 어떤 그룹에 들었나
  const checks = ['251370', '018880'].map(code => {
    const event = allEvents.find(e => e.code === code && e.date === latestDate);
    if (!event) {
      // BMS Score < 65일 수도. 4/30 BMS 보드에서 가져오기
      const bmsBoard = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'bms-board.json'))); } catch (_) { return null; }
      })();
      if (bmsBoard) {
        for (const k of Object.keys(bmsBoard.sections)) {
          const f = bmsBoard.sections[k].find(c => c.code === code);
          if (f) {
            return { code, found: true, fromBoard: true, name: f.name, bmsScore: f.normalizedScore, label: f.label, position: f.positionLabel };
          }
        }
      }
      return { code, found: false };
    }
    return {
      code,
      found: true,
      name: event.name,
      bmsScore: event.bmsScore,
      groups: event.groups,
      qvaHL: event.qvaHL,
      qvaEv: event.qvaEv,
      recentVVI: event.recentVVI,
      todayClose: event.todayClose,
    };
  });

  // 17. JSON 출력
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      analysisStart: config.ANALYSIS_START,
      analysisEnd: config.ANALYSIS_END,
      sampleMode: !!config.SAMPLE_DAYS,
      tradingDaysAnalyzed: tradingDays.length,
      universeSize: universe.length,
      totalEvents: allEvents.length,
      episodeEvents: episodeEvents.length,
      latestTradingDate: latestDate,
      executionSeconds: Math.round(elapsed),
    },
    config: {
      HORIZONS: config.HORIZONS,
      EPISODE_COOLDOWN: config.EPISODE_COOLDOWN,
      MIN_BMS_SCORE: config.MIN_BMS_SCORE,
      GROUP_DEFINITIONS: config.GROUP_DEFINITIONS,
    },
    eventStats,
    episodeStats,
    rankings,
    bmsH,
    qvaHComparison,
    snapshot,
    sampleEvents,
    requiredChecks: checks,
  };

  fs.writeFileSync(path.join(ROOT, 'bms-forward-performance-report.json'), JSON.stringify(out, null, 2));
  console.log(`\nJSON 저장: bms-forward-performance-report.json (${(JSON.stringify(out).length/1024).toFixed(0)}KB)`);

  fs.writeFileSync(path.join(ROOT, 'bms-forward-performance-report.html'), generateHTML(out));
  console.log(`HTML 저장: bms-forward-performance-report.html`);

  // 콘솔 요약
  console.log('\n' + '═'.repeat(80));
  console.log('후보군별 episode 기준 D+10 평균 수익률:');
  Object.keys(config.GROUP_DEFINITIONS).forEach(k => {
    const s = episodeStats[k];
    if (s.count === 0) {
      console.log(`  ${k} (${config.GROUP_DEFINITIONS[k].label}): 0건`);
      return;
    }
    const r = s.avgRet10 != null ? `${s.avgRet10.toFixed(2)}%` : '-';
    const hit = s.hit10Rate != null ? `${(s.hit10Rate*100).toFixed(0)}%` : '-';
    console.log(`  ${k} ${config.GROUP_DEFINITIONS[k].label.padEnd(22)} n=${String(s.count).padStart(4)} D+10 ${r.padStart(7)} +10%도달 ${hit}`);
  });

  if (bmsH) {
    console.log(`\n🏆 BMS-H 후보군: ${bmsH.winner.label} — ${bmsH.winner.desc}`);
    const w = bmsH.winner.stats;
    console.log(`   n=${w.count}, D+10=${w.avgRet10?.toFixed(2)}%, MFE10=${w.mfe10?.toFixed(2)}%, MAE10=${w.mae10?.toFixed(2)}%, +10%도달=${(w.hit10Rate*100).toFixed(0)}%`);
  }

  // 와이엠티/한온시스템 검증
  console.log('\n필수 검증:');
  checks.forEach(c => {
    if (!c.found) { console.log(`  ${c.code}: 후보 없음`); return; }
    if (c.fromBoard) {
      console.log(`  ${c.name}(${c.code}): BMS=${c.bmsScore} ${c.label} (${c.position}) — 백테스트 events에는 없으나 4/30 보드에 있음`);
    } else {
      console.log(`  ${c.name}(${c.code}): BMS=${c.bmsScore} groups=[${c.groups.join(',')}] qvaHL=${c.qvaHL||'-'} qvaEv=${c.qvaEv||'-'} VVI=${c.recentVVI?'D+'+c.recentVVI.daysAgo:'-'}`);
    }
  });
}

// ─────────────────────── 5/4 스냅샷 ───────────────────────

function computeSnapshotMay4(allEvents, charts, latestDate) {
  // latestDate = 4/30. 5/4 데이터는 차트에 없을 수 있음.
  const may4 = '20260504';
  const events4_30 = allEvents.filter(e => e.date === latestDate);
  const out = {
    baseDate: latestDate,
    snapshotDate: may4,
    candidates: [],
    available: false,
  };
  events4_30.forEach(e => {
    const rows = charts[e.code];
    if (!rows) return;
    const idx5 = rows.findIndex(r => r.date === may4);
    let snapshot = null;
    if (idx5 >= 0) {
      const r = rows[idx5];
      snapshot = {
        close: r.close,
        high: r.high,
        low: r.low,
        intraReturn: (r.close / e.todayClose - 1) * 100,
        highReturn: (r.high / e.todayClose - 1) * 100,
        available: true,
      };
      out.available = true;
    }
    out.candidates.push({
      code: e.code,
      name: e.name,
      market: e.market,
      bmsScore: e.bmsScore,
      groups: e.groups,
      base4_30Close: e.todayClose,
      may4: snapshot,
    });
  });
  // 정렬: BMS 점수 높은 순
  out.candidates.sort((a, b) => b.bmsScore - a.bmsScore);
  return out;
}

// ─────────────────────── QVA H그룹 비교 ───────────────────────

function buildQvaHComparison(episodeStats, episodeEvents) {
  // 기존 QVA H그룹 정의가 명확하지 않으므로:
  // 1) qva-watchlist-board.json 의 'breakoutSuccess' / 'qvaStrong' 같은 후보 활용 시도
  // 2) 우리 events 안에서 'qvaHL >= 80' 만족 events를 'QVA H그룹 (재정의)'으로 비교
  const out = {
    qvaHGroup: null,
    bmsH: null,
    intersection: null,
  };

  // QVA H그룹 (재정의) = qvaHL >= 80
  const qvaHEvents = episodeEvents.filter(e => e.qvaHL != null && e.qvaHL >= 80);
  if (qvaHEvents.length > 0) {
    out.qvaHGroup = aggregate(qvaHEvents.map(e => ({...e, groups: ['QVAH']})), 'QVAH');
  }

  // BMS-H = 그룹 H (BMS + QVA 변형) - 기본
  out.bmsH = episodeStats.H;

  // 교집합 = BMS≥80 AND QVA-HL≥80 AND VVI 발화 = 그룹 L
  out.intersection = episodeStats.L;

  return out;
}

// ─────────────────────── HTML 생성 ───────────────────────

function generateHTML(data) {
  // generateHTML은 분리해서 가독성 유지
  const TPL = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BMS Forward Performance Backtest</title>
<style>
  * { box-sizing: border-box; }
  body { background:#0f172a; color:#e2e8f0; font-family:'Pretendard',-apple-system,sans-serif; margin:0; padding:20px; line-height:1.5; }
  .wrap { max-width:1500px; margin:0 auto; }
  h1 { font-size:24px; color:#f1f5f9; margin:0 0 8px 0; }
  h2 { font-size:18px; color:#f1f5f9; margin:24px 0 8px 0; padding-bottom:6px; border-bottom:1px solid #334155; }
  h3 { font-size:15px; color:#cbd5e1; margin:16px 0 6px 0; }
  .subtitle { color:#94a3b8; font-size:13px; margin-bottom:14px; }
  .info-box { background:#1e293b; border-left:3px solid #38bdf8; padding:14px 18px; margin:14px 0; border-radius:6px; font-size:13px; color:#cbd5e1; }
  .info-box p { margin:6px 0; }
  .info-box strong { color:#f1f5f9; }
  .warn-box { background:#1e293b; border-left:3px solid #fbbf24; padding:12px 16px; margin:14px 0; border-radius:6px; color:#fcd34d; font-size:13px; }
  .winner-box { background:linear-gradient(135deg,#1e293b,#0e1a2e); border-left:4px solid #10b981; padding:18px 22px; margin:14px 0; border-radius:8px; }
  .winner-box .label { color:#10b981; font-size:13px; font-weight:600; }
  .winner-box h3 { color:#f1f5f9; margin:6px 0 10px 0; font-size:18px; }
  .winner-box .stats { display:flex; gap:16px; flex-wrap:wrap; font-size:13px; }
  .winner-box .stats div { background:#0f172a; padding:6px 12px; border-radius:6px; border:1px solid #334155; }
  .winner-box .stats strong { color:#f1f5f9; }
  table { width:100%; border-collapse:collapse; background:#1e293b; border-radius:6px; overflow:hidden; font-size:12px; margin:8px 0; }
  thead { background:#0f172a; }
  th { padding:8px 10px; text-align:left; color:#94a3b8; font-weight:600; border-bottom:1px solid #334155; white-space:nowrap; }
  td { padding:7px 10px; border-bottom:1px solid #1e293b; color:#cbd5e1; vertical-align:top; }
  td.r { text-align:right; }
  tbody tr:hover { background:#252e3f; }
  .pos { color:#10b981; }
  .neg { color:#ef4444; }
  .muted { color:#64748b; }
  .market-K { color:#3b82f6; font-weight:600; }
  .market-Q { color:#f59e0b; font-weight:600; }
  .nav { display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; font-size:13px; }
  .nav a { color:#38bdf8; text-decoration:none; padding:5px 10px; background:#1e293b; border-radius:4px; border:1px solid #334155; }
  details { background:#1e293b; border:1px solid #334155; border-radius:6px; padding:8px 14px; margin:8px 0; }
  details summary { cursor:pointer; color:#f1f5f9; font-weight:600; padding:4px 0; }
  .table-scroll { overflow-x:auto; }
  .qa-box { background:#1e293b; border-left:3px solid #a855f7; padding:12px 16px; margin:8px 0; border-radius:6px; font-size:13px; color:#cbd5e1; }
  .qa-box .q { color:#a855f7; font-weight:600; margin-bottom:4px; }
  .badge { display:inline-block; padding:1px 6px; border-radius:6px; font-size:10px; font-weight:600; margin-right:3px; white-space:nowrap; }
  .badge.match { background:#0ea5e9; color:#fff; }
  .badge.cross { background:#7c3aed; color:#fff; }
  .footer { color:#64748b; font-size:11px; margin-top:30px; padding-top:14px; border-top:1px solid #334155; }
  .legend { font-size:11px; color:#64748b; margin:6px 0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>BMS Forward Performance Backtest</h1>
  <div class="subtitle" id="subtitle"></div>
  <div class="nav">
    <a href="#summary">개요</a>
    <a href="#eventTable">후보군 비교</a>
    <a href="#rankings">랭킹</a>
    <a href="#bmsH">BMS-H 도출</a>
    <a href="#qvaH">QVA H 비교</a>
    <a href="#snapshot">5/4 스냅샷</a>
    <a href="#qa">최종 답변</a>
    <a href="#samples">샘플 events</a>
    <a href="/bms-board">→ BMS 보드</a>
    <a href="/big-move-similarity-report">→ BMS 분석 보고서</a>
  </div>

  <div class="info-box">
    <p>이 보고서는 BMS가 전일 장마감 기준으로 뽑은 후보군이 이후 실제로 어떤 성과를 보였는지 검증합니다.</p>
    <p>BMS는 과거 +40% 이상 상승 종목의 시작 조건과 현재 종목의 유사도를 보는 <strong>실험 모델</strong>이며, 본 보고서는 어떤 BMS 후보군이 실제 후속 상승률이 높았는지 찾기 위한 검증용입니다.</p>
    <p style="color:#fbbf24;margin-top:8px;"><strong>매수 추천이 아닙니다.</strong></p>
  </div>

  <div class="warn-box">⚠️ 미래 데이터 누수 방지: 각 기준일의 BMS 점수와 분류는 그 기준일까지의 데이터만 사용. 미래 D+N 성과는 사후 측정 단계에서만 사용됩니다.</div>

  <h2 id="summary">📋 개요</h2>
  <div id="overview"></div>

  <h2 id="eventTable">📊 후보군 비교 (12종)</h2>
  <h3>Episode 기준 (같은 종목 10거래일 cooldown 후 첫 신호만)</h3>
  <div class="legend">최종 판단은 episode 기준을 우선합니다. event 기준은 같은 종목 반복 신호 모두 포함.</div>
  <div class="table-scroll" id="episodeTableWrap"></div>

  <h3 style="margin-top:20px">Event 기준 (반복 신호 모두 포함)</h3>
  <details>
    <summary>event 기준 표 펼치기</summary>
    <div class="table-scroll" id="eventTableWrap"></div>
  </details>

  <h2 id="rankings">🏅 후보군 랭킹</h2>
  <div class="subtitle">episode 기준, n ≥ 30 후보군만</div>
  <div id="rankingsWrap"></div>

  <h2 id="bmsH">🏆 BMS-H 후보군 자동 도출</h2>
  <div id="bmsHWrap"></div>

  <h2 id="qvaH">🔄 QVA H그룹 vs BMS-H 비교</h2>
  <div id="qvaHWrap"></div>

  <h2 id="snapshot">📸 4/30 → 5/4 운영 스냅샷</h2>
  <div class="subtitle">정식 백테스트가 아닙니다. 4/30 기준 후보가 5/4 장중 어떻게 반응했는지 확인용.</div>
  <div id="snapshotWrap"></div>

  <h2 id="qa">❓ 최종 질문 자동 답변</h2>
  <div id="qaWrap"></div>

  <h2 id="samples">📑 후보군별 샘플 events</h2>
  <div class="subtitle">각 후보군에서 D+10 수익률 상위 30개 (episode 기준)</div>
  <div id="samplesWrap"></div>

  <div class="footer">
    생성: <span id="genTime"></span> · BMS Forward Performance Backtest · 매수 추천 아님 · 모델 검증·실험 보고서
  </div>
</div>

<script>
const DATA = __JSON_DATA__;

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d||'-'); }
function fmtPct(n, sign) {
  if (n == null || !isFinite(n)) return '<span class="muted">-</span>';
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : 'muted');
  const s = (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
  return '<span class="'+cls+'">'+s+'</span>';
}
function fmtNum(n) { return n != null ? Math.round(n).toLocaleString() : '-'; }
function fmtRate(n) { return n != null ? (n*100).toFixed(0)+'%' : '-'; }
function num(n, d) { return n != null && isFinite(n) ? n.toFixed(d != null ? d : 2) : '-'; }
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }

// 헤더
const m = DATA.meta;
document.getElementById('subtitle').textContent =
  '기간 ' + fmtDate(m.analysisStart) + ' ~ ' + fmtDate(m.analysisEnd) +
  ' · 거래일 ' + m.tradingDaysAnalyzed +
  ' · universe ' + m.universeSize +
  ' · events ' + m.totalEvents.toLocaleString() +
  ' (episode ' + m.episodeEvents.toLocaleString() + ')' +
  (m.sampleMode ? ' · ⚠ SAMPLE 모드' : '') +
  ' · 실행 ' + m.executionSeconds + '초';
document.getElementById('genTime').textContent = m.generatedAt.slice(0,19).replace('T',' ');

// 개요
document.getElementById('overview').innerHTML =
  '<div class="info-box">' +
  '<p>분석 기간 <strong>' + fmtDate(m.analysisStart) + ' ~ ' + fmtDate(m.analysisEnd) + '</strong> · ' +
  '거래일 <strong>' + m.tradingDaysAnalyzed + '일</strong> · ' +
  'universe <strong>' + m.universeSize + '개 종목</strong></p>' +
  '<p>총 <strong>' + m.totalEvents.toLocaleString() + '개</strong> events (BMS Score ≥ ' + DATA.config.MIN_BMS_SCORE + '), ' +
  'episode 기준 <strong>' + m.episodeEvents.toLocaleString() + '개</strong></p>' +
  '<p>baseline 기준일 <strong>' + fmtDate(m.latestTradingDate) + '</strong></p>' +
  '</div>';

// 후보군 비교 표
function renderGroupTable(stats) {
  const groups = Object.keys(DATA.config.GROUP_DEFINITIONS);
  const headers = ['그룹','정의','n','종목수','D+1','D+3','D+5','D+10','D+20','D+10>0%','+10도달','-10도달','MFE10','MAE10','MFE20','R/R'];
  let html = '<table><thead><tr>' + headers.map(h => '<th>'+h+'</th>').join('') + '</tr></thead><tbody>';
  groups.forEach(k => {
    const def = DATA.config.GROUP_DEFINITIONS[k];
    const s = stats[k] || { count: 0 };
    if (s.count === 0) {
      html += '<tr><td><strong>'+k+'</strong></td><td class="muted">'+def.label+'</td><td colspan="14" class="muted r">사례 없음</td></tr>';
      return;
    }
    html += '<tr>' +
      '<td><strong>'+k+'</strong> '+def.label+'</td>' +
      '<td class="muted" style="font-size:11px">'+def.desc+'</td>' +
      '<td class="r">'+s.count+'</td>' +
      '<td class="r">'+s.uniqueStocks+'</td>' +
      '<td class="r">'+fmtPct(s.avgRet1, true)+'</td>' +
      '<td class="r">'+fmtPct(s.avgRet3, true)+'</td>' +
      '<td class="r">'+fmtPct(s.avgRet5, true)+'</td>' +
      '<td class="r">'+fmtPct(s.avgRet10, true)+'</td>' +
      '<td class="r">'+fmtPct(s.avgRet20, true)+'</td>' +
      '<td class="r">'+fmtRate(s.posRate10)+'</td>' +
      '<td class="r">'+fmtRate(s.hit10Rate)+'</td>' +
      '<td class="r">'+fmtRate(s.hitNeg10Rate)+'</td>' +
      '<td class="r">'+fmtPct(s.mfe10, true)+'</td>' +
      '<td class="r">'+fmtPct(s.mae10)+'</td>' +
      '<td class="r">'+fmtPct(s.mfe20, true)+'</td>' +
      '<td class="r">'+(s.returnToRiskRatio != null ? num(s.returnToRiskRatio, 2) : '-')+'</td>' +
    '</tr>';
  });
  html += '</tbody></table>';
  return html;
}
document.getElementById('episodeTableWrap').innerHTML = renderGroupTable(DATA.episodeStats);
document.getElementById('eventTableWrap').innerHTML = renderGroupTable(DATA.eventStats);

// 랭킹
const rk = DATA.rankings || {};
function renderRank(title, arr, fmt) {
  if (!arr || arr.length === 0) return '<div class="muted">데이터 없음</div>';
  return '<div style="margin:6px 0"><strong style="color:#cbd5e1">'+title+'</strong><ol style="margin:4px 0 0 24px;font-size:13px">' +
    arr.map(r => '<li>'+r.label+' — <strong>'+fmt(r.value)+'</strong></li>').join('') +
    '</ol></div>';
}
document.getElementById('rankingsWrap').innerHTML =
  renderRank('1. D+10 평균 수익률', rk.avgRet10, v => fmtPct(v, true).replace(/<[^>]+>/g,'')) +
  renderRank('2. MFE10 (D+10 최대 도달폭)', rk.mfe10, v => fmtPct(v, true).replace(/<[^>]+>/g,'')) +
  renderRank('3. D+10 +수익 마감 비율', rk.posRate10, v => fmtRate(v)) +
  renderRank('4. +10% 도달률', rk.hit10Rate, v => fmtRate(v)) +
  renderRank('5. MAE10 가장 양호 (절댓값 작은)', rk.mae10Asc, v => fmtPct(v).replace(/<[^>]+>/g,'')) +
  renderRank('6. Return/Risk Ratio', rk.returnToRiskRatio, v => num(v, 2));

// BMS-H 자동 도출
const bh = DATA.bmsH;
if (bh && bh.winner) {
  const w = bh.winner;
  const s = w.stats;
  let html = '<div class="winner-box">' +
    '<div class="label">자동 도출된 BMS-H 후보군</div>' +
    '<h3>'+w.label+'</h3>' +
    '<div class="muted" style="margin-bottom:10px">'+w.desc+'</div>' +
    '<div class="stats">' +
      '<div>n <strong>'+s.count+'</strong></div>' +
      '<div>D+10 <strong>'+fmtPct(s.avgRet10, true)+'</strong></div>' +
      '<div>D+20 <strong>'+fmtPct(s.avgRet20, true)+'</strong></div>' +
      '<div>MFE10 <strong>'+fmtPct(s.mfe10, true)+'</strong></div>' +
      '<div>MAE10 <strong>'+fmtPct(s.mae10)+'</strong></div>' +
      '<div>+10% 도달 <strong>'+fmtRate(s.hit10Rate)+'</strong></div>' +
      '<div>R/R <strong>'+(s.returnToRiskRatio != null ? num(s.returnToRiskRatio, 2) : '-')+'</strong></div>' +
    '</div>' +
  '</div>';
  html += '<details><summary>전체 후보군 종합 점수 순위</summary><table><thead><tr><th>순위</th><th>그룹</th><th>정의</th><th>종합점수</th><th>n</th><th>D+10</th><th>MFE10</th><th>MAE10</th></tr></thead><tbody>';
  bh.ranking.forEach((r, i) => {
    html += '<tr><td>'+(i+1)+'</td><td><strong>'+r.key+'</strong> '+r.label+'</td><td class="muted" style="font-size:11px">'+r.desc+'</td>' +
      '<td class="r">'+num(r.composite, 2)+'</td>' +
      '<td class="r">'+r.stats.count+'</td>' +
      '<td class="r">'+fmtPct(r.stats.avgRet10, true)+'</td>' +
      '<td class="r">'+fmtPct(r.stats.mfe10, true)+'</td>' +
      '<td class="r">'+fmtPct(r.stats.mae10)+'</td>' +
    '</tr>';
  });
  html += '</tbody></table></details>';
  document.getElementById('bmsHWrap').innerHTML = html;
} else {
  document.getElementById('bmsHWrap').innerHTML = '<div class="muted">분석 데이터 부족</div>';
}

// QVA H 비교
const qh = DATA.qvaHComparison;
if (qh) {
  const compare = (label, s) => {
    if (!s || s.count === 0) return '<tr><td>'+label+'</td><td colspan="6" class="muted">데이터 없음</td></tr>';
    return '<tr><td>'+label+'</td>' +
      '<td class="r">'+s.count+'</td>' +
      '<td class="r">'+fmtPct(s.avgRet10, true)+'</td>' +
      '<td class="r">'+fmtPct(s.avgRet20, true)+'</td>' +
      '<td class="r">'+fmtPct(s.mfe10, true)+'</td>' +
      '<td class="r">'+fmtPct(s.mfe20, true)+'</td>' +
      '<td class="r">'+fmtPct(s.mae10)+'</td>' +
      '<td class="r">'+fmtRate(s.hit10Rate)+'</td>' +
      '<td class="r">'+fmtRate(s.hit20Rate)+'</td>' +
    '</tr>';
  };
  let html = '<div class="legend">QVA H그룹은 본 백테스트에서 \"qvaHL ≥ 80\"으로 재정의했습니다 (events 기반).</div>';
  html += '<table><thead><tr><th>그룹</th><th>n</th><th>D+10</th><th>D+20</th><th>MFE10</th><th>MFE20</th><th>MAE10</th><th>+10%</th><th>+20%</th></tr></thead><tbody>';
  html += compare('QVA H그룹 (qvaHL≥80)', qh.qvaHGroup);
  html += compare('BMS-H (그룹 H)', qh.bmsH);
  html += compare('교집합 (그룹 L = BMS+QVA변형+VVI)', qh.intersection);
  html += '</tbody></table>';
  document.getElementById('qvaHWrap').innerHTML = html;
}

// 5/4 스냅샷
const sn = DATA.snapshot;
if (sn) {
  let html = '';
  if (!sn.available) {
    html += '<div class="warn-box">5/4 데이터가 없거나 매우 일부 종목만 있습니다. 정식 백테스트가 아닌 운영 스냅샷이라 데이터 의존적입니다.</div>';
  }
  html += '<div class="legend">기준일 ' + fmtDate(sn.baseDate) + ' BMS 후보 (스코어 65+) → ' + fmtDate(sn.snapshotDate) + ' 장중 반응</div>';
  // 필수 검증 종목 강조
  const required = (DATA.requiredChecks || []).filter(c => c.found);
  if (required.length) {
    html += '<h3>필수 검증 종목</h3>';
    required.forEach(c => {
      const sc = sn.candidates.find(x => x.code === c.code);
      const may4 = sc && sc.may4 ? sc.may4 : null;
      html += '<div class="qa-box">';
      html += '<div class="q">'+c.name+' ('+c.code+')</div>';
      if (c.fromBoard) {
        html += '<div>BMS '+c.bmsScore+' · '+c.label+' · 위치 '+c.position+'</div>';
      } else {
        html += '<div>BMS '+c.bmsScore+' · 그룹 ['+(c.groups||[]).join(',')+'] · QVA-HL '+(c.qvaHL||'-')+' · QVA-Ev '+(c.qvaEv||'-')+' · 최근 VVI '+(c.recentVVI?'D+'+c.recentVVI.daysAgo+' score '+c.recentVVI.score:'없음')+'</div>';
      }
      if (may4) {
        html += '<div style="margin-top:4px">5/4 종가 ' + fmtNum(may4.close) + '원 · 종가 수익률 ' + fmtPct(may4.intraReturn, true) + ' · 장중 고가 수익률 ' + fmtPct(may4.highReturn, true) + '</div>';
      } else {
        html += '<div class="muted" style="margin-top:4px">5/4 데이터 없음</div>';
      }
      html += '</div>';
    });
  }
  // 전체 후보 표
  const withMay4 = sn.candidates.filter(c => c.may4 && c.may4.available);
  if (withMay4.length > 0) {
    html += '<h3>5/4 데이터 있는 4/30 BMS 후보 (' + withMay4.length + '개)</h3>';
    html += '<div class="table-scroll"><table><thead><tr><th>종목</th><th>코드</th><th>BMS</th><th>그룹</th><th>4/30 종가</th><th>5/4 종가</th><th>장중 수익률</th><th>고가 수익률</th></tr></thead><tbody>';
    withMay4.slice(0, 100).forEach(c => {
      html += '<tr>' +
        '<td><span class="'+marketCls(c.market)+'">'+c.name+'</span></td>' +
        '<td>'+c.code+'</td>' +
        '<td class="r">'+num(c.bmsScore, 1)+'</td>' +
        '<td>'+(c.groups||[]).join(',')+'</td>' +
        '<td class="r">'+fmtNum(c.base4_30Close)+'</td>' +
        '<td class="r">'+fmtNum(c.may4.close)+'</td>' +
        '<td class="r">'+fmtPct(c.may4.intraReturn, true)+'</td>' +
        '<td class="r">'+fmtPct(c.may4.highReturn, true)+'</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
  }
  document.getElementById('snapshotWrap').innerHTML = html;
}

// 7개 최종 질문 자동 답변
function answerQuestions() {
  const es = DATA.episodeStats;
  const valid = (k) => es[k] && es[k].count >= 30;
  const r = (k) => valid(k) && es[k].avgRet10 != null ? es[k].avgRet10.toFixed(2)+'%' : 'n/a';
  const h = (k) => valid(k) && es[k].hit10Rate != null ? (es[k].hit10Rate*100).toFixed(0)+'%' : 'n/a';
  const compare = (a, b, metric) => {
    if (!valid(a) || !valid(b) || es[a][metric] == null || es[b][metric] == null) return null;
    return es[a][metric] - es[b][metric];
  };

  const answers = [];

  // Q1: BMS 점수만 높은 후보가 실제로 좋은가?
  const aRet = valid('A') ? es['A'].avgRet10 : null;
  answers.push({
    q: 'Q1. BMS 점수만 높은 후보(BMS≥80)가 실제로 좋은가?',
    a: aRet != null
      ? 'D+10 평균 ' + r('A') + ' · +10% 도달 ' + h('A') + ' (n=' + (es.A.count||0) + '). ' +
        (aRet > 1 ? '평균 양수로 의미 있는 신호.' : (aRet > 0 ? '평균 양수지만 강도 약함.' : '평균 음수 — 단독 기준은 부족.'))
      : '데이터 부족 (sample 모드 또는 분석 기간이 짧음).'
  });

  // Q2: BMS + QVA 변형 조합이 더 좋은가?
  const diffH = compare('H', 'A', 'avgRet10');
  answers.push({
    q: 'Q2. BMS + QVA 변형 조합(그룹 H)이 BMS 단독(A)보다 더 좋은가?',
    a: diffH != null
      ? '그룹 H D+10 ' + r('H') + ' vs A ' + r('A') + ' (차이 ' + (diffH >= 0 ? '+' : '') + diffH.toFixed(2) + '%p). ' +
        (diffH > 0.5 ? '✅ QVA 변형 결합이 명확히 우위.' : (diffH > 0 ? '⚠ 약간 우위.' : '❌ 우위 없음.'))
      : '데이터 부족.'
  });

  // Q3: BMS + 거래대금 폭발 조합 (J)
  const diffJ = compare('J', 'A', 'avgRet10');
  answers.push({
    q: 'Q3. BMS + 거래대금 폭발 + 매물대 낮음(J) 조합은 더 좋은가?',
    a: diffJ != null
      ? '그룹 J D+10 ' + r('J') + ' vs A ' + r('A') + ' (차이 ' + (diffJ >= 0 ? '+' : '') + diffJ.toFixed(2) + '%p). ' +
        (diffJ > 0.5 ? '✅ 거래대금 폭발 결합이 명확히 우위.' : (diffJ > 0 ? '⚠ 약간 우위.' : '❌ 우위 없음.'))
      : '데이터 부족.'
  });

  // Q4: BMS + 최근 VVI (I)
  const diffI = compare('I', 'A', 'avgRet10');
  answers.push({
    q: 'Q4. BMS + 최근 VVI 조합(I)은 더 좋은가?',
    a: diffI != null
      ? '그룹 I D+10 ' + r('I') + ' vs A ' + r('A') + ' (차이 ' + (diffI >= 0 ? '+' : '') + diffI.toFixed(2) + '%p). ' +
        (diffI > 0.5 ? '✅ VVI 후속 조합이 명확히 우위.' : (diffI > 0 ? '⚠ 약간 우위.' : '❌ 우위 없음.'))
      : '데이터 부족.'
  });

  // Q5: 추세 후반(D)는 신선(C)보다 위험한가?
  const diffCD = (valid('C') && valid('D')) ? es['C'].avgRet10 - es['D'].avgRet10 : null;
  answers.push({
    q: 'Q5. 추세 후반 후보(D)도 계속 강한가, 아니면 위험한가? — 신선(C) 대비 비교',
    a: diffCD != null
      ? '신선 C ' + r('C') + ' vs 추세 후반 D ' + r('D') + ' (차이 ' + (diffCD >= 0 ? '+' : '') + diffCD.toFixed(2) + '%p, MAE10: C=' + fmtPct(es['C'].mae10).replace(/<[^>]+>/g,'') + ' / D=' + fmtPct(es['D'].mae10).replace(/<[^>]+>/g,'') + '). ' +
        (diffCD > 0.5 ? '신선 후보가 명확히 우위 → 추세 후반은 추격 위험.' : (diffCD < -0.5 ? '오히려 추세 후반이 강세 — 모멘텀 지속 신호.' : '큰 차이 없음.'))
      : '데이터 부족.'
  });

  // Q6: 눌림 대기(K)는 단기 반등에 유리한가?
  const kRet = valid('K') ? es['K'].avgRet5 : null;
  const kRet10 = valid('K') ? es['K'].avgRet10 : null;
  answers.push({
    q: 'Q6. 눌림 대기형 후보(K)는 단기 반등에 유리한가?',
    a: (kRet != null && kRet10 != null)
      ? 'D+5 ' + (kRet>=0?'+':'') + kRet.toFixed(2) + '% / D+10 ' + (kRet10>=0?'+':'') + kRet10.toFixed(2) + '% · +10% 도달 ' + h('K') + '. ' +
        ((kRet > 0 && kRet > kRet10) ? '단기 반등 우위 — 빠른 반등 후 추세 약화.' : (kRet10 > kRet ? '오히려 D+10이 더 강함 — 추세 회복.' : '강한 반등 신호 부족.'))
      : '데이터 부족.'
  });

  // Q7: BMS-H 결론
  const bh = DATA.bmsH;
  answers.push({
    q: 'Q7. BMS에서 QVA H그룹 같은 최종 강한 후보군은 무엇인가?',
    a: bh && bh.winner
      ? '🏆 <strong>' + bh.winner.label + '</strong> — ' + bh.winner.desc + '. D+10 ' + r(bh.winner.key) + ' · MFE10 ' + fmtPct(bh.winner.stats.mfe10, true).replace(/<[^>]+>/g,'') + ' · +10% 도달 ' + h(bh.winner.key) + '. 표본 수 ' + bh.winner.stats.count + '.'
      : '데이터 부족으로 단정 불가.'
  });

  return answers;
}

const qaAnswers = answerQuestions();
document.getElementById('qaWrap').innerHTML = qaAnswers.map(qa =>
  '<div class="qa-box"><div class="q">'+qa.q+'</div><div>'+qa.a+'</div></div>'
).join('');

// 후보군 샘플 events
const samples = DATA.sampleEvents || {};
let samHtml = '';
Object.keys(DATA.config.GROUP_DEFINITIONS).forEach(k => {
  const arr = samples[k] || [];
  const def = DATA.config.GROUP_DEFINITIONS[k];
  samHtml += '<details><summary><strong>'+k+'</strong> '+def.label+' <span class="muted" style="font-weight:400">('+arr.length+'/30)</span></summary>';
  if (arr.length === 0) {
    samHtml += '<div class="muted" style="padding:8px">사례 없음</div></details>';
    return;
  }
  samHtml += '<div class="legend">'+def.desc+'</div>';
  samHtml += '<div class="table-scroll"><table><thead><tr><th>일자</th><th>종목</th><th>코드</th><th>BMS</th><th>QVA-HL</th><th>QVA-Ev</th><th>VVI</th><th>D+10</th><th>D+20</th><th>MFE10</th><th>MAE10</th></tr></thead><tbody>';
  arr.forEach(s => {
    samHtml += '<tr>' +
      '<td>'+fmtDate(s.date)+'</td>' +
      '<td><span class="'+marketCls(s.market)+'">'+s.name+'</span></td>' +
      '<td>'+s.code+'</td>' +
      '<td class="r">'+num(s.bmsScore, 1)+'</td>' +
      '<td class="r">'+(s.qvaHL != null ? s.qvaHL : '-')+'</td>' +
      '<td class="r">'+(s.qvaEv != null ? s.qvaEv : '-')+'</td>' +
      '<td class="r">'+(s.recentVVI ? 'D+'+s.recentVVI.daysAgo : '-')+'</td>' +
      '<td class="r">'+fmtPct(s.ret10, true)+'</td>' +
      '<td class="r">'+fmtPct(s.ret20, true)+'</td>' +
      '<td class="r">'+fmtPct(s.mfe10, true)+'</td>' +
      '<td class="r">'+fmtPct(s.mae10)+'</td>' +
    '</tr>';
  });
  samHtml += '</tbody></table></div></details>';
});
document.getElementById('samplesWrap').innerHTML = samHtml;
</script>
</body>
</html>`;
  return TPL.replace('__JSON_DATA__', JSON.stringify(data));
}

// ─────────────────────── CLI ───────────────────────

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}

module.exports = { main, generateHTML, classifyEvent, aggregate, makeEpisodes };
