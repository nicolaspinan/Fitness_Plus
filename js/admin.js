/**
 * admin.js — Fitness Plus admin panel logic (change cms-fitness-plus, slice 3).
 *
 * Loaded ONLY on admin/index.html, AFTER js/site-config.js and js/supabase.js:
 *
 *     site-config → supabase → admin
 *
 * Reuses the existing window.Supabase wrapper for auth (signIn/signOut/
 * getSession/refreshSession), database CRUD (select/insert/update/remove) and
 * storage (upload/publicUrl). No inline handlers: every event is bound here
 * (script-src 'self').
 *
 * Security rules implemented here:
 *   - Auth gate: no session → login view; expired/refresh failure → login,
 *     never with a partially saved form (writes only apply after the response).
 *   - Every DB value rendered into the DOM is HTML-escaped (escapeHtml below,
 *     same approach as js/catalog.js) or set via textContent/value.
 *   - Uploads: type (png/jpeg/webp) + size (<=2MB) validated client-side;
 *     preview via FileReader.readAsDataURL — NEVER URL.createObjectURL.
 *
 * Row reordering: native HTML5 drag & drop (dragstart/dragover/drop/dragend,
 * all bound with addEventListener) on top of the existing arrow buttons, which
 * stay as the touch/mobile/accessibility fallback. Drops persist optimistically
 * (reorder state + re-render, then update the DB; reload on failure).
 *
 * No test runner — verified with `node --check js/admin.js` plus the manual
 * browser checklist from sdd-verify.
 */
(function () {
  'use strict';

  // ---- constants ------------------------------------------------------------

  var BUCKET = 'productos';
  var MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB
  var IMAGE_TYPES = { 'image/png': true, 'image/jpeg': true, 'image/webp': true };
  var IMAGE_EXTS = /\.(png|jpe?g|webp)$/i;
  var SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
  var VALID_VIEWS = ['login', 'categorias', 'productos', 'textos'];
  var MAX_VARIANTS = 10;
  var MAX_VARIANT_NAME_LENGTH = 40;

  // Monotonic counter so every dynamic row gets a unique label[for]/input[id]
  // pair even after rows are removed (ids are never reused within a session).
  var variantRowSeq = 0;

  var state = {
    categories: [],
    products: [],
    texts: {}
  };

  var editingCategoryId = null;
  // Tracks the hero URL the category had when its form was opened, so that an
  // explicitly removed hero object is only deleted from storage AFTER the
  // database row stops referencing it (safe against canceling the form).
  var previousCategoryHeroUrl = null;
  var editingProductId = null;
  var bannerTimer = null;
  var modalResolver = null;
  // Id of the row currently being dragged (null when no drag is active).
  var draggedRowId = null;
  // Whether the mousedown that could start a drag landed on an action button
  // (arrows/edit/delete). Row drags must never hijack the icon buttons.
  var dragPressOnButton = false;

  // ---- small helpers ----------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

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

  function formatPrice(n) {
    return Number(n).toLocaleString('es-AR');
  }

  /** True when value parses as an absolute http/https URL. */
  function isHttpUrl(value) {
    try {
      var parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  /** Stable client-side id (crypto.randomUUID with hex fallback) so a retry
   *  after a timeout upserts instead of duplicating the row. */
  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    var hex = '0123456789abcdef';
    var s = '';
    for (var i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
    return s.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }

  function isAuthError(err) {
    if (!err || !window.Supabase || !(err instanceof window.Supabase.SupabaseError)) return false;
    if (err.reason === 'auth') return true;
    // HTTP 401 from an authenticated call with no local session (e.g. logged
    // out from another tab) means the session is gone: treat as auth redirect.
    return err.status === 401 && !window.Supabase.getSession();
  }

  function isNetworkError(err) {
    return !!(err && window.Supabase && err instanceof window.Supabase.SupabaseError && err.reason === 'network');
  }

  function localDateISO(d) {
    var m = String(d.getMonth() + 1); if (m.length < 2) m = '0' + m;
    var day = String(d.getDate()); if (day.length < 2) day = '0' + day;
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function indexTexts(rows) {
    var map = {};
    for (var i = 0; i < rows.length; i++) map[rows[i].key] = rows[i].value;
    return map;
  }

  // ---- banner / toast ---------------------------------------------------------

  function showBanner(message, type) {
    var el = $('banner');
    if (!el) return;
    el.textContent = message;
    el.className = 'banner banner-' + (type || 'info');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { el.classList.add('hidden'); }, 4000);
  }

  function hideBanner() {
    var el = $('banner');
    if (el) el.classList.add('hidden');
  }

  // ---- confirm modal ------------------------------------------------------------

  function confirmDialog(message, okLabel) {
    var modal = $('confirmModal');
    $('confirmMessage').textContent = message;
    $('confirmOk').textContent = okLabel || 'Eliminar';
    modal.classList.remove('hidden');
    $('confirmOk').focus();
    return new Promise(function (resolve) {
      modalResolver = resolve;
    });
  }

  function closeModal(result) {
    var modal = $('confirmModal');
    if (modal) modal.classList.add('hidden');
    if (modalResolver) {
      var resolve = modalResolver;
      modalResolver = null;
      resolve(result);
    }
  }

  function bindModal() {
    $('confirmOk').addEventListener('click', function () { closeModal(true); });
    var closers = document.querySelectorAll('[data-modal-close]');
    for (var i = 0; i < closers.length; i++) {
      closers[i].addEventListener('click', function () { closeModal(false); });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('confirmModal').classList.contains('hidden')) {
        closeModal(false);
      }
    });
  }

  // ---- mobile nav drawer ---------------------------------------------------------
  // Off-canvas hamburger drawer for screens ≤ 960px. Toggling the .open class
  // slides the sidebar in/out; tapping a link or the backdrop closes it;
  // Escape also closes it. The desktop layout (> 960px) is unaffected.

  function closeMobileNav() {
    var sidebar = $('adminSidebar');
    var toggle = $('navToggle');
    var backdrop = $('navBackdrop');
    if (!sidebar || !toggle) return;
    sidebar.classList.remove('open');
    toggle.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Abrir menú');
    if (backdrop) backdrop.classList.add('hidden');
  }

  function openMobileNav() {
    var sidebar = $('adminSidebar');
    var toggle = $('navToggle');
    var backdrop = $('navBackdrop');
    if (!sidebar || !toggle) return;
    sidebar.classList.add('open');
    toggle.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Cerrar menú');
    if (backdrop) backdrop.classList.remove('hidden');
  }

  function bindMobileNav() {
    var toggle = $('navToggle');
    var backdrop = $('navBackdrop');
    var sidebar = $('adminSidebar');
    if (!toggle || !backdrop || !sidebar) return;

    toggle.addEventListener('click', function () {
      if (sidebar.classList.contains('open')) closeMobileNav();
      else openMobileNav();
    });

    backdrop.addEventListener('click', closeMobileNav);

    // Close the drawer when the user picks a nav link (categorías/productos/textos/
    // ver tienda) so they don't get trapped looking at the drawer over the content.
    var navLinks = sidebar.querySelectorAll('.sidebar-link');
    for (var i = 0; i < navLinks.length; i++) {
      navLinks[i].addEventListener('click', function () {
        // Only relevant on mobile layout; harmless on desktop (no .open ever set).
        if (sidebar.classList.contains('open')) closeMobileNav();
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) closeMobileNav();
    });
  }

  // ---- busy states ---------------------------------------------------------------

  function setBusy(btn, busy, busyText) {
    if (!btn) return;
    if (busy) {
      btn.setAttribute('data-idle', btn.textContent);
      btn.setAttribute('disabled', 'disabled');
      if (busyText) btn.textContent = busyText;
    } else {
      btn.removeAttribute('disabled');
      if (btn.hasAttribute('data-idle')) {
        btn.textContent = btn.getAttribute('data-idle');
        btn.removeAttribute('data-idle');
      }
    }
  }

  // ---- status (loading / error / empty) -------------------------------------------

  function setStatus(container, type, message, retryFn) {
    if (!container) return;
    container.innerHTML = '';
    if (type === 'hidden') return;

    var box = document.createElement('div');
    if (type === 'loading') {
      box.className = 'spinner';
      box.setAttribute('aria-live', 'polite');
      box.textContent = message || 'Cargando…';
    } else {
      box.className = 'status-box';
      var p = document.createElement('p');
      p.textContent = message || '';
      box.appendChild(p);
      if (type === 'error' && typeof retryFn === 'function') {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-reintentar';
        btn.textContent = 'Reintentar';
        btn.addEventListener('click', retryFn);
        box.appendChild(btn);
      }
    }
    container.appendChild(box);
  }

  // ---- auth gate + routing ---------------------------------------------------------

  function isAuthed() {
    return !!(window.Supabase && window.Supabase.getSession());
  }

  function currentView() {
    var h = window.location.hash || '';
    if (h.indexOf('#/') !== 0) return 'categorias';
    var name = h.slice(2).split('?')[0];
    return VALID_VIEWS.indexOf(name) !== -1 ? name : 'categorias';
  }

  function navigate(view) {
    window.location.hash = '#/' + view;
  }

  function goLogin() {
    showBanner('Tu sesión expiró. Volvé a iniciar sesión.', 'error');
    navigate('login');
  }

  function showView(name) {
    var shell = $('adminShell');
    var views = document.querySelectorAll('.admin-view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.toggle('hidden', views[i].id !== 'view-' + name);
    }
    if (shell) shell.classList.toggle('hidden', name === 'login');

    var links = document.querySelectorAll('[data-view]');
    for (var j = 0; j < links.length; j++) {
      links[j].classList.toggle('active', links[j].getAttribute('data-view') === name);
    }

    var titles = {
      login: 'Ingresar | Fitness Plus Admin',
      categorias: 'Categorías | Fitness Plus Admin',
      productos: 'Productos | Fitness Plus Admin',
      textos: 'Textos | Fitness Plus Admin'
    };
    document.title = titles[name] || 'Panel de Administración | Fitness Plus';
  }

  function renderView(name) {
    if (name === 'categorias') renderCategories();
    else if (name === 'productos') renderProducts();
    else if (name === 'textos') renderTexts();
  }

  function route() {
    var view = currentView();
    if (!isAuthed()) {
      if (view !== 'login') navigate('login');
      showView('login');
      return;
    }
    if (view === 'login') {
      navigate('categorias');
      return;
    }
    showView(view);
    renderView(view);
  }

  // ---- data loaders ---------------------------------------------------------------

  function loadCatalog() {
    return Promise.all([
      window.Supabase.select('categories', { order: 'sort_order.asc' }),
      window.Supabase.select('products', { order: 'sort_order.asc' })
    ]).then(function (results) {
      state.categories = Array.isArray(results[0]) ? results[0] : [];
      state.products = Array.isArray(results[1]) ? results[1] : [];
    });
  }

  function findCategory(id) {
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].id === id) return state.categories[i];
    }
    return null;
  }

  function findProduct(id) {
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].id === id) return state.products[i];
    }
    return null;
  }

  function productsOfCategory(categoryId) {
    var list = [];
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].category_id === categoryId) list.push(state.products[i]);
    }
    list.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
    return list;
  }

  function featuredList() {
    var list = [];
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].is_featured) list.push(state.products[i]);
    }
    list.sort(function (a, b) {
      var ao = (a.home_order == null) ? Infinity : a.home_order;
      var bo = (b.home_order == null) ? Infinity : b.home_order;
      return ao - bo;
    });
    return list;
  }

  function nextSortOrder(categoryId) {
    var list = productsOfCategory(categoryId);
    var max = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].sort_order > max) max = list[i].sort_order;
    }
    return max + 1;
  }

  function nextHomeOrder() {
    var list = featuredList();
    var max = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].home_order != null && list[i].home_order > max) max = list[i].home_order;
    }
    return max + 1;
  }

  // ---- shared row helpers ----------------------------------------------------------

  function makeThumb(url, alt) {
    var img = document.createElement('img');
    img.className = 'row-thumb';
    img.alt = alt || '';
    img.loading = 'lazy';
    // Keep the thumbnail from becoming the native drag source: the row itself
    // is draggable, so a drag started on the image must drag the whole row.
    img.setAttribute('draggable', 'false');
    img.addEventListener('error', function () { img.classList.add('hidden'); });
    if (url) img.src = url;
    return img;
  }

  function makeRow(thumb, titleEl, metaEl, actions) {
    var row = document.createElement('div');
    row.className = 'admin-row';
    if (thumb) row.appendChild(thumb);
    var main = document.createElement('div');
    main.className = 'row-main';
    if (titleEl) main.appendChild(titleEl);
    if (metaEl) main.appendChild(metaEl);
    row.appendChild(main);
    if (actions && actions.length) {
      var wrap = document.createElement('div');
      wrap.className = 'row-actions';
      for (var i = 0; i < actions.length; i++) wrap.appendChild(actions[i]);
      row.appendChild(wrap);
    }
    return row;
  }

  function iconButton(iconClass, label, onClick, extraClass) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn' + (extraClass ? ' ' + extraClass : '');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    var i = document.createElement('i');
    i.className = iconClass;
    i.setAttribute('aria-hidden', 'true');
    btn.appendChild(i);
    btn.addEventListener('click', onClick);
    return btn;
  }

  // =============================================================================
  // LOGIN / LOGOUT
  // =============================================================================

  function showLoginError(message) {
    var el = $('loginError');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function handleLoginSubmit(e) {
    e.preventDefault();
    var email = $('loginEmail').value.trim();
    var password = $('loginPassword').value;
    var errEl = $('loginError');
    errEl.classList.add('hidden');

    if (!email || !password) {
      showLoginError('Ingresá tu email y contraseña.');
      return;
    }

    setBusy($('loginSubmit'), true, 'Ingresando…');
    window.Supabase.signIn(email, password).then(function () {
      $('loginPassword').value = '';
      navigate('categorias');
    }).catch(function (err) {
      var msg = 'Credenciales inválidas. Revisá tu email y contraseña.';
      if (isNetworkError(err)) msg = 'No pudimos conectarnos. Comprobá tu conexión e intentá de nuevo.';
      if (err && window.Supabase && err instanceof window.Supabase.SupabaseError && err.reason === 'config') {
        msg = 'El panel no está configurado. Revisá js/site-config.js.';
      }
      showLoginError(msg);
    }).then(function () {
      setBusy($('loginSubmit'), false, 'Ingresar');
    });
  }

  function bindLogin() {
    $('loginForm').addEventListener('submit', handleLoginSubmit);
  }

  function logout() {
    window.Supabase.signOut().then(function () {
      showBanner('Sesión cerrada correctamente.', 'success');
      navigate('login');
    });
  }

  // =============================================================================
  // CATEGORIES (task 3.3)
  // =============================================================================

  function renderCategories() {
    closeCategoryForm();
    setStatus($('categoriasStatus'), 'loading', 'Cargando categorías…');
    $('categoriasList').classList.add('hidden');

    loadCatalog().then(function () {
      if (!state.categories.length) {
        setStatus($('categoriasStatus'), 'empty', 'Todavía no hay categorías. Creá la primera.');
        return;
      }
      setStatus($('categoriasStatus'), 'hidden');
      $('categoriasList').classList.remove('hidden');
      renderCategoryRows();
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      setStatus($('categoriasStatus'), 'error',
        'No pudimos cargar las categorías. Comprobá tu conexión e intentá de nuevo.',
        renderCategories);
    });
  }

  function renderCategoryRows() {
    var listEl = $('categoriasList');
    listEl.innerHTML = '';

    for (var i = 0; i < state.categories.length; i++) {
      var cat = state.categories[i];
      var count = productsOfCategory(cat.id).length;

      var title = document.createElement('div');
      title.className = 'row-title';
      title.textContent = cat.name;

      var meta = document.createElement('div');
      meta.className = 'row-meta';
      meta.textContent = 'slug: ' + cat.slug + ' · ' + count + ' producto' + (count === 1 ? '' : 's') +
        ' · orden ' + cat.sort_order;

      var actions = categoryRowActions(cat);

      // DnD onDrop receives (draggedId, targetId, before) — exactly the
      // reorderCategories signature, so the function is passed by reference.
      var row = makeRow(null, title, meta, actions);
      enableRowDrag(row, cat.id, reorderCategories);
      listEl.appendChild(row);
    }
  }

  /**
   * Build the action buttons for a category row. Receives the category as a
   * parameter (not via a loop closure) so each row's buttons act on their own
   * category — ES5 has no block scope, so closures inside a `for` would all
   * capture the last item.
   */
  function categoryRowActions(cat) {
    return [
      iconButton('fas fa-chevron-up', 'Mover ' + cat.name + ' hacia arriba', function () {
        moveCategory(cat.id, -1);
      }),
      iconButton('fas fa-chevron-down', 'Mover ' + cat.name + ' hacia abajo', function () {
        moveCategory(cat.id, 1);
      }),
      iconButton('fas fa-pen', 'Editar ' + cat.name, function () {
        openCategoryForm(cat.id);
      }),
      iconButton('fas fa-trash', 'Eliminar ' + cat.name, function () {
        deleteCategory(cat.id);
      }, 'danger')
    ];
  }

  function moveCategory(id, dir) {
    var sorted = state.categories.slice().sort(function (a, b) {
      return (a.sort_order || 0) - (b.sort_order || 0);
    });
    var idx = -1;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].id === id) { idx = i; break; }
    }
    var j = idx + dir;
    if (idx < 0 || j < 0 || j >= sorted.length) return;

    var a = sorted[idx];
    var b = sorted[j];
    Promise.all([
      window.Supabase.update('categories', a.id, { sort_order: b.sort_order }),
      window.Supabase.update('categories', b.id, { sort_order: a.sort_order })
    ]).then(function () {
      showBanner('Orden actualizado.', 'success');
      renderCategories();
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      showBanner('No se pudo cambiar el orden. Intentá de nuevo.', 'error');
      // One of the two swaps may have applied: reload state so the next move
      // starts from the DB's real order, not a half-applied one.
      loadCatalog().catch(function () { /* best-effort resync */ });
    });
  }

  function openCategoryForm(id) {
    var cat = id ? findCategory(id) : null;
    editingCategoryId = id || null;
    $('categoriaFormTitle').textContent = cat ? 'Editar categoría' : 'Nueva categoría';
    $('categoriaError').classList.add('hidden');

    $('cat-name').value = cat ? cat.name : '';
    $('cat-slug').value = cat ? cat.slug : '';
    $('cat-hero-title').value = cat ? cat.hero_title : '';
    $('cat-hero-subtitle').value = cat ? cat.hero_subtitle : '';
    $('cat-section-title').value = cat ? cat.section_title : '';
    $('cat-section-subtitle').value = cat ? cat.section_subtitle : '';

    var heroUrl = cat && cat.hero_image_url ? cat.hero_image_url : '';
    previousCategoryHeroUrl = heroUrl;
    $('cat-hero-url').value = heroUrl;
    setPreview($('cat-hero-preview'), heroUrl);
    $('btnCatHeroRemove').classList.toggle('hidden', !heroUrl);

    $('categoriasList').classList.add('hidden');
    setStatus($('categoriasStatus'), 'hidden');
    $('categoriaForm').classList.remove('hidden');
    $('categoriaForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('cat-name').focus();
  }

  function closeCategoryForm() {
    $('categoriaForm').classList.add('hidden');
    editingCategoryId = null;
    previousCategoryHeroUrl = null;
    $('cat-hero-file').value = '';
    $('cat-hero-url').value = '';
    setPreview($('cat-hero-preview'), '');
    $('btnCatHeroRemove').classList.add('hidden');
  }

  function removeCategoryHeroImage() {
    // Busy (uploading or saving): an in-flight upload would overwrite the URL
    // right after we clear it, resurrecting the image. Ignore the click.
    if ($('btnSaveCategoria').hasAttribute('disabled')) return;
    $('cat-hero-url').value = '';
    setPreview($('cat-hero-preview'), '');
    $('btnCatHeroRemove').classList.add('hidden');
    // The stored object is deleted only after a successful save (see
    // handleCategorySubmit) so canceling the form never orphans a broken URL.
  }

  function handleCategorySubmit(e) {
    e.preventDefault();
    var errEl = $('categoriaError');
    errEl.classList.add('hidden');

    var name = $('cat-name').value.trim();
    var slug = $('cat-slug').value.trim();
    var heroTitle = $('cat-hero-title').value.trim();
    var heroSubtitle = $('cat-hero-subtitle').value.trim();
    var sectionTitle = $('cat-section-title').value.trim();
    var sectionSubtitle = $('cat-section-subtitle').value.trim();

    if (!name) return showFormError(errEl, 'Ingresá el nombre de la categoría.');
    if (!slug) return showFormError(errEl, 'Ingresá el slug (parte de la URL).');
    if (!SLUG_RE.test(slug)) return showFormError(errEl, 'El slug solo puede contener letras, números y guiones.');
    if (!heroTitle || !heroSubtitle) return showFormError(errEl, 'Completá el título y subtítulo del hero.');
    if (!sectionTitle || !sectionSubtitle) return showFormError(errEl, 'Completá el título y subtítulo de la sección.');

    var heroImageUrl = $('cat-hero-url').value.trim();
    if (heroImageUrl && !/^https?:\/\//i.test(heroImageUrl)) {
      return showFormError(errEl, 'La URL del hero debe ser válida (http/https).');
    }

    setBusy($('btnSaveCategoria'), true, 'Guardando…');
    var payload = {
      name: name,
      slug: slug,
      hero_title: heroTitle,
      hero_subtitle: heroSubtitle,
      section_title: sectionTitle,
      section_subtitle: sectionSubtitle,
      hero_image_url: heroImageUrl || null
    };

    var request;
    if (editingCategoryId) {
      request = window.Supabase.update('categories', editingCategoryId, payload);
    } else {
      payload.id = newId();
      payload.sort_order = nextSortOrderForCategories();
      request = window.Supabase.insert('categories', payload, { upsert: true, onConflict: 'id' });
    }

    request.then(function () {
      if (previousCategoryHeroUrl && heroImageUrl !== previousCategoryHeroUrl) {
        // The image was removed or replaced: the row no longer references the
        // old object, so it can be cleaned up (best-effort, must never block).
        removeStoredObject(previousCategoryHeroUrl);
      }
      showBanner(editingCategoryId ? 'Categoría actualizada.' : 'Categoría creada.', 'success');
      closeCategoryForm();
      renderCategories();
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      if (err && err.code === '23505') {
        showFormError(errEl, 'Ya existe una categoría con ese slug.');
      } else {
        showFormError(errEl, 'No se pudo guardar la categoría. Intentá de nuevo.');
      }
    }).then(function () {
      setBusy($('btnSaveCategoria'), false, 'Guardar categoría');
    });
  }

  function nextSortOrderForCategories() {
    var max = -1;
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].sort_order > max) max = state.categories[i].sort_order;
    }
    return max + 1;
  }

  function deleteCategory(id) {
    var cat = findCategory(id);
    if (!cat) return;
    confirmDialog(
      'Se eliminarán todos los productos de esta categoría. ¿Continuar?',
      'Eliminar'
    ).then(function (confirmed) {
      if (!confirmed) return;
      window.Supabase.remove('categories', id).then(function () {
        showBanner('Categoría eliminada.', 'success');
        renderCategories();
      }).catch(function (err) {
        if (isAuthError(err)) { goLogin(); return; }
        showBanner('No se pudo eliminar la categoría. Intentá de nuevo.', 'error');
      });
    });
  }

  // =============================================================================
  // PRODUCTS (tasks 3.4 + 3.5)
  // =============================================================================

  function renderProducts() {
    closeProductForm();
    setStatus($('productosStatus'), 'loading', 'Cargando productos…');
    $('productosByCategory').classList.add('hidden');
    $('productosDestacados').classList.add('hidden');

    loadCatalog().then(function () {
      if (!state.categories.length) {
        setStatus($('productosStatus'), 'empty',
          'Todavía no hay categorías. Creá una categoría antes de cargar productos.');
        return;
      }
      setStatus($('productosStatus'), 'hidden');
      $('productosByCategory').classList.remove('hidden');
      renderProductsByCategory();
      renderFeaturedProducts();
      syncProductTabs();
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      setStatus($('productosStatus'), 'error',
        'No pudimos cargar los productos. Comprobá tu conexión e intentá de nuevo.',
        renderProducts);
    });
  }

  function hasVariants(p) {
    return !!(p && Array.isArray(p.variants) && p.variants.length > 0);
  }

  function productMetaEl(p) {
    var meta = document.createElement('div');
    meta.className = 'row-meta';

    var brand = document.createElement('span');
    brand.textContent = p.brand;

    var price = document.createElement('span');
    if (p.offer_price != null) {
      price.className = 'price-offer';
      price.textContent = '$' + formatPrice(p.offer_price);
      var original = document.createElement('span');
      original.className = 'price-original';
      original.textContent = '$' + formatPrice(p.price);
      meta.appendChild(brand);
      meta.appendChild(original);
      meta.appendChild(price);
    } else {
      price.textContent = '$' + formatPrice(p.price);
      meta.appendChild(brand);
      meta.appendChild(price);
    }

    if (!p.in_stock) {
      var out = document.createElement('span');
      out.className = 'row-badge badge-agotado';
      out.textContent = 'SIN STOCK';
      meta.appendChild(out);
    }
    if (p.offer_price != null) {
      var of = document.createElement('span');
      of.className = 'row-badge badge-oferta';
      of.textContent = 'OFERTA';
      meta.appendChild(of);
    }
    if (p.is_featured) {
      var f = document.createElement('span');
      f.className = 'row-badge badge-featured';
      f.textContent = '★ DESTACADO';
      meta.appendChild(f);
    }
    if (hasVariants(p)) {
      var vCount = document.createElement('span');
      vCount.className = 'row-meta-variants';
      vCount.textContent = p.variants.length + (p.variants.length === 1 ? ' variante' : ' variantes');
      meta.appendChild(vCount);
    }
    return meta;
  }

  function productRowActions(p, extra) {
    var actions = [];
    if (extra && extra.moveUp) actions.push(iconButton('fas fa-chevron-up', 'Mover hacia arriba', extra.moveUp));
    if (extra && extra.moveDown) actions.push(iconButton('fas fa-chevron-down', 'Mover hacia abajo', extra.moveDown));
    actions.push(iconButton(
      'fas fa-star' + (p.is_featured ? '' : ' far'),
      p.is_featured ? 'Quitar de destacados' : 'Agregar a destacados',
      function () { toggleFeatured(p.id); },
      p.is_featured ? 'star-on' : ''
    ));
    actions.push(iconButton('fas fa-pen', 'Editar ' + p.name, function () { openProductForm(p.id); }));
    actions.push(iconButton('fas fa-trash', 'Eliminar ' + p.name, function () { deleteProduct(p.id); }, 'danger'));
    return actions;
  }

  /**
   * Build the move handlers for a product row. Receives the product as a
   * parameter (not via a loop closure) so each row moves its own product.
   */
  function productMoveActions(p, moveFn) {
    return {
      moveUp: function () { moveFn(p.id, -1); },
      moveDown: function () { moveFn(p.id, 1); }
    };
  }

  function renderProductsByCategory() {
    var wrap = $('productosByCategory');
    wrap.innerHTML = '';

    for (var c = 0; c < state.categories.length; c++) {
      var cat = state.categories[c];
      var list = productsOfCategory(cat.id);

      var groupTitle = document.createElement('h3');
      groupTitle.className = 'group-title';
      groupTitle.textContent = cat.name;
      var count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = String(list.length);
      groupTitle.appendChild(count);
      wrap.appendChild(groupTitle);

      if (!list.length) {
        var empty = document.createElement('div');
        empty.className = 'group-empty';
        empty.textContent = 'Sin productos en esta categoría todavía.';
        wrap.appendChild(empty);
        continue;
      }

      var group = document.createElement('div');
      group.className = 'admin-list';
      // Drop handler receives the group's category id through a parameter (never
      // a loop variable) so every group's rows reorder only within themselves.
      var onProductDrop = productGroupDropHandler(cat.id);
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var title = document.createElement('div');
        title.className = 'row-title';
        title.textContent = p.name;
        var row = makeRow(makeThumb(p.image_url, p.name), title, productMetaEl(p), productRowActions(p, productMoveActions(p, moveProduct)));
        enableRowDrag(row, p.id, onProductDrop);
        group.appendChild(row);
      }
      wrap.appendChild(group);
    }
  }

  function renderFeaturedProducts() {
    var wrap = $('productosDestacados');
    wrap.innerHTML = '';

    var list = featuredList();
    var title = document.createElement('h3');
    title.className = 'group-title';
    title.textContent = 'Destacados en la home';
    var count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(list.length);
    title.appendChild(count);
    wrap.appendChild(title);

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'group-empty';
      empty.textContent = 'No hay productos destacados. Tocá la estrella en un producto para mostrarlo en la home.';
      wrap.appendChild(empty);
      return;
    }

    var group = document.createElement('div');
    group.className = 'admin-list';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var titleEl = document.createElement('div');
      titleEl.className = 'row-title';
      titleEl.textContent = p.name;
      var meta = productMetaEl(p);
      var order = document.createElement('span');
      order.textContent = 'posición ' + (p.home_order != null ? p.home_order : '-');
      meta.appendChild(order);

      var row = makeRow(makeThumb(p.image_url, p.name), titleEl, meta, productRowActions(p, productMoveActions(p, moveFeatured)));
      enableRowDrag(row, p.id, reorderFeatured);
      group.appendChild(row);
    }
    wrap.appendChild(group);
  }

  function syncProductTabs() {
    var tab = document.querySelector('.tab[data-tab="por-categoria"]');
    if (tab) tab.click();
  }

  function bindProductTabs() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        var name = this.getAttribute('data-tab');
        for (var j = 0; j < tabs.length; j++) {
          var active = tabs[j] === this;
          tabs[j].classList.toggle('active', active);
          tabs[j].setAttribute('aria-selected', active ? 'true' : 'false');
        }
        $('productosByCategory').classList.toggle('hidden', name !== 'por-categoria');
        $('productosDestacados').classList.toggle('hidden', name !== 'destacados');
      });
    }
  }

  function moveProduct(id, dir) {
    var p = findProduct(id);
    if (!p) return;
    var list = productsOfCategory(p.category_id);
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { idx = i; break; }
    }
    var j = idx + dir;
    if (idx < 0 || j < 0 || j >= list.length) return;

    var a = list[idx];
    var b = list[j];
    Promise.all([
      window.Supabase.update('products', a.id, { sort_order: b.sort_order }),
      window.Supabase.update('products', b.id, { sort_order: a.sort_order })
    ]).then(function () {
      showBanner('Orden actualizado.', 'success');
      renderProducts();
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      showBanner('No se pudo cambiar el orden. Intentá de nuevo.', 'error');
      // One of the two swaps may have applied: reload state so the next move
      // starts from the DB's real order, not a half-applied one.
      loadCatalog().catch(function () { /* best-effort resync */ });
    });
  }

  function moveFeatured(id, dir) {
    var list = featuredList();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { idx = i; break; }
    }
    var j = idx + dir;
    if (idx < 0 || j < 0 || j >= list.length) return;

    var a = list[idx];
    var b = list[j];
    Promise.all([
      window.Supabase.update('products', a.id, { home_order: b.home_order }),
      window.Supabase.update('products', b.id, { home_order: a.home_order })
    ]).then(function () {
      showBanner('Orden de destacados actualizado.', 'success');
      renderProducts();
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      showBanner('No se pudo cambiar el orden. Intentá de nuevo.', 'error');
      // One of the two swaps may have applied: reload state so the next move
      // starts from the DB's real order, not a half-applied one.
      loadCatalog().catch(function () { /* best-effort resync */ });
    });
  }

  function toggleFeatured(id) {
    var p = findProduct(id);
    if (!p) return;
    var patch = { is_featured: !p.is_featured };
    patch.home_order = patch.is_featured ? nextHomeOrder() : null;
    window.Supabase.update('products', id, patch).then(function () {
      showBanner(patch.is_featured ? 'Producto agregado a destacados.' : 'Producto quitado de destacados.', 'success');
      renderProducts();
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      showBanner('No se pudo actualizar el destacado. Intentá de nuevo.', 'error');
    });
  }

  function deleteProduct(id) {
    var p = findProduct(id);
    if (!p) return;
    confirmDialog('¿Eliminar el producto "' + p.name + '"? Esta acción no se puede deshacer.', 'Eliminar')
      .then(function (confirmed) {
        if (!confirmed) return;
        window.Supabase.remove('products', id).then(function () {
          removeStoredObject(p.image_url);
          removeStoredObject(p.nutrition_image_url);
          // Per-variant orphan cleanup (FLI-6 / SCF-5): each variant photo is
          // removed best-effort IN ADDITION to the main + nutrition images.
          // The loop is not awaited — delete completes regardless of any
          // storage failure (removeStoredObject swallows errors).
          if (Array.isArray(p.variants)) {
            for (var vi = 0; vi < p.variants.length; vi++) {
              if (p.variants[vi] && p.variants[vi].image_url) {
                removeStoredObject(p.variants[vi].image_url);
              }
            }
          }
          showBanner('Producto eliminado.', 'success');
          renderProducts();
        }).catch(function (err) {
          if (isAuthError(err)) { goLogin(); return; }
          showBanner('No se pudo eliminar el producto. Intentá de nuevo.', 'error');
        });
      });
  }

  // =============================================================================
  // DRAG & DROP REORDER (categories, products per category, destacados de home)
  // =============================================================================
  // Native HTML5 drag & drop, layered on top of the existing arrow buttons
  // (which stay as the touch/mobile/accessibility fallback and the precise
  // path). Drops are optimistic: in-memory state is reordered and the list is
  // re-rendered immediately, then only the rows whose order value changed are
  // persisted (Promise.all, like the move functions); on failure state is
  // reloaded so the UI snaps back to the DB's real order.
  //
  // All handlers receive ids/items as parameters — never a closure over a loop
  // variable (same rule that keeps categoryRowActions and productMoveActions
  // bug-free in ES5, which has no block scope).

  /**
   * Persist a batch of sort-order updates. The caller has ALREADY applied the
   * new order to in-memory state and re-rendered (optimistic UI): on success we
   * only confirm with a banner; on failure we resync state from the DB and call
   * rerenderFn so the optimistic reorder is undone.
   */
  function persistReorder(updates, successMessage, rerenderFn) {
    Promise.all(updates).then(function () {
      showBanner(successMessage, 'success');
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      showBanner('No se pudo cambiar el orden. Intentá de nuevo.', 'error');
      // Some of the batched updates may have applied: reload state so the next
      // move starts from the DB's real order, not a half-applied one.
      loadCatalog().then(function () {
        if (typeof rerenderFn === 'function') rerenderFn();
      }).catch(function () { /* best-effort resync */ });
    });
  }

  /** True when the pointer is over the upper half of the row (drop before it). */
  function isInRowTopHalf(e, rowEl) {
    var rect = rowEl.getBoundingClientRect();
    if (!rect || rect.height === 0) return true;
    var y = e.clientY;
    if (y == null) y = 0;
    return y < rect.top + rect.height / 2;
  }

  /** Remove the drop indicators from every row (only one drag at a time). */
  function clearDropIndicators() {
    var rows = document.querySelectorAll('.admin-row.drop-before, .admin-row.drop-after');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.remove('drop-before', 'drop-after');
    }
  }

  function dragFromButton(e) {
    return !!(e.target && typeof e.target.closest === 'function' && e.target.closest('button'));
  }

  /**
   * Make a row draggable and bind the native HTML5 DnD events. onDrop is called
   * as onDrop(draggedId, targetId, before) — all values arrive as parameters,
   * so no closure is ever created over a loop variable.
   */
  function enableRowDrag(rowEl, itemId, onDrop) {
    rowEl.setAttribute('draggable', 'true');

    rowEl.addEventListener('mousedown', function (e) {
      dragPressOnButton = dragFromButton(e);
    });

    rowEl.addEventListener('dragstart', function (e) {
      // Never hijack a drag started on an action button (arrows, edit, delete…).
      // The drag source is the row itself even when the pointer went down on a
      // button, so e.target is not enough: trust the mousedown flag too.
      if (dragPressOnButton || dragFromButton(e)) {
        dragPressOnButton = false;
        e.preventDefault();
        return;
      }
      draggedRowId = itemId;
      rowEl.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(itemId)); } catch (err) { /* older browsers */ }
      }
    });

    rowEl.addEventListener('dragover', function (e) {
      if (draggedRowId === null) return;
      if (draggedRowId === itemId) {
        rowEl.classList.remove('drop-before', 'drop-after');
        return;
      }
      // preventDefault is required to allow the drop.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      var before = isInRowTopHalf(e, rowEl);
      rowEl.classList.toggle('drop-before', before);
      rowEl.classList.toggle('drop-after', !before);
    });

    rowEl.addEventListener('dragleave', function (e) {
      // Ignore boundary crossings between the row's own children.
      var to = e.relatedTarget;
      if (to && rowEl.contains(to)) return;
      rowEl.classList.remove('drop-before', 'drop-after');
    });

    rowEl.addEventListener('drop', function (e) {
      e.preventDefault();
      if (draggedRowId === null || draggedRowId === itemId) return;
      clearDropIndicators();
      var before = isInRowTopHalf(e, rowEl);
      onDrop(draggedRowId, itemId, before);
    });

    rowEl.addEventListener('dragend', function () {
      draggedRowId = null;
      dragPressOnButton = false;
      rowEl.classList.remove('dragging');
      clearDropIndicators();
    });
  }

  /**
   * New order for a group of items: move the item at index `from` to the
   * position of the item at index `to` (before it, or after it when
   * before=false). Returns a reordered copy of the sorted array. The removal
   * shifts the target index left when the dragged item sat before it — that
   * off-by-one is the classic bug this handles.
   */
  function moveInSortedList(sorted, from, to, before) {
    var reordered = sorted.slice();
    var item = reordered.splice(from, 1)[0];
    var insertAt = to;
    if (from < to) insertAt = to - 1;
    if (!before) insertAt += 1;
    reordered.splice(insertAt, 0, item);
    return reordered;
  }

  /** Reorder all categories by drag & drop: sort_order rewritten 0..N-1. */
  function reorderCategories(draggedId, targetId, before) {
    if (draggedId === targetId) return;
    var sorted = state.categories.slice().sort(function (a, b) {
      return (a.sort_order || 0) - (b.sort_order || 0);
    });
    var from = -1;
    var to = -1;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].id === draggedId) from = i;
      if (sorted[i].id === targetId) to = i;
    }
    if (from < 0 || to < 0) return;

    var reordered = moveInSortedList(sorted, from, to, before);
    var changed = [];
    for (var i = 0; i < reordered.length; i++) {
      var cat = reordered[i];
      if (cat.sort_order !== i) changed.push(window.Supabase.update('categories', cat.id, { sort_order: i }));
      cat.sort_order = i;
    }
    if (!changed.length) return; // pure no-op
    state.categories = reordered;
    renderCategoryRows();
    persistReorder(changed, 'Orden actualizado.', renderCategoryRows);
  }

  /**
   * Reorder the products of ONE category group by drag & drop: sort_order
   * rewritten 0..N-1 within the group. Cross-category drops are a no-op.
   */
  function reorderProductsInCategory(catId, draggedId, targetId, before) {
    if (draggedId === targetId) return;
    var list = productsOfCategory(catId);
    var from = -1;
    var to = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === draggedId) from = i;
      if (list[i].id === targetId) to = i;
    }
    // The dragged row does not belong to this group (cross-group drop): no-op.
    if (from < 0 || to < 0) return;

    var reordered = moveInSortedList(list, from, to, before);
    var changed = [];
    for (var i = 0; i < reordered.length; i++) {
      var p = reordered[i];
      if (p.sort_order !== i) changed.push(window.Supabase.update('products', p.id, { sort_order: i }));
      p.sort_order = i;
    }
    if (!changed.length) return; // pure no-op
    renderProductsByCategory();
    persistReorder(changed, 'Orden actualizado.', renderProductsByCategory);
  }

  /**
   * Reorder the featured (home) products by drag & drop: home_order rewritten
   * 1..N. Non-featured products keep home_order null and are never touched.
   */
  function reorderFeatured(draggedId, targetId, before) {
    if (draggedId === targetId) return;
    var list = featuredList();
    var from = -1;
    var to = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === draggedId) from = i;
      if (list[i].id === targetId) to = i;
    }
    if (from < 0 || to < 0) return;

    var reordered = moveInSortedList(list, from, to, before);
    var changed = [];
    for (var i = 0; i < reordered.length; i++) {
      var p = reordered[i];
      var newOrder = i + 1;
      if (p.home_order !== newOrder) changed.push(window.Supabase.update('products', p.id, { home_order: newOrder }));
      p.home_order = newOrder;
    }
    if (!changed.length) return; // pure no-op
    renderFeaturedProducts();
    persistReorder(changed, 'Orden de destacados actualizado.', renderFeaturedProducts);
  }

  /**
   * Build the drop handler for the product rows of ONE category group. Receives
   * the category id as a parameter (never a loop variable) so each group's rows
   * reorder within their own group only.
   */
  function productGroupDropHandler(catId) {
    return function (draggedId, targetId, before) {
      reorderProductsInCategory(catId, draggedId, targetId, before);
    };
  }

  // ---- product form ------------------------------------------------------------

  function fillCategorySelect(selectedId) {
    var sel = $('prod-category');
    sel.innerHTML = '';
    for (var i = 0; i < state.categories.length; i++) {
      var opt = document.createElement('option');
      opt.value = state.categories[i].id;
      opt.textContent = state.categories[i].name;
      sel.appendChild(opt);
    }
    if (selectedId) {
      sel.value = selectedId;
    } else if (state.categories.length) {
      sel.value = state.categories[0].id;
    }
  }

  function openProductForm(id) {
    var p = id ? findProduct(id) : null;
    editingProductId = id || null;
    $('productoFormTitle').textContent = p ? 'Editar producto' : 'Nuevo producto';
    $('productoError').classList.add('hidden');

    fillCategorySelect(p ? p.category_id : null);
    $('prod-name').value = p ? p.name : '';
    $('prod-brand').value = p ? p.brand : '';
    $('prod-price').value = p ? p.price : '';
    $('prod-offer').value = p && p.offer_price != null ? p.offer_price : '';
    $('prod-short').value = p ? p.short_desc : '';
    $('prod-full').value = p ? p.full_desc : '';
    $('prod-stock').disabled = false;
    $('prod-stock').checked = p ? !!p.in_stock : true;
    $('prod-stock-hint').classList.add('hidden');
    $('prod-featured').checked = p ? !!p.is_featured : false;

    var imageUrl = p ? p.image_url : '';
    var nutritionUrl = p && p.nutrition_image_url ? p.nutrition_image_url : '';
    $('prod-image-url').value = imageUrl;
    $('prod-nutrition-url').value = nutritionUrl;
    setPreview($('prod-image-preview'), imageUrl);
    setPreview($('prod-nutrition-preview'), nutritionUrl);

    renderVariantRows(p ? p.variants : null);
    syncStockLock();

    $('productosStatus') && setStatus($('productosStatus'), 'hidden');
    $('productosByCategory').classList.add('hidden');
    $('productosDestacados').classList.add('hidden');
    $('productoForm').classList.remove('hidden');
    $('productoForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('prod-name').focus();
  }

  function closeProductForm() {
    clearVariantRows();
    $('productoForm').classList.add('hidden');
    editingProductId = null;
  }

  // ---- variant rows (flavor-variants) -------------------------------------------

  /**
   * Event-driven stock lock: after every row mutation the stock checkbox is
   * locked (disabled) while any variant row exists, with its checked state
   * showing the derived value (any variant in_stock). Removing all rows
   * re-enables the checkbox in the same form session, restoring it to the
   * product's authoritative in_stock (openProductForm's source) so the lock
   * never leaves a stale derived value behind — "remove all → save" never
   * silently persists a false in_stock the user didn't choose.
   */
  function syncStockLock() {
    var checkbox = $('prod-stock');
    var hint = $('prod-stock-hint');
    var rowEls = $('variantesContainer').querySelectorAll('.variant-row');

    if (rowEls.length > 0) {
      var anyStock = false;
      for (var i = 0; i < rowEls.length; i++) {
        var cb = rowEls[i].querySelector('.variant-stock');
        if (cb && cb.checked) { anyStock = true; break; }
      }
      checkbox.disabled = true;
      checkbox.checked = anyStock;
      if (hint) hint.classList.remove('hidden');
    } else {
      checkbox.disabled = false;
      var p = editingProductId ? findProduct(editingProductId) : null;
      checkbox.checked = p ? !!p.in_stock : true;
      if (hint) hint.classList.add('hidden');
    }
  }

  /**
   * Append one variant row (name + in_stock checkbox + optional photo + remove). Reuses
   * the form-field / btn-ghost patterns; inputs are populated via .value/.checked only
   * (never innerHTML), so a stored variant name cannot inject markup. Each row
   * carries its uploaded photo URL in row.dataset.variantImageUrl ('' = no
   * photo) — collectVariantRows harvests it as image_url ('' coerced to null
   * per FLI-1). imageUrl is the 3rd arg so renderVariantRows can re-populate
   * an existing product's variant photos. The add button is disabled at
   * MAX_VARIANTS rows. Runs syncStockLock after every mutation.
   */
  function addVariantRow(name, inStock, imageUrl) {
    var container = $('variantesContainer');

    variantRowSeq += 1;
    var rowSuffix = String(variantRowSeq);

    var row = document.createElement('div');
    row.className = 'variant-row';
    row.dataset.variantImageUrl = imageUrl || '';

    var nameField = document.createElement('div');
    nameField.className = 'form-field';
    var nameLabel = document.createElement('label');
    nameLabel.htmlFor = 'variant-name-' + rowSuffix;
    nameLabel.textContent = 'Sabor';
    var nameInput = document.createElement('input');
    nameInput.id = 'variant-name-' + rowSuffix;
    nameInput.type = 'text';
    nameInput.className = 'variant-name';
    nameInput.maxLength = String(MAX_VARIANT_NAME_LENGTH);
    nameInput.setAttribute('autocomplete', 'off');
    nameInput.placeholder = 'Ej: Naranja';
    nameInput.value = name == null ? '' : String(name);
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);

    var stockField = document.createElement('div');
    stockField.className = 'form-field';
    var stockLabel = document.createElement('label');
    stockLabel.htmlFor = 'variant-stock-' + rowSuffix;
    stockLabel.className = 'checkbox-label';
    var stockInput = document.createElement('input');
    stockInput.id = 'variant-stock-' + rowSuffix;
    stockInput.type = 'checkbox';
    stockInput.className = 'variant-stock';
    stockInput.checked = inStock !== false;
    stockLabel.appendChild(stockInput);
    stockLabel.appendChild(document.createTextNode('Disponible'));
    stockField.appendChild(stockLabel);

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-ghost btn-small variant-remove';
    removeBtn.setAttribute('aria-label', 'Quitar variante');
    var icon = document.createElement('i');
    icon.className = 'fas fa-times';
    icon.setAttribute('aria-hidden', 'true');
    removeBtn.appendChild(icon);

    // Optional per-variant photo (FLI-7): hidden file input + "Elegir foto"
    // label + thumbnail preview. Rendered ONLY inside variant rows — a
    // variant-less product shows no photo control. Wraps to its own grid row
    // below the name/available/remove trio (admin.css .variant-photo).
    var photoField = document.createElement('div');
    photoField.className = 'form-field variant-photo';

    var photoInput = document.createElement('input');
    photoInput.type = 'file';
    photoInput.id = 'variant-photo-' + rowSuffix;
    photoInput.className = 'file-input';
    photoInput.accept = 'image/png,image/jpeg,image/webp';
    photoInput.setAttribute('aria-label', 'Foto de la variante');

    var photoLabel = document.createElement('label');
    photoLabel.htmlFor = photoInput.id;
    photoLabel.className = 'btn-ghost btn-small file-label';
    photoLabel.textContent = 'Elegir foto';

    var photoPreview = document.createElement('img');
    photoPreview.className = 'variant-photo-preview';
    photoPreview.alt = '';
    photoPreview.setAttribute('aria-hidden', 'true');

    photoField.appendChild(photoInput);
    photoField.appendChild(photoLabel);
    photoField.appendChild(photoPreview);

    row.appendChild(nameField);
    row.appendChild(stockField);
    row.appendChild(removeBtn);
    row.appendChild(photoField);
    container.appendChild(row);

    // Populate the preview when re-rendering an existing product (imageUrl
    // non-empty); a null/empty value leaves the hidden placeholder state.
    setPreview(photoPreview, imageUrl || '');
    bindVariantUpload(row);

    $('variantesEmpty').classList.add('hidden');
    if (container.children.length >= MAX_VARIANTS) {
      $('btnAddVariante').setAttribute('disabled', 'disabled');
    }
    syncStockLock();
  }

  /** Empty the container, restore the empty-state hint and the add button. */
  function clearVariantRows() {
    $('variantesContainer').innerHTML = '';
    $('variantesEmpty').classList.remove('hidden');
    $('btnAddVariante').removeAttribute('disabled');
    syncStockLock();
  }

  /** Populate the rows from a product's saved variants (null/[] → no rows).
   *  Each variant's image_url (if any) feeds the row's photo preview. */
  function renderVariantRows(variants) {
    clearVariantRows();
    if (Array.isArray(variants)) {
      for (var i = 0; i < variants.length; i++) {
        var v = variants[i] || {};
        addVariantRow(v.name, v.in_stock, v.image_url);
      }
    }
  }

  /** Row removal (delegated on the container — CSP-safe, no inline handlers).
   *  Best-effort orphan cleanup: an uploaded variant photo is removed from
   *  storage BEFORE the row leaves the DOM (FLI-6 / SCF-4) — remove never
   *  blocks on a storage failure (removeStoredObject swallows errors). */
  function handleVariantesClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.variant-remove') : null;
    if (!btn) return;
    var row = btn.closest('.variant-row');
    if (!row || !row.parentNode) return;
    var rowImageUrl = row.dataset.variantImageUrl || '';
    if (rowImageUrl) removeStoredObject(rowImageUrl);
    row.parentNode.removeChild(row);
    if ($('variantesContainer').querySelectorAll('.variant-row').length === 0) {
      $('variantesEmpty').classList.remove('hidden');
    }
    $('btnAddVariante').removeAttribute('disabled');
    syncStockLock();
  }

  /** Stock checkbox changes re-derive the locked checkbox state (event-driven lock). */
  function handleVariantesInput(e) {
    if (e.target && e.target.classList && e.target.classList.contains('variant-stock')) {
      syncStockLock();
    }
  }

  function setPreview(img, url) {
    if (url) {
      img.src = url;
      img.classList.remove('hidden');
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
    }
  }

  function showFormError(errEl, message) {
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  }

  /**
   * Read the variant rows into a payload-ready array, validating per FV-1:
   * trimmed non-empty name ≤ 40 chars, unique case-insensitively, ≤ 10 rows,
   * boolean in_stock per variant. Fully-empty rows are skipped. Each harvested
   * row also carries image_url (FLI-1): the uploaded public URL when the row
   * has one, null when empty/missing — legacy rows without the dataset key
   * harvest as null. Returns {rows} or {error} in the existing Spanish error
   * style.
   */
  function collectVariantRows() {
    var rows = [];
    var seen = {};
    var rowEls = $('variantesContainer').querySelectorAll('.variant-row');

    if (rowEls.length > MAX_VARIANTS) {
      return { error: 'No podés cargar más de ' + MAX_VARIANTS + ' variantes.' };
    }

    for (var i = 0; i < rowEls.length; i++) {
      var nameInput = rowEls[i].querySelector('.variant-name');
      var stockInput = rowEls[i].querySelector('.variant-stock');
      var name = (nameInput ? nameInput.value : '').trim();

      if (!name) continue; // empty row: skip

      if (name.length > MAX_VARIANT_NAME_LENGTH) {
        return { error: 'El nombre de la variante no puede superar los ' + MAX_VARIANT_NAME_LENGTH + ' caracteres.' };
      }

      var lower = name.toLowerCase();
      if (seen[lower]) return { error: 'Ya existe una variante llamada "' + name + '".' };
      seen[lower] = true;

      var inStock = stockInput ? !!stockInput.checked : true;

      var rowUrl = rowEls[i].dataset.variantImageUrl || '';
      rows.push({ name: name, in_stock: inStock, image_url: rowUrl || null });
    }

    return { rows: rows };
  }

  function validateProductPayload() {
    var name = $('prod-name').value.trim();
    var brand = $('prod-brand').value.trim();
    var categoryId = $('prod-category').value;
    var priceRaw = $('prod-price').value.trim();
    var offerRaw = $('prod-offer').value.trim();
    var shortDesc = $('prod-short').value.trim();
    var fullDesc = $('prod-full').value.trim();
    var imageUrl = $('prod-image-url').value.trim();
    var nutritionUrl = $('prod-nutrition-url').value.trim();

    if (!name) return { error: 'Ingresá el nombre del producto.' };
    if (!brand) return { error: 'Ingresá la marca.' };
    if (!categoryId) return { error: 'Elegí una categoría.' };

    var price = Number(priceRaw);
    if (!priceRaw || !isFinite(price) || price <= 0 || Math.floor(price) !== price) {
      return { error: 'Ingresá un precio válido mayor a 0.' };
    }

    var offer = null;
    if (offerRaw) {
      offer = Number(offerRaw);
      if (!isFinite(offer) || offer <= 0 || Math.floor(offer) !== offer) {
        return { error: 'Ingresá un precio de oferta válido.' };
      }
      if (offer >= price) {
        return { error: 'El precio de oferta debe ser menor al precio original.' };
      }
    }

    if (!shortDesc) return { error: 'Ingresá la descripción corta.' };
    if (!fullDesc) return { error: 'Ingresá la descripción completa.' };
    if (!imageUrl) return { error: 'Subí o pegá la URL de la imagen principal.' };
    if (!isHttpUrl(imageUrl)) {
      return { error: 'La URL de la imagen principal debe ser una URL válida (http/https).' };
    }
    if (nutritionUrl && !isHttpUrl(nutritionUrl)) {
      return { error: 'La URL de la tabla nutricional debe ser una URL válida (http/https).' };
    }

    var variantResult = collectVariantRows();
    if (variantResult.error) return variantResult;
    var rows = variantResult.rows;

    return {
      name: name,
      brand: brand,
      category_id: categoryId,
      price: price,
      offer_price: offer,
      short_desc: shortDesc,
      full_desc: fullDesc,
      image_url: imageUrl,
      nutrition_image_url: nutritionUrl || null,
      variants: rows.length ? rows : null,
      in_stock: rows.length ? rows.some(function (v) { return v.in_stock; }) : $('prod-stock').checked,
      is_featured: $('prod-featured').checked
    };
  }

  function handleProductSubmit(e) {
    e.preventDefault();
    var errEl = $('productoError');
    errEl.classList.add('hidden');

    var payload = validateProductPayload();
    if (payload.error) {
      showFormError(errEl, payload.error);
      return;
    }

    setBusy($('btnSaveProducto'), true, 'Guardando…');

    var request;
    if (editingProductId) {
      var existing = findProduct(editingProductId);
      payload.home_order = payload.is_featured
        ? (existing && existing.home_order != null ? existing.home_order : nextHomeOrder())
        : null;
      request = window.Supabase.update('products', editingProductId, payload);
    } else {
      payload.id = newId();
      payload.sort_order = nextSortOrder(payload.category_id);
      payload.home_order = payload.is_featured ? nextHomeOrder() : null;
      request = window.Supabase.insert('products', payload, { upsert: true, onConflict: 'id' });
    }

    request.then(function () {
      showBanner(editingProductId ? 'Producto actualizado.' : 'Producto creado.', 'success');
      closeProductForm();
      renderProducts();
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      showFormError(errEl, 'No se pudo guardar el producto. Revisá los datos e intentá de nuevo.');
    }).then(function () {
      setBusy($('btnSaveProducto'), false, 'Guardar producto');
    });
  }

  // ---- image upload (task 3.5) ---------------------------------------------------

  function isValidImage(file) {
    if (!file) return false;
    if (file.size > MAX_IMAGE_BYTES) return false;
    if (IMAGE_TYPES[file.type]) return true;
    return IMAGE_EXTS.test(file.name);
  }

  function safeFileName(name) {
    var cleaned = String(name || '').replace(/[^a-zA-Z0-9._-]+/g, '-');
    return cleaned || 'imagen';
  }

  /**
   * Best-effort delete of a stored object referenced by a public URL of the
   * `productos` bucket (used when deleting a product or replacing its image).
   * Failures are swallowed — orphan cleanup must never block the main action.
   */
  function removeStoredObject(url) {
    if (!url) return;
    var marker = '/storage/v1/object/public/' + BUCKET + '/';
    var idx = url.indexOf(marker);
    if (idx === -1) return;
    var path = url.slice(idx + marker.length);
    try { path = decodeURIComponent(path); } catch (e) { /* keep raw path */ }
    window.Supabase.removeObject(BUCKET, path).catch(function () { /* best-effort */ });
  }

  /**
   * Bind one file input → URL input + preview pair.
   * Preview via FileReader.readAsDataURL (data: URL — allowed by img-src data:).
   * URL.createObjectURL is NEVER used for image previews.
   */
  function bindUpload(fileInputId, urlInputId, previewId, busyButtonId, removeButtonId) {
    busyButtonId = busyButtonId || 'btnSaveProducto';
    var fileInput = $(fileInputId);
    var urlInput = $(urlInputId);
    var preview = $(previewId);

    fileInput.addEventListener('change', function () {
      var file = fileInput.files[0];
      if (!file) return;

      if (!isValidImage(file)) {
        showBanner('El archivo debe ser una imagen (PNG/JPG/WEBP) de hasta 2MB.', 'error');
        fileInput.value = '';
        return;
      }

      var reader = new FileReader();
      reader.onload = function () {
        preview.src = reader.result;
        preview.classList.remove('hidden');
      };
      reader.onerror = function () { /* preview is best-effort */ };
      reader.readAsDataURL(file);

      var path = 'admin/' + Date.now() + '-' + safeFileName(file.name);
      fileInput.setAttribute('disabled', 'disabled');
      setBusy($(busyButtonId), true, 'Subiendo imagen…');
      window.Supabase.upload(BUCKET, path, file, { timeout: 30000 }).then(function () {
        var previousUrl = urlInput.value.trim();
        urlInput.value = window.Supabase.publicUrl(BUCKET, path);
        if (previousUrl) removeStoredObject(previousUrl);
        if (removeButtonId) $(removeButtonId).classList.remove('hidden');
        showBanner('Imagen subida correctamente.', 'success');
      }).catch(function (err) {
        if (isAuthError(err)) { goLogin(); return; }
        showBanner('No se pudo subir la imagen. Intentá de nuevo.', 'error');
        // Never leave a preview of a file that was not saved: restore the
        // preview to whatever the URL field currently holds.
        setPreview(preview, urlInput.value.trim());
        if (removeButtonId) $(removeButtonId).classList.toggle('hidden', !urlInput.value.trim());
      }).then(function () {
        fileInput.removeAttribute('disabled');
        fileInput.value = '';
        setBusy($(busyButtonId), false, 'Guardar ' + (busyButtonId === 'btnSaveCategoria' ? 'categoría' : 'producto'));
      });
    });

    // Manual URL edits update the preview too.
    urlInput.addEventListener('input', function () {
      setPreview(preview, urlInput.value.trim());
    });
  }

  /**
   * Bind one variant row's photo input → thumbnail preview + dataset URL
   * (FLI-7 / SCF-4). Mirrors bindUpload verbatim: 'admin/' + timestamp +
   * safeFileName path, bucket 'productos', png/jpeg/webp ≤ 2MB, 30s timeout,
   * FileReader data: preview (never URL.createObjectURL), and delete-on-replace
   * of the row's PREVIOUS URL via removeStoredObject (best-effort) BEFORE the
   * new one is stashed. On success the public URL is saved in
   * row.dataset.variantImageUrl so collectVariantRows can harvest it.
   */
  function bindVariantUpload(rowEl) {
    var fileInput = rowEl.querySelector('.variant-photo input[type="file"]');
    var preview = rowEl.querySelector('.variant-photo img');
    if (!fileInput || !preview) return;

    fileInput.addEventListener('change', function () {
      var file = fileInput.files[0];
      if (!file) return;

      if (!isValidImage(file)) {
        showBanner('El archivo debe ser una imagen (PNG/JPG/WEBP) de hasta 2MB.', 'error');
        fileInput.value = '';
        return;
      }

      var reader = new FileReader();
      reader.onload = function () {
        preview.src = reader.result;
        preview.classList.remove('hidden');
      };
      reader.onerror = function () { /* preview is best-effort */ };
      reader.readAsDataURL(file);

      var path = 'admin/' + Date.now() + '-' + safeFileName(file.name);
      fileInput.setAttribute('disabled', 'disabled');
      setBusy($('btnSaveProducto'), true, 'Subiendo imagen…');
      window.Supabase.upload(BUCKET, path, file, { timeout: 30000 }).then(function () {
        var previousUrl = rowEl.dataset.variantImageUrl || '';
        rowEl.dataset.variantImageUrl = window.Supabase.publicUrl(BUCKET, path);
        if (previousUrl) removeStoredObject(previousUrl);
        showBanner('Imagen subida correctamente.', 'success');
      }).catch(function (err) {
        if (isAuthError(err)) { goLogin(); return; }
        showBanner('No se pudo subir la imagen. Intentá de nuevo.', 'error');
        // Never leave a preview of a file that was not saved: restore the
        // preview to whatever the row currently holds.
        setPreview(preview, rowEl.dataset.variantImageUrl || '');
      }).then(function () {
        fileInput.removeAttribute('disabled');
        fileInput.value = '';
        setBusy($('btnSaveProducto'), false, 'Guardar producto');
      });
    });
  }

  // =============================================================================
  // TEXTS (task 3.6)
  // =============================================================================

  function renderTexts() {
    setStatus($('textosStatus'), 'loading', 'Cargando textos…');
    $('textosForm').classList.add('hidden');

    window.Supabase.select('site_texts').then(function (rows) {
      state.texts = indexTexts(Array.isArray(rows) ? rows : []);
      setStatus($('textosStatus'), 'hidden');
      $('textosForm').classList.remove('hidden');
      fillTextForm();
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      setStatus($('textosStatus'), 'error',
        'No pudimos cargar los textos. Comprobá tu conexión e intentá de nuevo.',
        renderTexts);
    });
  }

  function fillTextForm() {
    var inputs = document.querySelectorAll('[data-text-key]');
    for (var i = 0; i < inputs.length; i++) {
      var key = inputs[i].getAttribute('data-text-key');
      var value = state.texts[key];
      inputs[i].value = (value === undefined || value === null) ? '' : value;
    }
  }

  function handleTextsSubmit(e) {
    e.preventDefault();
    var errEl = $('textosError');
    errEl.classList.add('hidden');

    var changed = [];
    var inputs = document.querySelectorAll('[data-text-key]');
    for (var i = 0; i < inputs.length; i++) {
      var key = inputs[i].getAttribute('data-text-key');
      var value = inputs[i].type === 'number' ? inputs[i].value : inputs[i].value.trim();
      var original = state.texts[key];
      original = (original === undefined || original === null) ? '' : original;

      if (key === 'home_featured_max') {
        var n = parseInt(value, 10);
        if (value === '' || isNaN(n) || n < 1 || n > 6) {
          showFormError(errEl, 'El máximo de productos destacados debe ser un número entre 1 y 6.');
          return;
        }
        value = String(n);
      }

      if (String(original) !== String(value)) {
        changed.push({ key: key, value: value });
      }
    }

    if (!changed.length) {
      showBanner('No hay cambios para guardar.', 'success');
      return;
    }

    setBusy($('btnSaveTextos'), true, 'Guardando…');
    window.Supabase.insert('site_texts', changed, { upsert: true, onConflict: 'key' }).then(function () {
      for (var i = 0; i < changed.length; i++) state.texts[changed[i].key] = changed[i].value;
      showBanner('Textos guardados. La página pública ya muestra los cambios.', 'success');
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      showFormError(errEl, 'No se pudieron guardar los textos. Intentá de nuevo.');
    }).then(function () {
      setBusy($('btnSaveTextos'), false, 'Guardar textos');
    });
  }

  // =============================================================================
  // EXPORT (task 3.7)
  // =============================================================================

  function exportBackup() {
    var btn = $('btnExportar');
    // Disable without touching textContent (the button contains an <i> icon).
    btn.setAttribute('disabled', 'disabled');

    Promise.all([
      window.Supabase.select('categories', { order: 'sort_order.asc', limit: 10000 }),
      window.Supabase.select('products', { order: 'sort_order.asc', limit: 10000 }),
      window.Supabase.select('site_texts', { order: 'key.asc', limit: 10000 })
    ]).then(function (results) {
      var catRows = Array.isArray(results[0]) ? results[0] : [];
      var prodRows = Array.isArray(results[1]) ? results[1] : [];
      var textRows = Array.isArray(results[2]) ? results[2] : [];
      var data = {
        exported_at: new Date().toISOString(),
        categories: { count: catRows.length, rows: catRows },
        products: { count: prodRows.length, rows: prodRows },
        site_texts: { count: textRows.length, rows: textRows }
      };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var objectUrl = window.URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = objectUrl;
      a.download = 'respaldo-fitness-plus-' + localDateISO(new Date()) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(function () { window.URL.revokeObjectURL(objectUrl); }, 4000);
      showBanner('Respaldo descargado.', 'success');
    }).catch(function (err) {
      if (isAuthError(err)) { goLogin(); return; }
      showBanner('No se pudo exportar el respaldo. Intentá de nuevo.', 'error');
    }).then(function () {
      btn.removeAttribute('disabled');
    });
  }

  // =============================================================================
  // INIT
  // =============================================================================

  function init() {
    if (!window.Supabase) {
      showView('login');
      showLoginError('No se pudo cargar el cliente de Supabase. Revisá la consola.');
      return;
    }

    bindLogin();
    $('btnLogout').addEventListener('click', logout);
    $('btnExportar').addEventListener('click', exportBackup);
    $('btnNuevaCategoria').addEventListener('click', function () { openCategoryForm(null); });
    $('btnCloseCategoria').addEventListener('click', function () {
      closeCategoryForm();
      renderCategories();
    });
    $('categoriaForm').addEventListener('submit', handleCategorySubmit);
    $('btnCatHeroRemove').addEventListener('click', removeCategoryHeroImage);
    $('btnNuevoProducto').addEventListener('click', function () { openProductForm(null); });
    $('btnCloseProducto').addEventListener('click', function () {
      closeProductForm();
      renderProducts();
    });
    $('btnAddVariante').addEventListener('click', function () { addVariantRow(null, null); });
    $('variantesContainer').addEventListener('click', handleVariantesClick);
    $('variantesContainer').addEventListener('input', handleVariantesInput);
    $('productoForm').addEventListener('submit', handleProductSubmit);
    $('textosForm').addEventListener('submit', handleTextsSubmit);
    bindProductTabs();
    bindUpload('prod-image-file', 'prod-image-url', 'prod-image-preview');
    bindUpload('prod-nutrition-file', 'prod-nutrition-url', 'prod-nutrition-preview');
    bindUpload('cat-hero-file', 'cat-hero-url', 'cat-hero-preview', 'btnSaveCategoria', 'btnCatHeroRemove');
    bindModal();
    bindMobileNav();

    window.addEventListener('hashchange', route);
    // React to session changes made in another tab (logout clears
    // fitnessplus_admin_session): re-run the auth gate so a zombie tab is
    // kicked back to login instead of keeping a dead session.
    window.addEventListener('storage', function (e) {
      if (e.key === 'fitnessplus_admin_session') route();
    });
    route();
  }

  init();
})();
