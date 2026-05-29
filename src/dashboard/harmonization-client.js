/**
 * Browser-side harmonization (Category 1 & 3) aligned with harmonization.py — same MECE rules.
 * Used when splitting Direct vs Indirect from flat rows without changing the Python pipeline.
 */
(function (global) {
  "use strict";
  var VARIANCE_PCT = 0.02;
  var TOP_N = 5;
  var JSON_VERSION = 2;
  /** Hard cap for building all_opportunities (was Infinity when maxRows=null → browser freeze on large Cummins data). */
  var MAX_ALL_OPPORTUNITY_CARDS = 3000;
  /** Refuse client-side MECE recompute above this row count (use refresh_data.py harmonization_results instead). */
  var MAX_CLIENT_HARM_INPUT_ROWS = 100000;
  /** Abort inner top-N loops after this many milliseconds (graceful partial result). */
  var HARM_COMPUTE_BUDGET_MS = 8000;
  /**
   * Same as harmonization.py — MECE card excludes slices whose unit-price span exceeds this (USD).
   * Keep aligned with harmonization.py / refresh_data.py (do not raise to ~1e6 — that would negate price-variance filtering).
   */
  var MAX_UNIT_PRICE_SPREAD_USD = 7500;
  /** Same as harmonization.py — minimum MECE savings for a MECE card row (USD). */
  var MIN_TOP5_SAVINGS_USD = 1000;
  var HARMONIZATION_CALCULATION_NOTES =
    "Maximum unit-price spread capped at $7500 (captures long tail); top cards require at least $1000 MECE savings. " +
    "Base-table outliers trimmed with relaxed IQR (3.0× multiplier) on (item×site) and (item×supplier) groups when ≥4 rows. " +
    "Savings use weighted transaction unit prices × quantities.";
  var BAR_GREEN = "#4CAF50";
  var BAR_BLUE = "#7986CB";

  function roundUsd(x) {
    var v = +x;
    if (v !== v || !isFinite(v)) return 0;
    return Math.round(v * 100) / 100;
  }

  /** Stable item key for MECE: prefer SKU-like part; else commodity code; else description/L3 (matches indirect rows with blank part). */
  function harmonizationItemKey(r) {
    var part, cc, noun, mat, n, l3;
    if (!r) return "";
    part = r.part != null ? String(r.part).trim() : "";
    if (/\d/.test(part)) return part;
    cc = r.ccode != null ? String(r.ccode).trim() : "";
    if (cc) return "ccode:" + cc;
    noun = r.noun != null ? String(r.noun).trim() : "";
    mat = r.material != null ? String(r.material).trim() : "";
    n = noun || mat;
    if (n) return "noun:" + n.slice(0, 200);
    l3 = r.category_l3 != null ? String(r.category_l3).trim() : r.c3 != null ? String(r.c3).trim() : "";
    if (l3) return "l3:" + l3.slice(0, 120);
    return "";
  }

  function rowYear(r) {
    if (!r) return 0;
    var y = +r.year;
    if (y >= 1990 && y <= 2100) return y;
    var ym = r.ym != null ? String(r.ym) : "";
    var m = ym.match(/(20[0-2][0-9])/);
    if (m) {
      y = +m[1];
      if (y >= 1990 && y <= 2100) return y;
    }
    var d = r.d;
    if (d) {
      m = String(d).match(/(20[0-2][0-9])/);
      if (m) {
        y = +m[1];
        if (y >= 1990 && y <= 2100) return y;
      }
    }
    return 0;
  }

  /** forcedYear: if set (e.g. 2025), analyze only that calendar year; else same logic as harmonization.py (latest complete year in data). */
  function buildBaseTable(rows, forcedYear) {
    var nowY = new Date().getFullYear();
    var work = [];
    var i, r, yr, part, sup, site, sp, q, maxInData, yComplete, target_year;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      part = harmonizationItemKey(r);
      if (!part) continue;
      yr = rowYear(r);
      if (!yr || yr < 1990 || yr > 2100) continue;
      sup = r.supplier != null ? String(r.supplier).trim() : "";
      site = r.site != null ? String(r.site).trim() : "";
      sp = +(r.spend != null ? r.spend : 0);
      q = +(r.quantity != null ? r.quantity : r.qty != null ? r.qty : 0);
      if (!isFinite(sp)) sp = 0;
      if (!isFinite(q)) q = 0;
      work.push({ yr: yr, part: part, supplier: sup, site: site, spend: sp, qty: q });
    }
    if (!work.length) return { base: [], targetYear: 0, partKey: "part" };
    maxInData = Math.max.apply(
      null,
      work.map(function (w) {
        return w.yr;
      })
    );
    if (maxInData < 1990 || maxInData > 2100) return { base: [], targetYear: 0, partKey: "part" };
    if (forcedYear != null && forcedYear >= 1990 && forcedYear <= 2100) {
      target_year = forcedYear;
    } else {
      yComplete = work.filter(function (w) {
        return w.yr < nowY;
      });
      target_year = yComplete.length
        ? Math.max.apply(
            null,
            yComplete.map(function (w) {
              return w.yr;
            })
          )
        : Math.min(maxInData, nowY);
    }
    work = work.filter(function (w) {
      return w.yr === target_year;
    });
    if (!work.length) return { base: [], targetYear: target_year, partKey: "part" };
    var gmap = {};
    for (i = 0; i < work.length; i++) {
      var w = work[i];
      var k = w.part + "\0" + w.supplier + "\0" + w.site;
      if (!gmap[k]) gmap[k] = { item: w.part, supplier: w.supplier, site: w.site, total_qty: 0, total_spend: 0, year: target_year };
      gmap[k].total_qty += w.qty;
      gmap[k].total_spend += w.spend;
    }
    var base = [];
    for (var k2 in gmap) {
      var row = gmap[k2];
      if (row.total_qty <= 0 || !row.item) continue;
      row.unit_price = row.total_spend / row.total_qty;
      row.target_year = target_year;
      base.push(row);
    }
    return { base: base, targetYear: target_year, partKey: "part" };
  }

  function fragmentedPartsCount(base) {
    var byItem = {};
    var i, it, up;
    for (i = 0; i < base.length; i++) {
      it = base[i].item;
      up = base[i].unit_price;
      if (!byItem[it]) byItem[it] = { umin: up, umax: up };
      else {
        if (up < byItem[it].umin) byItem[it].umin = up;
        if (up > byItem[it].umax) byItem[it].umax = up;
      }
    }
    var cnt = 0;
    for (it in byItem) {
      var o = byItem[it];
      if (o.umin > 0 && o.umax > o.umin && (o.umax - o.umin) / o.umin > VARIANCE_PCT) cnt++;
    }
    return cnt;
  }

  function minMaxGap(ups) {
    var minP, maxP, j, v;
    if (!ups || !ups.length) return 0;
    minP = ups[0];
    maxP = ups[0];
    for (j = 1; j < ups.length; j++) {
      v = ups[j];
      if (v < minP) minP = v;
      if (v > maxP) maxP = v;
    }
    return maxP - minP;
  }

  /** Tukey IQR — local indices in prices[] to drop; mirrors harmonization._tukey_outlier_indices. */
  function tukeyDropLocalIndices(prices) {
    var n = prices.length;
    if (n < 4) return [];
    var order = [];
    var j;
    for (j = 0; j < n; j++) order.push(j);
    order.sort(function (a, b) {
      return prices[a] - prices[b];
    });
    var sortedP = order.map(function (ix) {
      return prices[ix];
    });
    var q1 = sortedP[Math.floor(n / 4)];
    var q3 = sortedP[Math.floor((3 * n) / 4)];
    var iqr = q3 - q1;
    if (!(iqr > 1e-12)) return [];
    var lo = q1 - 3.0 * iqr;
    var hi = q3 + 3.0 * iqr;
    var drop = {};
    for (j = 0; j < n; j++) {
      var v = sortedP[j];
      if (v < lo || v > hi) drop[order[j]] = 1;
    }
    var kept = n;
    for (j = 0; j < n; j++) if (drop[j]) kept--;
    if (kept < 2) return [];
    var outIdx = [];
    for (j = 0; j < n; j++) if (drop[j]) outIdx.push(j);
    return outIdx;
  }

  /** Mirror harmonization._filter_base_iqr_outliers — row-level Tukey on (item,site) and (item,supplier). */
  function filterBaseIqrOutliers(base) {
    var drop = Object.create(null);
    var byIS = Object.create(null);
    var byISup = Object.create(null);
    var i, k, row, nk, sub, prices, locDrop, li;
    if (!base || !base.length) return { base: [], removedRowCount: 0 };
    for (i = 0; i < base.length; i++) {
      row = base[i];
      k = String(row.item) + "\0" + String(row.site);
      if (!byIS[k]) byIS[k] = [];
      byIS[k].push({ idx: i, price: +row.unit_price });
      k = String(row.item) + "\0" + String(row.supplier);
      if (!byISup[k]) byISup[k] = [];
      byISup[k].push({ idx: i, price: +row.unit_price });
    }
    function applyGroups(groups) {
      for (nk in groups) {
        if (!Object.prototype.hasOwnProperty.call(groups, nk)) continue;
        sub = groups[nk];
        if (sub.length < 4) continue;
        prices = sub.map(function (x) {
          return x.price;
        });
        locDrop = tukeyDropLocalIndices(prices);
        for (li = 0; li < locDrop.length; li++) {
          drop[String(sub[locDrop[li]].idx)] = 1;
        }
      }
    }
    applyGroups(byIS);
    applyGroups(byISup);
    var out = [];
    for (i = 0; i < base.length; i++) {
      if (!drop[String(i)]) out.push(base[i]);
    }
    var removedRowCount = 0;
    for (var dk in drop) {
      if (Object.prototype.hasOwnProperty.call(drop, dk)) removedRowCount++;
    }
    return { base: out, removedRowCount: removedRowCount };
  }

  function assignMece(base) {
    var n = base.length;
    var b = base.map(function (row) {
      return {
        item: String(row.item).trim(),
        supplier: String(row.supplier).trim(),
        site: String(row.site).trim(),
        total_qty: row.total_qty,
        total_spend: row.total_spend,
        unit_price: row.unit_price,
        category: 0,
        savings: 0,
        min_ref_price: row.unit_price,
      };
    });
    var key, j, i, ii, pmin, sups, nSup, sites, nSite;
    var mapIS = {};
    for (i = 0; i < n; i++) {
      key = b[i].item + "\t" + b[i].site;
      if (!mapIS[key]) mapIS[key] = [];
      mapIS[key].push(i);
    }
    for (key in mapIS) {
      var ix = mapIS[key];
      sups = {};
      pmin = Infinity;
      for (j = 0; j < ix.length; j++) {
        ii = ix[j];
        sups[b[ii].supplier] = 1;
        if (b[ii].unit_price < pmin) pmin = b[ii].unit_price;
      }
      nSup = 0;
      for (var s in sups) nSup++;
      if (nSup <= 1) continue;
      for (j = 0; j < ix.length; j++) {
        ii = ix[j];
        if (b[ii].unit_price > pmin + 1e-12) {
          b[ii].category = 1;
          b[ii].min_ref_price = pmin;
          b[ii].savings = (b[ii].unit_price - pmin) * b[ii].total_qty;
        }
      }
    }
    var mapISup = {};
    for (i = 0; i < n; i++) {
      if (b[i].category !== 0) continue;
      key = b[i].item + "\t" + b[i].supplier;
      if (!mapISup[key]) mapISup[key] = [];
      mapISup[key].push(i);
    }
    for (key in mapISup) {
      var ix3 = mapISup[key];
      sites = {};
      pmin = Infinity;
      for (j = 0; j < ix3.length; j++) {
        ii = ix3[j];
        sites[b[ii].site] = 1;
        if (b[ii].unit_price < pmin) pmin = b[ii].unit_price;
      }
      nSite = 0;
      for (var st in sites) nSite++;
      if (nSite <= 1) continue;
      for (j = 0; j < ix3.length; j++) {
        ii = ix3[j];
        if (b[ii].unit_price > pmin + 1e-12) {
          b[ii].category = 3;
          b[ii].min_ref_price = pmin;
          b[ii].savings = (b[ii].unit_price - pmin) * b[ii].total_qty;
        }
      }
    }
    for (i = 0; i < n; i++) {
      if (b[i].category === 0) {
        b[i].savings = 0;
        b[i].min_ref_price = b[i].unit_price;
      }
    }
    var total_sav = 0;
    for (i = 0; i < n; i++) total_sav += b[i].savings;
    var val = {
      category_1_rows: 0,
      category_2_rows: 0,
      category_3_rows: 0,
      no_opportunity_rows: 0,
      sum_matches_base: false,
    };
    for (i = 0; i < n; i++) {
      if (b[i].category === 1) val.category_1_rows++;
      else if (b[i].category === 3) val.category_3_rows++;
      else val.no_opportunity_rows++;
    }
    val.sum_matches_base = val.category_1_rows + val.category_3_rows + val.no_opportunity_rows === n;
    return { tagged: b, val: val, total_sav: total_sav };
  }

  function formatNotePctBelow(pmin, pmax) {
    if (pmin <= 0 || pmax <= pmin) return [0, ""];
    var pct = (100 * (pmax - pmin)) / pmax;
    var r = Math.round(10 * pct) / 10;
    return [r, r + "% below priciest tranche"];
  }

  function argMinUnitPriceRow(pr) {
    if (!pr || !pr.length) return null;
    var mi = 0,
      i,
      minV = pr[0].unit_price;
    for (i = 1; i < pr.length; i++) {
      if (pr[i].unit_price < minV) {
        minV = pr[i].unit_price;
        mi = i;
      }
    }
    return pr[mi];
  }

  function argMaxUnitPriceRow(pr) {
    if (!pr || !pr.length) return null;
    var mi = 0,
      i,
      maxV = pr[0].unit_price;
    for (i = 1; i < pr.length; i++) {
      if (pr[i].unit_price > maxV) {
        maxV = pr[i].unit_price;
        mi = i;
      }
    }
    return pr[mi];
  }

  function sortBaseByUnitPriceAsc(pr) {
    return pr.slice().sort(function (a, b) {
      return a.unit_price - b.unit_price;
    });
  }

  function p80SavingsIndex(tagged, category_id) {
    var m = {};
    var i,
      t,
      key,
      arr = [];
    for (i = 0; i < tagged.length; i++) {
      t = tagged[i];
      if (t.category !== category_id) continue;
      key = category_id === 1 ? t.item + "\t" + t.site : t.item + "\t" + t.supplier;
      m[key] = (m[key] || 0) + t.savings;
    }
    for (key in m) arr.push({ k: key, s: m[key] });
    arr.sort(function (a, b) {
      return b.s - a.s;
    });
    return arr;
  }

  function partsTo80(sortedPairs, total) {
    if (!sortedPairs.length || total <= 0) return 0;
    var target = 0.8 * total;
    var c = 0,
      n = 0,
      i;
    for (i = 0; i < sortedPairs.length; i++) {
      c += sortedPairs[i].s;
      n++;
      if (c >= target) break;
    }
    return n;
  }

  function uniqueItemCount(base) {
    var u = {},
      i;
    for (i = 0; i < base.length; i++) u[base[i].item] = 1;
    var c = 0;
    for (var k in u) c++;
    return c;
  }

  /** O(n) index: item\t → rows (avoids O(pairs×n) base.filter in top5Cat1). */
  function indexBaseByItemSite(base) {
    var m = Object.create(null),
      i,
      row,
      k;
    if (!base || !base.length) return m;
    for (i = 0; i < base.length; i++) {
      row = base[i];
      k = String(row.item).trim() + "\t" + String(row.site).trim();
      if (!m[k]) m[k] = [];
      m[k].push(row);
    }
    return m;
  }

  /** O(n) index: item\tsupplier → rows (top5Cat3). */
  function indexBaseByItemSupplier(base) {
    var m = Object.create(null),
      i,
      row,
      k;
    if (!base || !base.length) return m;
    for (i = 0; i < base.length; i++) {
      row = base[i];
      k = String(row.item).trim() + "\t" + String(row.supplier).trim();
      if (!m[k]) m[k] = [];
      m[k].push(row);
    }
    return m;
  }

  function top5Cat1(tagged, base, maxRows) {
    var t = tagged.filter(function (x) {
      return x.category === 1;
    });
    if (!t.length) return [];
    var gsum = {};
    var i,
      k,
      pairs,
      pi,
      it,
      st,
      it_s,
      st_s,
      pk,
      bpart,
      tot_spend,
      tot_qty,
      pmin,
      pmax,
      pctNote,
      r_lo,
      r_hi,
      note,
      pr,
      labels,
      prices,
      colors,
      row,
      up,
      sn,
      lab,
      is_m,
      groups_table,
      sup_rows,
      export_rows,
      pminVal,
      sav0,
      upv,
      qv,
      row,
      up2,
      lim,
      tCompute0,
      byItemSite;
    for (i = 0; i < t.length; i++) {
      k = t[i].item + "\t" + t[i].site;
      gsum[k] = (gsum[k] || 0) + t[i].savings;
    }
    pairs = Object.keys(gsum).map(function (key) {
      var parts = key.split("\t");
      return { item: parts[0], site: parts.slice(1).join("\t"), sav: gsum[key] };
    });
    pairs.sort(function (a, b) {
      return b.sav - a.sav;
    });
    lim = maxRows === undefined ? TOP_N : maxRows === null ? MAX_ALL_OPPORTUNITY_CARDS : maxRows;
    if (!(lim > 0) || lim === Infinity) lim = MAX_ALL_OPPORTUNITY_CARDS;
    byItemSite = indexBaseByItemSite(base);
    tCompute0 = typeof Date !== "undefined" && Date.now ? Date.now() : 0;
    var out = [];
    for (pi = 0; pi < pairs.length && out.length < lim; pi++) {
      if (tCompute0 && Date.now() - tCompute0 > HARM_COMPUTE_BUDGET_MS) {
        if (typeof console !== "undefined" && console.warn) {
          try {
            console.warn("[harm] top5Cat1 stopped early (time budget " + HARM_COMPUTE_BUDGET_MS + "ms)");
          } catch (eW) {}
        }
        break;
      }
      if (!(pairs[pi].sav >= MIN_TOP5_SAVINGS_USD)) continue;
      it_s = String(pairs[pi].item).trim();
      st_s = String(pairs[pi].site).trim();
      pk = it_s;
      k = it_s + "\t" + st_s;
      bpart = byItemSite[k] || [];
      var supU = {};
      for (i = 0; i < bpart.length; i++) supU[bpart[i].supplier] = 1;
      var nsup = 0;
      for (var kSup in supU) if (Object.prototype.hasOwnProperty.call(supU, kSup)) nsup++;
      if (!bpart.length || nsup < 2) continue;
      tot_spend = 0;
      tot_qty = 0;
      for (i = 0; i < bpart.length; i++) {
        tot_spend += bpart[i].total_spend;
        tot_qty += bpart[i].total_qty;
      }
      pmin = Math.min.apply(
        null,
        bpart.map(function (r) {
          return r.unit_price;
        })
      );
      pmax = Math.max.apply(
        null,
        bpart.map(function (r) {
          return r.unit_price;
        })
      );
      if (!(isFinite(pmin) && isFinite(pmax)) || pmax <= pmin + 1e-12) continue;
      if (pmax - pmin > MAX_UNIT_PRICE_SPREAD_USD) continue;
      pctNote = formatNotePctBelow(pmin, pmax);
      r_lo = argMinUnitPriceRow(bpart);
      r_hi = argMaxUnitPriceRow(bpart);
      note =
        pctNote[1] +
        " · " +
        String(r_hi.supplier) +
        " (high) vs " +
        String(r_lo.supplier) +
        " (low) at same site";
      pr = sortBaseByUnitPriceAsc(bpart);
      labels = [];
      prices = [];
      colors = [];
      for (i = 0; i < pr.length; i++) {
        row = pr[i];
        up = row.unit_price;
        if (!isFinite(up)) continue;
        sn = String(row.supplier);
        lab = sn.length > 50 ? sn.slice(0, 50) + "…" : sn;
        labels.push(lab.slice(0, 100));
        prices.push(Math.round(up));
        is_m = up <= pmin + 1e-9 * (1 + Math.abs(pmin));
        colors.push(is_m ? BAR_GREEN : BAR_BLUE);
      }
      if (!labels.length) continue;
      groups_table = pr.map(function (r) {
        return {
          label: String(r.supplier).slice(0, 50) + " - " + String(r.site).slice(0, 50),
          qty: Math.round(r.total_qty),
        };
      });
      sup_rows = [];
      for (i = 0; i < pr.length; i++) {
        row = pr[i];
        up2 = row.unit_price;
        if (!isFinite(up2)) continue;
        sup_rows.push({
          supplier: String(row.supplier).slice(0, 200),
          site: String(row.site).slice(0, 200),
          unit_price: roundUsd(up2),
          quantity: roundUsd(row.total_qty),
          spend: roundUsd(row.total_spend),
        });
      }
      pminVal = pmin;
      export_rows = [];
      for (i = 0; i < bpart.length; i++) {
        row = bpart[i];
        upv = row.unit_price;
        qv = row.total_qty;
        sav0 = isFinite(upv) && isFinite(qv) ? Math.max(0, (upv - pminVal) * qv) : 0;
        export_rows.push({
          "Item Number": pk,
          Supplier: String(row.supplier),
          Site: String(row.site),
          "Unit Price": roundUsd(row.unit_price),
          Quantity: roundUsd(row.total_qty),
          Spend: roundUsd(row.total_spend),
          Savings: roundUsd(sav0),
          Category: "Category 1",
        });
      }
      out.push({
        harm_mece: 1,
        item: (pk + " · " + st_s).slice(0, 200),
        total_spend: Math.round(tot_spend),
        total_quantity: Math.round(tot_qty),
        price_gap_abs: roundUsd(pmax - pmin),
        price_gap_pct: pctNote[0],
        savings_subtitle: note,
        has_price_variance: pmax > pmin + 1e-12,
        lowest_supplier_site: (String(r_lo.supplier).slice(0, 50) + " - " + String(r_lo.site).slice(0, 40)).slice(0, 200),
        highest_supplier_site: (String(r_hi.supplier).slice(0, 50) + " - " + String(r_hi.site).slice(0, 40)).slice(0, 200),
        suppliers: sup_rows,
        supplier_count: sup_rows.length,
        chart: {
          labels: labels,
          unit_prices: prices,
          bar_colors: colors,
          y_axis_label: "Unit price (USD / unit)",
        },
        groups: groups_table,
        export_rows: export_rows,
      });
    }
    return out;
  }

  function top5Cat3(tagged, base, maxRows) {
    var t = tagged.filter(function (x) {
      return x.category === 3;
    });
    if (!t.length) return [];
    var gsum = {};
    var i,
      k,
      pairs,
      pi,
      it_s,
      sup_s,
      pk,
      bpart,
      tot_spend,
      tot_qty,
      pmin,
      pmax,
      pctNote,
      r_lo,
      r_hi,
      note,
      pr,
      labels,
      prices,
      colors,
      row,
      up,
      site_str,
      lab,
      is_m,
      groups_table,
      sup_rows,
      export_rows,
      pminVal,
      sav0,
      upv,
      qv,
      row,
      up2,
      lim,
      tCompute0,
      byItemSup;
    for (i = 0; i < t.length; i++) {
      k = t[i].item + "\t" + t[i].supplier;
      gsum[k] = (gsum[k] || 0) + t[i].savings;
    }
    pairs = Object.keys(gsum).map(function (key) {
      var parts = key.split("\t");
      return { item: parts[0], supplier: parts.slice(1).join("\t"), sav: gsum[key] };
    });
    pairs.sort(function (a, b) {
      return b.sav - a.sav;
    });
    lim = maxRows === undefined ? TOP_N : maxRows === null ? MAX_ALL_OPPORTUNITY_CARDS : maxRows;
    if (!(lim > 0) || lim === Infinity) lim = MAX_ALL_OPPORTUNITY_CARDS;
    byItemSup = indexBaseByItemSupplier(base);
    tCompute0 = typeof Date !== "undefined" && Date.now ? Date.now() : 0;
    var out = [];
    for (pi = 0; pi < pairs.length && out.length < lim; pi++) {
      if (tCompute0 && Date.now() - tCompute0 > HARM_COMPUTE_BUDGET_MS) {
        if (typeof console !== "undefined" && console.warn) {
          try {
            console.warn("[harm] top5Cat3 stopped early (time budget " + HARM_COMPUTE_BUDGET_MS + "ms)");
          } catch (eW2) {}
        }
        break;
      }
      if (!(pairs[pi].sav >= MIN_TOP5_SAVINGS_USD)) continue;
      it_s = String(pairs[pi].item).trim();
      sup_s = String(pairs[pi].supplier).trim();
      pk = it_s;
      k = it_s + "\t" + sup_s;
      bpart = byItemSup[k] || [];
      var siteU = {};
      for (i = 0; i < bpart.length; i++) siteU[bpart[i].site] = 1;
      var nsite = 0;
      for (var kSt in siteU) if (Object.prototype.hasOwnProperty.call(siteU, kSt)) nsite++;
      if (!bpart.length || nsite < 2) continue;
      tot_spend = 0;
      tot_qty = 0;
      for (i = 0; i < bpart.length; i++) {
        tot_spend += bpart[i].total_spend;
        tot_qty += bpart[i].total_qty;
      }
      pmin = Math.min.apply(
        null,
        bpart.map(function (r) {
          return r.unit_price;
        })
      );
      pmax = Math.max.apply(
        null,
        bpart.map(function (r) {
          return r.unit_price;
        })
      );
      if (!(isFinite(pmin) && isFinite(pmax)) || pmax <= pmin + 1e-12) continue;
      if (pmax - pmin > MAX_UNIT_PRICE_SPREAD_USD) continue;
      pctNote = formatNotePctBelow(pmin, pmax);
      r_lo = argMinUnitPriceRow(bpart);
      r_hi = argMaxUnitPriceRow(bpart);
      note =
        pctNote[1] +
        " · " +
        String(r_hi.site) +
        " vs " +
        String(r_lo.site) +
        " (same supplier)";
      pr = sortBaseByUnitPriceAsc(bpart);
      labels = [];
      prices = [];
      colors = [];
      for (i = 0; i < pr.length; i++) {
        row = pr[i];
        up = row.unit_price;
        if (!isFinite(up)) continue;
        site_str = String(row.site);
        lab = site_str.length > 60 ? site_str.slice(0, 60) + "…" : site_str;
        labels.push(lab.slice(0, 100));
        prices.push(Math.round(up));
        is_m = up <= pmin + 1e-9 * (1 + Math.abs(pmin));
        colors.push(is_m ? BAR_GREEN : BAR_BLUE);
      }
      if (!labels.length) continue;
      groups_table = pr.map(function (r) {
        return {
          label: String(r.supplier).slice(0, 50) + " - " + String(r.site).slice(0, 50),
          qty: Math.round(r.total_qty),
        };
      });
      sup_rows = [];
      for (i = 0; i < pr.length; i++) {
        row = pr[i];
        up2 = row.unit_price;
        if (!isFinite(up2)) continue;
        sup_rows.push({
          supplier: String(row.supplier).slice(0, 200),
          site: String(row.site).slice(0, 200),
          unit_price: roundUsd(up2),
          quantity: roundUsd(row.total_qty),
          spend: roundUsd(row.total_spend),
        });
      }
      pminVal = pmin;
      export_rows = [];
      for (i = 0; i < bpart.length; i++) {
        row = bpart[i];
        upv = row.unit_price;
        qv = row.total_qty;
        sav0 = isFinite(upv) && isFinite(qv) ? Math.max(0, (upv - pminVal) * qv) : 0;
        export_rows.push({
          "Item Number": pk,
          Supplier: String(row.supplier),
          Site: String(row.site),
          "Unit Price": roundUsd(row.unit_price),
          Quantity: roundUsd(row.total_qty),
          Spend: roundUsd(row.total_spend),
          Savings: roundUsd(sav0),
          Category: "Category 3",
        });
      }
      out.push({
        harm_mece: 3,
        item: (pk + " · " + sup_s).slice(0, 200),
        total_spend: Math.round(tot_spend),
        total_quantity: Math.round(tot_qty),
        price_gap_abs: roundUsd(pmax - pmin),
        price_gap_pct: pctNote[0],
        savings_subtitle: note,
        has_price_variance: pmax > pmin + 1e-12,
        lowest_supplier_site: (String(r_lo.site).slice(0, 50) + " (low) · $" + Math.round(pmin)).slice(0, 200),
        highest_supplier_site: (String(r_hi.site).slice(0, 50) + " (high) · $" + Math.round(pmax)).slice(0, 200),
        suppliers: sup_rows,
        site_count: nsite,
        chart: {
          labels: labels,
          unit_prices: prices,
          bar_colors: colors,
          y_axis_label: "Unit price (USD / unit)",
        },
        groups: groups_table,
        export_rows: export_rows,
      });
    }
    return out;
  }

  function harmSumExportRowsSavings(p) {
    var er = p && p.export_rows,
      s = 0,
      i,
      x;
    if (!er || !er.length) return 0;
    for (i = 0; i < er.length; i++) {
      x = er[i] && er[i].Savings;
      if (x != null && !isNaN(+x)) s += +x;
    }
    return s;
  }

  function perCategoryBlock(taggedArr, category_id, title, baseArr) {
    var t = taggedArr.filter(function (x) {
      return x.category === category_id;
    });
    var spend_cat = 0,
      sav = 0,
      i;
    for (i = 0; i < t.length; i++) {
      spend_cat += t[i].total_spend;
      sav += t[i].savings;
    }
    var isum = p80SavingsIndex(taggedArr, category_id);
    var p80 = sav > 0 && isum.length ? partsTo80(isum, sav) : 0;
    var top5 = category_id === 1 ? top5Cat1(taggedArr, baseArr) : top5Cat3(taggedArr, baseArr);
    var pct_v = spend_cat > 0 ? Math.round(10 * ((100 * sav) / spend_cat)) / 10 : null;
    return {
      id: category_id,
      title: title,
      savings_usd: roundUsd(sav),
      category_spend_usd: roundUsd(spend_cat),
      parts_for_80_pct_value: Math.round(p80),
      pct_savings_vs_spend: pct_v == null ? null : pct_v,
      top5: top5,
    };
  }

  function harmEmpty(msg) {
    return {
      v: JSON_VERSION,
      message: msg,
      analysis_year: null,
      part_key: "",
      base_table_row_count: 0,
      validation: {
        category_1_rows: 0,
        category_2_rows: 0,
        category_3_rows: 0,
        no_opportunity_rows: 0,
        sum_matches_base: false,
      },
      total_opportunity_usd: 0,
      price_fragmented_parts_count: 0,
      parts_for_80_pct_value: 0,
      pct_savings_vs_spend: null,
      categories: [],
      category_1: [],
      category_3: [],
      top_5: [],
      top_10: [],
      harmonization_meta: {
        max_unit_price_spread_usd: MAX_UNIT_PRICE_SPREAD_USD,
        min_top5_savings_usd: MIN_TOP5_SAVINGS_USD,
        calculation_notes: HARMONIZATION_CALCULATION_NOTES,
        outlier_method: "none",
        iqr_outlier_rows_removed: 0,
      },
      all_opportunities: [],
    };
  }

  function calculateFromRows(rows, opts) {
    try {
      return calculateFromRowsInner(rows, opts || {});
    } catch (e) {
      if (typeof console !== "undefined" && console.error) {
        try {
          console.error("[harm] calculateFromRows failed:", e);
        } catch (e2) {}
      }
      return harmEmpty(e && e.message ? "compute_error: " + String(e.message).slice(0, 120) : "compute_error");
    }
  }

  function calculateFromRowsInner(rows, opts) {
    var fy;
    opts = opts || {};
    if (!rows || !rows.length) return harmEmpty("empty_rows");
    if (rows.length > MAX_CLIENT_HARM_INPUT_ROWS) {
      if (typeof console !== "undefined" && console.warn) {
        try {
          console.warn(
            "[harm] Client harmonization skipped: " +
              rows.length +
              " rows > limit " +
              MAX_CLIENT_HARM_INPUT_ROWS +
              " (precompute with refresh_data.py)."
          );
        } catch (eL) {}
      }
      return harmEmpty("row_count_exceeds_client_limit_" + MAX_CLIENT_HARM_INPUT_ROWS);
    }
    fy = opts.analysisYear != null && opts.analysisYear !== "" ? +opts.analysisYear : null;
    if (fy == null || isNaN(fy) || fy < 1990 || fy > 2100) fy = null;
    var bt = buildBaseTable(rows, fy);
    var base = bt.base;
    var target_year = bt.targetYear;
    var part_key = bt.partKey || "part";
    if (!base || !base.length) return harmEmpty(target_year ? "no_rows_for_target_year" : "empty_rows");
    var gapF;
    try {
      gapF = filterBaseIqrOutliers(base);
    } catch (eFlt) {
      if (typeof console !== "undefined" && console.error) {
        try {
          console.error("[harm] outlier filter failed; continuing without filter:", eFlt);
        } catch (e2) {}
      }
      gapF = { base: base, removedRowCount: 0 };
    }
    base = gapF.base;
    if (typeof console !== "undefined" && console.log) {
      try {
        console.log("[harm] iqr_outlier_rows_removed=" + gapF.removedRowCount);
      } catch (eGap) {}
    }
    if (!base || !base.length) return harmEmpty(target_year ? "no_rows_after_outlier_filter" : "empty_rows");
    var frag = fragmentedPartsCount(base);
    var me = assignMece(base);
    var tagged = me.tagged;
    var val = me.val;
    var total_opp = me.total_sav;
    var current_spend = 0;
    var i;
    for (i = 0; i < base.length; i++) current_spend += base[i].total_spend;
    var all_item_sav = {};
    for (i = 0; i < tagged.length; i++) {
      if (tagged[i].category !== 1 && tagged[i].category !== 3) continue;
      var itk = tagged[i].item;
      all_item_sav[itk] = (all_item_sav[itk] || 0) + tagged[i].savings;
    }
    var itemSavArr = Object.keys(all_item_sav).map(function (k) {
      return { item: k, s: all_item_sav[k] };
    });
    itemSavArr.sort(function (a, b) {
      return b.s - a.s;
    });
    var p80_all = total_opp > 0 ? partsTo80(itemSavArr.map(function (x) {
      return { s: x.s };
    }), total_opp) : 0;
    var pct_spend = current_spend > 0 ? Math.round(10 * ((100 * total_opp) / current_spend)) / 10 : null;
    var catDefs = [
      [1, "Same site, different suppliers (unit price spread)"],
      [3, "Same supplier, different sites (unit price spread)"],
    ];
    var categories = catDefs.map(function (cd) {
      return perCategoryBlock(tagged, cd[0], cd[1], base);
    });
    var allCat1 = top5Cat1(tagged, base, MAX_ALL_OPPORTUNITY_CARDS);
    var allCat3 = top5Cat3(tagged, base, MAX_ALL_OPPORTUNITY_CARDS);
    var all_opp = allCat1.concat(allCat3);
    all_opp.sort(function (a, b) {
      return harmSumExportRowsSavings(b) - harmSumExportRowsSavings(a);
    });
    return {
      v: JSON_VERSION,
      message: "ok",
      year: target_year,
      analysis_year: target_year,
      part_key: part_key,
      parts_analyzed: uniqueItemCount(base),
      base_table_row_count: base.length,
      current_year_spend_usd: roundUsd(current_spend),
      total_opportunity_usd: Math.round(Math.max(0, total_opp)),
      total_opportunity_float: roundUsd(Math.max(0, total_opp)),
      price_fragmented_parts_count: frag,
      parts_for_80_pct_value: Math.round(p80_all),
      pct_savings_vs_spend: pct_spend == null ? null : pct_spend,
      validation: val,
      categories: categories,
      category_1: allCat1,
      category_3: allCat3,
      top_5: categories[0] && categories[0].top5 ? categories[0].top5.slice(0, TOP_N) : [],
      top_10: [],
      harmonization_meta: {
        max_unit_price_spread_usd: MAX_UNIT_PRICE_SPREAD_USD,
        min_top5_savings_usd: MIN_TOP5_SAVINGS_USD,
        calculation_notes: HARMONIZATION_CALCULATION_NOTES,
        outlier_method: "iqr_tukey_rows",
        iqr_multiplier: 3.0,
        iqr_outlier_rows_removed: gapF.removedRowCount,
      },
      all_opportunities: all_opp,
    };
  }


  /* ====================================================================
   * INDIRECT HARMONIZATION — Cat 1 + Cat 2 + pre-clean + de-duplication
   *
   * Standalone math layer for the redesigned Indirect Harmonization tab.
   * Operates on RAW transaction rows (typically post-key-remap so that
   * blank/non-numeric Part Numbers carry a synthetic `IH#FUZZY#<id>` key
   * in `r._idpIhKey` — supplied by the caller via opts.partKeyFn). The
   * function emits two MECE-aligned opportunity lists (harm_mece 4 and
   * 5) in the same shape that renderHarmonizationUnified consumes, plus
   * a diagnostics block reporting pre-clean exclusions, group-level
   * noise-filter exclusions, dedup reassignment counts, and per-play
   * totals.
   *
   * PRE-CLEAN PASS (applied BEFORE any grouping or benchmarking — these
   * rows do not exist for the purposes of the analysis):
   *   • Drop rows whose part-description text (r.material OR r.noun)
   *     contains any "dummy word" — word-boundary, case-insensitive.
   *   • Drop rows with qty <= 0 OR unit price <= 0 (computed sp/q).
   *   • Drop rows with line spend < minLineSpendUsd ($50).
   *   • Drop rows with unit price < minUnitPriceUsd ($0.05).
   * Each rule's exclusion count is reported via diagnostics so the UI
   * can show a transparent chip row.
   *
   * Categories:
   *   Cat 1 (harm_mece = 4, high-confidence):
   *     Same Supplier, Same Site, Same Part — Single-Invoice Rightsizing.
   *     Benchmark = MIN unit price within the (key, site, supplier)
   *     group; per-transaction savings = (up - benchmark) * qty for
   *     every transaction whose up > benchmark.
   *   Cat 2 (harm_mece = 5, medium-confidence):
   *     Same Supplier, Different Sites, Same Part — Cross-Site
   *     Rightsizing to Site Average. For each site in the (key,
   *     supplier) group, compute the site's VOLUME-WEIGHTED average
   *     unit price = sum(spend at site) / sum(qty at site). Benchmark
   *     = MIN of those site averages, restricted to sites with at
   *     least cat2MinBenchmarkSiteTxns transactions (default 3) — this
   *     keeps a singleton "lucky low" invoice from becoming a
   *     defensible cross-site benchmark. Per-transaction savings for
   *     a transaction at a non-benchmark site with up > benchmark =
   *     (up - benchmark) * qty.
   *
   * Group-level noise filters (applied at group level, BOTH categories):
   *   minBenchmarkUsd      group's benchmark unit price must be >= this
   *   maxPriceRatio        group's (maxUP / minUP) must be <= this
   *   maxQtyRatio          group's (maxQty / minQty) must be <= this OR
   *                        the high-quantity rows must NOT have a unit
   *                        price < 10% of the low-quantity rows' unit
   *                        price (UoM-mismatch fingerprint guard)
   *   minBenchmarkVolumeShare  fraction of the group's total quantity
   *                            that the benchmark price must come
   *                            from -- protects against a benchmark
   *                            anchored in a single sliver of volume
   *   minTransactions      group must have at least this many raw
   *                        transactions (post-pre-clean; signal-quality)
   *   minSavingsUsd        group's total post-dedup savings must be >=
   *                        this (post-dedup; quality of the play)
   *
   * De-duplication:
   *   For every transaction that is eligible for BOTH categories (its
   *   up exceeds both its same-site min and the cross-site site-avg
   *   min), assign to the category whose per-transaction savings is
   *   LARGER. On exact equality, Cat 1 wins (higher-confidence). After
   *   dedup we recompute per-group totals; any group whose post-dedup
   *   total falls below minSavingsUsd is dropped.
   *
   * @param {Array} rows  Raw transaction rows (post-L1-filter,
   *   post-key-remap). Required fields: spend, quantity (or qty),
   *   supplier, site, year (or ym/d). For pre-clean dummy-word match,
   *   r.material and r.noun are scanned.
   * @param {object} opts
   *   partKeyFn(r) -> string   REQUIRED. Returns the IH part key for
   *                            this row, or "" to skip the row.
   *   forcedYear: number|null  If set, analyze only that calendar year.
   *   minBenchmarkUsd: number  Default 1.00
   *   maxPriceRatio: number    Default 20
   *   maxQtyRatio: number      Default 10 (UoM-mismatch guard)
   *   minBenchmarkVolumeShare: number  Default 0.10 (benchmark-anchor guard)
   *   minTransactions: number  Default 5
   *   minSavingsUsd: number    Default 5000
   *   cat2MinBenchmarkSiteTxns: number  Default 3 (singleton-lucky-low guard)
   *   dummyWords: string[]     Default INDIRECT_HARM_DUMMY_WORDS_DEFAULT
   *   minLineSpendUsd: number  Default 50
   *   minUnitPriceUsd: number  Default 0.05
   *   maxOppsPerPlay: number   Hard cap per category.
   *
   * @returns {{
   *   cat1Opps: Opportunity[],          // post-dedup, savings-sorted
   *   cat2Opps: Opportunity[],          // post-dedup, savings-sorted
   *   diagnostics: { ...counts and Top 5 per category... }
   * }}
   */
  var INDIRECT_HARM_DUMMY_WORDS_DEFAULT = ["dummy", "sample", "test", "ncr", "return", "credit", "adjustment", "void", "reversal", "placeholder"];

  function computeIndirectHarmFromRows(rows, opts) {
    opts = opts || {};
    var partKeyFn = typeof opts.partKeyFn === "function" ? opts.partKeyFn : harmonizationItemKey;
    var forcedYear = opts.forcedYear != null ? +opts.forcedYear : null;
    var minBenchmarkUsd = opts.minBenchmarkUsd != null ? +opts.minBenchmarkUsd : 1.00;
    var maxPriceRatio = opts.maxPriceRatio != null ? +opts.maxPriceRatio : 20;
    /* UoM-mismatch fingerprint guard. Two bands of activity within a
       (Supplier, Site, Part) group -- one with low quantities at high
       unit prices, one with high quantities at much lower unit prices
       -- almost always indicates the items being billed are different
       even though they share a part key (e.g. one supplier line is
       billed "per system" at $89K/unit and a separate line is billed
       "per piece" at $1,260/unit). Trip the guard when BOTH (a)
       maxQty/minQty > maxQtyRatio AND (b) the high-quantity cohort's
       volume-weighted avg unit price is below 10% of the low-quantity
       cohort's. */
    var maxQtyRatio = opts.maxQtyRatio != null ? +opts.maxQtyRatio : 10;
    /* The benchmark price must come from transactions representing at
       least this fraction of the group's total quantity, otherwise
       the benchmark is anchored in an outlier sliver of volume and
       not defensible. */
    var minBenchmarkVolumeShare = opts.minBenchmarkVolumeShare != null ? +opts.minBenchmarkVolumeShare : 0.10;
    var minTransactions = opts.minTransactions != null ? +opts.minTransactions : 5;
    var minSavingsUsd = opts.minSavingsUsd != null ? +opts.minSavingsUsd : 5000;
    var cat2MinBenchmarkSiteTxns = opts.cat2MinBenchmarkSiteTxns != null ? +opts.cat2MinBenchmarkSiteTxns : 3;
    var minLineSpendUsd = opts.minLineSpendUsd != null ? +opts.minLineSpendUsd : 50;
    var minUnitPriceUsd = opts.minUnitPriceUsd != null ? +opts.minUnitPriceUsd : 0.05;
    var maxOppsPerPlay = opts.maxOppsPerPlay != null ? +opts.maxOppsPerPlay : MAX_ALL_OPPORTUNITY_CARDS;
    var dummyWords = Array.isArray(opts.dummyWords) && opts.dummyWords.length
      ? opts.dummyWords
      : INDIRECT_HARM_DUMMY_WORDS_DEFAULT;
    /* Pre-compile a single word-boundary regex for the dummy-word match
       so each row is one regex test instead of N substring lookups. */
    var dummyRegex = null;
    if (dummyWords && dummyWords.length) {
      var esc = dummyWords.map(function (w) {
        return String(w).toLowerCase().replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      });
      dummyRegex = new RegExp("\\b(" + esc.join("|") + ")\\b", "i");
    }
    var diag = {
      rawRowsIn: rows ? rows.length : 0,
      /* Walk top-bookend — every indirect invoice in the input slice.
         The walk reconciles from this raw total down to analyzedRowsSpend
         (bottom bookend), with every drop made visible. Bookends use
         SIGNED spend; intermediate exclusion buckets are tracked both
         signed and absolute (the in-app walk renders absolute so
         credit-note exclusions show as a clear "minus"). */
      inScopeRowsCount: 0,
      inScopeRowsSpend: 0,
      /* Walk bucket 0 — structural drops: row missing the analysis
         year OR missing supplier OR missing site. Made explicit so the
         walk no longer silently swallows ~75% of indirect rows. */
      structuralExcludedRowsCount: 0,
      structuralExcludedRowsSpend: 0,
      structuralExcludedRowsSpendAbs: 0,
      preCleanExcludedByDummyWord: 0,
      preCleanExcludedByDummyWordSpend: 0,
      preCleanExcludedByDummyWordSpendAbs: 0,
      preCleanExcludedByZeroQtyOrPrice: 0,
      preCleanExcludedByZeroQtyOrPriceSpend: 0,
      preCleanExcludedByZeroQtyOrPriceSpendAbs: 0,
      /* Bucket 2 sub-breakdown (credit-notes/returns vs. literal zero
         qty-or-price). Lets the walk annotate how much of the bucket-2
         exclusion is "legitimate credits we can't analyze" vs. "real
         junk rows". */
      preCleanExcludedByCreditNoteCount: 0,
      preCleanExcludedByCreditNoteSpend: 0,
      preCleanExcludedByCreditNoteSpendAbs: 0,
      preCleanExcludedByZeroOnlyCount: 0,
      preCleanExcludedByZeroOnlySpend: 0,
      preCleanExcludedByZeroOnlySpendAbs: 0,
      preCleanExcludedByMinLineSpend: 0,
      preCleanExcludedByMinLineSpendSpend: 0,
      preCleanExcludedByMinLineSpendSpendAbs: 0,
      preCleanExcludedByMinUnitPrice: 0,
      preCleanExcludedByMinUnitPriceSpend: 0,
      preCleanExcludedByMinUnitPriceSpendAbs: 0,
      rowsAfterPreClean: 0,
      /* In-scope rows that survived pre-clean but had no part key.
         Split between bucket 10 (sanity-check splits) and bucket 11
         (singletons — no clusterable peer) based on the row's
         `_idpIhClusterFate` flag stamped by _idpIhBuildPrep. Tracking
         these only post-pre-clean (rather than off the raw slice) is
         how the walk stays MECE — a singleton with qty=0 is bucket 2
         (qty/up≤0), not bucket 11. */
      excludedBySanitySplitRowsCount: 0,
      excludedBySanitySplitRowsSpend: 0,
      excludedBySanitySplitRowsSpendAbs: 0,
      excludedAsSingletonRowsCount: 0,
      excludedAsSingletonRowsSpend: 0,
      excludedAsSingletonRowsSpendAbs: 0,
      targetYear: null,
      rowsKeyedByPartNum: 0,
      rowsKeyedByFuzzy: 0,
      cat1GroupsTotal: 0,
      cat1ExcludedByMinTransactions: 0,
      cat1ExcludedByMinBenchmark: 0,
      cat1ExcludedByMaxRatio: 0,
      cat1ExcludedByQtyBand: 0,
      cat1ExcludedByBenchShare: 0,
      cat1ExcludedByMinSavings: 0,
      cat1ExcludedDroppedByMaxOpps: 0,
      cat1GroupsKept: 0,
      cat1TotalSavings: 0,
      cat1Top5: [],
      cat2GroupsTotal: 0,
      cat2ExcludedByMinTransactions: 0,
      cat2ExcludedByMinBenchmark: 0,
      cat2ExcludedByMaxRatio: 0,
      cat2ExcludedByQtyBand: 0,
      cat2ExcludedByBenchShare: 0,
      cat2ExcludedByOneSite: 0,
      cat2ExcludedByNoEligibleBenchmarkSite: 0,
      cat2ExcludedByMinSavings: 0,
      cat2ExcludedDroppedByMaxOpps: 0,
      cat2GroupsKept: 0,
      cat2TotalSavings: 0,
      cat2Top5: [],
      dedupReassignmentsTotal: 0,
      dedupReassignedToCat1: 0,
      dedupReassignedToCat2: 0,
      dedupTiesResolvedToCat1: 0,
      /* Walk buckets 5-8 — per-row attribution after group filters and
         post-dedup. Each row's Cat 1 group is checked in display order
         (minTxn → minSavings → minBenchmark → maxRatio); a row whose
         Cat 1 group OR Cat 2 group is kept is "analyzed" instead. */
      groupExcludedByMinTransactionsRowsCount: 0,
      groupExcludedByMinTransactionsRowsSpend: 0,
      groupExcludedByMinTransactionsRowsSpendAbs: 0,
      groupExcludedByMinSavingsRowsCount: 0,
      groupExcludedByMinSavingsRowsSpend: 0,
      groupExcludedByMinSavingsRowsSpendAbs: 0,
      groupExcludedByMinBenchmarkRowsCount: 0,
      groupExcludedByMinBenchmarkRowsSpend: 0,
      groupExcludedByMinBenchmarkRowsSpendAbs: 0,
      groupExcludedByMaxRatioRowsCount: 0,
      groupExcludedByMaxRatioRowsSpend: 0,
      groupExcludedByMaxRatioRowsSpendAbs: 0,
      /* UoM-mismatch fingerprint guard rejections, per-row, post-emit.
         Catches the pattern where a (Part, Supplier, Site) -- or
         (Part, Supplier) -- group has both a low-qty/high-price
         cohort and a high-qty/low-price cohort that almost certainly
         represent different items billed under the same part key
         (e.g. billed "per system" vs "per piece"). */
      groupExcludedByQtyBandRowsCount: 0,
      groupExcludedByQtyBandRowsSpend: 0,
      groupExcludedByQtyBandRowsSpendAbs: 0,
      /* Benchmark-anchor guard rejections, per-row, post-emit. Catches
         the pattern where the benchmark unit price is set by a tiny
         sliver of the group's total volume (e.g. one 12-unit invoice
         in a group otherwise dominated by 6 single-unit invoices at
         a completely different price band). */
      groupExcludedByBenchShareRowsCount: 0,
      groupExcludedByBenchShareRowsSpend: 0,
      groupExcludedByBenchShareRowsSpendAbs: 0,
      /* Walk bottom-bookend — UNIQUE rows in at least one kept opp. */
      analyzedRowsCount: 0,
      analyzedRowsSpend: 0
    };
    if (!rows || !rows.length) return { cat1Opps: [], cat2Opps: [], diagnostics: diag };
    /* No upstream truncation here — Indirect Harm runs in <1s on
       300k rows in benchmark, and the Assumption Walk's top-bookend
       must equal the Spend Overview KPI tile by spec. The legacy
       MAX_CLIENT_HARM_INPUT_ROWS cap belongs only to standard
       Harmonization (calculateFromRows). */
    /* PASS 1: structural sanity (year in range, supplier+site present)
       AND target-year determination. Rows that fail structural sanity
       are out of the walk's "in-scope" universe — they're not counted
       in any walk bucket (the walk reconciles within the analysis
       target year only, matching the rest of the tab's KPIs). */
    var nowY = new Date().getFullYear();
    var i, r, yr, partKey, sup, site, sp, q, up;
    var yearsSeen = [];
    var yComplete = [];
    var maxInData = -Infinity;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (!r) continue;
      yr = rowYear(r);
      if (!yr || yr < 1990 || yr > 2100) continue;
      sup = r.supplier != null ? String(r.supplier).trim() : "";
      site = r.site != null ? String(r.site).trim() : "";
      if (!sup || !site) continue;
      if (yr > maxInData) maxInData = yr;
      if (yr < nowY) yComplete.push(yr);
      yearsSeen.push(yr);
    }
    var target_year;
    if (forcedYear != null && forcedYear >= 1990 && forcedYear <= 2100) {
      target_year = forcedYear;
    } else if (yearsSeen.length) {
      if (yComplete.length) {
        /* Math.max.apply blows the call stack on 100k+ entries; loop
           is O(N) and safe for the in-scope-sized inputs we now allow. */
        var maxC = -Infinity;
        for (var yi = 0; yi < yComplete.length; yi++) {
          if (yComplete[yi] > maxC) maxC = yComplete[yi];
        }
        target_year = maxC;
      } else {
        target_year = Math.min(maxInData, nowY);
      }
    } else {
      target_year = 0;
    }
    diag.targetYear = target_year || null;
    if (!target_year) return { cat1Opps: [], cat2Opps: [], diagnostics: diag };

    /* PASS 2: walk over EVERY indirect input row so the top bookend
       matches the Spend Overview KPI tile. Attribute each row to
       exactly one bucket in display order:
         0. structural (year != target / missing supplier / missing site)
         1. dummy word
         2. qty ≤ 0 or unit price ≤ 0 (signed sub-split: credit-note vs zero-only)
         3. line spend < $50
         4. unit price < $0.05
         5–8. group filters (attributed later, post-emit)
         9. fuzzy sanity-check split
        10. singleton (no Part #, no clusterable peer)
        11. analyzed
       Pre-clean rules use first-failing-rule attribution to stay MECE. */
    var work = [];
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (!r) continue;
      /* For walk in-scope spend, treat non-finite spend as 0 so the
         total is a valid number; the row still counts as in-scope (an
         invoice with garbage spend is structurally present). */
      sp = +(r.spend != null ? r.spend : 0);
      if (!isFinite(sp)) sp = 0;
      diag.inScopeRowsCount++;
      diag.inScopeRowsSpend += sp;
      /* Bucket 0: structural — year missing/out-of-range, year !=
         target, or supplier/site blank. Surfaced as a real exclusion
         row in the walk (was previously a silent drop). */
      yr = rowYear(r);
      sup = r.supplier != null ? String(r.supplier).trim() : "";
      site = r.site != null ? String(r.site).trim() : "";
      if (!yr || yr < 1990 || yr > 2100 || yr !== target_year || !sup || !site) {
        diag.structuralExcludedRowsCount++;
        diag.structuralExcludedRowsSpend += sp;
        diag.structuralExcludedRowsSpendAbs += Math.abs(sp);
        continue;
      }
      /* Bucket 1: dummy word in r.material or r.noun. */
      if (dummyRegex) {
        var descA = r.material != null ? String(r.material) : "";
        var descB = r.noun != null ? String(r.noun) : "";
        if (dummyRegex.test(descA) || dummyRegex.test(descB)) {
          diag.preCleanExcludedByDummyWord++;
          diag.preCleanExcludedByDummyWordSpend += sp;
          diag.preCleanExcludedByDummyWordSpendAbs += Math.abs(sp);
          continue;
        }
      }
      /* Bucket 2: qty ≤ 0 or unit price ≤ 0. Sub-split:
           - credit-note / return: qty < 0 OR sp < 0
           - literal zero: qty == 0 OR sp == 0 (and neither is negative) */
      q = +(r.quantity != null ? r.quantity : r.qty != null ? r.qty : 0);
      if (!isFinite(q)) q = 0;
      if (q <= 0 || sp <= 0) {
        diag.preCleanExcludedByZeroQtyOrPrice++;
        diag.preCleanExcludedByZeroQtyOrPriceSpend += sp;
        diag.preCleanExcludedByZeroQtyOrPriceSpendAbs += Math.abs(sp);
        if (q < 0 || sp < 0) {
          diag.preCleanExcludedByCreditNoteCount++;
          diag.preCleanExcludedByCreditNoteSpend += sp;
          diag.preCleanExcludedByCreditNoteSpendAbs += Math.abs(sp);
        } else {
          diag.preCleanExcludedByZeroOnlyCount++;
          diag.preCleanExcludedByZeroOnlySpend += sp;
          diag.preCleanExcludedByZeroOnlySpendAbs += Math.abs(sp);
        }
        continue;
      }
      /* Bucket 3: line spend < $50. */
      if (sp < minLineSpendUsd) {
        diag.preCleanExcludedByMinLineSpend++;
        diag.preCleanExcludedByMinLineSpendSpend += sp;
        diag.preCleanExcludedByMinLineSpendSpendAbs += Math.abs(sp);
        continue;
      }
      up = sp / q;
      if (!isFinite(up) || up <= 0) {
        /* Defensive — by definition impossible here (sp>0 ∧ q>0), but
           bucket 2 owns this case if the floating-point divide
           produces a non-finite or non-positive up. Counts as zero-only
           since signs were both positive on entry. */
        diag.preCleanExcludedByZeroQtyOrPrice++;
        diag.preCleanExcludedByZeroQtyOrPriceSpend += sp;
        diag.preCleanExcludedByZeroQtyOrPriceSpendAbs += Math.abs(sp);
        diag.preCleanExcludedByZeroOnlyCount++;
        diag.preCleanExcludedByZeroOnlySpend += sp;
        diag.preCleanExcludedByZeroOnlySpendAbs += Math.abs(sp);
        continue;
      }
      /* Bucket 4: unit price < $0.05. */
      if (up < minUnitPriceUsd) {
        diag.preCleanExcludedByMinUnitPrice++;
        diag.preCleanExcludedByMinUnitPriceSpend += sp;
        diag.preCleanExcludedByMinUnitPriceSpendAbs += Math.abs(sp);
        continue;
      }
      diag.rowsAfterPreClean++;
      /* Key check AFTER pre-clean so a singleton/sanity-split row
         with (say) qty<=0 is correctly attributed to bucket 2 rather
         than bucket 9/10. The fate flag is stamped by the IH module's
         _idpIhBuildPrep. */
      partKey = partKeyFn(r);
      if (!partKey) {
        var fate = r._idpIhClusterFate;
        if (fate === "sanity_split") {
          diag.excludedBySanitySplitRowsCount++;
          diag.excludedBySanitySplitRowsSpend += sp;
          diag.excludedBySanitySplitRowsSpendAbs += Math.abs(sp);
        } else {
          /* Default to singleton — covers "singleton" tag explicitly
             AND any fuzzy candidate that never got a fate set
             (defensive). */
          diag.excludedAsSingletonRowsCount++;
          diag.excludedAsSingletonRowsSpend += sp;
          diag.excludedAsSingletonRowsSpendAbs += Math.abs(sp);
        }
        continue;
      }
      work.push({
        yr: yr,
        part: partKey,
        partRaw: r.part != null ? String(r.part).trim() : "",
        supplier: sup,
        site: site,
        spend: sp,
        qty: q,
        unit_price: up,
        _rawIdx: i,
        _origRow: r,
        _keyedByFuzzy: partKey.indexOf("IH#FUZZY#") === 0
      });
      if (partKey.indexOf("IH#FUZZY#") === 0) diag.rowsKeyedByFuzzy++;
      else diag.rowsKeyedByPartNum++;
    }
    if (!work.length) return { cat1Opps: [], cat2Opps: [], diagnostics: diag };
    /* Build Cat 1 groups: (key, site, supplier). Each transaction lands
       in exactly one Cat 1 group. Cat 2 groups: (key, supplier). */
    var cat1Groups = Object.create(null);
    var cat2Groups = Object.create(null);
    for (i = 0; i < work.length; i++) {
      var w = work[i];
      var k1 = w.part + "\u0001" + w.site + "\u0001" + w.supplier;
      var k2 = w.part + "\u0001" + w.supplier;
      if (!cat1Groups[k1]) cat1Groups[k1] = { key: w.part, site: w.site, supplier: w.supplier, rows: [] };
      cat1Groups[k1].rows.push(w);
      w._c1Key = k1;
      if (!cat2Groups[k2]) cat2Groups[k2] = { key: w.part, supplier: w.supplier, rows: [] };
      cat2Groups[k2].rows.push(w);
      w._c2Key = k2;
    }
    /* UoM-mismatch fingerprint detector. Splits the group's rows at
       the median quantity, computes a spend-weighted-average unit
       price for the low-qty half and the high-qty half, and returns
       true iff BOTH (a) the qty spread exceeds maxQtyRatio AND (b)
       the high-qty cohort's avg unit price is below 10% of the
       low-qty cohort's. Operates on the raw txn rows of any group
       (Cat 1 OR Cat 2) -- the fingerprint is item-level so per-site
       splits don't matter. */
    function hasQtyBandUomMismatch(grpRows) {
      if (!grpRows || grpRows.length < 2) return false;
      var qMin = Infinity, qMax = -Infinity;
      for (var qi = 0; qi < grpRows.length; qi++) {
        var qv = grpRows[qi].qty;
        if (qv < qMin) qMin = qv;
        if (qv > qMax) qMax = qv;
      }
      if (!isFinite(qMin) || qMin <= 0) return false;
      var qRatio = qMax / qMin;
      if (qRatio <= maxQtyRatio) return false;
      /* Median-split by qty. Even-length groups split in the middle;
         odd-length groups put the median row in the high-qty half so
         a singleton "high" row still has signal. */
      var sortedQ = grpRows.slice().sort(function (a, b) { return a.qty - b.qty; });
      var midIx = Math.floor(sortedQ.length / 2);
      var lowSpend = 0, lowQty = 0, highSpend = 0, highQty = 0;
      for (var si = 0; si < sortedQ.length; si++) {
        if (si < midIx) {
          lowSpend += sortedQ[si].spend;
          lowQty += sortedQ[si].qty;
        } else {
          highSpend += sortedQ[si].spend;
          highQty += sortedQ[si].qty;
        }
      }
      if (lowQty <= 0 || highQty <= 0) return false;
      var lowAvgUp = lowSpend / lowQty;
      var highAvgUp = highSpend / highQty;
      if (!isFinite(lowAvgUp) || lowAvgUp <= 0) return false;
      if (!isFinite(highAvgUp)) return false;
      return highAvgUp < 0.10 * lowAvgUp;
    }
    /* Cat 1 group eligibility — MIN_TRANSACTIONS, MIN_BENCHMARK,
       MAX_RATIO, QTY_BAND (UoM mismatch), MIN_BENCHMARK_VOLUME_SHARE.
       Cat 1 benchmark = MIN unit price across the group's
       transactions. minSavingsUsd is enforced LATER post-dedup.
       c1Fail[gk] = failure reason ("minTxn"|"minBenchmark"|"maxRatio"
       |"qtyBand"|"benchShare"|"minSavings" set later by emit) so the
       walk attribution loop can blame the right rule. */
    var c1Filt = { minTxn: 0, minBenchmark: 0, maxRatio: 0, qtyBand: 0, benchShare: 0 };
    var c1Stats = Object.create(null);
    var c1Fail = Object.create(null);
    var gk;
    for (gk in cat1Groups) {
      if (!Object.prototype.hasOwnProperty.call(cat1Groups, gk)) continue;
      diag.cat1GroupsTotal++;
      var g1 = cat1Groups[gk];
      if (g1.rows.length < minTransactions) { c1Filt.minTxn++; c1Fail[gk] = "minTxn"; continue; }
      var c1Min = Infinity, c1Max = -Infinity;
      for (var di = 0; di < g1.rows.length; di++) {
        var upi = g1.rows[di].unit_price;
        if (upi < c1Min) c1Min = upi;
        if (upi > c1Max) c1Max = upi;
      }
      if (c1Min < minBenchmarkUsd) { c1Filt.minBenchmark++; c1Fail[gk] = "minBenchmark"; continue; }
      var c1Ratio = c1Min > 0 ? (c1Max / c1Min) : Infinity;
      if (c1Ratio > maxPriceRatio) { c1Filt.maxRatio++; c1Fail[gk] = "maxRatio"; continue; }
      /* NEW: UoM-mismatch fingerprint. Two qty bands at vastly
         different unit-price bands almost always = different items
         under the same part key. */
      if (hasQtyBandUomMismatch(g1.rows)) {
        c1Filt.qtyBand++; c1Fail[gk] = "qtyBand"; continue;
      }
      /* NEW: benchmark-volume-share guard. "Benchmark cohort" =
         rows whose unit price is within 1% of c1Min (small tolerance
         absorbs floating-point quotient drift). Sum their qty; must
         be at least minBenchmarkVolumeShare of the group's total qty
         or the benchmark is anchored in a sliver of volume and not
         defensible. */
      var benchQty = 0, totalQty = 0;
      var benchCutoff = c1Min * 1.01;
      for (var bi = 0; bi < g1.rows.length; bi++) {
        var brQty = g1.rows[bi].qty;
        totalQty += brQty;
        if (g1.rows[bi].unit_price <= benchCutoff) benchQty += brQty;
      }
      if (totalQty > 0 && (benchQty / totalQty) < minBenchmarkVolumeShare) {
        c1Filt.benchShare++; c1Fail[gk] = "benchShare"; continue;
      }
      c1Stats[gk] = { minUP: c1Min, maxUP: c1Max, ratio: c1Ratio };
    }
    diag.cat1ExcludedByMinTransactions = c1Filt.minTxn;
    diag.cat1ExcludedByMinBenchmark = c1Filt.minBenchmark;
    diag.cat1ExcludedByMaxRatio = c1Filt.maxRatio;
    diag.cat1ExcludedByQtyBand = c1Filt.qtyBand;
    diag.cat1ExcludedByBenchShare = c1Filt.benchShare;
    /* Cat 2 group eligibility — MIN_TRANSACTIONS (across group), must
       span >=2 sites, build per-site volume-weighted-avg, restrict
       benchmark candidates to sites with >= cat2MinBenchmarkSiteTxns
       transactions, then MIN_BENCHMARK + MAX_RATIO. */
    /* Cat 2 group eligibility -- mirrors Cat 1 but with site-level
       benchmark. Same QTY_BAND + BENCHMARK_VOLUME_SHARE guards
       apply (the UoM-mismatch fingerprint is item-level so it's the
       same row-level check; the benchmark-volume-share check uses
       benchSite's qty / group total qty since the Cat 2 benchmark
       is per-site, not per-row).
       c2Fail[gk] is populated for the per-row walk attribution. */
    var c2Filt = {
      minTxn: 0, oneSite: 0, noEligibleSite: 0,
      minBenchmark: 0, maxRatio: 0, qtyBand: 0, benchShare: 0
    };
    var c2Stats = Object.create(null);
    var c2Fail = Object.create(null);
    for (gk in cat2Groups) {
      if (!Object.prototype.hasOwnProperty.call(cat2Groups, gk)) continue;
      diag.cat2GroupsTotal++;
      var g2 = cat2Groups[gk];
      if (g2.rows.length < minTransactions) { c2Filt.minTxn++; c2Fail[gk] = "minTxn"; continue; }
      /* Build per-site aggregates. */
      var perSite = Object.create(null);
      for (var ri = 0; ri < g2.rows.length; ri++) {
        var gr2 = g2.rows[ri];
        if (!perSite[gr2.site]) perSite[gr2.site] = { site: gr2.site, spend: 0, qty: 0, txnCount: 0 };
        perSite[gr2.site].spend += gr2.spend;
        perSite[gr2.site].qty += gr2.qty;
        perSite[gr2.site].txnCount += 1;
      }
      var siteList = [];
      var sk;
      for (sk in perSite) {
        if (!Object.prototype.hasOwnProperty.call(perSite, sk)) continue;
        var ps = perSite[sk];
        ps.avgUP = ps.qty > 0 ? ps.spend / ps.qty : Infinity;
        siteList.push(ps);
      }
      if (siteList.length < 2) { c2Filt.oneSite++; c2Fail[gk] = "oneSite"; continue; }
      /* Benchmark site must have >= cat2MinBenchmarkSiteTxns transactions
         to keep a singleton low-invoice site from becoming the
         benchmark. */
      var eligibleSites = siteList.filter(function (s) { return s.txnCount >= cat2MinBenchmarkSiteTxns; });
      if (!eligibleSites.length) { c2Filt.noEligibleSite++; c2Fail[gk] = "noEligibleSite"; continue; }
      /* Cross-site benchmark = MIN site-avg across eligible sites. */
      var benchSite = null;
      for (var ei = 0; ei < eligibleSites.length; ei++) {
        if (!benchSite || eligibleSites[ei].avgUP < benchSite.avgUP) benchSite = eligibleSites[ei];
      }
      if (!benchSite || !isFinite(benchSite.avgUP)) { c2Filt.noEligibleSite++; c2Fail[gk] = "noEligibleSite"; continue; }
      var c2Min = benchSite.avgUP;
      /* maxUP for ratio purposes = the highest per-site average, not
         the highest single transaction. */
      var c2Max = -Infinity;
      for (var mi = 0; mi < siteList.length; mi++) {
        if (siteList[mi].avgUP > c2Max) c2Max = siteList[mi].avgUP;
      }
      if (c2Min < minBenchmarkUsd) { c2Filt.minBenchmark++; c2Fail[gk] = "minBenchmark"; continue; }
      var c2Ratio = c2Min > 0 ? (c2Max / c2Min) : Infinity;
      if (c2Ratio > maxPriceRatio) { c2Filt.maxRatio++; c2Fail[gk] = "maxRatio"; continue; }
      /* NEW: UoM-mismatch fingerprint at the (Part, Supplier) level. */
      if (hasQtyBandUomMismatch(g2.rows)) {
        c2Filt.qtyBand++; c2Fail[gk] = "qtyBand"; continue;
      }
      /* NEW: benchmark-volume-share -- the benchmark site must
         contribute at least minBenchmarkVolumeShare of the group's
         total quantity. */
      var c2TotalQty = 0;
      for (var qti = 0; qti < g2.rows.length; qti++) c2TotalQty += g2.rows[qti].qty;
      var c2BenchQty = benchSite.qty;
      if (c2TotalQty > 0 && (c2BenchQty / c2TotalQty) < minBenchmarkVolumeShare) {
        c2Filt.benchShare++; c2Fail[gk] = "benchShare"; continue;
      }
      c2Stats[gk] = {
        minUP: c2Min, maxUP: c2Max, ratio: c2Ratio,
        benchSite: benchSite.site, siteAggregates: perSite,
        siteCount: siteList.length
      };
    }
    diag.cat2ExcludedByMinTransactions = c2Filt.minTxn;
    diag.cat2ExcludedByOneSite = c2Filt.oneSite;
    diag.cat2ExcludedByNoEligibleBenchmarkSite = c2Filt.noEligibleSite;
    diag.cat2ExcludedByMinBenchmark = c2Filt.minBenchmark;
    diag.cat2ExcludedByMaxRatio = c2Filt.maxRatio;
    diag.cat2ExcludedByQtyBand = c2Filt.qtyBand;
    diag.cat2ExcludedByBenchShare = c2Filt.benchShare;
    /* Per-transaction eligibility + dedup pass.
       Cat 1: up > c1Stats[c1Key].minUP   (single-invoice benchmark)
       Cat 2: row's site != benchSite AND up > c2Stats[c2Key].minUP
       Both eligible: bigger per-txn savings wins (tie → Cat 1). */
    for (i = 0; i < work.length; i++) {
      var w2 = work[i];
      var s1 = c1Stats[w2._c1Key];
      var s2 = c2Stats[w2._c2Key];
      var c1Eligible = !!s1;
      var c2Eligible = !!s2;
      var c1Sav = 0, c2Sav = 0;
      if (c1Eligible) {
        if (w2.unit_price > s1.minUP) c1Sav = (w2.unit_price - s1.minUP) * w2.qty;
        else c1Eligible = false;
      }
      if (c2Eligible) {
        if (w2.site === s2.benchSite) {
          c2Eligible = false; // benchmark site itself never contributes
        } else if (w2.unit_price > s2.minUP) {
          c2Sav = (w2.unit_price - s2.minUP) * w2.qty;
        } else {
          c2Eligible = false;
        }
      }
      if (c1Eligible && c2Eligible) {
        diag.dedupReassignmentsTotal++;
        if (c1Sav >= c2Sav) {
          w2._assignedCat = 1;
          w2._assignedSavings = c1Sav;
          diag.dedupReassignedToCat1++;
          if (c1Sav === c2Sav) diag.dedupTiesResolvedToCat1++;
        } else {
          w2._assignedCat = 2;
          w2._assignedSavings = c2Sav;
          diag.dedupReassignedToCat2++;
        }
      } else if (c1Eligible) {
        w2._assignedCat = 1;
        w2._assignedSavings = c1Sav;
      } else if (c2Eligible) {
        w2._assignedCat = 2;
        w2._assignedSavings = c2Sav;
      } else {
        w2._assignedCat = 0;
        w2._assignedSavings = 0;
      }
    }
    /* Emit Cat 1 opportunities (post-dedup totals). */
    function emitCat1Opps() {
      var out = [];
      var kk, totals = Object.create(null);
      for (i = 0; i < work.length; i++) {
        if (work[i]._assignedCat !== 1) continue;
        kk = work[i]._c1Key;
        if (!totals[kk]) totals[kk] = { sav: 0 };
        totals[kk].sav += work[i]._assignedSavings;
      }
      for (kk in cat1Groups) {
        if (!Object.prototype.hasOwnProperty.call(cat1Groups, kk)) continue;
        var stat = c1Stats[kk];
        if (!stat) continue;
        var g = cat1Groups[kk];
        var grpTotal = totals[kk] ? totals[kk].sav : 0;
        if (grpTotal < minSavingsUsd) { diag.cat1ExcludedByMinSavings++; c1Fail[kk] = "minSavings"; continue; }
        var benchmark = stat.minUP;
        var sortedRows = g.rows.slice().sort(function (a, b) { return b.unit_price - a.unit_price; });
        var supRows = [];
        var exportRows = [];
        var totalSpend = 0, totalQty = 0;
        var ti;
        for (ti = 0; ti < sortedRows.length; ti++) {
          var gr = sortedRows[ti];
          totalSpend += gr.spend;
          totalQty += gr.qty;
          var rowSav = (gr._assignedCat === 1) ? gr._assignedSavings : 0;
          var trancheLabel = "Tranche #" + (ti + 1);
          supRows.push({
            supplier: g.supplier,
            site: g.site,
            unit_price: roundUsd(gr.unit_price),
            quantity: roundUsd(gr.qty),
            spend: roundUsd(gr.spend),
            label: trancheLabel,
            _assignedCat: gr._assignedCat || 0,
            _rowSavings: roundUsd(rowSav)
          });
          exportRows.push({
            "Item Number": g.key,
            "Site": g.site,
            "Supplier": g.supplier,
            "Tranche": trancheLabel,
            "Quantity": gr.qty,
            "Unit Price": roundUsd(gr.unit_price),
            "Spend": roundUsd(gr.spend),
            "Savings": roundUsd(rowSav),
            "Category": "Same Supplier, Same Site - Single-Invoice Rightsizing",
            "Confidence": "high"
          });
        }
        var labels = supRows.map(function (s) { return s.label; });
        var unitPrices = supRows.map(function (s) { return s.unit_price; });
        var barColors = supRows.map(function () { return BAR_BLUE; });
        out.push({
          item: g.key,
          part: g.key,
          harm_mece: 4,
          confidence: "high",
          total_spend: roundUsd(totalSpend),
          total_quantity: roundUsd(totalQty),
          savings: roundUsd(grpTotal),
          savings_subtitle: formatNotePctBelow(benchmark, stat.maxUP)[1] || "",
          suppliers: supRows,
          supplier_count: 1,
          site_count: 1,
          benchmark: benchmark,
          chart: { labels: labels, unit_prices: unitPrices, bar_colors: barColors, y_axis_label: "Unit price ($/unit)" },
          export_rows: exportRows,
          analysis_year: target_year,
          year: target_year,
          bar_label_field: "label",
          _keyedByFuzzy: g.key.indexOf("IH#FUZZY#") === 0,
          _c1Key: kk
        });
      }
      return out;
    }
    /* Emit Cat 2 opportunities. Bars = per-site volume-weighted avg.
       Drill-down rows are per-site (each site = one row). */
    function emitCat2Opps() {
      var out = [];
      var kk, totals = Object.create(null);
      for (i = 0; i < work.length; i++) {
        if (work[i]._assignedCat !== 2) continue;
        kk = work[i]._c2Key;
        if (!totals[kk]) totals[kk] = { sav: 0, perSiteSav: Object.create(null) };
        totals[kk].sav += work[i]._assignedSavings;
        var sname = work[i].site;
        if (!totals[kk].perSiteSav[sname]) totals[kk].perSiteSav[sname] = 0;
        totals[kk].perSiteSav[sname] += work[i]._assignedSavings;
      }
      for (kk in cat2Groups) {
        if (!Object.prototype.hasOwnProperty.call(cat2Groups, kk)) continue;
        var stat = c2Stats[kk];
        if (!stat) continue;
        var g = cat2Groups[kk];
        var grpTotal = totals[kk] ? totals[kk].sav : 0;
        if (grpTotal < minSavingsUsd) { diag.cat2ExcludedByMinSavings++; continue; }
        var benchmark = stat.minUP;
        var perSite = stat.siteAggregates;
        var perSiteSav = totals[kk] ? totals[kk].perSiteSav : Object.create(null);
        var siteRows = [];
        var sk2;
        for (sk2 in perSite) {
          if (!Object.prototype.hasOwnProperty.call(perSite, sk2)) continue;
          var sr = perSite[sk2];
          siteRows.push({
            site: sr.site,
            spend: sr.spend,
            qty: sr.qty,
            txnCount: sr.txnCount,
            unit_price: sr.avgUP,
            assignedSav: perSiteSav[sr.site] || 0,
            _isBenchmark: sr.site === stat.benchSite
          });
        }
        siteRows.sort(function (a, b) { return b.unit_price - a.unit_price; });
        var supRows = [];
        var exportRows = [];
        var totalSpend = 0, totalQty = 0;
        for (var ti = 0; ti < siteRows.length; ti++) {
          var sr2 = siteRows[ti];
          totalSpend += sr2.spend;
          totalQty += sr2.qty;
          supRows.push({
            supplier: g.supplier,
            site: sr2.site,
            unit_price: roundUsd(sr2.unit_price),
            quantity: roundUsd(sr2.qty),
            spend: roundUsd(sr2.spend),
            txn_count: sr2.txnCount,
            _rowSavings: roundUsd(sr2.assignedSav),
            _isBenchmark: !!sr2._isBenchmark
          });
          exportRows.push({
            "Item Number": g.key,
            "Site": sr2.site,
            "Supplier": g.supplier,
            "Site Txn Count": sr2.txnCount,
            "Quantity": sr2.qty,
            "Site Volume-Weighted Avg Unit Price": roundUsd(sr2.unit_price),
            "Spend": roundUsd(sr2.spend),
            "Savings": roundUsd(sr2.assignedSav),
            "Is Benchmark Site": sr2._isBenchmark ? "yes" : "no",
            "Category": "Same Supplier, Different Sites - Cross-Site Rightsizing",
            "Confidence": "medium"
          });
        }
        var labels = supRows.map(function (s) { return String(s.site || "—"); });
        var unitPrices = supRows.map(function (s) { return s.unit_price; });
        var barColors = supRows.map(function () { return BAR_BLUE; });
        out.push({
          item: g.key,
          part: g.key,
          harm_mece: 5,
          confidence: "medium",
          total_spend: roundUsd(totalSpend),
          total_quantity: roundUsd(totalQty),
          savings: roundUsd(grpTotal),
          savings_subtitle: formatNotePctBelow(benchmark, stat.maxUP)[1] || "",
          suppliers: supRows,
          supplier_count: 1,
          site_count: stat.siteCount,
          benchmark: benchmark,
          benchmark_site: stat.benchSite,
          chart: { labels: labels, unit_prices: unitPrices, bar_colors: barColors, y_axis_label: "Unit price ($/unit)" },
          export_rows: exportRows,
          analysis_year: target_year,
          year: target_year,
          _keyedByFuzzy: g.key.indexOf("IH#FUZZY#") === 0,
          _c2Key: kk
        });
      }
      return out;
    }
    var cat1Opps = emitCat1Opps();
    var cat2Opps = emitCat2Opps();
    cat1Opps.sort(function (a, b) { return (+b.savings || 0) - (+a.savings || 0); });
    if (cat1Opps.length > maxOppsPerPlay) {
      diag.cat1ExcludedDroppedByMaxOpps = cat1Opps.length - maxOppsPerPlay;
      cat1Opps = cat1Opps.slice(0, maxOppsPerPlay);
    }
    cat2Opps.sort(function (a, b) { return (+b.savings || 0) - (+a.savings || 0); });
    if (cat2Opps.length > maxOppsPerPlay) {
      diag.cat2ExcludedDroppedByMaxOpps = cat2Opps.length - maxOppsPerPlay;
      cat2Opps = cat2Opps.slice(0, maxOppsPerPlay);
    }
    diag.cat1GroupsKept = cat1Opps.length;
    diag.cat2GroupsKept = cat2Opps.length;
    diag.cat1TotalSavings = cat1Opps.reduce(function (s, p) { return s + (+p.savings || 0); }, 0);
    diag.cat2TotalSavings = cat2Opps.reduce(function (s, p) { return s + (+p.savings || 0); }, 0);
    /* Walk attribution pass — per-row, post-emit. A row is "analyzed"
       iff its Cat 1 group OR its Cat 2 group emitted an opportunity
       (each group's total_spend includes ALL its rows, dedup or not).
       Otherwise we attribute to Cat 1's failure reason in the
       user-spec display order (minTxn → minSavings → minBenchmark →
       maxRatio). Cat 1 always has a group; if c1Fail[k] is missing
       the row's Cat 1 group must have been kept (so c1Kept catches
       it); we never fall through to the safety net in practice. */
    var c1Kept = Object.create(null);
    var c2Kept = Object.create(null);
    var oi;
    for (oi = 0; oi < cat1Opps.length; oi++) {
      if (cat1Opps[oi] && cat1Opps[oi]._c1Key) c1Kept[cat1Opps[oi]._c1Key] = 1;
    }
    for (oi = 0; oi < cat2Opps.length; oi++) {
      if (cat2Opps[oi] && cat2Opps[oi]._c2Key) c2Kept[cat2Opps[oi]._c2Key] = 1;
    }
    var wi, wr, failReason;
    for (wi = 0; wi < work.length; wi++) {
      wr = work[wi];
      if (c1Kept[wr._c1Key] || c2Kept[wr._c2Key]) {
        diag.analyzedRowsCount++;
        diag.analyzedRowsSpend += wr.spend;
        continue;
      }
      /* Walk attribution: a row is attributed to whichever rule
         excluded it, choosing the MOST RESTRICTIVE pass-of-blame
         between its Cat 1 group and its Cat 2 group. We resolve in
         the user-spec display order (minTxn -> minSavings ->
         minBenchmark -> maxRatio -> qtyBand -> benchShare); since
         every row has exactly one Cat 1 group and (at most) one
         Cat 2 group, we prefer the Cat 1 failure reason when both
         fail (Cat 1 is the higher-confidence side) and only fall
         through to Cat 2 when the Cat 1 group failed for a
         display-rank-equal-or-later reason but Cat 2 caught it
         earlier in the rank. Practically: if c1Fail provides a
         reason we trust it; only walk back to c2Fail when c1Fail
         is the catch-all minSavings (which is the broadest bucket)
         and c2Fail has a more specific qty-band/bench-share guard
         finding. */
      var fr1 = c1Fail[wr._c1Key];
      var fr2 = c2Fail[wr._c2Key];
      failReason = fr1;
      if ((!fr1 || fr1 === "minSavings") && (fr2 === "qtyBand" || fr2 === "benchShare")) failReason = fr2;
      var wrAbs = Math.abs(wr.spend);
      if (failReason === "minTxn") {
        diag.groupExcludedByMinTransactionsRowsCount++;
        diag.groupExcludedByMinTransactionsRowsSpend += wr.spend;
        diag.groupExcludedByMinTransactionsRowsSpendAbs += wrAbs;
      } else if (failReason === "minSavings") {
        diag.groupExcludedByMinSavingsRowsCount++;
        diag.groupExcludedByMinSavingsRowsSpend += wr.spend;
        diag.groupExcludedByMinSavingsRowsSpendAbs += wrAbs;
      } else if (failReason === "minBenchmark") {
        diag.groupExcludedByMinBenchmarkRowsCount++;
        diag.groupExcludedByMinBenchmarkRowsSpend += wr.spend;
        diag.groupExcludedByMinBenchmarkRowsSpendAbs += wrAbs;
      } else if (failReason === "maxRatio") {
        diag.groupExcludedByMaxRatioRowsCount++;
        diag.groupExcludedByMaxRatioRowsSpend += wr.spend;
        diag.groupExcludedByMaxRatioRowsSpendAbs += wrAbs;
      } else if (failReason === "qtyBand") {
        diag.groupExcludedByQtyBandRowsCount++;
        diag.groupExcludedByQtyBandRowsSpend += wr.spend;
        diag.groupExcludedByQtyBandRowsSpendAbs += wrAbs;
      } else if (failReason === "benchShare") {
        diag.groupExcludedByBenchShareRowsCount++;
        diag.groupExcludedByBenchShareRowsSpend += wr.spend;
        diag.groupExcludedByBenchShareRowsSpendAbs += wrAbs;
      } else {
        /* Safety net — should be unreachable in practice. */
        diag.groupExcludedByMinSavingsRowsCount++;
        diag.groupExcludedByMinSavingsRowsSpend += wr.spend;
        diag.groupExcludedByMinSavingsRowsSpendAbs += wrAbs;
      }
    }
    diag.cat1Top5 = cat1Opps.slice(0, 5).map(function (p) {
      return {
        item: p.item,
        site: p.suppliers && p.suppliers[0] ? p.suppliers[0].site : "",
        supplier: p.suppliers && p.suppliers[0] ? p.suppliers[0].supplier : "",
        savings: +p.savings || 0,
        total_spend: p.total_spend,
        benchmark: p.benchmark
      };
    });
    diag.cat2Top5 = cat2Opps.slice(0, 5).map(function (p) {
      return {
        item: p.item,
        site_count: p.site_count,
        supplier: p.suppliers && p.suppliers[0] ? p.suppliers[0].supplier : "",
        savings: +p.savings || 0,
        total_spend: p.total_spend,
        benchmark: p.benchmark,
        benchmark_site: p.benchmark_site
      };
    });
    return { cat1Opps: cat1Opps, cat2Opps: cat2Opps, diagnostics: diag };
  }

  global.idpCalculateHarmonizationFromRows = calculateFromRows;
  global.idpComputeIndirectHarmFromRows = computeIndirectHarmFromRows;
  global.idpHarmonizationItemKey = harmonizationItemKey;
  global.idpIndirectHarmDefaults = {
    DUMMY_WORDS: INDIRECT_HARM_DUMMY_WORDS_DEFAULT
  };
  global.idpHarmonizationLimits = {
    maxClientInputRows: MAX_CLIENT_HARM_INPUT_ROWS,
    maxAllOpportunityCards: MAX_ALL_OPPORTUNITY_CARDS,
    computeBudgetMs: HARM_COMPUTE_BUDGET_MS,
  };
})(typeof window !== "undefined" ? window : this);
