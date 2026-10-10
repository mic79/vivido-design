/**
 * BattleVR2 — A-Frame + PeerJS bootstrap (from RTSVR6 pattern).
 */
import AFRAME from 'https://cdn.jsdelivr.net/npm/aframe@1.7.0/dist/aframe-master.module.min.js';

window.AFRAME = AFRAME;
window.THREE = AFRAME.THREE;
window.__BATTLEVR2__ = true;

const RTS = new URL('./rts/', import.meta.url);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`BattleVR2 bootstrap: failed to load ${src}`));
    document.head.appendChild(s);
  });
}

await loadScript('https://cdn.jsdelivr.net/gh/c-frame/aframe-extras@7.2.0/dist/aframe-extras.min.js');
await loadScript('https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js');
await loadScript('https://unpkg.com/three-pathfinding@1.3.0/dist/three-pathfinding.umd.js');

// Box3D helpers (classic scripts attach window.Box3DCollision / Box3DPhysicsWorld)
await loadScript(new URL('../vendor/box3d/box3d-collision.js', import.meta.url).href);
await loadScript(new URL('../vendor/box3d/box3d-physics-world.js', import.meta.url).href);

// CapVR-style Mixamo body + zero-G legs (classic AFRAME components)
await loadScript(new URL('./gravity-mode.js', import.meta.url).href);
await loadScript(new URL('./zerog-legs.js', import.meta.url).href);
await loadScript(new URL('./body-foundation.js', import.meta.url).href);
try {
  // Hover body — NOT grounded walking. Do not write CapVR ?mode=zerog into the URL.
  window.BodyRiggedGravity?.setMode?.('zerog', { force: true });
  if (window.BodyRiggedGravity) {
    window.BodyRiggedGravity.allowSwitch = false;
    window.BodyRiggedGravity.clearUrlMode?.();
  }
} catch (_) { /* ignore */ }

const locals = [
  'high-refresh-rate.js',
  'rts-version-fps.js',
  'vr-raycaster-patch.js',
  'vr-hand-ray-setup.js',
  'vr-menu-aframe.js',
  'vr-game-ui-aframe.js',
];

for (let i = 0; i < locals.length; i++) {
  await loadScript(new URL(locals[i], RTS).href);
}

console.log('[BattleVR2] bootstrap ready');
