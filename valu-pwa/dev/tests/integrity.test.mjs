// Static checks: nothing the app loads is missing, and everything is available offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const sw = read('service-worker.js');
const precache = [...sw.slice(sw.indexOf('PRECACHE_URLS'), sw.indexOf('];', sw.indexOf('PRECACHE_URLS'))).matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('every precached file exists', () => {
  const missing = precache.filter((f) => !exists(f));
  assert.deepEqual(missing, []);
});

test('every app script and font is in the offline precache list', () => {
  const rootJs = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') && f !== 'service-worker.js');
  const vendor = fs.readdirSync(path.join(ROOT, 'vendor')).filter((f) => f.endsWith('.js') || f.endsWith('.css')).map((f) => 'vendor/' + f);
  const fonts = fs.readdirSync(path.join(ROOT, 'vendor/fonts')).map((f) => 'vendor/fonts/' + f);
  const notCached = [...rootJs, ...vendor, ...fonts].filter((f) => !precache.includes(f));
  assert.deepEqual(notCached, []);
});

test('every relative import resolves to a real file', () => {
  const bad = [];
  for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith('.js'))) {
    for (const m of read(f).matchAll(/(?:from|import)\s*\(?\s*['"](\.\/[^'"]+)['"]/g)) {
      if (!exists(m[1].slice(2))) bad.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('index.html loads only local files, plus the Google Picker loader', () => {
  const html = read('index.html');
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external.sort(), ['https://apis.google.com/js/api.js', 'https://apis.google.com/js/picker.js']);
  const local = [...html.matchAll(/(?:src|href)="((?!https?:|#)[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(local.filter((f) => !exists(f)), []);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline <script> blocks (needed for a strict CSP)');
});

test('fonts.css only references local font files', () => {
  const css = read('vendor/fonts.css');
  assert.ok(!/https?:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
  const files = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => 'vendor/' + m[1]);
  assert.deepEqual(files.filter((f) => !exists(f)), []);
});

test('no debug console.log calls ship in app code', () => {
  const offenders = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js')).filter((f) => /console\.log\(/.test(read(f)));
  assert.deepEqual(offenders, []);
});

test('version.js is the only place the version is defined', () => {
  assert.match(read('version.js'), /VALU_VERSION = 'v\d+(-dev)?'/);
  assert.ok(!/valu-app-v\d+/.test(sw), 'service worker must not hardcode a cache name');
  assert.ok(!/v\d{3}\s*—\s*What/.test(read('index.html')), 'index.html must not hardcode the version label');
});

test('PKCE is only enabled together with the dev worker, never with the original stable worker', () => {
  const src = read('googleAuth.js');
  const worker = /const WORKER_URL\s*=\s*'([^']+)'/.exec(src)[1];
  const pkce = /const USE_PKCE\s*=\s*(true|false)/.exec(src)[1] === 'true';
  if (pkce) assert.notEqual(worker, 'https://valu-auth.valu.workers.dev', 'stable worker ignores code_verifier');
});

test('dev builds keep their refresh token in a separate localStorage key', () => {
  const src = read('googleAuth.js');
  assert.match(src, /IS_DEV_BUILD\s*=[^;]*endsWith\('-dev'\)/);
  assert.match(src, /IS_DEV_BUILD\s*\?\s*'valu_dev_encrypted_refresh'\s*:\s*'valu_encrypted_refresh'/);
  const literal = src.split("'valu_encrypted_refresh'").length - 1;
  assert.equal(literal, 1, 'the plain key name must only appear in the REFRESH_KEY definition');
});
