import SheetsApi, { TABS, formatAccountDisplayName } from './sheetsApi.js';
import { getPendingRecurring } from './recurringService.js';
import { getRate } from './fxService.js';

const { ref, computed, watch, inject, nextTick } = Vue;

const DEMO_WELCOME_KEY = 'valu_demo_welcome_seen';

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
  props: ['sheetId', 'settings', 'groupName', 'accounts', 'isDemoGroup', 'demoCallout'],
  emits: ['navigate', 'refresh'],

  setup(props, { emit }) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    function getSheetId() { return props.sheetId || injectedSheetId.value; }
    const installBanner = inject('installBanner', { installed: ref(true), install: () => {} });
    const installDismissedHome = ref(!!localStorage.getItem('valu_install_dismissed_home'));
    const widgetLayout = ref(loadWidgetLayout());
    const widgetOrder = computed(() => widgetLayout.value.filter(w => w.enabled));
    const showInstallCard = computed(() => !installBanner.installed.value && !installDismissedHome.value);
    function dismissInstallHome() {
      installDismissedHome.value = true;
      localStorage.setItem('valu_install_dismissed_home', '1');
    }

    const expenses = ref([]);
    const incomeList = ref([]);
    const balanceHistory = ref([]);
    const selectedBar = ref(null);
    const loading = ref(true);
    const lastUpdateInfo = ref(null);
    const pendingRecurring = ref([]);
    const pendingFxUpdates = ref([]);

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');

    const enabledLists = computed(() => {
      const str = props.settings?.listsEnabled || '';
      return str.split(',').filter(Boolean);
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
        .reduce((sum, e) => sum + e.amount, 0);
    });

    const monthlyIncome = computed(() => {
      return incomeList.value
        .filter(e => {
          if (!e.date) return false;
          const parts = e.date.split('-');
          return `${parts[0]}-${parts[1]}` === currentMonth.value;
        })
        .reduce((sum, e) => sum + e.amount, 0);
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
          return sum + bal;
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
            return sum + bal;
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
                  notes: r[6], createdAt: r[7], balanceAdjusted: r[8] || '', repeats: r[9] || '',
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
                  notes: r[6], createdAt: r[7], balanceAdjusted: r[8] || '', repeats: r[9] || '',
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

        promises.push(
          SheetsApi.getFileUpdateInfo(sheetId)
            .then(info => { lastUpdateInfo.value = info; })
            .catch(() => {})
        );

        await Promise.all(promises);
        pendingRecurring.value = getPendingRecurring(
          expenses.value, incomeList.value,
          props.settings?.repeatsLastChecked || ''
        );
        pendingFxUpdates.value = detectPendingFxUpdates(
          expenses.value, incomeList.value,
          props.settings?.fxLastRechecked || ''
        );
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
    const demoCalloutDismissed = ref(false);
    function dismissDemoCallout() { demoCalloutDismissed.value = true; }

    function dismissDemoWelcome() {
      showDemoWelcomeSheet.value = false;
      try {
        sessionStorage.setItem(DEMO_WELCOME_KEY, '1');
      } catch (_) {}
    }

    // ── Smart Insights (derived expenses from balance + income) ────────────

    const smartInsightsMode = computed(() =>
      enabledLists.value.includes('accounts')
      && enabledLists.value.includes('income')
      && !enabledLists.value.includes('expenses')
    );

    function getAccountType(accountId) {
      const acc = (props.accounts || []).find(a => a.id === accountId);
      return acc ? (acc.type || '') : '';
    }

    function cashFlowBalanceForMonth(ym) {
      const [y, m] = ym.split('-').map(Number);
      const cashAccounts = (props.accounts || [])
        .filter(a => a.discontinued !== 'true' && a.type !== 'Investment');
      const lastKnown = {};

      const sortedHistory = [...balanceHistory.value].sort((a, b) =>
        (a.year * 100 + a.month) - (b.year * 100 + b.month)
      );

      for (const h of sortedHistory) {
        if (h.year * 100 + h.month > y * 100 + m) break;
        if (getAccountType(h.accountId) === 'Investment') continue;
        lastKnown[h.accountId] = { balance: h.balance, currency: getAccountCurrency(h.accountId) };
      }

      return cashAccounts.reduce((sum, a) => {
        const info = lastKnown[a.id];
        if (!info) return sum;
        return sum + info.balance;
      }, 0);
    }

    function incomeForMonth(ym) {
      return incomeList.value
        .filter(e => e.date && e.date.slice(0, 7) === ym)
        .reduce((sum, e) => sum + e.amount, 0);
    }

    function prevYm(ym) {
      const [y, m] = ym.split('-').map(Number);
      if (m === 1) return `${y - 1}-12`;
      return `${y}-${String(m - 1).padStart(2, '0')}`;
    }

    function estimatedSpending(ym) {
      const inc = incomeForMonth(ym);
      const endBal = cashFlowBalanceForMonth(ym);
      const startBal = cashFlowBalanceForMonth(prevYm(ym));
      if (startBal === 0 && endBal === 0) return null;
      return Math.round((inc - (endBal - startBal)) * 100) / 100;
    }

    const smartInsightsData = computed(() => {
      if (!smartInsightsMode.value) return null;
      if (balanceHistory.value.length === 0 && incomeList.value.length === 0) return null;

      const now = new Date();
      const months = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }

      const points = months.map(ym => {
        const est = estimatedSpending(ym);
        const inc = incomeForMonth(ym);
        return { month: ym, estimatedSpending: est, income: inc };
      }).filter(p => p.estimatedSpending !== null);

      if (points.length === 0) return null;

      const current = points[points.length - 1];
      const prev = points.length >= 2 ? points[points.length - 2] : null;

      const validPoints = points.filter(p => p.estimatedSpending > 0);
      const avg = validPoints.length > 0
        ? Math.round(validPoints.reduce((s, p) => s + p.estimatedSpending, 0) / validPoints.length)
        : 0;

      const savingsRates = points.map(p => {
        if (!p.income || p.income <= 0) return { month: p.month, rate: null };
        const saved = p.income - Math.max(0, p.estimatedSpending);
        return { month: p.month, rate: Math.round(saved / p.income * 100) };
      });

      const currentSavingsRate = savingsRates.length > 0
        ? savingsRates[savingsRates.length - 1].rate
        : null;

      const trendChange = prev && prev.estimatedSpending > 0
        ? Math.round((current.estimatedSpending - prev.estimatedSpending) / prev.estimatedSpending * 100)
        : null;

      return {
        currentMonth: current,
        previousMonth: prev,
        average: avg,
        trendChange,
        savingsRate: currentSavingsRate,
        history: points,
        savingsRates,
      };
    });

    const siChartWidth = 360;
    const siChartHeight = 140;
    const siChartPad = { top: 8, bottom: 20, left: 8, right: 8 };

    const siChartPath = computed(() => {
      const d = smartInsightsData.value;
      if (!d || d.history.length < 2) return null;

      const pts = d.history;
      const maxVal = Math.max(...pts.map(p => Math.max(Math.abs(p.estimatedSpending), p.income || 0)));
      if (maxVal === 0) return null;

      const w = siChartWidth - siChartPad.left - siChartPad.right;
      const h = siChartHeight - siChartPad.top - siChartPad.bottom;
      const step = w / (pts.length - 1);

      const spendPts = pts.map((p, i) => ({
        x: siChartPad.left + i * step,
        y: siChartPad.top + h - (Math.max(0, p.estimatedSpending) / maxVal * h),
      }));
      const incomePts = pts.map((p, i) => ({
        x: siChartPad.left + i * step,
        y: siChartPad.top + h - ((p.income || 0) / maxVal * h),
      }));

      const line = points => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const area = points => {
        const bottom = siChartPad.top + h;
        return line(points) + ` L${points[points.length - 1].x.toFixed(1)},${bottom} L${points[0].x.toFixed(1)},${bottom} Z`;
      };

      return {
        spendLine: line(spendPts),
        spendArea: area(spendPts),
        incomeLine: line(incomePts),
        incomeArea: area(incomePts),
        labels: pts.map((p, i) => ({
          x: siChartPad.left + i * step,
          label: monthLabel(p.month),
        })),
      };
    });

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

    const lastUpdateLabel = computed(() => {
      const info = lastUpdateInfo.value;
      if (!info || !info.modifiedTime) return null;
      const d = new Date(info.modifiedTime);
      const timeStr = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const who = info.lastModifyingUser?.displayName || info.lastModifyingUser?.emailAddress || null;
      return who ? `${timeStr} by ${who}` : timeStr;
    });

    const onboardingDismissed = ref(localStorage.getItem('valu_onboarding_dismissed') === '1');
    const isDemo = computed(() => props.groupName === 'Demo');
    const showDemoNotice = computed(() =>
      isDemo.value && !showDemoWelcomeSheet.value && !demoCalloutDismissed.value
    );
    const showOnboardingBanner = computed(() =>
      !isDemo.value && !onboardingDismissed.value
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
            sum += row.months[m];
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

    const balanceTableScrollRef = ref(null);
    function scrollBalanceTable() {
      const el = balanceTableScrollRef.value;
      if (!el) return;
      nextTick(() => {
        if (balanceTableYear.value === new Date().getFullYear()) {
          const monthIdx = new Date().getMonth();
          const cells = el.querySelectorAll('thead th');
          if (cells[monthIdx + 1]) {
            const cellLeft = cells[monthIdx + 1].offsetLeft;
            const stickyWidth = cells[0] ? cells[0].offsetWidth : 0;
            el.scrollLeft = cellLeft - stickyWidth - 8;
          }
        } else {
          el.scrollLeft = el.scrollWidth;
        }
      });
    }
    watch(balanceTableScrollRef, (el) => { if (el) scrollBalanceTable(); });
    watch(balanceTableYear, () => scrollBalanceTable());

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
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const completedMonths = Math.max(currentMonth - 1, 1);
      const yearsSet = new Set();
      const catYearTotals = {};

      for (const e of expenses.value) {
        if (!e.date) continue;
        const parts = e.date.split('-');
        const y = parseInt(parts[0]);
        const m = parseInt(parts[1]);
        if (y === currentYear && m >= currentMonth) continue;
        const cat = e.category || 'Uncategorized';
        const base = e.amount;
        yearsSet.add(y);
        if (!catYearTotals[cat]) catYearTotals[cat] = {};
        catYearTotals[cat][y] = (catYearTotals[cat][y] || 0) + base;
      }

      let years = [...yearsSet].sort((a, b) => a - b);
      const hasPriorYears = years.some(y => y < currentYear);
      if (hasPriorYears) years = years.filter(y => y !== currentYear);
      const defined = definedExpenseCategories.value;

      const rows = Object.entries(catYearTotals)
        .map(([name, yearTotals]) => {
          const values = {};
          for (const y of years) {
            if (yearTotals[y] != null) {
              const divisor = y === currentYear ? completedMonths : 12;
              values[y] = Math.round((yearTotals[y] / divisor) * 100) / 100;
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

    // ── Recurring transactions review ───────────────────────────────────────
    const showRecurringReview = ref(false);
    const recurringApplying = ref(false);

    function toggleRecurringItem(idx) {
      if (!pendingRecurring.value.length) return;
      pendingRecurring.value[idx].checked = !pendingRecurring.value[idx].checked;
    }

    const FX_TAG_RE = /\s*\(([A-Z]{3})\s+([\d.,]+)\)\s*$/;

    function parseFxTag(notes) {
      const match = (notes || '').match(FX_TAG_RE);
      if (!match) return null;
      const amount = parseFloat(match[2].replace(/,/g, ''));
      if (isNaN(amount)) return null;
      return { currency: match[1], amount };
    }

    function detectDuplicates(pendingItems) {
      const allItems = [...expenses.value, ...incomeList.value];
      for (const item of pendingItems) {
        item.isDuplicate = allItems.some(existing =>
          existing.title === item.title &&
          existing.date === item.newDate &&
          existing.amount === item.amount &&
          existing.id !== item.sourceId
        );
        if (item.isDuplicate) item.checked = false;
      }
    }

    async function openRecurringReview() {
      showRecurringReview.value = true;
      detectDuplicates(pendingRecurring.value);
      const updates = pendingRecurring.value.map(async (item) => {
        const fx = parseFxTag(item.notes);
        if (!fx) return;
        const result = await getRate(fx.currency, baseCurrency.value, item.newDate);
        if (!result.error && result.rate) {
          item.amount = Math.round(fx.amount * result.rate * 100) / 100;
          item.fxConverted = true;
        }
      });
      await Promise.all(updates);
    }

    async function applyRecurring() {
      const items = pendingRecurring.value.filter(i => i.checked);
      if (!items.length) {
        await dismissRecurring();
        return;
      }
      recurringApplying.value = true;
      try {
        for (const item of items) {
          const id = SheetsApi.generateId();
          const now = new Date().toISOString();
          const tab = item.type === 'expense' ? TABS.EXPENSES : TABS.INCOME;
          let amount = item.amount;
          let notes = item.notes || '';

          const fx = parseFxTag(notes);
          if (fx) {
            const result = await getRate(fx.currency, baseCurrency.value, item.newDate);
            if (!result.error && result.rate) {
              amount = Math.round(fx.amount * result.rate * 100) / 100;
            }
          }

          await SheetsApi.appendRow(getSheetId(), tab, [
            id, item.title, amount.toString(), item.accountId,
            item.category, item.newDate, notes, now, '', item.repeats || '',
          ]);
        }
        await SheetsApi.updateSetting(getSheetId(), 'repeatsLastChecked', new Date().toISOString());
        showRecurringReview.value = false;
        pendingRecurring.value = [];
        emit('refresh');
      } catch (err) {
        console.error('Failed to apply recurring items:', err);
      } finally {
        recurringApplying.value = false;
      }
    }

    async function dismissRecurring() {
      try {
        await SheetsApi.updateSetting(getSheetId(), 'repeatsLastChecked', new Date().toISOString());
        showRecurringReview.value = false;
        pendingRecurring.value = [];
      } catch (err) {
        console.error('Failed to dismiss recurring:', err);
      }
    }

    // ── FX recheck for upcoming items that reached their date ────────────
    const showFxReview = ref(false);
    const fxApplying = ref(false);

    function todayISO() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function detectPendingFxUpdates(expenseList, incomeItems, lastRechecked) {
      const today = todayISO();
      const items = [];
      function scan(list, type) {
        for (const item of list) {
          if (!item.notes || !item.date || !item.createdAt) continue;
          const fx = parseFxTag(item.notes);
          if (!fx) continue;
          if (item.date > today) continue;
          if (item.createdAt.slice(0, 10) >= item.date) continue;
          if (lastRechecked && item.date <= lastRechecked.slice(0, 10)) continue;
          items.push({ ...item, type, fx, checked: true, oldAmount: item.amount });
        }
      }
      scan(expenseList, 'expense');
      scan(incomeItems, 'income');
      items.sort((a, b) => a.date.localeCompare(b.date));
      return items;
    }

    function toggleFxItem(idx) {
      if (!pendingFxUpdates.value.length) return;
      pendingFxUpdates.value[idx].checked = !pendingFxUpdates.value[idx].checked;
    }

    async function openFxReview() {
      showFxReview.value = true;
      const updates = pendingFxUpdates.value.map(async (item) => {
        const result = await getRate(item.fx.currency, baseCurrency.value, item.date);
        if (!result.error && result.rate) {
          item.newAmount = Math.round(item.fx.amount * result.rate * 100) / 100;
        }
      });
      await Promise.all(updates);
    }

    async function applyFxUpdates() {
      const items = pendingFxUpdates.value.filter(i => i.checked && i.newAmount != null);
      if (!items.length) {
        await dismissFxUpdates();
        return;
      }
      fxApplying.value = true;
      try {
        for (const item of items) {
          const tab = item.type === 'expense' ? TABS.EXPENSES : TABS.INCOME;
          await SheetsApi.updateRow(getSheetId(), tab, item.id, [
            item.id, item.title, item.newAmount.toString(), item.accountId,
            item.category, item.date, item.notes, item.createdAt,
            item.balanceAdjusted || '', item.repeats || '',
          ]);
        }
        await SheetsApi.updateSetting(getSheetId(), 'fxLastRechecked', new Date().toISOString());
        showFxReview.value = false;
        pendingFxUpdates.value = [];
        emit('refresh');
      } catch (err) {
        console.error('Failed to apply FX updates:', err);
      } finally {
        fxApplying.value = false;
      }
    }

    async function dismissFxUpdates() {
      try {
        await SheetsApi.updateSetting(getSheetId(), 'fxLastRechecked', new Date().toISOString());
        showFxReview.value = false;
        pendingFxUpdates.value = [];
      } catch (err) {
        console.error('Failed to dismiss FX updates:', err);
      }
    }

    return {
      loading, enabledLists, baseCurrency, expenses, incomeList,
      monthlyExpenses, monthlyIncome, netWorth, netWorthHistory,
      recentTransactions, needsBalanceUpdate,
      prevMonthInfo, chartMax, selectedBar, selectedPoint, displayedBalance,
      chartWidth, chartHeight, chartPath, chartAreaPath,
      formatCurrency, formatDate, monthLabel, monthName, accountLabel, getCategoryIcon, getAccountCurrency,
      toggleBar, emit,
      showDemoWelcomeSheet, dismissDemoWelcome, showDemoNotice, demoCalloutDismissed, dismissDemoCallout, lastUpdateLabel,
      smartInsightsMode, smartInsightsData, siChartWidth, siChartHeight, siChartPath,
      showOnboarding, accountsNeedsData, incomeNeedsData, expensesNeedsData,
      showOnboardingBanner, dismissOnboardingBanner,
      balanceTableYear, availableYears, yearlyBalanceTable, showBalanceTable,
      prevYear, nextYear, canPrevYear, canNextYear, MONTH_ABBR, balanceTableScrollRef,
      balanceTooltip, showNameTooltip, hideNameTooltip,
      expCatTable, showExpCatTable, expCatChartData, EXP_CAT_COLORS, expCatScrollRef,
      categoryGoals, goalTotal, goalInputs, initGoalInput, updateGoalInput, saveGoal,
      showInstallCard, installBanner, dismissInstallHome,
      pendingRecurring, showRecurringReview, recurringApplying, toggleRecurringItem, openRecurringReview, applyRecurring, dismissRecurring,
      pendingFxUpdates, showFxReview, fxApplying, toggleFxItem, openFxReview, applyFxUpdates, dismissFxUpdates,
      widgetOrder,
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
            <p class="demo-welcome-text" style="font-size:12px;color:var(--color-text-secondary);margin-top:8px;">Try disabling Expenses in Groups → Demo to see <strong>Smart Insights</strong> — Valu estimates your spending from balance changes and income alone.</p>
            <button type="button" class="btn btn-primary demo-welcome-btn" @click="dismissDemoWelcome">Got it</button>
          </div>
        </div>
      </div>

      <!-- Demo data persistence notice (dismissable) -->
      <div v-if="groupName === 'Demo' && !showDemoWelcomeSheet && !demoCalloutDismissed" class="demo-notice mb-16">
        <button class="demo-notice-close" @click="dismissDemoCallout" aria-label="Dismiss">
          <span class="material-icons">close</span>
        </button>
        <div class="demo-notice-body">
          <span class="material-icons demo-notice-icon">info</span>
          <div>
            <strong>You're viewing demo data</strong>
            <p>This group is pre-filled with sample data so you can explore the app. Any changes you make here (adding entries, editing categories, etc.) are temporary and will not be saved.</p>
            <p v-if="demoCallout === 'signin'" style="margin-top:6px;">
              <strong>Ready to start for real?</strong> Sign in with Google to create your own group — your data will be stored privately in your Drive.
            </p>
          </div>
        </div>
      </div>

      <div v-if="loading" class="loading"><div class="spinner"></div>Loading...</div>

      <template v-else>
        <!-- Onboarding summary banner (never for demo) -->
        <div v-if="groupName !== 'Demo' && showOnboardingBanner" class="card mb-16 onboarding-banner">
          <div class="onboarding-banner-body">
            <span class="material-icons onboarding-banner-icon">auto_awesome</span>
            <div class="onboarding-banner-content">
              <strong>Welcome to Valu</strong>
              <p>Your finances are stored privately in your Google Drive. Three tools are ready to go — Expenses, Income, and Accounts — with default categories already set up.<br><br>Need help? Tap the orb in the top-right to open the Valu assistant.</p>
              <div class="onboarding-banner-actions">
                <button class="btn-text-link" @click="emit('navigate', 'activity')">Read more</button>
                <button class="btn-text-link btn-text-muted" @click="dismissOnboardingBanner">Dismiss</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Install app card -->
        <div v-if="showInstallCard" class="card mb-16 install-card">
          <div class="install-card-body">
            <span class="material-icons install-card-icon">download</span>
            <div class="install-card-content">
              <strong>Install Valu</strong>
              <span>Add to your home screen for the best experience — fast access, works offline.</span>
            </div>
          </div>
          <div class="install-card-actions">
            <button class="btn btn-text btn-sm" @click="dismissInstallHome()">Not now</button>
            <button class="btn btn-primary btn-sm" @click="installBanner.install()">Install</button>
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

        <!-- Recurring transactions reminder -->
        <div v-if="pendingRecurring && pendingRecurring.length" class="banner banner-info" style="cursor:pointer;" @click="openRecurringReview()">
          <span class="material-icons">repeat</span>
          <div class="banner-content">
            {{ pendingRecurring.length }} recurring item(s) ready to apply
          </div>
          <span class="banner-action">Review</span>
          <span class="material-icons banner-dismiss" @click.stop="dismissRecurring">close</span>
        </div>

        <!-- FX rate update reminder -->
        <div v-if="pendingFxUpdates && pendingFxUpdates.length" class="banner banner-info" style="cursor:pointer;" @click="openFxReview()">
          <span class="material-icons">currency_exchange</span>
          <div class="banner-content">
            {{ pendingFxUpdates.length }} item(s) need exchange rate update
          </div>
          <span class="banner-action">Review</span>
          <span class="material-icons banner-dismiss" @click.stop="dismissFxUpdates">close</span>
        </div>

        <template v-for="w in widgetOrder" :key="w.id">
        <!-- Total Balance + Area Chart -->
        <div v-if="w.id === 'totalBalance' && enabledLists.includes('accounts') && (accounts || []).length > 0" class="balance-widget">
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

        <!-- This Month Stats / Smart Insights -->
        <template v-if="w.id === 'thisMonth'">
        <div class="card mb-16" v-if="!smartInsightsMode && ((enabledLists.includes('expenses') && expenses.length > 0) || (enabledLists.includes('income') && incomeList.length > 0))">
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
          </div>
        </div>

        <div v-if="smartInsightsMode && smartInsightsData" class="card mb-16 smart-insights-card">
          <div class="card-header">
            <h3><span class="material-icons" style="font-size:18px;vertical-align:text-bottom;margin-right:4px;color:var(--color-primary);">auto_awesome</span>Smart Insights</h3>
          </div>
          <p class="smart-insights-desc">Based on your account balances and income — no expense logging needed.</p>

          <div class="stats-row">
            <div class="stat">
              <div class="stat-value" style="font-size:20px;color:var(--color-primary);">
                {{ formatCurrency(smartInsightsData.currentMonth.income, baseCurrency) }}
              </div>
              <div class="stat-label">Income</div>
            </div>
            <div class="stat">
              <div class="stat-value" style="font-size:20px;color:var(--color-secondary);">
                {{ formatCurrency(Math.max(0, smartInsightsData.currentMonth.estimatedSpending), baseCurrency) }}
              </div>
              <div class="stat-label">Est. spending</div>
            </div>
            <div v-if="smartInsightsData.savingsRate != null" class="stat">
              <div class="stat-value" style="font-size:20px;"
                   :style="{ color: smartInsightsData.savingsRate >= 0 ? 'var(--color-primary)' : 'var(--color-secondary)' }">
                {{ smartInsightsData.savingsRate }}%
              </div>
              <div class="stat-label">Savings rate</div>
            </div>
          </div>

          <div v-if="smartInsightsData.trendChange != null" class="smart-insights-trend">
            <span class="material-icons" style="font-size:16px;vertical-align:middle;">
              {{ smartInsightsData.trendChange > 0 ? 'trending_up' : smartInsightsData.trendChange < 0 ? 'trending_down' : 'trending_flat' }}
            </span>
            <span v-if="smartInsightsData.trendChange > 0">Estimated spending is <strong>{{ smartInsightsData.trendChange }}% higher</strong> than last month</span>
            <span v-else-if="smartInsightsData.trendChange < 0">Estimated spending is <strong>{{ Math.abs(smartInsightsData.trendChange) }}% lower</strong> than last month</span>
            <span v-else>Spending is about the same as last month</span>
          </div>
        </div>
        <div v-else-if="smartInsightsMode && !smartInsightsData" class="card mb-16 smart-insights-card" style="opacity:0.7;">
          <div class="card-header">
            <h3><span class="material-icons" style="font-size:18px;vertical-align:text-bottom;margin-right:4px;color:var(--color-primary);">auto_awesome</span>Smart Insights</h3>
          </div>
          <p class="smart-insights-desc" style="padding-bottom:8px;">Smart Insights will appear here once you have at least one month of account balance history and some income logged. Keep tracking to unlock spending estimates, savings rate, and trends.</p>
        </div>

        <div v-if="smartInsightsMode && siChartPath" class="card mb-16">
          <div class="card-header"><h3>Income vs Estimated Spending</h3></div>
          <div style="padding:4px 0 0;">
            <svg :width="siChartWidth" :height="siChartHeight" :viewBox="'0 0 ' + siChartWidth + ' ' + siChartHeight" style="width:100%;display:block;">
              <path :d="siChartPath.incomeArea" fill="var(--color-primary)" opacity="0.10" />
              <path :d="siChartPath.incomeLine" fill="none" stroke="var(--color-primary)" stroke-width="2" />
              <path :d="siChartPath.spendArea" fill="var(--color-secondary)" opacity="0.10" />
              <path :d="siChartPath.spendLine" fill="none" stroke="var(--color-secondary)" stroke-width="2" />
            </svg>
            <div class="si-chart-labels">
              <span v-for="lbl in siChartPath.labels" :key="lbl.label" class="si-chart-label">{{ lbl.label }}</span>
            </div>
            <div class="si-chart-legend">
              <span class="si-chart-legend-item"><span class="si-chart-legend-dot" style="background:var(--color-primary);"></span>Income</span>
              <span class="si-chart-legend-item"><span class="si-chart-legend-dot" style="background:var(--color-secondary);"></span>Est. spending</span>
            </div>
          </div>
        </div>

        <div v-if="smartInsightsMode && smartInsightsData && smartInsightsData.history.length > 1" class="card mb-16">
          <div class="card-header"><h3>Monthly Breakdown</h3></div>
          <div class="balance-table-wrap">
            <table class="balance-table">
              <thead>
                <tr>
                  <th class="balance-table-sticky">Month</th>
                  <th>Income</th>
                  <th>Est. Spending</th>
                  <th>Saved</th>
                  <th>Rate</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in smartInsightsData.history.slice().reverse()" :key="row.month">
                  <td class="balance-table-sticky balance-table-name">{{ monthLabel(row.month) }} {{ row.month.split('-')[0] }}</td>
                  <td>{{ formatCurrency(row.income, baseCurrency) }}</td>
                  <td>{{ formatCurrency(Math.max(0, row.estimatedSpending), baseCurrency) }}</td>
                  <td :style="{ color: row.income - Math.max(0, row.estimatedSpending) >= 0 ? 'var(--color-primary)' : 'var(--color-secondary)' }">
                    {{ formatCurrency(row.income - Math.max(0, row.estimatedSpending), baseCurrency) }}
                  </td>
                  <td>{{ row.income > 0 ? Math.round((row.income - Math.max(0, row.estimatedSpending)) / row.income * 100) + '%' : '--' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        </template>

        <!-- Recent Transactions -->
        <div v-if="w.id === 'recentTransactions' && recentTransactions.length > 0" class="card mb-16">
          <div class="card-header"><h3>Recent Transactions</h3></div>
          <div style="padding:0;">
            <div v-for="tx in recentTransactions" :key="tx.id" class="list-item" style="cursor:pointer;" @click="emit('navigate', tx.type === 'income' ? 'income' : 'expenses')">
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
                  {{ (tx.type === 'income' ? tx.amount >= 0 : tx.amount < 0) ? '+' : '-' }}{{ formatCurrency(Math.abs(tx.amount), baseCurrency) }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Balance Overview -->
        <template v-if="w.id === 'balanceOverview' && showBalanceTable">
        <div class="card mb-16">
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
          <div class="balance-table-wrap" ref="balanceTableScrollRef">
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
        </template>

        <!-- Expense Categories -->
        <div v-if="w.id === 'expenseCategories' && showExpCatTable" id="expense-goals" class="card mb-16">
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
        </template>

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

        <div v-if="lastUpdateLabel" class="home-last-update">
          <span class="material-icons home-last-update-icon">sync</span>
          Last updated {{ lastUpdateLabel }}
        </div>
      </template>

      <!-- Recurring review modal -->
      <div class="modal-overlay" :class="{ open: showRecurringReview }" @click.self="showRecurringReview = false">
        <div class="modal" v-if="showRecurringReview">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Recurring Items</h2>
            <button class="btn-icon" @click="showRecurringReview = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="max-height:50vh;overflow-y:auto;">
            <p style="color:var(--text-secondary);font-size:13px;margin:0 0 12px;">
              Select items to apply, then confirm.
            </p>
            <div v-for="(item, idx) in pendingRecurring" :key="idx"
              class="recurring-review-item" :style="item.isDuplicate ? { opacity: 0.6 } : {}" @click="toggleRecurringItem(idx)">
              <span class="material-icons" style="font-size:22px;margin-right:8px;color:var(--primary);">
                {{ item.checked ? 'check_box' : 'check_box_outline_blank' }}
              </span>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:500;font-size:14px;">{{ item.title }}</div>
                <div style="font-size:12px;color:var(--text-secondary);">
                  {{ item.type === 'expense' ? '−' : '+' }}{{ formatCurrency(item.amount, baseCurrency) }}
                  <template v-if="item.fxConverted">
                    <span class="material-icons" style="font-size:12px;vertical-align:middle;">currency_exchange</span>
                  </template>
                  &middot; {{ item.newDate }}
                  &middot; {{ item.sourceLabel }}
                </div>
                <div v-if="item.isDuplicate" style="font-size:11px;color:var(--color-warning);margin-top:2px;">
                  <span class="material-icons" style="font-size:13px;vertical-align:middle;margin-right:2px;">warning</span>
                  Possible duplicate — a similar entry already exists this month
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer" style="display:flex;gap:8px;">
            <button class="btn btn-text" @click="showRecurringReview = false" style="flex:1;">Cancel</button>
            <button class="btn-sheet-cta" @click="applyRecurring" :disabled="recurringApplying" style="flex:2;">
              {{ recurringApplying ? 'Applying...' : 'Apply selected' }}
            </button>
          </div>
        </div>
      </div>

      <!-- FX rate update review modal -->
      <div class="modal-overlay" :class="{ open: showFxReview }" @click.self="showFxReview = false">
        <div class="modal" v-if="showFxReview">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Exchange Rate Updates</h2>
            <button class="btn-icon" @click="showFxReview = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="max-height:50vh;overflow-y:auto;">
            <p style="color:var(--text-secondary);font-size:13px;margin:0 0 12px;">
              These upcoming items have reached their date. Select items to update with the correct exchange rate.
            </p>
            <div v-for="(item, idx) in pendingFxUpdates" :key="idx"
              class="recurring-review-item" @click="toggleFxItem(idx)">
              <span class="material-icons" style="font-size:22px;margin-right:8px;color:var(--primary);">
                {{ item.checked ? 'check_box' : 'check_box_outline_blank' }}
              </span>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:500;font-size:14px;">{{ item.title }}</div>
                <div style="font-size:12px;color:var(--text-secondary);">
                  {{ item.fx.currency }} {{ item.fx.amount.toFixed(2) }}
                  &middot; {{ item.date }}
                </div>
                <div v-if="item.newAmount != null" style="font-size:12px;">
                  <span style="color:var(--text-secondary);text-decoration:line-through;">{{ formatCurrency(item.oldAmount, baseCurrency) }}</span>
                  <span class="material-icons" style="font-size:12px;vertical-align:middle;margin:0 2px;">arrow_forward</span>
                  <span style="color:var(--color-primary);font-weight:600;">{{ formatCurrency(item.newAmount, baseCurrency) }}</span>
                </div>
                <div v-else style="font-size:12px;color:var(--text-secondary);">
                  Loading rate…
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer" style="display:flex;gap:8px;">
            <button class="btn btn-text" @click="showFxReview = false" style="flex:1;">Cancel</button>
            <button class="btn-sheet-cta" @click="applyFxUpdates" :disabled="fxApplying" style="flex:2;">
              {{ fxApplying ? 'Updating...' : 'Update selected' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
};
