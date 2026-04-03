/**
 * Single source of truth for FAQ content.
 * Used by both FaqPage.js (browsable) and ValuAssistant.js (conversational).
 */

export const FAQ_CATEGORIES = [
  { id: 'basics', label: 'Basics', icon: 'info' },
  { id: 'features', label: 'Features', icon: 'auto_awesome' },
  { id: 'data', label: 'Data & Privacy', icon: 'lock' },
  { id: 'setup', label: 'Setup & Configuration', icon: 'settings' },
];

export const FAQ_ENTRIES = [
  {
    id: 'whatIsValu',
    category: 'basics',
    question: 'What is Valu?',
    answer:
      'Valu is a personal finance tracker that stores all your data in your own Google Sheets \u2014 no servers, no subscriptions, full privacy. ' +
      'You can track expenses, income, account balances, set category goals, and see how your money flows over time.\n\n' +
      'With **Smart Insights**, you can get ~80% of the financial picture with ~10% of the effort \u2014 ' +
      'just track balances and income, and Valu estimates your spending automatically.\n\n' +
      'The **Valu assistant** (tap the animated orb in the top-right corner of any page) can answer questions about your finances, ' +
      'show summaries, and help you navigate the app.\n\nYour data stays yours.',
  },
  {
    id: 'privacy',
    category: 'data',
    question: 'Where is my data stored?',
    answer:
      'Your financial data is stored exclusively in Google Sheets on your own Google Drive. ' +
      'Valu never sends your data to any external server. The app runs entirely in your browser \u2014 ' +
      'even the assistant works 100% on-device with no cloud AI. ' +
      'Only you (and anyone you explicitly share your Sheet with) can access your data.',
  },
  {
    id: 'assistant',
    category: 'features',
    question: 'What is the Valu assistant?',
    answer:
      'The Valu assistant is a built-in helper you can open by tapping the animated orb in the top-right corner of any page.\n\n' +
      'You can ask it things like:\n' +
      '\u2022 "How much did I spend this month?"\n' +
      '\u2022 "Show my savings rate"\n' +
      '\u2022 "Compare this month to last month"\n' +
      '\u2022 "Am I over budget?"\n\n' +
      'The assistant runs entirely on your device \u2014 no data is sent to any server or cloud AI. ' +
      'It reads your financial data locally and generates answers in the browser.',
  },
  {
    id: 'smartInsights',
    category: 'features',
    question: 'What is Smart Insights?',
    answer:
      '**Smart Insights** lets you understand your spending without logging every expense.\n\n' +
      'How it works: Valu looks at changes in your cash accounts (checking, savings, credit) along with your income to estimate monthly spending.\n\n' +
      '\u2022 ~80% of the financial picture with ~10% of the effort\n' +
      '\u2022 Just update your balances monthly and log income\n' +
      '\u2022 Get spending estimates, savings rates, and trends\n' +
      '\u2022 Investment accounts are excluded so market fluctuations don\u2019t distort estimates\n\n' +
      'Want detailed category tracking? Enable Expenses in your group configurations anytime.',
  },
  {
    id: 'sharing',
    category: 'data',
    question: 'How do I share my data with someone?',
    answer:
      'Since your data lives in a Google Sheet, you can share it just like any other Google document:\n\n' +
      '1. Open Google Drive and find the spreadsheet named **Valu: [Your Group]**\n' +
      '2. Right-click \u2192 **Share** (or click the Share button)\n' +
      '3. Add the other person\u2019s email address\n\n' +
      'Once shared, both of you can use Valu with the same data. The other person will see the sheet appear when they sign in to Valu and go to **Groups \u2192 Open shared sheet**.',
  },
  {
    id: 'gettingStarted',
    category: 'setup',
    question: 'How do I get started?',
    answer:
      'After signing in, Valu creates a group with three tools ready to go:\n\n' +
      '1. **Add accounts** \u2014 set up your bank accounts and record balances\n' +
      '2. **Log income** \u2014 track your salary and other earnings\n' +
      '3. **Track expenses** \u2014 log your spending as you go\n\n' +
      'You can also enable the **FI Calculator** to project your path to financial independence.\n\n' +
      'Enable or disable tools and customize categories from your Group configuration.',
  },
  {
    id: 'categories',
    category: 'setup',
    question: 'How do I manage expense and income categories?',
    answer:
      'Categories are configured per group. Go to **Groups**, tap your group, and you\u2019ll see sections for Expense Categories and Income Categories. ' +
      'You can add, remove, reorder, and assign icons to each category. ' +
      'You can also disable categories entirely if you prefer uncategorized tracking.',
  },
  {
    id: 'currency',
    category: 'setup',
    question: 'How do I change my currency?',
    answer:
      'Your base currency is set per group. Go to **Groups**, tap your group, and change the **Base currency** setting. ' +
      'If you have accounts in multiple currencies, you can add exchange rates in the same configuration screen. ' +
      'Valu will convert foreign-currency amounts to your base currency for totals and charts.',
  },
  {
    id: 'groups',
    category: 'basics',
    question: 'What are groups?',
    answer:
      'A group is a separate spreadsheet that holds one set of financial data. You might use different groups for:\n\n' +
      '\u2022 Personal vs. shared household finances\n' +
      '\u2022 Separate budgets or side projects\n' +
      '\u2022 Different time periods\n\n' +
      'Each group has its own accounts, categories, and settings. You can switch between groups from the top bar or side menu.',
  },
  {
    id: 'offline',
    category: 'basics',
    question: 'Does Valu work offline?',
    answer:
      'Valu caches the app for offline access, so the interface loads even without a connection. ' +
      'However, since your data lives in Google Sheets, you need an internet connection to load or save data. ' +
      'Any data already displayed will remain visible while offline.',
  },
  {
    id: 'install',
    category: 'basics',
    question: 'Can I install Valu as an app?',
    answer:
      'Yes! Valu is a Progressive Web App (PWA). On most devices you can install it directly from the browser:\n\n' +
      '\u2022 **Android / Chrome**: tap the install banner or go to the browser menu \u2192 "Add to Home screen"\n' +
      '\u2022 **iOS / Safari**: tap the Share button \u2192 "Add to Home Screen"\n' +
      '\u2022 **Desktop**: click the install icon in the address bar\n\n' +
      'Once installed, Valu opens like a native app with its own icon.',
  },
  {
    id: 'balanceReminders',
    category: 'features',
    question: 'What are balance update reminders?',
    answer:
      'When enabled, Valu shows a reminder on the Home page if any of your accounts haven\u2019t had a balance recorded for the current month. ' +
      'This helps you keep your data up to date for accurate Smart Insights and net worth tracking. ' +
      'You can toggle reminders in **Settings \u2192 Reminders**.',
  },
  {
    id: 'goals',
    category: 'features',
    question: 'How do expense category goals work?',
    answer:
      'You can set a monthly spending target for each expense category. ' +
      'On the Home page, the Expense Categories chart shows your progress against these goals. ' +
      'The assistant can also tell you if you\u2019re over or under budget.\n\n' +
      'Set goals from the Home page by tapping the goal icon next to a category in the expense chart.',
  },
  {
    id: 'whatsNew',
    category: 'basics',
    question: "What's new in Valu?",
    answer:
      'Recent updates include:\n' +
      '\u2022 Year-to-date summary and income trend charts\n' +
      '\u2022 Smarter assistant with context-aware follow-ups\n' +
      '\u2022 Configurable trend periods (e.g. "spending trend last 12 months")\n' +
      '\u2022 FI Calculator auto-populates from your data\n' +
      '\u2022 Balance history preserves the newest entry per month\n' +
      '\u2022 Expense Categories widget with yearly averages and goals\n' +
      '\u2022 Smart Insights for balance-based expense estimation\n' +
      '\u2022 This assistant!',
  },
  {
    id: 'fiCalculator',
    category: 'features',
    question: 'What is the FI Calculator?',
    answer:
      'The **FI Calculator** (Financial Independence Calculator) helps you visualize your path to financial independence.\n\n' +
      'It uses your current net worth, average monthly income and expenses, and expected return on investment to project when your savings could cover your living expenses indefinitely.\n\n' +
      'The calculator auto-populates from your existing Valu data, but you can adjust all inputs. ' +
      'You can enable or disable it from Group Configuration.\n\n' +
      'Financial independence means having enough passive income or savings to cover your living expenses without needing to work.',
  },
];

export function getFaqById(id) {
  return FAQ_ENTRIES.find(e => e.id === id);
}

export function getFaqsByCategory(categoryId) {
  return FAQ_ENTRIES.filter(e => e.category === categoryId);
}
