/* Early boot: applies the saved theme before first paint and syncs the Android keyboard overlap.
 * Extracted from index.html (was two inline <script> blocks) so a strict Content-Security-Policy is possible. */

    /* DEV ONLY - storage isolation.
     * The stable app (/) and this dev copy (/dev/) live on the same origin, so they share localStorage.
     * Sharing the session keys (profile, access token, group caches) between two apps that can be signed
     * in to DIFFERENT Google accounts mixes accounts up: the side menu showed one email while the data
     * came from the other account. While the version ends in "-dev", every key this app reads or writes is
     * therefore stored under a "dev:" prefix. Stable's keys are never touched, and once the version loses
     * its "-dev" suffix (promotion) this block does nothing, so real users keep their existing sessions.
     * "valu_theme" stays shared on purpose. */
    (function () {
      if (!/-dev$/.test(String(window.VALU_VERSION || ''))) return;
      var real;
      try { real = window.localStorage; } catch (e) { return; }
      if (!real) return;
      var P = 'dev:';
      var SHARED = { valu_theme: true };
      function pk(k) { return SHARED[k] ? k : P + k; }
      function names() {
        var out = [];
        for (var i = 0; i < real.length; i++) {
          var k = real.key(i);
          if (k && k.indexOf(P) === 0) out.push(k.slice(P.length));
        }
        return out;
      }
      var methods = {
        getItem: function (k) { return real.getItem(pk(String(k))); },
        setItem: function (k, v) { real.setItem(pk(String(k)), String(v)); },
        removeItem: function (k) { real.removeItem(pk(String(k))); },
        clear: function () { names().forEach(function (k) { real.removeItem(P + k); }); },
        key: function (i) { var n = names(); return i >= 0 && i < n.length ? n[i] : null; },
      };
      var scoped = new Proxy({}, {
        get: function (_, p) {
          if (p === 'length') return names().length;
          if (typeof p !== 'string') return undefined;
          if (Object.prototype.hasOwnProperty.call(methods, p)) return methods[p];
          var v = real.getItem(pk(p));
          return v === null ? undefined : v;
        },
        set: function (_, p, v) { if (typeof p === 'string') real.setItem(pk(p), String(v)); return true; },
        deleteProperty: function (_, p) { if (typeof p === 'string') real.removeItem(pk(p)); return true; },
        has: function (_, p) {
          return typeof p === 'string' &&
            (p === 'length' || Object.prototype.hasOwnProperty.call(methods, p) || real.getItem(pk(p)) !== null);
        },
        ownKeys: function () { return names(); },
        getOwnPropertyDescriptor: function (_, p) {
          if (typeof p === 'string') {
            var v = real.getItem(P + p);
            if (v !== null) return { value: v, writable: true, enumerable: true, configurable: true };
          }
          return undefined;
        },
      });
      try {
        Object.defineProperty(window, 'localStorage', { configurable: true, enumerable: true, get: function () { return scoped; } });
      } catch (e) { /* if the browser refuses, dev keeps working on the shared storage */ }
    })();

    (function(){
      var t=localStorage.getItem('valu_theme');
      if(t==='dark'||t==='light'){
        document.documentElement.setAttribute('data-theme',t);
        var m=document.querySelector('meta[name="theme-color"]');
        if(m)m.setAttribute('content',t==='dark'?'#211f1d':'#729c9c');
      }
    })();
  
    (function () {
      if (!/Android/i.test(navigator.userAgent) || !window.visualViewport) return;
      function syncBottomOverlap() {
        var vv = visualViewport;
        var layoutH = window.innerHeight;
        var visibleBottom = vv.height + vv.offsetTop;
        var raw = Math.max(0, Math.round(layoutH - visibleBottom));
        var overlap = Math.min(56, raw);
        document.documentElement.style.setProperty('--vv-bottom-overlap', overlap + 'px');
      }
      syncBottomOverlap();
      visualViewport.addEventListener('resize', syncBottomOverlap);
      visualViewport.addEventListener('scroll', syncBottomOverlap);
      window.addEventListener('orientationchange', function () { setTimeout(syncBottomOverlap, 250); });
      window.addEventListener('pageshow', function (e) { if (e.persisted) setTimeout(syncBottomOverlap, 0); });
      requestAnimationFrame(function () { requestAnimationFrame(syncBottomOverlap); });
    })();
  
