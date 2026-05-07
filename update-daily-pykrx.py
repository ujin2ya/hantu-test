#!/usr/bin/env python3
"""
Daily chart update — KIS API 기반 최근 5거래일 갱신 (병렬 처리)

대상: naver-stocks-list.json의 전체 종목 (4,260개)
소스: KIS API (한국투자증권) — 공식 차트 데이터
출력: cache/stock-charts-long/{code}.json

동작:
1. naver-stocks-list.json에서 종목 코드 읽기
2. 각 종목별로 KIS API로 60일 조회 (최근 5거래일 포함)
3. stock-charts-long/{code}.json과 merge
   - 같은 date: replace
   - 새 date: append
   - 정렬, 중복 제거
   - 보존 행 수: env CHART_KEEP_ROWS (기본 1000, 약 4년치) 까지만 유지
     QVA/VVI/H/VPR 장기 백테스트를 위해 최소 3년치 일봉이 필요하므로
     기본값을 1000으로 둔다. 120으로 자르면 QVA 검출(idx>=60) 및 장기 백테스트
     표본이 크게 부족해진다.
4. ThreadPoolExecutor로 병렬 처리 (8개 워커, 5-10배 성능 향상)

실행:
  python update-daily-pykrx.py [limit]
  python update-daily-pykrx.py 2  # 테스트: 2개 종목만
"""

import json
import os
import random
import sys
import time
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Any
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from dotenv import load_dotenv

# ─── Config ───
ROOT = Path(__file__).parent
load_dotenv(ROOT / '.env')  # 명시적 경로 지정
STOCKS_LIST_PATH = ROOT / "cache" / "naver-stocks-list.json"
CHART_LONG_DIR = ROOT / "cache" / "stock-charts-long"
TOKEN_CACHE_FILE = ROOT / ".kis-token.json"  # app.js / update-flow-daily.js와 공유
# 장기 캐시 보존 행 수 — QVA/VVI/H/VPR 장기 백테스트용으로 기본 1000(약 4년치) 유지.
# 120으로 자르면 QVA 검출 및 장기 백테스트 표본이 부족해진다.
# env CHART_KEEP_ROWS로 운영 환경에서 오버라이드 가능.
MIN_ROWS = int(os.getenv("CHART_KEEP_ROWS", "1000"))

# 동시성 / 재시도 — KIS API rate limit (실전 ~초당 20회)을 넘지 않도록 보수적으로 둔다.
# 32 worker는 EGW00201/HTTP 429 silent fail이 빈번해 운영에서 1,000+ 종목 누락 사례가 있었다.
WORKERS = int(os.getenv("UPDATE_WORKERS", "8"))
PER_CALL_RETRIES = int(os.getenv("UPDATE_RETRIES", "3"))
RETRY_ROUNDS = int(os.getenv("UPDATE_RETRY_ROUNDS", "2"))  # 첫 패스 후 실패 종목 자동 재시도 횟수

# KIS API Config
KIS_APP_KEY = os.getenv("KIS_APP_KEY")
KIS_APP_SECRET = os.getenv("KIS_APP_SECRET")
KIS_BASE_URL = os.getenv("KIS_BASE_URL")

token_cache = {"accessToken": None, "expiresAt": 0}


# ─── Token Management ───
def _load_token_from_disk():
    """app.js / update-flow-daily.js와 공유하는 .kis-token.json에서 읽는다."""
    if not TOKEN_CACHE_FILE.exists():
        return None
    try:
        with open(TOKEN_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("accessToken") and data.get("expiresAt"):
            return data
    except Exception:
        return None
    return None


def _save_token_to_disk(token_data):
    try:
        with open(TOKEN_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(token_data, f)
    except Exception:
        pass


def get_access_token():
    """토큰 발급은 KIS에서 1분 1회 제한(EGW00133)이 있다. .kis-token.json 파일 캐시를
    app.js / update-flow-daily.js와 공유해 같은 분 안에 두 스크립트가 토큰을 새로
    발급해 403을 받는 일을 막는다."""
    global token_cache
    now_ms = datetime.now().timestamp() * 1000
    TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

    # 1) 메모리 캐시
    if (
        token_cache["accessToken"]
        and token_cache["expiresAt"] - now_ms > TOKEN_REFRESH_MARGIN_MS
    ):
        return token_cache["accessToken"]

    # 2) 파일 캐시 (다른 프로세스/스크립트가 발급해 둔 토큰 재사용)
    disk = _load_token_from_disk()
    if disk and disk["expiresAt"] - now_ms > TOKEN_REFRESH_MARGIN_MS:
        token_cache = {"accessToken": disk["accessToken"], "expiresAt": disk["expiresAt"]}
        return token_cache["accessToken"]

    # 3) 새로 발급
    url = f"{KIS_BASE_URL}/oauth2/tokenP"
    res = requests.post(
        url,
        json={
            "grant_type": "client_credentials",
            "appkey": KIS_APP_KEY,
            "appsecret": KIS_APP_SECRET,
        },
        timeout=10,
    )
    res.raise_for_status()

    data = res.json()
    expires_in = (data.get("expires_in", 3600)) * 1000
    now_ms = datetime.now().timestamp() * 1000

    token_cache = {"accessToken": data["access_token"], "expiresAt": now_ms + expires_in}
    _save_token_to_disk(token_cache)
    return token_cache["accessToken"]


# ─── KIS API ───
# rate-limit / 일시 오류로 판단해 retry할 KIS 메시지 코드.
# EGW00201: 초당 호출 한도 초과 / EGW00133: 1분당 토큰 발급 한도(여기선 거의 안 옴)
RETRYABLE_KIS_MSG_CODES = {"EGW00201", "EGW00133"}


def get_period_chart(access_token: str, stock_code: str, period: str = "D") -> List[Dict]:
    """
    KIS API로 차트 데이터 조회 (D: 일봉)

    HTTP 429/5xx와 KIS rate-limit msg_cd(EGW00201 등)는 지수 백오프로 PER_CALL_RETRIES만큼 재시도한다.
    그 외 KIS 오류(권한 없음, 종목 없음)는 즉시 raise.

    반환: [{"date": "YYYYMMDD", "open": int, "high": int, "low": int, "close": int, "volume": int}, ...]
    """
    url = f"{KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"

    last_err = None
    for attempt in range(PER_CALL_RETRIES):
        try:
            res = requests.get(
                url,
                headers={
                    "content-type": "application/json; charset=UTF-8",
                    "authorization": f"Bearer {access_token}",
                    "appkey": KIS_APP_KEY,
                    "appsecret": KIS_APP_SECRET,
                    "tr_id": "FHKST01010400",
                },
                params={
                    "fid_cond_mrkt_div_code": "J",
                    "fid_input_iscd": stock_code,
                    "fid_org_adj_prc": "0",
                    "fid_period_div_code": period,
                },
                timeout=10,
            )

            # HTTP 429 / 5xx → 백오프 후 재시도
            if res.status_code == 429 or 500 <= res.status_code < 600:
                last_err = f"HTTP {res.status_code}"
                time.sleep(min(8.0, 0.5 * (2 ** attempt)) + random.uniform(0, 0.3))
                continue
            res.raise_for_status()

            data = res.json()
            if data.get("rt_cd") != "0":
                msg_cd = (data.get("msg_cd") or "").strip()
                if msg_cd in RETRYABLE_KIS_MSG_CODES:
                    last_err = f"{msg_cd} / {data.get('msg1')}"
                    time.sleep(min(8.0, 0.5 * (2 ** attempt)) + random.uniform(0, 0.3))
                    continue
                # 그 외 에러는 종목별 영구 실패 — 재시도해도 의미 없음
                raise Exception(f"KIS 차트 API 오류: {msg_cd} / {data.get('msg1')}")

            rows = []
            for item in data.get("output", []):
                date_str = str(item.get("stck_bsop_date", "")).strip()
                if not date_str or len(date_str) != 8:
                    continue

                close = int(item.get("stck_clpr", 0))
                volume = int(item.get("acml_vol", 0))
                # valueApprox = 종가 × 거래량 (간이 거래대금).
                # 신규 row 생성 시 항상 함께 채워서 merge 단계의 dict.update가 stale valueApprox(=0)를
                # 새 값으로 덮어쓰도록 보장. (이전엔 신규 분기에서만 set해 갱신 분기에서 0 박힘 버그 있었음.)
                rows.append(
                    {
                        "date": date_str,
                        "open": int(item.get("stck_oprc", 0)),
                        "high": int(item.get("stck_hgpr", 0)),
                        "low": int(item.get("stck_lwpr", 0)),
                        "close": close,
                        "volume": volume,
                        "valueApprox": close * volume,
                    }
                )

            return rows
        except requests.exceptions.RequestException as e:
            last_err = str(e)
            if attempt < PER_CALL_RETRIES - 1:
                time.sleep(min(8.0, 0.5 * (2 ** attempt)) + random.uniform(0, 0.3))
                continue
            raise

    raise Exception(f"PER_CALL_RETRIES 소진: {last_err}")


# ─── File I/O ───
def load_stocks_list() -> List[str]:
    if not STOCKS_LIST_PATH.exists():
        raise FileNotFoundError(f"{STOCKS_LIST_PATH} not found")

    with open(STOCKS_LIST_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    codes = [s["code"] for s in data.get("stocks", [])]
    print(f"[Info] 로드한 종목 수: {len(codes)}")
    return codes


def load_cached_chart(code: str) -> Dict[str, Any]:
    cache_file = CHART_LONG_DIR / f"{code}.json"
    if cache_file.exists():
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def save_chart_data(code: str, data: Dict[str, Any]) -> bool:
    try:
        CHART_LONG_DIR.mkdir(parents=True, exist_ok=True)
        cache_file = CHART_LONG_DIR / f"{code}.json"
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
        return True
    except Exception:
        return False


def merge_chart_data(cached: Dict[str, Any], new_rows: List[Dict]) -> Dict[str, Any]:
    """기존 캐시와 새 데이터 merge"""
    if not cached:
        cached = {"meta": {}, "rows": []}

    existing_rows = cached.get("rows", [])
    existing_dates = {r["date"]: r for r in existing_rows}

    # 새 데이터 추가/업데이트
    # new_row는 get_period_chart에서 valueApprox까지 채워서 옴 → 갱신/신규 둘 다 valueApprox 정상 반영.
    for new_row in new_rows:
        date = new_row["date"]
        if date in existing_dates:
            existing_dates[date].update(new_row)
        else:
            existing_dates[date] = new_row

    # 정렬 및 중복 제거
    sorted_rows = sorted(existing_dates.values(), key=lambda r: r["date"])
    seen = set()
    unique_rows = []
    for r in sorted_rows:
        if r["date"] not in seen:
            unique_rows.append(r)
            seen.add(r["date"])

    # 최소 행 수 유지
    if len(unique_rows) > MIN_ROWS:
        unique_rows = unique_rows[-MIN_ROWS:]

    cached["rows"] = unique_rows
    return cached


# ─── Worker ───
def process_stock(code: str, access_token: str):
    """종목별 처리 (병렬 실행용)"""
    try:
        # KIS API 조회
        new_rows = get_period_chart(access_token, code)
        if not new_rows:
            return ("skip", code)

        # 기존 캐시 로드
        cached = load_cached_chart(code)

        # Merge
        updated = merge_chart_data(cached, new_rows)

        # 저장
        if save_chart_data(code, updated):
            return ("success", code)
        else:
            return ("fail", code)
    except Exception:
        return ("fail", code)


def _run_pass(codes, access_token, workers, label):
    """한 번의 패스를 실행하고 (fail로 분류된 종목 list, success/fail/skip 카운트)를 반환한다.
    'skip' = KIS API에 데이터 없음(해제/거래정지/우선주 등) → retry 의미 없음.
    'fail' = 네트워크/rate-limit 등 일시 오류 → retry 대상."""
    success = 0
    failed_codes = []
    skipped = 0
    completed = 0
    total = len(codes)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(process_stock, code, access_token): code for code in codes}
        for future in as_completed(futures):
            completed += 1
            status, code = future.result()
            if status == "success":
                success += 1
            elif status == "fail":
                failed_codes.append(code)
            elif status == "skip":
                skipped += 1

            if completed % 50 == 0 or completed == 1:
                pct = (completed * 100) // total
                print(f"[{label}] {completed}/{total} ({pct}%)")

    return failed_codes, success, len(failed_codes), skipped


# ─── Main ───
def update_daily():
    codes = load_stocks_list()

    # --limit 옵션 처리
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    if limit:
        codes = codes[:limit]
        print(f"[테스트 모드] {limit}개 종목만 처리")

    print(f"\n[시작] KIS API 차트 데이터 갱신 (workers={WORKERS}, retries={PER_CALL_RETRIES}, retry_rounds={RETRY_ROUNDS})")
    print(f"대상: {len(codes)}개 종목\n")

    # 토큰 획득
    try:
        access_token = get_access_token()
    except Exception as e:
        print(f"[ERROR] 토큰 획득 실패: {e}")
        sys.exit(1)

    # 1차 패스
    failed_codes, success, failed, skipped = _run_pass(
        codes, access_token, WORKERS, "진행"
    )
    total_success = success
    total_skipped = skipped

    # 자동 재시도 round — 실패 종목만 더 적은 동시성으로 다시 호출
    for r in range(1, RETRY_ROUNDS + 1):
        if not failed_codes:
            break
        retry_workers = max(2, WORKERS // (2 ** r))
        print(f"\n[Retry {r}/{RETRY_ROUNDS}] {len(failed_codes)}개 재시도 (workers={retry_workers})")
        # rate-limit 회복 시간을 짧게 둔다
        time.sleep(2.0)
        # retry 패스에서 새로운 'skip'은 진짜 데이터 없음 — total_skipped로 누적
        retry_failed, retry_success, _, retry_skip = _run_pass(
            failed_codes, access_token, retry_workers, f"Retry {r}"
        )
        total_success += retry_success
        total_skipped += retry_skip
        failed_codes = retry_failed

    # 완료 보고
    print(f"\n[완료]")
    print(f"  성공: {total_success}개")
    print(f"  실패(영구): {len(failed_codes)}개")
    print(f"  스킵(데이터 없음): {total_skipped}개")
    if failed_codes:
        sample = ", ".join(failed_codes[:10])
        print(f"  최종 실패 샘플(앞 10): {sample}")
    print(f"\n업데이트 시각: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")


if __name__ == "__main__":
    try:
        update_daily()
    except KeyboardInterrupt:
        print("\n[취소] 사용자가 중단했습니다")
        sys.exit(1)
    except Exception as e:
        print(f"\n[에러] {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)
