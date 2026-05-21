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
price using **volume-weighted (Σspend ÷ Σqty)**. This is the only method
that ties to total spend, which is what we want for a price index, and is
the only method that matches Excel's `AVERAGEIFS(spend, …) / AVERAGEIFS(qty, …)`
pattern.

```
weighted_unit_price(period) = Σ spend / Σ qty   (rows in the period bucket)
```

There is **no user-facing Weighting picker** — this is a permanent default
of the dashboard.

The `WEIGHTING` constant in `src/dashboard/index-math.mjs` still defines two
other methods (`spend`, `simple`) for historical reasons and so the math
module's contract stays stable; the dashboard never passes anything except
the default `qty` value. The unit test
`WEIGHTING.QTY matches Σspend/Σqty …` is the one that locks in the live
behavior.

---

## 3. Baseline (= 100) — auto-derived from granularity

The chart baseline is auto-locked from the active granularity:

| Granularity | Baseline period key | Label rendered in the subtitle |
|-------------|---------------------|--------------------------------|
| Yearly      | `"2024"`            | `FY 2024 = 100`                |
| Quarterly   | `"2024-Q1"`         | `Q1 2024 = 100`                |

There is **no user-facing Baseline picker** — toggling Granularity swaps
the baseline automatically.

**Rebasing formula** (applied per part):

```
index(period) = weighted_unit_price(period) / weighted_unit_price(baseline) × 100
```

By definition `index(baseline) = 100`.

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

When the user selects N parts, the chart **always** shows:

- **N per-part lines** — one per part, each rebased to its own baseline.
- **One bold aggregate overlay** computed via Laspeyres (spend-weighted by
  base-period spend), drawn on top of the per-part lines whenever N ≥ 2.
  For a single-part selection the aggregate equals that part's own line,
  so it's skipped.

There is **no user-facing Aggregation picker** — Laspeyres is the only
method shown, baked in as the default.

```
agg_index(period) = Σ_part [ part_index(period) × baseSpend(part) ] / Σ_part baseSpend(part)
```

Weights are computed **once** from the baseline period and held constant
for every other period. Parts with no baseline data contribute weight 0
and are therefore silently dropped from the aggregate (their per-part
line still renders if the rebase succeeded against a non-baseline
period).

The `AGGREGATION` constant in `src/dashboard/index-math.mjs` still defines
`simple` (arithmetic mean of per-part indexes) and `pooled` (Σspend/Σqty
across the basket re-indexed) for historical reasons; the dashboard never
calls them. The unit tests
`aggregateLaspeyres uses base-period spend as fixed weight`,
`aggregateSimpleMean is the arithmetic mean — visibly different from Laspeyres`,
and `aggregatePooledReweighted treats the basket as one big part` keep all
three locked in.

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

The PPI baseline is always FY 2024 — even in Quarterly mode where the
spend lines rebase to Q1 2024 — because there is no Q1 2024 PPI value to
rebase against. The chart subtitle documents this.

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

## 10. Detail table

The Detail-table panel below the chart reads from the same `frame` object
the chart just drew from. This guarantees its numbers can never drift from
what's plotted.

One row per chart-selected part, columns:

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

## 11. Saved views

The Saved-views panel persists the IA tab state per browser
(`localStorage` key `idp_ia_saved_views_v1`). One view captures:

```
{
  partKeys: ["ABC-001", ...],   // part-number strings, resolved at load time
  indexCodes: ["WPU10", ...],   // PPI series checkbox state
  granularity: "yearly"|"quarterly",
  window:      { start: "...", end: "..." }
}
```

Baseline, weighting, and aggregation are no longer user-controlled, so the
snapshot doesn't capture them.

The UI exposes only:

- A **Save current view** button — prompts for a name and saves.
- A list of saved views as pills — click a name to load, click the `×`
  to delete.

Rename, overwrite, default-view, share-link, and JSON import/export were
removed in the May 2026 simplification — too many knobs for too little use.

When loading, any part that no longer exists in the current dataset is
**reported as a warning** under the panel — never silently dropped from the
selection.

---

## 12. File map

| File                                       | Purpose                                              |
|--------------------------------------------|------------------------------------------------------|
| `src/dashboard/index-math.mjs`             | Pure ES module — all math defined here               |
| `src/dashboard/index.html`                 | UI controls, chart wiring, calls into the module     |
| `scripts/tests/index-math.test.mjs`        | `node --test` suite locking in the math              |
| `scripts/run-tests.ps1` / `run-tests.sh`   | Convenience runners                                  |
| `INDEX_METHODOLOGY.md` (this file)         | Human-readable spec                                  |

---

## 13. Harmonization → Index Opportunity tab

A second tab on the Harmonization page surfaces parts whose 2024→2025
weighted-average unit-price growth **outpaced both selected PPI indexes**.
It mirrors the visual structure of the existing Harmonization Summary
view (overall tile strip + three archetype sections, each with the same
five KPI tiles and a lazy detail table) but the definition of an
"opportunity" is PPI-relative, not supplier/plant-relative.

### 13a. User flow

1. The user picks **exactly two** PPI indexes from the picker at the top
   of the tab (any code from `IDP_BUILTIN_INDEX_CODES` whose `rawByYear`
   map contains both 2024 and 2025).
2. The dashboard computes each index's 2024→2025 growth %, picks the
   smaller as the **LOW target** (most aggressive — "your prices should
   have grown at most this slowly") and the larger as the **HIGH target**
   (conservative floor). Ties break alphabetically by code so the
   assignment is deterministic.
3. The tab then renders three archetype sections — **US**, **China**,
   **Rest of World** — split by the SpendCube's Cummins Country column
   (`Cummins_Country` / `Cummins Country` / `CMI Country`).
4. A combined "All archetypes" KPI strip sits above the three sections.

### 13b. Math (per part+site bucket)

```
priceLow   = Σspend_2024  / Σqty_2024           (NaN if qty_2024 ≤ 0)
priceHigh  = Σspend_2025  / Σqty_2025           (NaN if qty_2025 ≤ 0)
growthPct  = (priceHigh / priceLow − 1) × 100   (NaN if either price ≤ 0)

qualifies  = growthPct > lowTargetPct
lowSavings  = qualifies ? spend_2025 × max(0, (growthPct − lowTargetPct ) / 100) : 0
highSavings = qualifies ? spend_2025 × max(0, (growthPct − highTargetPct) / 100) : 0
```

`lowSavings ≥ highSavings` by construction. `highSavings` can be 0 even
when `qualifies = true` (a part that beat the LOW target but stayed
under the HIGH target). Both savings numbers are **floored at 0** — a
part never contributes negative savings to a rollup.

### 13c. Archetype rollup (per US / China / RoW and overall)

```
Total Opportunities  = count of qualifying parts
Total Savings        = Σ lowSavings              ← headline (aggressive)
Total Spend          = Σ spend_2025
Avg Savings %        = 100 × Total Savings / Total Spend (spend-weighted; 0 if no spend)
Parts for 80% Value  = count of qualifying parts (sorted by lowSavings desc)
                       needed to reach 80% of Total Savings
```

`Total Savings` shown on tiles is the **aggressive** (LOW target) number
because that's what stakeholders ask for. `highSavings` is still
recorded per row in the detail table and the Excel export for anyone
who wants the conservative floor.

### 13d. Cummins Country → archetype classification

```
US     : "US", "U.S.", "U.S.A.", "USA", "United States", "United States of America"
China  : "China", "P.R. China", "PRC", "People's Republic of China", "Mainland China"
RoW    : anything else (including blank / null)
```

Matching is case-insensitive and uses the row's most representative
Cummins Country value — picked as the country attached to the largest
single qty row for that part+site, so a one-off shipment in a different
country doesn't misclassify a part.

### 13e. Adding a new PPI series

Drop a new BLS workbook (FRED-export style or sparse-sample shape — both
layouts are detected) into `data/inputs/indexes/`, then run:

```
py scripts/build-builtin-index-pack.py --write   # regenerates data/inputs/index-data/generated-index-pack.json
py scripts/inline-index-math.py                  # re-inlines the math module + new pack into index.html
```

The new code is automatically picked up by:

- the **Index Analysis** tab (chart),
- the **Index Opportunity** picker on the Harmonization tab,
- the validation tests in `scripts/tests/index-math.test.mjs`.

### 13f. Quarterly view: flat-step expansion

PPI raw data is published yearly. When the IA tab is in **Quarterly**
view, each year's index value is flat-stepped across its 4 quarters
(Q1..Q4 of year Y all share the yearly Y value). This is implemented in
`expandYearlyToQuarterly()` and documented inline in `index-math.mjs`.
The Index Opportunity tab does not have a granularity toggle — it's
always 2024→2025 yearly per spec.

### 13g. Per-part drill-down ("View details")

Each row in an archetype's detail table has a **View details** link that
opens an inline drill-down (same UX pattern as the existing
Harmonization tab — a hidden `<tr>` below the main row that toggles
.hidden on click). The drill-down has three components:

**1. KPI strip — three cards** (matches the harmonization
detail layout):

```
2025 SPEND          = spend_2025
2025 VOLUME         = qty_2025
POTENTIAL SAVINGS   = lowSavings  (sub-text: "% of current spend")
```

**2. Line chart — two x-points (2024, 2025), three lines:**

| Line | 2024 value | 2025 value | Style |
|---|---|---|---|
| Actual unit price          | `priceLow`  | `priceHigh`                          | Solid, orange (`#F07F00`) |
| `<lowCode>` benchmark     | `priceLow`  | `priceLow × (1 + lowTargetPct/100)`  | Dashed, green (`#10B981`) |
| `<highCode>` benchmark    | `priceLow`  | `priceLow × (1 + highTargetPct/100)` | Dashed, amber (`#D97706`) |

All three lines anchor at the same 2024 price so the 2025 fan-out
visually shows where the part went vs. where each benchmark "would have
let it go". Y-axis is dollars. Legend at the bottom shows each line's
growth %.

**3. Detail table — two rows × eight columns:**

```
Year | Qty | Unit price | Spend | Low bench $/unit | High bench $/unit | Savings vs low | Savings vs high
2024 | …   | priceLow   | spnd  | priceLow         | priceLow          | 0              | 0
2025 | …   | priceHigh  | spnd  | priceLow × (1+L) | priceLow × (1+H)  | spnd − qty25 × lowBench25 | spnd − qty25 × highBench25
```

A positive **Savings vs benchmark** means the part outpaced the
benchmark (real opportunity). A negative value means the part beat the
benchmark (no opportunity for *this* row — possible when the 2025 spend
came in under what the benchmark would have allowed). The drill-down
table reports the raw signed number rather than flooring at 0, so the
direction is visible — the floor-at-0 logic is reserved for the rollup
math in `partCaptureSavings()`.

**Why the drill-down savings differ from the rollup savings**

The rollup uses `spendHigh × (growthPct − target)/100` (a single
multiplicative formula). The drill-down uses `spend_2025 − qty_2025 ×
benchmark_25` (a "what would the spend have been if the price followed
the benchmark" formula).

For a part where the 2025 quantity ratio matches the 2024-derived
price-growth assumption (the common case), these match. They diverge
when the 2025 quantity is materially different from the implicit
quantity that the rollup formula assumes — which is intentional. The
rollup formula is the "capture % of 2025 spend" headline number; the
drill-down formula is the "what would 2025 spend have been at the
benchmark price" decomposition. Both are honest; they answer slightly
different questions.

### 13h. Implementation pointers

| Concern | Where |
|---|---|
| Math primitives (pure, unit-tested)        | `src/dashboard/index-math.mjs` (§ "Index Opportunity math") |
| Tests                                       | `scripts/tests/index-math.test.mjs` (last block) |
| Tab UI                                      | `src/dashboard/index.html` → `<div id="harm-pane-index-opp">` |
| Tab JS (cache, render, export)              | `src/dashboard/index.html` → "HARMONIZATION → INDEX OPPORTUNITY TAB" |
| Part-level growth cache (one rebuild per data load) | `idpIoBuildPartCache()` |
| Archetype derivation (one re-derive per index pick) | `idpIoDeriveOpportunities()` |
| Per-part drill-down rows                    | `partDrilldownRows(part, lowT, highT)` (math) / `idpIoBuildDrilldownCell()` (UI) / `idpIoRenderDrilldownChart()` (Chart.js) |
| Excel export                                | `ioExportAllIndexOpportunities()` |
