/**
 * Built-in Demo group: in-memory only, no Google Sheet, edits are not persisted.
 */

export const DEMO_SHEET_ID = '__valu_demo__';

export function isDemoSheet(id) {
  return id === DEMO_SHEET_ID;
}

export function demoGroupMeta() {
  return {
    id: DEMO_SHEET_ID,
    name: 'Valu: Demo',
    modifiedTime: new Date().toISOString(),
  };
}

/** Key-value settings as consumed by the app (object). */
export function demoSettingsObject() {
  return {
    groupName: 'Demo',
    baseCurrency: 'EUR',
    listsEnabled: 'accounts,expenses,income',
    expenseCategories: 'Groceries,Transport,Utilities,Dining',
    incomeCategories: 'Salary,Freelance,Other',
    currencyRates: 'USD:0.92,GBP:1.17',
    createdAt: '',
    createdBy: '',
  };
}

/** Accounts rows (sheet row shape, no header). */
export function demoAccountsRows() {
  return [
    ['demo_acc_1', 'Main checking', 'EUR', 'checking', 'false', '1'],
    ['demo_acc_2', 'Savings', 'EUR', 'savings', 'false', '2'],
  ];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** ~12 months of balance history for two accounts (wavy growth toward ~21.8k total). */
export function demoBalanceHistoryRows() {
  const rows = [];
  const now = new Date();
  for (let back = 11; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const t = (11 - back) / 11;
    const wave = Math.sin(t * Math.PI * 2) * 400;
    const base1 = 12000 + t * 6200 + wave;
    const base2 = 4500 + t * 2100 - wave * 0.3;
    rows.push(
      ['demo_acc_1', String(y), String(m), base1.toFixed(2), `${y}-${pad2(m)}-01`],
      ['demo_acc_2', String(y), String(m), base2.toFixed(2), `${y}-${pad2(m)}-01`],
    );
  }
  return rows;
}

const EXPENSE_TITLES = [
  ['Weekly groceries', 'Groceries', 82.5],
  ['Train ticket', 'Transport', 34],
  ['Electric bill', 'Utilities', 112.3],
  ['Coffee & snacks', 'Dining', 18.75],
  ['Pharmacy', 'Groceries', 45.2],
  ['Restaurant', 'Dining', 64],
  ['Fuel', 'Transport', 58.9],
  ['Internet', 'Utilities', 39.99],
];

const INCOME_TITLES = [
  ['Salary deposit', 'Salary', 3200],
  ['Side project', 'Freelance', 450],
  ['Cashback', 'Other', 12.5],
];

/** Expense rows for last ~12 months (sparse). */
export function demoExpenseRows() {
  const rows = [];
  const now = new Date();
  let id = 1;
  for (let back = 0; back < 12; back++) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 15 - (back % 7));
    const ds = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const [title, cat, amt] = EXPENSE_TITLES[(back + id) % EXPENSE_TITLES.length];
    rows.push([
      `demo_exp_${id}`,
      title,
      String(amt + (back % 5) * 3),
      'demo_acc_1',
      cat,
      ds,
      '',
      ds,
    ]);
    id++;
    if (back % 2 === 0) {
      const [t2, c2, a2] = EXPENSE_TITLES[(id) % EXPENSE_TITLES.length];
      const d2 = new Date(now.getFullYear(), now.getMonth() - back, 22);
      const ds2 = `${d2.getFullYear()}-${pad2(d2.getMonth() + 1)}-${pad2(d2.getDate())}`;
      rows.push([
        `demo_exp_${id}`,
        t2,
        String(a2),
        'demo_acc_1',
        c2,
        ds2,
        '',
        ds2,
      ]);
      id++;
    }
  }
  return rows;
}

export function demoIncomeRows() {
  const rows = [];
  const now = new Date();
  let id = 1;
  for (let back = 0; back < 12; back++) {
    const day = Math.min(28, 1 + (back % 5) * 5);
    const d = new Date(now.getFullYear(), now.getMonth() - back, day);
    const ds = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const [title, cat, amt] = INCOME_TITLES[back % INCOME_TITLES.length];
    rows.push([
      `demo_inc_${id}`,
      title,
      String(amt),
      'demo_acc_1',
      cat,
      ds,
      '',
      ds,
    ]);
    id++;
  }
  return rows;
}

/** Map Settings!A2:B style range to rows. */
function demoSettingsRows() {
  const o = demoSettingsObject();
  return [
    ['groupName', o.groupName],
    ['baseCurrency', o.baseCurrency],
    ['listsEnabled', o.listsEnabled],
    ['expenseCategories', o.expenseCategories],
    ['incomeCategories', o.incomeCategories],
    ['currencyRates', o.currencyRates],
    ['createdAt', o.createdAt],
    ['createdBy', o.createdBy],
  ];
}

/**
 * Return cell rows for a Sheets range (used by getValues).
 * @param {string} range e.g. "Settings!A2:B" or "Accounts!A2:Z"
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

/** Accounts list shape used by index.html / pages. */
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
