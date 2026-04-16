// ========================================
// RTSVR2 — Renderer
// InstancedMesh management for all game objects
// ========================================

import {
  UNIT_TYPES, UNIT_SHAPES, BUILDING_TYPES, BUILDING_SHAPES, BUILDING_BASE_COLORS,
  PLAYER_COLORS, MAX_INSTANCES_PER_TYPE, MAX_BUILDING_INSTANCES,
  MAX_PROJECTILES, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT, HEALTH_BAR_Y_OFFSET,
  RESOURCE_FIELD_POSITIONS, BUILD_RADIUS_FROM_HQ,
} from './config.js';
import * as State from './state.js';
import * as Fog from './fog.js';
import * as UI from './ui.js';
import { sampleMoonTerrainWorldY } from './moon-environment.js';

let scene3D = null;  // THREE.Scene reference
const unitMeshes = {};     // unitType -> InstancedMesh
const buildingMeshes = {}; // buildingType -> InstancedMesh
let healthBarBgMesh = null;
let healthBarFgMesh = null;
let selectionRingMesh = null;
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

export function initRenderer(sceneEl) {
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

    mesh.setMatrixAt(idx, _mat4);

    // Player color tint
    _color.setHex(PLAYER_COLORS[building.ownerId] || 0x666666);
    mesh.setColorAt(idx, _color);

    building._renderIndex = idx;
    building._renderVisible = currentlyVisible;
    counts[building.type]++;
  });

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
    const shape = BUILDING_SHAPES[building.type];
    const hpPct = building.hp / building.maxHp;
    if (hpPct >= 1) return;
    const bGY = sampleMoonTerrainWorldY(building.x, building.z);
    addBar(building.x, bGY + (shape?.height || 3) + 0.5, building.z, hpPct, building._renderVisible);
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
  return s;
}

function updateSelectionRings() {
  let ringIndex = 0;

  State.selectedUnits.forEach(unitId => {
    const unit = State.units.get(unitId);
    if (!unit || unit.hp <= 0 || ringIndex >= 60) return;

    const s = selectionRingScaleForUnitType(unit.type);
    const uGY = sampleMoonTerrainWorldY(unit.x, unit.z);
    _mat4.compose(
      _pos.set(unit.x, uGY + 0.15, unit.z),
      _quat.identity(),
      _scale.set(s, 1, s)
    );
    selectionRingMesh.setMatrixAt(ringIndex, _mat4);
    ringIndex++;
  });

  // Selected Building
  if (UI.activeBuildingPanel && ringIndex < selectionRingMesh.count) {
    const building = UI.activeBuildingPanel;
    if (building && building.hp > 0 && Fog.isUnitVisibleToPlayer(building, State.gameSession.myPlayerId)) {
      const bSize = (building.size || 4) / 2 + 1.25;
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
  const shape = BUILDING_SHAPES[building.type];
  if (!shape) return Infinity;
  const centerY = shape.height * 0.5;
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
 * Among sphere hits: with pickNdc, prefer projected screen distance (matches what the user sees);
 * else use ray–center miss then along-ray distance (VR / legacy).
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
      miss < state.bestMiss - tieEps ||
      (Math.abs(miss - state.bestMiss) <= tieEps && dist < state.bestDist - tieEps);
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

    const shape = BUILDING_SHAPES[building.type];
    if (!shape) return;
    const radius = Math.max(shape.width, shape.depth) * 0.6 + boost;
    const centerY = shape.height * 0.5;
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
  Object.values(unitMeshes).forEach(m => { scene3D.remove(m); m.dispose(); });
  Object.values(buildingMeshes).forEach(m => { scene3D.remove(m); m.dispose(); });
  if (healthBarBgMesh) { scene3D.remove(healthBarBgMesh); healthBarBgMesh.dispose(); }
  if (healthBarFgMesh) { scene3D.remove(healthBarFgMesh); healthBarFgMesh.dispose(); }
  if (selectionRingMesh) { scene3D.remove(selectionRingMesh); selectionRingMesh.dispose(); }
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
