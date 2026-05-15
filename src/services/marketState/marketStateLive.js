// 시장 상태 라이브 — KOSPI/KOSDAQ 지수 실시간 변화율을 30분 주기로 갱신.
//
// 기존 boards/oneDaySurge/one-day-surge-board.js의 classifyMarketState()는
// cache/kospi-daily.json (전일 종가 vs 그 전일 종가) 만 봤기 때문에 장중 흐름 변화를
// 반영 못 했다. 예: 아침에 코스피 +1.5% → 14시 -0.8%로 바뀐 상황을 보드가 모름.
//
// 이 모듈은 Naver 실시간 polling API (장중 7초 주기로 갱신되는 공식 모바일 API)를 호출해
// cache/market-state-live.json 에 저장한다. 보드는 이 파일을 우선 읽어 상태 라벨을 결정.
//
// API:
//   GET https://polling.finance.naver.com/api/realtime?query=SERVICE_INDEX:KOSPI
//   응답: { result: { areas: [{ datas: [{ nv, cv, cr, ov, hv, lv, ms, cd, ... }] }] } }
//   - nv: 현재가 × 100 (예: 759270 = 7592.70)
//   - cr: 전일 대비 변화율 (%)
//   - ov/hv/lv: 시가/고가/저가 × 100
//   - ms: 시장 상태 ('OPEN' / 'CLOSE' 등)
//
// 사용:
//   const { updateLiveMarketState } = require('./marketStateLive');
//   await updateLiveMarketState();  // → cache/market-state-live.json 갱신

'use strict';

const fs = require('fs');
const path = require('path');
const { CACHE_DIR } = require('../../utils/paths');

const LIVE_PATH = path.join(CACHE_DIR, 'market-state-live.json');
const NAVER_INDEX_BASE = 'https://polling.finance.naver.com/api/realtime?query=SERVICE_INDEX%3A';

// 분류 라벨 + 설명 (boards/oneDaySurge/one-day-surge-board.js의 라벨과 일치 유지)
const LABELS = {
  BROAD_MARKET_UP: '🟢 코스피·코스닥 동반 상승 (1DS 우호)',
  LARGE_CAP_LED:   '🟡 대형주 쏠림장 (1DS 친화 X)',
  KOSDAQ_WEAK:     '🟠 코스닥 약세 (단타 후보 종가 유지 약화 가능)',
  WEAK_MARKET:     '🔴 코스피·코스닥 동반 하락',
  MIXED_MARKET:    '⚪ 혼합 (편차 큼)',
  UNKNOWN:         '◯ 시장 상태 데이터 미연결',
};
const DESCS = {
  BROAD_MARKET_UP: '지수 동반 상승 + 중소형 우호. 1DS 후보의 종가 유지에도 도움.',
  LARGE_CAP_LED:   '지수는 강하지만 1DS 친화 장은 아닐 수 있습니다. 코스닥/중소형주 흐름이 약하면 장중 고점 후 빠지는 후보가 늘어날 수 있습니다.',
  KOSDAQ_WEAK:     '코스닥 약세 — 1DS 후보 다수가 코스닥 종목이라 종가 유지가 약해질 수 있음. 짧은 대응 우선.',
  WEAK_MARKET:     '시장 전체 약세 — 매매 자체를 줄이는 것이 적절.',
  MIXED_MARKET:    '지수 방향 혼재 — 종목별 편차 큼. 카드별 판단.',
  UNKNOWN:         'naver 실시간 지수 API 호출 실패 — daily 파일로 fallback 권장.',
};

function classifyState(kr, dr) {
  if (kr == null && dr == null) return 'UNKNOWN';
  if (kr == null || dr == null) return 'MIXED_MARKET';
  if (kr > 0.3 && dr > 0.3) return 'BROAD_MARKET_UP';
  if (kr > 0.3 && dr < -0.5) return 'LARGE_CAP_LED';
  if (dr <= -1) return 'KOSDAQ_WEAK';
  if (kr < -0.5 && dr < -0.5) return 'WEAK_MARKET';
  return 'MIXED_MARKET';
}

// Naver 지수 fetch — 한 번에 한 종목씩 (콤마 쿼리는 첫 종목만 반환됨)
async function fetchIndex(symbol) {
  const url = NAVER_INDEX_BASE + encodeURIComponent(symbol);
  // Naver polling API는 Accept: application/json 보내면 HTTP 406 — Accept: */* 또는 헤더 최소화.
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': '*/*',
      'Referer': 'https://m.stock.naver.com/',
    },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const data = j && j.result && j.result.areas && j.result.areas[0] && j.result.areas[0].datas && j.result.areas[0].datas[0];
  if (!data) throw new Error('no data for ' + symbol);
  return {
    code: data.cd,
    marketStatus: data.ms,                            // 'OPEN' (장중) / 그 외 (장 마감)
    value:       Number((data.nv / 100).toFixed(2)),
    change:      Number((data.cv / 100).toFixed(2)),
    changeRate:  Number(data.cr),                     // 전일 대비 %
    open:        data.ov != null ? Number((data.ov / 100).toFixed(2)) : null,
    high:        data.hv != null ? Number((data.hv / 100).toFixed(2)) : null,
    low:         data.lv != null ? Number((data.lv / 100).toFixed(2)) : null,
  };
}

function getKstHHMM() {
  const fmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return fmt.format(new Date());
}

// 한 번 호출 — KOSPI + KOSDAQ 받아서 cache/market-state-live.json 저장
async function updateLiveMarketState() {
  const t0 = Date.now();
  let kospi = null, kosdaq = null;
  try { kospi = await fetchIndex('KOSPI'); } catch (e) { console.warn('[marketStateLive] KOSPI fetch failed:', e.message); }
  try { kosdaq = await fetchIndex('KOSDAQ'); } catch (e) { console.warn('[marketStateLive] KOSDAQ fetch failed:', e.message); }
  const state = classifyState(kospi && kospi.changeRate, kosdaq && kosdaq.changeRate);
  const asOfHHMM = getKstHHMM();
  const out = {
    updatedAt: new Date().toISOString(),
    asOfTime: asOfHHMM,
    state,
    label: LABELS[state],
    desc:  DESCS[state],
    kospi,
    kosdaq,
    isLive: true,
    elapsedMs: Date.now() - t0,
  };
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(LIVE_PATH, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`[marketStateLive] ${asOfHHMM} 갱신 — ${out.label} (KOSPI ${kospi ? kospi.changeRate + '%' : '?'} / KOSDAQ ${kosdaq ? kosdaq.changeRate + '%' : '?'})`);
  return out;
}

module.exports = { updateLiveMarketState, fetchIndex, classifyState, LIVE_PATH, LABELS, DESCS };

// CLI: node src/services/marketState/marketStateLive.js
if (require.main === module) {
  updateLiveMarketState().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
}
