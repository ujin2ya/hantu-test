// Korea Flow Lead Model — 외국인/기관 일별 순매수 시드 (parallel)
//
// seed-flow-naver.js와 동일 데이터·동일 출력 schema. 단지 N개 코드를 동시 처리한다.
// IP block 위험을 피하려면 WORKERS=4 권장.
//
// 실행:
//   node seed-flow-naver-parallel.js [pages=50] [throttleMs=700] [resumeRows=0] [workers=4] [universeFilter=1]

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const iconv = require('iconv-lite');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
const STOCKS_LIST = path.join(ROOT, 'cache', 'naver-stocks-list.json');
if (!fs.existsSync(FLOW_DIR)) fs.mkdirSync(FLOW_DIR, { recursive: true });

const PAGES = parseInt(process.argv[2] || '50', 10);
const THROTTLE_MS = parseInt(process.argv[3] || '700', 10);
const RESUME_ROWS = parseInt(process.argv[4] || '0', 10);
const WORKERS = parseInt(process.argv[5] || '4', 10);
const UNIVERSE_FILTER = (process.argv[6] || '1') !== '0';

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFrgnPage(code, page, retries = 2) {
  const url = `https://finance.naver.com/item/frgn.nhn?code=${code}&page=${page}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await axios.get(url, { headers: H, timeout: 25000, responseType: 'arraybuffer' });
      return iconv.decode(Buffer.from(r.data), 'euc-kr');
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

function parseFrgnHtml(html) {
  const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const rows = [];
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
    const foreignRate = num(cells[8]);

    if (close == null || close === 0) continue;

    rows.push({
      date,
      close,
      volume,
      instNetVol,
      foreignNetVol,
      instNetValue: instNetVol != null ? Math.round(instNetVol * close) : null,
      foreignNetValue: foreignNetVol != null ? Math.round(foreignNetVol * close) : null,
      foreignRate,
    });
  }

  const seen = new Set();
  const dedup = [];
  for (const r of rows) {
    if (seen.has(r.date)) continue;
    seen.add(r.date);
    dedup.push(r);
  }
  return dedup.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchFlow(code, startPage = 1, existingRows = []) {
  const all = [...existingRows];
  let pageFailures = 0;
  for (let p = startPage; p <= PAGES; p++) {
    let html;
    try {
      html = await fetchFrgnPage(code, p);
    } catch (e) {
      pageFailures++;
      if (p === 1) throw new Error(`page 1 failed: ${e.message}`);
      break;
    }
    const rows = parseFrgnHtml(html);
    if (!rows.length) break;
    all.push(...rows);

    const earliest = rows[0]?.date;
    if (earliest && earliest < '20230101') break;

    if (p < PAGES) await sleep(THROTTLE_MS);
  }
  const seen = new Set();
  const dedup = [];
  for (const r of all) {
    if (seen.has(r.date)) continue;
    seen.add(r.date);
    dedup.push(r);
  }
  return {
    rows: dedup.sort((a, b) => a.date.localeCompare(b.date)),
    pageFailures,
  };
}

function loadUniverseFilter() {
  if (!UNIVERSE_FILTER) return null;
  const data = JSON.parse(fs.readFileSync(STOCKS_LIST, 'utf-8'));
  const stocks = data.stocks || data;
  const set = new Set();
  for (const s of stocks) {
    if (s.isSpecial || s.isEtf) continue;
    if (s.code) set.add(s.code);
  }
  return set;
}

const stats = {
  done: 0,
  success: 0,
  fail: 0,
  cached: 0,
  totalPageFailures: 0,
};

async function processCode(code) {
  const cachePath = path.join(FLOW_DIR, `${code}.json`);

  let startPage = 1;
  let existingRows = [];
  if (RESUME_ROWS > 0 && fs.existsSync(cachePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (existing.rows && existing.rows.length >= RESUME_ROWS) {
        stats.cached++;
        stats.done++;
        return;
      }
      if (existing.rows && existing.rows.length >= 30) {
        startPage = Math.max(1, Math.floor(existing.rows.length / 18));
        existingRows = existing.rows;
      }
    } catch (_) {}
  }

  try {
    const { rows, pageFailures } = await fetchFlow(code, startPage, existingRows);
    stats.totalPageFailures += pageFailures;
    if (!rows.length) {
      stats.fail++;
    } else {
      fs.writeFileSync(cachePath, JSON.stringify({ code, rows }));
      stats.success++;
    }
  } catch (e) {
    stats.fail++;
  } finally {
    stats.done++;
  }
}

(async () => {
  const universe = loadUniverseFilter();
  let codes = fs
    .readdirSync(CHART_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort();
  if (universe) codes = codes.filter((c) => universe.has(c));

  const total = codes.length;
  console.log(
    `수집 대상: ${total} 종목, pages=${PAGES}, throttle=${THROTTLE_MS}ms, ` +
      `resume_rows=${RESUME_ROWS}, workers=${WORKERS}, universe_filter=${UNIVERSE_FILTER}`,
  );
  const expectedSec = (total * PAGES * (THROTTLE_MS + 250)) / 1000 / WORKERS;
  console.log(`예상 최대 시간: ~${(expectedSec / 3600).toFixed(1)}시간\n`);

  const t0 = Date.now();

  // Shared queue index
  let cursor = 0;
  let lastLog = 0;
  function nextCode() {
    if (cursor >= total) return null;
    return codes[cursor++];
  }

  function logProgress(forced = false) {
    const now = Date.now();
    if (!forced && now - lastLog < 8000) return;
    lastLog = now;
    const elapsed = ((now - t0) / 1000).toFixed(0);
    const rate = stats.done / Math.max(1, (now - t0) / 1000);
    const eta = (total - stats.done) / Math.max(0.001, rate);
    const failRate = ((stats.fail / Math.max(stats.success + stats.fail, 1)) * 100).toFixed(1);
    console.log(
      `  [${stats.done}/${total} ${((stats.done / total) * 100).toFixed(1)}%] ` +
        `ok=${stats.success} cached=${stats.cached} fail=${stats.fail}(${failRate}%) ` +
        `pgFails=${stats.totalPageFailures}  ${rate.toFixed(2)}/s ` +
        `elapsed ${elapsed}s ETA ${(eta / 60).toFixed(1)}분`,
    );
  }

  async function worker(wid) {
    while (true) {
      const code = nextCode();
      if (code == null) return;
      await processCode(code);
      logProgress();
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  logProgress(true);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n=== 완료 (${elapsed}s = ${(elapsed / 3600).toFixed(2)}h) ===`);
  console.log(
    `성공: ${stats.success}, cached: ${stats.cached}, 실패: ${stats.fail}, ` +
      `페이지 재시도 합계: ${stats.totalPageFailures}, 총: ${total}`,
  );
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
