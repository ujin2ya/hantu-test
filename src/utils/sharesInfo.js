// 보통주식수 / 유동주식수 계산 헬퍼.
// - 보통주식수 = DART cmpnyOvrviw 발행주식 총수(stk_total_no) 우선, 없으면 KIS 상장주식수(lstn_stcn) fallback.
// - 유동주식수 = 보통주식수 × (1 − 본인+특수관계인 합계 지분율 / 100). 추정치이며 5% 임원·우리사주는 미반영.
function computeSharesInfo({ companyOverview, kisLive, shareholders }) {
  const dartIssued = companyOverview && !companyOverview.error ? companyOverview.issuedShares : null;
  const kisListed  = kisLive && kisLive.listedShares != null ? kisLive.listedShares : null;
  const issuedShares = dartIssued || kisListed || null;
  const issuedSource = dartIssued ? "dart" : (kisListed ? "kis" : null);
  const otherShares = companyOverview && !companyOverview.error ? companyOverview.otherShares : null;
  const topRate = shareholders && !shareholders.error && shareholders.totalRateEnd != null
    ? Number(shareholders.totalRateEnd) : null;
  const freeFloatShares = (issuedShares != null && topRate != null)
    ? Math.round(issuedShares * (1 - topRate / 100)) : null;
  return {
    issuedShares,
    otherShares,
    freeFloatShares,
    issuedSource,
    topShareholderRate: topRate,
    reportLabel: shareholders && !shareholders.error ? shareholders.reportLabel : null,
    settlementDate: shareholders && !shareholders.error ? shareholders.settlementDate : null,
  };
}

module.exports = { computeSharesInfo };
