#!/usr/bin/env node
/**
 * Bisect enterVR speed with real Chrome flags via spawn + CDP connect.
 * Does not modify your normal Chrome profile.
 *
 *   node RTSVR5/bisect-entervr-spawn.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.PORT || 9110);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9224);
const XR_WAIT_S = Number(process.env.XR_WAIT_S || 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PW_DISABLE_FEATURES =
  'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
};

const VARIANTS = [
  {
    id: 'min',
    note: 'Minimal (slow baseline candidate)',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--mute-audio'],
  },
  {
    id: 'min_nosandbox',
    note: 'Minimal + --no-sandbox',
    args: [
      '--use-gl=angle',
      '--ignore-gpu-blocklist',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--no-sandbox',
    ],
  },
  {
    id: 'min_features',
    note: 'Minimal + Playwright disable-features only',
    args: [
      '--use-gl=angle',
      '--ignore-gpu-blocklist',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      `--disable-features=${PW_DISABLE_FEATURES}`,
    ],
  },
  {
    id: 'pw_like',
    note: 'Playwright-like: no-sandbox + disable-extensions + disable-features',
    args: [
      '--use-gl=angle',
      '--ignore-gpu-blocklist',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--no-sandbox',
      '--disable-extensions',
      `--disable-features=${PW_DISABLE_FEATURES}`,
    ],
  },
];

function serve() {
  const s = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const f = path.normalize(path.join(ROOT, rel));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });
}

function seedVr(profile, origin) {
  const def = path.join(profile, 'Default');
  fs.mkdirSync(def, { recursive: true });
  const prefsPath = path.join(def, 'Preferences');
  let prefs = {};
  try {
    if (fs.existsSync(prefsPath)) prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  } catch (_) {
    prefs = {};
  }
  prefs.profile = prefs.profile || {};
  prefs.profile.content_settings = prefs.profile.content_settings || {};
  prefs.profile.content_settings.exceptions = prefs.profile.content_settings.exceptions || {};
  prefs.profile.content_settings.exceptions.vr = prefs.profile.content_settings.exceptions.vr || {};
  prefs.profile.content_settings.exceptions.vr[`${origin},*`] = {
    last_modified: String(Date.now() * 1000),
    setting: 1,
  };
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

async function killByProfile(profile) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const esc = profile.replace(/'/g, "''");
  try {
    await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${esc}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { windowsHide: true }
    );
  } catch (_) {
    /* */
  }
  await sleep(2000);
}

async function runVariant(v) {
  console.log(`\n=== ${v.id} ===\n  ${v.note}`);
  const profile = path.join(ROOT, `.chrome-spawn-bisect-${v.id}`);
  fs.mkdirSync(profile, { recursive: true });
  await killByProfile(profile);
  seedVr(profile, `http://127.0.0.1:${PORT}`);

  const args = [
    ...v.args,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    `http://127.0.0.1:${PORT}/index.html?perf=1&nobot=1`,
  ];
  const child = spawn(CHROME, args, { stdio: 'ignore', detached: true });
  child.unref();

  let browser;
  try {
    // Wait for CDP
    const tLaunch = Date.now();
    while (Date.now() - tLaunch < 60000) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
        break;
      } catch (_) {
        await sleep(500);
      }
    }
    if (!browser) throw new Error('CDP connect timeout');

    const context = browser.contexts()[0];
    const page = context.pages().find((p) => p.url().includes('127.0.0.1')) || context.pages()[0];
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
      if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(false);
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
    await sleep(500);

    const t0 = Date.now();
    await page.evaluate(() => {
      const p = document.querySelector('a-scene').enterVR();
      if (p && p.catch) p.catch(() => {});
    });
    let on = false;
    for (let i = 0; i < XR_WAIT_S; i++) {
      on = await page.evaluate(() => {
        const sc = document.querySelector('a-scene');
        return !!(sc && sc.renderer && sc.renderer.xr && sc.renderer.xr.isPresenting);
      });
      if (on) break;
      if (i > 0 && i % 15 === 0) console.log(`  … waiting ${i}s`);
      await sleep(1000);
    }
    const waitS = (Date.now() - t0) / 1000;
    console.log(`  enterVR → isPresenting: ${on ? `${waitS.toFixed(1)}s` : `TIMEOUT ${waitS.toFixed(1)}s`}`);

    await page.evaluate(() => {
      const s = document.querySelector('a-scene');
      if (s && s.exitVR) s.exitVR();
    });
    await sleep(1000);
    try {
      await browser.close();
    } catch (_) {
      /* */
    }
    await killByProfile(profile);
    return { id: v.id, ok: on, waitS, note: v.note };
  } catch (e) {
    console.log(`  ERROR: ${e && e.message ? e.message : e}`);
    try {
      if (browser) await browser.close();
    } catch (_) {
      /* */
    }
    await killByProfile(profile);
    return { id: v.id, ok: false, waitS: null, note: v.note, err: String(e && e.message ? e.message : e) };
  }
}

async function main() {
  const only = (process.env.ONLY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const list = only.length ? VARIANTS.filter((v) => only.includes(v.id)) : VARIANTS;
  console.log('Spawn+CDP enterVR flag bisect — headset on');
  await serve();
  const out = [];
  for (const v of list) out.push(await runVariant(v));
  console.log('\n======== SUMMARY ========');
  for (const r of out) {
    const t = r.waitS == null ? 'n/a' : r.ok ? `${r.waitS.toFixed(1)}s` : `fail`;
    console.log(`  ${r.id.padEnd(20)} ${t.padEnd(8)} ${r.note}`);
  }
  fs.writeFileSync(path.join(ROOT, 'proof-entervr-spawn-bisect.json'), JSON.stringify(out, null, 2));
  console.log('Wrote proof-entervr-spawn-bisect.json');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
