/**
 * GTAVR — MD-500 helicopter: door enter/exit, rotor animation/audio, VR thumbstick flight.
 */

import * as THREE from 'three';
import { setBowEquipped, pulseControllerHaptic } from './vrrunner/bots.js';
import { RUNNER_STANDING_EYE_Y } from './vrrunner/runnerLevel.js';

const MODE_HELICOPTER = 'helicopter';

const DOOR_HOTSPOT_RADIUS = 0.09;
const DOOR_PROXIMITY_RADIUS = DOOR_HOTSPOT_RADIUS + 0.015;
const DOOR_GRAB_RADIUS = DOOR_HOTSPOT_RADIUS + 0.04;
const DOOR_EXIT_GRAB_RADIUS = DOOR_HOTSPOT_RADIUS + 0.22;
// After prepareHelicopterModel: +Z = nose (tail rotor is at −Z in the source GLTF).
const HELICOPTER_DOOR_LOCALS = [
    new THREE.Vector3(1.05, 1.45, 2.15),
    new THREE.Vector3(-1.05, 1.45, 2.15),
];
// Pilot-local offsets on heliRoot (+Z nose). +X = pilot's left (camera rig yaw π).
const COCKPIT_CAMERA_LOCAL = new THREE.Vector3(0.3, 0.85, 2.0);
const COCKPIT_CAMERA_YAW = Math.PI;
const HELICOPTER_EXIT_OFFSET = 0.95;
const AIRBORNE_EXIT_ALT_M = 2.5;
const AUTO_LEVEL_RATE = 1.1;
const GROUND_CLEARANCE = 0.04;
const HELI_BODY_RADIUS = 1.65;
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

let deps = null;
let mode = null;
let heliRoot = null;
let heliMesh = null;
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
let cyclicRestRotation = new THREE.Euler();
let cyclicRestPosition = new THREE.Vector3();
let velocity = new THREE.Vector3();
let heliAutonomousFlight = false;
let doorInteractLatch = false;
let lastDoorIndex = 0;
let rotorAudio = null;
let rotorGain = null;
let rotorAudioBuffer = null;
let rotorAudioLoadPromise = null;
let triggerAudioBuffer = null;
let triggerAudioLoadPromise = null;
const doorHotspotInside = [false, false];

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
    var foot = window.__gtavrPlayerFoot;
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

function ensureRotorAudioLoop() {
    var ctx = getTriggerAudioContext();
    if (!ctx || rotorAudio) return;
    ensureAudioBuffer(ROTOR_SFX_URL, _rotorBuf, _rotorLoad).then(function(buf) {
        if (!buf || !ctx || rotorAudio) return;
        rotorGain = ctx.createGain();
        rotorGain.gain.value = 0;
        rotorGain.connect(ctx.destination);
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
    rotorGain.gain.value = rpmNorm * rpmNorm * 0.55;
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
    if (!doorEnterMeshes.length) return;
    var foot = isFootModeForHeli();
    var heli = isHelicopterMode();
    for (var i = 0; i < doorEnterMeshes.length; i++) {
        doorEnterMeshes[i].visible = foot;
    }
    for (var j = 0; j < doorExitMeshes.length; j++) {
        doorExitMeshes[j].visible = heli;
    }
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

function distanceToDoor(worldPos) {
    var best = Infinity;
    for (var i = 0; i < HELICOPTER_DOOR_LOCALS.length; i++) {
        var p = worldDoorPointByIndex(_v1, i);
        if (!p) continue;
        var d = worldPos.distanceTo(p);
        if (d < best) best = d;
    }
    return best;
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
    var minY = null;
    var floorY = getHelicopterFloorY();
    if (floorY != null) minY = floorY + GROUND_CLEARANCE;

    var meshes = deps && deps.getCityCollisionMeshes ? deps.getCityCollisionMeshes() : null;
    if (meshes && meshes.length) {
        _v1.set(0, -1, 0);
        var probeHeights = [2.4, 1.2, 0.4];
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
                var gy = dh.point.y + GROUND_CLEARANCE;
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

function resolveHelicopterWorldCollision(nextPos) {
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

function enterHelicopter() {
    if (!deps || !isFootModeForHeli() || !heliRoot || isHelicopterMode()) return false;
    heliAutonomousFlight = false;
    setBowEquipped(false);
    if (deps.ensureFootLocomotionReady) deps.ensureFootLocomotionReady();
    else if (deps.ensureFootLocomotion) deps.ensureFootLocomotion();
    mode = MODE_HELICOPTER;
    if (window.__gtavrPlayerFoot && window.__gtavrPlayerFoot.updateDoorVisibility) {
        window.__gtavrPlayerFoot.updateDoorVisibility();
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
    updateDoorVisibility();
    attachCameraToHelicopter();
    clampHelicopterToGround(true);
    ensureRotorAudioLoop();
    updateRotorAudioVolume();
    if (deps.setCameraModeFirstPerson) deps.setCameraModeFirstPerson();
    console.log('🚁 Entered helicopter');
    return true;
}

function exitHelicopter() {
    if (!deps || mode !== MODE_HELICOPTER) return false;
    var exit = computeExitSpawn();
    if (!exit) return false;
    if (deps.detachCameraRigForFly) deps.detachCameraRigForFly();
    if (deps.ensureFootLocomotionReady) deps.ensureFootLocomotionReady();
    else if (deps.ensureFootLocomotion) deps.ensureFootLocomotion();
    if (deps.resetFootAt) {
        deps.resetFootAt(exit.position, exit.yaw, exit.inheritVelocity);
    }
    mode = null;
    updateRotorAudioVolume();
    updateDoorVisibility();
    if (window.__gtavrPlayerFoot && window.__gtavrPlayerFoot.updateDoorVisibility) {
        window.__gtavrPlayerFoot.updateDoorVisibility();
    }

    if (exit.airborne) {
        heliAutonomousFlight = true;
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
    if (rotorAction) rotorAction.timeScale = 0;
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

    if (distanceToDoor(worldPos) > DOOR_GRAB_RADIUS) return false;
    lastDoorIndex = getNearestDoorIndex(worldPos);
    doorInteractLatch = true;
    if (isFootModeForHeli()) return enterHelicopter();
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
        if (!isHelicopterMode() && distanceToDoor(_v0) > DOOR_GRAB_RADIUS) continue;
        if (isHelicopterMode() && distanceToDoor(_v0) > exitGrabRadius()) continue;
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
    applyHelicopterMotion(dt, readVRFlightInput(session), true);
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
    bindCyclicNode();
    console.log('🚁 Helicopter registered (doors + rotor + cyclic rig)');
}

function init(options) {
    deps = options;
    updateDoorVisibility();
}

export const PlayerHelicopter = {
    MODE_HELICOPTER,
    init,
    registerHelicopter,
    updateDoorVisibility,
    isHelicopterMode,
    tryDoorInteract,
    distanceToDoor,
    updateVRProximityTriggers,
    handleVRDoorInteract,
    updateFlight,
    updateAutonomousFlight,
    isHelicopterAutonomous: function() { return heliAutonomousFlight; },
    getFlightHudText,
    getDisplayRpm,
    getAltitudeM,
    DOOR_GRAB_RADIUS,
};
