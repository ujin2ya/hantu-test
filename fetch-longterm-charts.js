#!/usr/bin/env node
// 장기 차트 데이터 수집 — 2023-01-01 ~ 현재
// 용도: QVA 백테스트 데이터 확보 (최소 60거래일, 권장 500거래일)

const fs = require('fs');
const path = require('path');
const naverFetcher = require('./naver-fetcher');

const ROOT = path.dirname(__filename);
const CACHE_DIR = path.join(ROOT, 'cache');
const LONG_CACHE_DIR = path.join(CACHE_DIR, 'stock-charts-long');
const STOCKS_FILE = path.join(CACHE_DIR, 'naver-stocks-list.json');
const FAILED_FILE = path.join(CACHE_DIR, 'longterm-fetch-failed.json');

// CLI 인자 파싱
const startDateArg = process.argv[2] || '20230101';
const forceRefresh = process.argv.includes('--force');
const skipEtf = process.argv.includes('--skip-etf');
const limit = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1])
  : 999999;

const startDate = new Date(startDateArg.slice(0, 4), parseInt(startDateArg.slice(4, 6)) - 1, startDateArg.slice(6, 8));
const endDate = new Date();
const businessDaysEstimate = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24) * 0.7); // 대략 70% 거래일

console.log(`\n📊 장기 차트 데이터 수집 시작\n`);
console.log(`기간: ${startDateArg} ~ ${endDate.toISOString().split('T')[0]}`);
console.log(`예상 거래일: ${businessDaysEstimate}일`);
console.log(`옵션: ${forceRefresh ? '[--force] ' : ''}${skipEtf ? '[--skip-etf] ' : ''}${limit < 999999 ? `[--limit ${limit}]` : ''}\n`);

// 주식 메타 로드
let stocksData;
try {
  stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
} catch (e) {
  console.error('❌ naver-stocks-list.json 로드 실패:', e.message);
  process.exit(1);
}

let allStocks = stocksData.stocks || [];

// ETF/ETN 필터링
if (skipEtf) {
  allStocks = allStocks.filter(s => !s.isEtf);
  console.log(`ETF/ETN 제외 후: ${allStocks.length}개 종목\n`);
}

// limit 적용
allStocks = allStocks.slice(0, limit);

// 통계
const stats = {
  total: allStocks.length,
  success: 0,
  failed: 0,
  skipped: 0,
  rowsCounts: [],
  dateRanges: [],
};

const failed = [];

// 메인 루프
(async () => {
  for (let i = 0; i < allStocks.length; i++) {
    const stock = allStocks[i];
    const code = stock.code || stock.shortCode;
    const name = stock.name;

    // 진행률
    process.stdout.write(
      `\r[${i + 1}/${allStocks.length}] ${code} ${name.padEnd(15)} | ` +
      `성공: ${stats.success}, 실패: ${stats.failed}, 스킵: ${stats.skipped}`
    );

    // 기존 데이터 확인
    const existingPath = path.join(LONG_CACHE_DIR, `${code}.json`);
    let existingChart = null;
    let existingRows = [];

    if (!forceRefresh && fs.existsSync(existingPath)) {
      try {
        existingChart = JSON.parse(fs.readFileSync(existingPath, 'utf-8'));
        existingRows = existingChart.rows || [];
      } catch (_) {}
    }

    // 충분한 데이터가 있으면 스킵 (--force가 아닌 이상)
    if (!forceRefresh && existingRows.length >= 120) {
      const minDate = existingRows[0]?.date;
      if (minDate && minDate <= startDateArg) {
        stats.skipped++;
        continue;
      }
    }

    // Naver에서 데이터 fetch
    let newRows = null;
    let retries = 3;
    while (retries > 0) {
      try {
        newRows = await naverFetcher.fetchDailyChart(code, businessDaysEstimate + 100);
        break;
      } catch (e) {
        retries--;
        if (retries === 0) {
          stats.failed++;
          failed.push({ code, name, reason: e.message });
          break;
        }
        // 재시도 전 대기
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
      }
    }

    if (!newRows) continue;

    // Merge: 기존 + 새로운 데이터
    let mergedRows = [...existingRows];
    const existingDates = new Set(existingRows.map(r => r.date));

    for (const row of newRows) {
      if (!row.date) continue;
      if (existingDates.has(row.date)) {
        // 같은 date: replace
        const idx = mergedRows.findIndex(r => r.date === row.date);
        if (idx >= 0) mergedRows[idx] = row;
      } else {
        // 새로운 date: append
        mergedRows.push(row);
      }
    }

    // 정렬 및 중복 제거
    mergedRows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const seenDates = new Set();
    mergedRows = mergedRows.filter(r => {
      if (seenDates.has(r.date)) return false;
      seenDates.add(r.date);
      return true;
    });

    // startDate 이후 데이터만 유지
    mergedRows = mergedRows.filter(r => r.date >= startDateArg);

    if (mergedRows.length === 0) {
      stats.failed++;
      failed.push({ code, name, reason: 'no data after filter' });
      continue;
    }

    // 저장
    try {
      const output = {
        code,
        name,
        market: stock.market,
        fetchedAt: new Date().toISOString(),
        rows: mergedRows,
      };
      fs.writeFileSync(existingPath, JSON.stringify(output, null, 0));
      stats.success++;
      stats.rowsCounts.push(mergedRows.length);
      stats.dateRanges.push({ minDate: mergedRows[0].date, maxDate: mergedRows[mergedRows.length - 1].date });
    } catch (e) {
      stats.failed++;
      failed.push({ code, name, reason: 'save error: ' + e.message });
    }

    // throttle: 300-700ms 대기
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
  }

  console.log(`\n\n${'═'.repeat(100)}`);
  console.log(`✅ 장기 차트 데이터 수집 완료\n`);

  console.log(`📊 수집 통계:`);
  console.log(`  전체 종목: ${stats.total}개`);
  console.log(`  성공: ${stats.success}개`);
  console.log(`  실패: ${stats.failed}개`);
  console.log(`  스킵: ${stats.skipped}개\n`);

  if (stats.rowsCounts.length > 0) {
    const counts = stats.rowsCounts.sort((a, b) => a - b);
    const min = counts[0];
    const max = counts[counts.length - 1];
    const mean = Math.round(counts.reduce((a, b) => a + b, 0) / counts.length);
    const count120 = counts.filter(c => c >= 120).length;
    const count250 = counts.filter(c => c >= 250).length;
    const count500 = counts.filter(c => c >= 500).length;

    console.log(`📈 데이터 품질:`);
    console.log(`  행 수: 최소 ${min}, 최대 ${max}, 평균 ${mean}`);
    console.log(`  120거래일 이상: ${count120}개 (${(count120 / stats.success * 100).toFixed(1)}%)`);
    console.log(`  250거래일 이상: ${count250}개 (${(count250 / stats.success * 100).toFixed(1)}%)`);
    console.log(`  500거래일 이상: ${count500}개 (${(count500 / stats.success * 100).toFixed(1)}%)\n`);

    if (stats.dateRanges.length > 0) {
      const dates = stats.dateRanges.map(r => r.minDate).sort();
      const minDate = dates[0];
      const maxDate = Math.max(...stats.dateRanges.map(r => r.maxDate));
      console.log(`📅 날짜 범위:`);
      console.log(`  가장 이른 날짜: ${minDate}`);
      console.log(`  가장 늦은 날짜: ${maxDate}\n`);
    }
  }

  if (failed.length > 0) {
    console.log(`⚠️  실패 종목 (${failed.length}개):`);
    failed.slice(0, 10).forEach(f => {
      console.log(`  ${f.code} ${f.name}: ${f.reason}`);
    });
    if (failed.length > 10) {
      console.log(`  ... 외 ${failed.length - 10}개`);
    }
    console.log();

    // 실패 목록 저장
    fs.writeFileSync(FAILED_FILE, JSON.stringify(failed, null, 2));
    console.log(`💾 실패 목록 저장: ${FAILED_FILE}\n`);
  }

  console.log(`${'═'.repeat(100)}`);
  console.log(`\n✓ 다음 단계: QVA 백테스트 실행\n`);
})().catch(e => {
  console.error('\n❌ 오류:', e.message);
  process.exit(1);
});
