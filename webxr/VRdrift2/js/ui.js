(function () {
  const C = window.VRDRIFT || {};
  const RIG_STORAGE_KEY = 'vrdrift.rigYOffset';
  let menuOpen = false;
  let mode = 'solo';
  let lobby = 1;

  function loadStoredRigY() {
    try {
      const raw = localStorage.getItem(RIG_STORAGE_KEY);
      if (raw != null) {
        const v = parseFloat(raw);
        if (!isNaN(v)) return v;
      }
    } catch (e) {
      /* private mode / blocked storage */
    }
    return C.RIG_Y_OFFSET != null ? C.RIG_Y_OFFSET : 0;
  }

  let rigY = loadStoredRigY();
  if (window.VRDRIFT) window.VRDRIFT.RIG_Y_OFFSET = rigY;

  function setStatus(text) {
    const el = document.querySelector('#hud-status');
    if (el) el.setAttribute('text', 'value', text || '');
  }

  /** BattleVR: white lasers on both hands while menu is open (trigger = click). */
  function setMenuLasers(enabled) {
    ['leftHand', 'rightHand'].forEach((id) => {
      const hand = document.querySelector('#' + id);
      if (!hand) return;
      hand.setAttribute('visible', enabled);
      hand.setAttribute('forward-raycaster', {
        hand: id === 'leftHand' ? 'left' : 'right',
        lineColor: '#ffffff',
        maxLength: 10,
        enabled: !!enabled,
        objects: '.clickable'
      });
      if (enabled) {
        const rc = hand.components['forward-raycaster'];
        if (rc && rc.refreshObjects) rc.refreshObjects();
      }
    });
  }

  function wireMenu() {
    const menu = document.querySelector('#game-menu');
    if (!menu) return;

    document.querySelector('#menu-solo')?.addEventListener('click', () => {
      mode = 'solo';
      window.VRDriftNet.disconnect();
      setStatus('Solo');
      closeMenu();
    });

    document.querySelector('#menu-host')?.addEventListener('click', () => {
      mode = 'host';
      setStatus('Hosting lobby ' + lobby + '…');
      window.VRDriftNet.startHost(lobby, (err, id) => {
        setStatus(err ? 'Host error' : 'Host: ' + lobby);
        if (!err) closeMenu();
      });
    });

    document.querySelector('#menu-join')?.addEventListener('click', () => {
      mode = 'join';
      setStatus('Joining lobby ' + lobby + '…');
      window.VRDriftNet.joinHost(lobby, (err) => {
        setStatus(err ? 'Join failed' : 'Joined ' + lobby);
        if (!err) closeMenu();
      });
    });

    document.querySelector('#menu-lobby-minus')?.addEventListener('click', () => {
      lobby = Math.max(1, lobby - 1);
      document.querySelector('#menu-lobby-num')?.setAttribute('text', 'value', String(lobby));
    });
    document.querySelector('#menu-lobby-plus')?.addEventListener('click', () => {
      lobby = Math.min(window.VRDRIFT.MAX_LOBBIES, lobby + 1);
      document.querySelector('#menu-lobby-num')?.setAttribute('text', 'value', String(lobby));
    });

    function formatRigHeight(y) {
      const sign = y > 0 ? '+' : '';
      return sign + y.toFixed(1) + ' m';
    }

    function updateRigHeightDisplay() {
      const el = document.querySelector('#menu-rig-num');
      if (el) el.setAttribute('text', 'value', formatRigHeight(rigY));
    }

    function applyRigHeight() {
      const step = C.RIG_HEIGHT_STEP != null ? C.RIG_HEIGHT_STEP : 0.1;
      const minY = C.RIG_Y_MIN != null ? C.RIG_Y_MIN : -2;
      const maxY = C.RIG_Y_MAX != null ? C.RIG_Y_MAX : 1;
      rigY = Math.round(rigY / step) * step;
      rigY = Math.max(minY, Math.min(maxY, rigY));
      window.VRDRIFT.RIG_Y_OFFSET = rigY;
      try {
        localStorage.setItem(RIG_STORAGE_KEY, String(rigY));
      } catch (e) {
        /* ignore */
      }
      const player = document.querySelector('#player');
      const loco = player && player.components['drift-locomotion'];
      if (loco && loco.applyRigOffset) loco.applyRigOffset();
      updateRigHeightDisplay();
    }

    document.querySelector('#menu-rig-minus')?.addEventListener('click', () => {
      const step = C.RIG_HEIGHT_STEP != null ? C.RIG_HEIGHT_STEP : 0.1;
      rigY -= step;
      applyRigHeight();
    });
    document.querySelector('#menu-rig-plus')?.addEventListener('click', () => {
      const step = C.RIG_HEIGHT_STEP != null ? C.RIG_HEIGHT_STEP : 0.1;
      rigY += step;
      applyRigHeight();
    });
    updateRigHeightDisplay();
    applyRigHeight();
  }

  function openMenu() {
    menuOpen = true;
    const menu = document.querySelector('#game-menu');
    if (menu) menu.setAttribute('visible', true);
    setMenuLasers(true);
    setStatus('Menu open · Point and pull trigger to select · X to close');
  }

  function closeMenu() {
    menuOpen = false;
    const menu = document.querySelector('#game-menu');
    if (menu) menu.setAttribute('visible', false);
    setMenuLasers(false);
    setStatus('Push surfaces to move · Palm drift · Grip rails · Right stick turn · B/Y boost');
  }

  AFRAME.registerComponent('drift-ui', {
    init: function () {
      this.el.sceneEl.addEventListener('loaded', () => {
        wireMenu();
        setStatus('Push surfaces to move · Palm drift · Grip rails · Right stick turn · B/Y boost');
      });
      this.el.sceneEl.addEventListener('xbuttondown', () => {
        if (menuOpen) closeMenu();
        else openMenu();
      });
    }
  });

  window.VRDriftUI = {
    isMenuOpen: function () {
      return menuOpen;
    },
    openMenu: openMenu,
    closeMenu: closeMenu
  };
})();
