/**
 * Future halls — distinct Subside-lobby language (soft capsule, oculus rings,
 * open mouths into lit depth). NOT a Classic reskin.
 *
 * Quality rules borrowed from Classic (not its shapes):
 *  - Walk envelope empty; width from minRadius so chords never cut the path
 *  - Exits are large open apertures + vestibule depth (never a slab in your face)
 *  - Planar floor reflector; matte shell (world-fixed IBL)
 *  - dispose() removes the group from the lab
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FloorReflector } from './reflector.js';
import { courseFrameAt } from './architecture.js';

const UP = new THREE.Vector3(0, 1, 0);
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const PV = (f, u, y) => V(f.x + f.lx * u, y, f.z + f.lz * u);
const lat = (f) => V(f.lx, 0, f.lz);
const tan = (f) => V(f.tx, 0, f.tz);

function gridGeo(rows, uvFn) {
  const R = rows.length, C = rows[0].length;
  const pos = [], uvs = [], idx = [];
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const p = rows[i][j];
      pos.push(p.x, p.y, p.z);
      const uv = uvFn ? uvFn(i, j) : [j / Math.max(1, C - 1), i / Math.max(1, R - 1)];
      uvs.push(uv[0], uv[1]);
    }
  }
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < C - 1; j++) {
      const a = i * C + j, b = a + 1, c = a + C, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function flipWinding(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
  }
  g.computeVertexNormals();
  return g;
}

function orient(g, vi, want) {
  const n = g.attributes.normal;
  const cur = V(n.getX(vi), n.getY(vi), n.getZ(vi));
  if (cur.dot(want) < 0) flipWinding(g);
  return g;
}

function prep(g, aoFn) {
  const o = g.index ? g.toNonIndexed() : g;
  if (!o.attributes.normal) o.computeVertexNormals();
  const n = o.attributes.position.count;
  if (!o.attributes.uv) o.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  for (const k of Object.keys(o.attributes)) if (!['position', 'normal', 'uv'].includes(k)) o.deleteAttribute(k);
  const p = o.attributes.position;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = aoFn ? aoFn(p.getY(i)) : 1;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = a;
  }
  o.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return o;
}

function sweepLoop(frames, loop) {
  const rows = frames.map((f) => loop.map(([u, v]) => PV(f, u, f.y + v)));
  const g = gridGeo(rows, (i, j) => [j / (loop.length - 1), frames[i].s * 0.12]);
  return orient(g, Math.floor(loop.length * 0.25), lat(frames[0]).negate());
}

/** Open U shell: floor lips → walls → ceiling. No classical arch/column language. */
function shellProfile(halfW, H, fillet) {
  const f = Math.min(fillet, halfW * 0.36, H * 0.2);
  const pts = [];
  const arc = (cx, cy, r, a0, a1, n) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  pts.push([halfW - f, 0.05]);
  arc(halfW - f, f, f, -Math.PI / 2, 0, 10);
  for (let y = f; y <= H - f + 1e-6; y += Math.max(0.22, (H - 2 * f) / 10)) pts.push([halfW, y]);
  arc(halfW - f, H - f, f, 0, Math.PI / 2, 10);
  for (let x = halfW - f; x >= -halfW + f - 1e-6; x -= Math.max(0.25, (halfW - f) / 8)) pts.push([x, H]);
  arc(-halfW + f, H - f, f, Math.PI / 2, Math.PI, 10);
  for (let y = H - f; y >= f - 1e-6; y -= Math.max(0.22, (H - 2 * f) / 10)) pts.push([-halfW, y]);
  arc(-halfW + f, f, f, Math.PI, Math.PI * 1.5, 10);
  pts.push([-halfW + f, 0.05]);
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.04) out.push(b);
  }
  return out;
}

function makeLabel(text, accent) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 512, 256);
  ctx.fillStyle = 'rgba(24, 32, 42, 0.9)';
  ctx.font = '600 110px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 36, 120);
  ctx.fillStyle = `#${accent.getHexString()}`;
  ctx.fillRect(36, 185, 100, 5);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.45, 0.72),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  mesh.renderOrder = 3;
  return mesh;
}

function ceilingRing(add, x, y, z, radius, beamH) {
  const rim = new THREE.TorusGeometry(radius, 0.04, 12, 56);
  rim.rotateX(Math.PI / 2);
  rim.translate(x, y, z);
  add('glow', rim);
  const well = new THREE.TorusGeometry(radius, 0.1, 10, 56);
  well.rotateX(Math.PI / 2);
  well.translate(x, y + 0.02, z);
  add('line', well);
  const shaft = new THREE.CylinderGeometry(radius * 0.9, radius * 1.06, beamH, 36, 1, true);
  shaft.translate(x, y - beamH / 2, z);
  add('beam', shaft);
}

/**
 * Soft open mouth: continue the capsule profile into lit depth, flaring wider.
 * No rectangular end-cap slabs — those never appear in Subside-style refs.
 */
function openMouth(ctx, tip, outward, halfW, H, fillet) {
  const { add } = ctx;
  const depth = 22;
  const ds = 0.4;
  const rows = [];
  for (let d = ds; d <= depth + 1e-6; d += ds) {
    const u = d / depth;
    // Ease in — no abrupt lip at the mouth (that read as a grey slab/arch).
    const flare = 1 + 1.4 * u * u * u;
    const f = {
      s: tip.s + d,
      x: tip.x + outward.x * d,
      y: tip.y,
      z: tip.z + outward.z * d,
      tx: tip.tx, tz: tip.tz, lx: tip.lx, lz: tip.lz,
    };
    const prof = shellProfile(halfW * flare, H * Math.min(1.75, 0.92 + 0.32 * flare), fillet * Math.min(1.5, flare));
    rows.push(prof.map(([uu, vv]) => PV(f, uu, f.y + vv)));
  }
  const g = gridGeo(rows, (i, j) => [j / (rows[0].length - 1), i * 0.1]);
  add('shell', orient(g, Math.floor(rows[0].length * 0.25), lat(tip).negate()));

  // Floor accent into the mouth
  add('portal', orient(gridGeo(rows.map((_, i) => {
    const d = (i + 1) * ds;
    const f = {
      x: tip.x + outward.x * d, y: tip.y, z: tip.z + outward.z * d,
      lx: tip.lx, lz: tip.lz,
    };
    return [PV(f, -0.45, f.y + 0.04), PV(f, 0.45, f.y + 0.04)];
  })), 0, UP));

  return {
    lamps: [
      { p: V(tip.x + outward.x * depth * 0.45, tip.y + H * 0.6, tip.z + outward.z * depth * 0.45), i: 2.6, d: 16 },
      { p: V(tip.x + outward.x * depth * 0.85, tip.y + H * 0.7, tip.z + outward.z * depth * 0.85), i: 3.8, d: 22 },
    ],
  };
}

function futureHalfW(course, spec) {
  const cap = 4.0;
  const fromR = Number.isFinite(course.minRadius)
    ? Math.max(2.8, Math.min(cap, course.minRadius * 0.48))
    : cap;
  return Math.min(cap, spec.futureWo ?? fromR);
}

export function buildFutureRoom(renderer, test, course, opts = {}) {
  const spec = test.room;
  const lite = !!opts.lite;
  const group = new THREE.Group();
  group.name = `room_future_${test.id}`;
  const accent = new THREE.Color(test.accent);
  const nextAccent = new THREE.Color(opts.next?.accent ?? '#ffffff');
  const lightCol = new THREE.Color(0xe6ecf6);

  const mats = {
    shell: new THREE.MeshStandardMaterial({
      color: 0xa8b2c0, roughness: 0.42, metalness: 0.08, vertexColors: true,
      envMapIntensity: 0.38, side: THREE.DoubleSide, emissive: new THREE.Color(0x1a222c), emissiveIntensity: 0.15,
    }),
    floor: Object.assign(
      new THREE.MeshStandardMaterial({ color: 0xeef2f7, roughness: 0.12, metalness: 0.12, envMapIntensity: 0.9 }),
      { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
    ),
    deck: Object.assign(
      new THREE.MeshStandardMaterial({ color: 0x343c48, metalness: 0.06, roughness: 0.7, envMapIntensity: 0.14 }),
      { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 },
    ),
    line: new THREE.MeshBasicMaterial({ color: 0x1a222c }),
    glow: new THREE.MeshBasicMaterial({ color: lightCol.clone().multiplyScalar(2.4) }),
    feature: new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(1.5) }),
    portal: new THREE.MeshBasicMaterial({ color: accent.clone() }),
    vest: new THREE.MeshStandardMaterial({ color: 0xdde3ec, roughness: 0.38, side: THREE.BackSide }),
    nextGlow: new THREE.MeshBasicMaterial({
      color: nextAccent.clone().lerp(new THREE.Color(1, 1, 1), 0.5).multiplyScalar(2.2),
      side: THREE.DoubleSide, vertexColors: true,
    }),
    beam: new THREE.ShaderMaterial({
      uniforms: { color: { value: lightCol.clone() }, strength: { value: 0.03 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 color; uniform float strength; varying vec2 vUv;
        void main(){
          float r = 1.0 - abs(vUv.x - 0.5) * 2.0;
          float a = strength * pow(max(r, 0.0), 1.5) * pow(1.0 - vUv.y, 1.2);
          gl_FragColor = vec4(color * a, 1.0);
        }`,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  };

  const B = {};
  const add = (k, ...g) => (B[k] ??= []).push(...g.flat());
  const ctx = { course, spec, add, mats, group, accent, test, nextAccent };

  const hall = course.length <= 0 ? buildFutureStill(ctx) : buildFutureCapsule(ctx);

  const ao = (y) => 0.62 + 0.38 * smooth(0, 1.8, y);
  const cfg = {
    shell: { ao, cast: true, recv: true },
    deck: { cast: true, recv: true },
    line: {}, glow: {}, feature: {}, portal: {}, vest: {}, nextGlow: {}, beam: {},
  };
  for (const [k, list] of Object.entries(B)) {
    if (!list.length) continue;
    const c = cfg[k] ?? {};
    const mesh = new THREE.Mesh(mergeGeometries(list.map((g) => prep(g, c.ao))), mats[c.mat ?? k]);
    mesh.castShadow = !!c.cast && !lite;
    mesh.receiveShadow = !!c.recv && !lite;
    mesh.name = k;
    if (k === 'beam' || k === 'vest' || k === 'nextGlow') mesh.renderOrder = 2;
    group.add(mesh);
  }

  const floorMesh = new THREE.Mesh(hall.floorGeo, mats.floor);
  floorMesh.receiveShadow = !lite;
  floorMesh.name = 'floor';
  group.add(floorMesh);
  const reflector = lite ? null : new FloorReflector(floorMesh, mats.floor, {
    resolution: spec.reflRes ?? 1024, maxDist: 6, strength: 0.84, minFresnel: 0.28, heightSharp: 0.04, heightSoft: 0.55, nearBlur: 0.12,
  });

  const sun = new THREE.DirectionalLight(0xeef2fa, 2.4);
  sun.position.copy(hall.center).add(V(-0.28, 1.5, 0.38).normalize().multiplyScalar(28));
  sun.target.position.copy(hall.center);
  group.add(sun, sun.target);
  if (!lite) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const r = Math.min(hall.radius * 0.5, 22);
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 4, far: 55 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
  }
  for (const L of hall.lamps || []) {
    const p = new THREE.PointLight(0xf0f4ff, L.i ?? 2.0, L.d ?? 14, 1.7);
    p.position.copy(L.p);
    group.add(p);
  }

  const fogColor = new THREE.Color(0xc2c8d2);
  const envScene = new THREE.Scene();
  envScene.background = fogColor;
  const holder = new THREE.Group();
  holder.position.set(-hall.center.x, -(hall.eyeY ?? 1.6), -hall.center.z);
  holder.add(group);
  envScene.add(holder);
  envScene.add(new THREE.HemisphereLight(0xffffff, 0xa8b0bc, 1.05));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const xrOn = renderer.xr.enabled;
  renderer.xr.enabled = false;
  renderer.shadowMap.needsUpdate = true;
  if (reflector) reflector.enabled = false;
  const envRT = pmrem.fromScene(envScene, 0.04, 0.1, 280);
  if (reflector) reflector.enabled = true;
  renderer.xr.enabled = xrOn;
  pmrem.dispose();
  holder.remove(group);
  renderer.shadowMap.needsUpdate = true;

  const base = { feature: mats.feature.color.clone(), portal: accent.clone() };
  return {
    group, sun, reflector,
    envMap: envRT.texture,
    fog: new THREE.FogExp2(fogColor, 0.0045),
    background: fogColor,
    exposure: 1.08,
    hemi: 0.5,
    portalGlow: 0,
    info: hall,
    beforeRender() { if (!lite) sun.shadow.updateMatrices(sun); },
    update(dt, st) {
      const q = st.quality ?? 0.5;
      if (spec.feedback === 'lean' || spec.feedback === 'steady') {
        mats.feature.color.copy(base.feature).lerp(new THREE.Color(0xffffff), 0.3 + 0.5 * q);
      }
      mats.portal.color.copy(base.portal).multiplyScalar(0.85 + 0.4 * (st.portalGlow ?? 0));
    },
    dispose() {
      group.parent?.remove(group);
      reflector?.dispose();
      group.traverse((o) => {
        o.geometry?.dispose();
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of ms) { m.map?.dispose(); m.dispose(); }
      });
      sun.shadow.map?.dispose();
      envRT.dispose();
    },
  };
}

function buildFutureCapsule(ctx) {
  const { course, add, group, accent, test } = ctx;
  const L = course.length;
  const halfW = futureHalfW(course, ctx.spec);
  const H = 4.6;
  const fillet = 1.0;
  const ds = Math.min(0.3, Math.max(0.18, (Number.isFinite(course.minRadius) ? course.minRadius : 20) * 0.035));
  const pad = 1.5;

  const frames = [];
  for (let s = -pad; s <= L + pad + 1e-6; s += ds) frames.push(courseFrameAt(course, s));
  add('shell', sweepLoop(frames, shellProfile(halfW, H, fillet)));

  // Soft panel seams (future language — not pilasters)
  for (const u of [-halfW * 0.55, halfW * 0.55]) {
    add('line', gridGeo(frames.map((f) => [
      PV(f, u - 0.01, f.y + H * 0.35),
      PV(f, u + 0.01, f.y + H * 0.35),
    ])));
  }
  for (let s = 2.5; s < L - 1; s += 5.5) {
    const f = courseFrameAt(course, s);
    const g = new THREE.BoxGeometry(halfW * 1.1, 0.016, 0.022);
    g.applyMatrix4(new THREE.Matrix4().makeBasis(lat(f), UP, tan(f)).setPosition(f.x, f.y + H - 0.05, f.z));
    add('line', g);
  }

  const lamps = [];
  for (let s = 2.5; s < L - 1.5; s += 6.5) {
    const f = courseFrameAt(course, s);
    ceilingRing(add, f.x, f.y + H - 0.06, f.z, Math.min(1.0, halfW * 0.26), 1.2);
    lamps.push({ p: V(f.x, f.y + H - 0.35, f.z), i: 2.1, d: 12 });
  }

  const floorFrames = [];
  for (let s = -pad - 1; s <= L + pad + 1 + 1e-6; s += ds) floorFrames.push(courseFrameAt(course, s));
  const floorCols = [-1, -0.5, 0, 0.5, 1].map((t) => t * (halfW - 0.08));
  const floorRows = floorFrames.map((f) => floorCols.map((u) => V(f.x + f.lx * u, 0, f.z + f.lz * u)));
  const floorGeo = orient(gridGeo(floorRows, (i, j) => [floorRows[i][j].x * 0.2, floorRows[i][j].z * 0.2]), 0, UP);

  const flat = course.maxY < 0.08;
  const hw = 1.35;
  if (!flat) {
    const deckFr = [];
    for (let s = -0.4; s <= L + 0.4; s += 0.26) deckFr.push(courseFrameAt(course, s));
    add('deck', orient(gridGeo(deckFr.map((f) => [PV(f, hw, f.y + 0.05), PV(f, -hw, f.y + 0.05)]), (i, j) => [j, deckFr[i].s]), 0, UP));
    for (const sg of [1, -1]) {
      add('feature', orient(gridGeo(deckFr.map((f) => [PV(f, sg * hw, f.y + 0.055), PV(f, sg * (hw - 0.035), f.y + 0.055)])), 0, UP));
    }
  } else {
    for (const sg of [1, -1]) {
      add('feature', orient(gridGeo(frames.map((f) => [PV(f, sg * 1.22, 0.035), PV(f, sg * 1.19, 0.035)])), 0, UP));
    }
  }

  // Soft flared mouths — no rectangular end slabs.
  const fEnd = courseFrameAt(course, L + pad);
  const fStart = {
    ...courseFrameAt(course, -pad),
    tx: -courseFrameAt(course, -pad).tx,
    tz: -courseFrameAt(course, -pad).tz,
  };
  const mEnd = openMouth(ctx, fEnd, tan(fEnd), halfW, H, fillet);
  const mStart = openMouth(ctx, fStart, tan(fStart), halfW, H, fillet);
  lamps.push(...(mEnd?.lamps || []), ...(mStart?.lamps || []));

  const fLabel = courseFrameAt(course, Math.min(1.3, L * 0.08));
  const label = makeLabel(test.chamber, accent);
  label.position.set(fLabel.x + fLabel.lx * (halfW - 0.2), fLabel.y + 1.9, fLabel.z + fLabel.lz * (halfW - 0.2));
  label.lookAt(fLabel.x, fLabel.y + 1.9, fLabel.z);
  group.add(label);

  const mid = courseFrameAt(course, L / 2);
  return {
    floorGeo, columns: [], colH: H,
    sunDir: V(-0.3, -0.9, 0.25).normalize(),
    center: V(mid.x, 0, mid.z),
    radius: Math.max(L * 0.55, halfW * 4),
    eyeY: 1.6,
    lamps,
  };
}

/**
 * Soft continuous bowl — floor lip → drum → dome + oculus.
 * No rectangular wall slabs, no end-cap portals. Depth comes from the oculus,
 * ceiling halo, and fog — Subside lobby language, not cut-up panels.
 */
function buildFutureStill(ctx) {
  const { spec, add, group, accent, test } = ctx;
  const C = V(0, 0, 0);
  const wallR = Math.max(spec.Rc ?? 7.5, 7.2);
  const H = 5.0;
  const fillet = 1.15;
  const N = 96, NY = 36;
  const Ro = 2.2;

  const rows = [];
  for (let j = 0; j <= NY; j++) {
    const t = j / NY;
    let y, r;
    if (t < 0.16) {
      // soft floor lip → wall
      const u = t / 0.16;
      const a = -Math.PI / 2 + 0.12 + u * (Math.PI / 2 - 0.12);
      y = Math.max(0.06, fillet + Math.sin(a) * fillet);
      r = wallR - fillet + Math.cos(a) * fillet;
    } else if (t > 0.62) {
      // dome → oculus
      const u = (t - 0.62) / 0.38;
      const a = u * Math.acos(Math.min(0.94, Ro / wallR));
      y = H - 0.08 + (wallR * 0.55) * Math.sin(a);
      r = Math.max(Ro, wallR * Math.cos(a));
    } else {
      y = fillet + (H - 0.08 - fillet) * ((t - 0.16) / 0.46);
      r = wallR;
    }
    const row = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      row.push(V(C.x + r * Math.cos(a), y, C.z + r * Math.sin(a)));
    }
    rows.push(row);
  }
  {
    const mid = rows[Math.floor(NY * 0.35)][0];
    add('shell', orient(
      gridGeo(rows, (i, j) => [i / N, j / NY]),
      Math.floor(NY * 0.35) * (N + 1),
      V(C.x - mid.x, 0, C.z - mid.z).normalize(),
    ));
  }

  // Subtle vertical seams on the drum (thin, not slabs)
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const seam = [];
    for (let j = 0; j < 14; j++) {
      const y = 0.45 + j * (H - 1.15) / 13;
      const r = wallR - 0.02;
      seam.push([
        V(C.x + (r - 0.006) * Math.cos(a), y, C.z + (r - 0.006) * Math.sin(a)),
        V(C.x + (r + 0.006) * Math.cos(a), y, C.z + (r + 0.006) * Math.sin(a)),
      ]);
    }
    add('line', gridGeo(seam));
  }

  const yRing = H - 0.05;
  ceilingRing(add, C.x, yRing, C.z, 2.35, 3.2);

  // Ankle-height stand rings only
  const stand = new THREE.RingGeometry(0.46, 0.5, 96);
  stand.rotateX(-Math.PI / 2);
  stand.translate(C.x, 0.035, C.z);
  add('feature', stand);
  const stand2 = new THREE.RingGeometry(2.1, 2.14, 128);
  stand2.rotateX(-Math.PI / 2);
  stand2.translate(C.x, 0.03, C.z);
  add('line', stand2);

  // Bright oculus fill — open depth upward, not a side door slab
  const sky = new THREE.CircleGeometry(Ro * 1.9, 48);
  sky.rotateX(-Math.PI / 2);
  sky.translate(C.x, yRing + 2.4, C.z);
  add('glow', sky);

  const floorGeo = new THREE.CircleGeometry(wallR - 0.12, 96);
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.translate(C.x, 0, C.z);

  const label = makeLabel(test.chamber, accent);
  label.position.set(C.x, 2.05, C.z - wallR + 0.28);
  label.lookAt(C.x, 2.05, C.z);
  group.add(label);

  return {
    floorGeo, columns: [], colH: H,
    sunDir: V(0.15, -1, 0.2).normalize(),
    center: C.clone(),
    radius: wallR + 3,
    eyeY: 1.6,
    lamps: [
      { p: V(C.x, yRing - 0.4, C.z), i: 2.8, d: 22 },
      { p: V(C.x, H * 0.45, C.z), i: 1.4, d: 14 },
    ],
  };
}
