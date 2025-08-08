// Service Worker for Google Sheets PWA
const CACHE_NAME = 'google-sheets-pwa-v1.0.0';
const STATIC_CACHE_NAME = 'static-cache-v1.0.0';
const DYNAMIC_CACHE_NAME = 'dynamic-cache-v1.0.0';

// Files to cache for offline functionality
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/app.js',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    'https://accounts.google.com/gsi/client',
    'https://apis.google.com/js/api.js'
];

// API endpoints that should be cached
const API_CACHE_PATTERNS = [
    /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets/,
    /^https:\/\/www\.googleapis\.com\/oauth2/
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log('🔧 Service Worker installing...');
    
    event.waitUntil(
        caches.open(STATIC_CACHE_NAME)
            .then((cache) => {
                console.log('📦 Caching static assets...');
                return cache.addAll(STATIC_ASSETS.map(url => {
                    // Handle external URLs that might fail
                    return fetch(url).then(response => {
                        if (response.ok) {
                            return cache.put(url, response);
                        }
                        console.warn(`⚠️ Failed to cache ${url}`);
                    }).catch(error => {
                        console.warn(`⚠️ Failed to fetch ${url}:`, error);
                    });
                }));
            })
            .then(() => {
                console.log('✅ Static assets cached successfully');
                return self.skipWaiting();
            })
            .catch((error) => {
                console.error('❌ Error caching static assets:', error);
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('🚀 Service Worker activating...');
    
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName !== STATIC_CACHE_NAME && 
                            cacheName !== DYNAMIC_CACHE_NAME &&
                            cacheName !== CACHE_NAME) {
                            console.log('🗑️ Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => {
                console.log('✅ Service Worker activated');
                return self.clients.claim();
            })
    );
});

// Fetch event - handle network requests with caching strategy
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);

    // Skip non-GET requests and chrome extensions
    if (request.method !== 'GET' || url.protocol === 'chrome-extension:') {
        return;
    }

    // Handle different types of requests with appropriate strategies
    if (isStaticAsset(request)) {
        event.respondWith(handleStaticAsset(request));
    } else if (isAPIRequest(request)) {
        event.respondWith(handleAPIRequest(request));
    } else if (isGoogleService(request)) {
        event.respondWith(handleGoogleService(request));
    } else {
        event.respondWith(handleOtherRequests(request));
    }
});

// Check if request is for static assets
function isStaticAsset(request) {
    const url = new URL(request.url);
    return STATIC_ASSETS.some(asset => {
        if (asset.startsWith('http')) {
            return url.href === asset;
        }
        return url.pathname === asset || url.pathname.endsWith(asset);
    });
}

// Check if request is for API endpoints
function isAPIRequest(request) {
    return API_CACHE_PATTERNS.some(pattern => pattern.test(request.url));
}

// Check if request is for Google services
function isGoogleService(request) {
    const url = new URL(request.url);
    return url.hostname.includes('google') || 
           url.hostname.includes('googleapis') ||
           url.hostname.includes('gstatic');
}

// Handle static assets with cache-first strategy
async function handleStaticAsset(request) {
    try {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }

        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const cache = await caches.open(STATIC_CACHE_NAME);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        console.error('❌ Error handling static asset:', error);
        return new Response('Asset not available offline', { status: 503 });
    }
}

// Handle API requests with network-first, then cache strategy
async function handleAPIRequest(request) {
    try {
        // Try network first for fresh data
        const networkResponse = await fetch(request);
        
        if (networkResponse.ok) {
            // Cache successful API responses
            const cache = await caches.open(DYNAMIC_CACHE_NAME);
            cache.put(request, networkResponse.clone());
            return networkResponse;
        }
        
        // If network fails, try cache
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            console.log('📋 Serving API response from cache');
            return cachedResponse;
        }
        
        return networkResponse;
    } catch (error) {
        console.error('❌ Network error, trying cache:', error);
        
        // Network failed, try cache
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        
        // Return offline response for API calls
        return new Response(JSON.stringify({
            error: 'Network unavailable',
            message: 'This data is not available offline',
            offline: true
        }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// Handle Google services with network-first strategy
async function handleGoogleService(request) {
    try {
        const networkResponse = await fetch(request);
        
        if (networkResponse.ok) {
            // Cache Google services for offline access
            const cache = await caches.open(DYNAMIC_CACHE_NAME);
            cache.put(request, networkResponse.clone());
        }
        
        return networkResponse;
    } catch (error) {
        console.error('❌ Google service request failed:', error);
        
        // Try cache for Google services
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        
        // Return a basic offline response
        return new Response('Google service unavailable offline', { 
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

// Handle other requests with network-first strategy
async function handleOtherRequests(request) {
    try {
        const networkResponse = await fetch(request);
        return networkResponse;
    } catch (error) {
        // For navigation requests, return cached index.html
        if (request.mode === 'navigate') {
            const cachedResponse = await caches.match('/index.html');
            if (cachedResponse) {
                return cachedResponse;
            }
        }
        
        return new Response('Page not available offline', { status: 503 });
    }
}

// Background sync for when connection is restored
self.addEventListener('sync', (event) => {
    console.log('🔄 Background sync triggered:', event.tag);
    
    if (event.tag === 'auth-token-refresh') {
        event.waitUntil(handleAuthTokenRefresh());
    } else if (event.tag === 'sheets-data-sync') {
        event.waitUntil(handleSheetsDataSync());
    }
});

// Handle authentication token refresh in background
async function handleAuthTokenRefresh() {
    try {
        console.log('🔑 Attempting background auth token refresh...');
        
        // Send message to all clients to refresh their tokens
        const clients = await self.clients.matchAll();
        clients.forEach(client => {
            client.postMessage({
                type: 'AUTH_REFRESH_REQUIRED',
                message: 'Please refresh your authentication'
            });
        });
        
        console.log('✅ Auth refresh message sent to clients');
    } catch (error) {
        console.error('❌ Background auth refresh failed:', error);
    }
}

// Handle sheets data synchronization
async function handleSheetsDataSync() {
    try {
        console.log('📊 Attempting background sheets data sync...');
        
        // This could handle offline edits, pending uploads, etc.
        // For now, just notify clients that sync is needed
        const clients = await self.clients.matchAll();
        clients.forEach(client => {
            client.postMessage({
                type: 'SHEETS_SYNC_REQUIRED',
                message: 'Connection restored - please refresh your data'
            });
        });
        
        console.log('✅ Sheets sync message sent to clients');
    } catch (error) {
        console.error('❌ Background sheets sync failed:', error);
    }
}

// Handle messages from the main app
self.addEventListener('message', (event) => {
    const { type, data } = event.data;
    
    switch (type) {
        case 'SKIP_WAITING':
            self.skipWaiting();
            break;
            
        case 'GET_VERSION':
            event.ports[0].postMessage({ version: CACHE_NAME });
            break;
            
        case 'CLEAR_CACHE':
            clearAllCaches().then(() => {
                event.ports[0].postMessage({ success: true });
            });
            break;
            
        default:
            console.log('📨 Unknown message type:', type);
    }
});

// Clear all caches
async function clearAllCaches() {
    try {
        const cacheNames = await caches.keys();
        await Promise.all(
            cacheNames.map(cacheName => caches.delete(cacheName))
        );
        console.log('🗑️ All caches cleared');
        return true;
    } catch (error) {
        console.error('❌ Error clearing caches:', error);
        return false;
    }
}

// Periodic cleanup of old cache entries
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'cache-cleanup') {
        event.waitUntil(cleanupOldCacheEntries());
    }
});

// Clean up old cache entries
async function cleanupOldCacheEntries() {
    try {
        const cache = await caches.open(DYNAMIC_CACHE_NAME);
        const requests = await cache.keys();
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        
        for (const request of requests) {
            const response = await cache.match(request);
            const dateHeader = response.headers.get('date');
            
            if (dateHeader) {
                const responseDate = new Date(dateHeader).getTime();
                if (now - responseDate > maxAge) {
                    await cache.delete(request);
                    console.log('🗑️ Cleaned up old cache entry:', request.url);
                }
            }
        }
        
        console.log('✅ Cache cleanup completed');
    } catch (error) {
        console.error('❌ Cache cleanup failed:', error);
    }
}

// Handle push notifications (for future use)
self.addEventListener('push', (event) => {
    console.log('📨 Push notification received:', event);
    
    const options = {
        body: 'Your Google Sheets data has been updated',
        icon: '/icon-192.png',
        badge: '/icon-72.png',
        vibrate: [100, 50, 100],
        data: {
            dateOfArrival: Date.now(),
            primaryKey: 1
        },
        actions: [
            {
                action: 'view',
                title: 'View Sheet',
                icon: '/icon-192.png'
            },
            {
                action: 'close',
                title: 'Close',
                icon: '/icon-192.png'
            }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification('Google Sheets PWA', options)
    );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
    console.log('🔔 Notification clicked:', event);
    
    event.notification.close();
    
    if (event.action === 'view') {
        event.waitUntil(
            self.clients.openWindow('/')
        );
    }
});

console.log('🚀 Google Sheets PWA Service Worker loaded successfully'); 