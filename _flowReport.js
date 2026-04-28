// Korea Flow Lead Model — Phase C 데이터 검증 리포트
//
// 출력 항목 (사용자 요구):
//   - 수집 대상 / 성공 / 실패 / 평균 수집 일수
//   - 외국인 / 기관 결측률, 날짜 매칭 실패율
//   - 순매수대금 이상치 종목 (시총 50% 초과)
//   - 최근 5d / 20d 외국인+기관 순매수 상위
//   - Korea Flow Lead 후보 (모델 점수 ≥ 70)

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');

const ps = require('./pattern-screener');

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function loadStocksList() {
  return loadJSON(STOCKS_LIST);
}

function pad(s, n, right = false) {
  const v = String(s ?? '');
  if (v.length >= n) return v.slice(0, n);
  return right ? v.padStart(n) : v.padEnd(n);
}

function fmt억(v) {
  if (!Number.isFinite(v)) return '-';
  const a = v / 1e8;
  return a.toFixed(0) + '억';
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return '-';
  return (v * 100).toFixed(1) + '%';
}

(async () => {
  const list = loadStocksList();
  const codeMeta = new Map();
  for (const s of list.stocks) codeMeta.set(s.code, s);

  if (!fs.existsSync(FLOW_DIR)) {
    console.log('flow-history 디렉토리 없음 — seed-flow-naver.js 먼저 실행');
    process.exit(0);
  }

  const flowFiles = fs.readdirSync(FLOW_DIR).filter((f) => f.endsWith('.json'));
  const chartFiles = new Set(
    fs.readdirSync(CHART_DIR).filter((f) => f.endsWith('.json')),
  );

  const codes = flowFiles.map((f) => f.replace('.json', ''));
  let success = 0;
  let fail = 0;
  let totalDays = 0;
  let foreignMissing = 0;
  let instMissing = 0;
  let dateMismatch = 0;
  const outliers = [];
  const flow5d = [];
  const flow20d = [];

  // 모델용 — 가장 최근 시점 점수
  const candidates = [];        // FlowLead
  const reboundCands = [];       // Rebound

  for (const code of codes) {
    const meta = codeMeta.get(code) || {};
    const flow = loadJSON(path.join(FLOW_DIR, `${code}.json`));
    const rows = flow.rows || [];
    if (!rows.length) {
      fail++;
      continue;
    }
    success++;
    totalDays += rows.length;

    for (const r of rows) {
      if (r.foreignNetVol == null) foreignMissing++;
      if (r.instNetVol == null) instMissing++;
    }

    let chart = null;
    if (chartFiles.has(`${code}.json`)) {
      try {
        chart = loadJSON(path.join(CHART_DIR, `${code}.json`));
      } catch (_) {
        chart = null;
      }
      if (chart?.rows) {
        const chartDates = new Set(chart.rows.map((r) => r.date));
        for (const r of rows) if (!chartDates.has(r.date)) dateMismatch++;
      }
    }

    const mc = meta.marketValue || 0;
    for (const r of rows) {
      const totalFlow = Math.abs(r.foreignNetValue || 0) + Math.abs(r.instNetValue || 0);
      if (mc > 0 && totalFlow > mc * 0.5) {
        outliers.push({ code, name: meta.name, date: r.date, flow: totalFlow, mc });
      }
    }

    const last5 = rows.slice(-5);
    const last20 = rows.slice(-20);
    const sumKey = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
    const f5 = sumKey(last5, 'foreignNetValue');
    const i5 = sumKey(last5, 'instNetValue');
    const f20 = sumKey(last20, 'foreignNetValue');
    const i20 = sumKey(last20, 'instNetValue');
    flow5d.push({ code, name: meta.name, market: meta.market, foreign: f5, inst: i5, total: f5 + i5 });
    flow20d.push({ code, name: meta.name, market: meta.market, foreign: f20, inst: i20, total: f20 + i20 });

    // 모델 점수 — 최근 시점만 (라이브 모드)
    if (chart?.rows && chart.rows.length >= 60) {
      try {
        const score = ps.calculateFlowLeadScore(chart.rows, rows, meta);
        if (score && score.passed) {
          candidates.push({
            code,
            name: meta.name,
            market: meta.market,
            close: chart.rows[chart.rows.length - 1].close,
            mc,
            ...score,
          });
        }
      } catch (e) { /* 무시 */ }
    }

    // Rebound — 200MA 필요해서 chart 220일 이상
    if (chart?.rows && chart.rows.length >= 220) {
      try {
        const score = ps.calculateReboundScore(chart.rows, rows, meta);
        if (score && score.passed) {
          reboundCands.push({
            code,
            name: meta.name,
            market: meta.market,
            close: chart.rows[chart.rows.length - 1].close,
            mc,
            ...score,
          });
        }
      } catch (e) { /* 무시 */ }
    }
  }

  console.log('================================================================');
  console.log('Korea Flow Lead Model — Phase C 데이터 검증 리포트');
  console.log('================================================================\n');

  console.log(`수집 대상 종목 수: ${codes.length}`);
  console.log(`성공 종목 수: ${success}`);
  console.log(`실패 종목 수: ${fail}`);
  console.log(`평균 수집 일수: ${(totalDays / Math.max(success, 1)).toFixed(1)}일`);
  console.log(`외국인 데이터 결측률: ${((foreignMissing / Math.max(totalDays, 1)) * 100).toFixed(2)}%`);
  console.log(`기관 데이터 결측률: ${((instMissing / Math.max(totalDays, 1)) * 100).toFixed(2)}%`);
  console.log(`날짜 매칭 실패율: ${((dateMismatch / Math.max(totalDays, 1)) * 100).toFixed(2)}%`);
  console.log(`순매수대금 이상치 종목 (단일일 합계 > 시총 50%): ${outliers.length}`);
  if (outliers.length) {
    outliers.slice(0, 8).forEach((o) => {
      console.log(`  ${o.code} ${o.name} ${o.date}: ${fmt억(o.flow)} (시총 ${fmt억(o.mc)})`);
    });
  }

  console.log('\n--- 최근 5일 외국인+기관 순매수 상위 15 ---');
  flow5d.sort((a, b) => b.total - a.total).slice(0, 15).forEach((r, i) => {
    console.log(
      `  ${pad(i + 1, 2, true)}. ${pad(r.code, 7)} ${pad(r.name || '', 14)} ${pad(r.market || '', 7)}  합 ${pad(fmt억(r.total), 7, true)}  (외 ${pad(fmt억(r.foreign), 7, true)}, 기 ${pad(fmt억(r.inst), 7, true)})`,
    );
  });

  console.log('\n--- 최근 20일 외국인+기관 순매수 상위 15 ---');
  flow20d.sort((a, b) => b.total - a.total).slice(0, 15).forEach((r, i) => {
    console.log(
      `  ${pad(i + 1, 2, true)}. ${pad(r.code, 7)} ${pad(r.name || '', 14)} ${pad(r.market || '', 7)}  합 ${pad(fmt억(r.total), 8, true)}  (외 ${pad(fmt억(r.foreign), 8, true)}, 기 ${pad(fmt억(r.inst), 8, true)})`,
    );
  });

  console.log('\n--- Korea Flow Lead 후보 (필터 통과 + score 정렬) ---');
  if (!candidates.length) {
    console.log('  없음 (모델 미구현 또는 필터 통과 0)');
  } else {
    candidates.sort((a, b) => b.score - a.score);
    candidates.slice(0, 20).forEach((c, i) => {
      console.log(
        `  ${pad(i + 1, 2, true)}. ${pad(c.code, 7)} ${pad(c.name || '', 14)} score=${c.score}  flow5d ${fmt억((c.signals?.foreign5d || 0) + (c.signals?.inst5d || 0))}  ratio ${fmtPct(c.signals?.flowRatio5d)}  ret5 ${fmtPct(c.signals?.ret5d)}  ret20 ${fmtPct(c.signals?.ret20d)}`,
      );
    });
    console.log(`\n  총 ${candidates.length} 종목 통과`);
  }

  console.log('\n--- Korea Rebound 후보 (필터 통과 + score 정렬) ---');
  if (!reboundCands.length) {
    console.log('  없음 — 현재 시점 과매도+필터 통과 종목 0');
  } else {
    reboundCands.sort((a, b) => b.score - a.score);
    reboundCands.slice(0, 20).forEach((c, i) => {
      const s = c.signals || {};
      console.log(
        `  ${pad(i + 1, 2, true)}. ${pad(c.code, 7)} ${pad(c.name || '', 14)} score=${c.score}  ret5 ${fmtPct(s.ret5d)}  ret10 ${fmtPct(s.ret10d)}  ret20 ${fmtPct(s.ret20d)}  ATR% ${fmtPct(s.atrPct)}  flow3d ${fmt억(s.sum3)}`,
      );
    });
    console.log(`\n  총 ${reboundCands.length} 종목 통과`);
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
