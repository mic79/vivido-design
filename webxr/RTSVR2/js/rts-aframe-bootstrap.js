/**
 * Loads A-Frame 1.7 (ESM), then legacy script addons.
 * `rts-version-fps` loads as a classic script; the scene may miss it on first parse — flush re-applies.
 */
import AFRAME from 'https://cdn.jsdelivr.net/npm/aframe@1.7.0/dist/aframe-master.module.min.js';

window.AFRAME = AFRAME;
window.THREE = AFRAME.THREE;

const HERE = new URL('./', import.meta.url);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`RTSVR2 bootstrap: failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function flushRtsVersionFpsComponent() {
  const sc = document.getElementById('game-scene') || document.querySelector('a-scene');
  if (!sc || !globalThis.AFRAME || !AFRAME.components || !AFRAME.components['rts-version-fps']) return;
  if (!sc.hasAttribute('rts-version-fps')) return;
  if (sc.components && sc.components['rts-version-fps']) return;
  const v = sc.getAttribute('rts-version-fps');
  sc.removeAttribute('rts-version-fps');
  sc.setAttribute('rts-version-fps', v == null ? '' : v);
}

function flushDeferredSceneComponents() {
  flushRtsVersionFpsComponent();
}

await loadScript('https://cdn.jsdelivr.net/gh/c-frame/aframe-extras@7.2.0/dist/aframe-extras.min.js');
flushDeferredSceneComponents();

await loadScript('https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js');

const locals = [
  'high-refresh-rate.js',
  'rts-version-fps.js',
  'vr-raycaster-patch.js',
  'vr-hand-ray-setup.js',
  'vr-menu-aframe.js',
  'vr-game-ui-aframe.js',
];

for (let i = 0; i < locals.length; i++) {
  await loadScript(new URL(locals[i], HERE).href);
  flushDeferredSceneComponents();
}

flushDeferredSceneComponents();
requestAnimationFrame(() => flushDeferredSceneComponents());
