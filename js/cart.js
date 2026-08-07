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
 * { items: [{id, qty, name, price, in_stock}], updatedAt }) and exposes
 * the window.FPCart API consumed by catalog.js (.btn-cart buttons).
 * `price` is the effective unit price (offer_price ?? price) snapshotted at
 * add time and refreshed by reconcile() from the live catalog; `in_stock`
 * is an additive reconciliation hint set to true at add time and refreshed
 * by reconcile() as well. Both `price` and `in_stock` are supersets of the
 * spec's minimal shape, kept so the drawer and WhatsApp message can show
 * line subtotals and a grand total.
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

  // Internal cart lines: { id, qty, name, price, in_stock }.
  // `price` is the effective unit price (offer_price ?? price) snapshotted
  // at add time and refreshed by reconcile() from the live catalog.
  var items = load();

  // ---- small helpers ----------------------------------------------------------

  /** Format an integer as AR-style pesos: thousands separated by a period.
   *  Duplicates catalog.js `formatPrice` verbatim (ES5) so the drawer and
   *  the WhatsApp message render prices without depending on catalog.js
   *  being loaded. Not exported. */
  function formatPrice(n) {
    return Number(n).toLocaleString('es-AR');
  }

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

  /** Effective unit price for a catalog product: offer_price when set (not
   *  null), otherwise the regular price. Use `!= null` rather than `||` so
   *  a legitimate offer_price of 0 would still win — today offer_price is
   *  either null or a positive integer, but the explicit check is safer.
   *  Returns an integer (0 when neither field is present). */
  function effectivePrice(p) {
    if (p && p.offer_price != null) return Math.floor(Number(p.offer_price)) || 0;
    if (p && p.price != null) return Math.floor(Number(p.price)) || 0;
    return 0;
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
        var price = Math.floor(Number(it.price));
        if (isNaN(price) || price < 0) price = 0; // missing/invalid → 0 (reconcile fixes it)
        list.push({
          id: String(it.id),
          qty: qty,
          name: (it.name == null) ? '' : String(it.name),
          price: price,
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
   *  Snapshots the product name and effective unit price at add time; the
   *  price is overwritten later by reconcile() with the live catalog price
   *  when it differs (SC-01). `price` is optional — older callers that pass
   *  only (id, name) get price 0, fixed on the next reconcile() pass. */
  function add(id, name, price) {
    if (id == null) return;
    id = String(id);
    var item = findItem(id);
    if (item) {
      item.qty = Math.min(item.qty + 1, MAX_QTY);
    } else {
      var unit = (price == null) ? 0 : (Math.floor(Number(price)) || 0);
      if (unit < 0) unit = 0;
      items.push({
        id: id,
        qty: MIN_QTY,
        name: (name == null) ? '' : String(name),
        price: unit,
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

  /** Consolidated WhatsApp message (SC-03): header line, one '• Nx NAME —
   *  $SUBTOTAL (u. $UNIT)' bullet per in-stock item with its subtotal
   *  (qty × effective unit price) and unit price, and a final 'Total: $SUM'
   *  line that sums the subtotals of every in-stock line. Out-of-stock lines
   *  are excluded from both the bullets and the total. When every line is
   *  out of stock the message contains only the header and sending still
   *  proceeds. */
  function buildMessage() {
    var lines = [];
    var total = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].in_stock) {
        var unit = items[i].price || 0;
        var subtotal = unit * items[i].qty;
        total += subtotal;
        lines.push(
          '\u2022 ' + items[i].qty + 'x ' + items[i].name +
          ' \u2014 $' + formatPrice(subtotal) +
          ' (u. $' + formatPrice(unit) + ')'
        );
      }
    }
    var header = 'Hola, quiero comprar:';
    if (!lines.length) return header;
    return header + '\n' + lines.join('\n') + '\nTotal: $' + formatPrice(total);
  }

  /** Reconcile stored lines against the live catalog (SC-01): replace stored
   *  names and effective unit prices with catalog values and flag
   *  unknown/out-of-stock products so they are shown as "sin stock" and
   *  excluded from the message. Called by catalog.js once products are
   *  loaded. The catalog product shape is { id, name, price, offer_price,
   *  in_stock, ... }; the effective price is offer_price when set (not
   *  null), otherwise price. Lines whose id is no longer in the catalog keep
   *  their stored price (or 0). */
  function reconcile(products) {
    var byId = {};
    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      byId[String(p.id)] = {
        name: (p.name == null) ? '' : String(p.name),
        price: effectivePrice(p),
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
        if (items[j].price !== info.price) {
          items[j].price = info.price;
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
    // FIX-2: stock (and price) may have changed since the last save — refresh
    // the UI now so the drawer and send path never use a stale in_stock flag
    // or a stale price.
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
    // Hide the FAB over the hero; reveal it at the same scroll point the
    // navbar turns black (main.js toggles .scrolled at window.scrollY > 60).
    function onFabScroll() {
      fab.classList.toggle('visible', window.scrollY > 60);
    }
    window.addEventListener('scroll', onFabScroll, { passive: true });
    onFabScroll();
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
    renderItems();
    renderTotal();
    renderFooter();
  }

  /** Render the grand-total row as the FIRST child of the footer (above the
   *  Vaciar / Pedir buttons) so it sits between the items list and the
   *  action buttons. Only in-stock lines contribute. Idempotent: rebuilds
   *  the #cartTotal node on every render so stale prices are never shown. */
  function renderTotal() {
    var total = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].in_stock) {
        total += (items[i].price || 0) * items[i].qty;
      }
    }
    var prev = document.getElementById('cartTotal');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    if (!items.length) return; // empty cart → no total row
    var row = el('div', 'cart-total');
    row.id = 'cartTotal';
    row.setAttribute('role', 'status');
    row.appendChild(el('span', 'cart-total-label', 'Total'));
    row.appendChild(el('span', 'cart-total-amount', '$' + formatPrice(total)));
    // Insert as the first child of the footer so the buttons stay below it.
    if (ui.footerEl.firstChild) {
      ui.footerEl.insertBefore(row, ui.footerEl.firstChild);
    } else {
      ui.footerEl.appendChild(row);
    }
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
        } else {
          // In-stock line: show "qty × $unit = $subtotal" under the name.
          // Price may be 0 before reconcile() runs — still rendered so the
          // layout doesn't jump when the catalog arrives.
          var unit = it.price || 0;
          var subtotal = unit * it.qty;
          info.appendChild(el(
            'span', 'cart-item-price',
            it.qty + ' \u00d7 $' + formatPrice(unit) + ' = $' + formatPrice(subtotal)
          ));
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
    // Only return focus if the FAB is visible (it may be hidden when the
    // drawer is closed at the top of the page in some future entry point).
    if (ui.fab.classList.contains('visible')) ui.fab.focus();
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
