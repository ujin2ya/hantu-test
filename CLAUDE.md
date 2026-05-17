# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 폴더 구조 (2026-05-11 분류)

루트는 부트스트랩(`app.js`)과 데이터/views/src만 둔다. 모든 보드 generator·screener·일일 갱신 스크립트는 도메인별 폴더로 분류:

```
app.js                              # Express 부트스트랩 (루트 유지)
boards/                             # 7개 보드 generator + 보드 전용 라이브러리
  qva/
    qva-watchlist-board.js          # /qva-watchlist
    qva-vvi-redefined-board.js      # /qva-vvi-redefined-board
    vpr-analyzer.js                 # qva-watchlist 의존
  rebreak/
    hgroup-rebreak-operation-board.js  # /rebreak
  oneDaySurge/
    one-day-surge-board.js          # /one-day-surge-board
    one-day-surge-core.js           # 점수/필터 core
    one-day-surge-trade-plan.js     # 매매 가격 모듈
    one-day-surge-entry-confirm-report.js  # computeIntradayMetrics 라이브러리 (보고서 라우트는 제거됨)
  qva2/
    qva2-watchlist-board.js         # /qva2-watchlist
    qva2-d5-rebreak-board.js        # /qva2-d5-rebreak
    qva2-vvi-board.js               # /qva2-vvi
    qva2-screener.js                # 임계값 단일 진입점
screeners/                          # 일일 분석 엔진
  pattern-screener.js               # 5,000줄급 메인 분석 → cache/pattern-result.json
  korea-filter.js                   # valueMomentumScore / liquidityScore / marketCapScore
  dart-fetcher.js                   # DART 펀더멘탈
  naver-fetcher.js                  # 네이버 메타 + 시드
pipeline/                           # 일일 갱신 / 마스터 / 분봉 수집
  run-daily-analysis.js             # 16:20 cron 일일 갱신 (차트+수급+분석)
  update-flow-daily.js              # 외국인/기관 수급 증분
  collect-1ds-intraday.js           # 09:30 cron 1DS 분봉 수집
  generate-stocks.js                # 종목 마스터 재생성 (수동)
  update-daily-pykrx.py             # KIS API 차트 갱신 (.py — 위치 동일)
seeds/                              # 일회성 시드 (require 0건, 데이터 복구용)
  seed-financials-history.js
  seed-flow-naver.js
src/                                # webapp 코드 (라우트/컨트롤러/서비스/미들웨어/유틸)
views/                              # EJS 템플릿
master/                             # KIS 종목 마스터 zip
cache/                              # 캐시 데이터 (gitignore 화이트리스트)
reports/                            # 보드 generator 출력 HTML/JSON
data/intraday/1ds/                  # 1DS 분봉 누적
scripts/                            # sync-remote-cache.sh 등 ops
```

**ROOT 정의 규칙**: 보드 파일(`boards/<family>/*.js`)은 `const ROOT = path.join(__dirname, '..', '..');`, 1단계 폴더 파일(`screeners/*.js`, `pipeline/*.js`, `seeds/*.js`)은 `const ROOT = path.join(__dirname, '..');`. 모든 cache/reports 경로는 ROOT 기준으로 작성한다 — 직접 `__dirname`을 cache path에 쓰지 말 것.

**폴더 간 require 규칙**: 같은 폴더 안에서는 `require('./foo')` 그대로. 폴더 간은 상대 경로 — 보드 → screener는 `require('../../screeners/xxx')`, pipeline → screener는 `require('../screeners/xxx')`, seeds → screener는 `require('../screeners/xxx')`.

**spawn 규칙**: `src/services/pattern/adminTriggers.js`의 `BOARD_SCRIPTS` + `runDailyUpdate` + `refresh1dsIntraday`는 모두 `path.join(ROOT, 'boards', '<family>', 'xxx.js')` 형태로 새 path 사용. 단순 파일명만 쓰지 말 것.

## 명령어

- 의존성 설치: `npm install`
- Python 의존성 설치: `python -m venv .venv && .venv\Scripts\pip install -r requirements.txt` (Windows) — pykrx/pandas 기반 시드/갱신 스크립트용
- 웹 앱 실행: `node app.js` (포트는 `PORT` 환경변수, 기본값 `3012`). app.js는 부트스트랩 전용이고 라우터/서비스/cron은 `src/` 하위.
- 종목 마스터 재생성: `npm run generate-stocks` ([pipeline/generate-stocks.js](pipeline/generate-stocks.js)가 `master/`의 zip을 읽어 `stocks.json` 작성)
- 일일 갱신을 수동 트리거: `node pipeline/run-daily-analysis.js` (또는 `/admin/run-daily-update`)
- QVA 운영 보드 재생성: `node boards/qva/qva-watchlist-board.js` → `qva-watchlist-board.html` 생성. 라우트 `/qva-watchlist`가 이 정적 HTML을 서빙
- D+5 재돌파 운용 보드 재생성: `node boards/rebreak/hgroup-rebreak-operation-board.js` → `reports/hgroup-rebreak-operation-board-result.{html,json}` 생성. 라우트 `/rebreak`(= `/hgroup-rebreak-operation`)가 sendFile만 함. 심층 검증/수급 백테스트는 2026-05-10에 제거됨.
- 1-Day Surge Board(단타 관심 후보) 재생성: `node boards/oneDaySurge/one-day-surge-board.js` → `reports/one-day-surge-board-result.{html,json}` 생성. 라우트 `/one-day-surge-board`가 sendFile만 함. 다음날 검증/ENTRY_CONFIRM/날짜별 백테스트 보고서는 2026-05-10에 제거됨 (단, [boards/oneDaySurge/one-day-surge-entry-confirm-report.js](boards/oneDaySurge/one-day-surge-entry-confirm-report.js)는 라이브 보드의 `computeIntradayMetrics` 라이브러리 dependency로 보존됨 — main 함수가 호출되지 않을 뿐).
- 1DS GT 후보 분봉 백필: `node pipeline/collect-1ds-intraday.js [--target-date YYYYMMDD | --from YYYYMMDD --to YYYYMMDD | --from-board]` → `data/intraday/1ds/{date}/{code}.json`에 09:00~10:00 분봉 저장. KIS `FHKST03010230`(과거 분봉) 기반, 멱등 저장 (이미 있으면 skip). 환경변수 대신 CLI 플래그: `--window-days`(기본 40), `--groups`, `--top-per-day`, `--sleep`(기본 350ms), `--retry`(기본 2), `--end-hour`(기본 100000), `--dry-run`, `--from-board`. **`--from-board`는 라이브 운영용** — `reports/one-day-surge-board-result.json`의 `priorityRanked.mainPoolCodes`만 읽어 그 코드들(~15~25개)에 한해 수집. target-date를 보드의 analysisDate로 자동 설정. 09:31 cron이 이 모드로 호출. 누락 로그는 `reports/one-day-surge-intraday-missing.json`에 누적
- QVA 고점 재돌파 후보 보드 (새 VVI 정의): `node boards/qva/qva-vvi-redefined-board.js` → `reports/qva-vvi-redefined-board-result.{html,json}` 생성. 라우트 `/qva-vvi-redefined-board`. 환경변수 `VVI_LOOKBACK_DAYS`(기본 20), `VVI_TOP_LIMIT`(기본 10). 새 VVI 정의 = QVA 고가 재돌파 + QVA 이상 거래량 + QVA 이상 거래대금. 기존 VVI/QVA 보드와 별개의 신규 보드. 1차 백테스트는 2026-05-10에 제거됨.
- **QVA2 실험 라인 (기존 운영 3 보드의 1:1 mirror, 기존 QVA/VVI/VPR 무수정)**: 기존 QVA(`calculateRedefinedQVA`)는 약세 마감을 `notWeakClose` 필터로 컷하는 안정형. QVA2는 그 반대편 — "종가는 약했지만 거래대금이 강하게 들어왔고 장중 회복 흔적이 있는" 후보를 별도로 잡는 실험. 보드 3개는 기존 `/qva-watchlist`, `/rebreak`, `/qva-vvi-redefined-board`의 1:1 mirror로 만든다.
  - 공통 모듈: [boards/qva2/qva2-screener.js](boards/qva2/qva2-screener.js) — `calculateQVA2(rows, idx, meta, overrides)` + `findQVA2Events()` + `findVvi2AfterQva2(rows, qva2Idx, maxDays)`. 임계값은 `QVA2_CONFIG` / `VVI2_CONFIG`에서 단일 관리.
  - QVA2 H그룹/VPR 보드: `node boards/qva2/qva2-watchlist-board.js` → `reports/qva2-watchlist-board.{html,json}`. 라우트 `/qva2-watchlist`. 종목당 단일 funnel 상태(QVA2_NEW / QVA2_TRACKING / VVI2_FIRED / BREAKOUT_SUCCESS / FAILED) + 보조 태그(PRICE_HOLD / LOW_RISING / VALUE_REACTIVATION). TRACKING_DAYS=20, RECENT_BREAKOUT_DAYS=5, RECENT_FAILED_DAYS=5, EXIT_THRESHOLD_PCT=-15. 환경변수 `QVA2_MAX_MARKETCAP`(기본 5e12).
  - QVA2 D+5 재돌파 운용보드: `node boards/qva2/qva2-d5-rebreak-board.js` → `reports/qva2-d5-rebreak-board.{html,json}`. 라우트 `/qva2-d5-rebreak`. 입력은 `boards/qva2/qva2-watchlist-board.json`의 BREAKOUT_SUCCESS 후보. D+0 = BREAKOUT 일자, D+1~D+5 동안 D+0 고가 종가 재돌파 추적.
  - QVA2 고점 재돌파 보드: `node boards/qva2/qva2-vvi-board.js` → `reports/qva2-vvi-board.{html,json}`. 라우트 `/qva2-vvi`. QVA2 발생일의 (high, volume, value)를 기준으로 첫 재돌파일 탐지.
  - QVA2 검증/백테스트/사전감시 보고서들은 모두 2026-05-10에 제거됨.
  - 의존성 순서 (16:35 cron + admin trigger): qva2-watchlist → qva2-d5-rebreak → qva2-vvi.
  - 컨트롤러/라우터: [src/controllers/qva2Controller.js](src/controllers/qva2Controller.js), [src/routes/qva2Routes.js](src/routes/qva2Routes.js). [src/routes/index.js](src/routes/index.js)에 mount.
  - 살아있는 7개 보드의 HTML 상단에 3-section 통일 nav가 inline으로 들어가 있다 (🟢 운영 / 🟣 실험 / 📜 과거 — [네비게이션 카테고리](#네비게이션-카테고리-2026-05-17) 참고).
  - **임계값 튜닝은 `boards/qva2/qva2-screener.js`의 `QVA2_CONFIG`만 수정**. 보드 3개 모두 동일 screener를 import하므로 단일 진입점에서 동기화됨.
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
- `DART_API_KEY` — 공시·재무 조회 (`screeners/dart-fetcher.js`, `seeds/seed-financials-history.js`, pattern-screener의 펀더멘탈 스코어). 미설정 시 공시·재무 단계 skip

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
- `PATTERN_MAX_MARKETCAP` (기본 5천억), `PATTERN_MIN_MARKETCAP` (기본 50억) — `screeners/naver-fetcher.js`의 시드 시총 필터. 운영은 9천억으로 ramp
- `ANALYSIS_DATE` — `screeners/pattern-screener.js`가 분석 기준일을 강제 (재현 백테스트용)
- `PORT` — 웹 서버 포트

**운영 서버 SSH (`scripts/sync-remote-cache.sh`용)**
- `REMOTE_SSH_PASSWORD` — 필수. plink/pscp가 운영 서버에 접속할 때 사용
- `REMOTE_SSH_HOST` (기본 `hajiny.co.kr`), `REMOTE_SSH_PORT` (기본 `1027`), `REMOTE_SSH_USER` (기본 `eugene`), `REMOTE_SSH_PATH` (기본 `/home/eugene/workspace/hantu-test`) — 오버라이드 가능

## 아키텍처

단일 프로세스 Node/Express 앱이 KIS Open Trading API, 네이버 모바일 API, DART API, Gemini를 조합해서 한국 주식(KOSPI/KOSDAQ)을 점수화·스크리닝한다. 결과는 정적 HTML과 EJS 템플릿으로 렌더링한다.

크게 세 개의 축이 한 코드베이스에 공존한다:
1. **패턴 스크리너 + 일일 분석 캐시** (`screeners/pattern-screener.js`, QVA/VVI/CSB/Rebound/Trend Template/펀더멘탈 등을 결합한 5,000줄급 단일 모듈) → `cache/pattern-result.json`
2. **보드 (7개, 3 카테고리로 분류 — 2026-05-17)** — [네비게이션 카테고리](#네비게이션-카테고리-2026-05-17) 참고
   - 🟢 **운영 보드 (3)**: `/qva2-watchlist`, `/qva2-d5-rebreak`, `/qva2-vvi`
   - 🟣 **실험 라인 (1)**: `/one-day-surge-board`
   - 📜 **과거 보드 (3)**: `/qva-watchlist`, `/rebreak`, `/qva-vvi-redefined-board`
3. **일일 갱신 파이프라인** (`pipeline/update-flow-daily.js`, `update-daily-pykrx.py`, `pipeline/run-daily-analysis.js` + node-cron 4개)

운영 UI(관리자 대시보드, 구독 메일)는 위 세 축이 만든 결과물 위에 얇게 얹힌다.

### 네비게이션 카테고리 (2026-05-17)

7개 보드 모두의 HTML 상단에 동일한 3-section nav가 inline으로 들어있다. 카테고리는 다음과 같이 재분류됨:

| 카테고리 | 보드 | 라우트 | 색상 |
|---------|------|--------|------|
| 🟢 **운영 보드** | QVA2 H그룹/VPR | `/qva2-watchlist` | green |
| 🟢 **운영 보드** | QVA2 D+5 재돌파 | `/qva2-d5-rebreak` | green |
| 🟢 **운영 보드** | QVA2 고점 재돌파 | `/qva2-vvi` | green |
| 🟣 **실험 라인** | 1DS 단타 후보 | `/one-day-surge-board` | purple |
| 📜 **과거 보드** | QVA H그룹/VPR (구) | `/qva-watchlist` | gray |
| 📜 **과거 보드** | D+5 재돌파 운용 (구) | `/rebreak` | gray |
| 📜 **과거 보드** | QVA 고점 재돌파 (구) | `/qva-vvi-redefined-board` | gray |

이전 분류와의 차이: (a) QVA2 가족이 실험 라인에서 운영 보드로 승격, (b) 1DS가 운영에서 실험 라인으로 이동, (c) 기존 QVA/Rebreak/QVA-VVI-redefined 3개는 과거 보드로 분류. 코드/라우트/cron은 그대로 유지하고 UI 분류만 바뀜.

각 보드의 HTML 생성 코드에 인라인 nav HTML이 직접 들어가 있어 (별도 helper 모듈 없음), 카테고리를 다시 바꾸려면 7개 board generator 파일을 모두 수정해야 한다. 카테고리 변경 시 [src/routes/index.js](src/routes/index.js)의 mount 순서나 `BOARD_SCRIPTS` cron 실행 순서는 영향받지 않는다 (UI-only 분류).

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
| `GET /d5-rebreak/:code` | qvaVviRedefinedController.getRedefinedVviStockDetail | 모든 보드 상세 페이지가 공유하는 통일 페이지. `/qva-vvi-redefined/:code`와 동일 |
| `POST /d5-rebreak/:code/ai` | qvaVviRedefinedController.postCompanyAnalysis | 통일 상세 페이지의 AI 사업내용 요약 lazy 호출 |
| `GET /one-day-surge-board` | oneDaySurgeController.getBoard | 단타 관심 후보 보드 HTML sendFile (`reports/one-day-surge-board-result.html`) |
| `GET /one-day-surge`, `/ods` | (redirect) | `/one-day-surge-board`로 |
| `GET /one-day-surge-board/:code`, `/one-day-surge/:code` | qvaVviRedefinedController.getRedefinedVviStockDetail | 1DS 종목 상세 — 다른 보드들과 같은 통일 상세 페이지 (qva-vvi-redefined-detail.ejs) 공유. 보드 카드의 종목명 클릭 시 진입. 메인 카드 + 스캐너 카드 + 공격형 TOP 카드 모두 링크됨. literal route(/backtest, /explosive-backtest) 뒤에 등록되어 매칭 충돌 없음 |
| `POST /one-day-surge-board/:code/ai`, `/one-day-surge/:code/ai` | qvaVviRedefinedController.postCompanyAnalysis | 통일 상세 페이지의 AI 사업내용 요약 lazy 호출 |
| `GET /qva-vvi-redefined-board` | qvaVviRedefinedController.getRedefinedVviBoard | 새 VVI 정의 (QVA 고가 + 거래량 + 거래대금 동시 재돌파) 후보 보드 HTML sendFile (`reports/qva-vvi-redefined-board-result.html`) |
| `GET /qva-vvi-redefined/:code` | qvaVviRedefinedController.getRedefinedVviStockDetail | 새 VVI 종목 상세 페이지 — naver 메타 + KIS 실시간 + 60일 SVG 차트 + DART 재무 + Naver 뉴스 8건 + DART 공시 10건 + 새 VVI funnel 위치 + AI 분석 버튼. `views/qva-vvi-redefined-detail.ejs` 렌더. 보드 카드의 종목명이 이 라우트로 링크 |
| `POST /qva-vvi-redefined/:code/ai` | qvaVviRedefinedController.postCompanyAnalysis | 상세 페이지 AI 버튼이 fetch로 호출. Gemini가 기업분석/사업내용/최근이슈 3섹션 생성 (in-memory 30분 TTL 캐시). `geminiCompanyAnalysis.js` |
| `GET /qva2-watchlist` | qva2Controller.getWatchlistBoard | QVA2 H그룹/VPR 보드 sendFile (`reports/qva2-watchlist-board.html`). 기존 `/qva-watchlist`의 funnel 구조 mirror. **운영 보드** (2026-05-17 재분류) |
| `GET /qva2-d5-rebreak` | qva2Controller.getD5RebreakBoard | QVA2 D+5 재돌파 운용보드 sendFile (`reports/qva2-d5-rebreak-board.html`). 기존 `/rebreak`의 mirror, 입력은 qva2-watchlist의 BREAKOUT_SUCCESS. **운영 보드** (2026-05-17 재분류) |
| `GET /qva2-vvi` | qva2Controller.getVviBoard | QVA2 고점 재돌파 보드 sendFile (`reports/qva2-vvi-board.html`). 기존 `/qva-vvi-redefined-board` mirror. **운영 보드** (2026-05-17 재분류) |
| `GET /stock/:code` | qvaVviRedefinedController.getRedefinedVviStockDetail | 모든 보드 상세 페이지가 공유하는 통일 페이지. `/qva-vvi-redefined/:code`와 동일 |
| `POST /stock/:code/ai` | qvaVviRedefinedController.postCompanyAnalysis | 통일 상세 페이지의 AI 사업내용 요약 lazy 호출 |
| `POST /ai/comment` | aiController.postComment | Gemini 짧은 코멘트 호출. (현재 통일 상세 페이지는 `/qva-vvi-redefined/:code/ai` 등 컨트롤러 전용 AI 라우트를 사용하므로 사용처가 줄었다) |
| `GET/POST /login`, `GET /unsubscribe` | authController | 사이트 비밀번호 게이트, 메일 unsubscribe |
| `GET/POST /admin/login`, `GET /admin/logout` | adminController | 관리자 인증 |
| `GET /admin` | adminController.getDashboard | 대시보드 (구독자 / stocks 마스터 / 패턴 상태) |
| `POST /admin/unsubscribe` | adminController.postUnsubscribe | 관리자 수동 구독 해제 |
| `POST /admin/send-1ds-mail` | adminController.postSend1dsMailAll | `reports/one-day-surge-board-result.json` 기반 1DS 단타 메일을 **전체 구독자**에게 즉시 발송 (대시보드의 "📧 전체 구독자에게 1DS 메일 발송" 버튼) |
| `POST /admin/send-1ds-mail-one` | adminController.postSend1dsMailOne | 같은 1DS 메일을 **특정 구독자 한 명**에게만 발송 (구독자 그리드 행의 envelope 아이콘 버튼). `email` form field로 대상 지정 |
| `POST /admin/pattern/seed`, `/admin/pattern/analyze`, `/admin/backtest/qva` | adminController + adminTriggers | 패턴 시드/분석/QVA 백테스트 비동기 트리거 |
| `POST /admin/refresh-pattern-cache` | adminController | pattern-result.json 강제 재생성 (JSON 응답) |
| `POST /admin/refresh-watchlist-board` | adminController | `boards/qva/qva-watchlist-board.js` 만 강제 재실행 |
| `POST /admin/refresh-all-boards` | adminController.postRefreshAllBoards | **전체 보드 갱신** — `adminTriggers.BOARD_SCRIPTS` 7개를 백그라운드 순차 실행 (QVA + QVA 고점 재돌파 + D+5 재돌파 운용 + 1DS + QVA2 × 3). cron 16:35와 동일한 sequence를 admin에서 트리거. `patternState.refreshingAllBoards` / `allBoardsCurrent` / `allBoardsResults`로 진행 추적 |
| `POST /admin/refresh-1ds-intraday` | adminController.postRefresh1dsIntraday | **1DS 분봉 수집 + 보드 재생성** — `pipeline/collect-1ds-intraday.js --from-board` → `boards/oneDaySurge/one-day-surge-board.js` 백그라운드 순차. cron 09:31과 동일한 sequence를 admin "⚡ 1DS 분봉 수집 + 보드 갱신" 버튼에서 트리거. `patternState.refreshing1dsIntraday` / `oneDsIntradayPhase` / `oneDsIntradayCollected` / `oneDsIntradayFailed`로 진행 추적 |
| `POST /admin/run-daily-update` | adminController | `pipeline/run-daily-analysis.js` 강제 실행 |

기존에 있었지만 **현재는 없는** 라우트: `POST /search`, `/pattern`, `/scan`, `/backtest`, `/pdf`, `/pdf-viewer`, `/simple-report`, `/report`, `POST /subscribe`, `POST /ai/adjust`. UI는 단건 가중치 검색 모델에서 운영 보드 모델로 이전됐다.

### 종목 마스터 파이프라인

`pipeline/generate-stocks.js`는 KIS가 새 마스터 파일을 배포할 때 한 번씩 돌리는 일회성 도구다:
- `master/kospi_code.mst.zip`, `master/kosdaq_code.mst.zip`을 읽음
- `.mst` 엔트리를 **cp949**(UTF-8 아님)로 디코드 (iconv-lite 사용)
- `line.slice(0, len-228)`의 0/9/21 오프셋에서 고정폭 슬라이스 — 끝의 228바이트는 무시되므로, KIS가 레코드 포맷을 바꾸면 파서가 조용히 필드를 누락한다
- 평탄한 `stocks` 배열과 `byCode` 인덱스를 함께 `stocks.json`에 기록

[src/services/stocks/stocksLoader.js](src/services/stocks/stocksLoader.js)의 `loadStocks()`가 부팅 시 한 번 동기 적재한다. `getStocksMasterAge()`로 마스터 신선도(파일 mtime)를 admin 대시보드에 표시한다.

### KIS API 연결 (`src/services/kis/`)

- [kisToken.js](src/services/kis/kisToken.js) — `getAccessToken`. `.kis-token.json`에 24시간 토큰을 캐시. 만료 5분 전까지 재사용, 동시 호출은 `inflightIssue` 프로미스로 coalesce. KIS 토큰 발급 엔드포인트는 **1분당 1회** 제한(`EGW00133`)이 있어서 캐싱이 없으면 연속 호출 시 즉시 블록된다. 캐시 파일은 토큰 평문을 담으므로 `.gitignore` 처리.
- [kisApi.js](src/services/kis/kisApi.js) — `getCurrentPrice`, `getPeriodChart` 래퍼. KIS는 초당 호출 제한이 있어서 호출 사이 sleep이 **기능적으로 필수적**이다. 병렬화 금지.

현재 KIS 호출은 통일 상세 페이지(`qvaVviRedefinedController.getRedefinedVviStockDetail` — `/qva-vvi-redefined/:code`, `/qva2-*/:code`, `/stock/:code`, `/d5-rebreak/:code`가 공유)의 실시간 가격 1회 + `pipeline/update-flow-daily.js`/`update-daily-pykrx.py`(일일 갱신) 두 곳에서만 발생한다.

### 패턴 스크리너 (`screeners/pattern-screener.js`)

일일 갱신 파이프라인의 핵심 엔진. 약 5,000줄짜리 단일 모듈로, Minervini SEPA + Weinstein Stage 2 변형 (Trend Template, VCP, Breakout) + QVA(Quiet Volume Anomaly) + VVI + CSB + Rebound + 펀더멘탈을 결합해 후보군을 스코어링한다.

- **입력**: `cache/stock-charts-long/` (장기 일봉) + `cache/flow-history/` (수급) + DART 펀더멘탈
- **출력**: `cache/pattern-result.json` (5MB+)
- **트리거**: 16:10/16:20 cron 또는 `/admin/pattern/analyze`, `/admin/refresh-pattern-cache`
- **백테스트 재현**: `ANALYSIS_DATE` 환경변수로 기준일 강제
- **시총 필터**: `PATTERN_MAX_MARKETCAP` / `PATTERN_MIN_MARKETCAP`은 `screeners/naver-fetcher.js`에서 read

`screeners/pattern-screener.js`는 라우트 핸들러에 직접 노출되지 않는다 — 컨트롤러는 cache 파일을 읽어 렌더만 한다. seed/analyze는 [src/services/pattern/adminTriggers.js](src/services/pattern/adminTriggers.js)가 비동기로 띄우고 `patternState`로 진행 상태를 추적한다.

라이브 QVA 구현은 `screeners/pattern-screener.js`의 `calculateQuietVolumeAnomaly()`. 5가설(FIRST/2DAY/ABSORB/HIGHER_LOW/HOLD) 검증은 별도 일회성 스크립트 가족에서 했었지만 현재는 정리됐고, 라이브 boardgenerator (`boards/qva/qva-watchlist-board.js`)가 funnel 단계 시각화로 대체.

**VVI = VVI2 통일 (2026-05-17)**: 모든 VVI 검출은 `boards/qva2/qva2-screener.js`의 `findVvi2AfterQva2` (absorption type)로 통일됨. 원본 standalone VVI 검출 로직(volumeRatio20/valueRatio20/closeLocation 임계값)은 폐기되고, "QVA event를 anchor로 VVI2 absorption 발화 여부 검사"로 시맨틱이 바뀜.
- `screeners/pattern-screener.js`의 `calculateVolumeValueIgnition` 함수는 시그니처는 유지하되 내부적으로: (1) lastIdx-1 부터 40 거래일 거슬러 `calculateRedefinedQVA`로 직전 QVA anchor를 추론, (2) 첫 anchor에 대해 `findVvi2AfterQva2(rows, qvaIdx, ...)` 호출, (3) vvi2Idx === lastIdx면 passed. 호환 위해 `passed/category/signals.signalHigh/signals.signalClose` 등 기존 return shape는 유지.
- `boards/qva/qva-watchlist-board.js`는 (이 보드는 이미 qvaIdx를 알고 있어 anchor 추론이 불필요하므로) `findVvi2AfterQva2`를 **직접** import해서 호출. 3개 사이트(주 funnel VVI 검출 + EARLY_QVA 윈도우 체크 + LONG_QVA 윈도우 체크) 모두 단일 호출로 단순화.
- D+5 재돌파 보드(`boards/rebreak/`)는 `qva-watchlist-board.json`의 BREAKOUT_SUCCESS를 입력으로만 받으므로 자동으로 VVI2 결과를 상속.
- 1DS 보드(`boards/oneDaySurge/`)의 `vviRecentSignals` 참고 태그는 `cache/pattern-result.json` 경유 → cache 재생성(16:10 cron 또는 `/admin/refresh-pattern-cache`) 후 VVI2 결과로 갱신됨.
- `vvi.category`는 `STRONG_IGNITION`(volumeRatioToQva ≥ 1.5 + valueRatioToQva ≥ 1.5 + closeLocation ≥ 0.7) / `IGNITION`(그 외)로 derived. 원본의 STRONG_IGNITION/IGNITION 의미와 다르지만 `VVI_STRONG`/`VVI_IGNITION` 태그 분기는 그대로 유지됨.
- VVI 임계값 튜닝은 이제 `boards/qva2/qva2-screener.js`의 `VVI2_CONFIG` 한 곳에서 관리. QVA2 보드 가족과 H그룹/D+5 보드가 동일한 VVI2 detector를 공유한다.

### 운영 보드 — QVA Watchlist (`boards/qva/qva-watchlist-board.js`)

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

상수는 [boards/qva/qva-watchlist-board.js:33-39](boards/qva/qva-watchlist-board.js#L33-L39)에 모여있다 (`TRACKING_DAYS`, `LONG_QVA_START/END`, `RECENT_BREAKOUT_DAYS`, `RECENT_FAILED_DAYS`, `EXIT_THRESHOLD_PCT`). 백테스트 윈도우를 바꿀 때 이 상수만 건드리고 라이브 의미를 바꾸지 말 것.

`pattern-screener` + [boards/qva/vpr-analyzer.js](boards/qva/vpr-analyzer.js)를 사용해 funnel 단계와 후속 분석 태그를 계산하고, `qva-watchlist-board.html` + `boards/qva/qva-watchlist-board.json`을 ROOT에 정적 파일로 쓴다. `/qva-watchlist`는 sendFile만.

### 운영 보드 — D+5 재돌파 가족 (`hgroup-rebreak-*.js`)

H돌파일 고가 재돌파 = 강한 시그널 (n=186, 승률 75.27%, +6.83%) 이라는 검증 결과 위에 만든 운용 화면.

**중요한 D 기준의 차이**: D+5 재돌파의 D+0은 **H돌파일**이지 QVA 신호일이 아니다. `MAX_DAYS=5` ([boards/rebreak/hgroup-rebreak-operation-board.js:34](boards/rebreak/hgroup-rebreak-operation-board.js#L34))는 H돌파일로부터의 거래일 수. 입력은 `boards/qva/qva-watchlist-board.json`의 BREAKOUT_SUCCESS 종목만이고, 그 자체가 위 보드에서 5일 컷이므로 두 보드의 윈도우가 자연스럽게 일치한다.

| 스크립트 | 입력 | 출력 (under `reports/`) | 라우트 |
|---------|------|------------------------|--------|
| `boards/rebreak/hgroup-rebreak-operation-board.js` | `boards/qva/qva-watchlist-board.json` + `cache/stock-charts-long/` | `hgroup-rebreak-operation-board-result.{html,json}` | `/rebreak` |

스크립트들은 `boards/qva/qva-watchlist-board.json`을 **읽기만 하고 수정하지 않는다.** 운영 보드는 D+0~D+5 H그룹 후보의 H돌파일 고가 재돌파 상태와 기준 종가 이탈 여부를 추적하지, 매수 등급표를 만들지 않는다.

**D+5가 지난 종목은 어디로?** 어디로도 이관되지 않는다 — `/rebreak`에서 사라지고 QVA Watchlist의 BREAKOUT_SUCCESS에서도 빠진다. QVA_TRACKING은 "VVI 전" 조건 때문에 영구히 자격 없음. 장기 QVA는 위에서 본 배타 조건 때문에 자격 없음. 같은 종목에서 새 QVA가 발화하면 새 사이클로 처음부터 다시 들어온다.

종목별 상세(`/d5-rebreak/:code`)는 통일 상세 페이지(qva-vvi-redefined-detail.ejs)로 이관됐고, 보드/심층/백테스트 페이지는 모두 정적 HTML sendFile.

### 운영 보드 — 1-Day Surge Board (`boards/oneDaySurge/one-day-surge-board.js` + `boards/oneDaySurge/one-day-surge-core.js`)

QVA/VVI/H그룹과 **분리된 독립 보드**. 본체 점수에 QVA/VVI/BMS 조건을 섞지 않으며, QVA/VVI 이력은 카드 참고 태그로만 부착한다. 1차 버전은 일봉 캐시 기준 "다음 거래일 장초 단타 관심 후보 예비 보드"로, 실시간 분봉/호가/VI는 사용하지 않는다.

**파일 구조 (튜닝 시 한 곳만 고치면 보드+검증이 자동 동기화):**
- [boards/oneDaySurge/one-day-surge-core.js](boards/oneDaySurge/one-day-surge-core.js) — `CONFIG` 상수, `passesHardFilter`, `analyzeAt`, `scoreMetrics`, `classifyGroup` 등 점수/분류/필터 로직 일체. **임계값을 튜닝할 때는 이 파일만 고친다.**
- [boards/oneDaySurge/one-day-surge-board.js](boards/oneDaySurge/one-day-surge-board.js) — 라이브 보드 (오늘 후보 카드)
- [one-day-surge-nextday-validation-report.js](one-day-surge-nextday-validation-report.js) — 과거 N거래일 백테스트 검증 보고서
- [boards/oneDaySurge/one-day-surge-trade-plan.js](boards/oneDaySurge/one-day-surge-trade-plan.js) — 자동 참고 매매가 모듈. mainPool 상위 10개에 한해 SAFE/BALANCED/CLEAN/LIGHT 전략별 buyPrice(0.5~1.0% 눌림 지정가) / sellPrice1/2 / stopPrice + 손익비를 계산. 한국 호가 단위 round, CHASE_LIMIT_RATE=4% / INVALID_DROP_RATE=-3% 게이트로 WAIT_PULLBACK / ENTRY_INVALIDATED 분기. 기존 후보 선정/정렬은 무수정. **매수 추천이 아닌 참고 가격 — 시장가 매수 전제 X.**

- **입력**: `cache/stock-charts-long/{code}.json` (전 종목 일봉) + `cache/naver-stocks-list.json` (시총·`isEtf`·`isSpecial`) + `stocks.json` (보조) + (선택) `boards/qva/qva-watchlist-board.json` funnel + `cache/pattern-result.json`의 `vviRecentSignals`
- **출력**: `reports/one-day-surge-board-result.{html,json}` — 라우트 `/one-day-surge-board` (alias `/one-day-surge`, `/ods`)가 sendFile만
- **기준일**: 각 종목의 chart 캐시에서 가장 최근 volume>0 row. 보드 상단의 "분석 기준일"은 후보 풀에서 가장 흔한 baseDate.

**필터 (`passesHardFilter`, 차트 read 전에 적용):**
- ETF/ETN: naver `isEtf` 플래그
- 우선주/리츠/스팩/관리종목: naver `isSpecial` 플래그
- 키워드 매칭 (방어용): `EXCLUDE_NAME_KEYWORDS` (KODEX/TIGER/ACE/SOL/KBSTAR/HANARO/ARIRANG/TIMEFOLIO/KOSEF/히어로즈/PLUS/인버스/레버리지/리츠/스팩/제1~4호) + 종목명 끝 우선주 정규식 `/\s?\d*우[A-Z]?$/`
- 시총 < 500억 / ≥ 5조 / 시총 미확인 → 제외
- 결과: ~4270 chart 중 ~2350개를 **차트 파싱 전에 컷오프**해서 실제 처리량 절반 감소 → 1.8초 wall time

**stale 후보 가드 (2026-05-17, [boards/oneDaySurge/one-day-surge-board.js:1265](boards/oneDaySurge/one-day-surge-board.js#L1265))**: chart 캐시는 매일 OHLC=0 row가 추가되지만 거래정지/장기 미거래 종목은 `baseDate`(가장 최근 volume>0 row)가 옛 날짜로 떨어진다. 이런 후보는 1DS 매수 의미가 없고 `entryConfirmDate` / `targetDateForResult` 계산을 오염시킨다 (실제로 정상 후보 169건이 nextDayDir=null이고 stale 10건만 nextDayDir을 만들어 옛 날짜가 entryConfirmDate로 잡히는 사례 확인됨). → 후보 push 직후 가장 흔한 baseDate(consensus)를 산출하고, 거기서 **7 calendar days 이상 떨어진 후보는 제외**. 콘솔에 `🧹 stale 후보 N건 제외 (consensus baseDate YYYYMMDD에서 7일 이상 옛 후보 — 거래정지/미거래 추정)` 로그. 다른 funnel 보드(QVA / QVA2 / rebreak)는 D+0~D+30 추적 윈도우 안 옛 날짜가 의도된 동작이라 동일 가드 불필요.

**휴장일 처리 (2026-05-17, [boards/oneDaySurge/one-day-surge-board.js:60](boards/oneDaySurge/one-day-surge-board.js#L60))**: `getMarketStatus()`가 주말/한국 공휴일을 감지해 `status='holiday_closed'` 반환. KR_HOLIDAYS는 `screeners/pattern-screener.js`에서 export. `marketStatus.previousTradingDate`는 보드의 실제 데이터 `targetDateForResult`로 정정 (간단 holiday 목록 오차 보정). 상단 status banner(`computeBoardStatus`)는 휴장일이면 시각 무관 `'holiday'` 반환 → "📅 휴장일 (주말/공휴일/대체공휴일)". `renderTodayResult` 섹션 제목도 `📊 직전 거래일 1DS 결과 (YYYY-MM-DD)`로 자동 변경 + 보라색 휴장 안내 배너 prepend. `--force-status holiday_closed`로 테스트 가능.

**점수 구성**: 거래대금 증가(25) + 거래량 증가(15) + 종가 위치(20) + 당일 상승률(15) + 20일 고점 돌파/근접(15) + 거래대금 순위(10) − 윗꼬리(20) − 과열(20) − 위험(30) − 시가총액(8). 시총 감점은 1.5조~3조 -3 / 3조~5조 -8 / 500억~1,000억 -5, 핵심 1,000억~1.5조는 0.

**그룹 분류 (배타)**: D(과열·위험) → A(강한 단타) → B(장초 확인) → C(눌림 후 재상승) → null(드롭). 그룹별 상한 `CAP = { A: 80, B: 80, C: 60, D: 60 }`.

**위험 필터 면제 (`passesRiskFilter`)**: `prev_high_spike` / `peak_before_entry` 단독은 위험 자동 제외이나, **09:10~30 morningHigh 재돌파(`rebreakMorningHigh_10_30 ✓`)**가 함께 있으면 면제 → mainPool 진입 (`it.riskExempted = ['peak_before_entry', ...]`로 표시). 근거: "전일고가 돌파 + 첫10분고점 재돌파"는 강한 한입 패턴, "09:10에 빠졌다가 첫10분고점 재돌파"는 회복 흐름. 카드에는 `↗ 재돌파 회복 (peakBefore 면제)` / `↗ 강한 한입 (spike 면제)` chip 표시. `gap_hold_candle` / `trap_risk_high` / `risk_rebreak`는 면제 없음 (그룹 자체가 위험).

**검증 보고서 / ENTRY_CONFIRM 연구 / 날짜별 운영형 백테스트는 모두 제거됨**. `boards/oneDaySurge/one-day-surge-entry-confirm-report.js` 파일만 보존되어 라이브 보드의 분봉 분석 라이브러리(`computeIntradayMetrics`)로 사용된다.

**트리거**: 현재는 수동 실행만. cron 등록 / `/admin` 강제 재생성 / 검증 보고서 라우트 연결은 2차에서.

2차에서 실시간 1분/3분/5분 데이터(09:05/09:10 거래대금, 장초 고점 재돌파, VI 근접, VWAP 위 유지)를 추가할 예정 — 그때까지 1차 일봉 기반은 "예비 보드" 위치를 유지한다.

### 일일 갱신 파이프라인

[src/services/pattern/scheduledJobs.js](src/services/pattern/scheduledJobs.js)의 `registerSchedules()`가 `node-cron`으로 4개의 일일 작업을 등록 (시간은 KST):

| 시각 | 요일 | 작업 | 조건 |
|-----|------|------|------|
| 16:10 | 매일 | `pattern-screener.analyzeAll()` 호출 → `cache/pattern-result.json` 갱신 (종가 기준 신호 재계산만) | 항상 |
| 16:20 | 평일 (월-금) | `node pipeline/run-daily-analysis.js` 외부 실행 (차트+수급 갱신 + 재분석) | `patternState.analyzing`이 false일 때만 |
| 16:35 | 평일 (월-금) | **전체 보드 갱신** — `BOARD_SCRIPTS` 7개 순차 실행: `boards/qva/qva-watchlist-board.js` → `boards/qva/qva-vvi-redefined-board.js` → `boards/rebreak/hgroup-rebreak-operation-board.js` → `boards/oneDaySurge/one-day-surge-board.js` → `boards/qva2/qva2-watchlist-board.js` → `boards/qva2/qva2-d5-rebreak-board.js` → `boards/qva2/qva2-vvi-board.js`. 차트/수급 캐시는 16:20 일일 업데이트에서 이미 갱신됨 — 보드는 캐시 read만 | 항상 (보드별 실패는 다음 보드로 진행) |
| 09:30:00 | 평일 (월-금) | **1DS 분봉 수집 + 보드 재생성** ([refresh1dsIntraday](src/services/pattern/adminTriggers.js)) — `pipeline/collect-1ds-intraday.js --from-board`로 보드 mainPool 코드의 09:00~09:30 분봉을 KIS API에서 받아 `data/intraday/1ds/{오늘}/`에 저장 → `boards/oneDaySurge/one-day-surge-board.js` 재실행. 사용자가 09:30 정각 새로고침할 때 분봉 반영된 후보를 보도록 정각 시작. 보통 09:30:15~30 사이 완료, 사용자는 09:30:30+ 새로고침에서 확인 가능. 분봉 들어오면 trade plan이 분봉 기반(`strategySource: intraday`)으로 갱신되고, peak_before_entry/trap_risk 등 위험 태그가 걸리는 후보는 mainPool에서 빠짐 (단 morningHigh 재돌파 ✓ 면제) | 항상 |
| 09:32 | 평일 (월-금) | `reports/one-day-surge-board-result.json` 기반 단타 후보 메일 발송 ([sendOneDaySurgeMail](src/services/mail/oneDaySurgeMail.js) — TOP 5 + 추가 10 = 최대 15종목, manualTargets 매수/매도가 포함). 09:30 분봉 수집·보드 재생성 후 90초 마진 두고 발송 → 메일에 분봉 반영된 trade plan 포함. 6-field cron 표현식 `0 32 9 * * 1-5` | `MAIL_CRON_ENABLED=1`일 때만 |

각 스크립트의 역할:
- `pipeline/update-flow-daily.js` — KIS API로 최근 외국인/기관 수급 → `cache/flow-history/{code}.json` 증분 병합
- `update-daily-pykrx.py` — KIS API(파일명만 레거시)로 60일 일봉 → `cache/stock-charts-long/{code}.json` 병합. ThreadPoolExecutor 8 워커
- `pipeline/run-daily-analysis.js` — 위 두 캐시가 갱신된 뒤 pattern-screener를 호출, `cache/pattern-result.json`을 새로 쓴다
- `seed-historical-pykrx.py`, `seed-index-pykrx.py` — **일회성** 시드. FinanceDataReader 기반 (pykrx의 cp949/응답 버그 우회)

운영 서버에서 cron이 실패해도 `/admin/run-daily-update`, `/admin/refresh-pattern-cache`, `/admin/refresh-watchlist-board`로 수동 실행 가능.

### 캐시 디렉토리 구조

`.gitignore`는 `cache/*`를 기본 ignore하고, **운영 데이터로 동기화해야 하는 디렉토리만 화이트리스트**로 다시 추가한다 (`!cache/flow-history/`, `!cache/stock-charts-long/`, `!cache/pattern-result.json`). 새 캐시 디렉토리를 추가한다면 화이트리스트도 같이 갱신해야 한다.

| 경로 | 생산자 | 소비자 |
|------|--------|--------|
| `cache/stock-charts-long/{code}.json` | `update-daily-pykrx.py`, `seed-historical-pykrx.py` | `screeners/pattern-screener.js`, `boards/qva/qva-watchlist-board.js`, `hgroup-rebreak-*.js` |
| `cache/stock-charts/{code}.json` | `screeners/naver-fetcher.js` | 단기 분석 |
| `cache/flow-history/{code}.json` | `pipeline/update-flow-daily.js`, `seeds/seed-flow-naver.js` | `screeners/pattern-screener.js` |
| `cache/dart-financials/`, `cache/material-analysis/` | `screeners/dart-fetcher.js`, `seeds/seed-financials-history.js` | `screeners/pattern-screener.js` 펀더멘탈 |
| `cache/dart-shareholders/{code}.json` | `src/services/dart/dartShareholders.js` (DART hyslrSttus, 30일 TTL) | 종목 상세 페이지 — 최대주주+특수관계인 지분율, 유동주식수 추정 |
| `cache/dart-company-overview/{code}.json` | `src/services/dart/dartCompanyOverview.js` (DART cmpnyOvrviw, 30일 TTL) | 종목 상세 페이지 — 보통주 발행주식 총수(stk_total_no), 기타주식(vstk_total_no) |
| `cache/ai-comments/` | `/ai/comment` 라우트 ([src/services/ai/geminiComment.js](src/services/ai/geminiComment.js)) | UI 캐시 |
| `cache/pattern-result.json` | 16:10/16:20 cron, `/admin/refresh-pattern-cache` | `boards/qva/qva-watchlist-board.js`, 패턴 메일 |
| `cache/naver-stocks-list.json`, `cache/kospi-daily.json`, `cache/kosdaq-daily.json` | `screeners/naver-fetcher.js` 등 | 시드 단계 |
| `data/intraday/1ds/{YYYY-MM-DD}/{code}.json` | `pipeline/collect-1ds-intraday.js` (KIS `FHKST03010230`) | `boards/oneDaySurge/one-day-surge-board.js` (라이브 분봉 분석 — `one-day-surge-entry-confirm-report.computeIntradayMetrics` 라이브러리 호출) |

루트의 정적 출력물:
- `qva-watchlist-board.{html,json}` — `/qva-watchlist`가 sendFile하는 운영 보드
- `reports/hgroup-rebreak-operation-board-result.{html,json}` — `/rebreak`(= `/hgroup-rebreak-operation`)가 sendFile하는 D+5 재돌파 운용 보드
- `reports/one-day-surge-board-result.{html,json}` — `/one-day-surge-board`가 sendFile하는 단타 관심 후보 보드 (QVA/VVI와 독립)
- `reports/one-day-surge-intraday-missing.json` — 분봉 백필 시 누락/실패 누적 로그 (`pipeline/collect-1ds-intraday.js` 누적 append)
- `reports/qva-vvi-redefined-board-result.{html,json}` — 새 VVI 정의 (QVA 고가 + 거래량 + 거래대금 동시 재돌파) 후보 보드 (`/qva-vvi-redefined-board` sendFile). 기존 QVA/VVI/H그룹/재돌파 보드와 분리된 신규 보드.
- `reports/qva2-watchlist-board.{html,json}` — QVA2 H그룹/VPR 보드 (`/qva2-watchlist` sendFile). 기존 `/qva-watchlist` mirror — funnel(QVA2_NEW/QVA2_TRACKING/VVI2_FIRED/BREAKOUT_SUCCESS/FAILED) + 보조 태그. JSON의 `stages.BREAKOUT_SUCCESS`는 downstream `/qva2-d5-rebreak`이 입력으로 사용.
- `reports/qva2-d5-rebreak-board.{html,json}` — QVA2 D+5 재돌파 운용보드 (`/qva2-d5-rebreak` sendFile). 기존 `/rebreak` mirror — D+0(BREAKOUT)부터 D+1~D+5 재돌파 추적.
- `reports/qva2-vvi-board.{html,json}` — QVA2 고점 재돌파 보드 (`/qva2-vvi` sendFile). 기존 `/qva-vvi-redefined-board` mirror.

**2026-05-10 정리**: 7개 운영/실험 보드(QVA Watchlist / QVA 고점 재돌파 / D+5 재돌파 운용 / 1DS / QVA2 H그룹·D+5·고점 재돌파)와 어드민만 살리고, 나머지 보고서/백테스트(QVA2 validation·VVI2 backtest·pre-vvi2-watch·BMS audit·BMS forward validation·rebreak deep-dive·rebreak flow backtest·1DS validation·1DS entry-confirm·1DS entry-daily-backtest·QVA-VVI redefined backtest·dormant-spike-audit)와 그 라우트를 모두 제거했다. `boards/oneDaySurge/one-day-surge-entry-confirm-report.js` 파일만 라이브 1DS 보드의 `computeIntradayMetrics` 라이브러리 dependency로 보존 (보고서 라우트는 제거).

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
- `views/qva-vvi-redefined-detail.ejs` — **모든 종목 상세 페이지의 단일 템플릿** (재무·뉴스·공시 + 기업분석 3섹션 AI + Lightweight Charts)
- `views/admin/login.ejs` — `/admin/login`
- `views/admin/dashboard.ejs` — `/admin`

**모든 종목 상세 페이지를 QVA2 고점돌파 상세(qvaVviRedefinedController.getRedefinedVviStockDetail)로 통일 (2026-05-10, 1DS 합류 2026-05-17)**:
다음 10개 라우트 모두 동일 컨트롤러·동일 EJS를 공유한다 — `/qva-vvi-redefined/:code`, `/qva2-vvi/:code`, `/qva2-watchlist/:code`, `/qva2-d5-rebreak/:code`, `/stock/:code`, `/d5-rebreak/:code`, `/one-day-surge-board/:code`, `/one-day-surge/:code`, AI POST는 모두 `/<route>/:code/ai`. 보드 generator의 종목명 링크가 어느 라우트로 가도 같은 페이지를 보게 된다 (URL은 진입 보드 컨텍스트 보존, 페이지는 동일). 1DS는 메인 카드 + 09:30 스캐너 카드 + 공격형 TOP 카드 종목명이 모두 `/one-day-surge-board/:code`로 링크.
- 차트: TradingView Lightweight Charts v4 (CDN: `unpkg.com/lightweight-charts@4.2.0`). 3-pane 동기화 (캔들+MA6 / 거래량+MA20 / 거래대금+MA20), 기간 선택 1M/3M/6M/200D/1Y/ALL, 봉 개수에 따른 모드 자동 전환 (detail/mid/wide), 흰 배경 KIS 스타일.
- 발행 주식 정보: 보통주식수(DART cmpnyOvrviw `stk_total_no` 우선, 없으면 KIS `lstn_stcn` fallback) + 유동주식수(보통주식수 × (1 − 최대주주+특수관계인 지분율 / 100), DART hyslrSttus 기반 추정 — 5% 임원·우리사주 추가 lock-up 미반영). [src/utils/sharesInfo.js](src/utils/sharesInfo.js)의 `computeSharesInfo()`가 단일 진입점.
- D+5 재돌파의 H돌파일 마커·기준선 3개는 통일 과정에서 빠졌다 (qvaVviRedefined 컨트롤러는 보드 컨텍스트를 받지 않음). 운용에 다시 필요하면 lookupRebreakItem 같은 보강을 별도로 추가.

나머지는 모두 정적 HTML sendFile (운영 보드, D+5 재돌파 보드/심층/백테스트, qva-watchlist).

이전에 있던 `index.ejs`(단건 검색 폼), `pattern.ejs`(패턴 결과), `subscribe.ejs`, `scan.ejs`, `backtest.ejs`는 8c863eaf에서 제거됐다. PDFKit 기반 `/pdf*`, `/report*` 라우트도 함께 사라졌다.

새 EJS 템플릿을 추가할 때는 컨트롤러에서 `res.render(...)`로 명시적으로 호출해야 한다 — 자동 라우트는 없다.
