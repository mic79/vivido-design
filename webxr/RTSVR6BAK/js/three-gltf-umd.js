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

/** One KTX2Loader per page — multiple instances warn and fight over the Basis worker. */
let sharedKtx2Loader = null;
let sharedKtx2Renderer = null;

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

/**
 * Shared Basis/KTX2 loader for kits + mesa HQ. Call after `ensureThreeGltfLoaders()`.
 * @param {import('three').WebGLRenderer} renderer
 */
export async function getSharedKtx2Loader(renderer) {
  await ensureThreeGltfLoaders();
  const THREE = window.THREE;
  if (!renderer || !THREE?.KTX2Loader) return null;
  if (sharedKtx2Loader && sharedKtx2Renderer === renderer) return sharedKtx2Loader;
  if (sharedKtx2Loader && typeof sharedKtx2Loader.dispose === 'function') {
    try {
      sharedKtx2Loader.dispose();
    } catch (_) {
      /* */
    }
  }
  sharedKtx2Loader = new THREE.KTX2Loader()
    .setTranscoderPath('https://cdn.jsdelivr.net/npm/super-three@0.173.4/examples/jsm/libs/basis/')
    .detectSupport(renderer);
  sharedKtx2Renderer = renderer;
  return sharedKtx2Loader;
}
