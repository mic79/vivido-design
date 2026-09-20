// ========================================
// RTSVR4 — Effects System
// Particle pools for explosions and impacts
// ========================================

import { MAX_PARTICLES } from './config.js';
import { sampleGameplayEntityY } from './moon-environment.js';

let scene3D = null;
const particles = [];
let particleMesh = null;

let _fxColor = null;
let _fxLerpDark = null;
let _mat4 = null;
let _pos = null;
let _quat = null;
let _scale = null;

function ensureFxTemps() {
  const T = typeof window !== 'undefined' ? window.THREE : null;
  if (!T || _fxColor) return !!_fxColor;
  _fxColor = new T.Color();
  _fxLerpDark = new T.Color(0x220000);
  _mat4 = new T.Matrix4();
  _pos = new T.Vector3();
  _quat = new T.Quaternion();
  _scale = new T.Vector3();
  return true;
}

export function initEffects(sceneEl) {
  scene3D = sceneEl.object3D;
  const THREE = window.THREE;
  if (!THREE || !scene3D) return;
  ensureFxTemps();

  // Create particle instanced mesh
  const geometry = new THREE.SphereGeometry(0.15, 4, 3);
  // vertexColors required for InstancedMesh.instanceColor (Quest otherwise draws black/invisible).
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });

  particleMesh = new THREE.InstancedMesh(geometry, material, MAX_PARTICLES);
  particleMesh.count = 0;
  particleMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_PARTICLES * 3), 3
  );
  particleMesh.frustumCulled = false;
  particleMesh.renderOrder = 50;

  // Initialize all hidden
  for (let i = 0; i < MAX_PARTICLES; i++) {
    _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _scale.set(0, 0, 0));
    particleMesh.setMatrixAt(i, _mat4);
  }
  particleMesh.instanceMatrix.needsUpdate = true;

  scene3D.add(particleMesh);
}

/** World Y for FX at (x,z) — never hardcode 0.5 (Hera hills bury sparks under the mesh). */
export function fxWorldY(x, z, lift = 0.55) {
  try {
    return sampleGameplayEntityY(x, z) + lift;
  } catch (_) {
    return lift;
  }
}

/**
 * @param {number} x
 * @param {number} y world Y (pass fxWorldY(x,z) or absolute)
 * @param {number} z
 * @param {number} [count=8]
 */
export function spawnExplosion(x, y, z, count = 8) {
  if (!ensureFxTemps()) return;
  const baseY = Number.isFinite(y) ? y : fxWorldY(x, z);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const speed = 3 + Math.random() * 4;
    const particle = {
      x,
      y: baseY + 0.5,
      z,
      groundY: baseY - 0.2,
      vx: Math.cos(angle) * speed * (0.5 + Math.random()),
      vy: 2 + Math.random() * 3,
      vz: Math.sin(angle) * speed * (0.5 + Math.random()),
      life: 0,
      maxLife: 0.6 + Math.random() * 0.4,
      color: Math.random() < 0.5 ? 0xff6600 : 0xffaa00,
      scale: 0.5 + Math.random() * 0.5,
      index: -1,
      active: true,
    };

    // Find free slot
    let slot = particles.findIndex(p => !p.active);
    if (slot === -1 && particles.length < MAX_PARTICLES) {
      slot = particles.length;
      particles.push(particle);
    } else if (slot === -1) {
      slot = 0; // Overwrite oldest
      particles[slot] = particle;
    } else {
      particles[slot] = particle;
    }
    particles[slot].index = slot;
  }
}

/** Convenience: explosion seated on gameplay terrain at (x,z). */
export function spawnExplosionAt(x, z, count = 8, lift = 0.55) {
  spawnExplosion(x, fxWorldY(x, z, lift), z, count);
}

export function updateEffects(dt) {
  if (!particleMesh || !ensureFxTemps()) return;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (!p || !p.active) {
      // Hide
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _scale.set(0, 0, 0));
      particleMesh.setMatrixAt(i, _mat4);
      continue;
    }

    p.life += dt;
    if (p.life >= p.maxLife) {
      p.active = false;
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _scale.set(0, 0, 0));
      particleMesh.setMatrixAt(i, _mat4);
      continue;
    }

    // Physics
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    p.vy -= 9.8 * dt; // Gravity

    // Fade out
    const t = p.life / p.maxLife;
    const fadeScale = p.scale * (1 - t);
    const floorY = Number.isFinite(p.groundY) ? p.groundY : 0.1;
    const drawY = Math.max(floorY, p.y);

    _mat4.compose(
      _pos.set(p.x, drawY, p.z),
      _quat.identity(),
      _scale.set(fadeScale, fadeScale, fadeScale)
    );
    particleMesh.setMatrixAt(i, _mat4);

    // Color fade to dark
    _fxColor.setHex(p.color);
    _fxColor.lerp(_fxLerpDark, t);
    particleMesh.setColorAt(i, _fxColor);
  }

  let lastActive = -1;
  for (let i = 0; i < particles.length; i++) {
    if (particles[i] && particles[i].active) lastActive = i;
  }
  particleMesh.count = lastActive + 1;
  particleMesh.instanceMatrix.needsUpdate = true;
  if (particleMesh.instanceColor) particleMesh.instanceColor.needsUpdate = true;
}

export function freezeEffects() {
  if (particleMesh) particleMesh.count = 0;
}
