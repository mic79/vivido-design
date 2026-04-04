/**
 * Recurring transactions service.
 * Scans expenses/income for items with repeats:'monthly'|'yearly'
 * and generates pending copies for months that haven't been checked yet.
 */

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function clampDate(sourceDate, targetYear, targetMonth) {
  const [, , dayStr] = sourceDate.split('-');
  const day = Math.min(parseInt(dayStr, 10), lastDayOfMonth(targetYear, targetMonth));
  const mm = String(targetMonth).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${targetYear}-${mm}-${dd}`;
}

function parseYearMonth(ym) {
  if (!ym) return null;
  const [y, m] = ym.split('-').map(Number);
  return { year: y, month: m };
}

function currentYearMonth() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function prevMonth(ym) {
  return ym.month === 1
    ? { year: ym.year - 1, month: 12 }
    : { year: ym.year, month: ym.month - 1 };
}

function formatYearMonth(y, m) {
  return `${y}-${String(m).padStart(2, '0')}`;
}

function monthsBetween(fromYM, toYM) {
  const months = [];
  let y = fromYM.year, m = fromYM.month;
  // Advance one month past fromYM
  m++;
  if (m > 12) { m = 1; y++; }
  while (y < toYM.year || (y === toYM.year && m <= toYM.month)) {
    months.push({ year: y, month: m });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

/**
 * Scan items for pending recurring copies.
 * @param {Array} expenses - parsed expense objects (with .repeats, .date, .createdAt, etc.)
 * @param {Array} income - parsed income objects
 * @param {string} lastChecked - 'YYYY-MM' string from settings, or ''
 * @returns {Array} pendingItems - each { ...sourceItem, type:'expense'|'income', newDate, sourceLabel }
 */
export function getPendingRecurring(expenses, income, lastChecked) {
  const cur = currentYearMonth();
  const lastYM = parseYearMonth(lastChecked);

  // When no lastChecked exists, treat previous month as the baseline
  // to avoid generating a massive backlog from old items
  const effectiveLast = lastYM || prevMonth(cur);
  const upToDate = lastYM && (lastYM.year > cur.year || (lastYM.year === cur.year && lastYM.month >= cur.month));

  const pending = [];

  function makePending(item, type, newDate, sourceLabel) {
    pending.push({
      sourceId: item.id,
      sourceDate: item.date,
      title: item.title,
      amount: item.amount,
      accountId: item.accountId,
      category: item.category,
      notes: item.notes || '',
      repeats: item.repeats,
      type,
      newDate,
      sourceLabel,
      checked: true,
    });
  }

  function processItems(items, type) {
    for (const item of items) {
      if (!item.repeats) continue;
      const itemDate = item.date;
      if (!itemDate) continue;
      const [iy, im] = itemDate.split('-').map(Number);

      // When already up-to-date, only process items created after lastChecked
      // (e.g. user added a new recurring item for an earlier month)
      const isNew = item.createdAt && lastChecked && item.createdAt > lastChecked;
      if (upToDate && !isNew) continue;

      if (item.repeats === 'monthly') {
        // For new items found during recheck, generate from their own date;
        // for normal flow, generate from the effective last-checked month
        const fromYM = upToDate
          ? { year: iy, month: im }
          : (effectiveLast.year > iy || (effectiveLast.year === iy && effectiveLast.month >= im))
            ? effectiveLast
            : { year: iy, month: im };
        const gaps = monthsBetween(fromYM, cur);
        const label = `Monthly from ${new Date(iy, im - 1).toLocaleDateString(undefined, { month: 'short' })}`;
        for (const gap of gaps) {
          makePending(item, type, clampDate(itemDate, gap.year, gap.month), label);
        }
      } else if (item.repeats === 'yearly') {
        const fromYear = upToDate ? iy : effectiveLast.year;
        const label = `Yearly from ${new Date(iy, im - 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
        for (let y = fromYear + 1; y <= cur.year; y++) {
          if (y === iy) continue;
          if (y === cur.year && im > cur.month) continue;
          makePending(item, type, clampDate(itemDate, y, im), label);
        }
      }
    }
  }

  processItems(expenses, 'expense');
  processItems(income, 'income');

  // Deduplicate: when multiple months of the same recurring item all generate
  // a copy for the same target date, keep only the one from the latest source
  const byKey = new Map();
  for (const p of pending) {
    const key = `${p.type}|${p.title}|${p.newDate}`;
    const existing = byKey.get(key);
    if (!existing || p.sourceDate > existing.sourceDate) {
      byKey.set(key, p);
    }
  }
  const deduped = [...byKey.values()];
  deduped.sort((a, b) => a.newDate.localeCompare(b.newDate));
  return deduped;
}

export function formatYM(y, m) {
  return formatYearMonth(y, m);
}

export function getCurrentYM() {
  const c = currentYearMonth();
  return formatYearMonth(c.year, c.month);
}
