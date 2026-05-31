// Verify the Adjusted Scope rules-to-filter-pill mapping for the new
// "uncheck the actual checkboxes" implementation. Reports the EXACT
// casing each rule value resolves to in data.json's dicts, plus any
// rule value that doesn't resolve to a real dict entry (which would
// silently no-op when the user toggles Scope = Adjusted).
//
// Run:
//   node --max-old-space-size=8192 scripts/verify-adjusted-scope-filter-mapping.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const data = JSON.parse(fs.readFileSync(path.join(repoRoot, "src", "dashboard", "data.json"), "utf8"));
const rules = JSON.parse(fs.readFileSync(path.join(repoRoot, "src", "dashboard", "config", "adjusted-scope-rules.json"), "utf8"));

const rows = data.rows || [];
function ci(s) { return String(s == null ? "" : s).trim().toLowerCase(); }

/* Build distinct value sets per dict from the row stream (data.json
   may not ship a "dicts" block — the dashboard builds them at
   runtime from the rows). */
const suppliers = new Set();
const c1 = new Set(); const c2 = new Set();
const c3 = new Set(); const c4 = new Set();
for (const r of rows) {
  if (!r) continue;
  if (r.supplier != null) suppliers.add(String(r.supplier).trim());
  else if (r.su != null) suppliers.add(String(r.su).trim());
  const c1v = r.category_l1 != null ? r.category_l1 : r.c1;
  const c2v = r.category_l2 != null ? r.category_l2 : r.c2;
  const c3v = r.category_l3 != null ? r.category_l3 : r.c3;
  const c4v = r.category_l4 != null ? r.category_l4 : r.c4;
  if (c1v != null) c1.add(String(c1v).trim());
  if (c2v != null) c2.add(String(c2v).trim());
  if (c3v != null) c3.add(String(c3v).trim());
  if (c4v != null) c4.add(String(c4v).trim());
}

const supLower = new Map();
for (const v of suppliers) { const k = v.toLowerCase(); if (!supLower.has(k)) supLower.set(k, v); }
const c1Lower = new Map(); for (const v of c1) c1Lower.set(v.toLowerCase(), v);
const c2Lower = new Map(); for (const v of c2) c2Lower.set(v.toLowerCase(), v);
const c3Lower = new Map(); for (const v of c3) c3Lower.set(v.toLowerCase(), v);
const c4Lower = new Map(); for (const v of c4) c4Lower.set(v.toLowerCase(), v);

console.log("============================================================");
console.log(" ADJUSTED SCOPE → FILTER PILL MAPPING VERIFICATION");
console.log("============================================================");
console.log("Dataset distinct values:");
console.log("  suppliers:    " + suppliers.size);
console.log("  category_l1:  " + c1.size);
console.log("  category_l2:  " + c2.size);
console.log("  category_l3:  " + c3.size);
console.log("  category_l4:  " + c4.size);
console.log();

let missing = 0;

function resolveExact(ruleValue, lowerMap, dictName) {
  const k = String(ruleValue).trim().toLowerCase();
  const real = lowerMap.get(k);
  if (real == null) {
    console.log("  ! MISMATCH  " + dictName + " has no entry matching rule value '" + ruleValue + "'");
    missing++;
    return null;
  }
  if (real !== ruleValue) {
    console.log("    " + dictName.padEnd(12) + "rule '" + ruleValue + "'  →  dict '" + real + "'  (case-normalized)");
  } else {
    console.log("    " + dictName.padEnd(12) + "rule '" + ruleValue + "'  →  exact match");
  }
  return real;
}

function resolveContains(token, lowerMap, dictName) {
  const t = String(token).trim().toLowerCase();
  if (!t) return [];
  const hits = [];
  for (const [lo, original] of lowerMap.entries()) {
    if (lo.indexOf(t) !== -1) hits.push(original);
  }
  if (!hits.length) {
    console.log("  ! MISMATCH  " + dictName + " has no entry containing '" + token + "'");
    missing++;
    return [];
  }
  console.log("    " + dictName.padEnd(12) + "contains '" + token + "'  →  " + hits.length + " supplier(s): " + hits.slice(0, 5).join(", ") + (hits.length > 5 ? ", ..." : ""));
  return hits;
}

for (const rule of rules.exclusions) {
  console.log("------------------------------------------------------------");
  console.log("Rule: " + rule.label + "  (id=" + rule.id + ")");
  const m = rule.match || {};
  if (m.supplier_contains_ci) {
    for (const tok of m.supplier_contains_ci) resolveContains(tok, supLower, "supplier");
  }
  if (m.category_l1_equals_ci) {
    for (const v of m.category_l1_equals_ci) resolveExact(v, c1Lower, "category_l1");
  }
  if (m.category_l2_equals_ci) {
    for (const v of m.category_l2_equals_ci) resolveExact(v, c2Lower, "category_l2");
  }
  if (m.category_l3_equals_ci) {
    for (const v of m.category_l3_equals_ci) resolveExact(v, c3Lower, "category_l3");
  }
  if (m.category_l3_in_ci) {
    for (const v of m.category_l3_in_ci) resolveExact(v, c3Lower, "category_l3");
  }
  if (m.category_l4_equals_ci) {
    for (const v of m.category_l4_equals_ci) resolveExact(v, c4Lower, "category_l4");
  }
  if (m.category_l4_in_ci) {
    for (const v of m.category_l4_in_ci) resolveExact(v, c4Lower, "category_l4");
  }
  if (m.category_l3_or_l4_in_ci) {
    for (const v of m.category_l3_or_l4_in_ci) {
      const inC3 = c3Lower.get(String(v).trim().toLowerCase());
      const inC4 = c4Lower.get(String(v).trim().toLowerCase());
      if (inC3 == null && inC4 == null) {
        console.log("  ! MISMATCH  category_l3 + category_l4 have no entry matching '" + v + "'");
        missing++;
      } else {
        const dictTag = inC3 != null && inC4 != null ? "L3+L4" : (inC3 != null ? "L3" : "L4");
        const real = inC3 != null ? inC3 : inC4;
        console.log("    " + dictTag.padEnd(12) + "rule '" + v + "'  →  " + dictTag + " '" + real + "'");
      }
    }
  }
}

console.log("============================================================");
console.log(missing === 0 ? "ALL RULE VALUES RESOLVE TO REAL DICT ENTRIES." : "FOUND " + missing + " MISMATCH(ES). Rules-to-pill mapping would NO-OP on those.");
console.log("============================================================");
