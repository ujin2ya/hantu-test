#!/usr/bin/env node
/**
 * Daily analysis orchestrator
 *
 * 순서:
 * 1. pykrx로 최근 5거래일 차트 데이터 갱신
 * 2. Naver에서 최근 5거래일 수급 데이터 갱신
 * 3. analyzeAll() 실행
 * 4. pattern-result.json 저장
 * 5. 데이터 상태 검증 및 리포트
 *
 * 실행:
 *   node run-daily-analysis.js
 *   ANALYSIS_DATE=20260430 node run-daily-analysis.js  # 테스트
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Config ───
const ROOT = __dirname;
const PATTERN_RESULT_CACHE = path.join(ROOT, 'cache', 'pattern-result.json');
const UPDATE_CHART_SCRIPT = path.join(ROOT, 'update-daily-pykrx.py');
const UPDATE_FLOW_SCRIPT = path.join(ROOT, 'update-flow-daily.js');
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

// ─── Helpers ───
function formatTime() {
  return new Date().toISOString().split('T').join(' ').split('.')[0];
}

function log(msg, level = 'INFO') {
  const ts = formatTime();
  console.log(`[${ts}] [${level}] ${msg}`);
}

function runCommand(cmd, description) {
  /**
   * 외부 명령 실행
   * 실패하면 에러로그 후 false 반환
   */
  try {
    log(`시작: ${description}`);
    // timeout: 1800초 (30분) — pykrx/Naver 조회용 (Naver: 700ms × 4260 = ~50분)
    execSync(cmd, {
      stdio: 'pipe',
      cwd: ROOT,
      timeout: 1800000,
      encoding: 'utf-8'
    });
    log(`완료: ${description}`);
    return true;
  } catch (e) {
    log(`실패: ${description}`, 'ERROR');
    if (e.code === 'ETIMEDOUT') {
      log(`원인: 명령 실행 시간 초과 (30분)`, 'ERROR');
    } else {
      log(`상세: ${e.message}`, 'ERROR');
    }
    return false;
  }
}

async function runAnalysis() {
  /**
   * analyzeAll() 실행
   * 패턴-result.json 생성
   */
  try {
    log('시작: 패턴 분석 (analyzeAll)');

    const { analyzeAll } = require('./pattern-screener');
    const result = await analyzeAll();

    // 파일 저장
    fs.writeFileSync(
      PATTERN_RESULT_CACHE,
      JSON.stringify(result, null, 0),
      'utf-8',
    );
    log('완료: pattern-result.json 저장');

    return result;
  } catch (e) {
    log(`실패: 패턴 분석 - ${e.message}`, 'ERROR');
    return null;
  }
}

function printDataStatus(result) {
  /**
   * 데이터 상태 리포트
   */
  if (!result) {
    log('데이터 상태: 분석 실패로 확인 불가', 'WARN');
    return;
  }

  const {
    expectedMarketDate,
    availableModeDate,
    totalStocks,
    expectedDateCount,
    availableModeDateCount,
    coverageRatio,
    dataStatus,
    dataWarning,
  } = result;

  console.log('\n' + '='.repeat(70));
  console.log('📊 데이터 상태 리포트');
  console.log('='.repeat(70));

  console.log(`분석 기준일:          ${expectedMarketDate}`);
  console.log(`사용 가능 데이터 최신일: ${availableModeDate}`);
  console.log(`  └─ ${availableModeDateCount}개 종목 (${totalStocks} 중)`);
  console.log(`\n기준일 데이터 커버리지: ${coverageRatio}% (${expectedDateCount}/${totalStocks})`);

  if (dataStatus === 'OK') {
    console.log(`\n✅ 상태: 정상`);
  } else if (dataStatus === 'STALE') {
    console.log(`\n⚠️  상태: ${dataWarning || '데이터 부족'}`);
  } else {
    console.log(`\n❌ 상태: ${dataStatus}`);
  }

  console.log('='.repeat(70) + '\n');
}

function printSummary(chartOk, flowOk, analysisResult, timings) {
  /**
   * 최종 요약 (소요 시간 포함)
   */
  console.log('\n' + '='.repeat(70));
  console.log('📋 Daily Update 완료 요약');
  console.log('='.repeat(70));

  console.log(`차트 데이터 갱신:   ${chartOk ? '✅' : '❌'} (${timings?.chartTime || '?'}s)`);
  console.log(`수급 데이터 갱신:   ${flowOk ? '✅' : '❌'} (${timings?.flowTime || '?'}s)`);
  console.log(`패턴 분석 재실행:   ${analysisResult ? '✅' : '❌'} (${timings?.analysisTime || '?'}s)`);

  if (analysisResult) {
    console.log(
      `\n생성된 후보:
  - vviTodayCandidates: ${analysisResult.vviTodayCandidates?.length || 0}개
  - vviRecentSignals: ${analysisResult.vviRecentSignals?.length || 0}개
  - csbMainCandidates: ${analysisResult.csbMainCandidates?.length || 0}개
  - reboundCandidates: ${analysisResult.reboundCandidates?.length || 0}개`,
    );
  }

  if (timings?.totalTime) {
    console.log(`\n총 소요 시간: ${timings.totalTime}s (${Math.ceil(timings.totalTime / 60)}분)`);
  }

  console.log(`\n다음 실행: 내일 16:20`);
  console.log('='.repeat(70) + '\n');
}

async function main() {
  /**
   * 메인 플로우 (시간 측정 포함)
   */
  const startTime = Date.now();
  const timings = {};

  log('━'.repeat(70));
  log('Daily Update & Analysis 시작');
  log('━'.repeat(70));

  // 1. 차트 데이터 갱신
  let t1 = Date.now();
  const chartOk = runCommand(
    `${PYTHON_CMD} "${UPDATE_CHART_SCRIPT}"`,
    '차트 데이터 갱신 (pykrx)',
  );
  timings.chartTime = Math.ceil((Date.now() - t1) / 1000);

  console.log('');

  // 2. 수급 데이터 갱신
  let t2 = Date.now();
  const flowOk = runCommand(
    `node "${UPDATE_FLOW_SCRIPT}"`,
    '수급 데이터 갱신 (Naver)',
  );
  timings.flowTime = Math.ceil((Date.now() - t2) / 1000);

  console.log('');

  // 3. 패턴 분석
  let t3 = Date.now();
  const analysisResult = await runAnalysis();
  timings.analysisTime = Math.ceil((Date.now() - t3) / 1000);

  // 4. 데이터 상태 리포트
  printDataStatus(analysisResult);

  // 5. 최종 요약
  timings.totalTime = Math.ceil((Date.now() - startTime) / 1000);
  printSummary(chartOk, flowOk, analysisResult, timings);

  // 6. 종료 코드
  const allOk = chartOk && flowOk && analysisResult;
  process.exit(allOk ? 0 : 1);
}

// ─── Entry Point ───
main().catch((e) => {
  log(`치명적 오류: ${e.message}`, 'FATAL');
  process.exit(1);
});
