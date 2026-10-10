// ========================================
// Camera-facing blast flipbook.
// Free CC0 sheet: assets/fx/explosion.png (StumpyStrust boom3, OpenGameArt).
// ========================================

const SHEET_URL = 'assets/fx/explosion.png';
const COLS = 8;
const ROWS = 8;
const FRAMES = COLS * ROWS;
const POOL = 24;

let scene3D = null;
let atlas = null;
/** @type {{ mesh: any, map: any, life: number, maxLife: number, size: number, x: number, y: number, z: number, active: boolean }[]} */
const blasts = [];
let _camPos = null;
let ready = false;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function ensureTemps(THREE) {
  if (_camPos) return;
  _camPos = new THREE.Vector3();
}

function setFrame(map, frame) {
  const f = Math.max(0, Math.min(FRAMES - 1, frame | 0));
  const col = f % COLS;
  const row = Math.floor(f / COLS); // row 0 = top of sheet
  map.offset.set(col / COLS, 1 - (row + 1) / ROWS);
}

function buildPool(THREE) {
  const geo = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < POOL; i++) {
    const map = atlas.clone();
    map.repeat.set(1 / COLS, 1 / ROWS);
    setFrame(map, 0);
    map.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      // Sheet is black-backed fire — additive drops the black square.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1004;
    mesh.visible = false;
    mesh.position.set(0, -1000, 0);
    scene3D.add(mesh);
    blasts.push({
      mesh,
      map,
      life: 0,
      maxLife: 0.6,
      size: 3,
      x: 0,
      y: 0,
      z: 0,
      active: false,
    });
  }
  ready = true;
}

export function initExplosionFlipbook(sceneEl) {
  const THREE = window.THREE;
  scene3D = sceneEl && sceneEl.object3D;
  if (!THREE || !scene3D || typeof document === 'undefined') return;
  ensureTemps(THREE);

  const bust =
    document.querySelector('meta[name="rts-version"]')?.getAttribute('content') || '';
  const url = bust ? `${SHEET_URL}?v=${bust}` : SHEET_URL;

  const loader = new THREE.TextureLoader();
  loader.load(
    url,
    (tex) => {
      atlas = tex;
      atlas.colorSpace = THREE.SRGBColorSpace || atlas.colorSpace;
      atlas.wrapS = THREE.ClampToEdgeWrapping;
      atlas.wrapT = THREE.ClampToEdgeWrapping;
      atlas.magFilter = THREE.LinearFilter;
      atlas.minFilter = THREE.LinearFilter;
      atlas.generateMipmaps = false;
      atlas.flipY = true;
      atlas.needsUpdate = true;
      buildPool(THREE);
    },
    undefined,
    (err) => {
      console.warn('[fx] explosion sheet failed to load', url, err);
    },
  );
}

function profile(kind) {
  if (kind === 'death') return { size: 7.5, life: 0.95 };
  if (kind === 'heavy') return { size: 5.6, life: 0.8 };
  if (kind === 'muzzle') return { size: 1.6, life: 0.28 };
  return { size: 3.8, life: 0.65 };
}

/** @param {'impact'|'heavy'|'death'|'muzzle'} [kind] */
export function spawnBlast(x, y, z, kind = 'impact') {
  if (!ready || !blasts.length) return;
  let slot = blasts.find((b) => !b.active);
  if (!slot) {
    slot = blasts.reduce((a, b) => (a.life > b.life ? a : b));
  }
  const p = profile(kind);
  slot.active = true;
  slot.life = 0;
  slot.maxLife = p.life;
  slot.size = p.size;
  slot.x = x;
  slot.y = y;
  slot.z = z;
  slot.mesh.visible = true;
  slot.mesh.material.opacity = 1;
  setFrame(slot.map, 0);
  slot.map.needsUpdate = true;
}

function sceneCamera() {
  const fromDom = typeof document !== 'undefined'
    ? document.querySelector('a-scene')?.camera
    : null;
  if (fromDom) return fromDom;
  if (!scene3D) return null;
  return scene3D.getObjectByProperty('type', 'PerspectiveCamera');
}

export function updateExplosionFlipbook(dt) {
  if (!ready || !blasts.length) return;
  const cam = sceneCamera();
  if (cam && _camPos && cam.getWorldPosition) cam.getWorldPosition(_camPos);

  for (let i = 0; i < blasts.length; i++) {
    const b = blasts[i];
    if (!b.active) continue;
    b.life += dt;
    const t = b.life / b.maxLife;
    if (t >= 1) {
      b.active = false;
      b.mesh.visible = false;
      b.mesh.position.set(0, -1000, 0);
      continue;
    }
    const frame = Math.min(FRAMES - 1, Math.floor(t * FRAMES));
    setFrame(b.map, frame);
    const grow = 0.75 + Math.min(t, 0.35) * 0.7;
    const s = b.size * grow;
    const lift = b.y + s * 0.35;
    b.mesh.position.set(b.x, lift, b.z);
    b.mesh.scale.set(s, s, 1);
    if (cam && _camPos) b.mesh.lookAt(_camPos);
    b.mesh.material.opacity = t < 0.82 ? 1 : clamp01(1 - (t - 0.82) / 0.18);
  }
}

export function freezeExplosionFlipbook() {
  for (let i = 0; i < blasts.length; i++) {
    const b = blasts[i];
    b.active = false;
    if (b.mesh) {
      b.mesh.visible = false;
      b.mesh.position.set(0, -1000, 0);
    }
  }
}

export const EXPLOSION_FRAMES = FRAMES;
