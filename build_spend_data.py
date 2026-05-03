"""
Read CCS Spend Excel, emit D payload for Cummins_IDP_Dashboard.html (used by refresh_data.py → data.json; optional spend_data.json + gzip if run directly).
Run: python build_spend_data.py

Set INPUT_XLSX to override the default workbook path.
"""
from __future__ import annotations

import gzip
import json
import os
import sys

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_XLSX = os.path.join(
    HERE,
    "3.4.01 Jan. 2024 - Apr. 2026 CCS Spend_Direct & Indirect - Copy.xlsx",
)
OUT_JSON = os.path.join(HERE, "spend_data.json")
OUT_GZ = os.path.join(HERE, "spend_data.json.gz")


def _cell_str(x) -> str:
    if x is None or (isinstance(x, float) and x != x):
        return ""
    if isinstance(x, bool):
        s = str(x)
    elif isinstance(x, (int,)):
        s = str(x)
    elif isinstance(x, float) and abs(x - round(x)) < 1e-9:
        s = str(int(round(x)))
    else:
        s = str(x).strip()
        if s.lower() in ("nan", "none", "<na>"):
            return ""
    return s


def intern_col(series: pd.Series) -> tuple[list[str], list[int]]:
    d: dict[str, int] = {"": 0}
    out: list[str] = [""]
    n = len(series)
    idx = [0] * n
    for i in range(n):
        s = _cell_str(series.iloc[i]) if hasattr(series, "iloc") else _cell_str(series[i])
        if not s:
            idx[i] = 0
            continue
        j = d.get(s)
        if j is not None:
            idx[i] = j
        else:
            j = len(out)
            d[s] = j
            out.append(s)
            idx[i] = j
    return out, idx


def build_d(df: pd.DataFrame, source: str) -> dict:
    nrows = len(df)
    if nrows == 0:
        raise SystemExit("No rows in sheet.")

    d_i: dict[str, list[int]] = {}
    dicts: dict[str, list[str]] = {}

    dicts["d"] = [""]
    d_i["iD"] = [0] * nrows

    dicts["comp"] = [""]
    d_i["iComp"] = [0] * nrows

    pairs: list[tuple[str, str, str | None]] = [
        ("iYm", "ym", "Financial Month Year"),
        ("iSu", "su", "Bucketed Supplier Name"),
        ("iErp", "erp", "Supplier Name"),
        ("iErpN", "erpn", "Supplier Number"),
        ("iBu", "bu", "Business Unit"),
        ("iC1", "c1", "Category 1"),
        ("iC2", "c2", "Category 2"),
        ("iC3", "c3", "Category 3"),
        ("iC4", "c4", "Category 4"),
        ("iNoun", "noun", "Part Description"),
        ("iPart", "part", "Part Number"),
        ("iCcode", "ccode", "Commodity Code"),
        ("iCname", "cname", "Commodity Description"),
        ("iBilly", "billy", "Billing Country"),
        ("iBillc", "billc", "Billing City"),
        ("iShpy", "shpy", "Shipping Country"),
        ("iShpc", "shpc", "Shipping City"),
        ("iCo", "co", "Cummins Country"),
        ("iSite", "site", "CMI Location Name"),
    ]
    for ik, dk, ex in pairs:
        u, arr = intern_col(df[ex].map(_cell_str))
        dicts[dk] = u
        d_i[ik] = arr

    # Executive weight/quantity: Excel "Quantity" when present, else "Invoice Quantity" (not any "Lbs" column).
    weight_col = "Quantity" if "Quantity" in df.columns else "Invoice Quantity"
    if weight_col not in df.columns:
        raise SystemExit(
            f"Need column 'Quantity' or 'Invoice Quantity'; columns: {list(df.columns)[:20]}…"
        )

    spend: list[float] = []
    qty: list[float] = []
    qc: list[float] = []
    price: list[float] = []
    weight_lbs: list[float] = []
    for i in range(nrows):
        sp = df["Spend (USD)"].iloc[i]
        spend.append(float(sp) if not (isinstance(sp, float) and sp != sp) else 0.0)
        qv = df[weight_col].iloc[i]
        wv = float(qv) if not (isinstance(qv, float) and qv != qv) else 0.0
        # D.Weight_Lbs in JSON: same as Quantity (legacy key name; not sourced from a "Lbs" column).
        weight_lbs.append(wv)
        qf = wv
        qty.append(qf)
        qc.append(qf)
        pr = df["Invoice Price (USD)"].iloc[i]
        price.append(float(pr) if not (isinstance(pr, float) and pr != pr) else 0.0)

    return {
        "v": 1,
        "sourceFile": source,
        "n": nrows,
        "dicts": dicts,
        "iYm": d_i["iYm"],
        "iD": d_i["iD"],
        "iSu": d_i["iSu"],
        "iErp": d_i["iErp"],
        "iErpN": d_i["iErpN"],
        "iBu": d_i["iBu"],
        "iC1": d_i["iC1"],
        "iC2": d_i["iC2"],
        "iC3": d_i["iC3"],
        "iC4": d_i["iC4"],
        "iNoun": d_i["iNoun"],
        "iPart": d_i["iPart"],
        "iCcode": d_i["iCcode"],
        "iCname": d_i["iCname"],
        "iBilly": d_i["iBilly"],
        "iBillc": d_i["iBillc"],
        "iShpy": d_i["iShpy"],
        "iShpc": d_i["iShpc"],
        "iCo": d_i["iCo"],
        "iComp": d_i["iComp"],
        "iSite": d_i["iSite"],
        "spend": spend,
        "Weight_Lbs": weight_lbs,
        "qty": qty,
        "qc": qc,
        "price": price,
    }


def main() -> None:
    xlsx = os.environ.get("INPUT_XLSX", DEFAULT_XLSX)
    if not os.path.isfile(xlsx):
        print(f"File not found: {xlsx}", file=sys.stderr)
        sys.exit(1)
    print("Reading (may take a few minutes)...", xlsx)
    try:
        df = pd.read_excel(xlsx, sheet_name=0, engine="openpyxl")
    except PermissionError:
        print("Cannot read the file (permission denied). Close Excel or any other app using the workbook, then run again.", file=sys.stderr)
        sys.exit(1)
    d = build_d(df, os.path.basename(xlsx))
    print("Rows:", d["n"])
    print("Writing", OUT_JSON, "...")
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(d, f, separators=(",", ":"), ensure_ascii=False)
    jsize = os.path.getsize(OUT_JSON)
    print(f"  JSON: {jsize // (1024 * 1024)} MB ({jsize} bytes)")
    with gzip.open(OUT_GZ, "wt", encoding="utf-8", compresslevel=9) as f:
        json.dump(d, f, separators=(",", ":"), ensure_ascii=False)
    gsize = os.path.getsize(OUT_GZ)
    print(f"  Gzip: {gsize // (1024 * 1024)} MB ({gsize} bytes)")
    print("Done.")


if __name__ == "__main__":
    main()
