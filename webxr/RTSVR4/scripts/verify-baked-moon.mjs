#!/usr/bin/env node
/** Visual gate: Start screen + menu must show moon UNDER the lobby units, not as a planet in the corner. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8778);
const SHOT_DIR = path.join(ROOT, 'bench-poses');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

function moonWorldBox(page) {
  return page.evaluate(() => {
    const THREE = window.THREE;
    const ground = document.getElementById('ground');
    const root = ground && ground.getObject3D && ground.getObject3D('mesh');
    if (!THREE || !root) return null;
    root.updateMatrixWorld(true);
    const boxOf = (obj, selfOnly) => {
      const box = new THREE.Box3();
      if (selfOnly && obj.isMesh && obj.geometry) {
        obj.updateMatrixWorld(true);
        if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        box.copy(obj.geometry.boundingBox);
        box.applyMatrix4(obj.matrixWorld);
      } else {
        box.setFromObject(obj);
      }
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      return {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
        size: [size.x, size.y, size.z],
        center: [center.x, center.y, center.z],
      };
    };
    const meshes = [];
    let plate = null;
    root.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const rec = {
        name: o.name,
        verts: o.geometry?.attributes?.position?.count || 0,
        mat: o.material?.type,
        cheap: !!(o.material && o.material.userData && o.material.userData.cheapMoonLook),
        hasMap: !!(o.material && o.material.map),
        hasNormal: !!(o.material && o.material.normalMap),
        receiveShadow: !!o.receiveShadow,
        box: boxOf(o, o.name === 'rts-ground-mesh' || /^Moon_0/i.test(o.name)),
      };
      meshes.push(rec);
      if (o.name === 'rts-ground-mesh' || /^Moon_0/i.test(o.name)) plate = rec.box;
    });
    return {
      rootName: root.name,
      rotX: root.rotation?.x ?? null,
      rotY: root.rotation?.y ?? null,
      childRotX: root.children?.[0]?.rotation?.x ?? null,
      root: boxOf(root),
      plate,
      meshes,
    };
  });
}

async function pngDarkerFrac(browser, onPath, offPath, crop) {
  const onBuf = fs.readFileSync(onPath);
  const offBuf = fs.readFileSync(offPath);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(
    `<img id="a" src="data:image/png;base64,${onBuf.toString('base64')}">
     <img id="b" src="data:image/png;base64,${offBuf.toString('base64')}">`,
    { waitUntil: 'load' }
  );
  const r = await page.evaluate((c) => {
    const ia = document.getElementById('a');
    const ib = document.getElementById('b');
    const ca = document.createElement('canvas');
    ca.width = ia.naturalWidth;
    ca.height = ia.naturalHeight;
    const cb = document.createElement('canvas');
    cb.width = ib.naturalWidth;
    cb.height = ib.naturalHeight;
    ca.getContext('2d').drawImage(ia, 0, 0);
    cb.getContext('2d').drawImage(ib, 0, 0);
    const da = ca.getContext('2d').getImageData(c.x, c.y, c.w, c.h).data;
    const db = cb.getContext('2d').getImageData(c.x, c.y, c.w, c.h).data;
    let mad = 0;
    let darker = 0;
    const n = da.length / 4;
    for (let i = 0; i < da.length; i += 4) {
      const la = 0.2126 * da[i] + 0.7152 * da[i + 1] + 0.0722 * da[i + 2];
      const lb = 0.2126 * db[i] + 0.7152 * db[i + 1] + 0.0722 * db[i + 2];
      mad += Math.abs(la - lb);
      if (la < lb - 8) darker++;
    }
    return { mad: mad / n, darkerFrac: darker / n, n };
  }, crop);
  await page.close();
  return r;
}

async function pngTerrainLum(browser, shotPath) {
  const buf = fs.readFileSync(shotPath);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(
    `<img id="s" src="data:image/png;base64,${buf.toString('base64')}">`,
    { waitUntil: 'load' }
  );
  const lum = await page.evaluate(() => {
    const img = document.getElementById('s');
    if (!img || !img.naturalWidth) return { err: 'no image' };
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const x = 48;
    const y = Math.floor(c.height * 0.38);
    const pw = 240;
    const ph = 220;
    const id = ctx.getImageData(x, y, pw, ph).data;
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    let min = 255;
    let max = 0;
    for (let i = 0; i < id.length; i += 4) {
      const lum = 0.2126 * id[i] + 0.7152 * id[i + 1] + 0.0722 * id[i + 2];
      if (lum < 3) continue;
      sum += lum;
      sum2 += lum * lum;
      n++;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }
    const avg = n ? sum / n : 0;
    const std = n ? Math.sqrt(Math.max(0, sum2 / n - avg * avg)) : 0;
    return { w: c.width, h: c.height, n, avg, std, min: n ? min : 0, max: n ? max : 0 };
  });
  await page.close();
  return lum;
}

function assertGroundLiesOnXz(info, label) {
  if (!info) throw new Error(`${label}: no ground`);
  if (!info.plate) throw new Error(`${label}: plate missing`);
  const [sx, sy, sz] = info.plate.size;
  const cy = info.plate.center[1];
  if (sy > 80) throw new Error(`${label}: plate height span ${sy.toFixed(1)}m — still Z-up / vertical`);
  if (sx < 150 || sz < 150) throw new Error(`${label}: plate XZ too small ${sx.toFixed(1)}×${sz.toFixed(1)}`);
  if (Math.abs(cy) > 40) throw new Error(`${label}: plate center Y=${cy.toFixed(1)} not under units`);
  const skirts = info.meshes.find(
    (m) => /^Moon_1/i.test(m.name) || (m.name !== 'rts-ground-mesh' && m.verts > 200)
  );
  if (!skirts) throw new Error(`${label}: skirts missing`);
  if (skirts.box.max[1] > 80) {
    throw new Error(`${label}: skirts peak Y=${skirts.box.max[1].toFixed(1)} — drop flipped into the sky`);
  }
  if (
    !info.meshes.every(
      (m) => m.mat === 'MeshLambertMaterial' && m.cheap && m.hasMap && m.hasNormal
    )
  ) {
    throw new Error(`${label}: moon must be Lambert + normal, got ${JSON.stringify(info.meshes)}`);
  }
}

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`pageerror: ${err.message}`));
fs.mkdirSync(SHOT_DIR, { recursive: true });

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 60000 });
await page.waitForTimeout(600);

const startInfo = await moonWorldBox(page);
const startShot = path.join(SHOT_DIR, 'baked-moon-start.png');
await page.screenshot({ path: startShot, type: 'png' });
const startLum = await pngTerrainLum(browser, startShot);

const camSave = await page.evaluate(() => {
  const cam = document.getElementById('camera');
  const rig = document.getElementById('cameraRig');
  const saved = {
    rig: rig ? [rig.object3D.position.x, rig.object3D.position.y, rig.object3D.position.z] : null,
    cam: cam ? [cam.object3D.rotation.x, cam.object3D.rotation.y, cam.object3D.rotation.z] : null,
  };
  if (rig) rig.object3D.position.set(0, 140, 0);
  if (cam) cam.object3D.rotation.set(-Math.PI / 2, 0, 0);
  return saved;
});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(SHOT_DIR, 'baked-moon-lookdown.png'), type: 'png' });
await page.evaluate((saved) => {
  const cam = document.getElementById('camera');
  const rig = document.getElementById('cameraRig');
  if (rig && saved.rig) rig.object3D.position.set(saved.rig[0], saved.rig[1], saved.rig[2]);
  if (cam && saved.cam) cam.object3D.rotation.set(saved.cam[0], saved.cam[1], saved.cam[2]);
}, camSave);

await page.evaluate(() => {
  if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
});
await page.waitForTimeout(800);
const menuInfo = await moonWorldBox(page);
await page.screenshot({ path: path.join(SHOT_DIR, 'baked-moon-menu.png'), type: 'png' });

await page.evaluate(() => {
  if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(true);
});
await page.waitForTimeout(500);
const shadowOn = await page.evaluate(() => {
  const scene = document.querySelector('a-scene');
  const sm = scene && scene.renderer && scene.renderer.shadowMap;
  const ground = document.getElementById('ground');
  const moon = ground && ground.getObject3D && ground.getObject3D('mesh');
  let moonReceive = false;
  let lightCast = false;
  if (moon) {
    moon.traverse((o) => {
      if (o.isMesh && o.receiveShadow) moonReceive = true;
    });
  }
  scene && scene.object3D && scene.object3D.traverse((o) => {
    if (o.isDirectionalLight && o.castShadow) lightCast = true;
  });
  return {
    smEnabled: !!(sm && sm.enabled),
    moonReceive,
    lightCast,
    pref: typeof window._getDynamicShadowsEnabled === 'function' ? window._getDynamicShadowsEnabled() : null,
  };
});
await page.screenshot({ path: path.join(SHOT_DIR, 'shadows-on.png'), type: 'png' });

await page.evaluate(() => {
  if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(false);
});
await page.waitForTimeout(700);
const shadowOff = await page.evaluate(() => {
  const scene = document.querySelector('a-scene');
  const sm = scene && scene.renderer && scene.renderer.shadowMap;
  const ground = document.getElementById('ground');
  const moon = ground && ground.getObject3D && ground.getObject3D('mesh');
  let moonReceive = false;
  let lightCast = false;
  if (moon) {
    moon.traverse((o) => {
      if (o.isMesh && o.receiveShadow) moonReceive = true;
    });
  }
  scene && scene.object3D && scene.object3D.traverse((o) => {
    if (o.isDirectionalLight && o.castShadow) lightCast = true;
  });
  return { smEnabled: !!(sm && sm.enabled), moonReceive, lightCast };
});
await page.screenshot({ path: path.join(SHOT_DIR, 'shadows-off.png'), type: 'png' });

await page.evaluate(() => {
  if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(true);
});
await page.evaluate(() => {
  if (typeof window._startGame !== 'function') throw new Error('no _startGame');
  window._startGame('1v1');
});
await page.waitForFunction(() => {
  const overlay = document.getElementById('match-prepare-overlay');
  return !(overlay && !overlay.hidden);
}, null, { timeout: 180000 });
await page.waitForTimeout(900);
await page.evaluate(async () => {
  const State = await import('./js/state.js');
  if (!State.gameSession.gameStarted) throw new Error('game did not start');
  const myId = State.gameSession.myPlayerId;
  let hx = 0;
  let hz = 0;
  let found = false;
  State.buildings.forEach((b) => {
    if (found) return;
    if (b.ownerId === myId && b.type === 'hq') {
      hx = b.x;
      hz = b.z;
      found = true;
    }
  });
  if (!found) {
    const spawn = State.players[myId]?.spawn;
    if (spawn) {
      hx = spawn.x;
      hz = spawn.z;
    }
  }
  const rig = document.getElementById('cameraRig');
  const cam = document.getElementById('camera');
  if (rig) {
    rig.object3D.position.set(hx, 28, hz + 38);
    rig.object3D.rotation.set(0, 0, 0);
  }
  if (cam) cam.object3D.rotation.set(-0.55, 0, 0);
});
await page.waitForTimeout(700);
const matchOnPath = path.join(SHOT_DIR, 'shadows-on-match.png');
await page.screenshot({ path: matchOnPath, type: 'png' });
const matchOnFlags = await page.evaluate(() => {
  const scene = document.querySelector('a-scene');
  const sm = scene && scene.renderer && scene.renderer.shadowMap;
  const ground = document.getElementById('ground');
  const moon = ground && ground.getObject3D && ground.getObject3D('mesh');
  let moonReceive = false;
  let casterN = 0;
  let mapN = 0;
  let lightCast = false;
  if (moon) {
    moon.traverse((o) => {
      if (o.isMesh && o.receiveShadow) moonReceive = true;
    });
  }
  scene && scene.object3D && scene.object3D.traverse((o) => {
    if (o.castShadow && (o.isMesh || o.isInstancedMesh || o.isSkinnedMesh)) casterN += 1;
    if (o.isDirectionalLight) {
      if (o.castShadow) lightCast = true;
      if (o.shadow && o.shadow.map) mapN += 1;
    }
  });
  return {
    smEnabled: !!(sm && sm.enabled),
    smAuto: !!(sm && sm.autoUpdate),
    moonReceive,
    lightCast,
    casterN,
    mapN,
  };
});
await page.evaluate(() => {
  if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(false);
});
await page.waitForTimeout(700);
const matchOffPath = path.join(SHOT_DIR, 'shadows-off-match.png');
await page.screenshot({ path: matchOffPath, type: 'png' });
await page.evaluate(() => {
  if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(true);
});

const ready = logs.find((l) => l.includes('baked moon ready') || l.includes('skip baked moon')) || null;
const errors = logs.filter((l) => /pageerror|skip baked/i.test(l)).slice(0, 20);
console.log(JSON.stringify({ ready, startInfo, menuInfo, startLum, shadowOn, shadowOff, matchOnFlags, errors }, null, 2));

try {
  if (ready && /skip baked moon: decimated|skip baked moon: file too small/.test(ready)) {
    throw new Error(`baked fallback failed unexpectedly: ${ready}`);
  }
  if (!startInfo || startInfo.meshes.length < 2) throw new Error('moon plate+skirts did not load');
  assertGroundLiesOnXz(startInfo, 'start');
  assertGroundLiesOnXz(menuInfo, 'menu');
  if (!startLum || startLum.err) throw new Error(`start luminance: ${startLum && startLum.err}`);
  if (startLum.n < 50) throw new Error(`start terrain sample empty ${JSON.stringify(startLum)}`);
  if (startLum.avg < 28) throw new Error(`start terrain too dark (black/failed shader) avg=${startLum.avg.toFixed(1)}`);
  if (startLum.avg > 210) throw new Error(`start terrain blown out avg=${startLum.avg.toFixed(1)}`);
  if (startLum.std < 6) {
    throw new Error(`start terrain too flat (normals/albedo not reading) std=${startLum.std.toFixed(2)}`);
  }
  if (!shadowOn || !shadowOn.smEnabled || !shadowOn.moonReceive || !shadowOn.lightCast) {
    throw new Error(`shadows ON did not enable ground receive: ${JSON.stringify(shadowOn)}`);
  }
  if (!shadowOff || shadowOff.smEnabled || shadowOff.moonReceive || shadowOff.lightCast) {
    throw new Error(`shadows OFF still paying PCF: ${JSON.stringify(shadowOff)}`);
  }
  if (!matchOnFlags || !matchOnFlags.smEnabled || !matchOnFlags.moonReceive) {
    throw new Error(`match shadows ON lost receive: ${JSON.stringify(matchOnFlags)}`);
  }
  const blob = await pngDarkerFrac(browser, matchOnPath, matchOffPath, {
    x: 520,
    y: 280,
    w: 240,
    h: 220,
  });
  if (!blob || blob.darkerFrac < 0.04 || blob.mad < 1.5) {
    throw new Error(`match Shadows ON did not darken ground under HQ: ${JSON.stringify(blob)}`);
  }
} catch (err) {
  console.error('FAIL:', err.message);
  await browser.close();
  server.close();
  process.exit(1);
}

await browser.close();
server.close();
console.log('PASS');
