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

// ---------------------------------------------------------------------------
// Shared voice worker — runs Whisper (ASR) + Kokoro (TTS) off the main thread.
// On Quest this is what keeps the render loop from freezing during voice work,
// and (paired with WASM/CPU + small quantized models) stops the voice models
// from fighting the ~2 GB LLM for GPU memory and crashing the tab.
// ---------------------------------------------------------------------------
let _vw = null, _vwId = 0;
const _vwPending = new Map();
function workerSupported() { try { return typeof Worker !== 'undefined'; } catch { return false; } }
function voiceWorker() {
  if (_vw) return _vw;
  _vw = new Worker(new URL('./voice-worker.js', import.meta.url), { type: 'module' });
  _vw.onmessage = (e) => {
    const { id, type, payload } = e.data || {};
    const p = _vwPending.get(id);
    if (!p) return;
    _vwPending.delete(id);
    if (type === 'error') p.reject(new Error(payload && payload.message));
    else p.resolve(payload || {});
  };
  _vw.onerror = (err) => {
    for (const [, p] of _vwPending) p.reject(err.error || new Error('Voice worker failed'));
    _vwPending.clear();
  };
  return _vw;
}
function vwCall(type, payload, transfer) {
  const w = voiceWorker();
  const id = ++_vwId;
  return new Promise((resolve, reject) => {
    _vwPending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload }, transfer || []);
  });
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
  // Defaults tuned for memory-constrained headsets: a small model on WASM/CPU so
  // it neither competes with the LLM for GPU memory nor freezes the render loop
  // (the actual work runs in voice-worker.js). 'whisper-tiny' keeps the download
  // and RAM footprint small; pass a bigger modelId on desktop if you want.
  constructor({ modelId = 'onnx-community/whisper-tiny', device = 'wasm', dtype = 'fp32', language = null } = {}) {
    this.cfg = { modelId, device, dtype };
    this.language = language; // null = auto-detect; or e.g. 'en', 'nl'
    this.ready = false;
    this._warmed = false;
    this._useWorker = workerSupported();
    this._asr = null; // inline fallback pipeline (only if Workers unavailable)
  }

  static isSupported() { return MicRecorder.isSupported(); }

  async load() {
    if (this.ready) return this;
    if (this._useWorker) {
      await vwCall('warm-asr', { cfg: this.cfg });
    } else {
      const { pipeline } = await importTransformers();
      this._asr = await pipeline('automatic-speech-recognition', this.cfg.modelId,
        { device: this.cfg.device, dtype: this.cfg.dtype });
    }
    this.ready = true;
    return this;
  }

  /** Download + instantiate the model so first real use isn't slow. */
  async warmup() {
    if (this._warmed) return this;
    await this.load();
    this._warmed = true;
    return this;
  }

  /** Transcribe a mono 16 kHz AudioBuffer / Float32Array to text. */
  async transcribe(audio) {
    if (!this.ready) await this.load();
    const data0 = toFloat32(audio);

    // Guard against empty/silent clips — Whisper hallucinates loops on silence.
    const seconds = data0.length / TARGET_SR;
    let sum = 0;
    for (let i = 0; i < data0.length; i++) sum += data0[i] * data0[i];
    const rms = Math.sqrt(sum / Math.max(1, data0.length));
    if (seconds < 0.3 || rms < 0.005) return '';

    if (this._useWorker) {
      const data = new Float32Array(data0); // standalone buffer we can transfer
      const out = await vwCall('asr', { cfg: this.cfg, audio: data, language: this.language }, [data.buffer]);
      return collapseRepeats(((out && out.text) || '').trim());
    }
    const out = await this._asr(data0, {
      task: 'transcribe',
      language: this.language || undefined,
      chunk_length_s: 30,
      return_timestamps: false,
      no_repeat_ngram_size: 3,
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
    // fp16 on WebGPU is correct AND fast. (q8 on WebGPU is the trap: it loads but
    // the onnxruntime-web WebGPU backend mis-runs uint8 ops → slow + garbled,
    // wrong-language audio. The worker forces fp16 on GPU and only uses q8 on the
    // CPU/WASM fallback, where q8 is correct and keeps memory tiny.)
    dtype = 'fp16',
    device = 'webgpu',
    voice = 'af_heart',
    spatial = true,
    position = { x: 0, y: 1.6, z: -1.8 },
  } = {}) {
    this.cfg = { modelId, device, dtype };
    this.voice = voice;
    this.spatial = spatial;
    this.position = position;
    this.enabled = true;
    this.ready = false;
    this._warmed = false;
    this._useWorker = workerSupported();
    this._tts = null; // inline fallback (only if Workers unavailable)

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

  async load() {
    if (this.ready) return this;
    if (this._useWorker) {
      const r = await vwCall('warm-tts', { cfg: this.cfg });
      this.backend = (r && r.backend) || `${this.cfg.device}/${this.cfg.dtype}`;
    } else {
      // Inline (no Worker): still avoid q8 on WebGPU for the reasons above.
      const dtype = (this.cfg.device !== 'wasm') ? 'fp16' : (this.cfg.dtype || 'q8');
      const { KokoroTTS } = await importKokoro();
      this._tts = await KokoroTTS.from_pretrained(this.cfg.modelId, { dtype, device: this.cfg.device });
      this.backend = `${this.cfg.device}/${dtype}`;
    }
    console.log('[voice] TTS backend:', this.backend);
    this._initAudioGraph(); // audio graph stays on the main thread
    this.ready = true;
    return this;
  }

  /** Download + instantiate the TTS model so the first spoken reply isn't slow. */
  async warmup() {
    if (this._warmed) return this;
    await this.load();
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
    let data, rate;
    if (this._useWorker) {
      const out = await vwCall('tts', { cfg: this.cfg, text: clean, voice: this.voice });
      data = out.audio; rate = out.rate || 24000;
    } else {
      const audio = await this._tts.generate(clean, { voice: this.voice });
      data = audio.audio || audio.data;
      rate = audio.sampling_rate || audio.sampleRate || 24000;
    }
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
    try { return this._tts && this._tts.list_voices ? this._tts.list_voices() : []; } catch { return []; }
  }
}
