/**
 * catalog.js — shared public rendering engine for Fitness Plus.
 *
 * Change: cms-fitness-plus · Slice 2 (public rendering).
 *
 * Loaded on index.html, categoria.html, producto.html and 404.html AFTER
 * js/site-config.js and js/supabase.js, and BEFORE js/main.js:
 *
 *     site-config → supabase → catalog → main
 *
 * Reads categories, products and site_texts from Supabase via window.Supabase
 * and renders the navbar dropdown, the home featured grid, the generic
 * category page (categoria.html?categoria=<slug>) and the product detail page
 * (producto.html?id=<uuid>).
 *
 * Card markup is byte-identical to the previous static renderCards() output
 * (js/main.js, pre-cutover) — the ONLY additions are the OFERTA/SIN STOCK badges
 * and the offer price row (.precio-block / .precio-original), so the visual
 * design stays unchanged. Regular cards produce the exact same DOM as before.
 *
 * Vanilla JS, no imports/exports. No test runner — verified with node --check
 * plus the manual browser checklist from sdd-verify.
 */
(function () {
  'use strict';

  // ---- constants ------------------------------------------------------------

  var SITE_URL = window.SITE_URL || 'https://fitnessplus.com';
  var WHATSAPP_NUMBER = '543518682837';

  // Category slug → local hero background image. Mirrors the pre-cutover CSS
  // ids #hero-creatinas / #hero-preentrenos; unknown slugs get the default.
  var HERO_IMAGES = {
    creatinas: 'img/hero/creatinas_hero.png',
    preentrenos: 'img/hero/prework_hero.png'
  };

  // Fallback texts when a site_texts key is missing (spec: fallback defaults).
  // Values mirror the current static site copy verbatim (es-AR).
  var DEFAULT_TEXTS = {
    home_hero_title: 'EL PLUS QUE ESTABÁS BUSCANDO',
    home_hero_subtitle: 'Suplementos diseñados para darte la fuerza y la recuperación que necesitás.',
    home_section_title: 'PRODUCTOS',
    home_section_subtitle: 'Lo mejor para tu rendimiento',
    nosotros_title: 'POR QUÉ ELEGIRNOS',
    nosotros_subtitle: 'Somos tu mejor opción',
    nosotros_benefit_1_title: 'Contactanos',
    nosotros_benefit_1_text: 'Escribinos por WhatsApp o Instagram para hacer tus pedidos. Te atendemos personalmente.',
    nosotros_benefit_2_title: 'Calidad Garantizada',
    nosotros_benefit_2_text: 'Todos nuestros productos cuentan con certificación y están avalados por profesionales del deporte.',
    nosotros_benefit_3_title: 'Asesoramiento',
    nosotros_benefit_3_text: 'Te ayudamos en la elección de suplementos según tus objetivos. No dudes en contactarnos.',
    home_featured_max: '6'
  };

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var page = window.location.pathname.split('/').pop();
  var currentSlug = (function () {
    try {
      return new URLSearchParams(window.location.search).get('categoria') || '';
    } catch (e) {
      return '';
    }
  })();

  var state = { categories: [], products: [], texts: {} };
  var cardObserver = null;

  // ---- small helpers ----------------------------------------------------------

  /** HTML-escape a value before interpolating it into innerHTML markup. */
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function text(key, fallback) {
    var value = state.texts[key];
    return (value === undefined || value === null || value === '') ? fallback : value;
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function formatPrice(n) {
    return Number(n).toLocaleString('es-AR');
  }

  // ---- flavor variants: derived stock -----------------------------------------
  // A product with a non-empty variants array derives its stock from the
  // variants (any stock > 0); a variant-less product keeps today's manual
  // in_stock flag. NULL/[] variants = byte-identical current behavior (FV-1).

  function effectiveInStock(p) {
    var v = p && p.variants;
    if (Array.isArray(v) && v.length) {
      for (var i = 0; i < v.length; i++) if (Number(v[i].stock) > 0) return true;
      return false;
    }
    return !!(p && p.in_stock);
  }

  /** Stock of the named variant (trim + case-insensitive match) or null when
   *  the product has no such variant. */
  function variantStock(p, name) {
    var v = p && p.variants;
    if (!Array.isArray(v)) return null;
    var target = String(name).trim().toLowerCase();
    for (var i = 0; i < v.length; i++) {
      if (String(v[i].name).trim().toLowerCase() === target) return Number(v[i].stock);
    }
    return null;
  }

  function hasVariants(p) {
    return Array.isArray(p && p.variants) && p.variants.length > 0;
  }

  /** Resolve a product object by id (linear scan over the loaded catalog). */
  function productById(id) {
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].id === id) return state.products[i];
    }
    return null;
  }

  /** Grammatical article per product name so the WhatsApp message reads
   *  "un" (masculine) or "una" (feminine) correctly — e.g. "una creatina",
   *  "un pre-workout". Products not listed fall back to no article. */
  var PRODUCT_ARTICLES = {
    'CREATINA MYPROTEIN': 'una',
    'CREATINA STAR NUTRITION': 'una',
    'CREATINA ENA': 'una',
    'PRE-WORKOUT PREWAR': 'un',
    'PRE-WORKOUT PUMP V8': 'un'
  };

  /** WhatsApp deep link with the product name, its grammatical article and an
   *  optional flavor suffix ("sabor Naranja") — FV-6 exact format. Variant-less
   *  products (no variantName) keep today's byte-identical message. */
  function waLink(product, variantName) {
    var article = PRODUCT_ARTICLES[product.name] || '';
    var msg = 'Hola, quiero comprar ' + (article ? article + ' ' : '') + product.name;
    if (variantName) msg += ' sabor ' + variantName;
    return 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(msg);
  }

  function injectJsonLd(id, data) {
    var existing = document.getElementById(id);
    if (existing) existing.remove();
    var script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = id;
    script.textContent = JSON.stringify(data);
    document.head.appendChild(script);
  }

  function removeJsonLd(id) {
    var existing = document.getElementById(id);
    if (existing) existing.remove();
  }

  function setMeta(prop, value) {
    var el = document.querySelector('meta[property="' + prop + '"]');
    if (!el) el = document.querySelector('meta[name="' + prop + '"]');
    if (el) el.setAttribute('content', value);
  }

  function indexTexts(rows) {
    var map = {};
    for (var i = 0; i < rows.length; i++) map[rows[i].key] = rows[i].value;
    return map;
  }

  function productsOfCategory(categoryId) {
    var list = [];
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].category_id === categoryId) list.push(state.products[i]);
    }
    list.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
    return list;
  }

  /** Featured products ordered by home_order, clamped to home_featured_max (<=6). */
  function featuredProducts() {
    var list = [];
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].is_featured) list.push(state.products[i]);
    }
    list.sort(function (a, b) {
      var ao = (a.home_order == null) ? Infinity : a.home_order;
      var bo = (b.home_order == null) ? Infinity : b.home_order;
      return ao - bo;
    });
    var max = parseInt(text('home_featured_max', DEFAULT_TEXTS.home_featured_max), 10) || 6;
    if (max > 6) max = 6;
    return list.slice(0, max);
  }

  // ---- scroll reveal observer -------------------------------------------------

  function ensureObserver() {
    if (cardObserver) return cardObserver;
    if (typeof IntersectionObserver === 'undefined') return null;
    cardObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) entries[i].target.classList.add('visible');
      }
    }, { threshold: 0.1 });
    return cardObserver;
  }

  // ---- flavor variants: selection state + chips ---------------------------------
  // Selection is kept per product object (WeakMap) so it survives card
  // re-renders — the product object persists in state.products. The detail
  // page resolves via detailProduct. Card → detail navigation does NOT carry
  // the selection: the detail page starts from the first in-stock variant on
  // the same page load (design decision, no cross-session persistence).

  var selectedVariantByProduct = new WeakMap();
  var detailProduct = null;

  /** Stored selection when that variant still has stock, else first in-stock
   *  variant (array order). */
  function getSelectedVariant(p) {
    var stored = selectedVariantByProduct.get(p);
    if (stored && variantStock(p, stored) > 0) return stored;
    var v = p && p.variants;
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) {
        if (Number(v[i].stock) > 0) return v[i].name;
      }
    }
    return '';
  }

  /** One chip button. 0-stock variants stay focusable+clicKEABLE for photo
   *  viewing (FLI-4) — native `disabled` was dropped; they carry
   *  `aria-disabled="true"` + `.variant-chip--out` instead (NFR-1 a11y).
   *  data-variant and text go through escapeHtml (FV-3 XSS). `selected` is only
   *  applied to IN-STOCK variants: on the card an OOS chip must NEVER gain
   *  `.selected` even after a click (W1 resolution — the delegated handler
   *  enforces this asymmetry; detail OOS chips DO get `.selected` so the user
   *  sees which photo they are viewing). */
  function variantChipHtml(v, sel) {
    var name = String(v.name == null ? '' : v.name);
    var stock = Number(v.stock);
    var inStock = stock > 0;
    var selected = inStock && String(sel).trim().toLowerCase() === name.trim().toLowerCase();
    var oos = !inStock;
    var cls = 'variant-chip' + (selected ? ' selected' : '') + (oos ? ' variant-chip--out' : '');
    var attrs = 'type="button" class="' + cls + '" data-variant="' + escapeHtml(name) + '"' +
      ' aria-pressed="' + (selected ? 'true' : 'false') + '"' +
      (oos ? ' aria-disabled="true"' : '');
    return '<button ' + attrs + '>' + escapeHtml(name) + '</button>';
  }

  // ---- cards -------------------------------------------------------------------

  /**
   * Card template — byte-identical to the pre-cutover renderCards() innerHTML.
   * Additions ONLY (spec product-catalog): OFERTA badge + struck original price
   * when offer_price is set; SIN STOCK badge + disabled .btn-pedir when out of
   * stock. Regular (in-stock, no offer) cards keep the exact previous markup.
   */
  function cardTemplate(p) {
    var precio = (p.offer_price != null) ? p.offer_price : p.price;
    var badges = '';
    if (p.offer_price != null) badges += '<span class="badge badge-oferta">OFERTA</span>';
    if (!effectiveInStock(p)) badges += '<span class="badge badge-agotado">SIN STOCK</span>';

    var precioRow;
    if (p.offer_price != null) {
      precioRow = '<div class="precio-block">' +
        '<s class="precio-original">$' + escapeHtml(formatPrice(p.price)) + '</s>' +
        '<p class="precio" aria-label="Precio ' + escapeHtml(formatPrice(precio)) + ' pesos">$' + escapeHtml(formatPrice(precio)) + '</p>' +
        '</div>';
    } else {
      precioRow = '<p class="precio" aria-label="Precio ' + escapeHtml(formatPrice(precio)) + ' pesos">$' + escapeHtml(formatPrice(precio)) + '</p>';
    }

    var sel = getSelectedVariant(p);

    // Flavor chips — separate block ABOVE the flex price row (never a third
    // child of .precio-row, whose space-between layout must stay untouched).
    // All variants 0 → SIN STOCK card, no selector (SC-3).
    var chips = '';
    if (effectiveInStock(p) && hasVariants(p)) {
      chips = '<div class="variant-selector" role="group" aria-label="Sabor">' +
        p.variants.map(function (v) { return variantChipHtml(v, sel); }).join('') + '</div>';
    }

    var pedir;
    var cartBtn = '';
    if (effectiveInStock(p)) {
      // data-variant only exists when the product really has variants —
      // variant-less products get a plain .btn-cart without the attribute.
      var variantAttr = hasVariants(p) ? ' data-variant="' + escapeHtml(sel) + '"' : '';
      pedir = '<a href="' + waLink(p, sel) + '" target="_blank" rel="noopener noreferrer" class="btn-pedir" aria-label="Pedir ' + escapeHtml(p.name) + ' por WhatsApp">Pedir</a>';
      cartBtn = '<button type="button" class="btn-cart" data-id="' + escapeHtml(p.id) + '" data-name="' + escapeHtml(p.name) + '"' + variantAttr + '>Agregar</button>';
    } else {
      pedir = '<span class="btn-pedir disabled" aria-disabled="true" tabindex="-1">Pedir</span>';
    }

    // In-stock cards group Pedir + cart button in a flex .btn-group; the
    // out-of-stock card keeps the disabled Pedir alone (previous markup).
    var actionRow = effectiveInStock(p) ? '<div class="btn-group">' + pedir + cartBtn + '</div>' : pedir;

    return '<div class="producto-img">' +
      '<img src="' + escapeHtml(p.image_url) + '" alt="' + escapeHtml(p.name) + '" loading="lazy" width="400" height="240">' +
      badges +
      '</div>' +
      '<div class="producto-info">' +
      '<h3>' + escapeHtml(p.name) + '</h3>' +
      '<p class="descripcion">' + escapeHtml(p.short_desc) + '</p>' +
      chips +
      '<div class="precio-row">' + precioRow + actionRow + '</div>' +
      '</div>';
  }

  function addRipple(el) {
    el.classList.add('ripple');
    el.addEventListener('click', function (e) {
      var rect = el.getBoundingClientRect();
      var size = Math.max(rect.width, rect.height);
      var span = document.createElement('span');
      span.className = 'ripple-effect';
      span.style.width = span.style.height = size + 'px';
      span.style.left = (e.clientX - rect.left - size / 2) + 'px';
      span.style.top = (e.clientY - rect.top - size / 2) + 'px';
      el.appendChild(span);
      span.addEventListener('animationend', function () { span.remove(); });
    });
  }

  function buildCard(product) {
    var card = document.createElement('div');
    card.className = 'producto-card reveal';
    card.setAttribute('role', 'listitem');
    card.setAttribute('data-id', product.id);
    var precio = (product.offer_price != null) ? product.offer_price : product.price;
    card.setAttribute('aria-label', product.name + ' — $' + formatPrice(precio));
    card.tabIndex = 0;
    card.addEventListener('click', function (e) {
      if (e.target.closest('.btn-pedir, .btn-cart, .variant-chip')) return;
      window.location.href = 'producto.html?id=' + product.id;
    });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        // Guard BEFORE preventDefault so a focused .btn-pedir / .btn-cart /
        // .variant-chip control fires its own native activation (keyboard
        // accessibility — Enter/Space selects a chip instead of navigating).
        if (e.target.closest('.btn-pedir, .btn-cart, .variant-chip')) return;
        e.preventDefault();
        window.location.href = 'producto.html?id=' + product.id;
      }
    });
    card.innerHTML = cardTemplate(product);
    addRipple(card);
    var observer = ensureObserver();
    if (observer) observer.observe(card);
    else card.classList.add('visible');
    return card;
  }

  // ---- cart button delegation -------------------------------------------------
  // One document-level listener for .btn-cart (mirrors main.js:85) so adds
  // survive card/detail re-renders via innerHTML. The card click/keydown
  // guards above already ignore .btn-cart, so no navigation happens here.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.btn-cart');
    if (!btn) return;
    e.stopPropagation();
    if (window.FPCart && window.FPCart.add) {
      var id = btn.getAttribute('data-id');
      // Pass the catalog's effective unit price (offer_price when set,
      // otherwise price) so the cart drawer / WhatsApp total is correct.
      var price = 0;
      for (var i = 0; i < state.products.length; i++) {
        if (state.products[i].id === id) {
          price = (state.products[i].offer_price != null)
            ? state.products[i].offer_price
            : state.products[i].price;
          break;
        }
      }
      // data-variant only exists when the product really has variants (PR 1
      // fix 0e07ec6) — variant-less products pass '' and keep today's line.
      var variant = btn.getAttribute('data-variant') || '';
      window.FPCart.add(id, btn.getAttribute('data-name'), price, variant);
    }
  });

  // ---- variant chip delegation -------------------------------------------------
  // Document-level listener for .variant-chip (mirrors .btn-cart above): a
  // chip click selects the flavor in place (no re-render → focus is kept) and
  // updates the sibling Pedir href + cart data-variant. The card click/keydown
  // guards already ignore .variant-chip, so no navigation happens here (SC-8).
  // FLI-2 / FLI-4 / FLI-8 (flavor-images): the handler ALSO swaps both detail
  // slider slide imgs in place on chip click (detail page only) and disables
  // #btnPedirDetalle + .detalle-info .btn-cart while an OOS chip is selected.

  /** Id-ladder resolver for the detail slide imgs (FLI-2). 4-slide build
   *  exposes BOTH #slide-producto img + #slide-clone-producto img (clone for
   *  the infinite-loop illusion); the single-img build (no nutrition table)
   *  exposes a single #detalleImagen > img. Resolved once per call via
   *  querySelectorAll on those stable ids. Returns an empty NodeList on
   *  non-detail pages (cards have no #slide-* / #detalleImagen). */
  function detailSlideImgs() {
    var imgs = document.querySelectorAll('#slide-producto img, #slide-clone-producto img');
    return imgs.length === 2 ? imgs : document.querySelectorAll('#detalleImagen > img');
  }

  document.addEventListener('click', function (e) {
    var chip = e.target.closest('.variant-chip');
    // OOS chips are NOT natively disabled anymore (FLI-4) — they carry
    // aria-disabled="true" so they remain clickable for photo viewing. Only
    // bail on a non-chip target.
    if (!chip) return;
    e.stopPropagation();
    var card = chip.closest('.producto-card');
    var product = card ? productById(card.getAttribute('data-id')) : detailProduct;
    if (!product) return;
    var name = chip.getAttribute('data-variant');
    selectedVariantByProduct.set(product, name);

    var oos = chip.getAttribute('aria-disabled') === 'true';

    // 1. In-place selection state (sibling chips cleared, aria-pressed synced).
    //    CARD path (W1 resolution): an OOS chip must NOT gain `.selected` — a
    //    user cannot actually order it, so the misleading "selected" visual is
    //    suppressed on cards. Detail path keeps `.selected` on OOS chips so
    //    the customer sees which flavor photo they are viewing (FLI-2 intent).
    var chips = chip.parentNode.querySelectorAll('.variant-chip');
    for (var i = 0; i < chips.length; i++) {
      var isThis = chips[i] === chip;
      var showSelected = isThis && !(card && oos);
      chips[i].classList.toggle('selected', showSelected);
      chips[i].setAttribute('aria-pressed', showSelected ? 'true' : 'false');
    }

    // 2. Pedir href recomputed for the selected flavor.
    var pedirLink = card ? card.querySelector('.btn-pedir') : document.getElementById('btnPedirDetalle');
    if (pedirLink) pedirLink.setAttribute('href', waLink(product, name));

    // 3. Cart button carries the selection (NOT chip siblings — the detail
    //    cart button lives in .detalle-precio-row, outside the selector).
    var cartBtn = card ? card.querySelector('.btn-cart') : document.querySelector('.detalle-info .btn-cart');
    if (cartBtn) cartBtn.setAttribute('data-variant', name);

    // 4. (FLI-4 / SCF-3 / SCF-6) While an OOS chip is the selected chip,
    //    disable BOTH order controls; selecting an in-stock chip re-enables
    //    them. Detail-only — cards have no such controls here.
    if (!card) {
      if (pedirLink && typeof pedirLink.setAttribute === 'function') {
        if (oos) pedirLink.setAttribute('disabled', 'disabled');
        else pedirLink.removeAttribute('disabled');
      }
      if (cartBtn && typeof cartBtn.setAttribute === 'function') {
        if (oos) cartBtn.setAttribute('disabled', 'disabled');
        else cartBtn.removeAttribute('disabled');
      }

      // 5. (FLI-2 / FLI-5 / FLI-8 / SCF-2 / SCF-8) Silent detail image swap.
      //    Detail page only — card image NEVER swaps (SCF-7 guard). Resolve the
      //    variant object by name to read its image_url. Lazy-init
      //    dataset.mainSrc / dataset.mainAlt from each slide img's CURRENT src
      //    / alt on FIRST swap (NOT at render time — survives re-renders that
      //    reset the slider markup). Write src/alt in place via setAttribute;
      //    NO initSlider re-call, NO DOM rebuild (FLI-8 silent swap).
      var variant = null;
      if (Array.isArray(product.variants)) {
        for (var j = 0; j < product.variants.length; j++) {
          if (product.variants[j] && String(product.variants[j].name) === name) {
            variant = product.variants[j];
            break;
          }
        }
      }
      var variantImg = variant && variant.image_url ? variant.image_url : '';
      var slideImgs = detailSlideImgs();
      // Loop is a real NodeList; iterate by index (ES5 — project style).
      for (var k = 0; k < slideImgs.length; k++) {
        var img = slideImgs[k];
        // Lazy stash the canonical src/alt on first touch.
        if (!img.dataset.mainSrc) {
          img.dataset.mainSrc = img.getAttribute('src') || '';
          img.dataset.mainAlt = img.getAttribute('alt') || '';
        }
        if (variantImg) {
          img.setAttribute('src', escapeHtml(variantImg));
          img.setAttribute('alt', escapeHtml(product.name) + ' sabor ' + escapeHtml(variant ? variant.name : ''));
        } else {
          img.setAttribute('src', img.dataset.mainSrc);
          img.setAttribute('alt', img.dataset.mainAlt);
        }
      }
    }
  });

  // ---- navbar -------------------------------------------------------------------

  function renderNavbar() {
    var menu = document.getElementById('dropdownMenu');
    if (!menu) return;
    menu.innerHTML = '';
    var dropdown = document.querySelector('.dropdown');
    if (!state.categories.length) {
      if (dropdown) dropdown.style.display = 'none';
      return;
    }
    if (dropdown) dropdown.style.display = '';
    for (var i = 0; i < state.categories.length; i++) {
      var cat = state.categories[i];
      var link = document.createElement('a');
      link.href = 'categoria.html?categoria=' + encodeURIComponent(cat.slug);
      link.className = 'dropdown-cat-link';
      link.setAttribute('role', 'menuitem');
      link.textContent = cat.name.toUpperCase();
      if (page === 'categoria.html' && cat.slug === currentSlug) {
        link.setAttribute('aria-current', 'page');
      }
      menu.appendChild(link);
    }
  }

  // ---- grid / skeleton / error states --------------------------------------------

  function renderGrid(products, emptyMessage) {
    var grid = document.getElementById('productosGrid');
    if (!grid) return;
    grid.innerHTML = '';
    if (!products.length) {
      grid.innerHTML = '<div class="estado-vacio"><p>' + (emptyMessage || 'No hay productos.') + '</p></div>';
      return;
    }
    for (var i = 0; i < products.length; i++) {
      grid.appendChild(buildCard(products[i]));
    }
  }

  function renderSkeleton() {
    var grid = document.getElementById('productosGrid');
    if (grid) {
      grid.innerHTML = '';
      for (var i = 0; i < 6; i++) {
        var sk = document.createElement('div');
        sk.className = 'skeleton-card';
        sk.setAttribute('aria-hidden', 'true');
        sk.innerHTML = '<div class="skeleton skeleton-img"></div>' +
          '<div class="skeleton skeleton-line w60"></div>' +
          '<div class="skeleton skeleton-line w80"></div>';
        grid.appendChild(sk);
      }
    }
    var detalle = document.getElementById('productoDetalle');
    if (detalle) {
      detalle.innerHTML = '<div class="container skeleton-detail">' +
        '<div class="skeleton skeleton-detail-img"></div>' +
        '<div class="skeleton-detail-info">' +
        '<div class="skeleton skeleton-line w60"></div>' +
        '<div class="skeleton skeleton-line w90"></div>' +
        '<div class="skeleton skeleton-line w80"></div>' +
        '</div>' +
        '</div>';
    }
  }

  function bindRetry() {
    var btn = document.getElementById('btnReintentar');
    if (btn) btn.addEventListener('click', init);
  }

  function showErrorGrid() {
    var grid = document.getElementById('productosGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="estado-error">' +
      '<p>No pudimos cargar el catálogo. Comprobá tu conexión e intentá de nuevo.</p>' +
      '<button type="button" class="btn-reintentar" id="btnReintentar">Reintentar</button>' +
      '</div>';
    bindRetry();
  }

  function showErrorDetail() {
    var detalle = document.getElementById('productoDetalle');
    if (!detalle) return;
    detalle.innerHTML = '<div class="container estado-error">' +
      '<p>No pudimos cargar el producto. Comprobá tu conexión e intentá de nuevo.</p>' +
      '<button type="button" class="btn-reintentar" id="btnReintentar">Reintentar</button>' +
      '</div>';
    bindRetry();
  }

  // ---- buscador (search box) -------------------------------------------------------

  function bindBuscador() {
    var input = document.getElementById('buscador');
    if (!input || input.getAttribute('data-catalog-bound') === '1') return;
    input.setAttribute('data-catalog-bound', '1');
    input.addEventListener('input', function () {
      var texto = this.value.toLowerCase().trim();
      var cards = document.querySelectorAll('.producto-card');
      for (var i = 0; i < cards.length; i++) {
        var h3 = cards[i].querySelector('h3');
        var nombre = h3 ? h3.textContent.toLowerCase() : '';
        cards[i].style.display = nombre.indexOf(texto) !== -1 ? '' : 'none';
      }
    });
  }

  // ---- home (index.html) --------------------------------------------------------------

  function renderHomeTexts() {
    setText('hero-title', text('home_hero_title', DEFAULT_TEXTS.home_hero_title));
    setText('hero-subtitle', text('home_hero_subtitle', DEFAULT_TEXTS.home_hero_subtitle));
    setText('productos-title', text('home_section_title', DEFAULT_TEXTS.home_section_title));
    setText('productos-subtitle', text('home_section_subtitle', DEFAULT_TEXTS.home_section_subtitle));
    setText('nosotros-title', text('nosotros_title', DEFAULT_TEXTS.nosotros_title));
    setText('nosotros-subtitle', text('nosotros_subtitle', DEFAULT_TEXTS.nosotros_subtitle));
    for (var i = 1; i <= 3; i++) {
      setText('nosotros-benefit-' + i + '-title', text('nosotros_benefit_' + i + '_title', DEFAULT_TEXTS['nosotros_benefit_' + i + '_title']));
      setText('nosotros-benefit-' + i + '-text', text('nosotros_benefit_' + i + '_text', DEFAULT_TEXTS['nosotros_benefit_' + i + '_text']));
    }
  }

  function renderHome() {
    renderHomeTexts();
    var featured = featuredProducts();
    renderGrid(featured, 'Todavía no hay productos destacados.');

    var elements = [];
    for (var i = 0; i < featured.length; i++) {
      elements.push({
        '@type': 'ListItem',
        'position': i + 1,
        'url': SITE_URL + '/producto.html?id=' + featured[i].id,
        'name': featured[i].name
      });
    }
    if (elements.length) {
      injectJsonLd('ld-itemlist', {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        'name': 'Suplementos Deportivos Fitness Plus',
        'itemListElement': elements
      });
    } else {
      removeJsonLd('ld-itemlist');
    }
  }

  // ---- categoria.html ---------------------------------------------------------------

  function setCategoriaHero(slug, imageUrl) {
    var hero = document.getElementById('hero-categoria');
    if (!hero) return;
    var fallback = HERO_IMAGES[slug] || 'img/hero/principal_hero.png';
    var img = imageUrl || fallback;
    // Escape both quote classes before embedding the URL into a CSS url("...")
    // string. Halts any breakout from the url() token without touching HTML.
    var esc = String(img).replace(/"/g, '%22').replace(/'/g, '%27');
    hero.style.setProperty('background-image',
      'linear-gradient(135deg, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.6) 100%), url("' + esc + '")');
    hero.style.backgroundSize = 'cover';
    hero.style.backgroundPosition = 'center 80%';
  }

  function renderCategoria() {
    var slug = currentSlug;
    var category = null;
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].slug === slug) {
        category = state.categories[i];
        break;
      }
    }

    var hero = document.getElementById('hero-categoria');
    var busqueda = document.querySelector('.productos-busqueda');

    if (!category) {
      if (hero) hero.style.display = 'none';
      if (busqueda) busqueda.style.display = 'none';
      setText('categoria-section-title', 'Categoría no encontrada');
      setText('categoria-section-subtitle', '');
      document.title = 'Categoría no encontrada | Fitness Plus';
      renderGrid([], 'La categoría que buscás no existe.');
      return;
    }

    setText('categoria-hero-title', category.hero_title);
    setText('categoria-hero-subtitle', category.hero_subtitle);
    setText('categoria-section-title', category.section_title);
    setText('categoria-section-subtitle', category.section_subtitle);
    setCategoriaHero(slug, category && category.hero_image_url ? category.hero_image_url : null);

    var pageUrl = SITE_URL + '/categoria.html?categoria=' + encodeURIComponent(slug);
    document.title = category.name + ' | Fitness Plus';
    setMeta('description', category.hero_subtitle);
    var canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute('href', pageUrl);
    setMeta('og:title', category.name + ' | Fitness Plus');
    setMeta('og:description', category.hero_subtitle);
    setMeta('og:url', pageUrl);
    setMeta('twitter:title', category.name + ' | Fitness Plus');
    setMeta('twitter:description', category.hero_subtitle);

    injectJsonLd('ld-breadcrumb', {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      'itemListElement': [
        { '@type': 'ListItem', 'position': 1, 'name': 'Inicio', 'item': SITE_URL + '/' },
        { '@type': 'ListItem', 'position': 2, 'name': category.name, 'item': pageUrl }
      ]
    });

    renderGrid(productsOfCategory(category.id), 'Todavía no hay productos en esta categoría.');
  }

  // ---- producto.html ---------------------------------------------------------------

  function buildDetailMarkup(p) {
    var badges = '';
    if (p.offer_price != null) badges += '<span class="badge badge-oferta">OFERTA</span>';
    if (!effectiveInStock(p)) badges += '<span class="badge badge-agotado">SIN STOCK</span>';
    var badgesHtml = badges ? '<div class="detalle-badges">' + badges + '</div>' : '';

    var precioHtml;
    if (p.offer_price != null) {
      precioHtml = '<s class="precio-original">$' + escapeHtml(formatPrice(p.price)) + '</s>' +
        '<span class="precio-oferta">$' + escapeHtml(formatPrice(p.offer_price)) + '</span>';
    } else {
      precioHtml = '$' + escapeHtml(formatPrice(p.price));
    }

    var sel = getSelectedVariant(p);

    // Flavor chips — separate block ABOVE .detalle-precio-row (same rule as
    // the card: never inside the flex space-between price row). All variants
    // 0 → SIN STOCK + disabled Pedir, no selector (SC-3).
    var chips = '';
    if (effectiveInStock(p) && hasVariants(p)) {
      chips = '<div class="variant-selector" role="group" aria-label="Sabor">' +
        p.variants.map(function (v) { return variantChipHtml(v, sel); }).join('') + '</div>';
    }

    var pedir;
    var cartBtn = '';
    if (effectiveInStock(p)) {
      // data-variant only exists when the product really has variants —
      // variant-less products get a plain .btn-cart without the attribute.
      var variantAttr = hasVariants(p) ? ' data-variant="' + escapeHtml(sel) + '"' : '';
      pedir = '<a href="' + waLink(p, sel) + '" target="_blank" rel="noopener noreferrer" class="btn-pedir" id="btnPedirDetalle">Pedir</a>';
      cartBtn = '<button type="button" class="btn-cart" data-id="' + escapeHtml(p.id) + '" data-name="' + escapeHtml(p.name) + '"' + variantAttr + '>Agregar</button>';
    } else {
      pedir = '<span class="btn-pedir disabled" aria-disabled="true" tabindex="-1" id="btnPedirDetalle">Pedir</span>';
    }

    var actionRow = effectiveInStock(p) ? '<div class="btn-group">' + pedir + cartBtn + '</div>' : pedir;

    return '<div class="container detalle-container">' +
      '<div class="detalle-imagen" id="detalleImagen">' + buildSliderHtml(p) + '</div>' +
      '<div class="detalle-info">' +
      badgesHtml +
      '<h2 id="detalleNombre">' + escapeHtml(p.name) + '</h2>' +
      '<p class="detalle-descripcion" id="detalleDescripcion">' + escapeHtml(p.full_desc) + '</p>' +
      chips +
      '<div class="detalle-precio-row">' +
      '<p class="detalle-precio" id="detallePrecio">' + precioHtml + '</p>' +
      actionRow +
      '</div>' +
      '<div class="detalle-actions">' +
      '<a href="index.html" id="btnVolver" class="btn-volver"><i class="fas fa-arrow-left" aria-hidden="true"></i> Volver</a>' +
      '</div>' +
      '</div>' +
      '</div>';
  }

  /** Slider markup — the pre-cutover 4-slide clone pattern, verbatim. */
  function buildSliderHtml(p) {
    if (!p.nutrition_image_url) {
      return '<img src="' + escapeHtml(p.image_url) + '" alt="' + escapeHtml(p.name) + '" loading="lazy" width="600" height="600">';
    }
    return '<div class="detalle-slider">' +
      '<div class="detalle-slider-track" id="sliderTrack">' +
      '<div class="detalle-slide" id="slide-clone-tabla">' +
      '<img src="' + escapeHtml(p.nutrition_image_url) + '" alt="Tabla nutricional de ' + escapeHtml(p.name) + '" loading="lazy">' +
      '</div>' +
      '<div class="detalle-slide" id="slide-producto">' +
      '<img src="' + escapeHtml(p.image_url) + '" alt="' + escapeHtml(p.name) + '" loading="lazy" width="600" height="600">' +
      '</div>' +
      '<div class="detalle-slide" id="slide-tabla">' +
      '<img src="' + escapeHtml(p.nutrition_image_url) + '" alt="Tabla nutricional de ' + escapeHtml(p.name) + '" loading="lazy">' +
      '</div>' +
      '<div class="detalle-slide" id="slide-clone-producto">' +
      '<img src="' + escapeHtml(p.image_url) + '" alt="' + escapeHtml(p.name) + '" loading="lazy" width="600" height="600">' +
      '</div>' +
      '</div>' +
      '<button class="detalle-arrow prev" id="slidePrev" aria-label="Anterior">&#10094;</button>' +
      '<button class="detalle-arrow next" id="slideNext" aria-label="Siguiente">&#10095;</button>' +
      '<div class="detalle-dots" id="slideDots">' +
      '<span class="dot active"></span><span class="dot"></span>' +
      '</div>' +
      '</div>';
  }

  /** Slider behaviour — reused verbatim from the pre-cutover js/main.js. */
  function initSlider(container) {
    var currentSlide = 0; // 0 = producto, 1 = tabla
    var track = document.getElementById('sliderTrack');
    var slideTimer;

    function slideTo(idx, instant) {
      track.style.transition = instant ? 'none' : '';
      var pos = -(idx + 1) * 100; // producto= -100%, tabla = -200%
      track.style.transform = 'translateX(' + pos + '%)';
      if (instant) { track.offsetHeight; track.style.transition = ''; }
    }

    function updateDots(idx) {
      var dots = document.querySelectorAll('#slideDots .dot');
      for (var i = 0; i < dots.length; i++) {
        dots[i].classList.toggle('active', (idx === 0 && i === 0) || (idx === 1 && i === 1));
      }
    }

    function nextSlide() {
      clearTimeout(slideTimer);
      if (currentSlide === 0) {
        slideTo(1);
        currentSlide = 1;
        updateDots(1);
      } else {
        updateDots(0);
        slideTo(2);
        slideTimer = setTimeout(function () {
          slideTo(0, true);
          currentSlide = 0;
        }, 400);
      }
    }

    function prevSlide() {
      clearTimeout(slideTimer);
      if (currentSlide === 1) {
        slideTo(0);
        currentSlide = 0;
        updateDots(0);
      } else {
        updateDots(1);
        slideTo(-1);
        slideTimer = setTimeout(function () {
          slideTo(1, true);
          currentSlide = 1;
        }, 400);
      }
    }

    var nextBtn = document.getElementById('slideNext');
    var prevBtn = document.getElementById('slidePrev');
    if (nextBtn) nextBtn.addEventListener('click', nextSlide);
    if (prevBtn) prevBtn.addEventListener('click', prevSlide);

    var touchX = 0;
    container.addEventListener('touchstart', function (e) {
      touchX = e.changedTouches[0].screenX;
    }, { passive: true });
    container.addEventListener('touchend', function (e) {
      var diff = touchX - e.changedTouches[0].screenX;
      if (Math.abs(diff) > 50) {
        clearTimeout(slideTimer);
        if (diff > 0) { nextSlide(); } else { prevSlide(); }
      }
    }, { passive: true });

    slideTo(0, true);

    if ('ontouchstart' in window && typeof window.mediumZoom === 'function') {
      try { window.mediumZoom('#slide-tabla img, #slide-clone-tabla img'); } catch (e) { /* keep going */ }
    }
  }

  function updateProductoMeta(p) {
    var desc = p.full_desc;
    document.title = p.name + ' | Comprar — Fitness Plus';
    var url = SITE_URL + '/producto.html?id=' + p.id;

    var descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) descMeta.setAttribute('content', desc + ' Comprá online en Fitness Plus con envío 24/48h.');

    var canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute('href', url);

    setMeta('og:title', p.name + ' — Fitness Plus');
    setMeta('og:description', desc);
    setMeta('og:image', p.image_url);
    setMeta('og:url', url);
    setMeta('twitter:title', p.name + ' — Fitness Plus');
    setMeta('twitter:description', desc);
    setMeta('twitter:image', p.image_url);
  }

  function injectProductJsonLd(p) {
    var category = p.category_id || {};
    var url = SITE_URL + '/producto.html?id=' + p.id;
    var categoryUrl = SITE_URL + '/categoria.html?categoria=' + encodeURIComponent(category.slug || '');

    injectJsonLd('ld-product', {
      '@context': 'https://schema.org',
      '@type': 'Product',
      'name': p.name,
      'image': p.image_url,
      'description': p.full_desc,
      'brand': { '@type': 'Brand', 'name': p.brand },
      'category': category.name || '',
      'offers': {
        '@type': 'Offer',
        'url': url,
        'priceCurrency': 'ARS',
        'price': (p.offer_price != null) ? p.offer_price : p.price,
        'availability': effectiveInStock(p) ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        'itemCondition': 'https://schema.org/NewCondition'
      }
    });

    injectJsonLd('ld-breadcrumb', {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      'itemListElement': [
        { '@type': 'ListItem', 'position': 1, 'name': 'Inicio', 'item': SITE_URL + '/' },
        { '@type': 'ListItem', 'position': 2, 'name': category.name || '', 'item': categoryUrl },
        { '@type': 'ListItem', 'position': 3, 'name': p.name, 'item': url }
      ]
    });
  }

  function renderNotFound() {
    var nombre = document.getElementById('productoNombre');
    if (nombre) nombre.textContent = 'Producto no encontrado';
    var detalle = document.getElementById('productoDetalle');
    if (detalle) {
      detalle.innerHTML = '<div class="container"><p>El producto que buscás no existe.</p>' +
        '<a href="index.html" class="btn-volver"><i class="fas fa-arrow-left" aria-hidden="true"></i> Volver al inicio</a></div>';
    }
    document.title = 'Producto no encontrado | Fitness Plus';
  }

  function renderDetail(p) {
    detailProduct = p; // used by the chip delegation to resolve the product
    var nombre = document.getElementById('productoNombre');
    if (nombre) nombre.textContent = p.name;
    var detalle = document.getElementById('productoDetalle');
    if (detalle) {
      detalle.innerHTML = buildDetailMarkup(p);
      var detalleImg = document.getElementById('detalleImagen');
      if (p.nutrition_image_url && detalleImg) initSlider(detalleImg);
    }
    updateProductoMeta(p);
    injectProductJsonLd(p);
    requestAnimationFrame(function () {
      var detalleEl = document.getElementById('productoDetalle');
      if (detalleEl) {
        var top = detalleEl.getBoundingClientRect().top + window.scrollY;
        var offset = window.innerWidth > 768 ? 80 : 30;
        window.scrollTo({ top: top - offset, behavior: 'smooth' });
      }
    });
  }

  function renderProducto() {
    var params = new URLSearchParams(window.location.search);
    var uuid = params.get('id') || '';
    if (!UUID_RE.test(uuid)) {
      renderNotFound();
      return;
    }
    renderSkeleton();
    window.Supabase.select('products', {
      filters: { id: uuid },
      select: '*,category_id(id,name,slug)'
    }).then(function (rows) {
      if (!rows || !rows.length) {
        renderNotFound();
        return;
      }
      renderDetail(rows[0]);
    }).catch(function () {
      showErrorDetail();
    });
  }

  // ---- data load + init ------------------------------------------------------------

  function loadData() {
    var supabase = window.Supabase;
    if (!supabase) {
      return Promise.reject(new Error('Supabase client not loaded (missing js/supabase.js).'));
    }
    try {
      return Promise.all([
        supabase.select('categories', { order: 'sort_order.asc' }),
        supabase.select('products', { order: 'sort_order.asc' }),
        supabase.select('site_texts')
      ]).then(function (results) {
        state.categories = Array.isArray(results[0]) ? results[0] : [];
        state.products = Array.isArray(results[1]) ? results[1] : [];
        state.texts = indexTexts(Array.isArray(results[2]) ? results[2] : []);
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function renderError() {
    if (page === 'producto.html') {
      showErrorDetail();
      setText('productoNombre', 'No pudimos cargar el producto');
      document.title = 'Error | Fitness Plus';
    } else if (page === 'index.html' || page === 'categoria.html') {
      showErrorGrid();
      setText('categoria-hero-title', 'No pudimos cargar la categoría');
      document.title = 'Error | Fitness Plus';
    }
    // 404 and unknown pages: navbar is the only dynamic part, nothing else to do.
  }

  function init() {
    renderSkeleton();
    bindBuscador();
    loadData().then(function () {
      renderNavbar();
      if (page === 'categoria.html') {
        renderCategoria();
      } else if (page === 'producto.html') {
        renderProducto();
      } else if (page === 'index.html' || page === '' || page === undefined) {
        renderHome();
      }
      // Reconcile stored cart names against the live catalog (SC-01): replace
      // stale names and flag out-of-stock items for the cart message.
      if (window.FPCart && window.FPCart.reconcile) {
        window.FPCart.reconcile(state.products);
      }
    }).catch(function (err) {
      if (err && err.message) console.error('[catalog.js] ' + err.message);
      renderNavbar();
      renderError();
    });
  }

  init();
})();
