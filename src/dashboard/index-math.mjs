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
 * EXCEL DIFF (Validation panel)
 * ============================================================================ */

/**
 * Parse a pasted block of Excel/CSV text into { [partKey]: { [periodKey]: number } }.
 *
 * Two accepted layouts (we sniff the first non-blank line):
 *
 * (A) Wide / pivot — header row lists period columns:
 *     PartNumber  2024  2025  2026
 *     ABC-001     100   108.2 112.4
 *     XYZ-999     100    99.7 103.1
 *
 * (B) Long — three columns regardless of order: part, period, index value.
 *     We detect "long" when there are exactly 3 columns AND the header (if
 *     any) doesn't look like period codes.
 *
 * Separators auto-detected: tab > comma > 2+ spaces > single space.
 *
 * Period strings normalized:
 *   "2024"           → "2024"
 *   "2024 Q1"        → "2024-Q1"
 *   "2024-Q1"        → "2024-Q1"
 *   "Q1 2024"        → "2024-Q1"
 *   "Q1-24"          → "2024-Q1" (assumes 20YY for 2-digit years)
 *
 * Returns:
 *   { byPart: { partKey: { periodKey: number } }, partOrder: [...], periodOrder: [...], warnings: [...] }
 *
 * Best-effort and forgiving — bad lines are skipped with a warning, never throw.
 */
function parseExcelPivotText(text) {
  const byPart = Object.create(null);
  const partOrder = [];
  const periodSet = Object.create(null);
  const warnings = [];
  if (typeof text !== "string" || !text.trim()) {
    return { byPart, partOrder, periodOrder: [], warnings: ["Empty input."] };
  }
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\uFEFF/, "")).filter((l) => l.trim().length > 0);
  if (!lines.length) return { byPart, partOrder, periodOrder: [], warnings: ["No non-blank lines."] };
  const sepRe = lines[0].indexOf("\t") >= 0 ? /\t/ : lines[0].indexOf(",") >= 0 ? /,/ : /\s{2,}|\s+/;
  const split = (line) => line.split(sepRe).map((c) => c.trim());
  const header = split(lines[0]);
  const headerLooksLikePeriods = header.slice(1).some((h) => normalizePeriodLabel(h) != null);
  const isLong = header.length === 3 && !headerLooksLikePeriods;
  const ensurePart = (raw) => {
    const key = String(raw == null ? "" : raw).trim();
    if (!key) return null;
    if (!byPart[key]) { byPart[key] = Object.create(null); partOrder.push(key); }
    return key;
  };
  const putValue = (partKey, periodKey, rawVal) => {
    const v = parseFloat(String(rawVal).replace(/[, ]/g, ""));
    if (!Number.isFinite(v)) {
      warnings.push("Non-numeric value for " + partKey + " @ " + periodKey + ": " + rawVal);
      return;
    }
    byPart[partKey][periodKey] = v;
    periodSet[periodKey] = true;
  };
  if (isLong) {
    let startIdx = 0;
    const h0 = (header[0] || "").toLowerCase();
    if (/part|sku|item/.test(h0)) startIdx = 1;
    for (let i = startIdx; i < lines.length; i++) {
      const cells = split(lines[i]);
      if (cells.length < 3) { warnings.push("Skipped (too few cells): " + lines[i]); continue; }
      const partKey = ensurePart(cells[0]);
      const periodKey = normalizePeriodLabel(cells[1]);
      if (!partKey || !periodKey) { warnings.push("Skipped (bad part/period): " + lines[i]); continue; }
      putValue(partKey, periodKey, cells[2]);
    }
  } else {
    const periodKeys = [];
    for (let c = 1; c < header.length; c++) {
      const p = normalizePeriodLabel(header[c]);
      periodKeys.push(p);
      if (!p) warnings.push("Header column #" + (c + 1) + " (" + header[c] + ") didn't look like a period and was skipped.");
    }
    for (let i = 1; i < lines.length; i++) {
      const cells = split(lines[i]);
      if (!cells.length) continue;
      const partKey = ensurePart(cells[0]);
      if (!partKey) { warnings.push("Skipped (blank part): " + lines[i]); continue; }
      for (let c = 1; c < cells.length && c < header.length; c++) {
        const periodKey = periodKeys[c - 1];
        if (!periodKey) continue;
        if (cells[c] === "" || cells[c] == null) continue;
        putValue(partKey, periodKey, cells[c]);
      }
    }
  }
  const periodOrder = Object.keys(periodSet).sort(comparePeriodKeys);
  return { byPart, partOrder, periodOrder, warnings };
}

/**
 * Normalize a free-form period label to a canonical period key.
 * Returns null if it can't be parsed.
 */
function normalizePeriodLabel(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  let m = str.match(/^(\d{4})$/);
  if (m) return m[1];
  m = str.match(/^(\d{4})[\s\-]?Q([1-4])$/i);
  if (m) return m[1] + "-Q" + m[2];
  m = str.match(/^Q([1-4])[\s\-]?(\d{4})$/i);
  if (m) return m[2] + "-Q" + m[1];
  m = str.match(/^Q([1-4])[\s\-]?(\d{2})$/i);
  if (m) {
    const yy = parseInt(m[2], 10);
    const fullY = yy >= 70 ? 1900 + yy : 2000 + yy;
    return fullY + "-Q" + m[1];
  }
  return null;
}

/**
 * Diff dashboard-computed indexes against reference (e.g. Excel) values.
 *
 * Inputs:
 *   dashboardByPart — { [partKey]: { [periodKey]: number } }
 *   excelByPart     — same shape; usually the output of parseExcelPivotText
 *   tolerance       — abs delta (index points) above which a row is "fail"; default 0.5
 *
 * Returns:
 *   {
 *     rows: [ { partKey, periodKey, dashboard, reference, delta, absDelta, pctDelta, status: "match"|"fail"|"missing-dashboard"|"missing-reference" }, ... ],
 *     summary: { compared, matched, failed, missingDashboard, missingReference, maxAbsDelta, maxAbsDeltaRow, maxAbsPctDelta, maxAbsPctDeltaRow }
 *   }
 *
 * Rows are produced for every (part, period) appearing in EITHER side so the
 * user can see coverage holes (e.g. a part in Excel that the dashboard
 * couldn't price). `pctDelta` is computed against the reference where possible.
 */
function diffPartIndexes(dashboardByPart, excelByPart, tolerance) {
  const tol = Number.isFinite(+tolerance) ? +tolerance : 0.5;
  const rows = [];
  const summary = {
    compared: 0,
    matched: 0,
    failed: 0,
    missingDashboard: 0,
    missingReference: 0,
    tolerance: tol,
    maxAbsDelta: 0,
    maxAbsDeltaRow: null,
    maxAbsPctDelta: 0,
    maxAbsPctDeltaRow: null
  };
  const dash = dashboardByPart || Object.create(null);
  const exc = excelByPart || Object.create(null);
  const partKeys = uniqueSortedKeys(dash, exc);
  for (const partKey of partKeys) {
    const dPeriods = dash[partKey] || Object.create(null);
    const ePeriods = exc[partKey] || Object.create(null);
    const periodKeys = uniqueSortedKeys(dPeriods, ePeriods).sort(comparePeriodKeys);
    for (const periodKey of periodKeys) {
      const dVal = Number.isFinite(+dPeriods[periodKey]) ? +dPeriods[periodKey] : null;
      const eVal = Number.isFinite(+ePeriods[periodKey]) ? +ePeriods[periodKey] : null;
      const row = { partKey, periodKey, dashboard: dVal, reference: eVal, delta: null, absDelta: null, pctDelta: null, status: "" };
      if (dVal == null && eVal == null) continue;
      if (dVal == null) {
        row.status = "missing-dashboard";
        summary.missingDashboard += 1;
      } else if (eVal == null) {
        row.status = "missing-reference";
        summary.missingReference += 1;
      } else {
        row.delta = dVal - eVal;
        row.absDelta = Math.abs(row.delta);
        row.pctDelta = eVal !== 0 ? (row.delta / eVal) * 100 : null;
        summary.compared += 1;
        if (row.absDelta <= tol) {
          row.status = "match";
          summary.matched += 1;
        } else {
          row.status = "fail";
          summary.failed += 1;
        }
        if (row.absDelta > summary.maxAbsDelta) {
          summary.maxAbsDelta = row.absDelta;
          summary.maxAbsDeltaRow = { partKey, periodKey };
        }
        if (row.pctDelta != null && Math.abs(row.pctDelta) > summary.maxAbsPctDelta) {
          summary.maxAbsPctDelta = Math.abs(row.pctDelta);
          summary.maxAbsPctDeltaRow = { partKey, periodKey };
        }
      }
      rows.push(row);
    }
  }
  return { rows, summary };
}

function uniqueSortedKeys() {
  const set = Object.create(null);
  for (let i = 0; i < arguments.length; i++) {
    const o = arguments[i];
    if (!o) continue;
    for (const k of Object.keys(o)) set[k] = true;
  }
  return Object.keys(set);
}

/* ============================================================================
 * COVERAGE & SUMMARY HELPERS — feed the totals tiles and detail table.
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
  parseExcelPivotText,
  normalizePeriodLabel,
  diffPartIndexes,
  computeBaselineCoverage,
  sumByPeriodAcrossParts
};
