const { ref, computed, onMounted, inject } = Vue;

const DEFAULT_WIDGETS = [
  { id: 'totalBalance',       label: 'Total Balance',          icon: 'account_balance_wallet', requires: ['accounts'] },
  { id: 'thisMonth',          label: 'This Month / Insights',  icon: 'insights',               requires: [] },
  { id: 'recentTransactions', label: 'Recent Transactions',    icon: 'receipt_long',           requires: [] },
  { id: 'balanceOverview',    label: 'Balance Overview',       icon: 'table_chart',            requires: ['accounts'] },
  { id: 'expenseCategories',  label: 'Expense Categories',     icon: 'donut_large',            requires: ['expenses'] },
];
const LAYOUT_KEY = 'valu_home_layout';

function loadWidgetLayout() {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY));
    if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_WIDGETS.map(w => ({ ...w, enabled: true }));
    const merged = stored
      .filter(s => DEFAULT_WIDGETS.some(d => d.id === s.id))
      .map(s => {
        const def = DEFAULT_WIDGETS.find(d => d.id === s.id);
        return { ...def, enabled: s.enabled !== false };
      });
    for (const d of DEFAULT_WIDGETS) {
      if (!merged.some(m => m.id === d.id)) merged.push({ ...d, enabled: true });
    }
    return merged;
  } catch { return DEFAULT_WIDGETS.map(w => ({ ...w, enabled: true })); }
}

export default {
  props: ['groups', 'activeGroup'],
  emits: ['go-home', 'navigate'],

  setup(props) {
    const THEME_OPTIONS = [
      { value: 'auto', label: 'System default' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ];

    const NUMBER_FORMAT_OPTIONS = [
      { value: 'auto', label: 'System default' },
      { value: 'en-US', label: '1,234.56' },
      { value: 'de-DE', label: '1.234,56' },
    ];

    const theme = ref(localStorage.getItem('valu_theme') || 'auto');
    const numberFormat = ref(localStorage.getItem('valu_number_format') || 'auto');
    const defaultGroupId = ref(localStorage.getItem('valu_default_group') || '');
    const balanceReminders = ref(localStorage.getItem('valu_balance_reminders') !== 'false');

    function saveTheme() {
      localStorage.setItem('valu_theme', theme.value);
      applyTheme(theme.value);
    }

    function applyTheme(mode) {
      const root = document.documentElement;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (mode === 'dark') {
        root.setAttribute('data-theme', 'dark');
        if (meta) meta.setAttribute('content', '#211f1d');
      } else if (mode === 'light') {
        root.setAttribute('data-theme', 'light');
        if (meta) meta.setAttribute('content', '#729c9c');
      } else {
        root.removeAttribute('data-theme');
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (meta) meta.setAttribute('content', isDark ? '#211f1d' : '#729c9c');
      }
    }

    function saveDefaultGroup() {
      if (defaultGroupId.value) {
        localStorage.setItem('valu_default_group', defaultGroupId.value);
      } else {
        localStorage.removeItem('valu_default_group');
      }
    }

    function saveNumberFormat() {
      localStorage.setItem('valu_number_format', numberFormat.value);
    }

    function saveBalanceReminders() {
      localStorage.setItem('valu_balance_reminders', balanceReminders.value);
    }

    onMounted(() => {
      applyTheme(theme.value);
    });

    const openDropdown = ref(null);
    function toggleDropdown(name) {
      openDropdown.value = openDropdown.value === name ? null : name;
    }

    const homeWidgets = ref(loadWidgetLayout());
    const groupSettingsRef = inject('groupSettings', ref({}));
    const enabledLists = computed(() => {
      const str = groupSettingsRef.value?.listsEnabled || '';
      return str.split(',').filter(Boolean);
    });

    function saveWidgetLayout() {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(homeWidgets.value.map(w => ({ id: w.id, enabled: w.enabled }))));
    }
    function toggleWidget(id) {
      const w = homeWidgets.value.find(w => w.id === id);
      if (w) { w.enabled = !w.enabled; saveWidgetLayout(); }
    }
    function moveWidget(id, dir) {
      const idx = homeWidgets.value.findIndex(w => w.id === id);
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= homeWidgets.value.length) return;
      const arr = [...homeWidgets.value];
      [arr[idx], arr[targetIdx]] = [arr[targetIdx], arr[idx]];
      homeWidgets.value = arr;
      saveWidgetLayout();
    }
    function isWidgetAvailable(w) {
      if (!w.requires || w.requires.length === 0) return true;
      return w.requires.every(r => enabledLists.value.includes(r));
    }

    return {
      THEME_OPTIONS, NUMBER_FORMAT_OPTIONS, theme, numberFormat, defaultGroupId, balanceReminders,
      openDropdown, toggleDropdown,
      saveTheme, saveNumberFormat, saveDefaultGroup, saveBalanceReminders,
      homeWidgets, toggleWidget, moveWidget, isWidgetAvailable,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Settings</h1>
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

      <div style="padding:0 16px;">

        <!-- Theme -->
        <div class="card mb-16" @click="openDropdown = null">
          <div class="card-header"><h3>Appearance</h3></div>
          <div class="card-body">
            <div class="form-dropdown" @click.stop>
              <button type="button" class="form-dropdown-trigger" @click="toggleDropdown('theme')">
                <span>{{ THEME_OPTIONS.find(o => o.value === theme)?.label || 'System default' }}</span>
                <span class="material-icons form-dropdown-arrow">expand_more</span>
              </button>
              <div class="form-dropdown-list" v-if="openDropdown === 'theme'">
                <div v-for="opt in THEME_OPTIONS" :key="opt.value"
                     class="form-dropdown-option" :class="{ selected: theme === opt.value }"
                     @click="theme = opt.value; saveTheme(); openDropdown = null">{{ opt.label }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Number Format -->
        <div class="card mb-16" @click="openDropdown = null">
          <div class="card-header"><h3>Number Format</h3></div>
          <div class="card-body">
            <div class="form-dropdown" @click.stop>
              <button type="button" class="form-dropdown-trigger" @click="toggleDropdown('numberFormat')">
                <span>{{ NUMBER_FORMAT_OPTIONS.find(o => o.value === numberFormat)?.label || 'System default' }}</span>
                <span class="material-icons form-dropdown-arrow">expand_more</span>
              </button>
              <div class="form-dropdown-list" v-if="openDropdown === 'numberFormat'">
                <div v-for="opt in NUMBER_FORMAT_OPTIONS" :key="opt.value"
                     class="form-dropdown-option" :class="{ selected: numberFormat === opt.value }"
                     @click="numberFormat = opt.value; saveNumberFormat(); openDropdown = null">{{ opt.label }}</div>
              </div>
            </div>
            <p style="font-size:13px;color:var(--color-text-secondary);margin-top:8px;">
              Controls how numbers are displayed (decimal and thousands separators). Currency symbol position is not affected.
            </p>
          </div>
        </div>

        <!-- Default Group -->
        <div class="card mb-16" v-if="groups && groups.length > 0" @click="openDropdown = null">
          <div class="card-header"><h3>Default Group</h3></div>
          <div class="card-body">
            <div class="form-dropdown" @click.stop>
              <button type="button" class="form-dropdown-trigger" @click="toggleDropdown('defaultGroup')">
                <span>{{ defaultGroupId ? (groups.find(g => g.id === defaultGroupId)?.name || '').replace('Valu: ', '') || 'Last used group' : 'Last used group' }}</span>
                <span class="material-icons form-dropdown-arrow">expand_more</span>
              </button>
              <div class="form-dropdown-list" v-if="openDropdown === 'defaultGroup'">
                <div class="form-dropdown-option" :class="{ selected: !defaultGroupId }"
                     @click="defaultGroupId = ''; saveDefaultGroup(); openDropdown = null">Last used group</div>
                <div v-for="g in groups" :key="g.id"
                     class="form-dropdown-option" :class="{ selected: defaultGroupId === g.id }"
                     @click="defaultGroupId = g.id; saveDefaultGroup(); openDropdown = null">{{ g.name.replace('Valu: ', '') }}</div>
              </div>
            </div>
            <p style="font-size:13px;color:var(--color-text-secondary);margin-top:8px;">
              The group to load when you open the app.
            </p>
          </div>
        </div>

        <!-- Balance Update Reminders -->
        <div class="card mb-16">
          <div class="card-header"><h3>Reminders</h3></div>
          <div class="card-body" style="padding:0;">
            <div class="list-item">
              <div class="list-item-content">
                <div class="list-item-title">Balance update reminders</div>
                <div class="list-item-subtitle">Show a reminder to update account balances each month</div>
              </div>
              <label class="toggle">
                <input type="checkbox" v-model="balanceReminders" @change="saveBalanceReminders" />
                <div class="toggle-track"></div>
                <div class="toggle-thumb"></div>
              </label>
            </div>
          </div>
        </div>

        <!-- Home Layout -->
        <div class="card mb-16">
          <div class="card-header"><h3><span class="material-icons" style="font-size:18px;vertical-align:text-bottom;margin-right:4px;">dashboard_customize</span>Home Layout</h3></div>
          <div class="card-body" style="padding:0;">
            <div v-for="(w, idx) in homeWidgets" :key="w.id" class="home-layout-item" :style="!isWidgetAvailable(w) ? { opacity: 0.45 } : {}">
              <span class="material-icons home-layout-icon">{{ w.icon }}</span>
              <div class="home-layout-label">
                <span>{{ w.label }}</span>
                <span v-if="!isWidgetAvailable(w)" class="home-layout-hint">Requires {{ w.requires.join(', ') }}</span>
              </div>
              <label class="toggle toggle-sm" @click.stop>
                <input type="checkbox" :checked="w.enabled" @change="toggleWidget(w.id)" />
                <div class="toggle-track"></div>
                <div class="toggle-thumb"></div>
              </label>
              <div class="home-layout-arrows">
                <button class="home-layout-arrow" :disabled="idx === 0" @click="moveWidget(w.id, -1)">
                  <span class="material-icons">keyboard_arrow_up</span>
                </button>
                <button class="home-layout-arrow" :disabled="idx === homeWidgets.length - 1" @click="moveWidget(w.id, 1)">
                  <span class="material-icons">keyboard_arrow_down</span>
                </button>
              </div>
            </div>
            <p style="font-size:12px;color:var(--color-text-hint);padding:8px 16px 12px;">
              Choose which widgets appear on the Home page and in what order.
            </p>
          </div>
        </div>

      </div>
      </div>
    </div>
  `,
};
