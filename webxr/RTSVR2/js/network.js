// ========================================
// RTSVR2 — Network System
// PeerJS host-authoritative state sync
// ========================================

import * as State from './state.js';
import * as Units from './units.js';
import * as Buildings from './buildings.js';
import * as Pathfinding from './pathfinding.js';
import { NET_SNAPSHOT_RATE, NET_CLIENT_CMD_TIMEOUT_MS } from './config.js';

let peer = null;
const connections = new Map(); // playerId -> connection
let lobbyNumber = 1;
let lastSnapshotTime = 0;

let clientCmdSeq = 0;
/** cmdId -> { onResult, timerId } */
const pendingClientAcks = new Map();

function clearAllPendingClientAcks(rejectWithFalse, code = 'disconnected') {
  pendingClientAcks.forEach(({ onResult, timerId }) => {
    clearTimeout(timerId);
    if (rejectWithFalse && typeof onResult === 'function') {
      try { onResult(false, code); } catch (_) { /* ignore */ }
    }
  });
  pendingClientAcks.clear();
}

function fulfillClientAck(cmdId, ok, code) {
  const p = pendingClientAcks.get(cmdId);
  if (!p) return;
  clearTimeout(p.timerId);
  pendingClientAcks.delete(cmdId);
  if (typeof p.onResult === 'function') {
    try { p.onResult(!!ok, code); } catch (e) { console.error(e); }
  }
}

/** Human-readable text for host failure codes (and local client errors). */
export function commandFailureMessage(code) {
  const M = {
    unknown_building: 'Unknown building type.',
    no_player: 'Invalid player.',
    no_credits: 'Not enough credits.',
    no_hq: 'You need an HQ before placing structures.',
    too_far_from_hq: 'Too far from your HQ — build closer to base.',
    overlap_building: 'Overlaps another structure.',
    on_resource: 'Cannot build on a resource field.',
    out_of_bounds: 'Outside the buildable map area.',
    no_units: 'No valid units in that order.',
    invalid_target: 'Target is gone or invalid.',
    friendly_target: 'Cannot attack allies on your team.',
    not_owner: "You don't control that.",
    invalid_building: 'That building is unavailable.',
    not_constructed: 'Building is not finished yet.',
    cant_produce_here: 'This structure cannot train that unit.',
    invalid_unit_type: 'Unknown unit type.',
    unit_cap: 'Unit population cap reached.',
    not_in_queue: 'That unit is not in the production queue.',
    placement_failed: 'Could not place building.',
    unknown_action: 'Unknown command.',
    disconnected: 'Disconnected from host.',
    lobby_full: 'Lobby is full.',
    timeout: 'No response from host — try again.',
    network: 'Not connected to host.',
    send_failed: 'Failed to send command.',
  };
  if (!code) return 'Command failed.';
  return M[code] || 'Command failed.';
}

export function initNetwork() {
  // Nothing to initialize until host/join
}

function setLobbyMenuStatus(text) {
  const el = document.getElementById('menu-status');
  if (el) el.textContent = text;
  const vr = document.getElementById('menu-status-vr');
  if (vr && typeof vr.setAttribute === 'function') {
    vr.setAttribute('value', text);
  }
}

// --- HOST ---
export async function startHosting() {
  if (State.gameSession.isMultiplayer) return;

  const sessionID = `rtsvr2-host-${lobbyNumber}-${Date.now().toString(36)}`;

  try {
    peer = new Peer(sessionID, {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
    });

    peer.on('open', () => {
      State.gameSession.isMultiplayer = true;
      State.gameSession.isHost = true;
      console.log(`✅ Hosting as ${sessionID}`);

      setLobbyMenuStatus(`Hosting Lobby ${lobbyNumber} — Share code: ${sessionID}`);
    });

    peer.on('connection', conn => {
      conn.on('open', () => {
        let assignedId = null;
        for (let i = 1; i < 4; i++) {
          if (!connections.has(i)) {
            assignedId = i;
            break;
          }
        }

        if (assignedId === null) {
          try {
            conn.send({ type: 'lobby-full' });
          } catch (_) { /* ignore */ }
          conn.close();
          console.warn('Lobby full — connection rejected');
          return;
        }

        connections.set(assignedId, conn);
        State.players[assignedId].isHuman = true;
        State.players[assignedId].isBot = false;

        conn.send({
          type: 'player-assignment',
          playerId: assignedId,
        });

        broadcastData({
          type: 'player-joined',
          playerId: assignedId,
        });

        console.log(`✅ Player ${assignedId} connected`);

        conn.on('data', data => handleClientData(data, assignedId));

        conn.on('close', () => {
          connections.delete(assignedId);
          State.players[assignedId].isHuman = false;
          State.players[assignedId].isBot = true;
          console.log(`❌ Player ${assignedId} disconnected`);
        });
      });
    });

    peer.on('error', err => {
      console.error('Host error:', err);
      setLobbyMenuStatus(`Network error (host): ${err?.message || err || 'unknown'}`);
    });
  } catch (err) {
    console.error('Failed to host:', err);
  }
}

// --- CLIENT ---
export async function joinGame(hostId) {
  if (State.gameSession.isMultiplayer) return;

  const clientId = `rtsvr2-client-${Date.now().toString(36)}`;

  try {
    peer = new Peer(clientId, {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
    });

    peer.on('open', () => {
      const conn = peer.connect(hostId);

      conn.on('open', () => {
        State.gameSession.isMultiplayer = true;
        State.gameSession.isHost = false;
        connections.set('host', conn);
        console.log(`✅ Connected to host: ${hostId}`);

        conn.on('data', data => handleHostData(data));

        conn.on('close', () => {
          console.log('❌ Disconnected from host');
          clearAllPendingClientAcks(true, 'disconnected');
          State.gameSession.isMultiplayer = false;
          State.gameSession.isHost = false;
          connections.delete('host');
          const hud = document.getElementById('hud-status');
          if (hud) hud.textContent = 'Disconnected from host.';
        });
      });

      conn.on('error', err => {
        console.error('Connection error:', err);
      });
    });

    peer.on('error', err => {
      console.error('Join error:', err);
      setLobbyMenuStatus(`Could not connect: ${err?.message || err || 'unknown'}`);
    });
  } catch (err) {
    console.error('Failed to join:', err);
  }
}

// --- HOST: Handle client commands ---
function handleClientData(data, fromPlayerId) {
  if (fromPlayerId == null) return;
  if (data?.type === 'command') {
    const result = executeCommand(data, fromPlayerId);
    const cmdId = data.cmdId;
    if (cmdId != null) {
      const conn = connections.get(fromPlayerId);
      if (conn?.open) {
        try {
          conn.send({
            type: 'command-result',
            cmdId,
            ok: result.ok,
            code: result.code ?? undefined,
          });
        } catch (_) { /* ignore */ }
      }
    }
  }
}

// --- CLIENT: Handle server snapshots ---
function handleHostData(data) {
  switch (data.type) {
    case 'player-assignment':
      State.gameSession.myPlayerId = data.playerId;
      console.log(`Assigned player ${data.playerId}`);
      break;

    case 'snapshot':
      applySnapshot(data.snapshot);
      break;

    case 'game-start':
      State.gameSession.gameStarted = true;
      State.gameSession.menuOpen = false;
      State.deselectAll();
      State.gameSession.buildMode = null;
      {
        const b = document.getElementById('build-placement-banner');
        if (b) b.style.display = 'none';
        document.body.style.cursor = '';
      }
      import('./ui.js').then(m => m.updateMenuVisibility()).catch(() => {});
      break;

    case 'player-joined':
      console.log(`Player ${data.playerId} joined`);
      break;

    case 'lobby-full': {
      clearAllPendingClientAcks(true, 'lobby_full');
      State.gameSession.isMultiplayer = false;
      State.gameSession.isHost = false;
      connections.delete('host');
      setLobbyMenuStatus('Lobby is full. Try another host or start your own.');
      console.warn('Could not join: lobby full');
      break;
    }

    case 'command-result':
      if (data.cmdId != null) fulfillClientAck(data.cmdId, data.ok, data.code);
      break;
  }
}

function filterUnitsOwned(playerId, unitIds) {
  if (!Array.isArray(unitIds)) return [];
  return unitIds.filter(id => {
    const u = State.units.get(id);
    return u && u.ownerId === playerId && u.hp > 0;
  });
}

/** Host-authoritative execution; returns { ok, code? }. */
function executeCommand(data, actingPlayerId) {
  switch (data.action) {
    case 'move': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds);
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      Units.commandMove(ids, data.x, data.z);
      return { ok: true };
    }
    case 'attack': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds);
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      const target = State.units.get(data.targetId);
      if (!target || target.hp <= 0) return { ok: false, code: 'invalid_target' };
      const actor = State.players[actingPlayerId];
      if (!actor) return { ok: false, code: 'no_player' };
      if (target.team === actor.team) return { ok: false, code: 'friendly_target' };
      Units.commandAttackUnit(ids, data.targetId);
      return { ok: true };
    }
    case 'attackBuilding': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds);
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      const target = State.buildings.get(data.targetId);
      if (!target || target.hp <= 0) return { ok: false, code: 'invalid_target' };
      const actor = State.players[actingPlayerId];
      const owner = State.players[target.ownerId];
      if (!actor) return { ok: false, code: 'no_player' };
      if (owner && owner.team === actor.team) {
        return { ok: false, code: 'friendly_target' };
      }
      Units.commandAttackBuilding(ids, data.targetId);
      return { ok: true };
    }
    case 'follow': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds);
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      const target = State.units.get(data.targetId);
      if (!target || target.hp <= 0) return { ok: false, code: 'invalid_target' };
      Units.commandFollow(ids, data.targetId);
      return { ok: true };
    }
    case 'stop': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds);
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      Units.commandStop(ids);
      return { ok: true };
    }
    case 'build': {
      const fail = Buildings.getPlaceBuildingFailureCode(
        data.buildingType,
        actingPlayerId,
        data.x,
        data.z
      );
      if (fail) return { ok: false, code: fail };
      const placed = Buildings.placeBuilding(data.buildingType, actingPlayerId, data.x, data.z);
      if (!placed) return { ok: false, code: 'placement_failed' };
      return { ok: true };
    }
    case 'produce': {
      const b = State.buildings.get(data.buildingId);
      if (!b || b.ownerId !== actingPlayerId) return { ok: false, code: 'not_owner' };
      const fail = Buildings.getQueueUnitFailureCode(data.buildingId, data.unitType);
      if (fail) return { ok: false, code: fail };
      Buildings.queueUnit(data.buildingId, data.unitType);
      return { ok: true };
    }
    case 'cancelProduce': {
      const b = State.buildings.get(data.buildingId);
      if (!b || b.ownerId !== actingPlayerId) return { ok: false, code: 'not_owner' };
      const fail = Buildings.getCancelUnitFailureCode(data.buildingId, data.unitType);
      if (fail) return { ok: false, code: fail };
      Buildings.cancelUnit(data.buildingId, data.unitType);
      return { ok: true };
    }
    default:
      return { ok: false, code: 'unknown_action' };
  }
}

/**
 * Runs locally (single-player or host). Multiplayer client sends to host.
 * Returns boolean: local/host = success; client without onResult = message sent.
 * Optional onResult(ok, code?): code is a stable failure id when ok is false.
 */
export function sendCommand(command, onResult) {
  const me = State.gameSession.myPlayerId;

  const runLocal = () => {
    const r = executeCommand(command, me);
    if (typeof onResult === 'function') onResult(r.ok, r.code);
    return r.ok;
  };

  if (!State.gameSession.isMultiplayer) {
    return runLocal();
  }
  if (State.gameSession.isHost) {
    return runLocal();
  }

  const conn = connections.get('host');
  if (!conn?.open) {
    if (typeof onResult === 'function') onResult(false, 'network');
    return false;
  }

  if (typeof onResult === 'function') {
    const cmdId = ++clientCmdSeq;
    const timerId = setTimeout(() => fulfillClientAck(cmdId, false, 'timeout'), NET_CLIENT_CMD_TIMEOUT_MS);
    pendingClientAcks.set(cmdId, { onResult, timerId });
    try {
      conn.send({ type: 'command', ...command, cmdId });
    } catch (err) {
      clearTimeout(timerId);
      pendingClientAcks.delete(cmdId);
      onResult(false, 'send_failed');
      return false;
    }
    return true;
  }

  try {
    conn.send({ type: 'command', ...command });
    return true;
  } catch (_) {
    return false;
  }
}

// --- Broadcast (host only) ---
export function broadcastData(data) {
  if (!State.gameSession.isHost) return;
  connections.forEach(conn => {
    if (conn.open) conn.send(data);
  });
}

// --- State snapshot (host sends periodically) ---
export function updateNetwork(time) {
  if (!State.gameSession.isMultiplayer || !State.gameSession.isHost) return;
  if (!State.gameSession.gameStarted) return;

  // Send snapshots at configured rate
  if (time - lastSnapshotTime < (1000 / NET_SNAPSHOT_RATE)) return;
  lastSnapshotTime = time;

  const snapshot = {
    time: State.gameSession.elapsedTime,
    gameOver: State.gameSession.gameOver,
    winner: State.gameSession.winner,
    units: [],
    buildings: [],
    players: State.players.map(p => ({
      credits: p.credits,
      income: p.income,
      isDefeated: p.isDefeated,
    })),
  };

  State.units.forEach(u => {
    snapshot.units.push({
      id: u.id, type: u.type, ownerId: u.ownerId,
      x: u.x, z: u.z, hp: u.hp, state: u.state,
      rotation: u.rotation,
    });
  });

  State.buildings.forEach(b => {
    snapshot.buildings.push({
      id: b.id, type: b.type, ownerId: b.ownerId,
      x: b.x, z: b.z, hp: b.hp,
      constructionProgress: b.constructionProgress,
      isBuilt: b.isBuilt,
      captureProgress: b.captureProgress || 0,
    });
  });

  broadcastData({ type: 'snapshot', snapshot });
}

// --- Apply snapshot (client-side) ---
function applySnapshot(snapshot) {
  snapshot.players.forEach((pData, i) => {
    if (State.players[i]) {
      State.players[i].credits = pData.credits;
      State.players[i].income = pData.income;
      State.players[i].isDefeated = pData.isDefeated;
    }
  });

  const unitIdsInSnap = new Set(snapshot.units.map(u => u.id));
  const unitsToRemove = [];
  State.units.forEach((u, id) => {
    if (!unitIdsInSnap.has(id)) unitsToRemove.push(id);
  });
  unitsToRemove.forEach(id => State.removeUnit(id));

  snapshot.units.forEach(uData => {
    let unit = State.units.get(uData.id);
    if (!unit) {
      unit = Units.createUnit(uData.type, uData.ownerId, uData.x, uData.z, {
        id: uData.id,
        skipCapCheck: true,
        skipProducedStat: true,
      });
    }
    if (unit) {
      unit.x += (uData.x - unit.x) * 0.3;
      unit.z += (uData.z - unit.z) * 0.3;
      unit.hp = uData.hp;
      unit.state = uData.state;
      unit.rotation = uData.rotation;
    }
  });

  const bIdsInSnap = new Set(snapshot.buildings.map(b => b.id));
  let navDirty = false;
  const buildingsToRemove = [];
  State.buildings.forEach((b, id) => {
    if (!bIdsInSnap.has(id)) {
      buildingsToRemove.push(id);
      if (b.type !== 'hq') navDirty = true;
    }
  });
  buildingsToRemove.forEach(id => State.removeBuilding(id));

  snapshot.buildings.forEach(bData => {
    let building = State.buildings.get(bData.id);
    if (!building) {
      Buildings.createBuilding(bData.type, bData.ownerId, bData.x, bData.z, {
        id: bData.id,
        skipNavRebuild: true,
      });
      if (bData.type !== 'hq') navDirty = true;
      building = State.buildings.get(bData.id);
    }
    if (building) {
      building.hp = bData.hp;
      building.constructionProgress = bData.constructionProgress;
      building.isBuilt = bData.isBuilt;
      building.captureProgress = bData.captureProgress ?? 0;
    }
  });

  if (navDirty) Pathfinding.rebuildNavMesh();

  State.syncUnitCountsFromUnits();

  State.gameSession.elapsedTime = snapshot.time;
  if (snapshot.gameOver !== undefined) {
    State.gameSession.gameOver = snapshot.gameOver;
  }
  if (snapshot.winner !== undefined) {
    State.gameSession.winner = snapshot.winner;
  }
}
