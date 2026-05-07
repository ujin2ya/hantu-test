// 1-Day Surge 보드 일일 메일 — 평일 09:30:30 cron이 호출.
// reports/one-day-surge-board-result.json의 priorityRanked(top 5 + extra 10)를 단일 표로 발송.
const { mailTransporter } = require("./patternMail");
const { loadSubscribers } = require("./subscribers");

function fmtNum(n) {
  if (n == null || !isFinite(n)) return "-";
  return Math.round(n).toLocaleString("ko-KR");
}
function fmtPct(n, signed = true) {
  if (n == null || !isFinite(n)) return "-";
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
function fmtRatio(n) {
  if (n == null || !isFinite(n)) return "-";
  return `×${n.toFixed(1)}`;
}

async function sendOneDaySurgeMail(boardResult) {
  if (!mailTransporter) return;
  const subscribers = loadSubscribers();
  if (!subscribers.length) return;

  const groups = ["BALANCED-GT", "LIGHT-GT", "MID-CAP-GT"];
  const byCode = new Map();
  for (const g of groups) {
    for (const it of (boardResult?.groups?.[g] || [])) byCode.set(it.code, it);
  }

  const ranked = boardResult?.priorityRanked || {};
  const topCodes = ranked.topPriority || [];
  const extraCodes = ranked.extraPriority || [];
  const allCodes = [...topCodes, ...extraCodes];
  const items = allCodes.map(c => byCode.get(c)).filter(Boolean);
  if (!items.length) {
    console.log("[1DS메일] 후보 0건 — 스킵");
    return;
  }

  const meta = boardResult.meta || {};
  const analysisDate = meta.analysisDateFmt || meta.analysisDate || "-";
  const todayStr = new Date()
    .toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" })
    .replace(/\. /g, "-").replace(".", "");
  const subject = `[한투신호] 단타 후보 ${items.length}종목 (${todayStr} 09:30)`;

  const rows = items.map((c, i) => {
    const isTop = i < topCodes.length;
    const tier = isTop ? "⭐" : "";
    const buyMax = c.manualTargets?.preOpen?.realisticBuyMax;
    const sellMin = c.manualTargets?.preOpen?.sellMin;
    return `<tr>
      <td>${tier} ${c.name || c.code}</td>
      <td style="font-size:11px;color:#666">${c.market || ""}</td>
      <td style="text-align:right">${c.oneDaySurgeScore ?? "-"}</td>
      <td style="text-align:right">${fmtRatio(c.valueRatio)}</td>
      <td style="text-align:right;color:${(c.changeRate || 0) >= 0 ? "#c0392b" : "#2980b9"}">${fmtPct(c.changeRate)}</td>
      <td style="text-align:right">${fmtNum(c.close)}</td>
      <td style="text-align:right">${fmtNum(buyMax)}</td>
      <td style="text-align:right">${fmtNum(sellMin)}</td>
      <td style="font-size:11px;color:#444">${c.gtBand || "-"}</td>
    </tr>`;
  }).join("");

  const baseUrl = process.env.PUBLIC_URL || "http://localhost:3012";
  const marketState = boardResult.marketState || {};
  const html = `<html><body style="font-family:sans-serif;color:#222">
    <h2 style="color:#b8860b">오늘의 단타 후보 보드</h2>
    <p style="margin:4px 0">분석 기준일: ${analysisDate} 종가 · 후보 ${items.length}종목 (TOP ${topCodes.length} + 추가 ${extraCodes.length})</p>
    ${marketState.label ? `<p style="margin:4px 0;font-size:12px;color:#666">${marketState.label} — ${marketState.desc || ""}</p>` : ""}
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px;margin-top:8px">
      <thead style="background:#f5f5dc">
        <tr>
          <th>종목</th><th>시장</th><th>점수</th><th>거래대금배</th><th>등락</th>
          <th>종가</th><th>매수가(장전)</th><th>매도가(장전)</th><th>구간</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px">
      <a href="${baseUrl}/one-day-surge-board" style="color:#b8860b">▶ 단타 후보 보드 전체 보기 (${baseUrl}/one-day-surge-board)</a>
    </p>
    <hr>
    <p style="font-size:11px;color:#888">
      이 메일은 자동 발송됩니다. 매수 추천이 아닌 관찰 신호입니다.<br>
      매수가/매도가는 보드의 manualTargets(장전 가이드) 값입니다. 실제 대응은 본인의 판단입니다.<br>
      수신거부: {{UNSUBSCRIBE_LINK}}
    </p>
  </body></html>`;

  let sent = 0;
  for (const sub of subscribers) {
    try {
      const personalHtml = html.replace("{{UNSUBSCRIBE_LINK}}",
        `<a href="${baseUrl}/unsubscribe?token=${sub.unsubscribeToken}">수신거부</a>`);
      await mailTransporter.sendMail({
        from: `"한투신호" <${process.env.SMTP_USER}>`,
        to: sub.email,
        subject,
        html: personalHtml,
      });
      sent++;
    } catch (e) {
      console.error(`[1DS메일] ${sub.email} 실패:`, e.message);
    }
  }
  console.log(`[1DS메일] 완료: ${sent}/${subscribers.length}명`);
}

module.exports = { sendOneDaySurgeMail };
