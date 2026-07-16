/**
 * CapVR bot presentation:
 * - ONE visible body per bot: grabbable-ragdoll (ZeroGLegs loco + hit react + shatter)
 * - Upright yaw (BattleVR) — already enforced in zerog-bot; body follows yaw-only
 * - Feed thruster velocity into ZeroGLegs
 * - Wall collision = HEAD sphere (same as player camera probe), not waist/torso center
 */
(function () {
  'use strict';

  const THREE = (window.AFRAME && window.AFRAME.THREE) || window.THREE;

  const BOT_VIS = [
    { bot: 'zerog-bot-red', body: 'bot-red-body', team: 'red', target: 'bot-target' },
    { bot: 'zerog-bot-blue', body: 'bot-blue-body', team: 'blue', target: 'bot-blue-target' },
    { bot: 'zerog-bot-green', body: 'bot-green-body', team: 'blue', target: 'bot-green-target' }
  ];

  // Physics body ≈ Mixamo chest; feet at body.y-1 → head ≈ body.y+0.58
  const HEAD_Y = 0.58;
  // Match player checkAndResolveCollisions head probe (radius 0.25)
  const HEAD_R = 0.25;

  /**
   * Player walls collide at the camera (head). Bot Cannon/sphere was left at the
   * physics waist/chest, so Mixamo heads went through walls. Resolve only a head
   * sphere — same radius/idea as the player — and keep the visible bot-target there.
   */
  function patchBotHeadCollision() {
    const comp = AFRAME.components['zerog-bot'];
    const proto = comp?.Component?.prototype;
    if (!proto?.checkCustomCollisionWithSurfaces || !proto.getCollisionResponse) return;
    // Versioned so hot sessions replace older waist-only / torso+head patches.
    if (proto._capvrHeadCollide === 3) return;
    proto._capvrHeadCollide = 3;

    const _head = new THREE.Vector3();
    const _surfacePos = new THREE.Vector3();
    const _push = new THREE.Vector3();

    proto.checkCustomCollisionWithSurfaces = function () {
      if (!this.body) return;

      const collisionCulling = this.el.sceneEl.components['collision-culling'];
      const botId = this.el.id;
      const surfaces = collisionCulling && collisionCulling.data.enabled
        && collisionCulling.culledSurfaces.bots[botId]
        && collisionCulling.culledSurfaces.bots[botId].length > 0
        ? collisionCulling.culledSurfaces.bots[botId]
        : document.querySelectorAll('[grab-surface]');

      // Default: head above physics center (waist/chest). Live bone wins when mesh is ready.
      _head.set(this.body.position.x, this.body.position.y + HEAD_Y, this.body.position.z);
      const owner = botId?.replace('zerog-', '');
      const bodyEl = owner && document.getElementById(`${owner}-body`);
      const headBone = bodyEl?.components?.['grabbable-ragdoll']?.bones?.head;
      if (headBone) {
        bodyEl.object3D.updateWorldMatrix(true, false);
        headBone.getWorldPosition(_head);
      }

      _push.set(0, 0, 0);
      for (let s = 0; s < surfaces.length; s++) {
        const surface = surfaces[s];
        if (surface.hasAttribute?.('data-visual-only')
          || surface.classList?.contains('wireframe-visual-only')) {
          continue;
        }
        if (!surface.object3D) continue;
        surface.object3D.getWorldPosition(_surfacePos);
        const geometry = surface.getAttribute('geometry');
        if (!geometry) continue;
        const collision = this.getCollisionResponse(
          _head, HEAD_R, _surfacePos, geometry, surface
        );
        if (collision.lengthSq() > 0) _push.add(collision);
      }

      if (_push.lengthSq() <= 0) return;
      if (_push.length() > 0.4) _push.setLength(0.4);
      this.body.position.x += _push.x;
      this.body.position.y += _push.y;
      this.body.position.z += _push.z;
      if (this.velocity) {
        const n = _push.clone().normalize();
        const vn = this.velocity.dot(n);
        if (vn < 0) this.velocity.sub(n.multiplyScalar(vn));
      }
    };
  }

  function showCombatMesh(el) {
    const grab = el?.components?.['grabbable-ragdoll'];
    if (!grab?.model) return;
    grab.model.visible = true;
    grab.model.traverse((n) => {
      if (!n.isMesh || !n.material) return;
      n.visible = true;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach((m) => {
        if (!m) return;
        if (m.opacity === 0 || m.colorWrite === false) {
          m.transparent = false;
          m.opacity = 1;
          m.colorWrite = true;
          m.depthWrite = true;
          m.needsUpdate = true;
        }
      });
    });
  }

  const PLAY = { x: 20, yMin: 0.4, yMax: 11, z: 40 };

  function leashBotPhysics(botEl) {
    const body = botEl?.body || botEl?.components?.['zerog-bot']?.body;
    if (!body?.position) return;
    const p = body.position;
    let nx = p.x;
    let ny = p.y;
    let nz = p.z;
    let clamped = false;
    if (nx > PLAY.x) { nx = PLAY.x; clamped = true; }
    if (nx < -PLAY.x) { nx = -PLAY.x; clamped = true; }
    if (nz > PLAY.z) { nz = PLAY.z; clamped = true; }
    if (nz < -PLAY.z) { nz = -PLAY.z; clamped = true; }
    if (ny > PLAY.yMax) { ny = PLAY.yMax; clamped = true; }
    if (ny < PLAY.yMin) { ny = PLAY.yMin; clamped = true; }
    if (!clamped) return;
    p.x = nx; p.y = ny; p.z = nz;
    const bc = botEl.components?.['zerog-bot'];
    if (bc?.velocity) {
      if (Math.abs(nx) >= PLAY.x - 0.01) bc.velocity.x *= -0.2;
      if (Math.abs(nz) >= PLAY.z - 0.01) bc.velocity.z *= -0.2;
      if (ny >= PLAY.yMax - 0.01) bc.velocity.y = Math.min(0, bc.velocity.y);
      if (ny <= PLAY.yMin + 0.01) bc.velocity.y = Math.max(0, bc.velocity.y);
    }
  }

  /** Keep the visible grab/hit sphere on the Mixamo head (was glued at waist = body origin). */
  function syncBotTargetToHead(botEl, bodyEl, targetId) {
    const target = (targetId && document.getElementById(targetId))
      || botEl?.querySelector?.('.grabbable-player');
    if (!target?.object3D) return;

    let localY = HEAD_Y;
    const headBone = bodyEl?.components?.['grabbable-ragdoll']?.bones?.head;
    if (headBone && botEl.object3D) {
      const hp = new THREE.Vector3();
      headBone.getWorldPosition(hp);
      botEl.object3D.updateWorldMatrix(true, false);
      const local = botEl.object3D.worldToLocal(hp.clone());
      localY = local.y;
    }
    target.object3D.position.set(0, localY, 0);
  }

  function syncBotBodies() {
    const botsOn = !(window.perfConfig && window.perfConfig.botLogicEnabled === false);
    BOT_VIS.forEach(({ bot, body, team, target }) => {
      const botEl = document.getElementById(bot);
      const bodyEl = document.getElementById(body);
      if (!botEl || !bodyEl?.object3D) return;
      if (!botsOn || bodyEl.components?.['grabbable-ragdoll']?.data?.paused) {
        return;
      }

      leashBotPhysics(botEl);

      const grab = bodyEl.components?.['grabbable-ragdoll'];
      const owner = bot.replace('zerog-', '');
      if (grab?.ragdollActive && window.CapVRCombat?.isBotAlive?.(owner)) {
        try { grab.resetRagdoll?.(); } catch (e) { /* */ }
      }
      if (grab?.ragdollActive) return;

      const p = botEl.body?.position || botEl.object3D.position;
      const y = (p.y || 0) - 1.0;
      bodyEl.object3D.position.set(p.x, y, p.z);

      // Match zerog-bot / ZeroGLegs / character.glb forward (-Z after model yaw π).
      // Do NOT add +π here — grabbable-ragdoll already applies model.rotation.y = π,
      // and a second π made the mesh face opposite the aim/fire cone.
      const yaw = botEl.object3D.rotation.y;
      bodyEl.object3D.rotation.set(0, yaw, 0);

      if (grab) {
        if (grab._entityBasePos) grab._entityBasePos.set(p.x, y, p.z);
        grab._entityBaseRotY = yaw;
        if (grab._staticPose?.entityPos) grab._staticPose.entityPos.set(p.x, y, p.z);
        if (!grab._driveVel) grab._driveVel = new THREE.Vector3();
        const bc = botEl.components?.['zerog-bot'];
        if (bc?.velocity) grab._driveVel.copy(bc.velocity);
        else grab._driveVel.set(0, 0, 0);
      }

      showCombatMesh(bodyEl);
      syncBotTargetToHead(botEl, bodyEl, target);

      if (!bodyEl._capvrTinted && grab?.modelLoaded) {
        const color = team === 'red' ? '#ff3355' : '#3388ff';
        grab.model.traverse((n) => {
          if (!n.isMesh || !n.material) return;
          const mats = Array.isArray(n.material) ? n.material : [n.material];
          mats.forEach((m) => {
            if (!m) return;
            if (m.color) m.color.set(color);
            if (m.emissive) {
              m.emissive.set(color);
              if (typeof m.emissiveIntensity === 'number') {
                m.emissiveIntensity = Math.max(0.45, m.emissiveIntensity || 0);
              }
            }
          });
        });
        bodyEl._capvrTinted = true;
      }
    });
  }

  function patchGrabbableDriveVel() {
    const comp = AFRAME.components['grabbable-ragdoll'];
    if (!comp?.Component?.prototype || comp.Component.prototype._capvrDriveVel) return;
    const proto = comp.Component.prototype;
    proto._capvrDriveVel = true;
    const orig = proto._getDummyZeroGVelocity;
    proto._getDummyZeroGVelocity = function () {
      if (this._driveVel && this._driveVel.lengthSq?.() > 0.0001) {
        const v = this._zeroGVelScratch || (this._zeroGVelScratch = new THREE.Vector3());
        v.copy(this._driveVel);
        return v;
      }
      return orig ? orig.call(this) : new THREE.Vector3();
    };
  }

  function boot() {
    patchBotHeadCollision();
    patchGrabbableDriveVel();
    setTimeout(patchBotHeadCollision, 800);
    setTimeout(patchBotHeadCollision, 2500);
    console.log('[CapVR] bot-form: head-sphere wall collision (player-matched) + mesh sync');
  }

  if (window.AFRAME && !AFRAME.components['capvr-bot-form-sync']) {
    AFRAME.registerComponent('capvr-bot-form-sync', {
      tick: function () { syncBotBodies(); }
    });
  }

  const scene = document.querySelector('a-scene');
  function attach() {
    boot();
    const s = document.querySelector('a-scene');
    if (s && !s.hasAttribute('capvr-bot-form-sync')) s.setAttribute('capvr-bot-form-sync', '');
  }
  if (scene?.hasLoaded) setTimeout(attach, 300);
  else scene?.addEventListener('loaded', () => setTimeout(attach, 300), { once: true });
})();
