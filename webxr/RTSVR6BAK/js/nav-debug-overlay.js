// ========================================
// RTSVR6 — Nav walkability debug
// Toggle: N key, or `?navDebug=1` / `window.RTS_NAV_DEBUG = true`.
// Classic blue walkable cells on a grid mesh that follows terrain height
// (not a flat Y=const plane, not FoW-style opaque paint).
// ========================================

import * as Pathfinding from './pathfinding.js';
import * as State from './state.js';
import { setNavVisualEnabled } from './fog-visual.js';
import { sampleGameplayEntityY } from './moon-environment.js';

let root = null;
let mesh = null;
let canvas = null;
let texture = null;
let material = null;
let ctx2d = null;

function paintNavTexture() {
  if (!canvas || !ctx2d || !texture) return;
  const spec = Pathfinding.getNavGridSpec();
  if (canvas.width !== spec.cols) canvas.width = spec.cols;
  if (canvas.height !== spec.rows) canvas.height = spec.rows;
  Pathfinding.fillNavWalkabilityToCanvas2D(canvas, ctx2d);
  texture.needsUpdate = true;
}

/** Rebuild / displace nav overlay so it sits just above the ground. */
function rebuildNavMeshGeometry() {
  const THREE = window.THREE;
  if (!THREE || !mesh) return;
  const spec = Pathfinding.getNavGridSpec();
  const cols = spec.cols;
  const rows = spec.rows;
  const span = spec.planeSpanM;
  const half = span * 0.5;
  const cell = spec.cell;

  // One vertex per nav cell corner → segs = cols/rows.
  const old = mesh.geometry;
  const geo = new THREE.PlaneGeometry(span, span, cols, rows);
  // PlaneGeometry is XY; we rotate to XZ. Positions are local before rotation:
  // x ∈ [-half,half], y ∈ [-half,half] → after rotX(-π/2): x stays, z = -y.
  const pos = geo.attributes.position;
  const lift = 0.35;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i);
    const ly = pos.getY(i);
    const wx = lx;
    const wz = -ly;
    let gy = 0;
    try {
      gy = sampleGameplayEntityY(wx, wz);
    } catch (_) {
      gy = 0;
    }
    if (!Number.isFinite(gy)) gy = 0;
    // Keep plane in XY; world Y comes from group/mesh after rotation via baking into Z→Y.
    // After mesh.rotation.x = -π/2: local (x,y,z) → world (x, z, -y) if only rotX…
    // Three: rotX(-90): (x,y,z) → (x, z, -y) wait: R_x: y'=y cos - z sin, z'=y sin + z cos
    // cos(-90)=0, sin(-90)=-1 → y' = z, z' = -y (with z=0): y'=0, z'=-y.
    // So world position = mesh.position + (x, 0, -y) if mesh at origin… then we need height in local Z before rotation:
    // local (x, y, h) → after rotX(-90): (x, h, -y). Yes — put height in Z.
    pos.setZ(i, gy + lift);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  mesh.geometry = geo;
  if (old) old.dispose();

  // Mesh stays at origin; heights are baked into verts.
  mesh.position.set(0, 0, 0);
  mesh.rotation.x = -Math.PI / 2;
  void cell;
  void half;
}

function refreshNavOverlay() {
  paintNavTexture();
  rebuildNavMeshGeometry();
}

function onNavRebuilt() {
  refreshNavOverlay();
}

/**
 * Horizontal translucent plane showing walkable (blue) vs blocked, draped on terrain height.
 */
export function initNavDebugOverlay(sceneEl) {
  if (!sceneEl || !sceneEl.object3D || root) return;
  const THREE = window.THREE;
  if (!THREE) return;

  // Do not use FoW-style terrain paint — displaced mesh is the clear viz.
  setNavVisualEnabled(false);

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
  texture.generateMipmaps = false;

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

  mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.planeSpanM, spec.planeSpanM, 1, 1), material);
  mesh.name = 'rts-nav-debug-plane';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;

  root = new THREE.Group();
  root.name = 'rts-nav-debug-overlay';
  root.visible = !!State.gameSession.navDebug;
  root.add(mesh);
  sceneEl.object3D.add(root);

  window.addEventListener('rts-nav-rebuilt', onNavRebuilt);
  refreshNavOverlay();
}

export function setNavDebugOverlayVisible(visible) {
  setNavVisualEnabled(false);
  if (root) root.visible = !!visible;
  if (visible) refreshNavOverlay();
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
        u.path.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join('|')
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
      let yy = 4.5;
      try {
        yy = sampleGameplayEntityY(xx, zz) + 1.2;
      } catch (_) {
        /* */
      }
      pts.push(new THREE.Vector3(xx, yy, zz));
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
