// Verify the Adjusted Scope filter by replicating its math against
// data.json using the SAME rules JSON the dashboard loads.
// Reports: per-rule isolated impact, walk-attributed (OR) impact, the
// post-filter adjusted total, and round-trip to the Total view.

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
function fmtUsd(n) {
  return "$" + (n / 1e6).toFixed(2) + "M";
}

const sliceAll = rows.filter(r => r && rowYear(r) === 2025);
const sliceInd = sliceAll.filter(r => ci(r.category_l1 || r.c1) === "indirect");
const sliceIndSpend = sliceInd.reduce((s, r) => s + num(r.spend), 0);

console.log("============================================================");
console.log(" ADJUSTED SCOPE VERIFICATION");
console.log("============================================================");
console.log("Rules file:", path.relative(repoRoot, path.join(repoRoot, "src", "dashboard", "config", "adjusted-scope-rules.json")));
console.log("Rules name:", rules.name);
console.log("Rule count:", rules.exclusions.length);
console.log();
console.log("Starting scope (2025 Indirect):", sliceInd.length, "rows /", fmtUsd(sliceIndSpend));

function lowerSet(arr) {
  const s = new Set();
  for (const v of arr || []) {
    const lo = ci(v);
    if (lo) s.add(lo);
  }
  return s;
}

function buildMatcher(rule) {
  const m = rule.match || {};
  const supContains = (m.supplier_contains_ci || []).map(ci);
  const c1Eq = lowerSet(m.category_l1_equals_ci);
  const c2Eq = lowerSet(m.category_l2_equals_ci);
  const c3Eq = lowerSet([...(m.category_l3_equals_ci || []), ...(m.category_l3_in_ci || [])]);
  const c4Eq = lowerSet([...(m.category_l4_equals_ci || []), ...(m.category_l4_in_ci || [])]);
  const c3orc4 = m.category_l3_or_l4_in_ci ? lowerSet(m.category_l3_or_l4_in_ci) : null;
  return function (r) {
    if (supContains.length) {
      const sup = ci(r.supplier || r.su);
      let ok = false;
      for (const t of supContains) { if (sup.indexOf(t) !== -1) { ok = true; break; } }
      if (!ok) return false;
    }
    if (c1Eq.size && !c1Eq.has(ci(r.category_l1 || r.c1))) return false;
    if (c2Eq.size && !c2Eq.has(ci(r.category_l2 || r.c2))) return false;
    if (c3orc4) {
      const l3 = ci(r.category_l3 || r.c3);
      const l4 = ci(r.category_l4 || r.c4);
      if (!c3orc4.has(l3) && !c3orc4.has(l4)) return false;
    } else {
      if (c3Eq.size && !c3Eq.has(ci(r.category_l3 || r.c3))) return false;
      if (c4Eq.size && !c4Eq.has(ci(r.category_l4 || r.c4))) return false;
    }
    return true;
  };
}

const compiled = rules.exclusions.map(rule => ({ ...rule, fn: buildMatcher(rule) }));

// applies_when gate (only L1=Indirect rows are eligible for exclusion)
const aw = rules.applies_when || {};
const awC1 = lowerSet(aw.category_l1_equals_ci);
function inApplyScope(r) {
  if (!awC1.size) return true;
  return awC1.has(ci(r.category_l1 || r.c1));
}

// --- Per-rule isolated impact (sliced to 2025 Indirect to match the user's walk frame) ---
console.log();
console.log("--- Per-rule impact (isolated, 2025 Indirect slice) ---");
console.log("Rule".padEnd(40) + "Rows".padStart(10) + "Impact".padStart(12) + "Expected".padStart(12) + "Delta".padStart(10));
for (const rule of compiled) {
  let n = 0, sp = 0;
  for (const r of sliceInd) if (rule.fn(r)) { n++; sp += num(r.spend); }
  const mm = sp / 1e6;
  const exp = +rule.expected_delta_usd_m || 0;
  const delta = mm - exp;
  const flag = (Math.abs(delta) > 0.05 * exp && exp > 0) ? "  (in isolation)" : "";
  console.log(rule.label.padEnd(40) + String(n).padStart(10) + (mm.toFixed(2) + "M").padStart(12) + (exp.toFixed(2) + "M").padStart(12) + (delta.toFixed(2) + "M").padStart(10) + flag);
}

// --- Walk-attributed (first-matching-wins) ---
console.log();
console.log("--- Walk-attributed impact (first-matching rule wins, OR semantics) ---");
console.log("Rule".padEnd(40) + "Rows".padStart(10) + "Impact".padStart(12) + "Expected".padStart(12) + "Delta".padStart(10));
const walk = Object.create(null);
for (const rule of compiled) walk[rule.id] = { n: 0, s: 0 };
for (const r of sliceInd) {
  if (!inApplyScope(r)) continue;
  for (const rule of compiled) {
    if (rule.fn(r)) { walk[rule.id].n++; walk[rule.id].s += num(r.spend); break; }
  }
}
let running = sliceIndSpend;
let allWithin5pct = true;
for (const rule of compiled) {
  const w = walk[rule.id];
  const mm = w.s / 1e6;
  const exp = +rule.expected_delta_usd_m || 0;
  const delta = mm - exp;
  const within = Math.abs(delta) <= 0.05 * exp || exp === 0;
  if (!within) allWithin5pct = false;
  const flag = within ? "  OK" : "  FLAG (>5%)";
  console.log(rule.label.padEnd(40) + String(w.n).padStart(10) + (mm.toFixed(2) + "M").padStart(12) + (exp.toFixed(2) + "M").padStart(12) + (delta.toFixed(2) + "M").padStart(10) + flag);
  running -= w.s;
}

// --- Final totals ---
console.log();
console.log("--- Final totals ---");
let excludedSpend = 0, excludedRows = 0;
for (const r of sliceInd) {
  if (!inApplyScope(r)) continue;
  for (const rule of compiled) {
    if (rule.fn(r)) { excludedSpend += num(r.spend); excludedRows++; break; }
  }
}
const adjusted = sliceIndSpend - excludedSpend;
console.log("Total Indirect 2025         :", fmtUsd(sliceIndSpend));
console.log("Excluded                    :", fmtUsd(excludedSpend), "(" + excludedRows + " rows)");
console.log("Adjusted Indirect 2025      :", fmtUsd(adjusted));
console.log("Target (user)               :", fmtUsd(194.8 * 1e6));
console.log("Delta vs target             :", fmtUsd(adjusted - 194.8 * 1e6));

// --- Round-trip (Total view should be unchanged) ---
console.log();
console.log("--- Round-trip Scope=Total (no exclusions) ---");
console.log("Total Indirect 2025 (Total view):", fmtUsd(sliceIndSpend));
console.log("Expected $388.13M             :", Math.abs(sliceIndSpend - 388.13e6) < 0.5e6 ? "MATCH" : "MISMATCH");

// --- applies_when sanity: Scope=Adjusted should be no-op for Direct rows ---
console.log();
console.log("--- applies_when sanity: Direct + Adjusted should equal Direct + Total ---");
const sliceDir = sliceAll.filter(r => ci(r.category_l1 || r.c1) === "direct");
const sliceDirSpend = sliceDir.reduce((s, r) => s + num(r.spend), 0);
let dirExcluded = 0;
for (const r of sliceDir) {
  if (!inApplyScope(r)) continue;
  for (const rule of compiled) {
    if (rule.fn(r)) { dirExcluded += num(r.spend); break; }
  }
}
console.log("Direct 2025 total           :", fmtUsd(sliceDirSpend));
console.log("Direct 2025 excluded by Adj :", fmtUsd(dirExcluded), "(should be $0 — applies_when=Indirect only)");

console.log();
console.log(allWithin5pct ? "OK: all rules within 5% of user's expected walk." : "WARN: at least one rule deviates >5% from user's expected walk.");
console.log("DONE.");
