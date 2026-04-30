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
 *
 * 실행:
 *   node update-flow-daily.js
 */

const path = require('path');
const ROOT = __dirname;

require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
const axios = require('axios');

// ─── Config ───
const STOCKS_LIST_PATH = path.join(ROOT, 'cache', 'naver-stocks-list.json');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const MIN_ROWS = 120;

// KIS API Config
const KIS_APP_KEY = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const KIS_BASE_URL = process.env.KIS_BASE_URL;

let tokenCache = { accessToken: null, expiresAt: 0 };

// ─── Token Management ───
async function getAccessToken() {
  const now = Date.now();
  const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5분 전 갱신

  if (tokenCache.accessToken && tokenCache.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
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

  return tokenCache.accessToken;
}

// ─── KIS API ───
async function getInvestorTrend(accessToken, stockCode) {
  const url = `${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-investor`;

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
  });

  if (res.data.rt_cd !== '0') {
    throw new Error(`KIS 수급 API 오류: ${res.data.msg_cd} / ${res.data.msg1}`);
  }

  return res.data;
}

function normalizeInvestorTrend(apiData) {
  const rows = Array.isArray(apiData?.output) ? apiData.output : [];
  return rows
    .map((r) => {
      const dateStr = String(r.stck_bsop_date || '').trim();
      if (!/^\d{8}$/.test(dateStr)) return null;

      return {
        date: dateStr,
        closePrice: Number(r.stck_clpr || 0),
        foreignNetQty: Number(r.frgn_ntby_qty || 0),
        foreignNetValue: Number(r.frgn_ntby_tr_pbmn || 0),
        orgNetQty: Number(r.orgn_ntby_qty || 0),
        orgNetValue: Number(r.orgn_ntby_tr_pbmn || 0),
        personalNetQty: Number(r.prsn_ntby_qty || 0),
        foreignRate: (Number(r.frgn_ntby_qty || 0) / Math.max(Number(r.acml_vol || 1), 1)) * 100,
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

  if (sorted.length > MIN_ROWS) {
    sorted = sorted.slice(-MIN_ROWS);
  }

  cached.rows = sorted;
  return cached;
}

// ─── Main ───
async function updateDaily() {
  const codes = loadStocksList();

  console.log(`\n[시작] KIS API 수급 데이터 갱신`);
  console.log(`대상: ${codes.length}개 종목\n`);

  let success = 0;
  let failed = 0;
  let skipped = 0;

  // Access token 1회만 획득
  let accessToken = null;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    console.error(`[ERROR] 토큰 획득 실패: ${e.message}`);
    process.exit(1);
  }

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];

    if ((i + 1) % 50 === 0 || i === 0) {
      console.log(`[진행] ${i + 1}/${codes.length} (${Math.floor(((i + 1) / codes.length) * 100)}%)`);
    }

    try {
      // KIS API 조회
      const apiData = await getInvestorTrend(accessToken, code);
      const newRows = normalizeInvestorTrend(apiData);

      if (!newRows || newRows.length === 0) {
        skipped++;
        continue;
      }

      // 기존 캐시 로드
      const cached = loadFlowHistory(code);

      // Merge
      const updated = mergeFlowData(cached, newRows);

      // 저장
      saveFlowHistory(code, updated);
      success++;
    } catch (e) {
      // 조용히 실패 (해제된 종목, API 오류 등)
      failed++;
    }
  }

  console.log(`\n[완료]`);
  console.log(`  성공: ${success}개`);
  console.log(`  실패: ${failed}개`);
  console.log(`  스킵(데이터 없음): ${skipped}개`);
  console.log(`\n업데이트 시각: ${new Date().toISOString().split('T').join(' ').split('.')[0]}`);
}

updateDaily().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
