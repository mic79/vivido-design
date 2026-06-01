/**
 * Ambient fall + wingsuit glide layers (Web Audio).
 * Playback rates follow airspeed — smoothed `.value` writes for reliable
 * Quest / WebAudio behaviour (avoids stacked `setTargetAtTime` on params).
 */

import { MathUtils } from "three";

const AudioCtx = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;

const BASE = new URL("../../audio/", import.meta.url);

/** @type {AudioContext | null} */
let ctx = null;
/** @type {{ fall: AudioBuffer | null, flap: AudioBuffer | null, wind: AudioBuffer | null }} */
const buffers = { fall: null, flap: null, wind: null };
let loadPromise = null;
let graphReady = false;

/** @type {GainNode | null} */
let gOut = null;
/** @type {GainNode | null} */
let gFall = null;
/** @type {GainNode | null} */
let gFlap = null;
/** @type {GainNode | null} */
let gWind = null;
/** @type {AudioBufferSourceNode | null} */
let srcFall = null;
/** @type {AudioBufferSourceNode | null} */
let srcFlap = null;
/** @type {AudioBufferSourceNode | null} */
let srcWind = null;
let sourcesStarted = false;

/** Smoothed playback rates (heard swoosh follows speed). */
let smFallRate = 1;
let smWindRate = 1;
let smFlapRate = 1;

function getCtx() {
  if (!AudioCtx) return null;
  if (!ctx) ctx = new AudioCtx();
  return ctx;
}

async function decodeOne(c, rel, optional) {
  const url = new URL(rel, BASE).href;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const ab = await res.arrayBuffer();
    return await c.decodeAudioData(ab.slice(0));
  } catch (e) {
    if (!optional) console.warn("[glideAudio] failed to load", rel, e);
    return null;
  }
}

export function preloadGlideAudio() {
  if (loadPromise) return loadPromise;
  const c = getCtx();
  if (!c) {
    loadPromise = Promise.resolve();
    return loadPromise;
  }
  loadPromise = (async () => {
    const [fall, flap, windPrimary] = await Promise.all([
      decodeOne(c, "533085__myssyf__wind-and-palm.wav", false),
      decodeOne(c, "138979__huggy13ear__nylon-flapping-1.wav", false),
      decodeOne(c, "464108__bruce965__soaring-clouds.mp3", false),
    ]);
    buffers.fall = fall;
    buffers.flap = flap;
    let wind = windPrimary;
    if (!wind) {
      wind = await decodeOne(c, "464108__bruce965__soaring-clouds.flac", true);
    }
    if (!wind) {
      console.warn("[glideAudio] wind not loaded — check GTAVR/audio/464108__bruce965__soaring-clouds.mp3");
    }
    buffers.wind = wind;
  })();
  return loadPromise;
}

export function resumeGlideAudio() {
  const c = getCtx();
  if (c?.state === "suspended") c.resume().catch(() => {});
}

/** Stop all glide layers (call on XR session end / when not in headset). */
export function muteGlideAudio() {
  if (!ctx || !graphReady) return;
  const t = ctx.currentTime;
  try {
    if (gFall) {
      gFall.gain.cancelScheduledValues(t);
      gFall.gain.setValueAtTime(0, t);
    }
    if (gFlap) {
      gFlap.gain.cancelScheduledValues(t);
      gFlap.gain.setValueAtTime(0, t);
    }
    if (gWind) {
      gWind.gain.cancelScheduledValues(t);
      gWind.gain.setValueAtTime(0, t);
    }
  } catch (_) { /* ignore */ }
  smFallRate = 1;
  smWindRate = 1;
  smFlapRate = 1;
}

function ensureGraph() {
  const c = getCtx();
  if (!c) return false;
  if (!buffers.fall && !buffers.flap) return false;
  if (graphReady) return true;
  gOut = c.createGain();
  gOut.gain.value = 0.48;
  gOut.connect(c.destination);

  if (buffers.fall) {
    gFall = c.createGain();
    gFall.gain.value = 0;
    gFall.connect(gOut);
    srcFall = c.createBufferSource();
    srcFall.buffer = buffers.fall;
    srcFall.loop = true;
    srcFall.connect(gFall);
  }
  if (buffers.flap) {
    gFlap = c.createGain();
    gFlap.gain.value = 0;
    gFlap.connect(gOut);
    srcFlap = c.createBufferSource();
    srcFlap.buffer = buffers.flap;
    srcFlap.loop = true;
    srcFlap.connect(gFlap);
  }
  if (buffers.wind) {
    gWind = c.createGain();
    gWind.gain.value = 0;
    gWind.connect(gOut);
    srcWind = c.createBufferSource();
    srcWind.buffer = buffers.wind;
    srcWind.loop = true;
    srcWind.connect(gWind);
  }
  graphReady = true;
  return true;
}

/** If wind decoded after the first `ensureGraph`, wire it in and start (sources may already run). */
function ensureWindBranch_() {
  const c = ctx;
  if (!c || !buffers.wind || gWind || !gOut || !graphReady) return;
  gWind = c.createGain();
  gWind.gain.value = 0;
  gWind.connect(gOut);
  srcWind = c.createBufferSource();
  srcWind.buffer = buffers.wind;
  srcWind.loop = true;
  srcWind.connect(gWind);
  if (sourcesStarted) {
    try {
      srcWind.start(0);
    } catch (e) {
      console.warn("[glideAudio] wind branch late start:", e);
    }
  }
}

function startSourcesOnce() {
  const c = getCtx();
  if (!c || sourcesStarted) return;
  try {
    if (srcFall) srcFall.start(0);
    if (srcFlap) srcFlap.start(0);
    if (srcWind) srcWind.start(0);
    sourcesStarted = true;
  } catch (e) {
    console.warn("[glideAudio] start:", e);
  }
}

/**
 * @param {{ dt: number, falling: boolean, gliding: boolean, horizSpeed: number, totalSpeed?: number, locomotionSpeed?: number }} opts
 * `locomotionSpeed` — e.g. stick×moveSpeed while grounded (rig `velocity` stays ~0). Wind + flap use max(rig, that).
 */
export function tickGlideAudio(opts) {
  const { dt, falling, gliding, horizSpeed, totalSpeed, locomotionSpeed } = opts;
  if (!getCtx()) return;
  resumeGlideAudio();
  if (!buffers.fall && !buffers.flap) return;
  if (!ensureGraph()) return;
  ensureWindBranch_();
  startSourcesOnce();

  const c = ctx;
  const t = c.currentTime;
  const rigAir =
    typeof totalSpeed === "number" && Number.isFinite(totalSpeed)
      ? totalSpeed
      : horizSpeed;
  const loc =
    typeof locomotionSpeed === "number" && Number.isFinite(locomotionSpeed) ? locomotionSpeed : 0;
  const air = Math.max(0, rigAir, loc);
  const n = Math.min(Math.max(air / 7.2, 0), 1.75);
  const targetFall = 0.58 + n * 0.92;
  /* Wind pitch: silent below 5 m/s; above that start a bit low (still audible) and rise with excess speed. */
  const airAboveWind = Math.max(0, air - 5);
  const nWind = Math.min(airAboveWind / 11, 1.65);
  const targetWind = buffers.wind ? Math.min(1.9, 0.64 + nWind * 1.02) : 1;
  const targetFlap = 0.62 + n * 0.95;

  const k = Math.min(1, 22 * Math.min(0.08, Math.max(0.001, dt || 0.016)));
  smFallRate += (targetFall - smFallRate) * k;
  smWindRate += (targetWind - smWindRate) * k;
  smFlapRate += (targetFlap - smFlapRate) * k;

  if (srcFall) srcFall.playbackRate.value = smFallRate;
  if (srcWind) srcWind.playbackRate.value = smWindRate;
  if (srcFlap) {
    srcFlap.playbackRate.value = smFlapRate;
    const cents = -200 + n * 600;
    try {
      srcFlap.detune.setTargetAtTime(cents, t, 0.04);
    } catch (_) {
      /* detune unsupported on some paths */
    }
  }
  if (srcWind) {
    const windCents = -320 + nWind * 580;
    try {
      srcWind.detune.setTargetAtTime(windCents, t, 0.045);
    } catch (_) {
      /* detune unsupported */
    }
  }

  /* Wind: exactly 0 gain at ≤5 m/s; above that one curve (avoid double‑gate killing 5–9 m/s). */
  const swooshAud =
    MathUtils.smoothstep(0.2, 3.8, air) * Math.min(1, 0.1 + 0.9 * Math.pow(air / 12, 0.72));
  const flapTgt = gliding && gFlap ? 0.22 * swooshAud : 0;
  const windExcess = Math.max(0, air - 5);
  const windVol = windExcess <= 0 ? 0 : Math.min(1, Math.pow(windExcess / 9.5, 0.38));
  const windTgt = gWind && buffers.wind ? Math.min(0.784, 0.704 * windVol) : 0;
  const fallTgt = falling && gFall ? 0.42 * (0.25 + 0.75 * Math.min(1, air / 16)) : 0;
  if (gFall) gFall.gain.setTargetAtTime(fallTgt, t, 0.08);
  if (gFlap) gFlap.gain.setTargetAtTime(flapTgt, t, 0.07);
  if (gWind) gWind.gain.setTargetAtTime(windTgt, t, 0.09);
}
