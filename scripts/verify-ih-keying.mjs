// Verify the Indirect Harmonization part-keying logic the user asked
// about:
//   * How many opportunities are keyed by Part Number vs by fuzzy?
//   * Of the fuzzy ones, what's the size distribution (descriptions
//     merged per cluster)?
//   * Spot-check: are any Part Numbers that are present being
//     incorrectly treated as blank and falling into fuzzy clustering?
//
// Mirrors src/dashboard/index.html → _idpIhBuildPrep precisely (same
// way verify-indirect-harm.mjs does it).
//
// Run:
//   node --max-old-space-size=8192 scripts/verify-ih-keying.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const harmJs = fs.readFileSync(path.join(repoRoot, "src", "dashboard", "harmonization-client.js"), "utf8");
const shim = {};
new Function("window", harmJs)(shim);
const compute = shim.idpComputeIndirectHarmFromRows;
const indexMathUrl = "file:///" + path.join(repoRoot, "src", "dashboard", "index-math.mjs").replace(/\\/g, "/");
const indexMathMod = await import(indexMathUrl);
const IDPMATH = indexMathMod && (indexMathMod.default || indexMathMod);

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

console.log("Loading data.json...");
const data = JSON.parse(fs.readFileSync(path.join(repoRoot, "src", "dashboard", "data.json"), "utf8"));
const rows = data.rows || [];

function rowYearLocal(r) {
  const y = +r.year;
  if (y >= 1990 && y <= 2100) return y;
  const ym = r.ym != null ? String(r.ym) : "";
  let m = ym.match(/(20[0-2][0-9])/);
  if (m) return +m[1];
  if (r.d) { m = String(r.d).match(/(20[0-2][0-9])/); if (m) return +m[1]; }
  return 0;
}
const TARGET_TIME_YEAR = 2025;
const indirect = rows.filter(r => {
  if (!r) return false;
  const c1 = String(r.category_l1 != null ? r.category_l1 : r.c1 != null ? r.c1 : "").trim().toLowerCase();
  if (c1 !== "indirect" && c1 !== "indirects") return false;
  return rowYearLocal(r) === TARGET_TIME_YEAR;
});
console.log("Indirect 2025 slice rows:", indirect.length);

// --- Mirror _idpIhBuildPrep ------------------------------------------------
// Step 1: numeric-bearing Part Number wins; else null
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

// Step 2: fuzzy cluster + similarity sanity check
const tokenSets = fuzzyCandidates.map(c => IDPMATH.normalizeNameForFuzzy(c.name, { threshold: FUZZY_THRESHOLD }).tokens);
const clusterRes = IDPMATH.fuzzyClusterNames(fuzzyCandidates, { threshold: FUZZY_THRESHOLD });
const clusters = clusterRes.clusters || [];
for (let cl = 0; cl < clusters.length; cl++) {
  const c = clusters[cl];
  if (!c || !c.members || !c.members.length) continue;
  if (c.members.length < 2) continue;
  let members = c.members.slice();
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
  }
  if (members.length < 2) continue;
  const clusterKey = "IH#FUZZY#" + cl;
  for (const memberIdx of members) {
    const sliceIdx = fuzzyCandidates[memberIdx].id;
    if (indirect[sliceIdx]) indirect[sliceIdx]._idpIhKey = clusterKey;
  }
}
// Step 4: drop rows that are still unkeyed (singletons or sanity-split)
const prepRows = indirect.filter(r => r._idpIhKey);
const fuzzyRowCount = prepRows.filter(r => r._idpIhKey.indexOf("IH#FUZZY#") === 0).length;
console.log(`Prep rows after keying: ${prepRows.length}  (Part #: ${keyedByPartNum}, Fuzzy: ${fuzzyRowCount}, Dropped as singletons/sanity-split: ${indirect.length - prepRows.length})`);

// Step 3: run math
const mathOut = compute(prepRows, {
  partKeyFn: r => r && r._idpIhKey ? r._idpIhKey : "",
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

// ------- Q1: opps by part-num vs fuzzy --------------------------------------
const cat1Opps = mathOut.cat1Opps || [];
const cat2Opps = mathOut.cat2Opps || [];
function countByKeyType(opps) {
  let p = 0, f = 0;
  for (const o of opps) {
    const k = (o && o.item != null) ? String(o.item) : "";
    if (k.indexOf("IH#FUZZY#") === 0) f++; else p++;
  }
  return { partKeyed: p, fuzzyKeyed: f };
}
const c1Split = countByKeyType(cat1Opps);
const c2Split = countByKeyType(cat2Opps);
const allOpps = cat1Opps.concat(cat2Opps);
const totalSplit = countByKeyType(allOpps);
console.log("\n" + "=".repeat(78));
console.log("Q1: OPPORTUNITIES KEYED BY PART NUMBER vs BY FUZZY");
console.log("=".repeat(78));
console.log(`Cat 1: ${cat1Opps.length} opps  →  Part #: ${c1Split.partKeyed}   Fuzzy: ${c1Split.fuzzyKeyed}`);
console.log(`Cat 2: ${cat2Opps.length} opps  →  Part #: ${c2Split.partKeyed}   Fuzzy: ${c2Split.fuzzyKeyed}`);
console.log(`Total: ${allOpps.length} opps  →  Part #: ${totalSplit.partKeyed}   Fuzzy: ${totalSplit.fuzzyKeyed}`);

// ------- Q2: fuzzy cluster size distribution --------------------------------
const distinctDescsByCluster = Object.create(null);
const txnCountByCluster = Object.create(null);
const nameSource = (r) => {
  const n = r.noun != null ? String(r.noun).trim() : "";
  if (n) return n;
  const m = r.material != null ? String(r.material).trim() : "";
  if (m) return m;
  const c3 = r.category_l3 != null ? String(r.category_l3).trim() : "";
  return c3 || (r.c3 != null ? String(r.c3).trim() : "");
};
for (const r of prepRows) {
  const k = r._idpIhKey;
  if (!k || k.indexOf("IH#FUZZY#") !== 0) continue;
  txnCountByCluster[k] = (txnCountByCluster[k] || 0) + 1;
  if (!distinctDescsByCluster[k]) distinctDescsByCluster[k] = new Set();
  const d = nameSource(r);
  if (d) distinctDescsByCluster[k].add(d);
}
const clusterIds = Object.keys(distinctDescsByCluster);
const distinctSizes = clusterIds.map(k => distinctDescsByCluster[k].size);
const txnSizes = clusterIds.map(k => txnCountByCluster[k]);
function bucket(arr, edges) {
  const buckets = new Array(edges.length + 1).fill(0);
  for (const v of arr) {
    let placed = false;
    for (let i = 0; i < edges.length; i++) {
      if (v <= edges[i]) { buckets[i]++; placed = true; break; }
    }
    if (!placed) buckets[edges.length]++;
  }
  return buckets;
}
const edges = [1, 2, 3, 5, 10, 25];
const dBuckets = bucket(distinctSizes, edges);
const tBuckets = bucket(txnSizes, edges);
console.log("\n" + "=".repeat(78));
console.log("Q2: FUZZY CLUSTER SIZE DISTRIBUTION");
console.log("=".repeat(78));
console.log(`Total fuzzy clusters formed: ${clusterIds.length}`);
const bands = ["1 only", "2", "3", "4-5", "6-10", "11-25", "26+"];
console.log("\nBy DISTINCT DESCRIPTIONS merged per cluster:");
for (let i = 0; i < bands.length; i++) {
  console.log(`  ${bands[i].padEnd(8)} : ${String(dBuckets[i]).padStart(4)}  ${"\u2588".repeat(Math.min(50, dBuckets[i]))}`);
}
console.log("\nBy TRANSACTIONS per cluster:");
for (let i = 0; i < bands.length; i++) {
  console.log(`  ${bands[i].padEnd(8)} : ${String(tBuckets[i]).padStart(4)}  ${"\u2588".repeat(Math.min(50, tBuckets[i]))}`);
}
const big = clusterIds.filter(k => distinctDescsByCluster[k].size >= 10);
if (big.length) {
  console.log(`\nClusters merging 10+ distinct descriptions: ${big.length}`);
  big.sort((a, b) => distinctDescsByCluster[b].size - distinctDescsByCluster[a].size);
  for (const k of big.slice(0, 5)) {
    const descs = [...distinctDescsByCluster[k]];
    console.log(`  ${k}  ${distinctDescsByCluster[k].size} distinct descs across ${txnCountByCluster[k]} txns`);
    console.log(`    sample: ${descs.slice(0, 3).map(d => '"' + d.slice(0, 50) + '"').join(", ")}${descs.length > 3 ? ", …" : ""}`);
  }
} else {
  console.log("\nNo clusters merging 10+ distinct descriptions.");
}

// ------- Q3: spot-check fuzzy rows actually have blank/non-numeric parts ----
console.log("\n" + "=".repeat(78));
console.log("Q3: SPOT-CHECK: ARE FUZZY-KEYED ROWS' UNDERLYING PART NUMBERS BLANK?");
console.log("=".repeat(78));
let fuzzyRowsTotal = 0;
let fuzzyRowsBlankPart = 0;
let fuzzyRowsNonNumericPart = 0;
let fuzzyRowsNumericPart = 0;
const numericLeaks = [];
for (const r of prepRows) {
  const k = r._idpIhKey;
  if (!k || k.indexOf("IH#FUZZY#") !== 0) continue;
  fuzzyRowsTotal++;
  const part = r.part != null ? String(r.part).trim() : "";
  if (!part) {
    fuzzyRowsBlankPart++;
  } else if (/\d/.test(part)) {
    fuzzyRowsNumericPart++;
    if (numericLeaks.length < 10) {
      numericLeaks.push({ key: k, part, desc: (nameSource(r) || "").slice(0, 50) });
    }
  } else {
    fuzzyRowsNonNumericPart++;
  }
}
console.log(`Total rows assigned a fuzzy key:        ${fuzzyRowsTotal}`);
console.log(`  with blank Part Number:               ${fuzzyRowsBlankPart}`);
console.log(`  with non-numeric Part Number:         ${fuzzyRowsNonNumericPart}  (letters-only, e.g. "ABC", "TBD")`);
console.log(`  with NUMERIC Part Number (bug check): ${fuzzyRowsNumericPart}`);
if (fuzzyRowsNumericPart > 0) {
  console.log("\n  WARNING: fuzzy-keyed rows with numeric Part Numbers found — investigate.");
  for (const x of numericLeaks) {
    console.log(`    cluster=${x.key}  part="${x.part}"  desc="${x.desc}"`);
  }
} else {
  console.log("\n  All fuzzy-keyed rows have blank/non-numeric Part Numbers. Keying is correct.");
}

console.log("\nTop 5 fuzzy clusters by transaction count (representative descriptions):");
const sortedByTxn = clusterIds.slice().sort((a, b) => txnCountByCluster[b] - txnCountByCluster[a]).slice(0, 5);
for (const k of sortedByTxn) {
  const descs = [...distinctDescsByCluster[k]];
  console.log(`  ${k}  txns=${txnCountByCluster[k]}  distinct descs=${distinctDescsByCluster[k].size}`);
  console.log(`    sample: "${(descs[0] || "").slice(0, 80)}"`);
}
console.log("\nDone.");
