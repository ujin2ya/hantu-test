// Korea Flow Lead Model — 외국인/기관 일별 순매수 시드
//
// 모드:
//   PHASE_C : 페이지 2개 (~40일) — 데이터 검증용
//   FULL    : 페이지 50개 (~810일) — 백테스트용 풀 백필
//
// 입력: cache/stock-charts-long/<code>.json (시드된 종목 코드 목록)
// 출력: cache/flow-history/<code>.json
//
// 데이터 구조 per row:
//   { date, close, volume, instNetVol, foreignNetVol, instNetValue, foreignNetValue, foreignRate }
//   - *NetVol: 주식수 (Naver 원본)
//   - *NetValue: 종가 × 주식수 (원 환산, 음수 = 순매도)
//
// 실행:
//   node seed-flow-naver.js [pages=50] [throttleMs=700] [resumeRows=600]
//   node seed-flow-naver.js 2 350 0       # Phase C (검증, force)
//   node seed-flow-naver.js 50 700 600    # Full backfill (resume 모드, 600일+ 캐시 종목 skip)

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const iconv = require('iconv-lite');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, 'cache', 'stock-charts-long');
const FLOW_DIR = path.join(ROOT, 'cache', 'flow-history');
if (!fs.existsSync(FLOW_DIR)) fs.mkdirSync(FLOW_DIR, { recursive: true });

const PAGES = parseInt(process.argv[2] || '50', 10);
const THROTTLE_MS = parseInt(process.argv[3] || '700', 10);
const RESUME_ROWS = parseInt(process.argv[4] || '600', 10);  // 0이면 resume 비활성

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
      // 첫 페이지 실패 = 종목 자체 문제. 그 외는 fallthrough.
      if (p === 1) throw new Error(`page 1 failed: ${e.message}`);
      // 후반부 페이지는 빈 페이지로 간주 (상장 이전)
      break;
    }
    const rows = parseFrgnHtml(html);
    if (!rows.length) break;
    all.push(...rows);

    // 가장 오래된 row 가 시드 시작 (2023-01-01) 이전이면 종료
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

(async () => {
  const codes = fs
    .readdirSync(CHART_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort();

  console.log(`수집 대상: ${codes.length} 종목, pages=${PAGES}, throttle=${THROTTLE_MS}ms, resume_rows=${RESUME_ROWS}`);
  const expectedSec = (codes.length * PAGES * (THROTTLE_MS + 250)) / 1000;
  console.log(`예상 최대 시간: ~${(expectedSec / 3600).toFixed(1)}시간 (resume 종목 제외 시 단축)\n`);

  const t0 = Date.now();
  let success = 0, fail = 0, cached = 0, totalPageFailures = 0;
  let lastLog = 0;

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const cachePath = path.join(FLOW_DIR, `${code}.json`);

    // resume 분기:
    //   기존 캐시 rows >= RESUME_ROWS → skip
    //   기존 캐시 30 ≤ rows < RESUME_ROWS → 부족분만 추가 fetch (페이지당 ~18일, overlap 1페이지)
    let startPage = 1;
    let existingRows = [];
    if (RESUME_ROWS > 0 && fs.existsSync(cachePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        if (existing.rows && existing.rows.length >= RESUME_ROWS) {
          cached++;
          if (Date.now() - lastLog > 5000 || i === codes.length - 1) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
            console.log(`  [${i + 1}/${codes.length}] ${code} → cached (${existing.rows.length}d)  ok=${success} cached=${cached} fail=${fail} elapsed ${elapsed}s`);
            lastLog = Date.now();
          }
          continue;
        }
        if (existing.rows && existing.rows.length >= 30) {
          startPage = Math.max(1, Math.floor(existing.rows.length / 18));
          existingRows = existing.rows;
        }
      } catch (_) { /* fallthrough */ }
    }

    try {
      const { rows, pageFailures } = await fetchFlow(code, startPage, existingRows);
      totalPageFailures += pageFailures;
      if (!rows.length) {
        fail++;
      } else {
        fs.writeFileSync(cachePath, JSON.stringify({ code, rows }));
        success++;
      }
      if (Date.now() - lastLog > 8000 || i === codes.length - 1 || i % 25 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        const eta = ((codes.length - i - 1) * (Date.now() - t0)) / (i + 1) / 60000;
        const failRate = ((fail / Math.max(success + fail, 1)) * 100).toFixed(1);
        console.log(
          `  [${i + 1}/${codes.length} ${(((i + 1) / codes.length) * 100).toFixed(1)}%] ${code} → ${rows.length}d  ok=${success} cached=${cached} fail=${fail}(${failRate}%) pgFails=${totalPageFailures}  elapsed ${elapsed}s ETA ${eta.toFixed(1)}분`,
        );
        lastLog = Date.now();
      }
    } catch (e) {
      fail++;
      console.log(`  [${i + 1}] ${code} → ERROR: ${e.message}`);
    }
    if (i < codes.length - 1) await sleep(THROTTLE_MS);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n=== 완료 (${elapsed}s = ${(elapsed / 3600).toFixed(2)}h) ===`);
  console.log(`성공: ${success}, cached: ${cached}, 실패: ${fail}, 페이지 재시도 합계: ${totalPageFailures}, 총: ${codes.length}`);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
