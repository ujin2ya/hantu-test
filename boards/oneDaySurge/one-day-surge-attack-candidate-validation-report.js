#!/usr/bin/env node
/**
 * 1DS — 공격형 보조 후보 조건 백테스트 검증
 *
 * +10% Winner Profile에서 explosiveTop 커버리지 1.7%로 부족하다는 결과 → 공격형
 * 보조 후보 조건이 실제 수익성이 있는지 검증.
 *
 * 검증 조건 10종 (A~J):
 *   A. 기본:        value≥21억, cp≥0.50, drop≥-2.70, open≥0.5, ratio≥3, MH=✓, status∈{READY,FADED}, mc≤5조
 *   B. status 확장: A + WEAK 포함
 *   C. MH 제거:     A − rebreakMorningHigh 필수
 *   D. drop 완화:   A에서 drop ≥ -4.0
 *   E. value 강화:  A에서 value ≥ 50억
 *   F. ratio 강화:  A에서 ratio ≥ 5
 *   G. 시총 1000억~1조:  A + 1e11 ≤ mc < 1e12
 *   H. 시총 1000억~3조:  A + 1e11 ≤ mc < 3e12
 *   I. TEN_REBREAK 동시: A + 가설 TEN_REBREAK 발동
 *   J. FADED_RECOVERY 동시: A + 가설 FADED_RECOVERY 발동
 *
 * 진입 모드 2종 × 전략 5종 (= 10 매트릭스):
 *   진입 모드:
 *     - close:   09:30 close 진입 (즉시 진입)
 *     - rebreak: 09:30 high 재돌파 시 진입 (09:31~10:30 사이 첫 재돌파 분봉)
 *   전략:
 *     S1: TP +5%, SL -2%, 청산 15:20
 *     S2: TP +10%, SL -3%, 청산 15:20
 *     S3: TP +7%, SL -2.5%, 청산 15:20
 *     S4: 10:00 close > 진입가면 종가 보유, 아니면 10:00 청산 (TP/SL 없음)
 *     S5: 09:30 high 재돌파 후 +5/-2 (rebreak 모드 × S1과 동일 — 표시용)
 *
 * 비교 베이스라인:
 *   - explosiveTop  (스캐너 폭발형 — READY + MH + cp≥0.85 + value≥100억)
 *   - READY 전체
 *   - TEN_REBREAK 전체 (가설 발동 종목)
 *   - FADED_RECOVERY 전체
 *
 * 미래 누수 방지:
 *   - 조건 평가는 09:30 시점 메트릭만 사용 (m.* 전체).
 *   - 가설 trigger 평가는 trigger 시점 이전 분봉만 사용 (TEN_REBREAK 09:31~10:30,
 *     FADED_RECOVERY 09:31~10:30 — 재돌파 분봉 자체는 09:31~10:30 윈도우 안 분봉만 봄).
 *   - 진입가 = close 모드는 m.last0930, rebreak 모드는 m.high0930 (재돌파 분봉 시점 가격).
 *   - 성과 측정은 진입 시점 직후 분봉부터.
 *
 * 입력:
 *   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json
 *
 * 출력:
 *   - reports/one-day-surge-attack-candidate-validation-result.{json,html}
 *
 * 사용:
 *   node boards/oneDaySurge/one-day-surge-attack-candidate-validation-report.js
 *   node boards/oneDaySurge/one-day-surge-attack-candidate-validation-report.js --from 2026-04-16 --to 2026-05-14
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');
const REPORTS_DIR = path.join(ROOT, 'reports');
let OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-attack-candidate-validation-result.json');
let OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-attack-candidate-validation-result.html');

const scanner = require('./one-day-surge-0930-scanner');

// ── CLI ──
function parseArgs(argv) {
  const a = { from: null, to: null, days: null, minDirSize: 200 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from' || k === '--from-date') a.from = argv[++i];
    else if (k === '--to' || k === '--to-date') a.to = argv[++i];
    else if (k === '--days') a.days = parseInt(argv[++i], 10) || null;
    else if (k === '--min-dir-size') a.minDirSize = parseInt(argv[++i], 10) || 200;
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node one-day-surge-attack-candidate-validation-report.js [--from-date YYYY-MM-DD] [--to-date YYYY-MM-DD] [--days N]');
      process.exit(0);
    }
  }
  return a;
}
function applyDaysSuffix(days) {
  if (!days || days < 30) return;
  OUT_JSON = path.join(REPORTS_DIR, `one-day-surge-attack-candidate-validation-${days}d-result.json`);
  OUT_HTML = path.join(REPORTS_DIR, `one-day-surge-attack-candidate-validation-${days}d-result.html`);
}

// ── 분봉 유틸 ──
function barsInRange(bars, fromExclusive, toInclusive) {
  return bars.filter((b) => b && b.time && b.close > 0 && b.time > fromExclusive && b.time <= toInclusive);
}
function sumValue(arr) { return arr.reduce((s, b) => s + (b.value || 0), 0); }
function lastBarAtOrBefore(bars, t) {
  let r = null;
  for (const b of bars) {
    if (b && b.time && b.close > 0 && b.time <= t) r = b;
    else if (b && b.time > t) break;
  }
  return r;
}

// ── 가설 trigger 2종 (조건 I, J용) ──
function hypoTenRebreak(bars, m) {
  if (!m) return null;
  if ((m.value_0930 || 0) < 1e9) return null;
  if (m.highToLastDrop != null && m.highToLastDrop < -4) return null;
  const win = barsInRange(bars, '09:30', '10:30');
  if (win.length < 5) return null;
  for (let i = 0; i < win.length; i++) {
    const b = win[i];
    if (!(b.high > m.high0930)) continue;
    const prev5 = win.slice(Math.max(0, i - 5), i);
    if (prev5.length === 0) continue;
    const avg5 = sumValue(prev5) / prev5.length;
    if (avg5 <= 0) continue;
    if ((b.value || 0) < avg5 * 2) continue;
    return { entryTime: b.time, entryPrice: m.high0930 };
  }
  return null;
}
function hypoFadedRecovery(bars, m, status) {
  if (!m || status !== 'FADED') return null;
  if ((m.value_0930 || 0) < 2e9) return null;
  if (m.highToLastDrop == null) return null;
  if (m.highToLastDrop > -2.5 || m.highToLastDrop < -6) return null;
  const w1 = barsInRange(bars, '09:30', '10:00');
  if (!w1.some((b) => b.close >= m.last0930)) return null;
  const w2 = barsInRange(bars, '09:30', '10:30');
  const rb = w2.find((b) => b.high > m.high0930);
  if (!rb) return null;
  return { entryTime: rb.time, entryPrice: m.high0930 };
}

function passesExplosive(m) {
  if (!m || !m.rebreakMorningHigh) return false;
  if ((m.closePosition0930 || 0) < 0.85) return false;
  if ((m.value_0930 || 0) < 1e10) return false;
  return true;
}

// ── 조건 정의 (10종) ──
const BASE = {
  minValue: 2.1e9, minCP: 0.50, maxDrop: -2.7, minOpen: 0.5, minRatio: 3,
  requireMH: true, allowedStatus: ['READY', 'FADED'], maxMc: 5e12, minMc: 0,
  requireHypo: null,  // 'TEN_REBREAK' | 'FADED_RECOVERY' | null
};
const CONDITIONS = {
  A: { label: '기본 (제안 컷)',          ...BASE },
  B: { label: 'B. status 확장 (+WEAK)',   ...BASE, allowedStatus: ['READY', 'FADED', 'WEAK'] },
  C: { label: 'C. MH 필수 제거',          ...BASE, requireMH: false },
  D: { label: 'D. drop ≥ -4.0 완화',     ...BASE, maxDrop: -4.0 },
  E: { label: 'E. value ≥ 50억 강화',    ...BASE, minValue: 5e9 },
  F: { label: 'F. ratio ≥ 5 강화',        ...BASE, minRatio: 5 },
  G: { label: 'G. mc 1000억~1조',         ...BASE, minMc: 1e11, maxMc: 1e12 },
  H: { label: 'H. mc 1000억~3조',         ...BASE, minMc: 1e11, maxMc: 3e12 },
  I: { label: 'I. TEN_REBREAK 동시',      ...BASE, requireHypo: 'TEN_REBREAK' },
  J: { label: 'J. FADED_RECOVERY 동시',   ...BASE, requireHypo: 'FADED_RECOVERY' },
};

function passesCondition(cond, m, status, meta, hypos) {
  if (cond.allowedStatus && !cond.allowedStatus.includes(status)) return false;
  if (!(meta.marketCap > 0)) return false;
  if (meta.marketCap < cond.minMc || meta.marketCap > cond.maxMc) return false;
  if ((m.value_0930 || 0) < cond.minValue) return false;
  if ((m.closePosition0930 || 0) < cond.minCP) return false;
  if (m.highToLastDrop != null && m.highToLastDrop < cond.maxDrop) return false;
  if ((m.openToLastRate || 0) < cond.minOpen) return false;
  if ((m.valueToAvgRatio_0930 || 0) < cond.minRatio) return false;
  if (cond.requireMH && !m.rebreakMorningHigh) return false;
  if (cond.requireHypo && !hypos[cond.requireHypo]) return false;
  return true;
}

// ── 09:30 high 재돌파 진입 모드 — 09:31~10:30 사이 첫 재돌파 분봉 ──
function findRebreakEntry(bars, m) {
  if (!(m.high0930 > 0)) return null;
  const win = barsInRange(bars, '09:30', '10:30');
  const rb = win.find((b) => b.high > m.high0930);
  return rb ? { entryTime: rb.time, entryPrice: m.high0930 } : null;
}

// ── 성과 측정 (전략별) ──
// strategy: 'S1' | 'S2' | 'S3' | 'S4'
// entry: { entryTime, entryPrice }
function evalStrategy(bars, entry, strategy) {
  const after = bars.filter((b) => b && b.time && b.close > 0 && b.time > entry.entryTime);
  if (after.length === 0) return null;
  const E = entry.entryPrice;
  if (!(E > 0)) return null;

  // 공통 통계 (hit/fail 도달률은 모든 전략에서 동일하게 측정)
  let maxHi = -Infinity, minLo = Infinity;
  let hit5 = false, hit7 = false, hit10 = false, fail2 = false, fail3 = false;
  let hit5Idx = -1, hit7Idx = -1, hit10Idx = -1, fail2Idx = -1, fail3Idx = -1;
  let bar1000 = null;
  let bar1000Idx = -1;
  for (let i = 0; i < after.length; i++) {
    const b = after[i];
    if (b.high > maxHi) maxHi = b.high;
    if (b.low  < minLo) minLo = b.low;
    if (!hit5  && (b.high / E - 1) * 100 >= 5)  { hit5  = true; hit5Idx  = i; }
    if (!hit7  && (b.high / E - 1) * 100 >= 7)  { hit7  = true; hit7Idx  = i; }
    if (!hit10 && (b.high / E - 1) * 100 >= 10) { hit10 = true; hit10Idx = i; }
    if (!fail2 && (b.low  / E - 1) * 100 <= -2) { fail2 = true; fail2Idx = i; }
    if (!fail3 && (b.low  / E - 1) * 100 <= -3) { fail3 = true; fail3Idx = i; }
    if (bar1000 == null && b.time >= '10:00') { bar1000 = b; bar1000Idx = i; }
  }

  // 전략별 실현 수익
  let realized = null, outcome = null, exitTime = null;
  if (strategy === 'S4') {
    // 10:00 생존 시 종가 보유, else 10:00 청산
    if (!bar1000) {
      // 10:00 분봉 없음 — 종가 보유
      const last = after[after.length - 1];
      realized = (last.close / E - 1) * 100;
      outcome = 'CLOSE_HOLD';
      exitTime = last.time;
    } else if (bar1000.close > E) {
      const last = after[after.length - 1];
      realized = (last.close / E - 1) * 100;
      outcome = 'SURVIVED_HOLD';
      exitTime = last.time;
    } else {
      realized = (bar1000.close / E - 1) * 100;
      outcome = 'EXIT_1000';
      exitTime = bar1000.time;
    }
  } else {
    let tp, sl;
    if (strategy === 'S1') { tp = 5;  sl = -2;   }
    else if (strategy === 'S2') { tp = 10; sl = -3;  }
    else if (strategy === 'S3') { tp = 7;  sl = -2.5; }
    else return null;
    const tpPrice = E * (1 + tp / 100), slPrice = E * (1 + sl / 100);
    for (const b of after) {
      const slHit = b.low <= slPrice;
      const tpHit = b.high >= tpPrice;
      if (slHit)      { outcome = 'SL'; realized = sl; exitTime = b.time; break; }
      else if (tpHit) { outcome = 'TP'; realized = tp; exitTime = b.time; break; }
    }
    if (!outcome) {
      const last = after[after.length - 1];
      outcome = 'TIMEOUT';
      realized = (last.close / E - 1) * 100;
      exitTime = last.time;
    }
  }

  // 종가 수익 (참고)
  const last = after[after.length - 1];
  const closeReturn = (last.close / E - 1) * 100;
  // 10:00 생존 여부 (모든 전략 공통 메트릭)
  const hold1000 = bar1000 ? bar1000.close > E : null;
  const positiveAtClose = last.close > E;

  return {
    strategy, outcome, exitTime,
    realizedReturn: Number(realized.toFixed(2)),
    maxUp:          Number(((maxHi / E - 1) * 100).toFixed(2)),
    maxDown:        Number(((minLo / E - 1) * 100).toFixed(2)),
    closeReturn:    Number(closeReturn.toFixed(2)),
    hit5, hit7, hit10, fail2, fail3,
    hit5BeforeFail2: hit5Idx >= 0 && (fail2Idx < 0 || hit5Idx < fail2Idx),
    hit10BeforeFail3: hit10Idx >= 0 && (fail3Idx < 0 || hit10Idx < fail3Idx),
    hold1000, positiveAtClose,
  };
}

// ── 차트/메타 ──
const chartCache = new Map();
function loadChartRows(code) {
  if (chartCache.has(code)) return chartCache.get(code);
  const p = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(p)) { chartCache.set(code, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    chartCache.set(code, j.rows || null);
    return j.rows || null;
  } catch (_) { chartCache.set(code, null); return null; }
}
function findBaseRow(rows, nextDateNum) {
  if (!Array.isArray(rows)) return null;
  const idx = rows.findIndex((r) => r.date === nextDateNum);
  if (idx < 21) return null;
  return { baseIdx: idx - 1, baseRow: rows[idx - 1] };
}

// ── 통계 헬퍼 ──
function avg(arr)    { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function rate(n, total) { return total > 0 ? Number((n / total * 100).toFixed(1)) : 0; }
function pct(v, d) { return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d == null ? 2 : d)); }

function summarize(label, perfs, candidateCount, totalDays) {
  const n = perfs.length;
  if (n === 0) return { label, n: 0, candidateCount, perDayAvg: pct(candidateCount / Math.max(1, totalDays), 2), note: '진입 표본 없음' };
  const rets = perfs.map((p) => p.realizedReturn);
  return {
    label,
    candidateCount,                        // 조건 통과 종목 수 (진입 가능 후보)
    perDayAvg:        pct(candidateCount / Math.max(1, totalDays), 2),
    n,                                     // 실제 진입 표본 수 (rebreak 모드는 후보 < 진입)
    perDayEntry:      pct(n / Math.max(1, totalDays), 2),
    avgReturn:        pct(avg(rets), 2),
    medianReturn:     pct(median(rets), 2),
    winRate:          rate(perfs.filter((p) => p.realizedReturn > 0).length, n),
    lossRate:         rate(perfs.filter((p) => p.realizedReturn < 0).length, n),
    hit5Rate:         rate(perfs.filter((p) => p.hit5).length, n),
    hit7Rate:         rate(perfs.filter((p) => p.hit7).length, n),
    hit10Rate:        rate(perfs.filter((p) => p.hit10).length, n),
    fail2Rate:        rate(perfs.filter((p) => p.fail2).length, n),
    fail3Rate:        rate(perfs.filter((p) => p.fail3).length, n),
    avgMaxUp:         pct(avg(perfs.map((p) => p.maxUp)), 2),
    avgMaxDown:       pct(avg(perfs.map((p) => p.maxDown)), 2),
    worstLoss:        pct(Math.min(...rets), 2),
    bestWin:          pct(Math.max(...rets), 2),
    hold1000Rate:     rate(perfs.filter((p) => p.hold1000 === true).length, n),
    closePositiveRate: rate(perfs.filter((p) => p.positiveAtClose).length, n),
  };
}

// ── 메인 분석 ──
function analyzeAll(dirs, metaMap) {
  // 결과 컨테이너:
  //   conditionStats[condKey] = { candidates: [{date, code, isExpTop, hit10_vs_0930}], entries[mode][strat] = [perf...] }
  //   baselineStats[bucket] = same but only S1/close
  const condKeys = Object.keys(CONDITIONS);
  const conditionData = {};
  for (const k of condKeys) {
    conditionData[k] = {
      candidates: [],
      perfs: { close: { S1: [], S2: [], S3: [], S4: [] }, rebreak: { S1: [], S2: [], S3: [], S4: [] } },
    };
  }
  const baselineData = {
    explosiveTop:    { candidates: [], perfs: { close: { S1: [], S2: [], S3: [], S4: [] }, rebreak: { S1: [], S2: [], S3: [], S4: [] } } },
    READY:           { candidates: [], perfs: { close: { S1: [], S2: [], S3: [], S4: [] }, rebreak: { S1: [], S2: [], S3: [], S4: [] } } },
    TEN_REBREAK:     { candidates: [], perfs: { close: { S1: [], S2: [], S3: [], S4: [] }, rebreak: { S1: [], S2: [], S3: [], S4: [] } } },
    FADED_RECOVERY:  { candidates: [], perfs: { close: { S1: [], S2: [], S3: [], S4: [] }, rebreak: { S1: [], S2: [], S3: [], S4: [] } } },
  };

  // 모든 +10% (vs 09:30) winner 집합 — explosive coverage 비교용
  const winners10Set = new Set();         // `${date}|${code}`
  const winnersByCondition = {};
  for (const k of condKeys) winnersByCondition[k] = new Set();
  const winnersByBaseline = { explosiveTop: new Set(), READY: new Set(), TEN_REBREAK: new Set(), FADED_RECOVERY: new Set() };

  let allEligibleCount = 0;

  for (const dirName of dirs) {
    const dir = path.join(INTRADAY_BASE, dirName);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const nextDateNum = dirName.replace(/-/g, '');

    for (const fname of files) {
      const code = fname.replace(/\.json$/, '');
      const meta = metaMap.get(code);
      if (!meta) continue;
      const rows = loadChartRows(code);
      if (!rows) continue;
      const baseInfo = findBaseRow(rows, nextDateNum);
      if (!baseInfo) continue;
      const baseRow = baseInfo.baseRow;
      if (!baseRow || !(baseRow.close > 0)) continue;
      let sum = 0, cnt = 0;
      for (let i = baseInfo.baseIdx - 20; i < baseInfo.baseIdx; i++) {
        const r = rows[i];
        if (r && r.volume > 0) { sum += (r.valueApprox || 0); cnt++; }
      }
      const avg20 = cnt > 0 ? sum / cnt : 0;
      const baseValue = baseRow.valueApprox || 0;
      const liq = scanner.passesLiquidityFilter(meta, avg20, baseValue);
      if (!liq.ok) continue;
      let bars = null;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf-8'));
        bars = j.bars || [];
      } catch (_) { continue; }
      if (bars.length === 0) continue;
      const m = scanner.computeMetrics0930(bars, baseRow);
      if (!m) continue;
      const status = scanner.classifyStatus(m);
      allEligibleCount++;

      // +10% from 09:30 close 여부 (사후)
      const after0930 = bars.filter((b) => b && b.time > '09:30' && b.close > 0);
      const dayMaxAfter0930 = after0930.length ? Math.max(...after0930.map((b) => b.high || 0)) : 0;
      const hit10_vs_0930 = m.last0930 > 0 && dayMaxAfter0930 / m.last0930 - 1 >= 0.10;
      const dkey = `${dirName}|${code}`;
      if (hit10_vs_0930) winners10Set.add(dkey);

      const isExplosiveTop = status === 'READY' && passesExplosive(m);

      // 가설 trigger (조건 I, J 및 베이스라인용)
      const tr_tenRebreak    = hypoTenRebreak(bars, m);
      const tr_fadedRecovery = hypoFadedRecovery(bars, m, status);
      const hypos = { TEN_REBREAK: tr_tenRebreak, FADED_RECOVERY: tr_fadedRecovery };

      // 진입 시점 2종 정의 (close 모드: 09:30 close 즉시 / rebreak 모드: 첫 재돌파)
      const entryClose = { entryTime: '09:30', entryPrice: m.last0930 };
      const entryRebreak = findRebreakEntry(bars, m);

      // 각 조건 통과 여부 + 진입 + 전략별 평가
      for (const k of Object.keys(CONDITIONS)) {
        if (!passesCondition(CONDITIONS[k], m, status, meta, hypos)) continue;
        conditionData[k].candidates.push({ date: dirName, code, name: meta.name || code, status, isExplosiveTop, hit10_vs_0930, marketCap: meta.marketCap });
        if (hit10_vs_0930) winnersByCondition[k].add(dkey);
        // close 진입 — 모든 전략
        for (const s of ['S1', 'S2', 'S3', 'S4']) {
          const p = evalStrategy(bars, entryClose, s);
          if (p) conditionData[k].perfs.close[s].push({ ...p, date: dirName, code, isExplosiveTop, hit10_vs_0930 });
        }
        // rebreak 진입 — 가능한 경우에만
        if (entryRebreak) {
          for (const s of ['S1', 'S2', 'S3', 'S4']) {
            const p = evalStrategy(bars, entryRebreak, s);
            if (p) conditionData[k].perfs.rebreak[s].push({ ...p, date: dirName, code, isExplosiveTop, hit10_vs_0930 });
          }
        }
      }

      // 베이스라인 — 4종
      const baseAdds = [];
      if (isExplosiveTop) baseAdds.push('explosiveTop');
      if (status === 'READY') baseAdds.push('READY');
      if (tr_tenRebreak) baseAdds.push('TEN_REBREAK');
      if (tr_fadedRecovery) baseAdds.push('FADED_RECOVERY');
      for (const bk of baseAdds) {
        baselineData[bk].candidates.push({ date: dirName, code, isExplosiveTop, hit10_vs_0930, marketCap: meta.marketCap });
        if (hit10_vs_0930) winnersByBaseline[bk].add(dkey);
        // 베이스라인 close 진입 = 09:30 close 진입. rebreak는 TEN_REBREAK/FADED_RECOVERY의 경우 가설 trigger entry, 나머지는 일반 재돌파.
        for (const s of ['S1', 'S2', 'S3', 'S4']) {
          const p = evalStrategy(bars, entryClose, s);
          if (p) baselineData[bk].perfs.close[s].push({ ...p, date: dirName, code, isExplosiveTop, hit10_vs_0930 });
        }
        // TEN_REBREAK / FADED_RECOVERY는 가설의 자체 entry 사용. 그 외는 일반 rebreak 사용.
        const bEntry = (bk === 'TEN_REBREAK')    ? tr_tenRebreak
                     : (bk === 'FADED_RECOVERY') ? tr_fadedRecovery
                     : entryRebreak;
        if (bEntry) {
          for (const s of ['S1', 'S2', 'S3', 'S4']) {
            const p = evalStrategy(bars, bEntry, s);
            if (p) baselineData[bk].perfs.rebreak[s].push({ ...p, date: dirName, code, isExplosiveTop, hit10_vs_0930 });
          }
        }
      }
    }
  }

  return { conditionData, baselineData, winners10Set, winnersByCondition, winnersByBaseline, allEligibleCount };
}

// ── 결과 집계 ──
function buildSummaries(conditionData, baselineData, winners10Set, winnersByCondition, winnersByBaseline, totalDays) {
  const condKeys = Object.keys(CONDITIONS);
  const totalWinnerCount = winners10Set.size;

  function packGroup(label, data, winnerSet, isCondition) {
    const candidateCount = data.candidates.length;
    const expTopOverlapN = data.candidates.filter((c) => c.isExplosiveTop).length;
    const winnerN = winnerSet ? winnerSet.size : 0;
    const out = {
      label,
      candidateCount,
      perDayAvg:           pct(candidateCount / Math.max(1, totalDays), 2),
      uniqueCount:         (new Set(data.candidates.map((c) => `${c.date}|${c.code}`))).size,
      explosiveTopOverlap: { count: expTopOverlapN, overlapRate: rate(expTopOverlapN, candidateCount) },
      winners10_covered:   { count: winnerN, conditionRecall: rate(winnerN, totalWinnerCount), conditionPrecision: rate(winnerN, candidateCount) },
      strategies: {},
    };
    for (const mode of ['close', 'rebreak']) {
      out.strategies[mode] = {};
      for (const s of ['S1', 'S2', 'S3', 'S4']) {
        out.strategies[mode][s] = summarize(`${label} / ${mode} × ${s}`, data.perfs[mode][s], candidateCount, totalDays);
      }
    }
    return out;
  }

  const conditions = {};
  for (const k of condKeys) {
    conditions[k] = packGroup(`${k}: ${CONDITIONS[k].label}`, conditionData[k], winnersByCondition[k], true);
  }
  const baselines = {};
  for (const k of Object.keys(baselineData)) {
    baselines[k] = packGroup(k, baselineData[k], winnersByBaseline[k], false);
  }
  return { conditions, baselines, totalWinnerCount };
}

// ── 결론 빌더 ──
function buildConclusion(summaries) {
  const lines = [];
  const recommend = [];
  const warnings = [];

  // 조건별 베스트 전략 찾기
  let bestOverall = null;
  for (const [k, c] of Object.entries(summaries.conditions)) {
    for (const mode of ['close', 'rebreak']) {
      for (const s of ['S1', 'S2', 'S3', 'S4']) {
        const st = c.strategies[mode][s];
        if (!st || !st.n || st.n < 30) continue;
        const score = (st.avgReturn || 0) * Math.min(1, st.n / 50);  // 표본 보정
        if (!bestOverall || score > bestOverall.score) {
          bestOverall = { cond: k, mode, strategy: s, stat: st, score };
        }
      }
    }
  }
  if (bestOverall) {
    lines.push(`전체 베스트: ${bestOverall.cond} × ${bestOverall.mode} × ${bestOverall.strategy} — n=${bestOverall.stat.n}, 평균 ${bestOverall.stat.avgReturn}%, 승률 ${bestOverall.stat.winRate}%, +10% ${bestOverall.stat.hit10Rate}%, 최악 ${bestOverall.stat.worstLoss}%`);
  } else {
    lines.push('전체 베스트: 표본 부족 (모든 조건에서 n<30)');
  }

  // explosiveTop 베이스라인 vs 공격형 베스트 비교
  const expBaseline = summaries.baselines.explosiveTop;
  const expBest = expBaseline.strategies.close.S1;
  lines.push(`explosiveTop / close × S1 (+5/-2): n=${expBest.n}, 평균 ${expBest.avgReturn}%, 승률 ${expBest.winRate}%, +10% ${expBest.hit10Rate}%`);

  // 조건별 평가
  for (const [k, c] of Object.entries(summaries.conditions)) {
    const s1 = c.strategies.close.S1;
    if (!s1 || s1.n === 0) {
      warnings.push(`${k}: 진입 표본 0 — 후보 자체가 없거나 분봉 부족`);
      continue;
    }
    const tag = (s1.avgReturn > 0 && s1.winRate >= 45) ? '⭕'
              : (s1.avgReturn > 0 || s1.winRate >= 40) ? '🟡' : '❌';
    lines.push(`${tag} ${k}: n=${s1.n}, 일평균 ${s1.perDayEntry}개, close×S1 ${s1.avgReturn}% / 승률 ${s1.winRate}% / +10% ${s1.hit10Rate}% / 최악 ${s1.worstLoss}% / +10% 커버 ${c.winners10_covered.count}건(recall ${c.winners10_covered.conditionRecall}%, precision ${c.winners10_covered.conditionPrecision}%)`);
    if (s1.avgReturn > 0.5 && s1.winRate >= 45 && s1.perDayEntry >= 1 && s1.perDayEntry <= 15 && c.winners10_covered.conditionPrecision >= 20) {
      recommend.push(`${k}: 평균 ${s1.avgReturn}%, 승률 ${s1.winRate}%, 일평균 ${s1.perDayEntry}개, +10% precision ${c.winners10_covered.conditionPrecision}% — 공격형 보드 후보`);
    }
    if (s1.worstLoss != null && s1.worstLoss < -5) warnings.push(`${k}: 최악 손실 ${s1.worstLoss}% — SL 충돌 점검 필요`);
    if (s1.perDayEntry > 20) warnings.push(`${k}: 일평균 ${s1.perDayEntry}개 — 후보 과다, 추가 필터 필요`);
  }

  return { lines, recommend, warnings, bestOverall };
}

// ── HTML 렌더 ──
function renderHtml(out) {
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
  function fmtPct(v, d) { if (v == null || !Number.isFinite(v)) return '-'; const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : ''; const dd = d == null ? 2 : d; return `<span class="${cls}">${(v >= 0 ? '+' : '')}${v.toFixed(dd)}%</span>`; }
  function fmtRate(v) { return v == null ? '-' : v.toFixed(1) + '%'; }
  function fmtMoney(v) { if (v == null) return '-'; if (v >= 1e12) return (v/1e12).toFixed(2)+'조'; if (v >= 1e8) return (v/1e8).toFixed(1)+'억'; return v.toString(); }

  // 조건/베이스라인 요약 표 (close × S1만 — 메인)
  function summaryRow(key, c, isBaseline) {
    const s1 = c.strategies.close.S1;
    const s2 = c.strategies.close.S2;
    const r1 = c.strategies.rebreak.S1;
    return `<tr>
      <td><strong>${esc(key)}</strong></td>
      <td>${esc(c.label)}</td>
      <td class="num">${c.candidateCount}</td>
      <td class="num">${c.perDayAvg}</td>
      <td class="num">${c.explosiveTopOverlap.count} (${fmtRate(c.explosiveTopOverlap.overlapRate)})</td>
      <td class="num">${c.winners10_covered.count} (recall ${fmtRate(c.winners10_covered.conditionRecall)})</td>
      <td class="num">${fmtRate(c.winners10_covered.conditionPrecision)}</td>
      <td class="num">${s1.n || 0}</td>
      <td class="num">${fmtPct(s1.avgReturn)}</td>
      <td class="num">${fmtPct(s1.medianReturn)}</td>
      <td class="num">${fmtRate(s1.winRate)}</td>
      <td class="num">${fmtRate(s1.hit5Rate)}</td>
      <td class="num">${fmtRate(s1.hit10Rate)}</td>
      <td class="num">${fmtRate(s1.fail2Rate)}</td>
      <td class="num">${fmtPct(s1.worstLoss)}</td>
      <td class="num">${s2 ? fmtPct(s2.avgReturn) : '-'}</td>
      <td class="num">${r1 ? r1.n || 0 : '-'}</td>
      <td class="num">${r1 ? fmtPct(r1.avgReturn) : '-'}</td>
      <td class="num">${r1 ? fmtRate(r1.winRate) : '-'}</td>
    </tr>`;
  }

  const condRows = Object.entries(out.summaries.conditions).map(([k, c]) => summaryRow(k, c, false)).join('');
  const baseRows = Object.entries(out.summaries.baselines).map(([k, c]) => summaryRow(k, c, true)).join('');
  const summaryHead = `<thead><tr>
    <th>키</th><th>설명</th>
    <th>후보</th><th>일평균</th>
    <th>EXP 중복</th>
    <th>+10% 커버 (recall)</th><th>+10% precision</th>
    <th>n</th><th>avg</th><th>median</th><th>승률</th>
    <th>+5%</th><th>+10%</th><th>-2%</th><th>worst</th>
    <th>S2 avg</th>
    <th>rebreak n</th><th>rebreak avg</th><th>rebreak 승률</th>
  </tr></thead>`;

  // 진입 모드 비교 (close vs rebreak — S1)
  function modeCompareRow(key, c) {
    const cs = c.strategies.close.S1;
    const rs = c.strategies.rebreak.S1;
    const edge = (cs && rs && cs.n && rs.n) ? Number((rs.avgReturn - cs.avgReturn).toFixed(2)) : null;
    return `<tr>
      <td><strong>${esc(key)}</strong></td>
      <td class="num">${cs.n || 0}</td>
      <td class="num">${fmtPct(cs.avgReturn)}</td>
      <td class="num">${fmtRate(cs.winRate)}</td>
      <td class="num">${rs.n || 0}</td>
      <td class="num">${fmtPct(rs.avgReturn)}</td>
      <td class="num">${fmtRate(rs.winRate)}</td>
      <td class="num">${edge == null ? '-' : fmtPct(edge)}</td>
    </tr>`;
  }
  const allGroups = [...Object.entries(out.summaries.baselines), ...Object.entries(out.summaries.conditions)];
  const modeRows = allGroups.map(([k, c]) => modeCompareRow(k, c)).join('');

  // 전략별 (S1~S4) — 메인 조건 A에 대해
  function strategyTable(c) {
    function row(s, mode) {
      const st = c.strategies[mode][s];
      return `<tr>
        <td>${s}</td><td>${mode}</td>
        <td class="num">${st.n || 0}</td>
        <td class="num">${fmtPct(st.avgReturn)}</td>
        <td class="num">${fmtPct(st.medianReturn)}</td>
        <td class="num">${fmtRate(st.winRate)}</td>
        <td class="num">${fmtRate(st.hit5Rate)}</td>
        <td class="num">${fmtRate(st.hit10Rate)}</td>
        <td class="num">${fmtRate(st.fail2Rate)}</td>
        <td class="num">${fmtRate(st.fail3Rate)}</td>
        <td class="num">${fmtPct(st.avgMaxUp)}</td>
        <td class="num">${fmtPct(st.avgMaxDown)}</td>
        <td class="num">${fmtPct(st.worstLoss)}</td>
        <td class="num">${fmtRate(st.hold1000Rate)}</td>
        <td class="num">${fmtRate(st.closePositiveRate)}</td>
      </tr>`;
    }
    return ['S1', 'S2', 'S3', 'S4'].flatMap((s) => ['close', 'rebreak'].map((m) => row(s, m))).join('');
  }
  const stratHead = `<thead><tr>
    <th>전략</th><th>모드</th><th>n</th>
    <th>avg</th><th>median</th><th>승률</th>
    <th>+5%</th><th>+10%</th><th>-2%</th><th>-3%</th>
    <th>avg↑</th><th>avg↓</th><th>worst</th>
    <th>10시 생존</th><th>종가+</th>
  </tr></thead>`;
  const stratACond = strategyTable(out.summaries.conditions.A);
  const stratExpBase = strategyTable(out.summaries.baselines.explosiveTop);

  // 결론
  const conc = out.conclusion;
  const concLines = conc.lines.map((l) => `<li>${esc(l)}</li>`).join('');
  const recList = conc.recommend.length
    ? conc.recommend.map((r) => `<li>${esc(r)}</li>`).join('')
    : '<li style="color:#888;">추천 가능한 공격형 조건 없음 — 모든 조건이 평균 수익/승률/precision 기준을 만족하지 못함</li>';
  const warnList = conc.warnings.length
    ? conc.warnings.map((w) => `<li>${esc(w)}</li>`).join('')
    : '<li style="color:#888;">경고 없음</li>';

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>1DS 공격형 후보 조건 백테스트</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 22px; max-width: 1900px; margin: 0 auto; color: #222; background: #fafafa; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #ddd; }
  h3 { font-size: 13px; margin: 14px 0 6px; color: #444; }
  .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 11.5px; margin-bottom: 12px; }
  th, td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; font-weight: 600; white-space: nowrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #c62828; }
  .neg { color: #1565c0; }
  ul { padding-left: 22px; } li { margin: 3px 0; font-size: 13px; }
  .summary { background: #fff; padding: 12px 16px; border-radius: 6px; border: 1px solid #e0e0e0; margin-bottom: 18px; }
  .note { color: #888; font-size: 11px; margin-top: 4px; }
  tr:nth-child(odd) td.num { background: #fafafa; }
</style></head>
<body>
<h1>1DS — 공격형 보조 후보 조건 백테스트 검증</h1>
<div class="meta">
  생성: ${out.meta.generatedAt} · ${out.meta.totalDays}거래일 (${out.meta.datesAnalyzed[0]} ~ ${out.meta.datesAnalyzed[out.meta.datesAnalyzed.length - 1]}) · 모집단 ${out.meta.allEligibleCount}건 · +10% 종목(vs 0930) ${out.summaries.totalWinnerCount}건 · 소요 ${out.meta.elapsedSec}s
  <div class="note">조건/베이스라인 통과 종목당 close(09:30 close) / rebreak(09:30 high 첫 재돌파) 2종 진입 × S1~S4 4종 전략 평가. 미래 누수 차단됨.</div>
</div>

<div class="summary">
  <h2 style="margin-top:0;border:none;">1. 요약 결론</h2>
  <ul>${concLines}</ul>
</div>

<h2>2. 조건/베이스라인 vs explosiveTop — close × S1 메인 비교 (+ S2 평균, rebreak 보조)</h2>
<p class="note">+10% recall = 그 조건이 잡은 +10% 종목 / 전체 +10% 종목(${out.summaries.totalWinnerCount}건). +10% precision = 그 조건의 후보 중 +10% 비율. close × S1 = 09:30 close 진입 + +5/-2 청산.</p>
<h3>2-1. 베이스라인 (explosiveTop / READY / TEN_REBREAK / FADED_RECOVERY)</h3>
<table>${summaryHead}<tbody>${baseRows}</tbody></table>
<h3>2-2. 공격형 조건 A~J</h3>
<table>${summaryHead}<tbody>${condRows}</tbody></table>

<h2>3. 09:30 close 진입 vs 재돌파 진입 비교 (S1 +5/-2 기준)</h2>
<p class="note">edge = rebreak avg − close avg. 양수면 재돌파 진입이 평균 수익 우위.</p>
<table><thead><tr>
  <th>그룹</th>
  <th>close n</th><th>close avg</th><th>close 승률</th>
  <th>rebreak n</th><th>rebreak avg</th><th>rebreak 승률</th>
  <th>edge</th>
</tr></thead><tbody>${modeRows}</tbody></table>

<h2>4. 조건 A — 전략별 매트릭스 (S1~S4 × close/rebreak)</h2>
<p class="note">S1=+5/-2, S2=+10/-3, S3=+7/-2.5, S4=10시 생존 시 종가 보유. "10시 생존" / "종가+" 컬럼은 전체 진입의 사후 결과 비율.</p>
<table>${stratHead}<tbody>${stratACond}</tbody></table>

<h3>4-1. 베이스라인 explosiveTop — 전략별 매트릭스 (참고)</h3>
<table>${stratHead}<tbody>${stratExpBase}</tbody></table>

<h2>5. +10% 종목 커버율 (조건별)</h2>
<p>전체 +10% (vs 09:30 close) 종목 <strong>${out.summaries.totalWinnerCount}건</strong> 기준 — 각 조건이 얼마나 잡고(recall) 그 안에 +10%가 얼마나 차있는지(precision).</p>
<table><thead><tr><th>조건</th><th>설명</th><th>잡은 +10%</th><th>recall</th><th>후보 중 +10% 비율 (precision)</th></tr></thead><tbody>
  ${Object.entries(out.summaries.conditions).map(([k, c]) => `<tr><td><strong>${esc(k)}</strong></td><td>${esc(c.label)}</td><td class="num">${c.winners10_covered.count}</td><td class="num">${fmtRate(c.winners10_covered.conditionRecall)}</td><td class="num">${fmtRate(c.winners10_covered.conditionPrecision)}</td></tr>`).join('')}
  ${Object.entries(out.summaries.baselines).map(([k, c]) => `<tr><td><strong>${esc(k)}</strong></td><td>(베이스라인)</td><td class="num">${c.winners10_covered.count}</td><td class="num">${fmtRate(c.winners10_covered.conditionRecall)}</td><td class="num">${fmtRate(c.winners10_covered.conditionPrecision)}</td></tr>`).join('')}
</tbody></table>

<h2>6. 손실 위험 분석 (close × S1)</h2>
<table><thead><tr><th>조건</th><th>n</th><th>fail2 (-2%)</th><th>fail3 (-3%)</th><th>worst loss</th><th>avg drawdown</th></tr></thead><tbody>
  ${Object.entries(out.summaries.conditions).map(([k, c]) => {
    const s = c.strategies.close.S1;
    return `<tr><td><strong>${esc(k)}</strong></td><td class="num">${s.n||0}</td><td class="num">${fmtRate(s.fail2Rate)}</td><td class="num">${fmtRate(s.fail3Rate)}</td><td class="num">${fmtPct(s.worstLoss)}</td><td class="num">${fmtPct(s.avgMaxDown)}</td></tr>`;
  }).join('')}
</tbody></table>

<h2>7. 보드에 추가할 수 있는 공격형 후보 조건 제안</h2>
<ul>${recList}</ul>

<h2>8. 추가하면 안 되는 조건</h2>
<ul>${warnList}</ul>

<div class="note" style="margin-top:30px;border-top:1px dashed #ccc;padding-top:10px;">
  대상 일자: ${esc(out.meta.datesAnalyzed.join(', '))}
</div>
</body></html>`;
}

// ── main ──
function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(INTRADAY_BASE)) { console.error('[ERROR] data/intraday/1ds 없음'); process.exit(1); }

  console.log('\n📊 1DS 공격형 후보 조건 백테스트');
  const t0 = Date.now();
  const metaMap = scanner.loadStockMetaMap();
  console.log(`  메타 로드: ${metaMap.size}건`);

  const allDirs = fs.readdirSync(INTRADAY_BASE).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  let dirs = allDirs;
  if (args.from) dirs = dirs.filter((d) => d >= args.from);
  if (args.to)   dirs = dirs.filter((d) => d <= args.to);
  dirs = dirs.filter((d) => fs.readdirSync(path.join(INTRADAY_BASE, d)).length >= args.minDirSize);
  if (args.days && dirs.length > args.days) dirs = dirs.slice(-args.days);
  applyDaysSuffix(args.days);
  console.log(`  분봉 디렉토리: ${dirs.length}개${args.days ? ` (--days ${args.days})` : ''}`);
  if (dirs.length === 0) { console.error('[ERROR] 대상 일자 없음'); process.exit(1); }

  const { conditionData, baselineData, winners10Set, winnersByCondition, winnersByBaseline, allEligibleCount } = analyzeAll(dirs, metaMap);
  console.log(`  모집단(유동성 통과) ${allEligibleCount}건, +10% (vs 0930) winner ${winners10Set.size}건`);

  const summaries = buildSummaries(conditionData, baselineData, winners10Set, winnersByCondition, winnersByBaseline, dirs.length);
  const conclusion = buildConclusion(summaries);

  const out = {
    meta: {
      title: '1DS — 공격형 보조 후보 조건 백테스트 검증',
      generatedAt: new Date().toISOString(),
      datesAnalyzed: dirs,
      totalDays: dirs.length,
      allEligibleCount,
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(2)),
      methodology: '조건/베이스라인 통과 종목에 대해 close(09:30 close) / rebreak(09:30 high 첫 재돌파, 09:31~10:30) 진입 × S1(+5/-2) / S2(+10/-3) / S3(+7/-2.5) / S4(10시 생존 시 종가, 아니면 10:00 청산) 4종 전략 평가. 평가는 진입 직후 분봉부터 사용. 사전 조건은 09:30 분봉까지만, rebreak/가설 trigger는 trigger 시점 이전 분봉만 사용.',
    },
    conditionDefinitions: CONDITIONS,
    summaries,
    conclusion,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, renderHtml(out), 'utf-8');

  console.log(`\n  ⏱ 소요 ${out.meta.elapsedSec}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
  console.log('\n  📌 결론:');
  for (const l of conclusion.lines) console.log(`     ${l}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('❌', e); process.exit(1); }
}

module.exports = { main };
