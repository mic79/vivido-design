#!/usr/bin/env node
/**
 * Far vs near kit visibility — catch join/LOD/culling holes.
 *   node RTSVR5/bench-kit-visibility.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8772);
const SHOT = path.join(ROOT, 'bench-kit-vis');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootMatch(page, mode) {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
  await page.evaluate(() => {
    if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
  });
  await sleep(400);
  await page.evaluate((m) => window._startGame(m), mode);
  await page.waitForFunction(() => {
    const overlay = document.getElementById('match-prepare-overlay');
    return !(overlay && !overlay.hidden);
  }, null, { timeout: 300000 });
  await sleep(800);
}

function dumpKit() {
  const THREE = window.THREE;
  const sc = document.querySelector('a-scene');
  const r = sc && sc.renderer;
  const groundEl = document.getElementById('ground');
  const mesh = groundEl && groundEl.getObject3D && groundEl.getObject3D('mesh');
  const box = new THREE.Box3();
  const out = {
    kind: (mesh && mesh.userData && mesh.userData.rtsKitKind) || null,
    visMesh: 0,
    visInst: 0,
    lod0Inst: 0,
    lod2Inst: 0,
    joined: 0,
    frustumOnInst: 0,
    span: [0, 0, 0],
    instSpan: [0, 0, 0],
    cam: null,
    fogOn: false,
    calls: r && r.info && r.info.render ? r.info.render.calls : 0,
    tris: r && r.info && r.info.render ? r.info.render.triangles : 0,
  };
  if (!mesh) return out;
  mesh.updateMatrixWorld(true);
  const camEl = document.getElementById('camera');
  const camObj = camEl && (camEl.getObject3D('camera') || camEl.object3D);
  if (camObj) {
    const p = new THREE.Vector3();
    camObj.getWorldPosition(p);
    out.cam = [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)];
  }
  const fog = sc && sc.object3D && sc.object3D.getObjectByName && sc.object3D.getObjectByName('rts-world-fog-unexplored');
  out.fogOn = !!(fog && fog.visible);
  const instBox = new THREE.Box3();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  let instAny = false;
  mesh.traverse((o) => {
    if (o.isInstancedMesh) {
      if (o.visible && o.count > 0) {
        out.visInst++;
        if (/_lod0$/i.test(o.name || '')) out.lod0Inst += o.count;
        if (/_lod2$/i.test(o.name || '')) out.lod2Inst += o.count;
        o.updateMatrixWorld(true);
        for (let i = 0; i < Math.min(o.count, 8); i++) {
          o.getMatrixAt(i, m);
          m.premultiply(o.matrixWorld);
          v.setFromMatrixPosition(m);
          instBox.expandByPoint(v);
          instAny = true;
        }
      }
      if (o.frustumCulled) out.frustumOnInst++;
      return;
    }
    if ((o.isMesh || o.isSkinnedMesh) && o.visible) {
      out.visMesh++;
      if (o.name === 'rts-overview-joined') out.joined++;
      if (o.geometry && o.name !== 'rts-kit-ground') box.expandByObject(o);
    }
  });
  if (!box.isEmpty()) {
    const s = box.max.clone().sub(box.min);
    out.span = [+s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1)];
  }
  if (instAny && !instBox.isEmpty()) {
    const s = instBox.max.clone().sub(instBox.min);
    out.instSpan = [+s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1)];
  }
  return out;
}

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });
  const server = await startStaticServer();
  const logs = [];
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  const rows = [];
  try {
    const p1 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    p1.on('console', (msg) => {
      const t = msg.text();
      if (/overview|kit distance|join|rejected/i.test(t)) logs.push(t);
    });
    await bootMatch(p1, '1v1');
    await p1.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
    });
    await sleep(300);
    const skirmish = await p1.evaluate(dumpKit);
    skirmish.label = '1v1-spawn';
    rows.push(skirmish);
    await p1.screenshot({ path: path.join(SHOT, '1v1-spawn.png') });
    await p1.close();

    const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    p2.on('console', (msg) => {
      const t = msg.text();
      if (/overview|kit distance|join|rejected/i.test(t)) logs.push(t);
    });
    await bootMatch(p2, 'story');
    await p2.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
      const cam = Input.getCameraState();
      cam.y = 55;
      cam.rotX = 0.72;
    });
    await sleep(400);
    const far = await p2.evaluate(dumpKit);
    far.label = 'story-far';
    rows.push(far);
    await p2.screenshot({ path: path.join(SHOT, 'story-far.png') });

    const nearTarget = await p2.evaluate(() => {
      const THREE = window.THREE;
      const groundEl = document.getElementById('ground');
      const root = groundEl && groundEl.getObject3D && groundEl.getObject3D('mesh');
      const camEl = document.getElementById('camera');
      const camObj = camEl && (camEl.getObject3D('camera') || camEl.object3D);
      if (!root || !camObj) return null;
      const cam = new THREE.Vector3();
      camObj.getWorldPosition(cam);
      const m = new THREE.Matrix4();
      let best = null;
      let bestD = Infinity;
      root.traverse((o) => {
        if (!o.isInstancedMesh || !o.visible || !o.count) return;
        o.updateMatrixWorld(true);
        const n = Math.min(o.count, 12);
        for (let i = 0; i < n; i++) {
          o.getMatrixAt(i, m);
          m.premultiply(o.matrixWorld);
          const e = m.elements;
          const d = Math.hypot(e[12] - cam.x, e[14] - cam.z);
          if (d > 8 && d < bestD) {
            bestD = d;
            best = { x: e[12], y: e[13], z: e[14], name: o.name, count: o.count, d: +d.toFixed(1) };
          }
        }
      });
      return best;
    });
    await p2.evaluate(async (t) => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
      const cam = Input.getCameraState();
      if (!t) {
        cam.y = 10;
        cam.rotX = 0.45;
        return;
      }
      cam.x = t.x + 10;
      cam.y = Math.max((t.y || 0) + 8, 10);
      cam.z = t.z + 10;
      cam.rotX = 0.4;
      cam.rotY = Math.atan2(-10, -10);
    }, nearTarget);
    await sleep(400);
    const near = await p2.evaluate(dumpKit);
    near.label = 'story-near';
    near.target = nearTarget;
    rows.push(near);
    await p2.screenshot({ path: path.join(SHOT, 'story-near.png') });
    await p2.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n=== kit visibility ===');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(14)} kind=${String(r.kind).padEnd(8)} calls=${r.calls} trisK=${((r.tris || 0) / 1000).toFixed(0)} ` +
        `visMesh=${r.visMesh} visInst=${r.visInst} lod0=${r.lod0Inst} lod2=${r.lod2Inst} ` +
        `frustumOnInst=${r.frustumOnInst} fog=${r.fogOn} cam=${JSON.stringify(r.cam)} ` +
        `span=${r.span.join('x')} instSpan=${(r.instSpan || []).join('x')}`
    );
  }
  if (rows[2] && rows[2].target) console.log('near target', rows[2].target);
  console.log('\nlogs:\n' + logs.join('\n'));
  const sk = rows.find((r) => r.label === '1v1-spawn');
  const far = rows.find((r) => r.label === 'story-far');
  const near = rows.find((r) => r.label === 'story-near');
  let fail = 0;
  if (sk && sk.visMesh + sk.visInst < 40) {
    console.error('FAIL 1v1 almost no visible kit meshes', sk);
    fail = 1;
  }
  if (far && near && near.lod2Inst + 50 < far.lod2Inst && near.lod0Inst < 10) {
    console.error('FAIL story near dropped lod2 without lod0', { far: far.lod2Inst, near: near.lod2Inst, lod0: near.lod0Inst });
    fail = 1;
  }
  fs.writeFileSync(path.join(ROOT, 'bench-kit-visibility.json'), JSON.stringify({ rows, logs }, null, 2));
  process.exit(fail);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
