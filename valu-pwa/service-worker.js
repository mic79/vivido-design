/** Bump this string on every deploy so precached assets and stale caches are replaced. */
const CACHE_NAME = 'valu-app-v196';

const PRECACHE_URLS = [
  'index.html',
  'icons/favicon.png',
  'icons/apple-touch-icon.png',
  'icons/android-chrome-192x192.png',
  'icons/android-chrome-512x512.png',
  'icons/maskable_icon_x192.png',
  'icons/maskable_icon_x512.png',
  'styles.css',
  'googleAuth.js',
  'sheetsApi.js',
  'fxService.js',
  'useFxConvert.js',
  'recurringService.js',
  'demoData.js',
  'HomePage.js',
  'AccountsPage.js',
  'ExpensesPage.js',
  'IncomePage.js',
  'GroupsPage.js',
  'SettingsPage.js',
  'ActivityPage.js',
  'FaqPage.js',
  'AboutPage.js',
  'faqData.js',
  'ValuAssistant.js',
  'ValuDateField.js',
  'ValuDropdown.js',
  'ValuCurrencyPicker.js',
  'valu.js',
  'valu-landing-intro.js',
  'vendor/DrawSVGPlugin.min.js',
  'vendor/Draggable.min.js',
  'vendor/InertiaPlugin.min.js',
  'FiCalculatorPage.js',
  'ForecastPage.js',
  'manifest.json',
];

/** Bypass HTTP disk cache (fixes stale JS/CSS on mobile Safari / installed PWA). */
const FETCH_BUST = { cache: 'reload' };

function precacheUrl(relativePath) {
  return new URL(relativePath, self.registration.scope).href;
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(
        PRECACHE_URLS.map(async (rel) => {
          const url = precacheUrl(rel);
          try {
            const res = await fetch(url, FETCH_BUST);
            if (res.ok) await cache.put(url, res);
          } catch (_) {
            /* offline install: skip missing */
          }
        })
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('service-worker.js')) return;

  if (event.request.method !== 'GET') return;

  const path = url.pathname;
  const useBust =
    /\.(js|css)$/i.test(path) ||
    event.request.mode === 'navigate';

  event.respondWith(
    fetch(event.request, useBust ? FETCH_BUST : {})
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
