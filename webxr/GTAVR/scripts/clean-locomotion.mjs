import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '../js/vrrunner/playerLocomotion.js');
let src = fs.readFileSync(file, 'utf8');

// Remove duplicate locomotionMode declaration inside factory body
src = src.replace(/\nlet locomotionMode = "physics";\n\/\*\* Map=1: both grip/, '\n/** Map=1: both grip');

// Drop UI / editor / controller-setup block through getWorldCollisionBoxes (use deps getter above)
src = src.replace(
  /function setStatus\([\s\S]*?^function updateGrabLocomotion/m,
  'function updateGrabLocomotion'
);

// Simplify updateVRMovement — physics only, no editor branch
src = src.replace(
  /function updateVRMovement\(delta\) \{[\s\S]*?^}/m,
  `function updateVRMovement(delta) {
  const session = renderer.xr.getSession();
  if (!session) return;
  if (renderer.xr?.isPresenting && camera && typeof renderer.xr.updateCamera === 'function') {
    renderer.xr.updateCamera(camera);
  }
  vrInput.leftStick.x = 0;
  vrInput.leftStick.y = 0;
  vrInput.rightStick.x = 0;
  vrInput.rightStick.y = 0;

  const xrPad = getPairedXRControllerGrips(session, controllerGrip1, controllerGrip2);
  applyGamepadAxesToVRInput_(xrPad.L?.gamepad, true);
  applyGamepadAxesToVRInput_(xrPad.R?.gamepad, false);

  const dt = Math.min(0.1, (delta || 0) / 1000);
  if (!(dt > 0)) return;

  const xrCamera = renderer.xr.getCamera();
  updatePhysicsMovement(dt, xrCamera);
  tickRunnerCollisionIntegration(xrCamera, dt);
  applyGlideCruiseAfterCollision_(dt);
}`
);

fs.writeFileSync(file, src);
console.log('Cleaned playerLocomotion.js');
