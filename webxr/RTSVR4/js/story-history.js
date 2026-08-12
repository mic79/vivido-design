// ========================================
// RTSVR4 — Story match history (localStorage)
// Seeds + end-of-match stats for replay / bests
// ========================================

const STORAGE_KEY = 'RTSVR4_storyHistory_v1';
const MAX_ENTRIES = 40;

/** One-shot seed for the next Story start (Replay button). */
let pendingStorySeed = null;

/**
 * @typedef {{
 *   id: string,
 *   seed: number,
 *   playedAt: number,
 *   won: boolean,
 *   draw: boolean,
 *   durationSec: number,
 *   bases: number,
 *   hills: number,
 *   ore: number,
 *   stats: {
 *     unitsProduced: number,
 *     unitsLost: number,
 *     kills: number,
 *     buildingsBuilt: number,
 *     buildingsLost: number,
 *     creditsEarned: number,
 *   },
 * }} StoryMatchRecord
 */

/**
 * @returns {{ matches: StoryMatchRecord[] }}
 */
function emptyStore() {
  return { matches: [] };
}

/**
 * @returns {{ matches: StoryMatchRecord[] }}
 */
export function loadStoryHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.matches)) return emptyStore();
    return {
      matches: parsed.matches
        .filter(m => m && Number.isFinite(m.seed))
        .map(normalizeRecord)
        .slice(0, MAX_ENTRIES),
    };
  } catch (_) {
    return emptyStore();
  }
}

/**
 * @param {any} m
 * @returns {StoryMatchRecord}
 */
function normalizeRecord(m) {
  const s = m.stats || {};
  return {
    id: String(m.id || `story_${m.playedAt || 0}_${m.seed}`),
    seed: m.seed >>> 0,
    playedAt: Number(m.playedAt) || 0,
    won: !!m.won,
    draw: !!m.draw,
    durationSec: Math.max(0, Math.floor(Number(m.durationSec) || 0)),
    bases: Math.max(0, Math.floor(Number(m.bases) || 0)),
    hills: Math.max(0, Math.floor(Number(m.hills) || 0)),
    ore: Math.max(0, Math.floor(Number(m.ore) || 0)),
    stats: {
      unitsProduced: Math.floor(Number(s.unitsProduced) || 0),
      unitsLost: Math.floor(Number(s.unitsLost) || 0),
      kills: Math.floor(Number(s.kills) || 0),
      buildingsBuilt: Math.floor(Number(s.buildingsBuilt) || 0),
      buildingsLost: Math.floor(Number(s.buildingsLost) || 0),
      creditsEarned: Math.floor(Number(s.creditsEarned) || 0),
    },
  };
}

/**
 * @param {{ matches: StoryMatchRecord[] }} store
 */
function saveStore(store) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ matches: store.matches.slice(0, MAX_ENTRIES) })
    );
  } catch (err) {
    console.warn('[StoryHistory] localStorage write failed', err);
  }
}

/**
 * Queue a seed for the next Story generate (cleared when consumed).
 * @param {number} seed
 */
export function queueStoryReplay(seed) {
  if (!Number.isFinite(seed)) return;
  pendingStorySeed = seed >>> 0;
}

/**
 * Resolve seed for Story start: pending Replay → URL `?storySeed=` → null (random).
 * @returns {number | null}
 */
export function resolveStorySeed() {
  if (pendingStorySeed != null && Number.isFinite(pendingStorySeed)) {
    const s = pendingStorySeed >>> 0;
    pendingStorySeed = null;
    return s;
  }
  try {
    const sp = new URLSearchParams(window.location.search || '');
    const q = sp.get('storySeed');
    if (q != null && String(q).trim() !== '') {
      const n = Number(q);
      if (Number.isFinite(n)) return n >>> 0;
    }
  } catch (_) {}
  return null;
}

/**
 * @param {StoryMatchRecord} record
 */
export function recordStoryMatch(record) {
  const store = loadStoryHistory();
  const entry = normalizeRecord(record);
  store.matches = [entry, ...store.matches.filter(m => m.id !== entry.id)].slice(0, MAX_ENTRIES);
  saveStore(store);
  return entry;
}

/**
 * @returns {{
 *   matches: StoryMatchRecord[],
 *   fastestWin: StoryMatchRecord | null,
 *   mostKills: StoryMatchRecord | null,
 *   mostCredits: StoryMatchRecord | null,
 * }}
 */
export function getStoryBests() {
  const { matches } = loadStoryHistory();
  let fastestWin = null;
  let mostKills = null;
  let mostCredits = null;
  for (const m of matches) {
    if (m.won) {
      if (!fastestWin || m.durationSec < fastestWin.durationSec) fastestWin = m;
    }
    if (!mostKills || m.stats.kills > mostKills.stats.kills) mostKills = m;
    if (!mostCredits || m.stats.creditsEarned > mostCredits.stats.creditsEarned) mostCredits = m;
  }
  return { matches, fastestWin, mostKills, mostCredits };
}

/**
 * @param {number} sec
 */
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
