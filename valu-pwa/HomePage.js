import SheetsApi, { TABS, formatAccountDisplayName } from './sheetsApi.js';

const { ref, computed, watch, inject, nextTick } = Vue;

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

    const categoryIconMap = computed(() => {
      const map = {};
      for (const key of ['expenseCategories', 'incomeCategories']) {
        const str = props.settings?.[key] || '';
        str.split(',').filter(Boolean).forEach(c => {
          const idx = c.indexOf(':');
          if (idx > 0) map[c.slice(0, idx)] = c.slice(idx + 1);
        });
      }
      return map;
    });

    function getCategoryIcon(name) {
      return categoryIconMap.value[name] || '';
    }

    function convertToBase(amount, fromCurrency) {
      if (!fromCurrency || fromCurrency === baseCurrency.value) return amount;
      const rate = currencyRates.value[fromCurrency];
      return rate ? Math.round(amount * rate * 100) / 100 : amount;
    }

    function getNumberLocale() {
      const pref = localStorage.getItem('valu_number_format') || 'auto';
      return pref === 'auto' ? undefined : pref;
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

      const sortedMonths = Object.keys(monthMap).sort();
      const lastKnown = {};
      return sortedMonths
        .map(key => {
          const accs = monthMap[key];
          for (const a of activeIds) {
            if (accs[a.id] != null) lastKnown[a.id] = accs[a.id];
          }
          const total = activeIds.reduce((sum, a) => {
            const bal = accs[a.id] != null ? accs[a.id] : (lastKnown[a.id] || 0);
            return sum + convertToBase(bal, a.currency);
          }, 0);
          return { month: key, total };
        })
        .slice(-12);
    });

    const needsBalanceUpdate = computed(() => {
      if (localStorage.getItem('valu_balance_reminders') === 'false') return false;
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

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      return all
        .filter(tx => {
          if (!tx.date) return true;
          const [y, m, d] = tx.date.split('-').map(Number);
          return new Date(y, m - 1, d) <= today;
        })
        .sort((a, b) => {
          return (b.date || '').localeCompare(a.date || '');
        })
        .slice(0, 5);
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
        } else {
          expenses.value = [];
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
        } else {
          incomeList.value = [];
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
        } else {
          balanceHistory.value = [];
        }

        await Promise.all(promises);
      } catch (err) {
        if (err.message === 'popup_blocked' || err.message === 'refresh_failed') return;
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

    const onboardingDismissed = ref(localStorage.getItem('valu_onboarding_dismissed') === '1');
    const showOnboardingBanner = computed(() =>
      !props.isDemoGroup && !onboardingDismissed.value
    );
    function dismissOnboardingBanner() {
      onboardingDismissed.value = true;
      try { localStorage.setItem('valu_onboarding_dismissed', '1'); } catch (_) {}
    }

    // Auto-select the last month when chart data becomes available
    watch(netWorthHistory, (data) => {
      if (data.length > 0 && !selectedBar.value) {
        selectedBar.value = data[data.length - 1].month;
      }
    });

    // ── Yearly Balance Table ─────────────────────────────────────────────────
    const balanceTableYear = ref(new Date().getFullYear());

    const availableYears = computed(() => {
      const years = new Set(balanceHistory.value.map(h => h.year));
      return [...years].sort((a, b) => a - b);
    });

    const yearlyBalanceTable = computed(() => {
      const year = balanceTableYear.value;
      const activeAccounts = (props.accounts || [])
        .filter(a => a.discontinued !== 'true')
        .slice()
        .sort((a, b) => (parseInt(a.order) || 0) - (parseInt(b.order) || 0));

      const rows = activeAccounts.map(acc => {
        const months = [];
        for (let m = 1; m <= 12; m++) {
          const entry = balanceHistory.value.find(
            h => h.accountId === acc.id && h.year === year && h.month === m
          );
          months.push(entry !== undefined ? entry.balance : null);
        }
        return { id: acc.id, name: acc.name, currency: acc.currency || baseCurrency.value, months };
      });

      const totals = [];
      for (let m = 0; m < 12; m++) {
        let sum = 0;
        let hasAny = false;
        for (const row of rows) {
          if (row.months[m] !== null) {
            hasAny = true;
            sum += convertToBase(row.months[m], row.currency);
          }
        }
        totals.push(hasAny ? sum : null);
      }

      return { rows, totals };
    });

    const showBalanceTable = computed(() =>
      enabledLists.value.includes('accounts') && balanceHistory.value.length > 0
    );

    function prevYear() {
      const idx = availableYears.value.indexOf(balanceTableYear.value);
      if (idx > 0) balanceTableYear.value = availableYears.value[idx - 1];
    }
    function nextYear() {
      const idx = availableYears.value.indexOf(balanceTableYear.value);
      if (idx >= 0 && idx < availableYears.value.length - 1) balanceTableYear.value = availableYears.value[idx + 1];
    }
    const canPrevYear = computed(() => availableYears.value.indexOf(balanceTableYear.value) > 0);
    const canNextYear = computed(() => {
      const idx = availableYears.value.indexOf(balanceTableYear.value);
      return idx >= 0 && idx < availableYears.value.length - 1;
    });

    const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const balanceTooltip = ref(null);
    let tooltipTimer = null;
    function showNameTooltip(event, name) {
      clearTimeout(tooltipTimer);
      const rect = event.target.getBoundingClientRect();
      balanceTooltip.value = {
        text: name,
        top: rect.top - 6,
        left: rect.left + rect.width / 2,
      };
      tooltipTimer = setTimeout(() => { balanceTooltip.value = null; }, 2000);
    }
    function hideNameTooltip() {
      clearTimeout(tooltipTimer);
      balanceTooltip.value = null;
    }

    // ── Expense Category Table (yearly averages + chart) ─────────────────
    const EXP_CAT_COLORS = [
      '#5B8DB8','#E2725B','#F0C75E','#5AAD6E','#E8935A',
      '#6ECBDB','#8B6DB0','#E88B9C','#F5E16B','#5F9EA0',
      '#D4A574','#999999',
    ];

    const definedExpenseCategories = computed(() => {
      const str = props.settings?.expenseCategories || '';
      return str.split(',').filter(Boolean).map(c => {
        const idx = c.indexOf(':');
        return idx > 0 ? c.slice(0, idx) : c;
      });
    });

    const expCatTable = computed(() => {
      const currentYear = new Date().getFullYear();
      const yearsSet = new Set();
      const catYearTotals = {};

      for (const e of expenses.value) {
        if (!e.date) continue;
        const parts = e.date.split('-');
        const y = parseInt(parts[0]);
        if (y >= currentYear) continue;
        const cat = e.category || 'Uncategorized';
        const cur = getAccountCurrency(e.accountId);
        const base = convertToBase(e.amount, cur);
        yearsSet.add(y);
        if (!catYearTotals[cat]) catYearTotals[cat] = {};
        catYearTotals[cat][y] = (catYearTotals[cat][y] || 0) + base;
      }

      const years = [...yearsSet].sort((a, b) => a - b);
      const defined = definedExpenseCategories.value;

      const rows = Object.entries(catYearTotals)
        .map(([name, yearTotals]) => {
          const values = {};
          for (const y of years) {
            if (yearTotals[y] != null) {
              values[y] = Math.round((yearTotals[y] / 12) * 100) / 100;
            }
          }
          return { name, icon: categoryIconMap.value[name] || '', values };
        })
        .sort((a, b) => {
          const ai = defined.indexOf(a.name);
          const bi = defined.indexOf(b.name);
          if (ai >= 0 && bi >= 0) return ai - bi;
          if (ai >= 0) return -1;
          if (bi >= 0) return 1;
          return a.name.localeCompare(b.name);
        });

      const totals = {};
      for (const y of years) {
        let sum = 0;
        let hasAny = false;
        for (const row of rows) {
          if (row.values[y] != null) { hasAny = true; sum += row.values[y]; }
        }
        if (hasAny) totals[y] = Math.round(sum * 100) / 100;
      }

      return { years, rows, totals };
    });

    const expCatChartData = computed(() => {
      const t = expCatTable.value;
      if (!t.rows.length) return null;
      const maxTotal = Math.max(...t.years.map(y => t.totals[y] || 0), 1);
      const bars = t.years.map(y => {
        const segments = t.rows.map((row, i) => ({
          name: row.name,
          value: row.values[y] || 0,
          color: EXP_CAT_COLORS[i % EXP_CAT_COLORS.length],
        })).filter(s => s.value > 0);
        return { year: y, total: t.totals[y] || 0, segments };
      });
      const legendItems = t.rows.map((row, i) => ({
        name: row.name,
        color: EXP_CAT_COLORS[i % EXP_CAT_COLORS.length],
      }));
      return { bars, maxTotal, legendItems };
    });

    const showExpCatTable = computed(() =>
      enabledLists.value.includes('expenses') && expenses.value.length > 0
    );

    const expCatScrollRef = ref(null);
    watch(expCatScrollRef, (el) => {
      if (el) nextTick(() => { el.scrollLeft = el.scrollWidth; });
    });

    const categoryGoals = ref({});
    function loadCategoryGoals() {
      const goalsStr = props.settings?.expenseCategoryGoals || '';
      const map = {};
      goalsStr.split(',').filter(Boolean).forEach(g => {
        const idx = g.lastIndexOf(':');
        if (idx > 0) map[g.slice(0, idx)] = parseFloat(g.slice(idx + 1)) || 0;
      });
      categoryGoals.value = map;
    }
    loadCategoryGoals();
    watch(() => props.settings?.expenseCategoryGoals, loadCategoryGoals);

    const goalInputs = ref({});
    function initGoalInput(catName) {
      if (goalInputs.value[catName] === undefined) {
        const val = categoryGoals.value[catName];
        goalInputs.value[catName] = val != null ? String(val) : '';
      }
      return goalInputs.value[catName];
    }
    function updateGoalInput(catName, val) {
      goalInputs.value[catName] = val;
    }

    let goalSaveTimer = null;
    async function saveGoal(catName) {
      const raw = goalInputs.value[catName] || '';
      const val = parseFloat(raw.replace(',', '.'));
      if (!isNaN(val) && val >= 0) {
        categoryGoals.value[catName] = val;
      } else {
        delete categoryGoals.value[catName];
      }
      clearTimeout(goalSaveTimer);
      goalSaveTimer = setTimeout(async () => {
        const entries = Object.entries(categoryGoals.value)
          .filter(([, v]) => v >= 0)
          .map(([k, v]) => k + ':' + v);
        try {
          await SheetsApi.updateSetting(getSheetId(), 'expenseCategoryGoals', entries.join(','));
        } catch (err) {
          console.error('Failed to save goals:', err);
        }
      }, 800);
    }

    const goalTotal = computed(() => {
      const vals = Object.values(categoryGoals.value);
      if (vals.length === 0) return null;
      return Math.round(vals.reduce((s, v) => s + v, 0) * 100) / 100;
    });

    return {
      loading, enabledLists, baseCurrency, expenses, incomeList,
      monthlyExpenses, monthlyIncome, netWorth, netWorthHistory,
      recentTransactions, needsBalanceUpdate,
      prevMonthInfo, chartMax, selectedBar, selectedPoint, displayedBalance,
      chartWidth, chartHeight, chartPath, chartAreaPath,
      formatCurrency, formatDate, monthLabel, monthName, accountLabel, getCategoryIcon, getAccountCurrency,
      toggleBar, emit,
      showDemoWelcomeSheet, dismissDemoWelcome,
      showOnboarding, accountsNeedsData, incomeNeedsData, expensesNeedsData,
      showOnboardingBanner, dismissOnboardingBanner,
      balanceTableYear, availableYears, yearlyBalanceTable, showBalanceTable,
      prevYear, nextYear, canPrevYear, canNextYear, MONTH_ABBR,
      balanceTooltip, showNameTooltip, hideNameTooltip,
      expCatTable, showExpCatTable, expCatChartData, EXP_CAT_COLORS, expCatScrollRef,
      categoryGoals, goalTotal, goalInputs, initGoalInput, updateGoalInput, saveGoal,
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
        <!-- Onboarding summary banner -->
        <div v-if="showOnboardingBanner" class="card mb-16 onboarding-banner">
          <div class="onboarding-banner-body">
            <span class="material-icons onboarding-banner-icon">auto_awesome</span>
            <div class="onboarding-banner-content">
              <strong>Welcome to Valu</strong>
              <p>Your finances are stored privately in your Google Drive. Three tools are ready to go — Expenses, Income, and Accounts — with default categories already set up.</p>
              <div class="onboarding-banner-actions">
                <button class="btn-text-link" @click="emit('navigate', 'activity')">Read more</button>
                <button class="btn-text-link btn-text-muted" @click="dismissOnboardingBanner">Dismiss</button>
              </div>
            </div>
          </div>
        </div>

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
        <div class="card mb-16" v-if="(enabledLists.includes('expenses') && expenses.length > 0) || (enabledLists.includes('income') && incomeList.length > 0)">
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
            <!-- Savings Rate hidden for now -->
          </div>
        </div>

        <!-- Recent Transactions -->
        <div v-if="recentTransactions.length > 0" class="card mb-16">
          <div class="card-header"><h3>Recent Transactions</h3></div>
          <div style="padding:0;">
            <div v-for="tx in recentTransactions" :key="tx.id" class="list-item">
              <div class="list-item-icon"
                :style="{ background: tx.type === 'income' ? 'var(--color-primary-light)' : 'var(--color-expense-light, rgba(173,75,32,.1))', color: tx.type === 'income' ? 'var(--color-primary)' : 'var(--color-secondary)' }">
                <span class="material-icons">{{ getCategoryIcon(tx.category) || (tx.type === 'income' ? 'payments' : 'receipt') }}</span>
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
                  {{ (tx.type === 'income' ? tx.amount >= 0 : tx.amount < 0) ? '+' : '-' }}{{ formatCurrency(Math.abs(tx.amount), getAccountCurrency(tx.accountId)) }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Yearly Balance Table -->
        <div v-if="showBalanceTable" class="card mb-16">
          <div class="card-header">
            <h3>Balance Overview</h3>
            <div class="balance-table-year-nav">
              <button class="balance-table-year-arrow" :disabled="!canPrevYear" @click="prevYear">
                <span class="material-icons">chevron_left</span>
              </button>
              <span class="balance-table-year-label">{{ balanceTableYear }}</span>
              <button class="balance-table-year-arrow" :disabled="!canNextYear" @click="nextYear">
                <span class="material-icons">chevron_right</span>
              </button>
            </div>
          </div>
          <div class="balance-table-wrap">
            <table class="balance-table">
              <thead>
                <tr>
                  <th class="balance-table-sticky"></th>
                  <th v-for="m in MONTH_ABBR" :key="m">{{ m }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in yearlyBalanceTable.rows" :key="row.id">
                  <td class="balance-table-sticky balance-table-name"
                      :title="row.name"
                      @click="showNameTooltip($event, row.name)">{{ row.name }}</td>
                  <td v-for="(val, i) in row.months" :key="i"
                      :class="{ 'balance-table-empty': val === null }">
                    {{ val !== null ? formatCurrency(val, row.currency) : '--' }}
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr class="balance-table-total">
                  <td class="balance-table-sticky balance-table-name">Total</td>
                  <td v-for="(val, i) in yearlyBalanceTable.totals" :key="i"
                      :class="{ 'balance-table-empty': val === null }">
                    {{ val !== null ? formatCurrency(val, baseCurrency) : '--' }}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <div v-if="balanceTooltip" class="balance-table-tooltip"
             :style="{ top: balanceTooltip.top + 'px', left: balanceTooltip.left + 'px' }"
             @click="hideNameTooltip">{{ balanceTooltip.text }}</div>

        <!-- Expense Categories Table -->
        <div v-if="showExpCatTable" class="card mb-16">
          <div class="card-header"><h3>Average Monthly Expenses</h3></div>
          <div class="balance-table-wrap" ref="expCatScrollRef">
            <table class="balance-table">
              <thead>
                <tr>
                  <th class="balance-table-sticky"></th>
                  <th v-for="y in expCatTable.years" :key="y">{{ y }}</th>
                  <th>Goal</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, ri) in expCatTable.rows" :key="row.name">
                  <td class="balance-table-sticky balance-table-name"
                      :title="row.name"
                      @click="showNameTooltip($event, row.name)">
                    <span v-if="row.icon" class="material-icons" style="font-size:14px;vertical-align:middle;margin-right:3px;color:var(--color-primary);">{{ row.icon }}</span>{{ row.name }}
                  </td>
                  <td v-for="y in expCatTable.years" :key="y"
                      :class="{ 'balance-table-empty': row.values[y] == null }">
                    {{ row.values[y] != null ? formatCurrency(row.values[y], baseCurrency) : '--' }}
                  </td>
                  <td class="balance-table-goal-cell">
                    <input class="balance-table-goal-input"
                           :value="initGoalInput(row.name)"
                           @input="updateGoalInput(row.name, $event.target.value)"
                           @change="saveGoal(row.name)"
                           inputmode="decimal"
                           placeholder="—" />
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr class="balance-table-total">
                  <td class="balance-table-sticky balance-table-name">Total</td>
                  <td v-for="y in expCatTable.years" :key="y"
                      :class="{ 'balance-table-empty': expCatTable.totals[y] == null }">
                    {{ expCatTable.totals[y] != null ? formatCurrency(expCatTable.totals[y], baseCurrency) : '--' }}
                  </td>
                  <td class="balance-table-goal-cell" style="font-weight:600;">
                    {{ goalTotal != null ? formatCurrency(goalTotal, baseCurrency) : '' }}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div v-if="expCatChartData" class="expcat-chart">
            <div class="expcat-chart-bars">
              <div v-for="bar in expCatChartData.bars" :key="bar.year" class="expcat-chart-col">
                <div class="expcat-chart-bar" :style="{ height: Math.round(bar.total / expCatChartData.maxTotal * 180) + 'px' }">
                  <div v-for="(seg, si) in bar.segments" :key="si"
                       class="expcat-chart-seg"
                       :style="{ height: (seg.value / bar.total * 100) + '%', background: seg.color }"
                       :title="seg.name + ': ' + formatCurrency(seg.value, baseCurrency)">
                  </div>
                </div>
                <div class="expcat-chart-year">{{ bar.year }}</div>
              </div>
            </div>
            <div class="expcat-chart-legend">
              <span v-for="item in expCatChartData.legendItems" :key="item.name" class="expcat-chart-legend-item">
                <span class="expcat-chart-legend-dot" :style="{ background: item.color }"></span>
                {{ item.name }}
              </span>
            </div>
          </div>
        </div>

        <!-- Quick-start hints for empty tools -->
        <div v-if="showOnboarding && !isDemoGroup" class="onboarding">
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
