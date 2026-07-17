/**
 * CapVR combat — laser + shatter + health / HUD / deathcam / sticky blast / MP hooks.
 * HP / bars / kill-shot linger patterned after BattleVR (no laser SFX or overheat there either;
 * CapVR adds synthesized fire + impact cues).
 */
(function () {
  'use strict';

  const THREE = (window.AFRAME && window.AFRAME.THREE) || window.THREE;
  // Full arena reach (~80m field) — no soft "stop in air" range under this.
  const MAX_RANGE = 120;
  const MAX_HP = 100;
  const LASER_DAMAGE = 16;       // ~6 lasers to kill (BattleVR-ish durability)
  const STICKY_ATTACH_DAMAGE = 48; // legacy (sticky blast now stuns — kept for MP compat)
  const STICKY_SPLASH_DAMAGE = 16;
  /** Sticky boom stun sphere radius (metres). Attach target + same-team allies inside this. */
  const STICKY_STUN_RADIUS = 2.4;
  /** Sticky boom stun duration (ms) — matches stun-reboot.wav length. */
  const STICKY_STUN_MS = 5000;
  const STICKY_STUN_IMMUNITY_MS = 10000; // after stun ends
  const RESPAWN_MS = 5000;
  const HIT_CREDIT_MS = 250;
  const FIRE_COOLDOWN_MS = 280; // BattleVR hand-weapon ≈ 0.3s (no overheat exists there)
  // BattleVR health-system: regenDelay 5s, regenRate 10 HP/s (players + bots)
  const REGEN_DELAY_MS = 5000;
  const REGEN_RATE = 10;
  const REGEN_SYNC_MS = 450;

  // body == combat mesh (grabbable-ragdoll). ragdoll key kept as alias for older call sites.
  const BOT_MAP = [
    { bot: 'zerog-bot-red', body: 'bot-red-body', ragdoll: 'bot-red-body', team: 'red', owner: 'bot-red' },
    { bot: 'zerog-bot-blue', body: 'bot-blue-body', ragdoll: 'bot-blue-body', team: 'blue', owner: 'bot-blue' },
    { bot: 'zerog-bot-green', body: 'bot-green-body', ragdoll: 'bot-green-body', team: 'blue', owner: 'bot-green' }
  ];

  const botState = {};
  BOT_MAP.forEach(({ owner }) => {
    botState[owner] = {
      alive: true, hp: MAX_HP, maxHp: MAX_HP, respawnAt: 0, lastDamageAt: 0, lastRegenSyncAt: 0
    };
  });

  const healthBars = {}; // owner -> { fg, bg, root }

  function handEl(side) {
    if (side === 'left') return document.getElementById('leftHand') || document.getElementById('left-hand');
    return document.getElementById('rightHand') || document.getElementById('right-hand');
  }

  function localMixamo() {
    return document.getElementById('local-body')?.components?.['mixamo-body'] || null;
  }

  function localId() {
    return window.CapVRGame?.myPlayerId || 'player_0';
  }

  /** Resolve red/blue for humans + bots. */
  function resolveCombatTeam(id) {
    if (!id) return null;
    const sid = String(id);
    // Bot lasers pass team color as attackerId ('red'/'blue')
    if (sid === 'red' || sid === 'blue') return sid;
    if (sid === 'player' || sid === 'rig') return resolveCombatTeam(localId());
    const fromMap = window.CapVRGame?.playerTeams?.get?.(sid);
    if (fromMap === 'red' || fromMap === 'blue') return fromMap;
    const botEntry = BOT_MAP.find((b) => b.owner === sid || b.bot === sid || b.bot === `zerog-${sid}`);
    if (botEntry) return botEntry.team;
    if (sid.startsWith('bot-') || sid.startsWith('zerog-bot-')) {
      const owner = sid.replace(/^zerog-/, '');
      const el = document.getElementById(`zerog-${owner}`) || document.getElementById(sid);
      const t = el?.components?.['zerog-bot']?.data?.team;
      if (t === 'red' || t === 'blue') return t;
      const entry2 = BOT_MAP.find((b) => b.owner === owner);
      if (entry2) return entry2.team;
    }
    return null;
  }

  function areCombatTeammates(a, b) {
    if (!a || !b) return false;
    if (String(a) === String(b)) return false;
    const ta = resolveCombatTeam(a);
    const tb = resolveCombatTeam(b);
    // Both must have a known team — never treat "unknown" as friendly
    return !!(ta && tb && ta === tb);
  }

  /** True only when we know this is same-team laser heal (not sticky / not ambiguous). */
  function shouldFriendlyHeal(attackerId, targetId, opts) {
    if (opts?.sticky || opts?.forceDamage) return false;
    if (!attackerId || !targetId) return false;
    // Placeholders are not real attackers — do not heal
    if (attackerId === 'bot' || attackerId === 'sticky') return false;
    // Humans: only heal when BOTH have an explicit team in the lobby map.
    // Missing map entries must never look "friendly" (that immortalized teammates).
    const a = String(attackerId);
    const t = String(targetId);
    const map = window.CapVRGame?.playerTeams;
    if (map && (a.startsWith('player_') || t.startsWith('player_'))) {
      const ta = map.get?.(a);
      const tb = map.get?.(t);
      if (a.startsWith('player_') && ta !== 'red' && ta !== 'blue') return false;
      if (t.startsWith('player_') && tb !== 'red' && tb !== 'blue') return false;
    }
    return areCombatTeammates(attackerId, targetId);
  }

  /** Half damage, floored (laser 16 → heal 8). */
  function healFromDamage(damage) {
    const d = typeof damage === 'number' ? damage : LASER_DAMAGE;
    return Math.max(0, Math.floor(d / 2));
  }

  /** Who dealt this hit? Bot AI must pass attackerId — never default to local human. */
  function resolveHitAttackerId(detail) {
    const d = detail || {};
    if (d.attackerId) {
      // If caller also sent fromTeam and it disagrees with attackerId's team,
      // trust fromTeam (guards against mislabeled bot owners).
      if (d.fromTeam === 'red' || d.fromTeam === 'blue') {
        const ta = resolveCombatTeam(d.attackerId);
        if (ta && ta !== d.fromTeam) return d.fromTeam;
      }
      return d.attackerId;
    }
    if (d.fromTeam === 'red' || d.fromTeam === 'blue') return d.fromTeam;
    if (d.shooterId) return d.shooterId;
    return localId();
  }

  function playerSlotIndex(playerId) {
    if (!playerId) return null;
    const m = String(playerId).match(/player_(\d+)/);
    return m ? m[1] : null;
  }

  /** MP: client → host damage proposal (ragdoll-shooter path; syncDamageDealt is host-only). */
  function proposePlayerDamage(targetId, damage, shot) {
    const G = window.CapVRGame;
    if (!G?.sendCombatMsg || !G.isMultiplayer?.()) return;
    if (G.isHost?.()) return;
    const payload = {
      type: 'damage-dealt',
      targetId,
      damage: damage || LASER_DAMAGE,
      attackerId: localId()
    };
    if (shot?.point) {
      payload.point = shot.point.clone
        ? { x: shot.point.x, y: shot.point.y, z: shot.point.z }
        : { x: shot.point.x, y: shot.point.y, z: shot.point.z };
    }
    if (shot?.from) {
      payload.from = shot.from.clone
        ? { x: shot.from.x, y: shot.from.y, z: shot.from.z }
        : { x: shot.from.x, y: shot.from.y, z: shot.from.z };
    } else if (payload.point) {
      // Host requires a shot origin — use hit point if aim origin missing
      payload.from = { x: payload.point.x, y: payload.point.y, z: payload.point.z };
    }
    G.sendCombatMsg(payload);
  }

  /** Host applies authoritative PvP damage (listen-server / dedicated host). */
  function applyPlayerDamageAuthority(targetId, damage, shot) {
    window.CapVRCombat?.applyRemoteDamage?.({
      targetId,
      damage: damage || LASER_DAMAGE,
      attackerId: localId(),
      force: true,
      point: shot?.point
        ? (shot.point.clone
          ? { x: shot.point.x, y: shot.point.y, z: shot.point.z }
          : shot.point)
        : null,
      from: shot?.from
        ? (shot.from.clone
          ? { x: shot.from.x, y: shot.from.y, z: shot.from.z }
          : shot.from)
        : null
    });
  }

  function _shotDirFromPayload(shot) {
    if (!shot?.from || !shot?.point) return null;
    const from = shot.from.clone
      ? shot.from.clone()
      : new THREE.Vector3(shot.from.x, shot.from.y, shot.from.z);
    const pt = shot.point.clone
      ? shot.point.clone()
      : new THREE.Vector3(shot.point.x, shot.point.y, shot.point.z);
    const dir = pt.sub(from);
    if (dir.lengthSq() < 1e-6) return null;
    return dir.normalize();
  }

  function deathCorpseIdForAvatar(bodyEl) {
    if (!bodyEl?.id) return null;
    if (bodyEl.id === 'local-body') return 'player-death-ragdoll-local';
    const m = String(bodyEl.id).match(/^remote-body-(\d+)$/);
    if (m) return `player-death-ragdoll-${m[1]}`;
    return null;
  }

  function getDeathCarryVelocity(bodyEl, shot) {
    const lin = new THREE.Vector3();
    const dir = _shotDirFromPayload(shot);
    if (dir) lin.addScaledVector(dir, 3.4);
    if (bodyEl?.id === 'local-body') {
      const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
      if (zp?.velocity) {
        lin.x += zp.velocity.x || 0;
        lin.y += zp.velocity.y || 0;
        lin.z += zp.velocity.z || 0;
      }
    }
    const avatar = bodyEl?.components?.['mixamo-body-avatar'] || bodyEl?.components?.['mixamo-body'];
    if (avatar?.headVelocity) {
      lin.x += avatar.headVelocity.x || 0;
      lin.y += avatar.headVelocity.y || 0;
      lin.z += avatar.headVelocity.z || 0;
    }
    if (lin.lengthSq() < 0.2 && dir) lin.copy(dir).multiplyScalar(2.5);
    if (lin.length() > 9) lin.setLength(9);
    return lin;
  }

  function activatePlayerDeathRagdoll(bodyEl, shot) {
    const corpseId = deathCorpseIdForAvatar(bodyEl);
    if (!corpseId || !bodyEl?.object3D) return false;
    const corpse = document.getElementById(corpseId);
    const grab = corpse?.components?.['grabbable-ragdoll'];
    if (!grab) return false;
    if (!grab.modelLoaded) {
      // Model still loading — retry once; spin fallback runs until then
      if (!bodyEl._capvrDeathRagdollRetry) {
        bodyEl._capvrDeathRagdollRetry = true;
        setTimeout(() => {
          delete bodyEl._capvrDeathRagdollRetry;
          if (bodyEl.dataset?.capvrDead === 'true') {
            if (activatePlayerDeathRagdoll(bodyEl, shot)) {
              delete bodyEl._capvrDeathVel;
              delete bodyEl._capvrDeathLin;
            }
          }
        }, 280);
      }
      return false;
    }

    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    bodyEl.object3D.updateWorldMatrix(true, true);
    bodyEl.object3D.getWorldPosition(wp);
    bodyEl.object3D.getWorldQuaternion(wq);
    // Corpse is scene-root — set world pose as local
    corpse.object3D.position.copy(wp);
    corpse.object3D.quaternion.copy(wq);
    corpse.object3D.updateMatrixWorld(true);

    const dir = _shotDirFromPayload(shot);
    const carry = getDeathCarryVelocity(bodyEl, shot);
    const ok = grab.collapseForDeath(dir, carry);
    if (!ok) return false;

    // Team tint must match live avatar. Bot form mutates shared pooled mats in place
    // (color+emissive); tinting only albedo left blue emissive → corpse looked blue.
    // Apply BOTH via material pool (clone-by-key) so we don't repaint live bots.
    try {
      let ownerId = null;
      if (bodyEl.id === 'local-body') ownerId = localId();
      else {
        const idx = bodyEl.id.replace('remote-body-', '');
        ownerId = `player_${idx}`;
      }
      const team = resolveCombatTeam(ownerId)
        || window.CapVRGame?.playerTeams?.get?.(ownerId)
        || 'red';
      const isBlue = team === 'blue';
      const albedo = isBlue ? '#3388ff' : '#ff3355';
      const emHex = isBlue ? 0x2a7fff : 0xff2a3a;
      if (grab.model && window.CapVRMaterials?.applyAvatarTint) {
        window.CapVRMaterials.applyAvatarTint(grab.model, {
          color: albedo,
          emissive: emHex,
          emissiveIntensity: 0.4
        });
      } else if (grab.model) {
        grab.model.traverse((n) => {
          if (!n.isMesh || !n.material) return;
          const mats = Array.isArray(n.material) ? n.material : [n.material];
          const next = mats.map((m) => {
            if (!m) return m;
            const c = m.clone();
            c.userData = Object.assign({}, m.userData, { capvrNoShare: true });
            if (c.color) c.color.set(albedo);
            if (c.emissive) {
              c.emissive.setHex(emHex);
              c.emissiveIntensity = 0.4;
            }
            c.needsUpdate = true;
            return c;
          });
          n.material = Array.isArray(n.material) ? next : next[0];
        });
      }
    } catch (e) { /* */ }

    bodyEl._capvrDeathCorpseId = corpseId;
    bodyEl.object3D.visible = false;
    return true;
  }

  function deactivatePlayerDeathRagdoll(bodyEl) {
    const corpseId = bodyEl?._capvrDeathCorpseId || deathCorpseIdForAvatar(bodyEl);
    delete bodyEl?._capvrDeathCorpseId;
    if (bodyEl?.object3D) bodyEl.object3D.visible = true;
    const corpse = corpseId && document.getElementById(corpseId);
    const grab = corpse?.components?.['grabbable-ragdoll'];
    if (grab?.parkDeathCorpse) grab.parkDeathCorpse();
    else if (corpse) {
      corpse.setAttribute('visible', false);
      corpse.object3D.position.set(0, -80, 0);
    }
  }

  function applyHumanDeathTumble(bodyEl, shot) {
    if (!bodyEl?.object3D) return;
    bodyEl.dataset.capvrDead = 'true';
    bodyEl._capvrDeathUntil = performance.now() + RESPAWN_MS;

    // Prefer real Box3D ragdoll (same system as bots). Spin tumble is fallback only.
    if (activatePlayerDeathRagdoll(bodyEl, shot)) {
      delete bodyEl._capvrDeathVel;
      delete bodyEl._capvrDeathLin;
      return;
    }

    const dir = _shotDirFromPayload(shot);
    if (dir) {
      bodyEl._capvrDeathVel = { rx: dir.z * 2.8, rz: -dir.x * 2.8, ry: dir.y * 0.4 };
    } else {
      bodyEl._capvrDeathVel = { rx: 1.2, rz: 0.6, ry: 0 };
    }
    const lin = getDeathCarryVelocity(bodyEl, shot);
    bodyEl._capvrDeathLin = { x: lin.x, y: lin.y, z: lin.z };
  }

  function clearHumanDeathTumble(bodyEl) {
    if (!bodyEl) return;
    deactivatePlayerDeathRagdoll(bodyEl);
    delete bodyEl.dataset.capvrDead;
    delete bodyEl._capvrDeathUntil;
    delete bodyEl._capvrDeathVel;
    delete bodyEl._capvrDeathLin;
    if (bodyEl.object3D) {
      bodyEl.object3D.rotation.x = 0;
      bodyEl.object3D.rotation.z = 0;
      bodyEl.object3D.visible = true;
    }
  }

  function applyRemoteHumanDeathFx(playerId, shot) {
    const idx = playerSlotIndex(playerId);
    if (idx == null) return;
    const bodyEl = document.getElementById(`remote-body-${idx}`);
    const targetEl = document.getElementById(`remote-target-${idx}`);
    targetEl?.components?.['impact-effect']?.playEffect?.();
    if (bodyEl) {
      applyHumanDeathTumble(bodyEl, shot);
      bodyEl.setAttribute('visible', true);
    }
    if (shot?.point) playImpactSfx(shot.point);
  }

  function applyRemoteHumanRespawnFx(playerId) {
    const idx = playerSlotIndex(playerId);
    if (idx == null) return;
    const bodyEl = document.getElementById(`remote-body-${idx}`);
    clearHumanDeathTumble(bodyEl);
    if (bodyEl) bodyEl.setAttribute('visible', true);
  }

  function tickHumanDeathTumbles(dtSec) {
    const s = Math.min(0.05, dtSec || 0.016);
    const damp = Math.pow(0.94, s * 60);
    const world = new THREE.Vector3();
    document.querySelectorAll('[data-capvr-dead="true"]').forEach((el) => {
      if (!el.object3D) return;
      if (el._capvrDeathUntil && performance.now() > el._capvrDeathUntil) return;

      if (el._capvrDeathVel) {
        el.object3D.rotation.x += el._capvrDeathVel.rx * s;
        el.object3D.rotation.z += el._capvrDeathVel.rz * s;
        el.object3D.rotation.y += (el._capvrDeathVel.ry || 0) * s;
      }

      const lin = el._capvrDeathLin;
      if (lin && (lin.x || lin.y || lin.z)) {
        el.object3D.getWorldPosition(world);
        world.x += lin.x * s;
        world.y += lin.y * s;
        world.z += lin.z * s;
        lin.x *= damp;
        lin.y *= damp;
        lin.z *= damp;
        if (el.object3D.parent) {
          el.object3D.parent.updateWorldMatrix(true, false);
          el.object3D.parent.worldToLocal(world);
        }
        el.object3D.position.copy(world);
      }
    });
  }

  function purgeDuplicateCombatBodies() {
    ['bot-red-body-combat', 'bot-blue-body-combat', 'bot-green-body-combat', 'ik-local-body', 'grab-dummy']
      .forEach((id) => document.getElementById(id)?.remove());
    document.querySelectorAll('[mixamo-body]').forEach((el) => {
      if (el.id !== 'local-body' && el.id !== 'mirror-body') el.remove();
    });
  }

  function teamSpawn(team, slot) {
    if (window.CapVRGame?.getTeamSpawn) return window.CapVRGame.getTeamSpawn(team, slot || 0);
    if (typeof getTeamSpawnPosition === 'function') return getTeamSpawnPosition(team, slot || 0);
    return { x: team === 'red' ? -2 : 2, y: 2, z: team === 'red' ? -34 : 34 };
  }

  /* ── audio (BattleVR has impact SFX only — no laser shot file) ── */
  function ensureAudio() {
    if (window._capAudio) return window._capAudio;
    try {
      window._capAudio = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { /* */ }
    return window._capAudio;
  }

  function synthTone(freq, dur, gain, type) {
    try {
      const ctx = ensureAudio();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume?.();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type || 'square';
      o.frequency.value = freq;
      g.gain.value = gain == null ? 0.06 : gain;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (dur || 0.08));
      o.stop(ctx.currentTime + (dur || 0.09));
    } catch (e) { /* */ }
  }

  function playLaserFireSfx() {
    // Disabled — oscillator beeps on every arena shot (bots + peers) were too noisy.
  }

  /** Spaceshooter-style: random metal-hit-1/2/3 at the impact point. */
  function ensureMetalHitSounds() {
    const scene = document.querySelector('a-scene');
    if (!scene || scene.dataset.capvrMetalHits === '1') return;
    scene.dataset.capvrMetalHits = '1';
    const files = [
      'audio/metal-hit-92-200420.mp3',
      'audio/metal-hit-94-200422.mp3',
      'audio/metal-hit-95-200424.mp3'
    ];
    files.forEach((src, i) => {
      const id = `metal-hit-sound-${i + 1}`;
      if (document.getElementById(id)) return;
      const el = document.createElement('a-entity');
      el.id = id;
      el.setAttribute('sound', {
        src: `url(${src})`,
        autoplay: false,
        loop: false,
        volume: 0.35,
        positional: true,
        distanceModel: 'linear',
        refDistance: 1,
        maxDistance: 40,
        poolSize: 6
      });
      scene.appendChild(el);
    });
  }

  /**
   * Spaceshooter impact-spark-burst (compact, no smoke dependency).
   *
   * IMPORTANT: driven by updateHitSparks(dt) from the A-Frame tick — NOT
   * window.requestAnimationFrame. In an immersive WebXR session window.rAF is
   * paused, so the old rAF version never animated OR cleaned up: every shot
   * leaked its spheres into the scene permanently. This pool advances + disposes
   * on the XR render loop and is hard-capped so it can never accumulate.
   */
  const SPARKS = [];
  const SPARK_MAX = 90; // hard cap across all bursts (≈ 7 recent shots)
  const SHARED_SPARK_GEO = new THREE.SphereGeometry(0.008, 5, 3);

  // Combat visual FX (laser beams, impact orbs, hit sparks). Re-ENABLED by default:
  // FX also fire on wall hits, which hold 72 fps, so FX are not the dip cause.
  // Toggle live: __capvrFx(false) to suppress beams/sparks.
  if (window.__capvrFxOff === undefined) window.__capvrFxOff = false;
  if (!window.__capvrFx) {
    window.__capvrFx = function (on) {
      window.__capvrFxOff = (on === false);
      console.log('[CapVR] combat FX ' + (window.__capvrFxOff ? 'DISABLED (no beams/sparks)' : 'ENABLED'));
      return !window.__capvrFxOff;
    };
  }

  // BOT HIT-RESPONSE gate. When off, lasers still register (beam/FX, ray stops on bot)
  // but bots skip HP / hit-react / shatter / death. Default ON. Toggle: __capvrBotHit(false).
  // Pair with __capvrShatter(false) to keep debris shards off while hits still land.
  if (window.__capvrBotHitOff === undefined) window.__capvrBotHitOff = false;
  window.__capvrBotHit = function (on) {
    window.__capvrBotHitOff = (on === false);
    console.log('[CapVR] bot hit-response ' + (window.__capvrBotHitOff ? 'DISABLED (bots ignore hits)' : 'ENABLED'));
    return !window.__capvrBotHitOff;
  };

  function disposeSpark(spark) {
    if (spark._sceneObj && spark.mesh) spark._sceneObj.remove(spark.mesh);
    // Geometry is shared — only dispose the per-spark material.
    spark.mesh?.material?.dispose?.();
    spark.mesh = null;
  }

  function spawnHitSparks(position) {
    if (window.__capvrFxOff === true) return;
    const sceneObj = document.querySelector('a-scene')?.object3D;
    if (!sceneObj || !position) return;
    const origin = new THREE.Vector3(
      position.x != null ? position.x : position.X,
      position.y != null ? position.y : position.Y,
      position.z != null ? position.z : position.Z
    );
    const count = 6 + Math.floor(Math.random() * 4);
    const colors = [0xFFFF00, 0xFF8800, 0xFF4400, 0xFF6600];
    const burstDuration = 0.7;
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5;
      const speed = 1.5 + Math.random() * 2;
      const velocity = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.cos(phi) * speed * 0.5,
        Math.sin(phi) * Math.sin(theta) * speed
      );
      const color = colors[Math.floor(Math.random() * colors.length)];
      const mesh = new THREE.Mesh(
        SHARED_SPARK_GEO,
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(color),
          transparent: true,
          opacity: 0.9,
          depthTest: true,
          depthWrite: false
        })
      );
      mesh.position.copy(origin);
      mesh.renderOrder = 10010;
      sceneObj.add(mesh);
      SPARKS.push({
        mesh,
        _sceneObj: sceneObj,
        velocity,
        age: 0,
        maxAge: burstDuration,
        startColor: new THREE.Color(color),
        endColor: new THREE.Color(0x220000),
        originalOpacity: 0.9
      });
    }
    // Enforce the global cap — drop oldest so a rapid-fire spree can't pile up.
    while (SPARKS.length > SPARK_MAX) {
      disposeSpark(SPARKS.shift());
    }
  }

  /** Advance + retire all live sparks. Called from capvr-combat tick (XR-safe). */
  function updateHitSparks(dt) {
    if (!SPARKS.length) return;
    const step = Math.min(0.05, dt || 0.016);
    for (let i = SPARKS.length - 1; i >= 0; i--) {
      const spark = SPARKS[i];
      spark.age += step;
      if (spark.age >= spark.maxAge || !spark.mesh) {
        disposeSpark(spark);
        SPARKS.splice(i, 1);
        continue;
      }
      spark.mesh.position.x += spark.velocity.x * step;
      spark.mesh.position.y += spark.velocity.y * step;
      spark.mesh.position.z += spark.velocity.z * step;
      spark.velocity.y -= 2.0 * step;
      const progress = spark.age / spark.maxAge;
      spark.mesh.material.color.copy(spark.startColor).lerp(spark.endColor, progress);
      spark.mesh.material.opacity = spark.originalOpacity * (1 - progress);
    }
  }

  function playImpactSfx(pos) {
    if (!pos) return;
    ensureMetalHitSounds();
    const picks = [
      document.getElementById('metal-hit-sound-1'),
      document.getElementById('metal-hit-sound-2'),
      document.getElementById('metal-hit-sound-3')
    ].filter((el) => el?.components?.sound);
    const el = picks.length
      ? picks[Math.floor(Math.random() * picks.length)]
      : document.querySelector('#impact-sound');
    if (el?.components?.sound) {
      try {
        el.setAttribute('position', `${pos.x} ${pos.y} ${pos.z}`);
        if (el.object3D) el.object3D.position.set(pos.x, pos.y, pos.z);
        el.components.sound.stopSound?.();
        el.components.sound.playSound();
      } catch (e) { /* */ }
    }
    // No synth fallback — electronic hit beeps were playing for every laser impact.
    spawnHitSparks(pos);
  }

  /* ── laser visuals + deathcam linger (BattleVR killingShot) ── */

  /** True when a world point is near the local headset (inbound beam tip). */
  function _nearLocalCamera(p, distM) {
    const cam = document.getElementById('camera');
    if (!cam?.object3D || !p) return false;
    const c = new THREE.Vector3();
    cam.object3D.getWorldPosition(c);
    const x = p.x != null ? p.x : p.X;
    const y = p.y != null ? p.y : p.Y;
    const z = p.z != null ? p.z : p.Z;
    return c.distanceToSquared(new THREE.Vector3(x, y, z)) < (distM != null ? distM : 1.4) ** 2;
  }

  /**
   * Pull beam end back so it stops short of the camera.
   * A hairline ending at/inside the headset is invisible when looking at the shooter
   * (you're staring down the barrel) — only the impact flash reads.
   */
  function _pullLaserEndFromCamera(from, to, keepAwayM) {
    const cam = document.getElementById('camera');
    if (!cam?.object3D || !from || !to) return to;
    const c = new THREE.Vector3();
    cam.object3D.getWorldPosition(c);
    const fx = from.x != null ? from.x : from.X;
    const fy = from.y != null ? from.y : from.Y;
    const fz = from.z != null ? from.z : from.Z;
    const origin = new THREE.Vector3(fx, fy, fz);
    const end = new THREE.Vector3(
      to.x != null ? to.x : to.X,
      to.y != null ? to.y : to.Y,
      to.z != null ? to.z : to.Z
    );
    const away = keepAwayM != null ? keepAwayM : 0.7;
    if (end.distanceTo(c) >= away) return end;
    const toCam = c.clone().sub(origin);
    const d = toCam.length();
    if (d < 0.15) return end;
    toCam.multiplyScalar(1 / d);
    const stop = Math.max(0.25, d - away);
    return origin.clone().addScaledVector(toCam, stop);
  }

  function _orientLaserCylinder(el, fx, fy, fz, tx, ty, tz) {
    if (!el) return;
    const apply = () => {
      if (!el.object3D) return;
      const dir = new THREE.Vector3(tx - fx, ty - fy, tz - fz);
      if (dir.lengthSq() < 1e-8) return;
      dir.normalize();
      el.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    };
    if (el.object3D) apply();
    else el.addEventListener('loaded', apply, { once: true });
  }

  function spawnLaserVisuals(from, to, opts) {
    opts = opts || {};
    if (window.__capvrFxOff === true) return null;
    const scene = document.querySelector('a-scene');
    if (!scene || !from || !to) return null;
    const color = opts.color || '#00ffff';

    // Inbound hits end at/near headset — thicken, linger longer, stop short of camera.
    const inbound = !!(opts.inbound || (!opts.linger && opts.hit && _nearLocalCamera(to, 1.35)));
    let end = to;
    if (inbound || opts.pullFromCamera) {
      end = _pullLaserEndFromCamera(from, to, opts.keepAway != null ? opts.keepAway : 0.7);
    }

    const fx = from.x != null ? from.x : from.X;
    const fy = from.y != null ? from.y : from.Y;
    const fz = from.z != null ? from.z : from.Z;
    const tx = end.x != null ? end.x : end.X;
    const ty = end.y != null ? end.y : end.Y;
    const tz = end.z != null ? end.z : end.Z;
    const useThick = !!(opts.linger || opts.thick || inbound);
    const radius = opts.radius != null
      ? opts.radius
      : (opts.linger ? 0.04 : (inbound ? 0.028 : 0.018));
    const dur = opts.dur != null
      ? opts.dur
      : (opts.linger ? null : (inbound ? 320 : 80));

    // Line is reliable in A-Frame (cylinder quat often resets before object3D mounts).
    const beam = document.createElement('a-entity');
    beam.setAttribute(
      'line',
      `start: ${fx} ${fy} ${fz}; end: ${tx} ${ty} ${tz}; color: ${color}; opacity: ${opts.linger || inbound ? 1 : 0.85}`
    );

    // Impact orb only on real hits — never float a blob in empty air on a miss.
    let impact = null;
    if (opts.linger || opts.hit) {
      impact = document.createElement('a-sphere');
      impact.setAttribute('radius', opts.linger ? 0.22 : (inbound ? 0.11 : 0.14));
      impact.setAttribute('position', `${tx} ${ty} ${tz}`);
      impact.setAttribute('material', {
        color, emissive: color, emissiveIntensity: opts.linger ? 4 : 2.4, shader: 'flat'
      });
    }

    let origin = null;
    let thick = null;
    let hint = null;
    if (opts.linger || useThick) {
      if (opts.linger) {
        origin = document.createElement('a-sphere');
        origin.setAttribute('radius', 0.28);
        origin.setAttribute('position', `${fx} ${fy} ${fz}`);
        origin.setAttribute('material', {
          color: '#ffffff', emissive: color, emissiveIntensity: 5, shader: 'flat'
        });
        hint = document.createElement('a-entity');
        hint.setAttribute('position', `${fx} ${fy + 0.45} ${fz}`);
        hint.setAttribute('text', {
          value: 'KILL SHOT',
          align: 'center',
          width: 6,
          color: '#ff5555',
          opacity: 1
        });
        scene.appendChild(hint);
        scene.appendChild(origin);
      }
      // Thick cylinder — needed for inbound (thin a-line is invisible head-on).
      thick = document.createElement('a-entity');
      const mid = new THREE.Vector3((fx + tx) / 2, (fy + ty) / 2, (fz + tz) / 2);
      const len = Math.max(0.15, Math.hypot(tx - fx, ty - fy, tz - fz));
      thick.setAttribute('geometry', { primitive: 'cylinder', radius, height: len });
      thick.setAttribute('material', {
        color, emissive: color, emissiveIntensity: opts.linger ? 3 : 2.2,
        shader: 'flat', transparent: true, opacity: opts.linger ? 0.95 : 0.88
      });
      thick.setAttribute('position', `${mid.x} ${mid.y} ${mid.z}`);
      scene.appendChild(thick);
      _orientLaserCylinder(thick, fx, fy, fz, tx, ty, tz);
      if (opts.linger) {
        const visuals = { beam, impact, origin, thick, hint };
        scene.appendChild(beam);
        if (impact) scene.appendChild(impact);
        return visuals;
      }
    }

    scene.appendChild(beam);
    if (impact) scene.appendChild(impact);
    const visuals = { beam, impact, thick };
    if (dur != null) {
      setTimeout(() => {
        try { beam.remove(); } catch (e) { /* */ }
        try { impact?.remove(); } catch (e) { /* */ }
        try { thick?.remove(); } catch (e) { /* */ }
      }, dur);
    }
    return visuals;
  }

  function clearKillingShots(el) {
    if (!el?.killingShot?.length) return;
    el.killingShot.forEach(removeKillVisuals);
    el.killingShot = [];
  }

  function removeKillVisuals(v) {
    ['beam', 'impact', 'origin', 'thick', 'hint'].forEach((k) => {
      try { v?.[k]?.remove(); } catch (e) { /* */ }
    });
  }

  function retainKillingShot(el, visuals) {
    if (!visuals) return;
    const store = el || document.querySelector('a-scene');
    if (!store) return;
    if (!store.killingShot) store.killingShot = [];
    store.killingShot.push(visuals);
  }

  /* Team emissive — bots only. Local body uses player team (never forced teal). */
  function applyCharacterVisibility(bodyEl, team, opts) {
    if (!bodyEl?.object3D) return;
    opts = opts || {};
    const hex = team === 'red' ? 0xff2a3a : 0x2a7fff;
    const intensity = opts.local ? 0.35 : 0.55;
    // Local dissolve mutates mats in place — keep private.
    if (opts.local) {
      bodyEl.object3D.traverse((n) => {
        if (!n.isMesh || !n.material) return;
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        mats.forEach((m) => {
          if (!m) return;
          m.userData = m.userData || {};
          m.userData.capvrNoShare = true;
          if (m.emissive) m.emissive.setHex(hex);
          if (typeof m.emissiveIntensity === 'number') {
            m.emissiveIntensity = Math.max(intensity, m.emissiveIntensity || 0);
          } else {
            m.emissiveIntensity = intensity;
          }
          m.needsUpdate = true;
        });
      });
    } else if (window.CapVRMaterials) {
      window.CapVRMaterials.applyAvatarTint(bodyEl.object3D, {
        emissive: hex,
        emissiveIntensity: intensity
      });
    } else {
      bodyEl.object3D.traverse((n) => {
        if (!n.isMesh || !n.material) return;
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        mats.forEach((m) => {
          if (!m) return;
          if (m.emissive) m.emissive.setHex(hex);
          if (typeof m.emissiveIntensity === 'number') {
            m.emissiveIntensity = Math.max(intensity, m.emissiveIntensity || 0);
          } else {
            m.emissiveIntensity = intensity;
          }
          m.needsUpdate = true;
        });
      });
    }
    // Remove legacy semi-transparent team cylinders (mesh tint is enough)
    bodyEl.querySelectorAll?.('.capvr-contour').forEach((el) => el.remove());
  }

  function ensureBotVisibility() {
    BOT_MAP.forEach(({ body, team }) => {
      const el = document.getElementById(body);
      if (!el || el._capvrVisApplied) return;
      const av = el.components?.['mixamo-body-avatar'];
      if (av?.modelLoaded) {
        applyCharacterVisibility(el, team);
        el._capvrVisApplied = true;
      } else {
        setTimeout(() => {
          applyCharacterVisibility(el, team);
          el._capvrVisApplied = true;
        }, 2200);
      }
    });
    // Local tint follows YOUR team (re-runnable — team switches must retint)
    const local = document.getElementById('local-body');
    if (local) {
      const tintLocal = () => {
        const team = window.CapVRGame?.playerTeams?.get?.(localId()) || 'red';
        applyCharacterVisibility(local, team, { local: true });
      };
      if (!local._capvrVisBoot) {
        local._capvrVisBoot = true;
        setTimeout(tintLocal, 1200);
        setTimeout(tintLocal, 4000);
      } else {
        tintLocal();
      }
    }
  }

  /* ── health bars (BattleVR-style floaters + camera HUD) ── */
  function ensureHud() {
    const cam = document.getElementById('camera');
    if (!cam || document.getElementById('capvr-health-container')) return;
    const wrap = document.createElement('a-entity');
    wrap.id = 'capvr-health-container';
    wrap.setAttribute('position', '-0.22 -0.18 -0.55');
    wrap.innerHTML = [
      '<a-text value="Health" position="0 0.03 0" align="left" width="0.55" color="#ffffff"></a-text>',
      '<a-plane id="capvr-health-bar-bg" width="0.38" height="0.022" color="#ff0000" position="0.19 0 0"></a-plane>',
      '<a-plane id="capvr-health-bar-fg" width="0.38" height="0.022" color="#00ff00" position="0.19 0 0.001"></a-plane>',
      '<a-text id="capvr-health-text" value="Health: 100%" position="0 -0.035 0" align="left" width="0.5" color="#ffffff"></a-text>'
    ].join('');
    cam.appendChild(wrap);
  }

  function updateLocalHud(hp, maxHp) {
    ensureHud();
    const fg = document.getElementById('capvr-health-bar-fg');
    const text = document.getElementById('capvr-health-text');
    const wrap = document.getElementById('capvr-health-container');
    if (!fg || !text) return;
    const pct = Math.max(0, Math.min(1, (hp || 0) / (maxHp || MAX_HP)));
    const barWidth = 0.38 * pct;
    fg.setAttribute('geometry', `primitive: plane; width: ${barWidth}; height: 0.022`);
    fg.setAttribute('position', `${barWidth / 2} 0 0.001`);
    let color = '#00ff00';
    if (pct < 0.6) color = '#ffff00';
    if (pct < 0.3) color = '#ff0000';
    fg.setAttribute('color', color);
    text.setAttribute('value', `Health: ${Math.round(pct * 100)}%`);
    if (wrap) wrap.setAttribute('visible', true);
  }

  function ensureWorldBar(anchorEl, owner) {
    if (!anchorEl?.object3D) return null;
    if (healthBars[owner]?.root?.isConnected) return healthBars[owner];
    const root = document.createElement('a-entity');
    root.classList.add('capvr-health-bar');
    root.setAttribute('position', '0 2.15 0');
    const bg = document.createElement('a-entity');
    bg.setAttribute('geometry', { primitive: 'plane', width: 1, height: 0.1 });
    bg.setAttribute('material', { color: '#ff0000', shader: 'flat', transparent: true, opacity: 0.55 });
    bg.setAttribute('position', '0 0 -0.01');
    const fg = document.createElement('a-entity');
    fg.setAttribute('geometry', { primitive: 'plane', width: 1, height: 0.1 });
    fg.setAttribute('material', { color: '#00ff00', shader: 'flat', transparent: true, opacity: 0.9 });
    root.appendChild(bg);
    root.appendChild(fg);
    anchorEl.appendChild(root);
    healthBars[owner] = { root, fg, bg };
    return healthBars[owner];
  }

  function updateWorldBar(owner, hp, maxHp, dead) {
    const entry = BOT_MAP.find((b) => b.owner === owner);
    const bodyEl = entry && document.getElementById(entry.body);
    const bar = ensureWorldBar(bodyEl, owner);
    if (!bar) return;
    if (dead) {
      bar.root.setAttribute('visible', false);
      return;
    }
    bar.root.setAttribute('visible', true);
    const pct = Math.max(0, Math.min(1, (hp || 0) / (maxHp || MAX_HP)));
    bar.fg.setAttribute('geometry', { primitive: 'plane', width: Math.max(0.02, pct), height: 0.1 });
    bar.fg.setAttribute('position', `${(pct - 1) / 2} 0 0`);
    let color = '#00ff00';
    if (pct < 0.6) color = '#ffff00';
    if (pct < 0.3) color = '#ff0000';
    bar.fg.setAttribute('material', 'color', color);
    // Billboard toward camera
    const cam = document.getElementById('camera');
    if (cam?.object3D && bar.root.object3D) {
      const cp = new THREE.Vector3();
      cam.object3D.getWorldPosition(cp);
      bar.root.object3D.lookAt(cp);
    }
  }

  function ensureRemoteBar(playerId) {
    const idx = parseInt(String(playerId).split('_')[1], 10);
    if (Number.isNaN(idx)) return null;
    const remote = document.getElementById(`remote-player-${idx}`);
    if (!remote) return null;
    let bar = remote.querySelector('.mp-health-bar');
    if (!bar) {
      bar = document.createElement('a-entity');
      bar.classList.add('mp-health-bar');
      bar.setAttribute('position', '0 0.7 0');
      const bg = document.createElement('a-plane');
      bg.setAttribute('width', '0.5');
      bg.setAttribute('height', '0.06');
      bg.setAttribute('color', '#ff0000');
      bg.setAttribute('opacity', '0.5');
      const fill = document.createElement('a-plane');
      fill.classList.add('mp-health-fill');
      fill.setAttribute('width', '0.5');
      fill.setAttribute('height', '0.06');
      fill.setAttribute('color', '#00ff00');
      fill.setAttribute('position', '0 0 0.001');
      bar.appendChild(bg);
      bar.appendChild(fill);
      remote.appendChild(bar);
    }
    return bar;
  }

  function updateRemoteBar(playerId, hp, maxHp, isDead) {
    const bar = ensureRemoteBar(playerId);
    if (!bar) return;
    if (isDead) {
      bar.setAttribute('visible', false);
      return;
    }
    bar.setAttribute('visible', true);
    const pct = Math.max(0, Math.min(1, hp / (maxHp || MAX_HP)));
    const fill = bar.querySelector('.mp-health-fill');
    if (!fill) return;
    fill.setAttribute('width', Math.max(0.02, 0.5 * pct));
    fill.setAttribute('position', `${(0.5 * pct - 0.5) / 2} 0 0.001`);
    let color = '#00ff00';
    if (pct < 0.6) color = '#ffff00';
    if (pct < 0.3) color = '#ff0000';
    fill.setAttribute('color', color);
  }

  /* ── MP helpers (host-authoritative like BattleVR) ── */
  function combatBroadcast(payload) {
    const send = window.CapVRGame?.sendCombatMsg;
    if (typeof send === 'function') send(payload);
  }

  function syncHealthNet(entityId, currentHealth, maxHealth, isDead, shot) {
    const payload = {
      type: 'health-sync',
      entityId,
      currentHealth,
      maxHealth,
      isDead: !!isDead
    };
    // Always carry shot origin so victims can show laser / killshot (no silent deaths)
    if (shot?.from) {
      payload.from = {
        x: shot.from.x, y: shot.from.y, z: shot.from.z
      };
    }
    if (shot?.to || shot?.point) {
      const t = shot.to || shot.point;
      payload.to = { x: t.x, y: t.y, z: t.z };
      payload.point = { x: t.x, y: t.y, z: t.z };
    }
    if (shot?.sticky) payload.sticky = true;
    if (shot?.attackerId) payload.attackerId = shot.attackerId;
    combatBroadcast(payload);
  }

  function syncWeaponFired(from, to, color) {
    combatBroadcast({
      type: 'weapon-fired',
      playerId: localId(),
      startX: from.x, startY: from.y, startZ: from.z,
      endX: to.x, endY: to.y, endZ: to.z,
      color: color || '#00ffff'
    });
  }

  function syncDamageDealt(targetId, damage, attackerId, shot) {
    const payload = {
      type: 'damage-dealt',
      targetId,
      damage,
      attackerId: attackerId || localId()
    };
    if (shot?.from) {
      payload.from = { x: shot.from.x, y: shot.from.y, z: shot.from.z };
    }
    if (shot?.point || shot?.to) {
      const t = shot.point || shot.to;
      payload.point = { x: t.x, y: t.y, z: t.z };
    }
    if (shot?.sticky) payload.sticky = true;
    combatBroadcast(payload);
  }

  /** Show inbound shot FX (and death linger) from a known origin. */
  function showInboundShotFx(combat, shot, willKill) {
    if (!shot?.from || shot.sticky) return;
    const from = shot.from.clone
      ? shot.from.clone()
      : new THREE.Vector3(shot.from.x, shot.from.y, shot.from.z);
    const cam = document.getElementById('camera');
    const head = new THREE.Vector3();
    if (cam?.object3D) cam.object3D.getWorldPosition(head);
    // Prefer chest / shot point — do NOT snap non-kill tracers to the headset
    // (that made inbound beams end inside the camera → invisible head-on).
    let to = shot.to || shot.point;
    if (!to) {
      to = head.clone();
      to.y -= 0.5;
    } else {
      to = to.clone ? to.clone() : new THREE.Vector3(to.x, to.y, to.z);
    }
    if (willKill && cam?.object3D) {
      // Death linger still anchors near the victim, but pullFromCamera keeps tip visible.
      cam.object3D.getWorldPosition(to);
      to.y -= 0.35;
    }
    if (!hasLineOfSight(from, to, 0.2)) to = clipRayToCover(from, to);
    const visuals = spawnLaserVisuals(from, to, {
      linger: !!willKill,
      inbound: true,
      thick: true,
      pullFromCamera: true,
      dur: willKill ? null : 380,
      color: willKill ? '#ff2244' : '#ff6655',
      radius: willKill ? 0.04 : 0.03,
      hit: true
    });
    if (willKill) {
      if (visuals?.beam) visuals.beam.classList?.add?.('capvr-killshot');
      if (visuals?.thick) visuals.thick.classList?.add?.('capvr-killshot');
      const rig = document.getElementById('rig') || document.getElementById('player');
      const scene = document.querySelector('a-scene');
      retainKillingShot(rig, visuals);
      retainKillingShot(scene, visuals);
    }
  }

  function syncBotBodies() {
    BOT_MAP.forEach(({ bot, body, owner, team }) => {
      const botEl = document.getElementById(bot);
      const bodyEl = document.getElementById(body); // grabbable-ragdoll = loco + shatter
      if (!botEl) return;
      const st = botState[owner];
      if (bodyEl?.object3D) {
        bodyEl.object3D.visible = true;
        bodyEl.setAttribute('visible', true);
        const grab = bodyEl.components?.['grabbable-ragdoll'];
        if (!bodyEl._capvrVisApplied && grab?.modelLoaded) {
          applyCharacterVisibility(bodyEl, team);
          bodyEl._capvrVisApplied = true;
        }
        updateWorldBar(owner, st.hp, st.maxHp, !st.alive);
      }
      // Position/yaw/driveVel owned by capvr-bot-fix (don't fight shatter/ragdollActive).
    });
  }

  function restoreCombatBody(bodyEl, spawn) {
    if (!bodyEl?.object3D) return;
    const grab = bodyEl.components?.['grabbable-ragdoll'];
    if (grab) {
      try {
        if (typeof grab.resetRagdoll === 'function') grab.resetRagdoll();
        else if (typeof grab._disposeShatter === 'function') grab._disposeShatter();
      } catch (e) {
        console.warn('[CapVR] bot body reset failed', e);
      }
    }
    const y = (spawn.y || 2) - 1.0;
    bodyEl.object3D.position.set(spawn.x, y, spawn.z);
    bodyEl.setAttribute('position', `${spawn.x} ${y} ${spawn.z}`);
    bodyEl.object3D.visible = true;
    bodyEl.setAttribute('visible', true);
    if (grab) {
      if (grab._staticPose?.entityPos) {
        grab._staticPose.entityPos.set(spawn.x, y, spawn.z);
        if (grab._staticPose.entityQuat && bodyEl.object3D.quaternion) {
          grab._staticPose.entityQuat.copy(bodyEl.object3D.quaternion);
        }
      }
      if (grab._entityBasePos) grab._entityBasePos.set(spawn.x, y, spawn.z);
      if (grab.model) {
        grab.model.visible = true;
        grab.model.traverse((n) => {
          if (!n.isMesh && !n.isSkinnedMesh) return;
          n.visible = true;
          const mats = Array.isArray(n.material) ? n.material : [n.material];
          mats.forEach((m) => {
            if (!m) return;
            m.transparent = false;
            m.opacity = 1;
            m.colorWrite = true;
            m.depthWrite = true;
            m.needsUpdate = true;
          });
        });
      }
    }
  }

  function hideLocalHead() {
    const mixamo = localMixamo();
    if (!mixamo?.bones?.head || mixamo._capvrHeadHidden) return;
    const head = mixamo.bones.head;
    head.traverse?.((n) => { if (n.isMesh) n.visible = false; });
    mixamo._capvrHeadHidden = true;
  }

  function placeBot(owner) {
    const entry = BOT_MAP.find((b) => b.owner === owner);
    if (!entry) return;
    const botEl = document.getElementById(entry.bot);
    const bodyEl = document.getElementById(entry.body);
    const spawn = teamSpawn(entry.team, owner === 'bot-green' ? 1 : 0);
    if (botEl) {
      botEl.setAttribute('position', `${spawn.x} ${spawn.y} ${spawn.z}`);
      botEl.object3D.position.set(spawn.x, spawn.y, spawn.z);
      if (botEl.body?.position) botEl.body.position.set(spawn.x, spawn.y, spawn.z);
      if (botEl.body?.velocity) botEl.body.velocity.set(0, 0, 0);
      if (botEl.body?.angularVelocity) botEl.body.angularVelocity.set(0, 0, 0);
      const bc = botEl.components?.['zerog-bot'];
      if (bc) {
        bc.isGrabbingBall = false;
        bc.isStunned = false;
        bc._capvrDead = false;
        bc.navigationState = 'idle';
        bc.thrusterActive = bc.thrusterActive || { left: false, right: false };
        bc.thrusterActive.left = false;
        bc.thrusterActive.right = false;
        if (bc.velocity) bc.velocity.set(0, 0, 0);
      }
    }
    if (bodyEl) {
      bodyEl.setAttribute('visible', true);
      bodyEl.object3D.visible = true;
      bodyEl._capvrVisApplied = false;
      bodyEl._capvrTinted = false;
    }
    restoreCombatBody(bodyEl, { x: spawn.x, y: spawn.y, z: spawn.z });
    botState[owner].alive = true;
    botState[owner].hp = MAX_HP;
    botState[owner].respawnAt = 0;
    botState[owner].lastDamageAt = 0;
    botState[owner].lastRegenSyncAt = 0;
    updateWorldBar(owner, MAX_HP, MAX_HP, false);
    syncHealthNet(owner, MAX_HP, MAX_HP, false);
    document.dispatchEvent(new CustomEvent('entity-respawned', {
      detail: { entityId: owner, team: entry.team, entityType: 'bot' }
    }));
  }

  function _botCarryVelocity(owner) {
    const entry = BOT_MAP.find((b) => b.owner === owner);
    const botEl = entry && document.getElementById(entry.bot);
    const bc = botEl?.components?.['zerog-bot'];
    const v = bc?.velocity || botEl?.body?.velocity;
    if (!v) return null;
    return { x: v.x || 0, y: v.y || 0, z: v.z || 0 };
  }

  function killBot(owner, opts) {
    opts = opts || {};
    const st = botState[owner];
    if (!st || !st.alive) return;
    st.alive = false;
    st.hp = 0;
    st.respawnAt = performance.now() + RESPAWN_MS;
    document.dispatchEvent(new CustomEvent('combatant-died', { detail: { id: owner } }));
    document.dispatchEvent(new CustomEvent('entity-died', {
      detail: { entityId: owner, entityType: 'bot' }
    }));
    const entry = BOT_MAP.find((b) => b.owner === owner);
    const botEl = entry && document.getElementById(entry.bot);
    const bodyEl = entry && document.getElementById(entry.body);
    const bc = botEl?.components?.['zerog-bot'];
    // Capture flight momentum BEFORE clearing thruster drive.
    const carry = opts.carryVelocity || _botCarryVelocity(owner);
    if (bc) {
      bc._capvrDead = true;
      bc.isStunned = true;
      bc.stunEndTime = Date.now() + RESPAWN_MS + 250;
      bc.navigationState = 'idle';
      if (bc.thrusterActive) {
        bc.thrusterActive.left = false;
        bc.thrusterActive.right = false;
      }
    }
    // Collapse if damageBot hadn't already started a real ragdoll (sticky / no-point kills)
    const grab = bodyEl?.components?.['grabbable-ragdoll'];
    if (grab && !grab.ragdollActive && grab.shatterFromShot && !opts._collapsed) {
      try {
        const dir = opts.dir || new THREE.Vector3(0, -1, 0);
        const pt = opts.point
          ? (opts.point.clone ? opts.point.clone() : opts.point)
          : (bodyEl.object3D?.getWorldPosition(new THREE.Vector3()) || new THREE.Vector3());
        grab.shatterFromShot(pt, dir.clone().negate(), dir.clone(), 1.4, opts.regionId || null, {
          allowCollapse: true,
          carryVelocity: carry
        });
        if (grab.ragdollActive) opts._collapsed = true;
      } catch (e) { /* */ }
    } else if (grab?.ragdollActive && carry && typeof grab._applyCarryVelocityToRagdoll === 'function') {
      try { grab._applyCarryVelocityToRagdoll(carry); } catch (e) { /* */ }
    }
    // Stop AI drive AFTER corpse inherited momentum
    if (bc?.velocity) bc.velocity.set(0, 0, 0);
    if (botEl?.body?.velocity) botEl.body.velocity.set(0, 0, 0);
    updateWorldBar(owner, 0, MAX_HP, true);
    syncHealthNet(owner, 0, MAX_HP, true);
  }

  function isLethalHeadRegion(regionId) {
    return regionId === 'head' || regionId === 'neck';
  }

  /** True if this hit will finish destroying head/neck (REGION_DAMAGE_MAX stages). */
  function willDestroyHeadRegion(grab, regionId) {
    if (!grab || !isLethalHeadRegion(regionId)) return false;
    if (grab._destroyedRegionIds?.[regionId]) return true;
    const damageMax = window.RagdollShatter?.REGION_DAMAGE_MAX || 3;
    const prev = grab._regionDamage?.[regionId] || 0;
    return prev + 1 >= damageMax;
  }

  function headAlreadyDestroyed(grab) {
    if (!grab?._destroyedRegionIds) return false;
    return !!(grab._destroyedRegionIds.head || grab._destroyedRegionIds.neck);
  }

  function damageBot(owner, amount, opts) {
    opts = opts || {};
    const st = botState[owner];
    if (!st?.alive) return false;
    // Friendly laser → heal half (sticky blasts still damage; they never stick to teammates).
    // Never invent an attacker (localId default falsely treated enemy shots as friendly).
    if (shouldFriendlyHeal(opts.attackerId, owner, opts)) {
      return healBot(owner, healFromDamage(amount), opts);
    }
    // DIAGNOSTIC: skip the entire bot hit-response (damage, hit-react/shatter,
    // part removal, sfx, death/respawn) to isolate its cost. Re-enable: __capvrBotHit(true).
    if (window.__capvrBotHitOff === true) return false;
    const grabPre = opts.bodyEl?.components?.['grabbable-ragdoll'];
    // Head/neck fully destroyed ⇒ death (HP irrelevant)
    const headKill = willDestroyHeadRegion(grabPre, opts.regionId)
      || headAlreadyDestroyed(grabPre);
    if (headKill) st.hp = 0;
    else st.hp = Math.max(0, st.hp - amount);
    st.lastDamageAt = performance.now();
    updateWorldBar(owner, st.hp, st.maxHp, false);
    syncHealthNet(owner, st.hp, st.maxHp, false);
    let died = st.hp <= 0;
    if (opts.point && opts.bodyEl) {
      const grab = opts.bodyEl.components?.['grabbable-ragdoll'];
      if (grab?.shatterFromShot) {
        try {
          const dir = opts.dir || new THREE.Vector3(0, -1, 0);
          const carry = died ? _botCarryVelocity(owner) : null;
          if (carry) opts.carryVelocity = carry;
          grab.shatterFromShot(
            opts.point.clone(),
            dir.clone().negate(),
            dir.clone(),
            1,
            opts.regionId || null,
            { allowCollapse: died, carryVelocity: carry }
          );
          // Shatter just finished the head even if HP math missed it
          if (!died && headAlreadyDestroyed(grab)) {
            st.hp = 0;
            died = true;
          }
          // Only mark collapsed if a real ragdoll started (was incorrectly always set on death)
          if (died && grab.ragdollActive) opts._collapsed = true;
        } catch (e) { /* */ }
      }
      playImpactSfx(opts.point);
      const botId = BOT_MAP.find((b) => b.owner === owner)?.bot;
      const ie = document.getElementById(botId)?.querySelector?.('[impact-effect]');
      ie?.components?.['impact-effect']?.playEffect?.();
    }
    if (died) {
      killBot(owner, opts);
      return true;
    }
    return false;
  }

  function healBot(owner, amount, opts) {
    opts = opts || {};
    const st = botState[owner];
    if (!st?.alive) return false;
    const heal = Math.max(0, Math.floor(amount || 0));
    if (heal <= 0) return false;
    const before = st.hp;
    st.hp = Math.min(st.maxHp || MAX_HP, st.hp + heal);
    updateWorldBar(owner, st.hp, st.maxHp, false);
    if (st.hp !== before) syncHealthNet(owner, st.hp, st.maxHp, false);
    if (opts.point) playImpactSfx(opts.point);
    return false;
  }

  function tickHealthRegen(combat, dtMs) {
    if (!combat?.alive || combat.localHp >= combat.maxHp) return;
    const now = performance.now();
    if (!combat._lastDamageAt || now - combat._lastDamageAt < REGEN_DELAY_MS) return;
    const dt = Math.min(0.1, (dtMs || 16) / 1000);
    const before = combat.localHp;
    combat.localHp = Math.min(combat.maxHp, combat.localHp + REGEN_RATE * dt);
    if (combat.localHp === before) return;
    updateLocalHud(combat.localHp, combat.maxHp);
    if (!combat._lastRegenSyncAt || now - combat._lastRegenSyncAt >= REGEN_SYNC_MS) {
      combat._lastRegenSyncAt = now;
      syncHealthNet(localId(), combat.localHp, combat.maxHp, false);
    }
  }

  function tickBotHealthRegen(dtMs) {
    const now = performance.now();
    const dt = Math.min(0.1, (dtMs || 16) / 1000);
    Object.keys(botState).forEach((owner) => {
      const st = botState[owner];
      if (!st?.alive || st.hp >= st.maxHp) return;
      if (!st.lastDamageAt || now - st.lastDamageAt < REGEN_DELAY_MS) return;
      const before = st.hp;
      st.hp = Math.min(st.maxHp, st.hp + REGEN_RATE * dt);
      if (st.hp === before) return;
      updateWorldBar(owner, st.hp, st.maxHp, false);
      if (!st.lastRegenSyncAt || now - st.lastRegenSyncAt >= REGEN_SYNC_MS) {
        st.lastRegenSyncAt = now;
        syncHealthNet(owner, st.hp, st.maxHp, false);
      }
    });
  }

  function resetMatchCombat() {
    const combat = document.querySelector('[capvr-combat]')?.components?.['capvr-combat'];
    if (combat) {
      combat.localHp = MAX_HP;
      combat.maxHp = MAX_HP;
      combat.alive = true;
      combat._respawnAt = 0;
      combat._lastIncoming = null;
      combat._lastShotFrom = null;
      combat._lastShotTo = null;
      combat._queue = false;
      combat._nextFireAt = 0;
      combat._lastDamageAt = 0;
      combat._lastRegenSyncAt = 0;
      updateLocalHud(MAX_HP, MAX_HP);
    }
    const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
    if (zp) {
      zp.isStunned = false;
      zp.stunEndTime = 0;
      zp.stunImmunityEndTime = 0;
      if (zp.velocity) zp.velocity.set(0, 0, 0);
    }
    const localBody = document.getElementById('local-body');
    if (localBody) {
      const grab = localBody.components?.['grabbable-ragdoll'];
      try { grab?.resetRagdoll?.(); } catch (e) { /* */ }
    }
    document.querySelectorAll('.capvr-killshot, [data-capvr-killshot]').forEach((el) => el.remove());
    document.querySelectorAll('[zerog-ball]').forEach((el) => {
      const bc = el.components?.['zerog-ball'];
      if (!bc) return;
      bc._sticky = null;
      bc._capvrThrownAt = 0;
      bc._capvrStickyArmed = false;
    });
    BOT_MAP.forEach(({ owner }) => {
      botState[owner] = {
        alive: true, hp: MAX_HP, maxHp: MAX_HP, respawnAt: 0, lastDamageAt: 0, lastRegenSyncAt: 0
      };
      placeBot(owner);
    });
    const msg = document.querySelector('#hud-message');
    if (msg) {
      try { msg.setAttribute('visible', false); } catch (e) { /* */ }
    }
    syncHealthNet(localId(), MAX_HP, MAX_HP, false);
    console.log('[CapVR] combat match reset');
  }

  let _losRaycaster = null;
  /** Entity roots with grab-surface — BattleVR fireLaser pattern (recursive mesh hits). */
  const _losRoots = [];
  let _losRootCacheAt = 0;

  function _isLosIgnoredEl(el) {
    if (!el) return true;
    // NEVER use closest('[capvr-combat]') — combat lives on <a-scene>, so every
    // arena wall is under it and would be treated as "ignore" (static lasers miss).
    if (el.closest?.(
      '#player, #rig, #camera, #local-body, #leftHand, #rightHand, #left-hand, #right-hand, '
      + 'a-camera, #capvr-menu, #menu, #hud, #score-display'
    )) return true;
    if (el.hasAttribute?.('data-visual-only') || el.classList?.contains('wireframe-visual-only')) return true;
    if (el.id === 'red-goal' || el.id === 'blue-goal' || el.id === 'capture-ball') return true;
    if (el.id === 'player' || el.id === 'rig' || el.id === 'camera' || el.id === 'local-body') return true;
    if (el.hasAttribute?.('grabbable-ragdoll') || el.hasAttribute?.('mixamo-body')
      || el.hasAttribute?.('mixamo-body-avatar')) return true;
    if (el.hasAttribute?.('zerog-bot') || el.hasAttribute?.('zerog-ball')) return true;
    if (el.hasAttribute?.('zerog-player')) return true;
    if (el.classList?.contains('clickable') || el.classList?.contains('menu')) return true;
    if (el.classList?.contains('thruster-vfx') || el.classList?.contains('ctf-flag-xray')) return true;
    if (el.classList?.contains('ctf-flag-ball') || el.dataset?.flagTeam) return true;
    if (el.classList?.contains('capvr-contour') || el.classList?.contains('capvr-health-bar')) return true;
    if (el.id === 'flag-red' || el.id === 'flag-blue') return true;
    if (el.id === 'terrain') return true;
    return false;
  }

  function _elFromObject3D(obj) {
    let o = obj;
    while (o) {
      if (o.el) return o.el;
      o = o.parent;
    }
    return null;
  }

  function _isHitMeshSkipped(mesh) {
    if (!mesh) return true;
    if (mesh.visible === false) return true;
    const mat = mesh.material;
    const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
    // Wireframe overlays sit just outside solid faces — skip so we land on the solid.
    if (mats.length && mats.every((m) => m && m.wireframe)) return true;
    if (mats.length && mats.every((m) => m && m.transparent && m.opacity != null && m.opacity < 0.15)) {
      return true;
    }
    return false;
  }

  /**
   * BattleVR fireLaser: [grab-surface] triangle hits, near≈0.
   * CapVRRegression: filtering via closest('[capvr-combat]') emptied this list because
   * capvr-combat is on <a-scene> — every wall is a descendant.
   */
  function _refreshLosRoots() {
    _losRoots.length = 0;
    const T = (window.AFRAME && window.AFRAME.THREE) || window.THREE;
    document.querySelectorAll('[grab-surface]').forEach((el) => {
      if (_isLosIgnoredEl(el) || !el.object3D) return;
      if (el.object3D.visible === false) return;
      // HUD / menu only — NOT [capvr-combat] (that's the scene root)
      if (el.closest?.('#menu, #capvr-menu, #hud, #score-display')) return;
      _losRoots.push(el.object3D);
    });
    if (!_losRoots.length && !window.__capvrLosEmptyLogged) {
      window.__capvrLosEmptyLogged = true;
      console.warn('[CapVR] castEnvRay: no [grab-surface] occluders found');
    }
  }

  // Only skip tiny muzzle self-hits. Large near clips cause octa/tet back-face hits.
  const ENV_HIT_MIN_DIST = 0.02;

  function castEnvRay(ori, dir, maxDist) {
    if (!ori || !dir || !(maxDist > ENV_HIT_MIN_DIST)) return null;
    const T = (window.AFRAME && window.AFRAME.THREE) || window.THREE;
    if (!T) return null;
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const nd = new T.Vector3(dir.x / len, dir.y / len, dir.z / len);
    const origin = ori.isVector3 ? ori : new T.Vector3(ori.x, ori.y, ori.z);

    const now = performance.now();
    if (now - _losRootCacheAt > 400 || !_losRoots.length) {
      _refreshLosRoots();
      _losRootCacheAt = now;
    }
    if (!_losRoots.length) return null;

    // Always use A-Frame's THREE.Raycaster (dual Three.js copies otherwise miss all meshes)
    if (!_losRaycaster || _losRaycaster.__capvrT !== T) {
      _losRaycaster = new T.Raycaster();
      _losRaycaster.__capvrT = T;
    }
    _losRaycaster.set(origin, nd);
    _losRaycaster.near = ENV_HIT_MIN_DIST;
    _losRaycaster.far = maxDist;
    const hits = _losRaycaster.intersectObjects(_losRoots, true);
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!h || !(h.distance > ENV_HIT_MIN_DIST) || h.distance >= maxDist - 0.02) continue;
      const hitEl = _elFromObject3D(h.object);
      if (_isLosIgnoredEl(hitEl)) continue;
      if (_isHitMeshSkipped(h.object)) continue;
      const normal = h.face?.normal
        ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
        : nd.clone().negate();
      if (normal.dot(nd) > 0) normal.negate();
      return {
        point: h.point.clone(),
        distance: h.distance,
        normal
      };
    }
    return null;
  }

  /**
   * True if environment does not occlude the segment.
   * `slack` = how far short of the target we stop casting (so the target volume
   * itself isn't treated as a wall). Keep this tiny — large slack lets bots
   * shoot through cover you're hugging.
   */
  function hasLineOfSight(fromPos, toPos, slack) {
    if (!fromPos || !toPos) return false;
    const from = fromPos.clone ? fromPos.clone() : new THREE.Vector3(fromPos.x, fromPos.y, fromPos.z);
    const to = toPos.clone ? toPos.clone() : new THREE.Vector3(toPos.x, toPos.y, toPos.z);
    const dir = to.clone().sub(from);
    const dist = dir.length();
    if (dist < 0.08) return true;
    dir.multiplyScalar(1 / dist);
    const margin = slack != null ? slack : 0.06;
    // Cast almost to the target — walls within the last few cm still block
    const castDist = Math.max(0.1, dist - Math.max(0.02, margin));
    const hit = castEnvRay(from, dir, castDist);
    return !hit;
  }

  /** Strict combat LOS: direct ray + mid-height horizontal (blocks peeks over/through props). */
  function hasCombatLos(fromPos, toPos, slack) {
    const s = slack != null ? slack : 0.05;
    if (!hasLineOfSight(fromPos, toPos, s)) return false;
    const from = fromPos.clone ? fromPos.clone() : new THREE.Vector3(fromPos.x, fromPos.y, fromPos.z);
    const to = toPos.clone ? toPos.clone() : new THREE.Vector3(toPos.x, toPos.y, toPos.z);
    const midY = Math.min(from.y, to.y) + 0.5;
    return hasLineOfSight(
      new THREE.Vector3(from.x, midY, from.z),
      new THREE.Vector3(to.x, midY, to.z),
      s
    );
  }

  /**
   * Local player exposed at head (camera) + chest (local-body / below headset).
   * IMPORTANT: #player origin is already near headset height in zero-g — do NOT
   * add +1m to it (that aimed into the ceiling and made bots never shoot humans).
   */
  function localPlayerChestPos(out) {
    const o = out || new THREE.Vector3();
    const body = document.getElementById('local-body');
    if (body?.object3D) {
      // Mixamo root ≈ hips; chest is ~0.45m above hips (hips sit ~0.65 below eyes).
      body.object3D.getWorldPosition(o);
      o.y += 0.45;
      return o;
    }
    const cam = document.getElementById('camera');
    if (cam?.object3D) {
      cam.object3D.getWorldPosition(o);
      o.y -= 0.55;
      return o;
    }
    return null;
  }

  function hasLosToLocalPlayer(fromPos, slack) {
    if (!fromPos) return false;
    const from = fromPos.clone ? fromPos.clone() : new THREE.Vector3(fromPos.x, fromPos.y, fromPos.z);
    const s = slack != null ? slack : 0.05;
    const head = new THREE.Vector3();
    const torso = new THREE.Vector3();
    const cam = document.getElementById('camera');
    if (!cam?.object3D) return false;
    cam.object3D.getWorldPosition(head);
    if (!localPlayerChestPos(torso)) {
      torso.copy(head);
      torso.y -= 0.55;
    }
    // Head is what you see — if head is blocked you're in cover
    if (!hasCombatLos(from, head, s)) return false;
    // Chest / torso (body aim point)
    if (!hasCombatLos(from, torso, s)) return false;
    return true;
  }

  /** Real surface hit point along ray, or null on a clean miss. */
  function envRayHit(ori, dir, maxDist) {
    return castEnvRay(ori, dir, maxDist);
  }

  function envRayEnd(ori, dir, maxDist) {
    const hit = castEnvRay(ori, dir, maxDist);
    if (hit) return hit.point;
    return ori.clone().addScaledVector(
      dir.clone().normalize(),
      maxDist
    );
  }

  /** Clip a segment to the first wall. Returns end point. */
  function clipRayToCover(fromPos, toPos) {
    const from = fromPos.clone ? fromPos.clone() : new THREE.Vector3(fromPos.x, fromPos.y, fromPos.z);
    const to = toPos.clone ? toPos.clone() : new THREE.Vector3(toPos.x, toPos.y, toPos.z);
    const dir = to.clone().sub(from);
    const dist = dir.length();
    if (dist < 0.05) return to;
    dir.multiplyScalar(1 / dist);
    const hit = castEnvRay(from, dir, dist);
    if (hit && hit.distance < dist - 0.15) return hit.point;
    return to;
  }

  /**
   * True when the local shooting arm is clipping static geometry.
   * Uses the RAW controller pose (not IK-clamped palm) — IK can park the visual
   * hand on the near face while the tracker is deep inside / through the far side.
   * Fire-only: a few short env rays + optional Box3D overlaps (cheap).
   */
  const _clipShoulder = new THREE.Vector3();
  const _clipMuzzle = new THREE.Vector3();
  const _clipCtrl = new THREE.Vector3();
  const _clipProbe = new THREE.Vector3();
  const _clipDir = new THREE.Vector3();

  function _pointInsideEnv(p, radius) {
    const phys = window.CapVRPhysics?.get?.();
    const q = phys?.queries;
    if (!q?.sphereOverlaps || !p) return false;
    const r = radius != null ? radius : 0.035;
    try {
      return !!q.sphereOverlaps(
        { x: p.x, y: p.y, z: p.z },
        r,
        phys.playerShapeIds || null
      );
    } catch (e) {
      return false;
    }
  }

  /** Wall between A and B (hand past the hit surface / punched through). */
  function _segmentCrossesEnv(from, to, slack) {
    _clipDir.copy(to).sub(from);
    const dist = _clipDir.length();
    if (dist < 0.06) return false;
    _clipDir.multiplyScalar(1 / dist);
    const skin = slack != null ? slack : 0.05;
    const hit = castEnvRay(from, _clipDir, dist);
    return !!(hit && hit.distance < dist - skin);
  }

  function isLocalWeaponArmClipping(hand, muzzleOpt) {
    hand = hand || 'right';
    const mixamo = localMixamo();
    const ctrl = handEl(hand);
    const aim = muzzleOpt?.origin
      ? muzzleOpt
      : (mixamo?.getHandShotAim ? mixamo.getHandShotAim(hand) : null);

    // True tracked hand — not the IK palm that collision clamps onto the surface.
    if (ctrl?.object3D) {
      ctrl.object3D.getWorldPosition(_clipCtrl);
    } else if (aim?.origin) {
      _clipCtrl.copy(aim.origin);
    } else {
      return false;
    }

    if (aim?.origin) _clipMuzzle.copy(aim.origin);
    else _clipMuzzle.copy(_clipCtrl);

    const shoulderBone = mixamo?.bones?.[`${hand}UpperArm`]
      || mixamo?.bones?.[`${hand}Shoulder`];
    if (shoulderBone) {
      shoulderBone.getWorldPosition(_clipShoulder);
    } else {
      const cam = document.getElementById('camera');
      if (!cam?.object3D) return false;
      cam.object3D.getWorldPosition(_clipShoulder);
      _clipShoulder.y -= 0.15;
    }

    // Primary: wall between shoulder and REAL controller (covers deep embed + punch-through).
    if (_segmentCrossesEnv(_clipShoulder, _clipCtrl, 0.04)) return true;

    // IK muzzle can still sit past cover if clamp lost tracking.
    if (_segmentCrossesEnv(_clipShoulder, _clipMuzzle, 0.04)) return true;

    // Solid ENV volumes (boxes): overlap at controller + mid-arm samples.
    // Trimesh interiors often miss overlaps — segment test above is the mesh path.
    if (_pointInsideEnv(_clipCtrl, 0.045)) return true;
    if (_pointInsideEnv(_clipMuzzle, 0.04)) return true;
    for (let t = 0.35; t <= 0.85; t += 0.25) {
      _clipProbe.copy(_clipShoulder).lerp(_clipCtrl, t);
      if (_pointInsideEnv(_clipProbe, 0.04)) return true;
    }

    // Controller deep past the posed/clamped palm = still shoved into the wall.
    // (Palm sits on near face; tracker is further along the same direction.)
    const palmToCtrl = _clipCtrl.distanceTo(_clipMuzzle);
    if (palmToCtrl > 0.06) {
      if (_segmentCrossesEnv(_clipMuzzle, _clipCtrl, 0.02)) return true;
      _clipDir.copy(_clipCtrl).sub(_clipShoulder);
      const armLen = _clipDir.length() || 1;
      _clipDir.multiplyScalar(1 / armLen);
      _clipProbe.copy(_clipMuzzle).sub(_clipShoulder);
      const muzzleAlong = _clipProbe.dot(_clipDir);
      if (armLen - muzzleAlong > 0.07) return true;
    }

    return false;
  }

  function refuseFireIfArmClipping(hand, muzzleOpt) {
    const clipping = isLocalWeaponArmClipping(hand || 'right', muzzleOpt);
    const combat = document.querySelector('[capvr-combat]')?.components?.['capvr-combat'];
    if (combat) {
      combat._armClipping = clipping;
      combat._armClippingHand = hand || 'right';
      combat._armClippingAt = performance.now();
    }
    return clipping;
  }

  function getCombatantWorldPos(ownerId, out) {
    const dest = out || new THREE.Vector3();
    if (!ownerId) return null;
    const sid = String(ownerId);
    if (sid === localId() || sid === 'player' || sid === 'rig') {
      const p = document.getElementById('player') || document.getElementById('rig');
      if (!p?.object3D) return null;
      p.object3D.getWorldPosition(dest);
      return dest;
    }
    if (sid.startsWith('player_')) {
      const idx = sid.replace(/^player_?/, '');
      const el = document.getElementById(`remote-target-${idx}`)
        || document.getElementById(`remote-player-${idx}`)
        || document.getElementById(`remote-body-${idx}`);
      if (!el?.object3D) return null;
      el.object3D.getWorldPosition(dest);
      return dest;
    }
    const botOwner = sid.replace(/^zerog-/, '');
    const botEl = document.getElementById(`zerog-${botOwner}`) || document.getElementById(botOwner);
    if (botEl?.body?.position) {
      dest.set(botEl.body.position.x, botEl.body.position.y, botEl.body.position.z);
      return dest;
    }
    if (botEl?.object3D) {
      botEl.object3D.getWorldPosition(dest);
      return dest;
    }
    return null;
  }

  /** Spatial stun-reboot.wav at victim center for the stun duration (~5s clip). */
  function playStunRebootAt(pos, durationMs) {
    if (!pos || window.__capvrFxOff === true) return;
    const scene = document.querySelector('a-scene');
    if (!scene) return;
    const dur = durationMs || STICKY_STUN_MS;
    try {
      const el = document.createElement('a-entity');
      el.classList.add('capvr-stun-sfx');
      el.setAttribute('position', `${pos.x} ${pos.y} ${pos.z}`);
      el.setAttribute('sound', {
        src: 'url(audio/stun-reboot.wav)',
        autoplay: true,
        loop: false,
        volume: 1.0,
        positional: true,
        distanceModel: 'inverse',
        refDistance: 1.5,
        maxDistance: 28,
        rolloffFactor: 1.2,
        poolSize: 1
      });
      scene.appendChild(el);
      const start = () => {
        try {
          el.components?.sound?.playSound?.();
        } catch (e) { /* */ }
      };
      if (el.components?.sound) start();
      else el.addEventListener('sound-loaded', start, { once: true });
      setTimeout(() => {
        try {
          el.components?.sound?.stopSound?.();
          el.remove();
        } catch (e2) {
          try { el.remove(); } catch (e3) { /* */ }
        }
      }, dur + 250);
    } catch (e) { /* */ }
  }

  function applyStunToLocalPlayer(durationMs) {
    const player = document.querySelector('[zerog-player]');
    const zp = player?.components?.['zerog-player'];
    if (!zp) return false;
    const now = Date.now();
    if (zp.stunImmunityEndTime && now < zp.stunImmunityEndTime) return false;
    const ms = durationMs || STICKY_STUN_MS;
    zp.velocity?.set?.(0, 0, 0);
    zp.isStunned = true;
    zp.stunEndTime = now + ms;
    zp.stunImmunityEndTime = now + ms + STICKY_STUN_IMMUNITY_MS;
    window.CapVRFlags?.dropFromOwner?.(localId());
    const pos = getCombatantWorldPos(localId());
    if (pos) playStunRebootAt(pos, ms);
    document.dispatchEvent(new CustomEvent('capvr-player-stunned', {
      detail: { ownerId: localId(), durationMs: ms }
    }));
    return true;
  }

  function applyStunToBot(owner, durationMs) {
    const botOwner = String(owner || '').replace(/^zerog-/, '');
    if (!botOwner || !botState[botOwner]?.alive) return false;
    const botEl = document.getElementById(`zerog-${botOwner}`);
    const bc = botEl?.components?.['zerog-bot'];
    if (!bc) return false;
    const now = Date.now();
    if (bc.stunImmunityEndTime && now < bc.stunImmunityEndTime) return false;
    const ms = durationMs || STICKY_STUN_MS;
    if (bc.velocity) bc.velocity.set(0, 0, 0);
    if (botEl.body?.velocity) botEl.body.velocity.set(0, 0, 0);
    bc.isStunned = true;
    bc.stunEndTime = now + ms;
    bc.stunImmunityEndTime = now + ms + STICKY_STUN_IMMUNITY_MS;
    window.CapVRFlags?.dropFromOwner?.(botOwner);
    const pos = getCombatantWorldPos(botOwner);
    if (pos) playStunRebootAt(pos, ms);
    document.dispatchEvent(new CustomEvent('capvr-bot-stunned', {
      detail: { ownerId: botOwner, durationMs: ms }
    }));
    return true;
  }

  /** Stun a combatant by id (player_N / bot-red / local). Plays spatial reboot SFX. */
  function applyStunToOwner(ownerId, durationMs) {
    if (!ownerId) return false;
    const sid = String(ownerId);
    const ms = durationMs || STICKY_STUN_MS;
    if (sid === localId() || sid === 'player' || sid === 'rig') {
      return applyStunToLocalPlayer(ms);
    }
    if (sid.startsWith('bot-') || sid.startsWith('zerog-bot-')) {
      return applyStunToBot(sid.replace(/^zerog-/, ''), ms);
    }
    if (sid.startsWith('player_')) {
      // Remote human: local client only stuns if it's us; peers play SFX at their avatar
      if (sid === localId()) return applyStunToLocalPlayer(ms);
      const pos = getCombatantWorldPos(sid);
      if (pos) playStunRebootAt(pos, ms);
      document.dispatchEvent(new CustomEvent('capvr-remote-stunned', {
        detail: { ownerId: sid, durationMs: ms }
      }));
      return true;
    }
    return false;
  }

  function resolveStickyPrimaryOwner(detail) {
    if (detail?.targetPlayerId) return detail.targetPlayerId;
    const tid = detail?.targetId || '';
    if (tid === 'player' || tid === 'rig') return localId();
    if (String(tid).startsWith('remote-target-')) {
      return `player_${String(tid).replace('remote-target-', '')}`;
    }
    if (String(tid).startsWith('zerog-')) return String(tid).replace('zerog-', '');
    if (String(tid).startsWith('bot-')) return tid;
    return null;
  }

  /**
   * Sticky boom: stun attach target + same-team allies inside STICKY_STUN_RADIUS (2.4m).
   * No HP damage. Returns list of stunned owner ids.
   */
  function applyStickyStunBlast(detail) {
    const pos = detail?.position;
    if (!pos) return [];
    const center = pos.clone
      ? pos.clone()
      : new THREE.Vector3(pos.x, pos.y, pos.z);
    const primary = resolveStickyPrimaryOwner(detail);
    if (!primary) return [];
    const team = resolveCombatTeam(primary);
    const ms = detail.durationMs || STICKY_STUN_MS;
    const radius = detail.radius != null ? detail.radius : STICKY_STUN_RADIUS;
    const victims = new Set();
    victims.add(primary);

    if (team) {
      // Local human
      if (resolveCombatTeam(localId()) === team) {
        const lp = getCombatantWorldPos(localId());
        if (lp && (primary === localId() || lp.distanceTo(center) <= radius)) {
          victims.add(localId());
        }
      }
      // Remote humans
      for (let i = 0; i < 4; i++) {
        const pid = `player_${i}`;
        if (resolveCombatTeam(pid) !== team) continue;
        const rp = getCombatantWorldPos(pid);
        if (!rp) continue;
        if (pid === primary || rp.distanceTo(center) <= radius) victims.add(pid);
      }
      // Bots
      BOT_MAP.forEach(({ owner }) => {
        if (resolveCombatTeam(owner) !== team) return;
        if (!botState[owner]?.alive) return;
        const bp = getCombatantWorldPos(owner);
        if (!bp) return;
        if (owner === primary || bp.distanceTo(center) <= radius) victims.add(owner);
      });
    }

    const stunned = [];
    victims.forEach((id) => {
      if (applyStunToOwner(id, ms)) stunned.push(id);
    });
    return stunned;
  }

  function applyStickyShatters(bodyEl, center, count) {
    const grab = bodyEl?.components?.['grabbable-ragdoll'];
    if (!grab?.shatterFromShot || !center) return;
    const dir = new THREE.Vector3(0, -1, 0);
    for (let i = 0; i < count; i++) {
      const pt = center.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.25,
        (Math.random() - 0.5) * 0.35,
        (Math.random() - 0.5) * 0.25
      ));
      try {
        grab.shatterFromShot(pt, dir.clone().negate(), dir.clone(), 1.2, null, {
          allowCollapse: false
        });
      } catch (e) { /* */ }
    }
    playImpactSfx(center);
  }

  function patchRagdollShooter() {
    const comp = AFRAME.components['ragdoll-shooter'];
    if (!comp?.Component?.prototype || comp.Component.prototype._capvrMulti) return;
    const proto = comp.Component.prototype;
    proto._capvrMulti = true;
    proto._getMixamoBody = function () { return localMixamo(); };

    proto._fireShot = function (fromVrHand) {
      const combat = document.querySelector('[capvr-combat]')?.components?.['capvr-combat'];
      if (combat && !combat.alive) return;
      const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
      if (zp?.isStunned && Date.now() < (zp.stunEndTime || 0)) return;
      if (combat && performance.now() < (combat._nextFireAt || 0)) return;

      if (fromVrHand) {
        const mixamo = localMixamo();
        if (mixamo?.getHandShotAim) {
          const aim = mixamo.getHandShotAim('right');
          if (aim?.origin) {
            this._rayOri.copy(aim.origin);
            this._rayDir.copy(aim.direction).normalize();
          } else if (!this._aimFromCamera?.()) return;
        } else if (!this._refreshVrAimPreview?.() && !this._aimFromCamera?.()) return;
      } else if (!this._aimFromCamera?.()) {
        return;
      }

      // Hand / arm through static geometry → no shot (blocks "fire from inside wall").
      if (refuseFireIfArmClipping('right', { ok: true, origin: this._rayOri })) {
        return;
      }

      if (combat) combat._nextFireAt = performance.now() + FIRE_COOLDOWN_MS;

      playLaserFireSfx();

      const envHitPre = castEnvRay(this._rayOri, this._rayDir, MAX_RANGE);
      const envDistPre = envHitPre ? envHitPre.distance : MAX_RANGE;
      // Multiplayer PvP: hit remote player proxies before bot limbs / walls
      const remoteHit = window.CapVRMp?.raycastRemotePlayers?.(
        this._rayOri, this._rayDir, MAX_RANGE
      );
      if (remoteHit && remoteHit.distance < envDistPre - 0.05) {
        spawnLaserVisuals(this._rayOri, remoteHit.point, { hit: true, color: '#00ffff' });
        if (typeof this._spawnFlash === 'function') {
          this._spawnFlash(this._rayOri, remoteHit.point, true);
        }
        syncWeaponFired(this._rayOri, remoteHit.point, '#00ffff');
        const shot = {
          point: remoteHit.point,
          from: this._rayOri.clone()
        };
        if (window.CapVRGame?.isMultiplayer?.()) {
          if (window.CapVRGame.isHost?.()) {
            applyPlayerDamageAuthority(remoteHit.playerId, LASER_DAMAGE, shot);
          } else {
            proposePlayerDamage(remoteHit.playerId, LASER_DAMAGE, shot);
          }
        }
        playImpactSfx(remoteHit.point);
        return;
      }

      // Prefer capsule aim preview over skinned-mesh raycastFromShot (55k tris ×
      // bone re-skin per body per shot = the measured shooting-bots hitch).
      // Toggle: __capvrShooterFast(false) for precise mesh hits.
      const fastHit = window.__capvrShooterFastHit !== false;
      let best = null;
      let bestDist = MAX_RANGE;
      document.querySelectorAll('[grabbable-ragdoll]').forEach((el) => {
        if (!el.object3D?.visible) return;
        // Skip practice dummies / paused / non-combat proxies (phantom mid-air capsules).
        if (el.id === 'grab-dummy' || el.dataset?.botId == null) return;
        const grab = el.components?.['grabbable-ragdoll'];
        if (!grab || grab.data?.paused) return;
        const hit = (fastHit && grab.raycastAimPreview)
          ? grab.raycastAimPreview(this._rayOri, this._rayDir, MAX_RANGE)
          : grab.raycastFromShot?.(this._rayOri, this._rayDir, MAX_RANGE);
        if (hit && hit.distance < bestDist) {
          bestDist = hit.distance;
          best = { grab, hit, el };
        }
      });

      const envHit = envHitPre;
      const envDist = envDistPre;
      // Wall closer than body → blocked (no wallhack damage)
      if (best && bestDist >= envDist - 0.05) best = null;

      const didHit = !!(best || envHit);
      const end = best?.hit?.point
        || (envHit ? envHit.point : envRayEnd(this._rayOri, this._rayDir, MAX_RANGE));
      const visuals = spawnLaserVisuals(this._rayOri, end, { hit: didHit, color: '#00ffff' });
      if (typeof this._spawnFlash === 'function') this._spawnFlash(this._rayOri, end, didHit);
      document.dispatchEvent(new CustomEvent('capvr-laser', {
        detail: { from: this._rayOri.clone(), to: end.clone ? end.clone() : end, skipVisual: true }
      }));
      syncWeaponFired(this._rayOri, end, '#00ffff');

      if (!best?.el) {
        // Wall / static/dynamic prop hit — metal sparks. Clean miss — silence.
        if (envHit?.point) playImpactSfx(envHit.point);
        return;
      }
      // Never shatter here — damageBot owns shatter + allowCollapse (HP-gated).
      if (window.CapVRCombat) window.CapVRCombat._lastShotAt = performance.now();
      playImpactSfx(best.hit.point);
      document.dispatchEvent(new CustomEvent('capvr-limb-hit', {
        detail: {
          el: best.el,
          regionId: best.hit.regionId,
          credited: true,
          point: best.hit.point,
          dir: this._rayDir.clone(),
          damage: LASER_DAMAGE,
          visuals
        }
      }));
      const botId = best.el?.dataset?.botId;
      // CapVRMp: clients propose via damageBot only (avoid double damage-dealt)
      if (botId && !(window.CapVRGame?.isMultiplayer?.() && window.CapVRGame?.isHost?.() === false)) {
        syncDamageDealt(botId.replace('zerog-', ''), LASER_DAMAGE, localId());
      }
    };
  }

  AFRAME.registerComponent('capvr-combat', {
    init: function () {
      this._triggerWas = false;
      this._queue = false;
      this.localHp = MAX_HP;
      this.maxHp = MAX_HP;
      this.alive = true;
      this._respawnAt = 0;
      this._nextFireAt = 0;
      this._lastDamageAt = 0;
      this._lastRegenSyncAt = 0;
      this.cameraEl = document.querySelector('#camera');
      this._ori = new THREE.Vector3();
      this._dir = new THREE.Vector3();
      this._hasSceneShooter = this.el.hasAttribute('ragdoll-shooter');
      this._lastShotFrom = null;
      this._lastShotTo = null;

      purgeDuplicateCombatBodies();
      setTimeout(purgeDuplicateCombatBodies, 2500);
      patchRagdollShooter();
      setTimeout(patchRagdollShooter, 2000);
      ensureMetalHitSounds();
      ensureHud();
      updateLocalHud(this.localHp, this.maxHp);

      this._onMouse = (e) => {
        if (e.button !== 0 || this.el.is('vr-mode') || this._hasSceneShooter) return;
        if (!this.alive) return;
        this._queue = true;
      };
      window.addEventListener('mousedown', this._onMouse, true);

      document.addEventListener('local-player-shot', (e) => {
        const d = e.detail || {};
        // Non-sticky lasers must declare an origin — refuse phantom / ball leftover hits.
        if (!d.sticky && !d.from) return;
        // Hard gate: no laser HP through cover, and no damage from outside the field.
        if (d.from && (d.to || d.point) && !d.sticky) {
          const fromV = d.from.clone ? d.from.clone()
            : new THREE.Vector3(d.from.x, d.from.y, d.from.z);
          const to = d.to || d.point;
          const toV = to.clone ? to.clone() : new THREE.Vector3(to.x, to.y, to.z);
          const outside = Math.abs(fromV.x) > 20 || Math.abs(fromV.z) > 40
            || fromV.y < -0.5 || fromV.y > 12;
          // Strict cover: head+torso combat LOS (slack was 0.25 — hugged walls "didn't exist")
          const clear = hasLosToLocalPlayer(fromV, 0.05);
          if (outside || !clear) {
            const dir = toV.clone().sub(fromV);
            const dist = dir.length() || 1;
            dir.multiplyScalar(1 / dist);
            const wall = castEnvRay(fromV, dir, dist);
            if (wall?.point) {
              spawnLaserVisuals(fromV, wall.point, { hit: false, color: '#ff6655' });
              playImpactSfx(wall.point);
            }
            return;
          }
        }
        // Keep last inbound tracer so a killing blow always has a visible origin
        if (d.from && d.to) this._lastIncoming = d;
        else if (d.point && d.dir) this._lastIncoming = d;
        this._hurt(d.damage || LASER_DAMAGE, d);
      });
      document.addEventListener('capvr-limb-hit', (e) => this._onLimbHit(e.detail));
      document.addEventListener('sticky-bomb-detonate', (e) => this._onStickyBlast(e.detail));
      setTimeout(ensureBotVisibility, 1200);
      setTimeout(ensureBotVisibility, 3500);

      console.log('[CapVR] combat ready (HUD + deathcam + laser SFX)');
    },

    tick: function (t, dt) {
      updateHitSparks((dt || 16) / 1000); // XR-safe spark lifecycle (must run even when dead)
      tickHumanDeathTumbles((dt || 16) / 1000);
      syncBotBodies();
      hideLocalHead();
      this._tickBotRespawns();
      tickBotHealthRegen(dt);
      updateLocalHud(this.alive ? this.localHp : 0, this.maxHp);

      if (!this.alive) {
        if (performance.now() >= this._respawnAt) this._respawn();
        return;
      }
      tickHealthRegen(this, dt);
      if (this._hasSceneShooter) return;
      const rh = handEl('right');
      const gp = rh?.components?.['tracked-controls']?.controller?.gamepad;
      const btn = gp?.buttons?.[0];
      const pressed = !!(btn && (btn.pressed || btn.value > 0.7));
      if (pressed && !this._triggerWas) this._queue = true;
      this._triggerWas = pressed;
      if (this._queue) {
        this._queue = false;
        this.fire();
      }
    },

    _tickBotRespawns: function () {
      const now = performance.now();
      Object.keys(botState).forEach((owner) => {
        const st = botState[owner];
        if (!st.alive && st.respawnAt && now >= st.respawnAt) {
          placeBot(owner);
        }
      });
    },

    _onStickyBlast: function (detail) {
      // Sticky boom: stun only (no HP / shatter). Sphere = STICKY_STUN_RADIUS (2.4m).
      const stunned = applyStickyStunBlast(detail);
      if (detail) detail._stunnedVictims = stunned;
      const pos = detail?.position;
      if (pos) {
        const center = pos.clone
          ? pos.clone()
          : new THREE.Vector3(pos.x, pos.y, pos.z);
        // Brief boom cue (non-synth). Stun reboot SFX already plays per victim.
        const boom = document.querySelector('#bounce-sound');
        if (boom?.components?.sound) {
          try {
            boom.setAttribute('position', `${center.x} ${center.y} ${center.z}`);
            boom.components.sound.stopSound?.();
            boom.components.sound.playSound();
          } catch (e) { /* */ }
        }
      }
      if (stunned.length) {
        document.dispatchEvent(new CustomEvent('capvr-sticky-stun', {
          detail: {
            victims: stunned,
            position: detail.position,
            durationMs: STICKY_STUN_MS,
            radius: STICKY_STUN_RADIUS,
            primary: resolveStickyPrimaryOwner(detail)
          }
        }));
      }
    },

    fire: function () {
      if (!this.alive || !this._aim()) return;
      const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
      if (zp?.isStunned && Date.now() < (zp.stunEndTime || 0)) return;
      if (performance.now() < this._nextFireAt) return;
      // Hand / arm clipping statics → refuse fire entirely (no beam through walls).
      if (refuseFireIfArmClipping('right', { ok: true, origin: this._ori })) return;
      this._nextFireAt = performance.now() + FIRE_COOLDOWN_MS;
      playLaserFireSfx();
      const bodyHit = this._raycast();
      const envHit = castEnvRay(this._ori, this._dir, MAX_RANGE);
      const envDist = envHit ? envHit.distance : MAX_RANGE;
      // Wall closer than body → blocked (no wallhack damage)
      const hit = (bodyHit && bodyHit.distance < envDist - 0.05) ? bodyHit : null;
      const didHit = !!(hit || envHit);
      const end = hit?.point
        || (envHit ? envHit.point : envRayEnd(this._ori, this._dir, MAX_RANGE));
      this._lastShotFrom = this._ori.clone();
      this._lastShotTo = end.clone();
      spawnLaserVisuals(this._ori, end, { hit: didHit, color: '#00ffff' });
      document.dispatchEvent(new CustomEvent('capvr-laser', {
        detail: { from: this._ori.clone(), to: end.clone(), skipVisual: true }
      }));
      syncWeaponFired(this._ori, end, '#00ffff');
      if (!hit) {
        if (envHit?.point) playImpactSfx(envHit.point);
        return;
      }
      // Shatter once via damageBot (allowCollapse only on kill) — do not double-shatter here.
      if (window.CapVRCombat) window.CapVRCombat._lastShotAt = performance.now();
      playImpactSfx(hit.point);
      this._onLimbHit({
        el: hit.el,
        regionId: hit.regionId,
        credited: true,
        point: hit.point,
        dir: this._dir.clone(),
        damage: LASER_DAMAGE
      });
      const botId = hit.el?.dataset?.botId;
      // Host listen-server helper; CapVRMp mutes this on clients (they propose via damageBot).
      if (botId) {
        const owner = botId.replace('zerog-', '');
        if (!(window.CapVRGame?.isMultiplayer?.() && window.CapVRGame?.isHost?.() === false)) {
          syncDamageDealt(owner, LASER_DAMAGE, localId());
        }
      }
    },

    _aim: function () {
      const mixamo = localMixamo();
      if (this.el.is('vr-mode') && mixamo?.getHandShotAim) {
        const aim = mixamo.getHandShotAim('right');
        if (aim?.origin) {
          this._ori.copy(aim.origin);
          this._dir.copy(aim.direction).normalize();
          return true;
        }
      }
      const rh = handEl('right');
      if (this.el.is('vr-mode') && rh?.object3D) {
        rh.object3D.getWorldPosition(this._ori);
        rh.object3D.getWorldDirection(this._dir);
        this._dir.negate();
        return true;
      }
      const cam = this.cameraEl?.getObject3D?.('camera') || this.cameraEl?.object3D;
      if (!cam) return false;
      cam.getWorldPosition(this._ori);
      cam.getWorldDirection(this._dir);
      this._dir.negate();
      return true;
    },

    _raycast: function () {
      const fastHit = window.__capvrShooterFastHit !== false;
      let best = null;
      let bestDist = MAX_RANGE;
      document.querySelectorAll('[grabbable-ragdoll]').forEach((el) => {
        if (!el.object3D?.visible) return;
        if (el.id === 'grab-dummy' || el.dataset?.botId == null) return;
        const grab = el.components?.['grabbable-ragdoll'];
        if (!grab || grab.data?.paused) return;
        const hit = (fastHit && grab.raycastAimPreview)
          ? grab.raycastAimPreview(this._ori, this._dir, MAX_RANGE)
          : grab.raycastFromShot?.(this._ori, this._dir, MAX_RANGE);
        if (hit && hit.distance < bestDist) {
          bestDist = hit.distance;
          best = { el, point: hit.point, normal: hit.normal, regionId: hit.regionId, distance: hit.distance };
        }
      });
      return best;
    },

    _onLimbHit: function (detail) {
      const el = detail?.el;
      const botId = el?.dataset?.botId;
      if (!botId) return;
      const owner = botId.replace('zerog-', '');
      if (!botState[owner]?.alive) return;
      const recentShot = (performance.now() - (window.CapVRCombat?._lastShotAt || 0)) < HIT_CREDIT_MS;
      if (!detail?.credited && !recentShot && !detail?.force) return;
      // DIAGNOSTIC: must gate BEFORE knockback. damageBot alone was returning early
      // while the velocity shove below still ran — bots "relocated" on every hit and
      // that shove was the leftover response the earlier kill-switch missed.
      if (window.__capvrBotHitOff === true) return;
      const dmg = detail.damage || LASER_DAMAGE;
      const attacker = resolveHitAttackerId(detail);
      const friendly = areCombatTeammates(attacker, owner);
      damageBot(owner, dmg, {
        bodyEl: el,
        point: detail.point,
        dir: detail.dir || this._dir,
        regionId: detail.regionId,
        attackerId: attacker
      });
      if (friendly) return;
      const botEl = document.getElementById(botId);
      const bc = botEl?.components?.['zerog-bot'];
      const knockDir = detail.dir || this._dir;
      if (bc?.velocity && knockDir) {
        bc.velocity.x += knockDir.x * 3;
        bc.velocity.y += knockDir.y * 3 + 1;
        bc.velocity.z += knockDir.z * 3;
      }
    },

    _hurt: function (n, detail) {
      if (!this.alive) return;
      const src = detail || this._lastIncoming || {};
      // Friendly laser → heal half instead of damage (sticky never applies here as teammate stick).
      const attackerKey = src.fromTeam || src.attackerId;
      if (!src.sticky && shouldFriendlyHeal(attackerKey, localId(), src)) {
        this._heal(healFromDamage(n || LASER_DAMAGE), src);
        return;
      }
      const amount = n || LASER_DAMAGE;
      const willKill = this.localHp - amount <= 0;
      // Refuse phantom laser HP (no origin). Sticky/explosion may use blast center as from.
      if (!src.sticky && !src.from) {
        console.warn('[CapVR] ignored hurt without shot origin');
        return;
      }
      if (src.sticky && !src.from && src.point) src.from = src.point;
      if (src.from && !src.sticky) this._lastIncoming = src;

      // Deathcam / inbound tracer ONLY for a real shot origin — never invent a shooter.
      showInboundShotFx(this, src, willKill);

      this.localHp -= amount;
      this._lastDamageAt = performance.now();
      updateLocalHud(Math.max(0, this.localHp), this.maxHp);
      syncHealthNet(localId(), Math.max(0, this.localHp), this.maxHp, this.localHp <= 0, {
        from: src.from,
        to: src.to || src.point,
        point: src.point,
        sticky: src.sticky,
        attackerId: src.fromTeam || src.attackerId
      });
      playImpactSfx(detail?.point);
      document.querySelector('#player-target')?.components?.['impact-effect']?.playEffect?.();
      document.dispatchEvent(new CustomEvent('entity-damaged', {
        detail: { entityId: localId(), newHealth: this.localHp, team: null }
      }));

      if (this.localHp <= 0) {
        this.localHp = 0;
        this.alive = false;
        this._respawnAt = performance.now() + RESPAWN_MS;
        this._applyLocalDeathEffects(src, { stickyHud: !!src.sticky });
      }
    },

    /** Teammate laser heal — half damage, never above max HP. */
    _heal: function (n, detail) {
      if (!this.alive) return;
      const amount = Math.max(0, Math.floor(n || 0));
      if (amount <= 0) return;
      const before = this.localHp;
      this.localHp = Math.min(this.maxHp, this.localHp + amount);
      updateLocalHud(this.localHp, this.maxHp);
      if (this.localHp === before) return;
      syncHealthNet(localId(), this.localHp, this.maxHp, false, {
        from: detail?.from,
        to: detail?.to || detail?.point,
        point: detail?.point,
        heal: true,
        attackerId: detail?.fromTeam || detail?.attackerId
      });
      playImpactSfx(detail?.point);
      document.dispatchEvent(new CustomEvent('entity-damaged', {
        detail: { entityId: localId(), newHealth: this.localHp, team: null, heal: true }
      }));
    },

    /** Shared local death: stun, flag drop, ragdoll tumble, events (MP health-sync + local _hurt). */
    _applyLocalDeathEffects: function (shot, opts) {
      opts = opts || {};
      const id = localId();
      try { window.CapVRFlags?.dropFromOwner?.(id); } catch (e0) { /* */ }
      document.dispatchEvent(new CustomEvent('combatant-died', { detail: { id } }));
      document.dispatchEvent(new CustomEvent('entity-died', {
        detail: { entityId: id, entityType: 'player' }
      }));
      const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
      if (zp) {
        try {
          if (zp.leftHand) zp.releaseFromSurface?.(zp.leftHand);
          if (zp.rightHand) zp.releaseFromSurface?.(zp.rightHand);
        } catch (e) { /* */ }
        if (zp.grabbedSurface) {
          zp.grabbedSurface.left = null;
          zp.grabbedSurface.right = null;
        }
        if (zp.grabInfo) {
          zp.grabInfo.left = null;
          zp.grabInfo.right = null;
        }
        if (zp.isGrabbing) {
          zp.isGrabbing.left = false;
          zp.isGrabbing.right = false;
        }
        zp.isStunned = true;
        zp.stunEndTime = Date.now() + RESPAWN_MS;
      }
      const localBody = document.getElementById('local-body');
      applyHumanDeathTumble(localBody, shot);
      const msg = document.querySelector('#hud-message');
      if (msg) {
        msg.setAttribute('visible', true);
        msg.setAttribute('text', 'value', opts.stickyHud
          ? 'Destroyed — sticky blast'
          : 'Destroyed — kill shot linger…');
      }
    },

    _respawn: function () {
      const id = localId();
      // Never respawn while still holding / carrying a CTF flag
      try { window.CapVRFlags?.dropFromOwner?.(id); } catch (e0) { /* */ }
      this.alive = true;
      this.localHp = MAX_HP;
      this._lastDamageAt = 0;
      this._lastRegenSyncAt = 0;
      updateLocalHud(this.localHp, this.maxHp);
      const team = window.CapVRGame?.playerTeams?.get?.(id) || 'red';
      const spawn = teamSpawn(team, 0);
      const player = document.querySelector('#player');
      const rig = document.getElementById('rig');
      clearKillingShots(rig);
      clearKillingShots(player);
      clearKillingShots(document.querySelector('a-scene'));
      this._lastIncoming = null;
      clearHumanDeathTumble(document.getElementById('local-body'));
      if (player) {
        player.setAttribute('position', { x: spawn.x, y: spawn.y, z: spawn.z });
        if (player.body?.position) player.body.position.set(spawn.x, spawn.y, spawn.z);
        if (player.body?.velocity) player.body.velocity.set(0, 0, 0);
      }
      if (rig) rig.object3D.position.set(0, 0, 0);
      const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
      if (zp) {
        zp.isStunned = false;
        if (zp.grabbedSurface) {
          zp.grabbedSurface.left = null;
          zp.grabbedSurface.right = null;
        }
        if (zp.grabInfo) {
          zp.grabInfo.left = null;
          zp.grabInfo.right = null;
        }
      }
      if (window.CapVRFlags) window.CapVRFlags._scoreBlockedUntil = performance.now() + 2500;
      const msg = document.querySelector('#hud-message');
      if (msg) msg.setAttribute('visible', false);
      syncHealthNet(id, MAX_HP, MAX_HP, false);
      document.dispatchEvent(new CustomEvent('entity-respawned', {
        detail: { entityId: id, team, entityType: 'player' }
      }));
    },

    /** Remote health apply (clients / host broadcast). */
    applyHealthSync: function (data) {
      if (!data?.entityId) return;
      const id = data.entityId;
      if (id === localId() || id === 'player' || id === 'rig') {
        const prevHp = this.localHp;
        const nextHp = data.currentHealth;
        const wasAlive = this.alive;
        const willDie = !!data.isDead || nextHp <= 0;
        // Always apply authoritative HP. Missing `from` only skips inbound FX —
        // never reject the damage (that made teammates immortal under MP).
        if (wasAlive && (nextHp < prevHp || willDie) && !data.heal) {
          const shot = {
            from: data.from || null,
            to: data.to || data.point || null,
            point: data.point || data.to || null,
            sticky: !!data.sticky,
            fromTeam: data.attackerId
          };
          if (!shot.from && !shot.sticky && willDie && this._lastIncoming?.from) {
            showInboundShotFx(this, this._lastIncoming, true);
          } else if (shot.from || shot.sticky) {
            showInboundShotFx(this, shot, willDie && !shot.sticky);
            if (shot.from) this._lastIncoming = shot;
          } else if (willDie) {
            console.warn('[CapVR] health-sync death without shot origin (HP still applied)');
          }
        }
        this.localHp = nextHp;
        this.maxHp = data.maxHealth || MAX_HP;
        this.alive = !willDie && this.localHp > 0;
        updateLocalHud(this.alive ? this.localHp : 0, this.maxHp);
        if (wasAlive && !this.alive) {
          this._respawnAt = performance.now() + RESPAWN_MS;
          const shot = {
            from: data.from || this._lastIncoming?.from || null,
            to: data.to || data.point || null,
            point: data.point || data.to || null,
            sticky: !!data.sticky,
            fromTeam: data.attackerId
          };
          this._applyLocalDeathEffects(shot, { stickyHud: !!data.sticky });
        }
        return;
      }
      if (botState[id]) {
        botState[id].hp = data.currentHealth;
        botState[id].maxHp = data.maxHealth || MAX_HP;
        botState[id].alive = !data.isDead;
        updateWorldBar(id, botState[id].hp, botState[id].maxHp, data.isDead);
        return;
      }
      if (String(id).startsWith('player_')) {
        const wasDead = window.CapVRCombat?._remoteDead?.[id];
        updateRemoteBar(id, data.currentHealth, data.maxHealth || MAX_HP, data.isDead);
        if (data.isDead && !wasDead) {
          window.CapVRCombat._remoteDead = window.CapVRCombat._remoteDead || {};
          window.CapVRCombat._remoteDead[id] = true;
          applyRemoteHumanDeathFx(id, {
            from: data.from,
            point: data.point || data.to,
            to: data.to || data.point
          });
        } else if (!data.isDead && (data.currentHealth || 0) > 0 && wasDead) {
          window.CapVRCombat._remoteDead[id] = false;
          applyRemoteHumanRespawnFx(id);
        }
      }
    }
  });

  document.addEventListener('capvr-laser', (e) => {
    if (e.detail?.skipVisual) return;
    const { from, to } = e.detail || {};
    if (!from || !to) return;
    const color = e.detail.color || '#ffee66';
    spawnLaserVisuals(
      from.clone ? from.clone() : new THREE.Vector3(from.x, from.y, from.z),
      to.clone ? to.clone() : new THREE.Vector3(to.x, to.y, to.z),
      { color, hit: !!e.detail.hit, linger: !!e.detail.linger }
    );
    if (!e.detail?.silent) playLaserFireSfx();
  });

  window.CapVRCombat = {
    botState,
    _remoteDead: {},
    MAX_HP,
    LASER_DAMAGE,
    STICKY_ATTACH_DAMAGE,
    STICKY_SPLASH_DAMAGE,
    STICKY_STUN_RADIUS,
    STICKY_STUN_MS,
    applyStickyStunBlast,
    applyStunToOwner,
    playStunRebootAt,
    proposePlayerDamage,
    applyPlayerDamageAuthority,
    applyRemoteHumanDeathFx,
    applyRemoteHumanRespawnFx,
    applyCharacterVisibility,
    isBotAlive(owner) { return !!botState[owner]?.alive; },
    creditShotHit() { window.CapVRCombat._lastShotAt = performance.now(); },
    hasLineOfSight,
    hasCombatLos,
    hasLosToLocalPlayer,
    localPlayerChestPos,
    castEnvRay,
    clipRayToCover,
    /** True if local weapon hand/arm is through static geometry (muzzle inside or shoulder→hand blocked). */
    isLocalWeaponArmClipping,
    placeBot,
    killBot,
    damageBot,
    healBot,
    areCombatTeammates,
    resolveCombatTeam,
    shouldFriendlyHeal,
    healFromDamage,
    resolveHitAttackerId,
    syncDamageDealt,
    syncWeaponFired,
    syncHealthNet,
    resetMatchCombat,
    spawnLaserVisuals,
    applyRemoteWeaponFired(data) {
      if (!data) return;
      // Don't redraw our own muzzle flash (already shown locally).
      if (data.playerId && data.playerId === localId()) return;
      const from = new THREE.Vector3(data.startX, data.startY, data.startZ);
      const to = new THREE.Vector3(data.endX, data.endY, data.endZ);
      const hitMe = _nearLocalCamera(to, 1.5);
      spawnLaserVisuals(from, to, {
        color: data.color || '#00ffff',
        hit: true,
        inbound: hitMe,
        thick: hitMe,
        pullFromCamera: hitMe,
        dur: hitMe ? 380 : 120
      });
    },
    applyRemoteHealthSync(data) {
      const c = document.querySelector('[capvr-combat]')?.components?.['capvr-combat'];
      c?.applyHealthSync?.(data);
    },
    applyRemoteDamage(data) {
      // Prefer CapVRMp host authority path when loaded.
      if (window.CapVRMp?.isHost && window.CapVRCombat._capvrMpPatched) {
        // CapVRMp replaces this function — keep fallback below for order-of-load races.
      }
      if (!data?.targetId) return;
      if (window.CapVRGame?.isMultiplayer?.() && window.CapVRGame?.isHost?.() === false) return;
      if (data.attackerId && data.attackerId === localId() && !data.force) return;
      const shotFrom = data.from || (data.sticky ? data.point : null) || data.point || null;
      // Laser damage must carry a shot origin (stops phantom MP/ball leftovers)
      if (!data.sticky && !shotFrom) {
        console.warn('[CapVR] ignored damage-dealt without from', data.targetId);
        return;
      }
      if (data.targetId === localId() || data.targetId === 'player') {
        const c = document.querySelector('[capvr-combat]')?.components?.['capvr-combat'];
        c?._hurt?.(data.damage || LASER_DAMAGE, {
          fromTeam: data.attackerId,
          from: shotFrom,
          to: data.to || data.point,
          point: data.point,
          sticky: !!data.sticky,
          force: !!data.force
        });
        return;
      }
      if (botState[data.targetId]) {
        // Call raw damage (avoid CapVRMp client-propose wrapper looping)
        const bodyEl = document.getElementById(`${data.targetId}-body`);
        damageBot(data.targetId, data.damage || LASER_DAMAGE, {
          bodyEl,
          point: data.point
            ? new THREE.Vector3(data.point.x, data.point.y, data.point.z)
            : null,
          attackerId: data.attackerId || null,
          sticky: !!data.sticky
        });
      }
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    const scene = document.querySelector('a-scene');
    const attach = () => {
      purgeDuplicateCombatBodies();
      if (scene && !scene.components['capvr-combat']) scene.setAttribute('capvr-combat', '');
      ensureHud();
    };
    if (scene?.hasLoaded) attach();
    else scene?.addEventListener('loaded', attach, { once: true });
  });
})();
