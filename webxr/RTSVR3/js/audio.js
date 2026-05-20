// ========================================
// RTSVR2 — Audio Manager
// Sound pool for spatial audio
// ========================================

import { AUDIO_BASE_PATH, SOUND_EFFECTS } from './config.js';

const pools = {};
const POOL_SIZE = 5;
let listenerReady = false;
let audioContext = null;

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

/** Below 1 = lower pitch + slightly longer (HTMLAudioElement; preservesPitch off). */
const BUILD_COMPLETE_PLAYBACK_RATE = 0.78;

export function initAudio() {
  // Audio context will be created on first user interaction
  document.addEventListener('click', resumeAudio, { once: true });
  document.addEventListener('touchstart', resumeAudio, { once: true });

  // Preload all sounds
  for (const [key, filename] of Object.entries(SOUND_EFFECTS)) {
    pools[key] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const audio = new Audio(AUDIO_BASE_PATH + filename);
      audio.preload = 'auto';
      audio.volume = 0.3;
      pools[key].push(audio);
    }
  }
}

function resumeAudio() {
  // Try to resume any suspended audio contexts
  if (window.AudioContext || window.webkitAudioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
  }
  listenerReady = true;
}

/**
 * @param {string} soundKey
 * @param {number} [volume]
 * @param {number} [playbackRate=1] 0.25–4; values below 1 lower pitch (and slightly slow playback) when preservesPitch is false.
 */
export function playSound(soundKey, volume = 0.3, playbackRate = 1) {
  const pool = pools[soundKey];
  if (!pool) return;

  const now = performance.now();
  const minGap = SOUND_MIN_GAP_MS[soundKey] ?? SOUND_MIN_GAP_MS.default;
  const prev = lastSoundPlayAt[soundKey];
  if (prev != null && now - prev < minGap) return;
  lastSoundPlayAt[soundKey] = now;

  const rate = Math.min(4, Math.max(0.25, playbackRate));

  const applyAndPlay = (audio) => {
    try {
      audio.preservesPitch = false;
    } catch (_) { /* ignore */ }
    audio.playbackRate = rate;
    audio.volume = Math.min(1, Math.max(0, volume));
    audio.currentTime = 0;
    audio.play().catch(() => {}); // Ignore autoplay restrictions
  };

  for (const audio of pool) {
    if (audio.paused || audio.ended) {
      applyAndPlay(audio);
      return;
    }
  }

  const audio = pool[0];
  audio.pause();
  applyAndPlay(audio);
}

/** Soft tick for touchscreen UI / command confirmation (throttled). */
export function playTouchUiSound() {
  const now = performance.now();
  if (now - lastTouchUiSoundAt < TOUCH_UI_SOUND_GAP_MS) return;
  lastTouchUiSoundAt = now;
  playSound('uiTick', 0.06);
}

// Maps unit category to sound
export function playShotSound(unitType) {
  switch (unitType) {
    case 'rifleman': playSound('rifleShot', 0.2); break;
    case 'rocketSoldier': playSound('rocketShot', 0.3); break;
    case 'sniper': playSound('sniperShot', 0.25); break;
    case 'scoutBike': playSound('rifleShot', 0.15); break;
    case 'apc': playSound('rifleShot', 0.2); break;
    case 'lightTank': playSound('tankShot', 0.3); break;
    case 'heavyTank': playSound('tankShot', 0.4); break;
    case 'artillery': playSound('artilleryShot', 0.35); break;
    case 'harvester': playSound('rifleShot', 0.07); break;
    case 'mobileHq': playSound('uiTick', 0.05); break;
    case 'unitReady': playSound('unitReady', 0.4); break;
    default: playSound('rifleShot', 0.15); break;
  }
}

export function playExplosionSound(volume = 0.4) {
  playSound('explosion', volume);
}

export function playBuildCompleteSound() {
  playSound('buildComplete', 0.4, BUILD_COMPLETE_PLAYBACK_RATE);
}

export function playUnitReadySound() {
  playSound('unitReady', 0.4);
}

/** Engineer capture progress — not a weapon impact (avoid metal-hit misuse). */
export function playCaptureTickSound() {
  playSound('captureTick', 0.1);
}
