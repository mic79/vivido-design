/**
 * BattleVR2 — Box3D world for FP capsule + hover vehicle chassis.
 */
let physics = null;
let ready = false;
let readyPromise = null;
let playerVelY = 0;

let vehiclePos = { x: 0, y: 2.2, z: 0 };
let vehicleVelY = 0;
let vehicleShapeIds = null;
/**
 * Wall probe only — MUST sit above the nav/terrain surface at skim height.
 * A ground-penetrating capsule made every XZ step look like a wall hit and
 * killed forward speed (rotation still worked because yaw bypasses the capsule).
 */
const vehicleCapsule = {
  center1: { x: 0, y: 0.85, z: 0 },
  center2: { x: 0, y: 1.35, z: 0 },
  radius: 0.55,
};

const MOON_G = { x: 0, y: -1.62, z: 0 };

export function isBox3DReady() {
  return ready && physics;
}

export function getPhysics() {
  return physics;
}

export async function initBox3DWorld(options = {}) {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (typeof window.Box3DPhysicsWorld !== 'function') {
      throw new Error('Box3DPhysicsWorld not loaded — check bootstrap vendor scripts');
    }
    physics = new window.Box3DPhysicsWorld();
    // Moon bake sits below y=0 in places. CapVR already learned a y≈0 slab traps
    // you floating above the real floor — skip lab ground + demo props entirely.
    // Terrain contact is battle-phys BVH / heightfield, not Box3D statics.
    if (typeof physics._addGround === 'function') {
      physics._addGround = function () { /* no phantom floor */ };
    }
    if (typeof physics._addSceneColliders === 'function') {
      physics._addSceneColliders = function () { /* no lab props */ };
    }
    await physics.init({ gravity: options.gravity || MOON_G });
    if (typeof physics.setGravity === 'function') {
      physics.setGravity(MOON_G.x, MOON_G.y, MOON_G.z);
    }
    ready = true;
    window.__BATTLEVR2_BOX3D__ = physics;
    // CapVR mixamo-body expects scene.legIkWorld (feet/ground probes).
    const scene = document.querySelector('a-scene');
    if (scene) {
      scene.legIkWorld = {
        ready: true,
        physics,
        queries: physics.queries,
        playerShapeIds: () => physics.playerShapeIds,
        playerRootPos: () => physics.playerPosition || { x: 0, y: 0, z: 0 },
        terrain: null,
      };
    }
    console.log('[BattleVR2] Box3D world ready');
    return physics;
  })();
  return readyPromise;
}

export function spawnPlayerAt(x, y, z) {
  if (!physics) return;
  if (!physics.playerBody) {
    physics.initPlayerAt(x, y, z);
  } else {
    physics.setPlayerTranslation(x, y, z);
  }
  playerVelY = 0;
  physics.playerGrounded = true;
}

/** Integrate FP desire (forward/strafe/jump) into Box3D capsule mover. */
export function stepPlayerMover(dt, desire, yawRad) {
  if (!physics || !ready || !physics.playerBody) return getPlayerPosition();

  const speed = desire.sprint ? 8 : 4.5;
  const forward = desire.forward || 0;
  const strafe = desire.strafe || 0;
  const sin = Math.sin(yawRad);
  const cos = Math.cos(yawRad);
  const vx = (forward * -sin + strafe * cos) * speed;
  const vz = (forward * -cos - strafe * sin) * speed;

  if (desire.jump && physics.playerGrounded) {
    playerVelY = 4.2;
    physics.playerGrounded = false;
  }
  playerVelY += MOON_G.y * dt;

  const dx = vx * dt;
  const dy = playerVelY * dt;
  const dz = vz * dt;

  const moved = physics.movePlayer({ x: dx, y: dy, z: dz }, {});
  if (physics.playerGrounded) {
    playerVelY = Math.min(0, playerVelY);
  }
  physics.playerVelocity = { x: vx, y: playerVelY, z: vz };
  if (typeof physics.step === 'function') {
    physics.step(dt);
  }
  return moved?.position || physics.playerPosition;
}

export function setPlayerPosition(x, y, z) {
  if (!physics) return;
  if (!physics.playerBody) spawnPlayerAt(x, y, z);
  else physics.setPlayerTranslation(x, y, z);
}

export function getPlayerPosition() {
  if (!physics) return { x: 0, y: 1.6, z: 0 };
  return physics.getPlayerTranslation ? physics.getPlayerTranslation() : (physics.playerPosition || { x: 0, y: 1.6, z: 0 });
}

export function setPlayerColliderEnabled(on) {
  if (physics && typeof physics.setPlayerColliderEnabled === 'function') {
    physics.setPlayerColliderEnabled(on);
  }
}

export function teleportVehicleCollider(x, y, z) {
  vehiclePos = { x, y, z };
  vehicleVelY = 0;
}

/**
 * Hover chassis step: horizontal + vertical delta through Box3D capsule mover (collisions).
 * @returns {{x,y,z, grounded:boolean, blocked:boolean}}
 */
export function stepVehicleCollider(dt, desire) {
  if (!physics?.queries?.moveCapsuleMover) {
    vehiclePos.x += (desire.vx || 0) * dt;
    vehiclePos.y += (desire.vy || 0) * dt;
    vehiclePos.z += (desire.vz || 0) * dt;
    return { ...vehiclePos, grounded: false, blocked: false };
  }

  const dx = (desire.vx || 0) * dt;
  const dy = (desire.vy || 0) * dt;
  const dz = (desire.vz || 0) * dt;
  const before = { ...vehiclePos };
  const moved = physics.queries.moveCapsuleMover(
    vehiclePos,
    { x: dx, y: dy, z: dz },
    vehicleCapsule,
    physics.moverFilter
  );
  vehiclePos = moved.position;
  const wallHit = Math.hypot(moved.delta.x - dx, moved.delta.z - dz) > 0.02;
  const groundClip = dy < -1e-4 && moved.delta.y > dy + 1e-4;
  const blocked = wallHit || groundClip;
  // Ground probe under chassis
  let grounded = false;
  if (physics.queries.castRayDown) {
    const hit = physics.queries.castRayDown(
      vehiclePos.x,
      vehiclePos.y + 1.2,
      vehiclePos.z,
      3.5,
      vehicleShapeIds
    );
    if (hit && Math.abs(hit.point.y - (vehiclePos.y - 0.2)) < 0.55) grounded = true;
  }
  if (typeof physics.step === 'function') physics.step(dt);
  return { ...vehiclePos, grounded, blocked, wallHit, before };
}

export function getVehicleColliderPos() {
  return { ...vehiclePos };
}
