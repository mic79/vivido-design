import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '../../../VRrunner/js/main.js');
const outPath = path.join(__dirname, '../js/vrrunner/playerLocomotion.js');

const lines = fs.readFileSync(mainPath, 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.includes('const vrInput ='));
const end = lines.findIndex((l) => l.startsWith('function setupSunLight'));
if (start < 0 || end < 0) throw new Error('markers not found');

let body = lines.slice(start, end).join('\n');

// ChaseVR city mode: always use sandbox-style floor + slide anywhere grounded
body = body.replace(/getSandboxFloorY\(/g, 'getFloorY(');
body = body.replace(/getRunnerFloorY\(/g, 'getFloorY(');

// Skip pit reset that disposes runner level (ChaseVR owns the city)
body = body.replace(
  /function tryRunnerPitFallReset\(\) \{[\s\S]*?\n\}/,
  'function tryRunnerPitFallReset() { /* disabled in ChaseVR embed */ }'
);

// Skip editor toggle chord in updateVRMovement — keep physics only for embed
body = body.replace(
  /\/\* Quest map=1: hold BOTH grip[\s\S]*?\n  \}\n\n  \/\* Clamp dt/,
  '  /* Clamp dt'
);

const header = `/**
 * VRrunner kinematic player locomotion — extracted from main.js for ChaseVR embed.
 * Grab/throw jump, slide duck, wingsuit glide, stick move, BVH collision.
 */
import * as THREE from 'three';
import {
  getRunnerThrowAssist,
  triggerRunnerDuck,
  applyRunnerCameraDuck,
  getRigSampleHeightMul,
  getRunnerRadiusMul,
  resolveGlbMeshCollisions,
  getGlbFloorSupport,
  getGlbFloorY,
  getSandboxGlbCollisionMeshes,
  tryShatterRunnerGlassPlayer,
} from './runnerLevel.js';
import { getPairedXRControllerGrips } from './xrControllerPair.js';
import {
  applyGrappleWinchStep,
  isGrappleHookActive,
  isArcheryDrawActive,
} from './bots.js';
import { tickGlideAudio } from './glideAudio.js';

/** @param {object} deps */
export function createPlayerLocomotion(deps) {
  const renderer = deps.renderer;
  const camera = deps.camera;
  const cameraRig = deps.cameraRig;
  const crouchViewGroup = deps.crouchViewGroup;
  const getWorldCollisionBoxes = () => (deps.getCollisionBoxes ? deps.getCollisionBoxes() : []);
  const getFloorY = (x, z, currentY, slack = 0.35) => {
    if (deps.getFloorY) return deps.getFloorY(x, z, currentY, slack);
    return getGlbFloorY(x, z, currentY);
  };
  const RUNNER_MAP_ID = deps.mapId != null ? deps.mapId : 1;
  const controllerGrip1 = deps.controllerGrip1;
  const controllerGrip2 = deps.controllerGrip2;
  let locomotionMode = 'physics';

`;

const footer = `
  function registerHands(leftGrip, rightGrip) {
    handToCtrl.left = leftGrip || null;
    handToCtrl.right = rightGrip || null;
  }

  function syncHandSlotsFromGrips() {
    if (!deps.syncHandSlotsFromGrips) return;
    const slots = deps.syncHandSlotsFromGrips();
    if (slots) registerHands(slots.left, slots.right);
  }

  function resetRigAt(pos, yaw) {
    if (pos) cameraRig.position.copy(pos);
    if (typeof yaw === 'number') cameraRig.rotation.set(0, yaw + Math.PI, 0);
    rigVelocity.set(0, 0, 0);
    jumpsRemaining = MAX_JUMPS;
    parkourJumpGlideBlockSec_ = 0;
    glideLatch_ = false;
    grabState.left.active = false;
    grabState.right.active = false;
    grabState.left.history.length = 0;
    grabState.right.history.length = 0;
  }

  function updateFootFrame(deltaMs) {
    syncHandSlotsFromGrips();
    updateVRMovement(deltaMs);
    if (crouchViewGroup && camera) {
      applyRunnerCameraDuck(camera, crouchViewGroup, { deltaMs: deltaMs || 16.67 });
    }
  }

  return {
    updateFootFrame,
    updateVRMovement,
    updatePhysicsMovement,
    tickRunnerCollisionIntegration,
    applyGlideCruiseAfterCollision_,
    getRigVelocity: () => rigVelocity,
    registerHands,
    resetRigAt,
    isGrounded,
  };
}
`;

fs.writeFileSync(outPath, header + body + footer);
console.log('Wrote', outPath, 'body lines:', body.split('\n').length);
