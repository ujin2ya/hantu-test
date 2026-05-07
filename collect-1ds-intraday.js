#!/usr/bin/env node
/**
 * 1DS 후보 종목 다음날 장초 분봉 수집 (PoC)
 *
 * 입력:
 *   - reports/one-day-surge-board-result.json (one-day-surge-board.js v5 결과)
 *
 * 출력:
 *   - data/intraday/1ds/YYYY-MM-DD/{code}.json
 *
 * 사용:
 *   node collect-1ds-intraday.js                       # 기본 (top 30, BALANCED+LIGHT+MID-CAP, 09:00~09:30)
 *   node collect-1ds-intraday.js --top 50              # 상위 50개
 *   node collect-1ds-intraday.js --end-hour 100000     # 09:00~10:00 (2 콜/종목)
 *   node collect-1ds-intraday.js --groups BALANCED-GT,LIGHT-GT  # 그룹 한정
 *   node collect-1ds-intraday.js --include-mom         # MOM-RISK도 함께 (상한가형 검증용)
 *   node collect-1ds-intraday.js --dry-run             # API 호출 없이 후보만 출력
 *   node collect-1ds-intraday.js --date 2026-05-08     # 출력 디렉토리 날짜 지정 (기본: 오늘)
 *
 * 주의 (PoC 한계):
 *   - KIS FHKST03010200은 "오늘" 분봉만 반환 — 09:35+ 또는 10:05+에 실행해야 의미 있음
 *   - 이 스크립트는 자동 cron에 등록하지 않음 — 사용자가 다음 거래일 장초에 수동 실행
 *   - 이미 저장된 파일은 skip (멱등성)
 *   - 종목별 250ms sleep으로 KIS rate limit 방어
 *   - 실패 종목은 logs에 남기고 전체 작업 계속
 *
 * 다음 단계 (이 스크립트가 데이터 모은 후):
 *   - 별도 분석 스크립트로 ENTRY_CONFIRM 지표 계산 (gapRate, lowFromOpen_0_10, value_0_10 등)
 *   - 검증 보고서에 ENTRY_CONFIRM 효과 측정 (GOOD↑ / TRAP↓ / openFail↓ 검증)
 */

const fs = require('fs');
const path = require('path');

// dotenv 로드 (KIS 자격증명)
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { getAccessToken } = require('./src/services/kis/kisToken');
const { getMorningMinuteBars, normalizeBars } = require('./src/services/kis/kisMinuteBars');

const ROOT = __dirname;
const BOARD_RESULT_PATH = path.join(ROOT, 'reports', 'one-day-surge-board-result.json');
const OUTPUT_BASE = path.join(ROOT, 'data', 'intraday', '1ds');

// ── CLI 파싱 ──
function parseArgs(argv) {
  const args = {
    top: 30,
    groups: ['BALANCED-GT', 'LIGHT-GT', 'MID-CAP-GT'],
    includeMom: false,
    endHour: '093000',
    interval: '1m',
    dryRun: false,
    date: null,        // null이면 오늘
    sleepMs: 250,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') args.top = parseInt(argv[++i], 10) || 30;
    else if (a === '--groups') args.groups = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--include-mom') args.includeMom = true;
    else if (a === '--end-hour') args.endHour = argv[++i];
    else if (a === '--interval') args.interval = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--sleep') args.sleepMs = parseInt(argv[++i], 10) || 250;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node collect-1ds-intraday.js [--top 30] [--groups BALANCED-GT,LIGHT-GT,MID-CAP-GT]');
      console.log('                                    [--include-mom] [--end-hour 093000|100000]');
      console.log('                                    [--interval 1m] [--dry-run] [--date YYYY-MM-DD]');
      process.exit(0);
    }
  }
  if (args.includeMom && !args.groups.includes('MOM-RISK')) args.groups.push('MOM-RISK');
  return args;
}

// ── 후보 추출 ──
function loadCandidates(args) {
  if (!fs.existsSync(BOARD_RESULT_PATH)) {
    console.error(`[ERROR] 보드 결과 없음: ${BOARD_RESULT_PATH}\n  먼저 'node one-day-surge-board.js'를 실행하세요.`);
    process.exit(1);
  }
  const board = JSON.parse(fs.readFileSync(BOARD_RESULT_PATH, 'utf-8'));
  const all = [];
  for (const g of args.groups) {
    const list = (board.groups && board.groups[g]) || [];
    for (const it of list) {
      all.push({ ...it, _gtGroup: g });
    }
  }
  // 중복 제거 (한 종목이 여러 그룹에 들어가는 일은 없지만 방어)
  const seen = new Set();
  const dedup = [];
  for (const it of all) {
    if (seen.has(it.code)) continue;
    seen.add(it.code);
    dedup.push(it);
  }
  // 정렬: GT 그룹 우선 + valueToMcRatio 내림차순 + dailyValueRank 오름차순
  const groupRank = { 'BALANCED-GT': 1, 'LIGHT-GT': 2, 'MID-CAP-GT': 3, 'MOM-RISK': 4 };
  dedup.sort((a, b) => {
    const ga = groupRank[a._gtGroup] || 9;
    const gb = groupRank[b._gtGroup] || 9;
    if (ga !== gb) return ga - gb;
    const va = a.valueToMarketCapRatio || 0;
    const vb = b.valueToMarketCapRatio || 0;
    if (vb !== va) return vb - va;
    const ra = a.dailyValueRank || 9999;
    const rb = b.dailyValueRank || 9999;
    return ra - rb;
  });
  return { board, candidates: dedup.slice(0, args.top) };
}

function todayDateStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function dateStrToDir(s) {
  // accept YYYY-MM-DD or YYYYMMDD
  if (!s) return todayDateStr();
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return s;
}

async function main() {
  const args = parseArgs(process.argv);
  const dateDir = dateStrToDir(args.date);

  console.log(`\n📡 1DS 후보 장초 분봉 수집 (PoC)`);
  console.log(`  날짜: ${dateDir} / 그룹: ${args.groups.join(',')} / 상위 ${args.top}개 / 종료시각 ${args.endHour} / interval ${args.interval}`);
  if (args.dryRun) console.log(`  ⚠ DRY RUN — 후보 출력만, API 호출 없음`);

  const { board, candidates } = loadCandidates(args);
  console.log(`  보드 분석 기준일: ${board.meta?.analysisDateFmt || '-'} / 후보 풀: ${board.meta?.candidateTotal || '?'} / 추출 ${candidates.length}건`);

  if (candidates.length === 0) {
    console.error(`  [WARN] 추출된 후보 0건 — 그룹 이름 확인 또는 보드 결과를 확인하세요.`);
    process.exit(0);
  }

  // 후보 미리 출력
  console.log('\n  ── 추출 후보 ──');
  for (let i = 0; i < candidates.length; i++) {
    const it = candidates[i];
    const vmc = it.valueToMarketCapRatio != null ? it.valueToMarketCapRatio.toFixed(1) + '%' : '-';
    console.log(`  ${String(i + 1).padStart(3)}. [${it._gtGroup.padEnd(12)}] ${it.code} ${(it.name || '').padEnd(14)} mc=${(it.marketCap / 1e8).toFixed(0).padStart(5)}억 v/mc=${vmc.padStart(7)} chg=${(it.changeRate || 0).toFixed(1).padStart(6)}% rank=#${it.dailyValueRank || '-'}`);
  }

  if (args.dryRun) {
    console.log('\n  DRY RUN 완료. --dry-run 빼고 실행하면 실제 KIS 분봉을 수집합니다.');
    return;
  }

  const outDir = path.join(OUTPUT_BASE, dateDir);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n  ── 분봉 수집 시작 (출력: ${outDir}) ──`);

  // KIS 토큰
  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.error(`  [ERROR] KIS 토큰 발급 실패: ${e.message}`);
    console.error(`  .env에 KIS_APP_KEY / KIS_APP_SECRET / KIS_BASE_URL 가 있는지 확인하세요.`);
    process.exit(1);
  }
  console.log(`  KIS 토큰 OK (캐시 또는 신규)`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const summary = { total: candidates.length, fetched: 0, skipped: 0, failed: 0, failures: [] };

  for (let i = 0; i < candidates.length; i++) {
    const it = candidates[i];
    const outFile = path.join(outDir, `${it.code}.json`);
    if (fs.existsSync(outFile)) {
      summary.skipped++;
      console.log(`  [${String(i + 1).padStart(3)}/${candidates.length}] ${it.code} ${it.name} → skip (이미 존재)`);
      continue;
    }

    try {
      const { meta, raw } = await getMorningMinuteBars(token, it.code, args.endHour, args.sleepMs);
      const bars = normalizeBars(raw);
      const out = {
        code: it.code,
        name: it.name,
        market: it.market,
        date: dateDir,
        interval: args.interval,
        source: 'kis',
        tr: 'FHKST03010200',
        fetchedAt: new Date().toISOString(),
        windowFrom: '09:00',
        windowTo: args.endHour.slice(0, 2) + ':' + args.endHour.slice(2, 4),
        boardSnapshot: {
          gtGroup: it._gtGroup,
          marketCap: it.marketCap,
          valueToMarketCapRatio: it.valueToMarketCapRatio,
          dailyValueRank: it.dailyValueRank,
          candleType: it.candleType,
          dayChangeRate: it.changeRate,
          recent5Up15Count: it.recent5Up15Count,
        },
        kisMeta: meta,
        bars,
      };
      fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
      summary.fetched++;
      console.log(`  [${String(i + 1).padStart(3)}/${candidates.length}] ${it.code} ${it.name} → ${bars.length}개 분봉 저장`);
    } catch (e) {
      summary.failed++;
      summary.failures.push({ code: it.code, name: it.name, error: e.message });
      console.log(`  [${String(i + 1).padStart(3)}/${candidates.length}] ${it.code} ${it.name} → ❌ ${e.message}`);
    }
    if (i < candidates.length - 1) await sleep(args.sleepMs);
  }

  console.log(`\n✅ 수집 완료: 성공 ${summary.fetched} / skip ${summary.skipped} / 실패 ${summary.failed}`);
  if (summary.failures.length) {
    console.log(`  실패 상세:`);
    for (const f of summary.failures) console.log(`    ${f.code} ${f.name}: ${f.error}`);
  }

  // 수집 메니페스트 (디렉토리당 1개) — 분석 스크립트가 빨리 후보를 찾도록
  const manifestPath = path.join(outDir, '_manifest.json');
  const manifest = {
    date: dateDir,
    fetchedAt: new Date().toISOString(),
    interval: args.interval,
    windowFrom: '09:00',
    windowTo: args.endHour.slice(0, 2) + ':' + args.endHour.slice(2, 4),
    groups: args.groups,
    topN: args.top,
    candidates: candidates.map(it => ({
      code: it.code, name: it.name, gtGroup: it._gtGroup,
      marketCap: it.marketCap, valueToMarketCapRatio: it.valueToMarketCapRatio,
      dailyValueRank: it.dailyValueRank, candleType: it.candleType,
    })),
    summary,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n📝 수집 메니페스트: ${manifestPath}`);
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
