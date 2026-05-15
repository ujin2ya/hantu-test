#!/usr/bin/env python3
"""
장기 차트 시드 (merge-aware) — pykrx 기반

목적: cache/stock-charts-long/{code}.json의 일봉 history를 늘려서 QVA/VVI/VPR 백테스트 표본을 확보한다.

기존 seed-historical-pykrx.py와의 차이:
- force/resume 대신 항상 merge한다 (새 데이터 + 기존 데이터, date 기준 중복 제거 후 정렬)
- 길이 truncate 없음 (update-daily-pykrx.py의 MIN_ROWS=120 cap 미적용)
- ThreadPoolExecutor로 병렬화

실행:
    python seed-longterm-merge-pykrx.py [start=20240101] [end=YYYYMMDD] [workers=4] [limit=0] [min_market_cap=0] [min_trading_value=0]

기본값:
    start=20240101, end=오늘, workers=4, limit=0(전체), min_market_cap=0, min_trading_value=0
    universe = naver-stocks-list.json에서 isSpecial/isEtf 제외한 전체 종목 (≈4000개)
"""
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

from pykrx import stock

ROOT = Path(__file__).parent
STOCKS_LIST_PATH = ROOT / "cache" / "naver-stocks-list.json"
OUT_DIR = ROOT / "cache" / "stock-charts-long"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def parse_int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


START_DATE = sys.argv[1] if len(sys.argv) > 1 else "20240101"
END_DATE = sys.argv[2] if len(sys.argv) > 2 else datetime.now().strftime("%Y%m%d")
WORKERS = parse_int(sys.argv[3], 4) if len(sys.argv) > 3 else 4
LIMIT = parse_int(sys.argv[4], 0) if len(sys.argv) > 4 else 0
MIN_MARKET_CAP = parse_int(sys.argv[5], 0) if len(sys.argv) > 5 else 0
MIN_TRADING_VALUE = parse_int(sys.argv[6], 0) if len(sys.argv) > 6 else 0


def load_universe():
    with open(STOCKS_LIST_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    stocks = data.get("stocks", data)
    universe = []
    for s in stocks:
        if s.get("isSpecial") or s.get("isEtf"):
            continue
        if (s.get("marketValue") or 0) < MIN_MARKET_CAP:
            continue
        if (s.get("tradingValue") or 0) < MIN_TRADING_VALUE:
            continue
        universe.append(s)
    return universe


def load_existing(code):
    path = OUT_DIR / f"{code}.json"
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def merge_rows(existing_rows, new_rows):
    by_date = {}
    for r in existing_rows:
        d = r.get("date")
        if d:
            by_date[d] = r
    for r in new_rows:
        d = r.get("date")
        if d:
            by_date[d] = r  # 새 데이터로 덮어씀 (가격 보정 등 반영)
    merged = sorted(by_date.values(), key=lambda r: r["date"])
    return merged


def fetch_pykrx(code, start, end):
    df = stock.get_market_ohlcv(start, end, code)
    if df is None or len(df) == 0:
        return []
    rows = []
    for date_idx, row in df.iterrows():
        try:
            o = int(row.iloc[0]) if row.iloc[0] else 0
            h = int(row.iloc[1]) if row.iloc[1] else 0
            l = int(row.iloc[2]) if row.iloc[2] else 0
            c = int(row.iloc[3]) if row.iloc[3] else 0
            v = int(row.iloc[4]) if row.iloc[4] else 0
        except Exception:
            continue
        if c == 0:
            continue
        rows.append({
            "date": date_idx.strftime("%Y%m%d"),
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": v,
            "valueApprox": int(((o + h + l + c) / 4) * v),
        })
    return rows


progress_lock = Lock()
counter = {"done": 0, "ok": 0, "fail": 0, "no_data": 0, "merged_only": 0}


def process_one(meta, total):
    code = meta["code"]
    name = meta.get("name", "")
    try:
        new_rows = fetch_pykrx(code, START_DATE, END_DATE)
    except Exception as e:
        with progress_lock:
            counter["done"] += 1
            counter["fail"] += 1
        return ("fail", code, name, str(e), 0, 0)

    existing = load_existing(code) or {"code": code, "name": name, "rows": []}
    existing_rows = existing.get("rows", [])

    if not new_rows and not existing_rows:
        with progress_lock:
            counter["done"] += 1
            counter["no_data"] += 1
        return ("no_data", code, name, None, 0, 0)

    merged = merge_rows(existing_rows, new_rows)
    out = {
        "code": code,
        "name": existing.get("name") or name,
        "rows": merged,
    }
    if "market" in existing:
        out["market"] = existing["market"]

    try:
        path = OUT_DIR / f"{code}.json"
        with open(path, "w", encoding="utf-8") as wf:
            json.dump(out, wf, separators=(",", ":"), ensure_ascii=False)
    except Exception as e:
        with progress_lock:
            counter["done"] += 1
            counter["fail"] += 1
        return ("fail", code, name, f"save error: {e}", len(existing_rows), len(merged))

    with progress_lock:
        counter["done"] += 1
        if not new_rows:
            counter["merged_only"] += 1
        else:
            counter["ok"] += 1
    return ("ok", code, name, None, len(existing_rows), len(merged))


def main():
    universe = load_universe()
    if LIMIT > 0:
        universe = universe[:LIMIT]
    total = len(universe)

    print(f"[seed-longterm-merge-pykrx]")
    print(f"  start={START_DATE} end={END_DATE} workers={WORKERS} limit={LIMIT or 'all'}")
    print(f"  min_market_cap={MIN_MARKET_CAP/1e8:.0f}억 min_trading_value={MIN_TRADING_VALUE/1e8:.0f}억")
    print(f"  universe size: {total}")
    print()

    t0 = time.time()
    last_log = 0.0

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(process_one, m, total): m for m in universe}
        for fut in as_completed(futures):
            status, code, name, err, before, after = fut.result()
            now = time.time()
            with progress_lock:
                done = counter["done"]
            if now - last_log > 5.0 or done == total or done % 100 == 0:
                elapsed = now - t0
                rate = done / max(1.0, elapsed)
                eta = (total - done) / max(0.001, rate)
                with progress_lock:
                    snap = dict(counter)
                print(
                    f"  [{done}/{total} {done/total*100:5.1f}%] "
                    f"ok={snap['ok']} merged_only={snap['merged_only']} fail={snap['fail']} no_data={snap['no_data']} "
                    f"| {rate:.1f}/s ETA {eta/60:.1f}m"
                )
                last_log = now
            if err and status == "fail":
                print(f"    FAIL {code} {name}: {err}")

    elapsed = time.time() - t0
    print()
    print(f"[done in {elapsed/60:.1f}m]")
    print(f"  ok={counter['ok']} merged_only={counter['merged_only']} fail={counter['fail']} no_data={counter['no_data']}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[중단됨]")
        sys.exit(1)
