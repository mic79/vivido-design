#!/usr/bin/env node
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = 9156;
const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
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

const diag = await page.evaluate(async () => {
  const cock = await import('./js/cockpit.js');
  const THREE = window.THREE;
  window.__BATTLEVR2_ENTER_VEHICLE__?.();
  await new Promise((r) => setTimeout(r, 80));
  const seat = cock.getSeatWorldPosition();
  const rig = document.getElementById('cameraRig');
  const cam = document.getElementById('camera');
  cam.object3D.position.set(0, 0, 0);
  rig.object3D.position.set(seat.x, seat.y, seat.z);
  rig.object3D.rotation.set(0, seat.yaw, 0);
  for (let i = 0; i < 25; i++) window.__BATTLEVR2_FP_INPUT__?.(1 / 60);
  cock.syncCockpitToVehicle();
  cock.refreshHandAttachPoses();
  const mb = document.getElementById('local-body')?.components?.['mixamo-body'];
  for (let i = 0; i < 25; i++) mb?.updateLocalBody?.(1 / 60);

  let steer = null;
  window.__BATTLEVR2_COCKPIT__?.scene?.traverse((o) => {
    if (o.name === 'steer-wrap') steer = o;
  });
  const sw = new THREE.Vector3();
  new THREE.Box3().setFromObject(steer).getCenter(sw);

  const sceneEl = document.querySelector('a-scene');
  const renderer = sceneEl.renderer;
  const scene = sceneEl.object3D;
  scene.updateMatrixWorld(true);

  const sumBuf = (buf) => {
    let sum = 0;
    let nonzero = 0;
    for (let i = 0; i < buf.length; i++) {
      sum += buf[i];
      if (buf[i]) nonzero++;
    }
    return { sum, nonzero };
  };

  const w = 320;
  const h = 180;
  const renderSum = (camera) => {
    const target = new THREE.WebGLRenderTarget(w, h);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    const buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
    renderer.setRenderTarget(prev);
    target.dispose();
    return sumBuf(buf);
  };

  const debugCam = new THREE.PerspectiveCamera(45, w / h, 0.02, 5000);
  debugCam.position.set(sw.x + 0.06, sw.y + 0.4, sw.z + 0.12);
  debugCam.up.set(0, 0, -1);
  debugCam.lookAt(sw);
  debugCam.updateMatrixWorld(true);

  cam.object3D.position.set(0, 0, 0);
  cam.object3D.rotation.set(-1.2, 0, 0);
  const live = cam.getObject3D('camera');

  // Also try rendering into the default framebuffer then reading via draw-buffer trick
  const gl = renderer.getContext();
  const attrs = gl.getContextAttributes?.();

  return {
    boarded: !!window.__BATTLEVR2_BOARDED__,
    stick: { x: sw.x, y: sw.y, z: sw.z },
    debugRt: renderSum(debugCam),
    liveRt: renderSum(live),
    kids: scene.children.length,
    preserve: attrs?.preserveDrawingBuffer,
    outputColorSpace: renderer.outputColorSpace,
  };
});

console.log(JSON.stringify(diag, null, 2));
await browser.close();
server.close();
