/**
 * CapVR bot presentation + collision:
 * - ONE visible body per bot: grabbable-ragdoll (ZeroGLegs loco + hit react + shatter)
 * - Upright yaw (BattleVR) — already enforced in zerog-bot; body follows yaw-only
 * - Box3D head/torso depenetration
 * - Feed thruster velocity into ZeroGLegs
 */
(function () {
  'use strict';

  const THREE = (window.AFRAME && window.AFRAME.THREE) || window.THREE;

  // body id = combat mesh (grabbable-ragdoll). No separate invisible proxy.
  const BOT_VIS = [
    { bot: 'zerog-bot-red', body: 'bot-red-body', team: 'red' },
    { bot: 'zerog-bot-blue', body: 'bot-blue-body', team: 'blue' },
    { bot: 'zerog-bot-green', body: 'bot-green-body', team: 'blue' }
  ];

  function patchBotHeadCollision() {
    const comp = AFRAME.components['zerog-bot'];
    if (!comp?.Component?.prototype?.checkCustomCollisionWithSurfaces) return;
    const proto = comp.Component.prototype;
    proto._capvrHeadCollide = true;

    const TORSO_R = 0.35;
    const HEAD_R = 0.28;
    const HEAD_OFFSETS = [0.35, 0.85, 1.45];

    proto.checkCustomCollisionWithSurfaces = function () {
      if (!this.body) return;
      const bp = this.body.position;
      const probes = [
        { x: bp.x, y: bp.y, z: bp.z, r: TORSO_R }
      ];
      HEAD_OFFSETS.forEach((oy) => {
        probes.push({ x: bp.x, y: bp.y + oy, z: bp.z, r: HEAD_R });
      });

      const owner = this.el.id?.replace('zerog-', '');
      const bodyEl = owner && document.getElementById(`${owner}-body`);
      const headBone = bodyEl?.components?.['grabbable-ragdoll']?.bones?.head
        || bodyEl?.components?.['mixamo-body-avatar']?.bones?.head;
      if (headBone) {
        const hp = new THREE.Vector3();
        headBone.getWorldPosition(hp);
        probes.push({ x: hp.x, y: hp.y, z: hp.z, r: HEAD_R });
      }

      let dx = 0;
      let dy = 0;
      let dz = 0;

      const phys = window.CapVRPhysics?.get?.();
      if (phys?.resolveSphere) {
        if (!this._capvrProbeV) this._capvrProbeV = new THREE.Vector3();
        const sample = this._capvrProbeV;
        for (let iter = 0; iter < 3; iter++) {
          let moved = false;
          for (let i = 0; i < probes.length; i++) {
            const p = probes[i];
            sample.set(p.x + dx, p.y + dy, p.z + dz);
            const resolved = phys.resolveSphere(sample, p.r, {
              horizontalOnly: false,
              exclude: []
            });
            if (!resolved?.position) continue;
            const px = resolved.position.x - sample.x;
            const py = resolved.position.y - sample.y;
            const pz = resolved.position.z - sample.z;
            if (px * px + py * py + pz * pz > 1e-8) {
              dx += px;
              dy += py;
              dz += pz;
              moved = true;
            }
          }
          if (!moved) break;
        }
      }

      const collisionCulling = this.el.sceneEl.components['collision-culling'];
      const botId = this.el.id;
      const surfaces = collisionCulling && collisionCulling.data.enabled &&
        collisionCulling.culledSurfaces.bots[botId]?.length
        ? collisionCulling.culledSurfaces.bots[botId]
        : document.querySelectorAll('[grab-surface]');

      surfaces.forEach((surface) => {
        if (surface.hasAttribute('data-visual-only') || surface.classList.contains('wireframe-visual-only')) {
          return;
        }
        const surfacePos = new THREE.Vector3();
        surface.object3D.getWorldPosition(surfacePos);
        const geometry = surface.getAttribute('geometry');
        if (!geometry || !this.getCollisionResponse) return;
        for (let i = 0; i < probes.length; i++) {
          const p = probes[i];
          const pos = new THREE.Vector3(p.x + dx, p.y + dy, p.z + dz);
          const collision = this.getCollisionResponse(pos, p.r, surfacePos, geometry, surface);
          if (collision.length() > 0) {
            dx += collision.x;
            dy += collision.y;
            dz += collision.z;
          }
        }
      });

      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) return;
      const maxPush = 0.85;
      const s = len > maxPush ? maxPush / len : 1;
      this.body.position.x += dx * s;
      this.body.position.y += dy * s;
      this.body.position.z += dz * s;
      if (this.velocity) {
        const dir = new THREE.Vector3(dx, dy, dz).normalize();
        const into = this.velocity.dot(dir);
        if (into < 0) this.velocity.addScaledVector(dir, -into);
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
        // Undo any prior proxy-hide pass
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

  // Keep physics bots from drifting outside the CTF field and sniping from void.
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

  function syncBotBodies() {
    BOT_VIS.forEach(({ bot, body, team }) => {
      const botEl = document.getElementById(bot);
      const bodyEl = document.getElementById(body);
      if (!botEl || !bodyEl?.object3D) return;

      leashBotPhysics(botEl);

      const grab = bodyEl.components?.['grabbable-ragdoll'];
      const owner = bot.replace('zerog-', '');
      // Premature ragdoll while still alive freezes the mesh -> phantom lasers. Undo it.
      if (grab?.ragdollActive && window.CapVRCombat?.isBotAlive?.(owner)) {
        try { grab.resetRagdoll?.(); } catch (e) { /* */ }
      }
      // While full physics ragdoll / shatter collapse is active on a dead bot, don't teleport
      if (grab?.ragdollActive) return;

      const p = botEl.body?.position || botEl.object3D.position;
      // Feet hang: hips ~1m below chest physics center (same convention as updateBotBody)
      const y = (p.y || 0) - 1.0;
      bodyEl.object3D.position.set(p.x, y, p.z);

      const yaw = botEl.object3D.rotation.y;
      // Mixamo faces -Z; bot thrusters face +Z → +π
      bodyEl.object3D.rotation.set(0, yaw + Math.PI, 0);

      if (grab) {
        if (grab._entityBasePos) grab._entityBasePos.set(p.x, y, p.z);
        grab._entityBaseRotY = yaw + Math.PI;
        if (grab._staticPose?.entityPos) grab._staticPose.entityPos.set(p.x, y, p.z);
        if (!grab._driveVel) grab._driveVel = new THREE.Vector3();
        const bc = botEl.components?.['zerog-bot'];
        if (bc?.velocity) grab._driveVel.copy(bc.velocity);
        else grab._driveVel.set(0, 0, 0);
      }

      showCombatMesh(bodyEl);

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

  function tick() {
    syncBotBodies();
    requestAnimationFrame(tick);
  }

  function boot() {
    patchBotHeadCollision();
    patchGrabbableDriveVel();
    setTimeout(patchBotHeadCollision, 800);
    setTimeout(patchBotHeadCollision, 2500);
    requestAnimationFrame(tick);
    console.log('[CapVR] bot-fix: unified combat body (loco+shatter) + Box3D head collide');
  }

  const scene = document.querySelector('a-scene');
  if (scene?.hasLoaded) setTimeout(boot, 300);
  else scene?.addEventListener('loaded', () => setTimeout(boot, 300), { once: true });
})();
