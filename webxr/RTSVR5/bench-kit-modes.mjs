#!/usr/bin/env node
/**
 * Compare Story vs Skirmish kit GPU cost (draws/tris/LOD mix), not object count.
 *
 *   node RTSVR5/bench-kit-modes.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8771);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 1800);

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
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    try {
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
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dumpKit(page, label) {
  const kit = await page.evaluate(() => {
    const sc = document.querySelector('a-scene');
    const r = sc && sc.renderer;
    const groundEl = document.getElementById('ground');
    const mesh = groundEl && groundEl.getObject3D && groundEl.getObject3D('mesh');
    const out = {
      kind: (mesh && mesh.userData && mesh.userData.rtsKitKind) || null,
      combinedLod: !!(mesh && mesh.userData && mesh.userData.rtsLod0Root),
      lod0RootInScene: false,
      visInst: 0,
      hidInst: 0,
      visMesh: 0,
      hidMesh: 0,
      joined: 0,
      lod0Batches: 0,
      lod2Batches: 0,
      lod0Inst: 0,
      lod2Inst: 0,
      indoorNameHits: 0,
      frustumOff: 0,
      calls: r && r.info && r.info.render ? r.info.render.calls : 0,
      tris: r && r.info && r.info.render ? r.info.render.triangles : 0,
      memGeo: r && r.info && r.info.memory ? r.info.memory.geometries : 0,
      memTex: r && r.info && r.info.memory ? r.info.memory.textures : 0,
      sceneObj: 0,
      kitNames: [],
    };
    if (mesh && mesh.userData && mesh.userData.rtsLod0Root) {
      let p = mesh.userData.rtsLod0Root;
      while (p) {
        if (p === mesh) {
          out.lod0RootInScene = true;
          break;
        }
        p = p.parent;
      }
    }
    const scene = sc && sc.object3D;
    if (scene) {
      scene.traverse((o) => {
        out.sceneObj++;
        if (o.name === 'rts-overview-kit' || o.name === 'rts-story-kit') out.kitNames.push(o.name + (o.visible ? ':vis' : ':hid'));
      });
    }
    if (!mesh) return out;
    mesh.traverse((o) => {
      if (o.isInstancedMesh) {
        const n = o.count || 0;
        const vis = o.visible && n > 0;
        if (vis) out.visInst++;
        else out.hidInst++;
        if (!o.frustumCulled) out.frustumOff++;
        if (/_lod0$/i.test(o.name || '')) {
          if (vis) {
            out.lod0Batches++;
            out.lod0Inst += n;
          }
        } else if (/_lod2$/i.test(o.name || '')) {
          if (vis) {
            out.lod2Batches++;
            out.lod2Inst += n;
          }
        }
      } else if (o.isMesh || o.isSkinnedMesh) {
        if (o.name === 'rts-overview-joined') out.joined++;
        if (o.visible) out.visMesh++;
        else out.hidMesh++;
      }
      const n = `${o.name || ''} ${o.parent && o.parent.name ? o.parent.name : ''}`;
      if (/Indoor/i.test(n) && o.visible) out.indoorNameHits++;
    });
    return out;
  });
  const snap = await page.evaluate(() => {
    if (!window.__rtsPerf) return null;
    window.__rtsPerf.setPerfEnabled(true);
    window.__rtsPerf.resetSamples();
    return true;
  });
  if (snap) await sleep(SAMPLE_MS);
  const perf = await page.evaluate(() => (window.__rtsPerf ? window.__rtsPerf.snapshot() : null));
  const gpu = (perf && perf.gpu) || {};
  return {
    label,
    ...kit,
    fps: perf && (perf.fpsAvg ?? perf.fps),
    callsAvg: gpu.callsAvg,
    trisAvg: gpu.trisAvg,
  };
}

function print(rows) {
  console.log('\n=== kit mode GPU ===');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(18)} kind=${String(r.kind).padEnd(8)} calls=${Math.round(r.callsAvg || r.calls || 0)} trisK=${((r.trisAvg || r.tris || 0) / 1000).toFixed(0)} fps~${(r.fps || 0).toFixed(0)} ` +
        `lod0=${r.lod0Inst}/${r.lod0Batches}b lod2=${r.lod2Inst}/${r.lod2Batches}b visMesh=${r.visMesh} joined=${r.joined || 0} inst=${r.visInst} ` +
        `frustumOff=${r.frustumOff} indoor=${r.indoorNameHits} tex=${r.memTex} geo=${r.memGeo} kits=${(r.kitNames || []).join(',') || '-'} combined=${r.combinedLod}`
    );
  }
}

async function boot(page, mode) {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
  await page.evaluate(() => {
    if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
  });
  await sleep(800);
  const menu = await dumpKit(page, `${mode}-menu`);
  await page.evaluate(async (m) => {
    if (typeof window._startGame !== 'function') throw new Error('no _startGame');
    window._startGame(m);
  }, mode);
  await page.waitForFunction(() => {
    const overlay = document.getElementById('match-prepare-overlay');
    return !(overlay && !overlay.hidden);
  }, null, { timeout: 300000 });
  await sleep(1500);
  await page.evaluate(async () => {
    const Input = await import('./js/input.js');
    const State = await import('./js/state.js');
    if (typeof Input.positionCameraForPlayer === 'function') {
      Input.positionCameraForPlayer(State.gameSession.myPlayerId || 0);
    }
  });
  await sleep(400);
  const match = await dumpKit(page, `${mode}-match`);
  return [menu, match];
}

async function main() {
  const server = await startStaticServer();
  console.log(`Serving ${ROOT} at http://127.0.0.1:${PORT}/`);
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
  });
  const rows = [];
  try {
    const p1 = await browser.newPage();
    rows.push(...(await boot(p1, '1v1')));
    await p1.close();
    const p2 = await browser.newPage();
    rows.push(...(await boot(p2, 'story')));
    await p2.close();
  } finally {
    await browser.close();
    server.close();
  }
  print(rows);
  fs.writeFileSync(path.join(ROOT, 'bench-kit-modes.json'), JSON.stringify({ when: new Date().toISOString(), rows }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
