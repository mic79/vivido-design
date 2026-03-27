import SheetsApi, { TABS, formatAccountDisplayName, localDateISO } from './sheetsApi.js';

const { ref, computed, watch, inject } = Vue;

const LS_LAST_ACCOUNT_EXPENSE = 'valu_last_account_expense';

export default {
  props: ['sheetId', 'settings', 'accounts'],
  emits: ['refresh', 'go-home'],

  setup(props) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    function getSheetId() { return props.sheetId || injectedSheetId.value; }
    const expenses = ref([]);
    const loading = ref(true);
    const showAddModal = ref(false);
    const showEditModal = ref(false);
    const editingExpense = ref(null);
    const filterMonth = ref('');
    const openDropdown = ref(null);

    const newExpense = ref({
      title: '', amount: '', accountId: '', category: '', date: '', notes: '',
    });
    const adjustBalance = ref(false);
    const editAdjustBalance = ref(false);
    const editOriginal = ref(null);

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');

    const categories = computed(() => {
      const str = props.settings?.expenseCategories || '';
      return str.split(',').filter(Boolean);
    });

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
      for (const e of expenses.value) {
        if (e.date) {
          const parts = e.date.split('-');
          months.add(`${parts[0]}-${parts[1]}`);
        }
      }
      return [...months].sort().reverse();
    });

    const filteredExpenses = computed(() => {
      let list = [...expenses.value].sort((a, b) => {
        const da = a.date ? new Date(a.date) : new Date(0);
        const db = b.date ? new Date(b.date) : new Date(0);
        return db - da;
      });

      if (filterMonth.value) {
        list = list.filter(e => {
          if (!e.date) return false;
          const parts = e.date.split('-');
          const key = `${parts[0]}-${parts[1]}`;
          return key === filterMonth.value;
        });
      }

      return list;
    });

    const monthlyTotal = computed(() => {
      return filteredExpenses.value.reduce((sum, e) => {
        const cur = getAccountCurrency(e.accountId);
        return sum + convertToBase(e.amount, cur);
      }, 0);
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
      return (props.accounts || []).filter((a) => a.discontinued !== 'true');
    }

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

      const id = SheetsApi.generateId();
      const now = new Date().toISOString();
      const date = e.date || localDateISO();
      const shouldAdjust = adjustBalance.value && e.accountId;

      await SheetsApi.appendRow(getSheetId(), TABS.EXPENSES, [
        id, e.title.trim(), e.amount.toString(), e.accountId,
        e.category, date, e.notes, now, shouldAdjust ? 'yes' : '',
      ]);

      if (shouldAdjust) {
        const [y, m] = date.split('-').map(Number);
        const cur = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
        await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, y, m, cur - parseFloat(e.amount), date);
      }

      if (e.accountId) {
        try {
          localStorage.setItem(LS_LAST_ACCOUNT_EXPENSE, e.accountId);
        } catch (_) { /* private mode */ }
      }

      showAddModal.value = false;
      resetNewExpenseForm();
      await fetchData();
    }

    function startEdit(expense) {
      editOriginal.value = {
        amount: expense.amount,
        accountId: expense.accountId || '',
        balanceAdjusted: expense.balanceAdjusted || '',
      };
      editingExpense.value = { ...expense, amount: expense.amount.toString() };
      editAdjustBalance.value = expense.balanceAdjusted === 'yes';
      showEditModal.value = true;
    }

    async function saveEdit() {
      const e = editingExpense.value;
      const orig = editOriginal.value;
      if (!e || !orig) return;

      const shouldAdjust = editAdjustBalance.value && e.accountId;
      const date = e.date || localDateISO();

      await SheetsApi.updateRow(getSheetId(), TABS.EXPENSES, e.id, [
        e.id, e.title, e.amount.toString(), e.accountId,
        e.category, date, e.notes, e.createdAt, shouldAdjust ? 'yes' : '',
      ]);

      if (shouldAdjust) {
        const [y, m] = date.split('-').map(Number);
        const newAmt = parseFloat(e.amount) || 0;
        const accountChanged = e.accountId !== orig.accountId;

        if (accountChanged && orig.balanceAdjusted === 'yes' && orig.accountId) {
          const oldBal = await SheetsApi.getCurrentBalance(getSheetId(), orig.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), orig.accountId, y, m, oldBal + orig.amount, date);
          const newBal = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, y, m, newBal - newAmt, date);
        } else if (orig.balanceAdjusted === 'yes') {
          const delta = newAmt - orig.amount;
          const cur = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, y, m, cur - delta, date);
        } else {
          const cur = await SheetsApi.getCurrentBalance(getSheetId(), e.accountId);
          await SheetsApi.upsertBalanceRow(getSheetId(), e.accountId, y, m, cur - newAmt, date);
        }
      }

      showEditModal.value = false;
      editingExpense.value = null;
      editOriginal.value = null;
      await fetchData();
    }

    function duplicateExpense() {
      const e = editingExpense.value;
      if (!e) return;
      newExpense.value = {
        title: e.title,
        amount: e.amount.toString(),
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
      if (!confirm('Delete this expense?')) return;
      await SheetsApi.deleteRows(getSheetId(), TABS.EXPENSES, [id]);
      showEditModal.value = false;
      editingExpense.value = null;
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
      expenses, loading, filteredExpenses, monthlyTotal,
      showAddModal, showEditModal, editingExpense,
      newExpense, categories, baseCurrency,
      adjustBalance, editAdjustBalance,
      filterMonth, availableMonths, openDropdown, toggleDropdown, setDropdownOpen,
      formatCurrency, getAccountName, getAccountCurrency, formatAccountDisplayName,
      addExpense, startEdit, saveEdit, deleteExpense, duplicateExpense,
      formatDate, openNewExpenseModal,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <!-- Nav row -->
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

      <div v-if="loading" class="loading" style="padding-top:40px;"><div class="spinner"></div>Loading expenses...</div>

      <template v-else>
        <!-- Centered header -->
        <div class="subpage-header">
          <h1 class="subpage-title">Expenses</h1>
          <h2 class="subpage-balance">{{ formatCurrency(monthlyTotal, baseCurrency) }}</h2>
        </div>

        <!-- Filter -->
        <div style="padding:0 16px 8px;" v-if="availableMonths.length > 0">
          <div class="form-dropdown" @click.stop>
            <button type="button" class="form-dropdown-trigger" @click="toggleDropdown('filterMonth')">
              <span>{{ filterMonth || 'All months' }}</span>
              <span class="material-icons form-dropdown-arrow">expand_more</span>
            </button>
            <div class="form-dropdown-list" v-if="openDropdown === 'filterMonth'">
              <div class="form-dropdown-option" :class="{ selected: filterMonth === '' }"
                   @click="filterMonth = ''; openDropdown = null">All months</div>
              <div v-for="m in availableMonths" :key="m"
                   class="form-dropdown-option" :class="{ selected: filterMonth === m }"
                   @click="filterMonth = m; openDropdown = null">{{ m }}</div>
            </div>
          </div>
        </div>

        <!-- Expenses List -->
        <div class="valu-list" v-if="filteredExpenses.length > 0">
          <div v-for="exp in filteredExpenses" :key="exp.id" class="valu-list-item" @click="startEdit(exp)">
            <div class="valu-list-row">
              <div class="valu-list-name">{{ exp.title }}</div>
              <div class="valu-list-after">{{ formatCurrency(exp.amount, getAccountCurrency(exp.accountId)) }}</div>
            </div>
            <div class="valu-list-sub">
              {{ formatDate(exp.date) }}
              <span v-if="exp.category"> · {{ exp.category }}</span>
              <span v-if="getAccountName(exp.accountId)"> · {{ getAccountName(exp.accountId) }}</span>
            </div>
          </div>
        </div>

        <div v-if="filteredExpenses.length === 0 && expenses.length > 0" class="empty-state">
          <span class="material-icons">filter_list</span>
          <h3>No expenses for this period</h3>
        </div>

        <div v-if="expenses.length === 0" class="empty-state" style="padding-top:40px;">
          <span class="material-icons">shopping_cart</span>
          <h3>No expenses yet</h3>
          <p>Start tracking your spending by adding your first expense.</p>
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
            <input class="sheet-hero-name" v-model="newExpense.title" placeholder="What did you spend on?" />
            <input class="sheet-hero-amount" v-model="newExpense.amount" type="number" step="0.01" placeholder="0" />
            <div class="sheet-hero-label">Amount</div>
          </div>
          <div class="modal-body" @click="openDropdown = null">
            <div class="sheet-section-title">Details</div>
            <div class="sheet-list-item">
              <label>Date</label>
              <valu-date-field v-model="newExpense.date" />
            </div>
            <div class="sheet-list-item" v-if="categories.length > 0">
              <label>Category</label>
              <valu-dropdown :open="openDropdown === 'newCat'" @update:open="(v) => setDropdownOpen('newCat', v)">
                <template #label>{{ newExpense.category || 'No category' }}</template>
                <div class="valu-dropdown-option" :class="{ selected: !newExpense.category }"
                     @click="newExpense.category = ''; openDropdown = null">No category</div>
                <div v-for="c in categories" :key="c"
                     class="valu-dropdown-option" :class="{ selected: newExpense.category === c }"
                     @click="newExpense.category = c; openDropdown = null">{{ c }}</div>
              </valu-dropdown>
            </div>
            <div class="sheet-list-item" v-if="accounts && accounts.length > 0">
              <label>Account</label>
              <valu-dropdown :open="openDropdown === 'newAcct'" @update:open="(v) => setDropdownOpen('newAcct', v)">
                <template #label>{{ newExpense.accountId ? getAccountName(newExpense.accountId) : 'No account' }}</template>
                <div class="valu-dropdown-option" :class="{ selected: !newExpense.accountId }"
                     @click="newExpense.accountId = ''; openDropdown = null">No account</div>
                <div v-for="a in accounts" :key="a.id"
                     class="valu-dropdown-option" :class="{ selected: newExpense.accountId === a.id }"
                     @click="newExpense.accountId = a.id; openDropdown = null">{{ formatAccountDisplayName(a) }}</div>
              </valu-dropdown>
            </div>
            <div class="form-group" style="margin-top:16px;">
              <label class="form-label">Notes</label>
              <textarea class="form-input" v-model="newExpense.notes" rows="2" placeholder="Optional notes"></textarea>
            </div>
            <label v-if="newExpense.accountId && accounts && accounts.length > 0" class="balance-adjust-check" @click.stop>
              <input type="checkbox" v-model="adjustBalance" />
              <span>Also update {{ getAccountName(newExpense.accountId) }} balance</span>
            </label>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" @click="addExpense" :disabled="!newExpense.title.trim() || newExpense.amount === '' || newExpense.amount === undefined">Add expense</button>
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
            <input class="sheet-hero-amount" v-model="editingExpense.amount" type="number" step="0.01" placeholder="0" />
            <div class="sheet-hero-label">Amount</div>
          </div>
          <div class="modal-body" @click="openDropdown = null">
            <div class="sheet-section-title">Details</div>
            <div class="sheet-list-item">
              <label>Date</label>
              <valu-date-field v-model="editingExpense.date" />
            </div>
            <div class="sheet-list-item" v-if="categories.length > 0">
              <label>Category</label>
              <valu-dropdown :open="openDropdown === 'editCat'" @update:open="(v) => setDropdownOpen('editCat', v)">
                <template #label>{{ editingExpense.category || 'No category' }}</template>
                <div class="valu-dropdown-option" :class="{ selected: !editingExpense.category }"
                     @click="editingExpense.category = ''; openDropdown = null">No category</div>
                <div v-for="c in categories" :key="c"
                     class="valu-dropdown-option" :class="{ selected: editingExpense.category === c }"
                     @click="editingExpense.category = c; openDropdown = null">{{ c }}</div>
              </valu-dropdown>
            </div>
            <div class="sheet-list-item" v-if="accounts && accounts.length > 0">
              <label>Account</label>
              <valu-dropdown :open="openDropdown === 'editAcct'" @update:open="(v) => setDropdownOpen('editAcct', v)">
                <template #label>{{ editingExpense.accountId ? getAccountName(editingExpense.accountId) : 'No account' }}</template>
                <div class="valu-dropdown-option" :class="{ selected: !editingExpense.accountId }"
                     @click="editingExpense.accountId = ''; openDropdown = null">No account</div>
                <div v-for="a in accounts" :key="a.id"
                     class="valu-dropdown-option" :class="{ selected: editingExpense.accountId === a.id }"
                     @click="editingExpense.accountId = a.id; openDropdown = null">{{ formatAccountDisplayName(a) }}</div>
              </valu-dropdown>
            </div>
            <div class="form-group" style="margin-top:16px;">
              <label class="form-label">Notes</label>
              <textarea class="form-input" v-model="editingExpense.notes" rows="2"></textarea>
            </div>
            <label v-if="editingExpense.accountId && accounts && accounts.length > 0" class="balance-adjust-check" @click.stop>
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
    </div>
  `,
};
