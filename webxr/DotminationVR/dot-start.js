// dot-start.js — "how do I start?" for DotminationVR.
//   While the bot-vs-bot demo plays and nothing else is open, a start card floats above the
//   board (Play vs Bot · Multiplayer · Menu) and says how to open the menu anytime. A small
//   "X  Menu" tag floats by the left controller (or a wrist hint with hand tracking).
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
  var TEXT2 = '#b4c8c8';
  var CARD_W = 0.56, CARD_H = 0.3;

  function menuComp() {
    var m = document.querySelector('[vr-menu]');
    return m && m.components && m.components['vr-menu'];
  }
  function usingHands() {
    return !!(global.HandInput && global.HandInput.isHand && global.HandInput.isHand('leftHand'));
  }

  C._startShouldShow = function () {
    if (!this._isPresenting || !this._isPresenting()) return false;
    if (!this._dualBotPreview || !this.matchActive) return false;
    if (global.isMultiplayer || global.isMobileSpectator || this._tutorial) return false;
    var menu = menuComp();
    if (menu && menu.menuVisible) return false;
    var cards = this._uiCards || [];
    for (var i = 0; i < cards.length; i++) {
      if (cards[i] !== this._startCard && cards[i].group.visible) return false;   // welcome, name, rankings…
    }
    return true;
  };

  // In front of the board, on your side
  C._startPos = function () {
    var root = this.boards.shared.view.root;
    var box = new THREE.Box3().setFromObject(root);
    var front = this._uiFrontPos(0);
    // Over the lower part of the standing board: below eye level, most of the demo stays visible
    var y = isFinite(box.min.y) ? box.min.y + CARD_H / 2 + 0.04 : front.y - 0.25;
    return { x: front.x, y: y, z: front.z + (front.z >= root.getWorldPosition(new THREE.Vector3()).z ? 0.02 : -0.02) };
  };

  C._drawStartCard = function (ctx, card) {
    var W = card.cw, H = card.ch;
    this._uiPanel(ctx, card);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 54px ' + FONT;
    ctx.fillText('Ready to play?', W / 2, 92);
    ctx.font = '400 30px ' + FONT;
    ctx.fillStyle = TEXT2;
    ctx.fillText(usingHands() ? 'Two bots are playing a demo. Point and pinch to choose.'
      : 'Two bots are playing a demo. Point and pull the trigger.', W / 2, 142);
    var bw = 216, bh = 140, gap = 22, y = 178;
    var x0 = W / 2 - (3 * bw + 2 * gap) / 2;
    this._uiTile(ctx, card, { id: 'bot', x: x0, y: y, w: bw, h: bh, label: 'Play vs Bot', icon: 'arrow' });
    this._uiTile(ctx, card, { id: 'multi', x: x0 + bw + gap, y: y, w: bw, h: bh, label: 'Multiplayer', icon: 'shuffle' });
    this._uiTile(ctx, card, { id: 'menu', x: x0 + 2 * (bw + gap), y: y, w: bw, h: bh, label: 'All modes', icon: 'layers' });
    ctx.font = '400 30px ' + FONT;
    ctx.fillStyle = TEXT2;
    ctx.fillText(usingHands()
      ? 'Menu anytime: tap the watch on your left wrist'
      : 'Menu anytime: press X on your left controller', W / 2, H - 52);
  };

  C._onStartCard = function (id) {
    var menu = menuComp();
    this._uiHide(this._startCard);
    this._startHold = performance.now() + 1500;   // don't pop straight back while things change
    if (id === 'bot') {
      if (menu) { menu.menuMode = 'single'; menu.handleAction('start-bot'); }
      else this.startOfflineBotMatch();
    } else if (menu) {
      if (!menu.menuVisible) menu.toggleMenu();
      menu.handleAction(id === 'multi' ? 'mode-multi' : 'mode-single');
    }
  };

  // "X  Menu" tag that floats by the left controller while the start card is up
  function makeTag(sceneRoot) {
    var cw = 256, ch = 96;
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    var g = canvas.getContext('2d');
    UI.roundRect(g, 4, 4, cw - 8, ch - 8, 40);
    g.fillStyle = 'rgba(28,48,48,0.92)';
    g.fill();
    g.beginPath();
    g.arc(52, ch / 2, 30, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.fillStyle = '#1b3030';
    g.font = '700 38px ' + FONT;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('X', 52, ch / 2 + 2);
    g.fillStyle = '#ffffff';
    g.font = '700 44px ' + FONT;
    g.textAlign = 'left';
    g.fillText('Menu', 98, ch / 2 + 2);
    var tex = new THREE.CanvasTexture(canvas);
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.03), new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false
    }));
    mesh.renderOrder = 35;
    mesh.visible = false;
    sceneRoot.add(mesh);
    return mesh;
  }

  var tmpV = null, tmpCam = null;
  C._startTick = function (now) {
    if (!this._uiReady) return;
    if (!this._startCard) {
      this._startCard = this._uiCard('start', CARD_W, CARD_H, this._drawStartCard.bind(this), this._onStartCard.bind(this));
      this._startTag = makeTag(this.el.sceneEl.object3D);
      tmpV = new THREE.Vector3(); tmpCam = new THREE.Vector3();
    }
    if (now - (this._startCheckAt || 0) > 250) {
      this._startCheckAt = now;
      var show = now > (this._startHold || 0) && this._startShouldShow();
      if (show && !this._startCard.group.visible) {
        this._uiShow(this._startCard, this._startPos());
      } else if (!show && this._startCard.group.visible) {
        this._uiHide(this._startCard);
      }
      var hands = usingHands();
      if (hands !== this._startHands) { this._startHands = hands; this._startCard.dirty = true; }
    }
    // Controller tag follows the left controller, facing you
    var tag = this._startTag;
    var left = document.getElementById('leftHand');
    var tagOn = this._startCard.group.visible && !usingHands() && left && left.object3D && left.object3D.visible;
    tag.visible = !!tagOn;
    if (tagOn) {
      left.object3D.getWorldPosition(tmpV);
      var cam = this.el.sceneEl.camera;
      if (cam) cam.getWorldPosition(tmpCam);
      tag.position.set(tmpV.x, tmpV.y + 0.06, tmpV.z);
      tag.lookAt(tmpCam);
    }
  };

  var origTick = C._uiTick;
  C._uiTick = function (now) {
    var r = origTick.call(this, now);
    try { this._startTick(now); } catch (e) { if (!this._startErr) { this._startErr = true; console.error('[dot-start]', e); } }
    return r;
  };
})(typeof window !== 'undefined' ? window : globalThis);
