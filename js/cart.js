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
 * Slice B builds the FAB/badge/drawer/scrim/toast UI (injected via
 * createElement — CSP script-src 'self' forbids inline handlers), the
 * cross-tab storage sync and the responsive styles on top of this core.
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
    if (ui) {
      refreshAll();
      showToast('Agregado ✓');
    }
  }

  /** Remove a product line entirely (used by the drawer − control at qty 1). */
  function remove(id) {
    if (id == null) return;
    id = String(id);
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) {
        items.splice(i, 1);
        save();
        if (ui) refreshAll();
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
    if (ui) refreshAll();
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
    if (ui) refreshAll();
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
    // FIX-2: stock may have changed since the last save — refresh the UI now
    // so the drawer and send path never use a stale in_stock flag.
    if (ui) refreshAll();
  }

  // ---- Slice B: FAB / drawer / scrim / toast UI -------------------------------

  // UI shell state. Stays null until injectUI() runs (and while the script
  // executes outside a browser, e.g. node --check or the behavior harness).
  var ui = null;
  var toastTimer = null;

  var DOM_AVAILABLE = typeof document !== 'undefined' &&
    document.body && typeof document.createElement === 'function';

  /** WhatsApp deep link for the consolidated cart message. */
  function waUrl() {
    return 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(buildMessage());
  }

  /** createElement shortcut. */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** Build the UI shell — FAB + badge, scrim, drawer, toast — via
   *  createElement + addEventListener only (CSP forbids inline handlers). */
  function injectUI() {
    if (ui) return;

    var fab = el('button', 'cart-fab');
    fab.type = 'button';
    fab.id = 'cartFab';
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.setAttribute('aria-controls', 'cartDrawer');
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-label', 'Abrir carrito');
    var icon = el('i', 'fas fa-shopping-cart');
    icon.setAttribute('aria-hidden', 'true');
    var badge = el('span', 'cart-badge');
    badge.id = 'cartBadge';
    badge.setAttribute('aria-hidden', 'true');
    fab.appendChild(icon);
    fab.appendChild(badge);

    var scrim = el('div', 'cart-scrim');
    scrim.id = 'cartScrim';
    scrim.setAttribute('aria-hidden', 'true');

    var drawer = el('aside', 'cart-drawer');
    drawer.id = 'cartDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-labelledby', 'cartDrawerTitle');
    drawer.setAttribute('aria-hidden', 'true');

    var header = el('div', 'cart-drawer-header');
    var title = el('h2', null, 'Carrito');
    title.id = 'cartDrawerTitle';
    var closeBtn = el('button', 'cart-close', '\u00d7');
    closeBtn.type = 'button';
    closeBtn.id = 'cartClose';
    closeBtn.setAttribute('aria-label', 'Cerrar carrito');
    header.appendChild(title);
    header.appendChild(closeBtn);

    var itemsEl = el('div', 'cart-items');
    itemsEl.id = 'cartItems';
    var emptyEl = el('div', 'cart-empty', 'Tu carrito está vacío');
    emptyEl.id = 'cartEmpty';
    var footerEl = el('div', 'cart-footer');
    footerEl.id = 'cartFooter';
    drawer.appendChild(header);
    drawer.appendChild(itemsEl);
    drawer.appendChild(emptyEl);
    drawer.appendChild(footerEl);

    var toast = el('div', 'cart-toast');
    toast.id = 'cartToast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    document.body.appendChild(scrim);
    document.body.appendChild(drawer);
    document.body.appendChild(toast);
    document.body.appendChild(fab);

    ui = {
      fab: fab, badge: badge, scrim: scrim, drawer: drawer,
      itemsEl: itemsEl, emptyEl: emptyEl, footerEl: footerEl,
      closeBtn: closeBtn, toast: toast,
      vaciar: null, enviar: null,
      controls: [], focusables: [], open: false
    };

    fab.addEventListener('click', openDrawer);
    closeBtn.addEventListener('click', closeDrawer);
    scrim.addEventListener('click', closeDrawer);
    drawer.addEventListener('click', onDrawerClick);
    document.addEventListener('keydown', onDocumentKeydown);

    refreshAll();
  }

  /** Badge count + drawer re-render (drawer only while open — its content is
   *  rebuilt on every open anyway). */
  function refreshAll() {
    if (!ui) return;
    var count = getCount();
    ui.badge.classList.toggle('off', count === 0);
    ui.badge.textContent = count > 99 ? '99+' : String(count);
    if (ui.open) renderDrawerContent();
  }

  function renderDrawerContent() {
    renderFooter();
    renderItems();
  }

  /** One line per item. In-stock lines get − qty + controls; lines flagged
   *  "sin stock" by reconcile() are non-interactive (no controls). */
  function renderItems() {
    var wrap = ui.itemsEl;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    ui.controls = [];
    var focusables = [ui.closeBtn];

    if (items.length) {
      ui.emptyEl.classList.remove('show');
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var row = el('div', 'cart-item');
        row.setAttribute('data-id', it.id);
        var info = el('div', 'cart-item-info');
        info.appendChild(el('span', 'cart-item-name', it.name || it.id));
        if (!it.in_stock) {
          info.appendChild(el('em', 'cart-item-oos', 'Sin stock'));
        }
        row.appendChild(info);
        if (it.in_stock) {
          var ctl = el('div', 'cart-item-controls');
          var minus = el('button', 'cart-qty-minus', '\u2212');
          minus.type = 'button';
          minus.setAttribute('data-id', it.id);
          minus.setAttribute('aria-label', 'Quitar una unidad de ' + (it.name || it.id));
          var qty = el('span', 'cart-qty', String(it.qty));
          var plus = el('button', 'cart-qty-plus', '+');
          plus.type = 'button';
          plus.setAttribute('data-id', it.id);
          plus.setAttribute('aria-label', 'Agregar una unidad de ' + (it.name || it.id));
          ctl.appendChild(minus);
          ctl.appendChild(qty);
          ctl.appendChild(plus);
          row.appendChild(ctl);
          ui.controls.push(minus, plus);
        }
        wrap.appendChild(row);
      }
    } else {
      ui.emptyEl.classList.add('show');
    }

    // Tab order: close → item controls → Vaciar → Pedir (anchor only).
    var tail = [];
    if (ui.vaciar) tail.push(ui.vaciar);
    if (ui.enviar && ui.enviar.tagName === 'A') tail.push(ui.enviar);
    ui.focusables = focusables.concat(ui.controls, tail);
  }

  /** Footer: Vaciar (always) + Pedir anchor (items) or disabled span (empty,
   *  mirrors the .btn-pedir.disabled pattern from catalog.js). */
  function renderFooter() {
    if (!ui.vaciar) {
      var vaciar = el('button', 'btn-pedir', 'Vaciar');
      vaciar.type = 'button';
      vaciar.id = 'cartVaciar';
      ui.footerEl.appendChild(vaciar);
      ui.vaciar = vaciar;
    }
    var enviar;
    if (items.length) {
      enviar = el('a', 'btn-pedir cart-send', 'Pedir');
      enviar.id = 'cartEnviar';
      enviar.setAttribute('target', '_blank');
      enviar.setAttribute('rel', 'noopener noreferrer');
      enviar.setAttribute('href', waUrl());
      enviar.addEventListener('click', onEnviarClick);
    } else {
      enviar = el('span', 'btn-pedir disabled', 'Pedir');
      enviar.id = 'cartEnviar';
      enviar.setAttribute('aria-disabled', 'true');
      enviar.setAttribute('tabindex', '-1');
    }
    if (ui.enviar && ui.enviar.parentNode) ui.enviar.parentNode.removeChild(ui.enviar);
    ui.footerEl.appendChild(enviar);
    ui.enviar = enviar;
  }

  /** Container delegation for drawer controls (survives re-renders). */
  function onDrawerClick(e) {
    var minus = e.target.closest ? e.target.closest('.cart-qty-minus') : null;
    var plus = e.target.closest ? e.target.closest('.cart-qty-plus') : null;
    if (e.target.closest && e.target.closest('#cartVaciar')) {
      e.preventDefault();
      clear();
      return;
    }
    if (!minus && !plus) return;
    e.preventDefault();
    var id = (minus || plus).getAttribute('data-id');
    var item = findItem(id);
    if (plus) {
      setQty(id, (item ? item.qty : 1) + 1); // capped at 99 by clampQty
      refocusControl('cart-qty-plus', id);
    } else {
      setQty(id, (item ? item.qty : 1) - 1); // qty 1 → 0 → remove
      if (findItem(id)) {
        refocusControl('cart-qty-minus', id);
      } else {
        // Line removed: move focus to the first remaining control or Vaciar.
        var next = ui.controls.length ? ui.controls[0] : ui.vaciar;
        if (next) next.focus();
      }
    }
  }

  /** Keep focus on the same ± control after its re-render. */
  function refocusControl(cls, id) {
    for (var i = 0; i < ui.controls.length; i++) {
      if (ui.controls[i].className === cls &&
          ui.controls[i].getAttribute('data-id') === id) {
        ui.controls[i].focus();
        return;
      }
    }
  }

  function openDrawer() {
    if (!ui || ui.open) return;
    ui.open = true;
    ui.drawer.classList.add('open');
    ui.scrim.classList.add('open');
    ui.fab.setAttribute('aria-expanded', 'true');
    ui.drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('cart-lock');
    renderDrawerContent();
    if (ui.focusables.length) ui.focusables[0].focus();
  }

  function closeDrawer() {
    if (!ui || !ui.open) return;
    ui.open = false;
    ui.drawer.classList.remove('open');
    ui.scrim.classList.remove('open');
    ui.fab.setAttribute('aria-expanded', 'false');
    ui.drawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('cart-lock');
    ui.fab.focus();
  }

  /** ESC closes the drawer; Tab is trapped inside it (a11y, SC-06). */
  function onDocumentKeydown(e) {
    if (!ui || !ui.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDrawer();
      return;
    }
    if (e.key !== 'Tab' || !ui.focusables.length) return;
    var active = document.activeElement;
    var first = ui.focusables[0];
    var last = ui.focusables[ui.focusables.length - 1];
    if (e.shiftKey) {
      if (active === first || !ui.drawer.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !ui.drawer.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  /** Toast feedback (role="status" announces adds; global reduced-motion CSS
   *  makes the transition instant). */
  function showToast(msg) {
    if (!ui) return;
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.classList.remove('show'); }, 2400);
  }

  /** Send: refresh the URL from the current (just-reconciled) state so a
   *  stale in_stock flag is never sent (FIX-2), then clear after the anchor's
   *  new-tab navigation has been initiated (clear-on-send). */
  function onEnviarClick() {
    if (ui && ui.enviar) ui.enviar.setAttribute('href', waUrl());
    setTimeout(function () { clear(); }, 0);
  }

  /** Cross-tab sync (SC-05): another tab wrote the cart → re-read and
   *  re-render badge/drawer so every open tab stays consistent. */
  function syncFromStorage(e) {
    if (!e || e.key !== STORAGE_KEY) return;
    items = load();
    refreshAll();
    showToast('Carrito actualizado');
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

  // ---- boot -------------------------------------------------------------------

  // Inject the UI shell (script runs at the end of body, so the DOM is ready).
  if (DOM_AVAILABLE) {
    injectUI();
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('storage', syncFromStorage);
  }
})();
