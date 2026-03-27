import SheetsApi, { TABS, formatAccountDisplayName, localDateISO } from './sheetsApi.js';

const { ref, computed, watch, inject } = Vue;

const LS_LAST_ACCOUNT_INCOME = 'valu_last_account_income';

export default {
  props: ['sheetId', 'settings', 'accounts'],
  emits: ['refresh', 'go-home'],

  setup(props) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    function getSheetId() { return props.sheetId || injectedSheetId.value; }
    const incomeList = ref([]);
    const loading = ref(true);
    const showAddModal = ref(false);
    const showEditModal = ref(false);
    const editingIncome = ref(null);
    const filterMonth = ref(getCurrentMonthKey());
    const filterCategory = ref('');
    const filterSearch = ref('');
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

    const newIncome = ref({
      title: '', amount: '', accountId: '', category: '', date: '', notes: '',
    });
    const adjustBalance = ref(false);
    const editAdjustBalance = ref(false);
    const editOriginal = ref(null);

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');

    const categoriesEnabled = computed(() => props.settings?.incomeCategoriesEnabled !== 'false');

    const categories = computed(() => {
      if (!categoriesEnabled.value) return [];
      const str = props.settings?.incomeCategories || '';
      return str.split(',').filter(Boolean).map(c => {
        const idx = c.indexOf(':');
        if (idx < 0) return { name: c, icon: '' };
        return { name: c.slice(0, idx), icon: c.slice(idx + 1) };
      });
    });

    const allCategoryIcons = computed(() => {
      const str = props.settings?.incomeCategories || '';
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

    const availableMonths = computed(() => {
      const months = new Set();
      for (const e of incomeList.value) {
        if (e.date) {
          const parts = e.date.split('-');
          months.add(`${parts[0]}-${parts[1]}`);
        }
      }
      return [...months].sort().reverse();
    });

    const filteredIncome = computed(() => {
      let list = [...incomeList.value].sort((a, b) => {
        const da = a.date ? new Date(a.date) : new Date(0);
        const db = b.date ? new Date(b.date) : new Date(0);
        return db - da;
      });

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

      return list;
    });

    const monthlyTotal = computed(() => {
      return filteredIncome.value.reduce((sum, e) => {
        const cur = getAccountCurrency(e.accountId);
        return sum + convertToBase(e.amount, cur);
      }, 0);
    });

    const monthTotals = computed(() => {
      const map = {};
      for (const e of incomeList.value) {
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
        ? incomeList.value.filter(e => {
            if (!e.date) return false;
            const parts = e.date.split('-');
            return `${parts[0]}-${parts[1]}` === filterMonth.value;
          })
        : incomeList.value;
      for (const e of src) {
        if (e.category) set.add(e.category);
      }
      const allCats = (props.settings?.incomeCategories || '').split(',').filter(Boolean).map(c => {
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
        const rows = await SheetsApi.getTabData(getSheetId(), TABS.INCOME);
        incomeList.value = rows.map(r => ({
          id: r[0], title: r[1], amount: parseFloat(r[2]) || 0,
          accountId: r[3], category: r[4], date: r[5],
          notes: r[6], createdAt: r[7], balanceAdjusted: r[8] || '',
        }));
      } catch (err) {
        console.error('Failed to load income:', err);
      } finally {
        loading.value = false;
      }
    }

    function activeAccountsList() {
      return (props.accounts || []).filter((a) => a.discontinued !== 'true');
    }

    function defaultAccountIdForNewIncome() {
      const list = activeAccountsList();
      if (list.length === 1) return list[0].id;
      try {
        const last = localStorage.getItem(LS_LAST_ACCOUNT_INCOME);
        if (last && list.some((a) => a.id === last)) return last;
      } catch (_) { /* private mode */ }
      return '';
    }

    function resetNewIncomeForm() {
      newIncome.value = {
        title: '',
        amount: '',
        accountId: defaultAccountIdForNewIncome(),
        category: '',
        date: localDateISO(),
        notes: '',
      };
    }

    function openNewIncomeModal() {
      resetNewIncomeForm();
      adjustBalance.value = false;
      showAddModal.value = true;
    }

    async function addIncome() {
      const e = newIncome.value;
      if (!e.title.trim() || e.amount === '' || e.amount === undefined) return;

      const id = SheetsApi.generateId();
      const now = new Date().toISOString();
      const date = e.date || localDateISO();
      const shouldAdjust = adjustBalance.value && e.accountId;

      await SheetsApi.appendRow(getSheetId(), TABS.INCOME, [
        id, e.title.trim(), e.amount.toString(), e.accountId,
        e.category, date, e.notes, now, shouldAdjust ? 'yes' : '',
      ]);

      if (shouldAdjust) {
        const [y, m] = date.split('-').map(Number);
        const cur = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
        await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, y, m, cur + parseFloat(e.amount), date);
      }

      if (e.accountId) {
        try {
          localStorage.setItem(LS_LAST_ACCOUNT_INCOME, e.accountId);
        } catch (_) { /* private mode */ }
      }

      showAddModal.value = false;
      resetNewIncomeForm();
      await fetchData();
    }

    function startEdit(income) {
      editOriginal.value = {
        amount: income.amount,
        accountId: income.accountId || '',
        balanceAdjusted: income.balanceAdjusted || '',
      };
      editingIncome.value = { ...income, amount: income.amount.toString() };
      editAdjustBalance.value = income.balanceAdjusted === 'yes';
      showEditModal.value = true;
    }

    async function saveEdit() {
      const e = editingIncome.value;
      const orig = editOriginal.value;
      if (!e || !orig) return;

      const shouldAdjust = editAdjustBalance.value && e.accountId;
      const date = e.date || localDateISO();

      await SheetsApi.updateRow(getSheetId(), TABS.INCOME, e.id, [
        e.id, e.title, e.amount.toString(), e.accountId,
        e.category, date, e.notes, e.createdAt, shouldAdjust ? 'yes' : '',
      ]);

      if (shouldAdjust) {
        const [y, m] = date.split('-').map(Number);
        const newAmt = parseFloat(e.amount) || 0;
        const accountChanged = e.accountId !== orig.accountId;

        if (accountChanged && orig.balanceAdjusted === 'yes' && orig.accountId) {
          const oldBal = await SheetsApi.getCurrentBalance(getSheetId(), orig.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), orig.accountId, y, m, oldBal - orig.amount, date);
          const newBal = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, y, m, newBal + newAmt, date);
        } else if (orig.balanceAdjusted === 'yes') {
          const delta = newAmt - orig.amount;
          const cur = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, y, m, cur + delta, date);
        } else {
          const cur = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, y, m, cur + newAmt, date);
        }
      }

      showEditModal.value = false;
      editingIncome.value = null;
      editOriginal.value = null;
      await fetchData();
    }

    function duplicateIncome() {
      const e = editingIncome.value;
      if (!e) return;
      newIncome.value = {
        title: e.title,
        amount: e.amount.toString(),
        accountId: e.accountId || '',
        category: e.category || '',
        date: localDateISO(),
        notes: e.notes || '',
      };
      showEditModal.value = false;
      editingIncome.value = null;
      showAddModal.value = true;
    }

    async function deleteIncome(id) {
      if (!confirm('Delete this income entry?')) return;
      await SheetsApi.deleteRows(getSheetId(), TABS.INCOME, [id]);
      showEditModal.value = false;
      editingIncome.value = null;
      await fetchData();
    }

    function formatDate(dateStr) {
      if (!dateStr) return '';
      const [y, m, d] = dateStr.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric',
      });
    }

    watch(() => getSheetId(), (id) => { if (id) fetchData(); }, { immediate: true });

    watch(showAddModal, (v) => {
      if (!v && (openDropdown.value === 'newCat' || openDropdown.value === 'newAcct')) {
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

    return {
      incomeList, loading, filteredIncome, monthlyTotal, monthTotals,
      showAddModal, showEditModal, editingIncome,
      newIncome, categories, baseCurrency,
      adjustBalance, editAdjustBalance,
      filterMonth, filterCategory, filterSearch, availableMonths, usedCategories,
      showMonthSheet, formatMonthLabel,
      openDropdown, toggleDropdown, setDropdownOpen,
      formatCurrency, getAccountName, getAccountCurrency, getCategoryIcon, formatAccountDisplayName,
      addIncome, startEdit, saveEdit, deleteIncome, duplicateIncome,
      formatDate, openNewIncomeModal,
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
        <h1 class="subpage-nav-title">Income</h1>
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

      <div v-if="loading" class="loading" style="padding-top:40px;"><div class="spinner"></div>Loading income...</div>

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
        <div class="subpage-filter-bar">
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
        </div>

        <!-- Income List -->
        <div class="valu-list" v-if="filteredIncome.length > 0">
          <div v-for="inc in filteredIncome" :key="inc.id" class="valu-list-item" @click="startEdit(inc)">
            <div class="valu-list-row">
              <span v-if="getCategoryIcon(inc.category)" class="material-icons valu-list-cat-icon">{{ getCategoryIcon(inc.category) }}</span>
              <div class="valu-list-body">
                <div class="valu-list-top">
                  <div class="valu-list-name">{{ inc.title }}</div>
                  <div class="valu-list-after">{{ formatCurrency(inc.amount, getAccountCurrency(inc.accountId)) }}</div>
                </div>
                <div class="valu-list-sub">
                  {{ formatDate(inc.date) }}
                  <span v-if="getAccountName(inc.accountId)"> · {{ getAccountName(inc.accountId) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="filteredIncome.length === 0 && incomeList.length > 0" class="empty-state">
          <span class="material-icons">filter_list</span>
          <h3>No income for this period</h3>
        </div>

        <div v-if="incomeList.length === 0" class="empty-state" style="padding-top:40px;">
          <span class="material-icons">payments</span>
          <h3>No income recorded yet</h3>
          <p>Track your earnings by adding income entries.</p>
        </div>

        <div class="subpage-bottom-fixed">
          <button class="btn-add-outline" @click="openNewIncomeModal">ADD INCOME</button>
        </div>
      </template>
      </div>

      <!-- Add Income Sheet -->
      <div class="modal-overlay" :class="{ open: showAddModal }" @click.self="showAddModal = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>New Income</h2>
            <button class="btn-icon" @click="showAddModal = false"><span class="material-icons">close</span></button>
          </div>
          <div class="sheet-hero">
            <input class="sheet-hero-name" v-model="newIncome.title" placeholder="Income source" />
            <input class="sheet-hero-amount" v-model="newIncome.amount" type="number" step="0.01" placeholder="0" />
            <div class="sheet-hero-label">Amount</div>
          </div>
          <div class="modal-body" @click="openDropdown = null">
            <div class="sheet-section-title">Details</div>
            <div class="sheet-list-item">
              <label>Date</label>
              <valu-date-field v-model="newIncome.date" />
            </div>
            <div class="sheet-list-item" v-if="categories.length > 0">
              <label>Category</label>
              <valu-dropdown :open="openDropdown === 'newCat'" @update:open="(v) => setDropdownOpen('newCat', v)">
                <template #label>
                  <span v-if="getCategoryIcon(newIncome.category)" class="material-icons dropdown-cat-icon">{{ getCategoryIcon(newIncome.category) }}</span>
                  {{ newIncome.category || 'No category' }}
                </template>
                <div class="valu-dropdown-option" :class="{ selected: !newIncome.category }"
                     @click="newIncome.category = ''; openDropdown = null">No category</div>
                <div v-for="c in categories" :key="c.name"
                     class="valu-dropdown-option" :class="{ selected: newIncome.category === c.name }"
                     @click="newIncome.category = c.name; openDropdown = null">
                  <span v-if="c.icon" class="material-icons dropdown-cat-icon">{{ c.icon }}</span>
                  {{ c.name }}
                </div>
              </valu-dropdown>
            </div>
            <div class="sheet-list-item" v-if="accounts && accounts.length > 0">
              <label>Account</label>
              <valu-dropdown :open="openDropdown === 'newAcct'" @update:open="(v) => setDropdownOpen('newAcct', v)">
                <template #label>{{ newIncome.accountId ? getAccountName(newIncome.accountId) : 'No account' }}</template>
                <div class="valu-dropdown-option" :class="{ selected: !newIncome.accountId }"
                     @click="newIncome.accountId = ''; openDropdown = null">No account</div>
                <div v-for="a in accounts" :key="a.id"
                     class="valu-dropdown-option" :class="{ selected: newIncome.accountId === a.id }"
                     @click="newIncome.accountId = a.id; openDropdown = null">{{ formatAccountDisplayName(a) }}</div>
              </valu-dropdown>
            </div>
            <div class="form-group" style="margin-top:16px;">
              <label class="form-label">Notes</label>
              <textarea class="form-input" v-model="newIncome.notes" rows="2" placeholder="Optional notes"></textarea>
            </div>
            <label v-if="newIncome.accountId && accounts && accounts.length > 0" class="balance-adjust-check" @click.stop>
              <input type="checkbox" v-model="adjustBalance" />
              <span>Also update {{ getAccountName(newIncome.accountId) }} balance</span>
            </label>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" @click="addIncome" :disabled="!newIncome.title.trim() || newIncome.amount === '' || newIncome.amount === undefined">Add income</button>
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

      <!-- Edit Income Sheet -->
      <div class="modal-overlay" :class="{ open: showEditModal }" @click.self="showEditModal = false">
        <div class="modal" v-if="editingIncome">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Edit Income</h2>
            <button class="btn-icon" @click="showEditModal = false"><span class="material-icons">close</span></button>
          </div>
          <div class="sheet-hero">
            <input class="sheet-hero-name" v-model="editingIncome.title" placeholder="Title" />
            <input class="sheet-hero-amount" v-model="editingIncome.amount" type="number" step="0.01" placeholder="0" />
            <div class="sheet-hero-label">Amount</div>
          </div>
          <div class="modal-body" @click="openDropdown = null">
            <div class="sheet-section-title">Details</div>
            <div class="sheet-list-item">
              <label>Date</label>
              <valu-date-field v-model="editingIncome.date" />
            </div>
            <div class="sheet-list-item" v-if="categories.length > 0">
              <label>Category</label>
              <valu-dropdown :open="openDropdown === 'editCat'" @update:open="(v) => setDropdownOpen('editCat', v)">
                <template #label>
                  <span v-if="getCategoryIcon(editingIncome.category)" class="material-icons dropdown-cat-icon">{{ getCategoryIcon(editingIncome.category) }}</span>
                  {{ editingIncome.category || 'No category' }}
                </template>
                <div class="valu-dropdown-option" :class="{ selected: !editingIncome.category }"
                     @click="editingIncome.category = ''; openDropdown = null">No category</div>
                <div v-for="c in categories" :key="c.name"
                     class="valu-dropdown-option" :class="{ selected: editingIncome.category === c.name }"
                     @click="editingIncome.category = c.name; openDropdown = null">
                  <span v-if="c.icon" class="material-icons dropdown-cat-icon">{{ c.icon }}</span>
                  {{ c.name }}
                </div>
              </valu-dropdown>
            </div>
            <div class="sheet-list-item" v-if="accounts && accounts.length > 0">
              <label>Account</label>
              <valu-dropdown :open="openDropdown === 'editAcct'" @update:open="(v) => setDropdownOpen('editAcct', v)">
                <template #label>{{ editingIncome.accountId ? getAccountName(editingIncome.accountId) : 'No account' }}</template>
                <div class="valu-dropdown-option" :class="{ selected: !editingIncome.accountId }"
                     @click="editingIncome.accountId = ''; openDropdown = null">No account</div>
                <div v-for="a in accounts" :key="a.id"
                     class="valu-dropdown-option" :class="{ selected: editingIncome.accountId === a.id }"
                     @click="editingIncome.accountId = a.id; openDropdown = null">{{ formatAccountDisplayName(a) }}</div>
              </valu-dropdown>
            </div>
            <div class="form-group" style="margin-top:16px;">
              <label class="form-label">Notes</label>
              <textarea class="form-input" v-model="editingIncome.notes" rows="2"></textarea>
            </div>
            <label v-if="editingIncome.accountId && accounts && accounts.length > 0" class="balance-adjust-check" @click.stop>
              <input type="checkbox" v-model="editAdjustBalance" />
              <span>Also update {{ getAccountName(editingIncome.accountId) }} balance</span>
            </label>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" @click="saveEdit">Save changes</button>
            <div class="modal-footer-row">
              <button class="btn btn-text btn-danger" @click="deleteIncome(editingIncome.id)">Delete</button>
              <button class="btn btn-text" @click="duplicateIncome"><span class="material-icons" style="font-size:18px;vertical-align:middle;">content_copy</span> Duplicate</button>
              <button class="btn btn-text" @click="showEditModal = false">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
