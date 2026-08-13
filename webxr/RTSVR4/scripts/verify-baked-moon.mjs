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
    const boxOf = (obj) => {
      const box = new THREE.Box3().setFromObject(obj);
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
        box: boxOf(o),
      };
      meshes.push(rec);
      if (/^Moon_0/i.test(o.name)) plate = rec.box;
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
  if (!info) throw new Error(`${label}: no baked ground`);
  if (!info.plate) throw new Error(`${label}: plate missing`);
  const [sx, sy, sz] = info.plate.size;
  const cy = info.plate.center[1];
  if (sy > 80) throw new Error(`${label}: plate height span ${sy.toFixed(1)}m — still Z-up / vertical`);
  if (sx < 150 || sz < 150) throw new Error(`${label}: plate XZ too small ${sx.toFixed(1)}×${sz.toFixed(1)}`);
  if (Math.abs(cy) > 40) throw new Error(`${label}: plate center Y=${cy.toFixed(1)} not under units`);
  const skirts = info.meshes.find((m) => /^Moon_1/i.test(m.name));
  if (!skirts) throw new Error(`${label}: skirts missing`);
  if (skirts.box.max[1] > 40) {
    throw new Error(`${label}: skirts peak Y=${skirts.box.max[1].toFixed(1)} — drop flipped into the sky`);
  }
  if (Math.abs(info.rotY ?? 0) > 0.05) {
    throw new Error(`${label}: expected no yaw (LM unused), got ${info.rotY}`);
  }
  if (
    !info.meshes.every(
      (m) =>
        m.mat === 'MeshLambertMaterial' &&
        m.cheap &&
        m.hasMap &&
        m.hasNormal &&
        m.receiveShadow === false
    )
  ) {
    throw new Error(`${label}: baked moon must be Lambert + normal, no PCF, got ${JSON.stringify(info.meshes)}`);
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


const ready = logs.find((l) => l.includes('baked moon ready') || l.includes('skip baked moon')) || null;
const errors = logs.filter((l) => /pageerror|skip baked/i.test(l)).slice(0, 20);
console.log(JSON.stringify({ ready, startInfo, menuInfo, startLum, errors }, null, 2));

try {
  if (!ready || !ready.includes('baked moon ready')) throw new Error('baked moon did not load');
  assertGroundLiesOnXz(startInfo, 'start');
  assertGroundLiesOnXz(menuInfo, 'menu');
  if (!startLum || startLum.err) throw new Error(`start luminance: ${startLum && startLum.err}`);
  if (startLum.n < 50) throw new Error(`start terrain sample empty ${JSON.stringify(startLum)}`);
  if (startLum.avg < 28) throw new Error(`start terrain too dark (black/failed shader) avg=${startLum.avg.toFixed(1)}`);
  if (startLum.avg > 210) throw new Error(`start terrain blown out avg=${startLum.avg.toFixed(1)}`);
  if (startLum.std < 6) {
    throw new Error(`start terrain too flat (normals/albedo not reading) std=${startLum.std.toFixed(2)}`);
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
