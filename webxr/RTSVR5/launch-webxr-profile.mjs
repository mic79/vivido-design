#!/usr/bin/env node
/**
 * Launch a DEDICATED Chrome user-data-dir for WebXR with --no-sandbox.
 *
 * Why not --profile-directory=Profile 6 on the main User Data?
 * Chrome only allows one process per user-data-dir. If normal Chrome is already
 * open, a second launch just opens another window in that process and IGNORES
 * --no-sandbox — which is the ~120s enterVR hang you saw.
 *
 * This uses a separate directory so it can run ALONGSIDE your normal profile.
 *
 *   node RTSVR5/launch-webxr-profile.mjs
 *   node RTSVR5/launch-webxr-profile.mjs "http://localhost:8080/RTSVR5/"
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
/** Separate from "%LOCALAPPDATA%\\Google\\Chrome\\User Data" so flags apply even if normal Chrome is open. */
const USER_DATA =
  process.env.CHROME_WEBXR_USER_DATA ||
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome-WebXR-PCVR');
const URL = process.argv[2] || 'http://localhost:8080/RTSVR5/';

function seedVrAllows(userDataDir) {
  const def = path.join(userDataDir, 'Default');
  fs.mkdirSync(def, { recursive: true });
  const prefsPath = path.join(def, 'Preferences');
  let prefs = {};
  try {
    if (fs.existsSync(prefsPath)) prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  } catch (_) {
    prefs = {};
  }
  prefs.profile = prefs.profile || {};
  prefs.profile.name = prefs.profile.name || 'WebXR PCVR';
  prefs.profile.content_settings = prefs.profile.content_settings || {};
  prefs.profile.content_settings.exceptions = prefs.profile.content_settings.exceptions || {};
  prefs.profile.content_settings.exceptions.vr = prefs.profile.content_settings.exceptions.vr || {};
  const origins = [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:9100',
    'http://127.0.0.1:9100',
  ];
  const now = String(Date.now() * 1000);
  for (const o of origins) {
    prefs.profile.content_settings.exceptions.vr[`${o},*`] = {
      last_modified: now,
      setting: 1,
    };
  }
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

if (!fs.existsSync(CHROME)) {
  console.error('Chrome not found:', CHROME);
  process.exit(1);
}

fs.mkdirSync(USER_DATA, { recursive: true });
seedVrAllows(USER_DATA);

const args = [
  `--user-data-dir=${USER_DATA}`,
  '--no-sandbox',
  '--use-gl=angle',
  '--ignore-gpu-blocklist',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  URL,
];

console.log('Launching dedicated WebXR Chrome (can run beside normal Chrome):');
console.log('  user-data-dir:', USER_DATA);
console.log('  url:', URL);
console.log('  flags: --no-sandbox (applied because this is its own Chrome process)');
spawn(CHROME, args, { detached: true, stdio: 'ignore' }).unref();
