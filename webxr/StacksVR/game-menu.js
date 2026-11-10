// game-menu.js — VR menu, lobby queue, stats & replay browser for StacksVR
(function () {
  'use strict';

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
      var self = this;

      this.el.sceneEl.addEventListener('loaded', function () { self.cacheRefs(); });
      if (this.el.sceneEl.hasLoaded) this.cacheRefs();

      function onMenuButton() { self.requestToggleMenu(); }
      this.el.sceneEl.addEventListener('xbuttondown', onMenuButton);
      this.el.sceneEl.addEventListener('lobby-state-updated', function () { self.refreshLobbyUI(); });

      setTimeout(function attachX() {
        var leftHand = document.getElementById('leftHand');
        if (leftHand) {
          leftHand.addEventListener('xbuttondown', onMenuButton);
          // Quest / WebXR sometimes skips A-Frame button events when hand+laser share an entity
          leftHand.addEventListener('controllerconnected', function () {
            self._leftHandEl = leftHand;
          });
          self._leftHandEl = leftHand;
        } else setTimeout(attachX, 400);
      }, 100);

      this.el.sceneEl.addEventListener('enter-vr', function () {
        var overlay = document.getElementById('pre-vr-overlay');
        if (overlay) overlay.style.display = 'none';
      });
    },

    // Edge-detect left X (XR button index 4) so menu works even if xbuttondown never fires
    tick: function () {
      var hand = this._leftHandEl || document.getElementById('leftHand');
      if (!hand) return;
      var tracked = hand.components['tracked-controls'] ||
        hand.components['tracked-controls-webxr'] ||
        hand.components['oculus-touch-controls'] ||
        hand.components['meta-touch-controls'];
      var gp = tracked && tracked.controller && tracked.controller.gamepad;
      if (!gp || !gp.buttons || !gp.buttons[4]) return;
      var down = !!gp.buttons[4].pressed;
      if (down && !this._xWasDown) this.requestToggleMenu();
      this._xWasDown = down;
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
      this._refsReady = true;
      this._bindClicks();
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

    toggleMenu: function () {
      this.menuVisible = !this.menuVisible;
      var root = document.getElementById('vr-menu-root');
      if (root) root.setAttribute('visible', this.menuVisible);
      var lh = document.getElementById('leftHand');
      var rh = document.getElementById('rightHand');
      if (this.menuVisible) {
        if (lh) lh.setAttribute('raycaster', 'objects', '.menu-btn');
        if (rh) rh.setAttribute('raycaster', 'objects', '.menu-btn');
      } else {
        if (lh) lh.setAttribute('raycaster', 'objects', '.clickable');
        if (rh) rh.setAttribute('raycaster', 'objects', '.clickable');
      }
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
          this.menuVisible = false;
          var root = document.getElementById('vr-menu-root');
          if (root) root.setAttribute('visible', false);
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

      // Spectator seating
      this._applySpectatorPose();
    },

    _applySpectatorPose: function () {
      if (!window.isMultiplayer || !window.lobbyState) return;
      var myId = window.myPlayerId || (window.StacksLobby && window.StacksLobby.myPlayerId);
      var mp = window.lobbyState.matchPlayers || {};
      var isPlayer = mp.blue === myId || mp.red === myId;
      var rig = document.getElementById('rig');
      if (!rig) return;
      if (isPlayer) {
        if (mp.blue === myId) rig.setAttribute('position', '0 0 1.8');
        else rig.setAttribute('position', '0 0 1.8');
        return;
      }
      var slots = window.lobbyState.spectatorSlots || [];
      var idx = slots.indexOf(myId);
      if (idx < 0) idx = 0;
      var p = SPECTATOR_POSITIONS[idx % SPECTATOR_POSITIONS.length];
      rig.setAttribute('position', p.x + ' 0 ' + p.z);
      rig.setAttribute('rotation', '0 ' + p.ry + ' 0');
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
      var self = this;
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
