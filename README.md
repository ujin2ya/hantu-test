# 한투 점수화 대시보드

한국투자증권(KIS) Open API로 KOSPI/KOSDAQ 종목의 시세·거래량·이동평균·RSI·MACD·매물대·변동성을 가져와 **0~100점으로 종합 점수화**하고, Chart.js로 일/주/월/연봉을 함께 보여주는 Express 웹 앱이다.

## 주요 기능

- 종목명 검색 (정확 일치 우선, 없으면 부분 일치 후보 반환)
- 현재가 / 전일대비 / 등락률 / 당일 거래량·거래대금 표시
- 일봉 60개, 주봉 52개, 월봉 36개, 연봉 5개 차트
- 7개 지표(거래량 · 위치 · 추세 · RSI · MACD · 매물대 저항 · 변동성)를 **사용자 가중치**로 합산한 종합 점수와 판정(verdict)
- 현재가 위쪽 상위 매물대 3개 구간 표시

## 사전 요구사항

- Node.js 18 이상 권장 (Express 5 / axios 1.15 사용)
- 한국투자증권 Open API 신청 후 발급받은 **APP KEY / APP SECRET**
- 실전 투자 계정 또는 모의투자 계정 (둘은 `KIS_BASE_URL`이 다름)

## 설치

```bash
git clone <이 저장소>
cd hantu-test
npm install
```

## 환경변수 설정 (`.env`)

프로젝트 루트에 `.env` 파일을 만들고 다음 값을 채운다:

```
KIS_APP_KEY=발급받은_APP_KEY
KIS_APP_SECRET=발급받은_APP_SECRET
KIS_BASE_URL=https://openapi.koreainvestment.com:9443
PORT=3012
```

- 실전 투자: `https://openapi.koreainvestment.com:9443`
- 모의 투자: `https://openapivts.koreainvestment.com:29443`
- `PORT`는 선택사항(기본값 `3012`)

## 종목 마스터 생성 (최초 1회 또는 KIS 배포 시 갱신)

저장소에는 이미 `stocks.json`이 포함되어 있지만, 상장·폐지 변경을 반영하려면 마스터를 다시 생성해야 한다.

1. KIS가 배포하는 종목 마스터 파일을 받아 `master/` 폴더에 둔다:
   - `master/kospi_code.mst.zip`
   - `master/kosdaq_code.mst.zip`
2. 변환 스크립트 실행:

   ```bash
   npm run generate-stocks
   ```

   - `.mst` 파일은 **cp949** 인코딩이다. 스크립트가 iconv-lite로 알아서 디코드한다.
   - 실행이 끝나면 루트의 `stocks.json`이 갱신된다.

## 실행

### 웹 앱

```bash
node app.js
```

콘솔에 `서버 실행: http://localhost:3012` 이 출력되면 브라우저로 접속한다. 종목명(예: `삼성전자`)을 입력하고 필요하면 가중치를 조정한 뒤 **검색** 버튼을 누른다.

### CLI 버전 (디버깅용)

```bash
node token-test.js
```

대화형으로 종목명을 물어보고, 동명이 종목이 여러 개면 번호를 선택받는다. 이후 현재가·일·주·월·연봉 거래량을 콘솔에 출력한다. (비-TTY 환경에서는 stdin 대기로 멈추므로 터미널에서 직접 실행할 것.)

### 상용 서버 구동 (PM2)

상용 서버에서는 프로세스가 죽을 때 자동 재시작되고 부팅 시에도 살아나도록 [PM2](https://pm2.keymetrics.io/)로 띄우는 것을 권장한다. PM2는 `.env`를 건드리지 않으며, 앱 내부의 `dotenv`가 그대로 로드한다.

1. PM2 설치 (전역):

   ```bash
   npm install -g pm2
   ```

2. 앱 시작 (프로세스 이름 `hantu-test`):

   ```bash
   pm2 start app.js --name hantu-test
   ```

   PORT를 명령 한 줄에서 바꾸고 싶으면 `PORT=8080 pm2 start app.js --name hantu-test` 처럼 앞에 붙인다.

3. 재부팅 후 자동 기동:

   ```bash
   pm2 save
   pm2 startup          # 출력되는 sudo 명령을 한 번 그대로 실행
   ```

   `pm2 startup`이 안내하는 `sudo env PATH=... pm2 ...` 커맨드를 복사해 그대로 실행해야 부팅 스크립트가 등록된다.

4. 자주 쓰는 관리 명령:

   | 동작 | 명령 |
   | --- | --- |
   | 상태 확인 | `pm2 status` 또는 `pm2 list` |
   | 실시간 로그 | `pm2 logs hantu-test` |
   | 재시작 | `pm2 restart hantu-test` |
   | 코드 무중단 갱신 | `git pull && pm2 reload hantu-test` |
   | 중지 | `pm2 stop hantu-test` |
   | 목록에서 제거 | `pm2 delete hantu-test` |

#### ecosystem 설정 파일로 관리 (선택)

여러 프로세스를 쓰거나 환경변수를 PM2에서 관리하고 싶으면 루트에 `ecosystem.config.js`를 두고 `pm2 start ecosystem.config.js`로 띄운다. 예시:

```js
module.exports = {
  apps: [
    {
      name: "hantu-test",
      script: "app.js",
      instances: 1,          // KIS API가 초당 호출 제한이 있으므로 1로 고정
      exec_mode: "fork",     // cluster로 띄우면 토큰 발급/레이트리밋이 꼬인다
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        PORT: 3012,
      },
    },
  ],
};
```

> **주의:** `app.js`는 내부적으로 호출 간 sleep으로 KIS 초당 제한을 맞추므로, PM2 cluster 모드나 다중 인스턴스는 쓰지 말 것. 프로세스가 2개 이상이면 동시 호출이 발생해 토큰/시세 API가 레이트리밋에 걸린다.

## 가중치 조정 가이드

검색 폼 아래의 가중치 입력은 7개 지표에 대한 상대적 중요도다. 합이 100이 아니어도 내부에서 자동 정규화된다. 기본값은 다음과 같다:

| 지표 | 기본 가중치 | 설명 |
| --- | --- | --- |
| 거래량 (volume) | 30 | 당일 거래량이 평균 대비 얼마나 많은지 |
| 위치 (position) | 20 | 현재가가 각 기간 고저 범위에서 어디에 있는지 (하단 선호) |
| 추세 (trend) | 10 | 이동평균선 정배열 여부 |
| RSI | 5 | 과매도권 가점, 과매수권 감점 |
| MACD | 5 | MACD 선이 시그널 선 위면 가점 |
| 매물대 저항 (resistance) | 20 | 현재가 위쪽 매물대가 적을수록 가점 |
| 변동성 (volatility) | 10 | 20일 평균 변동폭이 낮을수록 가점 |

## 디렉터리 구조

```
.
├── app.js                # Express 웹 앱 (메인 엔트리)
├── token-test.js         # 대화형 CLI 버전
├── generate-stocks.js    # KIS 마스터 zip → stocks.json 변환기
├── stocks.json           # 종목 메타 (이름/단축코드/표준코드/시장)
├── master/               # KIS 마스터 파일(zip) 보관 위치
│   ├── kospi_code.mst.zip
│   └── kosdaq_code.mst.zip
├── views/
│   └── index.ejs         # 단일 페이지 EJS 템플릿
├── .env                  # 환경변수 (직접 생성, 커밋 금지)
└── package.json
```

## 주의사항

- KIS Open API는 **초당 호출 제한**이 있다. 코드는 각 API 호출 전 300~1100ms를 대기하도록 돼 있으므로 임의로 병렬화하지 말 것.
- 토큰 발급(`/oauth2/tokenP`)은 하루 호출 횟수 제한이 있으니, 짧은 시간 안에 앱을 반복 재시작하면 `초당 1회` 등의 에러가 날 수 있다.
- `.env`와 `master/` 안의 zip은 커밋하지 않는 것을 권장한다.
- 본 앱의 점수와 판정은 **참고용**이며, 매매 신호로 해석되지 않아야 한다.
