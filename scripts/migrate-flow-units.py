#!/usr/bin/env python3
"""
flow-history 캐시 row 단위/필드명 통일 마이그레이션 (idempotent).

배경:
- seed-flow-naver(.js) 가 시드한 row: schema { date, close, volume, instNetVol, foreignNetVol, instNetValue, foreignNetValue, foreignRate }, value 단위 = 원
- 옛 update-flow-daily.js 가 만든 row: schema { date, closePrice, foreignNetQty, foreignNetValue, orgNetQty, orgNetValue, personalNetQty, foreignRate }, value 단위 = 백만원
- 새 hardened update-flow-daily.js (현재): 정상 schema + 원 단위 (×1,000,000 변환)

이 스크립트는 모든 flow-history/*.json 의 모든 row를 한 번 훑어:
1) 키 정규화: closePrice→close, foreignNetQty→foreignNetVol, orgNetQty→instNetVol,
   orgNetValue→instNetValue, personalNetQty 삭제
2) 단위 식별 후 백만원 → 원 변환 (×1,000,000)
   - row의 |value| / |qty| 비율이 1 미만이면 백만원 단위로 간주
3) foreignRate 비정상값(|x|>100) → null
4) 정렬·중복 제거

idempotent — 두 번 돌려도 동일 결과 (이미 원 단위인 row는 비율 ≥ 1 이라 건너뜀).

실행: python scripts/migrate-flow-units.py
       python scripts/migrate-flow-units.py --dry-run   # 변경 통계만 출력
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
FLOW_DIR = ROOT / "cache" / "flow-history"

DRY_RUN = "--dry-run" in sys.argv


def normalize_keys(row: dict) -> dict:
    """옛 schema 키를 정상 schema 키로 변환."""
    out = dict(row)

    # 키 rename
    if "closePrice" in out and "close" not in out:
        out["close"] = out.pop("closePrice")
    elif "closePrice" in out:
        out.pop("closePrice")

    if "foreignNetQty" in out and "foreignNetVol" not in out:
        out["foreignNetVol"] = out.pop("foreignNetQty")
    elif "foreignNetQty" in out:
        out.pop("foreignNetQty")

    if "orgNetQty" in out and "instNetVol" not in out:
        out["instNetVol"] = out.pop("orgNetQty")
    elif "orgNetQty" in out:
        out.pop("orgNetQty")

    if "orgNetValue" in out and "instNetValue" not in out:
        out["instNetValue"] = out.pop("orgNetValue")
    elif "orgNetValue" in out:
        out.pop("orgNetValue")

    out.pop("personalNetQty", None)

    return out


def needs_million_to_won(value, qty):
    """net value/qty 비율로 단위를 판정. 1 미만이면 백만원 단위."""
    if not value or not qty:
        return False
    try:
        ratio = abs(value) / abs(qty)
    except ZeroDivisionError:
        return False
    return ratio < 1.0


def fix_row(row: dict) -> tuple[dict, bool]:
    """row를 정상 schema + 원 단위로 변환. (새_row, 바뀐_여부)."""
    new_row = normalize_keys(row)
    changed = new_row != row

    # 단위 변환 — foreign / inst 각각 독립 판정
    fnv = new_row.get("foreignNetValue") or 0
    fnq = new_row.get("foreignNetVol") or 0
    if needs_million_to_won(fnv, fnq):
        new_row["foreignNetValue"] = int(fnv * 1_000_000)
        changed = True

    inv = new_row.get("instNetValue") or 0
    inq = new_row.get("instNetVol") or 0
    if needs_million_to_won(inv, inq):
        new_row["instNetValue"] = int(inv * 1_000_000)
        changed = True

    # foreignRate 비정상값(|x|>100)을 null. 정상 보유비율(%)은 0~100 사이.
    fr = new_row.get("foreignRate")
    if isinstance(fr, (int, float)) and abs(fr) > 100:
        new_row["foreignRate"] = None
        changed = True

    return new_row, changed


def migrate_file(path: Path) -> dict:
    """한 파일을 마이그레이션. 통계 dict 반환."""
    stats = {"rows_total": 0, "rows_changed": 0, "file_changed": False}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return stats

    rows = data.get("rows") or []
    if not rows:
        return stats

    stats["rows_total"] = len(rows)
    new_rows = []
    file_changed = False
    for row in rows:
        new_row, changed = fix_row(row)
        if changed:
            stats["rows_changed"] += 1
            file_changed = True
        new_rows.append(new_row)

    # 정렬·중복 제거
    seen = set()
    deduped = []
    for r in sorted(new_rows, key=lambda r: r.get("date", "")):
        d = r.get("date")
        if not d or d in seen:
            continue
        seen.add(d)
        deduped.append(r)
    if deduped != rows:
        file_changed = True

    if file_changed:
        stats["file_changed"] = True
        if not DRY_RUN:
            data["rows"] = deduped
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"), ensure_ascii=False)

    return stats


def main():
    if not FLOW_DIR.exists():
        print(f"[ERROR] {FLOW_DIR} not found")
        sys.exit(1)

    files = sorted(FLOW_DIR.glob("*.json"))
    print(f"[시작] flow-history 마이그레이션 — 대상 {len(files)} 파일 (dry-run={DRY_RUN})")

    files_changed = 0
    rows_total = 0
    rows_changed = 0
    for i, fp in enumerate(files):
        s = migrate_file(fp)
        rows_total += s["rows_total"]
        rows_changed += s["rows_changed"]
        if s["file_changed"]:
            files_changed += 1
        if (i + 1) % 500 == 0:
            print(f"  [진행] {i+1}/{len(files)} 파일")

    print()
    print(f"[완료] 파일 변경: {files_changed}/{len(files)}")
    print(f"       row 변경: {rows_changed}/{rows_total}")
    if DRY_RUN:
        print("       (dry-run — 실제 파일은 건드리지 않음)")


if __name__ == "__main__":
    main()
