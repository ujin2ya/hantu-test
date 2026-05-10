#!/usr/bin/env node
/**
 * Daily flow update — KIS API 기반 수급 데이터 갱신
 *
 * 대상: flow-history/{code}.json
 * 소스: KIS API (한국투자증권) — 외국인/기관 수급 데이터
 * 동작:
 *   1. naver-stocks-list.json에서 종목 코드 읽기
 *   2. 각 종목별로 KIS API에서 수급 데이터 조회
 *   3. flow-history/{code}.json과 merge
 *   4. 같은 date: replace, 새 date: append, 정렬, 중복 제거
 *   5. 보존 행 수: env FLOW_KEEP_ROWS (기본 1000, 약 4년치) 까지만 유지
 *      QVA/VVI/H/VPR 장기 백테스트는 과거 cutoff에서도 VVI 검출(flow≥10)이
 *      필요하므로 기본값 1000을 둔다. 120으로 자르면 1년 이전 cutoff에서 VVI
 *      검출이 불가능해 H그룹/구조 훼손 등 검출이 모두 막힌다.
 *
 * 실행:
 *   node update-flow-daily.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');

require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
const axios = require('axios');

// ─── Config ───
const STOCKS_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const TOKEN_CACHE_FILE = path.join(ROOT, '.kis-token.json'); // app.js / update-daily-pykrx.py와 공유
// QVA/VVI/H/VPR 장기 백테스트를 위해 flow-history도 장기 보존이 필요하다.
// 120 row로 자르면 과거 cutoff에서 VVI 검출(flow≥10)이 불가능해진다.
// 기본 1000 row를 보존하되, FLOW_KEEP_ROWS 환경변수로 조정 가능하게 한다.
const FLOW_KEEP_ROWS = parseInt(process.env.FLOW_KEEP_ROWS || '1000', 10);

// 재시도 — 순차 실행이라 rate limit은 chart만큼 빈번하지 않지만,
// 일시 HTTP 오류/EGW00201로 인한 silent fail을 자동 회복.
const PER_CALL_RETRIES = parseInt(process.env.UPDATE_RETRIES || '3', 10);
const RETRY_ROUNDS = parseInt(process.env.UPDATE_RETRY_ROUNDS || '2', 10);

// KIS API Config
const KIS_APP_KEY = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const KIS_BASE_URL = process.env.KIS_BASE_URL;

let tokenCache = { accessToken: null, expiresAt: 0 };

// rate-limit / 일시 오류로 판단해 retry할 KIS 메시지 코드.
const RETRYABLE_KIS_MSG_CODES = new Set(['EGW00201', 'EGW00133']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Token Management ───
function loadTokenFromDisk() {
  if (!fs.existsSync(TOKEN_CACHE_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf-8'));
    if (data.accessToken && data.expiresAt) return data;
  } catch (_) {}
  return null;
}

function saveTokenToDisk(data) {
  try {
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(data), 'utf-8');
  } catch (_) {}
}

async function getAccessToken() {
  // 토큰 발급은 KIS에서 1분 1회 제한(EGW00133). app.js / update-daily-pykrx.py와
  // .kis-token.json을 공유해 같은 분 안에 두 스크립트가 발급 시도해 403 받는 일을 막는다.
  const now = Date.now();
  const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5분 전 갱신

  if (tokenCache.accessToken && tokenCache.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
    return tokenCache.accessToken;
  }

  const disk = loadTokenFromDisk();
  if (disk && disk.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
    tokenCache = { accessToken: disk.accessToken, expiresAt: disk.expiresAt };
    return tokenCache.accessToken;
  }

  const url = `${KIS_BASE_URL}/oauth2/tokenP`;
  const res = await axios.post(url, {
    grant_type: 'client_credentials',
    appkey: KIS_APP_KEY,
    appsecret: KIS_APP_SECRET,
  });

  const expiresIn = (res.data.expires_in || 3600) * 1000;
  tokenCache = {
    accessToken: res.data.access_token,
    expiresAt: now + expiresIn,
  };
  saveTokenToDisk(tokenCache);

  return tokenCache.accessToken;
}

// ─── KIS API ───
async function getInvestorTrend(accessToken, stockCode) {
  // HTTP 429/5xx와 KIS rate-limit msg_cd(EGW00201 등)는 지수 백오프로 PER_CALL_RETRIES만큼 재시도.
  // 그 외 KIS 오류(권한/종목 없음)는 즉시 throw → 종목별 영구 실패로 분류.
  const url = `${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-investor`;

  let lastErr = null;
  for (let attempt = 0; attempt < PER_CALL_RETRIES; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          authorization: `Bearer ${accessToken}`,
          appkey: KIS_APP_KEY,
          appsecret: KIS_APP_SECRET,
          tr_id: 'FHKST01010900',
        },
        params: {
          fid_cond_mrkt_div_code: 'J',
          fid_input_iscd: stockCode,
        },
        timeout: 10000,
        // 5xx도 axios가 throw하지 않게 해서 status로 직접 분기
        validateStatus: () => true,
      });

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastErr = `HTTP ${res.status}`;
        await sleep(Math.min(8000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 300));
        continue;
      }
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = res.data;
      if (data.rt_cd !== '0') {
        const msgCd = (data.msg_cd || '').trim();
        if (RETRYABLE_KIS_MSG_CODES.has(msgCd)) {
          lastErr = `${msgCd} / ${data.msg1}`;
          await sleep(Math.min(8000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 300));
          continue;
        }
        throw new Error(`KIS 수급 API 오류: ${msgCd} / ${data.msg1}`);
      }
      return data;
    } catch (e) {
      lastErr = e.message;
      if (attempt === PER_CALL_RETRIES - 1) throw e;
      const code = e.code;
      const isNetworkErr = code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
      // 명시적 KIS 비-retryable 에러는 그대로 throw
      if (!isNetworkErr && /KIS 수급 API 오류/.test(e.message)) throw e;
      await sleep(Math.min(8000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 300));
    }
  }
  throw new Error(`PER_CALL_RETRIES 소진: ${lastErr}`);
}

function normalizeInvestorTrend(apiData) {
  // 캐시 정상 schema (seed-flow-naver.js / pattern-screener 소비 형식)에 맞춘다:
  //   { date, close, volume, instNetVol, foreignNetVol, instNetValue, foreignNetValue, foreignRate }
  // 과거 버전은 closePrice/foreignNetQty/orgNetValue 같은 비호환 필드를 만들어
  // pattern-screener.js가 instNetValue를 못 읽는 문제가 있었다.
  const rows = Array.isArray(apiData?.output) ? apiData.output : [];
  return rows
    .map((r) => {
      const dateStr = String(r.stck_bsop_date || '').trim();
      if (!/^\d{8}$/.test(dateStr)) return null;

      const close = Number(r.stck_clpr || 0);
      const volume = Number(r.acml_vol || 0);
      const foreignNetVol = Number(r.frgn_ntby_qty || 0);
      const instNetVol = Number(r.orgn_ntby_qty || 0); // KIS 'orgn_*' = 기관(institution)
      // KIS의 frgn_ntby_tr_pbmn / orgn_ntby_tr_pbmn은 백만원 단위.
      // 캐시 일관 schema(seed-flow-naver의 instNetVol*close 원 단위)에 맞추기 위해 ×1,000,000.
      // 단위 안 맞추면 pattern-screener의 foreignNetValue/instNetValue 임계값이
      // 종목별로 1,000,000배 차이나게 적용되어 신호가 무너진다.
      const foreignNetValue = Number(r.frgn_ntby_tr_pbmn || 0) * 1_000_000;
      const instNetValue = Number(r.orgn_ntby_tr_pbmn || 0) * 1_000_000;

      return {
        date: dateStr,
        close,
        volume,
        instNetVol,
        foreignNetVol,
        instNetValue,
        foreignNetValue,
        // 캐시의 foreignRate는 외국인 보유비율(%)인데 KIS 일별 수급 API는 이를 직접 주지 않음.
        // null로 두는 게 seed-flow-naver와 일관 (cells[8] 미스매치 시 null).
        foreignRate: null,
      };
    })
    .filter(Boolean);
}

// ─── File I/O ───
function loadStocksList() {
  const data = JSON.parse(fs.readFileSync(STOCKS_LIST_PATH, 'utf-8'));
  return (data.stocks || []).map((s) => s.code);
}

function loadFlowHistory(code) {
  const filePath = path.join(FLOW_DIR, `${code}.json`);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return null;
}

function saveFlowHistory(code, data) {
  if (!fs.existsSync(FLOW_DIR)) fs.mkdirSync(FLOW_DIR, { recursive: true });
  const filePath = path.join(FLOW_DIR, `${code}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf-8');
}

function mergeFlowData(cached, newRows) {
  if (!cached) cached = { meta: {}, rows: [] };

  const existing = cached.rows || [];
  const existingDates = {};
  existing.forEach((r) => {
    existingDates[r.date] = r;
  });

  newRows.forEach((row) => {
    if (row.date in existingDates) {
      existingDates[row.date] = row;
    } else {
      existingDates[row.date] = row;
    }
  });

  let sorted = Object.values(existingDates).sort((a, b) => a.date.localeCompare(b.date));

  const seen = new Set();
  sorted = sorted.filter((r) => {
    if (seen.has(r.date)) return false;
    seen.add(r.date);
    return true;
  });

  if (sorted.length > FLOW_KEEP_ROWS) {
    sorted = sorted.slice(-FLOW_KEEP_ROWS);
  }

  cached.rows = sorted;
  return cached;
}

async function runPass(codes, accessToken, label) {
  // 한 번의 패스 — 각 종목을 순차 호출. 'fail'은 retry 대상, 'skip'은 진짜 데이터 없음.
  let success = 0;
  let skipped = 0;
  const failedCodes = [];
  const total = codes.length;

  for (let i = 0; i < total; i++) {
    const code = codes[i];
    if ((i + 1) % 50 === 0 || i === 0) {
      console.log(`[${label}] ${i + 1}/${total} (${Math.floor(((i + 1) / total) * 100)}%)`);
    }
    try {
      const apiData = await getInvestorTrend(accessToken, code);
      const newRows = normalizeInvestorTrend(apiData);

      if (!newRows || newRows.length === 0) {
        skipped++;
        continue;
      }

      const cached = loadFlowHistory(code);
      const updated = mergeFlowData(cached, newRows);
      saveFlowHistory(code, updated);
      success++;
    } catch (e) {
      // 일시 오류는 retry round에서 다시 시도
      failedCodes.push(code);
    }
  }

  return { success, failedCodes, skipped };
}

// ─── Main ───
async function updateDaily() {
  const codes = loadStocksList();

  console.log(`\n[시작] KIS API 수급 데이터 갱신 (retries=${PER_CALL_RETRIES}, retry_rounds=${RETRY_ROUNDS})`);
  console.log(`대상: ${codes.length}개 종목\n`);

  // Access token 1회만 획득 (.kis-token.json 공유)
  let accessToken = null;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    console.error(`[ERROR] 토큰 획득 실패: ${e.message}`);
    process.exit(1);
  }

  // 1차 패스
  let { success: totalSuccess, failedCodes, skipped: totalSkipped } = await runPass(
    codes,
    accessToken,
    '진행',
  );

  // 자동 재시도 round
  for (let r = 1; r <= RETRY_ROUNDS; r++) {
    if (failedCodes.length === 0) break;
    console.log(`\n[Retry ${r}/${RETRY_ROUNDS}] ${failedCodes.length}개 재시도`);
    await sleep(2000);
    const result = await runPass(failedCodes, accessToken, `Retry ${r}`);
    totalSuccess += result.success;
    totalSkipped += result.skipped;
    failedCodes = result.failedCodes;
  }

  console.log(`\n[완료]`);
  console.log(`  성공: ${totalSuccess}개`);
  console.log(`  실패(영구): ${failedCodes.length}개`);
  console.log(`  스킵(데이터 없음): ${totalSkipped}개`);
  if (failedCodes.length) {
    console.log(`  최종 실패 샘플(앞 10): ${failedCodes.slice(0, 10).join(', ')}`);
  }
  console.log(`\n업데이트 시각: ${new Date().toISOString().split('T').join(' ').split('.')[0]}`);
}

updateDaily().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
