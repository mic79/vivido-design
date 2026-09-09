#!/usr/bin/env node
/** Debug why hero LM isn't visible. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8835;
const VER = fs
  .readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/name="rts-version"\s+content="([^"]+)"/)?.[1];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.hdr': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) {
    res.writeHead(404);
    return res.end('missing');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&scenery=B0&v=${VER}`, {
  waitUntil: 'domcontentloaded',
  timeout: 180000,
});
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
await page.evaluate(() => window._dismissAppStartGate?.());
await page.waitForTimeout(400);
await page.evaluate(() => {
  window._setDynamicShadowsEnabled?.(false);
  window._startGame('1v1');
});
await page.waitForFunction(() => {
  const o = document.getElementById('match-prepare-overlay');
  return !(o && !o.hidden);
}, null, { timeout: 300000 });
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const THREE = window.THREE;
  const out = [];
  document.querySelector('a-scene')?.object3D?.traverse((o) => {
    if (!o.isMesh) return;
    if (!/circularplatform|pump_merged/i.test(o.name || '')) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const prog = m.userData?.shader || null;
      // Force compile
      const renderer = document.querySelector('a-scene')?.renderer;
      if (renderer && m) {
        // touch
      }
      const hasUv2 = !!o.geometry?.attributes?.uv2;
      let uv2Sample = null;
      if (hasUv2) {
        const a = o.geometry.attributes.uv2;
        uv2Sample = [a.getX(0), a.getY(0), a.getX((a.count / 2) | 0), a.getY((a.count / 2) | 0)];
      }
      out.push({
        name: o.name,
        type: m.type,
        heroLm: !!m.userData?.rtsHeroLm,
        applied: !!o.userData?.rtsHeroLmApplied,
        hasLightMap: !!m.lightMap,
        lmIntensity: m.lightMapIntensity,
        metalness: m.metalness,
        hasUv2,
        uv2Sample,
        cacheKey: m.customProgramCacheKey?.() || null,
        fragHasHero: null,
        fragHasAo: null,
      });
    }
  });

  // Compile one material via a throwaway render
  const scene = document.querySelector('a-scene');
  const gl = scene?.renderer;
  const cam = document.getElementById('camera')?.getObject3D('camera');
  if (gl && cam) {
    gl.compile(scene.object3D, cam);
  }

  // After compile, programs may be on material
  for (const row of out) {
    // find mesh again
  }
  document.querySelector('a-scene')?.object3D?.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m?.userData?.rtsHeroLm) continue;
      const p = gl?.properties?.get(m);
      const prog = p?.program || p?.currentProgram;
      const frag = prog?.fragmentShader || m.userData?.frag || '';
      // three stores shaders differently — try renderer.info
      const row = out.find((r) => r.name === o.name && r.heroLm);
      if (!row) continue;
      // Hook: read from last onBeforeCompile by re-triggering
    }
  });

  // Re-apply patch probe: call onBeforeCompile manually
  const probe = [];
  document.querySelector('a-scene')?.object3D?.traverse((o) => {
    if (!o.isMesh || !/circularplatform/i.test(o.name || '')) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m?.onBeforeCompile) return;
    const fake = {
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader:
        '#include <common>\n#include <aomap_fragment>\n#include <lights_fragment_end>\n#include <opaque_fragment>\n',
      uniforms: {},
    };
    m.onBeforeCompile(fake);
    probe.push({
      name: o.name,
      hasHero: fake.fragmentShader.includes('heroLmMul'),
      hasAoInclude: fake.fragmentShader.includes('#include <aomap_fragment>'),
      snippet: fake.fragmentShader.slice(0, 400),
    });
  });

  return { count: out.length, samples: out.slice(0, 6), probe: probe.slice(0, 3) };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
server.close();
