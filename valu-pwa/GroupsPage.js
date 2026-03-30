import SheetsApi, { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES, CATEGORY_ICONS } from './sheetsApi.js';
import GoogleAuth from './googleAuth.js';

const { ref, computed, watch } = Vue;

const AVAILABLE_LISTS = [
  { key: 'accounts',  label: 'Accounts',  icon: 'account_balance', description: 'Track bank accounts, savings, and net worth over time' },
  { key: 'expenses',  label: 'Expenses',  icon: 'shopping_cart',   description: 'Log and categorize your spending' },
  { key: 'income',    label: 'Income',    icon: 'payments',        description: 'Track income sources and earnings' },
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

export default {
  props: ['groups', 'activeGroup', 'userProfile', 'settings'],
  emits: ['switch-group', 'create-group', 'refresh-groups', 'open-shared', 'settings-updated', 'go-home'],

  setup(props, { emit }) {
    const creating = ref(false);
    const loading = ref(false);
    const sortMode = ref('modified');
    const listLabelsByGroupId = ref({});

    // Group config sheet state
    const showConfigSheet = ref(false);
    const configGroupId = ref(null);
    const configSaving = ref(false);
    const configGroupName = ref('');
    const configBaseCurrency = ref('CAD');
    const configEnabledLists = ref([]);
    const configExpenseCategories = ref([]);
    const configIncomeCategories = ref([]);
    const configCurrencyRates = ref([]);
    const newExpenseCat = ref('');
    const newIncomeCat = ref('');
    const newRateCurrency = ref('');
    const newRateValue = ref('');
    const currencyDropdownOpen = ref(false);
    const currencySearch = ref('');
    const iconPickerFor = ref(null);
    const editingCatName = ref(null);
    const editCatNameValue = ref('');

    // CATEGORY_ICONS imported from sheetsApi.js

    function serializeCategories(arr) {
      return arr.map(c => c.icon ? c.name + ':' + c.icon : c.name).join(',');
    }
    function parseCategories(str) {
      return (str || '').split(',').filter(Boolean).map(c => {
        const idx = c.indexOf(':');
        if (idx < 0) return { name: c, icon: '' };
        return { name: c.slice(0, idx), icon: c.slice(idx + 1) };
      });
    }
    /** True while configuring a group that does not exist yet (single-sheet create flow). */
    const configIsNewGroup = ref(false);

    const filteredCurrencies = computed(() => {
      const q = currencySearch.value.toLowerCase();
      if (!q) return CURRENCIES;
      return CURRENCIES.filter(c => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
    });

    function currencyName(code) {
      const found = CURRENCIES.find(c => c.code === code);
      return found ? found.name : code;
    }

    const sortedGroups = computed(() => {
      return [...(props.groups || [])].sort((a, b) =>
        new Date(b.modifiedTime) - new Date(a.modifiedTime)
      );
    });

    const displayGroups = computed(() => {
      const list = [...sortedGroups.value];
      if (sortMode.value === 'name') {
        list.sort((a, b) => {
          const na = (a.name || '').replace(/^Valu:\s*/i, '');
          const nb = (b.name || '').replace(/^Valu:\s*/i, '');
          return na.localeCompare(nb, undefined, { sensitivity: 'base' });
        });
      }
      return list;
    });

    function listsEnabledToLine(csv) {
      const keys = (csv || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!keys.length) return 'No tools enabled';
      return keys
        .map((k) => {
          const def = AVAILABLE_LISTS.find((a) => a.key === k);
          return def ? def.label : k.charAt(0).toUpperCase() + k.slice(1);
        })
        .join(', ');
    }

    function listSummaryForGroup(groupId) {
      const line = listLabelsByGroupId.value[groupId];
      if (line === undefined) return '…';
      return line || '—';
    }

    let hydrateInFlight = null;
    async function hydrateListLabels() {
      const groups = props.groups || [];
      const activeId = props.activeGroup?.id;
      const settings = props.settings;
      const updates = { ...listLabelsByGroupId.value };

      if (activeId && settings && typeof settings.listsEnabled === 'string') {
        updates[activeId] = listsEnabledToLine(settings.listsEnabled);
      }

      const pending = groups.filter((g) => {
        if (updates[g.id] != null && updates[g.id] !== '') return false;
        if (g.id === activeId && settings && typeof settings.listsEnabled === 'string') return false;
        return true;
      });

      await Promise.all(
        pending.map(async (g) => {
          try {
            const s = await SheetsApi.getSettings(g.id);
            updates[g.id] = listsEnabledToLine(s.listsEnabled);
          } catch {
            updates[g.id] = '—';
          }
        })
      );

      listLabelsByGroupId.value = updates;
    }

    function scheduleHydrateListLabels() {
      if (hydrateInFlight) clearTimeout(hydrateInFlight);
      hydrateInFlight = setTimeout(() => {
        hydrateInFlight = null;
        hydrateListLabels();
      }, 80);
    }

    watch(
      () => (props.groups || []).map((g) => g.id).join(','),
      () => {
        scheduleHydrateListLabels();
      },
      { immediate: true }
    );

    watch(
      () => `${props.activeGroup?.id || ''}|${props.settings?.listsEnabled ?? ''}`,
      () => {
        const id = props.activeGroup?.id;
        if (id != null && props.settings && typeof props.settings.listsEnabled === 'string') {
          listLabelsByGroupId.value = {
            ...listLabelsByGroupId.value,
            [id]: listsEnabledToLine(props.settings.listsEnabled),
          };
        }
      }
    );

    function toggleSortMode() {
      sortMode.value = sortMode.value === 'modified' ? 'name' : 'modified';
    }

    const isActiveGroupConfig = computed(() => {
      return props.activeGroup && configGroupId.value === props.activeGroup.id;
    });

    function openNewGroupFlow() {
      configIsNewGroup.value = true;
      configGroupId.value = null;
      configGroupName.value = '';
      configBaseCurrency.value = 'CAD';
      configEnabledLists.value = ['expenses', 'income', 'accounts'];
      configExpenseCategories.value = DEFAULT_EXPENSE_CATEGORIES.map(c => ({ ...c }));
      configIncomeCategories.value = DEFAULT_INCOME_CATEGORIES.map(c => ({ ...c }));
      configCurrencyRates.value = [];
      newExpenseCat.value = '';
      newIncomeCat.value = '';
      newRateCurrency.value = '';
      newRateValue.value = '';
      currencyDropdownOpen.value = false;
      currencySearch.value = '';
      iconPickerFor.value = null;
      editingCatName.value = null;
      showConfigSheet.value = true;
    }

    async function submitNewGroup() {
      const name = configGroupName.value.trim();
      if (!name || creating.value) return;

      creating.value = true;
      try {
        const result = await SheetsApi.createSpreadsheet(
          name,
          props.userProfile?.email || ''
        );
        const id = result.id;
        configGroupId.value = id;

        const listsCsv = configEnabledLists.value.join(',');
        const ratesStr = configCurrencyRates.value.map((r) => `${r.currency}:${r.rate}`).join(',');

        await Promise.all([
          SheetsApi.updateSetting(id, 'groupName', name),
          SheetsApi.updateSetting(id, 'baseCurrency', configBaseCurrency.value),
          SheetsApi.updateSetting(id, 'listsEnabled', listsCsv),
          SheetsApi.updateSetting(id, 'expenseCategories', serializeCategories(configExpenseCategories.value)),
          SheetsApi.updateSetting(id, 'incomeCategories', serializeCategories(configIncomeCategories.value)),
          SheetsApi.updateSetting(id, 'currencyRates', ratesStr),
        ]);

        listLabelsByGroupId.value = {
          ...listLabelsByGroupId.value,
          [id]: listsEnabledToLine(listsCsv),
        };

        configIsNewGroup.value = false;
        showConfigSheet.value = false;

        emit('create-group', {
          id: result.id,
          name: result.name,
          keepOnGroupsPage: true,
        });
      } catch (err) {
        configGroupId.value = null;
        alert('Failed to create group: ' + err.message);
      } finally {
        creating.value = false;
      }
    }

    async function openSharedSheet() {
      try {
        const picked = await GoogleAuth.showPicker('Valu:');
        if (picked) {
          emit('open-shared', picked);
        }
      } catch (err) {
        alert('Failed to open picker: ' + err.message);
      }
    }

    function switchGroup(group) {
      emit('switch-group', group);
    }

    function formatDate(isoString) {
      if (!isoString) return '';
      return new Date(isoString).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    }

    async function refreshGroups() {
      loading.value = true;
      const ids = (props.groups || []).map((g) => g.id);
      const cleared = { ...listLabelsByGroupId.value };
      ids.forEach((id) => {
        delete cleared[id];
      });
      listLabelsByGroupId.value = cleared;
      try {
        emit('refresh-groups');
      } finally {
        setTimeout(() => {
          loading.value = false;
          scheduleHydrateListLabels();
        }, 400);
      }
    }

    // ── Group Configuration Sheet ──────────────────────────────────────────

    async function openGroupConfig(group) {
      configIsNewGroup.value = false;
      configGroupId.value = group.id;
      showConfigSheet.value = true;

      try {
        const settings = await SheetsApi.getSettings(group.id);
        configGroupName.value = settings.groupName || group.name.replace('Valu: ', '');
        configBaseCurrency.value = settings.baseCurrency || 'CAD';
        configEnabledLists.value = (settings.listsEnabled || '').split(',').filter(Boolean);
        configExpenseCategories.value = parseCategories(settings.expenseCategories);
        configIncomeCategories.value = parseCategories(settings.incomeCategories);

        const ratesStr = settings.currencyRates || '';
        configCurrencyRates.value = ratesStr.split(',').filter(Boolean).map(r => {
          const [cur, val] = r.split(':');
          return { currency: cur, rate: val };
        });
        listLabelsByGroupId.value = {
          ...listLabelsByGroupId.value,
          [group.id]: listsEnabledToLine(settings.listsEnabled),
        };
      } catch (err) {
        console.error('Failed to load group settings:', err);
        alert('Failed to load group configuration: ' + err.message);
        showConfigSheet.value = false;
      }
    }

    watch(showConfigSheet, (open) => {
      if (!open && configIsNewGroup.value) {
        configGroupId.value = null;
      }
      if (!open) {
        configIsNewGroup.value = false;
      }
    });

    async function saveConfigField(key, value) {
      if (!configGroupId.value || configIsNewGroup.value) return;
      configSaving.value = true;
      try {
        await SheetsApi.updateSetting(configGroupId.value, key, value);
        if (isActiveGroupConfig.value) {
          emit('settings-updated', { [key]: value });
        }
      } catch (err) {
        alert('Failed to save: ' + err.message);
      } finally {
        configSaving.value = false;
      }
    }

    function saveConfigGroupName() {
      const name = configGroupName.value.trim();
      if (!name) return;
      saveConfigField('groupName', name);
    }

    function saveConfigBaseCurrency() {
      saveConfigField('baseCurrency', configBaseCurrency.value);
    }

    function selectConfigBaseCurrency(code) {
      configBaseCurrency.value = code;
      currencyDropdownOpen.value = false;
      saveConfigBaseCurrency();
    }

    async function toggleConfigList(key) {
      const idx = configEnabledLists.value.indexOf(key);
      if (idx >= 0) {
        configEnabledLists.value.splice(idx, 1);
      } else {
        configEnabledLists.value.push(key);
      }
      const csv = configEnabledLists.value.join(',');
      await saveConfigField('listsEnabled', csv);
      const gid = configGroupId.value;
      if (gid) {
        listLabelsByGroupId.value = {
          ...listLabelsByGroupId.value,
          [gid]: listsEnabledToLine(csv),
        };
      }
    }

    function addConfigCategory(type) {
      if (type === 'expense') {
        const name = newExpenseCat.value.trim();
        if (name && !configExpenseCategories.value.some(c => c.name === name)) {
          configExpenseCategories.value.push({ name, icon: '' });
          newExpenseCat.value = '';
          saveConfigField('expenseCategories', serializeCategories(configExpenseCategories.value));
        }
      } else {
        const name = newIncomeCat.value.trim();
        if (name && !configIncomeCategories.value.some(c => c.name === name)) {
          configIncomeCategories.value.push({ name, icon: '' });
          newIncomeCat.value = '';
          saveConfigField('incomeCategories', serializeCategories(configIncomeCategories.value));
        }
      }
    }

    function removeConfigCategory(type, index) {
      const list = type === 'expense' ? configExpenseCategories : configIncomeCategories;
      const name = list.value[index]?.name || 'this category';
      if (!confirm('Delete "' + name + '"? This will not remove the category from existing entries.')) return;
      list.value.splice(index, 1);
      const key = type === 'expense' ? 'expenseCategories' : 'incomeCategories';
      saveConfigField(key, serializeCategories(list.value));
    }

    function openIconPicker(type, index) {
      iconPickerFor.value = { type, index };
    }

    function pickIcon(iconName) {
      if (!iconPickerFor.value) return;
      const { type, index } = iconPickerFor.value;
      const list = type === 'expense' ? configExpenseCategories : configIncomeCategories;
      list.value[index] = { ...list.value[index], icon: iconName };
      iconPickerFor.value = null;
      const key = type === 'expense' ? 'expenseCategories' : 'incomeCategories';
      saveConfigField(key, serializeCategories(list.value));
    }

    function clearCategoryIcon() {
      if (!iconPickerFor.value) return;
      const { type, index } = iconPickerFor.value;
      const list = type === 'expense' ? configExpenseCategories : configIncomeCategories;
      list.value[index] = { ...list.value[index], icon: '' };
      iconPickerFor.value = null;
      const key = type === 'expense' ? 'expenseCategories' : 'incomeCategories';
      saveConfigField(key, serializeCategories(list.value));
    }

    function startRenameCat(type, index) {
      const list = type === 'expense' ? configExpenseCategories : configIncomeCategories;
      editingCatName.value = { type, index };
      editCatNameValue.value = list.value[index].name;
    }

    function saveRenameCat() {
      if (!editingCatName.value) return;
      const { type, index } = editingCatName.value;
      const list = type === 'expense' ? configExpenseCategories : configIncomeCategories;
      const newName = editCatNameValue.value.trim();
      if (!newName || (list.value.some((c, i) => c.name === newName && i !== index))) {
        editingCatName.value = null;
        return;
      }
      list.value[index] = { ...list.value[index], name: newName };
      editingCatName.value = null;
      const key = type === 'expense' ? 'expenseCategories' : 'incomeCategories';
      saveConfigField(key, serializeCategories(list.value));
    }

    function cancelRenameCat() {
      editingCatName.value = null;
    }

    function moveCategoryUp(type, index) {
      if (index === 0) return;
      const list = type === 'expense' ? configExpenseCategories : configIncomeCategories;
      const arr = [...list.value];
      [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
      list.value = arr;
      const key = type === 'expense' ? 'expenseCategories' : 'incomeCategories';
      saveConfigField(key, serializeCategories(arr));
    }

    function moveCategoryDown(type, index) {
      const list = type === 'expense' ? configExpenseCategories : configIncomeCategories;
      if (index >= list.value.length - 1) return;
      const arr = [...list.value];
      [arr[index], arr[index + 1]] = [arr[index + 1], arr[index]];
      list.value = arr;
      const key = type === 'expense' ? 'expenseCategories' : 'incomeCategories';
      saveConfigField(key, serializeCategories(arr));
    }

    function toggleCategoriesEnabled(type) {
      const key = type === 'expense' ? 'expenseCategoriesEnabled' : 'incomeCategoriesEnabled';
      const current = type === 'expense'
        ? (props.settings?.expenseCategoriesEnabled !== 'false')
        : (props.settings?.incomeCategoriesEnabled !== 'false');
      saveConfigField(key, current ? 'false' : 'true');
    }

    function areCategoriesEnabled(type) {
      if (type === 'expense') return props.settings?.expenseCategoriesEnabled !== 'false';
      return props.settings?.incomeCategoriesEnabled !== 'false';
    }

    function addConfigCurrencyRate() {
      const cur = newRateCurrency.value.trim().toUpperCase();
      const val = newRateValue.value.trim();
      if (!cur || !val) return;

      const existing = configCurrencyRates.value.findIndex(r => r.currency === cur);
      if (existing >= 0) {
        configCurrencyRates.value[existing].rate = val;
      } else {
        configCurrencyRates.value.push({ currency: cur, rate: val });
      }
      newRateCurrency.value = '';
      newRateValue.value = '';
      const str = configCurrencyRates.value.map(r => `${r.currency}:${r.rate}`).join(',');
      saveConfigField('currencyRates', str);
    }

    function removeConfigCurrencyRate(index) {
      configCurrencyRates.value.splice(index, 1);
      const str = configCurrencyRates.value.map(r => `${r.currency}:${r.rate}`).join(',');
      saveConfigField('currencyRates', str);
    }

    return {
      creating, loading,
      sortedGroups, displayGroups, sortMode, toggleSortMode,
      listSummaryForGroup,
      openNewGroupFlow, submitNewGroup, openSharedSheet, switchGroup, formatDate,
      refreshGroups,
      showConfigSheet, configGroupId, configSaving, configIsNewGroup,
      configGroupName, configBaseCurrency, configEnabledLists,
      configExpenseCategories, configIncomeCategories, configCurrencyRates,
      newExpenseCat, newIncomeCat, newRateCurrency, newRateValue,
      AVAILABLE_LISTS, CURRENCIES, CATEGORY_ICONS,
      currencyDropdownOpen, currencySearch, filteredCurrencies, currencyName,
      iconPickerFor, editingCatName, editCatNameValue,
      openGroupConfig, saveConfigGroupName, saveConfigBaseCurrency, selectConfigBaseCurrency,
      toggleConfigList, addConfigCategory, removeConfigCategory,
      openIconPicker, pickIcon, clearCategoryIcon,
      startRenameCat, saveRenameCat, cancelRenameCat,
      moveCategoryUp, moveCategoryDown,
      toggleCategoriesEnabled, areCategoriesEnabled,
      addConfigCurrencyRate, removeConfigCurrencyRate,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Groups</h1>
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

      <div class="subpage-header">
        <button type="button" class="btn-icon subpage-header-refresh" @click="refreshGroups" :disabled="loading" aria-label="Refresh groups from Drive">
          <span class="material-icons" :class="{ 'groups-refresh-spin': loading }" style="font-size:18px;">refresh</span>
        </button>
      </div>

      <div v-if="displayGroups.length > 1" class="groups-sort-bar">
        <button type="button" class="groups-sort-btn" @click="toggleSortMode">
          <span class="material-icons">filter_list</span>
          <span>Sort</span>
          <span class="groups-sort-mode">{{ sortMode === 'name' ? 'A–Z' : 'Recent' }}</span>
        </button>
      </div>

      <div class="groups-page-body">
        <div v-if="loading && displayGroups.length === 0" class="loading" style="padding-top:24px;"><div class="spinner"></div>Loading groups...</div>

        <div v-else-if="displayGroups.length === 0 && !loading" class="empty-state groups-empty-state">
          <span class="material-icons">group</span>
          <h3>No groups yet</h3>
          <p>Create a group to start tracking your finances, or open a shared one.</p>
        </div>

        <div v-else class="valu-list groups-valu-list">
          <button
            v-for="group in displayGroups"
            :key="group.id"
            type="button"
            class="valu-list-card groups-list-card"
            @click="openGroupConfig(group)"
          >
            <div class="valu-list-row">
              <span class="valu-list-name">{{ group.name.replace('Valu: ', '') }}</span>
              <span class="groups-card-lists">{{ listSummaryForGroup(group.id) }}</span>
            </div>
            <div class="valu-list-row-sub groups-card-sub">
              <span class="valu-list-sub">Last modified {{ formatDate(group.modifiedTime) }}</span>
              <span v-if="activeGroup && activeGroup.id === group.id" class="groups-active-pill">Active</span>
            </div>
          </button>
        </div>
      </div>

      <div class="subpage-bottom-fixed subpage-bottom-fixed--stack">
        <button type="button" class="btn-add-outline" @click="openNewGroupFlow">ADD GROUP</button>
        <button type="button" class="btn-add-outline btn-add-outline--muted" @click="openSharedSheet">OPEN SHARED GROUP</button>
      </div>
      </div>

      <!-- Group Config Sheet (existing groups + single-step new group) -->
      <div class="modal-overlay" :class="{ open: showConfigSheet }" @click.self="!creating && (showConfigSheet = false)">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>{{ configIsNewGroup ? 'New group' : 'Group Configuration' }}</h2>
            <button class="btn-icon" @click="!creating && (showConfigSheet = false)" :disabled="creating">
              <span class="material-icons">close</span>
            </button>
          </div>

          <div class="modal-body">

            <!-- Group Name -->
            <div class="card mb-16">
              <div class="card-header"><h3>Group Name</h3></div>
              <div class="card-body">
                <div class="flex gap-8">
                  <input class="form-input flex-1" v-model="configGroupName" @blur="saveConfigGroupName" @keyup.enter="configIsNewGroup ? submitNewGroup() : saveConfigGroupName()" />
                </div>
                <p v-if="configIsNewGroup" style="font-size:13px;color:var(--color-text-secondary);margin-top:8px;">
                  A Google Sheet is created in your Drive when you tap Create group below. Adjust tools and currency first if you like — everything is saved in one step.
                </p>
              </div>
            </div>

            <!-- Base Currency -->
            <div class="card mb-16">
              <div class="card-header"><h3>Base Currency</h3></div>
              <div class="card-body">
                <valu-currency-picker v-model:open="currencyDropdownOpen" v-model:search="currencySearch">
                  <template #label>{{ currencyName(configBaseCurrency) }}</template>
                  <div v-for="c in filteredCurrencies" :key="c.code"
                       class="currency-picker-option" :class="{ selected: c.code === configBaseCurrency }"
                       @click="selectConfigBaseCurrency(c.code)">{{ c.name }}</div>
                  <div v-if="filteredCurrencies.length === 0" class="currency-picker-empty">No match</div>
                </valu-currency-picker>
                <p style="font-size:13px;color:var(--color-text-secondary);margin-top:8px;">
                  All amounts will be displayed in this currency.
                </p>
              </div>
            </div>

            <!-- Currency Conversion Rates -->
            <div class="card mb-16">
              <div class="card-header"><h3>Currency Rates</h3></div>
              <div class="card-body">
                <p style="font-size:13px;color:var(--color-text-secondary);margin-bottom:12px;">
                  Set conversion rates from other currencies to {{ configBaseCurrency }}.
                </p>
                <div v-for="(r, i) in configCurrencyRates" :key="i" class="flex items-center gap-8 mb-8">
                  <span style="font-size:14px;font-weight:500;min-width:40px;">{{ r.currency }}</span>
                  <span style="font-size:13px;color:var(--color-text-secondary);flex:1;">= {{ r.rate }} {{ configBaseCurrency }}</span>
                  <button class="btn-icon btn-danger" @click="removeConfigCurrencyRate(i)">
                    <span class="material-icons" style="font-size:18px;">close</span>
                  </button>
                </div>
                <div class="flex gap-8 mt-8">
                  <input class="form-input" v-model="newRateCurrency" placeholder="USD" style="width:70px;" />
                  <input class="form-input flex-1" v-model="newRateValue" placeholder="Rate" type="number" step="any" />
                  <button class="btn btn-outline" @click="addConfigCurrencyRate" :disabled="!newRateCurrency || !newRateValue">Add</button>
                </div>
              </div>
            </div>

            <!-- Enabled Lists -->
            <div class="card mb-16">
              <div class="card-header"><h3>Enabled Tools</h3></div>
              <div class="card-body" style="padding:0;">
                <div v-for="list in AVAILABLE_LISTS" :key="list.key" class="list-item">
                  <div class="list-item-icon">
                    <span class="material-icons">{{ list.icon }}</span>
                  </div>
                  <div class="list-item-content">
                    <div class="list-item-title">{{ list.label }}</div>
                    <div class="list-item-subtitle">{{ list.description }}</div>
                  </div>
                  <label class="toggle">
                    <input type="checkbox" :checked="configEnabledLists.includes(list.key)" @change="toggleConfigList(list.key)" />
                    <div class="toggle-track"></div>
                    <div class="toggle-thumb"></div>
                  </label>
                </div>
              </div>
            </div>

            <!-- Expense Categories -->
            <div class="card mb-16" v-if="configEnabledLists.includes('expenses')">
              <div class="card-header">
                <h3>Expense Categories</h3>
                <label class="toggle toggle-sm" v-if="configExpenseCategories.length">
                  <input type="checkbox" :checked="areCategoriesEnabled('expense')" @change="toggleCategoriesEnabled('expense')" />
                  <div class="toggle-track"></div>
                  <div class="toggle-thumb"></div>
                </label>
              </div>
              <div class="card-body">
                <div class="cat-list" v-if="configExpenseCategories.length">
                  <div class="cat-item" v-for="(cat, i) in configExpenseCategories" :key="i">
                    <button class="cat-icon-btn" @click="openIconPicker('expense', i)">
                      <span class="material-icons">{{ cat.icon || 'label' }}</span>
                    </button>
                    <template v-if="editingCatName && editingCatName.type === 'expense' && editingCatName.index === i">
                      <input class="form-input cat-rename-input" v-model="editCatNameValue" @keyup.enter="saveRenameCat" @keyup.escape="cancelRenameCat" @blur="saveRenameCat" />
                    </template>
                    <span v-else class="cat-name" @click="startRenameCat('expense', i)">{{ cat.name }}</span>
                    <div class="cat-order-btns">
                      <button class="cat-order-btn" @click="moveCategoryUp('expense', i)" :disabled="i === 0"><span class="material-icons">arrow_upward</span></button>
                      <button class="cat-order-btn" @click="moveCategoryDown('expense', i)" :disabled="i === configExpenseCategories.length - 1"><span class="material-icons">arrow_downward</span></button>
                    </div>
                    <button class="cat-remove-btn" @click="removeConfigCategory('expense', i)">&times;</button>
                  </div>
                </div>
                <p v-else style="font-size:13px;color:var(--color-text-hint);margin-bottom:12px;">
                  No categories yet. Categories are optional.
                </p>
                <div class="flex gap-8">
                  <input class="form-input flex-1" v-model="newExpenseCat" placeholder="New category" @keyup.enter="addConfigCategory('expense')" />
                  <button class="btn btn-outline" @click="addConfigCategory('expense')" :disabled="!newExpenseCat.trim()">Add</button>
                </div>
              </div>
            </div>

            <!-- Income Categories -->
            <div class="card mb-16" v-if="configEnabledLists.includes('income')">
              <div class="card-header">
                <h3>Income Categories</h3>
                <label class="toggle toggle-sm" v-if="configIncomeCategories.length">
                  <input type="checkbox" :checked="areCategoriesEnabled('income')" @change="toggleCategoriesEnabled('income')" />
                  <div class="toggle-track"></div>
                  <div class="toggle-thumb"></div>
                </label>
              </div>
              <div class="card-body">
                <div class="cat-list" v-if="configIncomeCategories.length">
                  <div class="cat-item" v-for="(cat, i) in configIncomeCategories" :key="i">
                    <button class="cat-icon-btn" @click="openIconPicker('income', i)">
                      <span class="material-icons">{{ cat.icon || 'label' }}</span>
                    </button>
                    <template v-if="editingCatName && editingCatName.type === 'income' && editingCatName.index === i">
                      <input class="form-input cat-rename-input" v-model="editCatNameValue" @keyup.enter="saveRenameCat" @keyup.escape="cancelRenameCat" @blur="saveRenameCat" />
                    </template>
                    <span v-else class="cat-name" @click="startRenameCat('income', i)">{{ cat.name }}</span>
                    <div class="cat-order-btns">
                      <button class="cat-order-btn" @click="moveCategoryUp('income', i)" :disabled="i === 0"><span class="material-icons">arrow_upward</span></button>
                      <button class="cat-order-btn" @click="moveCategoryDown('income', i)" :disabled="i === configIncomeCategories.length - 1"><span class="material-icons">arrow_downward</span></button>
                    </div>
                    <button class="cat-remove-btn" @click="removeConfigCategory('income', i)">&times;</button>
                  </div>
                </div>
                <p v-else style="font-size:13px;color:var(--color-text-hint);margin-bottom:12px;">
                  No categories yet. Categories are optional.
                </p>
                <div class="flex gap-8">
                  <input class="form-input flex-1" v-model="newIncomeCat" placeholder="New category" @keyup.enter="addConfigCategory('income')" />
                  <button class="btn btn-outline" @click="addConfigCategory('income')" :disabled="!newIncomeCat.trim()">Add</button>
                </div>
              </div>
            </div>

            <!-- Icon Picker Overlay -->
            <div class="modal-overlay modal-overlay-top" :class="{ open: !!iconPickerFor }" @click.self="iconPickerFor = null">
              <div class="modal" v-if="iconPickerFor" style="max-height:60vh;">
                <div class="sheet-handle"></div>
                <div class="modal-header">
                  <h2>Choose Icon</h2>
                  <button class="btn-icon" @click="iconPickerFor = null"><span class="material-icons">close</span></button>
                </div>
                <div class="modal-body" style="padding:12px;">
                  <div class="icon-picker-grid">
                    <button v-for="ic in CATEGORY_ICONS" :key="ic" class="icon-picker-item" @click="pickIcon(ic)" :title="ic">
                      <span class="material-icons">{{ ic }}</span>
                    </button>
                  </div>
                  <button class="btn btn-text" style="width:100%;margin-top:8px;" @click="clearCategoryIcon">Remove icon</button>
                </div>
              </div>
            </div>

            <div v-if="configSaving && !configIsNewGroup" style="text-align:center;padding:8px;font-size:13px;color:var(--color-text-hint);">
              Saving...
            </div>

          </div>

          <div v-if="configIsNewGroup" class="modal-footer">
            <button type="button" class="btn-sheet-cta" @click="submitNewGroup" :disabled="!configGroupName.trim() || creating">
              {{ creating ? 'Creating...' : 'Create group' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
};
