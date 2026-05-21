/** Lightweight PeerJS sync — host rebroadcasts poses (DodgeVR / BattleVR pattern, simplified). */
(function () {
  const C = window.VRDRIFT;

  let peer = null;
  let connections = new Map();
  let isHost = false;
  let isMultiplayer = false;
  let lobby = 1;
  let mySlot = 0;
  let lastSend = 0;
  const remotes = new Map();

  function peerOpts() {
    return { host: '0.peerjs.com', port: 443, secure: true };
  }

  function broadcast(msg) {
    connections.forEach((conn) => {
      if (conn.open) conn.send(msg);
    });
  }

  function ensureRemote(slot, color) {
    let el = remotes.get(slot);
    if (el) return el;
    const root = document.querySelector('#remotes');
    if (!root) return null;
    el = document.createElement('a-entity');
    el.setAttribute('id', 'remote-' + slot);
    el.setAttribute('position', '0 2 0');
    el.setAttribute('drift-remote', { color: color || '#aaaaaa', playerId: 'player_' + slot });
    root.appendChild(el);
    remotes.set(slot, el);
    return el;
  }

  function handlePose(data) {
    if (data.slot === mySlot) return;
    const el = ensureRemote(data.slot, data.color);
    if (el && el.components['drift-remote']) {
      el.components['drift-remote'].applyState(data);
    }
  }

  function onData(data) {
    if (!data || data.type !== 'pose') return;
    if (isHost) {
      handlePose(data);
      broadcast(data);
    } else {
      handlePose(data);
    }
  }

  function hostIdForLobby(n) {
    return C.PEER_PREFIX + '-host-' + n;
  }

  window.VRDriftNet = {
    isMultiplayer: function () {
      return isMultiplayer;
    },

    startHost: function (lobbyNum, cb) {
      lobby = lobbyNum;
      isHost = true;
      isMultiplayer = true;
      mySlot = 0;
      const hostId = hostIdForLobby(lobby);
      peer = new Peer(hostId, peerOpts());
      peer.on('open', () => cb && cb(null, hostId));
      peer.on('connection', (conn) => {
        connections.set(conn.peer, conn);
        conn.on('data', onData);
        conn.on('close', () => connections.delete(conn.peer));
      });
      peer.on('error', (e) => cb && cb(e));
    },

    joinHost: function (lobbyNum, cb) {
      lobby = lobbyNum;
      isHost = false;
      isMultiplayer = true;
      mySlot = 1 + Math.floor(Math.random() * 6);
      const clientId = C.PEER_PREFIX + '-c-' + lobby + '-' + Date.now();
      peer = new Peer(clientId, peerOpts());
      peer.on('open', () => {
        const conn = peer.connect(hostIdForLobby(lobby));
        connections.set('host', conn);
        conn.on('open', () => cb && cb(null));
        conn.on('data', onData);
        conn.on('error', (e) => cb && cb(e));
      });
      peer.on('error', (e) => cb && cb(e));
    },

    disconnect: function () {
      connections.forEach((c) => {
        try {
          c.close();
        } catch (e) {}
      });
      connections.clear();
      if (peer) peer.destroy();
      peer = null;
      isMultiplayer = false;
      remotes.forEach((el) => el.parentNode && el.parentNode.removeChild(el));
      remotes.clear();
    },

    tickLocal: function (loco) {
      if (!isMultiplayer) return;
      const now = performance.now();
      if (now - lastSend < 1000 / C.SYNC_HZ) return;
      lastSend = now;
      const state = loco.getNetworkState();
      const msg = Object.assign({ type: 'pose', slot: mySlot, color: loco.data.color }, state);
      if (isHost) broadcast(msg);
      else {
        const h = connections.get('host');
        if (h && h.open) h.send(msg);
      }
    }
  };
})();
