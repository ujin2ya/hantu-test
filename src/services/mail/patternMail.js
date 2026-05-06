// 패턴 결과 일일 메일 — admin /admin/send-pattern-mail 또는 18:00 cron(MAIL_CRON_ENABLED)에서 호출.
const nodemailer = require("nodemailer");
const { loadSubscribers } = require("./subscribers");

// nodemailer transporter — SMTP 자격 미설정 시 null (메일 비활성).
const mailTransporter = (process.env.SMTP_USER && process.env.SMTP_PASS)
  ? nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

async function sendPatternMail(result) {
  if (!mailTransporter) return;
  const subscribers = loadSubscribers();
  if (!subscribers.length) return;

  const vviList = (result?.vviCandidates || []).slice(0, 10);
  const dateStr = new Date()
    .toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" })
    .replace(/\. /g, "-").replace(".", "");
  const subject = `[한투신호] VVI 초동 신호 ${vviList.length}종목 (${dateStr})`;

  const rows = vviList.map(c => {
    const s = c.vvi?.signals || {};
    const isStrong = c.vvi?.category === "STRONG_IGNITION";
    return `<tr>
      <td>${isStrong ? "⭐ " : ""}${c.name || c.code}</td>
      <td>${c.market || ""}</td>
      <td style="text-align:right">${c.vvi?.score ?? "-"}</td>
      <td style="text-align:right">${s.valueRatio20 ? s.valueRatio20.toFixed(1) + "배" : "-"}</td>
      <td style="text-align:right">${s.closeLocation != null ? Math.round(s.closeLocation * 100) + "%" : "-"}</td>
      <td style="text-align:right;color:${(s.todayReturn || 0) >= 0 ? "#c0392b" : "#2980b9"}">${s.todayReturn != null ? (s.todayReturn >= 0 ? "+" : "") + s.todayReturn.toFixed(2) + "%" : "-"}</td>
    </tr>`;
  }).join("");

  const baseUrl = process.env.PUBLIC_URL || "http://localhost:3012";
  const html = `<html><body style="font-family:sans-serif;color:#222">
    <h2 style="color:#b8860b">오늘의 VVI 거래대금 초동 신호</h2>
    <p>${dateStr} 종가 기준 · ${vviList.length}종목</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
      <thead style="background:#f5f5dc">
        <tr><th>종목</th><th>시장</th><th>점수</th><th>거래대금배</th><th>종가위치</th><th>등락</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:20px">
      <a href="${baseUrl}/qva-watchlist" style="color:#b8860b">▶ QVA Watchlist 보드 (${baseUrl}/qva-watchlist)</a>
    </p>
    <hr>
    <p style="font-size:11px;color:#888">
      이 메일은 자동 발송됩니다. 매수 추천이 아닌 관찰 신호입니다.<br>
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
      console.error(`[메일발송] ${sub.email} 실패:`, e.message);
    }
  }
  console.log(`[메일발송] 완료: ${sent}/${subscribers.length}명`);
}

module.exports = { mailTransporter, sendPatternMail };
