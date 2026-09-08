/**
 * Skirmish valley composition (Tempest Rising–style, lunar):
 *   - Traversable: open center / flank lanes on the crater floor
 *   - Blocking: walls built from real SM_Cliff_* kit meshes (not boxes)
 *   - Decorative: smaller rocks as scree at cliff bases + occasional debris
 *
 * Nav blockers match cliff footprints so pathfinding matches the silhouette.
 */
import { MAP_UNIT_NAV_RADIUS, MAP_TERRAIN_STYLE } from './config.js';

/** @typedef {{ x: number, z: number, yaw: number, scale: number, variant: number, blockHx: number, blockHz: number }} CliffPlacement */

/**
 * Valley walls: two facing cliff lines with a clear center lane (~±28 m).
 * @returns {CliffPlacement[]}
 */
export function getValleyCliffPlacements() {
  // Disabled until walls are authored with matching nav (no invisible blockers).
  return [];
}

/** Soft nav lift — disabled (was causing invisible walls). Always 0. */
export function skirmishValleyNavLift(_wx, _wz) {
  return 0;
}

export function isSkirmishLaneWalkableXZ(wx, wz) {
  return skirmishValleyNavLift(wx, wz) < 2.0;
}

/**
 * Collect unique cliff mesh prototypes from the seated props template.
 * @returns {import('three').Object3D[]}
 */
function collectCliffPrototypes(propsRoot) {
  const byKey = new Map();
  if (!propsRoot || typeof propsRoot.traverse !== 'function') return [];
  propsRoot.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const n = o.name || '';
    if (!/Cliff/i.test(n)) return;
    const key = (n.match(/SM_Cliff_\d+/i) || [n.replace(/_\d+$/, '')])[0];
    if (!byKey.has(key)) byKey.set(key, o);
  });
  return [...byKey.values()];
}

function collectRockPrototypes(propsRoot) {
  const out = [];
  if (!propsRoot || typeof propsRoot.traverse !== 'function') return out;
  propsRoot.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const n = o.name || '';
    if (!/Rock|Mineral|Dirt/i.test(n) || /Cliff/i.test(n)) return;
    if (out.length < 8) out.push(o);
  });
  return out;
}

/**
 * Build valley walls from real cliff meshes + scree. Returns null if no cliff prototypes.
 * @param {*} THREE
 * @param {import('three').Object3D | null} propsTemplate
 */
export function buildSkirmishValleyMeshes(THREE, propsTemplate) {
  const places = getValleyCliffPlacements();
  if (!places.length || !THREE) return null;
  const cliffs = collectCliffPrototypes(propsTemplate);
  const rocks = collectRockPrototypes(propsTemplate);
  if (!cliffs.length) {
    console.warn('[RTSVR5] valley: no Cliff meshes in props template — skip walls');
    return null;
  }

  const group = new THREE.Group();
  group.name = 'rts-skirmish-valley';
  group.userData.rtsLaneRidges = true;
  group.userData.rtsValleyCliffs = true;

  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const src = cliffs[p.variant % cliffs.length];
    const mesh = src.clone(true);
    mesh.name = `ValleyCliff_${i}`;
    mesh.position.set(p.x, 0, p.z);
    mesh.rotation.set(0, p.yaw, 0);
    mesh.scale.setScalar(p.scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
        c.frustumCulled = true;
      }
    });
    group.add(mesh);

    // Scree / rubble transition at the cliff foot (decorative, inward face).
    if (rocks.length) {
      const inward = Math.sign(p.x) || 1;
      for (let k = 0; k < 3; k++) {
        const rsrc = rocks[(i + k) % rocks.length];
        const rubble = rsrc.clone(true);
        const along = (k - 1) * (2.8 + (i % 3));
        rubble.position.set(
          p.x - inward * (p.blockHx * 0.55 + 2 + k),
          0,
          p.z + along
        );
        rubble.rotation.y = (i + k) * 0.9;
        rubble.scale.setScalar(0.55 + (k % 3) * 0.25);
        rubble.castShadow = false;
        rubble.receiveShadow = true;
        group.add(rubble);
      }
    }
  }

  return group;
}

/** @deprecated keep name for older imports */
export function buildSkirmishLaneRidgeMeshes(THREE, propsTemplate) {
  return buildSkirmishValleyMeshes(THREE, propsTemplate || null);
}

/** @deprecated */
export function skirmishLaneRidgeLift(wx, wz) {
  return skirmishValleyNavLift(wx, wz);
}

/** @deprecated */
export function getSkirmishLaneRidges() {
  return getValleyCliffPlacements().map((p) => ({
    x: p.x,
    z: p.z,
    hx: p.blockHx,
    hz: p.blockHz,
    height: 14,
  }));
}
