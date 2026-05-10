// 보드 상세 페이지의 단순 종목 상세는 더 이상 별도 파일로 존재하지 않는다.
// /stock/:code → qvaVviRedefined.getRedefinedVviStockDetail (라우트에서 직접 매핑) → 모든 보드가 같은 상세 페이지를 공유한다.
// 이 파일은 레거시 /?query=CODE → /stock/:code redirect 만 담당.
function getStockDetailByQuery(req, res, next) {
  const q = String(req.query.query || "").replace(/[^0-9A-Za-z]/g, "");
  if (!q) return next(); // query 없으면 다른 핸들러로 넘김
  return res.redirect("/stock/" + q + (req.query.from ? "?from=" + encodeURIComponent(String(req.query.from)) : ""));
}

module.exports = { getStockDetailByQuery };
