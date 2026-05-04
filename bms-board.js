#!/usr/bin/env node
/**
 * BMS 보드 — 운영용 화면 (실험 모델)
 *
 * BMS는 과거 +40% 상승 종목의 시작 조건과 현재 종목의 유사도를 보여주는 모델입니다.
 * QVA 보드와 분리되어 운영되며, BMS 점수가 높다고 매수 후보가 아닙니다.
 *
 * 데이터 의존성:
 *   - big-move-similarity-report.json (baselines / latestTradingDate 사용)
 *   - cache/stock-charts-long/{code}.json
 *   - cache/flow-history/{code}.json
 *
 * 섹션 구성:
 *   1. BMS 강한 + 신선
 *   2. BMS 강한 + 추세 후반
 *   3. BMS 관심 + 눌림 대기
 *   4. 기준일 거래대금 폭발
 *   5. BMS TOP 50
 *   6. BMS 과열/제외 (기본 접힘)
 *
 * 출력:
 *   - bms-board.json
 *   - bms-board.html
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

const MIN_MARKET_CAP = 30_000_000_000;

// 분석 제외 상품 — 보고서와 동일
const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];
function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

function fmtDate(d) {
  if (!d || d.length !== 8) return d || '-';
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}

// KST 시간대 헬퍼
function kstDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit' }).format(d).replace(/-/g, '');
}
function kstDateTimeStr(d) {
  // YYYY-MM-DD HH:mm
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12: false }).format(d).replace(',', '');
}
function kstDayOfWeek(d) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(d);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd];
}

// 다음 거래일 추정 (latestDate 이후 첫 평일, todayKST 이후로 보정)
// 한국 공휴일은 인식하지 못하므로 "예상"임을 명시할 것
function estimateNextTradingDate(latestDate, todayDate) {
  const parse = (s) => new Date(parseInt(s.slice(0,4)), parseInt(s.slice(4,6))-1, parseInt(s.slice(6,8)));
  const fmt = (d) => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  let d = parse(latestDate);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const today = parse(todayDate);
  if (d < today) {
    d = new Date(today);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  }
  return fmt(d);
}

function loadStocks() {
  const data = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  const map = {};
  (data.stocks || []).forEach(s => { map[s.code] = s; });
  return map;
}
function loadFlow(code) {
  const fp = path.join(FLOW_DIR, `${code}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return j.rows || null;
  } catch (_) { return null; }
}

// 캘린더 7일 전 (latestDate 이전)
function staleCutoff(latestDate, days = 7) {
  const y = parseInt(latestDate.slice(0, 4));
  const m = parseInt(latestDate.slice(4, 6)) - 1;
  const d = parseInt(latestDate.slice(6, 8));
  const dt = new Date(y, m, d);
  dt.setDate(dt.getDate() - days);
  return `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}`;
}

// 추가 가격/수익률 지표 (BMS scoreCurrentCandidate에 포함되지 않은 ret5/10/20/40)
function extraMetrics(rows) {
  const last = rows[rows.length - 1];
  const closeAt = (n) => rows[Math.max(0, rows.length - 1 - n)]?.close;
  const ret = (n) => {
    const c = closeAt(n);
    return c ? (last.close / c - 1) * 100 : null;
  };
  return {
    recent5Return: ret(5),
    recent10Return: ret(10),
    recent20Return: ret(20),
    recent40Return: ret(40),
    todayHigh: last.high,
    todayLow: last.low,
    todayOpen: last.open,
    closeLocation: (last.high - last.low) > 0 ? (last.close - last.low) / (last.high - last.low) : 0.5,
  };
}

// 위치 라벨 분류 — 한 후보당 단일 라벨 (우선순위)
function classifyPosition(c) {
  const s = c.normalizedScore;
  const sn = c.snapshot;
  const e = c.extra;
  const todayReturn = c.today.todayReturn;

  // 1. 과열 — 단기 급등
  if ((todayReturn > 10) || (e.recent5Return != null && e.recent5Return > 25)) return '과열';

  // 2. 강한 + 신선
  if (s >= 80 &&
      (e.recent20Return == null || e.recent20Return <= 25) &&
      (e.recent40Return == null || e.recent40Return <= 30) &&
      sn.returnFromLow60 <= 50) return '신선';

  // 3. 강한 + 추세 후반
  if (s >= 80 && ((e.recent40Return != null && e.recent40Return > 30) || sn.returnFromLow60 > 50)) return '추세 후반';

  // 4. 관심 + 눌림 대기
  if (s >= 65 && s < 80 &&
      sn.distanceFromHigh60 <= -20 &&
      sn.closeAboveMa20 && sn.closeMa20Gap >= -5) return '눌림 대기';

  // 5. 이미 급등
  if ((e.recent20Return != null && e.recent20Return > 25) ||
      (e.recent40Return != null && e.recent40Return > 30)) return '이미 급등';

  // 6. 그 외
  return '관찰';
}

// 4/30 기준 교차 신호 — QVA / QVA Higher Low / QVA Evolution / VVI / 최근 40일 VVI 발화
// 반환: { tags: [...], recentVVI: { date, daysAgo, score, signalClose } | null,
//         qvaHL, qvaEv, qvaBasic } 형태로 BMS-H 판정에 필요한 정보를 명시 노출
function computeCrossSignals(rows, flowRows, code, marketValue) {
  const tags = [];
  let qvaBasic = null, qvaHL = null, qvaEv = null, vviToday = null, recentVVI = null;

  try {
    const r = ps.calculateQuietVolumeAnomaly(rows, flowRows || [], { code, marketValue });
    if (r && r.passed) { qvaBasic = r.score || true; tags.push({ name: '기본 QVA', score: r.score }); }
  } catch (_) {}

  try {
    const r = ps.calculateQuietVolumeHigherLow(rows, flowRows || [], { code, marketValue });
    if (r && r.score) {
      qvaHL = r.score;
      if (r.score >= 70) tags.push({ name: 'QVA Higher Low', score: r.score });
    }
  } catch (_) {}

  try {
    if (ps.calculateQvaEvolution) {
      const r = ps.calculateQvaEvolution(rows, flowRows || [], { code, marketValue });
      if (r && r.score) {
        qvaEv = r.score;
        if (r.score >= 70) tags.push({ name: 'QVA Evolution', score: r.score });
      }
    }
  } catch (_) {}

  try {
    const r = ps.calculateVolumeValueIgnition(rows, flowRows || [], { code, marketValue });
    if (r && r.passed) {
      vviToday = r.score || r.totalScore || null;
      tags.push({ name: '돌파 성공', score: vviToday });
    }
  } catch (_) {}

  // 최근 40일 안 가장 최근 VVI 발화일
  for (let lb = 0; lb <= 40; lb++) {
    const sliceEnd = rows.length - lb;
    if (sliceEnd < 60) break;
    const past = rows.slice(0, sliceEnd);
    try {
      const v = ps.calculateVolumeValueIgnition(past, flowRows || [], { code, marketValue });
      if (v && v.passed) {
        const signalRow = past[past.length - 1];
        recentVVI = {
          date: signalRow.date,
          daysAgo: lb,
          score: v.score || v.totalScore || null,
          signalClose: signalRow.close,
        };
        if (lb > 0) tags.push({ name: `VVI D+${lb}`, score: recentVVI.score });
        break;
      }
    } catch (_) {}
  }

  return { tags, recentVVI, qvaHL, qvaEv, qvaBasic, vviToday };
}

// ─────────────────────── 메인 ───────────────────────

function main() {
  console.log('═'.repeat(80));
  console.log('BMS 보드 생성');
  console.log('═'.repeat(80));

  if (!fs.existsSync(REPORT_JSON)) {
    console.error('big-move-similarity-report.json이 없습니다. 먼저 `node big-move-similarity-report.js`를 실행하세요.');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(REPORT_JSON, 'utf-8'));
  const baselines = report.baselines;
  const latestDate = report.meta.latestTradingDate;
  const staleCut = staleCutoff(latestDate, 7);

  console.log(`기준일: ${fmtDate(latestDate)}`);
  console.log(`baseline episode: ${report.meta.totalEpisodes}개`);

  const stockMap = loadStocks();
  const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));
  console.log(`${files.length}개 차트 점수화 시작...`);

  const allCandidates = [];
  let processed = 0;
  files.forEach((file, idx) => {
    const code = file.replace('.json', '');
    const meta = stockMap[code];
    if (!meta) return;
    if (isExcludedProduct(meta.name)) return;

    let chart;
    try { chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8')); }
    catch (_) { return; }
    let rows = chart.rows || [];
    // latestDate 이후 데이터 잘라내기 (5/4 같은 이상치 row 제거)
    rows = rows.filter(r => r.date <= latestDate);
    if (rows.length < 60) return;
    if (rows[rows.length - 1].date < staleCut) return;

    const marketCap = meta.marketValue || 0;
    if (marketCap < MIN_MARKET_CAP) return;

    const flowRows = loadFlow(code);
    const result = bms.scoreCurrentCandidate(rows, marketCap, flowRows, baselines, latestDate);
    if (!result) return;

    const e = extraMetrics(rows);

    const c = {
      code, name: meta.name, market: meta.market, marketCap,
      ...result,
      extra: e,
    };
    c.positionLabel = classifyPosition(c);
    allCandidates.push(c);

    processed++;
    if ((idx + 1) % 500 === 0) process.stdout.write(`\r진행: ${idx + 1}/${files.length}`);
  });
  console.log(`\r${allCandidates.length}개 후보 점수화 완료 (처리 ${processed})`);

  // 정렬 및 rank 부여
  allCandidates.sort((a, b) => b.normalizedScore - a.normalizedScore);
  allCandidates.forEach((c, i) => { c.rank = i + 1; c.totalCount = allCandidates.length; });

  // 섹션 분류 (Forward Backtest 결과 반영해서 재구성)
  const strongFresh = allCandidates.filter(c =>
    c.normalizedScore >= 80 &&
    (c.extra.recent20Return == null || c.extra.recent20Return <= 25) &&
    (c.extra.recent40Return == null || c.extra.recent40Return <= 30) &&
    c.snapshot.returnFromLow60 <= 50
  );

  const strongLate = allCandidates.filter(c =>
    c.normalizedScore >= 80 &&
    ((c.extra.recent40Return != null && c.extra.recent40Return > 30) || c.snapshot.returnFromLow60 > 50)
  );

  const interestPullback = allCandidates.filter(c =>
    c.normalizedScore >= 65 && c.normalizedScore < 80 &&
    c.snapshot.distanceFromHigh60 <= -20 &&
    c.snapshot.closeAboveMa20 && c.snapshot.closeMa20Gap >= -5
  );

  // 거래대금 폭발 + 매물대 낮음 (Forward 백테스트 J 그룹: D+10 +3.40%, +10% 도달 68%)
  const explosiveLowOverhead = allCandidates.filter(c =>
    c.normalizedScore >= 80 &&
    c.today.todayValueRatio >= 4 &&
    c.snapshot.overheadSupply10 <= 0.15 &&
    c.extra.closeLocation >= 0.50
  );

  const top50 = allCandidates.slice(0, 50);

  const overheated = allCandidates.filter(c =>
    c.normalizedScore >= 50 &&
    (c.today.todayReturn > 10 ||
     (c.extra.recent20Return != null && c.extra.recent20Return > 30) ||
     (c.extra.recent5Return != null && c.extra.recent5Return > 25))
  );

  // 분류 라벨 통계
  const classification = {};
  allCandidates.forEach(c => { classification[c.positionLabel] = (classification[c.positionLabel] || 0) + 1; });

  // 교차 신호 — BMS Score >= 80 모든 후보 + 기존 섹션 (BMS-H 판정에 필요)
  const tagCodes = new Set();
  allCandidates.forEach(c => { if (c.normalizedScore >= 80) tagCodes.add(c.code); });
  [...strongFresh, ...strongLate, ...interestPullback, ...explosiveLowOverhead.slice(0, 50), ...top50].forEach(c => tagCodes.add(c.code));

  console.log();
  console.log(`교차 신호 계산 (${tagCodes.size}개 후보, QVA/VVI/최근 VVI 검증)...`);

  const signalMap = {};
  let tagCount = 0;
  tagCodes.forEach(code => {
    const file = path.join(CHART_DIR, code + '.json');
    if (!fs.existsSync(file)) return;
    let chart;
    try { chart = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return; }
    let rows = (chart.rows || []).filter(r => r.date <= latestDate);
    const meta = stockMap[code];
    if (!meta) return;
    const flowRows = loadFlow(code);
    signalMap[code] = computeCrossSignals(rows, flowRows, code, meta.marketValue);
    tagCount++;
    if (tagCount % 50 === 0) process.stdout.write(`\r교차 신호: ${tagCount}/${tagCodes.size}`);
  });
  console.log(`\r교차 신호 완료 (${tagCount}개)`);

  // 신호 정보를 모든 후보에 부착 (allCandidates도 포함 — BMS-H 판정에 필요)
  allCandidates.forEach(c => {
    const s = signalMap[c.code] || { tags: [], recentVVI: null };
    c.crossTags = s.tags;
    c.recentVVI = s.recentVVI;
    c.qvaHL = s.qvaHL;
    c.qvaEv = s.qvaEv;
    c.qvaBasic = s.qvaBasic;
    c.vviToday = s.vviToday;
  });

  // 🏆 BMS-H 후보군 (Forward Backtest 검증 결과: D+10 +8.19%, +10% 도달 73%, MFE10 +22.3%)
  // 정의: BMS Score >= 80 AND 최근 40거래일 안 VVI 발화 AND 현재가 >= VVI 신호가 × 0.95
  const bmsH = allCandidates.filter(c =>
    c.normalizedScore >= 80 &&
    c.recentVVI &&
    c.recentVVI.daysAgo <= 40 &&
    c.today.close >= c.recentVVI.signalClose * 0.95
  );

  // 💎 BMS+QVA+VVI 삼중 충족 (Forward Backtest 그룹 L: n=15, +10% 도달 87%, 표본 작음 주의)
  const tripleQVA = bmsH.filter(c =>
    (c.qvaBasic) ||
    (c.qvaHL != null && c.qvaHL >= 80) ||
    (c.qvaEv != null && c.qvaEv >= 70)
  );

  // BMS-H / 삼중 충족 플래그를 모든 카드에 부여 (UI 뱃지용)
  const bmsHSet = new Set(bmsH.map(c => c.code));
  const tripleSet = new Set(tripleQVA.map(c => c.code));
  allCandidates.forEach(c => {
    c.isBmsH = bmsHSet.has(c.code);
    c.isTriple = tripleSet.has(c.code);
  });

  // 섹션 분류 출력
  console.log();
  console.log('섹션 분류 (Forward Backtest 검증 반영):');
  console.log(`  1. 🏆 BMS-H 후보 (BMS+VVI 후속, 검증 D+10 +8.19%): ${bmsH.length}`);
  console.log(`  2. 💎 BMS+QVA+VVI 삼중 충족 (검증 +10% 도달 87%): ${tripleQVA.length}`);
  console.log(`  3. 💥 거래대금 폭발+매물대 낮음 (검증 D+10 +3.40%): ${explosiveLowOverhead.length}`);
  console.log(`  4. 🔥 구조 유사도 높음+추세 후반: ${strongLate.length}`);
  console.log(`  5. 🌱 구조 유사도 높음+신선: ${strongFresh.length}`);
  console.log(`  6. 👀 관심+눌림 대기: ${interestPullback.length}`);
  console.log(`  7. 📊 BMS TOP 50: ${top50.length}`);
  console.log(`  8. ⚠️  과열/제외: ${overheated.length}`);
  console.log('위치 라벨 분포:', classification);

  // 와이엠티/한온시스템 검증 출력
  const checks = ['251370', '018880'];
  console.log();
  console.log('필수 검증:');
  checks.forEach(code => {
    const c = allCandidates.find(x => x.code === code);
    if (!c) { console.log(`  ${code}: 후보에 없음`); return; }
    const inSections = [];
    if (bmsH.includes(c)) inSections.push('1. 🏆 BMS-H');
    if (tripleQVA.includes(c)) inSections.push('2. 💎 삼중 충족');
    if (explosiveLowOverhead.includes(c)) inSections.push('3. 💥 거래대금 폭발+매물대낮음');
    if (strongLate.includes(c)) inSections.push('4. 🔥 추세 후반');
    if (strongFresh.includes(c)) inSections.push('5. 🌱 신선');
    if (interestPullback.includes(c)) inSections.push('6. 👀 눌림 대기');
    if (top50.includes(c)) inSections.push('7. 📊 TOP 50');
    if (overheated.includes(c)) inSections.push('8. ⚠️  과열');
    console.log(`  ${c.name}(${c.code}) BMS=${c.normalizedScore} 위치=${c.positionLabel} #${c.rank} → 섹션: ${inSections.join(' / ') || '없음'}`);
    const sg = signalMap[code];
    if (sg) {
      const tags = sg.tags.map(t => t.name + (t.score?'('+t.score+')':'')).join(', ');
      console.log(`    교차 신호: ${tags || '없음'}`);
      if (sg.recentVVI) console.log(`    최근 VVI: ${sg.recentVVI.date} D+${sg.recentVVI.daysAgo} 신호가 ${sg.recentVVI.signalClose}원`);
    }
  });

  // 메타 시간 정보
  const generatedAt = new Date();
  const todayCalendarDate = kstDateStr(generatedAt);
  const generatedAtKST = kstDateTimeStr(generatedAt);
  const dowKST = kstDayOfWeek(generatedAt);
  const isMarketClosedToday = dowKST === 0 || dowKST === 6;
  const nextTradingDate = estimateNextTradingDate(latestDate, todayCalendarDate);
  // dataCoverageRatio: 차트 보유 + 점수화 통과 비율 (전체 차트 대비)
  const dataCoverageRatio = files.length ? allCandidates.length / files.length : 0;

  // QVA 보드 lookup 만들기 (보조 태그 + 검색 안내용)
  let qvaLookup = {};
  let qvaBoardMeta = null;
  try {
    const qvaBoardPath = path.join(ROOT, 'qva-watchlist-board.json');
    if (fs.existsSync(qvaBoardPath)) {
      const qvaBoard = JSON.parse(fs.readFileSync(qvaBoardPath, 'utf-8'));
      qvaBoardMeta = {
        latestTradingDate: qvaBoard.meta?.latestTradingDate,
        generatedAt: qvaBoard.meta?.generatedAt,
      };
      // stages 안의 모든 종목 모으기 — QVA 추적 / 신규 / 재확인 / 돌파 등
      const stagesRaw = qvaBoard.stages || {};
      Object.entries(stagesRaw).forEach(([stageKey, stageData]) => {
        const items = stageData?.items || stageData?.candidates || stageData;
        if (Array.isArray(items)) {
          items.forEach(it => {
            if (!it.code) return;
            const ex = qvaLookup[it.code];
            if (ex) ex.stages.push(stageKey);
            else qvaLookup[it.code] = {
              name: it.name || '',
              stages: [stageKey],
              breakoutSuccess: !!it.breakoutSuccess,
              isHGroup: !!(it.isHGroup || it.qvaH || it.judgment === 'OK_H'),
            };
          });
        }
      });
      // qvaTracking topPreview / recentVviHistory 도 모아두기
      ['qvaTracking', 'recentVviHistory'].forEach(k => {
        const sec = qvaBoard[k];
        const items = sec?.items || sec?.topPreview || [];
        if (Array.isArray(items)) {
          items.forEach(it => {
            if (!it.code) return;
            const ex = qvaLookup[it.code];
            if (ex) { if (!ex.stages.includes(k)) ex.stages.push(k); }
            else qvaLookup[it.code] = { name: it.name || '', stages: [k] };
          });
        }
      });
      console.log(`[QVA lookup] ${Object.keys(qvaLookup).length}개 종목`);
    } else {
      console.log('[QVA lookup] qva-watchlist-board.json 없음 — QVA 보조 태그 비활성화');
    }
  } catch (e) {
    console.warn('[QVA lookup] 로드 실패:', e.message);
  }

  // JSON 저장
  const out = {
    meta: {
      generatedAt: generatedAt.toISOString(),
      generatedAtKST,
      todayCalendarDate,
      isMarketClosedToday,
      nextTradingDate,
      dataCoverageRatio,
      latestTradingDate: latestDate,
      totalCandidates: allCandidates.length,
      totalEpisodes: report.meta.totalEpisodes,
      analysisStart: report.meta.analysisStart,
      analysisEnd: report.meta.analysisEnd,
      qvaLookup,
      qvaBoardMeta,
    },
    sections: {
      bmsH,
      tripleQVA,
      explosiveLowOverhead,
      strongLate,
      strongFresh,
      interestPullback,
      top50,
      overheated,
    },
    sectionCounts: {
      bmsH: bmsH.length,
      tripleQVA: tripleQVA.length,
      explosiveLowOverhead: explosiveLowOverhead.length,
      strongLate: strongLate.length,
      strongFresh: strongFresh.length,
      interestPullback: interestPullback.length,
      top50: top50.length,
      overheated: overheated.length,
    },
    // BMS-H Forward Backtest 검증 결과 (Forward Performance Backtest 그룹 I)
    bmsHValidation: {
      sample: 177,
      avgRetD10: 8.19,
      hitRate10: 0.73,
      mfe10: 22.3,
      mae10: -10.5,
      analysisPeriod: '2025-04-01 ~ 2026-04-30',
      definition: 'BMS Score >= 80 AND 최근 40거래일 안 VVI 발화 AND 현재가 >= VVI 신호가 × 0.95',
    },
    tripleValidation: {
      sample: 15,
      avgRetD10: 4.78,
      hitRate10: 0.87,
      analysisPeriod: '2025-04-01 ~ 2026-04-30',
      definition: 'BMS-H AND (기본 QVA OR QVA-HL≥80 OR QVA-Ev≥70)',
      caveat: '표본 작음 — 참고용',
    },
    classification,
  };

  fs.writeFileSync(path.join(ROOT, 'bms-board.json'), JSON.stringify(out, null, 2));
  console.log(`\nJSON 저장: bms-board.json`);

  fs.writeFileSync(path.join(ROOT, 'bms-board.html'), generateHTML(out));
  console.log(`HTML 저장: bms-board.html`);
}

// ─────────────────────── HTML ───────────────────────

function generateHTML(data) {
  const TPL = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BMS 보드 · Big Move Similarity</title>
<style>
  * { box-sizing: border-box; }
  body { background:#0f172a; color:#e2e8f0; font-family:'Pretendard',-apple-system,BlinkMacSystemFont,sans-serif; margin:0; padding:20px; line-height:1.5; }
  .wrap { max-width:1500px; margin:0 auto; }
  h1 { font-size:24px; color:#f1f5f9; margin:0 0 8px 0; }
  h2 { font-size:18px; color:#f1f5f9; margin:24px 0 8px 0; padding-bottom:6px; border-bottom:1px solid #334155; display:flex; align-items:center; gap:10px; }
  h2 .count { color:#94a3b8; font-weight:400; font-size:14px; }
  h2 .badge-h { background:#0ea5e9; color:#fff; padding:2px 8px; border-radius:10px; font-size:12px; font-weight:600; }
  .subtitle { color:#94a3b8; font-size:13px; margin-bottom:14px; }
  .info-box { background:#1e293b; border-left:3px solid #38bdf8; padding:14px 18px; margin:14px 0; border-radius:6px; font-size:13px; color:#cbd5e1; }
  .info-box p { margin:6px 0; }
  .info-box strong { color:#f1f5f9; }
  .warn-box { background:#1e293b; border-left:3px solid #fbbf24; padding:12px 16px; margin:14px 0; border-radius:6px; color:#fcd34d; font-size:13px; }
  .date-box { background:linear-gradient(135deg,#1e293b,#0e1a2e); border:1px solid #334155; padding:12px 18px; margin:8px 0 14px 0; border-radius:8px; display:flex; gap:18px; flex-wrap:wrap; font-size:13px; align-items:center; }
  .date-box .item { display:flex; flex-direction:column; gap:2px; }
  .date-box .lbl { color:#64748b; font-size:11px; }
  .date-box .val { color:#f1f5f9; font-weight:600; font-size:14px; }
  .date-box .note { color:#94a3b8; font-size:11px; flex:1; min-width:200px; }
  .date-box .closed { color:#fbbf24; font-size:11px; }
  .nav { display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; font-size:13px; }
  .nav a { color:#38bdf8; text-decoration:none; padding:5px 10px; background:#1e293b; border-radius:4px; border:1px solid #334155; }
  .nav a:hover { background:#252e3f; }
  .summary-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:8px; margin:10px 0; }
  .stat { background:#1e293b; padding:10px 12px; border-radius:6px; border:1px solid #334155; }
  .stat-label { color:#94a3b8; font-size:11px; text-transform:uppercase; }
  .stat-value { color:#f1f5f9; font-size:20px; font-weight:700; margin-top:2px; }
  .stat-sub { color:#64748b; font-size:11px; }

  /* 카드 그리드 (모바일 기본) */
  .card-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:10px; margin:8px 0; }
  .row-list { display:none; }

  /* 데스크톱 (≥900px): 리스트 표시, 카드 숨김 */
  @media (min-width: 900px) {
    .card-grid { display:none; }
    .row-list { display:block; overflow-x:auto; margin:8px 0; }
  }

  /* 리스트 테이블 */
  .row-list table { width:100%; border-collapse:collapse; background:#1e293b; border-radius:6px; overflow:hidden; font-size:12px; }
  .row-list thead { background:#0f172a; position:sticky; top:0; z-index:1; }
  .row-list th { padding:8px 10px; text-align:left; color:#94a3b8; font-weight:600; border-bottom:1px solid #334155; white-space:nowrap; }
  .row-list td { padding:8px 10px; border-bottom:1px solid #1e293b; color:#cbd5e1; vertical-align:top; white-space:nowrap; }
  .row-list td .sub { color:#64748b; font-size:11px; margin-top:2px; }
  .row-list td.tags { white-space:normal; min-width:160px; max-width:280px; }
  .row-list td.tags .tag-wrap { display:flex; flex-wrap:wrap; gap:3px; }
  .row-list tbody tr:hover { background:#252e3f; }
  .row-list tbody tr.fresh { border-left:3px solid #10b981; }
  .row-list tbody tr.late { border-left:3px solid #fbbf24; }
  .row-list tbody tr.pullback { border-left:3px solid #38bdf8; }
  .row-list tbody tr.explosive { border-left:3px solid #ec4899; }
  .row-list tbody tr.overheated { border-left:3px solid #ef4444; }

  .card { background:#1e293b; border:1px solid #334155; border-radius:8px; padding:12px 14px; font-size:12px; }
  .card.bmsh { border-left:4px solid #10b981; box-shadow:0 0 0 1px rgba(16,185,129,0.15); }
  .card.triple { border-left:4px solid #a855f7; box-shadow:0 0 0 1px rgba(168,85,247,0.2); }
  .card.fresh { border-left:3px solid #34d399; }
  .card.late { border-left:3px solid #fbbf24; }
  .card.pullback { border-left:3px solid #38bdf8; }
  .card.explosive { border-left:3px solid #ec4899; }
  .card.overheated { border-left:3px solid #ef4444; }
  .row-list tbody tr.bmsh { border-left:4px solid #10b981; }
  .row-list tbody tr.triple { border-left:4px solid #a855f7; }
  .badge.bmsh { background:#10b981; color:#0f172a; }
  .badge.triple { background:#a855f7; color:#fff; }
  .card-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid #334155; }
  .card-name { font-size:15px; font-weight:700; color:#f1f5f9; }
  .card-meta { color:#64748b; font-size:11px; margin-top:2px; }
  .card-score { font-size:22px; font-weight:700; color:#f1f5f9; }
  .card-score .raw { font-size:11px; color:#94a3b8; font-weight:400; }
  .card-rank { font-size:11px; color:#94a3b8; }
  .card-grid2 { display:grid; grid-template-columns:repeat(2,1fr); gap:4px 12px; margin:8px 0; }
  .card-row { display:flex; justify-content:space-between; }
  .lbl { color:#64748b; font-size:11px; }
  .val { color:#e2e8f0; font-weight:500; font-size:12px; }
  .pos { color:#10b981; }
  .neg { color:#ef4444; }
  .muted { color:#64748b; }
  .market-K { color:#3b82f6; font-weight:600; }
  .market-Q { color:#f59e0b; font-weight:600; }
  .badges { display:flex; flex-wrap:wrap; gap:3px; margin-top:6px; }
  .badge { display:inline-block; padding:2px 7px; border-radius:8px; font-size:10px; font-weight:600; white-space:nowrap; }
  .badge.match { background:#0ea5e9; color:#fff; }
  .badge.warn { background:#ef4444; color:#fff; }
  .badge.cross { background:#7c3aed; color:#fff; }
  .badge.position { background:#10b981; color:#0f172a; }
  .badge.position.late { background:#fbbf24; }
  .badge.position.pullback { background:#38bdf8; color:#0f172a; }
  .badge.position.overheat { background:#ef4444; color:#fff; }
  .badge.position.alreadyup { background:#a855f7; color:#fff; }
  .badge.position.watch { background:#64748b; color:#fff; }
  .controls { display:flex; gap:10px; margin:8px 0 12px 0; flex-wrap:wrap; }
  .controls input, .controls select { background:#1e293b; color:#e2e8f0; border:1px solid #334155; padding:7px 10px; border-radius:6px; font-size:13px; }
  .controls input { flex:1; min-width:200px; }
  details { background:#1e293b; border:1px solid #334155; border-radius:6px; padding:8px 14px; margin:10px 0; }
  details summary { cursor:pointer; font-weight:600; color:#f1f5f9; padding:4px 0; }
  .empty { color:#64748b; font-size:13px; padding:20px; text-align:center; background:#1e293b; border-radius:6px; border:1px dashed #334155; }
  .footer { color:#64748b; font-size:11px; margin-top:30px; padding-top:14px; border-top:1px solid #334155; }
  .verify { background:#1e293b; padding:10px 14px; border-radius:6px; margin:6px 0; border-left:3px solid #fbbf24; font-size:12px; }
  .verify .vname { color:#f1f5f9; font-weight:600; }
</style>
</head>
<body>
<div class="wrap">
  <h1>BMS 보드 · Big Move Similarity</h1>
  <div class="subtitle" id="subtitle"></div>
  <div id="dateBox"></div>

  <div class="nav">
    <a href="#bmsH">🏆 BMS-H</a>
    <a href="#tripleQVA">💎 삼중 충족</a>
    <a href="#explosiveLowOverhead">💥 폭발+매물대낮음</a>
    <a href="#strongLate">🔥 추세 후반</a>
    <a href="#strongFresh">🌱 신선</a>
    <a href="#interestPullback">👀 눌림 대기</a>
    <a href="#top50">📊 TOP 50</a>
    <a href="#overheated">⚠️ 과열</a>
    <a href="/qva-watchlist" title="저점권 거래대금 돌파형 QVA 후보 추적 보드로 이동합니다." style="background:#064e3b;color:#6ee7b7;border:1px solid #10b981;font-weight:600;">🌱 QVA 보드 보기 →</a>
    <a href="/big-move-similarity-report">→ 분석 보고서</a>
    <a href="/bms-forward-performance">→ Forward 백테스트</a>
  </div>
  <div style="background:#1e293b;border-left:3px solid #a855f7;padding:10px 14px;margin:0 0 12px 0;border-radius:6px;font-size:12px;color:#cbd5e1;">
    <strong style="color:#a855f7;">BMS 보드</strong> = 과거 대상승 조건 유사도 분석 (이 화면) ·
    <strong style="color:#34d399;">QVA 보드</strong> = 저점권 수급 흔적 추적 (<a href="/qva-watchlist" style="color:#34d399;">→ 이동</a>)
    <br><span style="color:#94a3b8;">두 보드는 분리 운영됩니다. 종목 카드의 보라색 태그(QVA-HL, VVI 등)는 QVA 계열 교차 신호입니다. QVA 추적 흐름은 QVA 보드에서 확인하세요.</span>
  </div>

  <div class="info-box">
    <p><strong>이 보드는 최신 마감일(latestTradingDate) 기준으로 생성됩니다.</strong> "기준일"은 현재 장중 날짜가 아니라 분석에 사용된 마지막 거래일의 마감일입니다. 보드 안의 "기준일 5.11배"는 그 기준일의 거래대금이 20일 중앙값 대비 몇 배인지를 의미합니다.</p>
    <p>BMS는 과거 +40% 이상 상승 종목의 시작 조건과 현재 종목의 유사도를 보는 <strong>실험 모델</strong>입니다.</p>
    <p>1년 Forward Backtest에서 BMS 점수만 높은 후보보다, BMS 점수와 <strong>최근 VVI 거래대금 발화</strong>가 함께 있는 <strong>BMS-H 후보군</strong>의 성과가 가장 좋았습니다 (D+10 +8.19% / +10% 도달 73%).</p>
    <p>따라서 이 보드는 <strong>BMS-H를 최상단</strong>에 표시합니다.</p>
    <p style="margin-top:8px;color:#94a3b8;font-size:12px;">QVA-H와 BMS-H는 별개 모델입니다. QVA-H = QVA→VVI→돌파 성공. BMS-H = BMS≥80 → 최근 VVI → 신호가 이상 유지. 두 모델 보드는 <a href="/qva-watchlist" style="color:#38bdf8">분리 운영</a>됩니다.</p>
  </div>

  <div class="warn-box">⚠️ 모든 급등 종목 포착이 목적이 아닙니다. <strong>검증된 조건 조합</strong>에 들어온 종목을 사용자가 놓치지 않도록 보여주는 것이 목적입니다. 매수 추천이 아닙니다.</div>

  <div id="queryNotice" style="display:none;background:#1e293b;border-left:3px solid #38bdf8;padding:10px 14px;margin:10px 0;border-radius:6px;font-size:12px;color:#cbd5e1;"></div>

  <div class="summary-grid" id="summary"></div>

  <h2 id="bmsH">🏆 BMS-H 후보 <span class="count" id="cnt-bmsH"></span></h2>
  <div id="bmsHValidationBox"></div>
  <p class="subtitle">BMS Score ≥ 80 AND 최근 40거래일 안 VVI 발화 AND 현재가 ≥ VVI 신호가 × 0.95 — <strong>과거 +40% 상승 종목 구조 유사 + 최근 거래대금 발화 확인</strong></p>
  <div class="card-grid" data-section="bmsH"></div>
  <div class="row-list" data-section="bmsH"></div>

  <h2 id="tripleQVA">💎 BMS+QVA+VVI 삼중 충족 <span class="count" id="cnt-tripleQVA"></span></h2>
  <div id="tripleValidationBox"></div>
  <p class="subtitle">BMS-H AND (기본 QVA OR QVA-HL ≥ 80 OR QVA-Ev ≥ 70) — <strong>초정밀 후보, 표본 작음</strong>. 1년 검증 +10% 도달 87%지만 n=15라 참고용.</p>
  <div class="card-grid" data-section="tripleQVA"></div>
  <div class="row-list" data-section="tripleQVA"></div>

  <h2 id="explosiveLowOverhead">💥 BMS 거래대금 폭발 + 매물대 낮음 <span class="count" id="cnt-explosiveLowOverhead"></span></h2>
  <p class="subtitle">BMS ≥ 80 AND today×Med20 ≥ 4 AND 매물대10 ≤ 15% AND closeLoc ≥ 0.5 — Forward 백테스트 D+10 +3.40%, +10% 도달 68%</p>
  <div class="card-grid" data-section="explosiveLowOverhead"></div>
  <div class="row-list" data-section="explosiveLowOverhead"></div>

  <h2 id="strongLate">🔥 구조 유사도 높음 + 추세 후반 <span class="count" id="cnt-strongLate"></span></h2>
  <p class="subtitle">BMS ≥ 80 AND (ret40 > 30 OR L60+ > 50) — Forward 백테스트 D+10 +3.03%. 점수 높지만 이미 많이 오른 후보. <strong>추격 위험 확인 필요</strong></p>
  <div class="card-grid" data-section="strongLate"></div>
  <div class="row-list" data-section="strongLate"></div>

  <h2 id="strongFresh">🌱 구조 유사도 높음 + 신선 <span class="count" id="cnt-strongFresh"></span></h2>
  <p class="subtitle">BMS ≥ 80 AND ret20 ≤ 25 AND ret40 ≤ 30 AND L60+ ≤ 50 — 아직 크게 오르지 않은 후보. Forward D+10 +0.76% (단독으로는 약함)</p>
  <div class="card-grid" data-section="strongFresh"></div>
  <div class="row-list" data-section="strongFresh"></div>

  <h2 id="interestPullback">👀 BMS 관심 + 눌림 대기 <span class="count" id="cnt-interestPullback"></span></h2>
  <p class="subtitle">65 ≤ BMS &lt; 80 AND 60일 고점 -20% 이하 AND close ≥ MA20 × 0.95 — Forward D+10 +3.32% (단기 반등 가능성)</p>
  <div class="card-grid" data-section="interestPullback"></div>
  <div class="row-list" data-section="interestPullback"></div>

  <h2 id="top50">📊 BMS TOP 50 <span class="count" id="cnt-top50"></span></h2>
  <p class="subtitle">전체 후보 중 BMS Score 상위 50개. 위치 라벨과 함께 표시</p>
  <div class="info-box" style="border-color:#7c3aed;font-size:12px;">
    <p style="margin:0;"><strong>📖 거래대금 지표 설명</strong></p>
    <p style="margin:4px 0 0 0;line-height:1.7;color:#cbd5e1;">
      <strong>기준일 배율</strong>: 기준일 거래대금 / 최근 20일 중앙값 거래대금 ·
      <strong>3일평균 배율</strong>: 최근 3거래일 평균 거래대금 / 20일 중앙값 ·
      <strong>10일/시총</strong>: 최근 10거래일 누적 거래대금 / 시가총액 ·
      <strong>20일/시총</strong>: 최근 20거래일 누적 거래대금 / 시가총액
    </p>
  </div>
  <div class="controls">
    <input type="text" id="filter-top" placeholder="종목명 또는 코드 검색…">
    <select id="position-filter">
      <option value="all">전체 위치</option>
      <option value="신선">신선</option>
      <option value="추세 후반">추세 후반</option>
      <option value="눌림 대기">눌림 대기</option>
      <option value="이미 급등">이미 급등</option>
      <option value="과열">과열</option>
      <option value="관찰">관찰</option>
    </select>
  </div>
  <div class="card-grid" data-section="top50"></div>
  <div class="row-list" data-section="top50"></div>

  <details>
    <summary id="overheated-summary">⚠️ BMS 과열/제외 <span id="cnt-overheated"></span></summary>
    <p class="subtitle">이미 너무 많이 오른 종목 — 추격 위험 확인용 (기본 접힘)</p>
    <div class="card-grid" data-section="overheated"></div>
    <div class="row-list" data-section="overheated"></div>
  </details>

  <h2>✅ 필수 검증</h2>
  <div id="verify-list"></div>

  <div class="footer">
    생성: <span id="gen-time"></span> · BMS 보드는 <a href="/qva-watchlist" style="color:#38bdf8">QVA 보드</a>와 분리 운영됩니다 · 매수 추천이 아니라 실험적 분류입니다.
  </div>
</div>

<script>
const DATA = __JSON_DATA__;

function fmtDate(d) { return d && d.length === 8 ? d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8) : (d||'-'); }
function fmtNum(n) { return n != null ? Math.round(n).toLocaleString() : '-'; }
function fmtMc(v) {
  if (!v) return '-';
  if (v >= 1e12) return (v/1e12).toFixed(2)+'조';
  if (v >= 1e8) return (v/1e8).toFixed(0)+'억';
  return (v/1e4).toFixed(0)+'만';
}
function pctStr(n, sign) {
  if (n == null || !isFinite(n)) return '-';
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : 'muted');
  const s = (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
  return '<span class="'+cls+'">'+s+'</span>';
}
function marketCls(m) { return m === 'KOSDAQ' ? 'market-Q' : 'market-K'; }
function positionBadgeCls(p) {
  if (p === '추세 후반') return 'late';
  if (p === '눌림 대기') return 'pullback';
  if (p === '과열') return 'overheat';
  if (p === '이미 급등') return 'alreadyup';
  if (p === '관찰') return 'watch';
  return '';
}

const SHORT = {
  '시총대비 거래대금 유입': '거래대금 유입',
  '거래대금 증가율': '거래대금 증가',
  '외국인+기관 순매수': '외인·기관 매수',
  '박스권 형성/돌파': '박스권 형성',
  '이동평균선 정배열': 'MA 정배열',
  '매물대 부담 낮음': '매물대 적음',
  '60일 고점 근접 (매물대 위험)': '고점 근접',
  '20일 저점 +30% 이상 (추격)': '단기 추격주의',
  '매물대 부담 과다': '매물대 부담',
  '당일 +10% 이상 (단기 과열)': '당일 과열',
  '박스권 넓음 (변동성 과다)': '변동성 큼',
};
function shortLbl(s) { return SHORT[s] || s; }

// '강한 후보'는 BMS Score만으로 부여되므로, 백테스트 결과 BMS-H가 아닌 한 '구조 유사도 높음'으로 부른다.
function labelText(c) {
  if (c.label === '강한 후보') return c.isBmsH ? '강한 확인 후보' : '구조 유사도 높음';
  return c.label;
}

function statusBadges(c) {
  const out = [];
  if (c.isBmsH) out.push('<span class="badge bmsh" title="BMS-H: BMS≥80 + 최근 VVI + 신호가 유지">BMS-H</span>');
  if (c.isTriple) out.push('<span class="badge triple" title="삼중 충족: BMS-H + QVA 변형">삼중</span>');
  return out.join('');
}

function cardHtml(c, sectionClass) {
  const sn = c.snapshot || {};
  const e = c.extra || {};
  const matched = (c.matched||[]).map(m => '<span class="badge match" title="'+m+'">'+shortLbl(m)+'</span>').join('');
  const warns = (c.warnings||[]).map(w => '<span class="badge warn" title="'+w+'">'+shortLbl(w)+'</span>').join('');
  const tags = (c.crossTags||[]).map(t => '<span class="badge cross" title="교차 모델: '+t.name+'">'+t.name+(t.score?' '+t.score:'')+'</span>').join('');
  const posCls = positionBadgeCls(c.positionLabel);
  const posBadge = '<span class="badge position '+posCls+'">'+c.positionLabel+'</span>';
  const sm = sn.smartMoneyShareRecent != null ? (sn.smartMoneyShareRecent*100).toFixed(2)+'%' : '-';
  const status = statusBadges(c);
  const vviInfo = c.recentVVI ? ' · <span style="color:#7c3aed">VVI D+'+c.recentVVI.daysAgo+'</span>' : '';

  return '<div class="card '+(sectionClass||'')+'" data-name="'+c.name+'" data-code="'+c.code+'" data-position="'+c.positionLabel+'">' +
    '<div class="card-head">' +
      '<div>' +
        '<div class="card-name '+marketCls(c.market)+'">'+c.name+' '+status+'</div>' +
        '<div class="card-meta">'+c.market+' · '+c.code+' · '+fmtMc(c.marketCap)+' · 기준일 종가 '+fmtNum(c.today.close)+'원 ('+pctStr(c.today.todayReturn, true)+')'+vviInfo+'</div>' +
      '</div>' +
      '<div style="text-align:right">' +
        '<div class="card-score">'+c.normalizedScore.toFixed(1)+'<span class="raw"> /100</span></div>' +
        '<div class="card-rank">#'+c.rank+'/'+c.totalCount+' · '+posBadge+'</div>' +
        '<div class="card-rank" style="font-size:10px;color:#94a3b8">'+labelText(c)+'</div>' +
      '</div>' +
    '</div>' +

    '<div class="card-grid2">' +
      '<div class="card-row"><span class="lbl">ret 5/10/20/40d</span><span class="val">'+
        (e.recent5Return!=null?e.recent5Return.toFixed(1):'-')+'/' +
        (e.recent10Return!=null?e.recent10Return.toFixed(1):'-')+'/' +
        (e.recent20Return!=null?e.recent20Return.toFixed(1):'-')+'/' +
        (e.recent40Return!=null?e.recent40Return.toFixed(1):'-')+'%</span></div>' +
      '<div class="card-row"><span class="lbl">L60+ / H60-</span><span class="val">'+
        (sn.returnFromLow60!=null?'+'+sn.returnFromLow60.toFixed(1):'-')+'% / '+
        (sn.distanceFromHigh60!=null?sn.distanceFromHigh60.toFixed(1):'-')+'%</span></div>' +
      '<div class="card-row" title="기준일 거래대금 / 최근 20일 중앙값 · 최근 3거래일 평균 / 20일 중앙값"><span class="lbl">기준일 / 3일평균</span><span class="val">'+
        c.today.todayValueRatio.toFixed(2)+'배 / '+sn.recent3ValueRatio.toFixed(2)+'배</span></div>' +
      '<div class="card-row" title="최근 10/20거래일 누적 거래대금 / 시가총액"><span class="lbl">10일/시총 · 20일/시총</span><span class="val">'+
        (sn.value10dRatio*100).toFixed(1)+'% / '+(sn.value20dRatio*100).toFixed(1)+'%</span></div>' +
      '<div class="card-row"><span class="lbl">매물대 +10%</span><span class="val">'+
        (sn.overheadSupply10*100).toFixed(1)+'%</span></div>' +
      '<div class="card-row"><span class="lbl">수급비율</span><span class="val">'+sm+'</span></div>' +
      '<div class="card-row"><span class="lbl">vs MA20</span><span class="val">'+
        (sn.closeAboveMa20?'<span class="pos">위</span>':'<span class="neg">아래</span>')+' '+sn.closeMa20Gap.toFixed(1)+'%</span></div>' +
      '<div class="card-row"><span class="lbl">vs MA60</span><span class="val">'+
        (sn.closeAboveMa60?'<span class="pos">위</span>':'<span class="neg">아래</span>')+' '+sn.closeMa60Gap.toFixed(1)+'%</span></div>' +
    '</div>' +

    (matched ? '<div class="badges">'+matched+'</div>' : '') +
    (tags ? '<div class="badges">'+tags+'</div>' : '') +
    (warns ? '<div class="badges">'+warns+'</div>' : '') +
  '</div>';
}

const sectionClassMap = {
  bmsH: 'bmsh',
  tripleQVA: 'triple',
  explosiveLowOverhead: 'explosive',
  strongLate: 'late',
  strongFresh: 'fresh',
  interestPullback: 'pullback',
  top50: '',
  overheated: 'overheated',
};

function rowHtml(c, sectionClass) {
  const sn = c.snapshot || {};
  const e = c.extra || {};
  const matched = (c.matched||[]).map(m => '<span class="badge match" title="'+m+'">'+shortLbl(m)+'</span>').join('');
  const warns = (c.warnings||[]).map(w => '<span class="badge warn" title="'+w+'">'+shortLbl(w)+'</span>').join('');
  const tags = (c.crossTags||[]).map(t => '<span class="badge cross" title="교차 모델: '+t.name+'">'+t.name+(t.score?' '+t.score:'')+'</span>').join('');
  const posCls = positionBadgeCls(c.positionLabel);
  const sm = sn.smartMoneyShareRecent != null ? (sn.smartMoneyShareRecent*100).toFixed(2)+'%' : '-';
  const ret = (n) => n != null && isFinite(n) ? (n>=0?'+':'')+n.toFixed(1) : '-';

  const status = statusBadges(c);
  const vviInfo = c.recentVVI ? '<span style="color:#a855f7">VVI D+'+c.recentVVI.daysAgo+'</span>' : '';

  return '<tr class="'+(sectionClass||'')+(c.isBmsH?' bmsh':'')+(c.isTriple?' triple':'')+'" data-name="'+c.name+'" data-code="'+c.code+'" data-position="'+c.positionLabel+'">' +
    '<td>#'+c.rank+'</td>' +
    '<td><div class="'+marketCls(c.market)+'" style="font-weight:600">'+c.name+' '+status+'</div>' +
        '<div class="sub">'+c.market+' · '+c.code+(vviInfo?' · '+vviInfo:'')+'</div></td>' +
    '<td><div>'+fmtMc(c.marketCap)+'</div><div class="sub" title="기준일 종가">'+fmtNum(c.today.close)+'원 '+pctStr(c.today.todayReturn, true)+'</div></td>' +
    '<td><div><strong style="font-size:14px">'+c.normalizedScore.toFixed(1)+'</strong> <span class="badge position '+posCls+'">'+c.positionLabel+'</span></div>' +
        '<div class="sub">'+labelText(c)+'</div></td>' +
    '<td><div>'+ret(e.recent5Return)+'/'+ret(e.recent10Return)+'/'+ret(e.recent20Return)+'%</div>' +
        '<div class="sub">40d '+ret(e.recent40Return)+'%</div></td>' +
    '<td title="기준일 거래대금/20일 중앙값 · 최근 3거래일 평균/20일 중앙값"><div>기준일 '+c.today.todayValueRatio.toFixed(2)+'배 · 3일평균 '+sn.recent3ValueRatio.toFixed(2)+'배</div>' +
        '<div class="sub" title="최근 N거래일 누적 거래대금 / 시가총액">10일/시총 '+(sn.value10dRatio*100).toFixed(1)+'% · 20일/시총 '+(sn.value20dRatio*100).toFixed(1)+'%</div></td>' +
    '<td><div>L60 +'+sn.returnFromLow60.toFixed(1)+'% · H60 '+sn.distanceFromHigh60.toFixed(1)+'%</div>' +
        '<div class="sub">MA20 '+(sn.closeAboveMa20?'<span class="pos">위</span>':'<span class="neg">아래</span>')+' '+sn.closeMa20Gap.toFixed(1)+'%</div></td>' +
    '<td><div>매물 '+(sn.overheadSupply10*100).toFixed(1)+'%</div><div class="sub">수급 '+sm+'</div></td>' +
    '<td class="tags"><div class="tag-wrap">'+matched+(tags?' '+tags:'')+(warns?' '+warns:'')+'</div></td>' +
  '</tr>';
}

function tableHtml(arr, sectionClass) {
  return '<table>' +
    '<thead><tr>' +
      '<th>#</th>' +
      '<th>종목</th>' +
      '<th title="시가총액 / 기준일 종가">시총·종가</th>' +
      '<th>BMS·위치</th>' +
      '<th title="기준일까지의 5/10/20/40일 수익률">수익률</th>' +
      '<th title="기준일 배율 = 기준일 거래대금/20일 중앙값 · 3일평균 배율 = 최근 3거래일 평균/20일 중앙값 · 10·20일/시총 = 누적/시가총액">거래대금 지표</th>' +
      '<th title="60일 저점/고점 대비, MA20">가격위치</th>' +
      '<th title="매물대 +10% / 수급비율">매물·수급</th>' +
      '<th>신호·태그·경고</th>' +
    '</tr></thead>' +
    '<tbody>' + arr.map(c => rowHtml(c, sectionClass)).join('') + '</tbody>' +
  '</table>';
}

// 헤더
const m = DATA.meta;
document.getElementById('subtitle').textContent =
  '기준일 ' + fmtDate(m.latestTradingDate) + ' 마감 기준' +
  ' · 전체 후보 ' + m.totalCandidates +
  ' · baseline episode ' + m.totalEpisodes +
  ' (' + fmtDate(m.analysisStart) + '~' + fmtDate(m.analysisEnd) + ')';
document.getElementById('gen-time').textContent = m.generatedAtKST || m.generatedAt.slice(0,19).replace('T',' ');

// 기준일 박스
const dataCovPct = m.dataCoverageRatio != null ? (m.dataCoverageRatio*100).toFixed(0)+'%' : '-';
document.getElementById('dateBox').innerHTML =
  '<div class="date-box">' +
    '<div class="item">' +
      '<span class="lbl">📅 기준일 (latestTradingDate)</span>' +
      '<span class="val">' + fmtDate(m.latestTradingDate) + ' 마감</span>' +
    '</div>' +
    '<div class="item">' +
      '<span class="lbl">🕒 생성 (KST)</span>' +
      '<span class="val">' + (m.generatedAtKST || m.generatedAt.slice(0,16).replace('T',' ')) + '</span>' +
    '</div>' +
    '<div class="item">' +
      '<span class="lbl">➡ 다음 거래일 (예상)</span>' +
      '<span class="val">' + fmtDate(m.nextTradingDate || '') + '</span>' +
    '</div>' +
    '<div class="item">' +
      '<span class="lbl">📊 데이터 커버리지</span>' +
      '<span class="val">' + dataCovPct + '</span>' +
    '</div>' +
    '<div class="note">' +
      '이 보드는 ' + fmtDate(m.latestTradingDate) + ' 마감 데이터 기준으로 생성되었습니다. ' +
      (m.isMarketClosedToday ? '<span class="closed">⚠ 오늘은 휴장일(주말)이라 마지막 거래일 마감 데이터를 표시합니다.</span>' : '') +
    '</div>' +
  '</div>';

// summary (요약 카드)
const cls = DATA.classification || {};
const sc = DATA.sectionCounts || {};
document.getElementById('summary').innerHTML = [
  ['전체 후보', m.totalCandidates],
  ['🏆 BMS-H', sc.bmsH || 0],
  ['💎 삼중 충족', sc.tripleQVA || 0],
  ['💥 폭발+매물대낮음', sc.explosiveLowOverhead || 0],
  ['🔥 추세 후반', sc.strongLate || 0],
  ['🌱 신선', sc.strongFresh || 0],
  ['👀 눌림 대기', sc.interestPullback || 0],
  ['⚠️ 과열', sc.overheated || 0],
].map(([l, v]) => '<div class="stat"><div class="stat-label">'+l+'</div><div class="stat-value">'+v+'</div></div>').join('');

// BMS-H 검증 요약 박스
const v = DATA.bmsHValidation;
if (v) {
  document.getElementById('bmsHValidationBox').innerHTML =
    '<div style="background:linear-gradient(135deg,#1e293b,#0e1a2e);border-left:4px solid #10b981;padding:12px 16px;margin:10px 0;border-radius:8px;font-size:13px;">' +
    '<div style="color:#10b981;font-weight:600;margin-bottom:4px">📈 1년 Forward Backtest 검증 결과 (' + v.analysisPeriod + ')</div>' +
    '<div style="display:flex;gap:14px;flex-wrap:wrap;margin:6px 0">' +
      '<div style="background:#0f172a;padding:4px 10px;border-radius:5px;border:1px solid #334155">표본 <strong>'+v.sample+'</strong></div>' +
      '<div style="background:#0f172a;padding:4px 10px;border-radius:5px;border:1px solid #334155">D+10 평균 <strong style="color:#10b981">+'+v.avgRetD10+'%</strong></div>' +
      '<div style="background:#0f172a;padding:4px 10px;border-radius:5px;border:1px solid #334155">+10% 도달률 <strong>'+(v.hitRate10*100).toFixed(0)+'%</strong></div>' +
      '<div style="background:#0f172a;padding:4px 10px;border-radius:5px;border:1px solid #334155">MFE10 <strong style="color:#10b981">+'+v.mfe10+'%</strong></div>' +
      '<div style="background:#0f172a;padding:4px 10px;border-radius:5px;border:1px solid #334155">MAE10 <strong style="color:#ef4444">'+v.mae10+'%</strong></div>' +
    '</div>' +
    '<div style="color:#94a3b8;font-size:11px;margin-top:4px">과거 검증 수치이며 미래 수익을 보장하지 않습니다.</div>' +
    '</div>';
}

const tv = DATA.tripleValidation;
if (tv) {
  document.getElementById('tripleValidationBox').innerHTML =
    '<div style="background:#1e293b;border-left:4px solid #fbbf24;padding:10px 14px;margin:10px 0;border-radius:6px;font-size:12px;">' +
    '<div style="color:#fbbf24;font-weight:600;margin-bottom:4px">⚠ 표본 작음 — 참고용</div>' +
    '<div>1년 검증 표본 <strong>'+tv.sample+'개</strong> · D+10 +<strong>'+tv.avgRetD10+'%</strong> · +10% 도달 <strong>'+(tv.hitRate10*100).toFixed(0)+'%</strong></div>' +
    '<div style="color:#94a3b8;font-size:11px;margin-top:3px">'+tv.caveat+'</div>' +
    '</div>';
}

// 섹션 카운트
['bmsH','tripleQVA','explosiveLowOverhead','strongLate','strongFresh','interestPullback','top50','overheated'].forEach(k => {
  const el = document.getElementById('cnt-'+k);
  if (el) el.textContent = '(' + (DATA.sections[k] || []).length + ')';
});

// 카드 + 테이블 둘 다 렌더 (CSS로 화면 크기에 따라 토글)
Object.keys(DATA.sections).forEach(k => {
  const arr = DATA.sections[k] || [];
  const cardWrap = document.querySelector('.card-grid[data-section="'+k+'"]');
  const listWrap = document.querySelector('.row-list[data-section="'+k+'"]');
  if (arr.length === 0) {
    if (cardWrap) cardWrap.outerHTML = '<div class="empty">조건을 만족하는 후보 없음</div>';
    if (listWrap) listWrap.outerHTML = '';
    return;
  }
  const cls = sectionClassMap[k] || '';
  if (cardWrap) cardWrap.innerHTML = arr.map(c => cardHtml(c, cls)).join('');
  if (listWrap) listWrap.innerHTML = tableHtml(arr, cls);
});

// TOP 50 필터 (카드 + 테이블 동시 적용)
const filterTop = document.getElementById('filter-top');
const posFilter = document.getElementById('position-filter');
function applyTopFilter() {
  const q = filterTop.value.trim().toLowerCase();
  const pf = posFilter.value;
  const sel = '[data-section="top50"] .card, [data-section="top50"] tbody tr';
  document.querySelectorAll(sel).forEach(el => {
    const name = (el.dataset.name||'').toLowerCase();
    const code = (el.dataset.code||'').toLowerCase();
    const pos = el.dataset.position || '';
    const matchQ = !q || name.includes(q) || code.includes(q);
    const matchP = pf === 'all' || pos === pf;
    el.style.display = matchQ && matchP ? '' : 'none';
  });
}
filterTop.addEventListener('input', applyTopFilter);
posFilter.addEventListener('change', applyTopFilter);

// 필수 검증 (와이엠티 / 한온시스템)
const checks = [
  { code: '251370', name: '와이엠티', expect: '강한 + 추세 후반' },
  { code: '018880', name: '한온시스템', expect: '관심 + 눌림 대기' },
];
const verify = document.getElementById('verify-list');
const findInSection = (code) => {
  const found = [];
  Object.keys(DATA.sections).forEach(k => {
    if ((DATA.sections[k]||[]).some(c => c.code === code)) {
      const labels = {
        strongFresh: '1. 강한+신선',
        strongLate: '2. 강한+추세 후반',
        interestPullback: '3. 관심+눌림 대기',
        explosiveValue: '4. 폭발적 거래대금',
        top50: '5. TOP 50',
        overheated: '6. 과열',
      };
      found.push(labels[k] || k);
    }
  });
  return found;
};

verify.innerHTML = checks.map(ch => {
  const found = findInSection(ch.code);
  const c = (DATA.sections.top50 || []).find(x => x.code === ch.code) ||
            Object.values(DATA.sections).flat().find(x => x.code === ch.code);
  const sectionTxt = found.length ? found.join(' · ') : '<span class="neg">어떤 섹션에도 없음</span>';
  const note = ch.code === '251370'
    ? '과거 대상승 종목의 조건과 매우 유사하지만, 최근 40거래일 기준 이미 많이 오른 상태입니다. 추격 위험을 함께 확인해야 합니다.'
    : '60일 고점 -25% 조정 후 박스 형성 + MA20 위 지지. 강한 후보가 아니라 눌림 대기 후보로 분류됩니다.';
  return '<div class="verify">' +
    '<div class="vname">'+ch.name+' ('+ch.code+') — 예상 분류: '+ch.expect+'</div>' +
    (c ? '<div style="margin-top:4px">BMS '+c.normalizedScore.toFixed(1)+' · '+c.positionLabel+' · #'+c.rank+'/'+c.totalCount+'</div>' : '') +
    '<div class="muted" style="margin-top:4px">실제 노출 섹션: '+sectionTxt+'</div>' +
    '<div class="muted" style="margin-top:4px;font-size:11px">'+note+'</div>' +
  '</div>';
}).join('');

// ─────────── URL query 파라미터 검색 + 안내 ───────────
(function handleQuery(){
  const params = new URLSearchParams(location.search);
  const q = (params.get('query') || params.get('q') || '').trim();
  if (!q) return;

  // 검색창에 자동 입력
  const filterInput = document.getElementById('filter-top');
  if (filterInput) {
    filterInput.value = q;
    filterInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // BMS 보드에서 종목 찾기
  const allCands = [];
  Object.keys(DATA.sections || {}).forEach(k => {
    (DATA.sections[k] || []).forEach(c => allCands.push({ section: k, ...c }));
  });
  const lowerQ = q.toLowerCase();
  const found = allCands.filter(c =>
    c.code === q || (c.name && c.name === q) ||
    (c.code && c.code.toLowerCase().includes(lowerQ)) ||
    (c.name && c.name.toLowerCase().includes(lowerQ))
  );
  // 같은 종목이 여러 섹션에 있을 수 있음
  const uniqueCodes = [...new Set(found.map(c => c.code))];
  // QVA 보드에 있는지 확인
  const qvaLookup = (DATA.meta && DATA.meta.qvaLookup) || {};
  const qvaInfo = qvaLookup[q] || (uniqueCodes.length === 1 ? qvaLookup[uniqueCodes[0]] : null);

  const notice = document.getElementById('queryNotice');
  if (!notice) return;
  notice.style.display = '';

  if (uniqueCodes.length > 0) {
    const sectionLabels = {
      bmsH: '🏆 BMS-H', tripleQVA: '💎 삼중 충족', explosiveLowOverhead: '💥 폭발+매물대낮음',
      strongLate: '🔥 추세 후반', strongFresh: '🌱 신선', interestPullback: '👀 눌림 대기',
      top50: '📊 TOP 50', overheated: '⚠️ 과열',
    };
    const sections = [...new Set(found.map(c => sectionLabels[c.section] || c.section))];
    const c0 = found[0];
    notice.innerHTML = '<strong>"' + q + '" 검색 결과</strong>: BMS 보드 ' + sections.length + '개 섹션에 노출 — ' + sections.join(' / ') +
      ' · BMS ' + c0.normalizedScore.toFixed(1) + ' · 위치 ' + c0.positionLabel +
      (qvaInfo ? ' · <span style="color:#34d399;">QVA 보드 상태: ' + qvaInfo.stages.join(', ') + '</span> <a href="/qva-watchlist?query=' + encodeURIComponent(q) + '" style="color:#34d399;">→ QVA 보드에서 보기</a>' : ' · QVA 보드에는 없음');
  } else {
    if (qvaInfo) {
      notice.innerHTML = '<span style="color:#fbbf24;">⚠ "' + q + '"는 현재 BMS 후보에 없습니다.</span> ' +
        'QVA 보드에는 <strong>' + (qvaInfo.stages || []).join(', ') + '</strong> 단계로 추적 중입니다. ' +
        '<a href="/qva-watchlist?query=' + encodeURIComponent(q) + '" style="color:#34d399;">→ QVA 보드에서 보기</a>';
    } else {
      notice.innerHTML = '<span style="color:#fbbf24;">⚠ "' + q + '"는 현재 BMS 후보에도, QVA 보드에도 없습니다.</span> ' +
        '입력값을 확인하거나 종목코드(예: 251370)로 다시 검색해 주세요.';
    }
  }
})();

// ─────────── QVA 보조 태그 자동 삽입 ───────────
// BMS 보드 카드에는 이미 crossTags(QVA-HL, QVA-Ev, VVI)가 있지만,
// QVA 보드의 운영 stage(QVA 추적 중, 돌파 성공 등)도 함께 표시한다.
(function injectQvaStageTags(){
  const lookup = (DATA.meta && DATA.meta.qvaLookup) || {};
  if (!Object.keys(lookup).length) return;
  const cards = document.querySelectorAll('.card[data-code]');
  cards.forEach(card => {
    const code = card.dataset.code;
    const info = lookup[code];
    if (!info || !info.stages || info.stages.length === 0) return;
    if (card.querySelector('.qva-stage-badge')) return;
    const stageMap = {
      QVA_NEW_TODAY: '🟢 오늘 QVA',
      QVA_REVIEW_OK_TODAY: '🟢 오늘 재확인',
      QVA_TRACKING: '👀 QVA 추적',
      LONG_QVA_REACTIVE: '🔁 장기 QVA 재점화',
      LONG_QVA_INTEREST: '🔁 장기 QVA 관심',
      LONG_QVA_ALL: '🔁 장기 QVA',
      VVI: '⏳ VVI',
      BREAKOUT_SUCCESS: '🔥 돌파 성공',
      BREAKOUT_FAILED: '❌ 돌파 실패',
      qvaTracking: '👀 QVA 추적',
      recentVviHistory: '⏳ 최근 VVI',
    };
    const tags = info.stages.slice(0, 3).map(s => {
      const label = stageMap[s] || s;
      return '<a href="/qva-watchlist?query=' + encodeURIComponent(code) + '" class="qva-stage-badge" title="QVA 보드 stage: ' + s + '. 클릭 시 QVA 보드에서 검색." style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:600;background:#064e3b;color:#6ee7b7;border:1px solid #10b981;text-decoration:none;margin-left:3px;">' + label + '</a>';
    }).join('');
    const headEl = card.querySelector('.card-name') || card.querySelector('.card-head > div:first-child');
    if (headEl) headEl.insertAdjacentHTML('beforeend', ' ' + tags);
  });
})();
</script>
</body>
</html>`;
  return TPL.replace('__JSON_DATA__', JSON.stringify(data));
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('오류:', e); process.exit(1); }
}

module.exports = { main, generateHTML, classifyPosition, computeCrossSignals };
