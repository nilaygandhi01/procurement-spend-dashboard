/* One-off sanity check for the Index Opportunity drill-down math
 * against real data.json. Picks the highest-2025-spend qualifying
 * part+site bucket, computes its drill-down rows, and prints them
 * side-by-side with hand-rolled values so the math can be eyeballed.
 *
 * Not part of the test suite — disposable script.
 *
 * Run: node --max-old-space-size=4096 scripts/sanity-io-drilldown.mjs
 */
import fs from "node:fs";
import * as m from "../src/dashboard/index-math.mjs";

const path = "./src/dashboard/data.json";
console.log("Loading data.json...");
const raw = fs.readFileSync(path, "utf8");
const d = JSON.parse(raw);
const rows = d && d.rows ? d.rows : Array.isArray(d) ? d : [];
console.log("rows:", rows.length);

const map = new Map();
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (!r) continue;
  const y = +r.year;
  if (y !== 2024 && y !== 2025) continue;
  const part = String(r.part || "").trim();
  if (!part) continue;
  const site = String(r.site || "").trim() || "-";
  const key = part + "|" + site;
  let b = map.get(key);
  if (!b) {
    b = { part, site, desc: r.description || "", s24: 0, q24: 0, s25: 0, q25: 0 };
    map.set(key, b);
  }
  const sp = +r.spend, qty = +r.qty;
  if (Number.isFinite(sp)) (y === 2024 ? (b.s24 += sp) : (b.s25 += sp));
  if (Number.isFinite(qty)) (y === 2024 ? (b.q24 += qty) : (b.q25 += qty));
}

// Find a part with both year's data, large 2025 spend, and growth > 5%.
let pick = null;
for (const b of map.values()) {
  if (b.q24 <= 0 || b.q25 <= 0 || b.s24 <= 0) continue;
  const p24 = b.s24 / b.q24, p25 = b.s25 / b.q25;
  if (!isFinite(p24) || !isFinite(p25) || p24 <= 0) continue;
  const g = (p25 / p24 - 1) * 100;
  if (g <= 5) continue;
  if (!pick || b.s25 > pick.s25) {
    pick = { ...b, p24, p25, growthPct: g };
  }
}
if (!pick) { console.log("No qualifying part found."); process.exit(0); }
console.log("\nPicked part:");
console.log("  part   =", pick.part);
console.log("  site   =", pick.site);
console.log("  q24 / s24 =", pick.q24, "/", pick.s24.toFixed(2), "→ p24 =", pick.p24.toFixed(4));
console.log("  q25 / s25 =", pick.q25, "/", pick.s25.toFixed(2), "→ p25 =", pick.p25.toFixed(4));
console.log("  growthPct =", pick.growthPct.toFixed(3), "%");

// Use realistic 2024→2025 PPI targets: low = +2.4 (WPU1017), high = +4.9 (PCU3339133391)
const lowT = 2.4;
const highT = 4.9;
const partForMath = {
  priceLow: pick.p24, priceHigh: pick.p25,
  qtyLow: pick.q24, qtyHigh: pick.q25,
  spendLow: pick.s24, spendHigh: pick.s25
};

console.log("\nDrill-down rows (low=2.4%, high=4.9%):");
const drillRows = m.partDrilldownRows(partForMath, lowT, highT);
console.log(JSON.stringify(drillRows, null, 2));

// Hand-rolled cross-check on the 2025 row:
const benchLow = pick.p24 * (1 + lowT / 100);
const benchHigh = pick.p24 * (1 + highT / 100);
const handSavLow = pick.s25 - pick.q25 * benchLow;
const handSavHigh = pick.s25 - pick.q25 * benchHigh;
console.log("\nHand-rolled 2025 cross-check:");
console.log("  benchLow  =", benchLow.toFixed(4), "(p24 * 1.024)");
console.log("  benchHigh =", benchHigh.toFixed(4), "(p24 * 1.049)");
console.log("  savingsVsLow  hand =", handSavLow.toFixed(2));
console.log("  savingsVsHigh hand =", handSavHigh.toFixed(2));
console.log("  matches module? lowDelta =", Math.abs(drillRows[1].savingsVsLow - handSavLow).toFixed(6),
            " highDelta =", Math.abs(drillRows[1].savingsVsHigh - handSavHigh).toFixed(6));

// Rollup math comparison for the same part:
const cap = m.partCaptureSavings(
  Object.assign({}, partForMath, { growthPct: pick.growthPct }),
  lowT, highT
);
console.log("\nRollup math (partCaptureSavings):");
console.log("  qualifies   =", cap.qualifies);
console.log("  lowSavings  =", cap.lowSavings.toFixed(2));
console.log("  highSavings =", cap.highSavings.toFixed(2));
