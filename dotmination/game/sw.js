const CACHE_NAME = 'dotmination-cache-v8';
const urlsToCache = [
    './',
    './index.html',
    './style.css?v=2024051604',
    './manifest.json',
    './lib/normalize.css',
    './fonts/roboto.css',
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
    './modules/utils.js?v=2024051604',
    './modules/tutorial.js?v=2024051604',
    './modules/botLogic.js?v=2024051604',
    './modules/realTimeResourceMode.js?v=2024051604',
    './script.js?v=2024051608',
    'https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js',
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
                return cache.addAll(urlsToCache);
            })
            .then(() => self.skipWaiting())
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
    return self.clients.claim();
});

// Fetch event: Serve cached content when offline
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Cache hit - return response
                if (response) {
                    return response;
                }

                // Not in cache - fetch from network
                return fetch(event.request).then(
                    (response) => {
                        // Don't cache responses for PeerJS signaling server or failed requests
                        if (!response || response.status !== 200 || response.type !== 'basic') {
                            return response;
                        }

                        // Clone the response for caching
                        var responseToCache = response.clone();

                        caches.open(CACHE_NAME)
                            .then(cache => {
                                cache.put(event.request, responseToCache);
                            });

                        return response;
                    }
                ).catch(error => {
                    console.error('Service Worker: Fetch failed; returning offline page instead.', error);
                });
            })
    );
});
