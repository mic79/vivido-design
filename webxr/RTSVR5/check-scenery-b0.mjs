#!/usr/bin/env node
/**
 * Prove 1v1 default = crater moon + Quest rocks props (B0), not kit-as-terrain.
 *   node RTSVR5/check-scenery-b0.mjs
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

const fetched = [];
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  fetched.push(rel);
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
  window._startGame('1v1');
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
  return {
    bake: !!(mesh && mesh.userData && mesh.userData.rtsSkirmishBake),
    kitKind: mesh && mesh.userData && mesh.userData.rtsKitKind,
    propsMode: props && props.userData && props.userData.rtsSceneryMode,
    propsUrl: props && props.userData && props.userData.rtsKitUrl,
    diag: window.__rtsHudDiag && window.__rtsHudDiag.diag,
  };
});
await browser.close();
server.close();

const gotMoon = fetched.some((u) => u.includes('terrain-skirmish-ue-lm.glb'));
const gotQuest = fetched.some((u) => u.includes('scifi-rts-quest.glb'));
const gotKitTerrain = fetched.some((u) => u.includes('scifi-rts-kit-lod2.glb'));
const propsLog = logs.find((l) => l.includes('skirmish scenery props')) || '';

let fail = 0;
if (!gotMoon || !st.bake) {
  console.error('FAIL moon bake not loaded', { gotMoon, st });
  fail = 1;
}
if (!gotQuest || st.propsMode !== 'B0') {
  console.error('FAIL quest rocks props not B0', { gotQuest, st, propsLog });
  fail = 1;
}
if (st.kitKind) {
  console.error('FAIL kit-as-terrain should not be default mesh', st);
  fail = 1;
}
if (gotKitTerrain) {
  console.error('FAIL lod2 kit should not load on B0 default');
  fail = 1;
}
if (!fail) console.log('PASS B0 moon + quest rocks props', { propsUrl: st.propsUrl, diag: st.diag, propsLog });
process.exit(fail);
