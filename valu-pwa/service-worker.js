const CACHE_NAME = 'valu-app-v157';

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
  'demoData.js',
  'HomePage.js',
  'AccountsPage.js',
  'ExpensesPage.js',
  'IncomePage.js',
  'GroupsPage.js',
  'SettingsPage.js',
  'ActivityPage.js',
  'ValuAssistant.js',
  'ValuDateField.js',
  'ValuDropdown.js',
  'ValuCurrencyPicker.js',
  'valu.js',
  'valu-landing-intro.js',
  'vendor/DrawSVGPlugin.min.js',
  'manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
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

  event.respondWith(
    fetch(event.request)
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
