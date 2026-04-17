// ========================================
// RTSVR2 — Network System
// PeerJS host-authoritative state sync
// ========================================

import * as State from './state.js';
import * as Units from './units.js';
import * as Buildings from './buildings.js';
import * as Pathfinding from './pathfinding.js';
import * as Fog from './fog.js';
import * as Renderer from './renderer.js';
import * as Audio from './audio.js';
import * as Effects from './effects.js';
import * as Resources from './resources.js';
import {
  MAX_PLAYERS,
  NET_SNAPSHOT_RATE,
  NET_CLIENT_CMD_TIMEOUT_MS,
  NET_KEEPALIVE_INTERVAL_MS,
  NET_HOST_BG_SIM_INTERVAL_MS,
  NET_CLIENT_AUTO_REJOIN_DELAY_MS,
  NET_CLIENT_AUTO_REJOIN_MAX,
  NET_HOST_PAUSE_AUTO_RESUME_MS,
} from './config.js';

/** Multiplayer client: last applied player team row from host (lobby defaults differ from match). */
let lastClientPlayerTeamSig = '';

/** Wall-clock gap between snapshots (ms) — drives client interpolation segment length. */
let lastClientSnapWallMs = 0;
let clientSnapshotInterpGapMs = 1000 / NET_SNAPSHOT_RATE;

/** Same TURN/STUN path as DodgeVR / index-zerog: worker returns full iceServers JSON (Metered-backed). */
async function getPeerIceServers() {
  let iceServersConfig = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  try {
    const response = await fetch('https://dotmination-turn-proxy.odd-bird-4c2c.workers.dev');
    if (response.ok) iceServersConfig = await response.json();
  } catch (_) { /* keep STUN fallback */ }
  return iceServersConfig;
}

let peer = null;
const connections = new Map(); // playerId -> connection

let mpLifecycleBound = false;
let keepaliveTimerId = null;
let hostBgSimTimerId = null;
let clientRejoinTimerId = null;
let clientAutoRejoinAttempts = 0;
let hostPauseAutoResumeTimerId = null;

/** BattleVR-style: host id is `rtsvr2-host-{N}` so joiners only pick lobby 1–4 (no pasted PeerJS id). */
export const MAX_LOBBIES = 4;
let selectedLobby = 1;
let lastSnapshotTime = 0;
/** Monotonic host snapshot id — clients drop stale/out-of-order packets (PeerJS can reorder under load). */
let hostSnapshotSeq = 0;
let lastClientSnapshotSeq = -1;

function hostSessionId() {
  return `rtsvr2-host-${selectedLobby}`;
}

function clearHostPauseAutoResumeTimer() {
  if (hostPauseAutoResumeTimerId != null) {
    clearTimeout(hostPauseAutoResumeTimerId);
    hostPauseAutoResumeTimerId = null;
  }
}

function clearMpPauseState() {
  clearHostPauseAutoResumeTimer();
  State.gameSession.mpSessionPaused = false;
  State.gameSession.mpPauseReason = '';
  State.gameSession.mpPauseTitle = '';
  State.gameSession.mpPauseDetail = '';
  State.gameSession.mpPauseSubline = '';
  State.gameSession.mpPendingHumanDropSeatIds = [];
  State.gameSession.mpPauseAutoResumeAt = 0;
}

/** Host only: (re)arm auto-resume after `remote_left` pause; resets the countdown on each new drop. */
function scheduleHostPauseAutoResume() {
  if (!State.gameSession.isMultiplayer || !State.gameSession.isHost) return;
  clearHostPauseAutoResumeTimer();
  const delay = Math.max(1000, NET_HOST_PAUSE_AUTO_RESUME_MS);
  State.gameSession.mpPauseAutoResumeAt = Date.now() + delay;
  hostPauseAutoResumeTimerId = setTimeout(() => {
    hostPauseAutoResumeTimerId = null;
    if (
      State.gameSession.isMultiplayer &&
      State.gameSession.isHost &&
      State.gameSession.mpSessionPaused &&
      State.gameSession.mpPauseReason === 'remote_left'
    ) {
      hostResumeFromPause();
    }
  }, delay);
}

function syncMpPauseUi() {
  import('./ui.js')
    .then(m => m.syncMpPauseOverlay())
    .catch(() => {});
}

function teardownPeerOnly() {
  if (clientRejoinTimerId) {
    clearTimeout(clientRejoinTimerId);
    clientRejoinTimerId = null;
  }
  hostSnapshotSeq = 0;
  lastClientSnapshotSeq = -1;
  clearMpPauseState();
  clearAllPendingClientAcks(true, 'disconnected');
  connections.forEach(c => {
    try {
      c.close();
    } catch (_) { /* ignore */ }
  });
  connections.clear();
  if (peer) {
    try {
      peer.destroy();
    } catch (_) { /* ignore */ }
    peer = null;
  }
}

export function getSelectedLobby() {
  return selectedLobby;
}

export function adjustLobby(delta) {
  selectedLobby = Math.max(1, Math.min(MAX_LOBBIES, selectedLobby + delta));
  refreshLobbyDisplay();
}

export function refreshLobbyDisplay() {
  const el = document.getElementById('menu-lobby-num');
  if (el) el.textContent = String(selectedLobby);
  const vr = document.getElementById('menu-lobby-vr');
  if (vr && typeof vr.setAttribute === 'function') {
    vr.setAttribute('value', `Lobby ${selectedLobby}`);
  }
}

/** Host only: numeric player ids (1–3) with an open PeerJS data connection. */
export function getConnectedRemotePlayerIds() {
  const out = [];
  connections.forEach((conn, id) => {
    if (typeof id === 'number' && id >= 1 && id <= 3 && conn && conn.open) out.push(id);
  });
  return out.sort((a, b) => a - b);
}

let clientCmdSeq = 0;
/** cmdId -> { onResult, timerId } */
const pendingClientAcks = new Map();

function clearAllPendingClientAcks(rejectWithFalse, code = 'disconnected') {
  pendingClientAcks.forEach(({ onResult, timerId }) => {
    clearTimeout(timerId);
    if (rejectWithFalse && typeof onResult === 'function') {
      try { onResult(false, code); } catch (_) { /* ignore */ }
    }
  });
  pendingClientAcks.clear();
}

function fulfillClientAck(cmdId, ok, code) {
  const p = pendingClientAcks.get(cmdId);
  if (!p) return;
  clearTimeout(p.timerId);
  pendingClientAcks.delete(cmdId);
  if (typeof p.onResult === 'function') {
    try { p.onResult(!!ok, code); } catch (e) { console.error(e); }
  }
}

/** Human-readable text for host failure codes (and local client errors). */
export function commandFailureMessage(code) {
  const M = {
    unknown_building: 'Unknown building type.',
    no_player: 'Invalid player.',
    no_credits: 'Not enough credits.',
    no_hq: 'You need an HQ before placing structures.',
    too_far_from_hq: 'Too far from your HQ — build closer to base.',
    overlap_building: 'Overlaps another structure.',
    on_resource: 'Cannot build on a resource field.',
    out_of_bounds: 'Outside the buildable map area.',
    no_units: 'No valid units in that order.',
    invalid_target: 'Target is gone or invalid.',
    friendly_target: 'Cannot attack allies on your team.',
    not_owner: "You don't control that.",
    invalid_building: 'That building is unavailable.',
    not_constructed: 'Building is not finished yet.',
    cant_produce_here: 'This structure cannot train that unit.',
    invalid_unit_type: 'Unknown unit type.',
    unit_cap: 'Unit population cap reached.',
    not_in_queue: 'That unit is not in the production queue.',
    placement_failed: 'Could not place building.',
    unknown_action: 'Unknown command.',
    disconnected: 'Disconnected from host.',
    session_paused: 'Match is paused (network). Wait for the host or reconnect.',
    lobby_full: 'Lobby is full.',
    timeout: 'No response from host — try again.',
    network: 'Not connected to host.',
    send_failed: 'Failed to send command.',
    no_harvesters: 'Select harvesters to assign a crystal.',
    invalid_field: 'That crystal is gone or empty.',
    field_not_visible: 'You have not explored that crystal yet.',
    no_refinery: 'Build a refinery before harvesting.',
    deployment_blocked: 'Cannot deploy HQ here (overlap, crystal, or map edge).',
  };
  if (!code) return 'Command failed.';
  return M[code] || 'Command failed.';
}

export function initNetwork() {
  refreshLobbyDisplay();
  setupMultiplayerLifecycle();
}

function setupMultiplayerLifecycle() {
  if (mpLifecycleBound || typeof document === 'undefined') return;
  mpLifecycleBound = true;
  keepaliveTimerId = setInterval(tickMultiplayerKeepalive, NET_KEEPALIVE_INTERVAL_MS);
  hostBgSimTimerId = setInterval(tickHostBackgroundSim, NET_HOST_BG_SIM_INTERVAL_MS);
  document.addEventListener('visibilitychange', onMpDocumentVisibilityChange);
}

function tickMultiplayerKeepalive() {
  if (!State.gameSession.isMultiplayer) return;
  try {
    if (State.gameSession.isHost) {
      if (getConnectedRemotePlayerIds().length === 0) return;
      broadcastData({ type: 'ping', t: Date.now() });
    } else {
      const c = connections.get('host');
      if (c?.open) c.send({ type: 'ping', t: Date.now() });
    }
  } catch (_) { /* ignore */ }
}

function tickHostBackgroundSim() {
  if (typeof document === 'undefined' || !document.hidden) return;
  import('./loop.js')
    .then(m => {
      if (typeof m.runHostedSimBackgroundBurst === 'function') {
        m.runHostedSimBackgroundBurst();
      }
    })
    .catch(() => {});
}

function onMpDocumentVisibilityChange() {
  if (State.gameSession.isHost) {
    import('./loop.js')
      .then(m => {
        if (typeof m.resetHostBackgroundBurstClock === 'function') {
          m.resetHostBackgroundBurstClock();
        }
      })
      .catch(() => {});
  }
  if (!State.gameSession.isMultiplayer) return;
  if (State.gameSession.isHost) {
    if (document.hidden) {
      setLobbyMenuStatus(
        'Host tab in background — backup timer keeps sim & snapshots (slower than focused). Refocus for best results.'
      );
      import('./ui.js')
        .then(m => m.showStatus('Host tab in background — refocus when possible.'))
        .catch(() => {});
    } else {
      refreshHostLobbyConnectionUi();
      import('./ui.js')
        .then(m => m.showStatus('Host tab active — full frame rate.'))
        .catch(() => {});
    }
  } else if (document.hidden) {
    if (!State.gameSession.gameStarted && State.gameSession.menuOpen) {
      setLobbyMenuStatus(
        'Client tab in background — updates may lag. Refocus if the menu looks stale.'
      );
    } else if (State.gameSession.gameStarted) {
      import('./ui.js')
        .then(m =>
          m.showStatus('Client tab in background — match may stutter until you refocus.')
        )
        .catch(() => {});
    }
  }
}

function setLobbyMenuStatus(text) {
  const el = document.getElementById('menu-status');
  if (el) el.textContent = text;
  const vr = document.getElementById('menu-status-vr');
  if (vr && typeof vr.setAttribute === 'function') {
    vr.setAttribute('value', text);
    // A-Frame `a-text`: some builds only refresh when `text` component is updated.
    try {
      const t = vr.getAttribute('text');
      if (t && typeof t === 'object') {
        vr.setAttribute('text', { ...t, value: text });
      } else {
        vr.setAttribute('text', { value: text, align: 'center', width: 0.72, color: '#cccccc' });
      }
    } catch (_) { /* ignore */ }
  }
}

/** Host: human count = you + open data connections in seats 1–3 (BattleVR-style lobby readout). */
function hostLobbyHumanCount() {
  return 1 + getConnectedRemotePlayerIds().length;
}

function refreshHostLobbyConnectionUi() {
  if (!State.gameSession.isMultiplayer || !State.gameSession.isHost) return;
  const n = hostLobbyHumanCount();
  const r = n - 1;
  const L = selectedLobby;
  const tail = State.gameSession.gameStarted
    ? State.gameSession.mpSessionPaused
      ? 'Match PAUSED — resume from the pause banner when ready (dropped seats → AI).'
      : 'Match running — snapshots to remotes.'
    : 'Pick a mode, then Start when ready.';
  setLobbyMenuStatus(
    `Host · lobby ${L} — ${n}/${MAX_PLAYERS} players (${r} remote). ${tail}`
  );
}

// --- HOST ---
export async function startHosting() {
  if (State.gameSession.isMultiplayer) return;

  teardownPeerOnly();
  syncMpPauseUi();

  const sessionID = hostSessionId();

  try {
    const iceServers = await getPeerIceServers();
    peer = new Peer(sessionID, {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
      config: { iceServers },
    });

    peer.on('open', () => {
      State.gameSession.isMultiplayer = true;
      State.gameSession.isHost = true;
      console.log(`✅ Hosting as ${sessionID}`);

      refreshHostLobbyConnectionUi();
    });

    peer.on('disconnected', () => {
      console.warn('[RTSVR2] PeerJS server disconnected (host)');
      setLobbyMenuStatus(
        'Signalling link dropped — if remotes freeze, stop Hosting and Host again (same lobby #).'
      );
      import('./ui.js')
        .then(m =>
          m.showStatus('Signalling disconnected. Remotes may recover; if not, re-Host the same lobby.')
        )
        .catch(() => {});
    });

    peer.on('connection', conn => {
      /**
       * PeerJS: for the callee, `open` can fire before `conn.on('open', …)` runs.
       * If we only listen for `open`, the handler never runs → no roster, no UI, no assignment.
       */
      let hostConnReadyDone = false;
      const onHostIncomingConnectionReady = () => {
        if (hostConnReadyDone) return;
        hostConnReadyDone = true;

        let assignedId = null;
        for (let i = 1; i < 4; i++) {
          if (!connections.has(i)) {
            assignedId = i;
            break;
          }
        }

        if (assignedId === null) {
          try {
            conn.send({ type: 'lobby-full' });
          } catch (_) { /* ignore */ }
          conn.close();
          console.warn('Lobby full — connection rejected');
          return;
        }

        connections.set(assignedId, conn);
        State.players[assignedId].isHuman = true;
        State.players[assignedId].isBot = false;

        conn.send({
          type: 'player-assignment',
          playerId: assignedId,
        });

        const humanCount = hostLobbyHumanCount();
        broadcastData({
          type: 'player-joined',
          playerId: assignedId,
          lobby: selectedLobby,
          humanCount,
          maxHumans: MAX_PLAYERS,
        });

        refreshHostLobbyConnectionUi();
        console.log(`✅ Player ${assignedId} connected (${humanCount}/${MAX_PLAYERS} humans)`);

        conn.on('data', data => handleClientData(data, assignedId));

        conn.on('close', () => {
          connections.delete(assignedId);
          if (State.gameSession.gameStarted && !State.gameSession.gameOver) {
            if (!Array.isArray(State.gameSession.mpPendingHumanDropSeatIds)) {
              State.gameSession.mpPendingHumanDropSeatIds = [];
            }
            if (!State.gameSession.mpPendingHumanDropSeatIds.includes(assignedId)) {
              State.gameSession.mpPendingHumanDropSeatIds.push(assignedId);
            }
            State.gameSession.mpSessionPaused = true;
            State.gameSession.mpPauseReason = 'remote_left';
            const cnt = State.gameSession.mpPendingHumanDropSeatIds.length;
            State.gameSession.mpPauseTitle =
              cnt > 1 ? `${cnt} players disconnected` : `Player ${assignedId + 1} disconnected`;
            const arSec = Math.round(NET_HOST_PAUSE_AUTO_RESUME_MS / 1000);
            State.gameSession.mpPauseDetail =
              `The match is paused — simulation is frozen. The host can resume now, or play continues automatically on a timer (dropped seats → AI, up to ${arSec}s unless reset). Each new disconnect resets the countdown.`;
            const seats = State.gameSession.mpPendingHumanDropSeatIds.map(i => `P${i + 1}`).join(', ');
            State.gameSession.mpPauseSubline = `Pending seats: ${seats} → AI on Resume or when the countdown reaches 0.`;
            scheduleHostPauseAutoResume();
            broadcastData({
              type: 'session-pause',
              reason: 'remote_left',
              seats: [...State.gameSession.mpPendingHumanDropSeatIds],
              title: State.gameSession.mpPauseTitle,
              detail: State.gameSession.mpPauseDetail,
              subline: State.gameSession.mpPauseSubline,
              autoResumeAt: State.gameSession.mpPauseAutoResumeAt,
            });
            syncMpPauseUi();
          } else {
            State.players[assignedId].isHuman = false;
            State.players[assignedId].isBot = true;
            const n = hostLobbyHumanCount();
            broadcastData({
              type: 'player-left',
              playerId: assignedId,
              lobby: selectedLobby,
              humanCount: n,
              maxHumans: MAX_PLAYERS,
            });
          }
          refreshHostLobbyConnectionUi();
          console.log(`❌ Player ${assignedId} disconnected`);
        });
      };

      conn.on('open', onHostIncomingConnectionReady);
      if (conn.open) {
        queueMicrotask(onHostIncomingConnectionReady);
      }
    });

    peer.on('error', err => {
      console.error('Host error:', err);
      const t = err?.type || '';
      if (t === 'unavailable-id' || t === 'invalid-id') {
        setLobbyMenuStatus(
          `Lobby ${selectedLobby} id is in use — change lobby (− / +) and Host again`
        );
      } else {
        setLobbyMenuStatus(`Network error (host): ${err?.message || err || 'unknown'}`);
      }
      teardownPeerOnly();
      State.gameSession.isMultiplayer = false;
      State.gameSession.isHost = false;
      syncMpPauseUi();
    });
  } catch (err) {
    console.error('Failed to host:', err);
  }
}

// --- CLIENT ---
const JOIN_OPEN_MS = 14000;

export async function joinGame() {
  if (State.gameSession.isMultiplayer) return;

  if (clientRejoinTimerId) {
    clearTimeout(clientRejoinTimerId);
    clientRejoinTimerId = null;
  }

  teardownPeerOnly();
  syncMpPauseUi();

  const hostId = hostSessionId();
  const clientId = `rtsvr2-client-${Date.now().toString(36)}`;

  try {
    const iceServers = await getPeerIceServers();
    peer = new Peer(clientId, {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
      config: { iceServers },
    });

    peer.on('open', () => {
      setLobbyMenuStatus(`Connecting to lobby ${selectedLobby}…`);
      const conn = peer.connect(hostId, {
        reliable: true,
        serialization: 'json',
      });
      let settled = false;
      let openTimer = null;

      const failJoin = (msg) => {
        if (settled) return;
        settled = true;
        if (openTimer) clearTimeout(openTimer);
        setLobbyMenuStatus(msg);
        teardownPeerOnly();
        State.gameSession.isMultiplayer = false;
        State.gameSession.isHost = false;
        syncMpPauseUi();
      };

      openTimer = setTimeout(() => {
        failJoin(
          `No host answered in lobby ${selectedLobby}. Pick the same number as the host, or wait for them to Host.`
        );
      }, JOIN_OPEN_MS);

      conn.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        clientAutoRejoinAttempts = 0;
        State.gameSession.isMultiplayer = true;
        State.gameSession.isHost = false;
        connections.set('host', conn);
        console.log(`✅ Connected to host: ${hostId}`);

        setLobbyMenuStatus(
          `Connected — lobby ${selectedLobby} · waiting for roster from host…`
        );
        syncMpPauseUi();

        conn.on('data', data => handleHostData(data));

        conn.on('close', () => {
          console.log('❌ Disconnected from host');
          lastClientPlayerTeamSig = '';
          clearAllPendingClientAcks(true, 'disconnected');
          const inLobby = !State.gameSession.gameStarted;
          const inMatch =
            State.gameSession.gameStarted && !State.gameSession.gameOver;
          const lobbyNum = selectedLobby;

          if (inMatch) {
            State.gameSession.mpSessionPaused = true;
            State.gameSession.mpPauseReason = 'lost_host';
            State.gameSession.mpPauseTitle = 'Lost connection to host';
            State.gameSession.mpPauseDetail =
              'Your link to the host dropped. The simulation on your device is frozen until you reconnect. The host may have paused the match if another seat disconnected.';
            State.gameSession.mpPauseSubline = '';
          } else if (inLobby) {
            State.gameSession.mpSessionPaused = true;
            State.gameSession.mpPauseReason = 'lobby_drop';
            State.gameSession.mpPauseTitle = 'Disconnected from host (lobby)';
            State.gameSession.mpPauseDetail =
              'The lobby connection closed. If automatic retries remain, the client will reconnect; otherwise use Join again with the same lobby number as the host.';
            State.gameSession.mpPauseSubline = '';
          }

          State.gameSession.isMultiplayer = false;
          State.gameSession.isHost = false;
          connections.delete('host');

          const hud = document.getElementById('hud-status');
          if (hud) hud.textContent = 'Disconnected from host.';

          if (inLobby && clientAutoRejoinAttempts < NET_CLIENT_AUTO_REJOIN_MAX) {
            clientAutoRejoinAttempts += 1;
            setLobbyMenuStatus(
              `Disconnected — reconnecting to lobby ${lobbyNum} (${clientAutoRejoinAttempts}/${NET_CLIENT_AUTO_REJOIN_MAX})…`
            );
            State.gameSession.mpPauseSubline = `Automatic reconnect attempt ${clientAutoRejoinAttempts} of ${NET_CLIENT_AUTO_REJOIN_MAX} in ${Math.round(NET_CLIENT_AUTO_REJOIN_DELAY_MS / 1000)}s…`;
            syncMpPauseUi();
            clientRejoinTimerId = setTimeout(() => {
              clientRejoinTimerId = null;
              joinGame().catch(() => {});
            }, NET_CLIENT_AUTO_REJOIN_DELAY_MS);
          } else {
            clientAutoRejoinAttempts = 0;
            setLobbyMenuStatus(
              `Disconnected from host. Use Join again (lobby ${lobbyNum}, same # as host).`
            );
            if (inMatch) {
              State.gameSession.mpPauseSubline =
                'No automatic in-match reconnect — open the menu and Join the same lobby when the host is online.';
              import('./ui.js')
                .then(m =>
                  m.showStatus(
                    'Lost connection to host. Join the same lobby again when the host is back.'
                  )
                )
                .catch(() => {});
            } else {
              State.gameSession.mpPauseSubline =
                'Automatic lobby reconnect gave up — tap Join again with the same lobby # as the host.';
            }
            syncMpPauseUi();
          }
        });
      });

      conn.on('error', err => {
        console.error('Connection error:', err);
        failJoin(`Could not open data channel: ${err?.message || err || 'unknown'}`);
      });
    });

    peer.on('disconnected', () => {
      console.warn('[RTSVR2] PeerJS server disconnected (client)');
      setLobbyMenuStatus(
        `Signalling link dropped — lobby ${selectedLobby}. Try Join again if the match does not recover.`
      );
      import('./ui.js')
        .then(m => m.showStatus('Signalling disconnected from PeerJS cloud — reconnect with Join if needed.'))
        .catch(() => {});
    });

    peer.on('error', err => {
      console.error('Join error:', err);
      setLobbyMenuStatus(`Could not connect: ${err?.message || err || 'unknown'}`);
      teardownPeerOnly();
      State.gameSession.isMultiplayer = false;
      State.gameSession.isHost = false;
      syncMpPauseUi();
    });
  } catch (err) {
    console.error('Failed to join:', err);
  }
}

// --- HOST: Handle client commands ---
function handleClientData(data, fromPlayerId) {
  if (fromPlayerId == null) return;
  if (data?.type === 'ping') {
    const conn = connections.get(fromPlayerId);
    if (conn?.open) {
      try {
        conn.send({ type: 'pong', t: data.t });
      } catch (_) { /* ignore */ }
    }
    return;
  }
  if (data?.type === 'pong') return;
  if (data?.type === 'command') {
    let result;
    try {
      result = executeCommand(data, fromPlayerId);
    } catch (err) {
      console.error('[RTSVR2] Host command execution error', err);
      result = { ok: false, code: 'unknown_action' };
    }
    const cmdId = data.cmdId;
    if (cmdId != null) {
      const conn = connections.get(fromPlayerId);
      if (conn?.open) {
        try {
          conn.send({
            type: 'command-result',
            cmdId,
            ok: result.ok,
            code: result.code ?? undefined,
          });
        } catch (_) { /* ignore */ }
      }
    }
  }
}

// --- CLIENT: Handle server snapshots ---
function handleHostData(data) {
  if (!data || !data.type) return;
  if (data.type === 'ping') {
    const c = connections.get('host');
    if (c?.open) {
      try {
        c.send({ type: 'pong', t: data.t });
      } catch (_) { /* ignore */ }
    }
    return;
  }
  if (data.type === 'pong') return;
  switch (data.type) {
    case 'player-assignment':
      State.gameSession.myPlayerId = data.playerId;
      console.log(`Assigned player ${data.playerId}`);
      break;

    case 'snapshot': {
      try {
        applySnapshot(data.snapshot);
      } catch (err) {
        console.error('[RTSVR2] applySnapshot failed', err);
      }
      break;
    }

    case 'game-start':
      lastClientSnapshotSeq = -1;
      clearMpPauseState();
      syncMpPauseUi();
      lastClientPlayerTeamSig = '';
      State.gameSession.gameStarted = true;
      State.gameSession.menuOpen = false;
      State.deselectAll();
      State.clearBuildPlacementFlags();
      {
        const b = document.getElementById('build-placement-banner');
        if (b) b.style.display = 'none';
        document.body.style.cursor = '';
      }
      import('./input.js')
        .then(m => {
          if (typeof m.positionCameraForPlayer === 'function') {
            m.positionCameraForPlayer(State.gameSession.myPlayerId);
          }
        })
        .catch(() => {});
      import('./ui.js')
        .then(async m => {
          m.updateMenuVisibility();
          try {
            const inp = await import('./input.js');
            if (typeof inp.getInputPlatform === 'function' && inp.getInputPlatform() === 'touch') {
              m.setMinimapVisible(true);
            }
          } catch (_) {
            /* ignore */
          }
        })
        .catch(() => {});
      break;

    case 'player-joined': {
      const L = data.lobby != null ? data.lobby : selectedLobby;
      const maxH = data.maxHumans != null ? data.maxHumans : MAX_PLAYERS;
      const n = data.humanCount;
      const my = State.gameSession.myPlayerId;
      const seat = typeof my === 'number' ? `You: P${my + 1}` : 'You: (assigning…)';
      if (typeof n === 'number') {
        const who =
          data.playerId === my
            ? 'You joined'
            : `P${(data.playerId ?? 0) + 1} joined`;
        setLobbyMenuStatus(
          `Lobby ${L} — ${n}/${maxH} players · ${who}. ${seat}. Host starts the match.`
        );
      } else {
        setLobbyMenuStatus(`Lobby ${L} — player ${data.playerId} joined. ${seat}.`);
      }
      console.log(`Player ${data.playerId} joined (${n}/${maxH} humans)`);
      break;
    }

    case 'player-left': {
      const L = data.lobby != null ? data.lobby : selectedLobby;
      const maxH = data.maxHumans != null ? data.maxHumans : MAX_PLAYERS;
      const n = data.humanCount;
      const left = data.playerId != null ? `P${data.playerId + 1} left` : 'A player left';
      if (typeof n === 'number') {
        setLobbyMenuStatus(`Lobby ${L} — ${n}/${maxH} players · ${left}.`);
      } else {
        setLobbyMenuStatus(`Lobby ${L} — ${left}.`);
      }
      console.log(`Player ${data.playerId} left (${n}/${maxH} humans)`);
      break;
    }

    case 'lobby-full': {
      if (clientRejoinTimerId) {
        clearTimeout(clientRejoinTimerId);
        clientRejoinTimerId = null;
      }
      clientAutoRejoinAttempts = 0;
      clearAllPendingClientAcks(true, 'lobby_full');
      State.gameSession.isMultiplayer = false;
      State.gameSession.isHost = false;
      connections.delete('host');
      clearMpPauseState();
      setLobbyMenuStatus('Lobby is full. Try another host or start your own.');
      syncMpPauseUi();
      console.warn('Could not join: lobby full');
      break;
    }

    case 'session-pause': {
      State.gameSession.mpSessionPaused = true;
      State.gameSession.mpPauseReason = data.reason || 'unknown';
      const seats = Array.isArray(data.seats) ? data.seats : [];
      State.gameSession.mpPendingHumanDropSeatIds = seats.slice();
      if (data.title) {
        State.gameSession.mpPauseTitle = data.title;
      } else if (seats.length > 1) {
        State.gameSession.mpPauseTitle = `${seats.length} players disconnected`;
      } else if (seats.length === 1) {
        State.gameSession.mpPauseTitle = `Player ${seats[0] + 1} disconnected`;
      } else {
        State.gameSession.mpPauseTitle = 'Match paused';
      }
      State.gameSession.mpPauseDetail =
        data.detail ||
        'The host has paused the match because of a network disconnect.';
      State.gameSession.mpPauseSubline =
        data.subline ||
        (State.gameSession.isHost
          ? 'When you are ready, tap Resume — listed seats become AI and everyone continues.'
          : 'Orders are disabled while paused. Wait for the host to resume.');
      State.gameSession.mpPauseAutoResumeAt =
        typeof data.autoResumeAt === 'number' && data.autoResumeAt > 0 ? data.autoResumeAt : 0;
      syncMpPauseUi();
      break;
    }

    case 'session-resume': {
      clearMpPauseState();
      syncMpPauseUi();
      break;
    }

    case 'command-result':
      if (data.cmdId != null) fulfillClientAck(data.cmdId, data.ok, data.code);
      break;

    default:
      if (data.type) console.warn('[RTSVR2] Unknown message from host:', data.type);
      break;
  }
}

function filterUnitsOwned(playerId, unitIds) {
  if (!Array.isArray(unitIds)) return [];
  return unitIds.filter(id => {
    const u = State.units.get(id);
    return u && u.ownerId === playerId && u.hp > 0;
  });
}

/** Host-authoritative execution; returns { ok, code? }. */
function executeCommand(data, actingPlayerId) {
  if (State.gameSession.isMultiplayer && State.gameSession.isHost && State.gameSession.mpSessionPaused) {
    return { ok: false, code: 'session_paused' };
  }
  switch (data.action) {
    case 'move': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds);
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      Units.commandMove(ids, data.x, data.z);
      return { ok: true };
    }
    case 'attack': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds);
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      const target = State.units.get(data.targetId);
      if (!target || target.hp <= 0) return { ok: false, code: 'invalid_target' };
      const actor = State.players[actingPlayerId];
      if (!actor) return { ok: false, code: 'no_player' };
      if (target.team === actor.team) return { ok: false, code: 'friendly_target' };
      Units.commandAttackUnit(ids, data.targetId);
      return { ok: true };
    }
    case 'attackBuilding': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds);
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      const target = State.buildings.get(data.targetId);
      if (!target || target.hp <= 0) return { ok: false, code: 'invalid_target' };
      const actor = State.players[actingPlayerId];
      const owner = State.players[target.ownerId];
      if (!actor) return { ok: false, code: 'no_player' };
      if (owner && owner.team === actor.team) {
        return { ok: false, code: 'friendly_target' };
      }
      Units.commandAttackBuilding(ids, data.targetId);
      return { ok: true };
    }
    case 'follow': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds);
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      const target = State.units.get(data.targetId);
      if (!target || target.hp <= 0) return { ok: false, code: 'invalid_target' };
      Units.commandFollow(ids, data.targetId);
      return { ok: true };
    }
    case 'deployMobileHq': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds).filter(id => {
        const u = State.units.get(id);
        return u && u.type === 'mobileHq';
      });
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      let n = 0;
      for (let i = 0; i < ids.length; i++) {
        const u = State.units.get(ids[i]);
        if (u && Buildings.tryDeployMobileHq(u)) n++;
      }
      if (n === 0) return { ok: false, code: 'deployment_blocked' };
      return { ok: true };
    }
    case 'harvestField': {
      const field = State.resourceFields.get(data.fieldId);
      if (!field || field.depleted) return { ok: false, code: 'invalid_field' };
      const actor = State.players[actingPlayerId];
      if (!actor) return { ok: false, code: 'no_player' };
      if (!Fog.wasExploredByTeam(actor.team, field.x, field.z)) {
        return { ok: false, code: 'field_not_visible' };
      }
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds).filter(id => {
        const u = State.units.get(id);
        return u && u.type === 'harvester';
      });
      if (ids.length === 0) return { ok: false, code: 'no_harvesters' };
      let okCount = 0;
      for (let i = 0; i < ids.length; i++) {
        const u = State.units.get(ids[i]);
        if (Resources.assignHarvesterToField(u, field.id)) okCount++;
      }
      if (okCount === 0) return { ok: false, code: 'no_refinery' };
      return { ok: true };
    }
    case 'stop': {
      const ids = filterUnitsOwned(actingPlayerId, data.unitIds);
      if (ids.length === 0) return { ok: false, code: 'no_units' };
      Units.commandStop(ids);
      return { ok: true };
    }
    case 'build': {
      const fail = Buildings.getPlaceBuildingFailureCode(
        data.buildingType,
        actingPlayerId,
        data.x,
        data.z
      );
      if (fail) return { ok: false, code: fail };
      const placed = Buildings.placeBuilding(data.buildingType, actingPlayerId, data.x, data.z);
      if (!placed) return { ok: false, code: 'placement_failed' };
      return { ok: true };
    }
    case 'produce': {
      const b = State.buildings.get(data.buildingId);
      if (!b || b.ownerId !== actingPlayerId) return { ok: false, code: 'not_owner' };
      const fail = Buildings.getQueueUnitFailureCode(data.buildingId, data.unitType);
      if (fail) return { ok: false, code: fail };
      Buildings.queueUnit(data.buildingId, data.unitType);
      return { ok: true };
    }
    case 'cancelProduce': {
      const b = State.buildings.get(data.buildingId);
      if (!b || b.ownerId !== actingPlayerId) return { ok: false, code: 'not_owner' };
      const fail = Buildings.getCancelUnitFailureCode(data.buildingId, data.unitType);
      if (fail) return { ok: false, code: fail };
      Buildings.cancelUnit(data.buildingId, data.unitType);
      return { ok: true };
    }
    default:
      return { ok: false, code: 'unknown_action' };
  }
}

/**
 * Runs locally (single-player or host). Multiplayer client sends to host.
 * Returns boolean: local/host = success; client without onResult = message sent.
 * Optional onResult(ok, code?): code is a stable failure id when ok is false.
 */
export function sendCommand(command, onResult) {
  const me = State.gameSession.myPlayerId;

  const runLocal = () => {
    const r = executeCommand(command, me);
    if (typeof onResult === 'function') onResult(r.ok, r.code);
    return r.ok;
  };

  if (!State.gameSession.isMultiplayer) {
    if (State.gameSession.mpSessionPaused) {
      const cb = typeof onResult === 'function' ? onResult : () => {};
      cb(false, 'session_paused');
      return false;
    }
    return runLocal();
  }
  if (State.gameSession.isHost) {
    return runLocal();
  }

  if (State.gameSession.mpSessionPaused) {
    const cb = typeof onResult === 'function' ? onResult : () => {};
    cb(false, 'session_paused');
    return false;
  }

  const conn = connections.get('host');
  if (!conn?.open) {
    if (typeof onResult === 'function') onResult(false, 'network');
    return false;
  }

  /** Always use cmdId + ack so the host always returns `command-result` — fire-and-forget was starving UI. */
  const cmdId = ++clientCmdSeq;
  const cb = typeof onResult === 'function' ? onResult : () => {};
  const timerId = setTimeout(() => fulfillClientAck(cmdId, false, 'timeout'), NET_CLIENT_CMD_TIMEOUT_MS);
  pendingClientAcks.set(cmdId, { onResult: cb, timerId });
  try {
    conn.send({ type: 'command', ...command, cmdId });
  } catch (err) {
    clearTimeout(timerId);
    pendingClientAcks.delete(cmdId);
    cb(false, 'send_failed');
    return false;
  }
  return true;
}

/** Smoothstep 0..1 */
function stp01(t) {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

function reseedClientUnitInterpolation(unit, uData) {
  const now = performance.now();
  let dur = clientSnapshotInterpGapMs;
  if (!Number.isFinite(dur) || dur < 20) dur = 1000 / NET_SNAPSHOT_RATE;
  dur = Math.max(28, Math.min(170, dur));

  const dx = uData.x - unit.x;
  const dz = uData.z - unit.z;
  if (dx * dx + dz * dz > 55 * 55) {
    unit.x = uData.x;
    unit.z = uData.z;
    unit.rotation = typeof uData.rotation === 'number' ? uData.rotation : unit.rotation;
    unit._ix0 = unit._ix1 = unit.x;
    unit._iz0 = unit._iz1 = unit.z;
    unit._ir0 = unit._ir1 = unit.rotation;
    unit._iT0 = now;
    unit._iDur = dur;
    return;
  }

  unit._ix0 = unit.x;
  unit._iz0 = unit.z;
  unit._ix1 = uData.x;
  unit._iz1 = uData.z;
  unit._ir0 = unit.rotation;
  unit._ir1 = typeof uData.rotation === 'number' ? uData.rotation : unit.rotation;
  unit._iT0 = now;
  unit._iDur = dur;
}

/** MP client: interpolate each unit along the last snapshot segment (smooth motion between host samples). */
export function smoothNetClientUnitPositions(dt) {
  const now = performance.now();
  State.units.forEach(unit => {
    if (!unit || unit.hp <= 0) return;
    if (unit._iT0 == null || unit._iDur == null || unit._ix1 == null) return;
    let u = (now - unit._iT0) / unit._iDur;
    if (u >= 1) {
      unit.x = unit._ix1;
      unit.z = unit._iz1;
      unit.rotation = unit._ir1;
      return;
    }
    const s = stp01(u);
    unit.x = unit._ix0 + (unit._ix1 - unit._ix0) * s;
    unit.z = unit._iz0 + (unit._iz1 - unit._iz0) * s;
    let dr = unit._ir1 - unit._ir0;
    while (dr > Math.PI) dr -= Math.PI * 2;
    while (dr < -Math.PI) dr += Math.PI * 2;
    unit.rotation = unit._ir0 + dr * s;
  });
}

// --- Broadcast (host only) ---
export function broadcastData(data) {
  if (!State.gameSession.isHost) return;
  connections.forEach(conn => {
    if (conn && conn.open) {
      try {
        conn.send(data);
      } catch (_) { /* ignore */ }
    }
  });
}

// --- State snapshot (host sends periodically) ---
export function updateNetwork(time) {
  if (!State.gameSession.isMultiplayer || !State.gameSession.isHost) return;
  if (!State.gameSession.gameStarted) return;

  // Send snapshots at configured rate
  if (time - lastSnapshotTime < (1000 / NET_SNAPSHOT_RATE)) return;
  lastSnapshotTime = time;

  hostSnapshotSeq += 1;
  const snapshot = {
    seq: hostSnapshotSeq,
    time: State.gameSession.elapsedTime,
    gameOver: State.gameSession.gameOver,
    winner: State.gameSession.winner,
    fx: State.takeHostFxForSnapshot(),
    units: [],
    buildings: [],
    players: State.players.map(p => ({
      credits: p.credits,
      income: p.income,
      isDefeated: p.isDefeated,
      team: p.team,
      stats: p.stats
        ? {
            unitsProduced: p.stats.unitsProduced,
            unitsLost: p.stats.unitsLost,
            kills: p.stats.kills,
            buildingsBuilt: p.stats.buildingsBuilt,
            buildingsLost: p.stats.buildingsLost,
            creditsEarned: p.stats.creditsEarned,
          }
        : undefined,
    })),
    resourceFields: [],
  };

  State.resourceFields.forEach(f => {
    snapshot.resourceFields.push({
      id: f.id,
      remaining: f.remaining,
      depleted: !!f.depleted,
    });
  });

  State.units.forEach(u => {
    snapshot.units.push({
      id: u.id,
      type: u.type,
      ownerId: u.ownerId,
      team: u.team,
      x: u.x,
      z: u.z,
      hp: u.hp,
      maxHp: u.maxHp,
      state: u.state,
      rotation: u.rotation,
      lastFireTime: u.lastFireTime,
      playerCommanded: !!u.playerCommanded,
      targetUnitId: u.targetUnitId ?? null,
      followLeadId: u.followLeadId ?? null,
      squadOffsetX: u.squadOffsetX ?? 0,
      squadOffsetZ: u.squadOffsetZ ?? 0,
      targetBuildingId: u.targetBuildingId ?? null,
      targetPos: u.targetPos ? { x: u.targetPos.x, z: u.targetPos.z } : null,
      guardPos: u.guardPos ? { x: u.guardPos.x, z: u.guardPos.z } : null,
      cargo: u.cargo,
      assignedRefinery: u.assignedRefinery ?? null,
      assignedField: u.assignedField ?? null,
      lastHarvestedField: u.lastHarvestedField ?? null,
    });
  });

  State.buildings.forEach(b => {
    snapshot.buildings.push({
      id: b.id,
      type: b.type,
      ownerId: b.ownerId,
      team: b.team,
      x: b.x,
      z: b.z,
      hp: b.hp,
      maxHp: b.maxHp,
      constructionProgress: b.constructionProgress,
      isBuilt: b.isBuilt,
      captureProgress: b.captureProgress || 0,
      rallyPoint: b.rallyPoint ? { x: b.rallyPoint.x, z: b.rallyPoint.z } : null,
      productionQueue: (b.productionQueue || []).map(q => ({
        unitType: q.unitType,
        remainingTime: q.remainingTime,
        totalTime: q.totalTime,
      })),
    });
  });

  broadcastData({ type: 'snapshot', snapshot });
}

/** Multiplayer client: replay host-authored visuals/sfx (no gameplay side effects). */
function applyHostFxEventsForClient(fxList) {
  for (const ev of fxList) {
    if (!ev || !ev.kind) continue;
    switch (ev.kind) {
      case 'shot': {
        const dur = typeof ev.duration === 'number' ? ev.duration : 200;
        const ty = typeof ev.ty === 'number' ? ev.ty : 0.8;
        Renderer.spawnProjectile(
          ev.x, 1.2, ev.z,
          ev.tx, ty, ev.tz,
          typeof ev.color === 'number' ? ev.color : 0xffffff,
          dur
        );
        if (ev.unitType) Audio.playShotSound(ev.unitType);
        break;
      }
      case 'unit_death': {
        const n = typeof ev.particles === 'number' ? ev.particles : 8;
        Effects.spawnExplosion(ev.x, 0.5, ev.z, n);
        Audio.playExplosionSound(typeof ev.volume === 'number' ? ev.volume : 0.3);
        break;
      }
      case 'building_death': {
        Effects.spawnExplosion(ev.x, 0.5, ev.z, 12);
        Audio.playExplosionSound(typeof ev.volume === 'number' ? ev.volume : 0.5);
        break;
      }
      case 'aoe_impact':
        Effects.spawnExplosion(ev.x, 0.5, ev.z, typeof ev.count === 'number' ? ev.count : 8);
        break;
      case 'build_complete':
        Audio.playBuildCompleteSound();
        break;
      case 'unit_ready':
        Audio.playUnitReadySound();
        break;
      case 'capture_tick':
        Audio.playCaptureTickSound();
        break;
      case 'capture_complete':
        Audio.playUnitReadySound();
        break;
      default:
        break;
    }
  }
}

/** Normalize host queue rows after JSON — missing numbers or odd shapes must not block MP clients. */
function sanitizeProductionQueueFromSnapshot(raw) {
  if (raw == null) return [];
  let list;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'object') {
    list = Object.keys(raw)
      .filter(k => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map(k => raw[k]);
  } else {
    list = [];
  }
  return list
    .filter(q => q && q.unitType)
    .map(q => {
      const rt = Number(q.remainingTime);
      const tt = Number(q.totalTime);
      const remainingTime = Number.isFinite(rt) ? Math.max(0, rt) : 0;
      const totalTime =
        Number.isFinite(tt) && tt > 0 ? tt : remainingTime > 0 ? remainingTime : 1;
      return {
        unitType: String(q.unitType),
        remainingTime,
        totalTime,
      };
    });
}

// --- Apply snapshot (client-side) ---
function applySnapshot(snapshot) {
  if (!snapshot) return;
  const isNetClient = State.gameSession.isMultiplayer && !State.gameSession.isHost;
  const snapSeq = snapshot.seq != null ? Number(snapshot.seq) : NaN;
  if (isNetClient && Number.isFinite(snapSeq)) {
    if (snapSeq <= lastClientSnapshotSeq) {
      return;
    }
  }

  const wall = performance.now();
  if (lastClientSnapWallMs > 0) {
    const gap = wall - lastClientSnapWallMs;
    if (gap > 5 && gap < 3000) {
      clientSnapshotInterpGapMs = clientSnapshotInterpGapMs * 0.62 + gap * 0.38;
      clientSnapshotInterpGapMs = Math.max(40, Math.min(220, clientSnapshotInterpGapMs));
    }
  }
  lastClientSnapWallMs = wall;

  let teamSig = '';
  snapshot.players.forEach((pData, i) => {
    const p = State.players[i];
    if (!p) return;
    p.credits = pData.credits;
    p.income = pData.income;
    p.isDefeated = pData.isDefeated;
    if (pData.team !== undefined) p.team = pData.team;
    if (pData.stats) {
      Object.assign(p.stats, pData.stats);
    }
    teamSig += `${p.team},`;
  });

  if (Array.isArray(snapshot.resourceFields)) {
    snapshot.resourceFields.forEach(rf => {
      const field = State.resourceFields.get(rf.id);
      if (!field) return;
      if (rf.remaining !== undefined) field.remaining = rf.remaining;
      if (rf.depleted !== undefined) field.depleted = rf.depleted;
    });
  }

  if (isNetClient && teamSig && teamSig !== lastClientPlayerTeamSig) {
    lastClientPlayerTeamSig = teamSig;
    Fog.initFog();
  }

  if (isNetClient && Array.isArray(snapshot.fx)) {
    applyHostFxEventsForClient(snapshot.fx);
  }

  const unitIdsInSnap = new Set(snapshot.units.map(u => u.id));
  const unitsToRemove = [];
  State.units.forEach((u, id) => {
    if (!unitIdsInSnap.has(id)) unitsToRemove.push(id);
  });
  unitsToRemove.forEach(id => State.removeUnit(id));

  snapshot.units.forEach(uData => {
    let unit = State.units.get(uData.id);
    if (!unit) {
      unit = Units.createUnit(uData.type, uData.ownerId, uData.x, uData.z, {
        id: uData.id,
        skipCapCheck: true,
        skipProducedStat: true,
        team: uData.team,
      });
      if (unit && typeof uData.rotation === 'number') {
        unit.rotation = uData.rotation;
      }
    }
    if (unit) {
      if (uData.team !== undefined && unit.team !== uData.team) {
        const oldT = unit.team;
        const oldSet = State.unitsByTeam.get(oldT);
        if (oldSet) oldSet.delete(unit.id);
        unit.team = uData.team;
        if (!State.unitsByTeam.has(unit.team)) State.unitsByTeam.set(unit.team, new Set());
        State.unitsByTeam.get(unit.team).add(unit.id);
      } else if (uData.team !== undefined) {
        unit.team = uData.team;
      }
      reseedClientUnitInterpolation(unit, uData);
      unit.hp = uData.hp;
      if (uData.maxHp !== undefined) unit.maxHp = uData.maxHp;
      unit.state = uData.state;
      if (uData.lastFireTime !== undefined) unit.lastFireTime = uData.lastFireTime;
      unit.playerCommanded = !!uData.playerCommanded;
      unit.targetUnitId = uData.targetUnitId != null ? uData.targetUnitId : null;
      unit.followLeadId = uData.followLeadId != null ? uData.followLeadId : null;
      unit.squadOffsetX = uData.squadOffsetX != null ? uData.squadOffsetX : 0;
      unit.squadOffsetZ = uData.squadOffsetZ != null ? uData.squadOffsetZ : 0;
      unit.targetBuildingId = uData.targetBuildingId != null ? uData.targetBuildingId : null;
      unit.targetPos = uData.targetPos ? { x: uData.targetPos.x, z: uData.targetPos.z } : null;
      unit.guardPos = uData.guardPos ? { x: uData.guardPos.x, z: uData.guardPos.z } : null;
      if (uData.cargo !== undefined) unit.cargo = uData.cargo;
      unit.assignedRefinery = uData.assignedRefinery != null ? uData.assignedRefinery : null;
      unit.assignedField = uData.assignedField != null ? uData.assignedField : null;
      unit.lastHarvestedField = uData.lastHarvestedField != null ? uData.lastHarvestedField : null;
    }
  });

  const bIdsInSnap = new Set(snapshot.buildings.map(b => b.id));
  let navDirty = false;
  const buildingsToRemove = [];
  State.buildings.forEach((b, id) => {
    if (!bIdsInSnap.has(id)) {
      buildingsToRemove.push(id);
      if (b.type !== 'hq') navDirty = true;
    }
  });
  buildingsToRemove.forEach(id => State.removeBuilding(id));

  snapshot.buildings.forEach(bData => {
    let building = State.buildings.get(bData.id);
    if (!building) {
      Buildings.createBuilding(bData.type, bData.ownerId, bData.x, bData.z, {
        id: bData.id,
        skipNavRebuild: true,
        team: bData.team,
      });
      if (bData.type !== 'hq') navDirty = true;
      building = State.buildings.get(bData.id);
    }
    if (building) {
      // Always sync world position: client may still hold pre-match lobby HQ (`bldg_0` etc.) at wrong x,z
      // while snapshot ids match the host — units were created fresh from snap so only buildings looked wrong.
      if (bData.x !== undefined && bData.z !== undefined) {
        if (building.x !== bData.x || building.z !== bData.z) {
          if (building.type === 'hq') navDirty = true;
          building.x = bData.x;
          building.z = bData.z;
        }
      }
      if (bData.ownerId !== undefined && building.ownerId !== bData.ownerId) {
        const oldSet = State.buildingsByPlayer.get(building.ownerId);
        if (oldSet) oldSet.delete(building.id);
        building.ownerId = bData.ownerId;
        if (!State.buildingsByPlayer.has(building.ownerId)) {
          State.buildingsByPlayer.set(building.ownerId, new Set());
        }
        State.buildingsByPlayer.get(building.ownerId).add(building.id);
      } else if (bData.ownerId !== undefined) {
        building.ownerId = bData.ownerId;
      }
      if (bData.team !== undefined) building.team = bData.team;
      building.hp = bData.hp;
      if (bData.maxHp !== undefined) building.maxHp = bData.maxHp;
      if (bData.rallyPoint) {
        building.rallyPoint = { x: bData.rallyPoint.x, z: bData.rallyPoint.z };
      }
      if (bData.constructionProgress !== undefined) {
        building.constructionProgress = bData.constructionProgress;
      }
      if (bData.isBuilt !== undefined) building.isBuilt = bData.isBuilt;
      building.captureProgress = bData.captureProgress ?? 0;
      // Full host sync each snapshot — never keep a stale queue if JSON shape is odd or a field was missing once.
      building.productionQueue = sanitizeProductionQueueFromSnapshot(bData.productionQueue);
    }
  });

  if (navDirty) Pathfinding.rebuildNavMesh();

  State.syncUnitCountsFromUnits();

  State.gameSession.elapsedTime = snapshot.time;
  if (snapshot.gameOver !== undefined) {
    State.gameSession.gameOver = snapshot.gameOver;
  }
  if (snapshot.winner !== undefined) {
    State.gameSession.winner = snapshot.winner;
  }

  if (isNetClient && Number.isFinite(snapSeq)) {
    lastClientSnapshotSeq = snapSeq;
  }
}

/** Host only: end session pause after remote disconnect — turn pending seats into AI and notify everyone. */
export function hostResumeFromPause() {
  if (!State.gameSession.isMultiplayer || !State.gameSession.isHost) return;
  if (!State.gameSession.mpSessionPaused) return;
  clearHostPauseAutoResumeTimer();
  const seats = [...(State.gameSession.mpPendingHumanDropSeatIds || [])];
  for (let si = 0; si < seats.length; si++) {
    const assignedId = seats[si];
    if (assignedId >= 1 && assignedId <= 3 && State.players[assignedId]) {
      State.players[assignedId].isHuman = false;
      State.players[assignedId].isBot = true;
    }
    const n = hostLobbyHumanCount();
    broadcastData({
      type: 'player-left',
      playerId: assignedId,
      lobby: selectedLobby,
      humanCount: n,
      maxHumans: MAX_PLAYERS,
    });
  }
  broadcastData({ type: 'session-resume' });
  clearMpPauseState();
  import('./ui.js')
    .then(m => {
      m.syncMpPauseOverlay();
      const label = seats.length
        ? `${seats.map(i => `P${i + 1}`).join(', ')} → AI`
        : 'continuing';
      m.showStatus(`Match resumed — ${label}.`);
    })
    .catch(() => {});
  refreshHostLobbyConnectionUi();
}
