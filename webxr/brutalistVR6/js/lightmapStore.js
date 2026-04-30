/**
 * IndexedDB-backed lightmap blob store.
 *
 * `localStorage` caps at ~5 MB per origin and bloats every byte by 33 % via base64
 * inside the JSON payload. With 1-bounce indirect on, lightmaps carry a lot more
 * non-flat content and PNG compression alone pushes 14 meshes past the cap. IDB
 * stores raw `Blob`s (no base64 overhead), the quota is hundreds of MB to GB
 * depending on free disk, and `setItem` storms become per-key `put` writes that
 * don't have to fit a single contiguous string in memory.
 *
 * Schema: one DB (`brutalistVR6_lightmaps`), one object store (`lightmaps`),
 * keyed by `mesh.name`, valued as `Blob` (image/png by default).
 */

const DB_NAME = "brutalistVR6_lightmaps";
const DB_VERSION = 1;
const STORE = "lightmaps";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = /** @type {IDBDatabase} */ (e.target.result);
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB.open failed"));
    req.onblocked = () => reject(new Error("indexedDB.open blocked (older tab open?)"));
  });
  return dbPromise;
}

function txStore(mode) {
  return openDB().then((db) => {
    const tx = db.transaction(STORE, mode);
    return { tx, store: tx.objectStore(STORE) };
  });
}

/** Store a `Blob` under `key`. Resolves when the transaction commits. */
export async function idbPut(key, blob) {
  const { tx, store } = await txStore("readwrite");
  return new Promise((resolve, reject) => {
    store.put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

/** Retrieve a `Blob` by `key`, or `null` if missing. */
export async function idbGet(key) {
  const { tx, store } = await txStore("readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

/** List every key currently in the store. */
export async function idbKeys() {
  const { tx, store } = await txStore("readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(/** @type {string[]} */ (req.result || []));
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

/** Delete a single key. Silently no-ops if the key isn't present. */
export async function idbDelete(key) {
  const { tx, store } = await txStore("readwrite");
  return new Promise((resolve, reject) => {
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Wipe the entire store. Used by the console `clearStorage` helper. */
export async function idbClear() {
  const { tx, store } = await txStore("readwrite");
  return new Promise((resolve, reject) => {
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Best-effort estimate of the IDB-backed quota and current usage in MB. Returns
 * `null` when `navigator.storage.estimate` isn't available (older Safari).
 */
export async function idbEstimateMB() {
  try {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    return {
      usageMB: (e.usage || 0) / 1024 / 1024,
      quotaMB: (e.quota || 0) / 1024 / 1024,
    };
  } catch (_) {
    return null;
  }
}
