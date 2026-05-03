/**
 * Browser-side harmonization (Category 1 & 3) aligned with harmonization.py — same MECE rules.
 * Used when splitting Direct vs Indirect from flat rows without changing the Python pipeline.
 */
(function (global) {
  "use strict";
  var VARIANCE_PCT = 0.02;
  var TOP_N = 5;
  var JSON_VERSION = 2;
  /** Same as harmonization.py — skip MECE slices whose unit-price span exceeds this (USD). */
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
      lim;
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
    lim = maxRows === undefined ? TOP_N : maxRows === null ? Infinity : maxRows;
    var out = [];
    for (pi = 0; pi < pairs.length && out.length < lim; pi++) {
      if (!(pairs[pi].sav >= MIN_TOP5_SAVINGS_USD)) continue;
      it_s = String(pairs[pi].item).trim();
      st_s = String(pairs[pi].site).trim();
      pk = it_s;
      bpart = base.filter(function (row2) {
        return String(row2.item).trim() === it_s && String(row2.site).trim() === st_s;
      });
      var supU = {};
      for (i = 0; i < bpart.length; i++) supU[bpart[i].supplier] = 1;
      var nsup = 0;
      for (k in supU) nsup++;
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
      lim;
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
    lim = maxRows === undefined ? TOP_N : maxRows === null ? Infinity : maxRows;
    var out = [];
    for (pi = 0; pi < pairs.length && out.length < lim; pi++) {
      if (!(pairs[pi].sav >= MIN_TOP5_SAVINGS_USD)) continue;
      it_s = String(pairs[pi].item).trim();
      sup_s = String(pairs[pi].supplier).trim();
      pk = it_s;
      bpart = base.filter(function (row2) {
        return String(row2.item).trim() === it_s && String(row2.supplier).trim() === sup_s;
      });
      var siteU = {};
      for (i = 0; i < bpart.length; i++) siteU[bpart[i].site] = 1;
      var nsite = 0;
      for (k in siteU) nsite++;
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
    var allCat1 = top5Cat1(tagged, base, null);
    var allCat3 = top5Cat3(tagged, base, null);
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

  global.idpCalculateHarmonizationFromRows = calculateFromRows;
  global.idpHarmonizationItemKey = harmonizationItemKey;
})(typeof window !== "undefined" ? window : this);
