/**
 * Google Sheets API v4 + Drive API v3 data layer.
 *
 * Features: batched writes, row-index caching, retry with backoff,
 * change detection via Drive modifiedTime polling.
 */

import GoogleAuth from './googleAuth.js';
import { isDemoSheet, demoValuesForRange, demoGroupMeta, setDemoOverride, setDemoOverrides, syncDemoHoldingsAccount } from './demoData.js';

export { isDemoSheet } from './demoData.js';
export { DEMO_SHEET_ID } from './demoData.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3/files';

// Tab names used by Valu spreadsheets
export const TABS = {
  SETTINGS:       'Settings',
  ACCOUNTS:       'Accounts',
  BALANCE_HISTORY:'BalanceHistory',
  HOLDINGS:       'Holdings',
  EXPENSES:       'Expenses',
  INCOME:         'Income',
  CHAT_HISTORY:   'ChatHistory',
};

// Default headers for each tab when creating a new spreadsheet
const TAB_HEADERS = {
  [TABS.SETTINGS]:        [['Key', 'Value']],
  [TABS.ACCOUNTS]:        [['ID', 'Name', 'Currency', 'Type', 'Discontinued', 'Order']],
  [TABS.BALANCE_HISTORY]: [['AccountID', 'Year', 'Month', 'Balance', 'UpdatedAt']],
  [TABS.HOLDINGS]:        [['HoldingsID', 'AccountID', 'Symbol', 'Shares', 'MarketValue']],
  [TABS.EXPENSES]:        [['ID', 'Title', 'Amount', 'AccountID', 'Category', 'Date', 'Notes', 'CreatedAt', 'BalanceAdjusted']],
  [TABS.INCOME]:          [['ID', 'Title', 'Amount', 'AccountID', 'Category', 'Date', 'Notes', 'CreatedAt', 'BalanceAdjusted']],
  [TABS.CHAT_HISTORY]:    [['ChatID', 'Title', 'CreatedAt', 'UpdatedAt', 'Messages']],
};

/** Holdings!Z1 — as-of date for GOOGLEFINANCE close; blank = use live price */
const HOLDINGS_AS_OF_Z1 = 'Z1';

/**
 * Column E formula for one Holdings row.
 * CASH rows: N(D) in the account currency (no quote).
 * Stock/ETF rows: shares × price × FX rate from listing currency → accountCurrency.
 * Uses LET to avoid repeated GOOGLEFINANCE calls.
 * @param {number} row - Sheet row (2-based)
 * @param {string} [accountCurrency] - ISO code from the Accounts tab (e.g. "CAD")
 */
function holdingsMarketValueFormula(row, accountCurrency) {
  const c = `C${row}`;
  const d = `D${row}`;
  const cur = (accountCurrency || 'CAD').toUpperCase();

  const priceFx = [
    `LET(`,
    `lc,IFERROR(GOOGLEFINANCE(sym,"currency"),"${cur}"),`,
    `lp,IFERROR(N(GOOGLEFINANCE(sym,"price")),0),`,
    `hp,IFERROR(N(INDEX(GOOGLEFINANCE(sym,"close",$Z$1,$Z$1),2,2)),lp),`,
    `p,IF(OR(ISBLANK($Z$1),$Z$1=""),lp,hp),`,
    `fp,"CURRENCY:"&lc&"${cur}",`,
    `lf,IFERROR(IF(lc="${cur}",1,N(GOOGLEFINANCE(fp))),1),`,
    `hf,IFERROR(IF(lc="${cur}",1,N(INDEX(GOOGLEFINANCE(fp,"close",$Z$1,$Z$1),2,2))),lf),`,
    `fx,IF(OR(ISBLANK($Z$1),$Z$1=""),lf,hf),`,
    `sh*p*fx)`,
  ].join('');

  return `=LET(sym,${c},sh,${d},IF(OR(sym="",sh=""),0,IF(UPPER(TRIM(sym))="CASH",N(sh),${priceFx})))`;
}

const HOLDINGS_FM_STORAGE_PREFIX = 'valu_holdings_fm_';
/** Bump when column E formula changes to trigger rewrite on existing sheets. */
const HOLDINGS_FM_REV = 'fxcash1';

function holdingsFormulasNeedRefresh(spreadsheetId) {
  try {
    return localStorage.getItem(HOLDINGS_FM_STORAGE_PREFIX + spreadsheetId) !== HOLDINGS_FM_REV;
  } catch {
    return true;
  }
}

function markHoldingsFormulasCurrent(spreadsheetId) {
  try {
    localStorage.setItem(HOLDINGS_FM_STORAGE_PREFIX + spreadsheetId, HOLDINGS_FM_REV);
  } catch (_) {}
}

/** Local calendar date YYYY-MM-DD (matches date picker / Accounts "today"). */
function localTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** @param {string} iso YYYY-MM-DD @param {number} deltaDays */
function isoAddCalendarDays(iso, deltaDays) {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(y, m - 1, d);
  if (x.getFullYear() !== y || x.getMonth() !== m - 1 || x.getDate() !== d) return iso;
  x.setDate(x.getDate() + deltaDays);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** True if historical total is indistinguishable from live (sheet fell back to price). */
function holdingsSumMatchesLive(histSum, liveSum) {
  const h = Math.round(histSum * 100) / 100;
  const l = Math.round(liveSum * 100) / 100;
  return Math.abs(h - l) < 0.02;
}

const HOLDINGS_VALUATION_MAX_DAYS_BACK = 45;

// Default categories for new groups
const DEFAULT_EXPENSE_CATEGORIES = [
  { name: 'Housing', icon: 'home' },
  { name: 'Food', icon: 'shopping_cart' },
  { name: 'Transportation', icon: 'directions_car' },
  { name: 'Utilities', icon: 'bolt' },
  { name: 'Healthcare', icon: 'local_hospital' },
  { name: 'Debt Payments', icon: 'credit_card' },
  { name: 'Personal Care', icon: 'face' },
  { name: 'Leisure', icon: 'celebration' },
  { name: 'Miscellaneous', icon: 'category' },
];

const DEFAULT_INCOME_CATEGORIES = [
  { name: 'Primary Salary/Wages', icon: 'work' },
  { name: 'Bonuses & Commission', icon: 'emoji_events' },
  { name: 'Investment Income', icon: 'trending_up' },
  { name: 'Side Hustles/Freelance', icon: 'laptop' },
  { name: 'Other Income', icon: 'attach_money' },
];

function serializeDefaultCategories(arr) {
  return arr.map(c => c.icon ? c.name + ':' + c.icon : c.name).join(',');
}

// Default settings for a new group
const DEFAULT_SETTINGS = [
  ['groupName',          'My Group'],
  ['baseCurrency',       'CAD'],
  ['listsEnabled',       'expenses,income,accounts,fi'],
  ['expenseCategories',  serializeDefaultCategories(DEFAULT_EXPENSE_CATEGORIES)],
  ['incomeCategories',   serializeDefaultCategories(DEFAULT_INCOME_CATEGORIES)],
  ['currencyRates',      ''],
  ['repeatsLastChecked', ''],
  ['fxLastRechecked',    ''],
  ['createdAt',          ''],
  ['createdBy',          ''],
];

/** Investment account type (Accounts column D) — compare case-insensitively */
export function isInvestmentAccountType(type) {
  return String(type || '').toLowerCase() === 'investment';
}

/** Sheets may return TRUE/FALSE as boolean or string — normalize for filters and toggles */
export function normalizeDiscontinuedCell(cell) {
  if (cell === true || cell === 'TRUE' || cell === 'true') return 'true';
  if (cell === false || cell === 'FALSE' || cell === 'false') return 'false';
  if (cell == null || cell === '') return 'false';
  const s = String(cell).trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return 'true';
  return 'false';
}

/** List / picker label: append (Discontinued) when the account row is discontinued */
export function formatAccountDisplayName(account) {
  if (!account || account.name == null) return '';
  const name = String(account.name).trim();
  if (!name) return '';
  return normalizeDiscontinuedCell(account.discontinued) === 'true' ? `${name} (Discontinued)` : name;
}

/** YYYY-MM-DD in the user's local timezone. Safer than toISOString().split('T')[0], which is UTC and can become "tomorrow" or "yesterday" on the local calendar. */
export function localDateISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Internal state ─────────────────────────────────────────────────────────────

const rowCache = new Map();           // "sheetId::tabName" → Map<id, rowIndex>
const modifiedTimeCache = new Map();  // spreadsheetId → lastModifiedTime
let changeDetectionTimer = null;
let _onChangeDetected = null;
let _watchedSheetIds = [];

// ── Retry helper ───────────────────────────────────────────────────────────────

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let token;
    try {
      token = await GoogleAuth.getAccessToken();
    } catch (err) {
      if (err.message === 'popup_blocked' || err.message === 'refresh_failed') {
        throw err;
      }
      throw err;
    }

    const opts = {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    let nonRetryable = false;
    try {
      const res = await fetch(url, opts);

      if (res.ok) return res.json();

      if (res.status === 401 && attempt < maxRetries) {
        await GoogleAuth.handleAuthFailure();
        continue;
      }

      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
        const waitMs = retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * Math.pow(2, attempt), 16000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      const body = await res.text();
      lastError = new Error(`Sheets API ${res.status}: ${body}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
        nonRetryable = true;
      }
    } catch (err) {
      if (err.message === 'popup_blocked' || err.message === 'refresh_failed') throw err;
      lastError = err;
    }
    if (nonRetryable) throw lastError;
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

// ── Row cache helpers ──────────────────────────────────────────────────────────

const _numericSheetIdCache = new Map();

function cacheKey(spreadsheetId, tabName) {
  return `${spreadsheetId}::${tabName}`;
}

function buildRowCache(spreadsheetId, tabName, rows, idColumnIndex = 0) {
  const key = cacheKey(spreadsheetId, tabName);
  const map = new Map();
  rows.forEach((row, i) => {
    const id = row[idColumnIndex];
    if (id) map.set(id, i + 2); // +2 because row 1 is headers, API is 1-indexed
  });
  rowCache.set(key, map);
}

function getCachedRowIndex(spreadsheetId, tabName, id) {
  const key = cacheKey(spreadsheetId, tabName);
  const map = rowCache.get(key);
  return map ? map.get(id) : undefined;
}

function invalidateCache(spreadsheetId, tabName) {
  if (tabName) {
    rowCache.delete(cacheKey(spreadsheetId, tabName));
  } else {
    for (const k of rowCache.keys()) {
      if (k.startsWith(spreadsheetId + '::')) rowCache.delete(k);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

const SheetsApi = {

  // ── Read ───────────────────────────────────────────────────────────────────

  async getValues(spreadsheetId, range) {
    if (!spreadsheetId) throw new Error('No spreadsheet ID provided');
    if (isDemoSheet(spreadsheetId)) {
      return demoValuesForRange(range);
    }
    const encoded = encodeURIComponent(range);
    const data = await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encoded}`
    );
    return data.values || [];
  },

  /**
   * Get all rows from a tab and build/update the row cache.
   * @param {string} spreadsheetId
   * @param {string} tabName
   * @param {number} idColumnIndex - which column holds the ID (default 0)
   * @returns {Promise<string[][]>}
   */
  async getTabData(spreadsheetId, tabName, idColumnIndex = 0) {
    const rows = await this.getValues(spreadsheetId, `${tabName}!A2:Z`);
    buildRowCache(spreadsheetId, tabName, rows, idColumnIndex);
    return rows;
  },

  // ── Write ──────────────────────────────────────────────────────────────────

  async appendRow(spreadsheetId, tabName, values) {
    if (isDemoSheet(spreadsheetId)) return { spreadsheetId, updates: {} };
    const encoded = encodeURIComponent(`${tabName}!A:Z`);
    const result = await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encoded}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        body: JSON.stringify({ values: [values] }),
      }
    );
    invalidateCache(spreadsheetId, tabName);
    return result;
  },

  async appendRows(spreadsheetId, tabName, rowsArray) {
    if (isDemoSheet(spreadsheetId)) return { spreadsheetId, updates: {} };
    const encoded = encodeURIComponent(`${tabName}!A:Z`);
    const result = await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encoded}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        body: JSON.stringify({ values: rowsArray }),
      }
    );
    invalidateCache(spreadsheetId, tabName);
    return result;
  },

  /**
   * Update a specific row by ID. Uses cache for row index, falls back to refetch.
   */
  async updateRow(spreadsheetId, tabName, id, values, idColumnIndex = 0) {
    if (isDemoSheet(spreadsheetId)) return { spreadsheetId, updates: {} };
    let rowIndex = getCachedRowIndex(spreadsheetId, tabName, id);

    if (!rowIndex) {
      await this.getTabData(spreadsheetId, tabName, idColumnIndex);
      rowIndex = getCachedRowIndex(spreadsheetId, tabName, id);
    }

    if (!rowIndex) throw new Error(`Row with ID "${id}" not found in ${tabName}`);

    const range = encodeURIComponent(`${tabName}!A${rowIndex}:Z${rowIndex}`);
    const result = await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        body: JSON.stringify({ values: [values] }),
      }
    );
    invalidateCache(spreadsheetId, tabName);
    return result;
  },

  /**
   * Delete rows by IDs. Uses batchUpdate with deleteDimension for efficiency.
   */
  async deleteRows(spreadsheetId, tabName, ids, idColumnIndex = 0) {
    if (isDemoSheet(spreadsheetId)) return;
    // Ensure cache is fresh
    await this.getTabData(spreadsheetId, tabName, idColumnIndex);

    const rowIndices = [...new Set(ids)]
      .map(id => getCachedRowIndex(spreadsheetId, tabName, id))
      .filter(Boolean)
      .sort((a, b) => b - a);

    if (rowIndices.length === 0) return;

    const numericSheetId = await this.getNumericSheetId(spreadsheetId, tabName);

    const requests = rowIndices.map(rowIdx => ({
      deleteDimension: {
        range: {
          sheetId: numericSheetId,
          dimension: 'ROWS',
          startIndex: rowIdx - 1, // 0-indexed for batchUpdate
          endIndex: rowIdx,
        },
      },
    }));

    await this.batchUpdate(spreadsheetId, requests);
    invalidateCache(spreadsheetId, tabName);
  },

  /**
   * Batch update multiple rows efficiently (e.g., reorder).
   * @param {Array<{id, values}>} updates - each has id and full row values
   */
  async batchUpdateRows(spreadsheetId, tabName, updates, idColumnIndex = 0) {
    if (isDemoSheet(spreadsheetId)) return;
    // Ensure cache
    let hasCache = rowCache.has(cacheKey(spreadsheetId, tabName));
    if (!hasCache) {
      await this.getTabData(spreadsheetId, tabName, idColumnIndex);
    }

    const data = updates.map(u => {
      const rowIndex = getCachedRowIndex(spreadsheetId, tabName, u.id);
      if (!rowIndex) return null;
      return {
        range: `${tabName}!A${rowIndex}:Z${rowIndex}`,
        values: [u.values],
      };
    }).filter(Boolean);

    if (data.length === 0) return;

    await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data,
        }),
      }
    );
    invalidateCache(spreadsheetId, tabName);
  },

  /**
   * Upsert a balance history row. If an entry for the same account+year+month
   * exists, it is overwritten in place. Otherwise a new row is appended.
   * @param {{ forceReplaceOlder?: boolean }} [opts] - If true (manual Accounts save), allow replacing
   *   even when the new valuation date sorts before the existing UpdatedAt (same month correction).
   */
  async upsertBalanceRow(spreadsheetId, accountId, year, month, balance, dateStr, opts = {}) {
    if (isDemoSheet(spreadsheetId)) return;
    const forceReplace = opts.forceReplaceOlder === true;
    balance = Math.round(balance * 100) / 100;
    const allRows = await this.getValues(spreadsheetId, 'BalanceHistory!A2:E');
    let rowIndex = -1;

    if (allRows) {
      for (let i = 0; i < allRows.length; i++) {
        if (String(allRows[i][0]) === String(accountId) &&
            parseInt(allRows[i][1]) === year &&
            parseInt(allRows[i][2]) === month) {
          rowIndex = i + 2;
          const existingDate = allRows[i][4] || '';
          if (!forceReplace && existingDate && dateStr && existingDate > dateStr) {
            return { skipped: true, existingDate };
          }
          break;
        }
      }
    }

    const values = [accountId, year.toString(), month.toString(), balance.toString(), dateStr];

    if (rowIndex > 0) {
      await fetchWithRetry(
        `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(`BalanceHistory!A${rowIndex}:E${rowIndex}`)}?valueInputOption=RAW`,
        { method: 'PUT', body: JSON.stringify({ values: [values] }) }
      );
    } else {
      await this.appendRow(spreadsheetId, 'BalanceHistory', values);
    }

    invalidateCache(spreadsheetId, 'BalanceHistory');
  },

  /**
   * Get the latest balance for an account by reading BalanceHistory
   * and picking the most recent year+month entry.
   */
  async getCurrentBalance(spreadsheetId, accountId) {
    const allRows = await this.getValues(spreadsheetId, 'BalanceHistory!A2:E');
    if (!allRows) return 0;
    const entries = allRows
      .filter(r => r[0] === accountId)
      .map(r => ({ year: parseInt(r[1]), month: parseInt(r[2]), balance: parseFloat(r[3]) || 0, updatedAt: r[4] || '' }))
      .sort((a, b) => {
        if (b.year !== a.year) return b.year - a.year;
        if (b.month !== a.month) return b.month - a.month;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
    return entries.length > 0 ? entries[0].balance : 0;
  },

  /**
   * Replace all holdings lines for one account; keeps other accounts' rows.
   * Column E is usually GOOGLEFINANCE × shares; use symbol CASH (any case) and put the
   * cash dollar amount in shares/D for uninvested brokerage cash (no quote lookup).
   * @param {Array<{symbol: string, shares: number|string}>} lines
   */
  async syncHoldingsForAccount(spreadsheetId, accountId, lines) {
    if (isDemoSheet(spreadsheetId)) {
      syncDemoHoldingsAccount(accountId, lines);
      return;
    }
    await this.ensureTab(spreadsheetId, TABS.HOLDINGS);
    const [raw, accRows] = await Promise.all([
      this.getValues(spreadsheetId, `${TABS.HOLDINGS}!A2:E2000`).then(r => r || []),
      this.getValues(spreadsheetId, `${TABS.ACCOUNTS}!A2:C`).then(r => r || []),
    ]);
    const currencyMap = {};
    for (const r of accRows) { if (r[0]) currencyMap[String(r[0])] = (r[2] || '').toUpperCase() || 'CAD'; }

    const others = raw.filter(r => r.length >= 2 && String(r[1]) !== String(accountId) && r[0]);
    const otherData = others.map(r => [r[0] || '', r[1] || '', r[2] || '', r[3] || '']);
    const newRows = [];
    for (const line of lines) {
      const sym = (line.symbol || '').trim();
      let sh = line.shares;
      if (typeof sh === 'string') sh = sh.replace(',', '.');
      const shares = parseFloat(sh);
      if (!sym || Number.isNaN(shares) || shares === 0) continue;
      newRows.push([this.generateId(), accountId, sym, String(shares)]);
    }
    const merged = [...otherData, ...newRows];
    const withFormulas = merged.map((r, i) => {
      const row = i + 2;
      const [id, accId, sym, shares] = r;
      return [id, accId, sym, shares, holdingsMarketValueFormula(row, currencyMap[accId])];
    });
    while (withFormulas.length < raw.length) {
      withFormulas.push(['', '', '', '', '']);
    }
    const endRow = 1 + Math.max(withFormulas.length, 1);
    const range = encodeURIComponent(`${TABS.HOLDINGS}!A2:E${endRow}`);
    await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', body: JSON.stringify({ values: withFormulas }) }
    );
    invalidateCache(spreadsheetId, TABS.HOLDINGS);
    markHoldingsFormulasCurrent(spreadsheetId);
  },

  /**
   * Rewrite column E so formulas include $Z$1 as-of and FX conversion to account currency.
   */
  async ensureHoldingsMarketFormulas(spreadsheetId) {
    if (isDemoSheet(spreadsheetId)) return;
    await this.ensureTab(spreadsheetId, TABS.HOLDINGS);
    const [raw, accRows] = await Promise.all([
      this.getValues(spreadsheetId, `${TABS.HOLDINGS}!A2:D2000`).then(r => r || []),
      this.getValues(spreadsheetId, `${TABS.ACCOUNTS}!A2:C`).then(r => r || []),
    ]);
    if (raw.length === 0) return;
    const currencyMap = {};
    for (const r of accRows) { if (r[0]) currencyMap[String(r[0])] = (r[2] || '').toUpperCase() || 'CAD'; }

    const formulas = [];
    for (let i = 0; i < raw.length; i++) {
      const row = i + 2;
      const r = raw[i] || [];
      const sym = (r[2] || '').toString().trim();
      const id = (r[0] || '').toString().trim();
      const accId = (r[1] || '').toString().trim();
      if (id && sym) {
        formulas.push([holdingsMarketValueFormula(row, currencyMap[accId])]);
      } else {
        formulas.push(['']);
      }
    }
    const endRow = 1 + raw.length;
    const range = encodeURIComponent(`${TABS.HOLDINGS}!E2:E${endRow}`);
    await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', body: JSON.stringify({ values: formulas }) }
    );
    invalidateCache(spreadsheetId, TABS.HOLDINGS);
  },

  /**
   * Set Holdings!Z1 to a calendar date (historical close) or clear for live price.
   * @param {string|null|undefined} dateStr - YYYY-MM-DD, or null/empty for live quote
   */
  async setHoldingsAsOfDateCell(spreadsheetId, dateStr) {
    if (isDemoSheet(spreadsheetId)) return;
    await this.ensureTab(spreadsheetId, TABS.HOLDINGS);
    const range = encodeURIComponent(`${TABS.HOLDINGS}!${HOLDINGS_AS_OF_Z1}`);
    let cell;
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr).trim())) {
      cell = [['']];
    } else {
      const [y, m, d] = dateStr.split('-').map(Number);
      if (!y || !m || !d) cell = [['']];
      else cell = [[`=DATE(${y},${m},${d})`]];
    }
    await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', body: JSON.stringify({ values: cell }) }
    );
  },

  /**
   * Sum column E for an account after optional as-of date is applied to Z1.
   * With a date: reads live total (Z1 blank), then tries the chosen day and each prior calendar day
   * until the account total differs from live — indicating a real historical close vs GOOGLEFINANCE
   * falling back to the live quote. The local **today** is exempt: matching live is expected same-day.
   * @param {string} [asOfDateStr] - YYYY-MM-DD from balance dialog; omit or empty = live price
   * @returns {{ sum: number, valuationDate: string|null, fellBackToLive?: boolean }}
   */
  async getHoldingsMarketValueSum(spreadsheetId, accountId, asOfDateStr) {
    const trimmed = asOfDateStr && String(asOfDateStr).trim();
    const hasDate = trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed);

    if (isDemoSheet(spreadsheetId)) {
      const rows = demoValuesForRange(`${TABS.HOLDINGS}!A2:E`) || [];
      const sum = this.sumHoldingsValuesForAccount(rows, accountId);
      return { sum, valuationDate: hasDate ? trimmed : null, fellBackToLive: false };
    }

    let sum = 0;
    let valuationDate = null;
    let fellBackToLive = false;
    try {
      await this.ensureTab(spreadsheetId, TABS.HOLDINGS);
      if (holdingsFormulasNeedRefresh(spreadsheetId)) {
        await this.ensureHoldingsMarketFormulas(spreadsheetId);
        markHoldingsFormulasCurrent(spreadsheetId);
      }

      await this.setHoldingsAsOfDateCell(spreadsheetId, null);
      const rawLive = (await this.getValues(spreadsheetId, `${TABS.HOLDINGS}!A2:E2000`)) || [];
      const liveSum = this.sumHoldingsValuesForAccount(rawLive, accountId);

      if (!hasDate) {
        sum = liveSum;
        valuationDate = null;
      } else {
        let found = false;
        for (let i = 0; i <= HOLDINGS_VALUATION_MAX_DAYS_BACK; i++) {
          const tryDate = isoAddCalendarDays(trimmed, -i);
          await this.setHoldingsAsOfDateCell(spreadsheetId, tryDate);
          const raw = (await this.getValues(spreadsheetId, `${TABS.HOLDINGS}!A2:E2000`)) || [];
          const histSum = this.sumHoldingsValuesForAccount(raw, accountId);
          if (!holdingsSumMatchesLive(histSum, liveSum)) {
            sum = histSum;
            valuationDate = tryDate;
            found = true;
            break;
          }
          if (tryDate === localTodayISO()) {
            sum = histSum;
            valuationDate = tryDate;
            found = true;
            break;
          }
        }
        if (!found) {
          sum = liveSum;
          valuationDate = null;
          fellBackToLive = true;
        }
      }
    } catch {
      sum = 0;
      valuationDate = null;
      fellBackToLive = false;
    } finally {
      try {
        await this.setHoldingsAsOfDateCell(spreadsheetId, null);
      } catch (_) {}
    }
    return {
      sum,
      valuationDate,
      fellBackToLive: hasDate ? fellBackToLive : false,
    };
  },

  /**
   * Market value for one Holdings row (column E). Google may omit trailing cells, so a row can
   * have A–D only; CASH lines then fall back to D (same as the sheet formula result).
   */
  marketValueFromHoldingsRow(r) {
    if (!r || r.length < 4) return NaN;
    const sym = (r[2] || '').toString().trim();
    if (!sym) return NaN;
    let v = NaN;
    if (r.length > 4 && r[4] !== '' && r[4] != null) {
      v = parseFloat(String(r[4]).replace(/,/g, ''));
    }
    if (Number.isNaN(v) && sym.toUpperCase() === 'CASH') {
      v = parseFloat(String(r[3] ?? '').replace(/,/g, ''));
    }
    return v;
  },

  sumHoldingsValuesForAccount(rows, accountId) {
    let sum = 0;
    const id = String(accountId);
    for (const r of rows) {
      if (r.length < 4 || String(r[1]) !== id) continue;
      const v = this.marketValueFromHoldingsRow(r);
      if (!Number.isNaN(v)) sum += v;
    }
    return Math.round(sum * 100) / 100;
  },

  /** Read holdings rows (A–D) for an account; E omitted for editing. */
  async getHoldingsLinesForAccount(spreadsheetId, accountId) {
    if (isDemoSheet(spreadsheetId)) {
      const rows = demoValuesForRange(`${TABS.HOLDINGS}!A2:E`) || [];
      return rows
        .filter(r => r.length >= 3 && String(r[1]) === String(accountId))
        .map(r => ({ symbol: (r[2] || '').trim(), shares: r[3] || '' }));
    }
    await this.ensureTab(spreadsheetId, TABS.HOLDINGS);
    const raw = (await this.getValues(spreadsheetId, `${TABS.HOLDINGS}!A2:E2000`)) || [];
    return raw
      .filter(r => r.length >= 3 && String(r[1]) === String(accountId) && (r[2] || '').trim())
      .map(r => ({ symbol: (r[2] || '').trim(), shares: r[3] || '' }));
  },

  // ── Structural operations ──────────────────────────────────────────────────

  async batchUpdate(spreadsheetId, requests) {
    if (isDemoSheet(spreadsheetId)) return { spreadsheetId, replies: [] };
    return fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({ requests }),
      }
    );
  },

  async getNumericSheetId(spreadsheetId, tabName) {
    if (isDemoSheet(spreadsheetId)) return 0;
    const key = `${spreadsheetId}::${tabName}`;
    if (_numericSheetIdCache.has(key)) return _numericSheetIdCache.get(key);
    const data = await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`
    );
    const sheet = data.sheets.find(s => s.properties.title === tabName);
    if (!sheet) throw new Error(`Tab "${tabName}" not found`);
    _numericSheetIdCache.set(key, sheet.properties.sheetId);
    return sheet.properties.sheetId;
  },

  async ensureTab(spreadsheetId, tabName) {
    if (isDemoSheet(spreadsheetId)) return;
    try {
      await this.getNumericSheetId(spreadsheetId, tabName);
    } catch {
      await this.batchUpdate(spreadsheetId, [{
        addSheet: { properties: { title: tabName } },
      }]);
      const headers = TAB_HEADERS[tabName];
      if (headers) {
        await fetchWithRetry(
          `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(tabName + '!A1')}?valueInputOption=RAW`,
          { method: 'PUT', body: JSON.stringify({ values: headers }) }
        );
      }
    }
  },

  // ── Spreadsheet management ─────────────────────────────────────────────────

  /**
   * Create a new Valu group spreadsheet with all required tabs.
   */
  async createSpreadsheet(groupName, userEmail) {
    const title = `Valu: ${groupName}`;
    const now = new Date().toISOString();

    const sheets = Object.keys(TAB_HEADERS).map((tabName, i) => ({
      properties: { title: tabName, index: i },
    }));

    const result = await fetchWithRetry(
      SHEETS_BASE,
      {
        method: 'POST',
        body: JSON.stringify({
          properties: { title },
          sheets,
        }),
      }
    );

    const spreadsheetId = result.spreadsheetId;
    if (!spreadsheetId) {
      console.error('createSpreadsheet: API response missing spreadsheetId:', result);
      throw new Error('Google Sheets did not return a spreadsheet ID');
    }
    console.log('createSpreadsheet: created', spreadsheetId);

    // Write headers for each tab
    const headerData = Object.entries(TAB_HEADERS).map(([tabName, headers]) => ({
      range: `${tabName}!A1`,
      values: headers,
    }));

    await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: headerData,
        }),
      }
    );

    // Write default settings
    const settingsData = DEFAULT_SETTINGS.map(([k, v]) => {
      if (k === 'groupName') return [k, groupName];
      if (k === 'createdAt') return [k, now];
      if (k === 'createdBy') return [k, userEmail];
      return [k, v];
    });

    await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent('Settings!A2:B')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        body: JSON.stringify({ values: settingsData }),
      }
    );

    return { id: spreadsheetId, name: title };
  },

  // ── Settings (key-value tab) ───────────────────────────────────────────────

  async getSettings(spreadsheetId) {
    const rows = await this.getValues(spreadsheetId, 'Settings!A2:B');
    const settings = {};
    for (const row of rows) {
      if (row[0]) settings[row[0]] = row[1] || '';
    }
    return settings;
  },

  async updateSetting(spreadsheetId, key, value) {
    if (isDemoSheet(spreadsheetId)) { setDemoOverride(key, value); return; }
    const rows = await this.getValues(spreadsheetId, 'Settings!A2:B');
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === key) {
        rowIndex = i + 2; // +2 for 1-indexed + header row
        break;
      }
    }

    if (rowIndex > 0) {
      const range = encodeURIComponent(`Settings!A${rowIndex}:B${rowIndex}`);
      await fetchWithRetry(
        `${SHEETS_BASE}/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
        {
          method: 'PUT',
          body: JSON.stringify({ values: [[key, value]] }),
        }
      );
    } else {
      // Key doesn't exist yet — append
      await this.appendRow(spreadsheetId, TABS.SETTINGS, [key, value]);
    }
  },

  async updateSettings(spreadsheetId, settingsObj) {
    if (isDemoSheet(spreadsheetId)) { setDemoOverrides(settingsObj); return; }
    const rows = await this.getValues(spreadsheetId, 'Settings!A2:B');
    const updates = [];
    const appends = [];

    for (const [key, value] of Object.entries(settingsObj)) {
      let found = false;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][0] === key) {
          updates.push({
            range: `Settings!A${i + 2}:B${i + 2}`,
            values: [[key, value]],
          });
          found = true;
          break;
        }
      }
      if (!found) appends.push([key, value]);
    }

    if (updates.length > 0) {
      await fetchWithRetry(
        `${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`,
        {
          method: 'POST',
          body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
        }
      );
    }
    if (appends.length > 0) {
      await this.appendRows(spreadsheetId, TABS.SETTINGS, appends);
    }
  },

  // ── Drive API ──────────────────────────────────────────────────────────────

  /**
   * List all Valu spreadsheets accessible to this app (drive.file scope).
   */
  async listSpreadsheets() {
    const data = await fetchWithRetry(
      `${DRIVE_BASE}?q=${encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet'")}&fields=${encodeURIComponent('files(id,name,modifiedTime,shared,owners)')}&orderBy=modifiedTime desc&pageSize=50`
    );
    return (data.files || []).filter(f => f.name.startsWith('Valu:'));
  },

  async renameSpreadsheet(fileId, newName) {
    if (isDemoSheet(fileId)) return;
    await fetchWithRetry(`${DRIVE_BASE}/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName }),
    });
  },

  async getFileModifiedTime(fileId) {
    if (isDemoSheet(fileId)) return demoGroupMeta().modifiedTime;
    const data = await fetchWithRetry(
      `${DRIVE_BASE}/${fileId}?fields=modifiedTime`
    );
    return data.modifiedTime;
  },

  async getFileUpdateInfo(fileId) {
    if (isDemoSheet(fileId)) return { modifiedTime: demoGroupMeta().modifiedTime, lastModifyingUser: null };
    const data = await fetchWithRetry(
      `${DRIVE_BASE}/${fileId}?fields=modifiedTime,lastModifyingUser`
    );
    return {
      modifiedTime: data.modifiedTime,
      lastModifyingUser: data.lastModifyingUser || null,
    };
  },

  // ── Change detection ───────────────────────────────────────────────────────

  startChangeDetection(spreadsheetIds, callback, intervalMs = 30000) {
    _onChangeDetected = callback;
    _watchedSheetIds = spreadsheetIds;

    // Initialize timestamps
    for (const id of spreadsheetIds) {
      if (!modifiedTimeCache.has(id)) {
        modifiedTimeCache.set(id, null);
      }
    }

    this.stopChangeDetection();
    changeDetectionTimer = setInterval(() => this.checkForChanges(), intervalMs);
  },

  stopChangeDetection() {
    if (changeDetectionTimer) {
      clearInterval(changeDetectionTimer);
      changeDetectionTimer = null;
    }
  },

  async checkForChanges() {
    for (const id of _watchedSheetIds) {
      if (isDemoSheet(id)) continue;
      try {
        const modTime = await this.getFileModifiedTime(id);
        const prev = modifiedTimeCache.get(id);
        modifiedTimeCache.set(id, modTime);

        if (prev && modTime !== prev && _onChangeDetected) {
          _onChangeDetected(id);
        }
      } catch {
        // Skip — will retry next interval
      }
    }
  },

  // ── Utility ────────────────────────────────────────────────────────────────

  generateId() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  },

  invalidateCache,
};

export default SheetsApi;
const CATEGORY_ICONS = [
  'restaurant', 'fastfood', 'coffee', 'local_bar', 'bakery_dining', 'local_grocery_store',
  'directions_car', 'directions_bus', 'flight', 'local_gas_station', 'local_parking', 'directions_bike',
  'home', 'power', 'wifi', 'phone_iphone', 'tv', 'build',
  'shopping_bag', 'checkroom', 'storefront', 'local_mall',
  'movie', 'sports_esports', 'music_note', 'sports_bar',
  'local_hospital', 'fitness_center', 'spa', 'medication',
  'school', 'menu_book', 'work', 'laptop', 'business_center',
  'pets', 'child_care', 'card_giftcard', 'volunteer_activism',
  'payments', 'trending_up', 'account_balance', 'savings',
  'receipt', 'attach_money', 'sell', 'real_estate_agent',
  'cleaning_services', 'local_laundry_service',
  'hotel', 'beach_access', 'hiking',
  'security', 'gavel', 'category', 'more_horiz',
  'shopping_cart', 'bolt', 'credit_card', 'face', 'celebration', 'emoji_events',
];

const CURRENCIES = [
  { name: 'Brazilian Real', code: 'BRL' },
  { name: 'Canadian Dollar', code: 'CAD' },
  { name: 'Euro', code: 'EUR' },
  { name: 'US Dollar', code: 'USD' },
  { name: 'West African CFA Franc', code: 'XOF' },
  { name: 'Australian Dollar', code: 'AUD' },
  { name: 'British Pound', code: 'GBP' },
  { name: 'Chinese Yuan', code: 'CNY' },
  { name: 'Danish Krone', code: 'DKK' },
  { name: 'Hong Kong Dollar', code: 'HKD' },
  { name: 'Indian Rupee', code: 'INR' },
  { name: 'Japanese Yen', code: 'JPY' },
  { name: 'Mexican Peso', code: 'MXN' },
  { name: 'New Zealand Dollar', code: 'NZD' },
  { name: 'Norwegian Krone', code: 'NOK' },
  { name: 'Singapore Dollar', code: 'SGD' },
  { name: 'South African Rand', code: 'ZAR' },
  { name: 'South Korean Won', code: 'KRW' },
  { name: 'Swedish Krona', code: 'SEK' },
  { name: 'Swiss Franc', code: 'CHF' },
  { name: 'Taiwan Dollar', code: 'TWD' },
];

export { TAB_HEADERS, DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES, CATEGORY_ICONS, CURRENCIES };
