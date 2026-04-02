import SheetsApi, { TABS, isDemoSheet } from './sheetsApi.js';
import { getFaqById } from './faqData.js';

const { ref, computed, watch, inject, onMounted, onBeforeUnmount, nextTick } = Vue;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Intent definitions ───────────────────────────────────────────────────────
const INTENTS = [
  // Exact / greeting
  { id: 'greeting',         patterns: [/^(hi|hello|hey|good morning|good evening)\b/i] },

  // Navigation & actions (checked before broad data intents)
  { id: 'addExpense',       patterns: [/add.*(expense|purchase|cost)/i, /log.*(expense|purchase)/i, /new expense/i] },
  { id: 'addIncome',        patterns: [/add.*income/i, /log.*income/i, /new income/i] },
  { id: 'goExpenses',       patterns: [/go\s*to\s*expense/i, /open\s*expense/i, /expense.*page/i, /expense.*list/i] },
  { id: 'goIncome',         patterns: [/go\s*to\s*income/i, /open\s*income/i, /income.*page/i] },
  { id: 'goAccounts',       patterns: [/go\s*to\s*account/i, /open\s*account/i, /account.*page/i] },
  { id: 'goSettings',       patterns: [/setting/i, /preference/i, /config/i] },
  { id: 'goGroups',         patterns: [/group/i, /switch.*group/i] },
  { id: 'goFi',             patterns: [/fi\s*calc/i, /financial\s*independence/i, /go\s*to\s*fi/i, /open\s*fi/i] },
  { id: 'updateBalance',    patterns: [/update.*balance/i, /store.*balance/i, /record.*balance/i] },

  // Specific data intents
  { id: 'biggestExpense',   patterns: [/biggest|largest|most expensive|highest/i] },
  { id: 'goalStatus',       patterns: [/goal/i, /on track/i, /budget\s*status/i, /over\s*budget/i, /under\s*budget/i, /am i on/i] },
  { id: 'compare',          patterns: [/compare/i, /vs\.?\s/i, /versus/i, /this month.*(last|prev)/i, /last month.*(this|current)/i, /month.*over.*month/i] },
  { id: 'trend',            patterns: [/trend/i, /spending.*over.*time/i, /year.*over.*year/i, /^history$/i] },
  { id: 'savingsRate',      patterns: [/savings?\s*rate/i, /save.*percent/i, /saving/i] },
  { id: 'chart',            patterns: [/\bchart\b/i, /\bgraph\b/i, /\bvisual\b/i, /show.*chart/i, /breakdown.*chart/i] },
  { id: 'income',           patterns: [/income/i, /earn(ed|ing)?/i, /salary/i, /revenue/i] },
  { id: 'netWorth',         patterns: [/net\s*worth/i, /total.*balance/i, /all.*account/i, /how much.*have\b/i] },
  { id: 'balance',          patterns: [/\bbalance/i, /account.*status/i] },

  // FAQ & informational
  { id: 'whatsNew',         patterns: [/what'?s\s*new/i, /changelog/i, /update/i, /latest.*feature/i, /new feature/i, /release note/i] },
  { id: 'help',             patterns: [/^help$/i, /how\s*(do|can)\s*i/i, /what\s*(can|do)\s*you/i, /getting\s*started/i, /how.*work/i] },
  { id: 'whatIsValu',       patterns: [/what\s*is\s*valu/i, /about\s*valu/i, /tell.*about/i] },
  { id: 'categories',       patterns: [/categor/i, /set\s*up.*categor/i, /manage.*categor/i] },
  { id: 'currency',         patterns: [/currency/i, /exchange.*rate/i, /base\s*currency/i] },
  { id: 'privacy',          patterns: [/privacy/i, /data.*safe/i, /secure/i, /who.*access/i] },
  { id: 'smartInsights',    patterns: [/smart\s*insight/i, /derived.*expense/i, /estimate.*spend/i, /balance.*based/i] },
  { id: 'assistantInfo',    patterns: [/what.*assistant/i, /who.*are.*you/i, /what.*can.*you.*do/i, /what.*is.*the.*orb/i, /what.*orb/i, /the.*logo/i] },
  { id: 'sharing',          patterns: [/how.*share/i, /share.*data/i, /share.*sheet/i, /share.*group/i, /multi.*user/i] },
  { id: 'offline',          patterns: [/\boffline\b/i, /work.*without.*internet/i, /no.*connection/i] },
  { id: 'install',          patterns: [/\binstall\b/i, /add.*home\s*screen/i, /\bpwa\b/i, /download.*app/i] },
  { id: 'howGoalsWork',     patterns: [/how.*goal.*work/i, /set.*goal/i, /what.*goal/i, /goal.*explain/i] },
  { id: 'reminders',        patterns: [/reminder/i, /balance.*remind/i, /remind.*balance/i] },
  { id: 'tips',             patterns: [/\btips?\b/i, /\badvice\b/i, /\brecommend/i, /what\s*should/i] },
  { id: 'thanks',           patterns: [/thank/i, /awesome/i, /\bgreat\b/i, /perfect/i, /\bnice\b/i, /\bcool\b/i] },

  // General spending (exact matches)
  { id: 'spending',         patterns: [/^(?:show\s+)?(?:all\s+)?spend(?:ing)?\s*$/i, /^show\s+(?:all\s+)?spend/i, /^total\s+expense/i, /^expense.*total/i] },
  { id: 'spendingOverview', patterns: [/how much.*(spend|spent|cost)(?!\s+on\b)/i, /spend(ing)?\s*(this|last|total)\s*$/i] },

  // Broad catch-alls (last — these have greedy capture groups)
  { id: 'categorySpending', patterns: [
    /(?:how much|what).+(?:spend|spent|cost|paid|pay).+(?:on|for)\s+(.+)/i,
    /(?:how much|what).+(?:on|for)\s+(.+)/i,
    /(?:spend|spent|cost|paid).+(?:on|for)\s+(.+)/i,
    /(.+?)\s+(?:spend|spent|cost|expense|total)s?\s*(?:this|last|per|by|in|$)/i,
  ]},
  { id: 'searchExpenses',   patterns: [
    /(?:search|find|look\s*up|look\s*for|show\s*me)\s+(.+)/i,
    /(?:how\s+about)\s+(?:just\s+)?(.+)/i,
    /(?:what\s+about)\s+(.+)/i,
  ]},
];

function matchIntent(text) {
  const clean = text.trim();
  for (const intent of INTENTS) {
    for (const pat of intent.patterns) {
      const m = clean.match(pat);
      if (m) return { id: intent.id, match: m };
    }
  }
  return null;
}

// ── Component ────────────────────────────────────────────────────────────────
export default {
  props: ['sheetId', 'settings', 'accounts', 'groupName'],
  emits: ['navigate', 'go-home'],

  setup(props, { emit }) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    function getSheetId() { return props.sheetId || injectedSheetId.value; }

    const messages = ref([]);
    const inputText = ref('');
    const messagesEl = ref(null);
    const inputEl = ref(null);

    const expenses = ref([]);
    const incomeList = ref([]);
    const balanceHistory = ref([]);
    const loading = ref(true);

    const chatList = ref([]);
    const activeChatId = ref(null);
    const showHistory = ref(false);
    let syncTimer = null;

    const answeredFaqIntents = new Set();
    const FAQ_SUGGESTION_TO_INTENT = {
      'What is Valu?': 'whatIsValu',
      'Privacy': 'privacy',
      'Smart Insights': 'smartInsights',
      "What's new": 'whatsNew',
      'Getting started': 'help',
      'Install as app': 'install',
    };
    let chatTabEnsured = false;

    const lastContext = { searchTerm: null, period: null, intent: null };

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');

    const currencyRates = computed(() => {
      const ratesStr = props.settings?.currencyRates || '';
      const map = {};
      ratesStr.split(',').filter(Boolean).forEach(r => {
        const [cur, val] = r.split(':');
        if (cur && val) map[cur] = parseFloat(val);
      });
      return map;
    });

    const enabledLists = computed(() => (props.settings?.listsEnabled || '').split(',').filter(Boolean));

    function getAccountCurrency(accountId) {
      const acc = (props.accounts || []).find(a => a.id === accountId);
      return acc ? (acc.currency || baseCurrency.value) : baseCurrency.value;
    }
    function getAccountName(accountId) {
      const acc = (props.accounts || []).find(a => a.id === accountId);
      return acc ? acc.name : '';
    }

    function convertToBase(amount, fromCurrency) {
      if (!fromCurrency || fromCurrency === baseCurrency.value) return amount;
      const rate = currencyRates.value[fromCurrency];
      return rate ? Math.round(amount * rate * 100) / 100 : amount;
    }

    function getNumberLocale() {
      return (localStorage.getItem('valu_number_format') || 'auto') === 'auto' ? undefined : localStorage.getItem('valu_number_format');
    }

    function fmt(amount) {
      try {
        const cur = baseCurrency.value;
        const numLocale = getNumberLocale();
        const sym = new Intl.NumberFormat(undefined, {
          style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol',
        }).formatToParts(0).find(p => p.type === 'currency')?.value || cur;
        const num = new Intl.NumberFormat(numLocale, {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        }).format(amount);
        return sym + num;
      } catch { return amount.toFixed(2); }
    }

    function pct(value) { return Math.round(value * 100); }

    // ── Data helpers ─────────────────────────────────────────────────────────
    function now() { return new Date(); }
    function thisMonth() {
      const n = now();
      return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
    }
    function lastMonth() {
      const n = now();
      const d = new Date(n.getFullYear(), n.getMonth() - 1, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    function monthLabel(ym) {
      const [y, m] = ym.split('-');
      return `${MONTH_NAMES[parseInt(m) - 1]} ${y}`;
    }

    function expensesForMonth(ym) {
      return expenses.value.filter(e => e.date && e.date.startsWith(ym));
    }
    function incomeForMonth(ym) {
      return incomeList.value.filter(e => e.date && e.date.startsWith(ym));
    }

    function expensesForYear(year) {
      const prefix = String(year);
      return expenses.value.filter(e => e.date && e.date.startsWith(prefix));
    }
    function expensesInRange(startYm, endYm) {
      return expenses.value.filter(e => {
        if (!e.date) return false;
        const ym = e.date.slice(0, 7);
        return ym >= startYm && ym <= endYm;
      });
    }

    function parseTimePeriod(text) {
      const lower = text.toLowerCase();
      const n = now();
      const cy = n.getFullYear();
      const cm = n.getMonth() + 1;

      if (/\b(?:in\s+)?total\b|all\s*time|overall|ever\b|all\s+years/i.test(lower)) {
        return { type: 'all', label: 'all time' };
      }
      const rangeMatch = lower.match(/(?:from\s+)(20\d{2})\s+(?:to|through|until|–|-)\s+(20\d{2})/i);
      if (rangeMatch) {
        const startY = parseInt(rangeMatch[1]);
        const endY = parseInt(rangeMatch[2]);
        return { type: 'range', startYm: `${startY}-01`, endYm: `${endY}-12`, label: `${startY}–${endY}` };
      }
      if (/this\s+year/i.test(lower)) {
        return { type: 'year', year: cy, label: String(cy) };
      }
      if (/last\s+year/i.test(lower)) {
        return { type: 'year', year: cy - 1, label: String(cy - 1) };
      }
      const nMonthsMatch = lower.match(/(?:last|past)\s+(\d+)\s+months?/i);
      if (nMonthsMatch) {
        const count = parseInt(nMonthsMatch[1]);
        const start = new Date(cy, cm - 1 - count, 1);
        const startYm = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
        const endYm = `${cy}-${String(cm).padStart(2, '0')}`;
        return { type: 'range', startYm, endYm, label: `last ${count} months` };
      }
      for (let mi = 0; mi < 12; mi++) {
        if (lower.includes(MONTH_NAMES[mi].toLowerCase()) || lower.includes(MONTH_SHORT[mi].toLowerCase())) {
          const yearMatch = lower.match(/\b(20\d{2})\b/);
          const year = yearMatch ? parseInt(yearMatch[1]) : cy;
          const ym = `${year}-${String(mi + 1).padStart(2, '0')}`;
          return { type: 'month', ym, label: `${MONTH_NAMES[mi]} ${year}` };
        }
      }
      if (/per\s*month|monthly|each\s*month|by\s*month/i.test(lower)) {
        return { type: 'monthly-breakdown', label: 'monthly breakdown' };
      }
      const bareYear = lower.match(/\b(20\d{2})\b/);
      if (bareYear) {
        return { type: 'year', year: parseInt(bareYear[1]), label: bareYear[1] };
      }
      return null;
    }

    function getExpensesForPeriod(period) {
      if (!period) return { list: expensesForMonth(thisMonth()), label: monthLabel(thisMonth()) };
      if (period.type === 'all') return { list: [...expenses.value], label: 'all time' };
      if (period.type === 'year') return { list: expensesForYear(period.year), label: period.label };
      if (period.type === 'month') return { list: expensesForMonth(period.ym), label: monthLabel(period.ym) };
      if (period.type === 'range') return { list: expensesInRange(period.startYm, period.endYm), label: period.label };
      return { list: expensesForMonth(thisMonth()), label: monthLabel(thisMonth()) };
    }

    function searchExpensesByKeywords(keywords, list) {
      const terms = keywords.map(k => k.toLowerCase().trim()).filter(Boolean);
      return list.filter(e => {
        const title = (e.title || '').toLowerCase();
        const cat = (e.category || '').toLowerCase();
        return terms.some(t => title.includes(t) || cat.includes(t));
      });
    }

    function extractKeywords(text) {
      let cleaned = text
        .replace(/\b(how much|what|have|we|i|spent|spend|on|for|this|last|year|month|per|the|a|an|in|my|our|and|or|just|about|show|me|with|from|to|all|any|each|total|is|are|was|were|been|be|do|does|did|can|could|would|should|will|shall|may|might|must|has|had|having|some|more|also|too|very|so|such|how|what|which|when|where|who|whom|whose|why|if|then|than|both|either|neither|not|no|nor|but|yet|after|before|during|of|at|by|up|down|out|off|over|under|again|further|once|here|there)\b/gi, ' ')
        .replace(/[?.,!;:'"()\[\]{}]/g, ' ')
        .trim();
      const parts = cleaned.split(/\s+and\s+|\s*,\s*|\s+/).filter(w => w.length > 1);
      return [...new Set(parts)];
    }

    function totalExpenses(list) {
      return list.reduce((s, e) => s + convertToBase(e.amount, getAccountCurrency(e.accountId)), 0);
    }
    function totalIncome(list) {
      return list.reduce((s, e) => s + convertToBase(e.amount, getAccountCurrency(e.accountId)), 0);
    }

    function categoryBreakdown(list) {
      const map = {};
      for (const e of list) {
        const cat = e.category || 'Uncategorized';
        const base = convertToBase(e.amount, getAccountCurrency(e.accountId));
        map[cat] = (map[cat] || 0) + base;
      }
      return Object.entries(map)
        .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }))
        .sort((a, b) => b.total - a.total);
    }

    function getGoals() {
      const str = props.settings?.expenseCategoryGoals || '';
      const map = {};
      str.split(',').filter(Boolean).forEach(g => {
        const idx = g.lastIndexOf(':');
        if (idx > 0) map[g.slice(0, idx)] = parseFloat(g.slice(idx + 1)) || 0;
      });
      return map;
    }

    function getCurrentBalance(accountId) {
      const entries = balanceHistory.value
        .filter(h => h.accountId === accountId)
        .sort((a, b) => b.year !== a.year ? b.year - a.year : b.month - a.month);
      return entries.length > 0 ? entries[0].balance : null;
    }

    function getNetWorth() {
      let total = 0;
      for (const acc of (props.accounts || [])) {
        if (acc.discontinued === 'true') continue;
        const bal = getCurrentBalance(acc.id);
        if (bal !== null) total += convertToBase(bal, acc.currency || baseCurrency.value);
      }
      return Math.round(total * 100) / 100;
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

    function cashFlowBalanceForYm(ym) {
      const [y, m] = ym.split('-').map(Number);
      const cashAccounts = (props.accounts || [])
        .filter(a => a.discontinued !== 'true' && a.type !== 'Investment');
      const lastKnown = {};
      const sorted = [...balanceHistory.value].sort((a, b) => (a.year * 100 + a.month) - (b.year * 100 + b.month));
      for (const h of sorted) {
        if (h.year * 100 + h.month > y * 100 + m) break;
        if (getAccountType(h.accountId) === 'Investment') continue;
        lastKnown[h.accountId] = { balance: h.balance, currency: getAccountCurrency(h.accountId) };
      }
      return cashAccounts.reduce((sum, a) => {
        const info = lastKnown[a.id];
        return info ? sum + convertToBase(info.balance, info.currency) : sum;
      }, 0);
    }

    function prevYm(ym) {
      const [y, m] = ym.split('-').map(Number);
      return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    }

    function estimatedSpendingForMonth(ym) {
      const inc = totalIncome(incomeForMonth(ym));
      const endBal = cashFlowBalanceForYm(ym);
      const startBal = cashFlowBalanceForYm(prevYm(ym));
      if (startBal === 0 && endBal === 0) return null;
      return Math.round((inc - (endBal - startBal)) * 100) / 100;
    }

    function monthlyAvg() {
      const months = new Set();
      for (const e of expenses.value) {
        if (e.date) months.add(e.date.slice(0, 7));
      }
      if (months.size === 0) return 0;
      const total = totalExpenses(expenses.value);
      return Math.round(total / months.size * 100) / 100;
    }

    // ── Chart builders ───────────────────────────────────────────────────────
    const CHART_COLORS = [
      '#5B8DB8','#E2725B','#F0C75E','#5AAD6E','#E8935A',
      '#6ECBDB','#8B6DB0','#E88B9C','#F5E16B','#5F9EA0',
      '#D4A574','#999999',
    ];

    function buildBarChart(items, labelKey, valueKey) {
      const max = Math.max(...items.map(i => i[valueKey]), 1);
      return {
        type: 'bar',
        items: items.map((item, idx) => ({
          label: item[labelKey],
          value: item[valueKey],
          pct: Math.round(item[valueKey] / max * 100),
          formatted: fmt(item[valueKey]),
          color: CHART_COLORS[idx % CHART_COLORS.length],
        })),
      };
    }

    function buildGoalChart(cats, goals) {
      return {
        type: 'goal',
        items: cats.map((c, idx) => {
          const goal = goals[c.name];
          return {
            label: c.name,
            actual: c.total,
            goal: goal || null,
            pct: goal ? Math.min(Math.round(c.total / goal * 100), 150) : null,
            over: goal ? c.total > goal : false,
            formatted: fmt(c.total),
            goalFormatted: goal ? fmt(goal) : null,
            color: CHART_COLORS[idx % CHART_COLORS.length],
          };
        }),
      };
    }

    function buildTrendChart(monthlyData) {
      const max = Math.max(...monthlyData.map(d => d.total), 1);
      return {
        type: 'trend',
        items: monthlyData.map(d => ({
          label: MONTH_SHORT[parseInt(d.month.split('-')[1]) - 1],
          value: d.total,
          pct: Math.round(d.total / max * 100),
          formatted: fmt(d.total),
        })),
      };
    }

    // ── Message helpers ──────────────────────────────────────────────────────
    function addMsg(from, text, opts = {}) {
      messages.value.push({ from, text, ts: new Date().toISOString(), ...opts });
      nextTick(() => {
        if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
      });
      onNewMessage();
    }
    function reply(text, opts = {}) {
      if (opts.suggestions) {
        opts.suggestions = opts.suggestions.filter(s => {
          const intentId = FAQ_SUGGESTION_TO_INTENT[s];
          return !intentId || !answeredFaqIntents.has(intentId);
        });
      }
      addMsg('valu', text, opts);
    }

    // ── Response generators ──────────────────────────────────────────────────
    function handleSpending(fullText) {
      if (smartInsightsMode.value) return handleSmartSpending(fullText);

      const period = fullText ? parseTimePeriod(fullText) : null;
      const tm = thisMonth();
      const lm = lastMonth();

      if (period && period.type !== 'month') {
        const { list, label } = getExpensesForPeriod(period);
        const total = totalExpenses(list);
        const cats = categoryBreakdown(list);
        let text = `Total spending in ${label}: ${fmt(total)} (${list.length} transactions).`;
        if (period.type === 'year' || period.type === 'range') {
          const months = [...new Set(list.map(e => e.date.slice(0, 7)))].sort();
          if (months.length > 1) {
            const perMonth = total / months.length;
            text += ` That's an average of ${fmt(perMonth)}/month.`;
          }
        }
        reply(text, {
          chart: cats.length > 0 ? buildBarChart(cats, 'name', 'total') : null,
          suggestions: ['Goal status', 'Compare months', 'Spending trend'],
        });
        return;
      }

      const targetYm = (period && period.type === 'month') ? period.ym : tm;
      const targetLabel = (period && period.type === 'month') ? period.label : monthLabel(tm);
      const targetExp = period && period.type === 'month' ? expensesForMonth(period.ym) : expensesForMonth(tm);
      const thisTotal = totalExpenses(targetExp);

      let text = `In ${targetLabel} you've spent ${fmt(thisTotal)}.`;

      if (!period || period.ym === tm) {
        const lastTotal = totalExpenses(expensesForMonth(lm));
        if (lastTotal > 0) {
          const diff = thisTotal - lastTotal;
          text += ` Last month was ${fmt(lastTotal)}`;
          if (diff > 0) text += ` — you're ${fmt(diff)} higher so far.`;
          else if (diff < 0) text += ` — you're ${fmt(Math.abs(diff))} lower so far.`;
          else text += '.';
        }
        const avg = monthlyAvg();
        if (avg > 0) text += ` Your monthly average is ${fmt(avg)}.`;
      }

      const cats = categoryBreakdown(targetExp);
      reply(text, {
        chart: cats.length > 0 ? buildBarChart(cats, 'name', 'total') : null,
        suggestions: ['Goal status', 'Compare months', 'Spending trend'],
      });
    }

    function handleSmartSpending(fullText) {
      const period = fullText ? parseTimePeriod(fullText) : null;
      const tm = thisMonth();
      const lm = lastMonth();

      const targetYm = (period?.type === 'month') ? period.ym : tm;
      const targetLabel = (period?.type === 'month') ? period.label : monthLabel(tm);
      const est = estimatedSpendingForMonth(targetYm);
      const inc = totalIncome(incomeForMonth(targetYm));

      if (est === null) {
        reply("I don't have enough balance data to estimate spending for that period. Make sure your account balances are up to date.", {
          suggestions: ['Update balances', 'Net worth', 'Income details'],
        });
        return;
      }

      let text = `Estimated spending in ${targetLabel}: ${fmt(Math.max(0, est))}.`;
      text += ` Income: ${fmt(inc)}.`;
      if (inc > 0) {
        const saved = inc - Math.max(0, est);
        text += ` ${saved >= 0 ? 'Saved' : 'Overspent'}: ${fmt(Math.abs(saved))} (${Math.round(saved / inc * 100)}% savings rate).`;
      }

      if (!period || targetYm === tm) {
        const lastEst = estimatedSpendingForMonth(lm);
        if (lastEst !== null && lastEst > 0) {
          const diff = Math.round(((Math.max(0, est) - lastEst) / lastEst) * 100);
          if (diff > 0) text += ` That's ${diff}% higher than last month.`;
          else if (diff < 0) text += ` That's ${Math.abs(diff)}% lower than last month.`;
        }
      }

      text += '\n\n_Estimated from your account balance changes and income — enable Expenses for detailed tracking._';

      reply(text, { suggestions: ['Spending trend', 'Savings rate', 'Net worth', 'Income details'] });
    }

    function handleCategorySpending(match, fullText) {
      if (smartInsightsMode.value) {
        reply("Smart Insights estimates your total spending from balance changes, but can't break it down by category without expense logs. Enable Expenses in your group settings for category-level tracking.", {
          suggestions: ['Show spending', 'Spending trend', 'Smart Insights'],
        });
        return;
      }

      let raw = match?.[1]?.trim();
      if (!raw) { handleSpending(); return; }

      const period = parseTimePeriod(fullText || raw);
      const { list: pool, label: periodLabel } = getExpensesForPeriod(period);
      raw = raw
        .replace(/\?+$/, '')
        .replace(/\b(?:in\s+)?(?:total|overall)\b/gi, '')
        .replace(/\b(?:all\s*time|ever)\b/gi, '')
        .replace(/\b(?:from\s+)?20\d{2}\s*(?:to|through|until|–|-)\s*20\d{2}\b/gi, '')
        .replace(/\b(?:in|for|during|from|of)\s+(?:20\d{2})\b/gi, '')
        .replace(/\b(?:this|last)\s+(?:year|month)\b/gi, '')
        .replace(/\b(?:last|past)\s+\d+\s+months?\b/gi, '')
        .replace(/\b(?:per|each|every|by)\s+month\b/gi, '')
        .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, '')
        .replace(/\b20\d{2}\b/g, '')
        .replace(/\b(?:from|to|through|until)\b/gi, '')
        .trim();
      if (!raw) { handleSpending(fullText); return; }
      const search = raw.toLowerCase();

      let found = pool.filter(e => (e.category || '').toLowerCase().includes(search));
      let matchType = 'category';
      if (found.length === 0) {
        found = pool.filter(e => (e.title || '').toLowerCase().includes(search));
        matchType = 'title';
      }
      if (found.length === 0) {
        const keywords = extractKeywords(raw);
        if (keywords.length > 0) {
          found = searchExpensesByKeywords(keywords, pool);
          matchType = 'keywords';
        }
      }

      if (found.length === 0) {
        reply(`I couldn't find any expenses matching "${raw}" in ${periodLabel}.`, {
          suggestions: ['Show all spending', 'Goal status', 'Search expenses'],
        });
        return;
      }

      saveContext(raw, period, 'categorySpending');

      const total = totalExpenses(found);
      const goals = getGoals();

      if (period && period.type === 'monthly-breakdown') {
        handleMonthlyBreakdown(found, raw);
        return;
      }

      if (period && (period.type === 'year' || period.type === 'range')) {
        const monthMap = {};
        for (const e of found) {
          const ym = e.date.slice(0, 7);
          monthMap[ym] = (monthMap[ym] || 0) + convertToBase(e.amount, getAccountCurrency(e.accountId));
        }
        const sortedMonths = Object.keys(monthMap).sort();
        const perMonth = sortedMonths.length > 0 ? total / sortedMonths.length : 0;
        let text = `Spent ${fmt(total)} on "${raw}" across ${periodLabel} (${found.length} transaction${found.length !== 1 ? 's' : ''}, avg ${fmt(perMonth)}/month).`;

        if (sortedMonths.length <= 12 && sortedMonths.length > 0) {
          const trendData = sortedMonths.map(ym => ({ month: ym, total: Math.round(monthMap[ym] * 100) / 100 }));
          reply(text, {
            chart: buildTrendChart(trendData),
            suggestions: ['Show all spending', 'Goal status', 'Compare months'],
          });
        } else {
          const lines = sortedMonths.slice(-6).map(ym => `${monthLabel(ym)}: ${fmt(monthMap[ym])}`);
          reply(text, { table: lines, suggestions: ['Show all spending', 'Goal status'] });
        }
        return;
      }

      const label = matchType === 'category' ? (found[0].category || raw) : raw;
      let text = `Spent ${fmt(total)} on "${label}" in ${periodLabel} (${found.length} transaction${found.length !== 1 ? 's' : ''}).`;

      if (matchType !== 'category' && found.length <= 8) {
        text += '\n' + found.map(e => `• ${e.title}: ${fmt(e.amount)} (${e.date})`).join('\n');
      }

      const catName = matchType === 'category' ? found[0].category : null;
      if (catName && goals[catName] != null) {
        const goal = goals[catName];
        if (total > goal) text += `\nThat's ${fmt(total - goal)} over your goal of ${fmt(goal)}.`;
        else text += `\nYou're within your goal of ${fmt(goal)}.`;
      }

      reply(text, { suggestions: ['Goal status', 'Show all spending', 'Tips'] });
    }

    function handleMonthlyBreakdown(expenseList, label) {
      const monthMap = {};
      for (const e of expenseList) {
        const ym = e.date.slice(0, 7);
        monthMap[ym] = (monthMap[ym] || 0) + convertToBase(e.amount, getAccountCurrency(e.accountId));
      }
      const sorted = Object.keys(monthMap).sort();
      if (sorted.length === 0) {
        reply(`No data to break down for "${label}".`);
        return;
      }
      const trendData = sorted.map(ym => ({ month: ym, total: Math.round(monthMap[ym] * 100) / 100 }));
      const avg = trendData.reduce((s, d) => s + d.total, 0) / trendData.length;
      reply(`Monthly breakdown for "${label}" (avg ${fmt(avg)}/month):`, {
        chart: buildTrendChart(trendData.slice(-12)),
        suggestions: ['Show all spending', 'Goal status'],
      });
    }

    function handleSearchFallback(text) {
      if (smartInsightsMode.value) {
        reply("Smart Insights estimates total spending from your balance changes, but can't search individual transactions. Enable Expenses in your group settings for detailed tracking.\n\nHere's what I can help with:", {
          suggestions: ['Show spending', 'Spending trend', 'Savings rate', 'Smart Insights'],
        });
        return;
      }

      const period = parseTimePeriod(text);
      const { list: pool, label: periodLabel } = getExpensesForPeriod(period);
      const keywords = extractKeywords(text);

      if (keywords.length === 0) {
        reply("I'm not sure I understand. Here are some things I can help with:", {
          suggestions: ['Show spending', 'Goal status', 'Compare months', 'Income details', 'Net worth', 'Tips', 'Help'],
        });
        return;
      }

      const found = searchExpensesByKeywords(keywords, pool);
      if (found.length === 0) {
        const allFound = searchExpensesByKeywords(keywords, expenses.value);
        if (allFound.length > 0) {
          saveContext(keywords.join(' '), period, 'search');
          const total = totalExpenses(allFound);
          const months = [...new Set(allFound.map(e => e.date.slice(0, 7)))].sort();
          reply(`No results in ${periodLabel}, but found ${allFound.length} matching transaction${allFound.length !== 1 ? 's' : ''} overall, totalling ${fmt(total)} (${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}).`, {
            suggestions: ['Show all spending', 'Goal status', 'Help'],
          });
        } else {
          reply(`I couldn't find any expenses matching "${keywords.join(', ')}". Try a different term or ask me something else.`, {
            suggestions: ['Show spending', 'Goal status', 'Help'],
          });
        }
        return;
      }

      saveContext(keywords.join(' '), period, 'search');
      const total = totalExpenses(found);
      let msg = `Found ${found.length} transaction${found.length !== 1 ? 's' : ''} matching "${keywords.join(', ')}" in ${periodLabel}, totalling ${fmt(total)}.`;

      if (found.length <= 10) {
        msg += '\n' + found.map(e => `• ${e.title}: ${fmt(e.amount)} (${e.category || 'No category'}, ${e.date})`).join('\n');
      } else {
        const cats = categoryBreakdown(found);
        msg += '\n\nBy category:';
        for (const c of cats.slice(0, 6)) {
          msg += `\n• ${c.name}: ${fmt(c.total)}`;
        }
      }

      if (period && (period.type === 'year' || period.type === 'range') && found.length > 2) {
        const monthMap = {};
        for (const e of found) {
          const ym = e.date.slice(0, 7);
          monthMap[ym] = (monthMap[ym] || 0) + convertToBase(e.amount, getAccountCurrency(e.accountId));
        }
        const trendData = Object.keys(monthMap).sort().map(ym => ({ month: ym, total: Math.round(monthMap[ym] * 100) / 100 }));
        reply(msg, {
          chart: trendData.length > 1 ? buildTrendChart(trendData.slice(-12)) : null,
          suggestions: ['Show all spending', 'Goal status', 'Compare months'],
        });
      } else {
        reply(msg, { suggestions: ['Show all spending', 'Goal status', 'Compare months'] });
      }
    }

    function handleGoalStatus() {
      if (smartInsightsMode.value) {
        reply("Category goals require expense logging to track per-category spending. Enable Expenses in your group settings, or ask me about your overall estimated spending and savings rate.", {
          suggestions: ['Show spending', 'Savings rate', 'Smart Insights'],
        });
        return;
      }
      const goals = getGoals();
      const tm = thisMonth();
      const monthExp = expensesForMonth(tm);
      const cats = categoryBreakdown(monthExp);
      const totalSpent = totalExpenses(monthExp);
      const totalGoal = Object.values(goals).reduce((s, g) => s + g, 0);

      if (Object.keys(goals).length === 0) {
        reply(`You've spent ${fmt(totalSpent)} this month, but you haven't set any category goals yet. You can set them in the Average Monthly Expenses widget on the Home page.`, {
          suggestions: ['Go home', 'Show spending', 'What are goals?'],
        });
        return;
      }

      let overCount = 0;
      for (const [cat, goal] of Object.entries(goals)) {
        const spent = cats.find(c => c.name === cat)?.total || 0;
        if (spent > goal) overCount++;
      }

      const remaining = totalGoal - totalSpent;
      let summary = `Total spent this month: ${fmt(totalSpent)}\nTotal monthly goal: ${fmt(totalGoal)}`;
      if (remaining >= 0) {
        summary += `\n${fmt(remaining)} remaining within budget.`;
      } else {
        summary += `\n${fmt(Math.abs(remaining))} over budget overall.`;
      }
      if (overCount > 0) {
        summary += ` (${overCount} categor${overCount > 1 ? 'ies' : 'y'} over)`;
      }

      reply(summary, {
        chart: buildGoalChart(
          Object.keys(goals).map(name => ({ name, total: cats.find(c => c.name === name)?.total || 0 })),
          goals
        ),
        suggestions: ['Spending breakdown', 'Compare months', 'Tips'],
      });
    }

    function handleCompare() {
      const tm = thisMonth();
      const lm = lastMonth();

      if (smartInsightsMode.value) {
        const thisEst = estimatedSpendingForMonth(tm);
        const lastEst = estimatedSpendingForMonth(lm);
        const thisVal = thisEst !== null ? Math.max(0, thisEst) : 0;
        const lastVal = lastEst !== null ? Math.max(0, lastEst) : 0;
        let text = `${monthLabel(tm)}: est. ${fmt(thisVal)} vs ${monthLabel(lm)}: est. ${fmt(lastVal)}.`;
        if (lastVal > 0) {
          const change = (thisVal - lastVal) / lastVal;
          text += ` That's ${change >= 0 ? '+' : ''}${pct(change)}%.`;
        }
        text += '\n\n_Estimates based on balance changes and income._';
        reply(text, { suggestions: ['Spending trend', 'Savings rate', 'Net worth'] });
        return;
      }

      const thisTotal = totalExpenses(expensesForMonth(tm));
      const lastTotal = totalExpenses(expensesForMonth(lm));
      const thisCats = categoryBreakdown(expensesForMonth(tm));
      const lastCats = categoryBreakdown(expensesForMonth(lm));

      let text = `${monthLabel(tm)}: ${fmt(thisTotal)} vs ${monthLabel(lm)}: ${fmt(lastTotal)}.`;
      if (lastTotal > 0) {
        const change = ((thisTotal - lastTotal) / lastTotal);
        text += ` That's ${change >= 0 ? '+' : ''}${pct(change)}%.`;
      }

      const diffs = [];
      const allCats = new Set([...thisCats.map(c => c.name), ...lastCats.map(c => c.name)]);
      for (const cat of allCats) {
        const thisAmt = thisCats.find(c => c.name === cat)?.total || 0;
        const lastAmt = lastCats.find(c => c.name === cat)?.total || 0;
        const diff = thisAmt - lastAmt;
        if (Math.abs(diff) > 10) diffs.push({ name: cat, diff });
      }
      diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

      if (diffs.length > 0) {
        text += '\n\nBiggest changes:';
        for (const d of diffs.slice(0, 4)) {
          text += `\n${d.name}: ${d.diff >= 0 ? '+' : ''}${fmt(d.diff)}`;
        }
      }

      reply(text, { suggestions: ['Goal status', 'Spending trend', 'Tips'] });
    }

    function handleTrend() {
      const months = [];
      const n = now();
      for (let i = 5; i >= 0; i--) {
        const d = new Date(n.getFullYear(), n.getMonth() - i, 1);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (smartInsightsMode.value) {
          const est = estimatedSpendingForMonth(ym);
          months.push({ month: ym, total: est !== null ? Math.max(0, Math.round(est * 100) / 100) : 0 });
        } else {
          months.push({ month: ym, total: Math.round(totalExpenses(expensesForMonth(ym)) * 100) / 100 });
        }
      }
      const avg = months.reduce((s, m) => s + m.total, 0) / months.length;
      const prefix = smartInsightsMode.value ? 'estimated ' : '';
      reply(`Here's your ${prefix}spending over the last 6 months. Your average is ${fmt(avg)}/month.`, {
        chart: buildTrendChart(months),
        suggestions: smartInsightsMode.value
          ? ['Savings rate', 'Net worth', 'Show spending']
          : ['Goal status', 'Compare months', 'Show spending'],
      });
    }

    function handleIncome() {
      const tm = thisMonth();
      const lm = lastMonth();
      const thisTotal = totalIncome(incomeForMonth(tm));
      const lastTotal = totalIncome(incomeForMonth(lm));
      const thisCats = categoryBreakdown(incomeForMonth(tm));

      let text = `Income this month: ${fmt(thisTotal)}.`;
      if (lastTotal > 0) text += ` Last month: ${fmt(lastTotal)}.`;

      let expTotal;
      if (smartInsightsMode.value) {
        const est = estimatedSpendingForMonth(tm);
        expTotal = est !== null ? Math.max(0, est) : 0;
      } else {
        expTotal = totalExpenses(expensesForMonth(tm));
      }
      if (thisTotal > 0 && expTotal > 0) {
        const saved = thisTotal - expTotal;
        const prefix = smartInsightsMode.value ? 'Est. net' : 'Net';
        text += ` ${prefix}: ${saved >= 0 ? '+' : ''}${fmt(saved)}.`;
      }
      reply(text, {
        chart: thisCats.length > 0 ? buildBarChart(thisCats, 'name', 'total') : null,
        suggestions: ['Show spending', 'Savings rate', 'Go to income'],
      });
    }

    function handleNetWorth() {
      const nw = getNetWorth();
      const accs = (props.accounts || []).filter(a => a.discontinued !== 'true');
      const lines = accs.map(a => {
        const bal = getCurrentBalance(a.id);
        return `${a.name}: ${bal !== null ? fmt(bal) : 'No data'}`;
      });
      reply(`Your net worth is ${fmt(nw)} across ${accs.length} account${accs.length !== 1 ? 's' : ''}.`, {
        table: lines,
        suggestions: ['Update balances', 'Go to accounts', 'Spending trend'],
      });
    }

    function handleBalance() {
      const accs = (props.accounts || []).filter(a => a.discontinued !== 'true');
      if (accs.length === 0) {
        reply("You haven't added any accounts yet.", { suggestions: ['Go to accounts', 'Getting started'] });
        return;
      }
      const lines = accs.map(a => {
        const bal = getCurrentBalance(a.id);
        return `${a.name}: ${bal !== null ? fmt(bal) : 'No data'}`;
      });
      reply('Here are your account balances:', { table: lines, suggestions: ['Net worth', 'Update balances', 'Go to accounts'] });
    }

    function handleBiggestExpense() {
      if (smartInsightsMode.value) {
        reply("I can't identify individual expenses without expense logging. With Smart Insights, I estimate your total spending from balance changes. Enable Expenses for detailed transaction tracking.", {
          suggestions: ['Show spending', 'Spending trend', 'Smart Insights'],
        });
        return;
      }
      const tm = thisMonth();
      const monthExp = expensesForMonth(tm);
      if (monthExp.length === 0) { reply('No expenses this month yet.'); return; }
      const sorted = [...monthExp].sort((a, b) => b.amount - a.amount);
      const top = sorted.slice(0, 5);
      const lines = top.map((e, i) => `${i + 1}. ${e.title}: ${fmt(e.amount)} (${e.category || 'No category'})`);
      reply(`Your biggest expenses this month:`, { table: lines, suggestions: ['Show spending', 'Goal status'] });
    }

    function handleSavingsRate() {
      const tm = thisMonth();
      const inc = totalIncome(incomeForMonth(tm));
      let exp;
      if (smartInsightsMode.value) {
        const est = estimatedSpendingForMonth(tm);
        exp = est !== null ? Math.max(0, est) : 0;
      } else {
        exp = totalExpenses(expensesForMonth(tm));
      }
      if (inc === 0) {
        reply("No income recorded this month, so I can't calculate a savings rate.", { suggestions: ['Add income', 'Show spending'] });
        return;
      }
      const rate = (inc - exp) / inc;
      const saved = inc - exp;
      const prefix = smartInsightsMode.value ? 'est. ' : '';
      reply(`This month: earned ${fmt(inc)}, ${prefix}spent ${fmt(exp)}. ${saved >= 0 ? 'Saved' : 'Overspent'} ${fmt(Math.abs(saved))} (${pct(rate)}% savings rate).`, {
        suggestions: ['Show spending', 'Income details', 'Spending trend'],
      });
    }

    function handleChart() {
      if (smartInsightsMode.value) {
        const n = now();
        const months = [];
        for (let i = 5; i >= 0; i--) {
          const d = new Date(n.getFullYear(), n.getMonth() - i, 1);
          const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          const est = estimatedSpendingForMonth(ym);
          months.push({ month: ym, total: est !== null ? Math.max(0, Math.round(est * 100) / 100) : 0 });
        }
        reply('Here\'s your estimated spending trend:', {
          chart: buildTrendChart(months),
          suggestions: ['Savings rate', 'Net worth', 'Show spending'],
        });
        return;
      }
      const cats = categoryBreakdown(expensesForMonth(thisMonth()));
      if (cats.length === 0) {
        reply('No expense data to chart this month.', { suggestions: ['Spending trend', 'Show spending'] });
        return;
      }
      reply('Here\'s your spending breakdown by category this month:', {
        chart: buildBarChart(cats, 'name', 'total'),
        suggestions: ['Goal status', 'Spending trend', 'Compare months'],
      });
    }

    // ── Quick actions ────────────────────────────────────────────────────────
    function handleNav(page, label) {
      reply(`Opening ${label}...`);
      setTimeout(() => emit('navigate', page), 400);
    }

    // ── FAQ / Onboarding ─────────────────────────────────────────────────────
    function handleHelp() {
      const hasData = expenses.value.length > 0 || incomeList.value.length > 0 || balanceHistory.value.length > 0;
      if (!hasData) {
        const enabledTools = (props.settings?.listsEnabled || '').split(',').filter(Boolean);
        const steps = [];
        if (enabledTools.includes('accounts')) steps.push('Go to accounts');
        if (enabledTools.includes('expenses')) steps.push('Go to expenses');
        if (enabledTools.includes('income')) steps.push('Go to income');
        if (enabledTools.includes('fi')) steps.push('FI Calculator');
        steps.push('What is Valu?', 'Privacy');

        const faq = getFaqById('gettingStarted');
        reply("Looks like you haven't logged any data yet.\n\n" + faq.answer, {
          suggestions: steps,
        });
      } else {
        reply("Here are some things I can help with:", {
          suggestions: [
            'Show spending', 'Goal status', 'Compare months', 'Spending trend',
            'Income details', 'Net worth', 'Biggest expenses', 'Tips',
            'What is Valu?', 'Privacy', "What's new",
          ],
        });
      }
    }

    function handleWhatIsValu() {
      const faq = getFaqById('whatIsValu');
      reply(faq.answer, {
        suggestions: ['Smart Insights', 'Getting started', 'Privacy'],
      });
    }

    function handleCategories() {
      const expCats = (props.settings?.expenseCategories || '').split(',').filter(Boolean).map(c => {
        const idx = c.indexOf(':');
        return idx > 0 ? c.slice(0, idx) : c;
      });
      let text = expCats.length > 0
        ? `You have ${expCats.length} expense categories: ${expCats.join(', ')}.`
        : "No expense categories set up yet.";
      text += " You can manage categories from the Expenses page — tap the category dropdown and select 'Manage categories'.";
      reply(text, { suggestions: ['Go to expenses', 'Goal status', 'Show spending'] });
    }

    function handleCurrency() {
      const base = baseCurrency.value;
      const rates = currencyRates.value;
      const rateList = Object.entries(rates);
      let text = `Your base currency is ${base}.`;
      if (rateList.length > 0) {
        text += ' Exchange rates: ' + rateList.map(([c, r]) => `1 ${c} = ${r} ${base}`).join(', ') + '.';
      }
      text += ' You can change this in your Group configuration.';
      reply(text, { suggestions: ['Go to groups', 'Show spending'] });
    }

    function handlePrivacy() {
      const faq = getFaqById('privacy');
      reply(faq.answer, {
        suggestions: ['What is Valu?', 'Getting started'],
      });
    }

    function handleWhatsNew() {
      reply("Recent updates include:\n• Expense Categories widget with yearly averages and goals on the Home page\n• Stacked bar chart for category spending visualization\n• Custom styled dialogs replacing browser alerts\n• Browser back/forward navigation support\n• Monthly summaries with real spending data\n• Milestones tracking your progress\n• Balance reminders toggle\n• This assistant!", {
        suggestions: ['Show spending', 'Goal status', 'Getting started'],
      });
    }

    function handleThanks() {
      const responses = [
        "You're welcome! Anything else I can help with?",
        "Happy to help! Let me know if you need anything else.",
        "Glad I could help! Feel free to ask anytime.",
      ];
      reply(responses[Math.floor(Math.random() * responses.length)], {
        suggestions: ['Show spending', 'Goal status', 'Tips'],
      });
    }

    function handleSmartInsightsExplainer() {
      const faq = getFaqById('smartInsights');
      reply(faq.answer, {
        suggestions: ['Show spending', 'Savings rate', 'Spending trend'],
      });
    }

    function handleFaqGeneric(faqId, suggestions) {
      const faq = getFaqById(faqId);
      if (faq) {
        reply(faq.answer, { suggestions });
      } else {
        reply("I don't have info on that yet. Try 'Getting started' or 'What is Valu?'", {
          suggestions: ['Getting started', 'What is Valu?'],
        });
      }
    }

    // ── Contextual tips ──────────────────────────────────────────────────────
    function handleTips() {
      const tips = [];
      const tm = thisMonth();

      const accs = (props.accounts || []).filter(a => a.discontinued !== 'true');
      for (const acc of accs) {
        const entries = balanceHistory.value
          .filter(h => h.accountId === acc.id)
          .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        if (entries.length > 0) {
          const last = entries[0].updatedAt || `${entries[0].year}-${String(entries[0].month).padStart(2, '0')}`;
          const daysSince = Math.floor((now() - new Date(last)) / 86400000);
          if (daysSince > 35) tips.push(`Your ${acc.name} balance hasn't been updated in ${daysSince} days.`);
        }
      }

      if (smartInsightsMode.value) {
        const est = estimatedSpendingForMonth(tm);
        const lastEst = estimatedSpendingForMonth(lastMonth());
        if (est !== null && lastEst !== null && lastEst > 0) {
          const change = (Math.max(0, est) - Math.max(0, lastEst)) / Math.max(0, lastEst);
          if (change > 0.15) tips.push(`Your estimated spending is ${pct(change)}% higher than last month. Consider reviewing your expenses.`);
          else if (change < -0.15) tips.push(`Your estimated spending is ${pct(Math.abs(change))}% lower than last month — nice work!`);
        }
        const inc = totalIncome(incomeForMonth(tm));
        if (est !== null && inc > 0) {
          const rate = (inc - Math.max(0, est)) / inc;
          if (rate > 0.3) tips.push(`Your savings rate is ${pct(rate)}% this month — well above the recommended 20%.`);
          else if (rate < 0.1) tips.push(`Your savings rate is only ${pct(rate)}% this month. Aim for at least 20% to build a healthy buffer.`);
        }
        tips.push("Keep your account balances up to date for the most accurate Smart Insights estimates.");
        if (tips.length <= 1) tips.push("Everything looks solid! Smart Insights is tracking your finances.");
        reply(tips.join('\n\n'), { suggestions: ['Show spending', 'Savings rate', 'Spending trend'] });
        return;
      }

      const goals = getGoals();
      const cats = categoryBreakdown(expensesForMonth(tm));

      for (const [cat, goal] of Object.entries(goals)) {
        const spent = cats.find(c => c.name === cat)?.total || 0;
        if (spent > goal * 1.1) tips.push(`Your ${cat} spending is ${pct((spent - goal) / goal)}% over goal. Consider reviewing recent ${cat.toLowerCase()} expenses.`);
      }

      const avg = monthlyAvg();
      const thisTotal = totalExpenses(expensesForMonth(tm));
      if (avg > 0 && thisTotal > avg * 1.15) {
        tips.push(`You're spending ${pct((thisTotal - avg) / avg)}% above your monthly average. Check which categories are driving the increase.`);
      }

      if (Object.keys(goals).length === 0 && cats.length > 0) {
        tips.push("You haven't set any spending goals yet. Goals help you stay aware of your spending patterns without any nagging.");
      }

      if (tips.length === 0) {
        tips.push("Everything looks good! You're within budget and your data is up to date.");
      }

      reply(tips.join('\n\n'), { suggestions: ['Goal status', 'Show spending', 'Compare months'] });
    }

    // ── Greeting with context ────────────────────────────────────────────────
    function greet() {
      const hour = now().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

      if (smartInsightsMode.value) {
        const tm = thisMonth();
        const est = estimatedSpendingForMonth(tm);
        const inc = totalIncome(incomeForMonth(tm));
        const nw = getNetWorth();

        if (balanceHistory.value.length === 0 && incomeList.value.length === 0) {
          reply(`${greeting}! Smart Insights is active — I'll estimate your spending from balance changes and income. Start by adding your accounts and logging income.`, {
            suggestions: ['What is Valu?', 'Getting started', 'Smart Insights'],
          });
          return;
        }

        let text = `${greeting}! Smart Insights is active.`;
        if (est !== null) {
          text += ` Estimated spending this month: ${fmt(Math.max(0, est))}.`;
          if (inc > 0) {
            const rate = Math.round((inc - Math.max(0, est)) / inc * 100);
            text += ` Savings rate: ${rate}%.`;
          }
        }
        if (nw > 0) text += ` Net worth: ${fmt(nw)}.`;

        reply(text, {
          suggestions: ['Show spending', 'Spending trend', 'Savings rate', 'Smart Insights'],
        });
        return;
      }

      if (expenses.value.length === 0 && incomeList.value.length === 0) {
        reply(`${greeting}! It looks like you're just getting started. I can help you learn about Valu and set things up.`, {
          suggestions: ['What is Valu?', 'Getting started', 'Privacy'],
        });
        return;
      }

      const tm = thisMonth();
      const thisTotal = totalExpenses(expensesForMonth(tm));
      const goals = getGoals();
      const cats = categoryBreakdown(expensesForMonth(tm));

      let contextLine = '';
      const overGoals = [];
      for (const [cat, goal] of Object.entries(goals)) {
        const spent = cats.find(c => c.name === cat)?.total || 0;
        if (spent > goal) overGoals.push(cat);
      }

      if (overGoals.length > 0) {
        contextLine = ` You're over budget on ${overGoals.join(', ')}.`;
      } else if (thisTotal > 0) {
        const avg = monthlyAvg();
        if (avg > 0) {
          const diff = ((thisTotal - avg) / avg);
          if (Math.abs(diff) > 0.05) {
            contextLine = ` That's ${diff > 0 ? pct(diff) + '% above' : pct(Math.abs(diff)) + '% below'} your average.`;
          } else {
            contextLine = ' Right on track with your average.';
          }
        }
      }

      reply(`${greeting}! You've spent ${fmt(thisTotal)} so far this month.${contextLine}`, {
        suggestions: ['Spending breakdown', 'Goal status', 'Tips', 'Compare months'],
      });
    }

    // ── Follow-up detection ──────────────────────────────────────────────────
    const FOLLOWUP_PATTERNS = [
      /^(?:how\s+about|what\s+about|and\s+(?:for|in|what\s+about))\s+(.+)/i,
      /^(?:show|break\s*(?:it|that|this)?\s*down|now)\s+(.+)/i,
      /^(?:and|but)\s+(.+)/i,
    ];
    const TIME_ONLY_PATTERNS = [
      /^(?:(?:how|what)\s+about\s+)?(?:in\s+)?(?:total|overall|all\s*time|ever)\b/i,
      /^(?:(?:how|what)\s+about\s+)?(?:each|every|per|by)\s+month/i,
      /^(?:(?:how|what)\s+about\s+)?(?:this|last)\s+(?:year|month)/i,
      /^(?:(?:how|what)\s+about\s+)?(?:last|past)\s+\d+\s+months?/i,
      /^(?:(?:how|what)\s+about\s+)?(?:monthly|yearly|per\s*month)/i,
      /^(?:(?:how|what)\s+about\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)/i,
      /^(?:(?:how|what)\s+about\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i,
      /^(?:(?:how|what)\s+about\s+)?(?:in\s+)?20\d{2}\??$/i,
      /^(?:(?:how|what)\s+about\s+)?(?:from\s+)?20\d{2}\s+(?:to|through|until|–|-)\s+20\d{2}/i,
      /^(?:and\s+)?(?:in\s+)?(?:total|overall)\b/i,
    ];

    function tryFollowUp(text) {
      if (!lastContext.searchTerm) return null;
      const lower = text.toLowerCase().trim();

      for (const pat of TIME_ONLY_PATTERNS) {
        if (pat.test(lower)) {
          const cleaned = lower.replace(/^how\s+about\s+/i, '').replace(/\?+$/, '').trim();
          const synth = `${lastContext.searchTerm} spending ${cleaned}`;
          return synth;
        }
      }

      for (const pat of FOLLOWUP_PATTERNS) {
        const m = text.match(pat);
        if (m) {
          const rest = m[1].trim().replace(/\?+$/, '');
          const period = parseTimePeriod(rest);
          if (period) {
            const withoutTimeParts = rest
              .replace(/\b20\d{2}\b/g, '')
              .replace(/\b(?:in|for|during|from|of)\b/gi, '');
            if (extractKeywords(withoutTimeParts).length === 0) {
              const synth = `${lastContext.searchTerm} spending ${rest}`;
              return synth;
            }
          }
        }
      }

      return null;
    }

    function saveContext(searchTerm, period, intent) {
      if (searchTerm) lastContext.searchTerm = searchTerm;
      if (period) lastContext.period = period;
      if (intent) lastContext.intent = intent;
    }

    function clearContext() {
      lastContext.searchTerm = null;
      lastContext.period = null;
      lastContext.intent = null;
    }

    // ── Intent router ────────────────────────────────────────────────────────
    function processInput(text) {
      addMsg('user', text);
      inputText.value = '';

      const followUp = tryFollowUp(text);
      const effectiveText = followUp || text;

      const intent = matchIntent(effectiveText);
      if (!intent) {
        handleSearchFallback(effectiveText);
        return;
      }

      if (FAQ_SUGGESTION_TO_INTENT[text] || Object.values(FAQ_SUGGESTION_TO_INTENT).includes(intent.id)) {
        answeredFaqIntents.add(intent.id);
      }

      switch (intent.id) {
        case 'greeting':        clearContext(); answeredFaqIntents.clear(); greet(); break;
        case 'spending':
        case 'spendingOverview': handleSpending(effectiveText); break;
        case 'categorySpending': handleCategorySpending(intent.match, effectiveText); break;
        case 'searchExpenses':   handleCategorySpending(intent.match, effectiveText); break;
        case 'goalStatus':      handleGoalStatus(); break;
        case 'compare':         handleCompare(); break;
        case 'trend':           handleTrend(); break;
        case 'income':          handleIncome(); break;
        case 'netWorth':        handleNetWorth(); break;
        case 'balance':         handleBalance(); break;
        case 'biggestExpense':  handleBiggestExpense(); break;
        case 'savingsRate':     handleSavingsRate(); break;
        case 'chart':           handleChart(); break;
        case 'addExpense':      handleNav('expenses', 'Expenses'); break;
        case 'addIncome':       handleNav('income', 'Income'); break;
        case 'goExpenses':      handleNav('expenses', 'Expenses'); break;
        case 'goIncome':        handleNav('income', 'Income'); break;
        case 'goAccounts':      handleNav('accounts', 'Accounts'); break;
        case 'goSettings':      handleNav('settings', 'Settings'); break;
        case 'goGroups':        handleNav('groups', 'Groups'); break;
        case 'goFi':            handleNav('fi', 'FI Calculator'); break;
        case 'updateBalance':   handleNav('accounts', 'Accounts'); break;
        case 'whatsNew':        handleWhatsNew(); break;
        case 'help':            handleHelp(); break;
        case 'whatIsValu':      handleWhatIsValu(); break;
        case 'categories':      handleCategories(); break;
        case 'currency':        handleCurrency(); break;
        case 'privacy':         handlePrivacy(); break;
        case 'smartInsights':   handleSmartInsightsExplainer(); break;
        case 'assistantInfo':   handleFaqGeneric('assistant', ['Smart Insights', 'Privacy', 'Getting started']); break;
        case 'sharing':         handleFaqGeneric('sharing', ['Privacy', 'What is Valu?']); break;
        case 'offline':         handleFaqGeneric('offline', ['Install as app', 'Getting started']); break;
        case 'install':         handleFaqGeneric('install', ['Getting started', 'What is Valu?']); break;
        case 'howGoalsWork':    handleFaqGeneric('goals', ['Goal status', 'Show spending']); break;
        case 'reminders':       handleFaqGeneric('balanceReminders', ['Go to settings', 'Getting started']); break;
        case 'tips':            handleTips(); break;
        case 'thanks':          handleThanks(); break;
        default:
          handleSearchFallback(effectiveText);
      }
    }

    function onSuggestionClick(text) {
      processInput(text);
    }

    function onSend() {
      const text = inputText.value.trim();
      if (!text) return;
      processInput(text);
    }

    function onKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
    }

    // ── Chat persistence ───────────────────────────────────────────────────
    function lsKey() {
      const sid = getSheetId();
      return sid ? `valu_chats_${sid}` : null;
    }

    function saveChatListToLocalStorage() {
      const key = lsKey();
      if (!key) return;
      try {
        const stripped = chatList.value.map(c => ({
          id: c.id, title: c.title, createdAt: c.createdAt,
          updatedAt: c.updatedAt, messages: c.messages.map(m => ({
            from: m.from, text: m.text, ts: m.ts,
            ...(m.table ? { table: m.table } : {}),
            ...(m.suggestions ? { suggestions: m.suggestions } : {}),
            ...(m.chart ? { hadChart: true } : {}),
          })),
        }));
        localStorage.setItem(key, JSON.stringify(stripped));
      } catch { /* quota exceeded — acceptable */ }
    }

    function loadChatListFromLocalStorage() {
      const key = lsKey();
      if (!key) return [];
      try {
        return JSON.parse(localStorage.getItem(key) || '[]');
      } catch { return []; }
    }

    function serializeMessagesForSheet(msgs) {
      return JSON.stringify(msgs.map(m => ({
        from: m.from, text: m.text, ts: m.ts,
        ...(m.table ? { table: m.table } : {}),
        ...(m.suggestions ? { suggestions: m.suggestions } : {}),
        ...(m.chart ? { hadChart: true } : {}),
      })));
    }

    async function ensureChatTab() {
      if (chatTabEnsured) return;
      const sid = getSheetId();
      if (!sid || isDemoSheet(sid)) { chatTabEnsured = true; return; }
      try {
        await SheetsApi.ensureTab(sid, TABS.CHAT_HISTORY);
        chatTabEnsured = true;
      } catch (err) {
        console.error('Assistant: failed to ensure ChatHistory tab', err);
      }
    }

    async function syncChatToSheet(chat) {
      const sid = getSheetId();
      if (!sid || isDemoSheet(sid)) return;
      await ensureChatTab();
      const msgJson = serializeMessagesForSheet(chat.messages);
      const row = [chat.id, chat.title, chat.createdAt, chat.updatedAt, msgJson];
      try {
        await SheetsApi.updateRow(sid, TABS.CHAT_HISTORY, chat.id, row);
      } catch {
        try {
          await SheetsApi.appendRow(sid, TABS.CHAT_HISTORY, row);
        } catch (err) {
          console.error('Assistant: failed to save chat to sheet', err);
        }
      }
    }

    function scheduleSyncToSheet() {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        const chat = chatList.value.find(c => c.id === activeChatId.value);
        if (chat) syncChatToSheet(chat);
      }, 2000);
    }

    function flushSync() {
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
        const chat = chatList.value.find(c => c.id === activeChatId.value);
        if (chat) syncChatToSheet(chat);
      }
    }

    async function loadChatHistory() {
      const cached = loadChatListFromLocalStorage();
      if (cached.length > 0) {
        chatList.value = cached;
      }

      const sid = getSheetId();
      if (!sid || isDemoSheet(sid)) return;

      try {
        await ensureChatTab();
        const rows = await SheetsApi.getValues(sid, `${TABS.CHAT_HISTORY}!A2:E`);
        if (rows && rows.length > 0) {
          const sheetChats = rows.map(r => {
            let msgs = [];
            try { msgs = JSON.parse(r[4] || '[]'); } catch { /* ignore */ }
            return {
              id: r[0], title: r[1] || 'Untitled',
              createdAt: r[2] || '', updatedAt: r[3] || '',
              messages: msgs,
            };
          });
          const merged = new Map();
          for (const c of cached) merged.set(c.id, c);
          for (const c of sheetChats) {
            const existing = merged.get(c.id);
            if (!existing || c.updatedAt > existing.updatedAt) {
              merged.set(c.id, c);
            }
          }
          chatList.value = [...merged.values()]
            .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
          saveChatListToLocalStorage();
        }
      } catch (err) {
        console.error('Assistant: failed to load chat history from sheet', err);
      }
    }

    function createNewChat(greetAfterData) {
      flushSync();
      clearContext();
      answeredFaqIntents.clear();
      const id = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const chat = { id, title: 'New chat', createdAt: nowIso, updatedAt: nowIso, messages: [] };
      chatList.value.unshift(chat);
      activeChatId.value = id;
      messages.value = chat.messages;
      showHistory.value = false;
      if (!greetAfterData) greet();
      saveChatListToLocalStorage();
      scheduleSyncToSheet();
    }

    function openChat(chatId) {
      flushSync();
      clearContext();
      answeredFaqIntents.clear();
      const chat = chatList.value.find(c => c.id === chatId);
      if (!chat) return;
      activeChatId.value = chatId;
      messages.value = chat.messages;
      showHistory.value = false;
      nextTick(() => {
        if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
      });
    }

    async function deleteChat(chatId) {
      const idx = chatList.value.findIndex(c => c.id === chatId);
      if (idx === -1) return;
      chatList.value.splice(idx, 1);
      saveChatListToLocalStorage();

      const sid = getSheetId();
      if (sid && !isDemoSheet(sid)) {
        try {
          await ensureChatTab();
          await SheetsApi.deleteRows(sid, TABS.CHAT_HISTORY, [chatId]);
        } catch (err) {
          console.error('Assistant: failed to delete chat from sheet', err);
        }
      }

      if (chatId === activeChatId.value) {
        if (chatList.value.length > 0) {
          openChat(chatList.value[0].id);
        } else {
          createNewChat(false);
        }
      }
    }

    function onNewMessage() {
      const chat = chatList.value.find(c => c.id === activeChatId.value);
      if (!chat) return;
      chat.updatedAt = new Date().toISOString();
      if (chat.title === 'New chat') {
        const firstUser = chat.messages.find(m => m.from === 'user');
        if (firstUser) {
          chat.title = firstUser.text.length > 50
            ? firstUser.text.slice(0, 47) + '...'
            : firstUser.text;
        }
      }
      saveChatListToLocalStorage();
      scheduleSyncToSheet();
    }

    const activeChat = computed(() => chatList.value.find(c => c.id === activeChatId.value));

    function chatPreview(chat) {
      const last = [...chat.messages].reverse().find(m => m.from === 'valu');
      if (last) return last.text.length > 60 ? last.text.slice(0, 57) + '...' : last.text;
      return 'Empty chat';
    }

    function formatChatDate(iso) {
      if (!iso) return '';
      try {
        const d = new Date(iso);
        const today = new Date();
        if (d.toDateString() === today.toDateString()) {
          return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        }
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      } catch { return ''; }
    }

    // ── Data loading ─────────────────────────────────────────────────────────
    async function fetchData() {
      const sheetId = getSheetId();
      if (!sheetId) { loading.value = false; return; }
      loading.value = true;
      try {
        const [expRows, incRows, balRows] = await Promise.all([
          enabledLists.value.includes('expenses')
            ? SheetsApi.getTabData(sheetId, TABS.EXPENSES) : Promise.resolve([]),
          enabledLists.value.includes('income')
            ? SheetsApi.getTabData(sheetId, TABS.INCOME) : Promise.resolve([]),
          enabledLists.value.includes('accounts')
            ? SheetsApi.getValues(sheetId, 'BalanceHistory!A2:E').catch(() => []) : Promise.resolve([]),
        ]);
        expenses.value = expRows.map(r => ({
          id: r[0], title: r[1], amount: parseFloat(r[2]) || 0,
          accountId: r[3], category: r[4], date: r[5],
        }));
        incomeList.value = incRows.map(r => ({
          id: r[0], title: r[1], amount: parseFloat(r[2]) || 0,
          accountId: r[3], category: r[4], date: r[5],
        }));
        balanceHistory.value = balRows.map(r => ({
          accountId: r[0], year: parseInt(r[1]), month: parseInt(r[2]),
          balance: Math.round((parseFloat(r[3]) || 0) * 100) / 100,
          updatedAt: r[4],
        }));
      } catch (err) {
        console.error('Assistant: failed to load data', err);
      }

      await loadChatHistory();

      if (chatList.value.length > 0 && !activeChatId.value) {
        openChat(chatList.value[0].id);
      } else if (!activeChatId.value) {
        createNewChat(true);
        greet();
      }

      loading.value = false;
    }

    watch(() => props.sheetId, fetchData);
    onMounted(fetchData);
    onBeforeUnmount(flushSync);

    return {
      messages, inputText, messagesEl, inputEl, loading,
      onSend, onKeydown, onSuggestionClick, fmt,
      emit,
      chatList, activeChatId, showHistory, activeChat,
      createNewChat, openChat, deleteChat, chatPreview, formatChatDate,
    };
  },

  template: `
    <div class="assistant-page">
      <div class="subpage-nav">
        <button class="subpage-back" @click="showHistory ? (showHistory = false) : emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <div class="subpage-title-area">
          <h2 class="subpage-title">{{ showHistory ? 'Chat history' : 'Valu assistant' }}</h2>
          <div v-if="!showHistory && activeChat && activeChat.title !== 'New chat'"
               class="assistant-chat-subtitle">{{ activeChat.title }}</div>
        </div>
        <div class="assistant-topbar-actions">
          <button class="assistant-topbar-btn" @click="showHistory = !showHistory"
                  :title="showHistory ? 'Back to chat' : 'Chat history'">
            <span class="material-icons">{{ showHistory ? 'chat' : 'forum' }}</span>
          </button>
          <button v-if="!showHistory" class="assistant-topbar-btn" @click="createNewChat(false)" title="New chat">
            <span class="material-icons">add_comment</span>
          </button>
        </div>
      </div>

      <div v-if="showHistory" class="assistant-history">
        <div v-if="chatList.length === 0" class="assistant-history-empty">
          No conversations yet.
        </div>
        <div v-for="chat in chatList" :key="chat.id" class="assistant-history-item"
             :class="{ 'assistant-history-item--active': chat.id === activeChatId }"
             @click="openChat(chat.id)">
          <div class="assistant-history-item-content">
            <div class="assistant-history-item-title">{{ chat.title }}</div>
            <div class="assistant-history-item-preview">{{ chatPreview(chat) }}</div>
          </div>
          <div class="assistant-history-item-meta">
            <span class="assistant-history-item-date">{{ formatChatDate(chat.updatedAt) }}</span>
            <button class="assistant-history-item-delete" @click.stop="deleteChat(chat.id)" title="Delete">
              <span class="material-icons">delete_outline</span>
            </button>
          </div>
        </div>
      </div>

      <template v-if="!showHistory">
        <div class="assistant-messages" ref="messagesEl">
          <div v-if="loading" class="assistant-loading">
            <span class="material-icons assistant-loading-icon">hourglass_top</span>
            Loading your data...
          </div>

          <div v-for="(msg, i) in messages" :key="i"
               class="assistant-msg" :class="'assistant-msg--' + msg.from">
            <div class="assistant-msg-row">
              <div v-if="msg.from === 'valu'" class="assistant-avatar">
                <div class="valu-orb-xs"><div class="spheres"><div class="spheres-group">
                  <div class="sphere s1"></div><div class="sphere s2"></div><div class="sphere s3"></div>
                </div></div></div>
              </div>
              <div class="assistant-bubble" :class="'assistant-bubble--' + msg.from">
                <div class="assistant-label">{{ msg.from === 'valu' ? 'Valu' : 'You' }}</div>
                <div class="assistant-text" v-html="msg.text.replace(/\\n/g, '<br>')"></div>

                <div v-if="msg.table" class="assistant-table">
                  <div v-for="(line, li) in msg.table" :key="li" class="assistant-table-row">{{ line }}</div>
                </div>

                <div v-if="msg.hadChart && !msg.chart" class="assistant-chart-note">
                  <span class="material-icons" style="font-size:14px;vertical-align:middle;">bar_chart</span>
                  Chart was generated here
                </div>

                <div v-if="msg.chart && msg.chart.type === 'bar'" class="assistant-chart">
                  <div v-for="(item, ci) in msg.chart.items" :key="ci" class="assistant-chart-bar-row">
                    <span class="assistant-chart-label">{{ item.label }}</span>
                    <div class="assistant-chart-track">
                      <div class="assistant-chart-fill" :style="{ width: item.pct + '%', background: item.color }"></div>
                    </div>
                    <span class="assistant-chart-value">{{ item.formatted }}</span>
                  </div>
                </div>

                <div v-if="msg.chart && msg.chart.type === 'goal'" class="assistant-chart">
                  <div v-for="(item, ci) in msg.chart.items" :key="ci" class="assistant-chart-bar-row">
                    <span class="assistant-chart-label">{{ item.label }}</span>
                    <div class="assistant-chart-track">
                      <div class="assistant-chart-fill"
                           :style="{ width: Math.min(item.pct || 0, 100) + '%', background: item.over ? 'var(--color-secondary)' : item.color }"></div>
                      <div v-if="item.goal" class="assistant-chart-goal-line" :style="{ left: '100%' }"></div>
                    </div>
                    <span class="assistant-chart-value" :style="{ color: item.over ? 'var(--color-secondary)' : '' }">
                      {{ item.formatted }}<span v-if="item.goalFormatted" style="opacity:.5;"> / {{ item.goalFormatted }}</span>
                    </span>
                  </div>
                </div>

                <div v-if="msg.chart && msg.chart.type === 'trend'" class="assistant-chart assistant-chart--trend">
                  <div v-for="(item, ci) in msg.chart.items" :key="ci" class="assistant-trend-col">
                    <div class="assistant-trend-bar" :style="{ height: item.pct + '%' }" :title="item.formatted"></div>
                    <div class="assistant-trend-label">{{ item.label }}</div>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="msg.suggestions && msg.from === 'valu'" class="assistant-suggestions">
              <button v-for="s in msg.suggestions" :key="s" class="assistant-suggestion"
                      @click="onSuggestionClick(s)">{{ s }}</button>
            </div>
          </div>
        </div>

        <div class="assistant-input-bar">
          <input class="assistant-input" ref="inputEl"
                 v-model="inputText"
                 @keydown="onKeydown"
                 placeholder="Type here.." />
          <button class="assistant-send" @click="onSend" :disabled="!inputText.trim()">
            <span class="material-icons">send</span>
          </button>
        </div>
      </template>
    </div>
  `,
};
