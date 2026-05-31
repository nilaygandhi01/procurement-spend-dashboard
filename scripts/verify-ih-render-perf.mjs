// Verify the Indirect Harmonization render-path performance fix:
// memoize _idpIhResolveFuzzyDesc and apply INDIRECT_HARM_TABLE_TOP_N
// to the visible row count.
//
// Measures:
//   1. Cluster size distribution (worst-case cost of a single
//      uncached _idpIhResolveFuzzyDesc call).
//   2. Number of fuzzy opp lookups that would happen in one render
//      pass (Cat 1 + Cat 2 combined) before vs after the TOP_N cap.
//   3. Time delta for an uncached vs cached pass over all fuzzy opp
//      keys returned by the math layer.
//
// Mirrors verify-ih-keying.mjs's prep build precisely so the math
// layer actually returns opportunities.
//
// Run:
//   node --max-old-space-size=8192 scripts/verify-ih-render-perf.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

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
console.log("Indirect 2025 slice rows: " + indirect.length.toLocaleString());

// --- Mirror _idpIhBuildPrep -------------------------------------------------
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

const tokenSets = fuzzyCandidates.map(c => IDPMATH.normalizeNameForFuzzy(c.name, { threshold: FUZZY_THRESHOLD }).tokens);
const clusterRes = IDPMATH.fuzzyClusterNames(fuzzyCandidates, { threshold: FUZZY_THRESHOLD });
const clusters = clusterRes.clusters || [];
const fuzzyMembersByKey = Object.create(null);
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
  const memList = [];
  for (const memberIdx of members) {
    const sliceIdx = fuzzyCandidates[memberIdx].id;
    if (indirect[sliceIdx]) {
      indirect[sliceIdx]._idpIhKey = clusterKey;
      memList.push({ row: indirect[sliceIdx], description: fuzzyCandidates[memberIdx].name });
    }
  }
  fuzzyMembersByKey[clusterKey] = memList;
}
const prepRows = indirect.filter(r => r._idpIhKey);

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

const cat1Opps = mathOut.cat1Opps || [];
const cat2Opps = mathOut.cat2Opps || [];

console.log("\nMath layer output:");
console.log("  Cat 1 opps: " + cat1Opps.length);
console.log("  Cat 2 opps: " + cat2Opps.length);
console.log("  Distinct fuzzy clusters in members map: " + Object.keys(fuzzyMembersByKey).length);

/* Cluster size distribution */
const clusterKeys = Object.keys(fuzzyMembersByKey);
const sizes = clusterKeys.map(k => (fuzzyMembersByKey[k] || []).length).sort((a, b) => b - a);
console.log("\nCluster size distribution (members per cluster):");
console.log("  max: " + sizes[0]);
console.log("  p90: " + sizes[Math.floor(sizes.length * 0.10)]);
console.log("  p50: " + sizes[Math.floor(sizes.length * 0.50)]);
console.log("  p10: " + sizes[Math.floor(sizes.length * 0.90)]);
console.log("  min: " + sizes[sizes.length - 1]);
console.log("  sum: " + sizes.reduce((a, b) => a + b, 0).toLocaleString());

/* Per-render fuzzy lookup count: uncapped vs TOP_N=20 capped */
function getKey(o) {
  return (o && (o.item != null ? String(o.item) : (o.part != null ? String(o.part) : ""))) || "";
}
function countFuzzyLookups(opps) {
  return opps.filter(o => {
    const k = getKey(o);
    return typeof k === "string" && k.indexOf("IH#FUZZY#") === 0;
  }).length;
}
const cat1Sorted = cat1Opps.slice().sort((a, b) => (+(b.savings) || 0) - (+(a.savings) || 0));
const cat2Sorted = cat2Opps.slice().sort((a, b) => (+(b.savings) || 0) - (+(a.savings) || 0));

const fuzzyLookupsUncapped = countFuzzyLookups(cat1Sorted) + countFuzzyLookups(cat2Sorted);
const TABLE_TOP_N = 20;
const fuzzyLookupsCapped = countFuzzyLookups(cat1Sorted.slice(0, TABLE_TOP_N)) + countFuzzyLookups(cat2Sorted.slice(0, TABLE_TOP_N));

console.log("\nFuzzy lookups per render pass (before this commit, fully uncached):");
console.log("  uncapped (all opps in both tables): " + fuzzyLookupsUncapped);
console.log("  capped (TOP_N=" + TABLE_TOP_N + " per table):  " + fuzzyLookupsCapped);

function resolveOnce(partKey, members) {
  let bestSpend = -Infinity, bestDesc = "";
  const seen = Object.create(null);
  const allDescs = [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (!m) continue;
    const dsc = (m && m.description != null) ? String(m.description).trim() : "";
    const rowRef = (m && m.row) ? m.row : null;
    let sp = 0;
    if (rowRef) {
      const spv = +(rowRef.spend != null ? rowRef.spend : 0);
      sp = isFinite(spv) ? Math.abs(spv) : 0;
    }
    if (dsc) {
      const key = dsc.toLowerCase();
      if (!seen[key]) { seen[key] = 1; allDescs.push(dsc); }
    }
    if (sp > bestSpend) { bestSpend = sp; bestDesc = dsc; }
  }
  return { canonical: bestDesc, distinctCount: allDescs.length, allDescriptions: allDescs };
}

function timeUncached(opps) {
  const t0 = performance.now();
  let n = 0, totalMemberIters = 0;
  for (const o of opps) {
    const k = getKey(o);
    if (typeof k !== "string" || k.indexOf("IH#FUZZY#") !== 0) continue;
    const members = fuzzyMembersByKey[k] || [];
    resolveOnce(k, members);
    totalMemberIters += members.length;
    n++;
  }
  return { ms: performance.now() - t0, calls: n, memberIters: totalMemberIters };
}
function timeCached(opps) {
  const cache = Object.create(null);
  const t0 = performance.now();
  let n = 0, hits = 0, totalMemberIters = 0;
  for (const o of opps) {
    const k = getKey(o);
    if (typeof k !== "string" || k.indexOf("IH#FUZZY#") !== 0) continue;
    if (cache[k] !== undefined) { hits++; n++; continue; }
    const members = fuzzyMembersByKey[k] || [];
    cache[k] = resolveOnce(k, members);
    totalMemberIters += members.length;
    n++;
  }
  return { ms: performance.now() - t0, calls: n, cacheHits: hits, memberIters: totalMemberIters };
}

const allOpps = cat1Sorted.concat(cat2Sorted);
const allCapped = cat1Sorted.slice(0, TABLE_TOP_N).concat(cat2Sorted.slice(0, TABLE_TOP_N));

console.log("\nResolve perf (mirrors what the dashboard does per render):");
const u1 = timeUncached(allOpps);
console.log("  uncached, all opps : " + String(u1.calls).padStart(4) + " calls, " + String(u1.memberIters.toLocaleString()).padStart(8) + " member-iters, " + u1.ms.toFixed(1) + " ms");
const c1 = timeCached(allOpps);
console.log("  cached,   all opps : " + String(c1.calls).padStart(4) + " calls (" + c1.cacheHits + " hits), " + String(c1.memberIters.toLocaleString()).padStart(8) + " member-iters, " + c1.ms.toFixed(1) + " ms");
const u2 = timeUncached(allCapped);
console.log("  uncached, TOP_N=20 : " + String(u2.calls).padStart(4) + " calls, " + String(u2.memberIters.toLocaleString()).padStart(8) + " member-iters, " + u2.ms.toFixed(1) + " ms");
const c2 = timeCached(allCapped);
console.log("  cached,   TOP_N=20 : " + String(c2.calls).padStart(4) + " calls (" + c2.cacheHits + " hits), " + String(c2.memberIters.toLocaleString()).padStart(8) + " member-iters, " + c2.ms.toFixed(1) + " ms");

console.log("\nSpeedup (uncached, all opps → cached + TOP_N=20):");
console.log("  " + u1.ms.toFixed(1) + " ms → " + c2.ms.toFixed(1) + " ms (" + (u1.ms / Math.max(c2.ms, 0.01)).toFixed(1) + "× faster)");
console.log("  member-iters: " + u1.memberIters.toLocaleString() + " → " + c2.memberIters.toLocaleString() + " (" + (u1.memberIters / Math.max(c2.memberIters, 1)).toFixed(1) + "× fewer)");
