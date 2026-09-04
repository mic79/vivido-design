#!/usr/bin/env node
/**
 * Prove why 1v1 (rocks-only) can be slower than Story (full kit).
 * Same page: 1v1 → story → 1v1, force-render, shadows/MSAA off.
 *
 *   node RTSVR5/bench-1v1-vs-story.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8777);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 2000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'application/json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
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

function dumpGpu() {
  const sc = document.querySelector('a-scene');
  const r = sc && sc.renderer;
  window.__rtsForceRender = true;
  if (sc) sc.__rtsSkipRender = false;
  if (typeof window.__rtsUpdateKitLod === 'function') window.__rtsUpdateKitLod();
  if (r && sc && sc.object3D && sc.camera) {
    r.info.reset();
    r.render(sc.object3D, sc.camera);
  }
  const groundEl = document.getElementById('ground');
  const mesh = groundEl && groundEl.getObject3D && groundEl.getObject3D('mesh');
  const out = {
    kind: (mesh && mesh.userData && mesh.userData.rtsKitKind) || null,
    calls: r && r.info && r.info.render ? r.info.render.calls : 0,
    tris: r && r.info && r.info.render ? r.info.render.triangles : 0,
    memTex: r && r.info && r.info.memory ? r.info.memory.textures : 0,
    memGeo: r && r.info && r.info.memory ? r.info.memory.geometries : 0,
    programs: r && r.info && r.info.programs ? r.info.programs.length : 0,
    visInst: 0,
    visInstCount: 0,
    visMesh: 0,
    hidMesh: 0,
    units: 0,
    buildings: 0,
    sceneObj: 0,
    envMap: false,
    lights: 0,
    kitLog: window.__rtsLastKitReady || null,
  };
  if (sc && sc.object3D) {
    sc.object3D.traverse((o) => {
      out.sceneObj++;
      if (o.isLight) out.lights++;
    });
  }
  if (mesh) {
    mesh.traverse((o) => {
      if (o.isInstancedMesh) {
        if (o.visible && o.count > 0) {
          out.visInst++;
          out.visInstCount += o.count;
        }
        return;
      }
      if (o.isMesh || o.isSkinnedMesh) {
        if (o.name === 'rts-kit-ground') return;
        if (o.visible) out.visMesh++;
        else out.hidMesh++;
      }
    });
  }
  const THREE = window.THREE;
  if (THREE && sc && sc.object3D) {
    sc.object3D.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const mats = o.material == null ? [] : Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && m.envMap) out.envMap = true;
      }
    });
  }
  try {
    const State = window.__rtsStateDump;
    if (State) {
      out.units = State.units || 0;
      out.buildings = State.buildings || 0;
    }
  } catch (_) {}
  return out;
}

async function sample(page, label) {
  await page.evaluate(() => {
    window.__rtsForceRender = true;
    const sc = document.querySelector('a-scene');
    if (sc) sc.__rtsSkipRender = false;
    if (window.__rtsPerf) {
      window.__rtsPerf.setPerfEnabled(true);
      window.__rtsPerf.resetSamples();
    }
  });
  await sleep(SAMPLE_MS);
  const gpu = await page.evaluate(dumpGpu);
  const perf = await page.evaluate(() => (window.__rtsPerf ? window.__rtsPerf.snapshot() : null));
  const counts = await page.evaluate(async () => {
    const State = await import('./js/state.js');
    return { units: State.units.size, buildings: State.buildings.size };
  });
  const g = (perf && perf.gpu) || {};
  return {
    label,
    ...gpu,
    ...counts,
    fps: perf && (perf.fpsAvg ?? perf.fps),
    callsAvg: g.callsAvg,
    trisAvg: g.trisAvg,
  };
}

async function startMode(page, mode) {
  await page.evaluate(async (m) => {
    if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(false);
    if (typeof window._setMsaa4xEnabled === 'function') window._setMsaa4xEnabled(false);
    window._startGame(m);
  }, mode);
  await page.waitForFunction(() => {
    const overlay = document.getElementById('match-prepare-overlay');
    return !(overlay && !overlay.hidden);
  }, null, { timeout: 300000 });
  await sleep(800);
  await page.evaluate(async () => {
    const Input = await import('./js/input.js');
    Input.positionCameraForPlayer(0);
  });
  await sleep(300);
}

async function main() {
  const server = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
  });
  const rows = [];
  const fetched = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', (msg) => {
      const t = msg.text();
      if (/kit ready|kit distance LOD|overview kit file|kit terrain|groundscape|overviewProps/i.test(t)) {
        console.log('  [page]', t);
      }
    });
    page.on('request', (req) => {
      const u = req.url();
      if (/\.glb(\?|$)/i.test(u)) fetched.push(u.replace(/^.*\//, ''));
    });
    await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });
    await sleep(500);

    await startMode(page, '1v1');
    rows.push(await sample(page, '1v1-first'));
    const shot1 = path.join(ROOT, 'bench-poses', '1v1-spawn.png');
    fs.mkdirSync(path.dirname(shot1), { recursive: true });
    await page.screenshot({ path: shot1 });

    await startMode(page, 'story');
    rows.push(await sample(page, 'story'));
    const shotS = path.join(ROOT, 'bench-poses', 'story-spawn.png');
    await page.screenshot({ path: shotS });

    await startMode(page, '1v1');
    rows.push(await sample(page, '1v1-again'));
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n=== GLB fetches ===');
  console.log([...new Set(fetched)].join(', '));

  console.log('\n=== 1v1 vs Story (forced render) ===');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(12)} kind=${String(r.kind).padEnd(8)} ` +
        `calls=${r.calls} callsAvg=${Math.round(r.callsAvg || 0)} trisK=${((r.tris || 0) / 1000).toFixed(0)} ` +
        `fps=${r.fps != null ? Number(r.fps).toFixed(0) : '-'} ` +
        `tex=${r.memTex} geo=${r.memGeo} prog=${r.programs} ` +
        `visInst=${r.visInst}/${r.visInstCount} visMesh=${r.visMesh} hidMesh=${r.hidMesh} ` +
        `units=${r.units} bld=${r.buildings} sceneObj=${r.sceneObj} envMap=${r.envMap}`
    );
  }
  fs.writeFileSync(path.join(ROOT, 'bench-1v1-vs-story.json'), JSON.stringify({ rows, fetched: [...new Set(fetched)] }, null, 2));

  const a = rows.find((r) => r.label === '1v1-first');
  const s = rows.find((r) => r.label === 'story');
  const b = rows.find((r) => r.label === '1v1-again');
  let fail = 0;
  if (fetched.some((f) => /scifi-overview-lods/i.test(f))) {
    console.error('FAIL fetched full Overview lods GLB during bench');
    fail = 1;
  }
  if (a && a.kind !== 'story') {
    console.error('FAIL 1v1 should use story kit scenery', a.kind);
    fail = 1;
  }
  if (s && s.kind !== 'story') {
    console.error('FAIL story kind wrong', s.kind);
    fail = 1;
  }
  if (a && s && Math.abs(a.memTex - s.memTex) > 30) {
    console.error('FAIL 1v1/Story texture mismatch', { aTex: a.memTex, sTex: s.memTex });
    fail = 1;
  }
  if (b && a && b.memTex > a.memTex + 25) {
    console.error('FAIL story→1v1 leaked textures', { first: a.memTex, again: b.memTex });
    fail = 1;
  }
  if (!fail) console.log('PASS 1v1 and Story share story kit scenery');
  process.exit(fail);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
