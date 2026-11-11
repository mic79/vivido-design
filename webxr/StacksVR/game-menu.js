// game-menu.js — VR menu, lobby queue, stats & replay browser for StacksVR
(function () {
  'use strict';

  // Diagonal position stagger, head-on Z facing (not 45° cup yaw)
  var PLAY_POSITION = { x: -0.65, y: 0, z: 1.75, ry: 0 };

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

  AFRAME.registerComponent('vr-menu', {
    init: function () {
      this.menuVisible = false;
      this.menuMode = 'single';
      this.lobbyNumber = 1;
      this.statsPage = 0;
      this.STATS_PER_PAGE = 4;
      this._refsReady = false;
      this._xWasDown = false;
      this._menuToggleAt = 0;
      this._poseKey = '';
      this._hoveredBtn = null;
      var self = this;

      this.el.sceneEl.addEventListener('loaded', function () { self.cacheRefs(); });
      if (this.el.sceneEl.hasLoaded) this.cacheRefs();

      function onMenuButton() { self.requestToggleMenu(); }
      this.el.sceneEl.addEventListener('xbuttondown', onMenuButton);
      this.el.sceneEl.addEventListener('lobby-state-updated', function () { self.refreshLobbyUI(); });

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
          // Fallback select when laser-controls click doesn't fire
          rightHand.addEventListener('triggerdown', function () {
            if (!self.menuVisible || !self._hoveredBtn) return;
            var el = self._hoveredBtn;
            if (!isEffectivelyVisible(el)) return;
            pulseHaptic(rightHand, 0.7, 55);
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
      this.refreshLobbyUI();
    },

    /** Real human/bot/multi match — dual-bot desktop preview does not count. */
    _isRealMatchPlaying: function () {
      var gm = document.querySelector('[stacks-game]');
      var comp = gm && gm.components['stacks-game'];
      if (comp && comp._dualBotPreview) return false;
      // Lobby PLAYING is authoritative while hosting / joined
      if (window.lobbyState && window.lobbyState.matchState === 'PLAYING') return true;
      if (!comp || !comp.matchActive) return false;
      if (!comp.modes || !comp.modes.active) return false;
      return true;
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
            if (comp) comp.endMatch();
            this.refreshLobbyUI();
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
          if (comp) comp.endMatch();
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
        default:
          break;
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
      var label;
      var color;
      if (playing) {
        label = 'END MATCH';
        color = '#cc3333';
      } else if (this.menuMode === 'multi') {
        label = 'START MATCH';
        color = '#ff8800';
      } else {
        label = 'START vs BOT';
        color = '#ff8800';
      }
      if (txt) txt.setAttribute('value', label);
      btn.setAttribute('material', 'color', color);
      btn.dataset.baseColor = color;
      btn.dataset.hoverColor = lightenHex(color, 0.42);
      // Keep data-action as start-bot (handles end when playing)
      btn.setAttribute('data-action', 'start-bot');
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
      var isMatchPlayer = mp.blue === myId || (mp.red === myId && mp.red !== '__BOT__');
      var inQueue = (ls.queue || []).indexOf(myId) >= 0;
      var slots = ls.spectatorSlots || [];
      var specIdx = slots.indexOf(myId);

      // Only park in spectator corners while a match is on and you're not playing.
      // Joining/hosting a lobby must NOT yank the player off the table.
      var useSpectator = !isMatchPlayer && !inQueue &&
        ls.matchState === 'PLAYING' && specIdx >= 0;

      var key = useSpectator
        ? ('spec:' + (specIdx % SPECTATOR_POSITIONS.length))
        : 'play';
      if (key === this._poseKey) return;
      this._poseKey = key;

      if (useSpectator) {
        var p = SPECTATOR_POSITIONS[specIdx % SPECTATOR_POSITIONS.length];
        this._movePlayerTo(p);
        window.isSpectator = true;
        } else {
        this._movePlayerTo(PLAY_POSITION);
        window.isSpectator = false;
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
