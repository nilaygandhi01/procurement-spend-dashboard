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

For each (part, period) bucket the dashboard computes a per-period unit
price under one of three **weighting methods**, controlled by the
Weighting picker in the IA tab. **Default = `qty`.**

| Method  | UI label                | Formula                                                | Matches Excel                                                |
|---------|-------------------------|--------------------------------------------------------|--------------------------------------------------------------|
| `qty`   | Qty-weighted (default)  | `Σ spend / Σ qty`                                      | `AVERAGEIFS(spend, …) / AVERAGEIFS(qty, …)`                  |
| `spend` | Spend-weighted          | `Σ(unit_price × spend) / Σ spend`                      | `SUMPRODUCT(unit_price, spend) / SUM(spend)` over the window |
| `simple`| Simple mean             | `mean(unit_price)` over rows                           | `AVERAGEIFS(unit_price, …)`                                  |

`qty` is the only method that ties to total spend, which is what we want
for a price index. `spend` and `simple` exist for one reason: when an
external Excel reference disagrees with the dashboard, the Weighting picker
lets you prove which method the Excel author actually used. The
**Validation panel** (§10) wires this directly into the diff.

The unit tests `WEIGHTING.QTY matches Σspend/Σqty …`,
`WEIGHTING.SPEND uses spend as the weight, not quantity`, and
`WEIGHTING.SIMPLE returns mean of per-row unit prices` lock in the
distinct behavior of all three.

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

## 6. Multi-part display rule & aggregation methods

When the user selects N parts, the chart's default behavior is to render
**N independent lines** — one per part, each rebased to its own baseline.
This is the `Aggregation = Per-part lines` setting.

If the user picks any of the three **basket-aggregation methods**, the
per-part lines are hidden and a single black aggregate line is drawn instead
(with PPI series still overlaid). The three methods produce mathematically
different numbers — picking the right one matters.

| Method      | Formula (per period)                                                            | When you'd use it                                                                                       |
|-------------|----------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| `laspeyres` | `Σ_part [ part_index(period) × baseSpend(part) ] / Σ_part baseSpend(part)`       | "How much would the same basket cost today vs. the baseline?" Fixed weights from baseline period.       |
| `simple`    | `mean(part_index(period))` over contributing parts                               | Each part gets equal voice — useful for spotting which parts moved without spend bias.                  |
| `pooled`    | `(Σ_part spend(period) / Σ_part qty(period)) / pooled_price(baseline) × 100`     | "Treat the basket as one big part." Index moves with both price *and* mix shift across periods.         |

The default is `Per-part lines` (no aggregation), preserving the original
display. The chart subtitle and the "ⓘ Method" popover document which
method is active.

**Excluded parts** (those without baseline data) contribute weight zero
to Laspeyres and aren't counted by Simple-mean; the Totals section reports
how many parts were excluded and why.

The unit tests `aggregateLaspeyres uses base-period spend as fixed weight`,
`aggregateSimpleMean is the arithmetic mean — visibly different from Laspeyres`,
and `aggregatePooledReweighted treats the basket as one big part` lock these in.

---

## 7. PPI series in Quarterly mode

The built-in PPI series — currently `WPU10` Metals & Metal Products,
`PCU332332` Fabricated Metal Products, `PCU3339133391` Pump & Compressor
Manufacturing, `PCU333996333996` Semiconductor (sample), `WPU1017` Steel
Mill Products, `WPU114301` Engines & Parts (sample), and `WPU11430119`
Diesel Engines (sample) — are loaded as **yearly** averages.
There is no quarterly PPI data in this dashboard.

**Adding a new PPI series.** Drop a new BLS workbook (FRED-export style or
sparse-sample shape — both layouts are detected) into
`data/inputs/indexes/`, then run:

```
py scripts/build-builtin-index-pack.py --write   # regenerates data/inputs/index-data/generated-index-pack.json
py scripts/inline-index-math.py                  # re-inlines the math module into index.html
```

The next build picks up the new code in `IDP_BUILTIN_INDEX_CODES` and a
checkbox appears in the Indexes panel automatically (no HTML edits).

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

## 9. Date-range presets

The Display window section above the chart includes one-click presets that
compute start/end period keys from the dataset's latest available period:

| Preset           | Yearly mode                | Quarterly mode                                    |
|------------------|----------------------------|---------------------------------------------------|
| `Last 4Q`        | Latest year only           | Last 4 quarters available                         |
| `Last 8Q`        | Last 2 years               | Last 8 quarters available                         |
| `YTD`            | Latest year only           | Latest year, Q1 through latest available quarter  |
| `Trailing 24M`   | Last 2 years               | Last 8 quarters (same as Last 8Q)                 |
| `All`            | No bounds                  | No bounds                                         |

All presets respect the baseline-lock rule — they shift the display window
only, not the indexing math.

---

## 10. Validation panel (Excel-diff)

The Validation panel sits below the chart. Paste an Excel pivot (wide or
long format) into the textarea and click **Run diff**.

**Accepted layouts:**

```
# Wide (header row = periods):
PartNumber<TAB>2024<TAB>2025<TAB>2026
ABC-001<TAB>100<TAB>108.2<TAB>112.4

# Long (3 columns):
Part<TAB>Period<TAB>Index
ABC-001<TAB>2024<TAB>100
ABC-001<TAB>2025<TAB>108.2
```

Separators auto-detect: TAB > comma > 2+ spaces > single space. Period
labels normalize from `2024`, `2024-Q1`, `2024 Q1`, `Q1 2024`, or `Q1-24`.

**What the diff does:**

1. Parses the paste into `{ partKey: { periodKey: value } }`.
2. Matches each pasted part number to the dashboard's part dictionary using
   the same canonicalization rule as Single-Source (case-insensitive,
   leading-zero-tolerant for all-numeric parts).
3. For every matched part, computes the dashboard's indexed series at the
   **currently-active granularity, baseline, AND weighting method**
   (so toggling the Weighting picker shows you exactly which method matches
   Excel).
4. Calls `diffPartIndexes` to produce a row-level report with delta,
   percent delta, and a status flag (`match` / `fail` / `missing-dashboard`
   / `missing-reference`). The default tolerance is **0.5 index points**
   and is editable in the UI.
5. Surfaces the underlying inputs (`Σspend`, `Σqty`, row count) next to
   every fail row so you can see *why* the calculation diverged — usually
   it's a row-count gap (Excel was filtered, dashboard wasn't) or a
   weighting-method mismatch.

The summary tiles show: rows compared, matched within tolerance, failed,
missing on each side, plus max absolute delta and max absolute percent
delta.

PPI series are excluded from the diff — they're indexed from external
yearly data, not from the spend rows.

---

## 11. Totals tiles & detail table

Two read-only panels sit under the chart and read from the same `frame`
object the chart just drew from. This guarantees their numbers can never
drift from what's plotted.

**Totals tiles** — one tile per visible period:

- **Spend** total + period-over-period delta (vs. baseline) in `$` and `%`.
- **Quantity** total + delta.
- **Aggregate index** (whatever the active aggregation method produced; the
  baseline tile always reads `100`).
- Meta line: parts in scope, parts with valid baseline, **baseline-period
  spend coverage %** (= included base spend / total selected-parts base
  spend), and weighting method.
- Excluded parts are surfaced in a click-to-expand list with the reason
  (no spend in baseline / baseline price non-finite).

**Detail table** — one row per chart-selected part, columns:

- Part #, Description
- For each visible period: `index`, `spend`, `qty`

Behavior:

- Sticky header; click any column to sort. Default sort = latest period's
  spend descending.
- Text filter narrows visible rows by part number or description.
- Click a row to toggle that part in/out of the chart.
- **Export CSV** button downloads the current table view.

Missing values render as `—` (never `0` or `NaN`).

---

## 12. Saved views

The Saved-views panel persists the full IA tab state per browser
(`localStorage` key `idp_ia_saved_views_v1`). One view captures:

```
{
  partKeys: ["ABC-001", ...],   // part-number strings, resolved at load time
  indexCodes: ["WPU10", ...],   // PPI series checkbox state
  granularity: "yearly"|"quarterly",
  baseline:    "2024"|"2024-Q1",
  weighting:   "qty"|"spend"|"simple",
  aggregation: "none"|"laspeyres"|"simple"|"pooled",
  window:      { start: "...", end: "..." }
}
```

- **Save as / Overwrite / Rename / Delete** operate on the currently-loaded
  view.
- **Set default** marks the view to auto-load whenever the IA tab opens.
- **Copy share link** base64-encodes the snapshot into `?iaView=` so a
  teammate opening the link sees the same chart (subject to their browser
  having access to the same dataset).
- **Export / Import JSON** round-trip the whole set across browsers.

When loading, any part that no longer exists in the current dataset is
**reported as a warning** under the panel — never silently dropped from the
selection.

---

## 13. File map

| File                                       | Purpose                                              |
|--------------------------------------------|------------------------------------------------------|
| `src/dashboard/index-math.mjs`             | Pure ES module — all math defined here               |
| `src/dashboard/index.html`                 | UI controls, chart wiring, calls into the module     |
| `scripts/tests/index-math.test.mjs`        | `node --test` suite locking in the math              |
| `scripts/run-tests.ps1` / `run-tests.sh`   | Convenience runners                                  |
| `INDEX_METHODOLOGY.md` (this file)         | Human-readable spec                                  |
