#!/usr/bin/env node
/**
 * Open Chrome the SAME way the OpenXR benches do (Playwright persistent
 * context + Playwright's default Chromium/Chrome args). The old spawn()-based
 * launcher only passed a few flags and was NOT equivalent — that is why
 * manual VR still took ~120s while benches hit isPresenting in ~1s.
 *
 *   # terminal 1: serve the app on 9100
 *   npx serve -l 9100 .
 *
 *   # terminal 2: close any window already using .chrome-openxr-vd-poses, then:
 *   node RTSVR5/launch-bench-chrome.mjs
 *   node RTSVR5/launch-bench-chrome.mjs "http://127.0.0.1:9100/?leanrocks=1"
 *
 * Leave this node process running (it owns the browser). Ctrl+C closes Chrome.
 * In the window: start 1v1, then VR or:
 *   document.querySelector('a-scene').enterVR()
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(ROOT, process.env.PROFILE_DIR || '.chrome-openxr-vd-poses');
const URL = process.argv[2] || 'http://127.0.0.1:9100/';

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--mute-audio'],
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });

console.log('Playwright-bench Chrome is open.');
console.log('  profile:', PROFILE);
console.log('  url:', URL);
console.log('  This includes Playwright defaults (--no-sandbox, etc.) that the old launcher missed.');
console.log('Keep this terminal open. Ctrl+C quits the browser.');
console.log('When 1v1 is ready, click VR or run: document.querySelector("a-scene").enterVR()');

const shutdown = async () => {
  try {
    await context.close();
  } catch (_) {
    /* */
  }
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await new Promise(() => {});
