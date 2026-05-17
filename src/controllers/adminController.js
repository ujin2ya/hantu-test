// /admin/* — 로그인 + 대시보드 + 패턴 트리거.
const fs = require("fs");
const patternScreener = require("../../screeners/pattern-screener");
const {
  setAdminCookie, clearAdminCookie, isAdminAuthed,
} = require("../services/auth/adminAuth");
const path = require("path");
const { loadSubscribers, saveSubscribers, MAX_SUBSCRIBERS } = require("../services/mail/subscribers");
const { sendOneDaySurgeMail, sendOneDaySurgeMailToOne } = require("../services/mail/oneDaySurgeMail");
const { getStocksMasterAge } = require("../services/stocks/stocksLoader");
const { REPORTS_DIR } = require("../utils/paths");
const triggers = require("../services/pattern/adminTriggers");

const ONE_DAY_SURGE_RESULT_PATH = path.join(REPORTS_DIR, "one-day-surge-board-result.json");

function readOneDaySurgeResult() {
  if (!fs.existsSync(ONE_DAY_SURGE_RESULT_PATH)) return null;
  return JSON.parse(fs.readFileSync(ONE_DAY_SURGE_RESULT_PATH, "utf-8"));
}

function getLogin(req, res) {
  if (isAdminAuthed(req)) return res.redirect("/admin");
  res.render("admin/login", { error: null });
}

function postLogin(req, res) {
  const password = String(req.body.password || "");
  if (!process.env.ADMIN_TOKEN || password !== process.env.ADMIN_TOKEN) {
    return res.render("admin/login", { error: "비밀번호가 일치하지 않습니다." });
  }
  setAdminCookie(res, password);
  res.redirect("/admin");
}

function getLogout(req, res) {
  clearAdminCookie(res);
  res.redirect("/admin/login");
}

function getDashboard(req, res) {
  res.render("admin/dashboard", {
    subscribers: loadSubscribers(),
    maxSubscribers: MAX_SUBSCRIBERS,
    flash: req.query.flash || null,
    query: req.query,
    stocksMaster: getStocksMasterAge(),
    patternState: triggers.patternState,
    seededCount: patternScreener.listSeededStocks().length,
  });
}

function postUnsubscribe(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!email) return res.redirect("/admin?flash=missing_email");
  const list = loadSubscribers();
  const idx = list.findIndex((s) => s.email === email);
  if (idx === -1) return res.redirect("/admin?flash=not_found");
  list.splice(idx, 1);
  saveSubscribers(list);
  res.redirect("/admin?flash=removed");
}

async function postSend1dsMailAll(req, res) {
  try {
    const result = readOneDaySurgeResult();
    if (!result) return res.redirect("/admin?flash=no_1ds_result");
    const r = await sendOneDaySurgeMail(result);
    if (r.reason === "no_subscribers") return res.redirect("/admin?flash=no_subscribers");
    if (r.reason === "no_candidates") return res.redirect("/admin?flash=no_1ds_candidates");
    if (r.reason === "no_transporter") return res.redirect("/admin?flash=no_smtp");
    return res.redirect(`/admin?flash=1ds_mail_sent&n=${r.sent}/${r.total}`);
  } catch (e) {
    console.error("[1DS메일·수동] 에러:", e.message);
    return res.redirect("/admin?flash=mail_error");
  }
}

async function postSend1dsMailOne(req, res) {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.redirect("/admin?flash=missing_email");
    const result = readOneDaySurgeResult();
    if (!result) return res.redirect("/admin?flash=no_1ds_result");
    const r = await sendOneDaySurgeMailToOne(result, email);
    if (r.ok) return res.redirect(`/admin?flash=1ds_mail_one_sent&email=${encodeURIComponent(email)}`);
    if (r.reason === "not_found") return res.redirect("/admin?flash=not_found");
    if (r.reason === "no_candidates") return res.redirect("/admin?flash=no_1ds_candidates");
    if (r.reason === "no_transporter") return res.redirect("/admin?flash=no_smtp");
    return res.redirect("/admin?flash=mail_error");
  } catch (e) {
    console.error("[1DS메일·개별] 에러:", e.message);
    return res.redirect("/admin?flash=mail_error");
  }
}

function postPatternSeed(req, res) {
  const r = triggers.startSeed();
  res.redirect(r.ok ? "/admin?flash=pattern_seed_started" : "/admin?flash=pattern_seeding");
}

function postPatternAnalyze(req, res) {
  const r = triggers.startAnalyze();
  res.redirect(r.ok ? "/admin?flash=pattern_analyze_started" : "/admin?flash=pattern_analyzing");
}

function postQvaBacktest(req, res) {
  const r = triggers.startQvaBacktest();
  res.redirect(r.ok ? "/admin?flash=qva_backtest_started" : "/admin?flash=qva_backtest_running");
}

function postRefreshPatternCache(req, res) {
  const r = triggers.refreshPatternCache();
  if (r.ok) res.json({ success: true, message: r.message });
  else res.status(r.message === "이미 분석 중입니다" ? 200 : 500).json({ success: false, message: r.message });
}

function postRefreshWatchlistBoard(req, res) {
  const r = triggers.refreshWatchlistBoard();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRefreshAllBoards(req, res) {
  const r = triggers.refreshAllBoards();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRefresh1dsIntraday(req, res) {
  const r = triggers.refresh1dsIntraday();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRefresh1dsSurvivor1000(req, res) {
  const r = triggers.refresh1dsSurvivor1000();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRegen1dsScannerBoard(req, res) {
  const r = triggers.regen1dsScannerBoard();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

function postRunDailyUpdate(req, res) {
  const r = triggers.runDailyUpdate();
  res.json({ success: r.ok, message: r.message, startedAt: r.startedAt });
}

// GET /admin/db-signals — 보드 신호 히스토리 조회
// 쿼리 파라미터 (1개 필수):
//   ?stockCode=005930
//   ?boardName=ONE_DAY_SURGE
//   ?date=2026-05-15
//   ?signalId=123
// 옵션: &limit=200 (기본), boardName+date 조합 가능
async function getDbSignals(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const { stockCode, boardName, date, signalId, limit } = req.query || {};
    const lim = Math.min(Number(limit || 200), 1000);

    let result;
    if (signalId) {
      const { query } = require('../db/mysql');
      const sig = await query('SELECT * FROM board_signals WHERE id = ?', [Number(signalId)]);
      const outcomes = await query('SELECT * FROM board_signal_outcomes WHERE signal_id = ? ORDER BY horizon_days', [Number(signalId)]);
      const links = await query(
        `SELECT 'out' AS direction, link_type, to_signal_id AS other_id, days_between FROM signal_links WHERE from_signal_id = ?
         UNION ALL
         SELECT 'in' AS direction, link_type, from_signal_id AS other_id, days_between FROM signal_links WHERE to_signal_id = ?`,
        [Number(signalId), Number(signalId)]
      );
      result = { signal: (sig && sig[0]) || null, outcomes, links };
    } else if (stockCode) {
      result = { mode: 'stock', stockCode, signals: await repo.findSignalsByStock(stockCode, { limit: lim }) };
    } else if (boardName && date) {
      result = { mode: 'board+date', boardName, date, signals: await repo.findSignalsByBoard(boardName, { date, limit: lim }) };
    } else if (boardName) {
      result = { mode: 'board', boardName, signals: await repo.findSignalsByBoard(boardName, { limit: lim }) };
    } else if (date) {
      result = { mode: 'date', date, signals: await repo.findSignalsByDate(date, { limit: lim }) };
    } else {
      return res.status(400).json({
        error: 'one of stockCode / boardName / date / signalId is required',
        examples: [
          '/admin/db-signals?stockCode=005930',
          '/admin/db-signals?boardName=ONE_DAY_SURGE',
          '/admin/db-signals?date=2026-05-15',
          '/admin/db-signals?signalId=123',
          '/admin/db-signals?boardName=QVA2_WATCHLIST&date=2026-05-15',
        ],
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─── 3차 조회 API (2026-05-17) ────────────────────────────────────────────
// 모두 requireAdmin 게이트 뒤. JSON 응답.

// GET /admin/db-signals/overlap?date=YYYY-MM-DD&minBoards=2&includeFailed=false&limit=100
//   같은 날짜에 2+ board_name에 동시 등장한 종목
async function getDbSignalsOverlap(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const { date, minBoards, includeFailed, limit } = req.query || {};
    if (!date) return res.status(400).json({ error: 'date is required', example: '/admin/db-signals/overlap?date=2026-05-15&minBoards=2' });
    const rows = await repo.findOverlap(date, {
      minBoards: Number(minBoards || 2),
      includeFailed: includeFailed === 'true' || includeFailed === '1',
      limit: Number(limit || 100),
    });
    res.json({ date, minBoards: Number(minBoards || 2), includeFailed: !!(includeFailed === 'true' || includeFailed === '1'), count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/repeated?days=20&minCount=2&limit=100
async function getDbSignalsRepeated(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const { days, minCount, limit } = req.query || {};
    const rows = await repo.findRepeated({
      days: Number(days || 20),
      minCount: Number(minCount || 2),
      limit: Number(limit || 100),
    });
    res.json({ days: Number(days || 20), minCount: Number(minCount || 2), count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/stock/:stockCode/history?days=180
async function getDbSignalsStockHistory(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const code = (req.params && req.params.stockCode) || '';
    if (!/^\d{4,6}$/.test(code)) return res.status(400).json({ error: 'stockCode must be 4-6 digits', example: '/admin/db-signals/stock/005930/history?days=180' });
    const days = Number((req.query && req.query.days) || 180);
    const result = await repo.findStockHistory(code, { days });
    res.json({ days, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/performance?boardName=QVA_WATCHLIST&signalKind=QVA_NEW&horizon=5&days=60
async function getDbSignalsPerformance(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const { boardName, signalKind, horizon, days } = req.query || {};
    if (!boardName) return res.status(400).json({
      error: 'boardName is required',
      example: '/admin/db-signals/performance?boardName=QVA_WATCHLIST&signalKind=QVA_NEW&horizon=5&days=60',
    });
    const result = await repo.findPerformance({
      boardName,
      signalKind: signalKind || null,
      horizon: Number(horizon || 5),
      days: Number(days || 60),
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/link-summary?days=180
async function getDbSignalsLinkSummary(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const days = Number((req.query && req.query.days) || 180);
    const rows = await repo.findLinkSummary({ days });
    res.json({ days, count: rows.length, link_types: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-signals/today-focus?date=YYYY-MM-DD&minBoards=1&limit=50
async function getDbSignalsTodayFocus(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const { date, minBoards, limit } = req.query || {};
    if (!date) return res.status(400).json({ error: 'date is required', example: '/admin/db-signals/today-focus?date=2026-05-15' });
    const rows = await repo.findTodayFocus(date, {
      minBoards: Number(minBoards || 1),
      limit: Number(limit || 50),
    });
    res.json({
      date,
      minBoards: Number(minBoards || 1),
      note: '매수 추천 아님 — priority_score는 (board_count×10 + positive_kind×5 - failed_kind×8 + recent_repeat×3 + strong_kind×10) 단순 합산',
      count: rows.length,
      rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /admin/db-board-dashboard?date=YYYY-MM-DD&days=60&limit=20
// 4차 (2026-05-17): JSON API들을 HTML로 한 화면에 묶은 최소 관리자 대시보드.
// 섹션별 try/catch — 한 섹션 실패해도 페이지 전체는 살아남음.
async function getDbBoardDashboard(req, res) {
  try {
    const repo = require('../db/boardSignalRepository');
    const labels = require('../db/boardSignalLabels');
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayYMD = `${yyyy}-${mm}-${dd}`;

    const date  = (req.query && req.query.date)  || todayYMD;
    const days  = Math.max(1, Number((req.query && req.query.days)  || 60) | 0);
    const limit = Math.max(5, Math.min(Number((req.query && req.query.limit) || 50) | 0, 100));
    const stockSearch = (req.query && req.query.stockCode) ? String(req.query.stockCode).trim() : null;

    // 섹션별로 격리 — 한 곳 실패해도 다른 섹션은 표시되어야 함
    const sections = {};
    const errors = {};

    async function safe(name, fn) {
      try { sections[name] = await fn(); }
      catch (e) { errors[name] = e.message || String(e); sections[name] = null; }
    }

    await safe('todayFocus', async () => {
      const rows = await repo.findTodayFocus(date, { minBoards: 1, limit });
      // boards 문자열 "BOARD/KIND, BOARD/KIND, ..." 을 파싱해서 stage_score 합산
      for (const r of rows) {
        const items = String(r.boards || '').split(', ').filter(Boolean);
        let stageScore = 0;
        for (const it of items) {
          const [bn, sk] = it.split('/', 2);
          stageScore += labels.getBoardKindWeight(bn, sk);
        }
        r.stage_score = stageScore;
      }
      return rows;
    });
    await safe('overlap',    () => repo.findOverlap(date, { minBoards: 2, includeFailed: false, limit }));
    await safe('repeated',   () => repo.findRepeated({ days, minCount: 2, limit }));

    // 보드별 성과 — 고정 6 조합
    const PERFORMANCE_CASES = [
      { board_name: 'QVA_WATCHLIST',  signal_kind: 'QVA_NEW',         horizon: 5 },
      { board_name: 'QVA_WATCHLIST',  signal_kind: 'VVI_FIRED',       horizon: 5 },
      { board_name: 'QVA2_WATCHLIST', signal_kind: 'QVA2_NEW',        horizon: 5 },
      { board_name: 'QVA2_VVI',       signal_kind: 'VVI2_FIRED',      horizon: 5 },
      { board_name: 'HGROUP_REBREAK', signal_kind: null,              horizon: 5 },
      { board_name: 'ONE_DAY_SURGE',  signal_kind: 'ATTACK_TOP',      horizon: 1 },
    ];
    await safe('performance', async () => {
      const out = [];
      for (const c of PERFORMANCE_CASES) {
        try {
          out.push(await repo.findPerformance({ boardName: c.board_name, signalKind: c.signal_kind, horizon: c.horizon, days }));
        } catch (e) { out.push({ board_name: c.board_name, signal_kind: c.signal_kind, horizon_days: c.horizon, error: e.message }); }
      }
      return out;
    });

    await safe('linkSummary', () => repo.findLinkSummary({ days }));
    await safe('dbSummary',   () => repo.findDbSummary());

    // ─── 사용자 조합 필터 (5차, 2026-05-17) ─────────────────────────────
    function arr(v) {
      if (v == null) return [];
      if (Array.isArray(v)) return v.filter(Boolean);
      return String(v).split(',').map(s => s.trim()).filter(Boolean);
    }
    const presetKey = (req.query && req.query.preset) || null;
    const overrides = {
      includeBoard: req.query.includeBoard !== undefined ? arr(req.query.includeBoard) : null,
      excludeBoard: req.query.excludeBoard !== undefined ? arr(req.query.excludeBoard) : null,
      includeKind:  req.query.includeKind  !== undefined ? arr(req.query.includeKind)  : null,
      excludeKind:  req.query.excludeKind  !== undefined ? arr(req.query.excludeKind)  : null,
      matchMode:    req.query.matchMode || null,
    };
    const filterApplied = !!(presetKey || overrides.includeBoard || overrides.excludeBoard ||
                             overrides.includeKind || overrides.excludeKind || overrides.matchMode);
    const filterMerged = labels.mergePresetWithOverrides(presetKey, overrides);
    const filterMinBoardCount  = Math.max(0, Number(req.query.minBoardCount  || 0) | 0);
    const filterMinRepeatCount = Math.max(0, Number(req.query.minRepeatCount || 0) | 0);

    let filterResolved = null;
    if (filterApplied) {
      filterResolved = {
        ...filterMerged,
        date: req.query.filterDate || null,     // 별도 filterDate 또는 null (= days 사용)
        days,
        limit,
        minBoardCount: filterMinBoardCount,
        minRepeatCount: filterMinRepeatCount,
      };
      await safe('filteredSignals', async () => {
        const rows = await repo.findFilteredSignals(filterResolved);
        // stage_score 계산 (today-focus와 동일 방식)
        for (const r of rows) {
          const items = String(r.raw_boards || '').split(', ').filter(Boolean);
          let stageScore = 0;
          for (const it of items) {
            const [bn, sk] = it.split('/', 2);
            stageScore += labels.getBoardKindWeight(bn, sk);
          }
          r.stage_score = stageScore;
        }
        rows.sort((a, b) => (b.stage_score - a.stage_score) || (b.signal_count - a.signal_count));
        return rows;
      });
      // 0건일 때 모순 진단
      if (sections.filteredSignals && sections.filteredSignals.length === 0) {
        sections.filterDiagnostics = labels.diagnoseFilterMismatch(
          filterMerged.includeBoard || [],
          filterMerged.includeKind || [],
          filterMerged.matchMode
        );
      }
    }

    // 종목 검색 — 입력 있으면 history 결과 직접 표시
    let stockHistory = null;
    if (stockSearch && /^\d{4,6}$/.test(stockSearch)) {
      try { stockHistory = await repo.findStockHistory(stockSearch, { days: 180 }); }
      catch (e) { errors.stockHistory = e.message; }
    }

    res.render('admin/db-board-dashboard', {
      date, days, limit,
      todayYMD,
      stockSearch, stockHistory,
      sections, errors,
      negativeKinds: repo.NEGATIVE_KINDS,
      positiveKinds: repo.POSITIVE_KINDS,
      // 라벨 헬퍼 (EJS에서 사용)
      formatBoardName: labels.formatBoardName,
      formatSignalKind: labels.formatSignalKind,
      formatBoardKind: labels.formatBoardKind,
      getBoardKindWeight: labels.getBoardKindWeight,
      // 5차 필터
      FILTER_PRESETS: labels.FILTER_PRESETS,
      BOARD_LABELS: labels.BOARD_LABELS,
      KIND_LABELS: labels.KIND_LABELS,
      BOARD_KIND_MATRIX: labels.BOARD_KIND_MATRIX,
      filterApplied,
      filterPreset: presetKey,
      filterResolved,
      filterMinBoardCount,
      filterMinRepeatCount,
    });
  } catch (e) {
    res.status(500).send(`<h1>대시보드 로딩 실패</h1><pre>${(e && e.stack) || e}</pre>`);
  }
}

module.exports = {
  getLogin, postLogin, getLogout,
  getDashboard, postUnsubscribe,
  postSend1dsMailAll, postSend1dsMailOne,
  postPatternSeed, postPatternAnalyze, postQvaBacktest,
  postRefreshPatternCache, postRefreshWatchlistBoard, postRefreshAllBoards, postRefresh1dsIntraday, postRefresh1dsSurvivor1000, postRegen1dsScannerBoard, postRunDailyUpdate,
  getDbSignals,
  getDbSignalsOverlap,
  getDbSignalsRepeated,
  getDbSignalsStockHistory,
  getDbSignalsPerformance,
  getDbSignalsLinkSummary,
  getDbSignalsTodayFocus,
  getDbBoardDashboard,
};
