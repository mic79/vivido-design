import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { Course, cruiseProfile, idealRoll } from './path.js';
import { SignalCapture } from './capture.js';
import { buildRoom as buildClassicRoom } from './architecture.js';
import { buildFutureRoom } from './architectureFuture.js';
import { buildMughalRoom } from './architectureMughal.js';
import { loadEnvStyle, saveEnvStyle, STYLE_FUTURE, STYLE_MUGHAL, STYLES, STYLES_UI } from './envStyle.js';
import { DesktopViz } from './viz.js';
import { TESTS, PLAYABLE, CHAPTERS, testById, chapterOf } from './tests.js';
import {
  saveSession, listSessions, getSession, deleteSession, clearAllSessions,
  exportSession, exportAllSessions,
} from './store.js';
import {
  buildChamberSet, makeWorldPanel, paintWorldPanel, placeWorldPanel,
  setPanelOpacityTarget, tickPanelOpacity, panelButtonAt, panelControlAt, panelSliderT,
} from './chamberEnv.js';
import { GuideAudio } from './audio.js';
import { Sfx } from './sfx.js';

const guideAudio = new GuideAudio();
const sfx = new Sfx();
const params = new URLSearchParams(location.search);
const LITE = params.has('lite');
const styleParam = params.get('style');
let envStyle = STYLES.some((s) => s.id === styleParam) ? styleParam : loadEnvStyle();
const SPEED_KEY = 'mg5.speedScale.v3';
const SPEED_MIN = 0.5;
const SPEED_MAX = 3;
function loadSpeedScale() {
  try {
    // Missing key → getItem is null → `+null === 0` (finite!) — that wrongly became 50%.
    const raw = localStorage.getItem(SPEED_KEY);
    if (raw == null || raw === '') return 1;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));
  } catch { /* */ }
  return 1;
}
function saveSpeedScale(v) {
  const n = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number.isFinite(+v) && +v > 0 ? +v : 1));
  try { localStorage.setItem(SPEED_KEY, String(n)); } catch { /* */ }
  return n;
}
let speedScale = loadSpeedScale();
function speedLabel(v = speedScale) {
  return `${Math.round(v * 100)}%`;
}
function refreshSpeedChip() {
  const el = document.getElementById('speedChip');
  if (el) el.textContent = `Speed ${speedLabel()}`;
}

/* Chrome + Meta Link: hide XR layers so three uses classic XRWebGLLayer. */
try {
  if (typeof XRRenderState !== 'undefined' && 'layers' in XRRenderState.prototype) {
    Object.defineProperty(XRRenderState.prototype, 'layers', { get() { return undefined; }, configurable: true });
  }
} catch (e) { /* ignore */ }

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = !LITE;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// The whole hall (sun included) moves rigidly, so the shadow map is rendered once per
// room; room.beforeRender() keeps its matrix in step with the moving lab.
renderer.shadowMap.autoUpdate = false;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 400);
camera.position.set(0, 1.6, 0);
camera.rotation.order = 'YXZ';
scene.add(camera);

/** Lab + its fixtures move under a fixed XR origin (inverse locomotion). */
const motionRoot = new THREE.Group();
scene.add(motionRoot);

/** Participant frame: only the guide card lives here (visible only while stationary). */
const moduleRoot = new THREE.Group();
scene.add(moduleRoot);

const worldPanel = makeWorldPanel();
moduleRoot.add(worldPanel);

/** Comfort fade: head-locked black shell used for every reposition / room change. */
const fadeShell = new THREE.Mesh(
  new THREE.SphereGeometry(0.3, 24, 16),
  new THREE.MeshBasicMaterial({
    color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false, fog: false,
  }),
);
fadeShell.renderOrder = 10000;
fadeShell.frustumCulled = false;
fadeShell.visible = false;
camera.add(fadeShell);

const capture = new SignalCapture();
const viz = new DesktopViz(document.getElementById('plot'));
viz.clearLive('Load a session to begin.');

const hemi = new THREE.HemisphereLight(0xffffff, 0xb8b0a4, 0.35);
scene.add(hemi);

/** Room architecture + fixtures, in course (lab) coordinates under motionRoot. */
const labRoot = new THREE.Group();
motionRoot.add(labRoot);

let room = null;
let set = null;
let course = new Course({ kind: 'still' });
let profile = cruiseProfile(0, 1);
let test = PLAYABLE[0];

const st = {
  // -1 home | 0 briefing | 1 settle countdown | 2 trial | 3 complete (stay put)
  phase: -1,
  t0: 0,
  tau: 0,
  s: 0,
  calm: 0,
  calmHeld: false,
  stopHold: 0,
  ready: false,
  looking: { yaw: 0, pitch: 0 },
  drag: null,
  selectedSessionId: null,
  confirmPulse: false,
  retryPulse: false,
  action: null,
  menu: false, // false | 'rooms' | 'style' | 'settings'
  hover: null,
  hoverPrev: null,
  sliderDrag: null, // 'slider:speed' while dragging
  panelUv: null,
  openSettingsOnEnter: false,
  inVr: false,
  briefingDone: false,
  briefingToken: 0,
  stepIndex: 0,
  lookStage: 0,
  gazeErrSum: 0,
  gazeErrN: 0,
  quality: 0.5,
  calmTime: 0,
  trialTime: 0,
  feedback: null,
  doneAt: 0,
  fade: 0,
  fadeTarget: 0,
  pending: null,
  lastPaint: 0,
};

/* ------------------------------------------------------------ progress */
const PROG_KEY = 'mg5.progress.v2';
const progress = (() => {
  try {
    const p = JSON.parse(localStorage.getItem(PROG_KEY) || '{}');
    return { completed: new Set(p.completed || []), last: p.last || null };
  } catch (e) { return { completed: new Set(), last: null }; }
})();
function saveProgress() {
  try { localStorage.setItem(PROG_KEY, JSON.stringify({ completed: [...progress.completed], last: progress.last })); } catch (e) { /* */ }
}
/** Where to continue: the first unfinished room after the last one played. */
function continueId() {
  const list = PLAYABLE;
  let li = list.findIndex((t) => t.id === progress.last);
  if (li < 0) li = 0;
  for (let k = 0; k < list.length; k++) {
    const t = list[(li + k) % list.length];
    if (!progress.completed.has(t.id)) return t.id;
  }
  return list[0].id;
}

window.__mg5 = {
  capture, st, renderer, motionRoot, moduleRoot, labRoot, TESTS, guideAudio, sfx, scene, worldPanel, progress, camera,
  get course() { return course; }, get set() { return set; }, get room() { return room; }, get test() { return test; },
};

/* ---------------------------------------------------------------- DOM */
const home = document.getElementById('home');
const drawer = document.getElementById('drawer');
const rail = document.getElementById('rail');
const goBtn = document.getElementById('go');
const goFlat = document.getElementById('goFlat');
const statusEl = document.getElementById('status');
const testSel = document.getElementById('test');
const testDesc = document.getElementById('testDesc');
const sessionsEl = document.getElementById('sessions');
const participant = () => document.getElementById('pid').value.trim();
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
const ROMAN = ['', 'I', 'II', 'III', 'IV'];

for (const t of PLAYABLE) {
  const opt = document.createElement('option');
  opt.value = t.id;
  opt.textContent = `${t.chamber} — ${t.name} (~${Math.round(t.introSec + t.trialSec)}s)`;
  testSel.appendChild(opt);
}

function renderRail() {
  rail.innerHTML = '';
  for (const c of CHAPTERS) {
    const rooms = PLAYABLE.filter((t) => t.chapter === c.id);
    if (!rooms.length) continue;
    const done = rooms.filter((t) => progress.completed.has(t.id)).length;
    const el = document.createElement('div');
    el.className = 'chap';
    el.innerHTML = `<h3>${ROMAN[c.id]} · ${c.name}<span>${done}/${rooms.length}</span></h3><div class="tiles"></div>`;
    const tiles = el.querySelector('.tiles');
    for (const t of rooms) {
      const b = document.createElement('button');
      b.className = 'tile' + (progress.completed.has(t.id) ? ' done' : '') + (t.id === testSel.value ? ' sel' : '');
      b.style.setProperty('--c', hex(t.accent));
      b.innerHTML = `<div class="n">${t.chamber}</div><div class="nm">${t.name}</div>`;
      b.title = t.brief;
      b.onclick = () => selectRoom(t.id);
      tiles.appendChild(b);
    }
    rail.appendChild(el);
  }
}

function renderHero() {
  const t = testById(testSel.value);
  document.documentElement.style.setProperty('--accent', hex(t.accent));
  document.getElementById('heroOver').textContent = `Chapter ${ROMAN[t.chapter]} · ${chapterOf(t).name}`;
  document.getElementById('heroTitle').textContent = t.name;
  document.getElementById('heroBrief').textContent = t.brief;
  const idx = PLAYABLE.indexOf(t);
  const chips = [`Room ${Math.max(1, idx + 1)} of ${PLAYABLE.length}`, t.protocol === 'seated' ? 'Seated' : 'Standing', `About ${Math.round(t.introSec + t.trialSec)} s`];
  if (progress.completed.has(t.id)) chips.push('Completed ✓');
  document.getElementById('heroChips').innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join('');
}

function showTestDesc() {
  const t = testById(testSel.value);
  testDesc.innerHTML = `<b>OBJECTIVE</b> ${t.objective}<br><b>YOU</b> ${t.youDo}<br><b>MODULE</b> ${t.weDo}<br><b>FOCUS</b> ${t.focus}`;
}

function selectRoom(id) {
  testSel.value = id;
  showTestDesc();
  renderHero();
  renderRail();
  if (st.phase === -1 && st.ready) transition(() => buildRoomFor(id));
}
testSel.onchange = () => selectRoom(testSel.value);

function renderStylePicker() {
  const el = document.getElementById('stylePicker');
  if (!el) return;
  el.innerHTML = STYLES_UI.map((s) => (
    `<button type="button" class="style-opt${s.id === envStyle ? ' on' : ''}" data-style="${s.id}" title="${s.hint}">${s.label}</button>`
  )).join('');
  el.querySelectorAll('[data-style]').forEach((btn) => {
    btn.onclick = () => {
      const next = saveEnvStyle(btn.dataset.style);
      if (next === envStyle) return;
      envStyle = next;
      renderStylePicker();
      if (st.phase === -1 && st.ready) transition(() => buildRoomFor(testSel.value));
      else if (st.phase === 0 || st.phase === 3) transition(() => setupChamber(test.id));
    };
  });
}

document.getElementById('btnResearch').onclick = () => drawer.classList.toggle('open');
document.getElementById('btnCloseDrawer').onclick = () => drawer.classList.remove('open');
document.getElementById('btnResetProgress').onclick = () => {
  progress.completed.clear();
  progress.last = null;
  saveProgress();
  renderRail();
  renderHero();
};

/* ---------------------------------------------------------- controllers */
const controllerFactory = new XRControllerModelFactory();
const raycaster = new THREE.Raycaster();
const pointers = [];
for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, fog: false }));
  ray.visible = false;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  tip.visible = false;
  c.add(ray);
  scene.add(tip);
  const p = { controller: c, ray, tip, connected: false, hover: null, gamepad: null, uv: null };
  pointers.push(p);
  c.addEventListener('connected', (e) => { p.connected = true; p.gamepad = e.data?.gamepad ?? null; });
  c.addEventListener('disconnected', () => { p.connected = false; p.gamepad = null; });
  c.addEventListener('selectstart', () => {
    if (p.hover?.startsWith?.('slider:')) {
      st.sliderDrag = p.hover;
      applyPanelSlider(p.hover, p.uv);
      hapticHand(p, 0.22, 35);
      return;
    }
    if (p.hover) {
      st.action = p.hover;
      hapticHand(p, 0.35, 45);
      return;
    }
    if (!st.menu && (st.phase === 0 || st.phase === 3)) {
      st.confirmPulse = true;
      hapticHand(p, 0.3, 40);
    }
  });
  c.addEventListener('selectend', () => {
    if (st.sliderDrag) {
      st.sliderDrag = null;
      hapticHand(p, 0.12, 20);
    }
  });
  c.addEventListener('squeezestart', () => {
    if (st.phase === 3 && !st.menu) { st.retryPulse = true; hapticHand(p, 0.28, 40); return; }
    st.calmHeld = true;
    hapticHand(p, 0.18, 30);
    if (st.phase === 2) capture.mark('calm_start');
  });
  c.addEventListener('squeezeend', () => {
    st.calmHeld = false;
    if (st.phase === 2) capture.mark('calm_end');
  });
  scene.add(c);
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerFactory.createControllerModel(grip));
  scene.add(grip);
}

/** Pulse one hand when we know its gamepad; otherwise both. */
function hapticHand(p, intensity, ms) {
  try {
    const act = p?.gamepad?.hapticActuators?.[0];
    if (act?.pulse) { act.pulse(intensity, ms); return; }
  } catch { /* */ }
  haptic(intensity, ms);
}

/** Gentle controller pulse on both hands (no-op on desktop). */
function haptic(intensity, ms) {
  const session = renderer.xr.getSession?.();
  if (!session) return;
  for (const src of session.inputSources) {
    const act = src.gamepad?.hapticActuators?.[0];
    try { act?.pulse?.(intensity, ms); } catch (e) { /* */ }
  }
}

function applyPanelSlider(id, uv) {
  if (id !== 'slider:speed') return;
  const t = panelSliderT(worldPanel, uv, id);
  if (t == null) return;
  speedScale = saveSpeedScale(SPEED_MIN + t * (SPEED_MAX - SPEED_MIN));
  refreshSpeedChip();
  st.lastPaint = 0;
}

const _rayM = new THREE.Matrix4();
/** Laser pointers onto the card; returns hovered button id. */
function updatePointers() {
  const cardOn = worldPanel.visible && worldPanel.material.opacity > 0.5 && st.phase >= 0;
  let hover = null;
  st.panelUv = null;
  for (const p of pointers) {
    const show = cardOn && p.connected && renderer.xr.isPresenting;
    p.ray.visible = show;
    p.tip.visible = false;
    p.hover = null;
    p.uv = null;
    if (!show) continue;
    _rayM.identity().extractRotation(p.controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(p.controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_rayM);
    const hit = raycaster.intersectObject(worldPanel, false)[0];
    p.ray.scale.z = hit ? hit.distance : 1.2;
    if (hit) {
      p.tip.visible = true;
      p.tip.position.copy(hit.point);
      p.uv = hit.uv;
      p.hover = panelButtonAt(worldPanel, hit.uv);
      if (p.hover && !hover) {
        hover = p.hover;
        st.panelUv = hit.uv;
      }
      if (st.sliderDrag && p.hover === st.sliderDrag) applyPanelSlider(st.sliderDrag, hit.uv);
      else if (st.sliderDrag && !p.hover) applyPanelSlider(st.sliderDrag, hit.uv);
    }
  }
  // Hover edge → light tick on the pointing hand
  if (hover && hover !== st.hoverPrev) {
    const hand = pointers.find((p) => p.hover === hover);
    hapticHand(hand, 0.14, 22);
  }
  st.hoverPrev = hover;
  return hover;
}

/* ------------------------------------------------------------ sessions */
function refreshSessionList() {
  const list = listSessions();
  sessionsEl.innerHTML = '';
  for (const e of list) {
    const row = document.createElement('div');
    row.className = 'sess' + (e.id === st.selectedSessionId ? ' on' : '');
    row.innerHTML = `<div><b>${e.testName || e.testId || e.protocol}</b>
      <div class="meta">${e.participantId || 'anon'} · ${new Date(e.savedAt).toLocaleString()} · ${e.durationSec?.toFixed?.(0) ?? '?'}s
      · roll̄ ${e.meanAbsErrRollDeg != null ? e.meanAbsErrRollDeg.toFixed(1) + '°' : '—'}</div></div>
      <div class="btnrow" style="margin:0;justify-content:flex-end">
        <button class="tiny" data-act="view">View</button>
        <button class="tiny" data-act="exp">Export</button>
        <button class="tiny danger" data-act="del">Del</button>
      </div>`;
    row.onclick = (ev) => {
      const act = ev.target?.dataset?.act;
      if (act === 'exp') {
        exportSession(e.id).then((n) => { statusEl.textContent = `Exported ${n}`; }).catch((err) => { statusEl.textContent = err.message; });
        return;
      }
      if (act === 'del') {
        deleteSession(e.id).then(() => {
          if (st.selectedSessionId === e.id) st.selectedSessionId = null;
          refreshSessionList();
        });
        return;
      }
      st.selectedSessionId = e.id;
      refreshSessionList();
      getSession(e.id).then((rec) => {
        if (!rec) return;
        capture.samples = rec.samples;
        capture.events = rec.events;
        capture.meta = rec.meta;
        viz.drawSession(capture);
        statusEl.textContent = `Loaded ${rec.testName || rec.id} (not exported)`;
      });
    };
    sessionsEl.appendChild(row);
  }
}

document.getElementById('btnExport').onclick = async () => {
  try {
    if (!st.selectedSessionId) { statusEl.textContent = 'Select a session first.'; return; }
    statusEl.textContent = `Exported ${await exportSession(st.selectedSessionId)}`;
  } catch (e) { statusEl.textContent = e.message; }
};
document.getElementById('btnExportAll').onclick = async () => {
  try { statusEl.textContent = `Exported all (${await exportAllSessions()})`; } catch (e) { statusEl.textContent = e.message; }
};
document.getElementById('btnClear').onclick = async () => {
  if (!confirm('Delete all saved sessions from this browser?')) return;
  await clearAllSessions();
  st.selectedSessionId = null;
  refreshSessionList();
  viz.clearLive('Archive cleared.');
  statusEl.textContent = 'Archive cleared';
};
refreshSessionList();

/* ---------------------------------------------------------------- input */
addEventListener('keydown', (e) => {
  if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (e.repeat) return;
    if (!st.menu && (st.phase === 0 || st.phase === 3)) { st.confirmPulse = true; return; }
    st.calmHeld = true;
    if (st.phase === 2) capture.mark('calm_start');
  }
  if (e.code === 'KeyR' && st.phase === 3) { st.retryPulse = true; e.preventDefault(); }
  if (e.code === 'KeyM' && (st.phase === 0 || st.phase === 3)) { st.action = st.menu ? 'back' : 'menu'; }
  if (e.code === 'Comma' && (st.phase === 0 || st.phase === 3)) { st.action = 'style'; }
  if (e.code === 'Period' && (st.phase === 0 || st.phase === 3)) { st.action = 'settings'; }
  if (e.code === 'Escape' && st.phase >= 0) {
    e.preventDefault();
    leaveToHome();
  }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    st.calmHeld = false;
    if (st.phase === 2) capture.mark('calm_end');
  }
});
const _ndc = new THREE.Vector2();
function mouseHover(e) {
  if (!worldPanel.visible || st.phase < 0) return null;
  _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(_ndc, camera);
  const hit = raycaster.intersectObject(worldPanel, false)[0];
  return hit ? panelButtonAt(worldPanel, hit.uv) : null;
}
canvas.addEventListener('pointerdown', (e) => {
  st.drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  if (!renderer.xr.isPresenting) {
    _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(_ndc, camera);
    const hit = raycaster.intersectObject(worldPanel, false)[0];
    const ctrl = hit ? panelControlAt(worldPanel, hit.uv) : null;
    if (ctrl?.kind === 'slider') {
      st.sliderDrag = ctrl.id;
      applyPanelSlider(ctrl.id, hit.uv);
      st.drag.slider = true;
    }
  }
});
canvas.addEventListener('pointerup', (e) => {
  const d = st.drag;
  const wasSlider = !!d?.slider || !!st.sliderDrag;
  st.drag = null;
  st.sliderDrag = null;
  if (wasSlider || !d || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 6) return;
  const id = mouseHover(e);
  if (id) st.action = id;
  else if (!st.menu && (st.phase === 0 || st.phase === 3)) st.confirmPulse = true;
});
canvas.addEventListener('pointermove', (e) => {
  if (!renderer.xr.isPresenting) {
    if (st.sliderDrag) {
      _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      raycaster.setFromCamera(_ndc, camera);
      const hit = raycaster.intersectObject(worldPanel, false)[0];
      if (hit) applyPanelSlider(st.sliderDrag, hit.uv);
    }
    const h = mouseHover(e);
    st.mouseHover = h;
    canvas.style.cursor = h ? 'pointer' : 'default';
  }
  if (!st.drag || renderer.xr.isPresenting || st.phase < 0) return;
  st.looking.yaw -= (e.clientX - st.drag.x) * 0.004;
  st.looking.pitch -= (e.clientY - st.drag.y) * 0.004;
  st.looking.pitch = Math.max(-1.3, Math.min(1.3, st.looking.pitch));
  st.drag.x = e.clientX;
  st.drag.y = e.clientY;
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (!renderer.xr.isPresenting) renderer.setSize(innerWidth, innerHeight, false);
});

/* ------------------------------------------------------------- geometry */
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _headPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();

/**
 * Put course sample under the participant with travel direction = view −Z
 * (and the walkway surface at the XR floor). Applied exactly — smoothness comes
 * from the course + cruise profile, so the room never slides on its own.
 */
function applyInversePath(sample) {
  const yawT = sample.yaw + Math.PI;
  const c = Math.cos(-yawT);
  const s = Math.sin(-yawT);
  motionRoot.rotation.y = -yawT;
  motionRoot.position.set(
    c * (-sample.x) + s * (-sample.z),
    -sample.y,
    -s * (-sample.x) + c * (-sample.z),
  );
}

function headWorldPose() {
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.getWorldPosition(_headPos);
  cam.getWorldQuaternion(_q);
  _euler.setFromQuaternion(_q, 'YXZ');
  return {
    x: _headPos.x, y: _headPos.y, z: _headPos.z,
    yaw: _euler.y, pitch: _euler.x, roll: _euler.z,
  };
}

/** Angle (rad) between gaze and a world object. */
function gazeAngleTo(obj) {
  _fwd.set(0, 0, -1).applyQuaternion(_q);
  obj.getWorldPosition(_to).sub(_headPos).normalize();
  return Math.acos(Math.max(-1, Math.min(1, _fwd.dot(_to))));
}

/* ------------------------------------------------------- transitions */

/** Fade to black, run `fn` while black, fade back in. Never move the room visibly. */
function transition(fn) {
  st.pending = fn;
  st.fadeTarget = 1;
}

function tickFade(dt) {
  const rate = st.fadeTarget > st.fade ? 1 / 0.7 : 1 / 1.0;
  if (st.fade < st.fadeTarget) st.fade = Math.min(st.fadeTarget, st.fade + dt * rate);
  else if (st.fade > st.fadeTarget) st.fade = Math.max(st.fadeTarget, st.fade - dt * rate);
  const e = st.fade * st.fade * (3 - 2 * st.fade);
  fadeShell.material.opacity = e;
  fadeShell.visible = e > 0.001;
  if (st.pending && st.fade >= 1) {
    const fn = st.pending;
    st.pending = null;
    fn();
    st.fadeTarget = 0;
  }
}

/* ---------------------------------------------------------- chambers */

function nextTest(t = test) {
  const i = PLAYABLE.indexOf(t);
  if (i < 0) return PLAYABLE[0] || null;
  return i < PLAYABLE.length - 1 ? PLAYABLE[i + 1] : null;
}

/** Build the hall for `id` (architecture, lighting, sound, fixtures). Call while black. */
function buildRoomFor(id) {
  test = testById(id);
  testSel.value = test.id;
  showTestDesc();
  course = new Course(test.course);
  profile = cruiseProfile(course.length, test.trialSec);
  if (set) set.dispose();
  if (room) room.dispose();
  const build = envStyle === STYLE_FUTURE ? buildFutureRoom
    : envStyle === STYLE_MUGHAL ? buildMughalRoom
      : buildClassicRoom;
  room = build(renderer, test, course, { next: nextTest() ?? PLAYABLE[0], lite: LITE, style: envStyle });
  labRoot.add(room.group);
  room.reflector?.exclude(worldPanel, ...pointers.flatMap((p) => [p.ray, p.tip]), fadeShell);
  scene.environment = room.envMap;
  scene.background = room.background;
  scene.fog = room.fog;
  renderer.toneMappingExposure = room.exposure;
  hemi.intensity = room.hemi;
  set = buildChamberSet(labRoot, test, course);
  set.opacity = 0;
  // Pad sits on the mirror floor — keep it out of the reflection pass (avoids a floating twin).
  if (set.pad) room.reflector?.exclude(set.pad);
  applyInversePath(course.sample(0));
  sfx.setRoom(test.sound);
  if (!renderer.xr.isPresenting) {
    camera.position.set(0, test.protocol === 'standing' ? 1.6 : 1.25, 0);
  }
}

function setupChamber(id) {
  buildRoomFor(id);
  progress.last = test.id;
  saveProgress();

  capture.reset({
    participantId: participant(),
    protocol: test.protocol,
    speedMps: +profile.vc.toFixed(3),
    courseKind: course.kind,
    courseLengthM: +course.length.toFixed(3),
    courseRiseM: +(course.sample(course.length).y - course.startY).toFixed(3),
    courseMinRadiusM: Number.isFinite(course.minRadius) ? +course.minRadius.toFixed(2) : null,
    introSec: test.introSec,
    trialSec: test.trialSec,
    trialKind: test.trialKind,
    testId: test.id,
    testName: test.name,
    chamber: test.chamber,
    chapter: test.chapter,
    focus: test.focus,
  });
  capture.mark('start', { protocol: test.protocol, testId: test.id, chamber: test.chamber });

  Object.assign(st, {
    phase: 0, t0: performance.now() / 1000, tau: 0, s: 0, calm: 0, calmHeld: false, stopHold: 0,
    confirmPulse: false, retryPulse: false, action: null, menu: false, hover: null,
    stepIndex: 0, lookStage: 0, gazeErrSum: 0, gazeErrN: 0, quality: 0.5,
    calmTime: 0, trialTime: 0, feedback: null, doneAt: 0,
    sway: { n: 0, x: 0, z: 0, xx: 0, zz: 0 }, lean: { sum: 0, n: 0 }, looking: { yaw: 0, pitch: 0 },
    lookExplore: 0, _prevLook: null,
  });
  camera.rotation.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  placeWorldPanel(worldPanel, headWorldPose());
  setPanelOpacityTarget(worldPanel, 1);
  st.lastPaint = 0;
  if (st.openSettingsOnEnter) {
    st.openSettingsOnEnter = false;
    st.menu = 'settings';
  }

  home.classList.add('hide');
  drawer.classList.remove('open');
  viz.clearLive(`Room ${test.chamber} — ${test.name}`);
  sfx.ambient(true);
  sfx.chime('enter');
  playBriefing();
}

function playBriefing() {
  const token = ++st.briefingToken;
  st.briefingDone = !guideAudio.voiceOn || !!test.skipVoice;
  if (st.briefingDone) return;
  guideAudio.play(test.id).then(() => {
    if (token !== st.briefingToken || st.phase !== 0) return;
    st.briefingDone = true;
  });
}

function startTrial(tAbs) {
  st.phase = 2;
  st.t0 = tAbs;
  st.tau = 0;
  st.s = 0;
  setPanelOpacityTarget(worldPanel, 0);
  guideAudio.play('begin');
  if (set.targets[0]) set.targets[0].userData.mode = 'armed';
  haptic(0.25, 60);
  capture.mark('trial_start', { trialKind: test.trialKind });
}

/** Friendly, non-technical result for the completion card. */
function feedbackFor() {
  const sum = capture.summarize();
  const r = sum.ride;
  switch (test.theme) {
    case 'freelook': {
      const look = st.lookExplore || 0;
      if (look > 8) return { headline: 'Well explored', detail: 'You looked around the hall. If that felt fine, you are ready to move.' };
      if (look > 3) return { headline: 'Settled in', detail: 'A short look around is enough. Continue if you feel comfortable.' };
      return { headline: 'Baseline done', detail: 'If anything felt off just looking around, take a break before the glides.' };
    }
    case 'still': {
      const a = st.sway;
      const sway = a.n > 1 ? Math.sqrt(Math.max(0, a.xx / a.n - (a.x / a.n) ** 2 + a.zz / a.n - (a.z / a.n) ** 2)) * 100 : 0; // cm
      if (sway < 1.2) return { headline: 'Very still', detail: 'Little movement recorded while the ring filled.' };
      if (sway < 2.5) return { headline: 'Steady enough', detail: 'Only the small natural sway most people have.' };
      return { headline: 'Room finished', detail: 'A little sway is normal. You can repeat this room any time.' };
    }
    case 'turn': {
      const q = st.lean.n ? st.lean.sum / st.lean.n : 0;
      if (q > 0.7) return { headline: 'Lean matched', detail: 'Your lean tracked the curve closely.' };
      if (q > 0.45) return { headline: 'Lean followed', detail: 'You stayed with the turn through most of the bend.' };
      return { headline: 'Room finished', detail: 'Next time, try tilting a little more into the turn.' };
    }
    case 'look': {
      const n = set.targets.length;
      const hits = set.targets.filter((fx) => fx.userData.mode === 'done').length;
      const acc = st.gazeErrN ? st.gazeErrSum / st.gazeErrN : 99;
      if (hits === n && acc < 3.5) return { headline: 'All targets', detail: 'Every ring filled, near the centre.' };
      if (hits === n) return { headline: 'All targets', detail: 'Every ring filled.' };
      if (hits > 0) return { headline: `${hits} of ${n}`, detail: 'Some rings filled. You can repeat this room any time.' };
      return { headline: 'Try again', detail: 'Look at the centre of each target until its ring fills.' };
    }
    default: {
      const e = Math.max(r.meanAbsErrRollDeg, r.meanAbsErrPitchDeg * 0.6);
      if (e < 3) return { headline: 'Upright', detail: 'Head stayed level through the ride.' };
      if (e < 6) return { headline: 'Mostly upright', detail: 'Balance held through most of the ride.' };
      return { headline: 'Room finished', detail: 'You reached the arch. Repeat any time.' };
    }
  }
}

async function finishChamber({ aborted = false, stopped = false } = {}) {
  if (st.phase < 0 || st.phase === 3) return;
  st.phase = 3;
  st.confirmPulse = false;
  st.retryPulse = false;
  st.menu = false;
  st.stopHold = 0;
  // Look steps are earned by doing them; the others complete with the ride.
  if (test.theme !== 'look' && !aborted) st.stepIndex = test.steps.length;
  st.doneAt = performance.now() / 1000;
  guideAudio.stopVoice();
  sfx.setMotion(0);
  sfx.setGaze(0, false);
  capture.mark('end', { aborted: !!aborted, stopped: !!stopped });
  camera.updateMatrixWorld(true);
  placeWorldPanel(worldPanel, headWorldPose());
  setPanelOpacityTarget(worldPanel, 1);
  if (!aborted) {
    progress.completed.add(test.id);
    saveProgress();
    st.feedback = feedbackFor();
    sfx.chime('complete');
    haptic(0.5, 140);
    setTimeout(() => { if (st.phase === 3 && st.doneAt) guideAudio.play('complete'); }, 900);
    statusEl.textContent = `Room ${test.chamber} complete`;
  } else if (stopped) {
    st.feedback = {
      headline: 'Stopped',
      detail: 'Motion is off. Trigger opens the next room, grip repeats this one, or choose All rooms.',
    };
    sfx.chime('step');
    haptic(0.35, 80);
    statusEl.textContent = 'Stopped';
  } else {
    st.feedback = null;
    statusEl.textContent = `Room ${test.chamber} left early`;
  }
  viz.drawSession(capture);
  try {
    st.selectedSessionId = await saveSession(capture);
    refreshSessionList();
  } catch (e) {
    console.error(e);
    statusEl.textContent = 'Save failed: ' + e.message;
  }
}

function syncAudioPrefs() {
  guideAudio.setMusic(document.getElementById('musicOn').checked);
  guideAudio.setVoice(document.getElementById('voiceOn').checked);
  guideAudio.unlock();
  guideAudio.startSessionMusic();
}

function begin(vr) {
  if (!st.ready) return;
  syncAudioPrefs();
  sfx.unlock();
  // First entry: start fully black, build the room, then fade in.
  st.fade = 1;
  st.fadeTarget = 0;
  st.pending = null;
  setupChamber(testSel.value);

  if (!vr || renderer.xr.isPresenting) return;
  navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] }).then((session) => {
    st.inVr = true;
    renderer.xr.setSession(session);
    session.addEventListener('end', onXrSessionEnd);
  }).catch((e) => {
    statusEl.textContent = 'VR failed: ' + e.message;
    leaveToHome();
  });
}

function leaveToHome() {
  guideAudio.stopVoice();
  if (st.phase === 0 || st.phase === 1 || st.phase === 2) finishChamber({ aborted: true });
  st.phase = -1;
  st.menu = false;
  setPanelOpacityTarget(worldPanel, 0);
  sfx.ambient(false);
  sfx.setMotion(0);
  sfx.setGaze(0, false);
  if (!renderer.xr.isPresenting) guideAudio.stopSessionMusic();
  testSel.value = continueId();
  showTestDesc();
  renderHero();
  renderRail();
  home.classList.remove('hide');
  transition(() => buildRoomFor(testSel.value));
}

function onXrSessionEnd() {
  st.inVr = false;
  guideAudio.stopSessionMusic();
  leaveToHome();
}

function syncAudioToggles() {
  const m = document.getElementById('musicOn');
  const v = document.getElementById('voiceOn');
  if (m) m.checked = guideAudio.musicOn;
  if (v) v.checked = guideAudio.voiceOn;
}

function applyEnvStyle(nextId) {
  const next = saveEnvStyle(nextId);
  if (next === envStyle) return false;
  envStyle = next;
  renderStylePicker();
  return true;
}

/** Card buttons (pointer, mouse) and their trigger/keyboard fallbacks. */
function runAction(id, tAbs) {
  if (!id || st.pending) return;
  if (id.startsWith('slider:')) return; // drag-only
  sfx.chime('step');
  haptic(0.28, 40);
  if (id === 'menu') { st.menu = 'rooms'; st.lastPaint = 0; return; }
  if (id === 'style') { st.menu = 'style'; st.lastPaint = 0; return; }
  if (id === 'settings' || id === 'speed') { st.menu = 'settings'; st.lastPaint = 0; return; }
  if (id === 'back') { st.menu = false; st.lastPaint = 0; return; }
  if (id === 'toggle:music') {
    guideAudio.setMusic(!guideAudio.musicOn);
    syncAudioToggles();
    st.lastPaint = 0;
    return;
  }
  if (id === 'toggle:voice') {
    guideAudio.setVoice(!guideAudio.voiceOn);
    syncAudioToggles();
    st.lastPaint = 0;
    return;
  }
  if (id.startsWith('style:')) {
    const sid = id.slice(6);
    if (!applyEnvStyle(sid)) { st.lastPaint = 0; return; }
    if (st.phase === -1 && st.ready) transition(() => buildRoomFor(testSel.value));
    else if (st.phase === 0 || st.phase === 3) transition(() => setupChamber(test.id));
    return;
  }
  if (id.startsWith('room:')) {
    const rid = id.slice(5);
    if (st.phase === 2 || st.phase === 1) return;
    if (st.phase === 0) capture.mark('end', { aborted: true, skippedTo: rid });
    transition(() => setupChamber(rid));
    return;
  }
  if (id === 'begin') { st.confirmPulse = true; return; }
  if (id === 'next') { transition(() => setupChamber((nextTest() ?? PLAYABLE[0]).id)); return; }
  if (id === 'repeat') { transition(() => setupChamber(test.id)); }
  void tAbs;
}

/* ------------------------------------------------------------- steps */

const _inv = new THREE.Matrix4();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * Gaze on a target: the ring fills only while the gaze is inside the accuracy
 * cone (dwellSec to fill), drains slowly when you look away, and a dot on the
 * target shows exactly where you are looking.
 */
function updateGazeTarget(fx, dt) {
  const d = fx.userData;
  const T = test.look;
  const err = gazeAngleTo(fx);
  fx.updateWorldMatrix(true, false);
  _inv.copy(fx.matrixWorld).invert();
  _o.copy(_headPos).applyMatrix4(_inv);
  _d.set(0, 0, -1).applyQuaternion(_q).transformDirection(_inv);
  if (_d.z < -1e-3 && _o.z > 0) {
    const t = -_o.z / _d.z;
    let hx = _o.x + _d.x * t, hy = _o.y + _d.y * t;
    const r = Math.hypot(hx, hy);
    if (r > 0.44) { hx *= 0.44 / r; hy *= 0.44 / r; }
    d.dotX = hx;
    d.dotY = hy;
  }
  const errDeg = err * 180 / Math.PI;
  const wantDot = Math.max(0, Math.min(1, (26 - errDeg) / 12));
  d.dotA += (wantDot - d.dotA) * Math.min(1, dt * 10);
  d.onTarget = errDeg < T.accuracyDeg;
  const before = d.fill;
  // Match playback speed: at 300% you pass targets ~3× sooner, so fill/drain 3× faster.
  const pace = Math.max(0.5, speedScale);
  if (d.onTarget) {
    d.fill = Math.min(1, d.fill + (dt * pace) / T.dwellSec);
    st.gazeErrSum += errDeg * dt;
    st.gazeErrN += dt;
  } else {
    d.fill = Math.max(0, d.fill - dt * 0.35 * pace);
  }
  if (Math.floor(d.fill * 4) > Math.floor(before * 4) && d.fill < 1) haptic(0.12, 25);
  sfx.setGaze(d.fill, d.onTarget);
  return d.fill >= 1 ? errDeg : null;
}

function updateSteps(dt, prog) {
  const n = test.steps.length;
  if (test.theme === 'look') {
    const fx = set.targets[st.lookStage];
    if (fx) {
      const doneErr = updateGazeTarget(fx, dt);
      if (doneErr != null) {
        const ud = fx.userData;
        ud.mode = 'done';
        ud.flash = 1;
        ud.dotA = 0;
        ud.onTarget = false;
        sfx.setGaze(1, false);
        sfx.chime('target');
        haptic(0.55, 110);
        capture.mark('step', { step: `look_${ud.label}`, angleDeg: +doneErr.toFixed(1) });
        st.lookStage += 1;
        st.stepIndex = st.lookStage;
        if (set.targets[st.lookStage]) set.targets[st.lookStage].userData.mode = 'armed';
      }
    } else if (st.lookStage === set.targets.length) {
      _fwd.set(0, 0, -1).applyQuaternion(_q);
      if (Math.abs(Math.atan2(-_fwd.x, -_fwd.z)) < 0.2 && Math.abs(_fwd.y) < 0.35) {
        st.lookStage += 1;
        st.stepIndex = n;
        sfx.chime('step');
        capture.mark('step', { step: 'face_forward' });
      }
    }
    return;
  }
  const prev = st.stepIndex;
  st.stepIndex = Math.max(st.stepIndex, Math.min(n - 1, Math.floor(prog * n + 0.02)));
  if (st.stepIndex > prev && st.stepIndex < n) sfx.chime('step');
}

/** Live 0..1 "doing it right" signal that drives the room's feedback lights. */
function updateQuality(dt, head, ideal) {
  let q = st.quality;
  if (test.theme === 'freelook') {
    const prev = st._prevLook;
    const dyaw = prev ? Math.abs(head.yaw - prev.yaw) : 0;
    const dpitch = prev ? Math.abs(head.pitch - prev.pitch) : 0;
    st._prevLook = { yaw: head.yaw, pitch: head.pitch };
    const rate = (dyaw + dpitch) / Math.max(dt, 1e-3);
    st.lookExplore = (st.lookExplore || 0) + Math.min(1.5, rate) * dt;
    q = 0.4 + 0.6 * Math.min(1, rate / 0.9);
  } else if (test.theme === 'still') {
    const a = st.sway;
    a.n++; a.x += head.x; a.z += head.z; a.xx += head.x * head.x; a.zz += head.z * head.z;
    const v = st._prevHead ? Math.hypot(head.x - st._prevHead.x, head.z - st._prevHead.z) / Math.max(dt, 1e-3) : 0;
    q = Math.max(0, Math.min(1, 1 - v / 0.12));
  } else if (test.theme === 'turn') {
    const need = Math.abs(ideal.roll);
    const err = Math.abs(head.roll - ideal.roll);
    q = need > 0.04 ? Math.max(0, Math.min(1, 1 - err / Math.max(0.08, need))) : 0.55;
    if (need > 0.04) { st.lean.sum += q * dt; st.lean.n += dt; }
  }
  st._prevHead = { x: head.x, z: head.z };
  st.quality += (q - st.quality) * Math.min(1, dt * 3);
}

/* --------------------------------------------------------- capture time */
capture._sessT0 = 0;
const _origPush = capture.push.bind(capture);
capture.push = (p) => {
  if (!capture._sessT0) capture._sessT0 = performance.now() / 1000;
  p.t = performance.now() / 1000 - capture._sessT0;
  return _origPush(p);
};
const _origReset = capture.reset.bind(capture);
capture.reset = (m) => {
  capture._sessT0 = performance.now() / 1000;
  return _origReset(m);
};

/* ----------------------------------------------------------- main loop */
let last = performance.now();

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const tAbs = now / 1000;

  st.calm += ((st.calmHeld ? 1 : 0) - st.calm) * Math.min(1, dt * 2);
  if (!renderer.xr.isPresenting) {
    if (st.phase === -1) {
      // home backdrop: slow, calm look around the hall
      camera.rotation.set(0.05 + 0.03 * Math.sin(tAbs * 0.13), 0.32 * Math.sin(tAbs * 0.07) + 0.12, 0);
    } else {
      camera.rotation.set(st.looking.pitch, st.looking.yaw, 0);
    }
  }

  tickFade(dt);
  tickPanelOpacity(worldPanel, dt);

  st.hover = renderer.xr.isPresenting ? updatePointers() : st.mouseHover ?? null;
  if (!renderer.xr.isPresenting) updatePointers();
  if (st.action) {
    const a = st.action;
    st.action = null;
    runAction(a, tAbs);
  }

  const confirm = st.confirmPulse && !st.pending;
  const retry = st.retryPulse && !st.pending;
  st.confirmPulse = false;
  st.retryPulse = false;

  let stage = null;
  let prog = 0;
  let remain = 0;

  if (st.phase === 0) {
    stage = 'wait';
    if (confirm) {
      if (!st.briefingDone && guideAudio.speaking) {
        guideAudio.skipVoice();
        st.briefingDone = true;
      } else {
        st.briefingDone = true;
        capture.mark('ready');
        guideAudio.stopVoice();
        st.phase = 1;
        st.menu = false;
        st.t0 = tAbs;
        setPanelOpacityTarget(worldPanel, 0);
        sfx.chime('confirm');
        haptic(0.3, 50);
        guideAudio.play('settle');
      }
    }
  } else if (st.phase === 1) {
    stage = 'countdown';
    remain = Math.max(0, test.introSec - (tAbs - st.t0));
    if (remain <= 0) startTrial(tAbs);
  } else if (st.phase === 2) {
    stage = 'trial';
    const trialT = tAbs - st.t0;
    let sample;
    let speed = 0;
    let done;
    headWorldPose();
    if (test.trialKind === 'ride') {
      // Grip / Space = full stop (comfort). Hold ~1.6 s while stopped → leave the room.
      const rate = (1 - st.calm) * speedScale;
      st.tau += dt * rate;
      const p = profile.at(st.tau);
      st.s = p.s;
      speed = p.v * (1 - st.calm) * speedScale;
      sample = course.sample(st.s);
      applyInversePath(sample);
      prog = course.length > 0 ? st.s / course.length : 1;
      done = st.tau >= profile.T;
      if (st.calmHeld && rate < 0.05) {
        st.stopHold += dt;
        if (st.stopHold >= 1.6) {
          finishChamber({ aborted: true, stopped: true });
          return;
        }
      } else {
        st.stopHold = 0;
      }
    } else {
      sample = course.sample(0);
      prog = Math.min(1, (trialT * speedScale) / test.trialSec);
      done = trialT * speedScale >= test.trialSec;
      // Still rooms: long grip/Space also exits if feeling unwell.
      if (st.calmHeld) {
        st.stopHold += dt;
        if (st.stopHold >= 1.6) {
          finishChamber({ aborted: true, stopped: true });
          return;
        }
      } else {
        st.stopHold = 0;
      }
    }
    const head = headWorldPose();
    updateSteps(dt, prog);
    const ideal = test.protocol === 'seated'
      ? { yaw: 0, pitch: 0, roll: idealRoll(sample.curvature) }
      : { yaw: 0, pitch: 0, roll: 0 };
    updateQuality(dt, head, ideal);
    sfx.setMotion(speed);
    st.trialTime += dt;
    if (st.calmHeld) st.calmTime += dt;
    capture.push({
      t: 0,
      phase: test.trialKind === 'still' ? 0 : 1,
      path: { s: sample.s, speed, curvature: sample.curvature, yaw: sample.yaw, x: sample.x, y: sample.y, z: sample.z, grade: sample.grade },
      head,
      ideal,
      calm: st.calm,
    });
    if (capture.samples.length % 3 === 0) viz.drawLive(capture.samples, capture.rmsErrors(5));
    if (done) finishChamber();
  } else if (st.phase === 3) {
    stage = 'done';
    prog = 1;
    if (confirm) transition(() => setupChamber((nextTest() ?? PLAYABLE[0]).id));
    else if (retry) transition(() => setupChamber(test.id));
  }

  if (stage !== 'trial') st.quality += (0.5 - st.quality) * Math.min(1, dt * 1.5);
  const roomState = { stage, progress: prog, time: tAbs, calm: st.calm, quality: st.quality };
  if (set) set.update(dt, roomState);
  if (room) room.update(dt, roomState);

  // Guide card — only repainted while visible, ~30 Hz
  if (worldPanel.material.opacity > 0.01 && tAbs - st.lastPaint > 1 / 30) {
    st.lastPaint = tAbs;
    paintWorldPanel(worldPanel, {
      test,
      course,
      hall: room?.info,
      stage: stage === 'done' ? 'done' : 'wait',
      stepIndex: st.stepIndex,
      time: tAbs,
      briefingDone: st.briefingDone,
      feedback: st.feedback,
      doneAt: st.doneAt,
      next: nextTest(),
      menu: st.menu,
      hover: st.hover,
      tests: PLAYABLE,
      chapters: CHAPTERS,
      completed: progress.completed,
      index: Math.max(0, PLAYABLE.indexOf(test)),
      styles: STYLES_UI,
      envStyle,
      musicOn: guideAudio.musicOn,
      voiceOn: guideAudio.voiceOn,
      speedScale,
    });
  }

  if (st.phase >= 0) {
    statusEl.textContent = stage === 'wait'
      ? `ROOM ${test.chamber} · ${st.briefingDone ? 'waiting for ready' : 'listening…'}`
      : stage === 'countdown' ? `ROOM ${test.chamber} · settle ${Math.ceil(remain)}`
        : stage === 'trial' ? `ROOM ${test.chamber} · ${(prog * 100).toFixed(0)}%`
          : statusEl.textContent;
  }

  scene.updateMatrixWorld();
  room?.beforeRender();
  renderer.render(scene, camera);
});

/* -------------------------------------------------------------- boot */
(async () => {
  window.__mg5.buildRoomFor = buildRoomFor;
  window.__mg5.runAction = runAction;
  window.__mg5.poseAt = (f) => applyInversePath(course.sample(f * course.length));
  testSel.value = continueId();
  showTestDesc();
  renderHero();
  renderRail();
  renderStylePicker();
  refreshSpeedChip();
  document.getElementById('speedChip')?.addEventListener('click', () => {
    if (st.phase === 0 || st.phase === 3) {
      st.menu = 'settings';
      st.lastPaint = 0;
      setPanelOpacityTarget(worldPanel, 1);
      return;
    }
    st.openSettingsOnEnter = true;
    statusEl.textContent = `Speed ${speedLabel()} — settings open on the hall card when you start.`;
  });
  window.__mg5.envStyle = () => envStyle;
  try {
    buildRoomFor(testSel.value);
    st.ready = true;
    goBtn.disabled = false;
    goFlat.disabled = false;
    statusEl.textContent = 'Ready';
  } catch (e) {
    console.error(e);
    statusEl.textContent = 'Room build failed: ' + e.message;
    goBtn.textContent = 'Load failed';
  }

  let vrOk = false;
  try { vrOk = !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')); } catch (e) { /* */ }
  const resume = progress.last && progress.completed.size > 0;
  goBtn.textContent = vrOk ? 'Enter VR' : 'Start';
  goBtn.onclick = () => begin(vrOk);
  goFlat.onclick = () => begin(false);
  goFlat.style.display = vrOk ? '' : 'none';
  document.getElementById('heroHint').textContent = vrOk
    ? (resume
      ? 'Continuing where you left off. Grip stops motion fully; hold to leave a room early.'
      : 'Put on your headset, then Enter VR. Grip stops motion fully if you feel unwell; hold to leave the room.')
    : 'No headset — halls play on screen. Drag to look; Space stops motion (hold to leave). Click to continue.';
  window.__mg5.bootDone = true;
})();
