// game-menu.js — VR menu, lobby queue, stats & replay browser for StacksVR
(function () {
  'use strict';

  // Diagonal position stagger, head-on Z facing (not 45° cup yaw)
  var PLAY_POSITION_BLUE = { x: -0.65, y: 0, z: 1.75, ry: 0 };
  var PLAY_POSITION_RED = { x: 0.65, y: 0, z: -1.75, ry: 180 };
  // Back-compat alias
  var PLAY_POSITION = PLAY_POSITION_BLUE;

  var SPECTATOR_POSITIONS = [
    { x: -3.2, y: 0, z: 2.8, ry: -20 },
    { x: 3.2, y: 0, z: 2.8, ry: 20 },
    { x: -3.2, y: 0, z: -2.8, ry: -160 },
    { x: 3.2, y: 0, z: -2.8, ry: 160 }
  ];

  function lightenHex(hex, amount) {
    amount = amount == null ? 0.35 : amount;
    var h = String(hex || '#444').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return '#88aacc';
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
  var BOT_BPM_KEY = 'stacksvr.botTargetBpm.v1';
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

  AFRAME.registerComponent('vr-menu', {
    init: function () {
      this.menuVisible = false;
      this.menuMode = 'single';
      this.lobbyNumber = 1;
      this.botTargetBpm = loadBotBpm();
      this.statsPage = 0;
      this.STATS_PER_PAGE = 4;
      this._refsReady = false;
      this._xWasDown = false;
      this._menuToggleAt = 0;
      this._poseKey = '';
      this._hoveredBtn = null;
      this._lastActionAt = 0;
      this._lastActionName = '';
      var self = this;

      this.el.sceneEl.addEventListener('loaded', function () { self.cacheRefs(); });
      if (this.el.sceneEl.hasLoaded) this.cacheRefs();

      function onMenuButton() { self.requestToggleMenu(); }
      this.el.sceneEl.addEventListener('xbuttondown', onMenuButton);
      this.el.sceneEl.addEventListener('lobby-state-updated', function () { self.refreshLobbyUI(); });
      this.el.sceneEl.addEventListener('board-size-changed', function () { self._setBoardButton(); });

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
      this.queueButtons = document.getElementById('menu-queue-buttons');
      this.leftHand = document.getElementById('leftHand');
      this.rightHand = document.getElementById('rightHand');
      this._refsReady = true;
      this._attachMenuToLeftHand();
      this._bindClicks();
      this.setRaycasters(false);
      this.botTargetBpm = loadBotBpm();
      this.refreshLobbyUI();
      this._applyBotBpmToGame();
    },

    /** Real human/bot/multi match — dual-bot desktop preview does not count. */
    _isRealMatchPlaying: function () {
      var gm = document.querySelector('[stacks-game]');
      var comp = gm && gm.components['stacks-game'];
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
          el.setAttribute('material', 'color', el.dataset.hoverColor);
          el.setAttribute('scale', '1.04 1.04 1.04');
          pulseHaptic(handEl || null, 0.35, 28);
        }
        function hoverOff() {
          if (self._hoveredBtn !== el) return;
          self._hoveredBtn = null;
          el.setAttribute('material', 'color', el.dataset.baseColor);
          el.setAttribute('scale', '1 1 1');
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
        var color = on ? '#1e6ad4' : '#1a2433';
        el.setAttribute('material', 'color', color);
        el.dataset.baseColor = color;
        el.dataset.hoverColor = lightenHex(color, on ? 0.28 : 0.45);
        var label = el.querySelector('a-text');
        if (label) label.setAttribute('color', on ? '#ffffff' : '#a8b8c8');
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

      var gm = document.querySelector('[stacks-game]');
      var comp = gm && gm.components['stacks-game'];
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
            } else if (window.sendMatchAction) {
              window.sendMatchAction('start');
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
          } else if (window.isMultiplayer && typeof window.sendMatchAction === 'function') {
            window.sendMatchAction('start');
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
      if (window.isMultiplayer) {
            if (window.endMultiplayer) window.endMultiplayer();
            this.refreshLobbyUI();
          } else if (window.connectToLobby) {
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
          if (window.sendMatchAction) window.sendMatchAction('start');
          else if (window.StacksLobby && window.StacksLobby.isHost) window.startLobbyMatch();
          break;
        case 'stats':
          this.menuMode = 'stats';
          this.refreshLobbyUI();
          this._showStats();
          break;
        case 'replay-latest':
          this._playLatestReplay();
          break;
        case 'toggle-music':
          if (window.StacksAudio && typeof window.StacksAudio.toggleMusic === 'function') {
            window.StacksAudio.toggleMusic();
          } else {
            window._musicEnabled = window._musicEnabled === false;
          }
          this._setMusicButton();
          break;
        case 'toggle-board':
          this._toggleBoardSize();
          break;
        case 'board-4':
          this._setBoardSizeChoice(4);
          break;
        case 'board-6':
          this._setBoardSizeChoice(6);
          break;
        case 'bot-speed-minus':
          this._nudgeBotBpm(-1);
          break;
        case 'bot-speed-plus':
          this._nudgeBotBpm(1);
          break;
        case 'bot-speed-track':
          this._nudgeBotBpm(1);
          break;
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
      var gm = document.querySelector('[stacks-game]');
      var comp = gm && gm.components && gm.components['stacks-game'];
      if (comp && typeof comp.setBotTargetBpm === 'function') {
        comp.setBotTargetBpm(bpm);
      } else if (comp && typeof comp.setBotSpeedScale === 'function') {
        // legacy hook
        comp.setBotSpeedScale(bpm);
      }
    },

    _setBotSpeedUI: function () {
      var bpm = clampBotBpm(this.botTargetBpm != null ? this.botTargetBpm : loadBotBpm());
      this.botTargetBpm = bpm;
      var txt = document.getElementById('menu-bot-speed-text');
      if (txt) {
        txt.setAttribute('value', bpm <= 0 ? '0 (off)' : (bpm + '/min'));
        txt.setAttribute('color', bpm <= 0 ? '#ff8866' : '#e8f4ff');
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
        var accent = bpm <= 0 ? '#555555' : (bpm < 10 ? '#3d8f5a' : (bpm > 20 ? '#c45a12' : '#1e6ad4'));
        fill.setAttribute('material', 'color', accent);
      }
      ['menu-bot-speed-minus', 'menu-bot-speed-plus', 'menu-bot-speed-hit'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.dataset.baseColor = el.id === 'menu-bot-speed-hit' ? '#152032' : '#243044';
        el.dataset.hoverColor = lightenHex('#1e6ad4', 0.4);
      });
    },

    _currentBoardSize: function () {
      var size = (window.getBoardSize && window.getBoardSize()) || 6;
      var gm = document.querySelector('[stacks-game]');
      var comp = gm && gm.components && gm.components['stacks-game'];
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
        var accent = is4 ? '#c45a12' : '#1e6ad4';
        var canEdit = !window.isMultiplayer || !!window.isHost ||
          !!(window.StacksLobby && window.StacksLobby.conn && window.StacksLobby.conn.open);
        slider.setAttribute('material', 'color', canEdit ? accent : '#555555');
      }
      if (t4) {
        t4.setAttribute('value', '4x4');
        t4.setAttribute('color', is4 ? '#ffffff' : '#8a9bb0');
      }
      if (t6) {
        t6.setAttribute('value', '6x6');
        t6.setAttribute('color', !is4 ? '#ffffff' : '#8a9bb0');
      }
      // Keep hit targets hoverable without fighting the slider color
      ['menu-board-4', 'menu-board-6'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.dataset.baseColor = '#152032';
        el.dataset.hoverColor = lightenHex('#1e6ad4', 0.35);
      });
    },

    _setMusicButton: function () {
      var btn = document.getElementById('menu-music-toggle');
      var txt = document.getElementById('menu-music-text');
      if (!btn) return;
      var on = window.StacksAudio
        ? window.StacksAudio.isMusicEnabled()
        : window._musicEnabled !== false;
      var color = on ? '#1f9d45' : '#555555';
      btn.setAttribute('material', 'color', color);
      btn.dataset.baseColor = color;
      btn.dataset.hoverColor = lightenHex(color, 0.42);
      if (txt) txt.setAttribute('value', on ? 'MUSIC' : 'MUTED');
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
        color = '#cc8800';
      } else if (window.isMultiplayer) {
        label = window.isHost ? 'LEAVE' : 'LEAVE';
        color = '#cc3333';
      } else {
        label = 'JOIN';
        color = '#22aa44';
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
      var label;
      var color;
      var action = 'start-bot';
      if (playing && canControl) {
        label = 'END MATCH';
        color = '#cc3333';
      } else if (playing && !canControl) {
        // Late joiner / spectator watching a live match — no end control
        label = 'SPECTATING';
        color = '#445566';
        action = 'noop';
      } else if (this.menuMode === 'multi') {
        label = canControl || !window.isMultiplayer || window.isHost
          ? 'START MATCH'
          : 'WAITING';
        color = (canControl || !window.isMultiplayer || window.isHost) ? '#ff8800' : '#445566';
        if (!(canControl || !window.isMultiplayer || window.isHost)) action = 'noop';
      } else {
        label = 'START vs BOT';
        color = '#ff8800';
      }
      if (txt) txt.setAttribute('value', label);
      btn.setAttribute('material', 'color', color);
      btn.dataset.baseColor = color;
      btn.dataset.hoverColor = lightenHex(color, 0.42);
      btn.setAttribute('data-action', action);
    },

    refreshLobbyUI: function () {
      var multi = this.menuMode === 'multi';
      var stats = this.menuMode === 'stats';
      if (this.singleSection) this.singleSection.setAttribute('visible', !multi && !stats);
      if (this.lobbySection) this.lobbySection.setAttribute('visible', multi);
      if (this.statsSection) this.statsSection.setAttribute('visible', stats);
      if (this.queueButtons) {
        this.queueButtons.setAttribute('visible', multi && !!window.isMultiplayer);
      }
      this._setTabColors();
      this._setLobbyLabel();
      this._setStartButton();
      this._setMusicButton();
      this._setBoardButton();
      this._setBotSpeedUI();
      if (stats) this._showStats();

      var status = document.getElementById('menu-lobby-status');
      if (status) {
        var live = window.StacksLobbyStatus || '';
      var ls = window.lobbyState;
        var msg;
        if (window.connectionState === 'connecting' && live) {
          msg = live;
        } else if (!window.isMultiplayer) {
          msg = live || 'Not connected';
        } else if (!ls) {
          msg = live || 'Connecting...';
        } else {
          var mp = ls.matchPlayers || {};
          var q = (ls.queue || []).length;
          var role = window.isHost ? 'HOST' : (window.isMobileSpectator ? 'WATCH' : 'JOINED');
          var detail = role + ' L' + (window.StacksLobby && window.StacksLobby.lobbyNum ? window.StacksLobby.lobbyNum : '?') +
            ' | ' + (ls.matchState || 'WAITING') +
            ' | B:' + (mp.blue ? 'Y' : '-') +
            ' R:' + (mp.red ? (mp.red === '__BOT__' ? 'BOT' : 'Y') : '-') +
            ' | Q:' + q;
          msg = live ? (live + ' · ' + detail) : detail;
        }
        status.setAttribute('value', msg);
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

    _applySeatPose: function () {
      if (!window.isMultiplayer || !window.lobbyState) return;
      var myId = window.myPlayerId || (window.StacksLobby && window.StacksLobby.myPlayerId);
      if (!myId) return;

      var ls = window.lobbyState;
      var mp = ls.matchPlayers || {};
      var isBlue = mp.blue === myId;
      var isRed = mp.red === myId && mp.red !== '__BOT__';
      var isMatchPlayer = isBlue || isRed;
      var inQueue = (ls.queue || []).indexOf(myId) >= 0;
      var slots = ls.spectatorSlots || [];
      var specIdx = slots.indexOf(myId);

      // Only park in spectator corners while a match is on and you're not playing.
      // Joining/hosting a lobby must NOT yank the player off the table.
      var useSpectator = !isMatchPlayer && !inQueue &&
        ls.matchState === 'PLAYING' && specIdx >= 0;

      var playSide = isRed ? 'red' : 'blue';
      var key = useSpectator
        ? ('spec:' + (specIdx % SPECTATOR_POSITIONS.length))
        : ('play:' + playSide);

      // Always sync spectator flag — early pose-key return used to leave a stale
      // isSpectator=true that blocked place/cup-grab after host vs-bot start.
      if (useSpectator) {
        window.isSpectator = true;
        if (window.StacksLobby) window.StacksLobby.isSpectator = true;
      } else {
        window.isSpectator = false;
        if (window.StacksLobby) window.StacksLobby.isSpectator = false;
      }

      if (key === this._poseKey) return;
      this._poseKey = key;

      if (useSpectator) {
        var p = SPECTATOR_POSITIONS[specIdx % SPECTATOR_POSITIONS.length];
        this._movePlayerTo(p);
      } else if (isRed) {
        this._movePlayerTo(PLAY_POSITION_RED);
      } else {
        this._movePlayerTo(PLAY_POSITION_BLUE);
      }
    },

    _showStats: function () {
      var KEY = 'stacksvr-match-history';
      var list = [];
      try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { list = []; }
      var panel = document.getElementById('menu-stats-text');
      if (!panel) return;
      if (!list.length) {
        panel.setAttribute('value', 'No matches yet');
        return;
      }
      var start = this.statsPage * this.STATS_PER_PAGE;
      var slice = list.slice(start, start + this.STATS_PER_PAGE);
      var lines = slice.map(function (m, i) {
        var d = new Date(m.ts);
        return (start + i + 1) + '. ' + d.toLocaleDateString() + ' ' +
          (m.bot ? 'BOT' : 'PvP') + ' ' + m.blue + '-' + m.red +
          (m.winner ? ' W:' + m.winner : '');
      });
      panel.setAttribute('value', lines.join('\n'));
    },

    _playLatestReplay: function () {
      if (!window.matchReplayStorage) return;
      window.matchReplayStorage.list().then(function (keys) {
        if (!keys || !keys.length) return;
        var latest = keys.sort(function (a, b) { return b - a; })[0];
        return window.matchReplayStorage.load(latest).then(function (replay) {
          if (replay && window.matchReplayPlayer) window.matchReplayPlayer.play(replay);
        });
      });
    }
  });
})();
