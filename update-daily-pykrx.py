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
   - 최소 120일 보존
4. ThreadPoolExecutor로 병렬 처리 (8개 워커, 5-10배 성능 향상)

실행:
  python update-daily-pykrx.py [limit]
  python update-daily-pykrx.py 2  # 테스트: 2개 종목만
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Any
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

# ─── Config ───
ROOT = Path(__file__).parent
STOCKS_LIST_PATH = ROOT / "cache" / "naver-stocks-list.json"
CHART_LONG_DIR = ROOT / "cache" / "stock-charts-long"
MIN_ROWS = 120

# KIS API Config
KIS_APP_KEY = os.getenv("KIS_APP_KEY")
KIS_APP_SECRET = os.getenv("KIS_APP_SECRET")
KIS_BASE_URL = os.getenv("KIS_BASE_URL")

token_cache = {"accessToken": None, "expiresAt": 0}


# ─── Token Management ───
def get_access_token():
    global token_cache
    now_ms = datetime.now().timestamp() * 1000
    TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

    if (
        token_cache["accessToken"]
        and token_cache["expiresAt"] - now_ms > TOKEN_REFRESH_MARGIN_MS
    ):
        return token_cache["accessToken"]

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
    return token_cache["accessToken"]


# ─── KIS API ───
def get_period_chart(access_token: str, stock_code: str, period: str = "D") -> List[Dict]:
    """
    KIS API로 차트 데이터 조회 (D: 일봉)

    반환: [{"date": "YYYYMMDD", "open": int, "high": int, "low": int, "close": int, "volume": int}, ...]
    """
    url = f"{KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"

    today = datetime.now()
    end_date = today.strftime("%Y%m%d")
    start_date = (today - timedelta(days=60)).strftime("%Y%m%d")  # 60일 조회

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
    res.raise_for_status()

    data = res.json()
    if data.get("rt_cd") != "0":
        raise Exception(f"KIS 차트 API 오류: {data.get('msg_cd')} / {data.get('msg1')}")

    rows = []
    for item in data.get("output", []):
        date_str = str(item.get("stck_bsop_date", "")).strip()
        if not date_str or len(date_str) != 8:
            continue

        rows.append(
            {
                "date": date_str,
                "open": int(item.get("stck_oprc", 0)),
                "high": int(item.get("stck_hgpr", 0)),
                "low": int(item.get("stck_lwpr", 0)),
                "close": int(item.get("stck_clpr", 0)),
                "volume": int(item.get("acml_vol", 0)),
            }
        )

    return rows


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
    for new_row in new_rows:
        date = new_row["date"]
        if date in existing_dates:
            existing_dates[date].update(new_row)
        else:
            new_row["valueApprox"] = new_row["close"] * new_row["volume"]
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


# ─── Main ───
def update_daily():
    codes = load_stocks_list()

    # --limit 옵션 처리
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    if limit:
        codes = codes[:limit]
        print(f"[테스트 모드] {limit}개 종목만 처리")

    print(f"\n[시작] KIS API 차트 데이터 갱신 (병렬처리, 8개 스레드)")
    print(f"대상: {len(codes)}개 종목\n")

    # 토큰 획득
    try:
        access_token = get_access_token()
    except Exception as e:
        print(f"[ERROR] 토큰 획득 실패: {e}")
        sys.exit(1)

    success = 0
    failed = 0
    skipped = 0
    completed = 0

    # 병렬 처리
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(process_stock, code, access_token): code for code in codes
        }

        for future in futures:
            completed += 1
            status, code = future.result()

            if status == "success":
                success += 1
            elif status == "fail":
                failed += 1
            elif status == "skip":
                skipped += 1

            # 진행률 표시
            if completed % 50 == 0 or completed == 1:
                pct = (completed * 100) // len(codes)
                print(f"[진행] {completed}/{len(codes)} ({pct}%)")

    # 완료 보고
    print(f"\n[완료]")
    print(f"  성공: {success}개")
    print(f"  실패: {failed}개")
    print(f"  스킵(데이터 없음): {skipped}개")
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
