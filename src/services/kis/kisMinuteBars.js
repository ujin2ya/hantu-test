// KIS 주식당일분봉 조회 (FHKST03010200).
// 주의: 이 endpoint는 "오늘 장중 분봉"만 반환. 과거 날짜 분봉은 다른 TR 필요.
// 수집 스크립트는 다음 거래일 09:35 이후(09:00~09:30 모인 시점) 또는 10:05 이후(09:00~10:00) 실행 가정.
const axios = require("axios");

// 단일 호출: hourHHMMSS 시점에서 과거 방향 30개 분봉 반환.
// 예: hourHHMMSS = "093000" → 약 09:00~09:29 (또는 09:01~09:30) 30개
async function getMinuteBarsAt(accessToken, stockCode, hourHHMMSS, includePastBusinessDay = "N") {
  const url = `${process.env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice`;
  const res = await axios.get(url, {
    headers: {
      "content-type": "application/json; charset=UTF-8",
      authorization: `Bearer ${accessToken}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "FHKST03010200",
    },
    params: {
      fid_etc_cls_code: "",
      fid_cond_mrkt_div_code: "J",
      fid_input_iscd: stockCode,
      fid_input_hour_1: hourHHMMSS,    // 종료 시간 (HHMMSS) — 이 시점에서 과거로 30개
      fid_pw_data_incu_yn: includePastBusinessDay, // "N" = 오늘만, "Y" = 과거 영업일까지
    },
    timeout: 10000,
  });
  if (res.data.rt_cd !== "0") {
    throw new Error(`분봉 API 오류 ${stockCode} @ ${hourHHMMSS}: ${res.data.msg_cd} / ${res.data.msg1}`);
  }
  return res.data; // output1 (메타) + output2 (분봉 배열, 최신→과거 순)
}

// 09:00~10:00 60분봉을 두 번에 나눠 수집하고 시간순(과거→최신) 정렬해 반환.
// endHour: "093000" 이면 09:00~09:30 1콜만, "100000" 이면 09:30+10:00 2콜.
// sleepMs: 콜 사이 대기 (KIS rate limit 방어).
async function getMorningMinuteBars(accessToken, stockCode, endHour = "100000", sleepMs = 250) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const calls = [];

  if (endHour <= "093000") {
    calls.push("093000");
  } else {
    // 두 번 나눠 호출: 09:30 (00~29) + 10:00 (30~59)
    calls.push("093000");
    calls.push(endHour);
  }

  const allBars = [];
  let meta = null;
  for (const hour of calls) {
    const res = await getMinuteBarsAt(accessToken, stockCode, hour);
    if (!meta) meta = res.output1 || null;
    const out2 = res.output2 || [];
    for (const r of out2) {
      // KIS는 최신→과거 순. 한 번에 다 모은 뒤 정렬.
      allBars.push(r);
    }
    if (calls.length > 1) await sleep(sleepMs);
  }
  // 중복 제거 (시간 키 기준) + 시간순 정렬
  const map = new Map();
  for (const b of allBars) {
    const key = (b.stck_bsop_date || "") + (b.stck_cntg_hour || "");
    if (!map.has(key)) map.set(key, b);
  }
  const sorted = [...map.values()].sort((a, b) => {
    const da = (a.stck_bsop_date || "") + (a.stck_cntg_hour || "");
    const db = (b.stck_bsop_date || "") + (b.stck_cntg_hour || "");
    return da < db ? -1 : da > db ? 1 : 0;
  });
  return { meta, raw: sorted };
}

// KIS 분봉 raw → 우리 표준 schema { time, open, high, low, close, volume, value }
// value는 KIS가 누적거래대금(acml_tr_pbmn)만 주므로 bar별로 diff해서 추정.
function normalizeBars(rawBars) {
  const bars = [];
  let prevAcmlValue = null;
  for (const r of rawBars) {
    const time = (r.stck_cntg_hour || "").slice(0, 4); // HHMM
    const formatted = time.length === 4 ? time.slice(0, 2) + ":" + time.slice(2) : time;
    const acml = Number(r.acml_tr_pbmn) || 0;
    let barValue = null;
    if (prevAcmlValue != null && acml >= prevAcmlValue) {
      barValue = acml - prevAcmlValue;
    } else if (prevAcmlValue == null) {
      barValue = acml; // 첫 bar — 누적이 곧 그 bar 거래대금 (장 시작부터 09:00 bar까지)
    }
    prevAcmlValue = acml;
    bars.push({
      time: formatted,
      open: Number(r.stck_oprc) || null,
      high: Number(r.stck_hgpr) || null,
      low:  Number(r.stck_lwpr) || null,
      close: Number(r.stck_prpr) || null,
      volume: Number(r.cntg_vol) || 0,
      value: barValue,
      acmlValue: acml,
    });
  }
  return bars;
}

module.exports = { getMinuteBarsAt, getMorningMinuteBars, normalizeBars };
