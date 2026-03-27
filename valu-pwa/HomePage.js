import SheetsApi, { TABS, formatAccountDisplayName } from './sheetsApi.js';

const { ref, computed, watch, inject } = Vue;

const DEMO_WELCOME_KEY = 'valu_demo_welcome_seen';

export default {
  props: ['sheetId', 'settings', 'groupName', 'accounts', 'isDemoGroup', 'demoCallout'],
  emits: ['navigate', 'refresh'],

  setup(props, { emit }) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    function getSheetId() { return props.sheetId || injectedSheetId.value; }

    const expenses = ref([]);
    const incomeList = ref([]);
    const balanceHistory = ref([]);
    const selectedBar = ref(null);
    const loading = ref(true);

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');

    const enabledLists = computed(() => {
      const str = props.settings?.listsEnabled || '';
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
        return amount.toFixed(2);
      }
    }

    function getAccountCurrency(accountId) {
      const acc = (props.accounts || []).find(a => a.id === accountId);
      return acc ? (acc.currency || baseCurrency.value) : baseCurrency.value;
    }

    // ── Computed widgets ────────────────────────────────────────────────────

    const currentMonth = computed(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });

    const prevMonthInfo = computed(() => {
      const now = new Date();
      const m = now.getMonth();
      const y = now.getFullYear();
      return m === 0
        ? { year: y - 1, month: 12 }
        : { year: y, month: m };
    });

    const monthlyExpenses = computed(() => {
      return expenses.value
        .filter(e => {
          if (!e.date) return false;
          const parts = e.date.split('-');
          return `${parts[0]}-${parts[1]}` === currentMonth.value;
        })
        .reduce((sum, e) => sum + convertToBase(e.amount, getAccountCurrency(e.accountId)), 0);
    });

    const monthlyIncome = computed(() => {
      return incomeList.value
        .filter(e => {
          if (!e.date) return false;
          const parts = e.date.split('-');
          return `${parts[0]}-${parts[1]}` === currentMonth.value;
        })
        .reduce((sum, e) => sum + convertToBase(e.amount, getAccountCurrency(e.accountId)), 0);
    });

    const netWorth = computed(() => {
      if (!enabledLists.value.includes('accounts')) return 0;
      return (props.accounts || [])
        .filter(a => a.discontinued !== 'true')
        .reduce((sum, a) => {
          const latest = balanceHistory.value
            .filter(h => h.accountId === a.id)
            .sort((x, y) => (y.year * 100 + y.month) - (x.year * 100 + x.month))[0];
          const bal = latest ? latest.balance : 0;
          return sum + convertToBase(bal, a.currency);
        }, 0);
    });

    const netWorthHistory = computed(() => {
      if (!enabledLists.value.includes('accounts')) return [];

      const monthMap = {};
      for (const h of balanceHistory.value) {
        const key = `${h.year}-${String(h.month).padStart(2, '0')}`;
        if (!monthMap[key]) monthMap[key] = {};
        monthMap[key][h.accountId] = h.balance;
      }

      const activeIds = (props.accounts || [])
        .filter(a => a.discontinued !== 'true')
        .map(a => ({ id: a.id, currency: a.currency || baseCurrency.value }));

      return Object.entries(monthMap)
        .map(([key, accs]) => {
          const total = activeIds.reduce((sum, a) => {
            const bal = accs[a.id] || 0;
            return sum + convertToBase(bal, a.currency);
          }, 0);
          return { month: key, total };
        })
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-12);
    });

    const needsBalanceUpdate = computed(() => {
      if (!enabledLists.value.includes('accounts')) return false;
      const activeAccounts = (props.accounts || []).filter(a => a.discontinued !== 'true');
      if (activeAccounts.length === 0) return false;
      const pm = prevMonthInfo.value;
      return activeAccounts.some(a =>
        !balanceHistory.value.find(
          h => h.accountId === a.id && h.year === pm.year && h.month === pm.month
        )
      );
    });

    const recentTransactions = computed(() => {
      const all = [];

      if (enabledLists.value.includes('expenses')) {
        for (const e of expenses.value) {
          all.push({ ...e, type: 'expense' });
        }
      }
      if (enabledLists.value.includes('income')) {
        for (const i of incomeList.value) {
          all.push({ ...i, type: 'income' });
        }
      }

      return all
        .sort((a, b) => {
          const da = a.date ? new Date(a.date) : new Date(0);
          const db = b.date ? new Date(b.date) : new Date(0);
          return db - da;
        })
        .slice(0, 5);
    });

    const savingsRate = computed(() => {
      if (monthlyIncome.value === 0) return null;
      return ((monthlyIncome.value - monthlyExpenses.value) / monthlyIncome.value * 100).toFixed(0);
    });

    // ── Net worth area chart (SVG) ──────────────────────────────────────────

    const chartWidth = 400;
    const chartHeight = 130;
    const chartPadTop = 8;
    const chartPadBottom = 4;
    const chartPadX = 16;

    const chartMin = computed(() => {
      if (netWorthHistory.value.length === 0) return 0;
      return Math.min(...netWorthHistory.value.map(h => h.total));
    });

    const chartMax = computed(() => {
      if (netWorthHistory.value.length === 0) return 1;
      return Math.max(...netWorthHistory.value.map(h => h.total), 1);
    });

    function getChartPoints() {
      const data = netWorthHistory.value;
      if (data.length < 2) return [];
      const range = chartMax.value - chartMin.value || 1;
      const usableH = chartHeight - chartPadTop - chartPadBottom;
      const usableW = chartWidth - chartPadX * 2;
      const stepX = usableW / (data.length - 1);

      return data.map((d, i) => ({
        x: chartPadX + i * stepX,
        y: chartPadTop + usableH - ((d.total - chartMin.value) / range) * usableH,
      }));
    }

    const chartPath = computed(() => {
      const points = getChartPoints();
      if (points.length < 2) return '';

      let path = `M ${points[0].x},${points[0].y}`;
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(i - 1, 0)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(i + 2, points.length - 1)];
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        path += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
      }
      return path;
    });

    const chartAreaPath = computed(() => {
      const points = getChartPoints();
      if (!chartPath.value || points.length < 2) return '';
      const lastPt = points[points.length - 1];
      const firstPt = points[0];
      return `${chartPath.value} L ${lastPt.x},${chartHeight} L ${firstPt.x},${chartHeight} Z`;
    });

    function toggleBar(monthKey) {
      selectedBar.value = monthKey;
    }

    const selectedPoint = computed(() => {
      if (!selectedBar.value) return null;
      const data = netWorthHistory.value;
      const idx = data.findIndex(d => d.month === selectedBar.value);
      if (idx < 0) return null;
      const points = getChartPoints();
      if (idx >= points.length) return null;
      return {
        x: points[idx].x,
        y: points[idx].y,
        total: data[idx].total,
      };
    });

    const displayedBalance = computed(() => {
      if (selectedPoint.value) return selectedPoint.value.total;
      return netWorth.value;
    });

    // ── Data fetching ───────────────────────────────────────────────────────

    async function fetchData() {
      const sheetId = getSheetId();
      if (!sheetId) {
        loading.value = false;
        return;
      }
      loading.value = true;

      try {
        const promises = [];

        if (enabledLists.value.includes('expenses')) {
          promises.push(
            SheetsApi.getTabData(sheetId, TABS.EXPENSES)
              .then(rows => {
                expenses.value = rows.map(r => ({
                  id: r[0], title: r[1], amount: parseFloat(r[2]) || 0,
                  accountId: r[3], category: r[4], date: r[5],
                  notes: r[6], createdAt: r[7],
                }));
              })
          );
        }

        if (enabledLists.value.includes('income')) {
          promises.push(
            SheetsApi.getTabData(sheetId, TABS.INCOME)
              .then(rows => {
                incomeList.value = rows.map(r => ({
                  id: r[0], title: r[1], amount: parseFloat(r[2]) || 0,
                  accountId: r[3], category: r[4], date: r[5],
                  notes: r[6], createdAt: r[7],
                }));
              })
          );
        }

        if (enabledLists.value.includes('accounts')) {
          promises.push(
            SheetsApi.getTabData(sheetId, TABS.BALANCE_HISTORY)
              .then(rows => {
                balanceHistory.value = rows.map(r => ({
                  accountId: r[0], year: parseInt(r[1]),
                  month: parseInt(r[2]), balance: parseFloat(r[3]) || 0,
                  updatedAt: r[4],
                }));
              })
          );
        }

        await Promise.all(promises);
      } catch (err) {
        if (err.message === 'popup_blocked') return;
        console.error('Failed to load home data:', err);
      } finally {
        loading.value = false;
      }
    }

    function formatDate(dateStr) {
      if (!dateStr) return '';
      const [y, m, d] = dateStr.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric',
      });
    }

    function monthLabel(monthStr) {
      const [y, m] = monthStr.split('-');
      return new Date(parseInt(y), parseInt(m) - 1).toLocaleString(undefined, { month: 'short' });
    }

    function monthName(m) {
      return new Date(2000, m - 1).toLocaleString(undefined, { month: 'long' });
    }

    function accountLabel(accountId) {
      if (!accountId) return '';
      const acc = (props.accounts || []).find(a => a.id === accountId);
      return acc ? formatAccountDisplayName(acc) : '';
    }

    watch(() => getSheetId(), () => { fetchData(); }, { immediate: true });
    watch(() => props.settings?.listsEnabled, () => { fetchData(); });

    const showDemoWelcomeSheet = ref(false);
    watch(
      () => props.isDemoGroup,
      (v) => {
        if (v && typeof sessionStorage !== 'undefined' && !sessionStorage.getItem(DEMO_WELCOME_KEY)) {
          showDemoWelcomeSheet.value = true;
        }
      },
      { immediate: true }
    );
    function dismissDemoWelcome() {
      showDemoWelcomeSheet.value = false;
      try {
        sessionStorage.setItem(DEMO_WELCOME_KEY, '1');
      } catch (_) {}
    }

    const accountsNeedsData = computed(() =>
      enabledLists.value.includes('accounts') && (props.accounts || []).length === 0
    );
    const incomeNeedsData = computed(() =>
      enabledLists.value.includes('income') && incomeList.value.length === 0
    );
    const expensesNeedsData = computed(() =>
      enabledLists.value.includes('expenses') && expenses.value.length === 0
    );

    const showOnboarding = computed(() =>
      !props.isDemoGroup
      && (accountsNeedsData.value || incomeNeedsData.value || expensesNeedsData.value)
    );

    // Auto-select the last month when chart data becomes available
    watch(netWorthHistory, (data) => {
      if (data.length > 0 && !selectedBar.value) {
        selectedBar.value = data[data.length - 1].month;
      }
    });

    return {
      loading, enabledLists, baseCurrency, expenses, incomeList,
      monthlyExpenses, monthlyIncome, netWorth, netWorthHistory,
      savingsRate, recentTransactions, needsBalanceUpdate,
      prevMonthInfo, chartMax, selectedBar, selectedPoint, displayedBalance,
      chartWidth, chartHeight, chartPath, chartAreaPath,
      formatCurrency, formatDate, monthLabel, monthName, accountLabel,
      toggleBar, emit,
      showDemoWelcomeSheet, dismissDemoWelcome,
      showOnboarding, accountsNeedsData, incomeNeedsData, expensesNeedsData,
    };
  },

  template: `
    <div class="page">
      <!-- Demo welcome bottom sheet (once per browser session) -->
      <div class="modal-overlay" :class="{ open: showDemoWelcomeSheet }" @click.self="dismissDemoWelcome">
        <div class="modal demo-welcome-modal">
          <div class="sheet-handle"></div>
          <div class="demo-welcome-body">
            <p class="demo-welcome-text"><strong class="demo-welcome-lead">Welcome!</strong> This Demo group is filled with dummy data to give you a quick idea what the interface looks like.</p>
            <button type="button" class="btn btn-primary demo-welcome-btn" @click="dismissDemoWelcome">Got it</button>
          </div>
        </div>
      </div>

      <!-- Signed-in prompt on demo (optional card could go here; index passes isDemoGroup) -->
      <div v-if="demoCallout === 'signin' && !showDemoWelcomeSheet" class="card mb-16 demo-signin-hint">
        <div class="list-item" style="cursor:default;">
          <div class="list-item-icon" style="background:var(--color-surface-alt);color:var(--color-text-secondary);">
            <span class="material-icons">lock</span>
          </div>
          <div class="list-item-content">
            <div class="list-item-title" style="color:var(--color-primary);font-weight:700;">Start your personal finance</div>
            <div class="list-item-subtitle">Sign in with Google to organize your own data in Drive. Demo changes are not saved.</div>
          </div>
        </div>
      </div>
      <div v-else-if="demoCallout === 'readonly' && !showDemoWelcomeSheet" class="card mb-16 demo-readonly-hint">
        <div class="list-item" style="cursor:default;">
          <div class="list-item-icon" style="background:var(--color-surface-alt);color:var(--color-primary);">
            <span class="material-icons">visibility</span>
          </div>
          <div class="list-item-content">
            <div class="list-item-title" style="font-weight:700;">Demo group</div>
            <div class="list-item-subtitle">Sample data for preview. Edits are not saved to any spreadsheet.</div>
          </div>
        </div>
      </div>

      <div v-if="loading" class="loading"><div class="spinner"></div>Loading...</div>

      <template v-else>
        <!-- Balance update reminder -->
        <div v-if="needsBalanceUpdate" class="banner banner-warning" @click="emit('navigate', 'accounts')" style="cursor:pointer;">
          <span class="material-icons">update</span>
          <div class="banner-content">
            Update your account balances for {{ monthName(prevMonthInfo.month) }} {{ prevMonthInfo.year }}
          </div>
          <span class="banner-action">Update</span>
        </div>

        <!-- Total Balance + Area Chart (no card boundary) -->
        <div v-if="enabledLists.includes('accounts') && (accounts || []).length > 0" class="balance-widget">
          <div class="stat">
            <div class="stat-label">Total balance</div>
            <div class="stat-value">{{ formatCurrency(displayedBalance, baseCurrency) }}</div>
          </div>

          <div v-if="netWorthHistory.length > 1" class="area-chart-wrap">
            <svg :viewBox="'0 0 ' + chartWidth + ' ' + chartHeight" preserveAspectRatio="none" class="area-chart-svg">
              <defs>
                <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--color-primary)" stop-opacity="0.35"/>
                  <stop offset="100%" stop-color="var(--color-primary)" stop-opacity="0.03"/>
                </linearGradient>
              </defs>
              <path :d="chartAreaPath" fill="url(#areaGrad)" />
              <path :d="chartPath" fill="none" stroke="var(--color-primary)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
              <template v-if="selectedPoint">
                <circle :cx="selectedPoint.x" :cy="selectedPoint.y" r="5" fill="var(--color-primary)" />
              </template>
            </svg>

            <div class="area-chart-labels">
              <div v-for="(h, i) in netWorthHistory" :key="h.month"
                   class="area-chart-label"
                   :class="{ active: selectedBar === h.month }"
                   @click="toggleBar(h.month)">
                <span class="area-chart-month">{{ monthLabel(h.month) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- This Month Stats -->
        <div class="card mb-16" v-if="expenses.length > 0 || incomeList.length > 0">
          <div class="card-header"><h3>This Month</h3></div>
          <div class="stats-row">
            <div class="stat" v-if="incomeList.length > 0">
              <div class="stat-value" style="font-size:20px;color:var(--color-primary);">
                {{ formatCurrency(monthlyIncome, baseCurrency) }}
              </div>
              <div class="stat-label">Income</div>
            </div>
            <div class="stat" v-if="expenses.length > 0">
              <div class="stat-value" style="font-size:20px;color:var(--color-secondary);">
                {{ formatCurrency(monthlyExpenses, baseCurrency) }}
              </div>
              <div class="stat-label">Expenses</div>
            </div>
            <div class="stat" v-if="incomeList.length > 0 && expenses.length > 0 && savingsRate !== null">
              <div class="stat-value" style="font-size:20px;" :style="{ color: savingsRate >= 0 ? 'var(--color-primary)' : 'var(--color-secondary)' }">
                {{ savingsRate }}%
              </div>
              <div class="stat-label">Savings Rate</div>
            </div>
          </div>
        </div>

        <!-- Recent Transactions -->
        <div v-if="recentTransactions.length > 0" class="card mb-16">
          <div class="card-header"><h3>Recent Transactions</h3></div>
          <div style="padding:0;">
            <div v-for="tx in recentTransactions" :key="tx.id" class="list-item">
              <div class="list-item-icon"
                :style="{ background: tx.type === 'income' ? 'var(--color-primary-light)' : 'rgba(173,75,32,.1)', color: tx.type === 'income' ? 'var(--color-primary)' : 'var(--color-secondary)' }">
                <span class="material-icons">{{ tx.type === 'income' ? 'payments' : 'receipt' }}</span>
              </div>
              <div class="list-item-content">
                <div class="list-item-title">{{ tx.title }}</div>
                <div class="list-item-subtitle">
                  {{ formatDate(tx.date) }}
                  <span v-if="tx.category"> · {{ tx.category }}</span>
                  <span v-if="accountLabel(tx.accountId)"> · {{ accountLabel(tx.accountId) }}</span>
                </div>
              </div>
              <div class="list-item-right">
                <div class="list-item-amount"
                     :style="{ color: tx.type === 'income' ? 'var(--color-primary)' : 'var(--color-secondary)' }">
                  {{ (tx.type === 'income' ? tx.amount >= 0 : tx.amount < 0) ? '+' : '-' }}{{ formatCurrency(Math.abs(tx.amount), baseCurrency) }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Onboarding: only shows enabled tools that still need data -->
        <div v-if="showOnboarding" class="onboarding">
          <button v-if="accountsNeedsData" type="button"
            class="onboarding-card onboarding-card--active"
            @click="emit('navigate', 'accounts')">
            <span class="material-icons onboarding-card-icon">account_balance</span>
            <div class="onboarding-card-text">
              <div class="onboarding-card-title">Bank account(s)</div>
              <div class="onboarding-card-desc">Add your first bank account.</div>
            </div>
          </button>

          <button v-if="incomeNeedsData" type="button"
            class="onboarding-card onboarding-card--active"
            @click="emit('navigate', 'income')">
            <span class="material-icons onboarding-card-icon">payments</span>
            <div class="onboarding-card-text">
              <div class="onboarding-card-title">Income</div>
              <div class="onboarding-card-desc">Log your first income entry.</div>
            </div>
          </button>

          <button v-if="expensesNeedsData" type="button"
            class="onboarding-card onboarding-card--active"
            @click="emit('navigate', 'expenses')">
            <span class="material-icons onboarding-card-icon">shopping_cart</span>
            <div class="onboarding-card-text">
              <div class="onboarding-card-title">Expenses</div>
              <div class="onboarding-card-desc">Log your first expense.</div>
            </div>
          </button>
        </div>
      </template>
    </div>
  `,
};
