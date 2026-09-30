// ========================================
// RTSVR6 — 1v1 match trace
// Human orders + bot orders + periodic snapshots, saved as JSON.
// ========================================

import * as State from './state.js';

const MAX_EVENTS = 4000;
const MAX_SNAPS = 500;
const SNAP_SEC = 8;

let enabled = false;
let events = [];
let snaps = [];
let lastSnap = -999;

export function isMatchTraceEnabled() {
  return enabled;
}

/** Call once when a match starts. On for 1v1 unless `?trace=0`. Force with `?trace=1`. */
export function startMatchTrace() {
  const sp = new URLSearchParams(window.location.search || '');
  const flag = sp.get('trace');
  const mode = State.gameSession.matchMode;
  enabled = flag === '1' || flag === 'true' || (flag !== '0' && mode === '1v1');
  events = [];
  snaps = [];
  lastSnap = -999;
  if (typeof window !== 'undefined') {
    window.__rtsDownloadTrace = downloadMatchTrace;
    window.__rtsTrace = () => buildPayload();
  }
  if (enabled) ensureTraceButton();
  else hideTraceButton();
}

/**
 * @param {string} kind
 * @param {number} ownerId
 * @param {object} detail
 */
export function traceOrder(kind, ownerId, detail = {}) {
  if (!enabled) return;
  const player = State.players[ownerId];
  const who = player?.isBot ? 'bot' : 'human';
  const types = detail.types || null;
  const interestingType = types && (types.mobileHq || types.artillery || types.artilleryTurret);
  if (who === 'bot' && !detail.keep && !detail.why && !interestingType) {
    if (kind === 'move' || kind === 'attackMove') return;
  }
  const ev = {
    t: +State.gameSession.elapsedTime.toFixed(1),
    who,
    pid: ownerId,
    kind,
  };
  if (detail.x != null) ev.x = detail.x;
  if (detail.z != null) ev.z = detail.z;
  if (detail.n) ev.n = detail.n;
  if (types) ev.types = types;
  if (detail.type) ev.type = detail.type;
  if (detail.targetId != null) ev.targetId = detail.targetId;
  if (detail.mhqFrom) ev.mhqFrom = detail.mhqFrom;
  if (detail.why) ev.why = detail.why;
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
}

export function tickMatchTrace() {
  if (!enabled || !State.gameSession.gameStarted || State.gameSession.gameOver) return;
  const t = State.gameSession.elapsedTime;
  if (t - lastSnap < SNAP_SEC) return;
  lastSnap = t;
  snaps.push(snapshot(t));
  if (snaps.length > MAX_SNAPS) snaps.shift();
}

function snapshot(t) {
  const seats = [];
  for (let i = 0; i < State.players.length; i++) {
    const p = State.players[i];
    if (!p || !p.isActive || p.isDefeated) continue;
    const units = {};
    let mhq = null;
    State.units.forEach(u => {
      if (u.ownerId !== p.id || u.hp <= 0) return;
      units[u.type] = (units[u.type] || 0) + 1;
      if (u.type === 'mobileHq') {
        mhq = {
          x: Math.round(u.x),
          z: Math.round(u.z),
          tx: u.targetPos ? Math.round(u.targetPos.x) : null,
          tz: u.targetPos ? Math.round(u.targetPos.z) : null,
          state: u.state,
        };
      }
    });
    const buildings = {};
    const hqs = [];
    State.buildings.forEach(b => {
      if (b.ownerId !== p.id || b.hp <= 0) return;
      buildings[b.type] = (buildings[b.type] || 0) + 1;
      if (b.type === 'hq') hqs.push({ x: Math.round(b.x), z: Math.round(b.z) });
    });
    seats.push({
      id: p.id,
      bot: !!p.isBot,
      strat: p.botMemory?.strategyId || null,
      credits: Math.round(p.credits),
      units,
      buildings,
      hqs,
      mhq,
      commit: p.botMemory?.expandCommitFieldId || null,
    });
  }
  return { t: Math.round(t), seats };
}

function buildPayload() {
  const human = events.filter(e => e.who === 'human' && (e.kind === 'build' || e.kind === 'train' || e.kind === 'deploy'));
  const bot = events.filter(e => e.who === 'bot' && (e.kind === 'build' || e.kind === 'train' || e.kind === 'deploy'));
  const turnbacks = events.filter(e => e.why && String(e.why).includes('turnback'));
  return {
    build: '0.7.115',
    mode: State.gameSession.matchMode,
    elapsed: +State.gameSession.elapsedTime.toFixed(1),
    summary: {
      humanEconomy: human.map(e => ({ t: e.t, kind: e.kind, type: e.type, x: e.x, z: e.z })),
      botEconomy: bot.map(e => ({ t: e.t, kind: e.kind, type: e.type, x: e.x, z: e.z, why: e.why || null })),
      mhqTurnbacks: turnbacks,
    },
    events,
    snaps,
  };
}

export function downloadMatchTrace() {
  if (!enabled && events.length === 0) startMatchTrace();
  tickMatchTrace();
  // Force a closing snapshot even if the interval has not elapsed.
  if (enabled) snaps.push(snapshot(State.gameSession.elapsedTime));
  const payload = buildPayload();
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `rtsvr6-trace-${Math.round(State.gameSession.elapsedTime)}s.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return payload.summary;
}

function ensureTraceButton() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('btn-match-trace')) {
    document.getElementById('btn-match-trace').hidden = false;
    return;
  }
  const b = document.createElement('button');
  b.id = 'btn-match-trace';
  b.type = 'button';
  b.textContent = 'Save trace';
  b.title = 'Download this 1v1 as JSON: your orders, the bot\'s orders, and snapshots.';
  b.style.cssText = [
    'position:fixed', 'right:12px', 'bottom:12px', 'z-index:90',
    'padding:6px 10px', 'font:12px Consolas,monospace',
    'background:#142018', 'color:#9d9', 'border:1px solid #3a6',
    'border-radius:4px', 'cursor:pointer',
  ].join(';');
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    downloadMatchTrace();
  });
  document.body.appendChild(b);
}

function hideTraceButton() {
  const b = typeof document !== 'undefined' && document.getElementById('btn-match-trace');
  if (b) b.hidden = true;
}
