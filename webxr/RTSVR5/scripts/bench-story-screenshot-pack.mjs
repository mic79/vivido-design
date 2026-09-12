#!/usr/bin/env node
/**
 * Story mode factual pack: RTSVR4 / RTSVR5 / RTSVR5Forest
 * Screenshots + GPU proxies (draws/tris) + __rtsPerf.
 *
 * Desktop Chromium (2D). NOT Quest / NOT Meta Link WebXR.
 * User Quest/Link numbers belong in a separate device section.
 *
 *   node RTSVR5/scripts/bench-story-screenshot-pack.mjs
 *
 * Env: SAMPLE_MS=2500 STORY_SEED=42 HEADED=1 CHANNEL=chrome
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, chromium as chromiumDefault } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBXR = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(WEBXR, 'RTSVR5', 'bench-story-pack');
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 2500);
const WARMUP_MS = Number(process.env.WARMUP_MS || 800);
const STORY_SEED = Number(process.env.STORY_SEED || 42) >>> 0;
const HEADED = process.env.HEADED !== '0';
const CHANNEL = process.env.CHANNEL || 'chrome'; // system Chrome when available

const PROJECTS = [
  { id: 'RTSVR4', root: path.join(WEBXR, 'RTSVR4'), port: 8784 },
  { id: 'RTSVR5', root: path.join(WEBXR, 'RTSVR5'), port: 8785 },
  { id: 'RTSVR5Forest', root: path.join(WEBXR, 'RTSVR5Forest'), port: 8786 },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
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

function startStaticServer(root, port) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const filePath = path.normalize(path.join(root, rel));
      if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
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
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sample(page) {
  await page.evaluate(() => {
    if (window.__rtsPerf) {
      window.__rtsPerf.setPerfEnabled(true);
      window.__rtsPerf.resetSamples();
    }
  });
  await sleep(SAMPLE_MS);
  return page.evaluate(() => {
    const snap = window.__rtsPerf ? window.__rtsPerf.snapshot() : null;
    const sc = document.querySelector('a-scene');
    const r = sc && sc.renderer;
    const info = r && r.info && r.info.render ? r.info.render : null;
    const mem = r && r.info && r.info.memory ? r.info.memory : null;
    const fpsEl = document.getElementById('rts-version-fps-label') || document.querySelector('[data-rts-fps]');
    let hudText = '';
    try {
      const wrist = document.getElementById('wrist-fps');
      hudText = (wrist && wrist.getAttribute && wrist.getAttribute('value')) || '';
    } catch (_) {}
    const ground = document.getElementById('ground');
    const mesh = ground && ground.getObject3D && ground.getObject3D('mesh');
    const props = ground && ground.getObject3D && ground.getObject3D('overviewProps');
    let plateTris = 0;
    let skirtTris = 0;
    let meshes = 0;
    if (mesh) {
      mesh.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        meshes++;
        const idx = o.geometry.index;
        const pos = o.geometry.attributes && o.geometry.attributes.position;
        const t = idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
        const n = `${o.name || ''}|${(o.parent && o.parent.name) || ''}`;
        if (/skirt/i.test(n)) skirtTris += t;
        else plateTris += t;
      });
    }
    return {
      snap,
      render: info
        ? { calls: info.calls, triangles: info.triangles, points: info.points, lines: info.lines }
        : null,
      memory: mem ? { textures: mem.textures, geometries: mem.geometries } : null,
      xrPresenting: !!(r && r.xr && r.xr.isPresenting),
      hudText,
      version: document.querySelector('meta[name="rts-version"]')?.getAttribute('content') || '?',
      terrain: {
        name: (mesh && mesh.name) || null,
        bake: !!(mesh && mesh.userData && mesh.userData.rtsSkirmishBake),
        kit: !!(mesh && mesh.userData && mesh.userData.rtsStoryKit),
        kitKind: mesh && mesh.userData && mesh.userData.rtsKitKind,
        hasProps: !!props,
        plateTris: Math.round(plateTris),
        skirtTris: Math.round(skirtTris),
        terrainMeshes: meshes,
      },
    };
  });
}

async function benchOne(proj, browser) {
  const shotDir = path.join(OUT_ROOT, 'screenshots', proj.id);
  fs.mkdirSync(shotDir, { recursive: true });
  const server = await startStaticServer(proj.root, proj.port);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const out = { id: proj.id, port: proj.port, version: null, poses: [], error: null };
  const poses = [
    { key: '01-menu', label: 'menu', setup: null },
    { key: '02-story-look-center', label: 'story-look-center', setup: 'start-story-center' },
    { key: '03-story-look-out', label: 'story-look-out', setup: 'look-out' },
    { key: '04-story-look-out-nofog', label: 'story-look-out-nofog', setup: 'nofog' },
  ];

  try {
    const url = `http://127.0.0.1:${proj.port}/index.html?perf=1&storySeed=${STORY_SEED}`;
    console.log(`\n=== ${proj.id} ${url} ===`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });
    await sleep(WARMUP_MS);

    for (const pose of poses) {
      if (pose.setup === 'start-story-center') {
        await page.evaluate(async () => {
          if (typeof window._startGame !== 'function') throw new Error('no _startGame');
          window._startGame('story');
        });
        await page.waitForFunction(() => {
          const overlay = document.getElementById('match-prepare-overlay');
          return !(overlay && !overlay.hidden);
        }, null, { timeout: 300000 });
        await sleep(1500);
        await page.evaluate(async () => {
          const State = await import('./js/state.js');
          const Input = await import('./js/input.js');
          const UI = await import('./js/ui.js');
          if (!State.gameSession.gameStarted) throw new Error('story did not start');
          if (typeof UI.setMinimapVisible === 'function') UI.setMinimapVisible(true);
          Input.positionCameraForPlayer(State.gameSession.myPlayerId);
        });
        await sleep(WARMUP_MS);
      } else if (pose.setup === 'look-out') {
        await page.evaluate(async () => {
          const Input = await import('./js/input.js');
          Input.positionCameraForPlayer(0);
          const cam = Input.getCameraState();
          cam.rotY += Math.PI;
        });
        await sleep(400);
      } else if (pose.setup === 'nofog') {
        await page.evaluate(() => {
          if (window.__rtsPerf) window.__rtsPerf.setAblation({ fogOverlay: false });
        });
        await sleep(200);
      }

      const shotPath = path.join(shotDir, `${pose.key}.png`);
      await page.screenshot({ path: shotPath, fullPage: false });
      const metrics = await sample(page);
      // second screenshot after sample window (HUD FPS updated)
      const shotPath2 = path.join(shotDir, `${pose.key}-sampled.png`);
      await page.screenshot({ path: shotPath2, fullPage: false });

      const snap = metrics.snap || {};
      const gpu = snap.gpu || {};
      const row = {
        pose: pose.label,
        screenshot: path.relative(WEBXR, shotPath2).split(path.sep).join('/'),
        screenshotPre: path.relative(WEBXR, shotPath).split(path.sep).join('/'),
        version: metrics.version,
        fpsAvg: snap.fpsAvg ?? snap.fps ?? null,
        fpsMin: snap.fpsMin ?? null,
        frameMs: snap.avgMs?.frame ?? null,
        fogCpuMs: snap.avgMs?.['render.fogOverlay'] ?? null,
        callsAvg: gpu.callsAvg ?? metrics.render?.calls ?? null,
        trisAvg: gpu.trisAvg ?? metrics.render?.triangles ?? null,
        trisK: Math.round(((gpu.trisAvg ?? metrics.render?.triangles ?? 0) || 0) / 1000),
        textures: metrics.memory?.textures ?? null,
        xrPresenting: metrics.xrPresenting,
        terrain: metrics.terrain,
        renderLast: metrics.render,
      };
      out.version = metrics.version;
      out.poses.push(row);
      console.log(
        `${proj.id} ${pose.label}: fps=${Number(row.fpsAvg || 0).toFixed(1)} d=${Number(row.callsAvg || 0).toFixed(0)} tK=${row.trisK} → ${row.screenshot}`
      );
    }
  } catch (err) {
    out.error = String(err && err.stack ? err.stack : err);
    console.error(proj.id, 'FAIL', out.error);
  } finally {
    await page.close();
    server.close();
  }
  return out;
}

async function main() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({
      headless: !HEADED,
      channel: CHANNEL,
      args: HEADED
        ? []
        : ['--use-gl=angle', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
    });
    console.log(`browser channel=${CHANNEL} headed=${HEADED}`);
  } catch (err) {
    console.warn('channel chrome failed, falling back to bundled chromium', err.message);
    browser = await chromiumDefault.launch({
      headless: !HEADED,
      args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
    });
  }

  const results = [];
  for (const proj of PROJECTS) {
    if (!fs.existsSync(path.join(proj.root, 'index.html'))) {
      results.push({ id: proj.id, error: 'missing index.html', poses: [] });
      continue;
    }
    results.push(await benchOne(proj, browser));
  }
  await browser.close();

  // Copy user Meta Link screenshots into pack if present
  const userShots = [
    {
      src: path.join(
        process.env.USERPROFILE || '',
        '.cursor/projects/d-backup-2024-04-Documents-Backup-MBP-2021-12-Backup-Projects-Apps-WebXR/assets',
        'c__Users_michi_AppData_Roaming_Cursor_User_workspaceStorage_6a9c63bfb9746c18bde6e8b503292e8a_images_MetaScreenshot1789072844-fa7ce5ea-4c4a-4773-a0f0-35695606cdfe.jpg'
      ),
      name: 'user-link-RTSVR4-0.4.65-Story-120fps-shadowsON.jpg',
      note: 'User Meta Link VR · RTSVR4 0.4.65 · 120 FPS · Shadows ON',
    },
    {
      src: path.join(
        process.env.USERPROFILE || '',
        '.cursor/projects/d-backup-2024-04-Documents-Backup-MBP-2021-12-Backup-Projects-Apps-WebXR/assets',
        'c__Users_michi_AppData_Roaming_Cursor_User_workspaceStorage_6a9c63bfb9746c18bde6e8b503292e8a_images_MetaScreenshot1789073037-c6dd5f74-0fe3-4545-bce6-9721f652e0ad.jpg'
      ),
      name: 'user-link-RTSVR5-0.5.117-Story-120fps-d108-tK1216.jpg',
      note: 'User Meta Link VR · RTSVR5 0.5.117 · 120 FPS · d=108 tK=1216 · Shadows ON · MSAA off',
    },
    {
      src: path.join(
        process.env.USERPROFILE || '',
        '.cursor/projects/d-backup-2024-04-Documents-Backup-MBP-2021-12-Backup-Projects-Apps-WebXR/assets',
        'c__Users_michi_AppData_Roaming_Cursor_User_workspaceStorage_6a9c63bfb9746c18bde6e8b503292e8a_images_MetaScreenshot1789073283-e1e9cd82-aec9-4f88-9336-6f28ebc85db2.jpg'
      ),
      name: 'user-link-RTSVR5-0.5.127-Story-120fps-d116-tK1313.jpg',
      note: 'User Meta Link VR · RTSVR5 0.5.127 · 120 FPS · d=116 tK=1313 · Shadows ON · MSAA off',
    },
  ];
  const userDir = path.join(OUT_ROOT, 'screenshots', 'user-device');
  fs.mkdirSync(userDir, { recursive: true });
  const userDevice = [];
  for (const u of userShots) {
    if (fs.existsSync(u.src)) {
      const dest = path.join(userDir, u.name);
      fs.copyFileSync(u.src, dest);
      userDevice.push({
        screenshot: path.relative(WEBXR, dest).split(path.sep).join('/'),
        note: u.note,
      });
    }
  }

  const pack = {
    when: new Date().toISOString(),
    method: {
      harness: 'RTSVR5/scripts/bench-story-screenshot-pack.mjs',
      mode: 'story',
      storySeed: STORY_SEED,
      sampleMs: SAMPLE_MS,
      headed: HEADED,
      channel: CHANNEL,
      presenting: '2D desktop (not WebXR / not Quest standalone)',
      note: 'Desktop FPS is not Quest. Use draws/tris + screenshots for relative compare; Quest FPS from device HUD only.',
    },
    userQuestStandaloneReported: {
      source: 'user verbal 2026-09-10',
      conditions: 'Quest 3 standalone · Story · Shadows OFF · MSAA OFF',
      RTSVR4_fps: 75,
      RTSVR5_fps: 55,
      RTSVR5Forest_fps: 45,
    },
    userDeviceScreenshots: userDevice,
    projects: results,
  };

  const jsonPath = path.join(OUT_ROOT, 'bench-story-pack.json');
  fs.writeFileSync(jsonPath, JSON.stringify(pack, null, 2));

  // Markdown report with image embeds (relative from pack folder)
  let md = `# Story benchmark pack\n\nGenerated: ${pack.when}\n\n`;
  md += `## Method\n\n`;
  md += `- Harness: \`${pack.method.harness}\`\n`;
  md += `- Mode: Story · seed ${STORY_SEED} · sample ${SAMPLE_MS} ms\n`;
  md += `- **${pack.method.presenting}**\n`;
  md += `- ${pack.method.note}\n\n`;
  md += `## User Quest 3 standalone (reported)\n\n`;
  md += `| Build | Story FPS | Conditions |\n|-------|-----------|------------|\n`;
  md += `| RTSVR4 | ~${pack.userQuestStandaloneReported.RTSVR4_fps} | Shadows/MSAA off |\n`;
  md += `| RTSVR5 | ~${pack.userQuestStandaloneReported.RTSVR5_fps} | Shadows/MSAA off |\n`;
  md += `| RTSVR5Forest | ~${pack.userQuestStandaloneReported.RTSVR5Forest_fps} | Shadows/MSAA off |\n\n`;
  md += `## User Meta Link screenshots (this PC)\n\n`;
  for (const u of userDevice) {
    md += `### ${u.note}\n\n`;
    md += `![shot](${path.relative(OUT_ROOT, path.join(WEBXR, u.screenshot)).split(path.sep).join('/')})\n\n`;
  }
  md += `## Desktop harness (this run)\n\n`;
  md += `| Project | Version | Pose | FPS avg | Draws | trisK | Screenshot |\n|---------|---------|------|---------|-------|-------|------------|\n`;
  for (const p of results) {
    for (const row of p.poses || []) {
      const relShot = path.relative(OUT_ROOT, path.join(WEBXR, row.screenshot)).split(path.sep).join('/');
      md += `| ${p.id} | ${row.version} | ${row.pose} | ${Number(row.fpsAvg || 0).toFixed(1)} | ${Number(row.callsAvg || 0).toFixed(0)} | ${row.trisK} | [png](${relShot}) |\n`;
    }
  }
  md += `\n`;
  for (const p of results) {
    md += `### ${p.id} (${p.version || '?'})\n\n`;
    if (p.error) md += `ERROR: ${p.error}\n\n`;
    for (const row of p.poses || []) {
      const relShot = path.relative(OUT_ROOT, path.join(WEBXR, row.screenshot)).split(path.sep).join('/');
      md += `#### ${row.pose} — ${Number(row.fpsAvg || 0).toFixed(1)} fps · d=${Number(row.callsAvg || 0).toFixed(0)} · tK=${row.trisK}\n\n`;
      md += `![${p.id} ${row.pose}](${relShot})\n\n`;
      if (row.terrain) {
        md += `Terrain: plate=${row.terrain.plateTris} skirt=${row.terrain.skirtTris} bake=${row.terrain.bake} props=${row.terrain.hasProps}\n\n`;
      }
    }
  }
  const mdPath = path.join(OUT_ROOT, 'README.md');
  fs.writeFileSync(mdPath, md);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  if (results.some((r) => r.error)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
