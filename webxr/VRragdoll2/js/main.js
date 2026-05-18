/**
 * VRragdoll — Rapier NPC ragdoll + VRrunner-style body IK & controller rig.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RagdollNPC } from './ragdoll-npc.js';
import { createBodyIkAvatar } from './bodyIkAvatar.js';
import {
  applyGamepadAxesToVRInput,
  getGripRefPosition,
  getPairedXRControllerGrips
} from './xr-input.js';
import { resolvePlayerBodyCollisions } from './player-body-collision.js';
import { GrabbablePropManager } from './grabbable-props.js';
import { buildRunnerCollisionBoxes, getRunnerCollisionBoxes } from './runner-collision-boxes.js';
import {
  initArcherySandbox,
  updateArcherySandbox,
  setArrowRagdollCallbacks,
  applyGrappleWinchStep,
  isArcheryDrawActive,
  isGrappleHookActive
} from '../../VRrunner/js/bots.js';
import {
  bindBulletTimeVignette,
  getBulletTimeScale,
  notifyArrowHitNpc,
  updateBulletTime
} from './bullet-time.js';

const CHARACTER_URL =
  'https://cdn.jsdelivr.net/gh/mattvb91/rapierjs-ragdoll@main/public/character.glb';

const STANDING_EYE_Y = 1.6;

/** Raised platform (player stays on ground at y=0). */
const PLATFORM_WIDTH = 5;
const PLATFORM_DEPTH = 5;
const PLATFORM_HEIGHT = 9;
const PLATFORM_TOP_Y = PLATFORM_HEIGHT;

/** NPC + wall spacing from player (original ground layout, Three.js forward is −Z). */
const NPC_DISTANCE_M = 1.25;
const NPC_Z = -NPC_DISTANCE_M;
const WALL_WIDTH = 5;
const WALL_HEIGHT = 1;
const WALL_THICKNESS = 0.1;
const WALL_Z = NPC_Z * 0.5;
const WALL_BASE_Y = PLATFORM_TOP_Y;
const WALL_CENTER_Y = WALL_BASE_Y + WALL_HEIGHT * 0.5;
/** Player-facing surface of the wall (toward +Z). */
const WALL_NEAR_FACE_Z = WALL_Z + WALL_THICKNESS * 0.5;
/** Front face of the block — same Z as the wall face (~0.58 m from player at origin). */
const PLATFORM_FRONT_Z = WALL_NEAR_FACE_Z;
const PLATFORM_BACK_Z = PLATFORM_FRONT_Z - PLATFORM_DEPTH;
const PLATFORM_CENTER_Z = PLATFORM_FRONT_Z - PLATFORM_DEPTH * 0.5;
const PIPE_HEIGHT = 15;
const PIPE_RADIUS = 0.05;
const PLAYER_COLLISION_RADIUS = 0.28;
/** Head above wall top (≈10 m) → can move past wall onto the platform. */
const WALL_MANTLE_CLEAR_Y = WALL_BASE_Y + WALL_HEIGHT - 0.05;
/** While climbing: only block penetrating the wall plane, not a forward standoff gap. */
const CLIMB_WALL_PENETRATE_EPS = 0.015;
const CLIMB_WALL_COLLISION_RADIUS = CLIMB_WALL_PENETRATE_EPS;
const moveSpeed = 3.5;
const rotateSpeed = 120;
const deadzone = 0.15;
const PLAYER_GRAVITY = 9.81;
const GROUND_EPS = 0.001;
const MAX_THROW_SPEED = 9;
const GROUND_FRICTION = 10;

const root = document.getElementById('app');
const hud = document.getElementById('hud');
if (!root || !hud) throw new Error('#app or #hud missing');

const bulletTimeVignette = document.createElement('div');
bulletTimeVignette.id = 'bullet-time-vignette';
Object.assign(bulletTimeVignette.style, {
  position: 'fixed',
  inset: '0',
  pointerEvents: 'none',
  opacity: '0',
  zIndex: '8',
  background:
    'radial-gradient(ellipse at center, transparent 42%, rgba(0, 12, 28, 0.75) 72%, rgba(0, 0, 0, 0.92) 100%)',
  transition: 'opacity 0.08s linear'
});
document.body.appendChild(bulletTimeVignette);
bindBulletTimeVignette(bulletTimeVignette);

hud.innerHTML = [
  '<b>VRragdoll</b> — NPC ragdoll + VR body IK (VRrunner rig)',
  'Desktop: <kbd>R</kbd> ragdoll · <kbd>G</kbd> / <kbd>Shift+G</kbd> stand · <kbd>Space</kbd> push',
  'VR: <b>squeeze</b> climb · bow: draw-hand <b>trigger</b> · <b>A</b> swap bow hand · <b>X</b> arrow type · NPC: squeeze · <b>Y</b> reset',
  '<span id="hud-state"></span>'
].join('<br/>');

const hudState = () => document.getElementById('hud-state');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.xr.enabled = true;
if (renderer.xr.setReferenceSpaceType) {
  try {
    renderer.xr.setReferenceSpaceType('local-floor');
  } catch (_) {
    /* ignore */
  }
}
root.appendChild(renderer.domElement);
root.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x252530);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 150);
const cameraRig = new THREE.Group();
cameraRig.name = 'camera_rig';
const crouchViewGroup = new THREE.Group();
crouchViewGroup.name = 'crouch_view_offset';
cameraRig.add(crouchViewGroup);
crouchViewGroup.add(camera);
camera.position.set(0, STANDING_EYE_Y, 0);
scene.add(cameraRig);

const bodyIkAvatar = createBodyIkAvatar(scene, { color: 0x5e87b8 });

const sun = new THREE.DirectionalLight(0xffffff, 1.05);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = sun.shadow.camera.bottom = -12;
sun.shadow.camera.right = sun.shadow.camera.top = 12;
sun.position.set(6, 14, 8);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x8899aa, 0.5));
scene.add(new THREE.HemisphereLight(0xb8c8e8, 0x2a2a32, 0.42));

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(24, 24),
  new THREE.MeshStandardMaterial({
    color: 0x4a5568,
    roughness: 0.92,
    metalness: 0.04,
    side: THREE.DoubleSide
  })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(24, 48, 0x7a8a9e, 0x3d4654);
grid.position.y = 0.001;
scene.add(grid);

const platformMesh = new THREE.Mesh(
  new THREE.BoxGeometry(PLATFORM_WIDTH, PLATFORM_HEIGHT, PLATFORM_DEPTH),
  new THREE.MeshStandardMaterial({
    color: 0x6b7280,
    roughness: 0.9,
    metalness: 0.05
  })
);
platformMesh.position.set(0, PLATFORM_HEIGHT * 0.5, PLATFORM_CENTER_Z);
platformMesh.castShadow = true;
platformMesh.receiveShadow = true;
scene.add(platformMesh);

const wallMesh = new THREE.Mesh(
  new THREE.BoxGeometry(WALL_WIDTH, WALL_HEIGHT, WALL_THICKNESS),
  new THREE.MeshStandardMaterial({
    color: 0x8b7355,
    roughness: 0.88,
    metalness: 0.06
  })
);
wallMesh.position.set(0, WALL_CENTER_Y, WALL_Z);
wallMesh.castShadow = true;
wallMesh.receiveShadow = true;
scene.add(wallMesh);

/** @type {THREE.Group | null} */
let controller1 = null;
/** @type {THREE.Group | null} */
let controller2 = null;
/** @type {THREE.Group | null} */
let controllerGrip1 = null;
/** @type {THREE.Group | null} */
let controllerGrip2 = null;
const handToCtrl = { left: null, right: null };
const handToPose = { left: null, right: null };

function setupVRControllers() {
  const xrHandsParent = crouchViewGroup;
  controller1 = renderer.xr.getController(0);
  xrHandsParent.add(controller1);
  controllerGrip1 = renderer.xr.getControllerGrip(0);
  controllerGrip1.add(new THREE.Group());
  xrHandsParent.add(controllerGrip1);

  controller2 = renderer.xr.getController(1);
  xrHandsParent.add(controller2);
  controllerGrip2 = renderer.xr.getControllerGrip(1);
  controllerGrip2.add(new THREE.Group());
  xrHandsParent.add(controllerGrip2);

  function clearHandSlotForGrip(grip, ctrl) {
    if (handToCtrl.left === grip) handToCtrl.left = null;
    if (handToCtrl.right === grip) handToCtrl.right = null;
    if (handToPose.left === ctrl) handToPose.left = null;
    if (handToPose.right === ctrl) handToPose.right = null;
  }

  function onGripConnected(grip, ctrl, e) {
    const src = e.data || null;
    grip.userData.xrInputSource = src;
    ctrl.userData.xrInputSource = src;
    const h = src?.handedness;
    if (h === 'left') {
      handToCtrl.left = grip;
      handToPose.left = ctrl;
    } else if (h === 'right') {
      handToCtrl.right = grip;
      handToPose.right = ctrl;
    } else if (!handToCtrl.left) {
      handToCtrl.left = grip;
      handToPose.left = ctrl;
    } else if (!handToCtrl.right) {
      handToCtrl.right = grip;
      handToPose.right = ctrl;
    }
  }

  function onGripDisconnected(grip, ctrl) {
    grip.userData.xrInputSource = null;
    ctrl.userData.xrInputSource = null;
    clearHandSlotForGrip(grip, ctrl);
  }

  controller1.addEventListener('connected', (e) => onGripConnected(controllerGrip1, controller1, e));
  controller1.addEventListener('disconnected', () => onGripDisconnected(controllerGrip1, controller1));
  controller2.addEventListener('connected', (e) => onGripConnected(controllerGrip2, controller2, e));
  controller2.addEventListener('disconnected', () => onGripDisconnected(controllerGrip2, controller2));
}

setupVRControllers();

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, PLATFORM_TOP_Y + 1, NPC_Z);
controls.enableDamping = true;
controls.update();

const vrInput = {
  leftStick: { x: 0, y: 0 },
  rightStick: { x: 0, y: 0 }
};

const _glQuatW = new THREE.Quaternion();
const _glEul = new THREE.Euler();
const _glFwd = new THREE.Vector3();
const _localPush = new THREE.Vector3();
const _rigPosPrev = new THREE.Vector3();
const _refHand = new THREE.Vector3();
const rigVelocity = new THREE.Vector3();

/**
 * @param {THREE.Vector3} next
 * @param {THREE.Vector3} prev
 * @param {boolean} [climbing]
 * @param {THREE.Camera | null} [xrCamera]
 */
function resolvePlayerAgainstWall(next, prev, climbing = false, xrCamera = null) {
  if (xrCamera) {
    xrCamera.getWorldPosition(tmpV);
    if (tmpV.y >= WALL_MANTLE_CLEAR_Y) return next;
  }

  const halfW = WALL_WIDTH * 0.5;
  const halfT = WALL_THICKNESS * 0.5;
  const r = climbing ? CLIMB_WALL_COLLISION_RADIUS : PLAYER_COLLISION_RADIUS;

  if (Math.abs(next.x) > halfW + r) return next;

  const zFaceNear = WALL_NEAR_FACE_Z + r;
  const zFaceFar = WALL_Z - halfT - r;

  if (next.z > zFaceNear || next.z < zFaceFar) return next;

  if (prev.z >= zFaceNear) next.z = zFaceNear;
  else if (prev.z <= zFaceFar) next.z = zFaceFar;
  else next.z = next.z > WALL_Z ? zFaceNear : zFaceFar;

  return next;
}

/** Rig XZ over the platform footprint (can stand on y = PLATFORM_TOP_Y). */
function isOverPlatformXZ(pos) {
  const halfW = PLATFORM_WIDTH * 0.5 + 0.08;
  return (
    Math.abs(pos.x) <= halfW && pos.z <= PLATFORM_FRONT_Z + 0.05 && pos.z >= PLATFORM_BACK_Z - 0.05
  );
}

/**
 * Highest floor under the player (ground or platform deck).
 * @param {THREE.Vector3} rigPos
 * @param {THREE.Camera | null} [xrCamera]
 */
function getPlayerSupportY(rigPos, xrCamera = null) {
  let y = 0;
  if (isOverPlatformXZ(rigPos)) {
    y = PLATFORM_TOP_Y;
  }
  if (xrCamera) {
    xrCamera.getWorldPosition(tmpV);
    /* Large margin so crouch / duck does not drop support to ground (y = 0). */
    if (tmpV.y >= PLATFORM_TOP_Y - 1.85 && isOverPlatformXZ(tmpV)) {
      y = Math.max(y, PLATFORM_TOP_Y);
    }
  }
  return y;
}

/** Keep rig feet on the platform deck when standing/crouching on it. */
function enforcePlatformDeckSupport(xrCamera) {
  const onDeck =
    isOverPlatformXZ(cameraRig.position) ||
    (xrCamera && (xrCamera.getWorldPosition(tmpV), isOverPlatformXZ(tmpV)));
  if (!onDeck) return;
  if (cameraRig.position.y < PLATFORM_TOP_Y - 0.02) {
    cameraRig.position.y = PLATFORM_TOP_Y;
    if (rigVelocity.y < 0) rigVelocity.y = 0;
  }
}

/**
 * Block walking through the front of the block below deck height.
 * @param {THREE.Camera} xrCamera
 */
function enforcePlatformFrontConstraint(xrCamera) {
  xrCamera.getWorldPosition(tmpV);
  /* On the deck: do not shove the rig forward when the head dips (crouch). */
  if (isOverPlatformXZ(cameraRig.position) || isOverPlatformXZ(tmpV)) {
    return;
  }
  if (tmpV.y >= PLATFORM_TOP_Y - 0.35) return;

  const halfW = PLATFORM_WIDTH * 0.5 + 0.12;
  if (Math.abs(cameraRig.position.x) > halfW) return;

  const minZ = PLATFORM_FRONT_Z + 0.1;
  if (cameraRig.position.z < minZ) {
    cameraRig.position.z = minZ;
    if (rigVelocity.z < 0) rigVelocity.z = 0;
  }
}

/**
 * Hard plane at the wall face — climb moves can overshoot soft sphere pushes.
 * @param {THREE.Camera} xrCamera
 * @param {boolean} climbing
 */
function enforceWallPlaneConstraint(xrCamera, climbing = false) {
  xrCamera.getWorldPosition(tmpV);
  if (tmpV.y >= WALL_MANTLE_CLEAR_Y) return;

  const halfW = WALL_WIDTH * 0.5 + 0.15;
  if (Math.abs(cameraRig.position.x) > halfW) return;

  const minZ = climbing ? WALL_NEAR_FACE_Z - CLIMB_WALL_PENETRATE_EPS : WALL_NEAR_FACE_Z + 0.1;

  if (cameraRig.position.z < minZ) {
    cameraRig.position.z = minZ;
    if (rigVelocity.z < 0) rigVelocity.z = 0;
  }

  if (!climbing && tmpV.z < WALL_NEAR_FACE_Z + 0.08) {
    cameraRig.position.z += WALL_NEAR_FACE_Z + 0.08 - tmpV.z;
    if (rigVelocity.z < 0) rigVelocity.z = 0;
  }
}

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.05, 0));
world.createCollider(RAPIER.ColliderDesc.cuboid(12, 0.05, 12), ground);

const platformBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.fixed().setTranslation(0, PLATFORM_HEIGHT * 0.5, PLATFORM_CENTER_Z)
);
world.createCollider(
  RAPIER.ColliderDesc.cuboid(
    PLATFORM_WIDTH * 0.5,
    PLATFORM_HEIGHT * 0.5,
    PLATFORM_DEPTH * 0.5
  ),
  platformBody
);

const wallBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.fixed().setTranslation(0, WALL_CENTER_Y, WALL_Z)
);
world.createCollider(
  RAPIER.ColliderDesc.cuboid(WALL_WIDTH * 0.5, WALL_HEIGHT * 0.5, WALL_THICKNESS * 0.5),
  wallBody
);

const grabbables = new GrabbablePropManager(scene, world, RAPIER);
const BAR_THICKNESS = 0.1;
grabbables.addBar({
  id: 'wall_ledge',
  center: new THREE.Vector3(0, WALL_BASE_Y + WALL_HEIGHT + BAR_THICKNESS * 0.5, WALL_Z),
  lengthX: WALL_WIDTH,
  thickness: BAR_THICKNESS
});
grabbables.addPipe({
  id: 'climb_pipe',
  base: new THREE.Vector3(0.55, 0, WALL_NEAR_FACE_Z + PIPE_RADIUS),
  height: PIPE_HEIGHT,
  radius: PIPE_RADIUS
});

buildRunnerCollisionBoxes({
  platformWidth: PLATFORM_WIDTH,
  platformDepth: PLATFORM_DEPTH,
  platformHeight: PLATFORM_HEIGHT,
  platformCenterZ: PLATFORM_CENTER_Z,
  wallWidth: WALL_WIDTH,
  wallHeight: WALL_HEIGHT,
  wallZ: WALL_Z,
  wallBaseY: WALL_BASE_Y,
  wallThickness: WALL_THICKNESS
});

let archeryReady = false;

function setupRunnerArchery() {
  if (archeryReady) return;
  initArcherySandbox({
    scene,
    camera,
    cameraRig,
    renderer,
    getCollisionBoxes: getRunnerCollisionBoxes,
    getPlayerVelocity: () => rigVelocity,
    getPlayerPosition: () => cameraRig.position
  });
  setArrowRagdollCallbacks({
    segmentHit: (prev, dir, segLen, speed) => {
      if (!ragdoll) return null;
      const hit = ragdoll.testArrowSegmentHit(prev, dir, segLen, speed);
      if (hit) notifyArrowHitNpc();
      return hit;
    },
    explosion: (center, radius, push) => {
      ragdoll?.applyExplosion(center, radius, push);
      notifyArrowHitNpc();
    }
  });
  archeryReady = true;
}

/** @type {RagdollNPC | null} */
let ragdoll = null;
let loadError = '';

const gltfLoader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
gltfLoader.setDRACOLoader(draco);

gltfLoader.load(
  CHARACTER_URL,
  (gltf) => {
    ragdoll = new RagdollNPC(world, RAPIER);
    ragdoll.attachFromGLTF(scene, gltf.scene, gltf.animations || [], NPC_Z, PLATFORM_TOP_Y);
  },
  undefined,
  (err) => {
    console.error(err);
    loadError = String(err && err.message ? err.message : err);
    const el = hudState();
    if (el) el.textContent = `Load failed: ${loadError}`;
  }
);

const clock = new THREE.Clock();
const tmpV = new THREE.Vector3();
const handPrev = { left: new THREE.Vector3(), right: new THREE.Vector3() };
const handVel = { left: new THREE.Vector3(), right: new THREE.Vector3() };
const handRefPrev = { left: new THREE.Vector3(), right: new THREE.Vector3() };
const handVelRef = { left: new THREE.Vector3(), right: new THREE.Vector3() };
const handRefReady = { left: false, right: false };
const _throwVel = new THREE.Vector3();
const squeezePrev = { left: false, right: false };
const ikHandL = new THREE.Vector3();
const ikHandR = new THREE.Vector3();
/** Match visible IK hands on the NPC (grip is often offset from the mesh). */
const VR_NPC_GRAB_REACH = 0.95;
let prevAnyPrimary = false;
let yButtonWasPressed = false;

/**
 * @param {'left' | 'right'} side
 * @param {THREE.Object3D} grip
 * @param {THREE.Vector3} out
 */
function getVRInteractionHand(side, grip, out) {
  if (bodyIkAvatar.getHandWorldPosition(side, out)) return out;
  grip.getWorldPosition(out);
  return out;
}
/** @type {{ a: THREE.Vector3, b: THREE.Vector3, segRadius: number }[]} */
const propCollisionSegments = [];

function setHudLine(extra) {
  const el = hudState();
  if (!el) return;
  let grab = '—';
  if (ragdoll) {
    const parts = [];
    if (ragdoll.grabbedPart.left) parts.push(`L:${ragdoll.grabbedPart.left}`);
    if (ragdoll.grabbedPart.right) parts.push(`R:${ragdoll.grabbedPart.right}`);
    if (parts.length) grab = parts.join(' ');
  }
  const base = ragdoll ? `Mode: <b>${ragdoll.mode}</b> · grab: ${grab}` : 'Loading character…';
  el.innerHTML = `${base}${extra ? ` · ${extra}` : ''}`;
}

function applyImpulseToTorso() {
  if (!ragdoll || ragdoll.mode !== 'ragdoll') return;
  const torso = ragdoll.getBody('torso');
  if (!torso) return;
  torso.applyImpulse({ x: (Math.random() - 0.5) * 3, y: 2.2, z: 4.5 }, true);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && ragdoll) ragdoll.setMode('ragdoll');
  if (e.code === 'KeyG' && ragdoll && ragdoll.mode === 'ragdoll') {
    if (e.shiftKey || ragdoll.canReturnToAnimated()) ragdoll.setMode('animated');
  }
  if (e.code === 'Space' && ragdoll) {
    e.preventDefault();
    applyImpulseToTorso();
  }
  if (e.code === 'KeyY' && ragdoll) {
    ragdoll.resetToSpawn();
  }
});

function updateHandVel(hand, pos, dt) {
  const prev = hand === 'left' ? handPrev.left : handPrev.right;
  const vel = hand === 'left' ? handVel.left : handVel.right;
  if (dt > 1e-4) vel.copy(pos).sub(prev).divideScalar(dt);
  prev.copy(pos);
}

/**
 * Hand speed in XR reference space while climbing (matches inverse climb coupling).
 * @param {'left' | 'right'} hand
 * @param {XRFrame | null | undefined} xrFrame
 * @param {XRReferenceSpace | null | undefined} refSpace
 * @param {XRInputSource | null | undefined} inputSource
 * @param {number} dt
 */
function updateHandRefVel(hand, xrFrame, refSpace, inputSource, dt) {
  if (!getGripRefPosition(xrFrame, refSpace, inputSource, _refHand)) {
    handRefReady[hand] = false;
    return;
  }
  const prev = handRefPrev[hand];
  const vel = handVelRef[hand];
  if (handRefReady[hand] && dt > 1e-4) {
    vel.copy(_refHand).sub(prev).divideScalar(dt);
  } else {
    vel.set(0, 0, 0);
  }
  prev.copy(_refHand);
  handRefReady[hand] = true;
}

/**
 * On climb release: rig inherits opposite of hand velocity (same as inverse grab move).
 * @param {{ left: boolean, right: boolean }} releasedHands
 */
function applyClimbThrowFromReleasedHands(releasedHands) {
  _throwVel.set(0, 0, 0);
  let n = 0;

  for (const side of ['left', 'right']) {
    if (!releasedHands[side]) continue;
    if (handRefReady[side]) {
      _throwVel.sub(handVelRef[side]);
    } else {
      _throwVel.sub(handVel[side]);
    }
    n++;
  }
  if (n === 0) return;

  _throwVel.multiplyScalar(1 / n);
  const speed = _throwVel.length();
  if (speed > MAX_THROW_SPEED) {
    _throwVel.multiplyScalar(MAX_THROW_SPEED / speed);
  }
  if (speed < 0.08) return;

  rigVelocity.copy(_throwVel);
}

/**
 * Inertial rig motion + gravity after releasing a climb.
 * @param {number} dt
 */
function applyRigGravity(dt) {
  if (grabbables.anyGrabActive) {
    rigVelocity.set(0, 0, 0);
    return;
  }

  const floorY = getPlayerSupportY(cameraRig.position, camera);
  const onGround = cameraRig.position.y <= floorY + GROUND_EPS;

  if (onGround && rigVelocity.y <= 0) {
    cameraRig.position.y = floorY;
    rigVelocity.y = 0;

    if (rigVelocity.x * rigVelocity.x + rigVelocity.z * rigVelocity.z > 1e-6) {
      _rigPosPrev.copy(cameraRig.position);
      cameraRig.position.x += rigVelocity.x * dt;
      cameraRig.position.z += rigVelocity.z * dt;
      resolvePlayerAgainstWall(cameraRig.position, _rigPosPrev, false, camera);
      const groundDamp = Math.exp(-GROUND_FRICTION * dt);
      rigVelocity.x *= groundDamp;
      rigVelocity.z *= groundDamp;
    }
    if (rigVelocity.lengthSq() < 0.0025) {
      rigVelocity.set(0, 0, 0);
    }
    return;
  }

  rigVelocity.y -= PLAYER_GRAVITY * dt;

  _rigPosPrev.copy(cameraRig.position);
  cameraRig.position.x += rigVelocity.x * dt;
  cameraRig.position.y += rigVelocity.y * dt;
  cameraRig.position.z += rigVelocity.z * dt;
  resolvePlayerAgainstWall(cameraRig.position, _rigPosPrev, false, camera);

  const landY = getPlayerSupportY(cameraRig.position, camera);
  if (cameraRig.position.y <= landY + GROUND_EPS) {
    cameraRig.position.y = landY;
    if (rigVelocity.y < 0) rigVelocity.y = 0;
  }
}

/**
 * Head-relative XZ locomotion (VRrunner editor movement, flat floor).
 * @param {number} dt
 * @param {THREE.Camera} xrCamera
 */
function updateFlatVRLocomotion(dt, xrCamera) {
  if (grabbables.anyGrabActive) {
    return;
  }

  xrCamera.getWorldQuaternion(_glQuatW);
  _glEul.setFromQuaternion(_glQuatW, 'YXZ');
  _glEul.x = 0;
  _glEul.z = 0;
  _glQuatW.setFromEuler(_glEul);

  _glFwd.set(0, 0, -1).applyQuaternion(_glQuatW);
  _glFwd.y = 0;
  if (_glFwd.lengthSq() < 1e-10) {
    _glFwd.set(0, 0, -1).applyQuaternion(cameraRig.quaternion);
    _glFwd.y = 0;
  }
  if (_glFwd.lengthSq() < 1e-10) _glFwd.set(0, 0, -1);
  _glFwd.normalize();

  const strafe = _localPush;
  strafe.set(-_glFwd.z, 0, _glFwd.x);

  _rigPosPrev.copy(cameraRig.position);

  const moveX = Math.abs(vrInput.leftStick.x) > deadzone ? -vrInput.leftStick.x : 0;
  const moveY = Math.abs(vrInput.leftStick.y) > deadzone ? -vrInput.leftStick.y : 0;
  if (moveX !== 0 || moveY !== 0) {
    /* Match VRrunner: strafe uses minus moveX so left stick left/right feel correct. */
    cameraRig.position.x += (_glFwd.x * moveY - strafe.x * moveX) * moveSpeed * dt;
    cameraRig.position.z += (_glFwd.z * moveY - strafe.z * moveX) * moveSpeed * dt;
    resolvePlayerAgainstWall(cameraRig.position, _rigPosPrev, false, xrCamera);
  }

  const rotateX = Math.abs(vrInput.rightStick.x) > deadzone ? vrInput.rightStick.x : 0;
  if (rotateX !== 0) {
    cameraRig.rotation.y -= rotateX * rotateSpeed * dt * (Math.PI / 180);
  }

  applyRigGravity(dt);
}

function pollVRInput(session) {
  vrInput.leftStick.x = 0;
  vrInput.leftStick.y = 0;
  vrInput.rightStick.x = 0;
  vrInput.rightStick.y = 0;
  if (!session) return null;
  return getPairedXRControllerGrips(session, controllerGrip1, controllerGrip2);
}

function updateXRInteraction(dt) {
  if (!ragdoll) return;
  const session = renderer.xr.getSession();
  if (!session) return;

  const pads = pollVRInput(session);
  if (!pads) return;

  const xrFrame = renderer.xr.getFrame();
  const refSpace = renderer.xr.getReferenceSpace();

  applyGamepadAxesToVRInput(pads.L?.gamepad, true, vrInput);
  applyGamepadAxesToVRInput(pads.R?.gamepad, false, vrInput);

  if (renderer.xr?.isPresenting && typeof renderer.xr.updateCamera === 'function') {
    renderer.xr.updateCamera(camera);
  }
  const xrCamera = renderer.xr.getCamera();

  const yPressed = !!(
    pads.L?.gamepad?.buttons?.[5]?.pressed || pads.R?.gamepad?.buttons?.[5]?.pressed
  );
  if (yPressed && !yButtonWasPressed) {
    ragdoll.resetToSpawn();
  }
  yButtonWasPressed = yPressed;

  let anyPrimary = false;
  /** @type {{ left?: { grip: THREE.Object3D, inputSource?: XRInputSource | null }, right?: { grip: THREE.Object3D, inputSource?: XRInputSource | null }}} */
  const propHands = {};
  /** @type {{ left?: { pos: THREE.Vector3, vel: THREE.Vector3 }, right?: { pos: THREE.Vector3, vel: THREE.Vector3 }}} */
  const npcHands = {};
  const propReleased = { left: false, right: false };

  for (const side of ['left', 'right']) {
    const grip = side === 'left' ? pads.leftGrip : pads.rightGrip;
    const src = side === 'left' ? pads.L : pads.R;
    if (!grip || !src?.gamepad) continue;

    const ikOut = side === 'left' ? ikHandL : ikHandR;
    getVRInteractionHand(side, grip, ikOut);
    updateHandVel(side, ikOut, dt);
    if (grabbables.grabbedId[side]) {
      updateHandRefVel(side, xrFrame, refSpace, src, dt);
    }

    const squeeze = side === 'left' ? pads.squeezeLeft : pads.squeezeRight;
    const gp = src.gamepad;
    if (gp.buttons[0]?.pressed || gp.buttons[4]?.pressed) anyPrimary = true;

    const was = side === 'left' ? squeezePrev.left : squeezePrev.right;
    if (squeeze && !was) {
      const npcHit = ragdoll.probeGrabPart(ikOut, VR_NPC_GRAB_REACH);
      const propHit = grabbables.findClosestGrab(ikOut);
      const preferNpc = npcHit && (!propHit || npcHit.dist <= propHit.dist + 0.04);

      if (preferNpc && ragdoll.tryGrab(ikOut, side)) {
        grabbables.releaseGrab(side);
      } else if (grabbables.tryGrab(ikOut, side, cameraRig, grip)) {
        handRefReady[side] = false;
        if (xrFrame && refSpace && src && getGripRefPosition(xrFrame, refSpace, src, _refHand)) {
          handRefPrev[side].copy(_refHand);
        }
        ragdoll.releaseGrab(side);
      } else if (ragdoll.tryGrab(ikOut, side)) {
        grabbables.releaseGrab(side);
      }
    }
    if (!squeeze && was) {
      if (grabbables.grabbedId[side]) {
        propReleased[side] = true;
      }
      grabbables.releaseGrab(side);
      ragdoll.releaseGrab(side);
    }
    if (side === 'left') squeezePrev.left = squeeze;
    else squeezePrev.right = squeeze;

    const pos = side === 'left' ? handPrev.left : handPrev.right;
    const vel = side === 'left' ? handVel.left : handVel.right;
    if (squeeze && grabbables.grabbedId[side]) {
      propHands[side] = { grip };
    } else if (squeeze && ragdoll.grabbedPart[side]) {
      npcHands[side] = { pos, vel };
    }
  }

  if (!grabbables.anyGrabActive && (propReleased.left || propReleased.right)) {
    applyClimbThrowFromReleasedHands(propReleased);
  }

  if (grabbables.anyGrabActive) {
    rigVelocity.set(0, 0, 0);
    grabbables.stepGrabs(propHands, cameraRig);
  } else if (!isArcheryDrawActive() && !isGrappleHookActive()) {
    updateFlatVRLocomotion(dt, xrCamera);
  }

  updateBulletTime(dt, ragdoll, isOverPlatformXZ, PLATFORM_TOP_Y, { impendingOnly: true });
  setupRunnerArchery();
  updateArcherySandbox(dt * getBulletTimeScale());
  updateBulletTime(dt, ragdoll, isOverPlatformXZ, PLATFORM_TOP_Y);
  applyGrappleWinchStep(dt);

  ragdoll.stepGrabs(npcHands);

  if (
    anyPrimary
    && !prevAnyPrimary
    && ragdoll.mode === 'ragdoll'
    && !ragdoll.anyGrabActive
    && ragdoll.canReturnToAnimated()
  ) {
    ragdoll.setMode('animated');
  }
  prevAnyPrimary = anyPrimary;
}

renderer.xr.addEventListener('sessionstart', () => {
  cameraRig.position.set(0, 0, 0);
  cameraRig.rotation.set(0, 0, 0);
  rigVelocity.set(0, 0, 0);
  setupRunnerArchery();
});

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (renderer.xr.isPresenting) {
    if (typeof renderer.xr.updateCamera === 'function') {
      renderer.xr.updateCamera(camera);
    }
    bodyIkAvatar.update({
      active: true,
      headObject: camera,
      leftHandObject: handToPose.left || handToCtrl.left,
      leftHandRotationObject: handToCtrl.left || handToPose.left,
      rightHandObject: handToPose.right || handToCtrl.right,
      rightHandRotationObject: handToCtrl.right || handToPose.right,
      velocity: rigVelocity,
      dtSec: dt
    });
    updateXRInteraction(dt);
  } else {
    controls.update();
    bodyIkAvatar.update({
      active: false,
      headObject: camera,
      leftHandObject: null,
      rightHandObject: null,
      velocity: rigVelocity,
      dtSec: dt
    });
  }

  if (!renderer.xr.isPresenting) {
    updateBulletTime(dt, ragdoll, isOverPlatformXZ, PLATFORM_TOP_Y);
  }
  const simDt = dt * getBulletTimeScale();

  if (ragdoll?.mixer && (ragdoll.mode === 'animated' || ragdoll.isCollapseDriving())) {
    ragdoll.mixer.update(simDt);
  }
  if (ragdoll?.mode === 'animated') {
    ragdoll.stepKinematicBodies();
  }

  if (ragdoll?.mode === 'ragdoll') {
    ragdoll.prePhysicsStep(simDt);
  }

  world.timestep = simDt;
  world.step();

  if (ragdoll?.mode === 'ragdoll') {
    ragdoll.syncBonesFromPhysics();
  }

  if (renderer.xr.isPresenting) {
    propCollisionSegments.length = 0;
    grabbables.fillCollisionSegments(propCollisionSegments);
    const climbing = grabbables.anyGrabActive;
    resolvePlayerBodyCollisions(
      cameraRig,
      camera,
      handToCtrl,
      ragdoll,
      {
        width: WALL_WIDTH,
        height: WALL_HEIGHT,
        thickness: WALL_THICKNESS,
        z: WALL_Z,
        baseY: WALL_BASE_Y,
        nearFaceZ: WALL_NEAR_FACE_Z,
        mantleClearY: WALL_MANTLE_CLEAR_Y
      },
      propCollisionSegments,
      {
        climbing,
        platform: {
          topY: PLATFORM_TOP_Y,
          minX: -PLATFORM_WIDTH * 0.5 - 0.08,
          maxX: PLATFORM_WIDTH * 0.5 + 0.08,
          minZ: PLATFORM_BACK_Z - 0.05,
          maxZ: PLATFORM_FRONT_Z + 0.05
        }
      }
    );
    const xrCam = renderer.xr.getCamera();
    enforceWallPlaneConstraint(xrCam, climbing);
    enforcePlatformFrontConstraint(xrCam);
    const supportY = getPlayerSupportY(cameraRig.position, xrCam);
    if (cameraRig.position.y < supportY) {
      cameraRig.position.y = supportY;
      if (rigVelocity.y < 0) rigVelocity.y = 0;
    }
    enforcePlatformDeckSupport(xrCam);
  }

  setHudLine(loadError && !ragdoll ? loadError : '');
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (!renderer.xr.isPresenting) {
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
});
