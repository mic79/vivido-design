// model-cache-worker.js
// Downloads a model URL into the Origin Private File System (OPFS), OFF the main
// thread, writing each chunk straight to disk so it never piles up in memory.
//
// Why this exists (Meta Quest 3 / mobile):
//   * The render thread stays smooth (no laser-pointer stutter): the network
//     read + disk write happen here, in a Worker, not on the UI thread.
//   * Memory stays tiny: chunks are written to disk immediately and never
//     accumulated in JS, so a ~2 GB model won't blow the tab's memory budget
//     mid-download (which was crashing the browser around 300-400 MB).
//   * Downloads RESUME via an HTTP Range request from the bytes already on disk,
//     so a crash/refresh no longer restarts from 0 (when the server supports it).
//
// Protocol (postMessage):
//   in : { url, key }
//   out: { type:'progress', loaded, total } |
//        { type:'done', name, size, writer } |
//        { type:'error', message }

const DIR = 'litert-models';

self.onmessage = async (e) => {
  const { url, key } = e.data || {};
  try {
    const result = await download(url, key, (loaded, total) =>
      self.postMessage({ type: 'progress', loaded, total })
    );
    self.postMessage({ type: 'done', name: key, size: result.size, writer: result.writer });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};

async function modelsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

async function sizeOf(fh) {
  try { return (await fh.getFile()).size; } catch { return 0; }
}

function parseTotal(res, offset) {
  const cr = res.headers.get('content-range'); // e.g. "bytes 100-1999/2000"
  const m = cr && /\/(\d+)\s*$/.exec(cr);
  if (m) return Number(m[1]);
  const cl = Number(res.headers.get('content-length')) || 0;
  return cl ? offset + cl : 0;
}

/**
 * Returns a uniform writer over OPFS using the fastest available mechanism:
 *   1) createSyncAccessHandle (worker-only, lowest overhead), else
 *   2) createWritable (FileSystemWritableFileStream).
 * `restart` truncates any existing partial file (server didn't honor Range).
 */
async function makeWriter(fh, offset, restart) {
  if (typeof fh.createSyncAccessHandle === 'function') {
    try {
      const access = await fh.createSyncAccessHandle();
      if (restart) access.truncate(0);
      let at = restart ? 0 : offset;
      return {
        kind: 'sync',
        async write(chunk) { access.write(chunk, { at }); at += chunk.byteLength; },
        async close() { access.flush(); access.close(); },
        async abort() { try { access.close(); } catch (_) {} },
      };
    } catch (_) { /* fall through to createWritable */ }
  }
  const writable = await fh.createWritable({ keepExistingData: !restart });
  if (restart) await writable.truncate(0);
  else if (offset > 0) await writable.write({ type: 'seek', position: offset });
  return {
    kind: 'writable',
    async write(chunk) { await writable.write(chunk); },
    async close() { await writable.close(); },
    async abort() { try { await writable.abort(); } catch (_) {} },
  };
}

async function download(url, key, onProgress) {
  const dir = await modelsDir();
  const fh = await dir.getFileHandle(key, { create: true });

  let offset = await sizeOf(fh); // bytes already on disk -> resume point

  const headers = {};
  if (offset > 0) headers['Range'] = `bytes=${offset}-`;
  const res = await fetch(url, { headers, mode: 'cors' });

  // Already-complete file (range past the end).
  if (offset > 0 && res.status === 416) {
    onProgress(offset, offset);
    return { size: offset, writer: 'cached' };
  }

  let restart = false;
  if (offset > 0 && res.status === 200) { restart = true; offset = 0; } // no Range support
  else if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
  }

  const total = parseTotal(res, offset);
  if (total && offset >= total && offset > 0) { // nothing left to fetch
    onProgress(offset, total);
    return { size: offset, writer: 'cached' };
  }

  const writer = await makeWriter(fh, offset, restart);
  try {
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = new Uint8Array(await res.arrayBuffer());
      await writer.write(buf);
      offset += buf.byteLength;
      onProgress(offset, total || offset);
    } else {
      const reader = res.body.getReader();
      let last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
        offset += value.byteLength;
        const now = Date.now();
        if (now - last > 150) { onProgress(offset, total || 0); last = now; }
      }
    }
    await writer.close();
  } catch (err) {
    await writer.abort();
    throw err;
  }
  onProgress(offset, total || offset);
  return { size: offset, writer: writer.kind };
}
