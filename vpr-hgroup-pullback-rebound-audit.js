#!/usr/bin/env node
/**
 * VPR (Volume Pullback Rebound) — H그룹 눌림 재돌파 감사 보고서
 *
 * 화면명: 돌파 후 눌림 재상승 후보
 *
 * 목적:
 *   QVA → VVI → 돌파 성공(H그룹) 이후 눌림대기 상태였던 종목들이 다시 재돌파/재상승했는지
 *   확인하는 감사 보고서. QVA/VVI/H그룹 정의는 변경하지 않는다.
 *
 *   이 보고서는 매수 확정 신호가 아니라, "H그룹 → 눌림 → 재돌파"가 의미 있는 후속 신호인지
 *   검증하기 위한 분석이다. 전체시장 매수후보 보드를 만들지 않는다.
 *
 * 입력:
 *   - qva-vvi-breakout-entry-report.json (details 중 entryTriggered1Pct && !breakoutFail = H그룹)
 *   - cache/stock-charts-long/{code}.json
 *
 * 출력:
 *   - reports/vpr-hgroup-pullback-rebound-audit-result.json
 *   - reports/vpr-hgroup-pullback-rebound-audit-result.html
 *
 * 라우트: /vpr-hgroup-audit
 *
 * 실행:
 *   node vpr-hgroup-pullback-rebound-audit.js
 */

const fs = require('fs');
const path = require('path');
const vprAnalyzer = require('./vpr-analyzer');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const HGROUP_INPUT = path.join(ROOT, 'qva-vvi-breakout-entry-report.json');
const CHART_DIR = path.join(ROOT, 'cache/stock-charts-long');
const OUT_JSON = path.join(REPORTS_DIR, 'vpr-hgroup-pullback-rebound-audit-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'vpr-hgroup-pullback-rebound-audit-result.html');

const CONFIG = Object.assign({}, vprAnalyzer.DEFAULT_CONFIG, {
  STATUS_SNAPSHOT_DAY: 3,         // 화면 상태 스냅샷 (entryDate + N) — 감사 전용
});

// ─────────────────────── 헬퍼 ───────────────────────

function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}
function avg(arr) {
  const v = arr.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  return round(v.reduce((s, x) => s + x, 0) / v.length, 2);
}
function median(arr) {
  const v = arr.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round(s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m], 2);
}
function rate(num, denom) {
  if (!denom) return null;
  return round(num / denom * 100, 2);
}
function formatDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// ─────────── 화면 상태 (judgmentStatus) 스냅샷 ───────────
// qva-watchlist-board.js의 judgmentStatus 로직을 entryDate + N 시점에 적용 (snapshot proxy).
// 우선순위: 약화 > 관리 > 눌림대기 > 추격 > 검토
function snapshotJudgmentStatus(rows, entryIdx, entryPrice, vviHigh, snapshotDay) {
  const idx = entryIdx + snapshotDay;
  if (idx >= rows.length) return null;
  const c = rows[idx].close;
  if (!c || c <= 0 || !(entryPrice > 0)) return null;
  if (c < entryPrice || c < vviHigh) return 'BREAKDOWN_WEAK';
  if (c >= entryPrice * 1.15) return 'MANAGEMENT';
  if (c > entryPrice * 1.07 || snapshotDay >= 3) return 'PULLBACK_WAIT';
  if (c > entryPrice * 1.03) return 'CHASE_CAUTION';
  return 'REVIEW_OK';
}
const STATUS_LABEL = {
  REVIEW_OK: '진입가 근처',
  CHASE_CAUTION: '추격 주의',
  PULLBACK_WAIT: '눌림 대기',
  MANAGEMENT: '관리 구간',
  BREAKDOWN_WEAK: '돌파 악화',
};

// ─────────────────────── VPR 분석 (감사용 래퍼) ───────────────────────

function analyzeVPR(hCase, rows) {
  const result = vprAnalyzer.analyzeVPR({
    entryDate: hCase.entryDate,
    vviHigh: hCase.vviHigh,
    vviClose: hCase.vviClose,
    vviLow: hCase.vviLow,
    qvaSignalPrice: hCase.qvaSignalPrice,
    entryPrice: hCase.entryPrice,
  }, rows, CONFIG);
  if (result.vprStatus === 'DATA_INSUFFICIENT') return result;

  // 화면 상태 스냅샷 (entryDate + 3)
  const entryIdx = rows.findIndex(r => r.date === hCase.entryDate);
  const snapshotStatus = entryIdx >= 0
    ? snapshotJudgmentStatus(rows, entryIdx, result.base.entryPrice, hCase.vviHigh, CONFIG.STATUS_SNAPSHOT_DAY)
    : null;

  // base에 hCase 메타 필드 보강 (감사 출력 호환)
  result.base = Object.assign({
    qvaDate: hCase.qvaSignalDate,
    vviDate: hCase.vviDate,
    hDate: hCase.entryDate,
  }, result.base);
  result.snapshotStatus = snapshotStatus;
  result.snapshotStatusLabel = snapshotStatus ? STATUS_LABEL[snapshotStatus] : null;

  // 감사 호환: result 안에 vprRole 보강 (라벨은 모듈 라벨로 통일)
  const status = result.result.vprStatus;
  if (status === 'STRONG_VPR_SUCCESS') result.result.vprRole = 'success_strong';
  else if (status === 'CLASSIC_VPR_SUCCESS') result.result.vprRole = 'success_classic';
  else if (status === 'PULLBACK_PENDING') result.result.vprRole = 'pending';
  else if (status === 'NO_PULLBACK_RUNAWAY') result.result.vprRole = 'runaway';
  else result.result.vprRole = 'failure';

  return result;
}

// ─────────────────────── 그룹 집계 ───────────────────────

function summarizeGroup(label, items) {
  const N = items.length;
  if (N === 0) {
    return { label, count: 0 };
  }
  const maxHigh10 = items.map(c => c.vpr?.result?.maxHighReturnWithin10);
  const close10 = items.map(c => c.vpr?.result?.closeReturnWithin10);
  const reboundMfe10 = items.map(c => c.vpr?.result?.maxHighReturnAfterRebound);
  const reboundClose10 = items.map(c => c.vpr?.result?.closeReturnAfterRebound);
  const reboundClose5 = items.map(c => c.vpr?.result?.close5AfterRebound);
  const reboundMfe5 = items.map(c => c.vpr?.result?.mfeHigh5AfterRebound);
  const daysToRebound = items.map(c => c.vpr?.rebound?.daysToRebound).filter(v => v != null);

  const reboundCount = items.filter(c => c.vpr?.rebound?.hasVprRebound).length;
  const classicCount = items.filter(c => c.vpr?.result?.isClassicVprSuccess).length;
  const strongCount = items.filter(c => c.vpr?.result?.isStrongVprSuccess).length;
  const failureCount = items.filter(c => c.vpr?.result?.isVprFailure).length;

  const high10 = maxHigh10.filter(v => v != null);
  const close10Valid = close10.filter(v => v != null);
  const reboundValueRatios = items
    .map(c => c.vpr?.rebound?.reboundValueVsPullbackAvg)
    .filter(v => v != null);

  return {
    label,
    count: N,
    avgHighReturn10: avg(maxHigh10),
    medianHighReturn10: median(maxHigh10),
    avgCloseReturn10: avg(close10),
    medianCloseReturn10: median(close10),
    avgReboundMfe10: avg(reboundMfe10),
    avgReboundClose10: avg(reboundClose10),
    avgReboundClose5: avg(reboundClose5),
    avgReboundMfe5: avg(reboundMfe5),
    vprSuccessRate: rate(classicCount, N),
    strongVprRate: rate(strongCount, N),
    vprFailureRate: rate(failureCount, N),
    reboundRate: rate(reboundCount, N),
    avgDaysToRebound: avg(daysToRebound),
    plus5HitRate: rate(high10.filter(v => v >= 5).length, high10.length),
    plus10HitRate: rate(high10.filter(v => v >= 10).length, high10.length),
    minus5CloseRate: rate(close10Valid.filter(v => v <= -5).length, close10Valid.length),
    minus10CloseRate: rate(close10Valid.filter(v => v <= -10).length, close10Valid.length),
    avgReboundValueRatio: avg(reboundValueRatios),
  };
}

// ─────────────────────── 자동 결론 ───────────────────────

function buildKeyFindings(summaryGroups, statusGroups) {
  const findings = [];
  const all = summaryGroups.find(g => g.key === 'ALL');
  const pwait = statusGroups.find(g => g.key === 'PULLBACK_WAIT');
  const broken = statusGroups.find(g => g.key === 'BREAKDOWN_WEAK');
  const mgmt = statusGroups.find(g => g.key === 'MANAGEMENT');
  const classic = summaryGroups.find(g => g.key === 'CLASSIC_VPR_SUCCESS');
  const struct = summaryGroups.find(g => g.key === 'STRUCTURAL_BREAK');
  const noPb = summaryGroups.find(g => g.key === 'NO_PULLBACK_RUNAWAY');
  const fail = summaryGroups.find(g => g.key === 'REBOUND_FAIL');

  if (pwait?.vprSuccessRate != null && all?.vprSuccessRate != null) {
    if (pwait.vprSuccessRate > all.vprSuccessRate) {
      findings.push(`눌림대기 그룹 VPR 성공률(${pwait.vprSuccessRate}%)이 H그룹 전체(${all.vprSuccessRate}%)보다 높음 — 눌림대기 상태는 VPR 후보로 의미가 있습니다.`);
    } else {
      findings.push(`눌림대기 그룹 VPR 성공률(${pwait.vprSuccessRate}%)이 H그룹 전체(${all.vprSuccessRate}%)보다 낮음 — 눌림대기만으로는 부족하며 재돌파 확인이 필요합니다.`);
    }
  }
  if (classic?.avgHighReturn10 != null && all?.avgHighReturn10 != null) {
    if (classic.avgHighReturn10 > all.avgHighReturn10) {
      findings.push(`정석 VPR 성공 그룹 평균 고가 상승률(${classic.avgHighReturn10}%)이 H그룹 전체(${all.avgHighReturn10}%)보다 높음 — VPR 재돌파 확인은 H그룹 이후 추가 상승 확인 신호로 볼 수 있습니다.`);
    }
  }
  if (struct?.avgCloseReturn10 != null && struct.avgCloseReturn10 < -5) {
    findings.push(`구조 훼손 그룹 평균 종가 수익률(${struct.avgCloseReturn10}%) — 기준 가격을 크게 이탈한 H그룹은 제외 또는 관리 해제가 적절합니다.`);
  }
  if (noPb?.avgHighReturn10 != null && all?.avgHighReturn10 != null && noPb.avgHighReturn10 > all.avgHighReturn10) {
    findings.push(`눌림 없이 상승 그룹 평균 고가 상승률(${noPb.avgHighReturn10}%) — 일부 H그룹은 눌림을 기다리지 않고 바로 상승하는 유형입니다.`);
  }
  if (broken?.vprFailureRate != null && all?.vprFailureRate != null && broken.vprFailureRate > all.vprFailureRate) {
    findings.push(`돌파 악화 그룹 VPR 실패율(${broken.vprFailureRate}%)이 H그룹 전체(${all.vprFailureRate}%)보다 높음 — 돌파 악화는 실제로 위험 상태로 볼 수 있습니다.`);
  }
  if (mgmt && mgmt.count > 0) {
    findings.push(`관리 구간 그룹 (${mgmt.count}건) 평균 고가 상승률 ${mgmt.avgHighReturn10}% / VPR 성공률 ${mgmt.vprSuccessRate}% — 중간 상태로 볼 수 있는지 별도 검토 필요.`);
  }
  if (fail?.count > 0 && fail?.avgCloseReturn10 != null) {
    findings.push(`재돌파 실패 그룹 (${fail.count}건) 평균 종가 ${fail.avgCloseReturn10}% — 눌림 후 재돌파 못 한 H그룹은 H돌파일 기준 평균 ${fail.avgCloseReturn10 < 0 ? '하락' : '미진'} 상태로 마감.`);
  }
  return findings;
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  if (!fs.existsSync(HGROUP_INPUT)) {
    console.error(`[ERROR] 입력 파일 없음: ${HGROUP_INPUT}`);
    console.error(`먼저 \`node qva-vvi-breakout-entry-report.js\`를 실행하세요.`);
    process.exit(1);
  }

  const entryReport = JSON.parse(fs.readFileSync(HGROUP_INPUT, 'utf-8'));
  const allDetails = entryReport.details || [];
  const hCases = allDetails.filter(x => x.entryTriggered1Pct && !x.breakoutFail);

  console.log(`\n📊 VPR H그룹 눌림 재돌파 감사 보고서`);
  console.log(`  H그룹 (1pct 돌파 + 종가 유지): ${hCases.length}건 / 전체 ${allDetails.length}건`);

  const candidates = [];
  let dataInsufficient = 0;

  for (const hc of hCases) {
    const chartPath = path.join(CHART_DIR, `${hc.code}.json`);
    if (!fs.existsSync(chartPath)) {
      candidates.push({
        code: hc.code, name: hc.name, market: hc.market,
        qvaDate: hc.qvaSignalDate, vviDate: hc.vviDate, hDate: hc.entryDate,
        vpr: { vprStatus: 'DATA_INSUFFICIENT', vprLabel: '데이터 부족',
               result: { vprStatus: 'DATA_INSUFFICIENT', vprLabel: '데이터 부족',
                         isClassicVprSuccess: false, isStrongVprSuccess: false, isVprFailure: false } },
        oneLineSummary: '차트 캐시에 종목 파일이 없어 분석 불가.',
      });
      dataInsufficient++;
      continue;
    }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(chartPath, 'utf-8')); } catch (_) { continue; }
    const rows = chart.rows || [];
    const vpr = analyzeVPR(hc, rows);
    const insufficient = vpr.vprStatus === 'DATA_INSUFFICIENT';
    if (insufficient) dataInsufficient++;
    candidates.push({
      code: hc.code,
      name: hc.name,
      market: hc.market,
      qvaDate: hc.qvaSignalDate,
      vviDate: hc.vviDate,
      hDate: hc.entryDate,
      currentStatus: vpr.snapshotStatus || null,
      currentStatusLabel: vpr.snapshotStatusLabel || null,
      vpr: insufficient ? { vprStatus: 'DATA_INSUFFICIENT', vprLabel: '데이터 부족',
                            reason: vpr.reason,
                            result: { vprStatus: 'DATA_INSUFFICIENT', vprLabel: '데이터 부족',
                                      isClassicVprSuccess: false, isStrongVprSuccess: false, isVprFailure: false } }
                        : vpr,
      oneLineSummary: insufficient ? `데이터 부족: ${vpr.reason}` : vpr.oneLineSummary,
    });
  }

  // ─── 그룹 집계 ───
  const analyzed = candidates.filter(c => c.vpr?.result?.vprStatus !== 'DATA_INSUFFICIENT');
  const byVprStatus = {
    ALL: analyzed,
    NORMAL_PULLBACK: analyzed.filter(c => c.vpr?.pullback?.pullbackType === 'NORMAL_PULLBACK'),
    DEEP_PULLBACK: analyzed.filter(c => c.vpr?.pullback?.pullbackType === 'DEEP_PULLBACK'),
    STRUCTURAL_BREAK: analyzed.filter(c => c.vpr?.pullback?.pullbackType === 'STRUCTURAL_BREAK'),
    NO_PULLBACK_RUNAWAY: analyzed.filter(c => c.vpr?.pullback?.pullbackType === 'NO_PULLBACK'),
    CLASSIC_VPR_SUCCESS: analyzed.filter(c => c.vpr?.result?.isClassicVprSuccess),
    STRONG_VPR_SUCCESS: analyzed.filter(c => c.vpr?.result?.isStrongVprSuccess),
    WEAK_VPR_REBOUND: analyzed.filter(c => c.vpr?.result?.isWeakVprRebound),
    REBOUND_FAIL: analyzed.filter(c => c.vpr?.result?.vprStatus === 'REBOUND_FAIL'),
    PULLBACK_PENDING: analyzed.filter(c => c.vpr?.result?.vprStatus === 'PULLBACK_PENDING'),
  };
  const groupLabels = {
    ALL: 'H그룹 전체',
    NORMAL_PULLBACK: '정상 눌림',
    DEEP_PULLBACK: '깊은 눌림',
    STRUCTURAL_BREAK: '구조 훼손',
    NO_PULLBACK_RUNAWAY: '눌림 없이 상승',
    CLASSIC_VPR_SUCCESS: '정석 VPR 성공',
    STRONG_VPR_SUCCESS: '강한 VPR 성공',
    WEAK_VPR_REBOUND: 'VPR 재돌파 약함',
    REBOUND_FAIL: '재돌파 실패',
    PULLBACK_PENDING: 'VPR 대기',
  };
  const summaryGroups = Object.keys(byVprStatus).map(k =>
    Object.assign({ key: k }, summarizeGroup(groupLabels[k], byVprStatus[k])));

  // ─── 화면 상태 (스냅샷) 비교 ───
  const byStatus = {
    REVIEW_OK: analyzed.filter(c => c.currentStatus === 'REVIEW_OK'),
    CHASE_CAUTION: analyzed.filter(c => c.currentStatus === 'CHASE_CAUTION'),
    PULLBACK_WAIT: analyzed.filter(c => c.currentStatus === 'PULLBACK_WAIT'),
    MANAGEMENT: analyzed.filter(c => c.currentStatus === 'MANAGEMENT'),
    BREAKDOWN_WEAK: analyzed.filter(c => c.currentStatus === 'BREAKDOWN_WEAK'),
  };
  const statusGroups = Object.keys(byStatus).map(k =>
    Object.assign({ key: k }, summarizeGroup(STATUS_LABEL[k], byStatus[k])));

  // ─── 대표 사례 ───
  const successCases = analyzed
    .filter(c => c.vpr?.result?.isClassicVprSuccess)
    .sort((a, b) => (b.vpr?.result?.maxHighReturnAfterRebound ?? -Infinity)
                  - (a.vpr?.result?.maxHighReturnAfterRebound ?? -Infinity))
    .slice(0, 10);
  const failureCases = analyzed
    .filter(c => c.vpr?.result?.isVprFailure)
    .sort((a, b) => (a.vpr?.pullback?.closeDrawdownFromEntryPct ?? 0)
                  - (b.vpr?.pullback?.closeDrawdownFromEntryPct ?? 0))
    .slice(0, 10);

  // ─── 결론 ───
  const keyFindings = buildKeyFindings(summaryGroups, statusGroups);

  // ─── summary 타일 ───
  const allG = summaryGroups.find(g => g.key === 'ALL');
  const summary = {
    hgroupAnalyzedCount: analyzed.length,
    hgroupTotalCount: hCases.length,
    dataInsufficientCount: dataInsufficient,
    pullbackWaitCount: byStatus.PULLBACK_WAIT.length,
    classicSuccessCount: byVprStatus.CLASSIC_VPR_SUCCESS.length,
    strongSuccessCount: byVprStatus.STRONG_VPR_SUCCESS.length,
    weakReboundCount: byVprStatus.WEAK_VPR_REBOUND.length,
    structuralBreakCount: byVprStatus.STRUCTURAL_BREAK.length,
    noPullbackCount: byVprStatus.NO_PULLBACK_RUNAWAY.length,
    reboundFailCount: byVprStatus.REBOUND_FAIL.length,
    pendingCount: byVprStatus.PULLBACK_PENDING.length,
    overallVprSuccessRate: allG?.vprSuccessRate ?? null,
    pullbackWaitVprSuccessRate: statusGroups.find(g => g.key === 'PULLBACK_WAIT')?.vprSuccessRate ?? null,
    avgHighReturnAfterRebound: avg(analyzed
      .filter(c => c.vpr?.rebound?.hasVprRebound)
      .map(c => c.vpr?.result?.maxHighReturnAfterRebound)),
  };

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: '돌파 후 눌림 재상승 후보 (VPR H그룹 감사)',
      purpose: 'QVA → VVI → 돌파 성공(H그룹) 이후 눌림대기 상태였던 종목들이 다시 재돌파/재상승했는지 확인하는 감사 보고서',
      notice: 'VPR은 매수 확정 신호가 아니라, H그룹 이후 눌림 재돌파가 의미 있는 후속 신호인지 검증하기 위한 분석입니다.',
      hgroupSource: 'qva-vvi-breakout-entry-report.json (entryTriggered1Pct && !breakoutFail)',
      hgroupCriteria: 'QVA → VVI → 다음 거래일 vviHigh × 1.01 돌파 + 종가 ≥ vviHigh',
    },
    config: CONFIG,
    summary,
    summaryGroups,
    statusGroups,
    candidates,
    examples: {
      successCases,
      failureCases,
    },
    keyFindings,
    dataLimit: [
      'VPR은 H그룹 이후 눌림 재돌파를 확인하는 감사 보고서이며, 매수 확정 신호가 아닙니다.',
      'QVA/VVI/H그룹 계산 로직 자체는 변경하지 않습니다. 입력 H그룹은 qva-vvi-breakout-entry-report.json의 H = E_excludeBreakoutFail 그룹을 그대로 사용합니다.',
      `현재 차트 캐시는 약 120거래일치이므로, 그 이전 H돌파일은 "데이터 부족"으로 분류됩니다 (이번 분석에서 ${dataInsufficient}건).`,
      `H돌파일 이후 ${CONFIG.PULLBACK_LOOKAHEAD_DAYS}거래일 안의 단기 감사이며, 재돌파일 이후 성과는 ${CONFIG.POST_REBOUND_DAYS.join('/')}일 윈도우로만 측정합니다.`,
      `화면 상태(눌림 대기 / 관리 / 돌파 약화)는 운영 보드(qva-watchlist-board.js)의 judgmentStatus 로직을 H돌파일 + ${CONFIG.STATUS_SNAPSHOT_DAY}거래일 시점에 적용한 스냅샷입니다.`,
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  console.log(`\n📊 VPR 분류 결과:`);
  for (const g of summaryGroups) {
    if (!g.count) continue;
    const tag = g.key === 'CLASSIC_VPR_SUCCESS' || g.key === 'STRONG_VPR_SUCCESS' ? '✅' :
                g.key === 'STRUCTURAL_BREAK' || g.key === 'REBOUND_FAIL' ? '❌' :
                g.key === 'NO_PULLBACK_RUNAWAY' ? '🚀' : '  ';
    console.log(`  ${tag} ${g.label.padEnd(16)} n=${String(g.count).padStart(4)}  H+10일 고가 ${String(g.avgHighReturn10 ?? '-').padStart(7)}% / 종가 ${String(g.avgCloseReturn10 ?? '-').padStart(7)}% / VPR성공률 ${String(g.vprSuccessRate ?? '-').padStart(5)}%`);
  }

  console.log(`\n📊 화면 상태별 (H돌파일 +${CONFIG.STATUS_SNAPSHOT_DAY}거래일 스냅샷):`);
  for (const g of statusGroups) {
    if (!g.count) continue;
    console.log(`  ${g.label.padEnd(10)} n=${String(g.count).padStart(4)}  VPR성공률 ${String(g.vprSuccessRate ?? '-').padStart(5)}%  / H+10 고가 ${String(g.avgHighReturn10 ?? '-').padStart(7)}%`);
  }

  console.log(`\n📝 자동 결론:`);
  for (const f of keyFindings) console.log('  - ' + f);

  // HTML
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>돌파 후 눌림 재상승 후보 — VPR H그룹 감사</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
  -webkit-overflow-scrolling: touch;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 14px 0 8px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; }
.purpose-box strong { color: #67e8f9; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }
.note-box { background: #1e293b; border-left: 4px solid #fbbf24; padding: 10px 14px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.7; }

.big-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.big-tile { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.big-tile.primary { border-left: 4px solid #0ea5e9; }
.big-tile.primary .value { color: #67e8f9; }
.big-tile.success { border-left: 4px solid #14b8a6; }
.big-tile.success .value { color: #5eead4; }
.big-tile.warn { border-left: 4px solid #f59e0b; }
.big-tile.warn .value { color: #fde047; }
.big-tile.fail { border-left: 4px solid #ef4444; }
.big-tile.fail .value { color: #fca5a5; }
.big-tile .label { font-size: 11px; color: #94a3b8; }
.big-tile .value { font-size: 18px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-top: 3px; }
.big-tile .sub { font-size: 11px; color: #64748b; margin-top: 3px; }

.tabs { display: flex; gap: 6px; margin: 18px 0 8px; flex-wrap: wrap; }
.tab-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-weight: 500; }
.tab-btn:hover { color: #f1f5f9; border-color: #64748b; }
.tab-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }

table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
table.cmp thead th { background: #0f172a; color: #94a3b8; font-weight: 600; padding: 9px 12px; border-bottom: 1px solid #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; text-align: right; }
table.cmp thead th:first-child { text-align: left; }
table.cmp tbody td { padding: 8px 12px; border-bottom: 1px solid #334155; text-align: right; font-variant-numeric: tabular-nums; }
table.cmp tbody td:first-child { text-align: left; color: #cbd5e1; font-weight: 600; }
table.cmp tbody tr:hover td { background: #273549; }
.row-highlight td { background: rgba(13, 148, 136, 0.18) !important; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-warn { color: #fde047; }

.tbl-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.list { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
table.list thead th { background: #0f172a; color: #94a3b8; font-weight: 600; text-align: left; padding: 9px 12px; border-bottom: 1px solid #334155; white-space: nowrap; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
table.list thead th.numeric { text-align: right; }
table.list tbody tr.row { border-bottom: 1px solid #1e293b; }
table.list tbody tr.row:hover { background: #273549; }
table.list tbody tr.row td { padding: 8px 12px; vertical-align: middle; line-height: 1.3; white-space: nowrap; }
table.list tbody tr.row td.numeric { text-align: right; }
table.list tbody tr.row td.col-name { font-weight: 600; color: #f1f5f9; min-width: 120px; }
table.list tbody tr.row td.col-name .meta { display: block; font-size: 10px; color: #64748b; font-weight: 400; margin-top: 2px; }
table.list tbody tr.row td.col-summary { color: #cbd5e1; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: normal; line-height: 1.4; font-size: 11.5px; }
table.list tbody tr.row:nth-child(odd) { background: #1c2942; }
table.list tbody tr.row:nth-child(odd):hover { background: #273549; }

.vpr-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.vpr-pill.STRONG_VPR_SUCCESS { background: #064e3b; color: #6ee7b7; }
.vpr-pill.CLASSIC_VPR_SUCCESS { background: #134e4a; color: #5eead4; }
.vpr-pill.WEAK_VPR_REBOUND { background: #422006; color: #fde047; }
.vpr-pill.PULLBACK_PENDING { background: #312e81; color: #c7d2fe; }
.vpr-pill.REBOUND_FAIL { background: #7f1d1d; color: #fca5a5; }
.vpr-pill.STRUCTURAL_BREAK { background: #7c2d12; color: #fdba74; }
.vpr-pill.NO_PULLBACK_RUNAWAY { background: #1e3a8a; color: #93c5fd; }
.vpr-pill.DATA_INSUFFICIENT { background: #475569; color: #cbd5e1; }

.status-pill { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 600; }
.status-pill.REVIEW_OK { background: #065f46; color: #6ee7b7; }
.status-pill.CHASE_CAUTION { background: #78350f; color: #fde047; }
.status-pill.PULLBACK_WAIT { background: #1e40af; color: #bfdbfe; }
.status-pill.MANAGEMENT { background: #4c1d95; color: #ddd6fe; }
.status-pill.BREAKDOWN_WEAK { background: #7f1d1d; color: #fca5a5; }

.findings { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; }
.findings ul { margin: 0; padding-left: 20px; line-height: 1.8; }
.findings li { color: #cbd5e1; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
footer.foot strong { color: #fde68a; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; max-width: 100%; }
  html, body { overflow-x: hidden; overflow-y: auto; }
  .tbl-wrap { overflow-x: auto !important; }
  .col-mobile-hide,
  table.list thead th.col-mobile-hide { display: none; }
}
</style>
</head>
<body>

<h1>돌파 후 눌림 재상승 후보 — VPR H그룹 감사</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  이 보고서는 <strong>QVA → VVI → 돌파 성공(H그룹)</strong> 이후 눌림대기 상태였던 종목들이
  다시 재돌파하거나 재상승했는지 확인하는 감사 보고서입니다. <strong>VPR = Volume Pullback Rebound</strong>.
</div>

<div class="warn-banner">
  ⚠️ <strong>VPR은 현재 매수확정 신호가 아닙니다.</strong> H그룹 이후 눌림 재돌파가 의미 있는 후속 신호인지 검증하기 위한 분석입니다.
  QVA/VVI/H그룹 정의는 변경하지 않았으며, 입력 H그룹은 기존 보고서를 그대로 사용합니다.
</div>

<div class="note-box">
  💡 <strong>VPR 흐름</strong>: QVA → VVI → 돌파 성공(H그룹) → 눌림 → 기준 가격 유지 → 재돌파 / 재상승.
  H그룹 돌파일 이후 1~10거래일 안에 어떤 형태로 눌림이 만들어졌고, 그 이후 다시 위쪽 가격을 회복했는지를 분류합니다.
</div>

<h2>📊 핵심 타일</h2>
<div class="big-summary" id="big-summary"></div>

<h2>📊 VPR 분류별 성과</h2>
<p class="subtitle">H돌파일 종가 대비 이후 10거래일 고가/종가 성과 + VPR 재돌파일 종가 기준 후속 5/10일 성과.</p>
<div id="vpr-perf-table"></div>

<h2>📊 화면 상태별 비교 (눌림 대기 / 관리 / 돌파 악화)</h2>
<p class="subtitle">H돌파일 +3거래일 시점 스냅샷 기준. 운영 보드의 judgmentStatus 로직을 그대로 적용한 과거 시점 시뮬레이션입니다.</p>
<div id="status-perf-table"></div>

<h2>📝 자동 결론</h2>
<div class="findings" id="findings"></div>

<h2>🏆 H그룹 사례 리스트</h2>
<div class="tabs" id="tabs"></div>
<div class="tbl-wrap">
  <table class="list">
    <thead>
      <tr>
        <th>#</th>
        <th>종목</th>
        <th class="col-mobile-hide">QVA</th>
        <th class="col-mobile-hide">VVI</th>
        <th class="col-mobile-hide">H돌파일</th>
        <th>화면 상태</th>
        <th>VPR 상태</th>
        <th class="numeric col-mobile-hide">기준가</th>
        <th class="numeric col-mobile-hide">눌림률(종가)</th>
        <th class="col-mobile-hide">재돌파일</th>
        <th class="numeric col-mobile-hide">소요</th>
        <th class="numeric">재돌파 후 고가↑</th>
        <th class="numeric col-mobile-hide">종가↑</th>
        <th class="numeric col-mobile-hide">거래대금배수</th>
        <th class="col-summary">한 줄 해석</th>
      </tr>
    </thead>
    <tbody id="list-body"></tbody>
  </table>
</div>

<footer class="foot" id="data-limit"></footer>

<script>
const DATA = __JSON_DATA__;

function fmt(v, d = 2, suffix = '') {
  if (v == null || !isFinite(v)) return '-';
  return v.toFixed(d) + suffix;
}
function fmtPct(v) {
  if (v == null || !isFinite(v)) return '-';
  const cls = v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : '');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>';
}
function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}

document.getElementById('subtitle').textContent =
  'H그룹 ' + DATA.summary.hgroupTotalCount + '건 중 ' + DATA.summary.hgroupAnalyzedCount +
  '건 분석 (데이터 부족 ' + DATA.summary.dataInsufficientCount + '건 제외) · ' +
  '생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

const tiles = [
  { cls: 'primary', label: 'H그룹 분석 사례', value: DATA.summary.hgroupAnalyzedCount, sub: '전체 ' + DATA.summary.hgroupTotalCount + '건' },
  { cls: 'primary', label: '눌림 대기 사례', value: DATA.summary.pullbackWaitCount, sub: 'H+3일 스냅샷' },
  { cls: 'success', label: '정석 VPR 성공', value: DATA.summary.classicSuccessCount },
  { cls: 'success', label: '강한 VPR 성공', value: DATA.summary.strongSuccessCount },
  { cls: 'warn', label: 'VPR 재돌파 약함', value: DATA.summary.weakReboundCount ?? 0 },
  { cls: 'success', label: 'VPR 성공률', value: (DATA.summary.overallVprSuccessRate ?? 0).toFixed(1) + '%', sub: 'H그룹 전체' },
  { cls: 'primary', label: '눌림대기 VPR 성공률', value: (DATA.summary.pullbackWaitVprSuccessRate ?? 0).toFixed(1) + '%' },
  { cls: 'fail', label: '구조 훼손', value: DATA.summary.structuralBreakCount },
  { cls: 'warn', label: '재돌파 후 평균 고가↑', value: (DATA.summary.avgHighReturnAfterRebound ?? 0).toFixed(1) + '%', sub: '+10일 윈도우' },
];
document.getElementById('big-summary').innerHTML = tiles.map(t =>
  '<div class="big-tile ' + t.cls + '">' +
    '<div class="label">' + t.label + '</div>' +
    '<div class="value">' + t.value + '</div>' +
    (t.sub ? '<div class="sub">' + t.sub + '</div>' : '') +
  '</div>'
).join('');

function perfTable(rows, highlightKeys = []) {
  const html = ['<table class="cmp"><thead><tr>',
    '<th>그룹</th>',
    '<th>사례 수</th>',
    '<th>VPR 성공률</th>',
    '<th>강한 VPR</th>',
    '<th>재돌파 발생률</th>',
    '<th>H+10 평균 고가↑</th>',
    '<th>H+10 평균 종가↑</th>',
    '<th>+5% 반응</th>',
    '<th>-5% 종가</th>',
    '<th>재돌파 후 평균 고가↑</th>',
    '<th>재돌파 후 평균 종가↑</th>',
    '<th>평균 소요일</th>',
    '<th>재돌파 거래대금배수</th>',
    '</tr></thead><tbody>'];
  for (const r of rows) {
    const hi = highlightKeys.includes(r.key) ? ' class="row-highlight"' : '';
    html.push('<tr' + hi + '>' +
      '<td>' + r.label + '</td>' +
      '<td>' + (r.count ?? '-') + '</td>' +
      '<td>' + (r.vprSuccessRate != null ? r.vprSuccessRate + '%' : '-') + '</td>' +
      '<td>' + (r.strongVprRate != null ? r.strongVprRate + '%' : '-') + '</td>' +
      '<td>' + (r.reboundRate != null ? r.reboundRate + '%' : '-') + '</td>' +
      '<td>' + fmtPct(r.avgHighReturn10) + '</td>' +
      '<td>' + fmtPct(r.avgCloseReturn10) + '</td>' +
      '<td>' + (r.plus5HitRate != null ? r.plus5HitRate + '%' : '-') + '</td>' +
      '<td>' + (r.minus5CloseRate != null ? r.minus5CloseRate + '%' : '-') + '</td>' +
      '<td>' + fmtPct(r.avgReboundMfe10) + '</td>' +
      '<td>' + fmtPct(r.avgReboundClose10) + '</td>' +
      '<td>' + (r.avgDaysToRebound != null ? r.avgDaysToRebound.toFixed(1) + '일' : '-') + '</td>' +
      '<td>' + (r.avgReboundValueRatio != null ? r.avgReboundValueRatio.toFixed(2) + '×' : '-') + '</td>' +
      '</tr>');
  }
  html.push('</tbody></table>');
  return html.join('');
}
document.getElementById('vpr-perf-table').innerHTML = perfTable(DATA.summaryGroups, ['CLASSIC_VPR_SUCCESS', 'STRONG_VPR_SUCCESS']);
document.getElementById('status-perf-table').innerHTML = perfTable(DATA.statusGroups, ['PULLBACK_WAIT']);

document.getElementById('findings').innerHTML =
  (DATA.keyFindings && DATA.keyFindings.length > 0)
    ? '<ul>' + DATA.keyFindings.map(f => '<li>' + f + '</li>').join('') + '</ul>'
    : '<p style="color:#94a3b8;">조건이 충족되지 않아 자동 결론이 생성되지 않았습니다.</p>';

const TAB_DEF = [
  { key: 'all', label: '전체', filter: c => c.vpr?.result?.vprStatus !== 'DATA_INSUFFICIENT' },
  { key: 'pullback_wait', label: '눌림 대기', filter: c => c.currentStatus === 'PULLBACK_WAIT' },
  { key: 'classic', label: '정석 VPR 성공', filter: c => c.vpr?.result?.isClassicVprSuccess },
  { key: 'strong', label: '강한 VPR 성공', filter: c => c.vpr?.result?.isStrongVprSuccess },
  { key: 'weak', label: 'VPR 재돌파 약함', filter: c => c.vpr?.result?.isWeakVprRebound },
  { key: 'pending', label: 'VPR 대기', filter: c => c.vpr?.result?.vprStatus === 'PULLBACK_PENDING' },
  { key: 'fail', label: '재돌파 실패', filter: c => c.vpr?.result?.vprStatus === 'REBOUND_FAIL' },
  { key: 'broken', label: '구조 훼손', filter: c => c.vpr?.result?.vprStatus === 'STRUCTURAL_BREAK' },
  { key: 'runaway', label: '눌림 없이 상승', filter: c => c.vpr?.result?.vprStatus === 'NO_PULLBACK_RUNAWAY' },
  { key: 'insufficient', label: '데이터 부족', filter: c => c.vpr?.result?.vprStatus === 'DATA_INSUFFICIENT' },
];
let currentTab = 'all';
document.getElementById('tabs').innerHTML = TAB_DEF.map(t =>
  '<button class="tab-btn' + (t.key === currentTab ? ' active' : '') + '" data-tab="' + t.key + '">' + t.label + '</button>'
).join('');
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTab = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderList();
  });
});

function renderList() {
  const tabDef = TAB_DEF.find(t => t.key === currentTab);
  const filtered = DATA.candidates.filter(tabDef.filter)
    .sort((a, b) => {
      const order = { STRONG_VPR_SUCCESS: 0, CLASSIC_VPR_SUCCESS: 1, WEAK_VPR_REBOUND: 2, PULLBACK_PENDING: 3, NO_PULLBACK_RUNAWAY: 4, REBOUND_FAIL: 5, STRUCTURAL_BREAK: 6, DATA_INSUFFICIENT: 9 };
      const oa = order[a.vpr?.result?.vprStatus] ?? 7;
      const ob = order[b.vpr?.result?.vprStatus] ?? 7;
      if (oa !== ob) return oa - ob;
      return (b.vpr?.result?.maxHighReturnAfterRebound ?? -Infinity)
           - (a.vpr?.result?.maxHighReturnAfterRebound ?? -Infinity);
    });
  const html = filtered.map((c, i) => {
    const v = c.vpr || {};
    const r = v.result || {};
    const p = v.pullback || {};
    const rb = v.rebound || {};
    return '<tr class="row">' +
      '<td>' + (i + 1) + '</td>' +
      '<td class="col-name">' + c.name + '<span class="meta">' + c.code + ' · ' + (c.market || '-') + '</span></td>' +
      '<td class="col-mobile-hide">' + fmtDate(c.qvaDate) + '</td>' +
      '<td class="col-mobile-hide">' + fmtDate(c.vviDate) + '</td>' +
      '<td class="col-mobile-hide">' + fmtDate(c.hDate) + '</td>' +
      '<td>' + (c.currentStatus
        ? '<span class="status-pill ' + c.currentStatus + '">' + (c.currentStatusLabel || c.currentStatus) + '</span>'
        : '-') + '</td>' +
      '<td><span class="vpr-pill ' + (r.vprStatus || 'DATA_INSUFFICIENT') + '">' + (r.vprLabel || '-') + '</span></td>' +
      '<td class="numeric col-mobile-hide">' + (v.base?.entryPrice != null ? v.base.entryPrice.toLocaleString() : '-') + '</td>' +
      '<td class="numeric col-mobile-hide">' + fmtPct(p.closeDrawdownFromEntryPct) + '</td>' +
      '<td class="col-mobile-hide">' + fmtDate(rb.reboundDate) + '</td>' +
      '<td class="numeric col-mobile-hide">' + (rb.daysToRebound != null ? rb.daysToRebound + '일' : '-') + '</td>' +
      '<td class="numeric">' + fmtPct(r.maxHighReturnAfterRebound) + '</td>' +
      '<td class="numeric col-mobile-hide">' + fmtPct(r.closeReturnAfterRebound) + '</td>' +
      '<td class="numeric col-mobile-hide">' + (rb.reboundValueVsPullbackAvg != null ? rb.reboundValueVsPullbackAvg.toFixed(2) + '×' : '-') + '</td>' +
      '<td class="col-summary">' + (c.oneLineSummary || '-') + '</td>' +
      '</tr>';
  }).join('');
  document.getElementById('list-body').innerHTML = html ||
    '<tr><td colspan="15" style="padding:20px; text-align:center; color:#64748b;">표시할 사례가 없습니다.</td></tr>';
}
renderList();

document.getElementById('data-limit').innerHTML =
  '<strong>데이터 한계</strong><br>' +
  (DATA.dataLimit || []).map(l => '• ' + l).join('<br>');
</script>

</body>
</html>
`;

main();
