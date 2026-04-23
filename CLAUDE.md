# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 명령어

- 의존성 설치: `npm install`
- 웹 앱 실행: `node app.js` (포트는 `PORT` 환경변수, 기본값 `3012`)
- CLI 버전 실행: `node token-test.js` (stdin 대화형 프롬프트 — 비-TTY 환경에서는 동작하지 않음)
- 종목 마스터 재생성: `npm run generate-stocks` (`master/`의 zip을 읽어 `stocks.json` 작성)

테스트, 린터, 빌드 단계는 구성되어 있지 않다.

## 필수 환경변수

`.env` 파일(`dotenv`로 로드)에 다음이 정의되어야 한다:
- `KIS_APP_KEY`, `KIS_APP_SECRET` — 한국투자증권(KIS) Open API 자격증명
- `KIS_BASE_URL` — KIS API 호스트 (실전 / 모의 여부에 따라 달라짐)
- `PORT` — 선택사항, 웹 서버 포트

## 아키텍처

단일 프로세스 Node/Express 앱. 한국 주식(KOSPI/KOSDAQ)을 KIS Open Trading API로 조회하고, 점수화한 대시보드를 Chart.js로 렌더링한다.

### 검색 한 번당 데이터 흐름

1. 사용자가 종목명과 (선택적인) 가중치 변경 값을 `POST /search`로 제출한다.
2. `getStockCodeByName`이 시작 시 메모리에 로드해둔 `stocksData`에서 이름을 매칭한다. 정확히 일치하는 이름이 있으면 그것을 우선하고, 없으면 부분 일치(substring)를 후보로 반환(첫 후보 자동 선택).
3. `getAccessToken` → `getCurrentPrice` → 네 번의 `getPeriodChart` (`D`/`W`/`M`/`Y`)가 **순차적으로** 실행된다. 각 호출 전 `safeApiCall`이 300~1100ms를 대기한다. KIS는 초당 호출 제한이 있으므로 이 sleep은 **기능적으로 필수적**이다 — 병렬화하지 말 것.
4. KIS 원시 응답은 `normalizeCurrentPrice`, `normalizePeriodData`로 도메인 객체로 정규화된 뒤, `buildSeries`에서 차트용 시리즈(역순, 기간별 개수 절삭)로 재가공된다.
5. `buildScoreModel`이 7개의 서브 점수를 계산하고, 사용자가 지정한 가중치로 합쳐서 0~100의 `totalScore`와 verdict(판정)를 만든다.

### 종목 마스터 파이프라인

`generate-stocks.js`는 KIS가 새 마스터 파일을 배포할 때 한 번씩 돌리는 일회성 도구다:
- `master/kospi_code.mst.zip`, `master/kosdaq_code.mst.zip`을 읽음
- `.mst` 엔트리를 **cp949**(UTF-8 아님)로 디코드 (iconv-lite 사용)
- `line.slice(0, len-228)`의 0/9/21 오프셋에서 고정폭 슬라이스 — 끝의 228바이트는 무시되므로, KIS가 레코드 포맷을 바꾸면 파서가 조용히 필드를 누락한다
- 평탄한 `stocks` 배열과 `byCode` 인덱스를 함께 기록

`app.js`와 `token-test.js`는 둘 다 시작 시 `loadStocks()`를 동기적으로 수행하며, 모든 검색에서 배열을 선형 순회한다.

### 점수 모델 (`buildScoreModel`)

7개의 독립적인 스코어러가 각각 `{ score: 0~100, explanation }`을 반환한다. 모두 이미 불러온 일/주/월/연봉 시리즈만 읽고, 네트워크는 건드리지 않는다:

- `calculateVolumeScore` — 오늘 거래량 vs 20일 평균, 그리고 주/월/연 비율. 양음봉 및 종가 위치에 따른 가점/감점이 추가로 붙는다.
- `calculatePositionScore` — 현재가가 각 기간의 고저 범위에서 어디에 있는지. `positionBandScore`는 하단~중하단을 선호한다.
- `calculateTrendScore` — 현재가와 5/20/60일 SMA, 4/12주 SMA 관계
- `calculateRSI`(14기간), `calculateMACD`(12/26/9) — 모두 최근 60 거래일 종가만 사용
- `estimateTrappedZones` — 최근 120일을 24개 가격 구간으로 나누어 거래량 가중 히스토그램 작성. 현재가 위쪽 매물대 비율이 저항 점수로 환산되고, UI에 "매물대" 목록으로 표시된다.
- `calculateVolatilityScore` — 반비례: 20일 변동폭이 낮을수록 점수가 높음

`parseWeights`는 7개 폼 필드를 합계가 정확히 100이 되도록 재조정한다(반올림 보정은 첫 키에 더해진다). 가중치는 점수 합산에 쓰이고, 템플릿으로 다시 전달되어 폼이 이전 값을 유지한다.

### 렌더링

하나의 EJS 템플릿(`views/index.ejs`, 약 700줄)이 검색 폼, 가중치 그리드, 현재가 카드, 4개의 Chart.js 캔버스, 점수 세부 내역, 매물대 목록까지 전부 그린다. `/search` 응답은 매번 `index`를 전체 컨텍스트 객체(가중치와 `candidates` 포함)로 재렌더링하며, `GET /` 핸들러는 같은 형태에 필드를 null로 채워 쓴다. **새 점수 출력이나 시리즈를 추가하면 두 핸들러의 render 컨텍스트와 템플릿에 모두 반영해야 한다.**

### 주의해야 할 코드 중복

`token-test.js`는 `app.js`보다 먼저 만들어진 독립 CLI이며, 페치/정규화 로직(`getAccessToken`, `getCurrentPrice`, `getPeriodChart`, `normalizePeriodVolume`, 날짜 헬퍼)을 상당 부분 중복으로 갖고 있다. KIS 호출 형태나 정규화 방식을 바꾸면 양쪽에 모두 반영하거나, `token-test.js`가 `app.js`에서 import하도록 리팩터링해야 한다.
