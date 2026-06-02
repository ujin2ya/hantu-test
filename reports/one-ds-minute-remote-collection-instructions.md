# 1DS 관찰 제외 +8% 백테스트용 분봉 백필 — 운영 서버 작업 지시문

## To: 운영 서버 Claude (ydata.co.kr / hantu-test)

> 로컬에서 만든 missing CSV(`one-ds-minute-missing-list.csv`)를 입력으로 받아 KIS API를 통해 1분봉을 09:00~15:30 전체 수집하는 일회성 작업이다. 운영 보드/cron/라우터에는 일체 손대지 말 것. 작업 결과(`data/intraday/1ds/`)만 갱신하면 된다.

---

## 0. 작업 배경 (요약)

로컬에서 1DS 관찰 제외 +8% 가설 검증 백테스트를 준비 중이다. 기존 09:30 cron이 받은 분봉은 09:00~10:00 default 윈도우라 09:00~15:30 전체가 필요한 이번 백테스트에 부족하다. 운영 서버는 KIS API에 접근 가능하므로 missing 항목만 골라서 full-day 분봉을 다시 받아준다.

대상: A 공격형 + B 10시 생존 + D 관찰 제외 +8% **이벤트 종목만** (574건 unique date-code 중 partial 361건 = 09:00~10:00만 있어서 재수집 필요).

C 관찰 제외 전체(약 18,000건)는 **수집 대상 아님** — 절대 받지 말 것.

---

## 1. 사전 점검 (필수)

운영 서버 작업 시작 전에 다음을 확인한다.

```bash
# 1. 현재 작업 디렉토리가 hantu-test 인지
cd /home/eugene/workspace/hantu-test
pwd  # → /home/eugene/workspace/hantu-test 확인

# 2. cron이 분봉 수집 중이 아닌지 (09:30 / 09:35 / 12:30 / 15:30 cron 충돌 방지)
date  # → 09:30~09:40 / 12:30~12:40 / 15:30~15:40 시간대 피하기

# 3. KIS API 토큰 정상 동작 확인
node -e "require('./src/services/kis/kisToken').getAccessToken().then(t => console.log('TOKEN OK', t.slice(0, 20) + '...')).catch(e => { console.error('TOKEN FAIL', e.message); process.exit(1); });"
```

`reports/.qva-live-watch.lock` 파일이 있으면 12:30 / 15:30 cron이 돌고 있는 중이다. 그 경우 cron이 끝날 때까지 대기 (보통 2~7분).

---

## 2. 입력 파일 전송 (로컬 → 운영 서버)

로컬에서 다음 파일을 운영 서버로 복사한다. 운영 서버 Claude는 이미 파일이 도착했다고 가정해도 좋다 (사용자가 scp로 보낼 예정).

| 로컬 경로 | 운영 서버 경로 |
|---|---|
| `reports/one-ds-minute-missing-list.csv` | `~/hantu-test/reports/one-ds-minute-missing-list.csv` |

서버에서 CSV가 도착했는지 확인:
```bash
ls -la reports/one-ds-minute-missing-list.csv
head -5 reports/one-ds-minute-missing-list.csv
wc -l reports/one-ds-minute-missing-list.csv
```

기대 형식 (1행 header + 데이터):
```
trade_date,code,name,required_from_time,required_to_time,group,event_count,missing_reason
2026-05-06,000020,"동화약품",09:00,15:30,D_EXCLUDED_PLUS8,1,last_bar_10:00
...
```

---

## 3. 수집 명령 (단일 명령으로 실행 가능)

`pipeline/collect-1ds-intraday.js`가 `--codes A,B,C... --target-date YYYY-MM-DD --full-day` 옵션을 지원한다. CSV를 일자별로 그룹화해서 각 일자마다 한 번씩 호출하면 된다.

**한 번에 처리하는 helper script**를 운영 서버에서 직접 실행한다 (별도 파일 생성 없이 inline node):

```bash
node -e "
const fs = require('fs');
const { execSync } = require('child_process');
const lines = fs.readFileSync('reports/one-ds-minute-missing-list.csv', 'utf-8')
  .split(/\r?\n/).slice(1).filter(l => l.trim());
const byDate = new Map();
for (const line of lines) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}),(\d{4,6})/);
  if (!m) continue;
  const date = m[1], code = m[2];
  if (!byDate.has(date)) byDate.set(date, new Set());
  byDate.get(date).add(code);
}
console.log('총', byDate.size, '거래일,', lines.length, '건');
const dates = [...byDate.keys()].sort();
for (const date of dates) {
  const codes = [...byDate.get(date)].sort().join(',');
  const n = byDate.get(date).size;
  console.log('▶', date, '—', n, '종목 수집 시작');
  try {
    execSync('node pipeline/collect-1ds-intraday.js --target-date ' + date + ' --codes ' + codes + ' --full-day --sleep 400 --retry 2', { stdio: 'inherit' });
    console.log('✓', date, '완료\n');
  } catch (e) {
    console.error('✗', date, '실패:', e.message, '— 다음 일자로 계속');
  }
}
console.log('전체 종료');
"
```

설명:
- `--target-date YYYY-MM-DD`: 일자 강제 지정
- `--codes A,B,C,...`: missing list의 그 일자 해당 코드만 (전체 종목 수집 X)
- `--full-day`: 09:00~15:30 종일 수집 (종목당 4 KIS 호출)
- `--sleep 400`: KIS rate limit 방어 (운영 cron보다 살짝 보수적)
- `--retry 2`: 실패 시 재시도

collector는 **멱등** — 이미 수집된 종목 중 `--full-day` 모드에서 마지막 bar ≥ 15:00이면 skip한다. 즉 partial 파일(09:00~10:00만 있음)은 자동으로 재수집되고, 이미 complete였던 파일은 건드리지 않는다.

---

## 4. 예상 시간

| 일자 수 | 종목 수 | 종목당 호출 | 총 KIS 호출 | sleep 400ms | 예상 시간 |
|---|---|---|---|---|---|
| 20 거래일 | 361건 (partial) | 4 | ~1,444 | 400ms × 4 + 처리 | **약 30~40분** |
| 60 거래일 | ~1,100건 추정 | 4 | ~4,400 | 〃 | **약 90~120분** |

KIS rate limit 에러(`EGW`)가 발생하면 자동으로 retry 2회. 그래도 실패하면 `reports/one-day-surge-intraday-missing.json`에 누적 기록되고 다음 일자로 진행.

---

## 5. 진행 확인 (작업 중)

별도 터미널에서 모니터링:
```bash
# 새로 추가된 분봉 파일 카운트
watch -n 30 "ls data/intraday/1ds/2026-05-*/ data/intraday/1ds/2026-06-*/ 2>/dev/null | wc -l"

# 또는 일자별 file count
for d in data/intraday/1ds/2026-05-*/; do echo "$(basename $d): $(ls $d | wc -l)"; done
```

---

## 6. 완료 후 검증 (운영 서버에서)

수집이 끝나면 각 missing 일자의 분봉이 15:30까지 다 있는지 확인:

```bash
node -e "
const fs = require('fs');
const lines = fs.readFileSync('reports/one-ds-minute-missing-list.csv', 'utf-8')
  .split(/\r?\n/).slice(1).filter(l => l.trim());
let complete = 0, partial = 0, missing = 0;
for (const line of lines) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}),(\d{4,6})/);
  if (!m) continue;
  const p = 'data/intraday/1ds/' + m[1] + '/' + m[2] + '.json';
  if (!fs.existsSync(p)) { missing++; continue; }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const bars = j.bars || [];
    const last = bars.length ? bars[bars.length - 1].time : '';
    if (last >= '15:30' && bars.length >= 300) complete++;
    else partial++;
  } catch { missing++; }
}
console.log('수집 후 검증 — complete:', complete, 'partial:', partial, 'missing:', missing);
"
```

complete가 missing CSV 줄 수(361건)에 근접하면 성공. partial이 여전히 많으면 일부 종목의 KIS 응답이 부분만 와서 발생하므로, 같은 명령을 한 번 더 돌리면 보강된다.

---

## 7. 로컬 sync (운영 서버 → 로컬)

운영 서버 작업이 끝났음을 사용자에게 알리고, 사용자가 로컬에서 다음 명령을 실행하도록 안내한다 (운영 서버 작업이 아님):

```bash
# 로컬에서 실행
bash scripts/sync-remote-cache.sh
# 또는 분봉만 따로 받고 싶다면 (sync-remote-cache.sh가 이미 data/intraday/1ds 포함)
```

`sync-remote-cache.sh`가 `cache/` + `reports/` + `data/intraday/1ds/` 를 운영 서버에서 받아온다.

---

## 8. 다음 단계 (로컬에서 — 운영 서버 작업 아님)

분봉이 동기화되면 사용자가 로컬에서 다음을 실행한다:

```bash
# 1. 커버리지 재확인
node scripts/one-ds-minute-coverage-check.js

# 2. complete이 충분히 늘었으면 백테스트 실행
node scripts/one-ds-excluded-plus8-intraday-hold-rebreak-audit.js --days=20
```

---

## 9. 절대 하지 말 것 (운영 서버 작업 가드)

- 기존 1DS 보드 (`boards/oneDaySurge/one-day-surge-board.js`) 수정 금지
- 기존 cron 일정 (`src/services/pattern/scheduledJobs.js`) 수정 금지
- 기존 라우터/컨트롤러 수정 금지
- `data/intraday/1ds/` 외 다른 디렉토리 건드리지 말 것
- KIS rate limit를 무시한 `--sleep 0` / `--sleep 100` 같은 공격적 옵션 금지 (운영 토큰 차단 위험)
- C 관찰 제외 전체(missing CSV에 없는 종목)를 추가로 수집하지 말 것
- 사용자가 명시적으로 요청하지 않은 git commit / push 금지

---

## 10. 오류 대응

| 증상 | 대응 |
|---|---|
| `TOKEN FAIL` | `.env`의 `KIS_APP_KEY` / `KIS_APP_SECRET` 확인. 1분 대기 후 재시도 (KIS 토큰 발급 1분 1회 제한) |
| `EGW00133` 다발 | sleep을 600ms로 늘려서 재실행: `--sleep 600` |
| 특정 일자만 계속 실패 | 그 일자의 cron lock 파일 확인 (`reports/.qva-live-watch.lock`). 있으면 삭제하지 말고 cron이 끝날 때까지 대기 |
| 디스크 부족 | `data/intraday/1ds/` 가 ~300MB까지 증가 가능. df로 확인 |
| 작업 중간에 중단됨 | 멱등이라 같은 명령 재실행하면 이미 받은 것 skip, 남은 것만 받음 |

---

## 11. 작업 완료 보고 형식

운영 서버 Claude는 작업 종료 시 다음 정보를 사용자에게 보고한다:

1. 처리한 일자 수 + 종목 수
2. complete / partial / missing 최종 카운트 (위 §6 검증 명령 결과)
3. `reports/one-day-surge-intraday-missing.json`의 신규 실패 항목 수
4. 총 소요 시간
5. KIS API 호출 횟수 추정

예시 보고:
> "20거래일 partial 361건 백필 완료. complete 348 / partial 11 / missing 2. 실패 2건 (KIS rate limit, 다음 실행 시 자동 재시도 가능). 총 38분 소요. 다음: 사용자가 로컬에서 `bash scripts/sync-remote-cache.sh` 실행 후 백테스트 진행."
