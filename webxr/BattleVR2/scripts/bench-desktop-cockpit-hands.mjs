#!/usr/bin/env node
/**
 * Flatscreen cockpit: hands must pin to stick/lever; mouse-right must tip stick right.
 *   node BattleVR2/scripts/bench-desktop-cockpit-hands.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9141);
const OUT = path.join(ROOT, 'bench-out', 'desktop-cockpit-hands');
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
  // Flatscreen seat pin (same as input-fp syncRigToSeat).
  const seat = cock.getSeatWorldPosition();
  const rig = document.getElementById('cameraRig');
  const cam = document.getElementById('camera');
  if (cam?.object3D) cam.object3D.position.set(0, 0, 0);
  if (rig?.object3D) {
    rig.object3D.position.set(seat.x, seat.y, seat.z);
    rig.object3D.rotation.set(0, seat.yaw, 0);
  }

  // DESKTOP bag optional — attach must still publish from boarded+active.
  window.__BATTLEVR2_DESKTOP_VEHICLE__ = null;
  cock.syncCockpitToVehicle();
  cock.updateCockpitControls();

  window.__BATTLEVR2_DESKTOP_VEHICLE__ = {
    yaw: 0,
    thrust: 0.6,
    strafe: 0,
    yawDelta: -0.04, // mouse-right (input-fp: -look.dx * sens when dx>0)
    boost: false,
  };
  cock.syncCockpitToVehicle();
  const axes = cock.updateCockpitControls();

  const mb = document.getElementById('local-body')?.components?.['mixamo-body'];
  for (let i = 0; i < 20; i++) mb?.updateLocalBody?.(1 / 60);

  const bag = window.__BATTLEVR2_COCKPIT_HAND_ATTACH__ || {};
  const body = document.getElementById('local-body');
  const bones = mb?.bones || {};
  const bodyAnchorY = body?.object3D?.position?.y;

  const wp = (obj) => {
    if (!obj) return null;
    const v = new THREE.Vector3();
    obj.getWorldPosition(v);
    return { x: v.x, y: v.y, z: v.z };
  };

  let steer = null;
  let thr = null;
  window.__BATTLEVR2_COCKPIT__?.scene?.traverse((o) => {
    if (o.name === 'steer-wrap') steer = o;
    if (o.name === 'thrust-wrap') thr = o;
  });

  const stickW = wp(steer);
  const leverW = wp(thr);
  const rightHandW = wp(bones.rightHandBone || bones.rightHand);
  const leftHandW = wp(bones.leftHandBone || bones.leftHand);

  const dist = (a, b) =>
    a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 999;

  // Stick tip: rest vs after mouse-right visual
  const qRest = steer?.quaternion?.clone?.();
  // Positive tip should NOT be used for mouse-right; steerVis must be negative.
  const steerVis = axes.steerVis;
  const mouseRightTipsRight = steerVis < -0.15;

  // Also tip stick left via keyboard yaw and confirm opposite
  window.__BATTLEVR2_DESKTOP_VEHICLE__ = {
    yaw: 1,
    thrust: 0.6,
    strafe: 0,
    yawDelta: 0,
    boost: false,
  };
  const axesLeft = cock.updateCockpitControls();
  const keyATipsLeft = axesLeft.steerVis > 0.15;

  return {
    boarded: !!window.__BATTLEVR2_BOARDED__,
    bodyVisible: body?.getAttribute?.('visible') !== 'false',
    attachLeft: !!(bag.left && Number.isFinite(bag.left.x)),
    attachRight: !!(bag.right && Number.isFinite(bag.right.x)),
    attachLeftKind: bag.left?.kind || null,
    attachRightKind: bag.right?.kind || null,
    joyHand: window.__BATTLEVR2_COCKPIT_JOY_HAND__ || null,
    steerVisMouseRight: steerVis,
    steerVisKeyA: axesLeft.steerVis,
    mouseRightTipsRight,
    keyATipsLeft,
    distRightToStick: dist(rightHandW, stickW),
    distLeftToLever: dist(leftHandW, leverW),
    stickW,
    leverW,
    rightHandW,
    leftHandW,
    hasBones: !!(bones.rightHandBone || bones.rightHand),
    modelLoaded: !!mb?.modelLoaded,
    bodyAnchorY,
    bodyAnchorOk: Number.isFinite(bodyAnchorY) && bodyAnchorY < -1.0,
    qRestOk: !!qRest,
  };
});

const pass =
  report.boarded &&
  report.attachLeft &&
  report.attachRight &&
  report.attachLeftKind === 'lever' &&
  report.attachRightKind === 'stick' &&
  report.mouseRightTipsRight &&
  report.keyATipsLeft &&
  report.modelLoaded &&
  report.bodyAnchorOk &&
  report.distRightToStick < 0.28 &&
  report.distLeftToLever < 0.28;

const out = { pass, report, errors };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

await browser.close();
server.close();
process.exit(pass && errors.length === 0 ? 0 : 1);
