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
 * Build the 2-row detail breakdown for one part vs. the chosen low/high
 * index targets — feeds the per-part drill-down on the Index Opportunity
 * tab (chart lines + the 2-row table below it).
 *
 * Returns rows in chronological order [2024, 2025]. Each row has:
 *   { year, qty, price, spend, lowBenchmark, highBenchmark,
 *     savingsVsLow, savingsVsHigh }
 *
 * Rule of the row layout (locked in by tests):
 *   - 2024 is the baseline year. Benchmarks equal the actual unit price
 *     for that row, and both savings columns are exactly 0. This keeps
 *     the visual story consistent with "the index curves anchor at
 *     2024 = actual price, then diverge in 2025".
 *   - 2025 benchmarks are the 2024 actual price grown by the target
 *     growth % (low and high). Savings = current spend − qty × benchmark.
 *     A negative number means the part outperformed the benchmark
 *     (no opportunity — but we return the raw number rather than
 *     flooring at 0 so the table can show the sign honestly).
 *
 * Returns null when the part is missing usable prices for either year
 * or the target growths are non-finite — caller should fall back to a
 * "no chart available" message.
 *
 * The part object's contract matches what idpIoBuildPartCache puts in
 * _idpIoPartCache.parts: { priceLow, priceHigh, qtyLow, qtyHigh,
 * spendLow, spendHigh }.
 */
function partDrilldownRows(part, lowTargetPct, highTargetPct) {
  if (!part) return null;
  const p24 = +part.priceLow;
  const p25 = +part.priceHigh;
  if (!Number.isFinite(p24) || p24 <= 0) return null;
  if (!Number.isFinite(p25) || p25 <= 0) return null;
  const lowT = +lowTargetPct;
  const highT = +highTargetPct;
  if (!Number.isFinite(lowT) || !Number.isFinite(highT)) return null;
  const q24 = Number.isFinite(+part.qtyLow) ? +part.qtyLow : 0;
  const q25 = Number.isFinite(+part.qtyHigh) ? +part.qtyHigh : 0;
  const s24 = Number.isFinite(+part.spendLow) ? +part.spendLow : 0;
  const s25 = Number.isFinite(+part.spendHigh) ? +part.spendHigh : 0;
  const benchLow25 = p24 * (1 + lowT / 100);
  const benchHigh25 = p24 * (1 + highT / 100);
  return [
    {
      year: 2024,
      qty: q24,
      price: p24,
      spend: s24,
      lowBenchmark: p24,
      highBenchmark: p24,
      savingsVsLow: 0,
      savingsVsHigh: 0
    },
    {
      year: 2025,
      qty: q25,
      price: p25,
      spend: s25,
      lowBenchmark: benchLow25,
      highBenchmark: benchHigh25,
      savingsVsLow: s25 - q25 * benchLow25,
      savingsVsHigh: s25 - q25 * benchHigh25
    }
  ];
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
/**
 * Hard outlier thresholds applied to the Index Opportunity dataset.
 * Co-located here (rather than in the consumer) so the unit-test suite
 * and the live runtime are guaranteed to use the same cutoffs.
 *
 *   minSpendLow  — Drop parts whose 2024 spend is below this floor.
 *                  Below ~$1 the weighted-avg unit price is dominated
 *                  by rounding error and growth % explodes (the user
 *                  reported +845% / +344% rows that all traced back
 *                  to sub-dollar 2024 spends).
 *   maxGrowthPct — Drop parts whose YoY growth exceeds this many
 *                  percent. Above 500% the math is virtually always a
 *                  data-quality artifact (zero-cost line, decimal-
 *                  point error, unit mismatch), not a real inflation
 *                  opportunity. Trimming at 500% removes the long
 *                  tail without nicking real high-growth parts —
 *                  legitimate top-of-distribution opportunities sit
 *                  comfortably under 200%.
 *
 * Used by isOutlierPart() and INDEX_METHODOLOGY.md §13c references
 * these exact values.
 */
const IO_OUTLIER_DEFAULTS = Object.freeze({
  minSpendLow: 1,
  maxGrowthPct: 500
});

/**
 * Return true if `part` should be excluded from Index Opportunity
 * results because its data is suspect.
 *
 * Operates on an enriched IO part record (the kind produced by
 * idpIoBuildPartCache in index.html), specifically:
 *   - part.spendLow   — 2024 total spend in the part+site bucket
 *   - part.growthPct  — 2024→2025 unit-price growth percent (NOT a
 *                       ratio — 250% means 250, not 2.5)
 *
 * Returns false for null/non-finite inputs (callers should already
 * have dropped those upstream, but defensiveness costs us nothing).
 *
 * `thresholds` defaults to IO_OUTLIER_DEFAULTS but can be overridden
 * for tests or future tuning. Pass { minSpendLow: 0, maxGrowthPct:
 * Infinity } to disable both rules.
 */
function isOutlierPart(part, thresholds) {
  if (!part) return false;
  const t = thresholds || IO_OUTLIER_DEFAULTS;
  /* Accept finite numbers OR ±Infinity as legitimate threshold inputs.
   * +Infinity = "no upper bound" (lets every growth value through);
   * any other non-number / NaN falls back to the documented default. */
  const minSpend = (typeof t.minSpendLow === "number" && !Number.isNaN(t.minSpendLow))
    ? t.minSpendLow : IO_OUTLIER_DEFAULTS.minSpendLow;
  const maxG = (typeof t.maxGrowthPct === "number" && !Number.isNaN(t.maxGrowthPct))
    ? t.maxGrowthPct : IO_OUTLIER_DEFAULTS.maxGrowthPct;
  const sp = +part.spendLow;
  const g = +part.growthPct;
  /* Spend rule: finite numbers below the floor are outliers. NaN
   * inputs defer to the upstream "valid growth" filter. */
  if (Number.isFinite(sp) && sp < minSpend) return true;
  /* Growth rule: explicit +Infinity is always an outlier (caller can
   * opt out by passing maxGrowthPct = +Infinity, which is handled in
   * the comparison — Infinity > Infinity is false). */
  if (g === Infinity) return true;
  if (Number.isFinite(g) && g > maxG) return true;
  return false;
}

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

/* ===========================================================================
 * Fuzzy item-name clustering (used by the Indirect Harmonization tab).
 *
 * The standard Harmonization tab keys on Part Number first, then falls back
 * to an exact-string match on Part Description / Material when Part Number is
 * blank. For L1 Indirect rows that blank-part case is the majority — and
 * "Office Paper A4 White" vs "office paper - A4 - white" being treated as two
 * separate items is exactly the kind of false fragmentation we want to merge
 * before the harmonization math runs.
 *
 * This module exposes three pure helpers that the Indirect Harmonization tab
 * glues into the existing harmonization-client.js pipeline by pre-rewriting
 * each blank-part row's `part` field to a stable synthetic cluster key.
 *
 * Threshold default is 0.80 token-set Jaccard, chosen on:
 *   - 0.6-0.7: noisy; merges "Steel Pipe 1in" with "Plastic Pipe 2in".
 *   - 0.8: sweet spot — catches case/punct/word-order/typo-of-one-token
 *     variations but doesn't cross size/material/colour boundaries.
 *   - 0.9: too tight — misses "office paper A4" vs "office paper a4 white".
 *
 * See INDIRECT_HARMONIZATION_METHODOLOGY.md for the rationale.
 * =========================================================================== */

const FUZZY_NAME_DEFAULTS = Object.freeze({
  /* Drop these as pure noise/stopwords (no informational value for grouping). */
  stopTokens: Object.freeze(new Set([
    "of","the","and","for","with","to","in","on","by","or","a","an"
  ])),
  /* Tokens shorter than this are dropped (after stopword removal) so single
   * letters like "x" / "a" / leftover punctuation slivers don't dominate the
   * similarity score. Two-char alphanumeric tokens (e.g., "a4", "30") are
   * kept — they often carry size / spec meaning. */
  minTokenLen: 2,
  /* Jaccard similarity threshold for merging two normalized item names. */
  threshold: 0.80,
  /* Hard cap on input size for fuzzy clustering. Above this we degrade to
   * exact-normalized-match only (no pairwise comparisons), to avoid pinning
   * the browser. Indirect slices typically sit well under this. */
  maxItems: 25000
});

/* Convert a raw item name to a normalized token set.
 *
 * Returns { norm, tokens } where:
 *   - norm   = a single lowercase whitespace-collapsed string (used for
 *              exact-match grouping pre-pass and as a stable display form);
 *   - tokens = a Set<string> of meaningful tokens (used for Jaccard).
 *
 * Pure & deterministic — same input always yields the same output. */
function normalizeNameForFuzzy(raw, options) {
  const opts = options || FUZZY_NAME_DEFAULTS;
  if (raw == null) return { norm: "", tokens: new Set() };
  let s = String(raw).toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  const parts = s.split(/\s+/).filter(Boolean);
  const stops = opts.stopTokens || FUZZY_NAME_DEFAULTS.stopTokens;
  const minLen = opts.minTokenLen != null ? opts.minTokenLen : FUZZY_NAME_DEFAULTS.minTokenLen;
  const kept = [];
  const seen = new Set();
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i];
    if (!t) continue;
    if (stops.has(t)) continue;
    if (t.length < minLen) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    kept.push(t);
  }
  kept.sort();
  return { norm: kept.join(" "), tokens: new Set(kept) };
}

/* Jaccard similarity between two token Sets: |A ∩ B| / |A ∪ B|.
 * Returns 0 for empty inputs (avoid 0/0 NaN propagation). */
function tokenJaccard(a, b) {
  if (!a || !b) return 0;
  const sa = a.size != null ? a.size : 0;
  const sb = b.size != null ? b.size : 0;
  if (sa === 0 || sb === 0) return 0;
  let inter = 0;
  const small = sa <= sb ? a : b;
  const large = sa <= sb ? b : a;
  for (const t of small) if (large.has(t)) inter++;
  if (inter === 0) return 0;
  const union = sa + sb - inter;
  return union > 0 ? inter / union : 0;
}

/* Tiny Union-Find with path compression + union-by-rank.
 * Internal helper for fuzzyClusterNames. */
function _ufMake(n) {
  const parent = new Array(n);
  const rank = new Array(n);
  for (let i = 0; i < n; i++) { parent[i] = i; rank[i] = 0; }
  return { parent, rank };
}
function _ufFind(uf, x) {
  while (uf.parent[x] !== x) {
    uf.parent[x] = uf.parent[uf.parent[x]];
    x = uf.parent[x];
  }
  return x;
}
function _ufUnion(uf, x, y) {
  const rx = _ufFind(uf, x), ry = _ufFind(uf, y);
  if (rx === ry) return;
  if (uf.rank[rx] < uf.rank[ry]) uf.parent[rx] = ry;
  else if (uf.rank[rx] > uf.rank[ry]) uf.parent[ry] = rx;
  else { uf.parent[ry] = rx; uf.rank[rx]++; }
}

/* Cluster a list of item names by fuzzy token-set similarity.
 *
 * Inputs:
 *   items   — Array<{ id: any, name: string, block?: string }>
 *             `block` is an optional grouping key (typically L3 category)
 *             used to prune pairwise comparisons — only items sharing the
 *             same block are ever compared. Items with no block share the
 *             "__nb__" pool. Blocking is what makes this scale to tens of
 *             thousands of items without an O(N²) explosion.
 *   options — { threshold, minTokenLen, stopTokens, maxItems } overrides.
 *
 * Output:
 *   {
 *     clusterIdByItemIdx: Array<number>  // cluster id per input index
 *     clusters: Array<{ id, members: number[], rep: string, displayName: string }>
 *     diagnostics: { totalItems, totalClusters, mergedItems, blocksProcessed,
 *                    droppedEmpty, droppedOverCap }
 *   }
 *
 * Algorithm:
 *   1. Normalize every name to a token set + canonical "norm" string.
 *   2. Pre-pass: items with identical `norm` AND same block are unioned
 *      directly (no Jaccard needed — they're already proven equivalent).
 *   3. Per-block, build an inverted index token -> [item indexes].
 *      For each item, candidate set = union over all its tokens' postings.
 *      For each unprocessed candidate pair, compute Jaccard and union if
 *      >= threshold. Each pair is compared at most once.
 *   4. Within each cluster, pick a representative: the most-frequent norm
 *      (ties broken by shortest, then lexicographically smallest). The
 *      displayName is the first raw `name` whose norm matches the rep.
 *
 * Pure & deterministic given a stable input order. */
function fuzzyClusterNames(items, options) {
  const opts = Object.assign({}, FUZZY_NAME_DEFAULTS, options || {});
  const N = items && items.length ? items.length : 0;
  const diagnostics = {
    totalItems: N, totalClusters: 0, mergedItems: 0,
    blocksProcessed: 0, droppedEmpty: 0, droppedOverCap: 0
  };
  if (N === 0) {
    return { clusterIdByItemIdx: [], clusters: [], diagnostics };
  }
  /* Normalize every input. Items that normalize to an empty token set are
   * dropped from clustering (assigned -1) — they have no signal to merge on. */
  const norms = new Array(N);
  const tokens = new Array(N);
  const blockOf = new Array(N);
  const blocks = Object.create(null);
  for (let i = 0; i < N; i++) {
    const it = items[i] || {};
    const { norm, tokens: tk } = normalizeNameForFuzzy(it.name, opts);
    norms[i] = norm;
    tokens[i] = tk;
    const blk = it.block != null && it.block !== "" ? String(it.block) : "__nb__";
    blockOf[i] = blk;
    if (tk.size === 0) { diagnostics.droppedEmpty++; continue; }
    if (!blocks[blk]) blocks[blk] = [];
    blocks[blk].push(i);
  }
  const overCap = N > opts.maxItems;
  if (overCap) diagnostics.droppedOverCap = N;
  const uf = _ufMake(N);
  /* Step 2: identical-norm pre-pass within each block. */
  for (const blk in blocks) {
    const idxs = blocks[blk];
    const seenNorm = Object.create(null);
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      const key = norms[i];
      if (!key) continue;
      if (seenNorm[key] != null) {
        _ufUnion(uf, seenNorm[key], i);
        diagnostics.mergedItems++;
      } else {
        seenNorm[key] = i;
      }
    }
  }
  /* Step 3: per-block Jaccard via inverted-index candidate generation.
   * Skip entirely if we're over the safety cap — degrade to exact-norm only. */
  if (!overCap) {
    for (const blk in blocks) {
      diagnostics.blocksProcessed++;
      const idxs = blocks[blk];
      const m = idxs.length;
      if (m < 2) continue;
      const postings = Object.create(null);
      for (let k = 0; k < m; k++) {
        const i = idxs[k];
        for (const t of tokens[i]) {
          if (!postings[t]) postings[t] = [];
          postings[t].push(i);
        }
      }
      const compared = new Set();
      for (let k = 0; k < m; k++) {
        const i = idxs[k];
        const cands = new Set();
        for (const t of tokens[i]) {
          const lst = postings[t];
          if (!lst) continue;
          for (let z = 0; z < lst.length; z++) {
            const j = lst[z];
            if (j !== i) cands.add(j);
          }
        }
        for (const j of cands) {
          if (j <= i) continue;
          const pairKey = i * N + j;
          if (compared.has(pairKey)) continue;
          compared.add(pairKey);
          if (_ufFind(uf, i) === _ufFind(uf, j)) continue;
          const sim = tokenJaccard(tokens[i], tokens[j]);
          if (sim >= opts.threshold) {
            _ufUnion(uf, i, j);
            diagnostics.mergedItems++;
          }
        }
      }
    }
  }
  /* Step 4: collect clusters by root and pick representatives. */
  const clusterIdByItemIdx = new Array(N);
  const rootToCluster = Object.create(null);
  const clusters = [];
  for (let i = 0; i < N; i++) {
    if (tokens[i].size === 0) { clusterIdByItemIdx[i] = -1; continue; }
    const r = _ufFind(uf, i);
    let cid = rootToCluster[r];
    if (cid == null) {
      cid = clusters.length;
      rootToCluster[r] = cid;
      clusters.push({ id: cid, members: [], rep: "", displayName: "" });
    }
    clusterIdByItemIdx[i] = cid;
    clusters[cid].members.push(i);
  }
  for (let c = 0; c < clusters.length; c++) {
    const mem = clusters[c].members;
    const counts = Object.create(null);
    for (let k = 0; k < mem.length; k++) {
      const nm = norms[mem[k]];
      counts[nm] = (counts[nm] || 0) + 1;
    }
    let bestNorm = "";
    let bestCount = -1;
    for (const nm in counts) {
      const cnt = counts[nm];
      if (cnt > bestCount ||
         (cnt === bestCount && (nm.length < bestNorm.length ||
            (nm.length === bestNorm.length && nm < bestNorm)))) {
        bestNorm = nm;
        bestCount = cnt;
      }
    }
    clusters[c].rep = bestNorm;
    /* Pick the first raw name in the cluster whose norm matches the rep
     * — preserves a human-readable display name (with capitalization etc.). */
    for (let k = 0; k < mem.length; k++) {
      if (norms[mem[k]] === bestNorm) {
        const it = items[mem[k]];
        clusters[c].displayName = it && it.name != null ? String(it.name) : bestNorm;
        break;
      }
    }
    if (!clusters[c].displayName) clusters[c].displayName = bestNorm;
  }
  diagnostics.totalClusters = clusters.length;
  return { clusterIdByItemIdx, clusters, diagnostics };
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
  partDrilldownRows,
  IO_OUTLIER_DEFAULTS,
  isOutlierPart,
  archetypeSummary,
  FUZZY_NAME_DEFAULTS,
  normalizeNameForFuzzy,
  tokenJaccard,
  fuzzyClusterNames
};
