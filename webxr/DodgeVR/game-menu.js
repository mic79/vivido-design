/* game-menu.js - VR Menu, Lobby, Queue & Spectator system for DodgeVR */

(function () {
  'use strict';

  var SPECTATOR_POSITIONS = [
    { x: -4, y: 0, z: 3, ry: -53 },
    { x: 4, y: 0, z: 3, ry: 53 },
    { x: -4, y: 0, z: -3, ry: -127 },
    { x: 4, y: 0, z: -3, ry: 127 }
  ];

  var PLAYER_POSITION_BLUE = { x: 0, y: 0, z: 6 };

  AFRAME.registerComponent('vr-menu', {
    init: function () {
      this.menuVisible = false;
      this.menuMode = 'single';
      this.lobbyNumber = 1;
      this._refsReady = false;

      this.menu = null;
      this.leftHand = null;
      this.rightHand = null;
      this.lobbySection = null;
      this.queueButtons = null;

      var self = this;

      if (this.el.hasLoaded) {
        this.cacheRefs();
      }
      this.el.addEventListener('loaded', function () {
        self.cacheRefs();
      });

      // X button is on the left controller - listen there AND on scene for robustness
      this.el.sceneEl.addEventListener('xbuttondown', function () {
        self.toggleMenu();
      });
      // Also attach directly to the left hand entity once available
      function attachXButton() {
        var leftHand = document.getElementById('leftHand');
        if (leftHand) {
          leftHand.addEventListener('xbuttondown', function () {
            self.toggleMenu();
          });
        } else {
          setTimeout(attachXButton, 500);
        }
      }
      setTimeout(attachXButton, 100);

      this.el.sceneEl.addEventListener('enter-vr', function () {
        var overlay = document.getElementById('pre-vr-overlay');
        if (overlay) overlay.style.display = 'none';
      });

      this.el.sceneEl.addEventListener('lobby-state-updated', function () {
        self.updateMenuDisplay();
      });
    },

    cacheRefs: function () {
      this.menu = document.getElementById('game-menu');
      this.leftHand = document.getElementById('leftHand');
      this.rightHand = document.getElementById('rightHand');
      this.lobbySection = document.getElementById('menu-lobby-section');
      this.queueButtons = document.getElementById('menu-queue-buttons');
      this._refsReady = !!(this.menu && this.leftHand && this.rightHand);
    },

    ensureRefs: function () {
      if (!this._refsReady) this.cacheRefs();
    },

    toggleMenu: function () {
      var now = Date.now();
      if (now - (this._lastToggle || 0) < 400) return;
      this._lastToggle = now;

      this.ensureRefs();
      this.menuVisible = !this.menuVisible;
      console.log('VR Menu toggled:', this.menuVisible, 'menu ref:', !!this.menu);
      if (this.menu) this.menu.setAttribute('visible', this.menuVisible);
      this.setRaycasters(this.menuVisible);
      if (this.menuVisible) this.updateMenuDisplay();
    },

    setRaycasters: function (enabled) {
      this.ensureRefs();
      var hands = [this.leftHand, this.rightHand];
      for (var i = 0; i < hands.length; i++) {
        var hand = hands[i];
        if (!hand) continue;
        hand.setAttribute('raycaster', {
          objects: enabled ? '.clickable' : '',
          lineColor: '#ffffff',
          lineOpacity: enabled ? 1 : 0,
          far: 10,
          enabled: enabled
        });
        // Force line visibility via the raycaster's internal line mesh
        var rc = hand.components.raycaster;
        if (rc && rc.line) {
          rc.line.visible = enabled;
        }
      }
    },

    handleMenuClick: function (buttonId) {
      switch (buttonId) {
        case 'menu-single': this.setMode('single'); break;
        case 'menu-multi': this.setMode('multi'); break;
        case 'menu-lobby-minus':
          this.lobbyNumber = Math.max(1, this.lobbyNumber - 1);
          this.updateLobbyNumberDisplay();
          break;
        case 'menu-lobby-plus':
          this.lobbyNumber = Math.min(10, this.lobbyNumber + 1);
          this.updateLobbyNumberDisplay();
          break;
        case 'menu-join': this.handleJoin(); break;
        case 'menu-join-queue': this.joinQueue(); break;
        case 'menu-leave-queue': this.leaveQueue(); break;
        case 'menu-mirror-toggle': this.toggleMirrorMode(); break;
        case 'menu-start-match': this.toggleMatch(); break;
      }
    },

    setMode: function (mode) {
      this.menuMode = mode;
      var singleBtn = document.getElementById('menu-single');
      var multiBtn = document.getElementById('menu-multi');
      if (singleBtn) singleBtn.setAttribute('material', 'color', mode === 'single' ? '#4488ff' : '#333333');
      if (multiBtn) multiBtn.setAttribute('material', 'color', mode === 'multi' ? '#4488ff' : '#333333');
      if (this.lobbySection) this.lobbySection.setAttribute('visible', mode === 'multi');
      if (this.queueButtons) this.queueButtons.setAttribute('visible', mode === 'multi' && window.isMultiplayer);

      var mirrorSection = document.getElementById('menu-mirror-section');
      if (mirrorSection) mirrorSection.setAttribute('visible', mode === 'single');

      if (mode === 'multi') {
        this.setMirrorMode(false);
      }

      if (mode === 'single' && window.isMultiplayer) {
        if (typeof window.endMultiplayer === 'function') window.endMultiplayer();
        this.moveToMatchPosition();
      }
      this.updateMenuDisplay();
    },

    toggleMirrorMode: function () {
      this.setMirrorMode(!window.botMirrorMode);
    },

    setMirrorMode: function (enabled) {
      window.botMirrorMode = enabled;
      var mirrorText = document.getElementById('menu-mirror-text');
      var mirrorBtn = document.getElementById('menu-mirror-toggle');
      if (mirrorText) mirrorText.setAttribute('text', 'value', enabled ? 'MIRRORED' : 'NORMAL');
      if (mirrorBtn) mirrorBtn.setAttribute('material', 'color', enabled ? '#4488ff' : '#555555');

      if (!enabled) {
        var botEntity = document.querySelector('[advanced-bot]');
        if (botEntity) botEntity.object3D.position.set(0, 1.6, -6);
        var botBall = document.querySelector('[simple-grab="player: player1"]');
        if (botBall && botBall.components['simple-grab']) {
          botBall.components['simple-grab'].resetPosition();
        }
        var botBodyEl = document.getElementById('bot-body');
        if (botBodyEl && botBodyEl.components['mixamo-body']) {
          botBodyEl.components['mixamo-body']._mirrorRefs = false;
        }
      }
    },

    updateLobbyNumberDisplay: function () {
      var numDisplay = document.getElementById('menu-lobby-number');
      if (numDisplay) numDisplay.setAttribute('text', 'value', this.lobbyNumber.toString());
    },

    handleJoin: function () {
      if (window.isMultiplayer) {
        if (typeof window.endMultiplayer === 'function') window.endMultiplayer();
        this.moveToMatchPosition();
        this.updateMenuDisplay();
      } else {
        if (typeof window.connectToLobby === 'function') {
          window.connectToLobby(this.lobbyNumber);
        }
      }
    },

    joinQueue: function () {
      if (typeof window.sendQueueAction === 'function') {
        window.sendQueueAction('join');
      }
    },

    leaveQueue: function () {
      if (typeof window.sendQueueAction === 'function') {
        window.sendQueueAction('leave');
      }
    },

    toggleMatch: function () {
      var ls = window.lobbyState;
      if (!window.isMultiplayer) {
        this.startSingleplayerMatch();
        return;
      }
      if (typeof window.sendMatchAction === 'function') {
        if (ls && ls.matchState === 'PLAYING') {
          window.sendMatchAction('end');
        } else {
          window.sendMatchAction('start');
        }
      }
      this.menuVisible = false;
      if (this.menu) this.menu.setAttribute('visible', false);
      this.setRaycasters(false);
    },

    startSingleplayerMatch: function () {
      var gmEl = document.querySelector('#game-manager');
      if (gmEl && gmEl.components['game-manager']) {
        var gm = gmEl.components['game-manager'];
        if (gm.matchState === 'PLAYING' || gm.matchState === 'OVERTIME' || gm.matchState === 'COUNTDOWN') {
          gm.endMatch();
          this.updateMenuDisplay();
          return;
        }
        if (gm.matchState === 'WAITING' || gm.matchState === 'ENDED') {
          if (gm.matchState === 'ENDED') gm.resetMatch();
          else gm.startCountdown();
        }
      }
      this.menuVisible = false;
      if (this.menu) this.menu.setAttribute('visible', false);
      this.setRaycasters(false);
    },

    movePlayerToPosition: function (pos) {
      var player = document.getElementById('player');
      if (player) {
        player.setAttribute('position', pos.x + ' ' + pos.y + ' ' + pos.z);
        if (pos.ry !== undefined) {
          var rig = document.getElementById('rig');
          if (rig) rig.setAttribute('rotation', '0 ' + pos.ry + ' 0');
        }
        var pc = player.components['player-collision'];
        if (pc && pc.body) {
          pc.body.position.set(pos.x, (pos.y || 0) + 1.0, pos.z);
          pc.body.velocity.set(0, 0, 0);
        }
      }
    },

    moveToSpectator: function (slotIndex) {
      if (slotIndex >= 0 && slotIndex < SPECTATOR_POSITIONS.length) {
        this.movePlayerToPosition(SPECTATOR_POSITIONS[slotIndex]);
        window.isSpectator = true;
        this.disableBallInteraction(true);
      }
    },

    moveToMatchPosition: function () {
      this.movePlayerToPosition(PLAYER_POSITION_BLUE);
      var rig = document.getElementById('rig');
      if (rig) rig.setAttribute('rotation', '0 0 0');
      window.isSpectator = false;
      this.disableBallInteraction(false);
    },

    disableBallInteraction: function (disable) {
      var blueBall = document.querySelector('[simple-grab="player: player2"]');
      if (blueBall && blueBall.components['simple-grab']) {
        blueBall.components['simple-grab'].spectatorMode = disable;
      }
    },

    updateMenuDisplay: function () {
      this.ensureRefs();
      var ls = window.lobbyState;

      var joinBtn = document.getElementById('menu-join');
      if (joinBtn) {
        var joinText = joinBtn.querySelector('a-text');
        if (joinText) {
          if (window.isMultiplayer) {
            joinText.setAttribute('text', 'value', 'LEAVE');
            joinBtn.setAttribute('material', 'color', '#cc3333');
          } else {
            joinText.setAttribute('text', 'value', 'JOIN');
            joinBtn.setAttribute('material', 'color', '#22aa44');
          }
        }
      }

      var mirrorSection = document.getElementById('menu-mirror-section');
      if (mirrorSection) mirrorSection.setAttribute('visible', this.menuMode === 'single');
      var mirrorText = document.getElementById('menu-mirror-text');
      var mirrorBtn = document.getElementById('menu-mirror-toggle');
      if (mirrorText) mirrorText.setAttribute('text', 'value', window.botMirrorMode ? 'MIRRORED' : 'NORMAL');
      if (mirrorBtn) mirrorBtn.setAttribute('material', 'color', window.botMirrorMode ? '#4488ff' : '#555555');

      if (!ls) {
        if (this.queueButtons) this.queueButtons.setAttribute('visible', false);
        var startMatchBtn = document.getElementById('menu-start-match');
        if (startMatchBtn) {
          startMatchBtn.setAttribute('visible', true);
          var stxt = document.getElementById('menu-start-match-text');
          var gmEl = document.querySelector('#game-manager');
          var gm = gmEl && gmEl.components['game-manager'];
          var isPlaying = gm && (gm.matchState === 'PLAYING' || gm.matchState === 'OVERTIME' || gm.matchState === 'COUNTDOWN');
          if (stxt) stxt.setAttribute('text', 'value', isPlaying ? 'END MATCH' : 'START MATCH');
          startMatchBtn.setAttribute('material', 'color', isPlaying ? '#cc3333' : '#ff8800');
        }
        return;
      }

      var playersList = document.getElementById('menu-players-list');
      if (playersList) {
        var text = 'Players:';
        for (var i = 0; i < ls.players.length; i++) {
          var p = ls.players[i];
          text += '\n  ' + p.nickname + (p.id === window.myPlayerId ? ' (you)' : '');
        }
        playersList.setAttribute('text', 'value', text);
      }

      var queueStatus = document.getElementById('menu-queue-status');
      if (queueStatus) {
        var qtext = '';
        if (ls.matchPlayers.blue || ls.matchPlayers.red) {
          var blueName = '-', redName = '-';
          for (var j = 0; j < ls.players.length; j++) {
            if (ls.players[j].id === ls.matchPlayers.blue) blueName = ls.players[j].nickname;
            if (ls.players[j].id === ls.matchPlayers.red) redName = ls.players[j].nickname;
          }
          qtext += 'Match: ' + blueName + ' vs ' + redName + '\n';
        }
        if (ls.queue.length > 0) {
          var names = [];
          for (var k = 0; k < ls.queue.length; k++) {
            var qp = null;
            for (var m = 0; m < ls.players.length; m++) {
              if (ls.players[m].id === ls.queue[k]) { qp = ls.players[m]; break; }
            }
            names.push(qp ? qp.nickname : '?');
          }
          qtext += 'Queue: ' + names.join(', ');
        }
        if (ls.matchState === 'PLAYING') qtext += '\nMatch in progress';
        queueStatus.setAttribute('text', 'value', qtext);
      }

      if (this.queueButtons && this.menuMode === 'multi') {
        this.queueButtons.setAttribute('visible', window.isMultiplayer);
      }

      var inQueue = ls.queue.indexOf(window.myPlayerId) >= 0;
      var isMatchPlayer = ls.matchPlayers.blue === window.myPlayerId || ls.matchPlayers.red === window.myPlayerId;
      var matchNotStarted = ls.matchState !== 'PLAYING';
      var joinQueueBtn = document.getElementById('menu-join-queue');
      var leaveQueueBtn = document.getElementById('menu-leave-queue');
      // Show "Join Queue" when not in queue and not in a match spot
      if (joinQueueBtn) joinQueueBtn.setAttribute('visible', !inQueue && !isMatchPlayer);
      // Show "Leave Queue" when in queue OR in a match spot before match has started
      if (leaveQueueBtn) leaveQueueBtn.setAttribute('visible', inQueue || (isMatchPlayer && matchNotStarted));

      var startMatchBtn2 = document.getElementById('menu-start-match');
      var startMatchText = document.getElementById('menu-start-match-text');
      if (startMatchBtn2 && startMatchText) {
        var bothSlotsFilled = ls.matchPlayers.blue && ls.matchPlayers.red;
        if (isMatchPlayer && ls.matchState === 'PLAYING') {
          startMatchBtn2.setAttribute('visible', true);
          startMatchText.setAttribute('text', 'value', 'END MATCH');
          startMatchBtn2.setAttribute('material', 'color', '#cc3333');
        } else if (isMatchPlayer && bothSlotsFilled) {
          startMatchBtn2.setAttribute('visible', true);
          startMatchText.setAttribute('text', 'value', 'START MATCH');
          startMatchBtn2.setAttribute('material', 'color', '#ff8800');
        } else {
          startMatchBtn2.setAttribute('visible', false);
        }
      }

    }
  });

  function lightenColor(hex, amount) {
    var c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var r = parseInt(c.substring(0, 2), 16);
    var g = parseInt(c.substring(2, 4), 16);
    var b = parseInt(c.substring(4, 6), 16);
    r = Math.min(255, Math.round(r + (255 - r) * amount));
    g = Math.min(255, Math.round(g + (255 - g) * amount));
    b = Math.min(255, Math.round(b + (255 - b) * amount));
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  AFRAME.registerComponent('menu-click', {
    init: function () {
      var self = this;
      this.originalColor = null;
      this.originalOpacity = null;

      this.el.addEventListener('click', function () {
        var vrMenu = self.el.sceneEl.components['vr-menu'];
        if (vrMenu) {
          vrMenu.handleMenuClick(self.el.id);
        }
      });

      this.el.addEventListener('mouseenter', function () {
        var mat = self.el.getAttribute('material');
        if (mat) {
          self.originalColor = mat.color;
          self.originalOpacity = mat.opacity;
        }
        var baseColor = self.originalColor || '#333333';
        self.el.setAttribute('material', 'color', lightenColor(baseColor, 0.2));
      });

      this.el.addEventListener('mouseleave', function () {
        if (self.originalColor) {
          self.el.setAttribute('material', 'color', self.originalColor);
        }
        if (self.originalOpacity !== null) {
          self.el.setAttribute('material', 'opacity', self.originalOpacity);
        }
      });
    }
  });
})();
