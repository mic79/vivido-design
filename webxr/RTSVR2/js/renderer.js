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

  console.log('✅ Renderer initialized with InstancedMesh');
}

// --- Unit Meshes ---
function createUnitMeshes() {
  for (const [type, shape] of Object.entries(UNIT_SHAPES)) {
    let geometry;
    if (shape.type === 'cylinder') {
      geometry = new THREE.CylinderGeometry(shape.radiusTop, shape.radiusBottom, shape.height, 8);
      geometry.translate(0, shape.height / 2, 0);
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
    mesh.castShadow = false;
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
    mesh.castShadow = false;
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
    _mat4.compose(
      _pos.set(pos.x, 2.5, pos.z),
      _quat.identity(),
      _scale.set(1, 1, 1)
    );
    resourceFieldMesh.setMatrixAt(i, _mat4);
  });
  resourceFieldMesh.instanceMatrix.needsUpdate = true;
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

function updateUnitInstances() {
  // Reset instance counts
  const counts = {};
  const indexMap = {}; // unitId -> { type, instanceIndex }
  for (const type of Object.keys(unitMeshes)) {
    counts[type] = 0;
  }

  const myTeam = State.players[State.gameSession.myPlayerId]?.team ?? 0;

  State.units.forEach(unit => {
    if (unit.hp <= 0) return;
    const mesh = unitMeshes[unit.type];
    if (!mesh) return;

    // Fog of war check
    const visible = Fog.isUnitVisibleToPlayer(unit, State.gameSession.myPlayerId);
    const idx = counts[unit.type];
    if (idx >= MAX_INSTANCES_PER_TYPE) return;

    if (visible) {
      // Build transform
      _euler.set(0, unit.rotation || 0, 0);
      _quat.setFromEuler(_euler);
      _mat4.compose(
        _pos.set(unit.x, 0, unit.z),
        _quat,
        _scale.set(1, 1, 1)
      );
    } else {
      // Hide
      _mat4.compose(_pos.set(0, -1000, 0), _quat.identity(), _zeroScale);
    }

    mesh.setMatrixAt(idx, _mat4);

    // Set color — harvester gets state-based tinting
    if (unit.type === 'harvester') {
      const baseColor = PLAYER_COLORS[unit.ownerId] || 0xffffff;
      switch (unit.state) {
        case 'harvesting': {
          // Pulsing green glow while mining
          const pulse = 0.6 + Math.sin(performance.now() * 0.005) * 0.4;
          _color.setRGB(pulse * 0.2, pulse, pulse * 0.3);
          break;
        }
        case 'movingToRefinery': {
          // Gold/yellow — carrying resources back
          _color.setRGB(1.0, 0.85, 0.2);
          break;
        }
        case 'depositing': {
          // Bright orange pulsing while unloading
          const pulse2 = 0.7 + Math.sin(performance.now() * 0.008) * 0.3;
          _color.setRGB(1.0, 0.5 * pulse2, 0.1);
          break;
        }
        case 'movingToField': {
          // Dim cyan — heading out empty
          _color.setRGB(0.3, 0.7, 0.7);
          break;
        }
        default:
          _color.setHex(baseColor);
      }
    } else {
      const baseColor = PLAYER_COLORS[unit.ownerId] || 0xffffff;
      _color.setHex(baseColor);
      
      switch (unit.state) {
        case 'attacking':
          // Aggressive red pulse
          const rPulse = 0.5 + Math.sin(performance.now() * 0.008) * 0.5;
          _color.lerp(new THREE.Color(0xff2222), rPulse * 0.5);
          break;
        case 'moving':
          // Energetic blueish tint
          _color.lerp(new THREE.Color(0x4488ff), 0.3);
          break;
        case 'following':
          // Peaceful green tint
          _color.lerp(new THREE.Color(0x44ff44), 0.4);
          break;
        default:
          // 'idle' or uncommanded -> stays base color
          break;
      }
    }
    mesh.setColorAt(idx, _color);

    // Store index mapping for health bars
    unit._renderIndex = idx;
    unit._renderVisible = visible;

    counts[unit.type]++;
  });

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

  State.buildings.forEach(building => {
    if (building.hp <= 0) return;
    const mesh = buildingMeshes[building.type];
    if (!mesh) return;

    const idx = counts[building.type];
    if (idx >= MAX_BUILDING_INSTANCES) return;

    // Fog of war check: Only show if it matches my team OR was explored
    const myTeam = State.players[State.gameSession.myPlayerId]?.team ?? 0;
    const explored = building.team === myTeam || Fog.wasExploredByTeam(myTeam, building.x, building.z);
    
    // Visibility check (is it CURRENTLY in vision?)
    const currentlyVisible = Fog.isUnitVisibleToPlayer(building, State.gameSession.myPlayerId);
    
    const DRAW_AS_VISIBLE = explored; // We draw "stale" info for explored buildings

    if (DRAW_AS_VISIBLE) {
      // Scale Y by construction progress
      const scaleY = Math.max(0.1, building.constructionProgress || 1);
      _euler.set(0, building.rotation || 0, 0);
      _quat.setFromEuler(_euler);
      _mat4.compose(
        _pos.set(building.x, 0, building.z),
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
    addBar(unit.x, HEALTH_BAR_Y_OFFSET, unit.z, hpPct, unit._renderVisible);
  });

  // Buildings
  State.buildings.forEach(building => {
    if (building.hp <= 0) return;
    const shape = BUILDING_SHAPES[building.type];
    const hpPct = building.hp / building.maxHp;
    if (hpPct >= 1) return;
    addBar(building.x, (shape?.height || 3) + 0.5, building.z, hpPct, building._renderVisible);
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

function updateSelectionRings() {
  let ringIndex = 0;

  State.selectedUnits.forEach(unitId => {
    const unit = State.units.get(unitId);
    if (!unit || unit.hp <= 0 || ringIndex >= 60) return;

    _mat4.compose(
      _pos.set(unit.x, 0.15, unit.z),
      _quat.identity(),
      _scale.set(1, 1, 1)
    );
    selectionRingMesh.setMatrixAt(ringIndex, _mat4);
    ringIndex++;
  });

  // Selected Building
  if (UI.activeBuildingPanel && ringIndex < selectionRingMesh.count) {
    const building = UI.activeBuildingPanel;
    if (building && building.hp > 0 && Fog.isUnitVisibleToPlayer(building, State.gameSession.myPlayerId)) {
      const bSize = (building.size || 4) / 2 + 1.25;
      _mat4.compose(
        _pos.set(building.x, 0.15, building.z),
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
    _mat4.compose(
      _pos.set(resource.x, 0.15, resource.z),
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
      _mat4.compose(
        _pos.set(field.x, 2.5 * scale, field.z),
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

export function raycastUnits(origin, direction, maxDist = 200) {
  let nearest = null;
  let nearestDist = maxDist;

  State.units.forEach(unit => {
    if (unit.hp <= 0 || !unit._renderVisible) return;

    // Sphere intersection test
    const shape = UNIT_SHAPES[unit.type];
    const radius = shape.type === 'cylinder' ?
      Math.max(shape.radiusBottom, shape.radiusTop) + 0.3 :
      Math.max(shape.width, shape.depth) * 0.5 + 0.3;
    const centerY = (shape.type === 'cylinder' ? shape.height : shape.height) * 0.5;

    _pos.set(unit.x, centerY, unit.z);

    // Ray-sphere intersection
    const oc = _pos.clone().sub(origin);
    const b = oc.dot(direction);
    const c = oc.dot(oc) - radius * radius;
    const discriminant = b * b - c;

    if (discriminant > 0) {
      const dist = b - Math.sqrt(discriminant);
      if (dist > 0 && dist < nearestDist) {
        nearestDist = dist;
        nearest = unit;
      }
    }
  });

  return nearest;
}

export function raycastBuildings(origin, direction, maxDist = 200) {
  let nearest = null;
  let nearestDist = maxDist;

  State.buildings.forEach(building => {
    if (building.hp <= 0 || !building._renderVisible) return;

    const shape = BUILDING_SHAPES[building.type];
    if (!shape) return;
    const radius = Math.max(shape.width, shape.depth) * 0.6;
    const centerY = shape.height * 0.5;

    _pos.set(building.x, centerY, building.z);
    const oc = _pos.clone().sub(origin);
    const b = oc.dot(direction);
    const c = oc.dot(oc) - radius * radius;
    const discriminant = b * b - c;

    if (discriminant > 0) {
      const dist = b - Math.sqrt(discriminant);
      if (dist > 0 && dist < nearestDist) {
        nearestDist = dist;
        nearest = building;
      }
    }
  });

  return nearest;
}

export function raycastResourceFields(origin, direction, maxDist = 200) {
  let nearest = null;
  let nearestDist = maxDist;

  State.resourceFields.forEach(field => {
    if (field.depleted) return;
    
    // Quick sphere approximation for resource crystal
    const radius = 2.0; 
    const centerY = Math.max(1, (field.remaining / field.maxCapacity) * 3);

    _pos.set(field.x, centerY, field.z);
    const oc = _pos.clone().sub(origin);
    const b = oc.dot(direction);
    const c = oc.dot(oc) - radius * radius;
    const discriminant = b * b - c;

    if (discriminant > 0) {
      const dist = b - Math.sqrt(discriminant);
      if (dist > 0 && dist < nearestDist) {
        nearestDist = dist;
        nearest = field;
      }
    }
  });

  return nearest;
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
    const hq = State.getPlayerHQ(State.gameSession.myPlayerId);
    if (hq) {
      buildRadiusMesh.position.set(hq.x, 0.2, hq.z);
      buildRadiusMesh.visible = true;
      return;
    }
  }
  
  buildRadiusMesh.visible = false;
}
