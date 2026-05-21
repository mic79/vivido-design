(function () {
  let menuOpen = false;
  let mode = 'solo';
  let lobby = 1;

  function setStatus(text) {
    const el = document.querySelector('#hud-status');
    if (el) el.setAttribute('text', 'value', text || '');
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
  }

  function openMenu() {
    menuOpen = true;
    const menu = document.querySelector('#game-menu');
    if (menu) menu.setAttribute('visible', true);
  }

  function closeMenu() {
    menuOpen = false;
    const menu = document.querySelector('#game-menu');
    if (menu) menu.setAttribute('visible', false);
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
