/**
 * BattleVR zerog physics — ONE integrator for on-foot AND vehicle.
 * Vehicle differs only by floor band + higher max speed; same G/damp/forces/contact.
 * Ground contact prefers full-map terrain BVH (nearby ray) over height-grid samples.
 */
import * as Box3D from './box3d-world.js';
import { sampleGroundY } from './rts-bridge.js';
import * as TerrainBvh from './terrain-bvh.js';

/** BattleVR zerog-player schema defaults */
export const THRUSTER_FORCE = 0.8;
export const MAX_SPEED_PLAYER = 8;
/** Faster than on-foot; same force model. */
export const MAX_SPEED_VEHICLE = 20;
export const DAMPING = 0.996;
export const MOON_G = -1.62;
export const SPEED_BOOST_FORCE = 5;
/**
 * On-foot phys Y = FEET on the terrain. View height is FIXED_EYE_HEIGHT_M above that
 * (cockpit-style: standing or seated IRL both look from the same virtual eye).
 */
export const FLOOR_BAND_PLAYER = 0;
/**
 * Fixed virtual eye above feet (cockpit-style lock — IRL sit/stand does not change it).
 * ~Mixamo model eye / standing height so the FP camera sits in the head socket, not the neck.
 */
export const FIXED_EYE_HEIGHT_M = 1.62;
/** @deprecated use FIXED_EYE_HEIGHT_M */
export const DESKTOP_EYE_HEIGHT_M = FIXED_EYE_HEIGHT_M;

if (typeof window !== 'undefined') {
  window.__BATTLEVR2_FIXED_EYE_M = FIXED_EYE_HEIGHT_M;
}
/** Fighter skims low — not a 2 m hover sled. */
export const FLOOR_BAND_VEHICLE = 0.42;
/** @deprecated use FLOOR_BAND_PLAYER — kept for exit spawn helpers */
export const FLOOR_BAND = FLOOR_BAND_PLAYER;

/** Desktop/surge force multiplier (matches zerog-loco surge = THRUSTER_FORCE * 2). */
export const SURGE_FORCE_PLAYER = THRUSTER_FORCE * 2;
/** Lever full-forward ≈ dual thruster authority, clearly faster than on foot. */
export const SURGE_FORCE_VEHICLE = THRUSTER_FORCE * 8;

const SLOPE_E = 1.0;
const NORMAL_VEL_KILL = 1.0;
/** Into-ground speed (m/s) above this = hard land (bounce + slam). */
const HARD_LAND_VN = -2.2;
const RESTITUTION_SOFT = 0.02;
const RESTITUTION_HARD = 0.28;

let vel = { x: 0, y: 0, z: 0 };
let pos = { x: 0, y: 0, z: 0 };
let yaw = 0;
/** 'player' | 'vehicle' */
let mover = 'player';
/** Peak into-ground impact this step (0 = none). */
let lastImpact = 0;
let airborne = false;

export function getPhysPose() {
  return { x: pos.x, y: pos.y, z: pos.z, yaw };
}

export function getPhysVelocity() {
  return { ...vel };
}

export function getPhysYaw() {
  return yaw;
}

export function setPhysYaw(y) {
  yaw = y;
}

export function setPhysMover(mode) {
  mover = mode === 'vehicle' ? 'vehicle' : 'player';
}

export function getPhysMover() {
  return mover;
}

export function getFloorBand() {
  return mover === 'vehicle' ? FLOOR_BAND_VEHICLE : FLOOR_BAND_PLAYER;
}

export function getMaxSpeed() {
  return mover === 'vehicle' ? MAX_SPEED_VEHICLE : MAX_SPEED_PLAYER;
}

/** Into-ground impact speed from last stepPhys (for slam VFX). */
export function getLastImpact() {
  return lastImpact;
}

export function isAirborne() {
  return airborne;
}

export function resetPhysAt(x, y, z, yawRad = 0) {
  pos = { x, y, z };
  vel = { x: 0, y: 0, z: 0 };
  yaw = yawRad;
  airborne = false;
  lastImpact = 0;
  if (mover === 'vehicle') {
    Box3D.teleportVehicleCollider(x, y, z);
  } else {
    Box3D.spawnPlayerAt(x, y, z);
  }
}

export function teleportPhys(x, y, z, yawRad) {
  adoptPhysPose(x, y ?? pos.y, z, yawRad, { keepVel: false });
}

export function adoptPhysPose(x, y, z, yawRad = null, opts = {}) {
  pos.x = x;
  pos.y = y;
  pos.z = z;
  if (yawRad != null) yaw = yawRad;
  if (!opts.keepVel) vel = { x: 0, y: 0, z: 0 };
  airborne = false;
  lastImpact = 0;
  if (mover === 'vehicle') Box3D.teleportVehicleCollider(pos.x, pos.y, pos.z);
  else Box3D.setPlayerPosition(pos.x, pos.y, pos.z);
}

export function setPhysVelocity(vx, vy, vz) {
  vel.x = vx || 0;
  vel.y = vy || 0;
  vel.z = vz || 0;
}

export function snapshotPhys() {
  return {
    pos: { x: pos.x, y: pos.y, z: pos.z },
    vel: { x: vel.x, y: vel.y, z: vel.z },
    yaw,
    airborne,
    lastImpact,
    mover,
  };
}

export function restorePhys(snap) {
  if (!snap) return;
  pos.x = snap.pos.x;
  pos.y = snap.pos.y;
  pos.z = snap.pos.z;
  vel.x = snap.vel.x;
  vel.y = snap.vel.y;
  vel.z = snap.vel.z;
  yaw = snap.yaw;
  airborne = !!snap.airborne;
  lastImpact = snap.lastImpact || 0;
  mover = snap.mover === 'vehicle' ? 'vehicle' : 'player';
  if (mover === 'vehicle') Box3D.teleportVehicleCollider(pos.x, pos.y, pos.z);
  else Box3D.setPlayerPosition(pos.x, pos.y, pos.z);
}

export function addPhysImpulse(ix, iy, iz) {
  vel.x += ix;
  vel.y += iy;
  vel.z += iz;
}

export function addPhysForce(fx, fy, fz, dt) {
  vel.x += fx * dt;
  vel.y += fy * dt;
  vel.z += fz * dt;
}

/** Same surge as on-foot stick; amount ∈ [-1,1], force defaults by mover. */
export function addPhysSurge(amount, dt, force = null) {
  const a = Math.max(-1, Math.min(1, amount));
  if (Math.abs(a) < 0.02) return;
  const f = force != null ? force : mover === 'vehicle' ? SURGE_FORCE_VEHICLE : SURGE_FORCE_PLAYER;
  const fwdX = -Math.sin(yaw);
  const fwdZ = -Math.cos(yaw);
  addPhysForce(fwdX * a * f, 0, fwdZ * a * f, dt);
}

export function addPhysYaw(rate, dt) {
  yaw += rate * dt;
}

function clampSpeed() {
  const max = getMaxSpeed();
  const sp = Math.hypot(vel.x, vel.y, vel.z);
  if (sp > max) {
    const s = max / sp;
    vel.x *= s;
    vel.y *= s;
    vel.z *= s;
  }
}

function sampleHeightfield(x, z) {
  // Primary: BVH ray on plate + horizon skirts (works across the whole drawn surface).
  if (TerrainBvh.isTerrainBvhReady()) {
    const hit = TerrainBvh.sampleTerrainBvhHit(x, z, pos.y);
    if (hit && Number.isFinite(hit.y)) {
      return { gy: hit.y, nx: hit.nx, ny: hit.ny, nz: hit.nz };
    }
    // Far miss — try a higher probe once (still nearby band via far=160).
    const hit2 = TerrainBvh.sampleTerrainBvhHit(x, z, null);
    if (hit2 && Number.isFinite(hit2.y)) {
      return { gy: hit2.y, nx: hit2.nx, ny: hit2.ny, nz: hit2.nz };
    }
  }

  // Fallback: analytic / height-grid sampler (pre-BVH or lobby).
  const gy = sampleGroundY(x, z, NaN);
  const gx1 = sampleGroundY(x + SLOPE_E, z, NaN);
  const gx0 = sampleGroundY(x - SLOPE_E, z, NaN);
  const gz1 = sampleGroundY(x, z + SLOPE_E, NaN);
  const gz0 = sampleGroundY(x, z - SLOPE_E, NaN);
  let nx = 0;
  let ny = 1;
  let nz = 0;
  if (
    Number.isFinite(gy) &&
    Number.isFinite(gx1) &&
    Number.isFinite(gx0) &&
    Number.isFinite(gz1) &&
    Number.isFinite(gz0)
  ) {
    const dydx = (gx1 - gx0) / (2 * SLOPE_E);
    const dydz = (gz1 - gz0) / (2 * SLOPE_E);
    nx = -dydx;
    ny = 1;
    nz = -dydz;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
  }
  return { gy: Number.isFinite(gy) ? gy : NaN, nx, ny, nz };
}

/**
 * Terrain contact — identical for player and vehicle (band height is the only difference).
 * Airborne when above floor band — ramp crests with upward tangent → ballistic flight.
 */
function resolveTerrain() {
  lastImpact = 0;
  const hf = sampleHeightfield(pos.x, pos.z);
  if (!Number.isFinite(hf.gy)) {
    airborne = true;
    return;
  }
  const floorY = hf.gy + getFloorBand();
  const clearance = pos.y - floorY;

  if (clearance > 0.04) {
    airborne = true;
    return;
  }

  airborne = false;

  const vn = vel.x * hf.nx + vel.y * hf.ny + vel.z * hf.nz;
  const hard = vn <= HARD_LAND_VN;

  if (clearance < 0) {
    if (hard && mover === 'vehicle') {
      const dig = Math.min(0.28, (-vn - 2.2) * 0.08);
      pos.y = Math.max(hf.gy + 0.08, floorY - dig);
    } else {
      pos.y = floorY;
    }
  }

  if (vn < 0) {
    const impact = -vn;
    lastImpact = impact;
    const rest = hard ? RESTITUTION_HARD : RESTITUTION_SOFT;

    vel.x -= hf.nx * vn * NORMAL_VEL_KILL;
    vel.y -= hf.ny * vn * NORMAL_VEL_KILL;
    vel.z -= hf.nz * vn * NORMAL_VEL_KILL;

    if (rest > 0 && impact > 0.15) {
      vel.x += hf.nx * impact * rest;
      vel.y += hf.ny * impact * rest;
      vel.z += hf.nz * impact * rest;
    }
  }

  if (mover === 'vehicle') Box3D.teleportVehicleCollider(pos.x, pos.y, pos.z);
  else Box3D.setPlayerPosition(pos.x, pos.y, pos.z);
}

/**
 * Same integration for both movers. Vehicle no longer uses a separate chassis capsule
 * (that path scraped the ground mesh and killed forward speed while yaw still worked).
 */
function integrateMover(dt) {
  const dx = vel.x * dt;
  const dy = vel.y * dt;
  const dz = vel.z * dt;

  if (mover === 'vehicle') {
    pos.x += dx;
    pos.y += dy;
    pos.z += dz;
    Box3D.teleportVehicleCollider(pos.x, pos.y, pos.z);
    return;
  }

  const phys = Box3D.getPhysics();
  if (phys?.movePlayer) {
    const moved = phys.movePlayer({ x: dx, y: dy, z: dz }, {});
    const p = moved?.position || Box3D.getPlayerPosition();
    pos.x = p.x;
    pos.y = p.y;
    pos.z = p.z;
  } else {
    pos.x += dx;
    pos.y += dy;
    pos.z += dz;
    Box3D.setPlayerPosition(pos.x, pos.y, pos.z);
  }
}

export function stepPhys(dt) {
  vel.y += MOON_G * dt;

  const damp = Math.pow(DAMPING, dt * 60);
  vel.x *= damp;
  vel.y *= damp;
  vel.z *= damp;
  clampSpeed();

  integrateMover(dt);
  resolveTerrain();

  if (typeof Box3D.getPhysics()?.step === 'function') {
    Box3D.getPhysics().step(dt);
  }

  return getPhysPose();
}
