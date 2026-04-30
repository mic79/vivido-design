/**
 * Brutalist massing from brutalistVR `createBrutalistScene` — same slab layout and materials.
 * Meshes are named for bake/debug; boxes get `userData.originalMaterial` for post-bake Physical + lightMap.
 */

const CONCRETE = 0x9c958a;
/* Previously a darker concrete tone (0x5c5852); user wants a single uniform stone colour. */
const CONCRETE_DARK = CONCRETE;

function createGrainTexture(THREE, size = 192) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 105 + Math.random() * 75;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * @param {typeof import('three')} THREE
 * @param {import('three').Scene} scene
 * @param {{ fidelityMax?: boolean }} [opts]
 * @returns {{ sceneObjects: import('three').Mesh[], materials: import('three').MeshPhysicalMaterial[] }}
 */
export function buildBrutalistLayout(THREE, scene, opts = {}) {
  const fidelityMax = opts.fidelityMax !== false;
  const grainTex = createGrainTexture(THREE);
  const grainGround = createGrainTexture(THREE);
  const materials = [];

  const wallMat = new THREE.MeshPhysicalMaterial({
    color: CONCRETE,
    roughness: fidelityMax ? 0.78 : 0.82,
    metalness: 0.07,
    roughnessMap: grainTex,
    envMapIntensity: fidelityMax ? 1.12 : 1.02,
    clearcoat: 0.06,
    clearcoatRoughness: 0.62,
    sheen: 0.22,
    sheenRoughness: 0.74,
    sheenColor: new THREE.Color(0xc8c2b6),
  });
  /* `darkMat` kept as a separate instance only so PBR maps/repeats stay independent if we
   * tweak them later, but its colour now matches `wallMat` per user request. */
  const darkMat = new THREE.MeshPhysicalMaterial({
    color: CONCRETE_DARK,
    roughness: fidelityMax ? 0.78 : 0.82,
    metalness: 0.07,
    roughnessMap: grainTex,
    envMapIntensity: fidelityMax ? 1.12 : 1.02,
    clearcoat: 0.06,
    clearcoatRoughness: 0.62,
    sheen: 0.22,
    sheenRoughness: 0.74,
    sheenColor: new THREE.Color(0xc8c2b6),
  });
  for (const m of [wallMat, darkMat]) {
    m.roughnessMap.repeat.set(5, 5);
    materials.push(m);
  }

  /* Floor matches the walls (light concrete). Slight extra roughness + reduced sheen
   * keeps it from looking like polished plastic; same base colour. */
  const groundMat = new THREE.MeshPhysicalMaterial({
    color: CONCRETE,
    roughness: fidelityMax ? 0.88 : 0.93,
    metalness: fidelityMax ? 0.05 : 0.02,
    roughnessMap: grainGround,
    envMapIntensity: fidelityMax ? 0.6 : 0.45,
    clearcoat: fidelityMax ? 0.03 : 0,
    sheen: fidelityMax ? 0.08 : 0.04,
    sheenRoughness: 0.94,
    sheenColor: new THREE.Color(0xc8c2b6),
  });
  groundMat.roughnessMap.repeat.set(24, 24);
  materials.push(groundMat);

  /* `PlaneGeometry(240, 240)` baked at 1024² → ~4.3 lightmap texels per world unit. Coarse,
   * but enough to capture broad slab shadows. `originalMaterial` lets `applyBakedMaterials`
   * swap the ground to the same lightmap-only path the walls use. */
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = "ground";
  ground.userData.originalMaterial = groundMat;
  scene.add(ground);

  function slab(w, h, d, mat = wallMat) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  const sceneObjects = [ground];

  const addNamed = (mesh, name) => {
    mesh.name = name;
    mesh.userData.originalMaterial = mesh.material;
    scene.add(mesh);
    sceneObjects.push(mesh);
  };

  const north = slab(120, 36, 8, wallMat);
  north.position.set(0, 18, -50);
  addNamed(north, "north");

  const south = slab(100, 28, 10, wallMat);
  south.position.set(-8, 14, 52);
  addNamed(south, "south");

  const east = slab(10, 44, 70, darkMat);
  east.position.set(58, 22, 0);
  addNamed(east, "east");

  const west = slab(12, 32, 65, wallMat);
  west.position.set(-58, 16, 4);
  addNamed(west, "west");

  const core = slab(28, 52, 28, wallMat);
  core.position.set(12, 26, -8);
  addNamed(core, "core");

  const bridge = slab(48, 4, 14, darkMat);
  bridge.position.set(-18, 22, -12);
  addNamed(bridge, "bridge");

  const pilotis = slab(22, 14, 22, wallMat);
  pilotis.position.set(-28, 7, 28);
  addNamed(pilotis, "pilotis");

  const cantilever = slab(36, 3, 18, wallMat);
  cantilever.position.set(22, 30, 22);
  cantilever.rotation.set(0.35, 0.12, -0.25, "XYZ");
  addNamed(cantilever, "cantilever");

  for (let i = 0; i < 5; i++) {
    const fin = slab(1.2, 24, 6, darkMat);
    fin.position.set(-20 + i * 5, 12, -35);
    addNamed(fin, `fin_${i}`);
  }

  const podium = slab(70, 6, 40, wallMat);
  podium.position.set(-30, 3, -22);
  addNamed(podium, "podium");

  return { sceneObjects, materials };
}
