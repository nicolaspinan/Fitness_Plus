(function () {

  // Static UI behaviors only (navbar, mobile menu, scroll reveal, back-to-top).
  // Catalog rendering (grids, cards, product detail, buscador, JSON-LD) moved
  // to js/catalog.js — loaded BEFORE this file (site-config → supabase →
  // catalog → main).

  const observer = new IntersectionObserver(function (entries) {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.1 });

  const backBtn = document.getElementById('backToTop');
  if (backBtn) {
    window.addEventListener('scroll', function () {
      backBtn.classList.toggle('visible', window.scrollY > 400);
    });
    backBtn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  document.querySelectorAll('.reveal:not(.producto-card)').forEach(el => observer.observe(el));

  const productosTrigger = document.getElementById('productosTrigger');
  const dropdownMenu = document.getElementById('dropdownMenu');

  function openDropdown() {
    if (!dropdownMenu) return;
    dropdownMenu.classList.add('show');
    if (productosTrigger) {
      productosTrigger.setAttribute('aria-expanded', 'true');
      productosTrigger.classList.add('is-open');
    }
    const firstItem = dropdownMenu.querySelector('a');
    if (firstItem) firstItem.focus();
  }

  function closeDropdown(returnFocus) {
    if (!dropdownMenu) return;
    dropdownMenu.classList.remove('show');
    if (productosTrigger) {
      productosTrigger.setAttribute('aria-expanded', 'false');
      productosTrigger.classList.remove('is-open');
    }
    if (returnFocus && productosTrigger) productosTrigger.focus();
  }

  function toggleDropdown() {
    if (!dropdownMenu) return;
    if (dropdownMenu.classList.contains('show')) {
      closeDropdown(true);
    } else {
      openDropdown();
    }
  }

  if (productosTrigger) {
    productosTrigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleDropdown();
    });

    productosTrigger.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && dropdownMenu.classList.contains('show')) {
        e.preventDefault();
        closeDropdown(true);
      }
    });
  }

  if (dropdownMenu) {
    dropdownMenu.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDropdown(true);
      }
    });
  }

  document.addEventListener('click', function (e) {
    const dropdown = document.querySelector('.dropdown');
    if (dropdown && !dropdown.contains(e.target) && dropdownMenu) {
      closeDropdown(false);
    }
  });

  const navbar = document.getElementById('navbar');
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');

  function openMobileMenu() {
    if (!navLinks || !navToggle) return;
    // Content starts below the fixed navbar so the X button never overlaps the first link.
    if (navbar) navLinks.style.paddingTop = (navbar.offsetHeight + 8) + 'px';
    navLinks.classList.add('open');
    navToggle.setAttribute('aria-expanded', 'true');
    navToggle.setAttribute('aria-label', 'Cerrar menú');
    const icon = navToggle.querySelector('i');
    if (icon) icon.className = 'fas fa-times';
    document.body.classList.add('menu-lock', 'menu-open');
    closeDropdown(false); // submenu starts collapsed on each open
  }

  function closeMobileMenu(returnFocus) {
    if (!navLinks || !navToggle) return;
    navLinks.style.paddingTop = '';
    navLinks.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', 'Abrir menú');
    const icon = navToggle.querySelector('i');
    if (icon) icon.className = 'fas fa-bars';
    document.body.classList.remove('menu-lock', 'menu-open');
    if (returnFocus) navToggle.focus();
  }

  if (navToggle) {
    navToggle.addEventListener('click', function () {
      if (navLinks.classList.contains('open')) {
        closeMobileMenu(true);
      } else {
        openMobileMenu();
      }
    });

    navToggle.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && navLinks.classList.contains('open')) {
        e.preventDefault();
        closeMobileMenu(true);
      }
    });
  }

  if (navLinks) {
    navLinks.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && navLinks.classList.contains('open')) {
        e.preventDefault();
        closeMobileMenu(true);
      }
    });
  }

  // Close the mobile drawer when tapping outside it (scrim or page).
  // navToggle lives outside navLinks, so exclude it explicitly or the toggle
  // would open the drawer and immediately close it again.
  document.addEventListener('click', function (e) {
    if (!navLinks || !navToggle) return;
    if (!navLinks.classList.contains('open')) return;
    if (navLinks.contains(e.target) || navToggle.contains(e.target)) return;
    closeMobileMenu(false);
  });

  document.querySelectorAll('.nav-link, .dropdown-cat-link, .dropdown-item').forEach(link => {
    link.addEventListener('click', function () {
      if (this.classList.contains('dropdown-trigger')) return;
      if (navLinks.classList.contains('open')) closeMobileMenu(false);
      closeDropdown(false);
    });
  });

  let ticking = false;
  window.addEventListener('scroll', function () {
    if (!ticking) {
      requestAnimationFrame(function () {
        navbar.classList.toggle('scrolled', window.scrollY > 60);
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });

  const pageName = window.location.pathname.split('/').pop() || 'index.html';

  if (pageName === 'index.html') {
    const sections = document.querySelectorAll('section[id]');
    const scrollLinks = document.querySelectorAll('a.nav-link[href^="#"]');

    function updateActiveLink() {
      let current = '';
      sections.forEach(section => {
        const top = section.offsetTop - 120; // matches the fixed navbar height (see scroll-margin-top in styles.css)
        if (window.scrollY >= top) {
          current = section.getAttribute('id');
        }
      });
      scrollLinks.forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('href') === '#' + current) {
          link.classList.add('active');
        }
      });
    }

    window.addEventListener('scroll', updateActiveLink);
  }

  // Ripple on primary buttons only. Product cards get their ripple from
  // catalog.js (buildCard) — applying it here too would spawn a second span.
  document.querySelectorAll('.btn-primary').forEach(el => {
    el.classList.add('ripple');
    el.addEventListener('click', function (e) {
      const rect = this.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const span = document.createElement('span');
      span.className = 'ripple-effect';
      span.style.width = span.style.height = size + 'px';
      span.style.left = (e.clientX - rect.left - size / 2) + 'px';
      span.style.top = (e.clientY - rect.top - size / 2) + 'px';
      this.appendChild(span);
      span.addEventListener('animationend', () => span.remove());
    });
  });

  // Back button: navigate back when there is a previous entry, else fall back to index.html.
  // Delegated at document level because catalog.js re-renders the detalle
  // container (and its #btnVolver anchor) on every load. Select by id only:
  // catalog.js renderNotFound also emits a .btn-volver link whose semantics are
  // the opposite ("Volver al inicio" = always go home), and it has no id.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('#btnVolver');
    if (!btn) return;
    if (document.referrer && window.history.length > 1) {
      e.preventDefault();
      window.history.back();
    }
    // else: let the href="index.html" fallback proceed
  });

})();
