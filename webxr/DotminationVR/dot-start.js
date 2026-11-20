// dot-start.js — getting started in DotminationVR, like the original 2D game:
//   • Returning players start straight in a match against the bot (index.html enter-vr).
//   • First-time players get the name + welcome cards over the bot demo; closing the welcome
//     card also starts a match, so nobody is left watching the demo without a way in.
//   • A small "Menu (X)" button sits just under the board. Point + trigger, pinch or poke it,
//     or press X on the left controller (watch tap with hand tracking).
// Uses the dot-ui.js card system; loaded after dot-ui.js / dot-player.js.
(function (global) {
  'use strict';
  if (!global.AFRAME || !AFRAME.components['dot-game'] || !global.DotUI) {
    console.error('[dot-start] dot-game and dot-ui must load first');
    return;
  }
  var C = AFRAME.components['dot-game'].Component.prototype;
  var FONT = global.DotUI.FONT;
  var BTN_W = 0.19, BTN_H = 0.055;

  function menuComp() {
    var m = document.querySelector('[vr-menu]');
    return m && m.components && m.components['vr-menu'];
  }
  function usingHands() {
    return !!(global.HandInput && global.HandInput.isHand && global.HandInput.isHand('leftHand'));
  }

  C._menuBtnShouldShow = function () {
    if (!this._isPresenting || !this._isPresenting()) return false;
    if (global.isMobileSpectator) return false;
    var menu = menuComp();
    if (!menu || menu.menuVisible) return false;
    var cards = this._uiCards || [];
    for (var i = 0; i < cards.length; i++) {
      if (cards[i] !== this._menuBtn && cards[i].group.visible) return false;   // welcome, name, end…
    }
    return true;
  };

  // Just under the board, on your side
  C._menuBtnPos = function () {
    var root = this.boards.shared.view.root;
    var box = new THREE.Box3().setFromObject(root);
    var front = this._uiFrontPos(0);
    var y = isFinite(box.min.y) ? box.min.y - BTN_H / 2 - 0.02 : front.y - 0.55;
    return { x: front.x, y: y, z: front.z };
  };

  C._drawMenuBtn = function (ctx, card) {
    var W = card.cw, H = card.ch, hov = card.hover === 'menu';
    var pink = this._sideColorCss('blue');
    var hands = usingHands();
    var r = H / 2 - 6;
    global.DotUI.roundRect(ctx, 6, 6, W - 12, H - 12, r);
    ctx.fillStyle = hov ? '#466f6f' : 'rgba(28,48,48,0.92)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = hov ? pink : 'rgba(255,255,255,0.35)';
    ctx.stroke();
    var fg = hov ? pink : '#ffffff';
    // ☰ Menu (X), centred as a group
    var lw = 40, g1 = 20, g2 = 18, br = 24;
    ctx.font = '700 50px ' + FONT;
    var tw = ctx.measureText('Menu').width;
    var total = lw + g1 + tw + (hands ? 0 : g2 + 2 * br);
    var ix = (W - total) / 2;
    ctx.fillStyle = fg;
    for (var i = -1; i <= 1; i++) ctx.fillRect(ix, H / 2 + i * 14 - 3, lw, 6);
    ctx.textAlign = 'left';
    ctx.fillText('Menu', ix + lw + g1, H / 2 + 2);
    if (!hands) {
      // (X) badge: the left controller button
      var bx = ix + lw + g1 + tw + g2 + br;
      ctx.beginPath();
      ctx.arc(bx, H / 2, br, 0, Math.PI * 2);
      ctx.fillStyle = fg;
      ctx.fill();
      ctx.fillStyle = hov ? '#466f6f' : '#1b3030';
      ctx.font = '700 32px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillText('X', bx, H / 2 + 2);
    }
    ctx.textAlign = 'center';
    card.buttons.push({ id: 'menu', x: 0, y: 0, w: W, h: H });
  };

  C._onMenuBtn = function () {
    var menu = menuComp();
    this._uiHide(this._menuBtn);
    if (menu && !menu.menuVisible) menu.toggleMenu();
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

  C._menuBtnTick = function (now) {
    if (!this._uiReady) return;
    if (!this._menuBtn) {
      this._menuBtn = this._uiCard('menu-btn', BTN_W, BTN_H, this._drawMenuBtn.bind(this), this._onMenuBtn.bind(this));
    }
    if (now - (this._menuBtnCheckAt || 0) < 250) return;
    this._menuBtnCheckAt = now;
    var show = this._menuBtnShouldShow();
    if (show) {
      var p = this._menuBtnPos();   // follows board moves / seat swaps
      if (this._menuBtn.group.visible) this._menuBtn.group.position.set(p.x, p.y, p.z);
      else this._uiShow(this._menuBtn, p);
    } else if (this._menuBtn.group.visible) this._uiHide(this._menuBtn);
    var hands = usingHands();
    if (hands !== this._menuBtnHands) { this._menuBtnHands = hands; this._menuBtn.dirty = true; }
  };

  var origTick = C._uiTick;
  C._uiTick = function (now) {
    var r = origTick.call(this, now);
    try { this._menuBtnTick(now); } catch (e) { if (!this._menuBtnErr) { this._menuBtnErr = true; console.error('[dot-start]', e); } }
    return r;
  };
})(typeof window !== 'undefined' ? window : globalThis);
