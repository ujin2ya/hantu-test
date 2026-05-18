#!/usr/bin/env node
/**
 * 나스닥 테마 watch 보드 결과 → 1DS 장초 감시 후보풀 빌드
 *
 * 핵심:
 *   전일 미국장 강세 테마와 최근 국내 QVA1/QVA2/VVI2/1DS 흔적이 결합된 종목을
 *   다음 거래일 09시 1DS 우선 감시 후보풀로 변환. 매수 신호 X.
 *
 * 입력:
 *   - reports/nasdaq-theme-watch-board-result.json (candidates 배열)
 *
 * 출력:
 *   - reports/theme-1ds-watch-pool.json
 *   - reports/theme-1ds-watch-pool.html
 *
 * 중요:
 *   - 1DS 탐지 조건 변경 X. 기존 보드/라우터/cron 수정 X.
 *   - 매수 신호 X — "1DS 우선 감시 후보", "장초 감시", "발화 여부 확인" 표현만.
 *   - 새 라우터 추가 X (이 단계는 HTML 생성까지만).
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC_JSON = path.join(ROOT, 'reports', 'nasdaq-theme-watch-board-result.json');
const OUT_JSON = path.join(ROOT, 'reports', 'theme-1ds-watch-pool.json');
const OUT_HTML = path.join(ROOT, 'reports', 'theme-1ds-watch-pool.html');

// ─── 유틸 ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtPct(v) { if (v == null || !Number.isFinite(v)) return '—'; return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
function fmtVal(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e12) return (v/1e12).toFixed(1) + '조';
  if (v >= 1e8)  return (v/1e8).toFixed(0) + '억';
  if (v >= 1e4)  return (v/1e4).toFixed(0) + '만';
  return Math.round(v).toLocaleString();
}

// 종목 코드별 그룹 분류 (사용자 spec 2026-05-19: 테마 매칭 종목만 + WEAK도 별도 그룹)
function classifyGroup(c) {
  // ─── 방어 필터: 테마 매칭 없으면 풀에서 무조건 제외 ───
  const matched = c.matchedThemes || [];
  if (matched.length === 0 || c.bestThemeStrength === 'NONE' || !c.bestThemeKey) {
    return null;
  }

  const strong = c.bestThemeStrength === 'STRONG';
  const mid = c.bestThemeStrength === 'MID';
  const weak = c.bestThemeStrength === 'WEAK';
  const ab = c.grade === 'A' || c.grade === 'B';
  const anyQVA      = c.hasQva1 || c.hasQva2;
  const anyVVIorODS = c.hasVvi2 || c.hasOneDaySurge;
  const anySignal   = anyQVA || anyVVIorODS;

  // WEAK 테마는 우선순위 낮은 별도 그룹 — 신호 유무 무관
  if (weak) return 'GROUP_Z_WEAK_THEME';

  // STRONG/MID 테마 + grade A/B + 신호 → 최상위
  if ((strong || mid) && ab && anySignal) return 'GROUP_A_THEME_SIGNAL';
  // STRONG/MID + QVA1/QVA2
  if ((strong || mid) && anyQVA) return 'GROUP_B_THEME_QVA';
  // STRONG/MID + VVI2 또는 1DS (사용자 spec: 두 신호 모두 포함)
  if ((strong || mid) && anyVVIorODS) return 'GROUP_C_THEME_VVI';
  // STRONG/MID 테마만 (신호 약함, 참고)
  if ((strong || mid) && !anySignal) return 'GROUP_D_THEME_ONLY';

  // 그 외 — 풀에서 제외
  return null;
}

// theme1dsWatchScore 계산 (사용자 spec 2026-05-19 v2 — 완전 새 점수표)
function calcWatchScore(c, group) {
  let score = 0;

  // 기본 — 테마 강도
  if (c.bestThemeStrength === 'STRONG') score += 30;
  else if (c.bestThemeStrength === 'MID') score += 18;
  else if (c.bestThemeStrength === 'WEAK') score += 5;

  // 테마 매칭 방식 — 현재 directStockMatch만 지원, keywordMatch는 향후 확장
  if (c.themeMatchReason === 'directStockMatch') score += 15;
  else if (c.themeMatchReason === 'keywordMatch') score += 8;

  // 국내 신호
  if (c.hasQva2) score += 18;
  if (c.hasQva1) score += 12;
  if (c.hasVvi2) score += 18;
  if (c.hasOneDaySurge) score += 15;

  // 최근 신호 근접도 (5거래일 이내)
  const minDays = Math.min(
    c.qva1DaysAgo != null ? c.qva1DaysAgo : 999,
    c.qva2DaysAgo != null ? c.qva2DaysAgo : 999,
    c.vvi2DaysAgo != null ? c.vvi2DaysAgo : 999,
    c.oneDaySurgeDaysAgo != null ? c.oneDaySurgeDaysAgo : 999,
  );
  if (minDays <= 5) score += 5;

  // 오늘 흐름
  if (c.valueRatio20 != null && c.valueRatio20 >= 2) score += 8;
  if (c.latestChangePct != null && c.latestChangePct >= 3) score += 5;
  if (c.closeStrong) score += 5;

  // 감점
  if (group === 'GROUP_D_THEME_ONLY') score -= 10;
  if (c.bestThemeStrength === 'WEAK') score -= 10;
  if (c.alreadyExtended) score -= 10;
  if (c.recentMaxDrop != null && c.recentMaxDrop <= -10) score -= 5;

  return Math.max(0, score);
}

// 등급 분류 — score + 그룹/테마 상한
function classifyWatchGrade(score, group, c) {
  const strength = c.bestThemeStrength;
  const matchedCount = (c.matchedThemes || []).length;
  const anySignal = c.hasQva1 || c.hasQva2 || c.hasVvi2 || c.hasOneDaySurge;

  // ─── GROUP_Z_WEAK_THEME: 무조건 WATCH_D (기본 접기) ───
  if (group === 'GROUP_Z_WEAK_THEME') return 'WATCH_D';

  // ─── WATCH_A: STRONG/MID 테마 + 매칭 + 신호 + GROUP_A/B/C + score≥80 ───
  const eligibleA =
    (strength === 'STRONG' || strength === 'MID') &&
    matchedCount >= 1 &&
    ['GROUP_A_THEME_SIGNAL', 'GROUP_B_THEME_QVA', 'GROUP_C_THEME_VVI'].includes(group) &&
    anySignal &&
    score >= 80;
  if (eligibleA) return 'WATCH_A';

  // ─── WATCH_B: STRONG/MID 테마 + 매칭 + 신호 + score≥60 ───
  const eligibleB =
    (strength === 'STRONG' || strength === 'MID') &&
    matchedCount >= 1 &&
    anySignal &&
    score >= 60;
  if (eligibleB) return 'WATCH_B';

  // ─── GROUP_D_THEME_ONLY: 최대 WATCH_C (테마는 있지만 국내 신호 약) ───
  if (group === 'GROUP_D_THEME_ONLY') {
    return score >= 40 ? 'WATCH_C' : 'WATCH_D';
  }

  // 일반: score 기준
  if (score >= 40) return 'WATCH_C';
  return 'WATCH_D';
}

// suggested1dsCheckPoints
function buildCheckPoints(c) {
  const pts = [];
  pts.push('09:00~09:10 거래대금 증가 확인');
  if (c.hasQva1 || c.hasQva2)  pts.push('QVA 고가 접근 여부 확인');
  if (c.hasVvi2)               pts.push('VVI2 anchor 가격 위 유지 확인');
  if (c.hasOneDaySurge)        pts.push('직전 1DS 신호가 위 가격 유지 확인');
  pts.push('시초가 이후 양봉 유지 확인');
  pts.push('테마 관련 뉴스/공시 확인');
  if (c.alreadyExtended) pts.push('⚠ 이미 신고가권 — 추격 진입 주의');
  if (c.recentMaxDrop != null && c.recentMaxDrop <= -10) pts.push('⚠ 최근 -10%↑ 흔들림 — 손절 라인 준비');
  return pts;
}

// 후보별 watchReason — watchGrade 기준 (사용자 spec 2026-05-19 v2)
function buildWatchReason(c, group, watchGrade) {
  const themeLabel = c.bestThemeLabel || '—';
  const strength = c.bestThemeStrength;

  if (watchGrade === 'WATCH_A') {
    const sig = c.hasQva2 ? `QVA2 ${c.qva2DaysAgo}일 전` :
                c.hasQva1 ? `QVA1 ${c.qva1DaysAgo}일 전` :
                c.hasVvi2 ? `VVI2 ${c.vvi2DaysAgo}일 전` :
                c.hasOneDaySurge ? `1DS ${c.oneDaySurgeDaysAgo}일 전` : '신호';
    return `전일 미국장 ${themeLabel} ${strength} + 최근 ${sig} → 09시 1DS 발화 여부 최우선 확인`;
  }
  if (watchGrade === 'WATCH_B') {
    return `${themeLabel} ${strength} + 최근 수급 흔적 → 장초 거래대금 증가 확인`;
  }
  if (watchGrade === 'WATCH_C') {
    return `미국장 테마는 강하지만 국내 수급 신호는 약함 → 참고 감시`;
  }
  // WATCH_D
  return `테마 매칭은 있으나 우선순위 낮음 → 접기 참고`;
}

function buildRiskNotes(c) {
  const notes = [];
  if (c.alreadyExtended) notes.push('이미 신고가권 — 추격 주의');
  if (c.recentMaxDrop != null && c.recentMaxDrop <= -10) notes.push('최근 -10%↑ 흔들림');
  if (c.bestThemeStrength === 'WEAK') notes.push('테마 강도 약함');
  return notes;
}

// 우선순위 정렬 키
function morningPriorityRank(watchGrade) {
  return { WATCH_A: 4, WATCH_B: 3, WATCH_C: 2, WATCH_D: 1 }[watchGrade] || 0;
}

// ─── 메인 ────────────────────────────────────────────────────────────────
function main() {
  console.log('🌎 나스닥 테마 → 1DS 장초 감시 후보풀 빌드');
  const t0 = Date.now();

  if (!fs.existsSync(SRC_JSON)) {
    console.error(`❌ 입력 파일 없음: ${SRC_JSON}`);
    console.error(`   먼저 boards/theme/nasdaq-theme-watch-board.js 실행 필요`);
    process.exit(1);
  }
  const src = JSON.parse(fs.readFileSync(SRC_JSON, 'utf-8'));
  console.log(`  source: ${SRC_JSON}`);
  console.log(`  source candidates: ${src.candidates.length}건 / 테마 기준일 ${src.themeDate}`);

  // 후보 분류 + 점수 (그룹 결정 → 점수 계산 → 등급 분류 순)
  const pool = [];
  for (const c of src.candidates) {
    const group = classifyGroup(c);
    if (!group) continue;
    const score = calcWatchScore(c, group);
    const watchGrade = classifyWatchGrade(score, group, c);
    const watchReason = buildWatchReason(c, group, watchGrade);
    const riskNotes = buildRiskNotes(c);
    const checkPoints = buildCheckPoints(c);
    pool.push({
      // 원본 후보 핵심 필드 (전체 src 그대로 가져옴)
      ...c,
      // 1DS 감시 추가 필드
      theme1dsWatchScore: score,
      watchGrade,
      watchGroup: group,
      watchReason,
      morningWatchPriority: morningPriorityRank(watchGrade) * 1000 + score,
      riskNotes,
      suggested1dsCheckPoints: checkPoints,
    });
  }

  // 정렬 — morningWatchPriority desc
  pool.sort((a, b) => b.morningWatchPriority - a.morningWatchPriority);

  // 그룹 묶음 (사용자 spec 2026-05-19 v2 — GROUP_Z 추가, GROUP_E 제거 유지)
  const grouped = {
    GROUP_A_THEME_SIGNAL: pool.filter(c => c.watchGroup === 'GROUP_A_THEME_SIGNAL'),
    GROUP_B_THEME_QVA:    pool.filter(c => c.watchGroup === 'GROUP_B_THEME_QVA'),
    GROUP_C_THEME_VVI:    pool.filter(c => c.watchGroup === 'GROUP_C_THEME_VVI'),
    GROUP_D_THEME_ONLY:   pool.filter(c => c.watchGroup === 'GROUP_D_THEME_ONLY'),
    GROUP_Z_WEAK_THEME:   pool.filter(c => c.watchGroup === 'GROUP_Z_WEAK_THEME'),
  };

  // 요약
  const summary = {
    totalCandidates: pool.length,
    watchA: pool.filter(c => c.watchGrade === 'WATCH_A').length,
    watchB: pool.filter(c => c.watchGrade === 'WATCH_B').length,
    watchC: pool.filter(c => c.watchGrade === 'WATCH_C').length,
    watchD: pool.filter(c => c.watchGrade === 'WATCH_D').length,
    strongThemeCandidates: pool.filter(c => c.bestThemeStrength === 'STRONG').length,
    midThemeCandidates:    pool.filter(c => c.bestThemeStrength === 'MID').length,
    weakThemeCandidates:   pool.filter(c => c.bestThemeStrength === 'WEAK').length,
    qvaLinked:           pool.filter(c => c.hasQva1 || c.hasQva2).length,
    qva1Linked:          pool.filter(c => c.hasQva1).length,
    qva2Linked:          pool.filter(c => c.hasQva2).length,
    vviLinked:           pool.filter(c => c.hasVvi2).length,
    oneDaySurgeLinked:   pool.filter(c => c.hasOneDaySurge).length,
    groupCounts: {
      GROUP_A_THEME_SIGNAL: grouped.GROUP_A_THEME_SIGNAL.length,
      GROUP_B_THEME_QVA:    grouped.GROUP_B_THEME_QVA.length,
      GROUP_C_THEME_VVI:    grouped.GROUP_C_THEME_VVI.length,
      GROUP_D_THEME_ONLY:   grouped.GROUP_D_THEME_ONLY.length,
      GROUP_Z_WEAK_THEME:   grouped.GROUP_Z_WEAK_THEME.length,
    },
  };

  const result = {
    generatedAt: new Date().toISOString(),
    source: 'nasdaq-theme-watch-board-result.json',
    themeDate: src.themeDate,
    usMarketDate: src.usMarketDate,
    summary,
    candidates: pool,
    grouped,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  console.log(`✅ JSON: ${OUT_JSON}`);
  fs.writeFileSync(OUT_HTML, renderHtml(result));
  console.log(`✅ HTML: ${OUT_HTML}`);

  // 콘솔 출력
  console.log();
  console.log('━'.repeat(80));
  console.log('=== 1DS 장초 감시 후보풀 요약 ===');
  console.log(`source: ${SRC_JSON} ✓`);
  console.log(`전체 후보: ${summary.totalCandidates}`);
  console.log(`  🔥 WATCH_A (09시 최우선): ${summary.watchA}`);
  console.log(`  ⏳ WATCH_B (장초 우선):   ${summary.watchB}`);
  console.log(`  👀 WATCH_C (테마 참고):   ${summary.watchC}`);
  console.log(`  📡 WATCH_D (참고):         ${summary.watchD}`);
  console.log(`STRONG 테마: ${summary.strongThemeCandidates} / MID 테마: ${summary.midThemeCandidates}`);
  console.log(`QVA1: ${summary.qva1Linked} / QVA2: ${summary.qva2Linked} / VVI2: ${summary.vviLinked} / 1DS: ${summary.oneDaySurgeLinked}`);
  console.log();
  console.log('그룹별:');
  console.log(`  GROUP_A 테마+신호:        ${summary.groupCounts.GROUP_A_THEME_SIGNAL}`);
  console.log(`  GROUP_B 테마+QVA:         ${summary.groupCounts.GROUP_B_THEME_QVA}`);
  console.log(`  GROUP_C 테마+VVI/1DS:     ${summary.groupCounts.GROUP_C_THEME_VVI}`);
  console.log(`  GROUP_D 테마만 (신호 약): ${summary.groupCounts.GROUP_D_THEME_ONLY}`);
  console.log(`  GROUP_Z WEAK 테마:        ${summary.groupCounts.GROUP_Z_WEAK_THEME}`);
  // (GROUP_E_SIGNAL_NO_THEME 제거됨 — 테마 매칭 없는 후보는 nasdaq-theme-watch-board에서 이미 제외)
  console.log();
  // ─── 등급 상한 + 그룹 필터 검증 ───────────────────────────────────────
  const watchAList = pool.filter(c => c.watchGrade === 'WATCH_A');
  const watchA_NoneStrength = watchAList.filter(c => c.bestThemeStrength === 'NONE').length;
  const watchA_GroupD       = watchAList.filter(c => c.watchGroup === 'GROUP_D_THEME_ONLY').length;
  const poolEmptyMatch      = pool.filter(c => !c.matchedThemes || c.matchedThemes.length === 0).length;
  const poolNoneStrength    = pool.filter(c => c.bestThemeStrength === 'NONE').length;
  const poolGroupE          = pool.filter(c => c.watchGroup === 'GROUP_E_SIGNAL_NO_THEME').length;
  console.log('=== 등급 상한 + 그룹 필터 검증 ===');
  console.log(`최종 1DS 감시 후보: ${pool.length}`);
  console.log(`  └ matchedThemes 빈 후보:  ${poolEmptyMatch} (기대 0) ${poolEmptyMatch === 0 ? '✓' : '❌'}`);
  console.log(`  └ bestThemeStrength=NONE: ${poolNoneStrength} (기대 0) ${poolNoneStrength === 0 ? '✓' : '❌'}`);
  console.log(`  └ GROUP_E_SIGNAL_NO_THEME: ${poolGroupE} (기대 0) ${poolGroupE === 0 ? '✓' : '❌'}`);
  console.log(`WATCH_A 전체: ${watchAList.length}`);
  console.log(`  └ bestThemeStrength=NONE: ${watchA_NoneStrength} (기대 0) ${watchA_NoneStrength === 0 ? '✓' : '❌'}`);
  console.log(`  └ GROUP_D_THEME_ONLY: ${watchA_GroupD} (기대 0) ${watchA_GroupD === 0 ? '✓' : '❌'}`);
  const countByGrade = (arr) => ({
    A: arr.filter(c => c.watchGrade === 'WATCH_A').length,
    B: arr.filter(c => c.watchGrade === 'WATCH_B').length,
    C: arr.filter(c => c.watchGrade === 'WATCH_C').length,
    D: arr.filter(c => c.watchGrade === 'WATCH_D').length,
  });
  const d = countByGrade(grouped.GROUP_D_THEME_ONLY);
  console.log(`GROUP_D 등급 분포: A ${d.A} / B ${d.B} / C ${d.C} / D ${d.D}`);
  console.log();
  console.log(`📝 1DS 보드에는 아직 통합하지 않음 — helper는 src/utils/theme1dsWatchPool.js`);
  console.log(`결과:`);
  console.log(`  JSON: ${OUT_JSON}`);
  console.log(`  HTML: ${OUT_HTML}`);
  console.log(`⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ─── HTML 렌더 ───────────────────────────────────────────────────────────
function renderHtml(result) {
  const { summary, candidates, grouped, themeDate, usMarketDate, generatedAt } = result;

  // 카드 JS 데이터 (모든 후보)
  const cardsForJs = candidates.map(c => ({
    code: c.code, name: c.name,
    watchGrade: c.watchGrade,
    watchGroup: c.watchGroup,
    score: c.theme1dsWatchScore,
    morningWatchPriority: c.morningWatchPriority,
    themeKey: c.bestThemeKey, themeLabel: c.bestThemeLabel || '—',
    themeStrength: c.bestThemeStrength || 'NONE',
    grade: c.grade, themeWatchScore: c.themeWatchScore,
    themeReason: c.bestThemeReason || null,
    matchedThemes: c.matchedThemes || [],
    hasQva1: c.hasQva1, qva1Date: c.qva1Date, qva1Score: c.qva1Score, qva1DaysAgo: c.qva1DaysAgo,
    hasQva2: c.hasQva2, qva2Date: c.qva2Date, qva2Score: c.qva2Score, qva2Type: c.qva2Type, qva2DaysAgo: c.qva2DaysAgo,
    hasVvi2: c.hasVvi2, vvi2Date: c.vvi2Date, vvi2DaysAgo: c.vvi2DaysAgo,
    hasOneds: c.hasOneDaySurge, onedsDate: c.oneDaySurgeDate, onedsScore: c.oneDaySurgeScore, onedsDaysAgo: c.oneDaySurgeDaysAgo,
    hasAnySignal: c.hasAnySignal,
    latestDate: c.latestDate, latestClose: c.latestClose, latestChangePct: c.latestChangePct,
    latestValue: c.latestValue, valueRatio20: c.valueRatio20,
    nearRecentHigh: c.nearRecentHigh, closeStrong: c.closeStrong, alreadyExtended: c.alreadyExtended,
    watchReason: c.watchReason,
    riskNotes: c.riskNotes || [],
    suggested1dsCheckPoints: c.suggested1dsCheckPoints || [],
  }));

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>나스닥 테마 기반 1DS 장초 감시 후보풀</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif; background: #0f172a; color: #cbd5e1; margin: 0; padding: 14px 18px 48px; max-width: 1500px; }
  h1 { color: #f1f5f9; font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #94a3b8; font-size: 12px; margin-bottom: 12px; }
  h2 { color: #5eead4; font-size: 16px; margin: 18px 0 8px; border-left: 3px solid #14b8a6; padding-left: 8px; }
  .note { background:#1e293b; border:1px solid #334155; color:#cbd5e1; padding:9px 13px; border-radius:6px; font-size:12px; margin: 8px 0 14px; line-height: 1.55; }

  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .stat { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 11px; }
  .stat .lbl { color: #94a3b8; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.2px; }
  .stat .val { color: #f1f5f9; font-size: 20px; font-weight: 700; margin-top: 2px; }
  .stat .sub { color: #94a3b8; font-size: 10.5px; margin-top: 2px; }

  /* 필터 바 */
  .filter-bar { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .filter-bar label { display: flex; flex-direction: column; font-size: 10.5px; color: #94a3b8; }
  .filter-bar select { background: #0f172a; color: #cbd5e1; border: 1px solid #334155; border-radius: 4px; padding: 4px 6px; font-size: 12px; min-width: 100px; margin-top: 2px; }
  .filter-bar button { background: #0f172a; color: #cbd5e1; border: 1px solid #334155; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .filter-bar button:hover { background: #334155; }
  .filter-bar .meta-count { color: #94a3b8; font-size: 11.5px; margin-left: auto; }

  /* 탭 */
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid #334155; margin-bottom: 12px; flex-wrap: wrap; }
  .tab { background: transparent; color: #94a3b8; border: none; padding: 8px 14px; cursor: pointer; font-size: 13px; font-weight: 600; border-bottom: 2px solid transparent; }
  .tab:hover { color: #cbd5e1; }
  .tab.active { color: #5eead4; border-bottom-color: #14b8a6; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 8px; }
  .cand { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 9px 12px; }
  .cand.hidden { display: none; }
  .cand[data-watch="WATCH_A"] { border-left: 3px solid #facc15; }
  .cand[data-watch="WATCH_B"] { border-left: 3px solid #a78bfa; }
  .cand[data-watch="WATCH_C"] { border-left: 3px solid #475569; }
  .cand[data-watch="WATCH_D"] { border-left: 3px solid #334155; opacity: 0.7; }

  .cand .row1 { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .cand .stock-link { text-decoration: none; color: inherit; display: inline-flex; align-items: baseline; gap: 4px; padding: 1px 4px; margin: -1px -4px; border-radius: 3px; transition: background 0.12s; }
  .cand .stock-link:hover { background: rgba(94, 234, 212, 0.12); }
  .cand .stock-link:hover .name { color: #5eead4; text-decoration: underline; text-decoration-color: #14b8a6; text-underline-offset: 2px; }
  .cand .name { color: #f1f5f9; font-weight: 700; font-size: 14px; transition: color 0.12s; }
  .cand .code { color: #64748b; font-size: 10.5px; font-family: ui-monospace, monospace; margin-left: 4px; }
  .cand .score { color: #f1f5f9; font-weight: 700; font-size: 16px; }

  .cand .row2 { font-size: 11px; color: #94a3b8; margin: 4px 0; display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  .cand .pill { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 600; }
  .p-strong { background: #422006; color: #fcd34d; border: 1px solid #b45309; }
  .p-mid    { background: #1e1b4b; color: #c4b5fd; border: 1px solid #4338ca; }
  .p-weak   { background: #0f172a; color: #94a3b8; border: 1px solid #334155; }
  .p-down   { background: #4c1d1d; color: #fca5a5; border: 1px solid #ef4444; }
  .p-none   { background: #0f172a; color: #475569; border: 1px solid #334155; }

  .p-watch-a { background: #422006; color: #fcd34d; border: 1px solid #facc15; font-weight: 700; }
  .p-watch-b { background: #1e1b4b; color: #c4b5fd; border: 1px solid #a78bfa; font-weight: 600; }
  .p-watch-c { background: #0f172a; color: #94a3b8; border: 1px solid #475569; }
  .p-watch-d { background: #0f172a; color: #64748b; border: 1px solid #334155; }

  .p-qva1 { background: #052e16; color: #86efac; border: 1px solid #166534; }
  .p-qva2 { background: #1e1b4b; color: #c4b5fd; border: 1px solid #4338ca; }
  .p-vvi2 { background: #1e3a8a; color: #93c5fd; border: 1px solid #3b82f6; }
  .p-ods  { background: #064e3b; color: #a7f3d0; border: 1px solid #10b981; }
  .p-risk { background: #4c1d1d; color: #fca5a5; border: 1px solid #ef4444; }

  .cand .reason { font-size: 11.5px; color: #cbd5e1; margin-top: 6px; padding-top: 6px; border-top: 1px solid #334155; line-height: 1.5; }
  .cand .risk { font-size: 11px; color: #fca5a5; margin-top: 3px; }
  .cand details { margin-top: 6px; }
  .cand details summary { cursor: pointer; color: #5eead4; font-size: 11px; font-weight: 600; padding: 3px 0; }
  .cand details summary:hover { color: #99f6e4; }
  .cand details .details-body { font-size: 11px; color: #cbd5e1; padding: 6px 8px; background: #0f172a; border-radius: 4px; margin-top: 4px; line-height: 1.6; }
  .cand details .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; }
  .cand details .kv .k { color: #94a3b8; }
  .cand details .kv .v { color: #cbd5e1; }
  .cand details ul.checkpoints { margin: 4px 0; padding-left: 18px; font-size: 11px; color: #cbd5e1; }
  .cand details ul.checkpoints li { margin-bottom: 2px; }

  .show-more { display: block; width: 100%; margin-top: 8px; padding: 8px; background: #1e293b; border: 1px dashed #475569; border-radius: 6px; color: #94a3b8; font-size: 12px; font-weight: 600; cursor: pointer; }
  .show-more:hover { color: #cbd5e1; border-color: #64748b; }

  .group { margin-bottom: 12px; }
  .group > summary { cursor: pointer; padding: 8px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #f1f5f9; font-weight: 600; font-size: 13px; list-style: none; display: flex; justify-content: space-between; align-items: center; }
  .group > summary::-webkit-details-marker { display: none; }
  .group > summary::before { content: '▶'; color: #5eead4; font-size: 10px; margin-right: 8px; transition: transform 0.15s; }
  .group[open] > summary::before { transform: rotate(90deg); display: inline-block; }
  .group > summary .count { color: #94a3b8; font-size: 11.5px; font-weight: 400; }
  .group .group-body { padding: 8px 0 4px; }

  .empty { padding: 14px; text-align: center; color: #94a3b8; font-size: 12.5px; background: rgba(0,0,0,0.25); border: 1px dashed #334155; border-radius: 6px; margin: 6px 0; }

  /* 1DS 통합 시뮬레이션 */
  .sim-section { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 14px 18px; margin-top: 18px; }
  .sim-section h3 { color: #c4b5fd; margin: 0 0 8px; font-size: 14px; }
  .sim-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; margin: 2px 4px 2px 0; font-size: 11px; font-weight: 600; }
  .sim-card { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; margin: 4px 0; font-size: 12px; }

  @media (max-width: 720px) {
    body { padding: 10px; }
    .cards { grid-template-columns: 1fr; }
    .filter-bar select { min-width: 80px; font-size: 11px; }
    .tab { padding: 7px 10px; font-size: 12px; }
  }
</style>
</head>
<body>

<h1>🌎 나스닥 테마 기반 1DS 장초 감시 후보풀</h1>
<div class="subtitle">
  테마 기준일 ${esc(themeDate || '—')} · 미국장 ${esc(usMarketDate || '—')} · 생성 ${esc(generatedAt)}
</div>

<div class="note">
  전일 미국장 강세 테마와 최근 국내 수급 흔적을 결합해, <b>다음 거래일 09시 1DS 발화 여부</b>를 우선 확인할 후보를 정리한 화면입니다.
  매수 신호가 아니라 <b>장초 감시 후보풀</b>이며, 실제 판단은 09시 거래대금/전일 고가 접근/시초가 양봉 유지 등을 함께 확인해야 합니다.
  <br><b style="color:#fde68a;">이 화면에는 전일 미국장 테마와 매칭된 국내 종목만 표시</b>합니다. 테마 매칭이 없는 국내 QVA/VVI/1DS 후보는 기존 보드에서 확인합니다.
</div>

<!-- 요약 카드 -->
<div class="summary">
  <div class="stat"><div class="lbl">전체 후보</div><div class="val">${summary.totalCandidates}</div></div>
  <div class="stat"><div class="lbl">🔥 WATCH_A</div><div class="val" style="color:#facc15;">${summary.watchA}</div><div class="sub">09시 최우선</div></div>
  <div class="stat"><div class="lbl">⏳ WATCH_B</div><div class="val" style="color:#a78bfa;">${summary.watchB}</div><div class="sub">장초 우선</div></div>
  <div class="stat"><div class="lbl">STRONG 테마</div><div class="val" style="color:#fde047;">${summary.strongThemeCandidates}</div></div>
  <div class="stat"><div class="lbl">QVA1/QVA2 연결</div><div class="val">${summary.qvaLinked}</div></div>
  <div class="stat"><div class="lbl">VVI2/1DS 연결</div><div class="val">${summary.vviLinked + summary.oneDaySurgeLinked}</div></div>
</div>

<!-- 그룹 분포 -->
<details open style="margin-bottom: 12px;">
<summary style="cursor:pointer;color:#5eead4;font-size:12px;padding:4px 0;">📊 그룹별 분포</summary>
<table style="width:100%;border-collapse:collapse;font-size:11.5px;margin-top:6px;">
  <thead><tr style="background:#0f172a;color:#5eead4;"><th style="text-align:left;padding:5px 8px;border-bottom:1px solid #334155;">그룹</th><th style="text-align:right;padding:5px 8px;border-bottom:1px solid #334155;">건수</th><th style="text-align:left;padding:5px 8px;border-bottom:1px solid #334155;">설명</th></tr></thead>
  <tbody>
    <tr><td style="padding:5px 8px;border-bottom:1px solid #334155;"><b>GROUP_A 테마+신호</b></td><td style="text-align:right;padding:5px 8px;border-bottom:1px solid #334155;">${summary.groupCounts.GROUP_A_THEME_SIGNAL}</td><td style="padding:5px 8px;border-bottom:1px solid #334155;color:#94a3b8;">STRONG 테마 + grade A/B + 신호 (가장 핵심)</td></tr>
    <tr><td style="padding:5px 8px;border-bottom:1px solid #334155;"><b>GROUP_B 테마+QVA</b></td><td style="text-align:right;padding:5px 8px;border-bottom:1px solid #334155;">${summary.groupCounts.GROUP_B_THEME_QVA}</td><td style="padding:5px 8px;border-bottom:1px solid #334155;color:#94a3b8;">STRONG/MID 테마 + QVA1/QVA2 흔적</td></tr>
    <tr><td style="padding:5px 8px;border-bottom:1px solid #334155;"><b>GROUP_C 테마+VVI</b></td><td style="text-align:right;padding:5px 8px;border-bottom:1px solid #334155;">${summary.groupCounts.GROUP_C_THEME_VVI}</td><td style="padding:5px 8px;border-bottom:1px solid #334155;color:#94a3b8;">STRONG/MID 테마 + VVI2 흔적</td></tr>
    <tr><td style="padding:5px 8px;border-bottom:1px solid #334155;"><b>GROUP_D 테마만</b></td><td style="text-align:right;padding:5px 8px;border-bottom:1px solid #334155;">${summary.groupCounts.GROUP_D_THEME_ONLY}</td><td style="padding:5px 8px;border-bottom:1px solid #334155;color:#94a3b8;">STRONG/MID 테마 (국내 수급 약함, 참고)</td></tr>
    <tr><td style="padding:5px 8px;"><b>GROUP_Z WEAK 테마</b></td><td style="text-align:right;padding:5px 8px;">${summary.groupCounts.GROUP_Z_WEAK_THEME}</td><td style="padding:5px 8px;color:#94a3b8;">WEAK 테마 (우선순위 낮음, 기본 접기)</td></tr>
  </tbody>
</table>
</details>

<!-- 필터 바 -->
<div class="filter-bar">
  <label>강도<select id="f-strength"><option value="">전체</option><option value="STRONG">STRONG</option><option value="MID">MID</option><option value="WEAK">WEAK</option></select></label>
  <label>watchGrade<select id="f-watch"><option value="">전체</option><option value="WATCH_A">WATCH_A 최우선</option><option value="WATCH_B">WATCH_B 우선</option><option value="WATCH_C">WATCH_C 참고</option><option value="WATCH_D">WATCH_D</option></select></label>
  <label>신호<select id="f-signal"><option value="">전체</option><option value="QVA1">QVA1</option><option value="QVA2">QVA2</option><option value="VVI2">VVI2</option><option value="ODS">1DS</option><option value="NONE">신호 없음</option></select></label>
  <label>정렬<select id="f-sort"><option value="priority">우선순위(watchGrade+점수)</option><option value="score">1DS 감시 점수</option><option value="theme-score">테마 watch 점수</option><option value="recent">최근 신호순</option><option value="strength">테마 강도순</option><option value="value">거래대금순</option></select></label>
  <button onclick="resetFilters()">초기화</button>
  <span class="meta-count" id="meta-count">—</span>
</div>

<!-- 탭 -->
<div class="tabs">
  <button class="tab active" data-tab="watch-a">🔥 09시 최우선</button>
  <button class="tab" data-tab="watch-b">⏳ 장초 우선</button>
  <button class="tab" data-tab="by-theme">🎯 테마별</button>
  <button class="tab" data-tab="by-signal">📡 신호별</button>
  <button class="tab" data-tab="all">📋 전체</button>
</div>

<div class="tab-panel active" data-panel="watch-a"><h2>WATCH_A — 09시 최우선 감시 (theme1dsWatchScore ≥ 80)</h2><div id="panel-watch-a-cards" class="cards"></div></div>
<div class="tab-panel" data-panel="watch-b"><h2>WATCH_B — 장초 우선 감시 (60~79)</h2><div id="panel-watch-b-cards" class="cards"></div></div>
<div class="tab-panel" data-panel="by-theme"><h2>테마별 — STRONG 펼침</h2><div id="panel-theme-groups"></div></div>
<div class="tab-panel" data-panel="by-signal"><h2>신호별</h2><div id="panel-signal-groups"></div></div>
<div class="tab-panel" data-panel="all"><h2>전체 후보</h2><details id="all-details"><summary style="cursor:pointer;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#f1f5f9;font-weight:600;">전체 ${summary.totalCandidates}건 펼치기</summary><div id="panel-all-cards" class="cards" style="margin-top:8px;"></div></details></div>

<!-- 1DS 통합 시뮬레이션 -->
<div class="sim-section">
  <h3>🔌 1DS 통합 시뮬레이션 (실제 1DS 보드 미수정)</h3>
  <div style="color:#94a3b8;font-size:11.5px;margin-bottom:8px;">이 후보풀이 향후 1DS 보드에 연결되면 카드에 다음과 같은 태그가 추가될 예정. helper는 src/utils/theme1dsWatchPool.js.</div>
  <div class="sim-card">
    <span class="sim-tag p-watch-a">🌎 테마감시 A</span>
    <span class="sim-tag p-strong">로봇/휴머노이드 STRONG</span>
    <span class="sim-tag p-qva2">QVA2 4일 전</span>
    <span class="sim-tag" style="background:#0f172a;color:#cbd5e1;border:1px solid #334155;">09시 거래대금 확인</span>
  </div>
  <div class="sim-card">
    <span class="sim-tag p-watch-b">🌎 테마감시 B</span>
    <span class="sim-tag p-mid">방산/우주 MID</span>
    <span class="sim-tag p-qva1">QVA1 3일 전</span>
    <span class="sim-tag" style="background:#0f172a;color:#cbd5e1;border:1px solid #334155;">전일 고가 접근 확인</span>
  </div>
</div>

<footer style="margin-top: 20px; padding: 10px; background: #1e293b; border-radius: 6px; color: #64748b; font-size: 11px; text-align: center;">
  매수 신호 X · 09시 1DS 발화 우선 감시용 후보풀 · 1DS 보드 미수정 · helper: src/utils/theme1dsWatchPool.js
</footer>

<script>
window.__CANDIDATES__ = ${JSON.stringify(cardsForJs)};

const LIMIT_TODAY = 15, LIMIT_B = 30, LIMIT_GROUP = 10;
const STRENGTH_RANK = { STRONG: 4, MID: 3, WEAK: 2, DOWN: 1, NONE: 0 };
const WATCH_RANK = { WATCH_A: 4, WATCH_B: 3, WATCH_C: 2, WATCH_D: 1 };
const STRENGTH_LABEL_CLS = { STRONG: 'p-strong', MID: 'p-mid', WEAK: 'p-weak', DOWN: 'p-down', NONE: 'p-none' };
const WATCH_LABEL = { WATCH_A: '🔥 09시 최우선', WATCH_B: '⏳ 장초 우선', WATCH_C: '👀 참고', WATCH_D: '📡 보조' };
const WATCH_CLS   = { WATCH_A: 'p-watch-a', WATCH_B: 'p-watch-b', WATCH_C: 'p-watch-c', WATCH_D: 'p-watch-d' };

function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmtPct(v) { if (v == null || !isFinite(v)) return '—'; return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
function fmtVal(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1e12) return (v/1e12).toFixed(1) + '조';
  if (v >= 1e8)  return (v/1e8).toFixed(0) + '억';
  if (v >= 1e4)  return (v/1e4).toFixed(0) + '만';
  return Math.round(v).toLocaleString();
}

function cardHtml(c) {
  const wCls = WATCH_CLS[c.watchGrade] || 'p-watch-d';
  const sCls = STRENGTH_LABEL_CLS[c.themeStrength] || 'p-none';
  const signals = [];
  if (c.hasQva1)  signals.push('<span class="pill p-qva1">QVA1 ' + (c.qva1DaysAgo!=null ? c.qva1DaysAgo+'d전' : '') + '</span>');
  if (c.hasQva2)  signals.push('<span class="pill p-qva2">QVA2 ' + (c.qva2DaysAgo!=null ? c.qva2DaysAgo+'d전' : '') + '</span>');
  if (c.hasVvi2)  signals.push('<span class="pill p-vvi2">VVI2 ' + (c.vvi2DaysAgo!=null ? c.vvi2DaysAgo+'d전' : '') + '</span>');
  if (c.hasOneds) signals.push('<span class="pill p-ods">1DS ' + (c.onedsDaysAgo!=null ? c.onedsDaysAgo+'d전' : '') + '</span>');
  if (!c.hasAnySignal) signals.push('<span class="pill p-none">신호 없음 (테마만)</span>');

  const details = [];
  if (c.qva1Date)   details.push('<div class="k">QVA1</div><div class="v">' + c.qva1Date + ' · ' + (c.qva1Score||0) + 'p</div>');
  if (c.qva2Date)   details.push('<div class="k">QVA2</div><div class="v">' + c.qva2Date + ' · ' + (c.qva2Score||0) + 'p' + (c.qva2Type ? ' · '+c.qva2Type : '') + '</div>');
  if (c.vvi2Date)   details.push('<div class="k">VVI2</div><div class="v">' + c.vvi2Date + '</div>');
  if (c.onedsDate)  details.push('<div class="k">1DS</div><div class="v">' + c.onedsDate + ' · ' + (c.onedsScore||0) + 'p</div>');
  if (c.latestDate) details.push('<div class="k">최근일</div><div class="v">' + c.latestDate + ' · close ' + (c.latestClose||'—') + ' · ' + fmtPct(c.latestChangePct) + '</div>');
  if (c.latestValue != null) details.push('<div class="k">거래대금</div><div class="v">' + fmtVal(c.latestValue) + (c.valueRatio20 ? ' (20일 평균 ×' + c.valueRatio20 + ')' : '') + '</div>');
  details.push('<div class="k">테마 매칭</div><div class="v">' + escHtml(c.themeLabel) + ' (' + c.themeStrength + ')</div>');
  if (c.themeReason) details.push('<div class="k">테마 이유</div><div class="v" style="font-style:italic;">' + escHtml(c.themeReason) + '</div>');
  details.push('<div class="k">테마 watch 점수</div><div class="v">' + c.themeWatchScore + ' (등급 ' + c.grade + ')</div>');

  const dataSignals = [];
  if (c.hasQva1)  dataSignals.push('QVA1');
  if (c.hasQva2)  dataSignals.push('QVA2');
  if (c.hasVvi2)  dataSignals.push('VVI2');
  if (c.hasOneds) dataSignals.push('ODS');
  if (!c.hasAnySignal) dataSignals.push('NONE');

  return '<div class="cand" data-code="' + escHtml(c.code) + '" data-watch="' + c.watchGrade + '"'
    + ' data-group="' + c.watchGroup + '"'
    + ' data-theme="' + escHtml(c.themeKey || '') + '"'
    + ' data-matched-themes="' + escHtml((c.matchedThemes||[]).join(',')) + '"'
    + ' data-strength="' + c.themeStrength + '"'
    + ' data-signals="' + dataSignals.join(',') + '"'
    + ' data-score="' + c.score + '"'
    + ' data-theme-score="' + (c.themeWatchScore||0) + '"'
    + ' data-recent="' + Math.min(c.qva1DaysAgo??999, c.qva2DaysAgo??999, c.vvi2DaysAgo??999, c.onedsDaysAgo??999) + '"'
    + ' data-value="' + (c.latestValue || 0) + '"'
    + ' data-strength-rank="' + (STRENGTH_RANK[c.themeStrength] || 0) + '">'
    + '<div class="row1"><div>'
    + '<a href="/stock/' + escHtml(c.code) + '?from=theme-1ds-watch-pool" target="_blank" rel="noopener" class="stock-link" title="새 창에서 상세 페이지 열기">'
    + '<span class="name">' + escHtml(c.name) + '</span><span class="code">' + escHtml(c.code) + '</span>'
    + '</a></div>'
    + '<div class="score">' + c.score + '</div></div>'
    + '<div class="row2">'
    + '<span class="pill ' + wCls + '">' + WATCH_LABEL[c.watchGrade] + '</span>'
    + '<span class="pill ' + sCls + '">' + escHtml(c.themeLabel) + ' ' + c.themeStrength + '</span>'
    + signals.join('')
    + (c.riskNotes && c.riskNotes.length ? '<span class="pill p-risk">⚠ ' + c.riskNotes.map(escHtml).join(' · ') + '</span>' : '')
    + '</div>'
    + '<div class="reason">' + escHtml(c.watchReason || '') + '</div>'
    + '<details><summary>상세 보기 + 09시 체크포인트</summary><div class="details-body">'
    + '<div class="kv">' + details.join('') + '</div>'
    + (c.suggested1dsCheckPoints && c.suggested1dsCheckPoints.length ? '<div style="margin-top:6px;color:#5eead4;font-size:10.5px;font-weight:600;">09시 체크포인트</div><ul class="checkpoints">' + c.suggested1dsCheckPoints.map(p => '<li>' + escHtml(p) + '</li>').join('') + '</ul>' : '')
    + '</div></details>'
    + '</div>';
}

function getFiltered() {
  const fStrength = document.getElementById('f-strength').value;
  const fWatch = document.getElementById('f-watch').value;
  const fSignal = document.getElementById('f-signal').value;
  const sort = document.getElementById('f-sort').value;

  let list = window.__CANDIDATES__.slice();
  if (fStrength) list = list.filter(c => c.themeStrength === fStrength);
  if (fWatch)    list = list.filter(c => c.watchGrade === fWatch);
  if (fSignal) {
    if (fSignal === 'NONE') list = list.filter(c => !c.hasAnySignal);
    else if (fSignal === 'QVA1') list = list.filter(c => c.hasQva1);
    else if (fSignal === 'QVA2') list = list.filter(c => c.hasQva2);
    else if (fSignal === 'VVI2') list = list.filter(c => c.hasVvi2);
    else if (fSignal === 'ODS')  list = list.filter(c => c.hasOneds);
  }

  if (sort === 'priority')    list.sort((a, b) => b.morningWatchPriority - a.morningWatchPriority);
  else if (sort === 'score')  list.sort((a, b) => b.score - a.score);
  else if (sort === 'theme-score') list.sort((a, b) => (b.themeWatchScore||0) - (a.themeWatchScore||0));
  else if (sort === 'recent') {
    const r = c => Math.min(c.qva1DaysAgo??999, c.qva2DaysAgo??999, c.vvi2DaysAgo??999, c.onedsDaysAgo??999);
    list.sort((a, b) => r(a) - r(b));
  }
  else if (sort === 'strength') list.sort((a, b) => (STRENGTH_RANK[b.themeStrength]||0) - (STRENGTH_RANK[a.themeStrength]||0) || b.score - a.score);
  else if (sort === 'value')    list.sort((a, b) => (b.latestValue||0) - (a.latestValue||0));

  return list;
}
function updateMetaCount(n) { document.getElementById('meta-count').textContent = '필터 결과 ' + n + '건 / 전체 ' + window.__CANDIDATES__.length + '건'; }

function renderWatchATab() {
  const filtered = getFiltered().filter(c => c.watchGrade === 'WATCH_A');
  const container = document.getElementById('panel-watch-a-cards');
  if (filtered.length === 0) { container.innerHTML = '<div class="empty">필터 조건에 맞는 WATCH_A 후보 없음</div>'; updateMetaCount(filtered.length); return; }
  const shown = filtered.slice(0, LIMIT_TODAY), hidden = filtered.slice(LIMIT_TODAY);
  container.innerHTML = shown.map(cardHtml).join('') + (hidden.length ? '<button class="show-more" onclick="expandMore(this, \\'watch-a\\')">+ ' + hidden.length + '건 더 보기</button>' : '');
  container._hidden = hidden;
  updateMetaCount(filtered.length);
}
function renderWatchBTab() {
  const filtered = getFiltered().filter(c => c.watchGrade === 'WATCH_B');
  const container = document.getElementById('panel-watch-b-cards');
  if (filtered.length === 0) { container.innerHTML = '<div class="empty">필터 조건에 맞는 WATCH_B 후보 없음</div>'; updateMetaCount(filtered.length); return; }
  const shown = filtered.slice(0, LIMIT_B), hidden = filtered.slice(LIMIT_B);
  container.innerHTML = shown.map(cardHtml).join('') + (hidden.length ? '<button class="show-more" onclick="expandMore(this, \\'watch-b\\')">+ ' + hidden.length + '건 더 보기</button>' : '');
  container._hidden = hidden;
  updateMetaCount(filtered.length);
}
function expandMore(btn, tab) {
  const container = btn.parentElement;
  const hidden = container._hidden || [];
  btn.outerHTML = hidden.map(cardHtml).join('');
}

function renderByThemeTab() {
  const filtered = getFiltered();
  // 테마별 모음
  const byTheme = {};
  for (const c of filtered) {
    for (const tk of (c.matchedThemes || [])) {
      if (!byTheme[tk]) byTheme[tk] = [];
      byTheme[tk].push(c);
    }
  }
  // 강도순 정렬
  const themeKeys = Object.keys(byTheme).sort((a, b) => {
    const sa = STRENGTH_RANK[byTheme[a][0]?.themeStrength] || 0;
    const sb = STRENGTH_RANK[byTheme[b][0]?.themeStrength] || 0;
    return sb - sa;
  });
  const container = document.getElementById('panel-theme-groups');
  const blocks = [];
  for (const tk of themeKeys) {
    const list = byTheme[tk];
    const label = list[0]?.themeLabel || tk;
    const strength = list[0]?.themeStrength || 'NONE';
    const isOpen = strength === 'STRONG';
    const sCls = STRENGTH_LABEL_CLS[strength] || 'p-none';
    const shown = list.slice(0, LIMIT_GROUP);
    const hidden = list.slice(LIMIT_GROUP);
    blocks.push(
      '<details class="group"' + (isOpen ? ' open' : '') + ' data-theme="' + tk + '">' +
      '<summary><span>' + escHtml(label) + ' <span class="pill ' + sCls + '">' + strength + '</span></span>' +
      '<span class="count">' + list.length + '건</span></summary>' +
      '<div class="group-body"><div class="cards">' + shown.map(cardHtml).join('') + '</div>' +
      (hidden.length ? '<button class="show-more" onclick="expandThemeMore(this,\\''+tk+'\\')">+ ' + hidden.length + '건 더 보기</button>' : '') +
      '</div></details>'
    );
  }
  container.innerHTML = blocks.join('') || '<div class="empty">필터 조건에 맞는 테마 후보 없음</div>';
  for (const tk of themeKeys) {
    if (byTheme[tk].length > LIMIT_GROUP) {
      const det = container.querySelector('details[data-theme="' + tk + '"]');
      if (det) det._hidden = byTheme[tk].slice(LIMIT_GROUP);
    }
  }
  updateMetaCount(filtered.length);
}
function expandThemeMore(btn, tk) {
  const det = btn.closest('details');
  const hidden = det._hidden || [];
  det.querySelector('.cards').insertAdjacentHTML('beforeend', hidden.map(cardHtml).join(''));
  btn.remove();
}

function renderBySignalTab() {
  const filtered = getFiltered();
  const groups = [
    { key: 'QVA2', label: 'QVA2 흔적 있음', pred: c => c.hasQva2 },
    { key: 'QVA1', label: 'QVA1 흔적 있음', pred: c => c.hasQva1 },
    { key: 'VVI2', label: 'VVI2 있음', pred: c => c.hasVvi2 },
    { key: 'ODS',  label: '1DS 있음', pred: c => c.hasOneds },
    { key: 'NONE', label: '신호 없음이지만 테마 매칭', pred: c => !c.hasAnySignal },
  ];
  const container = document.getElementById('panel-signal-groups');
  const blocks = [];
  for (const g of groups) {
    const list = filtered.filter(g.pred);
    if (list.length === 0) continue;
    const shown = list.slice(0, LIMIT_GROUP), hidden = list.slice(LIMIT_GROUP);
    blocks.push(
      '<details class="group" open data-signal="' + g.key + '">' +
      '<summary><span>' + escHtml(g.label) + '</span><span class="count">' + list.length + '건</span></summary>' +
      '<div class="group-body"><div class="cards">' + shown.map(cardHtml).join('') + '</div>' +
      (hidden.length ? '<button class="show-more" onclick="expandSignalMore(this,\\''+g.key+'\\')">+ ' + hidden.length + '건 더 보기</button>' : '') +
      '</div></details>'
    );
  }
  container.innerHTML = blocks.join('') || '<div class="empty">필터 조건에 맞는 신호 후보 없음</div>';
  for (const g of groups) {
    const list = filtered.filter(g.pred);
    if (list.length > LIMIT_GROUP) {
      const det = container.querySelector('details[data-signal="' + g.key + '"]');
      if (det) det._hidden = list.slice(LIMIT_GROUP);
    }
  }
  updateMetaCount(filtered.length);
}
function expandSignalMore(btn, key) {
  const det = btn.closest('details');
  const hidden = det._hidden || [];
  det.querySelector('.cards').insertAdjacentHTML('beforeend', hidden.map(cardHtml).join(''));
  btn.remove();
}

function renderAllTab() {
  const filtered = getFiltered();
  document.getElementById('panel-all-cards').innerHTML = filtered.map(cardHtml).join('') || '<div class="empty">필터 조건에 맞는 후보 없음</div>';
  const det = document.getElementById('all-details');
  if (det) det.querySelector('summary').textContent = '전체 ' + filtered.length + '건 펼치기';
  updateMetaCount(filtered.length);
}

const TAB_RENDERERS = { 'watch-a': renderWatchATab, 'watch-b': renderWatchBTab, 'by-theme': renderByThemeTab, 'by-signal': renderBySignalTab, 'all': renderAllTab };
let activeTab = 'watch-a';
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  TAB_RENDERERS[name]();
}
function resetFilters() {
  document.getElementById('f-strength').value = '';
  document.getElementById('f-watch').value = '';
  document.getElementById('f-signal').value = '';
  document.getElementById('f-sort').value = 'priority';
  TAB_RENDERERS[activeTab]();
}
function onFilterChange() { TAB_RENDERERS[activeTab](); }

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  document.querySelectorAll('.filter-bar select').forEach(sel => sel.addEventListener('change', onFilterChange));
  switchTab('watch-a');
});
</script>
</body></html>`;
}

main();
