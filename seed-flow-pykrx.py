#!/usr/bin/env python3
"""
flow-history 시드 — pykrx 인증 경로 (KRX 데이터 시스템).

seed-flow-naver.js와 동일한 출력 schema. 단지 데이터 출처가 KRX 공식 통계 화면.

스키마 매핑:
  Naver(scraper): {date, close, volume, instNetVol, foreignNetVol, instNetValue, foreignNetValue, foreignRate}
  → close/volume: cache/stock-charts-long/{code}.json 에서 join
  → instNetVol = pykrx volume_by_date '기관합계'
  → foreignNetVol = pykrx volume_by_date '외국인합계'
  → instNetValue = pykrx value_by_date '기관합계' (실거래대금 합산)
  → foreignNetValue = pykrx value_by_date '외국인합계'
  → foreignRate = null (pattern-screener/vpr/백테스트 미사용, UI 단건만)

전제: .env 의 KRX_ID, KRX_PW 가 유효해야 함.

실행:
    python seed-flow-pykrx.py [start=20230101] [end=오늘] [workers=4] [limit=0]
"""
import os
import sys
import json
import time
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

ROOT = Path(__file__).parent

# .env 로드 (pykrx import 전에)
env_path = ROOT / ".env"
if env_path.exists():
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v)

from pykrx import stock  # noqa: E402

CHART_DIR = ROOT / "cache" / "stock-charts-long"
FLOW_DIR = ROOT / "cache" / "flow-history"
STOCKS_LIST = ROOT / "cache" / "naver-stocks-list.json"
FLOW_DIR.mkdir(parents=True, exist_ok=True)


def parse_int(v, default):
    try:
        return int(v)
    except Exception:
        return default


START = sys.argv[1] if len(sys.argv) > 1 else "20230101"
END = sys.argv[2] if len(sys.argv) > 2 else datetime.now().strftime("%Y%m%d")
WORKERS = parse_int(sys.argv[3] if len(sys.argv) > 3 else "4", 4)
LIMIT = parse_int(sys.argv[4] if len(sys.argv) > 4 else "0", 0)


def load_universe():
    with open(STOCKS_LIST, encoding="utf-8") as f:
        data = json.load(f)
    stocks = data.get("stocks", data)
    return {s["code"] for s in stocks if not s.get("isSpecial") and not s.get("isEtf") and s.get("code")}


def load_chart_dict(code):
    p = CHART_DIR / f"{code}.json"
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        out = {}
        for r in d.get("rows", []):
            date = r.get("date")
            if date:
                out[date] = (r.get("close") or 0, r.get("volume") or 0)
        return out
    except Exception:
        return {}


lock = Lock()
stats = {"done": 0, "ok": 0, "fail": 0, "no_chart": 0, "empty": 0}


def process_code(code):
    try:
        chart = load_chart_dict(code)
        if not chart:
            with lock:
                stats["done"] += 1
                stats["no_chart"] += 1
            return
        df_value = stock.get_market_trading_value_by_date(START, END, code)
        df_volume = stock.get_market_trading_volume_by_date(START, END, code)
        if df_value is None or len(df_value) == 0:
            with lock:
                stats["done"] += 1
                stats["empty"] += 1
            return

        rows = []
        for ts in df_value.index:
            date_str = ts.strftime("%Y%m%d")
            close, volume = chart.get(date_str, (0, 0))
            try:
                inst_val = int(df_value.at[ts, "기관합계"])
                for_val = int(df_value.at[ts, "외국인합계"])
            except Exception:
                inst_val = for_val = 0
            try:
                inst_vol = int(df_volume.at[ts, "기관합계"]) if ts in df_volume.index else 0
                for_vol = int(df_volume.at[ts, "외국인합계"]) if ts in df_volume.index else 0
            except Exception:
                inst_vol = for_vol = 0
            rows.append({
                "date": date_str,
                "close": close,
                "volume": volume,
                "instNetVol": inst_vol,
                "foreignNetVol": for_vol,
                "instNetValue": inst_val,
                "foreignNetValue": for_val,
                "foreignRate": None,
            })

        rows.sort(key=lambda r: r["date"])
        out = {"code": code, "rows": rows}
        with open(FLOW_DIR / f"{code}.json", "w", encoding="utf-8") as wf:
            json.dump(out, wf, separators=(",", ":"), ensure_ascii=False)

        with lock:
            stats["done"] += 1
            if rows:
                stats["ok"] += 1
            else:
                stats["empty"] += 1
    except Exception as e:
        with lock:
            stats["done"] += 1
            stats["fail"] += 1
        if stats["fail"] <= 5:
            print(f"  FAIL {code}: {e}")


def main():
    universe = load_universe()
    codes = sorted([c for c in universe if (CHART_DIR / f"{c}.json").exists()])
    if LIMIT > 0:
        codes = codes[:LIMIT]
    total = len(codes)
    print(f"[seed-flow-pykrx] range={START}~{END} workers={WORKERS} 종목={total}")

    # warmup KRX auth (single login)
    print("KRX 워밍업...")
    _ = stock.get_market_trading_value_by_date(START, START, "005930")
    print("워밍업 완료\n")

    t0 = time.time()
    last_log = 0.0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = [ex.submit(process_code, c) for c in codes]
        for _ in as_completed(futures):
            now = time.time()
            with lock:
                done = stats["done"]
            if now - last_log > 5.0 or done == total or done % 50 == 0:
                with lock:
                    snap = dict(stats)
                rate = done / max(0.001, now - t0)
                eta = (total - done) / max(0.001, rate)
                print(
                    f"  [{done}/{total} {done/total*100:5.1f}%] "
                    f"ok={snap['ok']} fail={snap['fail']} no_chart={snap['no_chart']} empty={snap['empty']} "
                    f"| {rate:.1f}/s ETA {eta/60:.1f}분"
                )
                last_log = now

    elapsed = time.time() - t0
    print(f"\n=== 완료 ({elapsed/60:.1f}분) ===")
    print(f"ok={stats['ok']} fail={stats['fail']} no_chart={stats['no_chart']} empty={stats['empty']} 총={total}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[중단]")
        sys.exit(1)
