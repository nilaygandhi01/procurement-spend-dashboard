# Change log

## 2026-05-12 — Bug fixes: Single Source supplier filter + Time panel viewport

All in **`Cummins_IDP_Dashboard.html`**.

1. **Single Source Analysis** — **`buildSingleSourceAggregates`** (~**3665**)  
   - **Issue:** Distinct suppliers were counted over a **wide** slice (months + commodity only) while spend used **Spend Review–filtered** rows, so many multi-supplier parts still appeared.  
   - **Fix:** One pass over **`getFiltered()`** only: aggregate spend/qty per part and require **exactly one** distinct `idpSingleSourceSupplierKey`; skip parts whose only key is **`__none__`**. **`$50k`** threshold unchanged in **`renderSingleSourceAnalysis`**.

2. **Time filter dropdown (`#ff-panel-period`)** — CSS ~**555–623**; JS ~**4199–4235**, **`initFfDropdowns`** ~**11640**  
   - **`#filter-scroll`:** `overflow-x/y: visible` so ancestors do not clip absolutely positioned siblings.  
   - When Time opens: **`idpSyncPeriodPanelViewport(btn)`** sets **`position: fixed`** via class **`idp-ff-panel-viewport-fixed`** and CSS variables so the panel stays within the viewport; **`idpClearPeriodPanelViewport`** on close / tab switch.  
   - **HTML:** Time panel **`min-w-0`**, **`overflow-x-hidden`** (no outer `overflow-hidden` that hid the Apply row).

---

## 2026-05-12 — Lazy loading & approved UX (Index Excel, Part Search, tab init, debounce)

All changes are in **`Cummins_IDP_Dashboard.html`**. Approved UX: progress text, async gaps, **Load more** for Part Search, first-visit tab wiring, **300 ms** debounce on listed inputs. Visual palette (colors/spacing/fonts) unchanged except status line **color** for processing/error (explicitly approved).

### Completed

1. **Index Analysis — multi-file Excel upload (async + status)**  
   - **`idpParseIndexArrayBuffer`** (~**9238**) — optional `parseOpts`: `skipStatusUpdate`, `skipChartRedraw` for batch parses.  
   - **`idpProcessIndexExcelFilesAsync`** (~**9278**) — sequential queue: **50 ms** before parse, **150 ms** between files; **`#index-excel-status`** shows `Processing k of n: filename` (orange `#F07F00`), then `Loaded N index(es)` (`#334155`); errors `#b91c1c`.  
   - **`idpWireIndexExcelUploadOnce`** (~**9384**) — `change` handler calls async queue; still **`readAsArrayBuffer`** + **`XLSX.read(..., { type: "array" })`**.  
   - **`idpUpdateIndexExcelStatus`** (~**9365**) — singular/plural **“index / indexes”** when idle.

2. **Part Search — paginated table (50 rows / page)**  
   - Globals ~**3174–3178**: `PART_SEARCH_PAGE_SIZE`, `partSearchAllResults`, `partSearchDisplayedEnd`, `partSearchLastQuery`, `idpTabsLazyInitDone`.  
   - **`idpBuildPartSearchResultRow`**, **`idpAppendPartSearchRows`**, **`idpUpdatePartSearchLoadMoreUi`**, **`idpPartSearchLoadMore`** (~**7327–7425**).  
   - **`performPartSearch`** (~**7607**) — filter unchanged; **KPIs from full result set**; table appends pages; **`#ps-results-count`** “Showing X of Y”.  
   - **`renderPartSearchTable`** (~**7427**) — full render path (e.g. diagnostics) reuses row builder.  
   - **HTML** — **`#part-search-load-more-wrap`** / **`#part-search-load-more-btn`** inside **`#part-search-results`** (~**2519**).

3. **Tab lazy initialization**  
   - **`idpEnsureTabInitialized(viewName)`** (~**11139**) — runs at start of **`setAppView`** (~**11177** after `data-idp-app-view`). First visit wires: `part-search` → **`initPartSearch`**; `harmonization` → **`initHarmUnifiedFilterWire`**; `single-source` → **`initSingleSourceSortAndExportWireOnce`**; `index-analysis` → **`idpWireIndexExcelUploadOnce`**, **`idpWireIndexAnalysisPartsOnce`**, **`idpTryFetchDefaultIndexFilesOnce`**; `price-explanation` → **`initPriceExplanationWireOnce`**; `cleansheet` → **`csWireCleansheetExcelOnce`**.  
   - **`onReady`** (~**12001**) — no longer calls those inits at load; **`renderIndexAnalysisView`** (~**10039**) no longer calls the three index wires (handled on first **index-analysis** visit).

4. **Debounce — 300 ms**  
   - **`#part-search-input`** ~**7666**; **`#supplier-analysis-input`** ~**7682**; **`#index-index-search`** ~**10156**; **`#ia-part-input`** ~**9635**; **`#pe-part-input`** ~**11098**.

### Validation (manual)

- Index: multi-select upload → status steps → final count; tabs clickable during upload; chart + selected indexes after batch.  
- Part Search: large query → first 50 fast → Load more; KPIs match full set; ≤50 results hides button.  
- Each tab: first open works; return visit still works.  
- Quick typing on all listed inputs → single fire after **300 ms** idle.

**Note:** Automated browser benchmarks were not run in this environment; fill **`PERFORMANCE_REPORT.md`** after local DevTools runs.

---

## 2026-05-12 — DocumentFragment optimizations (zero UX / behavior change)

All changes are in **`Cummins_IDP_Dashboard.html`**: build rows off-DOM, then a **single** `appendChild(fragment)` onto the live container. Same row count, order, markup, and event listeners as before.

### Completed

1. **Part Search results table** — `renderPartSearchTable` (starts ~line **7325**)  
   - **Change:** `frag = document.createDocumentFragment()`; each row `frag.appendChild(tr)`; then `tb.appendChild(frag)`.

2. **Harmonization — 5-column line-item breakdown** — `harmAppendHarmFiveColBreakdown` (~**5167**)  
   - **Change:** `tbFrag` collects `<tr>` nodes for the breakdown tbody; `tb.appendChild(tbFrag)` once.

3. **Harmonization — MECE rollup table (4 rows)** — `harmAppendCategoryRollupTable` (~**6697**)  
   - **Change:** `harmRollupFrag` for tbody rows; single append to tbody.

4. **Cleansheet — SKU recommendations (top 10)** — inside `renderCleansheet` (~**4663**, tbody block ~**4730+**)  
   - **Change:** `csSkuFrag` for recommendation rows.

5. **Cleansheet — upload preview table** — `csProcessCleansheetWorkbook` (~**4780**)  
   - **Change:** `csUpFrag` for up to 20 preview rows.

6. **Part Search — supplier suggest list** — `renderSupplierSuggestDropdown` (~**7406**)  
   - **Change:** `sugFrag` for matched supplier `<button>` nodes; empty state still appends a single `<p>` directly (unchanged behavior).

7. **Part Search — supplier analysis** — `renderSupplierAnalysis` (~**7450**)  
   - **Change:** `fragCat` for `#supplier-category-tbody`; `fragParts` for `#supplier-parts-tbody`.

8. **Index Analysis — year summary table** — `renderIndexYearTable` (~**9664**)  
   - **Change:** `indexYearFrag` for selected index rows.

9. **Overview — Top 10 suppliers HTML table** — `renderTop10SuppliersOverview` (~**7908**)  
   - **Change:** `topSupFrag` for up to 10 detail rows (Chart.js path unchanged).

10. **Harmonization — unit-price waterfall allocation table** — `harmAppendHarmonizationUnitPriceBars` (~**6098**, tbody build ~**6195+**)  
    - **Change:** `harmWfFrag` for sorted supplier/site rows in the allocation `<tbody>`.

### Not changed (reason)

1. **RAP Direct / Indirect tables** — `renderRapTab` assigns **`innerHTML`** from `rapBuildTableRows` (string HTML). There is **no** per-row `appendChild` loop on the tbody; batching is already one DOM write per table.

2. **Single Source Analysis (`#ssa-tbody`)** — Per instructions: leave SSA / load-more path as-is (pagination + existing `setTimeout` batch).

3. **Harmonization main opportunity tables** (`appendRowsBatch` in `harmRenderCategoryOpportunitySection`) — Rows are appended in intentional preview/expand batches with click handlers tied to live insertion order; left unchanged to avoid any risk to expand/collapse and chart wiring.

4. **Chart.js, KPI sparklines, filter panels** — Out of scope.

### Validation (manual)

- Part Search: search → same table content and count line; supplier typeahead → same options and clicks.  
- Harmonization: expand “View details” → breakdown table matches prior layout.  
- Cleansheet: tab loads top SKU table; Excel upload shows same preview rows.  
- Index Analysis: selected indexes table matches prior.  
- Overview: Top 10 suppliers table + chart unchanged visually.

**Note:** Automated browser tests were not run in this environment; confirm in Chrome with your dataset.

---

## 2026-05-12 — Performance & maintainability audit (documentation)

### Added (earlier same day)

- **`AUDIT_REPORT.md`** — Phase 1 audit notes.
- **`LAZY_LOADING.md`** — Scope / deferred lazy-loading items.
- **`PERFORMANCE_REPORT.md`** — Benchmark template.

### Removed

- **`_audit_functions.js`** — Temporary audit script.

### Other files

- **`harmonization-client.js`**, **`index.html`** — Unchanged by DocumentFragment work.
