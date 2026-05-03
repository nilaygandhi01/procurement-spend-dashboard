"""
procurement-spend-dashboard/refresh_data.py
-------------------------------------------
Regenerates **data.json** in this same folder (the file Cummins_IDP_Dashboard.html loads via
`fetch("data.json")`). Not under public/ or src/ — keep JSON next to the HTML when using
`python -m http.server`.

Output shape: a JSON object with
  1) "rows": list of flat row objects (incl. spend_type: Direct|Indirect)
  2) "harmonization_results": MECE price harmonization (harmonization.py, v2 schema, 2 category blocks: 1 and 3)
  3) "ytd_comparison": YTD spend/qty vs same month-range prior year
  4) "monthly_spend_by_type": per ym, Direct and Indirect spend (USD) for the full dataset

Data source: default Excel name below, or set INPUT_XLSX / OUT_JSON. Paths with spaces are fine.
Optional: set MIRROR_DATA_TO_PUBLIC=1 to also copy data.json to public/data/data.json (for alternate hosting).

Run (from this folder):  python refresh_data.py
"""
from __future__ import annotations

import glob
import json
import math
import os
import re
import shutil
import sys
import traceback
from datetime import datetime
from typing import Any

import numpy as np
import pandas as pd

from build_spend_data import _cell_str
from harmonization import calculate_harmonization

HERE = os.path.dirname(os.path.abspath(__file__))


def _json_sanitize(obj: Any) -> Any:
    """Recursively convert numpy scalars and replace NaN/Inf so json.dump(..., allow_nan=False) succeeds."""
    if obj is None or isinstance(obj, (str, bool)):
        return obj
    if isinstance(obj, int) and not isinstance(obj, bool):
        return obj
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {str(k): _json_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_sanitize(v) for v in obj]
    try:
        import numpy as np

        if isinstance(obj, np.generic):
            return _json_sanitize(obj.item())
    except Exception:
        pass
    return str(obj)

PRIMARY_XLSX = r"C:\Users\Nilay Gandhi\OneDrive - McKinsey & Company\Desktop\Nilay @ Work\procurement-spend-dashboard\3.4.01 Jan. 2024 - Apr. 2026 CCS Spend_Direct & Indirect - Copy.xlsx"
LOCAL_NAME = "3.4.01 Jan. 2024 - Apr. 2026 CCS Spend_Direct & Indirect - Copy.xlsx"
LOCAL_CANDIDATE = os.path.join(HERE, LOCAL_NAME)

# Map alternate Excel column names to internal names used in harmonization / build_enriched_rows.
# Confirmed source headers (e.g. "Category L1", "Business Unit") are listed as aliases to canonicals.
# If canonical exists, duplicate aliases (same value) are dropped. Else first present alias renames in.
CANONICAL: list[tuple[str, tuple[str, ...]]] = [
    (
        "Financial Month Year",
        (
            "Financial_Month_Year",
            "Fin_Year_Month",
            "Fiscal_Month",
            "Fiscal Month Year",
            "Month",
            "MONTH",
            "Year_Month",
            "Year Month",
        ),
    ),
    (
        "Date",
        (
            "Invoice Date",
            "Invoice_Date",
            "Billing Date",
            "Billing_Date",
            "Trans_Date",
            "Pst_dt",
        ),
    ),
    ("Business Unit", ("Business_Unit", "BU", "Business_Unit_Name", "business_unit", "B_U", "B_U_Name")),
    (
        "Category 1",
        (
            "Category L1",
            "Mapped_Category_L1",
            "L1_Category",
            "Category_1",
            "Category_L1",
            "L1",
            "Cat1",
            "CATEGORY_1",
        ),
    ),
    (
        "Category 2",
        (
            "Category L2",
            "Mapped_Category_L2",
            "L2_Category",
            "Category_2",
            "Category_L2",
            "L2",
            "CATEGORY_2",
        ),
    ),
    (
        "Category 3",
        (
            "Category L3",
            "Mapped_Category_L3",
            "L3_Category",
            "Category_3",
            "Category_L3",
            "L3",
            "CATEGORY_3",
        ),
    ),
    (
        "Category 4",
        (
            "Category L4",
            "Mapped_Category_L4",
            "L4_Category",
            "Category_4",
            "Category_L4",
            "L4",
            "CATEGORY_4",
        ),
    ),
    ("Bucketed Supplier Name", ("Bucketed_Supplier", "Bucketed_Supplier_Name", "CR_Supplier", "cr_supplier")),
    ("Supplier Name", ("Supplier_Name", "Erp_Supplier", "VENDOR_NAME", "vendor_name")),
    ("Supplier Number", ("Supplier_Number", "SupplierNo", "Vendor ID")),
    ("CMI Location Name", ("CMI Location", "CMI_Location", "CMI_Site", "CMI_Location_Name", "CMI_Site_Name", "CMI Site Name")),
    (
        "Cummins Country",
        ("Cummins_Country", "CumminsCountry", "Country_Region", "CMI_Country", "Country (Cummins)", "CMI Country", "Cummins country"),
    ),
    ("Part Number", ("Part_Number", "Part_No", "Material Number", "Material_Number")),
    ("Part Description", ("Part_Description", "Description", "Item_Description", "Noun", "Noun name")),
    ("Commodity Code", ("Commodity_Code", "com_code")),
    ("Commodity Description", ("Commodity_Desc", "Commodity Description Long")),
    ("Billing Country", ("Billing_Country",)),
    ("Billing City", ("Billing_City",)),
    (
        "Shipping Country",
        ("Shipping Country", "Shipping_Country", "Shipping country", "SHIP_COUNTRY", "Ship_Country"),
    ),
    ("Shipping City", ("Shipping_City", "Shipping city", "Ship_City")),
    ("Company", ("Comp", "Comp_Name")),
    ("Material", ("Material_Description", "Material_Desc")),
]


def _year_from_value(val: Any) -> int:
    if val is None or (isinstance(val, float) and val != val):
        return 0
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        yv = int(val) if 1990 < val < 3000 else 0
        if yv:
            return yv
    s = _cell_str(val) if not isinstance(val, (int, float)) else str(val)
    m = re.search(r"(19|20)\d{2}", s)
    if m:
        return int(m.group(0))
    return 0


def _strip_numeric_text(ser: pd.Series) -> pd.Series:
    if pd.api.types.is_numeric_dtype(ser):
        return ser
    return ser.astype(str).str.replace(r"[$,%\s]", "", regex=True)


def _to_float_cell(val: Any) -> float:
    if val is None or (isinstance(val, float) and val != val):
        return 0.0
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return float(val)
    s = _strip_numeric_text(pd.Series([val]))[0]
    try:
        v = float(s) if s != "" and str(s) != "nan" else 0.0
    except ValueError:
        v = 0.0
    return v


def _dim_key(s: str) -> str:
    """Strip whitespace and lower-case for L2, L3, site, and shipping country in JSON."""
    return (s or "").strip().lower()


def spend_type_from_l1(l1: str) -> str:
    """'Direct' if L1 contains 'direct' (not inside 'indirect'); else 'Indirect'."""
    s = (l1 or "").strip().lower()
    if "indirect" in s:
        return "Indirect"
    if "direct" in s:
        return "Direct"
    return "Indirect"


def _parse_row_datetime_for_ym(df: pd.DataFrame, i: int) -> pd.Timestamp | None:
    """Prefer invoice/billing date over Financial Month Year for month bucketing (legacy, slow path)."""
    for c in ("Date", "Invoice Date", "Billing Date", "Financial Month Year"):
        if c not in df.columns:
            continue
        v = df[c].iloc[i]
        t = pd.to_datetime(v, errors="coerce")
        if pd.notna(t):
            return pd.Timestamp(t)
    return None


def _combine_row_timestamps(df: pd.DataFrame) -> pd.Series:
    """One vectorized to_datetime per column, combine_first — matches per-row 'first available' order."""
    ts = None
    for c in ("Date", "Invoice Date", "Billing Date", "Financial Month Year"):
        if c not in df.columns:
            continue
        t2 = pd.to_datetime(df[c], errors="coerce", utc=False)
        ts = t2 if ts is None else ts.combine_first(t2)
    if ts is None:
        return pd.Series(pd.NaT, index=df.index, dtype="datetime64[ns]")
    return ts


def _filler_col(df: pd.DataFrame, name: str) -> pd.Series:
    if name in df.columns:
        return df[name]
    return pd.Series(pd.NA, index=df.index, dtype=object)


def canonicalize_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    for canon, alts in CANONICAL:
        if canon in d.columns:
            for a in alts:
                if a in d.columns and a != canon:
                    d = d.drop(columns=[a], errors="ignore")
            continue
        for a in alts:
            if a in d.columns:
                d = d.rename(columns={a: canon})
                break
    return d


def _get(df: pd.DataFrame, i: int, *names: str) -> str:
    for n in names:
        if n in df.columns:
            v = df[n].iloc[i] if i < len(df) else None
            return _cell_str(v) if v is not None and not (isinstance(v, float) and v != v) else ""
    return ""


def _get_part_col(cols: list[str]) -> str:
    for n in ("Part Number", "Material Number", "Part_Number"):
        if n in cols:
            return n
    return "Part Number"


def _clean_for_numeric(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    for col in out.columns:
        if col in ("Spend (USD)", "Invoice Quantity", "Invoice Price (USD)", "Quantity", "Year"):
            s = out[col]
            s = s.replace(
                to_replace=["#N/A", "#N/A!", "N/A", "n/a", "NaN", "nan", "None", None, ""],
                value=pd.NA,
            )
            s = _strip_numeric_text(s)
            out[col] = pd.to_numeric(s, errors="coerce")
    return out


def _series_cell_str(ser: pd.Series) -> pd.Series:
    """Vector path over the column, then a single .map to _cell_str (no per-row .iloc in callers)."""
    if not isinstance(ser, pd.Series) or ser.empty:
        return ser if isinstance(ser, pd.Series) and ser.empty else pd.Series([], dtype=object)
    return ser.map(
        lambda v: _cell_str(v) if v is not None and not (isinstance(v, float) and (v != v)) else ""
    )


def _extract_year_from_ym_fmy(ser: pd.Series) -> np.ndarray:
    """4-digit year from FMY / text; 0 if not found."""
    ex = ser.astype(str).str.extract(r"((?:19|20)\d{2})")[0]
    yv = pd.to_numeric(ex, errors="coerce").to_numpy()
    o = np.where((yv >= 1990) & (yv < 3000) & ~np.isnan(yv), yv, 0.0).astype(int)
    return o


def _enriched_dataframe_to_records(out_df: pd.DataFrame) -> list[dict[str, Any]]:
    rlist = out_df.to_dict(orient="records")
    for rr in rlist:
        yv0 = rr.get("year", 0)
        try:
            rr["year"] = int(yv0) if yv0 is not None and str(yv0) not in ("", "nan", "None") else 0
        except (TypeError, ValueError):
            rr["year"] = 0
    return rlist


def _build_enriched_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    Flat spend rows for the dashboard, **vectorized** (column-wise to_datetime, no .iloc, no per-row to_datetime).
    """
    n = len(df)
    if n == 0:
        return pd.DataFrame()
    wcol = "Quantity" if "Quantity" in df.columns else "Invoice Quantity"
    if wcol not in df.columns:
        raise SystemExit("Need Quantity or Invoice Quantity.")
    if "Spend (USD)" not in df.columns:
        raise SystemExit("Need 'Spend (USD)'.")
    pcol = _get_part_col(list(df.columns))
    fmy = "Financial Month Year" in df.columns
    fmy_col = df["Financial Month Year"] if fmy else None

    sp = pd.to_numeric(df["Spend (USD)"], errors="coerce").fillna(0.0)
    qv = pd.to_numeric(df[wcol], errors="coerce").fillna(0.0)
    prc = (
        pd.to_numeric(df["Invoice Price (USD)"], errors="coerce").fillna(0.0)
        if "Invoice Price (USD)" in df.columns
        else pd.Series(0.0, index=df.index, dtype=float)
    )
    t = _combine_row_timestamps(df)
    pnum = _series_cell_str(_filler_col(df, pcol))
    noun = _series_cell_str(_filler_col(df, "Part Description"))
    mat0 = _series_cell_str(_filler_col(df, "Material"))
    mat = mat0.where(mat0.str.len() > 0, other=noun)
    b_u = _series_cell_str(_filler_col(df, "Business Unit"))
    l1v = _series_cell_str(_filler_col(df, "Category 1"))
    l2v = _series_cell_str(_filler_col(df, "Category 2")).str.strip().str.lower()
    l3v = _series_cell_str(_filler_col(df, "Category 3")).str.strip().str.lower()
    l4v = _series_cell_str(_filler_col(df, "Category 4"))
    sup = _series_cell_str(_filler_col(df, "Supplier Name"))
    bkt = _series_cell_str(_filler_col(df, "Bucketed Supplier Name"))
    su = sup.where(sup != "", bkt)
    st = l1v.fillna("").map(spend_type_from_l1)
    has_t = t.notna()
    fmy_s = _series_cell_str(fmy_col) if fmy else pd.Series([""] * n, index=df.index, dtype=object)
    ymv = pd.Series("", index=df.index, dtype=object)
    ymv.loc[has_t] = t[has_t].dt.strftime("%b %Y")
    if fmy:
        ymv.loc[~has_t] = fmy_s.loc[~has_t]
    fmy_yv = _extract_year_from_ym_fmy(fmy_col) if fmy else np.zeros(n, dtype=int)
    if "Year" in df.columns:
        ycol = np.rint(
            pd.to_numeric(_filler_col(df, "Year"), errors="coerce").fillna(0).to_numpy()
        )
    else:
        ycol = np.zeros(n, dtype=float)
    yv = (np.where((ycol >= 1990) & (ycol <= 3000), ycol, 0)).astype(int)
    y_arr = np.zeros(n, dtype=int)
    y_arr[has_t.to_numpy()] = t[has_t].dt.year.to_numpy()
    y_fb = np.where(fmy_yv > 0, fmy_yv, yv)
    y_arr[(~has_t).to_numpy()] = y_fb[(~has_t).to_numpy()]
    if fmy:
        mfix = (pd.Series(y_arr, index=ymv.index) > 0) & (ymv == "") & fmy_s.ne("")
        ymv = ymv.where(~mfix, fmy_s)
    d0s = _series_cell_str(_filler_col(df, "Date"))
    tstr = t.dt.strftime("%Y-%m-%d").where(t.notna(), other="")
    mdt = d0s.eq("") & has_t
    d_out = d0s.copy()
    d_out.loc[mdt] = tstr.loc[mdt]
    compv = _series_cell_str(_filler_col(df, "Company")) if "Company" in df.columns else pd.Series([""] * n, index=df.index, dtype=object)
    if "comp" in df.columns:
        comp2 = _series_cell_str(_filler_col(df, "comp"))
        compv = compv.where(compv != "", comp2)
    sitev = _series_cell_str(_filler_col(df, "CMI Location Name")).str.strip().str.lower()
    countryv = _series_cell_str(_filler_col(df, "Shipping Country")).str.strip().str.lower()
    return pd.DataFrame(
        {
            "part": pnum,
            "material": mat,
            "noun": noun,
            "supplier": su,
            "su": su,
            "spend": sp.round(6),
            "quantity": qv.round(6),
            "qty": qv.round(6),
            "year": y_arr,
            "ym": ymv,
            "price": prc.round(6),
            "spend_type": st,
            "business_unit": b_u,
            "category_l1": l1v,
            "category_l2": l2v,
            "category_l3": l3v,
            "category_l4": l4v,
            "site": sitev,
            "country": countryv,
            "co": _series_cell_str(_filler_col(df, "Cummins Country")),
            "cummins_country": _series_cell_str(_filler_col(df, "Cummins Country")),
            "erp": sup,
            "erpn": _series_cell_str(_filler_col(df, "Supplier Number")),
            "ccode": _series_cell_str(_filler_col(df, "Commodity Code")),
            "cname": _series_cell_str(_filler_col(df, "Commodity Description")),
            "billy": _series_cell_str(_filler_col(df, "Billing Country")),
            "billc": _series_cell_str(_filler_col(df, "Billing City")),
            "shpy": _series_cell_str(_filler_col(df, "Shipping Country")),
            "shpc": _series_cell_str(_filler_col(df, "Shipping City")),
            "d": d_out,
            "comp": compv,
            "bu": b_u,
            "c1": l1v,
            "c2": l2v,
            "c3": l3v,
            "c4": l4v,
        }
    )


def build_enriched_rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    return _enriched_dataframe_to_records(_build_enriched_dataframe(df))


def _row_cal_ymkey(row: dict[str, Any]) -> int | None:
    """Y*12 + month_index (0–11) from 'Jan 2024' ym, else from year with Jan."""
    ym = (row.get("ym") or "").strip()
    if ym:
        try:
            t = datetime.strptime(ym, "%b %Y")
            return t.year * 12 + (t.month - 1)
        except (ValueError, OSError, TypeError):
            pass
    y = row.get("year")
    try:
        yv = int(float(y)) if y is not None and str(y) not in ("", "nan", "None") else 0
    except (ValueError, TypeError):
        yv = 0
    if 1990 < yv < 3000:
        return yv * 12 + 0
    return None


def _series_cal_ymkey_from_edf(edf: pd.DataFrame) -> pd.Series:
    """Same key as _row_cal_ymkey: Y*12 + month index 0..11, else NaN."""
    if edf is None or edf.empty:
        return pd.Series([], dtype="float64")
    ym = edf["ym"].astype(str).str.strip()
    t = pd.to_datetime(ym, format="%b %Y", errors="coerce")
    yf = pd.to_numeric(edf["year"], errors="coerce")
    k = pd.Series(np.nan, index=edf.index, dtype="float64")
    v = t.notna()
    if v.any():
        k.loc[v] = t.loc[v].dt.year * 12 + (t.loc[v].dt.month - 1)
    m2 = (~v) & (yf > 1990) & (yf < 3000)
    if m2.any():
        k.loc[m2] = yf[m2] * 12.0
    return k


def _empty_ytd() -> dict[str, Any]:
    return {
        "v": 1,
        "current_year": None,
        "prior_year": None,
        "through_month_1_12": None,
        "current_ytd_spend": 0.0,
        "prior_ytd_spend": 0.0,
        "spend_change_pct": None,
        "current_ytd_qty": 0.0,
        "prior_ytd_qty": 0.0,
        "qty_change_pct": None,
    }


def compute_ytd_comparison_from_dataframe(edf: pd.DataFrame) -> dict[str, Any]:
    """
    YTD: latest calendar year in data through its max available month, vs same months in prior year.
    Vectorized on the enriched DataFrame (no 300k-row dict loop).
    """
    if edf is None or edf.empty:
        return _empty_ytd()
    k = _series_cal_ymkey_from_edf(edf)
    valid = k.notna()
    if not valid.any():
        return _empty_ytd()
    kv = k[valid].to_numpy()
    ky = (kv // 12).astype(np.int64, copy=False)
    km = (kv - ky * 12).astype(np.int64, copy=False)
    sp = pd.to_numeric(edf.loc[valid, "spend"], errors="coerce").fillna(0.0).to_numpy()
    qv = pd.to_numeric(edf.loc[valid, "quantity"], errors="coerce").fillna(0.0).to_numpy()
    max_y = int(ky.max())
    m_max = int(km[ky == max_y].max())
    py = max_y - 1
    ytd_c_sp = float(sp[(ky == max_y) & (km <= m_max)].sum())
    ytd_p_sp = float(sp[(ky == py) & (km <= m_max)].sum())
    ytd_c_q = float(qv[(ky == max_y) & (km <= m_max)].sum())
    ytd_p_q = float(qv[(ky == py) & (km <= m_max)].sum())
    p_sp = (100.0 * (ytd_c_sp - ytd_p_sp) / ytd_p_sp) if ytd_p_sp > 0 else None
    p_q = (100.0 * (ytd_c_q - ytd_p_q) / ytd_p_q) if ytd_p_q > 0 else None
    return {
        "v": 1,
        "current_year": max_y,
        "prior_year": py,
        "through_month_1_12": m_max + 1,
        "current_ytd_spend": round(ytd_c_sp, 2),
        "prior_ytd_spend": round(ytd_p_sp, 2),
        "spend_change_pct": None if p_sp is None else round(float(p_sp), 2),
        "current_ytd_qty": round(ytd_c_q, 2),
        "prior_ytd_qty": round(ytd_p_q, 2),
        "qty_change_pct": None if p_q is None else round(float(p_q), 2),
    }


def build_monthly_spend_by_type_from_dataframe(edf: pd.DataFrame) -> list[dict[str, Any]]:
    """Groupby on ym + Direct|Indirect, same output as build_monthly_spend_by_type (chronological)."""
    if edf is None or edf.empty:
        return []
    m = edf[edf["ym"].astype(str).str.strip() != ""]
    if m.empty:
        return []
    ym = m["ym"].astype(str).str.strip()
    st = m["spend_type"].astype(str).str.strip()
    kind = np.where(st == "Direct", "Direct", "Indirect")
    spv = pd.to_numeric(m["spend"], errors="coerce").fillna(0.0)
    g = m.assign(_ym=ym, _k=kind, _sp=spv).groupby(["_ym", "_k"], sort=False)["_sp"].sum()
    try:
        wide = g.unstack("_k", fill_value=0.0)
    except (ValueError, TypeError, KeyError):
        return []
    for c in ("Direct", "Indirect"):
        if c not in wide.columns:
            wide[c] = 0.0
    out: list[tuple[datetime, str, float, float]] = []
    for ym0 in wide.index:
        try:
            t0 = datetime.strptime(str(ym0), "%b %Y")
        except (ValueError, TypeError, OSError):
            continue
        d = float(wide.at[ym0, "Direct"])
        indv = float(wide.at[ym0, "Indirect"])
        out.append((t0, str(ym0), d, indv))
    out.sort(key=lambda x: x[0])
    return [
        {
            "ym": label,
            "Direct": round(d, 2),
            "Indirect": round(indv, 2),
        }
        for _dt, label, d, indv in out
    ]


def compute_ytd_comparison(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """
    YTD: latest calendar year in data through its max available month, vs same months in prior year.
    """
    empty = _empty_ytd()
    if not rows:
        return empty
    triples: list[tuple[int, int, float, float]] = []
    for r in rows:
        k = _row_cal_ymkey(r)
        if k is None:
            continue
        y = (k - (k % 12)) // 12
        m0 = k - y * 12
        try:
            sp = float(r.get("spend") or 0.0)
        except (TypeError, ValueError):
            sp = 0.0
        try:
            qv = r.get("quantity")
            if qv is None:
                qv = r.get("qty")
            qf = float(qv or 0.0)
        except (TypeError, ValueError):
            qf = 0.0
        triples.append((y, m0, sp, qf))
    if not triples:
        return empty
    max_y = max(t[0] for t in triples)
    m_max = max(t[1] for t in triples if t[0] == max_y)
    py = max_y - 1
    ytd_c_sp = ytd_p_sp = ytd_c_q = ytd_p_q = 0.0
    for y, m0, sp, qf in triples:
        if y == max_y and m0 <= m_max:
            ytd_c_sp += sp
            ytd_c_q += qf
        if y == py and m0 <= m_max:
            ytd_p_sp += sp
            ytd_p_q += qf
    p_sp: float | None
    p_q: float | None
    p_sp = (100.0 * (ytd_c_sp - ytd_p_sp) / ytd_p_sp) if ytd_p_sp > 0 else None
    p_q = (100.0 * (ytd_c_q - ytd_p_q) / ytd_p_q) if ytd_p_q > 0 else None
    return {
        "v": 1,
        "current_year": max_y,
        "prior_year": py,
        "through_month_1_12": m_max + 1,
        "current_ytd_spend": round(ytd_c_sp, 2),
        "prior_ytd_spend": round(ytd_p_sp, 2),
        "spend_change_pct": None if p_sp is None else round(float(p_sp), 2),
        "current_ytd_qty": round(ytd_c_q, 2),
        "prior_ytd_qty": round(ytd_p_q, 2),
        "qty_change_pct": None if p_q is None else round(float(p_q), 2),
    }


def build_monthly_spend_by_type(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Global aggregation: each calendar month (ym 'Jan 2024') with Direct vs Indirect spend (USD),
    sorted chronologically. Aligns with dashboard monthly split (row-level spend_type).
    """
    from collections import defaultdict

    m: dict[str, dict[str, float]] = defaultdict(lambda: {"Direct": 0.0, "Indirect": 0.0})
    for r in rows:
        ym = (r.get("ym") or "").strip()
        if not ym:
            continue
        try:
            sp = float(r.get("spend") or 0.0)
        except (TypeError, ValueError):
            sp = 0.0
        st = (r.get("spend_type") or "").strip()
        if st == "Direct":
            m[ym]["Direct"] += sp
        else:
            m[ym]["Indirect"] += sp
    if not m:
        return []
    out: list[tuple[datetime, str, dict[str, float]]] = []
    for ym, v in m.items():
        try:
            t0 = datetime.strptime(ym, "%b %Y")
        except ValueError:
            continue
        out.append((t0, ym, dict(v)))
    out.sort(key=lambda x: x[0])
    return [
        {
            "ym": ym,
            "Direct": round(t["Direct"], 2),
            "Indirect": round(t["Indirect"], 2),
        }
        for _dt, ym, t in out
    ]


def resolve_excel_path() -> str:
    env = os.environ.get("INPUT_XLSX", "").strip()
    if env and os.path.isfile(env):
        return os.path.normpath(env)
    if os.path.isfile(PRIMARY_XLSX):
        return os.path.normpath(PRIMARY_XLSX)
    if os.path.isfile(LOCAL_CANDIDATE):
        print("Using project-folder workbook:", LOCAL_CANDIDATE, file=sys.stderr)
        return os.path.normpath(LOCAL_CANDIDATE)
    pattern = os.path.join(HERE, "3.4.01*CCS*Spend*Indirect*.xlsx")
    m = glob.glob(pattern)
    if len(m) == 1 and os.path.isfile(m[0]):
        print("Using single matching workbook in folder:", m[0], file=sys.stderr)
        return os.path.normpath(m[0])
    m2 = [p for p in glob.glob(os.path.join(HERE, "*.xlsx")) if "node_modules" not in p.replace("\\", "/")]
    if len(m2) == 1:
        print("Using only .xlsx in project folder:", m2[0], file=sys.stderr)
        return os.path.normpath(m2[0])
    print("No Excel file found.", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    xlsx = resolve_excel_path()
    out = (os.environ.get("OUT_JSON") or os.environ.get("OUTPUT_JSON") or os.path.join(HERE, "data.json")).strip() or os.path.join(HERE, "data.json")
    out = os.path.abspath(os.path.normpath(out))
    print("Reading Excel…", xlsx, flush=True)
    try:
        raw = pd.read_excel(xlsx, sheet_name=0, engine="openpyxl")
    except Exception as e:
        print("read_excel failed:", e, file=sys.stderr)
        if isinstance(e, PermissionError):
            print("Close the workbook in Excel and retry.", file=sys.stderr)
        sys.exit(1)
    if raw is None or len(raw) == 0:
        print("Sheet is empty.", file=sys.stderr)
        sys.exit(1)
    df0 = _clean_for_numeric(raw)
    df1 = canonicalize_dataframe(df0)
    h: dict[str, Any]
    try:
        h = calculate_harmonization(df1)
        _cats = h.get("categories") if isinstance(h, dict) else None
        _n = len(_cats) if isinstance(_cats, list) else 0
        print(f"Harmonization payload: category_blocks={_n} (must be 2: Cat 1 + Cat 3)", flush=True)
        _val = h.get("validation") if isinstance(h, dict) else None
        if isinstance(_val, dict) and _val:
            print(
                "Category row counts (base-table rows with opportunity): "
                f"cat1={_val.get('category_1_rows')} "
                f"cat2={_val.get('category_2_rows')} "
                f"cat3={_val.get('category_3_rows')} "
                f"no_opp={_val.get('no_opportunity_rows')} "
                f"sum_ok={_val.get('sum_matches_base')}",
                flush=True,
            )
    except Exception as e:
        traceback.print_exc()
        print("harmonization (non-fatal):", e, file=sys.stderr)
        h = {
            "v": 2,
            "message": str(e),
            "analysis_year": None,
            "part_key": "",
            "parts_analyzed": 0,
            "base_table_row_count": 0,
            "total_opportunity_usd": 0,
            "price_fragmented_parts_count": 0,
            "parts_for_80_pct_value": 0,
            "pct_savings_vs_spend": None,
            "categories": [],
            "top_5": [],
            "top_10": [],
        }
    n_parts = int(h.get("parts_analyzed", 0) or 0)
    hy = h.get("analysis_year") if h.get("analysis_year") is not None else h.get("year")
    print(f"Harmonization: {n_parts} parts (year={hy})", flush=True)
    try:
        edf = _build_enriched_dataframe(df1)
        ytd = compute_ytd_comparison_from_dataframe(edf)
        monthly_type = build_monthly_spend_by_type_from_dataframe(edf)
        rows = _enriched_dataframe_to_records(edf)
    except SystemExit as se:
        raise
    except Exception as e:
        print("enriched / ytd / monthly:", e, file=sys.stderr)
        raise
    n = len(rows)
    out_obj: dict[str, Any] = {
        "rows": rows,
        "harmonization_results": _json_sanitize(h),
        "ytd_comparison": ytd,
        "monthly_spend_by_type": monthly_type,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(out_obj, f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    z = os.path.getsize(out)
    print(
        "Wrote",
        out,
        f"— {n} flat rows, ytd y={ytd.get('current_year')}, ytd_spend%Δ={ytd.get('spend_change_pct')}, "
        f"harmonization, {z // (1024 * 1024)} MB ({z} bytes)",
        flush=True,
    )
    if os.environ.get("MIRROR_DATA_TO_PUBLIC", "").strip().lower() in ("1", "true", "yes"):
        pub = os.path.join(HERE, "public", "data", "data.json")
        try:
            os.makedirs(os.path.dirname(pub), exist_ok=True)
            shutil.copy2(out, pub)
            print("Mirrored to", pub, flush=True)
        except OSError as e:
            print("Could not mirror to public/data:", e, file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
