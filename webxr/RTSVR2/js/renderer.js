// ========================================
// RTSVR2 — Renderer
// InstancedMesh management for all game objects
// ========================================

import {
  UNIT_TYPES, UNIT_SHAPES, BUILDING_TYPES, BUILDING_SHAPES, BUILDING_BASE_COLORS,
  PLAYER_COLORS, MAX_INSTANCES_PER_TYPE, MAX_BUILDING_INSTANCES,
  MAX_PROJECTILES, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT, HEALTH_BAR_Y_OFFSET,
  RESOURCE_FIELD_POSITIONS, BUILD_RADIUS_FROM_HQ, BARRACKS_UNITS,
} from './config.js';
import * as State from './state.js';
import * as Fog from './fog.js';
import * as UI from './ui.js';
import { sampleMoonTerrainWorldY } from './moon-environment.js';

let scene3D = null;  // THREE.Scene reference
const unitMeshes = {};     // unitType -> InstancedMesh
const buildingMeshes = {}; // buildingType -> InstancedMesh

/** Bundled with the game under RTSVR2/ (copied from BattleVR lunar lander). */
const HQ_GLB_URL = 'assets/lunar-lander/lunar_lander.glb';

/** Infantry visual (place file under RTSVR2/assets/). */
const INFANTRY_GLB_URL = 'assets/Meshy_AI_Apollo_astronaut_with_0416105251_texture.glb';

/** Barracks roster = all infantry unit types in this build. */
const INFANTRY_TYPES = BARRACKS_UNITS;
const INFANTRY_TYPES_SET = new Set(INFANTRY_TYPES);

const HARVESTER_GLB_URL = 'assets/Meshy_AI_A_lunar_harvester_of_0417212738_texture.glb';
/** Uniform visual scale vs `UNIT_SHAPES.harvester` box; gameplay footprint unchanged. */
const HARVESTER_GLB_VISUAL_SCALE = 2;
let harvesterGltfActive = false;

const LIGHT_TANK_GLB_URL = 'assets/Meshy_AI_A_lunar_light_tank_r_0417231220_texture.glb';
/** Uniform visual scale vs `UNIT_SHAPES.lightTank` box; gameplay footprint unchanged. */
const LIGHT_TANK_GLB_VISUAL_SCALE = 2;
let lightTankGltfActive = false;

const HEAVY_TANK_GLB_URL = 'assets/Meshy_AI_A_lunar_heavy_tank_r_0417233308_texture.glb';
/** Uniform visual scale vs `UNIT_SHAPES.heavyTank` box; gameplay footprint unchanged. */
const HEAVY_TANK_GLB_VISUAL_SCALE = 2;
let heavyTankGltfActive = false;

const MOBILE_HQ_GLB_URL = 'assets/Meshy_AI_A_lunar_mobile_HQ_wh_0417234643_texture.glb';
/** Uniform visual scale vs `UNIT_SHAPES.mobileHq` box; gameplay footprint unchanged. */
const MOBILE_HQ_GLB_VISUAL_SCALE = 4;
let mobileHqGltfActive = false;

const SCOUT_BIKE_GLB_URL = 'assets/Meshy_AI_A_lunar_rover_realis_0417235006_texture.glb';
/** Uniform visual scale vs `UNIT_SHAPES.scoutBike` box; gameplay footprint unchanged. */
const SCOUT_BIKE_GLB_VISUAL_SCALE = 4;
let scoutBikeGltfActive = false;

const ARTILLERY_GLB_URL = 'assets/Meshy_AI_A_lunar_artillery_tan_0418000218_texture.glb';
/** Uniform visual scale vs `UNIT_SHAPES.artillery` box; gameplay footprint unchanged. */
const ARTILLERY_GLB_VISUAL_SCALE = 3;
let artilleryGltfActive = false;

/** Visual scale vs gameplay HQ footprint (`BUILDING_SHAPES.hq.width`); does not change pathing/build logic. */
const HQ_GLB_VISUAL_SCALE = 4;

const REFINERY_GLB_URL = 'assets/Meshy_AI_A_lunar_temporary_ref_0417211214_texture.glb';
/** Horizontal size vs `max(refinery width, depth)`; gameplay footprint unchanged. */
const REFINERY_GLB_VISUAL_SCALE = 1.5;

const BARRACKS_GLB_URL = 'assets/Meshy_AI_A_lunar_temporary_bar_0417224422_texture.glb';
/** Horizontal size vs `max(barracks width, depth)`; gameplay footprint unchanged. */
const BARRACKS_GLB_VISUAL_SCALE = 2;

const WAR_FACTORY_GLB_URL = 'assets/Meshy_AI_A_lunar_temporary_gar_0417231334_texture.glb';
/** Horizontal size vs `max(warFactory width, depth)`; gameplay footprint unchanged. */
const WAR_FACTORY_GLB_VISUAL_SCALE = 2;

/** After HQ GLB loads: HUD / picking use model bounds instead of BUILDING_SHAPES.hq box. */
let hqModelVisualHeight = null;
let hqModelPickHalfHeight = null;
let hqModelPickRadius = null;

/** Full glTF clone per HQ (textures/materials); `buildingMeshes.hq` stays hidden as fallback. */
let hqTexturedTemplate = null;
const hqTexturedByBuildingId = new Map();
let hqTexturedMode = false;

/** Same pattern as HQ for textured refineries; `buildingMeshes.refinery` hidden when active. */
let refineryTexturedTemplate = null;
const refineryTexturedByBuildingId = new Map();
let refineryTexturedMode = false;
let refineryModelVisualHeight = null;
let refineryModelPickHalfHeight = null;
let refineryModelPickRadius = null;

let barracksTexturedTemplate = null;
const barracksTexturedByBuildingId = new Map();
let barracksTexturedMode = false;
let barracksModelVisualHeight = null;
let barracksModelPickHalfHeight = null;
let barracksModelPickRadius = null;

let warFactoryTexturedTemplate = null;
const warFactoryTexturedByBuildingId = new Map();
let warFactoryTexturedMode = false;
let warFactoryModelVisualHeight = null;
let warFactoryModelPickHalfHeight = null;
let warFactoryModelPickRadius = null;
let healthBarBgMesh = null;
let healthBarFgMesh = null;
let selectionRingMesh = null;
/** Cyan ring on squad leader when a follower is selected (not a command target). */
let squadLeaderRefRingMesh = null;
let resourceFieldMesh = null;
let projectileMesh = null;
let groundMesh = null;
let fogPlaneMesh = null;
let buildRadiusMesh = null;

// Reusable math objects
const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _color = new THREE.Color();
const _euler = new THREE.Euler();
const _zeroScale = new THREE.Vector3(0, 0, 0);

// Projectile pool
const activeProjectiles = [];
let projectileIndex = 0;

export async function initRenderer(sceneEl) {
  scene3D = sceneEl.object3D;

  createUnitMeshes();
  createBuildingMeshes();
  createHealthBarMeshes();
  createSelectionRingMesh();
  createResourceFieldMeshes();
  createProjectileMesh();
  createFogPlane();

  configureBattlefieldShadows(sceneEl);

  console.log('✅ Renderer initialized with InstancedMesh');

  await tryReplaceHqWithGltfModel(sceneEl);
  await tryReplaceRefineryWithGltfModel(sceneEl);
  await tryReplaceBarracksWithGltfModel(sceneEl);
  await tryReplaceWarFactoryWithGltfModel(sceneEl);
  await tryReplaceInfantryWithGltfModel(sceneEl);
  await tryReplaceHarvesterWithGltfModel(sceneEl);
  await tryReplaceLightTankWithGltfModel(sceneEl);
  await tryReplaceHeavyTankWithGltfModel(sceneEl);
  await tryReplaceMobileHqWithGltfModel(sceneEl);
  await tryReplaceScoutBikeWithGltfModel(sceneEl);
  await tryReplaceArtilleryWithGltfModel(sceneEl);
}

/** Upload / compile draw paths so the first visible frame after fade is not still warming shaders. */
export function warmRendererPrograms(sceneEl) {
  const r = sceneEl && sceneEl.renderer;
  const scene = sceneEl && sceneEl.object3D;
  const cam = sceneEl && sceneEl.camera;
  if (!r || !scene || !cam || typeof r.compile !== 'function') return;
  try {
    r.compile(scene, cam);
  } catch (_) {
    /* WebGL / state quirks on some drivers */
  }
}

/**
 * One directional shadow map onto the moon (cheap: moderate map size, single caster).
 * Call after scene lights and game meshes exist.
 */
export function configureBattlefieldShadows(sceneEl) {
  const THREE = window.THREE;
  const renderer = sceneEl && sceneEl.renderer;
  if (!renderer || !THREE) return;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  sceneEl.object3D.traverse((obj) => {
    if (!obj.isDirectionalLight) return;
    obj.castShadow = true;
    obj.shadow.mapSize.set(512, 512);
    obj.shadow.camera.near = 2;
    obj.shadow.camera.far = 220;
    const ext = 115;
    obj.shadow.camera.left = -ext;
    obj.shadow.camera.right = ext;
    obj.shadow.camera.top = ext;
    obj.shadow.camera.bottom = -ext;
    obj.shadow.bias = -0.0006;
    obj.shadow.normalBias = 0.035;
    obj.shadow.camera.updateProjectionMatrix();
  });
}

/** Box combat vehicles: plain box + one barrel cylinder along +Z (same footprint as other box units). */
const TANK_TYPES_WITH_CANNON = new Set(['lightTank', 'heavyTank', 'artillery']);

/** Flatten geometry into non-indexed triangle corner positions (indexed geos must not use raw vertex order). */
function appendTrianglePositions(geo, out) {
  const p = geo.attributes.position;
  const idx = geo.index;
  if (idx) {
    for (let i = 0; i < idx.count; i++) {
      const vi = idx.getX(i);
      out.push(p.getX(vi), p.getY(vi), p.getZ(vi));
    }
  } else {
    for (let i = 0; i < p.count; i++) {
      out.push(p.getX(i), p.getY(i), p.getZ(i));
    }
  }
}

function mergeGeometriesAsNonIndexedTriangles(a, b) {
  const pos = [];
  appendTrianglePositions(a, pos);
  appendTrianglePositions(b, pos);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  return geo;
}

/** Same box as other vehicles; roof barrel along +Z with its rear at hull depth center (z=0). */
function createBoxWithForwardBarrelGeometry(shape) {
  const w = shape.width;
  const h = shape.height;
  const d = shape.depth;

  const hull = new THREE.BoxGeometry(w, h, d);
  hull.translate(0, h * 0.5, 0);

  // From z=0 forward; front at z=d/2. (L - d/2) / L >= 1/3 iff L >= 3d/4; use ~0.86d (~40% past nose).
  const barrelLen = d * 0.86;
  const barrelR = Math.max(0.14, Math.min(w, h) * 0.16);
  const barrel = new THREE.CylinderGeometry(barrelR, barrelR, barrelLen, 10);
  barrel.rotateX(Math.PI / 2);
  barrel.translate(0, h + barrelR, barrelLen * 0.5);

  const merged = mergeGeometriesAsNonIndexedTriangles(hull, barrel);
  hull.dispose();
  barrel.dispose();
  return merged;
}

// --- Unit Meshes ---
function createUnitMeshes() {
  for (const [type, shape] of Object.entries(UNIT_SHAPES)) {
    let geometry;
    if (shape.type === 'cylinder') {
      geometry = new THREE.CylinderGeometry(shape.radiusTop, shape.radiusBottom, shape.height, 8);
      geometry.translate(0, shape.height / 2, 0);
    } else if (TANK_TYPES_WITH_CANNON.has(type)) {
      geometry = createBoxWithForwardBarrelGeometry(shape);
    } else {
      geometry = new THREE.BoxGeometry(shape.width, shape.height, shape.depth);
      geometry.translate(0, shape.height / 2, 0);
    }

    const material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      // We'll use instanceColor for player tinting
    });

    const mesh = new THREE.InstancedMesh(geometry, material, MAX_INSTANCES_PER_TYPE);
    mesh.count = 0;  // Start with 0 visible instances
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_TYPE * 3), 3
    );
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.name = `units_${type}`;

    // Initialize all instances to zero scale (invisible)
    for (let i = 0; i < MAX_INSTANCES_PER_TYPE; i++) {
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
      mesh.setMatrixAt(i, _mat4);
    }
    mesh.instanceMatrix.needsUpdate = true;

    scene3D.add(mesh);
    unitMeshes[type] = mesh;
  }
}

// --- Building Meshes ---
function createBuildingMeshes() {
  for (const [type, shape] of Object.entries(BUILDING_SHAPES)) {
    const geometry = new THREE.BoxGeometry(shape.width, shape.height, shape.depth);
    geometry.translate(0, shape.height / 2, 0);

    const material = new THREE.MeshLambertMaterial({
      color: BUILDING_BASE_COLORS[type] || 0x666666,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, MAX_BUILDING_INSTANCES);
    mesh.count = 0;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_BUILDING_INSTANCES * 3), 3
    );
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.name = `buildings_${type}`;

    for (let i = 0; i < MAX_BUILDING_INSTANCES; i++) {
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
      mesh.setMatrixAt(i, _mat4);
    }
    mesh.instanceMatrix.needsUpdate = true;

    scene3D.add(mesh);
    buildingMeshes[type] = mesh;
  }
}

function buildingHudHeight(buildingType) {
  if (buildingType === 'hq' && hqModelVisualHeight != null) return hqModelVisualHeight;
  if (buildingType === 'refinery' && refineryModelVisualHeight != null) return refineryModelVisualHeight;
  if (buildingType === 'barracks' && barracksModelVisualHeight != null) return barracksModelVisualHeight;
  if (buildingType === 'warFactory' && warFactoryModelVisualHeight != null) return warFactoryModelVisualHeight;
  return BUILDING_SHAPES[buildingType]?.height ?? 3;
}

function buildingPickVerticalAndRadius(buildingType) {
  if (buildingType === 'hq' && hqModelPickHalfHeight != null && hqModelPickRadius != null) {
    return { centerY: hqModelPickHalfHeight, radius: hqModelPickRadius };
  }
  if (
    buildingType === 'refinery'
    && refineryModelPickHalfHeight != null
    && refineryModelPickRadius != null
  ) {
    return { centerY: refineryModelPickHalfHeight, radius: refineryModelPickRadius };
  }
  if (
    buildingType === 'barracks'
    && barracksModelPickHalfHeight != null
    && barracksModelPickRadius != null
  ) {
    return { centerY: barracksModelPickHalfHeight, radius: barracksModelPickRadius };
  }
  if (
    buildingType === 'warFactory'
    && warFactoryModelPickHalfHeight != null
    && warFactoryModelPickRadius != null
  ) {
    return { centerY: warFactoryModelPickHalfHeight, radius: warFactoryModelPickRadius };
  }
  const shape = BUILDING_SHAPES[buildingType];
  if (!shape) return { centerY: 2, radius: 3 };
  return {
    centerY: shape.height * 0.5,
    radius: Math.max(shape.width, shape.depth) * 0.6,
  };
}

/**
 * Read-only: bottom-footprint center (XZ) + uniform scale for target horizontal size.
 * Matches `pivotBottomCenterUniformFootprint` without mutating `geometry`.
 */
function computeBottomFootprintPivotAndScaleFactors(geometry, targetFootprint) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const y0 = box.min.y;
  const ySpan = Math.max(1e-6, box.max.y - y0);
  const pos = geometry.attributes.position;

  let sx = 0;
  let sz = 0;
  let nBottom = 0;
  for (const frac of [0.04, 0.12, 0.35]) {
    const bottomBand = y0 + ySpan * frac;
    sx = 0;
    sz = 0;
    nBottom = 0;
    for (let i = 0; i < pos.count; i++) {
      const py = pos.getY(i);
      if (py <= bottomBand) {
        sx += pos.getX(i);
        sz += pos.getZ(i);
        nBottom++;
      }
    }
    if (nBottom >= 12) break;
  }

  const cx = nBottom > 0 ? sx / nBottom : (box.min.x + box.max.x) * 0.5;
  const cz = nBottom > 0 ? sz / nBottom : (box.min.z + box.max.z) * 0.5;
  const by = y0;
  const tx = -cx;
  const ty = -by;
  const tz = -cz;

  const w = box.max.x - box.min.x;
  const d = box.max.z - box.min.z;
  const horiz = Math.max(w, d);
  const scale = horiz > 1e-6 ? targetFootprint / horiz : 1;

  return { tx, ty, tz, scale };
}

/**
 * Ground at y=0, origin on footprint center (XZ). Uses mean XZ of vertices in the lowest
 * vertical band so asymmetric meshes (e.g. lander) sit over `building.x`/`building.z` like
 * the old box HQ (bottom-face center), not the 3D AABB center which can sit off to one side.
 */
function pivotBottomCenterUniformFootprint(geometry, targetFootprint) {
  const r = computeBottomFootprintPivotAndScaleFactors(geometry, targetFootprint);
  geometry.translate(r.tx, r.ty, r.tz);
  geometry.computeBoundingBox();
  geometry.scale(r.scale, r.scale, r.scale);
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
}

/**
 * Load GLB with A-Frame's gltf-model (same THREE as the scene — avoids a second Three.js bundle).
 * Merge mesh triangles into one non-indexed position-only BufferGeometry so mixed UV/tangent
 * attributes across parts cannot break BufferGeometryUtils.mergeGeometries().
 */
function mergeWorldMeshesToPositionsGeometry(root, THREE_w) {
  const positions = [];
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!child.isMesh && !child.isSkinnedMesh) return;
    if (!child.geometry || !child.geometry.attributes.position) return;
    const g = child.geometry.clone();
    g.applyMatrix4(child.matrixWorld);
    appendTrianglePositions(g, positions);
    g.dispose();
  });
  if (positions.length < 9) {
    throw new Error('HQ GLB: no triangle mesh data extracted');
  }
  const merged = new THREE_w.BufferGeometry();
  merged.setAttribute('position', new THREE_w.Float32BufferAttribute(new Float32Array(positions), 3));
  merged.computeVertexNormals();
  return merged;
}

function loadHqGltfRootCloneViaAframe(sceneEl, glbUrl) {
  return new Promise((resolve, reject) => {
    const holder = document.createElement('a-entity');
    holder.setAttribute('position', '0 0 0');
    holder.setAttribute('visible', 'false');
    holder.setAttribute('gltf-model', `url(${glbUrl})`);

    const fail = (err) => {
      holder.removeEventListener('model-error', onErr);
      holder.removeEventListener('model-loaded', onOk);
      if (holder.parentNode) holder.parentNode.removeChild(holder);
      reject(err instanceof Error ? err : new Error(String(err && (err.message || err))));
    };

    const onErr = (e) => {
      const d = e && e.detail;
      fail(d && (d.message || d.srcError) ? new Error(String(d.message || d.srcError)) : new Error('gltf-model load error'));
    };

    const onOk = (e) => {
      try {
        const model = e.detail && e.detail.model;
        if (!model) throw new Error('model-loaded missing detail.model');
        const clone = model.clone(true);
        holder.removeEventListener('model-error', onErr);
        holder.removeEventListener('model-loaded', onOk);
        if (holder.parentNode) holder.parentNode.removeChild(holder);
        resolve(clone);
      } catch (err) {
        fail(err);
      }
    };

    holder.addEventListener('model-error', onErr, { once: true });
    holder.addEventListener('model-loaded', onOk, { once: true });
    sceneEl.appendChild(holder);
  });
}

function disposeHqTexturedObject3D(root, THREE_w) {
  if (!root || !THREE_w) return;
  root.traverse((node) => {
    if (node.isMesh || node.isSkinnedMesh) {
      if (node.geometry) node.geometry.dispose();
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      mats.forEach((m) => {
        if (!m) return;
        const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
        maps.forEach((k) => {
          const t = m[k];
          if (t && t.dispose) t.dispose();
        });
        m.dispose();
      });
    }
  });
}

function applyHqPlayerTintToObject3D(root, ownerId, THREE_w) {
  const tint = new THREE_w.Color(PLAYER_COLORS[ownerId] || 0xffffff);
  tint.lerp(new THREE_w.Color(1, 1, 1), 0.55);
  root.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    mats.forEach((m) => {
      if (!m || !m.color) return;
      if (!m.userData._hqTintBase) {
        m.userData._hqTintBase = m.color.clone();
      }
      m.color.copy(m.userData._hqTintBase).multiply(tint);
    });
  });
}

function syncHqTexturedOne(building, worldMat4, drawVisible, THREE_w) {
  let root = hqTexturedByBuildingId.get(building.id);
  if (!root) {
    root = hqTexturedTemplate.clone(true);
    root.name = `hq_lander_${building.id}`;
    applyHqPlayerTintToObject3D(root, building.ownerId, THREE_w);
    scene3D.add(root);
    hqTexturedByBuildingId.set(building.id, root);
  }
  root.matrixAutoUpdate = false;
  root.matrix.copy(worldMat4);
  root.matrixWorldNeedsUpdate = true;
  root.visible = drawVisible;
}

function syncRefineryTexturedOne(building, worldMat4, drawVisible, THREE_w) {
  let root = refineryTexturedByBuildingId.get(building.id);
  if (!root) {
    root = refineryTexturedTemplate.clone(true);
    root.name = `refinery_gltf_${building.id}`;
    applyHqPlayerTintToObject3D(root, building.ownerId, THREE_w);
    scene3D.add(root);
    refineryTexturedByBuildingId.set(building.id, root);
  }
  root.matrixAutoUpdate = false;
  root.matrix.copy(worldMat4);
  root.matrixWorldNeedsUpdate = true;
  root.visible = drawVisible;
}

function syncBarracksTexturedOne(building, worldMat4, drawVisible, THREE_w) {
  let root = barracksTexturedByBuildingId.get(building.id);
  if (!root) {
    root = barracksTexturedTemplate.clone(true);
    root.name = `barracks_gltf_${building.id}`;
    applyHqPlayerTintToObject3D(root, building.ownerId, THREE_w);
    scene3D.add(root);
    barracksTexturedByBuildingId.set(building.id, root);
  }
  root.matrixAutoUpdate = false;
  root.matrix.copy(worldMat4);
  root.matrixWorldNeedsUpdate = true;
  root.visible = drawVisible;
}

function syncWarFactoryTexturedOne(building, worldMat4, drawVisible, THREE_w) {
  let root = warFactoryTexturedByBuildingId.get(building.id);
  if (!root) {
    root = warFactoryTexturedTemplate.clone(true);
    root.name = `war_factory_gltf_${building.id}`;
    applyHqPlayerTintToObject3D(root, building.ownerId, THREE_w);
    scene3D.add(root);
    warFactoryTexturedByBuildingId.set(building.id, root);
  }
  root.matrixAutoUpdate = false;
  root.matrix.copy(worldMat4);
  root.matrixWorldNeedsUpdate = true;
  root.visible = drawVisible;
}

async function tryReplaceHqWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !buildingMeshes.hq || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, HQ_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] HQ lunar lander GLB load failed (keeping box).', err);
    return;
  }

  const mergedMeasure = mergeWorldMeshesToPositionsGeometry(loadedRoot.clone(true), THREE_w);
  const p = computeBottomFootprintPivotAndScaleFactors(
    mergedMeasure,
    BUILDING_SHAPES.hq.width * HQ_GLB_VISUAL_SCALE
  );
  mergedMeasure.dispose();

  const inner = loadedRoot.clone(true);
  inner.position.set(p.tx * p.scale, p.ty * p.scale, p.tz * p.scale);
  inner.scale.setScalar(p.scale);
  inner.traverse((node) => {
    if (node.isMesh || node.isSkinnedMesh) {
      node.castShadow = true;
      node.receiveShadow = false;
    }
  });

  disposeHqTexturedObject3D(loadedRoot, THREE_w);

  const wrap = new THREE_w.Group();
  wrap.name = 'hq_lander_template';
  wrap.add(inner);
  wrap.updateMatrixWorld(true);
  const bb = new THREE_w.Box3().setFromObject(wrap);
  hqModelVisualHeight = bb.max.y - bb.min.y;
  hqModelPickHalfHeight = Math.abs(bb.min.y) < 0.08 ? bb.max.y * 0.5 : (bb.max.y + bb.min.y) * 0.5;
  hqModelPickRadius = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.6;

  hqTexturedTemplate = wrap;
  hqTexturedMode = true;
  buildingMeshes.hq.visible = false;

  configureBattlefieldShadows(sceneEl);
}

async function tryReplaceRefineryWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !buildingMeshes.refinery || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, REFINERY_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] Refinery GLB load failed (keeping box).', err);
    return;
  }

  const refShape = BUILDING_SHAPES.refinery;
  const targetFootprint = Math.max(refShape.width, refShape.depth) * REFINERY_GLB_VISUAL_SCALE;

  const mergedMeasure = mergeWorldMeshesToPositionsGeometry(loadedRoot.clone(true), THREE_w);
  const p = computeBottomFootprintPivotAndScaleFactors(mergedMeasure, targetFootprint);
  mergedMeasure.dispose();

  const inner = loadedRoot.clone(true);
  inner.position.set(p.tx * p.scale, p.ty * p.scale, p.tz * p.scale);
  inner.scale.setScalar(p.scale);
  inner.traverse((node) => {
    if (node.isMesh || node.isSkinnedMesh) {
      node.castShadow = true;
      node.receiveShadow = false;
    }
  });

  disposeHqTexturedObject3D(loadedRoot, THREE_w);

  const wrap = new THREE_w.Group();
  wrap.name = 'refinery_gltf_template';
  wrap.add(inner);
  wrap.updateMatrixWorld(true);
  const bb = new THREE_w.Box3().setFromObject(wrap);
  refineryModelVisualHeight = bb.max.y - bb.min.y;
  refineryModelPickHalfHeight = Math.abs(bb.min.y) < 0.08 ? bb.max.y * 0.5 : (bb.max.y + bb.min.y) * 0.5;
  refineryModelPickRadius = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.6;

  refineryTexturedTemplate = wrap;
  refineryTexturedMode = true;
  buildingMeshes.refinery.visible = false;

  configureBattlefieldShadows(sceneEl);
}

async function tryReplaceBarracksWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !buildingMeshes.barracks || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, BARRACKS_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] Barracks GLB load failed (keeping box).', err);
    return;
  }

  const barShape = BUILDING_SHAPES.barracks;
  const targetFootprint = Math.max(barShape.width, barShape.depth) * BARRACKS_GLB_VISUAL_SCALE;

  const mergedMeasure = mergeWorldMeshesToPositionsGeometry(loadedRoot.clone(true), THREE_w);
  const p = computeBottomFootprintPivotAndScaleFactors(mergedMeasure, targetFootprint);
  mergedMeasure.dispose();

  const inner = loadedRoot.clone(true);
  inner.position.set(p.tx * p.scale, p.ty * p.scale, p.tz * p.scale);
  inner.scale.setScalar(p.scale);
  inner.traverse((node) => {
    if (node.isMesh || node.isSkinnedMesh) {
      node.castShadow = true;
      node.receiveShadow = false;
    }
  });

  disposeHqTexturedObject3D(loadedRoot, THREE_w);

  const wrap = new THREE_w.Group();
  wrap.name = 'barracks_gltf_template';
  wrap.add(inner);
  wrap.updateMatrixWorld(true);
  const bb = new THREE_w.Box3().setFromObject(wrap);
  barracksModelVisualHeight = bb.max.y - bb.min.y;
  barracksModelPickHalfHeight = Math.abs(bb.min.y) < 0.08 ? bb.max.y * 0.5 : (bb.max.y + bb.min.y) * 0.5;
  barracksModelPickRadius = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.6;

  barracksTexturedTemplate = wrap;
  barracksTexturedMode = true;
  buildingMeshes.barracks.visible = false;

  configureBattlefieldShadows(sceneEl);
}

async function tryReplaceWarFactoryWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !buildingMeshes.warFactory || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, WAR_FACTORY_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] War factory GLB load failed (keeping box).', err);
    return;
  }

  const wfShape = BUILDING_SHAPES.warFactory;
  const targetFootprint = Math.max(wfShape.width, wfShape.depth) * WAR_FACTORY_GLB_VISUAL_SCALE;

  const mergedMeasure = mergeWorldMeshesToPositionsGeometry(loadedRoot.clone(true), THREE_w);
  const p = computeBottomFootprintPivotAndScaleFactors(mergedMeasure, targetFootprint);
  mergedMeasure.dispose();

  const inner = loadedRoot.clone(true);
  inner.position.set(p.tx * p.scale, p.ty * p.scale, p.tz * p.scale);
  inner.scale.setScalar(p.scale);
  inner.traverse((node) => {
    if (node.isMesh || node.isSkinnedMesh) {
      node.castShadow = true;
      node.receiveShadow = false;
    }
  });

  disposeHqTexturedObject3D(loadedRoot, THREE_w);

  const wrap = new THREE_w.Group();
  wrap.name = 'war_factory_gltf_template';
  wrap.add(inner);
  wrap.updateMatrixWorld(true);
  const bb = new THREE_w.Box3().setFromObject(wrap);
  warFactoryModelVisualHeight = bb.max.y - bb.min.y;
  warFactoryModelPickHalfHeight = Math.abs(bb.min.y) < 0.08 ? bb.max.y * 0.5 : (bb.max.y + bb.min.y) * 0.5;
  warFactoryModelPickRadius = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.6;

  warFactoryTexturedTemplate = wrap;
  warFactoryTexturedMode = true;
  buildingMeshes.warFactory.visible = false;

  configureBattlefieldShadows(sceneEl);
}

function disposeObject3DGeometryOnly(root) {
  if (!root) return;
  root.traverse((node) => {
    if ((node.isMesh || node.isSkinnedMesh) && node.geometry) {
      node.geometry.dispose();
    }
  });
}

/** Largest triangle mesh in the glTF (by index or position count) for a textured instanced body. */
function findDominantDrawMesh(root) {
  root.updateMatrixWorld(true);
  let best = null;
  let bestCount = -1;
  root.traverse((child) => {
    if (!child.isMesh && !child.isSkinnedMesh) return;
    const g = child.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;
    const idx = g.index;
    const n = idx ? idx.count : g.attributes.position.count;
    if (n > bestCount) {
      best = child;
      bestCount = n;
    }
  });
  return best;
}

function infantryCylinderFootprint(shape) {
  if (!shape || shape.type !== 'cylinder') return 0.8;
  return 2 * Math.max(shape.radiusTop, shape.radiusBottom);
}

/**
 * Clone dominant mesh geometry into world space, pivot to ground + uniform footprint scale,
 * then stretch Y to match gameplay cylinder height (XZ footprint unchanged).
 */
function bakeInfantryGeometryFromGltfRoot(gltfRoot, shape) {
  const dominant = findDominantDrawMesh(gltfRoot);
  if (!dominant) throw new Error('Infantry GLB: no drawable mesh');

  const geo = dominant.geometry.clone();
  geo.applyMatrix4(dominant.matrixWorld);

  const footprint = infantryCylinderFootprint(shape);
  pivotBottomCenterUniformFootprint(geo, footprint);

  geo.computeBoundingBox();
  const ySpan = Math.max(1e-6, geo.boundingBox.max.y - geo.boundingBox.min.y);
  const targetH = shape.height;
  if (Math.abs(ySpan - targetH) > 1e-4) {
    geo.scale(1, targetH / ySpan, 1);
    geo.computeBoundingBox();
    const y0 = geo.boundingBox.min.y;
    if (Math.abs(y0) > 1e-5) geo.translate(0, -y0, 0);
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.computeVertexNormals();

  const srcMat = Array.isArray(dominant.material) ? dominant.material[0] : dominant.material;
  if (!srcMat) throw new Error('Infantry GLB: mesh has no material');
  const material = srcMat.clone();
  material.fog = true;
  if (material.color) material.color.setRGB(1, 1, 1);

  return { geometry: geo, material };
}

/**
 * Box-shaped unit (e.g. harvester): optional Y rotation, bottom-center pivot, then **uniform** scale
 * so the mesh fits inside `width × height × depth` without stretching (aspect preserved).
 * @param {{ yawY?: number }} [opts] — `yawY`: radians around +Y; −π/2 = 90° clockwise from above, +π/2 = counter-clockwise.
 */
function bakeBoxUnitGeometryFromGltfRoot(gltfRoot, shape, opts = {}) {
  const dominant = findDominantDrawMesh(gltfRoot);
  if (!dominant) throw new Error('Box unit GLB: no drawable mesh');

  const geo = dominant.geometry.clone();
  geo.applyMatrix4(dominant.matrixWorld);

  const yawY = opts.yawY ?? 0;
  if (Math.abs(yawY) > 1e-8) geo.rotateY(yawY);

  const r = computeBottomFootprintPivotAndScaleFactors(geo, 1);
  geo.translate(r.tx, r.ty, r.tz);

  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const dx = Math.max(1e-6, b.max.x - b.min.x);
  const dy = Math.max(1e-6, b.max.y - b.min.y);
  const dz = Math.max(1e-6, b.max.z - b.min.z);
  const sx = shape.width / dx;
  const sy = shape.height / dy;
  const sz = shape.depth / dz;
  const u = Math.min(sx, sy, sz);
  geo.scale(u, u, u);

  geo.computeBoundingBox();
  const y0 = geo.boundingBox.min.y;
  if (Math.abs(y0) > 1e-5) geo.translate(0, -y0, 0);

  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.computeVertexNormals();

  const srcMat = Array.isArray(dominant.material) ? dominant.material[0] : dominant.material;
  if (!srcMat) throw new Error('Box unit GLB: mesh has no material');
  const material = srcMat.clone();
  material.fog = true;
  if (material.color) material.color.setRGB(1, 1, 1);

  return { geometry: geo, material };
}

function replaceUnitInstancedMesh(unitType, geometry, material, THREE_w) {
  const existing = unitMeshes[unitType];
  if (!existing || !scene3D) return;

  scene3D.remove(existing);
  existing.dispose();

  const mesh = new THREE_w.InstancedMesh(geometry, material, MAX_INSTANCES_PER_TYPE);
  mesh.count = 0;
  mesh.instanceColor = new THREE_w.InstancedBufferAttribute(
    new Float32Array(MAX_INSTANCES_PER_TYPE * 3), 3
  );
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.name = `units_${unitType}`;

  for (let i = 0; i < MAX_INSTANCES_PER_TYPE; i++) {
    _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    mesh.setMatrixAt(i, _mat4);
  }
  mesh.instanceMatrix.needsUpdate = true;

  scene3D.add(mesh);
  unitMeshes[unitType] = mesh;
}

async function tryReplaceInfantryWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, INFANTRY_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] Infantry GLB load failed (keeping cylinders).', err);
    return;
  }

  try {
    for (const type of INFANTRY_TYPES) {
      const shape = UNIT_SHAPES[type];
      if (!shape || shape.type !== 'cylinder') continue;

      const perTypeRoot = loadedRoot.clone(true);
      const { geometry, material } = bakeInfantryGeometryFromGltfRoot(perTypeRoot, shape);
      disposeObject3DGeometryOnly(perTypeRoot);
      replaceUnitInstancedMesh(type, geometry, material, THREE_w);
    }
  } catch (err) {
    console.warn('[RTSVR2] Infantry GLB apply failed (keeping cylinders).', err);
  }

  disposeObject3DGeometryOnly(loadedRoot);

  configureBattlefieldShadows(sceneEl);
}

async function tryReplaceHarvesterWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !unitMeshes.harvester || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, HARVESTER_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] Harvester GLB load failed (keeping box).', err);
    return;
  }

  try {
    const shape = UNIT_SHAPES.harvester;
    if (!shape || shape.type !== 'box') throw new Error('harvester shape must be box');

    const v = HARVESTER_GLB_VISUAL_SCALE;
    const visualShape = {
      type: 'box',
      width: shape.width * v,
      height: shape.height * v,
      depth: shape.depth * v,
    };

    const perTypeRoot = loadedRoot.clone(true);
    /** 90° clockwise when viewed from above (+Y): right-hand +Y is CCW, so use −π/2. */
    const { geometry, material } = bakeBoxUnitGeometryFromGltfRoot(perTypeRoot, visualShape, {
      yawY: -Math.PI / 2,
    });
    disposeObject3DGeometryOnly(perTypeRoot);
    replaceUnitInstancedMesh('harvester', geometry, material, THREE_w);
    harvesterGltfActive = true;
  } catch (err) {
    console.warn('[RTSVR2] Harvester GLB apply failed (keeping box).', err);
    harvesterGltfActive = false;
  }

  disposeObject3DGeometryOnly(loadedRoot);

  configureBattlefieldShadows(sceneEl);
}

async function tryReplaceLightTankWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !unitMeshes.lightTank || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, LIGHT_TANK_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] Light tank GLB load failed (keeping hull+barrel mesh).', err);
    return;
  }

  try {
    const shape = UNIT_SHAPES.lightTank;
    if (!shape || shape.type !== 'box') throw new Error('lightTank shape must be box');

    const v = LIGHT_TANK_GLB_VISUAL_SCALE;
    const visualShape = {
      type: 'box',
      width: shape.width * v,
      height: shape.height * v,
      depth: shape.depth * v,
    };

    const perTypeRoot = loadedRoot.clone(true);
    /** 90° counter-clockwise when viewed from above (+Y): +π/2 around +Y. */
    const { geometry, material } = bakeBoxUnitGeometryFromGltfRoot(perTypeRoot, visualShape, {
      yawY: Math.PI / 2,
    });
    disposeObject3DGeometryOnly(perTypeRoot);
    replaceUnitInstancedMesh('lightTank', geometry, material, THREE_w);
    lightTankGltfActive = true;
  } catch (err) {
    console.warn('[RTSVR2] Light tank GLB apply failed (keeping hull+barrel mesh).', err);
    lightTankGltfActive = false;
  }

  disposeObject3DGeometryOnly(loadedRoot);

  configureBattlefieldShadows(sceneEl);
}

async function tryReplaceHeavyTankWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !unitMeshes.heavyTank || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, HEAVY_TANK_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] Heavy tank GLB load failed (keeping hull+barrel mesh).', err);
    return;
  }

  try {
    const shape = UNIT_SHAPES.heavyTank;
    if (!shape || shape.type !== 'box') throw new Error('heavyTank shape must be box');

    const v = HEAVY_TANK_GLB_VISUAL_SCALE;
    const visualShape = {
      type: 'box',
      width: shape.width * v,
      height: shape.height * v,
      depth: shape.depth * v,
    };

    const perTypeRoot = loadedRoot.clone(true);
    const { geometry, material } = bakeBoxUnitGeometryFromGltfRoot(perTypeRoot, visualShape, {
      yawY: Math.PI / 2,
    });
    disposeObject3DGeometryOnly(perTypeRoot);
    replaceUnitInstancedMesh('heavyTank', geometry, material, THREE_w);
    heavyTankGltfActive = true;
  } catch (err) {
    console.warn('[RTSVR2] Heavy tank GLB apply failed (keeping hull+barrel mesh).', err);
    heavyTankGltfActive = false;
  }

  disposeObject3DGeometryOnly(loadedRoot);

  configureBattlefieldShadows(sceneEl);
}

async function tryReplaceMobileHqWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !unitMeshes.mobileHq || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, MOBILE_HQ_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] Mobile HQ GLB load failed (keeping box).', err);
    return;
  }

  try {
    const shape = UNIT_SHAPES.mobileHq;
    if (!shape || shape.type !== 'box') throw new Error('mobileHq shape must be box');

    const v = MOBILE_HQ_GLB_VISUAL_SCALE;
    const visualShape = {
      type: 'box',
      width: shape.width * v,
      height: shape.height * v,
      depth: shape.depth * v,
    };

    const perTypeRoot = loadedRoot.clone(true);
    const { geometry, material } = bakeBoxUnitGeometryFromGltfRoot(perTypeRoot, visualShape, {
      yawY: Math.PI / 2,
    });
    disposeObject3DGeometryOnly(perTypeRoot);
    replaceUnitInstancedMesh('mobileHq', geometry, material, THREE_w);
    mobileHqGltfActive = true;
  } catch (err) {
    console.warn('[RTSVR2] Mobile HQ GLB apply failed (keeping box).', err);
    mobileHqGltfActive = false;
  }

  disposeObject3DGeometryOnly(loadedRoot);

  configureBattlefieldShadows(sceneEl);
}

async function tryReplaceScoutBikeWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !unitMeshes.scoutBike || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, SCOUT_BIKE_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] Scout buggy GLB load failed (keeping box).', err);
    return;
  }

  try {
    const shape = UNIT_SHAPES.scoutBike;
    if (!shape || shape.type !== 'box') throw new Error('scoutBike shape must be box');

    const v = SCOUT_BIKE_GLB_VISUAL_SCALE;
    const visualShape = {
      type: 'box',
      width: shape.width * v,
      height: shape.height * v,
      depth: shape.depth * v,
    };

    const perTypeRoot = loadedRoot.clone(true);
    const { geometry, material } = bakeBoxUnitGeometryFromGltfRoot(perTypeRoot, visualShape, {
      yawY: Math.PI / 2,
    });
    disposeObject3DGeometryOnly(perTypeRoot);
    replaceUnitInstancedMesh('scoutBike', geometry, material, THREE_w);
    scoutBikeGltfActive = true;
  } catch (err) {
    console.warn('[RTSVR2] Scout buggy GLB apply failed (keeping box).', err);
    scoutBikeGltfActive = false;
  }

  disposeObject3DGeometryOnly(loadedRoot);

  configureBattlefieldShadows(sceneEl);
}

async function tryReplaceArtilleryWithGltfModel(sceneEl) {
  const THREE_w = window.THREE;
  if (!THREE_w || !scene3D || !unitMeshes.artillery || !sceneEl) return;

  let loadedRoot;
  try {
    loadedRoot = await loadHqGltfRootCloneViaAframe(sceneEl, ARTILLERY_GLB_URL);
  } catch (err) {
    console.warn('[RTSVR2] Artillery GLB load failed (keeping hull+barrel mesh).', err);
    return;
  }

  try {
    const shape = UNIT_SHAPES.artillery;
    if (!shape || shape.type !== 'box') throw new Error('artillery shape must be box');

    const v = ARTILLERY_GLB_VISUAL_SCALE;
    const visualShape = {
      type: 'box',
      width: shape.width * v,
      height: shape.height * v,
      depth: shape.depth * v,
    };

    const perTypeRoot = loadedRoot.clone(true);
    const { geometry, material } = bakeBoxUnitGeometryFromGltfRoot(perTypeRoot, visualShape, {
      yawY: Math.PI / 2,
    });
    disposeObject3DGeometryOnly(perTypeRoot);
    replaceUnitInstancedMesh('artillery', geometry, material, THREE_w);
    artilleryGltfActive = true;
  } catch (err) {
    console.warn('[RTSVR2] Artillery GLB apply failed (keeping hull+barrel mesh).', err);
    artilleryGltfActive = false;
  }

  disposeObject3DGeometryOnly(loadedRoot);

  configureBattlefieldShadows(sceneEl);
}

// --- Health Bars ---
function createHealthBarMeshes() {
  const maxBars = MAX_INSTANCES_PER_TYPE * Object.keys(UNIT_TYPES).length + MAX_BUILDING_INSTANCES * 4;
  const barGeom = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);

  // Background (red)
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x880000, side: THREE.DoubleSide, depthTest: false });
  healthBarBgMesh = new THREE.InstancedMesh(barGeom, bgMat, maxBars);
  healthBarBgMesh.count = 0;
  healthBarBgMesh.frustumCulled = false;
  healthBarBgMesh.renderOrder = 999;

  // Foreground (green)
  const fgMat = new THREE.MeshBasicMaterial({ color: 0x00cc00, side: THREE.DoubleSide, depthTest: false });
  healthBarFgMesh = new THREE.InstancedMesh(barGeom, fgMat, maxBars);
  healthBarFgMesh.count = 0;
  healthBarFgMesh.frustumCulled = false;
  healthBarFgMesh.renderOrder = 1000;

  for (let i = 0; i < maxBars; i++) {
    _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    healthBarBgMesh.setMatrixAt(i, _mat4);
    healthBarFgMesh.setMatrixAt(i, _mat4);
  }
  healthBarBgMesh.instanceMatrix.needsUpdate = true;
  healthBarFgMesh.instanceMatrix.needsUpdate = true;

  scene3D.add(healthBarBgMesh);
  scene3D.add(healthBarFgMesh);
}

// --- Selection Rings ---
function createSelectionRingMesh() {
  const geometry = new THREE.TorusGeometry(1.0, 0.05, 8, 24);
  geometry.rotateX(Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.8 });
  selectionRingMesh = new THREE.InstancedMesh(geometry, material, 60);
  selectionRingMesh.count = 0;
  selectionRingMesh.frustumCulled = false;
  selectionRingMesh.renderOrder = 998;

  for (let i = 0; i < 60; i++) {
    _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    selectionRingMesh.setMatrixAt(i, _mat4);
  }
  selectionRingMesh.instanceMatrix.needsUpdate = true;
  scene3D.add(selectionRingMesh);

  const refGeometry = geometry.clone();
  const refMat = new THREE.MeshBasicMaterial({ color: 0x44ccff, transparent: true, opacity: 0.88 });
  squadLeaderRefRingMesh = new THREE.InstancedMesh(refGeometry, refMat, 32);
  squadLeaderRefRingMesh.count = 0;
  squadLeaderRefRingMesh.frustumCulled = false;
  squadLeaderRefRingMesh.renderOrder = 997;
  for (let i = 0; i < 32; i++) {
    _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    squadLeaderRefRingMesh.setMatrixAt(i, _mat4);
  }
  squadLeaderRefRingMesh.instanceMatrix.needsUpdate = true;
  scene3D.add(squadLeaderRefRingMesh);

  // --- Build Radius Ring ---
  const brGeometry = new THREE.TorusGeometry(BUILD_RADIUS_FROM_HQ, 0.4, 8, 128);
  brGeometry.rotateX(Math.PI / 2);
  const brMat = new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.15 });
  buildRadiusMesh = new THREE.Mesh(brGeometry, brMat);
  buildRadiusMesh.visible = false;
  scene3D.add(buildRadiusMesh);
}

// --- Resource Fields ---
function createResourceFieldMeshes() {
  // Crystal-like shape for resource fields
  const geometry = new THREE.OctahedronGeometry(2.5, 0);
  const material = new THREE.MeshLambertMaterial({
    color: 0x44ff88,
    emissive: 0x22aa44,
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: 0.85,
  });

  resourceFieldMesh = new THREE.InstancedMesh(geometry, material, RESOURCE_FIELD_POSITIONS.length);
  resourceFieldMesh.count = RESOURCE_FIELD_POSITIONS.length;
  resourceFieldMesh.frustumCulled = false;

  RESOURCE_FIELD_POSITIONS.forEach((pos, i) => {
    const gY = sampleMoonTerrainWorldY(pos.x, pos.z);
    _mat4.compose(
      _pos.set(pos.x, gY + 2.5, pos.z),
      _quat.identity(),
      _scale.set(1, 1, 1)
    );
    resourceFieldMesh.setMatrixAt(i, _mat4);
  });
  resourceFieldMesh.instanceMatrix.needsUpdate = true;
  resourceFieldMesh.castShadow = true;
  resourceFieldMesh.receiveShadow = false;
  scene3D.add(resourceFieldMesh);
}

// --- Projectile pool ---
function createProjectileMesh() {
  const geometry = new THREE.SphereGeometry(0.2, 6, 4);
  const material = new THREE.MeshBasicMaterial({ color: 0xffff00 });

  projectileMesh = new THREE.InstancedMesh(geometry, material, MAX_PROJECTILES);
  projectileMesh.count = MAX_PROJECTILES;
  projectileMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_PROJECTILES * 3), 3
  );
  projectileMesh.frustumCulled = false;

  for (let i = 0; i < MAX_PROJECTILES; i++) {
    _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    projectileMesh.setMatrixAt(i, _mat4);
    _color.set(0xffff00);
    projectileMesh.setColorAt(i, _color);
  }
  projectileMesh.instanceMatrix.needsUpdate = true;
  projectileMesh.instanceColor.needsUpdate = true;
  scene3D.add(projectileMesh);
}

// --- Fog plane (darkens unexplored areas) ---
function createFogPlane() {
  // Simple dark plane over the map, with holes cut by visibility
  // For now, we'll handle fog via unit visibility toggling
}

// ==========================================
// UPDATE FUNCTIONS (called each frame)
// ==========================================

export function updateRendering() {
  updateUnitInstances();
  updateBuildingInstances();
  updateHealthBars();
  updateSelectionRings();
  updateResourceFields();
  updateProjectiles();
  updateBuildBoundary();
}

/** Higher = should win a limited InstancedMesh slot (same-type overflow used to hide harvesters first). */
function unitInstanceSortKey(unit, myPid) {
  let k = 0;
  if (State.selectedUnits.has(unit.id)) k += 4000;
  if (unit.ownerId === myPid) k += 1000;
  if (Fog.isUnitVisibleToPlayer(unit, myPid)) k += 100;
  return k;
}

function updateUnitInstances() {
  const counts = {};
  for (const type of Object.keys(unitMeshes)) {
    counts[type] = 0;
  }

  const myPid = State.gameSession.myPlayerId;
  /** Living followers (my units) per leader id — for squad leader tint when unselected. */
  const myFollowerCountByLeaderId = new Map();
  State.units.forEach(u => {
    if (u.hp <= 0 || u.ownerId !== myPid || !u.followLeadId) return;
    const lead = State.units.get(u.followLeadId);
    if (!lead || lead.hp <= 0 || lead.ownerId !== myPid) return;
    const lid = u.followLeadId;
    myFollowerCountByLeaderId.set(lid, (myFollowerCountByLeaderId.get(lid) || 0) + 1);
  });

  const byType = {};
  for (const type of Object.keys(unitMeshes)) {
    byType[type] = [];
  }

  State.units.forEach(unit => {
    if (unit.hp <= 0) return;
    if (!unitMeshes[unit.type]) return;
    byType[unit.type].push(unit);
  });

  for (const type of Object.keys(unitMeshes)) {
    const mesh = unitMeshes[type];
    const list = byType[type];
    list.sort((a, b) => unitInstanceSortKey(b, myPid) - unitInstanceSortKey(a, myPid));

    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
      if (i >= MAX_INSTANCES_PER_TYPE) {
        unit._renderIndex = -1;
        unit._renderVisible = false;
        continue;
      }

      const fogVis = Fog.isUnitVisibleToPlayer(unit, myPid);
      const visible =
        fogVis
        || (State.selectedUnits.has(unit.id) && unit.ownerId === myPid);

      if (visible) {
        _euler.set(0, unit.rotation || 0, 0);
        _quat.setFromEuler(_euler);
        const gY = sampleMoonTerrainWorldY(unit.x, unit.z);
        _mat4.compose(
          _pos.set(unit.x, gY, unit.z),
          _quat,
          _scale.set(1, 1, 1)
        );
      } else {
        _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
      }

      mesh.setMatrixAt(i, _mat4);

      if (unit.type === 'harvester') {
        const baseColor = PLAYER_COLORS[unit.ownerId] || 0xffffff;
        switch (unit.state) {
          case 'harvesting': {
            const pulse = 0.6 + Math.sin(performance.now() * 0.005) * 0.4;
            _color.setRGB(pulse * 0.2, pulse, pulse * 0.3);
            break;
          }
          case 'movingToRefinery': {
            _color.setRGB(1.0, 0.85, 0.2);
            break;
          }
          case 'depositing': {
            const pulse2 = 0.7 + Math.sin(performance.now() * 0.008) * 0.3;
            _color.setRGB(1.0, 0.5 * pulse2, 0.1);
            break;
          }
          case 'movingToField': {
            _color.setRGB(0.3, 0.7, 0.7);
            break;
          }
          default:
            _color.setHex(baseColor);
        }
      } else if (unit.type === 'mobileHq') {
        const baseColor = PLAYER_COLORS[unit.ownerId] || 0xffffff;
        _color.setHex(baseColor);
        _color.lerp(new THREE.Color(0xffcc66), 0.35);
      } else {
        const baseColor = PLAYER_COLORS[unit.ownerId] || 0xffffff;
        _color.setHex(baseColor);

        switch (unit.state) {
          case 'attacking': {
            const rPulse = 0.5 + Math.sin(performance.now() * 0.008) * 0.5;
            _color.lerp(new THREE.Color(0xff2222), rPulse * 0.5);
            break;
          }
          case 'moving':
            _color.lerp(new THREE.Color(0x4488ff), 0.3);
            break;
          case 'following':
            _color.lerp(new THREE.Color(0x44ff44), 0.4);
            break;
          default:
            break;
        }
        if (unit.ownerId === myPid) {
          if (unit.followLeadId) {
            _color.lerp(new THREE.Color(0x3aa899), 0.38);
          } else if ((myFollowerCountByLeaderId.get(unit.id) || 0) > 0) {
            _color.lerp(new THREE.Color(0xeec066), 0.34);
          }
        }
      }
      if ((unit.type === 'harvester' || unit.type === 'mobileHq') && unit.ownerId === myPid) {
        if (unit.followLeadId) {
          const lead = State.units.get(unit.followLeadId);
          if (lead && lead.hp > 0 && lead.ownerId === myPid) {
            _color.lerp(new THREE.Color(0x3aa899), 0.32);
          }
        } else if ((myFollowerCountByLeaderId.get(unit.id) || 0) > 0) {
          _color.lerp(new THREE.Color(0xeec066), 0.3);
        }
      }
      if (INFANTRY_TYPES_SET.has(unit.type)) {
        _color.lerp(new THREE.Color(1, 1, 1), 0.58);
      }
      if (harvesterGltfActive && unit.type === 'harvester') {
        _color.lerp(new THREE.Color(1, 1, 1), 0.42);
      }
      if (lightTankGltfActive && unit.type === 'lightTank') {
        _color.lerp(new THREE.Color(1, 1, 1), 0.4);
      }
      if (heavyTankGltfActive && unit.type === 'heavyTank') {
        _color.lerp(new THREE.Color(1, 1, 1), 0.4);
      }
      if (mobileHqGltfActive && unit.type === 'mobileHq') {
        _color.lerp(new THREE.Color(1, 1, 1), 0.38);
      }
      if (scoutBikeGltfActive && unit.type === 'scoutBike') {
        _color.lerp(new THREE.Color(1, 1, 1), 0.4);
      }
      if (artilleryGltfActive && unit.type === 'artillery') {
        _color.lerp(new THREE.Color(1, 1, 1), 0.4);
      }
      mesh.setColorAt(i, _color);

      unit._renderIndex = i;
      unit._renderVisible = visible;
    }

    counts[type] = Math.min(list.length, MAX_INSTANCES_PER_TYPE);
  }

  // Update counts and mark dirty
  for (const [type, mesh] of Object.entries(unitMeshes)) {
    // Hide remaining unused instances
    for (let i = counts[type]; i < mesh.count; i++) {
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
      mesh.setMatrixAt(i, _mat4);
    }
    mesh.count = Math.max(counts[type], mesh.count); // Never reduce count, just hide
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

function updateBuildingInstances() {
  const counts = {};
  for (const type of Object.keys(buildingMeshes)) {
    counts[type] = 0;
  }

  const myTeam = State.players[State.gameSession.myPlayerId]?.team ?? 0;
  const THREE_w = window.THREE;
  const hqSeenIds = new Set();
  const refinerySeenIds = new Set();
  const barracksSeenIds = new Set();
  const warFactorySeenIds = new Set();

  State.buildings.forEach(building => {
    if (building.hp <= 0) return;
    const mesh = buildingMeshes[building.type];
    if (!mesh) return;

    const idx = counts[building.type];
    if (idx >= MAX_BUILDING_INSTANCES) return;

    const ownerPl = State.players[building.ownerId];
    const onMySide = ownerPl && ownerPl.team === myTeam;
    const explored =
      onMySide
      || building.team === myTeam
      || Fog.wasExploredByTeam(myTeam, building.x, building.z);
    
    // Visibility check (is it CURRENTLY in vision?)
    const currentlyVisible = Fog.isUnitVisibleToPlayer(building, State.gameSession.myPlayerId);
    
    const DRAW_AS_VISIBLE = explored; // We draw "stale" info for explored buildings

    if (DRAW_AS_VISIBLE) {
      // Scale Y by construction progress
      const scaleY = Math.max(0.1, building.constructionProgress || 1);
      _euler.set(0, building.rotation || 0, 0);
      _quat.setFromEuler(_euler);
      const gY = sampleMoonTerrainWorldY(building.x, building.z);
      _mat4.compose(
        _pos.set(building.x, gY, building.z),
        _quat,
        _scale.set(1, scaleY, 1)
      );
    } else {
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    }

    if (hqTexturedMode && building.type === 'hq' && hqTexturedTemplate && THREE_w) {
      hqSeenIds.add(building.id);
      syncHqTexturedOne(building, _mat4, DRAW_AS_VISIBLE, THREE_w);
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    }

    if (refineryTexturedMode && building.type === 'refinery' && refineryTexturedTemplate && THREE_w) {
      refinerySeenIds.add(building.id);
      syncRefineryTexturedOne(building, _mat4, DRAW_AS_VISIBLE, THREE_w);
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    }

    if (barracksTexturedMode && building.type === 'barracks' && barracksTexturedTemplate && THREE_w) {
      barracksSeenIds.add(building.id);
      syncBarracksTexturedOne(building, _mat4, DRAW_AS_VISIBLE, THREE_w);
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    }

    if (warFactoryTexturedMode && building.type === 'warFactory' && warFactoryTexturedTemplate && THREE_w) {
      warFactorySeenIds.add(building.id);
      syncWarFactoryTexturedOne(building, _mat4, DRAW_AS_VISIBLE, THREE_w);
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    }

    mesh.setMatrixAt(idx, _mat4);

    // Player color tint
    _color.setHex(PLAYER_COLORS[building.ownerId] || 0x666666);
    mesh.setColorAt(idx, _color);

    building._renderIndex = idx;
    building._renderVisible = currentlyVisible;
    counts[building.type]++;
  });

  if (hqTexturedMode) {
    for (const [id, root] of [...hqTexturedByBuildingId]) {
      if (!hqSeenIds.has(id)) {
        scene3D.remove(root);
        disposeHqTexturedObject3D(root, window.THREE);
        hqTexturedByBuildingId.delete(id);
      }
    }
  }

  if (refineryTexturedMode) {
    for (const [id, root] of [...refineryTexturedByBuildingId]) {
      if (!refinerySeenIds.has(id)) {
        scene3D.remove(root);
        disposeHqTexturedObject3D(root, window.THREE);
        refineryTexturedByBuildingId.delete(id);
      }
    }
  }

  if (barracksTexturedMode) {
    for (const [id, root] of [...barracksTexturedByBuildingId]) {
      if (!barracksSeenIds.has(id)) {
        scene3D.remove(root);
        disposeHqTexturedObject3D(root, window.THREE);
        barracksTexturedByBuildingId.delete(id);
      }
    }
  }

  if (warFactoryTexturedMode) {
    for (const [id, root] of [...warFactoryTexturedByBuildingId]) {
      if (!warFactorySeenIds.has(id)) {
        scene3D.remove(root);
        disposeHqTexturedObject3D(root, window.THREE);
        warFactoryTexturedByBuildingId.delete(id);
      }
    }
  }

  for (const [type, mesh] of Object.entries(buildingMeshes)) {
    for (let i = counts[type]; i < mesh.count; i++) {
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
      mesh.setMatrixAt(i, _mat4);
    }
    mesh.count = Math.max(counts[type], mesh.count);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

function updateHealthBars() {
  let barIndex = 0;
  const camera = scene3D.getObjectByProperty('type', 'PerspectiveCamera');
  if (!camera) return;

  const cameraWorldPos = camera.getWorldPosition(new THREE.Vector3());

  // Helper to add a health bar facing camera
  const addBar = (x, y, z, hpPercent, visible) => {
    if (!visible || barIndex >= healthBarBgMesh.instanceMatrix.count) return;

    // Billboard: face camera
    const dx = cameraWorldPos.x - x;
    const dz = cameraWorldPos.z - z;
    const angle = Math.atan2(dx, dz);
    _euler.set(0, angle, 0);
    _quat.setFromEuler(_euler);

    // Background
    _mat4.compose(_pos.set(x, y, z), _quat, _scale.set(1, 1, 1));
    healthBarBgMesh.setMatrixAt(barIndex, _mat4);

    // Foreground (scale X by HP%)
    const fgScale = Math.max(0.01, hpPercent);
    const fgOffset = (1 - fgScale) * HEALTH_BAR_WIDTH * 0.5;
    _mat4.compose(
      _pos.set(x - Math.sin(angle) * fgOffset, y, z - Math.cos(angle) * fgOffset),
      _quat,
      _scale.set(fgScale, 1, 1)
    );
    healthBarFgMesh.setMatrixAt(barIndex, _mat4);

    barIndex++;
  };

  // Units
  State.units.forEach(unit => {
    if (unit.hp <= 0) return;
    const hpPct = unit.hp / unit.maxHp;
    if (hpPct >= 1) return; // Don't show bar when full HP
    const uGY = sampleMoonTerrainWorldY(unit.x, unit.z);
    addBar(unit.x, uGY + HEALTH_BAR_Y_OFFSET, unit.z, hpPct, unit._renderVisible);
  });

  // Buildings
  State.buildings.forEach(building => {
    if (building.hp <= 0) return;
    const hpPct = building.hp / building.maxHp;
    if (hpPct >= 1) return;
    const bGY = sampleMoonTerrainWorldY(building.x, building.z);
    addBar(building.x, bGY + buildingHudHeight(building.type) + 0.5, building.z, hpPct, building._renderVisible);
  });

  // Hide unused bars
  for (let i = barIndex; i < healthBarBgMesh.count; i++) {
    _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    healthBarBgMesh.setMatrixAt(i, _mat4);
    healthBarFgMesh.setMatrixAt(i, _mat4);
  }

  healthBarBgMesh.count = Math.max(barIndex, healthBarBgMesh.count);
  healthBarFgMesh.count = Math.max(barIndex, healthBarFgMesh.count);
  healthBarBgMesh.instanceMatrix.needsUpdate = true;
  healthBarFgMesh.instanceMatrix.needsUpdate = true;
}

/** Torus major 1 + tube 0.05 in XZ; scale so ring sits just outside unit footprint (matches larger shapes). */
function selectionRingScaleForUnitType(unitType) {
  const shape = UNIT_SHAPES[unitType];
  if (!shape) return 1;
  const torusOuter = 1.05;
  if (shape.type === 'cylinder') {
    const r = Math.max(shape.radiusBottom, shape.radiusTop) + 0.22;
    return r / torusOuter;
  }
  const half = Math.max(shape.width, shape.depth) * 0.5 + 0.22;
  let s = half / torusOuter;
  if (unitType === 'heavyTank') s *= 1.22;
  if (unitType === 'heavyTank' && heavyTankGltfActive) s *= HEAVY_TANK_GLB_VISUAL_SCALE;
  if (unitType === 'mobileHq' && mobileHqGltfActive) s *= MOBILE_HQ_GLB_VISUAL_SCALE;
  /** Ring smaller than full visual scale (buggy model is large; tighter selection ring). */
  if (unitType === 'scoutBike' && scoutBikeGltfActive) s *= SCOUT_BIKE_GLB_VISUAL_SCALE * 0.5;
  if (unitType === 'artillery' && artilleryGltfActive) s *= ARTILLERY_GLB_VISUAL_SCALE;
  if (unitType === 'lightTank' && lightTankGltfActive) s *= 2;
  return s;
}

function countSquadFollowersForRing(leaderId) {
  let n = 0;
  State.units.forEach(u => {
    if (u.hp > 0 && u.followLeadId === leaderId) n++;
  });
  return n;
}

function updateSelectionRings() {
  let ringIndex = 0;
  let refRingIndex = 0;
  const rungUnitIds = new Set();

  State.selectedUnits.forEach(unitId => {
    const unit = State.units.get(unitId);
    if (!unit || unit.hp <= 0 || ringIndex >= 60) return;

    let s = selectionRingScaleForUnitType(unit.type);
    if (!unit.followLeadId && countSquadFollowersForRing(unit.id) > 0) {
      s *= 1.12;
    }
    const uGY = sampleMoonTerrainWorldY(unit.x, unit.z);
    _mat4.compose(
      _pos.set(unit.x, uGY + 0.15, unit.z),
      _quat.identity(),
      _scale.set(s, 1, s)
    );
    selectionRingMesh.setMatrixAt(ringIndex, _mat4);
    ringIndex++;
    rungUnitIds.add(unitId);
  });

  const myPid = State.gameSession.myPlayerId;
  if (squadLeaderRefRingMesh) {
    State.selectedUnits.forEach(unitId => {
      const u = State.units.get(unitId);
      if (!u || u.hp <= 0 || u.ownerId !== myPid || !u.followLeadId || refRingIndex >= 32) return;
      const leadId = u.followLeadId;
      if (rungUnitIds.has(leadId)) return;
      const lead = State.units.get(leadId);
      if (!lead || lead.hp <= 0 || lead.ownerId !== myPid) return;
      if (countSquadFollowersForRing(leadId) === 0) return;
      const s = selectionRingScaleForUnitType(lead.type) * 1.12;
      const uGY = sampleMoonTerrainWorldY(lead.x, lead.z);
      _mat4.compose(
        _pos.set(lead.x, uGY + 0.15, lead.z),
        _quat.identity(),
        _scale.set(s, 1, s)
      );
      squadLeaderRefRingMesh.setMatrixAt(refRingIndex, _mat4);
      refRingIndex++;
      rungUnitIds.add(leadId);
    });
  }

  // Selected Building
  if (UI.activeBuildingPanel && ringIndex < selectionRingMesh.count) {
    const building = UI.activeBuildingPanel;
    if (building && building.hp > 0 && Fog.isUnitVisibleToPlayer(building, State.gameSession.myPlayerId)) {
      let bSize = (building.size || 4) / 2 + 1.25;
      if (building.type === 'barracks' && barracksTexturedMode) {
        bSize *= 1.5;
      }
      if (building.type === 'warFactory' && warFactoryTexturedMode) {
        bSize *= WAR_FACTORY_GLB_VISUAL_SCALE;
      }
      const bGY = sampleMoonTerrainWorldY(building.x, building.z);
      _mat4.compose(
        _pos.set(building.x, bGY + 0.15, building.z),
        _quat.identity(),
        _scale.set(bSize, 1, bSize)
      );
      selectionRingMesh.setMatrixAt(ringIndex, _mat4);
      ringIndex++;
    }
  }

  // Selected Resource Field
  if (UI.activeResourceField && ringIndex < selectionRingMesh.count) {
    const resource = UI.activeResourceField;
    const rSize = 3;
    const rGY = sampleMoonTerrainWorldY(resource.x, resource.z);
    _mat4.compose(
      _pos.set(resource.x, rGY + 0.15, resource.z),
      _quat.identity(),
      _scale.set(rSize, 1, rSize)
    );
    selectionRingMesh.setMatrixAt(ringIndex, _mat4);
    ringIndex++;
  }

  // Hide unused
  for (let i = ringIndex; i < selectionRingMesh.count; i++) {
    _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    selectionRingMesh.setMatrixAt(i, _mat4);
  }
  selectionRingMesh.count = Math.max(ringIndex, selectionRingMesh.count);
  selectionRingMesh.instanceMatrix.needsUpdate = true;

  if (squadLeaderRefRingMesh) {
    for (let i = refRingIndex; i < squadLeaderRefRingMesh.count; i++) {
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
      squadLeaderRefRingMesh.setMatrixAt(i, _mat4);
    }
    squadLeaderRefRingMesh.count = Math.max(refRingIndex, squadLeaderRefRingMesh.count);
    squadLeaderRefRingMesh.instanceMatrix.needsUpdate = true;
  }
}

function updateResourceFields() {
  if (!resourceFieldMesh) return;

  let i = 0;
  State.resourceFields.forEach(field => {
    if (i >= RESOURCE_FIELD_POSITIONS.length) return;

    const depletionRatio = field.remaining / field.maxCapacity;
    const scale = 0.3 + depletionRatio * 0.7; // Shrinks as depleted

    const myTeam = State.players[State.gameSession.myPlayerId]?.team ?? 0;
    const explored = Fog.wasExploredByTeam(myTeam, field.x, field.z);

    if (explored) {
      const fGY = sampleMoonTerrainWorldY(field.x, field.z);
      _mat4.compose(
        _pos.set(field.x, fGY + 2.5 * scale, field.z),
        _quat.identity(),
        _scale.set(scale, scale, scale)
      );
    } else {
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    }
    resourceFieldMesh.setMatrixAt(i, _mat4);
    i++;
  });

  resourceFieldMesh.instanceMatrix.needsUpdate = true;
}

// ==========================================
// PROJECTILES
// ==========================================

export function spawnProjectile(fromX, fromY, fromZ, toX, toY, toZ, color, duration = 200) {
  const proj = {
    index: projectileIndex % MAX_PROJECTILES,
    startX: fromX, startY: fromY, startZ: fromZ,
    endX: toX, endY: toY, endZ: toZ,
    startTime: performance.now(),
    duration,
    onHit: arguments[8], // Ninth argument is onHit callback
    active: true,
  };

  activeProjectiles.push(proj);
  projectileIndex++;

  // Set color
  _color.setHex(color);
  projectileMesh.setColorAt(proj.index, _color);
  projectileMesh.instanceColor.needsUpdate = true;
}

function updateProjectiles() {
  const now = performance.now();

  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const proj = activeProjectiles[i];
    const elapsed = now - proj.startTime;
    const t = Math.min(1, elapsed / proj.duration);

    if (t >= 1) {
      // Execute hit callback if present
      if (proj.onHit) {
        try {
          proj.onHit();
        } catch (err) {
          console.error('Error in projectile onHit:', err);
        }
      }

      // Hide projectile
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
      projectileMesh.setMatrixAt(proj.index, _mat4);
      activeProjectiles.splice(i, 1);
      continue;
    }

    // Interpolate position
    const x = proj.startX + (proj.endX - proj.startX) * t;
    const y = proj.startY + (proj.endY - proj.startY) * t + Math.sin(t * Math.PI) * 2; // Arc
    const z = proj.startZ + (proj.endZ - proj.startZ) * t;

    _mat4.compose(_pos.set(x, y, z), _quat.identity(), _scale.set(1, 1, 1));
    projectileMesh.setMatrixAt(proj.index, _mat4);
  }

  projectileMesh.instanceMatrix.needsUpdate = true;
}

// ==========================================
// GROUND PLANE (for raycasting)
// ==========================================
export function getGroundMesh() {
  if (!groundMesh) {
    // Find the A-Frame ground plane
    const groundEl = document.getElementById('ground');
    if (groundEl) {
      groundEl.object3D.traverse(child => {
        if (child.isMesh) groundMesh = child;
      });
    }
  }
  return groundMesh;
}

// ==========================================
// RAYCASTING (unit selection via bounding spheres)
// ==========================================

const _ray = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _rayPickOc = new THREE.Vector3();
const _rayPickClosest = new THREE.Vector3();
const _projPick = new THREE.Vector3();

/**
 * NDC distance from pick point to projected world point (same space as A-Frame setFromCamera).
 * @param { { x: number, y: number } | null | undefined } pickNdc
 */
export function pickScreenNdcError(wx, wy, wz, pickNdc) {
  if (!pickNdc) return Infinity;
  const cam = typeof document !== 'undefined' ? document.querySelector('a-scene')?.camera : null;
  if (!cam) return Infinity;
  _projPick.set(wx, wy, wz).project(cam);
  return Math.hypot(_projPick.x - pickNdc.x, _projPick.y - pickNdc.y);
}

export function pickScreenNdcErrorForUnit(unit, pickNdc) {
  if (!unit || !pickNdc) return Infinity;
  const shape = UNIT_SHAPES[unit.type];
  if (!shape) return Infinity;
  const centerY = shape.height * 0.5;
  const gY = sampleMoonTerrainWorldY(unit.x, unit.z);
  return pickScreenNdcError(unit.x, gY + centerY, unit.z, pickNdc);
}

export function pickScreenNdcErrorForBuilding(building, pickNdc) {
  if (!building || !pickNdc) return Infinity;
  const { centerY } = buildingPickVerticalAndRadius(building.type);
  const gY = sampleMoonTerrainWorldY(building.x, building.z);
  return pickScreenNdcError(building.x, gY + centerY, building.z, pickNdc);
}

export function pickScreenNdcErrorForGroundPoint(x, z, pickNdc) {
  if (!pickNdc || !Number.isFinite(x) || !Number.isFinite(z)) return Infinity;
  const y = sampleMoonTerrainWorldY(x, z);
  return pickScreenNdcError(x, y, z, pickNdc);
}

export function pickScreenNdcErrorForResourceField(field, pickNdc) {
  if (!field || !pickNdc) return Infinity;
  const cap = field.maxCapacity || 1;
  const cy = field.depleted ? 0.55 : Math.max(1, (field.remaining / cap) * 3);
  const gY = sampleMoonTerrainWorldY(field.x, field.z);
  return pickScreenNdcError(field.x, gY + cy, field.z, pickNdc);
}

/**
 * Along-ray distance to the **near** sphere intersection (same convention as `considerSpherePick`).
 * @returns {number|null}
 */
export function raySphereNearEntryT(origin, direction, center, radius, maxDist = 200) {
  _rayPickOc.subVectors(center, origin);
  const b = _rayPickOc.dot(direction);
  const c = _rayPickOc.dot(_rayPickOc) - radius * radius;
  const discriminant = b * b - c;
  if (discriminant <= 0) return null;
  const sqrtD = Math.sqrt(discriminant);
  const dist = b - sqrtD;
  if (dist <= 0 || dist >= maxDist) return null;
  return dist;
}

/**
 * Entry distance along `origin`+`direction` for a hit returned by `raycastUnits` / `raycastBuildings` /
 * `raycastResourceFields` (same sphere centers and radii). Used when resolving overlaps without NDC.
 * @param {'unit'|'building'|'resource'} kind
 */
export function battlefieldPickEntryT(origin, direction, kind, obj, maxDist = 200, radiusBoost = 0) {
  if (!obj) return null;
  const boost = Math.max(0, radiusBoost);
  if (kind === 'unit') {
    const shape = UNIT_SHAPES[obj.type];
    if (!shape) return null;
    const radius =
      shape.type === 'cylinder'
        ? Math.max(shape.radiusBottom, shape.radiusTop) + 0.3 + boost
        : Math.max(shape.width, shape.depth) * 0.5 + 0.3 + boost;
    const centerY = shape.height * 0.5;
    const gY = sampleMoonTerrainWorldY(obj.x, obj.z);
    _pos.set(obj.x, gY + centerY, obj.z);
    return raySphereNearEntryT(origin, direction, _pos, radius, maxDist);
  }
  if (kind === 'building') {
    const { centerY, radius: baseRadius } = buildingPickVerticalAndRadius(obj.type);
    const rBoost = boost * 0.55; // matches `raycastBuildings` (`max(0,radiusBoost)*0.55` added to base radius)
    const radius = baseRadius + rBoost;
    const gY = sampleMoonTerrainWorldY(obj.x, obj.z);
    _pos.set(obj.x, gY + centerY, obj.z);
    return raySphereNearEntryT(origin, direction, _pos, radius, maxDist);
  }
  if (kind === 'resource') {
    const radius = obj.depleted ? 2.35 : 2.0;
    const cap = obj.maxCapacity || 1;
    const centerY = obj.depleted ? 0.55 : Math.max(1, (obj.remaining / cap) * 3);
    const gY = sampleMoonTerrainWorldY(obj.x, obj.z);
    _pos.set(obj.x, gY + centerY, obj.z);
    return raySphereNearEntryT(origin, direction, _pos, radius, maxDist);
  }
  return null;
}

/**
 * Among sphere hits: with pickNdc, prefer projected screen distance (matches flat mouse / touch);
 * else prefer **along-ray entry distance** (first hit along the laser), then perpendicular miss — matches VR controller rays.
 */
function considerSpherePick(origin, direction, center, radius, maxDist, state, target, pickNdc) {
  _rayPickOc.subVectors(center, origin);
  const b = _rayPickOc.dot(direction);
  const c = _rayPickOc.dot(_rayPickOc) - radius * radius;
  const discriminant = b * b - c;
  if (discriminant <= 0) return;

  const sqrtD = Math.sqrt(discriminant);
  const dist = b - sqrtD;
  if (dist <= 0 || dist >= maxDist) return;

  const dDotD = direction.dot(direction);
  const tClosest = dDotD > 1e-20 ? b / dDotD : 0;
  _rayPickClosest.copy(origin).addScaledVector(direction, tClosest);
  const miss = _rayPickClosest.distanceTo(center);

  const screenPen = pickNdc ? pickScreenNdcError(center.x, center.y, center.z, pickNdc) : 0;

  const tieEps = pickNdc ? 2e-4 : 1e-3;
  let better = false;
  if (pickNdc) {
    better =
      screenPen < state.bestScreen - tieEps ||
      (Math.abs(screenPen - state.bestScreen) <= tieEps && miss < state.bestMiss - tieEps) ||
      (
        Math.abs(screenPen - state.bestScreen) <= tieEps &&
        Math.abs(miss - state.bestMiss) <= tieEps &&
        dist < state.bestDist - tieEps
      );
  } else {
    better =
      dist < state.bestDist - tieEps ||
      (Math.abs(dist - state.bestDist) <= tieEps && miss < state.bestMiss - tieEps);
  }
  if (better) {
    if (pickNdc) state.bestScreen = screenPen;
    state.bestMiss = miss;
    state.bestDist = dist;
    state.best = target;
  }
}

function makePickState(pickNdc) {
  return pickNdc
    ? { best: null, bestMiss: Infinity, bestDist: Infinity, bestScreen: Infinity }
    : { best: null, bestMiss: Infinity, bestDist: Infinity };
}

export function raycastUnits(origin, direction, maxDist = 200, radiusBoost = 0, pickNdc = null) {
  const boost = Math.max(0, radiusBoost);
  const state = makePickState(pickNdc);

  State.units.forEach(unit => {
    if (unit.hp <= 0 || !unit._renderVisible) return;

    const shape = UNIT_SHAPES[unit.type];
    const radius = shape.type === 'cylinder' ?
      Math.max(shape.radiusBottom, shape.radiusTop) + 0.3 + boost :
      Math.max(shape.width, shape.depth) * 0.5 + 0.3 + boost;
    const centerY = (shape.type === 'cylinder' ? shape.height : shape.height) * 0.5;
    const gY = sampleMoonTerrainWorldY(unit.x, unit.z);

    _pos.set(unit.x, gY + centerY, unit.z);
    considerSpherePick(origin, direction, _pos, radius, maxDist, state, unit, pickNdc);
  });

  return state.best;
}

export function raycastBuildings(origin, direction, maxDist = 200, radiusBoost = 0, pickNdc = null) {
  const boost = Math.max(0, radiusBoost) * 0.55;
  const state = makePickState(pickNdc);

  State.buildings.forEach(building => {
    if (building.hp <= 0 || !building._renderVisible) return;

    const { centerY, radius: baseRadius } = buildingPickVerticalAndRadius(building.type);
    const radius = baseRadius + boost;
    const gY = sampleMoonTerrainWorldY(building.x, building.z);

    _pos.set(building.x, gY + centerY, building.z);
    considerSpherePick(origin, direction, _pos, radius, maxDist, state, building, pickNdc);
  });

  return state.best;
}

export function raycastResourceFields(origin, direction, maxDist = 200, pickNdc = null) {
  const state = makePickState(pickNdc);

  State.resourceFields.forEach(field => {
    // Depleted fields stay pickable (small stub mesh); use a stable sphere for ray hit.
    const radius = field.depleted ? 2.35 : 2.0;
    const centerY = field.depleted
      ? 0.55
      : Math.max(1, (field.remaining / field.maxCapacity) * 3);
    const gY = sampleMoonTerrainWorldY(field.x, field.z);

    _pos.set(field.x, gY + centerY, field.z);
    considerSpherePick(origin, direction, _pos, radius, maxDist, state, field, pickNdc);
  });

  return state.best;
}

// Cleanup
export function disposeRenderer() {
  hqModelVisualHeight = null;
  hqModelPickHalfHeight = null;
  hqModelPickRadius = null;
  refineryModelVisualHeight = null;
  refineryModelPickHalfHeight = null;
  refineryModelPickRadius = null;
  barracksModelVisualHeight = null;
  barracksModelPickHalfHeight = null;
  barracksModelPickRadius = null;
  warFactoryModelVisualHeight = null;
  warFactoryModelPickHalfHeight = null;
  warFactoryModelPickRadius = null;

  if (hqTexturedMode) {
    const THREE_w = window.THREE;
    for (const root of hqTexturedByBuildingId.values()) {
      scene3D.remove(root);
      disposeHqTexturedObject3D(root, THREE_w);
    }
    hqTexturedByBuildingId.clear();
    if (hqTexturedTemplate) {
      disposeHqTexturedObject3D(hqTexturedTemplate, THREE_w);
      hqTexturedTemplate = null;
    }
    hqTexturedMode = false;
    if (buildingMeshes.hq) buildingMeshes.hq.visible = true;
  }

  if (refineryTexturedMode) {
    const THREE_w = window.THREE;
    for (const root of refineryTexturedByBuildingId.values()) {
      scene3D.remove(root);
      disposeHqTexturedObject3D(root, THREE_w);
    }
    refineryTexturedByBuildingId.clear();
    if (refineryTexturedTemplate) {
      disposeHqTexturedObject3D(refineryTexturedTemplate, THREE_w);
      refineryTexturedTemplate = null;
    }
    refineryTexturedMode = false;
    if (buildingMeshes.refinery) buildingMeshes.refinery.visible = true;
  }

  if (barracksTexturedMode) {
    const THREE_w = window.THREE;
    for (const root of barracksTexturedByBuildingId.values()) {
      scene3D.remove(root);
      disposeHqTexturedObject3D(root, THREE_w);
    }
    barracksTexturedByBuildingId.clear();
    if (barracksTexturedTemplate) {
      disposeHqTexturedObject3D(barracksTexturedTemplate, THREE_w);
      barracksTexturedTemplate = null;
    }
    barracksTexturedMode = false;
    if (buildingMeshes.barracks) buildingMeshes.barracks.visible = true;
  }

  if (warFactoryTexturedMode) {
    const THREE_w = window.THREE;
    for (const root of warFactoryTexturedByBuildingId.values()) {
      scene3D.remove(root);
      disposeHqTexturedObject3D(root, THREE_w);
    }
    warFactoryTexturedByBuildingId.clear();
    if (warFactoryTexturedTemplate) {
      disposeHqTexturedObject3D(warFactoryTexturedTemplate, THREE_w);
      warFactoryTexturedTemplate = null;
    }
    warFactoryTexturedMode = false;
    if (buildingMeshes.warFactory) buildingMeshes.warFactory.visible = true;
  }

  harvesterGltfActive = false;
  lightTankGltfActive = false;
  heavyTankGltfActive = false;
  mobileHqGltfActive = false;
  scoutBikeGltfActive = false;
  artilleryGltfActive = false;

  Object.values(unitMeshes).forEach(m => { scene3D.remove(m); m.dispose(); });
  Object.values(buildingMeshes).forEach(m => { scene3D.remove(m); m.dispose(); });
  if (healthBarBgMesh) { scene3D.remove(healthBarBgMesh); healthBarBgMesh.dispose(); }
  if (healthBarFgMesh) { scene3D.remove(healthBarFgMesh); healthBarFgMesh.dispose(); }
  if (selectionRingMesh) { scene3D.remove(selectionRingMesh); selectionRingMesh.dispose(); }
  if (squadLeaderRefRingMesh) { scene3D.remove(squadLeaderRefRingMesh); squadLeaderRefRingMesh.dispose(); squadLeaderRefRingMesh = null; }
  if (resourceFieldMesh) { scene3D.remove(resourceFieldMesh); resourceFieldMesh.dispose(); }
  if (projectileMesh) { scene3D.remove(projectileMesh); projectileMesh.dispose(); }
}

function updateBuildBoundary() {
  if (!buildRadiusMesh) return;

  if (State.gameSession.buildMode) {
    let hq = null;
    const sid = State.gameSession.buildModeHQId;
    if (sid && State.buildings.has(sid)) {
      const b = State.buildings.get(sid);
      if (b && b.type === 'hq' && b.hp > 0) hq = b;
    }
    if (!hq) hq = State.getPlayerHQ(State.gameSession.myPlayerId);
    if (hq) {
      const hGY = sampleMoonTerrainWorldY(hq.x, hq.z);
      buildRadiusMesh.position.set(hq.x, hGY + 0.2, hq.z);
      buildRadiusMesh.visible = true;
      return;
    }
  }
  
  buildRadiusMesh.visible = false;
}
