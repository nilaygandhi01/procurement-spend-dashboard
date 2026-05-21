/* One-off sanity check for the Index Opportunity math against real
 * data.json. Picks the highest-2025-spend part+site bucket that has
 * both 2024 and 2025 data, computes prices/growth/savings two ways
 * (math module vs hand), and prints them side-by-side.
 *
 * Not part of the test suite — disposable script.
 *
 * Run: node --max-old-space-size=4096 scripts/sanity-io.mjs
 */
import fs from "node:fs";
import * as m from "../src/dashboard/index-math.mjs";

const path = "./src/dashboard/data.json";
console.log("Loading data.json (large)...");
const raw = fs.readFileSync(path, "utf8");
console.log("Parsing...");
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
    b = { part, site, ctry: "", l24: 0, q24: 0, l25: 0, q25: 0 };
    map.set(key, b);
  }
  const spend = +r.spend || 0;
  const qty = +(r.quantity != null ? r.quantity : r.qty) || 0;
  if (y === 2024) { b.l24 += spend; b.q24 += qty; }
  else { b.l25 += spend; b.q25 += qty; }
  if (!b.ctry) b.ctry = r.cummins_country || r.country_exact || r.country || "";
}

let candidate = null;
let topSpend = 0;
for (const [, b] of map) {
  if (b.q24 <= 0 || b.q25 <= 0 || b.l24 <= 0 || b.l25 <= 0) continue;
  if (b.l25 < 100000) continue;
  // Require a price-growth of at least ~3% (above an aggressive low target)
  const g = (b.l25 / b.q25) / (b.l24 / b.q24) - 1;
  if (g <= 0.03) continue;
  if (b.l25 > topSpend) { topSpend = b.l25; candidate = b; }
}

if (!candidate) {
  console.log("no candidate part found");
  process.exit(0);
}

const p = candidate;
const priceLow = m.weightedUnitPrice(p.l24, p.q24);
const priceHigh = m.weightedUnitPrice(p.l25, p.q25);
const growth = m.priceGrowthPct(priceLow, priceHigh);

console.log("=== Top-2025-spend part ===");
console.log("Part:    ", p.part);
console.log("Site:    ", p.site);
console.log("Country: ", p.ctry || "(blank)");
console.log("---");
console.log(`2024 spend: $${p.l24.toFixed(2)} · qty: ${p.q24.toFixed(2)} · price (Σspend/Σqty): $${priceLow.toFixed(4)}`);
console.log(`2025 spend: $${p.l25.toFixed(2)} · qty: ${p.q25.toFixed(2)} · price (Σspend/Σqty): $${priceHigh.toFixed(4)}`);
console.log(`Growth %:  ${growth.toFixed(2)}`);

console.log("--- Hand-calc cross-check ---");
console.log("Hand price 2024:", (p.l24 / p.q24).toFixed(4));
console.log("Hand price 2025:", (p.l25 / p.q25).toFixed(4));
console.log("Hand growth %:  ", ((p.l25 / p.q25) / (p.l24 / p.q24) - 1) * 100);

const low = { code: "WPU1017", growthPct: 2.4 };
const high = { code: "PCU3339133391", growthPct: 4.9 };
const asg = m.assignLowHigh(low, high);
const cap = m.partCaptureSavings({ growthPct: growth, spendHigh: p.l25 }, asg.low.growthPct, asg.high.growthPct);

console.log("--- Simulated savings vs WPU1017(+2.4%) / PCU3339133391(+4.9%) ---");
console.log("Qualifies:        ", cap.qualifies);
console.log("Low capture $:    ", cap.lowSavings.toFixed(2));
console.log("High capture $:   ", cap.highSavings.toFixed(2));
console.log("Hand low capture: ", (p.l25 * Math.max(0, (growth - asg.low.growthPct) / 100)).toFixed(2));
console.log("Hand high capture:", (p.l25 * Math.max(0, (growth - asg.high.growthPct) / 100)).toFixed(2));

console.log("--- Cummins country archetype assignment ---");
const cclow = (p.ctry || "").trim().toLowerCase();
let arch = "row";
if (cclow === "us" || cclow === "united states") arch = "us";
else if (cclow === "china") arch = "china";
console.log("Archetype:", arch);
