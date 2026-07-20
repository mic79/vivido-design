/**
 * Room loader + VR thumbstick move for A-Frame (spaceshooter stack).
 *
 * Floor = planar GlossyReflector.
 * Walls/ceiling = baked lightmaps only (no env-map specular — that caused
 * the view-dependent bright blob that wasn't a real light).
 */
import AFRAME from 'aframe';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { GlossyReflector } from './GlossyReflector.js?v=47';
import './tonemapOnly.js?v=37';

const ROOM_GLB = new URL('../white_room.glb', import.meta.url).href;
const LUMEN_TABLE_GLB = new URL('../assets/lumen_hologram_table.glb', import.meta.url).href;
const GEOSYNTH_TABLE_GLB = new URL('../assets/geosynth_table.glb', import.meta.url).href;
/** Same super-three build as the import map — required for KHR_texture_basisu */
const BASIS_TRANSCODER =
  'https://cdn.jsdelivr.net/npm/super-three@0.173.5/examples/jsm/libs/basis/';
const ROOM_W = 7;
const ROOM_H = 3.6;
const ROOM_D = 14;
const HD = ROOM_D * 0.5;

/** Slight lift so baked walls read closer to the icy floor tint */
const SURFACE_COLOR = new THREE.Color(1.05, 1.08, 1.1);

function tuneMap(renderer, map) {
  if (!map) return;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = renderer.capabilities.getMaxAnisotropy();
  map.needsUpdate = true;
}

function makeWallCeilingMaterial(src, renderer) {
  tuneMap(renderer, src.map);
  // Bake only — no envMap/metalness (those create fake specular blobs)
  return new THREE.MeshBasicMaterial({
    map: src.map || null,
    color: SURFACE_COLOR.clone(),
    side: THREE.DoubleSide,
  });
}

const BLOOM_ON = 'threshold: 0.98; strength: 0.225; radius: 0.11';

AFRAME.registerComponent('white-room', {
  init() {
    const sceneEl = this.el.sceneEl;
    if (sceneEl.hasLoaded) this.build();
    else sceneEl.addEventListener('loaded', () => this.build(), { once: true });
  },

  async build() {
    const sceneEl = this.el.sceneEl;
    const scene = sceneEl.object3D;
    const renderer = sceneEl.renderer;

    const ktx2Loader = new KTX2Loader().setTranscoderPath(BASIS_TRANSCODER).detectSupport(renderer);
    const gltfLoader = new GLTFLoader().setKTX2Loader(ktx2Loader);

    const gltf = await gltfLoader.loadAsync(ROOM_GLB);

    const root = gltf.scene;
    root.updateMatrixWorld(true);
    /** Matte stand-ins for the floor mirror camera */
    const floorMirrorProxies = [];
    /** Real wall/ceiling meshes — hidden during floor mirror capture */
    const wallCeilingMeshes = [];

    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.castShadow = false;
      o.receiveShadow = false;
      const src = o.material;
      tuneMap(renderer, src.map);

      if (/cove/i.test(o.name)) {
        o.visible = false;
        return;
      }

      if (/floor/i.test(o.name)) {
        // Hidden — replaced by GlossyReflector
        o.visible = false;
        return;
      }

      if (/wall|ceiling/i.test(o.name)) {
        o.material = makeWallCeilingMaterial(src, renderer);
        wallCeilingMeshes.push(o);
        const proxy = o.clone();
        proxy.material = new THREE.MeshBasicMaterial({
          map: src.map || null,
          color: new THREE.Color(0.92, 0.96, 0.97),
          side: THREE.DoubleSide,
        });
        proxy.visible = false;
        floorMirrorProxies.push(proxy);
        return;
      }

      if (/light/i.test(o.name)) {
        o.material = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: new THREE.Color(0xe8f4f8),
          emissiveIntensity: 2.5,
          roughness: 1,
          metalness: 0,
          side: THREE.DoubleSide,
        });
        return;
      }

      o.material = new THREE.MeshBasicMaterial({
        map: src.map || null,
        color: new THREE.Color(0.92, 0.96, 0.97),
        side: THREE.DoubleSide,
      });
    });

    scene.add(root);
    for (const p of floorMirrorProxies) scene.add(p);
    GlossyReflector.setBakeProxies(floorMirrorProxies, wallCeilingMeshes);

    // Floor reflector — full wall height curve; tables forced to max blur via height stamp
    const floor = new GlossyReflector(new THREE.PlaneGeometry(ROOM_W - 0.04, ROOM_D - 0.04), {
      resolution: 768,
      color: 0xd5e8ea,
      mirrorStrength: 0.48,
      mixBlur: 1.0,
      fresnelPower: 2.6,
      baseLift: 0.5,
      maxDist: ROOM_H,
      heightSharp: 0.32,
      heightSoft: 0.75,
      nearBlur: 0,
      blurKernels: [5.0, 11.0, 20.0, 34.0],
      clipBias: 0.003,
    });
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.012;
    scene.add(floor);

    if (new URLSearchParams(location.search).has('debugHeight')) {
      floor.setDebugHeight?.(true);
    }

    const panelMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: new THREE.Color(0xf2f8fa),
      emissiveIntensity: 3.0,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    for (const yBlender of [-HD + 1.85, -HD + 2.85]) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 0.55), panelMat.clone());
      panel.rotation.x = Math.PI / 2;
      panel.position.set(0, ROOM_H - 0.05, -yBlender);
      scene.add(panel);
    }

    const tables = (
      await Promise.all([
        placePropTable(gltfLoader, renderer, scene, GEOSYNTH_TABLE_GLB, {
          x: 0,
          z: 0,
          yaw: 0,
          fixMaterials: fixGeosynthTableMaterials,
        }),
        placePropTable(gltfLoader, renderer, scene, LUMEN_TABLE_GLB, {
          x: 0,
          yaw: Math.PI + Math.PI / 2,
          alignWall: '+z',
          fixMaterials: fixLumenTableMaterials,
        }),
      ])
    ).filter(Boolean);
    GlossyReflector.setSoftMeshes(tables);
  },
});

/** Load a GLB, tune materials, sit on floor at (x,z) with yaw. */
async function placePropTable(loader, renderer, scene, url, opts) {
  const {
    x = 0,
    z = 0,
    yaw = 0,
    alignWall = null,
    wallInset = 0.08,
    fixMaterials,
  } = opts;
  try {
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;
    fixMaterials?.(root);
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        tuneMap(renderer, m.map);
        tuneMap(renderer, m.emissiveMap);
        // Keep additive hologram emissive out of tonemap so bloom picks it up
        if ('toneMapped' in m && m.blending !== THREE.AdditiveBlending) {
          m.toneMapped = true;
        }
      }
    });
    root.rotation.y = yaw;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    let px = x - (box.min.x + box.max.x) * 0.5;
    let pz;
    if (alignWall === '+z') {
      pz = HD - wallInset - box.max.z;
    } else if (alignWall === '-z') {
      pz = -HD + wallInset - box.min.z;
    } else {
      pz = z - (box.min.z + box.max.z) * 0.5;
    }
    root.position.set(px, -box.min.y + 0.012, pz);
    scene.add(root);
    return root;
  } catch (err) {
    console.warn('[white-room] table failed to load', url, err);
    return null;
  }
}

/**
 * Lumen table meshes share one Sketchfab atlas: opaque body + soft hologram alpha.
 * Body keeps BLEND+depthWrite so UI overlays stay translucent; glass/shaft blend
 * without writing depth (alphaTest was wrong — it made the laser plane a solid slab).
 */
function fixLumenTableMaterials(root) {
  const roleOf = (mesh) => {
    const matName = (mesh.material?.name || '').toLowerCase();
    if (matName.includes('shaft')) return 'shaft';
    if (matName.includes('glass')) return 'glass';
    if (matName.includes('body')) return 'body';
    let n = mesh;
    for (let i = 0; i < 8 && n; i++) {
      const name = (n.name || '').toLowerCase();
      if (name.includes('glass')) return 'glass';
      if (name.includes('shaft')) return 'shaft';
      if (name.includes('table') || name.includes('holi')) return 'body';
      n = n.parent;
    }
    return 'body';
  };

  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const role = roleOf(o);
    const mat = o.material.clone();
    o.material = mat;
    mat.side = THREE.DoubleSide;

    // Soft atlas alpha — never alphaTest (that turns hologram planes into solid slabs)
    mat.alphaTest = 0;
    mat.opacity = 1;

    if (role === 'body') {
      // Mostly opaque; holographic UI windows live in the same atlas alpha
      mat.transparent = true;
      mat.depthWrite = true;
      mat.depthTest = true;
      mat.blending = THREE.NormalBlending;
      o.renderOrder = 0;
    } else {
      // Glass cover + shaft laser: soft atlas alpha (NormalBlending — Additive ignores alpha)
      mat.transparent = true;
      mat.depthWrite = false;
      mat.depthTest = true;
      mat.blending = THREE.NormalBlending;
      mat.toneMapped = true;
      // Sketchfab emissiveStrength ~3 + bloom washed the plane to a solid neon slab
      if ('emissiveIntensity' in mat) {
        mat.emissiveIntensity = Math.min(mat.emissiveIntensity || 1, 0.85);
      }
      o.renderOrder = role === 'glass' ? 2 : 3;
    }
    mat.needsUpdate = true;
  });
}

/** Geosynth already has OPAQUE body + BLEND hologram — reinforce depthWrite. */
function fixGeosynthTableMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mat = o.material.clone();
    o.material = mat;
    const name = (mat.name || o.name || '').toLowerCase();
    if (name.includes('hologram') || mat.transparent) {
      mat.transparent = true;
      mat.depthWrite = false;
      mat.depthTest = true;
      o.renderOrder = 2;
    } else {
      mat.transparent = false;
      mat.depthWrite = true;
      mat.alphaTest = 0.01;
      o.renderOrder = 0;
    }
    mat.needsUpdate = true;
  });
}
/** Real frame rate from A-Frame tick deltas — visible in VR (parented to camera). */
AFRAME.registerComponent('fps-display', {
  init() {
    this._frames = 0;
    this._lastT = 0;
    this._fps = 0;
    this.el.setAttribute('text', {
      value: '-- FPS',
      align: 'center',
      anchor: 'center',
      width: 1.4,
      color: '#e8ffff',
      opacity: 0.95,
      font: 'roboto',
    });
    // Layer 1 = HUD only (floor mirror camera stays on layer 0)
    this.el.object3D.traverse((o) => o.layers.set(1));
    this.el.addEventListener('object3dset', () => {
      this.el.object3D.traverse((o) => o.layers.set(1));
    });
  },

  tick(t) {
    // Keep HUD on layer 1 (A-Frame text may recreate meshes)
    this.el.object3D.traverse((o) => {
      if (o.layers) o.layers.set(1);
    });
    // Player camera must see layer 1 (incl. XR ArrayCamera eyes)
    const cam = this.el.sceneEl?.camera;
    if (cam) {
      cam.layers.enable(1);
      if (cam.cameras) {
        for (const c of cam.cameras) c.layers.enable(1);
      }
    }

    if (!this._lastT) this._lastT = t;
    this._frames++;
    const elapsed = t - this._lastT;
    if (elapsed < 400) return;
    this._fps = Math.round((this._frames * 1000) / elapsed);
    this._frames = 0;
    this._lastT = t;
    const label = `${this._fps} FPS`;
    this.el.setAttribute('text', 'value', label);
    const desk = document.getElementById('fps-desktop');
    if (desk) desk.textContent = label;
  },
});

/** Right Quest A / desktop B — toggle bloom.
 *  OFF removes UnrealBloom (real FPS win) but keeps OutputPass tonemap so floor color matches.
 */
AFRAME.registerComponent('bloom-toggle', {
  init() {
    this._aLatched = false;
    this._bLatched = false;
    this._bloomOn = this.el.hasAttribute('bloom');

    this._onKeyDown = (e) => {
      if (e.code !== 'KeyB' || this.el.is('vr-mode')) return;
      if (this._bLatched) return;
      this._bLatched = true;
      this.toggleBloom();
    };
    this._onKeyUp = (e) => {
      if (e.code === 'KeyB') this._bLatched = false;
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  },

  remove() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  },

  toggleBloom() {
    const sceneEl = this.el;
    if (this._bloomOn) {
      // Drop expensive UnrealBloom; keep tonemap-only for color match
      sceneEl.removeAttribute('bloom');
      sceneEl.setAttribute('tonemap-only', 'enabled: true');
      this._bloomOn = false;
    } else {
      sceneEl.setAttribute('tonemap-only', 'enabled: false');
      sceneEl.setAttribute('bloom', BLOOM_ON);
      this._bloomOn = true;
    }
  },

  tick() {
    const sceneEl = this.el;
    if (!sceneEl.is('vr-mode')) {
      this._aLatched = false;
      return;
    }

    const session = sceneEl.renderer?.xr?.getSession?.();
    if (!session) return;

    let aDown = false;
    for (const src of session.inputSources) {
      if (src.handedness !== 'right' || !src.gamepad?.buttons?.[4]) continue;
      aDown = src.gamepad.buttons[4].pressed;
      break;
    }

    if (aDown && !this._aLatched) {
      this._aLatched = true;
      this.toggleBloom();
    } else if (!aDown) {
      this._aLatched = false;
    }
  },
});

AFRAME.registerComponent('thumbstick-move', {
  init() {
    this.turnLatched = false;
    this.tmpFwd = new THREE.Vector3();
    this.tmpRight = new THREE.Vector3();
    this.tmpP0 = new THREE.Vector3();
    this.tmpP1 = new THREE.Vector3();
  },

  pickStick(axes) {
    if (!axes) return [0, 0];
    const a01 = Math.hypot(axes[0] || 0, axes[1] || 0);
    const a23 = Math.hypot(axes[2] || 0, axes[3] || 0);
    return a23 >= a01 ? [axes[2] || 0, axes[3] || 0] : [axes[0] || 0, axes[1] || 0];
  },

  tick(_t, dtMs) {
    const sceneEl = this.el.sceneEl;
    if (!sceneEl.is('vr-mode')) return;
    const renderer = sceneEl.renderer;
    const session = renderer?.xr?.getSession?.();
    if (!session) return;

    const rig = document.querySelector('#rig');
    const head = document.querySelector('#head');
    if (!rig || !head) return;

    const dt = Math.min(dtMs / 1000, 0.05);
    let lx = 0;
    let ly = 0;
    let rx = 0;
    for (const src of session.inputSources) {
      if (!src.gamepad || !src.handedness) continue;
      const [sx, sy] = this.pickStick(src.gamepad.axes);
      if (src.handedness === 'left') {
        lx = -sx;
        ly = sy;
      } else if (src.handedness === 'right') {
        rx = sx;
      }
    }

    const rigObj = rig.object3D;
    const headObj = head.object3D;
    const dead = 0.15;
    if (Math.abs(lx) > dead || Math.abs(ly) > dead) {
      headObj.getWorldDirection(this.tmpFwd);
      this.tmpFwd.y = 0;
      if (this.tmpFwd.lengthSq() > 1e-6) this.tmpFwd.normalize();
      this.tmpRight.set(-this.tmpFwd.z, 0, this.tmpFwd.x);
      const k = 2.4 * dt;
      rigObj.position.addScaledVector(this.tmpFwd, ly * k);
      rigObj.position.addScaledVector(this.tmpRight, lx * k);
      rigObj.position.x = THREE.MathUtils.clamp(rigObj.position.x, -3.1, 3.1);
      rigObj.position.z = THREE.MathUtils.clamp(rigObj.position.z, -6.3, 6.3);
    }

    if (Math.abs(rx) > 0.7 && !this.turnLatched) {
      this.turnLatched = true;
      headObj.getWorldPosition(this.tmpP0);
      rigObj.rotation.y += (rx > 0 ? -1 : 1) * THREE.MathUtils.degToRad(30);
      rigObj.updateMatrixWorld(true);
      headObj.getWorldPosition(this.tmpP1);
      rigObj.position.x += this.tmpP0.x - this.tmpP1.x;
      rigObj.position.z += this.tmpP0.z - this.tmpP1.z;
    } else if (Math.abs(rx) < 0.4) {
      this.turnLatched = false;
    }
  },
});
