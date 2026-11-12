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

  // Survives lobby teardown so offline 4×4 choice carries into a new host session
  var preferredBoardSize = 6;

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
      mobileSpectatorCount: 0,
      // Playfield XZ size — 6 (classic) or 4 (compact). Host-authored; synced to all.
      boardSize: normalizeBoardSize(preferredBoardSize)
    };
  }

  function normalizeBoardSize(size) {
    return size === 4 ? 4 : 6;
  }

  /**
   * Host (or offline) sets board size. Broadcasts lobby-state so peers/spectators match.
   * Returns false if a non-host peer tried to change it while connected.
   */
  function setBoardSize(size) {
    size = normalizeBoardSize(size);
    if (Lobby.isMultiplayer && !Lobby.isHost) return false;
    preferredBoardSize = size;
    if (!Lobby.lobbyState) Lobby.lobbyState = createLobbyState();
    if (Lobby.lobbyState.boardSize === size) {
      global.lobbyState = Lobby.lobbyState;
      return true;
    }
    Lobby.lobbyState.boardSize = size;
    global.lobbyState = Lobby.lobbyState;
    broadcastLobbyState();
    var scene = document.querySelector('a-scene');
    if (scene) scene.emit('board-size-changed', { boardSize: size });
    return true;
  }

  function getBoardSize() {
    if (Lobby.lobbyState && Lobby.lobbyState.boardSize) {
      return normalizeBoardSize(Lobby.lobbyState.boardSize);
    }
    return normalizeBoardSize(preferredBoardSize);
  }

  /** Offline/host applies locally; peer requests host so lobby-state syncs everyone. */
  function requestBoardSize(size) {
    size = normalizeBoardSize(size);
    if (!Lobby.isMultiplayer || Lobby.isHost) return setBoardSize(size);
    if (Lobby.conn && Lobby.conn.open) {
      Lobby.conn.send({ type: 'board-size', size: size });
      return true;
    }
    return false;
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

  function seatOpen(id) {
    return !id || id === '__BOT__';
  }

  function clearSpectatorSlot(playerId) {
    if (!Lobby.lobbyState) return;
    for (var s = 0; s < Lobby.lobbyState.spectatorSlots.length; s++) {
      if (Lobby.lobbyState.spectatorSlots[s] === playerId) {
        Lobby.lobbyState.spectatorSlots[s] = null;
      }
    }
  }

  /**
   * Seat queued humans into open blue/red slots WITHOUT removing them from queue.
   * Queue length is the source of truth for "how many want to play" (Q:N in HUD).
   * Leaving queue removes only that player; others stay queued + seated.
   */
  function tryAssignMatchPlayers() {
    if (!Lobby.lobbyState) return;
    if (Lobby.lobbyState.matchState === 'PLAYING') return;
    if (Lobby.lobbyState.queue.length === 0) return;

    var mp = Lobby.lobbyState.matchPlayers;
    var q = Lobby.lobbyState.queue;
    for (var i = 0; i < q.length; i++) {
      var nextId = q[i];
      if (mp.blue === nextId || mp.red === nextId) continue;
      if (seatOpen(mp.blue)) {
        mp.blue = nextId;
      } else if (seatOpen(mp.red)) {
        mp.red = nextId;
      } else {
        break;
      }
      clearSpectatorSlot(nextId);
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
      // Only this player leaves — never clear the whole queue
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
    // Host can start without queue join — seat host as blue automatically (DodgeVR-style)
    if (Lobby.isHost && Lobby.myPlayerId) {
      // If host was wrongly parked on red, move them to blue (human pad side)
      if (mp.red === Lobby.myPlayerId) mp.red = null;
      if (seatOpen(mp.blue)) {
        mp.blue = Lobby.myPlayerId;
        for (var s = 0; s < Lobby.lobbyState.spectatorSlots.length; s++) {
          if (Lobby.lobbyState.spectatorSlots[s] === Lobby.myPlayerId) {
            Lobby.lobbyState.spectatorSlots[s] = null;
          }
        }
      }
    }
    if (!mp.blue || mp.blue === '__BOT__') return;

    // __BOT__ is a seat filler, not a human — treat as bot match.
    var humanRed = !!(mp.red && mp.red !== '__BOT__');
    var humanBlue = !!(mp.blue && mp.blue !== '__BOT__');
    var isBotMatch = humanBlue && !humanRed;
    if (isBotMatch) {
      // Solo / vs-bot: host (or blue human) always owns blue; bot always red
      if (Lobby.isHost && Lobby.myPlayerId) mp.blue = Lobby.myPlayerId;
      mp.red = '__BOT__';
    }
    Lobby.isLobbyBotMatch = isBotMatch;
    global.isLobbyBotMatch = isBotMatch;

    // Consume seated players from the queue (they're now playing)
    Lobby.lobbyState.queue = Lobby.lobbyState.queue.filter(function (id) {
      return id !== mp.blue && id !== mp.red;
    });
    clearSpectatorSlot(mp.blue);
    if (mp.red && mp.red !== '__BOT__') clearSpectatorSlot(mp.red);

    Lobby.lobbyState.matchState = 'PLAYING';
    Lobby.lobbyState.matchScore = { blue: 0, red: 0 };
    Lobby.lobbyState.matchGameState = 'PLAYING';
    var startTime = Date.now();
    Lobby.lobbyState.matchStartTime = startTime;
    // Unique per-match bag seed — both seats share the same piece sequence
    var bagSeed = (global.StacksShapes && global.StacksShapes.newBagSeed)
      ? global.StacksShapes.newBagSeed()
      : ((Date.now() ^ (Math.random() * 0x100000000)) >>> 0);
    Lobby.lobbyState.bagSeed = bagSeed;
    Lobby.isSpectator = !(mp.blue === Lobby.myPlayerId || mp.red === Lobby.myPlayerId);
    global.isSpectator = Lobby.isSpectator;
    global.lobbyState = Lobby.lobbyState;
    syncWindowState();

    for (var i = 0; i < Lobby.connections.length; i++) {
      if (Lobby.connections[i].conn.open) {
        Lobby.connections[i].conn.send({
          type: 'match-started',
          matchPlayers: {
            blue: mp.blue,
            red: mp.red
          },
          startTime: startTime,
          isBotMatch: isBotMatch,
          bagSeed: bagSeed,
          boardSize: normalizeBoardSize(Lobby.lobbyState.boardSize),
          state: Lobby.lobbyState
        });
      }
    }
    broadcastLobbyState();
    if (Lobby.onMatchStarted) Lobby.onMatchStarted(mp, startTime, isBotMatch, bagSeed);
  }

  function endLobbyMatch(result) {
    if (!Lobby.lobbyState) return;
    result = result || {};
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

    var endMsg = {
      type: 'match-ended',
      winner: result.winner || null,
      reason: result.reason || null,
      scores: result.scores || null,
      cancelled: !!result.cancelled || !result.winner
    };
    for (var i = 0; i < Lobby.connections.length; i++) {
      if (Lobby.connections[i].conn.open) {
        Lobby.connections[i].conn.send(endMsg);
      }
    }
    broadcastLobbyState();
    if (Lobby.onMatchEnded) {
      Lobby.onMatchEnded({
        cancelled: endMsg.cancelled,
        victory: !endMsg.cancelled && !!endMsg.winner,
        winner: endMsg.winner,
        reason: endMsg.reason,
        scores: endMsg.scores
      });
    }
  }

  function handleMatchAction(playerId, action, result) {
    if (!Lobby.lobbyState) return;
    var mp = Lobby.lobbyState.matchPlayers;
    // Host may start/end even before seating (startLobbyMatch auto-seats host as blue).
    // Seated match players may also start/end.
    var allowed = Lobby.isHost ||
      playerId === mp.blue ||
      playerId === mp.red;
    if (!allowed) return;
    if (action === 'start' && Lobby.lobbyState.matchState !== 'PLAYING') {
      startLobbyMatch();
    } else if (action === 'end' && Lobby.lobbyState.matchState === 'PLAYING') {
      endLobbyMatch(result || null);
    }
  }

  function sendMatchStartedToConn(conn) {
    if (!conn || !conn.open || !Lobby.lobbyState) return;
    if (Lobby.lobbyState.matchState !== 'PLAYING') return;
    var mp = Lobby.lobbyState.matchPlayers;
    if (!mp || !mp.blue || !mp.red) return;
    conn.send({
      type: 'match-started',
      matchPlayers: { blue: mp.blue, red: mp.red },
      startTime: Lobby.lobbyState.matchStartTime,
      isBotMatch: !!Lobby.isLobbyBotMatch || mp.red === '__BOT__',
      bagSeed: Lobby.lobbyState.bagSeed,
      boardSize: normalizeBoardSize(Lobby.lobbyState.boardSize),
      state: Lobby.lobbyState
    });
  }

  function sendSnapshotToConn(conn) {
    if (!conn || !conn.open) return;
    if (!Lobby.onRequestSnapshot) return;
    var snap = Lobby.onRequestSnapshot();
    if (snap) conn.send({ type: 'cup-snapshot', snapshot: snap });
  }

  /**
   * If the host already started an offline/local bot match, promote it into lobby
   * PLAYING so mobile spectators receive match-started + board + poses.
   * Does NOT clear cups (preserves in-progress board).
   */
  function ensureLobbyMatchPublished() {
    if (!Lobby.isHost || !Lobby.lobbyState) return false;
    var gm = document.querySelector('[stacks-game]');
    var comp = gm && gm.components && gm.components['stacks-game'];
    // Dual-bot idle spectacle is NOT a real lobby match — never promote it to
    // PLAYING or queue/start/control logic gets poisoned (isLobbyBotMatch false,
    // host stuck unable to place / no opponent).
    if (comp && comp._dualBotPreview) return false;
    var localPlaying = !!(comp && comp.matchActive && !comp._dualBotPreview &&
      (comp.matchState === 'PLAYING' || comp.matchState === 'COUNTDOWN'));
    if (Lobby.lobbyState.matchState === 'PLAYING' &&
        Lobby.lobbyState.matchPlayers.blue && Lobby.lobbyState.matchPlayers.red) {
      return true;
    }
    if (!localPlaying) return false;

    var mp = Lobby.lobbyState.matchPlayers;
    if (!mp.blue) mp.blue = Lobby.myPlayerId;
    if (!mp.red) mp.red = '__BOT__';
    Lobby.isLobbyBotMatch = mp.red === '__BOT__';
    global.isLobbyBotMatch = Lobby.isLobbyBotMatch;
    Lobby.lobbyState.matchState = 'PLAYING';
    Lobby.lobbyState.matchGameState = 'PLAYING';
    if (!Lobby.lobbyState.matchStartTime) {
      Lobby.lobbyState.matchStartTime = (comp && comp.modes && comp.modes.startTime) || Date.now();
    }
    if (comp && comp.modes && comp.modes.scores) {
      Lobby.lobbyState.matchScore = {
        blue: comp.modes.scores.blue || 0,
        red: comp.modes.scores.red || 0
      };
    }
    Lobby.isSpectator = !(mp.blue === Lobby.myPlayerId || mp.red === Lobby.myPlayerId);
    global.isSpectator = Lobby.isSpectator;
    global.lobbyState = Lobby.lobbyState;
    syncWindowState();
    broadcastLobbyState();
    for (var i = 0; i < Lobby.connections.length; i++) {
      if (Lobby.connections[i].conn.open) {
        sendMatchStartedToConn(Lobby.connections[i].conn);
        sendSnapshotToConn(Lobby.connections[i].conn);
      }
    }
    return true;
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
      else if (data.type === 'match-action') handleMatchAction(fromId, data.action, data.result);
      else if (data.type === 'board-size') setBoardSize(data.size);
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
          if (cj.id !== fromId && cj.conn.open) {
            cj.conn.send(Object.assign({}, data, { from: fromId, type: 'player-pose' }));
          }
        }
        if (Lobby.onPlayerPose) Lobby.onPlayerPose(fromId, data);
        if (typeof global.applyStacksRemotePose === 'function') {
          global.applyStacksRemotePose(fromId, data);
        }
      } else if (data.type === 'mobile-spectator') {
        var entryMs = Lobby.connections.find(function (x) { return x.id === fromId; });
        if (entryMs) entryMs.isMobileSpectator = true;
        Lobby.lobbyState.mobileSpectatorCount = Lobby.connections.filter(function (c) {
          return c.isMobileSpectator;
        }).length;
        // Promote offline-in-progress host match so phone leaves WAITING
        ensureLobbyMatchPublished();
        broadcastLobbyState();
        if (entryMs && entryMs.conn) {
          sendMatchStartedToConn(entryMs.conn);
          sendSnapshotToConn(entryMs.conn);
        }
      } else if (data.type === 'hello') {
        var exists = Lobby.lobbyState.players.some(function (p) { return p.id === fromId; });
        if (!exists) {
          Lobby.lobbyState.players.push({ id: fromId, nickname: data.nickname || 'Player', mobile: !!isMobile });
        }
        if (isMobile) {
          Lobby.lobbyState.mobileSpectatorCount = Lobby.connections.filter(function (c) {
            return c.isMobileSpectator || c.id === fromId;
          }).length;
        }
        assignSpectatorSlot(fromId);
        ensureLobbyMatchPublished();
        broadcastLobbyState();
        var entry = Lobby.connections.find(function (x) { return x.id === fromId; });
        if (entry && entry.conn) {
          sendMatchStartedToConn(entry.conn);
          sendSnapshotToConn(entry.conn);
        }
      }
      return;
    }

    // Peer / mobile spectator
    if (data.type === 'lobby-state') {
      Lobby.lobbyState = data.state;
      if (Lobby.lobbyState && Lobby.lobbyState.boardSize == null) Lobby.lobbyState.boardSize = 6;
      else if (Lobby.lobbyState) Lobby.lobbyState.boardSize = normalizeBoardSize(Lobby.lobbyState.boardSize);
      if (Lobby.lobbyState) preferredBoardSize = Lobby.lobbyState.boardSize;
      global.lobbyState = data.state;
      var mp = data.state.matchPlayers;
      Lobby.isSpectator = !(mp && (mp.blue === Lobby.myPlayerId || mp.red === Lobby.myPlayerId));
      global.isSpectator = Lobby.isSpectator;
      syncWindowState();
      if (Lobby.onLobbyState) Lobby.onLobbyState(data.state);
      var scene = document.querySelector('a-scene');
      if (scene) {
        scene.emit('lobby-state-updated');
        scene.emit('board-size-changed', {
          boardSize: Lobby.lobbyState ? Lobby.lobbyState.boardSize : 6
        });
      }
    } else if (data.type === 'match-started') {
      // MUST update local lobbyState here — do not wait for a later lobby-state
      // (HUD / avatar routing key off matchState === PLAYING + matchPlayers)
      Lobby.isLobbyBotMatch = !!data.isBotMatch;
      global.isLobbyBotMatch = Lobby.isLobbyBotMatch;
      if (data.state) {
        Lobby.lobbyState = data.state;
      } else if (!Lobby.lobbyState) {
        Lobby.lobbyState = createLobbyState();
      }
      if (data.matchPlayers) {
        Lobby.lobbyState.matchPlayers = {
          blue: data.matchPlayers.blue,
          red: data.matchPlayers.red
        };
      }
      Lobby.lobbyState.matchState = 'PLAYING';
      Lobby.lobbyState.matchGameState = 'PLAYING';
      Lobby.lobbyState.matchStartTime = data.startTime || Date.now();
      var bagSeed = data.bagSeed;
      if (bagSeed == null && data.state && data.state.bagSeed != null) bagSeed = data.state.bagSeed;
      if (bagSeed != null) Lobby.lobbyState.bagSeed = bagSeed >>> 0;
      if (data.boardSize != null) {
        Lobby.lobbyState.boardSize = normalizeBoardSize(data.boardSize);
      } else if (data.state && data.state.boardSize != null) {
        Lobby.lobbyState.boardSize = normalizeBoardSize(data.state.boardSize);
      } else if (Lobby.lobbyState.boardSize == null) {
        Lobby.lobbyState.boardSize = 6;
      }
      preferredBoardSize = Lobby.lobbyState.boardSize;
      global.lobbyState = Lobby.lobbyState;
      Lobby.isSpectator = !(Lobby.lobbyState.matchPlayers &&
        (Lobby.lobbyState.matchPlayers.blue === Lobby.myPlayerId ||
          Lobby.lobbyState.matchPlayers.red === Lobby.myPlayerId));
      global.isSpectator = Lobby.isSpectator;
      syncWindowState();
      if (Lobby.onMatchStarted) {
        Lobby.onMatchStarted(
          Lobby.lobbyState.matchPlayers,
          data.startTime,
          data.isBotMatch,
          Lobby.lobbyState.bagSeed
        );
      }
      var scene2 = document.querySelector('a-scene');
      if (scene2) {
        scene2.emit('lobby-state-updated');
        scene2.emit('board-size-changed', {
          boardSize: Lobby.lobbyState.boardSize || 6
        });
      }
    } else if (data.type === 'match-ended') {
      if (Lobby.lobbyState) {
        Lobby.lobbyState.matchState = 'WAITING';
        Lobby.lobbyState.matchGameState = null;
        global.lobbyState = Lobby.lobbyState;
      }
      if (Lobby.onMatchEnded) {
        Lobby.onMatchEnded({
          cancelled: !!data.cancelled || !data.winner,
          victory: !data.cancelled && !!data.winner,
          winner: data.winner || null,
          reason: data.reason || null,
          scores: data.scores || null
        });
      }
      var scene3 = document.querySelector('a-scene');
      if (scene3) scene3.emit('lobby-state-updated');
    } else if (data.type === 'cup-event' || data.type === 'cup-snapshot') {
      if (Lobby.onCupEvent) Lobby.onCupEvent(data);
      if (data.type === 'cup-snapshot' && Lobby.onCupSnapshot) Lobby.onCupSnapshot(data);
    } else if (data.type === 'player-pose') {
      var poseFrom = data.from || fromId;
      if (Lobby.onPlayerPose) Lobby.onPlayerPose(poseFrom, data);
      // Direct apply — do not depend solely on mobile-spectator callback wrapping
      if (typeof global.applyStacksRemotePose === 'function') {
        global.applyStacksRemotePose(poseFrom, data);
      }
    }
  }

  // Same ICE path as DodgeVR — STUN alone fails Quest↔mobile NAT; TURN is required.
  // Proxy may be CORS-blocked on mic79.github.io / localhost; fall back to same-origin ice-servers.json.
  async function getIceServers() {
    var stunOnly = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];
    function hasTurn(list) {
      return Array.isArray(list) && list.some(function (s) {
        var u = s && s.urls;
        var str = Array.isArray(u) ? u.join(',') : String(u || '');
        return /turn:/i.test(str);
      });
    }
    try {
      var response = await fetch('https://dotmination-turn-proxy.odd-bird-4c2c.workers.dev');
      if (response.ok) {
        var remote = await response.json();
        if (hasTurn(remote)) return remote;
      }
    } catch (e) {
      console.warn('[StacksLobby] TURN proxy fetch failed, trying local ice-servers.json');
    }
    var localTries = ['ice-servers.json'];
    if (typeof location !== 'undefined' && /\/scripts\//.test(location.pathname || '')) {
      localTries.push('../ice-servers.json');
    }
    for (var li = 0; li < localTries.length; li++) {
      try {
        var local = await fetch(localTries[li]);
        if (local.ok) {
          var fileIce = await local.json();
          if (hasTurn(fileIce)) {
            Lobby._iceSource = localTries[li];
            return fileIce;
          }
        }
      } catch (e2) {}
    }
    console.warn('[StacksLobby] No TURN config — mobile spectate across NATs will fail');
    return stunOnly;
  }

  function syncWindowState() {
    global.isMultiplayer = Lobby.isMultiplayer;
    global.isHost = Lobby.isHost;
    global.isSpectator = Lobby.isSpectator;
    // Sticky device/URL spectator mode — failed Watch must NOT clear this or
    // offline Preview orbit swipe dies (tick/onStart early-out on false).
    global.isMobileSpectator = !!(Lobby.isMobileSpectator || global._stacksDeviceMobileSpectator);
    global.isLobbyBotMatch = Lobby.isLobbyBotMatch;
    global.lobbyState = Lobby.lobbyState;
    global.myPlayerId = Lobby.myPlayerId;
    global.connectionState = Lobby.connectionState;
    global.StacksLobbyStatus = Lobby.statusText || '';
  }

  function setStatus(text) {
    Lobby.statusText = text || '';
    syncWindowState();
    var scene = document.querySelector('a-scene');
    if (scene) scene.emit('lobby-state-updated');
    if (Lobby.onStatus) Lobby.onStatus(text);
  }

  // DodgeVR semantics: true = id free, false = taken (or ambiguous timeout → try join)
  function checkPeerAvailability(id) {
    return new Promise(function (resolve) {
      var tempPeer = new Peer(id, { host: '0.peerjs.com', port: 443, secure: true });
      var timeout = setTimeout(function () {
        try { tempPeer.destroy(); } catch (e) {}
        resolve(false);
      }, 2000);
      tempPeer.on('open', function () {
        clearTimeout(timeout);
        try { tempPeer.destroy(); } catch (e) {}
        resolve(true);
      });
      tempPeer.on('error', function (err) {
        clearTimeout(timeout);
        try { tempPeer.destroy(); } catch (e) {}
        if (err && err.type === 'unavailable-id') resolve(false);
        else resolve(true);
      });
    });
  }

  function cleanupMultiplayer() {
    try {
      if (Lobby.conn) { Lobby.conn.close(); }
    } catch (e) {}
    Lobby.conn = null;
    for (var i = 0; i < Lobby.connections.length; i++) {
      try { Lobby.connections[i].conn.close(); } catch (e2) {}
    }
    Lobby.connections = [];
    try {
      if (Lobby.peer) Lobby.peer.destroy();
    } catch (e3) {}
    Lobby.peer = null;
    Lobby.isMultiplayer = false;
    Lobby.isHost = false;
    Lobby.isSpectator = false;
    Lobby.isMobileSpectator = false;
    Lobby.lobbyState = null;
    Lobby.myPlayerId = null;
    Lobby.connectionState = 'idle';
    Lobby.statusText = '';
    syncWindowState();
  }

  function endMultiplayer() {
    cleanupMultiplayer();
    setStatus('Disconnected');
  }

  async function setupHost(lobbyNum) {
    cleanupMultiplayer();
    Lobby.lobbyNum = lobbyNum;
    Lobby.lobbyState = createLobbyState();
    Lobby.myPlayerId = 'stacksvr-host-' + lobbyNum;
    Lobby.lobbyState.players.push({
      id: Lobby.myPlayerId,
      nickname: (global.playerNickname || 'Host').slice(0, 12),
      mobile: false
    });
    assignSpectatorSlot(Lobby.myPlayerId);
    Lobby.isHost = false; // set true only after peer open (DodgeVR)
    Lobby.isMultiplayer = false;
    syncWindowState();
    setStatus('Creating lobby ' + lobbyNum + '...');

    var ice = await getIceServers();
    Lobby.peer = new Peer(Lobby.myPlayerId, {
      host: '0.peerjs.com', port: 443, secure: true,
      config: { iceServers: ice }
    });

    Lobby.peer.on('open', function () {
      Lobby.isMultiplayer = true;
      Lobby.isHost = true;
      Lobby.connectionState = 'connected';
      syncWindowState();
      setStatus('HOSTING Lobby ' + lobbyNum + ' — waiting for players');
      broadcastLobbyState();
    });

    Lobby.peer.on('connection', function (newConn) {
      if (Lobby.connections.length >= 13) {
        newConn.close();
        return;
      }
      var peerId = newConn.peer;
      var entry = {
        id: peerId,
        conn: newConn,
        isMobileSpectator: peerId.indexOf('stacksvr-mspec-') === 0
      };
      newConn.on('open', function () {
        Lobby.connections.push(entry);
        newConn.send({ type: 'lobby-state', state: Lobby.lobbyState });
        setStatus('HOSTING Lobby ' + lobbyNum + ' — ' + Lobby.connections.length + ' connected');
      });
      newConn.on('data', function (data) {
        if (data && data.type === 'mobile-spectator') entry.isMobileSpectator = true;
        handleData(peerId, data, entry.isMobileSpectator);
      });
      newConn.on('close', function () {
        Lobby.connections = Lobby.connections.filter(function (c) { return c.id !== peerId; });
        removePlayer(peerId);
        setStatus('HOSTING Lobby ' + lobbyNum + ' — ' + Lobby.connections.length + ' connected');
      });
    });

    Lobby.peer.on('error', function (err) {
      console.warn('[StacksLobby] host error', err);
      setStatus('Host error: ' + (err && err.type ? err.type : 'unknown'));
      Lobby.connectionState = 'idle';
      syncWindowState();
    });
  }

  async function setupPeer(lobbyNum, asMobile) {
    cleanupMultiplayer();
    Lobby.lobbyNum = lobbyNum;
    Lobby.isHost = false;
    var peerIdNum = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    Lobby.myPlayerId = asMobile ? ('stacksvr-mspec-' + peerIdNum) : ('stacksvr-peer-' + peerIdNum);
    Lobby.isMobileSpectator = !!asMobile;
    Lobby.isSpectator = !!asMobile;
    syncWindowState();
    setStatus(asMobile ? 'Spectating — opening peer...' : 'Joining lobby ' + lobbyNum + '...');

    var ice = await getIceServers();
    Lobby.peer = new Peer(Lobby.myPlayerId, {
      host: '0.peerjs.com', port: 443, secure: true,
      config: { iceServers: ice }
    });

    var hostId = 'stacksvr-host-' + lobbyNum;
    return new Promise(function (resolve, reject) {
      var settled = false;
      function fail(msg) {
        if (settled) return;
        settled = true;
        Lobby.connectionState = 'idle';
        Lobby.isMultiplayer = false;
        syncWindowState();
        setStatus(msg);
        reject(new Error(msg));
      }
      function ok() {
        if (settled) return;
        settled = true;
        resolve(true);
      }

      var timer = setTimeout(function () {
        fail('Connection timed out to lobby ' + lobbyNum);
      }, 20000);

      Lobby.peer.on('open', function () {
        setStatus(asMobile ? 'Connecting to host...' : 'Connecting to host...');
        Lobby.conn = Lobby.peer.connect(hostId, { reliable: true });
        Lobby.conn.on('open', function () {
          clearTimeout(timer);
          Lobby.isMultiplayer = true;
          Lobby.isHost = false;
          Lobby.connectionState = 'connected';
          syncWindowState();
          if (asMobile) {
            Lobby.conn.send({ type: 'mobile-spectator', nickname: 'Spectator' });
            Lobby.conn.send({ type: 'hello', nickname: 'Spectator' });
            setStatus('WATCHING Lobby ' + lobbyNum);
          } else {
            Lobby.conn.send({
              type: 'hello',
              nickname: (global.playerNickname || 'Player').slice(0, 12)
            });
            setStatus('JOINED Lobby ' + lobbyNum);
          }
          ok();
        });
        Lobby.conn.on('data', function (data) { handleData(hostId, data, false); });
        Lobby.conn.on('error', function () {
          clearTimeout(timer);
          fail('Connection failed to lobby ' + lobbyNum);
        });
        Lobby.conn.on('close', function () {
          Lobby.isMultiplayer = false;
          Lobby.connectionState = 'idle';
          syncWindowState();
          setStatus('Disconnected from lobby');
          if (Lobby.onDisconnected) Lobby.onDisconnected();
        });
      });
      Lobby.peer.on('error', function (err) {
        clearTimeout(timer);
        fail('Peer error: ' + (err && err.type ? err.type : 'unknown'));
      });
    });
  }

  async function connectToLobby(lobbyNum) {
    if (Lobby.isMultiplayer || Lobby.connectionState === 'connecting') return;
    Lobby.connectionState = 'connecting';
    global.connectionState = 'connecting';
    setStatus('Connecting to lobby ' + lobbyNum + '...');
    var hostId = 'stacksvr-host-' + lobbyNum;
    var hostTaken = !(await checkPeerAvailability(hostId));
    if (hostTaken) {
      try {
        await setupPeer(lobbyNum, false);
      } catch (e) {
        setStatus((e && e.message) || 'Join failed');
      }
    } else {
      await setupHost(lobbyNum);
    }
  }

  // DodgeVR-style mobile spectator: TURN + wait on real conn open (not a short poll).
  async function connectAsMobileSpectator(lobbyNum) {
    if (Lobby.isMultiplayer || Lobby.connectionState === 'connecting') {
      return { ok: false, error: 'Already connecting.' };
    }
    Lobby.connectionState = 'connecting';
    global.connectionState = 'connecting';
    setStatus('Looking for lobby ' + lobbyNum + '...');
    var hostId = 'stacksvr-host-' + lobbyNum;
    var hostTaken = !(await checkPeerAvailability(hostId));
    if (!hostTaken) {
      Lobby.connectionState = 'idle';
      syncWindowState();
      return { ok: false, error: 'No lobby found. Host must create it in VR first.' };
    }
    try {
      await setupPeer(lobbyNum, true);
      return { ok: true };
    } catch (e) {
      Lobby.connectionState = 'idle';
      syncWindowState();
      return { ok: false, error: (e && e.message) || 'Connect failed' };
    }
  }

  function sendQueueAction(action) {
    if (Lobby.isHost) handleQueueAction(Lobby.myPlayerId, action);
    else if (Lobby.conn && Lobby.conn.open) Lobby.conn.send({ type: 'queue-action', action: action });
  }

  function sendMatchAction(action, result) {
    if (Lobby.isHost) handleMatchAction(Lobby.myPlayerId, action, result);
    else if (Lobby.conn && Lobby.conn.open) {
      Lobby.conn.send({ type: 'match-action', action: action, result: result || null });
    }
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
    var fromId = (pose && pose.from) || Lobby.myPlayerId;
    var msg = Object.assign({}, pose, { type: 'player-pose', from: fromId });
    if (Lobby.isHost) {
      for (var i = 0; i < Lobby.connections.length; i++) {
        if (Lobby.connections[i].conn.open) Lobby.connections[i].conn.send(msg);
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
    // Vs bot: local human is always blue (pad/station ownership)
    if (Lobby.isLobbyBotMatch || (mp && mp.red === '__BOT__')) return 'blue';
    if (mp.red === Lobby.myPlayerId) return 'red';
    return 'blue';
  }

  // Exports
  global.StacksLobby = Lobby;
  global.connectToLobby = connectToLobby;
  global.connectAsMobileSpectator = connectAsMobileSpectator;
  global.endMultiplayer = endMultiplayer;
  global.cleanupMultiplayer = cleanupMultiplayer;
  global.sendQueueAction = sendQueueAction;
  global.sendMatchAction = sendMatchAction;
  global.sendCupEvent = sendCupEvent;
  global.sendCupSnapshot = sendCupSnapshot;
  global.sendPlayerPose = sendPlayerPose;
  global.createLobbyState = createLobbyState;
  global.startLobbyMatch = startLobbyMatch;
  global.endLobbyMatch = endLobbyMatch;
  global.broadcastLobbyState = broadcastLobbyState;
  global.setBoardSize = setBoardSize;
  global.getBoardSize = getBoardSize;
  global.requestBoardSize = requestBoardSize;
  Lobby.setBoardSize = setBoardSize;
  Lobby.getBoardSize = getBoardSize;
  Lobby.requestBoardSize = requestBoardSize;
  Lobby.normalizeBoardSize = normalizeBoardSize;
  global.ensureLobbyMatchPublished = ensureLobbyMatchPublished;
  Lobby.ensureLobbyMatchPublished = ensureLobbyMatchPublished;
  Lobby.sendMatchStartedToConn = sendMatchStartedToConn;
  Lobby.sendSnapshotToConn = sendSnapshotToConn;
  Lobby.sendQueueAction = sendQueueAction;
  Lobby.sendMatchAction = sendMatchAction;
  Lobby.sendCupEvent = sendCupEvent;
  Lobby.sendCupSnapshot = sendCupSnapshot;
  Lobby.sendPlayerPose = sendPlayerPose;
  Lobby.connectToLobby = connectToLobby;
  Lobby.connectAsMobileSpectator = connectAsMobileSpectator;
  Lobby.endMultiplayer = endMultiplayer;
  Lobby.amMatchPlayer = amMatchPlayer;
  Lobby.mySide = mySide;
  Lobby.startLobbyMatch = startLobbyMatch;
  Lobby.endLobbyMatch = endLobbyMatch;

  global.isMultiplayer = false;
  global.isHost = false;
  global.isSpectator = false;
  global.isLobbyBotMatch = false;
  global.lobbyState = null;
  global.connectionState = 'idle';
  global.StacksLobbyStatus = '';
})(window);
