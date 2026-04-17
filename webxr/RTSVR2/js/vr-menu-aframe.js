/**
 * BoltVR-style VR main menu: laser raycaster hits .clickable planes; trigger emits click.
 * Depends on window._startGame / _hostGame / _joinGame (set from ui.js after init).
 */
(function () {
  AFRAME.registerComponent('rts-vr-menu-btn', {
    schema: { action: { type: 'string', default: '' } },
    init: function () {
      this.onClick = this.onClick.bind(this);
      this.el.addEventListener('click', this.onClick);
    },
    onClick: function () {
      const action = this.data.action;
      if (action === 'app_start') {
        if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
        return;
      }
      /** Hit tests + raycaster whitelist already gate VR hits; checking `.clickable` here broke lobby when sync lagged behind visible menu. */

      if (action === '1v1' && window._startGame) window._startGame('1v1');
      else if (action === '2v2' && window._startGame) window._startGame('2v2');
      else if (action === 'ffa' && window._startGame) window._startGame('ffa');
      else if (action === 'host' && window._hostGame) window._hostGame();
      else if (action === 'join' && window._joinGame) window._joinGame();
      else if (action === 'lobby_minus' && window._lobbyDelta) window._lobbyDelta(-1);
      else if (action === 'lobby_plus' && window._lobbyDelta) window._lobbyDelta(1);
    },
    remove: function () {
      this.el.removeEventListener('click', this.onClick);
    },
  });
})();
