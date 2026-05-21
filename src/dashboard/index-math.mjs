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
 * How a bucket's "average unit price" is computed from its rows.
 *
 *   QTY    — Σspend / Σqty                       (volume-weighted; default; matches Excel `AVERAGEIFS(spend)/AVERAGEIFS(qty)`)
 *   SPEND  — Σ(unit_price × spend) / Σspend      (spend-weighted unit price)
 *   SIMPLE — mean(unit_price) over rows           (unweighted simple average)
 *
 * SIMPLE is the metric most Excel users get *by accident* with
 * `AVERAGEIFS(unit_price_column, …)` and it almost never matches QTY when
 * quantities are unequal. The picker exists so we can prove parity / surface
 * which method an external Excel reference is actually using.
 */
const WEIGHTING = Object.freeze({ QTY: "qty", SPEND: "spend", SIMPLE: "simple" });

/**
 * How per-part indexes are combined into a single category line.
 *
 *   LASPEYRES — Σ(part_index(period) × part_base_spend) / Σ part_base_spend
 *               Spend-weighted, fixed-basket. Default. Weights are computed
 *               once from the BASELINE period and held constant — that's what
 *               makes it Laspeyres (vs. Paasche, which uses current weights).
 *   SIMPLE    — arithmetic mean of per-part indexes per period.
 *   POOLED    — pool all selected parts' rows into one mega-bucket per period
 *               (Σspend across parts / Σqty across parts), then index against
 *               the same pooled bucket at the baseline. Differs from LASPEYRES
 *               whenever the mix of parts shifts across periods.
 *
 * These three produce mathematically different numbers; the chart subtitle
 * and methodology doc surface which one is active.
 */
const AGGREGATION = Object.freeze({ LASPEYRES: "laspeyres", SIMPLE: "simple", POOLED: "pooled" });

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
 * Bucket a row stream into { [periodKey]: { spend, qty, sumPrice, sumPriceSpend, rowCount } }.
 *
 * Row shape: { year, month, spend, qty }.
 *   year  — integer YYYY
 *   month — integer 1..12 (1 = January)
 *   spend — number (any currency unit, must be consistent across rows)
 *   qty   — number (units; must be > 0 for the row to count)
 *
 * Rows with qty <= 0, non-finite qty/spend, or unparseable period are skipped.
 *
 * We accumulate ALL the aggregates needed for every supported WEIGHTING method
 * up front so callers don't have to re-bucket when toggling weighting:
 *   - spend, qty           → QTY-weighted unit price (Σspend/Σqty)
 *   - sumPriceSpend, spend → SPEND-weighted unit price (Σ(price·spend)/Σspend)
 *   - sumPrice, rowCount   → SIMPLE mean of per-row unit prices
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
    if (!b) {
      b = { spend: 0, qty: 0, sumPrice: 0, sumPriceSpend: 0, rowCount: 0 };
      buckets[key] = b;
    }
    b.spend += spend;
    b.qty += qty;
    const price = spend / qty;
    b.sumPrice += price;
    b.sumPriceSpend += price * spend;
    b.rowCount += 1;
  }
  return buckets;
}

/**
 * Period-level "average unit price" under the chosen weighting method.
 *
 * Defaults to QTY (volume-weighted) — the only method that matches Excel's
 * `AVERAGEIFS(spend, …)/AVERAGEIFS(qty, …)` pattern. Other methods are
 * exposed so the validation panel can prove which method an external Excel
 * reference is *actually* using when the QTY parity check fails.
 */
function weightedUnitPriceByPeriod(buckets, weightingMethod) {
  const method = weightingMethod || WEIGHTING.QTY;
  const out = Object.create(null);
  if (!buckets) return out;
  for (const k of Object.keys(buckets)) {
    const b = buckets[k];
    if (!b) continue;
    if (method === WEIGHTING.SPEND) {
      if (b.spend > 0 && Number.isFinite(b.sumPriceSpend)) out[k] = b.sumPriceSpend / b.spend;
    } else if (method === WEIGHTING.SIMPLE) {
      if (b.rowCount > 0 && Number.isFinite(b.sumPrice)) out[k] = b.sumPrice / b.rowCount;
    } else {
      if (b.qty > 0 && Number.isFinite(b.spend)) out[k] = b.spend / b.qty;
    }
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
 *                  bucketRowsByPeriod(rows, granularity), weighting), baselineKey).
 *
 * `weightingMethod` is optional; defaults to QTY.
 */
function computePartIndex(rows, granularity, baselineKey, weightingMethod) {
  return rebaseToBaseline(
    weightedUnitPriceByPeriod(bucketRowsByPeriod(rows, granularity), weightingMethod),
    baselineKey
  );
}

/* ============================================================================
 * AGGREGATION across multiple parts → one category-level index line.
 * The three methods can produce materially different numbers; the chart
 * subtitle surfaces which one is active and the methodology doc documents
 * the formulas. See AGGREGATION constant above.
 * ============================================================================ */

/**
 * Spend-weighted Laspeyres aggregator (default).
 *
 *   agg_index(period) = Σ_part [ part_index(part, period) × baseSpend(part) ] / Σ_part baseSpend(part)
 *
 * Weights are computed ONCE from the baseline period and held constant for
 * every other period. Parts with no baseline data contribute weight 0 and
 * are therefore silently dropped — the per-part "excluded" report should
 * surface them separately so the user knows why coverage is < 100%.
 *
 * Inputs:
 *   perPartIndexed     — { [partKey]: { ok, indexed: { [period]: number } } }
 *   perPartBuckets     — { [partKey]: { [period]: { spend, qty, … } } }  ← bucketed under the active granularity
 *   baselineKey        — period key whose spend defines the weights
 *
 * Returns:
 *   { ok, indexed: { [period]: number }, totalBaseSpend, contributingParts }
 */
function aggregateLaspeyres(perPartIndexed, perPartBuckets, baselineKey) {
  const indexed = Object.create(null);
  const contributing = [];
  let totalW = 0;
  if (!perPartIndexed || !perPartBuckets) return { ok: false, indexed, totalBaseSpend: 0, contributingParts: [] };
  const partKeys = Object.keys(perPartIndexed);
  const weights = Object.create(null);
  for (let i = 0; i < partKeys.length; i++) {
    const pk = partKeys[i];
    const r = perPartIndexed[pk];
    if (!r || !r.ok) continue;
    const baseBucket = perPartBuckets[pk] ? perPartBuckets[pk][baselineKey] : null;
    const w = baseBucket && Number.isFinite(baseBucket.spend) && baseBucket.spend > 0 ? baseBucket.spend : 0;
    if (w <= 0) continue;
    weights[pk] = w;
    totalW += w;
    contributing.push(pk);
  }
  if (totalW <= 0) return { ok: false, indexed, totalBaseSpend: 0, contributingParts: [] };
  const sums = Object.create(null);
  for (let i = 0; i < contributing.length; i++) {
    const pk = contributing[i];
    const w = weights[pk];
    const ind = perPartIndexed[pk].indexed || {};
    for (const period of Object.keys(ind)) {
      const v = +ind[period];
      if (!Number.isFinite(v)) continue;
      let s = sums[period];
      if (!s) { s = { num: 0, den: 0 }; sums[period] = s; }
      s.num += v * w;
      s.den += w;
    }
  }
  for (const period of Object.keys(sums)) {
    const s = sums[period];
    if (s.den > 0) indexed[period] = s.num / s.den;
  }
  return { ok: true, indexed, totalBaseSpend: totalW, contributingParts: contributing };
}

/**
 * Simple-mean aggregator: arithmetic mean of per-part indexes per period.
 * Equal weight to every contributing part — heavily distorted by tiny parts.
 */
function aggregateSimpleMean(perPartIndexed) {
  const indexed = Object.create(null);
  const contributing = [];
  if (!perPartIndexed) return { ok: false, indexed, totalBaseSpend: 0, contributingParts: [] };
  const partKeys = Object.keys(perPartIndexed);
  const sums = Object.create(null);
  for (let i = 0; i < partKeys.length; i++) {
    const pk = partKeys[i];
    const r = perPartIndexed[pk];
    if (!r || !r.ok) continue;
    contributing.push(pk);
    const ind = r.indexed || {};
    for (const period of Object.keys(ind)) {
      const v = +ind[period];
      if (!Number.isFinite(v)) continue;
      let s = sums[period];
      if (!s) { s = { num: 0, n: 0 }; sums[period] = s; }
      s.num += v;
      s.n += 1;
    }
  }
  if (!contributing.length) return { ok: false, indexed, totalBaseSpend: 0, contributingParts: [] };
  for (const period of Object.keys(sums)) {
    const s = sums[period];
    if (s.n > 0) indexed[period] = s.num / s.n;
  }
  return { ok: true, indexed, totalBaseSpend: 0, contributingParts: contributing };
}

/**
 * Pooled-reweighted aggregator: sum spend & qty across ALL parts per period,
 * then index against the same pooled bucket at the baseline. This is
 * equivalent to "treat the basket as one big part" — the index moves with
 * both price and mix.
 *
 *   pooled_price(period) = Σ_part spend(part, period) / Σ_part qty(part, period)
 *   agg_index(period)    = pooled_price(period) / pooled_price(baseline) × 100
 */
function aggregatePooledReweighted(perPartBuckets, baselineKey, weightingMethod) {
  const indexed = Object.create(null);
  const contributing = [];
  if (!perPartBuckets) return { ok: false, indexed, totalBaseSpend: 0, contributingParts: [] };
  const pooled = Object.create(null);
  const partKeys = Object.keys(perPartBuckets);
  for (let i = 0; i < partKeys.length; i++) {
    const pk = partKeys[i];
    const buckets = perPartBuckets[pk];
    if (!buckets) continue;
    let partContributed = false;
    for (const period of Object.keys(buckets)) {
      const b = buckets[period];
      if (!b) continue;
      let p = pooled[period];
      if (!p) {
        p = { spend: 0, qty: 0, sumPrice: 0, sumPriceSpend: 0, rowCount: 0 };
        pooled[period] = p;
      }
      p.spend += +b.spend || 0;
      p.qty += +b.qty || 0;
      p.sumPrice += +b.sumPrice || 0;
      p.sumPriceSpend += +b.sumPriceSpend || 0;
      p.rowCount += +b.rowCount || 0;
      partContributed = true;
    }
    if (partContributed) contributing.push(pk);
  }
  const rebased = rebaseToBaseline(weightedUnitPriceByPeriod(pooled, weightingMethod), baselineKey);
  if (!rebased.ok) return { ok: false, indexed, totalBaseSpend: 0, contributingParts: contributing };
  const baseSpend = pooled[baselineKey] && Number.isFinite(pooled[baselineKey].spend) ? pooled[baselineKey].spend : 0;
  return { ok: true, indexed: rebased.indexed, totalBaseSpend: baseSpend, contributingParts: contributing };
}

/**
 * Single entry point for "give me the category line".
 *
 * Inputs:
 *   perPartBuckets   — { [partKey]: bucketsByPeriod }
 *   perPartIndexed   — { [partKey]: { ok, indexed } } (already rebased to baselineKey)
 *   baselineKey      — period key the per-part series are anchored to
 *   aggregationMethod — AGGREGATION value
 *   weightingMethod  — only used by POOLED (Laspeyres/Simple operate on already-indexed values)
 */
function aggregatePartIndexes(perPartBuckets, perPartIndexed, baselineKey, aggregationMethod, weightingMethod) {
  const m = aggregationMethod || AGGREGATION.LASPEYRES;
  if (m === AGGREGATION.SIMPLE) return aggregateSimpleMean(perPartIndexed);
  if (m === AGGREGATION.POOLED) return aggregatePooledReweighted(perPartBuckets, baselineKey, weightingMethod);
  return aggregateLaspeyres(perPartIndexed, perPartBuckets, baselineKey);
}

/* ============================================================================
 * COVERAGE & SUMMARY HELPERS — feed the detail table.
 * ============================================================================ */

/**
 * For a set of parts, compute "what fraction of base-period spend is
 * represented by the parts that have a valid baseline index" — i.e. that
 * actually contribute to the aggregate. Surfaces the gap caused by missing-
 * baseline parts.
 *
 * Inputs:
 *   perPartBuckets — { [partKey]: bucketsByPeriod }
 *   perPartIndexed — { [partKey]: { ok, indexed } }
 *   baselineKey    — period whose spend forms the denominator
 *
 * Returns: { totalBaseSpend, includedBaseSpend, coveragePct }
 */
function computeBaselineCoverage(perPartBuckets, perPartIndexed, baselineKey) {
  let total = 0, included = 0;
  if (perPartBuckets) {
    for (const pk of Object.keys(perPartBuckets)) {
      const b = perPartBuckets[pk] ? perPartBuckets[pk][baselineKey] : null;
      const s = b && Number.isFinite(b.spend) ? b.spend : 0;
      if (s > 0) total += s;
    }
  }
  if (perPartIndexed) {
    for (const pk of Object.keys(perPartIndexed)) {
      const r = perPartIndexed[pk];
      if (!r || !r.ok) continue;
      const b = perPartBuckets && perPartBuckets[pk] ? perPartBuckets[pk][baselineKey] : null;
      const s = b && Number.isFinite(b.spend) ? b.spend : 0;
      if (s > 0) included += s;
    }
  }
  return {
    totalBaseSpend: total,
    includedBaseSpend: included,
    coveragePct: total > 0 ? (included / total) * 100 : 0
  };
}

/**
 * Sum spend / qty across parts per period — used by the totals-tile row
 * regardless of which aggregation method is selected for the index line.
 * Returns { [periodKey]: { spend, qty } }.
 */
function sumByPeriodAcrossParts(perPartBuckets) {
  const out = Object.create(null);
  if (!perPartBuckets) return out;
  for (const pk of Object.keys(perPartBuckets)) {
    const buckets = perPartBuckets[pk];
    if (!buckets) continue;
    for (const period of Object.keys(buckets)) {
      const b = buckets[period];
      if (!b) continue;
      let o = out[period];
      if (!o) { o = { spend: 0, qty: 0 }; out[period] = o; }
      o.spend += +b.spend || 0;
      o.qty += +b.qty || 0;
    }
  }
  return out;
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

// ============================================================================
// INDEX OPPORTUNITY math
//
// Pure-function primitives that back the Harmonization → Index Opportunity tab.
//
// What "opportunity" means here:
//   1. Pick any 2 PPI indexes.
//   2. The one with the lower 2024→2025 growth % becomes the LOW target
//      (most aggressive — "your prices should have grown this slowly").
//      The other becomes the HIGH target (conservative — "at minimum,
//      prices should not have outrun the higher index either").
//   3. For each part (deduped by part+site), compute its own 2024→2025
//      weighted-average unit-price growth using the same Σspend/Σqty
//      formula that the IA tab uses for the chart.
//   4. A part "qualifies as an opportunity" iff its growth exceeds the LOW
//      target — i.e. it outran the better of the two PPI references.
//   5. Two $ savings numbers per part:
//        lowSavings  (most aggressive) = spend2025 × max(0, (g − low) /100)
//        highSavings (conservative)    = spend2025 × max(0, (g − high)/100)
//      lowSavings ≥ highSavings by construction. lowSavings is the headline
//      "Total Savings" number shown on the tiles — it's what stakeholders
//      ask for, even though highSavings is the more defensible floor.
//
// All of this is intentionally year-agnostic in the math (every function
// takes explicit yLow / yHigh inputs). The dashboard hardcodes 2024→2025
// per spec, but the tests exercise other year pairs to keep the math honest.
//
// See INDEX_METHODOLOGY.md §13 for the formal definition.
// ============================================================================

/**
 * Weighted-average unit price for one (part+site) bucket and one year.
 * Σspend / Σqty (the IA tab's default volume-weighted formula).
 *
 * Returns NaN when qty <= 0 — never zero, never Infinity, never throws.
 * Caller is expected to skip the row when the result is non-finite.
 */
function weightedUnitPrice(sumSpend, sumQty) {
  const q = +sumQty;
  if (!Number.isFinite(q) || q <= 0) return NaN;
  const s = +sumSpend;
  if (!Number.isFinite(s)) return NaN;
  return s / q;
}

/**
 * Growth between two prices, as a percent (e.g. +7.5).
 * Returns NaN when either price is non-positive or non-finite.
 *
 * Asymmetric on purpose: we don't want a divide-by-zero or a negative-price
 * disaster to silently produce a finite-looking growth number.
 */
function priceGrowthPct(priceLow, priceHigh) {
  const a = +priceLow, b = +priceHigh;
  if (!Number.isFinite(a) || a <= 0) return NaN;
  if (!Number.isFinite(b) || b <= 0) return NaN;
  return (b / a - 1) * 100;
}

/**
 * Year-over-year growth % for a PPI series, given its raw {year: value} map.
 * Returns NaN if either year is missing or the low year value is non-positive.
 *
 * Identical formula to priceGrowthPct above; named separately so the call
 * site reads cleanly ("indexYearGrowthPct(WPU1017.rawByYear, 2024, 2025)").
 */
function indexYearGrowthPct(rawByYear, yLow, yHigh) {
  if (!rawByYear || typeof rawByYear !== "object") return NaN;
  const a = +rawByYear[yLow], b = +rawByYear[yHigh];
  return priceGrowthPct(a, b);
}

/**
 * Assign two indexes into { low, high } based on their 2024→2025 growth %.
 *
 * Input objects must have shape: { code, growthPct, ... }.
 * The one with the SMALLER growth becomes `low` (the most aggressive
 * benchmark — "your part should have grown at most this much"). The one
 * with the LARGER growth becomes `high` (the conservative benchmark).
 *
 * Tie-break: alphabetic by code so the assignment is deterministic and
 * stable across renders.
 *
 * Throws TypeError if either input is missing or has a non-finite growthPct,
 * since the UI is responsible for not calling this with bad inputs.
 */
function assignLowHigh(idxA, idxB) {
  if (!idxA || !idxB) throw new TypeError("assignLowHigh: both indexes required");
  const gA = +idxA.growthPct, gB = +idxB.growthPct;
  if (!Number.isFinite(gA) || !Number.isFinite(gB)) {
    throw new TypeError("assignLowHigh: both indexes need a finite growthPct");
  }
  if (gA < gB) return { low: idxA, high: idxB };
  if (gB < gA) return { low: idxB, high: idxA };
  // Deterministic tie-break: alphabetic by code (so re-renders are stable).
  const cA = String(idxA.code || ""), cB = String(idxB.code || "");
  return cA <= cB ? { low: idxA, high: idxB } : { low: idxB, high: idxA };
}

/**
 * Per-part capture-savings math.
 *
 * Inputs:
 *   part: { growthPct, spendHigh }
 *         growthPct = the part's own 2024→2025 weighted-avg unit-price growth
 *         spendHigh = the part's 2025 spend (used as the base for $ savings)
 *   lowTargetPct, highTargetPct: index targets from assignLowHigh()
 *
 * Returns:
 *   {
 *     qualifies:   boolean — true iff growthPct > lowTargetPct,
 *     lowSavings:  $ — spendHigh × max(0, (growthPct − lowTargetPct)/100),
 *     highSavings: $ — spendHigh × max(0, (growthPct − highTargetPct)/100),
 *   }
 *
 * Both savings numbers are floored at 0 so a part can never contribute a
 * negative savings to a rollup (which would silently cancel real savings).
 * highSavings can be 0 even when qualifies=true (part beat the LOW target
 * but stayed under the HIGH target).
 *
 * If growthPct or spendHigh is non-finite, returns { qualifies: false,
 * lowSavings: 0, highSavings: 0 } — never NaN.
 */
function partCaptureSavings(part, lowTargetPct, highTargetPct) {
  const g = part ? +part.growthPct : NaN;
  const s25 = part ? +part.spendHigh : NaN;
  const lowT = +lowTargetPct, highT = +highTargetPct;
  if (!Number.isFinite(g) || !Number.isFinite(s25) || !Number.isFinite(lowT) || !Number.isFinite(highT)) {
    return { qualifies: false, lowSavings: 0, highSavings: 0 };
  }
  if (s25 <= 0) return { qualifies: false, lowSavings: 0, highSavings: 0 };
  const qualifies = g > lowT;
  if (!qualifies) return { qualifies: false, lowSavings: 0, highSavings: 0 };
  const lowDelta = Math.max(0, g - lowT) / 100;
  const highDelta = Math.max(0, g - highT) / 100;
  return {
    qualifies: true,
    lowSavings: s25 * lowDelta,
    highSavings: s25 * highDelta
  };
}

/**
 * Count of qualifying parts (sorted by lowSavings desc) needed to reach
 * 80% of total lowSavings. Mirrors the "Parts for 80% Value" tile in the
 * existing Harmonization rollup but operates on the IO data shape.
 *
 * Returns 0 for empty/zero-total inputs.
 */
function partsFor80PctValue(qualifyingParts) {
  if (!qualifyingParts || !qualifyingParts.length) return 0;
  const sorted = qualifyingParts
    .map((p) => +p.lowSavings)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => b - a);
  if (!sorted.length) return 0;
  let total = 0;
  for (let i = 0; i < sorted.length; i++) total += sorted[i];
  if (total <= 0) return 0;
  const target = total * 0.8;
  let running = 0;
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i];
    if (running >= target) return i + 1;
  }
  return sorted.length;
}

/**
 * Roll up an array of qualifying parts (each with .spendHigh, .lowSavings,
 * .highSavings) into the 5-tile archetype summary used by the Index
 * Opportunity tab.
 *
 *   n              = count of qualifying parts
 *   totalSavings   = Σ lowSavings   ← headline number (most aggressive)
 *   totalSavingsHigh = Σ highSavings ← conservative shadow (not on tiles,
 *                                      used for the column in the detail
 *                                      table and the Excel export)
 *   totalSpend     = Σ spendHigh   (2025 spend)
 *   avgSavingsPct  = 100 × totalSavings / totalSpend   (spend-weighted; 0 if no spend)
 *   parts80        = partsFor80PctValue(qualifyingParts)
 */
function archetypeSummary(qualifyingParts) {
  let n = 0, totalSavings = 0, totalSavingsHigh = 0, totalSpend = 0;
  if (qualifyingParts && qualifyingParts.length) {
    for (let i = 0; i < qualifyingParts.length; i++) {
      const p = qualifyingParts[i];
      if (!p) continue;
      n += 1;
      const ls = +p.lowSavings, hs = +p.highSavings, sp = +p.spendHigh;
      if (Number.isFinite(ls)) totalSavings += ls;
      if (Number.isFinite(hs)) totalSavingsHigh += hs;
      if (Number.isFinite(sp)) totalSpend += sp;
    }
  }
  const avgSavingsPct = totalSpend > 0 ? (100 * totalSavings) / totalSpend : 0;
  return {
    n,
    totalSavings,
    totalSavingsHigh,
    totalSpend,
    avgSavingsPct,
    parts80: partsFor80PctValue(qualifyingParts || [])
  };
}

export {
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
  computeBaselineCoverage,
  sumByPeriodAcrossParts,
  weightedUnitPrice,
  priceGrowthPct,
  indexYearGrowthPct,
  assignLowHigh,
  partCaptureSavings,
  partsFor80PctValue,
  archetypeSummary
};
