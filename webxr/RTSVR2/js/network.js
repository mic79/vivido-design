// ========================================
// RTSVR2 — Network System
// PeerJS host-authoritative state sync
// ========================================

import * as State from './state.js';
import * as Units from './units.js';
import * as Buildings from './buildings.js';
import * as Pathfinding from './pathfinding.js';
import * as Fog from './fog.js';
import * as Renderer from './renderer.js';
import * as Audio from './audio.js';
import * as Effects from './effects.js';
import * as Resources from './resources.js';
import { NET_SNAPSHOT_RATE, NET_CLIENT_CMD_TIMEOUT_MS } from './config.js';

/** Multiplayer client: last applied player team row from host (lobby defaults differ from match). */
let lastClientPlayerTeamSig = '';

let peer = null;
const connections = new Map(); // playerId -> connection

/** BattleVR-style: host id is `rtsvr2-host-{N}` so joiners only pick lobby 1–4 (no pasted PeerJS id). */
export const MAX_LOBBIES = 4;
let selectedLobby = 1;
let lastSnapshotTime = 0;

function hostSessionId() {
  return `rtsvr2-host-${selectedLobby}`;
}

function teardownPeerOnly() {
  clearAllPendingClientAcks(true, 'disconnected');
  connections.forEach(c => {
    try {
      c.close();
    } catch (_) { /* ignore */ }
  });
  connections.clear();
  if (peer) {
    try {
      peer.destroy();
    } catch (_) { /* ignore */ }
    peer = null;
  }
}

export function getSelectedLobby() {
  return selectedLobby;
}

export function adjustLobby(delta) {
  selectedLobby = Math.max(1, Math.min(MAX_LOBBIES, selectedLobby + delta));
  refreshLobbyDisplay();
}

export function refreshLobbyDisplay() {
  const el = document.getElementById('menu-lobby-num');
  if (el) el.textContent = String(selectedLobby);
  const vr = document.getElementById('menu-lobby-vr');
  if (vr && typeof vr.setAttribute === 'function') {
    vr.setAttribute('value', `Lobby ${selectedLobby}`);
  }
}

/** Host only: numeric player ids (1–3) with an open PeerJS data connection. */
export function getConnectedRemotePlayerIds() {
  const out = [];
  connections.forEach((conn, id) => {
    if (typeof id === 'number' && id >= 1 && id <= 3 && conn && conn.open) out.push(id);
  });
  return out.sort((a, b) => a - b);
}

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
    no_harvesters: 'Select harvesters to assign a crystal.',
    invalid_field: 'That crystal is gone or empty.',
    field_not_visible: 'You have not explored that crystal yet.',
    no_refinery: 'Build a refinery before harvesting.',
    deployment_blocked: 'Cannot deploy HQ here (overlap, crystal, or map edge).',
  };
  if (!code) return 'Command failed.';
  return M[code] || 'Command failed.';
}

export function initNetwork() {
  refreshLobbyDisplay();
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

  teardownPeerOnly();

  const sessionID = hostSessionId();

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

      setLobbyMenuStatus(
        `Hosting lobby ${selectedLobby} — friends: same lobby number, then Join`
      );
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
      const t = err?.type || '';
      if (t === 'unavailable-id' || t === 'invalid-id') {
        setLobbyMenuStatus(
          `Lobby ${selectedLobby} id is in use — change lobby (− / +) and Host again`
        );
      } else {
        setLobbyMenuStatus(`Network error (host): ${err?.message || err || 'unknown'}`);
      }
      teardownPeerOnly();
      State.gameSession.isMultiplayer = false;
      State.gameSession.isHost = false;
    });
  } catch (err) {
    console.error('Failed to host:', err);
  }
}

// --- CLIENT ---
const JOIN_OPEN_MS = 14000;

export async function joinGame() {
  if (State.gameSession.isMultiplayer) return;

  teardownPeerOnly();

  const hostId = hostSessionId();
  const clientId = `rtsvr2-client-${Date.now().toString(36)}`;

  try {
    peer = new Peer(clientId, {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
    });

    peer.on('open', () => {
      setLobbyMenuStatus(`Connecting to lobby ${selectedLobby}…`);
      const conn = peer.connect(hostId);
      let settled = false;
      let openTimer = null;

      const failJoin = (msg) => {
        if (settled) return;
        settled = true;
        if (openTimer) clearTimeout(openTimer);
        setLobbyMenuStatus(msg);
        teardownPeerOnly();
        State.gameSession.isMultiplayer = false;
        State.gameSession.isHost = false;
      };

      openTimer = setTimeout(() => {
        failJoin(
          `No host answered in lobby ${selectedLobby}. Pick the same number as the host, or wait for them to Host.`
        );
      }, JOIN_OPEN_MS);

      conn.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        State.gameSession.isMultiplayer = true;
        State.gameSession.isHost = false;
        connections.set('host', conn);
        console.log(`✅ Connected to host: ${hostId}`);

        setLobbyMenuStatus(`Connected — lobby ${selectedLobby}`);

        conn.on('data', data => handleHostData(data));

        conn.on('close', () => {
          console.log('❌ Disconnected from host');
          lastClientPlayerTeamSig = '';
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
        failJoin(`Could not open data channel: ${err?.message || err || 'unknown'}`);
      });
    });

    peer.on('error', err => {
      console.error('Join error:', err);
      setLobbyMenuStatus(`Could not connect: ${err?.message || err || 'unknown'}`);
      teardownPeerOnly();
      State.gameSession.isMultiplayer = false;
      State.gameSession.isHost = false;
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
      lastClientPlayerTeamSig = '';
      State.gameSession.gameStarted = true;
      State.gameSession.menuOpen = false;
      State.deselectAll();
      State.clearBuildPlacementFlags();
      {
        const b = document.getElementById('build-placement-banner');
        if (b) b.style.display = 'none';
        document.body.style.cursor = '';
      }
      import('./input.js')
        .then(m => {
          if (typeof m.positionCameraForPlayer === 'function') {
            m.positionCameraForPlayer(State.gameSession.myPlayerId);
          }
        })
        .catch(() => {});
      import('./ui.js')
        .then(async m => {
          m.updateMenuVisibility();
          try {
            const inp = await import('./input.js');
            if (typeof inp.getInputPlatform === 'function' && inp.getInputPlatform() === 'touch') {
              m.setMinimapVisible(true);
            }
          } catch (_) {
            /* ignore */
          }
        })
        .catch(() => {});
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
    case 'deployMobileHq': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds).filter(id => {
        const u = State.units.get(id);
        return u && u.type === 'mobileHq';
      });
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      let n = 0;
      for (let i = 0; i < ids.length; i++) {
        const u = State.units.get(ids[i]);
        if (u && Buildings.tryDeployMobileHq(u)) n++;
      }
      if (n === 0) return { ok: false, code: 'deployment_blocked' };
      return { ok: true };
    }
    case 'harvestField': {
      const field = State.resourceFields.get(data.fieldId);
      if (!field || field.depleted) return { ok: false, code: 'invalid_field' };
      const actor = State.players[actingPlayerId];
      if (!actor) return { ok: false, code: 'no_player' };
      if (!Fog.wasExploredByTeam(actor.team, field.x, field.z)) {
        return { ok: false, code: 'field_not_visible' };
      }
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds).filter(id => {
        const u = State.units.get(id);
        return u && u.type === 'harvester';
      });
      if (ids.length === 0) return { ok: false, code: 'no_harvesters' };
      let okCount = 0;
      for (let i = 0; i < ids.length; i++) {
        const u = State.units.get(ids[i]);
        if (Resources.assignHarvesterToField(u, field.id)) okCount++;
      }
      if (okCount === 0) return { ok: false, code: 'no_refinery' };
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
    fx: State.takeHostFxForSnapshot(),
    units: [],
    buildings: [],
    players: State.players.map(p => ({
      credits: p.credits,
      income: p.income,
      isDefeated: p.isDefeated,
      team: p.team,
      stats: p.stats
        ? {
            unitsProduced: p.stats.unitsProduced,
            unitsLost: p.stats.unitsLost,
            kills: p.stats.kills,
            buildingsBuilt: p.stats.buildingsBuilt,
            buildingsLost: p.stats.buildingsLost,
            creditsEarned: p.stats.creditsEarned,
          }
        : undefined,
    })),
    resourceFields: [],
  };

  State.resourceFields.forEach(f => {
    snapshot.resourceFields.push({
      id: f.id,
      remaining: f.remaining,
      depleted: !!f.depleted,
    });
  });

  State.units.forEach(u => {
    snapshot.units.push({
      id: u.id,
      type: u.type,
      ownerId: u.ownerId,
      team: u.team,
      x: u.x,
      z: u.z,
      hp: u.hp,
      maxHp: u.maxHp,
      state: u.state,
      rotation: u.rotation,
      lastFireTime: u.lastFireTime,
      playerCommanded: !!u.playerCommanded,
      targetUnitId: u.targetUnitId ?? null,
      followLeadId: u.followLeadId ?? null,
      squadOffsetX: u.squadOffsetX ?? 0,
      squadOffsetZ: u.squadOffsetZ ?? 0,
      targetBuildingId: u.targetBuildingId ?? null,
      targetPos: u.targetPos ? { x: u.targetPos.x, z: u.targetPos.z } : null,
      guardPos: u.guardPos ? { x: u.guardPos.x, z: u.guardPos.z } : null,
      cargo: u.cargo,
      assignedRefinery: u.assignedRefinery ?? null,
      assignedField: u.assignedField ?? null,
      lastHarvestedField: u.lastHarvestedField ?? null,
    });
  });

  State.buildings.forEach(b => {
    snapshot.buildings.push({
      id: b.id,
      type: b.type,
      ownerId: b.ownerId,
      team: b.team,
      x: b.x,
      z: b.z,
      hp: b.hp,
      maxHp: b.maxHp,
      constructionProgress: b.constructionProgress,
      isBuilt: b.isBuilt,
      captureProgress: b.captureProgress || 0,
      rallyPoint: b.rallyPoint ? { x: b.rallyPoint.x, z: b.rallyPoint.z } : null,
      productionQueue: (b.productionQueue || []).map(q => ({
        unitType: q.unitType,
        remainingTime: q.remainingTime,
        totalTime: q.totalTime,
      })),
    });
  });

  broadcastData({ type: 'snapshot', snapshot });
}

/** Multiplayer client: replay host-authored visuals/sfx (no gameplay side effects). */
function applyHostFxEventsForClient(fxList) {
  for (const ev of fxList) {
    if (!ev || !ev.kind) continue;
    switch (ev.kind) {
      case 'shot': {
        const dur = typeof ev.duration === 'number' ? ev.duration : 200;
        const ty = typeof ev.ty === 'number' ? ev.ty : 0.8;
        Renderer.spawnProjectile(
          ev.x, 1.2, ev.z,
          ev.tx, ty, ev.tz,
          typeof ev.color === 'number' ? ev.color : 0xffffff,
          dur
        );
        if (ev.unitType) Audio.playShotSound(ev.unitType);
        break;
      }
      case 'unit_death': {
        const n = typeof ev.particles === 'number' ? ev.particles : 8;
        Effects.spawnExplosion(ev.x, 0.5, ev.z, n);
        Audio.playExplosionSound(typeof ev.volume === 'number' ? ev.volume : 0.3);
        break;
      }
      case 'building_death': {
        Effects.spawnExplosion(ev.x, 0.5, ev.z, 12);
        Audio.playExplosionSound(typeof ev.volume === 'number' ? ev.volume : 0.5);
        break;
      }
      case 'aoe_impact':
        Effects.spawnExplosion(ev.x, 0.5, ev.z, typeof ev.count === 'number' ? ev.count : 8);
        break;
      case 'build_complete':
        Audio.playBuildCompleteSound();
        break;
      case 'unit_ready':
        Audio.playUnitReadySound();
        break;
      case 'capture_tick':
        Audio.playCaptureTickSound();
        break;
      case 'capture_complete':
        Audio.playUnitReadySound();
        break;
      default:
        break;
    }
  }
}

// --- Apply snapshot (client-side) ---
function applySnapshot(snapshot) {
  const isNetClient = State.gameSession.isMultiplayer && !State.gameSession.isHost;

  let teamSig = '';
  snapshot.players.forEach((pData, i) => {
    const p = State.players[i];
    if (!p) return;
    p.credits = pData.credits;
    p.income = pData.income;
    p.isDefeated = pData.isDefeated;
    if (pData.team !== undefined) p.team = pData.team;
    if (pData.stats) {
      Object.assign(p.stats, pData.stats);
    }
    teamSig += `${p.team},`;
  });

  if (Array.isArray(snapshot.resourceFields)) {
    snapshot.resourceFields.forEach(rf => {
      const field = State.resourceFields.get(rf.id);
      if (!field) return;
      if (rf.remaining !== undefined) field.remaining = rf.remaining;
      if (rf.depleted !== undefined) field.depleted = rf.depleted;
    });
  }

  if (isNetClient && teamSig && teamSig !== lastClientPlayerTeamSig) {
    lastClientPlayerTeamSig = teamSig;
    Fog.initFog();
  }

  if (isNetClient && Array.isArray(snapshot.fx)) {
    applyHostFxEventsForClient(snapshot.fx);
  }

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
        team: uData.team,
      });
    }
    if (unit) {
      if (uData.team !== undefined && unit.team !== uData.team) {
        const oldT = unit.team;
        const oldSet = State.unitsByTeam.get(oldT);
        if (oldSet) oldSet.delete(unit.id);
        unit.team = uData.team;
        if (!State.unitsByTeam.has(unit.team)) State.unitsByTeam.set(unit.team, new Set());
        State.unitsByTeam.get(unit.team).add(unit.id);
      } else if (uData.team !== undefined) {
        unit.team = uData.team;
      }
      unit.x += (uData.x - unit.x) * 0.3;
      unit.z += (uData.z - unit.z) * 0.3;
      unit.hp = uData.hp;
      if (uData.maxHp !== undefined) unit.maxHp = uData.maxHp;
      unit.state = uData.state;
      unit.rotation = uData.rotation;
      if (uData.lastFireTime !== undefined) unit.lastFireTime = uData.lastFireTime;
      unit.playerCommanded = !!uData.playerCommanded;
      unit.targetUnitId = uData.targetUnitId != null ? uData.targetUnitId : null;
      unit.followLeadId = uData.followLeadId != null ? uData.followLeadId : null;
      unit.squadOffsetX = uData.squadOffsetX != null ? uData.squadOffsetX : 0;
      unit.squadOffsetZ = uData.squadOffsetZ != null ? uData.squadOffsetZ : 0;
      unit.targetBuildingId = uData.targetBuildingId != null ? uData.targetBuildingId : null;
      unit.targetPos = uData.targetPos ? { x: uData.targetPos.x, z: uData.targetPos.z } : null;
      unit.guardPos = uData.guardPos ? { x: uData.guardPos.x, z: uData.guardPos.z } : null;
      if (uData.cargo !== undefined) unit.cargo = uData.cargo;
      unit.assignedRefinery = uData.assignedRefinery != null ? uData.assignedRefinery : null;
      unit.assignedField = uData.assignedField != null ? uData.assignedField : null;
      unit.lastHarvestedField = uData.lastHarvestedField != null ? uData.lastHarvestedField : null;
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
        team: bData.team,
      });
      if (bData.type !== 'hq') navDirty = true;
      building = State.buildings.get(bData.id);
    }
    if (building) {
      if (bData.ownerId !== undefined && building.ownerId !== bData.ownerId) {
        const oldSet = State.buildingsByPlayer.get(building.ownerId);
        if (oldSet) oldSet.delete(building.id);
        building.ownerId = bData.ownerId;
        if (!State.buildingsByPlayer.has(building.ownerId)) {
          State.buildingsByPlayer.set(building.ownerId, new Set());
        }
        State.buildingsByPlayer.get(building.ownerId).add(building.id);
      } else if (bData.ownerId !== undefined) {
        building.ownerId = bData.ownerId;
      }
      if (bData.team !== undefined) building.team = bData.team;
      building.hp = bData.hp;
      if (bData.maxHp !== undefined) building.maxHp = bData.maxHp;
      if (bData.rallyPoint) {
        building.rallyPoint = { x: bData.rallyPoint.x, z: bData.rallyPoint.z };
      }
      if (bData.constructionProgress !== undefined) {
        building.constructionProgress = bData.constructionProgress;
      }
      if (bData.isBuilt !== undefined) building.isBuilt = bData.isBuilt;
      building.captureProgress = bData.captureProgress ?? 0;
      if (Array.isArray(bData.productionQueue)) {
        building.productionQueue = bData.productionQueue.map(q => ({
          unitType: q.unitType,
          remainingTime: q.remainingTime,
          totalTime: q.totalTime,
        }));
      }
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
