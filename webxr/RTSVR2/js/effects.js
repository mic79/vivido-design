// ========================================
// RTSVR2 — Effects System
// Particle pools for explosions and impacts
// ========================================

import { MAX_PARTICLES } from './config.js';

let scene3D = null;
const particles = [];
let particleMesh = null;

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

export function initEffects(sceneEl) {
  scene3D = sceneEl.object3D;

  // Create particle instanced mesh
  const geometry = new THREE.SphereGeometry(0.15, 4, 3);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });

  particleMesh = new THREE.InstancedMesh(geometry, material, MAX_PARTICLES);
  particleMesh.count = MAX_PARTICLES;
  particleMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_PARTICLES * 3), 3
  );
  particleMesh.frustumCulled = false;

  // Initialize all hidden
  for (let i = 0; i < MAX_PARTICLES; i++) {
    _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _scale.set(0, 0, 0));
    particleMesh.setMatrixAt(i, _mat4);
  }
  particleMesh.instanceMatrix.needsUpdate = true;

  scene3D.add(particleMesh);
}

export function spawnExplosion(x, y, z, count = 8) {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const speed = 3 + Math.random() * 4;
    const particle = {
      x, y: y + 0.5, z,
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

export function updateEffects(dt) {
  if (!particleMesh) return;

  const _color = new THREE.Color();

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

    _mat4.compose(
      _pos.set(p.x, Math.max(0.1, p.y), p.z),
      _quat.identity(),
      _scale.set(fadeScale, fadeScale, fadeScale)
    );
    particleMesh.setMatrixAt(i, _mat4);

    // Color fade to dark
    _color.setHex(p.color);
    _color.lerp(new THREE.Color(0x220000), t);
    particleMesh.setColorAt(i, _color);
  }

  particleMesh.instanceMatrix.needsUpdate = true;
  if (particleMesh.instanceColor) particleMesh.instanceColor.needsUpdate = true;
}
