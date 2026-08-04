#!/usr/bin/env node
/**
 * seed.js — idempotent seed for the Fitness Plus Supabase catalog.
 *
 * Change: cms-fitness-plus · Slice 1. Dev-only tool — NEVER shipped/deployed.
 *
 * Usage:
 *   node scripts/seed.js                # upsert categories, upload images, upsert products + site_texts
 *   node scripts/seed.js --dry-run      # validate local images + print the plan, NO network calls
 *
 * Configuration (never a literal in this file):
 *   SUPABASE_URL          — e.g. https://<ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  — service_role key (bypasses RLS; keep it secret)
 * Read from .env.local (gitignored) or the process environment.
 *
 * Idempotency strategy (re-runnable for restore/rollback):
 *   - categories: upsert by unique slug; products: upsert by name (uuids stay stable)
 *   - site_texts: PostgREST upsert on the `key` PK (Prefer: resolution=merge-duplicates)
 *   - images:     upload with `x-upsert: true` (10 files, public URLs stored in products)
 *
 * Data sources (verbatim, do not "fix" them):
 *   - categories: creatinas.html + preentrenos.html (hero/section texts)
 *   - products:   js/main.js fullProductos[] (names, prices, brands, descriptions, image paths)
 *   - site_texts: index.html (hero/section/nosotros slots)
 * Fixed by user request (2026-08-04): "ESTABAS" → "ESTABÁS" in home_hero_title
 * and "starnutriton_tabla.jpeg" → "starnutrition_tabla.jpeg" (file renamed).
 * NOT seeded (unreferenced leftovers): img/Creatinas/goom_*, goom_tabla.png,
 * preentrenos_pumpv8_uva.png, img/hero/*.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================================
// Seed data — VERBATIM from the current static site (see header above).
// ============================================================================

const CATEGORIES = [
  {
    slug: 'creatinas',
    name: 'Creatina',
    hero_title: 'CREATINAS',
    hero_subtitle: 'El suplemento con mayor respaldo científico para transformar tu rendimiento.',
    section_title: 'NUESTRAS CREATINAS',
    section_subtitle: 'Calidad premium para resultados reales',
    sort_order: 0
  },
  {
    slug: 'preentrenos',
    name: 'Pre Entrenos',
    hero_title: 'PRE ENTRENOS',
    hero_subtitle: 'Explosión de energía, enfoque y pumps para llevar tu entreno al máximo',
    section_title: 'NUESTROS PRE ENTRENOS',
    section_subtitle: 'Energía que marca la diferencia',
    sort_order: 1
  }
];

const PRODUCTS = [
  {
    name: 'CREATINA MYPROTEIN',
    brand: 'MyProtein',
    category: 'creatinas',
    price: 29900,
    short_desc: 'Creatina premium de estándar internacional y máxima pureza, sin aditivos.',
    full_desc: 'Creatina premium de estándar internacional y máxima pureza. Diseñada exclusivamente para quienes no negocian la calidad de su cuerpo y buscan el máximo rendimiento biológico sin aditivos.',
    image: 'img/Creatinas/creatina_myprotein.png',
    nutrition_image: 'img/tablas_nutricionales/myprotein_tabla.jpeg',
    sort_order: 0,
    home_order: 1
  },
  {
    name: 'CREATINA STAR NUTRITION',
    brand: 'Star Nutrition',
    category: 'creatinas',
    price: 28800,
    short_desc: 'La creatina micronizada Nº1 en ventas en Argentina. Fuerza explosiva y recuperación real.',
    full_desc: 'La creatina micronizada Nº1 en ventas y la más elegida de Argentina. Diseñada para darte la fuerza explosiva y la recuperación que tu cuerpo necesita, respaldada por la comunidad fitness que busca resultados reales sin pagar de más',
    image: 'img/Creatinas/creatina_starnutrition.png',
    nutrition_image: 'img/tablas_nutricionales/starnutrition_tabla.jpeg',
    sort_order: 1,
    home_order: 2
  },
  {
    name: 'CREATINA ENA',
    brand: 'ENA',
    category: 'creatinas',
    price: 29600,
    short_desc: 'Alta pureza y rápida absorción, respaldada por el laboratorio líder en nutrición deportiva.',
    full_desc: 'Creatina de alta pureza y rápida absorción respaldada por el laboratorio líder en nutrición deportiva. Diseñada bajo estrictos estándares farmacéuticos para garantizarte máxima potencia, seguridad absoluta y resultados visibles en cada entrenamiento.',
    image: 'img/Creatinas/creatina_ena.png',
    nutrition_image: 'img/tablas_nutricionales/ena_tabla.jpeg',
    sort_order: 2,
    home_order: 3
  },
  {
    name: 'PRE-WORKOUT PREWAR',
    brand: 'PreWar',
    category: 'preentrenos',
    price: 34400,
    short_desc: 'Combate la fatiga muscular y sostiene la concentración de principio a fin.',
    full_desc: 'Fórmula equilibrada con cafeína, beta alanina y arginina elaborada bajo calidad farmacéutica. Mejora el flujo sanguíneo, combate la fatiga muscular y sostiene la concentración de principio a fin sin bajones.\n\nMáxima congestión: Favorece el bombeo y el transporte de nutrientes a los músculos.\nEnfoque mental: Mantiene tu concentración al máximo en cada serie sin bajones repentinos.',
    image: 'img/Preentrenos/preentrenos_prewar.png',
    nutrition_image: 'img/tablas_nutricionales/prewar_tabla.jpeg',
    sort_order: 0,
    home_order: 4
  },
  {
    name: 'PRE-WORKOUT PUMP V8',
    brand: 'Pump V8',
    category: 'preentrenos',
    price: 35500,
    short_desc: 'Da energía e intensidad inmediata y aporta un enfoque mental total. Ideal para días de mucha fatiga.',
    full_desc: 'Fórmula potente a base de estimulantes y aminoácidos. Aumenta la vasodilatación, da energía e intensidad inmediata y aporta un enfoque mental total. Ideal para días de mucha fatiga.\n\nEnergía e intensidad inmediata: Activa tu cuerpo en minutos para entrenar sin rastro de fatiga.\nVasodilatación extrema: Máxima congestión y flujo de nutrientes directo a tus músculos.\nEnfoque mental absoluto: Mantiene tu mente 100% conectada con el entrenamiento de principio a fin.',
    image: 'img/Preentrenos/preentrenos_pumpv8_sandia.png',
    nutrition_image: 'img/tablas_nutricionales/pump-v8_sandia_tabla.jpg',
    sort_order: 1,
    home_order: 5
  }
];

// site_texts defaults — VERBATIM from index.html. The hero typo was corrected
// to "ESTABÁS" by user request; the rest is verbatim.
const SITE_TEXTS = {
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

// ============================================================================
// Helpers
// ============================================================================

function loadEnv() {
  const env = Object.assign({}, process.env);
  const envPath = path.join(PROJECT_ROOT, '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // process.env wins over .env.local
      if (!(key in env)) env[key] = value;
    }
  }
  return env;
}

function encodePath(objectPath) {
  return String(objectPath).split('/').map(encodeURIComponent).join('/');
}

function buildQuery(params) {
  const parts = [];
  if (params.filters) {
    for (const col of Object.keys(params.filters)) {
      parts.push(col + '=eq.' + encodeURIComponent(params.filters[col]));
    }
  }
  if (params.select) parts.push('select=' + encodeURIComponent(params.select));
  return parts.length ? '?' + parts.join('&') : '';
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function publicUrl(baseUrl, bucket, objectPath) {
  return baseUrl + '/storage/v1/object/public/' + bucket + '/' + encodePath(objectPath);
}

/** Minimal service-role client (service key bypasses RLS). */
function createClient(baseUrl, serviceKey) {
  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json'
  };

  async function request(restPath, opts) {
    opts = opts || {};
    const res = await fetch(baseUrl + restPath, {
      method: opts.method || 'GET',
      headers: Object.assign({}, headers, opts.headers || {}),
      body: opts.body
    });
    const text = await res.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = text; }
    }
    if (!res.ok) {
      const detail = body && typeof body === 'object'
        ? (body.message || body.code || JSON.stringify(body))
        : (text || res.statusText);
      throw new Error('[seed] HTTP ' + res.status + ' ' + (opts.method || 'GET') + ' ' + restPath + ' → ' + detail);
    }
    return body;
  }

  return {
    select(table, params) {
      return request('/rest/v1/' + table + buildQuery(params || {}));
    },
    insert(table, row, opts) {
      opts = opts || {};
      let query = '';
      const prefer = ['return=representation'];
      if (opts.upsert) {
        prefer.push('resolution=merge-duplicates');
        if (opts.onConflict) query = '?on_conflict=' + encodeURIComponent(opts.onConflict);
      }
      return request('/rest/v1/' + table + query, {
        method: 'POST',
        headers: { Prefer: prefer.join(',') },
        body: JSON.stringify(Array.isArray(row) ? row : [row])
      });
    },
    update(table, id, patch) {
      return request('/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch)
      });
    },
    upload(bucket, objectPath, buffer, contentType) {
      return request('/storage/v1/object/' + bucket + '/' + encodePath(objectPath), {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
        body: buffer
      });
    }
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const env = loadEnv();
  const supabaseUrl = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = env.SUPABASE_SERVICE_KEY || '';

  if (!supabaseUrl || !serviceKey) {
    const msg =
      '[seed] Missing configuration. Set SUPABASE_URL and SUPABASE_SERVICE_KEY\n' +
      '[seed] in .env.local (gitignored — never commit the service_role key) or in the environment.';
    if (DRY_RUN) {
      console.warn('[seed] WARNING: ' + msg.replace(/\n\[seed\]/g, '\n'));
    } else {
      console.error(msg);
      process.exit(1);
    }
  }

  const imagePaths = PRODUCTS.flatMap((p) => [p.image, p.nutrition_image]);

  // Fail fast if a referenced image is missing locally.
  for (const rel of imagePaths) {
    if (!fs.existsSync(path.join(PROJECT_ROOT, rel))) {
      console.error('[seed] Missing image file: ' + rel);
      process.exit(1);
    }
  }

  if (DRY_RUN) {
    console.log('[seed] DRY RUN — no changes will be made.');
    console.log('[seed] Supabase URL: ' + (supabaseUrl || '<missing>'));
    console.log('[seed] Categories: ' + CATEGORIES.length);
    console.log('[seed] Products: ' + PRODUCTS.length);
    console.log('[seed] Images to upload: ' + imagePaths.length);
    for (const rel of imagePaths) console.log('[seed]   ' + rel);
    console.log('[seed] site_texts keys: ' + Object.keys(SITE_TEXTS).length);
    console.log('[seed] DRY RUN OK — all ' + imagePaths.length + ' local images validated.');
    return;
  }

  const client = createClient(supabaseUrl, serviceKey);

  // 1) Categories — upsert by unique slug (uuids stay stable across runs).
  const categoryIds = {};
  for (const cat of CATEGORIES) {
    const { slug, ...fields } = cat;
    const existing = await client.select('categories', { filters: { slug: slug }, select: 'id' });
    if (existing && existing.length) {
      await client.update('categories', existing[0].id, fields);
      categoryIds[slug] = existing[0].id;
      console.log('[seed] category updated: ' + slug + ' (' + existing[0].id + ')');
    } else {
      const inserted = await client.insert('categories', cat);
      categoryIds[slug] = inserted[0].id;
      console.log('[seed] category inserted: ' + slug + ' (' + inserted[0].id + ')');
    }
  }

  // 2) Images — upload the 10 referenced files to bucket `productos`.
  //    Storage object path mirrors the local relative path (img/...) so the
  //    mapping is 1:1 with the current site. x-upsert keeps this re-runnable.
  for (const rel of imagePaths) {
    const buffer = fs.readFileSync(path.join(PROJECT_ROOT, rel));
    await client.upload('productos', rel, buffer, mimeFromPath(rel));
    console.log('[seed] image uploaded: ' + rel);
  }

  // 3) Products — upsert by name (uuid stays stable on re-runs).
  for (const prod of PRODUCTS) {
    const record = {
      name: prod.name,
      category_id: categoryIds[prod.category],
      price: prod.price,
      offer_price: null, // none of the current products is on offer
      short_desc: prod.short_desc,
      full_desc: prod.full_desc,
      image_url: publicUrl(supabaseUrl, 'productos', prod.image),
      nutrition_image_url: publicUrl(supabaseUrl, 'productos', prod.nutrition_image),
      brand: prod.brand,
      in_stock: true,
      is_featured: true,
      sort_order: prod.sort_order,
      home_order: prod.home_order
    };
    const existing = await client.select('products', { filters: { name: prod.name }, select: 'id' });
    if (existing && existing.length) {
      await client.update('products', existing[0].id, record);
      console.log('[seed] product updated: ' + prod.name + ' (' + existing[0].id + ')');
    } else {
      const inserted = await client.insert('products', record);
      console.log('[seed] product inserted: ' + prod.name + ' (' + inserted[0].id + ')');
    }
  }

  // 4) site_texts — upsert on the `key` PK (PostgREST merge-duplicates).
  const texts = Object.keys(SITE_TEXTS).map((key) => ({ key: key, value: SITE_TEXTS[key] }));
  await client.insert('site_texts', texts, { upsert: true, onConflict: 'key' });
  console.log('[seed] site_texts upserted: ' + texts.length + ' rows');

  console.log(
    '[seed] Done: ' + CATEGORIES.length + ' categories, ' + PRODUCTS.length +
    ' products, ' + imagePaths.length + ' images, ' + texts.length + ' site_texts.'
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
