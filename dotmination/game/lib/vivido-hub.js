/*
 * vivido-hub.js — live activity + global rankings client (Dotmination, DotminationVR).
 * Shared file: keep the copies in dotmination/game/lib/ and webxr/DotminationVR/ identical.
 *
 * Everything here is an optional extra. The games never wait for it:
 *   - every call has a 5 s timeout; any failure just means "no live info / no rankings now";
 *   - when the service reports { paused } (its free daily budget is used up) the game stops
 *     calling until the next UTC day and keeps working exactly as without the service.
 *
 * API:  VividoHub.init(app)            app = 'dotmination' | 'dotminationvr'
 *       VividoHub.setState(state)      'menu' | 'solo' | 'lobby' | 'searching' | 'playing' | 'waiting:<startType>'
 *       VividoHub.joinable(counts)     public matches you can join now, by start type
 *       VividoHub.refresh()            fresh counts now (menu opened)
 *       VividoHub.onChange(cb)         cb(counts|null, hub) on every update
 *       VividoHub.submitScore(level, ms) → Promise<{best, rank, total}|null>
 *       VividoHub.top(level) / VividoHub.overall() → Promise<…|null>
 *       VividoHub.getNick() / VividoHub.setNick(nick) → Promise
 */
(function (global) {
  'use strict';

  // Discord Activity: modules/discord.js maps this host through Discord's proxy (/hub)
  var DEFAULT_URL = 'https://vivido-hub.odd-bird-4c2c.workers.dev';
  var PAUSE_KEY = 'vividoHub.pausedUntil';
  var ID_KEY = 'vividoHub.id';
  var NICK_KEY = 'vividoHub.nick';
  var PING_MS = 45000;
  var RETRY_MS = 120000;

  function store(k, v) {
    try {
      if (v === undefined) return global.localStorage.getItem(k);
      if (v === null) global.localStorage.removeItem(k);
      else global.localStorage.setItem(k, v);
    } catch (e) { /* storage blocked: work without it */ }
    return null;
  }
  function base() { return global.VIVIDO_HUB_URL || DEFAULT_URL; }
  function pausedUntil() {
    var t = Number(store(PAUSE_KEY)) || 0;
    return Date.now() < t ? t : 0;
  }
  function newId() {
    var s = '';
    var a = new Uint8Array(12);
    try { global.crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < a.length; i++) a[i] = Math.random() * 256; }
    for (var j = 0; j < a.length; j++) s += ('0' + a[j].toString(16)).slice(-2);
    return 'p' + s;
  }

  var H = {
    app: null,
    state: 'menu',
    counts: null,
    available: false,
    paused: false,
    id: null,
    _cbs: [],
    _timer: null,
    _pendingState: null,
  };

  function emit() {
    for (var i = 0; i < H._cbs.length; i++) {
      try { H._cbs[i](H.available ? H.counts : null, H); } catch (e) { /* ignore UI errors */ }
    }
  }

  function call(method, path, body, keepalive) {
    if (pausedUntil()) { H.paused = true; H.available = false; return Promise.resolve(null); }
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 5000);
    var opts = { method: method, cache: 'no-store', keepalive: !!keepalive };
    if (ctrl) opts.signal = ctrl.signal;
    if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    return fetch(base() + path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (j && j.paused) {
          store(PAUSE_KEY, String(j.until || (Date.now() + 3600000)));
          H.paused = true;
          H.available = false;
          emit();
          return null;
        }
        if (!r.ok) return null;
        H.available = true;
        return j;
      });
    }).catch(function () {
      H.available = false;
      emit();
      return null;
    }).then(function (res) { clearTimeout(to); return res; });
  }

  function ping() {
    if (!H.app || (global.document && global.document.hidden)) return schedule(PING_MS);
    return call('POST', '/v1/ping', { app: H.app, id: H.id, state: H.state }).then(function (j) {
      if (j && j.counts) { H.counts = j.counts; emit(); }
      schedule(j ? PING_MS : (H.paused ? pausedUntil() - Date.now() + 5000 : RETRY_MS));
    });
  }

  function schedule(ms) {
    if (H._timer) clearTimeout(H._timer);
    H._timer = setTimeout(ping, Math.max(1000, Math.min(ms, 6 * 3600000)));
  }

  H.init = function (app) {
    if (H.app) return H;
    H.app = app;
    H.id = store(ID_KEY);
    if (!H.id || !/^[A-Za-z0-9_-]{8,64}$/.test(H.id)) { H.id = newId(); store(ID_KEY, H.id); }
    H.paused = !!pausedUntil();
    setTimeout(ping, 1500);
    if (global.document) {
      global.document.addEventListener('visibilitychange', function () {
        if (!global.document.hidden) schedule(500);
      });
    }
    // Leaving: drop off the online list right away
    global.addEventListener('pagehide', function () {
      if (H.available && !pausedUntil()) call('POST', '/v1/ping', { app: H.app, id: H.id, state: 'gone' }, true);
    });
    return H;
  };

  H.setState = function (state) {
    if (!state || state === H.state) return;
    H.state = state;
    // Changes are sent quickly (1 s debounce) so "waiting for an opponent" shows up fast
    if (H._pendingState) clearTimeout(H._pendingState);
    H._pendingState = setTimeout(function () { H._pendingState = null; if (H.app) schedule(0); }, 1000);
  };

  /** Fresh counts now (e.g. when a menu opens); at most every 10 s. */
  H.refresh = function () {
    if (!H.app || pausedUntil()) return;
    var now = Date.now();
    if (H._lastRefresh && now - H._lastRefresh < 10000) return;
    H._lastRefresh = now;
    schedule(0);
  };

  /** Joinable public matches by start type, minus your own: { blank: n, 'half-filled': n } */
  H.joinable = function (c) {
    c = c || H.counts;
    var out = {};
    var w = (c && c.waiting) || {};
    for (var t in w) {
      var n = w[t] | 0;
      if (H.state === 'waiting:' + t) n--;
      if (n > 0) out[t] = n;
    }
    return out;
  };

  H.onChange = function (cb) {
    if (typeof cb === 'function') { H._cbs.push(cb); cb(H.available ? H.counts : null, H); }
  };

  // Your rankings name; DotminationVR's start-screen nickname counts too (it's typed after start-up)
  H.getNick = function () { return store(NICK_KEY) || store('dotminationvr-nickname') || ''; };

  H.setNick = function (nick) {
    nick = String(nick || '').trim().slice(0, 16);
    if (nick.length < 2) return Promise.resolve(null);
    store(NICK_KEY, nick);
    return call('POST', '/v1/nick', { id: H.id, nick: nick });
  };

  H.submitScore = function (level, ms) {
    if (!H.app || !(level >= 1) || !(ms > 0)) return Promise.resolve(null);
    var nick = H.getNick();
    return call('POST', '/v1/score', { app: H.app, id: H.id, nick: nick || undefined, level: level | 0, ms: Math.round(ms) });
  };

  H.top = function (level) { return call('GET', '/v1/top?level=' + (level | 0) + '&id=' + encodeURIComponent(H.id || '')); };
  H.levels = function () { return call('GET', '/v1/levels?id=' + encodeURIComponent(H.id || '')); };
  H.overall = function () { return call('GET', '/v1/top?overall=1&id=' + encodeURIComponent(H.id || '')); };

  /** Short human line for the live counts, or '' when there's nothing to say. */
  H.liveText = function (c) {
    c = c || H.counts;
    if (!c) return '';
    var parts = [];
    var others = Math.max(0, (c.online | 0) - 1);
    parts.push(others === 0 ? 'Only you online right now' : (c.online + ' players online'));
    if (c.searching > 0) parts.push(c.searching + (c.searching === 1 ? ' waiting for an opponent' : ' waiting for opponents'));
    if (c.matches > 0) parts.push(c.matches + (c.matches === 1 ? ' match in progress' : ' matches in progress'));
    return parts.join(' · ');
  };

  H.fmtMs = function (ms) {
    var s = Math.round((ms | 0) / 1000);
    var m = Math.floor(s / 60);
    return m + ':' + ('0' + (s % 60)).slice(-2);
  };

  global.VividoHub = H;
})(typeof window !== 'undefined' ? window : globalThis);
