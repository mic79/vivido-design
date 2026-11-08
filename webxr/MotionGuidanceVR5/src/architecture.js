/**
 * Calibration halls — procedural classical-futurist architecture built around each course.
 *
 *  · nave     — basilica hall following the route bay by bay: free-standing fluted
 *               columns carrying a moulded arcade, ashlar outer walls pierced by tall
 *               arched windows, a coffered barrel vault on lit transverse ribs.
 *               Curves bend at the ribs/pilasters (bay-wise), like real masonry.
 *  · rotunda  — Pantheon-like drum: column ring + arcade, windowed polygonal wall,
 *               coffered dome with an open oculus; the sun falls through it.
 *
 * Real sun (directional, shadowed) enters through the window openings / oculus,
 * the floor is a glossy planar reflector (whiteRoomVR style), the hall is captured
 * into its own PMREM for IBL. Exits are open arches into a lit vestibule tinted
 * with the next room's colour. Lab coords: +X is the participant's left facing +Z.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FloorReflector } from './reflector.js';
import { cofferSet } from './textures.js';

/** Temporary: solid smooth floor + walls (no tile / ashlar). Vault/dome keep coffers. */
const SMOOTH_SHELL = true;

/** Moulded rib cross-section in the (inward-normal, tangent) plane. Back face is
 *  buried into the vault/dome so it never z-fights the coffered shell. */
const RIB_LOOP = [
  [-0.08, -0.48], [0.12, -0.48], [0.12, -0.34], [0.30, -0.34],
  [0.40, -0.18], [0.68, -0.18], [0.68, 0.18], [0.40, 0.18],
  [0.30, 0.34], [0.12, 0.34], [0.12, 0.48], [-0.08, 0.48],
];
const DOME_RIB_LOOP = [
  [-0.08, -0.42], [0.10, -0.42], [0.10, -0.30], [0.26, -0.30],
  [0.36, -0.16], [0.62, -0.16], [0.62, 0.16], [0.36, 0.16],
  [0.26, 0.30], [0.10, 0.30], [0.10, 0.42], [-0.08, 0.42],
];

const UP = new THREE.Vector3(0, 1, 0);
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* ------------------------------------------------------------- frames */

/** Position/tangent/left along the course, extended straight past both ends. */
export function courseFrameAt(course, s) {
  const L = course.length;
  if (L <= 0) return { s, x: 0, y: course.startY, z: s, tx: 0, tz: 1, lx: 1, lz: 0 };
  const c = course.sample(Math.max(0, Math.min(L, s)));
  const tx = Math.sin(c.yaw), tz = Math.cos(c.yaw);
  let x = c.x, z = c.z;
  if (s < 0) { x += tx * s; z += tz * s; } else if (s > L) { x += tx * (s - L); z += tz * (s - L); }
  return { s, x, y: c.y, z, tx, tz, lx: tz, lz: -tx };
}
const PV = (f, u, y) => V(f.x + f.lx * u, y, f.z + f.lz * u);
const lat = (f) => V(f.lx, 0, f.lz);
const tan = (f) => V(f.tx, 0, f.tz);

/* ------------------------------------------------------- geometry kit */

function gridGeo(rows, uvFn) {
  const R = rows.length, C = rows[0].length;
  const pos = [], uvs = [], idx = [];
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const p = rows[i][j];
      pos.push(p.x, p.y, p.z);
      uvs.push(...(uvFn ? uvFn(i, j) : [j / Math.max(1, C - 1), i / Math.max(1, R - 1)]));
    }
  }
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < C - 1; j++) {
      const a = i * C + j, b = (i + 1) * C + j, c = b + 1, d = a + 1;
      idx.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Flip winding if the surface at vertex vi doesn't face `expected`. */
function orient(g, vi, expected) {
  const n = g.attributes.normal;
  if (n.getX(vi) * expected.x + n.getY(vi) * expected.y + n.getZ(vi) * expected.z < 0) {
    const ix = g.index.array;
    for (let k = 0; k < ix.length; k += 3) { const t = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = t; }
    g.index.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/**
 * Sweep a closed (or open) 2D profile along frames {o, a, b}: each profile edge is
 * its own strip, so mouldings keep crisp arrises. Profile loops are CCW in (a, b).
 */
function sweep(frames, loop, { open = false, caps = false } = {}) {
  const out = [];
  const lens = [0];
  for (let i = 1; i < frames.length; i++) lens.push(lens[i - 1] + frames[i].o.distanceTo(frames[i - 1].o));
  const pt = (f, q) => f.o.clone().addScaledVector(f.a, q[0]).addScaledVector(f.b, q[1]);
  const n = loop.length;
  for (let e = 0; e < (open ? n - 1 : n); e++) {
    const p0 = loop[e], p1 = loop[(e + 1) % n];
    const da = p1[0] - p0[0], db = p1[1] - p0[1], L = Math.hypot(da, db) || 1;
    const g = gridGeo(frames.map((f) => [pt(f, p0), pt(f, p1)]), (i, j) => [j * L, lens[i]]);
    const f0 = frames[0];
    out.push(orient(g, 0, f0.a.clone().multiplyScalar(db / L).addScaledVector(f0.b, -da / L)));
  }
  if (caps) {
    const shape = new THREE.Shape(loop.map(([a, b]) => new THREE.Vector2(a, b)));
    for (const [f, nb] of [[frames[0], frames[1]], [frames[frames.length - 1], frames[frames.length - 2]]]) {
      const g = new THREE.ShapeGeometry(shape);
      const pa = g.attributes.position;
      for (let i = 0; i < pa.count; i++) {
        const p = pt(f, [pa.getX(i), pa.getY(i)]);
        pa.setXYZ(i, p.x, p.y, p.z);
      }
      g.computeVertexNormals();
      out.push(orient(g, 0, f.o.clone().sub(nb.o).normalize()));
    }
  }
  return out;
}

/** Matrix for a vertical panel from pA to pB whose local +Z points `outward`. */
function panelMatrix(pA, pB, outward) {
  let A = pA, B = pB;
  const X = B.clone().sub(A).setY(0);
  const span = X.length();
  X.normalize();
  let Z = new THREE.Vector3().crossVectors(X, UP);
  if (outward && Z.dot(outward) < 0) { [A, B] = [B, A]; X.negate(); Z.negate(); }
  return { m: new THREE.Matrix4().makeBasis(X, UP, Z).setPosition(A.x, 0, A.z), span, X, Z, A };
}

function archPath(P, cx, y0, r, spring) {
  const p = new P();
  p.moveTo(cx - r, y0);
  p.lineTo(cx + r, y0);
  p.lineTo(cx + r, spring);
  p.absarc(cx, spring, r, 0, Math.PI, false);
  p.lineTo(cx - r, y0);
  return p;
}

/** Points of an arched opening's inner outline (for lights/beams). */
function archOutline(cx, y0, r, spring, n = 24) {
  const pts = [V(cx + r, y0, 0), V(cx + r, spring, 0)];
  for (let k = 1; k < n; k++) {
    const a = (k / n) * Math.PI;
    pts.push(V(cx + r * Math.cos(a), spring + r * Math.sin(a), 0));
  }
  pts.push(V(cx - r, spring, 0), V(cx - r, y0, 0));
  return pts;
}

function prep(g, ao) {
  let o = g.index ? g.toNonIndexed() : g;
  if (!o.attributes.normal) o.computeVertexNormals();
  const n = o.attributes.position.count;
  if (!o.attributes.uv) o.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  for (const k of Object.keys(o.attributes)) if (!['position', 'normal', 'uv'].includes(k)) o.deleteAttribute(k);
  const col = new Float32Array(n * 3);
  const p = o.attributes.position;
  for (let i = 0; i < n; i++) {
    const a = ao ? ao(p.getY(i)) : 1;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = a;
  }
  o.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return o;
}

/* --------------------------------------------------------- components */

/** Fluted column template (base at y=0, top at H): {stone, metal, glow} geometries. */
function columnTemplate(H) {
  const rc = H * 0.075;
  const stone = [], metal = [], glow = [];
  const box = (w, h, y, list) => {
    const g = new THREE.BoxGeometry(w, h, w);
    g.translate(0, y + h / 2, 0);
    list.push(g);
  };
  const lathe = (pts, list, seg = 56) => list.push(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r * rc, y)), seg));
  box(2.9 * rc, 0.42, -0.12, stone); // bury the plinth well into the floor — no base flicker
  box(2.72 * rc, 0.05, 0.3, metal);
  lathe([[1.3, 0.35], [1.36, 0.39], [1.36, 0.45], [1.28, 0.5], [1.12, 0.52], [1.07, 0.56], [1.1, 0.6], [1.18, 0.62], [1.16, 0.66], [1.05, 0.68], [1.0, 0.72]], stone);
  // fluted shaft with entasis
  const y0 = 0.72, y1 = H - 0.92, F = 20, per = 8, segs = F * per, rows = 20;
  const pos = [], uvs = [], idx = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows, y = y0 + (y1 - y0) * t;
    const rs = rc * (1 + 0.025 * Math.sin(Math.PI * Math.min(1, t * 1.4)) - 0.1 * t * t);
    for (let j = 0; j < segs; j++) {
      const th = (j / segs) * Math.PI * 2;
      const u = (j % per) / per;
      const gr = u > 0.12 && u < 0.88 ? Math.sin(Math.PI * (u - 0.12) / 0.76) : 0;
      const r = rs * (1 - 0.07 * gr);
      pos.push(r * Math.cos(th), y, -r * Math.sin(th));
      uvs.push((j / segs) * Math.PI * 2 * rc, y);
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * segs + j, b = (i + 1) * segs + j, c = (i + 1) * segs + (j + 1) % segs, d = i * segs + (j + 1) % segs;
      idx.push(a, b, d, b, c, d);
    }
  }
  const shaft = new THREE.BufferGeometry();
  shaft.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  shaft.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  shaft.setIndex(idx);
  shaft.computeVertexNormals();
  orient(shaft, 0, V(1, 0, 0));
  stone.push(shaft);
  const rt = rc * 0.9; // top radius ≈ rs(1)
  const n0 = y1;
  lathe([[0.9, n0 - 0.02], [0.95, n0], [0.95, n0 + 0.12], [0.92, n0 + 0.12]], metal);
  const band = new THREE.CylinderGeometry(rt * 1.005, rt * 1.005, 0.07, 56, 1, true);
  band.translate(0, n0 + 0.155, 0);
  glow.push(band);
  lathe([[0.92, n0 + 0.19], [0.97, n0 + 0.24], [1.08, n0 + 0.4], [1.28, n0 + 0.56], [1.42, n0 + 0.66], [1.44, H - 0.22]], stone);
  box(3.1 * rc, 0.17, H - 0.22, stone);
  box(3.18 * rc, 0.05, H - 0.05, metal);
  const ao = (y) => 0.74 + 0.26 * smooth(0, 1.8, y);
  return {
    rc,
    stone: mergeGeometries(stone.map((g) => prep(g, ao))),
    metal: mergeGeometries(metal.map((g) => prep(g))),
    glow: mergeGeometries(glow.map((g) => prep(g))),
  };
}

/* -------------------------------------------------------------- build */

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} test   room definition (test.room, test.accent)
 * @param {Course} course
 * @param {{next?: object, lite?: boolean}} opts
 */
export function buildRoom(renderer, test, course, opts = {}) {
  const spec = test.room;
  const lite = !!opts.lite;
  const futurist = opts.style === 'future';
  const group = new THREE.Group();
  group.name = `room_${test.id}${futurist ? '_future' : ''}`;
  const accent = new THREE.Color(test.accent);
  const nextAccent = new THREE.Color(opts.next?.accent ?? '#ffffff');
  // Future reuses Classic geometry; only the palette / vault finish change.
  const lightCol = new THREE.Color(spec.light ?? (futurist ? 0xe4eaf4 : 0xfff4e6));
  const cs = futurist ? null : cofferSet();

  const mats = {
    wall: new THREE.MeshStandardMaterial(SMOOTH_SHELL
      ? { color: spec.stone ?? (futurist ? 0xc8ced8 : 0xf1eee8), roughness: futurist ? 0.42 : 0.55, metalness: futurist ? 0.06 : 0, vertexColors: true, envMapIntensity: futurist ? 0.28 : 1 }
      : { color: spec.stone ?? 0xf3f1ec, roughness: 0.6, vertexColors: true }),
    stone: Object.assign(
      new THREE.MeshStandardMaterial({
        color: spec.stone ?? (futurist ? 0xd2d8e2 : 0xf5f3ef),
        roughness: futurist ? 0.38 : 0.34, metalness: futurist ? 0.08 : 0, vertexColors: true, envMapIntensity: futurist ? 0.32 : 1,
      }),
      { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
    ),
    // Classic: coffered vault. Future: same shell, smooth lit finish (no coffer maps).
    vault: futurist
      ? new THREE.MeshStandardMaterial({
          color: spec.vault ?? 0xd8dee8, roughness: 0.4, metalness: 0.05, vertexColors: true,
          emissive: lightCol.clone().multiplyScalar(0.15), emissiveIntensity: 0.55, envMapIntensity: 0.35,
        })
      : new THREE.MeshStandardMaterial({
          color: spec.vault ?? 0xf1efea, map: cs.map, normalMap: cs.normalMap, normalScale: new THREE.Vector2(1.35, 1.35),
          roughness: 0.58, vertexColors: true,
          emissive: lightCol.clone(), emissiveMap: cs.emissiveMap, emissiveIntensity: 1.35,
        }),
    /** Smooth moulded ribs — warm stone (classic) or cool metal edge (future). */
    rib: new THREE.MeshStandardMaterial({
      color: spec.rib ?? (futurist ? 0xa8b2c0 : 0xcfc4b4),
      roughness: futurist ? 0.22 : 0.26, metalness: futurist ? 0.55 : 0.18, envMapIntensity: futurist ? 0.7 : 0.45,
    }),
    metal: new THREE.MeshStandardMaterial({
      color: spec.metal ?? (futurist ? 0xb8c2d0 : 0xd2bf9c), metalness: 1, roughness: futurist ? 0.32 : 0.45, envMapIntensity: futurist ? 0.75 : 0.55,
    }),
    dark: new THREE.MeshStandardMaterial({ color: futurist ? 0x1c222c : 0x24282c, metalness: 0.55, roughness: 0.3 }),
    // Matte on purpose: scene.environment is world-fixed while inverse locomotion
    // rotates the hall, so glossy IBL speculars slide across the path as if the
    // lights were spinning. Real reflections live on the planar floor reflector.
    deck: Object.assign(
      new THREE.MeshStandardMaterial({ color: futurist ? 0x3a424e : 0x4a5058, metalness: 0.05, roughness: 0.72, envMapIntensity: 0.15 }),
      { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 },
    ),
    glass: new THREE.MeshStandardMaterial({ color: 0xe6f2f5, roughness: 0.35, transparent: true, opacity: futurist ? 0.18 : 0.14, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.35 }),
    glow: new THREE.MeshBasicMaterial({ color: lightCol.clone().multiplyScalar(futurist ? 2.2 : 2.6) }),
    feature: new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(1.6) }),
    portal: new THREE.MeshBasicMaterial({ color: accent.clone() }),
    sky: new THREE.MeshBasicMaterial({ color: new THREE.Color(spec.sky ?? (futurist ? 0xe8eef8 : 0xfff6ea)).multiplyScalar(futurist ? 2.6 : 3.2), fog: false, side: THREE.DoubleSide }),
    vest: new THREE.MeshStandardMaterial({ color: futurist ? 0xe2e8f0 : 0xeeece7, roughness: 0.4, side: THREE.BackSide }),
    nextGlow: new THREE.MeshBasicMaterial({ color: nextAccent.clone().lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(2.2), vertexColors: true, side: THREE.DoubleSide }),
    nextLine: new THREE.MeshBasicMaterial({ color: nextAccent.clone().multiplyScalar(1.8) }),
    floor: Object.assign(
      new THREE.MeshStandardMaterial(SMOOTH_SHELL
        ? { color: spec.floorTint ?? (futurist ? 0xf0f4f8 : 0xf7f5f1), roughness: 0.14, metalness: 0.1, envMapIntensity: futurist ? 0.95 : 0.85 }
        : { color: spec.floorTint ?? 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.55 }),
      { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
    ),
    beam: new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(spec.sun ?? (futurist ? 0xe8eef8 : 0xfff0d8)) }, strength: { value: spec.beam ?? (futurist ? 0.04 : 0.055) } },
      vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform vec3 color; uniform float strength; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){ float v = clamp(vUv.y, 0.0, 1.0);
          float a = strength * pow(1.0 - v, 0.8) * smoothstep(0.0, 0.06, v);
          a *= 0.2 + 0.8 * (1.0 - clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0));
          gl_FragColor = vec4(color * a, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  };

  const B = {};
  const add = (k, ...g) => (B[k] ??= []).push(...g.flat());
  const ctx = { course, spec, add, mats, group, accent };

  const hall = spec.type === 'rotunda' ? buildRotunda(ctx) : buildNave(ctx);

  /* ---- merge buckets ---- */
  const aoWall = (y) => 0.7 + 0.3 * smooth(0, 1.6, y);
  const cfg = {
    wall: { ao: aoWall, cast: true, recv: true },
    stone: { ao: aoWall, cast: true, recv: true },
    vault: { ao: null, cast: true, recv: false },
    dome: { ao: null, cast: true, recv: false, mat: 'vault' },
    rib: { ao: null, cast: true, recv: true },
    metal: { cast: true, recv: true },
    dark: { cast: false, recv: true },
    deck: { cast: true, recv: true },
    deckSide: { cast: true, recv: true, mat: 'metal' },
    glass: {},
    glow: {},
    feature: {},
    portal: {},
    sky: {},
    vest: {},
    nextGlow: {},
    nextLine: {},
    beam: {},
  };
  for (const [k, list] of Object.entries(B)) {
    if (!list.length) continue;
    const c = cfg[k] ?? {};
    const mesh = new THREE.Mesh(mergeGeometries(list.map((g) => prep(g, c.ao))), mats[c.mat ?? k]);
    mesh.castShadow = !!c.cast && !lite;
    mesh.receiveShadow = !!c.recv && !lite;
    mesh.name = k;
    if (k === 'beam' || k === 'glass') mesh.renderOrder = 2;
    group.add(mesh);
  }

  /* ---- columns (instanced) ---- */
  if (hall.columns.length) {
    const tpl = columnTemplate(hall.colH);
    for (const [geo, mat, cast] of [[tpl.stone, mats.stone, true], [tpl.metal, mats.metal, true], [tpl.glow, mats.glow, false]]) {
      const im = new THREE.InstancedMesh(geo, mat, hall.columns.length);
      hall.columns.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = cast && !lite;
      im.receiveShadow = !lite && mat !== mats.glow;
      im.computeBoundingSphere();
      group.add(im);
    }
  }

  /* ---- floor: glossy planar reflector ---- */
  const floorMesh = new THREE.Mesh(hall.floorGeo, mats.floor);
  floorMesh.receiveShadow = !lite;
  floorMesh.name = 'floor';
  group.add(floorMesh);
  const reflector = lite ? null : new FloorReflector(floorMesh, mats.floor, {
    resolution: spec.reflRes ?? 1024, maxDist: 7, strength: spec.reflect ?? 0.82, minFresnel: 0.32, heightSharp: 0.03, heightSoft: 0.6, nearBlur: 0.1,
  });

  /* ---- sun ---- */
  const sun = new THREE.DirectionalLight(spec.sun ?? (futurist ? 0xe8eef8 : 0xfff0d8), spec.sunI ?? (futurist ? 4.2 : 5.5));
  const dir = hall.sunDir.clone().normalize();
  sun.position.copy(hall.center).addScaledVector(dir, -150);
  sun.target.position.copy(hall.center);
  group.add(sun, sun.target);
  if (!lite) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const r = hall.radius;
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 100, far: 220 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.035;
  }

  /* ---- environment captured from the hall itself ---- */
  const fogColor = new THREE.Color(spec.fog ?? (futurist ? 0xd8dee8 : 0xe9e6e1));
  const envScene = new THREE.Scene();
  envScene.background = fogColor;
  const holder = new THREE.Group();
  holder.position.set(-hall.center.x, -(hall.eyeY ?? 1.6), -hall.center.z);
  holder.add(group);
  envScene.add(holder);
  envScene.add(new THREE.HemisphereLight(0xffffff, futurist ? 0xb4bcc8 : 0xcfc8be, 1.0));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const xrOn = renderer.xr.enabled;
  renderer.xr.enabled = false;
  renderer.shadowMap.needsUpdate = true;
  if (reflector) reflector.enabled = false; // a nested capture would break PMREM's per-face viewports
  const envRT = pmrem.fromScene(envScene, 0.03, 0.1, 400);
  if (reflector) reflector.enabled = true;
  renderer.xr.enabled = xrOn;
  pmrem.dispose();
  holder.remove(group);
  renderer.shadowMap.needsUpdate = true;

  const base = { feature: mats.feature.color.clone(), portal: accent.clone(), glow: mats.glow.color.clone() };
  const room = {
    group,
    sun,
    reflector,
    envMap: envRT.texture,
    fog: new THREE.FogExp2(fogColor, spec.fogDensity ?? (futurist ? 0.009 : 0.011)),
    background: fogColor,
    exposure: spec.exposure ?? (futurist ? 1.08 : 1.0),
    hemi: spec.hemi ?? (futurist ? 0.48 : 0.35),
    portalGlow: 0,
    info: hall,
    /** Everything (sun included) moves rigidly with the lab, so the shadow map stays
     *  valid — only its matrix must follow. Call after world matrices are current. */
    beforeRender() {
      if (!lite) sun.shadow.updateMatrices(sun);
    },
    update(dt, st) {
      const q = st.quality ?? 0.5;
      if (spec.feedback === 'lean' || spec.feedback === 'steady') {
        mats.feature.color.copy(base.feature).multiplyScalar(0.55 + 0.9 * q);
      }
      const want = st.stage === 'done' ? 1 : st.stage === 'trial' ? smooth(0.7, 1, st.progress || 0) : 0.2;
      room.portalGlow += (want - room.portalGlow) * Math.min(1, dt * 2.5);
      mats.portal.color.copy(base.portal).multiplyScalar(0.7 + 2.4 * room.portalGlow);
      mats.nextLine.color.copy(nextAccent).multiplyScalar(1.0 + 1.6 * room.portalGlow);
    },
    dispose() {
      group.parent?.remove(group);
      group.traverse((o) => o.geometry?.dispose?.());
      for (const m of Object.values(mats)) m.dispose();
      reflector?.dispose();
      sun.shadow.map?.dispose();
      envRT.dispose();
    },
  };
  return room;
}

/* ------------------------------------------------- shared hall pieces */

const WALL_T = 0.7;
const ARC_T = 0.8;
const CORNICE = [[-0.56, 0], [0.56, 0], [0.56, 0.1], [0.66, 0.16], [0.7, 0.3], [0.7, 0.42], [0.62, 0.42], [0.62, 0.5], [-0.62, 0.5], [-0.62, 0.42], [-0.7, 0.42], [-0.7, 0.3], [-0.66, 0.16], [-0.56, 0.1]];
const WALL_CORNICE = [[0.01, 0], [0.22, 0], [0.3, 0.1], [0.36, 0.26], [0.58, 0.36], [0.66, 0.46], [0.66, 0.6], [0.01, 0.6]];
// Start slightly proud of the arcade face so the moulding never shares the same plane (z-fight).
const ARCHIVOLT = [[0.008, 0], [0.46, 0], [0.46, 0.05], [0.34, 0.05], [0.34, 0.09], [0.16, 0.09], [0.16, 0.12], [0.008, 0.12]];

/** Windowed wall bay between pA..pB (floor points). Returns window info for beams. */
function wallBay(ctx, pA, pB, outward, hW, { portal = null, window: win = true } = {}) {
  const { add } = ctx;
  const { m, span } = panelMatrix(pA, pB, outward);
  // Start slightly below the floor so the wall/floor joint has no hairline gap.
  const shape = new THREE.Shape([new THREE.Vector2(0, -0.05), new THREE.Vector2(span, -0.05), new THREE.Vector2(span, hW), new THREE.Vector2(0, hW)]);
  let w = null;
  if (portal) {
    shape.holes.push(archPath(THREE.Path, span / 2, portal.y0, portal.r, portal.y0 + portal.spring));
  } else if (win) {
    const ww = Math.max(0.6, Math.min(1.8, span - 2.6));
    const apex = hW - 1.5, spring = apex - ww / 2, sill = 1.5;
    if (spring - sill > 1.5) {
      shape.holes.push(archPath(THREE.Path, span / 2, sill, ww / 2, spring));
      w = { ww, sill, spring, apex };
    }
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: WALL_T, bevelEnabled: false, curveSegments: 18 });
  g.applyMatrix4(m);
  add('wall', g);
  const toWorld = (x, y, z) => V(x, y, z).applyMatrix4(m);
  let beamPts = null;
  if (w) {
    // sky glow beyond the opening + a slender bronze mullion
    const sky = new THREE.PlaneGeometry(w.ww + 1.6, w.apex - w.sill + 1.6);
    sky.translate(span / 2, (w.apex + w.sill) / 2, WALL_T + 1.4);
    sky.applyMatrix4(m);
    add('sky', sky);
    const mull = new THREE.BoxGeometry(0.06, w.apex - w.sill, 0.1);
    mull.translate(span / 2, (w.apex + w.sill) / 2, WALL_T * 0.55);
    mull.applyMatrix4(m);
    add('metal', mull);
    const tr = new THREE.BoxGeometry(w.ww, 0.06, 0.1);
    tr.translate(span / 2, w.spring, WALL_T * 0.55);
    tr.applyMatrix4(m);
    add('metal', tr);
    beamPts = [toWorld(span / 2 - w.ww / 2, w.sill, 0), toWorld(span / 2 + w.ww / 2, w.sill, 0),
      toWorld(span / 2 + w.ww / 2, w.spring + w.ww * 0.3, 0), toWorld(span / 2 - w.ww / 2, w.spring + w.ww * 0.3, 0)];
  }
  if (portal) portalDressing(ctx, m, span / 2, portal);
  return { beamPts, m, span };
}

/** Archivolt + accent line around an exit arch and the luminous vestibule beyond it. */
function portalDressing(ctx, m, cx, p) {
  const { add } = ctx;
  const R = new THREE.Matrix3().setFromMatrix4(m);
  const fr = [];
  const ptsL = archOutline(cx, p.y0, p.r, p.y0 + p.spring, 28);
  for (let i = 0; i < ptsL.length; i++) {
    const q = ptsL[i];
    const prev = ptsL[Math.max(0, i - 1)], next = ptsL[Math.min(ptsL.length - 1, i + 1)];
    const t = next.clone().sub(prev).normalize();
    const out = V(t.y, -t.x, 0); // away from the opening (outline runs CW over the top)
    fr.push({ o: q.clone().applyMatrix4(m), a: out.applyMatrix3(R).normalize(), b: V(0, 0, -1).applyMatrix3(R).normalize() });
  }
  add('metal', sweep(fr, [[0, 0], [0.5, 0], [0.5, 0.06], [0.36, 0.06], [0.36, 0.11], [0.14, 0.11], [0.14, 0.15], [0, 0.15]]));
  // accent line on the reveal edge
  add('portal', sweep(fr, [[-0.005, 0.02], [0.03, 0.02], [0.03, 0.15], [-0.005, 0.15]]));

  // vestibule: arched tunnel with light frames, ending in the next room's glow
  const Lv = p.depth ?? 16;
  const tunnel = new THREE.ExtrudeGeometry(archPath(THREE.Shape, cx, p.y0, p.r, p.y0 + p.spring), { depth: Lv, bevelEnabled: false, curveSegments: 24 });
  tunnel.translate(0, 0, WALL_T);
  tunnel.applyMatrix4(m);
  add('vest', tunnel);
  for (let z = 2.2; z < Lv - 1; z += 2.4) {
    const ring = archPath(THREE.Shape, cx, p.y0, p.r - 0.01, p.y0 + p.spring);
    ring.holes.push(archPath(THREE.Path, cx, p.y0 + 0.001, p.r - 0.07, p.y0 + p.spring));
    const g = new THREE.ShapeGeometry(ring, 24);
    g.translate(0, 0, WALL_T + z);
    g.applyMatrix4(m);
    add('nextLine', g);
  }
  const endW = p.r * 2, endH = p.spring + p.r;
  const end = new THREE.PlaneGeometry(endW, endH, 8, 8);
  const pa = end.attributes.position;
  const col = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count; i++) {
    const k = 1 - Math.min(1, Math.hypot(pa.getX(i) / (endW / 2), (pa.getY(i) + endH * 0.1) / (endH / 2)) * 0.75);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0.35 + 0.65 * k;
  }
  end.setAttribute('color', new THREE.BufferAttribute(col, 3));
  end.translate(cx, p.y0 + endH / 2, WALL_T + Lv - 0.05);
  end.applyMatrix4(m);
  add('nextGlow', end);
}

/** Arcade bay between two column centres: spandrel wall with a moulded arch. */
function arcadeBay(ctx, pA, pB, H, top, rc) {
  const { add } = ctx;
  const { m, span } = panelMatrix(pA, pB, null);
  const ri = span / 2 - rc * 1.15;
  const shape = new THREE.Shape();
  shape.moveTo(0, H);
  shape.lineTo(0, top);
  shape.lineTo(span, top);
  shape.lineTo(span, H);
  shape.lineTo(span / 2 + ri, H);
  shape.absarc(span / 2, H, ri, 0, Math.PI, false);
  shape.lineTo(0, H);
  const g = new THREE.ExtrudeGeometry(shape, { depth: ARC_T, bevelEnabled: false, curveSegments: 28 });
  g.translate(0, 0, -ARC_T / 2);
  g.applyMatrix4(m);
  add('stone', g);
  const R = new THREE.Matrix3().setFromMatrix4(m);
  for (const side of [1, -1]) {
    const fr = [];
    for (let k = 0; k <= 28; k++) {
      const a = (k / 28) * Math.PI;
      const rad = V(Math.cos(a), Math.sin(a), 0);
      fr.push({
        o: V(span / 2 + ri * rad.x, H + ri * rad.y, side * ARC_T / 2).applyMatrix4(m),
        a: rad.clone().applyMatrix3(R).normalize(),
        b: V(0, 0, side).applyMatrix3(R).normalize(),
      });
    }
    add('stone', sweep(fr, ARCHIVOLT));
  }
  // soffit light line
  const soffit = [];
  for (let k = 0; k <= 28; k++) {
    const a = (k / 28) * Math.PI;
    const r = ri - 0.03;
    soffit.push([V(span / 2 + r * Math.cos(a), H + r * Math.sin(a), -0.05).applyMatrix4(m), V(span / 2 + r * Math.cos(a), H + r * Math.sin(a), 0.05).applyMatrix4(m)]);
  }
  add('glow', orient(gridGeo(soffit), 28, V(0, -1, 0)));
  return ri;
}

function pilaster(ctx, p, tangent, inward, hW) {
  const h = hW + 0.05;
  const g = new THREE.BoxGeometry(1.0, h, 0.42);
  const Z = inward.clone().normalize();
  const X = new THREE.Vector3().crossVectors(UP, Z).normalize();
  g.applyMatrix4(new THREE.Matrix4().makeBasis(X, UP, Z).setPosition(p.x + Z.x * 0.21, h / 2 - 0.05, p.z + Z.z * 0.21));
  ctx.add('stone', g);
}

/** Additive light shafts from window openings along the sun direction. */
function beams(ctx, pts, d, floorY = 0) {
  if (!pts) return;
  // Stop short of the floor — ending on the floor plane z-fights the reflector and flickers.
  const stopY = floorY + 0.04;
  const hit = pts.map((c) => c.clone().addScaledVector(d, (c.y - stopY) / -d.y));
  for (let k = 0; k < 4; k++) {
    const a = pts[k], b = pts[(k + 1) % 4];
    const g = gridGeo([[a, b], [hit[k], hit[(k + 1) % 4]]], (i, j) => [j, i]);
    ctx.add('beam', g);
  }
}

/** Walkway along the course: flush runner when flat, floating deck with glass balustrade when elevated. */
function buildDeck(ctx, sA, sB) {
  const { course, add } = ctx;
  const fr = [];
  for (let s = sA; s <= sB + 1e-6; s += 0.25) fr.push(courseFrameAt(course, s));
  const hw = 1.5;
  const flat = course.maxY < 0.05;
  if (flat) {
    // Physical lift + polygonOffset on the deck mat — never share the floor plane.
    add('deck', orient(gridGeo(fr.map((f) => [PV(f, hw, 0.05), PV(f, -hw, 0.05)]), (i, j) => [j * 3, fr[i].s]), 0, UP));
    for (const sg of [1, -1]) {
      add('feature', orient(gridGeo(fr.map((f) => [PV(f, sg * hw, 0.056), PV(f, sg * (hw - 0.035), 0.056)])), 0, UP));
    }
    return;
  }
  const yb = (f) => Math.max(0.0, f.y - 0.42);
  add('deck', orient(gridGeo(fr.map((f) => [PV(f, hw, f.y), PV(f, -hw, f.y)]), (i, j) => [j * 3, fr[i].s]), 0, UP));
  const hb = (y) => 1.05 * smooth(0.2, 0.9, y);
  for (const sg of [1, -1]) {
    const out = (f) => lat(f).multiplyScalar(sg);
    add('deckSide', orient(gridGeo(fr.map((f) => [PV(f, sg * hw, f.y), PV(f, sg * hw, yb(f))])), 0, out(fr[0])));
    add('feature', orient(gridGeo(fr.map((f) => [PV(f, sg * (hw + 0.004), f.y - 0.05), PV(f, sg * (hw + 0.004), f.y - 0.085)])), 0, out(fr[0])));
    add('glass', gridGeo(fr.map((f) => [PV(f, sg * (hw - 0.06), f.y), PV(f, sg * (hw - 0.06), f.y + hb(f.y))])));
    // handrail only where the balustrade has grown
    let run = [];
    const flush = () => {
      if (run.length > 2) add('metal', sweep(run, [[-0.025, 0], [0.025, 0], [0.025, 0.05], [-0.025, 0.05]], { caps: true }));
      run = [];
    };
    for (const f of fr) {
      if (hb(f.y) > 0.04) run.push({ o: PV(f, sg * (hw - 0.06), f.y + hb(f.y)), a: lat(f), b: UP.clone() });
      else flush();
    }
    flush();
  }
  add('stone', orient(gridGeo(fr.map((f) => [PV(f, -hw, yb(f)), PV(f, hw, yb(f))])), 0, V(0, -1, 0)));
  // No centre-line pylons — they sit in the walk path and read as ringed pillars in the way.
}

/* --------------------------------------------------------------- nave */

function buildNave(ctx) {
  const { course, spec, add } = ctx;
  const bay = spec.bay ?? 5;
  const Wo = Math.min(spec.Wo ?? 8.2, Number.isFinite(course.minRadius) ? course.minRadius * 0.5 : 99);
  const Wc = Wo * 0.56;
  const H = spec.colH ?? 7.2;
  const rc = H * 0.075;
  const attic = 1.25;
  const riNom = bay / 2 - rc * 1.15;
  const top = H + riNom + attic;
  const hW = top;
  const rise = Wo * 0.72;
  const L = course.length;
  const kA = -Math.ceil(7 / bay), kB = Math.ceil((L + 6) / bay);
  const F = [];
  for (let k = kA; k <= kB; k++) F.push(courseFrameAt(course, k * bay));
  const last = F.length - 1;

  // floor (ruled between bay frames, so its edge matches the planar wall bays)
  const lerpRows = (fn, sub) => {
    const rows = [];
    for (let i = 0; i < last; i++) {
      const a = fn(F[i]), b = fn(F[i + 1]);
      for (let t = 0; t < sub; t++) rows.push(a.map((p, j) => p.clone().lerp(b[j], t / sub)));
    }
    rows.push(fn(F[last]));
    return rows;
  };
  const floorCols = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1].map((u) => u * Wo);
  const floorRows = lerpRows((f) => floorCols.map((u) => PV(f, u, 0)), 4);
  const floorGeo = orient(gridGeo(floorRows, (i, j) => { const p = floorRows[i][j]; return [p.x, p.z]; }), 0, UP);

  // outer walls with arched windows, pilasters, cornices, skirting
  const sunDir = (() => {
    const fm = courseFrameAt(course, L / 2);
    const el = (spec.sunEl ?? 28) * Math.PI / 180;
    return lat(fm).multiplyScalar(-0.75 * Math.cos(el)).addScaledVector(tan(fm), 0.65 * Math.cos(el)).addScaledVector(UP, -Math.sin(el)).normalize();
  })();
  for (const sg of [1, -1]) {
    for (let i = 0; i < last; i++) {
      const out = lat(F[i]).add(lat(F[i + 1])).multiplyScalar(sg).normalize();
      const { beamPts } = wallBay(ctx, PV(F[i], sg * Wo, 0), PV(F[i + 1], sg * Wo, 0), out, hW);
      if (beamPts && out.dot(sunDir) < -0.15) beams(ctx, beamPts, sunDir);
    }
    for (let i = 1; i < last; i++) pilaster(ctx, PV(F[i], sg * Wo, 0), tan(F[i]), lat(F[i]).multiplyScalar(-sg), hW);
    const inward = (f) => lat(f).multiplyScalar(-sg);
    add('stone', sweep(F.map((f) => ({ o: PV(f, sg * Wo, hW - 0.6), a: inward(f), b: UP.clone() })), WALL_CORNICE, { open: true }));
    add('glow', orient(gridGeo(F.map((f) => [PV(f, sg * (Wo - 0.72), hW - 0.14), PV(f, sg * (Wo - 0.72), hW - 0.08)])), 0, inward(F[0])));
    // Soft plinth (not near-black — that read as a floor gap). Proud of the wall, never coplanar.
    if (!SMOOTH_SHELL) {
      add('dark', sweep(F.map((f) => ({ o: PV(f, sg * Wo, 0), a: inward(f), b: UP.clone() })), [[0.01, 0], [0.06, 0], [0.06, 0.28], [0.01, 0.28]], { open: true }));
    }
  }

  // colonnades + arcades + cornice
  const columns = [];
  for (const sg of [1, -1]) {
    const tops = [];
    for (let i = 1; i < last; i++) {
      const f = F[i];
      const p = PV(f, sg * Wc, 0);
      const rot = Math.atan2(f.tx, f.tz);
      columns.push(new THREE.Matrix4().makeRotationY(rot).setPosition(p.x, 0, p.z));
      tops.push({ o: PV(f, sg * Wc, top), a: lat(f), b: UP.clone() });
      if (i < last - 1) arcadeBay(ctx, p, PV(F[i + 1], sg * Wc, 0), H, top, rc);
    }
    add('stone', sweep(tops, CORNICE, { caps: true }));
  }

  // coffered barrel vault (ruled per bay) + lit transverse ribs + crown light
  const NV = 32;
  const section = (f) => {
    const c = PV(f, 0, hW), l = lat(f);
    const pts = [];
    for (let j = 0; j <= NV; j++) {
      const a = (j / NV) * Math.PI;
      pts.push(c.clone().addScaledVector(l, Wo * Math.cos(a)).addScaledVector(UP, rise * Math.sin(a)));
    }
    return pts;
  };
  const s0 = section(F[0]);
  let arc = 0;
  const arcAt = [0];
  for (let j = 1; j <= NV; j++) { arc += s0[j].distanceTo(s0[j - 1]); arcAt.push(arc); }
  // ~bay/3.2 metres per coffer cell — dense enough to read from the walkway.
  const cellU = arc / Math.max(1, Math.round(arc / (bay / 3.2)));
  const SUB = 6;
  const vaultRows = lerpRows(section, SUB);
  const vault = gridGeo(vaultRows, (i, j) => [arcAt[j] / cellU, (i / SUB) * 5]);
  add('vault', orient(vault, NV / 2, V(0, -1, 0)));
  // Transverse moulded ribs (smooth stone) + a light channel on the soffit face.
  for (let i = 1; i < last; i++) {
    const f = F[i], c = PV(f, 0, hW), l = lat(f);
    const fr = [];
    for (let j = 0; j <= NV; j++) {
      const a = (j / NV) * Math.PI;
      const o = c.clone().addScaledVector(l, Wo * Math.cos(a)).addScaledVector(UP, rise * Math.sin(a));
      const nrm = l.clone().multiplyScalar(-Math.cos(a) / Wo).addScaledVector(UP, -Math.sin(a) / rise).normalize();
      fr.push({ o, a: nrm, b: tan(f) });
    }
    add('rib', sweep(fr, RIB_LOOP, { open: false }));
    // Glow sits in a recess on the rib face — never coplanar with the vault.
    add('glow', sweep(fr.map((q) => ({ ...q, o: q.o.clone().addScaledVector(q.a, 0.69) })), [[0, -0.055], [0.025, -0.055], [0.025, 0.055], [0, 0.055]], { open: false }));
  }

  // end walls with open arched portals + vestibules
  const yEnd = Math.max(0, courseFrameAt(course, kB * bay).y);
  const yStart = Math.max(0, courseFrameAt(course, kA * bay).y);
  for (const [f, outward, y0, isExit] of [[F[last], tan(F[last]), yEnd, true], [F[0], tan(F[0]).negate(), yStart, false]]) {
    const l = lat(f);
    let X = l.clone();
    let Z = new THREE.Vector3().crossVectors(X, UP);
    if (Z.dot(outward) < 0) { X.negate(); Z.negate(); }
    const m = new THREE.Matrix4().makeBasis(X, UP, Z).setPosition(f.x, 0, f.z);
    const outline = new THREE.Shape();
    outline.moveTo(-Wo, -0.05);
    outline.lineTo(Wo, -0.05);
    outline.lineTo(Wo, hW);
    for (let j = 1; j <= NV; j++) {
      const a = (j / NV) * Math.PI;
      outline.lineTo(Wo * Math.cos(a), hW + rise * Math.sin(a));
    }
    outline.lineTo(-Wo, 0);
    const p = { y0, r: 2.3, spring: 4.6, depth: isExit ? 18 : 10 };
    outline.holes.push(archPath(THREE.Path, 0, p.y0, p.r, p.y0 + p.spring));
    const g = new THREE.ExtrudeGeometry(outline, { depth: WALL_T, bevelEnabled: false, curveSegments: 24 });
    g.applyMatrix4(m);
    add('wall', g);
    portalDressing(ctx, m, 0, p);
  }

  buildDeck(ctx, kA * bay + WALL_T + 0.1, kB * bay - 0.05);

  const mid = courseFrameAt(course, L / 2);
  const ext = Math.hypot((kB - kA) * bay / 2, Wo) + 4;
  return {
    floorGeo,
    columns,
    colH: H,
    sunDir,
    center: V(mid.x, 0, mid.z),
    radius: ext,
    eyeY: 1.6 + mid.y,
    Wo,
    Wc,
    hW,
    vaultTop: hW + rise,
  };
}

/* ------------------------------------------------------------ rotunda */

function buildRotunda(ctx) {
  const { course, spec, add } = ctx;
  const L = course.length;
  const end = courseFrameAt(course, L);
  const pts = L > 0 ? course.points(96) : [{ x: 0, z: 0 }];
  // Centre on the exit ray so the exit is radial (passes between columns into the portal).
  let best = { d: 0, r: Infinity };
  for (let d = 0; d <= 16; d += 0.25) {
    const cx = end.x - end.tx * d, cz = end.z - end.tz * d;
    let r = 0;
    for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.z - cz));
    if (r < best.r - 1e-3) best = { d, r };
  }
  const C = V(end.x - end.tx * best.d, 0, end.z - end.tz * best.d);
  const H = spec.colH ?? 7.2;
  const rc = H * 0.075;
  const Rc = Math.max(spec.Rc ?? 8.5, best.r + 2.8);
  const Rp = Rc + 4.4;
  const Nb = Math.max(12, Math.round((2 * Math.PI * Rp) / 5.4 / 2) * 2);
  const step = (2 * Math.PI) / Nb;
  const Rv = Rp / Math.cos(step / 2);
  const aE = Math.atan2(end.tz, end.tx);
  const phi = (k) => aE - step / 2 + k * step;
  const at = (r, a, y = 0) => V(C.x + r * Math.cos(a), y, C.z + r * Math.sin(a));
  const chordC = 2 * Rc * Math.sin(step / 2);
  const riNom = chordC / 2 - rc * 1.15;
  const attic = 1.4;
  const top = H + riNom + attic;
  const hW = top + 0.6;
  const D = Rv * (spec.domeRatio ?? 0.78);
  const Ro = spec.oculus ?? 2.2;
  const el = (spec.sunEl ?? 70) * Math.PI / 180;
  const hdir = V(end.lx, 0, end.lz).multiplyScalar(0.7).addScaledVector(V(end.tx, 0, end.tz), 0.7).normalize();
  const sunDir = hdir.multiplyScalar(Math.cos(el)).addScaledVector(UP, -Math.sin(el)).normalize();

  // floor disc
  const floorGeo = new THREE.CircleGeometry(Rv + 0.8, 120);
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.translate(C.x, 0, C.z);
  {
    const p = floorGeo.attributes.position, uv = floorGeo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), p.getZ(i));
  }

  // walls: windows everywhere except the exit bay (portal)
  const yExit = Math.max(0, end.y);
  for (let k = 0; k < Nb; k++) {
    const a0 = phi(k), a1 = phi(k + 1), am = (a0 + a1) / 2;
    const out = V(Math.cos(am), 0, Math.sin(am));
    const isExit = k === 0;
    const { beamPts } = wallBay(ctx, at(Rv, a0), at(Rv, a1), out, hW, isExit ? { portal: { y0: yExit, r: 2.3, spring: 4.6, depth: 18 } } : {});
    if (beamPts && out.dot(sunDir) < -0.1) beams(ctx, beamPts, sunDir);
    pilaster(ctx, at(Rv, a0), V(-Math.sin(a0), 0, Math.cos(a0)), V(-Math.cos(a0), 0, -Math.sin(a0)), hW);
  }
  const ringFrames = (r, y, aFn) => {
    const fr = [];
    for (let k = 0; k <= Nb; k++) {
      const a = phi(k);
      fr.push({ o: at(r, a, y), a: aFn(a), b: UP.clone() });
    }
    return fr;
  };
  const inwardA = (a) => V(-Math.cos(a), 0, -Math.sin(a));
  add('stone', sweep(ringFrames(Rv, hW - 0.6, inwardA), WALL_CORNICE, { open: true }));
  if (!SMOOTH_SHELL) {
    add('dark', sweep(ringFrames(Rv, 0, inwardA), [[0.01, 0], [0.06, 0], [0.06, 0.28], [0.01, 0.28]], { open: true }));
  }
  {
    const rows = [];
    for (let k = 0; k <= Nb; k++) {
      const a = phi(k);
      rows.push([at(Rv - 0.665, a, hW - 0.14), at(Rv - 0.665, a, hW - 0.08)]);
    }
    add('glow', orient(gridGeo(rows), 0, inwardA(phi(0))));
    // Ledge closes the chord-wall → circular-dome gap; face +Y (never downward).
    const ledge = new THREE.RingGeometry(Rp - 0.85, Rv + 0.15, Nb * 8, 1);
    ledge.rotateX(-Math.PI / 2);
    ledge.translate(C.x, hW + 0.01, C.z);
    add('stone', ledge);
  }

  // column ring + arcade + cornice
  const columns = [];
  const tops = [];
  for (let k = 0; k <= Nb; k++) {
    const a = phi(k);
    const p = at(Rc, a);
    if (k < Nb) {
      columns.push(new THREE.Matrix4().makeRotationY(-a).setPosition(p.x, 0, p.z));
      arcadeBay(ctx, p, at(Rc, phi(k + 1)), H, top, rc);
    }
    tops.push({ o: at(Rc, a, top), a: V(Math.cos(a), 0, Math.sin(a)), b: UP.clone() });
  }
  add('stone', sweep(tops, CORNICE));

  // coffered dome with oculus + meridian ribs
  const aMax = Math.acos(Ro / Rv);
  const NA = 28, NZ = Nb * 12;
  const dPhi = step / 3;
  const merid = [];
  let v = 0;
  for (let j = 0; j <= NA; j++) {
    const a = (j / NA) * aMax;
    const r = Rv * Math.cos(a), y = hW + D * Math.sin(a);
    if (j) {
      const pr = merid[j - 1];
      v += Math.hypot(r - pr.r, y - pr.y) / ((r + pr.r) / 2 * dPhi);
    }
    merid.push({ r, y, v, a });
  }
  const domeRows = [];
  for (let i = 0; i <= NZ; i++) {
    const az = phi(0) + (i / NZ) * Math.PI * 2;
    domeRows.push(merid.map((q) => at(q.r, az, q.y)));
  }
  const dome = gridGeo(domeRows, (i, j) => [(i / NZ) * Nb * 4, merid[j].v * 1.15]);
  add('dome', orient(dome, 0, inwardA(phi(0)).add(V(0, -0.2, 0))));
  // Meridian moulded ribs — smooth stone over the coffered dome shell.
  for (let k = 0; k < Nb; k++) {
    const az = phi(k);
    const tA = V(-Math.sin(az), 0, Math.cos(az));
    const fr = merid.map((q) => {
      const nrm = V(-Math.cos(q.a) * Math.cos(az) / Rv, -Math.sin(q.a) / D, -Math.cos(q.a) * Math.sin(az) / Rv).normalize();
      return { o: at(q.r, az, q.y), a: nrm, b: tA };
    });
    add('rib', sweep(fr, DOME_RIB_LOOP));
    add('glow', sweep(fr.map((q) => ({ ...q, o: q.o.clone().addScaledVector(q.a, 0.63) })), [[0, -0.05], [0.025, -0.05], [0.025, 0.05], [0, 0.05]], { open: false }));
  }
  const yTop = hW + D * Math.sin(aMax);
  const rim = new THREE.TorusGeometry(Ro + 0.05, 0.14, 12, 96);
  rim.rotateX(Math.PI / 2);
  rim.translate(C.x, yTop, C.z);
  add('metal', rim);
  const sky = new THREE.CircleGeometry(Ro * 2.5, 48);
  sky.rotateX(Math.PI / 2);
  sky.translate(C.x, yTop + 3, C.z);
  add('sky', sky);
  // sun shaft through the oculus (stops above the floor — no coplanar end)
  {
    const ring = [];
    for (let k = 0; k <= 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const p = at(Ro * 0.92, a, yTop);
      ring.push([p, p.clone().addScaledVector(sunDir, (yTop - 0.04) / -sunDir.y)]);
    }
    add('beam', gridGeo(ring, (i, j) => [i / 32, j]));
  }
  if (L > 0 || spec.runner) buildDeck(ctx, L > 0 ? -1.2 : -2.0, L + (Rp - best.d) - 0.05);

  return {
    floorGeo,
    columns,
    colH: H,
    sunDir,
    center: C.clone(),
    radius: Rv + 3,
    eyeY: 1.6 + Math.max(0, course.maxY) * 0.5,
    Rc,
    Rp,
    hW,
    vaultTop: yTop,
  };
}
