// more-games.js — small "More WebXR games" link to the Vivido overview page.
// Shown on the 2D page (bottom-left); hidden while an immersive WebXR session runs.
(function () {
  'use strict';
  var HUB = 'https://vivido-design.itch.io/webxr-games';
  if (window.__vividoMoreGames) return;
  window.__vividoMoreGames = true;

  function add() {
    if (!document.body || document.getElementById('vivido-more-games')) return;
    var a = document.createElement('a');
    a.id = 'vivido-more-games';
    a.href = HUB;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'More WebXR games ↗';
    a.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483000',
      'padding:7px 12px', 'border-radius:999px', 'font:600 13px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'color:#04121c', 'background:rgba(51,187,255,.92)', 'text-decoration:none',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)', 'user-select:none'
    ].join(';');
    a.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    a.addEventListener('click', function (e) { e.stopPropagation(); });
    document.body.appendChild(a);
  }

  function setVisible(on) {
    var a = document.getElementById('vivido-more-games');
    if (a) a.style.display = on ? '' : 'none';
  }

  // Hide during any immersive session, whatever engine started it
  if (navigator.xr && typeof navigator.xr.requestSession === 'function') {
    var orig = navigator.xr.requestSession.bind(navigator.xr);
    navigator.xr.requestSession = function (mode) {
      var p = orig.apply(null, arguments);
      if (mode && mode !== 'inline') {
        p.then(function (session) {
          setVisible(false);
          session.addEventListener('end', function () { setVisible(true); });
        }, function () { /* ignore */ });
      }
      return p;
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
  else add();
})();
