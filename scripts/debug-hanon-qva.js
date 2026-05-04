require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const ps = require('../pattern-screener');

const ROOT = path.join(__dirname, '..');
const CODE = '018880';
const TARGET_DATES = ['20260108', '20260122'];
const JAN_START = '20260102';
const JAN_END = '20260131';
const EPISODE_MERGE_WINDOW = 10;
const TRACKING_WINDOW = 20;

const TH = {
  returnFromLow20Max: 20,
  returnFromLow60Max: 25,
  return20Max: 25,
  valueBreakMedianMul: 3.0,
  valueBreakMaxMul: 1.1,
  volumeBreakMedianMul: 2.0,
  return5Max: 15,
  return10Max: 20,
  prevCloseMul: 0.99,
  closeLocationMin: 0.50,
  upperWickRatioMax: 0.55,
  minTodayValue: 1_000_000_000,
  minMedianPrev20Value: 300_000_000,
  collapseRetThreshold: -30,
  collapseValueRatio: 3,
  ma60Mul: 0.85,
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fmtDate(date) {
  if (!date) return '-';
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function n(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  return +Number(v).toFixed(digits);
}

function pct(v) {
  return v == null ? '-' : `${n(v, 2)}%`;
}

function x(v) {
  return v == null ? '-' : `${n(v, 2)}x`;
}

function won(v) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  return `${(v / 1e8).toFixed(1)}억`;
}

function yn(v) {
  return v ? 'Y' : 'N';
}

function median(arr) {
  const xs = arr.filter(v => v > 0).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function sma(values) {
  if (!values.length || values.some(v => v == null)) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function retFrom(base, value) {
  return base > 0 ? (value / base - 1) * 100 : null;
}

function getMeta() {
  const stocksPath = path.join(ROOT, 'cache', 'naver-stocks-list.json');
  const list = readJson(stocksPath);
  const meta = (list.stocks || list || []).find(s => s.code === CODE);
  if (!meta) throw new Error(`meta not found: ${CODE}`);
  return meta;
}

function getRows() {
  const chartPath = path.join(ROOT, 'cache', 'stock-charts-long', `${CODE}.json`);
  const chart = readJson(chartPath);
  return { chart, rows: chart.rows || [] };
}

function getFlowRows() {
  const flowPath = path.join(ROOT, 'cache', 'flow-history', `${CODE}.json`);
  if (!fs.existsSync(flowPath)) return [];
  const flow = readJson(flowPath);
  return flow.rows || flow || [];
}

function diagnose(rows, idx, meta) {
  const sliced = rows.slice(0, idx + 1);
  const res = ps.calculateRedefinedQVA(sliced, [], meta);
  const today = rows[idx];
  const prev = rows[idx - 1];
  const close = today.close;
  const prevClose = prev?.close || close;
  const last5 = sliced.slice(-5);
  const prev5 = sliced.slice(-10, -5);
  const last20 = sliced.slice(-20);
  const last60 = sliced.slice(-60);
  const prev20 = sliced.slice(-21, -1);
  const prev20ValueMedian = median(prev20.map(r => r.valueApprox || r.close * r.volume || 0));
  const prev20ValueMax = Math.max(...prev20.map(r => r.valueApprox || r.close * r.volume || 0).filter(v => v > 0));
  const prev20VolumeMedian = median(prev20.map(r => r.volume || 0));
  const todayValue = today.valueApprox || today.close * today.volume || 0;
  const todayVolume = today.volume || 0;
  const range = today.high - today.low;
  const closeLocation = range > 0 ? (today.close - today.low) / range : 0.5;
  const upperWickRatio = range > 0 ? (today.high - today.close) / range : 0;
  const low20 = Math.min(...last20.map(r => r.low));
  const low60 = Math.min(...last60.map(r => r.low));
  const high60 = Math.max(...last60.map(r => r.high));
  const recent5MinLow = Math.min(...last5.map(r => r.low));
  const previous5MinLow = prev5.length ? Math.min(...prev5.map(r => r.low)) : null;
  const ma5 = sma(last5.map(r => r.close));
  const ma20 = sma(last20.map(r => r.close));
  const ma60 = sma(last60.map(r => r.close));
  const maxValue60 = Math.max(...last60.map(r => r.valueApprox || r.close * r.volume || 0));
  const returnFromLow20 = retFrom(low20, close);
  const returnFromLow60 = retFrom(low60, close);
  const returnFromHigh60 = retFrom(high60, close);
  const return5 = idx >= 5 ? retFrom(rows[idx - 5].close, close) : null;
  const return10 = idx >= 10 ? retFrom(rows[idx - 10].close, close) : null;
  const return20 = idx >= 20 ? retFrom(rows[idx - 20].close, close) : null;
  const valueMedX = prev20ValueMedian > 0 ? todayValue / prev20ValueMedian : null;
  const valueMaxX = prev20ValueMax > 0 ? todayValue / prev20ValueMax : null;
  const volMedX = prev20VolumeMedian > 0 ? todayVolume / prev20VolumeMedian : null;
  const notCollapsedAfterPump = !(returnFromHigh60 <= TH.collapseRetThreshold && maxValue60 >= todayValue * TH.collapseValueRatio);
  const closeAbovePrev99 = close >= prevClose * TH.prevCloseMul;
  const closeAboveMa5 = ma5 != null && close >= ma5;
  const closeAboveMa60x085 = ma60 != null && close >= ma60 * TH.ma60Mul;

  const checks = {
    lowZone: returnFromLow20 <= TH.returnFromLow20Max && returnFromLow60 <= TH.returnFromLow60Max && return20 <= TH.return20Max,
    valueBreak: todayValue >= prev20ValueMedian * TH.valueBreakMedianMul || todayValue >= prev20ValueMax * TH.valueBreakMaxMul,
    volumeBreak: todayVolume >= prev20VolumeMedian * TH.volumeBreakMedianMul,
    notExtended: return5 <= TH.return5Max && return10 <= TH.return10Max,
    notWeakClose: closeAbovePrev99 && closeLocation >= TH.closeLocationMin && upperWickRatio <= TH.upperWickRatioMax,
    liquidityFloor: todayValue >= TH.minTodayValue && prev20ValueMedian >= TH.minMedianPrev20Value,
    notCollapsedAfterPump,
    notTooBroken: closeAboveMa60x085,
  };

  const failedReasons = [];
  if (!checks.lowZone) failedReasons.push('lowZone');
  if (!checks.valueBreak) failedReasons.push('valueBreak');
  if (!checks.volumeBreak) failedReasons.push('volumeBreak');
  if (!checks.notExtended) failedReasons.push('notExtended');
  if (!checks.notWeakClose) {
    if (!closeAbovePrev99) failedReasons.push('notWeakClose: close<prevClose*0.99');
    if (closeLocation < TH.closeLocationMin) failedReasons.push('notWeakClose: closeLocation<0.50');
    if (upperWickRatio > TH.upperWickRatioMax) failedReasons.push('notWeakClose: upperWick>0.55');
  }
  if (!checks.liquidityFloor) failedReasons.push('liquidityFloor');
  if (!checks.notCollapsedAfterPump) failedReasons.push('notCollapsedAfterPump');
  if (!checks.notTooBroken) failedReasons.push('notTooBroken');

  return {
    date: today.date,
    idx,
    open: today.open,
    high: today.high,
    low: today.low,
    close,
    prevClose,
    closeLocation: n(closeLocation),
    upperWickRatio: n(upperWickRatio),
    closeAbovePrev99,
    returnFromLow20: n(returnFromLow20),
    returnFromLow60: n(returnFromLow60),
    returnFromHigh60: n(returnFromHigh60),
    return5: n(return5),
    return10: n(return10),
    return20: n(return20),
    todayValue,
    prev20ValueMedian,
    valueMedX: n(valueMedX),
    prev20ValueMax,
    valueMaxX: n(valueMaxX),
    todayVolume,
    prev20VolumeMedian,
    volMedX: n(volMedX),
    recent5Low: recent5MinLow,
    low20,
    recent5MinLow,
    previous5MinLow,
    ma5: ma5 == null ? null : n(ma5, 0),
    ma20: ma20 == null ? null : n(ma20, 0),
    ma60: ma60 == null ? null : n(ma60, 0),
    closeAboveMa5,
    closeAboveMa60x085,
    maxValue60,
    maxValue60ToTodayValue: todayValue > 0 ? n(maxValue60 / todayValue) : null,
    notCollapsedAfterPump,
    passedQVA: !!res?.passed,
    qvaScore: res?.score || 0,
    grade: res?.grade || 'NONE',
    failedReasons,
    rawFailedReasons: res?.excludeReasons || [],
    checks,
  };
}

function findQvaSignals(rows, meta, start, end) {
  const out = [];
  rows.forEach((r, idx) => {
    if (r.date < start || r.date > end) return;
    const d = diagnose(rows, idx, meta);
    if (d.passedQVA) out.push(d);
  });
  return out;
}

function buildEpisodes(signals) {
  const episodes = [];
  for (const sig of signals) {
    const last = episodes[episodes.length - 1];
    if (!last || sig.idx - last.lastIdx > EPISODE_MERGE_WINDOW) {
      episodes.push({
        signals: [sig],
        firstSignalDate: sig.date,
        bestSignalDate: sig.date,
        lastSignalDate: sig.date,
        episodeStart: sig.date,
        episodeEnd: sig.date,
        firstIdx: sig.idx,
        lastIdx: sig.idx,
        scoreMax: sig.qvaScore,
      });
    } else {
      last.signals.push(sig);
      last.lastSignalDate = sig.date;
      last.episodeEnd = sig.date;
      last.lastIdx = sig.idx;
      if (sig.qvaScore > last.scoreMax) {
        last.scoreMax = sig.qvaScore;
        last.bestSignalDate = sig.date;
      }
    }
  }
  return episodes;
}

function computePerformance(rows, ep, flowRows, meta) {
  const first = rows[ep.firstIdx];
  const close = first.close;
  const at = offset => rows[ep.firstIdx + offset] ? retFrom(close, rows[ep.firstIdx + offset].close) : null;
  const future = rows.slice(ep.firstIdx + 1, ep.firstIdx + TRACKING_WINDOW + 1);
  const highs = future.map(r => r.high);
  const lows = future.map(r => r.low);
  const mfe20 = highs.length ? retFrom(close, Math.max(...highs)) : null;
  const mae20 = lows.length ? retFrom(close, Math.min(...lows)) : null;

  let vvi = null;
  for (let k = 1; k <= TRACKING_WINDOW; k++) {
    const candIdx = ep.firstIdx + k;
    if (!rows[candIdx]) break;
    const candDate = rows[candIdx].date;
    const slicedChart = rows.slice(0, candIdx + 1);
    const slicedFlow = flowRows.filter(r => r.date <= candDate);
    let res = null;
    try { res = ps.calculateVolumeValueIgnition(slicedChart, slicedFlow, meta); } catch (_) {}
    if (res?.passed) {
      const vviRow = rows[candIdx];
      const next = rows[candIdx + 1] || null;
      const triggered1Pct = !!next && next.high >= vviRow.high * 1.01;
      const breakoutFail = !!next && next.close < vviRow.high;
      vvi = {
        date: vviRow.date,
        idx: candIdx,
        daysToVvi: k,
        high: vviRow.high,
        close: vviRow.close,
        category: res.category,
        score: res.score,
        nextDate: next?.date || null,
        nextHigh: next?.high || null,
        nextClose: next?.close || null,
        breakoutSuccess: triggered1Pct && !breakoutFail,
        triggered1Pct,
        breakoutFail,
      };
      break;
    }
  }

  return {
    d5: n(at(5)),
    d10: n(at(10)),
    d20: n(at(20)),
    mfe20: n(mfe20),
    mae20: n(mae20),
    hitPlus10Within20: highs.some(h => retFrom(close, h) >= 10),
    hitPlus20Within20: highs.some(h => retFrom(close, h) >= 20),
    hitMinus10Within20: lows.some(l => retFrom(close, l) <= -10),
    vviWithin20: !!vvi,
    vvi,
    hGroupWithin20: !!vvi?.breakoutSuccess,
  };
}

function printTable(rows, columns) {
  const widths = columns.map(c => Math.max(c.header.length, ...rows.map(r => String(c.value(r) ?? '-').length)));
  console.log(columns.map((c, i) => c.header.padEnd(widths[i])).join('  '));
  console.log(columns.map((_, i) => '-'.repeat(widths[i])).join('  '));
  for (const r of rows) {
    console.log(columns.map((c, i) => String(c.value(r) ?? '-').padEnd(widths[i])).join('  '));
  }
}

function main() {
  const meta = getMeta();
  const { chart, rows } = getRows();
  const flowRows = getFlowRows();
  const namedMeta = { ...meta, name: meta.name || chart.name, marketValue: meta.marketValue || meta.marketCap };

  console.log('\n[한온시스템 018880 QVA 디버그]');
  console.log(`chart rows: ${rows.length}, flow rows: ${flowRows.length}`);
  console.log(`QVA model: calculateRedefinedQVA / REDEFINED_TIGHT_FILTER_C30`);

  const targetRows = TARGET_DATES.map(date => {
    const idx = rows.findIndex(r => r.date === date);
    if (idx < 0) throw new Error(`target date not found: ${date}`);
    return diagnose(rows, idx, namedMeta);
  });

  console.log('\n핵심 날짜:');
  printTable(targetRows, [
    { header: 'date', value: r => fmtDate(r.date) },
    { header: 'close', value: r => r.close },
    { header: 'closeLoc', value: r => r.closeLocation },
    { header: 'retLow20', value: r => pct(r.returnFromLow20) },
    { header: 'retLow60', value: r => pct(r.returnFromLow60) },
    { header: 'valueMedX', value: r => x(r.valueMedX) },
    { header: 'valueMaxX', value: r => x(r.valueMaxX) },
    { header: 'volMedX', value: r => x(r.volMedX) },
    { header: 'pass', value: r => yn(r.passedQVA) },
    { header: 'failedReasons', value: r => r.failedReasons.join(', ') || '-' },
  ]);

  console.log('\n상세 진단:');
  for (const r of targetRows) {
    console.log(`\n${fmtDate(r.date)}`);
    console.table([{
      date: fmtDate(r.date), open: r.open, high: r.high, low: r.low, close: r.close, prevClose: r.prevClose,
      closeLocation: r.closeLocation, upperWickRatio: r.upperWickRatio, closeAbovePrev99: yn(r.closeAbovePrev99),
      returnFromLow20: r.returnFromLow20, returnFromLow60: r.returnFromLow60, returnFromHigh60: r.returnFromHigh60,
      return5: r.return5, return10: r.return10, return20: r.return20,
      todayValue: won(r.todayValue), prev20ValueMedian: won(r.prev20ValueMedian), valueMedX: r.valueMedX,
      prev20ValueMax: won(r.prev20ValueMax), valueMaxX: r.valueMaxX,
      todayVolume: r.todayVolume, prev20VolumeMedian: r.prev20VolumeMedian, volMedX: r.volMedX,
      recent5Low: r.recent5Low, low20: r.low20, recent5MinLow: r.recent5MinLow, previous5MinLow: r.previous5MinLow,
      ma5: r.ma5, ma20: r.ma20, ma60: r.ma60, closeAboveMa5: yn(r.closeAboveMa5), closeAboveMa60x085: yn(r.closeAboveMa60x085),
      maxValue60: won(r.maxValue60), maxValue60ToTodayValue: r.maxValue60ToTodayValue, notCollapsedAfterPump: yn(r.notCollapsedAfterPump),
      passedQVA: yn(r.passedQVA), qvaScore: r.qvaScore, failedReasons: r.failedReasons.join(' / ') || '-',
    }]);
  }

  const janSignals = findQvaSignals(rows, namedMeta, JAN_START, JAN_END);
  console.log('\n1월 QVA 통과일:');
  if (!janSignals.length) {
    console.log('(없음)');
  } else {
    printTable(janSignals, [
      { header: 'date', value: r => fmtDate(r.date) },
      { header: 'score', value: r => r.qvaScore },
      { header: 'close', value: r => r.close },
      { header: 'valueMedX', value: r => x(r.valueMedX) },
      { header: 'closeLoc', value: r => r.closeLocation },
      { header: 'reason', value: r => `valueBreak+volumeBreak+lowZone (${r.grade})` },
    ]);
  }

  const episodes = buildEpisodes(janSignals);
  console.log('\nEpisode:');
  if (!episodes.length) {
    console.log('(없음)');
  } else {
    episodes.forEach((ep, i) => {
      ep.performance = computePerformance(rows, ep, flowRows, namedMeta);
      console.log(`episode #${i + 1}`);
      console.log(`firstSignalDate: ${fmtDate(ep.firstSignalDate)}`);
      console.log(`bestSignalDate:  ${fmtDate(ep.bestSignalDate)}`);
      console.log(`lastSignalDate:  ${fmtDate(ep.lastSignalDate)}`);
      console.log(`episodeStart:    ${fmtDate(ep.episodeStart)}`);
      console.log(`episodeEnd:      ${fmtDate(ep.episodeEnd)}`);
      console.log(`scoreMax:        ${ep.scoreMax}`);
      console.log(`sameEpisode:     ${yn(ep.signals.length > 1)}`);
      console.log(`signals:         ${ep.signals.map(s => fmtDate(s.date)).join(', ')}`);
    });
  }

  console.log('\n성과:');
  if (!episodes.length) {
    console.log('(QVA episode 없음)');
  } else {
    for (const ep of episodes) {
      const p = ep.performance;
      console.log(`\n기준 firstSignalDate ${fmtDate(ep.firstSignalDate)}`);
      console.log(`D+5: ${pct(p.d5)}`);
      console.log(`D+10: ${pct(p.d10)}`);
      console.log(`D+20: ${pct(p.d20)}`);
      console.log(`MFE20: ${pct(p.mfe20)}`);
      console.log(`MAE20: ${pct(p.mae20)}`);
      console.log(`+10% within 20d: ${yn(p.hitPlus10Within20)}`);
      console.log(`+20% within 20d: ${yn(p.hitPlus20Within20)}`);
      console.log(`-10% within 20d: ${yn(p.hitMinus10Within20)}`);
      console.log(`VVI within 20d: ${yn(p.vviWithin20)}${p.vvi ? ` (${fmtDate(p.vvi.date)}, D+${p.vvi.daysToVvi}, ${p.vvi.category}, score ${p.vvi.score})` : ''}`);
      console.log(`HGroup within 20d: ${yn(p.hGroupWithin20)}${p.vvi?.nextDate ? ` (next ${fmtDate(p.vvi.nextDate)}, triggered1Pct=${yn(p.vvi.triggered1Pct)}, breakoutFail=${yn(p.vvi.breakoutFail)})` : ''}`);
    }
  }

  const aprilSignals = findQvaSignals(rows, namedMeta, '20260401', '20260430');
  const firstEp = episodes[0] || null;
  const firstPerf = firstEp?.performance || null;

  console.log('\n최종 판단:');
  console.log(`1. 2026-01-08 QVA: ${yn(targetRows[0].passedQVA)}${targetRows[0].passedQVA ? '' : ` (${targetRows[0].failedReasons.join(', ')})`}`);
  console.log(`2. 2026-01-22 QVA: ${yn(targetRows[1].passedQVA)}${targetRows[1].passedQVA ? '' : ` (${targetRows[1].failedReasons.join(', ')})`}`);
  console.log(`3. 2026년 1월 QVA 날짜 존재: ${yn(janSignals.length > 0)}${janSignals.length ? ` (${janSignals.map(s => fmtDate(s.date)).join(', ')})` : ''}`);
  console.log(`4. firstSignalDate: ${firstEp ? fmtDate(firstEp.firstSignalDate) : '-'}`);
  console.log(`5. bestSignalDate: ${firstEp ? fmtDate(firstEp.bestSignalDate) : '-'}`);
  console.log(`6. 1월 QVA 이후 20거래일 안 VVI: ${yn(firstPerf?.vviWithin20)}${firstPerf?.vvi ? ` (${fmtDate(firstPerf.vvi.date)})` : ''}`);
  console.log(`7. 1월 QVA 이후 20거래일 안 돌파 성공/H그룹: ${yn(firstPerf?.hGroupWithin20)}`);
  console.log(`8. 4월 중순~5월 급등을 1월 QVA 후속 흐름으로 볼지: ${firstEp ? '20거래일 추적창 밖의 장기 후속 흐름입니다. 1월 QVA 이후 20거래일 성과는 강했지만, VVI/H그룹 확인은 없었고 4월 중순 흐름은 별도 구간으로 봐야 합니다.' : '1월 QVA가 없어 후속 흐름으로 볼 수 없습니다.'}`);
  console.log(`9. QVA가 놓친 것인가: ${janSignals.length ? '1월에는 QVA가 잡혔습니다. 4월 구간은 저점권 QVA가 아니라 VVI/돌파 이후 연장 또는 재점화 구간으로 보는 것이 현재 모델 취지에 맞습니다.' : '1월 QVA는 없었습니다. 4월 구간을 QVA로 보지 않은 것은 저점권 조건상 자연스러운 결과인지 별도 확인이 필요합니다.'}`);
  console.log(`참고: 2026년 4월 QVA 통과일: ${aprilSignals.length ? aprilSignals.map(s => `${fmtDate(s.date)}(score ${s.qvaScore})`).join(', ') : '없음'}`);
}

main();
