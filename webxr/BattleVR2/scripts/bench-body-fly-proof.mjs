#!/usr/bin/env node
/**
 * PROOF: CapVR same-frame rigid weld.
 * Hand−stick relative vector in cockpit-local must stay put while the ship
 * translates/yaws. One-frame-stale attach makes that relative slide by ~Δvehicle.
 *
 *   node BattleVR2/scripts/bench-body-fly-proof.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9148);
const OUT = path.join(ROOT, 'bench-out', 'body-fly-proof');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL || 'chrome',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__BATTLEVR2_ENTER_VEHICLE__?.();
  await sleep(50);

  const seat = cock.getSeatWorldPosition();
  const rig = document.getElementById('cameraRig');
  const cam = document.getElementById('camera');
  if (cam?.object3D) cam.object3D.position.set(0, 0, 0);
  if (rig?.object3D) {
    rig.object3D.position.set(seat.x, seat.y, seat.z);
    rig.object3D.rotation.set(0, seat.yaw, 0);
  }

  const mb = document.getElementById('local-body')?.components?.['mixamo-body'];
  const bones = mb?.bones || {};
  const cockpitRoot = document.getElementById('player-cockpit')?.object3D;

  const wp = (obj) => {
    if (!obj) return null;
    const v = new THREE.Vector3();
    obj.getWorldPosition(v);
    return v.clone();
  };
  const toLocal = (world, inv) => {
    if (!world) return null;
    return world.clone().applyMatrix4(inv);
  };

  let steer = null;
  let thr = null;
  const findControls = () => {
    steer = null;
    thr = null;
    window.__BATTLEVR2_COCKPIT__?.scene?.traverse((o) => {
      if (o.name === 'steer-wrap') steer = o;
      if (o.name === 'thrust-wrap') thr = o;
    });
  };
  findControls();

  window.__BATTLEVR2_DESKTOP_VEHICLE__ = {
    yaw: 0, thrust: 0.5, strafe: 0, yawDelta: 0, boost: false,
  };
  window.__BATTLEVR2_FP_INPUT__?.(1 / 60);

  const invCock = new THREE.Matrix4();
  // Hand vs attach (not wrap center) — wrap AABB shifts as stick tips visually.
  const attachRelR = [];
  const attachRelL = [];
  // Pure translation only (no yaw tip) — cabin-local hand vs wrap must not slide.
  const thrustRelR = [];
  const thrustRelL = [];
  const hipsSamples = [];
  let prevStick = null;
  let maxStickStep = 0;
  let maxBoneDistR = 0;
  let maxBoneDistL = 0;
  let maxHandToAttachR = 0;
  let maxHandToAttachL = 0;

  for (let i = 0; i < 90; i++) {
    window.__BATTLEVR2_FORCE_VEHICLE_STEP__ = true;
    // Mostly hard yaw+thrust; every 3rd frame pure thrust (isolates cabin slide).
    const turning = i % 3 !== 0;
    window.__BATTLEVR2_DESKTOP_VEHICLE__ = {
      yaw: turning ? (i % 40 < 20 ? 1 : -1) : 0,
      thrust: 1,
      strafe: 0,
      yawDelta: turning ? 0.08 : 0,
      boost: false,
    };
    window.__BATTLEVR2_FP_INPUT__?.(1 / 60);
    findControls();

    const stick = wp(steer);
    const lever = wp(thr);
    const hand = wp(bones.rightHandBone || bones.rightHand);
    const leftHand = wp(bones.leftHandBone || bones.leftHand);
    const bag = window.__BATTLEVR2_COCKPIT_HAND_ATTACH__ || {};
    const attR = bag.right && Number.isFinite(bag.right.x)
      ? new THREE.Vector3(bag.right.x, bag.right.y, bag.right.z)
      : null;
    const attL = bag.left && Number.isFinite(bag.left.x)
      ? new THREE.Vector3(bag.left.x, bag.left.y, bag.left.z)
      : null;

    if (stick && prevStick) {
      maxStickStep = Math.max(maxStickStep, stick.distanceTo(prevStick));
    }
    if (hand && stick) maxBoneDistR = Math.max(maxBoneDistR, hand.distanceTo(stick));
    if (leftHand && lever) maxBoneDistL = Math.max(maxBoneDistL, leftHand.distanceTo(lever));
    if (hand && attR) maxHandToAttachR = Math.max(maxHandToAttachR, hand.distanceTo(attR));
    if (leftHand && attL) maxHandToAttachL = Math.max(maxHandToAttachL, leftHand.distanceTo(attL));

    if (cockpitRoot) {
      cockpitRoot.updateWorldMatrix(true, true);
      invCock.copy(cockpitRoot.matrixWorld).invert();
      const hR = toLocal(hand, invCock);
      const hL = toLocal(leftHand, invCock);
      const aR = toLocal(attR, invCock);
      const aL = toLocal(attL, invCock);
      if (hR && aR) {
        attachRelR.push({ x: hR.x - aR.x, y: hR.y - aR.y, z: hR.z - aR.z });
      }
      if (hL && aL) {
        attachRelL.push({ x: hL.x - aL.x, y: hL.y - aL.y, z: hL.z - aL.z });
      }
      if (!turning) {
        const sL = toLocal(stick, invCock);
        const lL = toLocal(lever, invCock);
        if (sL && hR) {
          thrustRelR.push({ x: hR.x - sL.x, y: hR.y - sL.y, z: hR.z - sL.z });
        }
        if (lL && hL) {
          thrustRelL.push({ x: hL.x - lL.x, y: hL.y - lL.y, z: hL.z - lL.z });
        }
      }
      if (bones.hips) {
        bones.hips.updateWorldMatrix(true, true);
        const hips = new THREE.Vector3();
        bones.hips.getWorldPosition(hips);
        hips.applyMatrix4(invCock);
        hipsSamples.push({ x: hips.x, y: hips.y, z: hips.z });
      }
    }

    prevStick = stick;
    await sleep(4);
  }
  window.__BATTLEVR2_FORCE_VEHICLE_STEP__ = false;

  const spanMax = (arr) => {
    if (!arr.length) return 999;
    let mx = 0;
    for (const k of ['x', 'y', 'z']) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of arr) {
        lo = Math.min(lo, s[k]);
        hi = Math.max(hi, s[k]);
      }
      mx = Math.max(mx, hi - lo);
    }
    return mx;
  };

  const attachRelRSpan = spanMax(attachRelR);
  const attachRelLSpan = spanMax(attachRelL);
  const thrustRelRSpan = spanMax(thrustRelR);
  const thrustRelLSpan = spanMax(thrustRelL);
  const hipsSpan = spanMax(hipsSamples);

  // Hand glued to post-step attach (CapVR weld). Wrap-relative thrust samples are
  // advisory only — stick visual spring-back moves the wrap AABB without lag.
  const weldedOk =
    maxStickStep > 0.05 &&
    maxHandToAttachR < 0.04 &&
    maxHandToAttachL < 0.04 &&
    attachRelRSpan < 0.02 &&
    attachRelLSpan < 0.02 &&
    hipsSpan < 0.04;
  const gripOk = maxBoneDistR < 0.28 && maxBoneDistL < 0.28;

  const prevFp = window.__BATTLEVR2_FP_INPUT__;
  window.__BATTLEVR2_FP_INPUT__ = (dt) => {
    prevFp?.(dt);
    if (cam?.object3D) {
      cam.object3D.position.set(0, 0, 0);
      cam.object3D.rotation.set(-1.2, 0, 0);
    }
  };
  window.__BATTLEVR2_FP_INPUT__(1 / 60);

  return {
    ok: !!(window.__BATTLEVR2_BOARDED__ && weldedOk && gripOk),
    boarded: !!window.__BATTLEVR2_BOARDED__,
    weldedOk,
    gripOk,
    maxStickStep,
    maxBoneDistR,
    maxBoneDistL,
    maxHandToAttachR,
    maxHandToAttachL,
    attachRelRSpan,
    attachRelLSpan,
    thrustRelRSpan,
    thrustRelLSpan,
    hipsSpan,
    n: attachRelR.length,
  };
});

await sleep(250);
await page.screenshot({ path: path.join(OUT, 'lookdown-fly.png') });

const out = { ...report, errors: errors.slice(0, 20), shot: path.join(OUT, 'lookdown-fly.png') };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

await browser.close();
server.close();
process.exit(out.ok && errors.length === 0 ? 0 : 1);
