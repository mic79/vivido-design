/**
 * GLTF / Draco / KTX2 loaders attached to A-Frame's THREE (global).
 * ESM `three/addons` pulls a second Three.js via the importmap and breaks VR culling / perf.
 */
let loadPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const key = `script[data-rts-three-umd="${src}"]`;
    if (document.querySelector(key)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.dataset.rtsThreeUmd = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

const THREE_EXAMPLES = 'https://cdn.jsdelivr.net/npm/three@0.173.4/examples/js';

export function ensureThreeGltfLoaders() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const THREE = window.THREE;
    if (!THREE) throw new Error('A-Frame THREE missing');
    if (!THREE.GLTFLoader) {
      await loadScript(`${THREE_EXAMPLES}/loaders/GLTFLoader.js`);
    }
    if (!THREE.DRACOLoader) {
      await loadScript(`${THREE_EXAMPLES}/loaders/DRACOLoader.js`);
    }
    if (!THREE.KTX2Loader) {
      await loadScript(`${THREE_EXAMPLES}/loaders/KTX2Loader.js`);
    }
  })();
  return loadPromise;
}
