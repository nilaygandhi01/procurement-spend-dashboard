"""
Price harmonization: one base table (Item + Supplier + Site + Year), then MECE categories.

Base grain: Item Number, Supplier, Site, Year (aggregated: sum qty, sum spend, unit price).
Analysis year: min(max(Year) in data, current calendar year) to avoid future-dated data.

Outliers: row-level Tukey IQR (3.0× fences) on unit_price within (item, site) and (item, supplier) when ≥4 rows;
MECE cards skip unit-price spreads above MAX_UNIT_PRICE_SPREAD_USD (cap extreme tails); savings ≥ MIN_TOP5_SAVINGS_USD per slice.

MECE order (exports: Categories 1, 2, and 3):
  1) Category 1 — same Item+Site, multiple suppliers, unit_price > min within (item, site)
  2) Category 2 (remaining) — same Item across sites with ≥2 suppliers and ≥2 sites;
     savings = (unit_price − min unit price for item across all tranches) × qty on tranches above min
  3) Category 3 (remaining) — same Item+Supplier, multiple sites, unit_price > min across sites
"""
from __future__ import annotations

import math
import re
import sys
from datetime import datetime
from typing import Any

import pandas as pd

VARIANCE_PCT = 0.02
TOP_N = 65
JSON_VERSION = 3
# Skip MECE slices whose unit-price span (max − min) exceeds this (USD); keeps smaller spreads / long tail.
MAX_UNIT_PRICE_SPREAD_USD = 25000.0
# MECE slice: skip opportunities whose MECE savings sum for that (item,site) or (item,supplier) group is below this (USD).
MIN_TOP5_SAVINGS_USD = 1000.0

HARMONIZATION_CALCULATION_NOTES = (
    "Maximum unit-price spread capped at $25000 (captures long tail); top cards require at least $1000 MECE savings. "
    "Base-table outliers trimmed with relaxed IQR (3.0× multiplier) on (item×site) and (item×supplier) groups when ≥4 rows. "
    "Savings use weighted transaction unit prices × quantities."
)

_BAR_GREEN = "#4CAF50"
_BAR_BLUE = "#7986CB"


def _row_year(v: Any) -> int | None:
    if v is None or (isinstance(v, float) and (v != v or math.isnan(v))):
        return None
    s = str(v).strip()
    if not s:
        return None
    m = re.search(r"(20[0-2][0-9])", s)
    if m:
        y = int(m.group(1))
        if 2000 <= y <= 2100:
            return y
    try:
        d = pd.to_datetime(s, errors="coerce")
        if pd.isna(d):
            return None
        return int(pd.Timestamp(d).year)
    except Exception:
        return None


def _get_year_series(df: pd.DataFrame) -> pd.Series:
    if "Year" in df.columns:
        y = pd.to_numeric(df["Year"], errors="coerce")
        if y.notna().any():
            return y
    fmy = "Financial Month Year" if "Financial Month Year" in df.columns else None
    if fmy and fmy in df.columns:
        return df[fmy].map(_row_year)
    if "Date" in df.columns:
        return df["Date"].map(_row_year)
    return pd.Series([None] * len(df), index=df.index)


def _part_col(cols: list[str]) -> str | None:
    for n in ("Part Number", "Material", "Material Number"):
        if n in cols:
            return n
    return None


def _empty(msg: str, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "v": JSON_VERSION,
        "message": msg,
        "analysis_year": None,
        "part_key": "",
        "base_table_row_count": 0,
        "validation": {
            "category_1_rows": 0,
            "category_2_rows": 0,
            "category_3_rows": 0,
            "no_opportunity_rows": 0,
            "sum_matches_base": False,
        },
        "total_opportunity_usd": 0.0,
        "price_fragmented_parts_count": 0,
        "parts_for_80_pct_value": 0,
        "pct_savings_vs_spend": None,
        "categories": [],
        "harmonization_meta": {
            "max_unit_price_spread_usd": MAX_UNIT_PRICE_SPREAD_USD,
            "min_top5_savings_usd": MIN_TOP5_SAVINGS_USD,
            "calculation_notes": HARMONIZATION_CALCULATION_NOTES,
            "outlier_method": "none",
            "iqr_outlier_rows_removed": 0,
        },
    }
    out.update(extra)
    return out


def _round_usd(x: Any) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v):
        return 0.0
    return round(v, 2)


def _build_base_table(df: pd.DataFrame) -> tuple[pd.DataFrame, int, str, str | None]:
    """
    Returns (base_table, target_year, supplier_col, part_col_name).
    base_table columns: item, supplier, site, year, total_qty, total_spend, unit_price
    """
    pk = _part_col(list(df.columns))
    if not pk:
        return pd.DataFrame(), 0, "Supplier Name", None

    sup_col = "Supplier Name" if "Supplier Name" in df.columns else "Bucketed Supplier Name"
    if sup_col not in df.columns:
        return pd.DataFrame(), 0, sup_col, pk

    if "CMI Location Name" not in df.columns:
        return pd.DataFrame(), 0, sup_col, pk

    wcol = "Quantity" if "Quantity" in df.columns else "Invoice Quantity"
    if wcol not in df.columns or "Spend (USD)" not in df.columns:
        return pd.DataFrame(), 0, sup_col, pk

    work = df.copy()
    work["_yr"] = _get_year_series(work)
    if work["_yr"].isna().all():
        return pd.DataFrame(), 0, sup_col, pk

    yseries = work["_yr"].dropna()
    if yseries.empty:
        return pd.DataFrame(), 0, sup_col, pk
    max_in_data = int(yseries.max())
    now_y = datetime.now().year
    if max_in_data < 1990 or max_in_data > 2100:
        return pd.DataFrame(), 0, sup_col, pk
    # Latest *complete* calendar year: exclude current year (incomplete YTD) when older years exist
    y_complete = yseries[yseries < now_y]
    if len(y_complete) > 0:
        target_year = int(y_complete.max())
    else:
        target_year = min(max_in_data, now_y)
    if target_year < 1990 or target_year > 2100:
        return pd.DataFrame(), 0, sup_col, pk

    work = work[work["_yr"] == target_year].copy()
    if len(work) == 0:
        return pd.DataFrame(), target_year, sup_col, pk

    work["spend"] = pd.to_numeric(work["Spend (USD)"], errors="coerce").fillna(0.0)
    work["qty"] = pd.to_numeric(work[wcol], errors="coerce").fillna(0.0)
    work["item"] = work[pk].map(lambda x: str(x).strip() if pd.notna(x) else "")
    work["supplier"] = work[sup_col].map(lambda x: str(x).strip() if pd.notna(x) else "")
    work["site"] = work["CMI Location Name"].map(lambda x: str(x).strip() if pd.notna(x) else "")

    g = (
        work.groupby(["item", "supplier", "site"], as_index=False, observed=True)
        .agg(total_qty=("qty", "sum"), total_spend=("spend", "sum"), year=("_yr", "max"))
    )
    g = g[(g["total_qty"] > 0) & (g["item"] != "")]
    # Canonical str keys so groupby index labels always match filter (avoids int vs str part IDs → empty charts / crashes)
    g["item"] = g["item"].map(lambda x: str(x).strip() if pd.notna(x) else "")
    g = g[g["item"] != ""]
    g["unit_price"] = g["total_spend"] / g["total_qty"]
    g["target_year"] = target_year
    return g, target_year, sup_col, pk


def _tukey_outlier_indices(prices: list[float]) -> set[int]:
    """Indices into prices (0..n-1) outside Tukey fences [Q1−3.0·IQR, Q3+3.0·IQR]. Empty if n<4 or would leave <2 points."""
    n = len(prices)
    if n < 4:
        return set()
    order = sorted(range(n), key=lambda i: prices[i])
    sorted_p = [prices[i] for i in order]
    q1 = sorted_p[n // 4]
    q3 = sorted_p[(3 * n) // 4]
    iqr = float(q3 - q1)
    if iqr <= 1e-12:
        return set()
    lo = q1 - 3.0 * iqr
    hi = q3 + 3.0 * iqr
    drop_pos: set[int] = set()
    for j in range(n):
        v = sorted_p[j]
        if v < lo or v > hi:
            drop_pos.add(order[j])
    if n - len(drop_pos) < 2:
        return set()
    return drop_pos


def _filter_base_iqr_outliers(base: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """
    Within each (item, site) and (item, supplier) group with >=4 rows, drop Tukey IQR outliers on unit_price.
    Union of drops from both passes (replaces prior rule that removed entire groups on price span).
    """
    if base is None or len(base) == 0:
        return base, 0

    drop_idx: set[Any] = set()

    for _, sub in base.groupby(["item", "site"], observed=True):
        if len(sub) < 4:
            continue
        prices = [float(x) for x in sub["unit_price"].tolist()]
        bad_local = _tukey_outlier_indices(prices)
        rows = sub.index.tolist()
        for li in bad_local:
            drop_idx.add(rows[li])

    for _, sub in base.groupby(["item", "supplier"], observed=True):
        if len(sub) < 4:
            continue
        prices = [float(x) for x in sub["unit_price"].tolist()]
        bad_local = _tukey_outlier_indices(prices)
        rows = sub.index.tolist()
        for li in bad_local:
            drop_idx.add(rows[li])

    n_before = len(base)
    out = base.drop(index=list(drop_idx), errors="ignore").reset_index(drop=True)
    removed = n_before - len(out)
    return out, removed


def _format_note_pct_below(pmin: float, pmax: float) -> tuple[float, str]:
    if pmin <= 0 or pmax <= pmin:
        return 0.0, ""
    pct = 100.0 * (pmax - pmin) / pmax
    return round(pct, 1), f"{round(pct, 1)}% below priciest tranche"


def _assign_mece(base: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, int], float]:
    """
    Append columns: category (0 none, 1,2,3), savings, min_ref_price
    """
    b = base.copy()
    b["item"] = b["item"].map(lambda x: str(x).strip() if pd.notna(x) else "")
    b = b[b["item"] != ""]
    b["category"] = 0
    b["savings"] = 0.0
    b["min_ref_price"] = b["unit_price"].values  # overwrites below

    n = len(b)
    b["_idx"] = range(n)

    # ---- Category 1: (Item, Site) — multiple suppliers at the same plant.
    # For each tranche with unit_price > min price at that (item, site):
    #   savings_tranche = (unit_price - min_price_at_plant) * total_qty_tranche
    # Total Cat-1 savings for a slice is the sum of those tranche savings.
    n_sup = b.groupby(["item", "site"], observed=True)["supplier"].transform("nunique")
    pmin1 = b.groupby(["item", "site"], observed=True)["unit_price"].transform("min")
    mask1 = (n_sup > 1) & (b["unit_price"] > pmin1 + 1e-12)
    b.loc[mask1, "min_ref_price"] = pmin1[mask1]
    s1 = (b.loc[mask1, "unit_price"] - pmin1[mask1]) * b.loc[mask1, "total_qty"]
    b.loc[mask1, "savings"] = s1
    b.loc[mask1, "category"] = 1

    rem = b["category"] == 0

    # ---- Category 2: (Item) — multiple sites AND multiple suppliers among remaining rows;
    # savings = (unit_price - min unit price for item) * qty where price > item min.
    b2 = b.loc[rem].copy()
    g_item_site = b2.groupby("item", observed=True)["site"].transform("nunique")
    g_item_sup = b2.groupby("item", observed=True)["supplier"].transform("nunique")
    pmin_item = b2.groupby("item", observed=True)["unit_price"].transform("min")
    mask2 = (g_item_site > 1) & (g_item_sup > 1) & (b2["unit_price"] > pmin_item + 1e-12)
    idx2 = b2.index[mask2]
    b.loc[idx2, "min_ref_price"] = pmin_item[mask2].values
    b.loc[idx2, "savings"] = (b2.loc[mask2, "unit_price"].values - pmin_item[mask2].values) * b2.loc[
        mask2, "total_qty"
    ].values
    b.loc[idx2, "category"] = 2

    rem = b["category"] == 0

    # ---- Category 3: (Item, Supplier) — same supplier, multiple plants.
    # Legitimate Cat-3 rows appear only where Cat 1 did not already attribute savings (same
    # base tranche cannot be both multi-supplier-at-site and priced here). Thresholds
    # (MIN_TOP5_SAVINGS_USD, MAX_UNIT_PRICE_SPREAD_USD) apply identically to Cat 1 and 3 cards.
    # Only rows still category 0 after Cat 1 are eligible (MECE). For each tranche with
    # unit_price > min price for that (item, supplier) across sites:
    #   savings_tranche = (unit_price - min_price_across_plants) * total_qty_tranche
    b2 = b.loc[rem].copy()
    g3 = b2.groupby(["item", "supplier"], observed=True)
    ns3 = b2.groupby(["item", "supplier"], observed=True)["site"].transform("nunique")
    pmin3 = g3["unit_price"].transform("min")
    mask3 = (ns3 > 1) & (b2["unit_price"] > pmin3 + 1e-12)
    idx3 = b2.index[mask3]
    b.loc[idx3, "min_ref_price"] = pmin3[mask3].values
    b.loc[idx3, "savings"] = (b2.loc[mask3, "unit_price"].values - pmin3[mask3].values) * b2.loc[
        mask3, "total_qty"
    ].values
    b.loc[idx3, "category"] = 3

    b.loc[b["category"] == 0, "savings"] = 0.0
    b.loc[b["category"] == 0, "min_ref_price"] = b.loc[b["category"] == 0, "unit_price"]

    total_sav = float(b["savings"].sum())
    val = {
        "category_1_rows": int((b["category"] == 1).sum()),
        "category_2_rows": int((b["category"] == 2).sum()),
        "category_3_rows": int((b["category"] == 3).sum()),
        "no_opportunity_rows": int((b["category"] == 0).sum()),
    }
    val["sum_matches_base"] = val["category_1_rows"] + val["category_2_rows"] + val["category_3_rows"] + val["no_opportunity_rows"] == n

    return b, val, total_sav


def _fragmented_parts_count(base: pd.DataFrame) -> int:
    if len(base) == 0:
        return 0
    pp = base.groupby("item", observed=True).agg(umin=("unit_price", "min"), umax=("unit_price", "max"))
    ok = (pp["umin"] > 0) & (pp["umax"] > pp["umin"])
    sp = (pp["umax"] - pp["umin"]) / pp["umin"]
    return int((ok & (sp > VARIANCE_PCT)).sum())


def _p80_savings_index(tagged: pd.DataFrame, category_id: int) -> pd.Series:
    t = tagged[tagged["category"] == category_id]
    if t.empty:
        return pd.Series(dtype=float)
    gcols: list[str] = (
        ["item", "site"]
        if category_id == 1
        else ["item"]
        if category_id == 2
        else (["item", "supplier"] if category_id == 3 else ["item"])
    )
    return t.groupby(gcols, observed=True)["savings"].sum().sort_values(ascending=False)


def _parts_to_80(item_sav: pd.Series, total: float) -> int:
    if item_sav.empty or total <= 0:
        return 0
    target = 0.8 * total
    c = 0.0
    n = 0
    for _it, s in item_sav.items():
        c += float(s)
        n += 1
        if c >= target:
            break
    return n


def _build_cat1_opportunities(
    tagged: pd.DataFrame,
    base: pd.DataFrame,
    max_cards: int | None,
) -> list[dict[str, Any]]:
    """
    MECE category 1 at (item, site) grain. Chart: suppliers vs unit price at one site.
    If max_cards is set, return only that many slices (by savings desc); else all qualifying slices.
    """
    t = tagged[tagged["category"] == 1]
    if t.empty:
        return []
    gsum = t.groupby(["item", "site"], observed=True)["savings"].sum().sort_values(ascending=False)
    out: list[dict[str, Any]] = []
    taken = 0

    for (it, st) in gsum.index:
        if max_cards is not None and taken >= max_cards:
            break
        try:
            sav_here = float(gsum.loc[(it, st)])
        except Exception:
            sav_here = 0.0
        if sav_here < MIN_TOP5_SAVINGS_USD:
            continue
        it_s, st_s = str(it).strip(), str(st).strip()
        pk = it_s
        # Full base tranches (all suppliers) for chart/table; tagged only has rows with savings>0
        bpart = base[(base["item"].astype(str) == it_s) & (base["site"].astype(str) == st_s)]
        if bpart.empty or bpart["supplier"].nunique() < 2:
            continue
        pr = bpart
        tot_spend = float(pr["total_spend"].sum()) if not pr.empty else 0.0
        tot_qty = float(pr["total_qty"].sum()) if not pr.empty else 0.0
        if not math.isfinite(tot_spend):
            tot_spend = 0.0
        if not math.isfinite(tot_qty):
            tot_qty = 0.0
        pmin = float(pr["unit_price"].min())
        pmax = float(pr["unit_price"].max())
        if not (math.isfinite(pmin) and math.isfinite(pmax)) or pmax <= pmin + 1e-12:
            continue
        if (pmax - pmin) > MAX_UNIT_PRICE_SPREAD_USD:
            continue
        pct, note0 = _format_note_pct_below(pmin, pmax)
        r_lo = pr.loc[pr["unit_price"].idxmin()]
        r_hi = pr.loc[pr["unit_price"].idxmax()]
        low_s = f"{str(r_lo['supplier'])[:50]} - {str(r_lo['site'])[:40]}"
        high_s = f"{str(r_hi['supplier'])[:50]} - {str(r_hi['site'])[:40]}"
        note = f"{note0} · {str(r_hi['supplier'])} (high) vs {str(r_lo['supplier'])} (low) at same site"

        labels: list[str] = []
        prices: list[int] = []
        colors: list[str] = []
        for _, row in pr.sort_values("unit_price", ascending=True).iterrows():
            up = float(row["unit_price"])
            if not math.isfinite(up):
                continue
            sn = str(row["supplier"])
            lab = f"{sn[:50]}{'…' if len(sn) > 50 else ''}"
            labels.append(lab[:100])
            prices.append(int(round(up)))
            is_m = up <= pmin + 1e-9 * (1.0 + abs(pmin))
            colors.append(_BAR_GREEN if is_m else _BAR_BLUE)
        if not labels:
            continue

        groups_table = [
            {
                "label": f"{str(r['supplier'])[:50]} - {str(r['site'])[:50]}",
                "qty": int(round(float(r["total_qty"]))),
            }
            for _, r in pr.iterrows()
        ]
        sup_rows: list[dict[str, Any]] = []
        for _, r in pr.sort_values("unit_price", ascending=True).iterrows():
            up2 = float(r["unit_price"])
            if not math.isfinite(up2):
                continue
            sup_rows.append(
                {
                    "supplier": str(r["supplier"])[:200],
                    "site": str(r["site"])[:200],
                    "unit_price": _round_usd(up2),
                    "quantity": _round_usd(r["total_qty"]),
                    "spend": _round_usd(r["total_spend"]),
                }
            )
        export_rows: list[dict[str, Any]] = []
        for _, r in pr.iterrows():
            upv = float(r["unit_price"])
            qv = float(r["total_qty"])
            sav0 = max(0.0, (upv - pmin) * qv) if math.isfinite(upv) and math.isfinite(qv) else 0.0
            export_rows.append(
                {
                    "Item Number": pk,
                    "Supplier": str(r["supplier"]),
                    "Site": str(r["site"]),
                    "Unit Price": _round_usd(r["unit_price"]),
                    "Quantity": _round_usd(r["total_qty"]),
                    "Spend": _round_usd(r["total_spend"]),
                    "Savings": _round_usd(sav0),
                    "Category": "Category 1",
                }
            )
        out.append(
            {
                "harm_mece": 1,
                "item": f"{pk} · {st_s}"[:200],
                "total_spend": int(round(tot_spend)),
                "total_quantity": int(round(tot_qty)),
                "price_gap_abs": _round_usd(pmax - pmin),
                "price_gap_pct": pct,
                "savings_subtitle": note,
                "has_price_variance": pmax > pmin + 1e-12,
                "lowest_supplier_site": low_s[:200],
                "highest_supplier_site": high_s[:200],
                "suppliers": sup_rows,
                "supplier_count": int(pr["supplier"].nunique()),
                "chart": {
                    "labels": labels,
                    "unit_prices": prices,
                    "bar_colors": colors,
                    "y_axis_label": "Unit price (USD / unit)",
                },
                "groups": groups_table,
                "export_rows": export_rows,
            }
        )
        taken += 1
    return out


def _build_cat2_opportunities(
    tagged: pd.DataFrame,
    base: pd.DataFrame,
    max_cards: int | None,
) -> list[dict[str, Any]]:
    """
    MECE category 2 at item grain: multiple sites and multiple suppliers; benchmark is min unit price across all
    (item, supplier, site) tranches for that item. Same thresholds as Categories 1 and 3.
    """
    t = tagged[tagged["category"] == 2]
    if t.empty:
        return []
    gsum = t.groupby("item", observed=True)["savings"].sum().sort_values(ascending=False)
    out: list[dict[str, Any]] = []
    taken = 0

    for it in gsum.index:
        if max_cards is not None and taken >= max_cards:
            break
        try:
            sav_here = float(gsum.loc[it])
        except Exception:
            sav_here = 0.0
        if sav_here < MIN_TOP5_SAVINGS_USD:
            continue
        it_s = str(it).strip()
        pk = it_s
        bpart = base[base["item"].astype(str) == it_s]
        if bpart.empty or bpart["site"].nunique() < 2 or bpart["supplier"].nunique() < 2:
            continue
        pr = bpart
        tot_spend = float(pr["total_spend"].sum()) if not pr.empty else 0.0
        tot_qty = float(pr["total_qty"].sum()) if not pr.empty else 0.0
        if not math.isfinite(tot_spend):
            tot_spend = 0.0
        if not math.isfinite(tot_qty):
            tot_qty = 0.0
        pmin = float(pr["unit_price"].min())
        pmax = float(pr["unit_price"].max())
        if not (math.isfinite(pmin) and math.isfinite(pmax)) or pmax <= pmin + 1e-12:
            continue
        if (pmax - pmin) > MAX_UNIT_PRICE_SPREAD_USD:
            continue
        pct, note0 = _format_note_pct_below(pmin, pmax)
        r_lo = pr.loc[pr["unit_price"].idxmin()]
        r_hi = pr.loc[pr["unit_price"].idxmax()]
        t_sub = tagged[(tagged["item"].astype(str) == it_s) & (tagged["category"] == 2)].copy()
        if t_sub.empty:
            continue
        try:
            lead = t_sub.sort_values("savings", ascending=False).iloc[0]
            disp_site = str(lead["site"])[:200]
            disp_sup = str(lead["supplier"])[:200]
        except Exception:
            disp_site = str(r_hi["site"])[:200]
            disp_sup = str(r_hi["supplier"])[:200]
        low_s = f"{str(r_lo['supplier'])[:50]} @ {str(r_lo['site'])[:40]} (low)"
        high_s = f"{str(r_hi['supplier'])[:50]} @ {str(r_hi['site'])[:40]} (high)"
        note = f"{note0} · cross-site vs global min · {high_s} vs {low_s}"

        labels: list[str] = []
        prices: list[int] = []
        colors: list[str] = []
        for _, row in pr.sort_values("unit_price", ascending=True).iterrows():
            up = float(row["unit_price"])
            if not math.isfinite(up):
                continue
            lab = f"{str(row['supplier'])[:40]} @ {str(row['site'])[:40]}"
            labels.append(lab[:100])
            prices.append(int(round(up)))
            is_m = up <= pmin + 1e-9 * (1.0 + abs(pmin))
            colors.append(_BAR_GREEN if is_m else _BAR_BLUE)
        if not labels:
            continue

        groups_table = [
            {
                "label": f"{str(r['supplier'])[:50]} - {str(r['site'])[:50]}",
                "qty": int(round(float(r["total_qty"]))),
            }
            for _, r in pr.iterrows()
        ]
        sup_rows: list[dict[str, Any]] = []
        for _, r in pr.sort_values("unit_price", ascending=True).iterrows():
            up2 = float(r["unit_price"])
            if not math.isfinite(up2):
                continue
            sup_rows.append(
                {
                    "supplier": str(r["supplier"])[:200],
                    "site": str(r["site"])[:200],
                    "unit_price": _round_usd(up2),
                    "quantity": _round_usd(r["total_qty"]),
                    "spend": _round_usd(r["total_spend"]),
                }
            )
        pmin_val = pmin
        export_rows: list[dict[str, Any]] = []
        for _, r in pr.iterrows():
            upv = float(r["unit_price"])
            qv = float(r["total_qty"])
            sav0 = max(0.0, (upv - pmin_val) * qv) if math.isfinite(upv) and math.isfinite(qv) else 0.0
            export_rows.append(
                {
                    "Item Number": pk,
                    "Supplier": str(r["supplier"]),
                    "Site": str(r["site"]),
                    "Unit Price": _round_usd(r["unit_price"]),
                    "Quantity": _round_usd(r["total_qty"]),
                    "Spend": _round_usd(r["total_spend"]),
                    "Savings": _round_usd(sav0),
                    "Category": "Category 2",
                }
            )
        out.append(
            {
                "harm_mece": 2,
                "item": f"{pk} · cross-site"[:200],
                "item_number": pk[:200],
                "display_site": disp_site,
                "display_supplier": disp_sup,
                "total_spend": int(round(tot_spend)),
                "total_quantity": int(round(tot_qty)),
                "price_gap_abs": _round_usd(pmax - pmin),
                "price_gap_pct": pct,
                "savings_subtitle": note,
                "has_price_variance": pmax > pmin + 1e-12,
                "lowest_supplier_site": low_s[:200],
                "highest_supplier_site": high_s[:200],
                "suppliers": sup_rows,
                "supplier_count": int(pr["supplier"].nunique()),
                "site_count": int(pr["site"].nunique()),
                "chart": {
                    "labels": labels,
                    "unit_prices": prices,
                    "bar_colors": colors,
                    "y_axis_label": "Unit price (USD / unit)",
                },
                "groups": groups_table,
                "export_rows": export_rows,
            }
        )
        taken += 1
    return out


def _build_cat3_opportunities(
    tagged: pd.DataFrame,
    base: pd.DataFrame,
    max_cards: int | None,
) -> list[dict[str, Any]]:
    """
    MECE category 3 at (item, supplier) grain. Chart: sites vs unit price.
    If max_cards is set, cap count; else all qualifying slices.
    """
    t = tagged[tagged["category"] == 3]
    if t.empty:
        return []
    gsum = t.groupby(["item", "supplier"], observed=True)["savings"].sum().sort_values(ascending=False)
    out: list[dict[str, Any]] = []
    taken = 0
    for (it, sup) in gsum.index:
        if max_cards is not None and taken >= max_cards:
            break
        try:
            sav_here = float(gsum.loc[(it, sup)])
        except Exception:
            sav_here = 0.0
        if sav_here < MIN_TOP5_SAVINGS_USD:
            continue
        it_s, sup_s = str(it).strip(), str(sup).strip()
        pk = it_s
        bpart = base[(base["item"].astype(str) == it_s) & (base["supplier"].astype(str) == sup_s)]
        if bpart.empty or bpart["site"].nunique() < 2:
            continue
        pr = bpart
        tot_spend = float(pr["total_spend"].sum()) if not pr.empty else 0.0
        tot_qty = float(pr["total_qty"].sum()) if not pr.empty else 0.0
        if not math.isfinite(tot_spend):
            tot_spend = 0.0
        if not math.isfinite(tot_qty):
            tot_qty = 0.0
        pmin = float(pr["unit_price"].min())
        pmax = float(pr["unit_price"].max())
        if not (math.isfinite(pmin) and math.isfinite(pmax)) or pmax <= pmin + 1e-12:
            continue
        if (pmax - pmin) > MAX_UNIT_PRICE_SPREAD_USD:
            continue
        pct, note0 = _format_note_pct_below(pmin, pmax)
        r_lo = pr.loc[pr["unit_price"].idxmin()]
        r_hi = pr.loc[pr["unit_price"].idxmax()]
        low_s = f"{str(r_lo['site'])[:50]} (low) · ${int(round(pmin))}"
        high_s = f"{str(r_hi['site'])[:50]} (high) · ${int(round(pmax))}"
        note = f"{note0} · {str(r_hi['site'])} vs {str(r_lo['site'])} (same supplier)"

        labels: list[str] = []
        prices: list[int] = []
        colors: list[str] = []
        for _, row in pr.sort_values("unit_price", ascending=True).iterrows():
            up = float(row["unit_price"])
            if not math.isfinite(up):
                continue
            site_str = str(row["site"])
            lab = f"{site_str[:60]}{'…' if len(site_str) > 60 else ''}"
            labels.append(lab[:100])
            prices.append(int(round(up)))
            is_m = up <= pmin + 1e-9 * (1.0 + abs(pmin))
            colors.append(_BAR_GREEN if is_m else _BAR_BLUE)
        if not labels:
            continue

        groups_table = [
            {
                "label": f"{str(r['supplier'])[:50]} - {str(r['site'])[:50]}",
                "qty": int(round(float(r["total_qty"]))),
            }
            for _, r in pr.iterrows()
        ]
        sup_rows: list[dict[str, Any]] = []
        for _, r in pr.sort_values("unit_price", ascending=True).iterrows():
            up2 = float(r["unit_price"])
            if not math.isfinite(up2):
                continue
            sup_rows.append(
                {
                    "supplier": str(r["supplier"])[:200],
                    "site": str(r["site"])[:200],
                    "unit_price": _round_usd(up2),
                    "quantity": _round_usd(r["total_qty"]),
                    "spend": _round_usd(r["total_spend"]),
                }
            )
        export_rows: list[dict[str, Any]] = []
        for _, r in pr.iterrows():
            upv = float(r["unit_price"])
            qv = float(r["total_qty"])
            sav0 = max(0.0, (upv - pmin) * qv) if math.isfinite(upv) and math.isfinite(qv) else 0.0
            export_rows.append(
                {
                    "Item Number": pk,
                    "Supplier": str(r["supplier"]),
                    "Site": str(r["site"]),
                    "Unit Price": _round_usd(r["unit_price"]),
                    "Quantity": _round_usd(r["total_qty"]),
                    "Spend": _round_usd(r["total_spend"]),
                    "Savings": _round_usd(sav0),
                    "Category": "Category 3",
                }
            )
        out.append(
            {
                "harm_mece": 3,
                "item": f"{pk} · {sup_s}"[:200],
                "total_spend": int(round(tot_spend)),
                "total_quantity": int(round(tot_qty)),
                "price_gap_abs": _round_usd(pmax - pmin),
                "price_gap_pct": pct,
                "savings_subtitle": note,
                "has_price_variance": pmax > pmin + 1e-12,
                "lowest_supplier_site": low_s[:200],
                "highest_supplier_site": high_s[:200],
                "suppliers": sup_rows,
                "site_count": int(pr["site"].nunique()),
                "chart": {
                    "labels": labels,
                    "unit_prices": prices,
                    "bar_colors": colors,
                    "y_axis_label": "Unit price (USD / unit)",
                },
                "groups": groups_table,
                "export_rows": export_rows,
            }
        )
        taken += 1
    return out


def _per_category_block(
    tagged: pd.DataFrame,
    category_id: int,
    title: str,
    base: pd.DataFrame,
) -> dict[str, Any]:
    t = tagged[tagged["category"] == category_id]
    spend_cat = float(t["total_spend"].sum()) if len(t) else 0.0
    sav = float(t["savings"].sum()) if len(t) else 0.0
    isum = _p80_savings_index(tagged, category_id)
    p80 = _parts_to_80(isum, sav) if sav > 0 and not t.empty else 0
    pct_v = (100.0 * sav / spend_cat) if spend_cat > 0 else None
    if category_id == 1:
        t5 = _build_cat1_opportunities(tagged, base, TOP_N)
    elif category_id == 2:
        t5 = _build_cat2_opportunities(tagged, base, TOP_N)
    else:
        t5 = _build_cat3_opportunities(tagged, base, TOP_N)

    return {
        "id": category_id,
        "title": title,
        "savings_usd": _round_usd(sav),
        "category_spend_usd": _round_usd(spend_cat),
        "parts_for_80_pct_value": int(p80),
        "pct_savings_vs_spend": None if pct_v is None else round(pct_v, 1),
        "top5": t5,
    }


def calculate_harmonization(df: pd.DataFrame) -> dict[str, Any]:
    if df is None or len(df) == 0:
        return _empty("empty_dataframe")

    pk = _part_col(list(df.columns))
    if not pk:
        return _empty("no_part_or_material_column")
    if pk not in df.columns:
        return _empty("no_part_or_material_column")

    n0 = len(df)
    part_col = df[pk].astype(str)
    valid_part_mask = part_col.str.contains(r"\d", na=False, regex=True) & part_col.str.strip().ne("")
    removed_count = n0 - int(valid_part_mask.sum())
    work = df.loc[valid_part_mask].copy()
    print(f"[harmonization] removed_invalid_parts={removed_count}", flush=True)
    if work is None or len(work) == 0:
        return _empty("no_valid_part_rows", part_key=pk, analysis_year=None)

    base, target_year, _sup, part_key = _build_base_table(work)
    if base is None or len(base) == 0:
        return _empty("no_rows_for_target_year", part_key=pk, analysis_year=target_year or None)

    base, removed_iqr_rows = _filter_base_iqr_outliers(base)
    print(f"[harm] iqr_outlier_rows_removed={removed_iqr_rows}", flush=True)

    if len(base) == 0:
        return _empty("no_rows_after_iqr_filter", part_key=pk, analysis_year=target_year or None)

    current_spend = float(base["total_spend"].sum())
    frag = _fragmented_parts_count(base)

    tagged, val, total_opp = _assign_mece(base)
    cat1_df = tagged[tagged["category"] == 1]
    cat3_df = tagged[tagged["category"] == 3]
    print(f"[harm] cat1_items={len(cat1_df)}", flush=True)
    print(f"[harm] cat3_items={len(cat3_df)}", flush=True)
    try:
        excluded_cat3_candidates = 0
        for (it, su), sub in base.groupby(["item", "supplier"], observed=True):
            if sub["site"].nunique() <= 1:
                continue
            tag_sub = tagged[
                (tagged["item"].astype(str) == str(it).strip())
                & (tagged["supplier"].astype(str) == str(su).strip())
            ]
            if tag_sub.empty:
                continue
            if not (tag_sub["category"] == 3).any():
                excluded_cat3_candidates += 1
        print(
            f"[harm][cat3-debug] item_supplier_pairs_multi_site_not_cat3_after_mece_order={excluded_cat3_candidates}",
            flush=True,
        )
    except Exception as _cat3_dbg_e:
        print(f"[harm][cat3-debug] skipped: {_cat3_dbg_e}", flush=True)
    if not cat3_df.empty and len(base) > 0:
        mns3: list[int] = []
        pair3 = cat3_df[["item", "supplier"]].drop_duplicates()
        for it0, su0 in zip(pair3["item"], pair3["supplier"]):
            subb = base[
                (base["item"].astype(str) == str(it0).strip()) & (base["supplier"].astype(str) == str(su0).strip())
            ]
            mns3.append(int(subb["site"].nunique()))
        print(f"[harm] cat3_multi_site_check={int(min(mns3)) if mns3 else 0}", flush=True)
    else:
        print("[harm] cat3_multi_site_check=0", flush=True)
    if not val["sum_matches_base"]:
        wmsg = (
            f"[harmonization] WARNING: row count mismatch. base={len(base)} "
            f"cat1={val['category_1_rows']} cat2={val['category_2_rows']} cat3={val['category_3_rows']} "
            f"none={val['no_opportunity_rows']}"
        )
        print(wmsg, flush=True)
        print(wmsg, file=sys.stderr, flush=True)
    else:
        msg = (
            f"[harmonization] year={target_year} base_rows={len(base)} "
            f"cat1={val['category_1_rows']} cat2={val['category_2_rows']} "
            f"cat3={val['category_3_rows']} no_opp={val['no_opportunity_rows']} total_savings={total_opp:.2f} fragmented_parts={frag}"
        )
        print(msg, flush=True)
        print(msg, file=sys.stderr, flush=True)

    all_item_sav = (
        tagged[tagged["category"].isin([1, 2, 3])]
        .groupby("item", observed=True)["savings"]
        .sum()
        .sort_values(ascending=False)
    )
    p80_all = _parts_to_80(all_item_sav, total_opp) if total_opp > 0 else 0
    pct_spend = (100.0 * total_opp / current_spend) if current_spend > 0 else None

    cat_defs: list[tuple[int, str]] = [
        (1, "Same site, different suppliers (unit price spread)"),
        (2, "Different supplier, different plant (cross-site price spread)"),
        (3, "Same supplier, different sites (unit price spread)"),
    ]

    categories = [_per_category_block(tagged, cid, title, base) for cid, title in cat_defs]

    cat1_all = _build_cat1_opportunities(tagged, base, None)
    cat2_all = _build_cat2_opportunities(tagged, base, None)
    cat3_all = _build_cat3_opportunities(tagged, base, None)
    print(
        f"[harm] category_1_opportunities={len(cat1_all)} category_2_opportunities={len(cat2_all)} "
        f"category_3_opportunities={len(cat3_all)}",
        flush=True,
    )

    return {
        "v": JSON_VERSION,
        "message": "ok",
        "year": int(target_year),
        "analysis_year": int(target_year),
        "part_key": part_key,
        "parts_analyzed": int(base["item"].nunique()),
        "base_table_row_count": int(len(base)),
        "current_year_spend_usd": _round_usd(current_spend),
        "total_opportunity_usd": int(round(max(0.0, total_opp))),
        "total_opportunity_float": _round_usd(max(0.0, total_opp)),
        "price_fragmented_parts_count": frag,
        "parts_for_80_pct_value": int(p80_all),
        "pct_savings_vs_spend": None if pct_spend is None else round(pct_spend, 1),
        "validation": val,
        "categories": categories,
        "category_1": cat1_all,
        "category_2": cat2_all,
        "category_3": cat3_all,
        "top_5": (categories[0].get("top5") or [])[:TOP_N] if categories else [],
        "top_10": [],
        "harmonization_meta": {
            "max_unit_price_spread_usd": MAX_UNIT_PRICE_SPREAD_USD,
            "min_top5_savings_usd": MIN_TOP5_SAVINGS_USD,
            "calculation_notes": HARMONIZATION_CALCULATION_NOTES,
            "outlier_method": "iqr_tukey_rows",
            "iqr_multiplier": 3.0,
            "iqr_outlier_rows_removed": int(removed_iqr_rows),
        },
    }
