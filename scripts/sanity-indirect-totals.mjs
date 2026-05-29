// Quick sanity: dollar-anchor what the Spend Overview KPI tile reports
// for Indirect + Time=2025 against the raw fields in data.json. The
// Assumption Walk top-bookend must match this.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(repoRoot, "src", "dashboard", "data.json"), "utf8"));
const rows = data.rows || [];

console.log("Total rows in data.json:", rows.length);

const indirect = rows.filter(r => {
  if (!r) return false;
  const c1 = String(r.category_l1 != null ? r.category_l1 : r.c1 != null ? r.c1 : "").trim().toLowerCase();
  return c1 === "indirect" || c1 === "indirects";
});
console.log("Indirect rows (L1=Indirect, all years):", indirect.length);

function sumSpend(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = +(arr[i].spend != null ? arr[i].spend : 0);
    if (Number.isFinite(v)) s += v;
  }
  return s;
}

function rowYear(r) {
  const y = +r.year;
  if (y >= 1990 && y <= 2100) return y;
  const ym = r.ym != null ? String(r.ym) : "";
  let m = ym.match(/(20[0-2][0-9])/);
  if (m) return +m[1];
  const d = r.d;
  if (d) { m = String(d).match(/(20[0-2][0-9])/); if (m) return +m[1]; }
  return 0;
}

const byYear = new Map();
for (const r of indirect) {
  const y = rowYear(r);
  if (!byYear.has(y)) byYear.set(y, { count: 0, spend: 0 });
  const b = byYear.get(y);
  b.count += 1;
  const v = +(r.spend != null ? r.spend : 0);
  if (Number.isFinite(v)) b.spend += v;
}
console.log("\nIndirect rows by year:");
const years = [...byYear.keys()].sort();
for (const y of years) {
  const b = byYear.get(y);
  console.log("  " + y + ": " + b.count.toLocaleString() + " rows, $" + Math.round(b.spend).toLocaleString());
}

const ind2025 = indirect.filter(r => rowYear(r) === 2025);
console.log("\nIndirect + 2025:", ind2025.length, "rows, $" + Math.round(sumSpend(ind2025)).toLocaleString());

// Also: indirect + 2025 + has supplier + has site (the "structurally clean" subset)
const ind2025clean = ind2025.filter(r => {
  const sup = r.supplier != null ? String(r.supplier).trim() : "";
  const site = r.site != null ? String(r.site).trim() : "";
  return sup && site;
});
console.log("Indirect + 2025 + has supplier + has site:", ind2025clean.length, "rows, $" + Math.round(sumSpend(ind2025clean)).toLocaleString());

const ind2025missingSup = ind2025.filter(r => {
  const sup = r.supplier != null ? String(r.supplier).trim() : "";
  return !sup;
});
console.log("Indirect + 2025 + missing supplier:", ind2025missingSup.length);

const ind2025missingSite = ind2025.filter(r => {
  const site = r.site != null ? String(r.site).trim() : "";
  return !site;
});
console.log("Indirect + 2025 + missing site:", ind2025missingSite.length);

// Sample a few rows for inspection.
console.log("\nFirst 3 indirect 2025 rows (raw):");
for (let i = 0; i < Math.min(3, ind2025.length); i++) {
  const r = ind2025[i];
  console.log("  ", JSON.stringify({
    year: r.year, ym: r.ym, d: r.d, supplier: r.supplier, site: r.site,
    part: r.part, material: r.material, noun: r.noun,
    spend: r.spend, quantity: r.quantity, qty: r.qty,
    category_l1: r.category_l1, c1: r.c1
  }));
}
