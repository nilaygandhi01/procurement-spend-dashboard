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
//
// Fuzzy keying is done here (mirrors the browser-side prep). Run:
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
const MAX_PRICE_RATIO = 100;
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

// --- Filter to L1 = Indirect ------------------------------------------------
const indirect = rows.filter(r => {
  if (!r) return false;
  const c1 = String(r.category_l1 != null ? r.category_l1 : r.c1 != null ? r.c1 : "").trim().toLowerCase();
  return c1 === "indirect" || c1 === "indirects";
});
console.log("Indirect rows:", indirect.length);

// --- Build part keys: numeric-bearing Part Number wins; else fuzzy ----------
const fuzzyCandidates = [];
let keyedByPartNum = 0;
for (let i = 0; i < indirect.length; i++) {
  const r = indirect[i];
  const part = r.part != null ? String(r.part).trim() : "";
  if (part && /\d/.test(part)) {
    r._idpIhKey = part;
    keyedByPartNum++;
  } else {
    r._idpIhKey = "";
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

// --- Fuzzy cluster + similarity sanity check --------------------------------
const tokenSets = fuzzyCandidates.map(c => IDPMATH.normalizeNameForFuzzy(c.name, { threshold: FUZZY_THRESHOLD }).tokens);
const clusterRes = IDPMATH.fuzzyClusterNames(fuzzyCandidates, { threshold: FUZZY_THRESHOLD });
let clustersFormed = 0, clustersSplit = 0;
const clusters = clusterRes.clusters || [];
for (let cl = 0; cl < clusters.length; cl++) {
  const c = clusters[cl];
  if (!c || !c.members || !c.members.length) continue;
  clustersFormed++;
  let members = c.members.slice();
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
  const clusterKey = "IH#FUZZY#" + cl;
  for (let mi = 0; mi < members.length; mi++) {
    const sliceIdx = fuzzyCandidates[members[mi]].id;
    if (indirect[sliceIdx]) indirect[sliceIdx]._idpIhKey = clusterKey;
  }
}
console.log("Fuzzy clusters formed:", clustersFormed);
console.log("Clusters split by similarity check:", clustersSplit);

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
  minTransactions: MIN_TRANSACTIONS,
  minSavingsUsd: MIN_SAVINGS_USD,
  cat2MinBenchmarkSiteTxns: CAT2_MIN_BENCHMARK_SITE_TXNS
});
console.log("Math took", (Date.now() - t1) + "ms");
const d = out.diagnostics;

function fmtUsd(n) { return "$" + Math.round(n).toLocaleString(); }
function fmtInt(n) { return (n || 0).toLocaleString(); }

console.log("\n========== VERIFICATION REPORT ==========");
console.log("Target year:", d.targetYear);
console.log("Rows fed to math:", fmtInt(d.rawRowsIn));

console.log("\n--- Pre-clean exclusions ---");
console.log("  · dummy/sample/test/etc word:   ", fmtInt(d.preCleanExcludedByDummyWord));
console.log("  · qty ≤ 0 or unit price ≤ 0:    ", fmtInt(d.preCleanExcludedByZeroQtyOrPrice));
console.log("  · line spend < $" + MIN_LINE_SPEND_USD + ":              ", fmtInt(d.preCleanExcludedByMinLineSpend));
console.log("  · unit price < $" + MIN_UNIT_PRICE_USD + ":             ", fmtInt(d.preCleanExcludedByMinUnitPrice));
console.log("Rows surviving pre-clean:           ", fmtInt(d.rowsAfterPreClean));
console.log("  · keyed by Part #:                ", fmtInt(d.rowsKeyedByPartNum));
console.log("  · keyed by fuzzy desc:            ", fmtInt(d.rowsKeyedByFuzzy));

console.log("\n--- Totals (post-dedup) ---");
const totalOpps = (d.cat1GroupsKept || 0) + (d.cat2GroupsKept || 0);
const totalSavings = (d.cat1TotalSavings || 0) + (d.cat2TotalSavings || 0);
console.log("Total qualifying opportunities:", fmtInt(totalOpps));
console.log("Total savings:                 ", fmtUsd(totalSavings));

console.log("\n--- Per-category breakdown (post-dedup) ---");
console.log("Cat 1 — Same Supplier, Same Site, Single-Invoice Rightsizing (high confidence):");
console.log("  Opps:        ", fmtInt(d.cat1GroupsKept));
console.log("  Savings:     ", fmtUsd(d.cat1TotalSavings));
console.log("Cat 2 — Same Supplier, Different Sites, Cross-Site Rightsizing to Site Average (medium confidence):");
console.log("  Opps:        ", fmtInt(d.cat2GroupsKept));
console.log("  Savings:     ", fmtUsd(d.cat2TotalSavings));

console.log("\n--- Group-level filter exclusions (Cat 1) ---");
console.log("  · < " + MIN_TRANSACTIONS + " transactions:           ", fmtInt(d.cat1ExcludedByMinTransactions));
console.log("  · benchmark < $" + MIN_BENCHMARK_USD + ":              ", fmtInt(d.cat1ExcludedByMinBenchmark));
console.log("  · ratio > " + MAX_PRICE_RATIO + "x:               ", fmtInt(d.cat1ExcludedByMaxRatio));
console.log("  · post-dedup savings < $" + MIN_SAVINGS_USD + ":  ", fmtInt(d.cat1ExcludedByMinSavings));

console.log("\n--- Group-level filter exclusions (Cat 2) ---");
console.log("  · < " + MIN_TRANSACTIONS + " transactions:                  ", fmtInt(d.cat2ExcludedByMinTransactions));
console.log("  · only one site:                     ", fmtInt(d.cat2ExcludedByOneSite));
console.log("  · no benchmark site ≥ " + CAT2_MIN_BENCHMARK_SITE_TXNS + " txns:   ", fmtInt(d.cat2ExcludedByNoEligibleBenchmarkSite));
console.log("  · benchmark < $" + MIN_BENCHMARK_USD + ":                     ", fmtInt(d.cat2ExcludedByMinBenchmark));
console.log("  · ratio > " + MAX_PRICE_RATIO + "x:                      ", fmtInt(d.cat2ExcludedByMaxRatio));
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

console.log("\nDONE.");
