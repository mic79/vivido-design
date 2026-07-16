/**
 * CapVR material / shader batching helpers.
 *
 * Cuts Three.js program + unique-material counts by:
 *  1. Sharing one MeshStandardMaterial instance across arena meshes with the
 *     same look (color / metalness / roughness / opacity / emissive).
 *  2. Sharing avatar materials by tint key (team color / emissive), so remotes
 *     and bots of the same team do not each own a private clone.
 *
 * Local-player dissolve mutates materials in place — those stay unshared.
 */
(function () {
  'use strict';

  const arenaPool = new Map();   // lookKey -> Material
  const avatarPool = new Map();  // tintKey -> Material
  let consolidateTimer = null;
  let lastStats = { replaced: 0, kept: 0, poolSize: 0 };

  function hexOf(c) {
    if (!c) return '000000';
    if (typeof c === 'number') return ('000000' + (c >>> 0).toString(16)).slice(-6);
    if (c.isColor) return c.getHexString();
    try {
      return new THREE.Color(c).getHexString();
    } catch (e) {
      return '000000';
    }
  }

  function lookKey(mat) {
    if (!mat || !mat.isMeshStandardMaterial) return null;
    // Textured / animated / skinned materials stay instance-local.
    if (mat.map || mat.normalMap || mat.roughnessMap || mat.metalnessMap ||
        mat.emissiveMap || mat.aoMap || mat.alphaMap || mat.lightMap ||
        mat.bumpMap || mat.displacementMap || mat.envMap) {
      return null;
    }
    if (mat.skinning || mat.morphTargets || mat.morphNormals) return null;
    if (mat.userData && mat.userData.capvrNoShare) return null;

    return [
      'std',
      hexOf(mat.color),
      hexOf(mat.emissive),
      (mat.metalness || 0).toFixed(3),
      (mat.roughness || 0).toFixed(3),
      mat.transparent ? 1 : 0,
      (mat.opacity == null ? 1 : mat.opacity).toFixed(3),
      (mat.emissiveIntensity == null ? 1 : mat.emissiveIntensity).toFixed(3),
      mat.side | 0,
      mat.flatShading ? 1 : 0,
      mat.wireframe ? 1 : 0,
      mat.depthWrite === false ? 0 : 1,
      mat.userData && mat.userData.gridKey ? 'g' : 'n'
    ].join('|');
  }

  function baseAvatarKey(mat) {
    if (!mat) return 'none';
    // Identity of the GLB/FBX source look (maps + base params), ignoring tint.
    const mapId = mat.map ? mat.map.uuid : 'nomap';
    const nId = mat.normalMap ? mat.normalMap.uuid : 'nonorm';
    return [
      mapId,
      nId,
      (mat.metalness || 0).toFixed(3),
      (mat.roughness || 0).toFixed(3),
      mat.transparent ? 1 : 0,
      (mat.opacity == null ? 1 : mat.opacity).toFixed(3),
      mat.side | 0
    ].join('|');
  }

  function avatarTint(src, opts) {
    if (!src || typeof THREE === 'undefined') return src;
    opts = opts || {};
    if (src.userData && src.userData.capvrNoShare) {
      // Caller asked for a private material — clone once and leave unshared.
      const priv = src.clone();
      if (opts.color != null && priv.color) priv.color.set(opts.color);
      if (opts.emissive != null && priv.emissive) priv.emissive.setHex(opts.emissive);
      if (opts.emissiveIntensity != null) priv.emissiveIntensity = opts.emissiveIntensity;
      priv.userData.capvrNoShare = true;
      return priv;
    }

    const colorHex = opts.color != null ? hexOf(opts.color) : hexOf(src.color);
    const emHex = opts.emissive != null ? hexOf(opts.emissive) : hexOf(src.emissive);
    const emI = opts.emissiveIntensity != null
      ? opts.emissiveIntensity
      : (src.emissiveIntensity == null ? 1 : src.emissiveIntensity);
    const key = baseAvatarKey(src) + '|c:' + colorHex + '|e:' + emHex + '|ei:' + Number(emI).toFixed(3);

    let m = avatarPool.get(key);
    if (!m) {
      m = src.clone();
      if (m.color) m.color.set('#' + colorHex);
      if (m.emissive) m.emissive.setHex(parseInt(emHex, 16));
      m.emissiveIntensity = emI;
      // Ensure skinned flag survives for MeshStandardMaterial used on skinned meshes.
      if (src.skinning) m.skinning = true;
      avatarPool.set(key, m);
    }
    return m;
  }

  function applyAvatarTint(root, opts) {
    if (!root) return 0;
    let n = 0;
    root.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      const next = mats.map((mat) => {
        n++;
        return avatarTint(mat, opts);
      });
      node.material = Array.isArray(node.material) ? next : next[0];
    });
    return n;
  }

  function consolidateRoot(root) {
    if (!root || typeof THREE === 'undefined') return lastStats;
    let replaced = 0;
    let kept = 0;

    root.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      if (node.isSkinnedMesh) return;
      if (node.userData && node.userData.capvrNoShare) return;

      const mats = Array.isArray(node.material) ? node.material : [node.material];
      let changed = false;
      const next = mats.map((mat) => {
        const key = lookKey(mat);
        if (!key) {
          kept++;
          return mat;
        }
        const existing = arenaPool.get(key);
        if (existing && existing !== mat) {
          replaced++;
          changed = true;
          return existing;
        }
        if (!existing) arenaPool.set(key, mat);
        kept++;
        return mat;
      });

      if (changed) {
        node.material = Array.isArray(node.material) ? next : next[0];
      }
    });

    lastStats = { replaced, kept, poolSize: arenaPool.size };
    return lastStats;
  }

  function refreshDistanceGrids() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[distance-grid]').forEach((el) => {
      const comp = el.components && el.components['distance-grid'];
      if (comp && typeof comp.ensureHooks === 'function') {
        // Drop orphaned uniform refs from pre-consolidate hooks.
        if (Array.isArray(comp.hooked)) comp.hooked.length = 0;
        comp.ensureHooks();
      }
    });
  }

  function consolidateScene() {
    const scene = document.querySelector('a-scene');
    if (!scene || !scene.object3D) return lastStats;
    const stats = consolidateRoot(scene.object3D);
    refreshDistanceGrids();
    if (typeof console !== 'undefined' && console.log) {
      console.log(
        '[CapVRMaterials] arena share: replaced=' + stats.replaced +
        ' kept=' + stats.kept + ' pool=' + stats.poolSize
      );
    }
    return stats;
  }

  function scheduleConsolidate(delayMs) {
    if (consolidateTimer) clearTimeout(consolidateTimer);
    consolidateTimer = setTimeout(() => {
      consolidateTimer = null;
      consolidateScene();
    }, delayMs == null ? 250 : delayMs);
  }

  function bindAuto() {
    const scene = document.querySelector('a-scene');
    if (!scene) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindAuto, { once: true });
      } else {
        setTimeout(bindAuto, 50);
      }
      return;
    }
    const run = () => {
      scheduleConsolidate(400);
      scheduleConsolidate(1500);
    };
    if (scene.hasLoaded) run();
    else scene.addEventListener('loaded', run, { once: true });
    scene.addEventListener('arena-loaded', () => scheduleConsolidate(200));
  }

  window.CapVRMaterials = {
    lookKey,
    avatarTint,
    applyAvatarTint,
    consolidateRoot,
    consolidateScene,
    scheduleConsolidate,
    getStats: function () {
      return {
        arenaPool: arenaPool.size,
        avatarPool: avatarPool.size,
        last: lastStats
      };
    },
    /** Debug / console: force a re-pass */
    bake: consolidateScene
  };

  bindAuto();
})();
