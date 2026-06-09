/**
 * IndexedDB cache for three-mesh-bvh trees on the forest road GLB.
 * BVH build is the main CPU cost on repeat visits — geometry + GLB URL version key the cache.
 */
import { MeshBVH } from 'three-mesh-bvh';

const IDB_NAME = 'drivevr5_env_collision';
const IDB_VERSION = 1;
/** Bump when BVH build params (maxLeafTris, etc.) or env asset changes. */
export const ENV_BVH_CACHE_VERSION = 1;

let idbPromise = null;

function openIdb() {
    if (!window.indexedDB) {
        return Promise.reject(new Error('indexedDB unavailable'));
    }
    if (idbPromise) return idbPromise;
    idbPromise = new Promise(function(resolve, reject) {
        var req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function(ev) {
            ev.target.result.createObjectStore('bvh', { keyPath: 'id' });
        };
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { reject(req.error); };
    });
    return idbPromise;
}

export function getEnvCacheScopeKey(envUrl) {
    return String(envUrl || '') + '@bv' + ENV_BVH_CACHE_VERSION;
}

/** Stable id per mesh geometry within an environment file. */
export function getMeshBvhCacheId(scopeKey, mesh) {
    if (!mesh || !mesh.geometry) return null;
    var geo = mesh.geometry;
    var pos = geo.attributes.position;
    if (!pos) return null;
    var name = (mesh.name || 'mesh').replace(/\s+/g, '_');
    var ix = geo.index ? geo.index.count : 0;
    return scopeKey + '::' + name + '::v' + pos.count + '::i' + ix;
}

function idbGet(id) {
    return openIdb().then(function(db) {
        return new Promise(function(resolve) {
            var req = db.transaction('bvh', 'readonly').objectStore('bvh').get(id);
            req.onsuccess = function() { resolve(req.result || null); };
            req.onerror = function() { resolve(null); };
        });
    }).catch(function() { return null; });
}

function idbPut(record) {
    return openIdb().then(function(db) {
        return new Promise(function(resolve) {
            var tx = db.transaction('bvh', 'readwrite');
            tx.objectStore('bvh').put(record);
            tx.oncomplete = function() { resolve(true); };
            tx.onerror = function() { resolve(false); };
        });
    }).catch(function() { return false; });
}

function idbDelete(id) {
    return openIdb().then(function(db) {
        return new Promise(function(resolve) {
            var tx = db.transaction('bvh', 'readwrite');
            tx.objectStore('bvh').delete(id);
            tx.oncomplete = function() { resolve(true); };
            tx.onerror = function() { resolve(false); };
        });
    }).catch(function() { return false; });
}

/**
 * Try to restore BVH trees from IndexedDB before computeBoundsTree().
 * @returns {Promise<{ restored: number, total: number }>}
 */
export async function restoreBvhForMeshes(envUrl, meshes) {
    var scopeKey = getEnvCacheScopeKey(envUrl);
    var total = meshes ? meshes.length : 0;
    var restored = 0;
    if (!meshes || !meshes.length || !window.indexedDB) {
        return { restored: 0, total: total };
    }
    for (var i = 0; i < meshes.length; i++) {
        var mesh = meshes[i];
        if (!mesh || !mesh.geometry || mesh.geometry.boundsTree) continue;
        var id = getMeshBvhCacheId(scopeKey, mesh);
        if (!id) continue;
        var rec = await idbGet(id);
        if (!rec || !rec.data) continue;
        try {
            mesh.geometry.boundsTree = MeshBVH.deserialize(rec.data, mesh.geometry, {
                setIndex: false
            });
            mesh.geometry.computeBoundingSphere();
            restored++;
        } catch (e) {
            console.warn('BVH cache deserialize failed —', id, e);
            idbDelete(id);
        }
    }
    if (restored) {
        console.log('💾 Restored', restored + '/' + total, 'BVH mesh(es) from IndexedDB');
    }
    return { restored: restored, total: total };
}

/** Persist a freshly built bounds tree (fire-and-forget). */
export function saveMeshBvhToCache(envUrl, mesh) {
    if (!mesh || !mesh.geometry || !mesh.geometry.boundsTree || !window.indexedDB) return;
    var scopeKey = getEnvCacheScopeKey(envUrl);
    var id = getMeshBvhCacheId(scopeKey, mesh);
    if (!id) return;
    try {
        var data = MeshBVH.serialize(mesh.geometry.boundsTree, { cloneBuffers: false });
        idbPut({ id: id, scopeKey: scopeKey, savedAt: Date.now(), data: data });
    } catch (e) {
        console.warn('BVH cache save failed —', id, e);
    }
}
