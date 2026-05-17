# Lazy Loading & Performance-Oriented Changes

**Status:** No Phase 2A–2D, 3, 5, or 6 code changes were applied in the codebase for this deliverable.

## Why nothing was implemented

The request simultaneously requires:

1. **Zero functionality, zero design, zero breaking changes** — behavior and visuals must match production exactly.
2. **Phases 2–6** — e.g. Part Search “Load next 50” button, supplier dropdown caps, deferred tab `initializeTab`, Excel `setTimeout` sequencing, harmonization “render on first expand”.

Items in (2) **change UX or timing** (new buttons, fewer visible rows, delayed search, different init order). They are **incompatible** with (1) unless rebuilt to be **pixel- and behavior-identical** (e.g. true virtual scrolling with full scroll height — high effort, non-trivial).

## Current behavior (as implemented today)

| Area | Behavior |
|------|-----------|
| **Part Search** | `performPartSearch` → `renderPartSearchTable` renders **every** matching row; KPIs use **full** `partSearchResults` (`updatePartSearchKpis`). Input is already **debounced 300ms** (`initPartSearch`). |
| **Supplier suggest** | `renderSupplierSuggestDropdown` caps suggestions at **80** matches (`lim = 80`), not unbounded. |
| **Index Analysis Excel** | Synchronous `FileReader` + `XLSX.read` on main thread (unchanged). |
| **Harmonization** | No “lazy first expand” gate in this pass (unchanged). |
| **Single Source (Phase 2E)** | **`SSA_PAGE_SIZE = 50`**, **`idpSsaLoadMore()`**, **`#ssa-load-more-btn`** click wired in **`initSingleSourceSortAndExportWireOnce`** — pagination path **present**. |
| **Tab init** | **`onReady`** still runs full wiring (`initFfDropdowns`, `initHarmFfDropdowns`, `populateFilterSelectsFromData`, `initPartSearch`, etc.) — no `tabsInitialized` gate added. |

## Safe future work (when policy allows behavior/testing budget)

1. **DocumentFragment** in `renderPartSearchTable` only — same rows, same order, single DOM insertion batch; **low regression risk** if done carefully.
2. **Virtual scrolling** for Part Search — **same** scroll height and row count as today requires a vlist library or custom scroll sync; otherwise it violates “identical design.”
3. **Chunked `requestIdleCallback` / `setTimeout(0)`** for Excel — must preserve final catalog state and error handling; measure with Performance panel.

See also `PERFORMANCE_REPORT.md` for measurement template.
