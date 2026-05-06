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
- `MAIL_CRON_ENABLED=1` — 일일 패턴 메일 cron 활성화

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
| [src/services/](src/services/) | 도메인 로직 — `ai/`, `auth/`, `kis/`, `mail/`, `pattern/`, `stocks/` |
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
| `POST /ai/comment` | aiController.postComment | Gemini 호출. `/d5-rebreak/:code` 페이지가 lazy 호출 |
| `GET/POST /login`, `GET /unsubscribe` | authController | 사이트 비밀번호 게이트, 메일 unsubscribe |
| `GET/POST /admin/login`, `GET /admin/logout` | adminController | 관리자 인증 |
| `GET /admin` | adminController.getDashboard | 대시보드 (구독자 / stocks 마스터 / 패턴 상태) |
| `POST /admin/unsubscribe` | adminController.postUnsubscribe | 관리자 수동 구독 해제 |
| `POST /admin/send-pattern-mail` | adminController.postSendPatternMail | `pattern-result.json` 기반 즉시 메일 |
| `POST /admin/pattern/seed`, `/admin/pattern/analyze`, `/admin/backtest/qva` | adminController + adminTriggers | 패턴 시드/분석/QVA 백테스트 비동기 트리거 |
| `POST /admin/refresh-pattern-cache` | adminController | pattern-result.json 강제 재생성 (JSON 응답) |
| `POST /admin/refresh-watchlist-board` | adminController | `qva-watchlist-board.js` 강제 재실행 |
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

매일 장마감 후 갱신되는 추적 보드. **mutually exclusive 스냅샷 상태:**
- `QVA_NEW` — 오늘(D=0) QVA 발생
- `QVA_TRACKING` — D+1~D+20, VVI 미발생, 미이탈
- `VVI_FIRED` — 가장 최근 거래일이 VVI 발생일
- `BREAKOUT_SUCCESS` — VVI 다음 거래일 돌파 성공
- `FAILED` — 종가 ≤ 신호가 × 0.85, D+20 만료, 또는 돌파 실패

**보조 태그(다중 적용):** `PRICE_HOLD`, `LOW_RISING`, `VALUE_REACTIVATION`. 설계 의도는 "H그룹(돌파 성공)이 1년 90개라 너무 적으니 추적 중·VVI 발생 후보도 같은 화면에 보이게 한다."

`pattern-screener` + [vpr-analyzer.js](vpr-analyzer.js)를 사용해 funnel 단계와 후속 분석 태그를 계산하고, `qva-watchlist-board.html` + `qva-watchlist-board.json`을 ROOT에 정적 파일로 쓴다. `/qva-watchlist`는 sendFile만.

### 운영 보드 — D+5 재돌파 가족 (`hgroup-rebreak-*.js`)

H돌파일 고가 재돌파 = 강한 시그널 (n=186, 승률 75.27%, +6.83%) 이라는 검증 결과 위에 만든 운용 화면.

| 스크립트 | 입력 | 출력 (under `reports/`) | 라우트 |
|---------|------|------------------------|--------|
| `hgroup-rebreak-operation-board.js` | `qva-watchlist-board.json` + `cache/stock-charts-long/` | `hgroup-rebreak-operation-board-result.{html,json}` | `/rebreak` |
| `hgroup-rebreak-deep-dive-report.js` | `reports/vpr-hgroup-three-year-with-flow-backtest-result.json` (events 448건) + 차트 | `hgroup-rebreak-deep-dive-result.{html,json}` | `/rebreak-deep` |
| `hgroup-rebreak-flow-backtest.js` | 위 두 결과 + `cache/flow-history/` | `hgroup-rebreak-flow-result.{html,json}` | `/d5-rebreak-flow` |

스크립트들은 `qva-watchlist-board.json`을 **읽기만 하고 수정하지 않는다.** 운영 보드는 D+0~D+5 H그룹 후보의 H돌파일 고가 재돌파 상태와 기준 종가 이탈 여부를 추적하지, 매수 등급표를 만들지 않는다.

종목별 상세(`/d5-rebreak/:code`)만 EJS 렌더(`d5-rebreak-detail.ejs`)이고, 보드/심층/백테스트 페이지는 모두 정적 HTML sendFile.

### 일일 갱신 파이프라인

[src/services/pattern/scheduledJobs.js](src/services/pattern/scheduledJobs.js)의 `registerSchedules()`가 `node-cron`으로 4개의 일일 작업을 등록 (시간은 KST):

| 시각 | 요일 | 작업 | 조건 |
|-----|------|------|------|
| 16:10 | 매일 | `pattern-screener.analyzeAll()` 호출 → `cache/pattern-result.json` 갱신 (종가 기준 신호 재계산만) | 항상 |
| 16:20 | 평일 (월-금) | `node run-daily-analysis.js` 외부 실행 (차트+수급 갱신 + 재분석) | `patternState.analyzing`이 false일 때만 |
| 16:35 | 평일 (월-금) | `node qva-watchlist-board.js` 외부 실행 → 운영 보드 HTML 갱신 | 항상 |
| 18:00 | 매일 | `pattern-result.json` 기반 메일 발송. 결과가 오늘자가 아니면 skip | `MAIL_CRON_ENABLED=1`일 때만 |

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

루트의 정적 출력물:
- `qva-watchlist-board.{html,json}` — `/qva-watchlist`가 sendFile하는 운영 보드
- `reports/hgroup-rebreak-*-result.{html,json}` — `/rebreak`, `/rebreak-deep`, `/d5-rebreak-flow`가 sendFile

### 인증·구독·관리자

[app.js](app.js)와 라우트는 **3계층** 게이트를 가진다:

1. **비공개 토큰** — `PRIVATE_SITE_TOKEN` + `NODE_ENV=production`일 때만 활성. 토큰 미보유 클라이언트는 모든 경로에 대해 **404**(`Cannot GET <path>`)로 위장. `?k=토큰`으로 진입 시 1년짜리 쿠키 발급 후 토큰 제거하고 redirect ([src/middleware/siteGate.js](src/middleware/siteGate.js) `privateTokenGate`)
2. **사이트 비밀번호** — `SITE_PASSWORD`. `/login` 통과 필요. `/login`, `/unsubscribe`만 화이트리스트. ([src/services/auth/siteAuth.js](src/services/auth/siteAuth.js))
3. **관리자 토큰** — `ADMIN_TOKEN`. `/admin`, `/admin/pattern/*`, `/admin/backtest/qva`, `/admin/refresh-*`, `/admin/run-daily-update`, `/admin/send-pattern-mail` 보호 ([src/services/auth/adminAuth.js](src/services/auth/adminAuth.js) `requireAdmin`)

쿠키는 `NODE_ENV=production`일 때 `Secure` 플래그 부착, 30일(사이트) / 365일(비공개 토큰) 유효.

**구독자 관리** — `.subscribers.json` 평문 저장 (`.gitignore`). 가입은 unsubscribe 토큰 기반의 메일 본문 링크나 관리자 대시보드를 통해서만 (별도 `/subscribe` POST 라우트는 현재 없음). `/admin/send-pattern-mail`로 수동 발송, 18:00 cron으로 자동 발송.

### 렌더링

EJS 템플릿은 4개만 남아있다:
- `views/site-login.ejs` — `/login`
- `views/d5-rebreak-detail.ejs` — `/d5-rebreak/:code`
- `views/admin/login.ejs` — `/admin/login`
- `views/admin/dashboard.ejs` — `/admin`

나머지는 모두 정적 HTML sendFile (운영 보드, D+5 재돌파 보드/심층/백테스트, qva-watchlist).

이전에 있던 `index.ejs`(단건 검색 폼), `pattern.ejs`(패턴 결과), `subscribe.ejs`, `scan.ejs`, `backtest.ejs`는 8c863eaf에서 제거됐다. PDFKit 기반 `/pdf*`, `/report*` 라우트도 함께 사라졌다.

새 EJS 템플릿을 추가할 때는 컨트롤러에서 `res.render(...)`로 명시적으로 호출해야 한다 — 자동 라우트는 없다.
