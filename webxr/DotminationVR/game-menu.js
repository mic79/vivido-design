// game-menu.js — VR menu, lobby queue, stats & replay browser (copied from StacksVR).
// DotminationVR: seats come from dot-game.seatPose(), board toggle = S/L hex,
// board toggle = original Normal/Harder bot, IDLE toggle = multiplayer start BLANK/HALF
// (lobby startType), BOT BPM slider = Level selector (original Levels, R = Random map).
(function () {
  'use strict';

  // Diagonal position stagger, head-on Z facing (not 45° cup yaw)
  var PLAY_POSITION_BLUE = { x: -0.65, y: 0, z: 1.75, ry: 0 };
  var PLAY_POSITION_RED = { x: 0.65, y: 0, z: -1.75, ry: 180 };
  // Back-compat alias
  var PLAY_POSITION = PLAY_POSITION_BLUE;

  // Far corners while a match is live (non-players)
  var SPECTATOR_POSITIONS = [
    { x: -3.2, y: 0, z: 2.8, ry: -20 },
    { x: 3.2, y: 0, z: 2.8, ry: 20 },
    { x: -3.2, y: 0, z: -2.8, ry: -160 },
    { x: 3.2, y: 0, z: -2.8, ry: 160 }
  ];
  // Closer ring while lobby is WAITING — unique slots so joiners don't stack on blue
  var LOBBY_WAIT_POSITIONS = [
    { x: -2.0, y: 0, z: 2.5, ry: -18 },
    { x: 2.0, y: 0, z: -2.5, ry: 162 },
    { x: 2.4, y: 0, z: 1.8, ry: 55 },
    { x: -2.4, y: 0, z: -1.8, ry: -125 }
  ];

  // ── Theme = current Dotmination colour scheme (follows "Change Colors") ──
  function darkenHex(hex, amount) {
    var h = String(hex || '#444').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return '#3b6161';
    var k = 1 - (amount == null ? 0.3 : amount);
    var r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }
  function themeYou() { return (window.DotBoard && window.DotBoard.COLORS[1]) || '#E11168'; }
  function themeOpp() { return (window.DotBoard && window.DotBoard.COLORS[2]) || '#12DACE'; }
  function themeYouLight() { return lightenHex(themeYou(), 0.3); }
  function themeYouDark() { return darkenHex(themeYou(), 0.15); }
  function themeOppDark() { return darkenHex(themeOpp(), 0.3); }

  function lightenHex(hex, amount) {
    amount = amount == null ? 0.35 : amount;
    var h = String(hex || '#444').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return '#b4c8c8';
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.min(255, Math.round(r + (255 - r) * amount));
    g = Math.min(255, Math.round(g + (255 - g) * amount));
    b = Math.min(255, Math.round(b + (255 - b) * amount));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function isEffectivelyVisible(el) {
    var node = el;
    while (node && node !== node.sceneEl) {
      if (node.object3D && !node.object3D.visible) return false;
      node = node.parentNode;
        }
        return true;
  }

  function getHandGamepad(handEl) {
    if (!handEl || !handEl.components) return null;
    var keys = [
      'tracked-controls', 'tracked-controls-webxr',
      'oculus-touch-controls', 'meta-touch-controls', 'vive-controls'
    ];
    for (var i = 0; i < keys.length; i++) {
      var c = handEl.components[keys[i]];
      if (c && c.controller && c.controller.gamepad) return c.controller.gamepad;
    }
    return null;
  }

  function pulseHaptic(handEl, intensity, durationMs) {
    intensity = intensity == null ? 0.45 : intensity;
    durationMs = durationMs == null ? 40 : durationMs;
    var hands = handEl
      ? [handEl]
      : [document.getElementById('leftHand'), document.getElementById('rightHand')];
    for (var i = 0; i < hands.length; i++) {
      var hand = hands[i];
      if (!hand) continue;
      try {
        var gp = getHandGamepad(hand);
        var act = gp && gp.hapticActuators && gp.hapticActuators[0];
        if (act && act.pulse) {
          var p = act.pulse(intensity, durationMs);
          if (p && p.catch) p.catch(function () {});
          continue;
        }
        if (gp && gp.vibrationActuator && gp.vibrationActuator.playEffect) {
          gp.vibrationActuator.playEffect('dual-rumble', {
            startDelay: 0,
            duration: durationMs,
            weakMagnitude: intensity,
            strongMagnitude: intensity
          });
        }
      } catch (e) { /* no haptics */ }
    }
  }

  window.StacksHaptics = { pulse: pulseHaptic, getGamepad: getHandGamepad };

  // Bot target blocks/min (0 = frozen, up to 40)
  var BOT_BPM_KEY = 'dotminationvr.botTargetBpm.v1';
  var BOT_BPM_MIN = 0;
  var BOT_BPM_MAX = 40;
  var BOT_BPM_STEPS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40];

  function clampBotBpm(v) {
    v = Number(v);
    if (!isFinite(v) || v < 0) return 12;
    return Math.min(BOT_BPM_MAX, Math.max(BOT_BPM_MIN, Math.round(v)));
  }

  function loadBotBpm() {
    try {
      var raw = localStorage.getItem(BOT_BPM_KEY);
      if (raw == null || raw === '') return 12;
      return clampBotBpm(raw);
    } catch (e) { return 12; }
  }

  function saveBotBpm(v) {
    v = clampBotBpm(v);
    try { localStorage.setItem(BOT_BPM_KEY, String(v)); } catch (e) { /* */ }
    return v;
  }

  function nearestBotBpmStep(v) {
    v = clampBotBpm(v);
    var best = BOT_BPM_STEPS[0];
    var bestD = Math.abs(best - v);
    for (var i = 1; i < BOT_BPM_STEPS.length; i++) {
      var d = Math.abs(BOT_BPM_STEPS[i] - v);
      if (d < bestD) { best = BOT_BPM_STEPS[i]; bestD = d; }
    }
    return best;
  }

  function stepBotBpm(cur, dir) {
    cur = nearestBotBpmStep(cur);
    var idx = BOT_BPM_STEPS.indexOf(cur);
    if (idx < 0) idx = BOT_BPM_STEPS.indexOf(12);
    idx = Math.max(0, Math.min(BOT_BPM_STEPS.length - 1, idx + (dir < 0 ? -1 : 1)));
    return BOT_BPM_STEPS[idx];
  }

  window.StacksBotBpm = {
    load: loadBotBpm,
    save: saveBotBpm,
    clamp: clampBotBpm,
    steps: BOT_BPM_STEPS,
    min: BOT_BPM_MIN,
    max: BOT_BPM_MAX
  };
  // Back-compat name used by older stacks-game hooks
  window.StacksBotSpeed = window.StacksBotBpm;

  // --- Quest passthrough (opt-in look; VRLeague-style — no session tear-down) ---
  // Smooth toggle = stay in immersive-ar and only show/hide the opaque arena shell.
  // Ending XR to swap VR↔AR froze tracking + killed the wrist menu.
  var PASS_KEY = 'dotminationvr.passthrough.v1';
  window._stacksArSupported = false;
  function loadPassthroughPref() {
    try {
      if (location.hash && /(^|[&#])passthrough\b/i.test(location.hash)) return true;
      var q = new URLSearchParams(location.search);
      if (q.get('passthrough') === '1') return true;
      return localStorage.getItem(PASS_KEY) === '1';
    } catch (e) {
      return false;
    }
  }
  function savePassthroughPref(on) {
    try { localStorage.setItem(PASS_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
  }
  function getStacksGame() {
    var el = document.querySelector('[dot-game]');
    return el && el.components && el.components['dot-game'];
  }
  function applyPassthroughVisuals(on) {
    var g = getStacksGame();
    if (g && typeof g.applyPassthroughVisuals === 'function') {
      g.applyPassthroughVisuals(!!on);
    }
  }
  function inXrSession(scene) {
    return !!(scene && scene.is && (scene.is('vr-mode') || scene.is('ar-mode')));
  }
  function enterXrSession(useAr) {
    var scene = document.querySelector('a-scene');
    if (!scene || typeof scene.enterVR !== 'function') return Promise.resolve(false);
    // Visuals follow the PASS preference (opaque shell = “VR look” even in AR session)
    applyPassthroughVisuals(!!(window.StacksPassthrough && window.StacksPassthrough.enabled));
    try {
      var p = scene.enterVR(!!useAr);
      return p && typeof p.then === 'function' ? p.then(function () { return true; }) : Promise.resolve(true);
    } catch (e) {
      console.warn('[StacksPassthrough] enterVR failed', e);
      return Promise.resolve(false);
    }
  }
  /**
   * Toggle passthrough look. Never ends the XR session when already in AR —
   * that was the freeze/menu bug. Opaque shell ⇔ room visible only.
   * If somehow still in immersive-vr, migrate once into AR then stay there.
   */
  function setPassthroughEnabled(on) {
    on = !!on;
    window.StacksPassthrough.enabled = on;
    savePassthroughPref(on);
    applyPassthroughVisuals(on);

    var scene = document.querySelector('a-scene');
    if (!scene || !inXrSession(scene)) return Promise.resolve(true);

    // Already AR (or entered as AR): smooth visual toggle only
    if (scene.is('ar-mode')) return Promise.resolve(true);

    // Rare: stuck in immersive-vr — need one migrate to AR for room to show
    if (!on || !window._stacksArSupported) return Promise.resolve(true);
    var exitP = (typeof scene.exitVR === 'function') ? scene.exitVR() : Promise.resolve();
    return Promise.resolve(exitP).then(function () {
      return new Promise(function (resolve) {
        setTimeout(function () { enterXrSession(true).then(resolve); }, 80);
      });
    }).catch(function (err) {
      console.warn('[StacksPassthrough] migrate to AR failed', err);
      return false;
    });
  }
  window.StacksPassthrough = {
    enabled: loadPassthroughPref(),
    setEnabled: setPassthroughEnabled,
    isEnabled: function () { return !!window.StacksPassthrough.enabled; }
  };
  // Probe AR; Enter VR uses immersive-ar when available so PASS can toggle without tearing XR down
  (function initArEntry() {
    function probe() {
      if (!navigator.xr || !navigator.xr.isSessionSupported) return;
      navigator.xr.isSessionSupported('immersive-ar').then(function (ok) {
        window._stacksArSupported = !!ok;
      }).catch(function () { window._stacksArSupported = false; });
    }
    function bindEnter() {
      var btn = document.querySelector('.a-enter-vr-button');
      if (!btn || btn.dataset.stacksPassHook === '1') return;
      btn.dataset.stacksPassHook = '1';
      btn.addEventListener('click', function (e) {
        var scene = document.querySelector('a-scene');
        if (!scene || inXrSession(scene)) return;
        // Quest: enter AR session always (opaque shell by default = VR look)
        if (!window._stacksArSupported) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        enterXrSession(true);
      }, true);
    }
    probe();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        setTimeout(bindEnter, 0);
        setTimeout(bindEnter, 500);
        setTimeout(probe, 0);
      });
    } else {
      setTimeout(bindEnter, 0);
      setTimeout(bindEnter, 500);
      setTimeout(probe, 0);
    }
  })();

  AFRAME.registerComponent('vr-menu', {
    init: function () {
      this.menuVisible = false;
      this.menuMode = 'single';
      this.lobbyNumber = 1;
      this.botTargetBpm = loadBotBpm();
      this.statsPage = 0;
      this.statsSubTab = 'single';
      this.STATS_PER_PAGE = 3;
      this._refsReady = false;
      this._xWasDown = false;
      this._menuToggleAt = 0;
      this._poseKey = '';
      this._hoveredBtn = null;
      this._lastActionAt = 0;
      this._lastActionName = '';
      this._joinCooldownUntil = 0;
      var self = this;

      // Live activity + world rankings (optional; vivido-hub.js). Hidden when unavailable.
      if (window.VividoHub && !window.isMobileSpectator) {
        var nick = '';
        try { nick = localStorage.getItem('dotminationvr-nickname') || ''; } catch (eN) { /* storage blocked */ }
        if (nick && !window.VividoHub.getNick()) { try { localStorage.setItem('vividoHub.nick', nick.slice(0, 16)); } catch (eS) { /* ignore */ } }
        window.VividoHub.init('dotminationvr');
        var hubState = function () {
          var FC = window.FlatCompat;
          if (FC && (FC.connected || FC.resume)) return 'playing';
          // Cross-play host signed in: flatscreen players can join this one right now
          if (FC && FC.active) {
            var hostOpen = FC.isHost() && FC.peer && FC.peer.open && !FC.peer.disconnected;
            var known = FC.startType === 'blank' || FC.startType === 'half-filled';
            return hostOpen && known ? 'waiting:' + FC.startType : 'solo';
          }
          var L = window.StacksLobby;
          if (window.isMultiplayer && L && L.lobbyState) {
            var ls = L.lobbyState, me = L.myPlayerId;
            var mp = ls.matchPlayers || {};
            if (ls.matchState === 'PLAYING' && me && (mp.blue === me || mp.red === me)) return 'playing';
            if (ls.queue && me && ls.queue.indexOf(me) >= 0) return 'searching';
            return 'lobby';
          }
          return 'solo';
        };
        setInterval(function () { window.VividoHub.setState(hubState()); }, 2000);
        window.VividoHub.onChange(function (c) {
          var el = document.getElementById('menu-live-text');
          if (el) el.setAttribute('value', c ? window.VividoHub.liveText(c) : '');
          self._refreshHubJoin(c);
        });
      }

      this.el.sceneEl.addEventListener('loaded', function () {
        self.cacheRefs();
        if (window.StacksPassthrough && window.StacksPassthrough.enabled) {
          applyPassthroughVisuals(true);
        }
      });
      if (this.el.sceneEl.hasLoaded) this.cacheRefs();

      function onMenuButton() { self.requestToggleMenu(); }
      this.el.sceneEl.addEventListener('xbuttondown', onMenuButton);
      this.el.sceneEl.addEventListener('lobby-state-updated', function () { self.refreshLobbyUI(); });
      this.el.sceneEl.addEventListener('board-size-changed', function () { self._setBoardButton(); });
      this.el.sceneEl.addEventListener('start-type-changed', function () { self._setStartTypeButton(); });
      // Visuals follow PASS preference (AR session + opaque shell = VR look)
      this.el.sceneEl.addEventListener('enter-vr', function () {
        applyPassthroughVisuals(!!(window.StacksPassthrough && window.StacksPassthrough.enabled));
        self._setPassthroughButton();
      });
      this.el.sceneEl.addEventListener('exit-vr', function () {
        applyPassthroughVisuals(false);
        self._setPassthroughButton();
      });

      setTimeout(function attachX() {
        var leftHand = document.getElementById('leftHand');
        var rightHand = document.getElementById('rightHand');
        if (leftHand) {
          leftHand.addEventListener('xbuttondown', onMenuButton);
          self._leftHandEl = leftHand;
          self._attachMenuToLeftHand();
        }
        if (rightHand && !rightHand.dataset.menuTriggerBound) {
          rightHand.dataset.menuTriggerBound = '1';
          // Fallback ONLY when laser-controls did not emit click on this press.
          // Same trigger often fires both → lobby +/- was jumping 2+ steps.
          rightHand.addEventListener('triggerdown', function () {
            if (!self.menuVisible || !self._hoveredBtn) return;
            var el = self._hoveredBtn;
            if (!isEffectivelyVisible(el)) return;
            if (self._lastActionAt && (performance.now() - self._lastActionAt) < 320) return;
            pulseHaptic(rightHand, 0.7, 55);
            if (window.StacksAudio) window.StacksAudio.sfx('ui');
            self.handleAction(el.getAttribute('data-action'));
          });
        }
        // laser-controls re-enables lines on controllerconnected — stamp them back off
        function guardLasers(hand) {
          if (!hand) return;
          hand.addEventListener('controllerconnected', function () {
            if (!self.menuVisible) self.setRaycasters(false);
            else self.setRaycasters(true); // right-only when open
          });
        }
        guardLasers(leftHand);
        guardLasers(rightHand);
        if (!leftHand || !rightHand) setTimeout(attachX, 400);
      }, 100);

      this.el.sceneEl.addEventListener('enter-vr', function () {
        var overlay = document.getElementById('pre-vr-overlay');
        if (overlay) overlay.style.display = 'none';
        var cam = document.getElementById('camera');
        if (cam) {
          cam.setAttribute('look-controls', 'enabled', false);
          cam.removeAttribute('wasd-controls');
        }
        self.setRaycasters(false);
      });

      this.el.sceneEl.addEventListener('exit-vr', function () {
        var cam = document.getElementById('camera');
        if (cam) {
          cam.setAttribute('look-controls', 'enabled', true);
          cam.setAttribute('wasd-controls', '');
        }
      });
    },

    // Edge-detect left X (XR button index 4) so menu works even if xbuttondown never fires
    tick: function () {
      var hand = this._leftHandEl || document.getElementById('leftHand');
      if (hand) {
        var tracked = hand.components['tracked-controls'] ||
          hand.components['tracked-controls-webxr'] ||
          hand.components['oculus-touch-controls'] ||
          hand.components['meta-touch-controls'];
        var gp = tracked && tracked.controller && tracked.controller.gamepad;
        if (gp && gp.buttons && gp.buttons[4]) {
          var down = !!gp.buttons[4].pressed;
          if (down && !this._xWasDown) this.requestToggleMenu();
          this._xWasDown = down;
        }
      }
      // laser-controls periodically revives lines — keep them dead while menu closed
      if (!this.menuVisible) {
        this._laserGuard = (this._laserGuard || 0) + 1;
        if (this._laserGuard % 20 === 0) this._forceHideLaserLines();
        if (this._hoveredBtn) this._clearHover();
      } else {
        // Fallback hover sync from hand raycasters (in case mouseenter misses)
        this._syncRayHover();
      }
    },

    _syncRayHover: function () {
      var hit = null;
      var hitHand = this.rightHand || document.getElementById('rightHand');
      var hand = hitHand;
      var rc = hand && hand.components && hand.components.raycaster;
      if (rc && rc.intersectedEls && rc.intersectedEls.length) {
        for (var j = 0; j < rc.intersectedEls.length; j++) {
          var el = rc.intersectedEls[j];
          if (el && el.classList && el.classList.contains('menu-btn') &&
              isEffectivelyVisible(el)) {
            hit = el;
          break;
          }
        }
      }
      if (hit === this._hoveredBtn) return;
      if (!hit) {
        this._clearHover();
        return;
      }
      // Reuse bound handlers via synthetic path
      if (this._hoveredBtn) this._clearHover();
      this._hoveredBtn = hit;
      hit.setAttribute('material', 'color', hit.dataset.hoverColor || lightenHex(hit.dataset.baseColor, 0.42));
      hit.setAttribute('scale', '1.04 1.04 1.04');
      pulseHaptic(hitHand, 0.35, 28);
    },

    _forceHideLaserLines: function () {
      ['leftHand', 'rightHand'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el || !el.object3D) return;
        var rc = el.components && el.components.raycaster;
        if (rc) {
          if (rc.data) {
            rc.data.showLine = false;
            rc.data.enabled = false;
          }
          if (rc.line) rc.line.visible = false;
        }
        el.object3D.traverse(function (obj) {
          if (obj.isLine || obj.type === 'Line') obj.visible = false;
        });
      });
    },

    /** Keep the panel parented to the left controller (palm-facing). */
    _attachMenuToLeftHand: function () {
      var root = document.getElementById('vr-menu-root');
      var left = this.leftHand || document.getElementById('leftHand') || this._leftHandEl;
      if (!root || !left) return;
      if (root.parentNode !== left) left.appendChild(root);
      root.setAttribute('position', '0.02 0.12 -0.04');
      root.setAttribute('rotation', '-68 14 0');
      root.setAttribute('scale', '0.62 0.62 0.62');
    },

    requestToggleMenu: function () {
      var now = performance.now();
      if (now - this._menuToggleAt < 250) return;
      this._menuToggleAt = now;
      this.toggleMenu();
    },

    cacheRefs: function () {
      this.menu = document.getElementById('vr-menu-root');
      this.lobbySection = document.getElementById('menu-lobby-section');
      this.singleSection = document.getElementById('menu-single-section');
      this.statsSection = document.getElementById('menu-stats-section');
      this.queuePanel = document.getElementById('menu-queue-panel');
      this.queueButtons = document.getElementById('menu-queue-buttons');
      this.leftHand = document.getElementById('leftHand');
      this.rightHand = document.getElementById('rightHand');
      this._refsReady = true;
      this._attachMenuToLeftHand();
      this._bindClicks();
      this._bindTheme();
      this.setRaycasters(false);
      this.botTargetBpm = loadBotBpm();
      this.refreshLobbyUI();
      this._applyBotBpmToGame();
    },

    /** Real human/bot/multi match — dual-bot desktop preview does not count. */
    _isRealMatchPlaying: function () {
      var gm = document.querySelector('[dot-game]');
      var comp = gm && gm.components['dot-game'];
      if (comp && comp._dualBotPreview) return false;
      // Lobby PLAYING is authoritative while hosting / joined
      if (window.lobbyState && window.lobbyState.matchState === 'PLAYING') return true;
      if (!comp || !comp.matchActive) return false;
      // COUNTDOWN: modes not active yet, but End Match must still work
      if (comp.matchState === 'COUNTDOWN' || comp.matchState === 'PLAYING') return true;
      if (!comp.modes || !comp.modes.active) return false;
      return true;
    },

    /** Host or seated human only — spectators / late joiners cannot end someone else's match. */
    _canControlMatch: function () {
      if (!window.isMultiplayer) return true;
      if (window.isMobileSpectator) return false;
      if (window.StacksLobby && typeof window.StacksLobby.canIControlMatch === 'function') {
        return !!window.StacksLobby.canIControlMatch();
      }
      if (window.isHost) return true;
      if (window.StacksLobby && window.StacksLobby.amMatchPlayer) {
        return !!window.StacksLobby.amMatchPlayer();
      }
      return false;
    },

    /** Only the lobby host may start (seating / bot fill live on the host). */
    _canStartMatch: function () {
      if (!window.isMultiplayer) return true;
      if (window.isMobileSpectator) return false;
      return !!window.isHost;
    },

    _bindTheme: function () {
      if (this._themeBound) return;
      this._themeBound = true;
      var self = this;
      this._themePrev = { you: '#E11168', opp: '#12DACE' };
      window.addEventListener('dot-palette-changed', function (e) {
        var prev = self._themePrev;
        self._themePrev = { you: e.detail.you, opp: e.detail.opp };
        self._applyTheme(prev);
      });
      // A remembered scheme may have been applied before the menu existed
      if (themeYou().toLowerCase() !== '#e11168' || themeOpp().toLowerCase() !== '#12dace') {
        var prev0 = this._themePrev;
        this._themePrev = { you: themeYou(), opp: themeOpp() };
        this._applyTheme(prev0);
      }
    },

    _bindClicks: function () {
      var self = this;
      var root = document.getElementById('vr-menu-root');
      if (!root || root.dataset.menuBound === '1') return;
      root.dataset.menuBound = '1';
      root.querySelectorAll('.menu-btn').forEach(function (el) {
        var mat = el.getAttribute('material') || {};
        el.dataset.baseColor = mat.color || '#444444';
        el.dataset.hoverColor = lightenHex(el.dataset.baseColor, 0.42);
        el.classList.add('clickable');

        function hoverOn(handEl) {
          if (!isEffectivelyVisible(el)) return;
          if (self._hoveredBtn === el) return;
          self._clearHover();
          self._hoveredBtn = el;
          var tile = (el.getAttribute('data-action') || '').indexOf('level-tile-') === 0;
          if (!tile) {
            el.setAttribute('material', 'color', el.dataset.hoverColor);
            el.setAttribute('scale', '1.04 1.04 1.04');
          } else self._drawLevelStrip();
          pulseHaptic(handEl || null, 0.35, 28);
        }
        function hoverOff() {
          if (self._hoveredBtn !== el) return;
          self._hoveredBtn = null;
          var tile = (el.getAttribute('data-action') || '').indexOf('level-tile-') === 0;
          if (!tile) {
            el.setAttribute('material', 'color', el.dataset.baseColor);
            el.setAttribute('scale', '1 1 1');
          } else self._drawLevelStrip();
        }

        el.addEventListener('mouseenter', function (evt) {
          hoverOn(evt && evt.detail && evt.detail.cursorEl);
        });
        el.addEventListener('mouseleave', hoverOff);
        el.addEventListener('raycaster-intersected', function (evt) {
          hoverOn(evt.detail && evt.detail.el);
        });
        el.addEventListener('raycaster-intersected-cleared', hoverOff);

        el.addEventListener('click', function (evt) {
          if (!isEffectivelyVisible(el)) return;
          var hand = (evt.detail && evt.detail.cursorEl) || null;
          pulseHaptic(hand, 0.7, 55);
          if (window.StacksAudio) window.StacksAudio.sfx('ui');
          var action = el.getAttribute('data-action');
          self.handleAction(action);
        });
      });
    },

    _clearHover: function () {
      if (!this._hoveredBtn) return;
      var el = this._hoveredBtn;
      this._hoveredBtn = null;
      el.setAttribute('material', 'color', el.dataset.baseColor || '#444');
      el.setAttribute('scale', '1 1 1');
      if ((el.getAttribute('data-action') || '').indexOf('level-tile-') === 0) this._drawLevelStrip();
    },

    setRaycasters: function (enabled) {
      // Menu lives on the left hand — only the right controller gets a select laser
      this._setHandRaycaster(this.leftHand || document.getElementById('leftHand'), false);
      this._setHandRaycaster(this.rightHand || document.getElementById('rightHand'), enabled);
    },

    _setHandRaycaster: function (hand, enabled) {
      if (!hand) return;
      hand.setAttribute('raycaster', {
        objects: enabled ? '.clickable' : '',
        showLine: enabled,
        lineColor: '#ffffff',
        lineOpacity: enabled ? 0.85 : 0,
        far: 10,
        enabled: !!enabled
      });
      setTimeout(function () {
        var rc = hand.components && hand.components.raycaster;
        if (rc && rc.data) {
          rc.data.showLine = !!enabled;
          rc.data.enabled = !!enabled;
        }
        if (rc && rc.line) rc.line.visible = !!enabled;
        hand.object3D.traverse(function (obj) {
          if (obj.isLine || (obj.type === 'Line')) obj.visible = !!enabled;
        });
      }, 0);
    },

    toggleMenu: function () {
      this.menuVisible = !this.menuVisible;
      var root = document.getElementById('vr-menu-root');
      if (this.menuVisible) {
        this._attachMenuToLeftHand();
        if (root) {
          root.setAttribute('visible', true);
          if (root.object3D) root.object3D.visible = true;
        }
        this.refreshLobbyUI();
        this.setRaycasters(true);
        if (window.StacksAudio) window.StacksAudio.sfx('ui');
        pulseHaptic(this.leftHand || document.getElementById('leftHand'), 0.4, 35);
      } else {
        this._clearHover();
        if (root) {
          root.setAttribute('visible', false);
          if (root.object3D) root.object3D.visible = false;
        }
        this.setRaycasters(false);
      }
    },

    closeMenu: function () {
      this.menuVisible = false;
      this._clearHover();
      var root = document.getElementById('vr-menu-root');
      if (root) {
        root.setAttribute('visible', false);
        if (root.object3D) root.object3D.visible = false;
      }
      this.setRaycasters(false);
    },

    _setTabColors: function () {
      var tabs = {
        single: document.getElementById('menu-single'),
        multi: document.getElementById('menu-multi'),
        stats: document.getElementById('menu-stats')
      };
      var active = this.menuMode === 'stats' ? 'stats' : this.menuMode;
      Object.keys(tabs).forEach(function (key) {
        var el = tabs[key];
        if (!el) return;
        var on = key === active;
        var color = on ? themeYou() : '#3b6161';
        el.setAttribute('material', 'color', color);
        el.dataset.baseColor = color;
        el.dataset.hoverColor = lightenHex(color, on ? 0.28 : 0.45);
        var label = el.querySelector('a-text');
        if (label) label.setAttribute('color', on ? '#ffffff' : '#b4c8c8');
      });
    },

    handleAction: function (action) {
      if (!action || action === 'noop') return;
      // One physical trigger must equal one action. laser-controls `click` + our
      // triggerdown fallback (and occasional double-click) used to step lobby ±2+.
      var now = performance.now();
      if (this._lastActionAt && (now - this._lastActionAt) < 320) return;
      this._lastActionAt = now;
      this._lastActionName = action;

      var gm = document.querySelector('[dot-game]');
      var comp = gm && gm.components['dot-game'];
      var playing = this._isRealMatchPlaying();
      switch (action) {
        case 'mode-single':
          this.menuMode = 'single';
          this.refreshLobbyUI();
          break;
        case 'mode-multi':
          this.menuMode = 'multi';
          this.refreshLobbyUI();
          break;
        case 'start-bot':
          // Dual-purpose START / END like DodgeVR's orange button
          if (playing) {
            if (!this._canControlMatch()) {
              // Spectator / late joiner — do not touch the live match
              this.refreshLobbyUI();
              break;
            }
            if (comp) comp.endMatch();
            this.refreshLobbyUI();
            this.closeMenu();
            break;
          }
          // Non-host clients must not see a working Start — host owns seating/bot fill
          if (window.isMultiplayer && !this._canStartMatch()) {
            this.refreshLobbyUI();
            break;
          }
          // A bot / lobby match replaces a running cross-play match. A cross-play host that is
          // still waiting keeps waiting while this game runs, and is asked when someone joins.
          var FCw = window.FlatCompat;
          if (FCw && FCw.active && this.menuMode !== 'multi') {
            if (FCw.connected || FCw.resume || !FCw.isHost()) FCw.stop();
            else if (comp) setTimeout(function () { comp._showNotice("Still waiting for a cross-play opponent. You'll be asked when someone joins", 5000); }, 1200);
          }
          // Host starting a match interrupts any lobby Watch
          if (window.replayActive || window.replaySpectator) {
            if (window.stopMatchReplay) window.stopMatchReplay({ force: true });
          }
          // Clear dual-bot idle without sending a no-op lobby "end" while WAITING
          if (comp && typeof comp.stopLocalPreview === 'function') {
            comp.stopLocalPreview();
          } else if (comp && (comp._dualBotPreview || (comp.matchActive && !playing))) {
            if (typeof comp.onMatchEnded === 'function') comp.onMatchEnded({ cancelled: true });
          }
          if (this.menuMode === 'multi') {
            if (window.StacksLobby && window.StacksLobby.isHost &&
                typeof window.startLobbyMatch === 'function') {
              // Host start: alone → vs bot; two queued → PvP
              window.startLobbyMatch();
            }
            this.refreshLobbyUI();
            this.closeMenu();
            break;
          }
          // ALWAYS prefer lobby match when hosting — offline bot leaves spectators
          // stuck on WAITING with empty cups / no poses.
          if (window.StacksLobby && window.StacksLobby.isHost &&
              typeof window.startLobbyMatch === 'function') {
            window.startLobbyMatch();
          } else if (comp) {
            comp.startOfflineBotMatch();
          }
          this.refreshLobbyUI();
          this.closeMenu();
          break;
        case 'end-match':
          if (this._canControlMatch() && comp) comp.endMatch();
          this.refreshLobbyUI();
          break;
        case 'lobby-minus':
          this.lobbyNumber = Math.max(1, this.lobbyNumber - 1);
          this._setLobbyLabel();
          break;
        case 'lobby-plus':
          this.lobbyNumber = Math.min(10, this.lobbyNumber + 1);
          this._setLobbyLabel();
          break;
        case 'join-lobby':
          // Same button toggles JOIN ↔ LEAVE. A held/repeated trigger must NOT
          // leave then immediately rejoin the same lobby number.
          if (window.isMultiplayer) {
            if (window.endMultiplayer) window.endMultiplayer();
            this._joinCooldownUntil = performance.now() + 1500;
            this.refreshLobbyUI();
          } else if (window.connectToLobby) {
            if (this._joinCooldownUntil && performance.now() < this._joinCooldownUntil) {
              break;
            }
            if (window.FlatCompat && window.FlatCompat.active) window.FlatCompat.stop();
            this._joinCooldownUntil = 0;
            window.connectToLobby(this.lobbyNumber);
          }
          break;
        case 'join-queue':
          if (window.sendQueueAction) window.sendQueueAction('join');
          break;
        case 'leave-queue':
          if (window.sendQueueAction) window.sendQueueAction('leave');
          break;
        case 'start-match':
          if (!this._canStartMatch()) {
            this.refreshLobbyUI();
            break;
          }
          if (window.StacksLobby && window.StacksLobby.isHost &&
              typeof window.startLobbyMatch === 'function') {
            window.startLobbyMatch();
          }
          break;
        case 'stats':
          this.menuMode = 'stats';
          this.statsPage = 0;
          this.refreshLobbyUI();
          this._showStats();
          break;
        case 'stats-sp':
          this.statsSubTab = 'single';
          this.statsPage = 0;
          this._showStats();
          break;
        case 'stats-mp':
          this.statsSubTab = 'multi';
          this.statsPage = 0;
          this._showStats();
          break;
        case 'stats-prev':
          if (this.statsPage > 0) this.statsPage--;
          this._showStats();
          break;
        case 'stats-next':
          this.statsPage++;
          this._showStats();
          break;
        case 'stats-clear':
          if (window.clearStacksMatchHistory) {
            window.clearStacksMatchHistory(this.statsSubTab);
          } else if (window.StacksStats && window.StacksStats.clearHistory) {
            window.StacksStats.clearHistory(this.statsSubTab);
          }
          this.statsPage = 0;
          this._showStats();
          break;
        case 'stats-replay-0':
          this._toggleReplaySlot(0);
          break;
        case 'stats-replay-1':
          this._toggleReplaySlot(1);
          break;
        case 'stats-replay-2':
          this._toggleReplaySlot(2);
          break;
        case 'replay-latest':
          this._playLatestReplay();
          break;
        case 'toggle-start-type':
          this._toggleStartType();
          break;
        case 'hub-join':
          // Join the waiting player (cross-play matchmaking finds their slot)
          if (this._hubJoinType && window.FlatCompat && !window.FlatCompat.active) {
            window.FlatCompat.start(this._hubJoinType);
            this.closeMenu();
          }
          this._refreshHubJoin(window.VividoHub && window.VividoHub.counts);
          this.refreshLobbyUI();
          break;
        case 'cross-play':
          // Play the original flatscreen / mobile Dotmination (flat-compat.js)
          if (window.FlatCompat) {
            if (window.FlatCompat.active) window.FlatCompat.stop();
            else window.FlatCompat.start(this._startTypeOn());
          }
          this.refreshLobbyUI();
          break;
        case 'toggle-music':
          if (window.StacksAudio && typeof window.StacksAudio.toggleMusic === 'function') {
            window.StacksAudio.toggleMusic();
          } else {
            window._musicEnabled = window._musicEnabled === false;
          }
          this._setMusicButton();
          break;
        case 'toggle-passthrough': {
          var want = !(window.StacksPassthrough && window.StacksPassthrough.enabled);
          var selfPass = this;
          if (window.StacksPassthrough && window.StacksPassthrough.setEnabled) {
            window.StacksPassthrough.setEnabled(want).then(function () {
              selfPass._setPassthroughButton();
            });
          }
          this._setPassthroughButton();
          break;
        }
        case 'toggle-board':
          this._toggleBoardSize();
          break;
        case 'board-4':
          this._setBoardSizeChoice(4);
          break;
        case 'board-6':
          this._setBoardSizeChoice(6);
          break;
        case 'level-page-prev':
        case 'level-page-next':
          this._levelPage = (this._levelPage | 0) + (action === 'level-page-next' ? 5 : -5);
          this._levelPageManual = true;
          this._setLevelUI();
          break;
        case 'level-tile-0': case 'level-tile-1': case 'level-tile-2': case 'level-tile-3': case 'level-tile-4': {
          var entry = this._levelTiles && this._levelTiles[parseInt(action.slice(-1), 10)];
          var gt = document.querySelector('[dot-game]');
          var ct = gt && gt.components && gt.components['dot-game'];
          if (entry != null && ct && ct.setLevel) ct.setLevel(entry);
          this._setLevelUI();
          break;
        }
        case 'how-to-play': {
          // Original main menu "How to Play" → interactive tutorial (solo)
          var gh = document.querySelector('[dot-game]');
          var chh = gh && gh.components && gh.components['dot-game'];
          if (chh && chh.startTutorial && !window.isMultiplayer && !playing) {
            chh.startTutorial();
            if (this.menuVisible) this.toggleMenu();
          }
          break;
        }
        case 'cycle-colors': {
          var gc = document.querySelector('[dot-game]');
          var cc = gc && gc.components && gc.components['dot-game'];
          if (cc && cc.cycleColors) cc.cycleColors();
          break;
        }
        case 'noop':
          break;
        default:
          break;
      }
    },

    _nudgeBotBpm: function (dir) {
      this.botTargetBpm = saveBotBpm(stepBotBpm(this.botTargetBpm != null ? this.botTargetBpm : 12, dir));
      this._applyBotBpmToGame();
      this._setBotSpeedUI();
      pulseHaptic(this._leftHandEl || document.getElementById('leftHand'), 0.35, 30);
    },

    _applyBotBpmToGame: function () {
      var bpm = clampBotBpm(this.botTargetBpm != null ? this.botTargetBpm : loadBotBpm());
      this.botTargetBpm = bpm;
      window._botTargetBpm = bpm;
      var gm = document.querySelector('[dot-game]');
      var comp = gm && gm.components && gm.components['dot-game'];
      if (comp && typeof comp.setBotTargetBpm === 'function') {
        comp.setBotTargetBpm(bpm);
      } else if (comp && typeof comp.setBotSpeedScale === 'function') {
        // legacy hook
        comp.setBotSpeedScale(bpm);
      }
    },

    /**
     * Original level list (.list--mode-regular) as a strip of 5 cards: Random first, then every
     * unlocked level with its number, 3 stars (won · <2:00 · <1:00) and best time.
     */
    _setLevelUI: function () {
      var gl = document.querySelector('[dot-game]');
      var cl = gl && gl.components && gl.components['dot-game'];
      var info = cl && cl.levelInfo ? cl.levelInfo() : { level: 1, max: 1, best: null };
      var entries = [0];
      for (var n = 1; n <= info.max; n++) entries.push(n);
      var cur = entries.indexOf(info.level);
      if (!this._levelPageManual) this._levelPage = cur - 2;
      this._levelPageManual = false;
      var start = Math.max(0, Math.min(entries.length - 5, this._levelPage | 0));
      if (entries.length <= 5) start = 0;
      this._levelPage = start;
      this._levelTiles = entries.slice(start, start + 5);
      while (this._levelTiles.length < 5) this._levelTiles.push(null);
      this._drawLevelStrip(cl, info);
    },

    _drawLevelStrip: function (cl, info) {
      var stripEl = document.getElementById('menu-level-strip');
      var U = window.DotUI;
      if (!stripEl || !U) return;
      if (!cl) {
        var gl = document.querySelector('[dot-game]');
        cl = gl && gl.components && gl.components['dot-game'];
      }
      info = info || (cl && cl.levelInfo ? cl.levelInfo() : { level: 1, max: 1 });
      if (!this._stripCanvas) {
        this._stripCanvas = document.createElement('canvas');
        this._stripCanvas.width = 1160;
        this._stripCanvas.height = 220;
        this._stripTex = new THREE.CanvasTexture(this._stripCanvas);
        if ('colorSpace' in this._stripTex && THREE.SRGBColorSpace) this._stripTex.colorSpace = THREE.SRGBColorSpace;
      }
      var mesh = stripEl.getObject3D('mesh');
      if (mesh && mesh.material.map !== this._stripTex) {
        mesh.material.map = this._stripTex;
        mesh.material.transparent = true;
        mesh.material.needsUpdate = true;
      }
      var ctx = this._stripCanvas.getContext('2d');
      ctx.clearRect(0, 0, 1160, 220);
      var pink = (cl && cl._sideColorCss) ? cl._sideColorCss('blue') : themeYou();
      var hoverIdx = -1;
      if (this._hoveredBtn) {
        var act = this._hoveredBtn.getAttribute('data-action') || '';
        if (act.indexOf('level-tile-') === 0) hoverIdx = parseInt(act.slice(-1), 10);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var i = 0; i < 5; i++) {
        var lv = this._levelTiles[i];
        if (lv == null) continue;
        var x = 12 + i * 232, y = 10, w = 208, h = 200;
        var sel = lv === info.level, hov = i === hoverIdx;
        ctx.save();
        ctx.shadowColor = sel ? pink : (hov ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.4)');
        ctx.shadowBlur = sel ? 26 : 12;
        U.roundRect(ctx, x, y, w, h, 18);
        ctx.fillStyle = hov ? '#466f6f' : '#3b6161';
        ctx.fill();
        ctx.restore();
        if (sel) { ctx.lineWidth = 5; ctx.strokeStyle = pink; U.roundRect(ctx, x, y, w, h, 18); ctx.stroke(); }
        var fg = sel ? pink : '#ffffff';
        if (lv === 0) {
          U.icon(ctx, 'shuffle', x + w / 2, y + 74, 76, fg);
          ctx.font = '700 40px ' + U.FONT;
          ctx.fillStyle = fg;
          ctx.fillText('Random', x + w / 2, y + 150);
        } else {
          var st = cl && cl.levelStars ? cl.levelStars(lv) : { stars: 0, time: null };
          ctx.font = '700 76px ' + U.FONT;
          ctx.fillStyle = fg;
          ctx.fillText(String(lv), x + w / 2, y + 62);
          for (var k = 0; k < 3; k++) U.star(ctx, x + w / 2 + (k - 1) * 46, y + 124, 19, k < st.stars ? U.STAR_ON : U.STAR_OFF);
          ctx.font = '400 32px ' + U.FONT;
          ctx.fillStyle = '#b4c8c8';
          ctx.fillText(st.time || '--:--', x + w / 2, y + 170);
        }
      }
      this._stripTex.needsUpdate = true;
    },

    _setBotSpeedUI: function () {
      var bpm = clampBotBpm(this.botTargetBpm != null ? this.botTargetBpm : loadBotBpm());
      this.botTargetBpm = bpm;
      var txt = document.getElementById('menu-bot-speed-text');
      if (txt) {
        txt.setAttribute('value', bpm <= 0 ? '0 (off)' : (bpm + '/min'));
        txt.setAttribute('color', bpm <= 0 ? '#ff8866' : '#ffffff');
      }

      // Track: 0 → 40 BPM maps across full width
      var t = (bpm - BOT_BPM_MIN) / (BOT_BPM_MAX - BOT_BPM_MIN);
      t = Math.max(0, Math.min(1, t));
      var trackHalf = 0.17;
      var x = -trackHalf + t * trackHalf * 2;
      var fill = document.getElementById('menu-bot-speed-fill');
      var knob = document.getElementById('menu-bot-speed-knob');
      if (knob) knob.setAttribute('position', x + ' 0 0.004');
      if (fill) {
        var fillW = Math.max(0.02, (x + trackHalf));
        fill.setAttribute('geometry', 'width', fillW);
        fill.setAttribute('position', (-trackHalf + fillW / 2) + ' 0 0.002');
        var accent = bpm <= 0 ? '#555555' : (bpm < 10 ? themeOppDark() : (bpm > 20 ? '#c45a12' : themeYou()));
        fill.setAttribute('material', 'color', accent);
      }
      ['menu-bot-speed-minus', 'menu-bot-speed-plus', 'menu-bot-speed-hit'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.dataset.baseColor = el.id === 'menu-bot-speed-hit' ? '#2a4646' : '#3b6161';
        el.dataset.hoverColor = lightenHex(themeYou(), 0.4);
      });
    },

    _currentBoardSize: function () {
      // DotminationVR: this slot is the bot difficulty — 4 Normal (default), 6 Harder
      var size = (window.getBoardSize && window.getBoardSize()) || 4;
      var gm = document.querySelector('[dot-game]');
      var comp = gm && gm.components && gm.components['dot-game'];
      if (comp && comp.boardSize) size = comp.boardSize;
      if (window.lobbyState && window.lobbyState.boardSize) {
        size = window.lobbyState.boardSize === 4 ? 4 : 6;
      }
      return size === 4 ? 4 : 6;
    },

    _toggleBoardSize: function () {
      this._setBoardSizeChoice(this._currentBoardSize() === 4 ? 6 : 4);
    },

    _setBoardSizeChoice: function (size) {
      size = size === 4 ? 4 : 6;
      if (window.requestBoardSize) window.requestBoardSize(size);
      else if (window.setBoardSize) window.setBoardSize(size);
      else {
        var scene = this.el.sceneEl;
        if (scene) scene.emit('board-size-changed', { boardSize: size });
      }
      this._setBoardButton();
      pulseHaptic(this._leftHandEl || document.getElementById('leftHand'), 0.4, 35);
    },

    _setBoardButton: function () {
      var root = document.getElementById('menu-board-toggle');
      var slider = document.getElementById('menu-board-slider');
      var t4 = document.getElementById('menu-board-4-text');
      var t6 = document.getElementById('menu-board-6-text');
      if (!root) return;
      var size = this._currentBoardSize();
      var is4 = size === 4;
      // Active pill slides left (4x4) or right (6x6); ascii "x" so Roboto glyph exists
      if (slider) {
        slider.setAttribute('position', (is4 ? -0.052 : 0.052) + ' 0 0.003');
        var accent = is4 ? themeYou() : '#c45a12';
        var canEdit = !window.isMultiplayer || !!window.isHost ||
          !!(window.StacksLobby && window.StacksLobby.conn && window.StacksLobby.conn.open);
        slider.setAttribute('material', 'color', canEdit ? accent : '#555555');
      }
      if (t4) {
        t4.setAttribute('value', 'NORMAL');
        t4.setAttribute('color', is4 ? '#ffffff' : '#b4c8c8');
      }
      if (t6) {
        t6.setAttribute('value', 'HARDER');
        t6.setAttribute('color', !is4 ? '#ffffff' : '#b4c8c8');
      }
      // Keep hit targets hoverable without fighting the slider color
      ['menu-board-4', 'menu-board-6'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.dataset.baseColor = '#2a4646';
        el.dataset.hoverColor = lightenHex(themeYou(), 0.35);
      });
    },

    /** Original multiplayer start type: 'blank' | 'half' (host-synced). */
    _startTypeOn: function () {
      if (typeof window.getStartType === 'function') return window.getStartType();
      if (window.lobbyState && window.lobbyState.startType != null) return window.lobbyState.startType;
      return 'blank';
    },

    _toggleStartType: function () {
      var next = this._startTypeOn() === 'half' ? 'blank' : 'half';
      if (window.requestStartType) window.requestStartType(next);
      else if (window.setStartType) window.setStartType(next);
      else if (window.lobbyState) window.lobbyState.startType = next;
      this._setStartTypeButton();
      pulseHaptic(this._leftHandEl || document.getElementById('leftHand'), 0.35, 30);
    },

    _setStartTypeButton: function () {
      var btn = document.getElementById('menu-start-type-toggle');
      var txt = document.getElementById('menu-start-type-text');
      if (!btn) return;
      var on = this._startTypeOn();
      var canEdit = !window.isMultiplayer || !!window.isHost ||
        !!(window.StacksLobby && window.StacksLobby.conn && window.StacksLobby.conn.open);
      var color = !canEdit ? '#555555' : (on === 'half' ? '#8a3fd1' : themeYou());
      btn.setAttribute('material', 'color', color);
      btn.dataset.baseColor = color;
      btn.dataset.hoverColor = lightenHex(color, 0.42);
      if (txt) {
        txt.setAttribute('value', on === 'half' ? 'HALF-FILLED' : 'BLANK START');
        txt.setAttribute('color', '#ffffff');
      }
    },

    /** JOIN: someone (2D, Google Play, Discord or another VR player) hosts a match you can join now. */
    _refreshHubJoin: function (c) {
      var btn = document.getElementById('menu-hub-join');
      var txt = document.getElementById('menu-hub-join-text');
      if (!btn || !window.VividoHub) return;
      var FC = window.FlatCompat;
      var busy = (FC && FC.active) || window.isMultiplayer || this._isRealMatchPlaying();
      var open = c ? window.VividoHub.joinable(c) : {};
      var types = Object.keys(open).sort(function (a, b) { return open[b] - open[a]; });
      var t = busy ? null : types[0];
      this._hubJoinType = t || null;
      btn.setAttribute('visible', !!t);
      if (txt && t) txt.setAttribute('value', 'JOIN ' + (t === 'half-filled' ? 'HALF-FILLED' : 'BLANK') + ' MATCH');
      var live = document.getElementById('menu-live-text');
      if (live) live.setAttribute('position', t ? '-0.12 -0.262 0.002' : '0 -0.262 0.002');
    },

    /** CROSS-PLAY on/off (original flatscreen / mobile Dotmination, flat-compat.js). */
    _setCrossPlayButton: function () {
      var btn = document.getElementById('menu-cross-play');
      var txt = document.getElementById('menu-cross-play-text');
      if (!btn) return;
      var on = !!(window.FlatCompat && window.FlatCompat.active);
      var color = on ? '#c0392b' : themeOppDark();
      btn.setAttribute('material', 'color', color);
      btn.dataset.baseColor = color;
      btn.dataset.hoverColor = lightenHex(color, 0.42);
      if (txt) txt.setAttribute('value', on ? 'LEAVE X-PLAY' : 'CROSS-PLAY');
    },

    _setMusicButton: function () {
      var btn = document.getElementById('menu-music-toggle');
      var txt = document.getElementById('menu-music-text');
      if (!btn) return;
      var on = window.StacksAudio
        ? window.StacksAudio.isMusicEnabled()
        : window._musicEnabled !== false;
      var color = on ? themeOppDark() : '#555555';
      btn.setAttribute('material', 'color', color);
      btn.dataset.baseColor = color;
      btn.dataset.hoverColor = lightenHex(color, 0.42);
      if (txt) txt.setAttribute('value', on ? 'MUSIC' : 'MUTED');
    },

    _setPassthroughButton: function () {
      var btn = document.getElementById('menu-passthrough-toggle');
      var txt = document.getElementById('menu-passthrough-text');
      if (!btn) return;
      var on = !!(window.StacksPassthrough && window.StacksPassthrough.enabled);
      var color = on ? themeOppDark() : '#3b6161';
      btn.setAttribute('material', 'color', color);
      btn.dataset.baseColor = color;
      btn.dataset.hoverColor = lightenHex(color, 0.42);
      if (txt) {
        txt.setAttribute('value', on ? 'PASS ON' : 'PASS');
        txt.setAttribute('color', on ? '#ffffff' : '#b4c8c8');
      }
    },

    _setLobbyLabel: function () {
      var el = document.getElementById('menu-lobby-num');
      if (el) el.setAttribute('value', String(this.lobbyNumber));
      var joinBtn = document.getElementById('menu-join') ||
        document.querySelector('[data-action="join-lobby"]');
      var joinText = document.getElementById('menu-join-text');
      if (!joinBtn) return;
      var label;
      var color;
      if (window.connectionState === 'connecting') {
        label = 'JOINING...';
        color = themeYouDark();
      } else if (window.isMultiplayer) {
        label = window.isHost ? 'LEAVE' : 'LEAVE';
        color = '#c0392b';
        } else {
        label = 'JOIN';
        color = themeOppDark();
      }
      if (joinText) joinText.setAttribute('value', label);
      else joinBtn.setAttribute('text', 'value', label);
      joinBtn.setAttribute('material', 'color', color);
      joinBtn.dataset.baseColor = color;
      joinBtn.dataset.hoverColor = lightenHex(color, 0.42);
    },

    _setStartButton: function () {
      var btn = document.getElementById('menu-start-match');
      var txt = document.getElementById('menu-start-match-text');
      if (!btn) return;
      var playing = this._isRealMatchPlaying();
      var canControl = this._canControlMatch();
      var canStart = this._canStartMatch();
      var label;
      var color;
      var action = 'start-bot';
      if (playing && canControl) {
        label = 'END MATCH';
        color = '#c0392b';
      } else if (playing && !canControl) {
        // Late joiner / spectator watching a live match — no end control
        label = 'SPECTATING';
        color = '#4a6a6a';
        action = 'noop';
      } else if (this.menuMode === 'multi' && window.isMultiplayer) {
        // Only HOST can start. Seated clients used to see START MATCH but
        // handleMatchAction silently ignored them — confusing dead control.
        if (canStart) {
          // Queue is required to play — empty queue = spectate dual bots
          var qLen = (window.lobbyState && window.lobbyState.queue &&
            window.lobbyState.queue.length) || 0;
          var inQ = !!(window.lobbyState && window.myPlayerId &&
            window.lobbyState.queue &&
            window.lobbyState.queue.indexOf(window.myPlayerId) >= 0);
          label = inQ ? 'START MATCH' : (qLen ? 'START (WATCH)' : 'START BOTS');
          color = themeYou();
        } else {
          label = 'WAIT FOR HOST';
          color = '#4a6a6a';
          action = 'noop';
        }
      } else if (this.menuMode === 'multi') {
        label = 'START MATCH';
        color = themeYou();
      } else {
        label = 'START vs BOT';
        color = themeYou();
      }
      if (txt) txt.setAttribute('value', label);
      btn.setAttribute('material', 'color', color);
      btn.dataset.baseColor = color;
      btn.dataset.hoverColor = lightenHex(color, 0.42);
      btn.setAttribute('data-action', action);
    },

    _nickForLobby: function (ls, id) {
      if (!id) return '-';
      if (id === '__BOT__') return 'Bot';
      var players = (ls && ls.players) || [];
      for (var i = 0; i < players.length; i++) {
        if (players[i].id === id) {
          return (players[i].nickname || 'Player').slice(0, 10);
        }
      }
      return '?';
    },

    _setQueueSlot: function (idx, opts) {
      var nameEl = document.getElementById('menu-q-slot-' + idx + '-name');
      var numEl = document.getElementById('menu-q-slot-' + idx + '-num');
      var bg = document.getElementById('menu-q-slot-' + idx + '-bg');
      var accent = document.getElementById('menu-q-slot-' + idx + '-accent');
      if (!nameEl || !bg) return;
      var filled = !!opts.filled;
      var isYou = !!opts.isYou;
      var label = opts.label || 'Open';
      var badge = opts.badge || String(idx + 1);
      nameEl.setAttribute('value', label);
      nameEl.setAttribute('color', filled ? (isYou ? '#ffffff' : '#ffffff') : '#5a7a7a');
      if (numEl) {
        numEl.setAttribute('value', badge);
        numEl.setAttribute('color', filled ? (isYou ? '#ffe08a' : '#b4c8c8') : '#8fa6a6');
      }
      var bgColor = !filled ? '#2a4646' : (isYou ? '#1f3636' : '#3b6161');
      var accentColor = !filled ? '#3b5555' : (isYou ? themeOpp() : (opts.accent || themeOpp()));
      bg.setAttribute('material', 'color', bgColor);
      if (accent) accent.setAttribute('material', 'color', accentColor);
    },

    _refreshQueuePanel: function () {
      var panel = this.queuePanel || document.getElementById('menu-queue-panel');
      if (!panel) return;
      var multi = this.menuMode === 'multi';
      var connected = !!window.isMultiplayer;
      panel.setAttribute('visible', multi && connected);

      if (!multi || !connected) return;

      var ls = window.lobbyState;
      var myId = window.myPlayerId ||
        (window.StacksLobby && window.StacksLobby.myPlayerId);
      var title = document.getElementById('menu-queue-title');
      var hint = document.getElementById('menu-queue-hint');
      var playing = !!(ls && ls.matchState === 'PLAYING');
      var mp = (ls && ls.matchPlayers) || {};

      if (playing && (mp.blue || mp.red)) {
        if (title) title.setAttribute('value', 'MATCH');
        if (hint) hint.setAttribute('value', 'In progress');
        this._setQueueSlot(0, {
          filled: !!mp.blue,
          isYou: mp.blue === myId,
          label: this._nickForLobby(ls, mp.blue),
          badge: 'B',
          accent: themeYouLight()
        });
        this._setQueueSlot(1, {
          filled: !!mp.red,
          isYou: mp.red === myId && mp.red !== '__BOT__',
          label: this._nickForLobby(ls, mp.red),
          badge: 'R',
          accent: '#e25a4a'
        });
      } else {
        var q = (ls && ls.queue) || [];
        var qLen = q.length;
        if (title) title.setAttribute('value', 'QUEUE  ' + qLen + '/2');
        if (hint) {
          hint.setAttribute('value',
            qLen >= 2 ? 'Ready | host starts' :
            (qLen === 1 ? '1 more or vs bot' : 'Join to play'));
        }
        for (var i = 0; i < 2; i++) {
          var id = q[i];
          this._setQueueSlot(i, {
            filled: !!id,
            isYou: id && id === myId,
            label: id ? this._nickForLobby(ls, id) : 'Open',
            badge: String(i + 1),
            accent: i === 0 ? themeYouLight() : '#e25a4a'
          });
        }
      }

      var inQ = !!(ls && myId && (ls.queue || []).indexOf(myId) >= 0);
      // Quick rematch (1–2 VR players): JOIN QUEUE reads PLAY AGAIN; the host
      // starts by itself once everyone is ready
      var rm = !playing ? this._rematchMenuInfo(ls, myId) : null;
      if (rm) {
        if (title) title.setAttribute('value', 'PLAY AGAIN  ' + rm.info.ready.length + '/' + rm.info.players.length);
        if (hint) hint.setAttribute('value', rm.hint);
        for (var ri = 0; ri < 2; ri++) {
          var rid = rm.info.players[ri];
          var rReady = !!rid && rm.info.ready.indexOf(rid) >= 0;
          this._setQueueSlot(ri, {
            filled: rReady,
            isYou: rid && rid === myId,
            label: rid ? this._nickForLobby(ls, rid) + (rReady ? '  READY' : '') : 'Bot',
            badge: String(ri + 1),
            accent: rReady ? '#44cc66' : '#667788'
          });
        }
      }
      var joinBtn = document.getElementById('menu-join-queue');
      var leaveBtn = document.getElementById('menu-leave-queue');
      var joinTxt = document.getElementById('menu-join-queue-text');
      var leaveTxt = document.getElementById('menu-leave-queue-text');
      if (joinBtn) {
        var jc = inQ ? '#1f3636' : themeOppDark();
        joinBtn.setAttribute('material', 'color', jc);
        joinBtn.dataset.baseColor = jc;
        joinBtn.dataset.hoverColor = lightenHex(jc, 0.42);
        if (joinTxt) {
          joinTxt.setAttribute('value', rm ? (inQ ? 'READY' : 'PLAY AGAIN') : (inQ ? 'QUEUED' : 'JOIN QUEUE'));
          joinTxt.setAttribute('color', inQ ? '#b4c8c8' : '#ffffff');
        }
      }
      if (leaveBtn) {
        var lc = inQ ? '#a93226' : '#3a2222';
        leaveBtn.setAttribute('material', 'color', lc);
        leaveBtn.dataset.baseColor = lc;
        leaveBtn.dataset.hoverColor = lightenHex(lc, 0.42);
        if (leaveTxt) {
          leaveTxt.setAttribute('value', 'LEAVE');
          leaveTxt.setAttribute('color', inQ ? '#ffffff' : '#886666');
        }
      }
    },

    /**
     * "Change Colors": static menu parts drawn in the previous scheme's colours are moved to the
     * new one (materials, hover colours, texts), then every dynamic button is re-coloured.
     */
    _applyTheme: function (prev) {
      var root = document.getElementById('vr-menu-root');
      var map = {};
      var put = function (from, to) { if (from) map[String(from).toLowerCase()] = to; };
      put(prev.you, themeYou());
      put(lightenHex(prev.you, 0.3), themeYouLight());
      put(darkenHex(prev.you, 0.15), themeYouDark());
      put(prev.opp, themeOpp());
      put(darkenHex(prev.opp, 0.3), themeOppDark());
      // The markup's hand-picked brand shades (first change away from the default scheme)
      if (String(prev.you).toLowerCase() === '#e11168') {
        put('#ff4d94', themeYouLight());
        put('#c40f5b', themeYouDark());
        put('#f0207a', themeYouLight());
      }
      if (String(prev.opp).toLowerCase() === '#12dace') put('#0f9b93', themeOppDark());
      if (root) {
        root.querySelectorAll('[material]').forEach(function (el) {
          var m = el.getAttribute('material');
          var c = m && m.color && String(m.color).toLowerCase();
          if (c && map[c]) el.setAttribute('material', 'color', map[c]);
          if (el.dataset.baseColor && map[el.dataset.baseColor.toLowerCase()]) {
            el.dataset.baseColor = map[el.dataset.baseColor.toLowerCase()];
            el.dataset.hoverColor = lightenHex(el.dataset.baseColor, 0.42);
          }
        });
        // a-text and primitives (a-plane …) carry a plain color attribute
        root.querySelectorAll('[color]').forEach(function (el) {
          var c = String(el.getAttribute('color') || '').toLowerCase();
          if (map[c]) el.setAttribute('color', map[c]);
        });
      }
      this.refreshLobbyUI();
    },

    /** lobby.js rematchInfo() for this player + a one-line status, or null. */
    _rematchMenuInfo: function (ls, myId) {
      if (!window.isMultiplayer || window.isMobileSpectator) return null;
      var info = typeof window.rematchInfo === 'function' ? window.rematchInfo() : null;
      if (!info || !myId || info.players.indexOf(myId) < 0) return null;
      var meReady = info.ready.indexOf(myId) >= 0;
      var others = info.players.filter(function (id) { return id !== myId; });
      var otherReady = others.some(function (id) { return info.ready.indexOf(id) >= 0; });
      var name = others.length ? this._nickForLobby(ls, others[0]) : '';
      var hint;
      if (!others.length) hint = 'Play again vs bot';
      else if (meReady) hint = otherReady ? 'Starting...' : 'Waiting for ' + name;
      else hint = otherReady ? name + ' is ready!' : 'Both ready = next match';
      return { info: info, hint: hint, meReady: meReady };
    },

    refreshLobbyUI: function () {
      var multi = this.menuMode === 'multi';
      var stats = this.menuMode === 'stats';
      if (this.singleSection) this.singleSection.setAttribute('visible', !multi && !stats);
      if (this.lobbySection) this.lobbySection.setAttribute('visible', multi);
      if (this.statsSection) this.statsSection.setAttribute('visible', stats);
      this._refreshQueuePanel();
      var startBtn = document.getElementById('menu-start-match');
      if (startBtn) startBtn.setAttribute('visible', !stats);
      this._setTabColors();
      this._setLobbyLabel();
      this._setStartButton();
      this._setMusicButton();
      this._setPassthroughButton();
      this._setBoardButton();
      this._setStartTypeButton();
      this._setCrossPlayButton();
      this._setLevelUI();
      if (stats) this._showStats();

      var status = document.getElementById('menu-lobby-status');
      if (status) {
        var live = window.StacksLobbyStatus || '';
        var ls = window.lobbyState;
        var msg;
        if (window.FlatCompat && (window.FlatCompat.active || window.FlatCompat.status) && !window.isMultiplayer) {
          msg = 'CROSS-PLAY | ' + (window.FlatCompat.status || 'off');
        } else if (window.connectionState === 'connecting' && live) {
          msg = live;
        } else if (!window.isMultiplayer) {
          msg = live || 'Not connected - pick lobby & JOIN';
        } else if (!ls) {
          msg = live || 'Connecting...';
        } else {
          var vrCount = 0;
          var plist = ls.players || [];
          for (var pi = 0; pi < plist.length; pi++) {
            if (plist[pi] && !plist[pi].mobile) vrCount++;
          }
          var role = window.isHost ? 'HOST' : (window.isMobileSpectator ? 'WATCH' : 'JOINED');
          // One line only — queue names live in the slots below
          msg = role + ' | ' + vrCount + ' in lobby';
          if (live && live.indexOf(role) < 0) msg = live + ' | ' + msg;
        }
        status.setAttribute('value', msg);
      }

      // Keep wrist/world version stamp current when lobby role changes
      var verEl = document.getElementById('version-display');
      if (verEl) {
        var ver = 'v' + (window.STACKS_VERSION || '0.0.0');
        var fpsMatch = (verEl.getAttribute('text') && verEl.getAttribute('text').value || '')
          .match(/(\d+)\s*FPS/);
        var bits = [ver];
        if (fpsMatch) bits.push(fpsMatch[1] + ' FPS');
        if (window.isMultiplayer) {
          bits.push(window.isHost ? 'HOST' : (window.isMobileSpectator ? 'WATCH' : 'JOINED'));
        }
        verEl.setAttribute('text', 'value', bits.join(' | '));
      }

      this._applySeatPose();
    },

    _resetRigLocal: function () {
      var rig = document.getElementById('rig');
      if (!rig) return;
      rig.setAttribute('position', '0 0 0');
      rig.setAttribute('rotation', '0 0 0');
    },

    _movePlayerTo: function (pos) {
      var player = document.getElementById('player');
      if (!player) return;
      player.setAttribute('position', pos.x + ' ' + (pos.y || 0) + ' ' + pos.z);
      // Yaw on player (locomotion root) — never offset #rig or snap-turn orbits off-body
      player.object3D.rotation.y = THREE.MathUtils.degToRad(pos.ry || 0);
      this._resetRigLocal();
    },

    /** Stable 0..3 index when spectatorSlots hasn't listed us yet. */
    _lobbySlotFallbackIndex: function (ls, myId) {
      var plist = (ls && ls.players) || [];
      var n = 0;
      for (var i = 0; i < plist.length; i++) {
        var p = plist[i];
        if (!p || !p.id || p.mobile) continue;
        if (p.id === myId) return n % 4;
        n++;
      }
      return 0;
    },

    _applySeatPose: function () {
      if (!window.isMultiplayer || !window.lobbyState) return;
      var myId = window.myPlayerId || (window.StacksLobby && window.StacksLobby.myPlayerId);
      if (!myId) return;

      var ls = window.lobbyState;
      var mp = ls.matchPlayers || {};
      var isBlue = mp.blue === myId;
      var isRed = mp.red === myId && mp.red !== '__BOT__';
      // Queued humans are pre-seated blue/red in WAITING — stand at that cup.
      // Anyone else needs a UNIQUE lobby/spectator slot (never pile onto blue).
      var usePlaySeat = isBlue || isRed;
      var slots = ls.spectatorSlots || [];
      var specIdx = slots.indexOf(myId);
      if (specIdx < 0 && !usePlaySeat) {
        specIdx = this._lobbySlotFallbackIndex(ls, myId);
      }
      var playing = ls.matchState === 'PLAYING';
      var ring = playing ? SPECTATOR_POSITIONS : LOBBY_WAIT_POSITIONS;
      var ringIdx = ((specIdx % ring.length) + ring.length) % ring.length;

      var gmSeat = document.querySelector('[dot-game]');
      var compSeat = gmSeat && gmSeat.components && gmSeat.components['dot-game'];
      var key = usePlaySeat
        ? ('play:' + (isRed ? 'red' : 'blue') + ':' + ((compSeat && compSeat.mode) || ''))
        : ((playing ? 'spec:' : 'wait:') + ringIdx);

      // Force a snap when a match just started so queued players land on cups
      // even if they already previewed the same play:* seat while WAITING.
      if (playing && this._poseMatchState !== 'PLAYING') {
        this._poseKey = '';
      }
      this._poseMatchState = ls.matchState || 'WAITING';

      // Spectator gameplay flag only while a live match is on and you're not seated
      if (!usePlaySeat && playing) {
        window.isSpectator = true;
        if (window.StacksLobby) window.StacksLobby.isSpectator = true;
      } else {
        window.isSpectator = false;
        if (window.StacksLobby) window.StacksLobby.isSpectator = false;
      }

      // Body tint: cup seat color, else default blue for lobby wait
      // Seat colour from the current palette (original colours: blue seat = player--2 pink)
      var gpc = document.querySelector('[dot-game]');
      var cpc = gpc && gpc.components && gpc.components['dot-game'];
      this._setLocalBodyColor(cpc && cpc._sideColorCss ? cpc._sideColorCss(isRed ? 'red' : 'blue') : (isRed ? themeOpp() : themeYou()));

      if (key === this._poseKey) return;
      this._poseKey = key;

      if (usePlaySeat && isRed) {
        this._movePlayerTo((compSeat && compSeat.seatPose && compSeat.seatPose('red')) || PLAY_POSITION_RED);
      } else if (usePlaySeat) {
        this._movePlayerTo((compSeat && compSeat.seatPose && compSeat.seatPose('blue')) || PLAY_POSITION_BLUE);
      } else {
        this._movePlayerTo(ring[ringIdx]);
      }
    },

    _setLocalBodyColor: function (hex) {
      var body = document.getElementById('player-body');
      if (!body) return;
      var gtc = document.querySelector('[dot-game]');
      var ctc = gtc && gtc.components && gtc.components['dot-game'];
      if (ctc && ctc._tintBody) { ctc._tintBody(body, hex); return; } // colour + glow
      try {
        body.setAttribute('mixamo-body', 'color', hex);
      } catch (e) { /* ignore */ }
      // Also tint any already-loaded meshes if the component caches color
      var mb = body.components && body.components['mixamo-body'];
      if (mb) {
        mb.data = mb.data || {};
        mb.data.color = hex;
        if (typeof mb.update === 'function') {
          try { mb.update({ color: hex }); } catch (e2) { /* ignore */ }
        }
        if (mb.model) {
          var col = new THREE.Color(hex);
          mb.model.traverse(function (o) {
            if (o.isMesh && o.material && o.material.color) {
              o.material.color.copy(col);
            }
          });
        }
      }
    },

    _setStatsTabColors: function () {
      var sp = document.getElementById('menu-stats-sp');
      var mp = document.getElementById('menu-stats-mp');
      if (sp) {
        var c = this.statsSubTab === 'single' ? themeYouLight() : '#3b6161';
        sp.setAttribute('material', 'color', c);
        sp.dataset.baseColor = c;
      }
      if (mp) {
        var c2 = this.statsSubTab === 'multi' ? themeYouLight() : '#3b6161';
        mp.setAttribute('material', 'color', c2);
        mp.dataset.baseColor = c2;
      }
    },

    _showStats: function () {
      this._setStatsTabColors();
      var hist = (window.StacksStats && window.StacksStats.loadHistory)
        ? window.StacksStats.loadHistory()
        : { single: [], multi: [], bests: {} };
      var list = this.statsSubTab === 'multi' ? (hist.multi || []) : (hist.single || []);
      var nick = (window.playerNickname || 'Player').slice(0, 12);
      var bests = (window.StacksStats && window.StacksStats.getBests)
        ? window.StacksStats.getBests(nick)
        : null;
      var fmt = (window.StacksStats && window.StacksStats.formatDuration)
        ? window.StacksStats.formatDuration
        : function (ms) {
          var s = Math.floor((ms || 0) / 1000);
          return Math.floor(s / 60) + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60);
        };

      var summary = document.getElementById('menu-stats-summary');
      var panel = document.getElementById('menu-stats-text');
      var pageEl = document.getElementById('menu-stats-page');
      if (!panel) return;

      var wins = 0;
      var losses = 0;
      for (var wi = 0; wi < list.length; wi++) {
        if (list[wi].result === 'WIN') wins++;
        else if (list[wi].result === 'LOSS') losses++;
      }

      // DotminationVR terms only (StacksVR's MPM / Atk / Blk / Lay / Peak don't exist here)
      var gmc = document.querySelector('[dot-game]');
      var dg = gmc && gmc.components && gmc.components['dot-game'];
      var lvlInfo = dg && dg.levelInfo ? dg.levelInfo() : null;
      var sumLines = [];
      if (bests && (bests.matches | 0) > 0) {
        sumLines.push(nick + '  ' + (bests.wins | 0) + 'W-' + (bests.losses | 0) + 'L' +
          (lvlInfo ? '   Level ' + lvlInfo.max + ' unlocked' : ''));
        sumLines.push('Most chains ' + (bests.bestChains | 0) +
          '   Longest chain ' + ((bests.bestMaxCombo | 0) >= 2 ? (bests.bestMaxCombo | 0) : '-') +
          '   Win streak ' + (bests.bestWinStreak | 0));
        // Original "View Stats": best / worst level time
        var ex = dg && dg.levelTimeExtremes ? dg.levelTimeExtremes() : null;
        if (ex && ex.best) {
          sumLines.push('Best time ' + ex.best.time + ' (L' + ex.best.level + ')' +
            '   Worst time ' + ex.worst.time + ' (L' + ex.worst.level + ')');
        } else {
          sumLines.push('Longest match ' + fmt(bests.longestMs));
        }
      } else if (list.length) {
        sumLines.push((this.statsSubTab === 'multi' ? 'PvP' : 'vs Bot') +
          '  ' + wins + 'W-' + losses + 'L');
      } else {
        sumLines.push('No ' + (this.statsSubTab === 'multi' ? 'PvP' : 'bot') + ' matches yet');
      }
      if (summary) summary.setAttribute('value', sumLines.join('\n'));

      var replayBtns = [];
      var replayTexts = [];
      for (var ri = 0; ri < this.STATS_PER_PAGE; ri++) {
        replayBtns.push(document.getElementById('menu-stats-replay-' + ri));
        replayTexts.push(document.getElementById('menu-stats-replay-' + ri + '-text'));
        if (replayBtns[ri]) replayBtns[ri].setAttribute('visible', false);
      }

      if (!list.length) {
        panel.setAttribute('value', 'Play a match to track\nprogression & bests.');
        if (pageEl) pageEl.setAttribute('value', '');
        return;
      }

      var totalPages = Math.max(1, Math.ceil(list.length / this.STATS_PER_PAGE));
      if (this.statsPage >= totalPages) this.statsPage = totalPages - 1;
      if (this.statsPage < 0) this.statsPage = 0;
      var start = this.statsPage * this.STATS_PER_PAGE;
      var end = Math.min(start + this.STATS_PER_PAGE, list.length);
      var lines = [];
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      for (var j = start; j < end; j++) {
        var m = list[j];
        var res = m.result || '?';
        var header = '#' + (j + 1) + ' ' + res + '  ' +
          (m.playerScore | 0) + '-' + (m.opponentScore | 0);
        if (m.opponentName) header += ' vs ' + m.opponentName;
        else if (m.bot) header += ' vs Bot';
        lines.push(header);
        var p = m.player || {};
        if (p.blocks != null) {
          lines.push('  ' + (m.level ? 'Level ' + m.level : (m.bot ? 'Random map' : 'PvP')) +
            '  Moves ' + (p.blocks | 0) +
            '  Chains ' + (p.chains | 0) +
            '  Longest ' + ((p.maxCombo | 0) >= 2 ? (p.maxCombo | 0) : '-') +
            '  ' + fmt(p.durationMs));
        }
        if (m.timestamp) {
          var d = new Date(m.timestamp);
          lines.push('  ' + months[d.getMonth()] + ' ' + d.getDate() +
            ' ' + d.getHours() + ':' +
            (d.getMinutes() < 10 ? '0' : '') + d.getMinutes());
        }
        lines.push('');
      }
      panel.setAttribute('value', lines.join('\n'));
      if (pageEl) {
        pageEl.setAttribute('value',
          totalPages > 1 ? (this.statsPage + 1) + ' / ' + totalPages : '');
      }

      var activeTs = (window.replayActive && window.matchReplayPlayer)
        ? window.matchReplayPlayer._matchTimestamp : null;
      var gate = window.stacksReplayGate;
      var liveMatch = gate ? gate.isLiveMatchPlaying() : this._isRealMatchPlaying();
      var canStartWatch = gate ? gate.canStart() : !liveMatch;
      var canStopWatch = gate ? gate.canCancel() : true;
      if (!window.matchReplayStorage) return;
      var selfStats = this;
      for (var si = 0; si < end - start; si++) {
        (function (slotIdx, match) {
          if (!match || !match.timestamp) return;
          if (activeTs && match.timestamp === activeTs) {
            if (replayBtns[slotIdx]) {
              replayBtns[slotIdx].setAttribute('visible', true);
              replayBtns[slotIdx].setAttribute('material', 'color',
                canStopWatch ? '#c0392b' : '#555555');
            }
            if (replayTexts[slotIdx]) {
              replayTexts[slotIdx].setAttribute('value', canStopWatch ? 'Stop' : 'Watching');
            }
            return;
          }
          window.matchReplayStorage.load(match.timestamp).then(function (replay) {
            if (!replay || !replayBtns[slotIdx]) return;
            // Events-only or legacy frames both count
            var usable = (replay.events && replay.events.length) ||
              (replay.frames && replay.frames.length);
            if (!usable) return;
            replayBtns[slotIdx].setAttribute('visible', true);
            if (liveMatch || !canStartWatch) {
              replayBtns[slotIdx].setAttribute('material', 'color', '#555555');
              if (replayTexts[slotIdx]) {
                replayTexts[slotIdx].setAttribute('value',
                  liveMatch ? 'In match' : 'Watch');
              }
            } else {
              replayBtns[slotIdx].setAttribute('material', 'color', themeYouLight());
              if (replayTexts[slotIdx]) replayTexts[slotIdx].setAttribute('value', 'Watch');
            }
            if (selfStats.refreshRaycasters) selfStats.refreshRaycasters();
          }).catch(function () { /* no replay */ });
        })(si, list[start + si]);
      }
    },

    _toggleReplaySlot: function (slot) {
      var hist = (window.StacksStats && window.StacksStats.loadHistory)
        ? window.StacksStats.loadHistory()
        : { single: [], multi: [] };
      var list = this.statsSubTab === 'multi' ? (hist.multi || []) : (hist.single || []);
      var idx = this.statsPage * this.STATS_PER_PAGE + slot;
      if (idx >= list.length) return;
      var match = list[idx];
      if (!match || !match.timestamp) return;

      var gate = window.stacksReplayGate;
      var activeSame = window.replayActive && window.matchReplayPlayer &&
        window.matchReplayPlayer._matchTimestamp === match.timestamp;

      // Stop only if host (or offline) — clients stay on Watching
      if (activeSame) {
        if (gate && !gate.canCancel()) return;
        if (window.stopMatchReplay) window.stopMatchReplay();
        this._showStats();
        return;
      }

      if (gate && !gate.canStart()) return;
      if (window.startMatchReplay) {
        window.startMatchReplay(match.timestamp);
        this.menuVisible = false;
        if (this.menu) this.menu.setAttribute('visible', false);
        if (typeof this.setRaycasters === 'function') this.setRaycasters(false);
      }
    },

    _playLatestReplay: function () {
      if (!window.matchReplayStorage) return;
      var gate = window.stacksReplayGate;
      if (gate && !gate.canStart()) return;
      var self = this;
      window.matchReplayStorage.list().then(function (keys) {
        if (!keys || !keys.length) return;
        if (gate && !gate.canStart()) return;
        var latest = keys.sort(function (a, b) { return b - a; })[0];
        if (window.startMatchReplay) {
          window.startMatchReplay(latest);
          self.menuVisible = false;
          if (self.menu) self.menu.setAttribute('visible', false);
          if (typeof self.setRaycasters === 'function') self.setRaycasters(false);
        }
      });
    }
  });
})();
