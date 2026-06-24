(function () {

  const fullProductos = [
    {
      nombre: 'CREATINA MYPROTEIN',
      descripcion: 'Creatina pura en polvo sin aditivos. Ideal para aumentar masa muscular y recuperación.',
      precio: 29900,
      img: 'img/Creatinas/creatina_myprotein.png',
      tabla: 'img/tablas_nutricionales/myprotein_tabla.jpeg',
      categoria: 'creatina',
      marca: 'MyProtein'
    },
    {
      nombre: 'CREATINA STAR NUTRITION',
      descripcion: 'Fórmula premium de creatina micronizada. Maximizá tu explosividad en cada serie.',
      precio: 28800,
      img: 'img/Creatinas/creatina_starnutrition.png',
      tabla: 'img/tablas_nutricionales/starnutriton_tabla.jpeg',
      categoria: 'creatina',
      marca: 'Star Nutrition'
    },
    {
      nombre: 'CREATINA ENA',
      descripcion: 'Creatina de alta pureza con rápida absorción. Resultados visibles en semanas.',
      precio: 29600,
      img: 'img/Creatinas/creatina_ena.png',
      tabla: 'img/tablas_nutricionales/ena_tabla.jpeg',
      categoria: 'creatina',
      marca: 'ENA'
    },
    {
      nombre: 'CREATINA GOOM',
      descripcion: 'Creatina micronizada de alta pureza con rápida absorción. Potenciá tu fuerza y rendimiento al máximo.',
      precio: 39900,
      img: 'img/Creatinas/goom_creatina3.png',
      tabla: 'img/tablas_nutricionales/goom_tabla.png',
      categoria: 'creatina',
      marca: 'Goom'
    },
    {
      nombre: 'PRE-WORKOUT PREWAR',
      descripcion: 'Explosión de energía extrema con beta-alanina y cafeína. Llevá tu entreno al límite.',
      precio: 34400,
      img: 'img/Preentrenos/preentrenos_prewar.png',
      tabla: 'img/tablas_nutricionales/prewar_tabla.jpeg',
      categoria: 'preentreno',
      marca: 'PreWar'
    },
    {
      nombre: 'PRE-WORKOUT PUMP V8',
      descripcion: 'Pre-entreno avanzado con óxido nítrico para vascularización y pumps increíbles.',
      precio: 35500,
      img: 'img/Preentrenos/preentrenos_pumpv8_sandia.png',
      tabla: 'img/tablas_nutricionales/pump-v8_sandia_tabla.jpg',
      categoria: 'preentreno',
      marca: 'Pump V8'
    }
  ];

  const SITE_URL = 'https://fitnessplus.com';

  const page = window.location.pathname.split('/').pop();

  function slugify(text) {
    return text.toString().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function renderCards(filtro) {
    const grid = document.getElementById('productosGrid');
    if (!grid) return;

    fullProductos.forEach((p, idx) => {
      if (filtro && p.categoria !== filtro) return;

      const card = document.createElement('div');
      card.className = 'producto-card reveal';
      card.setAttribute('role', 'listitem');
      card.setAttribute('aria-label', p.nombre + ' — $' + p.precio.toLocaleString('es-AR'));
      card.tabIndex = 0;
      card.addEventListener('click', function (e) {
        if (e.target.closest('.btn-pedir')) return;
        pageTransition('producto.html?id=' + idx);
      });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (e.target.closest('.btn-pedir')) return;
          pageTransition('producto.html?id=' + idx);
        }
      });
      card.innerHTML = `
        <div class="producto-img">
          <img src="${p.img}" alt="${p.nombre}" loading="lazy" width="400" height="240">
        </div>
        <div class="producto-info">
          <h3>${p.nombre}</h3>
          <p class="descripcion">${p.descripcion}</p>
          <div class="precio-row">
            <p class="precio" aria-label="Precio ${p.precio.toLocaleString('es-AR')} pesos">$${p.precio.toLocaleString('es-AR')}</p>
            <a href="https://wa.me/543518682837?text=${encodeURIComponent('Hola, quiero comprar ' + p.nombre + ' ($' + p.precio.toLocaleString('es-AR') + ')')}" target="_blank" rel="noopener noreferrer" class="btn-pedir" aria-label="Pedir ${p.nombre} por WhatsApp">Pedir</a>
          </div>
        </div>
      `;
      grid.appendChild(card);
      observer.observe(card);
    });
  }

  function injectJsonLd(id, data) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = id;
    script.textContent = JSON.stringify(data);
    document.head.appendChild(script);
  }

  const observer = new IntersectionObserver(function (entries) {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.1 });

  if (page === 'creatinas.html') {
    renderCards('creatina');
  } else if (page === 'preentrenos.html') {
    renderCards('preentreno');
  } else if (page === 'index.html' || page === '' || page === undefined) {
    renderCards();

    const itemListElements = fullProductos.map((p, idx) => ({
      '@type': 'ListItem',
      'position': idx + 1,
      'url': SITE_URL + '/producto.html?id=' + idx,
      'name': p.nombre
    }));

    injectJsonLd('ld-itemlist', {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      'name': 'Suplementos Deportivos Fitness Plus',
      'itemListElement': itemListElements
    });
  }

  if (page === 'producto.html') {
    const params = new URLSearchParams(window.location.search);
    const id = parseInt(params.get('id'), 10);
    const prod = fullProductos[id];

    if (prod) {
      document.getElementById('productoNombre').textContent = prod.nombre;
      document.getElementById('productoNombre').textContent = prod.nombre;
      const btnPedir = document.getElementById('btnPedirDetalle');
      if (btnPedir) {
        btnPedir.href = 'https://wa.me/543518682837?text=' + encodeURIComponent('Hola, quiero comprar ' + prod.nombre + ' ($' + prod.precio.toLocaleString('es-AR') + ')');
      }
      document.getElementById('detalleNombre').textContent = prod.nombre;
      document.getElementById('detalleDescripcion').textContent = prod.descripcion;
      document.getElementById('detallePrecio').textContent = '$' + prod.precio.toLocaleString('es-AR');
      const detalleImg = document.getElementById('detalleImagen');
      if (prod.tabla) {
        detalleImg.innerHTML =
          '<div class="detalle-slider">' +
            '<div class="detalle-slider-track" id="sliderTrack">' +
              '<div class="detalle-slide" id="slide-clone-tabla">' +
                '<img src="' + prod.tabla + '" alt="Tabla nutricional de ' + prod.nombre + '" loading="lazy">' +
              '</div>' +
              '<div class="detalle-slide" id="slide-producto">' +
                '<img src="' + prod.img + '" alt="' + prod.nombre + '" loading="lazy" width="600" height="600">' +
              '</div>' +
              '<div class="detalle-slide" id="slide-tabla">' +
                '<img src="' + prod.tabla + '" alt="Tabla nutricional de ' + prod.nombre + '" loading="lazy">' +
              '</div>' +
              '<div class="detalle-slide" id="slide-clone-producto">' +
                '<img src="' + prod.img + '" alt="' + prod.nombre + '" loading="lazy" width="600" height="600">' +
              '</div>' +
            '</div>' +
            '<button class="detalle-arrow prev" id="slidePrev" aria-label="Anterior">&#10094;</button>' +
            '<button class="detalle-arrow next" id="slideNext" aria-label="Siguiente">&#10095;</button>' +
            '<div class="detalle-dots" id="slideDots">' +
              '<span class="dot active"></span><span class="dot"></span>' +
            '</div>' +
          '</div>';
        var currentSlide = 0; // 0 = producto, 1 = tabla
        var track = document.getElementById('sliderTrack');
        var slideTimer;
        slideTo(0, true);
        function slideTo(idx, instant) {
          track.style.transition = instant ? 'none' : '';
          var pos = -(idx + 1) * 100; // producto= -100%, tabla = -200%
          track.style.transform = 'translateX(' + pos + '%)';
          if (instant) { track.offsetHeight; track.style.transition = ''; }
        }
        function updateDots(idx) {
          document.querySelectorAll('#slideDots .dot').forEach(function (d, i) {
            d.classList.toggle('active', (idx === 0 && i === 0) || (idx === 1 && i === 1));
          });
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
        document.getElementById('slideNext').addEventListener('click', nextSlide);
        document.getElementById('slidePrev').addEventListener('click', prevSlide);
        var touchX = 0;
        detalleImg.addEventListener('touchstart', function (e) {
          touchX = e.changedTouches[0].screenX;
        }, { passive: true });
        detalleImg.addEventListener('touchend', function (e) {
          var diff = touchX - e.changedTouches[0].screenX;
          if (Math.abs(diff) > 50) {
            clearTimeout(slideTimer);
            if (diff > 0) { nextSlide(); } else { prevSlide(); }
          }
        }, { passive: true });
        if ('ontouchstart' in window) {
          try { mediumZoom('#slide-tabla img, #slide-clone-tabla img'); } catch (e) {}
        }
      } else {
        detalleImg.innerHTML = '<img src="' + prod.img + '" alt="' + prod.nombre + '" loading="lazy" width="600" height="600">';
      }
      document.title = prod.nombre + ' | Comprar — Fitness Plus';

      const descMeta = document.querySelector('meta[name="description"]');
      if (descMeta) descMeta.setAttribute('content', prod.descripcion + ' Comprá online en Fitness Plus con envío 24/48h.');

      const canonical = document.querySelector('link[rel="canonical"]');
      if (canonical) canonical.setAttribute('href', SITE_URL + '/producto.html?id=' + id);

      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) ogTitle.setAttribute('content', prod.nombre + ' — Fitness Plus');
      const ogDesc = document.querySelector('meta[property="og:description"]');
      if (ogDesc) ogDesc.setAttribute('content', prod.descripcion);
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) ogImage.setAttribute('content', SITE_URL + '/' + prod.img);
      const ogUrl = document.querySelector('meta[property="og:url"]');
      if (ogUrl) ogUrl.setAttribute('content', SITE_URL + '/producto.html?id=' + id);

      const twTitle = document.querySelector('meta[name="twitter:title"]');
      if (twTitle) twTitle.setAttribute('content', prod.nombre + ' — Fitness Plus');
      const twDesc = document.querySelector('meta[name="twitter:description"]');
      if (twDesc) twDesc.setAttribute('content', prod.descripcion);
      const twImage = document.querySelector('meta[name="twitter:image"]');
      if (twImage) twImage.setAttribute('content', SITE_URL + '/' + prod.img);

      const categoriaNombre = prod.categoria === 'creatina' ? 'Creatinas' : 'Pre-Entrenos';
      const categoriaUrl = SITE_URL + '/' + (prod.categoria === 'creatina' ? 'creatinas.html' : 'preentrenos.html');

      injectJsonLd('ld-product', {
        '@context': 'https://schema.org',
        '@type': 'Product',
        'name': prod.nombre,
        'image': SITE_URL + '/' + prod.img,
        'description': prod.descripcion,
        'brand': { '@type': 'Brand', 'name': prod.marca },
        'category': categoriaNombre,
        'offers': {
          '@type': 'Offer',
          'url': SITE_URL + '/producto.html?id=' + id,
          'priceCurrency': 'ARS',
          'price': prod.precio,
          'availability': 'https://schema.org/InStock',
          'itemCondition': 'https://schema.org/NewCondition'
        }
      });

      injectJsonLd('ld-breadcrumb', {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        'itemListElement': [
          { '@type': 'ListItem', 'position': 1, 'name': 'Inicio', 'item': SITE_URL + '/' },
          { '@type': 'ListItem', 'position': 2, 'name': categoriaNombre, 'item': categoriaUrl },
          { '@type': 'ListItem', 'position': 3, 'name': prod.nombre, 'item': SITE_URL + '/producto.html?id=' + id }
        ]
      });

      requestAnimationFrame(function () {
        const detalle = document.getElementById('productoDetalle');
        if (detalle) {
          const top = detalle.getBoundingClientRect().top + window.scrollY;
          const offset = window.innerWidth > 768 ? 80 : 30;
          window.scrollTo({ top: top - offset, behavior: 'smooth' });
        }
      });
    } else {
      document.getElementById('productoNombre').textContent = 'Producto no encontrado';
      const detalle = document.getElementById('productoDetalle');
      if (detalle) detalle.innerHTML = '<div class="container"><p>El producto que buscás no existe.</p><a href="index.html" class="btn-volver"><i class="fas fa-arrow-left" aria-hidden="true"></i> Volver al inicio</a></div>';
      document.title = 'Producto no encontrado | Fitness Plus';
    }
  }

  const buscador = document.getElementById('buscador');
  if (buscador) {
    buscador.addEventListener('input', function () {
      const texto = this.value.toLowerCase().trim();
      document.querySelectorAll('.producto-card').forEach(card => {
        const nombre = card.querySelector('h3').textContent.toLowerCase();
        card.style.display = nombre.includes(texto) ? '' : 'none';
      });
    });
  }

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
    navLinks.classList.add('open');
    navToggle.setAttribute('aria-expanded', 'true');
    navToggle.setAttribute('aria-label', 'Cerrar menú');
    const icon = navToggle.querySelector('i');
    if (icon) icon.className = 'fas fa-times';
  }

  function closeMobileMenu(returnFocus) {
    if (!navLinks || !navToggle) return;
    navLinks.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', 'Abrir menú');
    const icon = navToggle.querySelector('i');
    if (icon) icon.className = 'fas fa-bars';
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
        const top = section.offsetTop - 120;
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

  var overlay = document.querySelector('.page-overlay');
  var TRANSITION_DURATION = 120;

  window.pageTransition = function (url) {
    if (overlay) { overlay.classList.add('active'); }
    setTimeout(function () { window.location.href = url; }, TRANSITION_DURATION);
  };

  if (overlay) {
    window.addEventListener('pageshow', function () {
      overlay.classList.remove('active');
    });
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest('a');
    if (!link) return;
    var href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('http') || href.startsWith('//') || link.hasAttribute('target')) return;
    e.preventDefault();
    pageTransition(href);
  });

  var btnVolver = document.getElementById('btnVolver');
  if (btnVolver) {
    btnVolver.addEventListener('click', function () {
      if (overlay) overlay.classList.add('active');
      setTimeout(function () { window.history.back(); }, TRANSITION_DURATION);
    });
  }

  document.querySelectorAll('.btn-primary, .producto-card').forEach(el => {
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

})();
