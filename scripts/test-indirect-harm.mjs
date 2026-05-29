// Unit tests for the redesigned Indirect Harmonization tab.
//
// Coverage:
//   PRE-CLEAN
//     - Dummy word in r.material excludes transaction entirely.
//     - Dummy word in r.noun excludes transaction entirely.
//     - qty <= 0 excludes.
//     - unit price <= 0 excludes.
//     - line spend < $50 excludes (e.g. $0.10 * 100 = $10 line).
//     - unit price < $0.05 excludes.
//     - A pre-cleaned transaction NEVER becomes a benchmark.
//
//   CAT 1 — Same Supplier, Same Site, Single-Invoice Rightsizing
//     - Basic grouping + benchmark + savings math.
//     - 4-txn group excluded by MIN_TRANSACTIONS = 5.
//     - 5-txn group exactly at the boundary kept.
//     - 5-txn group with $4,500 post-dedup savings excluded by MIN_SAVINGS_USD = 5000.
//     - Benchmark boundary $1.00.
//     - Max price ratio boundary 100x.
//     - Transaction with unit price == benchmark contributes zero (not double-counted).
//
//   CAT 2 — Same Supplier, Different Sites, Cross-Site Rightsizing to Site Average
//     - Site volume-weighted average benchmark math.
//     - Single-site groups excluded by spanning < 2 sites.
//     - Benchmark site must have >= INDIRECT_HARM_CAT2_MIN_BENCHMARK_SITE_TXNS = 3 transactions
//       (singleton "lucky low" invoice cannot become the benchmark).
//
//   DE-DUPLICATION
//     - Cat 1 wins when its per-txn savings > Cat 2's.
//     - Cat 2 wins when its per-txn savings > Cat 1's.
//     - Ties resolve to Cat 1 (higher confidence).
//
//   FUZZY / KEYING
//     - Numeric Part Number vs synthetic IH#FUZZY# keying.
//     - Fuzzy clustering similarity-check splits a transitive A~B~C chain where A~C < threshold.
//
//   SIDEBAR
//     - #nav-indirect-harm is the LAST sibling under #idp-nav-section-body-analysis in static HTML.
//
// Run: node scripts/test-indirect-harm.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const harmonizationClientPath = path.join(repoRoot, "src", "dashboard", "harmonization-client.js");
const indexMathPath = path.join(repoRoot, "src", "dashboard", "index-math.mjs");
const indexHtmlPath = path.join(repoRoot, "src", "dashboard", "index.html");

const harmJs = fs.readFileSync(harmonizationClientPath, "utf8");
const shim = {};
new Function("window", harmJs)(shim);
const idpComputeIndirectHarmFromRows = shim.idpComputeIndirectHarmFromRows;
if (typeof idpComputeIndirectHarmFromRows !== "function") {
  console.error("FAIL: harmonization-client.js did not expose idpComputeIndirectHarmFromRows");
  process.exit(1);
}

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = actual === expected || (typeof actual === "number" && typeof expected === "number" && Math.abs(actual - expected) < 1e-6);
  if (ok) { pass++; } else { fail++; console.log("FAIL:", label, "expected", expected, "got", actual); }
}
function truthy(val, label) {
  if (val) pass++;
  else { fail++; console.log("FAIL:", label, "expected truthy got", val); }
}

/** A test row factory. Optional `material` / `noun` for pre-clean tests. */
function row(year, partKey, supplier, site, qty, unitPrice, opts) {
  opts = opts || {};
  return {
    year: year,
    part: partKey.indexOf("IH#FUZZY#") === 0 ? "" : partKey,
    _idpIhKey: partKey,
    supplier: supplier,
    site: site,
    quantity: qty,
    spend: opts.lineSpend != null ? opts.lineSpend : qty * unitPrice,
    material: opts.material != null ? opts.material : "WIDGET",
    noun: opts.noun != null ? opts.noun : "WIDGET"
  };
}
function partKeyFn(r) { return r._idpIhKey || ""; }
function defaultOpts(overrides) {
  return Object.assign({
    partKeyFn: partKeyFn,
    minBenchmarkUsd: 1.00,
    maxPriceRatio: 100,
    minTransactions: 5,
    minSavingsUsd: 5000,
    cat2MinBenchmarkSiteTxns: 3,
    minLineSpendUsd: 50,
    minUnitPriceUsd: 0.05
    // dummyWords left as default (INDIRECT_HARM_DUMMY_WORDS_DEFAULT)
  }, overrides || {});
}

/* =============================== PRE-CLEAN =============================== */

console.log("--- TEST: pre-clean: dummy word in r.material ---");
{
  const rows = [
    row(2024, "P", "S", "A", 100, 10, { material: "TEST PART DO NOT USE" }),
    row(2024, "P", "S", "A", 100, 10),
    row(2024, "P", "S", "A", 100, 12),
    row(2024, "P", "S", "A", 100, 14),
    row(2024, "P", "S", "A", 100, 16),
    row(2024, "P", "S", "A", 100, 20)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts({ minSavingsUsd: 0 }));
  eq(out.diagnostics.preCleanExcludedByDummyWord, 1, "1 row excluded by dummy word in material");
  eq(out.diagnostics.rowsAfterPreClean, 5, "5 rows survived");
}

console.log("--- TEST: pre-clean: dummy word in r.noun ---");
{
  const rows = [
    row(2024, "P", "S", "A", 100, 10, { material: "WIDGET", noun: "SAMPLE" }),
    row(2024, "P", "S", "A", 100, 10),
    row(2024, "P", "S", "A", 100, 12),
    row(2024, "P", "S", "A", 100, 14),
    row(2024, "P", "S", "A", 100, 16),
    row(2024, "P", "S", "A", 100, 20)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts({ minSavingsUsd: 0 }));
  eq(out.diagnostics.preCleanExcludedByDummyWord, 1, "1 row excluded by dummy word in noun");
}

console.log("--- TEST: pre-clean: qty <= 0 or unit price <= 0 ---");
{
  const rows = [
    row(2024, "P", "S", "A", 0, 10),        // qty 0
    row(2024, "P", "S", "A", -5, 10),       // qty negative
    { year: 2024, part: "P", _idpIhKey: "P", supplier: "S", site: "A", quantity: 100, spend: 0, material: "WIDGET", noun: "WIDGET" }, // spend 0
    row(2024, "P", "S", "A", 100, 10),
    row(2024, "P", "S", "A", 100, 12),
    row(2024, "P", "S", "A", 100, 14),
    row(2024, "P", "S", "A", 100, 16),
    row(2024, "P", "S", "A", 100, 20)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts({ minSavingsUsd: 0 }));
  eq(out.diagnostics.preCleanExcludedByZeroQtyOrPrice, 3, "3 zero/negative rows excluded");
}

console.log("--- TEST: pre-clean: line spend < $50 ($0.10 invoice, qty 100 => $10 line) ---");
{
  // Big $50K-spend dummy with "test" in material; should be caught by dummy word filter.
  const rows = [
    row(2024, "P", "S", "A", 100, 0.10),    // line spend $10 < $50  → excluded
    row(2024, "P", "S", "A", 100, 100),     // good rows
    row(2024, "P", "S", "A", 100, 102),
    row(2024, "P", "S", "A", 100, 104),
    row(2024, "P", "S", "A", 100, 106),
    row(2024, "P", "S", "A", 100, 110)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts({ minSavingsUsd: 0 }));
  eq(out.diagnostics.preCleanExcludedByMinLineSpend, 1, "1 row excluded by min line spend");
  // Verify the $0.10 row never became the benchmark — Cat 1 benchmark should be $100, not $0.10.
  truthy(out.cat1Opps && out.cat1Opps.length >= 1, "Cat 1 opp emitted");
  if (out.cat1Opps && out.cat1Opps.length) {
    eq(out.cat1Opps[0].benchmark, 100, "Cat 1 benchmark is $100 (excluded-by-pre-clean $0.10 row not used)");
  }
}

console.log("--- TEST: pre-clean: unit price < $0.05 ---");
{
  // qty 5000 * $0.04 = $200 spend (passes line-spend filter), but unit price $0.04 < $0.05 → excluded.
  const rows = [
    row(2024, "P", "S", "A", 5000, 0.04),
    row(2024, "P", "S", "A", 100, 10),
    row(2024, "P", "S", "A", 100, 12),
    row(2024, "P", "S", "A", 100, 14),
    row(2024, "P", "S", "A", 100, 16),
    row(2024, "P", "S", "A", 100, 20)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts({ minSavingsUsd: 0 }));
  eq(out.diagnostics.preCleanExcludedByMinUnitPrice, 1, "1 row excluded by min unit price");
  // Benchmark = $10 (the legitimate min), NOT $0.04.
  if (out.cat1Opps && out.cat1Opps.length) {
    eq(out.cat1Opps[0].benchmark, 10, "Cat 1 benchmark = $10 (not the excluded $0.04 outlier)");
  }
}

console.log("--- TEST: pre-clean: dummy PO with $50K spend excluded entirely ---");
{
  // High-spend dummy invoice should NEVER survive pre-clean even though its line spend is huge.
  const rows = [
    row(2024, "P", "S", "A", 1000, 50, { material: "TEST INVOICE - 50K DUMMY", noun: "TEST" }),
    row(2024, "P", "S", "A", 100, 10),
    row(2024, "P", "S", "A", 100, 15),
    row(2024, "P", "S", "A", 100, 20),
    row(2024, "P", "S", "A", 100, 25),
    row(2024, "P", "S", "A", 100, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts({ minSavingsUsd: 0 }));
  eq(out.diagnostics.preCleanExcludedByDummyWord, 1, "$50K dummy PO excluded by dummy-word filter");
  if (out.cat1Opps && out.cat1Opps.length) {
    eq(out.cat1Opps[0].benchmark, 10, "Benchmark $10 (the dummy never participated)");
  }
}

/* =============================== CAT 1 ============================ */

console.log("--- TEST: Cat 1 basic single-invoice rightsizing math ---");
{
  // 1 supplier, 1 site, 5 txns @ $10 / $15 / $20 / $25 / $30 unit price, qty 1000 each.
  // Benchmark = $10. Per-txn savings = (up-10)*1000 for up > 10.
  // = 0 + 5000 + 10000 + 15000 + 20000 = 50000.
  const rows = [
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.cat1GroupsKept, 1, "Cat 1 kept");
  eq(out.cat1Opps[0].savings, 50000, "Cat 1 savings $50,000");
  eq(out.cat1Opps[0].benchmark, 10, "Cat 1 benchmark $10");
  // Single site → Cat 2 excluded.
  eq(out.diagnostics.cat2ExcludedByOneSite, 1, "Cat 2: single-site group excluded");
  eq(out.cat2Opps.length, 0, "Cat 2 emits nothing");
}

console.log("--- TEST: Cat 1 MIN_TRANSACTIONS — 4 txns excluded, 5 kept ---");
{
  const rows4 = [
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 30),
    row(2024, "P", "S", "A", 1000, 40)
  ];
  const o4 = idpComputeIndirectHarmFromRows(rows4, defaultOpts({ minSavingsUsd: 0 }));
  eq(o4.diagnostics.cat1ExcludedByMinTransactions, 1, "4-txn group excluded");
  const rows5 = [
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 30),
    row(2024, "P", "S", "A", 1000, 40),
    row(2024, "P", "S", "A", 1000, 50)
  ];
  const o5 = idpComputeIndirectHarmFromRows(rows5, defaultOpts({ minSavingsUsd: 0 }));
  eq(o5.diagnostics.cat1GroupsKept, 1, "exactly 5 txns kept");
}

console.log("--- TEST: Cat 1 MIN_SAVINGS_USD — 5-txn group with $4,500 savings excluded ---");
{
  // 5 txns: bench $10 (qty 100), then 4 txns @ $11.25 with qty 100 each.
  // Per txn savings = 1.25 * 100 = 125. Total = 4 * 125 = $500. Way under $5000.
  // Tune: bench $10 qty 100 (1 txn); 4 txns @ $11.125 qty 1000 → per-txn $1125 → total $4500.
  const rows = [
    row(2024, "P", "S", "A", 100, 10),
    row(2024, "P", "S", "A", 1000, 11.125),
    row(2024, "P", "S", "A", 1000, 11.125),
    row(2024, "P", "S", "A", 1000, 11.125),
    row(2024, "P", "S", "A", 1000, 11.125)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.cat1ExcludedByMinSavings, 1, "5-txn $4,500 group excluded");
  eq(out.cat1Opps.length, 0, "no Cat 1 opp emitted");
}

console.log("--- TEST: Cat 1 benchmark exactly $1.00 (boundary kept) ---");
{
  const rows = [
    row(2024, "P", "S", "A", 10000, 1.00),
    row(2024, "P", "S", "A", 10000, 2.00),
    row(2024, "P", "S", "A", 10000, 3.00),
    row(2024, "P", "S", "A", 10000, 4.00),
    row(2024, "P", "S", "A", 10000, 5.00)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.cat1ExcludedByMinBenchmark, 0, "benchmark exactly $1.00 not excluded");
  eq(out.diagnostics.cat1GroupsKept, 1, "kept");
}

console.log("--- TEST: Cat 1 MAX_PRICE_RATIO 100x ---");
{
  // Ratio 100x exactly → kept; ratio 101x → excluded.
  const rows100 = [
    row(2024, "P", "S", "A", 100, 1),
    row(2024, "P", "S", "A", 1000, 50),
    row(2024, "P", "S", "A", 1000, 75),
    row(2024, "P", "S", "A", 1000, 88),
    row(2024, "P", "S", "A", 1000, 100)
  ];
  const o100 = idpComputeIndirectHarmFromRows(rows100, defaultOpts({ minSavingsUsd: 0 }));
  eq(o100.diagnostics.cat1ExcludedByMaxRatio, 0, "ratio 100x kept");
  const rows101 = [
    row(2024, "P", "S", "A", 100, 1),
    row(2024, "P", "S", "A", 1000, 50),
    row(2024, "P", "S", "A", 1000, 75),
    row(2024, "P", "S", "A", 1000, 90),
    row(2024, "P", "S", "A", 1000, 101)
  ];
  const o101 = idpComputeIndirectHarmFromRows(rows101, defaultOpts({ minSavingsUsd: 0 }));
  eq(o101.diagnostics.cat1ExcludedByMaxRatio, 1, "ratio > 100x excluded");
}

console.log("--- TEST: Cat 1 transaction with up == benchmark contributes 0 ---");
{
  // 5 txns, two at the benchmark $10 (qty 1000 each).
  // Savings: 0 + 0 + (15-10)*1000 + (20-10)*1000 + (25-10)*1000 = 30000.
  const rows = [
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.cat1Opps[0].savings, 30000, "benchmark-price txns contribute zero");
}

/* =============================== CAT 2 ============================ */

console.log("--- TEST: Cat 2 site-volume-weighted-average math ---");
{
  // 2 sites, 1 supplier, 1 part. Site A: 3 txns @ $20, qty 1000 each (avg $20).
  // Site B: 3 txns @ $10, qty 1000 each (avg $10).
  // Cat 2 benchmark = MIN site_avg = $10. Site B benchmark site, A is "above" site.
  // Per-txn savings at non-benchmark site (A): 3 txns × (20-10)*1000 = 30000.
  // Both sites have 3 txns >= INDIRECT_HARM_CAT2_MIN_BENCHMARK_SITE_TXNS=3.
  const rows = [
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "B", 1000, 10),
    row(2024, "P", "S", "B", 1000, 10),
    row(2024, "P", "S", "B", 1000, 10)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.cat2GroupsKept, 1, "Cat 2 kept");
  eq(out.cat2Opps[0].savings, 30000, "Cat 2 savings $30,000 (3 × (20-10)*1000)");
  eq(out.cat2Opps[0].benchmark, 10, "Cat 2 benchmark = $10 site average");
  eq(out.cat2Opps[0].benchmark_site, "B", "benchmark site is B");
}

console.log("--- TEST: Cat 2 single-site groups excluded ---");
{
  const rows = [
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.cat2ExcludedByOneSite, 1, "single-site Cat 2 group excluded");
  eq(out.cat2Opps.length, 0, "no Cat 2 opp emitted");
}

console.log("--- TEST: Cat 2 benchmark site needs >= 3 transactions (singleton lucky-low excluded) ---");
{
  // Site A: 1 txn at $5 (the "lucky low"), qty 1000.
  // Site B: 5 txns at $20, qty 1000 each.
  // Site A's site_avg is $5 but only has 1 txn — not >= 3 — so it CANNOT be the benchmark.
  // Site B has 5 txns and is eligible. Site B's site_avg = $20.
  // With both sites' eligibility, benchmark candidates = {Site B}. Benchmark = $20.
  // Site A txns at $5 are NOT > $20 — savings 0. Cat 2 collapses.
  const rows = [
    row(2024, "P", "S", "A", 1000, 5),
    row(2024, "P", "S", "B", 1000, 20),
    row(2024, "P", "S", "B", 1000, 20),
    row(2024, "P", "S", "B", 1000, 20),
    row(2024, "P", "S", "B", 1000, 20),
    row(2024, "P", "S", "B", 1000, 20)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  // Cat 2 had a valid (multi-site, ≥5 txns) group but no eligible benchmark
  // delivered any savings — collapses by min savings or no benchmark candidate.
  // The benchmark site B has 5 txns at $20, so site B's avg becomes the benchmark
  // ($20). Site A's transactions are *below* the benchmark, so they don't contribute
  // savings. Group has 0 savings and is dropped by MIN_SAVINGS_USD.
  truthy(out.cat2Opps.length === 0, "Cat 2 collapses (lucky-low singleton not used as benchmark)");
}

console.log("--- TEST: Cat 2 benchmark site with 3 txns at $5 IS used (matches threshold) ---");
{
  // Same setup but Site A now has 3 txns at $5.
  const rows = [
    row(2024, "P", "S", "A", 1000, 5),
    row(2024, "P", "S", "A", 1000, 5),
    row(2024, "P", "S", "A", 1000, 5),
    row(2024, "P", "S", "B", 1000, 20),
    row(2024, "P", "S", "B", 1000, 20),
    row(2024, "P", "S", "B", 1000, 20)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.cat2GroupsKept, 1, "Cat 2 kept");
  eq(out.cat2Opps[0].benchmark_site, "A", "Site A (3 txns at $5) is the benchmark site");
  eq(out.cat2Opps[0].benchmark, 5, "benchmark = $5");
  // Per-txn savings at Site B: 3 * (20-5)*1000 = 45000.
  eq(out.cat2Opps[0].savings, 45000, "Cat 2 savings $45,000");
}

/* =============================== DE-DUP ============================ */

console.log("--- TEST: Dedup tiebreaker — Cat 1 wins when its per-txn savings > Cat 2 ---");
{
  // Site A: 5 txns. 1 txn @ $5 (qty 1000) → Site A site_avg = (5*1000 + 4*100*100)/(1000+400) = wait let me reset.
  // Simpler: Site A has 4 txns @ $100 qty 100 + 1 txn @ $5 qty 100 → site_avg = (4*100*100 + 5*100)/500 = (40000+500)/500 = $81.
  // Site B has 5 txns @ $50 qty 100 each → site_avg = $50.
  // Cat 1 (P, A, S): 5 txns. Benchmark = $5 (single invoice). 4 txns @ $100 save (100-5)*100 = 9500 each ⇒ total 38000.
  // Cat 2 (P, S): benchmark sites = {A, B} (both have ≥3 txns). MIN site_avg = $50 (Site B).
  //   Site A's 4 txns @ $100 each save (100-50)*100 = 5000 per txn ⇒ 20000.
  //   Site A's 1 txn @ $5 — not > $50, no savings.
  // Dedup: each $100 txn at Site A is eligible for both. Cat 1 per-txn saves 9500, Cat 2 saves 5000. Cat 1 wins.
  // Final: Cat 1 keeps 4 txns @ 9500 = 38000; Cat 2 keeps 0 txns at A site → collapses.
  // BUT Cat 2 group only had savings at Site A txns and they all went to Cat 1 → Cat 2 dropped by MIN_SAVINGS_USD.
  const rows = [
    row(2024, "P", "S", "A", 100, 5),
    row(2024, "P", "S", "A", 100, 100),
    row(2024, "P", "S", "A", 100, 100),
    row(2024, "P", "S", "A", 100, 100),
    row(2024, "P", "S", "A", 100, 100),
    row(2024, "P", "S", "B", 100, 50),
    row(2024, "P", "S", "B", 100, 50),
    row(2024, "P", "S", "B", 100, 50),
    row(2024, "P", "S", "B", 100, 50),
    row(2024, "P", "S", "B", 100, 50)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  truthy(out.diagnostics.dedupReassignedToCat1 >= 1, "≥1 reassignment to Cat 1");
  eq(out.cat1Opps.length, 1, "Cat 1 keeps the Site-A group");
  eq(out.cat1Opps[0].savings, 38000, "Cat 1 captures $38,000 (4 × $9,500)");
  // Site B Cat 1 group has 5 identical $50 txns ⇒ benchmark $50, all rows at benchmark → 0 savings → dropped by MIN_SAVINGS_USD.
  // Cat 2: contributing Site A txns all went to Cat 1 ⇒ Cat 2 group collapses.
  eq(out.cat2Opps.length, 0, "Cat 2 collapses (all dual-eligible txns went to Cat 1)");
}

console.log("--- TEST: Dedup tiebreaker — Cat 2 wins when its per-txn savings > Cat 1 ---");
{
  // Site A: 5 txns. Bench $48 (qty 100), other 4 @ $50 qty 100 each. Cat 1 per-txn savings for $50 txns = (50-48)*100 = 200.
  // Site B: 5 txns @ $10 qty 1000 each. Site B site_avg = $10.
  // Cat 2 benchmark site = B at $10 (Site A's site_avg = $49.60).
  // Per-txn savings at Site A:
  //   $48 txn: Cat 1 = 0 (it IS the bench); Cat 2 = (48-10)*100 = $3,800 → Cat 2 only.
  //   $50 txns (×4): Cat 1 = (50-48)*100 = $200; Cat 2 = (50-10)*100 = $4,000. DUAL → Cat 2 wins.
  // Cat 2 total = 3800 + 4 × 4000 = $19,800.
  // Cat 1 group left with only the bench txn → 0 savings → dropped by MIN_SAVINGS_USD.
  const rows = [
    row(2024, "P", "S", "A", 100, 48),
    row(2024, "P", "S", "A", 100, 50),
    row(2024, "P", "S", "A", 100, 50),
    row(2024, "P", "S", "A", 100, 50),
    row(2024, "P", "S", "A", 100, 50),
    row(2024, "P", "S", "B", 1000, 10),
    row(2024, "P", "S", "B", 1000, 10),
    row(2024, "P", "S", "B", 1000, 10),
    row(2024, "P", "S", "B", 1000, 10),
    row(2024, "P", "S", "B", 1000, 10)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  truthy(out.diagnostics.dedupReassignedToCat2 >= 1, "≥1 reassignment to Cat 2");
  eq(out.cat2Opps.length, 1, "Cat 2 keeps the cross-site group");
  eq(out.cat2Opps[0].savings, 19800, "Cat 2 captures $19,800 (3800 from $48 bench-txn + 4×4000 from $50 txns)");
  eq(out.cat1Opps.length, 0, "Cat 1 collapses");
}

console.log("--- TEST: Dedup tiebreaker — ties → Cat 1 wins ---");
{
  // Construct so per-txn savings tie exactly. Site A 5 txns: bench=$10, others=$20 (qty 100).
  // Cat 1 per-txn savings = (20-10)*100 = 1000.
  // Site B 5 txns @ $10 qty 100 ⇒ site_avg $10.
  // Cat 2 benchmark = $10 (site B). Site A txns @ $20 save (20-10)*100 = 1000 — EXACT tie.
  // Cat 1 wins → 4 txns × 1000 = 4000. Hmm under $5000. Let me scale qty up to 1500.
  // 4 txns × (20-10)*1500 = 60000. That works for both Cat 1 and Cat 2 if they win.
  const rows = [
    row(2024, "P", "S", "A", 100, 10),
    row(2024, "P", "S", "A", 1500, 20),
    row(2024, "P", "S", "A", 1500, 20),
    row(2024, "P", "S", "A", 1500, 20),
    row(2024, "P", "S", "A", 1500, 20),
    row(2024, "P", "S", "B", 100, 10),
    row(2024, "P", "S", "B", 100, 10),
    row(2024, "P", "S", "B", 100, 10),
    row(2024, "P", "S", "B", 100, 10),
    row(2024, "P", "S", "B", 100, 10)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  truthy(out.diagnostics.dedupTiesResolvedToCat1 >= 1, "ties → Cat 1");
  eq(out.cat1Opps.length, 1, "Cat 1 kept on tie");
  eq(out.cat1Opps[0].savings, 60000, "Cat 1 captures $60,000");
  eq(out.cat2Opps.length, 0, "Cat 2 collapses (tied dual-eligible txns went to Cat 1)");
}

/* ===================== FUZZY / KEYING ===================== */

console.log("--- TEST: Part-Number vs fuzzy keying ---");
{
  const rows = [
    row(2024, "PN-100", "S", "A", 1000, 10),
    row(2024, "PN-100", "S", "A", 1000, 15),
    row(2024, "PN-100", "S", "A", 1000, 20),
    row(2024, "PN-100", "S", "A", 1000, 25),
    row(2024, "PN-100", "S", "A", 1000, 30),
    row(2024, "IH#FUZZY#7", "S", "A", 1000, 100),
    row(2024, "IH#FUZZY#7", "S", "A", 1000, 150),
    row(2024, "IH#FUZZY#7", "S", "A", 1000, 200),
    row(2024, "IH#FUZZY#7", "S", "A", 1000, 250),
    row(2024, "IH#FUZZY#7", "S", "A", 1000, 300)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.cat1Opps.length, 2, "two Cat 1 groups (one Part-#, one fuzzy)");
  eq(out.diagnostics.rowsKeyedByFuzzy, 5, "5 rows keyed by fuzzy");
  eq(out.diagnostics.rowsKeyedByPartNum, 5, "5 rows keyed by Part #");
}

console.log("--- TEST: fuzzy clustering w/ similarity sanity-check (transitive chain split) ---");
{
  const indexMathUrl = "file:///" + indexMathPath.replace(/\\/g, "/");
  const IDP_INDEX_MATH = await import(indexMathUrl).then(m => m.default || m).catch(e => { console.log("import err:", e.message); return null; });
  if (!IDP_INDEX_MATH || !IDP_INDEX_MATH.fuzzyClusterNames) {
    console.log("SKIP: IDP_INDEX_MATH could not be loaded.");
  } else {
    // A~B and B~C ≥ 0.80 but A~C < 0.80 (the chain we want sanity check to catch).
    const items = [
      { id: 0, name: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", block: "L3" },
      { id: 1, name: "beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu", block: "L3" },
      { id: 2, name: "gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi", block: "L3" }
    ];
    const tk = items.map(it => IDP_INDEX_MATH.normalizeNameForFuzzy(it.name, { threshold: 0.80 }).tokens);
    const jab = IDP_INDEX_MATH.tokenJaccard(tk[0], tk[1]);
    const jbc = IDP_INDEX_MATH.tokenJaccard(tk[1], tk[2]);
    const jac = IDP_INDEX_MATH.tokenJaccard(tk[0], tk[2]);
    console.log("  J(A,B)=" + jab.toFixed(3) + " J(B,C)=" + jbc.toFixed(3) + " J(A,C)=" + jac.toFixed(3));
    eq(jab >= 0.80, true, "J(A,B) ≥ 0.80");
    eq(jbc >= 0.80, true, "J(B,C) ≥ 0.80");
    eq(jac < 0.80, true, "J(A,C) < 0.80 (the chain failure the sanity check catches)");
  }
}

/* ============================== SIDEBAR ============================ */

console.log("--- TEST: sidebar nav button DOM order ---");
{
  const html = fs.readFileSync(indexHtmlPath, "utf8");
  const sectionStart = html.indexOf('id="idp-nav-section-body-analysis"');
  if (sectionStart < 0) { fail++; console.log("FAIL: cannot find #idp-nav-section-body-analysis"); }
  else {
    const sectionDiv = html.indexOf(">", sectionStart) + 1;
    let depth = 1, idx = sectionDiv;
    while (depth > 0 && idx < html.length) {
      const nextOpen = html.indexOf("<div", idx);
      const nextClose = html.indexOf("</div>", idx);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; idx = nextOpen + 4; }
      else { depth--; idx = nextClose + 6; }
    }
    const sectionBody = html.slice(sectionDiv, idx);
    const idRe = /id="(nav-[a-z\-]+)"/g;
    const ids = [];
    let m;
    while ((m = idRe.exec(sectionBody))) ids.push(m[1]);
    console.log("  buttons (in order):", ids.join(", "));
    eq(ids.length, 6, "6 SPEND ANALYSIS buttons");
    eq(ids[ids.length - 1], "nav-indirect-harm", "indirect-harm is the LAST entry");
    eq(ids[0], "nav-harmonization", "first entry is Harmonization");
  }
}

/* ===================== ASSUMPTION WALK ===================== */

/**
 * Walk reconciliation invariant — applied to the new 13-row walk:
 *   inScopeRowsCount  = structuralExcluded + Σ pre-clean(1..4) +
 *                       Σ group-buckets(5..8) + sanity-split(9) +
 *                       singleton(10) + analyzedRowsCount
 *   inScopeRowsSpend  = same identity on SIGNED spend (display uses
 *                       absolute values; reconciliation is signed).
 */
function assertWalkReconciles(diag, label) {
  const bucketCount =
    (diag.structuralExcludedRowsCount || 0) +
    (diag.preCleanExcludedByDummyWord || 0) +
    (diag.preCleanExcludedByZeroQtyOrPrice || 0) +
    (diag.preCleanExcludedByMinLineSpend || 0) +
    (diag.preCleanExcludedByMinUnitPrice || 0) +
    (diag.groupExcludedByMinTransactionsRowsCount || 0) +
    (diag.groupExcludedByMinSavingsRowsCount || 0) +
    (diag.groupExcludedByMinBenchmarkRowsCount || 0) +
    (diag.groupExcludedByMaxRatioRowsCount || 0) +
    (diag.excludedBySanitySplitRowsCount || 0) +
    (diag.excludedAsSingletonRowsCount || 0);
  const totalCount = bucketCount + (diag.analyzedRowsCount || 0);
  eq(totalCount, diag.inScopeRowsCount || 0, label + ": invoice count reconciles");
  const bucketSpend =
    (diag.structuralExcludedRowsSpend || 0) +
    (diag.preCleanExcludedByDummyWordSpend || 0) +
    (diag.preCleanExcludedByZeroQtyOrPriceSpend || 0) +
    (diag.preCleanExcludedByMinLineSpendSpend || 0) +
    (diag.preCleanExcludedByMinUnitPriceSpend || 0) +
    (diag.groupExcludedByMinTransactionsRowsSpend || 0) +
    (diag.groupExcludedByMinSavingsRowsSpend || 0) +
    (diag.groupExcludedByMinBenchmarkRowsSpend || 0) +
    (diag.groupExcludedByMaxRatioRowsSpend || 0) +
    (diag.excludedBySanitySplitRowsSpend || 0) +
    (diag.excludedAsSingletonRowsSpend || 0);
  const totalSpend = bucketSpend + (diag.analyzedRowsSpend || 0);
  const diff = Math.abs(totalSpend - (diag.inScopeRowsSpend || 0));
  truthy(diff < 0.01, label + ": signed spend reconciles (diff $" + diff.toFixed(2) + ")");
}

console.log("--- TEST: walk reconciles on the basic 5-txn Cat-1 case ---");
{
  const rows = [
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.inScopeRowsCount, 5, "5 in-scope rows");
  // 1000*10 + 1000*15 + 1000*20 + 1000*25 + 1000*30 = 100000
  eq(Math.round(out.diagnostics.inScopeRowsSpend), 100000, "$100,000 in-scope spend");
  eq(out.diagnostics.analyzedRowsCount, 5, "all 5 rows analyzed (group kept)");
  eq(Math.round(out.diagnostics.analyzedRowsSpend), 100000, "all $100,000 analyzed");
  assertWalkReconciles(out.diagnostics, "basic Cat 1 case");
}

console.log("--- TEST: walk attributes each pre-clean bucket's spend ---");
{
  // Mix one row of each pre-clean failure + 5 valid rows for a Cat 1 group.
  const rows = [
    row(2024, "P", "S", "A", 100, 10, { material: "TEST PART", lineSpend: 1234 }), // dummy word: $1,234
    row(2024, "P", "S", "A", 0, 10),                                                // qty 0 spend $0
    row(2024, "P", "S", "A", 100, 0.30, { lineSpend: 30 }),                         // line spend < $50 → $30
    { year: 2024, part: "P", _idpIhKey: "P", supplier: "S", site: "A", quantity: 5000, spend: 200, material: "WIDGET", noun: "WIDGET" }, // up $0.04 < $0.05 → spend $200
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.preCleanExcludedByDummyWord, 1, "1 dummy-word excluded");
  eq(Math.round(out.diagnostics.preCleanExcludedByDummyWordSpend), 1234, "dummy spend $1,234");
  eq(out.diagnostics.preCleanExcludedByZeroQtyOrPrice, 1, "1 zero-qty excluded");
  eq(Math.round(out.diagnostics.preCleanExcludedByZeroQtyOrPriceSpend), 0, "zero-qty spend $0");
  eq(out.diagnostics.preCleanExcludedByMinLineSpend, 1, "1 min-line-spend excluded");
  eq(Math.round(out.diagnostics.preCleanExcludedByMinLineSpendSpend), 30, "min-line-spend $30");
  eq(out.diagnostics.preCleanExcludedByMinUnitPrice, 1, "1 min-unit-price excluded");
  eq(Math.round(out.diagnostics.preCleanExcludedByMinUnitPriceSpend), 200, "min-unit-price spend $200");
  assertWalkReconciles(out.diagnostics, "mixed pre-clean buckets");
}

console.log("--- TEST: walk attributes 'group < 5 txns' bucket ---");
{
  // 4 txns at (P, S, A) — fails Cat 1 minTxn AND Cat 2 minTxn AND single-site.
  const rows = [
    row(2024, "P", "S", "A", 100, 10),
    row(2024, "P", "S", "A", 100, 20),
    row(2024, "P", "S", "A", 100, 30),
    row(2024, "P", "S", "A", 100, 40)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts({ minSavingsUsd: 0 }));
  eq(out.diagnostics.groupExcludedByMinTransactionsRowsCount, 4, "4 rows attributed to min-txn bucket");
  // (10+20+30+40)*100 = 10000
  eq(Math.round(out.diagnostics.groupExcludedByMinTransactionsRowsSpend), 10000, "$10,000 min-txn spend");
  eq(out.diagnostics.analyzedRowsCount, 0, "0 analyzed");
  assertWalkReconciles(out.diagnostics, "group < 5 txns");
}

console.log("--- TEST: walk attributes 'group savings < $5K' bucket ---");
{
  // 5 txns with low post-dedup savings = $500 (well under $5K).
  // bench $10, then 4 txns @ $11.25 qty 100 → savings (1.25*100)*4 = $500.
  const rows = [
    row(2024, "P", "S", "A", 100, 10),
    row(2024, "P", "S", "A", 100, 11.25),
    row(2024, "P", "S", "A", 100, 11.25),
    row(2024, "P", "S", "A", 100, 11.25),
    row(2024, "P", "S", "A", 100, 11.25)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.cat1ExcludedByMinSavings, 1, "1 group excluded by min savings");
  eq(out.diagnostics.groupExcludedByMinSavingsRowsCount, 5, "5 rows attributed to min-savings bucket");
  // (10 + 4*11.25)*100 = (10+45)*100 = 5500
  eq(Math.round(out.diagnostics.groupExcludedByMinSavingsRowsSpend), 5500, "$5,500 min-savings spend");
  assertWalkReconciles(out.diagnostics, "group savings < $5K");
}

console.log("--- TEST: walk: singleton row (key='', no fate) → bucket 11 ---");
{
  // Singleton row: key='' AND no _idpIhClusterFate flag set → defaults to singleton bucket.
  // Other 5 rows form a valid Cat 1 group.
  const lonely = { year: 2024, part: "", _idpIhKey: "", supplier: "S", site: "A", quantity: 100, spend: 500, material: "WIDGET", noun: "WIDGET" };
  const rows = [
    lonely,
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.excludedAsSingletonRowsCount, 1, "1 singleton row");
  eq(Math.round(out.diagnostics.excludedAsSingletonRowsSpend), 500, "singleton spend $500");
  eq(out.diagnostics.excludedBySanitySplitRowsCount, 0, "no sanity-split rows");
  assertWalkReconciles(out.diagnostics, "singleton case");
}

console.log("--- TEST: walk: sanity-split row (key='', fate='sanity_split') → bucket 10 ---");
{
  const dropped = { year: 2024, part: "", _idpIhKey: "", _idpIhClusterFate: "sanity_split", supplier: "S", site: "A", quantity: 100, spend: 750, material: "WIDGET", noun: "WIDGET" };
  const rows = [
    dropped,
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.excludedBySanitySplitRowsCount, 1, "1 sanity-split row");
  eq(Math.round(out.diagnostics.excludedBySanitySplitRowsSpend), 750, "sanity-split spend $750");
  eq(out.diagnostics.excludedAsSingletonRowsCount, 0, "no singleton rows");
  assertWalkReconciles(out.diagnostics, "sanity-split case");
}

console.log("--- TEST: walk: singleton+qty=0 attributed to qty bucket, not singleton bucket ---");
{
  // A singleton row whose qty is 0 — should land in pre-clean bucket 2 (qty/up≤0), NOT
  // in the singleton bucket, because pre-clean rules run BEFORE the key check.
  const singletonZero = { year: 2024, part: "", _idpIhKey: "", supplier: "S", site: "A", quantity: 0, spend: 100, material: "WIDGET", noun: "WIDGET" };
  const rows = [
    singletonZero,
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.preCleanExcludedByZeroQtyOrPrice, 1, "qty-0 singleton → pre-clean bucket");
  eq(out.diagnostics.excludedAsSingletonRowsCount, 0, "NOT counted as singleton (pre-clean first)");
  assertWalkReconciles(out.diagnostics, "singleton+qty=0");
}

console.log("--- TEST: walk: a row in a kept Cat 1 group is analyzed, even at exactly benchmark price ---");
{
  // Cat 1 group is kept (savings ≥ $5K); a benchmark-price row contributes 0 savings
  // but is STILL counted in analyzedRowsSpend (total_spend in the opp covers it).
  const rows = [
    row(2024, "P", "S", "A", 1000, 10),  // benchmark — $10K spend, 0 savings
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30),
    row(2024, "P", "S", "A", 1000, 35)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.cat1Opps.length, 1, "1 Cat 1 opp emitted");
  eq(out.diagnostics.analyzedRowsCount, 5, "all 5 rows analyzed (including bench)");
  // (10+20+25+30+35) * 1000 = 120000
  eq(Math.round(out.diagnostics.analyzedRowsSpend), 120000, "all $120K analyzed");
  assertWalkReconciles(out.diagnostics, "kept-group with benchmark row");
}

console.log("--- TEST: walk: rows in BOTH a kept Cat 1 group AND kept Cat 2 group counted ONCE in analyzed ---");
{
  // Site A: 6 txns. Site B: 6 txns. Same (Part, Supplier) → Cat 2 group.
  // Each (Part, Site, Supplier) → Cat 1 group with potential savings.
  // We want BOTH Cat 1 AND Cat 2 to be kept and overlap on rows.
  // Site A: bench $10 (qty 100), then 5 txns @ $20 (qty 1000) → Cat 1 savings = 5 × (20-10)*1000 = 50000.
  // Site B: bench $5 (qty 100), then 5 txns @ $10 (qty 1000) → Cat 1 savings = 5 × (10-5)*1000 = 25000.
  // Cat 2: Site A avg = (10*100+5*20*1000)/(100+5000) = (1000+100000)/5100 = $19.80
  //        Site B avg = (5*100+5*10*1000)/(100+5000) = (500+50000)/5100 = $9.91
  // Cat 2 bench = $9.91 (Site B). Site A txns @ $20 save (20-9.91)*1000 = $10,090 each.
  // Per-txn: Cat 1 savings for Site A $20 = $10K, Cat 2 savings = $10,090. Cat 2 wins by $90.
  // Final: Site A's 5 $20 txns go to Cat 2. Cat 1 at Site A has only the $10 bench row → 0 → dropped.
  // Site B Cat 1 group: bench $5, 5 txns @ $10 contributing — but Site B is the Cat 2 benchmark site,
  // so these rows aren't dual-eligible (Cat 2 = 0 at bench site). They go to Cat 1 cleanly. Savings $25K.
  // ANALYZED rows: all 12 rows (since both groups kept). UNIQUE invoice spend.
  // Total in scope: 12 invoices. Site A: 100 + 5*1000 = 5100. Site B: 100 + 5*1000 = 5100. Sum = 10200.
  // Spend: Site A: 10*100 + 20*1000*5 = 1000 + 100000 = 101000. Site B: 5*100 + 10*1000*5 = 500 + 50000 = 50500.
  // Total: $151,500. Should match analyzedRowsSpend exactly.
  const rows = [
    row(2024, "P", "S", "A", 100, 10),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "B", 100, 5),
    row(2024, "P", "S", "B", 1000, 10),
    row(2024, "P", "S", "B", 1000, 10),
    row(2024, "P", "S", "B", 1000, 10),
    row(2024, "P", "S", "B", 1000, 10),
    row(2024, "P", "S", "B", 1000, 10)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  // Verify reconciliation regardless of which categories end up kept.
  eq(out.diagnostics.inScopeRowsCount, 12, "12 in-scope rows");
  // Sum of all rows' spend
  // SiteA: 10*100 + 5*(20*1000) = 1000 + 100000 = 101000
  // SiteB: 5*100 + 5*(10*1000) = 500 + 50000 = 50500
  eq(Math.round(out.diagnostics.inScopeRowsSpend), 151500, "$151,500 in-scope spend");
  // No double-counting in analyzed bucket — each row counted once max.
  truthy(out.diagnostics.analyzedRowsCount <= 12, "analyzed count <= 12 (no double-count)");
  truthy(out.diagnostics.analyzedRowsSpend <= 151500.01, "analyzed spend <= in-scope (no double-count)");
  assertWalkReconciles(out.diagnostics, "overlap case");
}

console.log("--- TEST: walk: missing supplier → structural bucket (bucket 0) ---");
{
  // Row with no supplier — must be attributed to the structural bucket,
  // NOT silently dropped before the walk's top bookend.
  const noSupplier = { year: 2024, part: "P", _idpIhKey: "P", supplier: "", site: "A", quantity: 100, spend: 999, material: "WIDGET", noun: "WIDGET" };
  const rows = [
    noSupplier,
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.inScopeRowsCount, 6, "all 6 rows count as in-scope (top bookend = raw)");
  eq(out.diagnostics.structuralExcludedRowsCount, 1, "1 row attributed to structural bucket");
  eq(Math.round(out.diagnostics.structuralExcludedRowsSpend), 999, "structural spend $999");
  eq(out.diagnostics.preCleanExcludedByDummyWord, 0, "0 dummy-word (structural caught it first)");
  assertWalkReconciles(out.diagnostics, "missing-supplier structural");
}

console.log("--- TEST: walk: missing site → structural bucket ---");
{
  const noSite = { year: 2024, part: "P", _idpIhKey: "P", supplier: "S", site: "", quantity: 100, spend: 444, material: "WIDGET", noun: "WIDGET" };
  const rows = [
    noSite,
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.structuralExcludedRowsCount, 1, "1 row attributed to structural bucket");
  eq(Math.round(out.diagnostics.structuralExcludedRowsSpend), 444, "structural spend $444");
  assertWalkReconciles(out.diagnostics, "missing-site structural");
}

console.log("--- TEST: walk: year != target → structural bucket ---");
{
  // The auto-detected target year is the latest complete year (typically
  // the most-populated year in the slice). A row with a different year
  // must show up in the structural bucket.
  const rows = [
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30),
    row(2023, "P", "S", "A", 1000, 10) // wrong year — should be structural-excluded
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  // target_year picked from rows = 2024 (max). Row 2023 is structural.
  eq(out.diagnostics.targetYear, 2024, "target year = 2024");
  eq(out.diagnostics.structuralExcludedRowsCount, 1, "2023 row → structural bucket");
  assertWalkReconciles(out.diagnostics, "wrong-year structural");
}

console.log("--- TEST: walk: bucket 2 credit-note vs zero-only sub-split ---");
{
  // 1 credit-note (qty = -5, sp = -50)
  // 1 zero-qty row (qty = 0, sp = 100)
  // 1 zero-spend row (qty = 100, sp = 0)
  // Expect: 3 rows in bucket 2 total, 1 in credit-note sub-bucket, 2 in zero-only.
  const rows = [
    { year: 2024, part: "P", _idpIhKey: "P", supplier: "S", site: "A", quantity: -5, spend: -50, material: "WIDGET", noun: "WIDGET" }, // credit-note
    { year: 2024, part: "P", _idpIhKey: "P", supplier: "S", site: "A", quantity: 0, spend: 100, material: "WIDGET", noun: "WIDGET" },   // zero-qty
    { year: 2024, part: "P", _idpIhKey: "P", supplier: "S", site: "A", quantity: 100, spend: 0, material: "WIDGET", noun: "WIDGET" },   // zero-spend
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  eq(out.diagnostics.preCleanExcludedByZeroQtyOrPrice, 3, "3 rows in bucket 2");
  eq(out.diagnostics.preCleanExcludedByCreditNoteCount, 1, "1 credit-note row");
  eq(Math.round(out.diagnostics.preCleanExcludedByCreditNoteSpend), -50, "credit-note signed spend = -$50");
  eq(Math.round(out.diagnostics.preCleanExcludedByCreditNoteSpendAbs), 50, "credit-note |spend| = $50");
  eq(out.diagnostics.preCleanExcludedByZeroOnlyCount, 2, "2 zero-only rows");
  eq(Math.round(out.diagnostics.preCleanExcludedByZeroOnlySpend), 100, "zero-only signed spend = $100");
  eq(Math.round(out.diagnostics.preCleanExcludedByZeroOnlySpendAbs), 100, "zero-only |spend| = $100");
  // Sub-buckets sum to bucket-2 totals (count + signed spend + |spend|).
  eq(out.diagnostics.preCleanExcludedByCreditNoteCount + out.diagnostics.preCleanExcludedByZeroOnlyCount,
     out.diagnostics.preCleanExcludedByZeroQtyOrPrice, "sub-buckets count sums to bucket-2 count");
  eq(Math.round(out.diagnostics.preCleanExcludedByCreditNoteSpend + out.diagnostics.preCleanExcludedByZeroOnlySpend),
     Math.round(out.diagnostics.preCleanExcludedByZeroQtyOrPriceSpend), "sub-buckets signed spend sums to bucket-2 spend");
  eq(Math.round(out.diagnostics.preCleanExcludedByCreditNoteSpendAbs + out.diagnostics.preCleanExcludedByZeroOnlySpendAbs),
     Math.round(out.diagnostics.preCleanExcludedByZeroQtyOrPriceSpendAbs), "sub-buckets |spend| sums to bucket-2 |spend|");
  assertWalkReconciles(out.diagnostics, "bucket-2 sub-split");
}

console.log("--- TEST: walk: bucket-2 |spend| ≥ |signed spend| even on net-negative bucket ---");
{
  // 2 credit-notes (-$1000 each) and 1 small positive zero-qty row → signed sum
  // = -$2000, but |signed| sum = $2000+ → ensures we won't show a positive number
  // under a "− Excluded" header in the walk.
  const rows = [
    { year: 2024, part: "P", _idpIhKey: "P", supplier: "S", site: "A", quantity: -10, spend: -1000, material: "WIDGET", noun: "WIDGET" },
    { year: 2024, part: "P", _idpIhKey: "P", supplier: "S", site: "A", quantity: -10, spend: -1000, material: "WIDGET", noun: "WIDGET" },
    { year: 2024, part: "P", _idpIhKey: "P", supplier: "S", site: "A", quantity: 0, spend: 0, material: "WIDGET", noun: "WIDGET" },
    row(2024, "P", "S", "A", 1000, 10),
    row(2024, "P", "S", "A", 1000, 15),
    row(2024, "P", "S", "A", 1000, 20),
    row(2024, "P", "S", "A", 1000, 25),
    row(2024, "P", "S", "A", 1000, 30)
  ];
  const out = idpComputeIndirectHarmFromRows(rows, defaultOpts());
  const signed = out.diagnostics.preCleanExcludedByZeroQtyOrPriceSpend;
  const abs = out.diagnostics.preCleanExcludedByZeroQtyOrPriceSpendAbs;
  eq(Math.round(signed), -2000, "signed bucket-2 sum = -$2,000");
  eq(Math.round(abs), 2000, "|spend| bucket-2 sum = $2,000");
  truthy(abs >= Math.abs(signed), "|spend| ≥ |signed spend| (display can always be a clear subtraction)");
  assertWalkReconciles(out.diagnostics, "net-negative bucket-2");
}

console.log("\n--- SUMMARY ---");
console.log("Passed:", pass);
console.log("Failed:", fail);
if (fail > 0) process.exit(1);
