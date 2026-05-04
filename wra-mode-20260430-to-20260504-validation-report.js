#!/usr/bin/env node
/**
 * WRA 운영 모드별 4/30 → 5/4 검증 보고서
 *
 * 목적:
 *   2026-04-30 장 마감 시점까지의 데이터만 사용해 만든 WRA 후보를 새 운영 모드(STABLE,
 *   REACTION, AGGRESSIVE, ALL, WEAK) 기준으로 분류한 뒤, 2026-05-04 OHLCV로
 *   각 모드의 실제 반응을 비교한다. 5/4 데이터는 검증에만 사용 — 후보 분류·점수·
 *   라벨에 절대 미반영.
 *
 * 입력:
 *   - reports/wra-asof-20260430-snapshot-result.json     (candidates + nextDay 5/4)
 *   - reports/wra-20260430-to-20260504-validation-result.json (signal OHLC cross-ref)
 *
 * 출력:
 *   - reports/wra-mode-20260430-to-20260504-validation-result.json
 *   - reports/wra-mode-20260430-to-20260504-validation-result.html
 *
 * 후보 산출 로직 미수정. QVA/VVI/pattern-screener/v3.1/board 미수정. 분석 전용.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const SNAPSHOT_PATH = path.join(REPORTS_DIR, 'wra-asof-20260430-snapshot-result.json');
const VALIDATION_PATH = path.join(REPORTS_DIR, 'wra-20260430-to-20260504-validation-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'wra-mode-20260430-to-20260504-validation-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'wra-mode-20260430-to-20260504-validation-result.html');

// ─────────────────────── 모드 정의 ───────────────────────

const MODES = [
  {
    id: 'STABLE', icon: '🛡️', title: '안정 관찰',
    desc: '거래대금 유입은 있으나 상대적으로 위험이 낮은 후보입니다. 단기 급등보다는 관심종목 관찰에 적합합니다.',
    filter: c =>
      (c.watchTagV3_1 === 'CLEAN_VALUE_SETUP' && c.riskOverlay !== 'HIGH_VOLATILITY')
      || (c.watchTagV3_1 === 'VALUE_LOOSE' && !c.riskOverlay && (c.riskScore || 0) < 20),
  },
  {
    id: 'REACTION', icon: '⚡', title: '단기 반응',
    desc: '다음 거래일 크게 움직일 가능성이 있는 후보입니다. 실패율도 높으므로 추격주의가 필요합니다.',
    filter: c =>
      c.watchTagV3_1 === 'HIGH_VOLATILITY'
      || (c.riskScore || 0) >= 20
      || c.watchTagV3_1 === 'VALUE_SURGE_CONFIRM'
      || c.watchTagV3_1 === 'BREAKOUT_MOMENTUM',
  },
  {
    id: 'AGGRESSIVE', icon: '🔥', title: '고위험 공격형',
    desc: '공격적으로 단기 변동성을 확인하고 싶을 때 보는 후보입니다. 크게 움직일 가능성과 실패 가능성이 모두 높습니다.',
    filter: c =>
      c.watchTagV3_1 === 'HIGH_VOLATILITY'
      || c.riskOverlay === 'HIGH_VOLATILITY'
      || (c.riskScore || 0) >= 30,
  },
  {
    id: 'ALL', icon: '📋', title: '전체 후보',
    desc: '전체 WRA 후보입니다.',
    filter: () => true,
  },
  {
    id: 'WEAK', icon: '👁️', title: '약한 후보',
    desc: 'WATCH_ONLY와 LOW_SIGNAL은 별도 그룹으로 집계하되, 운영 모드 기본 후보에서는 제외합니다.',
    filter: c => c.watchTagV3_1 === 'WATCH_ONLY' || c.watchTagV3_1 === 'LOW_SIGNAL',
  },
];

// ─────────────────────── 헬퍼 ───────────────────────

function round(v, d) { if (v == null || !isFinite(v)) return null; return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
function pct(num, den) { if (!den || den === 0) return null; return round(num / den * 100, 1); }
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ─────────────────────── 5/4 반응 계산 ───────────────────────

function computeReaction(c) {
  const nd = c.nextDay;
  if (!nd || nd.nextClose == null) return null;

  const sigClose = c._signalClose;
  const sigHigh = c._signalHigh;
  const sigVol = c._signalVolume;

  if (sigClose == null) return null;

  const closeRet = round((nd.nextClose - sigClose) / sigClose * 100, 2);
  const highRet = nd.nextHigh != null ? round((nd.nextHigh - sigClose) / sigClose * 100, 2) : null;
  const lowRet = nd.nextLow != null ? round((nd.nextLow - sigClose) / sigClose * 100, 2) : null;
  const openRet = nd.nextOpen != null ? round((nd.nextOpen - sigClose) / sigClose * 100, 2) : null;
  const closeLoc54 = (nd.nextHigh != null && nd.nextLow != null && nd.nextHigh > nd.nextLow)
    ? round((nd.nextClose - nd.nextLow) / (nd.nextHigh - nd.nextLow), 3) : null;

  const volRatio = (sigVol != null && sigVol > 0 && nd.nextVolume != null)
    ? round(nd.nextVolume / sigVol, 2) : null;
  const valueMaintained = volRatio != null && volRatio >= 0.7;
  const valueExpanded = volRatio != null && volRatio >= 1.5;

  const highBreak = (sigHigh != null && nd.nextHigh != null) ? nd.nextHigh > sigHigh : null;
  const closeUp = nd.nextClose > sigClose;

  // STRONG_CONFIRM: 4 조건 동시 충족
  const strongConfirm = highBreak === true && closeUp === true && closeLoc54 != null && closeLoc54 >= 0.6 && valueMaintained;

  // 분류
  const tags = new Set();
  if (strongConfirm) tags.add('STRONG_CONFIRM');
  if (closeRet >= 3) tags.add('CLOSE_WIN');
  if (highRet != null && highRet >= 5) tags.add('HIGH_OPPORTUNITY');
  if (highBreak === false && !closeUp) tags.add('FAILED_CONFIRM');
  if (highBreak === true && closeLoc54 != null && closeLoc54 < 0.4) tags.add('HIGH_THEN_FADE');
  if (closeRet <= -2) tags.add('CLOSE_LOSS');
  // gapUpFail: 시가 갭상승(>+1.5%) 후 종가 음봉
  if (openRet != null && openRet >= 1.5 && closeRet < 0) tags.add('GAP_UP_FAIL');

  return {
    closeRet, highRet, lowRet, openRet, closeLoc54, volRatio,
    valueMaintained, valueExpanded, highBreak, closeUp, strongConfirm,
    tags: [...tags],
  };
}

// ─────────────────────── 모드별 통계 ───────────────────────

function summarizeMode(events) {
  if (events.length === 0) return { count: 0 };
  const closeRets = events.map(e => e._reaction.closeRet).filter(v => v != null);
  const highRets = events.map(e => e._reaction.highRet).filter(v => v != null);
  const lowRets = events.map(e => e._reaction.lowRet).filter(v => v != null);
  const uniqueCodes = new Set(events.map(e => e.code));

  const close3 = closeRets.filter(v => v >= 3).length;
  const close5 = closeRets.filter(v => v >= 5).length;
  const closeNeg2 = closeRets.filter(v => v <= -2).length;
  const closeNeg3 = closeRets.filter(v => v <= -3).length;
  const closeNeg5 = closeRets.filter(v => v <= -5).length;
  const lowNeg3 = lowRets.filter(v => v <= -3).length;
  const lowNeg5 = lowRets.filter(v => v <= -5).length;
  const high5 = highRets.filter(v => v >= 5).length;
  const high10 = highRets.filter(v => v >= 10).length;

  const failedConfirm = events.filter(e => e._reaction.tags.includes('FAILED_CONFIRM')).length;
  const highThenFade = events.filter(e => e._reaction.tags.includes('HIGH_THEN_FADE')).length;
  const gapUpFail = events.filter(e => e._reaction.tags.includes('GAP_UP_FAIL')).length;
  const strongConfirm = events.filter(e => e._reaction.strongConfirm).length;
  const valueMaintained = events.filter(e => e._reaction.valueMaintained).length;
  const valueExpanded = events.filter(e => e._reaction.valueExpanded).length;
  const success = events.filter(e =>
    e._reaction.tags.includes('STRONG_CONFIRM')
    || e._reaction.tags.includes('CLOSE_WIN')
    || e._reaction.tags.includes('HIGH_OPPORTUNITY')).length;
  const fail = events.filter(e =>
    e._reaction.tags.includes('FAILED_CONFIRM')
    || e._reaction.tags.includes('HIGH_THEN_FADE')
    || e._reaction.tags.includes('CLOSE_LOSS')).length;

  return {
    count: events.length,
    uniqueStockCount: uniqueCodes.size,
    avgNextCloseReturn: closeRets.length ? round(closeRets.reduce((s, v) => s + v, 0) / closeRets.length, 2) : null,
    medNextCloseReturn: round(median(closeRets), 2),
    avgNextHighReturn: highRets.length ? round(highRets.reduce((s, v) => s + v, 0) / highRets.length, 2) : null,
    medNextHighReturn: round(median(highRets), 2),
    avgNextLowReturn: lowRets.length ? round(lowRets.reduce((s, v) => s + v, 0) / lowRets.length, 2) : null,
    closeReturnOver3Rate: pct(close3, closeRets.length),
    closeReturnOver5Rate: pct(close5, closeRets.length),
    highReturnOver5Rate: pct(high5, highRets.length),
    highReturnOver10Rate: pct(high10, highRets.length),
    failedConfirmRate: pct(failedConfirm, events.length),
    highThenFadeRate: pct(highThenFade, events.length),
    gapUpFailRate: pct(gapUpFail, events.length),
    lowDropOver3Rate: pct(lowNeg3, lowRets.length),
    lowDropOver5Rate: pct(lowNeg5, lowRets.length),
    closeDropOver2Rate: pct(closeNeg2, closeRets.length),
    closeDropOver5Rate: pct(closeNeg5, closeRets.length),
    valueMaintainedRate: pct(valueMaintained, events.length),
    valueExpandedRate: pct(valueExpanded, events.length),
    strongConfirmRate: pct(strongConfirm, events.length),
    successRate: pct(success, events.length),
    riskRewardRatio: closeNeg2 > 0 ? round(success / closeNeg2, 2) : null,
  };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('WRA 운영 모드별 4/30 → 5/4 검증 보고서');
  console.log('═'.repeat(80));

  if (!fs.existsSync(SNAPSHOT_PATH)) { console.error('snapshot 파일 없음:', SNAPSHOT_PATH); process.exit(1); }
  if (!fs.existsSync(VALIDATION_PATH)) { console.error('validation 파일 없음:', VALIDATION_PATH); process.exit(1); }

  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
  const val = JSON.parse(fs.readFileSync(VALIDATION_PATH, 'utf-8'));
  const valByCode = new Map((val.candidates || []).map(c => [c.code, c]));

  // cross-reference: signal OHLC 추가
  const candidates = (snap.candidates || []).map(c => {
    const v = valByCode.get(c.code);
    return {
      ...c,
      _signalOpen: v?.signalOpen ?? null,
      _signalHigh: v?.signalHigh ?? null,
      _signalLow: v?.signalLow ?? null,
      _signalClose: v?.signalClose ?? null,
      _signalVolume: v?.signalVolume ?? null,
      _signalValue: v?.signalValue ?? null,
    };
  });

  // 5/4 반응 계산
  candidates.forEach(c => { c._reaction = computeReaction(c); });
  const withReaction = candidates.filter(c => c._reaction != null);

  console.log(`\n전체 후보: ${candidates.length}, 5/4 반응 계산 가능: ${withReaction.length}`);

  // 모드별 분류 + 통계
  const modeResults = MODES.map(m => {
    const events = withReaction.filter(m.filter);
    return {
      id: m.id, icon: m.icon, title: m.title, desc: m.desc,
      summary: summarizeMode(events),
      events,                    // 종목 상세용
    };
  });

  // 콘솔 요약
  console.log('\n모드별 성과:');
  modeResults.forEach(r => {
    const s = r.summary;
    if (s.count === 0) { console.log(`  ${r.icon} ${r.title.padEnd(10)} n=0`); return; }
    console.log(`  ${r.icon} ${r.title.padEnd(10)} n=${String(s.count).padStart(3)} avgClose=${String(s.avgNextCloseReturn).padStart(6)}% avgHigh=${String(s.avgNextHighReturn).padStart(6)}% +3%=${String(s.closeReturnOver3Rate).padStart(5)}% +5%고가=${String(s.highReturnOver5Rate).padStart(5)}% 실패=${String(s.failedConfirmRate).padStart(5)}% RR=${s.riskRewardRatio}`);
  });

  // 모드별 상위/하위 종목
  const topLists = {};
  modeResults.forEach(r => {
    const ev = r.events;
    topLists[r.id] = {
      topCloseReturn: [...ev].sort((a, b) => (b._reaction.closeRet || -999) - (a._reaction.closeRet || -999)).slice(0, 10),
      topHighReturn: [...ev].sort((a, b) => (b._reaction.highRet || -999) - (a._reaction.highRet || -999)).slice(0, 10),
      worstCloseReturn: [...ev].sort((a, b) => (a._reaction.closeRet || 999) - (b._reaction.closeRet || 999)).slice(0, 10),
      highThenFade: ev.filter(e => e._reaction.tags.includes('HIGH_THEN_FADE')).slice(0, 10),
    };
  });

  // 결론 자동 생성
  const conclusion = buildConclusion(modeResults);

  // 컴팩트한 종목 리스트 생성
  function compact(c) {
    return {
      code: c.code, name: c.name, market: c.market, marketCap: c.marketCap,
      tag: c.watchTagV3_1, displayLabel: c.displayLabel,
      finalScore: c.finalScore, riskScore: c.riskScore, valueRatio20: c.valueRatio20,
      closeLocation: c.closeLocation, closeToMA20: c.closeToMA20,
      closeFromRecentLow20: c.closeFromRecentLow20,
      historyQuality: c.historyQuality, boxQuality: c.boxQuality,
      reaction: c._reaction,
      signalClose: c._signalClose, signalHigh: c._signalHigh, signalVolume: c._signalVolume,
    };
  }

  const out = {
    meta: {
      version: 'wra-mode-validation-v1',
      generatedAt: new Date().toISOString(),
      title: 'WRA 운영 모드별 4/30 → 5/4 검증 보고서',
      asOfDate: '20260430',
      validationDate: '20260504',
      requestBackground: '사용자는 WRA 보드를 안정 관찰 중심으로 볼지, 단기 반응 또는 고위험 공격형 후보를 별도로 볼지 고민하고 있다. 따라서 이 보고서는 각 운영 모드가 실제 다음 거래일에 어떤 차이를 보였는지 확인하기 위해 생성되었다.',
      cutoffRule: '후보 생성에는 2026-04-30 및 그 이전 데이터만 사용. 2026-05-04 데이터는 검증에만 사용 — 후보 분류·점수·라벨에 절대 미반영.',
      successDef: {
        STRONG_CONFIRM: '5/4 고가 > 4/30 고가 AND 5/4 종가 > 4/30 종가 AND 5/4 closeLocation ≥ 0.6 AND 거래대금 유지 (≥0.7×)',
        CLOSE_WIN: '5/4 종가 등락률 ≥ +3%',
        HIGH_OPPORTUNITY: '5/4 고가 등락률 ≥ +5%',
      },
      failDef: {
        FAILED_CONFIRM: '5/4 고가 ≤ 4/30 고가 AND 5/4 종가 ≤ 4/30 종가',
        HIGH_THEN_FADE: '5/4 고가 > 4/30 고가 BUT closeLocation < 0.4',
        CLOSE_LOSS: '5/4 종가 등락률 ≤ -2%',
        GAP_UP_FAIL: '시가 갭상승(≥+1.5%) 후 종가 음봉',
      },
    },
    sampleCount: { total: candidates.length, withReaction: withReaction.length },
    modeResults: modeResults.map(r => ({
      id: r.id, icon: r.icon, title: r.title, desc: r.desc,
      summary: r.summary,
      events: r.events.map(compact),
      topLists: {
        topCloseReturn: topLists[r.id].topCloseReturn.map(compact),
        topHighReturn: topLists[r.id].topHighReturn.map(compact),
        worstCloseReturn: topLists[r.id].worstCloseReturn.map(compact),
        highThenFade: topLists[r.id].highThenFade.map(compact),
      },
    })),
    conclusion,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  const html = HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out));
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  console.log(`\n✅ JSON: ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
  console.log(`✅ HTML: ${OUT_HTML} (${(html.length / 1024).toFixed(0)}KB)`);
}

function buildConclusion(modeResults) {
  const byId = Object.fromEntries(modeResults.map(r => [r.id, r]));
  const stable = byId.STABLE.summary;
  const reaction = byId.REACTION.summary;
  const aggressive = byId.AGGRESSIVE.summary;
  const all = byId.ALL.summary;
  const weak = byId.WEAK.summary;

  // 가장 강했던 모드 (avgClose 기준, n>=10 only)
  const strongest = modeResults
    .filter(r => r.id !== 'ALL' && r.summary.count >= 10)
    .sort((a, b) => (b.summary.avgNextCloseReturn || -999) - (a.summary.avgNextCloseReturn || -999))[0];
  // 가장 안전했던 모드 (실패율 + closeLoss 합 기준 낮은 순)
  const safest = modeResults
    .filter(r => r.id !== 'ALL' && r.summary.count >= 10)
    .sort((a, b) => ((a.summary.failedConfirmRate || 0) + (a.summary.closeDropOver2Rate || 0))
                  - ((b.summary.failedConfirmRate || 0) + (b.summary.closeDropOver2Rate || 0)))[0];

  const answers = {
    q1_stableSafer: {
      question: '안정 관찰 모드는 실제로 더 안전했는가?',
      answer: `안정 관찰 실패율 ${stable.failedConfirmRate}%, 종가 -2% 비율 ${stable.closeDropOver2Rate}%. 단기 반응 ${reaction.failedConfirmRate}%/${reaction.closeDropOver2Rate}%, 공격형 ${aggressive.failedConfirmRate}%/${aggressive.closeDropOver2Rate}%. ${(stable.closeDropOver2Rate || 100) < (reaction.closeDropOver2Rate || 0) ? '예 — 안정 관찰이 실패 위험 낮음' : '아니오'}`,
    },
    q2_reactionMoved: {
      question: '단기 반응 모드는 실제로 더 많이 움직였는가?',
      answer: `단기 반응 평균 종가 ${reaction.avgNextCloseReturn}%, 평균 고가 ${reaction.avgNextHighReturn}%, +3% 도달 ${reaction.closeReturnOver3Rate}%, +5% 고가 도달 ${reaction.highReturnOver5Rate}%. 안정 관찰 ${stable.avgNextCloseReturn}% / 고가 ${stable.avgNextHighReturn}%. ${(reaction.avgNextHighReturn || 0) > (stable.avgNextHighReturn || 0) ? '예 — 단기 반응이 더 크게 움직임' : '아니오'}`,
    },
    q3_aggressiveBoth: {
      question: '고위험 공격형은 수익 기회와 실패율이 동시에 높았는가?',
      answer: `공격형 +5% 고가 도달 ${aggressive.highReturnOver5Rate}%, +10% 고가 도달 ${aggressive.highReturnOver10Rate}%, 실패율 ${aggressive.failedConfirmRate}%, 종가 -2% 비율 ${aggressive.closeDropOver2Rate}%, RR=${aggressive.riskRewardRatio}. ${(aggressive.highReturnOver5Rate || 0) > (stable.highReturnOver5Rate || 0) && (aggressive.closeDropOver2Rate || 0) > (stable.closeDropOver2Rate || 0) ? '예 — 보상도 위험도 모두 큼' : '한쪽만 두드러짐'}`,
    },
    q4_defaultMode: {
      question: 'WRA 보드의 기본 모드는 무엇이 적절한가?',
      answer: `${safest ? safest.title + ' (가장 안전, 실패+종가하락 합산 가장 낮음)' : '데이터 부족'}. 안정성을 우선한다면 안정 관찰을 기본으로, 단기 매매 사용자에게는 단기 반응 모드를 유도하는 멀티 모드 UI가 적절. 단일 cutoff(4/30→5/4) 결과이므로 추가 검증 필요.`,
    },
    q5_aggressiveWarning: {
      question: '공격적 단기 후보를 볼 때 어떤 경고 문구가 필요한가?',
      answer: `공격형 모드 실패율 ${aggressive.failedConfirmRate}%, 종가 -5% 비율 ${aggressive.closeDropOver5Rate}%, gapUpFail ${aggressive.gapUpFailRate}%. 추격 매수 위험이 명백하므로 "추격주의 / 손절선 미리 정하기 / 분할진입 고려" 같은 행동 가이드가 필요.`,
    },
  };

  const recommendBoardCopy = {
    aggressiveBanner: '공격적으로 단기 변동성을 확인하고 싶다면 고위험 공격형 후보를 볼 수 있습니다. 단, 이 그룹은 실패율도 높으므로 추격주의가 필요합니다. 손절선을 미리 정하고 분할 진입을 고려하세요.',
    reactionBanner: '단기 반응 후보는 다음 거래일 크게 움직일 가능성이 있습니다. 다만 실패율도 동반되므로 추격보다는 다음 거래일 시초가/장중 흐름을 먼저 확인하세요.',
    stableBanner: '안정 관찰 후보는 거래대금 유입은 있으나 상대적으로 위험이 낮은 그룹입니다. 단기 급등보다는 관심종목 추적용으로 활용하세요.',
  };

  return {
    strongestMode: strongest ? { id: strongest.id, title: strongest.title, avgNextCloseReturn: strongest.summary.avgNextCloseReturn, highReturnOver5Rate: strongest.summary.highReturnOver5Rate } : null,
    safestMode: safest ? { id: safest.id, title: safest.title, failedConfirmRate: safest.summary.failedConfirmRate, closeDropOver2Rate: safest.summary.closeDropOver2Rate } : null,
    answers,
    recommendBoardCopy,
    finalProposal: '기본 모드 = 안정 관찰. 단기 반응/공격형은 빠른 모드 버튼으로 제공. 공격형 모드 진입 시 추격주의 배너 자동 노출. v3.2 보드는 후보 산출 로직을 바꾸지 않고 모드 분리만으로 사용자 의도 다양성 대응.',
  };
}

// ─────────────────────── HTML ───────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>WRA 운영 모드 검증 보고서</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 28px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
}
h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
h3 { font-size: 14px; margin: 16px 0 8px; color: #94a3b8; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; }
.purpose-box strong { color: #67e8f9; }
.cutoff-banner { background: #1e3a8a; border: 1px solid #3b82f6; padding: 10px 14px; border-radius: 6px; margin-bottom: 14px; font-size: 12px; color: #dbeafe; line-height: 1.6; }
.cutoff-banner strong { color: #93c5fd; }
.warn-banner { background: #422006; border-left: 4px solid #f59e0b; padding: 10px 14px; border-radius: 6px; font-size: 12px; color: #fde68a; line-height: 1.6; margin-bottom: 14px; }

/* mode card */
.mode-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 16px; }
.mode-card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; }
.mode-card.stable { border-left: 4px solid #10b981; }
.mode-card.reaction { border-left: 4px solid #a78bfa; }
.mode-card.aggressive { border-left: 4px solid #ef4444; }
.mode-card.all { border-left: 4px solid #38bdf8; }
.mode-card.weak { border-left: 4px solid #64748b; opacity: 0.85; }
.mode-card .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.mode-card .icon { font-size: 22px; }
.mode-card .title { font-size: 15px; font-weight: 700; color: #f1f5f9; }
.mode-card .desc { font-size: 12px; color: #94a3b8; line-height: 1.5; margin-bottom: 10px; }
.mode-card .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 12px; line-height: 1.5; }
.mode-card .stat-grid .k { color: #64748b; font-size: 11px; }
.mode-card .stat-grid .v { color: #f1f5f9; font-weight: 600; font-variant-numeric: tabular-nums; }
.mode-card .stat-grid .v.pos { color: #6ee7b7; }
.mode-card .stat-grid .v.neg { color: #fca5a5; }
.mode-card .stat-grid .v.warn { color: #fde047; }

table.cmp { width: 100%; border-collapse: collapse; font-size: 12px; margin: 8px 0 14px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; }
table.cmp th, table.cmp td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #334155; white-space: nowrap; }
table.cmp th:first-child, table.cmp td:first-child { text-align: left; color: #cbd5e1; }
table.cmp thead th { background: #0f172a; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
table.cmp tr:hover td { background: #273549; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-warn { color: #fde047; }

.answer-list { background: #1e293b; border-radius: 8px; padding: 14px 16px; }
.answer-item { padding: 10px 0; border-bottom: 1px dashed #334155; }
.answer-item:last-child { border-bottom: none; }
.answer-item .q { font-weight: 600; color: #67e8f9; margin-bottom: 4px; }
.answer-item .a { font-size: 12px; color: #cbd5e1; line-height: 1.6; }

.recommend-box { background: #422006; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 12px 16px; margin-bottom: 14px; color: #fde68a; line-height: 1.7; }
.recommend-box strong { color: #fef3c7; }

.copy-box { background: #1e3a5f; border: 1px solid #3b82f6; border-radius: 6px; padding: 10px 14px; margin: 8px 0; color: #dbeafe; line-height: 1.6; font-size: 13px; }
.copy-box .label { font-size: 10px; color: #93c5fd; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600; }

/* mode tabs for top lists */
.tab-bar { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
.tab-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.tab-btn:hover { color: #f1f5f9; }
.tab-btn.active { background: #0369a1; color: #f1f5f9; border-color: #38bdf8; }

table.evt { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; }
table.evt thead th { background: #0f172a; color: #94a3b8; padding: 8px 10px; font-size: 11px; text-transform: uppercase; text-align: left; border-bottom: 1px solid #334155; }
table.evt thead th.numeric { text-align: right; }
table.evt tbody tr { border-bottom: 1px solid #1e293b; }
table.evt tbody tr:nth-child(odd) { background: #1c2942; }
table.evt tbody tr:hover { background: #273549; }
table.evt tbody td { padding: 7px 10px; }
table.evt tbody td.numeric { text-align: right; }
table.evt tbody td.col-name { font-weight: 600; color: #f1f5f9; }
table.evt tbody td.col-name .meta { display: block; font-size: 10px; color: #64748b; font-weight: 400; margin-top: 2px; }

.tag-pill { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; }
.tag-pill.t-CLEAN_VALUE_SETUP { background: #047857; color: #d1fae5; }
.tag-pill.t-VALUE_SURGE_CONFIRM { background: #0e7490; color: #cffafe; }
.tag-pill.t-BREAKOUT_MOMENTUM { background: #6d28d9; color: #ede9fe; }
.tag-pill.t-VALUE_LOOSE { background: #92400e; color: #fef3c7; }
.tag-pill.t-HIGH_VOLATILITY { background: #991b1b; color: #fee2e2; }
.tag-pill.t-WATCH_ONLY { background: #475569; color: #e2e8f0; }
.tag-pill.t-LOW_SIGNAL { background: #1e293b; color: #94a3b8; border: 1px solid #475569; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }
</style>
</head>
<body>

<h1 id="page-title">WRA 운영 모드별 4/30 → 5/4 검증 보고서</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box" id="purpose-box"></div>
<div class="cutoff-banner" id="cutoff-banner"></div>
<div class="warn-banner">
  ⚠️ <strong>매수 신호 보고서가 아닙니다.</strong> 단일 cutoff(4/30 → 5/4) 분석으로 다른 cutoff에서 같은 패턴이 나오는지 추가 검증이 필요합니다.
</div>

<h2>📋 모드 정의 + 성과 카드</h2>
<div class="mode-grid" id="mode-grid"></div>

<h2>📊 모드별 성과표 (전체 비교)</h2>
<div id="cmp-table"></div>

<h2>💡 결론 — 5개 핵심 질문</h2>
<div class="answer-list" id="answers"></div>

<h2>🎯 보드 추천 문구 (직접 복사 가능)</h2>
<div id="copy-boxes"></div>

<h2>🏆 모드별 상위/하위 종목</h2>
<div class="tab-bar" id="tab-bar"></div>
<div id="top-lists"></div>

<footer class="foot">
  <strong>매수 신호 보고서가 아닙니다.</strong> 단일 cutoff(4/30 → 5/4) 분석.
  rolling 검증은 별도 보고서(/wra-rolling-diff)를 함께 참고하세요.
</footer>

<script id="report-data" type="application/json">__JSON_DATA__</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const meta = data.meta || {};
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function fmtNum(v, d) { if (v == null || !isFinite(v)) return '-'; return Number(v).toFixed(d == null ? 2 : d); }
  function fmtPct(v, d) { if (v == null || !isFinite(v)) return '-'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d) + '%'; }
  function fmtMc(v) { if (!v) return '-'; const e = v / 1e8; if (e >= 10000) return (e/10000).toFixed(1) + '조'; return Math.round(e) + '억'; }
  function pctStr(v) { if (v == null) return '-'; return fmtNum(v, 1) + '%'; }
  function clsRet(v) { if (v == null || !isFinite(v)) return ''; return v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : ''); }

  document.getElementById('subtitle').innerHTML =
    'asOfDate <strong>' + meta.asOfDate + '</strong> → validation <strong>' + meta.validationDate + '</strong> · 5/4 반응 매칭 ' + data.sampleCount.withReaction + '/' + data.sampleCount.total + ' · 생성 ' +
    new Date(meta.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  document.getElementById('purpose-box').innerHTML =
    '<strong>🎯 목적:</strong> ' + escapeHtml(meta.requestBackground);
  document.getElementById('cutoff-banner').innerHTML =
    '<strong>🔒 데이터 cutoff:</strong> ' + escapeHtml(meta.cutoffRule);

  // 모드 카드
  const grid = document.getElementById('mode-grid');
  data.modeResults.forEach(m => {
    const s = m.summary;
    const cls = m.id.toLowerCase();
    const div = document.createElement('div');
    div.className = 'mode-card ' + cls;
    if (s.count === 0) {
      div.innerHTML = '<div class="head"><span class="icon">' + m.icon + '</span><span class="title">' + m.title + '</span></div>' +
        '<div class="desc">' + escapeHtml(m.desc) + '</div>' +
        '<div style="color:#64748b;">표본 없음</div>';
      grid.appendChild(div);
      return;
    }
    div.innerHTML =
      '<div class="head"><span class="icon">' + m.icon + '</span><span class="title">' + m.title + '</span></div>' +
      '<div class="desc">' + escapeHtml(m.desc) + '</div>' +
      '<div class="stat-grid">' +
        '<div class="k">후보 수</div><div class="v">' + s.count + '건 (종목 ' + s.uniqueStockCount + ')</div>' +
        '<div class="k">평균 종가%</div><div class="v ' + ((s.avgNextCloseReturn||0) > 0 ? 'pos' : 'neg') + '">' + fmtNum(s.avgNextCloseReturn) + '%</div>' +
        '<div class="k">평균 고가%</div><div class="v pos">' + fmtNum(s.avgNextHighReturn) + '%</div>' +
        '<div class="k">평균 저가%</div><div class="v ' + ((s.avgNextLowReturn||0) > 0 ? 'pos' : 'neg') + '">' + fmtNum(s.avgNextLowReturn) + '%</div>' +
        '<div class="k">+3% 종가</div><div class="v">' + pctStr(s.closeReturnOver3Rate) + '</div>' +
        '<div class="k">+5% 고가</div><div class="v pos">' + pctStr(s.highReturnOver5Rate) + '</div>' +
        '<div class="k">+10% 고가</div><div class="v pos">' + pctStr(s.highReturnOver10Rate) + '</div>' +
        '<div class="k">실패율</div><div class="v neg">' + pctStr(s.failedConfirmRate) + '</div>' +
        '<div class="k">highThenFade</div><div class="v warn">' + pctStr(s.highThenFadeRate) + '</div>' +
        '<div class="k">종가 -2%</div><div class="v neg">' + pctStr(s.closeDropOver2Rate) + '</div>' +
        '<div class="k">거래대금 유지</div><div class="v">' + pctStr(s.valueMaintainedRate) + '</div>' +
        '<div class="k">RR 비율</div><div class="v">' + (s.riskRewardRatio == null ? '-' : fmtNum(s.riskRewardRatio)) + '</div>' +
      '</div>';
    grid.appendChild(div);
  });

  // 비교표
  let cmpHtml = '<table class="cmp"><thead><tr><th>모드</th><th>n</th><th>평균 종가%</th><th>중앙 종가%</th><th>평균 고가%</th><th>+3% 종가</th><th>+5% 고가</th><th>실패율</th><th>highThenFade</th><th>gapUpFail</th><th>종가 -2%</th><th>RR</th></tr></thead><tbody>';
  data.modeResults.forEach(m => {
    const s = m.summary;
    if (s.count === 0) return;
    cmpHtml += '<tr>' +
      '<td>' + m.icon + ' ' + m.title + '</td>' +
      '<td>' + s.count + '</td>' +
      '<td class="' + clsRet(s.avgNextCloseReturn) + '">' + fmtNum(s.avgNextCloseReturn) + '%</td>' +
      '<td>' + fmtNum(s.medNextCloseReturn) + '%</td>' +
      '<td class="cell-pos">' + fmtNum(s.avgNextHighReturn) + '%</td>' +
      '<td>' + pctStr(s.closeReturnOver3Rate) + '</td>' +
      '<td>' + pctStr(s.highReturnOver5Rate) + '</td>' +
      '<td class="cell-neg">' + pctStr(s.failedConfirmRate) + '</td>' +
      '<td class="cell-warn">' + pctStr(s.highThenFadeRate) + '</td>' +
      '<td>' + pctStr(s.gapUpFailRate) + '</td>' +
      '<td class="cell-neg">' + pctStr(s.closeDropOver2Rate) + '</td>' +
      '<td>' + (s.riskRewardRatio == null ? '-' : fmtNum(s.riskRewardRatio)) + '</td>' +
    '</tr>';
  });
  cmpHtml += '</tbody></table>';
  document.getElementById('cmp-table').innerHTML = cmpHtml;

  // 답변
  const ans = data.conclusion.answers || {};
  const ansEl = document.getElementById('answers');
  ['q1_stableSafer','q2_reactionMoved','q3_aggressiveBoth','q4_defaultMode','q5_aggressiveWarning'].forEach(k => {
    const a = ans[k]; if (!a) return;
    const div = document.createElement('div'); div.className = 'answer-item';
    div.innerHTML = '<div class="q">Q. ' + escapeHtml(a.question) + '</div><div class="a">→ ' + escapeHtml(a.answer) + '</div>';
    ansEl.appendChild(div);
  });

  // 추천 문구
  const cb = data.conclusion.recommendBoardCopy || {};
  const cbEl = document.getElementById('copy-boxes');
  const cbDefs = [
    { label: '🛡️ 안정 관찰 모드 배너', text: cb.stableBanner },
    { label: '⚡ 단기 반응 모드 배너', text: cb.reactionBanner },
    { label: '🔥 고위험 공격형 모드 배너', text: cb.aggressiveBanner },
  ];
  cbDefs.forEach(d => {
    const div = document.createElement('div'); div.className = 'copy-box';
    div.innerHTML = '<div class="label">' + d.label + '</div>' + escapeHtml(d.text || '');
    cbEl.appendChild(div);
  });
  // 최종 제안
  const fp = data.conclusion.finalProposal;
  if (fp) {
    const div = document.createElement('div'); div.className = 'recommend-box';
    div.innerHTML = '<strong>🎯 최종 제안:</strong> ' + escapeHtml(fp);
    cbEl.appendChild(div);
  }

  // 모드별 상위/하위 종목 — 탭 형식
  const tabBar = document.getElementById('tab-bar');
  const topLists = document.getElementById('top-lists');
  let activeMode = data.modeResults[0]?.id || 'STABLE';
  data.modeResults.forEach(m => {
    if (m.summary.count === 0) return;
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (m.id === activeMode ? ' active' : '');
    btn.dataset.mode = m.id;
    btn.textContent = m.icon + ' ' + m.title + ' (' + m.summary.count + ')';
    btn.addEventListener('click', () => {
      activeMode = m.id;
      tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTopList();
    });
    tabBar.appendChild(btn);
  });

  function renderTopList() {
    const m = data.modeResults.find(x => x.id === activeMode);
    if (!m) { topLists.innerHTML = ''; return; }
    const tl = m.topLists;
    let html = '';
    function tableHtml(title, list, retField) {
      if (!list || list.length === 0) return '';
      let h = '<h3>' + title + '</h3><table class="evt"><thead><tr><th>종목</th><th>유형</th><th class="numeric">점수</th><th class="numeric">vR20</th><th class="numeric">5/4 시가</th><th class="numeric">5/4 고가%</th><th class="numeric">5/4 종가%</th><th class="numeric">5/4 저가%</th></tr></thead><tbody>';
      list.forEach(c => {
        const r = c.reaction || {};
        h += '<tr>' +
          '<td class="col-name">' + escapeHtml(c.name) + '<span class="meta">' + c.code + ' · ' + (c.market||'-') + ' · ' + fmtMc(c.marketCap) + '</span></td>' +
          '<td><span class="tag-pill t-' + c.tag + '">' + escapeHtml(c.displayLabel || c.tag) + '</span></td>' +
          '<td class="numeric">' + fmtNum(c.finalScore, 1) + '</td>' +
          '<td class="numeric">' + fmtNum(c.valueRatio20, 1) + '×</td>' +
          '<td class="numeric ' + clsRet(r.openRet) + '">' + fmtPct(r.openRet, 2) + '</td>' +
          '<td class="numeric ' + clsRet(r.highRet) + '">' + fmtPct(r.highRet, 2) + '</td>' +
          '<td class="numeric ' + clsRet(r.closeRet) + '">' + fmtPct(r.closeRet, 2) + '</td>' +
          '<td class="numeric ' + clsRet(r.lowRet) + '">' + fmtPct(r.lowRet, 2) + '</td>' +
        '</tr>';
      });
      h += '</tbody></table>';
      return h;
    }
    html += tableHtml('🔥 5/4 종가 수익률 상위 10', tl.topCloseReturn);
    html += tableHtml('🚀 5/4 고가 수익률 상위 10', tl.topHighReturn);
    html += tableHtml('💢 5/4 종가 수익률 하위 10 (실패)', tl.worstCloseReturn);
    if (tl.highThenFade && tl.highThenFade.length > 0) {
      html += tableHtml('🌅 highThenFade 후보 (장중 고가 갔다가 종가에 밀림)', tl.highThenFade);
    }
    topLists.innerHTML = html;
  }
  renderTopList();
})();
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); console.error(e.stack); process.exit(1); }
}
