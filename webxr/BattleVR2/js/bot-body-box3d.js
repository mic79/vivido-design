/**
 * BattleVR2 — Box3D FP avatar / vehicle body for seat fillers (capVR-style, not Cannon).
 * Strategy AI remains in rts/bot.js; this only integrates a rigid proxy in the physics world.
 */
import * as Box3D from './box3d-world.js';
import * as State from './rts/state.js';

const bodies = new Map(); // seatId -> { mesh, x, y, z, yaw }

export function clearBotBodies(sceneEl) {
  for (const [, b] of bodies) {
    if (b.mesh?.parent) b.mesh.parent.remove(b.mesh);
  }
  bodies.clear();
}

export function ensureSeatBody(sceneEl, seatId, x, y, z) {
  if (bodies.has(seatId)) return bodies.get(seatId);
  const THREE = window.THREE;
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.28, 0.9, 4, 8),
    new THREE.MeshStandardMaterial({ color: seatId === 0 ? 0x3b82f6 : 0xef4444, roughness: 0.7 })
  );
  mesh.position.set(x, y, z);
  mesh.name = `bot-body-seat-${seatId}`;
  sceneEl.object3D.add(mesh);
  const rec = { mesh, x, y, z, yaw: 0 };
  bodies.set(seatId, rec);
  return rec;
}

/** Soft-follow a world target (e.g. enemy HQ approach for demo body). */
export function stepBotBodies(dt) {
  if (!Box3D.isBox3DReady()) return;
  for (const [seatId, b] of bodies) {
    const player = State.players[seatId];
    if (!player || !player.isBot || player.isDefeated) {
      b.mesh.visible = false;
      continue;
    }
    b.mesh.visible = true;
    // Idle hover near own spawn — strategy bot commands the army; body is presence only.
    const sp = player.spawn || { x: b.x, z: b.z };
    const tx = sp.x + 4;
    const tz = sp.z + 4;
    b.x += (tx - b.x) * Math.min(1, dt * 0.6);
    b.z += (tz - b.z) * Math.min(1, dt * 0.6);
    b.y += (2.0 - b.y) * Math.min(1, dt * 2);
    b.mesh.position.set(b.x, b.y, b.z);
  }
}

export function spawnOpponentBodyNearEnemy(sceneEl) {
  const enemy = State.players.find((p) => p.isBot && p.isActive && !p.isDefeated);
  if (!enemy) return null;
  const sp = enemy.spawn || { x: 0, z: 0 };
  return ensureSeatBody(sceneEl, enemy.id, sp.x + 4, 2, sp.z + 4);
}
