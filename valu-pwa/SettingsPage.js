const { ref, computed, onMounted } = Vue;

export default {
  props: ['groups', 'activeGroup'],
  emits: ['go-home'],

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
      if (mode === 'dark') {
        root.setAttribute('data-theme', 'dark');
      } else if (mode === 'light') {
        root.setAttribute('data-theme', 'light');
      } else {
        root.removeAttribute('data-theme');
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

    function activeGroupName() {
      if (!defaultGroupId.value) return '';
      const g = (props.groups || []).find(g => g.id === defaultGroupId.value);
      return g ? g.name.replace('Valu: ', '') : '';
    }

    onMounted(() => {
      applyTheme(theme.value);
    });

    const openDropdown = ref(null);
    function toggleDropdown(name) {
      openDropdown.value = openDropdown.value === name ? null : name;
    }

    return {
      THEME_OPTIONS, NUMBER_FORMAT_OPTIONS, theme, numberFormat, defaultGroupId, balanceReminders,
      openDropdown, toggleDropdown,
      saveTheme, saveNumberFormat, saveDefaultGroup, saveBalanceReminders, activeGroupName,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
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

      <div class="subpage-header">
        <h1 class="subpage-title">Settings</h1>
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

        <!-- About -->
        <div class="card mb-16">
          <div class="card-header"><h3>About</h3></div>
          <div class="card-body">
            <p style="font-size:13px;color:var(--color-text-secondary);line-height:1.5;">
              Valu helps you organize your personal financial data, securely and privately. Your data is stored exclusively in your own Google Drive.
            </p>
            <p style="font-size:12px;color:var(--color-text-hint);margin-top:8px;">
              
            </p>
          </div>
        </div>

      </div>
      </div>
    </div>
  `,
};
