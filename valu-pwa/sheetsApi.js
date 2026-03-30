/**
 * Google Sheets API v4 + Drive API v3 data layer.
 *
 * Features: batched writes, row-index caching, retry with backoff,
 * change detection via Drive modifiedTime polling.
 */

import GoogleAuth from './googleAuth.js';
import { isDemoSheet, demoValuesForRange, demoGroupMeta } from './demoData.js';

export { isDemoSheet } from './demoData.js';
export { DEMO_SHEET_ID } from './demoData.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3/files';

// Tab names used by Valu spreadsheets
export const TABS = {
  SETTINGS:       'Settings',
  ACCOUNTS:       'Accounts',
  BALANCE_HISTORY:'BalanceHistory',
  EXPENSES:       'Expenses',
  INCOME:         'Income',
};

// Default headers for each tab when creating a new spreadsheet
const TAB_HEADERS = {
  [TABS.SETTINGS]:        [['Key', 'Value']],
  [TABS.ACCOUNTS]:        [['ID', 'Name', 'Currency', 'Type', 'Discontinued', 'Order']],
  [TABS.BALANCE_HISTORY]: [['AccountID', 'Year', 'Month', 'Balance', 'UpdatedAt']],
  [TABS.EXPENSES]:        [['ID', 'Title', 'Amount', 'AccountID', 'Category', 'Date', 'Notes', 'CreatedAt', 'BalanceAdjusted']],
  [TABS.INCOME]:          [['ID', 'Title', 'Amount', 'AccountID', 'Category', 'Date', 'Notes', 'CreatedAt', 'BalanceAdjusted']],
};

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
  ['listsEnabled',       'expenses,income,accounts'],
  ['expenseCategories',  serializeDefaultCategories(DEFAULT_EXPENSE_CATEGORIES)],
  ['incomeCategories',   serializeDefaultCategories(DEFAULT_INCOME_CATEGORIES)],
  ['currencyRates',      ''],
  ['createdAt',          ''],
  ['createdBy',          ''],
];

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
        throw new Error('popup_blocked');
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
    } catch (err) {
      if (err.message === 'popup_blocked' || err.message === 'refresh_failed') throw err;
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

// ── Row cache helpers ──────────────────────────────────────────────────────────

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

    const rowIndices = ids
      .map(id => getCachedRowIndex(spreadsheetId, tabName, id))
      .filter(Boolean)
      .sort((a, b) => b - a); // delete from bottom up

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
  },

  /**
   * Upsert a balance history row. If an entry for the same account+year+month
   * exists, it is overwritten in place. Otherwise a new row is appended.
   */
  async upsertBalanceRow(spreadsheetId, accountId, year, month, balance, dateStr) {
    if (isDemoSheet(spreadsheetId)) return;
    const allRows = await this.getValues(spreadsheetId, 'BalanceHistory!A2:E');
    let rowIndex = -1;

    if (allRows) {
      for (let i = 0; i < allRows.length; i++) {
        if (allRows[i][0] === accountId &&
            parseInt(allRows[i][1]) === year &&
            parseInt(allRows[i][2]) === month) {
          rowIndex = i + 2;
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
    const data = await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`
    );
    const sheet = data.sheets.find(s => s.properties.title === tabName);
    if (!sheet) throw new Error(`Tab "${tabName}" not found`);
    return sheet.properties.sheetId;
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
    if (isDemoSheet(spreadsheetId)) return;
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
    if (isDemoSheet(spreadsheetId)) return;
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

  async getFileModifiedTime(fileId) {
    if (isDemoSheet(fileId)) return demoGroupMeta().modifiedTime;
    const data = await fetchWithRetry(
      `${DRIVE_BASE}/${fileId}?fields=modifiedTime`
    );
    return data.modifiedTime;
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
