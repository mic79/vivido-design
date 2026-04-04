/**
 * Exchange rate service using frankfurter.dev v2 API.
 * 160 currencies from 30+ central banks, no API key required.
 * Provides historical rates for currency conversion at data-entry time.
 *
 * Uses the official central bank for the target (base) currency when
 * available, so rates match what users see in banking apps.
 */

const rateCache = {};

const PROVIDER_BY_CURRENCY = {
  CAD: 'BOC',   // Bank of Canada
  EUR: 'ECB',   // European Central Bank
  USD: 'FRED',  // Federal Reserve
  BRL: 'BCB',   // Banco Central do Brasil
  GBP: 'BOE',   // Bank of England
  JPY: 'BOJ',   // Bank of Japan
  AUD: 'RBA',   // Reserve Bank of Australia
  CHF: 'ECB',   // No Swiss National Bank provider — ECB covers CHF
  SEK: 'RB',    // Sveriges Riksbank
  NOK: 'NB',    // Norges Bank
  DKK: 'ECB',   // ECB covers DKK
  PLN: 'NBP',   // Narodowy Bank Polski
  CZK: 'CNB',   // Czech National Bank
  HUF: 'ECB',   // ECB covers HUF
  MXN: 'BANXICO', // Banco de México
  TRY: 'TCMB',  // Central Bank of Turkey
  INR: 'FBIL',  // Financial Benchmarks India
  KES: 'CBK',   // Central Bank of Kenya
  RUB: 'CBR',   // Central Bank of Russia
  MYR: 'BNM',   // Bank Negara Malaysia
  ISK: 'SBI',   // Central Bank of Iceland
  GEL: 'NBG',   // National Bank of Georgia
  CLP: 'BCCH',  // Banco Central de Chile
  COP: 'BANREP', // Banco de la República
  TWD: 'CBC',   // Central Bank of Taiwan
  ILS: 'BOI',   // Bank of Israel
  UAH: 'NBU',   // National Bank of Ukraine
  KRW: 'BOE',   // BOE covers KRW; no dedicated Korean provider
};

function cacheKey(from, to, date) {
  return `${from}-${to}-${date}`;
}

function providerParam(from, to) {
  return PROVIDER_BY_CURRENCY[to] || PROVIDER_BY_CURRENCY[from] || '';
}

/**
 * Fetch the exchange rate for a given currency pair and date.
 * @param {string} from  - Source currency code (e.g. 'EUR')
 * @param {string} to    - Target currency code (e.g. 'CAD')
 * @param {string} date  - ISO date string 'YYYY-MM-DD'
 * @returns {Promise<{rate: number, date: string}|{error: string}>}
 */
export async function getRate(from, to, date) {
  if (!from || !to || from === to) return { rate: 1, date };

  // Clamp future dates to today — use the latest available rate;
  // the FX recheck flow will correct the amount when the actual date arrives
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const effectiveDate = date > todayStr ? todayStr : date;

  const key = cacheKey(from, to, effectiveDate);
  if (rateCache[key]) return rateCache[key];

  const provider = providerParam(from, to);
  const providerQs = provider ? `&providers=${provider}` : '';

  try {
    const url = `https://api.frankfurter.dev/v2/rate/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${effectiveDate}${providerQs}`;
    const resp = await fetch(url);

    if (!resp.ok) {
      if (provider) {
        const fallback = await fetch(`https://api.frankfurter.dev/v2/rate/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${effectiveDate}`);
        if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
        const fb = await fallback.json();
        if (fb.rate == null) throw new Error(`No rate for ${to}`);
        const result = { rate: fb.rate, date: fb.date || effectiveDate };
        rateCache[key] = result;
        return result;
      }
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const rate = data.rate;
    if (rate == null) throw new Error(`No rate for ${to}`);
    const result = { rate, date: data.date || effectiveDate };
    rateCache[key] = result;
    return result;
  } catch (err) {
    return { error: `Rate unavailable: ${err.message}` };
  }
}
