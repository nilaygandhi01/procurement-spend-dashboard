// Verify the new "Adjusted Scope unchecks the actual filter pills"
// behavior at the math layer: compute the spend totals that the
// dashboard will display after each state transition.
//
// Models:
//   1. Total scope, 2025 Indirect slice  →  $388.1M baseline.
//   2. Apply Scope = Adjusted (Indirect) →  unchecks the rule-matching
//      values in Supplier / L3 / L4 pills. New total = sum of spend
//      for rows whose supplier ∈ (allSuppliers − KPIT) AND L3 ∈
//      (allL3 − rule L3 values) AND L4 ∈ (allL4 − rule L4 values).
//   3. User re-checks "Software/Undefined" in L4 manually. New total
//      = state 2 + the spend of rows that were excluded ONLY because
//      of that L4 value.
//   4. User toggles back to Total. New total = state 1 (all re-checked).
//
// Run:
//   node --max-old-space-size=8192 scripts/verify-adjusted-scope-uncheck.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const data = JSON.parse(fs.readFileSync(path.join(repoRoot, "src", "dashboard", "data.json"), "utf8"));
const rules = JSON.parse(fs.readFileSync(path.join(repoRoot, "src", "dashboard", "config", "adjusted-scope-rules.json"), "utf8"));

const rows = data.rows || [];
function ci(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
function num(v) { const n = +v; return isFinite(n) ? n : 0; }
function rowYear(r) {
  if (r.year != null) return +r.year;
  const ym = String(r.ym || r.d || "");
  const m = ym.match(/(\d{4})/);
  return m ? +m[1] : NaN;
}
function fmtUsd(n) { return "$" + (n / 1e6).toFixed(2) + "M"; }

const sliceInd = rows.filter(r => r && rowYear(r) === 2025 && ci(r.category_l1 || r.c1) === "indirect");

/* --- Build dataset distinct value sets per dict (mirrors what fillF
   sees) --- */
const allSuppliers = new Set();
const allC3 = new Set();
const allC4 = new Set();
for (const r of sliceInd) {
  if (r.supplier != null) allSuppliers.add(String(r.supplier).trim());
  const c3v = r.category_l3 != null ? r.category_l3 : r.c3;
  const c4v = r.category_l4 != null ? r.category_l4 : r.c4;
  if (c3v != null) allC3.add(String(c3v).trim());
  if (c4v != null) allC4.add(String(c4v).trim());
}

/* --- Compute target value sets exactly as the dashboard does --- */
function lcSet(arr) {
  const s = new Set();
  if (arr) for (const v of arr) { const lo = ci(v); if (lo) s.add(lo); }
  return s;
}
function suppliersContaining(tokens) {
  const lower = (tokens || []).map(ci).filter(Boolean);
  if (!lower.length) return new Set();
  const out = new Set();
  for (const s of allSuppliers) {
    const lo = s.toLowerCase();
    for (const t of lower) { if (lo.indexOf(t) !== -1) { out.add(s); break; } }
  }
  return out;
}
function dictHasLc(set, valLc) {
  for (const v of set) if (v.toLowerCase() === valLc) return true;
  return false;
}

const targetsSup = new Set();   // raw supplier names to uncheck
const targetsC3 = new Set();    // lowercased L3 values to uncheck
const targetsC4 = new Set();    // lowercased L4 values to uncheck

for (const rule of rules.exclusions) {
  const m = rule.match || {};
  if (m.supplier_contains_ci) {
    for (const sup of suppliersContaining(m.supplier_contains_ci)) targetsSup.add(sup);
  }
  if (m.category_l3_equals_ci) for (const v of m.category_l3_equals_ci) targetsC3.add(ci(v));
  if (m.category_l3_in_ci) for (const v of m.category_l3_in_ci) targetsC3.add(ci(v));
  if (m.category_l4_equals_ci) for (const v of m.category_l4_equals_ci) targetsC4.add(ci(v));
  if (m.category_l4_in_ci) for (const v of m.category_l4_in_ci) targetsC4.add(ci(v));
  if (m.category_l3_or_l4_in_ci) {
    for (const v of m.category_l3_or_l4_in_ci) {
      const lo = ci(v);
      if (dictHasLc(allC3, lo)) targetsC3.add(lo);
      if (dictHasLc(allC4, lo)) targetsC4.add(lo);
    }
  }
}

/* --- spend evaluators --- */
function spendWithUnchecks(uncheckedSup, uncheckedC3, uncheckedC4) {
  /* Replicates the dashboard's row predicate: a row is INCLUDED iff
     its supplier ∉ uncheckedSup AND its L3 ∉ uncheckedC3 AND its L4
     ∉ uncheckedC4. */
  let total = 0;
  for (const r of sliceInd) {
    const s = String(r.supplier == null ? "" : r.supplier).trim();
    const c3v = ci(r.category_l3 || r.c3);
    const c4v = ci(r.category_l4 || r.c4);
    if (uncheckedSup.has(s)) continue;
    if (uncheckedC3.has(c3v)) continue;
    if (uncheckedC4.has(c4v)) continue;
    total += num(r.spend);
  }
  return total;
}

const baseline = sliceInd.reduce((s, r) => s + num(r.spend), 0);

console.log("============================================================");
console.log(" ADJUSTED-SCOPE → UNCHECK STATE TRANSITIONS");
console.log("============================================================");
console.log("Slice: 2025 Indirect, " + sliceInd.length.toLocaleString() + " rows, " + fmtUsd(baseline) + " baseline");
console.log("Distinct in slice: " + allSuppliers.size + " suppliers, " + allC3.size + " L3, " + allC4.size + " L4");

/* State 1 — Total: no unchecks */
const totalState = spendWithUnchecks(new Set(), new Set(), new Set());
console.log("\nState 1 — Scope = Total");
console.log("  Visible spend: " + fmtUsd(totalState) + "  (expect $388.10M)");
console.log("  Unchecked: 0 suppliers, 0 L3, 0 L4");

/* State 2 — Adjusted: full target set unchecked */
const adjState = spendWithUnchecks(targetsSup, targetsC3, targetsC4);
const delta = totalState - adjState;
console.log("\nState 2 — Scope = Adjusted (Indirect)");
console.log("  Visible spend: " + fmtUsd(adjState) + "  (expect ~$194.80M)");
console.log("  Delta vs Total: " + fmtUsd(delta) + "  (expect ~$193.34M)");
console.log("  Unchecked: " + targetsSup.size + " suppliers, " + targetsC3.size + " L3, " + targetsC4.size + " L4");
console.log("  Target L3: " + Array.from(targetsC3).sort().join(", "));
console.log("  Target L4: " + Array.from(targetsC4).sort().join(", "));
console.log("  Target Suppliers: " + Array.from(targetsSup).sort().join(", "));

/* State 3 — Adjusted with the user re-checking Software/Undefined in L4 */
const c4WithoutSoftware = new Set(targetsC4);
c4WithoutSoftware.delete("software/undefined");
const adjModSoftware = spendWithUnchecks(targetsSup, targetsC3, c4WithoutSoftware);
const softwareReadd = adjModSoftware - adjState;
console.log("\nState 3 — Adjusted, user re-checks 'Software/Undefined' in L4");
console.log("  Visible spend: " + fmtUsd(adjModSoftware));
console.log("  Re-added vs state 2: " + fmtUsd(softwareReadd) + "  (expect ~$7.86M)");
console.log("  Scope pill should now show: Adjusted (Indirect) \u2014 modified");

/* State 4 — back to Total: all rule-owned boxes re-checked, user's
   re-check of Software is no longer relevant since the scope toggle
   is off */
const backToTotal = spendWithUnchecks(new Set(), new Set(), new Set());
console.log("\nState 4 — Scope = Total (toggled back)");
console.log("  Visible spend: " + fmtUsd(backToTotal) + "  (expect $388.10M, matches state 1)");
console.log("  Round-trip delta: " + fmtUsd(totalState - backToTotal) + "  (expect $0.00M)");

/* Sanity flags */
console.log("\n--- Sanity check ---");
const expBaseline = 388.10e6;
const expAdjusted = 194.80e6;
const expSoftware = 7.86e6;
function pct(a, b) { return ((a - b) / b * 100).toFixed(2) + "%"; }
console.log("  Baseline vs expected $388.10M: " + pct(totalState, expBaseline) + "  " + (Math.abs(totalState - expBaseline) / expBaseline < 0.005 ? "PASS" : "REVIEW"));
console.log("  Adjusted vs expected $194.80M: " + pct(adjState, expAdjusted) + "  " + (Math.abs(adjState - expAdjusted) / expAdjusted < 0.02 ? "PASS" : "REVIEW"));
console.log("  Software re-add vs expected $7.86M: " + pct(softwareReadd, expSoftware) + "  " + (Math.abs(softwareReadd - expSoftware) / expSoftware < 0.02 ? "PASS" : "REVIEW"));
console.log("  Round-trip ($388.1M → $194.8M → $388.1M): " + (Math.abs(totalState - backToTotal) < 1 ? "PASS" : "REVIEW"));
