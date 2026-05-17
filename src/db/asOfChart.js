/**
 * AS_OF_DATE 환경변수 기반 chart row 시점 컷.
 *
 * 사용 (보드 generator의 chart 로더):
 *   const { filterRowsAsOf } = require('../../src/db/asOfChart');
 *   const j = JSON.parse(fs.readFileSync(chartPath, 'utf-8'));
 *   if (j && j.rows) j.rows = filterRowsAsOf(j.rows);
 *
 * 효과:
 *   - 환경변수 AS_OF_DATE=YYYY-MM-DD (또는 YYYYMMDD)가 있으면
 *     해당 날짜 이하의 row만 반환. 미래 row는 잘려나감.
 *   - 환경변수 없으면 no-op (기존 동작 유지).
 *   - 백필 스크립트가 보드 generator를 spawnSync로 호출하면서
 *     env: { AS_OF_DATE: '2026-04-15' } 식으로 주입 → 그 시점 chart로 보드 재생성.
 */

const _raw = process.env.AS_OF_DATE || null;
const AS_OF_YMD = _raw ? _raw.replace(/-/g, '') : null;

function filterRowsAsOf(rows) {
  if (!AS_OF_YMD || !Array.isArray(rows)) return rows;
  return rows.filter(r => r && r.date && String(r.date) <= AS_OF_YMD);
}

function isAsOfMode() { return !!AS_OF_YMD; }

module.exports = { filterRowsAsOf, isAsOfMode, AS_OF_YMD };
