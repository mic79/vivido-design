#!/usr/bin/env node
/**
 * Multi-angle right-stick grip proof.
 * lookdown: wrap after full FP tick (body-fly-proof).
 * orbit: skip prevFp (avoids syncRigToSeat wiping #camera) and drive
 *        seat+hands+orbit ourselves, then Playwright-screenshot.
 *
 *   node BattleVR2/scripts/bench-stick-grip-views.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9155);
const OUT = path.join(ROOT, 'bench-out', 'stick-grip-views');
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

const metrics = await page.evaluate(async () => {
  const cock = await import('./js/cockpit.js');
  const THREE = window.THREE;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__BATTLEVR2_ENTER_VEHICLE__?.();
  await sleep(80);

  const seat0 = cock.getSeatWorldPosition();
  const rig = document.getElementById('cameraRig');
  const camEl = document.getElementById('camera');
  if (camEl?.object3D) camEl.object3D.position.set(0, 0, 0);
  if (rig?.object3D) {
    rig.object3D.position.set(seat0.x, seat0.y, seat0.z);
    rig.object3D.rotation.set(0, seat0.yaw, 0);
  }

  const mb = document.getElementById('local-body')?.components?.['mixamo-body'];
  window.__BATTLEVR2_DESKTOP_VEHICLE__ = {
    yaw: 0, thrust: 0.35, strafe: 0, yawDelta: 0, boost: false,
  };
  for (let i = 0; i < 45; i++) {
    window.__BATTLEVR2_FORCE_VEHICLE_STEP__ = true;
    window.__BATTLEVR2_FP_INPUT__?.(1 / 60);
    await sleep(4);
  }
  window.__BATTLEVR2_FORCE_VEHICLE_STEP__ = false;
  window.__BATTLEVR2_DESKTOP_VEHICLE__ = {
    yaw: 0, thrust: 0.05, strafe: 0, yawDelta: 0, boost: false,
  };
  cock.syncCockpitToVehicle();
  cock.refreshHandAttachPoses();
  for (let i = 0; i < 30; i++) mb?.updateLocalBody?.(1 / 60);

  let steer = null;
  window.__BATTLEVR2_COCKPIT__?.scene?.traverse((o) => {
    if (o.name === 'steer-wrap') steer = o;
  });
  const stickW = new THREE.Vector3();
  if (steer) {
    const box = new THREE.Box3().setFromObject(steer);
    if (!box.isEmpty()) box.getCenter(stickW);
    else steer.getWorldPosition(stickW);
  }

  const bones = mb?.bones || {};
  const hand = bones.rightHandBone || bones.rightHand;
  const handW = new THREE.Vector3();
  hand?.updateWorldMatrix(true, false);
  hand?.getWorldPosition(handW);

  const hideExtras = (hide) => {
    const root = document.getElementById('local-body')?.object3D;
    if (!root) return;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const n = (o.name || '').toLowerCase();
      const isExtra =
        n.includes('head') ||
        n.includes('hip') ||
        n.includes('spine') ||
        n.includes('pelvis') ||
        n.includes('neck') ||
        n.includes('torso') ||
        n.includes('chest') ||
        n.includes('leg') ||
        n.includes('foot') ||
        n.includes('toe');
      if (!isExtra) return;
      if (hide) {
        if (!('_sgPrev' in o.userData)) o.userData._sgPrev = o.visible;
        o.visible = false;
      } else if ('_sgPrev' in o.userData) {
        o.visible = o.userData._sgPrev;
        delete o.userData._sgPrev;
      }
    });
  };
  window.__STICK_HIDE_EXTRAS__ = hideExtras;

  const refreshStickLocal = () => {
    let steerNow = null;
    window.__BATTLEVR2_COCKPIT__?.scene?.traverse((o) => {
      if (o.name === 'steer-wrap') steerNow = o;
    });
    const sw = new THREE.Vector3();
    if (steerNow && rig?.object3D) {
      const box = new THREE.Box3().setFromObject(steerNow);
      if (!box.isEmpty()) box.getCenter(sw);
      else steerNow.getWorldPosition(sw);
      rig.object3D.updateMatrixWorld(true);
      sw.applyMatrix4(new THREE.Matrix4().copy(rig.object3D.matrixWorld).invert());
      window.__STICK_L = { x: sw.x, y: sw.y, z: sw.z };
    }
  };
  refreshStickLocal();

  const flushCamAttrs = () => {
    // A-Frame position/rotation components overwrite object3D from attributes
    // every tick — writing object3D alone is wiped before the next render.
    const c = camEl.object3D;
    camEl.setAttribute('position', {
      x: c.position.x,
      y: c.position.y,
      z: c.position.z,
    });
    const e = new THREE.Euler().setFromQuaternion(c.quaternion, 'YXZ');
    camEl.setAttribute('rotation', {
      x: THREE.MathUtils.radToDeg(e.x),
      y: THREE.MathUtils.radToDeg(e.y),
      z: THREE.MathUtils.radToDeg(e.z),
    });
  };

  const applyOrbitCam = (view) => {
    const c = camEl.object3D;
    const nested = camEl.getObject3D?.('camera');
    if (nested) {
      nested.position.set(0, 0, 0);
      nested.rotation.set(0, 0, 0);
      nested.quaternion.identity();
    }
    refreshStickLocal();
    const s = window.__STICK_L;
    const eyeLocal = new THREE.Vector3(s.x + view.eye[0], s.y + view.eye[1], s.z + view.eye[2]);
    const atLocal = new THREE.Vector3(
      s.x + (view.at?.[0] || 0),
      s.y + (view.at?.[1] || 0),
      s.z + (view.at?.[2] || 0),
    );
    c.position.copy(eyeLocal);
    const parent = c.parent;
    parent.updateMatrixWorld(true);
    const eyeW = eyeLocal.clone().applyMatrix4(parent.matrixWorld);
    const atW = atLocal.clone().applyMatrix4(parent.matrixWorld);
    const dir = atW.clone().sub(eyeW).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(dir.dot(up)) > 0.9) up.set(0, 0, -1);
    c.up.copy(up);
    c.lookAt(atW);
    flushCamAttrs();
  };

  // Stop A-Frame from flushing schema position/rotation over object3D.
  camEl.components?.position?.pause?.();
  camEl.components?.rotation?.pause?.();

  const prevFp = window.__BATTLEVR2_FP_INPUT__;
  window.__STICK_VIEW__ = { mode: 'lookdown', pitch: -1.2 };
  window.__BATTLEVR2_FP_INPUT__ = (dt) => {
    const view = window.__STICK_VIEW__;
    if (view?.mode === 'orbit') {
      // Seat + hands without syncRigToSeat's camera wipe.
      cock.syncCockpitToVehicle();
      const seat = cock.getSeatWorldPosition();
      if (rig?.object3D) {
        rig.object3D.position.set(seat.x, seat.y, seat.z);
        rig.object3D.rotation.set(0, seat.yaw, 0);
      }
      cock.refreshHandAttachPoses();
      mb?.updateLocalBody?.(dt || 1 / 60);
      hideExtras(true);
      applyOrbitCam(view);
      return;
    }

    prevFp?.(dt);
    if (view?.mode === 'lookdown') {
      hideExtras(false);
      const c = camEl?.object3D;
      if (!c) return;
      const nested = camEl.getObject3D?.('camera');
      if (nested) {
        nested.position.set(0, 0, 0);
        nested.rotation.set(0, 0, 0);
      }
      // syncRigToSeat already zeroed pos; re-apply lookdown pitch after it.
      c.position.set(0, 0, 0);
      c.rotation.set(view.pitch ?? -1.2, 0, 0);
    }
  };

  window.__BATTLEVR2_FP_INPUT__(1 / 60);

  const yaw = window.__BATTLEVR2_VEHICLE__?.yaw || 0;
  const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(yawQ);
  const up = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(yawQ);
  const delta = handW.clone().sub(stickW);
  return {
    boarded: !!window.__BATTLEVR2_BOARDED__,
    handDist: hand ? handW.distanceTo(stickW) : 999,
    handAlongRight: delta.dot(right),
    handAlongUp: delta.dot(up),
    handAlongFwd: delta.dot(fwd),
    attach: window.__BATTLEVR2_COCKPIT_HAND_ATTACH__?.right || null,
    stickL: window.__STICK_L,
    stickW: { x: stickW.x, y: stickW.y, z: stickW.z },
    handW: { x: handW.x, y: handW.y, z: handW.z },
  };
});

const views = [
  { name: 'lookdown', mode: 'lookdown', pitch: -1.2 },
  { name: 'top', mode: 'orbit', eye: [0.1, 0.55, 0.18], at: [0, 0.02, 0] },
  { name: 'left', mode: 'orbit', eye: [-0.7, 0.12, 0.05], at: [0, 0.02, 0] },
  { name: 'right', mode: 'orbit', eye: [0.7, 0.12, 0.05], at: [0, 0.02, 0] },
  { name: 'front', mode: 'orbit', eye: [0.0, 0.12, -0.65], at: [0, 0.02, 0] },
  { name: 'back', mode: 'orbit', eye: [0.08, 0.14, 0.6], at: [0, 0.02, 0] },
];

const camLogs = [];
for (const v of views) {
  const log = await page.evaluate((view) => {
    window.__STICK_VIEW__ = view;
    for (let i = 0; i < 10; i++) window.__BATTLEVR2_FP_INPUT__?.(1 / 60);
    const c = document.getElementById('camera')?.object3D;
    const nested = document.getElementById('camera')?.getObject3D?.('camera');
    const wp = new window.THREE.Vector3();
    const wq = new window.THREE.Quaternion();
    c?.getWorldPosition(wp);
    c?.getWorldQuaternion(wq);
    return {
      name: view.name || view.mode,
      mode: view.mode,
      local: c
        ? { x: c.position.x, y: c.position.y, z: c.position.z, rx: c.rotation.x, ry: c.rotation.y, rz: c.rotation.z }
        : null,
      world: { x: wp.x, y: wp.y, z: wp.z, qx: wq.x, qy: wq.y, qz: wq.z, qw: wq.w },
      nestedPos: nested
        ? { x: nested.position.x, y: nested.position.y, z: nested.position.z }
        : null,
      stickL: window.__STICK_L || null,
    };
  }, v);
  camLogs.push(log);
  await sleep(280);
  const preShot = await page.evaluate(() => {
    for (let i = 0; i < 4; i++) window.__BATTLEVR2_FP_INPUT__?.(1 / 60);
    const c = document.getElementById('camera')?.object3D;
    const nested = document.getElementById('camera')?.getObject3D?.('camera');
    const wp = new window.THREE.Vector3();
    nested?.updateMatrixWorld(true);
    nested?.getWorldPosition(wp);
    return {
      local: c
        ? { x: c.position.x, y: c.position.y, z: c.position.z, rx: c.rotation.x, ry: c.rotation.y }
        : null,
      nestedW: { x: wp.x, y: wp.y, z: wp.z },
    };
  });
  camLogs[camLogs.length - 1].preShot = preShot;
  // Live Playwright capture (preserveDrawingBuffer is off — do not toDataURL).
  await page.screenshot({ path: path.join(OUT, `${v.name}.png`) });
}

await page.evaluate(() => window.__STICK_HIDE_EXTRAS__?.(false));

const out = {
  metrics,
  camLogs,
  errors: errors.slice(0, 20),
  dir: OUT,
  shotBytes: Object.fromEntries(
    views.map((v) => {
      const p = path.join(OUT, `${v.name}.png`);
      return [v.name, fs.existsSync(p) ? fs.statSync(p).size : 0];
    })
  ),
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
process.exit(
  metrics.boarded &&
    metrics.attach &&
    metrics.handDist < 0.15 &&
    errors.length === 0 &&
    Object.values(out.shotBytes).every((n) => n > 50000)
    ? 0
    : 1
);
