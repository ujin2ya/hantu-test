#!/usr/bin/env node
// QVA 모델 오늘 기준 스캔 — 기본 vs STRICT 비교

const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = path.dirname(__filename);
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const STOCKS_FILE = path.join(ROOT, 'cache', 'naver-stocks-list.json');

// 주식 메타 로드
const stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
const stockMap = {};
(stocksData.stocks || []).forEach(s => {
  stockMap[s.code] = s;
});

// QVA 스캔 — 기본 + STRICT 두 버전
const qvaBasic = [];
const qvaStrict = [];
const rejected = [];

const files = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json'));

console.log(`\n📊 QVA 스캔 시작 (기본 vs STRICT 비교)\n`);
console.log(`총 ${files.length}개 종목 처리 중...\n`);

let processed = 0;
files.forEach((file, idx) => {
  const code = file.replace('.json', '');
  const meta = stockMap[code];
  if (!meta) return;

  let chart;
  try {
    chart = JSON.parse(fs.readFileSync(path.join(CHART_DIR, file), 'utf-8'));
  } catch (_) { return; }

  const rows = chart.rows || [];
  if (rows.length < 60) return;

  // QVA 기본 버전 계산
  let qvaBasicResult = null;
  let qvaBasicReason = null;
  try {
    const res = ps.calculateQuietVolumeAnomaly(rows, [], { code, marketValue: meta.marketValue, isEtf: meta.isEtf, isSpecial: meta.isSpecial });
    if (res?.passed) {
      qvaBasicResult = res;
    } else {
      qvaBasicReason = res?.reason || 'unknown';
    }
  } catch (e) {
    qvaBasicReason = 'error';
    return;
  }

  // QVA STRICT 버전 계산
  let qvaStrictResult = null;
  let qvaStrictReason = null;
  try {
    const res = ps.calculateQuietVolumeAnomalyStrict(rows, [], { code, marketValue: meta.marketValue, isEtf: meta.isEtf, isSpecial: meta.isSpecial });
    if (res?.passed) {
      qvaStrictResult = res;
    } else {
      qvaStrictReason = res?.reason || 'unknown';
    }
  } catch (e) {
    qvaStrictReason = 'error';
  }

  const today = rows[rows.length - 1];
  const close = today.close;
  const todayReturn = today.open > 0 ? (close / today.open - 1) : 0;
  const baseSignals = qvaBasicResult?.signals || {};

  const item = {
    code,
    name: meta.name,
    market: meta.market,
    closePrice: close,
    todayReturn: (todayReturn * 100).toFixed(2),
    ret5d: (baseSignals.ret5d || 0).toFixed(2),
    ret20d: (baseSignals.ret20d || 0).toFixed(2),
    volumeRatio20: (baseSignals.volumeRatio20 || 0).toFixed(2),
    valueRatio20: (baseSignals.valueRatio20 || 0).toFixed(2),
    valueDryness: (baseSignals.valueDryness || 0).toFixed(2),
    upperWickRatio: (baseSignals.upperWickRatio || 0).toFixed(2),
    atrPct: (baseSignals.atrPct || 0).toFixed(1),
    avg20Value: baseSignals.avg20Value || 0,
  };

  if (qvaBasicResult?.passed) {
    qvaBasic.push(item);
  }

  if (qvaStrictResult?.passed) {
    qvaStrict.push(item);
  }

  if (!qvaBasicResult?.passed && !qvaStrictResult?.passed) {
    rejected.push({
      code,
      name: meta.name,
      basicReason: qvaBasicReason,
      strictReason: qvaStrictReason,
      todayReturn: item.todayReturn,
      ret5d: item.ret5d,
      ret20d: item.ret20d,
      volumeRatio20: item.volumeRatio20,
      valueRatio20: item.valueRatio20,
      valueDryness: item.valueDryness,
      upperWickRatio: item.upperWickRatio,
    });
  }

  processed++;
  if ((idx + 1) % 500 === 0) {
    process.stdout.write(`\r진행중: ${idx + 1}/${files.length}`);
  }
});

console.log(`\r완료: ${processed}개 종목 처리 완료\n`);

// 정렬 함수
const sortFn = (a, b) => {
  if (parseFloat(b.valueRatio20) !== parseFloat(a.valueRatio20)) {
    return parseFloat(b.valueRatio20) - parseFloat(a.valueRatio20);
  }
  if (parseFloat(b.volumeRatio20) !== parseFloat(a.volumeRatio20)) {
    return parseFloat(b.volumeRatio20) - parseFloat(a.volumeRatio20);
  }
  return parseFloat(a.todayReturn) - parseFloat(b.todayReturn);
};

qvaBasic.sort(sortFn);
qvaStrict.sort(sortFn);

// 결과 출력
console.log('═'.repeat(100));
console.log(`📊 QVA 스캔 결과 요약\n`);
console.log(`QVA 기본 후보: ${qvaBasic.length}개`);
console.log(`QVA STRICT 후보: ${qvaStrict.length}개\n`);

if (qvaBasic.length > 0) {
  console.log('─'.repeat(100));
  console.log(`🟢 QVA 기본 후보 (${qvaBasic.length}개)\n`);

  const header = '종목명          코드    시장      오늘  D5    D20   Vol×  Val×  건조  윗꼬 ATR%  평균거래대금';
  console.log(header);
  console.log('─'.repeat(100));

  qvaBasic.forEach(item => {
    const valStr = item.avg20Value >= 1e9
      ? (item.avg20Value / 1e9).toFixed(1) + 'B'
      : (item.avg20Value / 1e6).toFixed(1) + 'M';

    const row = `${item.name.padEnd(15)} ${item.code} ${item.market.padEnd(7)} ${item.todayReturn.padStart(5)} ${item.ret5d.padStart(5)} ${item.ret20d.padStart(5)} ${item.volumeRatio20.padStart(5)} ${item.valueRatio20.padStart(5)} ${item.valueDryness.padStart(5)} ${item.upperWickRatio.padStart(5)} ${item.atrPct.padStart(5)} ${valStr.padStart(12)}`;
    console.log(row);
  });
}

if (qvaStrict.length > 0) {
  console.log('\n' + '═'.repeat(100));
  console.log(`🟠 QVA STRICT 후보 (${qvaStrict.length}개) — 더 엄격한 실험 기준\n`);

  const header = '종목명          코드    시장      오늘  D5    D20   Vol×  Val×  건조  윗꼬 ATR%  평균거래대금';
  console.log(header);
  console.log('─'.repeat(100));

  qvaStrict.forEach(item => {
    const valStr = item.avg20Value >= 1e9
      ? (item.avg20Value / 1e9).toFixed(1) + 'B'
      : (item.avg20Value / 1e6).toFixed(1) + 'M';

    const row = `${item.name.padEnd(15)} ${item.code} ${item.market.padEnd(7)} ${item.todayReturn.padStart(5)} ${item.ret5d.padStart(5)} ${item.ret20d.padStart(5)} ${item.volumeRatio20.padStart(5)} ${item.valueRatio20.padStart(5)} ${item.valueDryness.padStart(5)} ${item.upperWickRatio.padStart(5)} ${item.atrPct.padStart(5)} ${valStr.padStart(12)}`;
    console.log(row);
  });
}

// 세아베스틸지주 확인
const seaName = '세아베스틸지주';
const seaCode = '001430';
const seaRejected = rejected.find(r => r.code === seaCode);

if (seaRejected) {
  console.log('\n' + '═'.repeat(100));
  console.log(`\n🔍 ${seaRejected.name} (${seaCode}) — 왜 QVA에서 제외되었는가?\n`);

  console.log(`지표 현황:`);
  console.log(`  • 오늘 수익률: ${seaRejected.todayReturn}% (기준: -1.5% ~ +3.5%)`);
  console.log(`  • 5일 수익률: ${seaRejected.ret5d}% (기준: ≤ 5%)`);
  console.log(`  • 20일 수익률: ${seaRejected.ret20d}% (기준: ≤ 10%)`);
  console.log(`  • 거래량비: ${seaRejected.volumeRatio20}x (기준: ≥ 1.7x)`);
  console.log(`  • 거래대금비: ${seaRejected.valueRatio20}x (기준: ≥ 1.7x)`);
  console.log(`  • 건조도: ${seaRejected.valueDryness} (기준: ≤ 1.1)`);
  console.log(`  • 윗꼬리: ${seaRejected.upperWickRatio} (기준: ≤ 0.40)\n`);

  console.log(`제외 사유:`);
  console.log(`  QVA 기본: ${seaRejected.basicReason}`);
  console.log(`  QVA STRICT: ${seaRejected.strictReason}\n`);

  console.log(`해석:`);
  console.log(`  이 종목은 이미 5일/20일 상승률이 있으며, 건조도가 높아서`);
  console.log(`  순수한 조용한 구간 매집형이 아닌 재료 반응형으로 판단됩니다.`);
  console.log(`  QVA는 "평소와 다른 조용한 구간"에서의 선행 신호를 포착하는 모델입니다.\n`);
}

if (qvaBasic.length === 0 && qvaStrict.length === 0) {
  console.log('\n' + '═'.repeat(100));
  console.log(`\n✓ 오늘 QVA 후보 없음\n`);
  console.log(`QVA는 후보를 억지로 만들지 않습니다.`);
  console.log(`조건에 부합하는 순수한 신호가 없을 때는 0개로 유지합니다.\n`);
}

console.log('═'.repeat(100));
