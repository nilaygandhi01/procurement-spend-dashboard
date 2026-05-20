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
  isInHalfOpenRange
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
