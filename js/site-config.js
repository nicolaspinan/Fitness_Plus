/**
 * site-config.js — site-wide configuration for Fitness Plus.
 *
 * Load FIRST, before js/supabase.js and any page script.
 *
 * Fill in the two placeholders below with your Supabase project credentials:
 *   - projectUrl: Supabase Dashboard → Project Settings → API → Project URL
 *   - anonKey:    Supabase Dashboard → Project Settings → API → Project API keys → anon public
 *
 * The anon key is PUBLIC by design (it ships in static JS). All write access
 * is gated server-side by Row Level Security (RLS) — never paste the
 * service_role key here.
 *
 * Until the placeholders are filled, js/supabase.js throws a descriptive error
 * instead of firing requests at invalid URLs (fail-fast guard).
 */
(function () {
  window.SUPABASE_CONFIG = {
    // Fitness Plus Supabase project (created 2026-08-04).
    projectUrl: 'https://vuckfanivmkhmczzvssw.supabase.co',

    // Publishable key (= legacy anon public key). NOT the secret key.
    anonKey: 'sb_publishable_6HAfqFeYka_f9v6uLI2H3g_wmegRdNR'
  };

  // Canonical site origin — used for JSON-LD, canonical links and Open Graph.
  // Moved here from js/main.js so catalog/admin code can share it.
  window.SITE_URL = 'https://fitnessplus.com';
})();
