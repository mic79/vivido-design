// ========================================
// RTSVR3 — Nav walkability debug (world overlay + texture refresh)
// Toggle: N key (in match, menu closed), or `?navDebug=1` / `window.RTS_NAV_DEBUG = true` before load.
// ========================================

import * as Pathfinding from './pathfinding.js';
import * as State from './state.js';

let root = null;
let mesh = null;
let canvas = null;
let texture = null;
let material = null;
let ctx2d = null;

function paintNavTexture() {
  if (!canvas || !ctx2d || !texture) return;
  Pathfinding.fillNavWalkabilityToCanvas2D(canvas, ctx2d);
  texture.needsUpdate = true;
}

function onNavRebuilt() {
  paintNavTexture();
}

/**
 * Horizontal translucent plane showing walkable (blue) vs blocked nav cells in world space.
 */
export function initNavDebugOverlay(sceneEl) {
  if (!sceneEl || !sceneEl.object3D || root) return;
  const THREE = window.THREE;
  if (!THREE) return;

  const spec = Pathfinding.getNavGridSpec();
  canvas = document.createElement('canvas');
  canvas.width = spec.cols;
  canvas.height = spec.rows;
  ctx2d = canvas.getContext('2d', { willReadFrequently: true });

  texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = true;

  const span = spec.planeSpanM;
  const geo = new THREE.PlaneGeometry(span, span, 1, 1);
  material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 2.6;
  mesh.name = 'rts-nav-debug-plane';
  mesh.frustumCulled = false;

  root = new THREE.Group();
  root.name = 'rts-nav-debug-overlay';
  root.visible = !!State.gameSession.navDebug;
  root.add(mesh);
  sceneEl.object3D.add(root);

  window.addEventListener('rts-nav-rebuilt', onNavRebuilt);
  paintNavTexture();
}

export function setNavDebugOverlayVisible(visible) {
  if (root) root.visible = visible;
}

let pathLines = null;
let pathDebugMat = null;
let lastPathDebugSig = '';

function pathDebugSignature() {
  const parts = [];
  State.selectedUnits.forEach((id) => {
    const u = State.units.get(id);
    if (!u?.path?.length) return;
    parts.push(
      `${id}:${u.pathIndex}:${u.x.toFixed(1)},${u.z.toFixed(1)}:` +
      u.path.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join('|'),
    );
  });
  return parts.join(';');
}

export function updatePathDebugOverlay() {
  if (!root || !State.gameSession.navDebug) return;
  const THREE = window.THREE;
  if (!THREE) return;

  const sig = pathDebugSignature();
  if (sig === lastPathDebugSig && pathLines) return;
  lastPathDebugSig = sig;

  if (!pathLines) {
    pathLines = new THREE.Group();
    pathLines.name = 'rts-nav-path-debug';
    root.add(pathLines);
  }
  if (!pathDebugMat) {
    pathDebugMat = new THREE.LineBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.95 });
  }

  while (pathLines.children.length > 0) {
    const ch = pathLines.children[0];
    pathLines.remove(ch);
    if (ch.geometry) ch.geometry.dispose();
  }

  State.selectedUnits.forEach((id) => {
    const u = State.units.get(id);
    if (!u?.path?.length) return;
    const pts = [];
    const pushPt = (xx, zz) => {
      const last = pts[pts.length - 1];
      if (last && Math.abs(last.x - xx) < 1e-4 && Math.abs(last.z - zz) < 1e-4) return;
      pts.push(new THREE.Vector3(xx, 4.5, zz));
    };
    pushPt(u.x, u.z);
    let px = u.x;
    let pz = u.z;
    for (let i = u.pathIndex; i < u.path.length; i++) {
      const wp = u.path[i];
      const samples = Pathfinding.sampleWorldSegmentToGridCellCenters(px, pz, wp.x, wp.z);
      for (let j = 0; j < samples.length; j++) {
        pushPt(samples[j].x, samples[j].z);
      }
      px = wp.x;
      pz = wp.z;
    }
    if (pts.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    pathLines.add(new THREE.Line(geo, pathDebugMat));
  });
}

export function syncNavDebugOverlayFromState() {
  setNavDebugOverlayVisible(!!State.gameSession.navDebug);
  if (!State.gameSession.navDebug) lastPathDebugSig = '';
}
