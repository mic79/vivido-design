/**
 * CapVR boot — gravity lock, sticky stick/beep/yank/boom, hand aliases, honest checklist.
 */
(function () {
  'use strict';

  const EXPECTED = [
    'Box3D-only physics (Cannon shim → Box3D)',
    'BoltVR UI / menu / MP / Mixamo bots / arenas',
    'body-rigged4 hands ↔ bot bodies (palm slide + capsule push)',
    'shoot + limb shatter + full bot reset on respawn',
    'CTF dual flags — grab enemy, score at YOUR goal if own flag HOME',
    'Sticky bombs: stick → beep → yank (re-grab) → boom',
    'Death drops flag + timed respawn (player + bots)',
    'CTF bot AI: attack / defend / recover / escort + strafe fire',
    'Health HUD + world bars + kill-shot linger (BattleVR-style)',
    'Laser/impact SFX (synthesized — BattleVR has no weapon overheat)',
    'Sticky: intentional throw only; attach = ~3 laser hits',
    'Bot Box3D head/torso collide (arena walls, not just grab-surface)',
    'Bot body = grabbable-ragdoll (ZeroGLegs loco + hit react + limb shatter)',
    'Lean Box3D host [capvr-physics] — no leg-ik-world / ground IK',
    'Combat: shatter only via HP; full collapse at 0 (no mesh/AI desync)',
    'Flags: no throw on drop; kinematic pin home/drop; match combat reset',
    'Local body tint follows YOUR team (not forced blue)'
  ];

  let _booted = false;

  function aliasHands() {
    const lh = document.getElementById('leftHand') || document.getElementById('left-hand');
    const rh = document.getElementById('rightHand') || document.getElementById('right-hand');
    if (lh && lh.id !== 'leftHand') lh.id = 'leftHand';
    if (rh && rh.id !== 'rightHand') rh.id = 'rightHand';
  }

  const _gebi = document.getElementById.bind(document);
  document.getElementById = function (id) {
    if (id === 'leftHand' || id === 'left-hand') return _gebi('leftHand') || _gebi('left-hand');
    if (id === 'rightHand' || id === 'right-hand') return _gebi('rightHand') || _gebi('right-hand');
    return _gebi(id);
  };

  const _qs = document.querySelector.bind(document);
  document.querySelector = function (sel) {
    if (sel === '#leftHand' || sel === '#left-hand') return _gebi('leftHand') || _gebi('left-hand') || _qs(sel);
    if (sel === '#rightHand' || sel === '#right-hand') return _gebi('rightHand') || _gebi('right-hand') || _qs(sel);
    return _qs(sel);
  };

  function lockZeroG() {
    if (window.BodyRiggedGravity) {
      window.BodyRiggedGravity.allowSwitch = false;
      window.BodyRiggedGravity.setMode('zerog', { force: true });
    }
  }

  function loadArenaThree() {
    // Backup if ArenaManager.init did not finish default load
    const tryLoad = () => {
      if (!window.ArenaManager?.loadOfficialArena) {
        setTimeout(tryLoad, 400);
        return;
      }
      if (typeof ArenaManager.loadCapVRDefaultArena === 'function') {
        ArenaManager.loadCapVRDefaultArena();
        return;
      }
      if (ArenaManager._appliedArenaName && ArenaManager._appliedArenaName !== 'One') return;
      ArenaManager.loadOfficialArena('three').then(() => {
        ArenaManager.updateMenuDisplay?.();
      }).catch(() => {});
    };
    setTimeout(tryLoad, 1800);
  }

  function ensureAudio() {
    if (window._capAudio) return window._capAudio;
    try {
      window._capAudio = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { /* */ }
    return window._capAudio;
  }

  function beepAt(pos, freq, dur) {
    try {
      const ctx = ensureAudio();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume?.();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      g.gain.value = 0.08;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (dur || 0.07));
      o.stop(ctx.currentTime + (dur || 0.08));
    } catch (e) { /* */ }
  }

  function unstickBall(bc) {
    if (!bc?._sticky) return false;
    bc._sticky = null;
    bc.isGrabbed = false;
    if (bc.body) {
      try {
        bc.body.wakeUp?.();
      } catch (e) { /* */ }
    }
    return true;
  }

  function patchStickyBombs() {
    const comp = AFRAME.components['zerog-ball'];
    if (!comp?.Component?.prototype || comp.Component.prototype._capvrSticky4) return;
    const proto = comp.Component.prototype;
    proto._capvrSticky4 = true;
    proto._sticky = null;

    function localOwnerId() {
      return window.CapVRGame?.myPlayerId || 'player_0';
    }

    function ownerTeam(ownerId) {
      if (!ownerId) return null;
      if (String(ownerId).startsWith('bot-')) {
        const bot = document.getElementById(`zerog-${ownerId}`);
        return bot?.components?.['zerog-bot']?.data?.team || null;
      }
      return window.CapVRGame?.playerTeams?.get?.(ownerId)
        || window.CapVRGame?.playerTeams?.get?.(localOwnerId())
        || null;
    }

    function targetTeam(el) {
      if (!el) return null;
      if (el.id === 'player' || el.id === 'rig') {
        return ownerTeam(localOwnerId());
      }
      if (el.id?.startsWith('zerog-bot')) {
        return el.components?.['zerog-bot']?.data?.team || null;
      }
      return null;
    }

    function canArmSticky(bc) {
      if (!bc || bc._sticky || bc.isGrabbed) return false;
      if (bc.isCaptureBall || bc.isCtfFlag) return false;
      if (String(bc.data?.player || '').startsWith('flag-')) return false;
      if (bc.ballState && bc.ballState !== 'FREE') return false;
      if (bc.tractorBeamActive || bc.autoReturnActive) return false;
      // Only intentional throws within a short arm window (set onRelease).
      if (!bc._capvrThrownAt || (performance.now() - bc._capvrThrownAt) > 2800) return false;
      return true;
    }

    const origTick = proto.tick;
    proto.tick = function (t, dt) {
      if (this._sticky) {
        const s = this._sticky;
        if (!s.targetEl?.object3D) {
          this._sticky = null;
          return;
        }
        const tp = new THREE.Vector3();
        if (s.targetEl.body?.position) {
          tp.set(s.targetEl.body.position.x, s.targetEl.body.position.y + 1, s.targetEl.body.position.z);
        } else {
          s.targetEl.object3D.getWorldPosition(tp);
          tp.y += 1;
        }
        tp.add(s.offset);
        this.el.object3D.position.copy(tp);
        if (this.body) {
          this.body.position.set(tp.x, tp.y, tp.z);
          this.body.velocity.set(0, 0, 0);
          this.body.angularVelocity?.set?.(0, 0, 0);
        }
        const elapsed = performance.now() - s.fuseStart;
        const progress = Math.min(1, elapsed / 3500);
        if (performance.now() >= s.nextBeep) {
          s.nextBeep = performance.now() + (420 - progress * 330);
          beepAt(tp, 900 + progress * 700, 0.07);
        }
        if (elapsed >= 3500) {
          const blast = tp.clone();
          const targetId = s.targetEl.id;
          const targetPlayerId = s.targetPlayerId || null;
          const attackerId = s.throwerId || null;
          const fuseStart = s.fuseStart;
          const mp = window.CapVRMp;
          // Clients: host owns the boom (avoid double damage). Failsafe request if host late.
          if (mp?.isMp?.() && !mp?.isHost?.()) {
            if (!s._askedBoom) {
              s._askedBoom = true;
              try {
                window.CapVRGame?.sendCombatMsg?.({
                  type: 'sticky-detonate',
                  visualOnly: true,
                  ballId: this.el.id,
                  targetId,
                  targetPlayerId,
                  attackerId,
                  fuseStart,
                  position: { x: blast.x, y: blast.y, z: blast.z },
                  fromId: localOwnerId()
                });
              } catch (e0) { /* */ }
            }
            // Keep glued until host sticky-detonate clears; hard-clear after 1s
            if (elapsed > 4500) {
              this._sticky = null;
              this._capvrThrownAt = 0;
            }
            return;
          }
          this._sticky = null;
          this._capvrThrownAt = 0;
          document.dispatchEvent(new CustomEvent('sticky-bomb-detonate', {
            detail: {
              position: blast,
              ballEl: this.el,
              targetId,
              targetPlayerId,
              attackerId,
              fuseStart
            }
          }));
          try {
            const scene = document.querySelector('a-scene');
            if (scene) {
              const flash = document.createElement('a-sphere');
              flash.setAttribute('radius', 0.55);
              flash.setAttribute('color', '#ff8800');
              flash.setAttribute('material', 'emissive: #ff4400; emissiveIntensity: 2; opacity: 0.75; transparent: true');
              flash.setAttribute('position', `${blast.x} ${blast.y} ${blast.z}`);
              scene.appendChild(flash);
              setTimeout(() => flash.remove(), 220);
            }
          } catch (e) { /* */ }
          beepAt(blast, 120, 0.2);
          if (typeof this.respawnToChestSlot === 'function') {
            setTimeout(() => this.respawnToChestSlot(), 250);
          }
        }
        return;
      }
      if (origTick) origTick.call(this, t, dt);
    };

    // Arm sticky only on intentional release/throw
    const origRelease = proto.onRelease;
    proto.onRelease = function () {
      const ownerBefore = this.currentOwner || localOwnerId();
      const ret = origRelease ? origRelease.apply(this, arguments) : undefined;
      // Capture / flag balls never become stickies
      if (this.isCaptureBall || this.isCtfFlag) return ret;
      const speed = this.body?.velocity?.length?.() || 0;
      if (speed >= 2.8 && this.ballState === 'FREE') {
        this._capvrThrownAt = performance.now();
        this._capvrThrowerId = ownerBefore;
      } else {
        this._capvrThrownAt = 0;
      }
      return ret;
    };

    // Yank: grabbing a stuck bomb unsticks it so you can throw again
    const origGrab = proto.onGrab;
    proto.onGrab = function (hand) {
      if (this._sticky) {
        const ballId = this.el?.id;
        unstickBall(this);
        this._capvrThrownAt = 0;
        beepAt(this.el.object3D.position, 400, 0.05);
        document.dispatchEvent(new CustomEvent('sticky-bomb-unstick', {
          detail: { ballId }
        }));
      }
      return origGrab ? origGrab.call(this, hand) : undefined;
    };

    // Replace any prior sticky poll (false-sticks to self / tractor)
    if (window._capvrStickyPoll) {
      clearInterval(window._capvrStickyPoll);
      window._capvrStickyPoll = null;
    }
    window._capvrStickyPoll = setInterval(() => {
      document.querySelectorAll('[zerog-ball]').forEach((el) => {
        const bc = el.components?.['zerog-ball'];
        if (!canArmSticky(bc)) return;
        const speed = el.body?.velocity?.length?.() || 0;
        if (speed < 3.2) return;
        const bp = el.object3D.position;
        const thrower = bc._capvrThrowerId || null;
        const throwerT = ownerTeam(thrower);
        const targets = [
          document.querySelector('#player'),
          ...document.querySelectorAll('[zerog-bot]'),
          ...document.querySelectorAll('[id^="remote-target-"]')
        ];
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          if (!t || !t.object3D) continue;
          // Never stick to thrower / self
          if (t.id === 'player') {
            if (!thrower || thrower === localOwnerId() || thrower === 'player_0') continue;
            if (throwerT && ownerTeam(localOwnerId()) === throwerT) continue;
          } else if (t.id?.startsWith('zerog-bot')) {
            const botOwner = t.id.replace('zerog-', '');
            if (thrower === botOwner) continue;
            const tt = targetTeam(t);
            if (throwerT && tt && throwerT === tt) continue;
          } else if (t.id?.startsWith('remote-target-')) {
            const idx = t.id.replace('remote-target-', '');
            const pid = `player_${idx}`;
            if (thrower === pid) continue;
            if (throwerT && ownerTeam(pid) === throwerT) continue;
            if (t.getAttribute('visible') === false) continue;
          }
          const tw = new THREE.Vector3();
          if (t.body?.position) tw.set(t.body.position.x, t.body.position.y, t.body.position.z);
          else t.object3D.getWorldPosition(tw);
          if (Math.hypot(bp.x - tw.x, bp.y - tw.y, bp.z - tw.z) < 0.95) {
            const fuseStart = performance.now();
            let targetPlayerId = null;
            if (t.id === 'player') targetPlayerId = localOwnerId();
            else if (t.id?.startsWith('remote-target-')) {
              targetPlayerId = `player_${t.id.replace('remote-target-', '')}`;
            }
            bc._sticky = {
              targetEl: t,
              offset: new THREE.Vector3(bp.x - tw.x, bp.y - (tw.y + 1), bp.z - tw.z),
              fuseStart,
              nextBeep: performance.now() + 180,
              throwerId: thrower,
              targetPlayerId
            };
            bc._capvrThrownAt = 0;
            beepAt(bp, 600, 0.06);
            document.dispatchEvent(new CustomEvent('sticky-bomb-attach', {
              detail: {
                ballId: el.id,
                targetId: t.id,
                targetPlayerId,
                throwerId: thrower,
                fuseStart,
                offset: {
                  x: bc._sticky.offset.x,
                  y: bc._sticky.offset.y,
                  z: bc._sticky.offset.z
                },
                netKey: `${el.id}:${fuseStart}`
              }
            }));
            break;
          }
        }
      });
    }, 90);
  }

  function skipBrokenObstacles() {
    const leg = AFRAME.components['leg-ik-world'];
    if (!leg?.Component?.prototype || leg.Component.prototype._capvrSkipObs) return;
    const proto = leg.Component.prototype;
    proto._capvrSkipObs = true;
    proto._loadReferenceObstacles = async function () {};
  }

  // Bot head/arena collision lives in capvr-bot-fix.js (Box3D resolveSphere).

  function patchLegIkForBoltVRLocomotion() {
    const leg = AFRAME.components['leg-ik-world'];
    if (!leg?.Component?.prototype || leg.Component.prototype._capvrBoltLoco) return;
    const proto = leg.Component.prototype;
    proto._capvrBoltLoco = true;

    proto._capvrFollowBoltPlayer = function () {
      if (!this.physics) return;
      const rig = document.getElementById('rig');
      const player = document.getElementById('player');
      const src = rig || player;
      if (!src?.object3D) return;
      if (!this._capvrTmp) this._capvrTmp = new THREE.Vector3();
      src.object3D.getWorldPosition(this._capvrTmp);
      const feetY = this._capvrTmp.y - 0.95;
      this.physics.setPlayerTranslation(this._capvrTmp.x, feetY, this._capvrTmp.z);
      this.playerGrounded = false;
      this.physics.playerGrounded = false;
      this.playerVelY = 0;
      if (this._playerRootPos) this._playerRootPos.set(this._capvrTmp.x, feetY, this._capvrTmp.z);
      if (this.scene?.legIkWorld) {
        this.scene.legIkWorld.playerRootPos = this._playerRootPos;
        this.scene.legIkWorld.isPlayerGrounded = false;
        this.scene.legIkWorld.playerSpeed = 0;
      }
    };

    proto._syncRigToPhysics = function () { this._capvrFollowBoltPlayer(); };
    proto._recenterPlayer = function (reason) {
      if (reason !== 'origin-jump' && this._applyStandingEyeHeight) this._applyStandingEyeHeight(reason);
      this._capvrFollowBoltPlayer();
      this.scene?.emit?.('vr-recenter', { reason: reason || 'unknown' });
    };
    proto._setVRRigFeetUnderHead = function () {};
    proto._updatePlayerPhysics = function () {
      if (!this.ready || !this.physics || this.ragdollActive) return;
      this._capvrFollowBoltPlayer();
      if (this._resolvePlayerVsGrabDummy) this._resolvePlayerVsGrabDummy(false);
    };

    // CapVR purged #grab-dummy — resolve player body against nearest bot grabbable-ragdoll.
    proto._getGrabDummyRagdoll = function () {
      const player = document.getElementById('player');
      const pp = new THREE.Vector3();
      if (player?.object3D) player.object3D.getWorldPosition(pp);
      else if (this._playerRootPos) pp.copy(this._playerRootPos);
      let best = null;
      let bestD = 4.5 * 4.5;
      document.querySelectorAll('[grabbable-ragdoll]').forEach((el) => {
        if (!el.object3D?.visible) return;
        const c = el.components?.['grabbable-ragdoll'];
        if (!c?.modelLoaded || !c.resolvePlayerCapsuleOnMesh) return;
        const bp = new THREE.Vector3();
        el.object3D.getWorldPosition(bp);
        const d = pp.distanceToSquared(bp);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      });
      return best;
    };

    const origInit = proto._initBox3D;
    if (origInit && !proto._capvrInitPatched) {
      proto._capvrInitPatched = true;
      proto._initBox3D = async function () {
        await origInit.call(this);
        const player = document.getElementById('player');
        if (player?.object3D && this.physics) {
          const p = new THREE.Vector3();
          player.object3D.getWorldPosition(p);
          this.physics.setPlayerTranslation(p.x, p.y - 0.95, p.z);
        }
        const rig = document.getElementById('rig');
        if (rig && Math.abs(rig.object3D.position.z) > 1) {
          rig.object3D.position.set(0, 0, 0);
        }
      };
    }
  }

  function patchGrabSurfaceAllShapes() {
    const comp = AFRAME.components['grab-surface'];
    if (!comp?.Component?.prototype || comp.Component.prototype._capvrAllShapes) return;
    const proto = comp.Component.prototype;
    proto._capvrAllShapes = true;
    const orig = proto.createPhysicsBody;
    proto.createPhysicsBody = function () {
      const geo = this.el.getAttribute('geometry') || {};
      const prim = geo.primitive || (this.el.tagName || '').toLowerCase().replace(/^a-/, '');
      if (prim === 'torus') {
        // Goal rings: visual only (fly-through). Skip colliders on goal children.
        if (this.el.closest?.('#red-goal, #blue-goal') || this.el.hasAttribute('goal-ring')) {
          return;
        }
        const tryBuild = (attempts) => {
          const phys = window.CapVRPhysics?.get?.();
          if (!phys?.addArenaStaticFromEl) {
            if (attempts < 40) setTimeout(() => tryBuild(attempts + 1), 100);
            return;
          }
          if (!this.el.getObject3D('mesh')) {
            if (attempts < 40) setTimeout(() => tryBuild(attempts + 1), 50);
            return;
          }
          if (this.body?._b3Body) return;
          const b3 = phys.addArenaStaticFromEl(this.el, { el: this.el });
          if (!b3) {
            if (attempts < 40) setTimeout(() => tryBuild(attempts + 1), 100);
            return;
          }
          const body = new CANNON.Body({ mass: 0 });
          body._b3Body = b3;
          body.el = this.el;
          this.body = body;
          this.el.body = body;
        };
        tryBuild(0);
        return;
      }
      return orig ? orig.call(this) : undefined;
    };
  }

  /** Never auto-release CTF flags on distance checks / grab-snap. */
  function patchFlagHold() {
    const comp = AFRAME.components['zerog-player'];
    if (!comp?.Component?.prototype || comp.Component.prototype._capvrFlagHold) return;
    const proto = comp.Component.prototype;
    proto._capvrFlagHold = true;

    if (proto.validateGrabDistances) {
      const orig = proto.validateGrabDistances;
      proto.validateGrabDistances = function () {
        ['left', 'right'].forEach((k) => {
          const gi = this.grabInfo?.[k];
          if (gi?.surface?.dataset?.flagTeam || gi?.surface?.components?.['zerog-ball']?.isCtfFlag) {
            gi.isBall = true;
          }
        });
        return orig.call(this);
      };
    }

    // Soften grab-snap auto-release when holding a flag
    if (proto.tick) {
      const origTick = proto.tick;
      proto.tick = function (t, dt) {
        const holdingFlag =
          this.grabbedSurface?.left?.dataset?.flagTeam ||
          this.grabbedSurface?.right?.dataset?.flagTeam;
        if (holdingFlag) this.grabSnapReleaseDist = 99;
        else if (this.grabSnapReleaseDist === 99) this.grabSnapReleaseDist = 0.42;
        return origTick.call(this, t, dt);
      };
    }
  }

  function logChecklist() {
    const phys = window.CapVRPhysics?.get?.();
    console.log('%c[CapVR] Ready', 'color:#5eead4;font-weight:bold');
    EXPECTED.forEach((e) => console.log('  •', e));
    console.log('[CapVR] Runtime:', {
      box3d: !!(phys?.b3 && phys?.world),
      shim: !!window.CapVRCannonShim?.active,
      ctf: !!window.CapVRFlags,
      combat: !!document.querySelector('[capvr-combat]'),
      gravity: window.BodyRiggedGravity?.getMode?.()
    });
  }

  function boot() {
    if (_booted) return;
    _booted = true;
    aliasHands();
    lockZeroG();
    // leg-ik-world removed — Box3D hosted by [capvr-physics]
    patchStickyBombs();
    patchGrabSurfaceAllShapes();
    patchFlagHold();
    loadArenaThree();
    const rebind = () => {
      const mb = document.getElementById('local-body')?.components?.['mixamo-body'];
      if (mb?._resolveControllers) mb._resolveControllers();
    };
    setTimeout(rebind, 500);
    setTimeout(rebind, 2000);
    setTimeout(patchGrabSurfaceAllShapes, 500);
    setTimeout(logChecklist, 2000);
    console.log('[CapVR] boot complete');
  }

  const scene = document.querySelector('a-scene');
  if (scene?.hasLoaded) setTimeout(boot, 200);
  else scene?.addEventListener('loaded', () => setTimeout(boot, 200), { once: true });
})();
