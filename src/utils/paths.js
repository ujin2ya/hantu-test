// 프로젝트 루트 경로를 한 곳에서 관리해 src/ 하위 모듈이 __dirname에 의존하지 않도록 한다.
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

module.exports = {
  ROOT,
  CACHE_DIR: path.join(ROOT, "cache"),
  REPORTS_DIR: path.join(ROOT, "reports"),
  CHART_DIR: path.join(ROOT, "cache", "stock-charts-long"),
  FLOW_DIR: path.join(ROOT, "cache", "flow-history"),
  AI_COMMENTS_DIR: path.join(ROOT, "cache", "ai-comments"),
  MATERIAL_DIR: path.join(ROOT, "cache", "material-analysis"),
  TOKEN_CACHE_PATH: path.join(ROOT, ".kis-token.json"),
  STOCKS_PATH: path.join(ROOT, "stocks.json"),
  SUBSCRIBERS_PATH: path.join(ROOT, ".subscribers.json"),
  VIEWS_DIR: path.join(ROOT, "views"),
};
