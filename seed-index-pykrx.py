# KOSPI/KOSDAQ 인덱스 일봉 fetch (FinanceDataReader)
# pykrx 의 cp949 인코딩 + KRX endpoint 빈 응답 두 버그 우회 — fdr 로 대체
# 실행: python seed-index-pykrx.py [start=20230101]
import json
import os
import sys
from datetime import datetime
import FinanceDataReader as fdr

ROOT = os.path.dirname(os.path.abspath(__file__))
START = sys.argv[1] if len(sys.argv) > 1 else "20230101"
START_FMT = f"{START[:4]}-{START[4:6]}-{START[6:8]}"

INDICES = [
    ("kospi-daily.json",  "KS11"),    # KOSPI
    ("kosdaq-daily.json", "KQ11"),    # KOSDAQ
]

for fname, ticker in INDICES:
    print(f"fetching {ticker} from {START_FMT}")
    df = fdr.DataReader(ticker, START_FMT)
    rows = []
    for date_idx, row in df.iterrows():
        c = float(row["Close"]) if row["Close"] else 0
        if c == 0:
            continue
        rows.append({
            "date": date_idx.strftime("%Y%m%d"),
            "open": float(row["Open"]) if row["Open"] else 0,
            "high": float(row["High"]) if row["High"] else 0,
            "low": float(row["Low"]) if row["Low"] else 0,
            "close": c,
        })
    out_path = os.path.join(ROOT, "cache", fname)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"fetchedAt": datetime.now().timestamp() * 1000, "rows": rows}, f)
    print(f"  -> {len(rows)} rows saved to {fname}")

print("done")
