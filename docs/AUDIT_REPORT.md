# Dashboard Code Audit Report

**Scope:** `Cummins_IDP_Dashboard.html` (inline script + markup), `harmonization-client.js` (referenced at line ~1672), `index.html` (redirect only).  
**Method:** `rg` / `grep` for definitions and references; heuristic: symbol appears only on its `function name(` line → **high** unused risk. Dynamic calls (`eval`, bracket notation), HTML `onclick` strings, and `window.*` exports were checked where noted.  
**Date:** 2026-05-12  

**Policy applied:** Per project rules (**zero functionality / design / breaking changes**), this audit **does not remove** any code. Treat every “unused” item as **candidate** until a human confirms no dynamic use and runs full regression.

---

## Summary

| Metric | Value |
|--------|--------|
| Unique `function name(` definitions in `Cummins_IDP_Dashboard.html` | **402** (automated count) |
| Symbols with **exactly one** `\\bname\\b` match (definition only) — **high-risk unused candidates** | **17** |
| Symbols with **two** matches (typical: definition + single call) — **not** auto-marked unused | Many (e.g. `renderAllCharts`) |
| `console.*(` occurrences in dashboard HTML | **57** |
| `window.alert(` | **6** |
| `if (false)` dead branches | **0** found |
| `harmonization-client.js` | Separate IIFE module; consumed by dashboard harmonization paths (do not assume unused) |

---

## High Confidence Unused (no second reference found)

Each of the following appears **only** as its `function …` definition line in `Cummins_IDP_Dashboard.html` (no other `functionName` token). Re-verify before deletion: HTML event attributes, `addEventListener` with string lookup, or future hooks.

| # | Function | Notes |
|---|----------|--------|
| 1 | `activeFilterCount` | Defined; never called — possible dead KPI/filter badge helper. |
| 2 | `aggrBy` | **Duplicate pattern:** `aggrBySplit` is used everywhere for Direct/Indirect; plain `aggrBy` never referenced. |
| 3 | `aggregateTopCategoriesForOverview` | **Duplicate pattern:** `aggregateTopCategoriesForOverviewSplit` is the variant in use. |
| 4 | `chartDatalabelsCategoryGrouped` | Non-horizontal datalabels helper; charts use `chartDatalabelsCategoryGroupedHorizontal` / stacked total helpers instead. |
| 5 | `fmtBnSpend` | Billion formatter; no references. |
| 6 | `fmtHarmSupplierRowUnitPrice` | No references. |
| 7 | `fmtPctOne` | No references. |
| 8 | `fmtPtd` | Quarter-to-date KPI string; no references (`fmtYtdKpi` / other KPI paths used). |
| 9 | `getFilteredOverviewData` | No references (`getFiltered` / `getFilteredHarmonization` used). |
| 10 | `getMulti2` | Legacy multi-select helper; no references. |
| 11 | `getRowsForHarmonizationSpendKind` | No references. |
| 12 | `kpiPtdPctsFromIdx` | No references (YTD path `kpiYtdPctsFromIdx` is used). |
| 13 | `onYmManualChange` | No references — time panel may use other handlers; **do not remove** without tracing all `f-ym0` / `f-ym1` wiring. |
| 14 | `quarterLabelFromYmStr` | No references. |
| 15 | `quarterToSortKey` | No references (`yqSortKey` used in KPI logic). |
| 16 | `topNFromMap` | **Duplicate pattern:** `topNFromSplit` used for overview tops. |
| 17 | `wireSpendFileButton` | Never invoked. **`handleSpendFileInput` is only attached inside this function** — and there are **no** DOM nodes in this file with `id="spend-file-input"` or `id="btn-load-spend-file"`. So the **manual JSON file upload path appears fully unwired** in current HTML. **Risk: MEDIUM** — removing would not change today’s UI if those IDs never exist; restoring upload would require calling `wireSpendFileButton()` from boot and adding hidden file UI. |

---

## Medium Confidence / Review Needed

- **Count == 2:** Many functions appear exactly twice (definition + single call site). These are **used**, not unused — the automated “MEDIUM” bucket from a one-off script listed false positives (e.g. `renderAllCharts`).
- **Possible dynamic use:** Any name that also appears inside quoted strings (e.g. diagnostic or `data-*` attributes) needs manual `rg \"functionName\"` before removal.
- **`onYmManualChange`:** Even with zero references, behavior may duplicate inline lambdas — treat as **review**, not delete.

---

## Duplicate Code (document only — do not consolidate without tests)

| Pair | Relationship |
|------|----------------|
| `aggrBy` / `aggrBySplit` | Same aggregation idea; split version adds Direct/Indirect. |
| `topNFromMap` / `topNFromSplit` | Same ranking pattern; split version carries `{ D, I }`. |
| `aggregateTopCategoriesForOverview` / `aggregateTopCategoriesForOverviewSplit` | Non-split vs Direct/Indirect split. |

Consolidation would shrink the file but is **out of scope** under zero-change rules.

---

## Keep (explicit public / HTML hooks)

Examples verified in this repo:

- **`window` exports:** `_idpSetAppView`, `idpRenderSingleSourceView`, `toggleSection`, `loadCollapseStates`, `runCompleteDiagnostics`, `idpRunAllTabTests`, `idpToggleNavSection`, notifications, SSA debug fields, harmonization debug payloads, `__idp_payload`, etc.
- **`idpSsaLoadMore`:** Wired from `#ssa-load-more-btn` in `initSingleSourceSortAndExportWireOnce` (not HTML `onclick`, but **used**).

Prefix rule (**idp**, **harm**, **cs**, **ssa**, **pe**, …): keep unless proven dead; many are wired indirectly.

---

## Debug / diagnostics

| Kind | Count / location |
|------|-------------------|
| `console.log` / `console.warn` / `console.error` / `console.debug` | **57** total `console.*(` in `Cummins_IDP_Dashboard.html` — **document only**; do not mass-remove (diagnostics / `?idpdiag=1` flows). |
| `window.alert` | **6** — user-facing guards in Index Analysis / Price Explanation flows. |

---

## Commented-out code

No exhaustive inventory in this pass. **Recommendation:** leave commented blocks unless tied to a verified ticket; they often document reverted experiments.

---

## Dead branches

- **`if (false)`:** none found.
- **Unreachable returns:** not scanned AST-wide.

---

## `harmonization-client.js`

- Loaded before the main inline dashboard script.
- Exports behavior into the global scope via its IIFE pattern (see file header). **Do not** mark internal helpers unused without analyzing cross-file references from `Cummins_IDP_Dashboard.html`.

---

## Phase 4 removal policy (when / if allowed)

1. Only remove items from **High** table after triple-check: HTML, `window.`, quoted strings, `typeof fn === "function"` indirection.
2. Remove **one** function per PR/commit; run full manual checklist after each.
3. **Do not** remove `wireSpendFileButton` / `handleSpendFileInput` until product confirms manual upload is intentionally retired **or** wiring is added — today they are dead but represent a **feature stub**.

---

## Recommendations

1. **Immediate (zero risk):** Use this report for onboarding and for planning a **post–freeze** cleanup branch.
2. **Performance (see `LAZY_LOADING.md`):** Part Search still renders **all** matching rows in `renderPartSearchTable` (`forEach` + `appendChild` per row) — largest predictable UI stall; any fix must preserve identical visible rows or be behind the same UX (virtual list with identical scrollbar behavior is non-trivial).
3. **Benchmarks:** Fill `PERFORMANCE_REPORT.md` locally with Chrome Performance traces (not automated in this repo).
