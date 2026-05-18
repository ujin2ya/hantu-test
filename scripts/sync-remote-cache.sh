#!/usr/bin/env bash
# 운영 서버(hajiny.co.kr) 캐시를 로컬로 동기화한다.
#
# 사용 시점: git push 전.
# 운영 서버는 매일 일일 업데이트 cron으로 cache를 갱신하는데, 우리가 local code를 commit/push하면
# GitHub Actions가 운영 서버에서 `git reset --hard origin/main`을 수행한다.
# 이때 운영 서버의 최신 cache가 git의 옛 cache로 덮어써져 데이터가 손실된다.
# 이 스크립트는 push 전에 운영 서버 cache를 git에 먼저 commit해서 그 손실을 막는다.
#
# 동기화 대상:
#   - cache/pattern-result.json
#   - cache/flow-history/{code}.json
#   - cache/stock-charts-long/{code}.json
#   - cache/market-state-live.json
#   - reports/                                      (보드 generator 산출물 — 16:35 cron의 결과.
#                                                    얘를 같이 받지 않으면 deploy reset --hard로 손실)
#   - qva-watchlist-board.{html,json}               (루트에 있는 QVA 운영 보드 산출물)
#   - data/intraday/1ds/{YYYY-MM-DD}/{code}.json  (1DS 분봉 — gitignore되어 git에는 안 들어가지만,
#                                                  로컬에서 1DS 보드 재생성 시 입력으로 필요)
#
# 비밀번호: .env의 REMOTE_SSH_PASSWORD에서 읽는다 (공백 줄·따옴표 모두 OK).
#
# 빠른 사용:
#   ./scripts/sync-remote-cache.sh                    # 전체 동기화 (~260MB tar)
#   ./scripts/sync-remote-cache.sh --minute-only      # 분봉만 빠르게 (~10MB tar) — 일봉/flow 제외
#   ./scripts/sync-remote-cache.sh --commit "메시지"  # 동기화 후 자동 commit (push는 별도)

set -euo pipefail

cd "$(dirname "$0")/.."

# 모드 파싱
MODE="full"
COMMIT_MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --minute-only) MODE="minute"; shift ;;
    --commit) COMMIT_MSG="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# .env 로드 (KEY=VALUE 한 줄씩)
if [ -f .env ]; then
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    export "$key=$val"
  done < <(grep -E '^[A-Za-z_][A-Za-z_0-9]*=' .env)
fi

REMOTE_HOST="${REMOTE_SSH_HOST:-hajiny.co.kr}"
REMOTE_PORT="${REMOTE_SSH_PORT:-1027}"
REMOTE_USER="${REMOTE_SSH_USER:-eugene}"
REMOTE_PATH="${REMOTE_SSH_PATH:-/home/eugene/workspace/hantu-test}"
PASSWORD="${REMOTE_SSH_PASSWORD:-}"

if [ -z "$PASSWORD" ]; then
  echo "❌ ERROR: .env에 REMOTE_SSH_PASSWORD가 없습니다."
  echo "   .env에 다음 한 줄을 추가하세요 (.env.example 참고):"
  echo "   REMOTE_SSH_PASSWORD=비밀번호"
  exit 1
fi

# plink/pscp 존재 확인 (PuTTY)
for tool in plink pscp; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "❌ ERROR: $tool 명령을 찾을 수 없습니다 (PuTTY 설치 필요)."
    echo "   Windows: choco install putty 또는 https://www.chiark.greenend.org.uk/~sgtatham/putty/"
    exit 1
  fi
done

REMOTE_TARGET="$REMOTE_USER@$REMOTE_HOST"
REMOTE_TMP="/tmp/hantu-cache-$$.tar.gz"
LOCAL_TMP="cache/.sync-tmp.tar.gz"

echo "🔄 운영 서버 캐시 동기화 시작 ($REMOTE_TARGET:$REMOTE_PORT)  [mode=$MODE]"
echo

# tar에 포함할 대상 (모드에 따라)
if [ "$MODE" = "minute" ]; then
  # 분봉 + 검증 결과만 (일봉/flow/보드 캐시 제외 — 빠름)
  TAR_TARGETS="cache/kis-minute reports/qva-vvi2-pre-intraday-minute-validation-result.json reports/qva-vvi2-pre-intraday-minute-validation-result.html reports/qva-vvi2-pre-intraday-fetch-failures.json data/intraday/1ds"
else
  TAR_TARGETS="cache/flow-history cache/stock-charts-long cache/pattern-result.json cache/market-state-live.json cache/kis-minute reports qva-watchlist-board.html qva-watchlist-board.json data/intraday/1ds"
fi

# 1) 원격에서 tar.gz 만들기
echo "[1/4] 원격에서 tar.gz 만들기..."
plink -P "$REMOTE_PORT" -pw "$PASSWORD" -batch "$REMOTE_TARGET" \
  "cd '$REMOTE_PATH' && tar -czf '$REMOTE_TMP' $TAR_TARGETS 2>/dev/null; ls -la '$REMOTE_TMP'"

# 2) 로컬로 다운로드
echo "[2/4] tar.gz 다운로드..."
pscp -P "$REMOTE_PORT" -pw "$PASSWORD" -batch -q "$REMOTE_TARGET:$REMOTE_TMP" "$LOCAL_TMP"

# 3) 압축 풀기 (ROOT 기준 — cache/, data/intraday/1ds/ 둘 다 풂)
echo "[3/4] 압축 풀기..."
tar -xzf "$LOCAL_TMP" -C .
rm -f "$LOCAL_TMP"

# 4) 원격 cleanup
echo "[4/4] 원격 임시 파일 정리..."
plink -P "$REMOTE_PORT" -pw "$PASSWORD" -batch "$REMOTE_TARGET" "rm -f '$REMOTE_TMP'" >/dev/null 2>&1 || true

echo
echo "✅ 캐시 동기화 완료"
echo
echo "동기화된 핵심 파일:"
ls -la cache/pattern-result.json 2>/dev/null | sed 's/^/  /'
ls -la cache/flow-history/000020.json 2>/dev/null | sed 's/^/  /' || true
ls -la cache/stock-charts-long/018880.json 2>/dev/null | sed 's/^/  /' || true
echo "동기화된 보드 산출물:"
ls -la qva-watchlist-board.html reports/qva2-watchlist-board.html reports/qva2-d5-rebreak-board.html reports/qva2-vvi-board.html reports/hgroup-rebreak-operation-board-result.html reports/qva-vvi-redefined-board-result.html reports/one-day-surge-board-result.html 2>/dev/null | sed 's/^/  /' || true
echo "동기화된 1DS 분봉 (최근 3거래일):"
ls -1 data/intraday/1ds/ 2>/dev/null | sort | tail -3 | sed 's/^/  /' || true

# 옵션: --commit 으로 자동 commit
if [ -n "$COMMIT_MSG" ]; then
  echo
  echo "🗂️  자동 commit (push는 별도): $COMMIT_MSG"
  git add cache/pattern-result.json cache/flow-history cache/stock-charts-long reports qva-watchlist-board.html qva-watchlist-board.json 2>/dev/null || true
  if git diff --cached --quiet; then
    echo "   변경 없음 — commit 생략"
  else
    git commit -m "$COMMIT_MSG

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  fi
fi
