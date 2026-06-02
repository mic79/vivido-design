/**
 * GTAVR — multiplayer combat sync: arrows, bow visuals, vehicle damage (host-forwarded).
 */

import * as THREE from 'three';
import {
    setLocalArrowFiredCallback,
    setMultiplayerArrowHitCallback,
    spawnRemoteNetworkArrow,
    buildRemoteBowVisual,
    updateRemoteBowVisual,
    playMetalHitAt,
} from './vrrunner/bots.js';

const VEHICLE_ARROW_DAMAGE = 12;
const VEHICLE_EXPLOSIVE_DAMAGE = 35;
const VEHICLE_MINIGUN_DAMAGE_NET = 2;
const REMOTE_MINIGUN_HIT_MIN_INTERVAL_MS = 90;

let deps = null;
const remoteMinigunHitLastMs = {};
const remoteBows = [];
const hostOccupants = {};
let occupancyRequestId = 0;
const pendingOccupancy = new Map();
const _seg = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();

function occupancyKey(kind, slot) {
    return kind + ':' + slot;
}

export function initMultiplayerSync(options) {
    deps = options;
    if (deps.ensureArcheryReady) deps.ensureArcheryReady();
    setLocalArrowFiredCallback(function(payload) {
        if (!deps || !deps.isMultiplayerActive()) return;
        sendCombatEvent('arrow-fired', payload);
    });
    setMultiplayerArrowHitCallback(function(arrow, prev, dirUnit, segLen) {
        if (!deps || !deps.isMultiplayerActive()) return null;
        return testArrowMultiplayerHit(arrow, prev, dirUnit, segLen);
    });
}

export function setupRemoteAvatarArchery(remoteAvatars) {
    if (!remoteAvatars || !deps) return;
    for (let i = 0; i < remoteAvatars.length; i++) {
        const av = remoteAvatars[i];
        if (!av.mesh) continue;
        const leftHand = new THREE.Group();
        leftHand.name = 'RemoteLeftHand';
        leftHand.position.set(-0.42, 1.05, -0.12);
        const rightHand = new THREE.Group();
        rightHand.name = 'RemoteRightHand';
        rightHand.position.set(0.42, 1.05, -0.12);
        av.mesh.add(leftHand);
        av.mesh.add(rightHand);
        const bow = buildRemoteBowVisual();
        if (bow) {
            av.mesh.add(bow);
        }
        av.leftHand = leftHand;
        av.rightHand = rightHand;
        av.bowGroup = bow;
        remoteBows[i] = av;
    }
}

export function syncRemoteArcheryFromState(playerIndex, archeryState) {
    const av = remoteBows[playerIndex];
    if (!av) return;
    if (!av.bowGroup && deps) {
        av.bowGroup = buildRemoteBowVisual();
        if (av.bowGroup && av.mesh) av.mesh.add(av.bowGroup);
    }
    if (!av.bowGroup) return;
    updateRemoteBowVisual(av.bowGroup, archeryState, av.leftHand, av.rightHand);
}

export function updateRemoteArcheryFromNetworkStates(remotePlayerStates, myPlayerId) {
    if (!remotePlayerStates) return;
    remotePlayerStates.forEach(function(state, playerId) {
        if (playerId === myPlayerId || !state || state.mode !== 'foot') return;
        const idx = parseInt(playerId.split('_')[1], 10);
        if (!isFinite(idx) || idx < 0) return;
        syncRemoteArcheryFromState(idx, state.archery || { eq: 0 });
    });
}

export function sendCombatEvent(event, payload) {
    if (!deps || !deps.isMultiplayerActive()) return;
    const data = {
        type: 'combat-event',
        event: event,
        playerId: deps.getMyPlayerId(),
        payload: payload || {},
        t: performance.now()
    };
    if (deps.isHost()) {
        handleCombatEvent(data, deps.getMyPlayerId());
        deps.sendToAllPlayers(data);
    } else {
        deps.sendToHost(data);
    }
}

export function handleCombatEvent(data, fromPlayerId) {
    if (!deps || !data || !data.event) return;
    const myId = deps.getMyPlayerId();
    const pid = data.playerId || fromPlayerId;

    switch (data.event) {
        case 'arrow-fired':
            if (pid !== myId) {
                const p = data.payload || {};
                spawnRemoteNetworkArrow({
                    ownerId: pid,
                    ox: p.ox, oy: p.oy, oz: p.oz,
                    dx: p.dx, dy: p.dy, dz: p.dz,
                    speed: p.speed,
                    explosive: p.explosive,
                    grapple: p.grapple
                });
            }
            break;
        case 'vehicle-hit':
            if (deps.isHost()) {
                applyAuthoritativeVehicleHit(data.payload);
            }
            break;
        case 'vehicle-damage':
            applyClientVehicleDamageSync(data.payload);
            if (deps.syncRemotePlayerVehicleDamage) {
                deps.syncRemotePlayerVehicleDamage(data.payload);
            }
            break;
        case 'vehicle-respawn':
            if (deps.isHost()) {
                const rid = pid;
                deps.resetAuthoritativeVehicleDamage(rid);
                deps.sendToAllPlayers({
                    type: 'combat-event',
                    event: 'vehicle-damage',
                    playerId: deps.getMyPlayerId(),
                    payload: {
                        targetId: rid,
                        damage: deps.getVehicleMaxDamage(),
                        maxDamage: deps.getVehicleMaxDamage(),
                        destroyed: false
                    }
                });
            }
            break;
        case 'occupancy-claim':
            if (deps.isHost()) {
                handleOccupancyClaim(data);
            }
            break;
        case 'occupancy-release':
            if (deps.isHost()) {
                clearHostOccupant(data.payload, pid);
            }
            break;
        case 'occupancy-granted': {
            const grant = data.payload || {};
            if ((grant.targetId || pid) !== myId) break;
            const pending = pendingOccupancy.get(grant.requestId);
            if (pending && pending.callback) pending.callback(true);
            pendingOccupancy.delete(grant.requestId);
            break;
        }
        case 'occupancy-kick': {
            const kick = data.payload || {};
            if ((kick.targetId || pid) !== myId) break;
            if (deps.forceExitOccupiedAsset) deps.forceExitOccupiedAsset(kick);
            break;
        }
        default:
            break;
    }
}

function applyAuthoritativeVehicleHit(payload) {
    if (!payload || !payload.targetId) return;
    const dmg = payload.damage || VEHICLE_MINIGUN_DAMAGE_NET;
    const targetId = payload.targetId;
    const hitPoint = payload.point;

    const currentDamage = deps.getAuthoritativeVehicleDamage(targetId, 0);
    if (currentDamage <= 0) return;

    const nextDamage = deps.getAuthoritativeVehicleDamage(targetId, dmg);
    const syncPayload = {
        targetId: targetId,
        damage: nextDamage,
        maxDamage: deps.getVehicleMaxDamage(),
        hitPoint: hitPoint,
        destroyed: nextDamage <= 0,
        explosive: !!payload.explosive
    };
    deps.sendToAllPlayers({
        type: 'combat-event',
        event: 'vehicle-damage',
        playerId: deps.getMyPlayerId(),
        payload: syncPayload
    });
    applyClientVehicleDamageSync(syncPayload);
}

function applyClientVehicleDamageSync(payload) {
    if (!payload || !payload.targetId) return;
    if (payload.targetId !== deps.getMyPlayerId()) return;
    deps.syncLocalVehicleDamage(payload.damage, payload.destroyed, payload.hitPoint);
}

function testArrowMultiplayerHit(arrow, prev, dirUnit, segLen) {
    if (!deps || segLen < 1e-5) return null;
    const raycaster = deps.getCityRaycaster();
    if (!raycaster) return null;

    raycaster.firstHitOnly = true;
    raycaster.near = 0;
    raycaster.far = segLen;
    raycaster.set(prev, dirUnit);

    const remoteCars = deps.getRemotePlayerCars();
    if (!remoteCars) return null;

    let bestDist = Infinity;
    let bestTarget = null;

    for (let i = 0; i < remoteCars.length; i++) {
        const car = remoteCars[i];
        if (!car || !car.mesh || !car.playerId || car.destroyed || !car.mesh.visible) continue;
        if (car.playerId === deps.getMyPlayerId()) continue;
        const hits = raycaster.intersectObject(car.mesh, true);
        if (hits.length && hits[0].distance < bestDist) {
            bestDist = hits[0].distance;
            bestTarget = { playerId: car.playerId, point: hits[0].point.clone(), arrow: arrow };
        }
    }

    if (!bestTarget) return null;

    const dmg = arrow.explosive ? VEHICLE_EXPLOSIVE_DAMAGE : VEHICLE_ARROW_DAMAGE;
    playMetalHitAt(bestTarget.point, { volume: 0.75, refDistance: 2.5, maxDistance: 55 });

    sendCombatEvent('vehicle-hit', {
        targetId: bestTarget.playerId,
        damage: dmg,
        point: {
            x: bestTarget.point.x,
            y: bestTarget.point.y,
            z: bestTarget.point.z
        },
        source: 'arrow',
        explosive: !!arrow.explosive
    });

    return { consumed: true };
}

export function raycastRemotePlayerVehicles(origin, direction, far) {
    if (!deps || !deps.isMultiplayerActive()) return null;
    const remoteCars = deps.getRemotePlayerCars();
    if (!remoteCars) return null;
    const raycaster = deps.getCityRaycaster();
    if (!raycaster) return null;

    raycaster.firstHitOnly = true;
    raycaster.near = 0.08;
    raycaster.far = far != null ? far : 900;
    raycaster.set(origin, direction);

    let best = null;
    for (let i = 0; i < remoteCars.length; i++) {
        const car = remoteCars[i];
        if (!car || !car.mesh || !car.playerId || car.destroyed || !car.mesh.visible) continue;
        if (car.playerId === deps.getMyPlayerId()) continue;
        const hits = raycaster.intersectObject(car.mesh, true);
        for (let hi = 0; hi < hits.length; hi++) {
            const hit = hits[hi];
            if (!hit.face) continue;
            if (!best || hit.distance < best.distance) {
                hit.remotePlayerId = car.playerId;
                hit.isRemotePlayerVehicle = true;
                best = hit;
            }
        }
    }
    return best;
}

function handleOccupancyClaim(data) {
    const payload = data.payload || {};
    const kind = payload.kind;
    const slot = payload.slot;
    const requestId = payload.requestId;
    const playerId = data.playerId;
    if (kind == null || slot == null || !playerId) return;
    grantOccupancy(kind, slot, requestId, playerId);
}

function clearHostOccupant(payload, playerId) {
    if (!payload || payload.kind == null || payload.slot == null) return;
    const key = occupancyKey(payload.kind, payload.slot);
    if (hostOccupants[key] === playerId) delete hostOccupants[key];
}

function grantOccupancy(kind, slot, requestId, playerId) {
    if (!deps || !deps.isHost()) return;
    const key = occupancyKey(kind, slot);
    const previous = hostOccupants[key];
    if (previous && previous !== playerId) {
        sendOccupancyMessage(previous, {
            type: 'combat-event',
            event: 'occupancy-kick',
            playerId: deps.getMyPlayerId(),
            payload: { kind: kind, slot: slot, targetId: previous }
        });
    }
    hostOccupants[key] = playerId;
    sendOccupancyMessage(playerId, {
        type: 'combat-event',
        event: 'occupancy-granted',
        playerId: deps.getMyPlayerId(),
        payload: { kind: kind, slot: slot, requestId: requestId, targetId: playerId }
    });
}

function sendOccupancyMessage(playerId, data) {
    if (playerId === deps.getMyPlayerId()) {
        handleCombatEvent(data, playerId);
    } else if (deps.sendToPlayer) {
        deps.sendToPlayer(playerId, data);
    }
}

export function requestOccupancy(kind, slot, callback) {
    if (!deps || !deps.isMultiplayerActive()) {
        if (callback) callback(true);
        return;
    }
    const requestId = ++occupancyRequestId;
    if (callback) pendingOccupancy.set(requestId, { kind: kind, slot: slot, callback: callback });
    const data = {
        type: 'combat-event',
        event: 'occupancy-claim',
        playerId: deps.getMyPlayerId(),
        payload: { kind: kind, slot: slot, requestId: requestId }
    };
    if (deps.isHost()) {
        handleOccupancyClaim(data);
    } else if (deps.sendToHost) {
        deps.sendToHost(data);
    }
}

export function releaseOccupancy(kind, slot) {
    if (!deps || !deps.isMultiplayerActive() || kind == null || slot == null) return;
    const data = {
        type: 'combat-event',
        event: 'occupancy-release',
        playerId: deps.getMyPlayerId(),
        payload: { kind: kind, slot: slot }
    };
    if (deps.isHost()) {
        clearHostOccupant(data.payload, deps.getMyPlayerId());
    } else if (deps.sendToHost) {
        deps.sendToHost(data);
    }
}

export function clearOccupancyForPlayer(playerId) {
    if (!playerId) return;
    Object.keys(hostOccupants).forEach(function(key) {
        if (hostOccupants[key] === playerId) delete hostOccupants[key];
    });
}

export function applyMinigunHitToNetworkVehicle(hit) {
    if (!hit || !hit.remotePlayerId) return false;
    const targetId = hit.remotePlayerId;
    const now = performance.now();
    const last = remoteMinigunHitLastMs[targetId] || 0;
    if (now - last < REMOTE_MINIGUN_HIT_MIN_INTERVAL_MS) return true;
    remoteMinigunHitLastMs[targetId] = now;
    sendCombatEvent('vehicle-hit', {
        targetId: targetId,
        damage: VEHICLE_MINIGUN_DAMAGE_NET,
        point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
        source: 'minigun'
    });
    return true;
}
