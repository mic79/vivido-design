/**
 * White Room VR — glossy floor + A-Frame/spaceshooter bloom (identical bind).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { GlossyReflector } from './GlossyReflector.js?v=8';
import { bindAframeBloom } from './aframeBloom.js?v=8';

const ROOM_GLB = new URL('../white_room.glb', import.meta.url).href;
const ROOM_ENV = new URL('../room_env.png', import.meta.url).href;
const ROOM_W = 7;
const ROOM_D = 14;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd8ecee);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.08, 60);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0xd8ecee, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Match typical A-Frame colorManagement path (spaceshooter)
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.xr.enabled = true;
Object.assign(renderer.domElement.style, {
  position: 'fixed',
  inset: '0',
  width: '100%',
  height: '100%',
  display: 'block',
  zIndex: '0',
});
document.body.appendChild(renderer.domElement);
document.getElementById('vr-slot').appendChild(VRButton.createButton(renderer));

const rig = new THREE.Group();
rig.position.set(0, 0, -5.6);
rig.rotation.y = Math.PI;
scene.add(rig);
camera.position.set(0, 1.48, 0);
rig.add(camera);

const clock = new THREE.Clock();
const tmpFwd = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpP0 = new THREE.Vector3();
const tmpP1 = new THREE.Vector3();
let turnLatched = false;
let pointerLocked = false;
let yaw = 0;
let pitch = 0.05;
const keys = new Set();

renderer.domElement.addEventListener('click', () => {
  if (!renderer.xr.isPresenting) renderer.domElement.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('mousemove', (e) => {
  if (!pointerLocked || renderer.xr.isPresenting) return;
  yaw -= e.movementX * 0.0022;
  pitch -= e.movementY * 0.0022;
  pitch = Math.max(-1.1, Math.min(1.1, pitch));
});
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

function pickStick(axes) {
  if (!axes) return [0, 0];
  const a01 = Math.hypot(axes[0] || 0, axes[1] || 0);
  const a23 = Math.hypot(axes[2] || 0, axes[3] || 0);
  return a23 >= a01 ? [axes[2] || 0, axes[3] || 0] : [axes[0] || 0, axes[1] || 0];
}

function rotateRigYaw(delta) {
  camera.getWorldPosition(tmpP0);
  rig.rotation.y += delta;
  rig.updateMatrixWorld(true);
  camera.getWorldPosition(tmpP1);
  rig.position.x += tmpP0.x - tmpP1.x;
  rig.position.z += tmpP0.z - tmpP1.z;
}

function updateLocomotion(dt) {
  const speed = 2.4;
  let lx = 0;
  let ly = 0;
  let rx = 0;
  if (renderer.xr.isPresenting) {
    const session = renderer.xr.getSession();
    if (session) {
      for (const src of session.inputSources) {
        if (!src.gamepad || !src.handedness) continue;
        const [sx, sy] = pickStick(src.gamepad.axes);
        if (src.handedness === 'left') {
          lx = sx;
          ly = sy;
        } else if (src.handedness === 'right') {
          rx = sx;
        }
      }
    }
  } else {
    if (keys.has('KeyW') || keys.has('ArrowUp')) ly += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) ly -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) lx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) lx += 1;
  }
  const dead = 0.15;
  if (Math.abs(lx) > dead || Math.abs(ly) > dead) {
    camera.getWorldDirection(tmpFwd);
    tmpFwd.y = 0;
    if (tmpFwd.lengthSq() > 1e-6) tmpFwd.normalize();
    tmpRight.set(-tmpFwd.z, 0, tmpFwd.x);
    const k = speed * dt;
    rig.position.addScaledVector(tmpFwd, ly * k);
    rig.position.addScaledVector(tmpRight, lx * k);
    rig.position.x = THREE.MathUtils.clamp(rig.position.x, -3.1, 3.1);
    rig.position.z = THREE.MathUtils.clamp(rig.position.z, -6.3, 6.3);
  }
  if (renderer.xr.isPresenting) {
    if (Math.abs(rx) > 0.7 && !turnLatched) {
      turnLatched = true;
      rotateRigYaw((rx > 0 ? -1 : 1) * THREE.MathUtils.degToRad(30));
    } else if (Math.abs(rx) < 0.4) {
      turnLatched = false;
    }
  }
}

function tuneMap(map) {
  if (!map) return;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = renderer.capabilities.getMaxAnisotropy();
  map.needsUpdate = true;
}

// spaceshooter.html: threshold 0.98; strength 0.3; radius 0.15
const bloom = bindAframeBloom(renderer, scene, camera, {
  threshold: 0.98,
  strength: 0.3,
  radius: 0.15,
});

renderer.xr.addEventListener('sessionstart', () => bloom.resize());
renderer.xr.addEventListener('sessionend', () => bloom.resize());

let floorReflector = null;

async function loadRoom() {
  const [gltf, envTex] = await Promise.all([
    new GLTFLoader().loadAsync(ROOM_GLB),
    new THREE.TextureLoader().loadAsync(ROOM_ENV),
  ]);

  envTex.colorSpace = THREE.SRGBColorSpace;
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnvMap = pmrem.fromEquirectangular(envTex).texture;
  envTex.dispose();
  pmrem.dispose();
  scene.environment = roomEnvMap;
  if ('environmentRotation' in scene) {
    scene.environmentRotation.set(0, Math.PI, 0);
  }

  const root = gltf.scene;
  root.updateMatrixWorld(true);

  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.castShadow = false;
    o.receiveShadow = false;
    const src = o.material;
    tuneMap(src.map);

    if (/floor/i.test(o.name)) {
      o.visible = false;
      return;
    }

    if (/cove/i.test(o.name)) {
      o.visible = false;
      return;
    }

    if (/light/i.test(o.name)) {
      // spaceshooter-style emissive so UnrealBloom threshold can pick it up
      o.material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: new THREE.Color(0xe8f4f8),
        emissiveIntensity: 2.5,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
      });
      return;
    }

    // Stay under bloom threshold (0.98) so walls don't wash to white
    o.material = new THREE.MeshBasicMaterial({
      map: src.map || null,
      color: new THREE.Color(0.92, 0.96, 0.97),
      side: THREE.DoubleSide,
    });
  });

  scene.add(root);

  const res = Math.floor(512 * Math.min(window.devicePixelRatio || 1, 1.5));
  floorReflector = new GlossyReflector(new THREE.PlaneGeometry(ROOM_W - 0.04, ROOM_D - 0.04), {
    resolution: res,
    color: 0xd5e8ea,
    mirrorStrength: 0.97,
    mixBlur: 1.0,
    fresnelPower: 2.6,
    baseLift: 0.5,
    maxHeight: 3.6,
    heightSharp: 0.32,
    heightSoft: 0.75,
    clipBias: 0.003,
  });
  floorReflector.rotation.x = -Math.PI / 2;
  floorReflector.position.y = 0.012;
  scene.add(floorReflector);

  const debugHeight = new URLSearchParams(location.search).has('debugHeight');
  if (floorReflector.setDebugHeight) floorReflector.setDebugHeight(debugHeight);

  const hd = 7;
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: new THREE.Color(0xf2f8fa),
    emissiveIntensity: 3.0,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  for (const yBlender of [-hd + 1.85, -hd + 2.85]) {
    const z = -yBlender;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 0.55), panelMat.clone());
    panel.rotation.x = Math.PI / 2;
    panel.position.set(0, 3.55, z);
    scene.add(panel);
  }

  document.getElementById('hud').innerHTML =
    '<strong>White Room VR</strong> — A-Frame/spaceshooter bloom bind<br />Click · WASD · Enter VR · <code>?debugHeight=1</code>';
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  bloom.resize();
}
window.addEventListener('resize', onResize);

renderer.setAnimationLoop(() => {
  updateLocomotion(Math.min(clock.getDelta(), 0.05));
  if (!renderer.xr.isPresenting) {
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }
  renderer.render(scene, camera);
});

loadRoom().catch((err) => {
  console.error(err);
  document.getElementById('hud').textContent = 'Load failed — ' + (err?.message || err);
});
