/**
 * Mughal-inspired calibration halls — same path envelope as Classic, different language.
 *
 * Minimalist reading of Indo-Islamic court architecture (not ornate Taj pastiche):
 *  · nave     — slim octagonal piers, cusped arcade, sandstone walls with a thin
 *               inward chhajja, tall cusped openings filled with a sparse jali,
 *               smooth pointed barrel vault on thin brass ribs (no coffers).
 *  · rotunda  — pier ring + cusped arcade, onion dome with a small oculus rim.
 *
 * Same systems as Classic: sun + planar floor reflector + PMREM, open exit into a
 * lit vestibule. Lab coords: +X is the participant's left facing +Z.
 */
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { FloorReflector } from './reflector.js';
import { sandstoneSet, marbleSet, marbleFloorSet } from './textures.js';

const SMOOTH_SHELL = true;
const DEG = Math.PI / 180;

/** Flat gilt band across the vault (inward-normal, tangent). Back face buried in the shell. */
const BAND_LOOP = [[-0.06, -0.14], [0.03, -0.14], [0.03, 0.14], [-0.06, 0.14]];
/** Half-round gilt rib for the dome. */
const DOME_RIB_LOOP = [[-0.06, -0.15], [0.08, -0.15], [0.15, -0.07], [0.15, 0.07], [0.08, 0.15], [-0.06, 0.15]];

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

/** Apex height above spring for a pointed arch of half-width r. */
const pointedRise = (r) => r * Math.sqrt(3);

/* ------------------------------------------------- multifoil arch kit */

const FOIL_SEG = 9;
/** Even foil count (so the apex is a clean cusp) from the opening half-width. */
const foilsFor = (r) => (r > 1.9 ? 10 : r > 1.3 ? 8 : r > 0.8 ? 6 : 4);
/** Scallop = a true circular segment: zero at both cusps, 1 at mid-lobe, sharp ~42° cusps. */
const FOIL_K = 0.94;
const FOIL_E = Math.sqrt(1 - FOIL_K * FOIL_K);
const foilBulge = (f) => {
  const u = (2 * f - 1) * FOIL_K;
  return (Math.sqrt(Math.max(0, 1 - u * u)) - FOIL_E) / (1 - FOIL_E);
};
/** Sagitta of one foil for an opening of half-width r. */
const foilAmp = (r, foils = foilsFor(r)) => ((2 * r * Math.PI) / 3 / (foils / 2)) * 0.34;

/**
 * Equilateral pointed arch (right spring → apex → left spring), optionally grown by a
 * constant offset `m` (concentric arcs, so the band keeps its width at the crown).
 * Normals point out of the opening, into the masonry.
 */
function baseArch(cx, spring, r, perHalf, m = 0) {
  const R = 2 * r + m;
  const aMax = Math.acos(r / R);
  const out = [];
  for (let k = 0; k <= perHalf; k++) {
    const a = (k / perHalf) * aMax;
    out.push({ x: cx - r + R * Math.cos(a), y: spring + R * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
  }
  for (let k = 1; k <= perHalf; k++) {
    const a = Math.PI - aMax + (k / perHalf) * aMax;
    out.push({ x: cx + r + R * Math.cos(a), y: spring + R * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
  }
  return out;
}

/**
 * Cusped (multifoil) soffit: the pointed arch with circular scallops bulging into the
 * masonry and sharp points between them. Polyline only — chained absarc joins leave a
 * slit in ExtrudeGeometry. The apex is index floor(length / 2) and is never displaced.
 */
function pointedSoffit(cx, spring, r, foils = foilsFor(r), ampScale = 1) {
  const perHalf = (foils / 2) * FOIL_SEG;
  const amp = foilAmp(r, foils) * ampScale;
  return baseArch(cx, spring, r, perHalf).map((q, i) => {
    const kk = i <= perHalf ? i : i - perHalf;
    const f = (kk % FOIL_SEG) / FOIL_SEG;
    const b = f === 0 ? 0 : amp * foilBulge(f);
    return { x: q.x + q.nx * b, y: q.y + q.ny * b, nx: q.nx, ny: q.ny };
  });
}

/**
 * Flat marble band that hugs a cusped opening: outer edge = plain arch grown by a constant
 * margin past the scallops, inner edge = the cusped soffit. Open at the bottom (jambs run
 * down to y0), or closed with a sill when `sill` is given. Extruded 0 → depth in local +Z.
 */
function openingFrame(cx, y0, r, spring, { margin = 0.24, depth = 0.05, sill = 0 } = {}) {
  const m = foilAmp(r) + margin;
  const outer = baseArch(cx, spring, r, 28, m);
  const inner = pointedSoffit(cx, spring, r);
  const shape = new THREE.Shape();
  const yb = sill ? y0 - sill : y0;
  shape.moveTo(cx + r + m, yb);
  shape.lineTo(cx + r + m, spring);
  for (const q of outer) shape.lineTo(q.x, q.y);
  shape.lineTo(cx - r - m, yb);
  if (sill) {
    shape.lineTo(cx + r + m, yb);
    const hole = new THREE.Path();
    hole.moveTo(cx + r, y0);
    hole.lineTo(cx + r, spring);
    for (const q of inner) hole.lineTo(q.x, q.y);
    hole.lineTo(cx - r, y0);
    hole.lineTo(cx + r, y0);
    shape.holes.push(hole);
  } else {
    shape.lineTo(cx - r, yb);
    shape.lineTo(cx - r, spring);
    for (let i = inner.length - 1; i >= 0; i--) shape.lineTo(inner[i].x, inner[i].y);
    shape.lineTo(cx + r, spring);
    shape.lineTo(cx + r, yb);
  }
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
}

/** Hexagonal jali: rectangular marble panel pierced by a flat-top hex lattice. Local XY, z 0 → depth. */
function jaliPanel(w, h, depth = 0.1, Rc = 0.17) {
  const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(w, 0), new THREE.Vector2(w, h), new THREE.Vector2(0, h)]);
  const frame = 0.16;
  const Rh = Rc * 0.78;
  const colStep = 1.5 * Rc, rowStep = Math.sqrt(3) * Rc;
  const x0 = frame + Rh, x1 = w - frame - Rh;
  const ncol = Math.max(1, Math.floor((x1 - x0) / colStep) + 1);
  const xOff = (x0 + x1) / 2 - ((ncol - 1) * colStep) / 2;
  for (let i = 0; i < ncol; i++) {
    const cx = xOff + i * colStep;
    const yStart = frame + rowStep * 0.5 + (i % 2 ? rowStep / 2 : 0);
    for (let cy = yStart; cy + rowStep * 0.5 <= h - frame; cy += rowStep) {
      const hole = new THREE.Path();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const px = cx + Rh * Math.cos(a), py = cy + Rh * Math.sin(a);
        if (k) hole.lineTo(px, py); else hole.moveTo(px, py);
      }
      hole.closePath();
      shape.holes.push(hole);
    }
  }
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
}

/** Eight-pointed star outline (brass inlay), local XY facing +Z. */
function starRing(R, width, points = 8) {
  const ring = (rr) => {
    const pts = [];
    for (let i = 0; i < points * 2; i++) {
      const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
      const q = i % 2 ? rr * 0.62 : rr;
      pts.push(new THREE.Vector2(q * Math.cos(a), q * Math.sin(a)));
    }
    return pts;
  };
  const shape = new THREE.Shape(ring(R));
  shape.holes.push(new THREE.Path(ring(R - width)));
  return new THREE.ShapeGeometry(shape);
}

/**
 * Equilateral pointed arch opening path (two centres). Span = 2r; apex at spring + r√3.
 * Polyline — never chain absarc on a Shape/Path (triangulator leaves a slit at the join).
 */
function archPath(P, cx, y0, r, spring, ampScale = 1) {
  const p = new P();
  const L = cx - r, Rgt = cx + r;
  const soffit = pointedSoffit(cx, spring, r, foilsFor(r), ampScale);
  p.moveTo(L, y0);
  p.lineTo(Rgt, y0);
  p.lineTo(Rgt, spring);
  for (const q of soffit) p.lineTo(q.x, q.y);
  p.lineTo(L, y0);
  return p;
}

/**
 * Merge-ready copy of a geometry: position / normal / uv / colour (AO) only.
 * `crease` (radians) re-derives normals so soffits and lathes read smooth while real
 * edges (cusps, wall corners, pier facets) stay crisp.
 */
function prep(g, ao, crease = 0) {
  let o = g.index ? g.toNonIndexed() : g;
  if (crease) o = toCreasedNormals(o, crease);
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

/**
 * Mughal pier (base y=0, top y=H): squared plinth, inverted-lotus base, crisp faceted octagonal
 * shaft with brass inlay bands, lotus-bell capital, serpentine bracket arms carrying the arches.
 * Returns {stone, metal, glow} merged geometries.
 */
function pierTemplate(H) {
  const rc = H * 0.062;
  const stone = [], metal = [], glow = [];
  const box = (w, h, y, list, d = w) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, y + h / 2, 0);
    list.push(g);
  };
  const lathe = (pts, list, seg = 16) => list.push(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r * rc, y)), seg));
  /** Octagonal prism with flat faces on the hall axes; `a` = apothem (in rc). */
  const prism = (aBot, aTop, ya, yb, list) => {
    const k = 1 / Math.cos(Math.PI / 8);
    const g = new THREE.CylinderGeometry(aTop * k * rc, aBot * k * rc, yb - ya, 8, 1, false);
    g.rotateY(Math.PI / 8);
    g.translate(0, (ya + yb) / 2, 0);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2.9, uv.getY(i) * (yb - ya));
    list.push(g);
  };

  const y1 = H - 0.92;
  box(2.5 * rc, 0.34, -0.1, stone);
  box(2.4 * rc, 0.03, 0.24, metal);
  lathe([[1.2, 0.24], [1.26, 0.33], [1.24, 0.44], [1.12, 0.58], [1.0, 0.72], [0.98, 0.86]], stone);
  prism(0.98, 0.92, 0.86, y1, stone);
  prism(1.0, 1.0, 1.45, 1.5, metal);
  prism(0.96, 0.96, y1 - 0.5, y1 - 0.45, metal);
  prism(0.945, 0.945, y1 - 0.07, y1 - 0.03, glow);
  lathe([[1.0, y1], [1.04, y1 + 0.08], [1.14, y1 + 0.22], [1.26, y1 + 0.4], [1.34, y1 + 0.58], [1.34, y1 + 0.75]], stone);
  box(3.5 * rc, 0.13, H - 0.17, stone);
  box(3.6 * rc, 0.04, H - 0.04, metal);

  // Serpentine (ogee) bracket arms along the arch axis (local ±Z).
  const L = 1.75 * rc, T = H - 0.17, w = 1.1 * rc;
  const arm = new THREE.Shape();
  arm.moveTo(0, T);
  arm.lineTo(L, T);
  arm.lineTo(L, T - 0.08);
  for (let i = 1; i <= 14; i++) {
    const s = i / 14;
    arm.lineTo(L * (1 - s), T - 0.08 - 0.62 * (s - 0.11 * Math.sin(2 * Math.PI * s)));
  }
  arm.lineTo(0, T);
  for (const sg of [1, -1]) {
    const g = new THREE.ExtrudeGeometry(arm, { depth: w, bevelEnabled: false, curveSegments: 1 });
    g.translate(0, 0, -w / 2);
    g.rotateY(sg * Math.PI / 2);
    stone.push(g);
  }

  const ao = (y) => 0.8 + 0.2 * smooth(0, 1.8, y);
  const crease = 35 * DEG;
  return {
    rc,
    stone: mergeGeometries(stone.map((g) => prep(g, ao, crease))),
    metal: mergeGeometries(metal.map((g) => prep(g, null, crease))),
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
export function buildMughalRoom(renderer, test, course, opts = {}) {
  const spec = test.room;
  const lite = !!opts.lite;
  const group = new THREE.Group();
  group.name = `room_mughal_${test.id}`;
  const accent = new THREE.Color(test.accent);
  const nextAccent = new THREE.Color(opts.next?.accent ?? '#ffffff');
  // Warm court light — sandstone / marble, soft gold sun (not Classic cream coffers).
  const lightCol = new THREE.Color(spec.light ?? 0xfff1dc);

  const mats = {
    // Soft red sandstone shell vs white-marble vault/floor — quiet Fatehpur / Agra court read.
    // Red sandstone shell with dressed courses; white marble for piers, arches, jali, dado.
    wall: new THREE.MeshStandardMaterial({
      color: 0xffffff, ...sandstoneSet(), normalScale: new THREE.Vector2(0.65, 0.65),
      roughness: 0.72, metalness: 0, vertexColors: true, envMapIntensity: 1.05,
    }),
    stone: Object.assign(
      new THREE.MeshStandardMaterial({
        color: 0xffffff, ...marbleSet(),
        roughness: 0.28, metalness: 0.02, vertexColors: true, envMapIntensity: 1.15,
      }),
      { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
    ),
    // Smooth marble vault — soft self-fill so curved bays don't fall to silhouette.
    vault: new THREE.MeshStandardMaterial({
      color: spec.vault ?? 0xf6eee4, roughness: 0.48, metalness: 0.02, vertexColors: true,
      emissive: lightCol.clone().multiplyScalar(0.38), emissiveIntensity: 1.15, envMapIntensity: 0.85,
    }),
    /** Thin brass / gilt ribs. */
    rib: new THREE.MeshStandardMaterial({
      color: spec.rib ?? 0xc4a574,
      roughness: 0.28, metalness: 0.72, envMapIntensity: 0.65,
    }),
    metal: new THREE.MeshStandardMaterial({
      color: spec.metal ?? 0xb8955a, metalness: 1, roughness: 0.38, envMapIntensity: 0.7,
    }),
    dark: new THREE.MeshStandardMaterial({ color: 0x3a342c, metalness: 0.35, roughness: 0.4 }),
    // Matte on purpose: scene.environment is world-fixed while inverse locomotion
    // rotates the hall, so glossy IBL speculars slide across the path as if the
    // lights were spinning. Real reflections live on the planar floor reflector.
    deck: Object.assign(
      new THREE.MeshStandardMaterial({ color: 0x5a5046, metalness: 0.05, roughness: 0.72, envMapIntensity: 0.15 }),
      { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 },
    ),
    glass: new THREE.MeshStandardMaterial({ color: 0xe8f0f2, roughness: 0.35, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.35 }),
    glow: new THREE.MeshBasicMaterial({ color: lightCol.clone().multiplyScalar(2.35) }),
    feature: new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(1.55) }),
    portal: new THREE.MeshBasicMaterial({ color: accent.clone() }),
    sky: new THREE.MeshBasicMaterial({ color: new THREE.Color(spec.sky ?? 0xfff4e4).multiplyScalar(3.0), fog: false, side: THREE.DoubleSide }),
    vest: new THREE.MeshStandardMaterial({ color: 0xf2ebe2, roughness: 0.42, side: THREE.BackSide }),
    nextGlow: new THREE.MeshBasicMaterial({ color: nextAccent.clone().lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(2.2), vertexColors: true, side: THREE.DoubleSide }),
    nextLine: new THREE.MeshBasicMaterial({ color: nextAccent.clone().multiplyScalar(1.8) }),
    floor: Object.assign(
      new THREE.MeshStandardMaterial({
        color: 0xffffff, ...marbleFloorSet(), normalScale: new THREE.Vector2(0.6, 0.6),
        roughness: 0.14, metalness: 0.08, envMapIntensity: 0.9,
      }),
      { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
    ),
    jali: new THREE.MeshStandardMaterial({
      color: 0xffffff, ...marbleSet(), roughness: 0.34, metalness: 0.02, vertexColors: true, envMapIntensity: 1.0,
    }),
    beam: new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(spec.sun ?? 0xffe8c8) }, strength: { value: spec.beam ?? 0.05 } },
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
    // crease: soffits / reveals read smooth, cusps and wall corners stay crisp.
    wall: { ao: aoWall, cast: true, recv: true, crease: 35 * DEG },
    stone: { ao: aoWall, cast: true, recv: true, crease: 35 * DEG },
    jali: { ao: aoWall, cast: true, recv: true },
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
    vest: { crease: 35 * DEG },
    nextGlow: {},
    nextLine: {},
    beam: {},
  };
  for (const [k, list] of Object.entries(B)) {
    if (!list.length) continue;
    const c = cfg[k] ?? {};
    const mesh = new THREE.Mesh(mergeGeometries(list.map((g) => prep(g, c.ao, c.crease))), mats[c.mat ?? k]);
    mesh.castShadow = !!c.cast && !lite;
    mesh.receiveShadow = !!c.recv && !lite;
    mesh.name = k;
    if (k === 'beam' || k === 'glass') mesh.renderOrder = 2;
    group.add(mesh);
  }

  /* ---- columns (instanced) ---- */
  if (hall.columns.length) {
    const tpl = pierTemplate(hall.colH);
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
  const sun = new THREE.DirectionalLight(spec.sun ?? 0xffe8c8, spec.sunI ?? 5.8);
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

  /* ---- environment ----
   * Skip hall PMREM. Glossy/normal-mapped marble (and some curved-hall captures) inject
   * NaN into the probe; PMREM blur spreads it and every MeshStandardMaterial goes black
   * while BasicMaterials look fine. Hemi + sun + vault emissive fill the room; the planar
   * floor reflector carries real reflections. */
  const fogColor = new THREE.Color(spec.fog ?? 0xe9e0d4);
  renderer.shadowMap.needsUpdate = true;

  const base = { feature: mats.feature.color.clone(), portal: accent.clone(), glow: mats.glow.color.clone() };
  const room = {
    group,
    sun,
    reflector,
    envMap: null,
    fog: new THREE.FogExp2(fogColor, spec.fogDensity ?? 0.007),
    background: fogColor,
    exposure: spec.exposure ?? 1.12,
    hemi: spec.hemi ?? 0.9,
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
    },
  };
  return room;
}

/* ------------------------------------------------- shared hall pieces */

const WALL_T = 0.7;
const ARC_T = 0.8;
/** Arcade parapet: flat marble slab with a shallow cavetto lip (symmetric about the arcade line). */
const CORNICE = [[-0.5, 0], [0.5, 0], [0.5, 0.07], [0.62, 0.13], [0.62, 0.24], [0.5, 0.24], [0.5, 0.46], [-0.5, 0.46], [-0.5, 0.24], [-0.62, 0.24], [-0.62, 0.13], [-0.5, 0.07]];
/** Chhajja: sloping stone eave bracketed out from the wall (profile along the inward normal / up). */
const WALL_CORNICE = [[0.01, 0], [0.12, 0], [0.2, 0.16], [0.64, 0.16], [0.64, 0.3], [0.2, 0.3], [0.14, 0.62], [0.01, 0.62]];
/** Marble dado with a stepped cap — stops below the window sills. */
const DADO = [[0.01, 0], [0.09, 0], [0.09, 1.0], [0.14, 1.0], [0.14, 1.06], [0.09, 1.1], [0.01, 1.1]];

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
    const half = ww / 2;
    const apex = hW - 1.5, spring = apex - pointedRise(half), sill = 1.5;
    if (spring - sill > 1.5) {
      shape.holes.push(archPath(THREE.Path, span / 2, sill, half, spring));
      w = { ww, sill, spring, apex };
    }
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: WALL_T, bevelEnabled: false, curveSegments: 18 });
  g.applyMatrix4(m);
  add('wall', g);
  const toWorld = (x, y, z) => V(x, y, z).applyMatrix4(m);
  let beamPts = null;
  if (w) {
    // sky glow beyond the opening
    const rise = pointedRise(w.ww / 2);
    const sky = new THREE.PlaneGeometry(w.ww + 1.6, w.apex - w.sill + rise + 1.2);
    sky.translate(span / 2, (w.apex + w.sill + rise * 0.35) / 2, WALL_T + 1.4);
    sky.applyMatrix4(m);
    add('sky', sky);
    // Marble surround on the room face: scalloped inner edge, constant-width outer arch, sill.
    const frame = openingFrame(span / 2, w.sill, w.ww / 2, w.spring, { margin: 0.2, depth: 0.07, sill: 0.2 });
    frame.translate(0, 0, -0.06);
    frame.applyMatrix4(m);
    add('stone', frame);
    // Hex jali filling the rectangular light up to the springing; the cusped head stays open.
    const jh = w.spring - w.sill + 0.04;
    const jali = jaliPanel(w.ww + 0.04, jh, 0.12);
    jali.translate(span / 2 - w.ww / 2 - 0.02, w.sill - 0.02, WALL_T * 0.42);
    jali.applyMatrix4(m);
    add('jali', jali);
    beamPts = [toWorld(span / 2 - w.ww / 2, w.sill, 0), toWorld(span / 2 + w.ww / 2, w.sill, 0),
      toWorld(span / 2 + w.ww / 2, w.spring + rise * 0.45, 0), toWorld(span / 2 - w.ww / 2, w.spring + rise * 0.45, 0)];
  }
  if (portal) portalDressing(ctx, m, span / 2, portal);
  return { beamPts, m, span };
}

/** Marble surround + thin accent line around an exit arch, and the luminous vestibule beyond it. */
function portalDressing(ctx, m, cx, p) {
  const { add } = ctx;
  const springY = p.y0 + p.spring;
  // Marble band on the room face: scalloped inner edge, constant-width outer arch.
  const frame = openingFrame(cx, p.y0, p.r, springY, { margin: 0.34, depth: 0.08 });
  frame.translate(0, 0, -0.07);
  frame.applyMatrix4(m);
  add('stone', frame);
  // Accent line hugging the cusped edge (glows as the ride completes).
  const acc = archPath(THREE.Shape, cx, p.y0, p.r + 0.05, springY);
  acc.holes.push(archPath(THREE.Path, cx, p.y0 + 0.002, p.r, springY));
  const accGeo = orient(new THREE.ShapeGeometry(acc), 0, V(0, 0, -1));
  accGeo.translate(0, 0, -0.072);
  accGeo.applyMatrix4(m);
  add('portal', accGeo);

  // vestibule: arched tunnel with light frames, ending in the next room's glow
  // The scallops belong to the doorway; the vault behind it is plain. Loft the cusped outline
  // (matching the wall hole at z = WALL_T) into a plain pointed arch over the first 1.6 m.
  const Lv = p.depth ?? 16;
  const section = (ampScale) => [
    V(cx + p.r, p.y0, 0),
    ...pointedSoffit(cx, springY, p.r, foilsFor(p.r), ampScale).map((q) => V(q.x, q.y, 0)),
    V(cx - p.r, p.y0, 0),
  ];
  // Scallops end at the wall face: a thin bevel steps out to the plain vault behind (no fan).
  const stations = [
    { z: WALL_T, a: 1 },
    { z: WALL_T + 0.05, a: 0 },
    { z: WALL_T + Lv, a: 0 },
  ];
  const rows = stations.map(({ z, a }) => section(a).map((v) => v.setZ(z)));
  const tunnel = orient(gridGeo(rows), Math.floor(rows[0].length / 2), UP);
  tunnel.applyMatrix4(m);
  add('vest', tunnel);
  for (let z = 2.2; z < Lv - 1; z += 2.4) {
    const ring = archPath(THREE.Shape, cx, p.y0, p.r - 0.01, springY, 0);
    ring.holes.push(archPath(THREE.Path, cx, p.y0 + 0.001, p.r - 0.07, springY, 0));
    const g = new THREE.ShapeGeometry(ring);
    g.translate(0, 0, WALL_T + z);
    g.applyMatrix4(m);
    add('nextLine', g);
  }
  // Glow must follow the pointed opening — a rectangle sticks through the soffit as a stray face.
  const end = archPath(THREE.Shape, cx, p.y0, p.r * 0.98, springY, 0);
  const endGeo = new THREE.ShapeGeometry(end);
  const pa = endGeo.attributes.position;
  const col = new Float32Array(pa.count * 3);
  const endH = p.spring + pointedRise(p.r);
  for (let i = 0; i < pa.count; i++) {
    const k = 1 - Math.min(1, Math.hypot((pa.getX(i) - cx) / p.r, (pa.getY(i) - p.y0) / endH) * 0.75);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0.35 + 0.65 * k;
  }
  endGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  endGeo.translate(0, 0, WALL_T + Lv - 0.05);
  endGeo.applyMatrix4(m);
  add('nextGlow', endGeo);
}

/** Arcade bay between two pier centres: spandrel with a moulded pointed arch. */
function arcadeBay(ctx, pA, pB, H, top, rc) {
  const { add } = ctx;
  const { m, span } = panelMatrix(pA, pB, null);
  // Spring inside the capital so the spandrel buries into the pier (no hairline gap).
  const ri = Math.max(0.55, span / 2 - rc * 1.55);
  const soffit = pointedSoffit(span / 2, H, ri);
  const mid = Math.floor(soffit.length / 2); // apex index
  const apex = soffit[mid];
  // Two half-spandrels overlapping past the apex — avoids a coplanar shared face (z-fight).
  const overlap = 0.05;
  for (const side of ['R', 'L']) {
    const xJoin = side === 'R' ? apex.x - overlap : apex.x + overlap;
    const xEdge = side === 'R' ? span : 0;
    const shape = new THREE.Shape();
    shape.moveTo(xJoin, apex.y);
    shape.lineTo(apex.x, apex.y);
    if (side === 'R') {
      for (let i = mid - 1; i >= 0; i--) shape.lineTo(soffit[i].x, soffit[i].y);
    } else {
      for (let i = mid + 1; i < soffit.length; i++) shape.lineTo(soffit[i].x, soffit[i].y);
    }
    shape.lineTo(xEdge, H);
    shape.lineTo(xEdge, top);
    shape.lineTo(xJoin, top);
    shape.lineTo(xJoin, apex.y);
    const g = new THREE.ExtrudeGeometry(shape, { depth: ARC_T, bevelEnabled: false, curveSegments: 1 });
    g.translate(0, 0, -ARC_T / 2);
    g.applyMatrix4(m);
    add('stone', g);
  }
  // Scalloped marble band on both faces of the spandrel (buried 1 cm so it never z-fights).
  for (const z of [ARC_T / 2 - 0.01, -ARC_T / 2 - 0.05]) {
    const band = openingFrame(span / 2, H, ri, H, { margin: 0.26, depth: 0.06 });
    band.translate(0, 0, z);
    band.applyMatrix4(m);
    add('stone', band);
  }
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
  const attic = 1.4;
  const riNom = Math.max(0.55, bay / 2 - rc * 1.55);
  // Keep solid mass ABOVE the pointed apex — a razor spandrel triangulates with gaps.
  const top = H + pointedRise(riNom) + attic;
  const hW = top;
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
    add('stone', sweep(F.map((f) => ({ o: PV(f, sg * Wo, 0), a: inward(f), b: UP.clone() })), DADO, { open: true }));
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

  // Shallow elliptical barrel (a plastered Mughal hall ceiling, not a Gothic pointed vault).
  const NV = 40;
  const riseVault = Wo * 0.4;
  const vaultPt = (l, c, j) => {
    const a = (j / NV) * Math.PI;
    return c.clone()
      .addScaledVector(l, Wo * Math.cos(a))
      .addScaledVector(UP, riseVault * Math.sin(a));
  };
  const vaultNrm = (l, j) => {
    const a = (j / NV) * Math.PI;
    const dA = 1e-3;
    const a0 = Math.max(0, a - dA), a1 = Math.min(Math.PI, a + dA);
    const tx = Wo * (Math.cos(a1) - Math.cos(a0)), ty = riseVault * (Math.sin(a1) - Math.sin(a0));
    return l.clone().multiplyScalar(-ty).addScaledVector(UP, tx).normalize();
  };
  const section = (f) => {
    const c = PV(f, 0, hW), l = lat(f);
    const pts = [];
    for (let j = 0; j <= NV; j++) pts.push(vaultPt(l, c, j));
    return pts;
  };
  const s0 = section(F[0]);
  let arc = 0;
  const arcAt = [0];
  for (let j = 1; j <= NV; j++) { arc += s0[j].distanceTo(s0[j - 1]); arcAt.push(arc); }
  const cellU = arc / Math.max(1, Math.round(arc / (bay / 2.4)));
  const SUB = 6;
  const vaultRows = lerpRows(section, SUB);
  const vault = gridGeo(vaultRows, (i, j) => [arcAt[j] / cellU, (i / SUB) * 5]);
  add('vault', orient(vault, Math.floor(NV / 2), V(0, -1, 0)));
  for (let i = 1; i < last; i++) {
    const f = F[i], c = PV(f, 0, hW), l = lat(f);
    const fr = [];
    for (let j = 0; j <= NV; j++) {
      fr.push({ o: vaultPt(l, c, j), a: vaultNrm(l, j), b: tan(f) });
    }
    add('rib', sweep(fr, BAND_LOOP, { open: false }));
    add('glow', sweep(fr.map((q) => ({ ...q, o: q.o.clone().addScaledVector(q.a, 0.032) })), [[0, -0.035], [0.012, -0.035], [0.012, 0.035], [0, 0.035]], { open: false }));
  }
  // Brass-inlaid eight-point star in every bay, flat on the crown of the vault.
  for (let k = kA; k < kB; k++) {
    const fm = courseFrameAt(course, (k + 0.5) * bay);
    const star = starRing(Math.min(1.5, bay * 0.3), 0.22);
    star.rotateX(Math.PI / 2);
    star.rotateY(Math.atan2(fm.tx, fm.tz));
    star.translate(fm.x, hW + riseVault - 0.05, fm.z);
    add('rib', orient(star, 0, V(0, -1, 0)));
  }

  // end walls with open pointed portals + vestibules
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
      const p = vaultPt(V(1, 0, 0), V(0, hW, 0), j);
      outline.lineTo(p.x, p.y);
    }
    outline.lineTo(-Wo, 0);
    const p = { y0, r: 2.15, spring: 3.9, depth: isExit ? 18 : 10 };
    outline.holes.push(archPath(THREE.Path, 0, p.y0, p.r, p.y0 + p.spring));
    const g = new THREE.ExtrudeGeometry(outline, { depth: WALL_T, bevelEnabled: false, curveSegments: 28 });
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
    vaultTop: hW + riseVault,
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
  const riNom = Math.max(0.55, chordC / 2 - rc * 1.55);
  const attic = 1.4;
  // Keep solid mass ABOVE the pointed apex — a razor spandrel triangulates with gaps.
  const top = H + pointedRise(riNom) + attic;
  const hW = top + 0.55;
  const D = Rv * (spec.domeRatio ?? 0.92);
  const Ro = spec.oculus ?? 1.65;
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
    const { beamPts } = wallBay(ctx, at(Rv, a0), at(Rv, a1), out, hW, isExit ? { portal: { y0: yExit, r: 2.15, spring: 3.9, depth: 18 } } : {});
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
  // Marble dado round every bay except the exit bay (k = 0), which must stay open.
  add('stone', sweep(ringFrames(Rv, 0, inwardA).slice(1), DADO, { open: true }));
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

  // Onion dome with small oculus — bulges past the drum, then tapers to the rim.
  const NA = 30, NZ = Nb * 12;
  const dPhi = step / 3;
  const merid = [];
  let v = 0;
  for (let j = 0; j <= NA; j++) {
    const t = j / NA; // 0 at springing → 1 at oculus
    // Soft onion: slight outward belly, then a quiet taper — not a cartoon bulb.
    const belly = Math.sin(Math.PI * Math.min(1, t * 1.15));
    const r = THREE.MathUtils.lerp(Rv, Ro, t * t) + Rv * 0.16 * belly * (1 - t * 0.55);
    const y = hW + D * (0.08 * belly + 0.92 * t);
    if (j) {
      const pr = merid[j - 1];
      v += Math.hypot(r - pr.r, y - pr.y) / (Math.max(0.4, (r + pr.r) / 2) * dPhi);
    }
    merid.push({ r, y, v, t });
  }
  const domeRows = [];
  for (let i = 0; i <= NZ; i++) {
    const az = phi(0) + (i / NZ) * Math.PI * 2;
    domeRows.push(merid.map((q) => at(q.r, az, q.y)));
  }
  const dome = gridGeo(domeRows, (i, j) => [(i / NZ) * Nb * 4, merid[j].v * 1.05]);
  add('dome', orient(dome, 0, inwardA(phi(0)).add(V(0, -0.2, 0))));
  for (let k = 0; k < Nb; k++) {
    const az = phi(k);
    const tA = V(-Math.sin(az), 0, Math.cos(az));
    const fr = [];
    for (let j = 0; j < merid.length; j++) {
      const q = merid[j];
      const prev = merid[Math.max(0, j - 1)];
      const next = merid[Math.min(merid.length - 1, j + 1)];
      const dr = next.r - prev.r, dy = next.y - prev.y;
      // Inward normal in the meridian plane, spun around Y.
      const nrm = V(-dy * Math.cos(az), dr, -dy * Math.sin(az)).normalize();
      if (nrm.y > 0.2) nrm.y = -Math.abs(nrm.y); // keep ribs reading on the underside
      fr.push({ o: at(q.r, az, q.y), a: nrm.normalize(), b: tA });
    }
    add('rib', sweep(fr, DOME_RIB_LOOP));
    add('glow', sweep(fr.map((q) => ({ ...q, o: q.o.clone().addScaledVector(q.a, 0.63) })), [[0, -0.04], [0.02, -0.04], [0.02, 0.04], [0, 0.04]], { open: false }));
  }
  const yTop = merid[merid.length - 1].y;
  const rim = new THREE.TorusGeometry(Ro + 0.04, 0.11, 10, 72);
  rim.rotateX(Math.PI / 2);
  rim.translate(C.x, yTop, C.z);
  add('metal', rim);
  // Quiet lotus-finial ring above the oculus (minimal — one lathed knob).
  {
    const fin = new THREE.LatheGeometry([
      new THREE.Vector2(0.05, 0), new THREE.Vector2(0.22, 0.08), new THREE.Vector2(0.18, 0.22),
      new THREE.Vector2(0.1, 0.38), new THREE.Vector2(0.04, 0.55), new THREE.Vector2(0.0, 0.7),
    ], 20);
    fin.translate(C.x, yTop + 0.02, C.z);
    add('metal', fin);
  }
  const sky = new THREE.CircleGeometry(Ro * 2.4, 48);
  sky.rotateX(Math.PI / 2);
  sky.translate(C.x, yTop + 3.2, C.z);
  add('sky', sky);
  {
    const ring = [];
    for (let k = 0; k <= 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const p = at(Ro * 0.9, a, yTop);
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
