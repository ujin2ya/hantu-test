/**
 * Daily flow update — Naver 수급 데이터 최근 5거래일 갱신
 *
 * 대상: flow-history/{code}.json
 * 소스: Naver Finance frgn.nhn 페이지
 * 동작:
 *   1. stock-charts-long/{code}.json에서 최근 5거래일 날짜 추출
 *   2. 각 종목별로 Naver에서 해당 날짜의 수급 데이터 조회
 *   3. flow-history/{code}.json과 merge
 *   4. 같은 date: replace, 새 date: append, 정렬, 중복 제거
 *
 * 실행:
 *   node update-flow-daily.js
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const iconv = require('iconv-lite');

// ─── Config ───
const CHART_LONG_DIR = path.join(__dirname, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(__dirname, 'cache', 'flow-history');
const MIN_ROWS = 120;
const THROTTLE_MS = 700; // Naver 방식 존중
const TIMEOUT_MS = 25000;

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Helpers ───
function listChartFiles() {
  if (!fs.existsSync(CHART_LONG_DIR)) return [];
  return fs.readdirSync(CHART_LONG_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

function loadChart(code) {
  const filePath = path.join(CHART_LONG_DIR, `${code}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function getRecentDates(code, days = 5) {
  /**
   * stock-charts-long/{code}.json에서 최근 N거래일 날짜 추출
   * 반환: ['20260428', '20260427', ...] (최근순)
   */
  const chart = loadChart(code);
  if (!chart || !chart.rows) return [];

  const rows = chart.rows || [];
  return rows.slice(-days).map(r => r.date).reverse();
}

async function fetchFrgnPage(code, page, retries = 2) {
  /**
   * Naver frgn.nhn 페이지 조회
   */
  const url = `https://finance.naver.com/item/frgn.nhn?code=${code}&page=${page}`;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await axios.get(url, {
        headers: H,
        timeout: TIMEOUT_MS,
        responseType: 'arraybuffer',
      });
      return iconv.decode(Buffer.from(r.data), 'euc-kr');
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

function parseFrgnHtml(html) {
  /**
   * frgn.nhn HTML 파싱
   * 반환: { date: { close, instNetValue, foreignNetValue, ... }, ... }
   */
  const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const rows = {};

  const num = (s) => {
    if (s == null) return null;
    const m = String(s).match(/[+-]?[\d,]+\.?\d*/);
    if (!m) return null;
    const v = parseFloat(m[0].replace(/,/g, ''));
    return Number.isFinite(v) ? v : null;
  };

  for (const tr of trs) {
    const dateMatch = tr.match(/(\d{4})\.(\d{2})\.(\d{2})/);
    if (!dateMatch) continue;
    const date = dateMatch[1] + dateMatch[2] + dateMatch[3];

    const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
    if (tdMatches.length < 9) continue;

    const cells = tdMatches.map((m) =>
      m.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(),
    );

    const close = num(cells[1]);
    const volume = num(cells[4]);
    const instNetVol = num(cells[5]);
    const foreignNetVol = num(cells[6]);
    const instNetValue = num(cells[7]);
    const foreignNetValue = num(cells[8]);

    if (!close || close <= 0) continue;

    rows[date] = {
      date,
      close: Math.round(close),
      volume: Math.round(volume || 0),
      instNetVol: Math.round(instNetVol || 0),
      foreignNetVol: Math.round(foreignNetVol || 0),
      instNetValue: Math.round(instNetValue || 0),
      foreignNetValue: Math.round(foreignNetValue || 0),
      foreignRate: foreignNetVol ? Math.round((foreignNetVol / volume) * 10000) / 100 : null,
    };
  }

  return rows;
}

async function fetchFlowForCode(code, targetDates = []) {
  /**
   * 특정 종목의 지정 날짜 수급 데이터 조회
   * targetDates: ['20260428', '20260427', ...]
   * 반환: { date: {...}, ... } (모든 페이지에서 찾은 행)
   */
  const targetSet = new Set(targetDates);
  const allRows = {};

  // 페이지 1~3만 확인 (최근 ~60일)
  for (let page = 1; page <= 3; page++) {
    try {
      const html = await fetchFrgnPage(code, page);
      const pageRows = parseFrgnHtml(html);

      // 대상 날짜만 수집
      for (const [date, row] of Object.entries(pageRows)) {
        if (targetSet.has(date)) {
          allRows[date] = row;
        }
      }

      await sleep(THROTTLE_MS);
    } catch (e) {
      // 페이지 없거나 조회 실패 → 다음 종목으로
      break;
    }
  }

  return allRows;
}

function loadFlowCache(code) {
  /**
   * flow-history/{code}.json 로드
   */
  const filePath = path.join(FLOW_DIR, `${code}.json`);
  if (!fs.existsSync(filePath)) {
    return { code, rows: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return { code, rows: [] };
  }
}

function mergeFlowData(cached, newRows) {
  /**
   * 기존 flow 캐시와 새 데이터 merge
   * 규칙: 같은 date는 replace, 새 date는 append
   */
  const existingDates = {};
  for (const row of cached.rows || []) {
    if (row.date) existingDates[row.date] = row;
  }

  // 새 데이터로 업데이트/추가
  for (const [date, newRow] of Object.entries(newRows)) {
    existingDates[date] = newRow;
  }

  // 정렬 (date 기준 오름차순)
  const sorted = Object.values(existingDates).sort((a, b) =>
    (a.date || '').localeCompare(b.date || ''),
  );

  // 중복 제거
  const seen = new Set();
  const unique = [];
  for (const row of sorted) {
    if (!seen.has(row.date)) {
      unique.push(row);
      seen.add(row.date);
    }
  }

  // 최소 행 수 유지
  const trimmed = unique.length > MIN_ROWS ? unique.slice(-MIN_ROWS) : unique;

  return { code: cached.code, rows: trimmed };
}

function saveFlowData(code, data) {
  /**
   * flow-history/{code}.json 저장
   */
  const filePath = path.join(FLOW_DIR, `${code}.json`);
  try {
    if (!fs.existsSync(FLOW_DIR)) fs.mkdirSync(FLOW_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf-8');
    return true;
  } catch (e) {
    console.log(`  [Error] ${code}: 저장 실패`);
    return false;
  }
}

async function updateDaily() {
  /**
   * 메인 업데이트 루프
   */
  const codes = listChartFiles();
  if (codes.length === 0) {
    console.log('[Error] stock-charts-long 디렉토리가 비어 있습니다');
    process.exit(1);
  }

  let success = 0;
  let failed = 0;
  let skipped = 0;

  console.log(`\n[시작] Naver 수급 데이터 최근 5거래일 갱신`);
  console.log(`대상: ${codes.length}개 종목\n`);

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];

    // 진행률 표시
    if ((i + 1) % 50 === 0 || i === 0) {
      console.log(`[진행] ${i + 1}/${codes.length} (${Math.round((i + 1) * 100 / codes.length)}%)`);
    }

    // 대상 날짜 추출
    const targetDates = getRecentDates(code, 5);
    if (targetDates.length === 0) {
      skipped++;
      continue;
    }

    // Naver에서 조회
    let newRows;
    try {
      newRows = await fetchFlowForCode(code, targetDates);
    } catch (e) {
      failed++;
      continue;
    }

    if (Object.keys(newRows).length === 0) {
      skipped++;
      continue;
    }

    // 캐시 로드 및 merge
    const cached = loadFlowCache(code);
    const merged = mergeFlowData(cached, newRows);

    // 저장
    if (saveFlowData(code, merged)) {
      success++;
    } else {
      failed++;
    }
  }

  // 완료 보고
  console.log(`\n[완료]`);
  console.log(`  성공: ${success}개`);
  console.log(`  실패: ${failed}개`);
  console.log(`  스킵(대상 날짜 없음): ${skipped}개`);
  console.log(`\n업데이트 시각: ${new Date().toISOString().split('T')[0]} ${new Date().toTimeString().split(' ')[0]}`);
}

// ─── Main ───
(async () => {
  try {
    await updateDaily();
  } catch (e) {
    console.error(`\n[에러]`, e.message);
    process.exit(1);
  }
})();
