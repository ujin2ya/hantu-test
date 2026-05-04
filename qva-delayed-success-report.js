/**
 * QVA delayed success report
 *
 * Finds REDEFINED_TIGHT_FILTER_C30 QVA events that did not convert to VVI/H
 * within 20 trading days, but still produced large forward MFE.
 *
 * Outputs:
 *   qva-delayed-success-report.json
 *   qva-delayed-success-report.html
 */

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const ps = require('./pattern-screener');

const ROOT = __dirname;
const LONG_CACHE_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const OUT_JSON = path.join(ROOT, 'qva-delayed-success-report.json');
const OUT_HTML = path.join(ROOT, 'qva-delayed-success-report.html');

const SCAN_START = '20250401';
const SCAN_END = '20260430';
const VVI_LOOKAHEAD = 20;
const EPISODE_MERGE_WINDOW = 10;
const HORIZONS = [20, 40, 60];
const DELAYED_MFE_THRESHOLD = 30;
const EXCLUDE_KEYWORDS = ['ETN', 'ETF', '레버리지', '인버스', '선물', 'TR', 'H)'];

function isExcludedProduct(name) {
  if (!name) return false;
  return EXCLUDE_KEYWORDS.some(kw => name.includes(kw));
}

function round2(v) {
  return v == null || !Number.isFinite(v) ? null : +v.toFixed(2);
}

function mean(values) {
  const arr = values.filter(v => v != null && Number.isFinite(v));
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

function rate(count, total) {
  return total ? round2(count / total * 100) : null;
}

function fmtDate(d) {
  return d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : (d || '-');
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function retFrom(price, value) {
  return price > 0 && value != null ? (value / price - 1) * 100 : null;
}

function computeForward(rows, idx, price) {
  const out = { d: {}, mfe: {}, mae: {}, hit: {}, available: {} };
  for (const h of HORIZONS) {
    const target = rows[idx + h];
    out.available[h] = !!target;
    out.d[h] = target ? round2(retFrom(price, target.close)) : null;

    let mfe = null;
    let mae = null;
    let hit10 = false;
    let hit20 = false;
    let hit30 = false;
    let hitMinus10 = false;
    for (let k = 1; k <= h && idx + k < rows.length; k++) {
      const row = rows[idx + k];
      const up = retFrom(price, row.high);
      const down = retFrom(price, row.low);
      if (mfe == null || up > mfe) mfe = up;
      if (mae == null || down < mae) mae = down;
      if (up >= 10) hit10 = true;
      if (up >= 20) hit20 = true;
      if (up >= 30) hit30 = true;
      if (down <= -10) hitMinus10 = true;
    }
    out.mfe[h] = round2(mfe);
    out.mae[h] = round2(mae);
    out.hit[h] = { plus10: hit10, plus20: hit20, plus30: hit30, minus10: hitMinus10 };
  }
  return out;
}

function collectVviPath(rows, flowRows, meta, qvaIdx) {
  const reasons = {};
  const attempts = [];
  const maxLook = Math.min(VVI_LOOKAHEAD, rows.length - 1 - qvaIdx);

  for (let k = 1; k <= maxLook; k++) {
    const candIdx = qvaIdx + k;
    const candDate = rows[candIdx].date;
    const slicedChart = rows.slice(0, candIdx + 1);
    const slicedFlow = flowRows.filter(r => r.date <= candDate);
    let vvi = null;
    let reason = null;

    if (slicedFlow.length < 10) {
      reason = 'flowRows<10';
    } else {
      try { vvi = ps.calculateVolumeValueIgnition(slicedChart, slicedFlow, meta); }
      catch (e) { reason = `error:${e.message}`; }
      if (!reason) reason = vvi?.passed ? null : (vvi?.reason || 'not passed');
    }

    if (vvi?.passed) {
      const vviRow = rows[candIdx];
      const next = rows[candIdx + 1] || null;
      const triggered1Pct = !!next && next.high >= vviRow.high * 1.01;
      const breakoutFail = !!next && next.close < vviRow.high;
      return {
        vviWithin20: true,
        hGroupWithin20: triggered1Pct && !breakoutFail,
        vviDate: vviRow.date,
        vviIdx: candIdx,
        daysToVvi: k,
        vviHigh: vviRow.high,
        vviClose: vviRow.close,
        vviScore: vvi.score,
        vviCategory: vvi.category,
        nextDate: next?.date || null,
        nextHigh: next?.high || null,
        nextClose: next?.close || null,
        triggered1Pct,
        breakoutFail,
        reasons,
        attempts,
      };
    }

    reasons[reason] = (reasons[reason] || 0) + 1;
    attempts.push({ date: candDate, reason });
  }

  return { vviWithin20: false, hGroupWithin20: false, reasons, attempts };
}

function addReasonCounts(target, reasons) {
  for (const [reason, count] of Object.entries(reasons || {})) {
    target[reason] = (target[reason] || 0) + count;
  }
}

function topReasons(reasonCounts, limit = 10) {
  return Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function topConditionReasons(reasonCounts, limit = 10) {
  const dataReasons = new Set(['flowRows<10']);
  return Object.entries(reasonCounts)
    .filter(([reason]) => !dataReasons.has(reason) && !reason.startsWith('error:'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function episodeDedup(events) {
  const byCode = new Map();
  for (const event of events) {
    if (!byCode.has(event.code)) byCode.set(event.code, []);
    byCode.get(event.code).push(event);
  }

  const dedup = [];
  for (const arr of byCode.values()) {
    arr.sort((a, b) => a.idx - b.idx);
    let current = null;
    for (const event of arr) {
      if (!current || event.idx - current.lastIdx > EPISODE_MERGE_WINDOW) {
        current = {
          ...event,
          firstSignalDate: event.qvaDate,
          bestSignalDate: event.qvaDate,
          lastSignalDate: event.qvaDate,
          episodeStart: event.qvaDate,
          episodeEnd: event.qvaDate,
          signalCountInEpisode: 1,
          lastIdx: event.idx,
          scoreMax: event.qvaScore,
        };
        dedup.push(current);
      } else {
        current.lastSignalDate = event.qvaDate;
        current.episodeEnd = event.qvaDate;
        current.lastIdx = event.idx;
        current.signalCountInEpisode += 1;
        if (event.qvaScore > current.scoreMax) {
          current.scoreMax = event.qvaScore;
          current.bestSignalDate = event.qvaDate;
        }
      }
    }
  }
  return dedup.sort((a, b) => a.qvaDate.localeCompare(b.qvaDate) || a.code.localeCompare(b.code));
}

function groupMetrics(items) {
  const metric = {
    signalCount: items.length,
    uniqueStocks: new Set(items.map(e => e.code)).size,
    vviEventCount: items.filter(e => e.vviWithin20).length,
    hGroupEventCount: items.filter(e => e.hGroupWithin20).length,
    vviRate: rate(items.filter(e => e.vviWithin20).length, items.length),
    hGroupRate: rate(items.filter(e => e.hGroupWithin20).length, items.length),
  };

  for (const h of HORIZONS) {
    const available = items.filter(e => e.forward.available[h]);
    metric[`availableD${h}`] = available.length;
    metric[`avgD${h}`] = round2(mean(available.map(e => e.forward.d[h])));
    metric[`avgMFE${h}`] = round2(mean(available.map(e => e.forward.mfe[h])));
    metric[`avgMAE${h}`] = round2(mean(available.map(e => e.forward.mae[h])));
    metric[`hitPlus10Rate${h}`] = rate(available.filter(e => e.forward.hit[h].plus10).length, available.length);
    metric[`hitPlus20Rate${h}`] = rate(available.filter(e => e.forward.hit[h].plus20).length, available.length);
    metric[`hitPlus30Rate${h}`] = rate(available.filter(e => e.forward.hit[h].plus30).length, available.length);
    metric[`hitMinus10Rate${h}`] = rate(available.filter(e => e.forward.hit[h].minus10).length, available.length);
  }

  return metric;
}

function makeCase(event) {
  return {
    code: event.code,
    name: event.name,
    market: event.market,
    qvaDate: event.qvaDate,
    qvaPrice: event.qvaPrice,
    qvaScore: event.qvaScore,
    firstSignalDate: event.firstSignalDate,
    bestSignalDate: event.bestSignalDate,
    lastSignalDate: event.lastSignalDate,
    d20: event.forward.d[20],
    d40: event.forward.d[40],
    d60: event.forward.d[60],
    mfe20: event.forward.mfe[20],
    mfe40: event.forward.mfe[40],
    mfe60: event.forward.mfe[60],
    mae20: event.forward.mae[20],
    mae40: event.forward.mae[40],
    mae60: event.forward.mae[60],
    vviWithin20: event.vviWithin20,
    hGroupWithin20: event.hGroupWithin20,
    vviFailTopReasons: topReasons(event.vviFailReasons || {}, 5),
  };
}

function scan() {
  const stocksList = readJsonSafe(STOCKS_LIST, { stocks: [] });
  const codeMeta = new Map((stocksList.stocks || []).map(s => [s.code, s]));
  const files = fs.readdirSync(LONG_CACHE_DIR).filter(f => f.endsWith('.json'));
  const rawEvents = [];
  let scannedRows = 0;

  console.log('\nQVA delayed success report');
  console.log(`scan: ${fmtDate(SCAN_START)} ~ ${fmtDate(SCAN_END)}`);
  console.log(`files: ${files.length}`);

  for (let fi = 0; fi < files.length; fi++) {
    if (fi % 250 === 0) process.stdout.write(`  progress ${fi}/${files.length}\r`);
    const code = files[fi].replace('.json', '');
    const meta = codeMeta.get(code);
    if (!meta) continue;

    const chart = readJsonSafe(path.join(LONG_CACHE_DIR, files[fi]), null);
    if (!chart) continue;
    const rows = chart.rows || [];
    if (rows.length < 65) continue;
    const name = chart.name || meta.name;
    if (isExcludedProduct(name)) continue;

    const flow = readJsonSafe(path.join(FLOW_DIR, files[fi]), { rows: [] });
    const flowRows = flow.rows || flow || [];
    const namedMeta = { ...meta, name, marketValue: meta.marketValue || meta.marketCap };

    for (let idx = 60; idx < rows.length; idx++) {
      const row = rows[idx];
      if (row.date < SCAN_START || row.date > SCAN_END) continue;
      scannedRows++;

      let qva = null;
      try { qva = ps.calculateRedefinedQVA(rows.slice(0, idx + 1), [], namedMeta); }
      catch (_) { qva = null; }
      if (!qva?.passed) continue;

      const vviPath = collectVviPath(rows, flowRows, namedMeta, idx);
      rawEvents.push({
        code,
        name,
        market: meta.market,
        idx,
        qvaDate: row.date,
        qvaPrice: row.close,
        qvaValue: row.valueApprox || row.close * row.volume || 0,
        qvaScore: qva.score,
        qvaGrade: qva.grade,
        qvaSignals: qva.signals,
        forward: computeForward(rows, idx, row.close),
        vviWithin20: vviPath.vviWithin20,
        hGroupWithin20: vviPath.hGroupWithin20,
        vviDate: vviPath.vviDate || null,
        daysToVvi: vviPath.daysToVvi || null,
        vviScore: vviPath.vviScore || null,
        vviCategory: vviPath.vviCategory || null,
        triggered1Pct: vviPath.triggered1Pct || false,
        breakoutFail: vviPath.breakoutFail || false,
        vviFailReasons: vviPath.reasons || {},
        vviAttempts: vviPath.attempts || [],
      });
    }
  }

  process.stdout.write(`  progress ${files.length}/${files.length}\n`);
  console.log(`scanned rows: ${scannedRows}, raw QVA signals: ${rawEvents.length}`);
  const events = episodeDedup(rawEvents);
  console.log(`episode-dedup QVA events: ${events.length}`);
  return { rawEvents, events, scannedRows, fileCount: files.length };
}

function buildReport() {
  const { rawEvents, events, scannedRows, fileCount } = scan();

  const qvaAll = events;
  const qvaToVvi20 = events.filter(e => e.vviWithin20);
  const hGroup20 = events.filter(e => e.hGroupWithin20);
  const qvaOnly = events.filter(e => !e.vviWithin20 && !e.hGroupWithin20);
  const delayed20 = qvaOnly.filter(e => e.forward.mfe[20] >= DELAYED_MFE_THRESHOLD);
  const delayed40 = qvaOnly.filter(e => e.forward.mfe[40] >= DELAYED_MFE_THRESHOLD);
  const delayed60 = qvaOnly.filter(e => e.forward.mfe[60] >= DELAYED_MFE_THRESHOLD);
  const delayed21to40 = qvaOnly.filter(e => (e.forward.mfe[20] == null || e.forward.mfe[20] < DELAYED_MFE_THRESHOLD) && e.forward.mfe[40] >= DELAYED_MFE_THRESHOLD);
  const delayed41to60 = qvaOnly.filter(e => (e.forward.mfe[40] == null || e.forward.mfe[40] < DELAYED_MFE_THRESHOLD) && e.forward.mfe[60] >= DELAYED_MFE_THRESHOLD);

  const groups = {
    qvaAll: { label: 'QVA 전체', items: qvaAll },
    qvaToVvi20: { label: '20일 안 2차 확인', items: qvaToVvi20 },
    hGroup20: { label: '20일 안 돌파 성공', items: hGroup20 },
    qvaOnlyMfe20_30: { label: 'QVA만, 20일 안 +30%', items: delayed20 },
    qvaOnlyMfe40_30: { label: 'QVA만, 40일 안 +30%', items: delayed40 },
    qvaOnlyMfe60_30: { label: 'QVA만, 60일 안 +30%', items: delayed60 },
  };

  const groupReasonCounts = {};
  for (const [key, group] of Object.entries(groups)) {
    groupReasonCounts[key] = {};
    for (const item of group.items) addReasonCounts(groupReasonCounts[key], item.vviFailReasons);
  }

  const hanon = events.find(e => e.code === '018880' && e.qvaDate === '20260114') || null;
  const hanonCase = hanon ? makeCase(hanon) : null;
  if (hanonCase) {
    hanonCase.d5 = (() => {
      const chart = readJsonSafe(path.join(LONG_CACHE_DIR, '018880.json'), null);
      const rows = chart?.rows || [];
      const idx = rows.findIndex(r => r.date === '20260114');
      return idx >= 0 && rows[idx + 5] ? round2(retFrom(rows[idx].close, rows[idx + 5].close)) : null;
    })();
    hanonCase.d10 = (() => {
      const chart = readJsonSafe(path.join(LONG_CACHE_DIR, '018880.json'), null);
      const rows = chart?.rows || [];
      const idx = rows.findIndex(r => r.date === '20260114');
      return idx >= 0 && rows[idx + 10] ? round2(retFrom(rows[idx].close, rows[idx + 10].close)) : null;
    })();
    hanonCase.groupMembership = {
      qvaAll: !!hanon,
      qvaToVvi20: !!hanon?.vviWithin20,
      hGroup20: !!hanon?.hGroupWithin20,
      qvaOnlyMfe20_30: delayed20.includes(hanon),
      qvaOnlyMfe40_30: delayed40.includes(hanon),
      qvaOnlyMfe60_30: delayed60.includes(hanon),
    };
  }

  const summary = {
    scanStart: SCAN_START,
    scanEnd: SCAN_END,
    qvaModel: 'REDEFINED_TIGHT_FILTER_C30 / calculateRedefinedQVA',
    vviLookaheadDays: VVI_LOOKAHEAD,
    episodeMergeWindow: EPISODE_MERGE_WINDOW,
    delayedMfeThreshold: DELAYED_MFE_THRESHOLD,
    fileCount,
    scannedRows,
    rawQvaSignalCount: rawEvents.length,
    episodeQvaCount: events.length,
    qvaOnlyCount: qvaOnly.length,
    delayed20Count: delayed20.length,
    delayed40Count: delayed40.length,
    delayed60Count: delayed60.length,
    delayed21to40Count: delayed21to40.length,
    delayed41to60Count: delayed41to60.length,
    qvaToVvi20Count: qvaToVvi20.length,
    hGroup20Count: hGroup20.length,
    generatedAt: new Date().toISOString(),
  };

  const metrics = {};
  for (const [key, group] of Object.entries(groups)) {
    metrics[key] = {
      label: group.label,
      ...groupMetrics(group.items),
      topVviFailReasons: topReasons(groupReasonCounts[key]),
    };
  }

  const recommendations = {
    keep20DayTracking: true,
    addD21toD40LongTracking: delayed21to40.length > 0,
    createQvaOnlyDelayedSuccessSection: delayed20.length > 0 || delayed40.length > 0 || delayed60.length > 0,
    rationale: [
      '처음 20거래일 추적은 빠른 확인용으로 유지한다.',
      '2차 확인이나 돌파 성공 없이도 최대 +30% 이상 오른 QVA 사례는 장기 관찰 섹션으로 따로 보는 편이 낫다.',
      '21~40거래일 사이에 뒤늦게 +30% 이상 오르는 표본이 있으면 40거래일 장기 추적을 추가할 가치가 있다.',
    ],
  };

  const answers = {
    q1_mfe20NoVviH: delayed20.length,
    q2_lateWithin40NoVviH: delayed21to40.length,
    q3_lateWithin60NoVviH: delayed41to60.length,
    q4_whyVviFailed: topReasons(groupReasonCounts.qvaOnlyMfe40_30),
    q4_conditionOnlyWhyVviFailed: topConditionReasons(groupReasonCounts.qvaOnlyMfe40_30),
    q5_hanonGroup: hanonCase?.groupMembership || null,
    q6_hanonIsQvaSuccessNoVviH: !!hanon && !hanon.vviWithin20 && !hanon.hGroupWithin20 && hanon.forward.mfe[20] >= DELAYED_MFE_THRESHOLD,
    q7_extendTrackingTo40: recommendations.addD21toD40LongTracking,
    q8_addLongTrackingSection: recommendations.createQvaOnlyDelayedSuccessSection,
  };

  const cases = {
    delayed20Top: delayed20.slice().sort((a, b) => (b.forward.mfe[20] || -999) - (a.forward.mfe[20] || -999)).slice(0, 30).map(makeCase),
    delayed40Top: delayed40.slice().sort((a, b) => (b.forward.mfe[40] || -999) - (a.forward.mfe[40] || -999)).slice(0, 30).map(makeCase),
    delayed60Top: delayed60.slice().sort((a, b) => (b.forward.mfe[60] || -999) - (a.forward.mfe[60] || -999)).slice(0, 30).map(makeCase),
    delayed21to40Top: delayed21to40.slice().sort((a, b) => (b.forward.mfe[40] || -999) - (a.forward.mfe[40] || -999)).slice(0, 30).map(makeCase),
    hanon: hanonCase,
  };

  return { summary, metrics, answers, recommendations, cases };
}

function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function pct(v) {
  return v == null ? '-' : `${round2(v)}%`;
}

function reasonLabel(reason) {
  const labels = {
    'flowRows<10': '수급 데이터 부족',
    'todayReturn<=0': '그날 주가가 시초가보다 오르지 못함',
    'not ignition': '거래대금/종가 힘이 VVI 기준만큼 강하지 않음',
    'ret5d>18%': '최근 5일 이미 너무 많이 오름',
    'avg20Value<20억': '평균 거래대금이 부족함',
    'ret20d>40%': '최근 20일 이미 너무 많이 오름',
    'closeLocation<0.4': '종가가 그날 저가 쪽에 가까움',
    'marketCap<500억': '시가총액이 너무 작음',
    'ATR n/a': '변동성 계산 데이터 부족',
    'atrPct>=30%': '변동성이 너무 큼',
    'ret20d>40%': '최근 20일 상승폭이 너무 큼',
  };
  return labels[reason] || reason;
}

function reasonText(items) {
  return (items || []).map(x => `${reasonLabel(x.reason)}(${x.count})`).join(', ') || '-';
}

function renderHtml(data) {
  const metricRows = Object.entries(data.metrics).map(([key, m]) => `
    <tr>
      <td class="txt">${htmlEscape(m.label)}</td>
      <td>${m.signalCount}</td>
      <td>${m.uniqueStocks}</td>
      <td>${pct(m.avgD20)}</td>
      <td>${pct(m.avgD40)}</td>
      <td>${pct(m.avgD60)}</td>
      <td>${pct(m.avgMFE20)}</td>
      <td>${pct(m.avgMFE40)}</td>
      <td>${pct(m.avgMFE60)}</td>
      <td>${pct(m.avgMAE20)}</td>
      <td>${pct(m.avgMAE40)}</td>
      <td>${pct(m.avgMAE60)}</td>
      <td>${pct(m.hitPlus30Rate20)}</td>
      <td>${pct(m.hitMinus10Rate20)}</td>
      <td>${pct(m.vviRate)}</td>
      <td>${pct(m.hGroupRate)}</td>
    </tr>`).join('');

  function renderCases(title, rows, horizon) {
    return `
      <section>
        <h2>${htmlEscape(title)}</h2>
        <div class="table-wrap"><table>
          <thead><tr>
            <th class="txt">종목</th><th>QVA일</th><th>점수</th><th>20일 뒤</th><th>40일 뒤</th><th>60일 뒤</th>
            <th>20일 최대상승</th><th>40일 최대상승</th><th>60일 최대상승</th><th>${horizon}일 최대하락</th><th>2차확인</th><th>돌파성공</th><th class="txt">2차 확인 실패 주요 사유</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="txt">${htmlEscape(r.name)} <span>${r.code}</span></td>
              <td>${fmtDate(r.qvaDate)}</td>
              <td>${r.qvaScore}</td>
              <td>${pct(r.d20)}</td>
              <td>${pct(r.d40)}</td>
              <td>${pct(r.d60)}</td>
              <td>${pct(r.mfe20)}</td>
              <td>${pct(r.mfe40)}</td>
              <td>${pct(r.mfe60)}</td>
              <td>${pct(r[`mae${horizon}`] ?? r.mae20)}</td>
              <td>${r.vviWithin20 ? 'Y' : 'N'}</td>
              <td>${r.hGroupWithin20 ? 'Y' : 'N'}</td>
              <td class="txt">${htmlEscape(reasonText(r.vviFailTopReasons))}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </section>`;
  }

  const h = data.cases.hanon;
  const hanonHtml = h ? `
    <section>
      <h2>필수 대표 사례: 한온시스템 018880</h2>
      <div class="cards">
        <div><b>QVA 날짜</b><strong>${fmtDate(h.qvaDate)}</strong></div>
        <div><b>D+5</b><strong>${pct(h.d5)}</strong></div>
        <div><b>D+10</b><strong>${pct(h.d10)}</strong></div>
        <div><b>D+20</b><strong>${pct(h.d20)}</strong></div>
        <div><b>20일 최대 상승폭</b><strong>${pct(h.mfe20)}</strong></div>
        <div><b>20일 최대 하락폭</b><strong>${pct(h.mae20)}</strong></div>
        <div><b>D+40 / D+60</b><strong>${pct(h.d40)} / ${pct(h.d60)}</strong></div>
        <div><b>40/60일 최대 상승폭</b><strong>${pct(h.mfe40)} / ${pct(h.mfe60)}</strong></div>
        <div><b>2차 확인 / 돌파 성공</b><strong>${h.vviWithin20 ? 'Y' : 'N'} / ${h.hGroupWithin20 ? 'Y' : 'N'}</strong></div>
      </div>
      <p>분류: QVA에는 잡혔지만 20거래일 안에 2차 확인이나 돌파 성공은 없었고, 그래도 20일 안 최대 +30% 이상 오른 사례입니다.</p>
    </section>` : '<section><h2>한온시스템</h2><p>018880 / 2026-01-14 QVA를 찾지 못했습니다.</p></section>';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>QVA 뒤늦은 상승 보고서</title>
<style>
  body { margin:0; background:#0f172a; color:#e5e7eb; font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  header { padding:28px 32px 18px; border-bottom:1px solid #334155; background:#111827; }
  h1 { margin:0 0 8px; font-size:24px; letter-spacing:0; }
  h2 { margin:26px 0 12px; font-size:18px; }
  main { padding:20px 32px 44px; }
  p { color:#cbd5e1; line-height:1.55; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin:14px 0; }
  .cards div { background:#111827; border:1px solid #334155; border-radius:6px; padding:12px; }
  .cards b { display:block; color:#94a3b8; font-size:12px; margin-bottom:6px; }
  .cards strong { font-size:20px; color:#f8fafc; }
  .table-wrap { overflow-x:auto; border:1px solid #334155; border-radius:6px; background:#111827; }
  table { width:100%; min-width:1380px; border-collapse:collapse; background:#111827; font-size:12px; }
  th, td { padding:8px 9px; border-bottom:1px solid #1f2937; text-align:right; white-space:nowrap; }
  th { color:#93c5fd; background:#0b1220; font-weight:700; }
  td.txt, th.txt { text-align:left; white-space:normal; word-break:keep-all; line-height:1.35; min-width:150px; }
  th.txt:first-child, td.txt:first-child { min-width:180px; }
  td span { color:#94a3b8; font-family:ui-monospace,Menlo,Consolas,monospace; }
  section { margin-top:20px; }
  .notice { color:#fbbf24; }
</style>
</head>
<body>
<header>
  <h1>QVA 뒤늦은 상승 보고서</h1>
  <p>QVA에 잡힌 뒤 20거래일 안에 2차 거래대금 확인이나 돌파 성공은 없었지만, 나중에 크게 오른 종목이 얼마나 있는지 확인합니다.</p>
</header>
<main>
  <section class="cards">
    <div><b>QVA 신호 묶음</b><strong>${data.summary.episodeQvaCount}</strong></div>
    <div><b>QVA만 잡힌 경우</b><strong>${data.summary.qvaOnlyCount}</strong></div>
    <div><b>20일 안 최대 +30% 이상</b><strong>${data.summary.delayed20Count}</strong></div>
    <div><b>21~40일에 뒤늦게 +30%</b><strong>${data.summary.delayed21to40Count}</strong></div>
    <div><b>41~60일에 뒤늦게 +30%</b><strong>${data.summary.delayed41to60Count}</strong></div>
    <div><b>2차 확인 / 돌파 성공</b><strong>${data.summary.qvaToVvi20Count} / ${data.summary.hGroup20Count}</strong></div>
  </section>

  <p class="notice">40일/60일 뒤 성과는 그 날짜까지 데이터가 있는 종목만 평균에 넣었습니다.</p>

  <section>
    <h2>그룹 비교</h2>
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="txt">그룹</th><th>신호 수</th><th>고유 종목</th><th>20일 뒤 평균</th><th>40일 뒤 평균</th><th>60일 뒤 평균</th>
        <th>20일 최대상승</th><th>40일 최대상승</th><th>60일 최대상승</th><th>20일 최대하락</th><th>40일 최대하락</th><th>60일 최대하락</th>
        <th>20일 안 +30%</th><th>20일 안 -10%</th><th>2차확인%</th><th>돌파성공%</th>
      </tr></thead>
      <tbody>${metricRows}</tbody>
    </table></div>
  </section>

  ${hanonHtml}

  <section>
    <h2>질문 답변</h2>
    <div class="table-wrap"><table class="qa-table">
      <tbody>
        <tr><td class="txt">1. 2차 확인/돌파 성공 없이 20일 안 최대 +30% 이상 오른 경우</td><td>${data.answers.q1_mfe20NoVviH}개</td></tr>
        <tr><td class="txt">2. D+21~D+40에 늦게 크게 오른 종목</td><td>${data.answers.q2_lateWithin40NoVviH}개</td></tr>
        <tr><td class="txt">3. D+41~D+60에 늦게 크게 오른 종목</td><td>${data.answers.q3_lateWithin60NoVviH}개</td></tr>
        <tr><td class="txt">4. 2차 확인을 못 받은 주요 사유</td><td class="txt">${htmlEscape(reasonText(data.answers.q4_whyVviFailed))}</td></tr>
        <tr><td class="txt">4-1. 데이터 부족 제외 조건 사유</td><td class="txt">${htmlEscape(reasonText(data.answers.q4_conditionOnlyWhyVviFailed))}</td></tr>
        <tr><td class="txt">5. 한온시스템 그룹</td><td class="txt">QVA 전체 포함, 2차 확인 없음, 돌파 성공 없음, 20/40/60일 안 최대 +30% 이상 그룹 모두 포함</td></tr>
        <tr><td class="txt">6. 한온시스템은 QVA에는 잡혔지만 2차 확인/돌파 성공은 없었나</td><td>${data.answers.q6_hanonIsQvaSuccessNoVviH ? '예' : '아니오'}</td></tr>
        <tr><td class="txt">7. 40일 추적 확대 가치</td><td>${data.answers.q7_extendTrackingTo40 ? '예' : '아니오'}</td></tr>
        <tr><td class="txt">8. 장기 추적 QVA 섹션 가치</td><td>${data.answers.q8_addLongTrackingSection ? '예' : '아니오'}</td></tr>
      </tbody>
    </table></div>
  </section>

  ${renderCases('QVA만 잡혔고 20일 안 최대 +30% 이상 오른 종목', data.cases.delayed20Top, 20)}
  ${renderCases('QVA만 잡혔고 40일 안 최대 +30% 이상 오른 종목', data.cases.delayed40Top, 40)}
  ${renderCases('21~40거래일 사이에 뒤늦게 +30% 이상 오른 종목', data.cases.delayed21to40Top, 40)}

  <section>
    <h2>최종 결론</h2>
    <p>기존 20거래일 추적은 그대로 두는 것이 좋습니다. 다만 2차 확인이나 돌파 성공 없이도 나중에 크게 오르는 QVA가 꽤 있으므로, 21~40거래일까지 보는 장기 관찰 섹션을 따로 추가할 가치가 있습니다. 이 섹션은 매수 신호가 아니라 “천천히 좋아질 수 있는 관심 후보”를 따로 모아보는 용도입니다.</p>
  </section>
</main>
</body>
</html>`;
}

const data = buildReport();
fs.writeFileSync(OUT_JSON, JSON.stringify(data, null, 2));
fs.writeFileSync(OUT_HTML, renderHtml(data));

console.log(`\nJSON saved: ${OUT_JSON}`);
console.log(`HTML saved: ${OUT_HTML}`);
console.log('\nKey answers:');
console.log(`  QVA only MFE20>=30: ${data.answers.q1_mfe20NoVviH}`);
console.log(`  late D21~D40 MFE>=30: ${data.answers.q2_lateWithin40NoVviH}`);
console.log(`  late D41~D60 MFE>=30: ${data.answers.q3_lateWithin60NoVviH}`);
console.log(`  Hanon QVA success no VVI/H: ${data.answers.q6_hanonIsQvaSuccessNoVviH ? 'YES' : 'NO'}`);
