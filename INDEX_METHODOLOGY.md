# Index Analysis — Methodology

Reference doc for the **Index Analysis** tab of the procurement spend dashboard.
This is the source of truth for what the chart math does. The same definitions
are pinned by unit tests in `scripts/tests/index-math.test.mjs` and implemented
by the pure ES module at `src/dashboard/index-math.mjs`.

> The chart on the IA tab links here so users can verify what they're seeing.

---

## 1. Period bucketing

Every row of spend data has an invoice/transaction date. We bucket those rows
into **periods** before doing any indexing.

| Granularity | Period keys                     | Bucketing rule                                          |
|-------------|---------------------------------|---------------------------------------------------------|
| Yearly      | `"2024"`, `"2025"`, `"2026"`    | All rows with the same calendar year                    |
| Quarterly   | `"2024-Q1"` … `"2026-Q4"`       | Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec |

Quarter assignment is **half-open by construction**: a row dated `2024-04-01`
lands in Q2, never in Q1. This mirrors the Excel `AVERAGEIFS` pattern with
the exclusive upper bound:

```
=AVERAGEIFS(unit_price, date, ">="&DATE(2024,4,1), date, "<"&DATE(2024,7,1))
```

The unit test `quarter boundary is half-open` locks this in.

---

## 2. Weighted-average unit price (the price metric being indexed)

For each (part, period) bucket the dashboard computes the **volume-weighted
unit price**:

```
weighted_unit_price(part, period) = Σ spend  /  Σ qty
                                    over all rows where row.part = part
                                    and row.period = period
```

This is **not** a simple average of per-row unit prices. With unequal
quantities the two metrics give different answers; the weighted average is
the one that ties to total spend, which is what we want for an index. Excel
users get the same number by writing
`= AVERAGEIFS(spend, ...) / AVERAGEIFS(qty, ...)` rather than
`= AVERAGEIFS(unit_price, ...)`.

The unit test `weighted average differs from simple average for unequal qty`
locks this in.

---

## 3. Baseline (= 100)

The chart supports two baselines:

| Setting          | Baseline period key | Meaning                                              |
|------------------|---------------------|------------------------------------------------------|
| FY 2024 = 100    | `"2024"`            | The volume-weighted unit price across all of 2024    |
| Q1 2024 = 100    | `"2024-Q1"`         | The volume-weighted unit price across Jan–Mar 2024   |

**Rebasing formula** (applied per part):

```
index(period) = weighted_unit_price(period) / weighted_unit_price(baseline) × 100
```

By definition `index(baseline) = 100`.

**Q1 vs. FY interaction with granularity.** Q1 2024 baseline only makes
sense in Quarterly mode (you can't index against a quarter when the axis is
years). When the user picks Q1 2024 but the granularity is Yearly, the chart
silently falls back to FY 2024 and surfaces that in the active-config note
under the controls. The radio is not flipped — the user's preference is
remembered for when they switch to Quarterly.

---

## 4. Baseline lock vs. display window  (the most important rule)

The IA tab has a **display window** (Start period → End period). It is a
**render-time filter only.** It does *not* feed into the indexing math.

Concretely, for each part:

1. The dashboard collects **every** row that matches the part + the global
   Spend Review *facet* filters (BU, c1–c4, supplier, RAP category, etc.).
   The global Spend Review *time* filter is intentionally ignored here.
2. Those rows are bucketed by period, weighted-averaged, and rebased to the
   baseline period using the **full** map. This yields
   `{ "2024": 100, "2024-Q1": 100, "2025": …, "2025-Q2": …, … }`.
3. Only then does the chart drop period keys outside the display window
   before drawing.

This guarantees:

- Narrowing the display window to `2025 Q3 → 2026 Q1` **does not** change
  the index value at `2025 Q3` — it's still computed against the same
  baseline.
- If the user picks a window that excludes the baseline period, the
  baseline point doesn't render on the chart, but every other point is still
  100×(weighted/baseline). The numbers don't drift.

The unit test `display window does not affect baseline math` locks this in.

---

## 5. Partial-period handling

A period bucket emits a value as long as **Σqty > 0** within it. We do not
require:

- a minimum number of transactions
- all 3 months of a quarter to be populated
- any specific suppliers / shipment patterns

This matches Excel `AVERAGEIFS`, which simply averages whatever rows fall
inside the date window — and is honest about the data we actually have.
The trade-off is that quarters with very sparse data still render a point;
users can hover the tooltip to see the underlying weighted price.

A row is excluded entirely if any of these are true:

- `qty <= 0`, `qty` non-finite, or missing
- `spend` non-finite (zero spend with positive qty *is* allowed and pulls
  the weighted-average toward zero — that's the actual procurement reality
  of free samples, returns, etc.)
- year < 1990 or > 2100 (defensive guard against garbage dates)
- the row's facet values don't match the global Spend Review filters

The unit test `quarter emits when only some months have data` locks the
sparse-bucket behavior in.

---

## 6. Multi-part display rule

When the user selects N parts, the chart renders **N independent lines** —
one per part, each rebased to its own baseline. There is **no basket
aggregation**.

What that means in practice:

- The chart shows price-index trajectories *side by side*, not a portfolio
  index.
- It is intentional that two parts can both read 100 at the baseline and
  cross/diverge afterwards — the chart is showing how each part moved
  relative to itself, not relative to the basket.
- Users who want a basket-level index can export to Excel and compute
  `Σ_all_parts spend / Σ_all_parts qty` per period externally.

The chart subtitle and methodology link make this rule visible to anyone
reading the chart without context.

---

## 7. PPI series in Quarterly mode

The built-in PPI series (currently `WPU10` Metals & Metal Products and
`PCU332332` Fabricated Metal Products) are loaded as **yearly** averages.
There is no quarterly PPI data in this dashboard.

In Quarterly mode, each year's yearly PPI value is replicated across that
year's 4 quarters (a flat step). The chart annotates these lines as
`PPI (CODE, yearly→Q step)` in the legend, and Chart.js renders them with
`stepped: "before"` so the visual cue is clear.

The PPI baseline is always FY 2024 — even when the user picks Q1 2024 for
the part lines — because there is no Q1 2024 PPI value to rebase against.
The active-config note documents this when the two baselines are in play
together.

---

## 8. Date-range conventions (reference)

Across the dashboard and Excel, we standardize on **inclusive start,
exclusive end** for time-range filters:

| Convention           | Excel form                                                    |
|----------------------|---------------------------------------------------------------|
| `>= start_inclusive` | `date >= DATE(2024,1,1)`                                      |
| `< end_exclusive`    | `date < DATE(2024,4,1)`                                       |
| Combined             | `AVERAGEIFS(value, date, ">="&DATE(2024,1,1), date, "<"&DATE(2024,4,1))` |

This avoids the classic off-by-one error of double-counting the first day of
the next period. The half-open quarter bucketing described in §1 is the same
convention applied period-wise.

`isInHalfOpenRange(periodKey, startKey, endKeyExclusive)` in
`src/dashboard/index-math.mjs` is the canonical implementation; the unit
test `isInHalfOpenRange treats end as exclusive` pins it down.

The chart's display window selectors are **inclusive on both ends** because
that matches user UX expectations ("show me 2025 Q1 through 2026 Q1, both
inclusive"). That's a separate concept from the bucketing rule — the chart
doesn't bucket anything at render time, it just picks which already-bucketed
period keys to draw.

---

## 9. File map

| File                                       | Purpose                                              |
|--------------------------------------------|------------------------------------------------------|
| `src/dashboard/index-math.mjs`             | Pure ES module — all math defined here               |
| `src/dashboard/index.html`                 | UI controls, chart wiring, calls into the module     |
| `scripts/tests/index-math.test.mjs`        | `node --test` suite locking in the math              |
| `scripts/run-tests.ps1` / `run-tests.sh`   | Convenience runners                                  |
| `INDEX_METHODOLOGY.md` (this file)         | Human-readable spec                                  |
