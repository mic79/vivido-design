/**
 * Cache composed JS-family tracks so reloads don't rebuild ribbons/forest/mud.
 * Same idea as Path/Meander shipping a GLB — IndexedDB covers first visit /
 * local iterates until assets/tracks/{js,js2}-track.glb is baked.
 *
 * Keys are per track id (`js`, `js2`, …) so JS2 never serves a JS1 bake.
 */
const IDB_NAME = 'drivevr6_js_track';
const IDB_VERSION = 1;
const STORE = 'glb';

/**
 * Bump when js compose / mud / forest placement changes so stale caches drop.
 * Also bump the ?v= on assets/tracks/*-track.glb when shipping a new bake.
 */
/** v16: interior meadow meets the grass edge. v13 was JS/JS2. JS3 v15 was the fillet; v14 was the rejected wave. */
export const JS_TRACK_CACHE_VERSION = 16;
export const JS3_TRACK_CACHE_VERSION = 16;

/** Shipped bake (Path/Meander style). Optional until tools/bake-js-track.mjs runs. */
export const JS_TRACK_BAKE_URL = 'assets/tracks/js-track.glb?v=' + JS_TRACK_CACHE_VERSION;
export const JS2_TRACK_BAKE_URL = 'assets/tracks/js2-track.glb?v=' + JS_TRACK_CACHE_VERSION;
export const JS3_TRACK_BAKE_URL = 'assets/tracks/js3-track.glb?v=' + JS3_TRACK_CACHE_VERSION;

let idbPromise = null;

function openIdb() {
    if (!globalThis.indexedDB) {
        return Promise.reject(new Error('indexedDB unavailable'));
    }
    if (idbPromise) return idbPromise;
    idbPromise = new Promise(function(resolve, reject) {
        var req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function(ev) {
            var db = ev.target.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { reject(req.error); };
    });
    return idbPromise;
}

function normalizeTrackId(trackId) {
    var id = String(trackId || 'js').toLowerCase();
    if (id === 'js2' || id === 'js3') return id;
    return 'js';
}

function cacheId(trackId, version) {
    return normalizeTrackId(trackId) + '-track@' + (version != null ? version : JS_TRACK_CACHE_VERSION);
}

export function cacheVersionForTrack(trackId) {
    return normalizeTrackId(trackId) === 'js3' ? JS3_TRACK_CACHE_VERSION : JS_TRACK_CACHE_VERSION;
}

export function bakeUrlForTrack(trackId) {
    var id = normalizeTrackId(trackId);
    if (id === 'js2') return JS2_TRACK_BAKE_URL;
    if (id === 'js3') return JS3_TRACK_BAKE_URL;
    return JS_TRACK_BAKE_URL;
}

export function getJsTrackGlb(version, trackId) {
    var id = cacheId(trackId, version);
    return openIdb().then(function(db) {
        return new Promise(function(resolve) {
            var req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
            req.onsuccess = function() {
                var rec = req.result;
                resolve(rec && rec.data ? rec.data : null);
            };
            req.onerror = function() { resolve(null); };
        });
    }).catch(function() { return null; });
}

export function putJsTrackGlb(arrayBuffer, meta) {
    if (!arrayBuffer || !globalThis.indexedDB) return Promise.resolve(false);
    var trackId = normalizeTrackId(meta && meta.trackId);
    var version = (meta && meta.version) || JS_TRACK_CACHE_VERSION;
    var id = cacheId(trackId, version);
    var rec = {
        id: id,
        trackId: trackId,
        version: version,
        savedAt: Date.now(),
        bytes: arrayBuffer.byteLength,
        source: (meta && meta.source) || 'compose',
        data: arrayBuffer
    };
    return openIdb().then(function(db) {
        return new Promise(function(resolve) {
            var tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(rec);
            tx.oncomplete = function() {
                console.log('💾 Cached', trackId, 'track GLB',
                    (rec.bytes / (1024 * 1024)).toFixed(1) + 'MB',
                    'v' + rec.version);
                resolve(true);
            };
            tx.onerror = function() { resolve(false); };
        });
    }).catch(function() { return false; });
}

/** Probe shipped bake without downloading the whole file when possible. */
export function probeJsTrackBakeUrl(url) {
    var u = url;
    return fetch(u, { method: 'HEAD', cache: 'no-store' })
        .then(function(r) {
            if (r.ok) return { ok: true, url: u, bytes: +r.headers.get('content-length') || 0 };
            // Some static hosts reject HEAD — try a ranged GET.
            return fetch(u, {
                method: 'GET',
                headers: { Range: 'bytes=0-15' },
                cache: 'no-store'
            }).then(function(r2) {
                if (r2.ok || r2.status === 206) {
                    return { ok: true, url: u, bytes: 0 };
                }
                return { ok: false, url: u };
            });
        })
        .catch(function() { return { ok: false, url: u }; });
}

export function forceJsComposeFromQuery(search) {
    var q = String(search || (typeof location !== 'undefined' ? location.search : '') || '');
    var p = new URLSearchParams(q.indexOf('?') === 0 ? q.slice(1) : q);
    var v = (p.get('compose') || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'force';
}
