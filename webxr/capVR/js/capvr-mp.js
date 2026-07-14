/**
 * CapVR multiplayer — host-authoritative CTF + combat glue over CapVRGame.sendCombatMsg.
 * Peers: clients propose (flag pickup/score, damage); host applies + broadcasts state.
 */
(function () {
  'use strict';

  const THREE = (window.AFRAME && window.AFRAME.THREE) || window.THREE;
  let _applyingFlagNet = false;
  let _playerHp = Object.create(null);

  function G() { return window.CapVRGame || {}; }
  function isMp() { return !!G().isMultiplayer?.(); }
  function isHost() { return !isMp() || !!G().isHost?.(); }
  function localId() { return G().myPlayerId || 'player_0'; }
  function send(msg) { G().sendCombatMsg?.(msg); }

  function ensurePlayerHp(id) {
    if (!_playerHp[id] && _playerHp[id] !== 0) {
      _playerHp[id] = window.CapVRCombat?.MAX_HP || 100;
    }
    return _playerHp[id];
  }

  function flagSnapshot() {
    const F = window.CapVRFlags;
    if (!F?.state) return null;
    const out = { red: null, blue: null };
    ['red', 'blue'].forEach((team) => {
      const s = F.state[team];
      if (!s) return;
      const pin = s._pinPos || F.HOME?.[team] || { x: 0, y: 2.6, z: 0 };
      out[team] = {
        home: !!s.home,
        carrierId: s.carrierId || null,
        carrierHand: s.carrierHand || null,
        pin: { x: pin.x, y: pin.y, z: pin.z },
        dropUntil: s.dropUntil || 0
      };
    });
    return out;
  }

  function broadcastFlags() {
    if (!isMp() || !isHost() || _applyingFlagNet) return;
    const flags = flagSnapshot();
    if (!flags) return;
    const scores = G().teamScores || { red: 0, blue: 0 };
    send({
      type: 'ctf-flag-state',
      flags,
      scores: { red: scores.red || 0, blue: scores.blue || 0 },
      fromId: localId()
    });
  }

  function applyFlagSnapshot(data) {
    const F = window.CapVRFlags;
    if (!F?.state || !data?.flags) return;
    _applyingFlagNet = true;
    try {
      ['red', 'blue'].forEach((team) => {
        const remote = data.flags[team];
        const s = F.state[team];
        if (!remote || !s) return;
        const el = s.el || F.getFlagEl?.(team);
        if (!el) return;

        if (remote.carrierId) {
          s.home = false;
          s.carrierId = remote.carrierId;
          s.carrierHand = remote.carrierHand || null;
          s._pinPos = null;
          F._clearDropTimer?.(team);
          el.dataset.carrierId = remote.carrierId;
          const bc = el.components?.['zerog-ball'];
          if (bc) {
            bc.currentOwner = remote.carrierId;
            bc.isGrabbed = true;
          }
        } else {
          s.carrierId = null;
          s.carrierHand = null;
          s.home = !!remote.home;
          delete el.dataset.carrierId;
          const bc = el.components?.['zerog-ball'];
          if (bc) {
            bc.currentOwner = null;
            bc.isGrabbed = false;
          }
          const pin = remote.pin || F.HOME?.[team];
          if (pin) {
            s._pinPos = { x: pin.x, y: pin.y, z: pin.z };
            F._placeFlag?.(el, pin.x, pin.y, pin.z);
          }
          if (remote.home) F._clearDropTimer?.(team);
          else if (remote.dropUntil && remote.dropUntil > performance.now()) {
            // Keep local drop timer roughly aligned
            if (!s.dropTimer) F._startDropTimer?.(team);
          }
        }
      });
      if (data.scores && G().teamScores) {
        G().teamScores.red = data.scores.red || 0;
        G().teamScores.blue = data.scores.blue || 0;
        G().updateScoreDisplays?.();
      }
      F._hud?.();
    } finally {
      _applyingFlagNet = false;
    }
  }

  function patchFlags() {
    const F = window.CapVRFlags;
    if (!F || F._capvrMpPatched) return;
    F._capvrMpPatched = true;

    const wrap = (name, after) => {
      const orig = F[name];
      if (typeof orig !== 'function') return;
      F[name] = function () {
        const result = orig.apply(this, arguments);
        if (!_applyingFlagNet && isHost()) after(result, arguments);
        return result;
      };
    };

    wrap('setCarrier', () => broadcastFlags());
    wrap('clearCarrier', () => broadcastFlags());
    wrap('resetHome', () => broadcastFlags());
    wrap('resetMatchFlags', () => broadcastFlags());

    // Any drop (death, stun, release) must reach the host
    const origDrop = F.dropFromOwner?.bind(F);
    if (origDrop && !F._capvrMpDropPatched) {
      F._capvrMpDropPatched = true;
      F.dropFromOwner = function (ownerId) {
        if (isMp() && !isHost() && !_applyingFlagNet && ownerId) {
          const pin = F._worldPosForOwner?.(ownerId);
          send({
            type: 'ctf-flag-request',
            action: 'drop',
            carrierId: ownerId,
            fromId: localId(),
            pin: pin ? { x: pin.x, y: pin.y, z: pin.z } : null
          });
        }
        const r = origDrop(ownerId);
        if (isHost() && !_applyingFlagNet) broadcastFlags();
        return r;
      };
    }

    const origPickup = F.tryPickup.bind(F);
    F.tryPickup = function (flagTeam, carrierId) {
      if (isMp() && !isHost()) {
        // Bots only run on host — humans propose pickup
        if (String(carrierId).startsWith('bot-')) return false;
        send({
          type: 'ctf-flag-request',
          action: 'pickup',
          flagTeam,
          carrierId,
          fromId: localId()
        });
        // Optimistic local carry for grab feel; host snapshot will correct
        return origPickup(flagTeam, carrierId);
      }
      const ok = origPickup(flagTeam, carrierId);
      if (ok && isHost()) broadcastFlags();
      return ok;
    };

    const origScore = F.tryScore.bind(F);
    F.tryScore = function (carrierId, atTeamBase, evidencePos) {
      if (isMp() && !isHost()) {
        send({
          type: 'ctf-flag-request',
          action: 'score',
          carrierId,
          atTeamBase,
          evidencePos: evidencePos
            ? { x: evidencePos.x, y: evidencePos.y, z: evidencePos.z }
            : null,
          fromId: localId()
        });
        return false; // host scores & broadcasts
      }
      const ok = origScore(carrierId, atTeamBase, evidencePos);
      if (ok && isHost()) broadcastFlags();
      return ok;
    };

    F.broadcastNetState = broadcastFlags;
    F.applyNetState = applyFlagSnapshot;
  }

  function samePlayerId(a, b) {
    if (a == null || b == null) return false;
    if (a === b) return true;
    const n = (x) => String(x).replace(/^player_?/, 'player_');
    return n(a) === n(b);
  }

  function dropFlagForPlayer(ownerId, pin) {
    const F = window.CapVRFlags;
    if (!F || !ownerId) return;
    let dropped = false;
    ['red', 'blue'].forEach((team) => {
      const s = F.state?.[team];
      if (!s?.carrierId || !samePlayerId(s.carrierId, ownerId)) return;
      if (pin && pin.x != null) F.clearCarrier?.(team, pin);
      else F.dropFromOwner?.(ownerId);
      dropped = true;
    });
    if (!dropped) F.dropFromOwner?.(ownerId);
    if (isHost()) broadcastFlags();
  }

  function handleFlagRequest(data) {
    if (!isHost() || !data) return;
    const F = window.CapVRFlags;
    if (!F) return;
    if (data.action === 'pickup') {
      F.tryPickup(data.flagTeam, data.carrierId || data.fromId);
      broadcastFlags();
    } else if (data.action === 'score') {
      // Reject score if carrier is dead on host HP map
      const cid = data.carrierId || data.fromId;
      if (isPlayerDead(cid)) {
        dropFlagForPlayer(cid, data.evidencePos || data.pin || null);
        return;
      }
      F.tryScore(cid, data.atTeamBase, data.evidencePos);
      broadcastFlags();
    } else if (data.action === 'drop') {
      dropFlagForPlayer(data.carrierId || data.fromId, data.pin || null);
    }
  }

  function isPlayerDead(id) {
    if (!id) return false;
    if (samePlayerId(id, localId())) {
      const c = document.querySelector('[capvr-combat]')?.components?.['capvr-combat'];
      if (c && c.alive === false) return true;
    }
    const hp = _playerHp[id];
    if (hp === 0) return true;
    // Normalize keys
    const n = String(id).replace(/^player_?/, 'player_');
    if (_playerHp[n] === 0) return true;
    return false;
  }

  function notifyDeathFlagDrop(ownerId) {
    if (!ownerId || !isMp()) return;
    const F = window.CapVRFlags;
    const pin = F?._worldPosForOwner?.(ownerId) || null;
    if (isHost()) {
      dropFlagForPlayer(ownerId, pin);
      return;
    }
    // Client: dropFromOwner wrapper sends ctf-flag-request drop + clears locally
    F?.dropFromOwner?.(ownerId);
  }

  function patchCombatAuthority() {
    const C = window.CapVRCombat;
    if (!C || C._capvrMpPatched) return;
    C._capvrMpPatched = true;

    const origDamageBot = C.damageBot;
    C.damageBot = function (owner, amount, opts) {
      if (isMp() && !isHost()) {
        // Client proposes; host applies. Still allow local hit spark via caller.
        send({
          type: 'damage-dealt',
          targetId: owner,
          damage: amount,
          attackerId: localId(),
          point: opts?.point ? {
            x: opts.point.x, y: opts.point.y, z: opts.point.z
          } : null,
          regionId: opts?.regionId || null,
          dir: opts?.dir ? {
            x: opts.dir.x, y: opts.dir.y, z: opts.dir.z
          } : null
        });
        return false;
      }
      return origDamageBot.call(this, owner, amount, opts || {});
    };

    // Avoid double-propose: fire() also calls syncDamageDealt after limb hits
    const origSyncDmg = C.syncDamageDealt;
    if (typeof origSyncDmg === 'function') {
      C.syncDamageDealt = function (targetId, damage, attackerId) {
        if (isMp() && !isHost()) return;
        return origSyncDmg.call(this, targetId, damage, attackerId);
      };
    } else {
      // syncDamageDealt is closed-over in combat — limb/fire paths already gated
    }

    const origApplyDamage = C.applyRemoteDamage;
    C.applyRemoteDamage = function (data) {
      if (!data?.targetId) return;
      if (isMp() && !isHost()) return;
      // Host already applied own shots — skip echo unless forced
      if (data.attackerId && data.attackerId === localId() && !data.force && !data.sticky) return;

      const tid = data.targetId;
      const dmg = data.damage || C.LASER_DAMAGE || 16;

      // Laser HP requires a shot origin — blocks phantom damage-dealt
      if (!data.sticky && !data.from) {
        console.warn('[CapVRMp] ignored laser damage without from', tid);
        return;
      }

      // Ignore damage to unconnected remotes (ghost slots)
      if (String(tid).startsWith('player_')
          && !samePlayerId(tid, localId())
          && G().isPlayerConnected
          && !G().isPlayerConnected(tid)) {
        return;
      }

      // Sticky splash: only apply if target is near the blast
      if (data.stickySplash && data.point) {
        const maxR = 2.4;
        let pos = null;
        if (samePlayerId(tid, localId()) || tid === 'player' || tid === 'rig') {
          const p = document.querySelector('#player');
          if (p?.object3D) {
            pos = new THREE.Vector3();
            p.object3D.getWorldPosition(pos);
          }
        } else if (String(tid).startsWith('player_')) {
          const idx = String(tid).replace(/^player_?/, '');
          const parent = document.getElementById(`remote-player-${idx}`);
          const el = document.getElementById(`remote-target-${idx}`) || parent;
          if (parent && (parent.getAttribute('visible') === false
              || parent.getAttribute('visible') === 'false')) return;
          if (el?.object3D) {
            pos = new THREE.Vector3();
            el.object3D.getWorldPosition(pos);
          }
        } else if (C.botState?.[tid] || String(tid).startsWith('bot-')) {
          const botEl = document.getElementById(`zerog-${tid}`) || document.getElementById(tid);
          if (botEl?.body?.position) {
            pos = new THREE.Vector3(botEl.body.position.x, botEl.body.position.y, botEl.body.position.z);
          } else if (botEl?.object3D) {
            pos = new THREE.Vector3();
            botEl.object3D.getWorldPosition(pos);
          }
        }
        if (!pos) return;
        const d = Math.hypot(pos.x - data.point.x, pos.y - data.point.y, pos.z - data.point.z);
        if (d > maxR) return;
      }

      const shotFrom = data.from || (data.sticky ? data.point : null);
      const shotTo = data.to || data.point || null;

      if (tid === localId() || tid === 'player' || tid === 'rig') {
        const c = document.querySelector('[capvr-combat]')?.components?.['capvr-combat'];
        c?._hurt?.(dmg, {
          fromTeam: data.attackerId,
          from: shotFrom,
          to: shotTo,
          point: data.point || shotTo,
          sticky: !!data.sticky
        });
        return;
      }

      if (String(tid).startsWith('bot-') || C.botState?.[tid]) {
        const bodyEl = document.getElementById(`${tid}-body`);
        const point = data.point
          ? new THREE.Vector3(data.point.x, data.point.y, data.point.z)
          : null;
        origDamageBot.call(C, tid, dmg, {
          bodyEl,
          point,
          regionId: data.regionId,
          dir: data.dir
            ? new THREE.Vector3(data.dir.x, data.dir.y, data.dir.z)
            : new THREE.Vector3(0, -1, 0)
        });
        return;
      }

      if (String(tid).startsWith('player_')) {
        let hp = ensurePlayerHp(tid);
        hp = Math.max(0, hp - dmg);
        _playerHp[tid] = hp;
        const dead = hp <= 0;
        send({
          type: 'health-sync',
          entityId: tid,
          currentHealth: hp,
          maxHealth: C.MAX_HP || 100,
          isDead: dead,
          point: data.point || shotTo || null,
          from: shotFrom || null,
          to: shotTo || null,
          sticky: !!data.sticky,
          attackerId: data.attackerId || null
        });
        // Also show the beam on peers immediately
        if (shotFrom && shotTo && !data.sticky) {
          send({
            type: 'weapon-fired',
            playerId: data.attackerId || 'bot',
            startX: shotFrom.x, startY: shotFrom.y, startZ: shotFrom.z,
            endX: shotTo.x, endY: shotTo.y, endZ: shotTo.z,
            color: '#ff6655'
          });
        }
        if (tid === localId()) {
          const c = document.querySelector('[capvr-combat]')?.components?.['capvr-combat'];
          c?._hurt?.(dmg, {
            fromTeam: data.attackerId,
            from: shotFrom,
            to: shotTo,
            point: data.point || shotTo,
            sticky: !!data.sticky
          });
        }
        if (dead) dropFlagForPlayer(tid, data.point || null);
      }
    };

    const combatProto = AFRAME.components['capvr-combat']?.Component?.prototype;
    if (combatProto?.applyHealthSync && !combatProto._capvrMpHealth) {
      combatProto._capvrMpHealth = true;
      const origHS = combatProto.applyHealthSync;
      combatProto.applyHealthSync = function (data) {
        if (!data?.entityId) return;
        const id = data.entityId;
        const wasLocalAlive = this.alive;
        const wasBotAlive = C.botState?.[id] ? C.botState[id].alive : null;

        origHS.call(this, data);

        if (id === localId() || id === 'player' || id === 'rig') {
          if (wasLocalAlive && !this.alive) {
            // Death FX / stun handled in combat.applyHealthSync; still net-drop flag
            notifyDeathFlagDrop(localId());
            document.dispatchEvent(new CustomEvent('combatant-died', {
              detail: { id: localId() }
            }));
          }
          if (!wasLocalAlive && this.alive && data.currentHealth > 0) {
            this._lastDamageAt = 0;
          }
          _playerHp[localId()] = this.localHp;
          return;
        }

        // Host: any player_* death in health-sync drops their flag for all
        if (String(id).startsWith('player_') && data.isDead && isHost()) {
          _playerHp[id] = 0;
          dropFlagForPlayer(id, data.point || null);
        }

        if (C.botState?.[id]) {
          if (data.isDead && wasBotAlive) {
            // Avoid re-entrant host killBot; clients need death ragdoll
            if (!isHost()) {
              C.killBot?.(id, {
                point: data.point
                  ? new THREE.Vector3(data.point.x, data.point.y, data.point.z)
                  : null
              });
            }
          } else if (!data.isDead && wasBotAlive === false && (data.currentHealth || 0) > 0) {
            if (!isHost()) C.placeBot?.(id);
          }
        }

        if (String(id).startsWith('player_')) {
          _playerHp[id] = data.currentHealth;
        }
      };
    }

    // Local human HP broadcasts update host map
    const origHurt = combatProto?._hurt;
    if (origHurt && !combatProto._capvrMpHurt) {
      combatProto._capvrMpHurt = true;
      combatProto._hurt = function (n, detail) {
        const wasAlive = this.alive;
        origHurt.call(this, n, detail);
        _playerHp[localId()] = this.localHp;
        if (wasAlive && !this.alive) notifyDeathFlagDrop(localId());
      };
    }

    // Sticky blast: clients propose damage; host applies + fans out VFX
    if (combatProto?._onStickyBlast && !combatProto._capvrMpSticky) {
      combatProto._capvrMpSticky = true;
      const origSticky = combatProto._onStickyBlast;
      combatProto._onStickyBlast = function (detail) {
        if (detail?._mpVisualOnly) {
          playStickyVfx(detail);
          return;
        }
        // Clients never authority-boom (host fuse / failsafe path)
        if (isMp() && !isHost()) {
          playStickyVfx(detail);
          return;
        }
        const ballId = detail.ballEl?.id || detail.ballId || 'ball';
        _stickyDmgBallAt[ballId] = performance.now();
        origSticky.call(this, detail);
        if (isMp() && isHost()) {
          broadcastStickyDetonate(detail);
        }
      };
    }
  }

  // —— Sticky bomb net ——
  const _stickyBoomKeys = new Set();
  const STICKY_ATTACH_DMG = () => window.CapVRCombat?.STICKY_ATTACH_DAMAGE || 48;
  const STICKY_SPLASH_DMG = () => window.CapVRCombat?.STICKY_SPLASH_DAMAGE || 16;

  function resolveStickyTargetEl(data) {
    if (!data) return null;
    if (data.targetPlayerId && samePlayerId(data.targetPlayerId, localId())) {
      return document.querySelector('#player');
    }
    if (data.targetId === 'player' || data.targetId === 'rig') {
      if (data.targetPlayerId && !samePlayerId(data.targetPlayerId, localId())) {
        const idx = String(data.targetPlayerId).replace(/^player_?/, '');
        return document.getElementById(`remote-target-${idx}`)
          || document.getElementById(`remote-player-${idx}`);
      }
      return document.querySelector('#player');
    }
    if (data.targetId) {
      return document.getElementById(data.targetId)
        || document.querySelector(`#${data.targetId}`);
    }
    return null;
  }

  function playerIdFromStickyTarget(targetId, explicit) {
    if (explicit) return explicit;
    if (!targetId) return null;
    if (targetId === 'player' || targetId === 'rig') return localId();
    const m = String(targetId).match(/remote-(?:target|player)-(\d+)/);
    if (m) return `player_${m[1]}`;
    return null;
  }

  function applyStickyAttach(data) {
    if (!data?.ballId) return;
    const ball = document.getElementById(data.ballId);
    const bc = ball?.components?.['zerog-ball'];
    if (!bc) return;
    if (bc._sticky && bc._sticky._netKey === data.netKey) return;
    const targetEl = resolveStickyTargetEl(data);
    if (!targetEl) return;
    const off = data.offset || { x: 0, y: 0.2, z: 0 };
    bc._sticky = {
      targetEl,
      offset: new THREE.Vector3(off.x, off.y, off.z),
      fuseStart: data.fuseStart || performance.now(),
      nextBeep: performance.now() + 180,
      throwerId: data.throwerId || null,
      targetPlayerId: data.targetPlayerId || null,
      _netKey: data.netKey || `${data.ballId}:${data.fuseStart}`,
      _fromNet: true
    };
    bc._capvrThrownAt = 0;
  }

  function playStickyVfx(detail) {
    const pos = detail?.position;
    if (!pos) return;
    const p = pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z);
    try {
      const scene = document.querySelector('a-scene');
      if (scene) {
        const flash = document.createElement('a-sphere');
        flash.setAttribute('radius', 0.55);
        flash.setAttribute('color', '#ff8800');
        flash.setAttribute('material', 'emissive: #ff4400; emissiveIntensity: 2; opacity: 0.75; transparent: true');
        flash.setAttribute('position', `${p.x} ${p.y} ${p.z}`);
        scene.appendChild(flash);
        setTimeout(() => flash.remove(), 220);
      }
    } catch (e) { /* */ }
    const boom = document.querySelector('#bounce-sound');
    if (boom?.components?.sound) {
      try {
        boom.setAttribute('position', `${p.x} ${p.y} ${p.z}`);
        boom.components.sound.stopSound?.();
        boom.components.sound.playSound?.();
      } catch (e2) { /* */ }
    }
  }

  function clearStickyOnBall(ballId) {
    const ball = ballId && document.getElementById(ballId);
    const bc = ball?.components?.['zerog-ball'];
    if (bc) {
      bc._sticky = null;
      bc._capvrThrownAt = 0;
    }
  }

  function broadcastStickyDetonate(detail) {
    const pos = detail?.position;
    if (!pos) return;
    const key = `${detail.ballEl?.id || detail.ballId || 'ball'}:${detail.fuseStart || 0}`;
    if (_stickyBoomKeys.has(key)) return;
    _stickyBoomKeys.add(key);
    send({
      type: 'sticky-detonate',
      ballId: detail.ballEl?.id || detail.ballId || null,
      targetId: detail.targetId || null,
      targetPlayerId: detail.targetPlayerId || playerIdFromStickyTarget(detail.targetId),
      attackerId: detail.attackerId || localId(),
      fuseStart: detail.fuseStart || 0,
      netKey: key,
      position: { x: pos.x, y: pos.y, z: pos.z },
      fromId: localId()
    });
  }

  function proposeStickyDamage(detail) {
    const pos = detail?.position;
    if (!pos) return;
    const center = { x: pos.x, y: pos.y, z: pos.z };
    const attach = STICKY_ATTACH_DMG();
    const splash = STICKY_SPLASH_DMG();
    const attackerId = detail.attackerId || localId();
    const tid = detail.targetId || '';
    const pid = playerIdFromStickyTarget(tid, detail.targetPlayerId);

    if (pid) {
      send({
        type: 'damage-dealt',
        targetId: pid,
        damage: attach,
        attackerId,
        sticky: true,
        force: true,
        point: center,
        from: center
      });
    } else if (String(tid).startsWith('zerog-') || String(tid).startsWith('bot-')) {
      const botOwner = String(tid).replace(/^zerog-/, '');
      send({
        type: 'damage-dealt',
        targetId: botOwner,
        damage: attach,
        attackerId,
        sticky: true,
        force: true,
        point: center
      });
    }

    // Splash proposes (host validates range loosely by applying)
    for (let i = 0; i < 4; i++) {
      const p = `player_${i}`;
      if (pid && samePlayerId(p, pid)) continue;
      send({
        type: 'damage-dealt',
        targetId: p,
        damage: splash,
        attackerId,
        sticky: true,
        stickySplash: true,
        point: center
      });
    }
    ['bot-red', 'bot-blue', 'bot-green'].forEach((owner) => {
      if (tid === `zerog-${owner}` || tid === owner) return;
      send({
        type: 'damage-dealt',
        targetId: owner,
        damage: splash,
        attackerId,
        sticky: true,
        stickySplash: true,
        point: center
      });
    });

    send({
      type: 'sticky-detonate',
      ballId: detail.ballEl?.id || detail.ballId || null,
      targetId: tid,
      targetPlayerId: pid,
      attackerId,
      position: center,
      fuseStart: detail.fuseStart || 0,
      visualOnly: true,
      fromId: localId()
    });
  }

  const _stickyDmgBallAt = Object.create(null);

  function applyStickyDamageHost(data) {
    const C = window.CapVRCombat;
    if (!C || !data?.position) return;
    const ballId = data.ballId || 'ball';
    const now = performance.now();
    // Host fuse + client failsafe can race — one boom per ball per 2s
    if (_stickyDmgBallAt[ballId] && now - _stickyDmgBallAt[ballId] < 2000) return;
    const key = data.netKey || `${ballId}:${data.fuseStart || 0}:dmg`;
    if (_stickyBoomKeys.has(key)) return;
    _stickyBoomKeys.add(key);
    _stickyDmgBallAt[ballId] = now;
    const center = data.position;
    const attach = STICKY_ATTACH_DMG();
    const splash = STICKY_SPLASH_DMG();
    const attackerId = data.attackerId || data.fromId || 'sticky';
    const pid = data.targetPlayerId || playerIdFromStickyTarget(data.targetId);
    const tid = data.targetId || '';

    if (pid) {
      C.applyRemoteDamage?.({
        targetId: pid,
        damage: attach,
        attackerId,
        sticky: true,
        force: true,
        point: center,
        from: center
      });
    } else if (String(tid).startsWith('zerog-') || String(tid).startsWith('bot-')) {
      const botOwner = String(tid).replace(/^zerog-/, '');
      C.applyRemoteDamage?.({
        targetId: botOwner,
        damage: attach,
        attackerId,
        sticky: true,
        force: true,
        point: center,
        from: center
      });
    }

    for (let i = 0; i < 4; i++) {
      const p = `player_${i}`;
      if (pid && samePlayerId(p, pid)) continue;
      if (G().isPlayerConnected && !G().isPlayerConnected(p) && !samePlayerId(p, localId())) continue;
      C.applyRemoteDamage?.({
        targetId: p,
        damage: splash,
        attackerId,
        sticky: true,
        stickySplash: true,
        force: true,
        point: center,
        from: center
      });
    }
    ['bot-red', 'bot-blue', 'bot-green'].forEach((owner) => {
      if (tid === `zerog-${owner}` || tid === owner) return;
      C.applyRemoteDamage?.({
        targetId: owner,
        damage: splash,
        attackerId,
        sticky: true,
        stickySplash: true,
        force: true,
        point: center,
        from: center
      });
    });
  }

  function handleStickyDetonateNet(data) {
    if (!data) return;
    const key = data.netKey || `${data.ballId}:${data.fuseStart || 0}`;
    const already = _stickyBoomKeys.has(key);
    if (!already) _stickyBoomKeys.add(key);
    clearStickyOnBall(data.ballId);
    if (!already || data.visualOnly) playStickyVfx(data);

    // Client failsafe / peer boom: host applies damage once
    if (isHost() && data.fromId && data.fromId !== localId()) {
      applyStickyDamageHost(data);
      // Fan-out authoritative VFX/clear to everyone else
      send({
        type: 'sticky-detonate',
        ballId: data.ballId,
        targetId: data.targetId,
        targetPlayerId: data.targetPlayerId,
        attackerId: data.attackerId,
        fuseStart: data.fuseStart,
        netKey: key,
        position: data.position,
        fromId: localId()
      });
    }
  }

  function handleStickyAttachNet(data) {
    applyStickyAttach(data);
  }

  function installStickyNet() {
    if (window._capvrStickyNet) return;
    window._capvrStickyNet = true;

    document.addEventListener('sticky-bomb-attach', (e) => {
      if (!isMp()) return;
      const d = e.detail || {};
      if (d._fromNet) return;
      const msg = {
        type: 'sticky-attach',
        ballId: d.ballId,
        targetId: d.targetId,
        targetPlayerId: d.targetPlayerId || playerIdFromStickyTarget(d.targetId),
        throwerId: d.throwerId || localId(),
        fuseStart: d.fuseStart || performance.now(),
        offset: d.offset || { x: 0, y: 0.2, z: 0 },
        netKey: d.netKey || `${d.ballId}:${d.fuseStart}`,
        fromId: localId()
      };
      send(msg);
      // Host already has local sticky; clients need host to have it for fuse authority
    });

    document.addEventListener('sticky-bomb-unstick', (e) => {
      if (!isMp()) return;
      const d = e.detail || {};
      send({ type: 'sticky-unstick', ballId: d.ballId, fromId: localId() });
    });
  }

  /** Sphere hit-test remotes for PvP lasers. */
  function raycastRemotePlayers(origin, dir, maxDist) {
    let best = null;
    let bestDist = maxDist;
    for (let i = 0; i < 4; i++) {
      const pid = `player_${i}`;
      if (pid === localId()) continue;
      if (G().isPlayerConnected && !G().isPlayerConnected(pid)) continue;
      const parent = document.getElementById(`remote-player-${i}`);
      const el = document.getElementById(`remote-target-${i}`) || parent;
      if (!el?.object3D || !parent) continue;
      const pVis = parent.getAttribute('visible');
      if (pVis === false || pVis === 'false') continue;
      // Skip if not connected — opaque hidden remotes
      const mat = el.getAttribute('material');
      if (mat && (mat.opacity === 0 || mat.opacity === '0')) continue;
      const center = new THREE.Vector3();
      el.object3D.getWorldPosition(center);
      // Sphere radius ~0.45 (head/body proxy)
      const radius = 0.55;
      const to = center.clone().sub(origin);
      const t = to.dot(dir);
      if (t < 0.2 || t > bestDist) continue;
      const closest = origin.clone().addScaledVector(dir, t);
      const lateral = closest.distanceTo(center);
      if (lateral > radius) continue;
      const hitDist = Math.max(0.2, t - Math.sqrt(Math.max(0, radius * radius - lateral * lateral)));
      if (hitDist < bestDist) {
        bestDist = hitDist;
        best = {
          playerId: pid,
          point: origin.clone().addScaledVector(dir, hitDist),
          distance: hitDist
        };
      }
    }
    return best;
  }

  function patchPlayerFire() {
    const combatProto = AFRAME.components['capvr-combat']?.Component?.prototype;
    if (!combatProto?.fire || combatProto._capvrMpFire) return;
    combatProto._capvrMpFire = true;
    const origFire = combatProto.fire;
    combatProto.fire = function () {
      // Run original first if not a dual path — instead wrap result via pre-check after aim
      if (!this.alive || !this._aim()) return;
      if (performance.now() < this._nextFireAt) return;

      const remoteHit = raycastRemotePlayers(this._ori, this._dir, 120);
      const envHit = window.CapVRCombat?.castEnvRay?.(this._ori, this._dir, 120);
      const envDist = envHit ? envHit.distance : 120;

      if (remoteHit && remoteHit.distance < envDist - 0.05) {
        this._nextFireAt = performance.now() + 280;
        const C = window.CapVRCombat;
        C?.spawnLaserVisuals?.(this._ori, remoteHit.point, { hit: true, color: '#00ffff' });
        send({
          type: 'weapon-fired',
          playerId: localId(),
          startX: this._ori.x, startY: this._ori.y, startZ: this._ori.z,
          endX: remoteHit.point.x, endY: remoteHit.point.y, endZ: remoteHit.point.z,
          color: '#00ffff'
        });
        send({
          type: 'damage-dealt',
          targetId: remoteHit.playerId,
          damage: C?.LASER_DAMAGE || 16,
          attackerId: localId(),
          point: {
            x: remoteHit.point.x, y: remoteHit.point.y, z: remoteHit.point.z
          },
          from: { x: this._ori.x, y: this._ori.y, z: this._ori.z }
        });
        // Listen-server host must apply locally (sendCombatMsg does not echo to self)
        if (isHost()) {
          C?.applyRemoteDamage?.({
            targetId: remoteHit.playerId,
            damage: C.LASER_DAMAGE || 16,
            attackerId: localId(),
            force: true,
            point: {
              x: remoteHit.point.x, y: remoteHit.point.y, z: remoteHit.point.z
            },
            from: { x: this._ori.x, y: this._ori.y, z: this._ori.z }
          });
        }
        return;
      }

      return origFire.call(this);
    };

    // Clients: propose bot damage via wrapped damageBot (no double local apply)
    if (combatProto._onLimbHit && !combatProto._capvrMpLimb) {
      combatProto._capvrMpLimb = true;
      const origLimb = combatProto._onLimbHit;
      combatProto._onLimbHit = function (detail) {
        if (isMp() && !isHost()) {
          const botId = detail?.el?.dataset?.botId;
          if (!botId) return;
          const owner = botId.replace('zerog-', '');
          // Visual shred only; HP/kill is host-authoritative via damageBot → damage-dealt
          if (detail.point) {
            const grab = detail.el?.components?.['grabbable-ragdoll'];
            try {
              grab?.shatterFromShot?.(
                detail.point.clone(),
                (detail.dir || new THREE.Vector3(0, 1, 0)).clone().negate(),
                detail.dir || new THREE.Vector3(0, -1, 0),
                1,
                detail.regionId || null,
                { allowCollapse: false }
              );
            } catch (e) { /* */ }
          }
          window.CapVRCombat?.damageBot?.(owner, detail.damage || 16, {
            bodyEl: detail.el,
            point: detail.point,
            dir: detail.dir,
            regionId: detail.regionId
          });
          return;
        }
        return origLimb.call(this, detail);
      };
    }
  }

  function patchBotFireSync() {
    // Host bot lasers: ensure weapon-fired + player damage for remotes
    document.addEventListener('capvr-laser', (e) => {
      if (!isMp() || !isHost()) return;
      const d = e.detail || {};
      if (d.skipNet || d.skipVisual === false && d.silent) { /* */ }
      if (!d.from || !d.to) return;
      // Only sync if it looks like a bot team laser
      if (!d.team) return;
      send({
        type: 'weapon-fired',
        playerId: `bot-${d.team}`,
        startX: d.from.x, startY: d.from.y, startZ: d.from.z,
        endX: d.to.x, endY: d.to.y, endZ: d.to.z,
        color: d.color || '#ff6655'
      });
    });
  }

  function patchBotPlayerTargeting() {
    // Extend CTF bot targeting to remote humans (runs when ctf patches fireAt)
    const tryPatch = () => {
      const F = window.CapVRFlags;
      if (!F || F._capvrMpTargets) return;
      // Targeting is inside IIFE in ctf-rules — use DOM event for remote player shot instead
      F._capvrMpTargets = true;
    };
    tryPatch();

    document.addEventListener('local-player-shot', (e) => {
      // Host: if the "local" listener is host but bot aimed at host, already handled.
      // When bot AI needs to hurt a remotesee damage via host routing below.
    });
  }

  /** Host: map bot shots that should hit remote players (position-based). */
  function installBotRemoteDamage() {
    if (window._capvrBotRemoteDmg) return;
    window._capvrBotRemoteDmg = true;
    const origDispatch = document.dispatchEvent.bind(document);
    // Hook is too invasive — instead poll in fireAt by patching after CTF loads via custom event
    document.addEventListener('capvr-bot-player-hit', (e) => {
      if (!isHost() || !isMp()) return;
      const d = e.detail || {};
      if (!d.playerId || d.playerId === localId()) return;
      window.CapVRCombat?.applyRemoteDamage?.({
        targetId: d.playerId,
        damage: d.damage || 16,
        attackerId: d.fromTeam || 'bot',
        point: d.point,
        from: d.from
      });
    });
  }

  function onCombatMessage(data) {
    if (!data?.type) return false;
    switch (data.type) {
      case 'ctf-flag-state':
        if (!isHost()) applyFlagSnapshot(data);
        return true;
      case 'ctf-flag-request':
        if (isHost()) handleFlagRequest(data);
        return true;
      case 'sticky-attach':
        handleStickyAttachNet(data);
        return true;
      case 'sticky-detonate':
        handleStickyDetonateNet(data);
        return true;
      case 'sticky-unstick':
        clearStickyOnBall(data.ballId);
        return true;
      case 'damage-dealt':
        // Host applies (index.html also calls applyRemoteDamage) — ensure idempotent
        return false; // let index.html handler run
      case 'health-sync':
        if (data.entityId) {
          _playerHp[data.entityId] = data.currentHealth;
          if (data.isDead && isHost()) {
            dropFlagForPlayer(data.entityId, data.point || null);
          }
        }
        return false;
      default:
        return false;
    }
  }

  window.CapVRMp = {
    isMp,
    isHost,
    isPlayerDead,
    broadcastFlags,
    applyFlagSnapshot,
    onCombatMessage,
    raycastRemotePlayers,
    ensurePlayerHp,
    notifyDeathFlagDrop,
    applyStickyAttach,
    sendFlagStateToJoiner() {
      if (!isHost()) return null;
      const flags = flagSnapshot();
      const scores = G().teamScores || { red: 0, blue: 0 };
      return {
        type: 'ctf-flag-state',
        flags,
        scores: { red: scores.red || 0, blue: scores.blue || 0 }
      };
    }
  };

  function boot() {
    patchFlags();
    patchCombatAuthority();
    patchPlayerFire();
    patchBotFireSync();
    patchBotPlayerTargeting();
    installBotRemoteDamage();
    installStickyNet();
    console.log('[CapVR] multiplayer glue ready (CTF death-drop + sticky net)');
  }

  // Retry until CapVRFlags + CapVRCombat exist
  let tries = 0;
  function waitBoot() {
    tries += 1;
    if (window.CapVRFlags && window.CapVRCombat && AFRAME?.components?.['capvr-combat']) {
      boot();
      return;
    }
    if (tries < 40) setTimeout(waitBoot, 250);
  }
  if (document.querySelector('a-scene')?.hasLoaded) waitBoot();
  else document.querySelector('a-scene')?.addEventListener('loaded', waitBoot, { once: true });
})();
