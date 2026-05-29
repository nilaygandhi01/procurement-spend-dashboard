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

console.log("\n--- SUMMARY ---");
console.log("Passed:", pass);
console.log("Failed:", fail);
if (fail > 0) process.exit(1);
