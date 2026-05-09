# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 명령어

- 의존성 설치: `npm install`
- Python 의존성 설치: `python -m venv .venv && .venv\Scripts\pip install -r requirements.txt` (Windows) — pykrx/pandas 기반 시드/갱신 스크립트용
- 웹 앱 실행: `node app.js` (포트는 `PORT` 환경변수, 기본값 `3012`). app.js는 부트스트랩 전용이고 라우터/서비스/cron은 `src/` 하위.
- 종목 마스터 재생성: `npm run generate-stocks` (`master/`의 zip을 읽어 `stocks.json` 작성)
- 일일 갱신을 수동 트리거: `node run-daily-analysis.js` (또는 `/admin/run-daily-update`)
- QVA 운영 보드 재생성: `node qva-watchlist-board.js` → `qva-watchlist-board.html` 생성. 라우트 `/qva-watchlist`가 이 정적 HTML을 서빙
- D+5 재돌파 보드/심층/수급 백테스트 재생성: `node hgroup-rebreak-operation-board.js`, `node hgroup-rebreak-deep-dive-report.js`, `node hgroup-rebreak-flow-backtest.js` → `reports/hgroup-rebreak-*-result.{html,json}` 생성. 라우트는 이 파일을 sendFile만 함
- 1-Day Surge Board(단타 관심 후보) 재생성: `node one-day-surge-board.js` → `reports/one-day-surge-board-result.{html,json}` 생성. 라우트 `/one-day-surge-board`가 sendFile만 함
- 1-Day Surge 다음날 검증 보고서: `node one-day-surge-nextday-validation-report.js` → `reports/one-day-surge-nextday-validation-result.{html,json}` 생성. 환경변수 `VALIDATION_DAYS`(기본 60), `VALIDATION_MAX_STOCKS`(기본 무제한) 지원
- 1DS GT 후보 분봉 백필: `node collect-1ds-intraday.js [--target-date YYYYMMDD | --from YYYYMMDD --to YYYYMMDD | --from-board]` → `data/intraday/1ds/{date}/{code}.json`에 09:00~10:00 분봉 저장. KIS `FHKST03010230`(과거 분봉) 기반, 멱등 저장 (이미 있으면 skip). 환경변수 대신 CLI 플래그: `--window-days`(기본 40), `--groups`, `--top-per-day`, `--sleep`(기본 350ms), `--retry`(기본 2), `--end-hour`(기본 100000), `--dry-run`, `--from-board`. **`--from-board`는 라이브 운영용** — `reports/one-day-surge-board-result.json`의 `priorityRanked.mainPoolCodes`만 읽어 그 코드들(~15~25개)에 한해 수집. target-date를 보드의 analysisDate로 자동 설정. 09:31 cron이 이 모드로 호출. 누락 로그는 `reports/one-day-surge-intraday-missing.json`에 누적
- 1DS ENTRY_CONFIRM 연구 보고서: `node one-day-surge-entry-confirm-report.js` → `reports/one-day-surge-entry-confirm-result.{html,json}` 생성. 라우트 `/one-day-surge-entry-confirm`. 환경변수 `ENTRY_VALIDATION_DAYS`(기본 40), `ENTRY_GROUPS`(기본 BALANCED-GT,LIGHT-GT,MID-CAP-GT,MOM-RISK). 분봉 데이터는 `data/intraday/1ds/`에서 read.
- 1DS ENTRY 날짜별 운영형 백테스트: `node one-day-surge-entry-daily-backtest-report.js` → `reports/one-day-surge-entry-daily-backtest-result.{html,json}` 생성. 라우트 `/one-day-surge-entry-daily-backtest`. 환경변수 `ENTRY_BACKTEST_DAYS`(기본 40). ENTRY_CONFIRM 인프라(generateGtEventsByDate, applyEntryConditions, computeOutcomes, summarizeBucket) 재사용. SAFE_REBREAK / BALANCED_REBREAK / LIGHT_REBREAK / CLEAN_REBREAK / RISK_REBREAK / PREV_HIGH_SPIKE 6개 전략을 날짜별로 simulate.
- QVA 고점 재돌파 후보 보드 (새 VVI 정의): `node qva-vvi-redefined-board.js` → `reports/qva-vvi-redefined-board-result.{html,json}` 생성. 라우트 `/qva-vvi-redefined-board`. 환경변수 `VVI_LOOKBACK_DAYS`(기본 20), `VVI_TOP_LIMIT`(기본 10). 새 VVI 정의 = QVA 고가 재돌파 + QVA 이상 거래량 + QVA 이상 거래대금. 기존 VVI/QVA 보드와 별개의 신규 보드. **이 보드 관련 새 파일은 더 만들지 말고 동일 파일에 섹션 추가/덮어쓰기로 관리.**
- 새 VVI 정의 1차 백테스트: `node qva-vvi-redefined-backtest-report.js` → `reports/qva-vvi-redefined-backtest-result.{html,json}` 생성. 라우트 `/qva-vvi-redefined-backtest`. 환경변수 `BACKTEST_LOOKBACK_DAYS`(기본 60). 5 그룹(A~E) 비교 + D+1/3/5/10/20 outcome (평균 최고가/최저가/종가, 도달률, 종가 양수율) + TOP 20 + WORST 20 + 자동 결론 5문항. **이 파일 1개만 사용 — v2/final/new 사본 만들지 않음. 새 실험은 동일 파일에 섹션 추가/덮어쓰기.**
- **QVA2 실험 라인 (기존 운영 3 보드의 1:1 mirror, 기존 QVA/VVI/VPR 무수정)**: 기존 QVA(`calculateRedefinedQVA`)는 약세 마감을 `notWeakClose` 필터로 컷하는 안정형. QVA2는 그 반대편 — "종가는 약했지만 거래대금이 강하게 들어왔고 장중 회복 흔적이 있는" 후보를 별도로 잡는 실험. 보드 3개는 기존 `/qva-watchlist`, `/rebreak`, `/qva-vvi-redefined-board`의 1:1 mirror로 만든다.
  - 공통 모듈: [qva2-screener.js](qva2-screener.js) — `calculateQVA2(rows, idx, meta, overrides)` + `findQVA2Events()` + `findVvi2AfterQva2(rows, qva2Idx, maxDays)`. 임계값은 `QVA2_CONFIG` / `VVI2_CONFIG`에서 단일 관리.
  - QVA2 H그룹/VPR 보드 (mirror of /qva-watchlist): `node qva2-watchlist-board.js` → `reports/qva2-watchlist-board.{html,json}`. 라우트 `/qva2-watchlist`. 종목당 단일 funnel 상태(QVA2_NEW / QVA2_TRACKING / VVI2_FIRED / BREAKOUT_SUCCESS / FAILED) + 보조 태그(PRICE_HOLD / LOW_RISING / VALUE_REACTIVATION). TRACKING_DAYS=20, RECENT_BREAKOUT_DAYS=5, RECENT_FAILED_DAYS=5, EXIT_THRESHOLD_PCT=-15. 환경변수 `QVA2_MAX_MARKETCAP`(기본 5e12).
  - QVA2 D+5 재돌파 운용보드 (mirror of /rebreak): `node qva2-d5-rebreak-board.js` → `reports/qva2-d5-rebreak-board.{html,json}`. 라우트 `/qva2-d5-rebreak`. 입력은 `qva2-watchlist-board.json`의 BREAKOUT_SUCCESS 후보. D+0 = BREAKOUT 일자, D+1~D+5 동안 D+0 고가 종가 재돌파 추적. 상태: CLOSE_REBREAK / TODAY_INITIAL_BREAKOUT / INTRADAY_PUSHBACK / BREACH_NO_RECOVER / NO_REBREAK. 환경변수 `QVA2_REBREAK_MAX_DAYS`(기본 5).
  - QVA2 고점 재돌파 보드 (mirror of /qva-vvi-redefined-board): `node qva2-vvi-board.js` → `reports/qva2-vvi-board.{html,json}`. 라우트 `/qva2-vvi`. QVA2 발생일의 (high, volume, value)를 기준으로 첫 재돌파일 탐지. `qva2-watchlist-board.json`의 `allEvents`를 입력으로 사용. 환경변수 `VVI2_LOOKBACK_DAYS`(기본 30), `VVI2_TOP_LIMIT`(기본 30).
  - QVA2 검증 보고서: `node qva2-validation-report.js` → `reports/qva2-validation-result.{html,json}`. 라우트 `/qva2-validation`. 전 종목 × 과거 N거래일 시뮬레이션 → D+1/3/5/10/20 종가, MFE/MAE D+5/10/20, +5/10/15/20/30% 도달률을 등급별·점수구간별·약세폭별·거래대금배율별·종가위치별·시총별 cohort로 비교. 환경변수 `QVA2_VALIDATION_DAYS`(기본 180), `QVA2_VALIDATION_MAX_STOCKS`(기본 0=무제한), `QVA2_VALIDATION_MAX_MARKETCAP`(기본 5e12). **기존 reports/qva-* 파일은 읽기만, 수정 안 함.**
  - 의존성 순서 (16:35 cron + admin trigger): qva2-watchlist → qva2-d5-rebreak → qva2-vvi (각자 독립이지만 d5-rebreak이 watchlist json을 read하므로 순서 유지).
  - 컨트롤러/라우터: [src/controllers/qva2Controller.js](src/controllers/qva2Controller.js), [src/routes/qva2Routes.js](src/routes/qva2Routes.js). [src/routes/index.js](src/routes/index.js)에 mount.
  - 기존 10개 운영 보드의 HTML 상단에 보라색 QVA2 nav banner를 추가했다 (보드 generator의 HTML 템플릿에 inline). 기존 nav/데이터/조건은 무수정 — 배너만 nav 위에 1줄 inject.
  - **임계값 튜닝은 `qva2-screener.js`의 `QVA2_CONFIG`만 수정**. 보드 3개 모두 동일 screener를 import하므로 단일 진입점에서 동기화됨. 새 파일 만들지 말고 같은 파일에 섹션 추가/덮어쓰기로 관리. ❌ qva2-vpr-board.js는 더 이상 사용하지 않음 (D+5 재돌파로 대체됨, 2026-05).
- **운영 서버 캐시 동기화 (push 전 필수)**: `bash scripts/sync-remote-cache.sh` — 운영 서버의 `cache/pattern-result.json` + `cache/flow-history/` + `cache/stock-charts-long/`를 로컬로 받는다. 이유는 [push 절차](#push-절차) 참고.

테스트, 린터, 빌드 단계는 구성되어 있지 않다. 운영 배포는 GitHub Actions(`.github/workflows/deploy.yml`)가 ydata.co.kr 서버에 SSH로 push해 PM2(`hantu-test` 프로세스)로 재기동한다.

## push 절차

코드 변경을 운영 서버에 배포하려면 다음 순서를 따른다:

1. **운영 서버 캐시를 먼저 동기화**: `bash scripts/sync-remote-cache.sh`
2. 캐시 변경이 있으면 `git add cache/...` → `git commit`
3. 코드 변경 commit
4. `git push`

**왜 이 순서가 필요한가?**

운영 서버의 cron이 매일 16:10 / 16:20 / 16:35 일일 업데이트로 `cache/pattern-result.json`, `cache/flow-history/`, `cache/stock-charts-long/`, `qva-watchlist-board.{html,json}`, `reports/hgroup-rebreak-*` 등을 갱신한다. 이 캐시는 `.gitignore` 화이트리스트로 git에 추적되지만, 운영 서버 자체에서 push하지 않는다.

GitHub Actions deploy(`deploy.yml`)는 운영 서버에서 `git fetch origin main && git reset --hard origin/main`을 실행한다. **`reset --hard`는 운영 서버의 모든 변경(캐시 포함)을 git의 origin/main 상태로 강제 일치**시키므로, push 전에 운영 서버의 최신 cache를 로컬 git으로 가져오지 않으면 deploy 시 운영 서버 cache가 옛날 git 버전으로 덮어써진다.

`sync-remote-cache.sh`는 plink/pscp(PuTTY)로 ssh 접속해 운영 서버 cache를 tar.gz로 묶어 받는다. 비밀번호는 `.env`의 `REMOTE_SSH_PASSWORD`에서 읽는다.

`bash scripts/sync-remote-cache.sh --commit "메시지"` 형태로 실행하면 자동 commit까지 한 번에 한다 (push는 별도).

## 필수 환경변수

`.env` 파일(`dotenv`로 로드)에 다음을 정의한다 (배포 환경에서는 GitHub Actions secrets로 주입):

**KIS API (필수)**
- `KIS_APP_KEY`, `KIS_APP_SECRET` — 한국투자증권 자격증명
- `KIS_BASE_URL` — 실전 / 모의 호스트

**외부 API**
- `GEMINI_API_KEY` — Gemini API. AI 코멘트(`/ai/comment`)에 사용. 미설정 시 `/ai/comment`가 503 반환
- `GEMINI_MODEL` (기본 `gemini-2.5-flash-lite`) — 모델 오버라이드
- `DART_API_KEY` — 공시·재무 조회 (`dart-fetcher.js`, `seed-financials-history.js`, pattern-screener의 펀더멘탈 스코어). 미설정 시 공시·재무 단계 skip

**인증/접근 제어**
- `SITE_PASSWORD` — 사이트 전체 비밀번호 게이트 (`/login`이 검증, 쿠키로 유지). 운영 환경에서만 활성
- `PRIVATE_SITE_TOKEN` — 1차 게이트. `NODE_ENV=production`에서 활성. 토큰 미보유 클라이언트는 모든 경로에 대해 **404로 위장**. `?k=토큰`으로 진입 시 1년짜리 쿠키를 발급. `SITE_PASSWORD`보다 먼저 통과해야 함
- `ADMIN_TOKEN` — `/admin/*` 라우트 게이트 (`/admin/login`이 검증)
- `NODE_ENV=production` — 게이트와 secure 쿠키 활성화

**메일/구독**
- `SMTP_USER`, `SMTP_PASS` — Gmail SMTP. 둘 다 설정돼야 `mailTransporter`가 켜짐
- `PUBLIC_URL` — 메일 본문의 unsubscribe 링크 base (기본 `http://localhost:3012`)
- `MAIL_CRON_ENABLED=1` — 평일 09:30:30 1DS 단타 후보 메일 cron 활성화

**튜닝/오버라이드**
- `PATTERN_MAX_MARKETCAP` (기본 5천억), `PATTERN_MIN_MARKETCAP` (기본 50억) — `naver-fetcher.js`의 시드 시총 필터. 운영은 9천억으로 ramp
- `ANALYSIS_DATE` — `pattern-screener.js`가 분석 기준일을 강제 (재현 백테스트용)
- `PORT` — 웹 서버 포트

**운영 서버 SSH (`scripts/sync-remote-cache.sh`용)**
- `REMOTE_SSH_PASSWORD` — 필수. plink/pscp가 운영 서버에 접속할 때 사용
- `REMOTE_SSH_HOST` (기본 `hajiny.co.kr`), `REMOTE_SSH_PORT` (기본 `1027`), `REMOTE_SSH_USER` (기본 `eugene`), `REMOTE_SSH_PATH` (기본 `/home/eugene/workspace/hantu-test`) — 오버라이드 가능

## 아키텍처

단일 프로세스 Node/Express 앱이 KIS Open Trading API, 네이버 모바일 API, DART API, Gemini를 조합해서 한국 주식(KOSPI/KOSDAQ)을 점수화·스크리닝한다. 결과는 정적 HTML과 EJS 템플릿으로 렌더링한다.

크게 세 개의 축이 한 코드베이스에 공존한다:
1. **패턴 스크리너 + 일일 분석 캐시** (`pattern-screener.js`, QVA/VVI/CSB/Rebound/Trend Template/펀더멘탈 등을 결합한 5,000줄급 단일 모듈) → `cache/pattern-result.json`
2. **운영 보드** — 패턴 결과를 funnel 단계별 운용 화면으로 재가공
   - QVA Watchlist Board (`qva-watchlist-board.js` → `/qva-watchlist`)
   - D+5 재돌파 운용 보드 가족 (`hgroup-rebreak-*.js` → `/rebreak`, `/rebreak-deep`, `/d5-rebreak-flow`, `/d5-rebreak/:code`)
   - 1-Day Surge Board — **QVA/VVI/BMS와 분리된 독립 단타 후보 보드** (`one-day-surge-board.js` → `/one-day-surge-board`). 본체 점수에는 QVA/VVI/BMS 조건을 섞지 않고, QVA/VVI 이력은 카드 참고 태그로만 부착.
3. **일일 갱신 파이프라인** (`update-flow-daily.js`, `update-daily-pykrx.py`, `run-daily-analysis.js` + node-cron 4개)

운영 UI(관리자 대시보드, 구독 메일)는 위 세 축이 만든 결과물 위에 얇게 얹힌다.

### 부트스트랩과 src/ 분리 (3698f61e 이후)

[app.js](app.js)는 약 50줄짜리 부트스트랩이며 다음만 한다:
1. `dotenv` 로드 (override=true)
2. express 인스턴스 생성, view engine 설정
3. 게이트 미들웨어 mount: `privateTokenGate` → `sitePasswordGate`
4. `src/routes/index.js`의 라우터 mount
5. `loadStocks()`로 종목 마스터 메모리 적재
6. `registerSchedules()`로 cron 4개 등록
7. `app.listen(PORT)`

비즈니스 로직은 모두 `src/` 하위로 이동했다:

| 디렉토리 | 역할 |
|---------|------|
| [src/routes/](src/routes/) | URL → 컨트롤러 매핑. `index.js`가 `auth/admin/qva/rebreak/ai` 라우터를 합쳐 export |
| [src/controllers/](src/controllers/) | 라우트 핸들러. 컨트롤러는 fs/render/sendFile만 하고 무거운 일은 services로 위임 |
| [src/services/](src/services/) | 도메인 로직 — `ai/`, `auth/`, `dart/`, `kis/`, `mail/`, `news/`, `pattern/`, `stocks/` |
| [src/middleware/](src/middleware/) | `siteGate.js` — `privateTokenGate` + `sitePasswordGate` |
| [src/utils/](src/utils/) | `paths.js` (모든 파일 경로 한 곳에서 export), `sleep.js` |

**경로는 항상 [src/utils/paths.js](src/utils/paths.js)에서 import**해서 쓴다. `__dirname` 기반 path 계산을 src/ 하위 모듈에서 직접 하지 말 것 — 디렉토리 깊이가 달라지면 깨진다.

### 라우트 맵

| 메서드 / 경로 | 컨트롤러 | 설명 |
|---------------|----------|------|
| `GET /` | qvaController.getBoard (redirect) | `/qva-watchlist`로 redirect |
| `GET /qva-watchlist` | qvaController.getBoard | `qva-watchlist-board.html` sendFile |
| `GET /qva-watchlist-board` | (redirect) | `/qva-watchlist`로 |
| `GET /rebreak`, `/d5-rebreak-board` | rebreakController (redirect) | `/hgroup-rebreak-operation`로 |
| `GET /hgroup-rebreak-operation` | rebreakController.getOperationBoard | D+5 재돌파 운용 보드 HTML sendFile |
| `GET /rebreak-deep`, `/d5-rebreak-deep-dive` | (redirect) | `/hgroup-rebreak-deep-dive`로 |
| `GET /hgroup-rebreak-deep-dive` | rebreakController.getDeepDive | 심층 검증 보고서 sendFile |
| `GET /d5-rebreak-flow`, `/rebreak-flow` | rebreakController.getFlowBacktest | 수급 결합 백테스트 보고서 sendFile |
| `GET /d5-rebreak/:code` | rebreakController.getDetail | 종목 상세 — JSON에서 항목 찾기 + 차트 60일 + KIS 실시간 가격 + `d5-rebreak-detail.ejs` 렌더 |
| `GET /one-day-surge-board` | oneDaySurgeController.getBoard | 단타 관심 후보 보드 HTML sendFile (`reports/one-day-surge-board-result.html`) |
| `GET /one-day-surge`, `/ods` | (redirect) | `/one-day-surge-board`로 |
| `GET /one-day-surge-validation` | oneDaySurgeController.getValidation | 다음날 검증 백테스트 보고서 HTML sendFile (`reports/one-day-surge-nextday-validation-result.html`) |
| `GET /ods-validation` | (redirect) | `/one-day-surge-validation`로 |
| `GET /one-day-surge-entry-confirm` | oneDaySurgeController.getEntryConfirm | 분봉 ENTRY_CONFIRM 연구 보고서 HTML sendFile (`reports/one-day-surge-entry-confirm-result.html`) |
| `GET /ods-entry-confirm` | (redirect) | `/one-day-surge-entry-confirm`로 |
| `GET /one-day-surge-entry-daily-backtest` | oneDaySurgeController.getEntryDailyBacktest | 날짜별 운영형 백테스트 보고서 HTML sendFile (`reports/one-day-surge-entry-daily-backtest-result.html`) |
| `GET /ods-entry-daily-backtest` | (redirect) | `/one-day-surge-entry-daily-backtest`로 |
| `GET /qva-vvi-redefined-board` | qvaVviRedefinedController.getRedefinedVviBoard | 새 VVI 정의 (QVA 고가 + 거래량 + 거래대금 동시 재돌파) 후보 보드 HTML sendFile (`reports/qva-vvi-redefined-board-result.html`) |
| `GET /qva-vvi-redefined-backtest` | qvaVviRedefinedController.getRedefinedVviBacktest | 새 VVI 정의 1차 백테스트 HTML sendFile (`reports/qva-vvi-redefined-backtest-result.html`) |
| `GET /qva-vvi-redefined/:code` | qvaVviRedefinedController.getRedefinedVviStockDetail | 새 VVI 종목 상세 페이지 — naver 메타 + KIS 실시간 + 60일 SVG 차트 + DART 재무 + Naver 뉴스 8건 + DART 공시 10건 + 새 VVI funnel 위치 + AI 분석 버튼. `views/qva-vvi-redefined-detail.ejs` 렌더. 보드 카드의 종목명이 이 라우트로 링크 |
| `POST /qva-vvi-redefined/:code/ai` | qvaVviRedefinedController.postCompanyAnalysis | 상세 페이지 AI 버튼이 fetch로 호출. Gemini가 기업분석/사업내용/최근이슈 3섹션 생성 (in-memory 30분 TTL 캐시). `geminiCompanyAnalysis.js` |
| `GET /qva2-watchlist` | qva2Controller.getWatchlistBoard | QVA2 H그룹/VPR 보드 sendFile (`reports/qva2-watchlist-board.html`). 기존 `/qva-watchlist`의 funnel 구조 mirror. 실험 라인 |
| `GET /qva2-d5-rebreak` | qva2Controller.getD5RebreakBoard | QVA2 D+5 재돌파 운용보드 sendFile (`reports/qva2-d5-rebreak-board.html`). 기존 `/rebreak`의 mirror, 입력은 qva2-watchlist의 BREAKOUT_SUCCESS. 실험 라인 |
| `GET /qva2-vvi` | qva2Controller.getVviBoard | QVA2 고점 재돌파 보드 sendFile (`reports/qva2-vvi-board.html`). 기존 `/qva-vvi-redefined-board` mirror. 실험 라인 |
| `GET /qva2-validation` | qva2Controller.getValidation | QVA2 검증 보고서 sendFile (`reports/qva2-validation-result.html`). 실험 라인 |
| `GET /stock/:code` | stockController.getStockDetail | 보드 어디서든 종목명 클릭 시 떠오르는 단순 종목 상세 페이지. naver/stocks.json 메타 + KIS 실시간 가격 + 60일 SVG 차트 + 보드 funnel 멤버십(QVA/D+5재돌파/1DS). `views/stock-detail.ejs` 렌더 |
| `POST /ai/comment` | aiController.postComment | Gemini 호출. `/d5-rebreak/:code` 페이지가 lazy 호출 (단타·스윙용 4섹션) |
| `GET/POST /login`, `GET /unsubscribe` | authController | 사이트 비밀번호 게이트, 메일 unsubscribe |
| `GET/POST /admin/login`, `GET /admin/logout` | adminController | 관리자 인증 |
| `GET /admin` | adminController.getDashboard | 대시보드 (구독자 / stocks 마스터 / 패턴 상태) |
| `POST /admin/unsubscribe` | adminController.postUnsubscribe | 관리자 수동 구독 해제 |
| `POST /admin/send-1ds-mail` | adminController.postSend1dsMailAll | `reports/one-day-surge-board-result.json` 기반 1DS 단타 메일을 **전체 구독자**에게 즉시 발송 (대시보드의 "📧 전체 구독자에게 1DS 메일 발송" 버튼) |
| `POST /admin/send-1ds-mail-one` | adminController.postSend1dsMailOne | 같은 1DS 메일을 **특정 구독자 한 명**에게만 발송 (구독자 그리드 행의 envelope 아이콘 버튼). `email` form field로 대상 지정 |
| `POST /admin/pattern/seed`, `/admin/pattern/analyze`, `/admin/backtest/qva` | adminController + adminTriggers | 패턴 시드/분석/QVA 백테스트 비동기 트리거 |
| `POST /admin/refresh-pattern-cache` | adminController | pattern-result.json 강제 재생성 (JSON 응답) |
| `POST /admin/refresh-watchlist-board` | adminController | `qva-watchlist-board.js` 만 강제 재실행 |
| `POST /admin/refresh-all-boards` | adminController.postRefreshAllBoards | **전체 보드 갱신** — `adminTriggers.BOARD_SCRIPTS` 8개를 백그라운드 순차 실행 (QVA + 재돌파 × 3 + 1DS + QVA2 × 3). cron 16:35와 동일한 sequence를 admin에서 트리거. `patternState.refreshingAllBoards` / `allBoardsCurrent` / `allBoardsResults`로 진행 추적 |
| `POST /admin/refresh-1ds-intraday` | adminController.postRefresh1dsIntraday | **1DS 분봉 수집 + 보드 재생성** — `collect-1ds-intraday.js --from-board` → `one-day-surge-board.js` 백그라운드 순차. cron 09:31과 동일한 sequence를 admin "⚡ 1DS 분봉 수집 + 보드 갱신" 버튼에서 트리거. `patternState.refreshing1dsIntraday` / `oneDsIntradayPhase` / `oneDsIntradayCollected` / `oneDsIntradayFailed`로 진행 추적 |
| `POST /admin/run-daily-update` | adminController | `run-daily-analysis.js` 강제 실행 |

기존에 있었지만 **현재는 없는** 라우트: `POST /search`, `/pattern`, `/scan`, `/backtest`, `/pdf`, `/pdf-viewer`, `/simple-report`, `/report`, `POST /subscribe`, `POST /ai/adjust`. UI는 단건 가중치 검색 모델에서 운영 보드 모델로 이전됐다.

### 종목 마스터 파이프라인

`generate-stocks.js`는 KIS가 새 마스터 파일을 배포할 때 한 번씩 돌리는 일회성 도구다:
- `master/kospi_code.mst.zip`, `master/kosdaq_code.mst.zip`을 읽음
- `.mst` 엔트리를 **cp949**(UTF-8 아님)로 디코드 (iconv-lite 사용)
- `line.slice(0, len-228)`의 0/9/21 오프셋에서 고정폭 슬라이스 — 끝의 228바이트는 무시되므로, KIS가 레코드 포맷을 바꾸면 파서가 조용히 필드를 누락한다
- 평탄한 `stocks` 배열과 `byCode` 인덱스를 함께 `stocks.json`에 기록

[src/services/stocks/stocksLoader.js](src/services/stocks/stocksLoader.js)의 `loadStocks()`가 부팅 시 한 번 동기 적재한다. `getStocksMasterAge()`로 마스터 신선도(파일 mtime)를 admin 대시보드에 표시한다.

### KIS API 연결 (`src/services/kis/`)

- [kisToken.js](src/services/kis/kisToken.js) — `getAccessToken`. `.kis-token.json`에 24시간 토큰을 캐시. 만료 5분 전까지 재사용, 동시 호출은 `inflightIssue` 프로미스로 coalesce. KIS 토큰 발급 엔드포인트는 **1분당 1회** 제한(`EGW00133`)이 있어서 캐싱이 없으면 연속 호출 시 즉시 블록된다. 캐시 파일은 토큰 평문을 담으므로 `.gitignore` 처리.
- [kisApi.js](src/services/kis/kisApi.js) — `getCurrentPrice`, `getPeriodChart` 래퍼. KIS는 초당 호출 제한이 있어서 호출 사이 sleep이 **기능적으로 필수적**이다. 병렬화 금지.

현재 KIS 호출은 `/d5-rebreak/:code` 상세 페이지(실시간 가격 1회) + `update-flow-daily.js`/`update-daily-pykrx.py`(일일 갱신) 두 곳에서만 발생한다.

### 패턴 스크리너 (`pattern-screener.js`)

일일 갱신 파이프라인의 핵심 엔진. 약 5,000줄짜리 단일 모듈로, Minervini SEPA + Weinstein Stage 2 변형 (Trend Template, VCP, Breakout) + QVA(Quiet Volume Anomaly) + VVI + CSB + Rebound + 펀더멘탈을 결합해 후보군을 스코어링한다.

- **입력**: `cache/stock-charts-long/` (장기 일봉) + `cache/flow-history/` (수급) + DART 펀더멘탈
- **출력**: `cache/pattern-result.json` (5MB+)
- **트리거**: 16:10/16:20 cron 또는 `/admin/pattern/analyze`, `/admin/refresh-pattern-cache`
- **백테스트 재현**: `ANALYSIS_DATE` 환경변수로 기준일 강제
- **시총 필터**: `PATTERN_MAX_MARKETCAP` / `PATTERN_MIN_MARKETCAP`은 `naver-fetcher.js`에서 read

`pattern-screener.js`는 라우트 핸들러에 직접 노출되지 않는다 — 컨트롤러는 cache 파일을 읽어 렌더만 한다. seed/analyze는 [src/services/pattern/adminTriggers.js](src/services/pattern/adminTriggers.js)가 비동기로 띄우고 `patternState`로 진행 상태를 추적한다.

라이브 QVA 구현은 `pattern-screener.js`의 `calculateQuietVolumeAnomaly()`. 5가설(FIRST/2DAY/ABSORB/HIGHER_LOW/HOLD) 검증은 별도 일회성 스크립트 가족에서 했었지만 현재는 정리됐고, 라이브 boardgenerator (`qva-watchlist-board.js`)가 funnel 단계 시각화로 대체.

### 운영 보드 — QVA Watchlist (`qva-watchlist-board.js`)

매일 장마감 후 갱신되는 추적 보드. funnel은 **단방향**이다: `QVA → VVI → H그룹(돌파 성공)`. 한 번 다음 단계로 넘어간 종목은 **앞 단계로 되돌아가지 않는다.**

**mutually exclusive 스냅샷 상태 (D+0~D+20, "정식 추적"):**
- `QVA_NEW` — 오늘(D=0) QVA 발생
- `QVA_TRACKING` — D+1~D+20, **VVI 미발생** + 미이탈 (VVI를 한 번이라도 발화한 종목은 영구히 이 상태로 안 돌아옴)
- `VVI_FIRED` — 가장 최근 거래일이 VVI 발생일
- `BREAKOUT_SUCCESS` — VVI 다음 거래일 돌파 성공. **H돌파일로부터 5거래일(`RECENT_BREAKOUT_DAYS=5`)까지만 보드에 유지**, D+6부터는 보드에서 영구 제외 (FAILED로도 안 표시됨)
- `FAILED` — 종가 ≤ 신호가 × 0.85, D+20 VVI 미발생 만료, 또는 돌파 실패. 마찬가지로 5일(`RECENT_FAILED_DAYS=5`)만 표시

**장기 QVA 슬롯 (D+21~D+40, `LONG_QVA_*` 태그):**
"H그룹의 후속 단계가 아니다." 진입 조건이 배타적: `earlySignals.length === 0 && longQvaSignals.length > 0` — **D+0~D+20 안에 QVA 신호가 한 번도 없었던 종목**이 D+21~D+40에 처음 발화할 때만 후보. 정식 추적 윈도우를 놓친 종목 구제용 슬롯이며, H그룹은 이미 D+0~D+20에 통과 흔적(earlySignals)이 있어 명시적으로 제외된다.

만료 조건: signalPrice 대비 -10% 이상 무너짐(`LONG_QVA_DROP_THRESHOLD_PCT=-10`) 또는 D+40 종료. tier는 `REACTIVE / INTEREST / BREAKOUT_DONE / WATCH / TRACKING` (재점화 점수 + qvaReturnPct 조합).

**보조 태그(다중 적용):** `PRICE_HOLD`, `LOW_RISING`, `VALUE_REACTIVATION`. 설계 의도는 "H그룹(돌파 성공)이 1년 90개라 너무 적으니 추적 중·VVI 발생 후보도 같은 화면에 보이게 한다."

상수는 [qva-watchlist-board.js:33-39](qva-watchlist-board.js#L33-L39)에 모여있다 (`TRACKING_DAYS`, `LONG_QVA_START/END`, `RECENT_BREAKOUT_DAYS`, `RECENT_FAILED_DAYS`, `EXIT_THRESHOLD_PCT`). 백테스트 윈도우를 바꿀 때 이 상수만 건드리고 라이브 의미를 바꾸지 말 것.

`pattern-screener` + [vpr-analyzer.js](vpr-analyzer.js)를 사용해 funnel 단계와 후속 분석 태그를 계산하고, `qva-watchlist-board.html` + `qva-watchlist-board.json`을 ROOT에 정적 파일로 쓴다. `/qva-watchlist`는 sendFile만.

### 운영 보드 — D+5 재돌파 가족 (`hgroup-rebreak-*.js`)

H돌파일 고가 재돌파 = 강한 시그널 (n=186, 승률 75.27%, +6.83%) 이라는 검증 결과 위에 만든 운용 화면.

**중요한 D 기준의 차이**: D+5 재돌파의 D+0은 **H돌파일**이지 QVA 신호일이 아니다. `MAX_DAYS=5` ([hgroup-rebreak-operation-board.js:34](hgroup-rebreak-operation-board.js#L34))는 H돌파일로부터의 거래일 수. 입력은 `qva-watchlist-board.json`의 BREAKOUT_SUCCESS 종목만이고, 그 자체가 위 보드에서 5일 컷이므로 두 보드의 윈도우가 자연스럽게 일치한다.

| 스크립트 | 입력 | 출력 (under `reports/`) | 라우트 |
|---------|------|------------------------|--------|
| `hgroup-rebreak-operation-board.js` | `qva-watchlist-board.json` + `cache/stock-charts-long/` | `hgroup-rebreak-operation-board-result.{html,json}` | `/rebreak` |
| `hgroup-rebreak-deep-dive-report.js` | `reports/vpr-hgroup-three-year-with-flow-backtest-result.json` (events 448건) + 차트 | `hgroup-rebreak-deep-dive-result.{html,json}` | `/rebreak-deep` |
| `hgroup-rebreak-flow-backtest.js` | 위 두 결과 + `cache/flow-history/` | `hgroup-rebreak-flow-result.{html,json}` | `/d5-rebreak-flow` |

스크립트들은 `qva-watchlist-board.json`을 **읽기만 하고 수정하지 않는다.** 운영 보드는 D+0~D+5 H그룹 후보의 H돌파일 고가 재돌파 상태와 기준 종가 이탈 여부를 추적하지, 매수 등급표를 만들지 않는다.

**D+5가 지난 종목은 어디로?** 어디로도 이관되지 않는다 — `/rebreak`에서 사라지고 QVA Watchlist의 BREAKOUT_SUCCESS에서도 빠진다. QVA_TRACKING은 "VVI 전" 조건 때문에 영구히 자격 없음. 장기 QVA는 위에서 본 배타 조건 때문에 자격 없음. 같은 종목에서 새 QVA가 발화하면 새 사이클로 처음부터 다시 들어온다.

종목별 상세(`/d5-rebreak/:code`)만 EJS 렌더(`d5-rebreak-detail.ejs`)이고, 보드/심층/백테스트 페이지는 모두 정적 HTML sendFile.

### 운영 보드 — 1-Day Surge Board (`one-day-surge-board.js` + `one-day-surge-core.js`)

QVA/VVI/H그룹과 **분리된 독립 보드**. 본체 점수에 QVA/VVI/BMS 조건을 섞지 않으며, QVA/VVI 이력은 카드 참고 태그로만 부착한다. 1차 버전은 일봉 캐시 기준 "다음 거래일 장초 단타 관심 후보 예비 보드"로, 실시간 분봉/호가/VI는 사용하지 않는다.

**파일 구조 (튜닝 시 한 곳만 고치면 보드+검증이 자동 동기화):**
- [one-day-surge-core.js](one-day-surge-core.js) — `CONFIG` 상수, `passesHardFilter`, `analyzeAt`, `scoreMetrics`, `classifyGroup` 등 점수/분류/필터 로직 일체. **임계값을 튜닝할 때는 이 파일만 고친다.**
- [one-day-surge-board.js](one-day-surge-board.js) — 라이브 보드 (오늘 후보 카드)
- [one-day-surge-nextday-validation-report.js](one-day-surge-nextday-validation-report.js) — 과거 N거래일 백테스트 검증 보고서
- [one-day-surge-trade-plan.js](one-day-surge-trade-plan.js) — 자동 참고 매매가 모듈. mainPool 상위 10개에 한해 SAFE/BALANCED/CLEAN/LIGHT 전략별 buyPrice(0.5~1.0% 눌림 지정가) / sellPrice1/2 / stopPrice + 손익비를 계산. 한국 호가 단위 round, CHASE_LIMIT_RATE=4% / INVALID_DROP_RATE=-3% 게이트로 WAIT_PULLBACK / ENTRY_INVALIDATED 분기. 기존 후보 선정/정렬은 무수정. **매수 추천이 아닌 참고 가격 — 시장가 매수 전제 X.**

- **입력**: `cache/stock-charts-long/{code}.json` (전 종목 일봉) + `cache/naver-stocks-list.json` (시총·`isEtf`·`isSpecial`) + `stocks.json` (보조) + (선택) `qva-watchlist-board.json` funnel + `cache/pattern-result.json`의 `vviRecentSignals`
- **출력**: `reports/one-day-surge-board-result.{html,json}` — 라우트 `/one-day-surge-board` (alias `/one-day-surge`, `/ods`)가 sendFile만
- **기준일**: 각 종목의 chart 캐시에서 가장 최근 volume>0 row. 보드 상단의 "분석 기준일"은 후보 풀에서 가장 흔한 baseDate.

**필터 (`passesHardFilter`, 차트 read 전에 적용):**
- ETF/ETN: naver `isEtf` 플래그
- 우선주/리츠/스팩/관리종목: naver `isSpecial` 플래그
- 키워드 매칭 (방어용): `EXCLUDE_NAME_KEYWORDS` (KODEX/TIGER/ACE/SOL/KBSTAR/HANARO/ARIRANG/TIMEFOLIO/KOSEF/히어로즈/PLUS/인버스/레버리지/리츠/스팩/제1~4호) + 종목명 끝 우선주 정규식 `/\s?\d*우[A-Z]?$/`
- 시총 < 500억 / ≥ 5조 / 시총 미확인 → 제외
- 결과: ~4270 chart 중 ~2350개를 **차트 파싱 전에 컷오프**해서 실제 처리량 절반 감소 → 1.8초 wall time

**점수 구성**: 거래대금 증가(25) + 거래량 증가(15) + 종가 위치(20) + 당일 상승률(15) + 20일 고점 돌파/근접(15) + 거래대금 순위(10) − 윗꼬리(20) − 과열(20) − 위험(30) − 시가총액(8). 시총 감점은 1.5조~3조 -3 / 3조~5조 -8 / 500억~1,000억 -5, 핵심 1,000억~1.5조는 0.

**그룹 분류 (배타)**: D(과열·위험) → A(강한 단타) → B(장초 확인) → C(눌림 후 재상승) → null(드롭). 그룹별 상한 `CAP = { A: 80, B: 80, C: 60, D: 60 }`.

**위험 필터 면제 (`passesRiskFilter`)**: `prev_high_spike` / `peak_before_entry` 단독은 위험 자동 제외이나, **09:10~30 morningHigh 재돌파(`rebreakMorningHigh_10_30 ✓`)**가 함께 있으면 면제 → mainPool 진입 (`it.riskExempted = ['peak_before_entry', ...]`로 표시). 근거: "전일고가 돌파 + 첫10분고점 재돌파"는 강한 한입 패턴, "09:10에 빠졌다가 첫10분고점 재돌파"는 회복 흐름. 카드에는 `↗ 재돌파 회복 (peakBefore 면제)` / `↗ 강한 한입 (spike 면제)` chip 표시. `gap_hold_candle` / `trap_risk_high` / `risk_rebreak`는 면제 없음 (그룹 자체가 위험).

**검증 보고서 (`one-day-surge-nextday-validation-report.js`)**: 라이브 보드와 **동일한 core 함수**로 과거 N거래일 시뮬레이션. 각 분류 이벤트에 대해 D+1의 +3%/+5%/+10% 도달률, 종가 -3%↓ 실패율, 평균/중앙값 다음날 시초·고가·종가를 그룹/점수구간/거래대금배율/시총구간/일자별로 cross-tab. 환경변수 `VALIDATION_DAYS`(기본 60), `VALIDATION_MAX_STOCKS`(기본 무제한). 출력 `reports/one-day-surge-nextday-validation-result.{html,json}` — 라우트 `/one-day-surge-validation` (alias `/ods-validation`).

**트리거**: 현재는 수동 실행만. cron 등록 / `/admin` 강제 재생성 / 검증 보고서 라우트 연결은 2차에서.

2차에서 실시간 1분/3분/5분 데이터(09:05/09:10 거래대금, 장초 고점 재돌파, VI 근접, VWAP 위 유지)를 추가할 예정 — 그때까지 1차 일봉 기반은 "예비 보드" 위치를 유지한다.

### 일일 갱신 파이프라인

[src/services/pattern/scheduledJobs.js](src/services/pattern/scheduledJobs.js)의 `registerSchedules()`가 `node-cron`으로 4개의 일일 작업을 등록 (시간은 KST):

| 시각 | 요일 | 작업 | 조건 |
|-----|------|------|------|
| 16:10 | 매일 | `pattern-screener.analyzeAll()` 호출 → `cache/pattern-result.json` 갱신 (종가 기준 신호 재계산만) | 항상 |
| 16:20 | 평일 (월-금) | `node run-daily-analysis.js` 외부 실행 (차트+수급 갱신 + 재분석) | `patternState.analyzing`이 false일 때만 |
| 16:35 | 평일 (월-금) | **전체 보드 갱신** — `BOARD_SCRIPTS` 8개 순차 실행: `qva-watchlist-board.js` → `hgroup-rebreak-operation-board.js` → `hgroup-rebreak-deep-dive-report.js` → `hgroup-rebreak-flow-backtest.js` → `one-day-surge-board.js` → `qva2-watchlist-board.js` → `qva2-d5-rebreak-board.js` → `qva2-vvi-board.js`. 차트/수급 캐시는 16:20 일일 업데이트에서 이미 갱신됨 — 보드는 캐시 read만. QVA2 검증(`qva2-validation-report.js`)은 cron 미등록 (수동 실행 또는 추후 별도 cron) | 항상 (보드별 실패는 다음 보드로 진행) |
| 09:30:00 | 평일 (월-금) | **1DS 분봉 수집 + 보드 재생성** ([refresh1dsIntraday](src/services/pattern/adminTriggers.js)) — `collect-1ds-intraday.js --from-board`로 보드 mainPool 코드의 09:00~09:30 분봉을 KIS API에서 받아 `data/intraday/1ds/{오늘}/`에 저장 → `one-day-surge-board.js` 재실행. 사용자가 09:30 정각 새로고침할 때 분봉 반영된 후보를 보도록 정각 시작. 보통 09:30:15~30 사이 완료, 사용자는 09:30:30+ 새로고침에서 확인 가능. 분봉 들어오면 trade plan이 분봉 기반(`strategySource: intraday`)으로 갱신되고, peak_before_entry/trap_risk 등 위험 태그가 걸리는 후보는 mainPool에서 빠짐 (단 morningHigh 재돌파 ✓ 면제) | 항상 |
| 09:32 | 평일 (월-금) | `reports/one-day-surge-board-result.json` 기반 단타 후보 메일 발송 ([sendOneDaySurgeMail](src/services/mail/oneDaySurgeMail.js) — TOP 5 + 추가 10 = 최대 15종목, manualTargets 매수/매도가 포함). 09:30 분봉 수집·보드 재생성 후 90초 마진 두고 발송 → 메일에 분봉 반영된 trade plan 포함. 6-field cron 표현식 `0 32 9 * * 1-5` | `MAIL_CRON_ENABLED=1`일 때만 |

각 스크립트의 역할:
- `update-flow-daily.js` — KIS API로 최근 외국인/기관 수급 → `cache/flow-history/{code}.json` 증분 병합
- `update-daily-pykrx.py` — KIS API(파일명만 레거시)로 60일 일봉 → `cache/stock-charts-long/{code}.json` 병합. ThreadPoolExecutor 8 워커
- `run-daily-analysis.js` — 위 두 캐시가 갱신된 뒤 pattern-screener를 호출, `cache/pattern-result.json`을 새로 쓴다
- `seed-historical-pykrx.py`, `seed-index-pykrx.py` — **일회성** 시드. FinanceDataReader 기반 (pykrx의 cp949/응답 버그 우회)

운영 서버에서 cron이 실패해도 `/admin/run-daily-update`, `/admin/refresh-pattern-cache`, `/admin/refresh-watchlist-board`로 수동 실행 가능.

### 캐시 디렉토리 구조

`.gitignore`는 `cache/*`를 기본 ignore하고, **운영 데이터로 동기화해야 하는 디렉토리만 화이트리스트**로 다시 추가한다 (`!cache/flow-history/`, `!cache/stock-charts-long/`, `!cache/pattern-result.json`). 새 캐시 디렉토리를 추가한다면 화이트리스트도 같이 갱신해야 한다.

| 경로 | 생산자 | 소비자 |
|------|--------|--------|
| `cache/stock-charts-long/{code}.json` | `update-daily-pykrx.py`, `seed-historical-pykrx.py` | `pattern-screener.js`, `qva-watchlist-board.js`, `hgroup-rebreak-*.js` |
| `cache/stock-charts/{code}.json` | `naver-fetcher.js` | 단기 분석 |
| `cache/flow-history/{code}.json` | `update-flow-daily.js`, `seed-flow-naver.js` | `pattern-screener.js`, `hgroup-rebreak-flow-backtest.js` |
| `cache/dart-financials/`, `cache/material-analysis/` | `dart-fetcher.js`, `seed-financials-history.js` | `pattern-screener.js` 펀더멘탈 |
| `cache/ai-comments/` | `/ai/comment` 라우트 ([src/services/ai/geminiComment.js](src/services/ai/geminiComment.js)) | UI 캐시 |
| `cache/pattern-result.json` | 16:10/16:20 cron, `/admin/refresh-pattern-cache` | `qva-watchlist-board.js`, 패턴 메일 |
| `cache/naver-stocks-list.json`, `cache/kospi-daily.json`, `cache/kosdaq-daily.json` | `naver-fetcher.js` 등 | 시드 단계 |
| `data/intraday/1ds/{YYYY-MM-DD}/{code}.json` | `collect-1ds-intraday.js` (KIS `FHKST03010230`) | `one-day-surge-entry-confirm-report.js`, `one-day-surge-entry-daily-backtest-report.js` |

루트의 정적 출력물:
- `qva-watchlist-board.{html,json}` — `/qva-watchlist`가 sendFile하는 운영 보드
- `reports/hgroup-rebreak-*-result.{html,json}` — `/rebreak`, `/rebreak-deep`, `/d5-rebreak-flow`가 sendFile
- `reports/one-day-surge-board-result.{html,json}` — `/one-day-surge-board`가 sendFile하는 단타 관심 후보 보드 (QVA/VVI와 독립)
- `reports/one-day-surge-nextday-validation-result.{html,json}` — 다음날 검증 백테스트 보고서 (`/one-day-surge-validation` sendFile)
- `reports/one-day-surge-entry-confirm-result.{html,json}` — 분봉 ENTRY_CONFIRM 연구 보고서 (`/one-day-surge-entry-confirm` sendFile). morningHigh rebreak 단일 알파 검증 + V1~V5 비교 + 위험 그룹 + prevHigh 위험 분석
- `reports/one-day-surge-entry-daily-backtest-result.{html,json}` — 날짜별 운영형 백테스트 보고서 (`/one-day-surge-entry-daily-backtest` sendFile). 6개 전략(SAFE/BALANCED/LIGHT/CLEAN/RISK/SPIKE)을 매일 simulate, 보드 반영 가능 여부 판단
- `reports/one-day-surge-intraday-missing.json` — 분봉 백필 시 누락/실패 누적 로그 (`collect-1ds-intraday.js` 누적 append)
- `reports/qva-vvi-redefined-board-result.{html,json}` — 새 VVI 정의 (QVA 고가 + 거래량 + 거래대금 동시 재돌파) 후보 보드 (`/qva-vvi-redefined-board` sendFile). 기존 QVA/VVI/H그룹/재돌파 보드와 분리된 신규 보드.
- `reports/qva-vvi-redefined-backtest-result.{html,json}` — 새 VVI 정의 1차 백테스트 (`/qva-vvi-redefined-backtest` sendFile). 5 그룹 비교 + D+1~D+20 outcome. **새 VVI 관련 파일은 보드 1개 + 백테스트 1개만 사용 — v2/final/new 같은 사본 만들지 않음. 새 실험은 동일 파일에 섹션 추가/덮어쓰기.**
- `reports/qva2-watchlist-board.{html,json}` — QVA2 H그룹/VPR 보드 (`/qva2-watchlist` sendFile). 기존 `/qva-watchlist` mirror — funnel(QVA2_NEW/QVA2_TRACKING/VVI2_FIRED/BREAKOUT_SUCCESS/FAILED) + 보조 태그. JSON의 `stages.BREAKOUT_SUCCESS`는 downstream `/qva2-d5-rebreak`이 입력으로 사용.
- `reports/qva2-d5-rebreak-board.{html,json}` — QVA2 D+5 재돌파 운용보드 (`/qva2-d5-rebreak` sendFile). 기존 `/rebreak` mirror — D+0(BREAKOUT)부터 D+1~D+5 재돌파 추적.
- `reports/qva2-vvi-board.{html,json}` — QVA2 고점 재돌파 보드 (`/qva2-vvi` sendFile). 기존 `/qva-vvi-redefined-board` mirror.
- `reports/qva2-validation-result.{html,json}` — QVA2 시그널 검증 (`/qva2-validation` sendFile). D+5/10/20 outcome × 등급/점수/약세폭/거래대금배율/시총/closeLocation cohort. **기존 QVA reports는 읽기만, 수정 안 함. QVA2 관련 새 파일/사본 만들지 말고 같은 파일에 섹션 덮어쓰기.** ❌ qva2-vpr-board.* 는 더 이상 생성 안 함 (D+5 재돌파로 대체됨, 2026-05).

### 인증·구독·관리자

[app.js](app.js)와 라우트는 **3계층** 게이트를 가진다:

1. **비공개 토큰** — `PRIVATE_SITE_TOKEN` + `NODE_ENV=production`일 때만 활성. 토큰 미보유 클라이언트는 모든 경로에 대해 **404**(`Cannot GET <path>`)로 위장. `?k=토큰`으로 진입 시 1년짜리 쿠키 발급 후 토큰 제거하고 redirect ([src/middleware/siteGate.js](src/middleware/siteGate.js) `privateTokenGate`)
2. **사이트 비밀번호** — `SITE_PASSWORD`. `/login` 통과 필요. `/login`, `/unsubscribe`만 화이트리스트. ([src/services/auth/siteAuth.js](src/services/auth/siteAuth.js))
3. **관리자 토큰** — `ADMIN_TOKEN`. `/admin`, `/admin/pattern/*`, `/admin/backtest/qva`, `/admin/refresh-*`, `/admin/run-daily-update`, `/admin/send-pattern-mail` 보호 ([src/services/auth/adminAuth.js](src/services/auth/adminAuth.js) `requireAdmin`)

쿠키는 `NODE_ENV=production`일 때 `Secure` 플래그 부착, 30일(사이트) / 365일(비공개 토큰) 유효.

**구독자 관리** — `.subscribers.json` 평문 저장 (`.gitignore`). 가입은 unsubscribe 토큰 기반의 메일 본문 링크나 관리자 대시보드를 통해서만 (별도 `/subscribe` POST 라우트는 현재 없음). `/admin/send-pattern-mail`로 수동 발송, 18:00 cron으로 자동 발송.

### 렌더링

EJS 템플릿:
- `views/site-login.ejs` — `/login`
- `views/d5-rebreak-detail.ejs` — `/d5-rebreak/:code` (단타·스윙 4섹션 AI)
- `views/stock-detail.ejs` — `/stock/:code` (보드 공용 단순 상세)
- `views/qva-vvi-redefined-detail.ejs` — `/qva-vvi-redefined/:code` (재무·뉴스·공시 + 기업분석 3섹션 AI)
- `views/admin/login.ejs` — `/admin/login`
- `views/admin/dashboard.ejs` — `/admin`

나머지는 모두 정적 HTML sendFile (운영 보드, D+5 재돌파 보드/심층/백테스트, qva-watchlist).

이전에 있던 `index.ejs`(단건 검색 폼), `pattern.ejs`(패턴 결과), `subscribe.ejs`, `scan.ejs`, `backtest.ejs`는 8c863eaf에서 제거됐다. PDFKit 기반 `/pdf*`, `/report*` 라우트도 함께 사라졌다.

새 EJS 템플릿을 추가할 때는 컨트롤러에서 `res.render(...)`로 명시적으로 호출해야 한다 — 자동 라우트는 없다.
