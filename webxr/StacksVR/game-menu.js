// game-menu.js — VR menu, lobby queue, stats & replay browser for StacksVR
(function () {
  'use strict';

  var PLAY_POSITION = { x: 0, y: 0, z: 1.35, ry: 0 };

  var SPECTATOR_POSITIONS = [
    { x: -3.5, y: 0, z: 2.5, ry: -40 },
    { x: 3.5, y: 0, z: 2.5, ry: 40 },
    { x: -3.5, y: 0, z: -2.0, ry: -140 },
    { x: 3.5, y: 0, z: -2.0, ry: 140 }
  ];

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
      this._menuPos = new THREE.Vector3();
      this._menuFwd = new THREE.Vector3();
      this._camPos = new THREE.Vector3();
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
        }
        // laser-controls re-enables lines on controllerconnected — stamp them back off
        function guardLasers(hand) {
          if (!hand) return;
          hand.addEventListener('controllerconnected', function () {
            if (!self.menuVisible) self.setRaycasters(false);
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
      }
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

    requestToggleMenu: function () {
      var now = performance.now();
      if (now - this._menuToggleAt < 250) return;
      this._menuToggleAt = now;
      this.toggleMenu();
    },

    cacheRefs: function () {
      this.menu = document.getElementById('vr-menu-root');
      this.lobbySection = document.getElementById('menu-lobby-section');
      this.queueButtons = document.getElementById('menu-queue-buttons');
      this.leftHand = document.getElementById('leftHand');
      this.rightHand = document.getElementById('rightHand');
      this._refsReady = true;
      this._bindClicks();
      this.setRaycasters(false);
      this.refreshLobbyUI();
    },

    _bindClicks: function () {
      var self = this;
      var root = document.getElementById('vr-menu-root');
      if (!root) return;
      root.querySelectorAll('.menu-btn').forEach(function (el) {
        el.addEventListener('click', function () {
          var action = el.getAttribute('data-action');
          self.handleAction(action);
        });
      });
    },

    setRaycasters: function (enabled) {
      this._setHandRaycaster(this.leftHand || document.getElementById('leftHand'), enabled);
      this._setHandRaycaster(this.rightHand || document.getElementById('rightHand'), enabled);
    },

    _setHandRaycaster: function (hand, enabled) {
      if (!hand) return;
      hand.setAttribute('raycaster', {
        objects: enabled ? '.menu-btn' : '',
        showLine: enabled,
        lineColor: '#9fe6b8',
        lineOpacity: enabled ? 0.85 : 0,
        far: 4,
        enabled: !!enabled
      });
      // laser-controls keeps a Line child — force hide when menu closed
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

    // Keep menu under a-scene (camera parenting hides / misplaces it in WebXR).
    // Park it in world space ~1.2m in front of the headset, facing the player.
    _placeMenuInView: function () {
      var root = document.getElementById('vr-menu-root');
      var cam = document.getElementById('camera');
      if (!root || !cam || !root.object3D) return;

      cam.object3D.getWorldPosition(this._camPos);
      cam.object3D.getWorldDirection(this._menuFwd); // where the headset looks
      this._menuFwd.y = 0;
      if (this._menuFwd.lengthSq() < 1e-6) this._menuFwd.set(0, 0, -1);
      this._menuFwd.normalize();

      this._menuPos.copy(this._camPos).addScaledVector(this._menuFwd, 1.2);
      this._menuPos.y = this._camPos.y - 0.12;

      root.object3D.position.copy(this._menuPos);
      // Plane faces +Z; yaw so +Z points back at the camera
      var yaw = Math.atan2(
        this._camPos.x - this._menuPos.x,
        this._camPos.z - this._menuPos.z
      );
      root.object3D.rotation.set(0, yaw, 0);
      root.object3D.visible = true;
      root.setAttribute('visible', true);
    },

    toggleMenu: function () {
      this.menuVisible = !this.menuVisible;
      var root = document.getElementById('vr-menu-root');
      if (this.menuVisible) {
        this._placeMenuInView();
        this.setRaycasters(true);
      } else {
        if (root) {
          root.setAttribute('visible', false);
          if (root.object3D) root.object3D.visible = false;
        }
        this.setRaycasters(false);
      }
    },

    closeMenu: function () {
      this.menuVisible = false;
      var root = document.getElementById('vr-menu-root');
      if (root) {
        root.setAttribute('visible', false);
        if (root.object3D) root.object3D.visible = false;
      }
      this.setRaycasters(false);
    },

    handleAction: function (action) {
      var gm = document.querySelector('[stacks-game]');
      var comp = gm && gm.components['stacks-game'];
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
          if (comp) comp.startOfflineBotMatch();
          this.closeMenu();
          break;
        case 'end-match':
          if (comp) comp.endMatch();
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
          if (window.connectToLobby) window.connectToLobby(this.lobbyNumber);
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
      if (el) el.setAttribute('text', 'value', 'Lobby ' + this.lobbyNumber);
      var joinBtn = document.querySelector('[data-action="join-lobby"]');
      if (joinBtn) joinBtn.setAttribute('text', 'value', 'Connect Lobby ' + this.lobbyNumber);
    },

    refreshLobbyUI: function () {
      var multi = this.menuMode === 'multi';
      if (this.lobbySection) this.lobbySection.setAttribute('visible', multi);
      if (this.queueButtons) {
        this.queueButtons.setAttribute('visible', multi && !!window.isMultiplayer);
      }
      this._setLobbyLabel();

      var status = document.getElementById('menu-lobby-status');
      if (status) {
        var ls = window.lobbyState;
        if (!window.isMultiplayer) {
          status.setAttribute('text', 'value', 'Not connected');
        } else if (!ls) {
          status.setAttribute('text', 'value', 'Connecting...');
        } else {
          var mp = ls.matchPlayers || {};
          var q = (ls.queue || []).length;
          status.setAttribute('text', 'value',
            ls.matchState + ' | B:' + (mp.blue ? 'Y' : '-') + ' R:' + (mp.red ? (mp.red === '__BOT__' ? 'BOT' : 'Y') : '-') +
            ' | Q:' + q + ' Spec:' + (ls.spectatorSlots || []).filter(Boolean).length);
        }
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
        panel.setAttribute('text', 'value', 'No matches yet');
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
      panel.setAttribute('text', 'value', lines.join('\n'));
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
