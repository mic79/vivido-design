// ========================================
// RTSVR2 — Audio Manager
// Sound pool for spatial audio
// ========================================

import { AUDIO_BASE_PATH, SOUND_EFFECTS } from './config.js';

const pools = {};
const POOL_SIZE = 5;
let listenerReady = false;
let audioContext = null;

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

export function playSound(soundKey, volume = 0.3) {
  const pool = pools[soundKey];
  if (!pool) return;

  // Find an available (not playing) audio element
  for (const audio of pool) {
    if (audio.paused || audio.ended) {
      audio.volume = Math.min(1, Math.max(0, volume));
      audio.currentTime = 0;
      audio.play().catch(() => {}); // Ignore autoplay restrictions
      return;
    }
  }

  // All busy — force-restart the first one
  const audio = pool[0];
  audio.volume = Math.min(1, Math.max(0, volume));
  audio.currentTime = 0;
  audio.play().catch(() => {});
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
    // Non-weapon callers (engineer capture, etc.) must not fall through to rifleShot — that sounded like looping gunfire.
    case 'impact': playSound('impact', 0.22); break;
    case 'unitReady': playSound('unitReady', 0.4); break;
    default: playSound('rifleShot', 0.15); break;
  }
}

export function playExplosionSound(volume = 0.4) {
  playSound('explosion', volume);
}

export function playBuildCompleteSound() {
  playSound('buildComplete', 0.5);
}

export function playUnitReadySound() {
  playSound('unitReady', 0.4);
}
