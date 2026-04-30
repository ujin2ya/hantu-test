#!/usr/bin/env python3
"""
Daily chart update — pykrx 기반 최근 5거래일 갱신

대상: naver-stocks-list.json의 전체 종목 (4,260개)
소스: pykrx (KRX 공식 데이터)
출력: cache/stock-charts-long/{code}.json

동작:
1. naver-stocks-list.json에서 종목 코드 읽기
2. 각 종목별로 pykrx로 최근 5거래일 조회
3. stock-charts-long/{code}.json과 merge
   - 같은 date: replace
   - 새 date: append
   - 정렬, 중복 제거
   - 최소 120일 보존
4. 진행률 표시 (매 50개마다)

실행:
  python update-daily-pykrx.py
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Any

import pandas as pd
from pykrx import stock

# ─── Config ───
ROOT = Path(__file__).parent
STOCKS_LIST_PATH = ROOT / "cache" / "naver-stocks-list.json"
CHART_LONG_DIR = ROOT / "cache" / "stock-charts-long"
MIN_ROWS = 120  # 최소 보존 행 수

# ─── Helpers ───
def load_stocks_list() -> List[str]:
    """naver-stocks-list.json에서 종목 코드 목록 읽기"""
    if not STOCKS_LIST_PATH.exists():
        print(f"Error: {STOCKS_LIST_PATH} not found")
        sys.exit(1)
    with open(STOCKS_LIST_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    codes = [s["code"] for s in data.get("stocks", [])]
    print(f"[Info] 로드한 종목 수: {len(codes)}")
    return codes


def fetch_pykrx_data(code: str, days: int = 5) -> pd.DataFrame:
    """
    pykrx로 최근 N거래일 데이터 조회

    반환: DataFrame { Date, Open, High, Low, Close, Volume }
    """
    try:
        # 최근 days + 여유(10일) 범위 조회
        end_date = datetime.now().strftime("%Y%m%d")
        start_date = (datetime.now() - timedelta(days=days + 10)).strftime("%Y%m%d")

        df = stock.get_market_ohlcv(start_date, end_date, code)

        if df is None or df.empty:
            return None

        # 역순 정렬 (가장 최근이 뒤에) → 재정렬해서 가장 최근 N개만
        df = df.sort_index(ascending=False).head(days)
        df = df.sort_index(ascending=True)  # 오름차순 정렬

        return df
    except Exception as e:
        # 조용히 실패 (해제된 종목, 거래 정지 등)
        return None


def load_cached_chart(code: str) -> Dict[str, Any]:
    """stock-charts-long/{code}.json 로드"""
    cache_file = CHART_LONG_DIR / f"{code}.json"
    if cache_file.exists():
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def merge_chart_data(cached: Dict[str, Any], new_df: pd.DataFrame) -> Dict[str, Any]:
    """
    기존 캐시와 새 데이터 merge

    규칙:
    - 같은 date: replace
    - 새 date: append
    - 정렬, 중복 제거
    - 최소 MIN_ROWS 유지
    """
    if cached is None:
        cached = {"meta": {}, "rows": []}

    existing_rows = cached.get("rows", [])
    existing_dates = {r["date"]: r for r in existing_rows}

    # 새 데이터 추가/업데이트
    for idx, row in new_df.iterrows():
        date_str = idx.strftime("%Y%m%d")
        new_row = {
            "date": date_str,
            "open": int(row["Open"]),
            "high": int(row["High"]),
            "low": int(row["Low"]),
            "close": int(row["Close"]),
            "volume": int(row["Volume"]),
            # valueApprox는 별도 계산 필요 (Naver에서 제공하는 거래대금)
            # 일단은 volume * close로 근사값 계산
        }

        if date_str in existing_dates:
            # 기존 필드(foreignRate 등) 보존하면서 OHLCV 업데이트
            existing_dates[date_str].update({
                "open": new_row["open"],
                "high": new_row["high"],
                "low": new_row["low"],
                "close": new_row["close"],
                "volume": new_row["volume"],
            })
        else:
            # 새 항목 추가
            new_row["valueApprox"] = new_row["close"] * new_row["volume"]  # 근사값
            existing_dates[date_str] = new_row

    # 정렬 (date 기준 오름차순)
    sorted_rows = sorted(existing_dates.values(), key=lambda r: r["date"])

    # 중복 제거 (date 기준)
    seen = set()
    unique_rows = []
    for r in sorted_rows:
        if r["date"] not in seen:
            unique_rows.append(r)
            seen.add(r["date"])

    # 최소 행 수 유지 (뒤에서 MIN_ROWS개만 유지)
    if len(unique_rows) > MIN_ROWS:
        # 최소 120일은 유지하되, 새 데이터는 모두 포함
        # 전략: 최근 MIN_ROWS + 새로 추가된 행들은 모두 유지
        unique_rows = unique_rows[-max(MIN_ROWS, len(unique_rows)):]

    cached["rows"] = unique_rows
    return cached


def save_chart_data(code: str, data: Dict[str, Any]) -> bool:
    """stock-charts-long/{code}.json 저장"""
    cache_file = CHART_LONG_DIR / f"{code}.json"
    try:
        CHART_LONG_DIR.mkdir(parents=True, exist_ok=True)
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
        return True
    except Exception as e:
        print(f"[Error] {code}: 저장 실패 - {e}")
        return False


def update_daily():
    """메인 업데이트 루프"""
    codes = load_stocks_list()

    success = 0
    failed = 0
    skipped = 0

    print(f"\n[시작] pykrx 최근 5거래일 갱신")
    print(f"대상: {len(codes)}개 종목\n")

    for i, code in enumerate(codes, 1):
        # 진행률 표시
        if i % 50 == 0 or i == 1:
            print(f"[진행] {i}/{len(codes)} ({i*100//len(codes)}%)")

        # pykrx 조회
        new_df = fetch_pykrx_data(code)
        if new_df is None or new_df.empty:
            skipped += 1
            continue

        # 기존 캐시 로드
        cached = load_cached_chart(code)

        # Merge
        updated = merge_chart_data(cached, new_df)

        # 저장
        if save_chart_data(code, updated):
            success += 1
        else:
            failed += 1

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
