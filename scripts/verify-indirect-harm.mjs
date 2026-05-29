// Run the Indirect Harmonization math layer against the real
// src/dashboard/data.json and print the verification report the user
// asked for:
//   - Total qualifying opportunities (post-dedup) and total savings
//   - Per-category breakdown (Cat 1 / Cat 2)
//   - Pre-clean exclusions by rule
//   - Group-level filter exclusions by reason
//   - Dedup reassignment counts
//   - Fuzzy clusters formed + split by similarity check
//   - Top 5 opportunities per category
//   - The FULL Assumption Walk (12 rows, reconciles to the dollar)
//
// Fuzzy keying mirrors the browser-side prep, including the singleton-
// vs-sanity-split distinction the in-app walk uses.
//
// Run:
//   node --max-old-space-size=8192 scripts/verify-indirect-harm.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// --- Load math + index-math helpers ----------------------------------------
const harmJs = fs.readFileSync(path.join(repoRoot, "src", "dashboard", "harmonization-client.js"), "utf8");
const shim = {};
new Function("window", harmJs)(shim);
const compute = shim.idpComputeIndirectHarmFromRows;
const indexMathUrl = "file:///" + path.join(repoRoot, "src", "dashboard", "index-math.mjs").replace(/\\/g, "/");
const indexMathMod = await import(indexMathUrl);
const IDPMATH = indexMathMod && (indexMathMod.default || indexMathMod);

// --- Constants (mirror INDIRECT_HARM_* in index.html) ----------------------
const FUZZY_THRESHOLD = 0.80;
const MIN_BENCHMARK_USD = 1.00;
const MAX_PRICE_RATIO = 20;
const MAX_QTY_RATIO = 10;
const MIN_BENCHMARK_VOLUME_SHARE = 0.10;
const MIN_TRANSACTIONS = 5;
const MIN_SAVINGS_USD = 5000;
const MIN_LINE_SPEND_USD = 50;
const MIN_UNIT_PRICE_USD = 0.05;
const CAT2_MIN_BENCHMARK_SITE_TXNS = 3;
const DUMMY_WORDS = ["dummy", "sample", "test", "ncr", "return", "credit", "adjustment", "void", "reversal", "placeholder"];

// --- Load data.json ---------------------------------------------------------
console.log("Loading data.json...");
const start = Date.now();
const data = JSON.parse(fs.readFileSync(path.join(repoRoot, "src", "dashboard", "data.json"), "utf8"));
const rows = data.rows || [];
console.log("Total rows:", rows.length, "(" + (Date.now() - start) + "ms)");

// --- Filter to L1 = Indirect, Time = 2025 -----------------------------------
// Mirror the live dashboard's filter state at the user's documented anchor
// (Time = 2025, all category/region/supplier filters = "All"). The Time
// filter is applied UPSTREAM in the dashboard, so `allRowsFiltered`
// already excludes other years before the IH math runs. Replicating that
// here is what makes the walk's top-bookend equal the Spend Overview KPI
// tile ($388.1M / ~61.9k invoices) instead of the multi-year mix.
function rowYearLocal(r) {
  const y = +r.year;
  if (y >= 1990 && y <= 2100) return y;
  const ym = r.ym != null ? String(r.ym) : "";
  let m = ym.match(/(20[0-2][0-9])/);
  if (m) return +m[1];
  const d = r.d;
  if (d) { m = String(d).match(/(20[0-2][0-9])/); if (m) return +m[1]; }
  return 0;
}
const TARGET_TIME_YEAR = 2025;
const indirect = rows.filter(r => {
  if (!r) return false;
  const c1 = String(r.category_l1 != null ? r.category_l1 : r.c1 != null ? r.c1 : "").trim().toLowerCase();
  if (c1 !== "indirect" && c1 !== "indirects") return false;
  return rowYearLocal(r) === TARGET_TIME_YEAR;
});
console.log("Indirect rows (Time=" + TARGET_TIME_YEAR + "):", indirect.length);
let _indSpendSanity = 0;
for (const r of indirect) {
  const v = +(r.spend != null ? r.spend : 0);
  if (Number.isFinite(v)) _indSpendSanity += v;
}
console.log("  signed spend:", "$" + Math.round(_indSpendSanity).toLocaleString(),
            "(should match Spend Overview KPI tile)");

// --- Build part keys: numeric-bearing Part Number wins; else fuzzy ----------
// Mirrors src/dashboard/index.html → _idpIhBuildPrep precisely so that
// the same singleton-vs-sanity-split attribution is applied here.
const fuzzyCandidates = [];
let keyedByPartNum = 0;
for (let i = 0; i < indirect.length; i++) {
  const r = indirect[i];
  const part = r.part != null ? String(r.part).trim() : "";
  if (part && /\d/.test(part)) {
    r._idpIhKey = part;
    keyedByPartNum++;
  } else {
    r._idpIhKey = null;
    let name = "";
    if (r.noun) name = String(r.noun).trim();
    else if (r.material) name = String(r.material).trim();
    else if (r.category_l3) name = String(r.category_l3).trim();
    else if (r.c3) name = String(r.c3).trim();
    fuzzyCandidates.push({ id: i, name, block: r.category_l3 != null ? String(r.category_l3) : (r.c3 != null ? String(r.c3) : "") });
  }
}
console.log("Keyed by Part #:", keyedByPartNum);
console.log("Fuzzy candidates:", fuzzyCandidates.length);

// --- Fuzzy cluster + similarity sanity check (mirrors _idpIhBuildPrep) -------
const tokenSets = fuzzyCandidates.map(c => IDPMATH.normalizeNameForFuzzy(c.name, { threshold: FUZZY_THRESHOLD }).tokens);
const clusterRes = IDPMATH.fuzzyClusterNames(fuzzyCandidates, { threshold: FUZZY_THRESHOLD });
let clustersFormed = 0, clustersSplit = 0;
const clusters = clusterRes.clusters || [];
for (let cl = 0; cl < clusters.length; cl++) {
  const c = clusters[cl];
  if (!c || !c.members || !c.members.length) continue;
  clustersFormed++;
  /* Singleton clusters: don't key. Their rows fall through to the
     Step 4 fallback below which tags them "singleton". */
  if (c.members.length < 2) {
    const sliceIdx = fuzzyCandidates[c.members[0]].id;
    if (indirect[sliceIdx] && indirect[sliceIdx]._idpIhKey == null) {
      indirect[sliceIdx]._idpIhClusterFate = "singleton";
    }
    continue;
  }
  let members = c.members.slice();
  const origSet = new Set(c.members);
  let split = false;
  let maxIters = members.length;
  while (members.length >= 2 && maxIters-- > 0) {
    let worstIdx = -1, worstMean = Infinity, anyBad = false;
    for (let i = 0; i < members.length; i++) {
      let sum = 0, n = 0;
      for (let j = 0; j < members.length; j++) {
        if (i === j) continue;
        const sim = IDPMATH.tokenJaccard(tokenSets[members[i]], tokenSets[members[j]]);
        if (sim < FUZZY_THRESHOLD) anyBad = true;
        sum += sim; n++;
      }
      const mean = n ? sum / n : 0;
      if (mean < worstMean) { worstMean = mean; worstIdx = i; }
    }
    if (!anyBad) break;
    members.splice(worstIdx, 1);
    split = true;
  }
  if (split) clustersSplit++;
  const keptSet = new Set(members);
  // Members dropped by sanity check → sanity_split fate.
  for (const memberIdx of origSet) {
    if (!keptSet.has(memberIdx)) {
      const sliceIdx = fuzzyCandidates[memberIdx].id;
      if (indirect[sliceIdx] && indirect[sliceIdx]._idpIhKey == null) {
        indirect[sliceIdx]._idpIhClusterFate = "sanity_split";
      }
    }
  }
  // If cluster collapsed to <2 after sanity check, treat remaining
  // members as sanity_split too (same as in _idpIhBuildPrep).
  if (members.length < 2) {
    for (const memberIdx of members) {
      const sliceIdx = fuzzyCandidates[memberIdx].id;
      if (indirect[sliceIdx] && indirect[sliceIdx]._idpIhKey == null) {
        indirect[sliceIdx]._idpIhClusterFate = "sanity_split";
      }
    }
    continue;
  }
  const clusterKey = "IH#FUZZY#" + cl;
  for (const memberIdx of members) {
    const sliceIdx = fuzzyCandidates[memberIdx].id;
    if (indirect[sliceIdx]) indirect[sliceIdx]._idpIhKey = clusterKey;
  }
}
// Step 4: anything still null is a singleton (no cluster created at all).
let singletonsTagged = 0, sanitySplitTagged = 0;
for (let i = 0; i < indirect.length; i++) {
  const r = indirect[i];
  if (!r) continue;
  if (r._idpIhKey == null) {
    if (!r._idpIhClusterFate) r._idpIhClusterFate = "singleton";
    r._idpIhKey = "";
  }
  if (r._idpIhClusterFate === "singleton") singletonsTagged++;
  else if (r._idpIhClusterFate === "sanity_split") sanitySplitTagged++;
}
console.log("Fuzzy clusters formed:", clustersFormed);
console.log("Clusters split by similarity check:", clustersSplit);
console.log("Singleton rows tagged:", singletonsTagged);
console.log("Sanity-split rows tagged:", sanitySplitTagged);

// --- Run math ---------------------------------------------------------------
console.log("\nRunning idpComputeIndirectHarmFromRows...");
const t1 = Date.now();
const out = compute(indirect, {
  partKeyFn: r => r._idpIhKey || "",
  dummyWords: DUMMY_WORDS,
  minLineSpendUsd: MIN_LINE_SPEND_USD,
  minUnitPriceUsd: MIN_UNIT_PRICE_USD,
  minBenchmarkUsd: MIN_BENCHMARK_USD,
  maxPriceRatio: MAX_PRICE_RATIO,
  maxQtyRatio: MAX_QTY_RATIO,
  minBenchmarkVolumeShare: MIN_BENCHMARK_VOLUME_SHARE,
  minTransactions: MIN_TRANSACTIONS,
  minSavingsUsd: MIN_SAVINGS_USD,
  cat2MinBenchmarkSiteTxns: CAT2_MIN_BENCHMARK_SITE_TXNS
});
console.log("Math took", (Date.now() - t1) + "ms");
const d = out.diagnostics;

function fmtUsd(n) { return "$" + Math.round(n).toLocaleString(); }
function fmtInt(n) { return (n || 0).toLocaleString(); }
function fmtNegInt(n) {
  if (!n) return "0";
  if (n > 0) return "-" + Math.round(n).toLocaleString();
  return Math.round(n).toLocaleString();
}
function fmtNegUsd(n) {
  if (!n) return "$0";
  if (n > 0) return "-$" + Math.round(n).toLocaleString();
  return "$" + Math.round(Math.abs(n)).toLocaleString();
}

console.log("\n========== VERIFICATION REPORT ==========");
console.log("Target year:", d.targetYear);
console.log("Rows fed to math:", fmtInt(d.rawRowsIn));
console.log("In-scope rows (every indirect invoice, top bookend):",
            fmtInt(d.inScopeRowsCount), "spend", fmtUsd(d.inScopeRowsSpend));
console.log("Structural exclusions (missing supplier/site/year):",
            fmtInt(d.structuralExcludedRowsCount), "|spend|", fmtUsd(d.structuralExcludedRowsSpendAbs),
            "(signed", fmtUsd(d.structuralExcludedRowsSpend) + ")");

console.log("\n--- Pre-clean exclusions ---");
console.log("  · dummy/sample/test/etc word:   ", fmtInt(d.preCleanExcludedByDummyWord),
            "(|spend|", fmtUsd(d.preCleanExcludedByDummyWordSpendAbs), ")");
console.log("  · qty ≤ 0 or unit price ≤ 0:    ", fmtInt(d.preCleanExcludedByZeroQtyOrPrice),
            "(|spend|", fmtUsd(d.preCleanExcludedByZeroQtyOrPriceSpendAbs),
            "; signed", fmtUsd(d.preCleanExcludedByZeroQtyOrPriceSpend) + ")");
console.log("      of which credit-notes/returns: ",
            fmtInt(d.preCleanExcludedByCreditNoteCount),
            "(|spend|", fmtUsd(d.preCleanExcludedByCreditNoteSpendAbs), ")");
console.log("      of which literal zero qty/price: ",
            fmtInt(d.preCleanExcludedByZeroOnlyCount),
            "(|spend|", fmtUsd(d.preCleanExcludedByZeroOnlySpendAbs), ")");
console.log("  · line spend < $" + MIN_LINE_SPEND_USD + ":              ", fmtInt(d.preCleanExcludedByMinLineSpend),
            "(|spend|", fmtUsd(d.preCleanExcludedByMinLineSpendSpendAbs), ")");
console.log("  · unit price < $" + MIN_UNIT_PRICE_USD + ":             ", fmtInt(d.preCleanExcludedByMinUnitPrice),
            "(|spend|", fmtUsd(d.preCleanExcludedByMinUnitPriceSpendAbs), ")");
console.log("Rows surviving pre-clean:           ", fmtInt(d.rowsAfterPreClean));
console.log("  · keyed by Part #:                ", fmtInt(d.rowsKeyedByPartNum));
console.log("  · keyed by fuzzy desc:            ", fmtInt(d.rowsKeyedByFuzzy));
console.log("  · sanity-split (no key):          ", fmtInt(d.excludedBySanitySplitRowsCount),
            "(|spend|", fmtUsd(d.excludedBySanitySplitRowsSpendAbs), ")");
console.log("  · singleton (no key):             ", fmtInt(d.excludedAsSingletonRowsCount),
            "(|spend|", fmtUsd(d.excludedAsSingletonRowsSpendAbs), ")");

console.log("\n--- Totals (post-dedup) ---");
const totalOpps = (d.cat1GroupsKept || 0) + (d.cat2GroupsKept || 0);
const totalSavings = (d.cat1TotalSavings || 0) + (d.cat2TotalSavings || 0);
console.log("Total qualifying opportunities:", fmtInt(totalOpps));
console.log("Total savings:                 ", fmtUsd(totalSavings));
console.log("Analyzed rows (unique):        ", fmtInt(d.analyzedRowsCount), "spend", fmtUsd(d.analyzedRowsSpend));

console.log("\n--- Per-category breakdown (post-dedup) ---");
console.log("Cat 1 — Same Supplier, Same Site, Single-Invoice Rightsizing (high confidence):");
console.log("  Opps:        ", fmtInt(d.cat1GroupsKept));
console.log("  Savings:     ", fmtUsd(d.cat1TotalSavings));
console.log("Cat 2 — Same Supplier, Different Sites, Cross-Site Rightsizing to Site Average (medium confidence):");
console.log("  Opps:        ", fmtInt(d.cat2GroupsKept));
console.log("  Savings:     ", fmtUsd(d.cat2TotalSavings));

console.log("\n--- Group-level row attribution (per-row, post-emit, post-dedup) ---");
console.log("  · group < " + MIN_TRANSACTIONS + " txns:                 ", fmtInt(d.groupExcludedByMinTransactionsRowsCount),
            "(|spend|", fmtUsd(d.groupExcludedByMinTransactionsRowsSpendAbs),
            "; signed", fmtUsd(d.groupExcludedByMinTransactionsRowsSpend) + ")");
console.log("  · group savings < $" + MIN_SAVINGS_USD + ":           ", fmtInt(d.groupExcludedByMinSavingsRowsCount),
            "(|spend|", fmtUsd(d.groupExcludedByMinSavingsRowsSpendAbs),
            "; signed", fmtUsd(d.groupExcludedByMinSavingsRowsSpend) + ")");
console.log("  · group benchmark < $" + MIN_BENCHMARK_USD + ":           ", fmtInt(d.groupExcludedByMinBenchmarkRowsCount),
            "(|spend|", fmtUsd(d.groupExcludedByMinBenchmarkRowsSpendAbs),
            "; signed", fmtUsd(d.groupExcludedByMinBenchmarkRowsSpend) + ")");
console.log("  · group max/min ratio > " + MAX_PRICE_RATIO + "x:        ", fmtInt(d.groupExcludedByMaxRatioRowsCount),
            "(|spend|", fmtUsd(d.groupExcludedByMaxRatioRowsSpendAbs),
            "; signed", fmtUsd(d.groupExcludedByMaxRatioRowsSpend) + ")");
console.log("  · group UoM-mismatch fingerprint:        ", fmtInt(d.groupExcludedByQtyBandRowsCount),
            "(|spend|", fmtUsd(d.groupExcludedByQtyBandRowsSpendAbs),
            "; signed", fmtUsd(d.groupExcludedByQtyBandRowsSpend) + ")");
console.log("  · group benchmark < " + Math.round(MIN_BENCHMARK_VOLUME_SHARE * 100) + "% of group vol:", fmtInt(d.groupExcludedByBenchShareRowsCount),
            "(|spend|", fmtUsd(d.groupExcludedByBenchShareRowsSpendAbs),
            "; signed", fmtUsd(d.groupExcludedByBenchShareRowsSpend) + ")");

console.log("\n--- Group-level filter exclusions (Cat 1 group counts) ---");
console.log("  · < " + MIN_TRANSACTIONS + " transactions:           ", fmtInt(d.cat1ExcludedByMinTransactions));
console.log("  · benchmark < $" + MIN_BENCHMARK_USD + ":              ", fmtInt(d.cat1ExcludedByMinBenchmark));
console.log("  · ratio > " + MAX_PRICE_RATIO + "x:               ", fmtInt(d.cat1ExcludedByMaxRatio));
console.log("  · UoM-mismatch fingerprint:        ", fmtInt(d.cat1ExcludedByQtyBand));
console.log("  · benchmark < " + Math.round(MIN_BENCHMARK_VOLUME_SHARE * 100) + "% of group vol:", fmtInt(d.cat1ExcludedByBenchShare));
console.log("  · post-dedup savings < $" + MIN_SAVINGS_USD + ":  ", fmtInt(d.cat1ExcludedByMinSavings));

console.log("\n--- Group-level filter exclusions (Cat 2 group counts) ---");
console.log("  · < " + MIN_TRANSACTIONS + " transactions:                  ", fmtInt(d.cat2ExcludedByMinTransactions));
console.log("  · only one site:                     ", fmtInt(d.cat2ExcludedByOneSite));
console.log("  · no benchmark site ≥ " + CAT2_MIN_BENCHMARK_SITE_TXNS + " txns:   ", fmtInt(d.cat2ExcludedByNoEligibleBenchmarkSite));
console.log("  · benchmark < $" + MIN_BENCHMARK_USD + ":                     ", fmtInt(d.cat2ExcludedByMinBenchmark));
console.log("  · ratio > " + MAX_PRICE_RATIO + "x:                      ", fmtInt(d.cat2ExcludedByMaxRatio));
console.log("  · UoM-mismatch fingerprint:                  ", fmtInt(d.cat2ExcludedByQtyBand));
console.log("  · benchmark < " + Math.round(MIN_BENCHMARK_VOLUME_SHARE * 100) + "% of group vol:        ", fmtInt(d.cat2ExcludedByBenchShare));
console.log("  · post-dedup savings < $" + MIN_SAVINGS_USD + ":         ", fmtInt(d.cat2ExcludedByMinSavings));

console.log("\n--- De-duplication ---");
console.log("Transactions reassigned:", fmtInt(d.dedupReassignmentsTotal));
console.log("  · → Cat 1:           ", fmtInt(d.dedupReassignedToCat1));
console.log("  · → Cat 2:           ", fmtInt(d.dedupReassignedToCat2));
console.log("  · ties → Cat 1:      ", fmtInt(d.dedupTiesResolvedToCat1));

console.log("\n--- Top 5 — Cat 1 (high confidence) ---");
const t1Top = d.cat1Top5 || [];
if (!t1Top.length) console.log("  (none)");
else t1Top.forEach((t, i) => {
  console.log(`  ${i + 1}. ${t.item || "—"} @ ${t.site || "—"} / ${t.supplier || "—"}`);
  console.log(`     savings ${fmtUsd(t.savings)} | benchmark $${(+t.benchmark || 0).toFixed(2)} | spend ${fmtUsd(t.total_spend)}`);
});

console.log("\n--- Top 5 — Cat 2 (medium confidence) ---");
const t2Top = d.cat2Top5 || [];
if (!t2Top.length) console.log("  (none)");
else t2Top.forEach((t, i) => {
  console.log(`  ${i + 1}. ${t.item || "—"} across ${t.site_count || 0} sites / ${t.supplier || "—"}`);
  console.log(`     savings ${fmtUsd(t.savings)} | benchmark $${(+t.benchmark || 0).toFixed(2)}${t.benchmark_site ? " @ " + t.benchmark_site : ""} | spend ${fmtUsd(t.total_spend)}`);
});

console.log("\n--- Fuzzy keying ---");
console.log("Total fuzzy clusters formed:        ", fmtInt(clustersFormed));
console.log("Clusters split by similarity check: ", fmtInt(clustersSplit));

/* ============== FULL ASSUMPTION WALK ============== */
console.log("\n========== ASSUMPTION WALK ==========");
console.log("How we got from total indirect line items (year " + (d.targetYear || "?") + ", post global filter) to analyzed spend.");
console.log("Counts are ERP line items (rows in data.json), not deduplicated PO invoices.\n");
/* Walk row tuple: [label, count (positive for bookends, positive
   integer for exclusion rows — sign added at render time), |spend|,
   isBookend, signedSpend (for reconciliation only)]. Exclusion rows
   render |spend| as a negative subtraction so credit-notes don't
   appear to grow the pool. */
const _vTy = (d.targetYear != null && +d.targetYear > 0) ? +d.targetYear : null;
const _vYrTag = _vTy ? " · year " + _vTy : "";
const walkRows = [
  ["Total indirect line items (in scope" + _vYrTag + ", post global Spend Review filters)",
   d.inScopeRowsCount, d.inScopeRowsSpend, true, d.inScopeRowsSpend],
  ["- Excluded: missing supplier, missing site, or out-of-scope year (structural)",
   (d.structuralExcludedRowsCount || 0),
   (d.structuralExcludedRowsSpendAbs || 0), false,
   (d.structuralExcludedRowsSpend || 0)],
  ["- Excluded: dummy/sample/test/NCR/return/credit/adjustment/void/reversal/placeholder wording",
   (d.preCleanExcludedByDummyWord || 0),
   (d.preCleanExcludedByDummyWordSpendAbs || 0), false,
   (d.preCleanExcludedByDummyWordSpend || 0)],
  ["- Excluded: quantity <= 0 or unit price <= 0",
   (d.preCleanExcludedByZeroQtyOrPrice || 0),
   (d.preCleanExcludedByZeroQtyOrPriceSpendAbs || 0), false,
   (d.preCleanExcludedByZeroQtyOrPriceSpend || 0)],
  ["- Excluded: line spend < $" + MIN_LINE_SPEND_USD,
   (d.preCleanExcludedByMinLineSpend || 0),
   (d.preCleanExcludedByMinLineSpendSpendAbs || 0), false,
   (d.preCleanExcludedByMinLineSpendSpend || 0)],
  ["- Excluded: unit price < $" + MIN_UNIT_PRICE_USD,
   (d.preCleanExcludedByMinUnitPrice || 0),
   (d.preCleanExcludedByMinUnitPriceSpendAbs || 0), false,
   (d.preCleanExcludedByMinUnitPriceSpend || 0)],
  ["- Excluded: group had fewer than " + MIN_TRANSACTIONS + " transactions",
   (d.groupExcludedByMinTransactionsRowsCount || 0),
   (d.groupExcludedByMinTransactionsRowsSpendAbs || 0), false,
   (d.groupExcludedByMinTransactionsRowsSpend || 0)],
  ["- Excluded: group total savings < $" + MIN_SAVINGS_USD.toLocaleString(),
   (d.groupExcludedByMinSavingsRowsCount || 0),
   (d.groupExcludedByMinSavingsRowsSpendAbs || 0), false,
   (d.groupExcludedByMinSavingsRowsSpend || 0)],
  ["- Excluded: group benchmark < $" + MIN_BENCHMARK_USD.toFixed(2),
   (d.groupExcludedByMinBenchmarkRowsCount || 0),
   (d.groupExcludedByMinBenchmarkRowsSpendAbs || 0), false,
   (d.groupExcludedByMinBenchmarkRowsSpend || 0)],
  ["- Excluded: group max/min price ratio > " + MAX_PRICE_RATIO + "x (tightened from 100x)",
   (d.groupExcludedByMaxRatioRowsCount || 0),
   (d.groupExcludedByMaxRatioRowsSpendAbs || 0), false,
   (d.groupExcludedByMaxRatioRowsSpend || 0)],
  ["- Excluded: group has quantity-band / price-band UoM mismatch fingerprint",
   (d.groupExcludedByQtyBandRowsCount || 0),
   (d.groupExcludedByQtyBandRowsSpendAbs || 0), false,
   (d.groupExcludedByQtyBandRowsSpend || 0)],
  ["- Excluded: benchmark anchored in < " + Math.round(MIN_BENCHMARK_VOLUME_SHARE * 100) + "% of group volume",
   (d.groupExcludedByBenchShareRowsCount || 0),
   (d.groupExcludedByBenchShareRowsSpendAbs || 0), false,
   (d.groupExcludedByBenchShareRowsSpend || 0)],
  ["- Excluded: fuzzy cluster failed similarity sanity-check",
   (d.excludedBySanitySplitRowsCount || 0),
   (d.excludedBySanitySplitRowsSpendAbs || 0), false,
   (d.excludedBySanitySplitRowsSpend || 0)],
  ["- Excluded: singleton (no Part #, no clusterable matches in description)",
   (d.excludedAsSingletonRowsCount || 0),
   (d.excludedAsSingletonRowsSpendAbs || 0), false,
   (d.excludedAsSingletonRowsSpend || 0)],
  ["Total analyzed line items (unique" + _vYrTag + " · matches IH Total Spend KPI at top)",
   d.analyzedRowsCount, d.analyzedRowsSpend, true, d.analyzedRowsSpend]
];
function padR(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; }
const colLab = 96, colCnt = 18, colSp = 22;
console.log(padR("Assumption", colLab) + padL("Line items", colCnt) + padL("Spend ($)", colSp));
console.log("-".repeat(colLab + colCnt + colSp));
for (let wi = 0; wi < walkRows.length; wi++) {
  const w = walkRows[wi];
  const isBookend = w[3];
  const lab = padR(isBookend ? w[0].toUpperCase() : w[0], colLab);
  const cnt = padL(isBookend ? fmtInt(w[1]) : "-" + (w[1] || 0).toLocaleString(), colCnt);
  const sp = padL(isBookend ? fmtUsd(w[2]) : "-$" + Math.round(w[2] || 0).toLocaleString(), colSp);
  console.log(lab + cnt + sp);
  /* Bucket-2 credit-notes vs zero-only sub-detail row. Insert as a
     small indented annotation right after bucket-2 to mirror the
     in-app render. */
  if (w[0].indexOf("- Excluded: quantity") === 0) {
    const cCnt = d.preCleanExcludedByCreditNoteCount || 0;
    const cSp = d.preCleanExcludedByCreditNoteSpendAbs || 0;
    const zCnt = d.preCleanExcludedByZeroOnlyCount || 0;
    const zSp = d.preCleanExcludedByZeroOnlySpendAbs || 0;
    if ((cCnt + zCnt) > 0) {
      console.log("    of which credit-notes/returns: " + cCnt.toLocaleString()
        + " line items / $" + Math.round(cSp).toLocaleString()
        + "; literal zero qty/price: " + zCnt.toLocaleString()
        + " line items / $" + Math.round(zSp).toLocaleString());
    }
  }
}
console.log("-".repeat(colLab + colCnt + colSp));
console.log("Note 1: counts are ERP line items (rows in data.json), not deduplicated PO invoices; one multi-line invoice contributes multiple line items.");
console.log("Note 2: exclusions applied in the order shown; each line item is attributed to the first rule that excludes it.");
console.log("Note 3: Spend column shows |line_spend| of excluded rows. Top/bottom bookends are signed totals; bookends reconcile exactly.");
console.log("        Intermediate row sums may exceed the bookend difference due to credit-note offsets.");

// Reconciliation check — uses SIGNED spend on the excluded rows (not |spend|).
const sumExclCount = walkRows.slice(1, -1).reduce((s, w) => s + (w[1] || 0), 0);
const sumExclSpendSigned = walkRows.slice(1, -1).reduce((s, w) => s + (w[4] || 0), 0);
const reconCount = (d.inScopeRowsCount || 0) - sumExclCount - (d.analyzedRowsCount || 0);
const reconSpend = (d.inScopeRowsSpend || 0) - sumExclSpendSigned - (d.analyzedRowsSpend || 0);
console.log("\n[Reconciliation check]");
console.log("  Sum(excluded counts) + analyzed - inScope (count):", reconCount === 0 ? "0 (reconciles)" : reconCount);
console.log("  Sum(excluded signed spend) + analyzed - inScope (spend):",
  Math.abs(reconSpend) < 0.01 ? "$0 (reconciles)" : "$" + reconSpend.toFixed(2));

// --- Gibson Engineering / Jacobs Vehicle Systems sanity check ---------------
// The user reported that this Cat 1 group was surfacing a ~$87K noise
// opportunity from a "1 unit at $89K vs 12 units at $1,260" UoM-mismatch
// pattern. With the new MAX_PRICE_RATIO=20 + MAX_QTY_RATIO + benchmark
// volume share guards, this group should no longer appear in cat1Opps.
console.log("\n========== GIBSON ENGINEERING / JACOBS VEHICLE SYSTEMS DRILL-DOWN ==========");
function _matchesGibsonJacobs(opp) {
  const sup = (opp.suppliers && opp.suppliers[0]) ? String(opp.suppliers[0].supplier || "").toLowerCase() : "";
  const site = (opp.suppliers && opp.suppliers[0]) ? String(opp.suppliers[0].site || "").toLowerCase() : "";
  return sup.indexOf("gibson") !== -1 && site.indexOf("jacobs") !== -1;
}
const gibsonInCat1 = (out.cat1Opps || []).filter(_matchesGibsonJacobs);
const gibsonInCat2 = (out.cat2Opps || []).filter(p => {
  const sup = (p.suppliers && p.suppliers[0]) ? String(p.suppliers[0].supplier || "").toLowerCase() : "";
  return sup.indexOf("gibson") !== -1;
});
console.log("Gibson Engineering @ Jacobs Vehicle Systems in Cat 1:", gibsonInCat1.length);
for (const opp of gibsonInCat1) {
  console.log("  ! still surfacing:", opp.item, "savings $" + Math.round(+opp.savings || 0).toLocaleString());
  const sup = opp.suppliers || [];
  for (const r of sup.slice(0, 10)) {
    console.log("     row: qty=" + r.quantity + " @ $" + Number(r.unit_price).toFixed(2) + "/u, spend $" + Number(r.spend).toLocaleString() + " (assignedCat=" + r._assignedCat + ", row_sav=$" + Number(r._rowSavings).toLocaleString() + ")");
  }
}
console.log("Gibson Engineering supplier in Cat 2:", gibsonInCat2.length);

console.log("\nDONE.");
