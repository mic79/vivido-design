// dot-start.js — getting started in DotminationVR, like the original 2D game:
//   • Returning players start straight in a match against the bot (index.html enter-vr).
//   • First-time players get the name + welcome cards over the bot demo; closing the welcome
//     card also starts a match, so nobody is left watching the demo without a way in.
//   • A "☰ Menu (X)" button under the board (point + trigger, pinch or poke; X on the left
//     controller still works). It stays parallel to the board on your side and doesn't turn
//     with your head. The mode / level is on the station card next to the time (dot-game.js).
// Uses the dot-ui.js card system; loaded after dot-ui.js / dot-player.js.
(function (global) {
  'use strict';
  if (!global.AFRAME || !AFRAME.components['dot-game'] || !global.DotUI) {
    console.error('[dot-start] dot-game and dot-ui must load first');
    return;
  }
  var C = AFRAME.components['dot-game'].Component.prototype;
  var UI = global.DotUI;
  var FONT = UI.FONT;
  var FOOT_W = 0.3, FOOT_H = 0.085;           // 1400 px/m canvas

  function menuComp() {
    var m = document.querySelector('[vr-menu]');
    return m && m.components && m.components['vr-menu'];
  }
  function usingHands() {
    return !!(global.HandInput && global.HandInput.isHand && global.HandInput.isHand('leftHand'));
  }

  C._footShouldShow = function () {
    if (!this._isPresenting || !this._isPresenting()) return false;
    if (global.isMobileSpectator) return false;
    return true;
  };

  // Which side of the board you're on: your seat, else where your head is
  C._footSide = function () {
    var p = this.boards.shared.view.root.getWorldPosition(new THREE.Vector3());
    var side = this._mySeatSide && this._mySeatSide();
    var seat = side && this.seatPose && this.seatPose(side);
    if (seat && isFinite(seat.z) && Math.abs(seat.z - p.z) > 0.05) return seat.z >= p.z ? 1 : -1;
    var cam = this.el.sceneEl && this.el.sceneEl.camera;
    var v = new THREE.Vector3(p.x, p.y, p.z + 1);
    if (cam) cam.getWorldPosition(v);
    return v.z >= p.z ? 1 : -1;
  };

  // Just under the board, on your side
  C._footPos = function (side) {
    var root = this.boards.shared.view.root;
    var p = root.getWorldPosition(new THREE.Vector3());
    var box = new THREE.Box3().setFromObject(root);
    var y = isFinite(box.min.y) ? box.min.y - FOOT_H / 2 - 0.015 : p.y - 0.55;
    return { x: p.x, y: y, z: p.z + side * 0.13 };
  };

  // Rounded pill with generous padding; returns its width
  function pill(ctx, card, id, W, H, parts, pink) {
    var hov = card.hover === id;
    var padX = 46, gap = 22, iconS = 46, h = 88, r = h / 2;
    ctx.font = '700 46px ' + FONT;
    var w = padX * 2;
    parts.forEach(function (pt, i) {
      w += (pt.icon ? iconS : pt.badge ? 52 : ctx.measureText(pt.text).width) + (i ? gap : 0);
    });
    var x0 = (W - w) / 2, y0 = (H - h) / 2;
    UI.roundRect(ctx, x0, y0, w, h, r);
    ctx.fillStyle = hov ? '#466f6f' : 'rgba(28,48,48,0.94)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = hov ? pink : 'rgba(255,255,255,0.28)';
    ctx.stroke();
    var fg = hov ? pink : '#ffffff', cx = x0 + padX, cy = H / 2;
    parts.forEach(function (pt, i) {
      if (i) cx += gap;
      if (pt.icon) {
        UI.icon(ctx, pt.icon, cx + iconS / 2, cy, iconS, fg);
        cx += iconS;
      } else if (pt.badge) {
        ctx.beginPath();
        ctx.arc(cx + 26, cy, 26, 0, Math.PI * 2);
        ctx.fillStyle = fg;
        ctx.fill();
        ctx.fillStyle = hov ? '#466f6f' : '#1b3030';
        ctx.font = '700 32px ' + FONT;
        ctx.textAlign = 'center';
        ctx.fillText(pt.badge, cx + 26, cy + 2);
        ctx.font = '700 46px ' + FONT;
        cx += 52;
      } else {
        ctx.fillStyle = fg;
        ctx.textAlign = 'left';
        ctx.fillText(pt.text, cx, cy + 2);
        cx += ctx.measureText(pt.text).width;
      }
    });
    ctx.textAlign = 'center';
    card.buttons.push({ id: id, x: x0, y: y0, w: w, h: h });
    return w;
  }

  C._drawFoot = function (ctx, card) {
    var W = card.cw, H = card.ch, pink = this._sideColorCss('blue');
    var menuParts = [{ icon: 'menu' }, { text: 'Menu' }];
    if (!usingHands()) menuParts.push({ badge: 'X' });
    pill(ctx, card, 'menu', W, H, menuParts, pink);
  };

  C._onFoot = function () {
    var menu = menuComp();
    if (menu && !menu.menuVisible) menu.toggleMenu();
  };

  // Restart (2D: Time panel → Restart): same level, or the same Random map, from the start
  C.canRestartMatch = function () {
    if (global.isMultiplayer || global.isMobileSpectator) return false;
    if (!this.matchActive || this._dualBotPreview || this._tutorial) return false;
    if (global.FlatCompat && global.FlatCompat.connected) return false;   // cross-play opponent
    return true;
  };
  C.restartMatch = function () {
    if (!this.canRestartMatch()) return false;
    var seed = this.bagSeed, lvl = this._levelMatch | 0;
    this.onMatchEnded({ cancelled: true, voluntary: true });
    if (this._endCard) this._uiHide(this._endCard);
    if (lvl > 0 && this.level !== lvl) this.setLevel(lvl);
    global.isLobbyBotMatch = true;
    this.onMatchStarted({ blue: 'local', red: '__BOT__' }, Date.now(), true, seed);
    return true;
  };

  // Closing the welcome card (✕) leaves you in a match, as in the 2D game
  var origOnWelcome = C._onWelcome;
  C._onWelcome = function (id) {
    var r = origOnWelcome.call(this, id);
    if (id === 'close' && this._dualBotPreview && !global.isMultiplayer && !global.isMobileSpectator) {
      this.startOfflineBotMatch();
    }
    return r;
  };

  C._footTick = function (now) {
    if (!this._uiReady) return;
    var f = this._foot;
    if (!f) {
      f = this._foot = this._uiCard('footer', FOOT_W, FOOT_H, this._drawFoot.bind(this), this._onFoot.bind(this));
    }
    if (now - (this._footCheckAt || 0) < 250) return;
    this._footCheckAt = now;
    if (!this._footShouldShow()) { if (f.group.visible) this._uiHide(f); return; }
    var side = this._footSide();
    var p = this._footPos(side);
    f.fixedYaw = side > 0 ? 0 : Math.PI;
    if (f.group.visible) f.group.position.set(p.x, p.y, p.z);
    else this._uiShow(f, p);
    var hands = usingHands();
    if (hands !== f.hands) { f.hands = hands; f.dirty = true; }
  };

  var origTick = C._uiTick;
  C._uiTick = function (now) {
    var r = origTick.call(this, now);
    try { this._footTick(now); } catch (e) { if (!this._footErr) { this._footErr = true; console.error('[dot-start]', e); } }
    return r;
  };
})(typeof window !== 'undefined' ? window : globalThis);
