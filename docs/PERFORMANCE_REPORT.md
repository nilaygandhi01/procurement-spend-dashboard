# Performance Report (template)

**Environment:** Record browser (Chrome **___**), OS, CPU throttling (None / 4× / 6×), whether `data.json` is local or remote.

**Policy:** No automated before/after numbers were captured in CI for this repo. Fill the tables after local runs using **Chrome DevTools → Performance**.

**Lazy loading (2026-05-12):** Part Search now renders **50 rows per page** with **Load more**; Index Excel uploads are **queued with delays** between files; several tabs **wire on first visit**. Use the rows below to capture **your** machine before/after if you keep an older build for comparison.

## How to measure

1. Open `Cummins_IDP_Dashboard.html` via **local HTTP server** (not `file:` if your data load requires it).
2. Performance panel → **Record** → perform the action → **Stop**.
3. Note **Scripting** time and **Long tasks** (>50ms) in the summary.

## Part Search (large result set)

| Step | Before (ms) | After (ms) | Notes |
|------|---------------|------------|--------|
| Debounce end → last long task end (**first 50 rows** only) | | | Query returning ~500–1000+ matches; KPIs still use full set |
| Debounce end → first paint of results table | | | |
| Click **Load next 50** → DOM stable | | | Optional: repeat until all rows loaded |

**Target (product prompt):** first **page** of results should feel responsive (sub‑second typical) because only **50** `<tr>` nodes are created per step; remaining rows load on demand.

## Excel upload (Index Analysis)

| Step | Before (ms) | After (ms) |
|------|---------------|------------|
| Select 3 files → UI unblocked (main thread idle between steps) | | | Expect shorter blocking bursts per file vs. back‑to‑back parse |
| Longest single task during `XLSX.read` | | | Per file |
| Wall time until status shows **Loaded N index(es)** | | | |

## Tab switch (Overview → Index Analysis)

| Step | Before (ms) | After (ms) |
|------|---------------|------------|
| Click nav → next paint + input responsive | | | First visit may include lazy wire + optional default index `fetch` |
| Cold page load → **Time to Interactive** (optional) | | | Fewer tab inits at `onReady` |

## Harmonization expand (if lazy expansion is ever added)

| Step | Before (ms) | After (ms) |
|------|---------------|------------|
| Click expand → detail DOM stable | | |

---

*Replace empty cells after each optimization release; attach trace screenshots to your internal ticket system if required.*
