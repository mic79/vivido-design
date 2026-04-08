import SheetsApi, { TABS, DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES } from './sheetsApi.js';
import { getCurrentYM, getPendingRecurring } from './recurringService.js';

const { ref, computed, watch, inject } = Vue;

const EXPENSE_CAT_DESCRIPTIONS = {
  'Housing': 'Rent/mortgage, property taxes, home insurance, maintenance.',
  'Food': 'Groceries, household supplies.',
  'Transportation': 'Fuel, public transit, car insurance, maintenance, parking.',
  'Utilities': 'Electricity, water, gas, internet, phone.',
  'Healthcare': 'Insurance premiums, copays, prescriptions, gym memberships.',
  'Debt Payments': 'Student loans, credit card payments, personal loans.',
  'Personal Care': 'Clothing, haircuts, cosmetics.',
  'Leisure': 'Dining out, entertainment, streaming services, hobbies.',
  'Miscellaneous': 'Gifts, charitable donations, subscriptions.',
};

const INCOME_CAT_DESCRIPTIONS = {
  'Primary Salary/Wages': 'Regular income from employment.',
  'Bonuses & Commission': 'Additional performance-based income.',
  'Investment Income': 'Dividends, interest, capital gains.',
  'Side Hustles/Freelance': 'Extra work income.',
  'Other Income': 'Tax refunds, child support, rental income, or gift money.',
};

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export default {
  props: ['sheetId', 'settings', 'groupName', 'accounts'],
  emits: ['go-home', 'navigate'],

  setup(props, { emit }) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    const installBanner = inject('installBanner', { installed: ref(true), install: () => {} });
    function getSheetId() { return props.sheetId || injectedSheetId.value; }

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');
    const enabledLists = computed(() => (props.settings?.listsEnabled || '').split(',').filter(Boolean));
    const onboardingCollapsed = ref(localStorage.getItem('valu_onboarding_dismissed') === '1');

    const expenses = ref([]);
    const incomeList = ref([]);
    const loading = ref(false);

    function formatCurrency(amount, currency) {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', currencyDisplay: 'narrowSymbol' }).format(amount);
      } catch { return amount.toFixed(2); }
    }

    async function fetchData() {
      const sid = getSheetId();
      if (!sid) return;
      loading.value = true;
      try {
        const [expRows, incRows] = await Promise.all([
          enabledLists.value.includes('expenses') ? SheetsApi.getValues(sid, `${TABS.EXPENSES}!A2:J`) : [],
          enabledLists.value.includes('income') ? SheetsApi.getValues(sid, `${TABS.INCOME}!A2:J`) : [],
        ]);
        expenses.value = (expRows || []).map(r => ({
          id: r[0], title: r[1], amount: parseFloat(r[2]) || 0,
          accountId: r[3], category: r[4], date: r[5], notes: r[6],
          createdAt: r[7] || '', repeats: r[9] || '',
        }));
        incomeList.value = (incRows || []).map(r => ({
          id: r[0], title: r[1], amount: parseFloat(r[2]) || 0,
          accountId: r[3], category: r[4], date: r[5], notes: r[6],
          createdAt: r[7] || '', repeats: r[9] || '',
        }));
      } catch (err) {
        if (err.message === 'popup_blocked' || err.message === 'refresh_failed') throw err;
        console.warn('ActivityPage fetchData:', err.message);
      } finally {
        loading.value = false;
      }
    }

    watch(() => getSheetId(), (sid) => { if (sid) fetchData(); }, { immediate: true });

    // ── Monthly Summary ──────────────────────────────────────────────────
    const monthlySummary = computed(() => {
      const now = new Date();
      let month = now.getMonth(); // 0-based, current month
      let year = now.getFullYear();
      // Use previous month
      month -= 1;
      if (month < 0) { month = 11; year -= 1; }
      const key = `${year}-${String(month + 1).padStart(2, '0')}`;
      const monthName = MONTH_NAMES[month];

      const monthExpenses = expenses.value.filter(e => e.date && e.date.startsWith(key));
      const monthIncome = incomeList.value.filter(e => e.date && e.date.startsWith(key));

      if (monthExpenses.length === 0 && monthIncome.length === 0) return null;

      const totalExpenses = monthExpenses.reduce((s, e) => s + e.amount, 0);
      const totalIncome = monthIncome.reduce((s, e) => s + e.amount, 0);
      const savingsRate = totalIncome > 0 ? Math.round((totalIncome - totalExpenses) / totalIncome * 100) : null;

      const catTotals = {};
      for (const e of monthExpenses) {
        const cat = e.category || 'Uncategorized';
        catTotals[cat] = (catTotals[cat] || 0) + e.amount;
      }
      const topCategories = Object.entries(catTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, total]) => ({ name, total }));

      return { monthName, year, totalExpenses, totalIncome, savingsRate, topCategories, expenseCount: monthExpenses.length, incomeCount: monthIncome.length };
    });

    // ── Milestones ───────────────────────────────────────────────────────
    const milestones = computed(() => {
      const list = [];
      const expCount = expenses.value.length;
      const incCount = incomeList.value.length;

      if (expCount >= 1) list.push({ icon: 'receipt_long', label: 'First expense logged', done: true });
      if (expCount >= 10) list.push({ icon: 'trending_up', label: '10 expenses tracked', done: true });
      if (expCount >= 50) list.push({ icon: 'star_half', label: '50 expenses tracked', done: true });
      if (expCount >= 100) list.push({ icon: 'star', label: '100 expenses tracked', done: true });

      if (incCount >= 1) list.push({ icon: 'payments', label: 'First income logged', done: true });
      if (incCount >= 10) list.push({ icon: 'savings', label: '10 income entries tracked', done: true });

      const accountCount = (props.accounts || []).length;
      if (accountCount >= 1) list.push({ icon: 'account_balance', label: 'First account added', done: true });

      const hasMultipleMonths = (() => {
        const months = new Set();
        for (const e of expenses.value) { if (e.date) months.add(e.date.slice(0, 7)); }
        for (const e of incomeList.value) { if (e.date) months.add(e.date.slice(0, 7)); }
        return months.size >= 2;
      })();
      if (hasMultipleMonths) list.push({ icon: 'date_range', label: 'Multiple months tracked', done: true });

      // Upcoming milestones (not yet reached)
      if (expCount === 0) list.push({ icon: 'receipt_long', label: 'Log your first expense', done: false });
      else if (expCount < 10) list.push({ icon: 'trending_up', label: `10 expenses (${expCount}/10)`, done: false });
      else if (expCount < 50) list.push({ icon: 'star_half', label: `50 expenses (${expCount}/50)`, done: false });
      else if (expCount < 100) list.push({ icon: 'star', label: `100 expenses (${expCount}/100)`, done: false });

      if (incCount === 0) list.push({ icon: 'payments', label: 'Log your first income', done: false });
      if (accountCount === 0) list.push({ icon: 'account_balance', label: 'Add your first account', done: false });
      if (!hasMultipleMonths && (expCount > 0 || incCount > 0)) {
        list.push({ icon: 'date_range', label: 'Track a second month', done: false });
      }

      return list;
    });

    function collapseOnboarding() {
      onboardingCollapsed.value = true;
      try { localStorage.setItem('valu_onboarding_dismissed', '1'); } catch (_) {}
    }
    function expandOnboarding() {
      onboardingCollapsed.value = false;
      try { localStorage.removeItem('valu_onboarding_dismissed'); } catch (_) {}
    }

    const recurringCount = computed(() => {
      return [...expenses.value, ...incomeList.value].filter(i => i.repeats).length;
    });

    const hasRecurringPending = computed(() => {
      if (recurringCount.value === 0) return false;
      const lastChecked = props.settings?.repeatsLastChecked || '';
      const pending = getPendingRecurring(expenses.value, incomeList.value, lastChecked);
      return pending.length > 0;
    });

    const recurringLastChecked = computed(() => {
      const lc = props.settings?.repeatsLastChecked || '';
      if (!lc) return null;
      const [y, m] = lc.split('-').map(Number);
      return new Date(y, m - 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    });

    function recheckRecurring() {
      emit('navigate', 'home');
    }

    // ── FX rate update status ─────────────────────────────────────────────
    const FX_TAG_RE = /\s*\([A-Z]{3}\s+[\d.,]+\)\s*$/;

    const fxUpcomingCount = computed(() => {
      return [...expenses.value, ...incomeList.value].filter(i => i.notes && FX_TAG_RE.test(i.notes)).length;
    });

    const hasFxPending = computed(() => {
      if (fxUpcomingCount.value === 0) return false;
      const lastRechecked = props.settings?.fxLastRechecked || '';
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      return [...expenses.value, ...incomeList.value].some(i => {
        if (!i.notes || !i.date || !i.createdAt) return false;
        if (!FX_TAG_RE.test(i.notes)) return false;
        if (i.date > todayStr) return false;
        if (i.createdAt.slice(0, 10) >= i.date) return false;
        if (lastRechecked && i.date <= lastRechecked.slice(0, 10)) return false;
        return true;
      });
    });

    const fxLastRechecked = computed(() => {
      const lc = props.settings?.fxLastRechecked || '';
      if (!lc) return null;
      const d = new Date(lc);
      return isNaN(d) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    });

    return {
      baseCurrency, onboardingCollapsed, collapseOnboarding, expandOnboarding,
      DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES,
      EXPENSE_CAT_DESCRIPTIONS, INCOME_CAT_DESCRIPTIONS,
      loading, monthlySummary, milestones, formatCurrency, emit,
      installBanner,
      recurringCount, hasRecurringPending, recurringLastChecked,
      recheckRecurring,
      fxUpcomingCount, hasFxPending, fxLastRechecked,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Activity</h1>
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

      <div class="page">
        <!-- Recurring status card -->
        <div v-if="recurringCount > 0" class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#5c8a8a;">repeat</span>
            <div>
              <div class="activity-feed-title">Recurring Items</div>
              <div class="activity-feed-date">{{ recurringCount }} item{{ recurringCount === 1 ? '' : 's' }} set to repeat</div>
            </div>
          </div>
          <div class="activity-feed-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div v-if="hasRecurringPending" style="flex:1;">
              <span class="material-icons" style="font-size:14px;vertical-align:middle;color:var(--color-warning);margin-right:4px;">info</span>
              Items are waiting to be reviewed.
              <a href="#" @click.prevent="$emit('navigate', 'home')" style="color:var(--color-primary);font-weight:600;margin-left:4px;">Review</a>
            </div>
            <div v-else style="flex:1;color:var(--text-secondary);">
              Up to date<span v-if="recurringLastChecked"> · checked {{ recurringLastChecked }}</span>
            </div>
            <button class="btn btn-text btn-sm" @click.stop="recheckRecurring" style="white-space:nowrap;flex-shrink:0;">
              <span class="material-icons" style="font-size:16px;vertical-align:middle;margin-right:2px;">refresh</span>
              Recheck
            </button>
          </div>
        </div>

        <!-- FX rate update status card -->
        <div v-if="fxUpcomingCount > 0" class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#5c8a8a;">currency_exchange</span>
            <div>
              <div class="activity-feed-title">Exchange Rates</div>
              <div class="activity-feed-date">{{ fxUpcomingCount }} item{{ fxUpcomingCount === 1 ? '' : 's' }} with currency conversion</div>
            </div>
          </div>
          <div class="activity-feed-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div v-if="hasFxPending" style="flex:1;">
              <span class="material-icons" style="font-size:14px;vertical-align:middle;color:var(--color-warning);margin-right:4px;">info</span>
              Upcoming items need rate updates.
              <a href="#" @click.prevent="$emit('navigate', 'home')" style="color:var(--color-primary);font-weight:600;margin-left:4px;">Review</a>
            </div>
            <div v-else style="flex:1;color:var(--text-secondary);">
              Up to date<span v-if="fxLastRechecked"> · checked {{ fxLastRechecked }}</span>
            </div>
          </div>
        </div>

        <!-- Getting Started Card: collapsed -->
        <div v-if="onboardingCollapsed" class="card mb-16 activity-card activity-card--collapsed" @click="expandOnboarding">
          <div class="activity-collapsed-row">
            <span class="material-icons activity-collapsed-icon">auto_awesome</span>
            <span class="activity-collapsed-title">Getting Started</span>
            <span class="material-icons activity-collapsed-chevron">expand_more</span>
          </div>
        </div>

        <!-- Getting Started Card: expanded -->
        <div v-else class="card mb-16 activity-card">
          <div class="activity-card-badge">Getting Started</div>
          <div class="activity-card-body">
            <h3 class="activity-card-title">Welcome to Valu</h3>
            <p class="activity-card-text">Your personal finance tracker — private, flexible, and stored in your own Google Drive.</p>

            <div class="activity-info-block">
              <span class="material-icons activity-info-icon">folder</span>
              <div>
                <strong>Your data, your Drive</strong>
                <p>A spreadsheet named <strong>"Valu: {{ groupName || 'Personal' }}"</strong> was created in your Google Drive. All your data lives there — Valu simply reads and writes to it.</p>
                <p>In Valu, a spreadsheet like this is called a <strong>Group</strong>. You can rename it, create more, or share one — each Group has its own settings and data.</p>
              </div>
            </div>

            <div class="activity-info-block">
              <span class="material-icons activity-info-icon">language</span>
              <div>
                <strong>Base currency: {{ baseCurrency }}</strong>
                <p>Your base currency is set to <strong>{{ baseCurrency }}</strong>. You can change this and other settings anytime in your Group configuration, accessible from the side menu under Groups.</p>
              </div>
            </div>

            <div class="activity-info-block">
              <span class="material-icons activity-info-icon">tune</span>
              <div>
                <strong>Tools & Categories</strong>
                <p>Three tools are enabled by default: <strong>Expenses</strong>, <strong>Income</strong>, and <strong>Accounts</strong>. Each works individually but offers more insights when combined.</p>
                <p>Default categories have been set up for you. You can customize them anytime from the category dropdown when logging an entry — just tap <strong>"Manage categories"</strong>.</p>
              </div>
            </div>

            <div class="activity-section-label">Default Expense Categories</div>
            <div class="activity-cat-list">
              <div v-for="cat in DEFAULT_EXPENSE_CATEGORIES" :key="cat.name" class="activity-cat-item">
                <span class="material-icons activity-cat-icon">{{ cat.icon || 'label' }}</span>
                <div>
                  <strong>{{ cat.name }}</strong>
                  <span class="activity-cat-desc">{{ EXPENSE_CAT_DESCRIPTIONS[cat.name] || '' }}</span>
                </div>
              </div>
            </div>

            <div class="activity-section-label">Default Income Categories</div>
            <div class="activity-cat-list">
              <div v-for="cat in DEFAULT_INCOME_CATEGORIES" :key="cat.name" class="activity-cat-item">
                <span class="material-icons activity-cat-icon">{{ cat.icon || 'label' }}</span>
                <div>
                  <strong>{{ cat.name }}</strong>
                  <span class="activity-cat-desc">{{ INCOME_CAT_DESCRIPTIONS[cat.name] || '' }}</span>
                </div>
              </div>
            </div>

            <div class="activity-info-block" style="margin-top:16px;">
              <span class="material-icons activity-info-icon">lightbulb</span>
              <div>
                <strong>Start simple, go deeper over time</strong>
                <p>More data means a little more effort, but also more valuable insights. Over time, new features and options will be added — you decide if and when they're relevant to you.</p>
              </div>
            </div>

            <button class="btn btn-primary" style="width:100%;margin-top:16px;" @click="collapseOnboarding">Got it</button>
          </div>
        </div>

        <!-- Monthly Summary -->
        <div v-if="monthlySummary" class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#6a8caf;">insights</span>
            <div>
              <div class="activity-feed-title">{{ monthlySummary.monthName }} {{ monthlySummary.year }}</div>
              <div class="activity-feed-date">Previous month summary</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <div class="activity-summary-stats">
              <div class="activity-summary-stat" v-if="monthlySummary.expenseCount > 0">
                <span class="activity-summary-label">Spent</span>
                <span class="activity-summary-value" style="color:var(--color-expense);">{{ formatCurrency(monthlySummary.totalExpenses, baseCurrency) }}</span>
              </div>
              <div class="activity-summary-stat" v-if="monthlySummary.incomeCount > 0">
                <span class="activity-summary-label">Earned</span>
                <span class="activity-summary-value" style="color:var(--color-income);">{{ formatCurrency(monthlySummary.totalIncome, baseCurrency) }}</span>
              </div>
              <div class="activity-summary-stat" v-if="monthlySummary.savingsRate !== null">
                <span class="activity-summary-label">Savings rate</span>
                <span class="activity-summary-value">{{ monthlySummary.savingsRate }}%</span>
              </div>
            </div>
            <div v-if="monthlySummary.topCategories.length > 0" class="activity-summary-cats">
              <div class="activity-summary-cat-label">Top expense categories</div>
              <div v-for="cat in monthlySummary.topCategories" :key="cat.name" class="activity-summary-cat-row">
                <span class="activity-summary-cat-name">{{ cat.name }}</span>
                <span class="activity-summary-cat-amount">{{ formatCurrency(cat.total, baseCurrency) }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="card mb-16 activity-feed-card activity-feed-card--muted">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#6a8caf;">insights</span>
            <div>
              <div class="activity-feed-title">Monthly Summary</div>
              <div class="activity-feed-date">No data for last month yet</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <p>Once you log expenses or income, a monthly recap will appear here — total spent, total earned, savings rate, and top categories.</p>
          </div>
        </div>

        <!-- Milestones -->
        <div class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#b07d4f;">emoji_events</span>
            <div>
              <div class="activity-feed-title">Milestones</div>
              <div class="activity-feed-date">{{ milestones.filter(m => m.done).length }} achieved</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <div v-if="milestones.length === 0" style="color:var(--color-text-secondary);">Start logging to earn milestones.</div>
            <div v-for="(m, i) in milestones" :key="i" class="activity-milestone-row">
              <span class="material-icons activity-milestone-icon" :style="{ color: m.done ? 'var(--color-primary)' : 'var(--color-text-hint)' }">{{ m.icon }}</span>
              <span class="activity-milestone-label" :class="{ 'activity-milestone--pending': !m.done }">{{ m.label }}</span>
              <span v-if="m.done" class="material-icons activity-milestone-check">check_circle</span>
            </div>
          </div>
        </div>

        <!-- What's New -->
        <div id="whats-new" class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#5c8a8a;">new_releases</span>
            <div>
              <div class="activity-feed-title">What's New in v189</div>
              <div class="activity-feed-date">April 2026</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <ul class="activity-feed-list">
              <li><strong>Currency auto-conversion</strong> — Log expenses, income, or balances in a foreign-currency account and auto-convert at the official central bank rate for the transaction date. Fallback to manual rates when offline.</li>
              <li><strong>Smarter assistant</strong> — Context-aware follow-ups, year-to-date summaries, income trend charts, budget queries, and FAQ-powered fallback answers.</li>
              <li><strong>FI Calculator</strong> — Financial Independence calculator with auto-populated data from your accounts, income, and expenses.</li>
              <li><strong>Balance history protection</strong> — Storing an older balance no longer overwrites a newer one for the same month.</li>
              <li><strong>Smart Insights</strong> — Estimate spending from balance changes and income — no expense logging needed.</li>
              <li><strong>Expense Categories widget</strong> — Monthly breakdown per category with editable goals, right on the Home page.</li>
            </ul>
          </div>
        </div>

        <!-- Tip -->
        <div class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#c09a4b;">lightbulb</span>
            <div>
              <div class="activity-feed-title">Tip: Manage from any dropdown</div>
              <div class="activity-feed-date">Quick tip</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <p>When logging an expense or income, you can add, rename, reorder, or remove categories without leaving the form. Just scroll to the bottom of any category dropdown and tap <strong>"Manage categories"</strong>. The same works for accounts.</p>
          </div>
        </div>

        <!-- Install app card -->
        <div v-if="!installBanner.installed.value" class="card mb-16 install-card">
          <div class="install-card-body">
            <span class="material-icons install-card-icon">download</span>
            <div class="install-card-content">
              <strong>Install Valu</strong>
              <span>Add to your home screen for the best experience — fast access, works offline.</span>
            </div>
          </div>
          <div class="install-card-actions">
            <button class="btn btn-primary btn-sm" @click="installBanner.install()">Install</button>
          </div>
        </div>
      </div>
      </div>
    </div>
  `,
};
