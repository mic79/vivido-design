const CACHE_NAME = 'dotmination-cache-v1';
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './lib/normalize.css',
  './fonts/roboto.css',
  // Add font files if roboto.css references them locally (e.g., woff2)
  // './fonts/Roboto-Regular.woff2',
  // './fonts/Roboto-Condensed-Regular.woff2', 
  './lib/all.min.css',
  './images/apple-touch-icon.png',
  './images/favicon.png',
  './lib/jquery-3.5.1.min.js',
  './lib/gsap/gsap.min.js',
  './lib/gsap/CSSRulePlugin.min.js',
  './lib/gsap/Draggable.min.js',
  './lib/shake.js',
  './lib/moment.js',
  './lib/howler.min.js',
  './modules/utils.js',
  './script.js',
  'https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js', // External script
  './sounds/submarine-sonar.mp3',
  './sounds/submarine-sonar-38243-once.mp3'
];

// Install event: Cache necessary files
self.addEventListener('install', event => {
  console.log('Service Worker: Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: Caching app shell');
        // Use addAll which fetches and caches in one step
        return cache.addAll(urlsToCache);
      })
      .catch(error => {
        console.error('Service Worker: Failed to cache during install:', error);
      })
  );
});

// Activate event: Clean up old caches
self.addEventListener('activate', event => {
  console.log('Service Worker: Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Service Worker: Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
  return self.clients.claim(); // Take control of uncontrolled clients
});

// Fetch event: Serve cached content when offline
self.addEventListener('fetch', event => {
  // console.log('Service Worker: Fetching', event.request.url);
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit - return response
        if (response) {
          // console.log('Service Worker: Serving from cache:', event.request.url);
          return response;
        }

        // Not in cache - fetch from network
        // console.log('Service Worker: Fetching from network:', event.request.url);
        return fetch(event.request).then(
          (response) => {
            // Check if we received a valid response
            // Don't cache responses for PeerJS signaling server or failed requests
            if(!response || response.status !== 200 || response.type !== 'basic') {
              if (event.request.url.includes('peerjs.com')) {
                  // console.log('Service Worker: Not caching PeerJS signaling request.');
              } else {
                  // console.log('Service Worker: Not caching invalid response for:', event.request.url);
              }
              return response;
            }

            // IMPORTANT: Clone the response. A response is a stream
            // and because we want the browser to consume the response
            // as well as the cache consuming the response, we need
            // to clone it so we have two streams.
            var responseToCache = response.clone();

            caches.open(CACHE_NAME)
              .then(cache => {
                // console.log('Service Worker: Caching new resource:', event.request.url);
                cache.put(event.request, responseToCache);
              });

            return response;
          }
        ).catch(error => {
            console.error('Service Worker: Fetch failed; returning offline page instead.', error);
            // Optional: return a custom offline fallback page
            // return caches.match('/offline.html');
        });
      })
  );
}); 