// 나스닥 테마 → 1DS 장초 감시 후보풀 lookup helper.
// 향후 1DS 보드 generator가 카드에 "테마 감시" 태그를 부착할 때 사용.
// 1DS 본체 로직 변경 X — 단순 lookup만.

const fs = require("fs");
const path = require("path");

const POOL_PATH = path.join(__dirname, "..", "..", "reports", "theme-1ds-watch-pool.json");

let _cached = null;
let _cachedMtime = 0;

function loadTheme1dsWatchPool() {
  try {
    if (!fs.existsSync(POOL_PATH)) return null;
    const st = fs.statSync(POOL_PATH);
    // 파일 mtime 변경 시 재로드 (보드 generator가 cron 06:30에 다시 생성)
    if (_cached && st.mtimeMs === _cachedMtime) return _cached;
    _cached = JSON.parse(fs.readFileSync(POOL_PATH, "utf-8"));
    _cachedMtime = st.mtimeMs;
    return _cached;
  } catch (_) {
    return null;
  }
}

function getThemeWatchInfoByCode(code) {
  const pool = loadTheme1dsWatchPool();
  if (!pool || !Array.isArray(pool.candidates)) {
    return { code, isThemeWatchCandidate: false };
  }
  const hit = pool.candidates.find((c) => c.code === code);
  if (!hit) return { code, isThemeWatchCandidate: false };
  return {
    code,
    isThemeWatchCandidate: true,
    watchGrade:        hit.watchGrade,
    watchGroup:        hit.watchGroup,
    bestThemeKey:      hit.bestThemeKey,
    bestThemeLabel:    hit.bestThemeLabel,
    bestThemeStrength: hit.bestThemeStrength,
    theme1dsWatchScore: hit.theme1dsWatchScore,
    themeWatchScore:   hit.themeWatchScore,
    grade:             hit.grade,
    watchReason:       hit.watchReason,
    riskNotes:         hit.riskNotes || [],
    hasQva1:  !!hit.hasQva1,  qva1Date: hit.qva1Date,
    hasQva2:  !!hit.hasQva2,  qva2Date: hit.qva2Date,
    hasVvi2:  !!hit.hasVvi2,  vvi2Date: hit.vvi2Date,
    hasOneDaySurge: !!hit.hasOneDaySurge, oneDaySurgeDate: hit.oneDaySurgeDate,
    themeDate:    pool.themeDate,
    usMarketDate: pool.usMarketDate,
  };
}

// 코드 셋(Set)으로 빠른 lookup
function getThemeWatchCodeSet() {
  const pool = loadTheme1dsWatchPool();
  if (!pool || !Array.isArray(pool.candidates)) return new Set();
  return new Set(pool.candidates.map((c) => c.code));
}

module.exports = {
  loadTheme1dsWatchPool,
  getThemeWatchInfoByCode,
  getThemeWatchCodeSet,
  POOL_PATH,
};
