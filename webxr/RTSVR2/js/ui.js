// ========================================
// RTSVR2 — UI System
// HUD, menus, build panel, production, minimap
// ========================================

import {
  UNIT_TYPES, BUILDING_TYPES, PLAYER_COLOR_HEX,
  MAP_SIZE, FOG_GRID_SIZE,
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
let lastBuildPanelUpdate = 0;
let vrMinimapCanvas = null;
let vrMinimapCtx = null;
let vrMinimapTexture = null;

let lastHudHelpPlatform = '';
let hud2dPanelHidden = false;

function uiMountRoot() {
  return document.getElementById('xr-dom-overlay') || document.body;
}

export function initUI() {
  window.__rtsVrMinimapClick = (wx, wz, moveMode) => {
    if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;
    if (moveMode) {
      const unitIds = Array.from(State.selectedUnits);
      if (unitIds.length > 0) {
        Network.sendCommand({ action: 'move', unitIds, x: wx, z: wz });
        showStatus('Moving...');
      }
    } else {
      Input.jumpCameraTo(wx, wz);
    }
  };

  createHUD();
  createMinimap();
  createMenu();
  createBuildMenu();
  updateMenuVisibility();
}

// --- HUD ---
function getHudControlsHelpHtml() {
  if (Input.getIsVR()) {
    return `VR: Laser + trigger on menu & map · X menu · Y map · B deselect · A select all · grips pan · pinch height zoom.<br>
      <span style="opacity:0.85">Flat screen (if you peek at the mirror): WASD pan · Q/E rotate · scroll zoom · left / right click.</span>`;
  }
  if (Input.getInputPlatform() === 'touch') {
    return `Tap: select & orders (same as VR trigger): move, attack, HQ, crystals.<br>
      Two fingers — drag: pan · pinch: zoom · twist: rotate camera.<br>
      Long-press ground: deselect · long-press your unit: nearby same type.<br>
      Minimap: drag finger to scrub view.<br>
      <span style="opacity:0.85">Esc: menu if you have a keyboard · otherwise use in-game controls.</span>`;
  }
  return `WASD: Pan · Q/E: Rotate · Scroll: Zoom · Left click: Select · Right click: Move/Atk<br>
    HQ click: Build · Ctrl+S: Stop · 1–0: Squads · Space: Deselect · Tab: Map · Esc: Menu<br>
    <span style="opacity:0.85">VR: Laser + trigger on menu & map · X menu · Y map · B deselect · A select all · grips pan</span>`;
}

function createHUD() {
  hudContainer = document.createElement('div');
  hudContainer.id = 'game-hud';
  hud2dPanelHidden = false;
  lastHudHelpPlatform = '';
  hudContainer.innerHTML = `
    <button type="button" id="hud-2d-toggle" aria-label="Toggle HUD"
      style="display: none; position: fixed; bottom: 50px; left: 50%; transform: translateX(-50%);
      z-index: 125; pointer-events: auto; user-select: none; touch-action: manipulation;
      font-family: 'Consolas', monospace; font-size: 12px; padding: 8px 14px; border-radius: 8px;
      border: 1px solid #555; background: rgba(20,25,30,0.92); color: #ccc;">
      Hide UI
    </button>
    <div id="hud-panel-2d-wrap">
    <div id="hud-resources" style="
      position: fixed; top: 8px; left: 8px;
      color: #0f0; font-family: 'Consolas', monospace; font-size: 14px;
      background: rgba(0,0,0,0.7); padding: 6px 12px; border-radius: 4px;
      z-index: 100; pointer-events: none; user-select: none;
    ">
      <div>
        <span id="hud-credits">$1000</span>
        <span style="color: #555; margin: 0 6px;">|</span>
        <span id="hud-income" style="color: #4f4;">+2/s</span>
        <span style="color: #555; margin: 0 6px;">|</span>
        <span id="hud-units" style="color: #aaf;">0/30</span>
        <span style="color: #555; margin: 0 6px;">|</span>
        <span id="hud-time" style="color: #ff8;">0:00</span>
      </div>
      <div id="hud-bot-debug" style="
        display: none; margin-top: 5px; padding-top: 5px; border-top: 1px solid #333;
        font-size: 12px; color: #eb8; line-height: 1.45;
      "></div>
      <div id="hud-version-fps" style="
        margin-top: 4px; font-size: 11px; color: #8ab0aa; letter-spacing: 0.02em;
      ">RTSVR2 …</div>
    </div>
    <div id="hud-selection" style="
      position: fixed; bottom: 8px; left: 8px;
      color: #fff; font-family: 'Consolas', monospace; font-size: 13px;
      background: rgba(0,0,0,0.7); padding: 6px 12px; border-radius: 4px;
      z-index: 100; pointer-events: none; user-select: none;
      display: none; max-width: min(400px, 92vw);
    "></div>
    <div id="hud-controls" style="
      position: fixed; top: 8px; right: 8px; max-width: min(420px, 94vw);
      color: #aaa; font-family: 'Consolas', monospace; font-size: 11px;
      background: rgba(0,0,0,0.5); padding: 6px 10px; border-radius: 4px;
      z-index: 100; pointer-events: none; user-select: none; line-height: 1.6;
    ">${getHudControlsHelpHtml()}</div>
    </div>
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

  const tog = document.getElementById('hud-2d-toggle');
  if (tog) {
    tog.addEventListener('click', () => {
      hud2dPanelHidden = !hud2dPanelHidden;
      const wrap = document.getElementById('hud-panel-2d-wrap');
      if (wrap) wrap.style.display = hud2dPanelHidden ? 'none' : 'block';
      tog.textContent = hud2dPanelHidden ? 'Show UI' : 'Hide UI';
    });
  }
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
    width: 180px; height: 180px;
    background: rgba(0,0,0,0.8); border: 1px solid #444; border-radius: 4px;
    z-index: 100; display: none; pointer-events: auto;
  `;

  minimapCanvas = document.createElement('canvas');
  minimapCanvas.id = 'minimap';
  minimapCanvas.width = 180;
  minimapCanvas.height = 180;
  minimapCanvas.style.cssText = 'width: 100%; height: 100%; border-radius: 4px; cursor: crosshair;';

  const handleMinimapClick = (e, isMoveOnly = false) => {
    const rect = minimapCanvas.getBoundingClientRect();
    const lx = e.clientX - rect.left;
    const lz = e.clientY - rect.top;
    
    // Map pixels (0-180) to world coords (-MAP_HALF to MAP_HALF)
    const wx = (lx / rect.width) * MAP_SIZE - MAP_SIZE / 2;
    const wz = (lz / rect.height) * MAP_SIZE - MAP_SIZE / 2;
    
    if (e.button === 2 || isMoveOnly) {
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

  container.appendChild(minimapCanvas);
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
  const menu = document.getElementById('game-menu');
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
    buildRoot.setAttribute(
      'visible',
      showHud && activeBuildingPanel ? 'true' : 'false'
    );
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
  if (activeBuildingPanel) {
    const now = performance.now();
    if (now - lastBuildPanelUpdate > 500) {
      lastBuildPanelUpdate = now;
      refreshBuildingPanel();
    }
  }
}

function updateHUD() {
  const player = State.players[State.gameSession.myPlayerId];
  if (!player) return;

  if (!State.gameSession.gameStarted) {
    lastHudHelpPlatform = '';
    if (hud2dPanelHidden) {
      hud2dPanelHidden = false;
      const wrap = document.getElementById('hud-panel-2d-wrap');
      const tog = document.getElementById('hud-2d-toggle');
      if (wrap) wrap.style.display = 'block';
      if (tog) tog.textContent = 'Hide UI';
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
      const totalHP = selected.reduce((s, u) => s + u.hp, 0);
      const maxHP = selected.reduce((s, u) => s + u.maxHp, 0);

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
      const combatUnits = selected.filter(u => u.type !== 'harvester');
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
      selEl.style.display = 'block';

      const vrSel = document.getElementById('vr-hud-selection');
      if (vrSel && Input.getIsVR()) {
        let plainExtra = '';
        const harvestersP = selected.filter(u => u.type === 'harvester');
        if (harvestersP.length > 0) {
          const h = harvestersP[0];
          plainExtra += ` | ${getHarvesterStatePlain(h)}`;
          if (h.cargo > 0) plainExtra += ` cargo $${h.cargo}`;
        }
        const combatP = selected.filter(u => u.type !== 'harvester');
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
              ${State.players.map(p => `<th style="padding: 10px 5px; color: ${p.colorHex}">${p.name}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${renderStatRow('Units Produced', 'unitsProduced')}
            ${renderStatRow('Units Lost', 'unitsLost')}
            ${renderStatRow('Combat Kills', 'kills')}
            <tr style="height: 10px;"></tr>
            ${renderStatRow('Buildings Built', 'buildingsBuilt')}
            ${renderStatRow('Buildings Lost', 'buildingsLost')}
            <tr style="height: 10px;"></tr>
            ${renderStatRow('Credits Earned', 'creditsEarned', val => `$${Math.floor(val)}`)}
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
      State.players.forEach((p, i) => {
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
      for (let i = State.players.length; i < 4; i++) {
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
}

function renderStatRow(label, statKey, formatter = val => val) {
  return `
    <tr style="border-bottom: 1px solid #222;">
      <td style="padding: 8px 5px; color: #aaa;">${label}</td>
      ${State.players.map(p => `<td style="padding: 8px 5px; font-weight: bold;">${formatter(p.stats[statKey])}</td>`).join('')}
    </tr>
  `;
}

function drawMinimapToContext(ctx, w, h) {
  const scale = w / MAP_SIZE;
  const isSpyMode = State.gameSession.debugFog;

  ctx.fillStyle = '#111';
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
          ctx.fillStyle = '#1a1a2a';
          ctx.fillRect(gx * cellW, gz * cellH, cellW + 1, cellH + 1);
        } else if (val === 1) {
          ctx.fillStyle = '#0d0d15';
          ctx.fillRect(gx * cellW, gz * cellH, cellW + 1, cellH + 1);
        }
      }
    }
  } else if (isSpyMode) {
    ctx.fillStyle = '#1a1a2a';
    ctx.fillRect(0, 0, w, h);
  }

  ctx.fillStyle = '#4f8';
  State.resourceFields.forEach(field => {
    if (!field.depleted && Fog.wasExploredByTeam(myTeam, field.x, field.z)) {
      const mx = (field.x + MAP_SIZE / 2) * scale;
      const mz = (field.z + MAP_SIZE / 2) * scale;
      ctx.fillRect(mx - 3, mz - 3, 6, 6);
    }
  });

  State.buildings.forEach(b => {
    if (b.hp <= 0) return;
    if (!Fog.wasExploredByTeam(myTeam, b.x, b.z)) return;
    const mx = (b.x + MAP_SIZE / 2) * scale;
    const mz = (b.z + MAP_SIZE / 2) * scale;
    ctx.fillStyle = PLAYER_COLOR_HEX[b.ownerId] || '#888';
    ctx.fillRect(mx - 3, mz - 3, 6, 6);
  });

  State.units.forEach(unit => {
    if (unit.hp <= 0) return;
    if (unit.team !== myTeam && !Fog.isUnitVisibleToPlayer(unit, State.gameSession.myPlayerId)) return;
    const mx = (unit.x + MAP_SIZE / 2) * scale;
    const mz = (unit.z + MAP_SIZE / 2) * scale;
    ctx.fillStyle = PLAYER_COLOR_HEX[unit.ownerId] || '#888';
    ctx.fillRect(mx - 1, mz - 1, 3, 3);
  });

  const cam = Input.getCameraState();
  const cx = (cam.x + MAP_SIZE / 2) * scale;
  const cz = (cam.z + MAP_SIZE / 2) * scale;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - 12, cz - 8, 24, 16);
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
export function updateMenuVisibility() {
  const hud2dTog = document.getElementById('hud-2d-toggle');
  if (hud2dTog) {
    hud2dTog.style.display =
      State.gameSession.gameStarted && !Input.getIsVR() ? 'block' : 'none';
  }

  if (menuEl) {
    const showHtml = State.gameSession.menuOpen && !Input.getIsVR();
    menuEl.style.display = showHtml ? 'block' : 'none';
  }
  const gameMenu = document.getElementById('game-menu');
  if (gameMenu) {
    const showVr = State.gameSession.menuOpen && Input.getIsVR();
    gameMenu.setAttribute('visible', showVr ? 'true' : 'false');
    syncVrMenuInteractive(showVr);
  }
  syncVrGameHudVisibility();
  refreshHandRaycasters();
}

export function toggleMinimap() {
  minimapVisible = !minimapVisible;
  const container = document.getElementById('minimap-container');
  if (container) {
    container.style.display = minimapVisible && !Input.getIsVR() ? 'block' : 'none';
  }
  syncVrGameHudVisibility();
  refreshHandRaycasters();
}

export function showBuildMenu() {
  if (buildMenuEl) {
    buildMenuEl.style.display = buildMenuEl.style.display === 'none' ? 'block' : 'none';
  }
}

export function hideBuildMenu() {
  if (buildMenuEl) buildMenuEl.style.display = 'none';
}

export function showBuildingPanel(building) {
  activeBuildingPanel = building;
  lastBuildPanelUpdate = 0; // Force immediate refresh

  if (!buildPanelEl) {
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
    Input.toggleBuildMode(type);
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
