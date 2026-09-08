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
  let propMeshes = 0;
  if (props) props.traverse((o) => { if (o.isMesh) propMeshes++; });
  return {
    bake: !!(mesh && mesh.userData && mesh.userData.rtsSkirmishBake),
    kitKind: mesh && mesh.userData && mesh.userData.rtsKitKind,
    propsMode: props && props.userData && props.userData.rtsSceneryMode,
    propsUrl: props && props.userData && props.userData.rtsKitUrl,
    seated: !!(props && props.userData && props.userData.rtsSeatedOnCrater),
    propMeshes,
    diag: window.__rtsHudDiag && window.__rtsHudDiag.diag,
  };
});

// Rematch path: re-attach B0 twice — must keep combined seated props (not quest GLB).
const rematch = await page.evaluate(async () => {
  const g = document.getElementById('ground');
  const sceneEl = document.querySelector('a-scene');
  const ensure = window.__rtsEnsureSkirmishSceneryProps;
  if (typeof ensure !== 'function') return { error: 'no ensure hook' };
  if (window.State && window.State.gameSession) {
    window.State.gameSession.matchPreparing = true;
    window.State.gameSession.gameStarted = true;
  }
  await ensure(g, sceneEl);
  await ensure(g, sceneEl);
  const props = g.getObject3D('overviewProps');
  return {
    propsUrl: props && props.userData && props.userData.rtsKitUrl,
    seated: !!(props && props.userData && props.userData.rtsSeatedOnCrater),
    propsMode: props && props.userData && props.userData.rtsSceneryMode,
  };
});

await browser.close();
server.close();

const gotCombined = fetched.some((u) => u.includes('terrain-skirmish-1v1.glb'));
const gotMoon = fetched.some((u) => u.includes('terrain-skirmish-ue-lm.glb'));
const gotQuest = fetched.some((u) => u.includes('scifi-rts-quest.glb'));
const gotKitTerrain = fetched.some((u) => u.includes('scifi-rts-kit-lod2.glb'));
const propsLog = logs.filter((l) => l.includes('skirmish scenery props'));
const bakeLog = logs.find((l) => l.includes('baked moon ready')) || '';
const seated = !!(st.propsUrl && /terrain-skirmish-1v1/i.test(st.propsUrl));
const rematchSeated = !!(rematch.propsUrl && /terrain-skirmish-1v1/i.test(rematch.propsUrl) && rematch.seated);

let fail = 0;
if ((!gotCombined && !gotMoon) || !st.bake) {
  console.error('FAIL moon bake not loaded', { gotCombined, gotMoon, st, bakeLog });
  fail = 1;
}
if (st.propsMode !== 'B0' || !seated) {
  console.error('FAIL scenery not seated B0', { st, propsLog });
  fail = 1;
}
if (!rematchSeated) {
  console.error('FAIL rematch lost combined seated props', { rematch, gotQuest });
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
if (!fail) {
  console.log('PASS B0 crater+rocks', {
    combined: gotCombined,
    seated,
    rematchSeated,
    propMeshes: st.propMeshes,
    propsUrl: st.propsUrl,
    diag: st.diag,
    gotQuest,
  });
}
process.exit(fail);
