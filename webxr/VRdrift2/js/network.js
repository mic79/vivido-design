/**
 * PeerJS multiplayer — host-authoritative arena ball + player pose sync.
 */
(function () {
  'use strict';

  const C = () => window.VRDRIFT || {};

  let peer = null;
  let connections = new Map();
  let isHost = false;
  let isMultiplayer = false;
  let lobby = 1;
  let mySlot = 0;
  let lastSend = 0;
  let latestBall = null;
  let ballSeq = 0;
  const remotes = new Map();

  function peerOpts() {
    return { host: '0.peerjs.com', port: 443, secure: true };
  }

  function hostIdForLobby(n) {
    return (C().PEER_PREFIX || 'vrdrift2') + '-host-' + n;
  }

  function broadcast(msg) {
    connections.forEach((conn) => {
      if (conn.open) conn.send(msg);
    });
  }

  function sendToHost(msg) {
    const h = connections.get('host');
    if (h && h.open) h.send(msg);
  }

  function ensureRemote(slot, color) {
    let el = remotes.get(slot);
    if (el) return el;
    const root = document.querySelector('#remotes');
    if (!root) return null;
    el = document.createElement('a-entity');
    el.setAttribute('id', 'remote-' + slot);
    el.setAttribute('position', '0 1 0');
    el.setAttribute('drift-remote', {
      color: color || '#aaaaaa',
      playerId: 'player_' + slot
    });
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

  function applyBallLocal(data) {
    if (!data) return;
    latestBall = data;
    ballSeq = data.seq || ballSeq;
    const phys = window.DriftPhys;
    if (phys && phys.gameBallBody) phys.setGameBallState(data);
  }

  function handleBallImpulse(data) {
    if (!isHost || !data) return;
    const phys = window.DriftPhys;
    if (!phys) return;
    phys.applyGameBallImpulse(data.ix || 0, data.iy || 0, data.iz || 0);
  }

  function onData(data) {
    if (!data || !data.type) return;
    if (data.type === 'pose') {
      if (isHost) {
        handlePose(data);
        broadcast(data);
      } else {
        handlePose(data);
      }
      return;
    }
    if (data.type === 'ball') {
      // Only clients apply host ball (host already owns sim)
      if (!isHost) applyBallLocal(data);
      return;
    }
    if (data.type === 'ball-impulse') {
      if (isHost) {
        handleBallImpulse(data);
      }
    }
  }

  function setStatus(text) {
    const el = document.querySelector('#hud-status');
    if (el) el.setAttribute('text', 'value', text || '');
    const net = document.querySelector('#net-status');
    if (net) net.textContent = text || '';
  }

  window.VRDriftNet = {
    isMultiplayer: function () {
      return isMultiplayer;
    },
    isHost: function () {
      return isHost;
    },
    getLatestBall: function () {
      return latestBall;
    },

    startHost: function (lobbyNum, cb) {
      lobby = lobbyNum;
      isHost = true;
      isMultiplayer = true;
      mySlot = 0;
      latestBall = null;
      const hostId = hostIdForLobby(lobby);
      peer = new Peer(hostId, peerOpts());
      peer.on('open', () => {
        setStatus('Host lobby ' + lobby);
        if (cb) cb(null, hostId);
      });
      peer.on('connection', (conn) => {
        connections.set(conn.peer, conn);
        conn.on('data', onData);
        conn.on('close', () => connections.delete(conn.peer));
        // Push current ball immediately so joiner snaps in
        const phys = window.DriftPhys;
        const state = phys && phys.getGameBallState && phys.getGameBallState();
        if (state && conn.open) {
          conn.send(Object.assign({ type: 'ball', seq: ++ballSeq }, state));
        } else {
          conn.on('open', () => {
            const s = window.DriftPhys && window.DriftPhys.getGameBallState();
            if (s) conn.send(Object.assign({ type: 'ball', seq: ++ballSeq }, s));
          });
        }
      });
      peer.on('error', (e) => {
        setStatus('Host error');
        if (cb) cb(e);
      });
    },

    joinHost: function (lobbyNum, cb) {
      lobby = lobbyNum;
      isHost = false;
      isMultiplayer = true;
      mySlot = 1 + Math.floor(Math.random() * 6);
      latestBall = null;
      const clientId = (C().PEER_PREFIX || 'vrdrift2') + '-c-' + lobby + '-' + Date.now();
      peer = new Peer(clientId, peerOpts());
      peer.on('open', () => {
        const conn = peer.connect(hostIdForLobby(lobby));
        connections.set('host', conn);
        conn.on('open', () => {
          setStatus('Joined lobby ' + lobby);
          if (cb) cb(null);
        });
        conn.on('data', onData);
        conn.on('error', (e) => {
          setStatus('Join failed');
          if (cb) cb(e);
        });
      });
      peer.on('error', (e) => {
        setStatus('Join error');
        if (cb) cb(e);
      });
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
      isHost = false;
      latestBall = null;
      remotes.forEach((el) => el.parentNode && el.parentNode.removeChild(el));
      remotes.clear();
      setStatus('Solo');
    },

    /** Clients report palm hits; host applies to the shared ball. */
    sendBallImpulse: function (ix, iy, iz) {
      if (!isMultiplayer) return;
      const msg = { type: 'ball-impulse', ix, iy, iz };
      if (isHost) {
        handleBallImpulse(msg);
      } else {
        sendToHost(msg);
      }
    },

    tickLocal: function (loco) {
      if (!isMultiplayer) return;
      const now = performance.now();
      const hz = C().SYNC_HZ || 30;
      if (now - lastSend < 1000 / hz) return;
      lastSend = now;

      if (loco && loco.getNetworkState) {
        const state = loco.getNetworkState();
        const msg = Object.assign(
          { type: 'pose', slot: mySlot, color: (loco.data && loco.data.color) || '#44aaff' },
          state
        );
        if (isHost) broadcast(msg);
        else sendToHost(msg);
      }

      // Host owns ball — always broadcast authoritative state
      if (isHost) {
        const phys = window.DriftPhys;
        const ball = phys && phys.getGameBallState && phys.getGameBallState();
        if (ball) {
          const msg = Object.assign({ type: 'ball', seq: ++ballSeq }, ball);
          latestBall = msg;
          broadcast(msg);
        }
      }
    },

    /** Clients re-apply latest host ball after local physics so it stays locked. */
    applyAuthoritativeBall: function () {
      if (!isMultiplayer || isHost || !latestBall) return;
      const phys = window.DriftPhys;
      if (phys && phys.gameBallBody) phys.setGameBallState(latestBall);
    }
  };
})();
