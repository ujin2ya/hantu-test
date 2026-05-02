# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 명령어

- 의존성 설치: `npm install`
- Python 의존성 설치: `python -m venv .venv && .venv\Scripts\pip install -r requirements.txt` (Windows) — pykrx/pandas 기반 시드/갱신 스크립트용
- 웹 앱 실행: `node app.js` (포트는 `PORT` 환경변수, 기본값 `3012`)
- 종목 마스터 재생성: `npm run generate-stocks` (`master/`의 zip을 읽어 `stocks.json` 작성)

테스트, 린터, 빌드 단계는 구성되어 있지 않다. 운영 배포는 GitHub Actions(`.github/workflows/deploy.yml`)가 ydata.co.kr 서버에 SSH로 push해 PM2(`hantu-test` 프로세스)로 재기동한다.

## 필수 환경변수

`.env` 파일(`dotenv`로 로드)에 다음을 정의한다 (배포 환경에서는 GitHub Actions secrets로 주입):

**KIS API (필수)**
- `KIS_APP_KEY`, `KIS_APP_SECRET` — 한국투자증권 자격증명
- `KIS_BASE_URL` — 실전 / 모의 호스트

**외부 API**
- `GEMINI_API_KEY` — Gemini API. AI 코멘트(`/ai/comment`), 점수 조정(`/ai/adjust`), `ai-grounding.js`에서 사용. 미설정 시 해당 기능만 비활성
- `GEMINI_MODEL` (기본 `gemini-2.5-flash-lite`), `GEMINI_GROUNDING_MODEL` (기본 `gemini-2.5-flash`) — 모델 오버라이드
- `AI_GROUNDING_DAILY_LIMIT` — Gemini grounding 일일 호출 상한 (기본 50)
- `DART_API_KEY` — 공시·재무 조회 (`dart-fetcher.js`, `seed-financials-history.js`, pattern-screener의 펀더멘탈 스코어). 미설정 시 공시·재무 단계 skip

**인증/접근 제어**
- `SITE_PASSWORD` — 사이트 전체 비밀번호 게이트 (`/login`이 검증, 쿠키로 유지). 운영 환경에서만 활성
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

## 아키텍처

단일 프로세스 Node/Express 앱이 KIS Open Trading API, 네이버 모바일 API, DART API, Gemini를 조합해서 한국 주식(KOSPI/KOSDAQ)을 점수화·스크리닝·백테스트한다. 결과는 EJS 템플릿과 정적 HTML로 렌더링한다.

크게 네 개의 축이 한 코드베이스에 공존한다:
1. **종목 단건 검색** (`POST /search` + 점수 모델) — 4월 스택의 원형
2. **패턴 스크리너 + 백테스트 인프라** (`pattern-screener.js`, `_run*.js` 가족, QVA/VVI/Flow/Rebound/CSB/Regime 6+ 모델)
3. **일일 갱신 파이프라인** (`update-flow-daily.js`, `update-daily-pykrx.py`, `run-daily-analysis.js` + node-cron)
4. **운영 UI** (관리자 대시보드, 구독 메일, PDF 리포트)

### 검색 한 번당 데이터 흐름 (`POST /search`)

1. 사용자가 종목명 또는 종목코드와 (선택적인) 가중치 변경 값을 `POST /search`로 제출한다.
2. `getStockInfoByQuery`가 시작 시 메모리에 로드해둔 `stocksData`에서 질의어를 매칭한다. 우선순위는 `shortCode` 정확 일치 → `standardCode` 정확 일치 → 종목명 정확 일치 → 종목명 부분 일치(substring). 후보가 여러 개면 첫 번째가 자동 선택된다.
3. `getAccessToken` → `getCurrentPrice` → 네 번의 `getPeriodChart` (`D`/`W`/`M`/`Y`)가 **순차적으로** 실행된다. 각 호출 전 `safeApiCall`이 300~1100ms를 대기한다. KIS는 초당 호출 제한이 있으므로 이 sleep은 **기능적으로 필수적**이다 — 병렬화하지 말 것.
   - `getAccessToken`은 `.kis-token.json`에 24시간 토큰을 캐시한다. 만료 5분 전까지 재사용하고, 동시 호출은 `inflightIssue` 프로미스로 coalesce한다. KIS 토큰 발급 엔드포인트는 **1분당 1회** 제한(`EGW00133`)이 있어서 캐싱이 없으면 연속 검색 시 바로 블록된다. 캐시 파일은 토큰 평문을 담으므로 `.gitignore` 처리.
4. KIS 원시 응답은 `normalizeCurrentPrice`, `normalizePeriodData`로 도메인 객체로 정규화된 뒤, `buildSeries`에서 차트용 시리즈(역순, 기간별 개수 절삭)로 재가공된다.
5. `buildScoreModel`이 7개의 서브 점수를 계산하고, 사용자가 지정한 가중치로 합쳐서 0~100의 `totalScore`와 verdict(판정)를 만든다.

### 종목 마스터 파이프라인

`generate-stocks.js`는 KIS가 새 마스터 파일을 배포할 때 한 번씩 돌리는 일회성 도구다:
- `master/kospi_code.mst.zip`, `master/kosdaq_code.mst.zip`을 읽음
- `.mst` 엔트리를 **cp949**(UTF-8 아님)로 디코드 (iconv-lite 사용)
- `line.slice(0, len-228)`의 0/9/21 오프셋에서 고정폭 슬라이스 — 끝의 228바이트는 무시되므로, KIS가 레코드 포맷을 바꾸면 파서가 조용히 필드를 누락한다
- 평탄한 `stocks` 배열과 `byCode` 인덱스를 함께 기록

`app.js`는 시작 시 `loadStocks()`를 동기적으로 수행하며, 모든 검색에서 배열을 선형 순회한다.

### 점수 모델 (`buildScoreModel`)

7개의 독립적인 스코어러가 각각 `{ score: 0~100, explanation }`을 반환한다. 모두 이미 불러온 일/주/월/연봉 시리즈만 읽고, 네트워크는 건드리지 않는다:

- `calculateVolumeScore` — 오늘 거래량 vs 20일 평균, 그리고 주/월/연 비율. 양음봉 및 종가 위치에 따른 가점/감점이 추가로 붙는다.
- `calculatePositionScore` — 현재가가 각 기간의 고저 범위에서 어디에 있는지. `positionBandScore`는 하단~중하단을 선호한다.
- `calculateTrendScore` — 현재가와 5/20/60일 SMA, 4/12주 SMA 관계
- `calculateRSI`(14기간), `calculateMACD`(12/26/9) — 모두 최근 60 거래일 종가만 사용
- `estimateTrappedZones` — 최근 120일을 24개 가격 구간으로 나누어 거래량 가중 히스토그램 작성. 현재가 위쪽 매물대 비율이 저항 점수로 환산되고, UI에 "매물대" 목록으로 표시된다.
- `calculateVolatilityScore` — 반비례: 20일 변동폭이 낮을수록 점수가 높음

`buildScoreModel`은 점수 계산 후 `estimateBuyZones` + `buildBuyRecommendation`도 호출해서 **추천 매수 구간**을 함께 반환한다. `estimateBuyZones`는 최근 **60일**을 24 bin 히스토그램으로 만들고 현재가 아래쪽 거래량 bin들을 전부 `supportBins`로 내보낸다.

`buildBuyRecommendation`은 두 가지 방식을 **동시에** 계산해 UI 탭으로 제공한다:
- **fixed (A안, 기본 탭)** — 현재가 대비 고정 밴드 (공격 -1~-5% / 중립 -5~-10% / 보수 -10~-18%).
- **atr (B안)** — `calculateATRPercent`로 14일 ATR%를 구한 뒤 `× 0.5~1.5 / 1.5~3 / 3~5` 배수로 밴드를 동적 계산. 하한 0.5% / 상한 30%로 clamp. ATR 계산 불가 시 `null` → UI에서 탭 disable.

두 방식 모두 공통 헬퍼 `buildTiersFromBands`로 렌더링된다: 각 밴드 내에서 거래량 최대 bin을 고르고, 없으면 밴드 중앙에 가까운 고정 %로 fallback. 총점 기준(≥70 공격 / ≥50 중립 / 그 외 보수)으로 `recommendedTier`를 마킹해 두 탭 공통으로 하이라이트한다.

`parseWeights`는 7개 폼 필드를 합계가 정확히 100이 되도록 재조정한다(반올림 보정은 첫 키에 더해진다). 가중치는 점수 합산에 쓰이고, 템플릿으로 다시 전달되어 폼이 이전 값을 유지한다.

### 패턴 스크리너 (`pattern-screener.js`)

`/pattern` 라우트와 일일 갱신 파이프라인의 핵심 엔진. 약 5,000줄짜리 단일 모듈로, Minervini SEPA + Weinstein Stage 2 변형 (Trend Template, VCP, Breakout) + QVA(Quiet Volume Anomaly)를 결합해 후보군을 스코어링한다. 입력은 `cache/stock-charts-long/`의 장기 일봉 + `cache/flow-history/`의 수급 + DART 펀더멘탈, 출력은 `cache/pattern-result.json` (5MB+).

- `ANALYSIS_DATE` 환경변수로 기준일 강제 가능 — 백테스트 재현용
- `PATTERN_MAX_MARKETCAP`/`PATTERN_MIN_MARKETCAP` 시총 필터는 `naver-fetcher.js`에서 read
- `app.js`의 `/pattern` 핸들러는 cache를 읽어 렌더만 한다 — seed/analyze는 `/admin/pattern/seed`, `/admin/pattern/analyze` (관리자 전용)

### 일일 갱신 파이프라인

`app.js`가 `node-cron`으로 세 개의 일일 작업을 스케줄한다 (시간은 KST):
- 16:10 매일 — flow/차트 갱신 (`update-flow-daily.js`, `update-daily-pykrx.py`)
- 16:20 평일(월~금) — 패턴 분석 (`run-daily-analysis.js` → `pattern-screener.js`)
- 18:00 매일 — `MAIL_CRON_ENABLED=1`일 때만 패턴 결과 메일 발송

각 스크립트의 역할:
- `update-flow-daily.js` — KIS API로 최근 외국인/기관 수급 → `cache/flow-history/{code}.json` 증분 병합
- `update-daily-pykrx.py` — KIS API(pykrx 아님 — 파일명만 레거시)로 60일 일봉 → `cache/stock-charts-long/{code}.json` 병합. ThreadPoolExecutor 8 워커
- `run-daily-analysis.js` — 위 두 캐시가 갱신된 뒤 pattern-screener를 호출, `cache/pattern-result.json`을 새로 쓴다
- `seed-historical-pykrx.py`, `seed-index-pykrx.py` — **일회성** 시드. FinanceDataReader 기반 (pykrx의 cp949/응답 버그 우회)

운영 서버에서 cron이 실패해도 `/admin/run-daily-update`로 수동 실행 가능.

### 백테스트 도구군 (`_run*.js`)

루트의 `_run*.js`는 모두 CLI 진입점(독립 `node _runX.js`로 실행). 입력은 `cache/`의 기존 차트/수급 데이터, 출력은 `cache/backtest/` + 콘솔 로그. **app.js와 import 관계 없음** — 코드 변경이 라이브 서버를 깨지 않는다.

모델 가족(파일명에 버전 suffix가 있으면 진화판):
- **Flow Lead** (`_runFlowLead*.js` v1~v4) — 외국인/기관 수급 누적 변동 기반 매수 신호
- **VVI** (`_runVolumeValueIgnition.js`) — 거래대금 초동 신호. 결과 보고서는 `vvi-backtest-4methods.txt`, `vvi-breakout-confirm.txt`
- **CSB** (`_runCSB*.js`, `_runCSBTrade*.js`) — Compression-Support-Breakout (압축 후 지지 돌파)
- **Rebound** (`_runRebound.js`) — 단기 d1~d5 반등
- **Regime** (`_runRegime.js`) — 시장 리짐 분류 (bull/bear/sideways)
- **QVA** (`backtest-qva-*.js`, `analyze-qva-*.js`, `scan-qva-today.js`, `qva-full-month-tracking-report.js`) — Quiet Volume Anomaly의 5가설(FIRST/2DAY/ABSORB/HIGHER_LOW/HOLD) 검증. `pattern-screener.js`의 `calculateQuietVolumeAnomaly()`가 라이브 구현
- **Backtest base** (`_runBacktest.js`, `_runBacktest250.js`) — 250일 창 등 공통 백테스트

새 모델을 추가할 때 라이브에 결합하려면 `pattern-screener.js`로 옮겨와야 한다. `_run*.js`만으로는 cron이나 `/pattern`에 노출되지 않는다.

### 캐시 디렉토리 구조

`.gitignore`는 `cache/*`를 기본 ignore하고, **운영 데이터로 동기화해야 하는 디렉토리만 화이트리스트**로 다시 추가한다 (`!cache/flow-history/`, `!cache/stock-charts-long/`, `!cache/pattern-result.json`). 새 캐시 디렉토리를 추가한다면 화이트리스트도 같이 갱신해야 한다.

| 경로 | 생산자 | 소비자 |
|------|--------|--------|
| `cache/stock-charts-long/{code}.json` | `update-daily-pykrx.py`, `seed-historical-pykrx.py` | `pattern-screener.js`, `_run*.js` |
| `cache/stock-charts/{code}.json` | `naver-fetcher.js` | 단기 분석 |
| `cache/flow-history/{code}.json` | `update-flow-daily.js`, `seed-flow-naver.js` | `pattern-screener.js`, Flow 백테스트 |
| `cache/dart-financials/`, `cache/material-analysis/` | `dart-fetcher.js`, `seed-financials-history.js` | `pattern-screener.js` 펀더멘탈 |
| `cache/ai-grounding/{code}.json`, `cache/ai-grounding/_daily.json` | `ai-grounding.js` | `app.js` `/search` 응답 보강 |
| `cache/ai-comments/` | `app.js` `/ai/comment` | UI 캐시 (schema v2) |
| `cache/pattern-result.json` | `run-daily-analysis.js` → `pattern-screener.js` | `app.js` `/pattern` 렌더 |
| `cache/backtest/`, `cache/scan-candidates.json`, `cache/weight-tuner.json` | `_run*.js` | 콘솔/로컬 분석 |
| `cache/naver-stocks-list.json`, `cache/kospi-daily.json`, `cache/kosdaq-daily.json` | `naver-fetcher.js` 등 | 시드 단계 |

### 인증·구독·관리자

`app.js`의 라우트는 세 계층의 게이트를 가진다:

1. **사이트 게이트** — `SITE_PASSWORD` + `NODE_ENV=production`일 때만 활성. `/login` 미통과 시 모든 요청을 막는다 (`requireSiteAuth` 미들웨어).
2. **관리자 게이트** — `ADMIN_TOKEN`. `/admin`, `/admin/pattern/*`, `/admin/backtest/qva`, `/admin/refresh-pattern-cache`, `/admin/run-daily-update`, `/admin/send-pattern-mail` 등 운영 라우트 보호 (`requireAdmin`).
3. **구독** — `/subscribe`, `/unsubscribe`. `.subscribers.json` 평문 저장 (`.gitignore` 됨). `/admin/send-pattern-mail`로 수동 발송, 18:00 cron으로 자동 발송.

### 렌더링

EJS 템플릿:
- `views/index.ejs` (기존, 약 700줄) — `/`, `/search` 응답
- `views/pattern.ejs` — 패턴 스크리너 결과 대시보드
- `views/scan.ejs`, `views/backtest.ejs` — 정적 렌더 (현재는 헬퍼 페이지)
- `views/subscribe.ejs`, `views/site-login.ejs`
- `views/admin/dashboard.ejs`, `views/admin/login.ejs`

`/search` 응답은 매번 `index`를 전체 컨텍스트 객체(가중치와 `candidates` 포함)로 재렌더링하며, `GET /` 핸들러는 같은 형태에 필드를 null로 채워 쓴다. **새 점수 출력이나 시리즈를 추가하면 두 핸들러의 render 컨텍스트와 템플릿에 모두 반영해야 한다.**

루트의 `render.html`, `pattern-render.html`, `detail-render.html`은 정적 export 결과(스냅샷). PDF 라우트(`/pdf`, `/pdf-viewer`, `/simple-report`, `/report`)는 PDFKit으로 동적 생성한다.
