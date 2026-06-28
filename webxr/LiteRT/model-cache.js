// model-cache.js
// Main-thread API for the OPFS model cache. It drives model-cache-worker.js to
// download a (large) model URL to disk with resume + progress WITHOUT janking
// the render thread or holding the file in memory, then returns a disk-backed
// File you can stream into the runtime.
//
//   import { ModelCache } from './model-cache.js';
//   if (ModelCache.isSupported()) {
//     const file = await ModelCache.getFile(url, { onProgress:(l,t)=>... });
//     await engine.load({ modelFile: file, ... }); // streamed, low-memory
//   }

const DIR = 'litert-models';

export const ModelCache = {
  /**
   * Why the on-disk cache can/can't be used. NOTE: we deliberately do NOT probe
   * createSyncAccessHandle here — that API only exists inside a Worker, so
   * checking it on the main thread wrongly disables caching. The worker does the
   * real capability check and falls back to createWritable if needed.
   */
  support() {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory)
      return { ok: false, reason: 'OPFS unavailable (navigator.storage.getDirectory missing)' };
    if (typeof Worker === 'undefined')
      return { ok: false, reason: 'Web Workers unavailable' };
    if (typeof window !== 'undefined' && window.isSecureContext === false)
      return { ok: false, reason: 'insecure context — serve over HTTPS (or localhost)' };
    return { ok: true, reason: '' };
  },

  isSupported() { return this.support().ok; },

  /** Stable, filesystem-safe key for a URL (so the same model resolves to one file). */
  keyFor(url) {
    let h = 0;
    for (let i = 0; i < url.length; i++) h = (Math.imul(h, 31) + url.charCodeAt(i)) | 0;
    const base = (url.split('?')[0].split('#')[0].split('/').pop() || 'model')
      .replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
    return `${(h >>> 0).toString(16)}_${base}`;
  },

  /**
   * Ensure the model at `url` is fully cached on disk (resuming if a partial
   * download exists), then return it as a File. Reports (loaded, total) bytes.
   */
  async getFile(url, { onProgress = null, signal = null } = {}) {
    const key = this.keyFor(url);
    const done = await new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL('./model-cache-worker.js', import.meta.url), { type: 'module' });
      } catch (e) { console.error('[ModelCache] worker spawn failed:', e); reject(e); return; }
      const cleanup = () => { try { worker.terminate(); } catch (_) {} };
      if (signal) signal.addEventListener('abort', () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      worker.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.type === 'progress') { if (onProgress) onProgress(m.loaded, m.total); }
        else if (m.type === 'done') { cleanup(); resolve(m); }
        else if (m.type === 'error') { cleanup(); reject(new Error(m.message)); }
      };
      worker.onerror = (err) => { cleanup(); reject(err.error || new Error(err.message || 'Worker failed')); };
      worker.postMessage({ url, key });
    });
    console.log(`[ModelCache] ready via "${done.writer}" writer, ${done.size} bytes on disk.`);

    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIR, { create: true });
    const fh = await dir.getFileHandle(key);
    return fh.getFile();
  },

  /** How many bytes of this URL are currently cached on disk (0 if none). */
  async cachedBytes(url) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIR, { create: true });
      const fh = await dir.getFileHandle(this.keyFor(url));
      return (await fh.getFile()).size;
    } catch { return 0; }
  },

  /** Delete a cached model (e.g. to force a fresh download). */
  async remove(url) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIR, { create: true });
      await dir.removeEntry(this.keyFor(url));
    } catch (_) {}
  },
};
