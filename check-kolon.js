require('dotenv').config();
const fs = require('fs');
const path = require('path');

// 코오롱(002020) 데이터 확인
const cacheFile = path.join(__dirname, 'cache', '002020.json');
const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

console.log('[코오롱 캐시 데이터]');
const rows = cache.rows || [];
console.log(`총 행 수: ${rows.length}`);

// 최근 3개 행
console.log('\n최근 3개 거래일:');
rows.slice(-3).forEach((r, i) => {
  console.log(`  rows[${rows.length - 3 + i}] (${i - 3}): ${r.date} | close=${r.close} | high=${r.high} | low=${r.low}`);
});

// pattern-result.json에서 코오롱 정보
const resultFile = path.join(__dirname, 'cache', 'pattern-result.json');
const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));

console.log('\n[pattern-result.json 코오롱 정보]');
const kolon = result.vviTodayCandidates?.find(c => c.code === '002020');
if (kolon) {
  console.log('vviTodayCandidates에 있음:');
  console.log('  signalDate:', kolon.signalDate);
  console.log('  lastDate:', kolon.lastDate);
  console.log('  signalHigh:', kolon.signalHigh);
  console.log('  closePrice:', kolon.closePrice);
  console.log('  vvi.signals.todayReturn:', kolon.vvi?.signals?.todayReturn);
  console.log('  vvi.signals.valueRatio20:', kolon.vvi?.signals?.valueRatio20);
  console.log('  vvi.signals.closeLocation:', kolon.vvi?.signals?.closeLocation);
} else {
  console.log('vviTodayCandidates에 없음');
}

const recentKolon = result.vviRecentSignals?.find(c => c.code === '002020');
if (recentKolon) {
  console.log('\nvviRecentSignals에 있음:');
  console.log('  signalDate:', recentKolon.signalDate);
  console.log('  status:', recentKolon.vviStatus);
  console.log('  daysAfterSignal:', recentKolon.daysAfterSignal);
  console.log('  currentPrice:', recentKolon.currentPrice);
}
