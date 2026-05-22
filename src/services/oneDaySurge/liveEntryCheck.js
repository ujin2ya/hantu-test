// 1DS 10시 생존 후보 — 클릭한 종목만 현재 진입 가능 여부 분석.
// 데이터 소스 1차: data/intraday/1ds/{date}/{code}.json 의 마지막 분봉 close 를 현재가로 사용.
// 2차에서 KIS 현재가 API 호출 추가 가능 (currentSource 필드로 구분).
//
// 판정 우선순위: DATA_MISSING > INVALID > CHASE_RISK > ENTER_OK > WATCH

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const INTRADAY_BASE = path.join(ROOT, 'data', 'intraday', '1ds');

const { getAccessToken } = require('../kis/kisToken');
const { getMinuteBarsAt, normalizeBars } = require('../kis/kisMinuteBars');

// 30초 TTL 메모리 캐시
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

// KIS 실시간 분봉 보강 — 종목당 30초 inflight coalesce (동시 클릭 방어)
const liveBarsCache = new Map();
const LIVE_BARS_TTL_MS = 30 * 1000;
const liveBarsInflight = new Map();

function nowKstIso() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  // KST → "YYYY-MM-DDTHH:MM:SS+09:00"
  const pad = (n) => String(n).padStart(2, '0');
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}T${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}+09:00`;
}

function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

function validateInputs(date, code) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'date 형식 오류 (YYYY-MM-DD)';
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return 'code 형식 오류 (6자리 숫자)';
  return null;
}

function loadIntradayBars(date, code) {
  const fp = path.join(INTRADAY_BASE, date, `${code}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return Array.isArray(j.bars) ? j : null;
  } catch (_) { return null; }
}

function findCloseAtOrAfter(bars, time) {
  for (const b of bars) {
    if (b && b.time === time && b.close > 0) return { bar: b, exactMatch: true };
  }
  for (const b of bars) {
    if (b && b.time > time && b.close > 0) return { bar: b, exactMatch: false };
  }
  return null;
}

function computeSummary(bars) {
  // 10:00 close
  const c10 = findCloseAtOrAfter(bars, '10:00');
  if (!c10) return { ok: false, reason: 'no_1000_bar' };
  const base1000 = c10.bar.close;
  const base1000ExactMatch = c10.exactMatch;

  // 09:31~10:00 high (돌파선)
  const pre = bars.filter(b => b && b.time >= '09:31' && b.time <= '10:00' && b.high > 0);
  const pre1000High = pre.length ? Math.max(...pre.map(b => b.high)) : null;

  // 10:00 이후 분봉
  const post = bars.filter(b => b && b.time > '10:00' && b.close > 0);
  if (post.length < 2) return { ok: false, reason: 'no_post_1000_bars' };

  // post1000 high/low + 시각
  let postHigh = -Infinity, postHighTime = null, postLow = Infinity, postLowTime = null;
  for (const b of post) {
    if (b.high > postHigh) { postHigh = b.high; postHighTime = b.time; }
    if (b.low  < postLow)  { postLow  = b.low;  postLowTime  = b.time; }
  }
  // 돌파
  let breakoutSuccess = false, breakoutTime = null, breakoutPrice = null;
  if (pre1000High) {
    for (const b of post) {
      if (b.high > pre1000High) {
        breakoutSuccess = true; breakoutTime = b.time; breakoutPrice = b.high;
        break;
      }
    }
  }
  // 현재가 = 마지막 분봉 close
  const lastBar = post[post.length - 1];
  const currentPrice = lastBar.close;
  const currentTime = lastBar.time;
  // 10:00 이후 -3% 이하 발생 후 회복 여부
  const threshold_m3 = base1000 * 0.97;
  let touched_m3 = false, recoveredFrom_m3 = false;
  for (const b of post) {
    if (b.low <= threshold_m3) {
      touched_m3 = true;
      // 이후 회복: 이 시점 이후 close > base1000 인 bar 존재
    }
    if (touched_m3 && b.close > base1000) recoveredFrom_m3 = true;
  }
  const m3_drop_unrecovered = touched_m3 && !recoveredFrom_m3;

  // 최근 5분 (마지막 5개 분봉)
  const last5 = post.slice(-5);
  const last5_open = last5.length > 0 ? last5[0].open || last5[0].close : null;
  const recent5mRate = last5_open > 0 ? ((currentPrice / last5_open) - 1) * 100 : null;
  // 최근 5분 저점 이탈 — 직전 5분 (post의 끝-10 ~ 끝-5) 의 min low 보다 last5 의 min low 가 더 낮으면 이탈
  let recent5mLowBroken = false;
  if (post.length >= 10) {
    const prev5 = post.slice(-10, -5);
    const prev5MinLow = prev5.length ? Math.min(...prev5.map(b => b.low)) : null;
    const last5MinLow = last5.length ? Math.min(...last5.map(b => b.low)) : null;
    if (prev5MinLow != null && last5MinLow != null) recent5mLowBroken = last5MinLow < prev5MinLow;
  }
  // 최근 5분 거래대금 추이 — last5 합계 vs 직전 5분 합계
  let recent5mValueTrend = 'UNKNOWN';
  if (post.length >= 10) {
    const prev5Sum = post.slice(-10, -5).reduce((s, b) => s + (b.value || 0), 0);
    const last5Sum = last5.reduce((s, b) => s + (b.value || 0), 0);
    if (prev5Sum > 0) {
      const ratio = last5Sum / prev5Sum;
      if (ratio >= 1.0) recent5mValueTrend = 'INCREASING';
      else if (ratio >= 0.5) recent5mValueTrend = 'MAINTAINED';
      else recent5mValueTrend = 'DECLINING';
    }
  }

  const currentRateFrom1000 = ((currentPrice / base1000) - 1) * 100;
  const drawdownFromPostHigh = postHigh > 0 ? ((currentPrice / postHigh) - 1) * 100 : 0;

  return {
    ok: true,
    base1000, base1000ExactMatch,
    currentPrice, currentTime,
    currentRateFrom1000: round(currentRateFrom1000, 2),
    pre1000High, post1000High: postHigh, post1000HighTime: postHighTime,
    post1000Low: postLow, post1000LowTime: postLowTime,
    drawdownFromPostHigh: round(drawdownFromPostHigh, 2),
    breakoutSuccess, breakoutTime, breakoutPrice,
    recent5mRate: round(recent5mRate, 2),
    recent5mLowBroken,
    recent5mValueTrend,
    m3_drop_unrecovered,
    postPoints: post.map(b => ({ time: b.time, price: b.close, volume: b.volume || 0 })),
  };
}

function decideVerdict(s) {
  const r = []; // reasons
  const w = []; // warnings
  if (!s || !s.ok) {
    return { verdict: 'DATA_MISSING', verdictLabel: '⚪ 데이터 부족', explainText: '분봉 또는 현재가 데이터가 부족해 판단할 수 없습니다.', reasons: r, warnings: w };
  }

  const {
    base1000, currentPrice, currentRateFrom1000, pre1000High,
    post1000High, drawdownFromPostHigh, breakoutSuccess, breakoutTime,
    recent5mLowBroken, m3_drop_unrecovered,
  } = s;

  // INVALID 우선
  if (currentPrice < base1000) r.push(`현재가가 10:00 기준가 이탈 (${currentPrice} < ${base1000})`);
  if (currentRateFrom1000 <= -2) r.push(`현재가 10:00 대비 ${currentRateFrom1000}% (≤ -2%)`);
  if (drawdownFromPostHigh <= -4) r.push(`고점 대비 ${drawdownFromPostHigh}% 큰 폭 밀림 (≤ -4%)`);
  if (m3_drop_unrecovered) r.push('10시 이후 -3% 이하 하락 후 회복 못 함');
  if (currentPrice < base1000 || currentRateFrom1000 <= -2 || drawdownFromPostHigh <= -4 || m3_drop_unrecovered) {
    return {
      verdict: 'INVALID',
      verdictLabel: '🔴 진입 부적합',
      explainText: '10:00 기준가를 이탈했거나 고점 대비 크게 밀렸습니다. 신규 진입 후보로 보기 어렵습니다.',
      reasons: r, warnings: w,
    };
  }

  // CHASE_RISK
  const chaseChecks = [];
  if (currentRateFrom1000 >= 5) chaseChecks.push(`10:00 대비 +${currentRateFrom1000}% (≥ +5%)`);
  if (post1000High > 0 && currentPrice >= post1000High * 0.99 && currentRateFrom1000 >= 4) {
    chaseChecks.push('고점권 (postHigh 99% 이상) + +4% 이상');
  }
  // post1000High가 +7% 이상이고 현재 +5% 이상이면 chase
  if (post1000High > 0 && (post1000High / base1000 - 1) * 100 >= 7 && currentRateFrom1000 >= 5) {
    chaseChecks.push('10시 이후 +7% 이상 상승 후 현재도 +5% 이상');
  }
  if (chaseChecks.length > 0) {
    return {
      verdict: 'CHASE_RISK',
      verdictLabel: '🟠 추격 위험 / 눌림 대기',
      explainText: '10:00 기준가 대비 이미 많이 올라 추격 부담이 있습니다. 신규 진입보다는 눌림 후 재돌파 확인이 필요합니다.',
      reasons: chaseChecks, warnings: w,
    };
  }

  // ENTER_OK
  const enterOk = breakoutSuccess
    && pre1000High != null && currentPrice >= pre1000High
    && currentRateFrom1000 >= 0
    && currentRateFrom1000 <= 5
    && drawdownFromPostHigh >= -2.5
    && !recent5mLowBroken;
  if (enterOk) {
    r.push('10시 생존 후 09:31~10:00 고점 돌파 성공' + (breakoutTime ? ` (${breakoutTime})` : ''));
    r.push(`현재가가 10:00 기준가 대비 +${currentRateFrom1000}%로 추격 부담이 크지 않음`);
    r.push(`고점 대비 ${drawdownFromPostHigh}%로 고점권 유지`);
    r.push('최근 5분 저점 이탈 없음');
    return {
      verdict: 'ENTER_OK',
      verdictLabel: '🟢 진입 검토 가능',
      explainText: '10시 생존 후 고점 돌파에 성공했고, 현재가가 10:00 기준가 위에서 과도하게 멀지 않은 구간입니다. 단, 10:00 기준가 이탈 시 실패로 봅니다.',
      reasons: r, warnings: w,
    };
  }

  // WATCH
  if (!breakoutSuccess) r.push('아직 09:31~10:00 고점 미돌파');
  if (currentRateFrom1000 >= 0) r.push(`현재가 10:00 기준가 위 (+${currentRateFrom1000}%)`);
  if (recent5mLowBroken) w.push('최근 5분 저점 이탈 — 약화 가능');
  // 11시 이후 미돌파면 약화 경고
  const currentTimeStr = s.currentTime || '';
  if (!breakoutSuccess && currentTimeStr > '11:00') {
    w.push('11시 이후에도 미돌파 — 약화 신호. 진입 보류 검토.');
  }
  return {
    verdict: 'WATCH',
    verdictLabel: '⏳ 관찰 / 돌파 대기',
    explainText: '10:00 기준가 위는 유지하고 있지만 아직 돌파 확인이 부족합니다. 11시 전까지 돌파 여부를 확인합니다.',
    reasons: r, warnings: w,
  };
}

function buildLevels(base1000, pre1000High) {
  return {
    baseLine: base1000,
    watchLine: pre1000High || null,
    stopLine2: round(base1000 * 0.98, 0),
    stopLine3: round(base1000 * 0.97, 0),
    chaseLine: round(base1000 * 1.05, 0),
  };
}

// 클릭 시점에 KIS 분봉 1콜로 최신 분봉 30개 보강.
// 다음 cron(12:30 / 15:30) 사이 갭에서도 10:00 이후 분봉을 채울 수 있게 한다.
// 종목당 30초 TTL + inflight coalesce — 동시 클릭/연속 새로고침에 KIS 호출 폭주 방어.
async function fetchLiveBarsForToday(code) {
  if (!process.env.KIS_BASE_URL || !process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    return null; // KIS 자격증명 미설정 환경(로컬 개발 등)
  }
  const cached = liveBarsCache.get(code);
  if (cached && (Date.now() - cached.savedAt) < LIVE_BARS_TTL_MS) {
    return cached.bars;
  }
  if (liveBarsInflight.has(code)) {
    return liveBarsInflight.get(code);
  }
  const promise = (async () => {
    try {
      const token = await getAccessToken();
      // 현재 KST 시각으로 endHour 구성 — KIS가 그 시점에서 거꾸로 30bar 반환
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      const parts = fmt.formatToParts(new Date());
      let hh = '10', mm = '00', ss = '00';
      for (const p of parts) {
        if (p.type === 'hour') hh = p.value;
        else if (p.type === 'minute') mm = p.value;
        else if (p.type === 'second') ss = p.value;
      }
      if (hh === '24') hh = '00';
      const endHour = `${hh}${mm}${ss}`;
      const res = await getMinuteBarsAt(token, code, endHour, 'N');
      const raw = res.output2 || [];
      const bars = normalizeBars(raw);
      liveBarsCache.set(code, { savedAt: Date.now(), bars });
      return bars;
    } catch (e) {
      // KIS 실패는 silent — 기존 파일 bars 만으로 진행
      return null;
    } finally {
      liveBarsInflight.delete(code);
    }
  })();
  liveBarsInflight.set(code, promise);
  return promise;
}

function mergeBars(prevBars, newBars) {
  const byTime = new Map();
  for (const b of (prevBars || [])) if (b && b.time) byTime.set(b.time, b);
  for (const b of (newBars  || [])) if (b && b.time) byTime.set(b.time, b);
  return Array.from(byTime.values()).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

function isTodayKst(dateStr) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = fmt.formatToParts(new Date());
    let y = '', m = '', d = '';
    for (const p of parts) {
      if (p.type === 'year') y = p.value;
      else if (p.type === 'month') m = p.value;
      else if (p.type === 'day') d = p.value;
    }
    return dateStr === `${y}-${m}-${d}`;
  } catch (_) { return false; }
}

async function analyzeLiveEntryFor1dsSurvivor({ date, code, name }) {
  const err = validateInputs(date, code);
  if (err) return { ok: false, reason: err };

  // 캐시 hit
  const cacheKey = `${date}__${code}`;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.savedAt) < CACHE_TTL_MS) {
    return cached.result;
  }

  const data = loadIntradayBars(date, code);
  let fileBars = data ? data.bars : null;
  let resolvedName = name || (data && data.name) || null;

  // 오늘 KST 일 때 KIS 실시간 분봉 1콜로 보강 — file bars 가 없거나 post-1000 부족할 때 모두 적용
  let liveSource = 'INTRADAY_LAST_CLOSE';
  if (isTodayKst(date)) {
    // 1차로 file bars 로 시도 → post-1000 부족하면 KIS 보강
    const trialSummary = fileBars ? computeSummary(fileBars) : { ok: false };
    if (!trialSummary.ok) {
      const liveBars = await fetchLiveBarsForToday(code);
      if (liveBars && liveBars.length > 0) {
        fileBars = mergeBars(fileBars, liveBars);
        liveSource = 'KIS_LIVE_MERGED';
      }
    }
  }

  if (!fileBars) {
    const result = {
      ok: true, code, name: resolvedName, date,
      checkedAt: nowKstIso(),
      verdict: 'DATA_MISSING',
      verdictLabel: '⚪ 데이터 부족',
      explainText: '분봉 파일이 없습니다.',
      currentSource: 'NONE',
      summary: null, levels: null, reasons: [], warnings: [],
      chart: null,
    };
    cache.set(cacheKey, { savedAt: Date.now(), result });
    return result;
  }

  const summary = computeSummary(fileBars);
  if (!summary.ok) {
    const result = {
      ok: true, code, name: resolvedName, date,
      checkedAt: nowKstIso(),
      verdict: 'DATA_MISSING',
      verdictLabel: '⚪ 데이터 부족',
      explainText: summary.reason === 'no_1000_bar'
        ? '10:00 분봉이 없습니다. 10:00 이후 첫 분봉도 없습니다.'
        : '10:00 이후 분봉이 부족합니다 (2개 미만).',
      currentSource: 'NONE',
      summary: null, levels: null, reasons: [], warnings: [],
      chart: null,
    };
    cache.set(cacheKey, { savedAt: Date.now(), result });
    return result;
  }

  const verdictInfo = decideVerdict(summary);
  const levels = buildLevels(summary.base1000, summary.pre1000High);

  const result = {
    ok: true,
    code, name: resolvedName,
    date,
    checkedAt: nowKstIso(),
    currentSource: liveSource,
    verdict: verdictInfo.verdict,
    verdictLabel: verdictInfo.verdictLabel,
    explainText: verdictInfo.explainText,
    summary: {
      base1000: summary.base1000,
      currentPrice: summary.currentPrice,
      currentTime: summary.currentTime,
      currentRateFrom1000: summary.currentRateFrom1000,
      preHigh0931To1000: summary.pre1000High,
      post1000High: summary.post1000High,
      post1000HighTime: summary.post1000HighTime,
      post1000Low: summary.post1000Low,
      post1000LowTime: summary.post1000LowTime,
      drawdownFromPostHigh: summary.drawdownFromPostHigh,
      breakoutSuccess: summary.breakoutSuccess,
      breakoutTime: summary.breakoutTime,
      breakoutPrice: summary.breakoutPrice,
      recent5mRate: summary.recent5mRate,
      recent5mLowBroken: summary.recent5mLowBroken,
      recent5mValueTrend: summary.recent5mValueTrend,
    },
    levels,
    reasons: verdictInfo.reasons,
    warnings: verdictInfo.warnings,
    chart: {
      baseTime: '10:00',
      points: summary.postPoints,
    },
  };

  cache.set(cacheKey, { savedAt: Date.now(), result });
  return result;
}

module.exports = { analyzeLiveEntryFor1dsSurvivor };
