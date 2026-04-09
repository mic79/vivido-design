import SheetsApi, {
  TABS, normalizeDiscontinuedCell, formatAccountDisplayName, CURRENCIES,
  isInvestmentAccountType,
} from './sheetsApi.js';
import { useFxConvert } from './useFxConvert.js';

const { ref, computed, onMounted, watch, inject, nextTick } = Vue;

export default {
  props: ['sheetId', 'settings', 'showUpdateReminder', 'accountsEntryIntent', 'isDemoGroup'],
  emits: ['refresh', 'go-home', 'accounts-updated', 'settings-updated', 'navigate', 'accounts-intent-consumed'],

  setup(props, { emit }) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    const showAlert = inject('showAlert', m => window.alert(m));
    const showConfirm = inject('showConfirm', m => Promise.resolve(window.confirm(m)));
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

    /** accountId -> count of holdings rows with a symbol */
    const holdingsRowCount = ref({});
    const editHoldingsLines = ref([{ symbol: '', shares: '' }]);
    const savingHoldings = ref(false);
    const loadingHoldingsEdit = ref(false);
    const sheetTotalLoading = ref(false);

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');
    const manualRates = computed(() => {
      const str = props.settings?.currencyRates || '';
      return str.split(',').filter(Boolean).map(r => { const [currency, rate] = r.split(':'); return { currency, rate }; });
    });

    const newAccount = ref({
      name: '',
      currency: baseCurrency.value,
      type: 'Checking/Debit',
    });

    const ACCOUNT_TYPES = ['Checking/Debit', 'Saving', 'Credit', 'Investment'];

    // CURRENCIES imported from sheetsApi.js

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

    function todayStr() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function parseDateParts(dateStr) {
      const [y, m] = dateStr.split('-').map(Number);
      return { year: y, month: m };
    }

    function prevMonthLastDayISO() {
      const d = new Date();
      const last = new Date(d.getFullYear(), d.getMonth(), 0);
      return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
    }

    function hasHoldingsRows(accountId) {
      return (holdingsRowCount.value[accountId] || 0) > 0;
    }

    async function refreshHoldingsRowCounts() {
      holdingsRowCount.value = {};
      const sid = getSheetId();
      if (!sid) return;
      try {
        await SheetsApi.ensureTab(sid, TABS.HOLDINGS);
        const raw = (await SheetsApi.getValues(sid, `${TABS.HOLDINGS}!A2:E2000`)) || [];
        const counts = {};
        for (const r of raw) {
          if (r.length < 3 || !(String(r[2] || '').trim())) continue;
          const aid = String(r[1]);
          counts[aid] = (counts[aid] || 0) + 1;
        }
        holdingsRowCount.value = counts;
      } catch {
        holdingsRowCount.value = {};
      }
    }


    function getNumberLocale() {
      const pref = localStorage.getItem('valu_number_format') || 'auto';
      return pref === 'auto' ? undefined : pref;
    }

    function amountToInput(num) {
      const pref = localStorage.getItem('valu_number_format') || 'auto';
      const str = Number(num).toString();
      if (pref === 'de-DE') return str.replace('.', ',');
      return str;
    }

    function sanitizeAmount(obj, key) {
      const raw = obj[key];
      if (typeof raw !== 'string') return;
      let s = raw.replace(/[^0-9.,-]/g, '');
      s = s.replace(/^(-?)(.*)/, (_, sign, rest) => sign + rest.replace(/-/g, ''));
      s = s.replace(/([.,])([.,])/g, '$1');
      s = s.replace(/([.,])([.,])/g, '$1');
      obj[key] = s;
    }

    function parseAmount(val) {
      if (typeof val === 'number') return val;
      if (!val || typeof val !== 'string') return NaN;
      const s = val.trim();
      const lastDot = s.lastIndexOf('.');
      const lastComma = s.lastIndexOf(',');
      if (lastComma > lastDot) {
        return parseFloat(s.replace(/\./g, '').replace(',', '.'));
      }
      return parseFloat(s.replace(/,/g, ''));
    }

    function formatCurrency(amount, currency) {
      try {
        const cur = currency || baseCurrency.value;
        const numLocale = getNumberLocale();
        const sym = new Intl.NumberFormat(undefined, {
          style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol',
        }).formatToParts(0).find(p => p.type === 'currency')?.value || cur;
        const num = new Intl.NumberFormat(numLocale, {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        }).format(amount);
        return sym + num;
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
        .filter(h => h.accountId === accountId && h.year === prevY && h.month === prevM)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      if (prevEntries.length === 0) return null;
      return Math.round((current - prevEntries[0].balance) * 100) / 100;
    }

    function orderSort(a, b) {
      const oa = parseInt(a.order) || 0;
      const ob = parseInt(b.order) || 0;
      return oa - ob;
    }

    const activeAccounts = computed(() =>
      accounts.value.filter(a => a.discontinued !== 'true').slice().sort(orderSort)
    );

    const discontinuedAccounts = computed(() =>
      accounts.value.filter(a => a.discontinued === 'true').slice().sort(orderSort)
    );

    const totalNetWorth = computed(() => {
      return activeAccounts.value.reduce((sum, a) => {
        const bal = getCurrentBalance(a.id);
        return bal != null ? sum + bal : sum;
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
          month: parseInt(r[2]), balance: Math.round((parseFloat(r[3]) || 0) * 100) / 100,
          updatedAt: r[4],
        }));

        emit('accounts-updated', accounts.value);
        await refreshHoldingsRowCounts();
      } catch (err) {
        if (err.message === 'popup_blocked' || err.message === 'refresh_failed') return;
        console.error('Failed to load accounts:', err);
      } finally {
        loading.value = false;
      }
    }

    async function addAccount() {
      const acc = newAccount.value;
      if (!acc.name.trim()) return;
      try {
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
      } catch (err) {
        console.error('Failed to add account:', err);
        showAlert('Failed to save. Please try again.');
      }
    }

    async function loadEditHoldingsLines(accountId) {
      loadingHoldingsEdit.value = true;
      try {
        const lines = await SheetsApi.getHoldingsLinesForAccount(getSheetId(), accountId);
        editHoldingsLines.value = lines.length
          ? lines.map(l => ({ symbol: l.symbol, shares: String(l.shares) }))
          : [{ symbol: '', shares: '' }];
      } catch (err) {
        console.error('Holdings load failed:', err);
        editHoldingsLines.value = [{ symbol: '', shares: '' }];
      } finally {
        loadingHoldingsEdit.value = false;
      }
    }

    function addHoldingRow() {
      editHoldingsLines.value.push({ symbol: '', shares: '' });
    }

    function removeHoldingRow(idx) {
      editHoldingsLines.value.splice(idx, 1);
      if (editHoldingsLines.value.length === 0) editHoldingsLines.value.push({ symbol: '', shares: '' });
    }

    async function saveHoldings() {
      if (!editingAccount.value) return;
      savingHoldings.value = true;
      try {
        await SheetsApi.syncHoldingsForAccount(
          getSheetId(),
          editingAccount.value.id,
          editHoldingsLines.value.map(l => ({ symbol: l.symbol, shares: l.shares }))
        );
        await refreshHoldingsRowCounts();
        showAlert('Holdings saved. Market values use GOOGLEFINANCE in your Google Sheet.');
      } catch (err) {
        console.error('Failed to save holdings:', err);
        showAlert('Could not save holdings. Check your connection and try again.');
      } finally {
        savingHoldings.value = false;
      }
    }

    async function startEdit(account) {
      editingAccount.value = { ...account };
      historyAccount.value = account;
      const lastBal = getCurrentBalance(account.id);
      balanceEntry.value = {
        accountId: account.id,
        date: todayStr(),
        amount: lastBal != null ? amountToInput(lastBal) : '',
      };
      sheetSwipeStep.value = false;
      showEditModal.value = true;
      if (isInvestmentAccountType(account.type)) {
        await loadEditHoldingsLines(account.id);
      } else {
        editHoldingsLines.value = [{ symbol: '', shares: '' }];
      }
    }

    const sheetSwipeStep = ref(false);

    /** Write current editingAccount row to the sheet without closing the modal */
    async function persistEditToSheet() {
      const acc = editingAccount.value;
      if (!acc) return;
      try {
        await SheetsApi.updateRow(getSheetId(), TABS.ACCOUNTS, acc.id, [
          acc.id, acc.name, acc.currency, acc.type, acc.discontinued, acc.order,
        ]);
        await fetchData();
      } catch (err) {
        console.error('Failed to save account:', err);
        showAlert('Failed to save. Please try again.');
      }
    }

    async function saveEdit() {
      await persistEditToSheet();
      showEditModal.value = false;
      editingAccount.value = null;
    }

    async function deleteAccount(id) {
      if (!(await showConfirm('Delete this account? Balance history entries will be kept.'))) return;
      try {
        await SheetsApi.deleteRows(getSheetId(), TABS.ACCOUNTS, [id]);
        showEditModal.value = false;
        editingAccount.value = null;
        await fetchData();
      } catch (err) {
        console.error('Failed to delete account:', err);
        showAlert('Failed to delete. Please try again.');
      }
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

    function getBalanceAccountCurrency() {
      const acc = accounts.value.find(a => a.id === balanceEntry.value.accountId);
      return acc ? (acc.currency || baseCurrency.value) : baseCurrency.value;
    }

    const balFx = useFxConvert({
      foreignCurrency: computed(() => getBalanceAccountCurrency()),
      baseCurrency,
      dateStr: computed(() => balanceEntry.value.date || todayStr()),
      setAmount: v => { balanceEntry.value.amount = v; },
      manualRates,
    });

    async function fillBalanceFromSheetTotal(accountId) {
      sheetTotalLoading.value = true;
      try {
        const r = await SheetsApi.getHoldingsMarketValueSum(
          getSheetId(),
          accountId,
          balanceEntry.value.date
        );
        balanceEntry.value.amount = amountToInput(r.sum);
        if (r.valuationDate) balanceEntry.value.date = r.valuationDate;
        if (r.fellBackToLive) {
          showAlert(
            'Totals still matched the live quote after trying earlier dates (up to 45 days). Amount reflects live prices; pick another date or enter the balance manually.'
          );
        }
      } catch (err) {
        console.error('Sheet total failed:', err);
        showAlert('Could not read totals from the Holdings sheet.');
      } finally {
        sheetTotalLoading.value = false;
      }
    }

    /**
     * @param {object} account
     * @param {{ dateStr?: string, useSheetTotal?: boolean }} [opts] useSheetTotal: fill from GOOGLEFINANCE sum (latest sheet calc)
     */
    async function openBalanceUpdate(account, opts = {}) {
      const lastBal = getCurrentBalance(account.id);
      const dateStr = opts.dateStr || todayStr();
      balanceEntry.value = {
        accountId: account.id,
        date: dateStr,
        amount: lastBal != null ? amountToInput(lastBal) : '',
      };
      balFx.reset();
      showBalanceModal.value = true;
      const useSheet = opts.useSheetTotal !== false
        && isInvestmentAccountType(account.type)
        && hasHoldingsRows(account.id);
      if (useSheet) {
        await fillBalanceFromSheetTotal(account.id);
      }
    }

    function getAccountById(id) {
      return accounts.value.find(a => a.id === id);
    }

    function editHistoryEntry(h) {
      const dateStr = h.updatedAt || `${h.year}-${String(h.month).padStart(2, '0')}-01`;
      balanceEntry.value = {
        accountId: historyAccount.value.id,
        date: dateStr,
        amount: amountToInput(h.balance),
      };
      showBalanceModal.value = true;
    }

    async function saveBalance() {
      const entry = balanceEntry.value;
      if (!entry.accountId || entry.amount === '') return;
      const amt = parseAmount(entry.amount);
      if (isNaN(amt)) return;
      try {
        const { year, month } = parseDateParts(entry.date);
        const dateStr = entry.date;
        const result = await upsertBalance(entry.accountId, year, month, amt, dateStr, { forceReplaceOlder: true });
        if (result && result.skipped) {
          showAlert(`Balance not updated — a newer entry from ${result.existingDate} already exists for this month.`);
          return;
        }
        showBalanceModal.value = false;
        await fetchData();
      } catch (err) {
        console.error('Failed to save balance:', err);
        showAlert('Failed to save. Please try again.');
      }
    }

    // ── Bulk update mode ─────────────────────────────────────────────────────

    function enterUpdateMode() {
      updateMode.value = true;
      updateDate.value = todayStr();
      const balances = {};
      for (const acc of activeAccounts.value) {
        const lastBal = getCurrentBalance(acc.id);
        balances[acc.id] = lastBal != null ? amountToInput(lastBal) : '';
      }
      updateBalances.value = balances;
    }

    async function saveBalanceUpdates() {
      try {
        const { year, month } = parseDateParts(updateDate.value);
        const dateStr = updateDate.value;
        const skipped = [];
        for (const acc of activeAccounts.value) {
          const val = updateBalances.value[acc.id];
          if (val === '' || val === undefined) continue;
          const amt = parseAmount(val);
          if (isNaN(amt)) continue;
          const result = await upsertBalance(acc.id, year, month, amt, dateStr, { forceReplaceOlder: true });
          if (result && result.skipped) skipped.push(acc.name);
        }
        updateMode.value = false;
        await fetchData();
        if (skipped.length) {
          showAlert(`${skipped.join(', ')}: balance not updated — a newer entry already exists for this month.`);
        }
      } catch (err) {
        console.error('Failed to save balances:', err);
        showAlert('Failed to save. Please try again.');
      }
    }

    // ── Shared upsert helper ─────────────────────────────────────────────────

    async function upsertBalance(accountId, year, month, amount, dateStr, opts) {
      return await SheetsApi.upsertBalanceRow(getSheetId(), accountId, year, month, amount, dateStr, opts);
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
        if (cur != null) currentTotal += cur;

        const prevEntries = balanceHistory.value
          .filter(h => h.accountId === acc.id && h.year === prevY && h.month === prevM)
          .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        if (prevEntries.length > 0) {
          prevTotal += prevEntries[0].balance;
        }
      }
      return currentTotal - prevTotal;
    });

    const prevMonthForHistory = computed(() => {
      const now = new Date();
      const m = now.getMonth();
      const y = now.getFullYear();
      return m === 0 ? { year: y - 1, month: 12 } : { year: y, month: m };
    });

    const investmentAccountsNeedingPrevMonth = computed(() => {
      const pm = prevMonthForHistory.value;
      return activeAccounts.value.filter(a => {
        if (!isInvestmentAccountType(a.type)) return false;
        if (!hasHoldingsRows(a.id)) return false;
        const hasRow = balanceHistory.value.some(
          h => h.accountId === a.id && h.year === pm.year && h.month === pm.month
        );
        return !hasRow;
      });
    });

    watch(
      () => ({ intent: props.accountsEntryIntent, ld: loading.value }),
      async ({ intent, ld }) => {
        if (!intent || ld) return;
        if (intent !== 'investment-month-end') return;
        await nextTick();
        try {
          const targets = investmentAccountsNeedingPrevMonth.value;
          if (targets.length === 0) {
            showAlert('No investment accounts with saved holdings are missing last month’s balance history.');
            return;
          }
          const acc = targets[0];
          await startEdit(acc);
          sheetSwipeStep.value = true;
          await openBalanceUpdate(acc, { dateStr: prevMonthLastDayISO(), useSheetTotal: true });
        } finally {
          emit('accounts-intent-consumed');
        }
      }
    );

    watch(() => getSheetId(), (id) => { if (id) fetchData(); }, { immediate: true });

    const addNameInput = ref(null);
    const balanceAmountInput = ref(null);
    watch(showBalanceModal, (v) => {
      if (v) nextTick(() => { balanceAmountInput.value?.focus(); });
    });
    watch(showAddModal, (v) => {
      if (!v) {
        currencyDropdownOpen.value = false;
        currencySearch.value = '';
        openDropdown.value = null;
      } else {
        newAccount.value.currency = baseCurrency.value;
        nextTick(() => { addNameInput.value?.focus(); });
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

    // ── Reorder accounts ───────────────────────────────────────────────────
    const reorderMode = ref(false);

    async function moveAccountUp(acc) {
      const list = activeAccounts.value;
      const idx = list.findIndex(a => a.id === acc.id);
      if (idx <= 0) return;
      try {
        const other = list[idx - 1];
        const tmpOrder = acc.order;
        acc.order = other.order;
        other.order = tmpOrder;
        await Promise.all([
          SheetsApi.updateRow(getSheetId(), TABS.ACCOUNTS, acc.id, [
            acc.id, acc.name, acc.currency, acc.type, acc.discontinued, acc.order,
          ]),
          SheetsApi.updateRow(getSheetId(), TABS.ACCOUNTS, other.id, [
            other.id, other.name, other.currency, other.type, other.discontinued, other.order,
          ]),
        ]);
        await fetchData();
      } catch (err) {
        console.error('Failed to reorder account:', err);
      }
    }

    async function moveAccountDown(acc) {
      const list = activeAccounts.value;
      const idx = list.findIndex(a => a.id === acc.id);
      if (idx < 0 || idx >= list.length - 1) return;
      try {
        const other = list[idx + 1];
        const tmpOrder = acc.order;
        acc.order = other.order;
        other.order = tmpOrder;
        await Promise.all([
          SheetsApi.updateRow(getSheetId(), TABS.ACCOUNTS, acc.id, [
            acc.id, acc.name, acc.currency, acc.type, acc.discontinued, acc.order,
          ]),
          SheetsApi.updateRow(getSheetId(), TABS.ACCOUNTS, other.id, [
            other.id, other.name, other.currency, other.type, other.discontinued, other.order,
          ]),
        ]);
        await fetchData();
      } catch (err) {
        console.error('Failed to reorder account:', err);
      }
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

    async function disableTool() {
      try {
        const current = (props.settings?.listsEnabled || '').split(',').filter(Boolean);
        const updated = current.filter(t => t !== 'accounts').join(',');
        await SheetsApi.updateSetting(getSheetId(), 'listsEnabled', updated);
        emit('settings-updated', { listsEnabled: updated });
        emit('go-home');
      } catch (err) {
        console.error('Failed to disable tool:', err);
        showAlert('Failed to save. Please try again.');
      }
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
      formatCurrency, sanitizeAmount, getCurrentBalance, getLastUpdateDate, formatUpdateDate,
      getAccountDiff,
      addAccount, startEdit, saveEdit, persistEditToSheet, deleteAccount,
      showHistory, openBalanceUpdate, saveBalance, editHistoryEntry,
      enterUpdateMode, saveBalanceUpdates, monthName,
      reorderMode, moveAccountUp, moveAccountDown, addNameInput, balanceAmountInput,
      disableTool,
      balFx,
      editHoldingsLines, addHoldingRow, removeHoldingRow, saveHoldings, savingHoldings, loadingHoldingsEdit,
      isInvestmentAccountType, hasHoldingsRows, fillBalanceFromSheetTotal, sheetTotalLoading,
      investmentAccountsNeedingPrevMonth, prevMonthForHistory,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <!-- Nav row (matches original: ← ... Accounts ... orb) -->
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Accounts</h1>
        <div class="valu-orb-sm subpage-orb-inline" @click="$emit('navigate', 'assistant')">
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
          <h2 class="subpage-balance">{{ formatCurrency(totalNetWorth, baseCurrency) }}</h2>
          <div class="subpage-diff" :class="previousMonthDiff >= 0 ? 'diff-positive' : 'diff-negative'">
            <span class="material-icons subpage-diff-arrow">{{ previousMonthDiff >= 0 ? 'trending_up' : 'trending_down' }}</span>
            <span class="subpage-diff-value">{{ formatCurrency(Math.abs(previousMonthDiff), baseCurrency) }}</span>
            <button class="subpage-diff-btn" @click="showInfoPopover = !showInfoPopover">
              <span class="material-icons subpage-diff-icon">info_outline</span>
            </button>
          </div>
        </div>

        <!-- Reorder toggle -->
        <div v-if="activeAccounts.length > 1" class="accounts-reorder-toggle">
          <button class="btn-text-sm" @click="reorderMode = !reorderMode">
            <span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">swap_vert</span>{{ reorderMode ? 'Done' : 'Reorder' }}
          </button>
        </div>

        <!-- Account list (card rows matching original) -->
        <div class="valu-list">
          <div v-for="(acc, idx) in activeAccounts" :key="acc.id"
               class="valu-list-card"
               @click="reorderMode ? null : startEdit(acc)">
            <div class="valu-list-row">
              <div v-if="reorderMode" class="account-reorder-arrows">
                <button class="account-reorder-btn" :disabled="idx === 0" @click.stop="moveAccountUp(acc)">
                  <span class="material-icons">arrow_upward</span>
                </button>
                <button class="account-reorder-btn" :disabled="idx === activeAccounts.length - 1" @click.stop="moveAccountDown(acc)">
                  <span class="material-icons">arrow_downward</span>
                </button>
              </div>
              <div class="valu-list-name">{{ formatAccountDisplayName(acc) }}</div>
              <div class="valu-list-after">{{ formatCurrency(getCurrentBalance(acc.id), baseCurrency) }}</div>
            </div>
            <div v-if="!reorderMode" class="valu-list-row valu-list-row-sub">
              <div class="valu-list-sub">
                <span v-if="getLastUpdateDate(acc.id)">Updated {{ formatUpdateDate(getLastUpdateDate(acc.id)) }}</span>
                <span v-else>No updates yet</span>
              </div>
              <div class="valu-list-diff" v-if="getAccountDiff(acc.id) !== null"
                   :class="getAccountDiff(acc.id) >= 0 ? 'diff-positive' : 'diff-negative'">
                {{ getAccountDiff(acc.id) >= 0 ? '+ ' : '- ' }}{{ formatCurrency(Math.abs(getAccountDiff(acc.id)), baseCurrency) }}
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
                <div class="valu-list-after">{{ formatCurrency(getCurrentBalance(acc.id), baseCurrency) }}</div>
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
        <div v-if="accounts.length === 0" class="empty-state" style="padding-top:40px;text-align:center;">
          <span class="material-icons">account_balance</span>
          <h3>No accounts yet</h3>
          <p>Add your bank accounts, savings, or investment accounts.</p>
          <div class="empty-state-disable">
            <p>Not ready to use this tool?</p>
            <button class="btn-disable-tool" @click="disableTool">Disable Accounts for now</button>
            <p class="empty-state-hint">You can re-enable it anytime from your Group configuration.</p>
          </div>
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
            <input ref="addNameInput" class="sheet-hero-name-solo" v-model="newAccount.name" placeholder="Account name" />
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
                       @change="persistEditToSheet()" />
                <span class="material-icons sheet-hero-edit-icon">edit</span>
              </div>
              <div class="sheet-hero-amount-display" style="cursor:pointer;" @click="openBalanceUpdate(editingAccount)">{{ formatCurrency(getCurrentBalance(editingAccount.id), baseCurrency) }}</div>
              <p v-if="isInvestmentAccountType(editingAccount.type) && hasHoldingsRows(editingAccount.id)" class="sheet-holdings-live-hint">Balance above is from history. Open <strong>Store new balance</strong> to pull the latest total from your Sheet (GOOGLEFINANCE).</p>
              <div class="sheet-hero-label">Balance</div>
            </div>

            <!-- Balance history (scrollable) -->
            <div class="sheet-history-list" v-if="accountHistory.length > 0">
              <div v-for="h in accountHistory" :key="h.year + '-' + h.month"
                   class="sheet-history-item" @click="editHistoryEntry(h)">
                <span class="sheet-history-date">{{ monthName(h.month) }} {{ h.year }}</span>
                <span class="sheet-history-amount">
                  {{ formatCurrency(h.balance, baseCurrency) }}
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

            <template v-if="isInvestmentAccountType(editingAccount.type)">
              <div class="sheet-section-title sheet-holdings-section-title">Stock &amp; ETF holdings</div>
              <p class="sheet-holdings-hint">Enter tickers as used in Google Sheets <code>GOOGLEFINANCE</code> (e.g. <code>NASDAQ:AAPL</code>, <code>TSE:VFV</code>). Market column is calculated in your Sheet — open the spreadsheet to refresh quotes.</p>
              <div v-if="loadingHoldingsEdit" class="sheet-holdings-loading">Loading holdings…</div>
              <template v-else>
                <div v-for="(line, hi) in editHoldingsLines" :key="'h'+hi" class="sheet-holdings-row">
                  <input v-model="line.symbol" class="form-input sheet-holdings-symbol" type="text" placeholder="Ticker (e.g. TSE:VFV)" autocomplete="off" />
                  <input v-model="line.shares" class="form-input sheet-holdings-shares" type="text" inputmode="decimal" placeholder="Shares" autocomplete="off" />
                  <button type="button" class="btn-icon sheet-holdings-remove" @click="removeHoldingRow(hi)" aria-label="Remove row">
                    <span class="material-icons">close</span>
                  </button>
                </div>
                <div class="sheet-holdings-actions">
                  <button type="button" class="btn btn-text btn-sm" @click="addHoldingRow">
                    <span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">add</span>Add line
                  </button>
                  <button type="button" class="btn btn-primary btn-sm" :disabled="savingHoldings" @click="saveHoldings">{{ savingHoldings ? 'Saving…' : 'Save holdings' }}</button>
                </div>
              </template>
            </template>

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
              <button class="btn btn-text btn-danger" @click="deleteAccount(editingAccount.id)">Delete account</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Record Balance Sheet (higher z-index, for editing a specific history entry) -->
      <div class="modal-overlay modal-overlay-top" :class="{ open: showBalanceModal }" @click.self="showBalanceModal = false">
        <div class="modal" v-if="showBalanceModal">
          <div class="sheet-handle"></div>
          <div class="modal-body" style="padding-top:8px; text-align:center;">
            <input ref="balanceAmountInput" class="sheet-hero-amount-input" type="text" inputmode="decimal" v-model="balanceEntry.amount" @input="sanitizeAmount(balanceEntry, 'amount')" placeholder="0" :readonly="balFx.fxActive.value" :class="{ 'fx-readonly': balFx.fxActive.value }" />
            <div class="sheet-hero-label">Balance <span v-if="balFx.fxActive.value" class="fx-base-tag">in {{ baseCurrency }}</span></div>
          </div>
          <div v-if="balFx.needsFx.value" class="fx-convert-section" style="padding:0 24px;">
            <button class="fx-toggle-btn" @click="balFx.toggle()">
              <span class="material-icons fx-toggle-icon">currency_exchange</span>
              {{ balFx.fxActive.value ? 'Cancel conversion' : 'Convert from ' + balFx.fxCurrency.value }}
            </button>
            <div v-if="balFx.fxActive.value" class="fx-convert-body">
              <div class="fx-input-row">
                <input class="fx-foreign-input" type="text" inputmode="decimal" v-model="balFx.fxForeignAmount.value" @input="balFx.updateConverted()" :placeholder="'Balance in ' + balFx.fxCurrency.value" />
                <span class="fx-currency-label">{{ balFx.fxCurrency.value }}</span>
              </div>
              <div v-if="balFx.fxLoading.value" class="fx-rate-info">Fetching rate...</div>
              <div v-else-if="balFx.fxError.value" class="fx-rate-info fx-rate-error">{{ balFx.fxError.value }} — enter balance in {{ baseCurrency }} directly.</div>
              <div v-else-if="balFx.fxRate.value" class="fx-rate-info">1 {{ balFx.fxCurrency.value }} = {{ balFx.fxRate.value.toFixed(4) }} {{ baseCurrency }} <span class="fx-rate-date">({{ balFx.fxRateDate.value }})</span></div>
            </div>
          </div>
          <div class="modal-body">
            <div class="sheet-list-item">
              <label>Date</label>
              <valu-date-field v-model="balanceEntry.date" />
            </div>
            <div v-if="getAccountById(balanceEntry.accountId) && isInvestmentAccountType(getAccountById(balanceEntry.accountId).type) && hasHoldingsRows(balanceEntry.accountId)" class="sheet-holdings-balance-tools">
              <button type="button" class="btn btn-text btn-sm" :disabled="sheetTotalLoading" @click="fillBalanceFromSheetTotal(balanceEntry.accountId)">
                <span class="material-icons" style="font-size:16px;vertical-align:middle;margin-right:4px;">cloud_download</span>
                {{ sheetTotalLoading ? 'Reading sheet…' : 'Use total from Holdings sheet' }}
              </button>
              <p class="sheet-holdings-balance-note">Uses <strong>GOOGLEFINANCE</strong> <em>close</em> for the <strong>date above</strong> (via a temporary cell in your Sheet, then cleared). If that total matches the <strong>live quote</strong> (weekends, holidays, or bad dates often do), the app tries <strong>one calendar day earlier</strong> repeatedly until it finds a different total, then sets the date to that day. <strong>Today</strong> is never shifted that way—matching live is normal for the current day.</p>
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
