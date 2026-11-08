/**
 * Session archive in IndexedDB (localStorage is too small for full sample streams).
 * Index of session metas is mirrored in localStorage for a fast list without opening IDB.
 */
const DB_NAME = 'mgvr5';
const DB_VER = 1;
const STORE = 'sessions';
const INDEX_KEY = 'mgvr5.sessionIndex';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); }
  catch { return []; }
}

function writeIndex(list) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list));
}

function downloadBlob(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2500);
}

/**
 * Persist a finished capture. Returns the session id.
 * Stores summary + samples + events (full record for later export).
 */
export async function saveSession(capture) {
  const summary = capture.summarize();
  const stamp = new Date().toISOString();
  const id = `sess_${stamp.replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    savedAt: stamp,
    testId: capture.meta.testId || '',
    testName: capture.meta.testName || '',
    summary,
    meta: { ...capture.meta },
    events: capture.events.slice(),
    samples: capture.samples.slice(),
  };

  const db = await openDb();
  try {
    await idbReq(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
  } finally {
    db.close();
  }

  const index = readIndex();
  index.unshift({
    id,
    savedAt: stamp,
    testId: record.testId,
    testName: record.testName,
    participantId: record.meta.participantId || '',
    protocol: record.meta.protocol,
    durationSec: summary.durationSec,
    nSamples: summary.nSamples,
    meanAbsErrRollDeg: summary.ride?.meanAbsErrRollDeg ?? null,
    meanAbsErrYawDeg: summary.ride?.meanAbsErrYawDeg ?? null,
  });
  // keep index bounded
  writeIndex(index.slice(0, 200));
  return id;
}

export function listSessions() {
  return readIndex();
}

export async function getSession(id) {
  const db = await openDb();
  try {
    return await idbReq(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
  } finally {
    db.close();
  }
}

export async function deleteSession(id) {
  const db = await openDb();
  try {
    await idbReq(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
  writeIndex(readIndex().filter((e) => e.id !== id));
}

export async function clearAllSessions() {
  const db = await openDb();
  try {
    await idbReq(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
  } finally {
    db.close();
  }
  writeIndex([]);
}

function recordToJSONL(rec) {
  const lines = [];
  lines.push(JSON.stringify({ type: 'meta', ...rec.meta, testId: rec.testId, testName: rec.testName, savedAt: rec.savedAt, id: rec.id }));
  for (const e of rec.events || []) lines.push(JSON.stringify({ type: 'event', ...e }));
  for (const s of rec.samples || []) lines.push(JSON.stringify({ type: 'sample', ...s }));
  return lines.join('\n') + '\n';
}

export async function exportSession(id) {
  const rec = await getSession(id);
  if (!rec) throw new Error('Session not found');
  const base = `${rec.testId || 'session'}_${(rec.meta.participantId || 'anon')}_${rec.id}`;
  downloadBlob(`${base}.jsonl`, recordToJSONL(rec), 'application/x-ndjson');
  downloadBlob(`${base}-summary.json`, JSON.stringify(rec.summary, null, 2), 'application/json');
  return base;
}

export async function exportAllSessions() {
  const index = readIndex();
  if (!index.length) throw new Error('No sessions to export');
  const bundle = [];
  for (const entry of index) {
    const rec = await getSession(entry.id);
    if (rec) bundle.push({
      id: rec.id,
      savedAt: rec.savedAt,
      testId: rec.testId,
      testName: rec.testName,
      summary: rec.summary,
      meta: rec.meta,
      events: rec.events,
      // samples omitted from mega-json if huge? include for completeness
      samples: rec.samples,
    });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(`mgvr5-all-${stamp}.json`, JSON.stringify(bundle, null, 2), 'application/json');
  // also a combined jsonl
  let jsonl = '';
  for (const rec of bundle) jsonl += recordToJSONL(rec) + '\n';
  downloadBlob(`mgvr5-all-${stamp}.jsonl`, jsonl, 'application/x-ndjson');
  return stamp;
}
