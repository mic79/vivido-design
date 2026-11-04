/**
 * Valu service worker.
 *
 * - Version comes from version.js (single source of truth, shared with index.html). Bump it there.
 * - Network-first for same-origin files (always fresh when online), cache fallback when offline.
 * - Everything the app needs to boot is precached - including the self-hosted libraries and fonts
 *   in vendor/ - so the installed app also starts without a connection.
 * - A new version waits until the user taps "Update available" (index.html posts SKIP_WAITING),
 *   so an update never reloads the page in the middle of editing something.
 */
importScripts('version.js');

const VERSION = self.VALU_VERSION || 'unknown';
/** Dev builds use their own cache namespace so they can never delete the stable app's caches. */
const CACHE_PREFIX = /-dev$/.test(VERSION) ? 'valu-dev-' : 'valu-app-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

const PRECACHE_URLS = [
  'index.html',
  'version.js',
  'boot.js',
  'app.js',
  'styles.css',
  'manifest.json',

  'icons/favicon.png',
  'icons/favicon.ico',
  'icons/apple-touch-icon.png',
  'icons/android-chrome-192x192.png',
  'icons/android-chrome-512x512.png',
  'icons/maskable_icon_x192.png',
  'icons/maskable_icon_x512.png',
  'images/icon-arrow-curved.svg',

  'googleAuth.js',
  'sheetsApi.js',
  'htmlSafe.js',
  'fxService.js',
  'useFxConvert.js',
  'recurringService.js',
  'demoData.js',
  'faqData.js',

  'HomePage.js',
  'AccountsPage.js',
  'ExpensesPage.js',
  'IncomePage.js',
  'GroupsPage.js',
  'SettingsPage.js',
  'ActivityPage.js',
  'FaqPage.js',
  'AboutPage.js',
  'ValuAssistant.js',
  'FiCalculatorPage.js',
  'ForecastPage.js',
  'ValuDateField.js',
  'ValuDropdown.js',
  'ValuCurrencyPicker.js',
  'valu.js',
  'valu-landing-intro.js',

  'vendor/vue.global.prod.js',
  'vendor/gsap.min.js',
  'vendor/DrawSVGPlugin.min.js',
  'vendor/Draggable.min.js',
  'vendor/InertiaPlugin.min.js',
  'vendor/shake-lite.js',
  'vendor/fonts.css',
  'vendor/fonts/lato-v25-S6uyw4BMUTPHjxAwXjeu.woff2',
  'vendor/fonts/lato-v25-S6uyw4BMUTPHjx4wXg.woff2',
  'vendor/fonts/lato-v25-S6u9w4BMUTPHh6UVSwaPGR_p.woff2',
  'vendor/fonts/lato-v25-S6u9w4BMUTPHh6UVSwiPGQ.woff2',
  'vendor/fonts/lato-v25-S6u9w4BMUTPHh50XSwaPGR_p.woff2',
  'vendor/fonts/lato-v25-S6u9w4BMUTPHh50XSwiPGQ.woff2',
  'vendor/fonts/materialicons-v145-flUhRq6tzZclQEJ-Vdg-IuiaDsNc.woff2',
];

/** Bypass HTTP disk cache (fixes stale JS/CSS on mobile Safari / installed PWA). */
const FETCH_BUST = { cache: 'reload' };

function precacheUrl(relativePath) {
  return new URL(relativePath, self.registration.scope).href;
}

/** Only these exact URLs are ever written to the cache, so it cannot grow without bound. */
const CACHEABLE = new Set(PRECACHE_URLS.map(precacheUrl));

self.addEventListener('install', (event) => {
  // No skipWaiting() here on purpose: see the 'message' handler below.
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
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
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
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('service-worker.js')) return;

  const isNavigation = request.mode === 'navigate';
  const useBust = isNavigation || /\.(js|css)$/i.test(url.pathname);

  event.respondWith(
    fetch(request, useBust ? FETCH_BUST : {})
      .then((response) => {
        if (response.ok && CACHEABLE.has(url.origin + url.pathname) && !url.search) {
          const clone = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        // Offline navigation to any app URL (e.g. "/", "/?demo", "/#groups"): serve the app shell.
        if (isNavigation) {
          const shell = await caches.match(precacheUrl('index.html'));
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
