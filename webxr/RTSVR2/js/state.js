// ========================================
// RTSVR2 — Game State
// Central state management for all game data
// ========================================

import {
  MAX_PLAYERS, STARTING_CREDITS, PASSIVE_INCOME_PER_SEC,
  PLAYER_COLORS, PLAYER_COLOR_HEX, PLAYER_TEAMS, SPAWN_POSITIONS,
  RESOURCE_FIELD_POSITIONS, RESOURCE_FIELD_CAPACITY, UNIT_CAP_PER_PLAYER,
} from './config.js';

// --- Unique ID generator ---
let nextId = 0;
export function generateId(prefix = 'obj') {
  return `${prefix}_${nextId++}`;
}
export function resetIds() { nextId = 0; }

// --- Player data ---
export const players = [];

export function initPlayers(humanIndices = [0], botIndices = [1, 2, 3]) {
  players.length = 0;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    players.push({
      id: i,
      name: `Player ${i + 1}`,
      color: PLAYER_COLORS[i],
      colorHex: PLAYER_COLOR_HEX[i],
      team: PLAYER_TEAMS[i],
      credits: STARTING_CREDITS,
      income: PASSIVE_INCOME_PER_SEC,
      isHuman: humanIndices.includes(i),
      isBot: botIndices.includes(i),
      isActive: true,
      isDefeated: false,
      spawn: SPAWN_POSITIONS[i],
      unitCount: 0,
      unitCap: UNIT_CAP_PER_PLAYER,
      // Bot AI state
      botState: 'SETUP',
      botMemory: {
        // Random personality variables (0.0 to 1.0)
        personality: {
          aggression: 0.6 + Math.random() * 0.4,      // Higher baseline aggression
          expansiveness: 0.5 + Math.random() * 0.5,   // Higher baseline expansiveness
          defensiveness: Math.random() * 0.4,         // Lower baseline defensiveness
          techPreference: 0.5 + Math.random() * 0.5,  // Favor vehicles
        },
        startDelayOffset: 2 + Math.random() * 4, // 2-6s start delay (fast!)
        
        discoveredResources: [],   // List of resource IDs the bot has physically seen
        targets: [],              // { id, type, x, z, priority, lastSeen }
        currentMissions: [],      // { type, targetId, unitIds, status, startedAt?, targetPos? }
        harassCooldownUntil: {}, // enemy harvester id -> game time when harass is allowed again
        scoutTargets: [],
        lastScoutTime: 0,
        lastBuildTime: 0,
        lastAttackTime: 0,
        armyRallyPoint: null,
        threatLevel: 0,           // 0-10 based on player strength
        dangerZones: [],          // [{x, z, time}] - places where scouts died recently
      },
      stats: {
        unitsProduced: 0,
        unitsLost: 0,
        kills: 0,
        buildingsBuilt: 0,
        buildingsLost: 0,
        creditsEarned: 0,
      },
    });
  }
}

// --- Units ---
export const units = new Map();       // id -> unit data
export const unitsByPlayer = new Map(); // playerId -> Set<unitId>
export const unitsByTeam = new Map();   // team -> Set<unitId>

export function addUnit(unit) {
  units.set(unit.id, unit);
  if (!unitsByPlayer.has(unit.ownerId)) unitsByPlayer.set(unit.ownerId, new Set());
  unitsByPlayer.get(unit.ownerId).add(unit.id);
  if (!unitsByTeam.has(unit.team)) unitsByTeam.set(unit.team, new Set());
  unitsByTeam.get(unit.team).add(unit.id);
  const player = players[unit.ownerId];
  if (player) player.unitCount++;
}

export function removeUnit(unitId) {
  const unit = units.get(unitId);
  if (!unit) return;
  units.delete(unitId);
  const playerUnits = unitsByPlayer.get(unit.ownerId);
  if (playerUnits) playerUnits.delete(unitId);
  const teamUnits = unitsByTeam.get(unit.team);
  if (teamUnits) teamUnits.delete(unitId);
  const player = players[unit.ownerId];
  if (player) player.unitCount--;
}

export function getPlayerUnits(playerId) {
  const ids = unitsByPlayer.get(playerId);
  if (!ids) return [];
  return Array.from(ids).map(id => units.get(id)).filter(Boolean);
}

export function getTeamUnits(team) {
  const ids = unitsByTeam.get(team);
  if (!ids) return [];
  return Array.from(ids).map(id => units.get(id)).filter(Boolean);
}

export function getEnemyUnits(team) {
  const results = [];
  unitsByTeam.forEach((ids, t) => {
    if (t !== team) {
      ids.forEach(id => {
        const u = units.get(id);
        if (u && u.hp > 0) results.push(u);
      });
    }
  });
  return results;
}

// --- Buildings ---
export const buildings = new Map(); // id -> building data
export const buildingsByPlayer = new Map();

export function addBuilding(building) {
  buildings.set(building.id, building);
  if (!buildingsByPlayer.has(building.ownerId)) buildingsByPlayer.set(building.ownerId, new Set());
  buildingsByPlayer.get(building.ownerId).add(building.id);
}

export function removeBuilding(buildingId) {
  const b = buildings.get(buildingId);
  if (!b) return;
  buildings.delete(buildingId);
  const playerBldgs = buildingsByPlayer.get(b.ownerId);
  if (playerBldgs) playerBldgs.delete(buildingId);
}

/** Keep buildingsByPlayer in sync when ownership changes (engineer capture, etc.). */
export function moveBuildingBetweenPlayers(buildingId, fromPlayerId, toPlayerId) {
  if (fromPlayerId === toPlayerId) return;
  const fromSet = buildingsByPlayer.get(fromPlayerId);
  if (fromSet) fromSet.delete(buildingId);
  if (!buildingsByPlayer.has(toPlayerId)) buildingsByPlayer.set(toPlayerId, new Set());
  buildingsByPlayer.get(toPlayerId).add(buildingId);
}

/** Recalculate unit counts from live units (e.g. after network snapshot). */
export function syncUnitCountsFromUnits() {
  players.forEach(p => { p.unitCount = 0; });
  units.forEach(u => {
    if (u.hp > 0 && players[u.ownerId]) {
      players[u.ownerId].unitCount++;
    }
  });
}

export function getPlayerBuildings(playerId) {
  const ids = buildingsByPlayer.get(playerId);
  if (!ids) return [];
  return Array.from(ids).map(id => buildings.get(id)).filter(Boolean);
}

/** Primary HQ: closest living HQ to this player's spawn (stable with multiple HQs). */
export function getPlayerHQ(playerId) {
  const hqs = getPlayerBuildings(playerId).filter(b => b.type === 'hq' && b.hp > 0);
  if (hqs.length === 0) return null;
  const player = players[playerId];
  const sx = player?.spawn?.x ?? 0;
  const sz = player?.spawn?.z ?? 0;
  let best = hqs[0];
  let bestD = Infinity;
  for (let i = 0; i < hqs.length; i++) {
    const b = hqs[i];
    const d = (b.x - sx) * (b.x - sx) + (b.z - sz) * (b.z - sz);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

export function getPlayerBuildingsOfType(playerId, type) {
  return getPlayerBuildings(playerId).filter(b => b.type === type && b.constructionProgress >= 1);
}

// --- Resource Fields ---
export const resourceFields = new Map(); // id -> field data

export function initResourceFields() {
  resourceFields.clear();
  RESOURCE_FIELD_POSITIONS.forEach((pos, i) => {
    const id = `resource_${i}`;
    resourceFields.set(id, {
      id,
      x: pos.x,
      z: pos.z,
      remaining: RESOURCE_FIELD_CAPACITY,
      maxCapacity: RESOURCE_FIELD_CAPACITY,
      depleted: false,
    });
  });
}

// --- Selection ---
export const selectedUnits = new Set();

export function selectUnit(unitId) {
  const unit = units.get(unitId);
  if (unit) {
    selectedUnits.add(unitId);
  }
}

export function deselectUnit(unitId) {
  selectedUnits.delete(unitId);
}

export function deselectAll() {
  selectedUnits.clear();
}

export function getSelectedUnits() {
  return Array.from(selectedUnits).map(id => units.get(id)).filter(Boolean);
}

// --- Game Session ---
export const gameSession = {
  myPlayerId: 0,
  gameStarted: false,
  gamePaused: false,
  gameOver: false,
  winner: -1,
  elapsedTime: 0,
  maxGameTime: 999 * 60, // 999 minutes (effective infinity)
  isMultiplayer: false,
  isHost: true,
  /** Until the player dismisses the first-run gate, only “Start” is shown (not the full lobby). */
  awaitingAppStart: true,
  menuOpen: true,
  buildMode: null,     // null or building type string
  /** When set, build-radius ring is centered on this HQ (second / Mobile HQ); cleared with buildMode. */
  buildModeHQId: null,
  buildGhostValid: false,
  buildGhostPos: { x: 0, z: 0 },
  debugFog: false,     // "Spy Mode" for observing AI
};

/** Batched into multiplayer snapshots so joiners hear/see the same SFX & particles as the host. */
export const pendingHostFx = [];

/** No-op unless this peer is the multiplayer host (solo clients never queue). */
export function pushHostFx(ev) {
  if (!gameSession.isMultiplayer || !gameSession.isHost) return;
  if (!ev || pendingHostFx.length >= 96) return;
  pendingHostFx.push(ev);
}

export function takeHostFxForSnapshot() {
  if (pendingHostFx.length === 0) return [];
  const out = pendingHostFx.slice();
  pendingHostFx.length = 0;
  return out;
}

/** Clears placement mode and which HQ owns the build ring (call whenever buildMode is cleared). */
export function clearBuildPlacementFlags() {
  gameSession.buildMode = null;
  gameSession.buildModeHQId = null;
}

// --- Reset all state ---
export function resetState() {
  resetIds();
  units.clear();
  unitsByPlayer.clear();
  unitsByTeam.clear();
  buildings.clear();
  buildingsByPlayer.clear();
  resourceFields.clear();
  selectedUnits.clear();
  gameSession.gameStarted = false;
  gameSession.gamePaused = false;
  gameSession.gameOver = false;
  gameSession.winner = -1;
  gameSession.elapsedTime = 0;
  gameSession.menuOpen = true;
  clearBuildPlacementFlags();
  pendingHostFx.length = 0;
}
