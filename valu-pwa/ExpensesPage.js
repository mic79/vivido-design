import SheetsApi, { TABS, formatAccountDisplayName, localDateISO, CATEGORY_ICONS, CURRENCIES } from './sheetsApi.js';

const { ref, computed, watch, inject, nextTick } = Vue;

const LS_LAST_ACCOUNT_EXPENSE = 'valu_last_account_expense';

export default {
  props: ['sheetId', 'settings', 'accounts'],
  emits: ['refresh', 'go-home', 'settings-updated'],

  setup(props, { emit }) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    const showAlert = inject('showAlert', m => window.alert(m));
    const showConfirm = inject('showConfirm', m => Promise.resolve(window.confirm(m)));
    function getSheetId() { return props.sheetId || injectedSheetId.value; }
    const expenses = ref([]);
    const loading = ref(true);
    const showAddModal = ref(false);
    const showEditModal = ref(false);
    const editingExpense = ref(null);
    const filterMonth = ref(getCurrentMonthKey());
    const filterCategory = ref('');
    const filterSearch = ref('');
    const showUpcoming = ref(true);
    const showMonthSheet = ref(false);
    const openDropdown = ref(null);

    function getCurrentMonthKey() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }

    function formatMonthLabel(key) {
      if (!key) return 'All months';
      const [y, m] = key.split('-').map(Number);
      return new Date(y, m - 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }

    const newExpense = ref({
      title: '', amount: '', accountId: '', category: '', date: '', notes: '',
    });
    const adjustBalance = ref(false);
    const editAdjustBalance = ref(false);
    const editOriginal = ref(null);

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');

    const categoriesEnabled = computed(() => props.settings?.expenseCategoriesEnabled !== 'false');

    const categories = computed(() => {
      if (!categoriesEnabled.value) return [];
      const str = props.settings?.expenseCategories || '';
      return str.split(',').filter(Boolean).map(c => {
        const idx = c.indexOf(':');
        if (idx < 0) return { name: c, icon: '' };
        return { name: c.slice(0, idx), icon: c.slice(idx + 1) };
      });
    });

    const allCategoryIcons = computed(() => {
      const str = props.settings?.expenseCategories || '';
      const map = {};
      str.split(',').filter(Boolean).forEach(c => {
        const idx = c.indexOf(':');
        if (idx > 0) map[c.slice(0, idx)] = c.slice(idx + 1);
      });
      return map;
    });

    function getCategoryIcon(categoryName) {
      return allCategoryIcons.value[categoryName] || '';
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

    function getAccountCurrency(accountId) {
      const acc = (props.accounts || []).find(a => a.id === accountId);
      return acc ? (acc.currency || baseCurrency.value) : baseCurrency.value;
    }

    function getAccountName(accountId) {
      const acc = (props.accounts || []).find(a => a.id === accountId);
      return acc ? formatAccountDisplayName(acc) : '';
    }

    function convertToBase(amount, fromCurrency) {
      if (!fromCurrency || fromCurrency === baseCurrency.value) return amount;
      const rate = currencyRates.value[fromCurrency];
      return rate ? amount * rate : amount;
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

    const availableMonths = computed(() => {
      const months = new Set();
      for (const e of expenses.value) {
        if (e.date) {
          const parts = e.date.split('-');
          months.add(`${parts[0]}-${parts[1]}`);
        }
      }
      return [...months].sort().reverse();
    });

    const filteredExpenses = computed(() => {
      let list = [...expenses.value].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      if (filterMonth.value) {
        list = list.filter(e => {
          if (!e.date) return false;
          const parts = e.date.split('-');
          return `${parts[0]}-${parts[1]}` === filterMonth.value;
        });
      }

      if (filterCategory.value) {
        list = list.filter(e => e.category === filterCategory.value);
      }

      if (filterSearch.value) {
        const q = filterSearch.value.toLowerCase();
        list = list.filter(e =>
          (e.title && e.title.toLowerCase().includes(q)) ||
          (e.notes && e.notes.toLowerCase().includes(q)) ||
          (e.category && e.category.toLowerCase().includes(q)) ||
          (getAccountName(e.accountId).toLowerCase().includes(q))
        );
      }

      if (!showUpcoming.value) {
        list = list.filter(e => !isFutureDate(e.date));
      }

      return list;
    });

    const hasFutureEntries = computed(() =>
      expenses.value.some(e => isFutureDate(e.date))
    );

    const monthlyTotal = computed(() => {
      return filteredExpenses.value.reduce((sum, e) => {
        const cur = getAccountCurrency(e.accountId);
        return sum + convertToBase(e.amount, cur);
      }, 0);
    });

    const monthTotals = computed(() => {
      const map = {};
      for (const e of expenses.value) {
        if (!e.date) continue;
        const parts = e.date.split('-');
        const key = `${parts[0]}-${parts[1]}`;
        const cur = getAccountCurrency(e.accountId);
        map[key] = (map[key] || 0) + convertToBase(e.amount, cur);
      }
      return map;
    });

    const usedCategories = computed(() => {
      const set = new Set();
      const src = filterMonth.value
        ? expenses.value.filter(e => {
            if (!e.date) return false;
            const parts = e.date.split('-');
            return `${parts[0]}-${parts[1]}` === filterMonth.value;
          })
        : expenses.value;
      for (const e of src) {
        if (e.category) set.add(e.category);
      }
      const allCats = (props.settings?.expenseCategories || '').split(',').filter(Boolean).map(c => {
        const idx = c.indexOf(':');
        return idx < 0 ? c : c.slice(0, idx);
      });
      const ordered = allCats.filter(name => set.has(name));
      for (const name of set) {
        if (!ordered.includes(name)) ordered.push(name);
      }
      return ordered;
    });

    async function fetchData() {
      loading.value = true;
      try {
        const rows = await SheetsApi.getTabData(getSheetId(), TABS.EXPENSES);
        expenses.value = rows.map(r => ({
          id: r[0], title: r[1], amount: parseFloat(r[2]) || 0,
          accountId: r[3], category: r[4], date: r[5],
          notes: r[6], createdAt: r[7], balanceAdjusted: r[8] || '',
        }));
      } catch (err) {
        console.error('Failed to load expenses:', err);
      } finally {
        loading.value = false;
      }
    }

    function activeAccountsList() {
      return (props.accounts || [])
        .filter((a) => a.discontinued !== 'true')
        .slice()
        .sort((a, b) => (parseInt(a.order) || 0) - (parseInt(b.order) || 0));
    }

    const sortedAccounts = computed(() => activeAccountsList());

    function defaultAccountIdForNewExpense() {
      const list = activeAccountsList();
      if (list.length === 1) return list[0].id;
      try {
        const last = localStorage.getItem(LS_LAST_ACCOUNT_EXPENSE);
        if (last && list.some((a) => a.id === last)) return last;
      } catch (_) { /* private mode */ }
      return '';
    }

    function resetNewExpenseForm() {
      newExpense.value = {
        title: '',
        amount: '',
        accountId: defaultAccountIdForNewExpense(),
        category: '',
        date: localDateISO(),
        notes: '',
      };
    }

    function openNewExpenseModal() {
      resetNewExpenseForm();
      adjustBalance.value = false;
      showAddModal.value = true;
    }

    async function addExpense() {
      const e = newExpense.value;
      if (!e.title.trim() || e.amount === '' || e.amount === undefined) return;
      const amt = parseAmount(e.amount);
      if (isNaN(amt)) return;
      try {
        const id = SheetsApi.generateId();
        const now = new Date().toISOString();
        const date = e.date || localDateISO();
        const shouldAdjust = adjustBalance.value && e.accountId;
        await SheetsApi.appendRow(getSheetId(), TABS.EXPENSES, [
          id, e.title.trim(), amt.toString(), e.accountId,
          e.category, date, e.notes, now, shouldAdjust ? 'yes' : '',
        ]);
        if (shouldAdjust) {
          const [y, m] = date.split('-').map(Number);
          const cur = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, y, m, cur - amt, date);
        }
        if (e.accountId) {
          try { localStorage.setItem(LS_LAST_ACCOUNT_EXPENSE, e.accountId); } catch (_) {}
        }
        showAddModal.value = false;
        resetNewExpenseForm();
        await fetchData();
      } catch (err) {
        console.error('Failed to add expense:', err);
        showAlert('Failed to save. Please try again.');
      }
    }

    function startEdit(expense) {
      editOriginal.value = {
        amount: expense.amount,
        accountId: expense.accountId || '',
        balanceAdjusted: expense.balanceAdjusted || '',
        date: expense.date || '',
      };
      editingExpense.value = { ...expense, amount: amountToInput(expense.amount) };
      editAdjustBalance.value = expense.balanceAdjusted === 'yes';
      showEditModal.value = true;
    }

    async function saveEdit() {
      const e = editingExpense.value;
      const orig = editOriginal.value;
      if (!e || !orig) return;
      const amt = parseAmount(e.amount);
      if (isNaN(amt)) return;
      try {
        const shouldAdjust = editAdjustBalance.value && e.accountId;
        const date = e.date || localDateISO();
        await SheetsApi.updateRow(getSheetId(), TABS.EXPENSES, e.id, [
          e.id, e.title, amt.toString(), e.accountId,
          e.category, date, e.notes, e.createdAt, shouldAdjust ? 'yes' : '',
        ]);
        if (shouldAdjust) {
          const [newY, newM] = date.split('-').map(Number);
          const newAmt = amt;
          const accountChanged = e.accountId !== orig.accountId;
          const origDate = orig.date || date;
          const [origY, origM] = origDate.split('-').map(Number);
          if (accountChanged && orig.balanceAdjusted === 'yes' && orig.accountId) {
            const oldBal = await SheetsApi.getCurrentBalance(getSheetId(), orig.accountId);
            await SheetsApi.upsertBalanceRow(getSheetId(), orig.accountId, origY, origM, oldBal + orig.amount, origDate);
            const newBal = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
            await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, newY, newM, newBal - newAmt, date);
          } else if (orig.balanceAdjusted === 'yes') {
            const delta = newAmt - orig.amount;
            const cur = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
            await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, origY, origM, cur + orig.amount, origDate);
            const cur2 = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
            await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, newY, newM, cur2 - newAmt, date);
          } else {
            const cur = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
            await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, newY, newM, cur - newAmt, date);
          }
        } else if (!shouldAdjust && orig.balanceAdjusted === 'yes' && orig.accountId) {
          const origDate = orig.date || date;
          const [origY, origM] = origDate.split('-').map(Number);
          const cur = await SheetsApi.getCurrentBalance(getSheetId(), orig.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), orig.accountId, origY, origM, cur + orig.amount, origDate);
        }
        showEditModal.value = false;
        editingExpense.value = null;
        editOriginal.value = null;
        await fetchData();
      } catch (err) {
        console.error('Failed to save expense:', err);
        showAlert('Failed to save. Please try again.');
      }
    }

    function duplicateExpense() {
      const e = editingExpense.value;
      if (!e) return;
      newExpense.value = {
        title: e.title,
        amount: amountToInput(parseAmount(e.amount)),
        accountId: e.accountId || '',
        category: e.category || '',
        date: localDateISO(),
        notes: e.notes || '',
      };
      showEditModal.value = false;
      editingExpense.value = null;
      showAddModal.value = true;
    }

    async function deleteExpense(id) {
      if (!(await showConfirm('Delete this expense?'))) return;
      try {
        const orig = editOriginal.value;
        if (orig && orig.balanceAdjusted === 'yes' && orig.accountId && orig.date) {
          const [y, m] = orig.date.split('-').map(Number);
          const cur = await SheetsApi.getCurrentBalance(getSheetId(), orig.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), orig.accountId, y, m, cur + orig.amount, orig.date);
        }
        await SheetsApi.deleteRows(getSheetId(), TABS.EXPENSES, [id]);
        showEditModal.value = false;
        editingExpense.value = null;
        await fetchData();
      } catch (err) {
        console.error('Failed to delete expense:', err);
        showAlert('Failed to delete. Please try again.');
      }
    }

    function isFutureDate(dateStr) {
      if (!dateStr) return false;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const [y, m, d] = dateStr.split('-').map(Number);
      return new Date(y, m - 1, d) > today;
    }

    function formatDate(dateStr) {
      if (!dateStr) return '';
      const [y, m, d] = dateStr.split('-').map(Number);
      const opts = { month: 'short', day: 'numeric' };
      if (!filterMonth.value && y !== new Date().getFullYear()) opts.year = 'numeric';
      return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
    }

    watch(() => getSheetId(), (id) => { if (id) fetchData(); }, { immediate: true });

    const addNameInput = ref(null);
    watch(showAddModal, (v) => {
      if (v) {
        nextTick(() => { addNameInput.value?.focus(); });
      } else if (openDropdown.value === 'newCat' || openDropdown.value === 'newAcct') {
        openDropdown.value = null;
      }
    });
    watch(showEditModal, (v) => {
      if (!v && (openDropdown.value === 'editCat' || openDropdown.value === 'editAcct')) {
        openDropdown.value = null;
      }
    });

    function toggleDropdown(name) {
      openDropdown.value = openDropdown.value === name ? null : name;
    }

    function setDropdownOpen(id, isOpen) {
      if (isOpen) openDropdown.value = id;
      else if (openDropdown.value === id) openDropdown.value = null;
    }

    // ── Category Manager ──────────────────────────────────────────────────
    const showCategoryManager = ref(false);
    const managedCategories = ref([]);
    const newManagedCat = ref('');
    const editingCatName = ref(null);
    const editCatNameValue = ref('');
    const catIconPickerFor = ref(null);

    function serializeCats(arr) {
      return arr.map(c => c.icon ? c.name + ':' + c.icon : c.name).join(',');
    }

    function openCategoryManager() {
      openDropdown.value = null;
      const str = props.settings?.expenseCategories || '';
      managedCategories.value = str.split(',').filter(Boolean).map(c => {
        const idx = c.indexOf(':');
        if (idx < 0) return { name: c, icon: '' };
        return { name: c.slice(0, idx), icon: c.slice(idx + 1) };
      });
      showCategoryManager.value = true;
    }

    async function saveManagedCategories() {
      try {
        const serialized = serializeCats(managedCategories.value);
        await SheetsApi.updateSetting(getSheetId(), 'expenseCategories', serialized);
        emit('settings-updated', { expenseCategories: serialized });
      } catch (err) {
        console.error('Failed to save categories:', err);
        showAlert('Failed to save categories. Please try again.');
      }
    }

    function addManagedCat() {
      const name = newManagedCat.value.trim();
      if (!name || managedCategories.value.some(c => c.name === name)) return;
      managedCategories.value.push({ name, icon: '' });
      newManagedCat.value = '';
      saveManagedCategories();
    }
    async function removeManagedCat(i) {
      const name = managedCategories.value[i]?.name || 'this category';
      if (!(await showConfirm('Delete "' + name + '"? This will not remove the category from existing entries.'))) return;
      managedCategories.value.splice(i, 1);
      saveManagedCategories();
    }
    function startRenameManagedCat(i) {
      editingCatName.value = i;
      editCatNameValue.value = managedCategories.value[i].name;
    }
    function saveRenameManagedCat() {
      if (editingCatName.value === null) return;
      const val = editCatNameValue.value.trim();
      if (val) managedCategories.value[editingCatName.value].name = val;
      editingCatName.value = null;
      saveManagedCategories();
    }
    function cancelRenameManagedCat() { editingCatName.value = null; }
    function moveManagedCatUp(i) {
      if (i <= 0) return;
      const arr = managedCategories.value;
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      saveManagedCategories();
    }
    function moveManagedCatDown(i) {
      const arr = managedCategories.value;
      if (i >= arr.length - 1) return;
      [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      saveManagedCategories();
    }
    function openCatIconPicker(i) { catIconPickerFor.value = i; }
    function pickCatIcon(iconName) {
      if (catIconPickerFor.value === null) return;
      managedCategories.value[catIconPickerFor.value].icon = iconName;
      catIconPickerFor.value = null;
      saveManagedCategories();
    }
    function clearCatIcon() {
      if (catIconPickerFor.value === null) return;
      managedCategories.value[catIconPickerFor.value].icon = '';
      catIconPickerFor.value = null;
      saveManagedCategories();
    }

    // ── Account Manager ──────────────────────────────────────────────────
    const showAccountManager = ref(false);
    const newManagedAccount = ref({ name: '', currency: '', type: 'Checking/Debit' });
    const ACCOUNT_TYPES = ['Checking/Debit', 'Saving', 'Credit', 'Investment'];
    const acctCurrencyOpen = ref(false);
    const acctCurrencySearch = ref('');
    const acctFilteredCurrencies = computed(() => {
      const q = acctCurrencySearch.value.toLowerCase();
      if (!q) return CURRENCIES;
      return CURRENCIES.filter(c => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
    });
    function acctCurrencyName(code) {
      const found = CURRENCIES.find(c => c.code === code);
      return found ? found.name : code;
    }
    function selectAcctCurrency(code) {
      newManagedAccount.value.currency = code;
      acctCurrencyOpen.value = false;
      acctCurrencySearch.value = '';
    }

    function openAccountManager() {
      openDropdown.value = null;
      newManagedAccount.value = { name: '', currency: baseCurrency.value, type: 'Checking/Debit' };
      showAccountManager.value = true;
    }

    async function addManagedAccount() {
      const acc = newManagedAccount.value;
      if (!acc.name.trim()) return;
      const id = SheetsApi.generateId();
      const currency = acc.currency || baseCurrency.value;
      const order = (props.accounts || []).length.toString();
      await SheetsApi.appendRow(getSheetId(), TABS.ACCOUNTS, [
        id, acc.name.trim(), currency, acc.type, 'false', order,
      ]);
      newManagedAccount.value = { name: '', currency: baseCurrency.value, type: 'Checking/Debit' };
      emit('refresh');
    }

    async function toggleManagedAccountDiscontinued(acc) {
      const newVal = acc.discontinued === 'true' ? 'false' : 'true';
      await SheetsApi.updateRow(getSheetId(), TABS.ACCOUNTS, acc.id, [
        acc.id, acc.name, acc.currency, acc.type, newVal, acc.order,
      ]);
      emit('refresh');
    }

    async function disableTool() {
      try {
        const current = (props.settings?.listsEnabled || '').split(',').filter(Boolean);
        const updated = current.filter(t => t !== 'expenses').join(',');
        await SheetsApi.updateSetting(getSheetId(), 'listsEnabled', updated);
        emit('settings-updated', { listsEnabled: updated });
        emit('go-home');
      } catch (err) {
        console.error('Failed to disable tool:', err);
        showAlert('Failed to save. Please try again.');
      }
    }

    return {
      expenses, loading, filteredExpenses, monthlyTotal, monthTotals,
      showAddModal, showEditModal, editingExpense,
      newExpense, categories, baseCurrency,
      adjustBalance, editAdjustBalance,
      filterMonth, filterCategory, filterSearch, showUpcoming, hasFutureEntries, availableMonths, usedCategories,
      showMonthSheet, formatMonthLabel,
      openDropdown, toggleDropdown, setDropdownOpen,
      sortedAccounts,
      formatCurrency, getAccountName, getAccountCurrency, getCategoryIcon, formatAccountDisplayName,
      addExpense, startEdit, saveEdit, deleteExpense, duplicateExpense,
      isFutureDate, formatDate, sanitizeAmount, openNewExpenseModal, addNameInput,
      showCategoryManager, managedCategories, newManagedCat, editingCatName, editCatNameValue, catIconPickerFor,
      openCategoryManager, addManagedCat, removeManagedCat,
      startRenameManagedCat, saveRenameManagedCat, cancelRenameManagedCat,
      moveManagedCatUp, moveManagedCatDown, openCatIconPicker, pickCatIcon, clearCatIcon,
      CATEGORY_ICONS,
      showAccountManager, newManagedAccount, ACCOUNT_TYPES,
      acctCurrencyOpen, acctCurrencySearch, acctFilteredCurrencies, acctCurrencyName, selectAcctCurrency,
      openAccountManager, addManagedAccount, toggleManagedAccountDiscontinued,
      disableTool,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <!-- Nav row with centered title -->
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Expenses</h1>
        <div class="valu-orb-sm subpage-orb-inline">
          <div class="spheres">
            <div class="spheres-group">
              <div class="sphere s1"></div>
              <div class="sphere s2"></div>
              <div class="sphere s3"></div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="loading" class="loading" style="padding-top:40px;"><div class="spinner"></div>Loading expenses...</div>

      <template v-else>
        <!-- Month + total header -->
        <div class="subpage-header">
          <button class="subpage-month-btn" @click="showMonthSheet = true">
            <span>{{ formatMonthLabel(filterMonth) }}</span>
            <span class="material-icons subpage-month-arrow">unfold_more</span>
          </button>
          <h2 class="subpage-balance">{{ formatCurrency(monthlyTotal, baseCurrency) }}</h2>
        </div>

        <!-- Category filter -->
        <div class="subpage-filter-bar" v-if="filteredExpenses.length > 0 || filterSearch || filterCategory || hasFutureEntries">
          <div class="subpage-filter-search" :class="{ expanded: filterSearch }">
            <span class="material-icons subpage-filter-search-icon">search</span>
            <input class="subpage-filter-search-input" v-model="filterSearch" placeholder="Search..." />
            <button v-if="filterSearch" class="subpage-filter-search-clear" @click="filterSearch = ''">
              <span class="material-icons">close</span>
            </button>
          </div>
          <div v-if="usedCategories.length > 0" style="position:relative;">
            <button class="subpage-filter-btn" :class="{ active: filterCategory }" @click="toggleDropdown('filterCat')">
              <span class="material-icons" style="font-size:16px;">filter_list</span>
              <span>{{ filterCategory || 'Filter' }}</span>
            </button>
            <div class="subpage-filter-dropdown" v-if="openDropdown === 'filterCat'" @click.stop>
              <div class="subpage-filter-option" :class="{ selected: !filterCategory }"
                   @click="filterCategory = ''; openDropdown = null">All categories</div>
              <div v-for="cat in usedCategories" :key="cat"
                   class="subpage-filter-option" :class="{ selected: filterCategory === cat }"
                   @click="filterCategory = cat; openDropdown = null">
                <span v-if="getCategoryIcon(cat)" class="material-icons dropdown-cat-icon">{{ getCategoryIcon(cat) }}</span>
                {{ cat }}
              </div>
            </div>
          </div>
          <button v-if="hasFutureEntries" class="subpage-filter-btn" :class="{ active: showUpcoming }" @click="showUpcoming = !showUpcoming">
            <span class="material-icons" style="font-size:16px;">event</span>
            <span>Upcoming</span>
          </button>
        </div>

        <!-- Expenses List -->
        <div class="valu-list" v-if="filteredExpenses.length > 0">
          <div v-for="exp in filteredExpenses" :key="exp.id" class="valu-list-item" :style="isFutureDate(exp.date) ? { opacity: 0.5 } : {}" @click="startEdit(exp)">
            <div class="valu-list-row">
              <span v-if="getCategoryIcon(exp.category)" class="material-icons valu-list-cat-icon">{{ getCategoryIcon(exp.category) }}</span>
              <div class="valu-list-body">
                <div class="valu-list-top">
                  <div class="valu-list-name">{{ exp.title }}</div>
                  <div class="valu-list-after">{{ formatCurrency(exp.amount, getAccountCurrency(exp.accountId)) }}</div>
                </div>
                <div class="valu-list-sub">
                  {{ formatDate(exp.date) }}
                  <span v-if="getAccountName(exp.accountId)"> · {{ getAccountName(exp.accountId) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="filteredExpenses.length === 0 && expenses.length > 0" class="empty-state">
          <span class="material-icons">filter_list</span>
          <h3>No expenses for this period</h3>
        </div>

        <div v-if="expenses.length === 0" class="empty-state" style="padding-top:40px;text-align:center;">
          <span class="material-icons">shopping_cart</span>
          <h3>No expenses yet</h3>
          <p>Start tracking your spending by adding your first expense.</p>
          <div class="empty-state-disable">
            <p>Not ready to use this tool?</p>
            <button class="btn-disable-tool" @click="disableTool">Disable Expenses for now</button>
            <p class="empty-state-hint">You can re-enable it anytime from your Group configuration.</p>
          </div>
        </div>

        <div class="subpage-bottom-fixed">
          <button class="btn-add-outline" @click="openNewExpenseModal">ADD EXPENSE</button>
        </div>
      </template>
      </div>

      <!-- Add Expense Sheet -->
      <div class="modal-overlay" :class="{ open: showAddModal }" @click.self="showAddModal = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>New Expense</h2>
            <button class="btn-icon" @click="showAddModal = false"><span class="material-icons">close</span></button>
          </div>
          <div class="sheet-hero">
            <input ref="addNameInput" class="sheet-hero-name" v-model="newExpense.title" placeholder="What did you spend on?" />
            <input class="sheet-hero-amount" v-model="newExpense.amount" @input="sanitizeAmount(newExpense, 'amount')" type="text" inputmode="decimal" placeholder="0" />
            <div class="sheet-hero-label">Amount</div>
          </div>
          <div class="modal-body" @click="openDropdown = null">
            <div class="sheet-section-title">Details</div>
            <div class="sheet-list-item">
              <label>Date</label>
              <valu-date-field v-model="newExpense.date" />
            </div>
            <div class="sheet-list-item">
              <label>Category</label>
              <valu-dropdown :open="openDropdown === 'newCat'" @update:open="(v) => setDropdownOpen('newCat', v)">
                <template #label>
                  <span v-if="getCategoryIcon(newExpense.category)" class="material-icons dropdown-cat-icon">{{ getCategoryIcon(newExpense.category) }}</span>
                  {{ newExpense.category || 'No category' }}
                </template>
                <div class="valu-dropdown-option" :class="{ selected: !newExpense.category }"
                     @click="newExpense.category = ''; openDropdown = null">No category</div>
                <div v-for="c in categories" :key="c.name"
                     class="valu-dropdown-option" :class="{ selected: newExpense.category === c.name }"
                     @click="newExpense.category = c.name; openDropdown = null">
                  <span v-if="c.icon" class="material-icons dropdown-cat-icon">{{ c.icon }}</span>
                  {{ c.name }}
                </div>
                <div class="valu-dropdown-option valu-dropdown-manage" @click="openCategoryManager()">
                  <span class="material-icons dropdown-cat-icon">settings</span> Manage categories
                </div>
              </valu-dropdown>
            </div>
            <div class="sheet-list-item">
              <label>Account</label>
              <valu-dropdown :open="openDropdown === 'newAcct'" @update:open="(v) => setDropdownOpen('newAcct', v)">
                <template #label>{{ newExpense.accountId ? getAccountName(newExpense.accountId) : 'No account' }}</template>
                <div class="valu-dropdown-option" :class="{ selected: !newExpense.accountId }"
                     @click="newExpense.accountId = ''; openDropdown = null">No account</div>
                <div v-for="a in sortedAccounts" :key="a.id"
                     class="valu-dropdown-option" :class="{ selected: newExpense.accountId === a.id }"
                     @click="newExpense.accountId = a.id; openDropdown = null">{{ formatAccountDisplayName(a) }}</div>
                <div class="valu-dropdown-option valu-dropdown-manage" @click="openAccountManager()">
                  <span class="material-icons dropdown-cat-icon">settings</span> Manage accounts
                </div>
              </valu-dropdown>
            </div>
            <div class="form-group" style="margin-top:16px;">
              <label class="form-label">Notes</label>
              <textarea class="form-input" v-model="newExpense.notes" rows="2" placeholder="Optional notes"></textarea>
            </div>
            <label v-if="newExpense.accountId && sortedAccounts.length > 0" class="balance-adjust-check" @click.stop>
              <input type="checkbox" v-model="adjustBalance" />
              <span>Also update {{ getAccountName(newExpense.accountId) }} balance</span>
            </label>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" @click="addExpense" :disabled="!newExpense.title.trim() || newExpense.amount === '' || newExpense.amount === undefined">Add expense</button>
          </div>
        </div>
      </div>

      <!-- Month Selection Sheet -->
      <div class="modal-overlay" :class="{ open: showMonthSheet }" @click.self="showMonthSheet = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Select Month</h2>
            <button class="btn-icon" @click="showMonthSheet = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="padding:0;">
            <div class="month-picker-option" :class="{ selected: !filterMonth }"
                 @click="filterMonth = ''; filterCategory = ''; showMonthSheet = false">
              <span class="month-picker-label">All months</span>
              <span class="month-picker-total">{{ formatCurrency(Object.values(monthTotals).reduce((a,b) => a+b, 0), baseCurrency) }}</span>
            </div>
            <div v-for="m in availableMonths" :key="m"
                 class="month-picker-option" :class="{ selected: filterMonth === m }"
                 @click="filterMonth = m; filterCategory = ''; showMonthSheet = false">
              <span class="month-picker-label">{{ formatMonthLabel(m) }}</span>
              <span class="month-picker-total">{{ formatCurrency(monthTotals[m] || 0, baseCurrency) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Edit Expense Sheet -->
      <div class="modal-overlay" :class="{ open: showEditModal }" @click.self="showEditModal = false">
        <div class="modal" v-if="editingExpense">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Edit Expense</h2>
            <button class="btn-icon" @click="showEditModal = false"><span class="material-icons">close</span></button>
          </div>
          <div class="sheet-hero">
            <input class="sheet-hero-name" v-model="editingExpense.title" placeholder="Title" />
            <input class="sheet-hero-amount" v-model="editingExpense.amount" @input="sanitizeAmount(editingExpense, 'amount')" type="text" inputmode="decimal" placeholder="0" />
            <div class="sheet-hero-label">Amount</div>
          </div>
          <div class="modal-body" @click="openDropdown = null">
            <div class="sheet-section-title">Details</div>
            <div class="sheet-list-item">
              <label>Date</label>
              <valu-date-field v-model="editingExpense.date" />
            </div>
            <div class="sheet-list-item">
              <label>Category</label>
              <valu-dropdown :open="openDropdown === 'editCat'" @update:open="(v) => setDropdownOpen('editCat', v)">
                <template #label>
                  <span v-if="getCategoryIcon(editingExpense.category)" class="material-icons dropdown-cat-icon">{{ getCategoryIcon(editingExpense.category) }}</span>
                  {{ editingExpense.category || 'No category' }}
                </template>
                <div class="valu-dropdown-option" :class="{ selected: !editingExpense.category }"
                     @click="editingExpense.category = ''; openDropdown = null">No category</div>
                <div v-for="c in categories" :key="c.name"
                     class="valu-dropdown-option" :class="{ selected: editingExpense.category === c.name }"
                     @click="editingExpense.category = c.name; openDropdown = null">
                  <span v-if="c.icon" class="material-icons dropdown-cat-icon">{{ c.icon }}</span>
                  {{ c.name }}
                </div>
                <div class="valu-dropdown-option valu-dropdown-manage" @click="openCategoryManager()">
                  <span class="material-icons dropdown-cat-icon">settings</span> Manage categories
                </div>
              </valu-dropdown>
            </div>
            <div class="sheet-list-item">
              <label>Account</label>
              <valu-dropdown :open="openDropdown === 'editAcct'" @update:open="(v) => setDropdownOpen('editAcct', v)">
                <template #label>{{ editingExpense.accountId ? getAccountName(editingExpense.accountId) : 'No account' }}</template>
                <div class="valu-dropdown-option" :class="{ selected: !editingExpense.accountId }"
                     @click="editingExpense.accountId = ''; openDropdown = null">No account</div>
                <div v-for="a in sortedAccounts" :key="a.id"
                     class="valu-dropdown-option" :class="{ selected: editingExpense.accountId === a.id }"
                     @click="editingExpense.accountId = a.id; openDropdown = null">{{ formatAccountDisplayName(a) }}</div>
                <div class="valu-dropdown-option valu-dropdown-manage" @click="openAccountManager()">
                  <span class="material-icons dropdown-cat-icon">settings</span> Manage accounts
                </div>
              </valu-dropdown>
            </div>
            <div class="form-group" style="margin-top:16px;">
              <label class="form-label">Notes</label>
              <textarea class="form-input" v-model="editingExpense.notes" rows="2"></textarea>
            </div>
            <label v-if="editingExpense.accountId && sortedAccounts.length > 0" class="balance-adjust-check" @click.stop>
              <input type="checkbox" v-model="editAdjustBalance" />
              <span>Also update {{ getAccountName(editingExpense.accountId) }} balance</span>
            </label>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" @click="saveEdit">Save changes</button>
            <div class="modal-footer-row">
              <button class="btn btn-text btn-danger" @click="deleteExpense(editingExpense.id)">Delete</button>
              <button class="btn btn-text" @click="duplicateExpense"><span class="material-icons" style="font-size:18px;vertical-align:middle;">content_copy</span> Duplicate</button>
              <button class="btn btn-text" @click="showEditModal = false">Cancel</button>
            </div>
          </div>
        </div>
      </div>
      <!-- Category Manager Sheet -->
      <div class="modal-overlay" :class="{ open: showCategoryManager }" @click.self="showCategoryManager = false">
        <div class="modal" v-if="showCategoryManager">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Expense Categories</h2>
            <button class="btn-icon" @click="showCategoryManager = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="padding:12px;">
            <div class="cat-list" v-if="managedCategories.length">
              <div class="cat-item" v-for="(cat, i) in managedCategories" :key="i">
                <button class="cat-icon-btn" @click="openCatIconPicker(i)">
                  <span class="material-icons">{{ cat.icon || 'label' }}</span>
                </button>
                <template v-if="editingCatName === i">
                  <input class="form-input cat-rename-input" v-model="editCatNameValue" @keyup.enter="saveRenameManagedCat" @keyup.escape="cancelRenameManagedCat" @blur="saveRenameManagedCat" />
                </template>
                <span v-else class="cat-name" @click="startRenameManagedCat(i)">{{ cat.name }}</span>
                <div class="cat-order-btns">
                  <button class="cat-order-btn" @click="moveManagedCatUp(i)" :disabled="i === 0"><span class="material-icons">arrow_upward</span></button>
                  <button class="cat-order-btn" @click="moveManagedCatDown(i)" :disabled="i === managedCategories.length - 1"><span class="material-icons">arrow_downward</span></button>
                </div>
                <button class="cat-remove-btn" @click="removeManagedCat(i)">&times;</button>
              </div>
            </div>
            <p v-else style="font-size:13px;color:var(--color-text-hint);margin-bottom:12px;">No categories yet.</p>
            <div class="flex gap-8" style="margin-top:12px;">
              <input class="form-input flex-1" v-model="newManagedCat" placeholder="New category" @keyup.enter="addManagedCat" />
              <button class="btn btn-outline" @click="addManagedCat" :disabled="!newManagedCat.trim()">Add</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Category Icon Picker -->
      <div class="modal-overlay modal-overlay-top" :class="{ open: catIconPickerFor !== null }" @click.self="catIconPickerFor = null">
        <div class="modal" v-if="catIconPickerFor !== null" style="max-height:60vh;">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Choose Icon</h2>
            <button class="btn-icon" @click="catIconPickerFor = null"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="padding:12px;">
            <div class="icon-picker-grid">
              <button v-for="ic in CATEGORY_ICONS" :key="ic" class="icon-picker-item" @click="pickCatIcon(ic)" :title="ic">
                <span class="material-icons">{{ ic }}</span>
              </button>
            </div>
            <button class="btn btn-text" style="width:100%;margin-top:8px;" @click="clearCatIcon">Remove icon</button>
          </div>
        </div>
      </div>

      <!-- Account Manager Sheet -->
      <div class="modal-overlay" :class="{ open: showAccountManager }" @click.self="showAccountManager = false">
        <div class="modal" v-if="showAccountManager">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Accounts</h2>
            <button class="btn-icon" @click="showAccountManager = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="padding:12px;">
            <div v-if="(accounts || []).length" class="cat-list">
              <div class="cat-item" v-for="acc in sortedAccounts" :key="acc.id">
                <span class="material-icons" style="font-size:20px;color:var(--color-primary);margin-right:8px;">account_balance</span>
                <span class="cat-name" style="cursor:default;">{{ formatAccountDisplayName(acc) }}</span>
              </div>
              <div v-for="acc in (accounts || []).filter(a => a.discontinued === 'true')" :key="acc.id" class="cat-item" style="opacity:0.5;">
                <span class="material-icons" style="font-size:20px;color:var(--color-text-hint);margin-right:8px;">account_balance</span>
                <span class="cat-name" style="cursor:default;text-decoration:line-through;">{{ formatAccountDisplayName(acc) }}</span>
              </div>
            </div>
            <p v-else style="font-size:13px;color:var(--color-text-hint);margin-bottom:12px;">No accounts yet.</p>
            <div style="margin-top:16px;border-top:1px solid var(--color-border);padding-top:12px;">
              <div class="sheet-section-title">Add account</div>
              <input class="form-input" v-model="newManagedAccount.name" placeholder="Account name" style="margin-bottom:8px;" />
              <div class="sheet-list-item" style="margin-bottom:8px;">
                <label>Type</label>
                <valu-dropdown :open="openDropdown === 'acctType'" @update:open="(v) => setDropdownOpen('acctType', v)">
                  <template #label>{{ newManagedAccount.type }}</template>
                  <div v-for="t in ACCOUNT_TYPES" :key="t"
                       class="valu-dropdown-option" :class="{ selected: newManagedAccount.type === t }"
                       @click="newManagedAccount.type = t; openDropdown = null">{{ t }}</div>
                </valu-dropdown>
              </div>
              <div class="sheet-list-item" style="margin-bottom:12px;">
                <label>Currency</label>
                <valu-currency-picker v-model:open="acctCurrencyOpen" v-model:search="acctCurrencySearch">
                  <template #label>{{ newManagedAccount.currency ? acctCurrencyName(newManagedAccount.currency) : 'Select currency' }}</template>
                  <div v-for="c in acctFilteredCurrencies" :key="c.code"
                       class="currency-picker-option" :class="{ selected: c.code === newManagedAccount.currency }"
                       @click="selectAcctCurrency(c.code)">{{ c.name }}</div>
                  <div v-if="acctFilteredCurrencies.length === 0" class="currency-picker-empty">No match</div>
                </valu-currency-picker>
              </div>
              <button class="btn btn-primary" style="width:100%;" @click="addManagedAccount" :disabled="!newManagedAccount.name.trim()">Add account</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
