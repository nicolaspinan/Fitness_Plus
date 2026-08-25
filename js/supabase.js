/**
 * supabase.js — minimal Supabase client for Fitness Plus (vanilla, no SDK).
 *
 * Pure-fetch wrapper around the Supabase HTTP APIs:
 *   - Auth:     /auth/v1/token (password + refresh_token grants), /auth/v1/logout
 *   - Database: /rest/v1/<table> (PostgREST)
 *   - Storage:  /storage/v1/object/<bucket>/<path>
 *
 * The anon key is public by design; every write is additionally gated by RLS
 * on the server (defense in depth). Load AFTER js/site-config.js — this file
 * reads window.SUPABASE_CONFIG.
 *
 * Session: persisted in localStorage under `fitnessplus_admin_session`; access
 * tokens are refreshed proactively when close to expiry and once after a 401.
 *
 * Public API (window.Supabase):
 *   signInWithPassword(email, password) / signIn(email, password) → session
 *   signOut()                                                          → clears session
 *   getSession()                                                       → session | null
 *   refreshSession()                                                   → fresh session
 *   select(table, {filters, order, limit, select})                     → rows
 *   insert(table, row, {upsert, onConflict})                           → inserted rows
 *   update(table, id, patch)                                           → updated rows
 *   remove(table, id)                                                  → deleted rows
 *   upload(bucket, path, file, {upsert, timeout})                       → upload result
 *     (default timeout 30s — uploads get more time than the 8s API default)
 *   publicUrl(bucket, path)                                            → public URL string
 *   removeObject(bucket, path)                                         → delete result
 *   SupabaseError                                                      → error constructor
 */
(function () {
  'use strict';

  var SESSION_KEY = 'fitnessplus_admin_session';
  var TIMEOUT_MS = 8000; // AbortController timeout
  var UPLOAD_TIMEOUT_MS = 30000; // uploads get more time: 2MB images on slow links
  var REFRESH_MARGIN_MS = 60 * 1000; // refresh when the token expires in < 1 min

  /** Typed error for every failure: configuration, network, HTTP or auth. */
  function SupabaseError(message, opts) {
    this.name = 'SupabaseError';
    this.message = message;
    opts = opts || {};
    this.status = opts.status || null;
    this.code = opts.code || null;
    this.details = opts.details || null;
    this.reason = opts.reason || null; // 'config' | 'network' | 'http' | 'auth'
  }
  SupabaseError.prototype = Object.create(Error.prototype);
  SupabaseError.prototype.constructor = SupabaseError;

  function isPlaceholder(value) {
    return !value || /^<|YOUR_|placeholder/i.test(String(value));
  }

  /**
   * Fail-fast guard (task 1.3): abort with a clear console error instead of
   * firing requests against invalid placeholder URLs.
   */
  function getConfig() {
    var cfg = (window.SUPABASE_CONFIG || {});
    var url = cfg.projectUrl;
    var key = cfg.anonKey;
    if (isPlaceholder(url) || isPlaceholder(key) || !/^https:\/\/.+\.supabase\.co\/?$/.test(String(url))) {
      console.error(
        '[supabase.js] Supabase is not configured. Open js/site-config.js and replace ' +
        '<YOUR_SUPABASE_URL> and <YOUR_ANON_KEY> with your Supabase project ' +
        '(Project Settings → API). Until then, every Supabase call is aborted here.'
      );
      throw new SupabaseError(
        'Supabase is not configured: fill in js/site-config.js (projectUrl + anonKey).',
        { reason: 'config' }
      );
    }
    return { url: String(url).replace(/\/$/, ''), key: key };
  }

  // ---- session persistence --------------------------------------------------

  function getSession() {
    var raw = null;
    try { raw = localStorage.getItem(SESSION_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try {
      var session = JSON.parse(raw);
      if (!session || !session.access_token) return null;
      session.expires_at = Number(session.expires_at) || 0;
      return session;
    } catch (e) {
      return null;
    }
  }

  function saveSession(session) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* keep in memory only */ }
    return session;
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  function isSessionExpired(session) {
    return !session || !session.expires_at || (session.expires_at - REFRESH_MARGIN_MS) <= Date.now();
  }

  // ---- low-level fetch ------------------------------------------------------

  function encodePath(objectPath) {
    return String(objectPath).split('/').map(function (seg) {
      return encodeURIComponent(seg);
    }).join('/');
  }

  function request(cfg, path, opts) {
    opts = opts || {};
    var timeoutMs = (typeof opts.timeout === 'number' && opts.timeout > 0) ? opts.timeout : TIMEOUT_MS;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

    var headers = {
      'apikey': cfg.key,
      'Authorization': 'Bearer ' + (opts.token || cfg.key)
    };
    if (opts.json !== false) headers['Content-Type'] = 'application/json';
    if (opts.headers) {
      Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    }

    return fetch(cfg.url + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      signal: controller.signal
    }).then(function (res) {
      var contentType = res.headers.get('content-type') || '';
      var bodyPromise = contentType.indexOf('application/json') !== -1
        ? res.json().catch(function () { return null; })
        : res.text().catch(function () { return ''; });
      return bodyPromise.then(function (body) {
        return { status: res.status, ok: res.ok, body: body };
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        throw new SupabaseError('Request timed out after ' + (timeoutMs / 1000) + 's.', { reason: 'network' });
      }
      throw new SupabaseError('Network error: could not reach Supabase.', { reason: 'network' });
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  function parseErrorBody(body, status) {
    var detail = body;
    if (Array.isArray(detail)) detail = detail[0];
    if (detail && typeof detail === 'object') {
      return new SupabaseError(
        detail.message || ('HTTP ' + status),
        { status: status, code: detail.code || null, details: detail.details || null, reason: 'http' }
      );
    }
    return new SupabaseError('HTTP ' + status, { status: status, reason: 'http' });
  }

  /**
   * perform() — one request with the token lifecycle policy:
   *   1. authenticated call + token close to expiry  → refresh first
   *   2. server answers 401 + a session existed      → refresh once, retry once
   * Anonymous operations never carry the stored session token: they always go
   * out with the publishable/anon key so an expiring/rotating admin token can
   * never break public rendering.
   * Refresh failure throws a SupabaseError (reason 'auth') so callers can
   * redirect to login without persisting partial data.
   */
  function perform(path, opts, retried) {
    var cfg = getConfig();
    var session = getSession();
    // Attach the stored Bearer token ONLY for authenticated operations; every
    // anonymous call falls back to cfg.key even if an admin session exists.
    var token = (opts.authenticated && session && session.access_token) || null;

    if (opts.authenticated && token && session && isSessionExpired(session)) {
      return refreshSession().then(function () {
        return perform(path, opts, retried);
      });
    }

    return request(cfg, path, {
      method: opts.method || 'GET',
      token: token || cfg.key,
      headers: opts.headers,
      body: opts.body,
      json: opts.json,
      timeout: opts.timeout
    }).then(function (res) {
      if (res.ok) return res.body;
      if (res.status === 401 && !retried && token) {
        return refreshSession().then(function () {
          return perform(path, opts, true);
        });
      }
      throw parseErrorBody(res.body, res.status);
    });
  }

  // ---- auth -----------------------------------------------------------------

  function signInWithPassword(email, password) {
    var cfg = getConfig();
    return request(cfg, '/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email: email, password: password })
    }).then(function (res) {
      if (!res.ok) throw parseErrorBody(res.body, res.status);
      var data = res.body || {};
      var session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
        user: data.user || null
      };
      return saveSession(session);
    });
  }

  /** Alias kept for the design's `signIn(email, pw)` name. */
  function signIn(email, password) {
    return signInWithPassword(email, password);
  }

  // In-flight refresh promise (single-flight): concurrent 401 handlers must
  // share ONE refresh_token rotation. Supabase rotates (and immediately
  // invalidates) the refresh token on every grant, so two parallel calls turn
  // the loser into "refresh_token already used"; its clearSession() would then
  // wipe the freshly saved valid session and spuriously log the admin out.
  var refreshingPromise = null;

  function refreshSession() {
    if (refreshingPromise) return refreshingPromise;
    var cfg = getConfig();
    var session = getSession();
    if (!session || !session.refresh_token) {
      clearSession();
      throw new SupabaseError('No session to refresh.', { reason: 'auth' });
    }
    refreshingPromise = request(cfg, '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (res) {
      // Settled: release the single-flight slot so a later caller starts a
      // fresh rotation against the newly saved refresh token.
      refreshingPromise = null;
      if (!res.ok) {
        clearSession();
        throw new SupabaseError('Session expired. Sign in again.', { status: res.status, reason: 'auth' });
      }
      var data = res.body || {};
      var fresh = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || session.refresh_token,
        expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
        user: data.user || session.user || null
      };
      return saveSession(fresh);
    }, function (err) {
      refreshingPromise = null;
      throw err;
    });
    return refreshingPromise;
  }

  function signOut() {
    var cfg = getConfig();
    var session = getSession();
    var promise = Promise.resolve(null);
    if (session && session.access_token) {
      promise = request(cfg, '/auth/v1/logout', { method: 'POST', token: session.access_token });
    }
    return promise.then(function () { clearSession(); }).catch(function () { clearSession(); });
  }

  // ---- database CRUD (PostgREST /rest/v1) -------------------------------------

  function buildQuery(params) {
    var parts = [];
    params = params || {};
    var filters = params.filters || {};
    Object.keys(filters).forEach(function (col) {
      parts.push(col + '=eq.' + encodeURIComponent(filters[col]));
    });
    if (params.order) parts.push('order=' + encodeURIComponent(params.order));
    if (typeof params.limit === 'number') parts.push('limit=' + params.limit);
    if (params.select) parts.push('select=' + encodeURIComponent(params.select));
    return parts.length ? '?' + parts.join('&') : '';
  }

  function select(table, params) {
    return perform('/rest/v1/' + table + buildQuery(params || {}), { authenticated: false });
  }

  function insert(table, row, opts) {
    opts = opts || {};
    var prefer = ['return=representation'];
    var query = '';
    if (opts.upsert) {
      prefer.push('resolution=merge-duplicates');
      if (opts.onConflict) query = '?on_conflict=' + encodeURIComponent(opts.onConflict);
    }
    return perform('/rest/v1/' + table + query, {
      method: 'POST',
      authenticated: true,
      headers: { 'Prefer': prefer.join(',') },
      body: JSON.stringify(Array.isArray(row) ? row : [row])
    });
  }

  function update(table, id, patch) {
    return perform('/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      authenticated: true,
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    });
  }

  function remove(table, id) {
    return perform('/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      authenticated: true,
      headers: { 'Prefer': 'return=representation' }
    });
  }

  // ---- storage (public bucket `productos`) -----------------------------------

  function upload(bucket, objectPath, file, opts) {
    opts = opts || {};
    return perform('/storage/v1/object/' + bucket + '/' + encodePath(objectPath), {
      method: 'POST',
      authenticated: true,
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'x-upsert': opts.upsert ? 'true' : 'false'
      },
      body: file,
      timeout: (typeof opts.timeout === 'number' && opts.timeout > 0) ? opts.timeout : UPLOAD_TIMEOUT_MS
    });
  }

  function publicUrl(bucket, objectPath) {
    var cfg = getConfig();
    return cfg.url + '/storage/v1/object/public/' + bucket + '/' + encodePath(objectPath);
  }

  function removeObject(bucket, objectPath) {
    return perform('/storage/v1/object/' + bucket + '/' + encodePath(objectPath), {
      method: 'DELETE',
      authenticated: true
    });
  }

  // ---- public surface ----------------------------------------------------------

  window.Supabase = {
    signIn: signIn,
    signInWithPassword: signInWithPassword,
    signOut: signOut,
    getSession: getSession,
    refreshSession: refreshSession,
    select: select,
    insert: insert,
    update: update,
    remove: remove,
    upload: upload,
    publicUrl: publicUrl,
    removeObject: removeObject,
    SupabaseError: SupabaseError
  };
})();
