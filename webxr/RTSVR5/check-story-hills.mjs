#!/usr/bin/env node
/**
 * Prove Story builds hills AFTER layout (mesh has macro lift), not flat plate.
 *   node RTSVR5/check-story-hills.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const f = path.normalize(path.join(ROOT, rel));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));
await page.goto(`http://127.0.0.1:${port}/index.html?perf=1`, {
  waitUntil: 'domcontentloaded', timeout: 120000,
});
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
await page.evaluate(() => {
  if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
  window._startGame('story');
});
await page.waitForFunction(() => {
  const o = document.getElementById('match-prepare-overlay');
  return !(o && !o.hidden);
}, null, { timeout: 300000 });
await page.waitForTimeout(4000);

const st = await page.evaluate(() => {
  const g = document.getElementById('ground');
  const mesh = g && g.getObject3D && g.getObject3D('mesh');
  const props = g && g.getObject3D && g.getObject3D('overviewProps');
  let minY = Infinity;
  let maxY = -Infinity;
  if (mesh) {
    mesh.updateMatrixWorld(true);
    mesh.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const pos = o.geometry.attributes && o.geometry.attributes.position;
      if (!pos) return;
      const v = new window.THREE.Vector3();
      for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 2000))) {
        v.fromBufferAttribute(pos, i);
        o.localToWorld(v);
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
      }
    });
  }
  const storyLog = (window.__rtsHudDiag && window.__rtsHudDiag.diag) || '';
  return {
    hasProps: !!props,
    kitKind: mesh && mesh.userData && mesh.userData.rtsKitKind,
    bake: !!(mesh && mesh.userData && mesh.userData.rtsSkirmishBake),
    yRange: Number.isFinite(minY) ? maxY - minY : 0,
    minY,
    maxY,
    diag: storyLog,
  };
});
await browser.close();
server.close();

const storyLine = logs.find((l) => l.includes('[Story] seed=')) || '';
const hillsMatch = /hills=(\d+)/.exec(storyLine);
const hills = hillsMatch ? +hillsMatch[1] : 0;

let fail = 0;
if (hills < 3) {
  console.error('FAIL Story layout has too few hills', { storyLine, hills });
  fail = 1;
}
if (st.hasProps) {
  console.error('FAIL Story should not keep skirmish rocks props', st);
  fail = 1;
}
if (st.kitKind) {
  console.error('FAIL Story should be hills mesh not kit', st);
  fail = 1;
}
// Hills mesh must have real vertical relief (flat rebuild bug was ~0–2m).
if (st.yRange < 8) {
  console.error('FAIL Story mesh looks flat — hills not stamped into geometry', st);
  fail = 1;
}
if (!fail) console.log('PASS Story hills', { hills, yRange: st.yRange, storyLine, diag: st.diag });
process.exit(fail);
