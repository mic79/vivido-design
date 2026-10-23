// Dev storage isolation (boot.js): dev and stable share an origin, so dev must never read or write stable's keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootSrc = fs.readFileSync(path.join(ROOT, 'boot.js'), 'utf8');

function fakeStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    _map: m,
  };
}

function run(version, real) {
  // In a browser the global object IS window, so bare `localStorage` resolves through it.
  const attrs = {};
  const sandbox = {
    VALU_VERSION: version,
    localStorage: real,
    navigator: { userAgent: 'node' },
    document: {
      documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
      querySelector: () => null,
    },
    requestAnimationFrame: () => {},
    Proxy, Object, String, Error,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bootSrc, sandbox);
  return { win: sandbox, attrs };
}

test('dev build stores everything under a dev: prefix and never touches stable keys', () => {
  const real = fakeStorage();
  real.setItem('valu_credential', 'STABLE-ACCOUNT');
  real.setItem('valu_groups_cache', 'STABLE-GROUPS');
  const { win } = run('v199-dev', real);
  const ls = win.localStorage;

  assert.equal(ls.getItem('valu_credential'), null, 'dev must not see stable data');
  ls.setItem('valu_credential', 'DEV-ACCOUNT');
  assert.equal(ls.getItem('valu_credential'), 'DEV-ACCOUNT');
  assert.equal(real.getItem('valu_credential'), 'STABLE-ACCOUNT', 'stable value untouched');
  assert.equal(real.getItem('dev:valu_credential'), 'DEV-ACCOUNT');

  ls.removeItem('valu_groups_cache');
  assert.equal(real.getItem('valu_groups_cache'), 'STABLE-GROUPS', 'removing in dev leaves stable alone');
});

test('Object.keys / clear on dev storage only cover dev keys', () => {
  const real = fakeStorage();
  real.setItem('valu_credential', 'STABLE');
  const { win } = run('v199-dev', real);
  const ls = win.localStorage;
  ls.setItem('valu_a', '1');
  ls.setItem('valu_b', '2');
  assert.deepEqual(Object.keys(ls).sort(), ['valu_a', 'valu_b']);
  assert.equal(ls.length, 2);
  ls.clear();
  assert.equal(Object.keys(ls).length, 0);
  assert.equal(real.getItem('valu_credential'), 'STABLE');
});

test('valu_theme stays shared with stable', () => {
  const real = fakeStorage();
  real.setItem('valu_theme', 'dark');
  const { win, attrs } = run('v199-dev', real);
  assert.equal(win.localStorage.getItem('valu_theme'), 'dark');
  assert.equal(attrs['data-theme'], 'dark');
});

test('a normal (promoted) version does not change storage at all', () => {
  const real = fakeStorage();
  const { win } = run('v199', real);
  assert.equal(win.localStorage, real);
});
