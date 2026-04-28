# pykrx 일봉 250일 + reseed (Phase 3 — 표본 확대)
#
# 입력: cache/naver-stocks-list.json
# 출력: cache/stock-charts-long/<code>.json (Naver 캐시 형식)
#
# 한국장 universe 만 시드:
#   - isSpecial=true 제외 (우선주)
#   - isEtf=true 제외
#   - marketValue >= 1,000억 (현재 시점 기준)
#   - tradingValue >= 50억 (현재 시점 기준)
#   → 약 1500 종목 추정
#
# 실행:
#   python seed-historical-pykrx.py [start_date=20250101] [resume|force] [min_market_cap=100_000_000_000]
# 예:
#   python seed-historical-pykrx.py 20230101 resume 50_000_000_000   # 500억+ resume 모드

import json
import os
import sys
import time
from datetime import datetime, timedelta
from pykrx import stock

ROOT = os.path.dirname(os.path.abspath(__file__))
STOCKS_LIST_PATH = os.path.join(ROOT, "cache", "naver-stocks-list.json")
OUT_DIR = os.path.join(ROOT, "cache", "stock-charts-long")
os.makedirs(OUT_DIR, exist_ok=True)

# 인자
START_DATE = sys.argv[1] if len(sys.argv) > 1 else "20250101"
END_DATE = datetime.now().strftime("%Y%m%d")
RESUME = sys.argv[2] != "force" if len(sys.argv) > 2 else True

# 시총 필터 — 3번째 인자로 변경 가능
MIN_MARKET_CAP = int(sys.argv[3]) if len(sys.argv) > 3 else 100_000_000_000
MIN_TRADING_VALUE = 5_000_000_000          # 50억

print(f"start={START_DATE}, end={END_DATE}")
print(f"universe: 시총≥{MIN_MARKET_CAP / 1e8}억, 거래대금≥{MIN_TRADING_VALUE / 1e8}억")

with open(STOCKS_LIST_PATH, "r", encoding="utf-8") as f:
    data = json.load(f)
    stocks = data.get("stocks", data)

# universe 필터
universe = []
for s in stocks:
    if s.get("isSpecial") or s.get("isEtf"):
        continue
    if (s.get("marketValue") or 0) < MIN_MARKET_CAP:
        continue
    if (s.get("tradingValue") or 0) < MIN_TRADING_VALUE:
        continue
    universe.append(s)

print(f"총 {len(stocks)} 종목 → universe {len(universe)} 종목")

success = 0
fail = 0
cached = 0
t0 = time.time()
last_log = 0.0

for i, meta in enumerate(universe):
    code = meta["code"]
    name = meta.get("name", "")
    cache_path = os.path.join(OUT_DIR, f"{code}.json")

    if RESUME and os.path.exists(cache_path):
        cached += 1
        if time.time() - last_log > 5.0 or i % 100 == 0:
            elapsed = int(time.time() - t0)
            eta = (len(universe) - i - 1) * (elapsed / max(1, i + 1)) / 60
            print(f"[{i+1}/{len(universe)} {(i+1)/len(universe)*100:.1f}%] {code} {name} → cached | elapsed {elapsed}s, ETA {eta:.1f}분")
            last_log = time.time()
        continue

    try:
        df = stock.get_market_ohlcv(START_DATE, END_DATE, code)
        if df is None or len(df) == 0:
            fail += 1
            continue

        rows = []
        for date_idx, row in df.iterrows():
            o = int(row.iloc[0]) if row.iloc[0] else 0  # 시가
            h = int(row.iloc[1]) if row.iloc[1] else 0  # 고가
            l = int(row.iloc[2]) if row.iloc[2] else 0  # 저가
            c = int(row.iloc[3]) if row.iloc[3] else 0  # 종가
            v = int(row.iloc[4]) if row.iloc[4] else 0  # 거래량
            if c == 0:
                continue
            rows.append({
                "date": date_idx.strftime("%Y%m%d"),
                "open": o, "high": h, "low": l, "close": c,
                "volume": v,
                "valueApprox": int(((o + h + l + c) / 4) * v),
            })

        out = { "code": code, "name": name, "rows": rows }
        with open(cache_path, "w", encoding="utf-8") as wf:
            json.dump(out, wf)

        success += 1
        if time.time() - last_log > 3.0 or i % 50 == 0 or i == len(universe) - 1:
            elapsed = int(time.time() - t0)
            eta = (len(universe) - i - 1) * (elapsed / max(1, i + 1)) / 60
            print(f"[{i+1}/{len(universe)} {(i+1)/len(universe)*100:.1f}%] {code} {name} → ok ({len(rows)}d) | elapsed {elapsed}s, ETA {eta:.1f}분")
            last_log = time.time()

        time.sleep(0.15)  # KRX rate limit 회피

    except Exception as e:
        fail += 1
        print(f"  [{i+1}] {code} {name} → ERROR: {e}")

elapsed = int(time.time() - t0)
print(f"\n=== 완료 ({elapsed}초) ===")
print(f"success: {success}, fail: {fail}, cached: {cached}, total: {len(universe)}")
