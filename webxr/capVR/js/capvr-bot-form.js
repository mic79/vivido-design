/**
 * CapVR bot presentation:
 * - ONE visible body per bot: grabbable-ragdoll (ZeroGLegs loco + hit react + shatter)
 * - Upright yaw (BattleVR) — already enforced in zerog-bot; body follows yaw-only
 * - Feed thruster velocity into ZeroGLegs
 * - Do NOT stack CapVR Box3D resolveSphere on top of BoltVR bot surface collision
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
    // CapVR mistake: we replaced BoltVR's single-sphere surface walk with
    // resolveSphere × many probes × 3 iters AND kept the surface forEach.
    // That was CapVR glue, not a BoltVR / Box3D flaw. Leave the BoltVR method alone.
    const comp = AFRAME.components['zerog-bot'];
    const proto = comp?.Component?.prototype;
    if (!proto || !proto._capvrHeadCollide) return;
    // If a prior tab/hot session already overwrote the method, we can't restore it here.
    // Hard refresh loads the original registerComponent body from index.html.
    delete proto._capvrHeadCollide;
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
    const botsOn = !(window.perfConfig && window.perfConfig.botLogicEnabled === false);
    BOT_VIS.forEach(({ bot, body, team }) => {
      const botEl = document.getElementById(bot);
      const bodyEl = document.getElementById(body);
      if (!botEl || !bodyEl?.object3D) return;
      if (!botsOn || bodyEl.components?.['grabbable-ragdoll']?.data?.paused) {
        return;
      }

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

  // Drive syncBotBodies from an A-Frame tick, NOT window.requestAnimationFrame.
  // window.rAF is paused during an immersive WebXR session, so the old rAF loop
  // stopped positioning bots in VR (and double-ran on flatscreen). A registered
  // component tick runs on the XR render loop.
  function boot() {
    patchBotHeadCollision();
    patchGrabbableDriveVel();
    setTimeout(patchBotHeadCollision, 800);
    setTimeout(patchBotHeadCollision, 2500);
    console.log('[CapVR] bot-form: combat body sync (BoltVR collision, no CapVR resolve stack)');
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
