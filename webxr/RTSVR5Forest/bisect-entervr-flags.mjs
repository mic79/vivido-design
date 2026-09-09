#!/usr/bin/env node
/**
 * Bisect which Playwright Chrome args make enterVR → isPresenting fast (~1s)
 * vs slow (~120s). Uses throwaway .chrome-bisect-* profiles only — does not
 * touch your normal Chrome profile.
 *
 *   node RTSVR5/bisect-entervr-flags.mjs
 *   ONLY=B_minimal_only,C_minimal_nosandbox node RTSVR5/bisect-entervr-flags.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9110);
const XR_WAIT_S = Number(process.env.XR_WAIT_S || 90);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PW_DISABLE_FEATURES =
  'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion';

const BASE = ['--use-gl=angle', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--mute-audio'];

const VARIANTS = [
  {
    id: 'A_playwright_full',
    note: 'Full Playwright defaults (known fast)',
    ignoreDefaultArgs: false,
    args: BASE,
  },
  {
    id: 'B_minimal_only',
    note: 'No Playwright defaults — plain args only',
    ignoreDefaultArgs: true,
    args: BASE,
  },
  {
    id: 'C_minimal_nosandbox',
    note: 'Minimal + --no-sandbox',
    ignoreDefaultArgs: true,
    args: [...BASE, '--no-sandbox'],
  },
  {
    id: 'D_minimal_pw_disable_features',
    note: 'Minimal + Playwright --disable-features (no --no-sandbox)',
    ignoreDefaultArgs: true,
    args: [...BASE, `--disable-features=${PW_DISABLE_FEATURES}`],
  },
  {
    id: 'E_minimal_disable_extensions',
    note: 'Minimal + --disable-extensions',
    ignoreDefaultArgs: true,
    args: [...BASE, '--disable-extensions'],
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

async function killProfileChrome(profilePath) {
  const escaped = profilePath.replace(/'/g, "''");
  const ps = `
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  try {
    await exec('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
  } catch (_) {
    /* */
  }
  await sleep(2000);
}

async function seedVrPermission(profilePath, origin) {
  const def = path.join(profilePath, 'Default');
  fs.mkdirSync(def, { recursive: true });
  const prefsPath = path.join(def, 'Preferences');
  let prefs = {};
  if (fs.existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    } catch (_) {
      prefs = {};
    }
  }
  prefs.profile = prefs.profile || {};
  prefs.profile.content_settings = prefs.profile.content_settings || {};
  prefs.profile.content_settings.exceptions = prefs.profile.content_settings.exceptions || {};
  prefs.profile.content_settings.exceptions.vr = prefs.profile.content_settings.exceptions.vr || {};
  // setting 1 = allow (same as the working bench profile)
  prefs.profile.content_settings.exceptions.vr[`${origin},*`] = {
    last_modified: String(Date.now() * 1000),
    last_visit: String(Date.now() * 1000),
    setting: 1,
  };
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

async function timeEnterVr(opts) {
  console.log(`\n=== ${opts.id} ===`);
  console.log(`  ${opts.note}`);
  const profile = path.join(ROOT, `.chrome-bisect-${opts.id}`);
  fs.mkdirSync(profile, { recursive: true });
  await killProfileChrome(profile);
  await seedVrPermission(profile, `http://127.0.0.1:${PORT}`);

  // When ignoreDefaultArgs is true, Playwright may omit user-data-dir from its
  // internal list — pass it explicitly in args so we never attach to the user's Chrome.
  const args = [...opts.args, `--user-data-dir=${profile}`];
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 800 },
      ignoreDefaultArgs: opts.ignoreDefaultArgs,
      args,
    });
  } catch (e) {
    console.log(`  LAUNCH FAIL: ${e && e.message ? e.message : e}`);
    return { id: opts.id, ok: false, waitS: null, note: opts.note, err: String(e && e.message ? e.message : e) };
  }

  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&nobot=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
      if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(false);
    });
    await page.evaluate(() => window._startGame('1v1'));
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
    await sleep(1500);
    await context.close();
    await killProfileChrome(profile);
    await sleep(1500);
    return { id: opts.id, ok: on, waitS, note: opts.note };
  } catch (e) {
    console.log(`  ERROR: ${e && e.message ? e.message : e}`);
    try {
      await context.close();
    } catch (_) {
      /* */
    }
    await killProfileChrome(profile);
    await sleep(1500);
    return { id: opts.id, ok: false, waitS: null, note: opts.note, err: String(e && e.message ? e.message : e) };
  }
}

async function main() {
  const only = (process.env.ONLY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const list = only.length ? VARIANTS.filter((v) => only.includes(v.id)) : VARIANTS;
  console.log('Bisect enterVR flags — headset on. Throwaway profiles under .chrome-bisect-*');
  await serve();
  const out = [];
  for (const v of list) out.push(await timeEnterVr(v));
  console.log('\n======== SUMMARY ========');
  for (const r of out) {
    const t = r.waitS == null ? 'n/a' : r.ok ? `${r.waitS.toFixed(1)}s` : `fail/${r.waitS?.toFixed(1)}s`;
    console.log(`  ${r.id.padEnd(36)} ${t}   ${r.note}`);
  }
  fs.writeFileSync(path.join(ROOT, 'proof-entervr-flag-bisect.json'), JSON.stringify(out, null, 2));
  console.log('Wrote proof-entervr-flag-bisect.json');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
