// voice.js
// 100% on-device voice I/O for the LiteRT prototype — no cloud, and no Web
// Speech API (neither SpeechRecognition nor speechSynthesis), so it works in
// the Meta Quest browser.
//
//   INPUT  : getUserMedia (raw PCM) -> mono 16 kHz -> on-device Whisper
//            (Transformers.js, WASM/WebGPU) -> text.
//            [Web Gemma 4 is text-only, so this local ASR replaces the
//             unavailable native audio-in / browser SpeechRecognition.]
//   OUTPUT : on-device Kokoro TTS (Transformers.js, WASM/WebGPU) -> audio,
//            played through a Web Audio PannerNode for true 3D spatial voice
//            in WebXR (replaces the robotic, non-spatial speechSynthesis).
//
// All classes are DOM-free; they work in flat pages and inside A-Frame/WebXR.

// CDN module sources (pinned for reproducibility).
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';
const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const TARGET_SR = 16000; // Whisper / Gemma audio frontends expect 16 kHz mono

let _tf = null;
async function importTransformers() {
  if (!_tf) _tf = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  return _tf;
}
let _kokoro = null;
async function importKokoro() {
  if (!_kokoro) _kokoro = await import(/* @vite-ignore */ KOKORO_URL);
  return _kokoro;
}

/** Resolve a Transformers.js device: 'auto' -> 'webgpu' if usable, else 'wasm'. */
let _webgpuOk = null;
async function pickDevice(preferred = 'auto') {
  if (preferred && preferred !== 'auto') return preferred;
  if (_webgpuOk === null) {
    try {
      _webgpuOk = !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
    } catch { _webgpuOk = false; }
  }
  return _webgpuOk ? 'webgpu' : 'wasm';
}
/** Default dtype per kind. Whisper MUST be fp32 — q8 produces garbled,
 *  repeating, multilingual hallucinations. Kokoro is fine at fp32 too. */
function defaultDtype(device, kind) {
  if (kind === 'asr') return 'fp32';
  return device === 'webgpu' ? 'fp32' : 'q8';
}

// ---------------------------------------------------------------------------
// Microphone capture (raw PCM -> mono 16 kHz)
// ---------------------------------------------------------------------------

export class MicRecorder {
  constructor() {
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.recording = false;
  }

  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
              typeof MediaRecorder !== 'undefined');
  }

  async init() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  }

  async start() {
    await this.init();
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start();
    this.recording = true;
  }

  /** Stop and return a mono 16 kHz AudioBuffer. */
  async stop() {
    if (!this.recorder || !this.recording) throw new Error('Not recording.');
    const blob = await new Promise((resolve) => {
      this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' }));
      this.recorder.stop();
    });
    this.recording = false;
    return blobToMono16k(blob);
  }

  dispose() {
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    this.stream = null;
    this.recorder = null;
  }
}

export async function blobToMono16k(blob) {
  const arrayBuf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    ctx.close && ctx.close();
  }
  return resampleToMono(decoded, TARGET_SR);
}

export async function resampleToMono(audioBuffer, targetRate = TARGET_SR) {
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * targetRate));
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new OAC(1, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

/** mono AudioBuffer (or Float32Array) -> Float32Array for the ASR pipeline. */
export function toFloat32(audio) {
  if (audio instanceof Float32Array) return audio;
  if (audio && typeof audio.getChannelData === 'function') return audio.getChannelData(0);
  throw new Error('Expected an AudioBuffer or Float32Array.');
}

/**
 * Strip Markdown / formatting so the TTS doesn't read symbols aloud
 * (e.g. "**Hallo!**" or "* English Meaning:" -> spoken cleanly).
 */
export function cleanForSpeech(text) {
  if (!text) return '';
  let s = text;
  s = s.replace(/```[\s\S]*?```/g, ' ');            // fenced code blocks
  s = s.replace(/`([^`]+)`/g, '$1');                // inline code
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');      // images
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');    // links -> link text
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');         // headings
  s = s.replace(/^\s*>\s?/gm, '');                  // blockquotes
  s = s.replace(/^\s*[-*+]\s+/gm, '');              // bullet markers
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');         // bold
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');            // italic
  s = s.replace(/~~(.*?)~~/g, '$1');                // strikethrough
  s = s.replace(/^\s*([-*_]\s*){3,}$/gm, ' ');      // horizontal rules
  s = s.replace(/[*_#`>~|]/g, '');                  // any stray markdown chars
  s = s.replace(/\s{2,}/g, ' ').replace(/\n{2,}/g, '\n');
  return s.trim();
}

/** Safety net: collapse a phrase that repeats back-to-back (hallucination). */
export function collapseRepeats(text) {
  if (!text) return '';
  const words = text.split(/\s+/);
  // If the text is one block repeated, keep a single copy.
  for (let unit = 1; unit <= Math.floor(words.length / 2); unit++) {
    const first = words.slice(0, unit).join(' ');
    let repeats = 1;
    while (words.slice(repeats * unit, (repeats + 1) * unit).join(' ') === first && first) repeats++;
    if (repeats * unit >= words.length - unit && repeats >= 3) return first;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Speech-to-text: on-device Whisper (Transformers.js)
// ---------------------------------------------------------------------------

export class Transcriber {
  constructor({ modelId = 'onnx-community/whisper-base', device = 'auto', dtype = null, language = null } = {}) {
    this.modelId = modelId;
    this.device = device;   // 'auto' | 'webgpu' | 'wasm'
    this.dtype = dtype;     // null = auto per device
    this.language = language; // null = auto-detect; or e.g. 'en', 'nl'
    this.asr = null;
    this.ready = false;
  }

  static isSupported() { return MicRecorder.isSupported(); }

  async load(onProgress = null) {
    if (this.ready) return this;
    const device = await pickDevice(this.device);
    const dtype = this.dtype || defaultDtype(device, 'asr');
    const { pipeline } = await importTransformers();
    this.asr = await pipeline('automatic-speech-recognition', this.modelId, {
      device,
      dtype,
      progress_callback: onProgress || undefined,
    });
    this.resolvedDevice = device;
    this.ready = true;
    return this;
  }

  /**
   * Fully prepare the model so the first real transcription is fast: this both
   * downloads/instantiates the pipeline AND runs one dummy inference, which is
   * what actually compiles the WebGPU shaders / WASM kernels (load() alone does
   * not). Call this at app start, not on first mic use.
   */
  async warmup(onProgress = null) {
    if (this._warmed) return this;
    await this.load(onProgress);
    try {
      // ~1s of low-level noise; goes straight through the pipeline (bypassing
      // the silence guard in transcribe) purely to trigger kernel compilation.
      const data = new Float32Array(TARGET_SR);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() - 0.5) * 0.02;
      await this.asr(data, {
        task: 'transcribe',
        language: this.language || undefined,
        chunk_length_s: 30,
        return_timestamps: false,
        temperature: 0,
      });
    } catch (_) {}
    this._warmed = true;
    return this;
  }

  /** Transcribe a mono 16 kHz AudioBuffer / Float32Array to text. */
  async transcribe(audio, { onProgress = null } = {}) {
    if (!this.ready) await this.load(onProgress);
    const data = toFloat32(audio);

    // Guard against empty/silent clips — Whisper hallucinates loops on silence.
    const seconds = data.length / TARGET_SR;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / Math.max(1, data.length));
    if (seconds < 0.3 || rms < 0.005) return '';

    const out = await this.asr(data, {
      task: 'transcribe',
      language: this.language || undefined,
      chunk_length_s: 30,
      return_timestamps: false,
      no_repeat_ngram_size: 3, // discourage repetition loops
      temperature: 0,
    });
    return collapseRepeats(((out && out.text) || '').trim());
  }
}

// ---------------------------------------------------------------------------
// Text-to-speech: on-device Kokoro + Web Audio spatialization (PannerNode)
// ---------------------------------------------------------------------------

export class SpatialSpeaker {
  constructor({
    modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX',
    dtype = null,           // null = auto (fp32 on webgpu, q8 on wasm)
    device = 'auto',        // 'auto' | 'webgpu' | 'wasm'
    voice = 'af_heart',
    spatial = true,
    position = { x: 0, y: 1.6, z: -1.8 },
  } = {}) {
    this.modelId = modelId;
    this.dtype = dtype;
    this.device = device;
    this.voice = voice;
    this.spatial = spatial;
    this.position = position;
    this.enabled = true;
    this.tts = null;
    this.ready = false;

    this.ctx = null;
    this.panner = null;
    this.gain = null;
    this.queue = [];
    this.playing = false;
    this.current = null;       // currently-playing AudioBufferSourceNode
    this.onPlaying = null;     // optional cb(isPlaying) for UI (stop button, etc.)
  }

  /** Fire the onPlaying callback only on actual state transitions. */
  _setPlaying(p) {
    if (this.playing === p) return;
    this.playing = p;
    if (typeof this.onPlaying === 'function') { try { this.onPlaying(p); } catch (_) {} }
  }

  static isSupported() {
    return typeof (window.AudioContext || window.webkitAudioContext) !== 'undefined';
  }

  async load(onProgress = null) {
    if (this.ready) return this;
    const device = await pickDevice(this.device);
    const dtype = this.dtype || defaultDtype(device, 'tts');
    const { KokoroTTS } = await importKokoro();
    this.tts = await KokoroTTS.from_pretrained(this.modelId, {
      dtype,
      device,
      progress_callback: onProgress || undefined,
    });
    this.resolvedDevice = device;
    this._initAudioGraph();
    this.ready = true;
    return this;
  }

  /**
   * Prepare TTS so the first spoken reply is fast: downloads/instantiates the
   * model AND synthesizes a tiny phrase (compiling the kernels). The audio is
   * generated but never enqueued/played, so it's silent. Call this at app start.
   */
  async warmup(onProgress = null) {
    if (this._warmed) return this;
    await this.load(onProgress);
    try { await this.tts.generate('Ready.', { voice: this.voice }); } catch (_) {}
    this._warmed = true;
    return this;
  }

  _initAudioGraph() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.gain = this.ctx.createGain();
    if (this.spatial) {
      this.panner = this.ctx.createPanner();
      this.panner.panningModel = 'HRTF';
      this.panner.distanceModel = 'inverse';
      this.panner.refDistance = 1;
      this.panner.maxDistance = 50;
      this.panner.rolloffFactor = 1;
      this.gain.connect(this.panner);
      this.panner.connect(this.ctx.destination);
      if (this.position) this.setPosition(this.position.x, this.position.y, this.position.z);
    } else {
      this.gain.connect(this.ctx.destination);
    }
  }

  /** Position the voice source in world space (the in-world avatar/speaker). */
  setPosition(x, y, z) {
    if (!this.panner) return;
    const t = this.ctx.currentTime;
    if (this.panner.positionX) {
      this.panner.positionX.setValueAtTime(x, t);
      this.panner.positionY.setValueAtTime(y, t);
      this.panner.positionZ.setValueAtTime(z, t);
    } else {
      this.panner.setPosition(x, y, z); // older API
    }
  }

  /** Update the listener (camera) pose each frame for correct spatialization. */
  updateListener({ px, py, pz, fx = 0, fy = 0, fz = -1, ux = 0, uy = 1, uz = 0 }) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(px, t); l.positionY.setValueAtTime(py, t); l.positionZ.setValueAtTime(pz, t);
      l.forwardX.setValueAtTime(fx, t); l.forwardY.setValueAtTime(fy, t); l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(ux, t); l.upY.setValueAtTime(uy, t); l.upZ.setValueAtTime(uz, t);
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  async _synth(text) {
    const clean = cleanForSpeech(text);
    if (!clean) return null;
    const audio = await this.tts.generate(clean, { voice: this.voice });
    // RawAudio: .audio (Float32Array), .sampling_rate (e.g. 24000)
    const data = audio.audio || audio.data;
    const rate = audio.sampling_rate || audio.sampleRate || 24000;
    const buf = this.ctx.createBuffer(1, data.length, rate);
    buf.copyToChannel ? buf.copyToChannel(data, 0) : buf.getChannelData(0).set(data);
    return buf;
  }

  _enqueue(buffer) {
    this.queue.push(buffer);
    if (!this.playing) this._playNext();
  }

  _playNext() {
    if (!this.queue.length) { this.current = null; this._setPlaying(false); return; }
    this._setPlaying(true);
    const buf = this.queue.shift();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    this.current = src;
    src.onended = () => { if (this.current === src) this.current = null; this._playNext(); };
    src.start();
  }

  /**
   * Synthesize + speak a full string (queued behind anything already playing).
   * Pass { force: true } to speak even when `enabled` is off (e.g. an explicit
   * "replay this reply" action).
   */
  async speak(text, { force = false } = {}) {
    if ((!this.enabled && !force) || !text || !text.trim()) return;
    if (!this.ready) await this.load();
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (_) {} }
    const buf = await this._synth(text);
    if (buf) this._enqueue(buf);
  }

  /**
   * Streaming speaker: feed cumulative response text on each token; speaks each
   * newly-completed sentence so the voice tracks generation. flush() at the end.
   */
  stream() {
    let spokenUpTo = 0;
    let cancelled = false;
    const self = this;
    const sentenceEnd = /[.!?。！？]+["')\]]?\s/g;
    const speakChunk = async (chunk) => {
      if (cancelled || !self.enabled || !chunk.trim()) return;
      if (!self.ready) await self.load();
      if (self.ctx.state === 'suspended') { try { await self.ctx.resume(); } catch (_) {} }
      if (cancelled) return; // may have been cancelled while awaiting
      try { const buf = await self._synth(chunk); if (!cancelled && buf) self._enqueue(buf); } catch (_) {}
    };
    return {
      push(fullText) {
        if (cancelled) return;
        let m, lastIdx = spokenUpTo;
        sentenceEnd.lastIndex = spokenUpTo;
        while ((m = sentenceEnd.exec(fullText)) !== null) lastIdx = m.index + m[0].length;
        if (lastIdx > spokenUpTo) {
          const chunk = fullText.slice(spokenUpTo, lastIdx).trim();
          spokenUpTo = lastIdx;
          speakChunk(chunk);
        }
      },
      flush(fullText) {
        if (cancelled) return;
        const rest = (fullText || '').slice(spokenUpTo).trim();
        spokenUpTo = (fullText || '').length;
        if (rest) speakChunk(rest);
      },
      cancel() { cancelled = true; spokenUpTo = 0; self.stop(); },
    };
  }

  /** Stop playback immediately and clear the queue. */
  stop() {
    this.queue = [];
    try { if (this.current) { this.current.onended = null; this.current.stop(); } } catch (_) {}
    this.current = null;
    this._setPlaying(false);
    try { this.ctx && this.ctx.suspend(); } catch (_) {}
    try { this.ctx && this.ctx.resume(); } catch (_) {}
  }

  async listVoices() {
    if (!this.ready) await this.load();
    try { return this.tts.list_voices ? this.tts.list_voices() : []; } catch { return []; }
  }
}
