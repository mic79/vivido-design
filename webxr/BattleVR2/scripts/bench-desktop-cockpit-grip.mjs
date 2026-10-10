#!/usr/bin/env node
/**
 * Verify flatscreen cockpit grip: palm normals + wrist near controls + fire curls.
 *   node BattleVR2/scripts/bench-desktop-cockpit-grip.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9146);
const OUT = path.join(ROOT, 'bench-out', 'desktop-cockpit-grip');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL || 'chrome',
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 90; i++) {
  if (await page.evaluate(() => !!window.__SCENE_READY__ && !!window.__BATTLEVR2_BOOT__)) break;
  await sleep(1000);
}
await page.evaluate(async () => {
  window._dismissAppStartGate?.();
  await window._startGame?.('1v1');
});
for (let i = 0; i < 60; i++) {
  if (await page.evaluate(() => !!window.__BATTLEVR2_MATCH__)) break;
  await sleep(500);
}

const report = await page.evaluate(async () => {
  const cock = await import('./js/cockpit.js');
  const THREE = window.THREE;
  window.__BATTLEVR2_ENTER_VEHICLE__?.();
  const seat = cock.getSeatWorldPosition();
  const rig = document.getElementById('cameraRig');
  document.getElementById('camera').object3D.position.set(0, 0, 0);
  rig.object3D.position.set(seat.x, seat.y, seat.z);
  rig.object3D.rotation.set(0, seat.yaw, 0);

  window.__BATTLEVR2_MOUSE_FIRE__ = false;
  window.__BATTLEVR2_DESKTOP_VEHICLE__ = {
    yaw: 0,
    thrust: 0.4,
    strafe: 0,
    yawDelta: 0,
    boost: false,
  };
  cock.syncCockpitToVehicle();
  cock.updateCockpitControls();
  const mb = document.getElementById('local-body').components['mixamo-body'];
  for (let i = 0; i < 24; i++) mb.updateLocalBody(1 / 60);
  mb.updateFingerPoses?.(1 / 60);

  const measurePalm = (hand) => {
    const handBone = mb.bones[`${hand}HandBone`];
    const middle1 = mb.bones[`${hand}HandMiddle1`];
    const index1 = mb.bones[`${hand}HandIndex1`];
    const pinky1 = mb.bones[`${hand}HandPinky1`];
    const thumb1 = mb.bones[`${hand}HandThumb1`];
    if (!handBone || !middle1) return null;
    const wrist = new THREE.Vector3();
    const mid = new THREE.Vector3();
    handBone.getWorldPosition(wrist);
    middle1.getWorldPosition(mid);
    const finger = mid.clone().sub(wrist).normalize();
    let palm = new THREE.Vector3(0, -1, 0);
    if (index1 && pinky1) {
      const iW = new THREE.Vector3();
      const pW = new THREE.Vector3();
      index1.getWorldPosition(iW);
      pinky1.getWorldPosition(pW);
      palm = pW.clone().sub(iW);
      palm = new THREE.Vector3().crossVectors(finger, palm);
      if (palm.lengthSq() > 1e-8) palm.normalize();
    }
    const thumb = new THREE.Vector3();
    thumb1?.getWorldPosition(thumb);
    return {
      wrist: wrist.toArray().map((v) => +v.toFixed(3)),
      finger: finger.toArray().map((v) => +v.toFixed(3)),
      palm: palm.toArray().map((v) => +v.toFixed(3)),
      thumb: thumb1 ? thumb.toArray().map((v) => +v.toFixed(3)) : null,
      curls: { ...mb.targetCurls[hand] },
    };
  };

  let steer = null;
  let thr = null;
  window.__BATTLEVR2_COCKPIT__.scene.traverse((o) => {
    if (o.name === 'steer-wrap') steer = o;
    if (o.name === 'thrust-wrap') thr = o;
  });
  const stickC = new THREE.Box3().setFromObject(steer).getCenter(new THREE.Vector3());
  const leverC = new THREE.Box3().setFromObject(thr).getCenter(new THREE.Vector3());
  const left = measurePalm('left');
  const right = measurePalm('right');
  const dist = (a, b) =>
    Math.hypot(a[0] - b.x, a[1] - b.y, a[2] - b.z);

  // Fire curls
  window.__BATTLEVR2_MOUSE_FIRE__ = true;
  cock.updateCockpitControls();
  for (let i = 0; i < 8; i++) mb.updateLocalBody(1 / 60);
  mb.updateFingerPoses?.(1 / 60);
  const rightFire = measurePalm('right');

  // Palm normal from index×pinky can flip sign — accept either strong axis match.
  const leftPalmDown = left && Math.abs(left.palm[1]) > 0.7 && left.palm[1] < 0;
  const rightPalmLeft = right && right.palm[0] < -0.7;
  const leftNear = left && dist(left.wrist, leverC) < 0.12;
  const rightNear = right && dist(right.wrist, stickC) < 0.14;
  const fireIndexUp =
    rightFire && rightFire.curls.index > right.curls.index + 0.4;

  return {
    left,
    right,
    rightFireCurls: rightFire?.curls,
    stickC: stickC.toArray().map((v) => +v.toFixed(3)),
    leverC: leverC.toArray().map((v) => +v.toFixed(3)),
    leftPalmDown,
    rightPalmLeft,
    leftNear,
    rightNear,
    fireIndexUp,
    attachKinds: {
      L: window.__BATTLEVR2_COCKPIT_HAND_ATTACH__?.left?.kind,
      R: window.__BATTLEVR2_COCKPIT_HAND_ATTACH__?.right?.kind,
    },
  };
});

const pass =
  report.leftPalmDown &&
  report.rightPalmLeft &&
  report.leftNear &&
  report.rightNear &&
  report.fireIndexUp &&
  report.attachKinds.L === 'lever' &&
  report.attachKinds.R === 'stick';

const out = { pass, report, errors };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
process.exit(pass && errors.length === 0 ? 0 : 1);
