#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
       
"""

import json
import os
import sys
import time
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Any
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from dotenv import load_dotenv

#  Config 
ROOT = Path(__file__).parent
load_dotenv(ROOT / '.env')
STOCKS_LIST_PATH = ROOT / "cache" / "naver-stocks-list.json"
CHART_LONG_DIR = ROOT / "cache" / "stock-charts-long"

KIS_APP_KEY = os.getenv("KIS_APP_KEY")
KIS_APP_SECRET = os.getenv("KIS_APP_SECRET")
KIS_BASE_URL = os.getenv("KIS_BASE_URL")

token_cache = {"accessToken": None, "expiresAt": 0}

#    
class Timer:
    def __init__(self, name: str):
        self.name = name
        self.start = None
        self.elapsed = 0

    def __enter__(self):
        self.start = time.time()
        return self

    def __exit__(self, *args):
        self.elapsed = time.time() - self.start
        print(f"[{self.elapsed:.3f}s] {self.name}")

#  Token 
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
    try:
        with Timer(" "):
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
    except Exception as e:
        print(f"   : {e}")
        return None

    data = res.json()
    expires_in = (data.get("expires_in", 3600)) * 1000
    now_ms = datetime.now().timestamp() * 1000

    token_cache = {"accessToken": data["access_token"], "expiresAt": now_ms + expires_in}
    return token_cache["accessToken"]


#  KIS API 
def get_period_chart(access_token: str, stock_code: str, period: str = "D") -> List[Dict]:
    """KIS API """
    url = f"{KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"

    today = datetime.now()
    end_date = today.strftime("%Y%m%d")
    start_date = (today - timedelta(days=60)).strftime("%Y%m%d")

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
        res.raise_for_status()
    except requests.exceptions.Timeout:
        print(f"    {stock_code}: API timeout")
        return []
    except Exception as e:
        print(f"   {stock_code}: {type(e).__name__}")
        return []

    data = res.json()
    if data.get("rt_cd") != "0":
        print(f"    {stock_code}: {data.get('msg_cd')}")
        return []

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


def load_cached_chart(code: str) -> Dict[str, Any]:
    """ """
    cache_file = CHART_LONG_DIR / f"{code}.json"
    if cache_file.exists():
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def save_chart_data(code: str, data: Dict[str, Any]) -> bool:
    """ """
    try:
        CHART_LONG_DIR.mkdir(parents=True, exist_ok=True)
        cache_file = CHART_LONG_DIR / f"{code}.json"
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
        return True
    except Exception:
        return False


def merge_chart_data(cached: Dict[str, Any], new_rows: List[Dict]) -> Dict[str, Any]:
    """merge"""
    if not cached:
        cached = {"meta": {}, "rows": []}

    existing_rows = cached.get("rows", [])
    existing_dates = {r["date"]: r for r in existing_rows}

    for new_row in new_rows:
        date = new_row["date"]
        if date in existing_dates:
            existing_dates[date].update(new_row)
        else:
            new_row["valueApprox"] = new_row["close"] * new_row["volume"]
            existing_dates[date] = new_row

    sorted_rows = sorted(existing_dates.values(), key=lambda r: r["date"])
    seen = set()
    unique_rows = []
    for r in sorted_rows:
        if r["date"] not in seen:
            unique_rows.append(r)
            seen.add(r["date"])

    MIN_ROWS = 120
    if len(unique_rows) > MIN_ROWS:
        unique_rows = unique_rows[-MIN_ROWS:]

    cached["rows"] = unique_rows
    return cached


#  Worker ( ) 
def process_stock(code: str, access_token: str, worker_id: int):
    """ """
    try:
        with Timer(f"W{worker_id} {code}"):
            # API 
            with Timer(f"  {code} API"):
                new_rows = get_period_chart(access_token, code)

            if not new_rows:
                return ("skip", code)

            #  
            with Timer(f"  {code} Load"):
                cached = load_cached_chart(code)

            # Merge
            with Timer(f"  {code} Merge"):
                updated = merge_chart_data(cached, new_rows)

            # 
            with Timer(f"  {code} Save"):
                if save_chart_data(code, updated):
                    return ("success", code)
                else:
                    return ("fail", code)
    except Exception as e:
        print(f" {code}: {e}")
        return ("fail", code)


#  Main 
def diagnose():
    print("\n" + "="*60)
    print("     ")
    print("="*60)

    #  
    with Timer("  "):
        with open(STOCKS_LIST_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        codes = [s["code"] for s in data.get("stocks", [])]

    print(f"  : {len(codes)}")

    # : 5 
    test_codes = codes[:5]
    print(f"\n : {len(test_codes)} \n")

    # 
    print("  ...")
    with Timer(""):
        access_token = get_access_token()

    if not access_token:
        print("   ")
        return

    #  
    print(f"\n 32    ...\n")

    start = time.time()
    worker_id_pool = iter(range(32))

    with ThreadPoolExecutor(max_workers=32) as executor:
        futures = {
            executor.submit(process_stock, code, access_token, next(worker_id_pool)): code
            for code in test_codes
        }

        for i, future in enumerate(as_completed(futures), 1):
            code = futures[future]
            try:
                status, _ = future.result()
                print(f"  [{i}/{len(test_codes)}] {status.upper():8} {code}")
            except Exception as e:
                print(f"  [{i}/{len(test_codes)}] ERROR    {code}: {e}")

    elapsed = time.time() - start
    print(f"\n   : {elapsed:.1f}")
    print(f"  : {len(test_codes)/elapsed:.1f}/")
    print("="*60 + "\n")


if __name__ == "__main__":
    diagnose()
