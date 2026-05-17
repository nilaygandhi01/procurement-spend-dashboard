#!/usr/bin/env python3
"""
Verify RAP Category filter mapping totals for calendar/fiscal year 2025, Direct spend only,
no other filters — compares per-category sums to published baselines.

Usage (repo root):
  python src/scripts/verify_rap_category_baselines_2025.py
  python src/scripts/verify_rap_category_baselines_2025.py path/to/data.json

Requires data.json with \"rows\": [ { year, spend, spend_type, category_l1, category_l2, category_l3, ... }, ... ]
(the shape emitted by src/scripts/refresh_data.py).
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from rap_category_filter_mapping import get_rap_category_for_filter  # noqa: E402

_YEAR_RE = re.compile(r"(19|20)\d{2}")

# Expected Direct RAP-category baselines (full 2025, no other filters), tolerance $1.
TARGETS: dict[str, float] = {
    "Castings": 283_383_482.57,
    "Forgings, Stampings, and Fabs": 19_616_568.46,
    "Other Manufactured Materials": 2_959_768.02,
    "Turbines and Compressors": 203_261_074.34,
    "Valves and Pumps": 58_734_183.31,
    "Other Fluid and Air Management": 41_900_578.41,
    "Controls": 166_466_137.67,
    "Sensors": 80_089_745.88,
    "Wiring Harnesses And Electrical Components": 23_014_877.37,
    "Precision Machining": 222_286_453.80,
    "Hardware": 50_001_124.29,
    "Other Mechanical Systems": 9_060_563.96,
    "Other Directs": 21_956_694.37,
}
TOTAL_DIRECTS_TARGET = 1_182_731_252.45
TOLERANCE = 1.0
YEAR = 2025


def _row_year(r: dict[str, Any]) -> int:
    y = r.get("year")
    if y is not None and y != "":
        try:
            yi = int(float(y))
            if 1990 <= yi <= 2100:
                return yi
        except (TypeError, ValueError):
            pass
    ym = str(r.get("ym") or "")
    m = _YEAR_RE.search(ym)
    return int(m.group(0)) if m else 0


def _row_spend_type_direct(r: dict[str, Any]) -> bool:
    s = str(r.get("spend_type") or "").strip()
    if s == "Direct":
        return True
    if s == "Indirect":
        return False
    low = s.lower()
    if low == "direct":
        return True
    if low == "indirect":
        return False
    l1 = str(r.get("category_l1") or r.get("c1") or "").lower()
    if "indirect" in l1:
        return False
    if "direct" in l1:
        return True
    return False


def _row_spend(r: dict[str, Any]) -> float:
    try:
        return float(r.get("spend") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _load_rows(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    if isinstance(raw, dict) and isinstance(raw.get("rows"), list):
        return [x for x in raw["rows"] if isinstance(x, dict)]
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    raise SystemExit(f"Unrecognized JSON shape in {path}: need object with 'rows' or a list.")


def default_json_path() -> str:
    env = (os.environ.get("VERIFY_SPEND_JSON") or "").strip()
    if env and os.path.isfile(env):
        return env
    candidates = [
        os.path.join(ROOT, "data", "outputs", "data.json"),
        os.path.join(ROOT, "src", "dashboard", "data.json"),
        os.path.join(ROOT, "data.json"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    raise SystemExit(
        "No data.json found. Set VERIFY_SPEND_JSON or pass path. Tried:\n  "
        + "\n  ".join(candidates)
    )


def main() -> int:
    path = sys.argv[1].strip() if len(sys.argv) > 1 else default_json_path()
    rows = _load_rows(path)
    sums: defaultdict[str, float] = defaultdict(float)
    total_direct = 0.0
    other_direct = 0.0

    for r in rows:
        if _row_year(r) != YEAR:
            continue
        if not _row_spend_type_direct(r):
            continue
        sp = _row_spend(r)
        total_direct += sp
        l1 = r.get("category_l1") or r.get("c1") or ""
        l2 = r.get("category_l2") or r.get("c2") or ""
        l3 = r.get("category_l3") or r.get("c3") or ""
        cat = get_rap_category_for_filter(l1, l2, l3)
        sums[cat] += sp
        if cat == "Other":
            other_direct += sp

    keys_expected = set(TARGETS.keys())
    ok = True
    lines: list[str] = []
    lines.append(f"File: {path}")
    lines.append(f"Rows scanned: {len(rows)} | Year={YEAR} | Direct spend total: ${total_direct:,.2f}")
    lines.append("")

    if abs(total_direct - TOTAL_DIRECTS_TARGET) > TOLERANCE:
        ok = False
        lines.append(
            f"FAIL: TOTAL DIRECT spend vs target — delta ${total_direct - TOTAL_DIRECTS_TARGET:,.2f} "
            f"(target ${TOTAL_DIRECTS_TARGET:,.2f})"
        )
    else:
        lines.append(f"OK: TOTAL DIRECT spend matches target within ${TOLERANCE}.")

    lines.append("")
    for name in sorted(keys_expected):
        t = TARGETS[name]
        got = sums.get(name, 0.0)
        d = got - t
        if abs(d) > TOLERANCE:
            ok = False
            lines.append(f"FAIL: {name!r} — got ${got:,.2f} target ${t:,.2f} (delta ${d:,.2f})")
        else:
            lines.append(f"OK:   {name!r} — ${got:,.2f}")

    # Unexpected Direct money in mapped buckets not in TARGET list (e.g. Other, Indirect buckets mis-tagged)
    extra_keys = set(sums.keys()) - keys_expected - {"Other"}
    # Indirect-only labels should not receive Direct spend; flag if they do
    indirect_labels = {
        "Corporate Services",
        "Facilities Services",
        "Other Indirects",
        "IT and Engineering Services",
        "Product Testing And Manufacturing Services",
        "Supply Chain",
    }
    for ek in sorted(extra_keys):
        v = sums[ek]
        if ek in indirect_labels and v > TOLERANCE:
            ok = False
            lines.append(f"FAIL: Direct spend ${v:,.2f} mapped to indirect bucket {ek!r} (unexpected).")
        elif v > TOLERANCE:
            lines.append(f"NOTE: extra category {ek!r}: ${v:,.2f} (not in baseline table)")

    if other_direct > TOLERANCE:
        ok = False
        lines.append(f"FAIL: {other_direct:,.2f} Direct USD mapped to 'Other' (unmapped L1/L2/L3).")

    lines.append("")
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
