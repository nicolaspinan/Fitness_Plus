/**
 * cart.js — public WhatsApp shopping cart for Fitness Plus.
 *
 * Change: web-shopping-cart · Slice A (cart core).
 *
 * Loaded on index.html, categoria.html, producto.html and 404.html AFTER
 * js/catalog.js and BEFORE js/main.js:
 *
 *     site-config → supabase → catalog → cart → main
 *
 * Owns the localStorage cart under key `fitnessplus_cart` (shape
 * { items: [{id, qty, name}], updatedAt }) and exposes the window.FPCart
 * API consumed by catalog.js (.btn-cart buttons). `in_stock` is an additive
 * reconciliation hint on each line (superset of the spec's minimal shape):
 * set to true at add time, refreshed by reconcile() from the live catalog.
 *
 * Slice B (pending) builds the FAB/badge/drawer/scrim/toast UI, cross-tab
 * storage sync and responsive CSS on top of this core.
 *
 * Vanilla JS (ES5), zero dependencies, no build step. No test runner —
 * verified with node --check plus the manual browser checklist from sdd-verify.
 */
(function () {
  'use strict';

  // ---- constants ------------------------------------------------------------

  var STORAGE_KEY = 'fitnessplus_cart';
  var WHATSAPP_NUMBER = '543518682837'; // duplicates catalog.js WHATSAPP_NUMBER

  var MIN_QTY = 1;
  var MAX_QTY = 99;

  // ---- state -----------------------------------------------------------------

  // Internal cart lines: { id, qty, name, in_stock }.
  var items = load();

  // ---- small helpers ----------------------------------------------------------

  /** Clamp any value to an integer within MIN_QTY..MAX_QTY. NaN, 0 or
   *  negatives yield 0 so callers can drop invalid lines. */
  function clampQty(qty) {
    var n = Math.floor(Number(qty));
    if (isNaN(n) || n < MIN_QTY) return 0;
    return n > MAX_QTY ? MAX_QTY : n;
  }

  function findItem(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  /** Persist the cart. Storage failures must never break the shopping flow —
   *  the cart keeps working in memory (mirrors supabase.js saveSession). */
  function save() {
    var data = {
      items: items,
      updatedAt: new Date().toISOString()
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      // keep in memory only
    }
  }

  /** Restore the cart from localStorage (SC-01). Validates the shape,
   *  clamps quantities and drops malformed lines so a corrupted stored
   *  value is tolerated. */
  function load() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return [];
    }
    if (!raw) return [];
    try {
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return [];
      var list = [];
      for (var i = 0; i < data.items.length; i++) {
        var it = data.items[i];
        if (!it || it.id == null) continue;
        var qty = clampQty(it.qty);
        if (qty < MIN_QTY) continue; // malformed or empty line → drop
        list.push({
          id: String(it.id),
          qty: qty,
          name: (it.name == null) ? '' : String(it.name),
          in_stock: it.in_stock !== false
        });
      }
      return list;
    } catch (e) {
      return [];
    }
  }

  // ---- API ---------------------------------------------------------------------

  /** Add a product (qty 1) or increment it when already in the cart (SC-02).
   *  Snapshots the product name at add time; reconcile() later replaces it
   *  with the catalog name when they differ (SC-01). */
  function add(id, name) {
    if (id == null) return;
    id = String(id);
    var item = findItem(id);
    if (item) {
      item.qty = Math.min(item.qty + 1, MAX_QTY);
    } else {
      items.push({
        id: id,
        qty: MIN_QTY,
        name: (name == null) ? '' : String(name),
        in_stock: true
      });
    }
    save();
  }

  /** Remove a product line entirely (used by the drawer − control at qty 1). */
  function remove(id) {
    if (id == null) return;
    id = String(id);
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) {
        items.splice(i, 1);
        save();
        return;
      }
    }
  }

  /** Set the quantity of a line. qty < 1 removes the line (decrement at 1);
   *  setQty(id, 1) on a missing id behaves like add() so the drawer can
   *  rebuild a line from the id alone (name fixed later by reconcile);
   *  existing lines are set exactly and capped at MAX_QTY. */
  function setQty(id, qty) {
    if (id == null) return;
    id = String(id);
    var n = clampQty(qty);
    if (n < MIN_QTY) {
      remove(id);
      return;
    }
    var item = findItem(id);
    if (!item) {
      add(id, '');
      return;
    }
    item.qty = n;
    save();
  }

  /** Snapshot of the current lines (safe for callers to read). */
  function getItems() {
    return items.slice();
  }

  /** Total quantity across all lines (the FAB badge count, SC-06). */
  function getCount() {
    var total = 0;
    for (var i = 0; i < items.length; i++) total += items[i].qty;
    return total;
  }

  /** Empty the cart. */
  function clear() {
    if (!items.length) return;
    items = [];
    save();
  }

  /** Consolidated WhatsApp message (SC-03): header line plus one '• Nx NAME'
   *  bullet per in-stock item — no prices, totals or grammatical articles.
   *  When every line is out of stock the message contains only the header
   *  and sending still proceeds. */
  function buildMessage() {
    var lines = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].in_stock) {
        lines.push('• ' + items[i].qty + 'x ' + items[i].name);
      }
    }
    var header = 'Hola, quiero comprar:';
    return lines.length ? header + '\n' + lines.join('\n') : header;
  }

  /** Reconcile stored lines against the live catalog (SC-01): replace stored
   *  names with catalog names and flag unknown/out-of-stock products so they
   *  are shown as "sin stock" and excluded from the message. Called by
   *  catalog.js once products are loaded. */
  function reconcile(products) {
    var byId = {};
    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      byId[String(p.id)] = {
        name: (p.name == null) ? '' : String(p.name),
        in_stock: !!p.in_stock
      };
    }
    var changed = false;
    for (var j = 0; j < items.length; j++) {
      var info = byId[items[j].id];
      if (info) {
        if (items[j].name !== info.name) {
          items[j].name = info.name;
          changed = true;
        }
        if (items[j].in_stock !== info.in_stock) {
          items[j].in_stock = info.in_stock;
          changed = true;
        }
      } else if (items[j].in_stock !== false) {
        items[j].in_stock = false; // unknown id → not available
        changed = true;
      }
    }
    if (changed) save();
  }

  // ---- exports -----------------------------------------------------------------

  window.FPCart = {
    add: add,
    remove: remove,
    setQty: setQty,
    getItems: getItems,
    getCount: getCount,
    clear: clear,
    buildMessage: buildMessage,
    reconcile: reconcile
  };
})();
