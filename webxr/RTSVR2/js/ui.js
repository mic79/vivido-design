// ========================================
// RTSVR2 — UI System
// HUD, menus, build panel, production, minimap
// ========================================

import {
  UNIT_TYPES, BUILDING_TYPES, PLAYER_COLOR_HEX,
  MAP_SIZE, MAP_UNIT_PLAYABLE_RADIUS, FOG_GRID_SIZE,
  clampWorldToPlayableDisk,
} from './config.js';
import * as State from './state.js';
import * as Buildings from './buildings.js';
import * as Fog from './fog.js';
import * as Input from './input.js';
import * as Network from './network.js';

let hudContainer = null;
let minimapCanvas = null;
let minimapCtx = null;
let minimapVisible = false;
let menuEl = null;
let buildMenuEl = null;
let buildPanelEl = null;
export let activeBuildingPanel = null;
export let activeResourceField = null;
/** @type {string[]|null} When set, bottom panel shows Mobile HQ deploy (same shell as building build menu). */
let activeMobileDeployUnitIds = null;
let lastMobileDeploySelectionSig = null;
let lastBuildPanelUpdate = 0;
let vrMinimapCanvas = null;
let vrMinimapCtx = null;
let vrMinimapTexture = null;

let lastHudHelpPlatform = '';
let mpPauseCountdownIntervalId = null;

function uiMountRoot() {
  return document.getElementById('xr-dom-overlay') || document.body;
}

function createAppStartOverlay() {
  const el = document.createElement('div');
  el.id = 'app-start-overlay';
  /* No dimming layer — full screen is transparent so the WebXR / canvas scene stays visible. */
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:250',
    'display:none',
    'flex-direction:column',
    'width:100%',
    'height:100%',
    'box-sizing:border-box',
    'background:transparent',
    'pointer-events:none',
    "font-family:'Consolas',monospace",
  ].join(';');
  el.innerHTML = `
    <div style="flex:2 0 0;min-height:0" aria-hidden="true"></div>
    <div style="flex:1 0 0;display:flex;align-items:center;justify-content:center;width:100%;min-height:0;pointer-events:none">
      <button type="button" id="btn-app-start" style="padding:18px 48px;font-size:22px;border-radius:10px;border:2px solid #0f0;background:rgba(4,24,8,0.92);color:#cfc;cursor:pointer;font-weight:bold;letter-spacing:0.12em;pointer-events:auto;box-shadow:0 4px 24px rgba(0,0,0,0.45)">Start</button>
    </div>
  `;
  const btn = el.querySelector('#btn-app-start');
  if (btn) btn.addEventListener('click', () => dismissAppStartGate());
  uiMountRoot().appendChild(el);
}

function createMpPauseOverlay() {
  if (document.getElementById('mp-pause-overlay')) return;
  const el = document.createElement('div');
  el.id = 'mp-pause-overlay';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-live', 'assertive');
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:420',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'box-sizing:border-box',
    'padding:24px',
    'background:rgba(2,6,10,0.72)',
    'pointer-events:auto',
    "font-family:'Consolas',monospace",
    'color:#e8f4ff',
  ].join(';');
  el.innerHTML = `
    <div style="max-width:min(520px,92vw);background:rgba(8,20,32,0.96);border:2px solid #4a9eff;border-radius:12px;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,0.55)">
      <div id="mp-pause-title" style="font-size:20px;font-weight:bold;margin:0 0 10px 0;color:#9df">Paused</div>
      <div id="mp-pause-detail" style="font-size:14px;line-height:1.55;margin:0 0 12px 0;opacity:0.95"></div>
      <div id="mp-pause-subline" style="font-size:12px;line-height:1.45;margin:0 0 16px 0;opacity:0.88;color:#bde"></div>
      <button type="button" id="mp-pause-resume" style="display:none;padding:10px 22px;font-size:15px;border-radius:8px;border:2px solid #6c6;background:#143214;color:#cfc;cursor:pointer;font-weight:bold">
        Resume now (AI takes dropped seats)
      </button>
    </div>
  `;
  const btn = el.querySelector('#mp-pause-resume');
  if (btn) {
    btn.addEventListener('click', () => {
      Network.hostResumeFromPause();
    });
  }
  uiMountRoot().appendChild(el);
}

function clearMpPauseCountdownInterval() {
  if (mpPauseCountdownIntervalId != null) {
    clearInterval(mpPauseCountdownIntervalId);
    mpPauseCountdownIntervalId = null;
  }
}

function mpPauseFormattedSubline() {
  const base = State.gameSession.mpPauseSubline || '';
  const until = State.gameSession.mpPauseAutoResumeAt;
  if (!until || State.gameSession.mpPauseReason !== 'remote_left') return base;
  const rem = Math.ceil((until - Date.now()) / 1000);
  if (rem > 0) {
    const tail = ` Live countdown: ${rem}s.`;
    return base ? `${base}${tail}` : tail.trim();
  }
  return base ? `${base} Auto-resume starting…` : 'Auto-resume starting…';
}

/** Show or hide the multiplayer disconnect / session pause banner (host + clients). */
export function syncMpPauseOverlay() {
  createMpPauseOverlay();
  const root = document.getElementById('mp-pause-overlay');
  if (!root) return;
  if (!State.gameSession.mpSessionPaused) {
    clearMpPauseCountdownInterval();
    root.style.display = 'none';
    const flat = document.getElementById('menu-status');
    const vr = document.getElementById('menu-status-vr');
    if (vr && flat && flat.textContent) {
      const text = flat.textContent.slice(0, 240);
      vr.setAttribute('value', text);
      try {
        const comp = vr.getAttribute('text');
        if (comp && typeof comp === 'object') {
          vr.setAttribute('text', { ...comp, value: text });
        } else {
          vr.setAttribute('text', { value: text, align: 'center', width: 0.72, color: '#cccccc' });
        }
      } catch (_) { /* ignore */ }
    }
    return;
  }
  root.style.display = 'flex';
  const t = document.getElementById('mp-pause-title');
  const d = document.getElementById('mp-pause-detail');
  const s = document.getElementById('mp-pause-subline');
  const btn = document.getElementById('mp-pause-resume');
  if (t) t.textContent = State.gameSession.mpPauseTitle || 'Paused';
  if (d) d.textContent = State.gameSession.mpPauseDetail || '';
  const subFull = mpPauseFormattedSubline();
  if (s) s.textContent = subFull;
  if (btn) {
    const showResume =
      State.gameSession.isHost &&
      State.gameSession.isMultiplayer &&
      State.gameSession.mpPauseReason === 'remote_left';
    btn.style.display = showResume ? 'inline-block' : 'none';
  }
  const vr = document.getElementById('menu-status-vr');
  if (vr && typeof vr.setAttribute === 'function') {
    const line = `${State.gameSession.mpPauseTitle || 'Paused'} — ${subFull}`.trim();
    vr.setAttribute('value', line.slice(0, 240));
    try {
      const comp = vr.getAttribute('text');
      if (comp && typeof comp === 'object') {
        vr.setAttribute('text', { ...comp, value: line.slice(0, 240) });
      }
    } catch (_) { /* ignore */ }
  }

  clearMpPauseCountdownInterval();
  const until = State.gameSession.mpPauseAutoResumeAt;
  if (
    until > Date.now() &&
    State.gameSession.mpPauseReason === 'remote_left'
  ) {
    mpPauseCountdownIntervalId = setInterval(() => {
      if (!State.gameSession.mpSessionPaused) {
        clearMpPauseCountdownInterval();
        return;
      }
      const el = document.getElementById('mp-pause-subline');
      const line = mpPauseFormattedSubline();
      if (el) el.textContent = line;
      const vr2 = document.getElementById('menu-status-vr');
      if (vr2 && typeof vr2.setAttribute === 'function') {
        const vline = `${State.gameSession.mpPauseTitle || 'Paused'} — ${line}`.trim();
        vr2.setAttribute('value', vline.slice(0, 240));
        try {
          const comp2 = vr2.getAttribute('text');
          if (comp2 && typeof comp2 === 'object') {
            vr2.setAttribute('text', { ...comp2, value: vline.slice(0, 240) });
          }
        } catch (_) { /* ignore */ }
      }
    }, 500);
  }
}

export function initUI() {
  window.__rtsVrMinimapClick = (wx, wz, moveMode) => {
    if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;
    if (State.gameSession.mpSessionPaused) return;
    const c = clampWorldToPlayableDisk(wx, wz, 0);
    const px = c.x;
    const pz = c.z;
    if (moveMode) {
      const unitIds = Array.from(State.selectedUnits);
      if (unitIds.length > 0) {
        Network.sendCommand({ action: 'move', unitIds, x: px, z: pz });
        showStatus('Moving...');
      }
    } else {
      Input.jumpCameraTo(px, pz);
    }
  };

  createAppStartOverlay();
  createHUD();
  createMinimap();
  createMenu();
  createBuildMenu();
  createMpPauseOverlay();
  window._dismissAppStartGate = dismissAppStartGate;
  updateMenuVisibility();
}

// --- HUD ---
function getHudControlsHelpHtml() {
  if (Input.getIsVR()) {
    return `VR: <b>Right trigger</b> — select / move / attack (only that controller's laser is shown while the trigger is held). With units selected, tap another friendly to <b>add to selection</b>; hold <b>grip + trigger on the same hand</b> and aim at a friendly to <b>follow</b> (engineers repair nearby damaged vehicles). <b>Left X</b> — cancel build placement or open menu. <b>Y</b> map · <b>B</b> deselect & cancel build · <b>A</b> select all · grips pan.<br>
      <span style="opacity:0.85">Flat screen (if you peek at the mirror): WASD pan · Q/E rotate · scroll zoom · left / right click.</span>`;
  }
  if (Input.getInputPlatform() === 'touch') {
    return `<div style="font-weight:bold;color:#8cf;margin-bottom:6px;">Touch</div>
      <ul style="margin:0;padding-left:1.1em;line-height:1.5;">
        <li><b>Tap</b> — select, open HQ or crystals; with your army selected, <b>tap another of your units</b> to add it to the group · <b>tap open ground</b> to move</li>
        <li><b>Two fingers</b> — drag to pan · pinch zoom · twist to rotate</li>
        <li><b>Long-press open ground</b> — clear selection</li>
        <li><b>Long-press your unit</b> — with <b>no</b> army selected, selects nearby same type; with <b>units already selected</b>, <b>hold (~0.5s) on a friendly</b> to <b>follow</b> it (or move if your aim favors ground — engineers repair nearby vehicles when escorting)</li>
        <li><b>Map</b> — drag on minimap to jump the camera; <b>Map · show/hide</b> sits under the minimap</li>
      </ul>
      <p style="margin:10px 0 0 0;opacity:0.85;font-size:11px;">Zoom in (pinch) for easier taps on single units; zoomed out is best for overview and orders.</p>`;
  }
  return `WASD: Pan · Q/E: Rotate · Scroll: Zoom · Left: Select · Left on open ground: Deselect · Right: Move / attack / follow (engineers repair nearby friendly vehicles; right-click follow a vehicle to stay with it)<br>
    HQ click: Build · Mobile HQ selected: Deploy panel (new HQ & build zone) · Ctrl+S: Stop · 1–0: Squads · Space: Deselect · Tab: Map · <b>G</b>: terrain grid (off by default) · Esc: Menu<br>
    <span style="opacity:0.85">VR: Laser + trigger on menu & map · grip+trigger on one hand for follow · X menu · Y map · B deselect · A select all · grips pan</span>`;
}

function updateFlatHudButtons() {
  if (Input.getIsVR()) return;
  const m = document.getElementById('hud-minimap-toggle');
  if (m) {
    m.textContent = minimapVisible ? 'Map · hide' : 'Map · show';
    const showMapToggle =
      State.gameSession.gameStarted && !Input.getIsVR() && Input.getInputPlatform() === 'touch';
    m.style.display = showMapToggle ? '' : 'none';
  }
}

function wireFlatHudActions() {
  const gh = () => document.getElementById('game-hud');
  document.getElementById('hud-help-toggle')?.addEventListener('click', () => {
    const root = gh();
    if (!root) return;
    const open = root.classList.toggle('rts-help-open');
    const btn = document.getElementById('hud-help-toggle');
    if (btn) btn.textContent = open ? 'Close' : 'Help';
  });
  document.getElementById('hud-main-menu-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    Input.toggleMenu();
  });
}

function createHUD() {
  hudContainer = document.createElement('div');
  hudContainer.id = 'game-hud';
  lastHudHelpPlatform = '';
  hudContainer.innerHTML = `
    <div id="hud-resources" style="
      position: fixed; top: 8px; left: 8px;
      color: #0f0; font-family: 'Consolas', monospace; font-size: 14px;
      background: rgba(0,0,0,0.7); padding: 6px 12px; border-radius: 4px;
      z-index: 100; pointer-events: none; user-select: none;
    ">
      <div style="display: flex; flex-direction: row; align-items: flex-start; gap: 6px; flex-wrap: wrap;">
        <button type="button" id="hud-main-menu-toggle" class="hud" aria-label="Main menu"
          style="pointer-events: auto; flex: 0 0 auto; touch-action: manipulation;
          box-sizing: border-box; min-width: 44px; min-height: 44px; padding: 0 10px;
          border-radius: 6px; border: 1px solid #666; background: rgba(22,28,34,0.95); color: #ddd;
          font-family: Consolas, monospace; font-size: 20px; line-height: 1; align-items: center; justify-content: center;">☰</button>
        <div id="hud-resources-stats" style="flex: 1; min-width: 0;">
          <span id="hud-credits">$1000</span>
          <span style="color: #555; margin: 0 6px;">|</span>
          <span id="hud-income" style="color: #4f4;">+2/s</span>
          <span style="color: #555; margin: 0 6px;">|</span>
          <span id="hud-units" style="color: #aaf;">0/30</span>
          <span style="color: #555; margin: 0 6px;">|</span>
          <span id="hud-time" style="color: #ff8;">0:00</span>
        </div>
      </div>
      <div id="hud-bot-debug" style="
        display: none; margin-top: 5px; padding-top: 5px; border-top: 1px solid #333;
        font-size: 12px; color: #eb8; line-height: 1.45;
      "></div>
      <div id="hud-version-fps" style="
        margin-top: 4px; font-size: 11px; color: #8ab0aa; letter-spacing: 0.02em;
      ">RTSVR2 …</div>
    </div>
    <div id="hud-flat-actions" class="hud" style="
      display: none; position: fixed; top: 8px; right: 8px; z-index: 126;
      flex-direction: row; flex-wrap: wrap; justify-content: flex-end; gap: 6px; align-items: center;
      pointer-events: auto; user-select: none; touch-action: manipulation;
      font-family: Consolas, monospace;">
      <button type="button" id="hud-help-toggle" style="
        font-size: 12px; padding: 8px 12px; border-radius: 8px; border: 1px solid #666;
        background: rgba(22,28,34,0.95); color: #ddd;">Help</button>
    </div>
    <div id="hud-help-panel" class="hud">
      <div id="hud-controls" style="
        color: #bbb; font-family: 'Consolas', monospace; font-size: 12px;
        line-height: 1.55; pointer-events: none; user-select: none;
      ">${getHudControlsHelpHtml()}</div>
    </div>
    <div id="hud-selection" style="
      position: fixed; bottom: 8px; left: 8px;
      color: #fff; font-family: 'Consolas', monospace; font-size: 13px;
      background: rgba(0,0,0,0.7); padding: 6px 12px; border-radius: 4px;
      z-index: 100; pointer-events: none; user-select: none;
      display: none; max-width: min(400px, 92vw);
    "></div>
    <div id="hud-status" style="
      position: fixed; bottom: 8px; right: 8px;
      color: #ff0; font-family: 'Consolas', monospace; font-size: 13px;
      background: rgba(0,0,0,0.7); padding: 6px 12px; border-radius: 4px;
      z-index: 100; pointer-events: none; user-select: none; max-width: min(320px, 88vw);
    "></div>
    <div id="hud-victory" style="
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      color: #ff0; font-family: Arial, sans-serif; font-size: 36px; font-weight: bold;
      text-shadow: 0 0 20px rgba(255,255,0,0.5);
      background: rgba(0,0,0,0.8); padding: 30px 50px; border-radius: 12px;
      z-index: 200; display: none; text-align: center;
    "></div>
  `;
  uiMountRoot().appendChild(hudContainer);
  wireFlatHudActions();
  updateFlatHudButtons();
}

// --- Build Menu (building placement) ---
function createBuildMenu() {
  buildMenuEl = document.createElement('div');
  buildMenuEl.id = 'build-menu';
  buildMenuEl.style.cssText = `
    position: fixed; bottom: 60px; left: 50%; transform: translateX(-50%);
    background: rgba(0,10,0,0.9); padding: 12px 16px;
    border: 1px solid #0a0; border-radius: 8px;
    z-index: 150; display: none; text-align: center;
    font-family: 'Consolas', monospace;
  `;

  // The standalone B-key build menu has been removed, as building placement is now done by selecting the HQ.
}

// --- Minimap ---
function createMinimap() {
  const container = document.createElement('div');
  container.id = 'minimap-container';
  container.style.cssText = `
    position: fixed; bottom: 60px; right: 8px;
    width: 180px;
    display: none; flex-direction: column; align-items: center; gap: 6px;
    background: rgba(0,0,0,0.8); border: 1px solid #444; border-radius: 12px;
    padding: 6px 6px 8px; box-sizing: border-box;
    z-index: 100; pointer-events: auto;
  `;

  const mapWrap = document.createElement('div');
  mapWrap.id = 'minimap-map-wrap';
  mapWrap.style.cssText =
    'width: 180px; height: 180px; flex-shrink: 0; border-radius: 50%; overflow: hidden; box-shadow: 0 0 0 1px rgba(255,255,255,0.14);';

  minimapCanvas = document.createElement('canvas');
  minimapCanvas.id = 'minimap';
  minimapCanvas.width = 180;
  minimapCanvas.height = 180;
  minimapCanvas.style.cssText = 'width: 100%; height: 100%; border-radius: 50%; cursor: crosshair; display: block;';

  const mapToggleBtn = document.createElement('button');
  mapToggleBtn.type = 'button';
  mapToggleBtn.id = 'hud-minimap-toggle';
  mapToggleBtn.textContent = 'Map · show';
  mapToggleBtn.style.cssText = `
    display: none; width: 100%; flex-shrink: 0;
    font-size: 12px; padding: 8px 6px; border-radius: 6px; border: 1px solid #666;
    background: rgba(22,28,34,0.95); color: #9fc; font-family: Consolas, monospace;
    touch-action: manipulation;
  `;
  mapToggleBtn.addEventListener('click', () => toggleMinimap());

  const handleMinimapClick = (e, isMoveOnly = false) => {
    const rect = minimapCanvas.getBoundingClientRect();
    const lx = e.clientX - rect.left;
    const lz = e.clientY - rect.top;

    // Match drawMinimapToContext mirror (translate + scale -1): corner bases read as lower-right on widget.
    const lx2 = rect.width - lx;
    const lz2 = rect.height - lz;
    let wx = (lx2 / rect.width) * MAP_SIZE - MAP_SIZE / 2;
    let wz = (lz2 / rect.height) * MAP_SIZE - MAP_SIZE / 2;
    const disk = clampWorldToPlayableDisk(wx, wz, 0);
    wx = disk.x;
    wz = disk.z;

    if (e.button === 2 || isMoveOnly) {
      if (State.gameSession.mpSessionPaused) return;
      const unitIds = Array.from(State.selectedUnits);
      if (unitIds.length > 0) {
        Network.sendCommand({ action: 'move', unitIds, x: wx, z: wz });
      }
    } else {
      // Left-click: Jump camera
      Input.jumpCameraTo(wx, wz);
    }
  };

  minimapCanvas.addEventListener('mousedown', (e) => {
    e.stopPropagation(); // Prevent main canvas from deselecting
    if (e.button === 0) minimapCanvas._isDragging = true;
    handleMinimapClick(e);
  });

  minimapCanvas.addEventListener('contextmenu', (e) => {
    e.preventDefault(); // Disable browser right-click menu
  });

  const minimapEventPoint = ev =>
    ev.touches && ev.touches.length
      ? ev.touches[0]
      : ev.changedTouches && ev.changedTouches.length
        ? ev.changedTouches[0]
        : ev;

  minimapCanvas.addEventListener(
    'touchstart',
    e => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      const p = minimapEventPoint(e);
      minimapCanvas._isDragging = true;
      minimapCanvas._touchDragId = e.touches[0] ? e.touches[0].identifier : null;
      handleMinimapClick(p);
      Input.notifyTouchInteraction('tap');
    },
    { passive: false }
  );

  minimapCanvas.addEventListener(
    'touchmove',
    e => {
      if (!minimapCanvas._isDragging || minimapCanvas._touchDragId == null) return;
      const t = Array.from(e.touches).find(tch => tch.identifier === minimapCanvas._touchDragId);
      if (!t) return;
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      handleMinimapClick(t);
    },
    { passive: false }
  );

  minimapCanvas.addEventListener('touchend', e => {
    minimapCanvas._isDragging = false;
    minimapCanvas._touchDragId = null;
    e.stopPropagation();
  });
  minimapCanvas.addEventListener('touchcancel', () => {
    minimapCanvas._isDragging = false;
    minimapCanvas._touchDragId = null;
  });

  window.addEventListener('mousemove', (e) => {
    if (minimapCanvas._isDragging) handleMinimapClick(e);
  });
  window.addEventListener('mouseup', () => {
    minimapCanvas._isDragging = false;
  });

  mapWrap.appendChild(minimapCanvas);
  container.appendChild(mapWrap);
  container.appendChild(mapToggleBtn);
  uiMountRoot().appendChild(container);
  minimapCtx = minimapCanvas.getContext('2d');
}

// --- Main Menu ---
function createMenu() {
  menuEl = document.createElement('div');
  menuEl.id = 'game-menu';
  menuEl.style.cssText = `
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: rgba(0,10,0,0.92); padding: 30px;
    border: 1px solid #0f0; border-radius: 12px;
    z-index: 300; text-align: center; font-family: 'Consolas', monospace;
    min-width: 320px; pointer-events: auto;
  `;
  menuEl.innerHTML = `
    <h2 style="color: #0f0; margin: 0 0 20px 0; font-size: 28px; letter-spacing: 0.1em;">RTS VR II</h2>
    <button id="btn-start-1v1" style="${btnStyle('#0a0')}" onclick="window._startGame('1v1')">⚔️ 1v1 vs Bot</button>
    <button id="btn-start-2v2" style="${btnStyle('#06a')}" onclick="window._startGame('2v2')">🤝 2v2 Co-op vs Bots</button>
    <button id="btn-start-ffa" style="${btnStyle('#a60')}" onclick="window._startGame('ffa')">👑 FFA (4 Players)</button>
    <hr style="border-color: #333; margin: 15px 0;">
    <p style="color:#aaa;font-size:12px;margin:0;">Multiplayer — same lobby # as host (BattleVR-style)</p>
    <p style="color:#8ac;font-size:11px;margin:6px 0 0 0;line-height:1.45;">1–4 humans: FFA uses every connected seat; host should keep this tab focused (background mode uses a slower backup timer + keepalive). Clients auto-rejoin the lobby briefly if the link drops before Start.</p>
    <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin:8px 0 10px 0;">
      <button type="button" id="btn-lobby-minus" style="${btnStyle('#333')};padding:6px 14px;">−</button>
      <span id="menu-lobby-num" style="color:#fff;font-size:20px;font-weight:bold;min-width:1.5em;text-align:center;">1</span>
      <button type="button" id="btn-lobby-plus" style="${btnStyle('#333')};padding:6px 14px;">+</button>
    </div>
    <button id="btn-host" style="${btnStyle('#008')}" onclick="window._hostGame()">🌐 Host Multiplayer</button>
    <button id="btn-join" style="${btnStyle('#800')}" onclick="window._joinGame()">🔗 Join Multiplayer</button>
    <p id="menu-status" style="color: #888; font-size: 12px; margin-top: 15px;">Select a game mode</p>
  `;
  uiMountRoot().appendChild(menuEl);

  const minus = menuEl.querySelector('#btn-lobby-minus');
  const plus = menuEl.querySelector('#btn-lobby-plus');
  if (minus) minus.addEventListener('click', () => Network.adjustLobby(-1));
  if (plus) plus.addEventListener('click', () => Network.adjustLobby(1));

  window._startGame = startGame;
  window._hostGame = hostGame;
  window._joinGame = joinGame;
  window._lobbyDelta = d => Network.adjustLobby(d);
  Network.refreshLobbyDisplay();
}

/** BoltVR-style: enable .clickable on menu hit targets and refresh hand raycasters. */
function syncVrMenuInteractive(show) {
  const menu = document.getElementById('vr-game-menu');
  if (!menu) return;
  menu.querySelectorAll('.js-vr-menu-btn').forEach(btn => {
    if (show) {
      btn.classList.add('clickable');
      if (btn.object3D) btn.object3D.visible = true;
    } else {
      btn.classList.remove('clickable');
      if (btn.object3D) btn.object3D.visible = false;
    }
  });
  refreshHandRaycasters();
}

function refreshHandRaycasters() {
  ['#leftHandRay', '#rightHandRay', '#leftHand', '#rightHand'].forEach(sel => {
    const h = document.querySelector(sel);
    if (h?.components?.raycaster?.refreshObjects) {
      h.components.raycaster.refreshObjects();
    }
  });
}

function syncVrGameHudVisibility() {
  const hud = document.getElementById('vr-game-hud');
  const inVr = Input.getIsVR();
  const inMatch = State.gameSession.gameStarted && !State.gameSession.menuOpen;
  const showHud = inVr && inMatch;
  if (hud) hud.setAttribute('visible', showHud ? 'true' : 'false');

  const vrRoot = document.getElementById('vr-minimap-root');
  if (vrRoot) {
    vrRoot.setAttribute('visible', showHud && minimapVisible ? 'true' : 'false');
  }
  const plane = document.getElementById('vr-minimap-plane');
  if (plane) {
    const on = showHud && minimapVisible;
    plane.classList.toggle('clickable', on);
    plane.setAttribute('visible', on ? 'true' : 'false');
  }

  const buildRoot = document.getElementById('vr-build-panel-root');
  if (buildRoot) {
    const showBuildUi =
      !!(activeBuildingPanel || (activeMobileDeployUnitIds && activeMobileDeployUnitIds.length > 0));
    buildRoot.setAttribute('visible', showHud && showBuildUi ? 'true' : 'false');
  }
}

function tryInitVrMinimapTexture() {
  if (vrMinimapCtx) return;
  const plane = document.getElementById('vr-minimap-plane');
  if (!plane) return;
  const mesh = plane.getObject3D('mesh');
  if (!mesh || !mesh.material) return;

  vrMinimapCanvas = document.createElement('canvas');
  vrMinimapCanvas.width = 180;
  vrMinimapCanvas.height = 180;
  vrMinimapCtx = vrMinimapCanvas.getContext('2d');

  const map = new THREE.CanvasTexture(vrMinimapCanvas);
  if (THREE.SRGBColorSpace !== undefined) {
    map.colorSpace = THREE.SRGBColorSpace;
  }
  mesh.material.map = map;
  mesh.material.color.setRGB(1, 1, 1);
  mesh.material.needsUpdate = true;
  vrMinimapTexture = map;
}

function btnStyle(bg) {
  return `
    display: block; width: 100%; padding: 12px; margin: 6px 0;
    background: ${bg}; color: #fff; border: none; border-radius: 6px;
    font-family: 'Consolas', monospace; font-size: 15px; cursor: pointer;
    transition: filter 0.15s, transform 0.1s;
  `;
}

// --- Update functions ---
export function updateUI() {
  if (Input.getIsVR()) {
    tryInitVrMinimapTexture();
    syncVrGameHudVisibility();
  }
  updateHUD();
  if (minimapVisible) updateMinimap();
  // Auto-refresh building panel
  const showMobileDeploy = activeMobileDeployUnitIds && activeMobileDeployUnitIds.length > 0;
  if (activeBuildingPanel || showMobileDeploy) {
    const now = performance.now();
    const mpClient =
      State.gameSession.isMultiplayer && !State.gameSession.isHost && State.gameSession.gameStarted;
    const throttleMs = mpClient ? 72 : 500;
    if (now - lastBuildPanelUpdate > throttleMs) {
      lastBuildPanelUpdate = now;
      if (activeBuildingPanel) refreshBuildingPanel();
      if (showMobileDeploy) refreshMobileHqDeployPanel();
    }
  }
}

function updateHUD() {
  const player = State.players[State.gameSession.myPlayerId];
  if (!player) return;

  if (!State.gameSession.gameStarted) {
    lastHudHelpPlatform = '';
    minimapVisible = false;
    const mmc = document.getElementById('minimap-container');
    if (mmc) mmc.style.display = 'none';
    const gh = document.getElementById('game-hud');
    if (gh) {
      gh.classList.remove('rts-help-open', 'rts-touch', 'rts-vr-session');
    }
    const helpBtn = document.getElementById('hud-help-toggle');
    if (helpBtn) helpBtn.textContent = 'Help';
    updateFlatHudButtons();
  }

  const ghud = document.getElementById('game-hud');
  if (ghud && State.gameSession.gameStarted) {
    ghud.classList.toggle('rts-vr-session', Input.getIsVR());
    if (!Input.getIsVR()) {
      ghud.classList.toggle('rts-touch', Input.getInputPlatform() === 'touch');
    } else {
      ghud.classList.remove('rts-touch');
    }
  }

  const controlsHelpEl = document.getElementById('hud-controls');
  if (controlsHelpEl && State.gameSession.gameStarted) {
    const helpKey = Input.getIsVR() ? 'vr' : Input.getInputPlatform();
    if (helpKey !== lastHudHelpPlatform) {
      lastHudHelpPlatform = helpKey;
      controlsHelpEl.innerHTML = getHudControlsHelpHtml();
    }
  }

  const creditsEl = document.getElementById('hud-credits');
  const incomeEl = document.getElementById('hud-income');
  const unitsEl = document.getElementById('hud-units');
  const timeEl = document.getElementById('hud-time');

  if (creditsEl) creditsEl.textContent = `$${Math.floor(player.credits)}`;
  if (incomeEl) incomeEl.textContent = `+${player.income.toFixed(1)}/s`;
  if (unitsEl) unitsEl.textContent = `${player.unitCount}/${player.unitCap}`;

  const elapsed = Math.floor(State.gameSession.elapsedTime);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  if (timeEl) timeEl.textContent = `${min}:${sec.toString().padStart(2, '0')}`;

  const vrTop = document.getElementById('vr-hud-top');
  if (vrTop && Input.getIsVR()) {
    vrTop.setAttribute(
      'value',
      `$${Math.floor(player.credits)}  +${player.income.toFixed(1)}/s  |  ${player.unitCount}/${player.unitCap} units  |  ${min}:${sec.toString().padStart(2, '0')}`
    );
  }

  const botDebugEl = document.getElementById('hud-bot-debug');
  if (botDebugEl) {
    if (State.gameSession.debugFog && State.gameSession.gameStarted) {
      const bots = State.players.filter(p => p.isBot && p.isActive && !p.isDefeated);
      if (bots.length === 0) {
        botDebugEl.style.display = 'none';
      } else {
        botDebugEl.style.display = 'block';
        botDebugEl.innerHTML =
          '<span style="color:#888;font-size:10px;">Spy · bots</span><br>' +
          bots
            .map(
              p =>
                `<span style="color:${p.colorHex}">${p.name}</span> · $${Math.floor(p.credits)}`
            )
            .join('<br>');
      }
    } else {
      botDebugEl.style.display = 'none';
    }
  }

  const vrSpy = document.getElementById('vr-hud-spy');
  if (vrSpy && Input.getIsVR()) {
    if (State.gameSession.debugFog && State.gameSession.gameStarted) {
      const bots = State.players.filter(p => p.isBot && p.isActive && !p.isDefeated);
      if (bots.length === 0) {
        vrSpy.setAttribute('visible', false);
      } else {
        vrSpy.setAttribute('visible', true);
        vrSpy.setAttribute(
          'value',
          bots.map(p => `${p.name} $${Math.floor(p.credits)}`).join('  ·  ')
        );
      }
    } else {
      vrSpy.setAttribute('visible', false);
    }
  }

  // Selection info
  const selEl = document.getElementById('hud-selection');
  if (selEl) {
    if (State.selectedUnits.size > 0) {
      const selected = State.getSelectedUnits();
      const types = {};
      selected.forEach(u => { types[u.type] = (types[u.type] || 0) + 1; });
      const desc = Object.entries(types).map(([t, c]) =>
        `${UNIT_TYPES[t]?.name || t}×${c}`
      ).join('  ');
      const totalHPRaw = selected.reduce((s, u) => s + u.hp, 0);
      const maxHPRaw = selected.reduce((s, u) => s + u.maxHp, 0);
      const totalHP = Math.round(totalHPRaw);
      const maxHP = Math.round(maxHPRaw);

      let extra = '';

      // Show harvester state details
      const harvesters = selected.filter(u => u.type === 'harvester');
      if (harvesters.length > 0) {
        const h = harvesters[0];
        const stateLabel = getHarvesterStateLabel(h);
        extra += `  |  ${stateLabel}`;
        if (h.cargo > 0) extra += `  💰 Cargo: $${h.cargo}`;
      }

      // Show combat unit state
      const combatUnits = selected.filter(u => u.type !== 'harvester' && u.type !== 'mobileHq');
      if (combatUnits.length > 0 && harvesters.length === 0) {
        const states = {};
        combatUnits.forEach(u => { states[u.state] = (states[u.state] || 0) + 1; });
        const stateDesc = Object.entries(states).map(([s, c]) => {
          const icon = s === 'attacking' ? '⚔️' : s === 'moving' ? '🏃' : '⏸️';
          return `${icon}${c}`;
        }).join(' ');
        extra += `  |  ${stateDesc}`;
      }

      selEl.innerHTML = `${desc}  |  HP: ${totalHP}/${maxHP}${extra}`;
      selEl.style.display = Input.getIsVR() ? 'none' : 'block';

      const vrSel = document.getElementById('vr-hud-selection');
      if (vrSel && Input.getIsVR()) {
        let plainExtra = '';
        const harvestersP = selected.filter(u => u.type === 'harvester');
        if (harvestersP.length > 0) {
          const h = harvestersP[0];
          plainExtra += ` | ${getHarvesterStatePlain(h)}`;
          if (h.cargo > 0) plainExtra += ` cargo $${h.cargo}`;
        }
        const combatP = selected.filter(u => u.type !== 'harvester' && u.type !== 'mobileHq');
        if (combatP.length > 0 && harvestersP.length === 0) {
          const states = {};
          combatP.forEach(u => { states[u.state] = (states[u.state] || 0) + 1; });
          plainExtra +=
            ' | ' +
            Object.entries(states)
              .map(([s, c]) => `${s.slice(0, 4)}×${c}`)
              .join(' ');
        }
        vrSel.setAttribute('value', `${desc} | HP ${totalHP}/${maxHP}${plainExtra}`);
        vrSel.setAttribute('visible', true);
      }
    } else {
      selEl.style.display = 'none';
      const vrSel = document.getElementById('vr-hud-selection');
      if (vrSel) vrSel.setAttribute('visible', false);
    }
  }

  // Victory/defeat
  const victoryEl = document.getElementById('hud-victory');
  if (State.gameSession.gameOver) {
    const victoryStatsPlayers = State.players.filter(p => p.isActive);
    if (victoryEl && !victoryEl.dataset.rtsVictoryPopulated) {
      victoryEl.dataset.rtsVictoryPopulated = '1';
      const myTeam = player.team;
      let title = '🏆 VICTORY!';
      let titleColor = '#0f0';
      
      if (State.gameSession.winner === -1) {
        title = '⏰ DRAW (Time Limit)';
        titleColor = '#ff0';
      } else if (State.gameSession.winner !== myTeam) {
        title = '💀 DEFEAT';
        titleColor = '#f00';
      }

      // Generate Stats Table
      let statsHtml = `
        <div style="font-size: 28px; color: ${titleColor}; margin-bottom: 20px; letter-spacing: 2px;">${title}</div>
        <table style="width: 100%; border-collapse: collapse; font-family: 'Consolas', monospace; font-size: 14px; text-align: left; color: #fff;">
          <thead>
            <tr style="border-bottom: 1px solid #444;">
              <th style="padding: 10px 5px;">Category</th>
              ${victoryStatsPlayers.map(p => `<th style="padding: 10px 5px; color: ${p.colorHex}">${p.name}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${renderStatRow(victoryStatsPlayers, 'Units Produced', 'unitsProduced')}
            ${renderStatRow(victoryStatsPlayers, 'Units Lost', 'unitsLost')}
            ${renderStatRow(victoryStatsPlayers, 'Combat Kills', 'kills')}
            <tr style="height: 10px;"></tr>
            ${renderStatRow(victoryStatsPlayers, 'Buildings Built', 'buildingsBuilt')}
            ${renderStatRow(victoryStatsPlayers, 'Buildings Lost', 'buildingsLost')}
            <tr style="height: 10px;"></tr>
            ${renderStatRow(victoryStatsPlayers, 'Credits Earned', 'creditsEarned', val => `$${Math.floor(val)}`)}
          </tbody>
        </table>
        <div style="margin-top: 25px; font-size: 14px; color: #888;">Press <span style="color:#eee">Esc</span> to return to command center</div>
      `;

      victoryEl.innerHTML = statsHtml;
      victoryEl.style.width = '600px'; 
      victoryEl.style.maxWidth = '90vw';
      victoryEl.style.display = 'block';
    }

    const vrRoot = document.getElementById('vr-hud-victory-root');
    const vrTitle = document.getElementById('vr-victory-title');
    const vrLab = document.getElementById('vr-victory-labels');
    const vrCols = [
      document.getElementById('vr-victory-col0'),
      document.getElementById('vr-victory-col1'),
      document.getElementById('vr-victory-col2'),
      document.getElementById('vr-victory-col3'),
    ];
    if (vrRoot && Input.getIsVR() && vrTitle && vrLab) {
      const myTeam = player.team;
      let title = 'VICTORY';
      let titleColor = '#00ff66';
      if (State.gameSession.winner === -1) {
        title = 'DRAW (time limit)';
        titleColor = '#ffff00';
      } else if (State.gameSession.winner !== myTeam) {
        title = 'DEFEAT';
        titleColor = '#ff4444';
      }
      vrTitle.setAttribute('value', title);
      vrTitle.setAttribute('color', titleColor);
      vrLab.setAttribute(
        'value',
        [
          'Category',
          '----------',
          'Produced',
          'Lost',
          'Kills',
          'Bldg+',
          'Bldg-',
          'Credits',
        ].join('\n')
      );
      victoryStatsPlayers.forEach((p, i) => {
        const el = vrCols[i];
        if (!el) return;
        const lines = [
          p.name,
          '----------',
          String(p.stats.unitsProduced),
          String(p.stats.unitsLost),
          String(p.stats.kills),
          String(p.stats.buildingsBuilt),
          String(p.stats.buildingsLost),
          `$${Math.floor(p.stats.creditsEarned)}`,
        ];
        el.setAttribute('value', lines.join('\n'));
        el.setAttribute('color', p.colorHex);
        el.setAttribute('visible', true);
      });
      for (let i = victoryStatsPlayers.length; i < 4; i++) {
        if (vrCols[i]) vrCols[i].setAttribute('visible', false);
      }
      vrRoot.setAttribute('visible', true);
    }
  } else {
    // RUTHLESS UI CLEANUP: Hide the victory screen if a match is NOT over
    if (victoryEl) {
      delete victoryEl.dataset.rtsVictoryPopulated;
      if (victoryEl.style.display !== 'none') {
        victoryEl.style.display = 'none';
      }
    }
    const vrRoot = document.getElementById('vr-hud-victory-root');
    if (vrRoot) vrRoot.setAttribute('visible', false);
  }

  // Mobile HQ deploy panel (same bottom shell as HQ build menu)
  if (State.gameSession.gameStarted && !State.gameSession.menuOpen) {
    const myId = State.gameSession.myPlayerId;
    const selected = State.getSelectedUnits();
    const mobile = selected.filter(
      u => u.ownerId === myId && u.type === 'mobileHq' && u.hp > 0
    );
    const onlyMobile = mobile.length > 0 && mobile.length === selected.length;
    const sig = onlyMobile ? mobile.map(u => u.id).sort().join(',') : '';
    if (sig !== lastMobileDeploySelectionSig) {
      lastMobileDeploySelectionSig = sig;
      if (sig) showMobileHqDeployPanel(mobile.map(u => u.id));
      else hideMobileHqDeployPanel();
    }
  }
}

function renderStatRow(players, label, statKey, formatter = val => val) {
  return `
    <tr style="border-bottom: 1px solid #222;">
      <td style="padding: 8px 5px; color: #aaa;">${label}</td>
      ${players.map(p => `<td style="padding: 8px 5px; font-weight: bold;">${formatter(p.stats[statKey])}</td>`).join('')}
    </tr>
  `;
}

function drawMinimapToContext(ctx, w, h) {
  const scaleX = w / MAP_SIZE;
  const scaleZ = h / MAP_SIZE;
  const isSpyMode = State.gameSession.debugFog;

  ctx.save();
  ctx.translate(w, h);
  ctx.scale(-1, -1);
  ctx.beginPath();
  if (typeof ctx.ellipse === 'function') {
    ctx.ellipse(
      MAP_SIZE * 0.5 * scaleX,
      MAP_SIZE * 0.5 * scaleZ,
      MAP_UNIT_PLAYABLE_RADIUS * scaleX,
      MAP_UNIT_PLAYABLE_RADIUS * scaleZ,
      0,
      0,
      Math.PI * 2
    );
  } else {
    ctx.arc(MAP_SIZE * 0.5 * scaleX, MAP_SIZE * 0.5 * scaleZ, MAP_UNIT_PLAYABLE_RADIUS * scaleX, 0, Math.PI * 2);
  }
  ctx.clip();

  ctx.fillStyle = '#141418';
  ctx.fillRect(0, 0, w, h);

  const myTeam = State.players[State.gameSession.myPlayerId]?.team ?? 0;
  const fogGrid = Fog.getTeamGrid(myTeam);
  if (fogGrid && !isSpyMode) {
    const cellW = w / FOG_GRID_SIZE;
    const cellH = h / FOG_GRID_SIZE;
    for (let gz = 0; gz < FOG_GRID_SIZE; gz++) {
      for (let gx = 0; gx < FOG_GRID_SIZE; gx++) {
        const val = fogGrid[gz * FOG_GRID_SIZE + gx];
        if (val === 2) {
          ctx.fillStyle = '#2a2a32';
          ctx.fillRect(gx * cellW, gz * cellH, cellW + 1, cellH + 1);
        } else if (val === 1) {
          ctx.fillStyle = '#1a1a20';
          ctx.fillRect(gx * cellW, gz * cellH, cellW + 1, cellH + 1);
        }
      }
    }
  } else if (isSpyMode) {
    ctx.fillStyle = '#2a2a32';
    ctx.fillRect(0, 0, w, h);
  }

  ctx.fillStyle = '#4f8';
  State.resourceFields.forEach(field => {
    if (!field.depleted && Fog.wasExploredByTeam(myTeam, field.x, field.z)) {
      const mx = (field.x + MAP_SIZE / 2) * scaleX;
      const mz = (field.z + MAP_SIZE / 2) * scaleZ;
      ctx.fillRect(mx - 3, mz - 3, 6, 6);
    }
  });

  State.buildings.forEach(b => {
    if (b.hp <= 0) return;
    if (!Fog.wasExploredByTeam(myTeam, b.x, b.z)) return;
    const mx = (b.x + MAP_SIZE / 2) * scaleX;
    const mz = (b.z + MAP_SIZE / 2) * scaleZ;
    ctx.fillStyle = PLAYER_COLOR_HEX[b.ownerId] || '#888';
    ctx.fillRect(mx - 3, mz - 3, 6, 6);
  });

  State.units.forEach(unit => {
    if (unit.hp <= 0) return;
    if (unit.team !== myTeam && !Fog.isUnitVisibleToPlayer(unit, State.gameSession.myPlayerId)) return;
    const mx = (unit.x + MAP_SIZE / 2) * scaleX;
    const mz = (unit.z + MAP_SIZE / 2) * scaleZ;
    ctx.fillStyle = PLAYER_COLOR_HEX[unit.ownerId] || '#888';
    ctx.fillRect(mx - 1, mz - 1, 3, 3);
  });

  const cam = Input.getCameraState();
  const cx = (cam.x + MAP_SIZE / 2) * scaleX;
  const cz = (cam.z + MAP_SIZE / 2) * scaleZ;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - 12, cz - 8, 24, 16);

  ctx.strokeStyle = 'rgba(255,255,255,0.42)';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  if (typeof ctx.ellipse === 'function') {
    ctx.ellipse(
      MAP_SIZE * 0.5 * scaleX,
      MAP_SIZE * 0.5 * scaleZ,
      MAP_UNIT_PLAYABLE_RADIUS * scaleX,
      MAP_UNIT_PLAYABLE_RADIUS * scaleZ,
      0,
      0,
      Math.PI * 2
    );
  } else {
    ctx.arc(MAP_SIZE * 0.5 * scaleX, MAP_SIZE * 0.5 * scaleZ, MAP_UNIT_PLAYABLE_RADIUS * scaleX, 0, Math.PI * 2);
  }
  ctx.stroke();

  ctx.restore();
}

function updateMinimap() {
  if (!minimapVisible) return;
  if (!Input.getIsVR() && minimapCtx && minimapCanvas) {
    drawMinimapToContext(minimapCtx, minimapCanvas.width, minimapCanvas.height);
  }
  if (Input.getIsVR() && vrMinimapCtx && vrMinimapCanvas) {
    drawMinimapToContext(vrMinimapCtx, vrMinimapCanvas.width, vrMinimapCanvas.height);
    if (vrMinimapTexture) vrMinimapTexture.needsUpdate = true;
  }
}

// --- Public API ---
export function dismissAppStartGate() {
  if (!State.gameSession.awaitingAppStart) return;
  State.gameSession.awaitingAppStart = false;
  /** VR lobby uses `#vr-game-menu`; if the menu was toggled closed before Start, show would stay false and lobby buttons never got `.clickable`. */
  if (Input.getIsVR()) {
    State.gameSession.menuOpen = true;
  }
  updateMenuVisibility();
}

export function updateMenuVisibility() {
  const flatBar = document.getElementById('hud-flat-actions');
  if (flatBar) {
    flatBar.style.display =
      State.gameSession.gameStarted && !Input.getIsVR() && Input.getInputPlatform() === 'touch'
        ? 'flex'
        : 'none';
  }
  if (State.gameSession.gameStarted && !Input.getIsVR()) {
    updateFlatHudButtons();
  }

  const gate = document.getElementById('app-start-overlay');
  if (gate) {
    gate.style.display =
      State.gameSession.awaitingAppStart && !Input.getIsVR() ? 'flex' : 'none';
  }

  const ghAll = document.getElementById('game-hud');
  if (ghAll) {
    if (State.gameSession.awaitingAppStart) {
      ghAll.style.display = 'none';
      ghAll.classList.remove('rts-pre-match');
    } else {
      ghAll.style.display = '';
      /** Lobby / mode picker (after Start gate): hide match HUD; see `.rts-pre-match` in styles.css. */
      ghAll.classList.toggle('rts-pre-match', !State.gameSession.gameStarted);
    }
  }

  const vrVer = document.getElementById('vr-version-fps');
  if (vrVer) {
    vrVer.setAttribute('visible', State.gameSession.awaitingAppStart ? 'false' : 'true');
  }
  const vrStart = document.getElementById('vr-app-start');
  if (vrStart) {
    const showVrStart = !!(State.gameSession.awaitingAppStart && Input.getIsVR());
    vrStart.setAttribute('visible', showVrStart ? 'true' : 'false');
    const vrb = document.getElementById('vr-btn-app-start');
    if (vrb) {
      if (showVrStart) vrb.classList.add('clickable');
      else vrb.classList.remove('clickable');
    }
  }

  if (menuEl) {
    const showHtml =
      !State.gameSession.awaitingAppStart && State.gameSession.menuOpen && !Input.getIsVR();
    menuEl.style.display = showHtml ? 'block' : 'none';
  }
  const vrGameMenu = document.getElementById('vr-game-menu');
  let showVrGameMenu = false;
  if (vrGameMenu) {
    showVrGameMenu =
      !State.gameSession.awaitingAppStart && State.gameSession.menuOpen && Input.getIsVR();
    vrGameMenu.setAttribute('visible', showVrGameMenu ? 'true' : 'false');
    syncVrMenuInteractive(showVrGameMenu);
  }
  /** Same predicate as `#vr-game-menu` visibility — used by `rts-vr-menu-btn` (attribute alone can lag XR). */
  globalThis.__rtsVrShowGameMenu = !!showVrGameMenu;
  syncVrGameHudVisibility();
  refreshHandRaycasters();
}

export function setMinimapVisible(on) {
  minimapVisible = !!on;
  const container = document.getElementById('minimap-container');
  const mapWrap = document.getElementById('minimap-map-wrap');
  const touchGame =
    State.gameSession.gameStarted && !Input.getIsVR() && Input.getInputPlatform() === 'touch';
  if (container) {
    if (Input.getIsVR()) {
      container.style.display = 'none';
    } else if (touchGame) {
      container.style.display = 'flex';
      if (mapWrap) mapWrap.style.display = minimapVisible ? 'block' : 'none';
    } else {
      container.style.display = minimapVisible ? 'flex' : 'none';
      if (mapWrap) mapWrap.style.display = '';
    }
  }
  syncVrGameHudVisibility();
  refreshHandRaycasters();
  updateFlatHudButtons();
}

export function toggleMinimap() {
  setMinimapVisible(!minimapVisible);
}

export function showBuildMenu() {
  if (buildMenuEl) {
    buildMenuEl.style.display = buildMenuEl.style.display === 'none' ? 'block' : 'none';
  }
}

export function hideBuildMenu() {
  if (buildMenuEl) buildMenuEl.style.display = 'none';
}

function ensureHudBuildPanel() {
  if (buildPanelEl) return;
  buildPanelEl = document.createElement('div');
  buildPanelEl.id = 'hud-build-panel';
  buildPanelEl.className = 'hud';
  buildPanelEl.style.cssText = `
      position: fixed; bottom: 60px; left: 8px;
      background: rgba(0,10,0,0.9); padding: 12px;
      border: 1px solid #0a0; border-radius: 8px;
      z-index: 110; min-width: 280px;
      font-family: 'Consolas', monospace; pointer-events: auto;
    `;
  uiMountRoot().appendChild(buildPanelEl);
}

function refreshMobileHqDeployPanel() {
  if (!buildPanelEl || !activeMobileDeployUnitIds || activeMobileDeployUnitIds.length === 0) return;

  const alive = activeMobileDeployUnitIds
    .map(id => State.units.get(id))
    .filter(u => u && u.type === 'mobileHq' && u.hp > 0 && u.ownerId === State.gameSession.myPlayerId);
  if (alive.length === 0) {
    hideMobileHqDeployPanel();
    return;
  }

  const names = UNIT_TYPES.mobileHq?.name || 'Mobile HQ';
  const totalHp = alive.reduce((s, u) => s + u.hp, 0);
  const maxHp = alive.reduce((s, u) => s + u.maxHp, 0);
  const deployLabel = alive.length > 1 ? `Deploy ${alive.length} (${names})` : 'Deploy as HQ';

  let html = `<div style="color: #0f0; font-size: 14px; font-weight: bold; margin-bottom: 4px;">
    ${names}
    <span style="color: #888; font-size: 11px; float: right;">HP: ${Math.floor(totalHp)}/${maxHp}</span>
  </div>`;
  html += `<div style="color:#8ac;font-size:11px;margin:4px 0;">Opens a new build radius here (clear of structures & crystals).</div>`;
  html += `<div><button type="button" style="
      display: inline-block; padding: 8px 14px; margin: 4px 0 0 0;
      background: #1a3a1a; color: #fff; border: 1px solid #0a0; border-radius: 4px;
      cursor: pointer; font-family: Consolas, monospace; font-size: 13px;
    " onclick="window._deployMobileHq && window._deployMobileHq()">${deployLabel}</button></div>`;
  html += '<div style="color: #555; font-size: 10px; margin-top: 4px;">Space to close panel · Deselect to cancel</div>';
  buildPanelEl.innerHTML = html;
  refreshVrMobileDeployPanel();
}

function refreshVrMobileDeployPanel() {
  const root = document.getElementById('vr-build-buttons');
  const titleEl = document.getElementById('vr-build-title');
  const queueEl = document.getElementById('vr-build-queue');
  if (!root || !Input.getIsVR()) return;
  if (!activeMobileDeployUnitIds || activeMobileDeployUnitIds.length === 0) return;

  while (root.firstChild) root.removeChild(root.firstChild);
  if (queueEl) queueEl.setAttribute('visible', false);

  const alive = activeMobileDeployUnitIds
    .map(id => State.units.get(id))
    .filter(u => u && u.type === 'mobileHq' && u.hp > 0 && u.ownerId === State.gameSession.myPlayerId);
  if (alive.length === 0) return;

  if (titleEl) {
    titleEl.setAttribute(
      'value',
      `${UNIT_TYPES.mobileHq?.name || 'Mobile HQ'}  HP ${Math.floor(alive.reduce((s, u) => s + u.hp, 0))}/${alive.reduce((s, u) => s + u.maxHp, 0)}`
    );
  }

  const rowH = 0.088;
  const btnW = 0.64;
  vrAddBuildRow(root, 0, 0.08, btnW, rowH, 'Deploy as HQ', 'confirm', true, { kind: 'deployMobileHq' });
  refreshHandRaycasters();
}

function showMobileHqDeployPanel(unitIds) {
  activeBuildingPanel = null;
  activeResourceField = null;
  activeMobileDeployUnitIds = unitIds.filter(id => {
    const u = State.units.get(id);
    return u && u.type === 'mobileHq' && u.hp > 0 && u.ownerId === State.gameSession.myPlayerId;
  });
  if (activeMobileDeployUnitIds.length === 0) return;

  lastBuildPanelUpdate = 0;
  ensureHudBuildPanel();

  window._deployMobileHq = () => {
    Network.sendCommand(
      { action: 'deployMobileHq', unitIds: activeMobileDeployUnitIds.slice() },
      (ok, code) => {
        if (ok) showStatus('HQ deployed');
        else showStatus(Network.commandFailureMessage(code));
        refreshMobileHqDeployPanel();
      }
    );
  };

  refreshMobileHqDeployPanel();
  buildPanelEl.style.display = 'block';
  syncVrGameHudVisibility();
  refreshHandRaycasters();
}

/** @public Deselect / spacebar should clear the Mobile HQ deploy panel. */
export function hideMobileHqDeployPanel() {
  activeMobileDeployUnitIds = null;
  window._deployMobileHq = undefined;
  if (buildPanelEl && !activeBuildingPanel) {
    buildPanelEl.style.display = 'none';
    buildPanelEl.innerHTML = '';
  }
  const vrBtns = document.getElementById('vr-build-buttons');
  if (vrBtns && !activeBuildingPanel) {
    while (vrBtns.firstChild) vrBtns.removeChild(vrBtns.firstChild);
  }
  syncVrGameHudVisibility();
  refreshHandRaycasters();
}

export function showBuildingPanel(building) {
  activeMobileDeployUnitIds = null;
  lastMobileDeploySelectionSig = null;
  window._deployMobileHq = undefined;
  activeBuildingPanel = building;
  lastBuildPanelUpdate = 0; // Force immediate refresh

  ensureHudBuildPanel();

  refreshBuildingPanel();
  buildPanelEl.style.display = 'block';
  refreshVrBuildingPanel();

  window._queueUnit = (bId, uType) => {
    Network.sendCommand({ action: 'produce', buildingId: bId, unitType: uType }, (ok, code) => {
      if (ok) showStatus(`Training ${UNIT_TYPES[uType]?.name}`);
      else showStatus(Network.commandFailureMessage(code));
      refreshBuildingPanel();
    });
  };

  window._cancelQueueUnit = (bId, uType) => {
    Network.sendCommand({ action: 'cancelProduce', buildingId: bId, unitType: uType }, (ok, code) => {
      if (ok) showStatus(`Cancelled ${UNIT_TYPES[uType]?.name}`);
      else showStatus(Network.commandFailureMessage(code));
      refreshBuildingPanel();
    });
  };

  window._startBuildMode = (type) => {
    const hqId =
      activeBuildingPanel &&
      activeBuildingPanel.type === 'hq' &&
      State.buildings.has(activeBuildingPanel.id)
        ? activeBuildingPanel.id
        : null;
    Input.toggleBuildMode(type);
    State.gameSession.buildModeHQId =
      State.gameSession.buildMode && hqId ? hqId : null;
    hideBuildingPanel();
  };
}

function refreshBuildingPanel() {
  if (!buildPanelEl || !activeBuildingPanel) return;

  const building = activeBuildingPanel;
  if (!State.buildings.has(building.id)) {
    hideBuildingPanel();
    return;
  }

  const bStats = BUILDING_TYPES[building.type];
  const options = Buildings.getProductionOptions(building.id);
  const player = State.players[State.gameSession.myPlayerId];
  const queue = building.productionQueue;

  let html = `<div style="color: #0f0; font-size: 14px; font-weight: bold; margin-bottom: 4px;">
    ${bStats?.name || building.type}
    <span style="color: #888; font-size: 11px; float: right;">HP: ${building.hp}/${building.maxHp}</span>
  </div>`;

  // Queue display
  if (queue.length > 0) {
    const current = queue[0];
    const pct = Math.floor((1 - current.remainingTime / current.totalTime) * 100);
    html += `<div style="color: #ff0; font-size: 12px; margin: 4px 0;">
      Building: ${UNIT_TYPES[current.unitType]?.name} ${pct}%
      <span style="color: #666;">(${queue.length} in queue)</span>
    </div>`;
    html += `<div style="background: #333; height: 4px; border-radius: 2px; margin-bottom: 8px;">
      <div style="background: #0f0; height: 100%; width: ${pct}%; border-radius: 2px;"></div>
    </div>`;
  }

  // Options (only if owned by player)
  if (building.ownerId !== State.gameSession.myPlayerId) {
    buildPanelEl.innerHTML = html;
    refreshVrBuildingPanel();
    return;
  }

  html += '<div>';
  if (building.type === 'hq') {
    const buildableTypes = ['barracks', 'warFactory', 'refinery'];
    buildableTypes.forEach(type => {
      const stats = BUILDING_TYPES[type];
      const affordable = player && player.credits >= stats.cost;
      html += `
        <button style="
          display: inline-block; padding: 6px 10px; margin: 3px;
          background: ${affordable ? '#1a3a1a' : '#2a1a1a'};
          color: ${affordable ? '#fff' : '#666'};
          border: 1px solid ${affordable ? '#0a0' : '#400'};
          border-radius: 4px; cursor: ${affordable ? 'pointer' : 'not-allowed'};
          font-family: Consolas, monospace; font-size: 12px;
          transition: background 0.15s;
        " ${affordable ? `onclick="window._startBuildMode('${type}')"` : ''}
           ${affordable ? `onmouseover="this.style.background='#2a5a2a'" onmouseout="this.style.background='#1a3a1a'"` : ''}
           title="Build ${stats.name}&#10;Cost: $${stats.cost} | Build Time: ${stats.buildTime}s">
          ${stats.name}<br><span style="font-size: 10px; color: ${affordable ? '#0f0' : '#f44'};">$${stats.cost}</span>
        </button>
      `;
    });
  } else {
    options.forEach(opt => {
      const affordable = player && player.credits >= opt.cost;
      const atCap = player && player.unitCount >= player.unitCap;
      const canBuild = affordable && !atCap;
      html += `
        <button style="
          display: inline-block; padding: 6px 10px; margin: 3px;
          background: ${canBuild ? '#1a3a1a' : '#2a1a1a'};
          color: ${canBuild ? '#fff' : '#666'};
          border: 1px solid ${canBuild ? '#0a0' : '#400'};
          border-radius: 4px; cursor: ${canBuild ? 'pointer' : 'not-allowed'};
          font-family: Consolas, monospace; font-size: 12px;
          transition: background 0.15s;
        " ${canBuild ? `onclick="window._queueUnit('${building.id}', '${opt.type}')"` : ''}
           oncontextmenu="window._cancelQueueUnit('${building.id}', '${opt.type}'); return false;"
           ${canBuild ? `onmouseover="this.style.background='#2a5a2a'" onmouseout="this.style.background='#1a3a1a'"` : ''}
           title="${opt.description}&#10;DMG: ${opt.damage} | HP: ${opt.hp} | Range: ${opt.range} | Speed: ${opt.speed}&#10;[Right-Click] to cancel 1">
          ${opt.name}<br><span style="font-size: 10px; color: ${affordable ? '#0f0' : '#f44'};">$${opt.cost}</span>
        </button>
      `;
    });
  }
  html += '</div>';
  html += '<div style="color: #555; font-size: 10px; margin-top: 4px;">Click to build | Space to close</div>';

  buildPanelEl.innerHTML = html;
  refreshVrBuildingPanel();
}

function vrAddBuildRow(parent, cx, y, w, h, line1, line2, enabled, buildSchema) {
  const el = document.createElement('a-entity');
  el.setAttribute('position', `${cx} ${y} 0.012`);
  const col = enabled ? '#1a3a1a' : '#2a1a1a';
  el.setAttribute('geometry', `primitive: plane; width: ${w}; height: ${h}`);
  el.setAttribute('material', `color: ${col}; transparent: true; opacity: 0.95`);
  if (enabled) {
    el.setAttribute('class', 'clickable');
    el.setAttribute('vr-button-hover', 'hoverColor: #3a6a3a');
    const parts = Object.entries(buildSchema).map(([k, v]) => `${k}: ${v}`);
    el.setAttribute('rts-vr-build-btn', parts.join('; '));
  }
  const t1 = document.createElement('a-text');
  t1.setAttribute('class', 'no-raycast');
  t1.setAttribute('value', line1);
  t1.setAttribute('position', '0 0.02 0.015');
  t1.setAttribute('align', 'center');
  t1.setAttribute('width', '1.15');
  t1.setAttribute('color', enabled ? '#ffffff' : '#666666');
  el.appendChild(t1);
  const t2 = document.createElement('a-text');
  t2.setAttribute('class', 'no-raycast');
  t2.setAttribute('value', line2);
  t2.setAttribute('position', '0 -0.03 0.015');
  t2.setAttribute('align', 'center');
  t2.setAttribute('width', '0.95');
  t2.setAttribute('color', enabled ? '#88ff88' : '#884444');
  el.appendChild(t2);
  parent.appendChild(el);
}

function refreshVrBuildingPanel() {
  const root = document.getElementById('vr-build-buttons');
  const titleEl = document.getElementById('vr-build-title');
  const queueEl = document.getElementById('vr-build-queue');
  if (!root || !activeBuildingPanel || !Input.getIsVR()) return;
  if (!State.buildings.has(activeBuildingPanel.id)) {
    hideBuildingPanel();
    return;
  }

  while (root.firstChild) root.removeChild(root.firstChild);

  const building = activeBuildingPanel;
  const bStats = BUILDING_TYPES[building.type];
  const options = Buildings.getProductionOptions(building.id);
  const player = State.players[State.gameSession.myPlayerId];
  const queue = building.productionQueue;

  if (titleEl) {
    titleEl.setAttribute(
      'value',
      `${bStats?.name || building.type}  HP ${building.hp}/${building.maxHp}`
    );
  }

  if (queueEl) {
    if (queue.length > 0) {
      const current = queue[0];
      const pct = Math.floor((1 - current.remainingTime / current.totalTime) * 100);
      queueEl.setAttribute(
        'value',
        `Queue: ${UNIT_TYPES[current.unitType]?.name || current.unitType} ${pct}% (${queue.length})`
      );
      queueEl.setAttribute('visible', true);
    } else {
      queueEl.setAttribute('visible', false);
    }
  }

  let y = 0.08;
  const rowH = 0.088;
  const btnW = 0.64;
  const cx = 0;

  if (building.ownerId !== State.gameSession.myPlayerId) {
    refreshHandRaycasters();
    return;
  }

  if (building.type === 'hq') {
    const buildableTypes = ['barracks', 'warFactory', 'refinery'];
    buildableTypes.forEach(type => {
      const stats = BUILDING_TYPES[type];
      const affordable = player && player.credits >= stats.cost;
      vrAddBuildRow(root, cx, y, btnW, rowH, stats.name, `$${stats.cost}`, affordable, {
        kind: 'build',
        buildingType: type,
      });
      y -= rowH + 0.018;
    });
  } else {
    options.forEach(opt => {
      const affordable = player && player.credits >= opt.cost;
      const atCap = player && player.unitCount >= player.unitCap;
      const canBuild = affordable && !atCap;
      vrAddBuildRow(root, cx, y, btnW, rowH, opt.name, `$${opt.cost}`, canBuild, {
        kind: 'produce',
        buildingId: building.id,
        unitType: opt.type,
      });
      y -= rowH + 0.018;
    });
  }

  if (queue.length > 0) {
    const first = queue[0];
    vrAddBuildRow(
      root,
      cx,
      y,
      btnW,
      rowH,
      `Cancel ${UNIT_TYPES[first.unitType]?.name || first.unitType}`,
      'queue',
      true,
      {
        kind: 'cancel',
        buildingId: building.id,
        unitType: first.unitType,
      }
    );
  }

  refreshHandRaycasters();
}

export function hideBuildingPanel() {
  activeMobileDeployUnitIds = null;
  lastMobileDeploySelectionSig = null;
  window._deployMobileHq = undefined;
  if (buildPanelEl) buildPanelEl.style.display = 'none';
  activeBuildingPanel = null;
  activeResourceField = null;
  const vrBtns = document.getElementById('vr-build-buttons');
  if (vrBtns) {
    while (vrBtns.firstChild) vrBtns.removeChild(vrBtns.firstChild);
  }
  syncVrGameHudVisibility();
  refreshHandRaycasters();
}

export function showResourceFieldPanel(resource) {
  activeResourceField = resource;
}

export function showStatus(msg) {
  const el = document.getElementById('hud-status');
  if (el) {
    el.textContent = msg;
    // Auto-clear after 3 seconds
    el._timeout && clearTimeout(el._timeout);
    if (msg) {
      el._timeout = setTimeout(() => { el.textContent = ''; }, 3000);
    }
  }
  const vrSt = document.getElementById('vr-hud-status');
  if (vrSt) {
    vrSt.setAttribute('value', msg || '');
    vrSt._timeout && clearTimeout(vrSt._timeout);
    if (msg) {
      vrSt._timeout = setTimeout(() => {
        vrSt.setAttribute('value', '');
      }, 3000);
    }
  }
}

// --- Game start callbacks ---
let onStartCallback = null;
let onHostCallback = null;
let onJoinCallback = null;

export function setCallbacks(onStart, onHost, onJoin) {
  onStartCallback = onStart;
  onHostCallback = onHost;
  onJoinCallback = onJoin;
}

function startGame(mode) { if (onStartCallback) onStartCallback(mode); }
function hostGame() { if (onHostCallback) onHostCallback(); }
function joinGame() { if (onJoinCallback) onJoinCallback(); }

function getHarvesterStatePlain(unit) {
  switch (unit.state) {
    case 'harvesting': return 'Harvesting';
    case 'movingToField': return 'To field';
    case 'movingToRefinery': return 'To refinery';
    case 'depositing': return 'Unloading';
    case 'idle': return 'Idle';
    case 'moving': return 'Moving';
    default: return unit.state;
  }
}

function getHarvesterStateLabel(unit) {
  switch (unit.state) {
    case 'harvesting':      return '<span style="color:#4f8">⛏ Harvesting</span>';
    case 'movingToField':   return '<span style="color:#6cc">🔍 Moving to field</span>';
    case 'movingToRefinery':return '<span style="color:#fd0">🚛 Returning with cargo</span>';
    case 'depositing':      return '<span style="color:#f80">📦 Unloading</span>';
    case 'idle':            return '<span style="color:#888">⏸ Idle</span>';
    case 'moving':          return '<span style="color:#aaa">🏃 Moving (manual)</span>';
    default:                return `<span style="color:#888">${unit.state}</span>`;
  }
}
