import { getRate } from './fxService.js';

const { ref, computed, watch, unref } = Vue;

// Locale-aware amount parser. Mirrors parseAmount() used elsewhere so that
// users with a "1.234,56" Number Format setting can type "1234,56" or
// "1.234,56" without it being mis-parsed as 123456 / 1234.56 (a 100x bug).
// Heuristic: if the rightmost comma sits to the right of the rightmost dot,
// dots are thousands separators and the comma is the decimal mark.
function parseLocaleAmount(val) {
  if (typeof val === 'number') return val;
  if (!val || typeof val !== 'string') return NaN;
  const s = val.trim();
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  return parseFloat(s.replace(/,/g, ''));
}

// Render a number into the amount field using the user's preferred decimal
// separator so the converted value matches the rest of the UI.
function formatAmountForInput(num) {
  const pref = (typeof localStorage !== 'undefined' && localStorage.getItem('valu_number_format')) || 'auto';
  const str = Number(num).toString();
  if (pref === 'de-DE') return str.replace('.', ',');
  return str;
}

/**
 * Composable for currency conversion at data-entry time.
 *
 * @param {Object} opts
 * @param {import('vue').Ref|import('vue').ComputedRef} opts.foreignCurrency  - The account's currency code
 * @param {import('vue').Ref|import('vue').ComputedRef} opts.baseCurrency     - The group's base currency
 * @param {import('vue').Ref|import('vue').ComputedRef} opts.dateStr          - Transaction date 'YYYY-MM-DD'
 * @param {(v: string) => void}                         opts.setAmount        - Setter for the converted amount field
 * @param {import('vue').Ref}                           [opts.manualRates]    - Optional manual fallback rates [{currency,rate}]
 */
export function useFxConvert({ foreignCurrency, baseCurrency, dateStr, setAmount, manualRates }) {
  const active = ref(false);
  const foreignAmount = ref('');
  const rate = ref(null);
  const rateDate = ref('');
  const loading = ref(false);
  const error = ref('');

  const needsFx = computed(() => {
    const fc = unref(foreignCurrency);
    const bc = unref(baseCurrency);
    return fc && bc && fc !== bc;
  });

  const fxCurrency = computed(() => unref(foreignCurrency));

  const fxIsFuture = computed(() => {
    const date = unref(dateStr);
    if (!date) return false;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return date > todayStr;
  });

  function reset() {
    active.value = false;
    foreignAmount.value = '';
    rate.value = null;
    rateDate.value = '';
    loading.value = false;
    error.value = '';
  }

  async function fetchRate() {
    const from = unref(foreignCurrency);
    const to = unref(baseCurrency);
    const date = unref(dateStr);
    if (!from || !to || from === to) return;

    loading.value = true;
    error.value = '';
    const result = await getRate(from, to, date);
    loading.value = false;

    if (result.error) {
      const fallback = tryManualRate(from);
      if (fallback != null) {
        rate.value = fallback;
        rateDate.value = 'manual';
        updateConverted();
      } else {
        error.value = result.error;
        rate.value = null;
      }
    } else {
      rate.value = result.rate;
      rateDate.value = result.date;
      updateConverted();
    }
  }

  function tryManualRate(from) {
    const rates = unref(manualRates);
    if (!rates || !Array.isArray(rates)) return null;
    const entry = rates.find(r => r.currency === from);
    if (entry) {
      const v = parseFloat(entry.rate);
      if (!isNaN(v)) return v;
    }
    return null;
  }

  function updateConverted() {
    if (!active.value || !rate.value) return;
    const raw = parseLocaleAmount(foreignAmount.value);
    if (isNaN(raw)) { setAmount(''); return; }
    const converted = Math.round(raw * rate.value * 100) / 100;
    setAmount(formatAmountForInput(converted));
  }

  function toggle() {
    active.value = !active.value;
    if (active.value) {
      foreignAmount.value = '';
      setAmount('');
      fetchRate();
    } else {
      reset();
    }
  }

  function buildFxTag() {
    if (!active.value || !foreignAmount.value) return '';
    const raw = parseLocaleAmount(foreignAmount.value);
    if (isNaN(raw)) return '';
    return `(${unref(foreignCurrency)} ${raw.toFixed(2)})`;
  }

  const FX_TAG_RE = /\s*\([A-Z]{3}\s+[\d.,]+\)\s*$/;

  function appendFxTag(notes) {
    const tag = buildFxTag();
    const cleaned = (notes || '').replace(FX_TAG_RE, '').trimEnd();
    if (!tag) return cleaned;
    return cleaned ? `${cleaned} ${tag}` : tag;
  }

  watch(() => unref(dateStr), () => { if (active.value) fetchRate(); });

  watch(() => unref(foreignCurrency), () => {
    if (active.value) {
      if (!needsFx.value) reset();
      else fetchRate();
    }
  });

  return {
    fxActive: active,
    fxForeignAmount: foreignAmount,
    fxRate: rate,
    fxRateDate: rateDate,
    fxLoading: loading,
    fxError: error,
    needsFx,
    fxCurrency,
    fxIsFuture,
    reset,
    fetchRate,
    updateConverted,
    toggle,
    buildFxTag,
    appendFxTag,
  };
}
