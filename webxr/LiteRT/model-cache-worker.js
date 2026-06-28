// model-cache-worker.js
// Downloads a model URL into the Origin Private File System (OPFS), OFF the main
// thread, writing each chunk straight to disk via a synchronous access handle.
//
// Why this exists (Meta Quest 3 / mobile):
//   * The render thread stays smooth (no laser-pointer stutter) because the
//     network read + disk write happen here, in a Worker, not on the UI thread.
//   * Memory stays tiny: chunks are written to disk immediately and never
//     accumulated in JS, so a ~2 GB model won't blow the tab's memory budget
//     mid-download (which was crashing the browser around 300-400 MB).
//   * Downloads RESUME: we keep the partial file and continue with an HTTP
//     Range request, so a crash/refresh no longer restarts from 0.
//
// Protocol (postMessage):
//   in : { url, key }
//   out: { type:'progress', loaded, total } | { type:'done', name, size }
//        | { type:'error', message }

const DIR = 'litert-models';

self.onmessage = async (e) => {
  const { url, key } = e.data || {};
  try {
    const size = await download(url, key, (loaded, total) =>
      self.postMessage({ type: 'progress', loaded, total })
    );
    self.postMessage({ type: 'done', name: key, size });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};

async function modelsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

async function download(url, key, onProgress) {
  const dir = await modelsDir();
  const fh = await dir.getFileHandle(key, { create: true });
  const access = await fh.createSyncAccessHandle();
  try {
    let offset = access.getSize(); // bytes already on disk -> resume point

    const headers = {};
    if (offset > 0) headers['Range'] = `bytes=${offset}-`;
    let res = await fetch(url, { headers, mode: 'cors' });

    // Already-complete file: server says the range is unsatisfiable.
    if (offset > 0 && res.status === 416) {
      access.flush();
      onProgress(offset, offset);
      return offset;
    }
    // Server ignored Range (no resume support) -> start over cleanly.
    if (offset > 0 && res.status === 200) {
      access.truncate(0);
      offset = 0;
    } else if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
    }

    // Work out the total size for a progress bar (best-effort).
    let total = 0;
    const cr = res.headers.get('content-range'); // e.g. "bytes 100-/2000"
    const m = cr && /\/(\d+)\s*$/.exec(cr);
    if (m) total = Number(m[1]);
    if (!total) {
      const cl = Number(res.headers.get('content-length')) || 0;
      total = cl ? offset + cl : 0;
    }

    if (total && offset >= total) { // nothing left to fetch
      access.flush();
      onProgress(offset, total);
      return offset;
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      // No streaming body: fall back to a single buffer write.
      const buf = new Uint8Array(await res.arrayBuffer());
      access.write(buf, { at: offset });
      offset += buf.byteLength;
      access.flush();
      onProgress(offset, total || offset);
      return offset;
    }

    const reader = res.body.getReader();
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      access.write(value, { at: offset });
      offset += value.byteLength;
      const now = Date.now();
      if (now - lastReport > 150) { onProgress(offset, total || 0); lastReport = now; }
    }
    access.flush();
    onProgress(offset, total || offset);
    return offset;
  } finally {
    access.close();
  }
}
