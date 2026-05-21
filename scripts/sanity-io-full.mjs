/* End-to-end sanity check that the Index Opportunity feature returns
 * non-zero opportunities against the real data.json, mimicking what
 * idpIoBuildPartCache + idpIoDeriveOpportunities do at runtime.
 *
 * Why: the user reported zero opportunities for WPU1017(+2.4%) and
 * PCU3339133391(+4.9%) across 250k+ rows. Root cause: the old cache
 * walked getFiltered() which gates on the default "Time = 2025" filter,
 * stripping 2024 history and zeroing every priceLow. This script
 * confirms that the dataset DOES contain qualifying parts when the
 * year filter is correctly ignored.
 *
 * Run: node --max-old-space-size=4096 scripts/sanity-io-full.mjs
 */
import fs from "node:fs";
import * as m from "../src/dashboard/index-math.mjs";

const path = "./src/dashboard/data.json";
console.log("Loading data.json...");
const raw = fs.readFileSync(path, "utf8");
console.log("Parsing...");
const d = JSON.parse(raw);
const rows = d && d.rows ? d.rows : Array.isArray(d) ? d : [];
console.log("Total rows:", rows.length);

// Build the same per-part/per-site bucket idpIoBuildPartCache builds.
// Walk EVERY row (year-agnostic) — that's the fix.
const buckets = new Map();
for (const r of rows) {
  if (!r) continue;
  const y = +r.year;
  if (y !== 2024 && y !== 2025) continue;
  const part = String(r.part || "").trim();
  if (!part) continue;
  const site = String(r.site || "").trim() || "-";
  const key = part + "|" + site;
  let b = buckets.get(key);
  if (!b) {
    b = {
      part, site,
      cumminsCountry: "",
      spendLow: 0, qtyLow: 0,
      spendHigh: 0, qtyHigh: 0
    };
    buckets.set(key, b);
  }
  const spend = +r.spend || 0;
  const qty = +(r.quantity != null ? r.quantity : r.qty) || 0;
  if (y === 2024) { b.spendLow += spend; b.qtyLow += qty; }
  else { b.spendHigh += spend; b.qtyHigh += qty; }
  if (!b.cumminsCountry) {
    b.cumminsCountry = r.cummins_country || r.country_exact || r.country || "";
  }
}

// Derive per-part prices + growth, drop incomplete parts.
const parts = [];
for (const [, b] of buckets) {
  const priceLow = m.weightedUnitPrice(b.spendLow, b.qtyLow);
  const priceHigh = m.weightedUnitPrice(b.spendHigh, b.qtyHigh);
  if (!Number.isFinite(priceLow) || priceLow <= 0) continue;
  if (!Number.isFinite(priceHigh) || priceHigh <= 0) continue;
  const growthPct = m.priceGrowthPct(priceLow, priceHigh);
  if (!Number.isFinite(growthPct)) continue;
  parts.push(Object.assign({}, b, { priceLow, priceHigh, growthPct }));
}
console.log("Eligible part+site combos (both years present):", parts.length);

const lowTarget = 2.4;
const highTarget = 4.9;
const enriched = parts
  .map((p) => Object.assign({}, p, m.partCaptureSavings(p, lowTarget, highTarget)))
  .filter((p) => p.qualifies);

console.log("");
console.log("=== Simulated WPU1017(+2.4%) / PCU3339133391(+4.9%) ===");
console.log("Qualifying parts:", enriched.length);
console.log("Total low capture $:", enriched.reduce((s, p) => s + p.lowSavings, 0).toFixed(0));
console.log("Total high capture $:", enriched.reduce((s, p) => s + p.highSavings, 0).toFixed(0));

if (enriched.length === 0) {
  console.error("FAIL: no qualifying parts — math regression.");
  process.exit(1);
}

// Archetype breakdown — same classifier as idpIoClassifyArchetype.
function classify(country) {
  const c = (country || "").trim().toLowerCase();
  if (!c) return "row";
  if (["us", "u.s.", "u.s.a.", "usa", "united states",
       "united states of america", "united-states", "united_states"].includes(c)) return "us";
  if (["china", "p.r. china", "prc",
       "people's republic of china", "peoples republic of china",
       "mainland china"].includes(c)) return "china";
  return "row";
}
const byArchetype = { us: [], china: [], row: [] };
for (const p of enriched) {
  byArchetype[classify(p.cumminsCountry)].push(p);
}
console.log("By archetype:");
for (const a of ["us", "china", "row"]) {
  const list = byArchetype[a];
  const sum = m.archetypeSummary(list);
  console.log(`  ${a.toUpperCase().padEnd(6)} n=${String(list.length).padStart(6)}  savings=$${sum.totalSavings.toFixed(0)}`);
}

// Top-5 qualifying parts by low savings.
enriched.sort((a, b) => b.lowSavings - a.lowSavings);
console.log("");
console.log("Top 5 qualifying parts by low savings:");
for (let i = 0; i < Math.min(5, enriched.length); i++) {
  const p = enriched[i];
  console.log(`  ${p.part} @ ${p.site}  growth=${p.growthPct.toFixed(2)}%  spend25=$${p.spendHigh.toFixed(0)}  lowSav=$${p.lowSavings.toFixed(0)}  (${classify(p.cumminsCountry)})`);
}

console.log("");
console.log("PASS");
