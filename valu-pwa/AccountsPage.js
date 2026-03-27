import SheetsApi, { TABS, normalizeDiscontinuedCell, formatAccountDisplayName } from './sheetsApi.js';

const { ref, computed, onMounted, watch, inject } = Vue;

export default {
  props: ['sheetId', 'settings', 'showUpdateReminder'],
  emits: ['refresh', 'go-home', 'accounts-updated'],

  setup(props, { emit }) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    function getSheetId() { return props.sheetId || injectedSheetId.value; }
    const accounts = ref([]);
    const balanceHistory = ref([]);
    const loading = ref(true);
    const showAddModal = ref(false);
    const showEditModal = ref(false);
    const showHistoryModal = ref(false);
    const showBalanceModal = ref(false);
    const showInfoPopover = ref(false);
    const currencyDropdownOpen = ref(false);
    const currencySearch = ref('');
    const openDropdown = ref(null);
    const updateMode = ref(false);
    const editingAccount = ref(null);
    const historyAccount = ref(null);
    const updateBalances = ref({});
    const updateDate = ref(todayStr());

    const balanceEntry = ref({ accountId: '', date: todayStr(), amount: '' });

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');

    const newAccount = ref({
      name: '',
      currency: baseCurrency.value,
      type: 'Checking/Debit',
    });

    const ACCOUNT_TYPES = ['Checking/Debit', 'Saving', 'Credit', 'Investment'];

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

    const filteredCurrencies = computed(() => {
      const q = currencySearch.value.toLowerCase();
      if (!q) return CURRENCIES;
      return CURRENCIES.filter(c => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
    });

    function currencyName(code) {
      const found = CURRENCIES.find(c => c.code === code);
      return found ? found.name : code;
    }

    function selectCurrency(code, target) {
      if (target === 'new') {
        newAccount.value.currency = code;
      } else if (editingAccount.value) {
        editingAccount.value.currency = code;
        // Persist only — full saveEdit() closes the sheet (bad UX for picker taps)
        persistEditToSheet();
      }
      currencyDropdownOpen.value = false;
      currencySearch.value = '';
    }

    const currencyRates = computed(() => {
      const ratesStr = props.settings?.currencyRates || '';
      const map = {};
      ratesStr.split(',').filter(Boolean).forEach(r => {
        const [cur, val] = r.split(':');
        if (cur && val) map[cur] = parseFloat(val);
      });
      return map;
    });

    function todayStr() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function parseDateParts(dateStr) {
      const [y, m] = dateStr.split('-').map(Number);
      return { year: y, month: m };
    }

    function convertToBase(amount, fromCurrency) {
      if (!fromCurrency || fromCurrency === baseCurrency.value) return amount;
      const rate = currencyRates.value[fromCurrency];
      return rate ? amount * rate : amount;
    }

    function formatCurrency(amount, currency) {
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency', currency: currency || baseCurrency.value,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        }).format(amount);
      } catch {
        return amount.toFixed(2) + ' ' + (currency || '');
      }
    }

    function getCurrentBalance(accountId) {
      const entries = balanceHistory.value
        .filter(h => h.accountId === accountId)
        .sort((a, b) => {
          if (b.year !== a.year) return b.year - a.year;
          if (b.month !== a.month) return b.month - a.month;
          return (b.updatedAt || '').localeCompare(a.updatedAt || '');
        });
      return entries.length > 0 ? entries[0].balance : 0;
    }

    function getLastUpdateDate(accountId) {
      const entries = balanceHistory.value
        .filter(h => h.accountId === accountId && h.updatedAt)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      if (entries.length === 0) return null;
      return entries[0].updatedAt;
    }

    function formatUpdateDate(dateStr) {
      if (!dateStr) return '';
      const parts = dateStr.split('-');
      if (parts.length >= 3) {
        const [y, m, d] = parts.map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(undefined, {
          month: 'short', day: 'numeric', year: 'numeric',
        });
      }
      return dateStr;
    }

    function getAccountDiff(accountId) {
      const now = new Date();
      const curY = now.getFullYear();
      const curM = now.getMonth() + 1;
      const prevM = curM === 1 ? 12 : curM - 1;
      const prevY = curM === 1 ? curY - 1 : curY;

      const current = getCurrentBalance(accountId);
      const prevEntries = balanceHistory.value
        .filter(h => h.accountId === accountId && h.year === prevY && h.month === prevM);
      if (prevEntries.length === 0) return null;
      return current - prevEntries[0].balance;
    }

    const activeAccounts = computed(() =>
      accounts.value.filter(a => a.discontinued !== 'true')
    );

    const discontinuedAccounts = computed(() =>
      accounts.value.filter(a => a.discontinued === 'true')
    );

    const totalNetWorth = computed(() => {
      return activeAccounts.value.reduce((sum, a) => {
        const bal = getCurrentBalance(a.id);
        return sum + convertToBase(bal, a.currency);
      }, 0);
    });

    const needsUpdate = computed(() => {
      if (activeAccounts.value.length === 0) return false;
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      return activeAccounts.value.some(a => {
        const lastDate = getLastUpdateDate(a.id);
        if (!lastDate) return true;
        const parts = lastDate.split('-');
        const lastMonth = `${parts[0]}-${parts[1]}`;
        return lastMonth < currentMonth;
      });
    });

    async function fetchData() {
      loading.value = true;
      try {
        const [accRows, histRows] = await Promise.all([
          SheetsApi.getTabData(getSheetId(), TABS.ACCOUNTS),
          SheetsApi.getTabData(getSheetId(), TABS.BALANCE_HISTORY),
        ]);

        accounts.value = accRows.map(r => ({
          id: r[0], name: r[1], currency: r[2],
          type: r[3], discontinued: normalizeDiscontinuedCell(r[4]), order: r[5],
        }));

        balanceHistory.value = histRows.map(r => ({
          accountId: r[0], year: parseInt(r[1]),
          month: parseInt(r[2]), balance: parseFloat(r[3]) || 0,
          updatedAt: r[4],
        }));

        emit('accounts-updated', accounts.value);
      } catch (err) {
        if (err.message === 'popup_blocked') return;
        console.error('Failed to load accounts:', err);
      } finally {
        loading.value = false;
      }
    }

    async function addAccount() {
      const acc = newAccount.value;
      if (!acc.name.trim()) return;

      const id = SheetsApi.generateId();
      const currency = acc.currency || baseCurrency.value;
      const order = accounts.value.length.toString();

      await SheetsApi.appendRow(getSheetId(), TABS.ACCOUNTS, [
        id, acc.name.trim(), currency, acc.type, 'false', order,
      ]);

      showAddModal.value = false;
      newAccount.value = {
        name: '',
        currency: baseCurrency.value,
        type: 'Checking/Debit',
      };
      await fetchData();
    }

    function startEdit(account) {
      editingAccount.value = { ...account };
      historyAccount.value = account;
      const lastBal = getCurrentBalance(account.id);
      balanceEntry.value = {
        accountId: account.id,
        date: todayStr(),
        amount: lastBal ? lastBal.toString() : '',
      };
      sheetSwipeStep.value = false;
      showEditModal.value = true;
    }

    const sheetSwipeStep = ref(false);

    /** Write current editingAccount row to the sheet without closing the modal */
    async function persistEditToSheet() {
      const acc = editingAccount.value;
      if (!acc) return;
      await SheetsApi.updateRow(getSheetId(), TABS.ACCOUNTS, acc.id, [
        acc.id, acc.name, acc.currency, acc.type, acc.discontinued, acc.order,
      ]);
      await fetchData();
    }

    async function saveEdit() {
      await persistEditToSheet();
      showEditModal.value = false;
      editingAccount.value = null;
    }

    async function deleteAccount(id) {
      if (!confirm('Delete this account and all its balance history?')) return;
      await SheetsApi.deleteRows(getSheetId(), TABS.ACCOUNTS, [id]);
      await fetchData();
    }

    function showHistory(account) {
      historyAccount.value = account;
      showHistoryModal.value = true;
    }

    const accountHistory = computed(() => {
      if (!historyAccount.value) return [];
      return balanceHistory.value
        .filter(h => h.accountId === historyAccount.value.id)
        .sort((a, b) => {
          if (b.year !== a.year) return b.year - a.year;
          if (b.month !== a.month) return b.month - a.month;
          return (b.updatedAt || '').localeCompare(a.updatedAt || '');
        });
    });

    // ── Individual balance recording ─────────────────────────────────────────

    function openBalanceUpdate(account) {
      const lastBal = getCurrentBalance(account.id);
      balanceEntry.value = {
        accountId: account.id,
        date: todayStr(),
        amount: lastBal ? lastBal.toString() : '',
      };
      showBalanceModal.value = true;
    }

    function getAccountById(id) {
      return accounts.value.find(a => a.id === id);
    }

    function editHistoryEntry(h) {
      const dateStr = h.updatedAt || `${h.year}-${String(h.month).padStart(2, '0')}-01`;
      balanceEntry.value = {
        accountId: historyAccount.value.id,
        date: dateStr,
        amount: h.balance.toString(),
      };
      showBalanceModal.value = true;
    }

    async function saveBalance() {
      const entry = balanceEntry.value;
      if (!entry.accountId || entry.amount === '') return;

      const { year, month } = parseDateParts(entry.date);
      const dateStr = entry.date;

      await upsertBalance(entry.accountId, year, month, entry.amount, dateStr);
      showBalanceModal.value = false;
      await fetchData();
    }

    // ── Bulk update mode ─────────────────────────────────────────────────────

    function enterUpdateMode() {
      updateMode.value = true;
      updateDate.value = todayStr();
      const balances = {};
      for (const acc of activeAccounts.value) {
        const lastBal = getCurrentBalance(acc.id);
        balances[acc.id] = lastBal ? lastBal.toString() : '';
      }
      updateBalances.value = balances;
    }

    async function saveBalanceUpdates() {
      const { year, month } = parseDateParts(updateDate.value);
      const dateStr = updateDate.value;

      for (const acc of activeAccounts.value) {
        const val = updateBalances.value[acc.id];
        if (val === '' || val === undefined) continue;
        await upsertBalance(acc.id, year, month, val, dateStr);
      }

      updateMode.value = false;
      await fetchData();
    }

    // ── Shared upsert helper ─────────────────────────────────────────────────

    async function upsertBalance(accountId, year, month, amount, dateStr) {
      await SheetsApi.upsertBalanceRow(getSheetId(), accountId, year, month, amount, dateStr);
    }

    function monthName(m) {
      return new Date(2000, m - 1).toLocaleString(undefined, { month: 'long' });
    }

    const previousMonthDiff = computed(() => {
      const now = new Date();
      const curY = now.getFullYear();
      const curM = now.getMonth() + 1;
      let prevY = curY, prevM = curM - 1;
      if (prevM < 1) { prevM = 12; prevY--; }

      let currentTotal = 0, prevTotal = 0;
      for (const acc of activeAccounts.value) {
        const cur = getCurrentBalance(acc.id);
        currentTotal += convertToBase(cur, acc.currency);

        const prevEntries = balanceHistory.value
          .filter(h => h.accountId === acc.id && h.year === prevY && h.month === prevM);
        if (prevEntries.length > 0) {
          prevTotal += convertToBase(prevEntries[0].balance, acc.currency);
        }
      }
      return currentTotal - prevTotal;
    });

    watch(() => getSheetId(), (id) => { if (id) fetchData(); }, { immediate: true });

    watch(showAddModal, (v) => {
      if (!v) {
        currencyDropdownOpen.value = false;
        currencySearch.value = '';
        openDropdown.value = null;
      } else {
        newAccount.value.currency = baseCurrency.value;
      }
    });
    watch(showEditModal, (v) => {
      if (!v) {
        currencyDropdownOpen.value = false;
        currencySearch.value = '';
        openDropdown.value = null;
      }
    });

    function setDropdownOpen(id, isOpen) {
      if (isOpen) openDropdown.value = id;
      else if (openDropdown.value === id) openDropdown.value = null;
    }

    function selectDropdownOption(name, value, target, field) {
      if (target === 'new') {
        newAccount.value[field] = value;
      } else if (editingAccount.value) {
        editingAccount.value[field] = value;
        persistEditToSheet();
      }
      openDropdown.value = null;
    }

    return {
      accounts, loading, activeAccounts, discontinuedAccounts,
      showAddModal, showEditModal, showHistoryModal, showBalanceModal, showInfoPopover,
      newAccount, editingAccount, historyAccount, accountHistory,
      updateMode, updateBalances, updateDate, needsUpdate,
      balanceEntry, getAccountById, sheetSwipeStep,
      totalNetWorth, previousMonthDiff, baseCurrency, ACCOUNT_TYPES, CURRENCIES,
      currencyDropdownOpen, currencySearch, filteredCurrencies, openDropdown,
      currencyName, selectCurrency,
      setDropdownOpen, selectDropdownOption,
      formatAccountDisplayName,
      formatCurrency, getCurrentBalance, getLastUpdateDate, formatUpdateDate,
      convertToBase, getAccountDiff,
      addAccount, startEdit, saveEdit, persistEditToSheet, deleteAccount,
      showHistory, openBalanceUpdate, saveBalance, editHistoryEntry,
      enterUpdateMode, saveBalanceUpdates, monthName,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <!-- Nav row (matches original: ← ... Accounts ... orb) -->
      <div class="subpage-nav">
        <button class="subpage-back" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <div class="valu-orb-sm subpage-orb">
          <div class="spheres">
            <div class="spheres-group">
              <div class="sphere s1"></div>
              <div class="sphere s2"></div>
              <div class="sphere s3"></div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="loading" class="loading" style="padding-top:40px;"><div class="spinner"></div>Loading accounts...</div>

      <template v-else>
        <!-- Centered header (matches screenshot exactly) -->
        <div class="subpage-header">
          <h1 class="subpage-title">Accounts</h1>
          <h2 class="subpage-balance">{{ formatCurrency(totalNetWorth, baseCurrency) }}</h2>
          <div class="subpage-diff" :class="previousMonthDiff >= 0 ? 'diff-positive' : 'diff-negative'">
            <span class="material-icons subpage-diff-arrow">{{ previousMonthDiff >= 0 ? 'trending_up' : 'trending_down' }}</span>
            <span class="subpage-diff-value">{{ formatCurrency(Math.abs(previousMonthDiff), baseCurrency) }}</span>
            <button class="subpage-diff-btn" @click="showInfoPopover = !showInfoPopover">
              <span class="material-icons subpage-diff-icon">info_outline</span>
            </button>
          </div>
        </div>

        <!-- Account list (card rows matching original) -->
        <div class="valu-list">
          <div v-for="acc in activeAccounts" :key="acc.id"
               class="valu-list-card"
               @click="startEdit(acc)">
            <div class="valu-list-row">
              <div class="valu-list-name">{{ formatAccountDisplayName(acc) }}</div>
              <div class="valu-list-after">{{ formatCurrency(getCurrentBalance(acc.id), acc.currency || baseCurrency) }}</div>
            </div>
            <div class="valu-list-row valu-list-row-sub">
              <div class="valu-list-sub">
                <span v-if="getLastUpdateDate(acc.id)">Updated {{ formatUpdateDate(getLastUpdateDate(acc.id)) }}</span>
                <span v-else>No updates yet</span>
              </div>
              <div class="valu-list-diff" v-if="getAccountDiff(acc.id) !== null"
                   :class="getAccountDiff(acc.id) >= 0 ? 'diff-positive' : 'diff-negative'">
                {{ getAccountDiff(acc.id) >= 0 ? '+ ' : '- ' }}{{ formatCurrency(Math.abs(getAccountDiff(acc.id)), acc.currency || baseCurrency) }}
              </div>
            </div>
          </div>

          <!-- Discontinued (separate block so status is obvious) -->
          <div v-if="discontinuedAccounts.length > 0" class="accounts-discontinued-block">
            <div class="accounts-discontinued-heading">
              <span class="material-icons" aria-hidden="true">inventory_2</span>
              Discontinued accounts
            </div>
            <p class="accounts-discontinued-hint">Hidden from net worth totals. Tap to edit or turn off discontinued.</p>
            <div v-for="acc in discontinuedAccounts" :key="acc.id"
                 class="valu-list-card valu-list-card-discontinued"
                 @click="startEdit(acc)">
              <div class="valu-list-row">
                <div class="valu-list-name">{{ formatAccountDisplayName(acc) }}</div>
                <div class="valu-list-after">{{ formatCurrency(getCurrentBalance(acc.id), acc.currency || baseCurrency) }}</div>
              </div>
              <div class="valu-list-row valu-list-row-sub">
                <div class="valu-list-sub">
                  <span v-if="getLastUpdateDate(acc.id)">Updated {{ formatUpdateDate(getLastUpdateDate(acc.id)) }}</span>
                  <span v-else>No updates yet</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Empty state -->
        <div v-if="accounts.length === 0" class="empty-state" style="padding-top:40px;">
          <span class="material-icons">account_balance</span>
          <h3>No accounts yet</h3>
          <p>Add your bank accounts, savings, or investment accounts.</p>
        </div>

        <!-- Fixed ADD ACCOUNT at bottom with gradient fade -->
        <div class="subpage-bottom-fixed">
          <button class="btn-add-outline" @click="showAddModal = true">ADD ACCOUNT</button>
        </div>
      </template>
      </div>

      <!-- Add Account Sheet -->
      <div class="modal-overlay" :class="{ open: showAddModal }" @click.self="showAddModal = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-body" style="padding-top:8px; text-align:center;">
            <input class="sheet-hero-name-solo" v-model="newAccount.name" placeholder="Account name" />
          </div>
          <div class="modal-body" @click="currencyDropdownOpen = false; openDropdown = null">
            <div class="sheet-section-title">Details</div>
            <div class="sheet-list-item">
              <label>Account type</label>
              <valu-dropdown :open="openDropdown === 'newType'" @update:open="(v) => setDropdownOpen('newType', v)">
                <template #label>{{ newAccount.type }}</template>
                <div v-for="t in ACCOUNT_TYPES" :key="t"
                     class="valu-dropdown-option" :class="{ selected: t === newAccount.type }"
                     @click="selectDropdownOption('newType', t, 'new', 'type')">{{ t }}</div>
              </valu-dropdown>
            </div>
            <div class="sheet-list-item">
              <label>Currency</label>
              <valu-currency-picker v-if="showAddModal" v-model:open="currencyDropdownOpen" v-model:search="currencySearch">
                <template #label>{{ newAccount.currency ? currencyName(newAccount.currency) : 'Select currency' }}</template>
                <div v-for="c in filteredCurrencies" :key="c.code"
                     class="currency-picker-option" :class="{ selected: c.code === newAccount.currency }"
                     @click="selectCurrency(c.code, 'new')">{{ c.name }}</div>
                <div v-if="filteredCurrencies.length === 0" class="currency-picker-empty">No match</div>
              </valu-currency-picker>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" @click="addAccount" :disabled="!newAccount.name.trim()">Add new account</button>
          </div>
        </div>
      </div>

      <!-- Account Detail Sheet (swipe-to-step like original) -->
      <div class="modal-overlay" :class="{ open: showEditModal }" @click.self="showEditModal = false">
        <div class="modal sheet-swipe-step" :class="{ expanded: sheetSwipeStep }" v-if="editingAccount">
          <div class="sheet-handle" @click="sheetSwipeStep = !sheetSwipeStep"></div>

          <!-- First step: account name, balance, history, CTA -->
          <div class="sheet-step-main">
            <div class="modal-body" style="padding-top:8px;">
              <div class="sheet-hero-name-row">
                <input class="sheet-hero-name" v-model="editingAccount.name" placeholder="Account name"
                       @change="saveEdit()" />
                <span class="material-icons sheet-hero-edit-icon">edit</span>
              </div>
              <div class="sheet-hero-amount-display">{{ formatCurrency(getCurrentBalance(editingAccount.id), editingAccount.currency || baseCurrency) }}</div>
              <div class="sheet-hero-label">Balance</div>
            </div>

            <!-- Balance history (scrollable) -->
            <div class="sheet-history-list" v-if="accountHistory.length > 0">
              <div v-for="h in accountHistory" :key="h.year + '-' + h.month"
                   class="sheet-history-item" @click="editHistoryEntry(h)">
                <span class="sheet-history-date">{{ monthName(h.month) }} {{ h.year }}</span>
                <span class="sheet-history-amount">
                  {{ formatCurrency(h.balance, editingAccount.currency || baseCurrency) }}
                </span>
              </div>
            </div>

            <div style="padding:0 16px 16px;">
              <button type="button" class="btn-sheet-cta-outline" @click="openBalanceUpdate(editingAccount)">Store new balance</button>
              <div class="sheet-swipe-hint" @click="sheetSwipeStep = !sheetSwipeStep">
                {{ sheetSwipeStep ? 'Click for less details' : 'Click for more details' }}
              </div>
            </div>
          </div>

          <!-- Second step: Details (revealed on swipe/click) -->
          <div class="sheet-step-details" @click="currencyDropdownOpen = false; openDropdown = null">
            <div class="sheet-section-title">Details</div>
            <div class="sheet-list-item">
              <label>Account type</label>
              <valu-dropdown :open="openDropdown === 'editType'" @update:open="(v) => setDropdownOpen('editType', v)">
                <template #label>{{ editingAccount.type }}</template>
                <div v-for="t in ACCOUNT_TYPES" :key="t"
                     class="valu-dropdown-option" :class="{ selected: t === editingAccount.type }"
                     @click="selectDropdownOption('editType', t, 'edit', 'type')">{{ t }}</div>
              </valu-dropdown>
            </div>
            <div class="sheet-list-item">
              <label>Currency</label>
              <valu-currency-picker v-if="showEditModal && editingAccount" v-model:open="currencyDropdownOpen" v-model:search="currencySearch">
                <template #label>{{ editingAccount.currency ? currencyName(editingAccount.currency) : 'Select currency' }}</template>
                <div v-for="c in filteredCurrencies" :key="c.code"
                     class="currency-picker-option" :class="{ selected: c.code === editingAccount.currency }"
                     @click="selectCurrency(c.code, 'edit')">{{ c.name }}</div>
                <div v-if="filteredCurrencies.length === 0" class="currency-picker-empty">No match</div>
              </valu-currency-picker>
            </div>
            <div class="sheet-list-item sheet-list-item-toggle">
              <label>Discontinued</label>
              <label class="toggle">
                <input type="checkbox" :checked="editingAccount.discontinued === 'true'"
                       @change="editingAccount.discontinued = $event.target.checked ? 'true' : 'false'; persistEditToSheet()" />
                <div class="toggle-track"></div>
                <div class="toggle-thumb"></div>
              </label>
            </div>
            <div style="padding:16px;">
              <button class="btn btn-text btn-danger" @click="deleteAccount(editingAccount.id); showEditModal = false;">Delete account</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Record Balance Sheet (higher z-index, for editing a specific history entry) -->
      <div class="modal-overlay modal-overlay-top" :class="{ open: showBalanceModal }" @click.self="showBalanceModal = false">
        <div class="modal" v-if="showBalanceModal">
          <div class="sheet-handle"></div>
          <div class="modal-body" style="padding-top:8px; text-align:center;">
            <input class="sheet-hero-amount-input" type="number" step="0.01" v-model="balanceEntry.amount" placeholder="0" autofocus />
            <div class="sheet-hero-label">Balance</div>
          </div>
          <div class="modal-body">
            <div class="sheet-list-item">
              <label>Date</label>
              <valu-date-field v-model="balanceEntry.date" />
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" @click="saveBalance" :disabled="balanceEntry.amount === ''">Store new balance</button>
          </div>
        </div>
      </div>

      <!-- Info popover (last in DOM to ensure it renders on top of everything) -->
      <div class="popover-backdrop" v-if="showInfoPopover" @click="showInfoPopover = false"></div>
      <div class="popover-fixed" v-if="showInfoPopover">
        <div class="popover-arrow"></div>
        <div class="popover-content">Compared to the previous month</div>
      </div>
    </div>
  `,
};
