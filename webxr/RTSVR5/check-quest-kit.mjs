#!/usr/bin/env node
/**
 * Prove ?quest=1 loads scifi-rts-quest.glb (Draco+KTX2 UE kit) and mounts kit terrain.
 *
 *   node RTSVR5/check-quest-kit.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8967;
const QUEST_GLB = path.join(ROOT, 'assets/terrain/scifi-rts-quest.glb');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
};

if (!fs.existsSync(QUEST_GLB) || fs.statSync(QUEST_GLB).size < 2_000_000) {
  console.error('FAIL missing scifi-rts-quest.glb — run scripts/compress-rts-quest.mjs');
  process.exit(1);
}

const fetched = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/') rel = '/index.html';
  fetched.push(rel);
  const f = path.normalize(path.join(ROOT, rel));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    res.end('nf');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));
await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&quest=1`, {
  waitUntil: 'domcontentloaded',
  timeout: 120000,
});
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
await page.evaluate(() => {
  if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
  window._startGame('1v1');
});
await page.waitForFunction(
  () => {
    const o = document.getElementById('match-prepare-overlay');
    return !(o && !o.hidden);
  },
  null,
  { timeout: 300000 }
);
await page.waitForTimeout(3000);

const st = await page.evaluate(() => {
  const g = document.getElementById('ground');
  const m = g && g.getObject3D && g.getObject3D('mesh');
  const sceneEl = document.querySelector('a-scene');
  const info = sceneEl && sceneEl.renderer && sceneEl.renderer.info;
  return {
    kind: m && m.userData && m.userData.rtsKitKind,
    storyKit: !!(m && m.userData && m.userData.rtsStoryKit),
    draws: info && info.render ? info.render.calls : null,
    tris: info && info.render ? info.render.triangles : null,
  };
});

await browser.close();
server.close();

const kitLog = logs.find((l) => l.includes('story kit file')) || '';
const readyLog = logs.find((l) => l.includes('kit ready')) || '';
const gotQuest = fetched.some((u) => u.includes('scifi-rts-quest.glb'));
const gotDesktop = fetched.some((u) => u.includes('scifi-rts-kit-lod2.glb'));

let fail = 0;
if (!gotQuest) {
  console.error('FAIL did not fetch scifi-rts-quest.glb', { fetched: fetched.filter((u) => u.includes('.glb')) });
  fail = 1;
}
if (gotDesktop && !kitLog.includes('scifi-rts-quest')) {
  console.error('FAIL fell back to desktop LOD2 instead of Quest GLB');
  fail = 1;
}
if (st.kind !== 'story' || !st.storyKit) {
  console.error('FAIL kit not mounted', st);
  fail = 1;
}
if (!fail) {
  console.log('PASS Quest base scenery', {
    file: 'scifi-rts-quest.glb',
    bytes: fs.statSync(QUEST_GLB).size,
    kind: st.kind,
    draws: st.draws,
    tris: st.tris,
    kitLog,
    readyLog: readyLog.slice(0, 200),
  });
}
process.exit(fail);
