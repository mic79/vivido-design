/**
 * GTAVR — VRrunner on-foot locomotion (grab/throw jump, slide, wingsuit, archery)
 * plus vehicle door enter/exit and multiplayer pose sync.
 */

import * as THREE from 'three';
import { createPlayerLocomotion } from '../../VRrunner/js/playerLocomotion.js';
import {
    registerSandboxGlbCollisionMeshes,
    setRunnerGlassSceneRef,
    RUNNER_STANDING_EYE_Y,
} from '../../VRrunner/js/runnerLevel.js';
import {
    initBots,
    updateBots,
    setBattleOnBEnabled,
    setEditorLocomotionActive,
    setBowHandToggleOnAEnabled,
    setBowEquipped,
    toggleBowOnHand,
    pulseControllerHaptic,
} from '../../VRrunner/js/bots.js';

const MODE_FOOT = 'foot';
const MODE_VEHICLE = 'vehicle';

const DOOR_HOTSPOT_RADIUS = 0.09;
/** SFX/haptics — matches visible sphere plus a few cm slack. */
const DOOR_PROXIMITY_RADIUS = DOOR_HOTSPOT_RADIUS + 0.015;
/** Grip interact — slightly larger than visual so enter/exit still feels reachable. */
const DOOR_GRAB_RADIUS = DOOR_HOTSPOT_RADIUS + 0.04;
const DOOR_LOCALS = [
    new THREE.Vector3(0.88, 0.82, -0.08),  // right side
    new THREE.Vector3(-0.88, 0.82, -0.08), // left side
];
const FOOT_EXIT_OFFSET = new THREE.Vector3(0.55, 0, 0.15);
const DESKTOP_STICK_DEADZONE = 0.08;

/** Behind-head holster in HMD camera space (+Z = behind the headset). */
const BACK_HOLSTER_CENTER = new THREE.Vector3(0, -0.06, 0.20);
const BACK_HOLSTER_HALF = new THREE.Vector3(0.16, 0.14, 0.12);
const TRIGGER_SFX_URL = new URL('../audio/submarine-sonar-38243-once.mp3', import.meta.url).href;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

let deps = null;
let mode = MODE_VEHICLE;
let doorGroup = null;
let doorEnterMeshes = [];
let doorExitMeshes = [];
let remoteAvatars = [];
let locomotion = null;
let botsReady = false;
let cityMeshesRegistered = false;
let doorInteractLatch = false;
let lastDoorIndex = 0;
let backHolsterGroup = null;
let triggerAudioBuffer = null;
let triggerAudioLoadPromise = null;
const backHolsterInside = [false, false];
const doorHotspotInside = [false, false];
const holsterGrabLatch = [false, false];

function makeDoorSphere(color, name) {
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(DOOR_HOTSPOT_RADIUS, 12, 12),
        new THREE.MeshStandardMaterial({
            color: color,
            emissive: color,
            emissiveIntensity: 0.35,
            transparent: true,
            opacity: 0.85
        })
    );
    mesh.name = name;
    mesh.userData.isDoorHotspot = true;
    return mesh;
}

function getChassis() {
    return deps && deps.getVehicleRef && deps.getVehicleRef().chassisMesh;
}

function worldDoorPointByIndex(out, index) {
    const chassis = getChassis();
    if (!chassis) return null;
    const i = Math.max(0, Math.min(DOOR_LOCALS.length - 1, index | 0));
    out.copy(DOOR_LOCALS[i]);
    chassis.localToWorld(out);
    return out;
}

function distanceToDoor(worldPos) {
    let best = Infinity;
    for (let i = 0; i < DOOR_LOCALS.length; i++) {
        const p = worldDoorPointByIndex(_v1, i);
        if (!p) continue;
        const d = worldPos.distanceTo(p);
        if (d < best) best = d;
    }
    return best;
}

function getTriggerAudioContext() {
    if (deps && deps.getAudioContext) return deps.getAudioContext();
    return null;
}

function ensureTriggerAudioBuffer() {
    if (triggerAudioBuffer) return Promise.resolve(triggerAudioBuffer);
    var ctx = getTriggerAudioContext();
    if (!ctx) return Promise.resolve(null);
    if (triggerAudioLoadPromise) return triggerAudioLoadPromise;
    triggerAudioLoadPromise = fetch(TRIGGER_SFX_URL)
        .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.arrayBuffer();
        })
        .then(function(ab) {
            var decodeCtx = getTriggerAudioContext();
            if (!decodeCtx) throw new Error('audio context unavailable');
            return new Promise(function(resolve, reject) {
                decodeCtx.decodeAudioData(ab, resolve, reject);
            });
        })
        .then(function(buf) {
            triggerAudioBuffer = buf;
            return buf;
        })
        .catch(function(err) {
            triggerAudioLoadPromise = null;
            console.warn('GTAVR trigger SFX failed to load:', TRIGGER_SFX_URL, err);
            return null;
        });
    return triggerAudioLoadPromise;
}

function playTriggerSonar(volumeScale) {
    var ctx = getTriggerAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended' && deps.startAudio) {
        deps.startAudio();
    }
    ensureTriggerAudioBuffer().then(function(buf) {
        if (!buf || !ctx) return;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(function() { /* ignore */ });
        }
        var src = ctx.createBufferSource();
        src.buffer = buf;
        var gain = ctx.createGain();
        gain.gain.value = 0.55 * (volumeScale == null ? 1 : volumeScale);
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(0);
    });
}

function getGripHandedness(grip, index) {
    var src = grip && grip.userData && grip.userData.xrInputSource;
    if (src && src.handedness) return src.handedness;
    return index === 0 ? 'left' : 'right';
}

/** World position of the visible VR hand mesh (falls back to grip origin). */
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

function ensureBackHolsterTrigger() {
    if (backHolsterGroup || !deps) return;
    var head = deps.camera || (deps.crouchViewGroup && deps.crouchViewGroup.children[0]);
    if (!head) return;
    backHolsterGroup = new THREE.Object3D();
    backHolsterGroup.name = 'BackBowHolster';
    backHolsterGroup.position.copy(BACK_HOLSTER_CENTER);
    head.add(backHolsterGroup);
}

function handInBackHolster(worldPos) {
    if (!backHolsterGroup || !worldPos) return false;
    backHolsterGroup.updateMatrixWorld(true);
    _v2.copy(worldPos);
    backHolsterGroup.worldToLocal(_v2);
    return Math.abs(_v2.x) <= BACK_HOLSTER_HALF.x
        && Math.abs(_v2.y) <= BACK_HOLSTER_HALF.y
        && Math.abs(_v2.z) <= BACK_HOLSTER_HALF.z;
}

function pulseHand(handedness, intensity, durationMs) {
    pulseControllerHaptic(handedness, intensity, durationMs);
}

function updateVRProximityTriggers(session) {
    if (!deps || !deps.controllerGrips || !session) return;
    ensureBackHolsterTrigger();

    for (var ci = 0; ci < 2; ci++) {
        var grip = deps.controllerGrips[ci];
        if (!grip) continue;
        getHandWorldPosition(grip, _v0);
        var handedness = getGripHandedness(grip, ci);

        if (isFootMode()) {
            var inHolster = handInBackHolster(_v0);
            if (inHolster && !backHolsterInside[ci]) {
                playTriggerSonar(1);
                pulseHand(handedness, 0.38, 48);
            }
            backHolsterInside[ci] = inHolster;

            var gripping = isGripPressedForHand(session, handedness);
            if (inHolster && gripping) {
                if (!holsterGrabLatch[ci]) {
                    holsterGrabLatch[ci] = true;
                    var equipped = toggleBowOnHand(handedness);
                    pulseHand(handedness, equipped ? 0.55 : 0.35, equipped ? 70 : 45);
                    playTriggerSonar(equipped ? 0.85 : 0.65);
                }
            } else {
                holsterGrabLatch[ci] = false;
            }
        } else {
            backHolsterInside[ci] = false;
            holsterGrabLatch[ci] = false;
        }

        var nearDoor = distanceToDoor(_v0) <= DOOR_PROXIMITY_RADIUS;
        if (nearDoor && !doorHotspotInside[ci]) {
            playTriggerSonar(0.75);
            pulseHand(handedness, 0.3, 40);
        }
        doorHotspotInside[ci] = nearDoor;
    }
}

function getNearestDoorIndex(worldPos) {
    if (!worldPos) return 0;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < DOOR_LOCALS.length; i++) {
        const p = worldDoorPointByIndex(_v1, i);
        if (!p) continue;
        const d = worldPos.distanceTo(p);
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    }
    return best;
}

function isFootMode() {
    return mode === MODE_FOOT;
}

function isVehicleMode() {
    return mode === MODE_VEHICLE;
}

function getMode() {
    return mode;
}

function ensureLocomotion() {
    if (locomotion || !deps) return locomotion;
    locomotion = createPlayerLocomotion({
        renderer: deps.renderer,
        camera: deps.camera,
        cameraRig: deps.cameraRig,
        crouchViewGroup: deps.crouchViewGroup,
        controllerGrip1: deps.controllerGrips && deps.controllerGrips[0],
        controllerGrip2: deps.controllerGrips && deps.controllerGrips[1],
        mapId: 1,
        getCollisionBoxes: function() { return []; },
        getFloorY: function(x, z, refY, slack) {
            if (!deps.getCityWalkableFloorY) return null;
            return deps.getCityWalkableFloorY(x, z, refY, slack);
        },
        syncHandSlotsFromGrips: function() {
            if (!deps.controllerGrips) return null;
            var left = null;
            var right = null;
            for (var i = 0; i < deps.controllerGrips.length; i++) {
                var g = deps.controllerGrips[i];
                if (!g) continue;
                var src = g.userData && g.userData.xrInputSource;
                var h = src && src.handedness;
                if (h === 'left') left = g;
                else if (h === 'right') right = g;
                else if (!left) left = g;
                else if (!right) right = g;
            }
            return { left: left, right: right };
        }
    });
    return locomotion;
}

function ensureBots() {
    if (botsReady || !deps || !locomotion) return;
    setRunnerGlassSceneRef(deps.scene);
    setEditorLocomotionActive(false);
    initBots({
        scene: deps.scene,
        camera: deps.camera,
        cameraRig: deps.cameraRig,
        renderer: deps.renderer,
        getCollisionBoxes: function() { return []; },
        getPlayerVelocity: function() { return locomotion.getRigVelocity(); },
        getPlayerSpawn: function() { return deps.cameraRig.position.clone(); },
        getPlayerPosition: function() { return deps.cameraRig.position; },
        respawnPlayer: function() {
            locomotion.resetRigAt(deps.cameraRig.position, deps.cameraRig.rotation.y - Math.PI);
        },
        canToggleArrowTypeOnX: function() {
            return mode === MODE_FOOT;
        }
    });
    setBattleOnBEnabled(true);
    setBowHandToggleOnAEnabled(false);
    setBowEquipped(false);
    botsReady = true;
}

function registerCityCollisionMeshes(meshes) {
    if (cityMeshesRegistered || !meshes || !meshes.length) return;
    registerSandboxGlbCollisionMeshes(meshes);
    cityMeshesRegistered = true;
    console.log('🚶 VRrunner BVH collision registered for on-foot mode:', meshes.length, 'meshes');
}

function setupDoorHandles(chassisMesh) {
    if (!chassisMesh || !deps || !deps.scene) return;
    if (doorGroup && doorGroup.parent) {
        doorGroup.parent.remove(doorGroup);
    }
    doorGroup = new THREE.Group();
    doorGroup.name = 'DoorHotspots';
    doorEnterMeshes = [];
    doorExitMeshes = [];
    for (let i = 0; i < DOOR_LOCALS.length; i++) {
        const sideName = i === 0 ? 'Right' : 'Left';
        const enter = makeDoorSphere(0x44ff88, 'DoorEnter' + sideName);
        const exit = makeDoorSphere(0xffaa44, 'DoorExit' + sideName);
        enter.position.copy(DOOR_LOCALS[i]);
        exit.position.copy(DOOR_LOCALS[i]);
        doorGroup.add(enter);
        doorGroup.add(exit);
        doorEnterMeshes.push(enter);
        doorExitMeshes.push(exit);
    }
    chassisMesh.add(doorGroup);
    updateDoorVisibility();
}

function isInHelicopter() {
    return !!(window.__gtavrPlayerHelicopter && window.__gtavrPlayerHelicopter.isHelicopterMode());
}

function updateDoorVisibility() {
    if (!doorEnterMeshes.length || !doorExitMeshes.length) return;
    for (let i = 0; i < doorEnterMeshes.length; i++) {
        doorEnterMeshes[i].visible = isFootMode() && !isInHelicopter();
    }
    for (let i = 0; i < doorExitMeshes.length; i++) {
        doorExitMeshes[i].visible = isVehicleMode();
    }
    const PH = window.__gtavrPlayerHelicopter;
    if (PH && PH.updateDoorVisibility) PH.updateDoorVisibility();
}

function parkPlayerVehicle() {
    if (deps.zeroVehicleVelocity) deps.zeroVehicleVelocity();
}

function computeExitSpawn() {
    const ref = deps.getVehicleRef && deps.getVehicleRef();
    const chassis = ref && ref.chassisMesh;
    if (!chassis) return null;

    const nearDoorIdx = (lastDoorIndex >= 0 && lastDoorIndex < DOOR_LOCALS.length)
        ? lastDoorIndex
        : getNearestDoorIndex(deps && deps.cameraRig ? deps.cameraRig.position : null);
    const doorLocal = DOOR_LOCALS[nearDoorIdx] || DOOR_LOCALS[0];
    const exitOffsetSign = doorLocal.x >= 0 ? 1 : -1;

    _v0.copy(doorLocal);
    chassis.localToWorld(_v0);
    const exitWorld = _v0;
    if (!exitWorld) return null;

    // Build a true outward direction from the selected door side.
    _v1.set(exitOffsetSign, 0, 0).applyQuaternion(chassis.quaternion).normalize();
    _v2.set(0, 0, 1).applyQuaternion(chassis.quaternion).normalize();
    _v1.addScaledVector(_v2, 0.18).normalize();
    _v1.y = 0;
    if (_v1.lengthSq() < 1e-6) _v1.set(exitOffsetSign, 0, 0);
    _v1.normalize();

    const spawn = exitWorld.clone().addScaledVector(_v1, 0.95);
    spawn.y += RUNNER_STANDING_EYE_Y;
    if (deps.getCityWalkableFloorY) {
        const floorY = deps.getCityWalkableFloorY(spawn.x, spawn.z, spawn.y);
        if (floorY !== null && floorY !== undefined) {
            spawn.y = floorY + RUNNER_STANDING_EYE_Y;
        }
    }
    return { position: spawn, yaw: Math.atan2(_v1.x, _v1.z) };
}

function enterVehicle() {
    if (!deps || mode !== MODE_FOOT) return false;
    const ref = deps.getVehicleRef && deps.getVehicleRef();
    if (!ref || !ref.chassisMesh) return false;
    setBowEquipped(false);
    mode = MODE_VEHICLE;
    updateDoorVisibility();
    if (deps.resetFootViewOffset) deps.resetFootViewOffset();
    if (deps.attachCameraRigToVehicle) deps.attachCameraRigToVehicle();
    if (deps.syncPlayerChassisFromPhysics) deps.syncPlayerChassisFromPhysics();
    if (deps.setCameraModeFirstPerson) deps.setCameraModeFirstPerson();
    console.log('🚪 Entered vehicle');
    return true;
}

function exitVehicle() {
    if (!deps || mode !== MODE_VEHICLE) return false;
    if (!deps.cameraRig) return false;

    parkPlayerVehicle();
    if (deps.releaseAllVRWheelGrabs) deps.releaseAllVRWheelGrabs();

    const exit = computeExitSpawn();
    if (!exit) return false;

    if (deps.detachCameraRigForFly) deps.detachCameraRigForFly();
    ensureLocomotion();
    ensureBots();
    locomotion.resetRigAt(exit.position, exit.yaw);

    mode = MODE_FOOT;
    updateDoorVisibility();
    console.log('🚪 Exited vehicle — VRrunner locomotion active');
    return true;
}

function tryDoorInteract(worldPos, pressed) {
    if (!pressed || !deps) {
        doorInteractLatch = false;
        return false;
    }
    if (doorInteractLatch) return false;
    if (distanceToDoor(worldPos) > DOOR_GRAB_RADIUS) return false;
    lastDoorIndex = getNearestDoorIndex(worldPos);
    doorInteractLatch = true;
    if (mode === MODE_FOOT) return enterVehicle();
    if (mode === MODE_VEHICLE) return exitVehicle();
    return false;
}

function applyDesktopStickFromKeys(keys) {
    if (!locomotion || !keys) return;
    var lx = 0;
    var ly = 0;
    var rx = 0;
    if (keys.left) lx -= 1;
    if (keys.right) lx += 1;
    if (keys.forward) ly += 1;
    if (keys.back) ly -= 1;
    locomotion.setStickInput({ x: lx, y: ly }, { x: rx, y: 0 });
}

function updateFootLocomotion(dt, input) {
    if (!deps || !deps.cameraRig || mode !== MODE_FOOT) return;
    ensureLocomotion();
    ensureBots();
    if (deps.getCityCollisionMeshes) {
        registerCityCollisionMeshes(deps.getCityCollisionMeshes());
    }

    updateBots(dt);

    var presenting = deps.renderer && deps.renderer.xr && deps.renderer.xr.isPresenting;
    if (presenting) {
        locomotion.updateFootFrame(dt * 1000);
    } else {
        input = input || {};
        applyDesktopStickFromKeys(input.keys);
        locomotion.updateFootDesktop(dt, deps.camera);
    }
}

function spawnOnFootBesideCar() {
    if (!deps || !deps.cameraRig) return;

    parkPlayerVehicle();
    const exit = computeExitSpawn();
    if (!exit) return;

    if (deps.detachCameraRigForFly) deps.detachCameraRigForFly();
    ensureLocomotion();
    ensureBots();
    locomotion.resetRigAt(exit.position, exit.yaw);
    mode = MODE_FOOT;
    updateDoorVisibility();
}

function startInVehicle() {
    mode = MODE_VEHICLE;
    updateDoorVisibility();
    if (deps.resetFootViewOffset) deps.resetFootViewOffset();
    if (deps.attachCameraRigToVehicle) deps.attachCameraRigToVehicle();
}

function getNetworkState() {
    if (!deps) return null;
    if (mode === MODE_VEHICLE) {
        const ref = deps.getVehicleRef && deps.getVehicleRef();
        if (!ref || !ref.chassisMesh) return null;
        const p = ref.chassisMesh.position;
        const r = ref.chassisMesh.rotation;
        return {
            mode: MODE_VEHICLE,
            x: p.x, y: p.y, z: p.z,
            rx: r.x, ry: r.y, rz: r.z
        };
    }
    const rig = deps.cameraRig;
    if (!rig) return null;
    return {
        mode: MODE_FOOT,
        x: rig.position.x, y: rig.position.y, z: rig.position.z,
        rx: rig.rotation.x, ry: rig.rotation.y, rz: rig.rotation.z
    };
}

function createRemoteAvatars(scene, colors) {
    remoteAvatars.length = 0;
    for (let i = 0; i < 4; i++) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.28, 0.85, 4, 8),
            new THREE.MeshStandardMaterial({ color: colors[i] || 0x88aacc })
        );
        body.position.y = 0.95;
        g.add(body);
        g.visible = false;
        scene.add(g);
        remoteAvatars.push({ mesh: g, playerId: null, mode: MODE_VEHICLE });
    }
}

function applyRemotePlayerState(playerIndex, playerId, state) {
    if (playerIndex < 0 || playerIndex >= remoteAvatars.length) return;
    const av = remoteAvatars[playerIndex];
    const carData = deps.getRemoteCarData && deps.getRemoteCarData(playerIndex);
    if (!state) return;

    const foot = state.mode === MODE_FOOT;
    av.mode = foot ? MODE_FOOT : MODE_VEHICLE;
    av.playerId = playerId;

    if (foot) {
        av.mesh.position.set(state.x, state.y - RUNNER_STANDING_EYE_Y + 0.95, state.z);
        av.mesh.rotation.set(state.rx || 0, state.ry || 0, state.rz || 0);
        av.mesh.visible = true;
        if (carData && carData.mesh) carData.mesh.visible = false;
    } else {
        av.mesh.visible = false;
        if (carData && carData.mesh && playerId !== deps.getMyPlayerId()) {
            carData.mesh.position.set(state.x, state.y, state.z);
            carData.mesh.rotation.set(state.rx || 0, state.ry || 0, state.rz || 0);
            carData.mesh.visible = true;
            if (carData.rigidBody && deps.updateRemoteCarPhysics) {
                deps.updateRemoteCarPhysics(carData, state);
            }
        }
    }
}

function resetFootAt(position, yaw, velocity) {
    ensureLocomotion();
    ensureBots();
    locomotion.resetRigAt(position, yaw);
    if (velocity && locomotion.setRigVelocity) {
        locomotion.setRigVelocity(velocity);
    }
    mode = MODE_FOOT;
    updateDoorVisibility();
}

function ensureFootLocomotionReady() {
    ensureLocomotion();
    ensureBots();
}

function init(options) {
    deps = options;
    if (options.scene && options.avatarColors) {
        createRemoteAvatars(options.scene, options.avatarColors);
    }
    if (options.scene) {
        setRunnerGlassSceneRef(options.scene);
    }
    if (options.getCityCollisionMeshes) {
        registerCityCollisionMeshes(options.getCityCollisionMeshes());
    }
}

export const PlayerFoot = {
    MODE_FOOT,
    MODE_VEHICLE,
    init,
    setupDoorHandles,
    updateDoorVisibility,
    isFootMode,
    isVehicleMode,
    getMode,
    enterVehicle,
    exitVehicle,
    tryDoorInteract,
    updateFootLocomotion,
    updateVRProximityTriggers,
    resetFootAt,
    ensureFootLocomotionReady,
    spawnOnFootBesideCar,
    startInVehicle,
    getNetworkState,
    applyRemotePlayerState,
    distanceToDoor,
    registerCityCollisionMeshes,
    DOOR_HOTSPOT_RADIUS,
    DOOR_PROXIMITY_RADIUS,
    DOOR_GRAB_RADIUS
};
