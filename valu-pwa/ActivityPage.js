import { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES } from './sheetsApi.js';

const { ref, computed } = Vue;

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

export default {
  props: ['settings', 'groupName'],
  emits: ['go-home'],

  setup(props) {
    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');
    const onboardingCollapsed = ref(localStorage.getItem('valu_onboarding_dismissed') === '1');

    function collapseOnboarding() {
      onboardingCollapsed.value = true;
      try { localStorage.setItem('valu_onboarding_dismissed', '1'); } catch (_) {}
    }
    function expandOnboarding() {
      onboardingCollapsed.value = false;
      try { localStorage.removeItem('valu_onboarding_dismissed'); } catch (_) {}
    }

    return {
      baseCurrency, onboardingCollapsed, collapseOnboarding, expandOnboarding,
      DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES,
      EXPENSE_CAT_DESCRIPTIONS, INCOME_CAT_DESCRIPTIONS,
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

      <div class="page">
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
                <span class="material-icons activity-cat-icon">{{ cat.icon }}</span>
                <div>
                  <strong>{{ cat.name }}</strong>
                  <span class="activity-cat-desc">{{ EXPENSE_CAT_DESCRIPTIONS[cat.name] || '' }}</span>
                </div>
              </div>
            </div>

            <div class="activity-section-label">Default Income Categories</div>
            <div class="activity-cat-list">
              <div v-for="cat in DEFAULT_INCOME_CATEGORIES" :key="cat.name" class="activity-cat-item">
                <span class="material-icons activity-cat-icon">{{ cat.icon }}</span>
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

        <!-- What's New -->
        <div class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#5c8a8a;">new_releases</span>
            <div>
              <div class="activity-feed-title">What's New in v142</div>
              <div class="activity-feed-date">March 2026</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <ul class="activity-feed-list">
              <li><strong>Manage in-context</strong> — Tap "Manage categories" or "Manage accounts" directly from any dropdown while logging entries.</li>
              <li><strong>Activity page</strong> — This page! A central feed for onboarding, updates, and future insights.</li>
              <li><strong>Default categories</strong> — New groups come pre-configured with expense and income categories.</li>
              <li><strong>Auto-focus</strong> — The name field is now focused when opening an Add sheet.</li>
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

        <!-- Monthly Summary (demo) -->
        <div class="card mb-16 activity-feed-card activity-feed-card--muted">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#6a8caf;">insights</span>
            <div>
              <div class="activity-feed-title">Monthly Summary</div>
              <div class="activity-feed-date">Coming soon</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <p>At the end of each month, you'll see a recap here — total spent, total earned, savings rate, and your top expense categories. The more you track, the more useful these summaries become.</p>
          </div>
        </div>

        <!-- Milestones (demo) -->
        <div class="card mb-16 activity-feed-card activity-feed-card--muted">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#b07d4f;">emoji_events</span>
            <div>
              <div class="activity-feed-title">Milestones</div>
              <div class="activity-feed-date">Coming soon</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <p>Track your progress with milestones like "First month fully tracked", "100 expenses logged", or "Net worth up this quarter". Achievements will appear here as you use the app.</p>
          </div>
        </div>
      </div>
      </div>
    </div>
  `,
};
