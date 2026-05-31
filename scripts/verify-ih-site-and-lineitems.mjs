// Verify the two Indirect Harmonization changes from this round:
//   1. Site name prettifier — produces proper-cased output from the
//      lowercased site values currently in data.json. Spot-check 3
//      sites (one Cummins manufacturing, one Cummins technologies,
//      one non-Cummins).
//   2. Line-item attribution — each Cat 1 / Cat 2 opportunity emitted
//      by the math layer is tied back to its underlying prep.rows
//      via _idpIhAssignedCat / _idpIhC1Key / _idpIhC2Key. Verify that
//      summing line-item spend per opp ties to opp.total_spend (Cat 1
//      exactly; Cat 2 within rounding because of cross-site aggregates),
//      and that the per-line row-savings vs benchmark roughly sums to
//      opp.savings.
//
// Run:
//   node --max-old-space-size=8192 scripts/verify-ih-site-and-lineitems.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// --- Inlined prettifier (copied from src/dashboard/index.html) -------------
const _IDP_IH_SITE_ACRONYMS = (() => {
  const arr = ["llc", "inc", "ltd", "ltda", "pvt", "co", "nv", "bv", "ag", "sa", "gmbh", "jv",
    "usa", "us", "uk", "eu", "uae", "rsa",
    "cfs", "cmi", "xpi", "cpif", "cp", "hudfld", "ctt", "cpf", "mro", "ats", "bof", "msc",
    "r&d", "rd", "it", "ai", "hr", "qc", "qa", "tc",
    "&", "ii", "iii", "iv"];
  const s = Object.create(null);
  for (const a of arr) s[a] = a.toUpperCase();
  return s;
})();
const _IDP_IH_SITE_LOWERS = (() => {
  const arr = ["of", "and", "the", "in", "on", "at", "to", "for", "de", "da", "del", "y", "e"];
  const s = Object.create(null);
  for (const a of arr) s[a] = 1;
  return s;
})();
function prettifySite(raw) {
  if (raw == null) return "";
  const s = String(raw);
  if (!s) return "";
  if (/[A-Z]/.test(s)) return s;
  let out = "";
  let lastWordStart = 0, atWordStart = true, isFirstWord = true;
  function flushWordCheck(endIx) {
    const word = out.slice(lastWordStart, endIx);
    if (!word) return;
    const lc = word.toLowerCase();
    if (_IDP_IH_SITE_ACRONYMS[lc]) {
      out = out.slice(0, lastWordStart) + _IDP_IH_SITE_ACRONYMS[lc];
    } else if (!isFirstWord && _IDP_IH_SITE_LOWERS[lc]) {
      out = out.slice(0, lastWordStart) + lc;
    }
    isFirstWord = false;
  }
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const isAlnum = /[A-Za-z0-9'&]/.test(ch);
    if (isAlnum) {
      if (atWordStart) {
        lastWordStart = out.length;
        out += ch.toUpperCase();
        atWordStart = false;
      } else {
        out += ch;
      }
    } else {
      if (!atWordStart) flushWordCheck(out.length);
      out += ch;
      atWordStart = true;
    }
  }
  if (!atWordStart) flushWordCheck(out.length);
  return out;
}

// --- Load harmonization math + data ---------------------------------------
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

console.log("=".repeat(78));
console.log("PART 1: SITE NAME PRETTIFIER SPOT-CHECK");
console.log("=".repeat(78));
const data = JSON.parse(fs.readFileSync(path.join(repoRoot, "src", "dashboard", "data.json"), "utf8"));
const rows = data.rows || [];
const indSiteSet = new Set();
for (const r of rows) if (r && r.spend_type === "Indirect" && r.site) indSiteSet.add(r.site);
const sortedIndSites = [...indSiteSet].sort();
console.log("\nAll", sortedIndSites.length, "distinct indirect site values, raw → prettified:");
for (const raw of sortedIndSites) {
  const out = prettifySite(raw);
  const tag = raw === out ? "  (unchanged)" : "";
  console.log("  " + JSON.stringify(raw).padEnd(58) + " →  " + JSON.stringify(out) + tag);
}

const spotChecks = [
  { tag: "Cummins manufacturing", raw: "cummins-scania xpi manufacturing, llc" },
  { tag: "Cummins technologies",  raw: "cummins turbo technologies - charleston" },
  { tag: "Non-Cummins",            raw: "jacobs vehicle systems, inc." }
];
console.log("\nThree spot-checks for the user-requested categories:");
for (const sc of spotChecks) {
  console.log("  [" + sc.tag.padEnd(22) + "] raw: " + JSON.stringify(sc.raw));
  console.log("  " + " ".repeat(26) + "ui:  " + JSON.stringify(prettifySite(sc.raw)));
}

// --- PART 2: Line-item attribution ----------------------------------------
console.log("\n" + "=".repeat(78));
console.log("PART 2: LINE-ITEM ATTRIBUTION INTEGRITY");
console.log("=".repeat(78));

// Filter to L1=Indirect, Time=2025 (matches the IH tab default view).
function isIndirect2025(r) {
  if (!r) return false;
  const c1 = (r.category_l1 ?? r.c1 ?? "").toString().trim().toLowerCase();
  if (c1 !== "indirect") return false;
  const y = +r.year || 0;
  if (y === 2025) return true;
  if (typeof r.ym === "string" && /\b2025\b/.test(r.ym)) return true;
  if (typeof r.d === "string" && /^2025\b/.test(r.d)) return true;
  return false;
}
const slice = rows.filter(isIndirect2025);

// Mirror _idpIhPrepareSliceCached: tag each row with _idpIhKey
function prepKey(r) {
  const part = r.part != null ? String(r.part).trim() : "";
  if (part && /[0-9]/.test(part)) return part;
  return null; // will be assigned a fuzzy key below
}
const rowsForKeying = slice.map(r => ({ row: r, partKey: prepKey(r) }));
const nameSource = (r) => {
  const m = r.material != null ? String(r.material).trim() : "";
  if (m) return m;
  const n = r.noun != null ? String(r.noun).trim() : "";
  if (n) return n;
  const c3 = r.category_l3 != null ? String(r.category_l3).trim() : "";
  return c3;
};
const nullKeyRows = rowsForKeying.filter(x => !x.partKey).map(x => x.row);
const blockKey = (r) => {
  const c3 = r.category_l3 != null ? String(r.category_l3).trim().toLowerCase() : "";
  return c3 || "_no_l3";
};
const fuzzyOut = IDPMATH.fuzzyClusterNames(nullKeyRows, nameSource, blockKey, FUZZY_THRESHOLD);
const fuzzyKeyByIdx = fuzzyOut.keyByIndex || {};
for (let i = 0, nullIdx = 0; i < rowsForKeying.length; i++) {
  if (rowsForKeying[i].partKey) continue;
  const k = fuzzyKeyByIdx[nullIdx];
  rowsForKeying[i].partKey = k != null ? "IH#FUZZY#" + k : "";
  nullIdx++;
}
const prepRows = rowsForKeying.map(x => {
  x.row._idpIhKey = x.partKey;
  return x.row;
}).filter(r => r._idpIhKey);

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
console.log("\nCat 1 opps:", mathOut.cat1Opps.length, "  Cat 2 opps:", mathOut.cat2Opps.length);

// Index prepRows by _idpIhC1Key (Cat 1) and _idpIhC2Key (Cat 2).
// Match what the Excel export does: include ALL group rows under
// every opp, regardless of dedup attribution, so Σ(Line Spend) ties
// to opp.total_spend exactly.
const c1Idx = Object.create(null), c2Idx = Object.create(null);
let c1RowsSeen = 0, c2RowsSeen = 0;
for (const r of prepRows) {
  if (r._idpIhC1Key) {
    if (!c1Idx[r._idpIhC1Key]) c1Idx[r._idpIhC1Key] = [];
    c1Idx[r._idpIhC1Key].push(r);
    c1RowsSeen++;
  }
  if (r._idpIhC2Key) {
    if (!c2Idx[r._idpIhC2Key]) c2Idx[r._idpIhC2Key] = [];
    c2Idx[r._idpIhC2Key].push(r);
    c2RowsSeen++;
  }
}
console.log("Cat 1 group-row index entries:", c1RowsSeen,
  "  Cat 2 group-row index entries:", c2RowsSeen);

function pad(n, w) { return String(n).padEnd(w); }
function reconcileOpp(opp, idx, catNum) {
  const key = catNum === 1 ? opp._c1Key : opp._c2Key;
  const lines = idx[key] || [];
  let sumSpend = 0, sumSav = 0;
  for (const ln of lines) {
    const qty = +(ln.quantity ?? ln.qty) || 0;
    const spend = +ln.spend || 0;
    let up = +ln.price;
    if (!isFinite(up) || up === 0) up = qty > 0 ? spend / qty : 0;
    sumSpend += spend;
    const bench = +opp.benchmark || 0;
    if (bench > 0 && up > bench && qty > 0) sumSav += (up - bench) * qty;
  }
  return { lines: lines.length, sumSpend, sumSav, oppSpend: +opp.total_spend, oppSav: +opp.savings };
}

console.log("\nCAT 1 spot-checks (top 3 by savings):");
const c1Top = mathOut.cat1Opps.slice(0, 3);
for (const opp of c1Top) {
  const r = reconcileOpp(opp, c1Idx, 1);
  const spendDiff = Math.abs(r.sumSpend - r.oppSpend);
  const savDiff = Math.abs(r.sumSav - r.oppSav);
  console.log("  " + pad(opp.item.slice(0, 30), 30),
    "lines=" + pad(r.lines, 4),
    "Σspend $" + pad(Math.round(r.sumSpend).toLocaleString(), 12),
    "opp.spend $" + pad(Math.round(r.oppSpend).toLocaleString(), 12),
    "Δ $" + Math.round(spendDiff),
    "| Σsav $" + pad(Math.round(r.sumSav).toLocaleString(), 12),
    "opp.sav $" + pad(Math.round(r.oppSav).toLocaleString(), 12),
    "Δ $" + Math.round(savDiff));
}
console.log("\nCAT 2 spot-checks (top 3 by savings):");
const c2Top = mathOut.cat2Opps.slice(0, 3);
for (const opp of c2Top) {
  const r = reconcileOpp(opp, c2Idx, 2);
  const spendDiff = Math.abs(r.sumSpend - r.oppSpend);
  const savDiff = Math.abs(r.sumSav - r.oppSav);
  console.log("  " + pad(opp.item.slice(0, 30), 30),
    "lines=" + pad(r.lines, 4),
    "Σspend $" + pad(Math.round(r.sumSpend).toLocaleString(), 12),
    "opp.spend $" + pad(Math.round(r.oppSpend).toLocaleString(), 12),
    "Δ $" + Math.round(spendDiff),
    "| Σsav $" + pad(Math.round(r.sumSav).toLocaleString(), 12),
    "opp.sav $" + pad(Math.round(r.oppSav).toLocaleString(), 12),
    "Δ $" + Math.round(savDiff));
}

// Aggregate counts: total line items in the Excel
let totalLineCount = 0;
for (const opp of mathOut.cat1Opps) totalLineCount += (c1Idx[opp._c1Key] || []).length;
for (const opp of mathOut.cat2Opps) totalLineCount += (c2Idx[opp._c2Key] || []).length;
const totalOppCount = mathOut.cat1Opps.length + mathOut.cat2Opps.length;
console.log("\nTotal distinct opportunities:        ", totalOppCount);
console.log("Total line-item rows in Excel export:", totalLineCount,
  "  (avg " + (totalLineCount / Math.max(1, totalOppCount)).toFixed(1) + " lines/opp)");

console.log("\nDone.");
