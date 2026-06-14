// ========================================
// RTSVR3 — Audio Manager
// Web Audio spatial pool (HRTF panner) + flat UI sounds
// ========================================

import {
  AUDIO_BASE_PATH,
  SOUND_EFFECTS,
  AUDIO_SPATIAL_REF_DISTANCE,
  AUDIO_SPATIAL_MAX_DISTANCE,
  AUDIO_SPATIAL_ROLLOFF,
} from './config.js';
import { sampleMoonTerrainWorldYCached } from './moon-environment.js';

const POOL_SIZE = 5;
const SPATIAL_VOICE_COUNT = 14;
const FLAT_VOICE_COUNT = 6;

/** Per-key minimum gap between plays (reduces machine-gun stacking on rapid events). */
const SOUND_MIN_GAP_MS = {
  rifleShot: 52,
  rocketShot: 70,
  sniperShot: 55,
  tankShot: 85,
  artilleryShot: 80,
  explosion: 100,
  buildComplete: 400,
  unitReady: 200,
  captureTick: 400,
  uiTick: 70,
  default: 32,
};
const lastSoundPlayAt = {};
let lastTouchUiSoundAt = 0;
const TOUCH_UI_SOUND_GAP_MS = 95;

/** Below 1 = lower pitch + slightly longer. */
const BUILD_COMPLETE_PLAYBACK_RATE = 0.78;

let audioContext = null;
let buffersReady = false;
/** @type {Record<string, AudioBuffer>} */
const buffers = {};
const spatialVoices = [];
const flatVoices = [];

let _camPosVec = null;
let _camFwdVec = null;

function ensureAudioContext() {
  if (audioContext) return audioContext;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioContext = new Ctx();
  return audioContext;
}

function setPannerPosition(panner, x, y, z) {
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    panner.setPosition(x, y, z);
  }
}

function createSpatialVoice(ctx) {
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = AUDIO_SPATIAL_REF_DISTANCE;
  panner.maxDistance = AUDIO_SPATIAL_MAX_DISTANCE;
  panner.rolloffFactor = AUDIO_SPATIAL_ROLLOFF;
  panner.coneInnerAngle = 360;
  panner.coneOuterAngle = 360;
  panner.coneOuterGain = 0;

  const gain = ctx.createGain();
  gain.connect(panner);
  panner.connect(ctx.destination);

  return { busy: false, gain, panner, source: null };
}

function createFlatVoice(ctx) {
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  return { busy: false, gain, source: null };
}

async function loadSoundBuffers(ctx) {
  const byFile = new Map();
  const entries = Object.entries(SOUND_EFFECTS);

  for (const [key, filename] of entries) {
    if (byFile.has(filename)) {
      buffers[key] = byFile.get(filename);
      continue;
    }
    try {
      const res = await fetch(AUDIO_BASE_PATH + filename);
      if (!res.ok) continue;
      const ab = await res.arrayBuffer();
      const decoded = await ctx.decodeAudioData(ab);
      byFile.set(filename, decoded);
      buffers[key] = decoded;
    } catch (_) {
      /* missing file or decode error — skip key */
    }
  }
  buffersReady = Object.keys(buffers).length > 0;
}

export function initAudio() {
  document.addEventListener('click', resumeAudio, { once: true });
  document.addEventListener('touchstart', resumeAudio, { once: true });
}

export function resumeAudio() {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  if (spatialVoices.length === 0) {
    for (let i = 0; i < SPATIAL_VOICE_COUNT; i++) {
      spatialVoices.push(createSpatialVoice(ctx));
    }
    for (let i = 0; i < FLAT_VOICE_COUNT; i++) {
      flatVoices.push(createFlatVoice(ctx));
    }
  }

  if (!buffersReady) {
    loadSoundBuffers(ctx).catch(() => {});
  }
}

/** Call each frame so VR / pan camera updates left-right and distance cues. */
export function updateListenerFromCamera() {
  const ctx = ensureAudioContext();
  if (!ctx) return;

  const cam =
    (typeof document !== 'undefined' && document.querySelector('a-scene')?.camera) ||
    null;
  if (!cam || !cam.getWorldPosition) return;

  const THREE = window.THREE;
  if (!THREE?.Vector3) return;

  if (!_camPosVec) {
    _camPosVec = new THREE.Vector3();
    _camFwdVec = new THREE.Vector3();
  }
  const pos = _camPosVec;
  const fwd = _camFwdVec;

  cam.getWorldPosition(pos);
  cam.getWorldDirection(fwd);

  const listener = ctx.listener;
  if (listener.positionX) {
    listener.positionX.value = pos.x;
    listener.positionY.value = pos.y;
    listener.positionZ.value = pos.z;
    listener.forwardX.value = fwd.x;
    listener.forwardY.value = fwd.y;
    listener.forwardZ.value = fwd.z;
    listener.upX.value = 0;
    listener.upY.value = 1;
    listener.upZ.value = 0;
  } else if (listener.setPosition) {
    listener.setPosition(pos.x, pos.y, pos.z);
    listener.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
  }
}

function soundWorldY(x, z, yHint) {
  if (Number.isFinite(yHint)) return yHint;
  if (Number.isFinite(x) && Number.isFinite(z)) {
    return sampleMoonTerrainWorldYCached({ x, z }, x, z) + 1.1;
  }
  return 1.2;
}

function acquireVoice(pool) {
  for (const v of pool) {
    if (!v.busy) return v;
  }
  return pool[0] || null;
}

function stopVoiceSource(voice) {
  if (!voice.source) return;
  try {
    voice.source.onended = null;
    voice.source.stop(0);
  } catch (_) { /* already stopped */ }
  try {
    voice.source.disconnect();
  } catch (_) { /* ignore */ }
  voice.source = null;
  voice.busy = false;
}

function canPlaySoundKey(soundKey) {
  const now = performance.now();
  const minGap = SOUND_MIN_GAP_MS[soundKey] ?? SOUND_MIN_GAP_MS.default;
  const prev = lastSoundPlayAt[soundKey];
  if (prev != null && now - prev < minGap) return false;
  lastSoundPlayAt[soundKey] = now;
  return true;
}

function playBufferOnVoice(voice, buffer, volume, playbackRate) {
  const ctx = ensureAudioContext();
  if (!ctx || !buffer || !voice) return;

  stopVoiceSource(voice);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = playbackRate;
  source.connect(voice.gain);
  voice.gain.gain.value = Math.min(1, Math.max(0, volume));
  voice.source = source;
  voice.busy = true;
  source.onended = () => {
    voice.busy = false;
    voice.source = null;
  };
  source.start(0);
}

/**
 * @param {string} soundKey
 * @param {number} [volume]
 * @param {number} [playbackRate=1]
 * @param {number} [worldX]
 * @param {number} [worldZ]
 * @param {number} [worldY]
 */
export function playSound(soundKey, volume = 0.3, playbackRate = 1, worldX, worldZ, worldY) {
  resumeAudio();
  if (!buffersReady || !canPlaySoundKey(soundKey)) return;

  const buffer = buffers[soundKey];
  if (!buffer) return;

  const rate = Math.min(4, Math.max(0.25, playbackRate));
  const spatial = Number.isFinite(worldX) && Number.isFinite(worldZ);

  if (spatial) {
    const voice = acquireVoice(spatialVoices);
    if (!voice) return;
    const y = soundWorldY(worldX, worldZ, worldY);
    setPannerPosition(voice.panner, worldX, y, worldZ);
    playBufferOnVoice(voice, buffer, volume, rate);
    return;
  }

  const voice = acquireVoice(flatVoices);
  if (!voice) return;
  playBufferOnVoice(voice, buffer, volume, rate);
}

function playSpatial(soundKey, x, z, volume, playbackRate = 1, yHint) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    playSound(soundKey, volume, playbackRate);
    return;
  }
  const y = soundWorldY(x, z, yHint);
  playSound(soundKey, volume, playbackRate, x, z, y);
}

/** Soft tick for touchscreen UI / command confirmation (throttled, non-spatial). */
export function playTouchUiSound() {
  const now = performance.now();
  if (now - lastTouchUiSoundAt < TOUCH_UI_SOUND_GAP_MS) return;
  lastTouchUiSoundAt = now;
  playSound('uiTick', 0.06);
}

export function playShotSound(unitType, x, z) {
  switch (unitType) {
    case 'rifleman': playSpatial('rifleShot', x, z, 0.2); break;
    case 'rocketSoldier': playSpatial('rocketShot', x, z, 0.3); break;
    case 'sniper': playSpatial('sniperShot', x, z, 0.25); break;
    case 'scoutBike': playSpatial('rifleShot', x, z, 0.15); break;
    case 'apc': playSpatial('rifleShot', x, z, 0.2); break;
    case 'lightTank': playSpatial('tankShot', x, z, 0.3); break;
    case 'heavyTank': playSpatial('tankShot', x, z, 0.4); break;
    case 'artillery': playSpatial('artilleryShot', x, z, 0.35); break;
    case 'harvester': playSpatial('rifleShot', x, z, 0.07); break;
    case 'mobileHq': playSpatial('uiTick', x, z, 0.05); break;
    default: playSpatial('rifleShot', x, z, 0.15); break;
  }
}

export function playExplosionSound(volume = 0.4, x, z) {
  playSpatial('explosion', x, z, volume);
}

export function playBuildCompleteSound(x, z) {
  playSpatial('buildComplete', x, z, 0.4, BUILD_COMPLETE_PLAYBACK_RATE);
}

export function playUnitReadySound(x, z) {
  playSpatial('unitReady', x, z, 0.4);
}

export function playCaptureTickSound(x, z) {
  playSpatial('captureTick', x, z, 0.1);
}
