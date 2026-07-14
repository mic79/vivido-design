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
  const STICKY_ATTACH_DAMAGE = 48; // ≈ 3 laser hits on attach target
  const STICKY_SPLASH_DAMAGE = 16;
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
    synthTone(880, 0.05, 0.05, 'square');
    synthTone(440, 0.07, 0.03, 'sawtooth');
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

  /** Spaceshooter impact-spark-burst (compact, no smoke dependency). */
  function spawnHitSparks(position) {
    const sceneObj = document.querySelector('a-scene')?.object3D;
    if (!sceneObj || !position) return;
    const origin = new THREE.Vector3(
      position.x != null ? position.x : position.X,
      position.y != null ? position.y : position.Y,
      position.z != null ? position.z : position.Z
    );
    const sparks = [];
    const count = 8 + Math.floor(Math.random() * 5);
    const colors = [0xFFFF00, 0xFF8800, 0xFF4400, 0xFF6600];
    const burstDuration = 0.8;
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
      const size = 0.006 + Math.random() * 0.004;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(size, 6, 4),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(color),
          transparent: true,
          opacity: 0.9,
          depthTest: true,
          depthWrite: false
        })
      );
      mesh.position.copy(origin);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10010;
      sceneObj.add(mesh);
      sparks.push({
        mesh,
        velocity,
        age: 0,
        maxAge: burstDuration,
        startColor: new THREE.Color(color),
        endColor: new THREE.Color(0x220000),
        originalOpacity: 0.9
      });
    }
    const t0 = performance.now();
    function step(now) {
      const dt = Math.min(0.05, (now - (step._last || now)) / 1000) || 0.016;
      step._last = now;
      const elapsed = (now - t0) / 1000;
      sparks.forEach((spark) => {
        spark.age += dt;
        if (spark.age > spark.maxAge) {
          spark.mesh.visible = false;
          return;
        }
        spark.mesh.position.x += spark.velocity.x * dt;
        spark.mesh.position.y += spark.velocity.y * dt;
        spark.mesh.position.z += spark.velocity.z * dt;
        spark.velocity.y -= 2.0 * dt;
        const progress = spark.age / spark.maxAge;
        spark.mesh.material.color.copy(spark.startColor).lerp(spark.endColor, progress);
        spark.mesh.material.opacity = spark.originalOpacity * (1 - progress);
      });
      if (elapsed < burstDuration) {
        requestAnimationFrame(step);
        return;
      }
      sparks.forEach((spark) => {
        sceneObj.remove(spark.mesh);
        spark.mesh.geometry.dispose();
        spark.mesh.material.dispose();
      });
    }
    requestAnimationFrame(step);
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
    } else {
      synthTone(220, 0.12, 0.07, 'triangle');
    }
    spawnHitSparks(pos);
  }

  /* ── laser visuals + deathcam linger (BattleVR killingShot) ── */
  function spawnLaserVisuals(from, to, opts) {
    opts = opts || {};
    const scene = document.querySelector('a-scene');
    if (!scene || !from || !to) return null;
    const color = opts.color || '#00ffff';
    const fx = from.x != null ? from.x : from.X;
    const fy = from.y != null ? from.y : from.Y;
    const fz = from.z != null ? from.z : from.Z;
    const tx = to.x != null ? to.x : to.X;
    const ty = to.y != null ? to.y : to.Y;
    const tz = to.z != null ? to.z : to.Z;

    // Line is reliable in A-Frame (cylinder quat often resets before object3D mounts).
    const beam = document.createElement('a-entity');
    beam.setAttribute(
      'line',
      `start: ${fx} ${fy} ${fz}; end: ${tx} ${ty} ${tz}; color: ${color}; opacity: ${opts.linger ? 1 : 0.85}`
    );

    // Impact orb only on real hits — never float a blob in empty air on a miss.
    let impact = null;
    if (opts.linger || opts.hit) {
      impact = document.createElement('a-sphere');
      impact.setAttribute('radius', opts.linger ? 0.22 : 0.14);
      impact.setAttribute('position', `${tx} ${ty} ${tz}`);
      impact.setAttribute('material', {
        color, emissive: color, emissiveIntensity: opts.linger ? 4 : 2.4, shader: 'flat'
      });
    }

    let origin = null;
    if (opts.linger) {
      origin = document.createElement('a-sphere');
      origin.setAttribute('radius', 0.28);
      origin.setAttribute('position', `${fx} ${fy} ${fz}`);
      origin.setAttribute('material', {
        color: '#ffffff', emissive: color, emissiveIntensity: 5, shader: 'flat'
      });
      // Extra thick cylinder for visibility when looking around (after object3D ready)
      const thick = document.createElement('a-entity');
      const mid = new THREE.Vector3((fx + tx) / 2, (fy + ty) / 2, (fz + tz) / 2);
      const len = Math.max(0.15, Math.hypot(tx - fx, ty - fy, tz - fz));
      thick.setAttribute('geometry', { primitive: 'cylinder', radius: 0.04, height: len });
      thick.setAttribute('material', {
        color, emissive: color, emissiveIntensity: 3,
        shader: 'flat', transparent: true, opacity: 0.95
      });
      thick.setAttribute('position', `${mid.x} ${mid.y} ${mid.z}`);
      scene.appendChild(thick);
      thick.addEventListener('loaded', () => {
        const dir = new THREE.Vector3(tx - fx, ty - fy, tz - fz).normalize();
        thick.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      });
      // HUD hint so player knows to look for the tracer
      const hint = document.createElement('a-entity');
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
      const visuals = { beam, impact, origin, thick, hint };
      scene.appendChild(beam);
      if (impact) scene.appendChild(impact);
      return visuals;
    }

    scene.appendChild(beam);
    if (impact) scene.appendChild(impact);
    const visuals = { beam, impact };
    setTimeout(() => {
      try { beam.remove(); } catch (e) { /* */ }
      try { impact?.remove(); } catch (e) { /* */ }
    }, opts.dur || 80);
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
    bodyEl.object3D.traverse((n) => {
      if (!n.isMesh || !n.material) return;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach((m) => {
        if (!m) return;
        if (m.emissive) m.emissive.setHex(hex);
        if (typeof m.emissiveIntensity === 'number') {
          m.emissiveIntensity = Math.max(opts.local ? 0.35 : 0.55, m.emissiveIntensity || 0);
        } else {
          m.emissiveIntensity = opts.local ? 0.35 : 0.55;
        }
        m.needsUpdate = true;
      });
    });
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
    // Local tint follows YOUR team (was wrongly forced cyan/white)
    const local = document.getElementById('local-body');
    if (local && !local._capvrVis) {
      local._capvrVis = true;
      const tintLocal = () => {
        const team = window.CapVRGame?.playerTeams?.get?.(localId()) || 'red';
        applyCharacterVisibility(local, team, { local: true });
      };
      setTimeout(tintLocal, 1200);
      setTimeout(tintLocal, 4000);
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
    let to = shot.to || shot.point || head;
    to = to.clone ? to.clone() : new THREE.Vector3(to.x, to.y, to.z);
    if (willKill && cam?.object3D) cam.object3D.getWorldPosition(to);
    if (!hasLineOfSight(from, to, 0.2)) to = clipRayToCover(from, to);
    const visuals = spawnLaserVisuals(from, to, {
      linger: !!willKill,
      color: willKill ? '#ff2244' : '#ff6655',
      thick: willKill ? 0.04 : 0.02,
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

  const _losRaycaster = new THREE.Raycaster();
  const _losBox = new THREE.Box3();
  const _losRoots = [];
  let _losRootCacheAt = 0;

  function _isLosIgnoredEl(el) {
    if (!el) return true;
    // Anything under the shooter / UI must never count as a wall hit.
    if (el.closest?.(
      '#player, #rig, #camera, #local-body, #leftHand, #rightHand, #left-hand, #right-hand, '
      + 'a-camera, #capvr-menu, #menu, #hud, #score-display, [zerog-player], [capvr-combat]'
    )) return true;
    if (el.hasAttribute?.('data-visual-only') || el.classList?.contains('wireframe-visual-only')) return true;
    if (el.id === 'red-goal' || el.id === 'blue-goal' || el.id === 'capture-ball') return true;
    if (el.id === 'player' || el.id === 'rig' || el.id === 'camera' || el.id === 'local-body') return true;
    if (el.hasAttribute?.('grabbable-ragdoll') || el.hasAttribute?.('mixamo-body')
      || el.hasAttribute?.('mixamo-body-avatar')) return true;
    if (el.hasAttribute?.('zerog-bot') || el.hasAttribute?.('zerog-ball')) return true;
    if (el.hasAttribute?.('zerog-player') || el.hasAttribute?.('capvr-combat')) return true;
    if (el.classList?.contains('clickable') || el.classList?.contains('menu')) return true;
    if (el.classList?.contains('thruster-vfx') || el.classList?.contains('ctf-flag-xray')) return true;
    if (el.classList?.contains('ctf-flag-ball') || el.dataset?.flagTeam) return true;
    if (el.classList?.contains('capvr-contour') || el.classList?.contains('capvr-health-bar')) return true;
    if (el.id === 'flag-red' || el.id === 'flag-blue') return true;
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

  function _refreshLosRoots() {
    _losRoots.length = 0;
    // Arena occluders: grab surfaces + common static props (cover without grab-surface).
    const sels = [
      '[grab-surface]',
      'a-box:not([data-visual-only])',
      'a-cylinder:not([data-visual-only])',
      'a-sphere.arena-cover',
      'a-octahedron',
      'a-tetrahedron',
      'a-plane.arena-cover'
    ];
    document.querySelectorAll(sels.join(',')).forEach((el) => {
      if (_isLosIgnoredEl(el) || !el.object3D) return;
      // Skip tiny HUD / menu planes
      if (el.closest?.('#menu, #capvr-menu, #hud, [capvr-combat]')) return;
      _losRoots.push(el.object3D);
    });
  }

  /** Ray vs world AABB of an object (covers rotated arena props better than raw geometry attrs). */
  function _rayAabbDistance(ori, dir, box, maxDist) {
    // Slab test
    let tmin = 0;
    let tmax = maxDist;
    const axes = [
      { o: ori.x, d: dir.x, min: box.min.x, max: box.max.x },
      { o: ori.y, d: dir.y, min: box.min.y, max: box.max.y },
      { o: ori.z, d: dir.z, min: box.min.z, max: box.max.z }
    ];
    for (let a = 0; a < 3; a++) {
      const A = axes[a];
      if (Math.abs(A.d) < 1e-9) {
        if (A.o < A.min || A.o > A.max) return null;
        continue;
      }
      let t1 = (A.min - A.o) / A.d;
      let t2 = (A.max - A.o) / A.d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
    if (tmin < 0.03 || tmin >= maxDist) return null;
    return tmin;
  }

  /**
   * Nearest occluder along a ray. Combines:
   *  1) Box3D ENVIRONMENT cast
   *  2) THREE mesh raycast against [grab-surface] (BattleVR-style)
   *  3) World AABB fallback on those surfaces
   * Returns { point, distance, normal } or null.
   */
  // Skip self / muzzle-adjacent garbage. Real walls farther than this still hit fine
  // when you're floating right next to them — we reject SELF meshes separately.
  const ENV_HIT_MIN_DIST = 0.35;

  function castEnvRay(ori, dir, maxDist) {
    if (!ori || !dir || !(maxDist > ENV_HIT_MIN_DIST)) return null;
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const nd = new THREE.Vector3(dir.x / len, dir.y / len, dir.z / len);
    const origin = ori.isVector3 ? ori : new THREE.Vector3(ori.x, ori.y, ori.z);
    let bestDist = maxDist;
    let bestPoint = null;
    let bestNormal = null;

    // 1) Box3D environment only (not player/hand/ragdoll categories)
    try {
      const phys = window.CapVRPhysics?.get?.();
      const q = phys?.queries;
      if (q?.castRay) {
        const hit = q.castRay(
          { x: origin.x, y: origin.y, z: origin.z },
          { x: nd.x, y: nd.y, z: nd.z },
          maxDist,
          q.envFilter || undefined
        );
        if (hit && hit.hit !== false && hit.fraction != null) {
          const dist = (hit.timeOfImpact != null) ? hit.timeOfImpact : (hit.fraction * maxDist);
          if (dist > ENV_HIT_MIN_DIST && dist < bestDist - 1e-4) {
            bestDist = dist;
            bestPoint = hit.point
              ? new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z)
              : origin.clone().addScaledVector(nd, dist);
            bestNormal = hit.normal
              ? new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z)
              : nd.clone().negate();
          }
        }
      }
    } catch (e) { /* */ }

    // 2) THREE mesh raycast — grab-surface walls/platforms only
    const now = performance.now();
    if (!_losRoots.length || now - _losRootCacheAt > 600) {
      _refreshLosRoots();
      _losRootCacheAt = now;
    }
    if (_losRoots.length) {
      _losRaycaster.set(origin, nd);
      _losRaycaster.near = ENV_HIT_MIN_DIST;
      _losRaycaster.far = maxDist;
      const hits = _losRaycaster.intersectObjects(_losRoots, true);
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (!h || !(h.distance > ENV_HIT_MIN_DIST) || h.distance >= bestDist) continue;
        const hitEl = _elFromObject3D(h.object);
        if (_isLosIgnoredEl(hitEl)) continue;
        // Skip invisible / fully transparent materials
        const mat = h.object?.material;
        const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
        const seethrough = mats.length && mats.every((m) => m && (m.opacity != null && m.opacity < 0.15) && m.transparent);
        if (seethrough) continue;
        bestDist = h.distance;
        bestPoint = h.point.clone();
        bestNormal = h.face?.normal
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
          : nd.clone().negate();
        break;
      }
    }

    if (!bestPoint || bestDist >= maxDist - 0.02) return null;
    return { point: bestPoint, distance: bestDist, normal: bestNormal || nd.clone().negate() };
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
   * Local player must be exposed at BOTH head (camera) and torso — cover that
   * hides your view must also stop incoming bot lasers.
   */
  function hasLosToLocalPlayer(fromPos, slack) {
    if (!fromPos) return false;
    const from = fromPos.clone ? fromPos.clone() : new THREE.Vector3(fromPos.x, fromPos.y, fromPos.z);
    const s = slack != null ? slack : 0.05;
    const head = new THREE.Vector3();
    const torso = new THREE.Vector3();
    const cam = document.getElementById('camera');
    if (cam?.object3D) cam.object3D.getWorldPosition(head);
    else return false;
    const player = document.getElementById('player') || document.getElementById('rig');
    if (player?.object3D) {
      player.object3D.getWorldPosition(torso);
      torso.y += 1.05;
    } else {
      torso.copy(head);
      torso.y -= 0.35;
    }
    // Head is what you see — if head is blocked you're in cover
    if (!hasCombatLos(from, head, s)) return false;
    // Torso too (stops “head only” corner cheese the other way)
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
      if (combat && performance.now() < (combat._nextFireAt || 0)) return;
      if (combat) combat._nextFireAt = performance.now() + FIRE_COOLDOWN_MS;

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
        syncDamageDealt(remoteHit.playerId, LASER_DAMAGE, localId());
        if (window.CapVRGame?.isHost?.()) {
          window.CapVRCombat?.applyRemoteDamage?.({
            targetId: remoteHit.playerId,
            damage: LASER_DAMAGE,
            attackerId: localId(),
            force: true,
            point: {
              x: remoteHit.point.x, y: remoteHit.point.y, z: remoteHit.point.z
            },
            from: {
              x: this._rayOri.x, y: this._rayOri.y, z: this._rayOri.z
            }
          });
        }
        playImpactSfx(remoteHit.point);
        return;
      }

      let best = null;
      let bestDist = MAX_RANGE;
      document.querySelectorAll('[grabbable-ragdoll]').forEach((el) => {
        if (!el.object3D?.visible) return;
        const grab = el.components?.['grabbable-ragdoll'];
        if (!grab?.raycastFromShot) return;
        const hit = grab.raycastFromShot(this._rayOri, this._rayDir, MAX_RANGE);
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
      const pos = detail?.position;
      if (!pos) return;
      const targetId = detail.targetId || '';
      const targetPlayerId = detail.targetPlayerId || null;
      const THREE_V = THREE.Vector3;
      const center = pos.clone ? pos.clone() : new THREE_V(pos.x, pos.y, pos.z);
      const attackerId = detail.attackerId || 'sticky';

      // Primary: attached target gets ≈3 laser hits + 3 shatter pulses
      if (targetId === 'player' || targetId === 'rig'
          || (targetPlayerId && targetPlayerId === localId())) {
        applyStickyShatters(document.getElementById('local-body'), center, 3);
        this._hurt(STICKY_ATTACH_DAMAGE, { sticky: true, point: center });
        playImpactSfx(center);
        syncDamageDealt(localId(), STICKY_ATTACH_DAMAGE, attackerId);
      } else if (targetPlayerId && targetPlayerId !== localId()) {
        // Stuck to a remote human — host authoritative HP
        window.CapVRCombat?.applyRemoteDamage?.({
          targetId: targetPlayerId,
          damage: STICKY_ATTACH_DAMAGE,
          attackerId,
          sticky: true,
          force: true,
          point: { x: center.x, y: center.y, z: center.z },
          from: { x: center.x, y: center.y, z: center.z }
        });
        playImpactSfx(center);
      } else if (String(targetId).startsWith('remote-target-')) {
        const idx = targetId.replace('remote-target-', '');
        const pid = `player_${idx}`;
        window.CapVRCombat?.applyRemoteDamage?.({
          targetId: pid,
          damage: STICKY_ATTACH_DAMAGE,
          attackerId,
          sticky: true,
          force: true,
          point: { x: center.x, y: center.y, z: center.z }
        });
        playImpactSfx(center);
      } else if (String(targetId).startsWith('zerog-bot') || String(targetId).startsWith('zerog-')) {
        const owner = targetId.replace('zerog-', '');
        const bodyEl = document.getElementById(`${owner}-body`)
          || document.getElementById(`${owner}-ragdoll`);
        applyStickyShatters(bodyEl, center, 3);
        damageBot(owner, STICKY_ATTACH_DAMAGE, {
          bodyEl, point: center, dir: new THREE.Vector3(0, -1, 0)
        });
        syncDamageDealt(owner, STICKY_ATTACH_DAMAGE, attackerId);
      }

      // Splash — local player
      const player = document.querySelector('#player');
      const primaryIsLocal = targetId === 'player' || targetId === 'rig'
        || (targetPlayerId && targetPlayerId === localId());
      if (player && !primaryIsLocal) {
        const p = new THREE.Vector3();
        player.object3D.getWorldPosition(p);
        if (p.distanceTo(center) < 2.4) {
          this._hurt(STICKY_SPLASH_DAMAGE, { sticky: true, point: center });
        }
      }
      // Splash — remote humans
      for (let i = 0; i < 4; i++) {
        const pid = `player_${i}`;
        if (pid === localId()) continue;
        if (targetPlayerId === pid) continue;
        if (targetId === `remote-target-${i}`) continue;
        const el = document.getElementById(`remote-target-${i}`);
        if (!el?.object3D) continue;
        const rp = new THREE.Vector3();
        el.object3D.getWorldPosition(rp);
        if (rp.distanceTo(center) < 2.6) {
          window.CapVRCombat?.applyRemoteDamage?.({
            targetId: pid,
            damage: STICKY_SPLASH_DAMAGE,
            attackerId,
            sticky: true,
            stickySplash: true,
            force: true,
            point: { x: center.x, y: center.y, z: center.z }
          });
        }
      }
      BOT_MAP.forEach(({ bot, owner, ragdoll, body }) => {
        if (!botState[owner]?.alive) return;
        if (targetId === bot) return;
        const botEl = document.getElementById(bot);
        if (!botEl) return;
        const bp = botEl.body?.position || botEl.object3D.position;
        if (Math.hypot(bp.x - center.x, bp.y - center.y, bp.z - center.z) < 2.6) {
          const bodyEl = document.getElementById(body) || document.getElementById(ragdoll);
          applyStickyShatters(bodyEl, center, 1);
          damageBot(owner, STICKY_SPLASH_DAMAGE, { bodyEl, point: center });
        }
      });

      // Boom flash
      const boom = document.querySelector('#bounce-sound');
      if (boom?.components?.sound) {
        try {
          boom.setAttribute('position', `${center.x} ${center.y} ${center.z}`);
          boom.components.sound.stopSound?.();
          boom.components.sound.playSound();
        } catch (e) { /* */ }
      } else {
        synthTone(90, 0.25, 0.1, 'sawtooth');
      }
    },

    fire: function () {
      if (!this.alive || !this._aim()) return;
      if (performance.now() < this._nextFireAt) return;
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
      let best = null;
      let bestDist = MAX_RANGE;
      document.querySelectorAll('[grabbable-ragdoll]').forEach((el) => {
        if (!el.object3D?.visible) return;
        const grab = el.components?.['grabbable-ragdoll'];
        if (!grab?.raycastFromShot) return;
        const hit = grab.raycastFromShot(this._ori, this._dir, MAX_RANGE);
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
      const dmg = detail.damage || LASER_DAMAGE;
      damageBot(owner, dmg, {
        bodyEl: el,
        point: detail.point,
        dir: detail.dir || this._dir,
        regionId: detail.regionId
      });
      const botEl = document.getElementById(botId);
      const bc = botEl?.components?.['zerog-bot'];
      if (bc?.velocity && this._dir) {
        bc.velocity.x += this._dir.x * 3;
        bc.velocity.y += this._dir.y * 3 + 1;
        bc.velocity.z += this._dir.z * 3;
      }
    },

    _hurt: function (n, detail) {
      if (!this.alive) return;
      const amount = n || LASER_DAMAGE;
      const willKill = this.localHp - amount <= 0;
      const src = detail || this._lastIncoming || {};
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
        const id = localId();
        // Drop CTF flag first (clears palm grab + carrier) before other release logic
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
          // releaseFromSurface does not clear grabbedSurface — that was re-attaching the flag
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
        }
        // Stun like BattleVR deathcam window
        if (zp) {
          zp.isStunned = true;
          zp.stunEndTime = Date.now() + RESPAWN_MS;
        }
        const msg = document.querySelector('#hud-message');
        if (msg) {
          msg.setAttribute('visible', true);
          msg.setAttribute('text', 'value', 'Destroyed — kill shot linger…');
        }
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
        // Avoid silent / phantom death: HP drops must carry a shot origin (or sticky)
        const prevHp = this.localHp;
        const nextHp = data.currentHealth;
        const wasAlive = this.alive;
        const willDie = !!data.isDead || nextHp <= 0;
        if (wasAlive && (nextHp < prevHp || willDie)) {
          const shot = {
            from: data.from || null,
            to: data.to || data.point || null,
            point: data.point || data.to || null,
            sticky: !!data.sticky,
            fromTeam: data.attackerId
          };
          if (!shot.from && !shot.sticky) {
            if (willDie && this._lastIncoming?.from) {
              showInboundShotFx(this, this._lastIncoming, true);
            } else {
              console.warn('[CapVR] rejected health-sync HP drop without shot origin');
              return;
            }
          } else {
            showInboundShotFx(this, shot, willDie && !shot.sticky);
            if (shot.from) this._lastIncoming = shot;
          }
        }
        this.localHp = nextHp;
        this.maxHp = data.maxHealth || MAX_HP;
        this.alive = !willDie && this.localHp > 0;
        updateLocalHud(this.alive ? this.localHp : 0, this.maxHp);
        if (wasAlive && !this.alive) {
          this._respawnAt = performance.now() + RESPAWN_MS;
          const zp = document.querySelector('[zerog-player]')?.components?.['zerog-player'];
          if (zp) {
            zp.isStunned = true;
            zp.stunEndTime = Date.now() + RESPAWN_MS;
          }
          const msg = document.querySelector('#hud-message');
          if (msg) {
            msg.setAttribute('visible', true);
            msg.setAttribute('text', 'value', data.sticky
              ? 'Destroyed — sticky blast'
              : 'Destroyed — kill shot linger…');
          }
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
        updateRemoteBar(id, data.currentHealth, data.maxHealth || MAX_HP, data.isDead);
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
    MAX_HP,
    LASER_DAMAGE,
    STICKY_ATTACH_DAMAGE,
    isBotAlive(owner) { return !!botState[owner]?.alive; },
    creditShotHit() { window.CapVRCombat._lastShotAt = performance.now(); },
    hasLineOfSight,
    hasCombatLos,
    hasLosToLocalPlayer,
    castEnvRay,
    clipRayToCover,
    placeBot,
    killBot,
    damageBot,
    syncDamageDealt,
    syncWeaponFired,
    syncHealthNet,
    resetMatchCombat,
    spawnLaserVisuals,
    applyRemoteWeaponFired(data) {
      if (!data) return;
      const from = new THREE.Vector3(data.startX, data.startY, data.startZ);
      const to = new THREE.Vector3(data.endX, data.endY, data.endZ);
      spawnLaserVisuals(from, to, { color: data.color || '#00ffff', hit: true });
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
      // Laser damage must carry a shot origin (stops phantom MP/ball leftovers)
      if (!data.sticky && !data.from) {
        console.warn('[CapVR] ignored damage-dealt without from', data.targetId);
        return;
      }
      if (data.targetId === localId() || data.targetId === 'player') {
        const c = document.querySelector('[capvr-combat]')?.components?.['capvr-combat'];
        c?._hurt?.(data.damage || LASER_DAMAGE, {
          fromTeam: data.attackerId,
          from: data.from,
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
            : null
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
