/**
 * Per-room fixtures + the single guide card.
 * - fixtures are part of the room (world-fixed): walkway light line + dock ring,
 *   stance ring, floating gaze targets with live fill ring and gaze dot
 * - one upright glass card, front-left of the participant, shown only while
 *   stationary. It carries progression (chapter, room n of N), an animated
 *   illustration, pointable buttons and the room-select grid.
 */
import * as THREE from 'three';
import { idealRoll } from './path.js';
import { courseFrameAt } from './architecture.js';

const LIFT = 0.06; // above the walkway / flat deck (deck sits at ~0.05)

/* --------------------------------------------------------- floor inlay */

const INLAY_VERT = /* glsl */`
  attribute vec2 aUV;
  varying vec2 vUV;
  void main() {
    vUV = aUV;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const INLAY_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uProgress;
  uniform float uPulse;
  uniform float uBoost;
  varying vec2 vUV;
  void main() {
    float across = abs(vUV.y - 0.5) * 2.0;
    float core = 1.0 - smoothstep(0.2, 1.0, across);
    float ahead = smoothstep(uProgress - 0.004, uProgress + 0.004, vUV.x);
    float base = mix(0.16, 0.6, ahead);
    float pulse = uPulse < 0.0 ? 0.0 : exp(-pow((vUV.x - uPulse) / 0.03, 2.0));
    float a = core * (base + pulse * 0.85 + uBoost * 0.25) * uOpacity;
    vec3 col = uColor * (0.9 + pulse * 1.4 + uBoost * 0.6);
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function makeInlay(course, color, width = 0.07) {
  const pts = course.points(Math.max(60, Math.ceil(course.length * 8)));
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const nx = tz, nz = -tx;
    const p = pts[i];
    pos.push(p.x + nx * width / 2, p.y + LIFT, p.z + nz * width / 2);
    pos.push(p.x - nx * width / 2, p.y + LIFT, p.z - nz * width / 2);
    const u = i / (pts.length - 1);
    uv.push(u, 0, u, 1);
    if (i < pts.length - 1) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0 },
      uProgress: { value: 0 },
      uPulse: { value: -1 },
      uBoost: { value: 0 },
    },
    vertexShader: INLAY_VERT,
    fragmentShader: INLAY_FRAG,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  }));
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return mesh;
}

/* ------------------------------------------------------- arc rings */

const ARC_VERT = /* glsl */`
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Ring that fills clockwise from 12 o'clock (as seen from its front). */
const ARC_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uProgress;
  uniform float uGlow;
  uniform float uBase;
  varying vec2 vPos;
  void main() {
    float a01 = fract(atan(vPos.x, vPos.y) / 6.2831853 + 1.0);
    float filled = step(a01, uProgress);
    float lit = max(filled, uGlow);
    float a = mix(uBase, 0.95, lit) * uOpacity;
    vec3 col = mix(vec3(0.82, 0.86, 0.88), uColor * 1.7, lit) * (1.0 + 0.8 * uGlow);
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function arcRing(inner, outer, color, base = 0.22) {
  return new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 160, 1),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: 0 },
        uProgress: { value: 0 },
        uGlow: { value: 0 },
        uBase: { value: base },
      },
      vertexShader: ARC_VERT,
      fragmentShader: ARC_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
}

function makeFloorRing(radius, width, color) {
  const mesh = arcRing(radius - width, radius, color);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = Math.PI; // 12 o'clock = straight ahead
  mesh.renderOrder = 3;
  return mesh;
}

/* ------------------------------------------------------- gaze target */

/** Floating holo-target: dark glass disc, bronze bezel, fill ring, gaze dot. */
function makeGazeTarget(color) {
  const g = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.CircleGeometry(0.5, 96),
    new THREE.MeshStandardMaterial({ color: 0x1d2328, roughness: 0.12, metalness: 0.5, transparent: true, opacity: 0.88 }),
  );
  const bezel = new THREE.Mesh(
    new THREE.TorusGeometry(0.5, 0.016, 12, 128),
    new THREE.MeshStandardMaterial({ color: 0xd8c3a0, roughness: 0.22, metalness: 1 }),
  );
  bezel.position.z = 0.004;
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.56, 0.575, 128),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  const zone = new THREE.Mesh(
    new THREE.RingGeometry(0.17, 0.176, 96),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthWrite: false }),
  );
  zone.position.z = 0.008;
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.075, 64),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color) }),
  );
  lens.position.z = 0.009;
  const ring = arcRing(0.3, 0.36, color, 0.16);
  ring.position.z = 0.011;
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.026, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
  );
  const dotHalo = new THREE.Mesh(
    new THREE.RingGeometry(0.034, 0.05, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
  );
  dot.add(dotHalo);
  dot.position.z = 0.016;
  g.add(plate, bezel, halo, zone, lens, ring, dot);
  g.rotation.order = 'YXZ';
  g.userData = {
    lens, ring, dot, halo: dotHalo, outer: halo, zone,
    color: new THREE.Color(color),
    mode: 'idle', // idle | armed | done
    fill: 0, dotX: 0, dotY: 0, dotA: 0, onTarget: false, flash: 0, level: 0.3,
  };
  return g;
}

/* ------------------------------------------------------- chamber set */

/**
 * Fixtures for one room (lab coords, world-fixed).
 * @returns {{ group, update(dt, s), dispose(), targets: THREE.Group[] }}
 */
export function buildChamberSet(labParent, test, course) {
  const group = new THREE.Group();
  group.name = 'chamberSet';
  labParent.add(group);

  const accent = test.accent;
  const h = { group, opacity: 0, opacityTarget: 1, targets: [] };

  if (course.kind === 'still') {
    h.ring = makeFloorRing(0.5, 0.045, accent);
    h.ring.position.set(0, course.startY + LIFT, 0);
    group.add(h.ring);
  } else {
    h.inlay = makeInlay(course, accent);
    group.add(h.inlay);
    const end = course.sample(course.length);
    h.dock = makeFloorRing(0.5, 0.04, accent);
    h.dock.position.set(end.x, end.y + LIFT, end.z);
    group.add(h.dock);
  }

  if (test.look) {
    const eyeH = test.protocol === 'seated' ? 1.25 : 1.6;
    for (const T of test.look.targets) {
      const f = courseFrameAt(course, T.s);
      const fx = makeGazeTarget(accent);
      const u = T.side * T.lateral;
      fx.position.set(f.x + f.lx * u, f.y + T.height, f.z + f.lz * u);
      // face the approaching participant (eye point a few metres before the target)
      const e = courseFrameAt(course, Math.max(0, T.s - 5));
      const dx = e.x - fx.position.x, dy = e.y + eyeH - fx.position.y, dz = e.z - fx.position.z;
      fx.rotation.set(-Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0);
      fx.userData.label = T.label;
      group.add(fx);
      h.targets.push(fx);
    }
  }

  h.update = (dt, state) => {
    h.opacity += (h.opacityTarget - h.opacity) * Math.min(1, dt * 2.5);
    const o = h.opacity;
    const t = state.time;
    if (h.inlay) {
      const u = h.inlay.material.uniforms;
      u.uOpacity.value = o;
      u.uProgress.value = state.progress;
      if (state.stage === 'wait') {
        const cyc = (t % 4.4) / 3.4;
        u.uPulse.value = cyc <= 1 ? cyc : -1;
      } else {
        u.uPulse.value = -1;
      }
      u.uBoost.value += ((state.calm || 0) - u.uBoost.value) * Math.min(1, dt * 4);
    }
    if (h.dock) {
      const u = h.dock.material.uniforms;
      u.uOpacity.value = o;
      const near = state.stage === 'done' ? 1 : Math.max(0, (state.progress - 0.8) / 0.2);
      u.uGlow.value += (near - u.uGlow.value) * Math.min(1, dt * 3);
    }
    if (h.ring) {
      const u = h.ring.material.uniforms;
      u.uOpacity.value = o;
      u.uProgress.value = state.stage === 'trial' ? state.progress : state.stage === 'done' ? 1 : 0;
      const glow = state.stage === 'wait' ? 0.25 + 0.2 * Math.sin(t * 1.6)
        : state.stage === 'done' ? 1 : 0;
      u.uGlow.value += (glow - u.uGlow.value) * Math.min(1, dt * 3);
    }
    for (const fx of h.targets) {
      const d = fx.userData;
      const pulse = 0.5 + 0.5 * Math.sin(t * 4);
      const want = d.mode === 'done' ? 2.6 : d.mode === 'armed' ? (d.onTarget ? 2.4 : 0.9 + 0.7 * pulse) : 0.25;
      d.level += (want - d.level) * Math.min(1, dt * 6);
      d.flash = Math.max(0, d.flash - dt * 1.4);
      d.lens.material.color.copy(d.color).multiplyScalar(d.level + d.flash * 2);
      d.outer.material.opacity = o * (d.mode === 'armed' ? 0.35 + 0.45 * pulse : d.mode === 'done' ? 0.6 : 0.12);
      const ru = d.ring.material.uniforms;
      ru.uOpacity.value = o * (d.mode === 'idle' ? 0.45 : 1);
      ru.uProgress.value = d.fill;
      ru.uGlow.value = d.mode === 'done' ? Math.max(0.4, d.flash) : 0;
      d.zone.material.opacity = o * (d.mode === 'armed' ? (d.onTarget ? 0.55 : 0.28) : 0.08);
      d.dot.position.x = d.dotX;
      d.dot.position.y = d.dotY;
      d.dot.material.opacity = o * d.dotA * 0.95;
      d.halo.material.opacity = o * d.dotA * 0.35;
      d.dot.visible = d.dotA > 0.01;
    }
  };

  h.dispose = () => {
    labParent.remove(group);
    group.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.()); else m?.dispose?.();
    });
  };

  return h;
}

/* ------------------------------------------------------------ guide card */

const CW = 1024, CH = 700;
const PANEL_W = 0.94;

export function makeWorldPanel() {
  const canvas = document.createElement('canvas');
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W, PANEL_W * CH / CW),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }),
  );
  mesh.rotation.order = 'YXZ';
  mesh.renderOrder = 20;
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.userData = { canvas, ctx, tex, opacityTarget: 0, buttons: [] };
  return mesh;
}

/** Canvas pixel → button id (for pointer rays hitting the card at uv). */
export function panelButtonAt(panel, uv) {
  if (!uv) return null;
  const x = uv.x * CW, y = (1 - uv.y) * CH;
  for (const b of panel.userData.buttons) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
  }
  return null;
}

/**
 * Upright card, front-left of the participant (relative to travel direction −Z),
 * slightly below eye level and turned to face the eyes. Yaw + gentle pitch only.
 */
export function placeWorldPanel(panel, head) {
  const dist = 1.5, ang = 0.42, drop = 0.18;
  const x = head.x - Math.sin(ang) * dist;
  const z = head.z - Math.cos(ang) * dist;
  const y = head.y - drop;
  panel.position.set(x, y, z);
  panel.rotation.set(-Math.atan2(drop, dist), Math.atan2(head.x - x, head.z - z), 0);
}

export function setPanelOpacityTarget(panel, opacity) {
  if (panel?.userData) panel.userData.opacityTarget = opacity;
}

export function tickPanelOpacity(panel, dt) {
  if (!panel?.material) return;
  const target = panel.userData?.opacityTarget ?? 0;
  panel.material.opacity += (target - panel.material.opacity) * Math.min(1, dt * 2.6);
  panel.visible = panel.material.opacity > 0.01;
}

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
const FONT = '"Segoe UI", "SF Pro Display", system-ui, sans-serif';
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

/**
 * @param {object} o { test, course, hall, stage: 'wait'|'done', stepIndex, time,
 *   briefingDone, feedback, next, menu, hover, tests, chapters, completed:Set, index }
 */
export function paintWorldPanel(panel, o) {
  const { test, stage, time = 0, menu, hover } = o;
  const { ctx, tex } = panel.userData;
  const buttons = (panel.userData.buttons = []);
  const accent = hex(test.accent);
  ctx.clearRect(0, 0, CW, CH);

  // Glass card
  const g = ctx.createLinearGradient(0, 0, 0, CH);
  g.addColorStop(0, 'rgba(24,31,36,0.92)');
  g.addColorStop(1, 'rgba(12,16,19,0.95)');
  ctx.fillStyle = g;
  round(ctx, 8, 8, CW - 16, CH - 16, 44);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const X = 60;
  // header: chapter + room n of N
  const chap = o.chapters.find((c) => c.id === test.chapter);
  ctx.fillStyle = accent;
  round(ctx, X, 50, 40, 6, 3);
  ctx.fill();
  ctx.font = `600 20px ${FONT}`;
  ctx.fillStyle = '#d9e4e6';
  spaced(ctx, `CHAPTER ${ROMAN[test.chapter]}  ·  ${chap?.name.toUpperCase() ?? ''}`, X, 94, 2.6);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#9fb2b6';
  ctx.fillText(`ROOM ${o.index + 1} OF ${o.tests.length}`, CW - X, 94);
  ctx.textAlign = 'left';
  drawProgress(ctx, X, 112, CW - 2 * X, o, time);

  if (menu) paintMenu(ctx, o, buttons, hover, time);
  else paintRoom(ctx, o, buttons, hover, accent, stage === 'done');

  tex.needsUpdate = true;
}

/** 14 segments grouped by chapter: done = solid, current = accent pulse. */
function drawProgress(ctx, x, y, w, o, time) {
  const n = o.tests.length;
  const gaps = o.chapters.length - 1;
  const gap = 4, cg = 16;
  const seg = (w - (n - 1 - gaps) * gap - gaps * cg) / n;
  let xx = x;
  o.tests.forEach((t, i) => {
    const done = o.completed.has(t.id);
    const cur = i === o.index;
    ctx.fillStyle = cur ? hex(t.accent) : done ? 'rgba(232,240,242,0.78)' : 'rgba(232,240,242,0.14)';
    if (cur) ctx.globalAlpha = 0.75 + 0.25 * Math.sin(time * 3);
    round(ctx, xx, y, seg, 7, 3.5);
    ctx.fill();
    ctx.globalAlpha = 1;
    const nxt = o.tests[i + 1];
    xx += seg + (nxt && nxt.chapter !== t.chapter ? cg : gap);
  });
}

function button(ctx, buttons, hover, id, x, y, text, accent, primary, time, w0 = 0) {
  ctx.font = `600 24px ${FONT}`;
  const w = Math.max(w0, ctx.measureText(text).width + 60);
  const h = 58;
  const hot = hover === id;
  round(ctx, x, y, w, h, h / 2);
  if (primary) {
    ctx.fillStyle = accent;
    ctx.globalAlpha = hot ? 1 : 0.86 + 0.08 * Math.sin(time * 2.4);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (hot) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke(); }
    ctx.fillStyle = '#0f1518';
  } else {
    ctx.fillStyle = hot ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.strokeStyle = hot ? 'rgba(255,255,255,0.8)' : 'rgba(220,235,238,0.32)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#e1ecee';
  }
  ctx.textAlign = 'center';
  ctx.fillText(text, x + w / 2, y + 38);
  ctx.textAlign = 'left';
  buttons.push({ id, x, y, w, h });
  return w;
}

function paintRoom(ctx, o, buttons, hover, accent, done) {
  const { test, course, stepIndex = 0, time = 0, briefingDone, feedback, next } = o;
  const X = 60;
  ctx.fillStyle = '#9fb2b6';
  ctx.font = `600 20px ${FONT}`;
  const stopped = done && feedback?.headline === 'Stopped';
  spaced(ctx, done ? (stopped ? `ROOM ${test.chamber}  ·  STOPPED` : `ROOM ${test.chamber}  ·  FINISHED`) : `ROOM ${test.chamber}`, X, 172, 3);
  ctx.fillStyle = '#f6fbfc';
  ctx.font = `600 50px ${FONT}`;
  ctx.fillText(done ? (feedback?.headline || 'Room finished') : test.name, X, 230);

  ctx.fillStyle = '#c3d1d4';
  ctx.font = `26px ${FONT}`;
  const yText = wrap(ctx, done ? (feedback?.detail || '') : test.brief, X, 278, 480, 35);

  const top = Math.max(yText + 56, 360);
  test.steps.forEach((s, i) => {
    const ok = i < stepIndex;
    const y = top + i * 46;
    ctx.beginPath();
    ctx.arc(X + 13, y - 9, 13, 0, Math.PI * 2);
    if (ok) {
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.strokeStyle = '#11181b';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(X + 6.5, y - 9);
      ctx.lineTo(X + 11.5, y - 4);
      ctx.lineTo(X + 20, y - 14);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(210,228,232,0.4)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(210,228,232,0.55)';
      ctx.font = `600 15px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), X + 13, y - 4);
      ctx.textAlign = 'left';
    }
    ctx.fillStyle = ok ? '#eef7f8' : '#a8bcc0';
    ctx.font = `25px ${FONT}`;
    ctx.fillText(s, X + 42, y);
  });

  const by = CH - 104;
  let x = X;
  if (!done) {
    x += button(ctx, buttons, hover, 'begin', x, by, briefingDone ? 'Begin  ▸' : 'Skip intro  ▸', accent, true, time) + 14;
    button(ctx, buttons, hover, 'menu', x, by, 'All rooms', accent, false, time);
  } else {
    x += button(ctx, buttons, hover, 'next', x, by, next ? `Next: ${next.name}  ▸` : 'Back to Room 1  ▸', accent, true, time) + 14;
    x += button(ctx, buttons, hover, 'repeat', x, by, 'Repeat', accent, false, time) + 14;
    button(ctx, buttons, hover, 'menu', x, by, 'All rooms', accent, false, time);
  }
  ctx.fillStyle = 'rgba(200,215,218,0.55)';
  ctx.font = `19px ${FONT}`;
  ctx.fillText(
    done
      ? (stopped ? 'Trigger · next   Grip · repeat   All rooms' : 'Trigger · next   Grip · repeat')
      : 'Trigger to begin · grip fully stops motion',
    X, CH - 22,
  );

  const bx = 610, byI = 150, bw = CW - bx - 50, bh = CH - 150 - 130;
  if (done) drawDoneBadge(ctx, bx, byI, bw, bh, time, accent, o.doneAt ?? time);
  else drawIllustration(ctx, bx, byI, bw, bh, { test, course, hall: o.hall, time, accent });
}

function paintMenu(ctx, o, buttons, hover, time) {
  const X = 60;
  ctx.fillStyle = '#f6fbfc';
  ctx.font = `600 44px ${FONT}`;
  ctx.fillText('All rooms', X, 196);
  ctx.fillStyle = '#9fb2b6';
  ctx.font = `22px ${FONT}`;
  ctx.fillText('Point at a room to go there. Completed rooms are ticked.', X + 230, 192);
  const cols = o.chapters.length, gap = 14, M = 44;
  const cw = (CW - 2 * M - (cols - 1) * gap) / cols;
  o.chapters.forEach((c, ci) => {
    const cx = M + ci * (cw + gap);
    ctx.fillStyle = '#c9d6d9';
    const head = `${ROMAN[c.id]} · ${c.name.toUpperCase()}`;
    let fs = 18;
    for (; fs > 12; fs--) {
      ctx.font = `600 ${fs}px ${FONT}`;
      if (ctx.measureText(head).width + head.length * 1.2 <= cw) break;
    }
    spaced(ctx, head, cx, 246, 1.2);
    const rooms = o.tests.filter((t) => t.chapter === c.id);
    rooms.forEach((t, ri) => {
      const y = 262 + ri * 64;
      const id = `room:${t.id}`;
      const hot = hover === id;
      const cur = t.id === o.test.id;
      const done = o.completed.has(t.id);
      round(ctx, cx, y, cw, 56, 14);
      ctx.fillStyle = hot ? 'rgba(255,255,255,0.18)' : cur ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
      ctx.fill();
      ctx.strokeStyle = hot ? '#ffffff' : cur ? hex(t.accent) : 'rgba(220,235,238,0.16)';
      ctx.lineWidth = hot || cur ? 2.5 : 1.5;
      ctx.stroke();
      ctx.fillStyle = hex(t.accent);
      round(ctx, cx + 12, y + 14, 5, 28, 2.5);
      ctx.fill();
      ctx.fillStyle = '#93a7ab';
      ctx.font = `600 17px ${FONT}`;
      ctx.fillText(t.chamber, cx + 28, y + 35);
      ctx.fillStyle = '#eef6f7';
      ctx.font = `19px ${FONT}`;
      const room = cw - 58 - (done ? 40 : 12);
      if (ctx.measureText(t.name).width <= room) ctx.fillText(t.name, cx + 58, y + 35);
      else {
        ctx.font = `17px ${FONT}`;
        const words = t.name.split(' ');
        let a = words.shift();
        while (words.length && ctx.measureText(`${a} ${words[0]}`).width <= room) a += ' ' + words.shift();
        let b = words.join(' ');
        while (b && ctx.measureText(b).width > room && b.length > 4) b = b.slice(0, -2) + '…';
        ctx.fillText(a, cx + 58, y + 25);
        ctx.fillText(b, cx + 58, y + 46);
      }
      if (done) {
        ctx.strokeStyle = hex(t.accent);
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(cx + cw - 34, y + 28);
        ctx.lineTo(cx + cw - 27, y + 35);
        ctx.lineTo(cx + cw - 15, y + 21);
        ctx.stroke();
      }
      buttons.push({ id, x: cx, y, w: cw, h: 56 });
    });
  });
  button(ctx, buttons, hover, 'back', X, CH - 104, '◂  Back', hex(o.test.accent), false, time);
}

/* ------------------------------------------------------ illustrations */

const ease = (x) => x * x * (3 - 2 * x);

function drawDoneBadge(ctx, x, y, w, h, time, accent, doneAt) {
  const cx = x + w / 2, cy = y + h / 2;
  const k = ease(Math.min(1, (time - doneAt) / 1.1));
  ctx.strokeStyle = 'rgba(220,235,238,0.12)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(cx, cy, 116, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, 116, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
  ctx.stroke();
  const c = ease(Math.max(0, Math.min(1, (time - doneAt - 0.6) / 0.5)));
  if (c > 0) {
    ctx.lineWidth = 14;
    ctx.beginPath();
    const p0 = [cx - 50, cy + 2], p1 = [cx - 14, cy + 38], p2 = [cx + 56, cy - 36];
    ctx.moveTo(...p0);
    if (c < 0.4) ctx.lineTo(p0[0] + (p1[0] - p0[0]) * c / 0.4, p0[1] + (p1[1] - p0[1]) * c / 0.4);
    else {
      ctx.lineTo(...p1);
      const e = (c - 0.4) / 0.6;
      ctx.lineTo(p1[0] + (p2[0] - p1[0]) * e, p1[1] + (p2[1] - p1[1]) * e);
    }
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

function drawIllustration(ctx, x, y, w, h, { test, course, hall, time, accent }) {
  if (test.theme === 'still') {
    drawStillFigure(ctx, x, y, w, h, time, accent);
    return;
  }
  if (test.theme === 'climb') {
    drawProfile(ctx, x, y, w, h, { course, time, accent });
    return;
  }
  drawPlan(ctx, x, y, w, h, { test, course, hall, time, accent });
}

/** Side elevation: the walkway's height over distance, with an animated rider. */
function drawProfile(ctx, x, y, w, h, { course, time, accent }) {
  const L = course.length;
  const pts = course.points(80);
  const span = Math.max(4, course.maxY - Math.min(0, course.minY) + 2.4);
  const pad = 26;
  const sx = (s) => x + pad + (s / L) * (w - 2 * pad);
  const sy = (yy) => y + h - pad - (yy / span) * (h - 2 * pad) * 0.9;
  ctx.strokeStyle = 'rgba(225,238,242,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + pad - 10, sy(0));
  ctx.lineTo(x + w - pad + 10, sy(0));
  ctx.stroke();
  // columns silhouette for scale
  ctx.fillStyle = 'rgba(225,238,242,0.06)';
  for (let k = 0; k <= 6; k++) ctx.fillRect(x + pad + (k / 6) * (w - 2 * pad) - 5, sy(7), 10, sy(0) - sy(7));
  // deck
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  pts.forEach((p, i) => { const X = sx(p.s), Y = sy(p.y); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
  ctx.lineTo(sx(L), sy(0));
  ctx.lineTo(sx(0), sy(0));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  pts.forEach((p, i) => { const X = sx(p.s), Y = sy(p.y); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
  ctx.stroke();
  const cyc = (time % 7.4) / 6;
  const s = ease(Math.min(1, cyc)) * L;
  const p = course.sample(s);
  const px = sx(s), py = sy(p.y);
  // upright figure: body stays vertical regardless of slope
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(px, py - 4);
  ctx.lineTo(px, py - 52);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px, py - 64, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([5, 7]);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, py - 90);
  ctx.lineTo(px, py + 6);
  ctx.stroke();
  ctx.setLineDash([]);
  const grade = Math.round(Math.abs(p.grade) * 100);
  ctx.fillStyle = '#c3d1d4';
  ctx.font = `22px ${FONT}`;
  ctx.fillText(grade ? `${grade} % ${p.grade > 0 ? 'up' : 'down'} · stay vertical` : 'stay vertical', x + pad, y + 24);
}

/** Top-down plan of the hall with route, exit, animated "you", lean inset, targets. */
function drawPlan(ctx, x, y, w, h, { test, course, hall, time, accent }) {
  const pts = course.points(120);
  const outline = [];
  if (hall?.Rp) {
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      outline.push([hall.center.x + hall.Rp * Math.cos(a), hall.center.z + hall.Rp * Math.sin(a)]);
    }
  } else {
    const W = hall?.Wo ?? 8;
    const L = [], R = [];
    for (let s = -4; s <= course.length + 4 + 1e-6; s += 0.5) {
      const f = courseFrameAt(course, s);
      L.push([f.x + f.lx * W, f.z + f.lz * W]);
      R.push([f.x - f.lx * W, f.z - f.lz * W]);
    }
    outline.push(...L, ...R.reverse(), L[0]);
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [px, pz] of outline) {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
  }
  const pad = 22;
  const scale = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxZ - minZ));
  const cx = x + w / 2, cy = y + h / 2;
  const mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2;
  const toS = (px, pz) => [cx - (px - mx) * scale, cy - (pz - mz) * scale];

  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.beginPath();
  outline.forEach(([a, b], i) => { const [sx, sy] = toS(a, b); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(225,238,242,0.38)';
  ctx.lineWidth = 3;
  ctx.stroke();
  // column dots
  if (hall?.Rc) {
    ctx.fillStyle = 'rgba(225,238,242,0.35)';
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      const [sx, sy] = toS(hall.center.x + hall.Rc * Math.cos(a), hall.center.z + hall.Rc * Math.sin(a));
      ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  } else if (hall?.Wc) {
    ctx.fillStyle = 'rgba(225,238,242,0.3)';
    for (let s = 0; s <= course.length; s += 5) {
      const f = courseFrameAt(course, s);
      for (const sg of [1, -1]) {
        const [sx, sy] = toS(f.x + f.lx * sg * hall.Wc, f.z + f.lz * sg * hall.Wc);
        ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // route
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => { const [sx, sy] = toS(p.x, p.z); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
  ctx.stroke();
  ctx.globalAlpha = 1;
  const end = pts[pts.length - 1];
  const [ex, ey] = toS(end.x, end.z);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(ex, ey, 9, 0, Math.PI * 2);
  ctx.stroke();

  const period = test.id === 'C03_brisk' ? 3.4 : test.theme === 'look' ? 9 : 6;
  const cyc = (time % (period + 1.4)) / period;
  const f = ease(Math.min(1, cyc));
  const s = f * course.length;
  const smp = course.sample(s);
  const [px, py] = toS(smp.x, smp.z);

  if (test.look) {
    const LK = test.look;
    const sim = period * f;
    const dwell = LK.dwellSec;
    let tcur = 0.8;
    let active = null;
    LK.targets.forEach((T, i) => {
      const fr = courseFrameAt(course, T.s);
      const pt = toS(fr.x + fr.lx * T.side * T.lateral, fr.z + fr.lz * T.side * T.lateral);
      const fl = cyc > 1 ? 1 : Math.max(0, Math.min(1, (sim - tcur) / dwell));
      tcur += dwell + 0.9;
      if (!active && fl < 1 && cyc <= 1) active = pt;
      ctx.fillStyle = '#1b2226';
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(220,235,238,0.3)';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = accent;
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], 15, -Math.PI / 2, -Math.PI / 2 + fl * Math.PI * 2);
      ctx.stroke();
      if (T.height > 3 || T.height < 1) {
        ctx.fillStyle = '#e6f0f2';
        ctx.font = `600 18px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(T.height > 3 ? '▲ high' : '▼ low', pt[0], pt[1] + (T.side > 0 ? -24 : 36));
        ctx.textAlign = 'left';
      }
      void i;
    });
    if (active) {
      const ang = Math.atan2(active[1] - py, active[0] - px);
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.arc(px, py, Math.hypot(active[0] - px, active[1] - py), ang - 0.12, ang + 0.12);
      ctx.closePath();
      ctx.fill();
    }
    const lx = x + 30, ly = y + h - 18;
    const demo = (time % 3.2) / dwell;
    ctx.strokeStyle = 'rgba(220,235,238,0.3)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(lx, ly, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.beginPath();
    ctx.arc(lx, ly, 15, -Math.PI / 2, -Math.PI / 2 + Math.min(1, demo) * Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#c3d1d4';
    ctx.font = `21px ${FONT}`;
    ctx.fillText('Hold your gaze ≈ 2 s', lx + 28, ly + 7);
  }

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(px, py, 8, 0, Math.PI * 2);
  ctx.fill();
  const hx = -Math.sin(smp.yaw), hy = -Math.cos(smp.yaw);
  ctx.beginPath();
  ctx.moveTo(px + hx * 20, py + hy * 20);
  ctx.lineTo(px + hy * 7 + hx * 8, py - hx * 7 + hy * 8);
  ctx.lineTo(px - hy * 7 + hx * 8, py + hx * 7 + hy * 8);
  ctx.closePath();
  ctx.fill();

  if (test.theme === 'turn') drawHeadInset(ctx, x + w - 64, y + h - 64, idealRoll(smp.curvature) * 2.4, accent);
}

function drawStillFigure(ctx, x, y, w, h, time, accent) {
  const cx = x + w / 2;
  const top = y + 20;
  ctx.setLineDash([6, 10]);
  ctx.strokeStyle = 'rgba(220,238,242,0.3)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, y);
  ctx.lineTo(cx, y + h - 60);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = '#eef7f8';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, top + 30, 28, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 64, top + 122);
  ctx.quadraticCurveTo(cx - 58, top + 74, cx, top + 72);
  ctx.quadraticCurveTo(cx + 58, top + 74, cx + 64, top + 122);
  ctx.lineTo(cx + 52, top + 250);
  ctx.lineTo(cx - 52, top + 250);
  ctx.closePath();
  ctx.stroke();
  const ry = y + h - 40;
  const p = ease(Math.min(1, (time % 7) / 6));
  ctx.strokeStyle = 'rgba(220,238,242,0.25)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.ellipse(cx, ry, 110, 24, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.beginPath();
  ctx.ellipse(cx, ry, 110, 24, 0, Math.PI / 2, Math.PI / 2 + p * Math.PI * 2);
  ctx.stroke();
}

function drawHeadInset(ctx, cx, cy, roll, accent) {
  ctx.fillStyle = 'rgba(8,12,14,0.92)';
  ctx.beginPath();
  ctx.arc(cx, cy, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(220,238,242,0.22)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.save();
  ctx.translate(cx, cy + 32);
  ctx.rotate(-roll);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(0, -48, 17, 0, Math.PI * 2);
  ctx.moveTo(-32, 6);
  ctx.quadraticCurveTo(0, -28, 32, 6);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------ helpers */

function spaced(ctx, text, x, y, sp) {
  let xx = x;
  for (const ch of text) { ctx.fillText(ch, xx, y); xx += ctx.measureText(ch).width + sp; }
}

function round(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx, text, x, y, maxW, lineH) {
  const words = String(text).split(/\s+/);
  let line = '', yy = y;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      ctx.fillText(line, x, yy);
      line = w;
      yy += lineH;
    } else line = t;
  }
  if (line) ctx.fillText(line, x, yy);
  return yy;
}
