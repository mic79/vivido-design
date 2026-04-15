// ========================================
// RTSVR2 — Bot AI
// C&C-inspired state machine AI
// ========================================

import {
  BOT_TICK_RATE, BOT_DEFEND_RADIUS, BOT_SCOUT_DELAY,
  BOT_ATTACK_THRESHOLD, BOT_FULL_ATTACK_THRESHOLD,
  BOT_STRIKE_RESERVE_MULT, BOT_MAX_PRODUCTION_QUEUE, BOT_FOCUS_FIRE_INTERVAL,
  BOT_SCOUT_DELAY_ECON, BOT_SCOUT_CAP, BOT_SCOUT_CAP_ECON, BOT_SCOUT_GAP_ECON,
  BOT_SCOUT_REPATH_SEC, BOT_SCOUT_ARRIVE_RADIUS,
  BOT_SCOUT_DANGER_WEIGHT, BOT_SCOUT_DANGER_ZONE_TTL,
  BOT_DEFENSE_RELEASE_SCOUT_DIST,
  BOT_HARVESTER_EXPLORE_PER_TICK, BOT_HARVESTER_EXPLORE_THROTTLE_SEC,
  BOT_EXPLORE_MIN_SEP, BOT_EXPLORE_RESERVE_SEC, BOT_EXPLORE_SECTORS,
  BOT_HARVESTER_ESCORT_RADIUS, BOT_HARVESTER_ESCORT_MAX_UNITS, BOT_HARVESTER_ESCORT_COOLDOWN,
  BOT_BASE_VEHICLE_THREAT_RADIUS, BOT_HARVESTER_VEHICLE_THREAT_RADIUS, BOT_RETALIATION_FLANK_DIST,
  BOT_ECON_EXPAND_CREDITS, BOT_STOP_HARVESTER_AT_POP,
  BOT_SECOND_WARFACTORY_CREDITS, BOT_RETALIATION_ENEMY_MULT,
  BOT_HARASS_COOLDOWN_SEC, BOT_SCOUT_MISSION_MAX_SEC,
  BOT_MIN_HARVESTERS_BEFORE_SACRIFICE, BOT_HARVESTER_PER_REFINERY_TARGET,
  UNIT_TYPES, MAP_SIZE,
} from './config.js';
import * as State from './state.js';
import * as Units from './units.js';
import * as Buildings from './buildings.js';
import * as Fog from './fog.js';
import * as Pathfinding from './pathfinding.js';
import * as UI from './ui.js';
import { unitGrid } from './spatial.js';

let lastBotTick = 0;

export function updateBotAI(time, dt) {
  // Throttle bot decisions
  if (time - lastBotTick < (1000 / BOT_TICK_RATE)) return;
  lastBotTick = time;

  State.players.forEach(player => {
    if (!player.isBot || player.isDefeated) return;
    runBotLogic(player, time);
  });
}

function runBotLogic(player, time) {
  const pid = player.id;
  const hq = State.getPlayerHQ(pid);
  if (!hq || hq.hp <= 0) return;

  const mem = player.botMemory;
  const elapsed = State.gameSession.elapsedTime;
  
  // 0. Fair start delay (perception of human reaction time)
  if (elapsed < (mem.startDelayOffset || 10)) return;

  const myUnits = State.getPlayerUnits(pid);
  const myBuildings = State.getPlayerBuildings(pid);
  const combatUnits = myUnits.filter(u => u.type !== 'harvester' && u.type !== 'engineer' && u.hp > 0);
  const harvesters = myUnits.filter(u => u.type === 'harvester' && u.hp > 0);
  
  // 1. Fair Memory & Visibility
  updateBotVisibility(player, elapsed);
  updateDiscoveredResources(player);
  updateThreatLevel(player);
  player.botMemory.militaryEmergency = computeMilitaryEmergency(player, harvesters);

  // Exploration before rally/defense so scouts & harvesters are not overridden the same tick
  assignBotScoutMissions(player, combatUnits, elapsed);
  assignHarvesterExploration(player, harvesters, elapsed);

  // 2. INDUSTRIAL LOOP (Defense First, then Greed)
  performProductionLogic(player, myBuildings, combatUnits, elapsed);
  performEconomyLogic(player, myBuildings, harvesters, elapsed);

  // 3. DEFENSIVE CHECK
  let localThreats = getThreatsToBuildings(player, myBuildings);
  if (localThreats.length > 0) {
    handleDefense(player, combatUnits, localThreats);
  }

  // 4. MISSION CONTROL
  manageMissions(player, combatUnits, elapsed);
  doAttackMission(player, combatUnits, elapsed);
  tickRetaliationMissions(player);
  tickScoutMissions(player, elapsed);
  handleHarvesterDefense(player, combatUnits, harvesters, elapsed);
  maybeBotEngineerCapture(player, elapsed);
  applyBotFairFocusFire(player, elapsed);
}

function updateDiscoveredResources(player) {
  const mem = player.botMemory;
  mem.discoveredResources = mem.discoveredResources.filter(id => {
    const f = State.resourceFields.get(id);
    return f && !f.depleted;
  });
  State.resourceFields.forEach(field => {
    if (field.depleted) return;
    if (mem.discoveredResources.includes(field.id)) return;

    if (Fog.isVisibleToTeam(player.team, field.x, field.z)) {
      mem.discoveredResources.push(field.id);
      console.log(`🤖 P${player.id} just discovered resource field ${field.id}!`);
    }
  });
}

function performEconomyLogic(player, buildings, harvesters, elapsed) {
  const pid = player.id;
  const mem = player.botMemory;
  const personality = mem.personality;
  const credits = player.credits;

  const hasBarracks = buildings.some(b => b.type === 'barracks' && b.hp > 0);
  const hasRefinery = buildings.some(b => b.type === 'refinery' && b.hp > 0);
  const hasFactory = buildings.some(b => b.type === 'warFactory' && b.hp > 0);

  // Difficulty/Personality scaling for construction timing
  const expansionThreshold = BOT_ECON_EXPAND_CREDITS;
  const factoryThreshold = 800 - (personality.techPreference * 400); // 400 to 800 credits

  // Priority 1: Mandatory Infrastructure (Core Base)
  if (!hasBarracks && credits >= 300) {
    const pos = findBuildPosition(State.getPlayerHQ(pid), 10, 'barracks', pid);
    if (pos) Buildings.placeBuilding('barracks', pid, pos.x, pos.z);
    return;
  }

  if (!hasRefinery && credits >= 500) {
    const hq = State.getPlayerHQ(pid);
    let pos = null;
    if (hq) {
      pos = findMainBaseRefineryPosition(hq, pid, player.team);
      if (!pos) pos = findBuildPosition(hq, 15, 'refinery', pid);
    }
    if (pos) Buildings.placeBuilding('refinery', pid, pos.x, pos.z);
    return;
  }

  if (!hasFactory && credits >= factoryThreshold && hasRefinery) {
    const pos = findBuildPosition(State.getPlayerHQ(pid), 12, 'warFactory', pid);
    if (pos) Buildings.placeBuilding('warFactory', pid, pos.x, pos.z);
    return;
  }

  const builtRefineries = buildings.filter(b => b.type === 'refinery' && b.isBuilt);
  const globalHarvesterCap = 15;
  const currentHarvesters = harvesters.length;
  const unitCount = State.getPlayerUnits(pid).length;

  const isNearCap = unitCount >= BOT_STOP_HARVESTER_AT_POP;

  const militaryEmergency = mem.militaryEmergency;
  if (
    currentHarvesters < globalHarvesterCap &&
    credits >= 200 &&
    !isNearCap &&
    (!militaryEmergency || currentHarvesters < 1)
  ) {
    const ref = pickRefineryForNextHarvester(builtRefineries, harvesters);
    if (ref && ref.productionQueue.filter(q => q.unitType === 'harvester').length < (militaryEmergency ? 1 : 2)) {
      Buildings.queueUnit(ref.id, 'harvester');
    }
  }

  if (credits >= expansionThreshold && currentHarvesters >= 8 && builtRefineries.length < 3) {
    const unclaimedFieldId = mem.discoveredResources.find(id => {
      const field = State.resourceFields.get(id);
      if (!field || field.depleted) return false;
      const nearbyBldg = State.getPlayerBuildingsOfType(pid, 'refinery').some(r =>
        Pathfinding.getDistanceSq(r.x, r.z, field.x, field.z) < 400
      );
      return !nearbyBldg;
    });

    if (unclaimedFieldId) {
      const field = State.resourceFields.get(unclaimedFieldId);
      const pos = findExpansionRefineryPosition(field, pid);
      if (pos) Buildings.placeBuilding('refinery', pid, pos.x, pos.z);
    }
  }

  // Bonus: If very aggressive and has lots of cash, build a second War Factory
  const factories = buildings.filter(b => b.type === 'warFactory' && b.hp > 0);
  if (personality.aggression > 0.55 && factories.length < 2 && credits >= BOT_SECOND_WARFACTORY_CREDITS && hasRefinery) {
    const pos = findBuildPosition(State.getPlayerHQ(pid), 20, 'warFactory', pid);
    if (pos) Buildings.placeBuilding('warFactory', pid, pos.x, pos.z);
  }
}

function performProductionLogic(player, buildings, combatUnits, elapsed) {
  const mem = player.botMemory;
  const personality = mem.personality;
  let credits = player.credits;
  const enemyAnalysis = analyzeEnemyComposition(player);

  const hasRefinery = buildings.some(b => b.type === 'refinery' && b.hp > 0);
  const hasFactory = buildings.some(b => b.type === 'warFactory' && b.hp > 0);
  if (!hasRefinery && credits < 600) return;
  
  if (hasRefinery && !hasFactory && credits < 800) return;

  const maxQueue = Math.max(BOT_MAX_PRODUCTION_QUEUE, 1 + Math.floor(personality.aggression * 2));
  const producers = buildings.filter(b => b.isBuilt && b.productionQueue.length < maxQueue);
  producers.sort((a, b) => (a.type === 'warFactory' ? -1 : 1));

  let creditReservation = 0;

  let threatLv = mem.threatLevel || 0;
  if (mem.militaryEmergency) threatLv = Math.max(threatLv, 6);

  producers.forEach(b => {
    if (b.type === 'warFactory') {
      const type = pickCounterUnit(enemyAnalysis, 'vehicle', threatLv, credits, personality);
      const cost = UNIT_TYPES[type]?.cost || 0;

      const currentUnits = State.getPlayerUnits(player.id).length;
      const hvList = State.getPlayerUnits(player.id).filter(u => u.type === 'harvester' && u.hp > 0);
      if (
        currentUnits >= 30 &&
        credits >= cost &&
        hvList.length > BOT_MIN_HARVESTERS_BEFORE_SACRIFICE &&
        player.credits > 350
      ) {
        const victim = pickHarvesterToRetire(hvList);
        if (victim) {
          console.log(`🤖 P${player.id} retiring harvester ${victim.id} for army space (${type})`);
          Units.destroyUnit(victim);
        }
      }

      if (credits >= cost) {
        if (Buildings.queueUnit(b.id, type)) {
          credits -= cost;
        }
      } else {
        // RUTHLESS SAVING: If we want a tank but can't afford it, RESERVE the money.
        // This stops the Barracks from spending the money on Rocket Soldiers.
        creditReservation = cost;
      }
    } 
    else if (b.type === 'barracks') {
      const mySnipers = combatUnits.filter(u => u.type === 'sniper');
      const sniperCost = UNIT_TYPES.sniper.cost;
      const vsSnipers = (enemyAnalysis.types?.sniper || 0) > 0;
      const minSnipers =
        hasFactory
          ? 0
          : mem.militaryEmergency && (enemyAnalysis.vehicle > 0 || vsSnipers)
            ? 1
            : 3;

      if (!hasFactory && mySnipers.length < minSnipers) {
        if (credits >= sniperCost) {
          if (Buildings.queueUnit(b.id, 'sniper')) credits -= sniperCost;
        } else {
          creditReservation = sniperCost;
        }
      } else {
        let type = pickCounterUnit(enemyAnalysis, 'infantry', threatLv, credits, personality);
        if (mem.militaryEmergency && enemyAnalysis.vehicle > 0) type = 'rocketSoldier';
        const cost = UNIT_TYPES[type]?.cost || 0;
        if (credits - creditReservation >= cost) {
          if (Buildings.queueUnit(b.id, type)) credits -= cost;
        }
      }
    }
  });

  // Rally mechanism
  const hq = State.getPlayerHQ(player.id);
  const rallyDist = 15 + (personality.defensiveness * 20);
  const rallyPoint = { x: hq.x + (hq.x > 0 ? -rallyDist : rallyDist), z: hq.z + (hq.z > 0 ? -rallyDist : rallyDist) };
  const enemyHqT = mem.targets.find(t => {
    if (t.type !== 'building') return false;
    const b = State.buildings.get(t.id);
    return b && b.hp > 0 && b.type === 'hq';
  });
  if (enemyHqT) {
    const dx = hq.x - enemyHqT.x;
    const dz = hq.z - enemyHqT.z;
    const len = Math.hypot(dx, dz) || 1;
    const pull = 5 + personality.defensiveness * 12;
    rallyPoint.x += (dx / len) * pull;
    rallyPoint.z += (dz / len) * pull;
  }
  
  const econExplore = botNeedsPriorityResourceExploration(player);
  combatUnits.forEach(u => {
    const onMission = mem.currentMissions.some(m => m.unitIds.includes(u.id));
    if (u.state === 'idle' && !onMission) {
      if (econExplore && u.type === 'scoutBike') return;
      if (Pathfinding.getDistanceSq(u.x, u.z, rallyPoint.x, rallyPoint.z) > 100) {
        Units.commandAttackMove([u.id], rallyPoint.x, rallyPoint.z);
      }
    }
  });
}

function updateBotVisibility(player, elapsed) {
  const mem = player.botMemory;
  
  // Clean up old mobile targets that aren't visible
  mem.targets = mem.targets.filter(t => {
    if (t.type === 'building') return true; // Remember buildings
    const isVisibleNow = Fog.isVisibleToTeam(player.team, t.x, t.z);
    return isVisibleNow || (elapsed - t.lastSeen < 10); // Forget units quickly
  });

  // Scan for NEW enemies currently in vision of any bot unit
  State.units.forEach(u => {
    if (u.team === player.team || u.hp <= 0) return;
    if (Fog.isVisibleToTeam(player.team, u.x, u.z)) {
      upsertTarget(mem, u.id, u.category === 'vehicle' ? 'vehicle' : 'infantry', u.x, u.z, elapsed);
    }
  });

  State.buildings.forEach(b => {
    if (b.hp <= 0) return;
    const bPlayer = State.players[b.ownerId];
    if (bPlayer && bPlayer.team !== player.team) {
      if (Fog.isVisibleToTeam(player.team, b.x, b.z)) {
        upsertTarget(mem, b.id, 'building', b.x, b.z, elapsed);
      }
    }
  });
}

function upsertTarget(mem, id, type, x, z, time) {
  let t = mem.targets.find(target => target.id === id);
  if (t) {
    t.x = x; t.z = z; t.lastSeen = time;
  } else {
    mem.targets.push({ id, type, x, z, lastSeen: time, priority: (type === 'building' ? 10 : 5) });
  }
}

function updateThreatLevel(player) {
  let enemyCombatUnits = 0;
  const team = player.team;
  State.players.forEach(p => {
    if (p.team === team || p.isDefeated) return;
    State.getPlayerUnits(p.id).forEach(u => {
      if (u.damage > 0 && u.hp > 0 && Fog.isVisibleToTeam(team, u.x, u.z)) enemyCombatUnits++;
    });
  });
  player.botMemory.threatLevel = Math.min(10, Math.floor(enemyCombatUnits / 3));
}

function unitIsLongRangeThreat(u) {
  if (!u) return false;
  return (
    u.type === 'sniper' ||
    u.type === 'artillery' ||
    (UNIT_TYPES[u.type]?.range ?? 0) >= 22
  );
}

function dangerZoneIsLongRangeNest(dz) {
  if (dz.longRangeKiller) return true;
  const t = dz.threats?.types;
  if (!t) return false;
  return (t.sniper || 0) > 0 || (t.artillery || 0) > 0;
}

function canCounterLongRange(u) {
  if (!u || u.type === 'scoutBike') return false;
  return (
    u.category === 'vehicle' ||
    u.type === 'rocketSoldier' ||
    u.type === 'sniper'
  );
}

function retaliationFlankPos(hq, dz) {
  const dx = hq.x - dz.x;
  const dz_ = hq.z - dz.z;
  const len = Math.hypot(dx, dz_) || 1;
  const px = (-dz_ / len) * BOT_RETALIATION_FLANK_DIST;
  const pz = (dx / len) * BOT_RETALIATION_FLANK_DIST;
  return { x: dz.x + px, z: dz.z + pz };
}

function computeMilitaryEmergency(player, harvesters) {
  const pid = player.id;
  const team = player.team;
  const hq = State.getPlayerHQ(pid);
  if (!hq) return false;

  const R = BOT_BASE_VEHICLE_THREAT_RADIUS;
  const R2 = R * R;

  const nearStrategic = (x, z) => {
    if (Pathfinding.getDistanceSq(hq.x, hq.z, x, z) <= R2) return true;
    return State.getPlayerBuildingsOfType(pid, 'refinery').some(
      r => Pathfinding.getDistanceSq(r.x, r.z, x, z) <= R2
    );
  };

  let vehicleNearBase = false;
  State.units.forEach(u => {
    if (u.team === team || u.hp <= 0 || u.category !== 'vehicle' || u.damage <= 0) return;
    if (!Fog.isVisibleToTeam(team, u.x, u.z)) return;
    if (nearStrategic(u.x, u.z)) vehicleNearBase = true;
  });
  if (vehicleNearBase) return true;

  const HVR = BOT_HARVESTER_VEHICLE_THREAT_RADIUS;
  for (const h of harvesters) {
    if (h.hp <= 0) continue;
    const near = unitGrid.queryRadiusFiltered(h.x, h.z, HVR, e =>
      e.team !== team &&
      e.category === 'vehicle' &&
      e.damage > 0 &&
      Fog.isVisibleToTeam(team, e.x, e.z)
    );
    if (near.length > 0) return true;
  }

  return (player.botMemory.threatLevel || 0) >= 5;
}

// --- ATTACK: Send army wave ---
function getThreatsToBuildings(player, buildings) {
  const threats = [];
  buildings.forEach(b => {
    if (b.hp <= 0) return;
    const local = unitGrid.queryRadiusFiltered(
      b.x, b.z, BOT_DEFEND_RADIUS,
      e =>
        e.team !== player.team &&
        e.hp > 0 &&
        Fog.isVisibleToTeam(player.team, e.x, e.z)
    );
    local.forEach(t => {
      if (!threats.some(existing => existing.id === t.id)) threats.push(t);
    });
  });
  return threats;
}

function manageRetaliation(player, idleUnits) {
  const mem = player.botMemory;
  const elapsed = State.gameSession.elapsedTime;

  const hotZone = mem.dangerZones
    .slice()
    .reverse()
    .find(dz => {
      if (!dz.threats || (dz.threats.infantry === 0 && dz.threats.vehicle === 0)) return false;
      if (elapsed - dz.time > 300) return false;
      return !mem.currentMissions.some(m => m.type === 'retaliation' && m.targetId === dz.time);
    });

  if (!hotZone) return null;

  const enemyCount = hotZone.threats.infantry + hotZone.threats.vehicle;
  const requiredPower = Math.max(5, Math.ceil(enemyCount * BOT_RETALIATION_ENEMY_MULT));
  const longRangeNest = dangerZoneIsLongRangeNest(hotZone);
  const hq = State.getPlayerHQ(player.id);

  let missionUnits;
  let targetPos = { x: hotZone.x, z: hotZone.z };

  if (longRangeNest) {
    const capable = idleUnits.filter(u => canCounterLongRange(u));
    const need = Math.min(requiredPower + 2, Math.max(4, capable.length));
    if (capable.length < 3) return null;
    missionUnits = capable.slice(0, need);
    if (hq) targetPos = retaliationFlankPos(hq, hotZone);
  } else {
    const combatUnits = idleUnits.filter(u => u.type !== 'scoutBike');
    if (combatUnits.length < requiredPower) return null;
    missionUnits = combatUnits.slice(0, requiredPower + 2);
  }

  const mission = {
    type: 'retaliation',
    targetId: hotZone.time,
    targetPos,
    unitIds: missionUnits.map(u => u.id),
  };
  mem.currentMissions.push(mission);

  Units.commandAttackMove(mission.unitIds, targetPos.x, targetPos.z);
  console.log(
    `🤖 Bot P${player.id} RETALIATION → [${targetPos.x.toFixed(0)}, ${targetPos.z.toFixed(0)}] (${longRangeNest ? 'flank vs long-range' : 'direct'})`
  );
  return mission;
}

function manageMissions(player, combatUnits, elapsed) {
  const mem = player.botMemory;
  const personality = mem.personality;
  const pid = player.id;
  
  // Clean up finished missions (SCOUT / retaliation use targetId differently than unit/building ids)
  mem.currentMissions = mem.currentMissions.filter(m => {
    const activeUnits = m.unitIds.map(id => State.units.get(id)).filter(u => u && u.hp > 0);
    m.unitIds = activeUnits.map(u => u.id);
    if (m.unitIds.length === 0) return false;

    if (m.type === 'SCOUT') {
      const age = elapsed - (m.startedAt ?? 0);
      return age < BOT_SCOUT_MISSION_MAX_SEC;
    }

    if (m.type === 'retaliation') {
      const age = elapsed - (typeof m.targetId === 'number' ? m.targetId : 0);
      return age < 120;
    }

    if (m.targetId == null) return true;

    const target = State.units.get(m.targetId) || State.buildings.get(m.targetId);
    if (!target || target.hp <= 0) return false;
    return true;
  });

  const idleUnits = combatUnits.filter(u => u.state === 'idle' && !mem.currentMissions.some(m => m.unitIds.includes(u.id)));

  // 1. RETALIATION (Overtake Danger Zones)
  const retaliatoryMission = manageRetaliation(player, idleUnits);
  if (retaliatoryMission) return;

  // DEEP BLUE HARVESTER ASSASSINS
  const cooldown = mem.harassCooldownUntil || (mem.harassCooldownUntil = {});
  const enemyHarvesters = mem.targets.filter(t => {
    const unit = State.units.get(t.id);
    const ready = !cooldown[t.id] || elapsed >= cooldown[t.id];
    return unit && unit.type === 'harvester' && ready;
  });

  if (enemyHarvesters.length > 0) {
    const target = enemyHarvesters[0];
    const needOre = botNeedsPriorityResourceExploration(player);
    const pool = needOre
      ? idleUnits.filter(u => u.type === 'sniper')
      : idleUnits.filter(u => u.type === 'scoutBike' || u.type === 'sniper');
    const assassins = pool.slice(0, 3);
    if (assassins.length >= 2) {
      mem.currentMissions.push({ type: 'HARASS', targetId: target.id, unitIds: assassins.map(u => u.id), status: 'active' });
      Units.commandAttackUnit(assassins.map(u => u.id), target.id);
      cooldown[target.id] = elapsed + BOT_HARASS_COOLDOWN_SEC;
    }
  }

  const baseMin = BOT_ATTACK_THRESHOLD;
  const baseMax = BOT_FULL_ATTACK_THRESHOLD;
  const personalityModifier = Math.floor((1.0 - personality.aggression) * (baseMax - baseMin));
  const strikeThreshold = Math.max(
    baseMin,
    Math.min(baseMax + 5, baseMin + personalityModifier + Math.floor(mem.threatLevel / 2))
  ); 
  
  // Available units must NOT be scout bikes (they are too weak for striking)
  // Include rallying units in the available pool for missions!
  const availableStrikeUnits = combatUnits.filter(u =>
    u.type !== 'scoutBike' && !mem.currentMissions.some(m => m.unitIds.includes(u.id))
  );

  const unitsReservedForDefense = Math.max(4, Math.ceil(strikeThreshold * BOT_STRIKE_RESERVE_MULT));

  if (availableStrikeUnits.length >= strikeThreshold + unitsReservedForDefense) {
    const buildings = mem.targets.filter(t => t.type === 'building' && State.buildings.get(t.id));
    if (buildings.length > 0) {
      buildings.sort((a, b) => {
        const bA = State.buildings.get(a.id);
        const bB = State.buildings.get(b.id);
        const scoreA = bA.type === 'hq' ? 100 : (bA.type === 'warFactory' || bA.type === 'barracks' ? 50 : 10);
        const scoreB = bB.type === 'hq' ? 100 : (bB.type === 'warFactory' || bB.type === 'barracks' ? 50 : 10);
        return scoreB - scoreA;
      });
      const target = buildings[0];
      const strikeSquad = availableStrikeUnits.slice(0, strikeThreshold);
      const ids = strikeSquad.map(u => u.id);
      mem.currentMissions.push({ type: 'STRIKE', targetId: target.id, unitIds: ids, status: 'active' });
      Units.commandAttackBuilding(ids, target.id);
      UI.showStatus(`🤖 P${pid} is launching a ${strikeSquad.length}-unit strike!`);
    }
  }
}

function unitOnScoutMission(mem, unitId) {
  return mem.currentMissions.some(m => m.type === 'SCOUT' && m.unitIds.includes(unitId));
}

function assignBotScoutMissions(player, combatUnits, elapsed) {
  const mem = player.botMemory;
  const pid = player.id;
  const hq = State.getPlayerHQ(pid);
  if (!hq) return;

  const econCritical = botNeedsPriorityResourceExploration(player);
  const startDelay = econCritical ? BOT_SCOUT_DELAY_ECON : BOT_SCOUT_DELAY;
  if (elapsed < startDelay) return;

  const maxScouts = econCritical ? BOT_SCOUT_CAP_ECON : BOT_SCOUT_CAP;
  const currentScoutMissions = mem.currentMissions.filter(m => m.type === 'SCOUT');
  if (currentScoutMissions.length >= maxScouts) return;

  const scoutGap = econCritical ? BOT_SCOUT_GAP_ECON : 6.0;
  if (elapsed - (mem.lastScoutMissionTime || 0) < scoutGap) return;

  const candidates = combatUnits.filter(u => !mem.currentMissions.some(m => m.unitIds.includes(u.id)));
  const candidate =
    candidates.find(u => u.type === 'scoutBike') ||
    candidates.find(u => u.category === 'infantry');
  if (!candidate) return;

  const hv = State.getPlayerUnits(pid).filter(u => u.type === 'harvester');
  const target = getScoutTarget(player, hq, elapsed, null, hv);
  if (!target) return;

  mem.lastScoutMissionTime = elapsed;
  mem.currentMissions.push({
    type: 'SCOUT',
    targetId: null,
    unitIds: [candidate.id],
    status: 'active',
    targetPos: target,
    startedAt: elapsed,
    _lastReissue: elapsed,
  });
  Units.commandAttackMove([candidate.id], target.x, target.z);
}

/**
 * No harvestable field in explored fog → fan harvesters out to different unexplored sectors
 * (batch targets with min separation + reservations so they don't stack on one fog cell).
 */
function assignHarvesterExploration(player, harvesters, elapsed) {
  if (!botNeedsPriorityResourceExploration(player)) return;
  const mem = player.botMemory;
  const hq = State.getPlayerHQ(player.id);
  if (!hq) return;

  const eligible = harvesters.filter(
    h =>
      h.hp > 0 &&
      !h.playerCommanded &&
      h.state === 'idle' &&
      !unitOnScoutMission(mem, h.id) &&
      elapsed - (h._botExploreCmdAt || 0) >= BOT_HARVESTER_EXPLORE_THROTTLE_SEC
  );
  if (eligible.length === 0) return;

  const want = Math.min(BOT_HARVESTER_EXPLORE_PER_TICK, eligible.length);
  const targets = allocateDiverseExploreTargets(player, hq, mem, elapsed, want, null, harvesters);
  for (let i = 0; i < targets.length; i++) {
    const h = eligible[i];
    h._botExploreCmdAt = elapsed;
    Units.commandAttackMove([h.id], targets[i].x, targets[i].z);
  }
}

/**
 * Visible enemies near our harvesters → send combat to kill them (runs late so it overrides rally).
 * Fair: only units visible in fog.
 */
function handleHarvesterDefense(player, combatUnits, harvesters, elapsed) {
  const team = player.team;
  const mem = player.botMemory;
  const R = BOT_HARVESTER_ESCORT_RADIUS;

  let bestEnemy = null;
  let bestDist = Infinity;

  for (const h of harvesters) {
    if (h.hp <= 0) continue;
    const nasties = unitGrid.queryRadiusFiltered(h.x, h.z, R, e =>
      e.team !== team &&
      e.hp > 0 &&
      e.damage > 0 &&
      Fog.isVisibleToTeam(team, e.x, e.z)
    );
    for (const e of nasties) {
      const d = Pathfinding.getDistanceSq(h.x, h.z, e.x, e.z);
      if (d < bestDist) {
        bestDist = d;
        bestEnemy = e;
      }
    }
  }

  if (!bestEnemy) return;

  if (elapsed - (mem._harvesterDefenseAt || 0) < BOT_HARVESTER_ESCORT_COOLDOWN) return;
  mem._harvesterDefenseAt = elapsed;

  const saveScouts = botNeedsPriorityResourceExploration(player);
  const responders = combatUnits.filter(u => {
    if (u.type === 'scoutBike') return false;
    if (u.state !== 'idle' && u.state !== 'moving') return false;
    if (saveScouts && unitOnScoutMission(mem, u.id)) return false;
    return true;
  });

  const n = Math.min(BOT_HARVESTER_ESCORT_MAX_UNITS, responders.length);
  if (n < 1) return;

  Units.commandAttackUnit(
    responders.slice(0, n).map(u => u.id),
    bestEnemy.id
  );
}

function tickScoutMissions(player, elapsed) {
  const mem = player.botMemory;
  const hq = State.getPlayerHQ(player.id);
  if (!hq) return;

  const arriveR2 = BOT_SCOUT_ARRIVE_RADIUS * BOT_SCOUT_ARRIVE_RADIUS;

  mem.currentMissions.forEach(m => {
    if (m.type !== 'SCOUT' || !m.targetPos) return;
    const u = m.unitIds.map(id => State.units.get(id)).find(x => x && x.hp > 0);
    if (!u) return;

    const distSq = Pathfinding.getDistanceSq(u.x, u.z, m.targetPos.x, m.targetPos.z);

    if (distSq <= arriveR2) {
      const hv = State.getPlayerUnits(player.id).filter(u => u.type === 'harvester');
      const next = getScoutTarget(player, hq, elapsed, m.targetPos, hv);
      if (next) {
        m.targetPos = next;
        m._lastReissue = elapsed;
        Units.commandAttackMove([u.id], next.x, next.z);
      }
      return;
    }

    if (elapsed - (m._lastReissue || 0) < BOT_SCOUT_REPATH_SEC) return;
    const stuck =
      u.state === 'idle' ||
      (u.state === 'moving' && !u.playerCommanded && distSq > arriveR2);
    if (stuck) {
      m._lastReissue = elapsed;
      Units.commandAttackMove([u.id], m.targetPos.x, m.targetPos.z);
    }
  });
}

function doAttackMission(player, combatUnits, elapsed) {
  const mem = player.botMemory;

  const strike = mem.currentMissions.find(m => m.type === 'STRIKE');
  if (!strike) return;

  const strikeUnits = strike.unitIds.map(id => State.units.get(id)).filter(u => u && u.hp > 0);
  const target = State.buildings.get(strike.targetId);

  if (strikeUnits.length === 0 || !target || target.hp <= 0) return;

  const needOrders = strikeUnits.filter(u =>
    u.state === 'idle' || (u.state === 'moving' && !u.playerCommanded)
  );
  if (needOrders.length > 0) {
    Units.commandAttackBuilding(needOrders.map(u => u.id), strike.targetId);
  }
}

function tickRetaliationMissions(player) {
  const mem = player.botMemory;
  mem.currentMissions.forEach(m => {
    if (m.type !== 'retaliation' || !m.targetPos) return;
    const ids = m.unitIds
      .map(id => State.units.get(id))
      .filter(u => u && u.hp > 0 && u.state === 'idle');
    if (ids.length > 0) {
      Units.commandAttackMove(
        ids.map(u => u.id),
        m.targetPos.x,
        m.targetPos.z
      );
    }
  });
}

// --- DEFENSE ---
function handleDefense(player, combatUnits, threats) {
  const pid = player.id;
  const hq = State.getPlayerHQ(pid);
  if (!hq || threats.length === 0) return;

  const mem = player.botMemory;
  const econExplore = botNeedsPriorityResourceExploration(player);
  const releaseR2 = BOT_DEFENSE_RELEASE_SCOUT_DIST * BOT_DEFENSE_RELEASE_SCOUT_DIST;

  threats.sort((a, b) => {
    const ua = State.units.get(a.id);
    const ub = State.units.get(b.id);
    if (!ua) return 1;
    if (!ub) return -1;
    return Pathfinding.getDistanceSq(hq.x, hq.z, ua.x, ua.z) - Pathfinding.getDistanceSq(hq.x, hq.z, ub.x, ub.z);
  });

  const primaryThreat = threats[0];
  const threatUnit = State.units.get(primaryThreat.id);
  const isMinorThreat = threatUnit && (threatUnit.type === 'scoutBike' || threatUnit.type === 'rifleman');
  const urgentDefense =
    threatUnit &&
    Pathfinding.getDistanceSq(hq.x, hq.z, threatUnit.x, threatUnit.z) < releaseR2;

  let available = combatUnits.filter(u => {
    if (u.state !== 'idle' && u.state !== 'moving') return false;
    if (unitOnScoutMission(mem, u.id)) return false;
    if (econExplore && u.type === 'scoutBike' && !urgentDefense) return false;
    return true;
  });

  if (threatUnit && unitIsLongRangeThreat(threatUnit)) {
    const capable = available.filter(u => canCounterLongRange(u));
    if (capable.length > 0) available = capable;
  }

  if (isMinorThreat) {
    available = available.slice(0, 2);
  }

  if (available.length === 0) return;

  if (!isMinorThreat && threats.length >= 3 && available.length >= 9) {
    const third = Math.max(2, Math.floor(available.length / 3));
    const a = available.slice(0, third);
    const b = available.slice(third, third * 2);
    const c = available.slice(third * 2);
    Units.commandAttackUnit(a.map(u => u.id), threats[0].id);
    Units.commandAttackUnit(b.map(u => u.id), threats[1].id);
    Units.commandAttackUnit(c.map(u => u.id), threats[2].id);
  } else if (!isMinorThreat && threats.length >= 2 && available.length >= 4) {
    const half = Math.max(2, Math.floor(available.length / 2));
    Units.commandAttackUnit(available.slice(0, half).map(u => u.id), threats[0].id);
    Units.commandAttackUnit(available.slice(half).map(u => u.id), threats[1].id);
  } else {
    Units.commandAttackUnit(available.map(u => u.id), primaryThreat.id);
  }

  const myBuildings = State.getPlayerBuildings(pid);
  const barracks = myBuildings.find(b => b.type === 'barracks' && b.isBuilt && b.productionQueue.length === 0);
  if (barracks && player.credits >= 175 && threats.length > 2) {
    Buildings.queueUnit(barracks.id, 'rocketSoldier');
  }
}

/**
 * Fair focus fire: cluster nearby attackers and retarget to the weakest visible enemy
 * (same intel a human has on screen).
 */
function applyBotFairFocusFire(player, elapsed) {
  const mem = player.botMemory;
  if (elapsed - (mem._lastFocusFire || 0) < BOT_FOCUS_FIRE_INTERVAL) return;
  mem._lastFocusFire = elapsed;

  const pid = player.id;
  const team = player.team;
  const combat = State.getPlayerUnits(pid).filter(u =>
    u.hp > 0 &&
    u.damage > 0 &&
    u.state === 'attacking' &&
    u.targetUnitId
  );
  if (combat.length === 0) return;

  const CLUSTER_R2 = 14 * 14;
  const clusters = [];
  const assigned = new Set();
  for (const seed of combat) {
    if (assigned.has(seed.id)) continue;
    const group = [];
    const q = [seed];
    assigned.add(seed.id);
    while (q.length) {
      const u = q.shift();
      group.push(u);
      for (const o of combat) {
        if (assigned.has(o.id)) continue;
        if (Pathfinding.getDistanceSq(u.x, u.z, o.x, o.z) <= CLUSTER_R2) {
          assigned.add(o.id);
          q.push(o);
        }
      }
    }
    clusters.push(group);
  }

  for (const group of clusters) {
    const enemySet = new Map();
    for (const u of group) {
      const r = u.range + 2;
      unitGrid.queryRadiusFiltered(u.x, u.z, r, e =>
        e.team !== team &&
        e.hp > 0 &&
        Fog.isVisibleToTeam(team, e.x, e.z)
      ).forEach(e => {
        if (!enemySet.has(e.id)) enemySet.set(e.id, e);
      });
    }
    const enemies = [...enemySet.values()];
    if (enemies.length === 0) continue;
    enemies.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
    const best = enemies[0];
    const needRetarget = group.filter(u => u.targetUnitId !== best.id);
    if (needRetarget.length === 0) continue;
    Units.commandAttackUnit(needRetarget.map(u => u.id), best.id);
  }
}

function maybeBotEngineerCapture(player, elapsed) {
  const mem = player.botMemory;
  const pid = player.id;
  const team = player.team;
  const engineers = State.getPlayerUnits(pid).filter(u =>
    u.type === 'engineer' &&
    u.hp > 0 &&
    u.state === 'idle' &&
    !mem.currentMissions.some(m => m.unitIds.includes(u.id))
  );
  if (engineers.length === 0) return;

  const candidates = mem.targets
    .map(t => (t.type === 'building' ? State.buildings.get(t.id) : null))
    .filter(b => {
      if (!b || b.hp <= 0 || !b.isBuilt) return false;
      const p = State.players[b.ownerId];
      if (!p || p.team === team) return false;
      return Fog.isVisibleToTeam(team, b.x, b.z);
    });

  candidates.sort((a, b) => {
    const eng = engineers[0];
    return (
      Pathfinding.getDistanceSq(eng.x, eng.z, a.x, a.z) -
      Pathfinding.getDistanceSq(eng.x, eng.z, b.x, b.z)
    );
  });

  const target = candidates[0];
  if (!target) return;

  if (elapsed - (mem._lastEngCaptureOrder || 0) < 2.5) return;
  mem._lastEngCaptureOrder = elapsed;
  Units.commandAttackBuilding([engineers[0].id], target.id);
}

// --- Helper functions ---

function findBuildPosition(hq, startDistance, buildingType, ownerId) {
  // Step outward in increasing rings so the bot NEVER fails to place a building
  // even if their HQ is extremely crowded
  for (let distance = startDistance; distance <= startDistance + 40; distance += 6) {
    const angleStep = Math.PI / (4 + Math.floor(distance / 5)); // More angles at wider rings
    for (let angle = 0; angle < Math.PI * 2; angle += angleStep) {
      const x = hq.x + Math.cos(angle) * distance;
      const z = hq.z + Math.sin(angle) * distance;
      if (Buildings.canPlaceBuilding(buildingType, ownerId, x, z)) {
        return { x, z };
      }
    }
  }

  return null;
}

function pickRefineryForNextHarvester(refineries, harvesters) {
  if (refineries.length === 0) return null;
  if (refineries.length === 1) return refineries[0];

  const cap = BOT_HARVESTER_PER_REFINERY_TARGET;
  let best = refineries[0];
  let bestLoad = Infinity;

  for (const ref of refineries) {
    const nearby = harvesters.filter(h =>
      Pathfinding.getDistanceSq(h.x, h.z, ref.x, ref.z) < 45 * 45
    ).length;
    const q = ref.productionQueue.filter(q => q.unitType === 'harvester').length;
    const load = (nearby + q * 0.6) / cap;
    if (load < bestLoad) {
      bestLoad = load;
      best = ref;
    }
  }
  return best;
}

/**
 * Refinery as close as legally placeable to a crystal (min travel time for harvesters).
 */
function findBestRefineryPositionNearField(field, ownerId) {
  let best = null;
  let bestDistSq = Infinity;
  const tryAnchor = (ax, az) => {
    const pos = findBuildPosition({ x: ax, z: az }, 4, 'refinery', ownerId);
    if (!pos) return;
    const d = Pathfinding.getDistanceSq(pos.x, pos.z, field.x, field.z);
    if (d < bestDistSq) {
      bestDistSq = d;
      best = pos;
    }
  };

  for (let ring = 0; ring <= 14; ring += 2) {
    tryAnchor(field.x, field.z);
    tryAnchor(field.x + ring, field.z);
    tryAnchor(field.x - ring, field.z);
    tryAnchor(field.x, field.z + ring);
    tryAnchor(field.x, field.z - ring);
    if (ring > 0) {
      tryAnchor(field.x + ring, field.z + ring);
      tryAnchor(field.x + ring, field.z - ring);
      tryAnchor(field.x - ring, field.z + ring);
      tryAnchor(field.x - ring, field.z - ring);
    }
  }

  for (const ox of [3, -3, 6, -6, 9, -9, 12, -12]) {
    for (const oz of [3, -3, 6, -6, 9, -9, 12, -12]) {
      tryAnchor(field.x + ox, field.z + oz);
    }
  }

  if (best) return best;
  return findBuildPosition(field, 8, 'refinery', ownerId);
}

/** Nearest non-depleted field the team has explored in fog (fair). */
function getNearestExploredResourceFieldToPoint(team, px, pz) {
  let best = null;
  let bestD = Infinity;
  State.resourceFields.forEach(f => {
    if (f.depleted) return;
    if (!Fog.wasExploredByTeam(team, f.x, f.z)) return;
    const d = Pathfinding.getDistanceSq(px, pz, f.x, f.z);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  });
  return best;
}

/**
 * Starting patch: nearest crystal to HQ within typical inner-ring spawn distance (no fog required).
 * Used only when fog has not yet marked the home node explored — avoids stuck HQ-only search.
 */
function getNearestResourceFieldNearHQ(hq, maxDist) {
  const maxD2 = maxDist * maxDist;
  let best = null;
  let bestD = Infinity;
  State.resourceFields.forEach(f => {
    if (f.depleted) return;
    const d = Pathfinding.getDistanceSq(hq.x, hq.z, f.x, f.z);
    if (d > maxD2) return;
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  });
  return best;
}

function findMainBaseRefineryPosition(hq, ownerId, team) {
  const field =
    getNearestExploredResourceFieldToPoint(team, hq.x, hq.z) ||
    getNearestResourceFieldNearHQ(hq, 52);
  if (!field) return null;
  return findBestRefineryPositionNearField(field, ownerId);
}

function findExpansionRefineryPosition(field, ownerId) {
  return findBestRefineryPositionNearField(field, ownerId);
}

function pickHarvesterToRetire(harvesters) {
  if (!harvesters.length) return null;
  return harvesters.reduce((a, b) => ((a.cargo || 0) <= (b.cargo || 0) ? a : b));
}

function botHasHarvestableKnownFields(team) {
  let found = false;
  State.resourceFields.forEach(f => {
    if (f.depleted) return;
    if (Fog.wasExploredByTeam(team, f.x, f.z)) found = true;
  });
  return found;
}

function botNeedsPriorityResourceExploration(player) {
  return !botHasHarvestableKnownFields(player.team);
}

function scoutWaypointDanger(mem, elapsed, x, z) {
  let d = 0;
  mem.targets.forEach(t => {
    const dist = Math.sqrt(Pathfinding.getDistanceSq(x, z, t.x, t.z)) + 4;
    let w = t.type === 'building' ? 2.4 : 0.9;
    if (t.type === 'building') {
      const b = State.buildings.get(t.id);
      if (b && b.type === 'hq') w *= 2;
    }
    d += w / (dist * 0.38 + 1);
  });
  mem.dangerZones.forEach(dz => {
    const age = elapsed - dz.time;
    if (age > BOT_SCOUT_DANGER_ZONE_TTL) return;
    const dist = Math.sqrt(Pathfinding.getDistanceSq(x, z, dz.x, dz.z)) + 6;
    const threatN =
      (dz.threats?.infantry || 0) + (dz.threats?.vehicle || 0) * 1.45 + 1;
    const recency = 1 - age / BOT_SCOUT_DANGER_ZONE_TTL;
    let weight = 2.8;
    if (dangerZoneIsLongRangeNest(dz)) weight *= 2.35;
    d += (threatN * recency * weight) / (dist * 0.42 + 1);
  });
  return d;
}

function exploreSectorIndex(hq, c) {
  const sectors = BOT_EXPLORE_SECTORS;
  const dx = c.x - hq.x;
  const dz = c.z - hq.z;
  let ang = Math.atan2(dx, dz);
  if (ang < 0) ang += Math.PI * 2;
  return Math.min(sectors - 1, Math.floor((ang / (Math.PI * 2)) * sectors));
}

function pruneExploreReservations(mem, elapsed) {
  if (!mem.exploreReservations) mem.exploreReservations = [];
  mem.exploreReservations = mem.exploreReservations.filter(r => elapsed < r.until);
}

function collectActiveScoutTargets(mem) {
  return mem.currentMissions.filter(m => m.type === 'SCOUT' && m.targetPos).map(m => m.targetPos);
}

function pathCrowdingPenalty(c, harvesters) {
  if (!harvesters || harvesters.length === 0) return 0;
  let p = 0;
  const r2 = 28 * 28;
  harvesters.forEach(h => {
    if (!h.targetPos || h.hp <= 0) return;
    if (h.state !== 'moving' && h.state !== 'movingToField') return;
    const d2 = Pathfinding.getDistanceSq(c.x, c.z, h.targetPos.x, h.targetPos.z);
    if (d2 < r2) p += 420000;
  });
  return p;
}

function scoreUnexploredCellForExplore(c, hq, mem, elapsed, excludePrev, harvesters) {
  let penalty = 0;
  if (excludePrev && Pathfinding.getDistanceSq(c.x, c.z, excludePrev.x, excludePrev.z) < 14 * 14) {
    penalty += 2.5e6;
  }
  const minD2 = BOT_EXPLORE_MIN_SEP * BOT_EXPLORE_MIN_SEP;
  (mem.exploreReservations || []).forEach(r => {
    if (elapsed >= r.until) return;
    if (Pathfinding.getDistanceSq(c.x, c.z, r.x, r.z) < minD2) penalty += 9e5;
  });
  collectActiveScoutTargets(mem).forEach(t => {
    if (Pathfinding.getDistanceSq(c.x, c.z, t.x, t.z) < minD2) penalty += 7e5;
  });
  penalty += pathCrowdingPenalty(c, harvesters);

  const distHq = Pathfinding.getDistanceSq(hq.x, hq.z, c.x, c.z);
  const danger = scoutWaypointDanger(mem, elapsed, c.x, c.z);
  return distHq + danger * BOT_SCOUT_DANGER_WEIGHT + penalty;
}

/**
 * Picks up to `wantCount` fog cell centers in different compass sectors from HQ, each ≥ BOT_EXPLORE_MIN_SEP apart.
 */
function allocateDiverseExploreTargets(player, hq, mem, elapsed, wantCount, excludePrev, harvesters) {
  pruneExploreReservations(mem, elapsed);
  const team = player.team;
  const raw = Fog.getUnexploredCellCenters(team);
  if (raw.length === 0) return [];

  const sectors = BOT_EXPLORE_SECTORS;
  const buckets = Array.from({ length: sectors }, () => []);
  for (const c of raw) {
    const score = scoreUnexploredCellForExplore(c, hq, mem, elapsed, excludePrev, harvesters);
    buckets[exploreSectorIndex(hq, c)].push({ c, score });
  }
  buckets.forEach(b => b.sort((a, x) => a.score - x.score));

  const picked = [];
  const minD2 = BOT_EXPLORE_MIN_SEP * BOT_EXPLORE_MIN_SEP;
  const tooCloseToPicked = pt =>
    picked.some(p => Pathfinding.getDistanceSq(p.x, p.z, pt.x, pt.z) < minD2);

  const startS = (mem._exploreSectorPass = ((mem._exploreSectorPass ?? 0) + 1) % sectors);

  let rounds = 0;
  while (picked.length < wantCount && rounds < 100) {
    rounds++;
    let addedThisRound = false;
    for (let k = 0; k < sectors && picked.length < wantCount; k++) {
      const s = (startS + k) % sectors;
      const bucket = buckets[s];
      while (bucket.length > 0) {
        const item = bucket.shift();
        if (tooCloseToPicked(item.c)) continue;
        picked.push(item.c);
        mem.exploreReservations.push({
          x: item.c.x,
          z: item.c.z,
          until: elapsed + BOT_EXPLORE_RESERVE_SEC,
        });
        addedThisRound = true;
        break;
      }
    }
    if (!addedThisRound) break;
  }

  if (picked.length < wantCount) {
    const flat = raw
      .map(c => ({
        c,
        score: scoreUnexploredCellForExplore(c, hq, mem, elapsed, excludePrev, harvesters),
      }))
      .sort((a, b) => a.score - b.score);
    for (const item of flat) {
      if (picked.length >= wantCount) break;
      if (tooCloseToPicked(item.c)) continue;
      picked.push(item.c);
      mem.exploreReservations.push({
        x: item.c.x,
        z: item.c.z,
        until: elapsed + BOT_EXPLORE_RESERVE_SEC,
      });
    }
  }

  return picked;
}

function pickSingleExploreWaypointDiverse(player, hq, mem, elapsed, excludePrev, harvesters) {
  const pts = allocateDiverseExploreTargets(player, hq, mem, elapsed, 1, excludePrev, harvesters);
  return pts[0] || null;
}

/**
 * Scout destination: fair fog only. Spreads scouts/harvesters across sectors; avoids stacking on one unexplored tile.
 */
function getScoutTarget(player, hq, elapsed, excludePrev, harvesters = []) {
  const mem = player.botMemory;
  const team = player.team;

  const priorityEco = botNeedsPriorityResourceExploration(player);

  for (const fieldId of mem.discoveredResources) {
    const field = State.resourceFields.get(fieldId);
    if (!field || field.depleted) continue;
    if (
      excludePrev &&
      Pathfinding.getDistanceSq(field.x, field.z, excludePrev.x, excludePrev.z) < 12 * 12
    ) {
      continue;
    }

    const nearbyUnits = unitGrid.queryRadius(field.x, field.z, 15).filter(u => u.team === team);
    if (nearbyUnits.length === 0) {
      const danger = scoutWaypointDanger(mem, elapsed, field.x, field.z);
      if (danger < 4.2 || priorityEco) return { x: field.x, z: field.z };
    }
  }

  const fogGoal = pickSingleExploreWaypointDiverse(player, hq, mem, elapsed, excludePrev, harvesters);
  if (fogGoal) return fogGoal;

  for (let attempt = 0; attempt < 14; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const t = 0.35 + Math.random() * 0.65;
    const wx = hq.x + Math.cos(angle) * (25 + t * 75);
    const wz = hq.z + Math.sin(angle) * (25 + t * 75);
    const x = Math.max(-MAP_SIZE / 2 + 8, Math.min(MAP_SIZE / 2 - 8, wx));
    const z = Math.max(-MAP_SIZE / 2 + 8, Math.min(MAP_SIZE / 2 - 8, wz));
    if (!Fog.wasExploredByTeam(team, x, z)) {
      const danger = scoutWaypointDanger(mem, elapsed, x, z);
      if (danger < 5.5) return { x, z };
    }
  }

  return {
    x: Math.max(-MAP_SIZE / 2 + 10, Math.min(MAP_SIZE / 2 - 10, -hq.x * 0.4)),
    z: Math.max(-MAP_SIZE / 2 + 10, Math.min(MAP_SIZE / 2 - 10, -hq.z * 0.4)),
  };
}

function analyzeEnemyComposition(player) {
  const result = { infantry: 0, vehicle: 0, total: 0, types: {} };

  State.units.forEach(unit => {
    if (unit.team === player.team || unit.hp <= 0) return;
    if (!Fog.isVisibleToTeam(player.team, unit.x, unit.z)) return;

    result.total++;
    if (unit.category === 'infantry') result.infantry++;
    else if (unit.category === 'vehicle') result.vehicle++;
    result.types[unit.type] = (result.types[unit.type] || 0) + 1;
  });

  return result;
}

function pickCounterUnit(enemyAnalysis, category, threatLevel, credits, personality) {
  if (category === 'infantry') {
    if (enemyAnalysis.vehicle > 1) return 'rocketSoldier';
    if (credits < 180 || (threatLevel <= 3 && enemyAnalysis.infantry < 5)) return 'rifleman';
    if (credits < 320) return Math.random() < 0.45 ? 'rifleman' : 'sniper';
    if (enemyAnalysis.infantry > 7) return 'sniper';
    return Math.random() < 0.55 ? 'rifleman' : 'sniper';
  }

  if (category === 'vehicle') {
    if (enemyAnalysis.infantry > 8) return 'artillery';
    if (credits < 380) return 'lightTank';
    if (threatLevel >= 7 && credits >= 520) return 'heavyTank';
    return personality.techPreference > 0.62 ? 'heavyTank' : 'lightTank';
  }

  return 'rifleman';
}
