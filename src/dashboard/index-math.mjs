/*
 * Index analysis math — pure ES module.
 *
 * Imported by both:
 *  - src/dashboard/index.html (via a <script type="module"> shim that
 *    assigns to window.IDP_INDEX_MATH so the legacy inline globals
 *    code can keep using globals without conversion to modules).
 *  - scripts/tests/index-math.test.mjs (node --test, no DOM).
 *
 * See INDEX_METHODOLOGY.md (repo root) for the formal definitions
 * behind each function below.
 *
 * Period-key convention used throughout this module:
 *   - Yearly      → "YYYY"           e.g. "2024"
 *   - Quarterly   → "YYYY-Qn"        e.g. "2024-Q1", "2025-Q4"
 */

const GRANULARITY = Object.freeze({ YEARLY: "yearly", QUARTERLY: "quarterly" });

/**
 * Quarter (1..4) for a 1-indexed month (1..12).
 * Half-open by construction: Jan/Feb/Mar→1, Apr/May/Jun→2, Jul/Aug/Sep→3, Oct/Nov/Dec→4.
 * A 2024-04-01 row therefore lands in Q2 — matching the Excel
 * `AVERAGEIFS(..., date_range, ">="&"2024-04-01", date_range, "<"&"2024-07-01")` pattern.
 */
function quarterOf(month1to12) {
  const m = +month1to12;
  if (!Number.isFinite(m) || m < 1 || m > 12) return NaN;
  return Math.floor((m - 1) / 3) + 1;
}

/**
 * Build the period key a row falls into under the given granularity.
 * Returns null if the year/month is invalid.
 */
function periodKeyOf(year, month1to12, granularity) {
  const y = +year;
  if (!Number.isFinite(y) || y < 1) return null;
  if (granularity === GRANULARITY.QUARTERLY) {
    const q = quarterOf(month1to12);
    if (!Number.isFinite(q)) return null;
    return y + "-Q" + q;
  }
  return String(y);
}

/**
 * Total-orderable key for sorting/comparing period keys across granularities.
 * Both yearly "2024" and quarterly "2024-Q3" map onto the same number line
 * (units = quarters) so we can compare them directly when mixing series.
 */
function periodSortKey(periodKey) {
  if (typeof periodKey !== "string" || !periodKey) return NaN;
  const m = periodKey.match(/^(\d{4})(?:-Q([1-4]))?$/);
  if (!m) return NaN;
  const y = parseInt(m[1], 10);
  const q = m[2] ? parseInt(m[2], 10) : 1;
  return y * 4 + (q - 1);
}

function comparePeriodKeys(a, b) {
  const ka = periodSortKey(a);
  const kb = periodSortKey(b);
  if (ka === kb) return 0;
  return ka < kb ? -1 : 1;
}

/**
 * Build an ordered list of every period key between startKey and endKey
 * (both inclusive) at the requested granularity. Used to lay out the x-axis.
 *
 * If start > end, returns an empty array.
 */
function expandPeriodRange(startKey, endKey, granularity) {
  const out = [];
  const sm = parsePeriodKey(startKey);
  const em = parsePeriodKey(endKey);
  if (!sm || !em) return out;
  if (granularity === GRANULARITY.QUARTERLY) {
    let y = sm.year;
    let q = sm.quarter;
    const endRank = em.year * 4 + (em.quarter - 1);
    while (y * 4 + (q - 1) <= endRank) {
      out.push(y + "-Q" + q);
      q += 1;
      if (q > 4) { q = 1; y += 1; }
    }
  } else {
    for (let y = sm.year; y <= em.year; y++) out.push(String(y));
  }
  return out;
}

function parsePeriodKey(periodKey) {
  if (typeof periodKey !== "string" || !periodKey) return null;
  const m = periodKey.match(/^(\d{4})(?:-Q([1-4]))?$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), quarter: m[2] ? parseInt(m[2], 10) : 1 };
}

/**
 * Bucket a row stream into { [periodKey]: { spend, qty } }.
 *
 * Row shape: { year, month, spend, qty }.
 *   year  — integer YYYY
 *   month — integer 1..12 (1 = January)
 *   spend — number (any currency unit, must be consistent across rows)
 *   qty   — number (units; must be > 0 for the row to count)
 *
 * Rows with qty <= 0, non-finite qty/spend, or unparseable period are skipped.
 *
 * Partial-period rule (locked in by tests): we emit a bucket as long as ≥ 1
 * row lands in it with qty > 0. We do NOT require a minimum number of rows
 * or a minimum number of distinct months within a quarter. This matches the
 * Excel `AVERAGEIFS` behavior, which averages whatever rows fall in the
 * date window.
 */
function bucketRowsByPeriod(rows, granularity) {
  const buckets = Object.create(null);
  if (!Array.isArray(rows)) return buckets;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const qty = +r.qty;
    const spend = +r.spend;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(spend)) continue;
    const key = periodKeyOf(r.year, r.month, granularity);
    if (key == null) continue;
    let b = buckets[key];
    if (!b) { b = { spend: 0, qty: 0 }; buckets[key] = b; }
    b.spend += spend;
    b.qty += qty;
  }
  return buckets;
}

/**
 * Weighted-average unit price per period: Σspend / Σqty.
 *
 * This is the SAME formula as the Excel reference, just expressed at the
 * aggregate. Excel's AVERAGEIFS over a unit-price column gives a simple
 * average; AVERAGEIFS(spend) / AVERAGEIFS(qty) gives the weighted average.
 * The dashboard intent is the latter (volume-weighted), so we sum spend
 * and qty first, then divide once.
 */
function weightedUnitPriceByPeriod(buckets) {
  const out = Object.create(null);
  for (const k of Object.keys(buckets)) {
    const b = buckets[k];
    if (b.qty > 0 && Number.isFinite(b.spend)) out[k] = b.spend / b.qty;
  }
  return out;
}

/**
 * Rebase a {period: rawValue} map so that rawByPeriod[baselineKey] = 100.
 *
 * IMPORTANT — baseline is computed from the FULL input map, regardless of
 * any chart display window. Requirement #3: narrowing the chart must NOT
 * change the baseline. Callers must therefore feed the unfiltered raw map
 * here, and only apply the display-window filter at render time.
 *
 * Returns:
 *   { ok: true,  indexed: { period: number }, baselineRaw: number, baselineKey }
 *   { ok: false, indexed: {},                 baselineRaw: NaN,    baselineKey }
 *
 * `ok = false` when the baseline period has no data (or zero/negative
 * weighted price). The caller should suppress that series from the chart
 * with a "needs a valid baseline" message.
 */
function rebaseToBaseline(rawByPeriod, baselineKey) {
  if (!rawByPeriod || typeof rawByPeriod !== "object") {
    return { ok: false, indexed: {}, baselineRaw: NaN, baselineKey: baselineKey };
  }
  const baseline = +rawByPeriod[baselineKey];
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return { ok: false, indexed: {}, baselineRaw: NaN, baselineKey: baselineKey };
  }
  const indexed = Object.create(null);
  for (const k of Object.keys(rawByPeriod)) {
    const v = +rawByPeriod[k];
    if (Number.isFinite(v) && v > 0) indexed[k] = (v / baseline) * 100;
  }
  return { ok: true, indexed: indexed, baselineRaw: baseline, baselineKey: baselineKey };
}

/**
 * Convenience pipeline: rows → bucketed → weighted → rebased.
 *
 * Equivalent to: rebaseToBaseline(weightedUnitPriceByPeriod(
 *                  bucketRowsByPeriod(rows, granularity)), baselineKey).
 */
function computePartIndex(rows, granularity, baselineKey) {
  return rebaseToBaseline(
    weightedUnitPriceByPeriod(bucketRowsByPeriod(rows, granularity)),
    baselineKey
  );
}

/**
 * Replicate a yearly-indexed series (e.g. PPI) across each year's 4 quarters
 * for display in Quarterly mode. The underlying PPI raw data is only
 * published yearly, so we render a flat step (Q1..Q4 of year Y all share
 * the yearly Y value). The chart legend documents this.
 */
function expandYearlyToQuarterly(indexedByYear) {
  const out = Object.create(null);
  if (!indexedByYear || typeof indexedByYear !== "object") return out;
  for (const yk of Object.keys(indexedByYear)) {
    const y = parseInt(yk, 10);
    if (!Number.isFinite(y)) continue;
    const v = +indexedByYear[yk];
    if (!Number.isFinite(v)) continue;
    for (let q = 1; q <= 4; q++) out[y + "-Q" + q] = v;
  }
  return out;
}

/**
 * Inclusive display-window check for the chart x-axis.
 * Used at render time only — never during baseline computation.
 */
function isInDisplayWindow(periodKey, startKeyOrNull, endKeyOrNull) {
  const k = periodSortKey(periodKey);
  if (!Number.isFinite(k)) return false;
  if (startKeyOrNull != null) {
    const s = periodSortKey(startKeyOrNull);
    if (Number.isFinite(s) && k < s) return false;
  }
  if (endKeyOrNull != null) {
    const e = periodSortKey(endKeyOrNull);
    if (Number.isFinite(e) && k > e) return false;
  }
  return true;
}

/**
 * Half-open range check: includes start, excludes end. Provided as a
 * standalone helper so tests can pin down the >=start AND <end_exclusive
 * semantics that match Excel's `DATE(2024,4,1)` exclusive-upper-bound
 * pattern. The dashboard does its bucketing via quarterOf(month) which
 * is half-open by construction; this helper exists so we can assert on
 * the rule directly in unit tests rather than only via its consequence.
 */
function isInHalfOpenRange(periodKey, startKeyOrNull, endKeyExclusiveOrNull) {
  const k = periodSortKey(periodKey);
  if (!Number.isFinite(k)) return false;
  if (startKeyOrNull != null) {
    const s = periodSortKey(startKeyOrNull);
    if (Number.isFinite(s) && k < s) return false;
  }
  if (endKeyExclusiveOrNull != null) {
    const e = periodSortKey(endKeyExclusiveOrNull);
    if (Number.isFinite(e) && k >= e) return false;
  }
  return true;
}

export {
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
};
