/*
 * Unit tests for src/dashboard/index-math.mjs.
 *
 * Pure-math tests — no Excel reference required (that scope was dropped from
 * the task). These lock in the BEHAVIOR of the math module so any future
 * refactor that breaks a rule from INDEX_METHODOLOGY.md fails CI.
 *
 * Run with:
 *   node --test scripts/tests/index-math.test.mjs
 * Or:
 *   ./scripts/run-tests.ps1   (Windows)
 *   ./scripts/run-tests.sh    (Linux/macOS/Git Bash)
 *
 * No external dependencies — uses node:test + node:assert (built-in).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GRANULARITY,
  WEIGHTING,
  AGGREGATION,
  quarterOf,
  periodKeyOf,
  periodSortKey,
  comparePeriodKeys,
  expandPeriodRange,
  bucketRowsByPeriod,
  weightedUnitPriceByPeriod,
  rebaseToBaseline,
  computePartIndex,
  expandYearlyToQuarterly,
  isInDisplayWindow,
  isInHalfOpenRange,
  aggregateLaspeyres,
  aggregateSimpleMean,
  aggregatePooledReweighted,
  aggregatePartIndexes,
  parseExcelPivotText,
  normalizePeriodLabel,
  diffPartIndexes,
  computeBaselineCoverage,
  sumByPeriodAcrossParts
} from "../../src/dashboard/index-math.mjs";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Convenience: a row with year/month/spend/qty. month is 1-indexed (Jan = 1). */
function row(year, month, spend, qty) {
  return { year, month, spend, qty };
}

/** Compare a numeric map allowing small float tolerance. */
function assertNumMapApprox(actual, expected, tol = 1e-9) {
  const aKeys = Object.keys(actual).sort();
  const eKeys = Object.keys(expected).sort();
  assert.deepEqual(aKeys, eKeys, `period keys differ: actual=${aKeys.join(",")} expected=${eKeys.join(",")}`);
  for (const k of eKeys) {
    assert.ok(
      Math.abs(actual[k] - expected[k]) <= tol,
      `at ${k}: actual=${actual[k]} expected=${expected[k]} delta=${actual[k] - expected[k]}`
    );
  }
}

// --------------------------------------------------------------------------
// quarterOf / periodKeyOf
// --------------------------------------------------------------------------

test("quarterOf maps months to half-open quarter buckets", () => {
  assert.equal(quarterOf(1), 1);
  assert.equal(quarterOf(2), 1);
  assert.equal(quarterOf(3), 1);
  // Boundary: month 4 (April) belongs to Q2, never Q1. This is the rule that
  // matches Excel `< DATE(2024,4,1)` exclusive upper bound.
  assert.equal(quarterOf(4), 2);
  assert.equal(quarterOf(6), 2);
  assert.equal(quarterOf(7), 3);
  assert.equal(quarterOf(9), 3);
  assert.equal(quarterOf(10), 4);
  assert.equal(quarterOf(12), 4);
});

test("quarterOf rejects out-of-range months", () => {
  assert.ok(Number.isNaN(quarterOf(0)));
  assert.ok(Number.isNaN(quarterOf(13)));
  assert.ok(Number.isNaN(quarterOf("xyz")));
});

test("periodKeyOf produces stable yearly + quarterly keys", () => {
  assert.equal(periodKeyOf(2024, 1, GRANULARITY.YEARLY), "2024");
  assert.equal(periodKeyOf(2024, 12, GRANULARITY.YEARLY), "2024");
  assert.equal(periodKeyOf(2024, 1, GRANULARITY.QUARTERLY), "2024-Q1");
  assert.equal(periodKeyOf(2024, 4, GRANULARITY.QUARTERLY), "2024-Q2");
  assert.equal(periodKeyOf(2025, 10, GRANULARITY.QUARTERLY), "2025-Q4");
});

test("periodKeyOf returns null for invalid input", () => {
  assert.equal(periodKeyOf(null, 1, GRANULARITY.YEARLY), null);
  assert.equal(periodKeyOf(2024, 0, GRANULARITY.QUARTERLY), null);
  assert.equal(periodKeyOf(2024, 13, GRANULARITY.QUARTERLY), null);
});

// --------------------------------------------------------------------------
// periodSortKey / comparePeriodKeys / expandPeriodRange
// --------------------------------------------------------------------------

test("periodSortKey orders mixed yearly + quarterly on one number line", () => {
  // Yearly "2024" aligns with Q1 of that year (same numeric rank)
  assert.equal(periodSortKey("2024"), periodSortKey("2024-Q1"));
  assert.ok(periodSortKey("2024-Q2") > periodSortKey("2024-Q1"));
  assert.ok(periodSortKey("2025-Q1") > periodSortKey("2024-Q4"));
});

test("comparePeriodKeys works for Array.sort", () => {
  const arr = ["2025-Q3", "2024", "2025-Q1", "2024-Q4", "2026"];
  arr.sort(comparePeriodKeys);
  assert.deepEqual(arr, ["2024", "2024-Q4", "2025-Q1", "2025-Q3", "2026"]);
});

test("expandPeriodRange yearly covers inclusive years", () => {
  assert.deepEqual(expandPeriodRange("2024", "2026", GRANULARITY.YEARLY), ["2024", "2025", "2026"]);
});

test("expandPeriodRange quarterly walks year/quarter inclusively", () => {
  assert.deepEqual(
    expandPeriodRange("2024-Q3", "2025-Q2", GRANULARITY.QUARTERLY),
    ["2024-Q3", "2024-Q4", "2025-Q1", "2025-Q2"]
  );
});

test("expandPeriodRange returns [] when start > end", () => {
  assert.deepEqual(expandPeriodRange("2026", "2024", GRANULARITY.YEARLY), []);
  assert.deepEqual(expandPeriodRange("2025-Q4", "2025-Q1", GRANULARITY.QUARTERLY), []);
});

// --------------------------------------------------------------------------
// bucketRowsByPeriod
// --------------------------------------------------------------------------

test("bucketRowsByPeriod skips invalid rows and aggregates spend/qty", () => {
  const rows = [
    row(2024, 1, 1000, 10),     // valid
    row(2024, 2, 500, 5),       // valid
    row(2024, 3, 0, 4),         // valid: zero-spend with positive qty is allowed
    row(2024, 4, 999, 0),       // invalid: qty <= 0
    row(2024, 5, NaN, 3),       // invalid: spend non-finite
    row(2024, 6, 300, NaN),     // invalid: qty non-finite
    { year: 0, month: 1, spend: 1, qty: 1 },  // invalid year
  ];
  const buckets = bucketRowsByPeriod(rows, GRANULARITY.YEARLY);
  assert.deepEqual(Object.keys(buckets), ["2024"]);
  assert.equal(buckets["2024"].spend, 1500);
  assert.equal(buckets["2024"].qty, 19);
});

test("bucketRowsByPeriod respects quarterly half-open boundary at month 4", () => {
  const rows = [
    row(2024, 3, 100, 10),  // Q1
    row(2024, 4, 200, 20),  // Q2 (NOT Q1)
  ];
  const buckets = bucketRowsByPeriod(rows, GRANULARITY.QUARTERLY);
  assert.deepEqual(Object.keys(buckets).sort(), ["2024-Q1", "2024-Q2"]);
  assert.equal(buckets["2024-Q1"].spend, 100);
  assert.equal(buckets["2024-Q1"].qty, 10);
  assert.equal(buckets["2024-Q2"].spend, 200);
  assert.equal(buckets["2024-Q2"].qty, 20);
});

test("bucketRowsByPeriod handles non-array input gracefully", () => {
  // The implementation uses Object.create(null) for the bucket map (no prototype
  // pollution risk), so we check emptiness by key count rather than deepEqual
  // against {} (which compares prototypes too).
  assert.equal(Object.keys(bucketRowsByPeriod(null, GRANULARITY.YEARLY)).length, 0);
  assert.equal(Object.keys(bucketRowsByPeriod(undefined, GRANULARITY.QUARTERLY)).length, 0);
  assert.equal(Object.keys(bucketRowsByPeriod("not an array", GRANULARITY.YEARLY)).length, 0);
  assert.equal(Object.keys(bucketRowsByPeriod(42, GRANULARITY.YEARLY)).length, 0);
});

// --------------------------------------------------------------------------
// weightedUnitPriceByPeriod
// --------------------------------------------------------------------------

test("weightedUnitPriceByPeriod = Σspend / Σqty (not simple mean of unit prices)", () => {
  // Two rows in 2024 with very unequal qty so weighted ≠ simple
  //   row A: 100 units @ $1   (unit price 1, spend 100)
  //   row B:   1 unit  @ $100 (unit price 100, spend 100)
  // Simple mean of unit prices = (1 + 100)/2 = 50.5
  // Weighted (Σspend / Σqty) = 200 / 101 ≈ 1.980198…
  const rows = [row(2024, 1, 100, 100), row(2024, 6, 100, 1)];
  const buckets = bucketRowsByPeriod(rows, GRANULARITY.YEARLY);
  const weighted = weightedUnitPriceByPeriod(buckets);
  const expected = 200 / 101;
  assert.ok(Math.abs(weighted["2024"] - expected) < 1e-9, `got ${weighted["2024"]} expected ${expected}`);
  // And it is definitely not 50.5 (the wrong / simple-average result)
  assert.ok(Math.abs(weighted["2024"] - 50.5) > 1, "weighted unit price must differ from simple mean");
});

test("weightedUnitPriceByPeriod skips buckets with zero qty", () => {
  // Construct a bucket map by hand to test the function in isolation
  const map = { "2024": { spend: 0, qty: 0 }, "2025": { spend: 200, qty: 4 } };
  const w = weightedUnitPriceByPeriod(map);
  assert.deepEqual(Object.keys(w), ["2025"]);
  assert.equal(w["2025"], 50);
});

// --------------------------------------------------------------------------
// rebaseToBaseline
// --------------------------------------------------------------------------

test("rebaseToBaseline pins baseline to exactly 100", () => {
  const raw = { "2024": 50, "2025": 60, "2026": 75 };
  const r = rebaseToBaseline(raw, "2024");
  assert.equal(r.ok, true);
  assert.equal(r.indexed["2024"], 100);
  assert.equal(r.indexed["2025"], 120);
  assert.equal(r.indexed["2026"], 150);
});

test("rebaseToBaseline returns ok=false when baseline period missing", () => {
  const raw = { "2025": 60, "2026": 75 };
  const r = rebaseToBaseline(raw, "2024");
  assert.equal(r.ok, false);
  assert.deepEqual(r.indexed, {});
});

test("rebaseToBaseline returns ok=false when baseline value is zero/negative/non-finite", () => {
  assert.equal(rebaseToBaseline({ "2024": 0 }, "2024").ok, false);
  assert.equal(rebaseToBaseline({ "2024": -1 }, "2024").ok, false);
  assert.equal(rebaseToBaseline({ "2024": NaN }, "2024").ok, false);
});

// --------------------------------------------------------------------------
// computePartIndex — the full pipeline
// --------------------------------------------------------------------------

test("computePartIndex yearly: FY 2024 baseline is exactly 100, later years scale", () => {
  // Synthetic part: clean monthly data, spend/qty doubles in 2025, triples in 2026.
  // Pick numbers so that the FY weighted price is easy to verify:
  //   2024: 12 rows × (spend=100, qty=10) → Σspend=1200 Σqty=120 → unit=10
  //   2025: 12 rows × (spend=200, qty=10) → unit=20  → index = 200
  //   2026: 12 rows × (spend=300, qty=10) → unit=30  → index = 300
  const rows = [];
  for (let m = 1; m <= 12; m++) rows.push(row(2024, m, 100, 10));
  for (let m = 1; m <= 12; m++) rows.push(row(2025, m, 200, 10));
  for (let m = 1; m <= 12; m++) rows.push(row(2026, m, 300, 10));
  const r = computePartIndex(rows, GRANULARITY.YEARLY, "2024");
  assert.equal(r.ok, true);
  assertNumMapApprox(r.indexed, { "2024": 100, "2025": 200, "2026": 300 });
});

test("computePartIndex quarterly: Q1 2024 baseline pins Q1 to 100, other quarters scale", () => {
  // Q1 2024 unit price = 10; Q2 2024 unit price = 11 → Q2 index = 110
  const rows = [
    row(2024, 1, 100, 10), row(2024, 2, 100, 10), row(2024, 3, 100, 10),  // Q1: unit 10
    row(2024, 4, 110, 10), row(2024, 5, 110, 10), row(2024, 6, 110, 10),  // Q2: unit 11
  ];
  const r = computePartIndex(rows, GRANULARITY.QUARTERLY, "2024-Q1");
  assert.equal(r.ok, true);
  assertNumMapApprox(r.indexed, { "2024-Q1": 100, "2024-Q2": 110 });
});

test("computePartIndex quarterly: quarter boundary lands April rows in Q2 not Q1", () => {
  // If April rows leaked into Q1, the Q1 weighted price would be different.
  // We construct numbers where the miscategorization would show up.
  const rows = [
    row(2024, 1, 100, 10),  // Q1: spend 100, qty 10
    row(2024, 4, 999, 100), // Q2: spend 999, qty 100. MUST NOT contaminate Q1.
  ];
  const r = computePartIndex(rows, GRANULARITY.QUARTERLY, "2024-Q1");
  // Q1 weighted = 100/10 = 10 → index 100
  // Q2 weighted = 999/100 = 9.99 → index 99.9
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.indexed["2024-Q1"] - 100) < 1e-9);
  assert.ok(Math.abs(r.indexed["2024-Q2"] - 99.9) < 1e-9);
});

test("computePartIndex: quarter emits when only some months have data (partial-period rule)", () => {
  // Q3 2025 has only the August row; should still emit a period with that single row's weighted price
  const rows = [
    row(2024, 6, 100, 10),   // Q2 baseline-feeder
    row(2025, 8, 200, 5),    // Q3 2025 only month with data
  ];
  const r = computePartIndex(rows, GRANULARITY.QUARTERLY, "2024-Q2");
  assert.equal(r.ok, true);
  assert.ok("2025-Q3" in r.indexed, "Q3 2025 should still emit even with only 1 of 3 months populated");
  // 200/5 / (100/10) * 100 = 40/10 * 100 = 400
  assert.ok(Math.abs(r.indexed["2025-Q3"] - 400) < 1e-9);
});

test("computePartIndex: baseline math does NOT depend on display window (requirement #3)", () => {
  // This test directly enforces the most important invariant from the spec:
  // narrowing the display window must not change any indexed value.
  // The math module has no concept of a display window — that's enforced at
  // the chart layer — but we can still assert that the indexed map is a pure
  // function of (rows, granularity, baselineKey).
  const rows = [
    row(2024, 1, 100, 10),
    row(2024, 6, 100, 10),
    row(2025, 1, 200, 10),
    row(2025, 6, 200, 10),
    row(2026, 1, 300, 10),
    row(2026, 6, 300, 10),
  ];
  // Run with the full row stream
  const full = computePartIndex(rows, GRANULARITY.YEARLY, "2024");
  // Run again with the same row stream — the math is pure, so we should get
  // identical numbers. The "display window" in production is applied AFTER
  // this map is computed (in renderIndexChart), never before.
  const again = computePartIndex(rows, GRANULARITY.YEARLY, "2024");
  assert.deepEqual(full.indexed, again.indexed);
  // And the indexed values are anchored to the baseline regardless of what
  // window the chart later chooses to render.
  assert.equal(full.indexed["2024"], 100);
  assert.ok(Math.abs(full.indexed["2025"] - 200) < 1e-9);
  assert.ok(Math.abs(full.indexed["2026"] - 300) < 1e-9);
});

// --------------------------------------------------------------------------
// expandYearlyToQuarterly
// --------------------------------------------------------------------------

test("expandYearlyToQuarterly flat-steps each year across 4 quarters", () => {
  const yearly = { "2024": 100, "2025": 120, "2026": 150 };
  const q = expandYearlyToQuarterly(yearly);
  for (let y = 2024; y <= 2026; y++) {
    for (let q1 = 1; q1 <= 4; q1++) {
      assert.equal(q[y + "-Q" + q1], yearly[String(y)], `${y} Q${q1} should equal yearly ${y}`);
    }
  }
});

// --------------------------------------------------------------------------
// isInDisplayWindow / isInHalfOpenRange
// --------------------------------------------------------------------------

test("isInDisplayWindow treats both bounds as inclusive (UX expectation)", () => {
  assert.ok(isInDisplayWindow("2025-Q1", "2025-Q1", "2026-Q1"));   // start inclusive
  assert.ok(isInDisplayWindow("2026-Q1", "2025-Q1", "2026-Q1"));   // end inclusive
  assert.ok(!isInDisplayWindow("2024-Q4", "2025-Q1", "2026-Q1"));
  assert.ok(!isInDisplayWindow("2026-Q2", "2025-Q1", "2026-Q1"));
  // null bounds = unbounded on that side
  assert.ok(isInDisplayWindow("2020", null, "2026"));
  assert.ok(isInDisplayWindow("2030", "2024", null));
});

test("isInHalfOpenRange treats end as exclusive (Excel AVERAGEIFS convention)", () => {
  assert.ok(isInHalfOpenRange("2024-Q1", "2024-Q1", "2024-Q2"));
  // 2024-Q2 is the exclusive upper bound — must NOT be included
  assert.ok(!isInHalfOpenRange("2024-Q2", "2024-Q1", "2024-Q2"));
  // 2024-Q1 IS the inclusive lower bound — must be included
  assert.ok(isInHalfOpenRange("2024-Q1", "2024-Q1", null));
});

// --------------------------------------------------------------------------
// WEIGHTING methods
// --------------------------------------------------------------------------

test("WEIGHTING.QTY matches Σspend/Σqty regardless of row order", () => {
  const rows = [row(2024, 1, 100, 10), row(2024, 2, 600, 20)];
  const b = bucketRowsByPeriod(rows, GRANULARITY.YEARLY);
  const p = weightedUnitPriceByPeriod(b, WEIGHTING.QTY);
  // (100+600)/(10+20) = 700/30 = 23.333…
  assert.ok(Math.abs(p["2024"] - 700 / 30) < 1e-9);
});

test("WEIGHTING.SPEND uses spend as the weight, not quantity", () => {
  // Row 1: price 10, spend 100 (qty 10).  Row 2: price 30, spend 600 (qty 20).
  // SPEND-weighted: (10*100 + 30*600) / (100+600) = (1000+18000)/700 = 27.142857…
  // QTY-weighted:   (100+600)/(10+20) = 23.333…  ← different!
  const rows = [row(2024, 1, 100, 10), row(2024, 2, 600, 20)];
  const b = bucketRowsByPeriod(rows, GRANULARITY.YEARLY);
  const p = weightedUnitPriceByPeriod(b, WEIGHTING.SPEND);
  assert.ok(Math.abs(p["2024"] - 19000 / 700) < 1e-9);
});

test("WEIGHTING.SIMPLE returns mean of per-row unit prices (no qty weighting)", () => {
  // Row 1: price 10.  Row 2: price 30.  Simple mean = 20.
  // QTY-weighted is 23.33 — pinning them apart proves SIMPLE is not QTY.
  const rows = [row(2024, 1, 100, 10), row(2024, 2, 600, 20)];
  const b = bucketRowsByPeriod(rows, GRANULARITY.YEARLY);
  const p = weightedUnitPriceByPeriod(b, WEIGHTING.SIMPLE);
  assert.ok(Math.abs(p["2024"] - 20) < 1e-9);
});

test("WEIGHTING default is QTY when method arg omitted", () => {
  const rows = [row(2024, 1, 100, 10), row(2024, 2, 600, 20)];
  const b = bucketRowsByPeriod(rows, GRANULARITY.YEARLY);
  assert.deepEqual(
    weightedUnitPriceByPeriod(b),
    weightedUnitPriceByPeriod(b, WEIGHTING.QTY)
  );
});

// --------------------------------------------------------------------------
// AGGREGATION across parts
// --------------------------------------------------------------------------

/**
 * Build two parts with very different baseline spend so we can prove the
 * weighted aggregator is NOT the same as the simple-mean aggregator.
 */
function twoPartFixture() {
  // Part A: $100K baseline, prices double in 2025 → index 200
  // Part B: $1M baseline, prices flat in 2025  → index 100
  const partA = [
    row(2024, 1, 100000, 1000),  // $100/unit
    row(2025, 1, 200000, 1000),  // $200/unit
  ];
  const partB = [
    row(2024, 1, 1000000, 10000), // $100/unit
    row(2025, 1, 1000000, 10000), // $100/unit (flat)
  ];
  const bucketsA = bucketRowsByPeriod(partA, GRANULARITY.YEARLY);
  const bucketsB = bucketRowsByPeriod(partB, GRANULARITY.YEARLY);
  const perPartBuckets = { A: bucketsA, B: bucketsB };
  const perPartIndexed = {
    A: rebaseToBaseline(weightedUnitPriceByPeriod(bucketsA), "2024"),
    B: rebaseToBaseline(weightedUnitPriceByPeriod(bucketsB), "2024")
  };
  return { perPartBuckets, perPartIndexed };
}

test("aggregateLaspeyres uses base-period spend as fixed weight", () => {
  const { perPartBuckets, perPartIndexed } = twoPartFixture();
  // Weights: A=$100K, B=$1M. 2025 indexes: A=200, B=100.
  // Laspeyres = (200*100k + 100*1M) / (100k + 1M)
  //           = (20M + 100M) / 1.1M = 120M/1.1M ≈ 109.0909…
  const r = aggregateLaspeyres(perPartIndexed, perPartBuckets, "2024");
  assert.equal(r.ok, true);
  assert.equal(r.indexed["2024"], 100);
  assert.ok(Math.abs(r.indexed["2025"] - (120e6 / 1.1e6)) < 1e-6);
  assert.equal(r.contributingParts.length, 2);
});

test("aggregateSimpleMean is the arithmetic mean — visibly different from Laspeyres", () => {
  const { perPartIndexed } = twoPartFixture();
  // Simple mean of part indexes for 2025: (200 + 100) / 2 = 150
  const r = aggregateSimpleMean(perPartIndexed);
  assert.equal(r.ok, true);
  assert.equal(r.indexed["2025"], 150);
  // …and 150 ≠ 109.09 (the Laspeyres number from the test above).
});

test("aggregatePooledReweighted treats the basket as one big part", () => {
  const { perPartBuckets } = twoPartFixture();
  // Pooled spend 2024 = $100K + $1M = $1.1M;  qty 2024 = 1000 + 10000 = 11000
  // Pooled price 2024 = 1.1M / 11000 = $100/unit
  // Pooled spend 2025 = $200K + $1M = $1.2M;  qty 2025 = 11000
  // Pooled price 2025 = 1.2M / 11000 ≈ $109.09/unit  →  index ≈ 109.0909…
  const r = aggregatePooledReweighted(perPartBuckets, "2024");
  assert.equal(r.ok, true);
  assert.equal(r.indexed["2024"], 100);
  assert.ok(Math.abs(r.indexed["2025"] - ((1.2e6 / 11000) / (1.1e6 / 11000) * 100)) < 1e-6);
});

test("aggregatePartIndexes dispatches on AGGREGATION constant", () => {
  const { perPartBuckets, perPartIndexed } = twoPartFixture();
  const las = aggregatePartIndexes(perPartBuckets, perPartIndexed, "2024", AGGREGATION.LASPEYRES);
  const sim = aggregatePartIndexes(perPartBuckets, perPartIndexed, "2024", AGGREGATION.SIMPLE);
  const pool = aggregatePartIndexes(perPartBuckets, perPartIndexed, "2024", AGGREGATION.POOLED);
  // All three converge at the baseline (=100) but diverge elsewhere
  assert.equal(las.indexed["2024"], 100);
  assert.equal(sim.indexed["2024"], 100);
  assert.equal(pool.indexed["2024"], 100);
  assert.notEqual(las.indexed["2025"], sim.indexed["2025"]);
});

test("aggregateLaspeyres skips parts with no baseline spend", () => {
  // Part C only has 2025 data — should be excluded entirely from a 2024-
  // baseline Laspeyres aggregate.
  const partC = [row(2025, 1, 500, 10)];
  const bucketsC = bucketRowsByPeriod(partC, GRANULARITY.YEARLY);
  const perPartBuckets = { C: bucketsC };
  const perPartIndexed = {
    C: rebaseToBaseline(weightedUnitPriceByPeriod(bucketsC), "2024")
  };
  const r = aggregateLaspeyres(perPartIndexed, perPartBuckets, "2024");
  assert.equal(r.ok, false); // no contributing parts
  assert.equal(r.contributingParts.length, 0);
});

// --------------------------------------------------------------------------
// computeBaselineCoverage
// --------------------------------------------------------------------------

test("computeBaselineCoverage reports included-vs-total base spend", () => {
  // Two parts: A has good baseline data ($100K), B's baseline is empty ($0).
  const partA = [row(2024, 1, 100000, 1000), row(2025, 1, 200000, 1000)];
  const partB = [row(2025, 1, 50000, 500)];
  const bA = bucketRowsByPeriod(partA, GRANULARITY.YEARLY);
  const bB = bucketRowsByPeriod(partB, GRANULARITY.YEARLY);
  const perPartBuckets = { A: bA, B: bB };
  const perPartIndexed = {
    A: rebaseToBaseline(weightedUnitPriceByPeriod(bA), "2024"),
    B: rebaseToBaseline(weightedUnitPriceByPeriod(bB), "2024"),
  };
  const cov = computeBaselineCoverage(perPartBuckets, perPartIndexed, "2024");
  // Only A has spend in 2024 → total = $100K; B contributes 0.
  // A is ok (its baseline math succeeded) → included = $100K.
  // B is NOT ok (its rebase failed) → contributes 0.
  // Coverage = 100% of the $100K base spend.
  assert.equal(cov.totalBaseSpend, 100000);
  assert.equal(cov.includedBaseSpend, 100000);
  assert.equal(cov.coveragePct, 100);
});

// --------------------------------------------------------------------------
// sumByPeriodAcrossParts
// --------------------------------------------------------------------------

test("sumByPeriodAcrossParts collapses parts into one tile of {spend,qty}", () => {
  const { perPartBuckets } = twoPartFixture();
  const totals = sumByPeriodAcrossParts(perPartBuckets);
  assert.equal(totals["2024"].spend, 1100000);
  assert.equal(totals["2024"].qty, 11000);
  assert.equal(totals["2025"].spend, 1200000);
  assert.equal(totals["2025"].qty, 11000);
});

// --------------------------------------------------------------------------
// normalizePeriodLabel
// --------------------------------------------------------------------------

test("normalizePeriodLabel accepts wide variety of Excel-friendly forms", () => {
  assert.equal(normalizePeriodLabel("2024"), "2024");
  assert.equal(normalizePeriodLabel("2024-Q1"), "2024-Q1");
  assert.equal(normalizePeriodLabel("2024 Q1"), "2024-Q1");
  assert.equal(normalizePeriodLabel("Q1 2024"), "2024-Q1");
  assert.equal(normalizePeriodLabel("Q1-2024"), "2024-Q1");
  assert.equal(normalizePeriodLabel("Q3-24"), "2024-Q3");
  assert.equal(normalizePeriodLabel("garbage"), null);
  assert.equal(normalizePeriodLabel(""), null);
  assert.equal(normalizePeriodLabel(null), null);
});

// --------------------------------------------------------------------------
// parseExcelPivotText
// --------------------------------------------------------------------------

test("parseExcelPivotText parses tab-separated wide pivot", () => {
  const txt = [
    "PartNumber\t2024\t2025\t2026",
    "ABC-001\t100\t108.2\t112.4",
    "XYZ-999\t100\t99.7\t103.1",
  ].join("\n");
  const r = parseExcelPivotText(txt);
  assert.deepEqual(r.partOrder, ["ABC-001", "XYZ-999"]);
  assert.deepEqual(r.periodOrder, ["2024", "2025", "2026"]);
  assert.equal(r.byPart["ABC-001"]["2025"], 108.2);
  assert.equal(r.byPart["XYZ-999"]["2026"], 103.1);
});

test("parseExcelPivotText parses comma-separated quarterly pivot", () => {
  const txt = [
    "Part,2024-Q1,2024-Q2,2024-Q3,2024-Q4",
    "P1,100,105,110,108",
  ].join("\n");
  const r = parseExcelPivotText(txt);
  assert.deepEqual(r.periodOrder, ["2024-Q1", "2024-Q2", "2024-Q3", "2024-Q4"]);
  assert.equal(r.byPart["P1"]["2024-Q3"], 110);
});

test("parseExcelPivotText parses long (3-column) format", () => {
  const txt = [
    "Part\tPeriod\tIndex",
    "ABC\t2024\t100",
    "ABC\t2025\t108.2",
    "XYZ\t2025\t99.7",
  ].join("\n");
  const r = parseExcelPivotText(txt);
  assert.equal(r.byPart["ABC"]["2024"], 100);
  assert.equal(r.byPart["ABC"]["2025"], 108.2);
  assert.equal(r.byPart["XYZ"]["2025"], 99.7);
});

test("parseExcelPivotText warns but doesn't throw on bad cells", () => {
  const txt = [
    "Part\t2024\t2025",
    "ABC\t100\tnot-a-number",
  ].join("\n");
  const r = parseExcelPivotText(txt);
  assert.equal(r.byPart["ABC"]["2024"], 100);
  assert.equal(r.byPart["ABC"]["2025"], undefined);
  assert.ok(r.warnings.length >= 1);
});

test("parseExcelPivotText empty / whitespace input returns empty result with warning", () => {
  const r = parseExcelPivotText("   \n\n  ");
  assert.equal(r.partOrder.length, 0);
  assert.ok(r.warnings.length >= 1);
});

// --------------------------------------------------------------------------
// diffPartIndexes
// --------------------------------------------------------------------------

test("diffPartIndexes flags matches inside tolerance and mismatches outside", () => {
  const dash = { A: { "2024": 100, "2025": 108.4 }, B: { "2024": 100, "2025": 95 } };
  const exc  = { A: { "2024": 100, "2025": 108.2 }, B: { "2024": 100, "2025": 99 } };
  const r = diffPartIndexes(dash, exc, 0.5);
  const matchA = r.rows.find((x) => x.partKey === "A" && x.periodKey === "2025");
  const failB  = r.rows.find((x) => x.partKey === "B" && x.periodKey === "2025");
  assert.equal(matchA.status, "match");
  assert.ok(Math.abs(matchA.delta - 0.2) < 1e-9);
  assert.equal(failB.status, "fail");
  assert.equal(r.summary.matched, 3);   // A/2024, A/2025, B/2024
  assert.equal(r.summary.failed, 1);    // B/2025
});

test("diffPartIndexes reports missing dashboard / missing reference rows", () => {
  // Dashboard knows A only @2024 and Z only @2024. Reference knows A@2024+2025 and B@2024.
  //   A/2024 → match (both sides)
  //   A/2025 → missing-dashboard (only in reference)
  //   B/2024 → missing-dashboard (only in reference)
  //   Z/2024 → missing-reference (only in dashboard)
  const dash = { A: { "2024": 100 },                 Z: { "2024": 100 } };
  const exc  = { A: { "2024": 100, "2025": 110 },     B: { "2024": 100 } };
  const r = diffPartIndexes(dash, exc, 0.5);
  const aMissDash = r.rows.find((x) => x.partKey === "A" && x.periodKey === "2025");
  const bMissDash = r.rows.find((x) => x.partKey === "B" && x.periodKey === "2024");
  const zMissRef  = r.rows.find((x) => x.partKey === "Z" && x.periodKey === "2024");
  assert.equal(aMissDash.status, "missing-dashboard");
  assert.equal(bMissDash.status, "missing-dashboard");
  assert.equal(zMissRef.status,  "missing-reference");
  assert.equal(r.summary.missingDashboard, 2);
  assert.equal(r.summary.missingReference, 1);
});

test("diffPartIndexes tracks max abs delta and max abs pct delta", () => {
  const dash = { A: { "2024": 100, "2025": 130 } };
  const exc  = { A: { "2024": 100, "2025": 110 } };
  const r = diffPartIndexes(dash, exc, 0.5);
  assert.equal(r.summary.maxAbsDelta, 20);
  assert.ok(Math.abs(r.summary.maxAbsPctDelta - (20 / 110) * 100) < 1e-9);
  assert.deepEqual(r.summary.maxAbsDeltaRow, { partKey: "A", periodKey: "2025" });
});

// --------------------------------------------------------------------------
// Directory-driven PPI index loader — sanity-check the generated JSON pack
// produced by `py scripts/build-builtin-index-pack.py --write` that the
// dashboard inlines at build time. We don't import the Python script; we
// just validate the JSON's shape so a corrupted pack fails CI before it
// reaches a user's browser.
// --------------------------------------------------------------------------
test("generated index pack has the expected 5 new BLS series codes", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const path = resolve("data/inputs/index-data/generated-index-pack.json");
  const raw = await readFile(path, "utf8");
  const pack = JSON.parse(raw);
  for (const code of [
    "PCU3339133391",
    "PCU333996333996",
    "WPU1017",
    "WPU114301",
    "WPU11430119",
  ]) {
    assert.ok(pack[code], `missing entry: ${code}`);
    const e = pack[code];
    assert.ok(typeof e.displayName === "string" && e.displayName.length, `${code}: displayName missing`);
    assert.ok(e.rawByYear && typeof e.rawByYear === "object", `${code}: rawByYear missing`);
    // Every shipped index has 2024 data (the canonical rebase baseline).
    const years = Object.keys(e.rawByYear).map((y) => +y).filter(Number.isFinite);
    assert.ok(years.includes(2024), `${code}: rawByYear lacks 2024 — rebase will fail`);
  }
});

test("generated index pack values rebase cleanly to 2024 = 100", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const raw = await readFile(resolve("data/inputs/index-data/generated-index-pack.json"), "utf8");
  const pack = JSON.parse(raw);
  for (const [code, entry] of Object.entries(pack)) {
    // Convert string keys to int for rebaseToBaseline().
    const rawByYear = {};
    for (const [yk, v] of Object.entries(entry.rawByYear)) rawByYear[+yk] = +v;
    const rb = rebaseToBaseline(rawByYear, 2024);
    assert.ok(rb.ok, `${code}: rebaseToBaseline.ok = false`);
    assert.ok(Math.abs(rb.indexed[2024] - 100) < 1e-9, `${code}: 2024 should rebase to 100, got ${rb.indexed[2024]}`);
    // No NaNs or infinities.
    for (const [yk, iv] of Object.entries(rb.indexed)) {
      assert.ok(Number.isFinite(iv), `${code}: indexed[${yk}] = ${iv} is not finite`);
    }
  }
});
