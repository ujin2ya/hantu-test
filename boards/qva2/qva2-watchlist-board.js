#!/usr/bin/env node
/**
 * QVA2 Watchlist Board — H그룹/VPR 보드의 QVA2 버전 (실험)
 *
 * 기존 /qva-watchlist (qva-watchlist-board.js) 와 동일한 funnel 구조이지만
 * 입력 신호가 QVA2 (qva2-screener.js의 calculateQVA2)이다. 기존 라인은 무수정.
 *
 * 메인 단계 (mutually exclusive 스냅샷 상태):
 *   - QVA2_NEW          : 오늘 (D=0) QVA2 발생
 *   - QVA2_TRACKING     : D+1 ~ D+20, VVI2 미발생, 미이탈
 *   - VVI2_FIRED        : 가장 최근 거래일이 VVI2 발생일 (내일 돌파 결과 봐야 함)
 *   - BREAKOUT_SUCCESS  : VVI2 다음 거래일 돌파 성공 (close > VVI2 high), 최근 5거래일까지 표시
 *   - FAILED            : 종가 ≤ 신호가 × 0.85, D+20 만료, 또는 돌파 실패 — 최근 5거래일까지만
 *
 * 보조 태그 (다중 적용):
 *   - PRICE_HOLD          : 현재 종가 ≥ 신호가 × 0.95
 *   - LOW_RISING          : min(low 최근 5일) > min(low 그 이전 5일)
 *   - VALUE_REACTIVATION  : avg value 최근 3일 ≥ 신호 직전 20일 평균 × 1.5
 *
 * 입력: cache/stock-charts-long, cache/naver-stocks-list.json
 * 출력: reports/qva2-watchlist-board.{json,html} (downstream qva2-vvi-board / qva2-d5-rebreak-board 가 읽음)
 * 라우트: GET /qva2-watchlist
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { calculateQVA2, findVvi2AfterQva2, QVA2_CONFIG } = require('./qva2-screener');

const ROOT = path.join(__dirname, '..', '..');
const CHART_DIR    = path.join(ROOT, 'cache', 'stock-charts-long');
const NAVER_LIST   = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const REPORTS_DIR  = path.join(ROOT, 'reports');
const OUT_JSON     = path.join(REPORTS_DIR, 'qva2-watchlist-board.json');
const OUT_HTML     = path.join(REPORTS_DIR, 'qva2-watchlist-board.html');

const TRACKING_DAYS = 30;            // 20 → 30 (D+21~30은 "연장 추적 구간" 태그)
const TRACKING_DAYS_PRIMARY = 20;     // D+20까지가 일반 추적, D+21~30은 연장
const RECENT_BREAKOUT_DAYS = 5;
const RECENT_FAILED_DAYS = 5;
const EXIT_THRESHOLD_PCT = -15;     // -15% 이탈 시 FAILED
const MAX_MARKETCAP = Number(process.env.QVA2_MAX_MARKETCAP || 5e12);

function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}
function round2(v) { return v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100; }

function loadMetaMap() {
  if (!fs.existsSync(NAVER_LIST)) return new Map();
  try {
    const j = JSON.parse(fs.readFileSync(NAVER_LIST, 'utf-8'));
    const m = new Map();
    for (const s of (j.stocks || [])) {
      if (!s.code) continue;
      m.set(s.code, { code: s.code, name: s.name, market: s.market, marketValue: s.marketValue || 0, isEtf: !!s.isEtf, isSpecial: !!s.isSpecial });
    }
    return m;
  } catch (_) { return new Map(); }
}

const { filterRowsAsOf } = require('../../src/db/asOfChart');
function loadChart(code) {
  const fp = path.join(CHART_DIR, code + '.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (j && j.rows) j.rows = filterRowsAsOf(j.rows);
    return j;
  } catch (_) { return null; }
}

function determineBaseDate(metaMap, codes) {
  const dateFreq = new Map();
  const sample = codes.slice(0, Math.min(codes.length, 800));
  for (const code of sample) {
    const c = loadChart(code);
    if (c && c.rows && c.rows.length) {
      const d = c.rows[c.rows.length - 1].date;
      dateFreq.set(d, (dateFreq.get(d) || 0) + 1);
    }
  }
  let best = null, max = 0;
  for (const [d, n] of dateFreq) { if (n > max) { max = n; best = d; } }
  return best;
}

function buildAuxTags(rows, qva2Idx, todayIdx, signalPrice, currentClose) {
  const auxTags = [];
  if (currentClose >= signalPrice * 0.95) auxTags.push('PRICE_HOLD');
  if (todayIdx >= 9) {
    const last5 = rows.slice(todayIdx - 4, todayIdx + 1).map(r => r.low).filter(v => v > 0);
    const prev5 = rows.slice(todayIdx - 9, todayIdx - 4).map(r => r.low).filter(v => v > 0);
    if (last5.length === 5 && prev5.length === 5 && Math.min(...last5) > Math.min(...prev5)) {
      auxTags.push('LOW_RISING');
    }
  }
  if (todayIdx >= 2 && qva2Idx >= 1) {
    const last3 = rows.slice(todayIdx - 2, todayIdx + 1).map(r => r.valueApprox || 0);
    const last3Avg = last3.reduce((s, v) => s + v, 0) / 3;
    const baseStart = Math.max(0, qva2Idx - 19);
    const baseRows = rows.slice(baseStart, qva2Idx);
    const baseAvg = baseRows.length > 0
      ? baseRows.reduce((s, r) => s + (r.valueApprox || 0), 0) / baseRows.length
      : 0;
    if (baseAvg > 0 && last3Avg >= baseAvg * 1.5) auxTags.push('VALUE_REACTIVATION');
  }
  return auxTags;
}

/**
 * 한 종목에 대해 funnel 단계와 메타를 계산.
 * @returns {Object|null} { stage, ... } 또는 null (보드에서 제외 — 너무 오래된 후보 등)
 */
function analyzeStock(code, meta, rows, baseDate) {
  if (!Array.isArray(rows) || rows.length < 65) return null;
  const todayIdx = rows.findIndex(r => r.date === baseDate);
  if (todayIdx < 0) return null;
  const todayRow = rows[todayIdx];
  if (!todayRow.close || todayRow.close <= 0) return null;

  // 가장 최근 QVA2 신호 (TODAY 포함, 최대 D+20 이전까지) — funnel anchor
  let qva2Idx = -1;
  let qva2Result = null;
  for (let k = 0; k <= TRACKING_DAYS; k++) {
    const idx = todayIdx - k;
    if (idx < 60) break;
    const r = calculateQVA2(rows, idx, meta, { maxMarketcap: MAX_MARKETCAP });
    if (r && r.passed) {
      qva2Idx = idx;
      qva2Result = r;
      break;
    }
  }
  if (qva2Idx < 0 || !qva2Result) return null;

  const qva2Date = rows[qva2Idx].date;
  const signalPrice = rows[qva2Idx].close;
  const daysSinceQva2 = todayIdx - qva2Idx;
  const qva2Type = qva2Result.qva2Type || 'absorption';

  // 이탈 검출 (close ≤ signal × (1 + EXIT_THRESHOLD_PCT / 100))
  let exited = false, exitDate = null;
  for (let k = 1; k <= daysSinceQva2; k++) {
    const r = rows[qva2Idx + k];
    if (r && r.close > 0 && r.close <= signalPrice * (1 + EXIT_THRESHOLD_PCT / 100)) {
      exited = true;
      exitDate = r.date;
      break;
    }
  }

  // VVI2 검출 (QVA2 이후, todayIdx까지만) — qva2Type별 다른 정의
  const vvi2 = findVvi2AfterQva2(rows.slice(0, todayIdx + 1), qva2Idx, daysSinceQva2, { qva2Type });
  const vvi2Idx = vvi2.vvi2Idx >= 0 ? vvi2.vvi2Idx : null;

  // 돌파 결과 (VVI2 다음 거래일 close > VVI2 high)
  let breakoutIdx = null, breakoutInfo = null;
  if (vvi2Idx != null && vvi2Idx + 1 <= todayIdx) {
    const next = rows[vvi2Idx + 1];
    const vviRow = rows[vvi2Idx];
    const triggered1Pct = next.high >= vviRow.high * 1.01;
    const closeAboveHigh = next.close > vviRow.high;
    breakoutIdx = vvi2Idx + 1;
    breakoutInfo = {
      date: next.date,
      vviHigh: vviRow.high,
      vviClose: vviRow.close,
      vviLow: vviRow.low,
      nextHigh: next.high,
      nextClose: next.close,
      entryPrice1Pct: vviRow.high * 1.01,
      triggered1Pct,
      breakoutSuccess: closeAboveHigh,    // 종가 기준 돌파 성공 (단순 정의)
    };
  }

  // 메인 단계 결정
  let mainStage, stageReason = null;
  if (daysSinceQva2 === 0) {
    mainStage = 'QVA2_NEW';
  } else if (exited) {
    mainStage = 'FAILED';
    stageReason = `${fmtDate(exitDate)} 종가 -15% 이탈`;
  } else if (vvi2Idx != null) {
    if (vvi2Idx === todayIdx) {
      mainStage = 'VVI2_FIRED';
    } else if (breakoutInfo) {
      const daysSinceBreakout = todayIdx - breakoutIdx;
      if (breakoutInfo.breakoutSuccess) {
        if (daysSinceBreakout <= RECENT_BREAKOUT_DAYS) mainStage = 'BREAKOUT_SUCCESS';
        else if (daysSinceQva2 <= TRACKING_DAYS) mainStage = 'QVA2_TRACKING';
        else return null;
      } else {
        if (daysSinceBreakout <= RECENT_FAILED_DAYS) {
          mainStage = 'FAILED';
          stageReason = `${fmtDate(breakoutInfo.date)} 돌파 실패 (다음 종가 < VVI2 고가)`;
        } else if (daysSinceQva2 <= TRACKING_DAYS) {
          // BREAKOUT 실패 후 5일 지났더라도 QVA2 신호는 여전히 유효 (장기 관찰).
          mainStage = 'QVA2_TRACKING';
        } else {
          return null;
        }
      }
    } else {
      mainStage = 'VVI2_FIRED';
    }
  } else {
    if (daysSinceQva2 >= TRACKING_DAYS) {
      mainStage = 'FAILED';
      stageReason = `D+${TRACKING_DAYS} 만료, VVI2 미발생`;
    } else {
      mainStage = 'QVA2_TRACKING';
    }
  }

  // 진입 판단 상태 (BREAKOUT_SUCCESS 그룹용)
  let judgmentStatus = null, currentReturnFromEntry = null, daysFromBreakout = null;
  if (mainStage === 'BREAKOUT_SUCCESS' && breakoutInfo) {
    const entryPrice = breakoutInfo.entryPrice1Pct;
    const c = todayRow.close;
    daysFromBreakout = todayIdx - breakoutIdx;
    currentReturnFromEntry = ((c - entryPrice) / entryPrice) * 100;
    if (c < entryPrice || c < breakoutInfo.vviHigh) judgmentStatus = 'BREAKDOWN_WEAK';
    else if (c >= entryPrice * 1.15) judgmentStatus = 'MANAGEMENT';
    else if (c > entryPrice * 1.07 || daysFromBreakout >= 3) judgmentStatus = 'PULLBACK_WAIT';
    else if (c > entryPrice * 1.03) judgmentStatus = 'CHASE_CAUTION';
    else judgmentStatus = 'REVIEW_OK';
  }

  const currentClose = todayRow.close;
  const currentReturnFromSignal = ((currentClose / signalPrice) - 1) * 100;
  const auxTags = buildAuxTags(rows, qva2Idx, todayIdx, signalPrice, currentClose);

  // ─── QVA2 후속 반응 평가 (장기 관찰 태그) ─────────────────────────────────
  // 새 모델이 아니라 QVA2_TRACKING 안에서 부착되는 태그.
  //   조건: D+1~D+30, qva2Close 위에서 유지, qva2Close × 0.95 이상, 거래대금/거래량 재증가, 너무 멀리 안 감.
  //   결과: hasFollowReaction = true 시 "QVA2 이후 재반응" + "거래대금 재증가" 태그 부착.
  let followInfo = null;
  let hasFollowReaction = false;
  if (daysSinceQva2 >= 1 && daysSinceQva2 <= TRACKING_DAYS) {
    const qva2Row = rows[qva2Idx];
    const qva2Close = qva2Row.close;
    const qva2High = qva2Row.high;
    const qva2Volume = qva2Row.volume || 0;
    const qva2Value = qva2Row.valueApprox || 0;
    const todayValue = todayRow.valueApprox || (currentClose * (todayRow.volume || 0)) || 0;
    const todayVolume = todayRow.volume || 0;

    // 직전 20일 (오늘 제외) median 거래대금/거래량 — today 시점
    const prev20 = rows.slice(Math.max(0, todayIdx - 20), todayIdx);
    function medianLocal(arr) {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const n = s.length;
      return n % 2 === 0 ? (s[n / 2 - 1] + s[n / 2]) / 2 : s[Math.floor(n / 2)];
    }
    const median20Vol = medianLocal(prev20.map(r => r.volume || 0));
    const median20Val = medianLocal(prev20.map(r => r.valueApprox || 0));
    const todayValueRatio = median20Val > 0 ? todayValue / median20Val : 0;
    const todayVolumeRatio = median20Vol > 0 ? todayVolume / median20Vol : 0;

    // 60일 고점 거리 (today 시점)
    const last60 = rows.slice(Math.max(0, todayIdx - 59), todayIdx + 1);
    const high60Today = Math.max(...last60.map(r => r.high));
    const distanceFromHigh60 = high60Today > 0 ? ((high60Today - currentClose) / high60Today) * 100 : 0;

    const notBrokenAfterQVA2 = currentClose >= qva2Close * 0.95;
    const aboveQVA2Close     = currentClose >= qva2Close;
    const valueReInflow      = todayValueRatio >= 2.0  || todayValue  >= qva2Value  * 0.8;
    const volumeAlive        = todayVolumeRatio >= 1.5 || todayVolume >= qva2Volume * 0.8;
    const notTooExtended     = currentClose <= qva2Close * 1.70;

    hasFollowReaction = notBrokenAfterQVA2 && aboveQVA2Close && valueReInflow && volumeAlive && notTooExtended;

    if (hasFollowReaction) {
      auxTags.push('QVA2 이후 재반응');
      auxTags.push('거래대금 재증가');
    }
    if (daysSinceQva2 > TRACKING_DAYS_PRIMARY && daysSinceQva2 <= TRACKING_DAYS) {
      auxTags.push('연장 추적 구간');
    }
    if (distanceFromHigh60 < 10) {
      auxTags.push('추격 위험 높음');
    } else if (distanceFromHigh60 < 15) {
      auxTags.push('고점 근처 주의');
    }

    followInfo = {
      hasFollowReaction,
      daysSinceQva2,
      qva2Close, qva2High, qva2Volume, qva2Value,
      closeVsQva2ClosePct:     +(((currentClose / qva2Close) - 1) * 100).toFixed(2),
      highVsQva2HighPct:       qva2High > 0 ? +(((todayRow.high / qva2High) - 1) * 100).toFixed(2) : null,
      valueVsQva2ValueRatio:   qva2Value > 0  ? +(todayValue  / qva2Value).toFixed(2)  : null,
      volumeVsQva2VolumeRatio: qva2Volume > 0 ? +(todayVolume / qva2Volume).toFixed(2) : null,
      todayValueRatio: +todayValueRatio.toFixed(2),
      todayVolumeRatio: +todayVolumeRatio.toFixed(2),
      distanceFromHigh60: +distanceFromHigh60.toFixed(2),
      reasons: {
        notBrokenAfterQVA2, aboveQVA2Close, valueReInflow, volumeAlive, notTooExtended,
      },
    };
  }

  // 추가 신호
  const riskTag = currentReturnFromSignal <= -5;
  const expiringSoon = daysSinceQva2 >= 15;
  let _ws = (auxTags.length || 0) * 25;
  if (currentReturnFromSignal >= 5) _ws += 15;
  else if (currentReturnFromSignal >= 0) _ws += 10;
  else if (currentReturnFromSignal <= -5) _ws -= 15;
  if (expiringSoon) _ws -= 10;
  if (daysSinceQva2 <= 5) _ws += 5;
  // follow reaction 후보는 우선 노출
  if (hasFollowReaction) _ws += 30;
  const watchScore = Math.max(0, Math.min(100, Math.round(_ws)));

  return {
    code, name: meta.name, market: meta.market, isPreferred: false, marketValue: meta.marketValue,

    qva2SignalDate: qva2Date,
    qva2SignalPrice: signalPrice,
    qva2Type: qva2Type,
    qva2Score: qva2Result.score,
    qva2Grade: qva2Result.grade,
    qva2GradeLabel: qva2Result.gradeLabel,
    qva2Tags: qva2Result.tags,
    qva2Signals: qva2Result.signals,
    daysSinceQva2,

    currentDate: baseDate,
    currentClose,
    currentVolume: todayRow.volume,
    currentValue: todayRow.valueApprox || todayRow.close * todayRow.volume,
    currentReturnFromSignal: round2(currentReturnFromSignal),

    vvi2Date: vvi2Idx != null ? rows[vvi2Idx].date : null,
    vvi2High: vvi2Idx != null ? rows[vvi2Idx].high : null,
    vvi2Close: vvi2Idx != null ? rows[vvi2Idx].close : null,
    vvi2Low:   vvi2Idx != null ? rows[vvi2Idx].low  : null,
    daysSinceVvi2: vvi2Idx != null ? todayIdx - vvi2Idx : null,

    breakoutDate: breakoutInfo?.date || null,
    breakoutVviHigh: breakoutInfo?.vviHigh || null,
    breakoutEntryPrice1Pct: breakoutInfo ? round2(breakoutInfo.entryPrice1Pct) : null,
    breakoutNextHigh: breakoutInfo?.nextHigh || null,
    breakoutNextClose: breakoutInfo?.nextClose || null,
    breakoutSuccess: breakoutInfo?.breakoutSuccess ?? null,
    daysFromBreakout,
    currentReturnFromEntry: round2(currentReturnFromEntry),
    judgmentStatus,

    mainStage, stageReason, auxTags,
    riskTag, expiringSoon, watchScore,
    // QVA2 후속 반응 (장기 관찰 태그)
    hasFollowReaction,
    followInfo,
  };
}

async function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`\n📊 QVA2 Watchlist Board (H그룹/VPR mirror, max marketcap ${(MAX_MARKETCAP / 1e12).toFixed(1)}조)`);

  const metaMap = loadMetaMap();
  const codes = fs.readdirSync(CHART_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  console.log(`  스캔 대상: ${codes.length}개 chart`);

  const baseDate = determineBaseDate(metaMap, codes);
  console.log(`  분석 기준일: ${baseDate ? fmtDate(baseDate) : '-'}`);

  const candidates = [];
  let scanned = 0, etfFiltered = 0, capFiltered = 0, chartShort = 0;
  for (const code of codes) {
    const meta = metaMap.get(code);
    if (!meta) continue;
    if (meta.isEtf || meta.isSpecial) { etfFiltered++; continue; }
    if (!meta.marketValue || meta.marketValue > MAX_MARKETCAP) { capFiltered++; continue; }
    const chart = loadChart(code);
    if (!chart || !chart.rows || chart.rows.length < 65) { chartShort++; continue; }
    scanned++;
    const r = analyzeStock(code, meta, chart.rows, baseDate);
    if (r) candidates.push(r);
  }
  console.log(`  scanned=${scanned}, etf/special=${etfFiltered}, capFiltered=${capFiltered}, chartShort=${chartShort}`);
  console.log(`  funnel candidates: ${candidates.length}건`);

  // 단계별 분류
  const stages = { QVA2_NEW: [], QVA2_TRACKING: [], VVI2_FIRED: [], BREAKOUT_SUCCESS: [], FAILED: [] };
  for (const c of candidates) (stages[c.mainStage] || (stages[c.mainStage] = [])).push(c);

  // 정렬 — 운영 보드 spec
  stages.QVA2_NEW.sort((a, b) => (b.qva2Score || 0) - (a.qva2Score || 0));
  // QVA2_TRACKING 정렬: 후속 반응 후보를 상단으로
  stages.QVA2_TRACKING.sort((a, b) => {
    const af = a.hasFollowReaction ? 1 : 0;
    const bf = b.hasFollowReaction ? 1 : 0;
    if (af !== bf) return bf - af;
    return (b.watchScore - a.watchScore) || (a.daysSinceQva2 - b.daysSinceQva2);
  });
  stages.VVI2_FIRED.sort((a, b) => (b.qva2Score || 0) - (a.qva2Score || 0));
  stages.BREAKOUT_SUCCESS.sort((a, b) => {
    const aBd = a.breakoutDate || '', bBd = b.breakoutDate || '';
    if (bBd !== aBd) return bBd.localeCompare(aBd);
    return (a.daysFromBreakout || 999) - (b.daysFromBreakout || 999);
  });
  stages.FAILED.sort((a, b) => (b.currentReturnFromSignal || -999) - (a.currentReturnFromSignal || -999));

  // QVA2_TRACKING 안의 follow reaction / 연장 추적 / 고점 근처 카운트
  const trackingFollowCount = stages.QVA2_TRACKING.filter(c => c.hasFollowReaction).length;
  const trackingExtendedCount = stages.QVA2_TRACKING.filter(c => c.daysSinceQva2 > TRACKING_DAYS_PRIMARY).length;
  const trackingNearHighCount = stages.QVA2_TRACKING.filter(c => (c.followInfo && c.followInfo.distanceFromHigh60 != null && c.followInfo.distanceFromHigh60 < 15)).length;

  const counts = {
    total: candidates.length,
    QVA2_NEW:         stages.QVA2_NEW.length,
    QVA2_TRACKING:    stages.QVA2_TRACKING.length,
    QVA2_TRACKING_followReaction: trackingFollowCount,
    QVA2_TRACKING_extended:       trackingExtendedCount,
    QVA2_TRACKING_nearHigh:       trackingNearHighCount,
    VVI2_FIRED:       stages.VVI2_FIRED.length,
    BREAKOUT_SUCCESS: stages.BREAKOUT_SUCCESS.length,
    FAILED:           stages.FAILED.length,
  };

  // QVA2_TRACKING 안에서 후속 반응 후보를 별도 list로 분리해 노출
  const followReactionList = stages.QVA2_TRACKING.filter(c => c.hasFollowReaction);

  const out = {
    meta: {
      title: 'QVA2 — 고점 대비 많이 내려온 뒤 돈이 다시 들어온 후보',
      subtitle: '최근 고점 대비 충분히 내려온 자리에서, 거래량과 거래대금이 평소보다 크게 늘어난 종목입니다. 정확한 저점을 맞히는 신호가 아니라, 다시 관심이 들어오기 시작했는지 확인하기 위한 관찰 후보입니다.',
      caution: 'QVA2는 매수 확정 신호가 아닙니다. 최근 고점 대비 많이 내려온 자리에서 돈이 다시 들어온 흔적을 찾는 관찰용 신호입니다. 저점을 정확히 맞히는 모델이 아닙니다.',
      generatedAt: new Date().toISOString(),
      baseDate, baseDateFmt: baseDate ? fmtDate(baseDate) : null,
      trackingDays: TRACKING_DAYS,
      recentBreakoutDays: RECENT_BREAKOUT_DAYS,
      recentFailedDays: RECENT_FAILED_DAYS,
      exitThresholdPct: EXIT_THRESHOLD_PCT,
      maxMarketcap: MAX_MARKETCAP,
      qva2Thresholds: QVA2_CONFIG,
    },
    counts,
    stages,
    followReactionList,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_HTML, buildHtml(out), 'utf-8');

  // DB 저장 (실패해도 HTML/JSON은 정상)
  try {
    const { saveQva2WatchlistBoardToDB } = require('../../src/db/saveBoardSignals');
    const r = await saveQva2WatchlistBoardToDB(out, { jsonPath: OUT_JSON, htmlPath: OUT_HTML });
    if (r) console.log(`  🗄  DB 저장: runId=${r.runId} rows=${r.totalRows} (inserted=${r.inserted} updated=${r.updated})`);
  } catch (e) {
    console.warn(`  ⚠ DB 저장 실패 (HTML/JSON은 정상 저장됨): ${e.message}`);
  } finally {
    try { await require('../../src/db/mysql').closePool(); } catch (_) {}
  }

  console.log(`\n  단계별:`);
  console.log(`    🟢 QVA2_NEW:         ${counts.QVA2_NEW}건`);
  console.log(`    📋 QVA2_TRACKING:    ${counts.QVA2_TRACKING}건`);
  console.log(`    🔥 VVI2_FIRED:       ${counts.VVI2_FIRED}건`);
  console.log(`    💥 BREAKOUT_SUCCESS: ${counts.BREAKOUT_SUCCESS}건 (최근 ${RECENT_BREAKOUT_DAYS}일)`);
  console.log(`    ❌ FAILED:           ${counts.FAILED}건 (최근 ${RECENT_FAILED_DAYS}일)`);
  if (stages.BREAKOUT_SUCCESS.length > 0) {
    console.log(`\n  ── BREAKOUT_SUCCESS 상위 ${Math.min(8, stages.BREAKOUT_SUCCESS.length)} ──`);
    for (const e of stages.BREAKOUT_SUCCESS.slice(0, 8)) {
      console.log(`    ${fmtDate(e.qva2SignalDate)} → VVI2 ${fmtDate(e.vvi2Date)} → 돌파 ${fmtDate(e.breakoutDate)} (D+${e.daysFromBreakout}) | ${e.code} ${(e.name || '').padEnd(12)} | 진입가 ${e.breakoutEntryPrice1Pct} → 현재 ${(e.currentReturnFromEntry || 0).toFixed(1)}% [${e.judgmentStatus}]`);
    }
  }
  console.log(`  elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`✅ JSON: ${OUT_JSON}`);
  console.log(`✅ HTML: ${OUT_HTML}`);
}

function buildHtml(data) {
  return HTML_TEMPLATE.replace('__JSON_DATA__', JSON.stringify(data));
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>QVA2 — 고점 대비 많이 내려온 뒤 돈이 다시 들어온 후보</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 18px 24px 80px; max-width: 1500px;
  font-family: -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  background: #0f172a; color: #e2e8f0; font-size: 13px;
}
nav.boards { display:flex; gap:6px; flex-wrap:wrap; padding:8px 0 14px; border-bottom:1px solid #1e293b; margin-bottom:14px; align-items:center; }
nav.boards .group-label { font-size:11px; color:#64748b; padding:4px 8px 4px 0; font-weight:600; letter-spacing:0.4px; text-transform:uppercase; }
nav.boards a { color:#94a3b8; text-decoration:none; font-size:12px; padding:5px 10px; border-radius:6px; border:1px solid transparent; }
nav.boards a:hover { color:#e2e8f0; background:#1e293b; }
nav.boards a.live { border-color:#1e293b; }
nav.boards a.experiment { border-color:#7c3aed; color:#c4b5fd; background:#1e1b4b; }
nav.boards a.experiment:hover { background:#312e81; color:#e0e7ff; }
nav.boards a.active { background:#1e293b; color:#f1f5f9; border-color:#334155; }
nav.boards a.experiment.active { background:#312e81; color:#e0e7ff; border-color:#a78bfa; }
nav.boards .sep { color:#475569; padding:0 6px; }
h1 { font-size:22px; margin:6px 0 4px; color:#f1f5f9; font-weight:700; }
.exp-pill { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; background:#312e81; color:#c4b5fd; border:1px solid #6366f1; margin-left:8px; vertical-align:middle; font-weight:600; }
.subtitle { font-size:13px; color:#94a3b8; margin-bottom:12px; line-height:1.6; }
.purpose-box { background: #0f172a; border-left: 3px solid #a78bfa; padding: 12px 16px; border-radius: 6px; margin-bottom: 14px; line-height: 1.7; color: #cbd5e1; font-size: 13px; }
.purpose-box strong { color: #c4b5fd; }
.caution-box { background:#1f1b14; border-left:3px solid #fbbf24; padding:10px 14px; border-radius:6px; margin-bottom:14px; color:#fcd34d; font-size:12px; line-height:1.6; }
.funnel-chip { display:inline-block; text-decoration:none; padding:4px 10px; border-radius:5px; font-size:12px; font-weight:600; transition: transform 0.1s, filter 0.15s; }
.funnel-chip:hover { transform: translateY(-1px); filter: brightness(1.25); }
h2[id^="sec-"] { scroll-margin-top: 14px; }

.stage-row { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:10px; margin-bottom:18px; }
.stage-pill { background:#1e293b; border:1px solid #334155; border-radius:10px; padding:14px 14px; text-align:center; cursor:pointer; transition:all 0.15s; }
.stage-pill:hover { background:#293548; }
.stage-pill .lbl { font-size:11px; color:#94a3b8; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.3px; }
.stage-pill .cnt { font-size:26px; font-weight:700; color:#f1f5f9; font-variant-numeric:tabular-nums; }
.stage-pill .desc { font-size:10.5px; color:#64748b; margin-top:4px; }
.stage-pill.s-QVA2_NEW         { border-left:5px solid #22c55e; }
.stage-pill.s-FOLLOW           { border-left:5px solid #a78bfa; background:linear-gradient(135deg, #1e1b4b 0%, #1e293b 50%); }
.stage-pill.s-QVA2_TRACKING    { border-left:5px solid #94a3b8; }
.stage-pill.s-VVI2_FIRED       { border-left:5px solid #f97316; }
.stage-pill.s-BREAKOUT_SUCCESS { border-left:5px solid #14b8a6; background:linear-gradient(135deg, #042f2e 0%, #1e293b 50%); }
.stage-pill.s-FAILED           { border-left:5px solid #ef4444; }

h2 { font-size:16px; margin:22px 0 10px; color:#cbd5e1; }
h2 .count { font-size:13px; color:#64748b; font-weight:400; margin-left:6px; }

.card { background:#1e293b; border:1px solid #334155; border-radius:10px; padding:14px 16px; margin-bottom:10px; }
.card.s-QVA2_NEW         { border-left:6px solid #22c55e; background:linear-gradient(90deg, #052e16 0%, #1e293b 30%); }
.card.s-QVA2_TRACKING    { border-left:4px solid #94a3b8; }
.card.s-VVI2_FIRED       { border-left:5px solid #f97316; background:linear-gradient(90deg, #431407 0%, #1e293b 30%); }
.card.s-BREAKOUT_SUCCESS { border-left:6px solid #14b8a6; background:linear-gradient(90deg, #042f2e 0%, #1e293b 25%); }
.card.s-FAILED           { border-left:4px solid #ef4444; opacity:0.78; }
.card h3 { margin: 0 0 6px; font-size: 15px; color:#f1f5f9; font-weight:700; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.card h3 .code { color: #64748b; font-size: 12px; font-weight: 400; }
.card h3 .market { color:#94a3b8; font-size:11px; padding:1px 6px; border:1px solid #334155; border-radius:4px; }
.card h3 a.name-link { color:#f1f5f9; text-decoration:none; border-bottom:1px dashed transparent; }
.card h3 a.name-link:hover { color:#5eead4; border-bottom-color:#5eead4; }
.card h3 .grade-badge { font-size:11px; padding:2px 8px; border-radius:999px; font-weight:600; border:1px solid #7c3aed; background:#1e1b4b; color:#c4b5fd; }
.card h3 .judgment-badge { font-size:11px; padding:2px 8px; border-radius:999px; font-weight:600; border:1px solid; }
.judgment-REVIEW_OK      { background:#042f2e; color:#5eead4; border-color:#14b8a6; }
.judgment-CHASE_CAUTION  { background:#3f1d05; color:#fdba74; border-color:#f97316; }
.judgment-PULLBACK_WAIT  { background:#172554; color:#93c5fd; border-color:#3b82f6; }
.judgment-MANAGEMENT     { background:#1e1b4b; color:#c4b5fd; border-color:#7c3aed; }
.judgment-BREAKDOWN_WEAK { background:#7f1d1d; color:#fca5a5; border-color:#ef4444; }

.metrics-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(135px, 1fr)); gap:8px; margin:8px 0; }
.metric { background:#0f172a; border:1px solid #334155; border-radius:6px; padding:7px 10px; }
.metric .label { font-size:10px; color:#94a3b8; margin-bottom:2px; text-transform:uppercase; letter-spacing:0.3px; }
.metric .value { font-size:14px; font-weight:600; color:#e2e8f0; font-variant-numeric:tabular-nums; }
.cell-pos { color:#6ee7b7; }
.cell-neg { color:#fca5a5; }
.cell-warn { color:#fbbf24; }

.tags { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }
.tag { font-size:10.5px; padding:2px 7px; border-radius:999px; background:#1e293b; color:#94a3b8; border:1px solid #334155; }
.tag.aux { background:#1e1b4b; color:#c4b5fd; border-color:#6366f1; }
.tag.risk { background:#7f1d1d; color:#fca5a5; border-color:#ef4444; }
.tag.expiring { background:#3f1d05; color:#fdba74; border-color:#f97316; }

.stage-reason { font-size:11.5px; color:#fca5a5; padding:6px 10px; background:#0f172a; border:1px solid #7f1d1d; border-radius:5px; margin-top:6px; }

details.section { margin-bottom: 16px; }
details.section > summary { cursor: pointer; font-size: 14px; font-weight: 700; color: #cbd5e1; padding: 10px 14px; user-select: none; background: #0f172a; border-radius: 8px; border: 1px solid #1e293b; }
details.section > .section-body { padding: 12px 6px; }
.section-empty { padding:18px; background:#1e293b; border:1px dashed #475569; border-radius:8px; color:#64748b; text-align:center; font-size:12px; }

footer.foot { margin-top:30px; padding:14px; background:#1e293b; border-radius:8px; font-size:12px; color:#94a3b8; line-height:1.7; }
</style>
</head>
<body>
<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
  <div style="background:linear-gradient(90deg,#064e3b 0%,#065f46 100%);border:1px solid #10b981;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#a7f3d0;font-weight:700;letter-spacing:0.3px;">🟢 운영 보드</span><a href="/qva2-watchlist" style="color:#fff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.22);border:1px solid #fff;font-weight:700;">📋 H그룹/VPR</a><a href="/qva2-d5-rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파</a><a href="/qva2-vvi" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파</a></div>
  <div style="background:linear-gradient(90deg,#1e1b4b 0%,#312e81 100%);border:1px solid #6366f1;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#c4b5fd;font-weight:700;letter-spacing:0.3px;">🟣 실험 라인</span><a href="/one-day-surge-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">⚡ 1DS 단타 후보</a><a href="/nasdaq-theme-watch" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🌎 나스닥 테마 감시</a><a href="/qva-live-watch" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">⚡ QVA 장중 감시</a></div>
  <div style="background:linear-gradient(90deg,#1e293b 0%,#334155 100%);border:1px solid #64748b;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;opacity:0.92;"><span style="color:#cbd5e1;font-weight:700;letter-spacing:0.3px;">📜 과거 보드</span><a href="/qva-watchlist" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">📋 H그룹/VPR (구)</a><a href="/rebreak" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🔥 D+5 재돌파 (구)</a><a href="/qva-vvi-redefined-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🎯 고점 재돌파 (구)</a></div>
  <div style="background:linear-gradient(90deg,#042f2e 0%,#134e4a 100%);border:1px solid #14b8a6;border-radius:8px;padding:8px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;"><span style="color:#5eead4;font-weight:700;letter-spacing:0.3px;">📊 통합 보기</span><a href="/db-board" style="color:#e0e7ff;text-decoration:none;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,0.08);">🗄 DB 신호 운영판</a></div>
</div>

<h1>📋 QVA2 — 고점 대비 많이 내려온 뒤 돈이 다시 들어온 후보 <span class="exp-pill">실험 라인</span></h1>
<div class="subtitle" id="subtitle"></div>

<div class="purpose-box">
  최근 고점 대비 충분히 내려온 자리에서, 거래량과 거래대금이 평소보다 크게 늘어난 종목입니다. 정확한 저점을 맞히는 신호가 아니라, 다시 관심이 들어오기 시작했는지 확인하기 위한 관찰 후보입니다.
  <br><br>
  <strong>두 경로 (한 쪽 통과 시 QVA2):</strong>
  <ul style="margin:6px 0 0 0;padding-left:20px;line-height:1.7;color:#cbd5e1;">
    <li><strong>absorption</strong> — 마감은 약하지만 장중 저가에서 어느 정도 회복했고, 거래대금이 강하게 들어온 후보</li>
    <li><strong>spike</strong> — 고점 대비 많이 내려온 자리에서, 장중 강한 반응과 큰 거래대금이 함께 나온 후보</li>
  </ul>
  <br><br><span style="color:#94a3b8;font-size:12px;">흐름 (chip 클릭 = 해당 섹션으로 이동):</span><br>
  <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px;">
    <a href="#sec-new" class="funnel-chip" style="background:#052e16;border:1px solid #22c55e;color:#86efac;">🟢 확인 신규</a>
    <span style="color:#475569;">→</span>
    <a href="#sec-tr"  class="funnel-chip" style="background:#0f172a;border:1px solid #64748b;color:#cbd5e1;">📋 추적 중 (D+1~30)</a>
    <span style="color:#475569;">→</span>
    <a href="#sec-vvi" class="funnel-chip" style="background:#431407;border:1px solid #f97316;color:#fdba74;">🔥 다음 거래일 돌파 대기</a>
    <span style="color:#475569;">→</span>
    <a href="#sec-bk"  class="funnel-chip" style="background:#042f2e;border:1px solid #5eead4;color:#5eead4;">💥 돌파 성공 (H그룹)</a>
    <span style="color:#475569;">·또는·</span>
    <a href="#sec-fl"  class="funnel-chip" style="background:#450a0a;border:1px solid #fca5a5;color:#fca5a5;">❌ 실패/이탈</a>
  </div>
</div>

<div class="caution-box">
  ⚠️ <strong>QVA2는 매수 확정 신호가 아닙니다.</strong> 최근 고점 대비 많이 내려온 자리에서 돈이 다시 들어온 흔적을 찾는 관찰용 신호입니다. <strong>저점을 정확히 맞히는 모델이 아닙니다.</strong>
</div>

<h2>📊 단계별 카운트</h2>
<div class="stage-row" id="stage-row"></div>

<h2 id="sec-new">🟢 QVA2 확인 신규 <span class="count" id="new-count"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">오늘 처음 QVA2 본 신호가 발동한 종목입니다. 매수 확정이 아니라 30거래일 동안 후속 반응을 추적하는 출발점입니다.</div>
<div id="new-host"></div>

<h2>🔄 QVA2 후속 반응 <span class="count" id="follow-count"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">최근 QVA2가 나온 뒤 가격이 무너지지 않고, 다시 거래량과 거래대금이 살아난 후보입니다. 첫 QVA2보다 늦은 자리이므로 고점 근처 여부와 추격 위험을 함께 확인해야 합니다.</div>
<div id="follow-host"></div>

<h2 id="sec-vvi">🔥 다음 거래일 돌파 대기 (VVI2) <span class="count" id="vvi-count"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">QVA2 후보 중 거래대금 초동이 더 강하게 확인된 상태입니다. VVI2 다음 거래일에 vviHigh 돌파 여부를 기다리는 후보입니다.</div>
<div id="vvi-host"></div>

<h2 id="sec-bk">💥 돌파 성공 확인 종목 (H그룹) <span class="count" id="bk-count"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">VVI2 돌파대기일 종가 × 1.01(=기준선)을 다음 거래일이 돌파한 후보입니다. 최근 5거래일 안 발생 건만 표시됩니다.</div>
<div id="bk-host"></div>

<h2 id="sec-tr">📋 QVA2 확인 추적 중 <span class="count" id="tr-count"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">QVA2 발생 후 30거래일 동안 VVI2/돌파 진행 여부를 지켜보는 후보입니다 (후속 반응 후보 제외). D+21~30은 "연장 추적 구간".</div>
<div id="tr-host"></div>

<h2 id="sec-fl">❌ 실패/이탈 <span class="count" id="fl-count"></span></h2>
<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">최근 5거래일 안에 -15% 이탈, 돌파 실패, 또는 D+30 만료된 후보입니다.</div>
<div id="fl-host"></div>

<footer class="foot" id="foot"></footer>

<script>
const DATA = __JSON_DATA__;

function fmtDate(d) {
  if (!d || String(d).length !== 8) return d || '-';
  const s = String(d);
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
}
function fmtMarketcap(v) { if (!v) return '-'; if (v >= 1e12) return (v / 1e12).toFixed(1) + '조'; if (v >= 1e8) return Math.round(v / 1e8) + '억'; return v; }
function fmtNum(v) { if (v == null) return '-'; return Math.round(v).toLocaleString(); }
function pctClass(v) { if (v == null) return ''; return v > 0 ? 'cell-pos' : (v < 0 ? 'cell-neg' : ''); }

document.getElementById('subtitle').textContent =
  '기준일 ' + (DATA.meta.baseDateFmt || '-') + ' · 추적 ' + DATA.meta.trackingDays + '거래일 · 최근 ' + DATA.meta.recentBreakoutDays + '일까지 BREAKOUT 표시 · 생성 ' + new Date(DATA.meta.generatedAt).toLocaleString('ko-KR');

// follow reaction 후보는 별도 섹션으로, QVA2_TRACKING 섹션에서는 제외
const followList = DATA.followReactionList || [];
const trackingNonFollow = DATA.stages.QVA2_TRACKING.filter(c => !c.hasFollowReaction);

const sr = document.getElementById('stage-row');
const c = DATA.counts;
const newCnt    = DATA.stages.QVA2_NEW.length || 0;
const followCnt = followList.length;
const trCnt     = trackingNonFollow.length;
const vviCnt    = DATA.stages.VVI2_FIRED.length || 0;
const bkCnt     = DATA.stages.BREAKOUT_SUCCESS.length || 0;
const flCnt     = DATA.stages.FAILED.length || 0;
sr.innerHTML = [
  pill('QVA2_NEW',         newCnt,    'QVA2 확인 신규',     '오늘 새로 발동'),
  pill('FOLLOW',           followCnt, 'QVA2 후속 반응',     '가격 유지 + 거래대금 재증가'),
  pill('QVA2_TRACKING',    trCnt,     'QVA2 확인 추적 중',  'D+1~30 (후속 제외)'),
  pill('VVI2_FIRED',       vviCnt,    '돌파 대기 (VVI2)',   '오늘 VVI2 발동'),
  pill('BREAKOUT_SUCCESS', bkCnt,     '돌파 성공 (H그룹)',  '최근 5거래일 성공'),
  pill('FAILED',           flCnt,     '실패/이탈',          '최근 5거래일'),
].join('');

function pill(stage, n, label, desc) {
  return '<div class="stage-pill s-' + stage + '"><div class="lbl">' + label + '</div><div class="cnt">' + (n ?? 0) + '</div><div class="desc">' + desc + '</div></div>';
}

document.getElementById('new-count').textContent    = '(' + newCnt + ')';
document.getElementById('follow-count').textContent = '(' + followCnt + ')';
document.getElementById('vvi-count').textContent    = '(' + vviCnt + ')';
document.getElementById('bk-count').textContent     = '(' + bkCnt + ')';
document.getElementById('tr-count').textContent     = '(' + trCnt + ')';
document.getElementById('fl-count').textContent     = '(' + flCnt + ')';

// 0건 안내 — 사용자가 "보드가 비어있다"고 오해하지 않도록 대체 안내 제공
function emptyHtml(msg, links) {
  let html = '<div class="section-empty">' + msg;
  if (links && links.length) {
    html += '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;justify-content:center;">';
    for (const l of links) {
      html += '<a href="' + l.href + '" style="color:#c4b5fd;text-decoration:none;padding:4px 12px;border-radius:5px;background:#1e1b4b;border:1px solid #6366f1;font-size:11.5px;">' + l.label + '</a>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

renderCards('new-host',    DATA.stages.QVA2_NEW,
  emptyHtml('오늘 새로 발동한 QVA2 본 신호가 없습니다.', [
    { href: '#follow-host', label: 'QVA2 후속 반응 보기' },
    { href: '#tr-host',     label: 'QVA2 추적 중 보기' },
  ]));

renderCards('follow-host', followList,
  emptyHtml('QVA2 후속 반응 후보가 없습니다. (최근 QVA2 발생 + 가격 유지 + 거래대금 재증가)', [
    { href: '#tr-host', label: 'QVA2 추적 중 보기' },
  ]));

renderCards('vvi-host',    DATA.stages.VVI2_FIRED,
  emptyHtml('오늘 새로 VVI2가 발동한 종목은 없습니다. QVA2 이후 가격이 유지되며 다시 거래대금이 살아난 후보는 "QVA2 후속 반응" 섹션에서 확인하세요.', [
    { href: '#follow-host', label: 'QVA2 후속 반응 보기' },
    { href: '/qva2-vvi',    label: 'QVA2 VVI 보드 보기' },
  ]));

renderCards('bk-host',     DATA.stages.BREAKOUT_SUCCESS,
  emptyHtml('최근 5거래일 안에 QVA2 기준 돌파 성공 후보는 없습니다. 새 QVA2 위치 필터가 엄격하게 적용되어 고점권 변동성 종목은 제외됩니다.', [
    { href: '#follow-host', label: 'QVA2 후속 반응 보기' },
    { href: '/qva2-d5-rebreak', label: 'D+5 재돌파 보드 보기' },
  ]));

renderCards('tr-host',     trackingNonFollow, emptyHtml('추적 중인 후보가 없습니다.', []));
renderCards('fl-host',     DATA.stages.FAILED, emptyHtml('최근 5거래일 안 실패/이탈 후보가 없습니다.', []));

document.getElementById('foot').innerHTML =
  '<strong>위치 필터:</strong> 고점 대비 ≥' + DATA.meta.qva2Thresholds.minDrawdownFromHigh60 + '% (60일) 또는 ≥' + DATA.meta.qva2Thresholds.minDrawdownFromHigh120 + '% (120일) / 가격 위치 ≤' + (DATA.meta.qva2Thresholds.maxPricePosition60*100).toFixed(0) + '% (60일) 또는 ≤' + (DATA.meta.qva2Thresholds.maxPricePosition120*100).toFixed(0) + '% (120일) / 고점 거리 ≥' + DATA.meta.qva2Thresholds.minDistanceFromHigh60 + '% / 저점 대비 ≤' + DATA.meta.qva2Thresholds.maxRiseFromLow60 + '%. ' +
  '<br><strong>absorption:</strong> changePct ' + DATA.meta.qva2Thresholds.absorptionMinChangePct + '% ~ ' + DATA.meta.qva2Thresholds.absorptionMaxChangePct + '% · closeLoc ≥' + DATA.meta.qva2Thresholds.absorptionMinCloseLocation + ' · vol ≥×' + DATA.meta.qva2Thresholds.absorptionMinVolumeRatio + ' · val ≥×' + DATA.meta.qva2Thresholds.absorptionMinValueRatio + ' · upperWick ≤' + DATA.meta.qva2Thresholds.absorptionMaxUpperWickRatio + ' · body ≤' + DATA.meta.qva2Thresholds.absorptionMaxBodyRatio + '. ' +
  '<br><strong>spike:</strong> 장중 +' + DATA.meta.qva2Thresholds.spikeMinIntradayHighPct + '% ↑ · val ≥×' + DATA.meta.qva2Thresholds.spikeMinValueRatio + ' · closeLoc ≥' + DATA.meta.qva2Thresholds.spikeMinCloseLocation + '. ' +
  '<br>임계값은 qva2-screener.js의 QVA2_CONFIG에서 조정.';

function renderCards(hostId, items, emptyHtmlOrMsg) {
  const host = document.getElementById(hostId);
  if (!items || items.length === 0) {
    // emptyHtmlOrMsg can be either a plain string or pre-built HTML (with <div>)
    const isHtml = typeof emptyHtmlOrMsg === 'string' && emptyHtmlOrMsg.startsWith('<div');
    host.innerHTML = isHtml ? emptyHtmlOrMsg : '<div class="section-empty">' + emptyHtmlOrMsg + '</div>';
    return;
  }
  host.innerHTML = items.map(card).join('');
}

function card(e) {
  const stage = e.mainStage;
  const tagsHtml = (e.auxTags || []).map(t => '<span class="tag aux">' + t + '</span>').join('') +
    (e.riskTag ? '<span class="tag risk">위험 (-5%↓)</span>' : '') +
    (e.expiringSoon && stage === 'QVA2_TRACKING' ? '<span class="tag expiring">만료 임박 (D+15~20)</span>' : '');
  const judgment = e.judgmentStatus
    ? '<span class="judgment-badge judgment-' + e.judgmentStatus + '">' + judgmentLabel(e.judgmentStatus) + '</span>'
    : '';
  return '<div class="card s-' + stage + '">' +
    '<h3>' +
      '<a class="name-link" href="/qva2-watchlist/' + e.code + '">' + (e.name || e.code) + '</a>' +
      '<span class="code">' + e.code + '</span>' +
      '<span class="market">' + (e.market || '') + '</span>' +
      '<span class="grade-badge">QVA2 ' + e.qva2Score + '점 · ' + (e.qva2Grade || '') + '</span>' +
      judgment +
    '</h3>' +
    metricsHtml(e) +
    (e.stageReason ? '<div class="stage-reason">⚠ ' + e.stageReason + '</div>' : '') +
    '<div class="tags">' + tagsHtml + '</div>' +
  '</div>';
}

function metricsHtml(e) {
  const cells = [
    ['QVA2 신호일',   fmtDate(e.qva2SignalDate) + ' (D+' + e.daysSinceQva2 + ')'],
    ['신호가',        fmtNum(e.qva2SignalPrice)],
    ['현재 종가',     fmtNum(e.currentClose)],
    ['신호 대비',     (e.currentReturnFromSignal >= 0 ? '+' : '') + (e.currentReturnFromSignal ?? 0).toFixed(2) + '%', pctClass(e.currentReturnFromSignal)],
  ];
  if (e.vvi2Date) {
    cells.push(['VVI2',           fmtDate(e.vvi2Date) + ' (D+' + (e.daysSinceVvi2 ?? '?') + ')']);
    cells.push(['VVI2 고가',       fmtNum(e.vvi2High)]);
  }
  if (e.breakoutDate) {
    cells.push(['돌파일',          fmtDate(e.breakoutDate) + ' (D+' + (e.daysFromBreakout ?? '?') + ')']);
    cells.push(['진입가 (×1.01)',  fmtNum(e.breakoutEntryPrice1Pct)]);
    if (e.currentReturnFromEntry != null) {
      cells.push(['진입 대비',     (e.currentReturnFromEntry >= 0 ? '+' : '') + e.currentReturnFromEntry.toFixed(2) + '%', pctClass(e.currentReturnFromEntry)]);
    }
  }
  cells.push(['시총', fmtMarketcap(e.marketValue)]);
  return '<div class="metrics-grid">' + cells.map(c => {
    const cls = c[2] || '';
    return '<div class="metric"><div class="label">' + c[0] + '</div><div class="value ' + cls + '">' + c[1] + '</div></div>';
  }).join('') + '</div>';
}

function judgmentLabel(s) {
  return ({
    REVIEW_OK: '검토 가능',
    CHASE_CAUTION: '추격 주의',
    PULLBACK_WAIT: '눌림 대기',
    MANAGEMENT: '관리 구간',
    BREAKDOWN_WEAK: '돌파 약화',
  })[s] || s;
}
</script>
</body>
</html>
`;

if (require.main === module) {
  main().catch(e => { console.error('❌', e); process.exit(1); });
}

module.exports = { main };
