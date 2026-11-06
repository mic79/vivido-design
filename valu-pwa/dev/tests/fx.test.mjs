import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('currency list covers the currencies people actually pay in (incl. MYR and IDR) without duplicates', () => {
  const src = fs.readFileSync(path.join(ROOT, 'sheetsApi.js'), 'utf8');
  const block = /const CURRENCIES = \[([\s\S]*?)\n\];/.exec(src)[1];
  const codes = [...block.matchAll(/code: '([A-Z]{3})'/g)].map((m) => m[1]);
  for (const c of ['CAD', 'USD', 'EUR', 'MYR', 'IDR', 'THB', 'PHP', 'VND', 'AED', 'TRY', 'PLN']) {
    assert.ok(codes.includes(c), `missing ${c}`);
  }
  assert.equal(new Set(codes).size, codes.length, 'duplicate currency codes');
});

test('tiny rates (IDR to CAD) are taken from the more precise reverse pair', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = String(url);
    const body = u.includes('/rate/IDR/CAD')
      ? { date: '2026-11-05', base: 'IDR', quote: 'CAD', rate: 0.000077 }       // API rounds hard
      : { date: '2026-11-05', base: 'CAD', quote: 'IDR', rate: 12987 };         // precise
    return { ok: true, status: 200, json: async () => body };
  };
  const { getRate } = await import('../fxService.js');
  const r = await getRate('IDR', 'CAD', '2026-11-05');
  assert.ok(Math.abs(r.rate - 1 / 12987) < 1e-12, `got ${r.rate}`);
  assert.equal(calls.length, 2);
});

test('normal rates are used as returned (no extra request)', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; return { ok: true, status: 200, json: async () => ({ date: '2026-11-05', rate: 0.3458 }) }; };
  const { getRate } = await import('../fxService.js');
  const r = await getRate('MYR', 'CAD', '2026-11-04');
  assert.equal(r.rate, 0.3458);
  assert.equal(n, 1);
});
