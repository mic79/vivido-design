/**
 * Built-in Demo group: in-memory only, no Google Sheet, edits are not persisted.
 * Data based on Canadian household averages, dynamically generated for the
 * last 5 years from the current date.
 */

export const DEMO_SHEET_ID = '__valu_demo__';

export function isDemoSheet(id) {
  return id === DEMO_SHEET_ID;
}

// In-memory settings overrides — persist within the session only
const _demoOverrides = {};

export function setDemoOverride(key, value) {
  _demoOverrides[key] = value;
}

export function setDemoOverrides(obj) {
  for (const [k, v] of Object.entries(obj)) {
    _demoOverrides[k] = v;
  }
}

export function getDemoSettings() {
  return { ...demoSettingsObject(), ..._demoOverrides };
}

export function demoGroupMeta() {
  return {
    id: DEMO_SHEET_ID,
    name: 'Valu: Demo',
    modifiedTime: new Date().toISOString(),
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function demoSettingsObject() {
  return {
    groupName: 'Demo',
    baseCurrency: 'CAD',
    listsEnabled: 'accounts,expenses,income,fi,forecast',
    expenseCategories: 'Housing:home,Groceries:shopping_cart,Transportation:directions_car,Utilities:bolt,Healthcare:health_and_safety,Debt Payments:credit_card,Personal Care:face,Leisure:local_activity,Miscellaneous:category',
    incomeCategories: 'Salary:work,Bonuses:emoji_events,Investment Income:trending_up,Freelance:laptop,Other Income:attach_money',
    expenseCategoryGoals: 'Housing:1800,Groceries:600,Transportation:400,Utilities:250,Healthcare:150,Debt Payments:300,Personal Care:100,Leisure:350,Miscellaneous:100',
    currencyRates: 'USD:1.36,EUR:1.48',
    createdAt: '',
    createdBy: '',
  };
}

export function demoAccountsRows() {
  return [
    ['demo_acc_chk', 'Chequing', 'CAD', 'checking', 'false', '1'],
    ['demo_acc_sav', 'Savings', 'CAD', 'savings', 'false', '2'],
    ['demo_acc_cc', 'Credit Card', 'CAD', 'credit', 'false', '3'],
  ];
}

const MONTHS_BACK = 60;

// Canadian average monthly expenses by category (approximate CAD)
const EXPENSE_TEMPLATES = [
  { cat: 'Housing',        base: 1750, variance: 100,  titles: ['Rent', 'Mortgage payment', 'Property tax', 'Home insurance', 'Condo fees'] },
  { cat: 'Groceries',      base: 520,  variance: 120,  titles: ['Grocery run', 'Superstore', 'No Frills', 'Costco trip', 'Walmart groceries', 'Metro'] },
  { cat: 'Transportation', base: 380,  variance: 100,  titles: ['Gas', 'Car insurance', 'Presto reload', 'Parking', 'Car maintenance', 'Oil change', 'Transit pass'] },
  { cat: 'Utilities',      base: 220,  variance: 60,   titles: ['Hydro bill', 'Internet bill', 'Phone bill', 'Natural gas', 'Water bill'] },
  { cat: 'Healthcare',     base: 120,  variance: 80,   titles: ['Pharmacy', 'Dental cleaning', 'Physio', 'Eye exam', 'Gym membership'] },
  { cat: 'Debt Payments',  base: 280,  variance: 50,   titles: ['Student loan', 'Credit card payment', 'Line of credit', 'Car loan'] },
  { cat: 'Personal Care',  base: 85,   variance: 40,   titles: ['Haircut', 'Cosmetics', 'Clothing', 'Dry cleaning', 'Shoes'] },
  { cat: 'Leisure',        base: 310,  variance: 120,  titles: ['Restaurant', 'Netflix', 'Spotify', 'Movie tickets', 'Coffee shop', 'Bar night', 'Concert tickets', 'Hobby supplies'] },
  { cat: 'Miscellaneous',  base: 90,   variance: 60,   titles: ['Gift', 'Donation', 'Amazon order', 'Office supplies', 'Pet food'] },
];

const INCOME_TEMPLATES = [
  { cat: 'Salary',            base: 4800, variance: 0,    titles: ['Salary deposit'] },
  { cat: 'Bonuses',           base: 400,  variance: 300,  titles: ['Performance bonus', 'Year-end bonus'], frequency: 0.15 },
  { cat: 'Investment Income', base: 120,  variance: 80,   titles: ['Dividend payment', 'Interest income', 'Capital gain'], frequency: 0.3 },
  { cat: 'Freelance',         base: 350,  variance: 200,  titles: ['Freelance project', 'Side gig', 'Consulting'], frequency: 0.4 },
  { cat: 'Other Income',      base: 80,   variance: 60,   titles: ['Tax refund', 'Cashback', 'Gift money'], frequency: 0.2 },
];

export function demoExpenseRows() {
  const rows = [];
  const now = new Date();
  const rand = seededRandom(42);
  let id = 1;

  for (let back = 0; back < MONTHS_BACK; back++) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const y = monthDate.getFullYear();
    const m = monthDate.getMonth() + 1;
    const daysInMonth = new Date(y, m, 0).getDate();
    const inflation = 1 + (MONTHS_BACK - back) * 0.003;

    for (const tmpl of EXPENSE_TEMPLATES) {
      const numEntries = tmpl.base > 400 ? 1 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 2);
      const totalTarget = (tmpl.base + (rand() - 0.5) * 2 * tmpl.variance) * inflation;

      for (let e = 0; e < numEntries; e++) {
        const portion = totalTarget / numEntries;
        const amt = Math.round((portion + (rand() - 0.5) * portion * 0.3) * 100) / 100;
        if (amt <= 0) continue;
        const day = Math.max(1, Math.min(daysInMonth, 1 + Math.floor(rand() * daysInMonth)));
        const ds = `${y}-${pad2(m)}-${pad2(day)}`;
        const title = tmpl.titles[Math.floor(rand() * tmpl.titles.length)];
        const acc = tmpl.cat === 'Groceries' || tmpl.cat === 'Leisure'
          ? (rand() > 0.4 ? 'demo_acc_cc' : 'demo_acc_chk')
          : 'demo_acc_chk';

        rows.push([`demo_exp_${id++}`, title, String(amt), acc, tmpl.cat, ds, '', ds]);
      }
    }
  }

  return rows;
}

export function demoIncomeRows() {
  const rows = [];
  const now = new Date();
  const rand = seededRandom(99);
  let id = 1;

  for (let back = 0; back < MONTHS_BACK; back++) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const y = monthDate.getFullYear();
    const m = monthDate.getMonth() + 1;
    const inflation = 1 + (MONTHS_BACK - back) * 0.004;

    for (const tmpl of INCOME_TEMPLATES) {
      const freq = tmpl.frequency || 1;
      if (rand() > freq) continue;
      const amt = Math.round(((tmpl.base + (rand() - 0.5) * 2 * tmpl.variance) * inflation) * 100) / 100;
      if (amt <= 0) continue;
      const day = Math.min(28, 1 + Math.floor(rand() * 27));
      const ds = `${y}-${pad2(m)}-${pad2(day)}`;
      const title = tmpl.titles[Math.floor(rand() * tmpl.titles.length)];

      rows.push([`demo_inc_${id++}`, title, String(amt), 'demo_acc_chk', tmpl.cat, ds, '', ds]);
    }
  }

  return rows;
}

export function demoBalanceHistoryRows() {
  const expRows = demoExpenseRows();
  const incRows = demoIncomeRows();
  const now = new Date();
  const rand = seededRandom(77);

  const monthlyNet = {};
  for (const r of incRows) {
    const ym = r[5].slice(0, 7);
    monthlyNet[ym] = (monthlyNet[ym] || 0) + (parseFloat(r[2]) || 0);
  }
  for (const r of expRows) {
    const ym = r[5].slice(0, 7);
    monthlyNet[ym] = (monthlyNet[ym] || 0) - (parseFloat(r[2]) || 0);
  }

  let chk = 5200;
  let sav = 8000;
  let cc = -800;
  const rows = [];

  for (let back = MONTHS_BACK; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const net = monthlyNet[`${y}-${pad2(m)}`] || 0;

    const ccDrift = (rand() - 0.5) * 200;
    let ccChange = ((-800 + ccDrift) - cc) * 0.3;
    const ccNew = cc + ccChange;
    if (ccNew > -100) ccChange = -100 - cc;
    cc += ccChange;

    const remaining = net - ccChange;
    const toSavings = remaining > 0 ? remaining * (0.35 + rand() * 0.15) : remaining * 0.1;
    sav += toSavings;
    chk += remaining - toSavings;

    const ds = `${y}-${pad2(m)}-01`;
    rows.push(
      ['demo_acc_chk', String(y), String(m), (Math.round(chk * 100) / 100).toFixed(2), ds],
      ['demo_acc_sav', String(y), String(m), (Math.round(sav * 100) / 100).toFixed(2), ds],
      ['demo_acc_cc',  String(y), String(m), (Math.round(cc * 100) / 100).toFixed(2), ds],
    );
  }
  return rows;
}

function demoSettingsRows() {
  const o = { ...demoSettingsObject(), ..._demoOverrides };
  return Object.entries(o).map(([k, v]) => [k, v]);
}

/**
 * Return cell rows for a Sheets range (used by getValues).
 */
export function demoValuesForRange(range) {
  const [tabPart] = range.split('!');
  const tab = tabPart.trim();

  switch (tab) {
    case 'Settings':
      return demoSettingsRows();
    case 'Accounts':
      return demoAccountsRows();
    case 'BalanceHistory':
      return demoBalanceHistoryRows();
    case 'Expenses':
      return demoExpenseRows();
    case 'Income':
      return demoIncomeRows();
    default:
      return [];
  }
}

export function demoAccountsList() {
  return demoAccountsRows().map((r) => ({
    id: r[0],
    name: r[1],
    currency: r[2],
    type: r[3],
    discontinued: r[4],
    order: r[5],
  }));
}
