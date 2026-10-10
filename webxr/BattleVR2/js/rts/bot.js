// ========================================
// RTSVR4 — Bot AI
// C&C-inspired state machine AI
// ========================================

import {
  BOT_TICK_RATE, BOT_DEFEND_RADIUS, BOT_SCOUT_DELAY,
  BOT_ATTACK_THRESHOLD, BOT_FULL_ATTACK_THRESHOLD,
  BOT_STRIKE_RESERVE_MULT, BOT_MAX_PRODUCTION_QUEUE, BOT_FOCUS_FIRE_INTERVAL,
  BOT_TARGET_APM,
  BOT_SCOUT_DELAY_ECON, BOT_SCOUT_CAP, BOT_SCOUT_CAP_ECON, BOT_SCOUT_GAP_ECON,
  BOT_SCOUT_CAP_INTEL, BOT_SCOUT_GAP_INTEL, BOT_SCOUT_DELAY_INTEL, BOT_INTEL_SPAWN_STANDOFF,
  BOT_SCOUT_REPATH_SEC, BOT_SCOUT_ARRIVE_RADIUS,
  BOT_SCOUT_DANGER_WEIGHT, BOT_SCOUT_DANGER_ZONE_TTL,
  BOT_DEFENSE_RELEASE_SCOUT_DIST,
  BOT_HARVESTER_EXPLORE_PER_TICK, BOT_HARVESTER_EXPLORE_THROTTLE_SEC,
  BOT_EXPLORE_MIN_SEP, BOT_EXPLORE_RESERVE_SEC, BOT_EXPLORE_SECTORS,
  BOT_HARVESTER_ESCORT_RADIUS, BOT_HARVESTER_ESCORT_MAX_UNITS, BOT_HARVESTER_ESCORT_COOLDOWN,
  BOT_BASE_VEHICLE_THREAT_RADIUS, BOT_HARVESTER_VEHICLE_THREAT_RADIUS, BOT_RETALIATION_FLANK_DIST,
  BOT_ECON_EXPAND_CREDITS, BOT_ECON_MOBILE_HQ_EXPAND_CREDITS, BOT_STOP_HARVESTER_AT_POP,
  BOT_MIN_HARVESTERS_KEEP, BOT_EXPAND_MIN_HARVESTERS, BOT_HV_CAP_BEFORE_MHQ, BOT_HV_CAP_BEFORE_FACTORY, BOT_MAX_REFINERIES, BOT_FIELD_CLAIM_RADIUS,
  BOT_ORE_CLUSTER_RADIUS, BOT_EXPAND_MIN_ORE_FRAC, BOT_EXPAND_ENEMY_HQ_AVOID, RESOURCE_FIELD_CAPACITY,
  BOT_SECOND_WARFACTORY_CREDITS, BOT_RETALIATION_ENEMY_MULT,
  BOT_HARASS_COOLDOWN_SEC, BOT_SCOUT_MISSION_MAX_SEC,
  BOT_MIN_HARVESTERS_BEFORE_SACRIFICE, BOT_HARVESTER_PER_REFINERY_TARGET, BOT_HARVESTER_GLOBAL_CAP,
  BOT_MIN_STABLE_HARVESTERS, BOT_MIN_STABLE_WORKING,
  BOT_GUARD_PER_HQ, BOT_GUARD_PER_REFINERY, BOT_DEFENSE_ARMY_SOFT_CAP,
  BOT_HQ_STRIKE_MIN, BOT_STRIKE_DEFENDER_MULT, BOT_STRATEGY_PRESETS,
  UNIT_TYPES, BUILDING_TYPES, MAP_SIZE, MAP_PLAYABLE_RADIUS, clampWorldToPlayableDisk, BUILD_RADIUS_FROM_HQ,
} from './config.js';
import * as State from './state.js';
import * as Units from './units.js';
import * as Buildings from './buildings.js';
import * as Fog from './fog.js';
import * as Pathfinding from './pathfinding.js';
import * as UI from './ui.js';
import * as Trace from './match-trace.js';
import { unitGrid } from './spatial.js';

let lastBotTick = 0;

/**
 * Apply a named strategy preset onto a bot player (FFA A/B seats).
 * @param {object} player
 * @param {string} strategyId
 */
export function applyBotStrategy(player, strategyId) {
  const preset = BOT_STRATEGY_PRESETS[strategyId];
  if (!player?.botMemory || !preset) return false;
  player.botMemory.personality = {
    aggression: preset.aggression,
    expansiveness: preset.expansiveness,
    defensiveness: preset.defensiveness,
    techPreference: preset.techPreference,
    artilleryAffinity: preset.artilleryAffinity ?? 0.5,
    staticDefenseBias: preset.staticDefenseBias ?? 0.5,
  };
  player.botMemory.strategyId = strategyId;
  player.botMemory.strategyLabel = preset.label;
  return true;
}

/**
 * Human-like order budget: ~BOT_TARGET_APM intentional commands/min.
 * Group selects count as 1. Refills each bot tick; unused budget carries (capped).
 * @param {object} mem
 * @returns {boolean}
 */
function botCanSpendOrder(mem) {
  return (mem._orderBudget || 0) >= 1;
}

/** @param {object} mem */
function botSpendOrder(mem) {
  mem._orderBudget = Math.max(0, (mem._orderBudget || 0) - 1);
}

/**
 * @param {object} mem
 * @param {number} [n=1]
 * @returns {boolean}
 */
function botTrySpendOrders(mem, n = 1) {
  const need = Math.max(1, n | 0);
  if ((mem._orderBudget || 0) < need) return false;
  mem._orderBudget -= need;
  return true;
}

function refillBotOrderBudget(mem) {
  const perTick = BOT_TARGET_APM / 60 / BOT_TICK_RATE;
  // APM/60 is half an order at 30/min, and an order costs 1, so the bank must hold one.
  const bank = Math.max(1, BOT_TARGET_APM / 60);
  mem._orderBudget = Math.min(bank, (mem._orderBudget || 0) + perTick);
}

/**
 * Avoid `commandAttackUnit` for bot field orders: every unit used the same targetPos as the
 * enemy center, so grid paths often failed across unwalkable wedges and defenders idled at
 * the nav rim. Attack-move toward a waypoint that is reachable from the **nearest** defender
 * to the foe (via `findNearestReachable`) restores routing; movers still auto-acquire hostiles.
 *
 * @param {string[]} unitIds
 * @param {{ id: string }} enemyRef — unit id wrapper (same shape as `mem.targets` rows / threat list)
 */
function commandBotEngageEnemyUnits(unitIds, enemyRef) {
  if (!enemyRef || enemyRef.id == null) return false;
  const tgt = State.units.get(enemyRef.id);
  if (!tgt || tgt.hp <= 0) return false;

  const units = unitIds.map(uid => State.units.get(uid)).filter(u => u && u.hp > 0);
  if (units.length === 0) return false;

  let anchor = units[0];
  let bestD2 = Infinity;
  for (const u of units) {
    const d2 = Pathfinding.getDistanceSq(u.x, u.z, tgt.x, tgt.z);
    if (d2 < bestD2) {
      bestD2 = d2;
      anchor = u;
    }
  }

  let ax = anchor.x;
  let az = anchor.z;
  if (!Pathfinding.isPositionWalkable(ax, az)) {
    const pushed = Pathfinding.snapOutOfObstacle(ax, az);
    ax = pushed.x;
    az = pushed.z;
  }

  const reach =
    Pathfinding.findNearestReachable(ax, az, tgt.x, tgt.z, 44) ||
    clampWorldToPlayableDisk(tgt.x, tgt.z, 2);

  Units.commandAttackMove(
    units.map(u => u.id),
    reach.x,
    reach.z
  );
  const stamped = State.gameSession.elapsedTime;
  for (let i = 0; i < units.length; i++) {
    units[i]._botDefenseCmdAt = stamped;
  }
  return true;
}

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

  refillBotOrderBudget(mem);

  const myUnits = State.getPlayerUnits(pid);
  const myBuildings = State.getPlayerBuildings(pid);
  // Mobile HQ is an expander, not a soldier. Guard/rally/attack groups were
  // attack-moving it back to the home pad every 2.5s (the turnback in match traces).
  const combatUnits = myUnits.filter(u =>
    u.type !== 'harvester' && u.type !== 'engineer' && u.type !== 'mobileHq' && u.hp > 0
  );
  const harvesters = myUnits.filter(u => u.type === 'harvester' && u.hp > 0);
  /** Story garrisons stay on base; only mobile combat explores / strikes. */
  const mobileCombat = combatUnits.filter(u => u.botRole !== 'garrison');

  // 1. Fair Memory & Visibility (no orders)
  updateBotVisibility(player, elapsed);
  updateDiscoveredResources(player);
  updateThreatLevel(player);
  player.botMemory.militaryEmergency = computeMilitaryEmergency(player, harvesters);
  player.botMemory.economyStable = computeEconomyStable(player, harvesters, myBuildings);

  // 2. Defense / missions first (spend limited APM on urgent orders)
  let localThreats = getThreatsToAssets(player, myBuildings, myUnits);
  if (localThreats.length > 0) {
    handleDefense(player, combatUnits, localThreats);
  }
  defendMobileHqUnderFire(player, combatUnits, elapsed);
  handleHarvesterDefense(player, mobileCombat, harvesters, elapsed);
  assignBaseGuards(player, mobileCombat, myBuildings, elapsed);
  manageMissions(player, mobileCombat, elapsed);
  doAttackMission(player, mobileCombat, elapsed);
  tickRetaliationMissions(player);
  applyBotFairFocusFire(player, elapsed);
  maybeBotEngineerCapture(player, elapsed);

  // 3. Exploration / scouts (remaining APM)
  assignBotScoutMissions(player, mobileCombat, elapsed);
  tickScoutMissions(player, elapsed);
  // Idle HVs with no ore also seek fog (resources.js); this keeps a few HVs probing while scouts work.
  assignHarvesterExploration(player, harvesters, elapsed);

  // 4. Industrial loop — economy first so building placement wins the credit race,
  // then unit queues spend leftover cash.
  performEconomyLogic(player, myBuildings, harvesters, elapsed);
  performProductionLogic(player, myBuildings, combatUnits, elapsed);
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

    // Crystal sites are map geography. A 1v1 player drives the MHQ to the
    // near contested crystal without waiting for a scout to stumble on it.
    if (
      Fog.isVisibleToTeam(player.team, field.x, field.z)
      || Fog.wasExploredByTeam(player.team, field.x, field.z)
      || player.isBot
    ) {
      mem.discoveredResources.push(field.id);
      console.log(`🤖 P${player.id} just discovered resource field ${field.id}!`);
    }
  });
}

function performEconomyLogic(player, buildings, harvesters, elapsed) {
  // Before any build return. A turret purchase used to skip the rest of the
  // tick, so a fresh Mobile HQ sat on the factory rally instead of leaving.
  shepherdMobileHq(player);
  const pid = player.id;
  const mem = player.botMemory;
  const personality = mem.personality;
  let credits = player.credits;

  const hasSolarPlaced = buildings.some(b => b.type === 'solarPanel' && b.hp > 0);
  const hasSolarBuilt = buildings.some(b => b.type === 'solarPanel' && b.isBuilt && b.hp > 0);
  let pendingSolar = buildings.some(b => b.type === 'solarPanel' && b.hp > 0 && !b.isBuilt);
  const hasBarracks = buildings.some(b => b.type === 'barracks' && b.hp > 0);
  const hasBarracksBuilt = buildings.some(b => b.type === 'barracks' && b.isBuilt && b.hp > 0);
  const hasRefinery = buildings.some(b => b.type === 'refinery' && b.hp > 0);
  const hasRefineryBuilt = buildings.some(b => b.type === 'refinery' && b.isBuilt && b.hp > 0);
  const hasFactory = buildings.some(b => b.type === 'warFactory' && b.hp > 0);

  const expansionThreshold = BOT_ECON_EXPAND_CREDITS;
  // War Factory costs 600 — never attempt below cost (old personality threshold could be 400).
  const factoryCreditsNeeded = 600;

  // Priority 0: first solar unlocks the tech tree
  if (!hasSolarPlaced && credits >= 150) {
    const pos = findBuildPosition(State.getPlayerHQ(pid), 8, 'solarPanel', pid);
    if (pos) Buildings.placeBuilding('solarPanel', pid, pos.x, pos.z);
    return;
  }
  if (hasSolarPlaced && !hasSolarBuilt) return;

  // Priority 1: refinery → barracks → factory
  if (hasSolarBuilt && !hasRefinery && credits >= 500) {
    const hq = State.getPlayerHQ(pid);
    let pos = null;
    if (hq) {
      pos = findMainBaseRefineryPosition(hq, pid, player.team);
      if (!pos) pos = findBuildPosition(hq, 15, 'refinery', pid);
    }
    if (pos) Buildings.placeBuilding('refinery', pid, pos.x, pos.z);
    return;
  }
  if (hasRefinery && !hasRefineryBuilt) return;

  // Fill trucks as soon as the refinery exists. Later placement returns used to
  // skip the harvester block until the factory was already up.
  if ((personality.artilleryAffinity ?? 0) >= 0.7 && harvesters.length < 6 && player.credits >= 200) {
    const ref = buildings.find(b => b.type === 'refinery' && b.isBuilt && b.hp > 0);
    const queued = ref ? ref.productionQueue.filter(q => q.unitType === 'harvester').length : 0;
    if (ref && harvesters.length + queued < 6 && queued < 2) {
      Buildings.queueUnit(ref.id, 'harvester');
      credits = player.credits;
    }
  }

  // After first refinery: 2nd solar BEFORE barracks so power is ready the tick barracks finishes,
  // then barracks → factory → MHQ with home ore still fat.
  const solarCount = buildings.filter(b => b.type === 'solarPanel' && b.hp > 0).length;
  if (hasRefineryBuilt && !hasFactory && solarCount < 2 && credits >= 150 && !pendingSolar) {
    const pos = findBuildPosition(State.getPlayerHQ(pid), 10, 'solarPanel', pid);
    if (pos) {
      Buildings.placeBuilding('solarPanel', pid, pos.x, pos.z);
      pendingSolar = true;
      credits = player.credits;
    }
  }

  if (hasRefineryBuilt && !hasBarracks && credits >= 300) {
    const pos = findBuildPosition(State.getPlayerHQ(pid), 10, 'barracks', pid);
    if (pos) {
      Buildings.placeBuilding('barracks', pid, pos.x, pos.z);
      // Fall through — HV soft-cap / factory placement still run this tick.
    }
  }

  // Power headroom before factory (50 consume) or while brownout.
  const pow = Buildings.getPlayerPower(pid);
  const factoryPowerNeed = 50;
  const needPowerForFactory =
    !hasFactory
    && buildings.some(b => b.type === 'barracks' && b.isBuilt && b.hp > 0)
    && pow.surplus < factoryPowerNeed;
  const needPowerBrownout = pow.surplus < 0;
  if (
    (needPowerForFactory || needPowerBrownout)
    && player.credits >= 150
    && !pendingSolar
  ) {
    const pos = findBuildPosition(State.getPlayerHQ(pid), 10, 'solarPanel', pid);
    if (pos) {
      Buildings.placeBuilding('solarPanel', pid, pos.x, pos.z);
      pendingSolar = true;
      credits = player.credits;
    }
  }

  const powNow = Buildings.getPlayerPower(pid);
  const hasBarracksBuiltNow = buildings.some(b => b.type === 'barracks' && b.isBuilt && b.hp > 0);

  if (
    !hasFactory
    && hasBarracksBuiltNow
    && player.credits >= factoryCreditsNeeded
    && powNow.surplus >= factoryPowerNeed
    && !pendingSolar
  ) {
    const pos = findBuildPosition(State.getPlayerHQ(pid), 12, 'warFactory', pid);
    if (pos) {
      const placed = Buildings.placeBuilding('warFactory', pid, pos.x, pos.z);
      if (placed) return;
    }
  }

  // Defenses after barracks — adapt to pressure; don't wait only for militaryEmergency.
  const expandFieldPreview = hasFactory ? findUnclaimedDiscoveredFieldId(
    { id: pid, botMemory: mem, team: player.team }
  ) : null;
  const liveRefCount = buildings.filter(b => b.type === 'refinery' && b.hp > 0).length;
  const expandStillOpen = hasFactory && liveRefCount < 2 && !!expandFieldPreview;
  const defenseBias = personality.staticDefenseBias ?? 0.5;
  const artyAffinity = personality.artilleryAffinity ?? 0.5;
    const underSiege = !!mem._seenEnemyArtillery || !!mem.militaryEmergency;
  // High-bias / siege profiles fortify during expand instead of waiting for a 2nd refinery.
  const wantStaticDefense =
    hasBarracksBuiltNow
    && (!expandStillOpen || underSiege || defenseBias >= 0.7)
    && (liveRefCount >= 1 || underSiege || mem.economyStable || defenseBias >= 0.6);
  if (wantStaticDefense && credits >= 400) {
    const turrets = buildings.filter(b => b.type === 'turret' && b.hp > 0);
    const artyTurrets = buildings.filter(b => b.type === 'artilleryTurret' && b.hp > 0);
    const preferArtyStatic = artyAffinity >= 0.65 || underSiege;
    // One static artillery per HQ (the new base included). Gun turrets do not
    // answer a 70m gun, so a siege profile does not spend the expand on them.
    const hqsLive = buildings.filter(b => b.type === 'hq' && b.hp > 0 && b.isBuilt);
    const hqMissingGun = hqsLive.find(hq => !artyTurrets.some(t =>
      Pathfinding.getDistanceSq(t.x, t.z, hq.x, hq.z) < 48 * 48
    ));
    const beforeSecondRef = liveRefCount < 2 && !mem.militaryEmergency;
    const deferHeavyDefense = beforeSecondRef;
    const turretCap = (beforeSecondRef || preferArtyStatic)
      ? (mem.militaryEmergency ? 1 : 0)
      : preferArtyStatic && artyTurrets.length === 0
        ? 1
        : (mem.militaryEmergency ? 3 : Math.max(1, Math.round(1 + defenseBias * 2)));
    const artyCap = beforeSecondRef
      ? 1
      : Math.max(hqsLive.length, preferArtyStatic ? 1 : 0);
    const artyCost = BUILDING_TYPES.artilleryTurret?.cost || 700;
    const artyPower = BUILDING_TYPES.artilleryTurret?.powerConsume || 40;
    if (preferArtyStatic && artyTurrets.length < artyCap) {
      const pow = Buildings.getPlayerPower(pid);
      if (pow.produce < pow.consume + artyPower && !pendingSolar) {
        const pos = findBuildPosition(State.getPlayerHQ(pid), 10, 'solarPanel', pid);
        if (pos) {
          Buildings.placeBuilding('solarPanel', pid, pos.x, pos.z);
          pendingSolar = true;
          credits = player.credits;
          if (credits < artyCost) return;
        }
      }
      if (credits >= artyCost && hqMissingGun) {
        const pos = findBuildPosition(hqMissingGun, 12, 'artilleryTurret', pid);
        if (pos) {
          const placed = Buildings.placeBuilding('artilleryTurret', pid, pos.x, pos.z);
          if (placed) return;
        }
      }
    }
    if (
      turrets.length < turretCap
      && !(preferArtyStatic && !deferHeavyDefense && artyTurrets.length === 0 && credits < artyCost)
    ) {
      const pos = findBuildPosition(State.getPlayerHQ(pid), 14, 'turret', pid);
      if (pos) {
        const placed = Buildings.placeBuilding('turret', pid, pos.x, pos.z);
        if (placed) return;
      }
    }
  }

  const builtRefineries = buildings.filter(b => b.type === 'refinery' && b.isBuilt);
  const liveRefineries = buildings.filter(b => b.type === 'refinery' && b.hp > 0);
  const hasMobileHqAlready = State.getPlayerUnits(pid).some(u => u.type === 'mobileHq' && u.hp > 0);
  const mhqInQueue = buildings.some(
    b => b.type === 'warFactory' && b.productionQueue.some(q => q.unitType === 'mobileHq')
  );
  // Harvest flow = get a 2nd crystal online ASAP. Cap trucks hard until MHQ is rolling.
  let harvesterTarget = 0;
  if (builtRefineries.length > 0) {
    if (liveRefineries.length >= 2) {
      harvesterTarget = BOT_HARVESTER_GLOBAL_CAP;
    } else if (hasMobileHqAlready || mhqInQueue) {
      // Human template: ~8–10 trucks on the home refinery while the MHQ is out.
      // A cap of 3 left the bot on one income stream for the whole match.
      harvesterTarget = 8;
    } else if (!hasFactory || (personality.artilleryAffinity ?? 0) >= 0.7) {
      harvesterTarget = (personality.artilleryAffinity ?? 0) >= 0.7 ? 6 : BOT_HV_CAP_BEFORE_FACTORY;
    } else {
      harvesterTarget = BOT_HV_CAP_BEFORE_MHQ;
    }
  }
  const currentHarvesters = harvesters.length;
  const unitCount = State.getPlayerUnits(pid).length;
  const belowHarvesterFloor = currentHarvesters < BOT_MIN_HARVESTERS_KEEP;
  const belowHarvesterTarget = currentHarvesters < harvesterTarget;
  const isNearCap =
    unitCount >= BOT_STOP_HARVESTER_AT_POP && !belowHarvesterFloor && !belowHarvesterTarget;

  // Expansion as soon as factory + min trucks exist. Do NOT wait for home ore to empty —
  // every other crystal is far and needs Mobile HQ.
  // Shepherd any live MHQ toward a far field even before the HV floor (unit may already be out).
  if (hasMobileHqAlready && liveRefineries.length < BOT_MAX_REFINERIES) {
    shepherdMobileHq(player);
  }
  // A deployed HQ with no refinery never clears the artillery cap. Place the pad
  // on that HQ (solar first when power is tight) instead of waiting on a field probe.
  if (hasFactory && liveRefineries.length < BOT_MAX_REFINERIES && credits >= 500) {
    const bareHqs = buildings.filter((b) => b.type === 'hq' && b.hp > 0 && b.isBuilt);
    for (let hi = 0; hi < bareHqs.length; hi++) {
      const hq = bareHqs[hi];
      if (liveRefineries.some((r) => Math.hypot(r.x - hq.x, r.z - hq.z) < 48)) continue;
      if (Buildings.getPlayerPower(pid).surplus < 40 && credits >= 150) {
        const solarPos = findBuildPosition(hq, 8, 'solarPanel', pid);
        if (solarPos && Buildings.placeBuilding('solarPanel', pid, solarPos.x, solarPos.z)) return;
      }
      const pad = findBuildPosition(hq, 10, 'refinery', pid);
      if (pad && Buildings.placeBuilding('refinery', pid, pad.x, pad.z)) return;
    }
  }
  const canExpand =
    hasFactory
    && currentHarvesters >= BOT_EXPAND_MIN_HARVESTERS
    && liveRefineries.length < BOT_MAX_REFINERIES;
  if (canExpand) {
    // 1) Place claimable expand refinery — prefer pads that cover the most crystals in a patch.
    let placedExpand = false;
    const expandCandidates = [];
    for (const id of mem.discoveredResources || []) {
      const field = State.resourceFields.get(id);
      if (!field || field.depleted) continue;
      if (fieldRemainingFrac(field) < BOT_EXPAND_MIN_ORE_FRAC) continue;
      if (fieldCoveredByOwnedRefinery(pid, field, liveRefineries)) continue;
      const pos = findExpansionRefineryPositionCached(player, field);
      if (!pos || credits < expansionThreshold) continue;
      let cover = 0;
      const claimR2 = BOT_FIELD_CLAIM_RADIUS * BOT_FIELD_CLAIM_RADIUS;
      State.resourceFields.forEach(f => {
        if (!f || f.depleted) return;
        if (Pathfinding.getDistanceSq(pos.x, pos.z, f.x, f.z) < claimR2) cover++;
      });
      expandCandidates.push({ field, pos, cover, rem: fieldRemainingFrac(field) });
    }
    expandCandidates.sort((a, b) => b.cover - a.cover || b.rem - a.rem);
    for (const cand of expandCandidates) {
      const { field, pos } = cand;
      const powExpand = Buildings.getPlayerPower(pid);
      if (powExpand.surplus < 40 && credits >= 150 && !pendingSolar) {
        const expandHq = nearestPlayerHq(pid, field.x, field.z) || State.getPlayerHQ(pid);
        let solarPos = findBuildPosition(expandHq, 8, 'solarPanel', pid);
        if (!solarPos) solarPos = findBuildPosition(State.getPlayerHQ(pid), 10, 'solarPanel', pid);
        if (solarPos) {
          Buildings.placeBuilding('solarPanel', pid, solarPos.x, solarPos.z);
          credits = player.credits;
          pendingSolar = true;
        }
      }
      if (Buildings.getPlayerPower(pid).surplus < 40) continue;
      if (credits < expansionThreshold) continue;
      if (Buildings.placeBuilding('refinery', pid, pos.x, pos.z)) {
        mem.expandCommitFieldId = null;
        return;
      }
      placedExpand = true;
      break;
    }

    // 2) Need Mobile HQ for a far unclaimed field.
    if (!placedExpand) {
      const unclaimedFieldId = findUnclaimedDiscoveredFieldId(player);
      const field = unclaimedFieldId ? State.resourceFields.get(unclaimedFieldId) : null;
      if (field) {
        mem.expandCommitFieldId = field.id;
        if (driveMobileHqExpansion(player, field)) {
          const pos2 = findExpansionRefineryPositionCached(player, field);
          if (pos2 && player.credits >= expansionThreshold) {
            const pow2 = Buildings.getPlayerPower(pid);
            if (pow2.surplus < 40) {
              if (player.credits >= 150 && !pendingSolar) {
                const expandHq = nearestPlayerHq(pid, field.x, field.z) || State.getPlayerHQ(pid);
                const solarPos =
                  findBuildPosition(expandHq, 8, 'solarPanel', pid)
                  || findBuildPosition(State.getPlayerHQ(pid), 10, 'solarPanel', pid);
                if (solarPos) Buildings.placeBuilding('solarPanel', pid, solarPos.x, solarPos.z);
              }
            } else {
              Buildings.placeBuilding('refinery', pid, pos2.x, pos2.z);
            }
          }
          return;
        }
      }
    }
  }

  const expandPending = canExpand && !!findUnclaimedDiscoveredFieldId(player);

  const militaryEmergency = mem.militaryEmergency;
  const savingCashForExpand =
    expandPending
    && player.credits < expansionThreshold + (UNIT_TYPES.mobileHq?.cost || 750);
  // Fill ore trucks first (up to stable count) even while banking for expand — starving at 5–6
  // HVs while sitting on an expand bank was the old "stupid" eco stall.
  const wantHarvestersHard = currentHarvesters < Math.min(harvesterTarget, BOT_MIN_STABLE_HARVESTERS);
  if (
    currentHarvesters < harvesterTarget
    && credits >= 200
    && !isNearCap
    && (!militaryEmergency || currentHarvesters < BOT_MIN_HARVESTERS_KEEP)
    && (!savingCashForExpand || wantHarvestersHard || belowHarvesterFloor)
  ) {
    const ref = pickRefineryForNextHarvester(builtRefineries, harvesters);
    const queued = ref
      ? ref.productionQueue.filter(q => q.unitType === 'harvester').length
      : 0;
    const inFlight = currentHarvesters + queued;
    if (ref && inFlight < harvesterTarget && queued < (militaryEmergency ? 1 : 2)) {
      Buildings.queueUnit(ref.id, 'harvester');
    }
  }

  const factories = buildings.filter(b => b.type === 'warFactory' && b.hp > 0);
  // Never sink cash into a 2nd factory until the expand refinery is up — that bank is the MHQ/pad.
  if (
    liveRefineries.length >= 2
    && !expandPending
    && personality.aggression > 0.55
    && factories.length < 2
    && credits >= BOT_SECOND_WARFACTORY_CREDITS
    && hasBarracksBuiltNow
  ) {
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
  
  // Hold $600 until the war factory is placed — do not spam army the tick cash hits 600.
  const savingForFactory = hasRefinery && !hasFactory;
  const expandFieldId = hasFactory ? findUnclaimedDiscoveredFieldId(player) : null;
  const expandField = expandFieldId ? State.resourceFields.get(expandFieldId) : null;
  const expandPadReady = !!expandField && !!findExpansionRefineryPositionCached(player, expandField);
  // HQ already covering the field (within build radius) → never buy another MHQ; wait for
  // solar/cash/pad freeyup. Contested ore used to queue endless Mobile HQs into the bank.
  const hqCoveringExpand = (() => {
    if (!expandField) return false;
    const hq = nearestPlayerHq(player.id, expandField.x, expandField.z);
    if (!hq) return false;
    return Pathfinding.getDistanceSq(hq.x, hq.z, expandField.x, expandField.z)
      <= BUILD_RADIUS_FROM_HQ * BUILD_RADIUS_FROM_HQ;
  })();
  const mhqCost = UNIT_TYPES.mobileHq?.cost || BOT_ECON_MOBILE_HQ_EXPAND_CREDITS;
  const livingMhqs = State.getPlayerUnits(player.id).filter(
    u => u.type === 'mobileHq' && u.hp > 0
  );
  const hasMobileHqUnit = livingMhqs.length > 0;
  let mhqQueued = buildings.some(
    b => b.type === 'warFactory' && b.productionQueue.some(q => q.unitType === 'mobileHq')
  );
  // Cancel twin MHQs already sitting in queues (legacy / race).
  if (hasMobileHqUnit || mhqQueued) {
    let seenMhq = hasMobileHqUnit ? 1 : 0;
    for (const b of buildings) {
      if (b.type !== 'warFactory' || !b.productionQueue?.length) continue;
      for (let i = b.productionQueue.length - 1; i >= 0; i--) {
        if (b.productionQueue[i].unitType !== 'mobileHq') continue;
        seenMhq++;
        if (seenMhq > 1) {
          Buildings.cancelUnit(b.id, 'mobileHq');
          credits = player.credits;
          mhqQueued = buildings.some(
            bb => bb.type === 'warFactory' && bb.productionQueue.some(q => q.unitType === 'mobileHq')
          );
        }
      }
    }
  }
  // Re-query. `buildings` is a snapshot from the start of the tick, so an MHQ
  // that deploys this tick is invisible and hqCount stays 1 — which queued a
  // second MHQ before the new base had a refinery.
  const liveNow = State.getPlayerBuildings(player.id);
  const refineryCount = liveNow.filter(b => b.type === 'refinery' && b.hp > 0).length;
  const hvForExpand = State.getPlayerUnits(player.id).filter(
    u => u.type === 'harvester' && u.hp > 0
  ).length;
  const hqCount = liveNow.filter(b => b.type === 'hq' && b.hp > 0).length;
  const builtRefineryCount = liveNow.filter(b => b.type === 'refinery' && b.isBuilt && b.hp > 0).length;
  const hqGunsReady = hqCount <= 1 || liveNow.filter(b => b.type === 'hq' && b.hp > 0).every(hq =>
    liveNow.some(g =>
      g.type === 'artilleryTurret' && g.hp > 0
      && Pathfinding.getDistanceSq(g.x, g.z, hq.x, hq.z) < 48 * 48
    )
  );
  // Next Mobile HQ only after the last base's refinery is finished and, once we
  // have more than the starting HQ, that base has a static gun. Buying the truck
  // on the same tick the pad was placed walked a second MHQ around for minutes.
  const wantsPreemptiveMhq =
    hasFactory
    && builtRefineryCount >= 1
    && builtRefineryCount >= hqCount
    && hqGunsReady
    && hqCount < ((personality.artilleryAffinity ?? 0) >= 0.7 ? 2 : 8)
    && refineryCount < BOT_MAX_REFINERIES
    && hvForExpand >= BOT_EXPAND_MIN_HARVESTERS
    && livingMhqs.length === 0
    && !mhqQueued
    && !hqCoveringExpand
    && !fieldCoveredByOwnedHq(player.id, expandField);
  const expandNeedsMobileHq =
    wantsPreemptiveMhq
    || (
      builtRefineryCount >= hqCount
      && hqGunsReady
      && refineryCount < BOT_MAX_REFINERIES
      && !!expandField
      && !expandPadReady
      && !hqCoveringExpand
      && !fieldCoveredByOwnedHq(player.id, expandField)
      && livingMhqs.length === 0
      && !mhqQueued
      && !expandSiteIsHostile(player, expandField.x, expandField.z)
    );
  // First expansion open until 2nd refinery — bank MHQ first, then the pad.
  const firstExpandOpen = hasFactory && refineryCount < 2;
  const expandPadBank = BOT_ECON_EXPAND_CREDITS + 150;
  const expandReserve =
    expandNeedsMobileHq
      ? mhqCost // only reserve MHQ price — earn the pad bank while it marches
      : (hasMobileHqUnit || mhqQueued) && firstExpandOpen
        ? expandPadBank
        : firstExpandOpen
          ? expandPadBank
          : 0;

  const maxQueue = Math.max(BOT_MAX_PRODUCTION_QUEUE, 1 + Math.floor(personality.aggression * 2));
  const producers = buildings.filter(b => b.isBuilt && b.productionQueue.length < maxQueue);
  producers.sort((a, b) => (a.type === 'warFactory' ? -1 : 1));

  let creditReservation = 0;
  if (savingForFactory) creditReservation = Math.max(creditReservation, 600);
  if (firstExpandOpen) {
    creditReservation = Math.max(creditReservation, expandReserve);
  }
  const hvAlive = State.getPlayerUnits(player.id).filter(u => u.type === 'harvester' && u.hp > 0).length;
  // Don't reserve HV cash while banking the first MHQ — trucks are intentionally soft-capped.
  if (
    hvAlive < BOT_HARVESTER_GLOBAL_CAP
    && !(firstExpandOpen && !hasMobileHqUnit && !mhqQueued)
  ) {
    creditReservation = Math.max(creditReservation, 200);
  }
  const ecoStable = !!mem.economyStable;
  let nonScoutCombat = combatUnits.filter(u => u.type !== 'scoutBike' && u.hp > 0).length;
  // Count combat already in production queues so soft-cap isn't bypassed by multi-tick queues.
  for (const b of buildings) {
    if (!b.productionQueue) continue;
    for (const q of b.productionQueue) {
      const ut = q.unitType;
      if (!ut || ut === 'harvester' || ut === 'scoutBike' || ut === 'mobileHq' || ut === 'engineer') continue;
      nonScoutCombat++;
    }
  }
  let threatLv = mem.threatLevel || 0;
  if (mem.militaryEmergency) threatLv = Math.max(threatLv, 6);

  // Refund combat sitting behind Mobile HQ — keep scouts (need them to find the next crystal).
  if (firstExpandOpen && !mem.militaryEmergency) {
    for (const b of buildings) {
      if (b.type !== 'warFactory' || !b.productionQueue?.length) continue;
      for (let i = b.productionQueue.length - 1; i >= 0; i--) {
        const ut = b.productionQueue[i].unitType;
        // Keep artillery in the queue. Cancelling it every tick and re-queuing
        // the siege answer meant the guns never finished (trace: 40+ trains, 1 built).
        if (ut === 'mobileHq' || ut === 'scoutBike' || ut === 'artillery') continue;
        Buildings.cancelUnit(b.id, ut);
        credits = player.credits;
      }
    }
  }

  producers.forEach(b => {
    if (b.type === 'warFactory') {
      const discoveredN = (mem.discoveredResources || []).length;
      const bikes = State.getPlayerUnits(player.id).filter(u => u.type === 'scoutBike' && u.hp > 0).length;
      const queuedBikes = buildings
        .filter(bb => bb.type === 'warFactory')
        .reduce((n, bb) => n + bb.productionQueue.filter(q => q.unitType === 'scoutBike').length, 0);
      const needExpandScout =
        firstExpandOpen
        && discoveredN < 2
        && (bikes + queuedBikes) < 2;
      // Hard-priority: queue Mobile HQ the instant factory can — before pickCounter / scouts.
      if (
        expandNeedsMobileHq
        && !hasMobileHqUnit
        && !mhqQueued
        && credits >= mhqCost
      ) {
        if (Buildings.queueUnit(b.id, 'mobileHq')) {
          credits -= mhqCost;
          mhqQueued = true;
          if (expandFieldId) mem.expandCommitFieldId = expandFieldId;
        }
        return;
      }
      if ((enemyAnalysis.types?.artillery || 0) > 0) mem._seenEnemyArtillery = true;
      let type = pickCounterUnit(enemyAnalysis, 'vehicle', threatLv, credits, personality, mem);
      const wantsArtyAnswer =
        type === 'artillery' && !!mem._seenEnemyArtillery;
      if (
        !wantsArtyAnswer
        && (personality.artilleryAffinity ?? 0) < 0.7
        && (needExpandScout
          || botNeedsExpansionScouting(player)
          || botNeedsEnemyHqScouting(player)
          || botNeedsPriorityResourceExploration(player)
          || (refineryCount < 2 && !hasMobileHqUnit))
        && credits >= (UNIT_TYPES.scoutBike?.cost || 200)
      ) {
        const bikeTarget = needExpandScout ? 2 : 3;
        if (bikes + queuedBikes < bikeTarget) type = 'scoutBike';
      }
      // One recon buggy even for a siege profile. It only visits crystals that
      // are still in fog and not sitting on an enemy spawn.
      if (
        (personality.artilleryAffinity ?? 0) >= 0.7
        && bikes + queuedBikes < 1
        && refineryCount >= 1
        && nearestSafeUnexploredCrystal(player)
        && credits >= (UNIT_TYPES.scoutBike?.cost || 125)
      ) {
        let artyBuilt = 0;
        const aliveNow = State.getPlayerUnits(player.id);
        for (let ai = 0; ai < aliveNow.length; ai++) {
          if (aliveNow[ai].type === 'artillery' && aliveNow[ai].hp > 0) artyBuilt++;
        }
        if (artyBuilt >= 2) type = 'scoutBike';
      }
      const isExpandMhq = false;
      const isScoutBike = type === 'scoutBike';
      const isArtilleryAnswer =
        type === 'artillery'
        && (!!mem._seenEnemyArtillery || (personality.artilleryAffinity ?? 0) >= 0.7);

      // HARD HOLD: while first expand is open, only Mobile HQ + ore/intel scouts leave the factory.
      // Exception: if already being shelled, allow artillery answers through.
      if (firstExpandOpen && !isExpandMhq && !isScoutBike && !mem.militaryEmergency && !isArtilleryAnswer) {
        return;
      }
      // Two mobile guns with the MHQ (human queued exactly that), then stop
      // until the second refinery is up. More than that eats the expand bank.
      if (isArtilleryAnswer && refineryCount < 2 && credits < 1800) {
        let artyN = 0;
        const alive = State.getPlayerUnits(player.id);
        for (let ai = 0; ai < alive.length; ai++) {
          if (alive[ai].type === 'artillery' && alive[ai].hp > 0) artyN++;
        }
        for (let bi = 0; bi < buildings.length; bi++) {
          const q = buildings[bi].productionQueue;
          if (!q) continue;
          for (let qi = 0; qi < q.length; qi++) {
            if (q[qi].unitType === 'artillery') artyN++;
          }
        }
        if (artyN >= 2) return;
      }
      if (type === 'artillery') {
        let artyN = 0;
        const aliveArty = State.getPlayerUnits(player.id);
        for (let ai = 0; ai < aliveArty.length; ai++) {
          if (aliveArty[ai].type === 'artillery' && aliveArty[ai].hp > 0) artyN++;
        }
        for (let bi = 0; bi < buildings.length; bi++) {
          const q = buildings[bi].productionQueue;
          if (!q) continue;
          for (let qi = 0; qi < q.length; qi++) {
            if (q[qi].unitType === 'artillery') artyN++;
          }
        }
        if (artyN >= 8) return;
      }

      // Soft-cap army before eco stable — but never downgrade artillery when answering siege.
      if (
        !mem.militaryEmergency
        && !isExpandMhq
        && !isScoutBike
        && !isArtilleryAnswer
        && (refineryCount < 2 || !ecoStable)
      ) {
        if (nonScoutCombat >= BOT_DEFENSE_ARMY_SOFT_CAP) return;
        if (type === 'heavyTank' || type === 'artillery' || type === 'apc') {
          type = 'lightTank';
        }
      }
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

      // MHQ spends through the expand reservation; critical expand scouts may dip into the MHQ bank.
      // Siege answers also spend through — surviving artillery is worth delaying the expand a beat.
      const expandBankFloor = expandNeedsMobileHq ? mhqCost : expandPadBank;
      const canAfford =
        isExpandMhq || isArtilleryAnswer
          ? credits >= cost
          : isScoutBike && firstExpandOpen
            ? (needExpandScout ? credits >= cost : credits - expandBankFloor >= cost)
            : credits - creditReservation >= cost;
      if (canAfford) {
        if (Buildings.queueUnit(b.id, type)) {
          credits -= cost;
        }
      } else if (!isExpandMhq && !isScoutBike && credits >= cost * 0.55) {
        creditReservation = Math.max(creditReservation, cost);
      }
    } 
    else if (b.type === 'barracks') {
      // Siege profiles answer guns with artillery, not a rifleman parade.
      const siegeGuns = (personality.artilleryAffinity ?? 0) >= 0.65 || !!mem._seenEnemyArtillery;
      if (siegeGuns) return;
      // Don't drain the factory / expand pad bank on infantry.
      if (savingForFactory && !mem.militaryEmergency) return;
      if (firstExpandOpen && !mem.militaryEmergency) return;
      // Same army soft-cap as factory — don't flood rifles before expand.
      if (
        !mem.militaryEmergency
        && (refineryCount < 2 || !ecoStable)
        && nonScoutCombat >= BOT_DEFENSE_ARMY_SOFT_CAP
      ) {
        return;
      }

      const mySnipers = combatUnits.filter(u => u.type === 'sniper');
      const sniperCost = UNIT_TYPES.sniper.cost;
      const vsSnipers = (enemyAnalysis.types?.sniper || 0) > 0;
      const minSnipers =
        hasFactory
          ? 0
          : mem.militaryEmergency && (enemyAnalysis.vehicle > 0 || vsSnipers)
            ? 1
            : 2;

      if (!hasFactory && mySnipers.length < minSnipers) {
        // Respect factory bank — snipers used to ignore reservation and drain $600.
        if (credits - creditReservation >= sniperCost) {
          if (Buildings.queueUnit(b.id, 'sniper')) credits -= sniperCost;
        }
      } else {
        let type = pickCounterUnit(enemyAnalysis, 'infantry', threatLv, credits, personality, mem);
        if (mem.militaryEmergency && enemyAnalysis.vehicle > 0) type = 'rocketSoldier';
        // Prefer cheap riflemen while banking for factory
        if (savingForFactory) type = 'rifleman';
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
  const ecoStableRally = !!mem.economyStable;
  const rallyIds = [];
  for (let i = 0; i < combatUnits.length; i++) {
    const u = combatUnits[i];
    // Story base garrisons must stay on their pad — herding them to the primary HQ rally
    // yanked them off-leash so damage reactions instantly cancelled (no return fire + stutter).
    if (u.botRole === 'garrison') continue;
    // Scouts never mass-rally — that clumps 4–5 bikes on one pad (looks like a convoy).
    // Artillery stays off the home pad so a siege profile can move the guns up.
    if (u.type === 'scoutBike' || u.type === 'artillery') continue;
    const onMission = mem.currentMissions.some(m => m.unitIds.includes(u.id));
    if (u.state === 'idle' && !onMission) {
      if (econExplore && u.type === 'scoutBike') continue;
      // While economy is spinning up, keep units on their guard pads — don't herd everyone
      // to one rally (that left refineries naked).
      if (!ecoStableRally && u.guardPos) {
        const gd = Pathfinding.getDistanceSq(u.x, u.z, u.guardPos.x, u.guardPos.z);
        if (gd < 14 * 14) continue;
      }
      if (Pathfinding.getDistanceSq(u.x, u.z, rallyPoint.x, rallyPoint.z) > 100) {
        rallyIds.push(u.id);
      }
    }
  }
  // One group move = one human APM action (not N individual clicks).
  if (rallyIds.length > 0 && botTrySpendOrders(mem, 1)) {
    Units.commandAttackMove(rallyIds, rallyPoint.x, rallyPoint.z);
  }
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
  return (t.sniper || 0) > 0 || (t.artillery || 0) > 0 || (t.artilleryTurret || 0) > 0;
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

/**
 * Ore loop is healthy: built refinery, enough harvesters, most of them actually mining/hauling.
 * Offense (STRIKE/PUSH/HARASS) stays gated until this is true (unless militaryEmergency).
 */
function computeEconomyStable(player, harvesters, buildings) {
  const refs = (buildings || State.getPlayerBuildings(player.id)).filter(
    b => b.type === 'refinery' && b.isBuilt && b.hp > 0
  );
  if (refs.length < 1) return false;
  const hv = harvesters.filter(h => h.hp > 0);
  if (hv.length < BOT_MIN_STABLE_HARVESTERS) return false;
  const working = hv.filter(h =>
    h.state === 'movingToField'
    || h.state === 'harvesting'
    || h.state === 'movingToRefinery'
    || h.state === 'depositing'
  ).length;
  if (working < BOT_MIN_STABLE_WORKING) return false;
  return true;
}

function isHarvesterWorking(h) {
  return !!h && (
    h.state === 'movingToField'
    || h.state === 'harvesting'
    || h.state === 'movingToRefinery'
    || h.state === 'depositing'
  );
}

/**
 * Park combat on every HQ + refinery so raid response is local, not a single rally blob.
 */
function assignBaseGuards(player, combatUnits, buildings, elapsed) {
  const mem = player.botMemory;
  if (elapsed - (mem._guardAssignAt || 0) < 2.5) return;
  mem._guardAssignAt = elapsed;

  const sites = [];
  for (const b of buildings) {
    if (b.hp <= 0) continue;
    if (b.type === 'hq') sites.push({ b, want: BOT_GUARD_PER_HQ });
    else if (b.type === 'refinery' && b.isBuilt) sites.push({ b, want: BOT_GUARD_PER_REFINERY });
  }
  if (sites.length === 0) return;

  const free = combatUnits.filter(u => {
    if (u.hp <= 0 || u.type === 'scoutBike' || u.type === 'artillery' || u.botRole === 'garrison') return false;
    if (mem.currentMissions.some(m => m.unitIds.includes(u.id))) return false;
    if (u.state === 'attacking') return false;
    return true;
  });

  const assigned = new Set();
  const moves = [];

  for (const site of sites) {
    const near = free
      .filter(u => !assigned.has(u.id))
      .map(u => ({
        u,
        d: Pathfinding.getDistanceSq(u.x, u.z, site.b.x, site.b.z),
      }))
      .sort((a, b) => a.d - b.d);

    let have = 0;
    for (const row of near) {
      if (have >= site.want) break;
      const u = row.u;
      assigned.add(u.id);
      have++;
      const gx = site.b.x + (have % 2 === 0 ? 6 : -6);
      const gz = site.b.z + (have % 3 === 0 ? 5 : -5);
      const pad = clampWorldToPlayableDisk(gx, gz, 2);
      u.guardPos = { x: pad.x, z: pad.z };
      u.homeBasePos = { x: site.b.x, z: site.b.z };
      const dist = Pathfinding.getDistance(u.x, u.z, pad.x, pad.z);
      if (dist > 10 && (u.state === 'idle' || (u.state === 'moving' && !u.playerCommanded))) {
        moves.push(u.id);
        u._guardMoveTo = pad;
      }
    }
  }

  // Batch one move per distinct pad — keep APM cheap: move all needing reposition toward nearest site.
  if (moves.length === 0 || !botTrySpendOrders(mem, 1)) return;
  // Group by approximate pad
  const byPad = new Map();
  for (const id of moves) {
    const u = State.units.get(id);
    if (!u?._guardMoveTo) continue;
    const key = `${u._guardMoveTo.x.toFixed(0)},${u._guardMoveTo.z.toFixed(0)}`;
    if (!byPad.has(key)) byPad.set(key, { pos: u._guardMoveTo, ids: [] });
    byPad.get(key).ids.push(id);
    delete u._guardMoveTo;
  }
  let first = true;
  for (const group of byPad.values()) {
    if (!first && !botTrySpendOrders(mem, 1)) break;
    first = false;
    Units.commandAttackMove(group.ids, group.pos.x, group.pos.z);
  }
}

// --- ATTACK: Send army wave ---
/**
 * Threats to our bases AND Mobile HQs — includes enemy static guns in range.
 * (Old code only scanned units near buildings, so artilleryTurrets were invisible.)
 */
function getThreatsToAssets(player, buildings, units) {
  const threats = [];
  const pushThreat = (t, kind) => {
    if (!t || t.hp <= 0) return;
    if (threats.some(e => e.id === t.id)) return;
    threats.push({ ...t, _threatKind: kind || (t.category ? 'unit' : 'building') });
  };

  const checkNear = (x, z, radius) => {
    unitGrid.queryRadiusFiltered(
      x, z, radius,
      e =>
        e.team !== player.team &&
        e.hp > 0 &&
        Fog.isVisibleToTeam(player.team, e.x, e.z)
    ).forEach(t => pushThreat(t, 'unit'));
  };

  buildings.forEach(b => {
    if (b.hp <= 0) return;
    checkNear(b.x, b.z, BOT_DEFEND_RADIUS);
  });
  (units || []).forEach(u => {
    if (u.hp <= 0 || u.type !== 'mobileHq') return;
    checkNear(u.x, u.z, BOT_DEFEND_RADIUS + 10);
  });

  // Enemy defense buildings whose range overlaps our assets.
  State.buildings.forEach(b => {
    if (b.hp <= 0 || !b.isBuilt) return;
    if (b.team === player.team) return;
    if (b.type !== 'turret' && b.type !== 'artilleryTurret') return;
    if (!Fog.isVisibleToTeam(player.team, b.x, b.z) && !Fog.wasExploredByTeam(player.team, b.x, b.z)) {
      return;
    }
    const range = (BUILDING_TYPES[b.type]?.range || 16) + 4;
    const range2 = range * range;
    let hitsUs = false;
    for (let i = 0; i < buildings.length; i++) {
      const ours = buildings[i];
      if (ours.hp <= 0) continue;
      if (Pathfinding.getDistanceSq(ours.x, ours.z, b.x, b.z) <= range2) {
        hitsUs = true;
        break;
      }
    }
    if (!hitsUs && units) {
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u.hp <= 0 || (u.type !== 'mobileHq' && u.type !== 'harvester')) continue;
        if (Pathfinding.getDistanceSq(u.x, u.z, b.x, b.z) <= range2) {
          hitsUs = true;
          break;
        }
      }
    }
    if (hitsUs) pushThreat(b, 'building');
  });

  return threats;
}

/** Send combat to kill the gun shelling our Mobile HQ; mark the pad as hostile. */
function defendMobileHqUnderFire(player, combatUnits, elapsed) {
  const mem = player.botMemory;
  const mhqs = State.getPlayerUnits(player.id).filter(u => u.type === 'mobileHq' && u.hp > 0);
  if (mhqs.length === 0) return;

  for (const mhq of mhqs) {
    const underFire =
      (mhq._botDamagedAt != null && elapsed - mhq._botDamagedAt < 6)
      || expandSiteIsHostile(player, mhq.x, mhq.z);
    if (!underFire) continue;

    // Do not blacklist the crystal the MHQ is marching to. A hit on the road
    // was marking resource_5 hostile for 90s, then base guards drove the MHQ home.
    // The damage handler already blacklists the crystal nearest the attacker.

    // Find the nearest visible/known static gun or artillery unit.
    let gun = null;
    let bestD = Infinity;
    State.buildings.forEach(b => {
      if (b.hp <= 0 || b.team === player.team) return;
      if (b.type !== 'artilleryTurret' && b.type !== 'turret') return;
      if (!Fog.isVisibleToTeam(player.team, b.x, b.z) && !Fog.wasExploredByTeam(player.team, b.x, b.z)) {
        return;
      }
      const d = Pathfinding.getDistanceSq(mhq.x, mhq.z, b.x, b.z);
      const reach = ((BUILDING_TYPES[b.type]?.range || 16) + 8) ** 2;
      if (d <= reach && d < bestD) {
        bestD = d;
        gun = b;
      }
    });
    if (!gun) {
      State.units.forEach(u => {
        if (u.hp <= 0 || u.team === player.team || u.type !== 'artillery') return;
        if (!Fog.isVisibleToTeam(player.team, u.x, u.z)) return;
        const d = Pathfinding.getDistanceSq(mhq.x, mhq.z, u.x, u.z);
        if (d < 80 * 80 && d < bestD) {
          bestD = d;
          gun = u;
        }
      });
    }
    if (!gun) continue;

    const responders = combatUnits.filter(u => {
      if (u.hp <= 0 || u.type === 'scoutBike' || u.type === 'mobileHq') return false;
      if (unitOnScoutMission(mem, u.id)) return false;
      if (u._botDefenseCmdAt != null && elapsed - u._botDefenseCmdAt < 1.2) return false;
      // Pull from nearest base / already near the fight — don't strand home if we're tiny.
      const home = unitHomeDefendAnchor(u);
      const nearFight = Pathfinding.getDistance(u.x, u.z, mhq.x, mhq.z) < 90;
      const nearHomeToMhq = home
        ? Pathfinding.getDistance(home.x, home.z, mhq.x, mhq.z) < 100
        : nearFight;
      return nearFight || nearHomeToMhq;
    });
    if (responders.length < 1 || !botTrySpendOrders(mem, 1)) continue;

    const ids = responders.slice(0, 8).map(u => u.id);
    if (gun.category) {
      commandBotEngageEnemyUnits(ids, gun);
    } else {
      Units.commandAttackBuilding(ids, gun.id);
    }
    const stamped = elapsed;
    for (const id of ids) {
      const u = State.units.get(id);
      if (u) u._botDefenseCmdAt = stamped;
    }
    mem.militaryEmergency = true;
  }
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

  // Prefer units whose home base is near the hot zone (Story multi-base).
  // NEVER fall back to the global idle pool — that was pulling other bases across the map.
  const localR = BOT_DEFEND_RADIUS + 18;
  const localIdle = idleUnits.filter(u => {
    const home = unitHomeDefendAnchor(u);
    if (home) {
      return Pathfinding.getDistance(home.x, home.z, hotZone.x, hotZone.z) <= localR;
    }
    // Untagged (no home): only join if already at the fight — never cross-map "assist".
    return Pathfinding.getDistance(u.x, u.z, hotZone.x, hotZone.z) <= localR;
  });
  if (localIdle.length === 0) return null;
  const pool = localIdle;

  let missionUnits;
  let targetPos = { x: hotZone.x, z: hotZone.z };

  if (longRangeNest) {
    const capable = pool.filter(u => canCounterLongRange(u));
    const need = Math.min(requiredPower + 2, Math.max(4, capable.length));
    if (capable.length < 1) return null;
    missionUnits = capable.slice(0, need);
    if (hq) targetPos = retaliationFlankPos(hq, hotZone);
  } else {
    const combatUnits = pool.filter(u => u.type !== 'scoutBike');
    if (combatUnits.length < 1) return null;
    // Take whoever is local — do not wait for a map-wide power count (that skipped locals
    // and previously triggered the global-pool fallback).
    missionUnits = combatUnits.slice(0, Math.min(requiredPower + 2, combatUnits.length));
  }

  {
    const rawTx = targetPos.x;
    const rawTz = targetPos.z;
    const lead = missionUnits[0];
    if (lead) {
      let ax = lead.x;
      let az = lead.z;
      if (!Pathfinding.isPositionWalkable(ax, az)) {
        const po = Pathfinding.snapOutOfObstacle(ax, az);
        ax = po.x;
        az = po.z;
      }
      targetPos =
        Pathfinding.findNearestReachable(ax, az, rawTx, rawTz, 52) ||
        clampWorldToPlayableDisk(rawTx, rawTz, 2);
    } else {
      targetPos = clampWorldToPlayableDisk(rawTx, rawTz, 2);
    }
  }

  if (!botCanSpendOrder(mem)) return null;

  const mission = {
    type: 'retaliation',
    targetId: hotZone.time,
    targetPos,
    unitIds: missionUnits.map(u => u.id),
  };
  mem.currentMissions.push(mission);

  Units.commandAttackMove(mission.unitIds, targetPos.x, targetPos.z);
  botSpendOrder(mem);
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
      if (m.status === 'complete') return false;
      const age = elapsed - (m.startedAt ?? 0);
      return age < BOT_SCOUT_MISSION_MAX_SEC;
    }

    if (m.type === 'retaliation') {
      const age = elapsed - (typeof m.targetId === 'number' ? m.targetId : 0);
      return age < 120;
    }

    if (m.type === 'PUSH') {
      const age = elapsed - (m.startedAt ?? elapsed);
      if (age > 90) return false;
    }

    if (m.type === 'RECON') {
      if (m.status === 'complete') return false;
      return true;
    }

    if (m.type === 'SIEGE') {
      const still = m.unitIds.some(id => {
        const u = State.units.get(id);
        return u && u.hp > 0;
      });
      if (!still) return false;
      return true;
    }

    if (m.targetId == null) return true;

    const target = State.units.get(m.targetId) || State.buildings.get(m.targetId);
    if (!target || target.hp <= 0) return false;
    return true;
  });

  const idleUnits = combatUnits.filter(u => u.state === 'idle' && !mem.currentMissions.some(m => m.unitIds.includes(u.id)));

  // 1. RETALIATION (Overtake Danger Zones) — never early-return; strikes still form this tick.
  manageRetaliation(player, idleUnits);

  // Recompute idle after retaliation may have claimed units.
  const idleAfter = combatUnits.filter(u => u.state === 'idle' && !mem.currentMissions.some(m => m.unitIds.includes(u.id)));

  // Strategic offense only after a real ore loop: stable harvest + ≥2 refineries.
  // militaryEmergency still drives handleDefense / escorts — not map-wide pushes.
  const cooldown = mem.harassCooldownUntil || (mem.harassCooldownUntil = {});
  const refCount = State.getPlayerBuildingsOfType(pid, 'refinery').filter(b => b.hp > 0).length;
  const armyN = combatUnits.filter(u => u.type !== 'scoutBike' && u.type !== 'mobileHq' && u.hp > 0).length;
  // A real squad is allowed to fight once the second base exists — don't wait on 8 harvesters.
  const canOffense = refCount >= 2 && (!!mem.economyStable || armyN >= BOT_ATTACK_THRESHOLD);
  const enemyHarvesters = canOffense ? mem.targets.filter(t => {
    const unit = State.units.get(t.id);
    const ready = !cooldown[t.id] || elapsed >= cooldown[t.id];
    return unit && unit.type === 'harvester' && ready;
  }) : [];

  if (enemyHarvesters.length > 0) {
    const target = enemyHarvesters[0];
    const needOre = botNeedsPriorityResourceExploration(player);
    const pool = needOre
      ? idleAfter.filter(u => u.type === 'sniper')
      : idleAfter.filter(u => u.type === 'scoutBike' || u.type === 'sniper');
    const assassins = pool.slice(0, 3);
    if (assassins.length >= 2) {
      const prey = State.units.get(target.id);
      if (prey && prey.hp > 0 && botTrySpendOrders(mem, 1)) {
        const rally = clampWorldToPlayableDisk(prey.x, prey.z, 2);
        mem.currentMissions.push({ type: 'HARASS', targetId: target.id, unitIds: assassins.map(u => u.id), status: 'active' });
        Units.commandAttackMove(assassins.map(u => u.id), rally.x, rally.z);
        cooldown[target.id] = elapsed + BOT_HARASS_COOLDOWN_SEC;
      }
    }
  }

  const baseMin = BOT_ATTACK_THRESHOLD;
  const baseMax = BOT_FULL_ATTACK_THRESHOLD;
  const personalityModifier = Math.floor((1.0 - personality.aggression) * (baseMax - baseMin));
  let strikeThreshold = Math.max(
    baseMin,
    Math.min(baseMax + 5, baseMin + personalityModifier + Math.floor(mem.threatLevel / 2))
  ); 
  
  // Available units must NOT be scout bikes (they are too weak for striking)
  const siegeGuns = (personality.artilleryAffinity ?? 0) >= 0.7;
  const availableStrikeUnits = combatUnits.filter(u =>
    u.type !== 'scoutBike'
    && !(siegeGuns && u.type === 'artillery')
    && !mem.currentMissions.some(m => m.unitIds.includes(u.id))
  );

  const alreadyStriking = mem.currentMissions.some(m => m.type === 'STRIKE' || m.type === 'PUSH');
  const unitsReservedForDefense = Math.max(4, Math.ceil(strikeThreshold * BOT_STRIKE_RESERVE_MULT));

  // Prefer known enemy buildings; fall back to last-seen enemy HQ / any known enemy building.
  const buildingTargets = mem.targets.filter(t => {
    if (t.type !== 'building') return false;
    const b = State.buildings.get(t.id);
    return b && b.hp > 0;
  });

  // The gun march does not wait on a second refinery or a strike budget.
  issueSiegeMarch(player, mem, personality, availableStrikeUnits, refCount, elapsed);

  // No strategic offense until ore loop is stable — defense + economy first.
  if (!canOffense) return;

  if (!alreadyStriking && buildingTargets.length > 0 && botCanSpendOrder(mem)) {
    buildingTargets.sort((a, b) => {
        const bA = State.buildings.get(a.id);
        const bB = State.buildings.get(b.id);
        const scoreA = bA.type === 'hq' ? 100 : (bA.type === 'warFactory' || bA.type === 'barracks' ? 50 : 10);
        const scoreB = bB.type === 'hq' ? 100 : (bB.type === 'warFactory' || bB.type === 'barracks' ? 50 : 10);
        return scoreB - scoreA;
      });
    let target = null;
    let tb = null;
    for (let ti = 0; ti < buildingTargets.length; ti++) {
      const cand = buildingTargets[ti];
      const bld = State.buildings.get(cand.id);
      if (!bld || bld.hp <= 0) continue;
      const gunTarget = bld.type === 'artilleryTurret' || bld.type === 'artillery';
      if (gunTarget && !availableStrikeUnits.some(u => u.type === 'artillery')) continue;
      target = cand;
      tb = bld;
      break;
    }
    if (tb && tb.hp > 0) {
      const defenders = countKnownDefendersNear(mem, target.x, target.z, 28);
      const neededForTarget =
        tb.type === 'hq'
          ? Math.max(BOT_HQ_STRIKE_MIN, Math.ceil(defenders * BOT_STRIKE_DEFENDER_MULT) + 4)
          : Math.max(strikeThreshold, Math.ceil(defenders * BOT_STRIKE_DEFENDER_MULT) + 2);
      // Soft gate: allow a push with fewer units once we have a clear objective (coord groups).
      const minPush = Math.max(4, Math.min(strikeThreshold, neededForTarget - 2));
      const canFullStrike =
        availableStrikeUnits.length >= neededForTarget + unitsReservedForDefense;
      const canSoftPush =
        availableStrikeUnits.length >= minPush + unitsReservedForDefense
        && availableStrikeUnits.length >= strikeThreshold;

      const siegeTarget = tb.type === 'artilleryTurret';
      if (siegeTarget) {
        const guns = availableStrikeUnits.filter(u => u.type === 'artillery');
        if (guns.length >= 1) {
          const ids = guns.slice(0, 6).map(u => u.id);
          mem.currentMissions.push({ type: 'STRIKE', targetId: target.id, unitIds: ids, status: 'active' });
          Units.commandAttackBuilding(ids, target.id);
        }
      } else if (canFullStrike || canSoftPush) {
        const squadSize = Math.min(
          availableStrikeUnits.length - unitsReservedForDefense,
          Math.max(minPush, canFullStrike ? neededForTarget : strikeThreshold)
        );
        if (squadSize >= minPush) {
          const strikeSquad = availableStrikeUnits.slice(0, squadSize);
      const ids = strikeSquad.map(u => u.id);
          if (canFullStrike && squadSize >= neededForTarget) {
      mem.currentMissions.push({ type: 'STRIKE', targetId: target.id, unitIds: ids, status: 'active' });
      Units.commandAttackBuilding(ids, target.id);
      UI.showStatus(`🤖 P${pid} is launching a ${strikeSquad.length}-unit strike!`);
          } else {
            // Coordinated group attack-move toward the objective (forms before full overrun force).
            mem.currentMissions.push({
              type: 'PUSH',
              targetId: target.id,
              unitIds: ids,
              status: 'active',
              targetPos: { x: target.x, z: target.z },
              startedAt: elapsed,
            });
            Units.commandAttackMove(ids, target.x, target.z);
            UI.showStatus(`🤖 P${pid} is pushing ${strikeSquad.length} units!`);
          }
          botSpendOrder(mem);
        }
      }
    }
  }

  issueSiegeMarch(player, mem, personality, availableStrikeUnits, refCount, elapsed);
}

function siegeWaypoint(cx, cz, sp) {
  const dx = sp.x - cx;
  const dz = sp.z - cz;
  const len = Math.hypot(dx, dz) || 1;
  const step = Math.min(26, Math.max(0, len - 58));
  let x = cx + (dx / len) * step;
  let z = cz + (dz / len) * step;
  if (!Pathfinding.isPositionWalkable(x, z)) {
    const s = Pathfinding.snapWorldXZToWalkable(x, z);
    x = s.x;
    z = s.z;
  }
  return clampWorldToPlayableDisk(x, z, 4);
}

function enemySpawns(player) {
  const out = [];
  for (let i = 0; i < State.players.length; i++) {
    const p = State.players[i];
    if (!p || !p.isActive || p.isDefeated || p.team === player.team || !p.spawn) continue;
    out.push(p.spawn);
  }
  return out;
}

function seenEnemyHqs(player) {
  const out = [];
  const mem = player.botMemory;
  for (let i = 0; i < (mem.targets || []).length; i++) {
    const t = mem.targets[i];
    if (t.type !== 'building') continue;
    const b = State.buildings.get(t.id);
    if (!b || b.hp <= 0 || b.type !== 'hq') continue;
    const owner = State.players[b.ownerId];
    if (!owner || owner.team === player.team) continue;
    out.push(b);
  }
  return out;
}

/** Crystals still in fog and far enough from an enemy spawn that a buggy can visit. */
function nearestSafeUnexploredCrystal(player) {
  const hq = State.getPlayerHQ(player.id);
  if (!hq) return null;
  const spawns = enemySpawns(player);
  let best = null;
  let bestD = Infinity;
  State.resourceFields.forEach((f) => {
    if (!f || f.depleted) return;
    if (Fog.wasExploredByTeam(player.team, f.x, f.z)) return;
    for (let i = 0; i < spawns.length; i++) {
      if (Math.hypot(f.x - spawns[i].x, f.z - spawns[i].z) < 78) return;
    }
    const d = Math.hypot(f.x - hq.x, f.z - hq.z);
    if (d < bestD) { best = f; bestD = d; }
  });
  return best;
}

function nearestUnseenEnemySpawn(player) {
  const hq = State.getPlayerHQ(player.id);
  if (!hq) return null;
  const seen = seenEnemyHqs(player);
  const spawns = enemySpawns(player);
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i];
    if (Fog.wasExploredByTeam(player.team, s.x, s.z)) continue;
    if (seen.some((b) => Math.hypot(b.x - s.x, b.z - s.z) < 40)) continue;
    const d = Math.hypot(s.x - hq.x, s.z - hq.z);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

/** Second refinery up, a static gun on every headquarters, and a real artillery line. */
function siegeDestroyReady(player) {
  const pid = player.id;
  const buildings = State.getPlayerBuildings(pid);
  const refs = buildings.filter((b) => b.type === 'refinery' && b.hp > 0 && b.isBuilt);
  if (refs.length < 1) return false;
  const turrets = buildings.filter((b) => b.type === 'artilleryTurret' && b.hp > 0);
  if (!turrets.length) return false;
  let arty = 0;
  const units = State.getPlayerUnits(pid);
  for (let i = 0; i < units.length; i++) {
    if (units[i].type === 'artillery' && units[i].hp > 0) arty++;
  }
  return arty >= 6;
}

function stepToward(fromX, fromZ, toX, toZ, step) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const len = Math.hypot(dx, dz) || 1;
  const s = Math.min(step, len);
  return clampWorldToPlayableDisk(fromX + (dx / len) * s, fromZ + (dz / len) * s, 4);
}

function issueSiegeMarch(player, mem, personality, availableStrikeUnits, refCount, elapsed) {
  const siegeAffinity = personality.artilleryAffinity ?? 0;
  if (siegeAffinity < 0.7) return;

  const ready = siegeDestroyReady(player);
  if (!ready) {
    mem.currentMissions = mem.currentMissions.filter((m) => m.type !== 'SIEGE');
    driveDiscoveryGun(player, mem, elapsed);
    return;
  }
  mem.currentMissions = mem.currentMissions.filter((m) => m.type !== 'RECON');

  const guns = State.getPlayerUnits(player.id).filter((u) => u.type === 'artillery' && u.hp > 0);
  if (guns.length < 4) return;
  let lead = guns[0];
  for (let i = 1; i < guns.length; i++) {
    if (guns[i].z > lead.z) lead = guns[i];
  }
  const ids = guns.map((g) => g.id);
  // Human pack orders, mirrored across z. The last point is inside range of the NE headquarters.
  let siegeMission = mem.currentMissions.find((m) => m.type === 'SIEGE');
  if (!siegeMission) {
    siegeMission = {
      type: 'SIEGE',
      unitIds: ids,
      status: 'active',
      startedAt: elapsed,
      targetPos: { x: lead.x, z: lead.z },
      _step: 0,
      _next: 0,
    };
    mem.currentMissions.push(siegeMission);
  }
  siegeMission.unitIds = ids;

  // Same base, in weapon range: headquarters first, then the factory that would rebuild it.
  const siegeRank = { hq: 0, warFactory: 1, barracks: 2, refinery: 3, artilleryTurret: 4, turret: 5, solarPanel: 6 };
  let attack = null;
  let attackRank = 99;
  let attackD = 72;
  State.buildings.forEach((b) => {
    if (!b || b.hp <= 0) return;
    const owner = State.players[b.ownerId];
    if (!owner || owner.team === player.team) return;
    if (!Fog.isVisibleToTeam(player.team, b.x, b.z)) return;
    const d = Math.hypot(b.x - lead.x, b.z - lead.z);
    if (d >= 72) return;
    const rank = siegeRank[b.type] ?? 7;
    if (rank < attackRank || (rank === attackRank && d < attackD)) {
      attack = b;
      attackRank = rank;
      attackD = d;
    }
  });
  if (attack) {
    if (attack.type === 'hq') siegeMission._pad = { x: attack.x, z: attack.z };
    if (siegeMission._atk !== attack.id) {
      siegeMission._atk = attack.id;
      siegeMission._next = elapsed;
      Units.commandAttackBuilding(ids, attack.id);
    }
    return;
  }
  siegeMission._atk = 0;

  // The headquarters is down. Walk onto that pad and shoot whatever is still standing there
  // before leaving for the next base. A player would not march off and leave the factory.
  const pad = siegeMission._pad;
  if (pad && Math.hypot(lead.x - pad.x, lead.z - pad.z) > 28) {
    const hold = siegeMission.targetPos;
    const holdD = hold ? Math.hypot(lead.x - hold.x, lead.z - hold.z) : 999;
    if (!(siegeMission._next && holdD >= 12 && elapsed - siegeMission._next < 12)) {
      siegeMission._next = elapsed;
      siegeMission.targetPos = { x: pad.x, z: pad.z };
      Units.commandMove(ids, pad.x, pad.z, { playerCommanded: true, traceWhy: 'siege' });
    }
    return;
  }
  if (pad) siegeMission._pad = null;

  // A move order to a seen headquarters, the same click a player can issue.
  // Never write unit coordinates.
  const seen = seenEnemyHqs(player);
  let hq = null;
  for (let i = 0; i < seen.length; i++) {
    if (!hq || seen[i].z > hq.z) hq = seen[i];
  }
  let tx = 147;
  let tz = 117;
  if (hq) {
    const dx = lead.x - hq.x;
    const dz = lead.z - hq.z;
    const len = Math.hypot(dx, dz) || 1;
    const stand = clampWorldToPlayableDisk(hq.x + (dx / len) * 60, hq.z + (dz / len) * 60, 4);
    tx = stand.x;
    tz = stand.z;
  }
  const hold = siegeMission.targetPos;
  const holdD = hold ? Math.hypot(lead.x - hold.x, lead.z - hold.z) : 999;
  if (siegeMission._next && holdD >= 12 && elapsed - siegeMission._next < 20) return;
  siegeMission._next = elapsed;
  siegeMission.targetPos = { x: tx, z: tz };
  Units.commandMove(ids, tx, tz, { playerCommanded: true, traceWhy: 'siege' });
}

/**
 * Next hop that is actually walkable.
 * The east column x≈155–200 is open from the south pad to the north base;
 * cells on the rim wall between those columns are not, so never aim across them.
 */
function nextSiegeAim(x, z, gx, gz) {
  const dist = Math.hypot(gx - x, gz - z);
  const posts = dist < 64
    ? [[gx, gz]]
    : z < -30
      ? [[148, z + 16], [144, z + 16], [140, z + 16]]
      : z < 50
        ? [[150, z + 18], [148, z + 16], [140, z + 16]]
        : [[200, Math.min(112, z + 20)], [112, Math.min(112, z + 20)], [152, 118]];
  for (let i = 0; i < posts.length; i++) {
    let px = posts[i][0];
    let pz = posts[i][1];
    if (!Pathfinding.isPositionWalkable(px, pz)) {
      const snapped = Pathfinding.snapOutOfObstacle(px, pz);
      if (!Pathfinding.isPositionWalkable(snapped.x, snapped.z)) continue;
      px = snapped.x;
      pz = snapped.z;
    }
    const path = Pathfinding.findPath(x, z, px, pz);
    if (!path || path.length < 2) continue;
    let aim = path[path.length - 1];
    for (let k = 1; k < path.length; k++) {
      if (Math.hypot(path[k].x - x, path[k].z - z) >= 14) {
        aim = path[k];
        break;
      }
    }
    if (Math.hypot(aim.x - x, aim.z - z) >= 8) return { x: aim.x, z: aim.z };
  }
  return { x, z };
}

function walkableStep(fromX, fromZ, toX, toZ) {
  const dist = Math.hypot(toX - fromX, toZ - fromZ);
  const reached = Pathfinding.findNearestReachable(fromX, fromZ, toX, toZ, 64, true);
  if (reached && Math.hypot(reached.x - toX, reached.z - toZ) < dist - 8) {
    return clampWorldToPlayableDisk(reached.x, reached.z, 4);
  }
  const base = Math.atan2(toX - fromX, toZ - fromZ);
  for (let i = 0; i < 7; i++) {
    const ang = base + (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.45);
    const p = clampWorldToPlayableDisk(fromX + Math.sin(ang) * 32, fromZ + Math.cos(ang) * 32, 4);
    if (!Pathfinding.isPositionWalkable(p.x, p.z)) continue;
    if (Math.hypot(p.x - toX, p.z - toZ) < dist - 6) return p;
  }
  return { x: fromX, z: fromZ };
}

function driveDiscoveryGun(player, mem, elapsed) {
  const home = State.getPlayerHQ(player.id);
  if (!home) return;
  const guns = State.getPlayerUnits(player.id).filter((u) => u.type === 'artillery' && u.hp > 0);
  if (!guns.length) return;
  let mission = mem.currentMissions.find((m) => m.type === 'RECON');
  let gun = mission ? State.units.get(mission.unitIds[0]) : null;
  if (!gun || gun.hp <= 0) {
    gun = guns[0];
    mission = {
      type: 'RECON',
      unitIds: [gun.id],
      status: 'active',
      startedAt: elapsed,
      targetPos: { x: gun.x, z: gun.z },
      _next: 0,
      _hp: gun.hp,
    };
    mem.currentMissions.push(mission);
  }
  mission.unitIds = [gun.id];
  const hurt = gun.hp < (mission._hp || gun.hp) - 8;
  mission._hp = gun.hp;
  if (hurt) mission._flee = elapsed + 10;
  const hold = mission.targetPos;
  const holdD = hold ? Math.hypot(gun.x - hold.x, gun.z - hold.z) : 999;
  const arrived = holdD < 14 || gun.state !== 'moving';
  if (!arrived && elapsed - (mission._next || 0) < 20) return;
  mission._next = elapsed;
  let tx = home.x;
  let tz = home.z;
  if (!(mission._flee && elapsed < mission._flee)) {
    const spawn = nearestUnseenEnemySpawn(player);
    if (spawn) {
      const dx = home.x - spawn.x;
      const dz = home.z - spawn.z;
      const len = Math.hypot(dx, dz) || 1;
      const stand = clampWorldToPlayableDisk(spawn.x + (dx / len) * 64, spawn.z + (dz / len) * 64, 6);
      tx = stand.x;
      tz = stand.z;
    } else {
      let hidden = null;
      let bestD = Infinity;
      State.resourceFields.forEach((f) => {
        if (!f || f.depleted || Fog.wasExploredByTeam(player.team, f.x, f.z)) return;
        const d = Math.hypot(f.x - gun.x, f.z - gun.z);
        if (d < bestD) { hidden = f; bestD = d; }
      });
      if (!hidden) {
        mission.status = 'complete';
        return;
      }
      tx = hidden.x;
      tz = hidden.z;
    }
  }
  const aim = stepToward(gun.x, gun.z, tx, tz, 36);
  mission.targetPos = { x: aim.x, z: aim.z };
  Units.commandMove([gun.id], aim.x, aim.z, { playerCommanded: true, traceWhy: 'recon' });
}

function unitOnScoutMission(mem, unitId) {
  return mem.currentMissions.some(m => m.type === 'SCOUT' && m.unitIds.includes(unitId));
}

/** Known enemy combat near a point (fair: only last-seen target memory). */
function countKnownDefendersNear(mem, x, z, radius) {
  const r2 = radius * radius;
  let n = 0;
  for (let i = 0; i < (mem.targets || []).length; i++) {
    const t = mem.targets[i];
    if (t.type === 'building') continue;
    if (Pathfinding.getDistanceSq(t.x, t.z, x, z) > r2) continue;
    const u = State.units.get(t.id);
    if (u && u.hp > 0 && u.damage > 0) n++;
    else if (!u) n++; // stale contact still counts as risk
  }
  return n;
}

function assignBotScoutMissions(player, combatUnits, elapsed) {
  const mem = player.botMemory;
  const pid = player.id;
  const hq = State.getPlayerHQ(pid);
  if (!hq) return;

  const econCritical = botNeedsPriorityResourceExploration(player);
  const expandScout = botNeedsExpansionScouting(player);
  const intelScout = botNeedsEnemyHqScouting(player);
  const startDelay = econCritical
    ? BOT_SCOUT_DELAY_ECON
    : expandScout
      ? 6
      : intelScout
        ? BOT_SCOUT_DELAY_INTEL
        : BOT_SCOUT_DELAY;
  if (elapsed < startDelay) return;

  const maxScouts = econCritical
    ? Math.min(BOT_SCOUT_CAP_ECON, 4)
    : expandScout
      ? BOT_SCOUT_CAP
      : intelScout
        ? (countUnclaimedDiscoveredFields(player) > 0 ? 2 : BOT_SCOUT_CAP_INTEL)
        : BOT_SCOUT_CAP;
  const currentScoutMissions = mem.currentMissions.filter(m => m.type === 'SCOUT');
  if (currentScoutMissions.length >= maxScouts) return;

  const scoutGap = econCritical
    ? BOT_SCOUT_GAP_ECON
    : expandScout
      ? 2.5
      : intelScout
        ? BOT_SCOUT_GAP_INTEL
        : 6.0;
  if (elapsed - (mem.lastScoutMissionTime || 0) < scoutGap) return;

  const candidates = combatUnits.filter(u => !mem.currentMissions.some(m => m.unitIds.includes(u.id)));
  // Prefer idle scout bikes; never send a bike that is already mid-move with another bike.
  const candidate =
    candidates.find(u => u.type === 'scoutBike' && u.state === 'idle') ||
    candidates.find(u => u.type === 'scoutBike') ||
    candidates.find(u => u.category === 'infantry' && u.state === 'idle');
  if (!candidate) return;

  const hv = State.getPlayerUnits(pid).filter(u => u.type === 'harvester');
  // Exclude active scout destinations so new scouts fan out instead of convoy-stacking.
  const activeScoutGoals = collectActiveScoutTargets(mem);
  const excludePrev = activeScoutGoals.length > 0 ? activeScoutGoals[activeScoutGoals.length - 1] : null;
  const target = getScoutTarget(player, hq, elapsed, excludePrev, hv);
  if (!target) return;
  // Reject destinations too close to another active scout (hard spread).
  const minSep2 = 40 * 40;
  if (activeScoutGoals.some(g => Pathfinding.getDistanceSq(g.x, g.z, target.x, target.z) < minSep2)) {
    const fogAlt = pickSingleExploreWaypointDiverse(player, hq, mem, elapsed, excludePrev, hv);
    if (!fogAlt) return;
    if (activeScoutGoals.some(g => Pathfinding.getDistanceSq(g.x, g.z, fogAlt.x, fogAlt.z) < minSep2)) return;
    Object.assign(target, fogAlt);
  }
  if (!botTrySpendOrders(mem, 1)) return;

  mem.lastScoutMissionTime = elapsed;
  mem.currentMissions.push({
    type: 'SCOUT',
    targetId: null,
    unitIds: [candidate.id],
    status: 'active',
    targetPos: target,
    startedAt: elapsed,
    _lastReissue: elapsed,
    _intel: !!target._intel,
  });
  // Intel marches use player-style move so auto-acquire doesn't halt 40m short of the HQ (vision 25).
  if (target._intel) {
    Units.commandMove([candidate.id], target.x, target.z, { playerCommanded: true });
  } else {
  Units.commandAttackMove([candidate.id], target.x, target.z);
  }
}

/**
 * Send idle harvesters into fog ONLY when the team knows ZERO live ore.
 * Never yank workers off a known crystal to "scout" — that left trucks walking past ore.
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
      (h.state === 'idle' || h.state === 'moving') &&
      (h.cargo || 0) === 0 &&
      !unitOnScoutMission(mem, h.id) &&
      elapsed - (h._botExploreCmdAt || 0) >= BOT_HARVESTER_EXPLORE_THROTTLE_SEC
  );
  if (eligible.length === 0) return;

  const want = Math.min(BOT_HARVESTER_EXPLORE_PER_TICK, eligible.length);
  const targets = allocateDiverseExploreTargets(player, hq, mem, elapsed, want, null, harvesters);
  for (let i = 0; i < targets.length; i++) {
    if (!botTrySpendOrders(mem, 1)) break;
    const h = eligible[i];
    h._botExploreCmdAt = elapsed;
    h._relocateAge = 0;
    Units.commandAttackMove([h.id], targets[i].x, targets[i].z);
  }
}

/**
 * Visible enemies near our harvesters → send combat to help (runs late so it overrides rally).
 * Fair: only units visible in fog.
 *
 * Uses **attack-move toward the harvester**, not `commandAttackUnit` on the enemy. A direct
 * attack order paths to the foe's XZ; if that point sits across unwalkable mesh / nav holes,
 * defenders stall at the rim. The harvester is already on walkable ground, and attack-move
 * lets responders auto-acquire the threat once they enter weapon range / vision.
 */
function handleHarvesterDefense(player, combatUnits, harvesters, elapsed) {
  const team = player.team;
  const mem = player.botMemory;
  const R = BOT_HARVESTER_ESCORT_RADIUS;

  let bestH = null;
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
        bestH = h;
      }
    }
  }

  if (!bestEnemy || !bestH) return;

  if (elapsed - (mem._harvesterDefenseAt || 0) < BOT_HARVESTER_ESCORT_COOLDOWN) return;
  mem._harvesterDefenseAt = elapsed;

  const saveScouts = botNeedsPriorityResourceExploration(player);
  const responders = combatUnits.filter(u => {
    if (u.type === 'scoutBike') return false;
    if (u.state !== 'idle' && u.state !== 'moving') return false;
    if (saveScouts && unitOnScoutMission(mem, u.id)) return false;
    // Only the threatened harvester's home-base troops escort — never other bases.
    if (bestH.homeBasePos && u.homeBasePos) {
      const d = Pathfinding.getDistance(
        u.homeBasePos.x,
        u.homeBasePos.z,
        bestH.homeBasePos.x,
        bestH.homeBasePos.z
      );
      if (d > 40) return false;
    } else if (u.homeBasePos) {
      const d = Pathfinding.getDistance(u.homeBasePos.x, u.homeBasePos.z, bestH.x, bestH.z);
      if (d > BOT_DEFEND_RADIUS + 14) return false;
    } else {
      // Untagged: must already be near the harvester
      if (Pathfinding.getDistance(u.x, u.z, bestH.x, bestH.z) > BOT_DEFEND_RADIUS + 14) return false;
    }
    return true;
  });

  const n = Math.min(BOT_HARVESTER_ESCORT_MAX_UNITS, responders.length);
  if (n < 1) return;
  if (!botTrySpendOrders(mem, 1)) return;

  const rally = clampWorldToPlayableDisk(bestH.x, bestH.z, 2);
  Units.commandAttackMove(responders.slice(0, n).map(u => u.id), rally.x, rally.z);
}

function tickScoutMissions(player, elapsed) {
  const mem = player.botMemory;
  const hq = State.getPlayerHQ(player.id);
  if (!hq) return;

  const arriveR2 = BOT_SCOUT_ARRIVE_RADIUS * BOT_SCOUT_ARRIVE_RADIUS;
  const DANGER_ABORT = 4.2;

  mem.currentMissions.forEach(m => {
    if (m.type !== 'SCOUT' || !m.targetPos) return;
    const u = m.unitIds.map(id => State.units.get(id)).find(x => x && x.hp > 0);
    if (!u) return;

    // Mid-mission damage or known guns on the route → abort, flee, remember the kill zone.
    const damaged =
      (u._botDamagedAt != null && elapsed - u._botDamagedAt < 5)
      || (m._hpWatch != null && u.hp < m._hpWatch - 0.5);
    m._hpWatch = u.hp;
    const destDanger = scoutWaypointDanger(mem, elapsed, m.targetPos.x, m.targetPos.z);
    const hereHostile = expandSiteIsHostile(player, u.x, u.z);
    const destHostile = expandSiteIsHostile(player, m.targetPos.x, m.targetPos.z);
    if (damaged || hereHostile || destHostile || destDanger >= DANGER_ABORT) {
      mem.dangerZones.push({
        x: u.x,
        z: u.z,
        time: elapsed,
        threats: {
          infantry: 0,
          vehicle: 1,
          types: { artilleryTurret: hereHostile || destHostile ? 1 : 0 },
        },
        killerType: u._botLastAttackerLongRange ? 'artilleryTurret' : null,
        longRangeKiller: !!u._botLastAttackerLongRange || hereHostile || destHostile,
      });
      if (mem.dangerZones.length > 12) mem.dangerZones.shift();
      m.status = 'complete';
      if (botTrySpendOrders(mem, 1)) {
        const dx = u.x - m.targetPos.x;
        const dz = u.z - m.targetPos.z;
        const len = Math.hypot(dx, dz) || 1;
        let fx = u.x + (dx / len) * 32;
        let fz = u.z + (dz / len) * 32;
        // Prefer HQ if it's farther from the danger than a blind reverse.
        const dFlee = (fx - m.targetPos.x) ** 2 + (fz - m.targetPos.z) ** 2;
        const dHq = (hq.x - m.targetPos.x) ** 2 + (hq.z - m.targetPos.z) ** 2;
        if (dHq >= dFlee) {
          fx = hq.x;
          fz = hq.z;
        }
        Units.commandMove([u.id], fx, fz, { playerCommanded: true });
        u._botFleeUntil = elapsed + 5;
      }
      return;
    }

    // Arrive vs the walkable snap of the fog cell — raw fog centers are often rocks/cliffs.
    let arriveX = m.targetPos.x;
    let arriveZ = m.targetPos.z;
    if (!Pathfinding.isPositionWalkable(arriveX, arriveZ)) {
      const s = Pathfinding.snapWorldXZToWalkable(arriveX, arriveZ);
      arriveX = s.x;
      arriveZ = s.z;
    }
    const distSq = Pathfinding.getDistanceSq(u.x, u.z, arriveX, arriveZ);

    if (distSq <= arriveR2) {
      const hv = State.getPlayerUnits(player.id).filter(u => u.type === 'harvester');
      const others = collectActiveScoutTargets(mem).filter(
        g => Pathfinding.getDistanceSq(g.x, g.z, m.targetPos.x, m.targetPos.z) > 1
      );
      const exclude = others[0] || m.targetPos;
      let next = getScoutTarget(player, hq, elapsed, exclude, hv);
      if (next && others.some(g => Pathfinding.getDistanceSq(g.x, g.z, next.x, next.z) < 40 * 40)) {
        next = pickSingleExploreWaypointDiverse(player, hq, mem, elapsed, exclude, hv);
      }
      // Refuse a next waypoint that is clearly a death trap.
      if (
        next
        && (expandSiteIsHostile(player, next.x, next.z)
          || scoutWaypointDanger(mem, elapsed, next.x, next.z) >= DANGER_ABORT)
      ) {
        next = pickSingleExploreWaypointDiverse(player, hq, mem, elapsed, exclude, hv);
      }
      if (
        next
        && !expandSiteIsHostile(player, next.x, next.z)
        && scoutWaypointDanger(mem, elapsed, next.x, next.z) < DANGER_ABORT
        && botTrySpendOrders(mem, 1)
      ) {
        m.targetPos = next;
        m._intel = !!next._intel;
        m._lastReissue = elapsed;
        m._hpWatch = u.hp;
        if (next._intel) {
          Units.commandMove([u.id], next.x, next.z, { playerCommanded: true });
        } else {
        Units.commandAttackMove([u.id], next.x, next.z);
        }
      } else {
        m.status = 'complete';
        Units.commandStop([u.id]);
      }
      return;
    }

    if (u._botFleeUntil && elapsed < u._botFleeUntil) return;
    if (elapsed - (m._lastReissue || 0) < BOT_SCOUT_REPATH_SEC) return;
    // Intel: break out of combat stalemates short of the HQ. Other scouts: only repath when idle.
    const stuck = u.state === 'idle' || (m._intel && u.state === 'attacking');
    if (stuck && botTrySpendOrders(mem, 1)) {
      m._lastReissue = elapsed;
      if (m._intel) {
        Units.commandMove([u.id], m.targetPos.x, m.targetPos.z, { playerCommanded: true });
      } else {
      Units.commandAttackMove([u.id], m.targetPos.x, m.targetPos.z);
      }
    }
  });
}

function doAttackMission(player, combatUnits, elapsed) {
  const mem = player.botMemory;

  const strike = mem.currentMissions.find(m => m.type === 'STRIKE' || m.type === 'PUSH');
  if (!strike) return;

  const strikeUnits = strike.unitIds.map(id => State.units.get(id)).filter(u => u && u.hp > 0);
  const target = State.buildings.get(strike.targetId);

  if (strikeUnits.length === 0 || !target || target.hp <= 0) return;

  const needOrders = strikeUnits.filter(u =>
    u.state === 'idle' || (u.state === 'moving' && !u.playerCommanded)
  );
  if (needOrders.length > 0 && botTrySpendOrders(mem, 1)) {
    if (strike.type === 'PUSH') {
      Units.commandAttackMove(needOrders.map(u => u.id), target.x, target.z);
    } else {
    Units.commandAttackBuilding(needOrders.map(u => u.id), strike.targetId);
    }
  }
}

function tickRetaliationMissions(player) {
  const mem = player.botMemory;
  for (let mi = 0; mi < mem.currentMissions.length; mi++) {
    const m = mem.currentMissions[mi];
    if (m.type !== 'retaliation' || !m.targetPos) continue;
    const ids = m.unitIds
      .map(id => State.units.get(id))
      .filter(u => u && u.hp > 0 && u.state === 'idle');
    if (ids.length > 0 && botTrySpendOrders(mem, 1)) {
      Units.commandAttackMove(
        ids.map(u => u.id),
        m.targetPos.x,
        m.targetPos.z
      );
    }
  }
}

/** Anchor a unit uses for “is this my base’s fight?” (Story multi-base). */
function unitHomeDefendAnchor(u) {
  if (u.homeBasePos) return u.homeBasePos;
  if (u.homeGuardPos) return u.homeGuardPos;
  return null;
}

/**
 * Story: each base only peels for threats near *its* home.
 * Untagged units only help if already near the threat (never cross-base assist).
 */
function unitCanDefendThreatLocally(u, threatUnit) {
  if (!threatUnit) return false;
  const home = unitHomeDefendAnchor(u);
  // Static guns shoot from 70m — allow a wider peel so expand bases can answer.
  const longGun = threatUnit.type === 'artilleryTurret' || threatUnit.type === 'artillery';
  const homeR = longGun
    ? 95
    : (u.botRole === 'garrison' ? BOT_DEFEND_RADIUS + 8 : BOT_DEFEND_RADIUS + 14);
  if (home) {
    return Pathfinding.getDistance(home.x, home.z, threatUnit.x, threatUnit.z) <= homeR;
  }
  const nearR = longGun ? 85 : BOT_DEFEND_RADIUS + 8;
  return Pathfinding.getDistance(u.x, u.z, threatUnit.x, threatUnit.z) <= nearR;
}

// --- DEFENSE ---
function handleDefense(player, combatUnits, threats) {
  const pid = player.id;
  const hq = State.getPlayerHQ(pid);
  if (!hq || threats.length === 0) return;

  const mem = player.botMemory;
  const elapsed = State.gameSession.elapsedTime;
  const econExplore = botNeedsPriorityResourceExploration(player);

  // Resolve live threats — units OR defense buildings.
  const liveThreats = [];
  for (let i = 0; i < threats.length; i++) {
    const raw = threats[i];
    const tu = State.units.get(raw.id);
    if (tu && tu.hp > 0) {
      liveThreats.push(tu);
      continue;
    }
    const tb = State.buildings.get(raw.id);
    if (tb && tb.hp > 0) liveThreats.push(tb);
  }
  if (liveThreats.length === 0) return;

  // Sort by distance to nearest of our buildings / MHQs so remote expands defend first.
  liveThreats.sort((a, b) => {
    let da = Infinity;
    let db = Infinity;
    State.getPlayerBuildings(pid).forEach(bld => {
      if (bld.hp <= 0) return;
      da = Math.min(da, Pathfinding.getDistanceSq(bld.x, bld.z, a.x, a.z));
      db = Math.min(db, Pathfinding.getDistanceSq(bld.x, bld.z, b.x, b.z));
    });
    State.getPlayerUnits(pid).forEach(u => {
      if (u.hp <= 0 || u.type !== 'mobileHq') return;
      da = Math.min(da, Pathfinding.getDistanceSq(u.x, u.z, a.x, a.z));
      db = Math.min(db, Pathfinding.getDistanceSq(u.x, u.z, b.x, b.z));
    });
    return da - db;
  });

  /** @type {Set<string>} */
  const committed = new Set();

  // Per-threat local responders — never mass the whole map onto one raid.
  const maxThreats = Math.min(5, liveThreats.length);
  for (let ti = 0; ti < maxThreats; ti++) {
    const threatUnit = liveThreats[ti];
    const threatIsBuilding = !threatUnit.category;
    const isMinorThreat =
      threatUnit.type === 'scoutBike' || threatUnit.type === 'rifleman';
    const releaseR2 = BOT_DEFENSE_RELEASE_SCOUT_DIST * BOT_DEFENSE_RELEASE_SCOUT_DIST;
    const urgentDefense = Pathfinding.getDistanceSq(hq.x, hq.z, threatUnit.x, threatUnit.z) < releaseR2;

    let available = combatUnits.filter(u => {
      if (committed.has(u.id)) return false;
      if (u.state !== 'idle' && u.state !== 'moving' && u.state !== 'attacking') return false;
      if (unitOnScoutMission(mem, u.id)) return false;
      if (mem.currentMissions.some(m => (m.type === 'SIEGE' || m.type === 'RECON') && m.unitIds.includes(u.id))) return false;
      if (econExplore && u.type === 'scoutBike' && !urgentDefense) return false;
      if (u._botDefenseCmdAt != null && elapsed - u._botDefenseCmdAt < 1.35) return false;
      if (!unitCanDefendThreatLocally(u, threatUnit)) return false;
      return true;
    });

    if (threatUnit.type === 'artilleryTurret' || threatUnit.type === 'artillery') {
      // Riflemen and tanks have to walk into the 70m gun to shoot. Only artillery
      // may take that fight; everyone else holds.
      const capable = available.filter(u => u.type === 'artillery');
      if (capable.length === 0) continue;
      available = capable;
    } else if (unitIsLongRangeThreat(threatUnit)) {
      const capable = available.filter(u => canCounterLongRange(u));
      if (capable.length > 0) available = capable;
    }

    const need = isMinorThreat ? 2 : (threatIsBuilding ? 5 : 4);
    if (available.length < 1) continue;
    const squad = available.slice(0, Math.min(need + 2, available.length));
    if (!botTrySpendOrders(mem, 1)) break;

    const ids = squad.map(u => u.id);
    for (const id of ids) committed.add(id);

    if (threatIsBuilding) {
      Units.commandAttackBuilding(ids, threatUnit.id);
      const stamped = elapsed;
      for (const id of ids) {
        const u = State.units.get(id);
        if (u) u._botDefenseCmdAt = stamped;
      }
    } else {
      commandBotEngageEnemyUnits(ids, threatUnit);
    }
  }

  const myBuildings = State.getPlayerBuildings(pid);
  const barracks = myBuildings.find(b => b.type === 'barracks' && b.isBuilt && b.productionQueue.length === 0);
  const siegeArmy = (player.botMemory?.personality?.artilleryAffinity ?? 0) >= 0.65;
  if (barracks && !siegeArmy && player.credits >= 175 && liveThreats.length > 2) {
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
    const needRetarget = group.filter(u => {
      if (u.targetUnitId === best.id) return false;
      // Don't yank a distant base's army onto a fight across the map
      if (!unitCanDefendThreatLocally(u, best)) return false;
      return true;
    });
    if (needRetarget.length === 0) continue;
    if (!botTrySpendOrders(mem, 1)) break;
    commandBotEngageEnemyUnits(needRetarget.map(u => u.id), best);
  }
}

function maybeBotEngineerCapture(player, elapsed) {
  const mem = player.botMemory;
  const pid = player.id;
  const team = player.team;
  const engineers = State.getPlayerUnits(pid).filter(u =>
    u.type === 'engineer' &&
    u.hp > 0 &&
    (u.state === 'idle' || (u.state === 'moving' && !u.playerCommanded)) &&
    !mem.currentMissions.some(m => m.unitIds.includes(u.id))
  );
  if (engineers.length === 0) return;

  const candidates = mem.targets
    .map(t => (t.type === 'building' ? State.buildings.get(t.id) : null))
    .filter(b => {
      if (!b || b.hp <= 0 || !b.isBuilt) return false;
      if (b.team === team) return false;
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
  if (!botTrySpendOrders(mem, 1)) return;
  mem._lastEngCaptureOrder = elapsed;
  Units.commandAttackBuilding([engineers[0].id], target.id);
}

// --- Helper functions ---

/** East shoulder from the SE spawn up to the NE base. Guns walk this. Don't build on it. */
function blocksSiegeLane(x, z) {
  return x > 110 && x < 200 && z > -90 && z < 140;
}

function findBuildPosition(hq, startDistance, buildingType, ownerId, opts = {}) {
  const placeOk = opts.geometryOnly
    ? (type, oid, x, z) => Buildings.canPlaceBuildingGeometry(type, oid, x, z)
    : (type, oid, x, z) => Buildings.canPlaceBuilding(type, oid, x, z);
  // Step outward in increasing rings so the bot NEVER fails to place a building
  // even if their HQ is extremely crowded
  for (let distance = startDistance; distance <= startDistance + 40; distance += 6) {
    const angleStep = Math.PI / (4 + Math.floor(distance / 5)); // More angles at wider rings
    for (let angle = 0; angle < Math.PI * 2; angle += angleStep) {
      const x = hq.x + Math.cos(angle) * distance;
      const z = hq.z + Math.sin(angle) * distance;
      if (blocksSiegeLane(x, z)) continue;
      if (placeOk(buildingType, ownerId, x, z)) {
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
 * Kept sparse — dense ring search was a PCVR frame sink when called from expand every bot tick.
 */
function findBestRefineryPositionNearField(field, ownerId) {
  let best = null;
  let bestDistSq = Infinity;
  const tryPos = (x, z) => {
    if (blocksSiegeLane(x, z)) return;
    if (!Buildings.canPlaceBuildingGeometry('refinery', ownerId, x, z)) return;
    const d = Pathfinding.getDistanceSq(x, z, field.x, field.z);
    if (d < bestDistSq) {
      bestDistSq = d;
      best = { x, z };
    }
  };

  for (const ring of [8, 10, 12, 14, 16, 18]) {
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const ang = (i / steps) * Math.PI * 2;
      tryPos(field.x + Math.cos(ang) * ring, field.z + Math.sin(ang) * ring);
    }
  }
  if (best) return best;
  return findBuildPosition(field, 8, 'refinery', ownerId, { geometryOnly: true });
}

function findExpansionRefineryPosition(field, ownerId) {
  // ONLY pads inside claim radius of THIS crystal.
  const claimR2 = BOT_FIELD_CLAIM_RADIUS * BOT_FIELD_CLAIM_RADIUS;
  let bestInClaim = null;
  let bestInClaimD = Infinity;

  const consider = (pos) => {
    if (!pos) return;
    const d = Pathfinding.getDistanceSq(pos.x, pos.z, field.x, field.z);
    if (d <= claimR2 && d < bestInClaimD) {
      bestInClaimD = d;
      bestInClaim = pos;
    }
  };

  // Cheap field rings first (most expands resolve here).
  for (let ring = 8; ring <= 28; ring += 4) {
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const x = field.x + Math.cos(ang) * ring;
      const z = field.z + Math.sin(ang) * ring;
      if (Buildings.canPlaceBuildingGeometry('refinery', ownerId, x, z)) consider({ x, z });
    }
  }
  if (bestInClaim) return bestInClaim;

  const hq = nearestPlayerHq(ownerId, field.x, field.z);
  if (hq) {
    const dx = field.x - hq.x;
    const dz = field.z - hq.z;
    const len = Math.hypot(dx, dz) || 1;
    for (let t = 8; t <= 32; t += 4) {
      const x = hq.x + (dx / len) * t;
      const z = hq.z + (dz / len) * t;
      if (Buildings.canPlaceBuildingGeometry('refinery', ownerId, x, z)) consider({ x, z });
    }
  }
  if (bestInClaim) return bestInClaim;

  consider(findBestRefineryPositionNearField(field, ownerId));
  return bestInClaim;
}

/** Cached expand pad probe — uncached geometry was destroying PCVR frame time. */
function findExpansionRefineryPositionCached(player, field) {
  if (!field) return null;
  const mem = player.botMemory;
  const now = State.gameSession.elapsedTime;
  if (!mem._expandPadCache) mem._expandPadCache = Object.create(null);
  const hit = mem._expandPadCache[field.id];
  if (hit && now < hit.until) return hit.pos;
  const pos = findExpansionRefineryPosition(field, player.id);
  mem._expandPadCache[field.id] = { pos, until: now + 2.0 };
  return pos;
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

/** True if an owned HQ already covers this crystal (or a neighbor in the same ore patch). */
function fieldCoveredByOwnedHq(pid, field) {
  if (!field) return false;
  const hqs = State.getPlayerBuildings(pid).filter(b => b.type === 'hq' && b.hp > 0);
  if (hqs.length === 0) return false;
  const buildR2 = BUILD_RADIUS_FROM_HQ * BUILD_RADIUS_FROM_HQ;
  const clusterR2 = BOT_ORE_CLUSTER_RADIUS * BOT_ORE_CLUSTER_RADIUS;
  for (let i = 0; i < hqs.length; i++) {
    if (Pathfinding.getDistanceSq(hqs[i].x, hqs[i].z, field.x, field.z) <= buildR2) return true;
  }
  // Cluster mate already under an HQ ⇒ no second Mobile HQ for the same patch.
  let covered = false;
  State.resourceFields.forEach(other => {
    if (covered || !other || other.depleted || other.id === field.id) return;
    if (Pathfinding.getDistanceSq(other.x, other.z, field.x, field.z) > clusterR2) return;
    for (let i = 0; i < hqs.length; i++) {
      if (Pathfinding.getDistanceSq(hqs[i].x, hqs[i].z, other.x, other.z) <= buildR2) {
        covered = true;
        return;
      }
    }
  });
  return covered;
}

function noteExpandAvoid(mem, fieldId, elapsed) {
  if (!fieldId) return;
  if (!mem.expandAvoidUntil) mem.expandAvoidUntil = {};
  mem.expandAvoidUntil[fieldId] = elapsed + 90;
  // Also stamp a danger zone at the field so scouts/MHQs share the lesson.
  const f = State.resourceFields.get(fieldId);
  if (f) {
    mem.dangerZones.push({
      x: f.x,
      z: f.z,
      time: elapsed,
      threats: { infantry: 0, vehicle: 1, types: { artilleryTurret: 1 } },
      killerType: 'artilleryTurret',
      longRangeKiller: true,
    });
    if (mem.dangerZones.length > 12) mem.dangerZones.shift();
  }
}

function expandAvoidActive(mem, fieldId, elapsed) {
  if (!fieldId || !mem.expandAvoidUntil) return false;
  if ((mem.expandAvoidUntil[fieldId] || 0) > elapsed) return true;
  // One static gun covers the whole contested ring (~60m). Blacklisting only the
  // crystal under the barrel left the next MHQ walking into the same umbrella.
  const field = State.resourceFields.get(fieldId);
  if (!field) return false;
  const umbrella = 76 * 76;
  const ids = Object.keys(mem.expandAvoidUntil);
  for (let i = 0; i < ids.length; i++) {
    if ((mem.expandAvoidUntil[ids[i]] || 0) <= elapsed) continue;
    const other = State.resourceFields.get(ids[i]);
    if (!other) continue;
    if (Pathfinding.getDistanceSq(other.x, other.z, field.x, field.z) <= umbrella) return true;
  }
  return false;
}

/** Visible/known static guns or death-zones that make a deploy pad suicidal. */
function expandSiteIsHostile(player, x, z) {
  if (x == null || z == null) return false;
  const team = player.team;
  const mem = player.botMemory;
  const elapsed = State.gameSession.elapsedTime;

  let hostile = false;
  State.buildings.forEach(b => {
    if (hostile || b.hp <= 0 || b.team === team) return;
    if (b.type !== 'artilleryTurret' && b.type !== 'turret') return;
    const known =
      Fog.isVisibleToTeam(team, b.x, b.z)
      || Fog.wasExploredByTeam(team, b.x, b.z)
      || mem.targets.some(t => t.id === b.id);
    if (!known) return;
    const range = (BUILDING_TYPES[b.type]?.range || 16) + 6;
    if (Pathfinding.getDistanceSq(x, z, b.x, b.z) <= range * range) hostile = true;
  });
  if (hostile) return true;

  for (const g of mem.knownGuns || []) {
    if (!g || elapsed - g.time > 180) continue;
    const r = g.range || 76;
    if (Pathfinding.getDistanceSq(x, z, g.x, g.z) <= r * r) return true;
  }

  State.units.forEach(u => {
    if (hostile || u.hp <= 0 || u.team === team || u.type !== 'artillery') return;
    if (!Fog.isVisibleToTeam(team, u.x, u.z)) return;
    if (Pathfinding.getDistanceSq(x, z, u.x, u.z) <= 76 * 76) hostile = true;
  });
  if (hostile) return true;

  for (const dz of mem.dangerZones || []) {
    if (elapsed - dz.time > BOT_SCOUT_DANGER_ZONE_TTL) continue;
    if (!dangerZoneIsLongRangeNest(dz)) continue;
    if (Pathfinding.getDistanceSq(x, z, dz.x, dz.z) < 55 * 55) return true;
  }
  return false;
}

/** True if an owned refinery already covers this crystal (or a neighbor in the same ore patch). */
function fieldCoveredByOwnedRefinery(pid, field, refs) {
  if (!field) return true;
  const claimR2 = BOT_FIELD_CLAIM_RADIUS * BOT_FIELD_CLAIM_RADIUS;
  const clusterR2 = BOT_ORE_CLUSTER_RADIUS * BOT_ORE_CLUSTER_RADIUS;
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    if (Pathfinding.getDistanceSq(r.x, r.z, field.x, field.z) < claimR2) return true;
  }
  // Same-patch: another live field already claimed within cluster radius → no extra refinery.
  let coveredViaCluster = false;
  State.resourceFields.forEach(other => {
    if (coveredViaCluster || !other || other.depleted || other.id === field.id) return;
    if (Pathfinding.getDistanceSq(other.x, other.z, field.x, field.z) > clusterR2) return;
    for (let i = 0; i < refs.length; i++) {
      if (Pathfinding.getDistanceSq(refs[i].x, refs[i].z, other.x, other.z) < claimR2) {
        coveredViaCluster = true;
        return;
      }
    }
  });
  return coveredViaCluster;
}

function fieldRemainingFrac(field) {
  const cap = field?.capacity || RESOURCE_FIELD_CAPACITY || 5000;
  return Math.max(0, (field?.remaining || 0) / Math.max(1, cap));
}

/** Min squared distance to an active enemy's match-start spawn (known corners, not unit vision). */
function distSqToEnemySpawn(player, x, z) {
  let best = Infinity;
  for (let i = 0; i < State.players.length; i++) {
    const p = State.players[i];
    if (!p || !p.isActive || p.isDefeated || p.team === player.team || !p.spawn) continue;
    const d = (p.spawn.x - x) ** 2 + (p.spawn.z - z) ** 2;
    if (d < best) best = d;
  }
  return best;
}

/** Min distance from point to any living enemy HQ (Infinity if none known/visible). */
function minDistSqToEnemyHq(player, x, z) {
  let best = Infinity;
  State.buildings.forEach(b => {
    if (b.type !== 'hq' || b.hp <= 0) return;
    if (b.team === player.team) return;
    // Fair: only avoid HQs we've explored or currently see.
    if (
      !Fog.isVisibleToTeam(player.team, b.x, b.z)
      && !Fog.wasExploredByTeam(player.team, b.x, b.z)
    ) {
      return;
    }
    const d = Pathfinding.getDistanceSq(b.x, b.z, x, z);
    if (d < best) best = d;
  });
  return best;
}

/** Discovered ore with no owned refinery covering its patch — prefer rich, safe fields. */
function findUnclaimedDiscoveredFieldId(player) {
  const pid = player.id;
  const mem = player.botMemory;
  const refs = State.getPlayerBuildings(pid).filter(b => b.type === 'refinery' && b.hp > 0);
  const hqs = State.getPlayerBuildings(pid).filter(b => b.type === 'hq' && b.hp > 0);
  const avoidR2 = BOT_EXPAND_ENEMY_HQ_AVOID * BOT_EXPAND_ENEMY_HQ_AVOID;
  let bestId = null;
  let bestScore = -Infinity;

  const committed = mem.expandCommitFieldId;
  if (committed) {
    const cf = State.resourceFields.get(committed);
    const stillGood =
      cf
      && !cf.depleted
      && !expandAvoidActive(mem, committed, State.gameSession.elapsedTime)
      && !expandSiteIsHostile(player, cf.x, cf.z)
      && minDistSqToEnemyHq(player, cf.x, cf.z) >= avoidR2
      && distSqToEnemySpawn(player, cf.x, cf.z) >= avoidR2
      && fieldRemainingFrac(cf) >= BOT_EXPAND_MIN_ORE_FRAC * 0.5
      && !fieldCoveredByOwnedRefinery(pid, cf, refs)
      && !fieldCoveredByOwnedHq(pid, cf);
    if (stillGood) {
      const pad = findExpansionRefineryPositionCached(player, cf);
      if (pad) return committed;
      let hqNear = false;
      for (let i = 0; i < hqs.length; i++) {
        if (
          Pathfinding.getDistanceSq(hqs[i].x, hqs[i].z, cf.x, cf.z)
          <= BUILD_RADIUS_FROM_HQ * BUILD_RADIUS_FROM_HQ
        ) {
          hqNear = true;
          break;
        }
      }
      if (!hqNear) return committed;
    }
    mem.expandCommitFieldId = null;
  }

  for (const id of mem.discoveredResources || []) {
    const field = State.resourceFields.get(id);
    if (!field || field.depleted) continue;
    if (expandAvoidActive(mem, id, State.gameSession.elapsedTime)) continue;
    if (expandSiteIsHostile(player, field.x, field.z)) continue;
    if (fieldCoveredByOwnedRefinery(pid, field, refs)) continue;
    if (fieldCoveredByOwnedHq(pid, field)) continue;
    const remFrac = fieldRemainingFrac(field);
    if (remFrac < BOT_EXPAND_MIN_ORE_FRAC) continue;

    let dHq = Infinity;
    for (let i = 0; i < hqs.length; i++) {
      dHq = Math.min(dHq, Pathfinding.getDistanceSq(hqs[i].x, hqs[i].z, field.x, field.z));
    }
    if (!Number.isFinite(dHq)) dHq = field.x * field.x + field.z * field.z;

    const padReady = !!findExpansionRefineryPositionCached(player, field);
    const coveredByOurHq =
      Number.isFinite(dHq) && dHq <= BUILD_RADIUS_FROM_HQ * BUILD_RADIUS_FROM_HQ;
    // Dead expand: HQ covers but no pad (contested footprint).
    if (coveredByOurHq && !padReady) continue;

    const enemyD = minDistSqToEnemyHq(player, field.x, field.z);
    const spawnD = distSqToEnemySpawn(player, field.x, field.z);
    // Known enemy HQ, or that player's starting corner — never expand on their doorstep.
    if (enemyD < avoidR2 || spawnD < avoidR2) continue;
    const score =
      remFrac * 8000
      + (padReady ? 12000 : 0)
      - Math.sqrt(dHq) * 8;
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}

function nearestPlayerHq(ownerId, x, z) {
  const hqs = State.getPlayerBuildings(ownerId).filter(b => b.type === 'hq' && b.hp > 0);
  if (hqs.length === 0) return null;
  let best = hqs[0];
  let bestD = Infinity;
  for (let i = 0; i < hqs.length; i++) {
    const d = Pathfinding.getDistanceSq(hqs[i].x, hqs[i].z, x, z);
    if (d < bestD) {
      bestD = d;
      best = hqs[i];
    }
  }
  return best;
}

/** True if a refinery footprint fits in claim radius of field and build radius of hqPos. */
function spotWouldAllowClaimRefinery(field, ownerId, hqX, hqZ) {
  const claimR2 = BOT_FIELD_CLAIM_RADIUS * BOT_FIELD_CLAIM_RADIUS;
  const buildR2 = BUILD_RADIUS_FROM_HQ * BUILD_RADIUS_FROM_HQ;
  for (const ring of [10, 14, 18]) {
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const px = field.x + Math.cos(ang) * ring;
      const pz = field.z + Math.sin(ang) * ring;
      if (Pathfinding.getDistanceSq(px, pz, field.x, field.z) > claimR2) continue;
      if (Pathfinding.getDistanceSq(px, pz, hqX, hqZ) > buildR2) continue;
      if (Buildings.canPlaceBuildingFootprint('refinery', ownerId, px, pz)) return true;
    }
  }
  return false;
}

/** Legal Mobile HQ deploy pad — prefer a spot that can feed multiple nearby crystals. */
function findMobileHqDeploySpotNearField(field, ownerId, player) {
  const cluster = [field];
  if (player) {
    const clusterR2 = BOT_ORE_CLUSTER_RADIUS * BOT_ORE_CLUSTER_RADIUS;
    const mem = player.botMemory;
    for (const id of mem.discoveredResources || []) {
      const f = State.resourceFields.get(id);
      if (!f || f.depleted || f.id === field.id) continue;
      if (fieldRemainingFrac(f) < BOT_EXPAND_MIN_ORE_FRAC) continue;
      if (Pathfinding.getDistanceSq(f.x, f.z, field.x, field.z) <= clusterR2) cluster.push(f);
    }
  }
  let cx = 0;
  let cz = 0;
  for (const f of cluster) {
    cx += f.x;
    cz += f.z;
  }
  cx /= cluster.length;
  cz /= cluster.length;

  const trySpot = (x, z) => {
    if (blocksSiegeLane(x, z)) return null;
    if (Buildings.getMobileHqDeployFailureCode(ownerId, x, z) !== null) return null;
    // Must leave a claim pad for the primary field (and preferably the cluster).
    if (!spotWouldAllowClaimRefinery(field, ownerId, x, z)) return null;
    return { x, z };
  };

  // Centroid first when the patch has 2+ crystals — one HQ + one ref covers the ring.
  if (cluster.length >= 2) {
    for (const ring of [0, 4, 8, 10, 12]) {
      if (ring === 0) {
        const hit = trySpot(cx, cz);
        if (hit) return hit;
        continue;
      }
      const steps = Math.max(8, Math.floor(ring * 1.5));
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        const hit = trySpot(cx + Math.cos(angle) * ring, cz + Math.sin(angle) * ring);
        if (hit) return hit;
      }
    }
  }

  for (const ring of [6, 8, 10, 12, 14]) {
    const steps = Math.max(12, Math.floor(ring * 1.5));
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const hit = trySpot(
        field.x + Math.cos(angle) * ring,
        field.z + Math.sin(angle) * ring
      );
      if (hit) return hit;
    }
  }
  for (const ox of [8, -8, 10, -10, 12, -12]) {
    for (const oz of [8, -8, 10, -10, 12, -12, 0]) {
      if (ox === 0 && oz === 0) continue;
      const hit = trySpot(field.x + ox, field.z + oz);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Move / deploy an existing Mobile HQ toward an unclaimed far field.
 * Production queues the unit when credits allow (see performProductionLogic).
 * @returns {boolean} true if a Mobile HQ was deployed this call
 */
/** Hold point outside the home HQ ring — never the HQ coordinate (that orbits the footprint). */
function mobileHqHoldPoint(ownerId) {
  const hq = State.getPlayerHQ(ownerId);
  if (!hq) return null;
  const dx = -hq.x;
  const dz = -hq.z;
  const len = Math.hypot(dx, dz) || 1;
  const c = clampWorldToPlayableDisk(hq.x + (dx / len) * 34, hq.z + (dz / len) * 34, 6);
  if (Pathfinding.isPositionWalkable(c.x, c.z)) return c;
  return Pathfinding.snapWorldXZToWalkable(c.x, c.z);
}

function driveMobileHqExpansion(player, field, _rerouteDepth = 0) {
  const pid = player.id;
  const mem = player.botMemory;
  const elapsed = State.gameSession.elapsedTime;
  const mhqs = State.getPlayerUnits(pid).filter(u => u.type === 'mobileHq' && u.hp > 0);
  if (mhqs.length === 0 || !field) return false;

  // Twin MHQs: only the lead continues the expand; extras wait on the hold pad (never stack deploys).
  if (mhqs.length > 1) {
    mhqs.sort((a, b) =>
      Pathfinding.getDistanceSq(a.x, a.z, field.x, field.z)
      - Pathfinding.getDistanceSq(b.x, b.z, field.x, field.z)
    );
    const hold = mobileHqHoldPoint(pid);
    for (let i = 1; i < mhqs.length; i++) {
      const spare = mhqs[i];
      if (spare._botFleeUntil && elapsed < spare._botFleeUntil) continue;
      // Do not recall a spare MHQ to the home base — that was the useless drive-back.
      if (hold && spare.targetPos
        && Pathfinding.getDistanceSq(spare.targetPos.x, spare.targetPos.z, hold.x, hold.z) < 12 * 12) {
        Units.commandStop([spare.id]);
      }
    }
  }

  const u = mhqs[0];
  const abort = !!u._mhqAbortExpand;
  if (abort) {
    u._mhqAbortExpand = false;
    u._botFleeUntil = 0;
    u.playerCommanded = false;
    // Blacklist the crystal the gun is sitting on — not the safe field we already turned toward.
    const atk = State.units.get(u._botLastAttackerId) || State.buildings.get(u._botLastAttackerId);
    let badId = null;
    if (atk) {
      let badD = 80 * 80;
      State.resourceFields.forEach(f => {
        if (!f || f.depleted) return;
        const d = Pathfinding.getDistanceSq(f.x, f.z, atk.x, atk.z);
        if (d < badD) {
          badD = d;
          badId = f.id;
        }
      });
    }
    if (badId) {
      noteExpandAvoid(mem, badId, elapsed);
      if (mem.expandCommitFieldId === badId) mem.expandCommitFieldId = null;
    }
    if (badId && field.id === badId) {
      if (_rerouteDepth < 1) {
        const altId = findUnclaimedDiscoveredFieldId(player);
        const alt = altId ? State.resourceFields.get(altId) : null;
        if (alt && alt.id !== field.id) return driveMobileHqExpansion(player, alt, _rerouteDepth + 1);
      }
    }
  }
  // Honor a short out-of-range dodge unless it is aimed at the home HQ (orbit bug).
  if (u._botFleeUntil && elapsed < u._botFleeUntil) {
    const home = State.getPlayerHQ(pid);
    const fleeingHome = home && u.targetPos
      && Pathfinding.getDistanceSq(u.targetPos.x, u.targetPos.z, home.x, home.z) < 18 * 18;
    if (!fleeingHome) return false;
    u._botFleeUntil = 0;
    u.playerCommanded = false;
  }

  const denied = expandAvoidActive(mem, field.id, elapsed)
    || expandSiteIsHostile(player, field.x, field.z)
    || minDistSqToEnemyHq(player, field.x, field.z) < BOT_EXPAND_ENEMY_HQ_AVOID * BOT_EXPAND_ENEMY_HQ_AVOID
    || distSqToEnemySpawn(player, field.x, field.z) < BOT_EXPAND_ENEMY_HQ_AVOID * BOT_EXPAND_ENEMY_HQ_AVOID;
  if (denied) {
    noteExpandAvoid(mem, field.id, elapsed);
    mem.expandCommitFieldId = null;
    if (_rerouteDepth < 1) {
      const altId = findUnclaimedDiscoveredFieldId(player);
      const alt = altId ? State.resourceFields.get(altId) : null;
      if (alt && alt.id !== field.id) {
        return driveMobileHqExpansion(player, alt, _rerouteDepth + 1);
      }
    }
    // Denied crystal: stop short. Do not keep the old move into the gun, and do
    // not accept a home-pad attack-move — that was the turnback.
    if (
      u.state === 'moving'
      && u.targetPos
      && Pathfinding.getDistanceSq(u.targetPos.x, u.targetPos.z, field.x, field.z) < 48 * 48
    ) {
      Units.commandStop([u.id]);
    }
    if (elapsed - (mem._mhqDenyLogAt || 0) > 5) {
      mem._mhqDenyLogAt = elapsed;
      Trace.traceOrder('mhq_denied', pid, {
        keep: true,
        why: field?.id || 'denied',
        x: Math.round(u.x),
        z: Math.round(u.z),
      });
    }
    return false;
  }

  mem.expandCommitFieldId = field.id;

  const spot = findMobileHqDeploySpotNearField(field, pid, player);
  if (!spot || expandSiteIsHostile(player, spot.x, spot.z)) {
    noteExpandAvoid(mem, field.id, elapsed);
    mem.expandCommitFieldId = null;
    if (_rerouteDepth < 1) {
      const altId = findUnclaimedDiscoveredFieldId(player);
      const alt = altId ? State.resourceFields.get(altId) : null;
      if (alt && alt.id !== field.id) return driveMobileHqExpansion(player, alt, _rerouteDepth + 1);
    }
    return false;
  }

  // Already standing on a legal pad for this crystal. Waiting for a searched
  // spot a few metres away left the MHQ idle for minutes (deploy code was clear).
  if (
    Pathfinding.getDistanceSq(u.x, u.z, field.x, field.z) < 32 * 32
    && Buildings.getMobileHqDeployFailureCode(pid, u.x, u.z) === null
    && spotWouldAllowClaimRefinery(field, pid, u.x, u.z)
  ) {
    if (Buildings.tryDeployMobileHq(u)) {
      console.log(`🤖 P${pid} deployed Mobile HQ near field ${field.id}`);
      return true;
    }
  }

  const bestD = Pathfinding.getDistanceSq(u.x, u.z, spot.x, spot.z);
  const arriveR = 5.5;
  if (bestD <= arriveR * arriveR) {
    if (Buildings.tryDeployMobileHq(u)) {
      console.log(`🤖 P${pid} deployed Mobile HQ near field ${field.id}`);
      u._mhqDeployFails = 0;
      return true;
    }
    u._mhqDeployFails = (u._mhqDeployFails || 0) + 1;
    if (u._mhqDeployFails >= 3) {
      noteExpandAvoid(mem, field.id, elapsed);
      mem.expandCommitFieldId = null;
      u._mhqDeployFails = 0;
      if (_rerouteDepth < 1) {
        const altId = findUnclaimedDiscoveredFieldId(player);
        const alt = altId ? State.resourceFields.get(altId) : null;
        if (alt && alt.id !== field.id) return driveMobileHqExpansion(player, alt, _rerouteDepth + 1);
      }
      return false;
    }
    // Pad blocked (overlap / ore) — nudge a few metres and retry next tick.
    const nudgeAng = Math.atan2(u.z - field.z, u.x - field.x) + 0.7;
    Units.commandMove(
      [u.id],
      spot.x + Math.cos(nudgeAng) * 6,
      spot.z + Math.sin(nudgeAng) * 6,
      { playerCommanded: false }
    );
    return false;
  }

  // Already marching toward this pad — don't spam repath every bot tick.
  if (
    u.state === 'moving'
    && u.targetPos
    && Pathfinding.getDistanceSq(u.targetPos.x, u.targetPos.z, spot.x, spot.z) < 36
  ) {
    return false;
  }
  Units.commandMove([u.id], spot.x, spot.z, { playerCommanded: false, traceWhy: `expand:${field.id}` });
  return false;
}

function shepherdMobileHq(player) {
  const pid = player.id;
  const liveRefs = State.getPlayerBuildings(pid).filter(b => b.type === 'refinery' && b.hp > 0).length;
  if (liveRefs >= BOT_MAX_REFINERIES) return;
  const hasMhq = State.getPlayerUnits(pid).some(u => u.type === 'mobileHq' && u.hp > 0);
  if (!hasMhq) return;
  const shepherdId = findUnclaimedDiscoveredFieldId(player);
  const shepherdField = shepherdId ? State.resourceFields.get(shepherdId) : null;
  if (shepherdField) driveMobileHqExpansion(player, shepherdField);
}

function pickHarvesterToRetire(harvesters) {
  if (!harvesters.length) return null;
  return harvesters.reduce((a, b) => ((a.cargo || 0) <= (b.cargo || 0) ? a : b));
}

function botHasHarvestableKnownFields(team) {
  return countHarvestableKnownFields(team) > 0;
}

function countHarvestableKnownFields(team) {
  let n = 0;
  State.resourceFields.forEach(f => {
    if (f.depleted || !(f.remaining > 0)) return;
    if (Fog.wasExploredByTeam(team, f.x, f.z)) n++;
  });
  return n;
}

function countAliveResourceFields() {
  let n = 0;
  State.resourceFields.forEach(f => {
    if (!f.depleted) n++;
  });
  return n;
}

/** Fields we have explored but not yet covered by a friendly refinery. */
function countUnclaimedDiscoveredFields(player) {
  const pid = player.id;
  const mem = player.botMemory;
  const refs = State.getPlayerBuildings(pid).filter(b => b.type === 'refinery' && b.hp > 0);
  let n = 0;
  for (const id of mem.discoveredResources || []) {
    const field = State.resourceFields.get(id);
    if (!field || field.depleted) continue;
    if (fieldRemainingFrac(field) < BOT_EXPAND_MIN_ORE_FRAC) continue;
    if (!fieldCoveredByOwnedRefinery(pid, field, refs)) n++;
  }
  return n;
}

/** Zero known ore — panic explore with harvesters + many scouts. */
function botNeedsPriorityResourceExploration(player) {
  return countHarvestableKnownFields(player.team) === 0;
}

/**
 * Keep scouting / expanding while any live ore is unknown or unclaimed by us.
 * Stops only when every non-depleted field is covered by one of our refineries.
 */
function botNeedsExpansionScouting(player) {
  const known = countHarvestableKnownFields(player.team);
  const alive = countAliveResourceFields();
  if (known < alive) return true;
  return countUnclaimedDiscoveredFields(player) > 0;
}

function scoutWaypointDanger(mem, elapsed, x, z) {
  let d = 0;
  mem.targets.forEach(t => {
    const dist = Math.sqrt(Pathfinding.getDistanceSq(x, z, t.x, t.z)) + 4;
    let w = t.type === 'building' ? 2.4 : 0.9;
    if (t.type === 'building') {
      const b = State.buildings.get(t.id);
      if (b && b.type === 'hq') w *= 2;
      if (b && (b.type === 'artilleryTurret' || b.type === 'turret')) {
        w *= b.type === 'artilleryTurret' ? 5.5 : 3.2;
      }
    }
    if (t.type === 'vehicle') {
      const u = State.units.get(t.id);
      if (u && u.type === 'artillery') w *= 4.5;
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

function scoreUnexploredCellForExplore(c, hq, mem, elapsed, excludePrev, harvesters, preferFar = false) {
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
  // Default: prefer nearby fog. Expansion: prefer map-center / mid-range so contested
  // crystals get found instead of forever ring-scouting the HQ fringe.
  let distTerm = distHq;
  if (preferFar) {
    const distOrigin = c.x * c.x + c.z * c.z;
    distTerm = distOrigin * 0.65 - Math.min(distHq, 120 * 120) * 0.4;
  }
  return distTerm + danger * BOT_SCOUT_DANGER_WEIGHT + penalty;
}

/**
 * Picks up to `wantCount` fog cell centers in different compass sectors from HQ, each ≥ BOT_EXPLORE_MIN_SEP apart.
 */
function allocateDiverseExploreTargets(player, hq, mem, elapsed, wantCount, excludePrev, harvesters) {
  pruneExploreReservations(mem, elapsed);
  const team = player.team;
  const raw = Fog.getUnexploredCellCenters(team);
  if (raw.length === 0) return [];

  const preferFar =
    botNeedsExpansionScouting(player)
    || botNeedsPriorityResourceExploration(player)
    || botNeedsEnemyHqScouting(player);
  const sectors = BOT_EXPLORE_SECTORS;
  const buckets = Array.from({ length: sectors }, () => []);
  for (const c of raw) {
    const score = scoreUnexploredCellForExplore(c, hq, mem, elapsed, excludePrev, harvesters, preferFar);
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
        const snapped = Pathfinding.snapWorldXZToWalkable(item.c.x, item.c.z);
        const goal = { x: snapped.x, z: snapped.z };
        if (tooCloseToPicked(goal)) continue;
        picked.push(goal);
        mem.exploreReservations.push({
          x: goal.x,
          z: goal.z,
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
        score: scoreUnexploredCellForExplore(c, hq, mem, elapsed, excludePrev, harvesters, preferFar),
      }))
      .sort((a, b) => a.score - b.score);
    for (const item of flat) {
      if (picked.length >= wantCount) break;
      if (tooCloseToPicked(item.c)) continue;
      const snapped = Pathfinding.snapWorldXZToWalkable(item.c.x, item.c.z);
      const goal = { x: snapped.x, z: snapped.z };
      if (tooCloseToPicked(goal)) continue;
      picked.push(goal);
      mem.exploreReservations.push({
        x: goal.x,
        z: goal.z,
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

/** Living enemy HQs this bot has not yet recorded in `mem.targets`. */
function botNeedsEnemyHqScouting(player) {
  // Scout bikes come from the factory — don't divert early infantry into suicide corner marches.
  const hasFactory = State.getPlayerBuildings(player.id).some(
    b => b.type === 'warFactory' && b.hp > 0
  );
  if (!hasFactory) return false;
  const known = getKnownEnemyHqIds(player);
  const living = getLivingEnemyHqs(player);
  return living.some(b => !known.has(b.id));
}

function getKnownEnemyHqIds(player) {
  const ids = new Set();
  const mem = player.botMemory;
  if (!mem?.targets) return ids;
  for (let i = 0; i < mem.targets.length; i++) {
    const t = mem.targets[i];
    if (t.type !== 'building') continue;
    const b = State.buildings.get(t.id);
    if (!b || b.type !== 'hq' || b.hp <= 0) continue;
    const owner = State.players[b.ownerId];
    if (owner && owner.team !== player.team) ids.add(b.id);
  }
  return ids;
}

function getLivingEnemyHqs(player) {
  const list = [];
  State.buildings.forEach(b => {
    if (b.type !== 'hq' || b.hp <= 0) return;
    const owner = State.players[b.ownerId];
    if (!owner || owner.isDefeated || owner.team === player.team) return;
    list.push(b);
  });
  return list;
}

/**
 * Fair map intel: path toward unknown enemies' match-spawn corners (public layout knowledge),
 * not toward hidden building coordinates. Softens danger weight so recon still goes.
 */
function pickEnemyIntelWaypoint(player, hq, mem, elapsed, excludePrev) {
  const known = getKnownEnemyHqIds(player);
  const unknown = getLivingEnemyHqs(player).filter(b => !known.has(b.id));
  if (unknown.length === 0) return null;

  const active = collectActiveScoutTargets(mem);
  const candidates = [];
  for (let i = 0; i < unknown.length; i++) {
    const b = unknown[i];
    const owner = State.players[b.ownerId];
    const sx = owner?.spawn?.x ?? b.x;
    const sz = owner?.spawn?.z ?? b.z;
    const dx = sx - hq.x;
    const dz = sz - hq.z;
    const len = Math.hypot(dx, dz) || 1;
    const standoff = BOT_INTEL_SPAWN_STANDOFF;
    const raw = clampWorldToPlayableDisk(
      sx - (dx / len) * standoff,
      sz - (dz / len) * standoff,
      8
    );
    candidates.push({ x: raw.x, z: raw.z, spawnX: sx, spawnZ: sz });
  }

  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (
      excludePrev
      && Pathfinding.getDistanceSq(c.x, c.z, excludePrev.x, excludePrev.z) < 16 * 16
    ) {
      continue;
    }
    if (active.some(t => Pathfinding.getDistanceSq(t.x, t.z, c.x, c.z) < 22 * 22)) continue;
    if (
      (mem.exploreReservations || []).some(
        r => elapsed < r.until && Pathfinding.getDistanceSq(r.x, r.z, c.x, c.z) < 22 * 22
      )
    ) {
      continue;
    }
    const exploredPad = Fog.wasExploredByTeam(player.team, c.spawnX, c.spawnZ) ? 80000 : 0;
    const danger = scoutWaypointDanger(mem, elapsed, c.x, c.z);
    const dist = Pathfinding.getDistanceSq(hq.x, hq.z, c.x, c.z);
    // Prefer unknown (unexplored) pads; accept more danger than ore scouting.
    const score =
      exploredPad + danger * (BOT_SCOUT_DANGER_WEIGHT * 0.28) + dist * 0.12;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best ? { x: best.x, z: best.z, _intel: true } : null;
}

/**
 * Scout destination: fair fog only. Spreads scouts/harvesters across sectors; avoids stacking on one unexplored tile.
 */
function getScoutTarget(player, hq, elapsed, excludePrev, harvesters = []) {
  const mem = player.botMemory;
  const team = player.team;

  if ((mem.personality?.artilleryAffinity ?? 0) >= 0.7) {
    const hidden = nearestSafeUnexploredCrystal(player);
    if (hidden) return { x: hidden.x, z: hidden.z };
  }

  const priorityEco = botNeedsPriorityResourceExploration(player) || botNeedsExpansionScouting(player);

  // Only park ONE scout on an empty known field (not every scout → same crystal).
  if (priorityEco && !excludePrev) {
  for (const fieldId of mem.discoveredResources) {
    const field = State.resourceFields.get(fieldId);
    if (!field || field.depleted) continue;

    const nearbyUnits = unitGrid.queryRadius(field.x, field.z, 15).filter(u => u.team === team);
    if (nearbyUnits.length === 0) {
      const danger = scoutWaypointDanger(mem, elapsed, field.x, field.z);
      if (danger < 4.2 || priorityEco) return { x: field.x, z: field.z };
      }
    }
  } else if (priorityEco && excludePrev) {
    for (const fieldId of mem.discoveredResources) {
      const field = State.resourceFields.get(fieldId);
      if (!field || field.depleted) continue;
      if (Pathfinding.getDistanceSq(field.x, field.z, excludePrev.x, excludePrev.z) < 40 * 40) {
        continue;
      }
      const nearbyUnits = unitGrid.queryRadius(field.x, field.z, 15).filter(u => u.team === team);
      if (nearbyUnits.length === 0) {
        return { x: field.x, z: field.z };
      }
    }
  }

  // Map-corner intel: unknown enemy match spawns (fair public layout knowledge).
  if (!botNeedsPriorityResourceExploration(player)) {
    const intel = pickEnemyIntelWaypoint(player, hq, mem, elapsed, excludePrev);
    if (intel) {
      mem.exploreReservations = mem.exploreReservations || [];
      mem.exploreReservations.push({
        x: intel.x,
        z: intel.z,
        until: elapsed + Math.max(BOT_EXPLORE_RESERVE_SEC, 28),
      });
      return intel;
    }
  }

  const fogGoal = pickSingleExploreWaypointDiverse(player, hq, mem, elapsed, excludePrev, harvesters);
  if (fogGoal) return fogGoal;

  for (let attempt = 0; attempt < 14; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const t = 0.35 + Math.random() * 0.65;
    const wx = hq.x + Math.cos(angle) * (25 + t * 75);
    const wz = hq.z + Math.sin(angle) * (25 + t * 75);
    const c = clampWorldToPlayableDisk(wx, wz, 8);
    const x = c.x;
    const z = c.z;
    if (!Fog.wasExploredByTeam(team, x, z)) {
      const danger = scoutWaypointDanger(mem, elapsed, x, z);
      if (danger < 5.5) return { x, z };
    }
  }

  const fallback = clampWorldToPlayableDisk(-hq.x * 0.4, -hq.z * 0.4, 10);
  return { x: fallback.x, z: fallback.z };
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

  // Static artillery is the same threat class as mobile guns.
  State.buildings.forEach(b => {
    if (b.team === player.team || b.hp <= 0) return;
    if (b.type !== 'artilleryTurret') return;
    if (!Fog.isVisibleToTeam(player.team, b.x, b.z)) return;
    result.types.artillery = (result.types.artillery || 0) + 1;
    result.total++;
  });

  return result;
}

function pickCounterUnit(enemyAnalysis, category, threatLevel, credits, personality, mem) {
  const enemyArty = enemyAnalysis.types?.artillery || 0;
  const affinity = personality.artilleryAffinity ?? 0.5;
  const siegeMemory = !!(mem && mem._seenEnemyArtillery);

  if (category === 'infantry') {
    if (enemyAnalysis.vehicle > 1) return 'rocketSoldier';
    if (credits < 180 || (threatLevel <= 3 && enemyAnalysis.infantry < 5)) return 'rifleman';
    if (credits < 320) return Math.random() < 0.45 ? 'rifleman' : 'sniper';
    if (enemyAnalysis.infantry > 7) return 'sniper';
    return Math.random() < 0.55 ? 'rifleman' : 'sniper';
  }

  if (category === 'vehicle') {
    // A siege profile builds artillery as the army, not only after a gun is visible.
    if ((affinity >= 0.7 || enemyArty > 0 || (siegeMemory && affinity >= 0.55)) && credits >= 500) {
      return 'artillery';
    }
    if (enemyAnalysis.infantry > 8 && credits >= 500) return 'artillery';
    if (credits < 380) return 'lightTank';
    if (threatLevel >= 7 && credits >= 520) return 'heavyTank';
    return personality.techPreference > 0.62 ? 'heavyTank' : 'lightTank';
  }

  return 'rifleman';
}
