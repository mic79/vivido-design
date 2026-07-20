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
import { GlossyReflector } from './GlossyReflector.js?v=20';

const ROOM_GLB = new URL('../white_room.glb', import.meta.url).href;
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

    const gltf = await new GLTFLoader().loadAsync(ROOM_GLB);

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

    // Floor only: planar reflector (the look that was working)
    const floor = new GlossyReflector(new THREE.PlaneGeometry(ROOM_W - 0.04, ROOM_D - 0.04), {
      resolution: 512,
      color: 0xd5e8ea,
      mirrorStrength: 0.48,
      mixBlur: 1.0,
      fresnelPower: 2.6,
      baseLift: 0.5,
      maxDist: ROOM_H,
      heightSharp: 0.32,
      heightSoft: 0.75,
      blurKernels: [2.0, 4.0, 7.0, 11.0],
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
  },
});

/** Real frame rate from A-Frame tick deltas — visible in VR (parented to camera). */
AFRAME.registerComponent('fps-display', {
  init() {
    this._frames = 0;
    this._lastT = 0;
    this._fps = 0;
    this.el.setAttribute('text', {
      value: '-- FPS',
      align: 'left',
      width: 0.8,
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
