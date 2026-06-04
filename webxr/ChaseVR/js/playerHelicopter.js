/**
 * ChaseVR — MD-500 helicopter: door enter/exit, rotor animation/audio, VR thumbstick flight.
 */

import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { setBowEquipped, pulseControllerHaptic, spawnWorldSurfaceImpact, tickWorldSurfaceImpactFx } from './vrrunner/bots.js';
import { RUNNER_STANDING_EYE_Y } from './vrrunner/runnerLevel.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const MODE_HELICOPTER = 'helicopter';

const DOOR_HOTSPOT_RADIUS = 0.09;
const DOOR_PROXIMITY_RADIUS = DOOR_HOTSPOT_RADIUS + 0.015;
const DOOR_GRAB_RADIUS = DOOR_HOTSPOT_RADIUS + 0.04;
const DOOR_EXIT_GRAB_RADIUS = DOOR_HOTSPOT_RADIUS + 0.22;
// After prepareHelicopterModel: pilot faces heliRoot −Z (COCKPIT_CAMERA_YAW = π); +Z is tailward.
const HELICOPTER_DOOR_LOCALS = [
    new THREE.Vector3(0.85, 1.45, 2.15),
    new THREE.Vector3(-0.85, 1.45, 2.15),
];
// Pilot-local offsets on heliRoot (+Z nose). +X = pilot's left (camera rig yaw π).
const COCKPIT_CAMERA_LOCAL = new THREE.Vector3(0.3, 0.85, 2.0);
const COCKPIT_CAMERA_YAW = Math.PI;
const HELICOPTER_EXIT_OFFSET = 0.95;
const AIRBORNE_EXIT_ALT_M = 2.5;
const AUTO_LEVEL_RATE = 1.1;
const GROUND_CLEARANCE = 0.04;
const HELI_COLLIDER_MARGIN = 0.06;
const HELI_BODY_RADIUS = 1.65; // legacy fallback if colliders missing
const MAX_TILT = Math.PI / 2.4;
const PITCH_TILT_STIFFNESS = 4.8;
const ROLL_TILT_STIFFNESS = 4.4;
const PITCH_ANG_DAMPING = 2.6;
const ROLL_ANG_DAMPING = 2.35;
const MAX_PITCH_ANG_VEL = 0.95;
const MAX_ROLL_ANG_VEL = 0.82;
const CYCLIC_VIS_SMOOTH = 16;
const CYCLIC_PITCH_ANGLE = 0.26;
const CYCLIC_ROLL_ANGLE = 0.26;
const CYCLIC_PITCH_SHIFT = 0.05;
const CYCLIC_ROLL_SHIFT = 0.045;
const CYCLIC_GRAB_RADIUS = DOOR_GRAB_RADIUS;
/** Hand travel on cyclic (local m) mapped to full pitch/roll stick deflection. */
const CYCLIC_HAND_PITCH_RANGE = 0.11;
const CYCLIC_HAND_ROLL_RANGE = 0.09;
const CYCLIC_GRAB_INPUT_DEADZONE = 0.04;
/** Debug markers — 30 cm cones at estimated minigun mounts, tips toward heliRoot −Z (nose). */
const MINIGUN_CONE_HEIGHT = 0.3;
const MINIGUN_CONE_RADIUS = 0.12;
// Side mounts on heliRoot (meters). Fuselage forward for placement = +Z. Cone tips use computeHeliNoseDir().
const HELICOPTER_MINIGUN_LOCALS = [
    new THREE.Vector3(1.72, 0.80, 1.15),
    new THREE.Vector3(-1.72, 0.80, 1.15),
];
const IDLE_DISPLAY_RPM = 680;
const MAX_DISPLAY_RPM = 2700;

const ROTOR_ANIM_BASE_SPEED = 1.0;
const ROTOR_SPOOL_UP = 0.42;
const ROTOR_SPOOL_DOWN = 0.55;
const ROTOR_IDLE = 0.22;
const MAX_LIFT_ACCEL = 16;
const GRAVITY = 9.8;
const YAW_RATE = 1.15;
const DRAG = 0.35;
const STICK_DEADZONE = 0.12;

const ROTOR_SFX_URL = new URL('../audio/freesound_community-helicopter-sound-41975.mp3', import.meta.url).href;
const TRIGGER_SFX_URL = new URL('../audio/submarine-sonar-38243-once.mp3', import.meta.url).href;
const MINIGUN_SFX_URL = new URL('../audio/u_w4utmqapnm-mini-gun-154177.mp3', import.meta.url).href;
const METAL_HIT_SFX_URLS = [
    new URL('../audio/metal-hit-92-200420.mp3', import.meta.url).href,
    new URL('../audio/metal-hit-94-200422.mp3', import.meta.url).href,
    new URL('../audio/metal-hit-95-200424.mp3', import.meta.url).href,
];
const MINIGUN_SPOOL_SEC = 0.5;
const MINIGUN_FIRE_SEC = 2.5;
const MINIGUN_COOLDOWN_SEC = 2.0;
const MINIGUN_CYCLE_SEC = MINIGUN_SPOOL_SEC + MINIGUN_FIRE_SEC + MINIGUN_COOLDOWN_SEC;
const MINIGUN_ROF = 16;
const MINIGUN_MAX_SHOTS_PER_FRAME = 4;
const MINIGUN_RAY_RANGE = 900;
const MINIGUN_SPREAD = 0.014;
const MINIGUN_TRACER_TTL = 0.08;
const MINIGUN_TRACER_RADIUS = 0.038;
const MINIGUN_TRACER_FALLBACK_LEN = 55;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _moveDir = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _nextPos = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _muzzleRight = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _tracerUp = new THREE.Vector3(0, 1, 0);
const _tracerQuat = new THREE.Quaternion();
const _coneQuat = new THREE.Quaternion();
const _colliderQuat = new THREE.Quaternion();
const _colliderInvQuat = new THREE.Quaternion();
const _discTangentU = new THREE.Vector3();
const _discTangentV = new THREE.Vector3();
const _colliderNormalW = new THREE.Vector3();
const _colliderCenterW = new THREE.Vector3();
const _colliderSupportW = new THREE.Vector3();
const _colliderTmpBox = new THREE.Box3();
const _corner = new THREE.Vector3();

/** @type {Array<{type:'box'|'disc',center:THREE.Vector3,halfExtents?:THREE.Vector3,radius?:number,thickness?:number,normal?:THREE.Vector3,margin:number}>} */
const heliColliders = [];
let heliColliderDebugGroup = null;

let deps = null;
let mode = null;
let heliRoot = null;
let heliMesh = null;
const HELI_COMBAT_MAX_HP = 100;
let heliCombatHp = HELI_COMBAT_MAX_HP;
let doorGroup = null;
let doorEnterMeshes = [];
let doorExitMeshes = [];
let rotorMixer = null;
let rotorAction = null;
let rotorSpin = 0;
let collective = 0;
let angVelPitch = 0;
let angVelRoll = 0;
let cyclicVisPitch = 0;
let cyclicVisRoll = 0;
let cyclicNode = null;
let cyclicGrabMesh = null;
let minigunDebugGroup = null;
const minigunConeMeshes = [null, null];
const cyclicGrabLocal = new THREE.Vector3();
const cyclicMarkerHeliLocal = new THREE.Vector3();
const cyclicGrabLocalTweak = new THREE.Vector3(0, 0, 0);
let cyclicRestRotation = new THREE.Euler();
let cyclicRestPosition = new THREE.Vector3();
let velocity = new THREE.Vector3();
let heliAutonomousFlight = false;
let doorInteractLatch = false;
let lastDoorIndex = 0;
let occupiedHeliSlot = null;
const vrCyclicGrabSlots = [null, null];
let rotorAudio = null;
let rotorGain = null;
let rotorPanner = null;
let rotorAudioBuffer = null;
let rotorAudioLoadPromise = null;
let triggerAudioBuffer = null;
let triggerAudioLoadPromise = null;
let minigunActive = false;
let minigunCycleElapsed = 0;
const minigunAudioSlots = [null, null];
const minigunShotAcc = [0, 0];
const minigunTracers = [];
/** @type {Array<{m:number,ox:number,oy:number,oz:number,dx:number,dy:number,dz:number}>} */
let minigunShotBatch = [];
let minigunShotBatchTimer = 0;
/** @type {Map<string,{cycleT:number,active:boolean,audioSlot:object|null}>} */
const remoteMinigunSimByPlayer = new Map();
const doorHotspotInside = [false, false];

function computeHeliNoseDir(out) {
    out.set(0, 0, -1);
    if (!heliMesh || !heliRoot) return out;
    var tail = null;
    var noseRef = null;
    heliMesh.traverse(function(child) {
        if (child.name === 'Tail_Rotor') tail = child;
        if (child.name === 'Cockpit' && !noseRef) noseRef = child;
    });
    if (!tail || !noseRef) return out;
    heliRoot.updateMatrixWorld(true);
    tail.getWorldPosition(_v0);
    noseRef.getWorldPosition(_v1);
    heliRoot.worldToLocal(_v0);
    heliRoot.worldToLocal(_v1);
    out.subVectors(_v1, _v0);
    out.y = 0;
    if (out.lengthSq() < 1e-8) return out.set(0, 0, -1);
    return out.normalize();
}

function makeNoseCone(color, name) {
    var mesh = new THREE.Mesh(
        new THREE.ConeGeometry(MINIGUN_CONE_RADIUS, MINIGUN_CONE_HEIGHT, 12),
        new THREE.MeshStandardMaterial({
            color: color,
            emissive: color,
            emissiveIntensity: 0.45,
            transparent: true,
            opacity: 0.88,
            depthWrite: false
        })
    );
    mesh.name = name;
    computeHeliNoseDir(_fwd);
    mesh.quaternion.setFromUnitVectors(_up.set(0, 1, 0), _fwd);
    mesh.renderOrder = 20;
    return mesh;
}

function setupMinigunDebugMarkers(attachNode) {
    if (!attachNode || minigunDebugGroup) return;
    minigunDebugGroup = new THREE.Group();
    minigunDebugGroup.name = 'HeliMinigunDebug';
    computeHeliNoseDir(_fwd);
    for (var i = 0; i < HELICOPTER_MINIGUN_LOCALS.length; i++) {
        var side = i === 0 ? 'Right' : 'Left';
        var cone = makeNoseCone(0xff2222, 'HeliMinigun_' + side);
        cone.position.copy(HELICOPTER_MINIGUN_LOCALS[i]);
        minigunConeMeshes[i] = cone;
        minigunDebugGroup.add(cone);
    }
    attachNode.add(minigunDebugGroup);
    console.log(
        '🚁 Minigun debug cones · nose',
        _fwd.x.toFixed(2),
        _fwd.y.toFixed(2),
        _fwd.z.toFixed(2),
        '· right',
        HELICOPTER_MINIGUN_LOCALS[0].x.toFixed(2),
        HELICOPTER_MINIGUN_LOCALS[0].y.toFixed(2),
        HELICOPTER_MINIGUN_LOCALS[0].z.toFixed(2),
        '· left',
        HELICOPTER_MINIGUN_LOCALS[1].x.toFixed(2),
        HELICOPTER_MINIGUN_LOCALS[1].y.toFixed(2),
        HELICOPTER_MINIGUN_LOCALS[1].z.toFixed(2)
    );
}

function makeDoorSphere(color, name) {
    var mesh = new THREE.Mesh(
        new THREE.SphereGeometry(DOOR_HOTSPOT_RADIUS, 12, 12),
        new THREE.MeshStandardMaterial({
            color: color,
            emissive: color,
            emissiveIntensity: 0.55,
            transparent: true,
            opacity: 0.9,
            depthWrite: false
        })
    );
    mesh.name = name;
    mesh.renderOrder = 20;
    return mesh;
}

function isHelicopterMode() {
    return mode === MODE_HELICOPTER;
}

function isFootModeForHeli() {
    if (deps && deps.isFootMode) return deps.isFootMode();
    var foot = window.__chasevrPlayerFoot;
    return !!(foot && foot.isFootMode && foot.isFootMode());
}

function getTriggerAudioContext() {
    return deps && deps.getAudioContext ? deps.getAudioContext() : null;
}

function ensureAudioBuffer(url, cacheRef, promiseRef) {
    if (cacheRef.val) return Promise.resolve(cacheRef.val);
    var ctx = getTriggerAudioContext();
    if (!ctx) return Promise.resolve(null);
    if (promiseRef.val) return promiseRef.val;
    promiseRef.val = fetch(url)
        .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.arrayBuffer();
        })
        .then(function(ab) {
            return new Promise(function(resolve, reject) {
                ctx.decodeAudioData(ab, resolve, reject);
            });
        })
        .then(function(buf) {
            cacheRef.val = buf;
            return buf;
        })
        .catch(function(err) {
            promiseRef.val = null;
            console.warn('Helicopter SFX load failed:', url, err);
            return null;
        });
    return promiseRef.val;
}

const _rotorBuf = { val: null };
const _rotorLoad = { val: null };
const _triggerBuf = { val: null };
const _triggerLoad = { val: null };
const _minigunBuf = { val: null };
const _minigunLoad = { val: null };
const _metalHitBufs = { val: null };
const _metalHitLoad = { val: null };
const _metalHitTimes = [];

function playTriggerSonar(volumeScale) {
    var ctx = getTriggerAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended' && deps.startAudio) deps.startAudio();
    ensureAudioBuffer(TRIGGER_SFX_URL, _triggerBuf, _triggerLoad).then(function(buf) {
        if (!buf || !ctx) return;
        if (ctx.state === 'suspended') ctx.resume().catch(function() {});
        var src = ctx.createBufferSource();
        src.buffer = buf;
        var gain = ctx.createGain();
        gain.gain.value = 0.55 * (volumeScale == null ? 1 : volumeScale);
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(0);
    });
}

function stopRotorAudioLoop() {
    if (rotorAudio) {
        try { rotorAudio.stop(); } catch (e) { /* already stopped */ }
        try { rotorAudio.disconnect(); } catch (e) { /* noop */ }
    }
    rotorAudio = null;
    if (rotorGain) {
        try { rotorGain.disconnect(); } catch (e) { /* noop */ }
    }
    rotorGain = null;
    if (rotorPanner) {
        try { rotorPanner.disconnect(); } catch (e) { /* noop */ }
    }
    rotorPanner = null;
}

/** Rotor loop only while piloting or heli is spooling down after a bailout. */
function isRotorAudioActive() {
    if (isHelicopterMode()) return true;
    return !!(heliAutonomousFlight && (rotorSpin > 0.04 || collective > 0.04));
}

function ensureRotorAudioLoop() {
    var ctx = getTriggerAudioContext();
    if (!ctx || rotorAudio) return;
    ensureAudioBuffer(ROTOR_SFX_URL, _rotorBuf, _rotorLoad).then(function(buf) {
        if (!buf || !ctx || rotorAudio) return;
        resumeAudioContext();
        rotorGain = ctx.createGain();
        rotorGain.gain.value = 0;
        var spatial = deps && deps.getSpatialAudio ? deps.getSpatialAudio() : null;
        if (spatial) {
            rotorPanner = spatial.createPanner({
                refDistance: 3,
                maxDistance: 200,
                rolloffFactor: 1.15
            });
            rotorGain.connect(rotorPanner);
        } else if (typeof window !== 'undefined' && window.spatialBusGain) {
            rotorGain.connect(window.spatialBusGain);
        } else {
            rotorGain.connect(ctx.destination);
        }
        rotorAudio = ctx.createBufferSource();
        rotorAudio.buffer = buf;
        rotorAudio.loop = true;
        rotorAudio.connect(rotorGain);
        rotorAudio.start(0);
    });
}

function updateRotorAudioVolume() {
    if (!rotorGain) return;
    var rpmNorm = Math.min(1, rotorSpin * 0.45 + collective * 0.55);
    if (!isRotorAudioActive() || rpmNorm < 0.02) {
        rotorGain.gain.value = 0;
        if (!isHelicopterMode()) stopRotorAudioLoop();
        return;
    }
    if (rotorPanner && heliRoot) {
        heliRoot.updateMatrixWorld(true);
        heliRoot.getWorldPosition(_v0);
        var spatial = deps && deps.getSpatialAudio ? deps.getSpatialAudio() : null;
        if (spatial) spatial.setPannerPosition(rotorPanner, _v0.x, _v0.y, _v0.z);
    }
    var inCockpit = isHelicopterMode();
    rotorGain.gain.value = rpmNorm * rpmNorm * (inCockpit ? 0.55 : 0.4);
}

function ensureMetalHitBuffers() {
    if (_metalHitBufs.val) return Promise.resolve(_metalHitBufs.val);
    if (_metalHitLoad.val) return _metalHitLoad.val;
    _metalHitLoad.val = Promise.all(METAL_HIT_SFX_URLS.map(function(url) {
        var cache = { val: null };
        var load = { val: null };
        return ensureAudioBuffer(url, cache, load).then(function(buf) { return buf; });
    })).then(function(buffers) {
        _metalHitBufs.val = buffers.filter(Boolean);
        return _metalHitBufs.val;
    }).catch(function() {
        _metalHitLoad.val = null;
        return [];
    });
    return _metalHitLoad.val;
}

function resumeAudioContext() {
    var ctx = getTriggerAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended' && deps && deps.startAudio) deps.startAudio();
    if (ctx.state === 'suspended') ctx.resume().catch(function() {});
}

function connectToSpatialBus(gainNode) {
    if (typeof window !== 'undefined' && window.spatialBusGain) {
        gainNode.connect(window.spatialBusGain);
    } else {
        gainNode.connect(getTriggerAudioContext().destination);
    }
}

function playSpatialOneShot(buffer, x, y, z, volume) {
    if (!buffer) return;
    var ctx = getTriggerAudioContext();
    if (!ctx) return;
    resumeAudioContext();
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    var gain = ctx.createGain();
    gain.gain.value = volume == null ? 0.5 : volume;
    src.connect(gain);
    if (deps && deps.getSpatialAudio) {
        var spatialMgr = deps.getSpatialAudio();
        if (spatialMgr && x != null) {
            var panner = spatialMgr.createPanner({
                refDistance: 4,
                maxDistance: 350,
                rolloffFactor: 1.15
            });
            spatialMgr.setPannerPosition(panner, x, y, z);
            gain.connect(panner);
            src.start(0);
            src.stop(ctx.currentTime + buffer.duration + 0.05);
            return;
        }
    } else if (deps && deps.spatialAudio && x != null) {
        var pannerLegacy = deps.spatialAudio.createPanner({
            refDistance: 4,
            maxDistance: 350,
            rolloffFactor: 1.15
        });
        deps.spatialAudio.setPannerPosition(pannerLegacy, x, y, z);
        gain.connect(pannerLegacy);
        src.start(0);
        src.stop(ctx.currentTime + buffer.duration + 0.05);
        return;
    }
    connectToSpatialBus(gain);
    src.start(0);
    src.stop(ctx.currentTime + buffer.duration + 0.05);
}

function playMetalHitAt(point) {
    var now = performance.now();
    while (_metalHitTimes.length && now - _metalHitTimes[0] > 120) _metalHitTimes.shift();
    if (_metalHitTimes.length >= 8) return;
    if (!_metalHitBufs.val || !_metalHitBufs.val.length) return;
    _metalHitTimes.push(now);
    var buf = _metalHitBufs.val[(Math.random() * _metalHitBufs.val.length) | 0];
    var vol = 0.38 + Math.random() * 0.22;
    playSpatialOneShot(buf, point.x, point.y, point.z, vol);
}

function getMinigunCollisionMeshes() {
    if (deps && deps.getCityCollisionMeshes) {
        var meshes = deps.getCityCollisionMeshes();
        if (meshes && meshes.length) return meshes;
    }
    if (deps && deps.getCityRoot) {
        var city = deps.getCityRoot();
        if (city) return [city];
    }
    return null;
}

function getMinigunConeFrame(mountIndex, outCenter, outDir) {
    var cone = minigunConeMeshes[mountIndex];
    if (cone && heliRoot) {
        cone.updateMatrixWorld(true);
        cone.getWorldPosition(outCenter);
        cone.getWorldQuaternion(_coneQuat);
        outDir.set(0, 1, 0).applyQuaternion(_coneQuat).normalize();
    } else if (heliRoot) {
        heliRoot.updateMatrixWorld(true);
        outCenter.copy(HELICOPTER_MINIGUN_LOCALS[mountIndex]);
        heliRoot.localToWorld(outCenter);
        computeHeliNoseDir(outDir);
        outDir.transformDirection(heliRoot.matrixWorld).normalize();
    } else {
        outCenter.set(0, 0, 0);
        outDir.set(0, 0, -1);
        return;
    }
    _muzzleRight.crossVectors(_worldUp, outDir);
    if (_muzzleRight.lengthSq() < 1e-8) _muzzleRight.set(1, 0, 0);
    else _muzzleRight.normalize();
    var spread = MINIGUN_SPREAD;
    outDir.addScaledVector(_muzzleRight, (Math.random() - 0.5) * spread * 2);
    outDir.addScaledVector(_worldUp, (Math.random() - 0.5) * spread * 2);
    outDir.normalize();
}

function getMinigunRayOrigin(mountIndex, outOrigin, outDir) {
    getMinigunConeFrame(mountIndex, outOrigin, outDir);
    outOrigin.addScaledVector(outDir, MINIGUN_CONE_HEIGHT * 0.5);
}

function spawnMinigunTracer(origin, dir, hitDist) {
    var scene = deps && deps.getScene ? deps.getScene() : null;
    if (!scene) return;
    var len = (hitDist != null && hitDist > 0.08)
        ? hitDist
        : MINIGUN_TRACER_FALLBACK_LEN;
    len = Math.min(Math.max(len, 0.2), MINIGUN_RAY_RANGE);
    var geom = new THREE.CylinderGeometry(
        MINIGUN_TRACER_RADIUS,
        MINIGUN_TRACER_RADIUS,
        len,
        6,
        1
    );
    var mat = new THREE.MeshBasicMaterial({
        color: 0xffdd55,
        transparent: true,
        opacity: 0.96,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
    });
    var mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(origin).addScaledVector(dir, len * 0.5);
    _tracerQuat.setFromUnitVectors(_tracerUp, dir);
    mesh.quaternion.copy(_tracerQuat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 9998;
    scene.add(mesh);
    minigunTracers.push({ mesh: mesh, ttl: MINIGUN_TRACER_TTL });
}

function updateMinigunTracers(dt) {
    var scene = deps && deps.getScene ? deps.getScene() : null;
    for (var i = minigunTracers.length - 1; i >= 0; i--) {
        var t = minigunTracers[i];
        t.ttl -= dt;
        if (t.mesh.material) {
            t.mesh.material.opacity = Math.max(0, t.ttl / MINIGUN_TRACER_TTL) * 0.96;
        }
        if (t.ttl <= 0) {
            if (scene) scene.remove(t.mesh);
            t.mesh.geometry.dispose();
            t.mesh.material.dispose();
            minigunTracers.splice(i, 1);
        }
    }
}

function raycastMinigunShot(origin, dir) {
    if (deps && deps.raycastCity) {
        return deps.raycastCity(origin, dir, MINIGUN_RAY_RANGE);
    }
    var meshes = getMinigunCollisionMeshes();
    if (!meshes || !meshes.length) return null;
    _raycaster.firstHitOnly = true;
    _raycaster.set(origin, dir);
    _raycaster.near = 0.08;
    _raycaster.far = MINIGUN_RAY_RANGE;
    var recursive = meshes.length === 1 && meshes[0] && meshes[0].isGroup;
    var hits = _raycaster.intersectObjects(meshes, recursive);
    for (var hi = 0; hi < hits.length; hi++) {
        var hit = hits[hi];
        if (!hit.face || isHeliObject(hit.object)) continue;
        return hit;
    }
    return null;
}

function isMinigunInFireWindow() {
    return minigunActive
        && minigunCycleElapsed >= MINIGUN_SPOOL_SEC
        && minigunCycleElapsed < MINIGUN_SPOOL_SEC + MINIGUN_FIRE_SEC;
}

function sendMinigunCombatEvent(event, payload) {
    if (!deps || !deps.sendCombatEvent) return;
    deps.sendCombatEvent(event, payload || {});
}

function flushMinigunShotBatch() {
    minigunShotBatchTimer = 0;
    if (!minigunShotBatch.length) return;
    var shots = minigunShotBatch;
    minigunShotBatch = [];
    sendMinigunCombatEvent('minigun-shots', {
        slot: getOccupiedHeliSlot(),
        shots: shots
    });
}

function queueMinigunShotNetworkSync(mountIndex, origin, dir, hitDist) {
    if (!deps || !deps.sendCombatEvent) return;
    minigunShotBatch.push({
        m: mountIndex,
        ox: origin.x,
        oy: origin.y,
        oz: origin.z,
        dx: dir.x,
        dy: dir.y,
        dz: dir.z,
        hd: hitDist != null ? hitDist : null
    });
    if (!minigunShotBatchTimer) {
        minigunShotBatchTimer = setTimeout(flushMinigunShotBatch, 48);
    }
}

function fireMinigunRay(mountIndex) {
    if (!heliRoot) return;
    if (deps && deps.isPlayerVehicleDestroyed && deps.isPlayerVehicleDestroyed()) return;
    getMinigunRayOrigin(mountIndex, _v0, _v1);
    var hit = raycastMinigunShot(_v0, _v1);
    var hitDist = hit ? hit.distance : null;
    if (hit && hit.face) {
        _hitNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
        playMetalHitAt(hit.point);
        if ((hit.isPlayerVehicle || hit.isRemotePlayerVehicle || hit.isChaseVehicle
                || hit.isParkedHelicopter)
            && deps && deps.applyVehicleMinigunHit) {
            deps.applyVehicleMinigunHit(hit.point, _hitNormal, hit);
        } else {
            spawnWorldSurfaceImpact(hit.point, _hitNormal);
        }
    }
    spawnMinigunTracer(_v0, _v1, hitDist);
    queueMinigunShotNetworkSync(mountIndex, _v0, _v1, hitDist);
}

function disconnectMinigunAudioSlot(slot) {
    if (!slot) return;
    if (slot.src) {
        try { slot.src.stop(); } catch (e) { /* already stopped */ }
        slot.src.disconnect();
    }
    if (slot.gain) slot.gain.disconnect();
    if (slot.panner) slot.panner.disconnect();
}

function updateMinigunAudioPositions() {
    var spatial = deps && deps.getSpatialAudio ? deps.getSpatialAudio() : null;
    if (!spatial) return;
    for (var si = 0; si < 2; si++) {
        var slot = minigunAudioSlots[si];
        if (!slot || !slot.panner) continue;
        getMinigunConeFrame(si, _v0, _v1);
        spatial.setPannerPosition(slot.panner, _v0.x, _v0.y, _v0.z);
    }
}

function stopMinigunBurst() {
    if (minigunActive) {
        sendMinigunCombatEvent('minigun-burst-stop', {
            slot: getOccupiedHeliSlot()
        });
    }
    minigunActive = false;
    minigunCycleElapsed = 0;
    minigunShotAcc[0] = 0;
    minigunShotAcc[1] = 0;
    if (minigunShotBatch.length) flushMinigunShotBatch();
    for (var ai = 0; ai < 2; ai++) {
        disconnectMinigunAudioSlot(minigunAudioSlots[ai]);
        minigunAudioSlots[ai] = null;
    }
}

function playMinigunBurstSound() {
    var ctx = getTriggerAudioContext();
    if (!ctx) return;
    resumeAudioContext();
    ensureAudioBuffer(MINIGUN_SFX_URL, _minigunBuf, _minigunLoad).then(function(buf) {
        if (!buf || !ctx || !minigunActive) return;
        for (var si = 0; si < 2; si++) {
            disconnectMinigunAudioSlot(minigunAudioSlots[si]);
            getMinigunConeFrame(si, _v0, _v1);
            var slot = {
                src: ctx.createBufferSource(),
                gain: ctx.createGain(),
                panner: null
            };
            slot.src.buffer = buf;
            slot.gain.gain.value = 0.38;
            slot.src.connect(slot.gain);
            var spatial = deps && deps.getSpatialAudio ? deps.getSpatialAudio() : null;
            if (spatial) {
                slot.panner = spatial.createPanner({
                    refDistance: 0.85,
                    maxDistance: 120,
                    rolloffFactor: 1.2
                });
                spatial.setPannerPosition(slot.panner, _v0.x, _v0.y, _v0.z);
                slot.gain.connect(slot.panner);
            } else if (typeof window !== 'undefined' && window.sfxMasterGain) {
                slot.gain.connect(window.sfxMasterGain);
            } else {
                slot.gain.connect(ctx.destination);
            }
            slot.src.start(0);
            minigunAudioSlots[si] = slot;
        }
    });
}

function isMinigunButtonHeld(session) {
    if (!session || !session.inputSources) return false;
    for (var i = 0; i < session.inputSources.length; i++) {
        var gp = session.inputSources[i] && session.inputSources[i].gamepad;
        if (!gp || !gp.buttons || !gp.buttons[4]) continue;
        if (gp.buttons[4].pressed || (gp.buttons[4].value || 0) > 0.5) return true;
    }
    return false;
}

function isHeliObject(obj) {
    if (!obj || !heliRoot) return false;
    var node = obj;
    while (node) {
        if (node === heliRoot || node === heliMesh) return true;
        node = node.parent;
    }
    return false;
}

function beginMinigunCycle() {
    minigunActive = true;
    minigunCycleElapsed = 0;
    minigunShotAcc[0] = 0;
    minigunShotAcc[1] = 0;
    playMinigunBurstSound();
    if (heliRoot) {
        sendMinigunCombatEvent('minigun-burst-start', {
            slot: getOccupiedHeliSlot(),
            x: heliRoot.position.x,
            y: heliRoot.position.y,
            z: heliRoot.position.z,
            ry: heliRoot.rotation.y
        });
    }
}

function updateMinigunShots(dt) {
    var shotDt = Math.min(dt, 0.05);
    for (var gi = 0; gi < 2; gi++) {
        minigunShotAcc[gi] += shotDt * MINIGUN_ROF;
        var shotsThisFrame = 0;
        while (minigunShotAcc[gi] >= 1 && shotsThisFrame < MINIGUN_MAX_SHOTS_PER_FRAME) {
            minigunShotAcc[gi] -= 1;
            fireMinigunRay(gi);
            shotsThisFrame++;
        }
    }
}

function updateMiniguns(dt, session) {
    if (deps && deps.isPlayerVehicleDestroyed && deps.isPlayerVehicleDestroyed()) {
        stopMinigunBurst();
        return;
    }
    updateMinigunTracers(dt);
    if (!isHelicopterMode() || !heliRoot || !session) {
        stopMinigunBurst();
        return;
    }
    if (deps && deps.isMenuVisible && deps.isMenuVisible()) {
        stopMinigunBurst();
        return;
    }
    if (!isMinigunButtonHeld(session)) {
        stopMinigunBurst();
        return;
    }
    if (!minigunActive) beginMinigunCycle();
    updateMinigunAudioPositions();
    minigunCycleElapsed += dt;
    while (minigunCycleElapsed >= MINIGUN_CYCLE_SEC) {
        minigunCycleElapsed -= MINIGUN_CYCLE_SEC;
        playMinigunBurstSound();
    }
    if (minigunCycleElapsed >= MINIGUN_SPOOL_SEC
        && minigunCycleElapsed < MINIGUN_SPOOL_SEC + MINIGUN_FIRE_SEC) {
        updateMinigunShots(dt);
    }
}

function setupDoorHandles(attachNode) {
    if (!attachNode || doorGroup) return;
    doorGroup = new THREE.Group();
    doorGroup.name = 'HeliDoorHotspots';
    doorEnterMeshes = [];
    doorExitMeshes = [];
    for (var i = 0; i < HELICOPTER_DOOR_LOCALS.length; i++) {
        var side = i === 0 ? 'Right' : 'Left';
        var enter = makeDoorSphere(0x66ccff, 'HeliDoorEnter' + side);
        var exit = makeDoorSphere(0xff8844, 'HeliDoorExit' + side);
        enter.position.copy(HELICOPTER_DOOR_LOCALS[i]);
        exit.position.copy(HELICOPTER_DOOR_LOCALS[i]);
        doorGroup.add(enter);
        doorGroup.add(exit);
        doorEnterMeshes.push(enter);
        doorExitMeshes.push(exit);
    }
    attachNode.add(doorGroup);
    updateDoorVisibility();
}

function updateDoorVisibility() {
    var foot = isFootModeForHeli();
    var heli = isHelicopterMode();
    if (doorEnterMeshes.length) {
        for (var i = 0; i < doorEnterMeshes.length; i++) {
            doorEnterMeshes[i].visible = foot;
        }
        for (var j = 0; j < doorExitMeshes.length; j++) {
            doorExitMeshes[j].visible = heli;
        }
    }
    if (cyclicGrabMesh) {
        cyclicGrabMesh.visible = false;
    }
    if (minigunDebugGroup) {
        minigunDebugGroup.visible = foot || heli;
    }
}

function computeCyclicGrabLocal(out) {
    out.set(0, 0, 0);
    if (!cyclicNode) return out;
    var savedPos = cyclicNode.position.clone();
    var savedRot = cyclicNode.rotation.clone();
    cyclicNode.position.copy(cyclicRestPosition);
    cyclicNode.rotation.copy(cyclicRestRotation);
    cyclicNode.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(cyclicNode);
    cyclicNode.position.copy(savedPos);
    cyclicNode.rotation.copy(savedRot);
    if (box.isEmpty()) return out;
    _v2.set(
        (box.min.x + box.max.x) * 0.5,
        box.max.y,
        (box.min.z + box.max.z) * 0.5
    );
    cyclicNode.worldToLocal(_v2);
    out.copy(_v2).add(cyclicGrabLocalTweak);
    return out;
}

function getCyclicGrabWorldPos(out) {
    if (!cyclicNode || !heliRoot) return null;
    computeCyclicGrabLocal(_v1);
    out.copy(_v1);
    cyclicNode.localToWorld(out);
    return out;
}

function worldPosToHeliLocal(worldPos, out) {
    heliRoot.updateMatrixWorld(true);
    out.copy(worldPos);
    heliRoot.worldToLocal(out);
    return out;
}

function syncCyclicGrabMarkerPosition() {
    if (!cyclicGrabMesh || !heliRoot || !cyclicNode) return;
    if (cyclicMarkerHeliLocal.lengthSq() > 1e-8) {
        cyclicGrabMesh.position.copy(cyclicMarkerHeliLocal);
        return;
    }
    getCyclicGrabWorldPos(_v0);
    heliRoot.worldToLocal(_v0);
    cyclicGrabMesh.position.copy(_v0);
}

function setupCyclicGrabHotspot() {
    if (!cyclicNode || !heliRoot) return;
    computeCyclicGrabLocal(cyclicGrabLocal);
    if (cyclicGrabMesh && cyclicGrabMesh.parent) {
        cyclicGrabMesh.parent.remove(cyclicGrabMesh);
    }
    // Same world-size hotspot as door handles — parent on heliRoot (meters), not on
    // the 0.01-scaled GLTF interior (would shrink the sphere ~100×).
    cyclicGrabMesh = makeDoorSphere(0xffcc44, 'HeliCyclicGrab');
    heliRoot.add(cyclicGrabMesh);
    getCyclicGrabWorldPos(_v0);
    heliRoot.worldToLocal(_v0);
    _v0.y -= 0.1;
    cyclicMarkerHeliLocal.copy(_v0);
    cyclicGrabMesh.position.copy(cyclicMarkerHeliLocal);
    cyclicGrabMesh.visible = false;
    console.log(
        '🚁 Cyclic grab hotspot · cyclic-local',
        cyclicGrabLocal.x.toFixed(3),
        cyclicGrabLocal.y.toFixed(3),
        cyclicGrabLocal.z.toFixed(3),
        '· heliRoot-local marker',
        cyclicGrabMesh.position.x.toFixed(3),
        cyclicGrabMesh.position.y.toFixed(3),
        cyclicGrabMesh.position.z.toFixed(3),
        '(yellow sphere, top of Cyclic bbox)'
    );
}

function worldDoorPointByIndex(out, index) {
    var i = Math.max(0, Math.min(HELICOPTER_DOOR_LOCALS.length - 1, index | 0));
    var mesh = doorEnterMeshes[i] || doorExitMeshes[i];
    if (mesh) return mesh.getWorldPosition(out);
    if (!heliRoot) return null;
    out.copy(HELICOPTER_DOOR_LOCALS[i]);
    heliRoot.localToWorld(out);
    return out;
}

function distanceToHeliRootDoors(heliRootNode, worldPos) {
    if (!heliRootNode || !worldPos) return Infinity;
    var best = Infinity;
    for (var i = 0; i < HELICOPTER_DOOR_LOCALS.length; i++) {
        _v1.copy(HELICOPTER_DOOR_LOCALS[i]);
        heliRootNode.localToWorld(_v1);
        var d = worldPos.distanceTo(_v1);
        if (d < best) best = d;
    }
    return best;
}

function distanceToDoor(worldPos) {
    if (!heliRoot) return Infinity;
    return distanceToHeliRootDoors(heliRoot, worldPos);
}

function getNearestDoorIndex(worldPos) {
    var best = 0;
    var bestDist = Infinity;
    for (var i = 0; i < HELICOPTER_DOOR_LOCALS.length; i++) {
        var p = worldDoorPointByIndex(_v1, i);
        if (!p) continue;
        var d = worldPos.distanceTo(p);
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    }
    return best;
}

function getGripHandedness(grip, index) {
    var src = grip && grip.userData && grip.userData.xrInputSource;
    if (src && src.handedness) return src.handedness;
    return index === 0 ? 'left' : 'right';
}

function getHandWorldPosition(grip, out) {
    if (!grip) return null;
    out = out || _v0;
    for (var i = 0; i < grip.children.length; i++) {
        var child = grip.children[i];
        if (child.userData && child.userData.isVRHand) {
            child.getWorldPosition(out);
            return out;
        }
    }
    grip.getWorldPosition(out);
    return out;
}

function isGripPressedForHand(session, handedness) {
    if (!session || !session.inputSources) return false;
    for (var i = 0; i < session.inputSources.length; i++) {
        var src = session.inputSources[i];
        if (!src || src.handedness !== handedness) continue;
        var gp = src.gamepad;
        return !!(gp && gp.buttons && gp.buttons[1] && gp.buttons[1].pressed);
    }
    return false;
}

function pulseHand(handedness, intensity, durationMs) {
    pulseControllerHaptic(handedness, intensity, durationMs);
}

function stickAxis(v) {
    if (Math.abs(v) < STICK_DEADZONE) return 0;
    var a = (Math.abs(v) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
    a = Math.min(1, a);
    return (v > 0 ? 1 : -1) * a * a;
}

function handAxis(v) {
    if (Math.abs(v) < CYCLIC_GRAB_INPUT_DEADZONE) return 0;
    var a = (Math.abs(v) - CYCLIC_GRAB_INPUT_DEADZONE) / (1 - CYCLIC_GRAB_INPUT_DEADZONE);
    a = Math.min(1, a);
    return (v > 0 ? 1 : -1) * a * a;
}

function getCyclicGrabHotspotWorldPos(out) {
    if (!heliRoot) return null;
    if (cyclicMarkerHeliLocal.lengthSq() > 1e-8) {
        out.copy(cyclicMarkerHeliLocal);
        heliRoot.updateMatrixWorld(true);
        heliRoot.localToWorld(out);
        return out;
    }
    return getCyclicGrabWorldPos(out);
}

function distanceGripToCyclic(controllerIndex) {
    if (!deps || !deps.controllerGrips || !cyclicNode) return Infinity;
    var grip = deps.controllerGrips[controllerIndex];
    if (!grip) return Infinity;
    grip.getWorldPosition(_v0);
    if (!getCyclicGrabHotspotWorldPos(_v1)) return Infinity;
    return _v0.distanceTo(_v1);
}

function releaseVRCyclicGrab(controllerIndex) {
    var slot = vrCyclicGrabSlots[controllerIndex];
    if (!slot) return;
    var grip = deps && deps.controllerGrips ? deps.controllerGrips[controllerIndex] : null;
    var hand = slot.hand;
    if (hand && slot.anchor) {
        slot.anchor.remove(hand);
        if (grip) {
            grip.add(hand);
            hand.position.set(0, 0, 0);
            hand.rotation.set(0, 0, 0);
        }
        if (deps && deps.setVRHandMesh) deps.setVRHandMesh(controllerIndex, hand);
    }
    if (slot.anchor && slot.anchor.parent) {
        slot.anchor.parent.remove(slot.anchor);
    }
    vrCyclicGrabSlots[controllerIndex] = null;
}

function releaseAllVRCyclicGrabs() {
    releaseVRCyclicGrab(0);
    releaseVRCyclicGrab(1);
}

function isVRCyclicGrabActive() {
    return !!(vrCyclicGrabSlots[0] || vrCyclicGrabSlots[1]);
}

function getVRCyclicGrabSlot(controllerIndex) {
    return vrCyclicGrabSlots[controllerIndex] || null;
}

function ensureVRHandForGrab(controllerIndex) {
    if (!deps || !deps.controllerGrips) return null;
    var grip = deps.controllerGrips[controllerIndex];
    if (!grip) return null;
    var hand = deps.getVRHandMesh ? deps.getVRHandMesh(controllerIndex) : null;
    if (!hand && deps.buildVRHandMesh) {
        hand = deps.buildVRHandMesh(controllerIndex === 0 ? 'left' : 'right');
        grip.add(hand);
        if (deps.setVRHandMesh) deps.setVRHandMesh(controllerIndex, hand);
    }
    return hand;
}

function attachVRHandToCyclic(controllerIndex, worldGripPos) {
    if (!cyclicNode || !heliRoot) return null;
    var hand = ensureVRHandForGrab(controllerIndex);
    var grip = deps.controllerGrips[controllerIndex];
    if (!hand || !grip) return null;

    var grabWorld = worldGripPos.clone();
    worldPosToHeliLocal(grabWorld, _v2);

    // Parent on heliRoot (meters) — not on the 0.01-scaled Cyclic mesh (shrinks hand ~100×).
    var anchor = new THREE.Group();
    anchor.name = 'CyclicGrab_' + controllerIndex;
    anchor.position.copy(_v2);
    heliRoot.add(anchor);

    if (hand.parent) hand.parent.remove(hand);
    anchor.add(hand);
    hand.position.set(0, 0, 0);
    hand.rotation.set(0, 0, 0);
    hand.visible = true;
    if (deps.setVRHandMesh) deps.setVRHandMesh(controllerIndex, hand);

    return {
        anchor: anchor,
        hand: hand,
        grip: grip,
        grabWorld: grabWorld,
        neutralHeli: _v2.clone(),
    };
}

function cyclicInputFromHeliDelta(dx, dz) {
    return {
        roll: handAxis(dx / CYCLIC_HAND_ROLL_RANGE),
        pitch: handAxis(-dz / CYCLIC_HAND_PITCH_RANGE),
    };
}

function syncCyclicGrabAnchorToGrip(slot, grip) {
    grip.getWorldPosition(_v0);
    worldPosToHeliLocal(_v0, _v1);
    slot.anchor.position.copy(_v1);
}

function tryStartVRCyclicGrab(controllerIndex) {
    if (vrCyclicGrabSlots[controllerIndex]) return true;
    if (distanceGripToCyclic(controllerIndex) > CYCLIC_GRAB_RADIUS) return false;
    var grip = deps.controllerGrips[controllerIndex];
    if (!grip || !cyclicNode) return false;
    grip.getWorldPosition(_v0);
    var slot = attachVRHandToCyclic(controllerIndex, _v0);
    if (!slot) return false;
    cyclicVisPitch = 0;
    cyclicVisRoll = 0;
    resetCyclicVisual();
    slot.active = true;
    vrCyclicGrabSlots[controllerIndex] = slot;
    pulseHand(controllerIndex === 0 ? 'left' : 'right', 0.35, 35);
    return true;
}

/**
 * VR cyclic grab — hand parents to the stick like the car steering wheel.
 * @returns {{ pitch: number, roll: number, hasGrab: boolean }}
 */
function updateVRCyclicGrab(session) {
    var out = { pitch: 0, roll: 0, hasGrab: false };
    if (!session || !deps || !cyclicNode || !isHelicopterMode()) {
        releaseAllVRCyclicGrabs();
        return out;
    }
    if (deps.isMenuVisible && deps.isMenuVisible()) {
        releaseAllVRCyclicGrabs();
        return out;
    }
    if (deps.isFlyMode && deps.isFlyMode()) {
        releaseAllVRCyclicGrabs();
        return out;
    }

    var pitchSum = 0;
    var rollSum = 0;
    var grabCount = 0;

    for (var ci = 0; ci < 2; ci++) {
        var grip = deps.controllerGrips[ci];
        if (!grip) continue;
        var handedness = getGripHandedness(grip, ci);
        var gripping = isGripPressedForHand(session, handedness);
        var slot = vrCyclicGrabSlots[ci];

        if (!slot && gripping && distanceGripToCyclic(ci) <= CYCLIC_GRAB_RADIUS) {
            tryStartVRCyclicGrab(ci);
            slot = vrCyclicGrabSlots[ci];
        }
        if (!slot) continue;
        if (!gripping) {
            releaseVRCyclicGrab(ci);
            continue;
        }

        grip.getWorldPosition(_v0);
        worldPosToHeliLocal(_v0, _v1);
        var dx = clampScalar(_v1.x - slot.neutralHeli.x, -CYCLIC_HAND_ROLL_RANGE, CYCLIC_HAND_ROLL_RANGE);
        var dz = clampScalar(_v1.z - slot.neutralHeli.z, -CYCLIC_HAND_PITCH_RANGE, CYCLIC_HAND_PITCH_RANGE);
        syncCyclicGrabAnchorToGrip(slot, grip);

        var inp = cyclicInputFromHeliDelta(dx, dz);
        pitchSum += inp.pitch;
        rollSum += inp.roll;
        grabCount++;
    }

    if (!grabCount) return out;
    out.hasGrab = true;
    out.pitch = pitchSum / grabCount;
    out.roll = rollSum / grabCount;
    return out;
}

function stickVal(v) {
    if (Math.abs(v) < STICK_DEADZONE) return 0;
    return v;
}

function readVRFlightInput(session) {
    var out = { rt: 0, lt: 0, yaw: 0, pitch: 0, roll: 0 };
    if (!session || !session.inputSources) return out;
    for (var i = 0; i < session.inputSources.length; i++) {
        var src = session.inputSources[i];
        var gp = src && src.gamepad;
        if (!gp) continue;
        if (src.handedness === 'right') {
            out.rt = gp.buttons && gp.buttons[0] ? (gp.buttons[0].value || 0) : 0;
            if (gp.axes && gp.axes.length >= 4) {
                out.yaw = stickVal(-(gp.axes[2] || 0));
            }
        }
        if (src.handedness === 'left') {
            out.lt = gp.buttons && gp.buttons[0] ? (gp.buttons[0].value || 0) : 0;
            if (gp.axes && gp.axes.length >= 4) {
                out.roll = stickAxis(-(gp.axes[2] || 0));
                out.pitch = stickAxis(gp.axes[3] || 0);
            }
        }
    }
    return out;
}

function computeExitSpawn() {
    if (!heliRoot || !deps || !deps.cameraRig) return null;
    var doorLocal = HELICOPTER_DOOR_LOCALS[lastDoorIndex] || HELICOPTER_DOOR_LOCALS[0];
    var exitOffsetSign = doorLocal.x >= 0 ? 1 : -1;
    _v1.set(exitOffsetSign, 0, 0).applyQuaternion(heliRoot.quaternion).normalize();
    _v2.set(0, 0, 1).applyQuaternion(heliRoot.quaternion).normalize();
    _v1.addScaledVector(_v2, 0.12).normalize();
    _v1.y = 0;
    if (_v1.lengthSq() < 1e-6) _v1.set(exitOffsetSign, 0, 0);
    _v1.normalize();

    var floorY = getHelicopterFloorY();
    var altAgl = floorY != null ? heliRoot.position.y - floorY : heliRoot.position.y;
    var airborne = altAgl > AIRBORNE_EXIT_ALT_M;

    if (airborne) {
        deps.cameraRig.getWorldPosition(_v0);
        var spawn = _v0.clone().addScaledVector(_v1, 0.4);
        return {
            position: spawn,
            yaw: Math.atan2(_v1.x, _v1.z),
            airborne: true,
            inheritVelocity: velocity.clone()
        };
    }

    _v0.copy(doorLocal);
    heliRoot.localToWorld(_v0);
    var spawnGround = _v0.clone().addScaledVector(_v1, HELICOPTER_EXIT_OFFSET);
    spawnGround.y += RUNNER_STANDING_EYE_Y;
    if (deps.getCityWalkableFloorY) {
        var walkY = deps.getCityWalkableFloorY(spawnGround.x, spawnGround.z, spawnGround.y);
        if (walkY !== null && walkY !== undefined) {
            spawnGround.y = walkY + RUNNER_STANDING_EYE_Y;
        }
    }
    return {
        position: spawnGround,
        yaw: Math.atan2(_v1.x, _v1.z),
        airborne: false,
        inheritVelocity: null
    };
}

function getDisplayRpm() {
    if (rotorSpin < 0.02 && collective < 0.02) return 0;
    // RT spools rotor; LT lowers collective — blend both so HUD reflects accel/decel.
    var rpmNorm = Math.min(1, rotorSpin * 0.45 + collective * 0.55);
    return Math.round(IDLE_DISPLAY_RPM + rpmNorm * (MAX_DISPLAY_RPM - IDLE_DISPLAY_RPM));
}

function getAltitudeM() {
    if (!heliRoot) return 0;
    var floorY = getHelicopterFloorY();
    if (floorY != null) return Math.max(0, heliRoot.position.y - floorY);
    return Math.max(0, heliRoot.position.y);
}

function getFlightHudText() {
    if (!isHelicopterMode()) return '';
    return getDisplayRpm() + ' RPM · ' + getAltitudeM().toFixed(1) + ' m';
}

function bindCyclicNode() {
    cyclicNode = null;
    if (!heliMesh) return;
    heliMesh.traverse(function(child) {
        if (cyclicNode || child.name !== 'Cyclic') return;
        cyclicNode = child;
    });
    if (!cyclicNode) {
        console.warn('🚁 Cyclic node not found in helicopter GLTF');
        return;
    }
    cyclicRestPosition.copy(cyclicNode.position);
    cyclicRestRotation.copy(cyclicNode.rotation);
    setupCyclicGrabHotspot();
    console.log(
        '🚁 Cyclic stick bound · local pos',
        cyclicRestPosition.x.toFixed(3),
        cyclicRestPosition.y.toFixed(3),
        cyclicRestPosition.z.toFixed(3)
    );
}

function updateCyclicVisual(pitch, roll) {
    if (!cyclicNode) return;
    cyclicNode.rotation.set(
        cyclicRestRotation.x - pitch * CYCLIC_PITCH_ANGLE,
        cyclicRestRotation.y,
        cyclicRestRotation.z - roll * CYCLIC_ROLL_ANGLE
    );
    cyclicNode.position.set(
        cyclicRestPosition.x - roll * CYCLIC_ROLL_SHIFT,
        cyclicRestPosition.y - pitch * CYCLIC_PITCH_SHIFT * 0.2,
        cyclicRestPosition.z - pitch * CYCLIC_PITCH_SHIFT
    );
}

function resetCyclicVisual() {
    cyclicVisPitch = 0;
    cyclicVisRoll = 0;
    if (!cyclicNode) return;
    cyclicNode.rotation.copy(cyclicRestRotation);
    cyclicNode.position.copy(cyclicRestPosition);
}

function clampScalar(v, lo, hi) {
    if (v > hi) return hi;
    if (v < lo) return lo;
    return v;
}

function updateHelicopterTilt(dt, pitchInput, rollInput, controlAuth) {
    var targetPitch = -pitchInput * MAX_TILT * controlAuth;
    var targetRoll = -rollInput * MAX_TILT * controlAuth;
    var pitchErr = targetPitch - heliRoot.rotation.x;
    var rollErr = targetRoll - heliRoot.rotation.z;

    angVelPitch += (pitchErr * PITCH_TILT_STIFFNESS - angVelPitch * PITCH_ANG_DAMPING) * dt;
    angVelRoll += (rollErr * ROLL_TILT_STIFFNESS - angVelRoll * ROLL_ANG_DAMPING) * dt;

    angVelPitch = clampScalar(angVelPitch, -MAX_PITCH_ANG_VEL, MAX_PITCH_ANG_VEL);
    angVelRoll = clampScalar(angVelRoll, -MAX_ROLL_ANG_VEL, MAX_ROLL_ANG_VEL);

    heliRoot.rotation.x += angVelPitch * dt;
    heliRoot.rotation.z += angVelRoll * dt;

    if (heliRoot.rotation.x > MAX_TILT) {
        heliRoot.rotation.x = MAX_TILT;
        if (angVelPitch > 0) angVelPitch = 0;
    } else if (heliRoot.rotation.x < -MAX_TILT) {
        heliRoot.rotation.x = -MAX_TILT;
        if (angVelPitch < 0) angVelPitch = 0;
    }
    if (heliRoot.rotation.z > MAX_TILT) {
        heliRoot.rotation.z = MAX_TILT;
        if (angVelRoll > 0) angVelRoll = 0;
    } else if (heliRoot.rotation.z < -MAX_TILT) {
        heliRoot.rotation.z = -MAX_TILT;
        if (angVelRoll < 0) angVelRoll = 0;
    }
}

function clampTiltAngle(rad) {
    if (rad > MAX_TILT) return MAX_TILT;
    if (rad < -MAX_TILT) return -MAX_TILT;
    return rad;
}

function expandWorldBoxToRootLocal(worldBox, root, outLocal) {
    if (worldBox.isEmpty()) return;
    var minX = Infinity;
    var minY = Infinity;
    var minZ = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    var maxZ = -Infinity;
    for (var xi = 0; xi < 2; xi++) {
        for (var yi = 0; yi < 2; yi++) {
            for (var zi = 0; zi < 2; zi++) {
                _corner.set(
                    xi ? worldBox.max.x : worldBox.min.x,
                    yi ? worldBox.max.y : worldBox.min.y,
                    zi ? worldBox.max.z : worldBox.min.z
                );
                root.worldToLocal(_corner);
                minX = Math.min(minX, _corner.x);
                minY = Math.min(minY, _corner.y);
                minZ = Math.min(minZ, _corner.z);
                maxX = Math.max(maxX, _corner.x);
                maxY = Math.max(maxY, _corner.y);
                maxZ = Math.max(maxZ, _corner.z);
            }
        }
    }
    outLocal.min.set(minX, minY, minZ);
    outLocal.max.set(maxX, maxY, maxZ);
}

function estimateRotorRadius(rotorNode) {
    if (!rotorNode) return 0.5;
    _colliderTmpBox.setFromObject(rotorNode);
    var size = _colliderTmpBox.getSize(_v0);
    return Math.max(size.x, size.y, size.z) * 0.5;
}

function buildHeliCollisionVolumes(root, meshNode) {
    heliColliders.length = 0;
    if (!root || !meshNode) return;

    root.updateMatrixWorld(true);
    meshNode.updateMatrixWorld(true);

    var topRotor = null;
    var tailRotor = null;
    var bodyBoxLocal = new THREE.Box3();
    meshNode.traverse(function(child) {
        if (child.name === 'Top_rotor') topRotor = child;
        if (child.name === 'Tail_Rotor') tailRotor = child;
        if (!child.isMesh) return;
        var name = child.name || '';
        if (name.indexOf('Top_rotor') >= 0 || name.indexOf('Tail_Rotor') >= 0) return;
        if (name.indexOf('Glass') >= 0) return;
        _colliderTmpBox.setFromObject(child);
        expandWorldBoxToRootLocal(_colliderTmpBox, root, bodyBoxLocal);
    });

    if (!bodyBoxLocal.isEmpty()) {
        var bodyCenter = bodyBoxLocal.getCenter(new THREE.Vector3());
        var bodyHalf = bodyBoxLocal.getSize(new THREE.Vector3()).multiplyScalar(0.48);
        bodyHalf.x = Math.max(0.45, bodyHalf.x);
        bodyHalf.y = Math.max(0.45, bodyHalf.y);
        bodyHalf.z = Math.max(0.55, bodyHalf.z);
        heliColliders.push({
            type: 'box',
            center: bodyCenter,
            halfExtents: bodyHalf,
            margin: HELI_COLLIDER_MARGIN
        });
    }

    if (topRotor) {
        var mainCenter = root.worldToLocal(topRotor.getWorldPosition(new THREE.Vector3()));
        var mainRadius = Math.max(1.8, estimateRotorRadius(topRotor) * 1.05);
        heliColliders.push({
            type: 'disc',
            center: mainCenter,
            radius: mainRadius,
            thickness: 0.14,
            normal: new THREE.Vector3(0, 1, 0),
            margin: 0.05
        });
    }

    if (tailRotor) {
        var tailCenter = root.worldToLocal(tailRotor.getWorldPosition(new THREE.Vector3()));
        var tailRadius = Math.max(0.42, estimateRotorRadius(tailRotor) * 0.95);
        tailRotor.getWorldQuaternion(_colliderQuat);
        _colliderNormalW.set(1, 0, 0).applyQuaternion(_colliderQuat).normalize();
        _colliderInvQuat.copy(root.quaternion).invert();
        _colliderNormalW.applyQuaternion(_colliderInvQuat).normalize();
        heliColliders.push({
            type: 'disc',
            center: tailCenter,
            radius: tailRadius,
            thickness: 0.1,
            normal: _colliderNormalW.clone(),
            margin: 0.04
        });
    }

    createHeliColliderDebugMeshes(root);
    console.log(
        '🚁 Helicopter colliders:',
        heliColliders.length,
        heliColliders.map(function(c) { return c.type; }).join(', ')
    );
}

function createHeliColliderDebugMeshes(root) {
    if (heliColliderDebugGroup && heliColliderDebugGroup.parent) {
        heliColliderDebugGroup.parent.remove(heliColliderDebugGroup);
    }
    heliColliderDebugGroup = new THREE.Group();
    heliColliderDebugGroup.name = 'HeliColliderDebug';
    heliColliderDebugGroup.visible = false;

    var mat = new THREE.MeshBasicMaterial({
        color: 0x44ff88,
        wireframe: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false
    });
    var tailMat = mat.clone();
    tailMat.color.setHex(0xff8844);

    for (var i = 0; i < heliColliders.length; i++) {
        var col = heliColliders[i];
        var mesh;
        if (col.type === 'box') {
            mesh = new THREE.Mesh(
                new THREE.BoxGeometry(
                    col.halfExtents.x * 2,
                    col.halfExtents.y * 2,
                    col.halfExtents.z * 2
                ),
                mat
            );
            mesh.position.copy(col.center);
        } else {
            mesh = new THREE.Mesh(
                new THREE.CylinderGeometry(col.radius, col.radius, col.thickness, 24, 1, true),
                col.normal.y > 0.65 ? mat : tailMat
            );
            mesh.position.copy(col.center);
            _colliderNormalW.copy(col.normal);
            if (_colliderNormalW.lengthSq() < 1e-6) _colliderNormalW.set(0, 1, 0);
            _colliderNormalW.normalize();
            mesh.quaternion.setFromUnitVectors(_up.set(0, 1, 0), _colliderNormalW);
        }
        mesh.renderOrder = 25;
        heliColliderDebugGroup.add(mesh);
    }

    root.add(heliColliderDebugGroup);
}

function setHeliColliderDebugVisible(visible) {
    if (heliColliderDebugGroup) heliColliderDebugGroup.visible = !!visible;
}

function getColliderWorldCenter(collider, rootPos, rootQuat, out) {
    out.copy(collider.center).applyQuaternion(rootQuat).add(rootPos);
    return out;
}

function addBoxSupportOffset(collider, rootQuat, dirWorld, outOffset) {
    _colliderInvQuat.copy(rootQuat).invert();
    _v0.copy(dirWorld).applyQuaternion(_colliderInvQuat).normalize();
    outOffset.set(
        _v0.x >= 0 ? collider.halfExtents.x : -collider.halfExtents.x,
        _v0.y >= 0 ? collider.halfExtents.y : -collider.halfExtents.y,
        _v0.z >= 0 ? collider.halfExtents.z : -collider.halfExtents.z
    );
    outOffset.applyQuaternion(rootQuat);
}

function addDiscSupportOffset(collider, rootQuat, dirWorld, outOffset) {
    _colliderNormalW.copy(collider.normal).applyQuaternion(rootQuat).normalize();
    var planar = dirWorld.dot(_colliderNormalW);
    _v0.copy(dirWorld).addScaledVector(_colliderNormalW, -planar);
    outOffset.set(0, 0, 0);
    if (_v0.lengthSq() > 1e-6) {
        _v0.normalize().multiplyScalar(collider.radius);
        outOffset.add(_v0);
    }
    var nSign = dirWorld.dot(_colliderNormalW) >= 0 ? 1 : -1;
    outOffset.addScaledVector(_colliderNormalW, nSign * collider.thickness * 0.5);
}

function getColliderWorldSupport(collider, rootPos, rootQuat, dirWorld, out) {
    getColliderWorldCenter(collider, rootPos, rootQuat, _colliderCenterW);
    if (collider.type === 'box') {
        addBoxSupportOffset(collider, rootQuat, dirWorld, _v1);
    } else {
        addDiscSupportOffset(collider, rootQuat, dirWorld, _v1);
    }
    out.copy(_colliderCenterW).add(_v1);
    return out;
}

function getHeliColliderLowestWorldY(rootPos, rootQuat) {
    if (!heliColliders.length) return rootPos.y;
    var minY = Infinity;
    for (var ci = 0; ci < heliColliders.length; ci++) {
        var col = heliColliders[ci];
        getColliderWorldCenter(col, rootPos, rootQuat, _colliderCenterW);
        if (col.type === 'box') {
            for (var xi = 0; xi < 2; xi++) {
                for (var yi = 0; yi < 2; yi++) {
                    for (var zi = 0; zi < 2; zi++) {
                        _v0.set(
                            xi ? col.halfExtents.x : -col.halfExtents.x,
                            yi ? col.halfExtents.y : -col.halfExtents.y,
                            zi ? col.halfExtents.z : -col.halfExtents.z
                        );
                        _v0.applyQuaternion(rootQuat).add(_colliderCenterW);
                        minY = Math.min(minY, _v0.y);
                    }
                }
            }
        } else {
            _colliderNormalW.copy(col.normal).applyQuaternion(rootQuat).normalize();
            _discTangentU.crossVectors(_colliderNormalW, _worldUp);
            if (_discTangentU.lengthSq() < 1e-5) {
                _discTangentU.set(1, 0, 0).cross(_colliderNormalW);
            }
            _discTangentU.normalize();
            _discTangentV.crossVectors(_colliderNormalW, _discTangentU).normalize();
            for (var ri = 0; ri < 8; ri++) {
                var ang = (ri / 8) * Math.PI * 2;
                _v0.copy(_colliderCenterW)
                    .addScaledVector(_discTangentU, Math.cos(ang) * col.radius)
                    .addScaledVector(_discTangentV, Math.sin(ang) * col.radius)
                    .addScaledVector(_colliderNormalW, -col.thickness * 0.5);
                minY = Math.min(minY, _v0.y);
                _v1.copy(_v0).addScaledVector(_colliderNormalW, col.thickness);
                minY = Math.min(minY, _v1.y);
            }
        }
    }
    return minY;
}

function getHelicopterFloorY() {
    if (!heliRoot || !deps || !deps.getCityWalkableFloorY) return null;
    return deps.getCityWalkableFloorY(
        heliRoot.position.x,
        heliRoot.position.z,
        heliRoot.position.y + 4
    );
}

function clampHelicopterToGround(forceSnap) {
    if (!heliRoot) return;
    var lowestOffset = 0;
    if (heliColliders.length) {
        lowestOffset = getHeliColliderLowestWorldY(heliRoot.position, heliRoot.quaternion) - heliRoot.position.y;
    }

    var minY = null;
    var floorY = getHelicopterFloorY();
    if (floorY != null) minY = floorY + GROUND_CLEARANCE - lowestOffset;

    var meshes = deps && deps.getCityCollisionMeshes ? deps.getCityCollisionMeshes() : null;
    if (meshes && meshes.length) {
        _v1.set(0, -1, 0);
        var probeHeights = heliColliders.length
            ? [3.6, 2.2, 1.0, 0.35]
            : [2.4, 1.2, 0.4];
        for (var pi = 0; pi < probeHeights.length; pi++) {
            _v2.set(heliRoot.position.x, heliRoot.position.y + probeHeights[pi], heliRoot.position.z);
            _raycaster.set(_v2, _v1);
            _raycaster.far = heliRoot.position.y + 40;
            var downHits = _raycaster.intersectObjects(meshes, false);
            for (var di = 0; di < downHits.length; di++) {
                var dh = downHits[di];
                if (!dh.face) continue;
                _hitNormal.copy(dh.face.normal).transformDirection(dh.object.matrixWorld).normalize();
                if (_hitNormal.y < 0.45) continue;
                var gy = dh.point.y + GROUND_CLEARANCE - lowestOffset;
                if (minY == null || gy > minY) minY = gy;
                break;
            }
        }
    }

    if (minY == null) return;
    if (forceSnap || heliRoot.position.y < minY) {
        heliRoot.position.y = minY;
        if (velocity.y < 0) velocity.y = 0;
    }
    if (heliRoot.position.y <= minY + 0.25 && collective < ROTOR_IDLE * 1.05) {
        heliRoot.position.y = minY;
        if (velocity.y < 0) velocity.y = 0;
        velocity.x *= 0.92;
        velocity.z *= 0.92;
    }
}

function resolveHelicopterWorldCollisionLegacy(nextPos) {
    var meshes = deps && deps.getCityCollisionMeshes ? deps.getCityCollisionMeshes() : null;
    if (!meshes || !meshes.length || !heliRoot) return;
    _moveDir.subVectors(nextPos, heliRoot.position);
    var moveLen = _moveDir.length();
    if (moveLen < 1e-5) return;
    _moveDir.multiplyScalar(1 / moveLen);
    var probeYs = [0.6, 1.15, 2.0, 3.2];
    for (var pi = 0; pi < probeYs.length; pi++) {
        _v2.set(heliRoot.position.x, heliRoot.position.y + probeYs[pi], heliRoot.position.z);
        _raycaster.set(_v2, _moveDir);
        _raycaster.far = moveLen + HELI_BODY_RADIUS;
        var hits = _raycaster.intersectObjects(meshes, false);
        for (var i = 0; i < hits.length; i++) {
            var hit = hits[i];
            if (!hit.face) continue;
            _hitNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
            if (_hitNormal.y > 0.55) continue;
            nextPos.copy(hit.point).addScaledVector(_hitNormal, HELI_BODY_RADIUS);
            velocity.reflect(_hitNormal);
            velocity.multiplyScalar(0.3);
            return;
        }
    }
}

function resolveHelicopterWorldCollision(nextPos) {
    var meshes = deps && deps.getCityCollisionMeshes ? deps.getCityCollisionMeshes() : null;
    if (!meshes || !meshes.length || !heliRoot) return;
    if (!heliColliders.length) {
        resolveHelicopterWorldCollisionLegacy(nextPos);
        return;
    }

    _moveDir.subVectors(nextPos, heliRoot.position);
    var moveLen = _moveDir.length();
    if (moveLen < 1e-5) return;
    _moveDir.normalize();

    var rootQuat = heliRoot.quaternion;
    var prevPos = heliRoot.position;
    var bestHitDist = Infinity;
    var bestNormal = null;
    var bestMargin = HELI_COLLIDER_MARGIN;

    for (var ci = 0; ci < heliColliders.length; ci++) {
        var col = heliColliders[ci];
        getColliderWorldSupport(col, prevPos, rootQuat, _moveDir, _colliderSupportW);
        _raycaster.set(_colliderSupportW, _moveDir);
        var pad = col.type === 'box'
            ? Math.max(col.halfExtents.x, col.halfExtents.y, col.halfExtents.z)
            : col.radius + col.thickness;
        _raycaster.far = moveLen + (col.margin || HELI_COLLIDER_MARGIN) + pad * 0.15;
        var hits = _raycaster.intersectObjects(meshes, false);
        for (var hi = 0; hi < hits.length; hi++) {
            var hit = hits[hi];
            if (!hit.face) continue;
            _hitNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
            if (_hitNormal.y > 0.55) continue;
            if (hit.distance < bestHitDist) {
                bestHitDist = hit.distance;
                bestNormal = _hitNormal.clone();
                bestMargin = col.margin || HELI_COLLIDER_MARGIN;
            }
        }
    }

    if (bestHitDist === Infinity || bestHitDist > moveLen + bestMargin) return;

    var travel = Math.max(0, bestHitDist - bestMargin);
    nextPos.copy(prevPos).addScaledVector(_moveDir, travel);
    if (bestNormal) {
        nextPos.addScaledVector(bestNormal, bestMargin * 0.35);
        velocity.reflect(bestNormal);
        velocity.multiplyScalar(0.3);
    }
}

function attachCameraToHelicopter() {
    if (!deps || !deps.cameraRig || !heliRoot) return;
    if (deps.detachCameraRigForFly) deps.detachCameraRigForFly();
    if (deps.cameraRig.parent !== heliRoot) {
        if (deps.cameraRig.parent) deps.cameraRig.parent.remove(deps.cameraRig);
        heliRoot.add(deps.cameraRig);
    }
    deps.cameraRig.position.copy(COCKPIT_CAMERA_LOCAL);
    deps.cameraRig.rotation.set(0, COCKPIT_CAMERA_YAW, 0);
    if (deps.camera) {
        deps.camera.position.set(0, 0, 0);
        deps.camera.rotation.set(0, 0, 0);
    }
    if (deps.resetFootViewOffset) deps.resetFootViewOffset();
}

function getDefaultHeliSlot() {
    if (deps && deps.getMyPlayerSlotIndex) return deps.getMyPlayerSlotIndex();
    return 0;
}

function getOccupiedHeliSlot() {
    return occupiedHeliSlot != null ? occupiedHeliSlot : getDefaultHeliSlot();
}

function releaseHeliOccupancy() {
    if (occupiedHeliSlot == null) return;
    if (deps && deps.releaseOccupancyClaim) {
        deps.releaseOccupancyClaim('heli', occupiedHeliSlot);
    }
    occupiedHeliSlot = null;
}

function restoreHeliHomeSlotIfNeeded() {
    if (occupiedHeliSlot == null) return;
    var home = getDefaultHeliSlot();
    if (occupiedHeliSlot !== home && deps && deps.repositionLocalHelicopterForSlot) {
        deps.repositionLocalHelicopterForSlot(home);
    }
}

function resetHelicopterCombatHp() {
    heliCombatHp = HELI_COMBAT_MAX_HP;
}

function getChaseWorldPos(out, quatOut) {
    if (!heliRoot) return false;
    heliRoot.updateMatrixWorld(true);
    heliRoot.getWorldPosition(out);
    if (quatOut) heliRoot.getWorldQuaternion(quatOut);
    return true;
}

function getTravelForward(out) {
    if (!heliRoot) {
        out.set(0, 0, 1);
        return out;
    }
    heliRoot.updateMatrixWorld(true);
    out.set(0, 0, 1).applyQuaternion(heliRoot.quaternion);
    out.y = 0;
    if (velocity && (velocity.x * velocity.x + velocity.z * velocity.z) > 4) {
        out.set(velocity.x, 0, velocity.z).normalize();
        return out;
    }
    if (out.lengthSq() < 1e-8) out.set(0, 0, 1);
    else out.normalize();
    return out;
}

function raycastHelicopterCombatSegment(origin, dirUnit, segLen) {
    if (!heliMesh || isHelicopterMode()) return null;
    _raycaster.firstHitOnly = true;
    _raycaster.near = 0.08;
    _raycaster.far = segLen;
    _raycaster.set(origin, dirUnit);
    var hits = _raycaster.intersectObject(heliMesh, true);
    for (var hi = 0; hi < hits.length; hi++) {
        var hit = hits[hi];
        if (!hit.face || isHeliObject(hit.object)) continue;
        return { t: hit.distance, point: hit.point };
    }
    return null;
}

function destroyHelicopterFromCombat(hitPoint) {
    if (!isHelicopterMode()) return;
    stopMinigunBurst();
    var fx = hitPoint;
    if (!fx && heliRoot) {
        heliRoot.getWorldPosition(_v0);
        fx = _v0;
    }
    if (deps && deps.spawnExplosionAt && fx) {
        deps.spawnExplosionAt(fx);
    }
    exitHelicopter();
    heliCombatHp = HELI_COMBAT_MAX_HP;
}

function wreckParkedHelicopter(hitPoint) {
    if (deps && deps.spawnExplosionAt && hitPoint) {
        deps.spawnExplosionAt(hitPoint);
    }
    heliAutonomousFlight = true;
    stopMinigunBurst();
    console.log('🚁 Parked helicopter destroyed');
    resetHelicopterCombatHp();
}

function applyHelicopterCombatDamage(amount, hitPoint, instantKill) {
    if (!heliMesh) return false;
    if (instantKill) {
        if (isHelicopterMode()) destroyHelicopterFromCombat(hitPoint);
        else wreckParkedHelicopter(hitPoint);
        return true;
    }
    heliCombatHp = Math.max(0, heliCombatHp - amount);
    if (heliCombatHp <= 0) {
        if (isHelicopterMode()) destroyHelicopterFromCombat(hitPoint);
        else wreckParkedHelicopter(hitPoint);
        return true;
    }
    return false;
}

function enterHelicopterAtSlot(slot) {
    if (!deps || !isFootModeForHeli() || !heliRoot || isHelicopterMode()) return false;
    var targetSlot = slot != null ? slot : getDefaultHeliSlot();
    resetHelicopterCombatHp();
    occupiedHeliSlot = targetSlot;
    if (targetSlot !== getDefaultHeliSlot() && deps.repositionHelicopterToOccupiedSlot) {
        deps.repositionHelicopterToOccupiedSlot(targetSlot);
    }
    heliAutonomousFlight = false;
    setBowEquipped(false);
    if (deps.ensureFootLocomotionReady) deps.ensureFootLocomotionReady();
    else if (deps.ensureFootLocomotion) deps.ensureFootLocomotion();
    mode = MODE_HELICOPTER;
    if (window.__chasevrPlayerFoot && window.__chasevrPlayerFoot.updateDoorVisibility) {
        window.__chasevrPlayerFoot.updateDoorVisibility();
    }
    if (deps.startAudio) deps.startAudio();
    velocity.set(0, 0, 0);
    rotorSpin = 0;
    collective = 0;
    heliRoot.rotation.x = 0;
    heliRoot.rotation.z = 0;
    angVelPitch = 0;
    angVelRoll = 0;
    resetCyclicVisual();
    releaseAllVRCyclicGrabs();
    updateDoorVisibility();
    attachCameraToHelicopter();
    clampHelicopterToGround(true);
    ensureRotorAudioLoop();
    updateRotorAudioVolume();
    if (deps.setCameraModeFirstPerson) deps.setCameraModeFirstPerson();
    console.log('🚁 Entered helicopter (slot', targetSlot + ')');
    return true;
}

function enterHelicopter() {
    return enterHelicopterAtSlot(getDefaultHeliSlot());
}

function forceExitHelicopter() {
    if (!isHelicopterMode()) return false;
    return exitHelicopter();
}

function tryEnterHeliAtNearestDoor(worldPos) {
    var target = null;
    if (deps && deps.findNearestHeliDoorTarget) {
        target = deps.findNearestHeliDoorTarget(worldPos);
    }
    var slot = target ? target.slot : getDefaultHeliSlot();
    var dist = target ? target.distance : distanceToDoor(worldPos);
    if (dist > DOOR_GRAB_RADIUS) return false;
    lastDoorIndex = getNearestDoorIndex(worldPos);

    if (deps && deps.requestOccupancyClaim) {
        deps.requestOccupancyClaim('heli', slot, function(granted) {
            if (granted) enterHelicopterAtSlot(slot);
        });
        return true;
    }
    return enterHelicopterAtSlot(slot);
}

function exitHelicopter() {
    if (!deps || mode !== MODE_HELICOPTER) return false;
    releaseAllVRCyclicGrabs();
    stopMinigunBurst();
    var exit = computeExitSpawn();
    if (!exit) return false;
    if (deps.detachCameraRigForFly) deps.detachCameraRigForFly();
    if (deps.ensureFootLocomotionReady) deps.ensureFootLocomotionReady();
    else if (deps.ensureFootLocomotion) deps.ensureFootLocomotion();
    if (deps.resetFootAt) {
        deps.resetFootAt(exit.position, exit.yaw, exit.inheritVelocity);
    }
    mode = null;
    releaseHeliOccupancy();
    restoreHeliHomeSlotIfNeeded();
    updateDoorVisibility();
    if (window.__chasevrPlayerFoot && window.__chasevrPlayerFoot.updateDoorVisibility) {
        window.__chasevrPlayerFoot.updateDoorVisibility();
    }

    if (exit.airborne) {
        heliAutonomousFlight = true;
        updateRotorAudioVolume();
        console.log('🚁 Bailed out — falling; helicopter descending');
        return true;
    }

    heliAutonomousFlight = false;
    rotorSpin = 0;
    collective = 0;
    angVelPitch = 0;
    angVelRoll = 0;
    velocity.set(0, 0, 0);
    if (heliRoot) {
        heliRoot.rotation.x = 0;
        heliRoot.rotation.z = 0;
    }
    resetCyclicVisual();
    releaseAllVRCyclicGrabs();
    if (rotorAction) rotorAction.timeScale = 0;
    stopRotorAudioLoop();
    console.log('🚁 Exited helicopter');
    return true;
}

function exitGrabRadius() {
    if (deps && deps.isVRPresenting && deps.isVRPresenting()) {
        return DOOR_EXIT_GRAB_RADIUS;
    }
    return 1.05;
}

function tryDoorInteract(worldPos, pressed) {
    if (!heliRoot) return false;
    if (!pressed || !deps) {
        doorInteractLatch = false;
        return false;
    }
    if (doorInteractLatch) return false;

    if (isHelicopterMode()) {
        if (distanceToDoor(worldPos) > exitGrabRadius()) return false;
        lastDoorIndex = getNearestDoorIndex(worldPos);
        doorInteractLatch = true;
        return exitHelicopter();
    }

    if (isFootModeForHeli()) {
        var enteredHeli = tryEnterHeliAtNearestDoor(worldPos);
        if (enteredHeli) doorInteractLatch = true;
        return enteredHeli;
    }
    return false;
}

function updateVRProximityTriggers(session) {
    if (!deps || !deps.controllerGrips || !session || !heliRoot) return;
    for (var ci = 0; ci < 2; ci++) {
        var grip = deps.controllerGrips[ci];
        if (!grip) continue;
        getHandWorldPosition(grip, _v0);
        var handedness = getGripHandedness(grip, ci);
        var nearDoor = distanceToDoor(_v0) <= DOOR_PROXIMITY_RADIUS;
        if (nearDoor && !doorHotspotInside[ci]) {
            playTriggerSonar(0.75);
            pulseHand(handedness, 0.3, 40);
        }
        doorHotspotInside[ci] = nearDoor;
    }
}

function handleVRDoorInteract(session) {
    if (!session || !heliRoot) return;
    if (isHelicopterMode() && isVRCyclicGrabActive()) return;
    var anyGripping = false;
    for (var ci = 0; ci < 2; ci++) {
        var grip = deps.controllerGrips[ci];
        if (!grip) continue;
        var handedness = getGripHandedness(grip, ci);
        if (isGripPressedForHand(session, handedness)) anyGripping = true;
    }
    if (!anyGripping) {
        tryDoorInteract(_v0, false);
        return;
    }
    for (ci = 0; ci < 2; ci++) {
        grip = deps.controllerGrips[ci];
        if (!grip) continue;
        handedness = getGripHandedness(grip, ci);
        var gripping = isGripPressedForHand(session, handedness);
        if (!gripping) continue;
        getHandWorldPosition(grip, _v0);
        if (isHelicopterMode()) {
            if (distanceGripToCyclic(ci) <= CYCLIC_GRAB_RADIUS) continue;
            if (distanceToDoor(_v0) > exitGrabRadius()) continue;
        } else {
            var heliTarget = deps && deps.findNearestHeliDoorTarget
                ? deps.findNearestHeliDoorTarget(_v0)
                : null;
            var heliDoorDist = heliTarget ? heliTarget.distance : distanceToDoor(_v0);
            if (heliDoorDist > DOOR_GRAB_RADIUS) continue;
        }
        if (!isFootModeForHeli() && !isHelicopterMode()) continue;
        if (tryDoorInteract(_v0, true)) break;
    }
}

function applyHelicopterMotion(dt, input, manned) {
    if (!heliRoot) return;

    if (manned && input) {
        if (input.rt > 0.08) {
            rotorSpin = Math.min(1, rotorSpin + ROTOR_SPOOL_UP * input.rt * dt);
            collective = Math.min(1, collective + ROTOR_SPOOL_UP * input.rt * dt);
        } else if (input.lt > 0.08) {
            collective = Math.max(0, collective - ROTOR_SPOOL_DOWN * input.lt * dt);
        }
    } else if (heliAutonomousFlight) {
        collective = Math.max(0, collective - ROTOR_SPOOL_DOWN * 0.4 * dt);
        heliRoot.rotation.x *= Math.exp(-AUTO_LEVEL_RATE * dt);
        heliRoot.rotation.z *= Math.exp(-AUTO_LEVEL_RATE * dt);
        angVelPitch *= Math.exp(-2.5 * dt);
        angVelRoll *= Math.exp(-2.5 * dt);
    }

    var controlAuth = collective > ROTOR_IDLE ? 1 : Math.max(0, collective / ROTOR_IDLE);

    if (manned && input) {
        heliRoot.rotation.order = 'YXZ';
        heliRoot.rotation.y += input.yaw * YAW_RATE * controlAuth * dt;
        updateHelicopterTilt(dt, input.pitch, input.roll, controlAuth);
        var cyclicBlend = 1 - Math.exp(-CYCLIC_VIS_SMOOTH * dt);
        cyclicVisPitch += (input.pitch - cyclicVisPitch) * cyclicBlend;
        cyclicVisRoll += (input.roll - cyclicVisRoll) * cyclicBlend;
        updateCyclicVisual(cyclicVisPitch, cyclicVisRoll);
    }

    _up.set(0, 1, 0).applyQuaternion(heliRoot.quaternion);
    var lift = collective > ROTOR_IDLE ? (collective - ROTOR_IDLE) * MAX_LIFT_ACCEL : 0;
    velocity.addScaledVector(_up, lift * dt);
    velocity.y -= GRAVITY * dt;

    var drag = Math.exp(-DRAG * dt);
    velocity.multiplyScalar(drag);

    _nextPos.copy(heliRoot.position).addScaledVector(velocity, dt);
    resolveHelicopterWorldCollision(_nextPos);
    heliRoot.position.copy(_nextPos);
    clampHelicopterToGround(false);

    if (rotorMixer) {
        rotorMixer.update(dt);
    }
    if (rotorAction) {
        rotorAction.timeScale = Math.max(0.05, rotorSpin * ROTOR_ANIM_BASE_SPEED * 2.5);
    }
    updateRotorAudioVolume();

    if (heliAutonomousFlight && getAltitudeM() < 0.35 && collective < ROTOR_IDLE * 0.5
        && velocity.lengthSq() < 2.5) {
        heliAutonomousFlight = false;
        rotorSpin = Math.max(0, rotorSpin - dt * 0.15);
        if (rotorSpin < 0.08) {
            rotorSpin = 0;
            if (rotorAction) rotorAction.timeScale = 0;
        }
    }
}

function updateFlight(dt, session) {
    if (!isHelicopterMode() || !heliRoot) return;
    var cyclicGrab = updateVRCyclicGrab(session);
    var input = readVRFlightInput(session);
    if (cyclicGrab.hasGrab) {
        input.pitch = cyclicGrab.pitch;
        input.roll = cyclicGrab.roll;
    }
    updateMiniguns(dt, session);
    tickWorldSurfaceImpactFx(dt);
    applyHelicopterMotion(dt, input, true);
}

function updateAutonomousFlight(dt) {
    if (!heliAutonomousFlight || !heliRoot || isHelicopterMode()) return;
    applyHelicopterMotion(dt, null, false);
}

function registerHelicopter(rootGroup, gltf) {
    heliRoot = rootGroup;
    heliMesh = rootGroup.children[0] || null;
    heliRoot.rotation.order = 'YXZ';
    // Door locals are in meters on the unscaled root (model child carries scale).
    setupDoorHandles(heliRoot);
    setupMinigunDebugMarkers(heliRoot);

    if (gltf && gltf.animations && gltf.animations.length && heliMesh) {
        rotorMixer = new THREE.AnimationMixer(heliMesh);
        var clip = gltf.animations.find(function(a) {
            return a.name && a.name.indexOf('Rotor') >= 0;
        }) || gltf.animations[0];
        rotorAction = rotorMixer.clipAction(clip);
        rotorAction.setLoop(THREE.LoopRepeat);
        rotorAction.play();
        rotorAction.timeScale = 0;
    }
    ensureRotorAudioLoop();
    ensureMetalHitBuffers();
    ensureAudioBuffer(MINIGUN_SFX_URL, _minigunBuf, _minigunLoad);
    bindCyclicNode();
    updateDoorVisibility();
    buildHeliCollisionVolumes(heliRoot, heliMesh);
    console.log('🚁 Helicopter registered (doors + rotor + cyclic rig + colliders)');
}

function computeHeliNoseDirFromRoot(root, heliMeshNode, out) {
    out.set(0, 0, -1);
    if (!root || !heliMeshNode) return out;
    var tail = null;
    var noseRef = null;
    heliMeshNode.traverse(function(child) {
        if (child.name === 'Tail_Rotor') tail = child;
        if (child.name === 'Cockpit' && !noseRef) noseRef = child;
    });
    if (!tail || !noseRef) return out;
    root.updateMatrixWorld(true);
    tail.getWorldPosition(_v0);
    noseRef.getWorldPosition(_v1);
    root.worldToLocal(_v0);
    root.worldToLocal(_v1);
    out.subVectors(_v1, _v0);
    out.y = 0;
    if (out.lengthSq() < 1e-8) return out.set(0, 0, -1);
    return out.normalize();
}

function getMinigunRayFromRoot(root, heliMeshNode, mountIndex, outOrigin, outDir) {
    if (!root) {
        outOrigin.set(0, 0, 0);
        outDir.set(0, 0, -1);
        return;
    }
    var local = HELICOPTER_MINIGUN_LOCALS[mountIndex];
    if (local) {
        outOrigin.copy(local);
        root.localToWorld(outOrigin);
        computeHeliNoseDirFromRoot(root, heliMeshNode, outDir);
        outDir.transformDirection(root.matrixWorld).normalize();
    } else {
        outOrigin.set(0, 0, 0);
        outDir.set(0, 0, -1);
        return;
    }
    _muzzleRight.crossVectors(_worldUp, outDir);
    if (_muzzleRight.lengthSq() < 1e-8) _muzzleRight.set(1, 0, 0);
    else _muzzleRight.normalize();
    var spread = MINIGUN_SPREAD;
    outDir.addScaledVector(_muzzleRight, (Math.random() - 0.5) * spread * 2);
    outDir.addScaledVector(_worldUp, (Math.random() - 0.5) * spread * 2);
    outDir.normalize();
    outOrigin.addScaledVector(outDir, MINIGUN_CONE_HEIGHT * 0.5);
}

function getNetworkState() {
    if (!heliRoot || !isHelicopterMode()) return null;
    return {
        mode: MODE_HELICOPTER,
        slot: getOccupiedHeliSlot(),
        x: heliRoot.position.x,
        y: heliRoot.position.y,
        z: heliRoot.position.z,
        rx: heliRoot.rotation.x,
        ry: heliRoot.rotation.y,
        rz: heliRoot.rotation.z,
        rs: rotorSpin,
        mg: minigunActive ? 1 : 0,
        mgf: isMinigunInFireWindow() ? 1 : 0,
        mgt: minigunCycleElapsed
    };
}

function setupRemoteHelicopterRotor(heliMeshNode, gltf, remoteData) {
    if (!gltf || !gltf.animations || !gltf.animations.length || !heliMeshNode) return;
    remoteData.mixer = new THREE.AnimationMixer(heliMeshNode);
    var clip = gltf.animations.find(function(a) {
        return a.name && a.name.indexOf('Rotor') >= 0;
    }) || gltf.animations[0];
    remoteData.rotorAction = remoteData.mixer.clipAction(clip);
    remoteData.rotorAction.setLoop(THREE.LoopRepeat);
    remoteData.rotorAction.play();
    remoteData.rotorAction.timeScale = 0;
}

function registerRemoteHelicopter(remoteData, rootGroup, gltf) {
    remoteData.root = rootGroup;
    remoteData.mesh = rootGroup.children[0] || null;
    rootGroup.rotation.order = 'YXZ';
    remoteData.shotAcc = [0, 0];
    remoteData.remoteMinigunAudio = null;
    setupRemoteHelicopterRotor(remoteData.mesh, gltf, remoteData);
}

function hideRemoteHelicopter(remoteData) {
    if (!remoteData || !remoteData.root) return;
    remoteData.root.visible = false;
    remoteData.shotAcc[0] = 0;
    remoteData.shotAcc[1] = 0;
    if (remoteData.playerId) stopRemoteMinigunSim(remoteData.playerId);
    if (remoteData.remoteMinigunAudio) {
        disconnectMinigunAudioSlot(remoteData.remoteMinigunAudio.audioSlot);
        remoteData.remoteMinigunAudio = null;
    }
}

function startMinigunAudioAtWorld(pos, targetHolder) {
    var ctx = getTriggerAudioContext();
    if (!ctx) return;
    resumeAudioContext();
    ensureAudioBuffer(MINIGUN_SFX_URL, _minigunBuf, _minigunLoad).then(function(buf) {
        if (!buf || !ctx) return;
        _v0.copy(pos);
        var slot = {
            src: ctx.createBufferSource(),
            gain: ctx.createGain(),
            panner: null
        };
        slot.src.buffer = buf;
        slot.gain.gain.value = 0.34;
        slot.src.connect(slot.gain);
        var spatial = deps && deps.getSpatialAudio ? deps.getSpatialAudio() : null;
        if (spatial) {
            slot.panner = spatial.createPanner({
                refDistance: 1.2,
                maxDistance: 160,
                rolloffFactor: 1.15
            });
            spatial.setPannerPosition(slot.panner, _v0.x, _v0.y, _v0.z);
            slot.gain.connect(slot.panner);
        } else if (typeof window !== 'undefined' && window.sfxMasterGain) {
            slot.gain.connect(window.sfxMasterGain);
        } else {
            slot.gain.connect(ctx.destination);
        }
        slot.src.start(0);
        if (targetHolder) {
            disconnectMinigunAudioSlot(targetHolder.audioSlot);
            targetHolder.audioSlot = slot;
        }
    });
}

function ensureRemoteMinigunAudio(remoteData) {
    if (!remoteData || !remoteData.root) return;
    if (!remoteData.remoteMinigunAudio) {
        remoteData.remoteMinigunAudio = { audioSlot: null };
    }
    if (remoteData.remoteMinigunAudio.audioSlot) return;
    remoteData.root.getWorldPosition(_v0);
    startMinigunAudioAtWorld(_v0, remoteData.remoteMinigunAudio);
}

function playNetworkMinigunShots(shots) {
    if (!shots || !shots.length) return;
    for (var i = 0; i < shots.length; i++) {
        var s = shots[i];
        _v0.set(s.ox, s.oy, s.oz);
        _v1.set(s.dx, s.dy, s.dz);
        spawnMinigunTracer(_v0, _v1, s.hd != null ? s.hd : null);
    }
}

function getRemoteMinigunSim(playerId) {
    if (!playerId) return null;
    var sim = remoteMinigunSimByPlayer.get(playerId);
    if (!sim) {
        sim = { cycleT: 0, active: false, audioSlot: null };
        remoteMinigunSimByPlayer.set(playerId, sim);
    }
    return sim;
}

function stopRemoteMinigunSim(playerId) {
    var sim = remoteMinigunSimByPlayer.get(playerId);
    if (!sim) return;
    sim.active = false;
    sim.cycleT = 0;
    disconnectMinigunAudioSlot(sim.audioSlot);
    sim.audioSlot = null;
}

function onRemoteMinigunBurstStart(playerId, payload) {
    var sim = getRemoteMinigunSim(playerId);
    sim.active = true;
    sim.cycleT = 0;
    if (payload && payload.x != null) {
        _v0.set(payload.x, payload.y, payload.z);
    }
    startMinigunAudioAtWorld(_v0, sim);
}

function onRemoteMinigunBurstStop(playerId) {
    stopRemoteMinigunSim(playerId);
}

function handleRemoteMinigunCombatEvent(event, payload, fromPlayerId) {
    if (!fromPlayerId || !event) return;
    if (event === 'minigun-burst-start') {
        onRemoteMinigunBurstStart(fromPlayerId, payload);
    } else if (event === 'minigun-burst-stop') {
        onRemoteMinigunBurstStop(fromPlayerId);
    } else if (event === 'minigun-shots' && payload && payload.shots) {
        playNetworkMinigunShots(payload.shots);
    }
}

function updateRemoteHelicopter(remoteData, state, dt) {
    if (!remoteData || !remoteData.root || !state) return;
    remoteData.root.visible = true;
    _v0.set(state.x, state.y, state.z);
    var lerp = Math.min(1, dt * 14);
    remoteData.root.position.lerp(_v0, lerp);
    remoteData.root.rotation.set(state.rx || 0, state.ry || 0, state.rz || 0);

    var rs = state.rs != null ? state.rs : 0.35;
    if (remoteData.mixer) remoteData.mixer.update(dt);
    if (remoteData.rotorAction) {
        remoteData.rotorAction.timeScale = Math.max(0.05, rs * ROTOR_ANIM_BASE_SPEED * 2.5);
    }

    var playerId = remoteData.playerId;
    var sim = playerId ? getRemoteMinigunSim(playerId) : null;
    if (sim) {
        if (state.mg) {
            if (!sim.active) {
                sim.active = true;
                sim.cycleT = state.mgt != null ? state.mgt : 0;
                remoteData.root.getWorldPosition(_v0);
                startMinigunAudioAtWorld(_v0, sim);
            } else if (state.mgt != null) {
                var snap = state.mgt;
                if (Math.abs(snap - sim.cycleT) > 0.45) sim.cycleT = snap;
            }
            sim.cycleT += dt;
            while (sim.cycleT >= MINIGUN_CYCLE_SEC) {
                sim.cycleT -= MINIGUN_CYCLE_SEC;
                remoteData.root.getWorldPosition(_v0);
                startMinigunAudioAtWorld(_v0, sim);
            }
        } else {
            stopRemoteMinigunSim(playerId);
        }
    }

    var cycleT = sim && sim.active ? sim.cycleT : (state.mgt != null ? state.mgt : 0);
    var firing = !!(state.mg && (
        state.mgf
        || (cycleT >= MINIGUN_SPOOL_SEC && cycleT < MINIGUN_SPOOL_SEC + MINIGUN_FIRE_SEC)
    ));
    if (firing) {
        ensureRemoteMinigunAudio(remoteData);
        var audioSlot = remoteData.remoteMinigunAudio
            && remoteData.remoteMinigunAudio.audioSlot;
        if (audioSlot && audioSlot.panner) {
            remoteData.root.getWorldPosition(_v0);
            var spatial = deps && deps.getSpatialAudio ? deps.getSpatialAudio() : null;
            if (spatial) spatial.setPannerPosition(audioSlot.panner, _v0.x, _v0.y, _v0.z);
        }
        if (sim && sim.audioSlot && sim.audioSlot.panner) {
            remoteData.root.getWorldPosition(_v0);
            var spatialSim = deps && deps.getSpatialAudio ? deps.getSpatialAudio() : null;
            if (spatialSim) spatialSim.setPannerPosition(sim.audioSlot.panner, _v0.x, _v0.y, _v0.z);
        }
        for (var gi = 0; gi < 2; gi++) {
            remoteData.shotAcc[gi] += dt * MINIGUN_ROF;
            while (remoteData.shotAcc[gi] >= 1) {
                remoteData.shotAcc[gi] -= 1;
                getMinigunRayFromRoot(remoteData.root, remoteData.mesh, gi, _v0, _v1);
                spawnMinigunTracer(_v0, _v1, null);
            }
        }
    } else if (remoteData.remoteMinigunAudio) {
        disconnectMinigunAudioSlot(remoteData.remoteMinigunAudio.audioSlot);
        remoteData.remoteMinigunAudio = null;
        remoteData.shotAcc[0] = 0;
        remoteData.shotAcc[1] = 0;
    }
}

function recoverFromCityVoid() {
    if (!heliRoot) return false;
    var floorY = getHelicopterFloorY();
    if (floorY == null && deps && deps.getCityWalkableFloorY) {
        floorY = deps.getCityWalkableFloorY(
            heliRoot.position.x,
            heliRoot.position.z,
            heliRoot.position.y + 4
        );
    }
    if (floorY == null) return false;
    heliRoot.position.y = floorY + GROUND_CLEARANCE;
    velocity.set(0, 0, 0);
    angVelPitch = 0;
    angVelRoll = 0;
    clampHelicopterToGround(true);
    console.warn('🛟 Helicopter void recovery @', heliRoot.position.x.toFixed(1), heliRoot.position.y.toFixed(1), heliRoot.position.z.toFixed(1));
    return true;
}

function init(options) {
    deps = options;
    updateDoorVisibility();
}

export const PlayerHelicopter = {
    MODE_HELICOPTER,
    init,
    registerHelicopter,
    registerRemoteHelicopter,
    updateRemoteHelicopter,
    hideRemoteHelicopter,
    handleRemoteMinigunCombatEvent,
    getNetworkState,
    updateDoorVisibility,
    isHelicopterMode,
    tryDoorInteract,
    distanceToDoor,
    distanceToHeliRootDoors,
    forceExitHelicopter,
    getChaseWorldPos,
    getTravelForward,
    raycastCombatSegment: raycastHelicopterCombatSegment,
    applyCombatDamage: applyHelicopterCombatDamage,
    getOccupiedHeliSlot,
    updateVRProximityTriggers,
    handleVRDoorInteract,
    updateFlight,
    updateAutonomousFlight,
    isVRCyclicGrabActive,
    getVRCyclicGrabSlot,
    releaseVRCyclicGrab,
    releaseAllVRCyclicGrabs,
    isHelicopterAutonomous: function() { return heliAutonomousFlight; },
    getFlightHudText,
    getDisplayRpm,
    getAltitudeM,
    recoverFromCityVoid,
    setHeliColliderDebugVisible,
    DOOR_GRAB_RADIUS,
};
