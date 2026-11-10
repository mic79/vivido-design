// lobby.js — PeerJS lobby / queue / bot-slot / spectator shell for StacksVR (from DodgeVR model)
(function (global) {
  'use strict';

  var Lobby = {
    peer: null,
    conn: null,
    connections: [], // host: [{ id, conn, isMobileSpectator }]
    isHost: false,
    isMultiplayer: false,
    isSpectator: false,
    isMobileSpectator: false,
    isLobbyBotMatch: false,
    myPlayerId: null,
    lobbyState: null,
    connectionState: 'idle',
    lobbyNum: 1,
    onLobbyState: null,
    onMatchStarted: null,
    onMatchEnded: null,
    onCupEvent: null,
    onCupSnapshot: null,
    onPlayerPose: null,
    onDisconnected: null
  };

  function createLobbyState() {
    return {
      players: [],
      queue: [],
      matchPlayers: { blue: null, red: null },
      matchState: 'WAITING',
      matchStartTime: 0,
      matchScore: { blue: 0, red: 0 },
      matchGameState: null,
      spectatorSlots: [null, null, null, null],
      mobileSpectatorCount: 0
    };
  }

  function broadcastLobbyState() {
    if (!Lobby.isHost || !Lobby.lobbyState) return;
    global.lobbyState = Lobby.lobbyState;
    for (var i = 0; i < Lobby.connections.length; i++) {
      var c = Lobby.connections[i];
      if (c.conn && c.conn.open) {
        c.conn.send({ type: 'lobby-state', state: Lobby.lobbyState });
      }
    }
    if (Lobby.onLobbyState) Lobby.onLobbyState(Lobby.lobbyState);
    var scene = document.querySelector('a-scene');
    if (scene) scene.emit('lobby-state-updated');
  }

  function assignSpectatorSlot(playerId) {
    if (!Lobby.lobbyState) return;
    for (var s = 0; s < Lobby.lobbyState.spectatorSlots.length; s++) {
      if (Lobby.lobbyState.spectatorSlots[s] === playerId) return;
    }
    for (var i = 0; i < Lobby.lobbyState.spectatorSlots.length; i++) {
      if (!Lobby.lobbyState.spectatorSlots[i]) {
        Lobby.lobbyState.spectatorSlots[i] = playerId;
        return;
      }
    }
  }

  function tryAssignMatchPlayers() {
    if (!Lobby.lobbyState) return;
    if (Lobby.lobbyState.matchState === 'PLAYING') return;
    if (Lobby.lobbyState.queue.length === 0) return;

    while (Lobby.lobbyState.queue.length > 0 &&
      (!Lobby.lobbyState.matchPlayers.blue || !Lobby.lobbyState.matchPlayers.red)) {
      var nextId = Lobby.lobbyState.queue.shift();
      if (!Lobby.lobbyState.matchPlayers.blue) {
        Lobby.lobbyState.matchPlayers.blue = nextId;
      } else {
        Lobby.lobbyState.matchPlayers.red = nextId;
      }
      for (var s = 0; s < Lobby.lobbyState.spectatorSlots.length; s++) {
        if (Lobby.lobbyState.spectatorSlots[s] === nextId) {
          Lobby.lobbyState.spectatorSlots[s] = null;
        }
      }
    }
  }

  function handleQueueAction(playerId, action) {
    if (!Lobby.lobbyState) return;
    if (action === 'join') {
      if (Lobby.lobbyState.queue.indexOf(playerId) < 0) {
        Lobby.lobbyState.queue.push(playerId);
      }
      tryAssignMatchPlayers();
    } else if (action === 'leave') {
      Lobby.lobbyState.queue = Lobby.lobbyState.queue.filter(function (id) { return id !== playerId; });
      if (Lobby.lobbyState.matchState !== 'PLAYING') {
        if (Lobby.lobbyState.matchPlayers.blue === playerId) {
          Lobby.lobbyState.matchPlayers.blue = null;
          assignSpectatorSlot(playerId);
        } else if (Lobby.lobbyState.matchPlayers.red === playerId) {
          Lobby.lobbyState.matchPlayers.red = null;
          assignSpectatorSlot(playerId);
        }
        tryAssignMatchPlayers();
      }
    }
    broadcastLobbyState();
  }

  function startLobbyMatch() {
    if (!Lobby.lobbyState) return;
    var mp = Lobby.lobbyState.matchPlayers;
    if (!mp.blue) return;

    var isBotMatch = mp.blue && !mp.red;
    Lobby.isLobbyBotMatch = isBotMatch;
    global.isLobbyBotMatch = isBotMatch;
    if (isBotMatch) {
      mp.red = '__BOT__';
    }

    Lobby.lobbyState.matchState = 'PLAYING';
    Lobby.lobbyState.matchScore = { blue: 0, red: 0 };
    Lobby.lobbyState.matchGameState = 'PLAYING';
    var startTime = Date.now();
    Lobby.lobbyState.matchStartTime = startTime;

    for (var i = 0; i < Lobby.connections.length; i++) {
      if (Lobby.connections[i].conn.open) {
        Lobby.connections[i].conn.send({
          type: 'match-started',
          matchPlayers: mp,
          startTime: startTime,
          isBotMatch: isBotMatch
        });
      }
    }
    broadcastLobbyState();
    if (Lobby.onMatchStarted) Lobby.onMatchStarted(mp, startTime, isBotMatch);
  }

  function endLobbyMatch() {
    if (!Lobby.lobbyState) return;
    Lobby.isLobbyBotMatch = false;
    global.isLobbyBotMatch = false;
    var oldBlue = Lobby.lobbyState.matchPlayers.blue;
    var oldRed = Lobby.lobbyState.matchPlayers.red;

    Lobby.lobbyState.matchState = 'WAITING';
    Lobby.lobbyState.matchGameState = null;

    // Clear bot placeholder so next human can take red
    if (oldRed === '__BOT__') Lobby.lobbyState.matchPlayers.red = null;

    // After match, seated players go back to spectator unless still in queue
    function park(id) {
      if (!id || id === '__BOT__') return;
      if (Lobby.lobbyState.queue.indexOf(id) < 0) assignSpectatorSlot(id);
    }
    park(oldBlue);
    if (oldRed && oldRed !== '__BOT__') park(oldRed);

    // Re-seat from queue
    Lobby.lobbyState.matchPlayers.blue = null;
    if (Lobby.lobbyState.matchPlayers.red !== '__BOT__') Lobby.lobbyState.matchPlayers.red = null;
    tryAssignMatchPlayers();

    for (var i = 0; i < Lobby.connections.length; i++) {
      if (Lobby.connections[i].conn.open) {
        Lobby.connections[i].conn.send({ type: 'match-ended' });
      }
    }
    broadcastLobbyState();
    if (Lobby.onMatchEnded) Lobby.onMatchEnded();
  }

  function handleMatchAction(playerId, action) {
    if (!Lobby.lobbyState) return;
    var mp = Lobby.lobbyState.matchPlayers;
    if (playerId !== mp.blue && playerId !== mp.red) return;
    if (action === 'start' && Lobby.lobbyState.matchState !== 'PLAYING') {
      startLobbyMatch();
    } else if (action === 'end' && Lobby.lobbyState.matchState === 'PLAYING') {
      endLobbyMatch();
    }
  }

  function removePlayer(peerId) {
    if (!Lobby.lobbyState) return;
    Lobby.lobbyState.players = Lobby.lobbyState.players.filter(function (p) { return p.id !== peerId; });
    Lobby.lobbyState.queue = Lobby.lobbyState.queue.filter(function (id) { return id !== peerId; });
    for (var s = 0; s < Lobby.lobbyState.spectatorSlots.length; s++) {
      if (Lobby.lobbyState.spectatorSlots[s] === peerId) Lobby.lobbyState.spectatorSlots[s] = null;
    }
    var wasPlaying = Lobby.lobbyState.matchState === 'PLAYING' &&
      (Lobby.lobbyState.matchPlayers.blue === peerId || Lobby.lobbyState.matchPlayers.red === peerId);
    if (Lobby.lobbyState.matchPlayers.blue === peerId) Lobby.lobbyState.matchPlayers.blue = null;
    if (Lobby.lobbyState.matchPlayers.red === peerId) Lobby.lobbyState.matchPlayers.red = null;
    if (wasPlaying) endLobbyMatch();
    else {
      tryAssignMatchPlayers();
      broadcastLobbyState();
    }
  }

  function handleData(fromId, data, isMobile) {
    if (!data || !data.type) return;

    if (Lobby.isHost) {
      if (data.type === 'queue-action') handleQueueAction(fromId, data.action);
      else if (data.type === 'match-action') handleMatchAction(fromId, data.action);
      else if (data.type === 'cup-event') {
        if (!data.from) data.from = fromId;
        // Rebroadcast to other peers, then apply locally on host
        for (var i = 0; i < Lobby.connections.length; i++) {
          var c = Lobby.connections[i];
          if (c.id !== fromId && c.conn.open) c.conn.send(data);
        }
        if (Lobby.onCupEvent) Lobby.onCupEvent(data);
      } else if (data.type === 'cup-snapshot') {
        for (var si = 0; si < Lobby.connections.length; si++) {
          var cs = Lobby.connections[si];
          if (cs.id !== fromId && cs.conn.open) cs.conn.send(data);
        }
        if (Lobby.onCupSnapshot) Lobby.onCupSnapshot(data);
      } else if (data.type === 'player-pose') {
        for (var j = 0; j < Lobby.connections.length; j++) {
          var cj = Lobby.connections[j];
          if (cj.id !== fromId && cj.conn.open) cj.conn.send(Object.assign({ from: fromId }, data));
        }
        if (Lobby.onPlayerPose) Lobby.onPlayerPose(fromId, data);
      } else if (data.type === 'hello') {
        var exists = Lobby.lobbyState.players.some(function (p) { return p.id === fromId; });
        if (!exists) {
          Lobby.lobbyState.players.push({ id: fromId, nickname: data.nickname || 'Player', mobile: !!isMobile });
        }
        if (isMobile) Lobby.lobbyState.mobileSpectatorCount++;
        else assignSpectatorSlot(fromId);
        broadcastLobbyState();
        // Late join during a match — push current board
        if (Lobby.lobbyState.matchState === 'PLAYING' && Lobby.onRequestSnapshot) {
          var snap = Lobby.onRequestSnapshot();
          if (snap) {
            var entry = Lobby.connections.find(function (x) { return x.id === fromId; });
            if (entry && entry.conn && entry.conn.open) {
              entry.conn.send({ type: 'cup-snapshot', snapshot: snap });
            }
          }
        }
      }
      return;
    }

    // Peer / mobile spectator
    if (data.type === 'lobby-state') {
      Lobby.lobbyState = data.state;
      global.lobbyState = data.state;
      var mp = data.state.matchPlayers;
      Lobby.isSpectator = !(mp && (mp.blue === Lobby.myPlayerId || mp.red === Lobby.myPlayerId));
      global.isSpectator = Lobby.isSpectator;
      if (Lobby.onLobbyState) Lobby.onLobbyState(data.state);
      var scene = document.querySelector('a-scene');
      if (scene) scene.emit('lobby-state-updated');
    } else if (data.type === 'match-started') {
      Lobby.isLobbyBotMatch = !!data.isBotMatch;
      global.isLobbyBotMatch = Lobby.isLobbyBotMatch;
      if (Lobby.onMatchStarted) Lobby.onMatchStarted(data.matchPlayers, data.startTime, data.isBotMatch);
    } else if (data.type === 'match-ended') {
      if (Lobby.onMatchEnded) Lobby.onMatchEnded();
    } else if (data.type === 'cup-event' || data.type === 'cup-snapshot') {
      if (Lobby.onCupEvent) Lobby.onCupEvent(data);
      if (data.type === 'cup-snapshot' && Lobby.onCupSnapshot) Lobby.onCupSnapshot(data);
    } else if (data.type === 'player-pose') {
      if (Lobby.onPlayerPose) Lobby.onPlayerPose(data.from || fromId, data);
    }
  }

  async function getIceServers() {
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
  }

  // Returns true if the PeerJS id is free (no host). False if taken (host online).
  // Uses ID-claim (unavailable-id) — NOT a DataConnection probe (those false-timeout
  // on Quest/mobile NAT and were reporting "No lobby found" while VR was hosting).
  function checkPeerAvailability(id) {
    return new Promise(function (resolve) {
      var tempPeer = null;
      var done = false;
      function finish(available) {
        if (done) return;
        done = true;
        try { if (tempPeer) tempPeer.destroy(); } catch (e) {}
        resolve(available);
      }
      try {
        tempPeer = new Peer(id, { host: '0.peerjs.com', port: 443, secure: true });
      } catch (e) {
        finish(true);
        return;
      }
      var timeout = setTimeout(function () {
        // Ambiguous — treat as free so VR can still host; mobile will try connect anyway
        finish(true);
      }, 4000);
      tempPeer.on('open', function () {
        clearTimeout(timeout);
        // Successfully registered as this id ⇒ nobody was hosting
        finish(true);
      });
      tempPeer.on('error', function (err) {
        clearTimeout(timeout);
        if (err && err.type === 'unavailable-id') {
          finish(false); // id taken ⇒ host exists
        } else {
          finish(true);
        }
      });
    });
  }

  async function setupHost(lobbyNum) {
    Lobby.lobbyNum = lobbyNum;
    Lobby.lobbyState = createLobbyState();
    Lobby.myPlayerId = 'stacksvr-host-' + lobbyNum;
    Lobby.lobbyState.players.push({ id: Lobby.myPlayerId, nickname: 'Host', mobile: false });
    Lobby.isHost = true;
    Lobby.isMultiplayer = true;
    global.isMultiplayer = true;
    global.isHost = true;
    global.lobbyState = Lobby.lobbyState;
    global.myPlayerId = Lobby.myPlayerId;

    var ice = await getIceServers();
    Lobby.peer = new Peer(Lobby.myPlayerId, {
      host: '0.peerjs.com', port: 443, secure: true,
      config: { iceServers: ice }
    });

    Lobby.peer.on('open', function () {
      Lobby.connectionState = 'connected';
      broadcastLobbyState();
    });

    Lobby.peer.on('connection', function (newConn) {
      var peerId = newConn.peer;
      var entry = { id: peerId, conn: newConn, isMobileSpectator: peerId.indexOf('stacksvr-mspec-') === 0 };
      Lobby.connections.push(entry);
      newConn.on('open', function () {
        newConn.send({ type: 'lobby-state', state: Lobby.lobbyState });
      });
      newConn.on('data', function (data) {
        if (data && data.type === 'mobile-spectator') entry.isMobileSpectator = true;
        if (data && data.type === 'hello') handleData(peerId, data, entry.isMobileSpectator);
        else handleData(peerId, data, entry.isMobileSpectator);
      });
      newConn.on('close', function () {
        Lobby.connections = Lobby.connections.filter(function (c) { return c.id !== peerId; });
        removePlayer(peerId);
      });
    });

    Lobby.peer.on('error', function (err) {
      console.warn('[StacksLobby] host error', err);
    });
  }

  async function setupPeer(lobbyNum, asMobile) {
    Lobby.lobbyNum = lobbyNum;
    Lobby.isHost = false;
    var peerIdNum = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    Lobby.myPlayerId = asMobile ? ('stacksvr-mspec-' + peerIdNum) : ('stacksvr-peer-' + peerIdNum);
    global.myPlayerId = Lobby.myPlayerId;
    Lobby.isMobileSpectator = !!asMobile;
    global.isMobileSpectator = Lobby.isMobileSpectator;

    var ice = await getIceServers();
    Lobby.peer = new Peer(Lobby.myPlayerId, {
      host: '0.peerjs.com', port: 443, secure: true,
      config: { iceServers: ice }
    });

    var hostId = 'stacksvr-host-' + lobbyNum;
    Lobby.peer.on('open', function () {
      Lobby.conn = Lobby.peer.connect(hostId);
      Lobby.conn.on('open', function () {
        Lobby.isMultiplayer = true;
        global.isMultiplayer = true;
        Lobby.connectionState = 'connected';
        if (asMobile) {
          Lobby.conn.send({ type: 'mobile-spectator', nickname: 'Spectator' });
          Lobby.conn.send({ type: 'hello', nickname: 'Spectator' });
        } else {
          Lobby.conn.send({ type: 'hello', nickname: 'Player' });
        }
      });
      Lobby.conn.on('data', function (data) { handleData(hostId, data, false); });
      Lobby.conn.on('close', function () {
        Lobby.isMultiplayer = false;
        if (Lobby.onDisconnected) Lobby.onDisconnected();
      });
    });
  }

  async function connectToLobby(lobbyNum) {
    if (Lobby.isMultiplayer || Lobby.connectionState === 'connecting') return;
    Lobby.connectionState = 'connecting';
    var hostId = 'stacksvr-host-' + lobbyNum;
    var hostTaken = !(await checkPeerAvailability(hostId));
    if (hostTaken) await setupPeer(lobbyNum, false);
    else await setupHost(lobbyNum);
  }

  async function connectAsMobileSpectator(lobbyNum) {
    if (Lobby.isMultiplayer || Lobby.connectionState === 'connecting') {
      return { ok: false, error: 'Already connecting.' };
    }
    Lobby.connectionState = 'connecting';
    var hostId = 'stacksvr-host-' + lobbyNum;
    var hostAvailable = await checkPeerAvailability(hostId);
    var hostTaken = !hostAvailable;
    if (!hostTaken) {
      Lobby.connectionState = 'idle';
      return { ok: false, error: 'No lobby found. In VR: Multi Lobby → Connect Lobby ' + lobbyNum + ' first.' };
    }
    try {
      await setupPeer(lobbyNum, true);
      // Wait briefly for the data connection to open
      var ok = await new Promise(function (resolve) {
        var n = 0;
        var iv = setInterval(function () {
          n++;
          if (Lobby.conn && Lobby.conn.open) {
            clearInterval(iv);
            resolve(true);
          } else if (n > 50) {
            clearInterval(iv);
            resolve(false);
          }
        }, 100);
      });
      if (!ok) {
        Lobby.connectionState = 'idle';
        Lobby.isMultiplayer = false;
        return { ok: false, error: 'Lobby id exists but connection failed. Same Wi‑Fi / retry.' };
      }
      return { ok: true };
    } catch (e) {
      Lobby.connectionState = 'idle';
      return { ok: false, error: (e && e.message) || 'Connect failed' };
    }
  }

  function sendQueueAction(action) {
    if (Lobby.isHost) handleQueueAction(Lobby.myPlayerId, action);
    else if (Lobby.conn && Lobby.conn.open) Lobby.conn.send({ type: 'queue-action', action: action });
  }

  function sendMatchAction(action) {
    if (Lobby.isHost) handleMatchAction(Lobby.myPlayerId, action);
    else if (Lobby.conn && Lobby.conn.open) Lobby.conn.send({ type: 'match-action', action: action });
  }

  function sendCupEvent(evt) {
    evt = Object.assign({ type: 'cup-event', from: Lobby.myPlayerId }, evt);
    if (Lobby.isHost) {
      for (var i = 0; i < Lobby.connections.length; i++) {
        if (Lobby.connections[i].conn.open) Lobby.connections[i].conn.send(evt);
      }
      // Host already applied locally — do not echo through onCupEvent
    } else if (Lobby.conn && Lobby.conn.open) {
      Lobby.conn.send(evt);
    }
  }

  function sendCupSnapshot(snap) {
    var msg = { type: 'cup-snapshot', snapshot: snap, from: Lobby.myPlayerId };
    if (Lobby.isHost) {
      for (var i = 0; i < Lobby.connections.length; i++) {
        if (Lobby.connections[i].conn.open) Lobby.connections[i].conn.send(msg);
      }
    } else if (Lobby.conn && Lobby.conn.open) {
      Lobby.conn.send(msg);
    }
  }

  function sendPlayerPose(pose) {
    var msg = Object.assign({ type: 'player-pose' }, pose);
    if (Lobby.isHost) {
      for (var i = 0; i < Lobby.connections.length; i++) {
        if (Lobby.connections[i].conn.open) Lobby.connections[i].conn.send(Object.assign({ from: Lobby.myPlayerId }, msg));
      }
    } else if (Lobby.conn && Lobby.conn.open) {
      Lobby.conn.send(msg);
    }
  }

  function amMatchPlayer() {
    if (!Lobby.lobbyState) return false;
    var mp = Lobby.lobbyState.matchPlayers;
    return mp && (mp.blue === Lobby.myPlayerId || mp.red === Lobby.myPlayerId);
  }

  function mySide() {
    if (!Lobby.lobbyState) return 'blue';
    var mp = Lobby.lobbyState.matchPlayers;
    if (mp.red === Lobby.myPlayerId) return 'red';
    return 'blue';
  }

  // Exports
  global.StacksLobby = Lobby;
  global.connectToLobby = connectToLobby;
  global.connectAsMobileSpectator = connectAsMobileSpectator;
  global.sendQueueAction = sendQueueAction;
  global.sendMatchAction = sendMatchAction;
  global.sendCupEvent = sendCupEvent;
  global.sendCupSnapshot = sendCupSnapshot;
  global.sendPlayerPose = sendPlayerPose;
  global.createLobbyState = createLobbyState;
  global.startLobbyMatch = startLobbyMatch;
  global.endLobbyMatch = endLobbyMatch;
  global.broadcastLobbyState = broadcastLobbyState;
  Lobby.sendQueueAction = sendQueueAction;
  Lobby.sendMatchAction = sendMatchAction;
  Lobby.sendCupEvent = sendCupEvent;
  Lobby.sendCupSnapshot = sendCupSnapshot;
  Lobby.sendPlayerPose = sendPlayerPose;
  Lobby.connectToLobby = connectToLobby;
  Lobby.connectAsMobileSpectator = connectAsMobileSpectator;
  Lobby.amMatchPlayer = amMatchPlayer;
  Lobby.mySide = mySide;
  Lobby.startLobbyMatch = startLobbyMatch;
  Lobby.endLobbyMatch = endLobbyMatch;

  global.isMultiplayer = false;
  global.isHost = false;
  global.isSpectator = false;
  global.isLobbyBotMatch = false;
  global.lobbyState = null;
})(window);
