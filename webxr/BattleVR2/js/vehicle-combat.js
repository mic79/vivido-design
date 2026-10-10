/**
 * Cockpit fighter weapons — yaw from chassis; pitch from look / virtual stick.
 *   Flatscreen: mouse look pitch (screen crosshair).
 *   VR: grabbed flight-stick fwd/back (push toward canopy = aim down);
 *       yaw stays vehicle-locked (headset / thumbstick do not aim guns).
 * Default: pulse/plasma. Optional grenade: ?weapon=grenade or #grenade.
 */
import * as State from './rts/state.js';
import * as Units from './rts/units.js';
import * as Renderer from './rts/renderer.js';
import * as Bridge from './rts-bridge.js';
import * as Vehicle from './vehicle.js';
import * as Cockpit from './cockpit.js';
import { BUILDING_SHAPES, UNIT_SHAPES } from './rts/config.js';
import * as Audio from './rts/audio.js';
import * as Effects from './rts/effects.js';
import { sampleGameplayEntityY } from './rts/moon-environment.js';
import * as TerrainBvh from './terrain-bvh.js';

/** Fallback if camera missing — slight nose-down for skim shots. */
const AIM_PITCH_FALLBACK = 0.06;
const AIM_PITCH_MIN = -1.15;
const AIM_PITCH_MAX = 1.05;

/** @type {import('three').Vector3 | null} */
let _aimEye = null;
/** @type {import('three').Vector3 | null} */
let _aimFwd = null;

function isXrPresenting() {
  try {
    const xr = document.querySelector('a-scene')?.renderer?.xr;
    if (xr?.isPresenting) return true;
  } catch (_) { /* */ }
  return false;
}

/**
 * The THREE.Camera that actually draws the frame — same ray as screen-center HUD.
 * (A-Frame `#camera`.object3D is only a Group; the PerspectiveCamera is a child.)
 */
function getRenderCamera() {
  const camEl = document.getElementById('camera');
  try {
    const nested = camEl?.getObject3D?.('camera');
    if (nested?.isCamera || nested?.isPerspectiveCamera) return nested;
  } catch (_) { /* */ }
  try {
    const sceneCam = document.querySelector('a-scene')?.camera;
    if (sceneCam?.isCamera || sceneCam?.isPerspectiveCamera) return sceneCam;
  } catch (_) { /* */ }
  return camEl?.object3D || null;
}

/**
 * VR: virtual flight-stick fwd/back (from cockpit grab) → gun pitch.
 * Published by cockpit.js as __BATTLEVR2_STICK_AIM_PITCH__ (rad).
 */
function getVrVirtualStickAimPitch() {
  const p = window.__BATTLEVR2_STICK_AIM_PITCH__;
  if (!Number.isFinite(p)) return AIM_PITCH_FALLBACK * 0.35;
  return Math.max(AIM_PITCH_MIN, Math.min(AIM_PITCH_MAX, p));
}

const WEAPONS = {
  plasma: {
    id: 'plasma',
    label: 'Pulse plasma',
    cooldown: 0.11,
    damage: 11,
    range: 72,
    /** ms per meter — low = fast bolt */
    travelMsPerM: 6,
    minDuration: 40,
    maxDuration: 220,
    color: 0x66f0ff,
    heavy: false,
    flat: true,
    sound: 'scoutBike',
  },
  /** Former default slow yellow bolt — kept as optional. */
  grenade: {
    id: 'grenade',
    label: 'Grenade launcher',
    cooldown: 0.42,
    damage: 22,
    range: 48,
    travelMsPerM: 42,
    minDuration: 280,
    maxDuration: 700,
    color: 0xffb020,
    heavy: true,
    flat: false,
    sound: 'artillery',
  },
};

function resolveWeaponId() {
  try {
    const q = `${location.search || ''}${location.hash || ''}`;
    if (/(?:[?&#]weapon=grenade\b)|(?:[?&#]grenade\b)/i.test(q)) return 'grenade';
    if (/(?:[?&#]weapon=plasma\b)|(?:[?&#]plasma\b)/i.test(q)) return 'plasma';
  } catch (_) { /* */ }
  return 'plasma';
}

let weapon = WEAPONS[resolveWeaponId()] || WEAPONS.plasma;
let cooldown = 0;
let hudCrosshair = null;
let worldReticle = null;
let worldReticleDepthFixed = false;
const RETICLE_DIST = 28;

export function getFighterWeapon() {
  return weapon;
}

export function setFighterWeapon(id) {
  if (WEAPONS[id]) weapon = WEAPONS[id];
  return weapon;
}

function ensureHudCrosshair() {
  if (hudCrosshair) return hudCrosshair;
  const el = document.createElement('div');
  el.id = 'fighter-crosshair';
  el.setAttribute('aria-hidden', 'true');
  // Desktop/2D: above all page UI. VR uses the world reticle (depthTest off).
  el.style.cssText = [
    'position:fixed',
    'left:50%',
    'top:50%',
    'width:26px',
    'height:26px',
    'margin:-13px 0 0 -13px',
    'pointer-events:none',
    'z-index:2147483000',
    'display:none',
    'opacity:0.85',
    'mix-blend-mode:screen',
  ].join(';');
  el.innerHTML = `
    <svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">
      <circle cx="13" cy="13" r="9" fill="none" stroke="#7af6ff" stroke-width="1.4" opacity="0.85"/>
      <circle cx="13" cy="13" r="1.6" fill="#e8fbff"/>
      <path d="M13 2v3.2M13 20.8V24M2 13h3.2M20.8 13H24" stroke="#7af6ff" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;
  document.body.appendChild(el);
  hudCrosshair = el;
  return el;
}

/** World reticle that draws on top of terrain/units (no depth test). Needed in XR. */
function ensureWorldReticle() {
  if (worldReticle) return worldReticle;
  const scene = document.querySelector('a-scene');
  if (!scene) return null;
  const el = document.createElement('a-entity');
  el.setAttribute('id', 'fighter-world-reticle');
  el.setAttribute(
    'geometry',
    'primitive: ring; radiusInner: 0.12; radiusOuter: 0.18; segmentsTheta: 48'
  );
  el.setAttribute(
    'material',
    'color: #7af6ff; opacity: 0.92; transparent: true; shader: flat; side: double; depthTest: false; depthWrite: false'
  );
  el.setAttribute('render-order', '9999');
  // Dot
  const dot = document.createElement('a-entity');
  dot.setAttribute('geometry', 'primitive: circle; radius: 0.035; segments: 24');
  dot.setAttribute(
    'material',
    'color: #e8fbff; opacity: 0.95; transparent: true; shader: flat; side: double; depthTest: false; depthWrite: false'
  );
  el.appendChild(dot);
  // Cross ticks
  for (const [dx, dy] of [[0, 0.28], [0, -0.28], [0.28, 0], [-0.28, 0]]) {
    const tick = document.createElement('a-entity');
    tick.setAttribute('position', `${dx} ${dy} 0`);
    tick.setAttribute('geometry', 'primitive: plane; width: 0.04; height: 0.1');
    if (Math.abs(dx) > 0) tick.setAttribute('geometry', 'primitive: plane; width: 0.1; height: 0.04');
    tick.setAttribute(
      'material',
      'color: #7af6ff; opacity: 0.9; transparent: true; shader: flat; side: double; depthTest: false; depthWrite: false'
    );
    el.appendChild(tick);
  }
  el.object3D.visible = false;
  scene.appendChild(el);
  worldReticle = el;
  const harden = () => {
    worldReticleDepthFixed = false;
    hardenReticleDepth(el);
  };
  el.addEventListener('loaded', harden);
  // Materials may appear a frame later under A-Frame.
  setTimeout(harden, 0);
  setTimeout(harden, 100);
  return el;
}

function hardenReticleDepth(el) {
  if (!el?.object3D) return;
  let foundMat = false;
  el.object3D.traverse((o) => {
    o.renderOrder = 10000;
    o.frustumCulled = false;
    if (o.material) {
      foundMat = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        m.depthTest = false;
        m.depthWrite = false;
        m.transparent = true;
        m.needsUpdate = true;
      }
    }
  });
  if (foundMat) worldReticleDepthFixed = true;
}

function updateWorldReticle(ray, visible) {
  const el = ensureWorldReticle();
  if (!el?.object3D) return;
  hardenReticleDepth(el);
  el.object3D.visible = !!visible;
  if (!visible || !ray) return;
  const o = ray.lookOrigin || ray.origin;
  const d = ray.lookDirection || ray.direction;
  const x = o.x + d.x * RETICLE_DIST;
  const y = o.y + d.y * RETICLE_DIST;
  const z = o.z + d.z * RETICLE_DIST;
  el.object3D.position.set(x, y, z);
  el.object3D.lookAt(o.x, o.y, o.z);
}

export function setFighterCrosshairVisible(on) {
  ensureHudCrosshair().style.display = on ? 'block' : 'none';
  if (!on) updateWorldReticle(null, false);
}

function entityGroundY(ent) {
  const gy = sampleGameplayEntityY(ent.x, ent.z);
  return Number.isFinite(gy) ? gy : Bridge.sampleGroundY(ent.x, ent.z, 0);
}

function entityPickCenterY(ent) {
  const gY = entityGroundY(ent);
  if (ent.category === 'vehicle') {
    const h = UNIT_SHAPES[ent.type]?.height || 1.2;
    return gY + h * 0.55;
  }
  if (ent.category === 'infantry') {
    const h = UNIT_SHAPES[ent.type]?.height || 1.8;
    return gY + h * 0.5;
  }
  const shape = BUILDING_SHAPES[ent.type];
  const h = shape?.height || 3;
  return gY + h * 0.55;
}

function entityPickRadius(ent) {
  if (ent.category === 'vehicle') {
    const s = UNIT_SHAPES[ent.type];
    return s ? Math.max(s.width || 1, s.depth || 1) * 0.55 : 1.8;
  }
  if (ent.category === 'infantry') {
    const s = UNIT_SHAPES[ent.type];
    return s?.type === 'cylinder'
      ? Math.max(s.radiusBottom || 0.4, s.radiusTop || 0.4) + 0.35
      : 0.9;
  }
  const s = BUILDING_SHAPES[ent.type];
  return s ? Math.max(s.width, s.depth) * 0.5 : 3;
}

/**
 * Crosshair ray = from the render camera (screen center).
 * Projectile still spawns at the gun muzzle, aimed at the point under the crosshair
 * (muzzle-parallel shots miss the sight picture — classic gun/camera offset bug).
 */
function vehicleAimRay() {
  const pose = Vehicle.getVehiclePose();
  const yaw = pose.yaw;
  const muzzle = Vehicle.getMuzzleWorldPos();
  const THREE = window.THREE;
  const cam = getRenderCamera();

  let lookOrigin = { x: muzzle.x, y: muzzle.y, z: muzzle.z };
  let lookDir = { x: -Math.sin(yaw), y: -AIM_PITCH_FALLBACK, z: -Math.cos(yaw) };
  let pitch = AIM_PITCH_FALLBACK;

  if (!isXrPresenting() && cam?.getWorldDirection && THREE?.Vector3) {
    if (!_aimEye) _aimEye = new THREE.Vector3();
    if (!_aimFwd) _aimFwd = new THREE.Vector3();
    cam.updateWorldMatrix?.(true, false);
    cam.getWorldPosition(_aimEye);
    cam.getWorldDirection(_aimFwd);
    const len = _aimFwd.length() || 1;
    lookOrigin = { x: _aimEye.x, y: _aimEye.y, z: _aimEye.z };
    lookDir = { x: _aimFwd.x / len, y: _aimFwd.y / len, z: _aimFwd.z / len };
    pitch = Math.asin(Math.max(-1, Math.min(1, lookDir.y)));
  } else {
    pitch = getVrVirtualStickAimPitch();
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    lookDir = { x: fwdX * cosP, y: sinP, z: fwdZ * cosP };
    const len = Math.hypot(lookDir.x, lookDir.y, lookDir.z) || 1;
    lookDir.x /= len;
    lookDir.y /= len;
    lookDir.z /= len;
    // Eye ≈ seat/camera; fall back to muzzle if no cam.
    if (cam?.getWorldPosition && THREE?.Vector3) {
      if (!_aimEye) _aimEye = new THREE.Vector3();
      cam.updateWorldMatrix?.(true, false);
      cam.getWorldPosition(_aimEye);
      lookOrigin = { x: _aimEye.x, y: _aimEye.y, z: _aimEye.z };
    }
  }

  return {
    /** @deprecated use muzzle — kept so older call sites keep working */
    origin: muzzle,
    muzzle,
    lookOrigin,
    lookDirection: lookDir,
    /** Muzzle → default far aim point (overwritten after hit tests). */
    direction: lookDir,
    yaw,
    pitch,
    pose,
  };
}

function pickEnemyAlongRay(origin, direction, maxDist, myTeam, myId) {
  let best = null;
  let bestT = maxDist;
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;
  const dx = direction.x;
  const dy = direction.y;
  const dz = direction.z;

  const consider = (ent) => {
    if (!ent || ent.hp <= 0 || ent.fpHero) return;
    if (ent.team === myTeam || ent.ownerId === myId) return;
    const cx = ent.x;
    const cy = entityPickCenterY(ent);
    const cz = ent.z;
    const radius = entityPickRadius(ent);
    const ocx = cx - ox;
    const ocy = cy - oy;
    const ocz = cz - oz;
    const b = ocx * dx + ocy * dy + ocz * dz;
    if (b < 0.5 || b > bestT) return;
    const closestX = ox + dx * b;
    const closestY = oy + dy * b;
    const closestZ = oz + dz * b;
    const miss = Math.hypot(cx - closestX, cy - closestY, cz - closestZ);
    if (miss > radius) return;
    bestT = b;
    best = { ent, t: b, hitY: cy };
  };

  State.units.forEach(consider);
  State.buildings.forEach(consider);
  return best;
}

/** First ground contact along the aim ray (BVH preferred, height sample fallback). */
function pickGroundAlongRay(origin, direction, maxDist) {
  const steps = 28;
  let prevAbove = true;
  let prevX = origin.x;
  let prevY = origin.y;
  let prevZ = origin.z;
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * maxDist;
    const x = origin.x + direction.x * t;
    const y = origin.y + direction.y * t;
    const z = origin.z + direction.z * t;
    let gy = NaN;
    if (TerrainBvh.isTerrainBvhReady()) {
      const hit = TerrainBvh.sampleTerrainBvhY(x, z, y);
      if (Number.isFinite(hit)) gy = hit;
    }
    if (!Number.isFinite(gy)) {
      const h = sampleGameplayEntityY(x, z);
      gy = Number.isFinite(h) ? h : Bridge.sampleGroundY(x, z, NaN);
    }
    const above = !Number.isFinite(gy) || y >= gy - 0.05;
    if (prevAbove && !above) {
      const y0 = prevY;
      const g0 = Number.isFinite(sampleGameplayEntityY(prevX, prevZ))
        ? sampleGameplayEntityY(prevX, prevZ)
        : gy;
      const y1 = y;
      const g1 = gy;
      const denom = y0 - g0 - (y1 - g1);
      const u = Math.abs(denom) > 1e-6 ? (y0 - g0) / denom : 0.5;
      const uu = Math.max(0, Math.min(1, u));
      return {
        x: prevX + (x - prevX) * uu,
        y: g1 + 0.08,
        z: prevZ + (z - prevZ) * uu,
        t: t * uu + ((i - 1) / steps) * maxDist * (1 - uu),
      };
    }
    prevAbove = above;
    prevX = x;
    prevY = y;
    prevZ = z;
    if (!above && i === 1) {
      return { x, y: gy + 0.08, z, t };
    }
  }
  return null;
}

function spawnFighterBolt(from, to, wpn, onHit) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const duration = Math.min(
    wpn.maxDuration,
    Math.max(wpn.minDuration, dist * wpn.travelMsPerM)
  );
  Renderer.spawnProjectile(
    from.x,
    from.y,
    from.z,
    to.x,
    to.y,
    to.z,
    wpn.color,
    duration,
    onHit || null,
    !!wpn.heavy,
    !!wpn.flat
  );
}

function fireOnce(ray, hero) {
  const wpn = weapon;
  const lookO = ray.lookOrigin || ray.origin;
  const lookD = ray.lookDirection || ray.direction;
  const muzzle = ray.muzzle || ray.origin;

  // Hit-test along the crosshair/camera ray (what you see), not the gun bore.
  const enemy = pickEnemyAlongRay(lookO, lookD, wpn.range, hero.team, hero.ownerId);
  const ground = pickGroundAlongRay(lookO, lookD, wpn.range);

  let end = {
    x: lookO.x + lookD.x * wpn.range,
    y: lookO.y + lookD.y * wpn.range,
    z: lookO.z + lookD.z * wpn.range,
  };
  let onHit = null;

  const enemyT = enemy?.t ?? Infinity;
  const groundT = ground?.t ?? Infinity;

  if (enemy && enemyT <= groundT) {
    const tgt = enemy.ent;
    let dmg = wpn.damage;
    if (tgt.category === 'infantry') dmg *= hero.dmgVsInfantry || 1;
    else if (tgt.category === 'vehicle') dmg *= hero.dmgVsVehicle || 1;
    else if (tgt.type && !tgt.category) dmg *= hero.dmgVsBuilding || 1;
    const finalDmg = Math.max(1, Math.round(dmg));
    end = { x: tgt.x, y: enemy.hitY, z: tgt.z };
    onHit = () => {
      const live = State.units.get(tgt.id) || State.buildings.get(tgt.id);
      if (
        live &&
        live.hp > 0 &&
        live.team !== hero.team &&
        live.ownerId !== hero.ownerId
      ) {
        Units.applyDamage(live, finalDmg, hero);
      }
    };
  } else if (ground) {
    end = { x: ground.x, y: ground.y, z: ground.z };
    onHit = () => {
      try {
        Effects.spawnImpact(ground.x, ground.y, ground.z, !!wpn.heavy);
      } catch (_) { /* */ }
    };
  }

  cooldown = wpn.cooldown;
  // Tracer leaves the barrel but converges on the crosshair aim point.
  spawnFighterBolt(muzzle, end, wpn, onHit);
  try {
    Audio.playShotSound(wpn.sound, muzzle.x, muzzle.z);
  } catch (_) { /* */ }
  try {
    Effects.spawnMuzzleFlash(
      muzzle.x,
      muzzle.y,
      muzzle.z,
      end.x - muzzle.x,
      end.z - muzzle.z
    );
  } catch (_) { /* */ }
}

/**
 * @param {number} dt
 * @param {{ fireWanted?: boolean, joyHand?: string|null, requireStick?: boolean }} opts
 */
export function stepFighterCombat(dt, opts = {}) {
  cooldown = Math.max(0, cooldown - dt);
  const boarded = !!window.__BATTLEVR2_BOARDED__ && Cockpit.isCockpitActive();
  setFighterCrosshairVisible(boarded);
  if (!boarded) {
    updateWorldReticle(null, false);
    return;
  }

  const ray = vehicleAimRay();
  // World reticle is VR-only — on flatscreen it was a second, often-wrong, floating sight.
  // PC uses the large screen-center HUD, which matches camera forward / shot direction.
  updateWorldReticle(ray, isXrPresenting());

  const fireWanted = !!opts.fireWanted || !!window.__BATTLEVR2_FIGHTER_FIRE__;
  window.__BATTLEVR2_FIGHTER_FIRE__ = false;
  if (!fireWanted || cooldown > 0) return;
  if (!opts.joyHand && opts.requireStick) return;

  const heroId = Bridge.getHeroUnitId();
  const hero = heroId != null ? State.units.get(heroId) : null;
  if (!hero) return;
  if (hero.hp <= 0) hero.hp = hero.maxHp || 100;

  fireOnce(ray, hero);
}
