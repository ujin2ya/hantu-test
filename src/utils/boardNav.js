// 보드 네비게이션 helper.
// 9개 보드 HTML 상단에 들어가는 4섹션 nav (🟢 운영 / 🟣 실험 / 📜 과거 / 📊 통합)를
// 한 곳에서 관리한다. 인라인 style 위주에서 class + media query로 전환해
// 모바일에서도 자연스럽게 wrap되도록 구성.
//
// 사용:
//   const { getBoardNavHtml } = require('../../src/utils/boardNav');
//   const navHtml = getBoardNavHtml('/qva-live-watch');  // currentRoute 강조
//   body += navHtml;
//
// currentRoute가 nav 안의 어느 href와 일치하면 그 링크에 `current` class를 붙여 강조.

const SECTIONS = [
  {
    key: 'op',
    label: '🟢 운영 보드',
    color: { bg: 'linear-gradient(90deg,#064e3b 0%,#065f46 100%)', border: '#10b981', label: '#a7f3d0' },
    links: [
      { href: '/qva2-watchlist',  text: '📋 H그룹/VPR' },
      { href: '/qva2-d5-rebreak', text: '🔥 D+5 재돌파' },
      { href: '/qva2-vvi',        text: '🎯 고점 재돌파' },
    ],
  },
  {
    key: 'exp',
    label: '🟣 실험 라인',
    color: { bg: 'linear-gradient(90deg,#1e1b4b 0%,#312e81 100%)', border: '#6366f1', label: '#c4b5fd' },
    links: [
      { href: '/one-day-surge-board',    text: '⚡ 1DS 단타 후보' },
      { href: '/one-day-surge-board-v2', text: '⚡ 1DS 단타 후보 v2' },
      { href: '/nasdaq-theme-watch',     text: '🌎 나스닥 테마 감시' },
      { href: '/qva-live-watch',         text: '⚡ QVA 장중 감시' },
    ],
  },
  {
    key: 'past',
    label: '📜 과거 보드',
    color: { bg: 'linear-gradient(90deg,#1e293b 0%,#334155 100%)', border: '#64748b', label: '#cbd5e1' },
    links: [
      { href: '/qva-watchlist',           text: '📋 H그룹/VPR (구)' },
      { href: '/rebreak',                 text: '🔥 D+5 재돌파 (구)' },
      { href: '/qva-vvi-redefined-board', text: '🎯 고점 재돌파 (구)' },
    ],
  },
  {
    key: 'merged',
    label: '📊 통합 보기',
    color: { bg: 'linear-gradient(90deg,#042f2e 0%,#134e4a 100%)', border: '#14b8a6', label: '#5eead4' },
    links: [
      { href: '/db-board', text: '🗄 DB 신호 운영판' },
    ],
  },
];

const NAV_CSS = `
<style>
  .board-nav { display:flex; flex-direction:column; gap:6px; margin-bottom:14px; }
  .board-nav-row {
    border:1px solid; border-radius:8px; padding:8px 14px;
    display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12.5px;
  }
  .board-nav-row .nav-label {
    font-weight:700; letter-spacing:0.3px; flex-shrink:0;
  }
  .board-nav-row a {
    color:#e0e7ff; text-decoration:none; padding:4px 10px; border-radius:4px;
    background:rgba(255,255,255,0.08); white-space:nowrap; line-height:1.4;
    transition:background 0.15s;
  }
  .board-nav-row a:hover { background:rgba(255,255,255,0.18); }
  .board-nav-row a.current {
    color:#fff; background:rgba(255,255,255,0.22);
    border:1px solid #fff; font-weight:700;
  }
  /* 태블릿 — 라벨은 한 줄 유지, 링크는 한 줄에 자연스럽게 wrap */
  @media (max-width: 768px) {
    .board-nav-row { padding:8px 12px; gap:6px; font-size:12.5px; }
    .board-nav-row a { padding:6px 10px; }
  }
  /* 모바일 — 섹션 라벨을 한 줄 차지하게 두고 링크는 grid처럼 2열로 배치 */
  @media (max-width: 560px) {
    .board-nav-row { padding:8px 10px; gap:6px; }
    .board-nav-row .nav-label { width:100%; margin-bottom:4px; font-size:12px; }
    .board-nav-row a {
      flex:1 1 calc(50% - 6px); text-align:center; padding:7px 8px;
      font-size:12px; min-width:0; overflow:hidden; text-overflow:ellipsis;
    }
  }
  /* 좁은 모바일 — 1열로 풀폭 */
  @media (max-width: 360px) {
    .board-nav-row a { flex:1 1 100%; }
  }
</style>`;

function getBoardNavHtml(currentRoute) {
  const norm = (r) => (r || '').replace(/\/$/, '');
  const cur = norm(currentRoute);
  const rows = SECTIONS.map((sec) => {
    const links = sec.links.map((l) => {
      const isCurrent = norm(l.href) === cur;
      return `<a href="${l.href}"${isCurrent ? ' class="current"' : ''}>${l.text}</a>`;
    }).join('');
    return (
      `<div class="board-nav-row" style="background:${sec.color.bg};border-color:${sec.color.border};">` +
        `<span class="nav-label" style="color:${sec.color.label};">${sec.label}</span>` +
        links +
      `</div>`
    );
  }).join('');
  return NAV_CSS + `<div class="board-nav">${rows}</div>`;
}

module.exports = { getBoardNavHtml, NAV_CSS, SECTIONS };
