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
    const filterMonth = ref('');
    const openDropdown = ref(null);

    const newIncome = ref({
      title: '', amount: '', accountId: '', category: '', date: '', notes: '',
    });

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');

    const categories = computed(() => {
      const str = props.settings?.incomeCategories || '';
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
          const key = `${parts[0]}-${parts[1]}`;
          return key === filterMonth.value;
        });
      }

      return list;
    });

    const monthlyTotal = computed(() => {
      return filteredIncome.value.reduce((sum, e) => {
        const cur = getAccountCurrency(e.accountId);
        return sum + convertToBase(e.amount, cur);
      }, 0);
    });

    async function fetchData() {
      loading.value = true;
      try {
        const rows = await SheetsApi.getTabData(getSheetId(), TABS.INCOME);
        incomeList.value = rows.map(r => ({
          id: r[0], title: r[1], amount: parseFloat(r[2]) || 0,
          accountId: r[3], category: r[4], date: r[5],
          notes: r[6], createdAt: r[7],
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
      showAddModal.value = true;
    }

    async function addIncome() {
      const e = newIncome.value;
      if (!e.title.trim() || !e.amount) return;

      const id = SheetsApi.generateId();
      const now = new Date().toISOString();
      const date = e.date || localDateISO();

      await SheetsApi.appendRow(getSheetId(), TABS.INCOME, [
        id, e.title.trim(), e.amount.toString(), e.accountId,
        e.category, date, e.notes, now,
      ]);

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
      editingIncome.value = { ...income, amount: income.amount.toString() };
      showEditModal.value = true;
    }

    async function saveEdit() {
      const e = editingIncome.value;
      if (!e) return;

      await SheetsApi.updateRow(getSheetId(), TABS.INCOME, e.id, [
        e.id, e.title, e.amount.toString(), e.accountId,
        e.category, e.date, e.notes, e.createdAt,
      ]);

      showEditModal.value = false;
      editingIncome.value = null;
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
      incomeList, loading, filteredIncome, monthlyTotal,
      showAddModal, showEditModal, editingIncome,
      newIncome, categories, baseCurrency,
      filterMonth, availableMonths, openDropdown, toggleDropdown, setDropdownOpen,
      formatCurrency, getAccountName, getAccountCurrency, formatAccountDisplayName,
      addIncome, startEdit, saveEdit, deleteIncome, duplicateIncome,
      formatDate, openNewIncomeModal,
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

      <div v-if="loading" class="loading" style="padding-top:40px;"><div class="spinner"></div>Loading income...</div>

      <template v-else>
        <!-- Centered header -->
        <div class="subpage-header">
          <h1 class="subpage-title">Income</h1>
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

        <!-- Income List -->
        <div class="valu-list" v-if="filteredIncome.length > 0">
          <div v-for="inc in filteredIncome" :key="inc.id" class="valu-list-item" @click="startEdit(inc)">
            <div class="valu-list-row">
              <div class="valu-list-name">{{ inc.title }}</div>
              <div class="valu-list-after">{{ inc.amount }}</div>
            </div>
            <div class="valu-list-sub">
              {{ formatDate(inc.date) }}
              <span v-if="inc.category"> · {{ inc.category }}</span>
              <span v-if="getAccountName(inc.accountId)"> · {{ getAccountName(inc.accountId) }}</span>
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
            <input class="sheet-hero-name" v-model="newIncome.title" placeholder="Income source" autofocus />
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
                <template #label>{{ newIncome.category || 'No category' }}</template>
                <div class="valu-dropdown-option" :class="{ selected: !newIncome.category }"
                     @click="newIncome.category = ''; openDropdown = null">No category</div>
                <div v-for="c in categories" :key="c"
                     class="valu-dropdown-option" :class="{ selected: newIncome.category === c }"
                     @click="newIncome.category = c; openDropdown = null">{{ c }}</div>
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
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" @click="addIncome" :disabled="!newIncome.title.trim() || !newIncome.amount">Add income</button>
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
                <template #label>{{ editingIncome.category || 'No category' }}</template>
                <div class="valu-dropdown-option" :class="{ selected: !editingIncome.category }"
                     @click="editingIncome.category = ''; openDropdown = null">No category</div>
                <div v-for="c in categories" :key="c"
                     class="valu-dropdown-option" :class="{ selected: editingIncome.category === c }"
                     @click="editingIncome.category = c; openDropdown = null">{{ c }}</div>
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
