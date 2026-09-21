// ========================================
// RTSVR6 — Combat VFX
// Fewer particles, bigger reads. Additive glow + soft smoke.
// Trajectories are muzzle→shell beams in renderer.js (not here).
// ========================================

import { sampleGameplayEntityY } from './moon-environment.js';
import {
  initExplosionFlipbook,
  spawnBlast,
  updateExplosionFlipbook,
  freezeExplosionFlipbook,
} from './explosion-flipbook.js';

const MAX_GLOW = 280;
const MAX_SOFT = 120;

let scene3D = null;
const glowParticles = [];
const softParticles = [];
let glowMesh = null;
let softMesh = null;

let _fxColor = null;
let _fxLerpDark = null;
let _fxLerpAsh = null;
let _mat4 = null;
let _pos = null;
let _quat = null;
let _scale = null;

function ensureFxTemps() {
  const T = typeof window !== 'undefined' ? window.THREE : null;
  if (!T) return false;
  if (_fxColor) return true;
  _fxColor = new T.Color();
  _fxLerpDark = new T.Color(0xff5a18);
  _fxLerpAsh = new T.Color(0x7a7168);
  _mat4 = new T.Matrix4();
  _pos = new T.Vector3();
  _quat = new T.Quaternion();
  _scale = new T.Vector3();
  return true;
}

function allocIn(pool, max, partial) {
  let slot = pool.findIndex((p) => !p.active);
  if (slot === -1 && pool.length < max) {
    slot = pool.length;
    pool.push(partial);
  } else if (slot === -1) {
    let best = 0;
    let bestLife = -1;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!p || !p.active) continue;
      if (p.life > bestLife) {
        bestLife = p.life;
        best = i;
      }
    }
    slot = best;
    pool[slot] = partial;
  } else {
    pool[slot] = partial;
  }
  pool[slot].index = slot;
  pool[slot].active = true;
  return slot;
}

function hideSlot(mesh, i) {
  _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _scale.set(0, 0, 0));
  mesh.setMatrixAt(i, _mat4);
}

function makePoolMesh(THREE, fire, cap) {
  // Small base so scale stays in real meters, not cartoon balloons.
  const geometry = new THREE.SphereGeometry(fire ? 0.22 : 0.32, 6, 5);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    fog: false,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: fire ? 0.92 : 0.55,
    toneMapped: false,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, cap);
  mesh.count = 0;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  mesh.frustumCulled = false;
  mesh.renderOrder = fire ? 1003 : 1002;
  for (let i = 0; i < cap; i++) {
    hideSlot(mesh, i);
    _fxColor.setHex(0xffffff);
    mesh.setColorAt(i, _fxColor);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return mesh;
}

export function initEffects(sceneEl) {
  scene3D = sceneEl.object3D;
  const THREE = window.THREE;
  if (!THREE || !scene3D) return;
  ensureFxTemps();

  glowMesh = makePoolMesh(THREE, true, MAX_GLOW);
  softMesh = makePoolMesh(THREE, false, MAX_SOFT);
  scene3D.add(glowMesh);
  scene3D.add(softMesh);
  initExplosionFlipbook(sceneEl);
}

export function fxWorldY(x, z, lift = 0.55) {
  try {
    return sampleGameplayEntityY(x, z) + lift;
  } catch (_) {
    return lift;
  }
}

function pushGlow(partial) {
  return allocIn(glowParticles, MAX_GLOW, partial);
}

function pushSoft(partial) {
  return allocIn(softParticles, MAX_SOFT, partial);
}

function spawnFlash(x, y, z, scale, life, color, expand = 4.2) {
  pushGlow({
    role: 'flash',
    x, y, z,
    groundY: y - 0.5,
    vx: 0, vy: 0.15, vz: 0,
    life: 0,
    maxLife: life,
    color,
    scale,
    expand,
    drag: 0,
    gravity: 0,
    index: -1,
    active: true,
  });
}

function spawnRing(x, y, z, scale, life, color, expand = 7) {
  pushGlow({
    role: 'ring',
    x, y: y + 0.12, z,
    groundY: y,
    vx: 0, vy: 0, vz: 0,
    life: 0,
    maxLife: life,
    color,
    scale,
    expand,
    drag: 0,
    gravity: 0,
    index: -1,
    active: true,
  });
}

function spawnSparkBurst(x, y, z, count, speedMin, speedMax, lifeMin, lifeMax, colors, elevBias = 0.3) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const elev = elevBias + (Math.random() - 0.15) * 1.0;
    const speed = speedMin + Math.random() * (speedMax - speedMin);
    const cosE = Math.cos(elev);
    pushGlow({
      role: 'spark',
      x, y, z,
      groundY: y - 0.4,
      vx: Math.cos(angle) * cosE * speed,
      vy: Math.sin(elev) * speed + 2,
      vz: Math.sin(angle) * cosE * speed,
      life: 0,
      maxLife: lifeMin + Math.random() * (lifeMax - lifeMin),
      color: colors[(Math.random() * colors.length) | 0],
      scale: 0.35 + Math.random() * 0.25,
      expand: 0,
      drag: 1.4,
      gravity: 16,
      index: -1,
      active: true,
    });
  }
}

function spawnDebris(x, y, z, count, heavy) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (heavy ? 5 : 3) + Math.random() * (heavy ? 7 : 4);
    const elev = 0.4 + Math.random() * 0.65;
    const cosE = Math.cos(elev);
    pushSoft({
      role: 'debris',
      x, y: y + 0.25, z,
      groundY: y - 0.05,
      vx: Math.cos(angle) * cosE * speed,
      vy: Math.sin(elev) * speed + 2.5,
      vz: Math.sin(angle) * cosE * speed,
      life: 0,
      maxLife: 0.7 + Math.random() * 0.55,
      color: Math.random() < 0.5 ? 0x6a5648 : 0x3a322c,
      scale: (heavy ? 0.28 : 0.18) + Math.random() * 0.12,
      expand: 0,
      drag: 1.0,
      gravity: 20,
      bounce: 0.4,
      index: -1,
      active: true,
    });
  }
}

function spawnSmoke(x, y, z, count, heavy) {
  // Mars dust plume — tan, translucent, rises and thins. Not a fireball.
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spread = (heavy ? 0.6 : 0.3) * Math.random();
    pushSoft({
      role: 'smoke',
      x: x + Math.cos(angle) * spread,
      y: y + 0.15 + Math.random() * 0.2,
      z: z + Math.sin(angle) * spread,
      groundY: y,
      vx: (Math.random() - 0.5) * 1.1,
      vy: 0.8 + Math.random() * (heavy ? 1.6 : 0.9),
      vz: (Math.random() - 0.5) * 1.1,
      life: 0,
      maxLife: (heavy ? 0.85 : 0.5) + Math.random() * 0.35,
      color: Math.random() < 0.5 ? 0xc4b5a4 : 0x9a8d80,
      scale: (heavy ? 1.15 : 0.7) + Math.random() * (heavy ? 0.7 : 0.4),
      expand: 1.15,
      drag: 0.7,
      gravity: -0.35,
      index: -1,
      active: true,
    });
  }
}

/**
 * Layered combat burst. Bigger layers, fewer sparks = better read, similar cost.
 * @param {'burst'|'impact'|'muzzle'|'death'} [kind='burst']
 */
export function spawnExplosion(x, y, z, count = 8, kind = 'burst') {
  if (!ensureFxTemps()) return;
  const baseY = Number.isFinite(y) ? y : fxWorldY(x, z);
  const n = Math.max(1, Math.min(48, count | 0));
  const heavy = kind === 'death' || kind === 'burst' || n >= 12;

  if (kind === 'muzzle') {
    spawnBlast(x, baseY, z, 'muzzle');
    return;
  }

  const blastKind = kind === 'death' ? 'death' : (heavy ? 'heavy' : 'impact');
  spawnBlast(x, baseY, z, blastKind);
  spawnDebris(x, baseY, z, kind === 'death' ? 4 : (heavy ? 3 : 1), heavy || kind === 'death');
}

export function spawnExplosionAt(x, z, count = 8, lift = 0.55, kind = 'burst') {
  spawnExplosion(x, fxWorldY(x, z, lift), z, count, kind);
}

export function spawnMuzzleFlash(x, y, z, dx = 0, dz = 1) {
  if (!ensureFxTemps()) return;
  void dx;
  void dz;
  spawnBlast(x, y, z, 'muzzle');
}

export function spawnImpact(x, y, z, heavy = false) {
  spawnExplosion(x, y, z, heavy ? 16 : 8, 'impact');
}

export function spawnTracerWisp(x, y, z, colorHex, heavy = false) {
  if (!ensureFxTemps()) return;
  pushGlow({
    role: 'ember',
    x, y, z,
    groundY: y - 1,
    vx: (Math.random() - 0.5) * 0.9,
    vy: (Math.random() - 0.5) * 0.7,
    vz: (Math.random() - 0.5) * 0.9,
    life: 0,
    maxLife: heavy ? 0.28 : 0.16,
    color: colorHex,
    scale: heavy ? 0.55 : 0.35,
    expand: -0.35,
    drag: 2.8,
    gravity: 2,
    index: -1,
    active: true,
  });
}

function updatePool(pool, mesh, dt, additiveFade) {
  if (!mesh) return;
  let lastActive = -1;

  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p || !p.active) {
      hideSlot(mesh, i);
      continue;
    }

    p.life += dt;
    if (p.life >= p.maxLife) {
      p.active = false;
      hideSlot(mesh, i);
      continue;
    }

    const t = p.life / p.maxLife;
    const drag = Math.exp(-(p.drag || 0) * dt);
    p.vx *= drag;
    p.vz *= drag;
    p.vy -= (p.gravity != null ? p.gravity : 11) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;

    if (p.bounce && p.y < p.groundY) {
      p.y = p.groundY;
      p.vy = Math.abs(p.vy) * p.bounce;
      p.vx *= 0.7;
      p.vz *= 0.7;
    }

    const expand = p.expand || 0;
    let sx;
    let sy;
    let sz;
    if (p.role === 'ring') {
      const r = p.scale * (0.4 + t * expand);
      sx = r;
      sy = 0.08;
      sz = r;
    } else if (p.role === 'flash') {
      const s = p.scale * (0.5 + t * expand) * (1 - t * t);
      sx = sy = sz = s;
    } else if (p.role === 'smoke') {
      const s = p.scale * (1 + t * expand) * (1 - t * 0.5);
      sx = sy = sz = s;
    } else if (p.role === 'ember') {
      const s = p.scale * Math.max(0.2, 1 + t * expand) * (1 - t);
      sx = sy = sz = s;
    } else {
      const s = p.scale * (1 - t * t);
      sx = sy = sz = s;
    }

    const floorY = Number.isFinite(p.groundY) ? p.groundY : 0.05;
    const drawY = p.role === 'ring' || p.role === 'flash' ? p.y : Math.max(floorY, p.y);

    _mat4.compose(_pos.set(p.x, drawY, p.z), _quat.identity(), _scale.set(sx, sy, sz));
    mesh.setMatrixAt(i, _mat4);

    _fxColor.setHex(p.color);
    if (additiveFade) {
      _fxColor.lerp(_fxLerpDark, t * (p.role === 'flash' ? 0.65 : 0.8));
    } else {
      _fxColor.lerp(_fxLerpAsh, t * 0.45);
    }
    mesh.setColorAt(i, _fxColor);
    lastActive = i;
  }

  mesh.count = lastActive + 1;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

export function updateEffects(dt) {
  if (!glowMesh || !ensureFxTemps()) return;
  updatePool(glowParticles, glowMesh, dt, true);
  updatePool(softParticles, softMesh, dt, false);
  updateExplosionFlipbook(dt);
}

export function freezeEffects() {
  if (glowMesh) glowMesh.count = 0;
  if (softMesh) softMesh.count = 0;
  for (let i = 0; i < glowParticles.length; i++) {
    if (glowParticles[i]) glowParticles[i].active = false;
  }
  for (let i = 0; i < softParticles.length; i++) {
    if (softParticles[i]) softParticles[i].active = false;
  }
  freezeExplosionFlipbook();
}
