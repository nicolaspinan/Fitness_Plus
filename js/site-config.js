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
    // e.g. https://abcdefghijklm.supabase.co — replace the ENTIRE value.
    projectUrl: '<YOUR_SUPABASE_URL>',

    // Project API keys → anon public (NOT the service_role key).
    anonKey: '<YOUR_ANON_KEY>'
  };

  // Canonical site origin — used for JSON-LD, canonical links and Open Graph.
  // Moved here from js/main.js so catalog/admin code can share it.
  window.SITE_URL = 'https://fitnessplus.com';
})();
