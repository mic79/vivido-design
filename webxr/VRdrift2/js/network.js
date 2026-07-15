/**
 * PeerJS multiplayer — CapVR-style Mixamo remotes + touch-ownership arena ball.
 * Host assigns slots; whoever is touching the ball owns its state briefly.
 */
(function () {
  'use strict';

  const C = () => window.VRDRIFT || {};
  const MAX_REMOTE_BODIES = 4;

  let peer = null;
  let connections = new Map();
  let isHost = false;
  let isMultiplayer = false;
  let lobby = 1;
  let mySlot = 0;
  let nextClientSlot = 1;
  let lastSend = 0;
  let latestBall = null;
  let ballSeq = 0;
  let ballOwnerSlot = null;
  let ballOwnerUntil = 0;
  const remotes = new Map();
  const remotePoses = new Map();

  function peerOpts() {
    return { host: '0.peerjs.com', port: 443, secure: true };
  }

  function hostIdForLobby(n) {
    return (C().PEER_PREFIX || 'vrdrift2') + '-host-' + n;
  }

  function broadcast(msg, exceptPeer) {
    connections.forEach((conn, peerId) => {
      if (exceptPeer && peerId === exceptPeer) return;
      if (conn.open) conn.send(msg);
    });
  }

  function sendToHost(msg) {
    const h = connections.get('host');
    if (h && h.open) h.send(msg);
  }

  function setStatus(text) {
    const el = document.querySelector('#hud-status');
    if (el) el.setAttribute('text', 'value', text || '');
    const net = document.querySelector('#net-status');
    if (net) net.textContent = text || '';
  }

  function remoteBodyEl(slot) {
    return document.getElementById('remote-body-' + slot);
  }

  function showRemoteBody(slot, color, visible) {
    const body = remoteBodyEl(slot);
    if (!body) return;
    body.setAttribute('visible', !!visible);
    if (color && body.components && body.components['mixamo-body-avatar']) {
      body.setAttribute('mixamo-body-avatar', 'color', color);
    }
  }

  function ensureRemote(slot, color) {
    if (slot === mySlot) return null;
    let el = remotes.get(slot);
    if (!el) {
      const root = document.querySelector('#remotes');
      if (!root) return null;
      el = document.createElement('a-entity');
      el.setAttribute('id', 'remote-' + slot);
      el.setAttribute('position', '0 1 0');
      el.setAttribute('drift-remote', {
        color: color || '#aaaaaa',
        playerId: 'player_' + slot,
        slot: slot
      });
      root.appendChild(el);
      remotes.set(slot, el);
    }
    showRemoteBody(slot, color, true);
    return el;
  }

  function handlePose(data) {
    if (!data || data.slot === mySlot) return;
    remotePoses.set(data.slot, data);
    const el = ensureRemote(data.slot, data.color);
    if (el && el.components['drift-remote']) {
      el.components['drift-remote'].applyState(data);
    }
    if (data.bodyPose) {
      const body = remoteBodyEl(data.slot);
      if (body && body.components && body.components['mixamo-body-avatar']) {
        body.setAttribute('visible', true);
        body.components['mixamo-body-avatar'].updateRemotePoseData(data.bodyPose);
      }
    }
  }

  function softApplyBall(data, k) {
    const phys = window.DriftPhys;
    if (!phys || !phys.gameBallBody || !data) return;
    const p = phys.getGameBallPosition();
    const v = phys.getGameBallVelocity();
    if (!p || !v) return;
    const t = Math.max(0, Math.min(1, k));
    phys.setGameBallPosition(
      p.x + (data.px - p.x) * t,
      p.y + (data.py - p.y) * t,
      p.z + (data.pz - p.z) * t
    );
    phys.setGameBallVelocity(
      v.x + ((data.vx || 0) - v.x) * t,
      v.y + ((data.vy || 0) - v.y) * t,
      v.z + ((data.vz || 0) - v.z) * t
    );
  }

  function hardApplyBall(data) {
    if (!data) return;
    latestBall = data;
    ballSeq = data.seq || ballSeq;
    const phys = window.DriftPhys;
    if (phys && phys.gameBallBody) phys.setGameBallState(data);
  }

  function iOwnBall() {
    return ballOwnerSlot === mySlot && performance.now() < ballOwnerUntil;
  }

  function handleBall(data, fromPeer) {
    if (!data) return;
    const owner = data.ownerSlot;
    if (owner != null) {
      ballOwnerSlot = owner;
      ballOwnerUntil = performance.now() + (C().BALL_NET_OWNER_MS || 450);
    }

    // Never overwrite the local sim while we are the active toucher
    if (owner === mySlot && iOwnBall()) {
      latestBall = data;
      return;
    }

    if (isHost) {
      // Client-owned ball: take their authoritative snap + redistribute
      if (owner != null && owner !== mySlot) {
        hardApplyBall(data);
        broadcast(data, fromPeer);
        return;
      }
      return;
    }

    // Client receiving host (or rebroadcast) ball — soft correct when free
    latestBall = data;
    ballSeq = data.seq || ballSeq;
    if (!iOwnBall()) softApplyBall(data, C().BALL_NET_CORRECT_K != null ? C().BALL_NET_CORRECT_K : 0.35);
  }

  function handleBallImpulse(data) {
    if (!isHost || !data) return;
    const phys = window.DriftPhys;
    if (!phys) return;
    phys.applyGameBallImpulse(data.ix || 0, data.iy || 0, data.iz || 0);
  }

  function onData(data, fromPeer) {
    if (!data || !data.type) return;
    if (data.type === 'welcome') {
      mySlot = data.slot;
      setStatus('Joined as P' + (mySlot + 1));
      return;
    }
    if (data.type === 'pose') {
      if (isHost) {
        handlePose(data);
        broadcast(data, fromPeer);
      } else {
        handlePose(data);
      }
      return;
    }
    if (data.type === 'ball') {
      handleBall(data, fromPeer);
      return;
    }
    if (data.type === 'ball-impulse') {
      if (isHost) handleBallImpulse(data);
    }
  }

  function wireConn(conn, peerKey) {
    connections.set(peerKey, conn);
    conn.on('data', (data) => onData(data, peerKey));
    conn.on('close', () => {
      connections.delete(peerKey);
      if (conn._driftSlot != null) {
        remotePoses.delete(conn._driftSlot);
        const el = remotes.get(conn._driftSlot);
        if (el && el.parentNode) el.parentNode.removeChild(el);
        remotes.delete(conn._driftSlot);
        showRemoteBody(conn._driftSlot, null, false);
      }
    });
  }

  window.VRDriftNet = {
    isMultiplayer: function () {
      return isMultiplayer;
    },
    isHost: function () {
      return isHost;
    },
    getMySlot: function () {
      return mySlot;
    },
    getLatestBall: function () {
      return latestBall;
    },
    getRemotePoses: function () {
      return remotePoses;
    },
    getBallOwnerSlot: function () {
      if (ballOwnerSlot == null) return null;
      if (performance.now() >= ballOwnerUntil) return null;
      return ballOwnerSlot;
    },

    /** Local palms/body touched the arena ball — claim short ownership. */
    noteLocalBallTouch: function () {
      if (!isMultiplayer) return;
      ballOwnerSlot = mySlot;
      ballOwnerUntil = performance.now() + (C().BALL_NET_OWNER_MS || 450);
    },

    startHost: function (lobbyNum, cb) {
      lobby = lobbyNum;
      isHost = true;
      isMultiplayer = true;
      mySlot = 0;
      nextClientSlot = 1;
      latestBall = null;
      ballOwnerSlot = null;
      const hostId = hostIdForLobby(lobby);
      peer = new Peer(hostId, peerOpts());
      peer.on('open', () => {
        setStatus('Host lobby ' + lobby);
        if (cb) cb(null, hostId);
      });
      peer.on('connection', (conn) => {
        const setup = () => {
          if (conn._driftReady) return;
          if (nextClientSlot >= MAX_REMOTE_BODIES) {
            try {
              conn.send({ type: 'lobby-full' });
            } catch (e) {}
            conn.close();
            return;
          }
          conn._driftReady = true;
          const slot = nextClientSlot++;
          conn._driftSlot = slot;
          wireConn(conn, conn.peer);
          conn.send({ type: 'welcome', slot: slot });
          const phys = window.DriftPhys;
          const state = phys && phys.getGameBallState && phys.getGameBallState();
          if (state) {
            conn.send(
              Object.assign({ type: 'ball', seq: ++ballSeq, ownerSlot: ballOwnerSlot }, state)
            );
          }
        };
        if (conn.open) setup();
        else conn.on('open', setup);
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
      mySlot = -1;
      latestBall = null;
      ballOwnerSlot = null;
      const clientId = (C().PEER_PREFIX || 'vrdrift2') + '-c-' + lobby + '-' + Date.now();
      peer = new Peer(clientId, peerOpts());
      peer.on('open', () => {
        const conn = peer.connect(hostIdForLobby(lobby));
        wireConn(conn, 'host');
        conn.on('open', () => {
          setStatus('Joined lobby ' + lobby);
          if (cb) cb(null);
        });
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
      ballOwnerSlot = null;
      remotes.forEach((el) => el.parentNode && el.parentNode.removeChild(el));
      remotes.clear();
      remotePoses.clear();
      for (let i = 0; i < MAX_REMOTE_BODIES; i++) showRemoteBody(i, null, false);
      setStatus('Solo');
    },

    sendBallImpulse: function (ix, iy, iz) {
      if (!isMultiplayer) return;
      const msg = { type: 'ball-impulse', ix, iy, iz };
      if (isHost) handleBallImpulse(msg);
      else sendToHost(msg);
    },

    tickLocal: function (loco) {
      if (!isMultiplayer) return;
      const now = performance.now();
      const hz = C().SYNC_HZ || 30;
      if (now - lastSend < 1000 / hz) return;
      lastSend = now;

      if (loco && loco.getNetworkState && mySlot >= 0) {
        const state = loco.getNetworkState();
        const msg = Object.assign(
          { type: 'pose', slot: mySlot, color: (loco.data && loco.data.color) || '#44aaff' },
          state
        );
        if (isHost) broadcast(msg);
        else sendToHost(msg);
      }

      const phys = window.DriftPhys;
      const ball = phys && phys.getGameBallState && phys.getGameBallState();
      if (!ball) return;

      // Active toucher sends authoritative ball (CapVR ownership pattern)
      if (iOwnBall()) {
        const msg = Object.assign(
          { type: 'ball', seq: ++ballSeq, ownerSlot: mySlot },
          ball
        );
        latestBall = msg;
        if (isHost) broadcast(msg);
        else sendToHost(msg);
        return;
      }

      // Host owns free ball
      if (isHost) {
        const msg = Object.assign(
          { type: 'ball', seq: ++ballSeq, ownerSlot: null },
          ball
        );
        latestBall = msg;
        broadcast(msg);
      }
    },

    /**
     * Soft re-apply host ball for clients when not the active owner.
     * Hard snaps caused stutter while rolling into the ball.
     */
    applyAuthoritativeBall: function () {
      if (!isMultiplayer || isHost || !latestBall) return;
      if (iOwnBall()) return;
      softApplyBall(
        latestBall,
        C().BALL_NET_CORRECT_K != null ? C().BALL_NET_CORRECT_K : 0.22
      );
    }
  };
})();
