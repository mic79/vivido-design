/**
 * CapVR CTF — grab enemy flag, score through YOUR goal, reset flag, update scoreboard.
 * Uses window.CapVRGame bridge (block-scoped gameMode/processGoalScored are invisible otherwise).
 */
(function () {
  'use strict';

  // DIAGNOSTIC: bot shooting is DISABLED BY DEFAULT (no hits → no shatter) so we can
  // confirm whether the 72→36 dip is the fragment churn. Re-enable with __capvrBotsFire(true).
  if (window.__capvrBotFireOff === undefined) window.__capvrBotFireOff = true;
  window.__capvrBotsFire = function (on) {
    window.__capvrBotFireOff = (on === false);
    console.log('[CapVR] bot firing ' + (window.__capvrBotFireOff ? 'DISABLED (no shatter)' : 'ENABLED'));
    return !window.__capvrBotFireOff;
  };

  // Pedestals offset inset from goal colliders so home flags aren't bouncing in the goal body.
  const HOME = {
    red: { x: 0, y: 2.6, z: -36.5 },
    blue: { x: 0, y: 2.6, z: 36.5 }
  };
  /** Score when carrier evidence (hand/flag follow pos) is within this radius of goal center. */
  const GOAL_SCORE_RADIUS = 3.0;
  const DROP_MS = 20000;
  const FLAG_GRAB_DIST = 1.25;
  let lastScoreAt = 0;
  const _prevFlagPos = { red: null, blue: null };
  /** Rising-edge occupancy: true while evidence is inside the goal volume. */
  const _inOwnGoal = { red: false, blue: false };
  /** After a failed enter (e.g. stale pos), keep retrying until leave or score. */
  const _scoreRetry = { red: false, blue: false };

  const state = {
    red: { home: true, carrierId: null, carrierHand: null, el: null, dropTimer: null, dropUntil: 0, botPickupBlockedUntil: 0 },
    blue: { home: true, carrierId: null, carrierHand: null, el: null, dropTimer: null, dropUntil: 0, botPickupBlockedUntil: 0 }
  };

  function G() { return window.CapVRGame || {}; }
  function gameMode() { return G().gameMode || 'capture'; }
  function localOwnerId() { return G().myPlayerId || 'player_0'; }
  function teams() { return G().playerTeams; }

  /** Normalize player_0 / player0 / local id compares. */
  function sameOwner(a, b) {
    if (a == null || b == null) return false;
    if (a === b) return true;
    const norm = (x) => String(x).replace(/^player_?/, 'player_');
    if (norm(a) === norm(b)) return true;
    const local = localOwnerId();
    return norm(a) === norm(local) && norm(b) === norm(local);
  }

  function localCombatAlive() {
    const c = document.querySelector('[capvr-combat]')?.components?.['capvr-combat'];
    if (c && c.alive === false) return false;
    return true;
  }

  /** Clear zerog-player hand grab so death cannot leave flag glued to the palm. */
  function forceReleaseLocalFlagGrab(flagEl) {
    const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
    if (!zp) return;
    ['left', 'right'].forEach((handKey) => {
      const surface = zp.grabbedSurface?.[handKey] || zp.grabInfo?.[handKey]?.surface;
      if (flagEl && surface && surface !== flagEl) return;
      if (!flagEl && !(surface?.dataset?.flagTeam || surface?.components?.['zerog-ball']?.isCtfFlag)) {
        return;
      }
      const hand = handKey === 'left' ? zp.leftHand : zp.rightHand;
      try {
        if (hand && typeof zp.releaseFromSurface === 'function') {
          zp.releaseFromSurface(hand);
        }
      } catch (e) { /* */ }
      if (zp.grabbedSurface) zp.grabbedSurface[handKey] = null;
      if (zp.grabInfo) zp.grabInfo[handKey] = null;
      if (zp.isGrabbing) zp.isGrabbing[handKey] = false;
      try { zp.endGrabSnap?.(handKey); } catch (e2) { /* */ }
    });
    if (flagEl) {
      const bc = flagEl.components?.['zerog-ball'];
      if (bc) {
        bc.isGrabbed = false;
        bc.grabbingHand = null;
        bc.currentOwner = null;
        try {
          bc.body?.velocity?.set?.(0, 0, 0);
          bc.body?.angularVelocity?.set?.(0, 0, 0);
        } catch (e3) { /* */ }
      }
    }
  }

  function hudMsg(text, ms) {
    const hud = document.querySelector('#hud-message');
    if (!hud) return;
    hud.setAttribute('visible', true);
    hud.setAttribute('text', 'value', text);
    hud.setAttribute('text', 'color', '#ffffff');
    clearTimeout(hudMsg._t);
    hudMsg._t = setTimeout(() => {
      try { hud.setAttribute('visible', false); } catch (e) { /* */ }
    }, ms || 2500);
  }

  function dropSecondsLeft(team) {
    const s = state[team];
    if (!s?.dropUntil) return 0;
    return Math.max(0, Math.ceil((s.dropUntil - performance.now()) / 1000));
  }

  const FLAG_HUD_COLOR = { red: '#ff3355', blue: '#3388ff' };

  /** Camera HUD: only live reset countdowns, in that flag's color. */
  function ensureCamCtfHud() {
    let root = document.getElementById('ctf-cam-hud');
    if (root) return root;
    const cam = document.getElementById('camera')
      || document.querySelector('[camera]')
      || document.querySelector('a-camera');
    if (!cam) return null;
    root = document.createElement('a-entity');
    root.id = 'ctf-cam-hud';
    root.setAttribute('position', '0 0.06 -0.55');
    ['red', 'blue'].forEach((team, i) => {
      const t = document.createElement('a-entity');
      t.id = `ctf-cam-hud-${team}`;
      // Side-by-side if both are counting
      t.setAttribute('position', `${i === 0 ? -0.08 : 0.08} 0 0`);
      t.setAttribute('text', {
        value: '',
        align: 'center',
        width: 0.9,
        color: FLAG_HUD_COLOR[team],
        wrapCount: 8
      });
      t.setAttribute('visible', false);
      root.appendChild(t);
    });
    cam.appendChild(root);
    return root;
  }

  function destroyArenaCtfBoard() {
    const board = document.getElementById('ctf-vr-hud');
    if (board?.parentNode) board.parentNode.removeChild(board);
  }

  /** Update camera countdown labels — hidden when no drop timers. */
  function updateDropCountdownHud() {
    ensureCamCtfHud();
    destroyArenaCtfBoard();
    const redLeft = dropSecondsLeft('red');
    const blueLeft = dropSecondsLeft('blue');
    const both = redLeft > 0 && blueLeft > 0;
    [['red', redLeft], ['blue', blueLeft]].forEach(([team, left]) => {
      const el = document.getElementById(`ctf-cam-hud-${team}`);
      if (!el) return;
      if (left > 0) {
        el.setAttribute('visible', true);
        el.setAttribute('text', 'value', `${left}`);
        el.setAttribute('text', 'color', FLAG_HUD_COLOR[team]);
        // Center if alone; flank if both counting
        const x = both ? (team === 'red' ? -0.08 : 0.08) : 0;
        el.setAttribute('position', `${x} 0 0`);
      } else {
        el.setAttribute('visible', false);
        el.setAttribute('text', 'value', '');
      }
    });
    const root = document.getElementById('ctf-cam-hud');
    if (root) root.setAttribute('visible', redLeft > 0 || blueLeft > 0);
  }

  window.CapVRFlags = {
    state,
    HOME,
    DROP_MS,
    isHome(team) { return !!state[team]?.home; },
    getCarrier(team) { return state[team]?.carrierId || null; },
    getFlagEl(team) { return state[team]?.el || document.getElementById(`flag-${team}`); },
    enemyTeam(team) { return team === 'red' ? 'blue' : 'red'; },

    /** BoltVR capture-ball style: fresnel rim drawn through walls (depthTest:false). */
    _ensureFlagXray(el, team) {
      if (!el) return;
      if (el.querySelector('[xray-contour], .ctf-flag-xray')) return;
      const color = team === 'red' ? '#ff3355' : '#3388ff';
      const xray = document.createElement('a-entity');
      xray.classList.add('ctf-flag-xray');
      // Slightly larger than flag radius 0.22 — same margin as capture-ball (0.21 vs 0.2)
      xray.setAttribute('xray-contour', `radius: 0.24; color: ${color}; power: 6.0; opacity: 0.95`);
      el.appendChild(xray);
    },

    ensureEntities() {
      const scene = document.querySelector('a-scene');
      if (!scene) return;
      ['red', 'blue'].forEach((team) => {
        let el = document.getElementById(`flag-${team}`);
        if (!el) {
          const color = team === 'red' ? '#ff3355' : '#3388ff';
          el = document.createElement('a-sphere');
          el.id = `flag-${team}`;
          el.setAttribute('radius', 0.22);
          el.setAttribute('color', color);
          el.setAttribute('glow', `color: ${color}; intensity: 2.2`);
          el.setAttribute('zerog-ball', `player: flag-${team}; maxVelocity: 9`);
          el.dataset.flagTeam = team;
          el.classList.add('ctf-flag-ball');

          const pole = document.createElement('a-cylinder');
          pole.setAttribute('radius', 0.045);
          pole.setAttribute('height', 1.55);
          pole.setAttribute('position', '0 -0.95 0');
          pole.setAttribute('color', '#ddd');
          el.appendChild(pole);

          const cloth = document.createElement('a-box');
          cloth.setAttribute('width', 0.6);
          cloth.setAttribute('height', 0.38);
          cloth.setAttribute('depth', 0.04);
          cloth.setAttribute('position', '0.32 0.2 0');
          cloth.setAttribute('material', { color, emissive: color, emissiveIntensity: 0.55 });
          el.appendChild(cloth);
          scene.appendChild(el);
        }
        state[team].el = el;
        el.dataset.flagTeam = team;
        el.setAttribute('visible', true);
        this._ensureFlagXray(el, team);
        // Only snap home on first create — never wipe a live carry on re-boot
        if (!el.dataset.capvrFlagReady) {
          el.dataset.capvrFlagReady = '1';
          this.resetHome(team, true);
        }
      });
      const capture = document.getElementById('capture-ball');
      if (capture) capture.setAttribute('visible', false);
    },

    _clearDropTimer(team) {
      const s = state[team];
      if (!s) return;
      if (s.dropTimer) clearTimeout(s.dropTimer);
      s.dropTimer = null;
      s.dropUntil = 0;
    },

    _startDropTimer(team) {
      const s = state[team];
      if (!s) return;
      this._clearDropTimer(team);
      s.dropUntil = performance.now() + DROP_MS;
      s.dropTimer = setTimeout(() => {
        s.dropTimer = null;
        s.dropUntil = 0;
        if (!s.carrierId && !s.home) {
          this.resetHome(team);
          hudMsg(`${team.toUpperCase()} flag returned to base`, 2200);
        }
      }, DROP_MS);
      this._hud();
    },

    _placeFlag(el, x, y, z) {
      if (!el) return;
      el.object3D.position.set(x, y, z);
      el.setAttribute('position', `${x} ${y} ${z}`);
      const team = el.dataset?.flagTeam;
      const carried = !!(team && state[team]?.carrierId);
      if (el.body) {
        el.body.position.set(x, y, z);
        el.body.velocity.set(0, 0, 0);
        el.body.angularVelocity.set(0, 0, 0);
        // Free flags: no goal bounce (mask 8). Walls-only keeps them from tunneling off-map.
        try {
          // Cannon shim: 0=static, 1=dynamic, 2=kinematic (constants may be absent).
          const Body = window.CANNON?.Body;
          const DYNAMIC = Body?.DYNAMIC != null ? Body.DYNAMIC : 1;
          const KINEMATIC = Body?.KINEMATIC != null ? Body.KINEMATIC : 2;
          if (carried) {
            el.body.collisionFilterMask = 4 | 8;
            el.body.type = DYNAMIC;
            if (el.body.mass === 0) {
              el.body.mass = 2;
              el.body.updateMassProperties?.();
            }
          } else {
            el.body.collisionFilterMask = 4; // walls only — no goal yeet
            el.body.type = KINEMATIC;
          }
        } catch (e) { /* */ }
        try {
          if (!carried && typeof el.body.sleep === 'function') el.body.sleep();
          else el.body.wakeUp?.();
        } catch (e) {
          el.body.wakeUp?.();
        }
      }
      const bc = el.components?.['zerog-ball'];
      if (bc) {
        bc.isGrabbed = carried;
        if (bc.velocity) bc.velocity.set?.(0, 0, 0);
        if (bc.body) {
          try {
            bc.body.velocity?.set?.(0, 0, 0);
            bc.body.angularVelocity?.set?.(0, 0, 0);
            if (!carried) bc.body.collisionFilterMask = 4;
          } catch (e) { /* */ }
        }
      }
    },

    /** Keep uncarried flags frozen in place every frame (home or drop). */
    pinFreeFlags() {
      ['red', 'blue'].forEach((team) => {
        const s = state[team];
        if (!s?.el || s.carrierId) return;
        const el = s.el;
        const p = el.object3D?.position || el.body?.position;
        if (!p) return;
        if (!s._pinPos) {
          s._pinPos = { x: p.x, y: p.y, z: p.z };
        }
        // Always snap — never let physics / throw leftovers carry a free flag.
        this._placeFlag(el, s._pinPos.x, s._pinPos.y, s._pinPos.z);
      });
    },

    resetHome(team, silent) {
      const s = state[team];
      const home = HOME[team];
      const el = s?.el || document.getElementById(`flag-${team}`);
      if (!el || !home) return;
      this._clearDropTimer(team);
      s.home = true;
      s.carrierId = null;
      s.carrierHand = null;
      // After any return/reset, give humans a window to grab before bots snatch it
      s.botPickupBlockedUntil = performance.now() + 4000;
      s.el = el;
      s._pinPos = { x: home.x, y: home.y, z: home.z };
      this._placeFlag(el, home.x, home.y, home.z);
      const bc = el.components?.['zerog-ball'];
      if (bc) {
        bc.currentOwner = null;
        bc.isGrabbed = false;
        bc.grabbingHand = null;
        bc.lastOwnerChangeTime = Date.now();
        try {
          if (bc.body) {
            bc.body.velocity?.set?.(0, 0, 0);
            bc.body.angularVelocity?.set?.(0, 0, 0);
          }
        } catch (e) { /* */ }
      }
      delete el.dataset.carrierId;
      const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
      if (zp?.grabbedSurface) {
        ['left', 'right'].forEach((k) => {
          if (zp.grabbedSurface[k] === el) {
            zp.grabbedSurface[k] = null;
            if (zp.isGrabbing) zp.isGrabbing[k] = false;
            if (zp.grabInfo) zp.grabInfo[k] = null;
          }
        });
      }
      // Clear bot "holding ball" so they don't keep a phantom grab on a home flag
      document.querySelectorAll('[zerog-bot]').forEach((bot) => {
        const c = bot.components?.['zerog-bot'];
        if (c) c.isGrabbingBall = false;
      });
      if (!silent) document.dispatchEvent(new CustomEvent('ctf-flag-home', { detail: { team } }));
      this._hud();
    },

    /** Full CTF reset for match restart / new match */
    resetMatchFlags() {
      this.ensureEntities();
      ['red', 'blue'].forEach((team) => this.resetHome(team, true));
      lastScoreAt = 0;
      _inOwnGoal.red = false;
      _inOwnGoal.blue = false;
      _scoreRetry.red = false;
      _scoreRetry.blue = false;
      hudMsg('Flags reset', 1500);
      this._hud();
    },

    setCarrier(team, carrierId) {
      const s = state[team];
      if (!s) return;
      this._clearDropTimer(team);
      ['red', 'blue'].forEach((t) => {
        if (t !== team && state[t].carrierId === carrierId) this.clearCarrier(t, true);
      });
      s.carrierId = carrierId;
      s.home = false;
      s.botPickupBlockedUntil = 0;
      // carrierHand set by grab path ('left'|'right'); clear on set from bots
      if (!s.carrierHand || String(carrierId).startsWith('bot-')) s.carrierHand = null;
      const el = s.el;
      if (el) {
        el.dataset.carrierId = carrierId || '';
        const bc = el.components?.['zerog-ball'];
        if (bc) {
          bc.currentOwner = carrierId;
          bc.isGrabbed = true;
        }
      }
      document.dispatchEvent(new CustomEvent('ctf-flag-taken', { detail: { team, carrierId } }));
      this._hud();
    },

    clearCarrier(team, drop) {
      const s = state[team];
      if (!s) return;
      const was = s.carrierId;
      s.carrierId = null;
      s.carrierHand = null;
      const el = s.el;
      if (el) {
        delete el.dataset.carrierId;
        const bc = el.components?.['zerog-ball'];
        if (bc) {
          bc.currentOwner = null;
          bc.isGrabbed = false;
          bc.grabbingHand = null;
          bc.lastOwnerChangeTime = Date.now();
          // Dropped flags must be immediately re-grabbable (no steal-lock leftovers)
          try {
            if (bc.body) {
              bc.body.velocity?.set?.(0, 0, 0);
              bc.body.angularVelocity?.set?.(0, 0, 0);
            }
          } catch (e) { /* */ }
        }
        if (drop && typeof drop === 'object' && drop.x != null) {
          s._pinPos = { x: drop.x, y: drop.y, z: drop.z };
          this._placeFlag(el, drop.x, drop.y, drop.z);
        } else if (drop && el.object3D) {
          const p = new THREE.Vector3();
          el.object3D.getWorldPosition(p);
          s._pinPos = { x: p.x, y: p.y, z: p.z };
          this._placeFlag(el, p.x, p.y, p.z);
        }
      }
      s.home = false;
      // Brief bot pickup grace so the dropper can re-grab their own drop
      s.botPickupBlockedUntil = performance.now() + 2500;
      if (was) s.lastDropperId = was;
      this._startDropTimer(team);
      // Countdown is the VR HUD; skip noisy drop toast
      document.dispatchEvent(new CustomEvent('ctf-flag-dropped', {
        detail: { team, previousCarrier: was, drop }
      }));
      this._hud();
    },

    resolveTeamForOwner(ownerId) {
      if (!ownerId) return null;
      const id = String(ownerId);
      const pt = teams();
      if (pt?.get) {
        const t = pt.get(id) || pt.get(id.replace(/^player_/, 'player')) || pt.get(id.replace(/^player/, 'player_'));
        if (t) return t;
      }
      if (id === 'bot-red' || (id.includes('red') && !id.includes('blue') && !id.includes('green'))) return 'red';
      if (id === 'bot-blue' || id === 'bot-green' || id.includes('blue') || id.includes('green')) return 'blue';
      if (id === localOwnerId() || /^player_?\d+$/i.test(id)) {
        return pt?.get?.(id) || pt?.get?.('player_0') || 'red';
      }
      return null;
    },

    /** Distance from local human to a flag (Infinity if unknown). */
    _humanFlagDist(el) {
      if (!el?.object3D) return Infinity;
      const player = document.getElementById('player');
      if (!player?.object3D) return Infinity;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      player.object3D.getWorldPosition(a);
      el.object3D.getWorldPosition(b);
      return a.distanceTo(b);
    },

    /** Local human near a flag (blocks bot snipes from pedestal / drop). */
    _humanNearFlag(el, radius) {
      return this._humanFlagDist(el) < (radius || 5);
    },

    /**
     * Contested pickup: bots may take the flag unless a human is clearly closer.
     * Old 5.5m hard block meant blue bots never grabbed while you defended home.
     */
    _botBlockedByHumanContest(el, botOwner) {
      const humanDist = this._humanFlagDist(el);
      if (humanDist > 3.2) return false; // human not contesting
      const botEl = this._elForOwner(botOwner);
      if (!botEl?.object3D && !botEl?.body) return humanDist < 2.4;
      const bp = new THREE.Vector3();
      if (botEl.body?.position) {
        bp.set(botEl.body.position.x, botEl.body.position.y, botEl.body.position.z);
      } else {
        botEl.object3D.getWorldPosition(bp);
      }
      const fp = new THREE.Vector3();
      el.object3D.getWorldPosition(fp);
      const botDist = bp.distanceTo(fp);
      // Human wins the contest only if clearly closer
      return humanDist + 0.35 < botDist;
    },

    tryPickup(flagTeam, carrierId) {
      const s = state[flagTeam];
      if (!s || !carrierId) return false;
      if (s.carrierId && s.carrierId !== carrierId) {
        hudMsg('Flag is carried — kill carrier to free it', 1600);
        return false;
      }
      const carrierTeam = this.resolveTeamForOwner(carrierId);
      if (!carrierTeam) return false;

      // CapVR: NEVER return own flag by touch. Dropped flags only auto-home via timer.
      // Owning team cannot grab their own flag at all.
      if (carrierTeam === flagTeam) {
        if (sameOwner(carrierId, localOwnerId())
            && (!this._lastOwnFlagToast || performance.now() - this._lastOwnFlagToast > 2500)) {
          this._lastOwnFlagToast = performance.now();
          const left = dropSecondsLeft(flagTeam);
          hudMsg(
            left > 0
              ? `YOUR FLAG — cannot pick up (auto-homes in ${left}s)`
              : 'YOUR FLAG — only enemy team can grab it',
            2200
          );
        }
        return false;
      }

      const isBot = String(carrierId).startsWith('bot-');
      if (isBot) {
        if (s.botPickupBlockedUntil && performance.now() < s.botPickupBlockedUntil) return false;
        if (s.el && this._botBlockedByHumanContest(s.el, carrierId)) {
          // Human is contesting — don't spam HUD every frame
          if (!this._lastContestHud || performance.now() - this._lastContestHud > 1800) {
            this._lastContestHud = performance.now();
            hudMsg('Contested flag — grab it before the bot does!', 1600);
          }
          return false;
        }
      }

      if (s.carrierId === carrierId) return true;
      this.setCarrier(flagTeam, carrierId);
      const myTeam = this.resolveTeamForOwner(carrierId);
      const ownHome = myTeam ? !!state[myTeam]?.home : true;
      if (ownHome) {
        hudMsg(`GOT ${flagTeam.toUpperCase()} FLAG — score at YOUR goal`, 2800);
      } else {
        const left = dropSecondsLeft(myTeam);
        hudMsg(
          left > 0
            ? `GOT ${flagTeam.toUpperCase()} FLAG — wait: your flag returns in ${left}s`
            : `GOT ${flagTeam.toUpperCase()} FLAG — cannot score until YOUR flag is HOME`,
          3200
        );
      }
      return true;
    },

    canGrab(flagTeam, carrierId) {
      const s = state[flagTeam];
      if (!s || !carrierId) return false;
      if (s.carrierId && s.carrierId !== carrierId) return false;
      const carrierTeam = this.resolveTeamForOwner(carrierId);
      if (!carrierTeam) return false;
      // Never grab your own flag (no touch-return)
      if (carrierTeam === flagTeam) return false;
      const isBot = String(carrierId).startsWith('bot-');
      if (isBot) {
        if (s.botPickupBlockedUntil && performance.now() < s.botPickupBlockedUntil) return false;
        if (s.el && this._botBlockedByHumanContest(s.el, carrierId)) return false;
      }
      return !s.carrierId || s.carrierId === carrierId;
    },

    /**
     * @param {string} carrierId
     * @param {string} atTeamBase scoring team's goal
     * @param {{x:number,y:number,z:number}|null} evidencePos hand/flag position already verified in volume
     */
    tryScore(carrierId, atTeamBase, evidencePos) {
      if (!carrierId || !atTeamBase) return false;
      if (performance.now() - lastScoreAt < 1200) return false;
      // Ghost scores: dead carrier / fresh respawn next to goal must never count
      if (sameOwner(carrierId, localOwnerId()) && !localCombatAlive()) {
        console.log('[CapVR] tryScore blocked: carrier dead');
        return false;
      }
      if (window.CapVRMp?.isPlayerDead?.(carrierId)) {
        console.log('[CapVR] tryScore blocked: carrier dead (MP HP map)');
        return false;
      }
      if (this._scoreBlockedUntil && performance.now() < this._scoreBlockedUntil
          && sameOwner(carrierId, localOwnerId())) {
        console.log('[CapVR] tryScore blocked: post-respawn grace');
        return false;
      }
      const carrierTeam = this.resolveTeamForOwner(carrierId);
      if (!carrierTeam || carrierTeam !== atTeamBase) {
        console.log('[CapVR] tryScore blocked: team mismatch', carrierId, carrierTeam, atTeamBase);
        return false;
      }

      const enemy = this.enemyTeam(carrierTeam);
      if (!sameOwner(state[enemy]?.carrierId, carrierId)) {
        console.log('[CapVR] tryScore blocked: not carrying enemy flag', enemy, state[enemy]?.carrierId);
        return false;
      }
      if (!state[carrierTeam].home) {
        console.warn('[CapVR] tryScore blocked: own flag not HOME', carrierTeam);
        const left = dropSecondsLeft(carrierTeam);
        const detail = state[carrierTeam].carrierId
          ? 'enemy still has your flag'
          : (left > 0 ? `your flag returns in ${left}s` : 'your flag is away');
        hudMsg(`CANNOT SCORE — ${detail}. Leave the goal & re-enter when yours is HOME.`, 3400);
        return false;
      }

      // Evidence = the same point(s) that triggered the goal hit (hand / follow pos).
      // Do NOT require flagEl.object3D — physics often lags behind the held hand.
      let inVol = false;
      if (evidencePos && this._pointInGoalVolume(evidencePos.x, evidencePos.y, evidencePos.z, carrierTeam)) {
        inVol = true;
      } else {
        const samples = this._scoreSamplePoints(carrierId, evidencePos || null);
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i];
          if (this._pointInGoalVolume(s.x, s.y, s.z, carrierTeam)) {
            inVol = true;
            break;
          }
        }
      }
      if (!inVol) {
        console.log('[CapVR] tryScore blocked: no evidence in goal volume');
        return false;
      }

      lastScoreAt = performance.now();
      console.log('%c[CapVR] ★ SCORE! ' + carrierTeam.toUpperCase(), 'color:#0f0;font-size:16px;font-weight:bold');
      _inOwnGoal[carrierTeam] = true;
      _scoreRetry[carrierTeam] = false;

      const flagEl = state[enemy].el;
      const bc = flagEl?.components?.['zerog-ball'];
      if (bc?.isGrabbed) {
        try { bc.onRelease?.(); } catch (e) { /* */ }
      }
      const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
      if (zp?.grabbedSurface) {
        ['left', 'right'].forEach((k) => {
          if (zp.grabbedSurface[k] === flagEl) {
            try { zp.releaseFromSurface?.(k === 'left' ? zp.leftHand : zp.rightHand); } catch (e) { /* */ }
            zp.grabbedSurface[k] = null;
            if (zp.isGrabbing) zp.isGrabbing[k] = false;
            if (zp.grabInfo) zp.grabInfo[k] = null;
          }
        });
      }
      state[enemy].carrierHand = null;

      this.resetHome(enemy);
      _prevFlagPos[enemy] = null;

      let scoredViaProcess = false;
      const pg = G().processGoalScored;
      const scoresBefore = G().teamScores
        ? { red: G().teamScores.red, blue: G().teamScores.blue }
        : null;

      if (typeof pg === 'function') {
        window._capvrForceGoal = true;
        try {
          pg(carrierTeam, atTeamBase);
          scoredViaProcess = true;
        } catch (e) {
          console.warn('[CapVR] processGoalScored failed', e);
        } finally {
          window._capvrForceGoal = false;
        }
      }

      const scores = G().teamScores;
      if (scores && scoresBefore && scores[carrierTeam] === scoresBefore[carrierTeam]) {
        scores[carrierTeam] = (scores[carrierTeam] || 0) + 1;
        G().updateScoreDisplays?.();
        G().showGoalHUD?.(carrierTeam, 'PLAYING', null);
      } else if (scores && !scoredViaProcess) {
        scores[carrierTeam] = (scores[carrierTeam] || 0) + 1;
        G().updateScoreDisplays?.();
        G().showGoalHUD?.(carrierTeam, 'PLAYING', null);
      }

      document.dispatchEvent(new CustomEvent('ctf-scored', {
        detail: { team: carrierTeam, flagTeam: enemy }
      }));
      hudMsg(`${carrierTeam.toUpperCase()} SCORES!`, 3000);
      // Flash own goal ring
      try {
        const goalEl = document.getElementById(carrierTeam === 'red' ? 'red-goal' : 'blue-goal');
        if (goalEl) {
          const mat = goalEl.getAttribute('material') || {};
          goalEl.setAttribute('material', Object.assign({}, mat, { emissiveIntensity: 2.5, opacity: 0.8 }));
          setTimeout(() => {
            goalEl.setAttribute('material', Object.assign({}, mat, { emissiveIntensity: 0.55, opacity: 0.35 }));
          }, 900);
        }
      } catch (e) { /* */ }
      this._hud();
      return true;
    },

    _goalPos(team) {
      const id = team === 'red' ? 'red-goal' : 'blue-goal';
      const el = document.getElementById(id);
      if (el?.object3D) {
        const p = new THREE.Vector3();
        el.object3D.getWorldPosition(p);
        return p;
      }
      const h = HOME[team];
      return new THREE.Vector3(h.x, h.y, h.z);
    },

    /** Sphere around goal center — one clear rule. */
    _pointInGoalVolume(px, py, pz, goalTeam) {
      const g = this._goalPos(goalTeam);
      return Math.hypot(px - g.x, py - g.y, pz - g.z) <= GOAL_SCORE_RADIUS;
    },

    _segmentCrossesGoal(ax, ay, az, bx, by, bz, goalTeam) {
      const g = this._goalPos(goalTeam);
      const z0 = az - g.z;
      const z1 = bz - g.z;
      if (z0 * z1 > 0 && Math.min(Math.abs(z0), Math.abs(z1)) > GOAL_SCORE_RADIUS) {
        return false;
      }
      let t = Math.abs(z1 - z0) < 1e-6 ? 0.5 : (0 - z0) / (z1 - z0);
      t = Math.max(0, Math.min(1, t));
      return this._pointInGoalVolume(
        ax + (bx - ax) * t,
        ay + (by - ay) * t,
        az + (bz - az) * t,
        goalTeam
      );
    },

    /** Evidence points while carrying: follow pos + holding hand (not camera — too easy to false-hit). */
    _scoreSamplePoints(carrierId, flagPos) {
      const pts = [];
      if (flagPos) pts.push(flagPos);
      const oid = carrierId;
      if (oid === localOwnerId() || oid === 'player_0') {
        const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
        const enemy = state.red?.carrierId === oid ? 'red' : (state.blue?.carrierId === oid ? 'blue' : null);
        const handKey = enemy ? state[enemy].carrierHand : null;
        const hands = [];
        if (handKey === 'left' && zp?.leftHand) hands.push(zp.leftHand);
        else if (handKey === 'right' && zp?.rightHand) hands.push(zp.rightHand);
        else {
          if (zp?.leftHand) hands.push(zp.leftHand);
          if (zp?.rightHand) hands.push(zp.rightHand);
        }
        hands.forEach((h) => {
          if (!h?.object3D) return;
          const v = new THREE.Vector3();
          h.object3D.getWorldPosition(v);
          pts.push({ x: v.x, y: v.y, z: v.z });
        });
        const bc = enemy && state[enemy].el?.components?.['zerog-ball'];
        if (bc?.isGrabbed && bc.grabbingHand?.object3D) {
          const v = new THREE.Vector3();
          bc.grabbingHand.object3D.getWorldPosition(v);
          pts.push({ x: v.x, y: v.y, z: v.z });
        }
      }
      return pts;
    },

    _checkCarrierScore(flagTeam, carrierId, flagPos) {
      const carrierTeam = this.resolveTeamForOwner(carrierId);
      if (!carrierTeam || carrierTeam === flagTeam) return;

      const samples = this._scoreSamplePoints(carrierId, flagPos);
      let hit = false;
      let evidence = flagPos || null;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (this._pointInGoalVolume(s.x, s.y, s.z, carrierTeam)) {
          hit = true;
          evidence = s;
          break;
        }
      }

      const prev = _prevFlagPos[flagTeam];
      if (!hit && prev && flagPos) {
        hit = this._segmentCrossesGoal(
          prev.x, prev.y, prev.z,
          flagPos.x, flagPos.y, flagPos.z,
          carrierTeam
        );
        if (hit) evidence = flagPos;
      }

      if (flagPos) {
        const g = this._goalPos(carrierTeam);
        const dist = Math.hypot(flagPos.x - g.x, flagPos.y - g.y, flagPos.z - g.z);
        if (dist < 12) {
          const hud = document.getElementById('ctf-status-hud');
          const left = dropSecondsLeft(carrierTeam);
          const ownOk = state[carrierTeam].home;
          let line;
          if (ownOk) {
            line = hit
              ? `★ SCORING ZONE — release through YOUR goal!`
              : `→ YOUR GOAL  ${dist.toFixed(1)}m — fly through the ring to score`;
          } else {
            line = left > 0
              ? `→ AT YOUR GOAL but CANNOT SCORE — your flag returns in ${left}s`
              : `→ AT YOUR GOAL but CANNOT SCORE — recover YOUR flag first`;
          }
          if (hud) {
            hud.dataset.nearGoal = '1';
            hud.textContent = line;
          }
          if (!ownOk && sameOwner(carrierId, localOwnerId())
              && (!this._lastAwayToast || performance.now() - this._lastAwayToast > 4000)) {
            this._lastAwayToast = performance.now();
            hudMsg(line, 2600);
          }
        }
      }

      if (hit) {
        const entering = !_inOwnGoal[carrierTeam];
        _inOwnGoal[carrierTeam] = true;
        // Enter once, or keep retrying if enter failed while own flag WAS home (pos desync).
        if (entering || _scoreRetry[carrierTeam]) {
          const ok = this.tryScore(carrierId, carrierTeam, evidence);
          if (ok) {
            _scoreRetry[carrierTeam] = false;
          } else if (!state[carrierTeam].home) {
            // Consumed this entry while flag away — must leave & re-enter after it returns
            _scoreRetry[carrierTeam] = false;
          } else {
            // Own flag home but score failed — retry next frames until leave
            _scoreRetry[carrierTeam] = true;
          }
        }
      } else {
        _inOwnGoal[carrierTeam] = false;
        _scoreRetry[carrierTeam] = false;
      }
    },

    /**
     * If the local player is physically holding a flag but CTF carrier state was lost,
     * re-attach carrier so scoring can run.
     */
    _syncCarrierFromPhysicalGrab() {
      const oid = localOwnerId();
      // Dead / deathcam: never re-attach carrier from a stuck grab
      if (!localCombatAlive()) {
        forceReleaseLocalFlagGrab(null);
        return;
      }
      const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
      ['red', 'blue'].forEach((team) => {
        const el = state[team].el || document.getElementById(`flag-${team}`);
        if (!el) return;
        state[team].el = el;
        const bc = el.components?.['zerog-ball'];
        const heldByHand =
          (zp?.grabbedSurface?.left === el) ||
          (zp?.grabbedSurface?.right === el) ||
          (zp?.grabInfo?.left?.surface === el) ||
          (zp?.grabInfo?.right?.surface === el);
        const heldByBall = !!(bc?.isGrabbed && bc.grabbingHand);
        if (!heldByHand && !heldByBall) return;

        // Local is holding this flag — ensure CTF carrier matches
        if (state[team].carrierId && !sameOwner(state[team].carrierId, oid)) return;
        if (this.resolveTeamForOwner(oid) === team) return; // can't carry own flag
        if (!sameOwner(state[team].carrierId, oid)) {
          console.log('[CapVR] re-sync carrier from physical grab', team, oid);
          this.setCarrier(team, oid);
        }
        if (!state[team].carrierHand) {
          if (zp?.grabbedSurface?.left === el || zp?.grabInfo?.left?.surface === el) {
            state[team].carrierHand = 'left';
          } else if (zp?.grabbedSurface?.right === el || zp?.grabInfo?.right?.surface === el) {
            state[team].carrierHand = 'right';
          }
        }
      });
    },

    getObjectiveForTeam(botTeam) {
      // Legacy helper — bot mission state machine uses getBotMission().
      const mission = this.getBotMission(null, botTeam);
      return mission?.flagEl || null;
    },

    /**
     * CTF bot mission — priority:
     * CARRY → own goal; RECOVER → enemy carrying our flag; ESCORT → ally has enemy flag;
     * ATTACK → enemy flag; DEFEND → orbit own flag / goal.
     * No touch-return grab of own flag (drop timer still applies).
     */
    getBotMission(owner, botTeam) {
      const enemyTeam = this.enemyTeam(botTeam);
      const myFlag = state[botTeam];
      const enemyFlag = state[enemyTeam];
      const goal = this._goalPos(botTeam);
      const home = HOME[botTeam] || goal;

      if (enemyFlag?.carrierId === owner) {
        return {
          behavior: 'CARRY',
          target: goal || home,
          flagEl: enemyFlag.el,
          grabTeam: null
        };
      }

      // Enemy has our flag — chase carrier (fight/recover). Do not grab our own flag.
      if (myFlag?.carrierId) {
        const carrierTeam = this.resolveTeamForOwner(myFlag.carrierId);
        if (carrierTeam && carrierTeam !== botTeam) {
          const pos = this._worldPosForOwner(myFlag.carrierId);
          return {
            behavior: 'RECOVER',
            target: pos || home,
            flagEl: myFlag.el,
            grabTeam: null,
            engageOwner: myFlag.carrierId
          };
        }
      }

      // Own flag on ground — camp / defend it until timer homes (no pickup).
      if (myFlag && !myFlag.home && !myFlag.carrierId) {
        const el = myFlag.el;
        const p = new THREE.Vector3();
        if (el?.object3D) el.object3D.getWorldPosition(p);
        else if (home) p.set(home.x, home.y, home.z);
        return {
          behavior: 'DEFEND',
          target: { x: p.x, y: p.y + 1.2, z: p.z },
          flagEl: el,
          grabTeam: null,
          preferDefend: true
        };
      }

      // Ally carrying enemy flag — escort toward our goal
      if (enemyFlag?.carrierId) {
        const ct = this.resolveTeamForOwner(enemyFlag.carrierId);
        if (ct === botTeam && enemyFlag.carrierId !== owner) {
          const cPos = this._worldPosForOwner(enemyFlag.carrierId);
          const tx = cPos && goal
            ? {
                x: (cPos.x + goal.x) * 0.5,
                y: ((cPos.y || 2) + (goal.y || 2)) * 0.5 + 0.5,
                z: (cPos.z + goal.z) * 0.5
              }
            : (goal || cPos);
          return {
            behavior: 'ESCORT',
            target: tx,
            flagEl: enemyFlag.el,
            grabTeam: null
          };
        }
        if (ct === botTeam) {
          // shouldn't reach — CARRY handles self
        } else {
          // Enemy carrying their... wait, enemyFlag carrier from OUR team handled above.
          // If somehow enemy carries enemy flag? Impossible. If freefloating handled below.
        }
      }

      // Prefer attack bot to go for enemy flag; defend bots orbit home.
      const preferDefend = owner === 'bot-green';
      if (preferDefend && myFlag?.home) {
        const hx = home?.x ?? 0;
        const hy = (home?.y ?? 2.2) + 1;
        const hz = home?.z ?? 0;
        const t = performance.now() * 0.0007 + 1.7;
        return {
          behavior: 'DEFEND',
          target: { x: hx + Math.cos(t) * 3.2, y: hy, z: hz + Math.sin(t) * 3.2 },
          flagEl: myFlag.el,
          grabTeam: null
        };
      }

      // Attack enemy flag (home or dropped free)
      if (enemyFlag && !enemyFlag.carrierId) {
        const el = enemyFlag.el;
        const p = new THREE.Vector3();
        if (el?.object3D) el.object3D.getWorldPosition(p);
        else {
          const eh = HOME[enemyTeam];
          if (eh) p.set(eh.x, eh.y, eh.z);
        }
        return {
          behavior: 'ATTACK',
          target: { x: p.x, y: p.y, z: p.z },
          flagEl: el,
          grabTeam: enemyTeam
        };
      }

      // Fallback: defend own home
      {
        const hx = home?.x ?? 0;
        const hy = (home?.y ?? 2.2) + 1;
        const hz = home?.z ?? 0;
        const t = performance.now() * 0.0008;
        return {
          behavior: 'DEFEND',
          target: { x: hx + Math.cos(t) * 3.5, y: hy, z: hz + Math.sin(t) * 3.5 },
          flagEl: myFlag?.el || null,
          grabTeam: null
        };
      }
    },

    tickCarryFollow() {
      this._syncCarrierFromPhysicalGrab();
      this.pinFreeFlags();

      ['red', 'blue'].forEach((team) => {
        const s = state[team];
        if (!s.carrierId || !s.el) {
          _prevFlagPos[team] = null;
          return;
        }
        s._pinPos = null; // carried — no pin
        const carrierEl = this._elForOwner(s.carrierId);
        if (!carrierEl) {
          // Don't clear carrier just because entity lookup failed for one frame
          console.warn('[CapVR] carrier el missing (keeping carrier)', s.carrierId);
          return;
        }
        const p = new THREE.Vector3();
        const oid = s.carrierId;
        let gotHand = false;
        if (sameOwner(oid, localOwnerId()) || oid === 'player_0') {
          // Deathcam: never keep following / scoring with a stuck hand grab
          if (!localCombatAlive()) {
            this.dropFromOwner(oid);
            return;
          }
          const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
          let hand = null;
          const preferred = s.carrierHand;
          if (preferred === 'left' && zp?.leftHand &&
              (zp.grabbedSurface?.left === s.el || zp.grabInfo?.left?.surface === s.el)) {
            hand = zp.leftHand;
          } else if (preferred === 'right' && zp?.rightHand &&
              (zp.grabbedSurface?.right === s.el || zp.grabInfo?.right?.surface === s.el)) {
            hand = zp.rightHand;
          }
          if (!hand && zp?.grabbedSurface?.left === s.el) {
            hand = zp.leftHand;
            s.carrierHand = 'left';
          } else if (!hand && zp?.grabbedSurface?.right === s.el) {
            hand = zp.rightHand;
            s.carrierHand = 'right';
          }
          // Ball component may still track the hand even if grabbedSurface drifted
          if (!hand) {
            const bc = s.el.components?.['zerog-ball'];
            if (bc?.isGrabbed && bc.grabbingHand) hand = bc.grabbingHand;
          }
          if (hand?.object3D) {
            hand.object3D.getWorldPosition(p);
            gotHand = true;
          } else {
            // Fall back to flag's current world pos (zerog-ball may already follow hand)
            s.el.object3D.getWorldPosition(p);
            gotHand = true;
          }
        } else if (carrierEl.body?.position) {
          p.set(carrierEl.body.position.x, carrierEl.body.position.y + 1.15, carrierEl.body.position.z);
          gotHand = true;
        } else {
          carrierEl.object3D.getWorldPosition(p);
          p.y += 1.15;
          gotHand = true;
        }
        if (gotHand) {
          this._placeFlag(s.el, p.x, p.y, p.z);
          s.home = false;
        }

        const flagPos = { x: p.x, y: p.y, z: p.z };
        // Also sample live object3D in case place raced with physics
        const live = new THREE.Vector3();
        s.el.object3D.getWorldPosition(live);
        this._checkCarrierScore(team, s.carrierId, flagPos);
        if (live.x !== flagPos.x || live.y !== flagPos.y || live.z !== flagPos.z) {
          this._checkCarrierScore(team, s.carrierId, { x: live.x, y: live.y, z: live.z });
        }
        _prevFlagPos[team] = flagPos;
      });
    },

    dropFromOwner(ownerId) {
      if (!ownerId) return;
      const pos = this._worldPosForOwner(ownerId);
      const isLocal = sameOwner(ownerId, localOwnerId());
      ['red', 'blue'].forEach((team) => {
        const s = state[team];
        if (!s?.carrierId || !sameOwner(s.carrierId, ownerId)) return;
        // Peel flag off the hand BEFORE clearing carrier (prevents re-sync→re-carry)
        if (isLocal) forceReleaseLocalFlagGrab(s.el);
        this.clearCarrier(team, pos || true);
      });
      // Safety: local death may have carrierId mismatch — still release any held CTF ball
      if (isLocal) {
        document.querySelectorAll('#flag-red, #flag-blue, .ctf-flag-ball').forEach((el) => {
          const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
          const held =
            zp?.grabbedSurface?.left === el ||
            zp?.grabbedSurface?.right === el ||
            zp?.grabInfo?.left?.surface === el ||
            zp?.grabInfo?.right?.surface === el;
          if (held) {
            forceReleaseLocalFlagGrab(el);
            const team = el.dataset?.flagTeam;
            if (team && sameOwner(state[team]?.carrierId, ownerId)) {
              this.clearCarrier(team, pos || true);
            } else if (team && !state[team]?.carrierId) {
              // Already cleared; pin at drop pos
              const p = pos || this._worldPosForOwner(ownerId);
              if (p) {
                state[team]._pinPos = { x: p.x, y: p.y, z: p.z };
                this._placeFlag?.(el, p.x, p.y, p.z);
              }
            }
          }
        });
      }
    },

    _worldPosForOwner(ownerId) {
      const el = this._elForOwner(ownerId);
      if (!el) return null;
      const p = new THREE.Vector3();
      if (ownerId === localOwnerId() || ownerId === 'player_0') {
        const cam = document.getElementById('camera');
        if (cam) {
          cam.object3D.getWorldPosition(p);
          p.y -= 0.5;
          return { x: p.x, y: p.y, z: p.z };
        }
      }
      if (el.body?.position) {
        return { x: el.body.position.x, y: el.body.position.y, z: el.body.position.z };
      }
      el.object3D.getWorldPosition(p);
      return { x: p.x, y: p.y, z: p.z };
    },

    _elForOwner(ownerId) {
      if (!ownerId) return null;
      if (String(ownerId).startsWith('bot-')) {
        return document.querySelector(`#zerog-${ownerId}`) || document.getElementById(ownerId);
      }
      return document.getElementById('player');
    },

    _hud() {
      // VR: only colored drop-reset countdown(s). No HOME/AWAY spam, no arena boards.
      updateDropCountdownHud();

      // Lightweight desktop debug strip (not shown in headset)
      const el = document.getElementById('ctf-status-hud');
      if (!el) return;
      if (el.dataset.nearGoal === '1') {
        el.dataset.nearGoal = '0';
        return;
      }
      const scores = G().teamScores || {};
      const bits = ['red', 'blue'].map((team) => {
        const left = dropSecondsLeft(team);
        if (left > 0) return `${team[0].toUpperCase()}:${left}s`;
        if (state[team]?.carrierId) return `${team[0].toUpperCase()}:carried`;
        return `${team[0].toUpperCase()}:${state[team]?.home ? 'home' : 'away'}`;
      });
      el.textContent = `${scores.red || 0}–${scores.blue || 0}  ${bits.join(' ')}`;
    }
  };

  function patchBallOwnership() {
    const comp = AFRAME.components['zerog-ball'];
    if (!comp?.Component?.prototype || comp.Component.prototype._capvrFlagHook) return;
    const proto = comp.Component.prototype;
    proto._capvrFlagHook = true;
    const origGrab = proto.onGrab;
    const origRelease = proto.onRelease;

    proto.onGrab = function (hand) {
      const team = this.el.dataset?.flagTeam;
      if (team) {
        const carrierId = localOwnerId();
        // Reset sticky grab flags so a prior failed grab can't block this one
        this.isGrabbed = false;
        const result = window.CapVRFlags.tryPickup(team, carrierId);
        if (result === false) {
          this.isGrabbed = false;
          this.currentOwner = null;
          return;
        }
        try {
          if (origGrab) origGrab.call(this, hand);
        } catch (e) {
          console.warn('[CapVR] flag onGrab (shim-safe):', e);
          this.isGrabbed = true;
          this.grabbingHand = hand;
        }
        this.currentOwner = carrierId;
        this.isGrabbed = true;
        window.CapVRFlags.state[team].carrierId = carrierId;
        window.CapVRFlags.state[team].botPickupBlockedUntil = 0;
        return;
      }
      try {
        return origGrab ? origGrab.call(this, hand) : undefined;
      } catch (e) {
        console.warn('[CapVR] ball onGrab:', e);
        this.isGrabbed = true;
        this.grabbingHand = hand;
      }
    };

    proto.onRelease = function (hand) {
      const team = this.el.dataset?.flagTeam;
      const carrierId = localOwnerId();
      // CTF flags must never inherit BoltVR throw velocity on drop.
      if (team) {
        this.isGrabbed = false;
        this.grabbingHand = null;
        this.currentOwner = null;
        try {
          if (this.body) {
            this.body.velocity.set(0, 0, 0);
            this.body.angularVelocity.set(0, 0, 0);
          }
          if (this.velocity) this.velocity.set?.(0, 0, 0);
        } catch (e) { /* */ }
        if (window.CapVRFlags.state[team]?.carrierId === carrierId) {
          const pos = window.CapVRFlags._worldPosForOwner(carrierId);
          window.CapVRFlags.state[team].carrierHand = null;
          window.CapVRFlags.clearCarrier(team, pos || true);
        }
        return;
      }
      try {
        if (origRelease) origRelease.call(this, hand);
      } catch (e) {
        console.warn('[CapVR] ball onRelease (shim-safe):', e);
        this.isGrabbed = false;
        this.grabbingHand = null;
      }
    };
  }

  function patchPlayerTryGrab() {
    const comp = AFRAME.components['zerog-player'];
    if (!comp?.Component?.prototype?.tryGrabBall || comp.Component.prototype._capvrFlagGrabGate) return;
    const proto = comp.Component.prototype;
    proto._capvrFlagGrabGate = true;

    const origFind = proto.findNearestBall;
    proto.findNearestBall = function (hand) {
      if (gameMode() === 'capture') {
        const handPos = new THREE.Vector3();
        if (this.getHandProbePos) this.getHandProbePos(hand, handPos);
        else hand?.object3D?.getWorldPosition?.(handPos);
        let best = null;
        let bestDist = Infinity;
        const oid = localOwnerId();
        document.querySelectorAll('#flag-red, #flag-blue, .ctf-flag-ball').forEach((el) => {
          if (!el.components?.['zerog-ball']) return;
          const team = el.dataset?.flagTeam;
          if (team && !window.CapVRFlags.canGrab(team, oid)) return;
          const bp = new THREE.Vector3();
          el.object3D.getWorldPosition(bp);
          const d = handPos.distanceTo(bp);
          if (d < FLAG_GRAB_DIST && d < bestDist) {
            bestDist = d;
            best = el;
          }
        });
        if (best) return best;
      }
      return origFind ? origFind.call(this, hand) : null;
    };

    const orig = proto.tryGrabBall;
    proto.tryGrabBall = function (hand) {
      const ball = this.findNearestBall?.(hand);
      const data = ball?.components?.['zerog-ball']?.data;
      const bp = data?.player;
      if (bp === 'flag-red' || bp === 'flag-blue') {
        const team = bp === 'flag-red' ? 'red' : 'blue';
        const oid = localOwnerId();
        const isLeft = hand?.id === 'leftHand' || hand?.id === 'left-hand';
        const handKey = isLeft ? 'left' : 'right';
        const otherKey = handKey === 'left' ? 'right' : 'left';
        if (this.isGrabbing?.[handKey]) return false;

        // Other hand already holding THIS flag → don't steal it; let wall grab proceed
        if (this.grabbedSurface?.[otherKey] === ball) return false;
        // Already carrying this flag with the other hand (carrierHand locked)
        const st = window.CapVRFlags.state[team];
        if (st?.carrierId === oid && st.carrierHand && st.carrierHand !== handKey) {
          return false;
        }

        if (!window.CapVRFlags.canGrab(team, oid)) return false;

        this.lastStealTime = 0;
        this.ballStealTimeout = null;

        const prevCarrier = st?.carrierId;
        try {
          this.grabbedSurface[handKey] = ball;
          if (this.attachToSurface) this.attachToSurface(hand, ball);
        } catch (e) {
          console.warn('[CapVR] flag attach failed:', e);
          this.grabbedSurface[handKey] = null;
          if (this.isGrabbing) this.isGrabbing[handKey] = false;
          if (window.CapVRFlags.state[team]?.carrierId === oid && prevCarrier !== oid) {
            window.CapVRFlags.clearCarrier(team, true);
          }
          return false;
        }

        // Own-flag return path removed — never treat home as a failed enemy grab cleanup
        if (!window.CapVRFlags.state[team]?.carrierId) {
          this.grabbedSurface[handKey] = null;
          if (this.isGrabbing) this.isGrabbing[handKey] = false;
          if (this.grabInfo) this.grabInfo[handKey] = null;
          return false;
        }

        // Lock follow to this hand so wall-grabs with the other hand can't steal the flag
        window.CapVRFlags.state[team].carrierHand = handKey;

        if (!this.isGrabbing?.[handKey]) {
          this.isGrabbing[handKey] = true;
          if (!this.grabInfo) this.grabInfo = {};
          this.grabInfo[handKey] = {
            surface: ball,
            isBall: true,
            initialHandPos: new THREE.Vector3(),
            lastHandPos: new THREE.Vector3()
          };
          hand?.object3D?.getWorldPosition?.(this.grabInfo[handKey].initialHandPos);
          this.grabInfo[handKey].lastHandPos.copy(this.grabInfo[handKey].initialHandPos);
        }

        if (this.playHapticFeedback) this.playHapticFeedback(hand, 0.5, 100);
        return true;
      }
      return orig.call(this, hand);
    };
  }

  function patchBotFlagGrab() {
    const comp = AFRAME.components['zerog-bot'];
    if (!comp?.Component?.prototype || comp.Component.prototype._capvrBotFlag) return;
    const proto = comp.Component.prototype;
    proto._capvrBotFlag = true;

    const FIRE_COOLDOWN = 700;
    const FIRE_RANGE = 24;
    // Target + line-of-sight scanning is expensive (full-arena raycasts per candidate).
    // Running it every frame per bot was the CapVR-only bot-aim perf sink. Re-scan a few
    // times a second and cheaply track the cached target's position in between.
    const THREAT_EVAL_MS = 150;
    // ~75° half-angle — was 60° and combined with strafe-facing meant bots almost never shot.
    const FIRE_AIM_COS = Math.cos((75 * Math.PI) / 180);
    const FLAG_GRAB_RANGE = 2.35;
    // Soft play volume around goals at z=±38.8 (bots outside this must not deal laser damage)
    const PLAY = { x: 20, yMin: -0.5, yMax: 12, z: 40 };
    const _aimFrom = new THREE.Vector3();
    const _aimTo = new THREE.Vector3();
    const _aimDir = new THREE.Vector3();
    const _losA = new THREE.Vector3();
    const _losB = new THREE.Vector3();

    function botOwnerFromEl(el) {
      if (el?.id === 'zerog-bot-red') return 'bot-red';
      if (el?.id === 'zerog-bot-green') return 'bot-green';
      return 'bot-blue';
    }

    function isBotAlive(owner) {
      if (window.CapVRCombat?.isBotAlive) return window.CapVRCombat.isBotAlive(owner);
      return true;
    }

    function inPlayVolume(p) {
      if (!p) return false;
      return Math.abs(p.x) <= PLAY.x
        && Math.abs(p.z) <= PLAY.z
        && p.y >= PLAY.yMin
        && p.y <= PLAY.yMax;
    }

    /** Full 3D LOS + mid-height horizontal LOS (blocks outside / over-wall peek lasers). */
    function hasCombatLos(from, to) {
      if (typeof window.CapVRCombat?.hasCombatLos === 'function') {
        return window.CapVRCombat.hasCombatLos(from, to, 0.05);
      }
      const los = window.CapVRCombat?.hasLineOfSight;
      if (typeof los !== 'function') return false;
      if (!los(from, to, 0.05)) return false;
      const midY = Math.min(from.y, to.y) + 0.5;
      _losA.set(from.x, midY, from.z);
      _losB.set(to.x, midY, to.z);
      return los(_losA, _losB, 0.05);
    }

    /** Local human behind cover: require clear LOS to head AND torso. */
    function hasLosToLocalPlayer(from) {
      if (typeof window.CapVRCombat?.hasLosToLocalPlayer === 'function') {
        return window.CapVRCombat.hasLosToLocalPlayer(from, 0.05);
      }
      return hasCombatLos(from, getPlayerAimPos(_aimTo) || from);
    }

    function getPlayerAimPos(out) {
      // Aim at torso for lead; damage LOS separately requires camera/head clear.
      const player = document.getElementById('player') || document.getElementById('rig');
      if (player?.object3D) {
        player.object3D.getWorldPosition(out);
        out.y += 1.05;
        return out;
      }
      const cam = document.getElementById('camera');
      if (cam?.object3D) {
        cam.object3D.getWorldPosition(out);
        return out;
      }
      return null;
    }

    function shooterCanFire(bot) {
      if (!bot?.el || bot._capvrDead) return false;
      const owner = botOwnerFromEl(bot.el);
      if (!isBotAlive(owner)) return false;
      const bodyEl = document.getElementById(`${owner}-body`);
      if (bodyEl?.components?.['grabbable-ragdoll']?.ragdollActive) return false;
      return true;
    }

    /** BattleVR-style facing gate: must roughly face the target to shoot. */
    function isFacingTarget(bot, toDir) {
      if (!bot?.el?.object3D || !toDir) return false;
      const forward = new THREE.Vector3(0, 0, 1);
      forward.applyQuaternion(bot.el.object3D.quaternion);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) return false;
      forward.normalize();
      // Compare on XZ — upright bots yaw-only (BattleVR did the same style check).
      const aim = new THREE.Vector3(toDir.x, 0, toDir.z);
      if (aim.lengthSq() < 1e-6) return true; // target nearly above/below — allow
      aim.normalize();
      return forward.dot(aim) >= FIRE_AIM_COS;
    }

    // CapVR CTF combat is lasers — disable BoltVR personal-ball spam at the player.
    if (!proto._capvrNoBallThrow) {
      proto._capvrNoBallThrow = true;
      const origThrow = proto.throwBallAtPlayer;
      proto.throwBallAtPlayer = function () {
        if (gameMode() === 'capture') return;
        return origThrow ? origThrow.apply(this, arguments) : undefined;
      };
    }

    /**
     * BoltVR-style steer: face target → thrusters only.
     * NO direct velocity assist (that made bots ice-skate faster than players).
     * applyThrusterForces + maybeBoost own the actual push.
     */
    function steerBot(bot, target, dt, opts) {
      if (!bot?.body || !bot.velocity || !target) return Infinity;
      const bp = bot.body.position;
      let aimX = target.x - bp.x;
      let aimY = (target.y != null ? target.y : bp.y) - bp.y;
      let aimZ = target.z - bp.z;
      let dist = Math.hypot(aimX, aimY, aimZ) || 1;
      bot._targetDistance = dist;
      aimX /= dist; aimY /= dist; aimZ /= dist;

      // Thrust direction (may orbit) vs face direction (keepAim stays on the quarry)
      let thrustX = aimX;
      let thrustY = aimY;
      let thrustZ = aimZ;

      if (opts?.strafe) {
        const sx = -aimZ;
        const sz = aimX;
        const amt = Math.sin(performance.now() / (opts.period || 420)) * (opts.strafeAmt || 0.5);
        if (opts.keepAim) {
          // Circle while facing the target (so lasers can actually fire)
          thrustX = aimX + sx * amt;
          thrustZ = aimZ + sz * amt;
          if (opts.holdRange && dist < opts.holdRange * 0.7) {
            thrustX = -aimX * 0.55 + sx * amt;
            thrustY = aimY * 0.2;
            thrustZ = -aimZ * 0.55 + sz * amt;
          } else if (opts.holdRange && dist < opts.holdRange) {
            thrustX = sx * (0.85 + Math.abs(amt));
            thrustY = aimY * 0.15;
            thrustZ = sz * (0.85 + Math.abs(amt));
          }
          const tLen = Math.hypot(thrustX, thrustY, thrustZ) || 1;
          thrustX /= tLen; thrustY /= tLen; thrustZ /= tLen;
        } else {
          thrustX += sx * amt;
          thrustZ += sz * amt;
          const len = Math.hypot(thrustX, thrustY, thrustZ) || 1;
          thrustX /= len; thrustY /= len; thrustZ /= len;
          if (opts.holdRange && dist < opts.holdRange * 0.75) {
            thrustX = -aimX; thrustY = -aimY * 0.35; thrustZ = -aimZ;
          } else if (opts.holdRange && dist < opts.holdRange) {
            thrustX = sx; thrustY *= 0.2; thrustZ = sz;
            const l2 = Math.hypot(thrustX, thrustY, thrustZ) || 1;
            thrustX /= l2; thrustY /= l2; thrustZ /= l2;
          }
          // Without keepAim, face along thrust (legacy wander / defend patrol)
          aimX = thrustX; aimY = thrustY; aimZ = thrustZ;
        }
      }

      if (!bot.targetDirection) bot.targetDirection = new THREE.Vector3();
      bot.targetDirection.set(thrustX, thrustY, thrustZ);
      const faceDir = new THREE.Vector3(aimX, 0, aimZ);
      if (faceDir.lengthSq() < 1e-6) faceDir.set(0, 0, 1);
      else faceDir.normalize();
      const facing = typeof bot.rotateTowards === 'function'
        ? bot.rotateTowards(faceDir, dt)
        : true;
      bot.thrusterActive = bot.thrusterActive || { left: false, right: false };
      // keepAim: allow thrusters even while still turning (strafe + gun fights)
      const mayThrust = opts?.keepAim ? true : !!facing;
      bot.thrusterActive.left = mayThrust;
      bot.thrusterActive.right = mayThrust;
      bot.navigationState = facing ? 'thrusting' : 'rotating';
      return dist;
    }

    function flagGrabDistance(bot, mission) {
      if (!mission?.grabTeam || !bot?.body) return Infinity;
      const el = mission.flagEl || window.CapVRFlags.state?.[mission.grabTeam]?.el;
      if (!el?.object3D) {
        const t = mission.target;
        if (!t) return Infinity;
        return Math.hypot(
          t.x - bot.body.position.x,
          (t.y != null ? t.y : bot.body.position.y) - bot.body.position.y,
          t.z - bot.body.position.z
        );
      }
      const fp = new THREE.Vector3();
      el.object3D.getWorldPosition(fp);
      return Math.hypot(
        fp.x - bot.body.position.x,
        fp.y - bot.body.position.y,
        fp.z - bot.body.position.z
      );
    }

    function bestEnemyTarget(bot, myTeam) {
      let best = null;
      let bestDist = FIRE_RANGE;
      const bp = bot.body?.position;
      if (!bp || !inPlayVolume(bp)) return null;

      _aimFrom.set(bp.x, bp.y + 0.35, bp.z);

      const teamsMap = window.CapVRGame?.playerTeams;
      // Local human — only if BOTH head and torso are exposed (real cover blocks)
      const localPid = localOwnerId();
      const playerTeam = window.CapVRFlags.resolveTeamForOwner(localPid);
      if (playerTeam && playerTeam !== myTeam && getPlayerAimPos(_aimTo)) {
        if (inPlayVolume(_aimTo)) {
          const d = _aimFrom.distanceTo(_aimTo);
          if (d < bestDist && hasLosToLocalPlayer(_aimFrom)) {
            bestDist = d;
            best = { type: 'player', playerId: localPid, pos: _aimTo.clone(), dist: d };
          }
        }
      }
      // Remote humans (host AI sees synced remote targets)
      for (let i = 0; i < 4; i++) {
        const pid = `player_${i}`;
        if (pid === localPid) continue;
        if (window.CapVRGame?.isPlayerConnected
            && !window.CapVRGame.isPlayerConnected(pid)) continue;
        const team = teamsMap?.get?.(pid) || window.CapVRFlags.resolveTeamForOwner(pid);
        if (!team || team === myTeam) continue;
        const parent = document.getElementById(`remote-player-${i}`);
        const el = document.getElementById(`remote-target-${i}`) || parent;
        if (!el?.object3D || !parent) continue;
        const pVis = parent.getAttribute('visible');
        if (pVis === false || pVis === 'false') continue;
        const pos = new THREE.Vector3();
        el.object3D.getWorldPosition(pos);
        if (!inPlayVolume(pos)) continue;
        const d = _aimFrom.distanceTo(pos);
        if (d < bestDist && hasCombatLos(_aimFrom, pos)) {
          bestDist = d;
          best = { type: 'human', playerId: pid, pos: pos.clone(), dist: d };
        }
      }

      ['zerog-bot-red', 'zerog-bot-blue', 'zerog-bot-green'].forEach((id) => {
        if (id === bot.el.id) return;
        const el = document.getElementById(id);
        const bc = el?.components?.['zerog-bot'];
        if (!bc || bc.data.team === myTeam || bc._capvrDead) return;
        const owner = botOwnerFromEl(el);
        if (!isBotAlive(owner)) return;
        const p = el.body?.position || el.object3D.position;
        if (!inPlayVolume(p)) return;
        const pos = new THREE.Vector3(p.x, (p.y || 0) + 1.0, p.z);
        const d = _aimFrom.distanceTo(pos);
        if (d < bestDist && hasCombatLos(_aimFrom, pos)) {
          bestDist = d;
          best = {
            type: 'bot',
            owner,
            bodyEl: document.getElementById(`${owner}-body`)
              || document.querySelector(`[data-bot-id="${id}"]`),
            pos,
            dist: d
          };
        }
      });
      return best;
    }

    // Cheaply update a cached threat's position/distance without any raycast, so aim
    // tracks a moving target between full LOS re-scans. Returns false if the target
    // is gone/dead (forcing a fresh scan on the next eval tick).
    function refreshThreatPos(bot, threat) {
      if (!threat || !bot?.body) return false;
      const bp = bot.body.position;
      _aimFrom.set(bp.x, bp.y + 0.35, bp.z);
      if (threat.type === 'player') {
        if (!getPlayerAimPos(threat.pos)) return false;
      } else if (threat.type === 'bot') {
        if (!isBotAlive(threat.owner)) return false;
        const el = document.getElementById('zerog-' + threat.owner);
        const p = el?.body?.position || el?.object3D?.position;
        if (!p) return false;
        threat.pos.set(p.x, (p.y || 0) + 1.0, p.z);
      } else if (threat.type === 'human') {
        const idx = String(threat.playerId).replace('player_', '');
        const parent = document.getElementById('remote-player-' + idx);
        const el = document.getElementById('remote-target-' + idx) || parent;
        const pVis = parent?.getAttribute?.('visible');
        if (!el?.object3D || pVis === false || pVis === 'false') return false;
        el.object3D.getWorldPosition(threat.pos);
      } else {
        return false;
      }
      if (!inPlayVolume(threat.pos)) return false;
      threat.dist = _aimFrom.distanceTo(threat.pos);
      return threat.dist <= FIRE_RANGE;
    }

    // Throttled threat acquisition. Staggered per bot so all three don't scan the
    // same frame. Between scans the cached target is position-refreshed for free.
    function getThreatThrottled(bot, myTeam) {
      const now = performance.now();
      if (bot._capvrThreatPhase == null) bot._capvrThreatPhase = Math.random() * THREAT_EVAL_MS;
      const due = now - (bot._capvrThreatAt || 0) >= THREAT_EVAL_MS + bot._capvrThreatPhase;
      if (!due && bot._capvrThreat) {
        if (refreshThreatPos(bot, bot._capvrThreat)) return bot._capvrThreat;
        // Cached target invalid — fall through to a fresh scan.
      }
      if (!due && !bot._capvrThreat) return null;
      bot._capvrThreatAt = now;
      bot._capvrThreatPhase = 0;
      bot._capvrThreat = bestEnemyTarget(bot, myTeam);
      return bot._capvrThreat;
    }

    function fireAt(bot, myTeam, target) {
      // DIAGNOSTIC: run with __capvrBotsFire(false) to stop all bot shooting →
      // no laser hits → no shatter fragments. If the frame STILL dips to 36 with
      // firing off, the dip is not the shatter churn. Toggle back with (true).
      if (window.__capvrBotFireOff === true || window.perfConfig?.botFiringEnabled === false) return;
      if (!target?.pos || !bot.body) return;
      if (!shooterCanFire(bot)) return;
      const now = performance.now();
      if (now - (bot._capvrLastFire || 0) < FIRE_COOLDOWN) return;

      _aimFrom.set(bot.body.position.x, bot.body.position.y + 0.35, bot.body.position.z);
      // Shooter outside play volume must not deal damage (common after flying out)
      if (!inPlayVolume(_aimFrom)) return;

      _aimTo.copy(target.pos);
      if (target.type === 'player') getPlayerAimPos(_aimTo);
      if (!inPlayVolume(_aimTo)) return;

      _aimDir.subVectors(_aimTo, _aimFrom);
      const dist = _aimDir.length() || 1;
      if (dist > FIRE_RANGE) return;
      _aimDir.multiplyScalar(1 / dist);

      // Must be turned toward the target (~60° cone like BattleVR aimAtTarget).
      if (!isFacingTarget(bot, _aimDir)) return;

      // Hard combat LOS. Local player: head+torso. Others: aim point.
      const clearLos = target.type === 'player'
        ? hasLosToLocalPlayer(_aimFrom)
        : hasCombatLos(_aimFrom, _aimTo);
      if (!clearLos) {
        bot._capvrLastFire = now;
        const wall = typeof window.CapVRCombat?.castEnvRay === 'function'
          ? window.CapVRCombat.castEnvRay(_aimFrom, _aimDir, dist)
          : null;
        const impact = wall?.point
          || new THREE.Vector3().copy(_aimFrom).addScaledVector(_aimDir, Math.min(dist, 4));
        document.dispatchEvent(new CustomEvent('capvr-laser', {
          detail: {
            from: _aimFrom.clone(),
            to: impact.clone ? impact.clone() : impact,
            team: myTeam,
            color: myTeam === 'red' ? '#ff6655' : '#55aaff',
            hit: false
          }
        }));
        return;
      }

      bot._capvrLastFire = now;

      document.dispatchEvent(new CustomEvent('capvr-laser', {
        detail: {
          from: _aimFrom.clone(),
          to: _aimTo.clone(),
          team: myTeam,
          color: myTeam === 'red' ? '#ff6655' : '#55aaff',
          hit: true
        }
      }));

      const dmg = window.CapVRCombat?.LASER_DAMAGE || 16;
      if (target.type === 'player') {
        // Final gate at damage time (LOS can change between target pick and fire)
        if (!hasLosToLocalPlayer(_aimFrom)) return;
        document.dispatchEvent(new CustomEvent('local-player-shot', {
          detail: {
            fromTeam: myTeam,
            point: _aimTo.clone(),
            dir: _aimDir.clone(),
            from: _aimFrom.clone(),
            to: _aimTo.clone(),
            damage: dmg
          }
        }));
        return;
      }
      if (target.type === 'human' && target.playerId) {
        // Host AI → remote human (multiplayer)
        document.dispatchEvent(new CustomEvent('capvr-bot-player-hit', {
          detail: {
            playerId: target.playerId,
            damage: dmg,
            fromTeam: myTeam,
            point: _aimTo.clone(),
            from: _aimFrom.clone(),
            to: _aimTo.clone()
          }
        }));
        return;
      }
      if (target.bodyEl) {
        // Single shatter path via damageBot (collapse only at HP 0)
        document.dispatchEvent(new CustomEvent('capvr-limb-hit', {
          detail: {
            el: target.bodyEl,
            credited: true,
            force: true,
            point: _aimTo.clone(),
            dir: _aimDir.clone(),
            damage: dmg
          }
        }));
      }
    }

    if (proto.intelligentNavigation) {
      proto.intelligentNavigation = function (dt) {
        if (gameMode() !== 'capture') {
          // Hidden capture-ball makes stock AI idle — keep still rather than thrash.
          this.navigationState = 'idle';
          this.thrusterActive.left = false;
          this.thrusterActive.right = false;
          return;
        }

        const owner = botOwnerFromEl(this.el);
        if (this._capvrDead || !isBotAlive(owner)) {
          this.thrusterActive.left = false;
          this.thrusterActive.right = false;
          this.navigationState = 'idle';
          if (this.velocity) this.velocity.set(0, 0, 0);
          return;
        }

        const myTeam = this.data.team || window.CapVRFlags.resolveTeamForOwner(owner);
        const mission = window.CapVRFlags.getBotMission(owner, myTeam);
        if (!mission?.target || !this.body) {
          this.navigationState = 'idle';
          return;
        }

        this._capvrBehavior = mission.behavior;

        // Engage nearby threats: strafe + shoot (BattleVR-style).
        // Throttled — full LOS scanning every frame per bot was the perf sink.
        const threat = getThreatThrottled(this, myTeam);
        const flagDist = flagGrabDistance(this, mission);
        // Prefer flag snatch when almost on it — don't get stuck dueling and never grab
        const nearFlag = !!(mission.grabTeam && flagDist < FLAG_GRAB_RANGE + 0.8);
        const engage =
          !nearFlag && threat && threat.dist < 16 &&
          (mission.behavior === 'DEFEND' || mission.behavior === 'RECOVER' ||
           mission.behavior === 'ESCORT' || mission.behavior === 'ATTACK' ||
           mission.behavior === 'CARRY');

        let dist;
        if (engage && threat) {
          dist = steerBot(this, threat.pos, dt, {
            strafe: true,
            strafeAmt: 0.4,
            period: 480,
            holdRange: 8,
            keepAim: true
          });
          fireAt(this, myTeam, threat);
        } else if (mission.behavior === 'DEFEND') {
          dist = steerBot(this, mission.target, dt, {
            strafe: true,
            strafeAmt: 0.35,
            period: 700,
            keepAim: !!(threat && threat.dist < 12)
          });
          if (threat && threat.dist < FIRE_RANGE) fireAt(this, myTeam, threat);
        } else if (mission.behavior === 'CARRY') {
          dist = steerBot(this, mission.target, dt);
          this.isGrabbingBall = true;
          if (threat && threat.dist < 10) fireAt(this, myTeam, threat);
        } else if (mission.behavior === 'RECOVER') {
          dist = steerBot(this, mission.target, dt, {
            strafe: true,
            strafeAmt: 0.3,
            keepAim: !!(threat && threat.dist < 14)
          });
          if (threat) fireAt(this, myTeam, threat);
        } else {
          // ATTACK / ESCORT — thrusters + boost only
          dist = steerBot(this, mission.target, dt);
          if (threat && threat.dist < FIRE_RANGE) fireAt(this, myTeam, threat);
        }

        // Always measure against the flag — not the combat steer distance
        if (mission.grabTeam && flagDist < FLAG_GRAB_RANGE) {
          const ok = window.CapVRFlags.tryPickup(mission.grabTeam, owner);
          if (ok) this.isGrabbingBall = true;
        }
      };
    }

    if (proto.releaseBall) {
      const origRel = proto.releaseBall;
      proto.releaseBall = function () {
        window.CapVRFlags.dropFromOwner(botOwnerFromEl(this.el));
        return origRel.apply(this, arguments);
      };
    }
  }

  function patchGoalForCtf() {
    const comp = AFRAME.components['goal'];
    if (!comp?.Component?.prototype?.checkGoalScore || comp.Component.prototype._capvrCtfGoal) return;
    const proto = comp.Component.prototype;
    proto._capvrCtfGoal = true;
    // Collide must NOT score. Own-flag auto-home lands ON the goal sensor and used to
    // call tryScore whenever the player was carrying the enemy flag anywhere on the map.
    proto.checkGoalScore = function () {
      /* CapVR: scoring is tick + volume only (see CapVRFlags._checkCarrierScore). */
    };
  }

  function patchStunDropsFlag() {
    const ballComp = AFRAME.components['zerog-ball'];
    if (ballComp?.Component?.prototype?.stunPlayer && !ballComp.Component.prototype._capvrStunDrop) {
      const proto = ballComp.Component.prototype;
      proto._capvrStunDrop = true;
      const orig = proto.stunPlayer;
      proto.stunPlayer = function () {
        window.CapVRFlags?.dropFromOwner?.(localOwnerId());
        return orig.apply(this, arguments);
      };
    }
    if (ballComp?.Component?.prototype?.stunBot && !ballComp.Component.prototype._capvrStunBotDrop) {
      const proto = ballComp.Component.prototype;
      proto._capvrStunBotDrop = true;
      const orig = proto.stunBot;
      proto.stunBot = function (botId) {
        if (botId) window.CapVRFlags?.dropFromOwner?.(botId);
        return orig.apply(this, arguments);
      };
    }
  }

  function boot() {
    window.CapVRFlags.ensureEntities();
    patchBallOwnership();
    patchBotFlagGrab();
    patchGoalForCtf();
    patchPlayerTryGrab();
    patchStunDropsFlag();
    document.addEventListener('combatant-died', (e) => {
      if (e.detail?.id) window.CapVRFlags.dropFromOwner(e.detail.id);
    });
    document.addEventListener('entity-respawned', (e) => {
      const id = e.detail?.entityId || e.detail?.id;
      if (!id) return;
      // Belt-and-suspenders: never enter the field still carrying
      window.CapVRFlags.dropFromOwner(id);
      if (sameOwner(id, localOwnerId())) {
        window.CapVRFlags._scoreBlockedUntil = performance.now() + 2500;
        forceReleaseLocalFlagGrab(null);
      }
    });

    if (!document.getElementById('ctf-status-hud')) {
      const d = document.createElement('div');
      d.id = 'ctf-status-hud';
      d.style.cssText = 'position:fixed;bottom:12px;left:12px;background:rgba(0,0,0,.85);color:#9cf;padding:8px 12px;font:13px monospace;z-index:10000;max-width:92vw;pointer-events:none';
      document.body.appendChild(d);
    }
    destroyArenaCtfBoard();
    ensureCamCtfHud();
    window.CapVRFlags._hud();

    // CRITICAL: A-Frame does NOT emit a DOM 'tick' event. Scoring must run via a
    // component tick() (or rAF). The old addEventListener('tick') never fired —
    // that is why bringing the flag to the goal did nothing.
    if (!AFRAME.components['capvr-ctf-tick']) {
      AFRAME.registerComponent('capvr-ctf-tick', {
        tick: function () {
          if (gameMode() !== 'capture') return;
          window.CapVRFlags.tickCarryFollow();
          window.CapVRFlags._hud();
          const c = document.getElementById('capture-ball');
          if (c) c.setAttribute('visible', false);
        }
      });
    }
    const scene = document.querySelector('a-scene');
    if (scene && !scene.getAttribute('capvr-ctf-tick')) {
      scene.setAttribute('capvr-ctf-tick', '');
    }

    // Make goal rings non-solid so you can fly through the hole (visual + score only).
    ['red-goal', 'blue-goal'].forEach((id) => {
      const goal = document.getElementById(id);
      if (!goal) return;
      const torus = goal.querySelector('a-torus');
      if (torus) {
        torus.removeAttribute('grab-surface');
        torus.classList.remove('grabbable-surface');
        // Soft visual only — disable any physics body left on the ring
        try {
          if (torus.body && window.CANNON?.world) {
            window.CANNON.world.remove?.(torus.body);
            torus.body = null;
          }
        } catch (e) { /* */ }
      }
      // Goal cylinder is a thin sensor disk (wrong orientation vs visual). Keep collide
      // backup but scoring is driven by the component tick volume check.
    });

    console.log('[CapVR] CTF ready');
  }

  function scheduleBoot() {
    if (window._capvrCtfBooted) return;
    window._capvrCtfBooted = true;
    setTimeout(boot, 300);
  }

  if (document.querySelector('a-scene')?.hasLoaded) scheduleBoot();
  else document.querySelector('a-scene')?.addEventListener('loaded', scheduleBoot, { once: true });
})();
