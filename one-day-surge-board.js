#!/usr/bin/env node
/**
 * 1-Day Surge Board v5 — GOOD_TRADE 중심 리팩토링
 *
 * v4-extra2 검증 결과 반영:
 *   - HIT10 중심 A/B/C/D 그룹 → GOOD_TRADE 중심 GT 그룹 체계로 전환
 *   - 그룹: BALANCED-GT / LIGHT-GT / MID-CAP-GT / MOM-RISK / HEAVY-WATCH / MICRO-RISK / HEAVY-RISK
 *   - 시총 5조 이상 초대형주 / ETF / ETN / 리츠 / 스팩 / 우선주 기본 제외 (passesHardFilter)
 *   - gapRate는 다음날 시초가가 있어야 알 수 있어 카드에 "다음 거래일 시초가 확인 필요" 표시
 *
 * 입력:
 *   - cache/stock-charts-long/{code}.json
 *   - cache/naver-stocks-list.json (marketValue, isEtf, isSpecial)
 *   - stocks.json (보조)
 *   - qva-watchlist-board.json (있으면) QVA 참고 태그
 *   - cache/pattern-result.json (있으면) VVI 참고 태그
 *
 * 출력:
 *   - reports/one-day-surge-board-result.json
 *   - reports/one-day-surge-board-result.html
 *
 * 라우트: GET /one-day-surge-board (sendFile)
 */

const fs = require('fs');
const path = require('path');
const core = require('./one-day-surge-core');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const REPORTS_DIR = path.join(ROOT, 'reports');
const STOCKS_PATH = path.join(ROOT, 'stocks.json');
const NAVER_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const QVA_BOARD_PATH = path.join(ROOT, 'qva-watchlist-board.json');
const PATTERN_RESULT_PATH = path.join(ROOT, 'cache', 'pattern-result.json');
const OUT_JSON = path.join(REPORTS_DIR, 'one-day-surge-board-result.json');
const OUT_HTML = path.join(REPORTS_DIR, 'one-day-surge-board-result.html');

// 그룹별 화면 노출 상한
const GT_CAP = {
  'BALANCED-GT': 80,
  'LIGHT-GT':    80,
  'MID-CAP-GT':  30,
  'MOM-RISK':    60,
  'HEAVY-WATCH': 40,
  'MICRO-RISK':  40,
  'HEAVY-RISK':  30,
};

const GT_GROUP_ORDER = ['BALANCED-GT', 'LIGHT-GT', 'MID-CAP-GT', 'MOM-RISK', 'HEAVY-WATCH', 'MICRO-RISK', 'HEAVY-RISK'];

function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}

// ── meta map ──
function loadStockMetaMap() {
  const map = new Map();
  if (fs.existsSync(STOCKS_PATH)) {
    try {
      const j = JSON.parse(fs.readFileSync(STOCKS_PATH, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (s.shortCode) map.set(s.shortCode, { name: s.name, market: s.market });
      }
    } catch (_) {}
  }
  if (fs.existsSync(NAVER_LIST_PATH)) {
    try {
      const j = JSON.parse(fs.readFileSync(NAVER_LIST_PATH, 'utf-8'));
      for (const s of (j.stocks || [])) {
        if (!s.code) continue;
        const cur = map.get(s.code) || {};
        map.set(s.code, {
          ...cur,
          name: s.name || cur.name,
          market: s.market || cur.market,
          marketCap: s.marketValue || 0,
          isEtf: !!s.isEtf,
          isSpecial: !!s.isSpecial,
        });
      }
    } catch (_) {}
  }
  return map;
}

// ── QVA / VVI 이력 lookup ──
function loadHistoryLookups() {
  const qvaCodes = new Map();
  const vviCodes = new Map();
  if (fs.existsSync(QVA_BOARD_PATH)) {
    try {
      const b = JSON.parse(fs.readFileSync(QVA_BOARD_PATH, 'utf-8'));
      const stages = b.stages || {};
      const order = [
        ['BREAKOUT_SUCCESS', 'H그룹 출신'], ['VVI_FIRED', 'VVI 발생'],
        ['QVA_TODAY', '오늘 QVA'], ['QVA_NEW', 'QVA 신규(D+0)'],
        ['QVA_TRACKING', 'QVA 추적'], ['EARLY_QVA', 'EARLY QVA'],
        ['LONG_QVA_REACTIVE', '장기 QVA 재점화'], ['LONG_QVA_INTEREST', '장기 QVA'],
        ['LONG_QVA_BREAKOUT_DONE', '장기 QVA 돌파'],
      ];
      for (const [stage, label] of order) {
        for (const it of (stages[stage] || [])) {
          if (it.code && !qvaCodes.has(it.code)) qvaCodes.set(it.code, label);
        }
      }
      for (const it of (b.recentVviHistory || [])) {
        if (it.code && !vviCodes.has(it.code)) {
          vviCodes.set(it.code, { signalDate: it.signalDate, daysAfterSignal: it.daysAfterSignal, vviStatus: it.vviStatus });
        }
      }
    } catch (_) {}
  }
  if (fs.existsSync(PATTERN_RESULT_PATH)) {
    try {
      const p = JSON.parse(fs.readFileSync(PATTERN_RESULT_PATH, 'utf-8'));
      for (const it of (p.vviRecentSignals || [])) {
        if (it.code && !vviCodes.has(it.code)) {
          vviCodes.set(it.code, { signalDate: it.signalDate, daysAfterSignal: it.daysAfterSignal, vviStatus: it.vviStatus });
        }
      }
    } catch (_) {}
  }
  return { qvaCodes, vviCodes };
}

// ── 쉬운 말 한 줄 해석 (GT 그룹별) ──
function buildSummaryLine(it) {
  const m = it; // metrics fields are spread on item
  const parts = [];
  if (m.valueRatio >= 5) parts.push(`거래대금이 평소보다 ×${m.valueRatio.toFixed(1)}배 폭증`);
  else if (m.valueRatio >= 3) parts.push(`거래대금이 평소보다 ×${m.valueRatio.toFixed(1)}배 강하게 증가`);
  else if (m.valueRatio >= 2) parts.push(`거래대금이 평소보다 ×${m.valueRatio.toFixed(1)}배 늘었음`);

  if (m.valueToMarketCapRatio != null) {
    if (m.valueToMarketCapRatio >= 20) parts.push(`시총 대비 거래대금 ${m.valueToMarketCapRatio.toFixed(1)}% (회사 크기 대비 매우 강한 수급)`);
    else if (m.valueToMarketCapRatio >= 10) parts.push(`시총 대비 거래대금 ${m.valueToMarketCapRatio.toFixed(1)}% (회사 크기 대비 강한 수급)`);
    else if (m.valueToMarketCapRatio >= 5) parts.push(`시총 대비 거래대금 ${m.valueToMarketCapRatio.toFixed(1)}% (회사 크기에 비해 충분한 수급)`);
  }

  if (m.candleType === 'LOW_GAP_INTRADAY') parts.push('낮은 갭에서 장중 매수세로 끌어올린 캔들 (실전 단타에 유리)');
  else if (m.candleType === 'GAP_HOLD') parts.push('갭상승 후 종가 유지형 (HIT10 높지만 시초가 추격 위험)');
  else if (m.candleType === 'BIG_GREEN') parts.push('장대양봉 마감');
  else if (m.candleType === 'UPPER_WICK_GREEN') parts.push(`윗꼬리 양봉 (윗꼬리 ${(m.upperTailRatio*100).toFixed(0)}%)`);

  if (m.recent5Up15Count === 0) parts.push('최근 5일 첫 급등형');
  else if (m.recent5Up15Count === 1) parts.push('최근 5일 +15% 1회 (sweet spot)');
  else if (m.recent5Up15Count >= 3) parts.push(`최근 5일 +15% ${m.recent5Up15Count}회 (과열 주의)`);

  if (m.dailyValueRank != null && m.dailyValueRank <= 10) parts.push(`거래대금 시장 상위 ${m.dailyValueRank}위`);
  else if (m.dailyValueRank != null && m.dailyValueRank <= 30) parts.push(`거래대금 시장 상위 ${m.dailyValueRank}위`);

  let tail;
  switch (m.gtGroup) {
    case 'BALANCED-GT':
      tail = '균형형 단타 후보. 다음 거래일 장초 시초가가 갭 7% 미만이면 진입 검토.';
      break;
    case 'LIGHT-GT':
      tail = '경량 단타 후보. 다음 거래일 장초 시초가 흐름 확인 후 진입 검토.';
      break;
    case 'MID-CAP-GT':
      tail = '중형 단타 후보. 검증 보고서에서 의외로 강했던 영역 (LOW_GAP_INTRADAY 한정).';
      break;
    case 'MOM-RISK':
      tail = '상한가형(전일 +29%↑). HIT10률은 높지만 시초가 진입자에게 TRAP 위험이 큼 — 추격 금지.';
      break;
    case 'HEAVY-WATCH':
      tail = '준중대형(1.5조~3조). 단타 탄력이 약해 참고로만 봅니다.';
      break;
    case 'MICRO-RISK':
      tail = '초경량(500억~1,000억). 가볍게 튈 수는 있지만 장중 흔들림 큼 — 실전 진입 비추천.';
      break;
    case 'HEAVY-RISK':
      tail = '대형(3조~5조). 단타 탄력이 더 약함 — 보드 하단 배치.';
      break;
    default:
      tail = '';
  }
  return parts.join(', ') + '. ' + tail;
}

function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(CHART_DIR)) {
    console.error('[ERROR] cache/stock-charts-long 디렉토리가 없습니다.');
    process.exit(1);
  }

  console.log('\n📊 1-Day Surge Board v5 (GOOD_TRADE 중심) 생성');
  const metaMap = loadStockMetaMap();
  const { qvaCodes, vviCodes } = loadHistoryLookups();
  const naverCount = [...metaMap.values()].filter(x => x.marketCap > 0).length;
  console.log(`  종목 메타: ${metaMap.size}건 (시총 보유 ${naverCount}건) / QVA 이력: ${qvaCodes.size} / VVI 이력: ${vviCodes.size}`);

  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`  차트 캐시 파일: ${files.length}건`);

  // 1차 통과 — passesHardFilter + analyze + 기본 메트릭 계산
  const candidates = [];
  const filterCounts = { no_meta: 0, etf: 0, special: 0, excluded_name: 0, no_marketcap: 0, mc_under_500: 0, mc_over_5t: 0 };
  let parseErrCount = 0;
  let skippedNoMetrics = 0;

  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    const meta = metaMap.get(code);
    const filt = core.passesHardFilter(meta);
    if (!filt.ok) {
      filterCounts[filt.reason] = (filterCounts[filt.reason] || 0) + 1;
      continue;
    }
    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, f), 'utf-8')); }
    catch (_) { parseErrCount++; continue; }
    const rows = chart && chart.rows;
    const baseIdx = core.pickLatestBaseIdx(rows);
    if (baseIdx < 0) { skippedNoMetrics++; continue; }

    const m = core.analyzeAt(rows, baseIdx);
    if (!m) { skippedNoMetrics++; continue; }
    const s = core.scoreMetrics(m, meta.marketCap);

    // v5 신규 메트릭
    const valueToMarketCapRatio = (meta.marketCap > 0 && Number.isFinite(m.valueAmount))
      ? m.valueAmount / meta.marketCap * 100 : null;
    const candleType = core.classifyCandleType(m);
    const recent5Up7Count = core.countRecentSurges(rows, baseIdx, 5, 7);
    const recent5Up15Count = core.countRecentSurges(rows, baseIdx, 5, 15);
    const recent10Up15Count = core.countRecentSurges(rows, baseIdx, 10, 15);
    const baseGapRate = m.gapPct; // alias

    candidates.push({
      code,
      name: chart.name || meta.name || code,
      market: chart.market || meta.market || '',
      marketCap: meta.marketCap,
      ...m,
      ...s,
      marketCapBandLabel: core.MARKET_CAP_BAND_LABEL[s.marketCapBand],
      gtBand: core.classifyGtBand(meta.marketCap),
      gtBandLabel: core.GT_BAND_LABEL[core.classifyGtBand(meta.marketCap)] || null,
      valueToMarketCapRatio: valueToMarketCapRatio != null ? core.round(valueToMarketCapRatio, 2) : null,
      candleType,
      recent5Up7Count, recent5Up15Count, recent10Up15Count,
      baseGapRate: baseGapRate != null ? core.round(baseGapRate, 2) : null,
      qvaHistoryLabel: qvaCodes.get(code) || null,
      vviHistory: vviCodes.get(code) || null,
    });
  }

  // 2차: 일자내 거래대금 순위 (같은 baseDate 안에서)
  const byDate = new Map();
  for (const it of candidates) {
    if (!byDate.has(it.baseDate)) byDate.set(it.baseDate, []);
    byDate.get(it.baseDate).push(it);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => (b.valueAmount || 0) - (a.valueAmount || 0));
    list.forEach((it, idx) => { it.dailyValueRank = idx + 1; });
  }

  // 3차: GT 그룹 분류
  const grouped = {};
  for (const k of GT_GROUP_ORDER) grouped[k] = [];
  let unclassified = 0;
  for (const it of candidates) {
    const g = core.classifyGtGroup({
      m: it,
      marketCap: it.marketCap,
      valueToMarketCapRatio: it.valueToMarketCapRatio,
      candleType: it.candleType,
      dailyValueRank: it.dailyValueRank,
      recent5Up15Count: it.recent5Up15Count,
    });
    it.gtGroup = g;
    it.summaryLine = buildSummaryLine(it);
    if (g === 'UNCLASSIFIED') { unclassified++; continue; }
    if (grouped[g]) grouped[g].push(it);
  }

  // 4차: 그룹별 정렬
  // 우선: valueToMcRatio 높은 순, 거래대금 순위 높은 순(낮은 숫자), recent5Up15Count 작은 순, LOW_GAP_INTRADAY 우선
  function gtSort(a, b) {
    const lowGapA = a.candleType === 'LOW_GAP_INTRADAY' ? 1 : 0;
    const lowGapB = b.candleType === 'LOW_GAP_INTRADAY' ? 1 : 0;
    if (lowGapB !== lowGapA) return lowGapB - lowGapA;
    const va = a.valueToMarketCapRatio || 0;
    const vb = b.valueToMarketCapRatio || 0;
    if (vb !== va) return vb - va;
    const ra = a.dailyValueRank || 9999;
    const rb = b.dailyValueRank || 9999;
    if (ra !== rb) return ra - rb;
    const r5a = a.recent5Up15Count != null ? a.recent5Up15Count : 99;
    const r5b = b.recent5Up15Count != null ? b.recent5Up15Count : 99;
    if (r5a !== r5b) return r5a - r5b;
    return (b.oneDaySurgeScore || 0) - (a.oneDaySurgeScore || 0);
  }
  for (const g of GT_GROUP_ORDER) {
    grouped[g].sort(gtSort);
    if (grouped[g].length > GT_CAP[g]) grouped[g] = grouped[g].slice(0, GT_CAP[g]);
  }

  // 분석 기준일
  const dateFreq = new Map();
  for (const it of candidates) dateFreq.set(it.baseDate, (dateFreq.get(it.baseDate) || 0) + 1);
  let analysisDate = null, maxFreq = 0;
  for (const [d, c] of dateFreq) { if (c > maxFreq) { maxFreq = c; analysisDate = d; } }

  // 요약 통계
  const all = GT_GROUP_ORDER.flatMap(g => grouped[g]);
  const valueSurgeCount = all.filter(x => x.valueRatio >= 3).length;
  const lowGapCount = all.filter(x => x.candleType === 'LOW_GAP_INTRADAY').length;
  const highVmcCount = all.filter(x => x.valueToMarketCapRatio >= 10).length;

  const out = {
    meta: {
      title: '1-Day Surge Board v5 · GOOD_TRADE 중심 단타 후보 보드',
      generatedAt: new Date().toISOString(),
      analysisDate,
      analysisDateFmt: analysisDate ? fmtDate(analysisDate) : null,
      stockUniverse: files.length,
      candidateTotal: candidates.length,
      shownTotal: all.length,
      basis: '일봉 캐시 기준. 실시간 분봉/호가 미사용. 우선주/ETF/리츠/스팩/관리종목/시총 5조↑·500억↓ 제외. v4-extra2 검증 결과 반영 GT 그룹 체계.',
      filterConfig: {
        marketCapHardMin: core.CONFIG.MARKET_CAP_HARD_MIN,
        marketCapHardMax: core.CONFIG.MARKET_CAP_HARD_MAX,
      },
    },
    counts: Object.assign(
      {},
      ...GT_GROUP_ORDER.map(g => ({ [g]: grouped[g].length })),
      {
        unclassified,
        valueSurgeCount,
        lowGapCount,
        highVmcCount,
        filterRejected: filterCounts,
        skippedNoMetrics,
        parseErrCount,
      }
    ),
    groups: grouped,
    groupOrder: GT_GROUP_ORDER,
    groupLabels: core.GT_GROUP_LABEL,
    groupDescriptions: core.GT_GROUP_DESC,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(out)), 'utf-8');

  console.log(`\n  분석 기준일: ${analysisDate ? fmtDate(analysisDate) : '-'} (가장 흔한 baseDate, 빈도 ${maxFreq})`);
  console.log(`  필터 제외: ETF=${filterCounts.etf} 특수=${filterCounts.special} 키워드=${filterCounts.excluded_name} 시총미확인=${filterCounts.no_marketcap} <500억=${filterCounts.mc_under_500} ≥5조=${filterCounts.mc_over_5t}`);
  console.log(`  후보 풀: ${candidates.length}건 / 노출: ${all.length}건 / 미분류: ${unclassified}건`);
  for (const g of GT_GROUP_ORDER) console.log(`    ${g.padEnd(13)} ${grouped[g].length}건`);
  console.log(`  거래대금 ×3↑ ${valueSurgeCount} / LOW_GAP_INTRADAY ${lowGapCount} / v/mc≥10% ${highVmcCount}`);
  console.log(`\n✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>1-Day Surge Board v5 · 단타 관심 후보</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
}
nav { display:flex; gap:10px; flex-wrap:wrap; padding:8px 0 14px; border-bottom:1px solid #1e293b; margin-bottom:14px; }
nav a { color:#94a3b8; text-decoration:none; font-size:12px; padding:4px 8px; border-radius:4px; }
nav a:hover { color:#e2e8f0; background:#1e293b; }
nav a.active { color:#f1f5f9; background:#1e293b; }

h1 { font-size: 22px; margin: 0 0 4px; color: #f1f5f9; font-weight: 700; }
h2 { font-size: 16px; margin: 22px 0 10px; color: #cbd5e1; }
.subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
.purpose-box { background: #0f172a; border-left: 3px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #67e8f9; }
.warn-box { background: #422006; border-left: 4px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.6; }
.warn-box strong { color: #fcd34d; }
.filter-info { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 12px; font-size: 11px; color: #94a3b8; margin-bottom: 14px; line-height: 1.7; }
.filter-info strong { color: #cbd5e1; }

.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
.summary-cell { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; }
.summary-cell .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px; }
.summary-cell .value { font-size: 20px; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; margin-top: 4px; }
.summary-cell .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
.summary-cell.balanced { border-left: 4px solid #10b981; }
.summary-cell.light    { border-left: 4px solid #38bdf8; }
.summary-cell.mid      { border-left: 4px solid #a78bfa; }
.summary-cell.mom      { border-left: 4px solid #f97316; }
.summary-cell.heavy-w  { border-left: 4px solid #94a3b8; }
.summary-cell.micro    { border-left: 4px solid #fbbf24; }
.summary-cell.heavy-r  { border-left: 4px solid #ef4444; }

.filter-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.filter-btn { padding: 6px 12px; border-radius: 999px; border: 1px solid #334155; background: #1e293b; color: #cbd5e1; font-size: 12px; cursor: pointer; }
.filter-btn:hover { background: #334155; }
.filter-btn.active { background: #1d4ed8; color: #f1f5f9; border-color: #3b82f6; }

.group-section { margin-bottom: 18px; }
.group-header { display: flex; align-items: center; gap: 10px; padding: 10px 0; cursor: pointer; user-select: none; }
.group-header h2 { margin: 0; }
.group-header .toggle { color: #64748b; font-size: 16px; }
.group-desc { font-size: 12px; color: #94a3b8; margin-bottom: 8px; line-height: 1.6; }
.group-body { display: block; }
.group-body.collapsed { display: none; }

.card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
.card.g-BALANCED-GT { border-left: 6px solid #10b981; box-shadow: -3px 0 12px -8px #10b981; }
.card.g-LIGHT-GT    { border-left: 5px solid #38bdf8; }
.card.g-MID-CAP-GT  { border-left: 5px solid #a78bfa; }
.card.g-MOM-RISK    { border-left: 5px solid #f97316; }
.card.g-HEAVY-WATCH { border-left: 5px solid #94a3b8; opacity: 0.95; }
.card.g-MICRO-RISK  { border-left: 5px solid #fbbf24; opacity: 0.92; }
.card.g-HEAVY-RISK  { border-left: 5px solid #ef4444; opacity: 0.85; }

.card h3 { margin: 0 0 6px; font-size: 15px; color: #f1f5f9; font-weight: 700; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.card h3 .code { color: #64748b; font-size: 12px; font-weight: 400; }
.card h3 .market { color: #94a3b8; font-size: 11px; font-weight: 400; padding: 1px 6px; border: 1px solid #334155; border-radius: 4px; }
.card .meta { font-size: 11px; color: #94a3b8; margin-bottom: 8px; display:flex; flex-wrap:wrap; gap:4px; align-items:center; }

.badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px; line-height: 1.3; border: 1px solid transparent; }
.badge.score    { background: #1e293b; color: #f1f5f9; border-color: #475569; font-weight: 700; }
.badge.g-BALANCED-GT { background: #064e3b; color: #6ee7b7; border-color: #10b981; font-weight: 700; }
.badge.g-LIGHT-GT    { background: #0c4a6e; color: #7dd3fc; border-color: #0ea5e9; font-weight: 700; }
.badge.g-MID-CAP-GT  { background: #4c1d95; color: #c4b5fd; border-color: #8b5cf6; font-weight: 700; }
.badge.g-MOM-RISK    { background: #7c2d12; color: #fdba74; border-color: #f97316; font-weight: 700; }
.badge.g-HEAVY-WATCH { background: #1e293b; color: #cbd5e1; border-color: #475569; }
.badge.g-MICRO-RISK  { background: #422006; color: #fde047; border-color: #ca8a04; }
.badge.g-HEAVY-RISK  { background: #7f1d1d; color: #fca5a5; border-color: #ef4444; }
.badge.value-strong { background: #064e3b; color: #a7f3d0; border-color: #10b981; }
.badge.value-mid    { background: #134e4a; color: #5eead4; border-color: #14b8a6; }
.badge.tail      { background: #422006; color: #fde047; border-color: #ca8a04; }
.badge.overheat  { background: #7c2d12; color: #fdba74; border-color: #f97316; }
.badge.breakout  { background: #064e3b; color: #6ee7b7; border-color: #10b981; }
.badge.aux       { background: #1e293b; color: #cbd5e1; border-color: #334155; }
.badge.qva       { background: #312e81; color: #c7d2fe; border-color: #818cf8; }
.badge.vvi       { background: #1e3a8a; color: #bfdbfe; border-color: #3b82f6; }
.badge.candle-low-gap { background: #4c1d95; color: #ddd6fe; border-color: #8b5cf6; font-weight: 700; }
.badge.candle-gap-hold { background: #7c2d12; color: #fdba74; border-color: #f97316; }
.badge.candle-big-green { background: #064e3b; color: #6ee7b7; border-color: #10b981; }
.badge.candle-other { background: #1e293b; color: #cbd5e1; border-color: #334155; }
.badge.vmc-strong { background: #064e3b; color: #a7f3d0; border-color: #10b981; font-weight: 700; }
.badge.vmc-mid    { background: #134e4a; color: #5eead4; border-color: #14b8a6; }
.badge.first-surge   { background: #1e293b; color: #cbd5e1; border-color: #475569; }
.badge.surge-sweet   { background: #064e3b; color: #6ee7b7; border-color: #10b981; }
.badge.surge-overheat { background: #7c2d12; color: #fdba74; border-color: #f97316; }
.badge.gap-info { background: #1e293b; color: #94a3b8; border-color: #334155; }
.badge.gap-warn { background: #422006; color: #fcd34d; border-color: #f59e0b; }
.badge.gap-strong { background: #7c2d12; color: #fdba74; border-color: #f97316; font-weight: 700; }
.badge.gap-extreme { background: #7f1d1d; color: #fca5a5; border-color: #ef4444; font-weight: 700; }
.badge.value-rank-top10 { background: #064e3b; color: #a7f3d0; border-color: #10b981; font-weight: 700; }
.badge.value-rank-top30 { background: #134e4a; color: #5eead4; border-color: #14b8a6; }

.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin: 8px 0; }
.metric { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 7px 10px; }
.metric .label { font-size: 10px; color: #94a3b8; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.3px; }
.metric .value { font-size: 14px; font-weight: 600; color: #e2e8f0; font-variant-numeric: tabular-nums; }
.metric .sub { font-size: 10px; color: #64748b; margin-top: 2px; }
.cell-pos { color: #6ee7b7; }
.cell-neg { color: #fca5a5; }
.cell-warn { color: #fbbf24; }

.summary-line { margin-top: 8px; padding: 8px 12px; background: #0f172a; border-left: 2px solid #38bdf8; border-radius: 4px; font-size: 12px; line-height: 1.7; color: #cbd5e1; }
.gap-note { margin-top: 8px; padding: 6px 10px; background: #0f172a; border-left: 2px solid #94a3b8; border-radius: 4px; font-size: 11px; color: #94a3b8; }

.empty-list { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 24px; text-align: center; color: #64748b; }

footer.foot { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 12px; color: #94a3b8; line-height: 1.7; }

@media (max-width: 900px) {
  body { padding: 12px 12px 60px; }
  .metrics-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
</head>
<body>

<nav>
  <a href="/qva-watchlist">📋 H그룹/VPR 보드</a>
  <a href="/rebreak">🔥 D+5 재돌파 운용</a>
  <a href="/rebreak-deep">🔬 재돌파 심층 검증</a>
  <a href="/one-day-surge-board" class="active">⚡ 단타 관심 후보 v5</a>
  <a href="/one-day-surge-validation">🔬 단타 다음날 검증</a>
</nav>

<h1>⚡ 1-Day Surge Board v5 · 단타 관심 후보 (GOOD_TRADE 중심)</h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  <strong>1DS는 초대형 우량주가 아니라, 시총 대비 거래대금이 강하게 들어온 단기 수급 후보를 찾는 보드입니다.</strong>
  시총 5조 이상 초대형주는 단타 급등 탄력이 약해 기본 제외합니다.
  ETF / ETN / 리츠 / 스팩 / 우선주 / 관리종목도 단타 후보 성격이 아니라 모두 제외합니다.
  v4-extra2 검증 결과를 반영해 그룹을 <strong>BALANCED-GT / LIGHT-GT / MID-CAP-GT / MOM-RISK / HEAVY-WATCH / MICRO-RISK / HEAVY-RISK</strong>로 재편했습니다.
</div>
<div class="warn-box">
  ⚠ 보드는 <strong>전일 종가 기준 일봉 캐시</strong>로 후보를 뽑습니다. 다음날 시초가 이후에만 알 수 있는 갭(gapRate)은
  <strong>"다음 거래일 시초가 확인 필요"</strong>로 표시됩니다. 갭 7% 이상이면 추격 위험, 12% 이상이면 강한 추격 주의로 봅니다.
</div>
<div class="filter-info" id="filter-info"></div>

<h2>📊 오늘 후보 요약</h2>
<div class="summary-grid" id="summary-grid"></div>

<div class="filter-bar" id="filter-bar"></div>

<div id="groups-container"></div>

<footer class="foot" id="foot"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtNum(v) { return v != null && Number.isFinite(v) ? Math.round(v).toLocaleString() : '-'; }
function fmtPct(v, prec) {
  if (v == null || !Number.isFinite(v)) return '-';
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(prec || 2) + '%';
}
function fmtDate(d) { if (!d || d.length !== 8) return d || '-'; return d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8); }
function fmtMoney(v) {
  if (v == null) return '-';
  if (v >= 1e12) return (v/1e12).toFixed(2) + '조';
  if (v >= 1e8) return (v/1e8).toFixed(1) + '억';
  if (v >= 1e4) return (v/1e4).toFixed(0) + '만';
  return Math.round(v).toLocaleString();
}

document.getElementById('subtitle').textContent =
  '분석 기준일: ' + (DATA.meta.analysisDateFmt || '-') +
  ' · 사용 종목 수: ' + DATA.meta.stockUniverse +
  ' · 후보 노출: ' + DATA.meta.shownTotal +
  ' · 생성: ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

(function renderFilterInfo() {
  const r = DATA.counts.filterRejected || {};
  document.getElementById('filter-info').innerHTML =
    '<strong>필터 제외 통계</strong> · 총 ' + DATA.meta.stockUniverse + '개 차트 중 ETF ' + (r.etf||0) +
    ' / 우선주·리츠·스팩·관리종목 등 ' + (r.special||0) +
    ' / 키워드 매칭 ' + (r.excluded_name||0) +
    ' / 시총 미확인 ' + (r.no_marketcap||0) +
    ' / 시총 500억 미만 ' + (r.mc_under_500||0) +
    ' / 시총 5조 이상 ' + (r.mc_over_5t||0) + ' 제외';
})();

function renderSummary() {
  const c = DATA.counts;
  const cells = [
    { lab: 'BALANCED-GT', val: c['BALANCED-GT'], sub: '균형형 단타 후보 (3,000억~7,000억)', cls: 'balanced' },
    { lab: 'LIGHT-GT',    val: c['LIGHT-GT'],    sub: '경량 단타 후보 (1,000억~3,000억)', cls: 'light' },
    { lab: 'MID-CAP-GT',  val: c['MID-CAP-GT'],  sub: '중형 LOW_GAP (7,000억~1.5조)', cls: 'mid' },
    { lab: 'MOM-RISK',    val: c['MOM-RISK'],    sub: '상한가형 (전일 +29%↑)', cls: 'mom' },
    { lab: 'HEAVY-WATCH', val: c['HEAVY-WATCH'], sub: '준중대형 (1.5~3조) 참고', cls: 'heavy-w' },
    { lab: 'MICRO-RISK',  val: c['MICRO-RISK'],  sub: '초경량 (500억~1,000억) 위험 표시', cls: 'micro' },
    { lab: 'HEAVY-RISK',  val: c['HEAVY-RISK'],  sub: '대형 (3~5조) 강한 감점', cls: 'heavy-r' },
    { lab: '거래대금 ×3↑', val: c.valueSurgeCount, sub: '평소 대비 강한 돈 몰림' },
    { lab: 'LOW_GAP_INTRADAY', val: c.lowGapCount, sub: '낮은 갭+장중 매수' },
    { lab: 'v/mc ≥ 10%',  val: c.highVmcCount,    sub: '시총 대비 거래대금 매우 강함' },
  ];
  document.getElementById('summary-grid').innerHTML = cells.map(c =>
    '<div class="summary-cell ' + (c.cls || '') + '"><div class="label">' + c.lab + '</div>' +
    '<div class="value">' + c.val + '</div>' +
    '<div class="sub">' + c.sub + '</div></div>'
  ).join('');
}
renderSummary();

const FILTERS = [
  { key: 'all',         label: '전체' },
  { key: 'BALANCED-GT', label: 'BALANCED-GT' },
  { key: 'LIGHT-GT',    label: 'LIGHT-GT' },
  { key: 'MID-CAP-GT',  label: 'MID-CAP-GT' },
  { key: 'MOM-RISK',    label: 'MOM-RISK (상한가형)' },
  { key: 'low-gap',     label: 'LOW_GAP_INTRADAY 만' },
  { key: 'qva',         label: 'QVA 이력 있음' },
  { key: 'vvi',         label: 'VVI 이력 있음' },
];
let currentFilter = 'all';
function renderFilterBar() {
  document.getElementById('filter-bar').innerHTML = FILTERS.map(f =>
    '<button class="filter-btn' + (currentFilter === f.key ? ' active' : '') + '" data-key="' + f.key + '">' + f.label + '</button>'
  ).join('');
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.addEventListener('click', () => {
      currentFilter = b.dataset.key;
      renderFilterBar();
      renderGroups();
    });
  });
}
renderFilterBar();

const CANDLE_LABEL = {
  LOW_GAP_INTRADAY: '🟣 낮은 갭 + 장중 끌어올림',
  GAP_HOLD:         '🟠 갭상승 유지형 (TRAP 주의)',
  BIG_GREEN:        '🟢 장대양봉',
  UPPER_WICK_GREEN: '🟡 윗꼬리 양봉',
  RED_CLOSE:        '🔴 음봉 마감',
  OTHER:            '⚪ 기타',
};

function buildCardHtml(it) {
  const badges = [];
  // 그룹 라벨
  const groupLabel = (DATA.groupLabels && DATA.groupLabels[it.gtGroup]) || it.gtGroup;
  badges.push('<span class="badge g-' + it.gtGroup + '">' + groupLabel + '</span>');
  // 시총 + 점수
  badges.push('<span class="badge aux" title="' + (it.gtBandLabel || '') + '">' + fmtMoney(it.marketCap) + '</span>');
  badges.push('<span class="badge score">총점 ' + it.oneDaySurgeScore + '</span>');

  // v/mc 비율
  if (it.valueToMarketCapRatio != null) {
    if (it.valueToMarketCapRatio >= 20)      badges.push('<span class="badge vmc-strong">시총대비 ' + it.valueToMarketCapRatio.toFixed(1) + '% 폭증</span>');
    else if (it.valueToMarketCapRatio >= 10) badges.push('<span class="badge vmc-strong">시총대비 ' + it.valueToMarketCapRatio.toFixed(1) + '% 강함</span>');
    else if (it.valueToMarketCapRatio >= 5)  badges.push('<span class="badge vmc-mid">시총대비 ' + it.valueToMarketCapRatio.toFixed(1) + '%</span>');
  }

  // 캔들
  if (it.candleType === 'LOW_GAP_INTRADAY') badges.push('<span class="badge candle-low-gap" title="낮은 갭에서 장중 매수세로 끌어올림 — 실전 단타 유리">' + CANDLE_LABEL[it.candleType] + '</span>');
  else if (it.candleType === 'GAP_HOLD')    badges.push('<span class="badge candle-gap-hold" title="갭상승 후 종가 유지 — HIT10 높지만 시초가 추격 위험">' + CANDLE_LABEL[it.candleType] + '</span>');
  else if (it.candleType === 'BIG_GREEN')   badges.push('<span class="badge candle-big-green">' + CANDLE_LABEL[it.candleType] + '</span>');
  else if (it.candleType && it.candleType !== 'OTHER') badges.push('<span class="badge candle-other">' + (CANDLE_LABEL[it.candleType] || it.candleType) + '</span>');

  // 거래대금 일자내 순위
  if (it.dailyValueRank != null) {
    if (it.dailyValueRank <= 10) badges.push('<span class="badge value-rank-top10">시장 거래대금 #' + it.dailyValueRank + '</span>');
    else if (it.dailyValueRank <= 30) badges.push('<span class="badge value-rank-top30">시장 거래대금 #' + it.dailyValueRank + '</span>');
  }

  // 최근 급등 횟수
  if (it.recent5Up15Count != null) {
    if (it.recent5Up15Count === 0) badges.push('<span class="badge first-surge">첫 급등형</span>');
    else if (it.recent5Up15Count === 1) badges.push('<span class="badge surge-sweet">최근 5일 +15% 1회 (sweet spot)</span>');
    else if (it.recent5Up15Count >= 3) badges.push('<span class="badge surge-overheat">최근 5일 +15% ' + it.recent5Up15Count + '회 (과열)</span>');
  }

  // 거래대금 배율
  if (it.valueRatio >= 5) badges.push('<span class="badge value-strong">거래대금 ×' + it.valueRatio.toFixed(1) + ' 폭증</span>');
  else if (it.valueRatio >= 3) badges.push('<span class="badge value-strong">거래대금 ×' + it.valueRatio.toFixed(1) + ' 강함</span>');
  else if (it.valueRatio >= 2) badges.push('<span class="badge value-mid">거래대금 ×' + it.valueRatio.toFixed(1) + '</span>');

  if (it.isBreakoutOf20) badges.push('<span class="badge breakout">20일 고점 돌파</span>');
  else if (it.nearHigh20) badges.push('<span class="badge breakout">20일 고점 근접</span>');
  if (it.upperTailRatio >= 0.4) badges.push('<span class="badge tail">윗꼬리 ' + (it.upperTailRatio*100).toFixed(0) + '%</span>');
  if ((it.ret3d != null && it.ret3d >= 25) || (it.ret5d != null && it.ret5d >= 40)) {
    badges.push('<span class="badge overheat">최근 과열</span>');
  }

  // QVA / VVI 참고 태그
  if (it.qvaHistoryLabel) badges.push('<span class="badge qva" title="참고용: 본 보드 점수와 무관">QVA 이력: ' + it.qvaHistoryLabel + '</span>');
  if (it.vviHistory && it.vviHistory.signalDate) {
    badges.push('<span class="badge vvi" title="참고용: 본 보드 점수와 무관">VVI 이력 ' + fmtDate(it.vviHistory.signalDate) + (it.vviHistory.daysAfterSignal != null ? ' (D+' + it.vviHistory.daysAfterSignal + ')' : '') + '</span>');
  }

  const chgCls = it.changeRate > 0 ? 'cell-pos' : (it.changeRate < 0 ? 'cell-neg' : '');
  const cpCls  = it.closePosition >= 0.7 ? 'cell-pos' : (it.closePosition < 0.4 ? 'cell-neg' : '');
  const tailCls = it.upperTailRatio >= 0.4 ? 'cell-warn' : '';
  const distCls = it.distFromHigh20 == null ? '' : (it.distFromHigh20 >= 0 ? 'cell-pos' : (it.distFromHigh20 < -10 ? 'cell-neg' : ''));

  return '<div class="card g-' + it.gtGroup + '" data-group="' + it.gtGroup + '" data-candle="' + (it.candleType || '') + '" data-qva="' + (it.qvaHistoryLabel ? '1' : '0') + '" data-vvi="' + (it.vviHistory ? '1' : '0') + '">' +
    '<h3>' + (it.name || '-') + ' <span class="code">' + it.code + '</span> <span class="market">' + (it.market || '-') + '</span></h3>' +
    '<div class="meta">' + badges.join('') + '</div>' +
    '<div class="metrics-grid">' +
      '<div class="metric"><div class="label">기준일 종가</div><div class="value">' + fmtNum(it.close) + '원</div><div class="sub">' + fmtDate(it.baseDate) + '</div></div>' +
      '<div class="metric"><div class="label">전일 등락률</div><div class="value ' + chgCls + '">' + fmtPct(it.changeRate, 2) + '</div><div class="sub">기준일 갭 ' + fmtPct(it.baseGapRate, 2) + '</div></div>' +
      '<div class="metric"><div class="label">시가총액</div><div class="value">' + fmtMoney(it.marketCap) + '원</div><div class="sub">' + (it.gtBandLabel || '-') + '</div></div>' +
      '<div class="metric"><div class="label">시총 대비 거래대금</div><div class="value">' + (it.valueToMarketCapRatio != null ? it.valueToMarketCapRatio.toFixed(1) + '%' : '-') + '</div><div class="sub">v/mc — 5%↑ 의미 / 10%↑ 강함</div></div>' +
      '<div class="metric"><div class="label">거래대금</div><div class="value">' + fmtMoney(it.valueAmount) + '원</div><div class="sub">평소 대비 ×' + (it.valueRatio != null ? it.valueRatio.toFixed(2) : '-') + '</div></div>' +
      '<div class="metric"><div class="label">시장 거래대금 순위</div><div class="value">#' + (it.dailyValueRank || '-') + '</div><div class="sub">일자내 valueAmount 순</div></div>' +
      '<div class="metric"><div class="label">종가 위치</div><div class="value ' + cpCls + '">' + (it.closePosition*100).toFixed(0) + '%</div><div class="sub">고가 1.0 / 저가 0.0</div></div>' +
      '<div class="metric"><div class="label">윗꼬리</div><div class="value ' + tailCls + '">' + (it.upperTailRatio*100).toFixed(0) + '%</div><div class="sub">≥40% 부담 / ≥60% 강함</div></div>' +
      '<div class="metric"><div class="label">최근 5일 +15% 횟수</div><div class="value">' + (it.recent5Up15Count != null ? it.recent5Up15Count + '회' : '-') + '</div><div class="sub">0~1회 sweet / 3회↑ 과열</div></div>' +
      '<div class="metric"><div class="label">최근 3일 / 5일</div><div class="value">' + fmtPct(it.ret3d, 1) + ' / ' + fmtPct(it.ret5d, 1) + '</div><div class="sub">누적 상승률</div></div>' +
      '<div class="metric"><div class="label">20일 고점 대비</div><div class="value ' + distCls + '">' + fmtPct(it.distFromHigh20, 2) + '</div><div class="sub">' + (it.high20 != null ? fmtNum(it.high20) + '원' : '-') + '</div></div>' +
      '<div class="metric"><div class="label">캔들 구조</div><div class="value">' + (CANDLE_LABEL[it.candleType] || '-') + '</div><div class="sub">실전 단타 우선 = LOW_GAP</div></div>' +
    '</div>' +
    '<div class="summary-line">💡 ' + (it.summaryLine || '') + '</div>' +
    '<div class="gap-note">🚪 다음 거래일 시초가가 나오면 갭 7% 이상은 "갭 과열 주의", 12% 이상은 "강한 추격 주의", 20% 이상은 "초고위험 갭"으로 표시됩니다. 7% 미만이면 "장초 확인 가능 구간".</div>' +
    '</div>';
}

function renderGroups() {
  const html = [];
  for (const g of (DATA.groupOrder || [])) {
    let list = (DATA.groups[g] || []).slice();
    list = list.filter(it => {
      if (currentFilter === 'all') return true;
      if (currentFilter === 'qva') return !!it.qvaHistoryLabel;
      if (currentFilter === 'vvi') return !!it.vviHistory;
      if (currentFilter === 'low-gap') return it.candleType === 'LOW_GAP_INTRADAY';
      return it.gtGroup === currentFilter;
    });
    const title = (DATA.groupLabels && DATA.groupLabels[g]) || g;
    const desc  = (DATA.groupDescriptions && DATA.groupDescriptions[g]) || '';
    const opened = ['BALANCED-GT', 'LIGHT-GT', 'MID-CAP-GT'].includes(g);
    html.push(
      '<section class="group-section">' +
        '<div class="group-header" data-grp="' + g + '">' +
          '<h2>' + title + ' <span style="color:#64748b;font-size:13px;font-weight:400;">(' + list.length + '건)</span></h2>' +
          '<span class="toggle">' + (opened ? '▼' : '▶') + '</span>' +
        '</div>' +
        '<div class="group-desc">' + desc + '</div>' +
        '<div class="group-body' + (opened ? '' : ' collapsed') + '" data-grp-body="' + g + '">' +
          (list.length === 0 ? '<div class="empty-list">조건에 맞는 후보가 없습니다.</div>' : list.map(buildCardHtml).join('')) +
        '</div>' +
      '</section>'
    );
  }
  document.getElementById('groups-container').innerHTML = html.join('') || '<div class="empty-list">조건에 맞는 후보가 없습니다.</div>';
  document.querySelectorAll('.group-header').forEach(h => {
    h.addEventListener('click', () => {
      const g = h.dataset.grp;
      const body = document.querySelector('[data-grp-body="' + g + '"]');
      const toggle = h.querySelector('.toggle');
      if (body) {
        body.classList.toggle('collapsed');
        if (toggle) toggle.textContent = body.classList.contains('collapsed') ? '▶' : '▼';
      }
    });
  });
}
renderGroups();

document.getElementById('foot').innerHTML =
  '<strong>v5 GT 그룹 분류 (검증 보고서 v4-extra2 권고 반영)</strong><br>' +
  '• <strong>BALANCED-GT</strong> — 시총 3,000억~7,000억 + valueToMcRatio ≥ 5% + (LOW_GAP_INTRADAY 또는 거래대금 시장 상위 30위)<br>' +
  '• <strong>LIGHT-GT</strong> — 시총 1,000억~3,000억 + valueToMcRatio ≥ 5% + recent5Up15Count ≤ 1회<br>' +
  '• <strong>MID-CAP-GT</strong> — 시총 7,000억~1.5조 + valueToMcRatio ≥ 5% + LOW_GAP_INTRADAY 한정<br>' +
  '• <strong>MOM-RISK</strong> — 전일 +29% 이상 (상한가형 — HIT10 높지만 TRAP 큼, 추격 금지)<br>' +
  '• <strong>HEAVY-WATCH</strong> — 시총 1.5조~3조 (단타 탄력 약화, 참고)<br>' +
  '• <strong>MICRO-RISK</strong> — 시총 500억~1,000억 (실전 진입 비추천, 위험 표시)<br>' +
  '• <strong>HEAVY-RISK</strong> — 시총 3조~5조 (강한 감점, 보드 하단)<br>' +
  '<br><strong>제외 조건 (one-day-surge-core.js passesHardFilter)</strong><br>' +
  '• ETF / ETN / 리츠 / 스팩 / 우선주 / 관리종목 (naver isEtf · isSpecial 플래그 + 키워드 매칭)<br>' +
  '• 키워드 매칭: ETF, ETN, KODEX, TIGER, ACE, SOL, KBSTAR, HANARO, ARIRANG, TIMEFOLIO, KOSEF, 히어로즈, PLUS, 인버스, 레버리지, 리츠, 스팩, 제1호~제4호, 종목명 끝 우/우B/숫자우/숫자우B/숫자우C<br>' +
  '• 시가총액 500억 미만 / 5조 이상 → 제외 · 시총 미확인 → 제외<br>' +
  '<br><strong>정렬 기준 (각 그룹 내)</strong><br>' +
  '• LOW_GAP_INTRADAY 우선 → valueToMcRatio 높은 순 → 일자내 거래대금 순위 높은 순(낮은 숫자) → recent5Up15Count 작은 순<br>' +
  '<br><strong>다음 거래일 갭(gapRate) 처리</strong><br>' +
  '• 보드는 전일 종가 기준이라 다음날 시초가 없음 — 카드 하단 "다음 거래일 시초가 확인 필요" 표시<br>' +
  '• 다음날 장초에 gapRate < 7% 면 장초 확인 가능 구간, 7%↑ 갭 과열 주의, 12%↑ 강한 추격 주의, 20%↑ 초고위험 갭<br>' +
  '<br>' +
  '• <strong>QVA / VVI 이력은 참고 태그</strong>이며 본 보드 점수에는 들어가지 않습니다. (검증 보고서 v3 결론 — QVA 단독 가점 금지)<br>' +
  '• <strong>매수 확정 신호가 아닙니다.</strong> 다음 거래일 장초 흐름 확인용 매수후보 좁히기 보드입니다.';
</script>

</body>
</html>
`;

main();
